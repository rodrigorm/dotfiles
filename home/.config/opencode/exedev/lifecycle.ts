import { randomBytes } from "node:crypto"

import { createCapability } from "./control-channel"
import { makeVmPlan } from "./naming"
import { redactError } from "./redaction"
import { assertTransition, isTransitionPending } from "./state"
import { FileStateStore } from "./state-store"
import {
  ExedevError,
  type AuthorizedControlRequest,
  type ControlCapability,
  type ExedevRecord,
  type ExedevResponse,
  type SessionContext,
  type VmIdentity,
  type WorkingTreeCapture,
  type WorkspaceGateway,
} from "./types"

export interface TransitionFence {
  supported: boolean
  reason?: string
}

export interface InfrastructureOperations {
  remove?(identity: VmIdentity): Promise<void>
  diagnose?(record: ExedevRecord): Promise<Record<string, unknown>>
  logs?(record: ExedevRecord): Promise<string[]>
  preflightDelete?(record: ExedevRecord): Promise<Record<string, unknown>>
}

export interface LifecycleDependencies {
  store: FileStateStore
  workspace: WorkspaceGateway
  fence: TransitionFence
  capture?: (context: SessionContext) => Promise<WorkingTreeCapture>
  infrastructure?: InfrastructureOperations
  now?: () => Date
}

export class LifecycleController {
  private readonly store: FileStateStore
  private readonly workspace: WorkspaceGateway
  private readonly fence: TransitionFence
  private readonly capture?: (context: SessionContext) => Promise<WorkingTreeCapture>
  private readonly infrastructure: InfrastructureOperations
  private readonly now: () => Date
  private readonly contexts = new Map<string, SessionContext>()

  constructor(dependencies: LifecycleDependencies) {
    this.store = dependencies.store
    this.workspace = dependencies.workspace
    this.fence = dependencies.fence
    this.capture = dependencies.capture
    this.infrastructure = dependencies.infrastructure ?? {}
    this.now = dependencies.now ?? (() => new Date())
  }

  registerContext(context: SessionContext): void {
    this.contexts.set(context.sessionId, context)
  }

  unregisterContext(sessionId: string): void {
    this.contexts.delete(sessionId)
  }

  async capabilityFor(sessionId: string, role: "host" | "remote" = "host"): Promise<ControlCapability> {
    const record = await this.store.get(sessionId)
    return createCapability({
      sessionId,
      generation: record?.generation ?? 1,
      role,
    })
  }

  async handle(request: AuthorizedControlRequest): Promise<ExedevResponse> {
    try {
      const record = await this.store.get(request.capability.sessionId)
      this.assertCapability(record, request.capability)

      switch (request.operation) {
        case "start":
          return await this.start(request.capability)
        case "stop":
          return await this.stop(request.capability)
        case "status":
          return this.status(request.capability, record)
        case "logs":
          return await this.logs(request.capability, record)
        case "diagnose":
          return await this.diagnose(request.capability, record)
        case "delete":
          return await this.delete(request.capability, record, request.force)
        case "retry":
          return await this.retry(request.capability, record)
      }
    } catch (error) {
      const record = await this.store.get(request.capability.sessionId).catch(() => undefined)
      return failureResponse(
        request.operation,
        record?.state ?? "error",
        error instanceof ExedevError ? error.stage : "validate",
        redactError(error),
        record,
      )
    }
  }

  async onSessionIdle(sessionId: string): Promise<void> {
    await this.store.withRecordLock(sessionId, async (record, write) => {
      if (!record || !isTransitionPending(record.state)) return
      if (!this.fence.supported) return

      try {
        if (record.state === "activation_pending") {
          await this.waitForSync(record)
          await this.workspace.warp({ sessionId, workspaceId: record.workspaceId, directory: record.directory })
          await write({
            ...record,
            state: "remote",
            operation: record.operation ? { ...record.operation, phase: "remote" } : undefined,
            updatedAt: this.now().toISOString(),
            lastError: undefined,
          })
          return
        }

        if (record.state === "stop_pending" || record.state === "recovery_pending") {
          await this.waitForSync(record)
          await this.workspace.warp({ sessionId, workspaceId: null, directory: record.directory })
          if (record.workspaceId) await this.workspace.remove({ workspaceId: record.workspaceId, directory: record.directory })
          const nextState = "detached"
          assertTransition(record.state, nextState)
          await write({
            ...record,
            state: nextState,
            operation: record.operation ? { ...record.operation, phase: "detached" } : undefined,
            updatedAt: this.now().toISOString(),
            lastError: undefined,
          })
          return
        }

        if (record.state === "delete_pending") {
          const workspaceStillAttached = record.operation?.phase !== "removing"
          if (workspaceStillAttached && record.workspaceId) {
            await this.waitForSync(record)
            await this.workspace.warp({ sessionId, workspaceId: null, directory: record.directory })
            await this.workspace.remove({ workspaceId: record.workspaceId, directory: record.directory })
          }
          if (!this.infrastructure.remove) throw new ExedevError("remove", "VM removal is not configured", "REMOVE_UNAVAILABLE")
          await this.infrastructure.remove(record.vmIdentity)
          await write({
            ...record,
            state: "deleted",
            operation: record.operation ? { ...record.operation, phase: "deleted" } : undefined,
            updatedAt: this.now().toISOString(),
            lastError: undefined,
          })
        }
      } catch (error) {
        await write({
          ...record,
          state: "error",
          updatedAt: this.now().toISOString(),
          lastError: {
            stage: error instanceof ExedevError ? error.stage : "reconcile",
            message: redactError(error),
          },
        })
      }
    })
  }

