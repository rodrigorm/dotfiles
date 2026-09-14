import { createReadStream } from "node:fs"
import { lstat, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, relative, resolve, sep } from "node:path"

import { assertRelativePath, sha256 } from "./naming"
import { nodeProcessRunner, sanitizeEnvironment } from "./process"
import { redactError, redactText } from "./redaction"
import { SandboxError, type GitWorkingTreeObservation, type ProcessResult, type ProcessRunner, type SessionContext, type WorkingTreeCapture } from "./types"

const MAX_PATCH_BYTES = 8 * 1024 * 1024
const MAX_UNTRACKED_FILES = 10_000
const MAX_UNTRACKED_FILE_BYTES = 32 * 1024 * 1024
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024
const MAX_INSPECTION_BYTES = 16 * 1024
const CAPTURE_DEADLINE_MS = 30_000
const FILE_READ_CHUNK_BYTES = 64 * 1024

type ReturnedWorktree = string | { readonly worktreePath: string; readonly remoteTree?: string }

export async function syncBackWorkingTree(
  context: SessionContext,
  initialCapture: WorkingTreeCapture,
  returnedWorktree: ReturnedWorktree,
  runner: ProcessRunner = nodeProcessRunner,
): Promise<void> {
  const hostWorktree = context.worktree
  const remoteWorktree = typeof returnedWorktree === "string" ? returnedWorktree : returnedWorktree.worktreePath
  let temporaryRoot: string | undefined

  try {
    assertDirectory(hostWorktree)
    assertDirectory(remoteWorktree)
    validateCapture(initialCapture)

    temporaryRoot = await mkdtemp(resolve(tmpdir(), "opencode-sync-back-"))
    const indexPath = resolve(temporaryRoot, "index")
    const initialTree = await reconstructCaptureTree(runner, hostWorktree, indexPath, initialCapture)

    await requireSyncGit(runner, remoteWorktree, ["read-tree", "HEAD"], { indexPath })
    await requireSyncGit(runner, remoteWorktree, ["add", "-A", "--"], { indexPath })
    const returnedTree = await syncGitText(runner, remoteWorktree, ["write-tree"], { indexPath })
    if (!/^[a-f0-9]{40}$/i.test(returnedTree)) {
      throw new SandboxError("sync", "Git returned an invalid returned worktree tree", "GIT_TREE")
    }
    const remoteTree = typeof returnedWorktree === "string" ? undefined : returnedWorktree.remoteTree
    if (remoteTree !== undefined) {
      if (!/^[a-f0-9]{40}$/i.test(remoteTree)) throw new SandboxError("sync", "Git returned an invalid remote tree", "GIT_TREE")
      if (remoteTree !== returnedTree) {
        throw new SandboxError("sync", "remote and imported Git trees do not match", "GIT_IMPORT_MISMATCH")
      }
    }

    const diff = (await requireSyncGit(runner, hostWorktree, ["diff", "--binary", initialTree, returnedTree, "--"])).stdout
    const currentCapture = await captureWorkingTree(context, runner)
    if (!sameCapture(initialCapture, currentCapture)) {
      throw new SandboxError("sync", "host working tree changed since the initial capture", "GIT_WORKTREE_CHANGED")
    }
    if (!diff) return

    await requireSyncGit(runner, hostWorktree, ["apply", "--check", "--binary", "-"], { stdin: diff }, "GIT_APPLY")
    await requireSyncGit(runner, hostWorktree, ["apply", "--binary", "-"], { stdin: diff }, "GIT_APPLY")
  } catch (error) {
    if (error instanceof SandboxError) throw error
    throw new SandboxError("sync", redactError(error), "GIT_SYNC_BACK")
  } finally {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function inspectWorkingTree(
  directory: string,
  runner: ProcessRunner = nodeProcessRunner,
  signal?: AbortSignal,
): Promise<GitWorkingTreeObservation> {
  assertDirectory(directory)
  const result = await runner.run({
    argv: ["git", "-C", directory, "status", "--porcelain=v2", "--branch", "--untracked-files=normal", "--"],
    cwd: directory,
    timeoutMs: 5_000,
    signal,
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

async function reconstructCaptureTree(
  runner: ProcessRunner,
  worktree: string,
  indexPath: string,
  capture: WorkingTreeCapture,
): Promise<string> {
  await requireSyncGit(runner, worktree, ["read-tree", capture.baseSha], { indexPath })
  if (capture.patch) {
    await requireSyncGit(runner, worktree, ["apply", "--cached", "--binary", "-"], { indexPath, stdin: capture.patch }, "GIT_CAPTURE_APPLY")
  }

  for (const file of capture.untracked) {
    const object = await syncGitText(runner, worktree, ["hash-object", "-w", "--stdin"], { indexPath, stdin: file.content })
    if (!/^[a-f0-9]{40}$/i.test(object)) throw new SandboxError("sync", `Git returned an invalid blob for ${file.path}`, "GIT_BLOB")
    await requireSyncGit(runner, worktree, ["update-index", "--add", "--cacheinfo", `100644,${object},${file.path}`], { indexPath })
  }

  const tree = await syncGitText(runner, worktree, ["write-tree"], { indexPath })
  if (!/^[a-f0-9]{40}$/i.test(tree)) throw new SandboxError("sync", "Git returned an invalid capture tree", "GIT_TREE")
  return tree
}

function validateCapture(capture: WorkingTreeCapture): void {
  if (!/^[a-f0-9]{40}$/i.test(capture.baseSha)) throw new SandboxError("sync", "working tree capture has an invalid base revision", "GIT_HEAD")
  const paths = new Set<string>()
  for (const file of capture.untracked) {
    assertRelativePath(file.path)
    if (paths.has(file.path)) throw new SandboxError("sync", `working tree capture contains duplicate path: ${file.path}`, "CAPTURE_PATH")
    paths.add(file.path)
    if (sha256(file.content) !== file.sha256) throw new SandboxError("sync", `working tree hash mismatch: ${file.path}`, "CAPTURE_HASH")
  }
}

function sameCapture(left: WorkingTreeCapture, right: WorkingTreeCapture): boolean {
  if (left.baseSha !== right.baseSha || left.patch !== right.patch || left.untracked.length !== right.untracked.length) return false
  const leftFiles = [...left.untracked].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const rightFiles = [...right.untracked].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return leftFiles.every((file, index) => {
    const other = rightFiles[index]
    return Boolean(other) && file.path === other.path && file.sha256 === other.sha256 && sameBytes(file.content, other.content)
  })
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

async function requireSyncGit(
  runner: ProcessRunner,
  cwd: string,
  args: string[],
  options: { indexPath?: string; stdin?: string | Uint8Array } = {},
  failureCode = "GIT_COMMAND",
): Promise<ProcessResult> {
  const result = await runSyncGit(runner, cwd, args, options)
  if (result.exitCode !== 0) {
    throw new SandboxError("sync", redactText(result.stderr || result.stdout || `git ${args[0] ?? "command"} failed`), failureCode)
  }
  return result
}

async function syncGitText(
  runner: ProcessRunner,
  cwd: string,
  args: string[],
  options: { indexPath?: string; stdin?: string | Uint8Array } = {},
): Promise<string> {
  return (await requireSyncGit(runner, cwd, args, options)).stdout.trim()
}

async function runSyncGit(
  runner: ProcessRunner,
  cwd: string,
  args: string[],
  options: { indexPath?: string; stdin?: string | Uint8Array } = {},
): Promise<ProcessResult> {
  try {
    return await runner.run({
      argv: ["git", "-C", cwd, ...args],
      cwd,
      env: {
        ...sanitizeEnvironment(),
        ...(options.indexPath ? { GIT_INDEX_FILE: options.indexPath } : {}),
      },
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      maxOutputBytes: MAX_PATCH_BYTES,
    })
  } catch (error) {
    if (error instanceof SandboxError) throw error
    throw new SandboxError("sync", redactError(error), "GIT_COMMAND")
  }
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
