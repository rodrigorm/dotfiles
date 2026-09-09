export const SANDBOX_OPERATIONS = [
  "start",
  "stop",
  "status",
  "inspect",
  "inventory",
  "delete",
  "logs",
  "diagnose",
  "retry",
  "recover",
  "repair",
] as const

export type SandboxOperation = (typeof SANDBOX_OPERATIONS)[number]

export type PublicOperation = SandboxOperation

export const SANDBOX_STATES = [
  "local",
  "provisioning",
  "activation_pending",
  "remote",
  "stop_pending",
  "sync_failed",
  "detached",
  "delete_pending",
  "deleted",
  "recovery_pending",
  "orphaned",
  "error",
] as const

export type SandboxState = (typeof SANDBOX_STATES)[number]

export type SandboxStage = string

export interface VmIdentity {
  id?: string
  name: string
  sshDest: string
  sshUser?: string
  sshHost?: string
  region?: string
  tags: string[]
  comment: string
}

export interface VmInfo {
  identity: VmIdentity
  status?: string
}

export interface VmPlan {
  vmName: string
  branch: string
  tags: string[]
  comment: string
}

export interface CreateVmInput {
  name: string
  cpu: number
  memory: string
  tags: string[]
  comment: string
}

export interface CopyVmInput extends CreateVmInput {
  baseVm: string
}

export const PERSISTED_SANDBOX_SCHEMA_VERSION = 1 as const

export const MAX_OPERATION_JOURNAL_ENTRIES = 32 as const
export const MAX_OPERATION_JOURNAL_STRING_BYTES = 256 as const
export const MAX_OPERATION_JOURNAL_EVIDENCE_REFS = 8 as const
export const MAX_OPERATION_JOURNAL_EVIDENCE_BYTES = 4 * 1024
export const MAX_OPERATION_JOURNAL_BYTES = 16 * 1024

export interface SandboxJournalEntry {
  requestId: string
  operation: SandboxOperation
  startedAt: string
  endedAt?: string
  resultCode: string
  evidence: string[]
}

export interface SandboxRecord {
  sessionId: string
  workspaceId: string
  projectId: string
  provider: string
  providerState: Record<string, unknown>
  vmName?: string
  vmIdentity?: VmIdentity
  generation: number
  directory: string
  branch: string
  baseSha: string
  preservedWorktreePath?: string
  /** Compatibility projection for public responses and legacy callers. */
  state?: SandboxState
  schemaVersion?: typeof PERSISTED_SANDBOX_SCHEMA_VERSION
  desiredLocation?: SandboxDesiredLocation
  phase?: SandboxIntentPhase
  operation?: SandboxOperationRecord
  journal?: SandboxJournalEntry[]
  createdAt: string
  updatedAt: string
  lastError?: SandboxErrorRecord
}

export interface SandboxOperationRecord {
  kind: SandboxOperation
  phase: string
  requestId?: string
  force?: boolean
  providerDestroyed?: boolean
}

export interface SandboxErrorRecord {
  stage: string
  message: string
  code?: string
}

export type PersistedSandboxRecord = Omit<SandboxRecord, "state" | "schemaVersion" | "desiredLocation" | "phase"> & {
  schemaVersion: typeof PERSISTED_SANDBOX_SCHEMA_VERSION
  desiredLocation: SandboxDesiredLocation
  phase: SandboxIntentPhase
}

export interface SessionContext {
  sessionId: string
  projectId: string
  directory: string
  worktree: string
}

export interface WorkspaceInfo {
  id: string
  type: string
  name: string
  branch: string | null
  directory: string | null
  extra: unknown | null
  projectID: string
}

export interface WorkspaceRuntimeMetadata {
  providerState?: Record<string, unknown>
  vmName?: string
  vmIdentity?: VmIdentity
}

export interface ProviderResourceObservation {
  resourceId: string
  projectId?: string
  resource: "present" | "absent" | "unknown"
  ownership: "verified" | "unknown" | "conflict"
  health: "healthy" | "degraded" | "unknown"
  remoteVersion?: string
  evidence: string[]
}

export interface ProcessOwnershipObservation {
  observed: boolean
  process: "present" | "absent" | "unknown"
  ownership: "verified" | "unknown" | "conflict"
  liveness: "running" | "exited" | "unknown"
  pid?: number
  evidence: string[]
}

export interface DiagnosticVersionSources {
  configured?: string
  local?: string
  dependency?: string
}

export interface GitWorkingTreeObservation {
  head: string | null
  branch: string | null
  dirty: boolean | null
  evidence: string[]
}

export type WorkspaceProviderId = "exedev" | "sbx" | "cloudflare"

// Sync results identify a separate branch or a control-plane barrier; neither applies files to the active worktree.
export type WorkspaceSyncResult =
  | {
      kind: "control-plane"
      baseSha: string
    }
  | {
      kind: "branch"
      baseSha: string
      branch: string
    }

export interface WorkspaceSyncOutInput {
  workspaceId: string
  directory: string
  baseSha: string
}