  async assertMessageAllowed(sessionId: string): Promise<void> {
    const record = await this.store.get(sessionId)
    if (!record) return
    if (isTransitionPending(record.state)) {
      throw new ExedevError("fencing", "session transition is still pending; retry after it completes", "TRANSITION_PENDING")
    }
    if (record.state === "error") {
      throw new ExedevError("fencing", "session is in an error state; run exedevctl diagnose or retry", "SESSION_ERROR")
    }
  }

  async reconcile(projectId?: string): Promise<void> {
    for (const record of await this.store.list()) {
      if (projectId && record.projectId !== projectId) continue
      if (record.state !== "provisioning" && record.state !== "activation_pending" && record.state !== "remote" && record.state !== "stop_pending" && record.state !== "delete_pending") continue
      assertTransition(record.state, "recovery_pending")
      await this.store.write({
        ...record,
        state: "recovery_pending",
        operation: record.operation ? { ...record.operation, phase: "recovery_pending" } : undefined,
        updatedAt: this.now().toISOString(),
        lastError: this.fence.supported
          ? undefined
          : {
              stage: "reconcile",
              message: "local OpenCode restarted without a supported pre-routing fencing seam",
            },
      })
    }
  }

  dispose(): void {
    this.contexts.clear()
  }

  private async start(capability: ControlCapability): Promise<ExedevResponse> {
    const context = this.contexts.get(capability.sessionId)
    if (!context) throw new ExedevError("validate", "session context is not available", "SESSION_CONTEXT")
    if (!this.fence.supported) {
      return failureResponse("start", "error", "fencing", this.fence.reason ?? "no supported pre-routing fencing seam")
    }

    return this.store.withRecordLock(capability.sessionId, async (existing, write) => {
      if (existing?.state === "remote") return successResponse("start", existing, "session is already remote")
      if (existing && (existing.state === "provisioning" || existing.state === "activation_pending")) {
        return successResponse("start", existing, "session activation is already pending")
      }
      if (existing?.state === "deleted") throw new ExedevError("validate", "session VM has already been deleted", "SESSION_DELETED")

      const resuming = existing?.state === "detached"
      const generation = existing?.state === "error" ? existing.generation : (existing?.generation ?? 0) + 1
      const workspaceId = existing?.state === "error" ? existing.workspaceId : workspaceIdFor(capability.sessionId, generation)
      const plan = makeVmPlan({ workspaceId, projectId: context.projectId, generation })
      let vmName = plan.vmName
      let branch = plan.branch
      let vmIdentity: VmIdentity = {
        name: plan.vmName,
        sshDest: "pending",
        tags: plan.tags,
        comment: plan.comment,
      }
      if (resuming && existing) {
        vmName = existing.vmName
        branch = existing.branch
        vmIdentity = { ...existing.vmIdentity, tags: plan.tags, comment: plan.comment }
      } else if (existing?.state === "error") {
        vmName = existing.vmName
        branch = existing.branch
        vmIdentity = existing.vmIdentity
      }
      const capture = this.capture ? await this.capture(context) : undefined
      if (!capture) throw new ExedevError("checkout", "working tree capture is not configured", "CAPTURE_UNAVAILABLE")

      const operation = {
        id: randomBytes(16).toString("hex"),
        kind: "start" as const,
        phase: "provisioning",
        startedAt: this.now().toISOString(),
      }
      const pending: ExedevRecord = {
        sessionId: capability.sessionId,
        workspaceId,
        projectId: context.projectId,
        vmName,
        vmIdentity,
        generation,
        directory: context.directory,
        branch,
        baseSha: capture.baseSha,
        state: "provisioning",
        operation,
        createdAt: existing?.createdAt ?? this.now().toISOString(),
        updatedAt: this.now().toISOString(),
      }
      await write(pending)

      try {
        const workspace = await this.workspace.create({
          type: "exedev",
          projectId: context.projectId,
          directory: context.directory,
          id: workspaceId,
          branch,
          extra: {
            owner: "opencode-exedev",
            sessionId: capability.sessionId,
            generation,
            baseSha: capture.baseSha,
            vmName,
            tags: plan.tags,
            comment: plan.comment,
          },
        })
        if (workspace.id.length === 0 || workspace.projectID !== context.projectId || workspace.type !== "exedev") {
          throw new ExedevError("provision", "workspace response did not match the requested owner", "WORKSPACE_IDENTITY")
        }
        if (capture.patch || capture.untracked.length > 0) {
          if (!this.workspace.applyCapture) {
            throw new ExedevError("sync", "remote capture helper is unavailable; activation stays local", "CAPTURE_APPLY_UNAVAILABLE")
          }
          await this.workspace.applyCapture({ workspaceId: workspace.id, directory: context.directory, capture })
        }
        const metadata = workspaceMetadata(workspace.extra)
        const next: ExedevRecord = {
          ...pending,
          workspaceId: workspace.id,
          vmName: metadata.vmName ?? pending.vmName,
          vmIdentity: metadata.vmIdentity ?? pending.vmIdentity,
          state: "activation_pending",
          operation: { ...operation, phase: "awaiting_idle" },
          updatedAt: this.now().toISOString(),
          lastError: undefined,
        }
        assertTransition(pending.state, next.state)
        await write(next)
        return successResponse("start", next, "VM pronta. A proxima mensagem sera executada na exe.dev.")
      } catch (error) {
        const failed: ExedevRecord = {
          ...pending,
          state: "error",
          updatedAt: this.now().toISOString(),
          lastError: {
            stage: error instanceof ExedevError ? error.stage : "provision",
            message: redactError(error),
          },
        }
        await write(failed)
        const lastError = failed.lastError ?? { stage: "provision", message: "start failed" }
        return failureResponse("start", "error", lastError.stage, lastError.message, failed)
      }
    })
  }

