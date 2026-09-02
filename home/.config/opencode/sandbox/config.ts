import { isAbsolute, join } from "node:path"

import { isRecord, SandboxError, type SandboxConfig, type WorkspaceProviderId } from "./types"

export const DEFAULT_CONFIG = {
  provider: "exedev",
  baseVm: null,
  cpu: 2,
  memory: "8GB",
  remotePort: 4096,
  stateDirectory: "~/.local/state/opencode-sandbox",
  sshLobby: "exe.dev",
  bootstrapTimeoutMs: 600_000,
  healthTimeoutMs: 30_000,
  openCodeVersion: "1.18.23",
} as const

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$/
const MEMORY = /^[1-9][0-9]{0,5}(?:[KMGTPE]B?)?$/i

export function parseConfig(
  input: unknown,
  env: Record<string, string | undefined> = process.env,
): SandboxConfig {
  if (!isRecord(input)) throw new SandboxError("validate", "sandbox configuration must be an object", "CONFIG_TYPE")

  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULT_CONFIG, key)) {
      throw new SandboxError("validate", `unknown configuration key: ${key}`, "CONFIG_KEY")
    }
  }

  const baseVm = input.baseVm === undefined ? DEFAULT_CONFIG.baseVm : input.baseVm
  if (baseVm !== null && (!isString(baseVm) || !IDENTIFIER.test(baseVm))) {
    throw new SandboxError("validate", "baseVm must be null or a safe VM identifier", "CONFIG_BASE_VM")
  }

  const provider = input.provider === undefined ? DEFAULT_CONFIG.provider : input.provider
  if (provider !== "exedev" && provider !== "sbx" && provider !== "cloudflare") {
    throw new SandboxError("validate", "provider must be exedev, sbx, or cloudflare", "CONFIG_PROVIDER")
  }

  const cpu = input.cpu === undefined ? DEFAULT_CONFIG.cpu : input.cpu
  if (!isPositiveInteger(cpu) || cpu > 64) {
    throw new SandboxError("validate", "cpu must be an integer between 1 and 64", "CONFIG_CPU")
  }

  const memory = input.memory === undefined ? DEFAULT_CONFIG.memory : input.memory
  if (!isString(memory) || !MEMORY.test(memory)) {
    throw new SandboxError("validate", "memory must be a safe exe.dev memory size", "CONFIG_MEMORY")
  }

  const remotePort = input.remotePort === undefined ? DEFAULT_CONFIG.remotePort : input.remotePort
  if (!isPositiveInteger(remotePort) || remotePort > 65535) {
    throw new SandboxError("validate", "remotePort must be an integer between 1 and 65535", "CONFIG_PORT")
  }

  const home = env.HOME
  if (!home || !isAbsolute(home)) {
    throw new SandboxError("validate", "HOME must be an absolute directory", "CONFIG_HOME")
  }

  const stateDirectoryValue = input.stateDirectory === undefined ? DEFAULT_CONFIG.stateDirectory : input.stateDirectory
  if (!isString(stateDirectoryValue)) {
    throw new SandboxError("validate", "stateDirectory must be a path", "CONFIG_STATE_DIRECTORY")
  }
  const stateDirectory = expandHome(stateDirectoryValue, home)
  const knownHostsFile = expandHome(
    env.SANDBOX_KNOWN_HOSTS_FILE ?? join(stateDirectory, "known_hosts"),
    home,
  )
  if (!isAbsolute(knownHostsFile)) {
    throw new SandboxError("validate", "known hosts path must be absolute", "CONFIG_KNOWN_HOSTS")
  }

  const sshLobby = input.sshLobby === undefined ? DEFAULT_CONFIG.sshLobby : input.sshLobby
  if (!isString(sshLobby) || !HOSTNAME.test(sshLobby)) {
    throw new SandboxError("validate", "sshLobby must be a safe hostname", "CONFIG_SSH_LOBBY")
  }

  const bootstrapTimeoutMs = input.bootstrapTimeoutMs === undefined ? DEFAULT_CONFIG.bootstrapTimeoutMs : input.bootstrapTimeoutMs
  if (!isPositiveInteger(bootstrapTimeoutMs) || bootstrapTimeoutMs > 3_600_000) {
    throw new SandboxError("validate", "bootstrapTimeoutMs must be a positive timeout", "CONFIG_BOOTSTRAP_TIMEOUT")
  }

  const healthTimeoutMs = input.healthTimeoutMs === undefined ? DEFAULT_CONFIG.healthTimeoutMs : input.healthTimeoutMs
  if (!isPositiveInteger(healthTimeoutMs) || healthTimeoutMs > 600_000) {
    throw new SandboxError("validate", "healthTimeoutMs must be a positive timeout", "CONFIG_HEALTH_TIMEOUT")
  }

  const openCodeVersion = input.openCodeVersion === undefined ? DEFAULT_CONFIG.openCodeVersion : input.openCodeVersion
  if (!isString(openCodeVersion) || !/^[A-Za-z0-9._-]+$/.test(openCodeVersion)) {
    throw new SandboxError("validate", "openCodeVersion is invalid", "CONFIG_OPENCODE_VERSION")
  }

  return {
    provider: provider as WorkspaceProviderId,
    baseVm,
    cpu,
    memory,
    remotePort,
    stateDirectory,
    knownHostsFile,
    sshLobby,
    bootstrapTimeoutMs,
    healthTimeoutMs,
    openCodeVersion,
  }
}

export function experimentalWorkspacesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const explicit = env.OPENCODE_EXPERIMENTAL_WORKSPACES
  if (explicit !== undefined) return isTruthy(explicit)
  return isTruthy(env.OPENCODE_EXPERIMENTAL)
}

export function assertExperimentalWorkspacesEnabled(env: Record<string, string | undefined> = process.env): void {
  if (!experimentalWorkspacesEnabled(env)) {
    throw new SandboxError(
      "validate",
      "OpenCode experimental workspaces are disabled; set OPENCODE_EXPERIMENTAL_WORKSPACES=1 and restart OpenCode",
      "WORKSPACES_DISABLED",
    )
  }
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home
  if (value.startsWith("~/")) return join(home, value.slice(2))
  return value
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true"
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}