export interface WorkspaceProviderBase {
  readonly type: string
  readonly name: string
  readonly description: string
  configure(info: WorkspaceInfo): WorkspaceInfo | Promise<WorkspaceInfo>
  prepare(info: WorkspaceInfo, env: Record<string, string | undefined>, from?: WorkspaceInfo): Promise<void>
  syncIn(workspaceId: string, capture: WorkingTreeCapture): Promise<void>
  syncOut?(input: WorkspaceSyncOutInput): Promise<WorkspaceSyncResult>
  target(info: WorkspaceInfo): WorkspaceTarget | Promise<WorkspaceTarget>
  release(info: WorkspaceInfo): Promise<void>
  destroy?(info: WorkspaceInfo): Promise<void>
  inspect?(info: WorkspaceInfo, signal?: AbortSignal): Promise<ProviderResourceObservation>
  diagnose?(info: WorkspaceInfo, signal?: AbortSignal): Promise<ProviderResourceObservation>
  inventory?(): Promise<ProviderResourceObservation[]>
  processObservation?(workspaceId: string): ProcessOwnershipObservation
  branch?(workspaceId: string): string
  runtimeMetadata?(workspaceId: string): WorkspaceRuntimeMetadata | undefined
  dispose?(): Promise<void>
}

export function isWorkspaceSyncResult(value: unknown): value is WorkspaceSyncResult {
  if (!isRecord(value) || typeof value.baseSha !== "string" || !/^[a-f0-9]{40}$/i.test(value.baseSha)) return false
  if (value.kind === "control-plane") return true
  return value.kind === "branch" && isWorkspaceBranch(value.branch)
}

export type WorkspaceTarget =
  | {
      type: "local"
      directory: string
    }
  | {
      type: "remote"
      url: string | URL
      headers?: HeadersInit
    }

export interface RuntimeResourceReference {
  provider: string
  resourceId: string
}

export interface RuntimeOwner {
  provider: string
  projectId: string
  sessionId: string
  generation: number
  workspaceId: string
  directory: string
  branch: string
  baseSha: string
}

export interface RuntimeAdoptionInput {
  resource: RuntimeResourceReference
  owner: RuntimeOwner
}

export interface RuntimeSession {
  readonly workspaceId: string
  readonly target: Extract<WorkspaceTarget, { type: "remote" }>
  /** Host-accessible worktree path; omitted for provider-local checkouts. */
  readonly worktreePath?: string
  /** Provider-local checkout path; never pass this to host Git. */
  readonly remoteWorktreePath?: string
  readonly recoveryMetadata?: Record<string, unknown>
  inspect?(signal?: AbortSignal): Promise<ProviderResourceObservation>
  diagnose?(signal?: AbortSignal): Promise<ProviderResourceObservation>
  processObservation?(): ProcessOwnershipObservation
  /** Drop only local control assets created for this session; never stop the provider resource. */
  abort?(): Promise<RuntimeCloseResult>
}

export interface RuntimeCloseResult {
  preservedWorktreePath?: string
}

export interface RuntimeDriver {
  inspect(resource: RuntimeResourceReference, signal?: AbortSignal): Promise<ProviderResourceObservation>
  adopt(input: RuntimeAdoptionInput): Promise<RuntimeSession>
  sync(session: RuntimeSession): Promise<void>
  close(session: RuntimeSession): Promise<RuntimeCloseResult>
  abort?(session: RuntimeSession): Promise<RuntimeCloseResult>
  destroy(resource: RuntimeResourceReference, owner: RuntimeOwner): Promise<void>
}

export interface WorkspaceCreateInput {
  type: string
  projectId: string
  directory: string
  id?: string
  branch: string
  extra: Record<string, unknown>
}

export interface WorkspaceReplayEvent {
  id: string
  aggregateID: string
  seq: number
  type: string
  data: Record<string, unknown>
}

export interface WorkspaceGateway {
  create(input: WorkspaceCreateInput): Promise<WorkspaceInfo>
  applyCapture?(input: { workspaceId: string; directory: string; capture: WorkingTreeCapture }): Promise<void>
  warp(input: { sessionId: string; workspaceId: string | null; directory: string }): Promise<void>
  replaySession?(input: { sessionId: string; directory: string; target: Extract<WorkspaceTarget, { type: "remote" }> }): Promise<void>
  startSync?(input: { directory: string }): Promise<void>
  remove(input: { workspaceId: string; directory: string }): Promise<void>
  waitForSync?(input: { workspaceId: string; directory: string; timeoutMs: number }): Promise<void>
  syncOut?(input: WorkspaceSyncOutInput): Promise<WorkspaceSyncResult>
  inspect?(input: { workspaceId: string; directory: string; signal?: AbortSignal }): Promise<WorkspaceInfo | undefined>
}

export interface WorkingTreeFile {
  path: string
  sha256: string
  content: Uint8Array
}

export interface WorkingTreeCapture {
  baseSha: string
  patch: string
  untracked: WorkingTreeFile[]
}

export type SandboxDesiredLocation = "local" | "remote" | "deleted"

