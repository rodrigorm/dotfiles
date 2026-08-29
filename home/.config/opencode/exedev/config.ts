import { isAbsolute, join } from "node:path"

import { ExedevError, type ExedevConfig } from "./types"

export const DEFAULT_CONFIG = {
  baseVm: null,
  cpu: 2,
  memory: "8GB",
  remotePort: 4096,
  stateDirectory: "~/.local/state/opencode-exedev",
  sshLobby: "exe.dev",
  bootstrapTimeoutMs: 600_000,
  healthTimeoutMs: 30_000,
  openCodeVersion: "1.18.23",
} as const

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG))
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$/
const MEMORY = /^[1-9][0-9]{0,5}(?:[KMGTPE]B?)?$/i

export function parseConfig(
  input: unknown,
  env: Record<string, string | undefined> = process.env,
): ExedevConfig {
  if (!isRecord(input)) throw new ExedevError("validate", "exedev configuration must be an object", "CONFIG_TYPE")

  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new ExedevError("validate", `unknown configuration key: ${key}`, "CONFIG_KEY")
    }
  }

  const baseVm = input.baseVm === undefined ? DEFAULT_CONFIG.baseVm : input.baseVm
  if (baseVm !== null && (!isString(baseVm) || !IDENTIFIER.test(baseVm))) {
    throw new ExedevError("validate", "baseVm must be null or a safe VM identifier", "CONFIG_BASE_VM")
  }

  const cpu = input.cpu === undefined ? DEFAULT_CONFIG.cpu : input.cpu
  if (!isPositiveInteger(cpu) || cpu > 64) {
    throw new ExedevError("validate", "cpu must be an integer between 1 and 64", "CONFIG_CPU")
  }

  const memory = input.memory === undefined ? DEFAULT_CONFIG.memory : input.memory
  if (!isString(memory) || !MEMORY.test(memory)) {
    throw new ExedevError("validate", "memory must be a safe exe.dev memory size", "CONFIG_MEMORY")
  }

  const remotePort = input.remotePort === undefined ? DEFAULT_CONFIG.remotePort : input.remotePort
  if (!isPositiveInteger(remotePort) || remotePort > 65535) {
    throw new ExedevError("validate", "remotePort must be an integer between 1 and 65535", "CONFIG_PORT")
  }

  const home = env.HOME
  if (!home || !isAbsolute(home)) {
    throw new ExedevError("validate", "HOME must be an absolute directory", "CONFIG_HOME")
  }

  const stateDirectoryValue = input.stateDirectory === undefined ? DEFAULT_CONFIG.stateDirectory : input.stateDirectory
  if (!isString(stateDirectoryValue)) {
    throw new ExedevError("validate", "stateDirectory must be a path", "CONFIG_STATE_DIRECTORY")
  }
  const stateDirectory = expandHome(stateDirectoryValue, home)
  const knownHostsFile = expandHome(
    env.EXEDEV_KNOWN_HOSTS_FILE ?? join(stateDirectory, "known_hosts"),
    home,
  )
  if (!isAbsolute(knownHostsFile)) {
    throw new ExedevError("validate", "known hosts path must be absolute", "CONFIG_KNOWN_HOSTS")
  }

  const sshLobby = input.sshLobby === undefined ? DEFAULT_CONFIG.sshLobby : input.sshLobby
  if (!isString(sshLobby) || !HOSTNAME.test(sshLobby)) {
    throw new ExedevError("validate", "sshLobby must be a safe hostname", "CONFIG_SSH_LOBBY")
  }

  const bootstrapTimeoutMs = input.bootstrapTimeoutMs === undefined ? DEFAULT_CONFIG.bootstrapTimeoutMs : input.bootstrapTimeoutMs
  if (!isPositiveInteger(bootstrapTimeoutMs) || bootstrapTimeoutMs > 3_600_000) {
    throw new ExedevError("validate", "bootstrapTimeoutMs must be a positive timeout", "CONFIG_BOOTSTRAP_TIMEOUT")
  }

  const healthTimeoutMs = input.healthTimeoutMs === undefined ? DEFAULT_CONFIG.healthTimeoutMs : input.healthTimeoutMs
  if (!isPositiveInteger(healthTimeoutMs) || healthTimeoutMs > 600_000) {
    throw new ExedevError("validate", "healthTimeoutMs must be a positive timeout", "CONFIG_HEALTH_TIMEOUT")
  }

  return {
    baseVm,
    cpu,
    memory,
    remotePort,
    stateDirectory,
    knownHostsFile,
    sshLobby,
    bootstrapTimeoutMs,
    healthTimeoutMs,
    openCodeVersion: DEFAULT_CONFIG.openCodeVersion,
  }
}

export function experimentalWorkspacesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const explicit = env.OPENCODE_EXPERIMENTAL_WORKSPACES
  if (explicit !== undefined) return isTruthy(explicit)
  return isTruthy(env.OPENCODE_EXPERIMENTAL)
}

export function assertExperimentalWorkspacesEnabled(env: Record<string, string | undefined> = process.env): void {
  if (!experimentalWorkspacesEnabled(env)) {
    throw new ExedevError(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}
