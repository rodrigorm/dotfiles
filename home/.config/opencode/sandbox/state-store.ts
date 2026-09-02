import { createHash, randomBytes } from "node:crypto"
import { lstat, open, readFile, readdir, rename, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"

import { redactText } from "./redaction"
import { isNodeError, isRecord, SandboxError, isSandboxState, type SandboxRecord } from "./types"
import { assertPrivateDirectory, assertPrivateFile, ensurePrivateDirectory } from "./secure-fs"

export class FileStateStore {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  async get(sessionId: string): Promise<SandboxRecord | undefined> {
    await ensurePrivateDirectory(this.root)
    const path = this.recordPath(sessionId)
    try {
      const stats = await lstat(path)
      if (stats.isSymbolicLink() || !stats.isFile()) throw new SandboxError("validate", "state record is not a regular file", "STATE_FILE")
      if (process.getuid?.() !== undefined && stats.uid !== process.getuid()) {
        throw new SandboxError("validate", "state record has an unexpected owner", "STATE_OWNER")
      }
      if ((stats.mode & 0o077) !== 0) throw new SandboxError("validate", "state record is accessible by another user", "STATE_MODE")
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined
      throw error
    }

    const text = await readFile(path, "utf8")
    return validateRecord(JSON.parse(text), sessionId)
  }

  async list(): Promise<SandboxRecord[]> {
    await ensurePrivateDirectory(this.root)
    const entries = await readdir(this.root, { withFileTypes: true })
    const records: SandboxRecord[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      const path = join(this.root, entry.name)
      await assertPrivateFile(path)
      const text = await readFile(path, "utf8")
      records.push(validateRecord(JSON.parse(text)))
    }
    return records.sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  }

  recordPath(sessionId: string): string {
    return join(this.root, `${hash(sessionId)}.json`)
  }

  async write(record: SandboxRecord): Promise<void> {
    const validated = validateRecord(record)
    await ensurePrivateDirectory(this.root)
    await this.withLock(record.sessionId, async () => {
      await this.writeUnlocked(validated)
    })
  }

  async withLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    await ensurePrivateDirectory(this.root)
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
        return await operation()
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
       write: (record: SandboxRecord) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    return this.withLock(sessionId, async () => {
      const current = await this.get(sessionId)
      const write = async (record: SandboxRecord): Promise<void> => {
        if (record.sessionId !== sessionId) {
          throw new SandboxError("validate", "state session does not match lock key", "STATE_SESSION")
        }
        const validated = validateRecord(record)
        await this.writeUnlocked(validated)
      }
      return operation(current, write)
    })
  }

  private async writeUnlocked(record: SandboxRecord): Promise<void> {
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

function validateRecord(value: unknown, expectedSessionId?: string): SandboxRecord {
  if (!isRecord(value)) throw new SandboxError("validate", "state record must be an object", "STATE_SCHEMA")
  if (containsCredentialKey(value)) throw new SandboxError("validate", "state record contains a credential field", "STATE_SECRET")

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
  if (!isSandboxState(value.state)) throw new SandboxError("validate", "state lifecycle value is invalid", "STATE_SCHEMA")

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
  if (value.vmIdentity !== undefined) {
    if (!isRecord(value.vmIdentity) || typeof value.vmIdentity.name !== "string" || typeof value.vmIdentity.sshDest !== "string") {
      throw new SandboxError("validate", "VM identity is invalid", "STATE_SCHEMA")
    }
    if (!Array.isArray(value.vmIdentity.tags) || value.vmIdentity.tags.some((tag) => typeof tag !== "string")) {
      throw new SandboxError("validate", "VM tags are invalid", "STATE_SCHEMA")
    }
  }
  const lastError = isRecord(value.lastError) && typeof value.lastError.message === "string"
    ? { ...value.lastError, message: redactText(value.lastError.message) }
    : value.lastError
  return {
    ...value,
    provider,
    providerState: redactValues(providerState),
    ...(lastError ? { lastError } : {}),
  } as unknown as SandboxRecord
}

function redactValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValues)
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValues(item)]))
  }
  return typeof value === "string" ? redactText(value) : value
}

function containsCredentialKey(value: Record<string, unknown>): boolean {
  for (const [key, item] of Object.entries(value)) {
    if (/(?:password|token|secret|credential|auth(?:orization|_content)?|api[_-]?key|private[_-]?key)/i.test(key)) return true
    if (isRecord(item) && containsCredentialKey(item)) return true
    if (Array.isArray(item) && item.some((entry) => isRecord(entry) && containsCredentialKey(entry))) return true
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
