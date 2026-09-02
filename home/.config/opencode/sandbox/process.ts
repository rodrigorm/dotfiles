import { spawn } from "node:child_process"

import { SandboxError, type ProcessHandle, type ProcessResult, type ProcessRunner, type ProcessSupervisor, type RunProcessInput } from "./types"

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576
const TERMINATION_GRACE_MS = 3_000

export const nodeProcessRunner: ProcessRunner = {
  run: runProcess,
}

export const nodeProcessSupervisor: ProcessSupervisor = {
  start: startProcess,
}

export function sanitizeEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
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
  return environment
}

export async function runProcess(input: RunProcessInput): Promise<ProcessResult> {
  const process = await startProcess(input)
  return process.result
}

export function startProcess(input: RunProcessInput): Promise<ProcessHandle> {
  if (input.argv.length === 0 || input.argv.some((argument) => typeof argument !== "string")) {
    return Promise.reject(new SandboxError("validate", "process argv must contain at least one string", "ARGV_INVALID"))
  }

  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    return Promise.reject(new SandboxError("validate", "process output limit is invalid", "OUTPUT_LIMIT_INVALID"))
  }

  const child = spawn(input.argv[0], input.argv.slice(1), {
    cwd: input.cwd,
    env: input.env ? input.env : undefined,
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
  let pendingLine = ""

  const emitLines = (chunk: Buffer) => {
    if (!input.onLine) return
    pendingLine += chunk.toString("utf8")
    const lines = pendingLine.split("\n")
    pendingLine = lines.pop() ?? ""
    for (const line of lines) input.onLine(line.endsWith("\r") ? line.slice(0, -1) : line)
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength
    if (stdoutBytes <= maxOutputBytes) stdout.push(chunk)
    else stdoutOverflow = true
    emitLines(chunk)
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

  const result = new Promise<ProcessResult>((resolve, reject) => {
    let spawnError: Error | undefined
    child.once("error", (error) => {
      spawnError = error
    })
    child.once("close", (exitCode, signal) => {
      if (spawnError) {
        reject(new SandboxError("validate", `failed to start process: ${spawnError.message}`, "PROCESS_START"))
        return
      }
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      })
      if (input.onLine && pendingLine) {
        input.onLine(pendingLine.endsWith("\r") ? pendingLine.slice(0, -1) : pendingLine)
      }
    })
  }).then((result) => {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (terminationTimer) clearTimeout(terminationTimer)
    input.signal?.removeEventListener("abort", abort)

    if (stdoutOverflow || stderrOverflow) {
      throw new SandboxError("validate", "process output exceeded the configured limit", "OUTPUT_LIMIT")
    }
    if (timedOut) return { ...result, exitCode: null, signal: "SIGTERM" as const }
    if (aborted) return { ...result, exitCode: null, signal: "SIGTERM" as const }
    return result
  })

  if (child.pid === undefined) {
    void result.catch(() => undefined)
    terminate()
    return Promise.reject(new SandboxError("validate", "process did not expose a PID", "PROCESS_PID"))
  }

  return Promise.resolve({
    pid: child.pid,
    result,
    terminate,
  })
}
