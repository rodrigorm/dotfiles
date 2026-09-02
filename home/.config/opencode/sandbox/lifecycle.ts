import { createCapability } from "./control-channel"
import { shortHash } from "./naming"
import { redactError, redactText } from "./redaction"
import { assertTransition, isTransitionPending } from "./state"
import { FileStateStore } from "./state-store"
import {
  isRecord,
  SandboxError,
  type AuthorizedControlRequest,
  type ControlCapability,
  type SandboxRecord,
  type SandboxResponse,
  type SandboxState,
  type SessionContext,
  type VmIdentity,
  type WorkingTreeCapture,
  type WorkspaceGateway,
  type WorkspaceTarget,
} from "./types"
import {
  createSandcastleSession,
  type SandcastleSession,
  type SandcastleSessionFactory,
} from "./sandcastle-session"

const MAX_DIAGNOSTIC_BYTES = 64 * 1024

export interface InfrastructureOperations {
  remove?(record: SandboxRecord): Promise<void>
  diagnose?(record: SandboxRecord): Promise<Record<string, unknown>>
  logs?(record: SandboxRecord): Promise<string[]>
  preflightDelete?(record: SandboxRecord): Promise<Record<string, unknown>>
}

export interface LifecycleDependencies {
  store: FileStateStore
  workspace: WorkspaceGateway
  capture?: (context: SessionContext) => Promise<WorkingTreeCapture>
  infrastructure?: InfrastructureOperations
  providerType?: string
  branchForWorkspace?: (workspaceId: string) => string
  providerRelease?: (record: SandboxRecord) => Promise<void>
  providerDestroy?: (record: SandboxRecord) => Promise<void>
  sandcastle?: SandcastleSessionFactory
  now?: () => Date
}

export class LifecycleController {
  private readonly store: FileStateStore
  private readonly workspace: WorkspaceGateway
  private readonly capture?: (context: SessionContext) => Promise<WorkingTreeCapture>
  private readonly infrastructure: InfrastructureOperations
  private readonly providerType: string
  private readonly branchForWorkspace?: (workspaceId: string) => string
  private readonly providerRelease?: (record: SandboxRecord) => Promise<void>
  private readonly providerDestroy?: (record: SandboxRecord) => Promise<void>
  private readonly sandcastle?: SandcastleSessionFactory
  private readonly now: () => Date
  private readonly contexts = new Map<string, SessionContext>()
  private readonly sessions = new Map<string, SandcastleSession>()
  private readonly targets = new Map<string, WorkspaceTarget | Promise<WorkspaceTarget>>()
  private readonly targetGates = new Map<string, Deferred<WorkspaceTarget>>()

  constructor(dependencies: LifecycleDependencies) {
    this.store = dependencies.store
    this.workspace = dependencies.workspace
    this.capture = dependencies.capture
    this.infrastructure = dependencies.infrastructure ?? {}
    this.providerType = dependencies.providerType ?? "exedev"
    this.branchForWorkspace = dependencies.branchForWorkspace
    this.providerRelease = dependencies.providerRelease
    this.providerDestroy = dependencies.providerDestroy
    this.sandcastle = dependencies.sandcastle
    this.now = dependencies.now ?? (() => new Date())
  }

  registerContext(context: SessionContext): void {
    this.contexts.set(context.sessionId, context)
  }

  async capabilityFor(sessionId: string, role: "host" | "remote" = "host"): Promise<ControlCapability> {
    const record = await this.store.get(sessionId)
    return createCapability({
      sessionId,
      generation: record?.generation ?? 1,
      role,
    })
  }

  targetFor(sessionId: string): WorkspaceTarget | Promise<WorkspaceTarget> | undefined {
    const session = this.sessions.get(sessionId)
    return session ? this.targetForWorkspace(session.workspaceId) : undefined
  }

  targetForWorkspace(workspaceId: string): WorkspaceTarget | Promise<WorkspaceTarget> | undefined {
    const target = this.targets.get(workspaceId)
    if (target) return target
    for (const session of this.sessions.values()) {
      if (session.workspaceId === workspaceId) return session.target
    }
    return undefined
  }

  async handle(request: AuthorizedControlRequest): Promise<SandboxResponse> {
    try {
      const record = await this.store.get(request.capability.sessionId)
      this.assertCapability(record, request.capability)
      this.assertOperationAllowed(record, request)

      switch (request.operation) {
        case "start":
          return await this.start(request.capability)
        case "stop": {
          const response = await this.stop(request.capability)
          if (this.sandcastle && response.state === "stop_pending") {
            setTimeout(() => void this.onSessionIdle(request.capability.sessionId), 500)
          }
          return response
        }
        case "status":
          return this.status(record)
        case "logs":
          return await this.logs(record)
        case "diagnose":
          return await this.diagnose(record)
        case "delete":
          return await this.delete(request.capability, request.force)
        case "retry":
          return await this.retry(request.capability, record)
      }
    } catch (error) {
      const record = await this.store.get(request.capability.sessionId).catch(() => undefined)
      return failureResponse(
        request.operation,
        record?.state ?? "error",
        error instanceof SandboxError ? error.stage : "validate",
        redactError(error),
        record,
      )
    }
  }

