import { randomUUID } from "node:crypto"
import { chmod, writeFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"

import { DEFAULT_CLOUDFLARE_HEALTH_TIMEOUT_MS, loadConfig } from "./config"
import { assertSandboxId, CloudflareBridgeClient, parseCloudflareBridgeUrl, waitForAbort, type CloudflareSandboxClient } from "./cloudflare-bridge"
import { CloudflareProvider } from "./cloudflare-provider"
import { shortHash } from "./naming"
import { redactError, redactText } from "./redaction"
import { readLimitedBody } from "./workspace-http"
import { isRecord, SandboxError, type WorkspaceInfo, type WorkspaceTarget } from "./types"

const MAX_TELEMETRY_EVENTS = 25
const MAX_LOG_BYTES = 48 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_TELEMETRY_TIMEOUT_MS = 30_000
const TELEMETRY_POLL_INTERVAL_MS = 500
const CONNECTOR_EXEC_TIMEOUT_MS = 10_000
const WORKER_NAME_FIELD = "$workers.scriptName"
const MAX_HEALTH_EVIDENCE_BYTES = 1_024

type Json = Record<string, unknown>

export const parseCloudflaredTokenIdentity: (token: string) => Json = function (token) {
  if (Buffer.byteLength(token) > 4 * 1024) return { status: "unavailable" }
  try {
    const value = JSON.parse(Buffer.from(token.trim(), "base64").toString("utf8"))
    const tunnelId = value && typeof value === "object" && !Array.isArray(value) && typeof value.t === "string" ? value.t : undefined
    return tunnelId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tunnelId) ? { tunnelId } : { status: "unavailable" }
  } catch {
    return { status: "unavailable" }
  }
}

const LOOPBACK_HEALTH_SCRIPT = `
const input = JSON.parse(await Bun.stdin.text())
try {
  const response = await fetch("http://127.0.0.1:" + input.port + "/global/health", {
    headers: { Authorization: input.authorization },
  })
  const body = (await response.text()).slice(0, 65536)
  console.log(JSON.stringify({ status: response.status, body }))
  process.exitCode = response.ok ? 0 : 1
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}`

