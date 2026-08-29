import { createHash, randomBytes } from "node:crypto"

import { assertPrivateSocket } from "./secure-fs"
import { ExedevError } from "./types"
import { assertSafeSshDestination } from "./naming"

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
    throw new ExedevError("validate", "SSH user is unsafe", "SSH_USER_INVALID")
  }
  assertAbsolutePath(input.localControlSocket, "local control socket")
  assertAbsolutePath(input.remoteControlSocket, "remote control socket")
  assertAbsolutePath(input.remoteLauncherPath, "remote launcher")
  assertPort(input.remotePort)
  assertPort(input.localPort)

  return [
    input.sshBin,
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${input.knownHostsFile}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
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

export function buildHostProbeArgv(input: Pick<SupervisorArgvInput, "sshBin" | "knownHostsFile" | "destination" | "sshUser">): string[] {
  assertSafeSshDestination(input.destination)
  if (input.sshUser !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(input.sshUser)) {
    throw new ExedevError("validate", "SSH user is unsafe", "SSH_USER_INVALID")
  }
  return [
    input.sshBin,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${input.knownHostsFile}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    "-T",
    ...(input.sshUser && !input.destination.includes("@") ? ["-l", input.sshUser] : []),
    input.destination,
    "true",
  ]
}

export interface RuntimePaths {
  remoteDirectory: string
  remoteControlSocket: string
  remoteLauncherPath: string
  remoteCliPath: string
  remoteCommandPath: string
}

export function makeRuntimePaths(sessionId: string, generation: number, random: () => string = () => randomBytes(12).toString("hex")): RuntimePaths {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) throw new ExedevError("validate", "session ID is unsafe", "SESSION_ID")
  if (!Number.isSafeInteger(generation) || generation < 1) throw new ExedevError("validate", "generation is invalid", "GENERATION_INVALID")
  const entropy = random()
  if (!/^[a-f0-9]{8,64}$/i.test(entropy)) throw new ExedevError("validate", "runtime entropy is invalid", "RUNTIME_ENTROPY")
  const suffix = createHash("sha256").update(`${sessionId}:${generation}:${entropy}`).digest("hex").slice(0, 12)
  const remoteDirectory = `/tmp/oe-${suffix}`
  return {
    remoteDirectory,
    remoteControlSocket: `${remoteDirectory}/c.sock`,
    remoteLauncherPath: `${remoteDirectory}/launcher`,
    remoteCliPath: `${remoteDirectory}/exedevctl`,
    remoteCommandPath: `${remoteDirectory}/commands/exedev.md`,
  }
}

export interface RemoteFrameInput {
  generation: number
  directory: string
  branch: string
  baseSha: string
  remotePort: number
  remoteControlSocket: string
  remoteLauncherPath: string
  remoteCliPath: string
  remoteCommandPath: string
  controlToken: string
  serverPassword: string
  authContent: string
  openCodeVersion: string
}

export interface RemoteFrame extends RemoteFrameInput {
  version: 1
  username: "opencode"
}

export function buildRemoteFrame(input: RemoteFrameInput, maxBytes = 128 * 1024): { frame: RemoteFrame; serialized: string } {
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new ExedevError("validate", "generation is invalid", "FRAME_GENERATION")
  assertAbsolutePath(input.directory, "remote directory")
  assertAbsolutePath(input.remoteControlSocket, "remote control socket")
  assertAbsolutePath(input.remoteLauncherPath, "remote launcher")
  assertAbsolutePath(input.remoteCliPath, "remote CLI")
  assertAbsolutePath(input.remoteCommandPath, "remote command")
  assertPort(input.remotePort)
  if (!input.controlToken || !input.serverPassword || !input.openCodeVersion) {
    throw new ExedevError("validate", "remote frame credentials are incomplete", "FRAME_CREDENTIALS")
  }
  const frame: RemoteFrame = { ...input, version: 1, username: "opencode" }
  const serialized = `${JSON.stringify(frame)}\n`
  if (Buffer.byteLength(serialized) > maxBytes) throw new ExedevError("validate", "remote frame is too large", "FRAME_LIMIT")
  return { frame, serialized }
}

export function generateRemoteCredentials(): { controlToken: string; serverPassword: string } {
  return {
    controlToken: randomBytes(32).toString("base64url"),
    serverPassword: randomBytes(32).toString("base64url"),
  }
}

export function basicAuthHeader(password: string, username = "opencode"): string {
  if (!password || !/^[A-Za-z0-9._~-]{1,256}$/.test(username)) throw new ExedevError("validate", "Basic Auth credentials are invalid", "BASIC_AUTH")
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export async function validateLocalControlSocket(path: string): Promise<void> {
  await assertPrivateSocket(path)
}

function assertAbsolutePath(path: string, label: string): void {
  if (!path.startsWith("/") || path.includes("\0") || path.includes("\n") || path.includes("\r")) {
    throw new ExedevError("validate", `${label} path is unsafe`, "PATH_INVALID")
  }
}

function assertPort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new ExedevError("validate", "port is invalid", "PORT_INVALID")
}
