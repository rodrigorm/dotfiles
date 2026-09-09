import { randomBytes, timingSafeEqual } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, posix } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

import { createIsolatedSandboxProvider, type IsolatedSandboxHandle } from "@ai-hero/sandcastle"

import {
  assertSandboxId,
  CloudflareBridgeClient,
  waitForAbort,
  type CloudflareSandboxClient,
  type CloudflareTunnelInfo,
} from "./cloudflare-bridge"
import { basicAuthHeader } from "./remote-runtime"
import { nodeProcessRunner, sanitizeEnvironment } from "./process"
import { assertRelativePath, assertSafeBranch, assertSha, quoteRemoteCommandPart, sha256, shortHash } from "./naming"
import { redactError, redactText } from "./redaction"
import { readLimitedBody } from "./workspace-http"
import { requestControl } from "./cli"
import type { OpenCodeSandboxAdapter, SandcastleAdapterInput } from "./sandcastle-session"
import {
  isNodeError,
  isRecord,
  SandboxError,
  type ProcessResult,
  type ProcessRunner,
  type ProviderResourceObservation,
  type WorkspaceInfo,
  type WorkspaceProviderBase,
  type WorkspaceRuntimeMetadata,
  type WorkspaceTarget,
  type WorkingTreeCapture,
} from "./types"

const REMOTE_DIRECTORY = "/workspace"
const REMOTE_CHECKOUT_DIRECTORY = `${REMOTE_DIRECTORY}/.opencode-worktree`
const DEFAULT_REMOTE_PORT = 4096
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 600_000
const DEFAULT_OPENCODE_VERSION = "1.18.23"
const MAX_OUTPUT_BYTES = 256 * 1024
const TRANSFER_DIRECTORY = `${REMOTE_DIRECTORY}/.opencode-sandbox/transfers`

const BOOTSTRAP = (version: string) => `set -eu
command -v git >/dev/null 2>&1
command -v bun >/dev/null 2>&1
if ! command -v opencode >/dev/null 2>&1; then
    bun install --global opencode-ai@${shellQuote(version)}
fi
test "$(opencode --version 2>/dev/null)" = ${shellQuote(version)}
`

const REMOTE_SANDBOXCTL = `#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec bun "$script_dir/../.config/opencode/sandbox/cli.ts" "$@"
`

export interface CloudflareProviderOptions {
  worktree: string
  apiUrl?: string | URL
  apiKey?: string
  client?: CloudflareSandboxClient
  runner?: ProcessRunner
  fetcher?: typeof fetch
  remotePort?: number
  healthTimeoutMs?: number
  bootstrapTimeoutMs?: number
  openCodeVersion?: string
  deferActivation?: boolean
  localControlSocket?: string
  controlTokenFor?: (sessionId: string) => Promise<string>
  revokeControlToken?: (token: string) => void
  assetDirectory?: string
}

interface CloudflareMetadata {
  sessionId: string
  generation: number
  workspaceId: string
  projectId: string
  sandboxId?: string
  branch?: string
  baseSha?: string
  checkoutHead?: string
  tunnelName?: string
}

interface Activation {
  provider: "cloudflare"
  sessionId: string
  generation: number
  workspaceId: string
  projectId: string
  sandboxId: string
  branch: string
  baseSha: string
  checkoutHead: string
  tunnelName: string
  tunnel?: CloudflareTunnelInfo
  password: string
  authContent?: string
  controlDirectory?: string
  controlToken?: string
  controlPoller?: Promise<void>
  closed?: boolean
}

interface CloudflareOwner {
  provider: "cloudflare"
  sessionId: string
  generation: number
  workspaceId: string
  projectId: string
}

export class CloudflareProvider implements WorkspaceProviderBase {
  readonly type = "cloudflare"
  readonly name = "Cloudflare Sandbox"
  private readonly client: CloudflareSandboxClient
  private readonly worktree: string
  private readonly runner: ProcessRunner
  private readonly fetcher: typeof fetch
  private readonly remotePort: number
  private readonly healthTimeoutMs: number
  private readonly bootstrapTimeoutMs: number
  private readonly openCodeVersion: string
  private readonly deferActivation: boolean
  private readonly localControlSocket?: string
  private readonly controlTokenFor?: (sessionId: string) => Promise<string>
  private readonly revokeControlToken?: (token: string) => void
  private readonly assetDirectory: string
  private readonly active = new Map<string, Activation>()
  private readonly owned = new Map<string, CloudflareOwner>()

  constructor(options: CloudflareProviderOptions) {
    this.client = options.client ?? createClient(options)
    this.worktree = options.worktree
    this.runner = options.runner ?? nodeProcessRunner
    this.fetcher = options.fetcher ?? fetch
    this.remotePort = options.remotePort ?? DEFAULT_REMOTE_PORT
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
    this.bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS
    this.openCodeVersion = options.openCodeVersion ?? DEFAULT_OPENCODE_VERSION
    this.deferActivation = options.deferActivation ?? false
    this.localControlSocket = options.localControlSocket
    this.controlTokenFor = options.controlTokenFor
    this.revokeControlToken = options.revokeControlToken
    this.assetDirectory = options.assetDirectory ?? fileURLToPath(new URL(".", import.meta.url))

    if (!Number.isSafeInteger(this.remotePort) || this.remotePort < 1024 || this.remotePort > 65535 || this.remotePort === 3000) {
      throw new SandboxError("validate", "Cloudflare remote port is invalid or reserved", "CLOUDFLARE_PORT")
    }
    if (!/^[A-Za-z0-9._-]+$/.test(this.openCodeVersion)) {
      throw new SandboxError("validate", "OpenCode version is unsafe", "OPENCODE_VERSION")
    }
  }

  get description(): string {
    return `OpenCode workspace backed by a Cloudflare Sandbox (OpenCode ${this.openCodeVersion})`
  }

