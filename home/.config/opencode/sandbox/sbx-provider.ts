import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { connect, createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { dirname, isAbsolute, join, posix } from "node:path"

import { createIsolatedSandboxProvider, type IsolatedSandboxHandle } from "@ai-hero/sandcastle"

import { assertRelativePath, assertSafeBranch, assertSha, quoteRemoteCommandPart, sha256, shortHash } from "./naming"
import { assertAbsolutePath, basicAuthHeader, buildRemoteFrame, generateRemoteCredentials, makeRuntimePaths, reserveLocalPort, type RuntimePaths } from "./remote-runtime"
import { nodeProcessRunner, nodeProcessSupervisor, sanitizeEnvironment } from "./process"
import { redactError, redactText } from "./redaction"
import type { OpenCodeSandboxAdapter, SandcastleAdapterInput } from "./sandcastle-session"
import {
  isRecord,
  isNodeError,
  SandboxError,
  type SandboxStage,
  type ProcessHandle,
  type ProcessResult,
  type ProcessRunner,
  type ProcessSupervisor,
  type ProviderResourceObservation,
  type WorkspaceInfo,
  type WorkspaceProviderBase,
  type WorkspaceRuntimeMetadata,
  type WorkspaceSyncOutInput,
  type WorkspaceTarget,
  type WorkingTreeCapture,
} from "./types"

const SBX_BIN = "sbx"
const DEFAULT_SSH_BIN = "/usr/bin/ssh"
const DEFAULT_REMOTE_PORT = 4096
const DEFAULT_REMOTE_CONTROL_PORT = 9419
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000
const DEFAULT_OPENCODE_VERSION = "1.18.23"
const MAX_OUTPUT_BYTES = 256 * 1024
const MAX_FILE_OUTPUT_BYTES = 64 * 1024 * 1024
const MAX_HEALTH_RESPONSE_BYTES = 512 * 1024
const OWNERSHIP_FILE = "/tmp/opencode-sandbox-owner"
const INSPECTION_TIMEOUT_MS = 5_000
const START_SERVER = String.raw`import json, os, shutil, signal, subprocess, sys, time

frame = json.load(sys.stdin)
required = ("authContent", "password", "workspaceId", "directory", "port", "pidFile")
if any(key not in frame for key in required):
    raise SystemExit("incomplete server frame")

try:
    with open(frame["pidFile"], "r", encoding="ascii") as pid_file:
        old_pid = int(pid_file.read().strip())
    if old_pid > 1:
        with open(f"/proc/{old_pid}/cmdline", "rb") as command_line:
            if b"opencode" in command_line.read():
                os.kill(old_pid, signal.SIGTERM)
                for _ in range(20):
                    try:
                        os.kill(old_pid, 0)
                    except ProcessLookupError:
                        break
                    time.sleep(0.05)
except (FileNotFoundError, ProcessLookupError, ValueError):
    pass

command = shutil.which("opencode")
if command is None:
    raise SystemExit("opencode is not installed")
environment = os.environ.copy()
environment["OPENCODE_AUTH_CONTENT"] = frame["authContent"]
environment["OPENCODE_WORKSPACE_ID"] = frame["workspaceId"]
environment["OPENCODE_SERVER_USERNAME"] = "opencode"
environment["OPENCODE_SERVER_PASSWORD"] = frame["password"]
environment["OPENCODE_EXPERIMENTAL_WORKSPACES"] = "1"
process = subprocess.Popen(
    [command, "serve", "--hostname", "0.0.0.0", "--port", str(frame["port"])],
    cwd=frame["directory"],
    env=environment,
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    start_new_session=True,
)
with open(frame["pidFile"], "w", encoding="ascii") as pid_file:
    pid_file.write(str(process.pid))
`

const REMOTE_WRITE_PATH = String.raw`import os, sys

path = sys.argv[1]
if not path.startswith("/") or path != os.path.abspath(path) or path != os.path.realpath(path) or "\x00" in path:
    raise SystemExit("unsafe file path")
os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
fd = os.open(path, flags, 0o600)
with os.fdopen(fd, "wb") as output:
    output.write(sys.stdin.buffer.read())
`

const REMOTE_COPY_FILE = String.raw`import base64, os, sys

path = sys.argv[1]
if not path.startswith("/") or path != os.path.abspath(path) or path != os.path.realpath(path) or "\x00" in path:
    raise SystemExit("unsafe file path")
with open(path, "rb") as source:
    while True:
        chunk = source.read(1024 * 1024)
        if not chunk:
            break
        sys.stdout.write(base64.b64encode(chunk).decode("ascii"))
`

const REMOTE_LAUNCHER = String.raw`#!/usr/bin/env python3
import json, os, shutil, sys

def fail(message):
    print("remote launcher: " + message, file=sys.stderr)
    raise SystemExit(78)

try:
    frame = json.load(sys.stdin)
except Exception:
    fail("invalid startup frame")

if not isinstance(frame, dict) or frame.get("version") != 1 or frame.get("username") != "opencode":
    fail("unsupported startup frame")

required = ("workspaceId", "directory", "remotePort", "remoteControlPort", "remoteControlSocket", "remoteLauncherPath", "controlToken", "serverPassword", "authContent", "openCodeVersion")
if any(not frame.get(key) for key in required):
    fail("startup frame is incomplete")
if not isinstance(frame["remotePort"], int) or not 1 <= frame["remotePort"] <= 65535:
    fail("invalid remote port")
if not isinstance(frame["remoteControlPort"], int) or not 1 <= frame["remoteControlPort"] <= 65535:
    fail("invalid remote control port")
if any(not isinstance(frame[key], str) or not frame[key].startswith("/") or "\x00" in frame[key] or "\n" in frame[key] or "\r" in frame[key] for key in ("directory", "remoteControlSocket", "remoteLauncherPath")):
    fail("invalid runtime path")
try:
    json.loads(frame["authContent"])
except Exception:
    fail("invalid auth content")
try:
    os.chdir(frame["directory"])
except Exception:
    fail("remote checkout is unavailable")
runtime = os.path.dirname(frame["remoteLauncherPath"])
command = shutil.which("opencode")
if command is None:
    fail("opencode is not installed")

environment = os.environ.copy()
environment["PATH"] = os.path.join(runtime, "bin") + os.pathsep + environment.get("PATH", "")
environment["OPENCODE_AUTH_CONTENT"] = frame["authContent"]
environment["OPENCODE_WORKSPACE_ID"] = frame["workspaceId"]
environment["OPENCODE_SERVER_USERNAME"] = "opencode"
environment["OPENCODE_SERVER_PASSWORD"] = frame["serverPassword"]
environment["OPENCODE_EXPERIMENTAL_WORKSPACES"] = "1"
environment["OPENCODE_CONFIG_DIR"] = os.path.join(runtime, "config")
environment["SANDBOX_CONTROL_HOST"] = "127.0.0.1"
environment["SANDBOX_CONTROL_PORT"] = str(frame["remoteControlPort"])
environment["SANDBOX_CONTROL_TOKEN"] = frame["controlToken"]
environment["SANDBOX_CONTROL_ROLE"] = "remote"
os.execvpe(command, [command, "serve", "--hostname", "0.0.0.0", "--port", str(frame["remotePort"])], environment)
`

const WRITE_FILE = String.raw`import os, sys

root = os.path.realpath(sys.argv[1])
relative = sys.argv[2]
if not relative or os.path.isabs(relative) or "\x00" in relative or any(part in ("", ".", "..") for part in relative.split("/")):
    raise SystemExit("invalid relative path")
target = os.path.realpath(os.path.join(root, relative))
if os.path.commonpath((root, target)) != root:
    raise SystemExit("path escapes checkout")
os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
fd = os.open(target, flags, 0o600)
with os.fdopen(fd, "wb") as output:
    output.write(sys.stdin.buffer.read())
`

export interface SbxProviderOptions {
  worktree: string
  runner?: ProcessRunner
  supervisor?: ProcessSupervisor
  fetcher?: typeof fetch
  sbxBin?: string
  sshBin?: string
  remotePort?: number
  healthTimeoutMs?: number
  bootstrapTimeoutMs?: number
  reservePort?: () => Promise<number>
  openCodeVersion?: string
  localControlSocket?: string
  controlTokenFor?: (sessionId: string) => Promise<string>
  revokeControlToken?: (token: string) => void
  assetDirectory?: string
  deferActivation?: boolean
  writeOwnership?: (sandbox: string, ownershipId: string) => Promise<void>
  readOwnership?: (sandbox: string) => Promise<string | undefined>
}

interface SbxMetadata {
  sessionId: string
  generation: number
  workspaceId: string
  projectId: string
  sandbox?: string
  hostPort?: number
  branch?: string
  baseSha?: string
  ownershipId?: string
}

interface Activation {
  provider: "sbx"
  ownershipId: string
  sessionId: string
  generation: number
  workspaceId: string
  projectId: string
  sandbox: string
  directory: string
  branch: string
  baseSha: string
  hostPort: number
  password: string
  paths?: RuntimePaths
  controlToken?: string
  process?: ProcessHandle
  authContent?: string
  failure?: string
}

interface EnsuredSandbox {
  hostPort: number
  created: boolean
}

interface SbxOwner {
  provider: "sbx"
  ownershipId: string
  sessionId: string
  generation: number
  workspaceId: string
  projectId: string
}

export class SbxProvider implements WorkspaceProviderBase {
  readonly type = "sbx"
  readonly name = "Docker Sandbox"
  private readonly worktree: string
  private readonly runner: ProcessRunner
  private readonly supervisor: ProcessSupervisor
  private readonly fetcher: typeof fetch
  private readonly sbxBin: string
  private readonly sshBin: string
  private readonly remotePort: number
  private readonly healthTimeoutMs: number
  private readonly bootstrapTimeoutMs: number
  private readonly reservePort: () => Promise<number>
  private readonly openCodeVersion: string
  private readonly localControlSocket?: string
  private readonly controlTokenFor?: (sessionId: string) => Promise<string>
  private readonly revokeControlToken?: (token: string) => void
  private readonly assetDirectory: string
  private readonly deferActivation: boolean
  private readonly writeOwnershipOverride?: (sandbox: string, ownershipId: string) => Promise<void>
  private readonly readOwnershipOverride?: (sandbox: string) => Promise<string | undefined>
  private readonly active = new Map<string, Activation>()
  private readonly owned = new Map<string, SbxOwner>()
  private controlProxy: Server | undefined
  private controlProxyPort: number | undefined
  private controlProxyCreation: Promise<number> | undefined
  private controlProxyClosing: Promise<void> | undefined

  constructor(options: SbxProviderOptions) {
    this.worktree = options.worktree
    this.runner = options.runner ?? nodeProcessRunner
    this.supervisor = options.supervisor ?? nodeProcessSupervisor
    this.fetcher = options.fetcher ?? fetch
    this.sbxBin = options.sbxBin ?? SBX_BIN
    this.sshBin = options.sshBin ?? DEFAULT_SSH_BIN
    this.remotePort = options.remotePort ?? DEFAULT_REMOTE_PORT
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
    this.bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? 600_000
    this.reservePort = options.reservePort ?? reserveLocalPort
    this.openCodeVersion = options.openCodeVersion ?? DEFAULT_OPENCODE_VERSION
    this.localControlSocket = options.localControlSocket
    this.controlTokenFor = options.controlTokenFor
    this.revokeControlToken = options.revokeControlToken
    this.assetDirectory = options.assetDirectory ?? fileURLToPath(new URL(".", import.meta.url))
    this.deferActivation = options.deferActivation ?? false
    this.writeOwnershipOverride = options.writeOwnership
    this.readOwnershipOverride = options.readOwnership
  }

  get description(): string {
    return "OpenCode workspace backed by an isolated Docker Sandbox clone"
  }

  configure(info: WorkspaceInfo): WorkspaceInfo {
    const suffix = shortHash(info.id)
    return {
      ...info,
      name: `oc-sbx-${suffix}`,
      branch: info.branch ?? this.branch(info.id),
      directory: this.worktree,
    }
  }

  branch(workspaceId: string): string {
    return `opencode/sbx-${shortHash(workspaceId)}`
  }

  async prepare(info: WorkspaceInfo, env: Record<string, string | undefined>, from?: WorkspaceInfo): Promise<void> {
    const metadata = readMetadata(info, from)
    if (!metadata.ownershipId) {
      if (metadata.sandbox) throw ownershipError()
      metadata.ownershipId = randomBytes(32).toString("base64url")
    }
    if (metadata.sandbox && !metadata.hostPort) throw ownershipError()
    const active = this.active.get(info.id)
    if (active) {
      const expected = ownerFromMetadata(metadata)
      if (metadata.sandbox !== active.sandbox || !sameOwner(active, expected)) throw ownershipError()
      await this.assertOwned(active.sandbox, expected)
      return
    }
    const branch = info.branch ?? metadata.branch ?? this.branch(info.id)
    assertSafeBranch(branch)
    const baseSha = metadata.baseSha ?? (await this.hostGit(["rev-parse", "HEAD"], "checkout")).stdout.trim()
    assertSha(baseSha)
    if (!env.OPENCODE_AUTH_CONTENT) throw new SandboxError("bootstrap", "OpenCode auth content is unavailable", "AUTH_UNAVAILABLE")

    const sandbox = metadata.sandbox ?? `oc-sbx-${shortHash(info.id)}`
    assertSandboxName(sandbox)
    const rememberedPort = metadata.hostPort
    const requestedPort = rememberedPort ?? (await this.reservePort())
    const owner = ownerFromMetadata(metadata)
    const ensured = await this.ensureSandbox(sandbox, requestedPort, owner)
    let activation: Activation | undefined
    try {
      await this.configureManagedAuth(sandbox, env.OPENCODE_AUTH_CONTENT)
      const cloneRoot = await this.cloneDirectory(sandbox)
      assertAbsolutePath(cloneRoot, "sandbox checkout")
      await this.ensureOpenCodeVersion(sandbox)
      const directory = this.deferActivation ? join(cloneRoot, ".opencode-worktree") : cloneRoot
      assertSandboxPath(directory, "sandbox checkout")
      if (this.deferActivation) {
        await this.runSbx(["exec", sandbox, "mkdir", "-p", "--", directory], "provision")
      } else {
        await this.prepareCheckout(sandbox, directory, branch, baseSha)
      }

      const password = randomBytes(32).toString("base64url")
      activation = { ...owner, sandbox, directory, branch, baseSha, hostPort: ensured.hostPort, password }
      this.active.set(info.id, activation)
      if (this.controlTokenFor && this.localControlSocket) {
        activation.paths = makeRuntimePaths(metadata.sessionId, metadata.generation)
        activation.controlToken = await this.controlTokenFor(metadata.sessionId)
        activation.authContent = env.OPENCODE_AUTH_CONTENT
        if (!this.deferActivation) await this.activate(info.id)
      } else {
        await this.alignProjectIdentity(activation)
        await this.startServer(activation, env.OPENCODE_AUTH_CONTENT)
        await this.waitForHealth(activation)
      }
      info.directory = directory
      info.extra = {
        ...(isRecord(info.extra) ? info.extra : {}),
        providerState: metadataFor(activation),
      }
    } catch (error) {
      if (activation?.process) {
        activation.process.terminate()
        await waitForProcess(activation.process).catch(() => undefined)
      }
      if (activation?.controlToken) this.revokeControlToken?.(activation.controlToken)
      this.active.delete(info.id)
      const cleanup = await this.runSbxRaw(ensured.created ? ["rm", "--force", sandbox] : ["stop", sandbox], "remove").catch(() => undefined)
      if (ensured.created && cleanup?.exitCode === 0) this.owned.delete(sandbox)
      throw error instanceof SandboxError ? error : new SandboxError("bootstrap", redactError(error), "SBX_PROVISION")
    }
  }

  async syncIn(workspaceId: string, capture: WorkingTreeCapture): Promise<void> {
    const activation = this.active.get(workspaceId)
    if (!activation) throw new SandboxError("sync", "sandbox runtime is not active", "RUNTIME_UNAVAILABLE")
    if (capture.baseSha !== activation.baseSha) {
      throw new SandboxError("sync", "working tree capture does not match the sandbox checkout", "CAPTURE_SHA_MISMATCH")
    }
    if (capture.patch) {
      await this.runSbx(
        ["exec", "-i", activation.sandbox, "git", "-C", activation.directory, "apply", "--binary", "-"],
        "sync",
        capture.patch,
      )
    }
    for (const file of capture.untracked) {
      assertRelativePath(file.path)
      if (sha256(file.content) !== file.sha256) throw new SandboxError("sync", `working tree hash mismatch: ${file.path}`, "CAPTURE_HASH")
      await this.runSbx(
        ["exec", "-i", activation.sandbox, "python3", "-c", WRITE_FILE, activation.directory, file.path],
        "sync",
        file.content,
      )
    }
  }

  async syncOut(input: WorkspaceSyncOutInput): Promise<{ kind: "branch"; baseSha: string; branch: string }> {
    const activation = this.active.get(input.workspaceId)
    if (!activation) throw new SandboxError("sync", "sandbox runtime is not active", "RUNTIME_UNAVAILABLE")
    if (input.baseSha !== activation.baseSha) throw new SandboxError("sync", "workspace base revision changed", "WORKSPACE_BASE_SHA")

    const currentBranch = (await this.runSbx(["exec", activation.sandbox, "git", "-C", activation.directory, "symbolic-ref", "--short", "HEAD"], "sync")).stdout.trim()
    if (currentBranch !== activation.branch) throw new SandboxError("sync", "sandbox checkout is on an unexpected branch", "BRANCH_MISMATCH")
    await this.runSbx(["exec", activation.sandbox, "git", "-C", activation.directory, "add", "-A"], "sync")
    const staged = await this.runSbxRaw(["exec", activation.sandbox, "git", "-C", activation.directory, "diff", "--cached", "--quiet"], "sync")
    if (staged.exitCode === 1) await this.runSbx(["exec", activation.sandbox, "git", "-C", activation.directory, "commit", "-m", "opencode: sync sandbox workspace"], "sync")
    else if (staged.exitCode !== 0) throw new SandboxError("sync", redactText(staged.stderr || "could not inspect staged changes"), "GIT_COMMAND")

    const remote = `sandbox-${activation.sandbox}`
    const remoteCheck = await this.hostGitRaw(["remote", "get-url", remote], "sync")
    if (remoteCheck.exitCode !== 0) throw new SandboxError("sync", `Git remote ${remote} is unavailable`, "GIT_REMOTE_UNAVAILABLE")
    await this.hostGit([
      "fetch",
      "--no-tags",
      remote,
      `${activation.branch}:refs/remotes/${remote}/${activation.branch}`,
    ], "sync")
    return { kind: "branch", baseSha: activation.baseSha, branch: activation.branch }
  }

  async target(info: WorkspaceInfo): Promise<WorkspaceTarget> {
    const activation = this.active.get(info.id)
    if (!activation) throw new SandboxError("tunnel", "sandbox runtime is not active", "RUNTIME_UNAVAILABLE")
    this.assertActive(activation)
    return {
      type: "remote",
      url: `http://127.0.0.1:${activation.hostPort}`,
      headers: { Authorization: basicAuthHeader(activation.password) },
    }
  }

  runtimeMetadata(workspaceId: string): WorkspaceRuntimeMetadata | undefined {
    const activation = this.active.get(workspaceId)
    return activation ? { providerState: metadataFor(activation) } : undefined
  }

  async inspect(info: WorkspaceInfo): Promise<ProviderResourceObservation> {
    const metadata = readMetadata(info)
    const sandbox = metadata.sandbox
    if (!sandbox) throw new SandboxError("inspect", "sandbox identity is unavailable", "SBX_IDENTITY_UNAVAILABLE")
    const expected = ownerFromMetadata(metadata)
    const inventory = await this.runSbx(["ls", "--json"], "inspect", undefined, { timeoutMs: INSPECTION_TIMEOUT_MS })
    const items = parseSbxInventory(inventory.stdout).filter((candidate) => candidate.name === sandbox)
    const evidence = [`sbx inventory:${sandbox}`]
    if (items.length === 0) {
      return { resourceId: sandbox, resource: "absent", ownership: "unknown", health: "unknown", evidence }
    }
    if (items.length !== 1) {
      return { resourceId: sandbox, resource: "present", ownership: "conflict", health: "unknown", evidence: [...evidence, "sbx inventory is ambiguous"] }
    }
    const item = items[0]!

    const marker = this.readOwnershipOverride
      ? await this.readOwnershipOverride(sandbox)
      : await this.readOwnership(sandbox, INSPECTION_TIMEOUT_MS)
    evidence.push(`sbx owner marker:${sandbox}`)
    return {
      resourceId: sandbox,
      resource: "present",
      ownership: classifyOwnership(marker, this.owned.get(sandbox), expected),
      health: classifySbxHealth(item.status),
      evidence,
    }
  }

  async inventory(): Promise<ProviderResourceObservation[]> {
    const inventory = await this.runSbx(["ls", "--json"], "inspect", undefined, { timeoutMs: INSPECTION_TIMEOUT_MS })
    const items = parseSbxInventory(inventory.stdout)
    const names = new Map<string, number>()
    for (const item of items) names.set(item.name, (names.get(item.name) ?? 0) + 1)
    return items.map((item) => ({
      resourceId: item.name,
      resource: "present" as const,
      ownership: (names.get(item.name) ?? 0) > 1 ? "conflict" as const : "unknown" as const,
      health: (names.get(item.name) ?? 0) > 1 ? "unknown" as const : classifySbxHealth(item.status),
      evidence: [`sbx inventory:${item.name}`],
    }))
  }

  async release(info: WorkspaceInfo): Promise<void> {
    const activation = this.active.get(info.id)
    const metadata = readMetadata(info)
    const sandbox = activation?.sandbox ?? metadata.sandbox
    if (!sandbox) {
      if (this.active.size === 0) await this.closeControlProxy()
      throw new SandboxError("remove", "sandbox identity is unavailable", "SBX_IDENTITY_UNAVAILABLE")
    }
    const expected = ownerFromMetadata(metadata)
    if (activation && (metadata.sandbox !== activation.sandbox || !sameOwner(activation, expected))) throw ownershipError()
    await this.assertOwned(sandbox, expected)
    if (activation?.controlToken) this.revokeControlToken?.(activation.controlToken)
    if (activation?.process) {
      activation.process.terminate()
      await waitForProcess(activation.process)
    }
    try {
      await this.runSbx(["stop", sandbox], "detach")
    } finally {
      this.active.delete(info.id)
      if (this.active.size === 0) await this.closeControlProxy()
    }
  }

  async destroy(info: WorkspaceInfo): Promise<void> {
    const activation = this.active.get(info.id)
    const metadata = readMetadata(info)
    const sandbox = activation?.sandbox ?? metadata.sandbox
    if (!sandbox) {
      if (this.active.size === 0) await this.closeControlProxy()
      throw new SandboxError("remove", "sandbox identity is unavailable", "SBX_IDENTITY_UNAVAILABLE")
    }
    const expected = ownerFromMetadata(metadata)
    if (activation && (metadata.sandbox !== activation.sandbox || !sameOwner(activation, expected))) throw ownershipError()
    await this.assertOwned(sandbox, expected)
    if (activation?.controlToken) this.revokeControlToken?.(activation.controlToken)
    if (activation?.process) {
      activation.process.terminate()
      await waitForProcess(activation.process)
    }
    await this.runSbx(["stop", sandbox], "detach").catch(() => undefined)
    try {
      await this.runSbx(["rm", "--force", sandbox], "remove")
      this.owned.delete(sandbox)
    } finally {
      this.active.delete(info.id)
      if (this.active.size === 0) await this.closeControlProxy()
    }
  }

  async dispose(): Promise<void> {
    const activations = [...this.active.values()]
    for (const activation of activations) await this.assertOwned(activation.sandbox, activation)
    let failure: unknown
    try {
      const results = await Promise.allSettled(activations.map(async (activation) => {
        if (activation.controlToken) this.revokeControlToken?.(activation.controlToken)
        if (activation.process) {
          activation.process.terminate()
          await waitForProcess(activation.process).catch(() => undefined)
        }
        await this.runSbx(["stop", activation.sandbox], "detach")
        this.active.delete(activation.workspaceId)
        this.owned.delete(activation.sandbox)
      }))
      failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason
    } finally {
      if (this.active.size === 0) await this.closeControlProxy()
    }
    if (failure) throw failure
  }

  createIsolatedHandle(info: WorkspaceInfo): IsolatedSandboxHandle {
    const activation = this.active.get(info.id)
    if (!activation) throw new SandboxError("provision", "sandbox runtime is not active", "RUNTIME_UNAVAILABLE")

    let closing: Promise<void> | undefined
    return {
      worktreePath: activation.directory,
      exec: (command, options) => this.execute(activation, command, options),
      copyIn: (hostPath, sandboxPath) => this.copyIn(activation, hostPath, sandboxPath),
      copyFileOut: (sandboxPath, hostPath) => this.copyFileOut(activation, sandboxPath, hostPath),
      close: () => {
        closing ??= this.close(info)
        return closing
      },
    }
  }

  async close(info: WorkspaceInfo): Promise<void> {
    await this.destroy(info)
  }

  async activate(workspaceId: string): Promise<void> {
    const activation = this.active.get(workspaceId)
    if (!activation) throw new SandboxError("bootstrap", "sandbox runtime is not active", "RUNTIME_UNAVAILABLE")
    const process = activation.process
    if (process) return
    if (!activation.paths || !activation.controlToken || !activation.authContent) {
      throw new SandboxError("bootstrap", "SBX control runtime is unavailable", "CONTROL_CHANNEL")
    }
    try {
      await this.alignProjectIdentity(activation)
      await this.startControlledServer(activation)
      await this.waitForHealth(activation)
    } catch (error) {
      if (activation.process) {
        activation.process.terminate()
        await waitForProcess(activation.process).catch(() => undefined)
        activation.process = undefined
      }
      if (this.active.size === 1) await this.closeControlProxy()
      throw error
    }
  }

  private async ensureSandbox(sandbox: string, hostPort: number, owner: SbxOwner): Promise<EnsuredSandbox> {
    const create = await this.runSbxRaw(
      [
        "create",
        "--quiet",
        "--clone",
        "--name",
        sandbox,
        "--publish",
        `127.0.0.1:${hostPort}:${this.remotePort}/tcp`,
        "opencode",
        this.worktree,
      ],
      "provision",
    )
    if (create.exitCode === 0) {
      try {
        await this.writeOwnership(sandbox, owner)
      } catch (error) {
        await this.runSbxRaw(["rm", "--force", sandbox], "remove").catch(() => undefined)
        throw error
      }
      this.owned.set(sandbox, owner)
      return { hostPort, created: true }
    }

    await this.assertOwned(sandbox, owner)
    const started = await this.runSbxRaw(["exec", sandbox, "true"], "provision")
    if (started.exitCode !== 0) {
      throw new SandboxError("provision", redactText(create.stderr || started.stderr || "could not create sandbox"), "SBX_CREATE")
    }
    const existingPort = await this.publishedPort(sandbox)
    if (existingPort !== undefined) return { hostPort: existingPort, created: false }
    await this.runSbx(["ports", sandbox, "--publish", `127.0.0.1:${hostPort}:${this.remotePort}/tcp`], "tunnel")
    return { hostPort, created: false }
  }

  private async publishedPort(sandbox: string): Promise<number | undefined> {
    const result = await this.runSbx(["ports", sandbox, "--json"], "tunnel")
    const mapping = parsePortMappings(result.stdout).find((item) => item.sandboxPort === this.remotePort && isLoopback(item.hostIp))
    return mapping?.hostPort
  }

  private async assertOwned(sandbox: string, expected: SbxOwner): Promise<void> {
    const marker = this.readOwnershipOverride
      ? await this.readOwnershipOverride(sandbox)
      : await this.readOwnership(sandbox)
    const markerMatches = typeof marker === "string" ? marker === expected.ownershipId : sameOwner(marker, expected)
    if (!sameOwner(this.owned.get(sandbox), expected) || !markerMatches) {
      throw ownershipError()
    }
  }

  private async writeOwnership(sandbox: string, owner: SbxOwner): Promise<void> {
    if (this.writeOwnershipOverride) return this.writeOwnershipOverride(sandbox, owner.ownershipId)
    await this.runSbx(["exec", "-i", sandbox, "python3", "-c", REMOTE_WRITE_PATH, OWNERSHIP_FILE], "provision", `${JSON.stringify(owner)}\n`)
  }

  private async readOwnership(sandbox: string, timeoutMs?: number): Promise<string | SbxOwner | undefined> {
    const directory = await mkdtemp(join(tmpdir(), "opencode-sbx-owner-"))
    const path = join(directory, "owner")
    try {
      const result = await this.runSbxRaw(["cp", `${sandbox}:${OWNERSHIP_FILE}`, path], "validate", undefined, { timeoutMs })
      if (result.exitCode !== 0) return undefined
      return parseSbxOwner((await readFile(path, "utf8")).trim())
    } catch {
      return undefined
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  private async cloneDirectory(sandbox: string): Promise<string> {
    const result = await this.runSbx(["exec", sandbox, "git", "rev-parse", "--show-toplevel"], "checkout")
    const directory = result.stdout.trim()
    if (!directory || directory === "/run/sandbox/source" || directory.includes("\n")) {
      throw new SandboxError("checkout", "sandbox clone directory is unavailable", "SBX_CLONE_DIRECTORY")
    }
    return directory
  }

  private async ensureOpenCodeVersion(sandbox: string): Promise<void> {
    const version = await this.runSbxRaw(["exec", sandbox, "opencode", "--version"], "bootstrap")
    if (version.exitCode === 0 && version.stdout.trim() === this.openCodeVersion) return
    await this.runSbx(["exec", sandbox, "npm", "install", "--global", `opencode-ai@${this.openCodeVersion}`], "bootstrap")
    const installed = (await this.runSbx(["exec", sandbox, "opencode", "--version"], "bootstrap")).stdout.trim()
    if (installed !== this.openCodeVersion) {
      throw new SandboxError("bootstrap", "installed OpenCode version does not match configuration", "OPENCODE_VERSION")
    }
  }

  private async configureManagedAuth(sandbox: string, authContent: string): Promise<void> {
    const credential = openAiCredential(authContent)
    if (!credential) return
    await this.runSbx(["secret", "set", "openai", "--sandbox", sandbox, "--force"], "bootstrap", `${credential}\n`)
  }

  private async alignProjectIdentity(activation: Activation): Promise<void> {
    const remote = await this.hostGitRaw(["remote", "get-url", "origin"], "checkout")
    const identity = remote.exitCode === 0 ? canonicalGitRemote(remote.stdout) : undefined
    if (!identity) return
    await this.runSbx(["exec", activation.sandbox, "git", "-C", activation.directory, "remote", "set-url", "origin", identity], "checkout")
  }

  private async prepareCheckout(sandbox: string, directory: string, branch: string, baseSha: string): Promise<void> {
    const currentSha = (await this.runSbx(["exec", sandbox, "git", "-C", directory, "rev-parse", "HEAD"], "checkout")).stdout.trim()
    const currentBranch = (await this.runSbx(["exec", sandbox, "git", "-C", directory, "symbolic-ref", "--short", "HEAD"], "checkout")).stdout.trim()
    if (currentSha === baseSha && currentBranch === branch) return
    const dirty = await this.runSbxRaw(["exec", sandbox, "git", "-C", directory, "status", "--porcelain", "--untracked-files=all"], "checkout")
    if (dirty.exitCode !== 0) throw new SandboxError("checkout", redactText(dirty.stderr || "could not inspect sandbox checkout"), "GIT_COMMAND")
    if (dirty.stdout.trim()) throw new SandboxError("checkout", "existing sandbox checkout has uncommitted changes", "REMOTE_DIRTY")
    if (currentSha && currentSha !== baseSha) {
      throw new SandboxError("checkout", "existing sandbox checkout is at a different revision", "REMOTE_SHA_MISMATCH")
    }
    await this.runSbx(["exec", sandbox, "git", "-C", directory, "checkout", "-B", branch, baseSha], "checkout")
    const verified = (await this.runSbx(["exec", sandbox, "git", "-C", directory, "rev-parse", "HEAD"], "checkout")).stdout.trim()
    if (verified !== baseSha) throw new SandboxError("checkout", "sandbox checkout did not reach the requested SHA", "REMOTE_SHA_MISMATCH")
  }

  private async startServer(activation: Activation, authContent: string): Promise<void> {
    await this.runSbx(
      ["exec", "-i", activation.sandbox, "python3", "-c", START_SERVER],
      "bootstrap",
      JSON.stringify({
        authContent,
        password: activation.password,
        workspaceId: activation.workspaceId,
        directory: activation.directory,
        port: this.remotePort,
        pidFile: `/tmp/opencode-sbx-${shortHash(activation.workspaceId)}.pid`,
      }),
    )
  }

  private async startControlledServer(activation: Activation): Promise<void> {
    const localControlSocket = this.localControlSocket
    const paths = activation.paths
    const controlToken = activation.controlToken
    const authContent = activation.authContent
    if (!localControlSocket || !paths || !controlToken || !authContent) throw new SandboxError("control_channel", "SBX control transport is unavailable", "CONTROL_CHANNEL")
    const localControlPort = await this.ensureControlProxy()

    const assets = await this.assets()
    await this.runSbx(["exec", activation.sandbox, "mkdir", "-p", "--", paths.remoteDirectory, `${paths.remoteDirectory}/bin`, `${paths.remoteDirectory}/.config/opencode/sandbox`, `${paths.remoteDirectory}/config/command`], "bootstrap")
    await this.writeRemoteFile(activation, paths.remoteLauncherPath, REMOTE_LAUNCHER)
    await this.writeRemoteFile(activation, paths.remoteCliPath, assets.launcher)
    await this.writeRemoteFile(activation, `${paths.remoteDirectory}/.config/opencode/sandbox/cli.mjs`, assets.cli)
    await this.writeRemoteFile(activation, paths.remoteCommandPath, assets.command)
    await this.runSbx(["exec", activation.sandbox, "chmod", "700", "--", paths.remoteDirectory, `${paths.remoteDirectory}/bin`, `${paths.remoteDirectory}/.config`, `${paths.remoteDirectory}/.config/opencode`, `${paths.remoteDirectory}/.config/opencode/sandbox`, `${paths.remoteDirectory}/config`, `${paths.remoteDirectory}/config/command`, paths.remoteLauncherPath, paths.remoteCliPath], "bootstrap")
    await this.runSbx(["exec", activation.sandbox, "chmod", "600", "--", paths.remoteCommandPath, `${paths.remoteDirectory}/.config/opencode/sandbox/cli.mjs`], "bootstrap")

    const frame = buildRemoteFrame({
      workspaceId: activation.workspaceId,
      directory: activation.directory,
      remotePort: this.remotePort,
      remoteControlPort: DEFAULT_REMOTE_CONTROL_PORT,
      remoteControlSocket: paths.remoteControlSocket,
      remoteLauncherPath: paths.remoteLauncherPath,
      controlToken,
      serverPassword: activation.password,
      authContent,
      openCodeVersion: this.openCodeVersion,
    })
    activation.process = await this.supervisor.start({
      argv: buildSbxSupervisorArgv({
        sshBin: this.sshBin,
        sandbox: activation.sandbox,
        localControlPort,
        remoteControlPort: DEFAULT_REMOTE_CONTROL_PORT,
        remoteLauncherPath: paths.remoteLauncherPath,
      }),
      env: sanitizeEnvironment(),
      stdin: frame,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    })
    this.observeProcess(activation)
  }

  private async ensureControlProxy(): Promise<number> {
    if (this.controlProxyClosing) await this.controlProxyClosing
    if (this.controlProxyPort !== undefined) return this.controlProxyPort
    const creation = this.controlProxyCreation ?? this.createControlProxy()
    this.controlProxyCreation ??= creation
    try {
      const port = await creation
      if (this.controlProxyPort !== port) throw new SandboxError("control_channel", "control proxy was closed during initialization", "CONTROL_PROXY")
      return port
    } finally {
      if (this.controlProxyCreation === creation) this.controlProxyCreation = undefined
    }
  }

  private async createControlProxy(): Promise<number> {
    const localControlSocket = this.localControlSocket
    if (!localControlSocket) throw new SandboxError("control_channel", "local control socket is unavailable", "CONTROL_CHANNEL")

    const server = createServer((client) => {
      const target = connect({ path: localControlSocket })
      const close = () => {
        client.destroy()
        target.destroy()
      }
      client.pipe(target)
      target.pipe(client)
      client.once("error", close)
      target.once("error", close)
      client.once("close", () => target.destroy())
      target.once("close", () => client.destroy())
    })

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening)
          reject(error)
        }
        const onListening = () => {
          server.off("error", onError)
          resolve()
        }
        server.once("error", onError)
        server.once("listening", onListening)
        server.listen(0, "127.0.0.1")
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new SandboxError("control_channel", "control proxy port is unavailable", "CONTROL_PROXY")
      this.controlProxy = server
      this.controlProxyPort = address.port
      return address.port
    } catch (error) {
      await closeServer(server)
      if (error instanceof SandboxError) throw error
      throw new SandboxError("control_channel", redactError(error), "CONTROL_PROXY")
    }
  }

  private closeControlProxy(): Promise<void> {
    if (this.controlProxyClosing) return this.controlProxyClosing
    let closing!: Promise<void>
    closing = this.finishClosingControlProxy().finally(() => {
      if (this.controlProxyClosing === closing) this.controlProxyClosing = undefined
    })
    this.controlProxyClosing = closing
    return closing
  }

  private async finishClosingControlProxy(): Promise<void> {
    const creation = this.controlProxyCreation
    if (creation) await creation.catch(() => undefined)
    const server = this.controlProxy
    this.controlProxy = undefined
    this.controlProxyPort = undefined
    if (server) await closeServer(server)
  }

  private async assets(): Promise<{ cli: string; launcher: string; command: string }> {
    try {
      const [bundle, launcher, command] = await Promise.all([
        Bun.build({
          entrypoints: [join(this.assetDirectory, "cli.ts")],
          target: "node",
          format: "esm",
          write: false,
        } as Parameters<typeof Bun.build>[0] & { write: false }),
        readFile(join(this.assetDirectory, "../../../bin/sandboxctl"), "utf8"),
        readFile(join(this.assetDirectory, "../command/sandbox.md"), "utf8"),
      ])
      const output = bundle.outputs[0]
      if (!bundle.success || !output) throw new Error("could not bundle sandboxctl")
      return { cli: await output.text(), launcher, command }
    } catch (error) {
      throw new SandboxError("bootstrap", redactError(error), "ASSET_UNAVAILABLE")
    }
  }

  private async writeRemoteFile(activation: Activation, path: string, content: string): Promise<void> {
    assertSandboxPath(path, "remote asset path")
    await this.runSbx(["exec", "-i", activation.sandbox, "python3", "-c", REMOTE_WRITE_PATH, path], "bootstrap", content)
  }

  private async execute(
    activation: Activation,
    command: string,
    options?: { onLine?: (line: string) => void; cwd?: string; sudo?: boolean; stdin?: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.assertActive(activation)
    const cwd = options?.cwd ?? activation.directory
    assertSandboxPath(cwd, "sandbox working directory")
    const commandLine = `cd -- ${quoteRemoteCommandPart(cwd)} && ${command}`
    const commandArgs = options?.sudo
      ? ["exec", activation.sandbox, "sudo", "--", "sh", "-lc", commandLine]
      : ["exec", activation.sandbox, "sh", "-lc", commandLine]
    const result = await this.runSbxRaw(commandArgs, "exec", options?.stdin, {
      onLine: options?.onLine,
    })
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? -1,
    }
  }

  private async copyIn(activation: Activation, hostPath: string, sandboxPath: string): Promise<void> {
    this.assertActive(activation)
    if (!isAbsolute(hostPath)) throw new SandboxError("sync", "host copy path must be absolute", "PATH_INVALID")
    assertSandboxPath(sandboxPath, "sandbox copy path")
    const stats = await lstat(hostPath).catch((error: unknown) => {
      throw new SandboxError("sync", redactError(error), "COPY_IN")
    })
    if (stats.isSymbolicLink()) throw new SandboxError("sync", "symbolic links cannot be copied into the sandbox", "COPY_IN")
    if (stats.isDirectory()) {
      await this.runSbx(["exec", activation.sandbox, "mkdir", "-p", "--", sandboxPath], "sync")
      for (const entry of await readdir(hostPath, { withFileTypes: true })) {
        await this.copyIn(activation, join(hostPath, entry.name), posix.join(sandboxPath, entry.name))
      }
      return
    }
    if (!stats.isFile()) throw new SandboxError("sync", "only regular files can be copied into the sandbox", "COPY_IN")
    await this.runSbx(["exec", "-i", activation.sandbox, "python3", "-c", REMOTE_WRITE_PATH, sandboxPath], "sync", await readFile(hostPath))
  }

  private async copyFileOut(activation: Activation, sandboxPath: string, hostPath: string): Promise<void> {
    this.assertActive(activation)
    assertSandboxPath(sandboxPath, "sandbox copy path")
    if (!isAbsolute(hostPath)) throw new SandboxError("sync", "host copy path must be absolute", "PATH_INVALID")
    const result = await this.runSbxRaw(["exec", activation.sandbox, "python3", "-c", REMOTE_COPY_FILE, sandboxPath], "sync", undefined, {
      maxOutputBytes: MAX_FILE_OUTPUT_BYTES,
    })
    if (result.exitCode !== 0) throw new SandboxError("sync", redactText(result.stderr || "remote file copy failed"), "COPY_OUT")
    const encoded = result.stdout.replace(/\s/g, "")
    if ((encoded && encoded.length % 4 !== 0) || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw new SandboxError("sync", "remote file copy returned invalid data", "COPY_OUT")
    }
    await mkdir(dirname(hostPath), { recursive: true })
    try {
      const stats = await lstat(hostPath)
      if (stats.isSymbolicLink()) throw new SandboxError("sync", "refusing to replace a symbolic link", "COPY_OUT")
    } catch (error) {
      if (!(error instanceof SandboxError) && !isNodeError(error, "ENOENT")) throw error
      if (error instanceof SandboxError) throw error
    }
    await writeFile(hostPath, Buffer.from(encoded, "base64"), { mode: 0o600 })
  }

  private observeProcess(activation: Activation): void {
    if (!activation.process) return
    void activation.process.result
      .then((result) => {
        if (result.exitCode !== 0 || result.signal !== null) activation.failure = "SSH supervisor exited"
      })
      .catch((error) => {
        activation.failure = redactError(error)
      })
  }

  private assertActive(activation: Activation): void {
    if (activation.failure) throw new SandboxError("tunnel", activation.failure, "SUPERVISOR_EXITED")
  }

  private async waitForHealth(activation: Activation): Promise<void> {
    const url = `http://127.0.0.1:${activation.hostPort}/global/health`
    const deadline = Date.now() + this.healthTimeoutMs
    while (Date.now() < deadline) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 2_000)
      try {
        const response = await this.fetcher(url, {
          headers: { Authorization: basicAuthHeader(activation.password) },
          signal: controller.signal,
        })
        if (response.ok) {
          const value = await readHealthResponse(response).catch(() => undefined)
          if (isRecord(value) && value.healthy === true) return
        }
      } catch {
        // The published port may not be ready yet.
      } finally {
        clearTimeout(timeout)
      }
      await delay(250)
    }
    throw new SandboxError("remote_health", "sandbox OpenCode health check timed out", "REMOTE_HEALTH_TIMEOUT")
  }

  private async runSbx(args: string[], stage: SandboxStage, stdin?: string | Uint8Array, options: { onLine?: (line: string) => void; maxOutputBytes?: number; timeoutMs?: number } = {}): Promise<ProcessResult> {
    const result = await this.runSbxRaw(args, stage, stdin, options)
    if (result.exitCode !== 0) throw new SandboxError(stage, redactText(result.stderr || result.stdout || "sbx command failed"), "SBX_COMMAND")
    return result
  }

  private async runSbxRaw(args: string[], stage: SandboxStage, stdin?: string | Uint8Array, options: { onLine?: (line: string) => void; maxOutputBytes?: number; timeoutMs?: number } = {}): Promise<ProcessResult> {
    try {
      return await this.runner.run({
        argv: [this.sbxBin, ...args],
        env: sanitizeEnvironment(),
        stdin,
        onLine: options.onLine,
        timeoutMs: options.timeoutMs ?? this.bootstrapTimeoutMs,
        maxOutputBytes: options.maxOutputBytes ?? MAX_OUTPUT_BYTES,
      })
    } catch (error) {
      throw new SandboxError(stage, redactError(error), "SBX_COMMAND")
    }
  }

  private async hostGit(args: string[], stage: SandboxStage): Promise<ProcessResult> {
    const result = await this.hostGitRaw(args, stage)
    if (result.exitCode !== 0) throw new SandboxError(stage, redactText(result.stderr || result.stdout || "Git command failed"), "GIT_COMMAND")
    return result
  }

  private async hostGitRaw(args: string[], stage: SandboxStage): Promise<ProcessResult> {
    try {
      return await this.runner.run({
        argv: ["git", "-C", this.worktree, ...args],
        cwd: this.worktree,
        env: sanitizeEnvironment(),
        maxOutputBytes: 16 * 1024,
      })
    } catch (error) {
      throw new SandboxError(stage, redactError(error), "GIT_COMMAND")
    }
  }
}

