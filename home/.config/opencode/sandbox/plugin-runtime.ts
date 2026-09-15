import { dirname, isAbsolute, join } from "node:path"
import { open, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { Database } from "bun:sqlite"

import { assertExperimentalWorkspacesEnabled, loadConfig, parseConfig, withApiEnvironmentOverrides } from "./config"
import { ControlChannel } from "./control-channel"
import { SshExeControl, type ExeControl } from "./exe-control"
import { LifecycleController, type InfrastructureOperations } from "./lifecycle"
import { isSafeSandboxPath, shortHash } from "./naming"
import { createExedevSandcastleAdapter, ExedevProvider, ensureExeDevHostKey, remoteWorkspaceDirectory } from "./exedev-provider"
import { createSbxSandcastleAdapter, SbxProvider } from "./sbx-provider"
import { createCloudflareSandcastleAdapter, REMOTE_CHECKOUT_DIRECTORY } from "./cloudflare-provider"
import { redactError } from "./redaction"
import { FileStateStore } from "./state-store"
import type { SandcastleAdapterInput, SandcastleSessionFactory } from "./sandcastle-session"
import { captureWorkingTree, inspectWorkingTree } from "./working-tree"
import {
  HttpWorkspaceGateway,
  MAX_REPLAY_EVENTS,
  MAX_REPLAY_HISTORY_BYTES,
  serializedReplayEventBytes,
} from "./workspace-http"
import { MAX_REMOTE_FRAME_BYTES } from "./remote-runtime"
import {
  isNodeError,
  isRecord,
  SandboxError,
  type ControlCapability,
  type RuntimeOwner,
  type SandboxRecord,
  type SessionContext,
  type WorkspaceInfo,
  type WorkspaceProviderBase,
  type WorkspaceReplayEvent,
  type WorkspaceTarget,
} from "./types"

export interface PluginInputLike {
  client?: unknown
  project: { id: string }
  directory: string
  worktree: string
  serverUrl: URL
  experimental_workspace: {
    register(type: string, adapter: WorkspaceAdapterLike): void
  }
}

export interface WorkspaceAdapterLike {
  name: string
  description: string
  configure(info: WorkspaceInfo): WorkspaceInfo | Promise<WorkspaceInfo>
  create(info: WorkspaceInfo, env: Record<string, string | undefined>, from?: WorkspaceInfo): Promise<void>
  remove(info: WorkspaceInfo): Promise<void>
  target(info: WorkspaceInfo): WorkspaceTarget | Promise<WorkspaceTarget>
}

export interface SandboxPluginOptions {
  env?: Record<string, string | undefined>
  config?: unknown
  provisioner?: WorkspaceProviderBase
  sandcastle?: SandcastleWorkspaceOptions
  control?: ExeControl
  ensureHostKey?: () => Promise<void>
  ensureVmHostKey?: (identity: import("./types").VmIdentity) => Promise<void>
  runner?: import("./types").ProcessRunner
  supervisor?: import("./types").ProcessSupervisor
  fetcher?: typeof fetch
  infrastructure?: InfrastructureOperations
  log?: (message: string) => void
}

export interface SandcastleWorkspaceOptions extends SandcastleSessionFactory {
  type: string
  name: string
  description: string
}

export interface PluginHooksLike {
  dispose(): Promise<void>
  event(input: { event: unknown }): Promise<void>
  "chat.message"(input: { sessionID: string }): Promise<void>
  "command.execute.before"(input: { command: string; sessionID: string }): Promise<void>
  "shell.env"(input: { cwd: string; sessionID?: string }, output: { env: Record<string, string> }): Promise<void>
}

export async function createSandboxPlugin(input: PluginInputLike, options: SandboxPluginOptions = {}): Promise<PluginHooksLike | undefined> {
  const env = options.env ?? process.env
  const log = options.log ?? ((message: string) => console.error(`opencode-sandbox: ${message}`))

  try {
    assertExperimentalWorkspacesEnabled(env)
    const config = options.config !== undefined && options.config !== null
      ? parseConfig(withApiEnvironmentOverrides(options.config, env), env)
      : await loadConfig(input.worktree, env)
    const authContent = await resolveAuthContent(env)
    const runtimeRoot = runtimeDirectory(env)
    const controlSocket = join(runtimeRoot, `oe-${shortHash(`${process.pid}:${input.project.id}`)}`, "c.sock")
    const store = new FileStateStore(config.stateDirectory)
    const capabilities = new Map<string, ControlCapability>()
    let projectCapability: ControlCapability | undefined
    let disposing = false
    const controllerRef: { current?: LifecycleController } = {}
    let controlChannel: ControlChannel | undefined
    const exeControl = options.control ?? new SshExeControl({
      lobby: config.sshLobby,
      knownHostsFile: config.knownHostsFile,
      runner: options.runner,
    })
    const ensureHostKey = options.ensureHostKey ?? (() => ensureExeDevHostKey(config.knownHostsFile, config.sshLobby, options.runner))
    const controlTokenFor = async (sessionId: string): Promise<string> => {
      const controller = controllerRef.current
      const channel = controlChannel
      if (!channel || !controller) throw new SandboxError("control_channel", "control channel is not ready", "CONTROL_CHANNEL")
      const capability = await controller.capabilityFor(sessionId, "remote")
      channel.register(capability)
      return capability.token
    }
    const defaultSbx = config.provider === "sbx" && !options.provisioner && !options.sandcastle
    const defaultExedev = config.provider === "exedev" && !options.provisioner && !options.sandcastle
    const sbxOwnerForResource = defaultSbx
      ? async (resourceId: string, owner?: RuntimeOwner) => {
          const matches = (await store.list()).filter((record) => {
            if (record.provider !== "sbx") return false
            if (owner && (
              owner.provider !== record.provider ||
              owner.projectId !== record.projectId ||
              owner.sessionId !== record.sessionId ||
              owner.generation !== record.generation ||
              owner.workspaceId !== record.workspaceId
            )) return false
            const state = record.providerState
            const candidate = [state.sandbox, state.resourceId, state.sandboxId].find((value): value is string => typeof value === "string" && value.length > 0)
            return candidate === resourceId
          })
          if (matches.length !== 1) return undefined
          const record = matches[0]!
          const ownershipId = record.providerState.ownershipId
          if (typeof ownershipId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(ownershipId)) return undefined
          return {
            provider: "sbx" as const,
            ownershipId,
            sessionId: record.sessionId,
            generation: record.generation,
            workspaceId: record.workspaceId,
            projectId: record.projectId,
          }
        }
      : undefined
    const defaultSbxProvider = defaultSbx
        ? new SbxProvider({
          worktree: input.worktree,
          runner: options.runner,
          localControlSocket: controlSocket,
          supervisor: options.supervisor,
          fetcher: options.fetcher,
          remotePort: config.remotePort,
          healthTimeoutMs: config.healthTimeoutMs,
          bootstrapTimeoutMs: config.bootstrapTimeoutMs,
          openCodeVersion: config.openCodeVersion,
          deferActivation: true,
          authContent,
          ownerForResource: sbxOwnerForResource,
          controlTokenFor,
          revokeControlToken: (token) => controlChannel?.revoke(token),
        })
      : undefined
    const defaultSbxRuntimeDriver = defaultSbxProvider?.runtimeDriver()
    const exedevMetadataForResource = defaultExedev
      ? async (resourceId: string, owner?: RuntimeOwner): Promise<unknown> => {
          const matches = (await store.list()).filter((record) => {
            if (record.provider !== "exedev") return false
            if (owner && (
              owner.provider !== record.provider ||
              owner.projectId !== record.projectId ||
              owner.sessionId !== record.sessionId ||
              owner.generation !== record.generation ||
              owner.workspaceId !== record.workspaceId ||
              owner.directory !== record.directory ||
              owner.branch !== record.branch ||
              owner.baseSha !== record.baseSha
            )) return false
            const state = record.providerState
            const identity = isRecord(state.vmIdentity) ? state.vmIdentity : record.vmIdentity
            const candidates = [
              state.resourceId,
              state.vmName,
              record.vmName,
              record.vmIdentity?.id,
              record.vmIdentity?.name,
              isRecord(identity) && typeof identity.id === "string" ? identity.id : undefined,
              isRecord(identity) && typeof identity.name === "string" ? identity.name : undefined,
            ]
            return candidates.includes(resourceId)
          })
          if (matches.length !== 1) return undefined
          const record = matches[0]!
          const state = record.providerState
          const identity = isRecord(state.vmIdentity) ? state.vmIdentity : record.vmIdentity
          if (
            state.provider !== "exedev" ||
            state.projectId !== record.projectId ||
            state.sessionId !== record.sessionId ||
            state.generation !== record.generation ||
            state.workspaceId !== record.workspaceId ||
            state.branch !== record.branch ||
            state.baseSha !== record.baseSha ||
            typeof state.remoteDirectory !== "string" ||
            typeof state.vmName !== "string" ||
            !identity
          ) return undefined
          return {
            provider: "exedev",
            projectId: record.projectId,
            sessionId: record.sessionId,
            generation: record.generation,
            workspaceId: record.workspaceId,
            branch: record.branch,
            baseSha: record.baseSha,
            remoteDirectory: state.remoteDirectory,
            vmName: state.vmName,
            vmIdentity: identity,
          }
        }
      : undefined
    const defaultExedevProvider = defaultExedev
      ? new ExedevProvider({
          config,
          control: exeControl,
          worktree: input.worktree,
          runner: options.runner,
          localControlSocket: controlSocket,
          supervisor: options.supervisor,
          fetcher: options.fetcher,
          ensureHostKey,
          ensureVmHostKey: options.ensureVmHostKey,
          authContent,
          durableMetadataForResource: exedevMetadataForResource,
          controlTokenFor,
          revokeControlToken: (token) => controlChannel?.revoke(token),
          deferActivation: true,
        })
      : undefined
    const defaultExedevRuntimeDriver = defaultExedevProvider?.runtimeDriver()
    const sandcastle: SandcastleWorkspaceOptions | undefined = options.sandcastle ?? (
      config.provider === "cloudflare" || ((config.provider === "exedev" || config.provider === "sbx") && !options.provisioner)
        ? {
            type: config.provider,
            name: config.provider === "sbx" ? "Docker Sandbox" : config.provider === "cloudflare" ? "Cloudflare Sandbox" : "exe.dev",
            description: config.provider === "sbx"
              ? "OpenCode workspace backed by an isolated Docker Sandbox clone"
              : config.provider === "cloudflare"
                ? `OpenCode workspace backed by a Cloudflare Sandbox (OpenCode ${config.openCodeVersion})`
                : `OpenCode workspace backed by an exe.dev VM (OpenCode ${config.openCodeVersion})`,
            ...(defaultSbxRuntimeDriver ? { runtimeDriver: defaultSbxRuntimeDriver } : {}),
            ...(defaultExedevRuntimeDriver ? { runtimeDriver: defaultExedevRuntimeDriver } : {}),
            createAdapter: (adapterInput: SandcastleAdapterInput) => {
              if (config.provider === "sbx") {
                return createSbxSandcastleAdapter({
                  input: adapterInput,
                  worktree: input.worktree,
                  localControlSocket: controlSocket,
                  supervisor: options.supervisor,
                  fetcher: options.fetcher,
                  remotePort: config.remotePort,
                  healthTimeoutMs: config.healthTimeoutMs,
                  bootstrapTimeoutMs: config.bootstrapTimeoutMs,
                  openCodeVersion: config.openCodeVersion,
                  authContent,
                  controlTokenFor,
                  revokeControlToken: (token) => controlChannel?.revoke(token),
                  provider: defaultSbxProvider,
                })
              }
              if (config.provider === "cloudflare") {
                if (!config.apiUrl || !config.apiKey) {
                  throw new SandboxError("validate", "Cloudflare provider requires apiUrl and apiKey", "CLOUDFLARE_CONFIG")
                }
                return createCloudflareSandcastleAdapter({
                  input: adapterInput,
                  worktree: input.worktree,
                  apiUrl: config.apiUrl,
                  apiKey: config.apiKey,
                  fetcher: options.fetcher,
                  remotePort: config.remotePort,
                  healthTimeoutMs: config.healthTimeoutMs,
                  bootstrapTimeoutMs: config.bootstrapTimeoutMs,
                  openCodeVersion: config.openCodeVersion,
                  authContent,
                  localControlSocket: controlSocket,
                  controlTokenFor,
                  revokeControlToken: (token) => controlChannel?.revoke(token),
                })
              }
              return createExedevSandcastleAdapter({
                input: adapterInput,
                config,
                control: exeControl,
                worktree: input.worktree,
                runner: options.runner,
                localControlSocket: controlSocket,
                supervisor: options.supervisor,
                fetcher: options.fetcher,
                ensureHostKey,
                authContent,
                provider: defaultExedevProvider,
                controlTokenFor,
                revokeControlToken: (token) => controlChannel?.revoke(token),
              })
            },
          }
        : undefined
    )
    const provider: WorkspaceProviderBase | undefined = sandcastle
      ? undefined
      : options.provisioner ?? createProvider(config.provider, {
          config,
          env,
          worktree: input.worktree,
          controlSocket,
          control: exeControl,
          supervisor: options.supervisor,
          fetcher: options.fetcher,
          ensureHostKey,
          controllerRef,
          getControlChannel: () => controlChannel,
        })
    const inspectionProvider = provider ?? defaultSbxProvider ?? defaultExedevProvider ?? (!options.sandcastle ? createInspectionProvider(config.provider, {
      config,
      worktree: input.worktree,
      control: exeControl,
      controlSocket,
      supervisor: options.supervisor,
      fetcher: options.fetcher,
      ensureHostKey,
    }) : undefined)
    const clientFetch = (input.client as { _client?: { getConfig?: () => { fetch?: typeof fetch } } } | undefined)?._client?.getConfig?.().fetch
    const gateway = new HttpWorkspaceGateway({
      serverUrl: input.serverUrl,
      directory: input.directory,
      projectId: input.project.id,
      fetcher: clientFetch ? (request, init) => clientFetch(new Request(request, init)) : undefined,
      captureApplier: provider
        ? async ({ workspaceId, capture }) => {
            await provider.syncIn(workspaceId, capture)
          }
        : undefined,
      syncOut: provider?.syncOut
        ? (syncInput) => provider.syncOut!(syncInput)
        : undefined,
      runtimeMetadata: provider?.runtimeMetadata?.bind(provider),
      sessionEvents: (sessionId) => readSessionEvents(openCodeDatabasePath(env), sessionId),
    })
    const controller = new LifecycleController({
      store,
      workspace: gateway,
      capture: (context) => captureWorkingTree(context),
      providerType: sandcastle?.type ?? provider?.type,
      branchForWorkspace: provider?.branch?.bind(provider),
      providerInspect: inspectionProvider?.inspect
        ? (record, signal) => inspectionProvider.inspect!(workspaceInfoForRecord(record), signal)
        : undefined,
      providerDiagnose: inspectionProvider?.diagnose
        ? (record, signal) => inspectionProvider.diagnose!(workspaceInfoForRecord(record), signal)
        : undefined,
      processInspect: inspectionProvider?.processObservation
        ? (record) => inspectionProvider.processObservation!(record.workspaceId)
        : undefined,
      diagnosticSources: async (signal) => {
        const dependency = await installedPluginVersion(signal)
        return {
          configured: config.openCodeVersion,
          ...(env.OPENCODE_VERSION ? { local: env.OPENCODE_VERSION } : {}),
          ...(dependency ? { dependency } : {}),
        }
      },
      providerTarget: provider?.target
        ? (record) => provider.target(workspaceInfoForRecord(record))
        : undefined,
      providerInventory: inspectionProvider?.inventory?.bind(inspectionProvider),
      gitInspect: (record, worktreePath, signal) => inspectWorkingTree(worktreePath, undefined, signal),
      providerRelease: provider?.release
        ? (record) => provider.release!(workspaceInfoForRecord(record))
        : undefined,
      providerDestroy: provider?.destroy
        ? (record) => provider.destroy!(workspaceInfoForRecord(record))
        : undefined,
      sandcastle,
      infrastructure: options.infrastructure ?? {
        remove: async (record) => {
          if (record.provider !== "exedev" || inspectionProvider?.type !== "exedev" || !inspectionProvider.destroy) {
            throw new SandboxError("remove", "verified exe.dev cleanup is unavailable", "EXEDEV_CLEANUP_UNAVAILABLE")
          }
          await ensureHostKey()
          await inspectionProvider.destroy(workspaceInfoForRecord(record))
        },
      },
    })
    controllerRef.current = controller
    await controller.reconcile(input.project.id)
    const channel = new ControlChannel({
      socketPath: controlSocket,
      handler: (request) => controller.handle(request),
      requestTimeoutMs: config.bootstrapTimeoutMs + config.healthTimeoutMs + 60_000,
    })
    controlChannel = channel

    await channel.start()
    if (!provider && !sandcastle) throw new SandboxError("validate", "sandbox provider is unavailable", "PROVIDER_UNAVAILABLE")
    const adapter = sandcastle
      ? createSandcastleWorkspaceAdapter(sandcastle, controller)
      : createWorkspaceAdapter(provider!)
    input.experimental_workspace.register(sandcastle?.type ?? provider!.type, adapter)

    const contextFor = (sessionId: string, cwd = input.directory): SessionContext => {
      const context = {
        sessionId,
        projectId: input.project.id,
        directory: cwd,
        worktree: input.worktree,
      }
      controller.registerContext(context)
      return context
    }

    const capabilityFor = async (sessionId: string): Promise<ControlCapability> => {
      const next = await controller.capabilityFor(sessionId, "host")
      if (disposing) throw new SandboxError("transition", "sandbox plugin was disposed", "PLUGIN_DISPOSED")
      const previous = capabilities.get(sessionId)
      if (!previous || previous.generation !== next.generation || previous.expiresAt <= Date.now()) {
        if (previous) channel.revoke(previous.token)
        channel.register(next)
        capabilities.set(sessionId, next)
      }
      return capabilities.get(sessionId) ?? next
    }

    const revokeHostCapability = (sessionId: string): void => {
      const capability = capabilities.get(sessionId)
      if (!capability) return
      channel.revoke(capability.token)
      capabilities.delete(sessionId)
    }
    const capabilityForInventory = async (): Promise<ControlCapability> => {
      const current = projectCapability
      if (current && current.expiresAt > Date.now()) return current
      if (current) channel?.revoke(current.token)
      const next = await controller.projectCapabilityFor(input.project.id)
      channel?.register(next)
      projectCapability = next
      return next
    }
    let disposal: Promise<void> | undefined

    return {
      dispose() {
        disposal ??= (async () => {
          disposing = true
          for (const capability of capabilities.values()) channel?.revoke(capability.token)
          if (projectCapability) channel?.revoke(projectCapability.token)
          capabilities.clear()
          projectCapability = undefined
          let failure: unknown
          try {
            await controller.dispose()
          } catch (error) {
            failure = error
          }
          try {
            await provider?.dispose?.()
          } catch (error) {
            failure ??= error
          }
          try {
            await channel.close()
          } catch (error) {
            failure ??= error
          }
          if (failure) throw failure
        })().catch((error) => {
          disposal = undefined
          throw error
        })
        return disposal
      },
      async event({ event }) {
        const value = isRecord(event) ? event : undefined
        if (!value) return
        const properties = isRecord(value.properties) ? value.properties : undefined
        if (!properties) return
        if (value.type === "session.created" || value.type === "session.updated") {
          const info = isRecord(properties.info) ? properties.info : undefined
          if (info && typeof info.id === "string" && typeof info.directory === "string") contextFor(info.id, info.directory)
          return
        }
        if (value.type === "session.idle" && typeof properties.sessionID === "string") {
          const sessionId = properties.sessionID
          contextFor(sessionId)
          // ponytail: drain trailing events for 500 ms; replace with a durable idle fence when OpenCode exposes one.
          controller.scheduleSessionIdle(sessionId, async () => {
            const record = await store.get(sessionId)
            if (record && record.phase === "idle" && !record.lastError) revokeHostCapability(sessionId)
          })
        }
      },
      async "chat.message"({ sessionID }) {
        contextFor(sessionID)
        await controller.assertMessageAllowed(sessionID)
      },
      async "command.execute.before"({ command, sessionID }) {
        if (command === "sandbox") {
          contextFor(sessionID)
          await capabilityFor(sessionID)
        }
      },
      async "shell.env"({ cwd, sessionID }, output) {
        if (!sessionID) return
        contextFor(sessionID, cwd)
        const capability = await capabilityFor(sessionID)
        const project = await capabilityForInventory()
        output.env.SANDBOX_CONTROL_SOCKET = channel.socketPath
        output.env.SANDBOX_CONTROL_TOKEN = capability.token
        output.env.SANDBOX_CONTROL_PROJECT_TOKEN = project.token
        output.env.SANDBOX_CONTROL_ROLE = "host"
      },
    }
  } catch (error) {
    log(redactError(error))
    return undefined
  }
}

async function installedPluginVersion(signal?: AbortSignal): Promise<string | undefined> {
  try {
    const packagePath = join(dirname(fileURLToPath(import.meta.url)), "../node_modules/@opencode-ai/plugin/package.json")
    const value = JSON.parse(await readFile(packagePath, { encoding: "utf8", signal }))
    return isRecord(value) && typeof value.version === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value.version)
      ? value.version
      : undefined
  } catch {
    return undefined
  }
}

