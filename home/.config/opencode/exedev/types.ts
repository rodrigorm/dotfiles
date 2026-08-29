export const EXEDEV_OPERATIONS = [
  "start",
  "stop",
  "status",
  "delete",
  "logs",
  "diagnose",
  "retry",
] as const

export type ExedevOperation = (typeof EXEDEV_OPERATIONS)[number]

export const EXEDEV_STATES = [
  "local",
  "provisioning",
  "activation_pending",
  "remote",
  "stop_pending",
  "detached",
  "delete_pending",
  "deleted",
  "recovery_pending",
  "error",
] as const

export type ExedevState = (typeof EXEDEV_STATES)[number]

export const EXEDEV_STAGES = [
  "validate",
  "discover",
  "provision",
  "bootstrap",
  "checkout",
  "tunnel",
  "remote_health",
  "sync",
  "activation",
  "git_preflight",
  "detach",
  "remove",
  "reconcile",
  "fencing",
  "control_channel",
] as const

export type ExedevStage = (typeof EXEDEV_STAGES)[number] | (string & {})

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

export interface ExedevRecord {
  sessionId: string
  workspaceId: string
  projectId: string
  vmName: string
  vmIdentity: VmIdentity
  generation: number
  directory: string
  branch: string
  baseSha: string
  state: ExedevState
  localPort?: number
  localControlSocket?: string
  remoteControlSocket?: string
  operation?: {
    id: string
    kind: ExedevOperation
    phase: string
    startedAt: string
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

export interface WorkspaceGateway {
  create(input: WorkspaceCreateInput): Promise<WorkspaceInfo>
  applyCapture?(input: { workspaceId: string; directory: string; capture: WorkingTreeCapture }): Promise<void>
  warp(input: { sessionId: string; workspaceId: string | null; directory: string }): Promise<void>
  remove(input: { workspaceId: string; directory: string }): Promise<void>
  waitForSync?(input: { workspaceId: string; directory: string; timeoutMs: number }): Promise<void>
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

export interface ExedevResponse {
  ok: boolean
  operation: ExedevOperation
  state: ExedevState
  sessionId?: string
  workspaceId?: string
  vm?: string
  stage?: ExedevStage
  message: string
  diagnosticOperation?: "diagnose"
  details?: Record<string, unknown>
}

export interface ControlRequest {
  operation: ExedevOperation
  force: boolean
}

export type CapabilityRole = "host" | "remote"

export interface ControlCapability {
  token: string
  sessionId: string
  generation: number
  role: CapabilityRole
  expiresAt: number
  allowStart: boolean
  allowForce: boolean
}

export interface AuthorizedControlRequest extends ControlRequest {
  capability: ControlCapability
}

export interface ExedevConfig {
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
  timeoutMs?: number
  signal?: AbortSignal
  maxOutputBytes?: number
}

export interface ProcessRunner {
  run(input: RunProcessInput): Promise<ProcessResult>
}

export class ExedevError extends Error {
  readonly stage: ExedevStage
  readonly code: string

  constructor(stage: ExedevStage, message: string, code = "EXEDEV_ERROR") {
    super(message)
    this.name = "ExedevError"
    this.stage = stage
    this.code = code
  }
}

export function isExedevOperation(value: unknown): value is ExedevOperation {
  return typeof value === "string" && (EXEDEV_OPERATIONS as readonly string[]).includes(value)
}

export function isExedevState(value: unknown): value is ExedevState {
  return typeof value === "string" && (EXEDEV_STATES as readonly string[]).includes(value)
}