  configure(info: WorkspaceInfo): WorkspaceInfo {
    const suffix = shortHash(info.id)
    return {
      ...info,
      name: `oc-cf-${suffix}`,
      branch: info.branch ?? this.branch(info.id),
      directory: this.checkoutDirectory(),
    }
  }

  branch(workspaceId: string): string {
    return `opencode/sandbox-${shortHash(workspaceId)}`
  }

  async prepare(info: WorkspaceInfo, env: Record<string, string | undefined>, from?: WorkspaceInfo): Promise<void> {
    const metadata = readMetadata(info, from)
    const active = this.active.get(info.id)
    if (active) {
      const expected = ownerFromMetadata(metadata)
      if (metadata.sandboxId !== active.sandboxId || !sameOwner(active, expected)) throw cloudflareOwnershipError()
      this.assertOwned(active.sandboxId, expected)
      return
    }
    const branch = info.branch ?? metadata.branch ?? this.branch(info.id)
    assertSafeBranch(branch)
    const baseSha = metadata.baseSha ?? (await this.readHead())
    assertSha(baseSha)
    const authContent = env.OPENCODE_AUTH_CONTENT
    if (!authContent) throw new SandboxError("bootstrap", "OpenCode auth content is unavailable", "AUTH_UNAVAILABLE")

    const owner = ownerFromMetadata(metadata)
    const workspace = await this.ensureSandbox(metadata, branch, baseSha, owner)
    const password = randomBytes(32).toString("base64url")
    const tunnelName = metadata.tunnelName ?? tunnelNameFor(info.id)
    const controlEnabled = Boolean(this.localControlSocket || this.controlTokenFor)
    let controlToken: string | undefined
    let activation: Activation | undefined
    try {
      if (!this.deferActivation) await this.ignoreRuntime(workspace.sandboxId)
      await this.bootstrap(workspace.sandboxId)
      if (controlEnabled && (!this.localControlSocket || !this.controlTokenFor)) {
        throw new SandboxError("control_channel", "Cloudflare control transport is unavailable", "CONTROL_CHANNEL")
      }
      controlToken = controlEnabled ? await this.controlTokenFor!(metadata.sessionId ?? info.id) : undefined
      if (controlEnabled && !controlToken) {
        throw new SandboxError("control_channel", "Cloudflare control token is unavailable", "CONTROL_CHANNEL")
      }
      const controlDirectory = controlEnabled ? `${runtimeDirectory(info.id)}/control` : undefined
      if (controlDirectory) await this.installControlRuntime(workspace.sandboxId, runtimeDirectory(info.id), controlDirectory)
      activation = {
        ...owner,
        sandboxId: workspace.sandboxId,
        branch,
        baseSha,
        checkoutHead: workspace.checkoutHead,
        tunnelName,
        password,
        authContent,
        controlDirectory,
        controlToken,
      }
      this.active.set(info.id, activation)
      if (controlDirectory && controlToken) this.startControlPoller(activation)
      if (!this.deferActivation) await this.activate(info.id)
      info.directory = this.checkoutDirectory()
      info.extra = {
        ...(isRecord(info.extra) ? info.extra : {}),
        providerState: metadataFor(activation),
      }
    } catch (error) {
      if (activation) activation.closed = true
      if (controlToken) this.revokeControlToken?.(controlToken)
      this.active.delete(info.id)
      await this.cleanupRuntime(workspace.sandboxId, info.id).catch(() => undefined)
      if (workspace.created) {
        await this.destroyIfPresent(workspace.sandboxId)
        this.owned.delete(workspace.sandboxId)
      }
      throw error instanceof SandboxError ? error : new SandboxError("bootstrap", redactError(error), "CLOUDFLARE_PROVISION")
    }
  }

  async activate(workspaceId: string): Promise<void> {
    const activation = this.active.get(workspaceId)
    if (!activation) throw new SandboxError("bootstrap", "Cloudflare sandbox runtime is not active", "RUNTIME_UNAVAILABLE")
    if (activation.tunnel) return
    if (!activation.authContent) throw new SandboxError("bootstrap", "OpenCode auth content is unavailable", "AUTH_UNAVAILABLE")

    await this.startServer(activation)
    activation.tunnel = await this.client.tunnel(activation.sandboxId, this.remotePort, activation.tunnelName)
    await this.waitForHealth(activation)
  }

  async syncIn(workspaceId: string, capture: WorkingTreeCapture): Promise<void> {
    const activation = this.active.get(workspaceId)
    if (!activation) throw new SandboxError("sync", "Cloudflare sandbox runtime is not active", "RUNTIME_UNAVAILABLE")
    if (capture.baseSha !== activation.baseSha) {
      throw new SandboxError("sync", "working tree capture does not match the Cloudflare checkout", "CAPTURE_SHA_MISMATCH")
    }
    const checkoutDirectory = this.checkoutDirectory()

    if (capture.patch) {
      const patchPath = `${runtimeDirectory(workspaceId)}/capture-${randomBytes(8).toString("hex")}.patch`
      await this.client.putFile(activation.sandboxId, patchPath, new TextEncoder().encode(capture.patch))
      try {
        await this.run(
          activation.sandboxId,
          { argv: ["git", "-C", checkoutDirectory, "apply", "--binary", "--", patchPath] },
          "sync",
        )
      } finally {
        await this.removeFile(activation.sandboxId, patchPath)
      }
    }

    for (const file of capture.untracked) {
      assertRelativePath(file.path)
      if (sha256(file.content) !== file.sha256) throw new SandboxError("sync", `working tree hash mismatch: ${file.path}`, "CAPTURE_HASH")
      const path = `${checkoutDirectory}/${file.path}`
      await this.run(activation.sandboxId, { argv: ["mkdir", "-p", "--", posix.dirname(path)] }, "sync")
      await this.client.putFile(activation.sandboxId, path, file.content)
    }
  }

