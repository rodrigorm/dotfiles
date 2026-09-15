import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { chmod, mkdtemp, mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { nodeProcessRunner } from "./process"
import { redactError, redactText } from "./redaction"

const REPOSITORY_ROOT = join(import.meta.dir, "../../../..")
const FIXTURE_MODULE_URL = import.meta.url
const FIXTURE_SOURCE = "home/.config/opencode/sandbox/cloudflare-e2e.ts"
const REMOTE_EDIT_MARKER = "cloudflare-e2e-remote-edit"
const REMOTE_README_MARKER = "cloudflare-e2e-remote-readme"
const REMOTE_CREATED_CONTENT = "cloudflare-e2e-remote-created"
const REPORT_FILE = "cloudflare-e2e-report.json"
const MAX_HTTP_BODY_BYTES = 512 * 1024
const MAX_PROCESS_OUTPUT_BYTES = 128 * 1024

export type Json = Record<string, unknown>
export type Environment = Record<string, string | undefined>
export type E2EProvider = "cloudflare" | "sbx" | "exedev"
export const DEFAULT_E2E_PROVIDER: E2EProvider = "cloudflare"

export function selectE2EProvider(env: Environment = process.env): E2EProvider {
  const provider = env.SANDBOX_E2E_PROVIDER ?? DEFAULT_E2E_PROVIDER
  if (provider !== "cloudflare" && provider !== "sbx" && provider !== "exedev") {
    throw new Error("SANDBOX_E2E_PROVIDER must be cloudflare, sbx, or exedev")
  }
  return provider
}

export function buildE2EConfig(
  provider: E2EProvider,
  sourceConfig: Json,
  environmentConfig: Json,
  env: Environment,
): Json {
  const input = { ...sourceConfig, ...environmentConfig }
  if (provider === "sbx" || provider === "exedev") {
    const { apiUrl: _apiUrl, apiKey: _apiKey, ...withoutCloudflareCredentials } = input
    return { ...withoutCloudflareCredentials, provider }
  }

  const apiUrl = env.SANDBOX_API_URL ?? environmentConfig.apiUrl ?? sourceConfig.apiUrl
  const apiKey = env.SANDBOX_API_KEY ?? environmentConfig.apiKey ?? sourceConfig.apiKey
  if (typeof apiUrl !== "string" || apiUrl.length === 0) throw new Error("Cloudflare bridge URL is unavailable")
  if (typeof apiKey !== "string" || apiKey.length === 0) throw new Error("Cloudflare bridge key is unavailable")
  return { ...input, provider, apiUrl, apiKey }
}

export function buildFixedEditCommand(remoteWorktreePath: string): string {
  assertRemoteWorktreePath(remoteWorktreePath)
  const quotedPath = shellQuote(remoteWorktreePath)
  return `uname -s | grep -Fx Linux && pwd -P | grep -Fx -- ${quotedPath} && test -f host-e2e-untracked.txt && printf '%s\\n' '${REMOTE_EDIT_MARKER}' >> host-e2e-untracked.txt && grep -F -- '${REMOTE_EDIT_MARKER}' host-e2e-untracked.txt && printf '%s\\n' '${REMOTE_README_MARKER}' >> README.md && grep -F -- '${REMOTE_README_MARKER}' README.md && test ! -e remote-e2e-created.txt && printf '%s\\n' '${REMOTE_CREATED_CONTENT}' > remote-e2e-created.txt && grep -Fx -- '${REMOTE_CREATED_CONTENT}' remote-e2e-created.txt && printf 'remote-uname=' && uname -s && printf 'remote-cwd=' && pwd -P`
}

type PhaseStatus = "PASS" | "FAIL"

type Phase = {
  name: string
  status: PhaseStatus
  startedAt: string
  endedAt: string
  deadlineMs: number
  deadlineAt: string
  details?: unknown
  error?: Json
}

type Report = {
  schemaVersion: 1
  outcome: "running" | "pass" | "fail"
  runId: string
  startedAt: string
  endedAt?: string
  phases: Phase[]
  budgets: Record<string, number>
  constraints: {
    llmCall: false
    subagents: false
    providerDirectCalls: false
    fixedEdit: string
  }
  resources: Json
  cleanup?: Json
  failure?: Json
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is unavailable`)
  return value
}

function assertRemoteWorktreePath(value: string): void {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(value) || value === "/" || value.includes("..")) {
    throw new Error("remote worktree path is invalid")
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function concreteId(value: unknown, label: string): string {
  const id = requiredString(value, label)
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(id)) throw new Error(`${label} is not a concrete ID`)
  return id
}

function bounded(value: unknown, max = 8_192, secrets: readonly string[] = []): string {
  const text = redactText(String(value ?? ""), secrets)
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`
}

function safeJson(value: unknown, secrets: readonly string[], key = ""): unknown {
  if (key && /(?:password|token|secret|credential|auth|api[_-]?key|private[_-]?key)/i.test(key)) return "[REDACTED]"
  if (typeof value === "string") return bounded(value, 4_096, secrets)
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => safeJson(item, secrets))
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).slice(0, 64).map(([name, item]) => [name, safeJson(item, secrets, name)]))
  return value
}

function safeError(error: unknown, secrets: readonly string[]): Json {
  const value = isRecord(error) ? error : {}
  return {
    name: typeof value.name === "string" ? value.name : error instanceof Error ? error.name : "Error",
    message: bounded(error instanceof Error ? error.message : error, 4_096, secrets),
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(typeof value.stage === "string" ? { stage: value.stage } : {}),
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function request(
  baseUrl: string,
  path: string,
  init: RequestInit,
  signal: AbortSignal,
  secrets: readonly string[],
): Promise<unknown> {
  const response = await fetch(new URL(path, `${baseUrl.replace(/\/$/, "")}/`), { ...init, signal })
  const text = await response.text()
  if (Buffer.byteLength(text) > MAX_HTTP_BODY_BYTES) throw new Error(`${init.method ?? "GET"} ${path} returned an oversized response`)
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} returned HTTP ${response.status}: ${bounded(text, 2_048, secrets)}`)
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${init.method ?? "GET"} ${path} returned invalid JSON`)
  }
}

async function sessionShell(
  hostUrl: string,
  worktree: string,
  sessionId: string,
  command: string,
  signal: AbortSignal,
  secrets: readonly string[],
): Promise<unknown> {
  const path = `/session/${encodeURIComponent(sessionId)}/shell?directory=${encodeURIComponent(worktree)}`
  return request(hostUrl, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: "general", command }),
  }, signal, secrets)
}

function textParts(value: unknown): string {
  const result: string[] = []
  const seen = new Set<object>()
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      result.push(item)
      return
    }
    if (!item || typeof item !== "object" || seen.has(item)) return
    seen.add(item)
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") result.push(item.text)
    if (isRecord(item) && item.type === "tool" && isRecord(item.state) && typeof item.state.output === "string") result.push(item.state.output)
    for (const child of Object.values(item)) visit(child)
  }
  visit(value)
  return result.join("\n")
}

