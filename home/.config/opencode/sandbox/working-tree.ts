import { createReadStream } from "node:fs"
import { lstat } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

import { nodeProcessRunner } from "./process"
import { sha256 } from "./naming"
import { SandboxError, type GitWorkingTreeObservation, type ProcessRunner, type SessionContext, type WorkingTreeCapture } from "./types"

const MAX_PATCH_BYTES = 8 * 1024 * 1024
const MAX_UNTRACKED_FILES = 10_000
const MAX_UNTRACKED_FILE_BYTES = 32 * 1024 * 1024
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024
const MAX_INSPECTION_BYTES = 16 * 1024
const CAPTURE_DEADLINE_MS = 30_000
const FILE_READ_CHUNK_BYTES = 64 * 1024

export async function inspectWorkingTree(
  directory: string,
  runner: ProcessRunner = nodeProcessRunner,
): Promise<GitWorkingTreeObservation> {
  assertDirectory(directory)
  const result = await runner.run({
    argv: ["git", "-C", directory, "status", "--porcelain=v2", "--branch", "--untracked-files=normal", "--"],
    cwd: directory,
    timeoutMs: 5_000,
    maxOutputBytes: MAX_INSPECTION_BYTES,
  })
  if (result.exitCode !== 0) throw new SandboxError("inspect", "could not inspect the Git worktree", "GIT_INSPECTION")

  let head: string | null = null
  let branch: string | null = null
  let dirty = false
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("# branch.oid ")) {
      const value = line.slice("# branch.oid ".length).trim()
      if (/^[a-f0-9]{40}$/i.test(value)) head = value
      continue
    }
    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim()
      branch = value === "(detached)" ? null : value || null
      continue
    }
    if (/^(?:1|2|u|\?|!) /.test(line)) dirty = true
  }

  return {
    head,
    branch,
    dirty,
    evidence: ["git status --porcelain=v2"],
  }
}

export async function captureWorkingTree(
  context: SessionContext,
  runner: ProcessRunner = nodeProcessRunner,
  deadlineMs = CAPTURE_DEADLINE_MS,
): Promise<WorkingTreeCapture> {
  const controller = new AbortController()
  const deadline = Date.now() + deadlineMs
  let timedOut = false
  const deadlineTimer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, deadlineMs)

  try {
    return await captureWorkingTreeWithinDeadline(context, runner, controller.signal, deadline)
  } catch (error) {
    if (timedOut || (error instanceof SandboxError && error.code === "GIT_CAPTURE_TIMEOUT")) {
      throw new SandboxError("git_preflight", "working tree capture timed out", "GIT_CAPTURE_TIMEOUT")
    }
    throw error
  } finally {
    clearTimeout(deadlineTimer)
  }
}