export function connectorSnapshotScript(procRoot = "/proc"): string {
  return `
const { readdir, readlink } = await import("node:fs/promises")
const root = ${JSON.stringify(procRoot)}
const parseTokenIdentity = ${parseCloudflaredTokenIdentity.toString()}
const MAX_PROCESSES = 8, MAX_LISTENERS = 8, MAX_BODY_BYTES = 16 * 1024, MAX_OUTPUT_BYTES = 48 * 1024, MAX_CMDLINE_BYTES = 8 * 1024, MAX_TOKEN_FILE_BYTES = 4 * 1024, FETCH_TIMEOUT_MS = 2_000
const read = (path) => Bun.file(path).text(), readLimited = async (path, maxBytes) => { const bytes = new Uint8Array(await Bun.file(path).slice(0, maxBytes + 1).arrayBuffer()); return { text: new TextDecoder().decode(bytes.subarray(0, maxBytes)), truncated: bytes.byteLength > maxBytes } }, loopback = (address, family) => family === "tcp" ? address.toUpperCase() === "0100007F" : address.toUpperCase() === "00000000000000000000000001000000"
function netListeners(text, family) {
  const result = new Map()
  for (const line of text.split(/\\r?\\n/).slice(1)) { const fields = line.trim().split(/\\s+/), local = fields[1] ?? "", separator = local.lastIndexOf(":"), inode = fields[9]; if (fields[3] !== "0A" || separator < 0 || !inode || !loopback(local.slice(0, separator), family)) continue; const port = Number.parseInt(local.slice(separator + 1), 16); if (Number.isSafeInteger(port) && port > 0 && port <= 65535) result.set(inode, { port, family, host: family === "tcp" ? "127.0.0.1" : "::1", state: "LISTEN" }) }
  return result
}
async function readBody(response, signal) {
  const reader = response.body?.getReader()
  if (!reader) { const bytes = Buffer.from(await response.text()); return { text: new TextDecoder().decode(bytes.subarray(0, MAX_BODY_BYTES)), truncated: bytes.byteLength > MAX_BODY_BYTES } }
  const chunks = [], abort = () => { void reader.cancel().catch(() => undefined) }
  let size = 0
  signal.addEventListener("abort", abort, { once: true })
  try {
    while (true) { const next = await reader.read(); if (next.done) break; const remaining = MAX_BODY_BYTES - size; if (next.value.byteLength > remaining) { if (remaining > 0) chunks.push(next.value.subarray(0, remaining)); await reader.cancel().catch(() => undefined); size = MAX_BODY_BYTES; return { text: new TextDecoder().decode(Buffer.concat(chunks, size)), truncated: true } } chunks.push(next.value); size += next.value.byteLength }
    return { text: new TextDecoder().decode(Buffer.concat(chunks, size)), truncated: false }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error }
  finally { signal.removeEventListener("abort", abort); reader.releaseLock() }
}
function connectionMetrics(text) {
  const result = {}
  for (const line of text.split(/\\r?\\n/)) { const match = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\\{[^}]*\\})?\\s+([-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?)(?:\\s+\\d+)?$/.exec(line.trim()); if (!match || !match[1].startsWith("cloudflared_") || !/(connection|config_version|config_push)/i.test(match[1])) continue; const value = Number(match[2]); if (!Number.isFinite(value)) continue; const previous = result[match[1]]; result[match[1]] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value] }
  return result
}
function tokenArgument(args) {
  for (let index = 0; index < args.length; index++) { const arg = args[index] ?? ""; if (arg === "--token") return { token: args[index + 1] ?? "" }; if (arg.startsWith("--token=")) return { token: arg.slice("--token=".length) }; if (arg === "--token-file") return { file: args[index + 1] ?? "" }; if (arg.startsWith("--token-file=")) return { file: arg.slice("--token-file=".length) } }
  return {}
}
async function tokenIdentity(args) {
  const source = tokenArgument(args)
  if (Object.hasOwn(source, "token")) return parseTokenIdentity(source.token)
  if (!source.file) return { status: "unavailable" }
  try { const file = await readLimited(source.file, MAX_TOKEN_FILE_BYTES); return file.truncated ? { status: "unavailable" } : parseTokenIdentity(file.text) } catch { return { status: "unavailable" } }
}
async function endpoint(host, port, path, metrics) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const address = host.includes(":") ? "[" + host + "]" : host
    const response = await fetch("http://" + address + ":" + port + path, { signal: controller.signal }), body = await readBody(response, controller.signal)
    if (metrics) return { status: response.status, ok: response.ok, metrics: connectionMetrics(body.text), ...(body.truncated ? { truncated: true } : {}) }
    let value = body.text; try { value = JSON.parse(body.text) } catch {}
    return { status: response.status, ok: response.ok, body: value, ...(body.truncated ? { truncated: true } : {}) }
  } catch { return { status: null, ok: false, error: "fetch failed" } }
  finally { clearTimeout(timeout) }
}
async function snapshot() {
  let entries
  try {
    entries = (await readdir(root)).filter((entry) => /^\\d+$/.test(entry)).sort((left, right) => Number(left) - Number(right))
  } catch {
    return { status: "inaccessibleproc", processes: [], listeners: [], tokenIdentity: { status: "unavailable" } }
  }

  const processes = []
  let connectorIdentity = { status: "unavailable" }
  let inaccessible = false
  for (const pidText of entries) {
    let comm, cmdline
    const pid = Number(pidText)
    if (!Number.isSafeInteger(pid) || pid < 1) continue
    try {
      const values = await Promise.all([read(root + "/" + pidText + "/comm"), readLimited(root + "/" + pidText + "/cmdline", MAX_CMDLINE_BYTES)])
      comm = values[0]
      cmdline = values[1].text
    } catch {
      inaccessible = true
      continue
    }
    const args = cmdline.split("\\0").filter(Boolean)
    const command = (args[0] ?? "").split("/").pop()
    if (comm.trim() !== "cloudflared" && command !== "cloudflared") continue
    processes.push({ pid, role: "cloudflared", state: "running" })
    if (!connectorIdentity.tunnelId) {
      const identity = await tokenIdentity(args)
      if (identity.tunnelId) connectorIdentity = identity
    }
    if (processes.length === MAX_PROCESSES) break
  }
  if (processes.length === 0) return { status: inaccessible ? "inaccessibleproc" : "missingprocess", processes: [], listeners: [], tokenIdentity: { status: "unavailable" } }

  let tcp = "", tcp6 = ""
  try { tcp = await read(root + "/net/tcp") } catch { inaccessible = true }
  try { tcp6 = await read(root + "/net/tcp6") } catch (error) { if (error?.code !== "ENOENT") return { status: "inaccessibleproc", processes, listeners: [], tokenIdentity: connectorIdentity } }
  const sockets = new Map([...netListeners(tcp, "tcp"), ...netListeners(tcp6, "tcp6")])
  const listeners = [], seen = new Set()
  for (const process of processes) {
    let fds
    try { fds = await readdir(root + "/" + process.pid + "/fd") } catch { inaccessible = true; continue }
    for (const fd of fds) {
      if (fd === "0" || fd === "1" || fd === "2") continue
      let link
      try { link = await readlink(root + "/" + process.pid + "/fd/" + fd) } catch { inaccessible = true; continue }
      const inode = /^socket:\\[(\\d+)\\]$/.exec(link)?.[1]
      const listener = inode ? sockets.get(inode) : undefined
      if (!listener) continue
       const key = process.pid + ":" + listener.family + ":" + listener.port
      if (seen.has(key)) continue
      seen.add(key)
       listeners.push({ pid: process.pid, role: "metrics", state: listener.state, port: listener.port, family: listener.family, host: listener.host })
      if (listeners.length === MAX_LISTENERS) break
    }
    if (listeners.length === MAX_LISTENERS) break
  }
  if (listeners.length === 0) return { status: inaccessible ? "inaccessibleproc" : "missinglistener", processes, listeners, tokenIdentity: connectorIdentity }

  const endpoints = await Promise.all([...new Map(listeners.map((listener) => [listener.family + ":" + listener.port, listener])).values()].map(async (listener) => {
    const [ready, metrics] = await Promise.all([endpoint(listener.host, listener.port, "/ready", false), endpoint(listener.host, listener.port, "/metrics", true)])
    return { family: listener.family, host: listener.host, port: listener.port, ready, metrics }
  }))
  return { status: endpoints.every((entry) => entry.ready.ok && entry.metrics.ok) ? "ok" : "fetchfail", processes, listeners, endpoints, tokenIdentity: connectorIdentity }
}
function emit(value) {
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text) + 1 <= MAX_OUTPUT_BYTES) return console.log(text)
  console.log(JSON.stringify({ status: "inaccessibleproc", reason: "connector snapshot output exceeded its limit", processes: value.processes?.slice(0, MAX_PROCESSES) ?? [], listeners: value.listeners?.slice(0, MAX_LISTENERS) ?? [], tokenIdentity: value.tokenIdentity?.tunnelId ? { tunnelId: value.tokenIdentity.tunnelId } : { status: "unavailable" }, truncated: true }))
}
try { emit(await snapshot()) } catch { emit({ status: "inaccessibleproc", processes: [], listeners: [], tokenIdentity: { status: "unavailable" } }) }
`
}