  async onSessionIdle(sessionId: string, expected?: { record: SandboxRecord; capability: ControlCapability }): Promise<void> {
    await this.store.withRecordLock(sessionId, async (record, write) => {
      if (!record) {
        if (expected) throw retryStale()
        return
      }
      if (expected) {
        if (!sameRetryRecord(record, expected.record)) throw retryStale()
        this.assertCapability(record, expected.capability)
        this.assertOperationAllowed(record, { operation: "retry", force: false, capability: expected.capability })
      }
      if (this.sandcastle) {
        try {
          await this.onSandcastleIdle(record, write)
        } catch (error) {
          this.rejectTargetGate(record.workspaceId, error)
          await write({
            ...record,
            state: failureState(error, Boolean(this.sandcastle)),
            operation: failedOperation(record, error, Boolean(this.sandcastle)),
            updatedAt: this.now().toISOString(),
            lastError: {
              stage: failureStage(error),
              message: redactError(error),
            },
          })
        }
        return
      }
      let current = record
      if (record.state === "remote") {
        if (!this.workspace.syncOut) return
        try {
          await this.syncOut(record)
        } catch (error) {
          await write({
            ...record,
            state: failureState(error, false),
            operation: failedOperation(record, error, false),
            updatedAt: this.now().toISOString(),
            lastError: {
              stage: failureStage(error),
              message: redactError(error),
            },
          })
        }
        return
      }
      if (!isTransitionPending(record.state)) return

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

        if (record.state === "stop_pending" || (record.state === "recovery_pending" && record.operation?.kind !== "delete")) {
          if (record.operation?.kind === "stop" || record.operation?.phase === "remote") await this.syncOut(record)
          await this.workspace.warp({ sessionId, workspaceId: null, directory: record.directory })
          await this.cleanupWorkspace(record)
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

        if (record.state === "delete_pending" || (record.state === "recovery_pending" && record.operation?.kind === "delete")) {
          const discarding = record.operation?.phase === "discarding"
          const workspaceStillAttached = !discarding && !["removing", "destroying"].includes(record.operation?.phase ?? "")
          if (workspaceStillAttached && record.workspaceId) {
            await this.syncOut(record)
            await this.workspace.warp({ sessionId, workspaceId: null, directory: record.directory })
            current = {
              ...record,
              operation: record.operation ? { ...record.operation, phase: "removing" } : undefined,
              updatedAt: this.now().toISOString(),
            }
            await write(current)
          }
          if (current.operation?.phase === "removing" || current.operation?.phase === "discarding" || workspaceStillAttached) {
            await this.cleanupWorkspace(current)
            current = {
              ...current,
              operation: current.operation ? { ...current.operation, phase: "destroying" } : undefined,
              updatedAt: this.now().toISOString(),
            }
            await write(current)
          }
          if (this.providerDestroy) await this.providerDestroy(current)
          else {
            if (!this.infrastructure.remove) {
              throw new SandboxError("remove", "provider removal is not configured", "REMOVE_UNAVAILABLE")
            }
            await this.infrastructure.remove(current)
          }
          await write({
            ...current,
            state: "deleted",
            operation: current.operation ? { ...current.operation, phase: "deleted" } : undefined,
            updatedAt: this.now().toISOString(),
            lastError: undefined,
          })
        }
      } catch (error) {
        await write({
          ...current,
          state: failureState(error, false),
          operation: failedOperation(current, error, false),
          updatedAt: this.now().toISOString(),
          lastError: {
            stage: failureStage(error),
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
      throw new SandboxError("transition", "session transition is still pending; retry after it completes", "TRANSITION_PENDING")
    }
    if (record.state === "orphaned") {
      throw new SandboxError("reconcile", "session sandbox is orphaned; manual recovery is required", "SESSION_ORPHANED")
    }
    if (record.state === "error" || record.state === "sync_failed") {
      throw new SandboxError("transition", "session is in an error state; run sandboxctl diagnose or retry", "SESSION_ERROR")
    }
  }

  async reconcile(projectId?: string): Promise<void> {
    for (const record of await this.store.list()) {
      if (projectId && record.projectId !== projectId) continue
      if (this.sandcastle && isSandcastleActive(record.state) && !this.sessions.has(record.sessionId)) {
        await this.store.write({
          ...record,
          state: "orphaned",
          operation: record.operation ? { ...record.operation, phase: "orphaned" } : undefined,
          updatedAt: this.now().toISOString(),
          lastError: {
            stage: "reconcile",
            message: "Sandcastle session handle is unavailable; manual recovery is required",
          },
        })
        continue
      }
      if (record.state !== "provisioning" && record.state !== "activation_pending" && record.state !== "remote" && record.state !== "stop_pending" && record.state !== "delete_pending") continue
      assertTransition(record.state, "recovery_pending")
      await this.store.write({
        ...record,
        state: "recovery_pending",
        operation: record.operation ? { ...record.operation } : undefined,
        updatedAt: this.now().toISOString(),
        lastError: undefined,
      })
      await this.onSessionIdle(record.sessionId)
    }
  }

  dispose(): void {
    this.contexts.clear()
    for (const [workspaceId] of this.targetGates) {
      this.rejectTargetGate(workspaceId, new SandboxError("transition", "sandbox plugin was disposed", "PLUGIN_DISPOSED"))
    }
  }

  private async onSandcastleIdle(
    record: SandboxRecord,
    write: (record: SandboxRecord) => Promise<void>,
  ): Promise<void> {
    if (record.state === "remote") return
    if (record.state === "activation_pending") {
      const session = this.sessions.get(record.sessionId)
      if (!session) throw new SandboxError("reconcile", "Sandcastle session handle is unavailable", "SANDCASTLE_HANDLE")
      if (!this.workspace.replaySession || !this.workspace.startSync || !this.workspace.waitForSync) {
        throw new SandboxError("sync", "workspace activation protocol is unavailable", "WORKSPACE_ACTIVATION")
      }
      const localTarget: WorkspaceTarget = { type: "local", directory: record.directory }
      await this.withTarget(record.workspaceId, localTarget, () =>
        this.workspace.warp({ sessionId: record.sessionId, workspaceId: record.workspaceId, directory: record.directory }))
      await this.withTarget(record.workspaceId, session.target, () => this.workspace.startSync!({ directory: record.directory }))
      await this.workspace.waitForSync({ workspaceId: record.workspaceId, directory: record.directory, timeoutMs: 30_000 })
      await this.workspace.replaySession({ sessionId: record.sessionId, directory: record.directory, target: session.target })
      await write({
        ...record,
        state: "remote",
        operation: record.operation ? { ...record.operation, phase: "remote" } : undefined,
        updatedAt: this.now().toISOString(),
        lastError: undefined,
      })
      this.resolveTargetGate(record.workspaceId, session.target)
      return
    }
    if (record.state !== "stop_pending" && record.state !== "delete_pending") return

    const session = this.sessions.get(record.sessionId)
    if (!session) {
      if (record.operation?.kind === "delete") {
        await this.removeWorkspace(record)
        await write({
          ...record,
          state: "deleted",
          operation: { ...record.operation, phase: "deleted" },
          updatedAt: this.now().toISOString(),
          lastError: undefined,
        })
        return
      }
      throw new SandboxError("reconcile", "Sandcastle session handle is unavailable", "SANDCASTLE_HANDLE")
    }

    if (record.operation?.phase === "discarding") {
      await this.workspace.warp({ sessionId: record.sessionId, workspaceId: null, directory: record.directory })
      const closeResult = await session.close()
      await this.removeWorkspace(record)
      this.sessions.delete(record.sessionId)
      await write({
        ...record,
        state: "deleted",
        operation: record.operation ? { ...record.operation, phase: "deleted" } : undefined,
        preservedWorktreePath: closeResult.preservedWorktreePath,
        updatedAt: this.now().toISOString(),
        lastError: undefined,
      })
      return
    }

    try {
      await session.sync()
    } catch (error) {
      if (error instanceof SandboxError) throw error
      throw new SandboxError("sync", redactError(error), "SANDCASTLE_SYNC")
    }
    const localTarget: WorkspaceTarget = { type: "local", directory: record.directory }
    await this.withTarget(record.workspaceId, localTarget, () =>
      this.workspace.warp({ sessionId: record.sessionId, workspaceId: null, directory: record.directory }))
    const closeResult = await session.close()
    await this.removeWorkspace(record)
    this.sessions.delete(record.sessionId)
    await write({
      ...record,
      state: record.operation?.kind === "delete" ? "deleted" : "detached",
      operation: record.operation
        ? { ...record.operation, phase: record.operation.kind === "delete" ? "deleted" : "detached" }
        : undefined,
      preservedWorktreePath: closeResult.preservedWorktreePath,
      updatedAt: this.now().toISOString(),
      lastError: undefined,
    })
    this.resolveTargetGate(record.workspaceId, localTarget)
    this.targets.delete(record.workspaceId)
  }

  private async start(capability: ControlCapability): Promise<SandboxResponse> {
    if (this.sandcastle) return this.startWithSandcastle(capability)

    const context = this.contexts.get(capability.sessionId)
    if (!context) throw new SandboxError("validate", "session context is not available", "SESSION_CONTEXT")

    return this.store.withRecordLock(capability.sessionId, async (existing, write) => {
      this.assertCapability(existing, capability)
      this.assertOperationAllowed(existing, { operation: "start", force: false, capability })
      if (existing?.state === "remote") return successResponse("start", existing, "session is already remote")
      if (existing && (existing.state === "provisioning" || existing.state === "activation_pending")) {
        return successResponse("start", existing, "session activation is already pending")
      }
      if (existing?.state === "deleted") throw new SandboxError("validate", "session workspace has already been deleted", "SESSION_DELETED")
      if (existing && existing.provider !== this.providerType) {
        throw new SandboxError("validate", `session belongs to provider ${existing.provider}`, "PROVIDER_MISMATCH")
      }
      if (existing?.state === "error" && existing.operation?.kind === "start" && existing.operation.phase === "provisioning") {
        await this.cleanupWorkspace(existing, true)
      }

      const resuming = existing?.state === "detached"
      const generation = existing?.state === "error" ? existing.generation : (existing?.generation ?? 0) + 1
      const workspaceId = existing?.state === "error" ? existing.workspaceId : workspaceIdFor(capability.sessionId, generation)
      const resumingExisting = existing && (resuming || existing.state === "error") ? existing : undefined
      const branch = resumingExisting?.branch ?? this.branchForWorkspace?.(workspaceId) ?? defaultWorkspaceBranch(workspaceId)
      const vmName = existing?.vmName
      const vmIdentity = existing?.vmIdentity
      const capture = this.capture ? await this.capture(context) : undefined
      if (!capture) throw new SandboxError("checkout", "working tree capture is not configured", "CAPTURE_UNAVAILABLE")

      const operation = {
        kind: "start" as const,
        phase: "provisioning",
      }
      let current: SandboxRecord = {
        sessionId: capability.sessionId,
        workspaceId,
        projectId: context.projectId,
        provider: this.providerType,
        providerState: existing?.providerState ?? {},
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
      await write(current)

      try {
        const workspace = await this.workspace.create({
          type: this.providerType,
          projectId: context.projectId,
          directory: context.directory,
          id: workspaceId,
          branch,
          extra: {
            owner: "opencode-sandbox",
            sessionId: capability.sessionId,
            generation,
            baseSha: capture.baseSha,
            provider: this.providerType,
            providerState: current.providerState,
            ...(vmName ? { vmName } : {}),
            ...(vmIdentity ? { vmIdentity } : {}),
          },
        })
        if (
          workspace.id !== workspaceId ||
          workspace.projectID !== context.projectId ||
          workspace.type !== this.providerType ||
          workspace.branch !== branch
        ) {
          throw new SandboxError("provision", "workspace response did not match the requested owner", "WORKSPACE_IDENTITY")
        }
        const metadata = workspaceMetadata(workspace.extra)
        current = {
          ...current,
          workspaceId: workspace.id,
          provider: this.providerType,
          providerState: metadata.providerState ?? current.providerState,
          vmName: metadata.vmName ?? current.vmName,
          vmIdentity: metadata.vmIdentity ?? current.vmIdentity,
          updatedAt: this.now().toISOString(),
        }
        await write(current)
        if (capture.patch || capture.untracked.length > 0) {
          if (!this.workspace.applyCapture) {
            throw new SandboxError("sync", "remote capture helper is unavailable; activation stays local", "CAPTURE_APPLY_UNAVAILABLE")
          }
          await this.workspace.applyCapture({ workspaceId: workspace.id, directory: context.directory, capture })
        }
        const next: SandboxRecord = {
          ...current,
          workspaceId: workspace.id,
          provider: this.providerType,
          providerState: metadata.providerState ?? current.providerState,
          vmName: metadata.vmName ?? current.vmName,
          vmIdentity: metadata.vmIdentity ?? current.vmIdentity,
          state: "activation_pending",
          operation: { ...operation, phase: "awaiting_idle" },
          updatedAt: this.now().toISOString(),
          lastError: undefined,
        }
        assertTransition(current.state, next.state)
        await write(next)
        return successResponse("start", next, "Sandbox pronta. A proxima mensagem sera executada remotamente.")
      } catch (error) {
        let cleanupError: unknown
        try {
          await this.cleanupWorkspace(current, true)
        } catch (error) {
          cleanupError = error
        }
        const failed: SandboxRecord = {
          ...current,
          state: "error",
          updatedAt: this.now().toISOString(),
          lastError: {
            stage: error instanceof SandboxError ? error.stage : "provision",
            message: cleanupError ? `${redactError(error)}; cleanup failed: ${redactError(cleanupError)}` : redactError(error),
          },
        }
        await write(failed)
        const lastError = failed.lastError ?? { stage: "provision", message: "start failed" }
        return failureResponse("start", "error", lastError.stage, lastError.message, failed)
      }
    })
  }

  private async startWithSandcastle(capability: ControlCapability): Promise<SandboxResponse> {
    const factory = this.sandcastle
    if (!factory) throw new SandboxError("validate", "Sandcastle session factory is unavailable", "SANDCASTLE_UNAVAILABLE")
    const context = this.contexts.get(capability.sessionId)
    if (!context) throw new SandboxError("validate", "session context is not available", "SESSION_CONTEXT")

    return this.store.withRecordLock(capability.sessionId, async (existing, write) => {
      this.assertCapability(existing, capability)
      this.assertOperationAllowed(existing, { operation: "start", force: false, capability })
      if (existing?.state === "remote") return successResponse("start", existing, "session is already remote")
      if (existing && (existing.state === "provisioning" || existing.state === "activation_pending")) {
        return successResponse("start", existing, "session activation is already pending")
      }
      if (existing?.state === "deleted") throw new SandboxError("validate", "session workspace has already been deleted", "SESSION_DELETED")
      if (existing?.state === "sync_failed") {
        throw new SandboxError("transition", "session sync failed; retry or discard it first", "SESSION_SYNC_FAILED")
      }
      if (existing?.state === "orphaned") {
        throw new SandboxError("reconcile", "session sandbox is orphaned; recover it manually before starting again", "SESSION_ORPHANED")
      }

      const generation = (existing?.generation ?? 0) + 1
      const workspaceId = workspaceIdFor(capability.sessionId, generation)
      const branch = defaultWorkspaceBranch(workspaceId)
      const capture = this.capture ? await this.capture(context) : undefined
      if (!capture) throw new SandboxError("checkout", "working tree capture is not configured", "CAPTURE_UNAVAILABLE")

      const operation = {
        kind: "start" as const,
        phase: "provisioning",
      }
      let current: SandboxRecord = {
        sessionId: capability.sessionId,
        workspaceId,
        projectId: context.projectId,
        provider: this.providerType,
        providerState: {},
        generation,
        directory: context.directory,
        branch,
        baseSha: capture.baseSha,
        state: "provisioning",
        operation,
        createdAt: existing?.createdAt ?? this.now().toISOString(),
        updatedAt: this.now().toISOString(),
      }
      await write(current)

      let session: SandcastleSession | undefined
        try {
          session = await createSandcastleSession({
            factory,
            context,
            workspaceId,
            generation,
            branch,
            baseSha: capture.baseSha,
          })
        this.sessions.set(capability.sessionId, session)
        this.targets.set(workspaceId, { type: "local", directory: context.directory })
        current = {
          ...current,
          providerState: session.recoveryMetadata,
          updatedAt: this.now().toISOString(),
        }
        await write(current)
        await session.applyCapture(capture)

        const workspace = await this.workspace.create({
          type: this.providerType,
          projectId: context.projectId,
          directory: context.directory,
          id: workspaceId,
          branch,
          extra: {
            owner: "opencode-sandbox",
            sessionId: capability.sessionId,
            generation,
            baseSha: capture.baseSha,
            provider: this.providerType,
            ...session.recoveryMetadata,
          },
        })
        if (
          workspace.id !== workspaceId ||
          workspace.projectID !== context.projectId ||
          workspace.type !== this.providerType ||
          workspace.branch !== branch
        ) {
          throw new SandboxError("provision", "workspace response did not match the requested owner", "WORKSPACE_IDENTITY")
        }
        this.beginTargetGate(workspaceId)

        const next: SandboxRecord = {
          ...current,
          state: "activation_pending",
          operation: { ...operation, phase: "awaiting_idle" },
          updatedAt: this.now().toISOString(),
          lastError: undefined,
        }
        assertTransition(current.state, next.state)
        await write(next)
        return successResponse("start", next, "Sandbox pronta. A proxima mensagem sera executada remotamente.")
      } catch (error) {
        let cleanupError: unknown
        let preservedWorktreePath: string | undefined
        if (session) {
          try {
            preservedWorktreePath = (await session.close()).preservedWorktreePath
          } catch (error) {
            cleanupError = error
          }
          this.sessions.delete(capability.sessionId)
          this.rejectTargetGate(workspaceId, error)
          this.targets.delete(workspaceId)
        }
        try {
          await this.removeWorkspace(current)
        } catch (error) {
          cleanupError ??= error
        }
        const failed: SandboxRecord = {
          ...current,
          state: "error",
          ...(preservedWorktreePath ? { preservedWorktreePath } : {}),
          updatedAt: this.now().toISOString(),
          lastError: {
            stage: error instanceof SandboxError ? error.stage : "provision",
            message: cleanupError ? `${redactError(error)}; cleanup failed: ${redactError(cleanupError)}` : redactError(error),
          },
        }
        await write(failed)
        const lastError = failed.lastError ?? { stage: "provision", message: "start failed" }
        return failureResponse("start", "error", lastError.stage, lastError.message, failed)
      }
    })
  }

  private async stop(capability: ControlCapability): Promise<SandboxResponse> {
    return this.store.withRecordLock(capability.sessionId, async (record, write) => {
      this.assertCapability(record, capability)
      this.assertOperationAllowed(record, { operation: "stop", force: false, capability })
      if (!record) return successResponse("stop", undefined, "session is already local")
      if (record.state === "detached" || record.state === "local") return successResponse("stop", record, "session is already local")
      if (record.state === "stop_pending") return successResponse("stop", record, "session detach is already pending")
      if (record.state !== "remote") throw new SandboxError("transition", "cannot stop while another transition is pending", "STOP_TRANSITION")

      const next: SandboxRecord = {
        ...record,
        state: "stop_pending",
        operation: {
          kind: "stop",
          phase: "awaiting_idle",
        },
        updatedAt: this.now().toISOString(),
      }
      this.beginTargetGate(record.workspaceId)
      assertTransition(record.state, next.state)
      await write(next)
      return successResponse("stop", next, "Detach agendado; a resposta atual sera concluida primeiro.")
    })
  }

  private beginTargetGate(workspaceId: string): void {
    if (this.targetGates.has(workspaceId)) return
    const gate = deferred<WorkspaceTarget>()
    void gate.promise.catch(() => undefined)
    this.targetGates.set(workspaceId, gate)
    this.targets.set(workspaceId, gate.promise)
  }

  private resolveTargetGate(workspaceId: string, target: WorkspaceTarget): void {
    this.targetGates.get(workspaceId)?.resolve(target)
    this.targetGates.delete(workspaceId)
    this.targets.set(workspaceId, target)
  }

  private rejectTargetGate(workspaceId: string, error: unknown): void {
    this.targetGates.get(workspaceId)?.reject(error)
    this.targetGates.delete(workspaceId)
    this.targets.delete(workspaceId)
  }

  private async withTarget<T>(workspaceId: string, target: WorkspaceTarget, operation: () => Promise<T>): Promise<T> {
    const previous = this.targets.get(workspaceId)
    this.targets.set(workspaceId, target)
    try {
      return await operation()
    } finally {
      if (previous) this.targets.set(workspaceId, previous)
      else this.targets.delete(workspaceId)
    }
  }

  private status(record: SandboxRecord | undefined): SandboxResponse {
    if (!record) return successResponse("status", undefined, "session is local")
    return successResponse("status", record, `session state: ${record.state}`)
  }

  private async logs(record: SandboxRecord | undefined): Promise<SandboxResponse> {
    if (!record) return successResponse("logs", undefined, "no sandbox session is associated")
    const output = boundedText((this.infrastructure.logs ? await this.infrastructure.logs(record) : []).join("\n"))
    return successResponse("logs", record, output.value, {
      logs: output.value ? output.value.split("\n") : [],
      ...(output.truncated ? { truncated: true } : {}),
    })
  }

  private async diagnose(record: SandboxRecord | undefined): Promise<SandboxResponse> {
    if (!record) return successResponse("diagnose", undefined, "no sandbox session is associated")
    const details = this.infrastructure.diagnose
      ? boundedDetails(nonSecretDetails(await this.infrastructure.diagnose(record)))
      : { configured: false }
    return successResponse("diagnose", record, "diagnostics completed", details)
  }

  private async delete(capability: ControlCapability, force: boolean): Promise<SandboxResponse> {
    const decision = await this.store.withRecordLock(capability.sessionId, async (record, write) => {
      this.assertCapability(record, capability)
      this.assertOperationAllowed(record, { operation: "delete", force, capability })
      if (!record || record.state === "deleted") return { record, forceDiscard: false }
      const forceDiscard = force && record.state === "sync_failed"
      if (force && (capability.role !== "host" || (record.state !== "detached" && !forceDiscard))) {
        throw new SandboxError("remove", "force delete is available only on the host after stop", "FORCE_DELETE_SCOPE")
      }
      if (!forceDiscard && record.state !== "remote" && record.state !== "detached") {
        throw new SandboxError("transition", "delete is blocked while a transition is pending", "DELETE_TRANSITION")
      }
      if (!force && this.infrastructure.preflightDelete) await this.infrastructure.preflightDelete(record)
      if (!this.sandcastle && !this.providerDestroy && !this.infrastructure.remove) {
        throw new SandboxError("remove", "provider removal is not configured", "REMOVE_UNAVAILABLE")
      }

      let phase = "awaiting_idle"
      if (forceDiscard) phase = "discarding"
      else if (record.state === "detached") phase = "removing"
      const next: SandboxRecord = {
        ...record,
        state: "delete_pending",
        operation: {
          kind: "delete",
          phase,
          force,
        },
        updatedAt: this.now().toISOString(),
      }
      assertTransition(record.state, next.state)
      await write(next)
      return { record: next, forceDiscard }
    })

    const next = decision.record
    if (!next || next.state === "deleted") return successResponse("delete", next, "Sandbox is already deleted")
    if (!force) return successResponse("delete", next, "Delete agendado; a resposta atual sera concluida primeiro.")

    await this.onSessionIdle(capability.sessionId, { record: next, capability })
    const final = await this.store.get(capability.sessionId)
    if (final?.state !== "deleted") {
      const lastError = final?.lastError ?? { stage: "remove", message: "sandbox removal is still pending" }
      return failureResponse("delete", final?.state ?? "error", lastError.stage, lastError.message, final)
    }
    return successResponse("delete", final, decision.forceDiscard ? "Failed sandbox discarded." : "Sandbox removed.")
  }

  private async retry(capability: ControlCapability, record: SandboxRecord | undefined): Promise<SandboxResponse> {
    this.assertOperationAllowed(record, { operation: "retry", force: false, capability })
    if (record?.state === "orphaned") {
      throw new SandboxError("reconcile", "session sandbox is orphaned; manual recovery is required", "SESSION_ORPHANED")
    }
    if (record?.state === "recovery_pending") {
      await this.onSessionIdle(record.sessionId, { record, capability })
      return successResponse("retry", (await this.store.get(record.sessionId)) ?? record, "Retry completed.")
    }
    if (!record || (record.state !== "error" && record.state !== "sync_failed")) {
      return successResponse("retry", record, "there is no failed operation to retry")
    }
    const operation = record.operation?.kind
    if (operation === "start") {
      if (record.operation?.phase === "awaiting_idle") return this.retryPending(capability, record, "activation_pending", "start", "awaiting_idle")
      if (record.operation?.phase === "remote") return this.retryRemoteSync(capability, record)
      return this.start(capability)
    }
    if (operation === "stop") return this.retryPending(capability, record, "stop_pending", "stop", "awaiting_idle")
    if (operation === "delete") {
      let phase = "awaiting_idle"
      if (record.operation?.phase === "destroying") phase = "destroying"
      else if (record.operation?.phase === "removing") phase = "removing"
      else if (record.operation?.phase === "discarding") phase = "discarding"
      return this.retryPending(capability, record, "delete_pending", "delete", phase)
    }
    throw new SandboxError("validate", "no retryable operation is recorded", "RETRY_UNAVAILABLE")
  }

  private async retryPending(
    capability: ControlCapability,
    record: SandboxRecord,
    state: "activation_pending" | "stop_pending" | "delete_pending",
    kind: "start" | "stop" | "delete",
    phase: string,
  ): Promise<SandboxResponse> {
    const next = await this.store.withRecordLock(record.sessionId, async (current, write) => {
      if (!current || !sameRetryRecord(current, record)) throw retryStale()
      this.assertCapability(current, capability)
      this.assertOperationAllowed(current, { operation: "retry", force: false, capability })
      const next: SandboxRecord = {
        ...current,
        state,
        operation: {
          ...current.operation,
          kind,
          phase,
        },
        updatedAt: this.now().toISOString(),
        lastError: undefined,
      }
      assertTransition(current.state, next.state)
      await write(next)
      return next
    })
    await this.onSessionIdle(record.sessionId, { record: next, capability })
    const final = (await this.store.get(record.sessionId)) ?? next
    if (final.state === "error" || final.state === "sync_failed" || final.state === "orphaned") {
      const lastError = final.lastError ?? { stage: "reconcile", message: "retry failed" }
      return failureResponse("retry", final.state, lastError.stage, lastError.message, final)
    }
    return successResponse("retry", final, "Retry completed.")
  }

  private async retryRemoteSync(capability: ControlCapability, record: SandboxRecord): Promise<SandboxResponse> {
    const next = await this.store.withRecordLock(record.sessionId, async (current, write) => {
      if (!current || !sameRetryRecord(current, record)) throw retryStale()
      this.assertCapability(current, capability)
      this.assertOperationAllowed(current, { operation: "retry", force: false, capability })
      try {
        await this.syncOut(current)
        const next = {
          ...current,
          state: "remote" as const,
          updatedAt: this.now().toISOString(),
          operation: current.operation ? { ...current.operation, phase: "remote" } : undefined,
          lastError: undefined,
        }
        assertTransition(current.state, next.state)
        await write(next)
        return next
      } catch (error) {
        const state = failureState(error, false)
        await write({
          ...current,
          state,
          operation: failedOperation(current, error, false),
          updatedAt: this.now().toISOString(),
          lastError: {
            stage: failureStage(error),
            message: redactError(error),
          },
        })
        throw error
      }
    })
    return successResponse("retry", next, "Retry completed.")
  }

  private assertCapability(record: SandboxRecord | undefined, capability: ControlCapability): void {
    if (record && capability.generation !== record.generation) {
      throw new SandboxError("validate", "control capability belongs to an old generation", "CAPABILITY_GENERATION")
    }
    if (record && capability.role === "remote" && record.state === "detached") {
      throw new SandboxError("validate", "remote capability is detached", "CAPABILITY_REVOKED")
    }
  }

  private assertOperationAllowed(record: SandboxRecord | undefined, request: AuthorizedControlRequest): void {
    if (request.capability.role !== "remote") return
    if (request.operation === "start" || (request.operation === "retry" && record?.operation?.kind === "start")) {
      throw new SandboxError("validate", "start is only authorized from the host", "REQUEST_START")
    }
    if (request.operation === "delete" && request.force) {
      throw new SandboxError("validate", "force delete is only authorized from the host", "REQUEST_FORCE")
    }
    if (request.operation === "retry" && isForceDelete(record)) {
      throw new SandboxError("validate", "force delete can only be retried from the host", "REQUEST_FORCE")
    }
  }

  private async waitForSync(record: SandboxRecord): Promise<void> {
    if (!this.workspace.waitForSync) return
    await this.workspace.waitForSync({
      workspaceId: record.workspaceId,
      directory: record.directory,
      timeoutMs: 30_000,
    })
  }

  private async removeWorkspace(record: SandboxRecord): Promise<void> {
    try {
      await this.workspace.remove({ workspaceId: record.workspaceId, directory: record.directory })
    } catch (error) {
      if (!(error instanceof SandboxError && error.code === "WORKSPACE_HTTP_404")) throw error
    }
  }

  private async cleanupWorkspace(record: SandboxRecord, destroy = false): Promise<void> {
    let failure: unknown
    try {
      if (this.providerRelease) await this.providerRelease(record)
    } catch (error) {
      failure = error
    }
    try {
      await this.workspace.remove({ workspaceId: record.workspaceId, directory: record.directory })
    } catch (error) {
      if (!(error instanceof SandboxError && error.code === "WORKSPACE_HTTP_404")) failure ??= error
    }
    if (destroy && this.providerDestroy) {
      try {
        await this.providerDestroy(record)
      } catch (error) {
        failure ??= error
      }
    }
    if (failure) throw failure
  }

  private async syncOut(record: SandboxRecord): Promise<void> {
    try {
      if (!this.workspace.syncOut) {
        await this.waitForSync(record)
        return
      }

      const result = await this.workspace.syncOut({
        workspaceId: record.workspaceId,
        directory: record.directory,
        baseSha: record.baseSha,
      })
      if (result.baseSha !== record.baseSha) {
        throw new SandboxError("sync", "workspace sync returned a different base revision", "WORKSPACE_BASE_SHA")
      }
    } catch (error) {
      if (error instanceof SandboxError) throw error
      throw new SandboxError("sync", redactError(error), "WORKSPACE_SYNC")
    }
  }
}

function isSandcastleActive(state: SandboxState): boolean {
  return (
    state === "provisioning" ||
    state === "activation_pending" ||
    state === "remote" ||
    state === "stop_pending" ||
    state === "sync_failed" ||
    state === "delete_pending" ||
    state === "recovery_pending"
  )
}

function failureState(error: unknown, sandcastle: boolean): SandboxState {
  if (sandcastle && error instanceof SandboxError && error.code === "SANDCASTLE_HANDLE") return "orphaned"
  if (error instanceof SandboxError && error.stage === "sync") return "sync_failed"
  return "error"
}

function failureStage(error: unknown): string {
  if (error instanceof SandboxError) return error.stage
  return "reconcile"
}

function failedOperation(record: SandboxRecord, error: unknown, sandcastle: boolean): SandboxRecord["operation"] {
  if (!record.operation) return undefined
  return failureState(error, sandcastle) === "orphaned" ? { ...record.operation, phase: "orphaned" } : record.operation
}

function nonSecretDetails(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (/(?:password|token|secret|credential|auth|api[_-]?key|private[_-]?key)/i.test(key)) continue
    result[key] = nonSecretValue(item)
  }
  return result
}

function nonSecretValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(nonSecretValue)
  if (isRecord(value)) return nonSecretDetails(value)
  return typeof value === "string" ? redactText(value) : value
}

function boundedDetails(details: Record<string, unknown>): Record<string, unknown> {
  const output = boundedText(JSON.stringify(details))
  return output.truncated ? { truncated: true, preview: output.value } : details
}

function boundedText(value: string): { value: string; truncated: boolean } {
  const redacted = redactText(value)
  const bytes = Buffer.from(redacted)
  if (bytes.byteLength <= MAX_DIAGNOSTIC_BYTES) return { value: redacted, truncated: false }
  const suffix = "\n[truncated]"
  return {
    value: `${bytes.subarray(0, MAX_DIAGNOSTIC_BYTES - Buffer.byteLength(suffix)).toString("utf8")}${suffix}`,
    truncated: true,
  }
}

function workspaceIdFor(sessionId: string, generation: number): string {
  const compact = Buffer.from(`${sessionId}:${generation}`).toString("base64url").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)
  return `wrk_${compact}`
}

function sameRetryRecord(current: SandboxRecord, expected: SandboxRecord): boolean {
  return (
    current.sessionId === expected.sessionId &&
    current.generation === expected.generation &&
    current.workspaceId === expected.workspaceId &&
    current.state === expected.state &&
    current.updatedAt === expected.updatedAt &&
    current.operation?.kind === expected.operation?.kind &&
    current.operation?.phase === expected.operation?.phase &&
    current.operation?.force === expected.operation?.force
  )
}

function retryStale(): SandboxError {
  return new SandboxError("validate", "session changed while retry was pending; retry again", "RETRY_STALE")
}

function isForceDelete(record: SandboxRecord | undefined): boolean {
  const operation = record?.operation
  if (operation?.kind !== "delete") return false
  if (operation.force === true || operation.phase === "discarding") return true
  return operation.force === undefined && (operation.phase === "removing" || operation.phase === "destroying")
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function defaultWorkspaceBranch(workspaceId: string): string {
  return `opencode/sandbox-${shortHash(workspaceId)}`
}

function workspaceMetadata(value: unknown): { providerState?: Record<string, unknown>; vmName?: string; vmIdentity?: VmIdentity } {
  if (!isRecord(value)) return {}
  const providerState = isRecord(value.providerState) ? value.providerState : undefined
  const vmName = typeof value.vmName === "string" ? value.vmName : undefined
  if (!isRecord(value.vmIdentity) || typeof value.vmIdentity.name !== "string" || typeof value.vmIdentity.sshDest !== "string") {
    return { providerState, vmName }
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
  return { providerState, vmName, vmIdentity: identity }
}

function successResponse(operation: "start" | "stop" | "status" | "delete" | "logs" | "diagnose" | "retry", record: SandboxRecord | undefined, message: string, details?: Record<string, unknown>): SandboxResponse {
  const responseDetails = { ...recordDetails(record), ...(details ?? {}) }
  return {
    ok: true,
    operation,
    state: record?.state ?? (operation === "delete" ? "deleted" : "local"),
    sessionId: record?.sessionId,
    workspaceId: record?.workspaceId,
    vm: record?.vmName,
    message,
    ...(Object.keys(responseDetails).length > 0 ? { details: responseDetails } : {}),
  }
}

function failureResponse(operation: "start" | "stop" | "status" | "delete" | "logs" | "diagnose" | "retry", state: SandboxRecord["state"] | "error", stage: string, message: string, record?: SandboxRecord): SandboxResponse {
  const responseDetails = recordDetails(record)
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
    ...(Object.keys(responseDetails).length > 0 ? { details: responseDetails } : {}),
  }
}

function recordDetails(record: SandboxRecord | undefined): Record<string, unknown> {
  if (!record) return {}
  const recoveryMetadata = boundedDetails(nonSecretDetails(record.providerState))
  return {
    branch: record.branch,
    provider: record.provider,
    ...(Object.keys(recoveryMetadata).length > 0 ? { recoveryMetadata } : {}),
    ...(record.preservedWorktreePath ? { preservedWorktreePath: record.preservedWorktreePath } : {}),
  }
}
