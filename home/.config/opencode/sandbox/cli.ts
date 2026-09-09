import { request as httpRequest } from "node:http"
import { readFile, rename, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { redactError } from "./redaction"
import {
  SandboxError,
  isSandboxOperation,
  isRecord,
  type PublicOperation,
  type SandboxOperation,
  type SandboxResultV2,
  type SandboxResponse,
} from "./types"

const RESPONSE_LIMIT_BYTES = 64 * 1024
const REQUEST_TIMEOUT_MS = 4_300_000

export function parseCliArgs(argv: readonly string[], remote: boolean): { operation: SandboxOperation; force: boolean } {
  if (argv.length === 0) throw new SandboxError("validate", "usage: sandboxctl <operation>", "CLI_USAGE")
  const [operation, ...rest] = argv
  if (!isSandboxOperation(operation)) throw new SandboxError("validate", `unsupported operation: ${operation}`, "CLI_OPERATION")

  if (operation === "delete" && rest.length === 1 && rest[0] === "--force") {
    if (remote) throw new SandboxError("validate", "remote capabilities cannot request delete --force", "CLI_FORCE")
    return { operation, force: true }
  }
  if (rest.length > 0) throw new SandboxError("validate", `unexpected argument for ${operation}`, "CLI_ARGUMENT")
  if (remote && operation === "start") {
    throw new SandboxError("validate", "start is only available from the host", "CLI_START")
  }
  if (remote && operation === "inventory") {
    throw new SandboxError("validate", "inventory is only available from the host", "CLI_INVENTORY")
  }
  if (remote && operation === "repair") {
    throw new SandboxError("validate", "repair is only available from the host", "CLI_REPAIR")
  }
  if (remote && operation === "recover") {
    throw new SandboxError("validate", "recover is only available from the host", "CLI_RECOVER")
  }
  return { operation, force: false }
}

export function requestControl(
  socketPath: string,
  token: string,
  body: Record<string, unknown>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ status: number; body: unknown }> {
  return requestControlHttp({ socketPath }, token, body, timeoutMs)
}

export function requestControlTcp(
  host: string,
  port: number,
  token: string,
  body: Record<string, unknown>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ status: number; body: unknown }> {
  if (host !== "127.0.0.1" && host !== "::1") throw new SandboxError("validate", "control host must be loopback", "CONTROL_HOST")
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new SandboxError("validate", "control port is invalid", "CONTROL_PORT")
  return requestControlHttp({ host, port }, token, body, timeoutMs)
}

function requestControlHttp(
  endpoint: { socketPath: string } | { host: string; port: number },
  token: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const fail = (error: unknown) => reject(error instanceof SandboxError ? error : new SandboxError("control_channel", redactError(error), "CONTROL_CHANNEL"))
    const request = httpRequest(
      {
        ...( "socketPath" in endpoint ? { socketPath: endpoint.socketPath } : endpoint),
        path: "/v1/operation",
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(JSON.stringify(body)),
        },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength
          if (size <= RESPONSE_LIMIT_BYTES) chunks.push(chunk)
          else request.destroy(new SandboxError("control_channel", "control response is too large", "RESPONSE_LIMIT"))
        })
        response.once("error", fail)
        response.once("end", () => {
          if (size > RESPONSE_LIMIT_BYTES) return
          const text = Buffer.concat(chunks).toString("utf8")
          try {
            resolve({ status: response.statusCode ?? 500, body: JSON.parse(text) })
          } catch {
            reject(new SandboxError("control_channel", "control response is not valid JSON", "RESPONSE_JSON"))
          }
        })
      },
    )
    request.once("error", fail)
    request.once("timeout", () => request.destroy(new SandboxError("control_channel", "control request timed out", "REQUEST_TIMEOUT")))
    request.end(JSON.stringify(body))
  })
}

