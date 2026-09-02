import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { chmod, unlink } from "node:fs/promises"

import { preparePrivateSocket } from "./secure-fs"
import { redactError } from "./redaction"
import {
  SandboxError,
  isSandboxOperation,
  isRecord,
  type AuthorizedControlRequest,
  type ControlCapability,
  type ControlRequest,
  type SandboxResponse,
} from "./types"

const DEFAULT_REQUEST_BYTES = 8 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_CAPABILITY_TTL_MS = 15 * 60 * 1000

export interface ControlChannelOptions {
  socketPath: string
  handler?: (request: AuthorizedControlRequest) => Promise<SandboxResponse>
  maxRequestBytes?: number
  requestTimeoutMs?: number
  now?: () => number
}

export function createCapability(input: {
  sessionId: string
  generation: number
  role: "host" | "remote"
  now?: number
  ttlMs?: number
}): ControlCapability {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.sessionId)) {
    throw new SandboxError("validate", "capability session ID is invalid", "CAPABILITY_SESSION")
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new SandboxError("validate", "capability generation is invalid", "CAPABILITY_GENERATION")
  }
  const now = input.now ?? Date.now()
  const ttlMs = input.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new SandboxError("validate", "capability expiry is invalid", "CAPABILITY_EXPIRY")
  }
  return {
    token: randomBytes(32).toString("base64url"),
    sessionId: input.sessionId,
    generation: input.generation,
    role: input.role,
    expiresAt: now + ttlMs,
  }
}

export class ControlChannel {
  readonly socketPath: string
  private readonly handler: (request: AuthorizedControlRequest) => Promise<SandboxResponse>
  private readonly maxRequestBytes: number
  private readonly requestTimeoutMs: number
  private readonly now: () => number
  private readonly capabilities = new Map<string, ControlCapability>()
  private server: Server | undefined

  constructor(options: ControlChannelOptions) {
    this.socketPath = options.socketPath
    this.handler = options.handler ?? defaultHandler
    this.maxRequestBytes = options.maxRequestBytes ?? DEFAULT_REQUEST_BYTES
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.now = options.now ?? Date.now
  }

  register(capability: ControlCapability): void {
    this.capabilities.set(capability.token, capability)
  }

  revoke(token: string): void {
    this.capabilities.delete(token)
  }

  async start(): Promise<void> {
    if (this.server) return
    await preparePrivateSocket(this.socketPath)
    const server = createServer((request, response) => {
      void this.handle(request, response)
    })
    server.requestTimeout = this.requestTimeoutMs
    server.headersTimeout = this.requestTimeoutMs
    server.keepAliveTimeout = this.requestTimeoutMs
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
        server.listen(this.socketPath)
      })
      await chmod(this.socketPath, 0o600)
      this.server = server
    } catch (error) {
      await closeServer(server)
      await unlink(this.socketPath).catch(() => undefined)
      throw error
    }
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.capabilities.clear()
    if (!server) return
    await closeServer(server)
    await unlink(this.socketPath).catch(() => undefined)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (status: number, body: object) => {
      const text = JSON.stringify(body)
      response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) })
      response.end(text)
    }

    if (request.method !== "POST" || request.url !== "/v1/operation") {
      send(404, { ok: false, message: "control route not found" })
      return
    }

    const capability = this.findCapability(request.headers.authorization)
    if (!capability) {
      send(401, { ok: false, message: "control capability is invalid or expired" })
      return
    }

    let body: unknown
    try {
      body = await readJson(request, this.maxRequestBytes)
    } catch (error) {
      send(error instanceof SandboxError && error.code === "REQUEST_TOO_LARGE" ? 413 : 400, {
        ok: false,
        message: error instanceof Error ? error.message : "invalid control request",
      })
      return
    }

    let controlRequest: ControlRequest
    try {
      controlRequest = parseControlRequest(body, capability)
    } catch (error) {
      send(400, { ok: false, message: error instanceof Error ? error.message : "invalid control request" })
      return
    }

    try {
      const result = await this.handler({ ...controlRequest, capability })
      send(result.ok ? 200 : 409, result)
    } catch (error) {
      const message = redactError(error)
      send(500, { ok: false, operation: controlRequest.operation, state: "error", message })
    }
  }

  private findCapability(header: string | undefined): ControlCapability | undefined {
    if (!header?.startsWith("Bearer ")) return undefined
    const token = header.slice("Bearer ".length)
    const capability = [...this.capabilities.values()].find((candidate) => equalSecret(candidate.token, token))
    if (!capability || capability.expiresAt <= this.now()) {
      if (capability) this.capabilities.delete(capability.token)
      return undefined
    }
    return capability
  }
}

export function parseControlRequest(value: unknown, capability: ControlCapability): ControlRequest {
  if (!isRecord(value)) throw new SandboxError("validate", "control request must be an object", "REQUEST_SCHEMA")
  const keys = Object.keys(value).sort()
  const allowedKeys = value.force === undefined ? ["operation"] : ["force", "operation"]
  if (keys.length !== allowedKeys.length || !keys.every((key, index) => key === allowedKeys[index])) {
    throw new SandboxError("validate", "control request contains unsupported fields", "REQUEST_FIELDS")
  }
  if (!isSandboxOperation(value.operation)) throw new SandboxError("validate", "control operation is invalid", "REQUEST_OPERATION")
  if (value.force !== undefined && typeof value.force !== "boolean") {
    throw new SandboxError("validate", "control force flag is invalid", "REQUEST_FORCE")
  }
  const force = value.force ?? false
  if (force && (capability.role !== "host" || value.operation !== "delete")) {
    throw new SandboxError("validate", "force is not authorized for this capability", "REQUEST_FORCE")
  }
  if (value.operation === "start" && capability.role !== "host") {
    throw new SandboxError("validate", "start is only authorized from the host", "REQUEST_START")
  }
  return { operation: value.operation, force }
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(request.headers["content-length"] ?? 0)
  if (declaredLength > maxBytes) throw new SandboxError("validate", "control request is too large", "REQUEST_TOO_LARGE")
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > maxBytes) throw new SandboxError("validate", "control request is too large", "REQUEST_TOO_LARGE")
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  try {
    return JSON.parse(text)
  } catch {
    throw new SandboxError("validate", "control request is not valid JSON", "REQUEST_JSON")
  }
}

function equalSecret(expected: string, actual: string): boolean {
  const left = Buffer.from(expected)
  const right = Buffer.from(actual)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

async function defaultHandler(request: AuthorizedControlRequest): Promise<SandboxResponse> {
  return {
    ok: true,
    operation: request.operation,
    state: "local",
    sessionId: request.capability.sessionId,
    message: `${request.operation} accepted`,
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
