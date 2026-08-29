import { ExedevError, isExedevOperation, type ExedevOperation, type ExedevState } from "./types"

const TRANSITIONS: Record<ExedevState, readonly ExedevState[]> = {
  local: ["provisioning", "error"],
  provisioning: ["activation_pending", "error", "recovery_pending"],
  activation_pending: ["remote", "error", "recovery_pending"],
  remote: ["stop_pending", "delete_pending", "error", "recovery_pending"],
  stop_pending: ["detached", "error", "recovery_pending"],
  detached: ["provisioning", "delete_pending", "deleted", "error"],
  delete_pending: ["deleted", "error", "recovery_pending"],
  deleted: [],
  recovery_pending: ["detached", "error"],
  error: ["provisioning", "stop_pending", "delete_pending", "recovery_pending"],
}

export function canTransition(from: ExedevState, to: ExedevState): boolean {
  return TRANSITIONS[from].includes(to)
}

export function assertTransition(from: ExedevState, to: ExedevState): void {
  if (!canTransition(from, to)) {
    throw new ExedevError("validate", `invalid lifecycle transition: ${from} -> ${to}`, "STATE_TRANSITION")
  }
}

export function nextStateFor(state: ExedevState, operation: ExedevOperation): ExedevState {
  if (!isExedevOperation(operation)) {
    throw new ExedevError("validate", `unsupported operation: ${String(operation)}`, "OPERATION_INVALID")
  }

  switch (operation) {
    case "start":
      return state === "remote" || state === "provisioning" || state === "activation_pending" ? state : "provisioning"
    case "stop":
      return state === "remote" || state === "stop_pending" ? "stop_pending" : state
    case "delete":
      return state === "deleted" || state === "delete_pending" ? state : "delete_pending"
    case "status":
    case "logs":
    case "diagnose":
    case "retry":
      return state
  }
}

export function isTransitionPending(state: ExedevState): boolean {
  return state === "provisioning" || state === "activation_pending" || state === "stop_pending" || state === "delete_pending" || state === "recovery_pending"
}
