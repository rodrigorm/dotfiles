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
import {
  SandboxError,
  type ProcessOwnershipObservation,
  type ProviderResourceObservation,
  type RuntimeDriver,
  type RuntimeSession,
  type SessionContext,
  type WorkspaceTarget,
  type WorkingTreeCapture,
} from "./types"

export interface OpenCodeSandboxAdapter {
  readonly provider: SandboxProvider
  applyCapture(input: { sandbox: Sandbox; capture: WorkingTreeCapture }): Promise<void>
  target(): WorkspaceTarget | Promise<WorkspaceTarget>
  inspect?(signal?: AbortSignal): Promise<ProviderResourceObservation>
  diagnose?(signal?: AbortSignal): Promise<ProviderResourceObservation>
  processObservation?(): ProcessOwnershipObservation
  recoveryMetadata?(): Record<string, unknown>
  close?(): Promise<void>
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
  runtimeDriver?: RuntimeDriver
}

export interface SandcastleSessionInput {
  factory: SandcastleSessionFactory
  context: SessionContext
  workspaceId: string
  generation: number
  branch: string
  baseSha: string
}

export interface SandcastleSession extends RuntimeSession {
  readonly workspaceId: string
  readonly branch: string
  readonly worktree: Worktree
  readonly worktreePath: string
  readonly sandbox: Sandbox
  readonly target: Extract<WorkspaceTarget, { type: "remote" }>
  readonly recoveryMetadata: Record<string, unknown>
  inspect?(signal?: AbortSignal): Promise<ProviderResourceObservation>
  diagnose?(signal?: AbortSignal): Promise<ProviderResourceObservation>
  processObservation?(): ProcessOwnershipObservation
  applyCapture(capture: WorkingTreeCapture): Promise<void>
  sync(): Promise<SandboxRunResult>
  close(): Promise<CloseResult>
  abort(): Promise<CloseResult>
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
    let closing: Promise<CloseResult> | undefined
    let sandboxClosed = false
    let sandboxCloseFailed = false
    let sandboxFailure: unknown
    let worktreeClosed = false
    let closeResult: CloseResult = {}
    let aborting: Promise<CloseResult> | undefined

    return {
      workspaceId: input.workspaceId,
      branch: input.branch,
      worktree: sessionWorktree,
      worktreePath: sessionWorktree.worktreePath,
      sandbox: sessionSandbox,
      get target() {
        if (!target) throw new SandboxError("tunnel", "sandbox target is unavailable", "TARGET_UNAVAILABLE")
        return target
      },
      get recoveryMetadata() {
        return { ...(adapter.recoveryMetadata?.() ?? {}) }
      },
      ...(adapter.inspect ? { inspect: (signal?: AbortSignal) => adapter.inspect!(signal) } : {}),
      ...(adapter.diagnose ? { diagnose: (signal?: AbortSignal) => adapter.diagnose!(signal) } : {}),
      ...(adapter.processObservation ? { processObservation: () => adapter.processObservation!() } : {}),
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
      close() {
        closing ??= (async () => {
          let failure: unknown
          if (!sandboxClosed) {
            if (sandboxCloseFailed && !adapter.close) {
              failure = sandboxFailure
            } else if (sandboxCloseFailed) {
              try {
                await adapter.close!()
                sandboxClosed = true
              } catch (error) {
                failure = error
              }
            } else {
              try {
                await sessionSandbox.close()
                sandboxClosed = true
              } catch (error) {
                sandboxCloseFailed = true
                sandboxFailure = error
                if (!adapter.close) failure = error
                else {
                  try {
                    await adapter.close()
                    sandboxClosed = true
                  } catch (closeError) {
                    failure = closeError
                  }
                }
              }
            }
          }
          if (!worktreeClosed) {
            try {
              closeResult = await sessionWorktree.close()
              worktreeClosed = true
            } catch (error) {
              const preservedWorktreePath = preservedPathFrom(error)
              if (preservedWorktreePath) closeResult = { preservedWorktreePath }
              failure ??= error
            }
          }
          if (failure) throw failure
          return closeResult
        })().catch((error) => {
          attachPreservedPath(error, closeResult.preservedWorktreePath)
          closing = undefined
          throw error
        })
        return closing
      },
      abort() {
        aborting ??= (async () => {
          let failure: unknown
          if (!sandboxClosed) {
            try {
              await sessionSandbox.close()
              sandboxClosed = true
            } catch (error) {
              failure = error
            }
          }
          if (!worktreeClosed) {
            try {
              closeResult = await sessionWorktree.close()
              worktreeClosed = true
            } catch (error) {
              const preservedWorktreePath = preservedPathFrom(error)
              if (preservedWorktreePath) closeResult = { preservedWorktreePath }
              failure ??= error
            }
          }
          if (failure) {
            attachPreservedPath(failure, closeResult.preservedWorktreePath)
            throw failure
          }
          return closeResult
        })().catch((error) => {
          attachPreservedPath(error, closeResult.preservedWorktreePath)
          aborting = undefined
          throw error
        })
        return aborting
      },
    }
  } catch (error) {
    let preservedWorktreePath: string | undefined
    try {
      preservedWorktreePath = (await sandbox?.close())?.preservedWorktreePath
    } catch (cleanupError) {
      preservedWorktreePath = preservedPathFrom(cleanupError)
    }
    try {
      preservedWorktreePath ??= (await worktree?.close())?.preservedWorktreePath
    } catch (cleanupError) {
      preservedWorktreePath ??= preservedPathFrom(cleanupError)
    }
    attachPreservedPath(error, preservedWorktreePath)
    if (error instanceof SandboxError) throw error
    throw new SandboxError("provision", redactError(error), "SANDCASTLE_SESSION")
  }
}

function preservedPathFrom(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "preservedWorktreePath" in error && typeof error.preservedWorktreePath === "string"
    ? error.preservedWorktreePath
    : undefined
}

function attachPreservedPath(error: unknown, path: string | undefined): void {
  if (!path || !(error instanceof Error)) return
  Object.assign(error, { preservedWorktreePath: path })
}
