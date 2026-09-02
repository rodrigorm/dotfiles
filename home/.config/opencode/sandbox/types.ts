export const SANDBOX_OPERATIONS = [
  "start",
  "stop",
  "status",
  "delete",
  "logs",
  "diagnose",
  "retry",
] as const

export type SandboxOperation = (typeof SANDBOX_OPERATIONS)[number]

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
  state: SandboxState
  operation?: {
    kind: SandboxOperation
    phase: string
  }
  createdAt: string
  updatedAt: string
  lastError?: {
    stage: string
    message: string
  }
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
  replaySession?(input: { sessionId: string; target: Extract<WorkspaceTarget, { type: "remote" }> }): Promise<void>
  startSync?(input: { directory: string }): Promise<void>
  remove(input: { workspaceId: string; directory: string }): Promise<void>
  waitForSync?(input: { workspaceId: string; directory: string; timeoutMs: number }): Promise<void>
  syncOut?(input: WorkspaceSyncOutInput): Promise<WorkspaceSyncResult>
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

export interface SandboxResponse {
  ok: boolean
  operation: SandboxOperation
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
}

export type CapabilityRole = "host" | "remote"

export interface ControlCapability {
  token: string
  sessionId: string
  generation: number
  role: CapabilityRole
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