export type TelemetryEventSummary = Json & { id: string; scriptName?: string; requestId?: string; outcome?: string; level?: string; message?: string; error?: string; payload?: string }
export type TelemetryPage = { count?: number; truncated: boolean; events: TelemetryEventSummary[] }

export function parseTelemetryEvents(value: unknown, limit = MAX_TELEMETRY_EVENTS, secrets: readonly string[] = []): TelemetryPage {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("telemetry event limit must be positive")
  const root = objectAt(value, "response")
  const result = objectAt(root.result, "result")
  const events = objectAt(result.events, "result.events")
  if (!Array.isArray(events.events)) throw new Error("Workers Observability response is missing result.events.events[]")

  const count = typeof events.count === "number" && Number.isSafeInteger(events.count) && events.count >= 0 ? events.count : undefined
  return {
    ...(count === undefined ? {} : { count }),
    truncated: events.events.length > limit,
    events: events.events.slice(0, limit).map((value, index) => {
      const event = objectAt(value, `result.events.events[${index}]`)
      const metadata = objectAt(event.$metadata, `result.events.events[${index}].$metadata`)
      if (typeof metadata.id !== "string" || metadata.id.length === 0) throw new Error(`Workers Observability event ${index} is missing $metadata.id`)
      const workers = isRecord(event.$workers) ? event.$workers : {}
      const payload = typeof event.source === "string" ? event.source : isRecord(event.source) ? JSON.stringify(event.source) : undefined
      return {
        id: metadata.id,
        ...(typeof workers.scriptName === "string" ? { scriptName: workers.scriptName } : {}),
        ...(typeof workers.requestId === "string" ? { requestId: workers.requestId } : typeof metadata.requestId === "string" ? { requestId: metadata.requestId } : {}),
        ...(typeof workers.outcome === "string" ? { outcome: workers.outcome } : {}),
        ...(typeof metadata.level === "string" ? { level: metadata.level } : {}),
        ...(typeof metadata.message === "string" ? { message: trim(redactText(metadata.message, secrets)) } : {}),
        ...(typeof metadata.error === "string" ? { error: trim(redactText(metadata.error, secrets)) } : {}),
        ...(payload === undefined ? {} : { payload: trim(redactText(payload, secrets)) }),
      }
    }),
  }
}

export type SmokeStage = { name: string; status: "PASS" | "FAIL"; startedAt: string; endedAt: string; details?: Json; error?: Json }
export type SmokeAttempt = { startedAt: string; endedAt?: string }
export type SmokeResult = { schemaVersion: 1; runId: string; outcome: "pass" | "fail"; attempt: SmokeAttempt; stages: SmokeStage[]; resources: Json; evidence?: Json; cleanup?: Json; telemetry?: Json; failure?: Json }
export type SmokeOptions = { env?: Record<string, string | undefined>; worktree?: string; fetcher?: typeof fetch; client?: CloudflareSandboxClient; runId?: string; telemetryTimeoutMs?: number; telemetryPollMs?: number }

