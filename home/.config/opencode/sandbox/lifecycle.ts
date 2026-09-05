import { createCapability } from "./control-channel"
import { shortHash } from "./naming"
import { redactError, redactText } from "./redaction"
import { assertTransition, isTransitionPending } from "./state"
import { FileStateStore } from "./state-store"
import {
  isRecord,
  SandboxError,
  type AuthorizedControlRequest,
  type CapabilityRole,
  type ControlCapability,
  type GitWorkingTreeObservation,
  type ProviderResourceObservation,
  type PublicOperation,
  type SandboxRecord,
  type SandboxObservation,
  type SandboxAllowedAction,
  type SandboxResultV2,
  type SandboxResponse,
  type SandboxState,
  type SessionContext,
  type VmIdentity,
  type WorkingTreeCapture,
  type WorkspaceGateway,
  type WorkspaceInfo,
  type WorkspaceTarget,
} from "./types"
import {
  createSandcastleSession,
  type SandcastleSession,
  type SandcastleSessionFactory,
} from "./sandcastle-session"

const MAX_DIAGNOSTIC_BYTES = 48 * 1024
const INSPECTION_TIMEOUT_MS = 5_000
const INVENTORY_TIMEOUT_MS = 10_000
const MAX_INVENTORY_RECORDS = 1_000
const MAX_INVENTORY_RESOURCES = 1_000
const MAX_INVENTORY_DETAIL_BYTES = 48 * 1024
const MAX_RESPONSE_BYTES = 64 * 1024 - 1024

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
  providerInspect?: (record: SandboxRecord) => Promise<ProviderResourceObservation>
  providerTarget?: (record: SandboxRecord) => WorkspaceTarget | undefined | Promise<WorkspaceTarget | undefined>
  providerInventory?: () => Promise<ProviderResourceObservation[]>
  gitInspect?: (record: SandboxRecord, worktreePath: string) => Promise<GitWorkingTreeObservation>
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
  private readonly providerInspect?: (record: SandboxRecord) => Promise<ProviderResourceObservation>
  private readonly providerTarget?: (record: SandboxRecord) => WorkspaceTarget | undefined | Promise<WorkspaceTarget | undefined>
  private readonly providerInventory?: () => Promise<ProviderResourceObservation[]>
  private readonly gitInspect?: (record: SandboxRecord, worktreePath: string) => Promise<GitWorkingTreeObservation>
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
  private readonly operations = new Set<Promise<unknown>>()
  private readonly idleTimers = new Set<ReturnType<typeof setTimeout>>()
  private disposed = false
  private disposal?: Promise<void>

  constructor(dependencies: LifecycleDependencies) {
    this.store = dependencies.store
    this.workspace = dependencies.workspace
    this.capture = dependencies.capture
    this.infrastructure = dependencies.infrastructure ?? {}
    this.providerInspect = dependencies.providerInspect
    this.providerTarget = dependencies.providerTarget
    this.providerInventory = dependencies.providerInventory
    this.gitInspect = dependencies.gitInspect
    this.providerType = dependencies.providerType ?? "exedev"
    this.branchForWorkspace = dependencies.branchForWorkspace
    this.providerRelease = dependencies.providerRelease
    this.providerDestroy = dependencies.providerDestroy
    this.sandcastle = dependencies.sandcastle
    this.now = dependencies.now ?? (() => new Date())
  }

  registerContext(context: SessionContext): void {
    if (this.disposed) return
    this.contexts.set(context.sessionId, context)
  }

  async capabilityFor(sessionId: string, role: "host" | "remote" = "host", scope: "session" = "session"): Promise<ControlCapability> {
    if (this.disposed) throw pluginDisposed()
    const record = await this.store.get(sessionId)
    if (this.disposed) throw pluginDisposed()
    return createCapability({
      sessionId,
      generation: record?.generation ?? 1,
      role,
      scope,
      ...(record?.projectId ? { projectId: record.projectId } : {}),
    })
  }

  async projectCapabilityFor(projectId: string): Promise<ControlCapability> {
    if (this.disposed) throw pluginDisposed()
    return createCapability({
      sessionId: `project_${shortHash(projectId)}`,
      generation: 1,
      role: "host",
      scope: "project",
      projectId,
    })
  }

  targetFor(sessionId: string): WorkspaceTarget | Promise<WorkspaceTarget> | undefined {
    if (this.disposed) return undefined
    const session = this.sessions.get(sessionId)
    return session ? this.targetForWorkspace(session.workspaceId) : undefined
  }

  targetForWorkspace(workspaceId: string): WorkspaceTarget | Promise<WorkspaceTarget> | undefined {
    if (this.disposed) return undefined
    const target = this.targets.get(workspaceId)
    if (target) return target
    for (const session of this.sessions.values()) {
      if (session.workspaceId === workspaceId) return session.target
    }
    return undefined
  }

  handle(request: AuthorizedControlRequest): Promise<SandboxResponse> {
    return this.track(this.handleRequest(request))
  }

  private async handleRequest(request: AuthorizedControlRequest): Promise<SandboxResponse> {
    try {
      if (this.disposed) throw pluginDisposed()
      const record = request.operation === "inventory" && (request.capability.scope ?? "session") === "project"
        ? undefined
        : await this.store.get(request.capability.sessionId)
      this.assertCapability(record, request.capability)
      this.assertOperationAllowed(record, request)

      switch (request.operation) {
        case "start":
          return await this.start(request.capability)
        case "stop": {
          const response = await this.stop(request.capability)
          if (this.sandcastle && response.state === "stop_pending") {
            this.scheduleSessionIdle(request.capability.sessionId)
          }
          return response
        }
        case "status":
          return this.status(record, request.capability)
        case "inspect":
          return await this.inspect(record, request.capability)
        case "inventory":
          return await this.inventory(request.capability)
        case "logs":
          return await this.logs(record, request.capability)
        case "diagnose":
          return await this.diagnose(record, request.capability)
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
        error,
        request.capability.role,
        { captureAvailable: this.capture !== undefined },
      )
    }
  }

  onSessionIdle(sessionId: string, expected?: { record: SandboxRecord; capability: ControlCapability }): Promise<void> {
    if (this.disposed) return Promise.reject(pluginDisposed())
    return this.track(this.processSessionIdle(sessionId, expected))
  }

  scheduleSessionIdle(sessionId: string, complete?: () => void | Promise<void>): void {
    if (this.disposed) return
    const timer = setTimeout(() => {
      this.idleTimers.delete(timer)
      void this.track(this.onSessionIdle(sessionId).then(complete)).catch(() => undefined)
    }, 500)
    this.idleTimers.add(timer)
  }

  private async processSessionIdle(sessionId: string, expected?: { record: SandboxRecord; capability: ControlCapability }): Promise<void> {
    await this.store.withRecordLock(sessionId, (record, write) => this.processSessionIdleLocked(sessionId, record, write, expected))
  }

  private async processSessionIdleLocked(
    sessionId: string,
    record: SandboxRecord | undefined,
    write: (record: SandboxRecord) => Promise<void>,
    expected?: { record: SandboxRecord; capability: ControlCapability },
  ): Promise<void> {
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
        const preservedWorktreePath = preservedPathFrom(error) ?? record.preservedWorktreePath
        await write({
          ...record,
          ...(preservedWorktreePath ? { preservedWorktreePath } : {}),
          state: failureState(error, Boolean(this.sandcastle)),
          operation: failedOperation(record, error, Boolean(this.sandcastle)),
          updatedAt: this.now().toISOString(),
          lastError: failureDetails(error),
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
          lastError: failureDetails(error),
        })
      }
      return
    }
    if (!isTransitionPending(record.state)) return

    try {
      if (record.state === "recovery_pending" && !record.operation) {
        throw new SandboxError("reconcile", "restart recovery cannot prove work preservation", "RECOVERY_PRESERVATION_UNVERIFIED")
      }
      if (record.state === "activation_pending" || (record.state === "recovery_pending" && record.operation?.kind === "start")) {
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

      if (record.state === "stop_pending" || (record.state === "recovery_pending" && record.operation?.kind === "stop")) {
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
        lastError: failureDetails(error),
      })
    }
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

  reconcile(projectId?: string): Promise<void> {
    return this.track(this.reconcileRecords(projectId))
  }

  private async reconcileRecords(projectId?: string): Promise<void> {
    for (const candidate of await this.store.list()) {
      if (projectId && candidate.projectId !== projectId) continue
      await this.store.withRecordLock(candidate.sessionId, async (record, write) => {
        if (!record || (projectId && record.projectId !== projectId)) return
        if (record.state === "recovery_pending" && !record.operation) {
          const error = new SandboxError("reconcile", "restart recovery cannot prove work preservation", "RECOVERY_PRESERVATION_UNVERIFIED")
          await write({
            ...record,
            state: "error",
            updatedAt: this.now().toISOString(),
            lastError: failureDetails(error),
          })
          return
        }
        if (this.sandcastle && isSandcastleActive(record.state) && !this.sessions.has(record.sessionId)) {
          await write({
            ...record,
            state: "orphaned",
            operation: record.operation ? { ...record.operation, phase: "orphaned" } : undefined,
            updatedAt: this.now().toISOString(),
            lastError: {
              code: "SANDCASTLE_HANDLE",
              stage: "reconcile",
              message: "Sandcastle session handle is unavailable; manual recovery is required",
            },
          })
          return
        }
        if (record.state === "recovery_pending") {
          await this.processSessionIdleLocked(record.sessionId, record, write)
          return
        }
        if (this.sandcastle && isSandcastleActive(record.state)) return
        if (record.state !== "provisioning" && record.state !== "activation_pending" && record.state !== "remote" && record.state !== "stop_pending" && record.state !== "delete_pending") return
        assertTransition(record.state, "recovery_pending")
        const next: SandboxRecord = {
          ...record,
          state: "recovery_pending",
          operation: record.operation ? { ...record.operation } : undefined,
          updatedAt: this.now().toISOString(),
          lastError: undefined,
        }
        await write(next)
        await this.processSessionIdleLocked(record.sessionId, next, write)
      })
    }
  }

  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.disposed = true
      for (const timer of this.idleTimers) clearTimeout(timer)
      this.idleTimers.clear()
      for (const [workspaceId] of this.targetGates) this.rejectTargetGate(workspaceId, pluginDisposed())
      await Promise.allSettled([...this.operations])
      for (const [workspaceId] of this.targetGates) this.rejectTargetGate(workspaceId, pluginDisposed())

      const sessions = [...this.sessions.entries()]
      const results = await Promise.allSettled(sessions.map(async ([sessionId, session]) => {
        let operationError: unknown
        try {
          const record = await this.store.get(sessionId)
          if (record && ["remote", "stop_pending", "delete_pending", "sync_failed"].includes(record.state)) await session.sync()
        } catch (error) {
          operationError = error
        }
        try {
          const closeResult = await session.close()
          await this.persistPreservedWorktreePath(sessionId, closeResult.preservedWorktreePath)
          this.sessions.delete(sessionId)
          if (operationError) throw operationError
          return closeResult
        } catch (error) {
          await this.persistPreservedWorktreePath(sessionId, preservedPathFrom(error))
          throw error
        }
      }))
      results.forEach((result, index) => {
        if (result.status === "fulfilled") this.sessions.delete(sessions[index]![0])
      })
      this.contexts.clear()
      this.targets.clear()
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
      if (failure) throw failure.reason
    })().catch((error) => {
      this.disposal = undefined
      throw error
    })
    return this.disposal
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.finally(() => this.operations.delete(operation)).catch(() => undefined)
    return operation
  }

  private async onSandcastleIdle(
    record: SandboxRecord,
    write: (record: SandboxRecord) => Promise<void>,
  ): Promise<void> {
    if (record.state === "remote") return
    if (record.state === "activation_pending" || (record.state === "recovery_pending" && record.operation?.kind === "start")) {
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
      assertTransition(record.state, "remote")
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
    if (
      record.state !== "stop_pending" &&
      record.state !== "delete_pending" &&
      !(record.state === "recovery_pending" && (record.operation?.kind === "stop" || record.operation?.kind === "delete"))
    ) return

    const session = this.sessions.get(record.sessionId)
    if (!session) {
      if (record.operation?.kind === "delete" && record.operation.phase === "removing" && record.operation.providerDestroyed) {
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

    const deleting = record.operation?.kind === "delete"
    const discarding = record.operation?.phase === "discarding"
    const localTarget: WorkspaceTarget = { type: "local", directory: record.directory }
    let current = record
    if (discarding) {
      await this.workspace.warp({ sessionId: record.sessionId, workspaceId: null, directory: record.directory })
    } else if (!deleting || !["removing", "destroying"].includes(record.operation?.phase ?? "")) {
      try {
        await session.sync()
      } catch (error) {
        if (error instanceof SandboxError) throw error
        throw new SandboxError("sync", redactError(error), "SANDCASTLE_SYNC")
      }
      await this.withTarget(record.workspaceId, localTarget, () =>
        this.workspace.warp({ sessionId: record.sessionId, workspaceId: null, directory: record.directory }))
    }
    const closeResult = await session.close()
    current = {
      ...record,
      ...(closeResult.preservedWorktreePath ? { preservedWorktreePath: closeResult.preservedWorktreePath } : {}),
      updatedAt: this.now().toISOString(),
    }
    if (deleting) {
      current = {
        ...current,
        operation: record.operation
          ? { ...record.operation, phase: "removing", ...(this.sandcastle ? { providerDestroyed: true } : {}) }
          : undefined,
        updatedAt: this.now().toISOString(),
      }
    }
    if (!deleting && current.operation) {
      current = {
        ...current,
        operation: { ...current.operation, providerDestroyed: true },
      }
    }
    await write(current)
    try {
      await this.removeWorkspace(current)
    } catch (error) {
      if (current.preservedWorktreePath && error instanceof Error) {
        Object.assign(error, { preservedWorktreePath: current.preservedWorktreePath })
      }
      throw error
    }
    this.sessions.delete(record.sessionId)
    await write({
      ...current,
      state: deleting ? "deleted" : "detached",
      operation: current.operation
        ? { ...current.operation, phase: deleting ? "deleted" : "detached" }
        : undefined,
      ...(current.preservedWorktreePath ? { preservedWorktreePath: current.preservedWorktreePath } : {}),
      updatedAt: this.now().toISOString(),
      lastError: undefined,
    })
    this.resolveTargetGate(record.workspaceId, localTarget)
    this.targets.delete(record.workspaceId)
  }

  private async start(capability: ControlCapability, expected?: SandboxRecord): Promise<SandboxResponse> {
    if (this.sandcastle) return this.startWithSandcastle(capability, expected)

    const context = this.contexts.get(capability.sessionId)
    if (!context) throw new SandboxError("validate", "session context is not available", "SESSION_CONTEXT")

    return this.store.withRecordLock(capability.sessionId, async (existing, write) => {
      if (expected && (!existing || !sameRetryRecord(existing, expected))) throw retryStale()
      this.assertCapability(existing, capability)
      this.assertOperationAllowed(existing, { operation: "start", force: false, capability })
      if (existing?.state === "remote") return successResponse("start", existing, "session is already remote")
      if (existing && (existing.state === "provisioning" || existing.state === "activation_pending")) {
        return successResponse("start", existing, "session activation is already pending")
      }
      if (existing && isTransitionPending(existing.state)) throw new SandboxError("transition", "cannot start while another transition is pending", "START_TRANSITION")
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
        ...(existing?.preservedWorktreePath ? { preservedWorktreePath: existing.preservedWorktreePath } : {}),
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
            ...failureDetails(error),
            ...(cleanupError ? { message: `${redactError(error)}; cleanup failed: ${redactError(cleanupError)}` } : {}),
          },
        }
        await write(failed)
        const lastError = failed.lastError ?? { stage: "provision", message: "start failed" }
        return failureResponse("start", "error", lastError.stage, lastError.message, failed)
      }
    })
  }

  private async startWithSandcastle(capability: ControlCapability, expected?: SandboxRecord): Promise<SandboxResponse> {
    const factory = this.sandcastle
    if (!factory) throw new SandboxError("validate", "Sandcastle session factory is unavailable", "SANDCASTLE_UNAVAILABLE")
    const context = this.contexts.get(capability.sessionId)
    if (!context) throw new SandboxError("validate", "session context is not available", "SESSION_CONTEXT")

    return this.store.withRecordLock(capability.sessionId, async (existing, write) => {
      if (expected && (!existing || !sameRetryRecord(existing, expected))) throw retryStale()
      this.assertCapability(existing, capability)
      this.assertOperationAllowed(existing, { operation: "start", force: false, capability })
      if (existing?.state === "remote") return successResponse("start", existing, "session is already remote")
      if (existing && (existing.state === "provisioning" || existing.state === "activation_pending")) {
        return successResponse("start", existing, "session activation is already pending")
      }
      if (existing && isTransitionPending(existing.state)) throw new SandboxError("transition", "cannot start while another transition is pending", "START_TRANSITION")
      if (existing?.state === "deleted") throw new SandboxError("validate", "session workspace has already been deleted", "SESSION_DELETED")
      if (existing?.state === "sync_failed") {
        throw new SandboxError("transition", "session sync failed; retry or discard it first", "SESSION_SYNC_FAILED")
      }
      if (existing?.state === "orphaned") {
        throw new SandboxError("reconcile", "session sandbox is orphaned; recover it manually before starting again", "SESSION_ORPHANED")
      }
      let preservedWorktreePath = existing?.preservedWorktreePath
      if (existing?.state === "error" && existing.operation?.kind === "start") {
        const retained = this.sessions.get(capability.sessionId)
        if (retained) {
          try {
            preservedWorktreePath = (await retained.close()).preservedWorktreePath ?? preservedWorktreePath
          } catch (error) {
            const path = preservedPathFrom(error)
            if (path) await write({ ...existing, preservedWorktreePath: path, updatedAt: this.now().toISOString() })
            throw error
          }
          this.sessions.delete(capability.sessionId)
        }
        if (preservedWorktreePath && preservedWorktreePath !== existing.preservedWorktreePath) {
          await write({ ...existing, preservedWorktreePath, updatedAt: this.now().toISOString() })
        }
        await this.removeWorkspace(existing)
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
        ...(preservedWorktreePath ? { preservedWorktreePath } : {}),
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
          let sessionClosed = false
          try {
            preservedWorktreePath = (await session.close()).preservedWorktreePath
            sessionClosed = true
          } catch (error) {
            cleanupError = error
            preservedWorktreePath ??= preservedPathFrom(error)
          }
          if (sessionClosed) this.sessions.delete(capability.sessionId)
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
            ...failureDetails(error),
            ...(cleanupError ? { message: `${redactError(error)}; cleanup failed: ${redactError(cleanupError)}` } : {}),
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
      if (!record) return successResponse("stop", undefined, "session is already local", undefined, capability.role)
      if (record.state === "detached" || record.state === "local") return successResponse("stop", record, "session is already local", undefined, capability.role)
      if (record.state === "stop_pending") return successResponse("stop", record, "session detach is already pending", undefined, capability.role)
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
      return successResponse("stop", next, "Detach agendado; a resposta atual sera concluida primeiro.", undefined, capability.role)
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

  private status(record: SandboxRecord | undefined, capability: ControlCapability): SandboxResponse {
    const options = { captureAvailable: this.capture !== undefined }
    if (!record) return successResponse("status", undefined, "session is local", undefined, capability.role, options)
    return successResponse("status", record, `session state: ${record.state}`, undefined, capability.role, options)
  }

  private async inspect(record: SandboxRecord | undefined, capability: ControlCapability): Promise<SandboxResponse> {
    if (!record) {
      return successResponse("inspect", undefined, "no sandbox session is associated", undefined, capability.role, {
        observations: emptyObservations(this.now()),
        classification: "unknown",
        recommendedAction: null,
        captureAvailable: this.capture !== undefined,
      })
    }

    const freshAt = this.now().toISOString()
    const handle = this.sessions.get(record.sessionId)
    const [workspace, provider, git, target] = await Promise.all([
      this.inspectWorkspace(record, freshAt),
      this.inspectProvider(record, handle, freshAt),
      this.inspectGit(record, handle, freshAt),
      this.inspectRuntimeTarget(record, handle),
    ])
    const handleObservation = runtimeHandleObservation(handle, target, freshAt)
    const observations = [recordObservation(record), handleObservation, workspace.observation, provider.observation, git.observation]
    const classification = classifySituation(record, observations)
    const work = workFromInspection(record, git.value, classification)
    const effectiveTarget = effectiveTargetFor(record, target.value, workspace.value, provider.value, provider.observation, handleObservation)
    const probeError = workspace.error ?? provider.error ?? git.error ?? target.error
    const contextAvailable = this.contexts.has(record.sessionId)
    const preservationVerified = Boolean(record.preservedWorktreePath && /^[a-f0-9]{40}$/i.test(git.value?.head ?? ""))
    return successResponse("inspect", record, probeError ? "inspection completed with unknown evidence" : "inspection completed", undefined, capability.role, {
      ok: !probeError,
      observations,
      classification,
      effectiveTarget,
      work,
      ...(probeError ? { error: publicError(probeError) } : {}),
      allowedActions: allowedActions(record, capability.role, classification, provider.observation, this.capture !== undefined, contextAvailable, true, preservationVerified),
      recommendedAction: recommendedAction(record, capability.role, classification, provider.observation, this.capture !== undefined, contextAvailable, true, preservationVerified),
    })
  }

  private async inventory(capability: ControlCapability): Promise<SandboxResponse> {
    const projectId = capability.projectId
    if (!projectId) throw new SandboxError("validate", "project capability is missing a project ID", "CAPABILITY_PROJECT")

    const recordsPromise = this.store.list()
    const resourcesPromise = this.providerInventory
      ? withTimeout(this.providerInventory(), INVENTORY_TIMEOUT_MS, "provider inventory timed out")
      : Promise.resolve(undefined)
    const [records, resourcesResult] = await Promise.all([
      recordsPromise,
      resourcesPromise.then((resources) => ({ resources, error: undefined as unknown })).catch((error: unknown) => ({ resources: undefined, error })),
    ])
    const allProjectRecords = records.filter((record) => record.projectId === projectId)
    const projectRecords = allProjectRecords.slice(0, MAX_INVENTORY_RECORDS)
    const recordsTruncated = projectRecords.length < allProjectRecords.length
    const allResources = resourcesResult.resources ?? []
    const projectResources = allResources.filter((resource) => resource.projectId === projectId)
    const unscopedResources = allResources.length - projectResources.length
    const inventoryScoped = allResources.length > 0 && unscopedResources === 0
    const resources = projectResources.slice(0, MAX_INVENTORY_RESOURCES).map(safeProviderResource)
    const resourcesTruncated = resources.length < projectResources.length
    const freshAt = this.now().toISOString()
    const providerObservationValue: SandboxObservation = resourcesResult.error
      ? {
          source: "provider",
          observed: true,
          freshAt,
          resource: "unknown",
          ownership: "unknown",
          health: "unknown",
          evidence: [`provider inventory failed:${errorCode(resourcesResult.error)}`],
        }
      : resourcesResult.resources
        ? inventoryScoped
          ? {
            source: "provider",
            observed: true,
            freshAt,
            resource: resources.length > 0 ? "present" : "absent",
            ownership: resources.some((resource) => resource.ownership === "conflict") ? "conflict" : "unknown",
            health: aggregateInventoryHealth(resources),
            evidence: [`provider inventory:${resources.length}`],
          }
          : {
              source: "provider",
              observed: true,
              freshAt,
              resource: "unknown",
              ownership: "unknown",
              health: "unknown",
              evidence: [`provider inventory scope is unknown; omitted:${unscopedResources}`],
            }
        : {
            source: "provider",
            observed: false,
            freshAt,
            resource: "unknown",
            ownership: "unknown",
            health: "unknown",
            evidence: ["provider inventory is unavailable"],
          }
    const observations: SandboxObservation[] = [
      {
        source: "record",
        observed: true,
        freshAt,
        resource: projectRecords.length > 0 ? "present" : "absent",
        ownership: "unknown",
        health: "unknown",
        evidence: [`lifecycle records:${projectRecords.length}`],
      },
      providerObservationValue,
      ...["handle", "workspace", "git"].map((source) => ({
        source: source as SandboxObservation["source"],
        observed: false,
        freshAt,
        evidence: [],
      })),
    ]
    const error = resourcesResult.error
    const boundedRecords = boundedItems(projectRecords.map(inventoryRecord), MAX_INVENTORY_DETAIL_BYTES / 2)
    const boundedResources = boundedItems(resources, MAX_INVENTORY_DETAIL_BYTES / 2)
    return {
      ...baseResult("inventory", true, "project inventory completed", {
        role: "host",
        observations,
        classification: error || !resourcesResult.resources || !inventoryScoped ? "unknown" : projectRecords.length === 0 && resources.length === 0 ? "clean" : "unknown",
        allowedActions: [{
          operation: "inventory",
          role: "host",
          arguments: [],
          preconditions: ["host project capability"],
          waitFor: "none",
        }],
        recommendedAction: null,
        ...(error ? { ok: false, error: publicError(error) } : {}),
      }),
      state: "local",
      details: {
        records: boundedRecords.values,
        providerResources: boundedResources.values,
        ...(recordsTruncated || resourcesTruncated || boundedRecords.truncated || boundedResources.truncated ? { truncated: true } : {}),
      },
    }
  }

  private async inspectWorkspace(record: SandboxRecord, freshAt: string): Promise<Probe<WorkspaceInfo>> {
    if (!this.workspace.inspect) {
      return {
        observation: { source: "workspace", observed: false, freshAt, resource: "unknown", ownership: "unknown", health: "unknown", evidence: ["workspace inspection is unavailable"] },
      }
    }
    try {
      const info = await withTimeout(this.workspace.inspect({ workspaceId: record.workspaceId, directory: record.directory }), INSPECTION_TIMEOUT_MS, "workspace inspection timed out")
      if (!info) {
        return { observation: { source: "workspace", observed: true, freshAt, resource: "absent", ownership: "unknown", health: "unknown", evidence: [`workspace registry:${record.workspaceId}`] } }
      }
      const matches = workspaceMatches(record, info)
      return {
        value: info,
        observation: {
          source: "workspace",
          observed: true,
          freshAt,
          resource: "present",
          ownership: matches ? "verified" : "conflict",
          health: "unknown",
          evidence: [`workspace registry:${record.workspaceId}`],
        },
      }
    } catch (error) {
      return { observation: unknownObservation("workspace", freshAt, `workspace inspection failed:${errorCode(error)}`), error }
    }
  }

  private async inspectProvider(record: SandboxRecord, session: SandcastleSession | undefined, freshAt: string): Promise<Probe<ProviderResourceObservation>> {
    if (!session?.inspect && !this.providerInspect) {
      return { observation: unknownObservation("provider", freshAt, "provider inspection is unavailable") }
    }
    try {
      const result = await withTimeout(session?.inspect ? session.inspect() : this.providerInspect!(record), INSPECTION_TIMEOUT_MS, "provider inspection timed out")
      return { observation: providerObservation(result, freshAt), value: result }
    } catch (error) {
      return {
        observation: unknownObservation("provider", freshAt, `provider inspection failed:${errorCode(error)}`),
        error,
      }
    }
  }

  private async inspectGit(record: SandboxRecord, session: SandcastleSession | undefined, freshAt: string): Promise<Probe<GitWorkingTreeObservation>> {
    if (!this.gitInspect) {
      return { observation: { source: "git", observed: false, freshAt, evidence: ["Git inspection is unavailable"] } }
    }
    const worktreePath = session?.worktree.worktreePath ?? record.preservedWorktreePath
    if (!worktreePath) {
      return { observation: { source: "git", observed: false, freshAt, evidence: ["runtime worktree is unavailable"] } }
    }
    try {
      const value = await withTimeout(this.gitInspect(record, worktreePath), INSPECTION_TIMEOUT_MS, "Git inspection timed out")
      return {
        value,
        observation: { source: "git", observed: true, freshAt, evidence: safeEvidence(value.evidence) },
      }
    } catch (error) {
      return { observation: { source: "git", observed: true, freshAt, evidence: [`Git inspection failed:${errorCode(error)}`] }, error }
    }
  }

  private async inspectRuntimeTarget(record: SandboxRecord, session: SandcastleSession | undefined): Promise<TargetProbe> {
    try {
      if (session) return { observed: true, value: session.target }
      if (!this.providerTarget) return { observed: false }
      return { observed: true, value: await withTimeout(Promise.resolve(this.providerTarget(record)), INSPECTION_TIMEOUT_MS, "runtime target inspection timed out") }
    } catch (error) {
      return { observed: true, error }
    }
  }

  private async logs(record: SandboxRecord | undefined, capability: ControlCapability): Promise<SandboxResponse> {
    if (!record) return successResponse("logs", undefined, "no sandbox session is associated", undefined, capability.role)
    const output = boundedText((this.infrastructure.logs ? await this.infrastructure.logs(record) : []).join("\n"))
    return successResponse("logs", record, "logs retrieved", {
      logs: output.value ? output.value.split("\n") : [],
      ...(output.truncated ? { truncated: true } : {}),
    }, capability.role)
  }

  private async diagnose(record: SandboxRecord | undefined, capability: ControlCapability): Promise<SandboxResponse> {
    if (!record) return successResponse("diagnose", undefined, "no sandbox session is associated", undefined, capability.role)
    const details = this.infrastructure.diagnose
      ? boundedDetails(nonSecretDetails(await this.infrastructure.diagnose(record)))
      : { configured: false }
    return successResponse("diagnose", record, "diagnostics completed", details, capability.role)
  }

  private async delete(capability: ControlCapability, force: boolean): Promise<SandboxResponse> {
    const decision = await this.store.withRecordLock(capability.sessionId, async (record, write) => {
      this.assertCapability(record, capability)
      this.assertOperationAllowed(record, { operation: "delete", force, capability })
      if (!record || record.state === "deleted") return { record, forceDiscard: false, alreadyDeleted: true }
      const forceDiscard = force && record.state === "sync_failed"
      if (force && (capability.role !== "host" || (record.state !== "detached" && !forceDiscard))) {
        throw new SandboxError("remove", "force delete is available only on the host after stop", "FORCE_DELETE_SCOPE")
      }
      if (!forceDiscard && record.state !== "remote" && record.state !== "detached") {
        throw new SandboxError("transition", "delete is blocked while a transition is pending", "DELETE_TRANSITION")
      }
      if (!force && record.preservedWorktreePath) await this.verifyPreservedWorktree(record)
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
          ...(record.operation?.providerDestroyed ? { providerDestroyed: true } : {}),
        },
        updatedAt: this.now().toISOString(),
      }
      assertTransition(record.state, next.state)
      await write(next)
      if (!force) return { record: next, forceDiscard, alreadyDeleted: false }

      let final = next
      await this.processSessionIdleLocked(capability.sessionId, next, async (updated) => {
        final = updated
        await write(updated)
      }, { record: next, capability })
      return { record: final, forceDiscard, alreadyDeleted: false }
    })

    const final = decision.record
    if (decision.alreadyDeleted) return successResponse("delete", final, "Sandbox is already deleted", undefined, capability.role)
    if (!force) return successResponse("delete", final, "Delete agendado; a resposta atual sera concluida primeiro.", undefined, capability.role)
    if (final?.state !== "deleted") {
      const lastError = final?.lastError ?? { stage: "remove", message: "sandbox removal is still pending" }
      return failureResponse("delete", final?.state ?? "error", lastError.stage, lastError.message, final, undefined, capability.role)
    }
    return successResponse("delete", final, decision.forceDiscard ? "Failed sandbox discarded." : "Sandbox removed.", undefined, capability.role)
  }

  private async retry(capability: ControlCapability, record: SandboxRecord | undefined): Promise<SandboxResponse> {
    this.assertOperationAllowed(record, { operation: "retry", force: false, capability })
    if (record?.state === "orphaned") {
      throw new SandboxError("reconcile", "session sandbox is orphaned; manual recovery is required", "SESSION_ORPHANED")
    }
    if (record?.state === "recovery_pending") {
      return this.store.withRecordLock(record.sessionId, async (current, write) => {
        if (!current || !sameRetryRecord(current, record)) throw retryStale()
        let final = current
        await this.processSessionIdleLocked(record.sessionId, current, async (updated) => {
          final = updated
          await write(updated)
        }, { record, capability })
        if (final.state === "error" || final.state === "sync_failed" || final.state === "orphaned" || final.state === "recovery_pending") {
          const lastError = final.lastError ?? { stage: "reconcile", message: "retry did not complete" }
          return failureResponse("retry", final.state, lastError.stage, lastError.message, final, undefined, capability.role)
        }
        return successResponse("retry", final, "Retry completed.", undefined, capability.role)
      })
    }
    if (!record || (record.state !== "error" && record.state !== "sync_failed")) {
      return successResponse("retry", record, "there is no failed operation to retry", undefined, capability.role)
    }
    const operation = record.operation?.kind
    if (operation === "start") {
      if (record.operation?.phase === "awaiting_idle") return this.retryPending(capability, record, "activation_pending", "start", "awaiting_idle")
      if (record.operation?.phase === "remote") return this.retryRemoteSync(capability, record)
      return this.start(capability, record)
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
    return this.store.withRecordLock(record.sessionId, async (current, write) => {
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
      let final = next
      await this.processSessionIdleLocked(record.sessionId, next, async (updated) => {
        final = updated
        await write(updated)
      }, { record: next, capability })
      if (final.state === "error" || final.state === "sync_failed" || final.state === "orphaned") {
        const lastError = final.lastError ?? { stage: "reconcile", message: "retry failed" }
        return failureResponse("retry", final.state, lastError.stage, lastError.message, final, undefined, capability.role)
      }
      return successResponse("retry", final, "Retry completed.", undefined, capability.role)
    })
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
          lastError: failureDetails(error),
        })
        throw error
      }
    })
    return successResponse("retry", next, "Retry completed.", undefined, capability.role)
  }

  private assertCapability(record: SandboxRecord | undefined, capability: ControlCapability): void {
    const scope = capability.scope ?? "session"
    if (scope === "project") {
      if (capability.role !== "host" || !capability.projectId) {
        throw new SandboxError("validate", "project capability is invalid", "CAPABILITY_SCOPE")
      }
      return
    }
    if (record && capability.generation !== record.generation) {
      throw new SandboxError("validate", "control capability belongs to an old generation", "CAPABILITY_GENERATION")
    }
    if (record && capability.role === "remote" && record.state === "detached") {
      throw new SandboxError("validate", "remote capability is detached", "CAPABILITY_REVOKED")
    }
  }

  private assertOperationAllowed(record: SandboxRecord | undefined, request: AuthorizedControlRequest): void {
    const scope = request.capability.scope ?? "session"
    if (scope === "project") {
      if (request.operation !== "inventory" || request.capability.role !== "host") {
        throw new SandboxError("validate", "project capabilities are limited to host inventory", "REQUEST_SCOPE")
      }
      return
    }
    if (request.operation === "inventory") {
      throw new SandboxError("validate", "inventory requires a host project capability", "REQUEST_INVENTORY")
    }
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

  private async persistPreservedWorktreePath(sessionId: string, path: string | undefined): Promise<void> {
    if (!path) return
    await this.store.withRecordLock(sessionId, async (record, write) => {
      if (!record || record.preservedWorktreePath === path) return
      await write({ ...record, preservedWorktreePath: path, updatedAt: this.now().toISOString() })
    })
  }

  private async verifyPreservedWorktree(record: SandboxRecord): Promise<void> {
    if (!record.preservedWorktreePath || !this.gitInspect) {
      throw new SandboxError("inspect", "preserved Git worktree cannot be verified", "PRESERVATION_UNVERIFIED")
    }
    try {
      const observation = await withTimeout(this.gitInspect(record, record.preservedWorktreePath), INSPECTION_TIMEOUT_MS, "Git preservation inspection timed out")
      if (!/^[a-f0-9]{40}$/i.test(observation.head ?? "")) throw new Error("Git worktree HEAD is unavailable")
    } catch {
      throw new SandboxError("inspect", "preserved Git worktree cannot be verified", "PRESERVATION_UNVERIFIED")
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
        throw new SandboxError("sync", "workspace preservation is unavailable", record.state === "recovery_pending" ? "RECOVERY_PRESERVATION_UNVERIFIED" : "PRESERVATION_UNAVAILABLE")
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

function failureDetails(error: unknown, message = redactError(error)): NonNullable<SandboxRecord["lastError"]> {
  return {
    code: error instanceof SandboxError ? error.code : "SANDBOX_ERROR",
    stage: failureStage(error),
    message,
  }
}

function preservedPathFrom(error: unknown): string | undefined {
  return isRecord(error) && typeof error.preservedWorktreePath === "string" ? error.preservedWorktreePath : undefined
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
  return typeof value === "string" ? safePublicText(value) : value
}

function boundedDetails(details: Record<string, unknown>): Record<string, unknown> {
  const output = boundedText(JSON.stringify(details))
  return output.truncated ? { truncated: true, preview: output.value } : details
}

function boundedText(value: string): { value: string; truncated: boolean } {
  const redacted = safePublicText(value)
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
    current.operation?.force === expected.operation?.force &&
    current.operation?.providerDestroyed === expected.operation?.providerDestroyed
  )
}

function retryStale(): SandboxError {
  return new SandboxError("validate", "session changed while retry was pending; retry again", "RETRY_STALE")
}

function pluginDisposed(): SandboxError {
  return new SandboxError("transition", "sandbox plugin was disposed", "PLUGIN_DISPOSED")
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

interface ResultOptions {
  role?: CapabilityRole
  record?: SandboxRecord
  ok?: boolean
  observations?: SandboxObservation[]
  effectiveTarget?: SandboxResultV2["effectiveTarget"]
  classification?: SandboxResultV2["classification"]
  work?: SandboxResultV2["work"]
  allowedActions?: SandboxAllowedAction[]
  recommendedAction?: SandboxResultV2["recommendedAction"]
  error?: SandboxResultV2["error"]
  captureAvailable?: boolean
  contextAvailable?: boolean
  mutationsAllowed?: boolean
}

interface Probe<T> {
  observation: SandboxObservation
  value?: T
  error?: unknown
}

function successResponse(
  operation: PublicOperation,
  record: SandboxRecord | undefined,
  message: string,
  details?: Record<string, unknown>,
  role: CapabilityRole = "host",
  options: Omit<ResultOptions, "record" | "role"> = {},
): SandboxResponse {
  const responseDetails = { ...recordDetails(record), ...(details ?? {}) }
  return boundResponse({
    ...baseResult(operation, true, message, { ...options, record, role }),
    state: record?.state ?? (operation === "delete" ? "deleted" : "local"),
    sessionId: record?.sessionId,
    workspaceId: record?.workspaceId,
    vm: record?.vmName,
    ...(Object.keys(responseDetails).length > 0 ? { details: responseDetails } : {}),
  })
}

function failureResponse(
  operation: PublicOperation,
  state: SandboxRecord["state"] | "error",
  stage: string,
  message: string,
  record?: SandboxRecord,
  error?: unknown,
  role: CapabilityRole = "host",
  options: Omit<ResultOptions, "record" | "role"> = {},
): SandboxResponse {
  const responseDetails = recordDetails(record)
  const responseError = error ? publicError(error) : recordedError(record) ?? publicError(new SandboxError(stage, message))
  return boundResponse({
    ...baseResult(operation, false, message, {
      record,
      role,
      error: responseError,
      ...options,
    }),
    state,
    stage,
    sessionId: record?.sessionId,
    workspaceId: record?.workspaceId,
    vm: record?.vmName,
    diagnosticOperation: "diagnose",
    ...(Object.keys(responseDetails).length > 0 ? { details: responseDetails } : {}),
  })
}

function boundResponse(response: SandboxResponse): SandboxResponse {
  if (Buffer.byteLength(JSON.stringify(response)) < MAX_RESPONSE_BYTES) return response
  const { details: _details, ...withoutDetails } = response
  const base = { ...withoutDetails, message: "response exceeded the control-channel size limit" }
  const previewSource = response.details === undefined ? response.message : JSON.stringify(response.details)
  const preview = boundedText(previewSource).value
  const bounded = { ...base, details: { truncated: true, preview } }
  if (Buffer.byteLength(JSON.stringify(bounded)) < MAX_RESPONSE_BYTES) return bounded
  return {
    ...baseResult(response.operation, false, "response exceeded the control-channel size limit", {
      observations: emptyObservations(new Date()),
      classification: "unknown",
      work: emptyWork(),
      allowedActions: [],
      recommendedAction: null,
      error: { code: "RESPONSE_LIMIT", stage: "control_channel", retryable: false },
    }),
    state: "error",
    stage: "control_channel",
  }
}

function baseResult(operation: PublicOperation, ok: boolean, message: string, options: ResultOptions = {}): SandboxResultV2 {
  const record = options.record
  const role = options.role ?? "host"
  const now = new Date()
  const observations = options.observations ?? recordOnlyObservations(record, now)
  const classification = options.classification ?? recordOnlyClassification(record)
  const provider = observations.find((observation) => observation.source === "provider")
  const captureAvailable = options.captureAvailable ?? false
  const contextAvailable = options.contextAvailable ?? false
  const mutationsAllowed = options.mutationsAllowed ?? false
  return {
    schemaVersion: 2,
    requestId: cryptoRandomUuid(),
    ok: options.ok ?? ok,
    operation,
    message: safePublicText(message),
    session: sessionFor(record),
    intent: intentFor(record),
    effectiveTarget: options.effectiveTarget ?? null,
    observations,
    classification,
    work: options.work ?? workFromRecord(record, classification),
    allowedActions: options.allowedActions ?? allowedActions(record, role, classification, provider, captureAvailable, contextAvailable, mutationsAllowed),
    recommendedAction: options.recommendedAction === undefined
      ? recommendedAction(record, role, classification, provider, captureAvailable, contextAvailable, mutationsAllowed)
      : options.recommendedAction,
    error: options.error === undefined ? recordedError(record) : options.error,
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

function sessionFor(record: SandboxRecord | undefined): SandboxResultV2["session"] {
  if (!record || !isPublicProvider(record.provider)) return null
  return {
    projectId: record.projectId,
    sessionId: record.sessionId,
    workspaceId: record.workspaceId,
    generation: record.generation,
    provider: record.provider,
  }
}

function intentFor(record: SandboxRecord | undefined): SandboxResultV2["intent"] {
  if (!record) return { desiredLocation: "local", phase: "idle" }
  let desiredLocation: SandboxResultV2["intent"]["desiredLocation"]
  if (record.operation?.kind === "delete" || record.state === "delete_pending" || record.state === "deleted") desiredLocation = "deleted"
  else if (record.operation?.kind === "stop" || record.state === "stop_pending" || record.state === "detached" || record.state === "local") desiredLocation = "local"
  else desiredLocation = "remote"

  let phase: SandboxResultV2["intent"]["phase"] = "idle"
  if (record.state === "provisioning") phase = "provisioning"
  else if (record.state === "activation_pending") phase = "activating"
  else if (record.state === "stop_pending") phase = "detaching"
  else if (record.state === "delete_pending") phase = "deleting"
  else if (record.state === "sync_failed") phase = "syncing"
  else if (record.state === "recovery_pending") {
    phase = record.operation?.kind === "start" ? "activating" : record.operation?.kind === "stop" ? "detaching" : record.operation?.kind === "delete" ? "deleting" : "idle"
  }
  return { desiredLocation, phase }
}

function recordOnlyObservations(record: SandboxRecord | undefined, now: Date): SandboxObservation[] {
  const freshAt = now.toISOString()
  return [
    recordObservation(record),
    ...["handle", "workspace", "provider", "git"].map((source) => ({
      source: source as SandboxObservation["source"],
      observed: false,
      freshAt,
      evidence: [],
    })),
  ]
}

function emptyObservations(now: Date): SandboxObservation[] {
  const freshAt = now.toISOString()
  return [
    {
      source: "record",
      observed: true,
      freshAt,
      resource: "absent",
      ownership: "unknown",
      health: "unknown",
      evidence: ["no lifecycle record"],
    },
    ...["handle", "workspace", "provider", "git"].map((source) => ({
      source: source as SandboxObservation["source"],
      observed: false,
      freshAt,
      evidence: [],
    })),
  ]
}

function recordObservation(record: SandboxRecord | undefined): SandboxObservation {
  if (!record) {
    return {
      source: "record",
      observed: true,
      freshAt: new Date().toISOString(),
      resource: "absent",
      ownership: "unknown",
      health: "unknown",
      evidence: ["no lifecycle record"],
    }
  }
  return {
    source: "record",
    observed: true,
    freshAt: record.updatedAt,
    resource: "present",
    ownership: "unknown",
    health: "unknown",
    evidence: [`state record:${record.sessionId}`],
  }
}

function recordOnlyClassification(record: SandboxRecord | undefined): SandboxResultV2["classification"] {
  return "unknown"
}

function workFromRecord(record: SandboxRecord | undefined, classification: SandboxResultV2["classification"]): SandboxResultV2["work"] {
  if (!record) return emptyWork()
  const failed = record.state === "sync_failed"
  return {
    captureBaseSha: record.baseSha,
    runtimeHead: null,
    sync: failed ? "failed" : "unknown",
    preservation: record.operation?.force || isForceDelete(record)
      ? "discard_authorized"
      : classification === "clean" && !record.preservedWorktreePath ? "not_needed" : "at_risk",
    preservedWorktreePath: record.preservedWorktreePath ?? null,
  }
}

function emptyWork(): SandboxResultV2["work"] {
  return {
    captureBaseSha: null,
    runtimeHead: null,
    sync: "unknown",
    preservation: "not_needed",
    preservedWorktreePath: null,
  }
}

function allowedActions(
  record: SandboxRecord | undefined,
  role: CapabilityRole,
  classification: SandboxResultV2["classification"],
  provider: SandboxObservation | undefined,
  captureAvailable: boolean,
  contextAvailable = false,
  mutationsAllowed = true,
  preservationVerified = false,
): SandboxAllowedAction[] {
  const actions: SandboxAllowedAction[] = [
    action("status", role, [], [], "none"),
    action("inspect", role, [], [], "none"),
  ]
  if (record) {
    actions.push(action("logs", role, [], ["session record exists"], "none"))
    actions.push(action("diagnose", role, [], ["session record exists"], "none"))
  }
  if (!record) {
    if (mutationsAllowed && captureAvailable && contextAvailable && role === "host") actions.push(action("start", "host", [], ["host capability", "session context is available", "working tree is available"], "none"))
    return actions
  }

  if (mutationsAllowed && classification === "attached" && record.state === "remote") {
    actions.push(action("stop", role, [], ["runtime is attached", "preserve runtime changes before detaching"], "session_idle"))
    actions.push(action("delete", role, [], ["preserve runtime changes before deletion"], "session_idle"))
  }
  if (
    mutationsAllowed &&
    classification === "leaked_resource" &&
    record.state === "detached" &&
    provider?.observed === true &&
    provider.resource === "present" &&
    provider?.ownership === "verified" &&
    (preservationVerified || record.operation?.force)
  ) {
    actions.push(action("delete", "host", [], ["provider ownership is verified", "Git preservation is verified or explicitly discarded"], "operation_completion"))
  }
  if (
    mutationsAllowed &&
    (record.state === "error" || record.state === "sync_failed" || record.state === "recovery_pending") &&
    record.operation &&
    ["start", "stop", "delete"].includes(record.operation.kind)
  ) {
    const requiredRole = record.operation?.kind === "start" || isForceDelete(record) ? "host" : role
    if (classification !== "conflict") actions.push(action("retry", requiredRole, [], ["recorded operation is retryable"], "operation_completion"))
  }
  if (
    mutationsAllowed &&
    classification === "clean" &&
    (record.state === "local" || record.state === "detached") &&
    provider?.observed === true &&
    provider.resource === "absent" &&
    role === "host" &&
    captureAvailable &&
    contextAvailable
  ) {
    actions.push(action("start", "host", [], ["no observed runtime requires preservation", "session context is available", "working tree is available"], "none"))
  }
  return actions
}

function recommendedAction(
  record: SandboxRecord | undefined,
  role: CapabilityRole,
  classification: SandboxResultV2["classification"],
  provider: SandboxObservation | undefined,
  captureAvailable: boolean,
  contextAvailable = false,
  mutationsAllowed = true,
  preservationVerified = false,
): SandboxResultV2["recommendedAction"] {
  const actions = allowedActions(record, role, classification, provider, captureAvailable, contextAvailable, mutationsAllowed, preservationVerified)
  const can = (operation: PublicOperation, requiredRole?: CapabilityRole) => actions.some((item) => item.operation === operation && (!requiredRole || item.role === requiredRole))
  if (classification === "attached" && can("stop")) return { operation: "stop", reasonCode: "ATTACHED_RUNTIME" }
  if (classification === "leaked_resource" && can("delete", "host")) return { operation: "delete", reasonCode: "VERIFIED_LEAK" }
  if (classification === "leaked_resource") return { operation: "inspect", reasonCode: "PRESERVATION_UNVERIFIED" }
  if (classification === "work_at_risk" && can("retry")) return { operation: "retry", reasonCode: "WORK_AT_RISK" }
  if (classification === "clean" && can("start", "host")) return { operation: "start", reasonCode: "NO_RUNTIME" }
  if (classification === "control_lost") return { operation: "inspect", reasonCode: "RESOURCE_STATE_UNKNOWN" }
  if (classification === "stale_record") return { operation: "inspect", reasonCode: "STALE_RECORD_NEEDS_EVIDENCE" }
  if (classification === "orphan") return { operation: "inspect", reasonCode: "VERIFIED_ORPHAN_READ_ONLY" }
  if (classification === "conflict") return { operation: "inspect", reasonCode: "OWNERSHIP_CONFLICT" }
  if (classification === "unknown" && can("inspect")) return { operation: "inspect", reasonCode: "INSUFFICIENT_EVIDENCE" }
  return null
}

function action(
  operation: PublicOperation,
  role: CapabilityRole,
  args: string[],
  preconditions: string[],
  waitFor: SandboxAllowedAction["waitFor"],
): SandboxAllowedAction {
  return { operation, role, arguments: args, preconditions, waitFor }
}

function publicError(error: unknown): NonNullable<SandboxResultV2["error"]> {
  const sandboxError = error instanceof SandboxError ? error : undefined
  const stage = sandboxError?.stage ?? "inspect"
  const code = sandboxError?.code ?? "SANDBOX_ERROR"
  return { code, stage, retryable: retryableError(code, stage) }
}

function recordedError(record: SandboxRecord | undefined): SandboxResultV2["error"] {
  if (!record?.lastError) return null
  const code = record.lastError.code ?? "RECORDED_ERROR"
  return { code, stage: record.lastError.stage, retryable: retryableError(code, record.lastError.stage) }
}

function retryableError(code: string, stage: string): boolean {
  return stage !== "validate" && !["STATE_SECRET", "STATE_OWNER", "STATE_MODE", "STATE_FILE", "STATE_SCHEMA"].includes(code)
}

function isPublicProvider(value: string): value is "exedev" | "sbx" | "cloudflare" {
  return value === "exedev" || value === "sbx" || value === "cloudflare"
}

function providerObservation(value: ProviderResourceObservation, freshAt: string): SandboxObservation {
  const resource = safeProviderResource(value)
  return {
    source: "provider",
    observed: true,
    freshAt,
    resource: resource.resource,
    ownership: resource.ownership,
    health: resource.health,
    evidence: resource.evidence,
  }
}

function safeProviderResource(value: ProviderResourceObservation): ProviderResourceObservation {
  return {
    resourceId: safeResourceId(value.resourceId),
    ...(value.projectId ? { projectId: safeResourceId(value.projectId) } : {}),
    resource: value.resource,
    ownership: value.ownership,
    health: value.health,
    evidence: safeEvidence(value.evidence),
  }
}

function aggregateInventoryHealth(resources: readonly ProviderResourceObservation[]): ProviderResourceObservation["health"] {
  if (resources.length === 0 || resources.some((resource) => resource.resource !== "present" || resource.health === "unknown")) return "unknown"
  if (resources.some((resource) => resource.health === "degraded")) return "degraded"
  return resources.every((resource) => resource.health === "healthy") ? "healthy" : "unknown"
}

function unknownObservation(source: SandboxObservation["source"], freshAt: string, evidence: string): SandboxObservation {
  return {
    source,
    observed: true,
    freshAt,
    resource: "unknown",
    ownership: "unknown",
    health: "unknown",
    evidence: safeEvidence([evidence]),
  }
}

function workspaceMatches(record: SandboxRecord, info: WorkspaceInfo): boolean {
  if (info.id !== record.workspaceId || info.projectID !== record.projectId || info.type !== record.provider || info.branch !== record.branch) return false
  const extra = isRecord(info.extra) ? info.extra : {}
  const state = isRecord(extra.providerState) ? extra.providerState : extra
  for (const [key, expected] of [
    ["sessionId", record.sessionId],
    ["generation", record.generation],
    ["workspaceId", record.workspaceId],
    ["projectId", record.projectId],
    ["provider", record.provider],
  ] as const) {
    const actual = extra[key] ?? state[key]
    if (actual !== undefined && actual !== expected) return false
  }
  return true
}

function classifySituation(record: SandboxRecord, observations: SandboxObservation[]): SandboxResultV2["classification"] {
  const provider = observations.find((observation) => observation.source === "provider")
  const handle = observations.find((observation) => observation.source === "handle")
  const workspace = observations.find((observation) => observation.source === "workspace")
  if (observations.some((observation) => observation.ownership === "conflict")) return "conflict"
  if (record.state === "sync_failed") return "work_at_risk"

  const present = provider?.observed === true && provider.resource === "present" && provider.ownership === "verified"
  const absent = provider?.observed === true && provider.resource === "absent"
  const handlePresent = handle?.observed === true && handle.resource === "present"
  const handleAbsent = handle?.observed === true && handle.resource === "absent"
  const workspaceAbsent = workspace?.observed === true && workspace.resource === "absent"
  const desired = intentFor(record).desiredLocation
  if (handlePresent && present && provider.health !== "unknown") return "attached"
  if (handlePresent) return "unknown"
  if (!provider?.observed || provider.resource === "unknown") {
    return record.state === "local" || record.state === "detached" || record.state === "deleted" ? "unknown" : "control_lost"
  }
  if (provider.resource === "present" && provider.ownership !== "verified") return "unknown"
  if (handleAbsent && present) return desired === "local" || desired === "deleted" ? "leaked_resource" : "orphan"
  if (handleAbsent && record.state !== "local" && record.state !== "detached" && record.state !== "deleted") {
    if (absent && workspaceAbsent) return "stale_record"
    return "control_lost"
  }
  if (absent && workspaceAbsent && handleAbsent) return "clean"
  return "unknown"
}

function workFromInspection(
  record: SandboxRecord,
  git: GitWorkingTreeObservation | undefined,
  classification: SandboxResultV2["classification"],
): SandboxResultV2["work"] {
  const base = workFromRecord(record, classification)
  const preservation = record.preservedWorktreePath && /^[a-f0-9]{40}$/i.test(git?.head ?? "")
    ? "preserved"
    : record.operation?.force || isForceDelete(record)
      ? "discard_authorized"
      : ["control_lost", "orphan", "leaked_resource", "work_at_risk", "unknown"].includes(classification)
        ? "at_risk"
        : "not_needed"
  return {
    ...base,
    runtimeHead: git?.head ?? null,
    sync: record.state === "sync_failed" ? "failed" : git?.dirty === true ? "dirty" : git?.dirty === false ? "clean" : base.sync,
    preservation,
    preservedWorktreePath: record.preservedWorktreePath ?? null,
  }
}

function effectiveTargetFor(
  record: SandboxRecord,
  runtimeTarget: WorkspaceTarget | undefined,
  workspace: WorkspaceInfo | undefined,
  providerValue: ProviderResourceObservation | undefined,
  provider: SandboxObservation,
  handle: SandboxObservation,
): SandboxResultV2["effectiveTarget"] {
  if (handle.observed && handle.resource === "present") {
    const target = runtimeTarget
    if (!target) return null
    if (target.type === "local") return { kind: "local", directory: target.directory }
    if (provider.resource !== "present" || provider.ownership !== "verified" || !providerValue?.resourceId) return null
    return { kind: "remote", resourceId: safeResourceId(providerValue.resourceId) }
  }
  if (handle.observed && handle.resource === "unknown") return null
  if (record.state !== "local" || !workspace || !workspaceMatches(record, workspace) || workspace.directory !== record.directory) return null
  return { kind: "local", directory: record.directory }
}

interface TargetProbe {
  observed: boolean
  value?: WorkspaceTarget
  error?: unknown
}

function runtimeHandleObservation(
  session: SandcastleSession | undefined,
  target: TargetProbe,
  freshAt: string,
): SandboxObservation {
  if (target.error) {
    return {
      source: "handle",
      observed: true,
      freshAt,
      resource: "unknown",
      ownership: "unknown",
      health: "unknown",
      evidence: [`runtime target inspection failed:${errorCode(target.error)}`],
      }
  }
  if (!target.observed) {
    return {
      source: "handle",
      observed: false,
      freshAt,
      evidence: ["runtime target inspection is unavailable"],
    }
  }
  if (session) {
    return {
      source: "handle",
      observed: true,
      freshAt,
      resource: "present",
      ownership: "verified",
      health: "unknown",
      evidence: ["in-memory runtime handle"],
    }
  }
  if (target.value) {
    return {
      source: "handle",
      observed: true,
      freshAt,
      resource: "present",
      ownership: "verified",
      health: "unknown",
      evidence: ["direct provider runtime target"],
    }
  }
  return {
    source: "handle",
    observed: true,
    freshAt,
    resource: "absent",
    ownership: "unknown",
    health: "unknown",
    evidence: ["no in-memory runtime handle"],
  }
}

function inventoryRecord(record: SandboxRecord): Record<string, unknown> {
  const result: Record<string, unknown> = {
    sessionId: record.sessionId,
    projectId: record.projectId,
    workspaceId: record.workspaceId,
    generation: record.generation,
    provider: record.provider,
    state: record.state,
    branch: record.branch,
    baseSha: record.baseSha,
  }
  if (record.preservedWorktreePath) result.preservedWorktreePath = record.preservedWorktreePath
  const providerState = boundedDetails(nonSecretDetails(record.providerState))
  if (Object.keys(providerState).length > 0) result.providerState = providerState
  return result
}

function boundedItems<T>(values: readonly T[], maxBytes: number): { values: T[]; truncated: boolean } {
  const result: T[] = []
  let bytes = 0
  for (const value of values) {
    const size = Buffer.byteLength(JSON.stringify(value))
    if (bytes + size > maxBytes) return { values: result, truncated: true }
    result.push(value)
    bytes += size
  }
  return { values: result, truncated: false }
}

function safeEvidence(values: readonly unknown[]): string[] {
  const output: string[] = []
  let bytes = 0
  for (const value of values.slice(0, 8)) {
    const text = safePublicText(String(value)).slice(0, 256)
    const size = Buffer.byteLength(text)
    if (bytes + size > 4_096) break
    output.push(text)
    bytes += size
  }
  return output
}

function safeResourceId(value: string): string {
  const text = safePublicText(value).slice(0, 128)
  return text || "unknown"
}

function safePublicText(value: string): string {
  return redactText(value).replace(/https?:\/\/[^\s]+/gi, "[REDACTED_URL]")
}

function errorCode(error: unknown): string {
  return error instanceof SandboxError ? error.code : "SANDBOX_ERROR"
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SandboxError("inspect", message, "INSPECTION_TIMEOUT")), timeoutMs)
    promise.then(resolve, reject).finally(() => clearTimeout(timer)).catch(() => undefined)
  })
}

function cryptoRandomUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}
