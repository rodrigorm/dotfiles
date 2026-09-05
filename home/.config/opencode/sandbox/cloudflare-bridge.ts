import { isRecord, SandboxError, type ProcessResult, type SandboxStage } from "./types"
import { redactText } from "./redaction"

const MAX_RESPONSE_BYTES = 512 * 1024
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_HYDRATE_BYTES = 32 * 1024 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000

export interface CloudflareExecInput {
  argv: string[]
  cwd?: string
  timeoutMs?: number
  stdin?: string
  onLine?: (line: string) => void
}

export interface CloudflareTunnelInfo {
  id: string
  port: number
  url: string
}

export interface CloudflareSandboxClient {
  createSandbox(): Promise<string>
  destroySandbox(sandboxId: string): Promise<void>
  destroyTunnel(sandboxId: string, port: number): Promise<void>
  running(sandboxId: string): Promise<boolean>
  exec(sandboxId: string, input: CloudflareExecInput): Promise<ProcessResult>
  putFile(sandboxId: string, path: string, content: Uint8Array): Promise<void>
  getFile(sandboxId: string, path: string): Promise<Uint8Array>
  hydrate(sandboxId: string, content: Uint8Array): Promise<void>
  tunnel(sandboxId: string, port: number, name: string): Promise<CloudflareTunnelInfo>
}

export interface CloudflareBridgeClientOptions {
  apiUrl: string | URL
  apiKey: string
  fetcher?: typeof fetch
  requestTimeoutMs?: number
}

export class CloudflareBridgeClient implements CloudflareSandboxClient {
  private readonly apiUrl: URL
  private readonly apiKey: string
  private readonly fetcher: typeof fetch
  private readonly requestTimeoutMs: number

  constructor(options: CloudflareBridgeClientOptions) {
    this.apiUrl = new URL(options.apiUrl)
    if (this.apiUrl.protocol !== "http:" && this.apiUrl.protocol !== "https:") {
      throw new SandboxError("validate", "Cloudflare bridge URL must use HTTP or HTTPS", "CLOUDFLARE_URL")
    }
    if (this.apiUrl.protocol === "http:" && !isLoopback(this.apiUrl.hostname)) {
      throw new SandboxError("validate", "Cloudflare bridge URL must use HTTPS", "CLOUDFLARE_URL")
    }
    if (!options.apiKey) throw new SandboxError("validate", "Cloudflare bridge API key is empty", "CLOUDFLARE_KEY")
    this.apiKey = options.apiKey
    this.fetcher = options.fetcher ?? fetch
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  async createSandbox(): Promise<string> {
    const response = await this.request("/v1/sandbox", { method: "POST" }, "provision")
    const value = parseJson(response.body, "sandbox creation")
    if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
      throw new SandboxError("provision", "Cloudflare bridge returned an invalid sandbox ID", "CLOUDFLARE_SCHEMA")
    }
    assertSandboxId(value.id)
    return value.id
  }

  async destroySandbox(sandboxId: string): Promise<void> {
    assertSandboxId(sandboxId)
    await this.request(`/v1/sandbox/${encodeURIComponent(sandboxId)}`, { method: "DELETE" }, "remove")
  }

