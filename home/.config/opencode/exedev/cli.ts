import { request as httpRequest } from "node:http"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"

import { redactError } from "./redaction"
import {
  ExedevError,
  isExedevOperation,
  type ExedevOperation,
  type ExedevResponse,
} from "./types"

const RESPONSE_LIMIT_BYTES = 64 * 1024
const REQUEST_TIMEOUT_MS = 10_000

export function parseCliArgs(argv: readonly string[], remote: boolean): { operation: ExedevOperation; force: boolean } {
  if (argv.length === 0) throw new ExedevError("validate", "usage: exedevctl <operation>", "CLI_USAGE")
  const [operation, ...rest] = argv
  if (!isExedevOperation(operation)) throw new ExedevError("validate", `unsupported operation: ${operation}`, "CLI_OPERATION")

  if (operation === "delete" && rest.length === 1 && rest[0] === "--force") {
    if (remote) throw new ExedevError("validate", "remote capabilities cannot request delete --force", "CLI_FORCE")
    return { operation, force: true }
  }
  if (rest.length > 0) throw new ExedevError("validate", `unexpected argument for ${operation}`, "CLI_ARGUMENT")
  if (remote && operation === "start") {
    throw new ExedevError("validate", "start is only available from the host", "CLI_START")
  }
  return { operation, force: false }
}

export interface ControlHttpResponse {
  status: number
  body: unknown
}

export function requestControl(
  socketPath: string,
  token: string,
  body: Record<string, unknown>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<ControlHttpResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
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
          else request.destroy(new ExedevError("control_channel", "control response is too large", "RESPONSE_LIMIT"))
        })
        response.once("error", reject)
        response.once("end", () => {
          if (size > RESPONSE_LIMIT_BYTES) return
          const text = Buffer.concat(chunks).toString("utf8")
          try {
            resolve({ status: response.statusCode ?? 500, body: JSON.parse(text) })
          } catch {
            reject(new ExedevError("control_channel", "control response is not valid JSON", "RESPONSE_JSON"))
          }
        })
      },
    )
    request.once("error", reject)
    request.once("timeout", () => request.destroy(new ExedevError("control_channel", "control request timed out", "REQUEST_TIMEOUT")))
    request.end(JSON.stringify(body))
  })
}

export async function runCli(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  output: { stdout?: (text: string) => void; stderr?: (text: string) => void } = {},
): Promise<number> {
  const writeStdout = output.stdout ?? ((text: string) => process.stdout.write(text))
  const writeStderr = output.stderr ?? ((text: string) => process.stderr.write(text))
  let parsed: { operation: ExedevOperation; force: boolean }
  try {
    parsed = parseCliArgs(argv, env.EXEDEV_CONTROL_ROLE === "remote")
  } catch (error) {
    const message = redactError(error)
    writeStderr(`exedevctl: ${message}\n`)
    writeStdout(`${JSON.stringify(validationError(argv, message))}\n`)
    return 2
  }

  const operation = parsed.operation
  const socketPath = env.EXEDEV_CONTROL_SOCKET
  const token = env.EXEDEV_CONTROL_TOKEN
  if (!socketPath || !token) {
    const response = errorResponse(operation, "control_channel", "exedevctl is not running inside an OpenCode session")
    writeStdout(`${JSON.stringify(response)}\n`)
    return 1
  }

  try {
    const response = await requestControl(socketPath, token, {
      operation,
      ...(parsed.force ? { force: true } : {}),
    })
    if (!isRecord(response.body)) throw new ExedevError("control_channel", "control response has invalid shape", "RESPONSE_SCHEMA")
    const result = response.body as unknown as ExedevResponse
    writeStdout(`${JSON.stringify(result)}\n`)
    return response.status >= 200 && response.status < 300 && result.ok ? 0 : 1
  } catch (error) {
    const result = errorResponse(operation, "control_channel", redactError(error))
    writeStdout(`${JSON.stringify(result)}\n`)
    return 1
  }
}

function errorResponse(operation: ExedevOperation, stage: string, message: string): ExedevResponse {
  return {
    ok: false,
    operation,
    state: "error",
    stage,
    message,
    diagnosticOperation: "diagnose",
  }
}

function validationError(argv: readonly string[], message: string): Record<string, unknown> {
  const operation = isExedevOperation(argv[0]) ? argv[0] : undefined
  return {
    ok: false,
    ...(operation ? { operation } : {}),
    state: "error",
    stage: "validate",
    message,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const currentFile = resolve(fileURLToPath(import.meta.url))
if (resolve(process.argv[1] ?? "") === currentFile) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode
  })
}
