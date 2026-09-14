import { afterEach, describe, expect, it } from "bun:test"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { createWorktree } from "@ai-hero/sandcastle"

import { nodeProcessRunner } from "./process"
import { captureWorkingTree, syncBackWorkingTree } from "./working-tree"
import type { SessionContext, WorkingTreeCapture } from "./types"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("local working tree sync-back", () => {
  it("applies edits to an initially untracked file without changing HEAD or the index", async () => {
    const repository = await createRepository()
    await writeFile(join(repository, "staged.txt"), "staged change\n")
    await runGit(repository, ["add", "staged.txt"])
    await writeFile(join(repository, "tracked.txt"), "local change\n")
    await writeFile(join(repository, "remote.txt"), "before\n")
    const context = contextFor(repository)
    const initialCapture = await captureWorkingTree(context)
    const returnedWorktree = await createReturnedWorktree(repository, initialCapture, "opencode/sync-back-untracked")

    try {
      await writeFile(join(returnedWorktree.worktreePath, "remote.txt"), "after remotely\n")
      await writeFile(join(returnedWorktree.worktreePath, "remote.bin"), Buffer.from([0, 1, 2, 255]))
      const head = await runGit(repository, ["rev-parse", "HEAD"])
      const index = await runGit(repository, ["ls-files", "--stage"])
      const cachedDiff = await runGit(repository, ["diff", "--cached", "--binary"])

      await syncBackWorkingTree(context, initialCapture, returnedWorktree)

      expect(await readFile(join(repository, "remote.txt"), "utf8")).toBe("after remotely\n")
      expect(await readFile(join(repository, "remote.bin"))).toEqual(Buffer.from([0, 1, 2, 255]))
      expect(await runGit(repository, ["rev-parse", "HEAD"])).toBe(head)
      expect(await runGit(repository, ["ls-files", "--stage"])).toBe(index)
      expect(await runGit(repository, ["diff", "--cached", "--binary"])).toBe(cachedDiff)
      expect(await readFile(join(repository, "tracked.txt"), "utf8")).toBe("local change\n")
      expect(await readFile(join(repository, "staged.txt"), "utf8")).toBe("staged change\n")
    } finally {
      await returnedWorktree.close()
    }
  })

  it("rejects a concurrent host change before applying any remote file", async () => {
    const repository = await createRepository()
    const context = contextFor(repository)
    const initialCapture = await captureWorkingTree(context)
    const returnedWorktree = await createReturnedWorktree(repository, initialCapture, "opencode/sync-back-conflict")

    try {
      await writeFile(join(returnedWorktree.worktreePath, "tracked.txt"), "remote change\n")
      await writeFile(join(returnedWorktree.worktreePath, "remote-only.txt"), "must not be applied\n")
      await writeFile(join(repository, "tracked.txt"), "local concurrent change\n")
      const head = await runGit(repository, ["rev-parse", "HEAD"])
      const index = await runGit(repository, ["ls-files", "--stage"])

      await expect(syncBackWorkingTree(context, initialCapture, returnedWorktree)).rejects.toMatchObject({
        code: "GIT_WORKTREE_CHANGED",
      })

      expect(await readFile(join(repository, "tracked.txt"), "utf8")).toBe("local concurrent change\n")
      await expect(access(join(repository, "remote-only.txt"))).rejects.toBeDefined()
      expect(await runGit(repository, ["rev-parse", "HEAD"])).toBe(head)
      expect(await runGit(repository, ["ls-files", "--stage"])).toBe(index)
      expect(await readFile(join(returnedWorktree.worktreePath, "remote-only.txt"), "utf8")).toBe("must not be applied\n")
    } finally {
      await returnedWorktree.close()
    }
  })

  it("rejects an imported tree that differs from the remote tree", async () => {
    const repository = await createRepository()
    const context = contextFor(repository)
    const initialCapture = await captureWorkingTree(context)
    const returnedWorktree = await createReturnedWorktree(repository, initialCapture, "opencode/sync-back-tree-mismatch")

    try {
      const remoteTree = await runGit(returnedWorktree.worktreePath, ["rev-parse", "HEAD^{tree}"])
      await writeFile(join(returnedWorktree.worktreePath, "not-imported.txt"), "remote content\n")

      await expect(syncBackWorkingTree(context, initialCapture, { worktreePath: returnedWorktree.worktreePath, remoteTree })).rejects.toMatchObject({
        code: "GIT_IMPORT_MISMATCH",
      })

      await expect(access(join(repository, "not-imported.txt"))).rejects.toBeDefined()
    } finally {
      await returnedWorktree.close()
    }
  })
})

async function createRepository(): Promise<string> {
  const repository = await temporaryDirectory()
  await runGit(repository, ["init", "-q"])
  await runGit(repository, ["config", "user.name", "Working Tree Test"])
  await runGit(repository, ["config", "user.email", "working-tree@example.invalid"])
  await writeFile(join(repository, ".gitignore"), ".sandcastle/\n")
  await writeFile(join(repository, "tracked.txt"), "base\n")
  await runGit(repository, ["add", "."])
  await runGit(repository, ["commit", "-q", "-m", "initial"])
  return repository
}

async function createReturnedWorktree(repository: string, capture: WorkingTreeCapture, branch: string) {
  const worktree = await createWorktree({
    cwd: repository,
    branchStrategy: { type: "branch", branch, baseBranch: capture.baseSha },
  })
  if (capture.patch) await runGit(worktree.worktreePath, ["apply", "--binary", "-"], capture.patch)
  for (const file of capture.untracked) {
    const path = join(worktree.worktreePath, file.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.content)
  }
  return worktree
}

function contextFor(repository: string): SessionContext {
  return { sessionId: "ses_sync_back", projectId: "prj_sync_back", directory: repository, worktree: repository }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-working-tree-test-"))
  temporaryDirectories.push(directory)
  return directory
}

async function runGit(cwd: string, args: string[], stdin?: string | Uint8Array): Promise<string> {
  const result = await nodeProcessRunner.run({ argv: ["git", "-C", cwd, ...args], cwd, stdin })
  if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args[0] ?? "command"} failed`)
  return result.stdout.trimEnd()
}