  async destroyTunnel(sandboxId: string, port: number): Promise<void> {
    assertSandboxId(sandboxId)
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
      throw new SandboxError("tunnel", "Cloudflare tunnel port is invalid", "CLOUDFLARE_PORT")
    }
    await this.request(
      `/v1/sandbox/${encodeURIComponent(sandboxId)}/tunnel/${port}`,
      { method: "DELETE" },
      "tunnel",
    )
  }

  async running(sandboxId: string): Promise<boolean> {
    assertSandboxId(sandboxId)
    const response = await this.request(
      `/v1/sandbox/${encodeURIComponent(sandboxId)}/running`,
      { method: "GET" },
      "discover",
    )
    const value = parseJson(response.body, "sandbox status")
    if (!isRecord(value) || typeof value.running !== "boolean") {
      throw new SandboxError("discover", "Cloudflare bridge returned an invalid running status", "CLOUDFLARE_SCHEMA")
    }
    return value.running
  }

  async exec(sandboxId: string, input: CloudflareExecInput): Promise<ProcessResult> {
    assertSandboxId(sandboxId)
    if (input.argv.length === 0 || input.argv.some((value) => typeof value !== "string")) {
      throw new SandboxError("validate", "Cloudflare command argv is empty", "CLOUDFLARE_ARGV")
    }
    const body: Record<string, unknown> = { argv: input.argv }
    if (input.cwd !== undefined) body.cwd = input.cwd
    if (input.timeoutMs !== undefined) body.timeout_ms = input.timeoutMs
    if (input.stdin !== undefined) body.stdin = input.stdin
    const pending = await this.openResponse(
      `/v1/sandbox/${encodeURIComponent(sandboxId)}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      "control_channel",
    )
    try {
      if (!pending.response.ok) {
        const body = await readLimitedBody(pending.response, MAX_RESPONSE_BYTES, "control_channel")
        throw new SandboxError(
          "control_channel",
          redactText(new TextDecoder().decode(body)) || `Cloudflare bridge returned HTTP ${pending.response.status}`,
          `CLOUDFLARE_HTTP_${pending.response.status}`,
        )
      }
      if (pending.response.headers.get("content-type")?.includes("text/event-stream")) {
        return await parseSseStream(pending.response, input.onLine)
      }
      const responseBody = await readLimitedBody(pending.response, MAX_RESPONSE_BYTES, "control_channel")
      return parseExecResponse(responseBody, pending.response.headers.get("content-type") ?? "", input.onLine)
    } finally {
      pending.close()
    }
  }

  async putFile(sandboxId: string, path: string, content: Uint8Array): Promise<void> {
    assertSandboxId(sandboxId)
    assertWorkspacePath(path)
    await this.request(
      `/v1/sandbox/${encodeURIComponent(sandboxId)}/file/${path.split("/").filter((part) => part.length > 0).map((part) => encodeURIComponent(part)).join("/")}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: Buffer.from(content),
      },
      "sync",
    )
  }

  async getFile(sandboxId: string, path: string): Promise<Uint8Array> {
    assertSandboxId(sandboxId)
    assertWorkspacePath(path)
    const response = await this.request(
      `/v1/sandbox/${encodeURIComponent(sandboxId)}/file/${path.split("/").filter((part) => part.length > 0).map((part) => encodeURIComponent(part)).join("/")}`,
      { method: "GET" },
      "sync",
      MAX_FILE_BYTES,
    )
    return response.body
  }

  async hydrate(sandboxId: string, content: Uint8Array): Promise<void> {
    assertSandboxId(sandboxId)
    if (content.byteLength > MAX_HYDRATE_BYTES) {
      throw new SandboxError(
        "checkout",
        "Cloudflare bridge hydrate payload exceeds its 32 MiB limit",
        "CLOUDFLARE_ARCHIVE_LIMIT",
      )
    }
    await this.request(
      `/v1/sandbox/${encodeURIComponent(sandboxId)}/hydrate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: Buffer.from(content),
      },
      "checkout",
    )
  }

  async tunnel(sandboxId: string, port: number, name: string): Promise<CloudflareTunnelInfo> {
    assertSandboxId(sandboxId)
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
      throw new SandboxError("tunnel", "Cloudflare tunnel port is invalid", "CLOUDFLARE_PORT")
    }
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
      throw new SandboxError("tunnel", "Cloudflare tunnel name is invalid", "CLOUDFLARE_TUNNEL_NAME")
    }
    const response = await this.request(
      `/v1/sandbox/${encodeURIComponent(sandboxId)}/tunnel/${port}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      },
      "tunnel",
    )
    const value = parseJson(response.body, "tunnel creation")
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      value.id.length === 0 ||
      value.port !== port ||
      typeof value.url !== "string"
    ) {
      throw new SandboxError("tunnel", "Cloudflare bridge returned an invalid tunnel", "CLOUDFLARE_SCHEMA")
    }
    let url: URL
    try {
      url = new URL(value.url)
    } catch {
      throw new SandboxError("tunnel", "Cloudflare bridge returned an invalid tunnel URL", "CLOUDFLARE_SCHEMA")
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
      throw new SandboxError("tunnel", "Cloudflare bridge returned an invalid tunnel URL", "CLOUDFLARE_SCHEMA")
    }
    return {
      id: value.id,
      port: value.port,
      url: url.toString().replace(/\/$/, ""),
    }
  }

  private async request(
    path: string,
    options: {
      method: "GET" | "POST" | "PUT" | "DELETE"
      headers?: Record<string, string>
      body?: BodyInit
    },
    stage: SandboxStage,
    maxBytes = MAX_RESPONSE_BYTES,
  ): Promise<{ body: Uint8Array; contentType: string }> {
    const pending = await this.openResponse(path, options, stage)
    try {
      const body = await readLimitedBody(pending.response, maxBytes, stage)
      if (!pending.response.ok) {
        const message = redactText(new TextDecoder().decode(body))
        throw new SandboxError(stage, message || `Cloudflare bridge returned HTTP ${pending.response.status}`, `CLOUDFLARE_HTTP_${pending.response.status}`)
      }
      return { body, contentType: pending.response.headers.get("content-type") ?? "" }
    } finally {
      pending.close()
    }
  }

  private async openResponse(
    path: string,
    options: {
      method: "GET" | "POST" | "PUT" | "DELETE"
      headers?: Record<string, string>
      body?: BodyInit
    },
    stage: SandboxStage,
  ): Promise<{ response: Response; close(): void }> {
    const url = new URL(this.apiUrl)
    const basePath = url.pathname.replace(/\/$/, "").replace(/\/v1$/, "")
    url.pathname = `${basePath}${path}`
    url.search = ""
    url.hash = ""

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    try {
      const response = await this.fetcher(url, {
        method: options.method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...options.headers,
        },
        body: options.body,
        signal: controller.signal,
      })
      return {
        response,
        close: () => clearTimeout(timeout),
      }
    } catch (error) {
      clearTimeout(timeout)
      throw new SandboxError(stage, `Cloudflare bridge request failed: ${redactText(error instanceof Error ? error.message : String(error))}`, "CLOUDFLARE_REQUEST")
    }
  }
}

