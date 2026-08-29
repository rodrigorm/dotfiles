import { spawn } from "node:child_process"

import { ExedevError, type ProcessResult, type ProcessRunner, type RunProcessInput } from "./types"

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576
const TERMINATION_GRACE_MS = 3_000

export const nodeProcessRunner: ProcessRunner = {
  run: runProcess,
}

export function sanitizeEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  additional: Record<string, string | undefined> = {},
): Record<string, string> {
  const allowed = new Set([
    "HOME",
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "XDG_RUNTIME_DIR",
  ])
  const environment: Record<string, string> = {}

  for (const key of allowed) {
    const value = source[key]
    if (value !== undefined) environment[key] = value
  }
  for (const [key, value] of Object.entries(additional)) {
    if (value !== undefined) environment[key] = value
  }

  delete environment.SSH_AUTH_SOCK
  delete environment.OPENCODE_AUTH_CONTENT
  return environment
}

export async function runProcess(input: RunProcessInput): Promise<ProcessResult> {
  if (input.argv.length === 0 || input.argv.some((argument) => typeof argument !== "string")) {
    throw new ExedevError("validate", "process argv must contain at least one string", "ARGV_INVALID")
  }

  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new ExedevError("validate", "process output limit is invalid", "OUTPUT_LIMIT_INVALID")
  }

  const child = spawn(input.argv[0], input.argv.slice(1), {
    cwd: input.cwd,
    env: input.env ? toEnvironment(input.env) : undefined,
    shell: false,
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
  })

  let stdoutBytes = 0
  let stderrBytes = 0
  let stdoutOverflow = false
  let stderrOverflow = false
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength
    if (stdoutBytes <= maxOutputBytes) stdout.push(chunk)
    else stdoutOverflow = true
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength
    if (stderrBytes <= maxOutputBytes) stderr.push(chunk)
    else stderrOverflow = true
  })

  if (input.stdin === undefined) child.stdin?.end()
  else child.stdin?.end(typeof input.stdin === "string" ? input.stdin : Buffer.from(input.stdin))

  let terminationTimer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  let aborted = false

  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill("SIGTERM")
    terminationTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    }, TERMINATION_GRACE_MS)
  }

  const timeoutTimer = input.timeoutMs
    ? setTimeout(() => {
        timedOut = true
        terminate()
      }, input.timeoutMs)
    : undefined

  const abort = () => {
    aborted = true
    terminate()
  }
  input.signal?.addEventListener("abort", abort, { once: true })

  const result = await new Promise<ProcessResult>((resolve, reject) => {
    let spawnError: Error | undefined
    child.once("error", (error) => {
      spawnError = error
    })
    child.once("close", (exitCode, signal) => {
      if (spawnError) {
        reject(new ExedevError("validate", `failed to start process: ${spawnError.message}`, "PROCESS_START"))
        return
      }
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      })
    })
  })

  if (timeoutTimer) clearTimeout(timeoutTimer)
  if (terminationTimer) clearTimeout(terminationTimer)
  input.signal?.removeEventListener("abort", abort)

  if (stdoutOverflow || stderrOverflow) {
    throw new ExedevError("validate", "process output exceeded the configured limit", "OUTPUT_LIMIT")
  }
  if (timedOut) return { ...result, exitCode: null, signal: "SIGTERM" }
  if (aborted) return { ...result, exitCode: null, signal: "SIGTERM" }
  return result
}

function toEnvironment(input: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) environment[key] = value
  }
  return environment
}
