import { randomBytes } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, posix } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

import { createIsolatedSandboxProvider, type IsolatedSandboxHandle } from "@ai-hero/sandcastle"

import type { ExeControl } from "./exe-control"
import { assertAliasPath, assertUnixSocketPath, buildRemoteCommandArgv, buildSupervisorArgv, DEFAULT_SSH_BIN, makeRuntimePaths, reserveLocalPort, worktreeAliasCommand, type RuntimePaths } from "./remote-runtime"
import { basicAuthHeader, buildRemoteFrame, generateRemoteCredentials } from "./remote-runtime"
import { assertPrivateFile, ensurePrivateDirectory } from "./secure-fs"
import { nodeProcessRunner, nodeProcessSupervisor, sanitizeEnvironment, trackedProcessObservation, unknownProcessObservation } from "./process"
import { assertRelativePath, assertSafeBranch, assertSafeComment, assertSafeSshDestination, assertSafeTag, assertSafeVmName, assertSha, identityMatches, makeVmPlan, quoteRemoteCommandPart, sha256, shortHash } from "./naming"
import { redactError, redactText } from "./redaction"
import { readLimitedBody } from "./workspace-http"
import { captureWorkingTree, syncBackWorkingTree as syncBackLocalWorkingTree } from "./working-tree"
import type { OpenCodeSandboxAdapter, SandcastleAdapterInput } from "./sandcastle-session"
import {
  copyVmIdentity,
  isNodeError,
  isRecord,
  SandboxError,
  type SandboxConfig,
  type ProcessHandle,
  type ProcessOwnershipObservation,
  type ProcessResult,
  type ProcessRunner,
  type ProcessSupervisor,
  type ProviderResourceObservation,
  type RuntimeAdoptionInput,
  type RuntimeCloseResult,
  type RuntimeDriver,
  type RuntimeOwner,
  type RuntimeResourceReference,
  type RuntimeSession,
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
const MAX_SYNC_PATCH_BYTES = 8 * 1024 * 1024
const INSPECTION_TIMEOUT_MS = 5_000
const INVENTORY_TIMEOUT_MS = 10_000
const SSH_KEYGEN_BIN = "/usr/bin/ssh-keygen"
const SSH_KEYSCAN_BIN = "/usr/bin/ssh-keyscan"
const EXEDEV_VM_HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.exe\.xyz$/
const MAX_PROCESS_FAILURE_OUTPUT_CHARS = 2_000
export const REMOTE_WRITE_FILE = String.raw`#!/usr/bin/env python3
import base64, os, sys

if not os.path.isabs(sys.argv[1]):
    raise SystemExit("runtime directory must be absolute")
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
const REMOTE_VALIDATE_CHECKOUT = String.raw`import os, stat, sys

path = sys.argv[1]
if (
    not path.startswith("/")
    or path != os.path.abspath(path)
    or path != os.path.realpath(path)
    or "\x00" in path
    or "\n" in path
    or "\r" in path
):
    raise SystemExit("unsafe checkout path")
if not hasattr(os, "O_DIRECTORY") or not hasattr(os, "O_NOFOLLOW"):
    raise SystemExit("checkout validation is unsupported")
fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_gid != os.getgid():
        raise SystemExit("checkout ownership is unsafe")
    os.fchmod(fd, 0o700)
finally:
    os.close(fd)
`
const REMOTE_LAUNCHER = String.raw`#!/usr/bin/env python3
import hashlib, json, os, re, shutil, stat, subprocess, sys

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
if not isinstance(frame["workspaceId"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", frame["workspaceId"]):
    fail("invalid workspace ID")
try:
    json.loads(frame["authContent"])
except Exception:
    fail("invalid auth content")

if os.geteuid() == 0:
    fail("refusing to run OpenCode as root")

uid = os.getuid()
gid = os.getgid()
runtime = os.path.dirname(frame["remoteLauncherPath"])
socket_path = frame["remoteControlSocket"]
expected_directory = "/tmp/oc-" + hashlib.sha256(frame["workspaceId"].encode("ascii")).hexdigest()[:10] + "/project"
if (
    not re.fullmatch(r"/tmp/oe-[a-f0-9]{12}", runtime)
    or runtime != os.path.abspath(runtime)
    or runtime != os.path.realpath(runtime)
    or frame["remoteLauncherPath"] != os.path.join(runtime, "launcher")
    or frame["remoteLauncherPath"] != os.path.realpath(frame["remoteLauncherPath"])
    or socket_path != os.path.join(runtime, "c.sock")
    or socket_path != os.path.abspath(socket_path)
    or socket_path != os.path.realpath(socket_path)
    or frame["directory"] != expected_directory
    or frame["directory"] != os.path.abspath(frame["directory"])
    or frame["directory"] != os.path.realpath(frame["directory"])
):
    fail("runtime path is unsafe")

try:
    runtime_info = os.lstat(runtime)
    launcher_info = os.lstat(frame["remoteLauncherPath"])
    checkout_info = os.lstat(frame["directory"])
except Exception:
    fail("remote runtime is unavailable")
if (
    stat.S_ISLNK(runtime_info.st_mode)
    or not stat.S_ISDIR(runtime_info.st_mode)
    or runtime_info.st_uid != uid
    or runtime_info.st_gid != gid
    or stat.S_IMODE(runtime_info.st_mode) != 0o700
):
    fail("remote runtime is not private")
if (
    stat.S_ISLNK(launcher_info.st_mode)
    or not stat.S_ISREG(launcher_info.st_mode)
    or launcher_info.st_uid != uid
    or launcher_info.st_gid != gid
    or stat.S_IMODE(launcher_info.st_mode) != 0o700
):
    fail("remote launcher is not private")
if (
    stat.S_ISLNK(checkout_info.st_mode)
    or not stat.S_ISDIR(checkout_info.st_mode)
    or checkout_info.st_uid != uid
    or checkout_info.st_gid != gid
    or stat.S_IMODE(checkout_info.st_mode) != 0o700
):
    fail("remote checkout is not private")

def read_control_socket(expected_uid, expected_gid):
    try:
        socket_info = os.lstat(socket_path)
    except OSError:
        fail("remote control socket is unavailable")
    if stat.S_ISLNK(socket_info.st_mode) or not stat.S_ISSOCK(socket_info.st_mode):
        fail("remote control path is not a socket")
    if socket_info.st_uid != expected_uid or socket_info.st_gid != expected_gid or stat.S_IMODE(socket_info.st_mode) != 0o600:
        fail("remote control socket ownership or permissions are unsafe")
    return socket_info

read_control_socket(0, 0)
try:
    subprocess.run(
        ["/usr/bin/sudo", "-n", "--", "/usr/bin/chown", "--no-dereference", "--", f"{uid}:{gid}", socket_path],
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=5,
    )
except (OSError, subprocess.SubprocessError):
    fail("could not transfer remote control socket ownership")
read_control_socket(uid, gid)

try:
    os.chdir(frame["directory"])
except OSError:
    fail("remote checkout is unavailable")

home = os.path.expanduser("~")
if not home.startswith("/") or "\x00" in home:
    fail("user home is unavailable")
bun_directory = os.path.join(home, ".bun", "bin")
command = shutil.which("opencode", path=bun_directory)
if command is None:
    fail("opencode is not installed")

environment = os.environ.copy()
environment["BUN_INSTALL"] = os.path.dirname(bun_directory)
environment["PATH"] = os.path.join(runtime, "bin") + os.pathsep + bun_directory + os.pathsep + environment.get("PATH", "")
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
if [ "$(id -u)" -eq 0 ]; then
    printf '%s\n' 'remote bootstrap refuses to run as root' >&2
    exit 1
fi

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
bun="$BUN_INSTALL/bin/bun"

if [ ! -x "$bun" ] || [ "$("$bun" --version 2>/dev/null || true)" != "${BUN_VERSION}" ]; then
    command -v bash >/dev/null
    command -v curl >/dev/null
    command -v unzip >/dev/null
    curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"
fi

test -x "$bun"
bun_version=$("$bun" --version 2>/dev/null || true)
if [ "$bun_version" != "${BUN_VERSION}" ]; then
    printf 'Bun version mismatch: expected %s, got %s\n' "${BUN_VERSION}" "$bun_version" >&2
    exit 1
fi

opencode="$BUN_INSTALL/bin/opencode"
package="$BUN_INSTALL/install/global/node_modules/opencode-ai"
if [ ! -x "$opencode" ] || [ "$("$opencode" --version 2>/dev/null || true)" != "${version}" ]; then
    "$bun" install --global --ignore-scripts "opencode-ai@${version}"
    test -f "$package/postinstall.mjs"
    "$bun" "$package/postinstall.mjs"
fi

test -x "$opencode"
opencode_version=$("$opencode" --version 2>/dev/null || true)
if [ "$opencode_version" != "${version}" ]; then
    printf 'OpenCode version mismatch: expected %s, got %s\n' "${version}" "$opencode_version" >&2
    exit 1
fi
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
  authContent?: string
  durableMetadataForResource?: (resourceId: string, owner?: RuntimeOwner) => Promise<unknown>
  assetDirectory?: string
  deferActivation?: boolean
}

export interface ExedevSandcastleAdapterOptions extends ExedevProviderOptions {
  input: SandcastleAdapterInput
  authContent?: string
  provider?: ExedevProvider
}

interface WorkspaceMetadata {
  sessionId: string
  generation: number
  baseSha?: string
  tags?: string[]
  comment?: string
  vmIdentity?: VmIdentity
  remoteDirectory?: string
  remoteWorktreePath?: string
}

interface ExedevRuntimeMetadata {
  provider: "exedev"
  projectId: string
  sessionId: string
  generation: number
  workspaceId: string
  branch: string
  baseSha: string
  remoteDirectory: string
  remoteWorktreePath: string
  vmName: string
  vmIdentity: VmIdentity
}

interface Activation {
  workspaceId: string
  projectId: string
  sessionId: string
  generation: number
  vm: VmInfo
  paths: RuntimePaths
  directory: string
  branch: string
  baseSha: string
  localPort: number
  password: string
  controlToken: string
  process?: ProcessHandle
  authContent?: string
  preservedWorktreePath?: string
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
  private readonly authContent?: string
  private readonly durableMetadataForResource?: (resourceId: string, owner?: RuntimeOwner) => Promise<unknown>
  private readonly assetDirectory: string
  private readonly deferActivation: boolean
  private readonly active = new Map<string, Activation>()
  private readonly runtimeSessions = new WeakMap<RuntimeSession, Activation>()

  constructor(options: ExedevProviderOptions) {
    this.config = options.config
    this.control = options.control
    this.worktree = options.worktree
    assertAliasPath(this.worktree, "host worktree alias")
    assertUnixSocketPath(options.localControlSocket, "local control socket")
    this.localControlSocket = options.localControlSocket
    this.runner = options.runner ?? nodeProcessRunner
    this.supervisor = options.supervisor ?? nodeProcessSupervisor
    this.fetcher = options.fetcher ?? fetch
    this.reservePort = options.reservePort ?? reserveLocalPort
    this.ensureHostKey = options.ensureHostKey ?? (() => ensureExeDevHostKey(this.config.knownHostsFile, this.config.sshLobby, this.runner))
    this.ensureVmHostKey = options.ensureVmHostKey ?? ((identity) => ensureExeDevVmHostKey(this.config.knownHostsFile, identity, this.runner))
    this.controlTokenFor = options.controlTokenFor
    this.revokeControlToken = options.revokeControlToken
    this.authContent = options.authContent
    this.durableMetadataForResource = options.durableMetadataForResource
    this.assetDirectory = options.assetDirectory ?? fileURLToPath(new URL(".", import.meta.url))
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
    const metadata = readWorkspaceMetadata(info, from)
    const active = this.active.get(info.id)
    if (active) {
      if (
        !metadata.vmIdentity ||
        !identityMatches(active.vm.identity, metadata.vmIdentity) ||
        info.branch !== active.branch ||
        (info.directory !== null && info.directory !== active.directory) ||
        (metadata.baseSha !== undefined && metadata.baseSha !== active.baseSha)
      ) throw exedevOwnershipError()
      await this.verifyVmIdentity(info, metadata, active.vm.identity)
      return
    }

    const generation = metadata.generation
    const branch = info.branch
    if (!branch) throw new SandboxError("validate", "workspace branch is missing", "BRANCH_MISSING")
    assertSafeBranch(branch)

    const expectedDirectory = remoteWorkspaceDirectory(info.id)
    const directory = info.directory ?? expectedDirectory
    if (directory !== expectedDirectory) throw new SandboxError("validate", "workspace directory is not plugin-owned", "WORKSPACE_DIRECTORY")
    assertRemotePath(directory, "workspace directory")
    const [remoteUrl, localSha] = await Promise.all([
      this.deferActivation ? Promise.resolve(undefined) : this.readRemoteUrl(),
      this.readHead(),
    ])
    const baseSha = metadata.baseSha ?? localSha
    if (baseSha !== localSha) throw new SandboxError("checkout", "workspace SHA changed during provisioning", "GIT_HEAD_CHANGED")
    assertSha(baseSha)
    if (!env.OPENCODE_AUTH_CONTENT) throw new SandboxError("bootstrap", "OpenCode auth content is unavailable", "AUTH_UNAVAILABLE")

    await this.ensureHostKey()
    const paths = makeRuntimePaths(metadata.sessionId, generation)
    const localPort = await this.reservePort()
    let createdByThisCall = false
    let createdIdentity: VmIdentity | undefined
    let createdCleanup: (() => Promise<void>) | undefined
    try {
      const provisioned = await this.provisionVm(info, metadata, (cleanup) => {
        createdByThisCall = true
        createdCleanup = cleanup
      })
      createdByThisCall ||= provisioned.created
      if (provisioned.created) createdIdentity = copyVmIdentity(provisioned.vm.identity)
      const vm = provisioned.created
        ? { ...provisioned.vm, identity: await this.verifyVmIdentity(info, metadata, provisioned.vm.identity) }
        : provisioned.vm
      await this.ensureVmHostKey(vm.identity)
      await this.bootstrap(vm.identity, paths, directory, remoteUrl, baseSha, branch)
      const credentials = generateRemoteCredentials()
      if (!this.controlTokenFor) {
        throw new SandboxError("control_channel", "remote capability factory is unavailable", "CONTROL_CAPABILITY")
      }
      const controlToken = await this.controlTokenFor(metadata.sessionId)
      const activation: Activation = {
        workspaceId: info.id,
        projectId: info.projectID,
        sessionId: metadata.sessionId,
        generation: metadata.generation,
        vm,
        paths,
        directory,
        branch,
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
      if (createdByThisCall) {
        if (createdCleanup) await createdCleanup().catch(() => undefined)
        else if (createdIdentity) await this.destroyVerifiedVm(info, metadata, createdIdentity).catch(() => undefined)
      }
      if (error instanceof SandboxError) throw error
      throw new SandboxError("bootstrap", redactError(error), "PROVISION_FAILED")
    }
  }

  async activate(workspaceId: string): Promise<void> {
    const activation = this.active.get(workspaceId)
    if (!activation) throw new SandboxError("bootstrap", "workspace runtime is not active", "RUNTIME_UNAVAILABLE")
    if (activation.process) return
    if (!activation.authContent) throw new SandboxError("bootstrap", "OpenCode auth content is unavailable", "AUTH_UNAVAILABLE")

    if (activation.directory !== remoteWorkspaceDirectory(activation.workspaceId)) {
      throw new SandboxError("checkout", "workspace checkout path is not plugin-owned", "WORKSPACE_DIRECTORY")
    }
    await this.remote(activation.vm.identity, ["python3", "-c", REMOTE_VALIDATE_CHECKOUT, activation.directory], undefined, "checkout")
    const identityPath = posix.join(activation.directory, ".git/opencode")
    assertRemotePath(identityPath, "project identity path")
    await this.remote(activation.vm.identity, ["python3", "-c", REMOTE_WRITE_PATH, identityPath], activation.projectId, "bootstrap")
    await this.remote(
      activation.vm.identity,
      ["sudo", "-n", "--", "sh", "-lc", worktreeAliasCommand(this.worktree, activation.directory, "exe.dev")],
      undefined,
      "bootstrap",
    )
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
        [activation.paths.remoteWriteFilePath, activation.directory, encodePath(file.path)],
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
      providerState: { ...metadataForActivation(activation) },
      vmName: activation.vm.identity.name,
      vmIdentity: copyVmIdentity(activation.vm.identity),
    }
  }

  async inspect(info: WorkspaceInfo, _signal?: AbortSignal): Promise<ProviderResourceObservation> {
    const metadata = readWorkspaceMetadata(info)
    const expected = metadata.vmIdentity
    const resourceId = expected?.id ?? expected?.name ?? info.name
    if (!expected || expected.sshDest === "pending") {
      return {
        resourceId,
        resource: "unknown",
        ownership: "unknown",
        health: "unknown",
        evidence: ["exe.dev VM identity is unavailable"],
      }
    }
    const inventory = validateVmInventory(await this.control.list(INSPECTION_TIMEOUT_MS))
    const matches = inventory.filter((item) => identityMatches(expected, item.identity))
    const sameName = inventory.filter((item) => item.identity.name === expected.name)
    if (matches.length === 0) {
      if (sameName.length > 0) {
        return { resourceId, resource: "present", ownership: "conflict", health: "unknown", evidence: [`exe.dev inventory:${resourceId}`] }
      }
      return { resourceId, resource: "absent", ownership: "unknown", health: "unknown", evidence: [`exe.dev inventory:${resourceId}`] }
    }
    const match = matches[0]
    if (matches.length !== 1 || sameName.length !== 1 || !match || !hasOwnerTag(info, metadata, match.identity)) {
      return { resourceId, resource: "present", ownership: "conflict", health: "unknown", evidence: [`exe.dev inventory:${resourceId}`] }
    }
    const observation: ProviderResourceObservation = {
      resourceId,
      resource: "present",
      ownership: "verified",
      health: classifyVmHealth(match.status),
      evidence: [`exe.dev inventory:${resourceId}`],
    }
    return observation
  }

  async diagnose(info: WorkspaceInfo, signal?: AbortSignal): Promise<ProviderResourceObservation> {
    const observation = await this.inspect(info)
    if (observation.resource !== "present" || observation.ownership !== "verified") return observation
    const health = await this.activeHealth(info.id, signal)
    if (!health) return { ...observation, health: "unknown" }
    let authenticatedHealth: ProviderResourceObservation["health"] = "unknown"
    if (health.healthy === true) authenticatedHealth = "healthy"
    else if (health.healthy === false) authenticatedHealth = "degraded"
    return {
      ...observation,
      health: authenticatedHealth,
      ...(health.version ? { remoteVersion: health.version } : {}),
    }
  }

  processObservation(workspaceId: string): ProcessOwnershipObservation {
    const activation = this.active.get(workspaceId)
    return activation
      ? trackedProcessObservation(activation.process, "exe.dev SSH supervisor")
      : unknownProcessObservation("exe.dev activation is not tracked by this process")
  }

  async inventory(): Promise<ProviderResourceObservation[]> {
    const inventory = validateVmInventory(await this.control.list(INVENTORY_TIMEOUT_MS))
    const names = new Map<string, number>()
    for (const item of inventory) names.set(item.identity.name, (names.get(item.identity.name) ?? 0) + 1)
    return inventory.map((item) => {
      const resourceId = item.identity.id ?? item.identity.name
      const ambiguous = (names.get(item.identity.name) ?? 0) > 1
      return {
        resourceId,
        resource: "present" as const,
        ownership: ambiguous ? "conflict" as const : "unknown" as const,
        health: ambiguous ? "unknown" as const : classifyVmHealth(item.status),
        evidence: [`exe.dev inventory:${resourceId}`],
      }
    })
  }

  runtimeDriver(): RuntimeDriver {
    return {
      inspect: (resource) => this.inspectRuntime(resource),
      adopt: (input) => this.adoptRuntime(input),
      sync: (session) => this.syncRuntime(session),
      close: (session) => this.closeRuntime(session),
      abort: (session) => this.abortRuntime(session),
      destroy: (resource, owner) => this.destroyRuntime(resource, owner),
    }
  }

  private async inspectRuntime(resource: RuntimeResourceReference): Promise<ProviderResourceObservation> {
    if (resource.provider !== this.type) {
      throw new SandboxError("inspect", "runtime provider does not match exe.dev", "EXEDEV_PROVIDER_MISMATCH")
    }
    assertSafeVmName(resource.resourceId)
    const metadata = await this.durableMetadata(resource.resourceId)
    if (!metadata) {
      return {
        resourceId: resource.resourceId,
        resource: "unknown",
        ownership: "unknown",
        health: "unknown",
        evidence: [`exe.dev durable owner metadata:${resource.resourceId}`],
      }
    }
    return (await this.observeRuntime(resource, metadata)).observation
  }

  private async adoptRuntime(input: RuntimeAdoptionInput): Promise<RuntimeSession> {
    if (input.resource.provider !== this.type || input.owner.provider !== this.type) {
      throw new SandboxError("adopt", "runtime adoption is not supported for this provider", "EXEDEV_ADOPT_UNSUPPORTED")
    }
    assertSafeVmName(input.resource.resourceId)
    assertSafeBranch(input.owner.branch)
    assertSha(input.owner.baseSha)
    if ([...this.active.values()].some((activation) => resourceMatchesIdentity(input.resource, activation.vm.identity))) {
      throw new SandboxError("adopt", "exe.dev VM is already controlled by this process", "EXEDEV_ADOPT_CONFLICT")
    }

    let metadata: ExedevRuntimeMetadata | undefined
    let observed: { observation: ProviderResourceObservation; vm?: VmInfo }
    try {
      metadata = await this.durableMetadata(input.resource.resourceId, input.owner)
      if (!metadata || !sameRuntimeOwner(metadata, input.owner)) {
        throw new SandboxError("adopt", "exe.dev VM ownership metadata is unavailable", "EXEDEV_ADOPT_UNKNOWN")
      }
      observed = await this.observeRuntime(input.resource, metadata)
    } catch (error) {
      throw adoptionUnknown(error)
    }
    assertAdoptableExedev(observed.observation)
    const vm = observed.vm
    if (!vm) throw new SandboxError("adopt", "exe.dev VM identity is unavailable", "EXEDEV_ADOPT_UNKNOWN")
    if (!this.localControlSocket || !this.controlTokenFor || !this.authContent) {
      throw new SandboxError("adopt", "exe.dev control runtime is unavailable", "EXEDEV_ADOPT_UNSUPPORTED")
    }

    const paths = runtimePathsForDirectory(metadata.remoteDirectory)
    const directory = metadata.remoteWorktreePath
    let activation: Activation | undefined
    try {
      // Inventory and durable metadata are the ownership proof. SSH is read-only until both match.
      await this.ensureVmHostKey(vm.identity)
      await this.verifyAdoptedCheckout(vm.identity, directory, input.owner.branch, input.owner.baseSha)
      const localPort = await this.reservePort()
      const credentials = generateRemoteCredentials()
      const controlToken = await this.controlTokenFor(input.owner.sessionId)
      activation = {
        workspaceId: input.owner.workspaceId,
        projectId: input.owner.projectId,
        sessionId: input.owner.sessionId,
        generation: input.owner.generation,
        vm,
        paths,
        directory,
        branch: input.owner.branch,
        baseSha: input.owner.baseSha,
        localPort,
        password: credentials.serverPassword,
        controlToken,
        authContent: this.authContent,
      }
      this.active.set(activation.workspaceId, activation)
      await this.activate(activation.workspaceId)
      let aborting: Promise<RuntimeCloseResult> | undefined
      let session!: RuntimeSession
      session = {
        workspaceId: activation.workspaceId,
        target: {
          type: "remote",
          url: `http://127.0.0.1:${activation.localPort}`,
          headers: { Authorization: basicAuthHeader(activation.password) },
        },
        remoteWorktreePath: activation.directory,
        recoveryMetadata: { ...metadataForActivation(activation) },
        inspect: () => this.inspectRuntime({ provider: this.type, resourceId: resourceIdForIdentity(activation!.vm.identity) }),
        abort: () => {
          aborting ??= this.abortRuntime(session).catch((error) => {
            aborting = undefined
            throw error
          })
          return aborting
        },
      }
      this.runtimeSessions.set(session, activation)
      return session
    } catch (error) {
      if (activation) await this.cleanupAdoption(activation)
      throw error instanceof SandboxError ? error : new SandboxError("adopt", redactError(error), "EXEDEV_ADOPT_UNKNOWN")
    }
  }

  private async syncRuntime(session: RuntimeSession): Promise<void> {
    const activation = this.runtimeSessions.get(session)
    if (!activation) throw new SandboxError("sync", "adopted exe.dev runtime is not active", "RUNTIME_UNAVAILABLE")
    await this.assertRuntimeOwned(activation, true)
    const localBase = await this.localGit(this.worktree, ["cat-file", "-e", `${activation.baseSha}^{commit}`], "sync")
    if (localBase.exitCode !== 0) throw new SandboxError("sync", "the captured base revision is unavailable locally", "GIT_BASE_UNAVAILABLE")

    const branch = await this.remoteResult(activation.vm.identity, ["git", "-C", activation.directory, "symbolic-ref", "--short", "HEAD"], undefined, "sync")
    if (branch.exitCode !== 0 || branch.stdout.trim() !== activation.branch) {
      throw new SandboxError("sync", "exe.dev checkout is on an unexpected branch", "BRANCH_MISMATCH")
    }
    const head = await this.remoteResult(activation.vm.identity, ["git", "-C", activation.directory, "rev-parse", "HEAD"], undefined, "sync")
    try {
      if (head.exitCode !== 0) throw new Error("remote HEAD is unavailable")
      assertSha(head.stdout.trim())
    } catch {
      throw new SandboxError("sync", "exe.dev checkout HEAD is invalid", "REMOTE_HEAD_MISMATCH")
    }
    const lineage = await this.remoteResult(
      activation.vm.identity,
      ["git", "-C", activation.directory, "merge-base", "--is-ancestor", activation.baseSha, head.stdout.trim()],
      undefined,
      "sync",
    )
    if (lineage.exitCode !== 0) {
      throw new SandboxError("sync", "exe.dev checkout history diverged from the captured revision", "REMOTE_LINEAGE_MISMATCH")
    }

    await this.remote(activation.vm.identity, ["git", "-C", activation.directory, "add", "-A"], undefined, "sync")
    const staged = await this.remoteResult(activation.vm.identity, ["git", "-C", activation.directory, "diff", "--cached", "--quiet"], undefined, "sync")
    if (staged.exitCode === 1) {
      await this.remote(activation.vm.identity, [
        "git",
        "-C",
        activation.directory,
        "-c",
        "user.name=OpenCode Sandbox",
        "-c",
        "user.email=opencode@localhost",
        "commit",
        "-m",
        "opencode: sync sandbox workspace",
      ], undefined, "sync")
    } else if (staged.exitCode !== 0) {
      throw new SandboxError("sync", redactText(staged.stderr || "could not inspect remote changes"), "GIT_COMMAND")
    }

    const patch = await this.remoteResult(
      activation.vm.identity,
      ["git", "-C", activation.directory, "diff", "--binary", activation.baseSha, "--"],
      undefined,
      "sync",
      { maxOutputBytes: MAX_SYNC_PATCH_BYTES },
    )
    if (patch.exitCode !== 0) throw new SandboxError("sync", redactText(patch.stderr || "could not capture remote changes"), "GIT_DIFF")
    if (patch.stdout) await this.preservePatch(activation, patch.stdout)
  }

  private async closeRuntime(session: RuntimeSession): Promise<RuntimeCloseResult> {
    const activation = this.runtimeSessions.get(session)
    if (!activation) throw new SandboxError("remove", "adopted exe.dev runtime is not active", "RUNTIME_UNAVAILABLE")
    try {
      await this.assertRuntimeOwned(activation)
      await this.release(workspaceInfoForActivation(activation))
      return activation.preservedWorktreePath ? { preservedWorktreePath: activation.preservedWorktreePath } : {}
    } catch (error) {
      await this.cleanupAdoption(activation).catch(() => undefined)
      throw error
    } finally {
      this.runtimeSessions.delete(session)
    }
  }

  private async abortRuntime(session: RuntimeSession): Promise<RuntimeCloseResult> {
    const activation = this.runtimeSessions.get(session)
    if (!activation) return {}
    try {
      await this.cleanupAdoption(activation)
      return activation.preservedWorktreePath ? { preservedWorktreePath: activation.preservedWorktreePath } : {}
    } finally {
      this.runtimeSessions.delete(session)
    }
  }

  private async destroyRuntime(resource: RuntimeResourceReference, owner: RuntimeOwner): Promise<void> {
    if (resource.provider !== this.type || owner.provider !== this.type) {
      throw new SandboxError("remove", "runtime destruction is not supported for this provider", "EXEDEV_ADOPT_UNSUPPORTED")
    }
    assertSafeVmName(resource.resourceId)
    const metadata = await this.durableMetadata(resource.resourceId, owner)
    if (!metadata || !sameRuntimeOwner(metadata, owner)) {
      throw new SandboxError("remove", "exe.dev VM ownership could not be verified", "EXEDEV_OWNERSHIP_UNVERIFIED")
    }
    const observed = await this.observeRuntime(resource, metadata)
    assertDestructibleExedev(observed.observation)
    if (!observed.vm) throw new SandboxError("remove", "exe.dev VM identity could not be verified", "EXEDEV_OWNERSHIP_UNVERIFIED")
    await this.control.remove(observed.vm.identity)
  }

  private async durableMetadata(resourceId: string, owner?: RuntimeOwner): Promise<ExedevRuntimeMetadata | undefined> {
    const raw = this.durableMetadataForResource
      ? await this.durableMetadataForResource(resourceId, owner)
      : [...this.active.values()].find((activation) => resourceMatchesIdentity({ provider: this.type, resourceId }, activation.vm.identity))
        ? metadataForActivation([...this.active.values()].find((activation) => resourceMatchesIdentity({ provider: this.type, resourceId }, activation.vm.identity))!)
        : undefined
    if (!raw) return undefined
    return parseExedevRuntimeMetadata(raw)
  }

  private async observeRuntime(
    resource: RuntimeResourceReference,
    metadata: ExedevRuntimeMetadata,
  ): Promise<{ observation: ProviderResourceObservation; vm?: VmInfo }> {
    const inventory = validateVmInventory(await this.control.list(INSPECTION_TIMEOUT_MS))
    const byReference = inventory.filter((item) => resourceMatchesIdentity(resource, item.identity))
    const sameName = inventory.filter((item) => item.identity.name === metadata.vmName)
    const exact = inventory.filter((item) => identityMatches(metadata.vmIdentity, item.identity))
    const evidence = [`exe.dev inventory:${resource.resourceId}`]
    if (byReference.length === 0 && sameName.length === 0) {
      return {
        observation: {
          resourceId: resource.resourceId,
          projectId: metadata.projectId,
          resource: "absent",
          ownership: "unknown",
          health: "unknown",
          evidence,
        },
      }
    }
    if (byReference.length !== 1 || sameName.length !== 1 || exact.length !== 1) {
      return {
        observation: {
          resourceId: resource.resourceId,
          projectId: metadata.projectId,
          resource: "present",
          ownership: "conflict",
          health: "unknown",
          evidence: [...evidence, "exe.dev inventory is ambiguous"],
        },
      }
    }
    const vm = exact[0]
    if (!vm || !resourceMatchesIdentity(resource, vm.identity) || vm.identity.name !== metadata.vmName || !hasOwnerTagForMetadata(metadata, vm.identity)) {
      return {
        observation: {
          resourceId: resource.resourceId,
          projectId: metadata.projectId,
          resource: "present",
          ownership: "conflict",
          health: "unknown",
          evidence,
        },
      }
    }
    return {
      vm,
      observation: {
        resourceId: resource.resourceId,
        projectId: metadata.projectId,
        resource: "present",
        ownership: "verified",
        health: classifyVmHealth(vm.status),
        evidence,
      },
    }
  }

  private async verifyAdoptedCheckout(identity: VmIdentity, directory: string, branch: string, baseSha: string): Promise<void> {
    assertRemotePath(directory, "workspace directory")
    const branchResult = await this.remoteResult(identity, ["git", "-C", directory, "symbolic-ref", "--short", "HEAD"], undefined, "checkout")
    if (branchResult.exitCode !== 0 || branchResult.stdout.trim() !== branch) {
      throw new SandboxError("adopt", "exe.dev checkout branch does not match the lifecycle record", "EXEDEV_ADOPT_CHECKOUT")
    }
    const head = await this.remoteResult(identity, ["git", "-C", directory, "rev-parse", "HEAD"], undefined, "checkout")
    if (head.exitCode !== 0) throw new SandboxError("adopt", "exe.dev checkout revision is unavailable", "EXEDEV_ADOPT_CHECKOUT")
    try {
      assertSha(head.stdout.trim())
    } catch {
      throw new SandboxError("adopt", "exe.dev checkout revision is invalid", "EXEDEV_ADOPT_CHECKOUT")
    }
    const lineage = await this.remoteResult(
      identity,
      ["git", "-C", directory, "merge-base", "--is-ancestor", baseSha, head.stdout.trim()],
      undefined,
      "checkout",
    )
    if (lineage.exitCode !== 0) {
      throw new SandboxError("adopt", "exe.dev checkout history does not contain the lifecycle base revision", "EXEDEV_ADOPT_CHECKOUT")
    }
  }

  private async assertRuntimeOwned(activation: Activation, requireHealthy = false): Promise<void> {
    const metadata = metadataForActivation(activation)
    const observed = await this.observeRuntime({ provider: this.type, resourceId: resourceIdForIdentity(activation.vm.identity) }, metadata)
    if (observed.observation.resource !== "present" || observed.observation.ownership !== "verified" || !observed.vm) {
      throw new SandboxError("remove", "exe.dev VM ownership could not be verified", "EXEDEV_OWNERSHIP_UNVERIFIED")
    }
    if (requireHealthy && observed.observation.health !== "healthy") {
      throw new SandboxError("sync", "exe.dev VM health is not usable", "EXEDEV_RUNTIME_UNAVAILABLE")
    }
  }

  private async preservePatch(activation: Activation, patch: string): Promise<void> {
    const temporaryRoot = await makeTemporarySyncRoot(this.worktree, activation.workspaceId)
    const worktreePath = join(temporaryRoot, "worktree")
    let added = false
    try {
      const addedWorktree = await this.localGit(this.worktree, ["worktree", "add", "--detach", worktreePath, activation.baseSha], "sync")
      if (addedWorktree.exitCode !== 0) throw new SandboxError("sync", redactText(addedWorktree.stderr || "could not create a preservation worktree"), "GIT_WORKTREE")
      added = true
      const applied = await this.localGit(worktreePath, ["apply", "--binary", "-"], "sync", patch)
      if (applied.exitCode !== 0) throw new SandboxError("sync", redactText(applied.stderr || "could not apply remote changes"), "GIT_APPLY")
      const staged = await this.localGit(worktreePath, ["add", "-A"], "sync")
      if (staged.exitCode !== 0) throw new SandboxError("sync", redactText(staged.stderr || "could not stage preserved changes"), "GIT_COMMAND")
      const committed = await this.localGit(worktreePath, ["-c", "user.name=OpenCode Sandbox", "-c", "user.email=opencode@localhost", "commit", "-m", "opencode: preserve recovered workspace"], "sync")
      if (committed.exitCode !== 0) throw new SandboxError("sync", redactText(committed.stderr || "could not commit preserved changes"), "GIT_COMMAND")
      const head = await this.localGit(worktreePath, ["rev-parse", "HEAD"], "sync")
      if (head.exitCode !== 0) throw new SandboxError("sync", "could not read preserved revision", "GIT_HEAD")
      const updated = await this.localGit(this.worktree, ["update-ref", `refs/heads/${activation.branch}`, head.stdout.trim()], "sync")
      if (updated.exitCode !== 0) throw new SandboxError("sync", redactText(updated.stderr || "could not update preserved branch"), "GIT_BRANCH")
      await this.localGit(this.worktree, ["worktree", "remove", "--force", worktreePath], "sync")
      added = false
      await removeTemporarySyncRoot(temporaryRoot)
    } catch (error) {
      if (added) activation.preservedWorktreePath = worktreePath
      else await removeTemporarySyncRoot(temporaryRoot)
      throw error
    }
  }

  private async localGit(cwd: string, args: string[], stage: "sync", stdin?: string): Promise<ProcessResult> {
    return this.runner.run({
      argv: ["git", "-C", cwd, ...args],
      cwd,
      stdin,
      env: sanitizeEnvironment(),
      timeoutMs: this.config.bootstrapTimeoutMs,
      maxOutputBytes: MAX_SYNC_PATCH_BYTES,
    })
  }

  private async cleanupAdoption(activation: Activation): Promise<void> {
    if (activation.process) {
      activation.process.terminate()
      await waitForProcess(activation.process).catch(() => undefined)
      activation.process = undefined
    }
    this.revokeControlToken?.(activation.controlToken)
    this.active.delete(activation.workspaceId)
  }

  async release(info: WorkspaceInfo): Promise<void> {
    const activation = this.active.get(info.id)
    const metadata = readWorkspaceMetadata(info)
    let identity: VmIdentity | undefined
    if (activation) {
      if (!metadata.vmIdentity || !identityMatches(activation.vm.identity, metadata.vmIdentity)) throw exedevOwnershipError()
      identity = await this.verifyVmIdentity(info, metadata, activation.vm.identity)
    }
    if (!activation) {
      if (!metadata.vmIdentity || !metadata.remoteDirectory) return
      if (metadata.vmIdentity.sshDest === "pending") throw new SandboxError("remove", "workspace VM identity is unavailable", "VM_IDENTITY_UNAVAILABLE")
      assertRuntimeDirectory(metadata.remoteDirectory)
      identity = await this.verifyVmIdentity(info, metadata, metadata.vmIdentity)
      await this.remote(identity, ["rm", "-rf", "--", metadata.remoteDirectory], undefined, "detach")
      return
    }
    this.revokeControlToken?.(activation.controlToken)
    if (activation.process) {
      activation.process.terminate()
      await waitForProcess(activation.process)
    }
    await this.remote(identity!, ["rm", "-rf", "--", activation.paths.remoteDirectory], undefined, "detach")
    this.active.delete(info.id)
  }

  async destroy(info: WorkspaceInfo): Promise<void> {
    const activation = this.active.get(info.id)
    const metadata = readWorkspaceMetadata(info)
    if (activation && (!metadata.vmIdentity || !identityMatches(activation.vm.identity, metadata.vmIdentity))) throw exedevOwnershipError()
    const expected = activation?.vm.identity ?? metadata.vmIdentity
    if (!expected || expected.sshDest === "pending") throw new SandboxError("remove", "workspace VM identity is unavailable", "VM_IDENTITY_UNAVAILABLE")
    const identity = await this.verifyVmIdentity(info, metadata, expected)
    await this.control.remove(identity)
    this.active.delete(info.id)
  }

  private async verifyVmIdentity(info: WorkspaceInfo, metadata: WorkspaceMetadata, expected: VmIdentity): Promise<VmIdentity> {
    return copyVmIdentity((await this.findVerifiedVm(info, metadata, expected)).identity)
  }

  private async findVerifiedVm(info: WorkspaceInfo, metadata: WorkspaceMetadata, expected: VmIdentity): Promise<VmInfo> {
    if (info.type !== this.type || info.name !== expected.name) throw exedevOwnershipError()
    if (expected.sshDest === "pending") throw new SandboxError("remove", "workspace VM identity is unavailable", "VM_IDENTITY_UNAVAILABLE")
    const inventory = validateVmInventory(await this.control.list(INSPECTION_TIMEOUT_MS))
    const sameName = inventory.filter((item) => item.identity.name === expected.name)
    const matches = sameName.filter((item) => identityMatches(expected, item.identity))
    const match = matches[0]
    if (matches.length !== 1 || sameName.length !== 1 || !match || !hasOwnerTag(info, metadata, match.identity)) {
      const differingFields = [...new Set(sameName.flatMap((item) => identityDifferenceFields(expected, item.identity)))]
      const ownerTagMatches = sameName.filter((item) => hasOwnerTag(info, metadata, item.identity)).length
      throw exedevOwnershipError(
        `exe.dev VM ownership could not be verified; identity fields differ: ${differingFields.length > 0 ? differingFields.join(",") : "none"}; matches=${matches.length}; sameName=${sameName.length}; ownerTagMatches=${ownerTagMatches}`,
      )
    }
    return match
  }

  private async destroyVerifiedVm(info: WorkspaceInfo, metadata: WorkspaceMetadata, expected: VmIdentity): Promise<void> {
    const identity = await this.verifyVmIdentity(info, metadata, expected)
    await this.control.remove(identity)
  }

  async dispose(): Promise<void> {
    const activations = [...this.active.values()]
    const results = await Promise.allSettled(
      activations.map(async (activation) => {
        const identity = await this.verifyActivation(activation)
        this.revokeControlToken?.(activation.controlToken)
        if (activation.process) {
          activation.process.terminate()
          await waitForProcess(activation.process)
        }
        await this.remote(identity, ["rm", "-rf", "--", activation.paths.remoteDirectory], undefined, "detach")
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

  private async provisionVm(
    info: WorkspaceInfo,
    metadata: WorkspaceMetadata,
    onCreated?: (cleanup: () => Promise<void>) => void,
  ): Promise<ProvisionedVm> {
    const plan = makeVmPlan({ workspaceId: info.id, projectId: info.projectID, generation: metadata.generation })
    const ownerTag = exedevOwnerTag(info, metadata)
    const tags = [...new Set([...(metadata.tags ?? plan.tags), ownerTag])]
    const comment = metadata.comment ?? plan.comment
    tags.forEach(assertSafeTag)
    assertSafeVmName(info.name)
    assertSafeComment(comment)

    const expected = metadata.vmIdentity
    if (expected && expected.sshDest !== "pending") {
      assertSafeVmName(expected.name)
      assertSafeSshDestination(expected.sshDest)
      expected.tags.forEach(assertSafeTag)
      const vm = await this.findVerifiedVm(info, metadata, expected)
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
      const vm = validateVmInfo(await this.control.copy({
          baseVm: this.config.baseVm,
          name: info.name,
          cpu: this.config.cpu,
          memory: this.config.memory,
          tags,
          comment,
        }, onCreated))
      return { vm, created: true }
    }
    const receipt = validateVmInfo(await this.control.create({
      name: info.name,
      cpu: this.config.cpu,
      memory: this.config.memory,
      tags,
      comment,
    }))
    let confirmed: VmInfo | undefined
    onCreated?.(async () => {
      const vm = confirmed ?? await this.confirmCreatedVm(info, metadata, receipt, tags, comment)
      await this.control.remove(vm.identity)
    })
    const vm = await this.confirmCreatedVm(info, metadata, receipt, tags, comment)
    confirmed = vm
    return { vm, created: true }
  }

  private async confirmCreatedVm(
    info: WorkspaceInfo,
    metadata: WorkspaceMetadata,
    receipt: VmInfo,
    tags: string[],
    comment: string,
  ): Promise<VmInfo> {
    if (receipt.identity.name !== info.name) throw exedevOwnershipError()
    const inventory = validateVmInventory(await this.control.list(INSPECTION_TIMEOUT_MS))
    const sameName = inventory.filter((item) => item.identity.name === receipt.identity.name)
    const matches = sameName.filter((item) =>
      item.identity.sshDest === receipt.identity.sshDest &&
      (receipt.identity.id === undefined || item.identity.id === receipt.identity.id) &&
      tags.every((tag) => item.identity.tags.includes(tag)) &&
      item.identity.comment === comment &&
      hasOwnerTag(info, metadata, item.identity),
    )
    if (sameName.length !== 1 || matches.length !== 1) throw exedevOwnershipError()
    const match = matches[0]
    if (!match) throw exedevOwnershipError()
    return { ...match, identity: copyVmIdentity(match.identity) }
  }

  private async verifyActivation(activation: Activation): Promise<VmIdentity> {
    const info: WorkspaceInfo = {
      id: activation.workspaceId,
      type: this.type,
      name: activation.vm.identity.name,
      branch: activation.branch,
      directory: activation.directory,
      projectID: activation.projectId,
      extra: {
        sessionId: activation.sessionId,
        generation: activation.generation,
        vmIdentity: activation.vm.identity,
      },
    }
    return this.verifyVmIdentity(info, {
      sessionId: activation.sessionId,
      generation: activation.generation,
      vmIdentity: activation.vm.identity,
    }, activation.vm.identity)
  }

  private async bootstrap(vm: VmIdentity, paths: RuntimePaths, directory: string, remoteUrl: string | undefined, baseSha: string, branch: string): Promise<void> {
    await this.remote(vm, ["/bin/sh", "-s"], REMOTE_BOOTSTRAP(this.config.openCodeVersion), "bootstrap")
    const assets = await this.assets()
    if (this.deferActivation) {
      const symlink = await this.remoteResult(vm, ["test", "-L", directory], undefined, "checkout")
      if (symlink.exitCode === 0) throw new SandboxError("checkout", "existing workspace directory is a symlink", "REMOTE_DIR_UNSAFE")
    }
    const checkoutDirectory = this.deferActivation ? directory : posix.dirname(directory)
    await this.remote(vm, ["mkdir", "-p", "--", paths.remoteDirectory, `${paths.remoteDirectory}/bin`, `${paths.remoteDirectory}/.config/opencode/sandbox`, `${paths.remoteDirectory}/config/command`, checkoutDirectory], undefined, "bootstrap")
    await this.seedRemoteFile(vm, paths.remoteWriteFilePath, REMOTE_WRITE_FILE)
    await this.writeRemoteFile(vm, paths.remoteWriteFilePath, paths.remoteDirectory, paths.remoteLauncherPath, REMOTE_LAUNCHER)
    await this.writeRemoteFile(vm, paths.remoteWriteFilePath, paths.remoteDirectory, paths.remoteCliPath, assets.launcher)
    await this.writeRemoteFile(vm, paths.remoteWriteFilePath, paths.remoteDirectory, `${paths.remoteDirectory}/.config/opencode/sandbox/cli.ts`, assets.cli)
    await this.writeRemoteFile(vm, paths.remoteWriteFilePath, paths.remoteDirectory, `${paths.remoteDirectory}/.config/opencode/sandbox/redaction.ts`, assets.redaction)
    await this.writeRemoteFile(vm, paths.remoteWriteFilePath, paths.remoteDirectory, `${paths.remoteDirectory}/.config/opencode/sandbox/types.ts`, assets.types)
    await this.writeRemoteFile(vm, paths.remoteWriteFilePath, paths.remoteDirectory, paths.remoteCommandPath, assets.command)
    await this.remote(vm, ["chmod", "700", paths.remoteDirectory, `${paths.remoteDirectory}/bin`, `${paths.remoteDirectory}/.config`, `${paths.remoteDirectory}/.config/opencode`, `${paths.remoteDirectory}/.config/opencode/sandbox`, `${paths.remoteDirectory}/config`, `${paths.remoteDirectory}/config/command`, checkoutDirectory], undefined, "bootstrap")
    await this.remote(vm, ["chmod", "700", paths.remoteLauncherPath, paths.remoteCliPath, paths.remoteWriteFilePath], undefined, "bootstrap")
    await this.remote(vm, ["chmod", "600", paths.remoteCommandPath, `${paths.remoteDirectory}/.config/opencode/sandbox/cli.ts`, `${paths.remoteDirectory}/.config/opencode/sandbox/redaction.ts`, `${paths.remoteDirectory}/.config/opencode/sandbox/types.ts`], undefined, "bootstrap")
    if (!this.deferActivation) {
      if (!remoteUrl) throw new SandboxError("git_preflight", "origin is unavailable", "REMOTE_URL_INVALID")
      await this.prepareCheckout(vm, directory, remoteUrl, baseSha, branch)
      await this.remote(vm, ["chmod", "700", directory], undefined, "bootstrap")
    }
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
          const value = await readHealthResponse(response, controller.signal).catch(() => undefined)
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
    const secrets = [activation.password, activation.controlToken, activation.authContent]
      .filter((secret): secret is string => typeof secret === "string" && secret.length > 0)
    const output = (value: string) => redactText(value, secrets).slice(0, MAX_PROCESS_FAILURE_OUTPUT_CHARS)
    void process.result
      .then((result) => {
        if (result.exitCode !== 0 || result.signal !== null) {
          activation.failure = `SSH supervisor exited (exit code ${result.exitCode}, signal ${result.signal}); stdout=${output(result.stdout)}; stderr=${output(result.stderr)}`
        }
      })
      .catch((error) => {
        activation.failure = redactError(error, secrets)
      })
  }

  private async activeHealth(workspaceId: string, signal?: AbortSignal): Promise<{ healthy?: boolean; version?: string } | undefined> {
    const activation = this.active.get(workspaceId)
    if (!activation?.process || activation.process.alive === false) return undefined
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2_000)
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener("abort", abort, { once: true })
    try {
      if (signal?.aborted) return undefined
      const response = await this.fetcher(`http://127.0.0.1:${activation.localPort}/global/health`, {
        headers: { Authorization: basicAuthHeader(activation.password) },
        signal: controller.signal,
      })
      if (!response.ok) return undefined
      const value = await readHealthResponse(response, controller.signal)
      if (!isRecord(value)) return undefined
      return {
        ...(typeof value.healthy === "boolean" ? { healthy: value.healthy } : {}),
        ...(typeof value.version === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value.version) ? { version: value.version } : {}),
      }
    } catch {
      return undefined
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", abort)
    }
  }

  private assertActive(activation: Activation): void {
    if (activation.failure) throw new SandboxError("tunnel", activation.failure, "SUPERVISOR_EXITED")
  }

  private async readHead(): Promise<string> {
    return this.localGitText(["rev-parse", "HEAD"])
  }

  private async readRemoteUrl(): Promise<string> {
    return normalizePublicRemote(await this.localGitText(["remote", "get-url", "origin"]))
  }

  private async localGitText(args: string[]): Promise<string> {
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
    await this.remote(vm, [writer, root, encodePath(relative)], content, "bootstrap")
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

async function readHealthResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    return JSON.parse(await readLimitedBody(response, signal, "diagnose"))
  } catch {
    return undefined
  }
}

export function createExedevSandcastleAdapter(options: ExedevSandcastleAdapterOptions): OpenCodeSandboxAdapter {
  const { input, authContent, provider: suppliedProvider, ...providerOptions } = options
  const provider = suppliedProvider ?? new ExedevProvider({ ...providerOptions, authContent, deferActivation: true })
  let baseline: WorkingTreeCapture | undefined
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
      baseline = capture
    },
    syncBackWorkingTree: async ({ sandbox, worktreePath }) => {
      if (!baseline) throw new SandboxError("sync", "exe.dev working tree baseline is unavailable", "SYNC_BASELINE_UNAVAILABLE")
      let remoteTreeResult: Awaited<ReturnType<typeof sandbox.exec>>
      try {
        remoteTreeResult = await sandbox.exec("git rev-parse HEAD^{tree}")
      } catch (error) {
        if (error instanceof SandboxError) throw error
        throw new SandboxError("sync", redactError(error), "REMOTE_TREE")
      }
      if (remoteTreeResult.exitCode !== 0) {
        throw new SandboxError("sync", redactText(remoteTreeResult.stderr || "could not read the exe.dev Git tree"), "REMOTE_TREE")
      }
      const remoteTree = remoteTreeResult.stdout.trim()
      if (!/^[a-f0-9]{40}$/i.test(remoteTree)) {
        throw new SandboxError("sync", "exe.dev returned an invalid Git tree", "REMOTE_TREE")
      }
      await syncBackLocalWorkingTree(input.context, baseline, { worktreePath, remoteTree })
      baseline = await captureWorkingTree(input.context)
    },
    target: () => provider.target(info),
    close: () => provider.close(info),
    recoveryMetadata: () => {
      const metadata = provider.runtimeMetadata(input.workspaceId)
      return {
        ...(metadata?.providerState ?? {}),
        remoteWorktreePath: remoteWorkspaceDirectory(input.workspaceId),
        ...(metadata?.vmName ? { vmName: metadata.vmName } : {}),
        ...(metadata?.vmIdentity ? { vmIdentity: metadata.vmIdentity } : {}),
      }
    },
    processObservation: () => provider.processObservation(input.workspaceId),
    inspect: (signal?: AbortSignal) => provider.diagnose(info, signal),
    diagnose: (signal?: AbortSignal) => provider.diagnose(info, signal),
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

  let existing: string | undefined
  try {
    await assertPrivateFile(knownHostsFile)
    existing = await readFile(knownHostsFile, "utf8")
  } catch (error) {
    if (error instanceof SandboxError && error.code === "PATH_MISSING") {
      existing = undefined
    } else {
      throw error
    }
  }

  if (existing !== undefined) {
    const known = await runner.run({
      argv: [SSH_KEYGEN_BIN, "-F", host, "-f", knownHostsFile],
      env: sanitizeEnvironment(),
      maxOutputBytes: 32 * 1024,
    })
    if (known.exitCode === 0 && known.stdout.trim().length > 0) {
      await verifyHostKey(knownHostsFile, host, runner)
      return
    }
  }

  if (!EXEDEV_VM_HOST_PATTERN.test(host)) {
    throw new SandboxError("discover", "VM host key is not configured for the exact SSH destination", "VM_HOST_KEY_UNKNOWN")
  }

  const scanned = await runner.run({
    argv: [SSH_KEYSCAN_BIN, "-T", "5", "-t", "rsa", host],
    env: sanitizeEnvironment(),
    maxOutputBytes: 32 * 1024,
  })
  if (scanned.exitCode !== 0 || scanned.stdout.trim().length === 0) {
    throw new SandboxError("discover", "could not retrieve the exe.dev VM host key", "VM_HOST_KEY_SCAN")
  }
  const scannedEntry = exactScannedHostKeys(scanned.stdout, host)

  const temporary = `${knownHostsFile}.${randomBytes(8).toString("hex")}.tmp`
  await writeFile(temporary, scannedEntry, { encoding: "utf8", mode: 0o600, flag: "wx" })
  try {
    await assertPrivateFile(temporary)
    await verifyHostKey(temporary, host, runner)
    if (existing === undefined) {
      try {
        await writeFile(knownHostsFile, scannedEntry, { encoding: "utf8", mode: 0o600, flag: "wx" })
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error
        await assertPrivateFile(knownHostsFile)
        await verifyHostKey(knownHostsFile, host, runner)
        return
      }
    } else {
      const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
      await writeFile(knownHostsFile, `${separator}${scannedEntry}`, { encoding: "utf8", flag: "a" })
    }
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
  await assertPrivateFile(knownHostsFile)
}

function exactScannedHostKeys(output: string, host: string): string {
  const entries = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
  if (entries.length === 0 || entries.some((line) => {
    const fields = line.split(/\s+/)
    return fields.length < 3 || fields[0] !== host
  })) {
    throw new SandboxError("discover", "exe.dev VM scan returned an unexpected SSH destination", "VM_HOST_KEY_SCAN")
  }
  return `${entries.join("\n")}\n`
}

function readWorkspaceMetadata(info: WorkspaceInfo, from?: WorkspaceInfo): WorkspaceMetadata {
  assertWorkspaceInfo(info)
  if (from) assertWorkspaceInfo(from)
  const value = {
    ...(isRecord(from?.extra) ? from.extra : {}),
    ...(isRecord(info.extra) ? info.extra : {}),
  }
  if (value.providerState !== undefined && !isRecord(value.providerState)) {
    throw new SandboxError("validate", "workspace provider state is invalid", "PROVIDER_STATE_INVALID")
  }
  const state = isRecord(value.providerState) ? value.providerState : {}
  const field = (key: string): unknown => value[key] !== undefined ? value[key] : state[key]
  const provider = field("provider")
  if (provider !== undefined && provider !== "exedev") throw exedevOwnershipError()
  const sessionId = field("sessionId")
  if (sessionId !== undefined && (typeof sessionId !== "string" || !SAFE_IDENTIFIER.test(sessionId))) {
    throw new SandboxError("validate", "workspace session ID is invalid", "SESSION_ID")
  }
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
  if (Array.isArray(tags)) tags.forEach(assertSafeTag)
  const vmIdentityValue = field("vmIdentity")
  const vmIdentity = vmIdentityValue === undefined ? undefined : parseVmIdentity(vmIdentityValue)
  if (vmIdentityValue !== undefined && !vmIdentity) {
    throw new SandboxError("validate", "workspace VM identity is invalid", "VM_IDENTITY_INVALID")
  }
  if (vmIdentity && vmIdentity.name !== info.name) throw exedevOwnershipError()
  const remoteDirectory = field("remoteDirectory")
  if (remoteDirectory !== undefined) {
    if (typeof remoteDirectory !== "string") throw new SandboxError("validate", "workspace runtime directory is invalid", "RUNTIME_DIRECTORY")
    assertRemotePath(remoteDirectory, "workspace runtime directory")
  }
  const remoteWorktreePath = field("remoteWorktreePath")
  if (remoteWorktreePath !== undefined && (
    typeof remoteWorktreePath !== "string" ||
    remoteWorktreePath !== remoteWorkspaceDirectory(info.id)
  )) {
    throw new SandboxError("validate", "workspace checkout path is not plugin-owned", "WORKSPACE_DIRECTORY")
  }
  const comment = field("comment")
  if (comment !== undefined && typeof comment !== "string") {
    throw new SandboxError("validate", "workspace VM comment is invalid", "COMMENT_INVALID")
  }
  if (typeof comment === "string" && comment) assertSafeComment(comment)
  return {
    sessionId: typeof sessionId === "string" ? sessionId : info.id,
    generation: typeof generation === "number" ? generation : 1,
    baseSha: typeof baseSha === "string" ? baseSha : undefined,
    tags: Array.isArray(tags) ? [...tags] : undefined,
    comment: typeof comment === "string" ? comment : undefined,
    vmIdentity,
    remoteDirectory: typeof remoteDirectory === "string" ? remoteDirectory : undefined,
    remoteWorktreePath: typeof remoteWorktreePath === "string" ? remoteWorktreePath : undefined,
  }
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

function assertWorkspaceInfo(value: unknown): asserts value is WorkspaceInfo {
  if (!isRecord(value) || value.type !== "exedev") throw exedevOwnershipError()
  if (
    typeof value.id !== "string" ||
    !SAFE_IDENTIFIER.test(value.id) ||
    typeof value.name !== "string" ||
    typeof value.projectID !== "string" ||
    !SAFE_IDENTIFIER.test(value.projectID) ||
    (value.branch !== null && typeof value.branch !== "string") ||
    (value.directory !== null && typeof value.directory !== "string") ||
    (value.extra !== undefined && value.extra !== null && !isRecord(value.extra))
  ) throw new SandboxError("validate", "exe.dev workspace info is invalid", "EXEDEV_WORKSPACE_INVALID")

  assertSafeVmName(value.name)
  if (typeof value.branch === "string") assertSafeBranch(value.branch)
  if (typeof value.directory === "string" && (!isAbsolute(value.directory) || /[\0\n\r]/.test(value.directory))) {
    throw new SandboxError("validate", "workspace directory is invalid", "EXEDEV_WORKSPACE_INVALID")
  }
}

function classifyVmHealth(status: string | undefined): ProviderResourceObservation["health"] {
  if (!status) return "unknown"
  const normalized = status.trim().toLowerCase()
  if (["running", "ready", "online", "active"].includes(normalized)) return "healthy"
  if (["created", "dead", "exited", "paused", "stopped", "powered_off"].includes(normalized)) return "degraded"
  return "unknown"
}

function parseVmIdentity(value: unknown): VmIdentity | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.sshDest !== "string") return undefined
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string")) return undefined
  if (value.comment !== undefined && typeof value.comment !== "string") return undefined
  for (const key of ["id", "sshUser", "sshHost", "region"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length === 0)) return undefined
  }
  const tags = value.tags
  try {
    assertSafeVmName(value.name)
    assertSafeSshDestination(value.sshDest)
    tags.forEach(assertSafeTag)
    if (typeof value.comment === "string" && value.comment) assertSafeComment(value.comment)
  } catch {
    return undefined
  }
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

function validateVmInventory(value: unknown): VmInfo[] {
  if (!Array.isArray(value)) throw exedevSchemaError("exe.dev VM inventory is not an array")
  return value.map((item) => validateVmInfo(item))
}

function validateVmInfo(value: unknown): VmInfo {
  if (!isRecord(value)) throw exedevSchemaError("exe.dev VM response is not an object")
  const identity = parseVmIdentity(value.identity)
  if (!identity) throw exedevSchemaError("exe.dev VM identity is invalid")
  if (value.status !== undefined && (typeof value.status !== "string" || value.status.length === 0)) {
    throw exedevSchemaError("exe.dev VM status is invalid")
  }
  return {
    identity,
    ...(value.status !== undefined ? { status: value.status } : {}),
  }
}

function exedevSchemaError(message: string): SandboxError {
  return new SandboxError("discover", message, "EXEDEV_SCHEMA")
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
    const fingerprints = result.stdout.match(/SHA256:[A-Za-z0-9+/=]+/g) ?? []
    if (result.exitCode !== 0 || fingerprints.length === 0 || fingerprints.some((fingerprint) => fingerprint !== EXEDEV_HOST_FINGERPRINT)) {
      throw new SandboxError("discover", "exe.dev host key does not match the official fingerprint", "HOST_KEY_MISMATCH")
    }
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

function assertRemotePath(path: string, label: string): void {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(path) || path.includes("..")) throw new SandboxError("validate", `${label} is unsafe`, "PATH_INVALID")
}

function assertRuntimeDirectory(path: string): void {
  if (!/^\/tmp\/oe-[a-f0-9]{12}$/.test(path)) throw exedevOwnershipError()
}

function runtimePathsForDirectory(remoteDirectory: string): RuntimePaths {
  assertRuntimeDirectory(remoteDirectory)
  return {
    remoteDirectory,
    remoteControlSocket: `${remoteDirectory}/c.sock`,
    remoteLauncherPath: `${remoteDirectory}/launcher`,
    remoteCliPath: `${remoteDirectory}/bin/sandboxctl`,
    remoteCommandPath: `${remoteDirectory}/config/command/sandbox.md`,
    remoteWriteFilePath: `${remoteDirectory}/write-file`,
  }
}

function metadataForActivation(activation: Activation): ExedevRuntimeMetadata {
  return {
    provider: "exedev",
    projectId: activation.projectId,
    sessionId: activation.sessionId,
    generation: activation.generation,
    workspaceId: activation.workspaceId,
    branch: activation.branch,
    baseSha: activation.baseSha,
    remoteDirectory: activation.paths.remoteDirectory,
    remoteWorktreePath: activation.directory,
    vmName: activation.vm.identity.name,
    vmIdentity: copyVmIdentity(activation.vm.identity),
  }
}

function parseExedevRuntimeMetadata(value: unknown): ExedevRuntimeMetadata {
  if (!isRecord(value) || value.provider !== "exedev") throw new SandboxError("discover", "exe.dev durable metadata is invalid", "EXEDEV_METADATA")
  const strings = ["projectId", "sessionId", "workspaceId", "branch", "baseSha", "remoteDirectory", "vmName"]
  if (strings.some((key) => typeof value[key] !== "string" || value[key] === "")) {
    throw new SandboxError("discover", "exe.dev durable metadata is incomplete", "EXEDEV_METADATA")
  }
  const projectId = value.projectId as string
  const sessionId = value.sessionId as string
  const workspaceId = value.workspaceId as string
  const branch = value.branch as string
  const baseSha = value.baseSha as string
  const remoteDirectory = value.remoteDirectory as string
  const remoteWorktreePathValue = value.remoteWorktreePath
  const remoteWorktreePath = remoteWorktreePathValue === undefined
    ? remoteWorkspaceDirectory(workspaceId)
    : remoteWorktreePathValue
  const vmName = value.vmName as string
  if (!SAFE_IDENTIFIER.test(projectId) || !SAFE_IDENTIFIER.test(sessionId) || !SAFE_IDENTIFIER.test(workspaceId)) {
    throw new SandboxError("discover", "exe.dev durable owner metadata is invalid", "EXEDEV_METADATA")
  }
  if (typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1) {
    throw new SandboxError("discover", "exe.dev durable generation is invalid", "EXEDEV_METADATA")
  }
  assertSafeBranch(branch)
  assertSha(baseSha)
  assertRuntimeDirectory(remoteDirectory)
  if (typeof remoteWorktreePath !== "string" || remoteWorktreePath !== remoteWorkspaceDirectory(workspaceId)) {
    throw new SandboxError("discover", "exe.dev durable checkout path is not plugin-owned", "EXEDEV_METADATA")
  }
  assertSafeVmName(vmName)
  const vmIdentity = parseVmIdentity(value.vmIdentity)
  if (!vmIdentity || vmIdentity.name !== vmName) {
    throw new SandboxError("discover", "exe.dev durable VM identity is invalid", "EXEDEV_METADATA")
  }
  return {
    provider: "exedev",
    projectId,
    sessionId,
    generation: value.generation,
    workspaceId,
    branch,
    baseSha,
    remoteDirectory,
    remoteWorktreePath,
    vmName,
    vmIdentity,
  }
}

function sameRuntimeOwner(metadata: ExedevRuntimeMetadata, owner: RuntimeOwner): boolean {
  return metadata.provider === owner.provider &&
    metadata.projectId === owner.projectId &&
    metadata.sessionId === owner.sessionId &&
    metadata.generation === owner.generation &&
    metadata.workspaceId === owner.workspaceId &&
    metadata.branch === owner.branch &&
    metadata.baseSha === owner.baseSha
}

function resourceMatchesIdentity(resource: RuntimeResourceReference, identity: VmIdentity): boolean {
  return resource.resourceId === identity.name || resource.resourceId === identity.id
}

function resourceIdForIdentity(identity: VmIdentity): string {
  return identity.id ?? identity.name
}

function hasOwnerTagForMetadata(metadata: ExedevRuntimeMetadata, identity: VmIdentity): boolean {
  return identity.tags.includes("opencode-sandbox") && identity.tags.includes(exedevOwnerTagForValues(metadata))
}

function exedevOwnerTagForValues(metadata: Pick<ExedevRuntimeMetadata, "projectId" | "sessionId" | "workspaceId" | "generation">): string {
  return `opencode-owner-${shortHash(`${metadata.projectId}:${metadata.sessionId}:${metadata.workspaceId}:${metadata.generation}`)}`
}

function assertAdoptableExedev(observation: ProviderResourceObservation): void {
  if (observation.ownership === "conflict") {
    throw new SandboxError("adopt", "exe.dev VM ownership conflicts with the lifecycle record", "EXEDEV_ADOPT_CONFLICT")
  }
  if (observation.resource !== "present" || observation.ownership !== "verified" || observation.health === "unknown") {
    throw new SandboxError("adopt", "exe.dev VM ownership or health is unknown", "EXEDEV_ADOPT_UNKNOWN")
  }
  if (observation.health !== "healthy") {
    throw new SandboxError("adopt", "stopped exe.dev VMs cannot be resumed without provider mutation", "EXEDEV_ADOPT_UNSUPPORTED")
  }
}

function assertDestructibleExedev(observation: ProviderResourceObservation): void {
  if (observation.ownership === "conflict" || observation.resource !== "present" || observation.ownership !== "verified") {
    throw new SandboxError("remove", "exe.dev VM ownership could not be verified", "EXEDEV_OWNERSHIP_UNVERIFIED")
  }
}

function adoptionUnknown(error: unknown): SandboxError {
  if (error instanceof SandboxError && ["EXEDEV_ADOPT_CONFLICT", "EXEDEV_ADOPT_CHECKOUT", "EXEDEV_ADOPT_UNSUPPORTED"].includes(error.code)) return error
  return new SandboxError("adopt", "exe.dev VM state is unknown", "EXEDEV_ADOPT_UNKNOWN")
}

function workspaceInfoForActivation(activation: Activation): WorkspaceInfo {
  return {
    id: activation.workspaceId,
    type: "exedev",
    name: activation.vm.identity.name,
    branch: activation.branch,
    directory: activation.directory,
    projectID: activation.projectId,
    extra: {
      sessionId: activation.sessionId,
      generation: activation.generation,
      providerState: metadataForActivation(activation),
      vmName: activation.vm.identity.name,
      vmIdentity: copyVmIdentity(activation.vm.identity),
    },
  }
}

async function makeTemporarySyncRoot(worktree: string, workspaceId: string): Promise<string> {
  return mkdtemp(join(dirname(worktree), `.opencode-exedev-sync-${shortHash(workspaceId)}-`))
}

async function removeTemporarySyncRoot(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

function exedevOwnerTag(info: WorkspaceInfo, metadata: WorkspaceMetadata): string {
  return `opencode-owner-${shortHash(`${info.projectID}:${metadata.sessionId}:${info.id}:${metadata.generation}`)}`
}

function hasOwnerTag(info: WorkspaceInfo, metadata: WorkspaceMetadata, identity: VmIdentity): boolean {
  return identity.tags.includes(exedevOwnerTag(info, metadata))
}

function identityDifferenceFields(expected: VmIdentity, observed: VmIdentity): string[] {
  const differences: Array<keyof VmIdentity> = (["id", "name", "sshDest", "sshUser", "sshHost", "region", "comment"] as const)
    .filter((field) => expected[field] !== observed[field])
  const expectedTags = [...expected.tags].sort()
  const observedTags = [...observed.tags].sort()
  if (expectedTags.length !== observedTags.length || expectedTags.some((tag, index) => tag !== observedTags[index])) {
    differences.push("tags")
  }
  return differences
}

function exedevOwnershipError(message = "exe.dev VM ownership could not be verified"): SandboxError {
  return new SandboxError("remove", message, "EXEDEV_OWNERSHIP_UNVERIFIED")
}

function encodePath(value: string): string {
  return Buffer.from(value).toString("base64url")
}

async function waitForProcess(process: ProcessHandle): Promise<void> {
  await Promise.race([process.result.catch(() => undefined), delay(3_000)])
}