  async target(info: WorkspaceInfo): Promise<WorkspaceTarget> {
    const activation = this.active.get(info.id)
    if (!activation) throw new SandboxError("tunnel", "Cloudflare sandbox runtime is not active", "RUNTIME_UNAVAILABLE")
    if (!activation.tunnel) throw new SandboxError("tunnel", "Cloudflare sandbox tunnel is not active", "RUNTIME_UNAVAILABLE")
    return {
      type: "remote",
      url: activation.tunnel.url,
      headers: { Authorization: basicAuthHeader(activation.password) },
    }
  }

  runtimeMetadata(workspaceId: string): WorkspaceRuntimeMetadata | undefined {
    const activation = this.active.get(workspaceId)
    return activation ? { providerState: metadataFor(activation) } : undefined
  }

  async inspect(info: WorkspaceInfo, signal?: AbortSignal): Promise<ProviderResourceObservation> {
    const metadata = readMetadata(info)
    const activation = this.active.get(info.id)
    const sandboxId = activation?.sandboxId ?? metadata.sandboxId
    if (!sandboxId) {
      return {
        resourceId: info.id,
        resource: "unknown",
        ownership: "unknown",
        health: "unknown",
        evidence: ["Cloudflare sandbox identity is unavailable"],
      }
    }

    let running: boolean
    try {
      running = await this.client.running(sandboxId, signal)
    } catch (error) {
      if (isNotFound(error)) {
        return { resourceId: sandboxId, resource: "absent", ownership: "unknown", health: "unknown", evidence: [`Cloudflare sandbox:${sandboxId}`] }
      }
      throw error
    }

    const ownership = sameOwner(this.owned.get(sandboxId), ownerFromMetadata(metadata)) ? "verified" as const : "unknown" as const
    if (!running) {
      return { resourceId: sandboxId, resource: "present", ownership, health: "degraded", evidence: [`Cloudflare sandbox:${sandboxId}`] }
    }

    return {
      resourceId: sandboxId,
      resource: "present",
      ownership,
      health: "unknown",
      evidence: [`Cloudflare sandbox:${sandboxId}`],
    }
  }

  async diagnose(info: WorkspaceInfo, signal?: AbortSignal): Promise<ProviderResourceObservation> {
    const observation = await this.inspect(info, signal)
    const activation = this.active.get(info.id)
    const health = activation && observation.resource === "present" && observation.health !== "degraded"
      ? await this.activeHealth(activation, signal)
      : undefined
    if (!health) return observation
    return {
      ...observation,
      ...(health.healthy === true ? { health: "healthy" as const } : {}),
      ...(health.healthy === false ? { health: "degraded" as const } : {}),
      ...(health.version ? { remoteVersion: health.version } : {}),
    }
  }

  createIsolatedHandle(info: WorkspaceInfo): IsolatedSandboxHandle {
    const activation = this.active.get(info.id)
    if (!activation) throw new SandboxError("provision", "Cloudflare sandbox runtime is not active", "RUNTIME_UNAVAILABLE")

    let closing: Promise<void> | undefined
    return {
      worktreePath: this.checkoutDirectory(),
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
      return
    } catch (error) {
      failure ??= error
    }
    throw failure
  }

  async release(info: WorkspaceInfo): Promise<void> {
    const activation = this.active.get(info.id)
    const metadata = readMetadata(info)
    const sandboxId = activation?.sandboxId ?? metadata.sandboxId
    if (!sandboxId) throw new SandboxError("remove", "Cloudflare sandbox identity is unavailable", "CLOUDFLARE_ID_UNAVAILABLE")
    const expected = ownerFromMetadata(metadata)
    if (activation && (metadata.sandboxId !== activation.sandboxId || !sameOwner(activation, expected))) throw cloudflareOwnershipError()
    this.assertOwned(sandboxId, expected)
    if (activation) activation.closed = true
    if (activation?.controlToken) this.revokeControlToken?.(activation.controlToken)
    await this.cleanupRuntime(sandboxId, info.id)
    this.active.delete(info.id)
  }

  async destroy(info: WorkspaceInfo): Promise<void> {
    const activation = this.active.get(info.id)
    const metadata = readMetadata(info)
    const sandboxId = activation?.sandboxId ?? metadata.sandboxId
    if (!sandboxId) throw new SandboxError("remove", "Cloudflare sandbox identity is unavailable", "CLOUDFLARE_ID_UNAVAILABLE")
    const expected = ownerFromMetadata(metadata)
    if (activation && (metadata.sandboxId !== activation.sandboxId || !sameOwner(activation, expected))) throw cloudflareOwnershipError()
    this.assertOwned(sandboxId, expected)
    await this.destroyIfPresent(sandboxId)
    this.owned.delete(sandboxId)
    this.active.delete(info.id)
  }

  async dispose(): Promise<void> {
    const activations = [...this.active.values()]
    for (const activation of activations) this.assertOwned(activation.sandboxId, activation)
    for (const activation of activations) {
      activation.closed = true
      if (activation.controlToken) this.revokeControlToken?.(activation.controlToken)
    }
    const results = await Promise.allSettled(activations.map(async (activation) => {
      await this.cleanupRuntime(activation.sandboxId, activation.workspaceId)
      this.active.delete(activation.workspaceId)
      this.owned.delete(activation.sandboxId)
    }))
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
    if (failure) throw failure.reason
  }

