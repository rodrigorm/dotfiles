import { randomBytes } from "node:crypto"
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, posix } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

import { createIsolatedSandboxProvider, type IsolatedSandboxHandle } from "@ai-hero/sandcastle"

import type { ExeControl } from "./exe-control"
import { buildRemoteCommandArgv, buildSupervisorArgv, DEFAULT_SSH_BIN, makeRuntimePaths, reserveLocalPort, type RuntimePaths } from "./remote-runtime"
import { basicAuthHeader, buildRemoteFrame, generateRemoteCredentials } from "./remote-runtime"
import { assertPrivateFile, ensurePrivateDirectory } from "./secure-fs"
import { nodeProcessRunner, nodeProcessSupervisor, sanitizeEnvironment } from "./process"
import { assertRelativePath, assertSafeBranch, assertSafeComment, assertSafeSshDestination, assertSafeTag, assertSafeVmName, assertSha, identityMatches, makeVmPlan, quoteRemoteCommandPart, sha256, shortHash } from "./naming"
import { redactError, redactText } from "./redaction"
import type { OpenCodeSandboxAdapter, SandcastleAdapterInput } from "./sandcastle-session"
import {
  copyVmIdentity,
  isNodeError,
  isRecord,
  SandboxError,
  type SandboxConfig,
  type ProcessHandle,
  type ProcessResult,
  type ProcessRunner,
  type ProcessSupervisor,
  type VmIdentity,
  type VmInfo,
  type WorkspaceInfo,
  type WorkspaceProviderBase,
  type WorkspaceRuntimeMetadata,
  type WorkspaceTarget,
  type WorkingTreeCapture,
} from "./types"

const EXEDEV_HOST_FINGERPRINT = "SHA256:JJOP/lwiBGOMilfONPWZCXUrfK154cnJFXcqlsi6lPo"
const BUN_VERSION = "1.3.14"
const MAX_REMOTE_OUTPUT_BYTES = 256 * 1024
const MAX_FILE_OUTPUT_BYTES = 64 * 1024 * 1024
const SSH_KEYGEN_BIN = "/usr/bin/ssh-keygen"
const SSH_KEYSCAN_BIN = "/usr/bin/ssh-keyscan"
const REMOTE_WRITE_FILE = String.raw`#!/usr/bin/env python3
import base64, os, sys

root = os.path.realpath(sys.argv[1])
if root != os.path.abspath(sys.argv[1]):
    raise SystemExit("runtime directory is a symlink")
relative = base64.urlsafe_b64decode(sys.argv[2] + "=" * (-len(sys.argv[2]) % 4)).decode("utf-8")
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
const REMOTE_SEED_FILE = String.raw`import os, sys

path = sys.argv[1]
if path != os.path.abspath(path) or path != os.path.realpath(path) or not hasattr(os, "O_NOFOLLOW"):
    raise SystemExit("unsafe runtime path")
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700)
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
const REMOTE_LAUNCHER = String.raw`#!/usr/bin/env python3
import json, os, shutil, socket, stat, sys

def fail(message):
    print("remote launcher: " + message, file=sys.stderr)
    raise SystemExit(78)

try:
    frame = json.load(sys.stdin)
except Exception:
    fail("invalid startup frame")

if not isinstance(frame, dict) or frame.get("version") != 1 or frame.get("username") != "opencode":
    fail("unsupported startup frame")

required = ("workspaceId", "directory", "remotePort", "remoteControlSocket", "remoteLauncherPath", "controlToken", "serverPassword", "authContent", "openCodeVersion")
if any(not frame.get(key) for key in required):
    fail("startup frame is incomplete")
if not isinstance(frame["remotePort"], int) or not 1 <= frame["remotePort"] <= 65535:
    fail("invalid remote port")
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
try:
    socket_info = os.stat(frame["remoteControlSocket"])
    if not stat.S_ISSOCK(socket_info.st_mode) or socket_info.st_uid != os.getuid() or socket_info.st_mode & 0o077:
        fail("remote control path is not a socket")
except OSError:
    fail("remote control socket is unavailable")

runtime = os.path.dirname(frame["remoteLauncherPath"])
bun = shutil.which("bun")
if bun is None:
    fail("bun is not installed")
command = shutil.which("opencode")
if command is None:
    fail("opencode is not installed")

environment = os.environ.copy()
environment["PATH"] = os.path.join(runtime, "bin") + os.pathsep + os.path.dirname(bun) + os.pathsep + environment.get("PATH", "")
environment["OPENCODE_AUTH_CONTENT"] = frame["authContent"]
environment["OPENCODE_WORKSPACE_ID"] = frame["workspaceId"]
environment["OPENCODE_SERVER_USERNAME"] = "opencode"
environment["OPENCODE_SERVER_PASSWORD"] = frame["serverPassword"]
environment["OPENCODE_EXPERIMENTAL_WORKSPACES"] = "1"
environment["OPENCODE_CONFIG_DIR"] = os.path.join(runtime, "config")
environment["SANDBOX_CONTROL_SOCKET"] = frame["remoteControlSocket"]
environment["SANDBOX_CONTROL_TOKEN"] = frame["controlToken"]
environment["SANDBOX_CONTROL_ROLE"] = "remote"
os.execvpe(command, [command, "serve", "--hostname", "127.0.0.1", "--port", str(frame["remotePort"])], environment)
`

