import { isAbsolute, join } from "node:path"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { Database } from "bun:sqlite"

import { assertExperimentalWorkspacesEnabled, parseConfig } from "./config"
import { ControlChannel } from "./control-channel"
import { SshExeControl, type ExeControl } from "./exe-control"
import { LifecycleController, type InfrastructureOperations } from "./lifecycle"
import { shortHash } from "./naming"
import { isTransitionPending } from "./state"
import { createExedevSandcastleAdapter, ExedevProvider, ensureExeDevHostKey } from "./exedev-provider"
import { createSbxSandcastleAdapter, SbxProvider } from "./sbx-provider"
import { createCloudflareSandcastleAdapter } from "./cloudflare-provider"
import { redactError } from "./redaction"
import { FileStateStore } from "./state-store"
import type { SandcastleAdapterInput, SandcastleSessionFactory } from "./sandcastle-session"
import { captureWorkingTree } from "./working-tree"
import { HttpWorkspaceGateway } from "./workspace-http"
import {
  isNodeError,
  isRecord,
  SandboxError,
  type ControlCapability,
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
    const config = parseConfig(options.config ?? (await configFromEnvironment(input.worktree, env)), env)
    const authContent = await resolveAuthContent(env)
    const runtimeRoot = runtimeDirectory(env)
    const controlSocket = join(runtimeRoot, `oe-${shortHash(`${process.pid}:${input.project.id}`)}`, "c.sock")
    const store = new FileStateStore(config.stateDirectory)
    const capabilities = new Map<string, ControlCapability>()
    const controllerRef: { current?: LifecycleController } = {}
    let controlChannel: ControlChannel | undefined
    const exeControl = options.control ?? new SshExeControl({
      lobby: config.sshLobby,
      knownHostsFile: config.knownHostsFile,
    })
    const ensureHostKey = options.ensureHostKey ?? (() => ensureExeDevHostKey(config.knownHostsFile, config.sshLobby))
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
            createAdapter: (adapterInput: SandcastleAdapterInput) => {
              const controlTokenFor = async (sessionId: string): Promise<string> => {
                const controller = controllerRef.current
                const channel = controlChannel
                if (!channel || !controller) throw new SandboxError("control_channel", "control channel is not ready", "CONTROL_CHANNEL")
                const capability = await controller.capabilityFor(sessionId, "remote")
                channel.register(capability)
                return capability.token
              }
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
                })
              }
              if (config.provider === "cloudflare") {
                const apiUrl = env.SANDBOX_API_URL
                const apiKey = env.SANDBOX_API_KEY
                if (!apiUrl || !apiKey) {
                  throw new SandboxError("validate", "Cloudflare provider requires SANDBOX_API_URL and SANDBOX_API_KEY", "CLOUDFLARE_CONFIG")
                }
                return createCloudflareSandcastleAdapter({
                  input: adapterInput,
                  worktree: input.worktree,
                  apiUrl,
                  apiKey,
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
                localControlSocket: controlSocket,
                supervisor: options.supervisor,
                fetcher: options.fetcher,
                ensureHostKey,
                authContent,
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
      providerRelease: provider?.release
        ? (record) => provider.release!(workspaceInfoForRecord(record))
        : undefined,
      providerDestroy: provider?.destroy
        ? (record) => provider.destroy!(workspaceInfoForRecord(record))
        : undefined,
      sandcastle,
      infrastructure: options.infrastructure ?? {
        remove: async (record) => {
          await ensureHostKey()
          if (!record.vmIdentity) throw new SandboxError("remove", "VM identity is unavailable", "VM_IDENTITY_UNAVAILABLE")
          await exeControl.remove(record.vmIdentity)
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

    return {
      async dispose() {
        controller.dispose()
        capabilities.clear()
        await provider?.dispose?.()
        await channel.close()
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
          setTimeout(() => {
            void controller.onSessionIdle(sessionId).then(async () => {
              const record = await store.get(sessionId)
              if (record && !isTransitionPending(record.state)) revokeHostCapability(sessionId)
            })
          }, 500)
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
        output.env.SANDBOX_CONTROL_SOCKET = channel.socketPath
        output.env.SANDBOX_CONTROL_TOKEN = capability.token
        output.env.SANDBOX_CONTROL_ROLE = "host"
      },
    }
  } catch (error) {
    log(redactError(error))
    return undefined
  }
}

function openCodeDatabasePath(env: Record<string, string | undefined>): string {
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "opencode.db")
}

export function readSessionEvents(databasePath: string, sessionId: string): WorkspaceReplayEvent[] {
  const database = new Database(databasePath, { readonly: true })
  try {
    const rows = database.query<{
      id: string
      aggregateID: string
      seq: number
      type: string
      data: string
    }, [string]>(
      "SELECT id, aggregate_id AS aggregateID, seq, type, data FROM event WHERE aggregate_id = ? ORDER BY seq",
    ).all(sessionId)
    return rows.map((row, index) => {
      const data: unknown = JSON.parse(row.data)
      if (row.seq !== index || !isRecord(data)) {
        throw new SandboxError("sync", "OpenCode session history is invalid", "WORKSPACE_HISTORY")
      }
      return { ...row, data }
    })
  } finally {
    database.close()
  }
}

export async function resolveAuthContent(env: Record<string, string | undefined>): Promise<string | undefined> {
  if (env.OPENCODE_AUTH_CONTENT) return env.OPENCODE_AUTH_CONTENT
  const dataDirectory = env.XDG_DATA_HOME ?? (env.HOME ? join(env.HOME, ".local", "share") : undefined)
  if (!dataDirectory || !isAbsolute(dataDirectory)) return undefined
  try {
    const content = await readFile(join(dataDirectory, "opencode", "auth.json"), "utf8")
    JSON.parse(content)
    return content
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined
    throw new SandboxError("bootstrap", "OpenCode auth content could not be loaded", "AUTH_UNAVAILABLE")
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
  return {
    id: record.workspaceId,
    type: record.provider,
    name: record.vmName ?? record.workspaceId,
    branch: record.branch,
    directory: record.directory,
    extra: {
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
      return { ...info, extra: nonSecretExtra(info.extra) }
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

async function configFromEnvironment(worktree: string, env: Record<string, string | undefined>): Promise<unknown> {
  const fileConfig = await configFromProjectFile(worktree)
  const text = env.SANDBOX_CONFIG
  if (!text) return { ...fileConfig, ...(env.SANDBOX_PROVIDER ? { provider: env.SANDBOX_PROVIDER } : {}) }
  try {
    const value = JSON.parse(text)
    if (!isRecord(value)) throw new SandboxError("validate", "SANDBOX_CONFIG must contain a JSON object", "CONFIG_JSON_TYPE")
    return { ...fileConfig, ...value, ...(env.SANDBOX_PROVIDER ? { provider: env.SANDBOX_PROVIDER } : {}) }
  } catch (error) {
    if (error instanceof SandboxError) throw error
    throw new SandboxError("validate", "SANDBOX_CONFIG is not valid JSON", "CONFIG_JSON")
  }
}

async function configFromProjectFile(worktree: string): Promise<Record<string, unknown>> {
  const path = join(worktree, ".opencode", "sandbox.json")
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return {}
    throw new SandboxError("validate", `could not read ${path}`, "CONFIG_FILE")
  }
  try {
    const value = JSON.parse(text)
    if (!isRecord(value)) throw new SandboxError("validate", `${path} must contain a JSON object`, "CONFIG_FILE_TYPE")
    return value
  } catch (error) {
    if (error instanceof SandboxError) throw error
    throw new SandboxError("validate", `${path} is not valid JSON`, "CONFIG_FILE_JSON")
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