function openCodeDatabasePath(env: Record<string, string | undefined>): string {
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "opencode.db")
}

function createInspectionProvider(
  provider: "exedev" | "sbx" | "cloudflare",
  options: {
    config: ReturnType<typeof parseConfig>
    worktree: string
    control: ExeControl
    controlSocket: string
    supervisor?: import("./types").ProcessSupervisor
    fetcher?: typeof fetch
    ensureHostKey: () => Promise<void>
  },
): WorkspaceProviderBase | undefined {
  if (provider === "sbx") {
    return new SbxProvider({
      worktree: options.worktree,
      remotePort: options.config.remotePort,
      healthTimeoutMs: options.config.healthTimeoutMs,
      bootstrapTimeoutMs: options.config.bootstrapTimeoutMs,
      supervisor: options.supervisor,
      fetcher: options.fetcher,
      openCodeVersion: options.config.openCodeVersion,
    })
  }
  if (provider === "exedev") {
    return new ExedevProvider({
      config: options.config,
      control: options.control,
      worktree: options.worktree,
      localControlSocket: options.controlSocket,
      supervisor: options.supervisor,
      fetcher: options.fetcher,
      ensureHostKey: options.ensureHostKey,
    })
  }
  return undefined
}

export function readSessionEvents(databasePath: string, sessionId: string): WorkspaceReplayEvent[] {
  const database = new Database(databasePath, { readonly: true })
  try {
    const summary = database.query<{
      count: number
      bytes: number
    }, [string]>(
      "SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(data AS BLOB))), 0) AS bytes FROM event WHERE aggregate_id = ?",
    ).get(sessionId)
    if (!summary || summary.count > MAX_REPLAY_EVENTS || summary.bytes > MAX_REPLAY_HISTORY_BYTES) {
      throw replayLimitError()
    }
    const rows = database.query<{
      id: string
      aggregateID: string
      seq: number
      type: string
      data: string
    }, [string]>(
      `SELECT id, aggregate_id AS aggregateID, seq, type, data FROM event WHERE aggregate_id = ? ORDER BY seq LIMIT ${MAX_REPLAY_EVENTS + 1}`,
    ).all(sessionId)
    if (rows.length > MAX_REPLAY_EVENTS) {
      throw replayLimitError()
    }
    let serializedBytes = 2
    return rows.map((row, index) => {
      let data: unknown
      try {
        data = JSON.parse(row.data)
      } catch {
        throw new SandboxError("sync", "OpenCode session history contains invalid event JSON", "WORKSPACE_HISTORY")
      }
      if (row.seq !== index || !isRecord(data)) {
        throw new SandboxError("sync", "OpenCode session history is invalid", "WORKSPACE_HISTORY")
      }
      const event = { ...row, data }
      serializedBytes += serializedReplayEventBytes(event) + (index === 0 ? 0 : 1)
      if (serializedBytes > MAX_REPLAY_HISTORY_BYTES) throw replayLimitError()
      return event
    })
  } finally {
    database.close()
  }
}

