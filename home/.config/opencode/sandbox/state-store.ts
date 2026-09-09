import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomBytes } from "node:crypto"
import { lstat, open, readFile, readdir, rename, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"

import { redactText } from "./redaction"
import {
  isRequestId,
  isNodeError,
  isSandboxDesiredLocation,
  isSandboxIntentPhase,
  isRecord,
  isSandboxOperation,
  isSandboxState,
  PERSISTED_SANDBOX_SCHEMA_VERSION,
  MAX_OPERATION_JOURNAL_BYTES,
  MAX_OPERATION_JOURNAL_EVIDENCE_BYTES,
  MAX_OPERATION_JOURNAL_EVIDENCE_REFS,
  MAX_OPERATION_JOURNAL_ENTRIES,
  MAX_OPERATION_JOURNAL_STRING_BYTES,
  SandboxError,
  type SandboxJournalEntry,
  type PersistedSandboxRecord,
  type SandboxRecord,
  type SandboxState,
} from "./types"
import {
  assertLegalIntentPhase,
  compatibilityStateForIntent,
  intentForLegacyState,
  isBlockingOperation,
  operationForIntent,
  operationForLegacyState,
} from "./state"
import { assertPrivateDirectory, assertPrivateFile, ensurePrivateDirectory } from "./secure-fs"

interface NormalizedRecord {
  persisted: PersistedSandboxRecord
  compatibilityState: SandboxState
  needsWrite: boolean
}

interface ValidatedCommon {
  sessionId: string
  workspaceId: string
  projectId: string
  provider: string
  providerState: Record<string, unknown>
  vmName?: string
  vmIdentity?: PersistedSandboxRecord["vmIdentity"]
  generation: number
  directory: string
  branch: string
  baseSha: string
  preservedWorktreePath?: string
  createdAt: string
  updatedAt: string
  operation?: PersistedSandboxRecord["operation"]
  journal?: PersistedSandboxRecord["journal"]
  lastError?: PersistedSandboxRecord["lastError"]
}

export class FileStateStore {
  readonly root: string
  private readonly lockContext = new AsyncLocalStorage<string>()

  constructor(root: string) {
    this.root = root
  }

  async get(sessionId: string): Promise<SandboxRecord | undefined> {
    await ensurePrivateDirectory(this.root)
    const candidate = await this.readNormalized(sessionId)
    if (!candidate) return undefined
    if (!candidate.needsWrite) {
      return toCompatibilityRecord(candidate.persisted, candidate.compatibilityState)
    }
    return this.migrateWithLock(sessionId)
  }

  async list(): Promise<SandboxRecord[]> {
    await ensurePrivateDirectory(this.root)
    const entries = await readdir(this.root, { withFileTypes: true })
    const records: SandboxRecord[] = []
    const sessions = new Set<string>()
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      const path = join(this.root, entry.name)
      await assertPrivateFile(path)
      const value = parseDocument(await readFile(path, "utf8"))
      if (!isRecord(value) || typeof value.sessionId !== "string") {
        throw new SandboxError("validate", "state field sessionId is invalid", "STATE_SCHEMA")
      }
      if (sessions.has(value.sessionId)) continue
      const sessionId = value.sessionId
      sessions.add(sessionId)
      const candidate = normalizeStoredRecord(value, sessionId)
      const record = candidate.needsWrite
        ? await this.migrateWithLock(sessionId)
        : toCompatibilityRecord(candidate.persisted, candidate.compatibilityState)
      if (record) records.push(record)
    }
    return records.sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  }

  recordPath(sessionId: string): string {
    return join(this.root, `${hash(sessionId)}.json`)
  }

  async write(record: SandboxRecord | PersistedSandboxRecord): Promise<void> {
    const normalized = normalizeForWrite(record)
    await ensurePrivateDirectory(this.root)
    await this.withLock(record.sessionId, async () => {
      await this.writeUnlocked(normalized.persisted)
    })
  }

  async withLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    await ensurePrivateDirectory(this.root)
    if (this.lockContext.getStore() === sessionId) return operation()
    const lockPath = join(this.root, `.${hash(sessionId)}.lock`)
    for (let attempt = 0; attempt < 2; attempt++) {
      let handle
      try {
        handle = await open(lockPath, "wx", 0o600)
      } catch (error) {
        if (!isNodeError(error, "EEXIST") || attempt === 1 || !(await removeStaleLock(lockPath))) {
          if (isNodeError(error, "EEXIST")) {
            throw new SandboxError("validate", `session is already locked: ${sessionId}`, "STATE_LOCKED")
          }
          throw error
        }
        continue
      }

      try {
        await handle.writeFile(`${process.pid}\n`)
        return await this.lockContext.run(sessionId, operation)
      } finally {
        await handle.close().catch(() => undefined)
        await unlink(lockPath).catch(() => undefined)
      }
    }
    throw new SandboxError("validate", `session is already locked: ${sessionId}`, "STATE_LOCKED")
  }

  async withRecordLock<T>(
    sessionId: string,
    operation: (
       current: SandboxRecord | undefined,
       write: (record: SandboxRecord | PersistedSandboxRecord) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    return this.withLock(sessionId, async () => {
      const current = await this.readAndMigrateUnlocked(sessionId)
      const write = async (record: SandboxRecord | PersistedSandboxRecord): Promise<void> => {
        if (record.sessionId !== sessionId) {
          throw new SandboxError("validate", "state session does not match lock key", "STATE_SESSION")
        }
        const normalized = normalizeForWrite(record)
        await this.writeUnlocked(normalized.persisted)
      }
      return operation(current, write)
    })
  }

  private async readAndMigrateUnlocked(sessionId: string): Promise<SandboxRecord | undefined> {
    const normalized = await this.readNormalized(sessionId)
    if (!normalized) return undefined
    if (normalized.needsWrite) await this.writeUnlocked(normalized.persisted)
    return toCompatibilityRecord(normalized.persisted, normalized.compatibilityState)
  }

  private async migrateWithLock(sessionId: string): Promise<SandboxRecord | undefined> {
    // ponytail: bounded 100 ms reader wait; longer lifecycle locks keep the existing STATE_LOCKED result.
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        return await this.withLock(sessionId, () => this.readAndMigrateUnlocked(sessionId))
      } catch (error) {
        if (!(error instanceof SandboxError) || error.code !== "STATE_LOCKED" || attempt === 99) throw error
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
    }
    return undefined
  }

  private async readNormalized(sessionId: string): Promise<NormalizedRecord | undefined> {
    let value: unknown
    try {
      value = await this.readDocument(this.recordPath(sessionId))
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined
      throw error
    }
    return normalizeStoredRecord(value, sessionId)
  }

  private async readDocument(path: string): Promise<unknown> {
    const stats = await lstat(path)
    if (stats.isSymbolicLink() || !stats.isFile()) throw new SandboxError("validate", "state record is not a regular file", "STATE_FILE")
    if (process.getuid?.() !== undefined && stats.uid !== process.getuid()) {
      throw new SandboxError("validate", "state record has an unexpected owner", "STATE_OWNER")
    }
    if ((stats.mode & 0o077) !== 0) throw new SandboxError("validate", "state record is accessible by another user", "STATE_MODE")
    return parseDocument(await readFile(path, "utf8"))
  }

  private async writeUnlocked(record: PersistedSandboxRecord): Promise<void> {
    const path = this.recordPath(record.sessionId)
    await assertPrivateDirectory(dirname(path))
    await rejectSymlink(path)

    const temporaryPath = join(this.root, `.${hash(record.sessionId)}.${randomBytes(8).toString("hex")}.tmp`)
    const handle = await open(temporaryPath, "wx", 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, path)
  }
}

