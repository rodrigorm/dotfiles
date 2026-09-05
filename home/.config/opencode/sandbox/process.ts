import { spawn, type ChildProcess } from "node:child_process"

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

  let child: ChildProcess
  try {
    child = spawn(input.argv[0], input.argv.slice(1), {
      cwd: input.cwd,
      env: input.env ? input.env : undefined,
      shell: false,
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return Promise.reject(new SandboxError("validate", `failed to start process: ${message}`, "PROCESS_START"))
  }

  let stdoutBytes = 0
  let stderrBytes = 0
  let stdoutOverflow = false
  let stderrOverflow = false
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let pendingLine: Buffer[] = []
  let pendingLineBytes = 0
  let lineOverflow = false
  let terminationTimer: ReturnType<typeof setTimeout> | undefined
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  let aborted = false
  let terminating = false
  let cleanedUp = false

  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (terminationTimer) clearTimeout(terminationTimer)
    input.signal?.removeEventListener("abort", abort)
  }

  const terminate = () => {
    if (terminating || child.exitCode !== null || child.signalCode !== null) return
    terminating = true
    child.kill("SIGTERM")
    terminationTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    }, TERMINATION_GRACE_MS)
  }

  const overflow = () => {
    stdoutOverflow = true
    terminate()
  }

  const emitLines = (chunk: Buffer) => {
    if (!input.onLine || stdoutOverflow) return
    let start = 0
    while (start < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, start)
      const end = newline === -1 ? chunk.byteLength : newline
      const part = chunk.subarray(start, end)
      if (!lineOverflow) {
        if (pendingLineBytes + part.byteLength > maxOutputBytes) {
          lineOverflow = true
          overflow()
          return
        }
        else {
          pendingLine.push(part)
          pendingLineBytes += part.byteLength
        }
      }
      if (newline === -1) return
      if (!lineOverflow) {
        const line = Buffer.concat(pendingLine, pendingLineBytes).toString("utf8")
        input.onLine(line.endsWith("\r") ? line.slice(0, -1) : line)
      }
      pendingLine = []
      pendingLineBytes = 0
      lineOverflow = false
      start = newline + 1
    }
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength
    if (stdoutBytes <= maxOutputBytes) stdout.push(chunk)
    else overflow()
    emitLines(chunk)
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength
    if (stderrBytes <= maxOutputBytes) stderr.push(chunk)
    else {
      stderrOverflow = true
      terminate()
    }
  })

  if (input.stdin === undefined) child.stdin?.end()
  else child.stdin?.end(typeof input.stdin === "string" ? input.stdin : Buffer.from(input.stdin))

  const abort = () => {
    aborted = true
    terminate()
  }

  const result = new Promise<ProcessResult>((resolve, reject) => {
    let spawnError: Error | undefined
    child.once("error", (error) => {
      spawnError = error
      cleanup()
      reject(new SandboxError("validate", `failed to start process: ${error.message}`, "PROCESS_START"))
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
      if (input.onLine && pendingLineBytes > 0 && !lineOverflow && !stdoutOverflow) {
        const line = Buffer.concat(pendingLine, pendingLineBytes).toString("utf8")
        input.onLine(line.endsWith("\r") ? line.slice(0, -1) : line)
      }
    })
  }).then(
    (result) => {
      cleanup()

      if (stdoutOverflow || stderrOverflow) {
        throw new SandboxError("validate", "process output exceeded the configured limit", "OUTPUT_LIMIT")
      }
      if (timedOut) return { ...result, exitCode: null, signal: "SIGTERM" as const }
      if (aborted) return { ...result, exitCode: null, signal: "SIGTERM" as const }
      return result
    },
    (error) => {
      cleanup()
      throw error
    },
  )

  timeoutTimer = input.timeoutMs
    ? setTimeout(() => {
        timedOut = true
        terminate()
      }, input.timeoutMs)
    : undefined

  input.signal?.addEventListener("abort", abort, { once: true })
  if (input.signal?.aborted) abort()

  if (child.pid === undefined) {
    return result.then(
      () => Promise.reject(new SandboxError("validate", "process did not expose a PID", "PROCESS_PID")),
      (error) => Promise.reject(error),
    )
  }

  return Promise.resolve({
    pid: child.pid,
    result,
    terminate,
  })
}