async function readHealthResponse(response: Response): Promise<unknown> {
  if (!response.body) return undefined
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_HEALTH_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        return undefined
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks, size)))
  } catch {
    return undefined
  }
}

export interface SbxSandcastleAdapterOptions extends SbxProviderOptions {
  input: SandcastleAdapterInput
  authContent?: string
}

export function createSbxSandcastleAdapter(options: SbxSandcastleAdapterOptions): OpenCodeSandboxAdapter {
  const { input, authContent, ...providerOptions } = options
  const provider = new SbxProvider({ ...providerOptions, deferActivation: true })
  const info: WorkspaceInfo = {
    id: input.workspaceId,
    type: "sbx",
    name: `oc-sbx-${shortHash(input.workspaceId)}`,
    branch: input.branch,
    directory: input.context.worktree,
    projectID: input.projectId,
    extra: {
      sessionId: input.sessionId,
      generation: input.generation,
      baseSha: input.baseSha,
    },
  }
  const sandboxProvider = createIsolatedSandboxProvider({
    name: provider.name,
    env: authContent ? { OPENCODE_AUTH_CONTENT: authContent } : {},
    create: async ({ env }) => {
      const content = env.OPENCODE_AUTH_CONTENT ?? authContent
      if (!content) throw new SandboxError("bootstrap", "OpenCode auth content is unavailable", "AUTH_UNAVAILABLE")
      await provider.prepare(info, { OPENCODE_AUTH_CONTENT: content })
      return provider.createIsolatedHandle(info)
    },
  })

  return {
    provider: sandboxProvider,
    applyCapture: async ({ capture }) => {
      await provider.syncIn(input.workspaceId, capture)
      await provider.activate(input.workspaceId)
    },
    target: () => provider.target(info),
    inspect: () => provider.inspect(info),
    recoveryMetadata: () => provider.runtimeMetadata(input.workspaceId)?.providerState ?? {},
    close: () => provider.close(info),
  }
}