export type SandboxIntentPhase =
  | "idle"
  | "capturing"
  | "provisioning"
  | "activating"
  | "syncing"
  | "detaching"
  | "deleting"

export const SANDBOX_DESIRED_LOCATIONS = ["local", "remote", "deleted"] as const
export const SANDBOX_INTENT_PHASES = ["idle", "capturing", "provisioning", "activating", "syncing", "detaching", "deleting"] as const

export function isSandboxDesiredLocation(value: unknown): value is SandboxDesiredLocation {
  return typeof value === "string" && (SANDBOX_DESIRED_LOCATIONS as readonly string[]).includes(value)
}

export function isSandboxIntentPhase(value: unknown): value is SandboxIntentPhase {
  return typeof value === "string" && (SANDBOX_INTENT_PHASES as readonly string[]).includes(value)
}

export interface SandboxObservation {
  source: "record" | "handle" | "workspace" | "provider" | "git"
  observed: boolean
  freshAt: string
  resource?: "present" | "absent" | "unknown"
  ownership?: "verified" | "unknown" | "conflict"
  health?: "healthy" | "degraded" | "unknown"
  evidence: string[]
}

export interface SandboxAllowedAction {
  operation: PublicOperation
  role: "host" | "remote"
  arguments: string[]
  preconditions: string[]
  waitFor: "none" | "session_idle" | "operation_completion"
}

export interface SandboxResultV2 {
  schemaVersion: 2
  requestId: string
  ok: boolean
  operation: PublicOperation
  message: string
  session: null | {
    projectId: string
    sessionId: string
    workspaceId: string
    generation: number
    provider: WorkspaceProviderId
  }
  intent: {
    desiredLocation: SandboxDesiredLocation
    phase: SandboxIntentPhase
  }
  effectiveTarget: null | { kind: "local"; directory: string } | { kind: "remote"; resourceId: string }
  observations: SandboxObservation[]
  classification: "clean" | "attached" | "control_lost" | "orphan" | "stale_record" | "leaked_resource" | "conflict" | "work_at_risk" | "unknown"
  work: {
    captureBaseSha: string | null
    runtimeHead: string | null
    sync: "clean" | "dirty" | "failed" | "unknown"
    preservation: "not_needed" | "preserved" | "at_risk" | "discard_authorized"
    preservedWorktreePath: string | null
  }
  allowedActions: SandboxAllowedAction[]
  recommendedAction: null | { operation: PublicOperation; reasonCode: string }
  error: null | { code: string; stage: string; retryable: boolean }
}

export interface SandboxResponse extends Partial<SandboxResultV2> {
  ok: boolean
  operation: PublicOperation
  state: SandboxState
  sessionId?: string
  workspaceId?: string
  vm?: string
  stage?: SandboxStage
  message: string
  diagnosticOperation?: "diagnose"
  details?: Record<string, unknown>
}

export interface ControlRequest {
  operation: SandboxOperation
  force: boolean
  requestId?: string
}

export type CapabilityRole = "host" | "remote"
export type CapabilityScope = "session" | "project"

export interface ControlCapability {
  token: string
  sessionId: string
  generation: number
  role: CapabilityRole
  scope?: CapabilityScope
  projectId?: string
  expiresAt: number
}

export interface AuthorizedControlRequest extends ControlRequest {
  capability: ControlCapability
}

export interface SandboxConfig {
  provider: WorkspaceProviderId
  baseVm: string | null
  cpu: number
  memory: string
  remotePort: number
  stateDirectory: string
  knownHostsFile: string
  sshLobby: string
  bootstrapTimeoutMs: number
  healthTimeoutMs: number
  openCodeVersion: string
}

export interface ProcessResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export interface RunProcessInput {
  argv: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  stdin?: string | Uint8Array
  onLine?: (line: string) => void
  timeoutMs?: number
  signal?: AbortSignal
  maxOutputBytes?: number
}

export interface ProcessRunner {
  run(input: RunProcessInput): Promise<ProcessResult>
}

export interface ProcessHandle {
  readonly pid: number
  readonly alive?: boolean
  readonly result: Promise<ProcessResult>
  terminate(): void
}

export interface ProcessSupervisor {
  start(input: RunProcessInput): Promise<ProcessHandle>
}

export class SandboxError extends Error {
  readonly stage: SandboxStage
  readonly code: string

  constructor(stage: SandboxStage, message: string, code = "SANDBOX_ERROR") {
    super(message)
    this.name = "SandboxError"
    this.stage = stage
    this.code = code
  }
}

export function isSandboxOperation(value: unknown): value is SandboxOperation {
  return typeof value === "string" && (SANDBOX_OPERATIONS as readonly string[]).includes(value)
}

export function isRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
}

export function isSandboxState(value: unknown): value is SandboxState {
  return typeof value === "string" && (SANDBOX_STATES as readonly string[]).includes(value)
}

function isWorkspaceBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("..") &&
    !value.includes("//") &&
    !/[\0\n\r ~^:?*\[\\]/.test(value)
  )
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function copyVmIdentity(identity: VmIdentity): VmIdentity {
  return { ...identity, tags: [...identity.tags] }
}

export function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}