function normalizeForWrite(value: SandboxRecord | PersistedSandboxRecord): NormalizedRecord {
  if (isSandboxDesiredLocation(value.desiredLocation) && isSandboxIntentPhase(value.phase) && value.schemaVersion === undefined) {
    value = { ...value, schemaVersion: PERSISTED_SANDBOX_SCHEMA_VERSION }
  }
  return normalizeStoredRecord(value, value.sessionId)
}

const CANONICAL_FIELDS = new Set([
  "sessionId",
  "workspaceId",
  "projectId",
  "provider",
  "providerState",
  "vmName",
  "vmIdentity",
  "generation",
  "directory",
  "branch",
  "baseSha",
  "preservedWorktreePath",
  "schemaVersion",
  "desiredLocation",
  "phase",
  "operation",
  "journal",
  "createdAt",
  "updatedAt",
  "lastError",
])

const OBSERVED_PROVIDER_FIELDS = new Set([
  "observation",
  "observations",
  "classification",
  "work",
  "control",
  "health",
  "effectivetarget",
  "observed",
  "resource",
  "ownership",
  "status",
])

interface CanonicalIntent {
  desiredLocation: NonNullable<PersistedSandboxRecord["desiredLocation"]>
  phase: NonNullable<PersistedSandboxRecord["phase"]>
  operation?: PersistedSandboxRecord["operation"]
  lastError?: PersistedSandboxRecord["lastError"]
}

