import { join } from "node:path"

import { assertExperimentalWorkspacesEnabled, parseConfig } from "./config"
import { ControlChannel, createCapability } from "./control-channel"
import { LifecycleController, type InfrastructureOperations, type TransitionFence } from "./lifecycle"
import { shortHash } from "./naming"
import { redactError } from "./redaction"
import { FileStateStore } from "./state-store"
import { captureWorkingTree } from "./working-tree"
import { HttpWorkspaceGateway } from "./workspace-http"
import { ExedevError, type ControlCapability, type SessionContext, type WorkspaceInfo, type WorkspaceTarget } from "./types"

export interface PluginInputLike {
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

export interface WorkspaceProvisioner {
  create(info: WorkspaceInfo, env: Record<string, string | undefined>, from?: WorkspaceInfo): Promise<void>
  remove(info: WorkspaceInfo): Promise<void>
  target(info: WorkspaceInfo): Promise<WorkspaceTarget>
}

export interface ExedevPluginOptions {
  env?: Record<string, string | undefined>
  config?: unknown
  fence?: TransitionFence
  provisioner?: WorkspaceProvisioner
  infrastructure?: InfrastructureOperations
  log?: (message: string) => void
}

export interface PluginHooksLike {
  dispose(): Promise<void>
  event(input: { event: unknown }): Promise<void>
  "command.execute.before"(input: { command: string; sessionID: string }): Promise<void>
  "shell.env"(input: { cwd: string; sessionID?: string }, output: { env: Record<string, string> }): Promise<void>
}

export const NO_PUBLIC_FENCING_SEAM: TransitionFence = {
  supported: false,
  reason: "OpenCode 1.18.23 exposes no supported pre-routing fencing hook",
}

export async function createExedevPlugin(input: PluginInputLike, options: ExedevPluginOptions = {}): Promise<PluginHooksLike | undefined> {
  const env = options.env ?? process.env
  const log = options.log ?? ((message: string) => console.error(`opencode-exedev: ${message}`))

  try {
    assertExperimentalWorkspacesEnabled(env)
    const config = parseConfig(options.config ?? configFromEnvironment(env), env)
    const runtimeRoot = runtimeDirectory(env)
    const controlSocket = join(runtimeRoot, `oe-${shortHash(`${process.pid}:${input.project.id}`)}`, "c.sock")
    const store = new FileStateStore(config.stateDirectory)
    const gateway = new HttpWorkspaceGateway({
      serverUrl: input.serverUrl,
      directory: input.directory,
      projectId: input.project.id,
    })
    const controller = new LifecycleController({
      store,
      workspace: gateway,
      fence: options.fence ?? NO_PUBLIC_FENCING_SEAM,
      capture: (context) => captureWorkingTree(context),
      infrastructure: options.infrastructure,
    })
    await controller.reconcile(input.project.id)
    const control = new ControlChannel({
      socketPath: controlSocket,
      handler: (request) => controller.handle(request),
    })
    const capabilities = new Map<string, ControlCapability>()
    const contexts = new Map<string, SessionContext>()

    await control.start()
    const adapter = createWorkspaceAdapter(options.provisioner ?? new FailingProvisioner(options.fence ?? NO_PUBLIC_FENCING_SEAM), config.openCodeVersion)
    input.experimental_workspace.register("exedev", adapter)

    const contextFor = (sessionId: string, cwd = input.directory): SessionContext => {
      const context = {
        sessionId,
        projectId: input.project.id,
        directory: cwd,
        worktree: input.worktree,
      }
      contexts.set(sessionId, context)
      controller.registerContext(context)
      return context
    }

    const capabilityFor = async (sessionId: string): Promise<ControlCapability> => {
      const next = await controller.capabilityFor(sessionId, "host")
      const previous = capabilities.get(sessionId)
      if (!previous || previous.generation !== next.generation) {
        if (previous) control.revoke(previous.token)
        control.register(next)
        capabilities.set(sessionId, next)
      }
      return capabilities.get(sessionId) ?? next
    }

    return {
      async dispose() {
        controller.dispose()
        contexts.clear()
        capabilities.clear()
        await control.close()
      },
      async event({ event }) {
        const value = asRecord(event)
        if (!value) return
        const properties = asRecord(value.properties)
        if (!properties) return
        if (value.type === "session.created" || value.type === "session.updated") {
          const info = asRecord(properties.info)
          if (info && typeof info.id === "string" && typeof info.directory === "string") contextFor(info.id, info.directory)
          return
        }
        if (value.type === "session.idle" && typeof properties.sessionID === "string") {
          contextFor(properties.sessionID)
          await controller.onSessionIdle(properties.sessionID)
        }
      },
      async "command.execute.before"({ command, sessionID }) {
        if (command === "exedev") {
          contextFor(sessionID)
          await capabilityFor(sessionID)
        }
      },
      async "shell.env"({ cwd, sessionID }, output) {
        if (!sessionID) return
        contextFor(sessionID, cwd)
        const capability = await capabilityFor(sessionID)
        output.env.EXEDEV_CONTROL_SOCKET = control.socketPath
        output.env.EXEDEV_CONTROL_TOKEN = capability.token
        output.env.EXEDEV_CONTROL_ROLE = "host"
      },
    }
  } catch (error) {
    log(redactError(error))
    return undefined
  }
}

function createWorkspaceAdapter(provisioner: WorkspaceProvisioner, version: string): WorkspaceAdapterLike {
  return {
    name: "exe.dev",
    description: `OpenCode workspace backed by an exe.dev VM (OpenCode ${version})`,
    configure(info) {
      const suffix = shortHash(info.id)
      return {
        ...info,
        name: `oc-${suffix}`,
        branch: info.branch ?? `opencode/exedev-${suffix}`,
        extra: nonSecretExtra(info.extra),
      }
    },
    create(info, env, from) {
      return provisioner.create(info, env, from)
    },
    remove(info) {
      return provisioner.remove(info)
    },
    target(info) {
      return provisioner.target(info)
    },
  }
}

class FailingProvisioner implements WorkspaceProvisioner {
  private readonly fence: TransitionFence

  constructor(fence: TransitionFence) {
    this.fence = fence
  }

  async create(): Promise<void> {
    throw new ExedevError("fencing", this.fence.reason ?? "exe.dev transitions are disabled", "FENCING_UNAVAILABLE")
  }

  async remove(): Promise<void> {
    throw new ExedevError("fencing", "exe.dev workspace removal is disabled until fencing is supported", "FENCING_UNAVAILABLE")
  }

  async target(): Promise<WorkspaceTarget> {
    throw new ExedevError("fencing", "exe.dev target is disabled until fencing is supported", "FENCING_UNAVAILABLE")
  }
}

function configFromEnvironment(env: Record<string, string | undefined>): unknown {
  const text = env.EXEDEV_CONFIG
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ExedevError("validate", "EXEDEV_CONFIG is not valid JSON", "CONFIG_JSON")
  }
}

function runtimeDirectory(env: Record<string, string | undefined>): string {
  const value = env.XDG_RUNTIME_DIR ?? env.TMPDIR ?? "/tmp"
  if (!value.startsWith("/")) throw new ExedevError("validate", "runtime directory must be absolute", "RUNTIME_DIRECTORY")
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
    if (/(?:password|token|secret|credential|auth)/i.test(key)) continue
    result[key] = stripSecrets(item)
  }
  return result
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
