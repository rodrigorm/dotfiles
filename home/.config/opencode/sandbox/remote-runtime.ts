import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:net"

import { SandboxError } from "./types"
import { assertSafeSshDestination, quoteRemoteCommandPart } from "./naming"

export const DEFAULT_SSH_BIN = "/usr/bin/ssh"

export interface SupervisorArgvInput {
  sshBin: string
  knownHostsFile: string
  destination: string
  sshUser?: string
  remotePort: number
  localPort: number
  localControlSocket: string
  remoteControlSocket: string
  remoteLauncherPath: string
}

export function buildSupervisorArgv(input: SupervisorArgvInput): string[] {
  assertSafeSshDestination(input.destination)
  if (input.sshUser !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(input.sshUser)) {
    throw new SandboxError("validate", "SSH user is unsafe", "SSH_USER_INVALID")
  }
  assertAbsolutePath(input.localControlSocket, "local control socket")
  assertAbsolutePath(input.remoteControlSocket, "remote control socket")
  assertAbsolutePath(input.remoteLauncherPath, "remote launcher")
  assertPort(input.remotePort)
  assertPort(input.localPort)

  return [
    input.sshBin,
    ...fixedSshOptions(input.knownHostsFile),
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "StreamLocalBindUnlink=yes",
    "-T",
    "-L",
    `127.0.0.1:${input.localPort}:127.0.0.1:${input.remotePort}`,
    "-R",
    `${input.remoteControlSocket}:${input.localControlSocket}`,
    ...(input.sshUser && !input.destination.includes("@") ? ["-l", input.sshUser] : []),
    input.destination,
    input.remoteLauncherPath,
  ]
}

export function buildRemoteCommandArgv(
  input: Pick<SupervisorArgvInput, "sshBin" | "knownHostsFile" | "destination" | "sshUser">,
  command: readonly string[],
): string[] {
  assertSafeSshDestination(input.destination)
  if (input.sshUser !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(input.sshUser)) {
    throw new SandboxError("validate", "SSH user is unsafe", "SSH_USER_INVALID")
  }
  if (command.length === 0 || command.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new SandboxError("validate", "remote command is incomplete", "REMOTE_COMMAND_INVALID")
  }

  return [
    input.sshBin,
    ...fixedSshOptions(input.knownHostsFile),
    "-T",
    ...(input.sshUser && !input.destination.includes("@") ? ["-l", input.sshUser] : []),
    input.destination,
    ...command.map(quoteRemoteCommandPart),
  ]
}

export interface RuntimePaths {
  remoteDirectory: string
  remoteControlSocket: string
  remoteLauncherPath: string
  remoteCliPath: string
  remoteCommandPath: string
  remoteWriteFilePath: string
}

export function makeRuntimePaths(sessionId: string, generation: number, random: () => string = () => randomBytes(12).toString("hex")): RuntimePaths {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) throw new SandboxError("validate", "session ID is unsafe", "SESSION_ID")
  if (!Number.isSafeInteger(generation) || generation < 1) throw new SandboxError("validate", "generation is invalid", "GENERATION_INVALID")
  const entropy = random()
  if (!/^[a-f0-9]{8,64}$/i.test(entropy)) throw new SandboxError("validate", "runtime entropy is invalid", "RUNTIME_ENTROPY")
  const suffix = createHash("sha256").update(`${sessionId}:${generation}:${entropy}`).digest("hex").slice(0, 12)
  const remoteDirectory = `/tmp/oe-${suffix}`
  return {
    remoteDirectory,
    remoteControlSocket: `${remoteDirectory}/c.sock`,
    remoteLauncherPath: `${remoteDirectory}/launcher`,
    remoteCliPath: `${remoteDirectory}/bin/sandboxctl`,
    remoteCommandPath: `${remoteDirectory}/config/command/sandbox.md`,
    remoteWriteFilePath: `${remoteDirectory}/write-file`,
  }
}

export interface RemoteFrameInput {
  workspaceId: string
  directory: string
  remotePort: number
  remoteControlPort?: number
  remoteControlSocket: string
  remoteLauncherPath: string
  controlToken: string
  serverPassword: string
  authContent: string
  openCodeVersion: string
}

export function buildRemoteFrame(input: RemoteFrameInput, maxBytes = 128 * 1024): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.workspaceId)) throw new SandboxError("validate", "workspace ID is invalid", "WORKSPACE_ID")
  assertAbsolutePath(input.directory, "remote directory")
  assertAbsolutePath(input.remoteControlSocket, "remote control socket")
  assertAbsolutePath(input.remoteLauncherPath, "remote launcher")
  assertPort(input.remotePort)
  if (!input.controlToken || !input.serverPassword || !input.openCodeVersion) {
    throw new SandboxError("validate", "remote frame credentials are incomplete", "FRAME_CREDENTIALS")
  }
  if (input.remoteControlPort !== undefined) assertPort(input.remoteControlPort)
  const serialized = `${JSON.stringify({ ...input, version: 1, username: "opencode" })}\n`
  if (Buffer.byteLength(serialized) > maxBytes) throw new SandboxError("validate", "remote frame is too large", "FRAME_LIMIT")
  return serialized
}

export function generateRemoteCredentials(): { controlToken: string; serverPassword: string } {
  return {
    controlToken: randomBytes(32).toString("base64url"),
    serverPassword: randomBytes(32).toString("base64url"),
  }
}

export function basicAuthHeader(password: string, username = "opencode"): string {
  if (!password || !/^[A-Za-z0-9._~-]{1,256}$/.test(username)) throw new SandboxError("validate", "Basic Auth credentials are invalid", "BASIC_AUTH")
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function assertAbsolutePath(path: string, label: string): void {
  if (!path.startsWith("/") || path.includes("\0") || path.includes("\n") || path.includes("\r")) {
    throw new SandboxError("validate", `${label} path is unsafe`, "PATH_INVALID")
  }
}

function assertPort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new SandboxError("validate", "port is invalid", "PORT_INVALID")
}

export function fixedSshOptions(knownHostsFile: string): string[] {
  return [
    "-F",
    "/dev/null",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHostsFile}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "ForwardAgent=no",
    "-o",
    "IdentityAgent=none",
    "-o",
    "ProxyCommand=none",
    "-o",
    "ProxyJump=none",
    "-o",
    "SendEnv=none",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "RemoteCommand=none",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "UpdateHostkeys=no",
    "-o",
    "ClearAllForwardings=yes",
  ]
}

export async function reserveLocalPort(): Promise<number> {
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === "string" || address.port < 1) throw new SandboxError("tunnel", "could not reserve a local port", "PORT_RESERVATION")
    return address.port
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined)
  }
}