function readMetadata(info: WorkspaceInfo, from?: WorkspaceInfo): SbxMetadata {
  if (info.type !== "sbx") throw ownershipError()
  const value = isRecord(info.extra) ? info.extra : isRecord(from?.extra) ? from.extra : {}
  const state = isRecord(value.providerState) ? value.providerState : value
  const metadata: SbxMetadata = { sessionId: "", generation: 0, workspaceId: info.id, projectId: info.projectID }
  const field = (key: string): unknown => state[key] !== undefined ? state[key] : value[key]
  const provider = field("provider")
  if (provider !== undefined && provider !== "sbx") throw ownershipError()
  const sessionId = field("sessionId")
  if (sessionId !== undefined && typeof sessionId !== "string") {
    throw new SandboxError("validate", "sandbox session ID is invalid", "SESSION_ID")
  }
  if (typeof sessionId === "string") metadata.sessionId = sessionId
  if (!metadata.sessionId) throw ownershipError()
  const generation = field("generation")
  if (generation !== undefined && (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1)) {
    throw new SandboxError("validate", "sandbox generation is invalid", "GENERATION_INVALID")
  }
  if (typeof generation === "number") metadata.generation = generation
  if (metadata.generation < 1) throw ownershipError()
  const workspaceId = field("workspaceId")
  if (workspaceId !== undefined && workspaceId !== info.id) {
    throw new SandboxError("validate", "sandbox workspace ownership is invalid", "SBX_OWNERSHIP_UNVERIFIED")
  }
  const projectId = field("projectId")
  if (projectId !== undefined && projectId !== info.projectID) {
    throw new SandboxError("validate", "sandbox project ownership is invalid", "SBX_OWNERSHIP_UNVERIFIED")
  }
  const sandbox = field("sandbox")
  if (typeof sandbox === "string") {
    assertSandboxName(sandbox)
    metadata.sandbox = sandbox
  }
  const hostPort = field("hostPort")
  if (hostPort !== undefined) {
    if (typeof hostPort !== "number" || !Number.isSafeInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
      throw new SandboxError("validate", "sandbox host port is invalid", "PORT_INVALID")
    }
    metadata.hostPort = hostPort
  }
  const branch = field("branch")
  if (typeof branch === "string") {
    assertSafeBranch(branch)
    metadata.branch = branch
  }
  const baseSha = field("baseSha")
  if (typeof baseSha === "string") {
    assertSha(baseSha)
    metadata.baseSha = baseSha
  }
  const ownershipId = field("ownershipId")
  if (ownershipId !== undefined) {
    if (typeof ownershipId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(ownershipId)) throw ownershipError()
    metadata.ownershipId = ownershipId
  }
  return metadata
}