  private async ensureSandbox(
    metadata: CloudflareMetadata,
    branch: string,
    baseSha: string,
    owner: CloudflareOwner,
  ): Promise<{ sandboxId: string; created: boolean; checkoutHead: string }> {
    if (metadata.sandboxId) {
      this.assertOwned(metadata.sandboxId, owner)
      if (metadata.baseSha !== baseSha || !metadata.checkoutHead) throw cloudflareOwnershipError()
      try {
        if (await this.client.running(metadata.sandboxId) && await this.hasGitWorkspace(metadata.sandboxId)) {
          await this.ensureHead(metadata.sandboxId, metadata.checkoutHead)
          await this.ensureBranch(metadata.sandboxId, branch)
          return { sandboxId: metadata.sandboxId, created: false, checkoutHead: metadata.checkoutHead }
        }
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
      throw new SandboxError("provision", "owned Cloudflare sandbox is unavailable", "CLOUDFLARE_RESOURCE_UNAVAILABLE")
    }

    const sandboxId = await this.client.createSandbox()
    this.owned.set(sandboxId, owner)
    let checkoutHead: string
    try {
      if (this.deferActivation) {
        await this.run(sandboxId, { argv: ["mkdir", "-p", "--", this.checkoutDirectory()] }, "checkout")
        checkoutHead = baseSha
      } else {
        const archive = await this.createArchive(baseSha)
        await this.client.hydrate(sandboxId, archive)
        checkoutHead = await this.initializeWorkspace(sandboxId, branch)
      }
    } catch (error) {
      await this.destroyIfPresent(sandboxId)
      this.owned.delete(sandboxId)
      throw error
    }
    return { sandboxId, created: true, checkoutHead }
  }

  private assertOwned(sandboxId: string, expected: CloudflareOwner): void {
    if (!sameOwner(this.owned.get(sandboxId), expected)) {
      throw cloudflareOwnershipError()
    }
  }

  private checkoutDirectory(): string {
    return this.deferActivation ? REMOTE_CHECKOUT_DIRECTORY : REMOTE_DIRECTORY
  }

  private async hasGitWorkspace(sandboxId: string): Promise<boolean> {
    const result = await this.client.exec(sandboxId, {
      argv: ["git", "-C", this.checkoutDirectory(), "rev-parse", "--is-inside-work-tree"],
      timeoutMs: this.bootstrapTimeoutMs,
    })
    return result.exitCode === 0 && result.stdout.trim() === "true"
  }

  private async ensureBranch(sandboxId: string, branch: string): Promise<void> {
    const current = await this.client.exec(sandboxId, {
      argv: ["git", "-C", this.checkoutDirectory(), "symbolic-ref", "--short", "HEAD"],
      timeoutMs: this.bootstrapTimeoutMs,
    })
    if (current.exitCode === 0 && current.stdout.trim() === branch) return
    const dirty = await this.run(
      sandboxId,
      { argv: ["git", "-C", this.checkoutDirectory(), "status", "--porcelain", "--untracked-files=all"] },
      "checkout",
    )
    if (dirty.stdout.trim()) throw new SandboxError("checkout", "existing Cloudflare checkout has uncommitted changes", "REMOTE_DIRTY")
    await this.run(sandboxId, { argv: ["git", "-C", this.checkoutDirectory(), "checkout", "-B", branch] }, "checkout")
  }

  private async ensureHead(sandboxId: string, expectedHead: string): Promise<void> {
    const current = await this.run(
      sandboxId,
      { argv: ["git", "-C", this.checkoutDirectory(), "rev-parse", "HEAD"] },
      "checkout",
    )
    if (current.stdout.trim() !== expectedHead) {
      throw new SandboxError("checkout", "existing Cloudflare checkout is at a different revision", "REMOTE_SHA_MISMATCH")
    }
  }

  private async initializeWorkspace(sandboxId: string, branch: string): Promise<string> {
    const checkoutDirectory = this.checkoutDirectory()
    await this.run(sandboxId, { argv: ["git", "-C", checkoutDirectory, "init"] }, "checkout")
    await this.run(sandboxId, { argv: ["git", "-C", checkoutDirectory, "config", "user.email", "opencode@localhost"] }, "checkout")
    await this.run(sandboxId, { argv: ["git", "-C", checkoutDirectory, "config", "user.name", "OpenCode Sandbox"] }, "checkout")
    await this.run(sandboxId, { argv: ["git", "-C", checkoutDirectory, "checkout", "-B", branch] }, "checkout")
    await this.run(sandboxId, { argv: ["git", "-C", checkoutDirectory, "add", "-A"] }, "checkout")
    await this.run(
      sandboxId,
      { argv: ["git", "-C", checkoutDirectory, "commit", "--allow-empty", "-m", "opencode: initialize sandbox workspace"] },
      "checkout",
    )
    const head = await this.run(sandboxId, { argv: ["git", "-C", checkoutDirectory, "rev-parse", "HEAD"] }, "checkout")
    assertSha(head.stdout.trim())
    return head.stdout.trim()
  }

  private async createArchive(baseSha: string): Promise<Uint8Array> {
    const directory = await mkdtemp(join(tmpdir(), "opencode-cloudflare-"))
    const archive = join(directory, "workspace.tar")
    try {
      const result = await this.runner.run({
        argv: ["git", "-C", this.worktree, "archive", "--format=tar", baseSha, "-o", archive],
        cwd: this.worktree,
        env: sanitizeEnvironment(),
        timeoutMs: this.bootstrapTimeoutMs,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      })
      if (result.exitCode !== 0) throw new SandboxError("checkout", redactText(result.stderr || result.stdout || "could not archive workspace"), "GIT_ARCHIVE")
      // ponytail: hydrate is capped at 32 MiB; use a remote clone/import path for larger repositories.
      return new Uint8Array(await readFile(archive))
    } catch (error) {
      if (error instanceof SandboxError) throw error
      throw new SandboxError("checkout", redactError(error), "GIT_ARCHIVE")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  private async bootstrap(sandboxId: string): Promise<void> {
    await this.run(sandboxId, { argv: ["sh", "-lc", BOOTSTRAP(this.openCodeVersion)], timeoutMs: this.bootstrapTimeoutMs }, "bootstrap")
  }

  private async ignoreRuntime(sandboxId: string): Promise<void> {
    const excludeFile = `${REMOTE_DIRECTORY}/.git/info/exclude`
    await this.run(
      sandboxId,
      {
        argv: [
          "sh",
          "-lc",
          `grep -qxF '/.opencode-sandbox/' ${shellQuote(excludeFile)} || printf '%s\\n' '/.opencode-sandbox/' >> ${shellQuote(excludeFile)}`,
        ],
      },
      "bootstrap",
    )
  }

  private async installControlRuntime(sandboxId: string, runtime: string, controlDirectory: string): Promise<void> {
    const assets = await this.assets()
    const sandboxDirectory = `${runtime}/.config/opencode/sandbox`
    const configDirectory = `${runtime}/config/command`
    const binDirectory = `${runtime}/bin`
    await this.run(
      sandboxId,
      { argv: ["mkdir", "-p", "--", runtime, binDirectory, sandboxDirectory, configDirectory, controlDirectory] },
      "bootstrap",
    )
    const files: Array<[string, string]> = [
      [`${runtime}/bin/sandboxctl`, REMOTE_SANDBOXCTL],
      [`${sandboxDirectory}/cli.ts`, assets.cli],
      [`${sandboxDirectory}/redaction.ts`, assets.redaction],
      [`${sandboxDirectory}/types.ts`, assets.types],
      [`${configDirectory}/sandbox.md`, assets.command],
    ]
    for (const [path, content] of files) {
      await this.client.putFile(sandboxId, path, new TextEncoder().encode(content))
    }
    await this.run(
      sandboxId,
      { argv: ["chmod", "700", "--", runtime, binDirectory, sandboxDirectory, configDirectory, controlDirectory, `${runtime}/bin/sandboxctl`] },
      "bootstrap",
    )
    await this.run(
      sandboxId,
      { argv: ["chmod", "600", "--", `${sandboxDirectory}/cli.ts`, `${sandboxDirectory}/redaction.ts`, `${sandboxDirectory}/types.ts`, `${configDirectory}/sandbox.md`] },
      "bootstrap",
    )
  }

  private async assets(): Promise<{ cli: string; redaction: string; types: string; command: string }> {
    try {
      const [cli, redaction, types, command] = await Promise.all([
        readFile(join(this.assetDirectory, "cli.ts"), "utf8"),
        readFile(join(this.assetDirectory, "redaction.ts"), "utf8"),
        readFile(join(this.assetDirectory, "types.ts"), "utf8"),
        readFile(join(this.assetDirectory, "../command/sandbox.md"), "utf8"),
      ])
      return { cli, redaction, types, command }
    } catch (error) {
      throw new SandboxError("bootstrap", redactError(error), "ASSET_UNAVAILABLE")
    }
  }

  private startControlPoller(activation: Activation): void {
    activation.controlPoller = this.pollControlMailbox(activation).catch(() => undefined)
  }

  private async pollControlMailbox(activation: Activation): Promise<void> {
    const controlDirectory = activation.controlDirectory
    const controlToken = activation.controlToken
    const localControlSocket = this.localControlSocket
    if (!controlDirectory || !controlToken || !localControlSocket) return

    while (!activation.closed) {
      try {
        const result = await this.client.exec(activation.sandboxId, {
          argv: ["find", controlDirectory, "-maxdepth", "1", "-type", "f", "-name", "*.request", "-print", "-quit"],
          timeoutMs: 5_000,
        })
        const requestPath = result.exitCode === 0
          ? result.stdout.split(/\r?\n/).find((path) => isControlRequestPath(controlDirectory, path))
          : undefined
        if (!activation.closed && requestPath) await this.handleControlRequest(activation, requestPath, localControlSocket, controlToken)
      } catch {
        // A transient bridge failure should not tear down the active session.
      }
      await delay(250)
    }
  }

  private async handleControlRequest(activation: Activation, requestPath: string, localControlSocket: string, controlToken: string): Promise<void> {
    const responsePath = requestPath.slice(0, -".request".length) + ".response"
    let response: { status: number; body: unknown }
    try {
      const value = JSON.parse(new TextDecoder().decode(await this.client.getFile(activation.sandboxId, requestPath)))
      if (!isRecord(value) || typeof value.token !== "string" || !isRecord(value.body) || !sameSecret(value.token, controlToken)) {
        throw new SandboxError("control_channel", "Cloudflare control request is invalid", "CONTROL_REQUEST")
      }
      response = await requestControl(localControlSocket, controlToken, value.body)
    } catch (error) {
      response = {
        status: 400,
        body: {
          ok: false,
          operation: "status",
          state: "error",
          stage: "control_channel",
          message: redactError(error),
        },
      }
    }
    const temporaryResponsePath = `${responsePath}.writing`
    await this.client.putFile(activation.sandboxId, temporaryResponsePath, new TextEncoder().encode(JSON.stringify(response)))
    await this.run(activation.sandboxId, { argv: ["mv", "--", temporaryResponsePath, responsePath] }, "sync")
    await this.removeFile(activation.sandboxId, requestPath)
  }

  private async startServer(activation: Activation): Promise<void> {
    const runtime = runtimeDirectory(activation.workspaceId)
    const authPath = `${runtime}/auth`
    const passwordPath = `${runtime}/password`
    const controlTokenPath = activation.controlToken ? `${runtime}/control-token` : undefined
    if (!activation.authContent) throw new SandboxError("bootstrap", "OpenCode auth content is unavailable", "AUTH_UNAVAILABLE")
    await this.run(activation.sandboxId, { argv: ["mkdir", "-p", "--", runtime] }, "bootstrap")
    try {
      await this.client.putFile(activation.sandboxId, authPath, new TextEncoder().encode(activation.authContent))
      await this.client.putFile(activation.sandboxId, passwordPath, new TextEncoder().encode(activation.password))
      if (controlTokenPath) await this.client.putFile(activation.sandboxId, controlTokenPath, new TextEncoder().encode(activation.controlToken!))
      await this.run(
        activation.sandboxId,
        { argv: ["sh", "-lc", serverCommand(runtime, authPath, passwordPath, this.remotePort, activation.workspaceId, activation.controlDirectory, controlTokenPath)], cwd: this.checkoutDirectory() },
        "bootstrap",
      )
    } finally {
      await this.removeFile(activation.sandboxId, authPath)
      await this.removeFile(activation.sandboxId, passwordPath)
      if (controlTokenPath) await this.removeFile(activation.sandboxId, controlTokenPath)
    }
  }

  private async waitForHealth(activation: Activation): Promise<void> {
    const tunnel = activation.tunnel
    if (!tunnel) throw new SandboxError("tunnel", "Cloudflare sandbox tunnel is unavailable", "RUNTIME_UNAVAILABLE")
    const deadline = Date.now() + this.healthTimeoutMs
    while (Date.now() < deadline) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 2_000)
      try {
        const response = await this.fetcher(`${tunnel.url}/global/health`, {
          headers: { Authorization: basicAuthHeader(activation.password) },
          signal: controller.signal,
        })
        if (response.ok) {
          const value = await readHealthResponse(response, controller.signal).catch(() => undefined)
          if (isRecord(value) && value.healthy === true) return
        }
      } catch {
        // The tunnel may need a moment after the container starts.
      } finally {
        clearTimeout(timeout)
      }
      await delay(250)
    }
    throw new SandboxError("remote_health", "Cloudflare OpenCode health check timed out", "REMOTE_HEALTH_TIMEOUT")
  }

  private async activeHealth(activation: Activation, signal?: AbortSignal): Promise<{ healthy?: boolean; version?: string } | undefined> {
    if (!activation.tunnel) return undefined
    const tunnel = activation.tunnel
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2_000)
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener("abort", abort, { once: true })
    try {
      if (signal?.aborted) return undefined
      const response = await waitForAbort(
        () => this.fetcher(`${tunnel.url}/global/health`, {
          headers: { Authorization: basicAuthHeader(activation.password) },
          signal: controller.signal,
        }),
        controller.signal,
        (lateResponse) => lateResponse.body?.cancel(),
      )
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

  private async run(
    sandboxId: string,
    input: { argv: string[]; cwd?: string; timeoutMs?: number },
    stage: "checkout" | "bootstrap" | "sync" | "remove",
  ): Promise<ProcessResult> {
    const result = await this.client.exec(sandboxId, input)
    if (result.exitCode !== 0 || result.signal !== null) {
      throw new SandboxError(stage, redactText(result.stderr || result.stdout || "Cloudflare command failed"), "CLOUDFLARE_COMMAND")
    }
    return result
  }

  private async execute(
    activation: Activation,
    command: string,
    options?: { onLine?: (line: string) => void; cwd?: string; sudo?: boolean; stdin?: string | Uint8Array; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cwd = options?.cwd ?? this.checkoutDirectory()
    assertRemotePath(cwd, "sandbox working directory")
    const commandLine = `cd -- ${quoteRemoteCommandPart(cwd)} && ${command}`
    const argv = options?.sudo ? ["sudo", "--", "sh", "-lc", commandLine] : ["sh", "-lc", commandLine]
    const result = await this.client.exec(activation.sandboxId, {
      argv,
      stdin: options?.stdin,
      onLine: options?.onLine,
      timeoutMs: this.bootstrapTimeoutMs,
      signal: options?.signal,
    })
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? -1,
    }
  }

  private async copyIn(activation: Activation, hostPath: string, sandboxPath: string): Promise<void> {
    if (!isAbsolute(hostPath)) throw new SandboxError("sync", "host copy path must be absolute", "PATH_INVALID")
    assertRemotePath(sandboxPath, "sandbox copy path")
    const stats = await lstat(hostPath).catch((error: unknown) => {
      throw new SandboxError("sync", redactError(error), "COPY_IN")
    })
    if (stats.isSymbolicLink()) throw new SandboxError("sync", "symbolic links cannot be copied into the sandbox", "COPY_IN")
    if (stats.isDirectory()) {
      await this.run(activation.sandboxId, { argv: ["mkdir", "-p", "--", sandboxPath] }, "sync")
      for (const entry of await readdir(hostPath, { withFileTypes: true })) {
        await this.copyIn(activation, join(hostPath, entry.name), posix.join(sandboxPath, entry.name))
      }
      return
    }
    if (!stats.isFile()) throw new SandboxError("sync", "only regular files can be copied into the sandbox", "COPY_IN")

    const content = await readFile(hostPath)
    const stagedPath = `${TRANSFER_DIRECTORY}/in-${randomBytes(8).toString("hex")}`
    await this.run(activation.sandboxId, { argv: ["mkdir", "-p", "--", TRANSFER_DIRECTORY, posix.dirname(sandboxPath)] }, "sync")
    try {
      await this.client.putFile(activation.sandboxId, stagedPath, content)
      await this.run(activation.sandboxId, { argv: ["mv", "--", stagedPath, sandboxPath] }, "sync")
    } finally {
      await this.removeFile(activation.sandboxId, stagedPath)
    }
  }

  private async copyFileOut(activation: Activation, sandboxPath: string, hostPath: string): Promise<void> {
    assertRemotePath(sandboxPath, "sandbox copy path")
    if (!isAbsolute(hostPath)) throw new SandboxError("sync", "host copy path must be absolute", "PATH_INVALID")
    const stagedPath = `${TRANSFER_DIRECTORY}/out-${randomBytes(8).toString("hex")}`
    await this.run(activation.sandboxId, { argv: ["mkdir", "-p", "--", TRANSFER_DIRECTORY] }, "sync")
    try {
      await this.run(activation.sandboxId, { argv: ["test", "-f", "--", sandboxPath] }, "sync")
      const link = await this.client.exec(activation.sandboxId, { argv: ["test", "-L", "--", sandboxPath] })
      if (link.exitCode === 0) throw new SandboxError("sync", "refusing to copy a symbolic link from the sandbox", "COPY_OUT")
      await this.run(activation.sandboxId, { argv: ["cp", "--", sandboxPath, stagedPath] }, "sync")
      const content = await this.client.getFile(activation.sandboxId, stagedPath)
      await mkdir(dirname(hostPath), { recursive: true })
      try {
        const stats = await lstat(hostPath)
        if (stats.isSymbolicLink()) throw new SandboxError("sync", "refusing to replace a symbolic link", "COPY_OUT")
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error
      }
      await writeFile(hostPath, content, { mode: 0o600 })
    } finally {
      await this.removeFile(activation.sandboxId, stagedPath)
    }
  }

  private async removeFile(sandboxId: string, path: string): Promise<void> {
    await this.client.exec(sandboxId, { argv: ["rm", "-f", "--", path] }).catch(() => undefined)
  }

  private async cleanupRuntime(sandboxId: string, workspaceId: string): Promise<void> {
    const runtime = runtimeDirectory(workspaceId)
    let failure: unknown
    try {
      const result = await this.client.exec(sandboxId, {
        argv: ["sh", "-lc", cleanupCommand(runtime)],
      })
      if (result.exitCode !== 0 || result.signal !== null) {
        failure = new SandboxError("remove", redactText(result.stderr || result.stdout || "Cloudflare cleanup failed"), "CLOUDFLARE_COMMAND")
      }
    } catch (error) {
      if (!isNotFound(error)) failure = error
    }
    try {
      await this.client.destroyTunnel(sandboxId, this.remotePort)
    } catch (error) {
      if (!failure && !isNotFound(error)) failure = error
    }
    if (failure) throw failure
  }

  private async destroyIfPresent(sandboxId: string): Promise<void> {
    await this.client.destroySandbox(sandboxId).catch((error) => {
      if (!isNotFound(error)) throw error
    })
  }

  private async readHead(): Promise<string> {
    const result = await this.runner.run({
      argv: ["git", "-C", this.worktree, "rev-parse", "HEAD"],
      cwd: this.worktree,
      env: sanitizeEnvironment(),
      maxOutputBytes: 16 * 1024,
    })
    if (result.exitCode !== 0) throw new SandboxError("checkout", redactText(result.stderr || "could not read local HEAD"), "GIT_HEAD")
    return result.stdout.trim()
  }
}

async function readHealthResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    return JSON.parse(await readLimitedBody(response, signal, "diagnose"))
  } catch {
    return undefined
  }
}