const REMOTE_BOOTSTRAP = (version: string) => String.raw`set -eu
command -v git >/dev/null
command -v python3 >/dev/null

if ! command -v bun >/dev/null; then
    command -v npm >/dev/null || { printf '%s\n' 'bun and npm are unavailable' >&2; exit 1; }
    npm install --global bun@${BUN_VERSION}
fi

if ! command -v opencode >/dev/null; then
    bun install --global opencode-ai@${version}
fi

test "$(bun --version 2>/dev/null)" = "${BUN_VERSION}"
test "$(opencode --version 2>/dev/null)" = "${version}"
`

export interface ExedevProviderOptions {
  config: SandboxConfig
  control: ExeControl
  worktree: string
  localControlSocket: string
  runner?: ProcessRunner
  supervisor?: ProcessSupervisor
  fetcher?: typeof fetch
  reservePort?: () => Promise<number>
  ensureHostKey?: () => Promise<void>
  ensureVmHostKey?: (identity: VmIdentity) => Promise<void>
  controlTokenFor?: (sessionId: string) => Promise<string>
  revokeControlToken?: (token: string) => void
  assetDirectory?: string
  deferActivation?: boolean
}

export interface ExedevSandcastleAdapterOptions extends ExedevProviderOptions {
  input: SandcastleAdapterInput
  authContent?: string
}

interface WorkspaceMetadata {
  sessionId: string
  generation: number
  baseSha?: string
  tags?: string[]
  comment?: string
  vmIdentity?: VmIdentity
  remoteDirectory?: string
}

interface Activation {
  workspaceId: string
  vm: VmInfo
  paths: RuntimePaths
  directory: string
  baseSha: string
  localPort: number
  password: string
  controlToken: string
  process?: ProcessHandle
  authContent?: string
  failure?: string
}

interface ProvisionedVm {
  vm: VmInfo
  created: boolean
}

export class ExedevProvider implements WorkspaceProviderBase {
  readonly type = "exedev"
  readonly name = "exe.dev"
  private readonly config: SandboxConfig
  private readonly control: ExeControl
  private readonly worktree: string
  private readonly localControlSocket: string
  private readonly runner: ProcessRunner
  private readonly supervisor: ProcessSupervisor
  private readonly fetcher: typeof fetch
  private readonly reservePort: () => Promise<number>
  private readonly ensureHostKey: () => Promise<void>
  private readonly ensureVmHostKey: (identity: VmIdentity) => Promise<void>
  private readonly controlTokenFor?: (sessionId: string) => Promise<string>
  private readonly revokeControlToken?: (token: string) => void
  private readonly assetDirectory: string
  private readonly deferActivation: boolean
  private readonly active = new Map<string, Activation>()

  constructor(options: ExedevProviderOptions) {
    this.config = options.config
    this.control = options.control
    this.worktree = options.worktree
    this.localControlSocket = options.localControlSocket
    this.runner = options.runner ?? nodeProcessRunner
    this.supervisor = options.supervisor ?? nodeProcessSupervisor
    this.fetcher = options.fetcher ?? fetch
    this.reservePort = options.reservePort ?? reserveLocalPort
    this.ensureHostKey = options.ensureHostKey ?? (() => ensureExeDevHostKey(this.config.knownHostsFile, this.config.sshLobby, this.runner))
    this.ensureVmHostKey = options.ensureVmHostKey ?? ((identity) => ensureExeDevVmHostKey(this.config.knownHostsFile, identity, this.runner))
    this.controlTokenFor = options.controlTokenFor
    this.revokeControlToken = options.revokeControlToken
    this.assetDirectory = options.assetDirectory ?? fileURLToPath(new URL(".", import.meta.url))
    this.deferActivation = options.deferActivation ?? false
    this.deferActivation = options.deferActivation ?? false
  }

  get description(): string {
    return `OpenCode workspace backed by an exe.dev VM (OpenCode ${this.config.openCodeVersion})`
  }

  configure(info: WorkspaceInfo): WorkspaceInfo {
    const suffix = shortHash(info.id)
    return {
      ...info,
      name: `oc-${suffix}`,
      branch: info.branch ?? `opencode/sandbox-${suffix}`,
      directory: info.directory ?? remoteWorkspaceDirectory(info.id),
    }
  }

  branch(workspaceId: string): string {
    return `opencode/sandbox-${shortHash(workspaceId)}`
  }