function metadataFor(activation: Activation): Record<string, unknown> {
  return {
    provider: activation.provider,
    sessionId: activation.sessionId,
    generation: activation.generation,
    workspaceId: activation.workspaceId,
    projectId: activation.projectId,
    sandbox: activation.sandbox,
    hostPort: activation.hostPort,
    branch: activation.branch,
    baseSha: activation.baseSha,
    ownershipId: activation.ownershipId,
  }
}

function ownerFromMetadata(metadata: SbxMetadata): SbxOwner {
  return {
    provider: "sbx",
    ownershipId: metadata.ownershipId ?? "",
    sessionId: metadata.sessionId,
    generation: metadata.generation,
    workspaceId: metadata.workspaceId,
    projectId: metadata.projectId,
  }
}

function sameOwner(actual: SbxOwner | undefined, expected: SbxOwner): boolean {
  return Boolean(
    actual &&
    actual.provider === expected.provider &&
    actual.ownershipId === expected.ownershipId &&
    actual.sessionId === expected.sessionId &&
    actual.generation === expected.generation &&
    actual.workspaceId === expected.workspaceId &&
    actual.projectId === expected.projectId
  )
}

function parseSbxOwner(value: string): string | SbxOwner | undefined {
  if (/^[A-Za-z0-9_-]{43}$/.test(value)) return value
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (
    !isRecord(parsed) ||
    parsed.provider !== "sbx" ||
    typeof parsed.ownershipId !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(parsed.ownershipId) ||
    typeof parsed.sessionId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(parsed.sessionId) ||
    typeof parsed.generation !== "number" ||
    !Number.isSafeInteger(parsed.generation) ||
    parsed.generation < 1 ||
    typeof parsed.workspaceId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(parsed.workspaceId) ||
    typeof parsed.projectId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(parsed.projectId)
  ) return undefined
  return {
    provider: "sbx",
    ownershipId: parsed.ownershipId,
    sessionId: parsed.sessionId,
    generation: parsed.generation,
    workspaceId: parsed.workspaceId,
    projectId: parsed.projectId,
  }
}