export interface CloudflareSandcastleAdapterOptions extends CloudflareProviderOptions {
  input: SandcastleAdapterInput
  authContent?: string
}

export function createCloudflareSandcastleAdapter(options: CloudflareSandcastleAdapterOptions): OpenCodeSandboxAdapter {
  const { input, authContent, ...providerOptions } = options
  const provider = new CloudflareProvider({ ...providerOptions, deferActivation: true })
  const info: WorkspaceInfo = {
    id: input.workspaceId,
    type: "cloudflare",
    name: `oc-cf-${shortHash(input.workspaceId)}`,
    branch: input.branch,
    directory: REMOTE_CHECKOUT_DIRECTORY,
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
    inspect: (signal?: AbortSignal) => provider.inspect(info, signal),
    diagnose: (signal?: AbortSignal) => provider.diagnose(info, signal),
    recoveryMetadata: () => provider.runtimeMetadata(input.workspaceId)?.providerState ?? {},
    close: () => provider.close(info),
  }
}

function createClient(options: CloudflareProviderOptions): CloudflareSandboxClient {
  if (!options.apiUrl || !options.apiKey) {
    throw new SandboxError("validate", "Cloudflare provider requires an API URL and API key", "CLOUDFLARE_CONFIG")
  }
  return new CloudflareBridgeClient({ apiUrl: options.apiUrl, apiKey: options.apiKey, fetcher: options.fetcher })
}

