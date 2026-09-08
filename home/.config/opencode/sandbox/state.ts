import {
  SandboxError,
  type PersistedSandboxRecord,
  type SandboxDesiredLocation,
  type SandboxIntentPhase,
  type SandboxOperation,
  type SandboxRecord,
  type SandboxState,
} from "./types"

const INTENT_PHASES: Record<SandboxDesiredLocation, readonly SandboxIntentPhase[]> = {
  local: ["idle", "syncing", "detaching"],
  remote: ["idle", "capturing", "syncing", "provisioning", "activating"],
  deleted: ["idle", "syncing", "deleting"],
}

const BLOCKING_OPERATION_KINDS: readonly SandboxOperation[] = ["start", "stop", "delete", "recover"]

export function isLegalIntentPhase(desiredLocation: SandboxDesiredLocation, phase: SandboxIntentPhase): boolean {
  return INTENT_PHASES[desiredLocation].includes(phase)
}

export function assertLegalIntentPhase(desiredLocation: SandboxDesiredLocation, phase: SandboxIntentPhase): void {
  if (!isLegalIntentPhase(desiredLocation, phase)) {
    throw new SandboxError("validate", `invalid persisted intent: ${desiredLocation} + ${phase}`, "STATE_INTENT")
  }
}

export function isBlockingOperation(operation?: SandboxRecord["operation"]): boolean {
  return operation !== undefined && BLOCKING_OPERATION_KINDS.includes(operation.kind)
}

export function intentForLegacyState(
  state: SandboxState,
  operation?: SandboxRecord["operation"],
): { desiredLocation: SandboxDesiredLocation; phase: SandboxIntentPhase } {
  switch (state) {
    case "local":
    case "detached":
      return { desiredLocation: "local", phase: "idle" }
    case "provisioning":
      return { desiredLocation: "remote", phase: "provisioning" }
    case "activation_pending":
      return { desiredLocation: "remote", phase: "activating" }
    case "remote":
      return { desiredLocation: "remote", phase: "idle" }
    case "stop_pending":
      return { desiredLocation: "local", phase: "detaching" }
    case "delete_pending":
      return { desiredLocation: "deleted", phase: "deleting" }
    case "deleted":
      return { desiredLocation: "deleted", phase: "idle" }
    case "sync_failed":
    case "recovery_pending":
    case "orphaned":
    case "error":
      return { desiredLocation: failedIntentLocation(state, operation), phase: "idle" }
  }
}

export function operationForLegacyState(
  state: SandboxState,
  operation?: SandboxRecord["operation"],
): SandboxRecord["operation"] | undefined {
  if (operation) return operation
  switch (state) {
    case "provisioning":
      return { kind: "start", phase: "provisioning" }
    case "activation_pending":
      return { kind: "start", phase: "awaiting_idle" }
    case "stop_pending":
      return { kind: "stop", phase: "awaiting_idle" }
    case "delete_pending":
      return { kind: "delete", phase: "awaiting_idle" }
    case "detached":
      return { kind: "stop", phase: "detached" }
    default:
      return undefined
  }
}

export function operationForIntent(
  desiredLocation: SandboxDesiredLocation,
  phase: SandboxIntentPhase,
  operation?: SandboxRecord["operation"],
): SandboxRecord["operation"] | undefined {
  if (operation) return operation
  if (desiredLocation === "remote" && phase === "activating") return { kind: "start", phase: "awaiting_idle" }
  if (desiredLocation === "local" && phase === "detaching") return { kind: "stop", phase: "awaiting_idle" }
  if (desiredLocation === "deleted" && phase === "deleting") return { kind: "delete", phase: "awaiting_idle" }
  return undefined
}

export function compatibilityStateForIntent(record: Pick<PersistedSandboxRecord, "desiredLocation" | "phase" | "operation" | "lastError">): SandboxState {
  const operation = record.operation
  const error = record.lastError

  if (error) {
    if (record.desiredLocation === "remote" && error.code === "SANDCASTLE_HANDLE") return "orphaned"
    if (error.code === "LEGACY_ORPHANED") return "orphaned"
    if (error.code === "LEGACY_RECOVERY") return "recovery_pending"
    if (error.code === "DELETE_RECOVERY_REQUIRED" || error.code === "STOP_RECOVERY_REQUIRED") return "recovery_pending"
    if (operation?.kind === "recover") return "recovery_pending"
    if (operation?.kind === "start" && operation.phase === "provisioning") return "error"
    if (error.stage === "sync" || error.code?.includes("SYNC")) return "sync_failed"
    return "error"
  }

  if (record.desiredLocation === "deleted") {
    return record.phase === "deleting" ? "delete_pending" : "deleted"
  }
  if (record.desiredLocation === "remote") {
    if (record.phase === "provisioning" || record.phase === "capturing") return "provisioning"
    if (record.phase === "activating") return "activation_pending"
    return "remote"
  }
  if (record.phase === "detaching") return "stop_pending"
  if (record.phase === "syncing") {
    if (operation?.kind === "delete") return "delete_pending"
    if (operation?.kind === "stop") return "stop_pending"
  }
  if (operation?.kind === "stop" && operation.phase === "detached") return "detached"
  return "local"
}

function failedIntentLocation(
  state: Extract<SandboxState, "sync_failed" | "recovery_pending" | "orphaned" | "error">,
  operation?: SandboxRecord["operation"],
): SandboxDesiredLocation {
  switch (operation?.kind) {
    case "start":
    case "recover":
      return "remote"
    case "stop":
      return "local"
    case "delete":
      return "deleted"
    default:
      return state === "orphaned" ? "remote" : "local"
  }
}