export async function runSmoke(options: SmokeOptions = {}): Promise<SmokeResult> {
  const env = options.env ?? process.env
  const runId = options.runId ?? randomUUID()
  const startedAt = new Date().toISOString()
  const result: SmokeResult = { schemaVersion: 1, runId, outcome: "fail", attempt: { startedAt }, stages: [], resources: {} }
  const worktree = options.worktree ?? env.SANDBOX_WORKTREE ?? process.cwd()
  const authContent = env.OPENCODE_AUTH_CONTENT ?? "{}"
  const accountId = env.CLOUDFLARE_ACCOUNT_ID
  const telemetryToken = env.CLOUDFLARE_API_TOKEN
  const workerName = env.CLOUDFLARE_WORKER_NAME
  const baseFetcher = options.fetcher ?? fetch
  let apiKey = ""
  let apiOrigin: string | undefined
  let bridgeBasePath = ""
  let client: CloudflareSandboxClient | undefined
  let provider: CloudflareProvider | undefined
  let prepared = false
  let prepareAttempted = false
  let sandboxId: string | undefined
  let remotePort = 4096
  let healthTimeoutMs = DEFAULT_CLOUDFLARE_HEALTH_TIMEOUT_MS
  let bootstrapTimeoutMs = 600_000
  let openCodeVersion = "1.18.23"
  let target: Extract<WorkspaceTarget, { type: "remote" }> | undefined
  let failure: unknown

  const workspaceId = `smoke-${shortHash(runId)}`
  const projectId = `smoke-project-${shortHash(runId)}`
  const info: WorkspaceInfo = {
    id: workspaceId,
    type: "cloudflare",
    name: `oc-cf-${shortHash(workspaceId)}`,
    branch: `opencode/sandbox-${shortHash(workspaceId)}`,
    directory: "/workspace",
    projectID: projectId,
    extra: { sessionId: `smoke-session-${shortHash(runId)}`, generation: 1, workspaceId, projectId },
  }
  const secrets = () => [apiKey, telemetryToken ?? "", authContent, ...basicAuthSecrets(target?.headers)]
  const safeError = (error: unknown): Json => ({
    message: redactError(error, secrets()),
    ...(error instanceof SandboxError
      ? { stage: error.stage, code: error.code, ...(error.details ? { details: sanitizeSmokeOutput(error.details, secrets()) } : {}) }
      : {}),
  })
  const instrumentedFetch = (async (input, init) => {
    const original = new URL(input instanceof Request ? input.url : String(input))
    const url = new URL(original)
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    for (const [key, value] of new Headers(init?.headers).entries()) headers.set(key, value)
    const isBridge = apiOrigin !== undefined && url.origin === apiOrigin
    if (isBridge) {
      // The URL is recorded by invocation logs; the header also survives in request metadata.
      url.searchParams.set("opencode_smoke_run", runId)
      headers.set("x-opencode-smoke-run", runId)
    }
    return baseFetcher(url, { ...init, headers })
  }) as typeof fetch

  const stage = async (name: string, action: () => Promise<Json>): Promise<boolean> => {
    const stageStartedAt = new Date().toISOString()
    try {
      const details = await action()
      result.stages.push({ name, status: "PASS", startedAt: stageStartedAt, endedAt: new Date().toISOString(), details })
      return true
    } catch (error) {
      failure ??= error
      result.stages.push({ name, status: "FAIL", startedAt: stageStartedAt, endedAt: new Date().toISOString(), error: safeError(error) })
      return false
    }
  }

  try {
    const steps: Array<[string, () => Promise<Json>]> = [
      ["config", async () => {
        const config = await loadConfig(worktree, { ...env, SANDBOX_PROVIDER: "cloudflare" })
        const apiUrl = required(config.apiUrl ?? undefined, "SANDBOX_API_URL (config or environment)")
        apiKey = required(config.apiKey ?? undefined, "SANDBOX_API_KEY (config or environment)")
        remotePort = positiveInteger(env.SANDBOX_REMOTE_PORT, config.remotePort, 65_535)
        healthTimeoutMs = positiveInteger(env.SANDBOX_HEALTH_TIMEOUT_MS, config.healthTimeoutMs, 600_000)
        bootstrapTimeoutMs = positiveInteger(env.SANDBOX_BOOTSTRAP_TIMEOUT_MS, config.bootstrapTimeoutMs, 3_600_000)
        openCodeVersion = env.SANDBOX_OPENCODE_VERSION ?? config.openCodeVersion
        const parsedUrl = parseCloudflareBridgeUrl(apiUrl)
        apiOrigin = parsedUrl.origin
        bridgeBasePath = parsedUrl.pathname.replace(/\/$/, "").replace(/\/v1$/, "")
        client = options.client ?? new CloudflareBridgeClient({ apiUrl: parsedUrl, apiKey, fetcher: instrumentedFetch, requestTimeoutMs: bootstrapTimeoutMs })
        provider = new CloudflareProvider({ worktree, client, fetcher: instrumentedFetch, remotePort, healthTimeoutMs, bootstrapTimeoutMs, openCodeVersion, deferActivation: true })
        return { provider: config.provider, bridgeUrl: "configured", worktree, remotePort, healthTimeoutMs, openCodeVersion }
      }],
      ["bridge-health", async () => {
        const response = await request(instrumentedFetch, new URL(`${bridgeBasePath}/health`, `${apiOrigin}/`), {}, DEFAULT_REQUEST_TIMEOUT_MS, "bridge_health")
        if (!response.response.ok) throw new Error(`Cloudflare bridge health returned HTTP ${response.response.status}`)
        return { status: response.response.status, transport: "cloudflare-bridge" }
      }],
      ["bootstrap", async () => {
        if (!provider) throw new Error("Cloudflare provider was not initialized")
        prepareAttempted = true
        await provider.prepare(info, { OPENCODE_AUTH_CONTENT: authContent })
        prepared = true
        const value = provider.runtimeMetadata(workspaceId)?.providerState?.sandboxId
        if (typeof value !== "string") throw new Error("Cloudflare provider did not expose its sandbox ID")
        assertSandboxId(value)
        sandboxId = value
        result.resources = { ...result.resources, sandboxId }
        return { sandboxId, bootstrapTimeoutMs }
      }],
      ["resource-health", async () => {
        if (!provider || !sandboxId) throw new Error("Cloudflare sandbox is unavailable")
        const observation = await provider.inspect(info)
        if (observation.resource !== "present" || observation.ownership !== "verified") throw new Error("Cloudflare sandbox ownership or presence is not verified")
        return { resource: observation.resource, ownership: observation.ownership, health: observation.health, sandboxId }
      }],
      ["activate", async () => {
        if (!provider || !sandboxId) throw new Error("Cloudflare sandbox is unavailable")
        await provider.activate(workspaceId)
        const next = await provider.target(info)
        if (next.type !== "remote") throw new Error("Cloudflare provider returned a local target")
        target = next
        const tunnelHostname = safeTunnelHostname(target.url)
        const tunnelUrl = String(target.url)
        result.resources = { ...result.resources, tunnelUrl, tunnelHostname, tunnelPort: remotePort }
        return { sandboxId, tunnelUrl, tunnelHostname, authentication: "basic auth" }
      }],
      ["loopback-health", async () => {
        if (!client || !sandboxId || !target) throw new Error("authenticated loopback target is unavailable")
        const health = await probeLoopback(client, sandboxId, remotePort, target.headers, secrets())
        result.evidence = { ...(result.evidence ?? {}), loopback: health }
        if (health.ok !== true) throw new SandboxError("loopback_health", "authenticated OpenCode loopback health was not healthy", "LOOPBACK_HEALTH")
        return health
      }],
      ["remote-health", async () => {
        if (!target) throw new Error("authenticated remote target is unavailable")
        const response = await request(instrumentedFetch, new URL("/global/health", target.url), { headers: target.headers ?? {} }, DEFAULT_REQUEST_TIMEOUT_MS, "remote_health")
        const health = publicHealthDetails(response.response.status, response.text, response.response.ok, response.response.headers.get("cf-ray"), secrets())
        if (health.ok !== true) throw new SandboxError("remote_health", `authenticated OpenCode remote health was not healthy (HTTP ${health.status})`, "REMOTE_HEALTH", health)
        return { ...health, transport: "cloudflare-tunnel" }
      }],
    ]
    for (const [name, action] of steps) if (!await stage(name, action)) break
  } catch (error) {
    failure ??= error
  } finally {
    const evidence = result.evidence ?? {}
    if (client && sandboxId) {
      if (!evidence.loopback && provider) {
        const next = await provider.target(info).catch(() => undefined)
        if (next?.type === "remote") {
          target = next
          evidence.loopback = await probeLoopback(client, sandboxId, remotePort, target.headers, secrets()).catch((error) => ({ available: false, error: safeError(error) }))
        } else {
          evidence.loopback = { available: false, reason: "activation did not expose an authenticated target" }
        }
      }
      evidence.serverLog = await readServerLog(client, sandboxId, workspaceId, secrets()).catch((error) => ({ available: false, error: safeError(error) }))
      } else {
        evidence.loopback = { available: false, reason: "sandbox ID was not observed" }
        evidence.serverLog = { available: false, reason: "sandbox ID was not observed" }
      }
      try {
        evidence.connector = await connectorSnapshot(client, sandboxId, secrets())
      } catch {
        const snapshotTime = new Date().toISOString()
        evidence.connector = { status: "inaccessibleproc", reason: "connector snapshot was unavailable", tokenIdentity: { status: "unavailable" }, startedAt: snapshotTime, endedAt: snapshotTime }
      }
      result.evidence = evidence
      if (client && sandboxId) result.telemetry = await collectTelemetry(accountId, telemetryToken, workerName, runId, startedAt, baseFetcher, secrets, safeError, options.telemetryTimeoutMs, options.telemetryPollMs)
      result.cleanup = await cleanup(provider, prepared, prepareAttempted, info, sandboxId)
      if (result.cleanup.ok === false && !failure) failure = new SandboxError("remove", "Cloudflare sandbox cleanup failed", "CLEANUP_FAILED")
      if (failure) result.failure = { error: safeError(failure) }
      result.outcome = failure || result.cleanup.ok === false ? "fail" : "pass"
      result.attempt.endedAt = new Date().toISOString()
    }
  return result
}