function classifyOwnership(marker: string | SbxOwner | undefined, local: SbxOwner | undefined, expected: SbxOwner): ProviderResourceObservation["ownership"] {
  if (!expected.ownershipId) return "unknown"
  if (typeof marker === "string") {
    if (marker !== expected.ownershipId) return "conflict"
    return sameOwner(local, expected) ? "verified" : "unknown"
  }
  if (!marker) return "unknown"
  return sameOwner(marker, expected) ? "verified" : "conflict"
}

interface SbxInventoryItem {
  name: string
  status?: string
}

function parseSbxInventory(value: string): SbxInventoryItem[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new SandboxError("inspect", "SBX inventory response is invalid", "SBX_INVENTORY_INVALID")
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.sandboxes)
      ? parsed.sandboxes
      : isRecord(parsed) && Array.isArray(parsed.items)
        ? parsed.items
        : undefined
  if (!entries) {
    throw new SandboxError("inspect", "SBX inventory response is invalid", "SBX_INVENTORY_INVALID")
  }
  return entries.map((item) => {
    if (!isRecord(item)) throw invalidSbxInventory()
    const name = typeof item.name === "string" ? item.name : typeof item.sandbox === "string" ? item.sandbox : undefined
    if (!name) throw invalidSbxInventory()
    try {
      assertSandboxName(name)
    } catch {
      throw invalidSbxInventory()
    }
    if (item.status !== undefined && typeof item.status !== "string") throw invalidSbxInventory()
    return { name, status: item.status }
  })
}