export async function requestControlMailbox(
  mailboxPath: string,
  token: string,
  body: Record<string, unknown>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ status: number; body: unknown }> {
  assertMailboxPath(mailboxPath)
  if (!token) throw new SandboxError("validate", "control token is empty", "CONTROL_TOKEN")
  const id = randomUUID()
  const requestPath = join(mailboxPath, `${id}.request`)
  const pendingPath = join(mailboxPath, `${id}.requesting`)
  const responsePath = join(mailboxPath, `${id}.response`)
  await writeFile(pendingPath, JSON.stringify({ token, body }), { encoding: "utf8", flag: "wx", mode: 0o600 })
  await rename(pendingPath, requestPath)
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const response = await readFile(responsePath)
        if (response.byteLength > RESPONSE_LIMIT_BYTES) throw new SandboxError("control_channel", "control response is too large", "RESPONSE_LIMIT")
        try {
          const value = JSON.parse(response.toString("utf8"))
          if (!isRecord(value) || typeof value.status !== "number" || !("body" in value)) {
            throw new SandboxError("control_channel", "control response has invalid shape", "RESPONSE_SCHEMA")
          }
          return { status: value.status, body: value.body }
        } catch (error) {
          if (error instanceof SandboxError) throw error
          throw new SandboxError("control_channel", "control response is not valid JSON", "RESPONSE_JSON")
        }
      } catch (error) {
        if (!isMissingFile(error)) throw error
      }
      await delay(100)
    }
    throw new SandboxError("control_channel", "control request timed out", "REQUEST_TIMEOUT")
  } finally {
    await rm(requestPath, { force: true }).catch(() => undefined)
    await rm(pendingPath, { force: true }).catch(() => undefined)
    await rm(responsePath, { force: true }).catch(() => undefined)
  }
}

export async function runCli(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  output: { stdout?: (text: string) => void; stderr?: (text: string) => void } = {},
): Promise<number> {
  const writeStdout = output.stdout ?? ((text: string) => process.stdout.write(text))
  const writeStderr = output.stderr ?? ((text: string) => process.stderr.write(text))
  let parsed: { operation: SandboxOperation; force: boolean }
  try {
    parsed = parseCliArgs(argv, env.SANDBOX_CONTROL_ROLE === "remote")
  } catch (error) {
    const message = redactError(error)
    writeStderr(`sandboxctl: ${message}\n`)
    writeJson(writeStdout, validationError(argv, message, error), isSandboxOperation(argv[0]) ? argv[0] : "status")
    return 2
  }

  const operation = parsed.operation
  const socketPath = env.SANDBOX_CONTROL_SOCKET
  const mailboxPath = env.SANDBOX_CONTROL_MAILBOX
  const controlHost = env.SANDBOX_CONTROL_HOST
  const controlPort = env.SANDBOX_CONTROL_PORT === undefined ? undefined : Number(env.SANDBOX_CONTROL_PORT)
  const token = operation === "inventory" ? env.SANDBOX_CONTROL_PROJECT_TOKEN : env.SANDBOX_CONTROL_TOKEN
  const hasTcpEndpoint = controlHost !== undefined || env.SANDBOX_CONTROL_PORT !== undefined
  const requestId = randomUUID()
  if (!socketPath && !mailboxPath && !hasTcpEndpoint) {
    const response = errorResponse(operation, new SandboxError("control_channel", "sandboxctl is not running inside an OpenCode session", "CONTROL_ENDPOINT"), requestId)
    writeJson(writeStdout, response, operation, requestId)
    return 1
  }
  if (!token) {
    const response = errorResponse(operation, new SandboxError("authenticate", "sandbox control token is unavailable", "CONTROL_TOKEN"), requestId)
    writeJson(writeStdout, response, operation, requestId)
    return 1
  }

  try {
    const body = {
      operation,
      requestId,
      ...(parsed.force ? { force: true } : {}),
    }
    const response = socketPath
      ? await requestControl(socketPath, token, body)
      : mailboxPath
        ? await requestControlMailbox(mailboxPath, token, body)
        : await requestControlTcp(controlHost ?? "", controlPort ?? Number.NaN, token, body)
    if (!isV2Response(response.body) || response.body.requestId !== requestId) {
      throw new SandboxError("control_channel", "control response has invalid shape", "RESPONSE_SCHEMA")
    }
    const result = response.body as unknown as SandboxResponse
    writeJson(writeStdout, result, operation, requestId)
    return response.status >= 200 && response.status < 300 && result.ok ? 0 : 1
  } catch (error) {
    const result = errorResponse(operation, error, requestId)
    writeJson(writeStdout, result, operation, requestId)
    return 1
  }
}