async function cleanup(provider: CloudflareProvider | undefined, prepared: boolean, prepareAttempted: boolean, info: WorkspaceInfo, sandboxId: string | undefined): Promise<Json> {
  if (!sandboxId) return { attempted: false, ownership: "unknown", remoteAbsence: "unverified", ok: true, reason: "no sandbox ID was observed" }
  if (!prepared) return { attempted: prepareAttempted, ownership: "verified", sandboxId, remoteAbsence: "unverified", rollback: "provider prepare rollback", ok: true }
  if (!provider) return { attempted: false, ownership: "unknown", sandboxId, remoteAbsence: "unverified", ok: false, reason: "provider is unavailable" }
  try {
    await provider.close(info)
    return { attempted: true, ownership: "verified", sandboxId, remoteAbsence: "unverified", method: "provider.close", ok: true }
  } catch (error) {
    return { attempted: true, ownership: "verified", sandboxId, remoteAbsence: "unverified", method: "provider.close", ok: false, error: redactError(error) }
  }
}

export function parseConnectorSnapshotOutput(stdout: string, startedAt: string, endedAt: string, secrets: readonly string[] = []): Json {
  if (Buffer.byteLength(stdout) > MAX_LOG_BYTES) return { status: "inaccessibleproc", reason: "connector snapshot output exceeded its limit", tokenIdentity: { status: "unavailable" }, startedAt, endedAt }
  try {
    const value: unknown = JSON.parse(stdout)
    if (!isRecord(value) || typeof value.status !== "string") throw new Error("invalid connector snapshot")
    const safe = sanitizeSmokeOutput(value, secrets)
    const output = isRecord(safe) ? safe : { status: "inaccessibleproc" }
    const readyConnections = connectorReadyConnections(output)
    return {
      ...output,
      tokenIdentity: output.tokenIdentity ?? { status: "unavailable" },
      ...(readyConnections === undefined ? {} : { readyConnections }),
      ...connectorMetricEvidence(output),
      startedAt,
      endedAt,
    }
  } catch {
    return { status: "inaccessibleproc", reason: "connector snapshot output was invalid", tokenIdentity: { status: "unavailable" }, startedAt, endedAt }
  }
}

