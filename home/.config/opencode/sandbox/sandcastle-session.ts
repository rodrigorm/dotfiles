import {
  createWorktree as defaultCreateWorktree,
  type CloseResult,
  type Sandbox,
  type SandboxProvider,
  type SandboxRunResult,
  type Worktree,
} from "@ai-hero/sandcastle"

import { redactError, redactText } from "./redaction"
import { runSyncBarrier } from "./sync-barrier"
import { SandboxError, type SessionContext, type WorkspaceTarget, type WorkingTreeCapture } from "./types"

export interface OpenCodeSandboxAdapter {
  readonly provider: SandboxProvider
  applyCapture(input: { sandbox: Sandbox; capture: WorkingTreeCapture }): Promise<void>
  target(): WorkspaceTarget | Promise<WorkspaceTarget>
  recoveryMetadata?(): Record<string, unknown>
}

export interface SandcastleAdapterInput {
  sessionId: string
  projectId: string
  workspaceId: string
  generation: number
  branch: string
  baseSha: string
  context: SessionContext
}

export interface SandcastleSessionFactory {
  createAdapter(input: SandcastleAdapterInput): OpenCodeSandboxAdapter | Promise<OpenCodeSandboxAdapter>
  createWorktree?: typeof defaultCreateWorktree
}

export interface SandcastleSessionInput {
  factory: SandcastleSessionFactory
  context: SessionContext
  workspaceId: string
  generation: number
  branch: string
  baseSha: string
}

export interface SandcastleSession {
  readonly workspaceId: string
  readonly branch: string
  readonly worktree: Worktree
  readonly sandbox: Sandbox
  readonly target: Extract<WorkspaceTarget, { type: "remote" }>
  readonly recoveryMetadata: Record<string, unknown>
  applyCapture(capture: WorkingTreeCapture): Promise<void>
  sync(): Promise<SandboxRunResult>
  close(): Promise<CloseResult>
}

export async function createSandcastleSession(input: SandcastleSessionInput): Promise<SandcastleSession> {
  const adapter = await input.factory.createAdapter({
    sessionId: input.context.sessionId,
    projectId: input.context.projectId,
    workspaceId: input.workspaceId,
    generation: input.generation,
    branch: input.branch,
    baseSha: input.baseSha,
    context: input.context,
  })
  const createWorktree = input.factory.createWorktree ?? defaultCreateWorktree
  let worktree: Worktree | undefined
  let sandbox: Sandbox | undefined

  try {
    worktree = await createWorktree({
      cwd: input.context.worktree,
      branchStrategy: {
        type: "branch",
        branch: input.branch,
        baseBranch: input.baseSha,
      },
    })
    sandbox = await worktree.createSandbox({ sandbox: adapter.provider })
    const sessionWorktree = worktree
    const sessionSandbox = sandbox
    let target: Extract<WorkspaceTarget, { type: "remote" }> | undefined
    let closed = false
    let closeResult: CloseResult | undefined

    return {
      workspaceId: input.workspaceId,
      branch: input.branch,
      worktree: sessionWorktree,
      sandbox: sessionSandbox,
      get target() {
        if (!target) throw new SandboxError("tunnel", "sandbox target is unavailable", "TARGET_UNAVAILABLE")
        return target
      },
      get recoveryMetadata() {
        return { ...(adapter.recoveryMetadata?.() ?? {}) }
      },
      async applyCapture(capture) {
        if (capture.baseSha !== input.baseSha) {
          throw new SandboxError("sync", "working tree capture does not match the Sandcastle worktree", "CAPTURE_SHA_MISMATCH")
        }
        const head = await sessionSandbox.exec("git rev-parse HEAD")
        if (head.exitCode !== 0) {
          throw new SandboxError("sync", redactText(head.stderr || "could not read sandbox HEAD"), "SANDBOX_HEAD")
        }
        if (head.stdout.trim() !== input.baseSha) {
          throw new SandboxError("sync", "sandbox worktree does not match the captured revision", "SANDBOX_HEAD_MISMATCH")
        }
        await adapter.applyCapture({ sandbox: sessionSandbox, capture })
        const nextTarget = await adapter.target()
        if (nextTarget.type !== "remote") throw new SandboxError("tunnel", "sandbox target is not remote", "TARGET_INVALID")
        target = nextTarget
      },
      async sync() {
        const commit = await sessionSandbox.exec(
          "git add -A && (git diff --cached --quiet || git -c user.name='OpenCode Sandbox' -c user.email='opencode@localhost' commit -m 'opencode: sync sandbox workspace')",
        )
        if (commit.exitCode !== 0) {
          throw new SandboxError("sync", redactText(commit.stderr || "could not commit sandbox changes"), "SANDBOX_COMMIT")
        }
        return runSyncBarrier(sessionSandbox)
      },
      async close() {
        if (closed) return closeResult ?? {}
        await sessionSandbox.close()
        closeResult = await sessionWorktree.close()
        closed = true
        return closeResult
      },
    }
  } catch (error) {
    await sandbox?.close().catch(() => undefined)
    await worktree?.close().catch(() => undefined)
    if (error instanceof SandboxError) throw error
    throw new SandboxError("provision", redactError(error), "SANDCASTLE_SESSION")
  }
}