export function assertSandboxId(value: string): void {
  if (!/^[a-z2-7]{1,128}$/.test(value)) {
    throw new SandboxError("validate", "Cloudflare sandbox ID is unsafe", "CLOUDFLARE_SANDBOX_ID")
  }
}

function parseExecResponse(body: Uint8Array, contentType: string, onLine?: (line: string) => void): ProcessResult {
  const text = new TextDecoder().decode(body)
  if (contentType.includes("text/event-stream") || text.includes("event:")) return parseSse(text, onLine)
  const value = parseJson(body, "command execution")
  if (!isRecord(value)) throw new SandboxError("control_channel", "Cloudflare command response is invalid", "CLOUDFLARE_SCHEMA")
  const exitCode = "exit_code" in value ? value.exit_code : value.exitCode
  if (exitCode !== null && typeof exitCode !== "number") {
    throw new SandboxError("control_channel", "Cloudflare command response has an invalid exit code", "CLOUDFLARE_SCHEMA")
  }
  const stdout = decodeOutput(value.stdout)
  if (onLine) emitLines(stdout, onLine)
  return {
    exitCode,
    signal: null,
    stdout,
    stderr: decodeOutput(value.stderr),
  }
}

function parseSse(text: string, onLine?: (line: string) => void): ProcessResult {
  let event = ""
  let data: string[] = []
  let stdout = ""
  let stderr = ""
  let pendingLine = ""
  let exitCode: number | null | undefined

  const consume = () => {
    if (!event) {
      data = []
      return
    }
    const value = data.join("\n")
    if (event === "stdout") {
      const chunk = decodeOutput(value)
      stdout += chunk
      if (onLine) pendingLine = emitLines(chunk, onLine, pendingLine)
    } else if (event === "stderr") stderr += decodeOutput(value)
    else if (event === "exit") {
      let parsed: unknown
      try {
        parsed = JSON.parse(value)
      } catch {
        throw new SandboxError("control_channel", "Cloudflare exit event is invalid JSON", "CLOUDFLARE_SCHEMA")
      }
      if (!isRecord(parsed) || (parsed.exit_code !== null && typeof parsed.exit_code !== "number")) {
        throw new SandboxError("control_channel", "Cloudflare exit event has an invalid exit code", "CLOUDFLARE_SCHEMA")
      }
      exitCode = parsed.exit_code
    } else if (event === "error") {
      let parsed: unknown
      try {
        parsed = JSON.parse(value)
      } catch {
        throw new SandboxError("control_channel", redactText(value), "CLOUDFLARE_COMMAND")
      }
      const message = isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : value
      const code = isRecord(parsed) && typeof parsed.code === "string" ? parsed.code : "CLOUDFLARE_COMMAND"
      throw new SandboxError("control_channel", redactText(message), code)
    }
    event = ""
    data = []
  }

  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      consume()
    } else if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim()
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart())
    }
  }
  consume()

  if (exitCode === undefined) {
    throw new SandboxError("control_channel", "Cloudflare command stream ended without an exit event", "CLOUDFLARE_STREAM")
  }
  if (onLine && pendingLine) onLine(pendingLine.endsWith("\r") ? pendingLine.slice(0, -1) : pendingLine)
  return { exitCode, signal: null, stdout, stderr }
}