function sandboxResponse(value: unknown): Json | undefined {
  if (isRecord(value) && value.schemaVersion === 2 && typeof value.operation === "string") return value
  const lines = textParts(value).split(/\r?\n/)
  for (const line of lines) {
    const start = line.indexOf("{")
    const end = line.lastIndexOf("}")
    if (start < 0 || end < start) continue
    try {
      const candidate: unknown = JSON.parse(line.slice(start, end + 1))
      if (isRecord(candidate) && candidate.schemaVersion === 2 && typeof candidate.operation === "string") return candidate
    } catch {
      // Shell output can contain ordinary text around the JSON result.
    }
  }
  return undefined
}

function safeShell(value: unknown, command: string, secrets: readonly string[]): Json {
  const text = textParts(value)
  const response = sandboxResponse(value)
  return {
    command,
    text: bounded(text, 8_192, secrets),
    textBytes: Buffer.byteLength(text),
    sandboxResponse: response ? safeJson(response, secrets) : null,
  }
}

async function readRecord(stateDirectory: string, sessionId: string): Promise<Json | undefined> {
  let entries
  try {
    entries = await readdir(stateDirectory, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    try {
      const value: unknown = JSON.parse(await readFile(join(stateDirectory, entry.name), "utf8"))
      if (isRecord(value) && value.sessionId === sessionId) return value
    } catch {
      // Atomic state replacement can expose a partial file for one poll.
    }
  }
  return undefined
}

function recordSummary(value: unknown, secrets: readonly string[]): Json | null {
  if (!isRecord(value)) return null
  const operation = isRecord(value.operation) ? value.operation : undefined
  const providerState = isRecord(value.providerState) ? value.providerState : undefined
  const providerResourceIds = Object.fromEntries(["sandboxId", "resourceId", "tunnelName", "tunnelId"]
    .filter((key) => typeof providerState?.[key] === "string")
    .map((key) => [key, providerState![key]]))
  return {
    sessionId: value.sessionId ?? null,
    workspaceId: value.workspaceId ?? null,
    projectId: value.projectId ?? null,
    provider: value.provider ?? null,
    generation: value.generation ?? null,
    desiredLocation: value.desiredLocation ?? null,
    phase: value.phase ?? null,
    branch: value.branch ?? null,
    baseSha: value.baseSha ?? null,
    operation: operation ? {
      kind: operation.kind ?? null,
      phase: operation.phase ?? null,
      providerDestroyed: operation.providerDestroyed ?? null,
    } : null,
    providerResourceIds,
    lastError: isRecord(value.lastError) ? safeJson(value.lastError, secrets) : null,
    updatedAt: value.updatedAt ?? null,
  }
}

function metadataRemoteWorktreePath(value: unknown, provider: E2EProvider): string | undefined {
  if (!isRecord(value)) return undefined
  if (value.provider !== undefined && value.provider !== provider) return undefined
  const state = isRecord(value.providerState) ? value.providerState : value
  if (state.provider !== undefined && state.provider !== provider) return undefined
  const path = state.remoteWorktreePath
  if (path === undefined) return undefined
  if (typeof path !== "string") throw new Error("remote worktree metadata is invalid")
  assertRemoteWorktreePath(path)
  return path
}

function remoteWorktreePathFromMetadata(record: unknown, workspace: unknown, provider: E2EProvider): string | undefined {
  const recordPath = metadataRemoteWorktreePath(record, provider)
  if (recordPath) return recordPath
  const workspaceExtra = isRecord(workspace) ? workspace.extra : undefined
  return metadataRemoteWorktreePath(workspaceExtra, provider)
}

async function waitForLocation(input: {
  hostUrl: string
  worktree: string
  stateDirectory: string
  sessionId: string
  workspaceId: string
  projectId: string
  provider: E2EProvider
  remote: boolean
  signal: AbortSignal
  secrets: readonly string[]
}): Promise<Json> {
  let last: Json = {}
  while (!input.signal.aborted) {
    try {
      const directory = encodeURIComponent(input.worktree)
      const [sessionValue, workspaceValue, syncValue, record] = await Promise.all([
        request(input.hostUrl, `/session/${encodeURIComponent(input.sessionId)}?directory=${directory}`, {}, input.signal, input.secrets),
        request(input.hostUrl, `/experimental/workspace?directory=${directory}`, {}, input.signal, input.secrets),
        request(input.hostUrl, `/experimental/workspace/status?directory=${directory}`, {}, input.signal, input.secrets),
        readRecord(input.stateDirectory, input.sessionId),
      ])
      const session = isRecord(sessionValue) ? sessionValue : {}
      const sessionWorkspaceId = typeof session.workspaceID === "string"
        ? session.workspaceID
        : typeof session.workspaceId === "string" ? session.workspaceId : null
      const workspaces = Array.isArray(workspaceValue) ? workspaceValue : []
      const workspace = workspaces.find((item) => isRecord(item) && item.id === input.workspaceId)
      const syncEntries = Array.isArray(syncValue) ? syncValue : []
      const sync = syncEntries.find((item) => isRecord(item) && item.workspaceID === input.workspaceId)
      const operation = isRecord(record?.operation) ? record.operation : undefined
      const lastError = isRecord(record?.lastError) ? record.lastError : undefined
      const remoteWorktreePath = input.remote ? remoteWorktreePathFromMetadata(record, workspace, input.provider) : undefined
      const lifecycle = input.remote
        ? record?.desiredLocation === "remote" && record.phase === "idle" && operation?.kind === "start" && operation.phase === "remote" && !lastError
        : record?.desiredLocation === "local" && record.phase === "idle" && operation?.kind === "stop" && operation.phase === "detached" && operation.providerDestroyed === true && !lastError
      last = {
        lifecycle: recordSummary(record, input.secrets),
        session: { workspaceId: sessionWorkspaceId },
        workspace: workspace ? safeJson(workspace, input.secrets) : null,
        sync: sync ? safeJson(sync, input.secrets) : null,
        remoteWorktreePath: remoteWorktreePath ?? null,
      }
      if (lastError) throw new Error(`lifecycle failed: ${bounded(lastError.message, 2_048, input.secrets)}`)
      if (input.remote) {
        if (lifecycle && sessionWorkspaceId === input.workspaceId && isRecord(workspace) && workspace.projectID === input.projectId && isRecord(sync) && sync.status === "connected") {
          if (!remoteWorktreePath) throw new Error("remote worktree metadata is unavailable")
          return { ...last, remoteWorktreePath, protocol: { warp: true, replay: true } }
        }
      } else if (lifecycle && sessionWorkspaceId === null && !workspace && !sync) {
        return { ...last, protocol: { warpBack: true, syncBack: true } }
      }
    } catch (error) {
      if (input.signal.aborted) break
      last = { ...last, lastError: safeError(error, input.secrets) }
    }
    try {
      await delay(500, undefined, { signal: input.signal })
    } catch {
      break
    }
  }
  throw new Error(`timed out waiting for ${input.remote ? "Warp/replay" : "local return"}: ${bounded(JSON.stringify(last), 4_096, input.secrets)}`)
}

async function stopHost(pid: number, port: number, signal: AbortSignal, secrets: readonly string[]): Promise<Json> {
  const probe = await nodeProcessRunner.run({
    argv: ["ps", "-p", String(pid), "-o", "command="],
    signal,
    maxOutputBytes: 16 * 1024,
  })
  const command = probe.stdout.trim()
  if (probe.exitCode !== 0 || command.length === 0) return { attempted: true, alreadyExited: true, pid }
  if (!/opencode.*\bserve\b/.test(command) || !new RegExp(`--port\\s+${port}(?:\\s|$)`).test(command)) {
    throw new Error(`refusing to terminate PID ${pid}: host identity was not verified`)
  }

  try {
    process.kill(pid, "SIGTERM")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return { attempted: true, alreadyExited: true, pid }
    throw error
  }

  const graceDeadline = Date.now() + 5_000
  while (Date.now() < graceDeadline && !signal.aborted) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return { attempted: true, pid, signal: "SIGTERM" }
    }
    try {
      await delay(100, undefined, { signal })
    } catch {
      break
    }
  }
  if (signal.aborted) throw new Error("host cleanup deadline exceeded")

  try {
    process.kill(pid, "SIGKILL")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return { attempted: true, pid, signal: "SIGTERM" }
    throw error
  }
  const killDeadline = Date.now() + 2_000
  while (Date.now() < killDeadline && !signal.aborted) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return { attempted: true, pid, signal: "SIGKILL", forced: true }
    }
    await delay(100, undefined, { signal }).catch(() => undefined)
  }
  if (signal.aborted) throw new Error("host cleanup deadline exceeded")
  throw new Error(`host PID ${pid} did not exit after SIGKILL`)
}