  private async stop(capability: ControlCapability): Promise<ExedevResponse> {
    return this.store.withRecordLock(capability.sessionId, async (record, write) => {
      if (!record) return successResponse("stop", undefined, "session is already local")
      if (record.state === "detached" || record.state === "local") return successResponse("stop", record, "session is already local")
      if (record.state === "stop_pending") return successResponse("stop", record, "session detach is already pending")
      if (record.state !== "remote") throw new ExedevError("fencing", "cannot stop while another transition is pending", "STOP_TRANSITION")

      const next: ExedevRecord = {
        ...record,
        state: "stop_pending",
        operation: {
          id: randomBytes(16).toString("hex"),
          kind: "stop",
          phase: "awaiting_idle",
          startedAt: this.now().toISOString(),
        },
        updatedAt: this.now().toISOString(),
      }
      assertTransition(record.state, next.state)
      await write(next)
      return successResponse("stop", next, "Detach agendado; a resposta atual sera concluida primeiro.")
    })
  }

  private status(capability: ControlCapability, record: ExedevRecord | undefined): ExedevResponse {
    if (!record) return successResponse("status", undefined, "session is local")
    return successResponse("status", record, `session state: ${record.state}`)
  }

  private async logs(capability: ControlCapability, record: ExedevRecord | undefined): Promise<ExedevResponse> {
    if (!record) return successResponse("logs", undefined, "no exedev session is associated")
    const logs = this.infrastructure.logs ? await this.infrastructure.logs(record) : []
    return successResponse("logs", record, logs.join("\n"), { logs })
  }

  private async diagnose(capability: ControlCapability, record: ExedevRecord | undefined): Promise<ExedevResponse> {
    if (!record) return successResponse("diagnose", undefined, "no exedev session is associated")
    const details = this.infrastructure.diagnose ? await this.infrastructure.diagnose(record) : { configured: false }
    return successResponse("diagnose", record, "diagnostics completed", details)
  }

