import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

import { nodeProcessRunner } from "./process"
import { ExedevError, type ProcessRunner, type SessionContext, type WorkingTreeCapture } from "./types"

const MAX_PATCH_BYTES = 8 * 1024 * 1024
const MAX_UNTRACKED_FILES = 10_000
const MAX_UNTRACKED_FILE_BYTES = 32 * 1024 * 1024

export async function captureWorkingTree(
  context: SessionContext,
  runner: ProcessRunner = nodeProcessRunner,
): Promise<WorkingTreeCapture> {
  assertDirectory(context.worktree)
  const baseSha = await gitText(runner, context.worktree, ["rev-parse", "HEAD"], "git_preflight")
  if (!/^[a-f0-9]{40}$/i.test(baseSha)) throw new ExedevError("git_preflight", "git returned an invalid HEAD", "GIT_HEAD")

  const patchResult = await runner.run({
    argv: ["git", "-C", context.worktree, "diff", "--binary", "HEAD", "--"],
    cwd: context.worktree,
    env: undefined,
    maxOutputBytes: MAX_PATCH_BYTES,
  })
  if (patchResult.exitCode !== 0) {
    throw new ExedevError("git_preflight", "could not capture tracked changes", "GIT_DIFF")
  }

  const pathsResult = await runner.run({
    argv: ["git", "-C", context.worktree, "ls-files", "--others", "--exclude-standard", "-z"],
    cwd: context.worktree,
    env: undefined,
    maxOutputBytes: MAX_UNTRACKED_FILES * 4096,
  })
  if (pathsResult.exitCode !== 0) throw new ExedevError("git_preflight", "could not list untracked files", "GIT_UNTRACKED")

  const paths = pathsResult.stdout.split("\0").filter(Boolean)
  if (paths.length > MAX_UNTRACKED_FILES) throw new ExedevError("git_preflight", "too many untracked files to capture", "GIT_UNTRACKED_LIMIT")
  const untracked = []
  for (const path of paths) {
    const absolutePath = safeWorktreePath(context.worktree, path)
    const stats = await lstat(absolutePath)
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new ExedevError("git_preflight", `untracked path is not a regular file: ${path}`, "GIT_UNTRACKED_PATH")
    }
    if (stats.size > MAX_UNTRACKED_FILE_BYTES) {
      throw new ExedevError("git_preflight", `untracked file is too large: ${path}`, "GIT_UNTRACKED_SIZE")
    }
    const content = await readFile(absolutePath)
    untracked.push({ path, sha256: sha256(content), content })
  }

  return { baseSha, patch: patchResult.stdout, untracked }
}

function assertDirectory(path: string): void {
  if (!isAbsolute(path) || path.includes("\0") || path.includes("\n") || path.includes("\r")) {
    throw new ExedevError("validate", "worktree path is unsafe", "WORKTREE_PATH")
  }
}

function safeWorktreePath(worktree: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes("\0") || path.includes("\n") || path.includes("\r")) {
    throw new ExedevError("git_preflight", "git returned an unsafe untracked path", "GIT_PATH")
  }
  const absolute = resolve(worktree, path)
  const relativePath = relative(worktree, absolute)
  if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
    throw new ExedevError("git_preflight", "untracked path escapes the worktree", "GIT_PATH")
  }
  return absolute
}

async function gitText(runner: ProcessRunner, cwd: string, args: string[], stage: "git_preflight"): Promise<string> {
  const result = await runner.run({ argv: ["git", "-C", cwd, ...args], cwd, maxOutputBytes: 4096 })
  if (result.exitCode !== 0) throw new ExedevError(stage, "git command failed", "GIT_COMMAND")
  return result.stdout.trim()
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}