  async prepare(info: WorkspaceInfo, env: Record<string, string | undefined>, from?: WorkspaceInfo): Promise<void> {
    if (this.active.has(info.id)) return

    const metadata = readWorkspaceMetadata(info, from)
    const generation = metadata.generation
    const branch = info.branch
    if (!branch) throw new SandboxError("validate", "workspace branch is missing", "BRANCH_MISSING")
    assertSafeBranch(branch)

    const expectedDirectory = remoteWorkspaceDirectory(info.id)
    const directory = info.directory ?? expectedDirectory
    if (directory !== expectedDirectory) throw new SandboxError("validate", "workspace directory is not plugin-owned", "WORKSPACE_DIRECTORY")
    assertRemotePath(directory, "workspace directory")
    const [remoteUrl, localSha] = await Promise.all([this.readRemoteUrl(), this.readHead()])
    const baseSha = metadata.baseSha ?? localSha
    if (baseSha !== localSha) throw new SandboxError("checkout", "workspace SHA changed during provisioning", "GIT_HEAD_CHANGED")
    assertSha(baseSha)
    if (!env.OPENCODE_AUTH_CONTENT) throw new SandboxError("bootstrap", "OpenCode auth content is unavailable", "AUTH_UNAVAILABLE")

    await this.ensureHostKey()
    const paths = makeRuntimePaths(metadata.sessionId, generation)
    const localPort = await this.reservePort()
    const provisioned = await this.provisionVm(info, metadata)
    const vm = provisioned.vm

    try {
      await this.ensureVmHostKey(vm.identity)
      await this.bootstrap(vm.identity, paths, directory, remoteUrl, baseSha, branch)
      const credentials = generateRemoteCredentials()
      if (!this.controlTokenFor) {
        throw new SandboxError("control_channel", "remote capability factory is unavailable", "CONTROL_CAPABILITY")
      }
      const controlToken = await this.controlTokenFor(metadata.sessionId)
      const activation: Activation = {
        workspaceId: info.id,
        vm,
        paths,
        directory,
        baseSha,
        localPort,
        password: credentials.serverPassword,
        controlToken,
        authContent: env.OPENCODE_AUTH_CONTENT,
      }
      this.active.set(info.id, activation)
      info.extra = {
        ...(isRecord(info.extra) ? info.extra : {}),
        vmName: vm.identity.name,
        vmIdentity: copyVmIdentity(vm.identity),
      }
      if (!this.deferActivation) await this.activate(info.id)
    } catch (error) {
      const activation = this.active.get(info.id)
      if (activation?.process) {
        activation.process.terminate()
        await waitForProcess(activation.process).catch(() => undefined)
      }
      if (activation) this.revokeControlToken?.(activation.controlToken)
      this.active.delete(info.id)
      if (provisioned.created) await this.control.remove(vm.identity).catch(() => undefined)
      if (error instanceof SandboxError) throw error
      throw new SandboxError("bootstrap", redactError(error), "PROVISION_FAILED")
    }
  }

  async activate(workspaceId: string): Promise<void> {
    const activation = this.active.get(workspaceId)
    if (!activation) throw new SandboxError("bootstrap", "workspace runtime is not active", "RUNTIME_UNAVAILABLE")
    if (activation.process) return
    if (!activation.authContent) throw new SandboxError("bootstrap", "OpenCode auth content is unavailable", "AUTH_UNAVAILABLE")

    const frame = buildRemoteFrame({
      workspaceId: activation.workspaceId,
      directory: activation.directory,
      remotePort: this.config.remotePort,
      remoteControlSocket: activation.paths.remoteControlSocket,
      remoteLauncherPath: activation.paths.remoteLauncherPath,
      controlToken: activation.controlToken,
      serverPassword: activation.password,
      authContent: activation.authContent,
      openCodeVersion: this.config.openCodeVersion,
    })
    try {
      activation.process = await this.supervisor.start({
        argv: buildSupervisorArgv({
          sshBin: DEFAULT_SSH_BIN,
          knownHostsFile: this.config.knownHostsFile,
          destination: activation.vm.identity.sshDest,
          sshUser: activation.vm.identity.sshUser,
          remotePort: this.config.remotePort,
          localPort: activation.localPort,
          localControlSocket: this.localControlSocket,
          remoteControlSocket: activation.paths.remoteControlSocket,
          remoteLauncherPath: activation.paths.remoteLauncherPath,
        }),
        env: sanitizeEnvironment(),
        stdin: frame,
        maxOutputBytes: MAX_REMOTE_OUTPUT_BYTES,
      })
      this.observeProcess(activation)
      await this.waitForHealth(activation)
    } catch (error) {
      if (activation.process) {
        activation.process.terminate()
        await waitForProcess(activation.process).catch(() => undefined)
        activation.process = undefined
      }
      throw error
    }
  }

  async syncIn(workspaceId: string, capture: WorkingTreeCapture): Promise<void> {
    const activation = this.active.get(workspaceId)
    if (!activation) throw new SandboxError("sync", "workspace runtime is not active", "RUNTIME_UNAVAILABLE")
    this.assertActive(activation)
    if (capture.baseSha !== activation.baseSha) {
      throw new SandboxError("sync", "working tree capture does not match the remote checkout", "CAPTURE_SHA_MISMATCH")
    }
    if (capture.patch) {
      await this.remote(activation.vm.identity, ["git", "-C", activation.directory, "apply", "--binary", "-"], capture.patch, "sync")
    }
    for (const file of capture.untracked) {
      if (sha256(file.content) !== file.sha256) throw new SandboxError("sync", `working tree hash mismatch: ${file.path}`, "CAPTURE_HASH")
      assertRelativePath(file.path)
      await this.remote(
        activation.vm.identity,
        [activation.paths.remoteWriteFilePath, encodePath(activation.directory), encodePath(file.path)],
        file.content,
        "sync",
      )
    }
  }