async function parseSseStream(response: Response, onLine?: (line: string) => void): Promise<ProcessResult> {
  if (!response.body) throw new SandboxError("control_channel", "Cloudflare command stream has no body", "CLOUDFLARE_STREAM")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let event = ""
  let data: string[] = []
  let stdout = ""
  let stderr = ""
  let pendingLine = ""
  let exitCode: number | null | undefined
  let outputBytes = 0
  let eventDataBytes = 0

  const consume = () => {
    if (!event) {
      data = []
      eventDataBytes = 0
      return
    }
    const value = data.join("\n")
    if (event === "stdout") {
      const chunk = decodeOutput(value)
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > MAX_RESPONSE_BYTES) throw new SandboxError("control_channel", "Cloudflare command output is too large", "CLOUDFLARE_RESPONSE_LIMIT")
      stdout += chunk
      if (onLine) pendingLine = emitLines(chunk, onLine, pendingLine)
    } else if (event === "stderr") {
      const chunk = decodeOutput(value)
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > MAX_RESPONSE_BYTES) throw new SandboxError("control_channel", "Cloudflare command output is too large", "CLOUDFLARE_RESPONSE_LIMIT")
      stderr += chunk
    } else if (event === "exit") {
      let parsed: unknown
      try {
        parsed = JSON.parse(value)
      } catch {
        throw new SandboxError("control_channel", "Cloudflare exit event is invalid JSON", "CLOUDFLARE_SCHEMA")
      }
      if (!isRecord(parsed) || (parsed.exit_code !== null && typeof parsed.exit_code !== "number")) {
        throw new SandboxError("control_channel", "Cloudflare exit event has an invalid exit code", "CLOUDFLARE_SCHEMA")
      }
      exitCode = parsed.exit_code
    } else if (event === "error") {
      let parsed: unknown
      try {
        parsed = JSON.parse(value)
      } catch {
        throw new SandboxError("control_channel", redactText(value), "CLOUDFLARE_COMMAND")
      }
      const message = isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : value
      const code = isRecord(parsed) && typeof parsed.code === "string" ? parsed.code : "CLOUDFLARE_COMMAND"
      throw new SandboxError("control_channel", redactText(message), code)
    }
    event = ""
    data = []
    eventDataBytes = 0
  }

  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const chunk = decoder.decode(next.value, { stream: true })
      if (Buffer.byteLength(buffer) + Buffer.byteLength(chunk) > MAX_RESPONSE_BYTES) {
        throw new SandboxError("control_channel", "Cloudflare command output is too large", "CLOUDFLARE_RESPONSE_LIMIT")
      }
      buffer += chunk
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "")
        buffer = buffer.slice(newline + 1)
        if (line === "") consume()
        else if (line.startsWith("event:")) event = line.slice("event:".length).trim()
        else if (line.startsWith("data:")) {
          const value = line.slice("data:".length).trimStart()
          eventDataBytes += Buffer.byteLength(value)
          if (eventDataBytes > MAX_RESPONSE_BYTES) {
            throw new SandboxError("control_channel", "Cloudflare command output is too large", "CLOUDFLARE_RESPONSE_LIMIT")
          }
          data.push(value)
        }
        newline = buffer.indexOf("\n")
      }
    }
    const remainder = decoder.decode()
    if (Buffer.byteLength(buffer) + Buffer.byteLength(remainder) > MAX_RESPONSE_BYTES) {
      throw new SandboxError("control_channel", "Cloudflare command output is too large", "CLOUDFLARE_RESPONSE_LIMIT")
    }
    buffer += remainder
    if (buffer) {
      if (buffer.startsWith("event:")) event = buffer.slice("event:".length).trim()
      else if (buffer.startsWith("data:")) {
        const value = buffer.slice("data:".length).trimStart()
        eventDataBytes += Buffer.byteLength(value)
        if (eventDataBytes > MAX_RESPONSE_BYTES) {
          throw new SandboxError("control_channel", "Cloudflare command output is too large", "CLOUDFLARE_RESPONSE_LIMIT")
        }
        data.push(value)
      }
    }
    consume()
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }

  if (exitCode === undefined) throw new SandboxError("control_channel", "Cloudflare command stream ended without an exit event", "CLOUDFLARE_STREAM")
  if (onLine && pendingLine) onLine(pendingLine.endsWith("\r") ? pendingLine.slice(0, -1) : pendingLine)
  return { exitCode, signal: null, stdout, stderr }
}