function readMetadata(info: WorkspaceInfo, from?: WorkspaceInfo): CloudflareMetadata {
  if (info.type !== "cloudflare") throw cloudflareOwnershipError()
  const value = isRecord(info.extra) ? info.extra : isRecord(from?.extra) ? from.extra : {}
  const state = isRecord(value.providerState) ? value.providerState : value
  const field = (key: string): unknown => value[key] ?? state[key]
  const metadata: CloudflareMetadata = { sessionId: "", generation: 0, workspaceId: info.id, projectId: info.projectID }

  const provider = field("provider")
  if (provider !== undefined && provider !== "cloudflare") throw cloudflareOwnershipError()
  const sessionId = field("sessionId")
  if (sessionId !== undefined && (typeof sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId))) {
    throw new SandboxError("validate", "Cloudflare session ID is invalid", "SESSION_ID")
  }
  if (typeof sessionId === "string") metadata.sessionId = sessionId
  if (!metadata.sessionId) throw cloudflareOwnershipError()
  const generation = field("generation")
  if (generation !== undefined && (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1)) {
    throw new SandboxError("validate", "Cloudflare generation is invalid", "GENERATION_INVALID")
  }
  if (typeof generation === "number") metadata.generation = generation
  if (metadata.generation < 1) throw cloudflareOwnershipError()
  const workspaceId = field("workspaceId")
  if (workspaceId !== undefined && workspaceId !== info.id) {
    throw new SandboxError("validate", "Cloudflare workspace ownership is invalid", "CLOUDFLARE_OWNERSHIP_UNVERIFIED")
  }
  const projectId = field("projectId")
  if (projectId !== undefined && projectId !== info.projectID) {
    throw new SandboxError("validate", "Cloudflare project ownership is invalid", "CLOUDFLARE_OWNERSHIP_UNVERIFIED")
  }

  const sandboxId = field("sandboxId")
  if (sandboxId !== undefined) {
    if (typeof sandboxId !== "string") throw new SandboxError("validate", "Cloudflare sandbox ID is invalid", "CLOUDFLARE_SANDBOX_ID")
    assertSandboxId(sandboxId)
    metadata.sandboxId = sandboxId
  }
  const branch = field("branch")
  if (branch !== undefined) {
    if (typeof branch !== "string") throw new SandboxError("validate", "Cloudflare workspace branch is invalid", "BRANCH_INVALID")
    assertSafeBranch(branch)
    metadata.branch = branch
  }
  const baseSha = field("baseSha")
  if (baseSha !== undefined) {
    if (typeof baseSha !== "string") throw new SandboxError("validate", "Cloudflare workspace SHA is invalid", "GIT_HEAD")
    assertSha(baseSha)
    metadata.baseSha = baseSha
  }
  const checkoutHead = field("checkoutHead")
  if (checkoutHead !== undefined) {
    if (typeof checkoutHead !== "string") throw new SandboxError("validate", "Cloudflare checkout HEAD is invalid", "GIT_HEAD")
    assertSha(checkoutHead)
    metadata.checkoutHead = checkoutHead
  }
  const tunnelName = field("tunnelName")
  if (tunnelName !== undefined) {
    if (typeof tunnelName !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(tunnelName)) {
      throw new SandboxError("validate", "Cloudflare tunnel name is invalid", "CLOUDFLARE_TUNNEL_NAME")
    }
    metadata.tunnelName = tunnelName
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
    sandboxId: activation.sandboxId,
    branch: activation.branch,
    baseSha: activation.baseSha,
    checkoutHead: activation.checkoutHead,
    tunnelName: activation.tunnelName,
  }
}