  async target(info: WorkspaceInfo): Promise<WorkspaceTarget> {
    const activation = this.active.get(info.id)
    if (!activation) throw new SandboxError("tunnel", "workspace runtime is not active", "RUNTIME_UNAVAILABLE")
    this.assertActive(activation)
    return {
      type: "remote",
      url: `http://127.0.0.1:${activation.localPort}`,
      headers: { Authorization: basicAuthHeader(activation.password) },
    }
  }

  runtimeMetadata(workspaceId: string): WorkspaceRuntimeMetadata | undefined {
    const activation = this.active.get(workspaceId)
    if (!activation) return undefined
    return {
      providerState: { remoteDirectory: activation.paths.remoteDirectory },
      vmName: activation.vm.identity.name,
      vmIdentity: copyVmIdentity(activation.vm.identity),
    }
  }

  async release(info: WorkspaceInfo): Promise<void> {
    const activation = this.active.get(info.id)
    if (!activation) {
      const metadata = readWorkspaceMetadata(info)
      if (!metadata.vmIdentity || !metadata.remoteDirectory) return
      await this.remote(metadata.vmIdentity, ["rm", "-rf", "--", metadata.remoteDirectory], undefined, "detach")
      return
    }
    this.revokeControlToken?.(activation.controlToken)
    if (activation.process) {
      activation.process.terminate()
      await waitForProcess(activation.process)
    }
    await this.remote(activation.vm.identity, ["rm", "-rf", "--", activation.paths.remoteDirectory], undefined, "detach")
    this.active.delete(info.id)
  }

  async destroy(info: WorkspaceInfo): Promise<void> {
    const metadata = readWorkspaceMetadata(info)
    if (!metadata.vmIdentity || metadata.vmIdentity.sshDest === "pending") {
        throw new SandboxError("remove", "workspace VM identity is unavailable", "VM_IDENTITY_UNAVAILABLE")
    }
    await this.control.remove(metadata.vmIdentity)
    this.active.delete(info.id)
  }

  async dispose(): Promise<void> {
    const activations = [...this.active.values()]
    const results = await Promise.allSettled(
      activations.map(async (activation) => {
        this.revokeControlToken?.(activation.controlToken)
        if (activation.process) {
          activation.process.terminate()
          await waitForProcess(activation.process)
        }
        await this.remote(activation.vm.identity, ["rm", "-rf", "--", activation.paths.remoteDirectory], undefined, "detach")
        this.active.delete(activation.workspaceId)
      }),
    )
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
    if (failure) throw failure.reason
  }

  createIsolatedHandle(info: WorkspaceInfo): IsolatedSandboxHandle {
    const activation = this.active.get(info.id)
    if (!activation) throw new SandboxError("provision", "workspace runtime is not active", "RUNTIME_UNAVAILABLE")

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
    let failure: unknown
    try {
      await this.release(info)
    } catch (error) {
      failure = error
    }
    try {
      await this.destroy(info)
      this.active.delete(info.id)
      return
    } catch (error) {
      failure ??= error
    }
    throw failure
  }