async function connectorSnapshot(client: CloudflareSandboxClient | undefined, sandboxId: string | undefined, secrets: readonly string[]): Promise<Json> {
  const startedAt = new Date().toISOString()
  try {
    if (!client || !sandboxId) return { status: "missingprocess", reason: "sandbox ID was not observed", tokenIdentity: { status: "unavailable" }, startedAt, endedAt: new Date().toISOString() }
    const signal = AbortSignal.timeout(CONNECTOR_EXEC_TIMEOUT_MS)
    const result = await waitForAbort(() => client.exec(sandboxId, {
      argv: ["bun", "-e", connectorSnapshotScript()],
      timeoutMs: CONNECTOR_EXEC_TIMEOUT_MS,
      signal,
    }), signal)
    const endedAt = new Date().toISOString()
    if (result.exitCode !== 0 || result.signal !== null) return { status: "inaccessibleproc", reason: "connector snapshot command failed", tokenIdentity: { status: "unavailable" }, startedAt, endedAt }
    return parseConnectorSnapshotOutput(result.stdout, startedAt, endedAt, secrets)
  } catch {
    return { status: "inaccessibleproc", reason: "connector snapshot was unavailable", tokenIdentity: { status: "unavailable" }, startedAt, endedAt: new Date().toISOString() }
  }
}

export type TelemetryQueryInput = { accountId: string; apiToken: string; workerName?: string; runId: string; from: number; to: number | (() => number); fetcher: typeof fetch; timeoutMs?: number; secrets?: readonly string[] }
export type TelemetryQueryResult = { count?: number; events: TelemetryEventSummary[]; truncated: boolean }