function normalizeStoredRecord(value: unknown, expectedSessionId?: string): NormalizedRecord {
  if (!isRecord(value)) throw new SandboxError("validate", "state record must be an object", "STATE_SCHEMA")
  if (containsCredentialKey(value)) throw new SandboxError("validate", "state record contains a credential field", "STATE_SECRET")

  const common = validateCommon(value, expectedSessionId)
  const hasCanonicalIntent = hasOwn(value, "schemaVersion") || hasOwn(value, "desiredLocation") || hasOwn(value, "phase")
  if (hasCanonicalIntent) {
    validateSchemaVersion(value.schemaVersion)
    if (!isSandboxDesiredLocation(value.desiredLocation)) {
      throw new SandboxError("validate", "state desired location is invalid", "STATE_SCHEMA")
    }
    if (!isSandboxIntentPhase(value.phase)) {
      throw new SandboxError("validate", "state intent phase is invalid", "STATE_SCHEMA")
    }
    if (value.phase === "syncing" && !isBlockingOperation(common.operation)) {
      throw new SandboxError("validate", "state syncing phase requires a blocking operation", "STATE_SCHEMA")
    }
    const canonical = canonicalizeMissingOperation(
      value.desiredLocation,
      value.phase,
      common.operation,
      common.lastError,
    )
    assertLegalIntentPhase(canonical.desiredLocation, canonical.phase)
    const persisted = buildPersistedRecord(common, canonical)
    return {
      persisted,
      compatibilityState: compatibilityStateForIntent(persisted),
      needsWrite: needsCanonicalWrite(value, persisted),
    }
  }

  if (hasOwn(value, "state")) {
    if (!isSandboxState(value.state)) throw new SandboxError("validate", "state lifecycle value is invalid", "STATE_SCHEMA")
    const legacy = legacyFields(value.state, common.operation, common.lastError)
    const intent = missingProvisioningIntent(value.state, common.operation)
      ? { desiredLocation: "remote" as const, phase: "idle" as const }
      : intentForLegacyState(value.state, legacy.operation)
    assertLegalIntentPhase(intent.desiredLocation, intent.phase)
    const persisted = buildPersistedRecord(common, {
      desiredLocation: intent.desiredLocation,
      phase: intent.phase,
      operation: legacy.operation,
      lastError: legacy.lastError,
    })
    return {
      persisted,
      compatibilityState: compatibilityStateForIntent(persisted),
      needsWrite: true,
    }
  }
  throw new SandboxError("validate", "state record has no canonical intent", "STATE_SCHEMA")
}