export async function resolveAuthContent(env: Record<string, string | undefined>): Promise<string | undefined> {
  if (env.OPENCODE_AUTH_CONTENT) {
    assertAuthContentSize(env.OPENCODE_AUTH_CONTENT)
    return env.OPENCODE_AUTH_CONTENT
  }
  const dataDirectory = env.XDG_DATA_HOME ?? (env.HOME ? join(env.HOME, ".local", "share") : undefined)
  if (!dataDirectory || !isAbsolute(dataDirectory)) return undefined
  try {
    const content = await readLimitedText(join(dataDirectory, "opencode", "auth.json"), MAX_REMOTE_FRAME_BYTES)
    JSON.parse(content)
    return content
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined
    if (error instanceof SandboxError) throw error
    throw new SandboxError("bootstrap", "OpenCode auth content could not be loaded", "AUTH_UNAVAILABLE")
  }
}

function replayLimitError(): SandboxError {
  return new SandboxError("sync", "OpenCode session history exceeds the replay limit", "WORKSPACE_REPLAY_LIMIT")
}

function assertAuthContentSize(content: string): void {
  if (Buffer.byteLength(content) > MAX_REMOTE_FRAME_BYTES) {
    throw new SandboxError("bootstrap", "OpenCode auth content is too large", "AUTH_LIMIT")
  }
}