export async function queryTelemetry(input: TelemetryQueryInput): Promise<TelemetryQueryResult> {
  if (!input.runId) throw new Error("telemetry run ID is required")
  if (!Number.isSafeInteger(input.from) || input.from < 0) throw new Error("telemetry start time is invalid")
  const timeoutMs = input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("telemetry request timeout is invalid")
  const to = typeof input.to === "function" ? input.to() : input.to
  if (!Number.isSafeInteger(to) || to < input.from) throw new Error("telemetry end time is invalid")
  const response = await request(input.fetcher, `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/workers/observability/telemetry/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      queryId: `opencode-smoke-${shortHash(input.runId)}`,
      timeframe: { from: input.from, to },
      view: "events",
      limit: MAX_TELEMETRY_EVENTS,
      dry: true,
      parameters: {
        filterCombination: "and",
        needle: { value: input.runId, matchCase: true },
        ...(input.workerName ? { filters: [{ key: WORKER_NAME_FIELD, operation: "eq", type: "string", value: input.workerName }] } : {}),
      },
    }),
  }, timeoutMs, "telemetry")
  if (!response.response.ok) throw new Error(`Workers Observability query returned HTTP ${response.response.status}`)
  let value: unknown
  try {
    value = JSON.parse(response.text)
  } catch {
    throw new Error("Workers Observability query returned invalid JSON")
  }
  const page = parseTelemetryEvents(value, MAX_TELEMETRY_EVENTS, input.secrets)
  return { count: page.count, events: page.events, truncated: page.truncated }
}

async function collectTelemetry(
  accountId: string | undefined,
  apiToken: string | undefined,
  workerName: string | undefined,
  runId: string,
  startedAt: string,
  fetcher: typeof fetch,
  secrets: () => readonly string[],
  safeError: (error: unknown) => Json,
  timeoutMs?: number,
  pollMs?: number,
): Promise<Json> {
  if (!accountId || !apiToken) return { status: "unavailable", reason: "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required" }
  try {
    const totalMs = timeoutMs ?? DEFAULT_TELEMETRY_TIMEOUT_MS
    const poll = pollMs ?? TELEMETRY_POLL_INTERVAL_MS
    if (!Number.isSafeInteger(totalMs) || totalMs < 1 || !Number.isSafeInteger(poll) || poll < 1) throw new Error("telemetry polling timeout is invalid")
    const deadline = Date.now() + totalMs
    let query: TelemetryQueryResult | undefined
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      query = await queryTelemetry({ accountId, apiToken, workerName, runId, from: Date.parse(startedAt), to: () => Date.now(), fetcher, timeoutMs: Math.max(1, Math.min(DEFAULT_REQUEST_TIMEOUT_MS, remaining)), secrets: secrets() })
      if (query.events.length > 0) break
      const waitMs = Math.min(poll, Math.max(0, deadline - Date.now()))
      if (waitMs === 0) break
      await delay(waitMs)
    }
    if (!query) throw new Error("Workers Logs query deadline elapsed before a response")
    return { status: query.events.length > 0 ? "correlated" : "incomplete", runId, workerName: workerName ?? null, count: query.count ?? null, events: query.events, truncated: query.truncated }
  } catch (error) {
    return { status: "unavailable", runId, reason: "Workers Logs query failed", error: safeError(error) }
  }
}

export function publicHealthDetails(status: number, text: string, responseOk: boolean, cfRay: string | null, secrets: readonly string[]): Json {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Cloudflare error pages are often HTML rather than JSON.
  }
  const body = isRecord(value) ? value : {}
  const visibleBody = visibleHealthText(text)
  const subcode = cloudflareSubcode(text) ?? cloudflareSubcode(visibleBody)
  return {
    ok: responseOk && body.healthy === true,
    status,
    healthy: typeof body.healthy === "boolean" ? body.healthy : null,
    body: trimHealthEvidence(redactText(visibleBody, secrets)),
    subcode: subcode ?? null,
    cfRay: cfRay ? trimHealthEvidence(redactText(cfRay, secrets)) : null,
  }
}

function cloudflareSubcode(text: string): number | undefined {
  for (const pattern of [
    /\b(?:cloudflare\s+)?error\s+(1\d{3})\b/i,
    /\b(?:cf[-\s]?|subcode\s*[:=]\s*|code\s*[:=]\s*)(1\d{3})\b/i,
  ]) {
    const value = text.match(pattern)?.[1]
    if (value) return Number(value)
  }
  return undefined
}

function visibleHealthText(text: string): string {
  const withoutEmbeddedContent = text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
  return withoutEmbeddedContent
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|#160|#xA0);/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function trimHealthEvidence(value: string): string {
  const bytes = Buffer.from(value)
  return bytes.byteLength <= MAX_HEALTH_EVIDENCE_BYTES
    ? value
    : new TextDecoder().decode(bytes.subarray(0, MAX_HEALTH_EVIDENCE_BYTES))
}

function connectorReadyConnections(value: Json): number | undefined {
  const direct = numberField(value, "readyConnections")
  if (direct !== undefined) return direct
  if (!Array.isArray(value.endpoints)) return undefined
  const counts = value.endpoints.flatMap((endpoint) => {
    if (!isRecord(endpoint)) return []
    const readyBody = isRecord(endpoint.ready) && isRecord(endpoint.ready.body) ? numberField(endpoint.ready.body, "readyConnections") : undefined
    const metrics = isRecord(endpoint.metrics) && isRecord(endpoint.metrics.metrics) ? endpoint.metrics.metrics : {}
    const metricCounts = Object.entries(metrics).flatMap(([name, metric]) => {
      if (!/connection/i.test(name)) return []
      const values = Array.isArray(metric) ? metric : [metric]
      return values.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
    })
    return readyBody === undefined ? metricCounts : [readyBody, ...metricCounts]
  })
  return counts.length > 0 ? Math.max(...counts) : undefined
}

function safeTunnelHostname(value: string | URL): string {
  let hostname: string
  try {
    hostname = new URL(value).hostname
  } catch {
    throw new SandboxError("tunnel", "Cloudflare provider returned an invalid tunnel URL", "TUNNEL_URL")
  }
  if (!hostname || !/^[A-Za-z0-9.-]{1,253}$/.test(hostname)) throw new SandboxError("tunnel", "Cloudflare provider returned an unsafe tunnel hostname", "TUNNEL_HOSTNAME")
  return hostname
}

function connectorMetricEvidence(value: Json): Json {
  return {
    config_version: connectorMetricValue(value, "config_version"),
    ha_connections: connectorMetricValue(value, "ha_connections"),
  }
}

function connectorMetricValue(value: Json, suffix: string): number | number[] | null {
  const direct = metricNumbers(value[suffix])
  if (direct.length > 0) return direct.length === 1 ? direct[0]! : direct
  if (!Array.isArray(value.endpoints)) return null
  const values = value.endpoints.flatMap((endpoint) => {
    if (!isRecord(endpoint) || !isRecord(endpoint.metrics) || !isRecord(endpoint.metrics.metrics)) return []
    return Object.entries(endpoint.metrics.metrics).flatMap(([name, metric]) => name === suffix || name.endsWith(`_${suffix}`) ? metricNumbers(metric) : [])
  })
  return values.length === 0 ? null : values.length === 1 ? values[0]! : values
}

function metricNumbers(value: unknown): number[] {
  const values = Array.isArray(value) ? value : [value]
  return values.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
}

function numberField(value: Json | undefined, key: string): number | undefined {
  const field = value?.[key]
  return typeof field === "number" && Number.isFinite(field) ? field : undefined
}

async function request(fetcher: typeof fetch, input: RequestInfo | URL, init: RequestInit, timeoutMs: number, stage: string): Promise<{ response: Response; text: string }> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error(`${stage} timeout is invalid`)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await waitForAbort(() => fetcher(input, { ...init, signal: controller.signal }), controller.signal, (late) => late.body?.cancel())
    return { response, text: await readLimitedBody(response, controller.signal, stage) }
  } catch (error) {
    if (controller.signal.aborted) throw new SandboxError(stage, `${stage} request timed out`, "SMOKE_TIMEOUT")
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function probeLoopback(client: CloudflareSandboxClient, sandboxId: string, port: number, headers: HeadersInit | undefined, secrets: readonly string[]): Promise<Json> {
  const authorization = new Headers(headers).get("authorization")
  if (!authorization) return { available: false, reason: "loopback authentication header is unavailable" }
  try {
    const result = await client.exec(sandboxId, {
      argv: ["bun", "-e", LOOPBACK_HEALTH_SCRIPT],
      stdin: JSON.stringify({ port, authorization }),
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
    })
    let value: unknown
    try {
      value = JSON.parse(result.stdout)
    } catch {
      return { available: false, commandFailed: true, exitCode: result.exitCode, error: redactText(result.stderr || "loopback health command returned invalid JSON", secrets) }
    }
    if (!isRecord(value) || typeof value.status !== "number" || typeof value.body !== "string") {
      return { available: false, commandFailed: true, exitCode: result.exitCode, error: "loopback health command returned an invalid result" }
    }
    return { available: true, exitCode: result.exitCode, ...healthDetails(value.status, value.body, result.exitCode === 0) }
  } catch (error) {
    return { available: false, commandFailed: true, error: redactError(error, secrets) }
  }
}

function healthDetails(status: number, text: string, responseOk: boolean): Json {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    value = undefined
  }
  const body = isRecord(value) ? value : {}
  return { ok: responseOk && body.healthy === true, status, healthy: typeof body.healthy === "boolean" ? body.healthy : null, ...(typeof body.version === "string" ? { version: body.version } : {}), authenticated: true }
}

async function readServerLog(client: CloudflareSandboxClient, sandboxId: string, workspaceId: string, secrets: readonly string[]): Promise<Json> {
  const path = `/workspace/.opencode-sandbox/${shortHash(workspaceId)}/server.log`
  const result = await client.exec(sandboxId, {
    argv: ["sh", "-lc", `set -eu; file='${path}'; if [ ! -f "$file" ]; then printf 'ABSENT\\n'; elif [ "$(wc -c <"$file")" -gt ${MAX_LOG_BYTES} ]; then printf 'META:%s:1\\n' "$(wc -c <"$file")"; tail -c ${MAX_LOG_BYTES} "$file"; else printf 'META:%s:0\\n' "$(wc -c <"$file")"; cat "$file"; fi`],
    timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
  })
  if (result.exitCode !== 0 || result.signal !== null) return { available: false, commandFailed: true, exitCode: result.exitCode, error: redactText(result.stderr || result.stdout || "server log command failed", secrets) }
  const newline = result.stdout.indexOf("\n")
  const header = (newline < 0 ? result.stdout : result.stdout.slice(0, newline)).trim()
  if (header === "ABSENT") return { available: false, bytes: 0, truncated: false }
  const match = /^META:([0-9]+):(0|1)$/.exec(header)
  if (!match) throw new Error("OpenCode server log metadata is invalid")
  const bytes = Number(match[1])
  if (!Number.isSafeInteger(bytes)) throw new Error("OpenCode server log size is invalid")
  return { available: true, bytes, truncated: match[2] === "1", text: trim(redactText(newline < 0 ? "" : result.stdout.slice(newline + 1), secrets)) }
}

function objectAt(value: unknown, path: string): Json {
  if (!isRecord(value)) throw new Error(`Workers Observability response is missing ${path}`)
  return value
}

function basicAuthSecrets(headers: HeadersInit | undefined): string[] {
  const authorization = new Headers(headers).get("authorization")
  if (!authorization) return []
  const encoded = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(authorization)?.[1]
  if (!encoded) return [authorization]
  const decoded = Buffer.from(encoded, "base64").toString("utf8")
  const separator = decoded.indexOf(":")
  return separator < 0 ? [authorization] : [authorization, decoded.slice(separator + 1)]
}

function trim(value: string): string {
  const bytes = Buffer.from(value)
  return bytes.byteLength <= MAX_LOG_BYTES ? value : new TextDecoder().decode(bytes.subarray(0, MAX_LOG_BYTES))
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`)
  return value
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`invalid positive integer: ${value}`)
  return parsed
}