function canonicalizeMissingOperation(
  desiredLocation: NonNullable<PersistedSandboxRecord["desiredLocation"]>,
  phase: NonNullable<PersistedSandboxRecord["phase"]>,
  operation: PersistedSandboxRecord["operation"] | undefined,
  lastError: PersistedSandboxRecord["lastError"] | undefined,
): CanonicalIntent {
  const recoveredOperation = operationForIntent(desiredLocation, phase, operation)
  if (recoveredOperation) return { desiredLocation, phase, operation: recoveredOperation, lastError }

  if (!operation && desiredLocation === "remote" && ["capturing", "provisioning"].includes(phase)) {
    return {
      desiredLocation,
      phase: "idle",
      operation: { kind: "start", phase },
      lastError: lastError ?? missingOperationError("start", phase),
    }
  }

  return { desiredLocation, phase, operation, lastError }
}

function missingProvisioningIntent(state: SandboxState, operation: SandboxRecord["operation"] | undefined): boolean {
  return state === "provisioning" && operation === undefined
}

function missingOperationError(kind: "start", phase: string): NonNullable<SandboxRecord["lastError"]> {
  return {
    stage: "migrate",
    message: `legacy ${kind} operation is missing at ${phase}; retry ${kind} to continue`,
    code: "LEGACY_OPERATION_MISSING",
  }
}

function buildPersistedRecord(common: ValidatedCommon, intent: CanonicalIntent): PersistedSandboxRecord {
  return {
    sessionId: common.sessionId,
    workspaceId: common.workspaceId,
    projectId: common.projectId,
    provider: common.provider,
    providerState: common.providerState,
    ...(common.vmName !== undefined ? { vmName: common.vmName } : {}),
    ...(common.vmIdentity !== undefined ? { vmIdentity: common.vmIdentity } : {}),
    generation: common.generation,
    directory: common.directory,
    branch: common.branch,
    baseSha: common.baseSha,
    ...(common.preservedWorktreePath !== undefined ? { preservedWorktreePath: common.preservedWorktreePath } : {}),
    schemaVersion: PERSISTED_SANDBOX_SCHEMA_VERSION,
    desiredLocation: intent.desiredLocation,
    phase: intent.phase,
    ...(intent.operation ? { operation: intent.operation } : {}),
    ...(common.journal && common.journal.length > 0 ? { journal: common.journal } : {}),
    createdAt: common.createdAt,
    updatedAt: common.updatedAt,
    ...(intent.lastError ? { lastError: intent.lastError } : {}),
  }
}

function needsCanonicalWrite(value: Record<string, unknown>, persisted: PersistedSandboxRecord): boolean {
  if (Object.keys(value).some((key) => !CANONICAL_FIELDS.has(key))) return true
  return value.schemaVersion !== persisted.schemaVersion ||
    value.desiredLocation !== persisted.desiredLocation ||
    value.phase !== persisted.phase ||
    value.provider !== persisted.provider ||
    differs(value.providerState, persisted.providerState) ||
    differs(value.vmIdentity, persisted.vmIdentity) ||
    differs(value.operation, persisted.operation) ||
    differs(value.journal, persisted.journal) ||
    differs(value.lastError, persisted.lastError)
}

function differs(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) !== JSON.stringify(right)
}

function legacyFields(
  state: SandboxState,
  operation: SandboxRecord["operation"] | undefined,
  lastError: SandboxRecord["lastError"] | undefined,
): { operation?: SandboxRecord["operation"]; lastError?: SandboxRecord["lastError"] } {
  const migratedOperation = operationForLegacyState(state, operation)
  if (lastError) return { operation: migratedOperation, lastError }
  switch (state) {
    case "detached":
      return { operation: migratedOperation }
    case "provisioning":
      if (!operation) return { operation: migratedOperation, lastError: missingOperationError("start", state) }
      return { operation: migratedOperation }
    case "activation_pending":
    case "stop_pending":
    case "delete_pending":
      return { operation: migratedOperation }
    case "sync_failed":
      return { operation: migratedOperation, lastError: { stage: "sync", message: "legacy sync failure", code: "LEGACY_SYNC" } }
    case "recovery_pending":
      return { operation: migratedOperation, lastError: { stage: "reconcile", message: "legacy recovery is pending", code: "LEGACY_RECOVERY" } }
    case "orphaned":
      return { operation: migratedOperation, lastError: { stage: "reconcile", message: "legacy orphaned runtime", code: "LEGACY_ORPHANED" } }
    case "error":
      return { operation: migratedOperation, lastError: { stage: "transition", message: "legacy lifecycle error", code: "LEGACY_ERROR" } }
    default:
      return { operation: migratedOperation }
  }
}

