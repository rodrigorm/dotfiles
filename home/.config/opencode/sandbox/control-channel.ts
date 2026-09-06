import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { chmod, unlink } from "node:fs/promises"

import { preparePrivateSocket } from "./secure-fs"
import { redactError } from "./redaction"
import {
  SandboxError,
  isSandboxOperation,
  isRecord,
  type AuthorizedControlRequest,
  type CapabilityScope,
  type ControlCapability,
  type ControlRequest,
  type SandboxResponse,
} from "./types"

const DEFAULT_REQUEST_BYTES = 8 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_CAPABILITY_TTL_MS = 15 * 60 * 1000
const RESPONSE_LIMIT_BYTES = 64 * 1024

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
  scope?: CapabilityScope
  projectId?: string
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
  const scope = input.scope ?? "session"
  if (scope === "project" && input.role !== "host") {
    throw new SandboxError("validate", "project capabilities are host-only", "CAPABILITY_SCOPE")
  }
  if (scope === "project" && (!input.projectId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.projectId))) {
    throw new SandboxError("validate", "project capability ID is invalid", "CAPABILITY_PROJECT")
  }
  return {
    token: randomBytes(32).toString("base64url"),
    sessionId: input.sessionId,
    generation: input.generation,
    role: input.role,
    scope,
    ...(input.projectId ? { projectId: input.projectId } : {}),
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
    const send = (status: number, body: object, operation: ControlRequest["operation"] = "status") => {
      let text: string
      try {
        text = JSON.stringify(body)
      } catch {
        status = 500
        text = JSON.stringify(errorResponse(operation, "control_channel", "control response could not be serialized", "RESPONSE_JSON"))
      }
      if (Buffer.byteLength(text) > RESPONSE_LIMIT_BYTES) {
        status = 500
        text = JSON.stringify(errorResponse(operation, "control_channel", "control response is too large", "RESPONSE_LIMIT"))
      }
      response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) })
      response.end(text)
    }

    if (request.method !== "POST" || request.url !== "/v1/operation") {
      send(404, errorResponse("status", "validate", "control route not found", "CONTROL_ROUTE"))
      return
    }

    const capability = this.findCapability(request.headers.authorization)
    if (!capability) {
      send(401, errorResponse("status", "authenticate", "control capability is invalid or expired", "CONTROL_AUTH"))
      return
    }

    let body: unknown
    try {
      body = await readJson(request, this.maxRequestBytes)
    } catch (error) {
      const sandboxError = error instanceof SandboxError ? error : new SandboxError("validate", "invalid control request", "REQUEST_SCHEMA")
      send(sandboxError.code === "REQUEST_TOO_LARGE" ? 413 : 400, errorResponse("status", sandboxError.stage, sandboxError.message, sandboxError.code))
      return
    }

    let controlRequest: ControlRequest
    try {
      controlRequest = parseControlRequest(body, capability)
    } catch (error) {
      const sandboxError = error instanceof SandboxError ? error : new SandboxError("validate", "invalid control request", "REQUEST_SCHEMA")
      const operation = isRecord(body) && isSandboxOperation(body.operation) ? body.operation : "status"
      send(400, errorResponse(operation, sandboxError.stage, sandboxError.message, sandboxError.code), operation)
      return
    }

    try {
      const result = await this.handler({ ...controlRequest, capability })
      send(result.ok ? 200 : 409, normalizeResponse(result, controlRequest.operation), controlRequest.operation)
    } catch (error) {
      const sandboxError = error instanceof SandboxError ? error : new SandboxError("control_channel", redactError(error), "SANDBOX_ERROR")
      send(500, errorResponse(controlRequest.operation, sandboxError.stage, sandboxError.message, sandboxError.code), controlRequest.operation)
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
  const scope = capability.scope ?? "session"
  if (value.operation === "inventory" && (scope !== "project" || capability.role !== "host" || !capability.projectId)) {
    throw new SandboxError("validate", "inventory requires a host project capability", "REQUEST_INVENTORY")
  }
  if (scope === "project" && (capability.role !== "host" || !capability.projectId || value.operation !== "inventory")) {
    throw new SandboxError("validate", "project capabilities can only request inventory", "REQUEST_SCOPE")
  }
  if (force && (capability.role !== "host" || value.operation !== "delete")) {
    throw new SandboxError("validate", "force is not authorized for this capability", "REQUEST_FORCE")
  }
  if (value.operation === "start" && capability.role !== "host") {
    throw new SandboxError("validate", "start is only authorized from the host", "REQUEST_START")
  }
  if (value.operation === "repair" && capability.role !== "host") {
    throw new SandboxError("validate", "repair is only authorized from the host", "REQUEST_REPAIR")
  }
  if (value.operation === "recover" && capability.role !== "host") {
    throw new SandboxError("validate", "recover is only authorized from the host", "REQUEST_RECOVER")
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
    ...emptyResponse(request.operation, true, `${request.operation} accepted`, null),
    state: "local",
    sessionId: request.capability.sessionId,
  }
}

function errorResponse(
  operation: ControlRequest["operation"],
  stage: string,
  message: string,
  code: string,
): SandboxResponse {
  return {
    ...emptyResponse(operation, false, message, { code, stage, retryable: stage !== "validate" && code !== "CONTROL_AUTH" }),
    state: "error",
    stage,
  }
}

function emptyResponse(
  operation: ControlRequest["operation"],
  ok: boolean,
  message: string,
  error: SandboxResponse["error"],
): SandboxResponse {
  const freshAt = new Date().toISOString()
  return {
    schemaVersion: 2,
    requestId: randomUUID(),
    ok,
    operation,
    message: redactError(message),
    session: null,
    intent: { desiredLocation: "local", phase: "idle" },
    effectiveTarget: null,
    observations: ["record", "handle", "workspace", "provider", "git"].map((source) => ({
      source: source as "record" | "handle" | "workspace" | "provider" | "git",
      observed: false,
      freshAt,
      evidence: [],
    })),
    classification: "unknown",
    work: {
      captureBaseSha: null,
      runtimeHead: null,
      sync: "unknown",
      preservation: "not_needed",
      preservedWorktreePath: null,
    },
    allowedActions: [],
    recommendedAction: null,
    error,
    state: "error",
    stage: "validate",
  }
}

function normalizeResponse(value: SandboxResponse, operation: ControlRequest["operation"]): SandboxResponse {
  const message = typeof value.message === "string" ? value.message : `${operation} accepted`
  const normalized: SandboxResponse = {
    ...emptyResponse(operation, typeof value.ok === "boolean" ? value.ok : false, message, null),
    ...value,
    schemaVersion: 2,
    requestId: typeof value.requestId === "string" ? value.requestId : randomUUID(),
    operation: typeof value.operation === "string" ? value.operation : operation,
    ok: typeof value.ok === "boolean" ? value.ok : false,
    message: redactError(message),
  }
  if (!Array.isArray(normalized.observations)) normalized.observations = emptyResponse(operation, false, "", null).observations
  if (!normalized.intent || typeof normalized.intent !== "object") normalized.intent = { desiredLocation: "local", phase: "idle" }
  if (!Array.isArray(normalized.allowedActions)) normalized.allowedActions = []
  if (!normalized.work || typeof normalized.work !== "object") {
    normalized.work = {
      captureBaseSha: null,
      runtimeHead: null,
      sync: "unknown",
      preservation: "not_needed",
      preservedWorktreePath: null,
    }
  }
  if (normalized.error === undefined) normalized.error = null
  if (normalized.recommendedAction === undefined) normalized.recommendedAction = null
  return normalized
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
