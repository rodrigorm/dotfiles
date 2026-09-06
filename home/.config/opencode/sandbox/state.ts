import { SandboxError, type SandboxState } from "./types"

const TRANSITIONS: Record<SandboxState, readonly SandboxState[]> = {
  local: ["provisioning", "error"],
  provisioning: ["activation_pending", "error", "recovery_pending", "orphaned"],
  activation_pending: ["remote", "error", "recovery_pending", "orphaned"],
  remote: ["stop_pending", "delete_pending", "sync_failed", "error", "recovery_pending", "orphaned"],
  stop_pending: ["detached", "sync_failed", "error", "recovery_pending"],
  sync_failed: ["remote", "stop_pending", "delete_pending", "error", "orphaned"],
  detached: ["provisioning", "delete_pending", "deleted", "error"],
  delete_pending: ["deleted", "sync_failed", "error", "recovery_pending"],
  deleted: [],
  recovery_pending: ["remote", "detached", "deleted", "error", "orphaned", "delete_pending"],
  orphaned: ["recovery_pending", "delete_pending"],
  error: ["provisioning", "activation_pending", "remote", "stop_pending", "delete_pending", "recovery_pending", "sync_failed", "orphaned"],
}

export function canTransition(from: SandboxState, to: SandboxState): boolean {
  return TRANSITIONS[from].includes(to)
}

export function assertTransition(from: SandboxState, to: SandboxState): void {
  if (!canTransition(from, to)) {
    throw new SandboxError("validate", `invalid lifecycle transition: ${from} -> ${to}`, "STATE_TRANSITION")
  }
}

export function isTransitionPending(state: SandboxState): boolean {
  return state === "provisioning" || state === "activation_pending" || state === "stop_pending" || state === "delete_pending" || state === "recovery_pending"
}