function validateCommon(value: Record<string, unknown>, expectedSessionId?: string): ValidatedCommon {
  const requiredStrings = ["sessionId", "workspaceId", "projectId", "directory", "branch", "baseSha", "createdAt", "updatedAt"]
  for (const key of requiredStrings) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new SandboxError("validate", `state field ${key} is invalid`, "STATE_SCHEMA")
    }
  }
  if (expectedSessionId !== undefined && value.sessionId !== expectedSessionId) {
    throw new SandboxError("validate", "state record session does not match filename", "STATE_SESSION")
  }
  if (typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1) {
    throw new SandboxError("validate", "state generation is invalid", "STATE_SCHEMA")
  }

  const provider = value.provider === undefined ? "exedev" : value.provider
  if (typeof provider !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(provider)) {
    throw new SandboxError("validate", "state provider is invalid", "STATE_SCHEMA")
  }

  const providerState = value.providerState === undefined ? {} : value.providerState
  if (!isRecord(providerState)) throw new SandboxError("validate", "provider state is invalid", "STATE_SCHEMA")

  if (value.vmName !== undefined && (typeof value.vmName !== "string" || value.vmName.length === 0)) {
    throw new SandboxError("validate", "VM name is invalid", "STATE_SCHEMA")
  }
  if (value.preservedWorktreePath !== undefined && (typeof value.preservedWorktreePath !== "string" || !isAbsolute(value.preservedWorktreePath))) {
    throw new SandboxError("validate", "preserved worktree path is invalid", "STATE_SCHEMA")
  }
  const vmIdentity = value.vmIdentity === undefined ? undefined : validateVmIdentity(value.vmIdentity)
  const operation = validateOperation(value.operation)
  const journal = validateJournal(value.journal)
  const lastError = validateLastError(value.lastError)
  return {
    sessionId: value.sessionId as string,
    workspaceId: value.workspaceId as string,
    projectId: value.projectId as string,
    provider,
    providerState: normalizeProviderState(providerState),
    ...(value.vmName !== undefined ? { vmName: value.vmName as string } : {}),
    ...(vmIdentity ? { vmIdentity } : {}),
    generation: value.generation as number,
    directory: value.directory as string,
    branch: value.branch as string,
    baseSha: value.baseSha as string,
    ...(value.preservedWorktreePath !== undefined ? { preservedWorktreePath: value.preservedWorktreePath as string } : {}),
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
    ...(operation ? { operation } : {}),
    ...(journal && journal.length > 0 ? { journal } : {}),
    ...(lastError ? { lastError } : {}),
  }
}

function validateSchemaVersion(value: unknown): asserts value is typeof PERSISTED_SANDBOX_SCHEMA_VERSION {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new SandboxError("validate", "state schema version is invalid", "STATE_VERSION")
  }
  if (value > PERSISTED_SANDBOX_SCHEMA_VERSION) {
    throw new SandboxError("validate", `state schema version ${value} is newer than supported`, "STATE_VERSION")
  }
  if (value !== PERSISTED_SANDBOX_SCHEMA_VERSION) {
    throw new SandboxError("validate", `state schema version ${value} is unsupported`, "STATE_VERSION")
  }
}