function ownerFromMetadata(metadata: CloudflareMetadata): CloudflareOwner {
  return {
    provider: "cloudflare",
    sessionId: metadata.sessionId,
    generation: metadata.generation,
    workspaceId: metadata.workspaceId,
    projectId: metadata.projectId,
  }
}

function sameOwner(actual: CloudflareOwner | undefined, expected: CloudflareOwner): boolean {
  return Boolean(
    actual &&
    actual.provider === expected.provider &&
    actual.sessionId === expected.sessionId &&
    actual.generation === expected.generation &&
    actual.workspaceId === expected.workspaceId &&
    actual.projectId === expected.projectId
  )
}

function cloudflareOwnershipError(): SandboxError {
  return new SandboxError("validate", "Cloudflare resource ownership could not be verified", "CLOUDFLARE_OWNERSHIP_UNVERIFIED")
}

function runtimeDirectory(workspaceId: string): string {
  return `${REMOTE_DIRECTORY}/.opencode-sandbox/${shortHash(workspaceId)}`
}

function assertRemotePath(value: string, label: string): void {
  if (!isAbsolute(value) || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new SandboxError("validate", `${label} path is unsafe`, "PATH_INVALID")
  }
}

function isControlRequestPath(root: string, value: string): boolean {
  if (!value.startsWith(`${root}/`)) return false
  const name = value.slice(root.length + 1)
  return /^[0-9a-f-]{36}\.request$/i.test(name)
}