function errorResponse(operation: SandboxOperation, error: unknown, requestId: string = randomUUID()): SandboxResponse {
  const sandboxError = error instanceof SandboxError ? error : undefined
  const stage = sandboxError?.stage ?? "control_channel"
  const code = sandboxError?.code ?? "CONTROL_CHANNEL"
  const message = redactError(error)
  return {
    ...emptyResult(operation, false, message, { code, stage, retryable: stage !== "validate" && code !== "CONTROL_AUTH" }, stage, requestId),
    ok: false,
    operation,
    state: "error",
    stage,
    message,
    diagnosticOperation: "diagnose",
  }
}

function validationError(argv: readonly string[], message: string, error: unknown): SandboxResultV2 & { state: "error"; stage: string } {
  const operation = isSandboxOperation(argv[0]) ? argv[0] : undefined
  return emptyResult(operation ?? "status", false, message, {
    code: error instanceof SandboxError ? error.code : "CLI_USAGE",
    stage: error instanceof SandboxError ? error.stage : "validate",
    retryable: false,
  }, error instanceof SandboxError ? error.stage : "validate")
}

function emptyResult(
  operation: PublicOperation,
  ok: boolean,
  message: string,
  error: { code: string; stage: string; retryable: boolean } | null,
  stage = error?.stage ?? "validate",
  requestId: string = randomUUID(),
): SandboxResultV2 & { state: "error"; stage: string } {
  const sources = ["record", "handle", "workspace", "provider", "git"] as const
  return {
    schemaVersion: 2,
    requestId,
    ok,
    operation,
    message: redactError(message),
    session: null,
    intent: { desiredLocation: "local", phase: "idle" },
    effectiveTarget: null,
     observations: sources.map((source) => ({
      source,
      observed: false,
      freshAt: new Date().toISOString(),
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
    stage,
  }
}

function writeJson(write: (text: string) => void, value: unknown, operation: SandboxOperation, requestId?: string): void {
  let text: string
  try {
    text = JSON.stringify(value)
  } catch {
    text = JSON.stringify(errorResponse(operation, new SandboxError("control_channel", "control response could not be serialized", "RESPONSE_JSON"), requestId))
  }
  if (Buffer.byteLength(text) > RESPONSE_LIMIT_BYTES) {
    text = JSON.stringify(errorResponse(operation, new SandboxError("control_channel", "control response is too large", "RESPONSE_LIMIT"), requestId))
  }
  write(`${text}\n`)
}

function isV2Response(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  return (
    value.schemaVersion === 2 &&
    typeof value.requestId === "string" &&
    typeof value.ok === "boolean" &&
    isPublicOperation(value.operation) &&
    typeof value.message === "string" &&
    isRecord(value.intent) &&
    Array.isArray(value.observations) &&
    (value.effectiveTarget === null || isRecord(value.effectiveTarget)) &&
    typeof value.classification === "string" &&
    isRecord(value.work) &&
    Array.isArray(value.allowedActions) &&
    (value.recommendedAction === null || isRecord(value.recommendedAction)) &&
    (value.error === null || isRecord(value.error))
  )
}

function isPublicOperation(value: unknown): value is PublicOperation {
  return typeof value === "string" && [
    "start",
    "stop",
    "status",
    "inspect",
    "inventory",
    "delete",
    "logs",
    "diagnose",
    "retry",
    "recover",
    "repair",
  ].includes(value)
}

function assertMailboxPath(value: string): void {
  if (!value.startsWith("/") || value.includes("\0") || value.includes("\n") || value.includes("\r") || value.split("/").slice(1).some((part) => part === "" || part === "." || part === "..")) {
    throw new SandboxError("validate", "control mailbox path is unsafe", "CONTROL_MAILBOX")
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

if (import.meta.main) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode
  })
}