async function readLimitedText(path: string, maxBytes: number): Promise<string> {
  const file = await open(path, "r")
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (size <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - size + 1))
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      size += bytesRead
      if (size > maxBytes) throw new SandboxError("bootstrap", "OpenCode auth content is too large", "AUTH_LIMIT")
      chunks.push(chunk.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks, size).toString("utf8")
  } finally {
    await file.close()
  }
}

function createProvider(
  provider: "exedev" | "sbx" | "cloudflare",
  options: {
    config: ReturnType<typeof parseConfig>
    env: Record<string, string | undefined>
    worktree: string
    controlSocket: string
    control: ExeControl
    supervisor?: import("./types").ProcessSupervisor
    fetcher?: typeof fetch
    ensureHostKey: () => Promise<void>
    controllerRef: { current?: LifecycleController }
    getControlChannel: () => ControlChannel | undefined
  },
): WorkspaceProviderBase {
  if (provider === "sbx") {
    return new SbxProvider({
      worktree: options.worktree,
      remotePort: options.config.remotePort,
      healthTimeoutMs: options.config.healthTimeoutMs,
      bootstrapTimeoutMs: options.config.bootstrapTimeoutMs,
      supervisor: options.supervisor,
      fetcher: options.fetcher,
      openCodeVersion: options.config.openCodeVersion,
    })
  }

  if (provider === "cloudflare") throw new SandboxError("validate", "Cloudflare must use the Sandcastle adapter", "CLOUDFLARE_LEGACY_DISABLED")

  return new ExedevProvider({
    config: options.config,
    control: options.control,
    worktree: options.worktree,
    localControlSocket: options.controlSocket,
    supervisor: options.supervisor,
    fetcher: options.fetcher,
    ensureHostKey: options.ensureHostKey,
    controlTokenFor: async (sessionId) => {
      const controller = options.controllerRef.current
      const channel = options.getControlChannel()
      if (!channel || !controller) throw new SandboxError("control_channel", "control channel is not ready", "CONTROL_CHANNEL")
      const capability = await controller.capabilityFor(sessionId, "remote")
      channel.register(capability)
      return capability.token
    },
    revokeControlToken: (token) => options.getControlChannel()?.revoke(token),
  })
}