function invalidSbxInventory(): SandboxError {
  return new SandboxError("inspect", "SBX inventory response is invalid", "SBX_INVENTORY_INVALID")
}

function classifySbxHealth(status: string | undefined): ProviderResourceObservation["health"] {
  if (!status) return "unknown"
  return status.toLowerCase() === "running" ? "healthy" : "degraded"
}

function ownershipError(): SandboxError {
  return new SandboxError("validate", "SBX resource ownership could not be verified", "SBX_OWNERSHIP_UNVERIFIED")
}

function canonicalGitRemote(value: string): string | undefined {
  const remote = value.trim()
  try {
    const parsed = new URL(remote)
    if (parsed.protocol === "file:" || !parsed.hostname || !parsed.pathname) return undefined
    return `https://${parsed.hostname.toLowerCase()}/${parsed.pathname.replace(/^\/+/, "")}`
  } catch {
    const scp = remote.match(/^(?:[^@/:]+@)?([^@/:]+):(.+)$/)
    return scp ? `https://${scp[1]!.toLowerCase()}/${scp[2]!}` : undefined
  }
}

function openAiCredential(authContent: string): string | undefined {
  const auth = JSON.parse(authContent) as unknown
  if (!isRecord(auth) || !isRecord(auth.openai)) return undefined
  if (auth.openai.type === "oauth" && typeof auth.openai.access === "string") return auth.openai.access
  if (auth.openai.type === "api" && typeof auth.openai.key === "string") return auth.openai.key
  return undefined
}