  private async execute(
    activation: Activation,
    command: string,
    options?: { onLine?: (line: string) => void; cwd?: string; sudo?: boolean; stdin?: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.assertActive(activation)
    const cwd = options?.cwd ?? activation.directory
    assertRemotePath(cwd, "sandbox working directory")
    const commandLine = `cd -- ${quoteRemoteCommandPart(cwd)} && ${command}`
    const remoteCommand = options?.sudo ? ["sudo", "--", "sh", "-lc", commandLine] : ["sh", "-lc", commandLine]
    const result = await this.remoteResult(activation.vm.identity, remoteCommand, options?.stdin, "exec", {
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
    assertRemotePath(sandboxPath, "sandbox copy path")
    const stats = await lstat(hostPath).catch((error: unknown) => {
      throw new SandboxError("sync", redactError(error), "COPY_IN")
    })
    if (stats.isSymbolicLink()) throw new SandboxError("sync", "symbolic links cannot be copied into the sandbox", "COPY_IN")
    if (stats.isDirectory()) {
      await this.remote(activation.vm.identity, ["mkdir", "-p", "--", sandboxPath], undefined, "sync")
      for (const entry of await readdir(hostPath, { withFileTypes: true })) {
        await this.copyIn(activation, join(hostPath, entry.name), posix.join(sandboxPath, entry.name))
      }
      return
    }
    if (!stats.isFile()) throw new SandboxError("sync", "only regular files can be copied into the sandbox", "COPY_IN")
    const content = await readFile(hostPath)
    await this.remote(activation.vm.identity, ["python3", "-c", REMOTE_WRITE_PATH, sandboxPath], content, "sync")
  }

  private async copyFileOut(activation: Activation, sandboxPath: string, hostPath: string): Promise<void> {
    this.assertActive(activation)
    assertRemotePath(sandboxPath, "sandbox copy path")
    if (!isAbsolute(hostPath)) throw new SandboxError("sync", "host copy path must be absolute", "PATH_INVALID")
    const result = await this.remoteResult(activation.vm.identity, ["python3", "-c", REMOTE_COPY_FILE, sandboxPath], undefined, "sync", {
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
      if (!isNodeError(error, "ENOENT")) throw error
    }
    await writeFile(hostPath, Buffer.from(encoded, "base64"), { mode: 0o600 })
  }

  private async provisionVm(info: WorkspaceInfo, metadata: WorkspaceMetadata): Promise<ProvisionedVm> {
    const plan = makeVmPlan({ workspaceId: info.id, projectId: info.projectID, generation: metadata.generation })
    const tags = metadata.tags ?? plan.tags
    const comment = metadata.comment ?? plan.comment
    tags.forEach(assertSafeTag)
    assertSafeVmName(info.name)
    assertSafeComment(comment)

    const expected = metadata.vmIdentity
    if (expected && expected.sshDest !== "pending") {
      assertSafeVmName(expected.name)
      assertSafeSshDestination(expected.sshDest)
      expected.tags.forEach(assertSafeTag)
      const matches = (await this.control.list()).filter((item) => identityMatches(expected, item.identity))
      if (matches.length !== 1) throw new SandboxError("discover", "known VM identity did not match exactly one VM", "VM_IDENTITY_MISMATCH")
      const vm = matches[0]
      if (this.control.replaceTags) await this.control.replaceTags(vm.identity, tags)
      else if (tags.length > 0) await this.control.tag(vm.identity.name, tags)
      if (this.control.comment) await this.control.comment(vm.identity.name, comment)
      return {
        vm: {
          ...vm,
          identity: { ...vm.identity, tags: [...tags], comment },
        },
        created: false,
      }
    }

    if (this.config.baseVm) {
      return {
        vm: await this.control.copy({
          baseVm: this.config.baseVm,
          name: info.name,
          cpu: this.config.cpu,
          memory: this.config.memory,
          tags,
          comment,
        }),
        created: true,
      }
    }
    return {
      vm: await this.control.create({
        name: info.name,
        cpu: this.config.cpu,
        memory: this.config.memory,
        tags,
        comment,
      }),
      created: true,
    }
  }

  private async bootstrap(vm: VmIdentity, paths: RuntimePaths, directory: string, remoteUrl: string, baseSha: string, branch: string): Promise<void> {
    await this.remote(vm, ["/bin/sh", "-s"], REMOTE_BOOTSTRAP(this.config.openCodeVersion), "bootstrap")
    const assets = await this.assets()
    await this.remote(vm, ["mkdir", "-p", "--", paths.remoteDirectory, `${paths.remoteDirectory}/bin`, `${paths.remoteDirectory}/.config/opencode/sandbox`, `${paths.remoteDirectory}/config/command`, posix.dirname(directory)], undefined, "bootstrap")
    await this.seedRemoteFile(vm, paths.remoteWriteFilePath, REMOTE_WRITE_FILE)
    await this.writeRemoteFile(vm, paths.remoteWriteFilePath, paths.remoteDirectory, paths.remoteLauncherPath, REMOTE_LAUNCHER)
    await this.writeRemoteFile(vm, paths.remoteWriteFilePath, paths.remoteDirectory, paths.remoteCliPath, assets.launcher)
    await this.writeRemoteFile(vm, paths.remoteWriteFilePath, paths.remoteDirectory, `${paths.remoteDirectory}/.config/opencode/sandbox/cli.ts`, assets.cli)
    await this.writeRemoteFile(vm, paths.remoteWriteFilePath, paths.remoteDirectory, `${paths.remoteDirectory}/.config/opencode/sandbox/redaction.ts`, assets.redaction)
    await this.writeRemoteFile(vm, paths.remoteWriteFilePath, paths.remoteDirectory, `${paths.remoteDirectory}/.config/opencode/sandbox/types.ts`, assets.types)
    await this.writeRemoteFile(vm, paths.remoteWriteFilePath, paths.remoteDirectory, paths.remoteCommandPath, assets.command)
    await this.remote(vm, ["chmod", "700", paths.remoteDirectory, `${paths.remoteDirectory}/bin`, `${paths.remoteDirectory}/.config`, `${paths.remoteDirectory}/.config/opencode`, `${paths.remoteDirectory}/.config/opencode/sandbox`, `${paths.remoteDirectory}/config`, `${paths.remoteDirectory}/config/command`, posix.dirname(directory)], undefined, "bootstrap")
    await this.remote(vm, ["chmod", "700", paths.remoteLauncherPath, paths.remoteCliPath, paths.remoteWriteFilePath], undefined, "bootstrap")
    await this.remote(vm, ["chmod", "600", paths.remoteCommandPath, `${paths.remoteDirectory}/.config/opencode/sandbox/cli.ts`, `${paths.remoteDirectory}/.config/opencode/sandbox/redaction.ts`, `${paths.remoteDirectory}/.config/opencode/sandbox/types.ts`], undefined, "bootstrap")
    await this.prepareCheckout(vm, directory, remoteUrl, baseSha, branch)
    await this.remote(vm, ["chmod", "700", directory], undefined, "bootstrap")
  }

  private async prepareCheckout(vm: VmIdentity, directory: string, remoteUrl: string, baseSha: string, branch: string): Promise<void> {
    const existing = await this.remoteResult(vm, ["test", "-d", directory], undefined, "checkout")
    if (existing.exitCode !== 0) {
      await this.remote(vm, ["git", "clone", "--no-checkout", "--", remoteUrl, directory], undefined, "checkout")
    } else {
      const symlink = await this.remoteResult(vm, ["test", "-L", directory], undefined, "checkout")
      if (symlink.exitCode === 0) throw new SandboxError("checkout", "existing workspace directory is a symlink", "REMOTE_DIR_UNSAFE")
      const currentRemote = (await this.remote(vm, ["git", "-C", directory, "remote", "get-url", "origin"], undefined, "checkout")).stdout.trim()
      if (currentRemote !== remoteUrl) throw new SandboxError("checkout", "existing remote does not match the local project", "REMOTE_MISMATCH")
    }

    const currentSha = (await this.remoteResult(vm, ["git", "-C", directory, "rev-parse", "HEAD"], undefined, "checkout")).stdout.trim()
    const currentBranch = (await this.remoteResult(vm, ["git", "-C", directory, "symbolic-ref", "--short", "HEAD"], undefined, "checkout")).stdout.trim()
    if (currentSha === baseSha && currentBranch === branch) return

    const dirty = await this.remoteResult(vm, ["git", "-C", directory, "status", "--porcelain", "--untracked-files=all"], undefined, "checkout")
    if (dirty.exitCode === 0 && dirty.stdout.trim()) throw new SandboxError("checkout", "existing remote checkout has uncommitted changes", "REMOTE_DIRTY")
    if (currentSha && currentSha !== baseSha) {
      throw new SandboxError("checkout", "existing remote checkout is at a different revision", "REMOTE_SHA_MISMATCH")
    }
    await this.remote(vm, ["git", "-C", directory, "fetch", "--no-tags", "origin", baseSha], undefined, "checkout")
    await this.remote(vm, ["git", "-C", directory, "checkout", "-B", branch, baseSha], undefined, "checkout")
    const verifiedSha = (await this.remote(vm, ["git", "-C", directory, "rev-parse", "HEAD"], undefined, "checkout")).stdout.trim()
    if (verifiedSha !== baseSha) throw new SandboxError("checkout", "remote checkout did not reach the requested SHA", "REMOTE_SHA_MISMATCH")
  }

  private async waitForHealth(activation: Activation): Promise<void> {
    const url = `http://127.0.0.1:${activation.localPort}/global/health`
    const deadline = Date.now() + this.config.healthTimeoutMs
    while (Date.now() < deadline) {
      this.assertActive(activation)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 2_000)
      try {
        const response = await this.fetcher(url, {
          headers: { Authorization: basicAuthHeader(activation.password) },
          signal: controller.signal,
        })
        if (response.ok) {
          const value = await response.json().catch(() => undefined)
          if (isRecord(value) && value.healthy === true && value.version === this.config.openCodeVersion) return
        }
      } catch {
        // The listener may not be ready yet.
      } finally {
        clearTimeout(timeout)
      }
      await delay(250)
    }
    throw new SandboxError("remote_health", "remote OpenCode health check timed out", "REMOTE_HEALTH_TIMEOUT")
  }

  private observeProcess(activation: Activation): void {
    const process = activation.process
    if (!process) return
    void process.result
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

  private async readHead(): Promise<string> {
    return this.localGit(["rev-parse", "HEAD"])
  }

  private async readRemoteUrl(): Promise<string> {
    return normalizePublicRemote(await this.localGit(["remote", "get-url", "origin"]))
  }

  private async localGit(args: string[]): Promise<string> {
    const result = await this.runner.run({ argv: ["git", "-C", this.worktree, ...args], cwd: this.worktree, maxOutputBytes: 4096 })
    if (result.exitCode !== 0) throw new SandboxError("git_preflight", "local Git command failed", "GIT_COMMAND")
    return result.stdout.trim()
  }

  private async assets(): Promise<{ cli: string; redaction: string; types: string; launcher: string; command: string }> {
    try {
      const [cli, redaction, types, launcher, command] = await Promise.all([
        readFile(join(this.assetDirectory, "cli.ts"), "utf8"),
        readFile(join(this.assetDirectory, "redaction.ts"), "utf8"),
        readFile(join(this.assetDirectory, "types.ts"), "utf8"),
        readFile(join(this.assetDirectory, "../../../bin/sandboxctl"), "utf8"),
        readFile(join(this.assetDirectory, "../command/sandbox.md"), "utf8"),
      ])
      return { cli, redaction, types, launcher, command }
    } catch (error) {
      throw new SandboxError("bootstrap", redactError(error), "ASSET_UNAVAILABLE")
    }
  }

  private async seedRemoteFile(vm: VmIdentity, path: string, content: string): Promise<void> {
    assertRemotePath(path, "remote writer path")
    await this.remote(vm, ["python3", "-c", REMOTE_SEED_FILE, path], content, "bootstrap")
  }

  private async writeRemoteFile(vm: VmIdentity, writer: string, root: string, path: string, content: string): Promise<void> {
    assertRemotePath(writer, "remote writer path")
    assertRemotePath(root, "remote asset root")
    assertRemotePath(path, "remote asset path")
    const relative = posix.relative(root, path)
    if (!relative || relative.startsWith("../") || relative === ".." || relative.startsWith("/")) {
      throw new SandboxError("validate", "remote asset path is outside its runtime", "PATH_INVALID")
    }
    await this.remote(vm, [writer, encodePath(root), encodePath(relative)], content, "bootstrap")
  }

  private async remoteResult(
    identity: VmIdentity,
    command: string[],
    stdin: string | Uint8Array | undefined,
    stage: "bootstrap" | "checkout" | "sync" | "detach" | "exec",
    options: { maxOutputBytes?: number; onLine?: (line: string) => void } = {},
  ): Promise<ProcessResult> {
    assertSafeSshDestination(identity.sshDest)
    try {
      const result = await this.runner.run({
        argv: buildRemoteCommandArgv({
           sshBin: DEFAULT_SSH_BIN,
          knownHostsFile: this.config.knownHostsFile,
          destination: identity.sshDest,
          sshUser: identity.sshUser,
        }, command),
        env: sanitizeEnvironment(),
        stdin,
        onLine: options.onLine,
        timeoutMs: this.config.bootstrapTimeoutMs,
        maxOutputBytes: options.maxOutputBytes ?? MAX_REMOTE_OUTPUT_BYTES,
      })
      return result
    } catch (error) {
      if (error instanceof SandboxError && error.stage === stage) throw error
      throw new SandboxError(stage, redactError(error), "REMOTE_COMMAND")
    }
  }

  private async remote(
    identity: VmIdentity,
    command: string[],
    stdin: string | Uint8Array | undefined,
    stage: "bootstrap" | "checkout" | "sync" | "detach" | "exec",
  ): Promise<ProcessResult> {
    const result = await this.remoteResult(identity, command, stdin, stage)
    if (result.exitCode !== 0) throw new SandboxError(stage, redactText(result.stderr || "remote command failed"), "REMOTE_COMMAND")
    return result
  }
}

export function createExedevSandcastleAdapter(options: ExedevSandcastleAdapterOptions): OpenCodeSandboxAdapter {
  const { input, authContent, ...providerOptions } = options
  const provider = new ExedevProvider({ ...providerOptions, deferActivation: true })
  const info: WorkspaceInfo = {
    id: input.workspaceId,
    type: "exedev",
    name: `oc-${shortHash(input.workspaceId)}`,
    branch: input.branch,
    directory: remoteWorkspaceDirectory(input.workspaceId),
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
    close: () => provider.close(info),
    recoveryMetadata: () => {
      const metadata = provider.runtimeMetadata(input.workspaceId)
      return {
        ...(metadata?.providerState ?? {}),
        ...(metadata?.vmName ? { vmName: metadata.vmName } : {}),
        ...(metadata?.vmIdentity ? { vmIdentity: metadata.vmIdentity } : {}),
      }
    },
  }
}

export function remoteWorkspaceDirectory(workspaceId: string): string {
  return `/tmp/oc-${shortHash(workspaceId)}/project`
}

export async function ensureExeDevHostKey(knownHostsFile: string, lobby: string, runner: ProcessRunner = nodeProcessRunner): Promise<void> {
  await ensurePrivateDirectory(dirname(knownHostsFile))
  let existing: string
  try {
    existing = await readFile(knownHostsFile, "utf8")
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error
    const scanned = await runner.run({
      argv: [SSH_KEYSCAN_BIN, "-T", "5", "-t", "rsa", lobby],
      env: sanitizeEnvironment(),
      maxOutputBytes: 32 * 1024,
    })
    if (scanned.exitCode !== 0 || scanned.stdout.trim().length === 0) {
      throw new SandboxError("discover", "could not retrieve the exe.dev host key", "HOST_KEY_SCAN")
    }
    const temporary = `${knownHostsFile}.${randomBytes(8).toString("hex")}.tmp`
    await writeFile(temporary, scanned.stdout, { encoding: "utf8", mode: 0o600, flag: "wx" })
    try {
      await assertPrivateFile(temporary)
      await verifyHostKey(temporary, lobby, runner)
      try {
        await writeFile(knownHostsFile, scanned.stdout, { encoding: "utf8", mode: 0o600, flag: "wx" })
      } catch (writeError) {
        if (!isNodeError(writeError, "EEXIST")) throw writeError
        await verifyHostKey(knownHostsFile, lobby, runner)
      }
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
    await assertPrivateFile(knownHostsFile)
    return
  }

  if (existing.trim().length === 0) throw new SandboxError("discover", "configured known hosts file is empty", "HOST_KEY_MISSING")
  await assertPrivateFile(knownHostsFile)
  await verifyHostKey(knownHostsFile, lobby, runner)
}

export async function ensureExeDevVmHostKey(knownHostsFile: string, identity: VmIdentity, runner: ProcessRunner = nodeProcessRunner): Promise<void> {
  const host = identity.sshDest.slice(identity.sshDest.lastIndexOf("@") + 1)
  if (!/^[A-Za-z0-9][A-Za-z0-9.:-]{0,253}$/.test(host)) {
    throw new SandboxError("discover", "VM SSH host is unsafe", "HOST_INVALID")
  }
  await ensurePrivateDirectory(dirname(knownHostsFile))

  try {
    await assertPrivateFile(knownHostsFile)
  } catch (error) {
    if (error instanceof SandboxError && error.code === "PATH_MISSING") {
      throw new SandboxError("discover", "VM host key is not configured", "VM_HOST_KEY_MISSING")
    }
    throw error
  }

  const known = await runner.run({
    argv: [SSH_KEYGEN_BIN, "-F", host, "-f", knownHostsFile],
    env: sanitizeEnvironment(),
    maxOutputBytes: 32 * 1024,
  })
  if (known.exitCode === 0 && known.stdout.trim().length > 0) return
  throw new SandboxError("discover", "VM host key is not configured for the exact SSH destination", "VM_HOST_KEY_UNKNOWN")
}

function readWorkspaceMetadata(info: WorkspaceInfo, from?: WorkspaceInfo): WorkspaceMetadata {
  const value = {
    ...(isRecord(from?.extra) ? from.extra : {}),
    ...(isRecord(info.extra) ? info.extra : {}),
  }
  const state = isRecord(value.providerState) ? value.providerState : {}
  const field = (key: string): unknown => value[key] ?? state[key]
  const generation = field("generation")
  if (generation !== undefined && (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1)) {
    throw new SandboxError("validate", "workspace generation is invalid", "GENERATION_INVALID")
  }
  const baseSha = field("baseSha")
  if (baseSha !== undefined && (typeof baseSha !== "string" || !/^[a-f0-9]{40}$/i.test(baseSha))) {
    throw new SandboxError("validate", "workspace base SHA is invalid", "BASE_SHA_INVALID")
  }
  const tags = field("tags")
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string"))) {
    throw new SandboxError("validate", "workspace VM tags are invalid", "TAGS_INVALID")
  }
  const vmIdentityValue = field("vmIdentity")
  const vmIdentity = vmIdentityValue === undefined ? undefined : parseVmIdentity(vmIdentityValue)
  if (vmIdentityValue !== undefined && !vmIdentity) {
    throw new SandboxError("validate", "workspace VM identity is invalid", "VM_IDENTITY_INVALID")
  }
  const remoteDirectory = field("remoteDirectory")
  if (remoteDirectory !== undefined) {
    if (typeof remoteDirectory !== "string") throw new SandboxError("validate", "workspace runtime directory is invalid", "RUNTIME_DIRECTORY")
    assertRemotePath(remoteDirectory, "workspace runtime directory")
  }
  return {
    sessionId: typeof field("sessionId") === "string" ? field("sessionId") as string : info.id,
    generation: typeof generation === "number" ? generation : 1,
    baseSha: typeof baseSha === "string" ? baseSha : undefined,
    tags: Array.isArray(tags) ? [...tags] : undefined,
    comment: typeof field("comment") === "string" ? field("comment") as string : undefined,
    vmIdentity,
    remoteDirectory: typeof remoteDirectory === "string" ? remoteDirectory : undefined,
  }
}

function parseVmIdentity(value: unknown): VmIdentity | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.sshDest !== "string") return undefined
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string")) return undefined
  const tags = value.tags
  const identity: VmIdentity = {
    name: value.name,
    sshDest: value.sshDest,
    tags: [...tags],
    comment: typeof value.comment === "string" ? value.comment : "",
  }
  for (const key of ["id", "sshUser", "sshHost", "region"] as const) {
    if (typeof value[key] === "string") identity[key] = value[key]
  }
  return identity
}

function normalizePublicRemote(value: string): string {
  const ssh = /^git@([A-Za-z0-9.-]+):([A-Za-z0-9._/-]+)$/.exec(value)
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SandboxError("git_preflight", "origin is not a public HTTPS repository", "REMOTE_URL_INVALID")
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || !/^\/[A-Za-z0-9._/-]+$/.test(url.pathname) || url.pathname.includes("..")) {
    throw new SandboxError("git_preflight", "origin is not a public HTTPS repository", "REMOTE_URL_INVALID")
  }
  return `${url.origin}${url.pathname}`
}

async function verifyHostKey(path: string, host: string, runner: ProcessRunner): Promise<void> {
  const entry = await runner.run({ argv: [SSH_KEYGEN_BIN, "-F", host, "-f", path], env: sanitizeEnvironment(), maxOutputBytes: 32 * 1024 })
  if (entry.exitCode !== 0 || entry.stdout.trim().length === 0) {
    throw new SandboxError("discover", `known hosts file has no entry for ${host}`, "HOST_KEY_MISSING")
  }
  const temporary = `${path}.${randomBytes(8).toString("hex")}.entry.tmp`
  await writeFile(temporary, entry.stdout, { encoding: "utf8", mode: 0o600, flag: "wx" })
  try {
    const result = await runner.run({ argv: [SSH_KEYGEN_BIN, "-lf", temporary, "-E", "sha256"], env: sanitizeEnvironment(), maxOutputBytes: 32 * 1024 })
    if (result.exitCode !== 0 || !result.stdout.includes(EXEDEV_HOST_FINGERPRINT)) {
      throw new SandboxError("discover", "exe.dev host key does not match the official fingerprint", "HOST_KEY_MISMATCH")
    }
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

function assertRemotePath(path: string, label: string): void {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(path) || path.includes("..")) throw new SandboxError("validate", `${label} is unsafe`, "PATH_INVALID")
}

function encodePath(value: string): string {
  return Buffer.from(value).toString("base64url")
}

async function waitForProcess(process: ProcessHandle): Promise<void> {
  await Promise.race([process.result.catch(() => undefined), delay(3_000)])
}