function workspaceInfoForRecord(record: SandboxRecord): WorkspaceInfo {
  const providerState = record.providerState
  const providerStateVmIdentity = isRecord(providerState) && isRecord(providerState.vmIdentity) ? providerState.vmIdentity : undefined
  const providerStateName = isRecord(providerState) && typeof providerState.vmName === "string"
    ? providerState.vmName
    : typeof providerStateVmIdentity?.name === "string"
      ? providerStateVmIdentity.name
      : undefined
  return {
    id: record.workspaceId,
    type: record.provider,
    name: record.vmName ?? record.vmIdentity?.name ?? providerStateName ?? record.workspaceId,
    branch: record.branch,
    directory: record.directory,
    extra: {
      sessionId: record.sessionId,
      generation: record.generation,
      providerState: record.providerState,
      ...(record.vmName ? { vmName: record.vmName } : {}),
      ...(record.vmIdentity ? { vmIdentity: record.vmIdentity } : {}),
    },
    projectID: record.projectId,
  }
}

function createSandcastleWorkspaceAdapter(options: SandcastleWorkspaceOptions, controller: LifecycleController): WorkspaceAdapterLike {
  return {
    name: options.name,
    description: options.description,
    configure(info) {
      return {
        ...info,
        directory: options.type === "cloudflare"
          ? REMOTE_CHECKOUT_DIRECTORY
          : options.type === "sbx"
            ? sbxRemoteWorktreePath(info.extra)
            : options.type === "exedev"
              ? exedevRemoteWorktreePath(info)
              : info.directory,
        extra: nonSecretExtra(info.extra),
      }
    },
    async create() {},
    async remove() {},
    target(info) {
      const target = controller.targetForWorkspace(info.id)
      if (!target) throw new SandboxError("tunnel", "sandbox target is unavailable", "TARGET_UNAVAILABLE")
      return target
    },
  }
}