const HELP = `Usage: bun home/.config/opencode/sandbox/cloudflare-startup-smoke.ts

Checks the Cloudflare bridge, one sandbox, authenticated loopback and public OpenCode health,
then collects bounded server logs and optional Workers Logs before one provider-owned cleanup.
It does not create an OpenCode session or call an LLM. Set SANDBOX_SMOKE_OUTPUT for a 0600 JSON copy.`

export type MainOptions = { env?: Record<string, string | undefined>; stdout?: (text: string) => void; stderr?: (text: string) => void }

export async function main(argv = process.argv.slice(2), options: MainOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text))
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text))
  if (argv.length > 0) {
    if (argv.length === 1 && argv[0] === "--help") {
      stdout(`${HELP}\n`)
      return 0
    }
    stderr(`unknown argument: ${argv[0]}\n`)
    return 1
  }
  const env = options.env ?? process.env
  let result: SmokeResult
  try {
    result = await runSmoke({ env })
  } catch (error) {
    result = failedResult(error)
  }
  const secrets = [env.SANDBOX_API_KEY ?? "", env.CLOUDFLARE_API_TOKEN ?? "", env.OPENCODE_AUTH_CONTENT ?? ""]
  const output = `${JSON.stringify(sanitizeSmokeOutput(result, secrets), null, 2)}\n`
  stdout(output)
  if (env.SANDBOX_SMOKE_OUTPUT) {
    try {
      await writeFile(env.SANDBOX_SMOKE_OUTPUT, output, { mode: 0o600 })
      await chmod(env.SANDBOX_SMOKE_OUTPUT, 0o600)
    } catch (error) {
      stderr(`could not write smoke output: ${redactError(error, secrets)}\n`)
      return 1
    }
  }
  return result.outcome === "pass" ? 0 : 1
}

function failedResult(error: unknown): SmokeResult {
  const startedAt = new Date().toISOString()
  return { schemaVersion: 1, runId: randomUUID(), outcome: "fail", attempt: { startedAt, endedAt: new Date().toISOString() }, stages: [], resources: {}, evidence: { loopback: { available: false }, serverLog: { available: false }, connector: { status: "missingprocess", reason: "smoke attempt did not start", tokenIdentity: { status: "unavailable" }, startedAt, endedAt: new Date().toISOString() } }, cleanup: { attempted: false, ownership: "unknown", remoteAbsence: "unverified", ok: false }, failure: { error: { message: redactError(error) } } }
}

export function sanitizeSmokeOutput(value: unknown, secrets: readonly string[] = [], key?: string): unknown {
  if (key && isCredentialKey(key)) return "[REDACTED]"
  if (typeof value === "string") return redactText(value, secrets)
  if (Array.isArray(value)) return value.map((item) => sanitizeSmokeOutput(item, secrets))
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitizeSmokeOutput(item, secrets, name)]))
  return value
}

function isCredentialKey(value: string): boolean {
  const key = value.replace(/[_-]/g, "").toLowerCase()
  return key === "auth" || key === "sshkey" || key.endsWith("authorization") || key.endsWith("authcontent") || key === "cookie" || key === "setcookie" || key.endsWith("password") || key.endsWith("token") || key.endsWith("secret") || key.endsWith("credential") || key.endsWith("apikey") || key.endsWith("privatekey")
}

if (import.meta.main) process.exitCode = await main()