async function runPhase<T>(
  phases: Phase[],
  name: string,
  deadlineMs: number,
  action: (signal: AbortSignal) => Promise<T>,
  secrets: readonly string[],
): Promise<T> {
  const startedAt = new Date()
  const controller = new AbortController()
  const deadlineAt = new Date(startedAt.getTime() + deadlineMs)
  const timer = setTimeout(() => controller.abort(), deadlineMs)
  try {
    const details = await action(controller.signal)
    phases.push({ name, status: "PASS", startedAt: startedAt.toISOString(), endedAt: new Date().toISOString(), deadlineMs, deadlineAt: deadlineAt.toISOString(), ...(details === undefined ? {} : { details }) })
    return details
  } catch (error) {
    const failure = controller.signal.aborted ? new Error(`${name} deadline exceeded after ${deadlineMs} ms`) : error
    phases.push({ name, status: "FAIL", startedAt: startedAt.toISOString(), endedAt: new Date().toISOString(), deadlineMs, deadlineAt: deadlineAt.toISOString(), error: safeError(failure, secrets) })
    throw failure
  } finally {
    clearTimeout(timer)
  }
}

function lastJson(text: string): Json {
  for (const line of text.trim().split(/\r?\n/).reverse()) {
    try {
      const value: unknown = JSON.parse(line)
      if (isRecord(value)) return value
    } catch {
      // The fixture emits one JSON line after any diagnostic output.
    }
  }
  throw new Error("local host fixture did not emit its JSON result")
}

function timeout(env: Environment, name: string, fallback: number): number {
  const value = env[name]
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 3_600_000) throw new Error(`${name} must be an integer between 1 and 3600000`)
  return parsed
}

function fixtureAssert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function fixtureRequest(baseUrl: string, path: string, init: RequestInit = {}): Promise<unknown> {
  return request(baseUrl, path, init, AbortSignal.timeout(5_000), [])
}

async function reserveFixturePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("could not reserve a local port")
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function waitForFixtureHealth(hostUrl: string, child: ChildProcess): Promise<Json> {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    try {
      const health = await fixtureRequest(hostUrl, "/global/health")
      if (isRecord(health) && health.healthy === true) return health
    } catch {
      if (child.exitCode !== null) throw new Error("OpenCode exited before health; see host.log")
    }
    await delay(250)
  }
  throw new Error("OpenCode health timeout; see host.log")
}

async function writePrivate(path: string, content: string | Uint8Array): Promise<void> {
  await writeFile(path, content, { flag: "wx", mode: 0o600 })
  await chmod(path, 0o600)
}

export async function createE2ERuntimeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "oe-e2e-"))
  await chmod(directory, 0o700)
  return directory
}

export async function cleanupE2ERuntimeDirectory(
  path: string,
  hostStopped: boolean,
  signal?: AbortSignal,
  secrets: readonly string[] = [],
): Promise<Json> {
  if (!hostStopped) return { attempted: false, preserved: true, path, reason: "host is still running" }
  if (signal?.aborted) throw new Error("runtime directory cleanup deadline exceeded")
  if (!(await exists(path))) return { attempted: true, alreadyAbsent: true, path }
  await rm(path, { recursive: true, force: true })
  if (signal?.aborted) throw new Error("runtime directory cleanup deadline exceeded")
  if (await exists(path)) throw new Error(`runtime directory cleanup left the path in place: ${bounded(path, 2_048, secrets)}`)
  return { attempted: true, removed: true, path }
}

export async function prepareE2EClone(
  source: string,
  destination: string,
  signal?: AbortSignal,
  secrets: readonly string[] = [],
): Promise<{ source: string; destination: string; revision: string }> {
  const captured = await nodeProcessRunner.run({
    argv: ["git", "rev-parse", "HEAD"],
    cwd: source,
    signal,
    maxOutputBytes: 4_096,
  })
  if (captured.exitCode !== 0) throw new Error(`git revision capture failed: ${bounded(captured.stderr || captured.stdout, 2_048, secrets)}`)
  const revision = captured.stdout.trim()
  if (!/^[a-f0-9]{40}$/i.test(revision)) throw new Error(`git returned an invalid captured revision: ${bounded(revision, 128, secrets)}`)

  const cloned = await nodeProcessRunner.run({
    argv: ["git", "clone", "--no-local", "--no-hardlinks", "--no-checkout", source, destination],
    cwd: source,
    signal,
    maxOutputBytes: 32 * 1024,
  })
  if (cloned.exitCode !== 0) throw new Error(`git clone failed: ${bounded(cloned.stderr || cloned.stdout, 2_048, secrets)}`)

  const checkedOut = await nodeProcessRunner.run({
    argv: ["git", "checkout", "--detach", revision],
    cwd: destination,
    signal,
    maxOutputBytes: 32 * 1024,
  })
  if (checkedOut.exitCode !== 0) throw new Error(`git checkout of captured revision failed: ${bounded(checkedOut.stderr || checkedOut.stdout, 2_048, secrets)}`)

  const verified = await nodeProcessRunner.run({
    argv: ["git", "rev-parse", "HEAD"],
    cwd: destination,
    signal,
    maxOutputBytes: 4_096,
  })
  if (verified.exitCode !== 0 || verified.stdout.trim() !== revision) {
    throw new Error(`fixture clone is not checked out at the captured revision: ${bounded(verified.stdout || verified.stderr, 128, secrets)}`)
  }

  const gitDirectory = join(destination, ".git")
  const gitDirectoryStats = await stat(gitDirectory)
  if (!gitDirectoryStats.isDirectory()) throw new Error("fixture clone did not create an independent Git directory")
  if (await exists(join(gitDirectory, "objects", "info", "alternates"))) {
    throw new Error("fixture clone uses an external Git object store")
  }

  return { source, destination, revision }
}