function sbxRemoteWorktreePath(value: unknown): string {
  const extra = isRecord(value) ? value : {}
  const providerState = isRecord(extra.providerState) ? extra.providerState : extra
  const path = providerState.remoteWorktreePath ?? extra.remoteWorktreePath
  if (!isSafeSandboxPath(path)) {
    throw new SandboxError("validate", "SBX remote worktree path is invalid", "WORKSPACE_DIRECTORY")
  }
  return path
}

function exedevRemoteWorktreePath(info: WorkspaceInfo): string {
  const extra = isRecord(info.extra) ? info.extra : {}
  const providerState = isRecord(extra.providerState) ? extra.providerState : extra
  const path = providerState.remoteWorktreePath ?? extra.remoteWorktreePath
  if (!isSafeSandboxPath(path) || path !== remoteWorkspaceDirectory(info.id)) {
    throw new SandboxError("validate", "exe.dev remote worktree path is invalid", "WORKSPACE_DIRECTORY")
  }
  return path
}

function createWorkspaceAdapter(provider: WorkspaceProviderBase): WorkspaceAdapterLike {
  return {
    name: provider.name,
    description: provider.description,
    async configure(info) {
      const configured = await provider.configure(info)
      return {
        ...configured,
        extra: nonSecretExtra(configured.extra),
      }
    },
    create(info, env, from) {
      return provider.prepare(info, env, from)
    },
    remove(info) {
      return provider.release(info)
    },
    target(info) {
      return provider.target(info)
    },
  }
}

function runtimeDirectory(env: Record<string, string | undefined>): string {
  const value = env.XDG_RUNTIME_DIR ?? env.TMPDIR ?? "/tmp"
  if (!value.startsWith("/")) throw new SandboxError("validate", "runtime directory must be absolute", "RUNTIME_DIRECTORY")
  return value
}

function nonSecretExtra(value: unknown): Record<string, unknown> {
  const sanitized = stripSecrets(value)
  return isRecord(sanitized) ? sanitized : {}
}

function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets)
  if (!isRecord(value)) return value
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (/(?:password|token|secret|credential|auth|api[_-]?key|private[_-]?key)/i.test(key)) continue
    result[key] = stripSecrets(item)
  }
  return result
}