function parsePortMappings(value: string): PortMapping[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return parsePortText(value)
  }
  const mappings: PortMapping[] = []
  collectPortMappings(parsed, mappings)
  return deduplicateMappings([...mappings, ...parsePortText(JSON.stringify(parsed))])
}

interface PortMapping {
  hostPort: number
  sandboxPort: number
  hostIp?: string
}

function collectPortMappings(value: unknown, mappings: PortMapping[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectPortMappings(entry, mappings))
    return
  }
  if (!isRecord(value)) return

  const hostPort = numberField(value, ["hostPort", "host_port", "HostPort"])
  const sandboxPort = numberField(value, ["sandboxPort", "sandbox_port", "containerPort", "container_port", "ContainerPort"])
  if (hostPort !== undefined && sandboxPort !== undefined) {
    mappings.push({ hostPort, sandboxPort, hostIp: stringField(value, ["hostIp", "host_ip", "HostIp"]) })
  }
  for (const entry of Object.values(value)) collectPortMappings(entry, mappings)
}

function parsePortText(value: string): PortMapping[] {
  const mappings: PortMapping[] = []
  const pattern = /(?:(127\.0\.0\.1|::1|0\.0\.0\.0):)?(\d+)->(\d+)\/(tcp|tcp4|tcp6)/g
  for (const match of value.matchAll(pattern)) {
    mappings.push({ hostIp: match[1], hostPort: Number(match[2]), sandboxPort: Number(match[3]) })
  }
  return mappings
}