function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes)
}

function tunnelNameFor(workspaceId: string): string {
  return `oc-${shortHash(workspaceId)}`
}

function serverCommand(
  runtime: string,
  authPath: string,
  passwordPath: string,
  port: number,
  workspaceId: string,
  controlDirectory?: string,
  controlTokenPath?: string,
): string {
  const quotedRuntime = shellQuote(runtime)
  const quotedAuth = shellQuote(authPath)
  const quotedPassword = shellQuote(passwordPath)
  const quotedWorkspaceId = shellQuote(workspaceId)
  const quotedLog = shellQuote(`${runtime}/server.log`)
  const quotedPid = shellQuote(`${runtime}/server.pid`)
  const controlSetup = controlDirectory && controlTokenPath
    ? `control_mailbox=${shellQuote(controlDirectory)}
control_token_file=${shellQuote(controlTokenPath)}
control_token=$(cat "$control_token_file")
`
    : ""
  const controlEnvironment = controlDirectory && controlTokenPath
    ? `SANDBOX_CONTROL_MAILBOX="$control_mailbox" SANDBOX_CONTROL_TOKEN="$control_token" SANDBOX_CONTROL_ROLE=remote OPENCODE_CONFIG_DIR="$runtime/config" `
    : ""
  return `set -eu
runtime=${quotedRuntime}
auth_file=${quotedAuth}
password_file=${quotedPassword}
workspace_id=${quotedWorkspaceId}
log_file=${quotedLog}
pid_file=${quotedPid}
${controlSetup}export PATH="$runtime/bin:$PATH"
if [ -s "$pid_file" ]; then
    old_pid=$(cat "$pid_file")
    case "$old_pid" in
        ""|*[!0-9]*) ;;
        *)
            old_command=$(tr '\\0' ' ' <"/proc/$old_pid/cmdline" 2>/dev/null || true)
            case "$old_command" in
                *opencode*) kill "$old_pid" 2>/dev/null || true ;;
            esac
            ;;
    esac
    sleep 0.1
fi
auth_content=$(cat "$auth_file")
server_password=$(cat "$password_file")
nohup env OPENCODE_AUTH_CONTENT="$auth_content" OPENCODE_WORKSPACE_ID="$workspace_id" OPENCODE_SERVER_USERNAME=opencode OPENCODE_SERVER_PASSWORD="$server_password" OPENCODE_EXPERIMENTAL_WORKSPACES=1 ${controlEnvironment}opencode serve --hostname 0.0.0.0 --port ${port} >"$log_file" 2>&1 < /dev/null &
printf '%s\\n' "$!" >"$pid_file"
rm -f -- "$auth_file" "$password_file"${controlDirectory && controlTokenPath ? ` "$control_token_file"` : ""}
`
}

function cleanupCommand(runtime: string): string {
  const quotedRuntime = shellQuote(runtime)
  const quotedPid = shellQuote(`${runtime}/server.pid`)
  return `set -eu
pid_file=${quotedPid}
if [ -s "$pid_file" ]; then
    pid=$(cat "$pid_file")
    case "$pid" in
        ""|*[!0-9]*) ;;
        *)
            command_line=$(tr '\\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)
            case "$command_line" in
                *opencode*) kill "$pid" 2>/dev/null || true ;;
            esac
            ;;
    esac
fi
rm -rf -- ${quotedRuntime}
`
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'"
}

function isNotFound(error: unknown): boolean {
  return error instanceof SandboxError && error.code === "CLOUDFLARE_HTTP_404"
}