function validateOperation(value: unknown): SandboxRecord["operation"] | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || !isSandboxOperation(value.kind) || typeof value.phase !== "string") {
    throw new SandboxError("validate", "state operation is invalid", "STATE_SCHEMA")
  }
  if (value.phase.length === 0) {
    throw new SandboxError("validate", "state operation phase is invalid", "STATE_SCHEMA")
  }
  if (value.force !== undefined && typeof value.force !== "boolean") {
    throw new SandboxError("validate", "state operation force is invalid", "STATE_SCHEMA")
  }
  if (value.providerDestroyed !== undefined && typeof value.providerDestroyed !== "boolean") {
    throw new SandboxError("validate", "state operation providerDestroyed is invalid", "STATE_SCHEMA")
  }
  if (value.requestId !== undefined && !isRequestId(value.requestId)) {
    throw new SandboxError("validate", "state operation request ID is invalid", "STATE_SCHEMA")
  }
  return {
    kind: value.kind,
    phase: value.phase,
    ...(value.requestId !== undefined ? { requestId: value.requestId } : {}),
    ...(value.force !== undefined ? { force: value.force } : {}),
    ...(value.providerDestroyed !== undefined ? { providerDestroyed: value.providerDestroyed } : {}),
  }
}

export function boundOperationJournal(entries: readonly SandboxJournalEntry[]): SandboxJournalEntry[] {
  const bounded = entries.slice(-MAX_OPERATION_JOURNAL_ENTRIES).map((entry) => ({
    requestId: entry.requestId,
    operation: entry.operation,
    startedAt: boundedJournalText(entry.startedAt),
    ...(entry.endedAt !== undefined ? { endedAt: boundedJournalText(entry.endedAt) } : {}),
    resultCode: boundedJournalText(entry.resultCode),
    evidence: boundedJournalEvidence(entry.evidence),
  }))
  const latest: SandboxJournalEntry[] = []
  for (let index = bounded.length - 1; index >= 0; index--) {
    const candidate = [bounded[index]!, ...latest]
    if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_OPERATION_JOURNAL_BYTES) break
    latest.unshift(bounded[index]!)
  }
  return latest
}

function validateJournal(value: unknown): SandboxJournalEntry[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new SandboxError("validate", "state journal is invalid", "STATE_SCHEMA")

  const requestIds = new Set<string>()
  const entries = value.map((entry) => {
    if (!isRecord(entry) || !isRequestId(entry.requestId) || !isSandboxOperation(entry.operation)) {
      throw new SandboxError("validate", "state journal entry is invalid", "STATE_SCHEMA")
    }
    if (requestIds.has(entry.requestId)) {
      throw new SandboxError("validate", "state journal contains a duplicate request ID", "STATE_JOURNAL_DUPLICATE")
    }
    requestIds.add(entry.requestId)
    if (typeof entry.startedAt !== "string" || entry.startedAt.length === 0) {
      throw new SandboxError("validate", "state journal start time is invalid", "STATE_SCHEMA")
    }
    if (entry.endedAt !== undefined && (typeof entry.endedAt !== "string" || entry.endedAt.length === 0)) {
      throw new SandboxError("validate", "state journal end time is invalid", "STATE_SCHEMA")
    }
    if (typeof entry.resultCode !== "string" || entry.resultCode.length === 0) {
      throw new SandboxError("validate", "state journal result code is invalid", "STATE_SCHEMA")
    }
    if (!Array.isArray(entry.evidence) || entry.evidence.some((item) => typeof item !== "string")) {
      throw new SandboxError("validate", "state journal evidence is invalid", "STATE_SCHEMA")
    }
    return {
      requestId: entry.requestId,
      operation: entry.operation,
      startedAt: boundedJournalText(entry.startedAt),
      ...(entry.endedAt !== undefined ? { endedAt: boundedJournalText(entry.endedAt) } : {}),
      resultCode: boundedJournalText(entry.resultCode),
      evidence: boundedJournalEvidence(entry.evidence),
    }
  })

  return boundOperationJournal(entries)
}

function boundedJournalText(value: string): string {
  const redacted = redactText(value)
  return truncateUtf8(redacted, MAX_OPERATION_JOURNAL_STRING_BYTES)
}