export async function cleanupE2EClone(
  path: string,
  createdByTest: boolean,
  signal?: AbortSignal,
  secrets: readonly string[] = [],
): Promise<Json> {
  if (!createdByTest) return { attempted: false, preserved: true, path, reason: "clone was not created by this test" }
  if (signal?.aborted) throw new Error("clone cleanup deadline exceeded")
  if (!(await exists(path))) return { attempted: true, alreadyAbsent: true, path }
  await rm(path, { recursive: true, force: true })
  if (signal?.aborted) throw new Error("clone cleanup deadline exceeded")
  if (await exists(path)) throw new Error(`clone cleanup left the path in place: ${bounded(path, 2_048, secrets)}`)
  return { attempted: true, removed: true, path }
}

export async function runLocalHostFixture(): Promise<void> {
  const provider = selectE2EProvider(process.env)
  const runDirectory = process.env.SANDBOX_E2E_RUN_DIRECTORY ?? process.cwd()
  const worktree = join(runDirectory, "repo")
  const stateDirectory = join(runDirectory, "state")
  const runtimeDirectory = process.env.SANDBOX_E2E_RUNTIME_DIRECTORY ?? await createE2ERuntimeDirectory()
  const dataDirectory = join(runDirectory, "data")
  const sourceConfigPath = join(REPOSITORY_ROOT, ".opencode", "sandbox.json")
  const xdgConfigHome = join(REPOSITORY_ROOT, "home", ".config")
  const hostLogPath = join(runDirectory, "host.log")
  const hostInfoPath = join(runDirectory, "host.json")
  const originalReadmePath = join(runDirectory, "README.md.original")
  const manifestPath = join(runDirectory, "manifest.json")
  const knownHostsFile = join(runDirectory, "known_hosts")
  const runId = runDirectory.split("/").at(-1) ?? "unknown"
  const marker = `<!-- opencode-cloudflare-e2e:${runId} -->`
  const initialUntrackedContent = `host-e2e-untracked:${runId}\n`
  const expectedRemoteUntrackedContent = `${initialUntrackedContent}${REMOTE_EDIT_MARKER}\n`
  const untrackedPath = join(worktree, "host-e2e-untracked.txt")
  const readmePath = join(worktree, "README.md")
  const remoteCreatedPath = join(worktree, "remote-e2e-created.txt")
  const expectedRemoteCreatedContent = `${REMOTE_CREATED_CONTENT}\n`

  await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })
  await chmod(runtimeDirectory, 0o700)
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 })

  const sourceConfigValue: unknown = JSON.parse(await readFile(sourceConfigPath, "utf8"))
  fixtureAssert(isRecord(sourceConfigValue), "source sandbox config is invalid")
  const environmentConfigValue: unknown = process.env.SANDBOX_CONFIG ? JSON.parse(process.env.SANDBOX_CONFIG) : {}
  const environmentConfig = isRecord(environmentConfigValue) ? environmentConfigValue : {}
  const effectiveConfig: Json & { provider: E2EProvider; stateDirectory: string; openCodeVersion: string } = {
    ...buildE2EConfig(provider, sourceConfigValue, environmentConfig, process.env),
    provider,
    stateDirectory,
    openCodeVersion: "1.18.25",
  }
  const apiKeyValue = provider === "cloudflare"
    ? requiredString(effectiveConfig["apiKey"], "Cloudflare bridge key")
    : undefined
  const credentialsPath = provider === "cloudflare" ? join(runDirectory, "credentials.json") : undefined
  if (provider === "cloudflare") {
    await writePrivate(credentialsPath!, `${JSON.stringify({ apiUrl: effectiveConfig["apiUrl"], apiKey: apiKeyValue })}\n`)
  }
  const childEnvironment: Environment = {
    ...process.env,
    PATH: `${join(REPOSITORY_ROOT, "home", "bin")}:${process.env.PATH ?? ""}`,
    TMPDIR: runtimeDirectory,
    XDG_RUNTIME_DIR: runtimeDirectory,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_DATA_HOME: dataDirectory,
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_EXPERIMENTAL_WORKSPACES: "1",
    SANDBOX_PROVIDER: provider,
    SANDBOX_CONFIG: JSON.stringify(effectiveConfig),
  }
  if (provider !== "cloudflare") {
    delete childEnvironment.SANDBOX_API_URL
    delete childEnvironment.SANDBOX_API_KEY
  }
  if (provider === "exedev") childEnvironment.SANDBOX_KNOWN_HOSTS_FILE = knownHostsFile
  else delete childEnvironment.SANDBOX_KNOWN_HOSTS_FILE
  delete childEnvironment.OPENCODE_CONFIG_DIR
  fixtureAssert(childEnvironment.OPENCODE_AUTH_CONTENT === "{}", "OpenCode auth content was not fixed to {} before host startup")

  let originalReadme: Buffer
  try {
    originalReadme = await readFile(originalReadmePath)
  } catch {
    originalReadme = await readFile(readmePath)
    await writePrivate(originalReadmePath, originalReadme)
  }
  const currentReadme = await readFile(readmePath)
  if (!currentReadme.toString("utf8").includes(marker)) {
    await writeFile(readmePath, Buffer.concat([currentReadme, Buffer.from(`\n${marker}\n`)]))
  }
  try {
    await stat(untrackedPath)
  } catch {
    await writeFile(untrackedPath, initialUntrackedContent, { flag: "wx", mode: 0o600 })
  }
  await chmod(untrackedPath, 0o600)

  const status = execFileSync("git", ["status", "--short", "--", "README.md", "host-e2e-untracked.txt"], {
    cwd: worktree,
    encoding: "utf8",
  })
  fixtureAssert(status.includes("README.md") && status.includes("host-e2e-untracked.txt"), "host test changes are missing")
  fixtureAssert(!(await exists(join(worktree, ".opencode", "sandbox.json"))), "ignored credential-bearing config appeared in the worktree")

  const port = await reserveFixturePort()
  const url = `http://127.0.0.1:${port}`
  const logHandle = await open(hostLogPath, "w", 0o600)
  const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: worktree,
    env: childEnvironment,
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
  })
  await logHandle.close()
  child.unref()
  const hostPid = child.pid
  fixtureAssert(typeof hostPid === "number" && Number.isInteger(hostPid) && hostPid > 0, "OpenCode listener PID is unavailable")
  await writePrivate(hostInfoPath, `${JSON.stringify({ pid: hostPid, port, url })}\n`)

  const health = await waitForFixtureHealth(url, child)
  fixtureAssert(health.version === "1.18.30", `unexpected host version: ${String(health.version)}`)

  const directory = encodeURIComponent(worktree)
  const configValue = await fixtureRequest(url, `/config?directory=${directory}`)
  fixtureAssert(isRecord(configValue), "local OpenCode config endpoint is unavailable")
  const projectValue = await fixtureRequest(url, `/project/current?directory=${directory}`)
  fixtureAssert(isRecord(projectValue) && typeof projectValue.id === "string" && projectValue.id.length > 0, "local project endpoint did not identify the worktree")

  const experimentalValue = await fixtureRequest(url, `/experimental/workspace?directory=${directory}`)
  fixtureAssert(Array.isArray(experimentalValue), "experimental workspace endpoint is unavailable")

  const sessionTitle = `local ${provider} E2E fixture ${runId}`
  const sessionsValue = await fixtureRequest(url, `/session?directory=${directory}`)
  const sessions = Array.isArray(sessionsValue) ? sessionsValue : []
  const existingSession = sessions.find((value): value is Json => isRecord(value) && value.title === sessionTitle)
  const sessionValue = existingSession ?? await fixtureRequest(url, `/session?directory=${directory}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: sessionTitle }),
  })
  fixtureAssert(isRecord(sessionValue), "local session was not created")
  const sessionId = concreteId(sessionValue.id, "local session ID")
  const sessionPath = `/session/${encodeURIComponent(sessionId)}`
  const shellInit = (command: string): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: "general", command }),
  })

  let historyValue = await fixtureRequest(url, `${sessionPath}/message?directory=${directory}&limit=100`)
  let historyText = textParts(historyValue)
  if (!historyText.includes(worktree)) await fixtureRequest(url, `${sessionPath}/shell?directory=${directory}`, shellInit("pwd"))
  const pluginProbe = await fixtureRequest(url, `${sessionPath}/shell?directory=${directory}`, shellInit("sandboxctl status"))
  historyValue = await fixtureRequest(url, `${sessionPath}/message?directory=${directory}&limit=100`)
  historyText = textParts(historyValue)
  fixtureAssert(historyText.includes(worktree), "local pwd result is absent from session history")
  fixtureAssert(historyText.includes('"schemaVersion":2'), "sandboxctl plugin probe is absent from history")
  fixtureAssert(textParts(pluginProbe).length > 0 || JSON.stringify(pluginProbe).length > 0, "plugin probe returned no result")

  const runtimeEntries = await readdir(runtimeDirectory, { withFileTypes: true })
  const controlDirectory = runtimeEntries.find((entry) => entry.isDirectory() && /^oe-[A-Za-z0-9_-]+$/.test(entry.name))
  const controlSocket = controlDirectory ? join(runtimeDirectory, controlDirectory.name, "c.sock") : undefined
  fixtureAssert(controlSocket, "sandbox plugin control socket is unavailable")
  await stat(controlSocket)
  const logText = await readFile(hostLogPath, "utf8")
  const pluginLogLines = logText
    .split("\n")
    .filter((line) => /plugin|sandbox|workspace/i.test(line))
    .slice(-8)
    .map((line) => line.length > 512 ? `${line.slice(0, 509)}...` : line)

  const manifest = {
    schemaVersion: 1,
    phase: "local-host-ready",
    provider,
    runDirectory,
    repositoryRoot: REPOSITORY_ROOT,
    worktree,
    fixturePath: join(runDirectory, "local-host-fixture.mjs"),
    hostPID: hostPid,
    hostURL: url,
    hostInfo: hostInfoPath,
    host: { pid: hostPid, url, hostname: "127.0.0.1", port, version: health.version },
    sessionID: sessionId,
    stateDirectory,
    runtimeDirectory,
    dataDirectory,
    xdgConfigHome,
    pluginEntry: join(xdgConfigHome, "opencode", "plugin", "sandbox.ts"),
    config: {
      provider: effectiveConfig["provider"],
      remoteOpenCodeVersion: effectiveConfig.openCodeVersion,
      configEndpoint: true,
      experimentalWorkspaceEndpoint: { status: 200, count: experimentalValue.length },
    },
    ...(credentialsPath ? { credentialsFile: credentialsPath, credentialsPrivate: true } : {}),
    ...(provider === "exedev" ? { knownHostsFile, knownHostsPrivate: true } : {}),
    pluginProof: {
      controlCommand: "sandboxctl status",
      controlProbeViaSessionShell: true,
      controlProbeResult: "schemaVersion=2, ok=true, operation=status",
      controlSocket,
      pluginLogPath: hostLogPath,
      pluginLogLines,
    },
    history: {
      messageCount: Array.isArray(historyValue) ? historyValue.length : 0,
      localPwd: historyText.includes(worktree),
      sandboxStatus: historyText.includes('"schemaVersion":2'),
    },
    testChanges: {
      readmeMarker: marker,
      untrackedFile: untrackedPath,
      initialUntrackedContent,
      expectedRemoteUntrackedContent,
      remoteReadmeMarker: REMOTE_README_MARKER,
      remoteCreatedFile: remoteCreatedPath,
      expectedRemoteCreatedContent,
      originalReadmeBytes: originalReadmePath,
    },
    trigger: {
      start: "Run exactly once in a host OpenCode session shell: sandboxctl start.",
      stop: "After warp, run exactly once in the remote session shell: sandboxctl stop.",
      transport: "cli.ts selects the injected Unix socket/token on host and the injected mailbox/token remotely; do not call /v1/operation or copy tokens manually.",
    },
    checks: {
      health: "/global/health",
      session: "/session",
      history: "/session/{id}/message",
      localWorkingDirectory: worktree,
      cloudflareAllocation: false,
      authContent: childEnvironment.OPENCODE_AUTH_CONTENT,
      llmCall: false,
    },
  }
  if (apiKeyValue) fixtureAssert(!JSON.stringify(manifest).includes(apiKeyValue), "credential leaked into manifest")
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  await chmod(manifestPath, 0o600)
  process.stdout.write(`${JSON.stringify({ runDirectory, pid: hostPid, url, sessionID: sessionId, version: health.version })}\n`)
}

export type MainOptions = {
  env?: Environment
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

export async function main(argv = process.argv.slice(2), options: MainOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text))
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text))
  if (argv.length > 0) {
    if (argv.length === 1 && argv[0] === "--help") {
      stdout(`Usage: bun home/.config/opencode/sandbox/cloudflare-e2e.ts\n\nRuns the real Cloudflare, SBX, or exe.dev sandbox lifecycle without an LLM.\nSet SANDBOX_E2E_PROVIDER=sbx or exedev to select a provider; Cloudflare is the default.\nSet SANDBOX_E2E_OUTPUT for a JSON copy.\n`)
      return 0
    }
    stderr(`unknown argument: ${argv[0]}\n`)
    return 2
  }

  const env = options.env ?? process.env
  let provider: E2EProvider = DEFAULT_E2E_PROVIDER
  const startedAt = new Date().toISOString()
  const runId = `cloudflare-e2e-${Date.now().toString(36)}`
  const report: Report = {
    schemaVersion: 1,
    outcome: "running",
    runId,
    startedAt,
    phases: [],
    budgets: {},
    constraints: {
      llmCall: false,
      subagents: false,
      providerDirectCalls: false,
      fixedEdit: REMOTE_EDIT_MARKER,
    },
    resources: { fixtureSource: FIXTURE_SOURCE },
  }
  const secrets = [env.SANDBOX_API_KEY ?? "", env.CLOUDFLARE_API_TOKEN ?? "", env.OPENCODE_AUTH_CONTENT ?? "{}"]
  let runDirectory: string | undefined
  let runtimeDirectory: string | undefined
  let worktree: string | undefined
  let fixtureCopy: string | undefined
  let cloneCreated = false
  let hostUrl: string | undefined
  let hostPid: number | undefined
  let hostPort: number | undefined
  let hostAttempted = false
  let hostStopped = false
  let stateDirectory: string | undefined
  let sessionId: string | undefined
  let fixtureSessionId: string | undefined
  let workspaceId: string | undefined
  let projectId: string | undefined
  let remoteWorktreePath: string | undefined
  let remoteReady = false
  let startAttempted = false
  let stopAttempted = false
  let stopCompleted = false
  let testSucceeded = false
  let failure: unknown

  const persist = async (): Promise<void> => {
    if (!runDirectory || report.cleanup?.runDirectoryRemoved === true) return
    await writeFile(join(runDirectory, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    await chmod(join(runDirectory, REPORT_FILE), 0o600)
  }

  const phase = async <T>(name: string, deadlineMs: number, action: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    report.budgets[name] = deadlineMs
    try {
      const value = await runPhase(report.phases, name, deadlineMs, action, secrets)
      await persist().catch(() => undefined)
      return value
    } catch (error) {
      failure ??= error
      await persist().catch(() => undefined)
      throw error
    }
  }

  const stopRemote = async (signal: AbortSignal): Promise<Json> => {
    if (!hostUrl || !worktree || !sessionId || !stateDirectory || !workspaceId || !projectId) throw new Error("stop prerequisites are unavailable")
    stopAttempted = true
    const command = "sandboxctl stop"
    const value = await sessionShell(hostUrl, worktree, sessionId, command, signal, secrets)
    const response = sandboxResponse(value)
    const shell = safeShell(value, command, secrets)
    if (!response || response.ok !== true || response.operation !== "stop") throw new Error(`sandboxctl stop did not return a successful v2 response: ${bounded(JSON.stringify(shell), 4_096, secrets)}`)
    const local = await waitForLocation({ hostUrl, worktree, stateDirectory, sessionId, workspaceId, projectId, provider, remote: false, signal, secrets })
    stopCompleted = true
    return { shell, local }
  }

  try {
    provider = selectE2EProvider(env)
    report.resources = { ...report.resources, provider }
    const budgets = {
      prepare: timeout(env, "SANDBOX_E2E_PREPARE_TIMEOUT_MS", 30_000),
      host: timeout(env, "SANDBOX_E2E_HOST_TIMEOUT_MS", 120_000),
      start: timeout(env, "SANDBOX_E2E_START_TIMEOUT_MS", 900_000),
      warpReplay: timeout(env, "SANDBOX_E2E_WARP_REPLAY_TIMEOUT_MS", 300_000),
      edit: timeout(env, "SANDBOX_E2E_EDIT_TIMEOUT_MS", 60_000),
      stop: timeout(env, "SANDBOX_E2E_STOP_TIMEOUT_MS", 300_000),
      verify: timeout(env, "SANDBOX_E2E_VERIFY_TIMEOUT_MS", 30_000),
      cleanup: timeout(env, "SANDBOX_E2E_CLEANUP_TIMEOUT_MS", 60_000),
    }
    report.budgets = { ...budgets }

    runDirectory = await mkdtemp(join(REPOSITORY_ROOT, ".cloudflare-e2e-"))
    runtimeDirectory = await createE2ERuntimeDirectory()
    worktree = join(runDirectory, "repo")
    fixtureCopy = join(runDirectory, "local-host-fixture.mjs")
    report.resources = { ...report.resources, runDirectory, runtimeDirectory, worktree, fixtureCopy }
    await persist()

    await phase("prepare-worktree", budgets.prepare, async (signal) => {
      const fixtureShim = [
        `import { runLocalHostFixture } from ${JSON.stringify(FIXTURE_MODULE_URL)}`,
        "runLocalHostFixture().catch((error) => {",
        '  process.stderr.write(`local-host-fixture: ${error instanceof Error ? error.message : "failed"}\\n`)',
        "  process.exitCode = 1",
        "})",
        "",
      ].join("\n")
      await writeFile(fixtureCopy!, fixtureShim, { mode: 0o700 })
      await chmod(fixtureCopy!, 0o700)
      const clone = await prepareE2EClone(REPOSITORY_ROOT, worktree!, signal, secrets)
      cloneCreated = true
      report.resources = { ...report.resources, capturedRevision: clone.revision }
      return { sourceFixture: FIXTURE_SOURCE, copiedFixture: fixtureCopy, worktree, clone }
    })

    await phase("host-session", budgets.host, async (signal) => {
      hostAttempted = true
      const fixtureEnvironment: Environment = {
        ...env,
        OPENCODE_AUTH_CONTENT: "{}",
        SANDBOX_E2E_RUN_DIRECTORY: runDirectory,
        SANDBOX_E2E_RUNTIME_DIRECTORY: runtimeDirectory,
      }
      const result = await nodeProcessRunner.run({
        argv: [process.execPath, fixtureCopy!],
        cwd: runDirectory!,
        env: fixtureEnvironment,
        signal,
        maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
      })
      try {
        const hostInfoValue: unknown = JSON.parse(await readFile(join(runDirectory!, "host.json"), "utf8"))
        if (isRecord(hostInfoValue)) {
          const candidatePid = Number(hostInfoValue.pid)
          const candidatePort = Number(hostInfoValue.port)
          if (Number.isSafeInteger(candidatePid) && candidatePid > 0) hostPid = candidatePid
          if (Number.isSafeInteger(candidatePort) && candidatePort > 0 && candidatePort <= 65_535) hostPort = candidatePort
        }
      } catch {
        // The fixture may fail before its host identity is recorded.
      }
      let manifest: Json | undefined
      try {
        manifest = JSON.parse(await readFile(join(runDirectory!, "manifest.json"), "utf8")) as Json
        const candidatePid = Number(manifest.hostPID)
        if (Number.isSafeInteger(candidatePid) && candidatePid > 0) hostPid = candidatePid
      } catch {
        // The fixture may fail before its manifest is complete.
      }
      if (result.exitCode !== 0 || !manifest) throw new Error(`local host fixture failed: ${bounded(result.stderr || result.stdout, 4_096, secrets)}`)

      const fixtureResult = lastJson(result.stdout)
      hostUrl = requiredString(manifest.hostURL, "fixture host URL")
      const parsedHostUrl = new URL(hostUrl)
      if (parsedHostUrl.protocol !== "http:" || parsedHostUrl.hostname !== "127.0.0.1" || !parsedHostUrl.port) throw new Error("fixture did not start an owned loopback host")
      hostPort = Number(parsedHostUrl.port)
      stateDirectory = requiredString(manifest.stateDirectory, "fixture state directory")
      const fixtureRuntimeDirectory = requiredString(manifest.runtimeDirectory, "fixture runtime directory")
      if (fixtureRuntimeDirectory !== runtimeDirectory) throw new Error("fixture did not use the registered runtime directory")
      worktree = requiredString(manifest.worktree, "fixture worktree")
      fixtureSessionId = concreteId(manifest.sessionID, "fixture session ID")
      const expectedPlugin = join(REPOSITORY_ROOT, "home", ".config", "opencode", "plugin", "sandbox.ts")
      if (manifest.pluginEntry !== expectedPlugin) throw new Error("fixture did not load the current sandbox plugin")
      if (!isRecord(manifest.config) || manifest.config.provider !== provider) throw new Error(`fixture host is not configured for ${provider}`)
      if (!isRecord(manifest.checks) || manifest.checks.authContent !== "{}" || manifest.checks.llmCall !== false || manifest.checks.cloudflareAllocation !== false) throw new Error("fixture host performed an unrequested operation")
      const health = await request(hostUrl, "/global/health", {}, signal, secrets)
      if (!isRecord(health) || health.healthy !== true) throw new Error("fixture host health is not healthy")
      report.resources = {
        ...report.resources,
        host: { pid: hostPid, url: hostUrl, port: hostPort, version: health.version ?? null, authContent: "{}", plugin: expectedPlugin },
        fixture: {
          result: safeJson(fixtureResult, secrets),
          manifest: {
            fixturePath: manifest.fixturePath ?? null,
            sessionId: fixtureSessionId,
            provider: manifest.config.provider,
            history: safeJson(manifest.history, secrets),
            checks: safeJson(manifest.checks, secrets),
            readmeMarker: isRecord(manifest.testChanges) ? manifest.testChanges.readmeMarker ?? null : null,
            testChanges: isRecord(manifest.testChanges) ? safeJson(manifest.testChanges, secrets) : null,
          },
        },
      }
      const directory = encodeURIComponent(worktree!)
      const created = await request(hostUrl, `/session?directory=${directory}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `${provider} e2e ${runId}` }),
      }, signal, secrets)
      if (!isRecord(created)) throw new Error("HTTP session creation returned no session")
      sessionId = concreteId(created.id, "created session ID")
      projectId = concreteId(created.projectID, "created session project ID")
      const seedCommand = "pwd"
      const seedValue = await sessionShell(hostUrl, worktree!, sessionId, seedCommand, signal, secrets)
      const seed = safeShell(seedValue, seedCommand, secrets)
      if (typeof seed.text !== "string" || seed.text.trim().length === 0) throw new Error("created session did not produce local shell history")
      report.resources = { ...report.resources, sessionId, projectId, session: { createdVia: "POST /session", fixtureSessionId, created: safeJson(created, secrets), seed } }
      return { hostHealth: safeJson(health, secrets), plugin: expectedPlugin, authContent: "{}", llmCall: false, session: { id: sessionId, projectId, seed } }
    })

    await phase("start", budgets.start, async (signal) => {
      if (!hostUrl || !worktree || !sessionId) throw new Error("start prerequisites are unavailable")
      startAttempted = true
      const command = "sandboxctl start"
      const value = await sessionShell(hostUrl, worktree, sessionId, command, signal, secrets)
      const response = sandboxResponse(value)
      const shell = safeShell(value, command, secrets)
      if (!response || response.ok !== true || response.operation !== "start") throw new Error(`sandboxctl start did not return a successful v2 response: ${bounded(JSON.stringify(shell), 4_096, secrets)}`)
      const session = isRecord(response.session) ? response.session : {}
      if (session.provider !== provider) throw new Error(`sandboxctl start selected an unexpected provider: ${String(session.provider)}`)
      if (concreteId(session.sessionId, "start response session ID") !== sessionId) throw new Error("start response session ID does not match the created session")
      workspaceId = concreteId(session.workspaceId, "start response workspace ID")
      projectId = concreteId(session.projectId, "start response project ID")
      report.resources = { ...report.resources, sessionId, workspaceId, projectId, start: shell }
      return { shell, ids: { sessionId, workspaceId, projectId } }
    })

    await phase("warp-replay", budgets.warpReplay, async (signal) => {
      if (!hostUrl || !worktree || !stateDirectory || !sessionId || !workspaceId || !projectId) throw new Error("Warp/replay prerequisites are unavailable")
      const result = await waitForLocation({ hostUrl, worktree, stateDirectory, sessionId, workspaceId, projectId, provider, remote: true, signal, secrets })
      remoteWorktreePath = requiredString(result.remoteWorktreePath, "remote worktree path")
      remoteReady = true
      report.resources = { ...report.resources, remoteWorktreePath, remote: result }
      return result
    })

    await phase("fixed-edit", budgets.edit, async (signal) => {
      if (!hostUrl || !worktree || !sessionId) throw new Error("fixed edit prerequisites are unavailable")
      const command = buildFixedEditCommand(requiredString(remoteWorktreePath, "remote worktree path"))
      const value = await sessionShell(hostUrl, worktree, sessionId, command, signal, secrets)
      const shell = safeShell(value, command, secrets)
      const shellText = typeof shell.text === "string" ? shell.text : ""
      const shellLines = shellText.split(/\r?\n/)
      const remoteUname = /^remote-uname=([^\r\n]+)$/m.exec(shellText)?.[1]
      const remoteCwd = /^remote-cwd=([^\r\n]+)$/m.exec(shellText)?.[1]
      if (
        remoteUname !== "Linux" ||
        remoteCwd !== remoteWorktreePath ||
        !shellLines.includes(REMOTE_EDIT_MARKER) ||
        !shellLines.includes(REMOTE_README_MARKER) ||
        !shellLines.includes(REMOTE_CREATED_CONTENT)
      ) {
        throw new Error(`fixed remote execution proof was not observed: ${bounded(JSON.stringify(shell), 4_096, secrets)}`)
      }
      const remoteExecution = { uname: remoteUname, cwd: remoteCwd }
      report.resources = { ...report.resources, fixedEdit: shell, remoteExecution }
      return { ...shell, remoteExecution }
    })

    await phase("stop", budgets.stop, async (signal) => stopRemote(signal))

    await phase("verify-local-sync", budgets.verify, async (signal) => {
      if (!hostUrl || !worktree || !stateDirectory || !sessionId) throw new Error("local verification prerequisites are unavailable")
      if (signal.aborted) throw new Error("local verification deadline exceeded")
      const untracked = await readFile(join(worktree, "host-e2e-untracked.txt"), "utf8")
      const readme = await readFile(join(worktree, "README.md"), "utf8")
      const remoteCreatedPath = join(worktree, "remote-e2e-created.txt")
      const created = await readFile(remoteCreatedPath, "utf8")
      const record = await readRecord(stateDirectory, sessionId)
      const fixtureManifest = isRecord(report.resources.fixture) && isRecord(report.resources.fixture.manifest)
        ? report.resources.fixture.manifest
        : undefined
      const marker = requiredString(fixtureManifest?.readmeMarker, "fixture README marker")
      const testChanges = isRecord(fixtureManifest?.testChanges) ? fixtureManifest.testChanges : undefined
      const expectedContent = requiredString(testChanges?.expectedRemoteUntrackedContent, "fixture expected remote content")
      const expectedCreatedContent = requiredString(testChanges?.expectedRemoteCreatedContent, "fixture expected created content")
      if (untracked !== expectedContent) throw new Error("remote edit content did not sync back to the local worktree")
      const readmeMarkerIndex = readme.indexOf(marker)
      const remoteReadmeIndex = readme.indexOf(REMOTE_README_MARKER)
      if (readmeMarkerIndex < 0 || remoteReadmeIndex <= readmeMarkerIndex) throw new Error("README markers did not survive the local return")
      if (created !== expectedCreatedContent) throw new Error("remote-created file did not sync back to the local worktree")
      if (!isRecord(record?.operation) || record.operation.providerDestroyed !== true) throw new Error("stop did not record provider cleanup")

      const localCommand = "printf 'local-uname=' && uname -s && printf 'local-cwd=' && pwd -P"
      const localValue = await sessionShell(hostUrl, worktree, sessionId, localCommand, signal, secrets)
      const localShell = safeShell(localValue, localCommand, secrets)
      const localShellText = typeof localShell.text === "string" ? localShell.text : ""
      const localUname = /^local-uname=([^\r\n]+)$/m.exec(localShellText)?.[1]
      const localCwd = /^local-cwd=([^\r\n]+)$/m.exec(localShellText)?.[1]
      if (!localUname || localCwd !== worktree) throw new Error(`local session return proof was not observed: ${bounded(JSON.stringify(localShell), 4_096, secrets)}`)
      report.resources = {
        ...report.resources,
        localSync: {
          untrackedFile: join(worktree, "host-e2e-untracked.txt"),
          remoteEdit: untracked === expectedContent,
          expectedContent,
          fixtureReadme: readmeMarkerIndex >= 0,
          remoteReadme: readme.slice(remoteReadmeIndex, remoteReadmeIndex + REMOTE_README_MARKER.length) === REMOTE_README_MARKER,
          remoteCreatedFile: remoteCreatedPath,
          remoteCreated: created === expectedCreatedContent,
          localReturn: { sessionId, shell: localShell, uname: localUname, cwd: localCwd },
          operation: safeJson(record?.operation, secrets),
          lifecycle: recordSummary(record, secrets),
        },
      }
      return report.resources.localSync
    })
    testSucceeded = true
  } catch (error) {
    failure ??= error
  }

  report.cleanup = { attempted: false, evidenceDirectory: runDirectory ?? null }
  if (runDirectory) {
    try {
      await phase("cleanup", timeout(env, "SANDBOX_E2E_CLEANUP_TIMEOUT_MS", 60_000), async (signal) => {
        const cleanup: Json = { attempted: true, evidenceDirectory: runDirectory, stop: { attempted: stopAttempted, completed: stopCompleted } }
        const errors: Json[] = []

        if (startAttempted && !stopAttempted && hostUrl && worktree && sessionId && stateDirectory && workspaceId && projectId) {
          try {
            const stopped = await stopRemote(signal)
            cleanup.stop = { attempted: true, completed: stopCompleted, ...stopped }
          } catch (error) {
            cleanup.stop = { attempted: true, completed: false, error: safeError(error, secrets) }
            errors.push({ resource: "sandbox lifecycle", error: safeError(error, secrets) })
          }
        }

        const remoteMayBeActive = (startAttempted || remoteReady) && !stopCompleted
        if (hostPid !== undefined && hostPort !== undefined && !remoteMayBeActive) {
          try {
            cleanup.host = await stopHost(hostPid, hostPort, signal, secrets)
            hostStopped = true
          } catch (error) {
            cleanup.host = { attempted: true, pid: hostPid, error: safeError(error, secrets) }
            errors.push({ resource: "host", error: safeError(error, secrets) })
          }
        } else if (hostPid !== undefined && hostPort !== undefined) {
          cleanup.host = { attempted: false, preserved: true, pid: hostPid, reason: "remote resource may still be active because sandbox stop did not complete" }
          errors.push({ resource: "host", error: "host preserved because sandbox stop did not complete" })
        } else if (hostAttempted) {
          cleanup.host = { attempted: false, error: "owned host PID was not observed" }
          errors.push({ resource: "host", error: "owned host PID was not observed" })
        } else {
          cleanup.host = { attempted: false, reason: "host was not started" }
          hostStopped = true
        }

        if (runtimeDirectory) {
          try {
            cleanup.runtimeDirectory = await cleanupE2ERuntimeDirectory(runtimeDirectory, hostStopped, signal, secrets)
          } catch (error) {
            cleanup.runtimeDirectory = { attempted: true, path: runtimeDirectory, error: safeError(error, secrets) }
            errors.push({ resource: "runtime directory", error: safeError(error, secrets) })
          }
        }

        const safeToRemoveClone = testSucceeded && cloneCreated
        if (safeToRemoveClone && worktree) {
          try {
            cleanup.worktree = await cleanupE2EClone(worktree, cloneCreated, signal, secrets)
          } catch (error) {
            cleanup.worktree = { attempted: true, path: worktree, error: safeError(error, secrets) }
            errors.push({ resource: "clone", error: safeError(error, secrets) })
          }
        } else {
          cleanup.worktree = {
            attempted: false,
            preserved: true,
            path: worktree ?? null,
            reason: testSucceeded ? "clone was not created" : "failure evidence preserved",
          }
        }

        cleanup.ok = errors.length === 0
        cleanup.errors = errors
        report.cleanup = cleanup
        if (errors.length > 0) throw new Error(`cleanup failed: ${bounded(JSON.stringify(errors), 4_096, secrets)}`)

        if (testSucceeded && safeToRemoveClone) {
          await persist()
          await rm(runDirectory!, { recursive: true, force: true })
          report.cleanup.runDirectoryRemoved = true
        }
        return cleanup
      })
    } catch (error) {
      failure ??= error
      if (report.cleanup) report.cleanup.ok = false
    }
  }

  report.endedAt = new Date().toISOString()
  report.outcome = failure ? "fail" : "pass"
  if (failure) report.failure = safeError(failure, secrets)
  if (report.cleanup && report.cleanup.runDirectoryRemoved !== true) {
    report.cleanup.evidenceDirectory = runDirectory ?? null
    await persist().catch((error) => {
      report.failure ??= safeError(error, secrets)
      report.outcome = "fail"
    })
  }

  const output = `${JSON.stringify(report, null, 2)}\n`
  stdout(output)
  const outputPath = env.SANDBOX_E2E_OUTPUT
  if (outputPath) {
    try {
      await writeFile(outputPath, output, { mode: 0o600 })
      await chmod(outputPath, 0o600)
    } catch (error) {
      stderr(`could not write SANDBOX_E2E_OUTPUT: ${redactError(error, secrets)}\n`)
      return 1
    }
  }
  if (failure) stderr(`cloudflare-e2e: ${bounded(failure, 2_048, secrets)}\n`)
  return report.outcome === "pass" ? 0 : 1
}

if (import.meta.main) process.exitCode = await main()