function emitLines(chunk: string, onLine: (line: string) => void, pending = ""): string {
  const lines = `${pending}${chunk}`.split("\n")
  const remainder = lines.pop() ?? ""
  for (const line of lines) onLine(line.endsWith("\r") ? line.slice(0, -1) : line)
  return remainder
}

function parseJson(body: Uint8Array, operation: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body))
  } catch {
    throw new SandboxError("control_channel", `Cloudflare ${operation} response is not valid JSON`, "CLOUDFLARE_JSON")
  }
}

function decodeOutput(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return ""
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new SandboxError("control_channel", "Cloudflare command output is not valid base64", "CLOUDFLARE_SCHEMA")
  }
  return Buffer.from(value, "base64").toString("utf8")
}

async function readLimitedBody(response: Response, maxBytes: number, stage: SandboxStage): Promise<Uint8Array> {
  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer())
    if (body.byteLength > maxBytes) throw new SandboxError(stage, "Cloudflare bridge response is too large", "CLOUDFLARE_RESPONSE_LIMIT")
    return body
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new SandboxError(stage, "Cloudflare bridge response is too large", "CLOUDFLARE_RESPONSE_LIMIT")
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Uint8Array.from(Buffer.concat(chunks, size))
}

function assertWorkspacePath(value: string): void {
  if (
    !value.startsWith("/workspace") ||
    (value.length > "/workspace".length && !value.startsWith("/workspace/")) ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.split("/").slice(1).some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new SandboxError("validate", "Cloudflare workspace path is unsafe", "CLOUDFLARE_PATH")
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"
}