  private async delete(capability: ControlCapability, record: ExedevRecord | undefined, force: boolean): Promise<ExedevResponse> {
    if (!record || record.state === "deleted") return successResponse("delete", record, "VM is already deleted")
    if (force && (capability.role !== "host" || record.state !== "detached")) {
      throw new ExedevError("remove", "force delete is available only on the host after stop", "FORCE_DELETE_SCOPE")
    }
    if (record.state !== "remote" && record.state !== "detached") {
      throw new ExedevError("fencing", "delete is blocked while a transition is pending", "DELETE_TRANSITION")
    }
    if (!force && this.infrastructure.preflightDelete) await this.infrastructure.preflightDelete(record)
    if (!this.infrastructure.remove) throw new ExedevError("remove", "VM removal is not configured", "REMOVE_UNAVAILABLE")

    const next: ExedevRecord = {
      ...record,
      state: "delete_pending",
      operation: {
        id: randomBytes(16).toString("hex"),
        kind: "delete",
        phase: force || record.state === "detached" ? "removing" : "awaiting_idle",
        startedAt: this.now().toISOString(),
      },
      updatedAt: this.now().toISOString(),
    }
    assertTransition(record.state, next.state)
    await this.store.write(next)
    if (force) await this.onSessionIdle(capability.sessionId)
    return successResponse("delete", next, force ? "VM removal requested." : "Delete agendado; a resposta atual sera concluida primeiro.")
  }

  private async retry(capability: ControlCapability, record: ExedevRecord | undefined): Promise<ExedevResponse> {
    if (!record || record.state !== "error") return successResponse("retry", record, "there is no failed operation to retry")
    const operation = record.operation?.kind
    if (operation === "start") return this.start(capability)
    if (operation === "stop") return this.stop(capability)
    if (operation === "delete") return this.delete(capability, record, false)
    throw new ExedevError("validate", "no retryable operation is recorded", "RETRY_UNAVAILABLE")
  }

  private assertCapability(record: ExedevRecord | undefined, capability: ControlCapability): void {
    if (record && capability.generation !== record.generation) {
      throw new ExedevError("validate", "control capability belongs to an old generation", "CAPABILITY_GENERATION")
    }
    if (record && capability.role === "remote" && record.state === "detached") {
      throw new ExedevError("validate", "remote capability is detached", "CAPABILITY_REVOKED")
    }
  }

  private async waitForSync(record: ExedevRecord): Promise<void> {
    if (!this.workspace.waitForSync) return
    await this.workspace.waitForSync({
      workspaceId: record.workspaceId,
      directory: record.directory,
      timeoutMs: 30_000,
    })
  }
}

function workspaceIdFor(sessionId: string, generation: number): string {
  const compact = Buffer.from(`${sessionId}:${generation}`).toString("base64url").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)
  return `wrk_${compact}`
}

function workspaceMetadata(value: unknown): { vmName?: string; vmIdentity?: VmIdentity } {
  if (!isRecord(value)) return {}
  const vmName = typeof value.vmName === "string" ? value.vmName : undefined
  if (!isRecord(value.vmIdentity) || typeof value.vmIdentity.name !== "string" || typeof value.vmIdentity.sshDest !== "string") {
    return { vmName }
  }
  const identity: VmIdentity = {
    name: value.vmIdentity.name,
    sshDest: value.vmIdentity.sshDest,
    tags: Array.isArray(value.vmIdentity.tags) ? value.vmIdentity.tags.filter((tag): tag is string => typeof tag === "string") : [],
    comment: typeof value.vmIdentity.comment === "string" ? value.vmIdentity.comment : "",
  }
  for (const [source, target] of [["id", "id"], ["sshUser", "sshUser"], ["sshHost", "sshHost"], ["region", "region"]] as const) {
    if (typeof value.vmIdentity[source] === "string") identity[target] = value.vmIdentity[source]
  }
  return { vmName, vmIdentity: identity }
}

function successResponse(operation: "start" | "stop" | "status" | "delete" | "logs" | "diagnose" | "retry", record: ExedevRecord | undefined, message: string, details?: Record<string, unknown>): ExedevResponse {
  return {
    ok: true,
    operation,
    state: record?.state ?? (operation === "delete" ? "deleted" : "local"),
    sessionId: record?.sessionId,
    workspaceId: record?.workspaceId,
    vm: record?.vmName,
    message,
    ...(details ? { details } : {}),
  }
}

function failureResponse(operation: "start" | "stop" | "status" | "delete" | "logs" | "diagnose" | "retry", state: ExedevRecord["state"] | "error", stage: string, message: string, record?: ExedevRecord): ExedevResponse {
  return {
    ok: false,
    operation,
    state,
    stage,
    sessionId: record?.sessionId,
    workspaceId: record?.workspaceId,
    vm: record?.vmName,
    message,
    diagnosticOperation: "diagnose",
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