function deduplicateMappings(mappings: PortMapping[]): PortMapping[] {
  const seen = new Set<string>()
  return mappings.filter((mapping) => {
    const key = `${mapping.hostIp ?? ""}:${mapping.hostPort}:${mapping.sandboxPort}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function numberField(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === "number" && Number.isSafeInteger(candidate)) return candidate
    if (typeof candidate === "string" && /^[0-9]+$/.test(candidate)) return Number(candidate)
  }
  return undefined
}

function stringField(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string") return value[key]
  }
  return undefined
}

function isLoopback(value: string | undefined): boolean {
  return value === undefined || value === "127.0.0.1" || value === "::1"
}

interface SbxSupervisorArgvInput {
  sshBin: string
  sandbox: string
  localControlPort: number
  remoteControlPort: number
  remoteLauncherPath: string
}

function buildSbxSupervisorArgv(input: SbxSupervisorArgvInput): string[] {
  assertSandboxName(input.sandbox)
  assertSandboxPath(input.remoteLauncherPath, "remote launcher")
  assertPort(input.localControlPort)
  assertPort(input.remoteControlPort)

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
    "IdentityAgent=none",
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
    "StreamLocalBindUnlink=yes",
    "-T",
    "-R",
    `127.0.0.1:${input.remoteControlPort}:127.0.0.1:${input.localControlPort}`,
    `${input.sandbox}.sbx`,
    input.remoteLauncherPath,
  ]
}

function assertSandboxPath(path: string, label: string): void {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(path) || path.includes("..")) {
    throw new SandboxError("validate", `${label} is unsafe`, "PATH_INVALID")
  }
}

function assertPort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new SandboxError("validate", "port is invalid", "PORT_INVALID")
  }
}

async function waitForProcess(process: ProcessHandle): Promise<void> {
  await Promise.race([process.result.catch(() => undefined), delay(3_000)])
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

function assertSandboxName(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{1,62}$/.test(value) || value === "default") {
    throw new SandboxError("validate", "sandbox name is unsafe", "SBX_NAME_INVALID")
  }
}