function boundedJournalEvidence(values: readonly string[]): string[] {
  const output: string[] = []
  for (const value of values.slice(0, MAX_OPERATION_JOURNAL_EVIDENCE_REFS)) {
    const text = boundedJournalText(value)
    if (Buffer.byteLength(JSON.stringify([...output, text])) > MAX_OPERATION_JOURNAL_EVIDENCE_BYTES) break
    output.push(text)
  }
  return output
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0
  let length = 0
  for (const character of value) {
    const size = Buffer.byteLength(character)
    if (bytes + size > maxBytes) break
    bytes += size
    length += character.length
  }
  return value.slice(0, length)
}

function validateLastError(value: unknown): SandboxRecord["lastError"] | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || typeof value.stage !== "string" || typeof value.message !== "string") {
    throw new SandboxError("validate", "state last error is invalid", "STATE_SCHEMA")
  }
  if (value.code !== undefined && typeof value.code !== "string") {
    throw new SandboxError("validate", "state last error code is invalid", "STATE_SCHEMA")
  }
  return {
    stage: value.stage,
    message: redactText(value.message),
    ...(value.code !== undefined ? { code: value.code } : {}),
  }
}

function validateVmIdentity(value: unknown): NonNullable<ValidatedCommon["vmIdentity"]> {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.sshDest !== "string") {
    throw new SandboxError("validate", "VM identity is invalid", "STATE_SCHEMA")
  }
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string")) {
    throw new SandboxError("validate", "VM tags are invalid", "STATE_SCHEMA")
  }
  if (value.comment !== undefined && typeof value.comment !== "string") {
    throw new SandboxError("validate", "VM comment is invalid", "STATE_SCHEMA")
  }
  const identity: NonNullable<ValidatedCommon["vmIdentity"]> = {
    name: value.name,
    sshDest: value.sshDest,
    tags: [...value.tags],
    comment: typeof value.comment === "string" ? value.comment : "",
  }
  for (const key of ["id", "sshUser", "sshHost", "region"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new SandboxError("validate", `VM ${key} is invalid`, "STATE_SCHEMA")
    }
    if (typeof value[key] === "string") identity[key] = value[key]
  }
  return identity
}

function toCompatibilityRecord(record: PersistedSandboxRecord, state: SandboxState): SandboxRecord {
  return { ...record, state }
}

function parseDocument(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new SandboxError("validate", "state record is not valid JSON", "STATE_SCHEMA")
  }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function normalizeProviderState(value: Record<string, unknown>): Record<string, unknown> {
  return normalizeProviderValue(value) as Record<string, unknown>
}

function normalizeProviderValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeProviderValue)
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !OBSERVED_PROVIDER_FIELDS.has(normalizeMetadataKey(key)))
        .map(([key, item]) => [key, normalizeProviderValue(item)]),
    )
  }
  return typeof value === "string" ? redactText(value) : value
}

function normalizeMetadataKey(key: string): string {
  return key.replace(/[-_]/g, "").toLowerCase()
}

function containsCredentialKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredentialKey)
  if (!isRecord(value)) return false
  for (const [key, item] of Object.entries(value)) {
    if (/(?:password|token|secret|credential|auth(?:orization|_content)?|api[_-]?key|private[_-]?key|cookie|set-cookie|ssh[_-]?key)/i.test(key)) return true
    if (isRecord(item) && containsCredentialKey(item)) return true
    if (Array.isArray(item) && containsCredentialKey(item)) return true
  }
  return false
}

async function rejectSymlink(path: string): Promise<void> {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) throw new SandboxError("validate", `refusing to replace symlink: ${path}`, "STATE_SYMLINK")
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return
    throw error
  }
}

async function removeStaleLock(path: string): Promise<boolean> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    return isNodeError(error, "ENOENT")
  }

  const pid = Number(text.trim())
  if (!Number.isSafeInteger(pid) || pid < 1) {
    const stats = await lstat(path).catch(() => undefined)
    if (!stats || Date.now() - stats.mtimeMs < 30_000) return false
    await unlink(path).catch(() => undefined)
    return true
  }
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if (!isNodeError(error, "ESRCH")) return false
    await unlink(path).catch(() => undefined)
    return true
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24)
}