async function captureWorkingTreeWithinDeadline(
  context: SessionContext,
  runner: ProcessRunner,
  signal: AbortSignal,
  deadline: number,
): Promise<WorkingTreeCapture> {
  assertDirectory(context.worktree)
  const baseSha = await gitText(runner, context.worktree, ["rev-parse", "HEAD"], "git_preflight", signal, deadline)
  if (!/^[a-f0-9]{40}$/i.test(baseSha)) throw new SandboxError("git_preflight", "git returned an invalid HEAD", "GIT_HEAD")

  const patchResult = await runner.run({
    argv: ["git", "-C", context.worktree, "diff", "--binary", "HEAD", "--"],
    cwd: context.worktree,
    env: undefined,
    signal,
    timeoutMs: remainingCaptureMs(deadline, signal),
    maxOutputBytes: MAX_PATCH_BYTES,
  })
  remainingCaptureMs(deadline, signal)
  if (patchResult.exitCode !== 0) {
    throw new SandboxError("git_preflight", "could not capture tracked changes", "GIT_DIFF")
  }
  let captureBytes = Buffer.byteLength(patchResult.stdout)
  if (captureBytes > MAX_CAPTURE_BYTES) throw new SandboxError("git_preflight", "working tree capture is too large", "GIT_CAPTURE_LIMIT")

  const pathsResult = await runner.run({
    argv: ["git", "-C", context.worktree, "ls-files", "--others", "--exclude-standard", "--exclude=.sandcastle/**", "-z"],
    cwd: context.worktree,
    env: undefined,
    signal,
    timeoutMs: remainingCaptureMs(deadline, signal),
    maxOutputBytes: MAX_UNTRACKED_FILES * 4096,
  })
  remainingCaptureMs(deadline, signal)
  if (pathsResult.exitCode !== 0) throw new SandboxError("git_preflight", "could not list untracked files", "GIT_UNTRACKED")

  const paths = pathsResult.stdout.split("\0").filter(Boolean)
  if (paths.length > MAX_UNTRACKED_FILES) throw new SandboxError("git_preflight", "too many untracked files to capture", "GIT_UNTRACKED_LIMIT")
  const untracked = []
  for (const path of paths) {
    remainingCaptureMs(deadline, signal)
    const absolutePath = safeWorktreePath(context.worktree, path)
    const stats = await lstat(absolutePath)
    remainingCaptureMs(deadline, signal)
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new SandboxError("git_preflight", `untracked path is not a regular file: ${path}`, "GIT_UNTRACKED_PATH")
    }
    if (stats.size > MAX_UNTRACKED_FILE_BYTES) {
      throw new SandboxError("git_preflight", `untracked file is too large: ${path}`, "GIT_UNTRACKED_SIZE")
    }
    if (captureBytes + stats.size > MAX_CAPTURE_BYTES) {
      throw new SandboxError("git_preflight", "working tree capture is too large", "GIT_CAPTURE_LIMIT")
    }
    const remainingBytes = MAX_CAPTURE_BYTES - captureBytes
    const fileLimit = Math.min(MAX_UNTRACKED_FILE_BYTES, remainingBytes)
    const content = await readBoundedFile(
      absolutePath,
      fileLimit,
      signal,
      fileLimit === MAX_UNTRACKED_FILE_BYTES ? "GIT_UNTRACKED_SIZE" : "GIT_CAPTURE_LIMIT",
      fileLimit === MAX_UNTRACKED_FILE_BYTES ? `untracked file is too large: ${path}` : "working tree capture is too large",
    )
    remainingCaptureMs(deadline, signal)
    if (captureBytes + content.byteLength > MAX_CAPTURE_BYTES) {
      throw new SandboxError("git_preflight", "working tree capture is too large", "GIT_CAPTURE_LIMIT")
    }
    captureBytes += content.byteLength
    untracked.push({ path, sha256: sha256(content), content })
  }

  return { baseSha, patch: patchResult.stdout, untracked }
}

async function readBoundedFile(
  path: string,
  maxBytes: number,
  signal: AbortSignal,
  tooLargeCode: "GIT_UNTRACKED_SIZE" | "GIT_CAPTURE_LIMIT",
  tooLargeMessage: string,
): Promise<Buffer> {
  if (signal.aborted) throw signal.reason ?? new Error("working tree capture timed out")
  const stream = createReadStream(path, { highWaterMark: FILE_READ_CHUNK_BYTES, signal })
  const chunks: Buffer[] = []
  let size = 0

  try {
    for await (const chunk of stream) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (size + value.byteLength > maxBytes) {
        throw new SandboxError("git_preflight", tooLargeMessage, tooLargeCode)
      }
      chunks.push(value)
      size += value.byteLength
    }
  } finally {
    stream.destroy()
  }

  return Buffer.concat(chunks, size)
}

function assertDirectory(path: string): void {
  if (!isAbsolute(path) || path.includes("\0") || path.includes("\n") || path.includes("\r")) {
    throw new SandboxError("validate", "worktree path is unsafe", "WORKTREE_PATH")
  }
}

function safeWorktreePath(worktree: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes("\0") || path.includes("\n") || path.includes("\r")) {
    throw new SandboxError("git_preflight", "git returned an unsafe untracked path", "GIT_PATH")
  }
  const absolute = resolve(worktree, path)
  const relativePath = relative(worktree, absolute)
  if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
    throw new SandboxError("git_preflight", "untracked path escapes the worktree", "GIT_PATH")
  }
  return absolute
}

function remainingCaptureMs(deadline: number, signal: AbortSignal): number {
  const remaining = deadline - Date.now()
  if (signal.aborted || remaining <= 0) {
    throw new SandboxError("git_preflight", "working tree capture timed out", "GIT_CAPTURE_TIMEOUT")
  }
  return remaining
}

async function gitText(
  runner: ProcessRunner,
  cwd: string,
  args: string[],
  stage: "git_preflight",
  signal: AbortSignal,
  deadline: number,
): Promise<string> {
  const result = await runner.run({
    argv: ["git", "-C", cwd, ...args],
    cwd,
    signal,
    timeoutMs: remainingCaptureMs(deadline, signal),
    maxOutputBytes: 4096,
  })
  remainingCaptureMs(deadline, signal)
  if (result.exitCode !== 0) throw new SandboxError(stage, "git command failed", "GIT_COMMAND")
  return result.stdout.trim()
}
