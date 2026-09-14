import { afterEach, describe, expect, it } from "bun:test"
import { spawn } from "node:child_process"
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  createIsolatedSandboxProvider,
  createWorktree,
  type IsolatedSandboxHandle,
  type Sandbox,
  type Worktree,
} from "@ai-hero/sandcastle"

import { createCapability } from "./control-channel"
import { LifecycleController } from "./lifecycle"
import { nodeProcessRunner } from "./process"
import { FileStateStore } from "./state-store"
import { runSyncBarrier } from "./sync-barrier"
import { captureWorkingTree } from "./working-tree"
import { createSandcastleSession, type SandcastleSessionFactory } from "./sandcastle-session"
import type { GitWorkingTreeObservation, SandboxRecord, SessionContext, WorkspaceInfo } from "./types"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("Sandcastle sync barrier", () => {
  it("runs the adapter sync-back hook after the barrier", async () => {
    const repository = await createRepository()
    const baseSha = await runGit(repository, ["rev-parse", "HEAD"])
    const calls: string[] = []
    const fake = createFakeProvider({
      onCommand(command) {
        if (command.trim() === "true") calls.push("barrier")
      },
    })
    const session = await createSandcastleSession({
      factory: {
        createAdapter: async () => ({
          provider: fake.provider,
          async applyCapture() {},
          target: () => ({ type: "remote", url: "https://fake.example.test" }),
          async syncBackWorkingTree() {
            calls.push("sync-back")
          },
        }),
      } satisfies SandcastleSessionFactory,
      context: { sessionId: "ses_sync_hook", projectId: "prj_sync_hook", directory: repository, worktree: repository },
      workspaceId: "wrk_sync_hook",
      generation: 1,
      branch: "opencode/sync-hook",
      baseSha,
    })

    try {
      await session.applyCapture({ baseSha, patch: "", untracked: [] })
      await session.sync()
    } finally {
      await session.close()
    }

    expect(calls).toEqual(["barrier", "sync-back"])
  })

  it("syncs out-of-band commits and dirty files through the public lifecycle", async () => {
    const repository = await createRepository()
    const fake = createFakeProvider()
    const branch = "opencode/sandcastle-sync"
    const worktree = await createWorktree({
      cwd: repository,
      branchStrategy: { type: "branch", branch },
    })
    const sandbox = await worktree.createSandbox({ sandbox: fake.provider })
    const remotePath = fake.handles[0]?.worktreePath
    if (!remotePath) throw new Error("fake provider did not create a handle")

    let preservedWorktreePath: string | undefined
    try {
      const streamed: string[] = []
      const streamResult = await sandbox.exec("printf 'first\\nsecond\\n'", {
        onLine: (line) => streamed.push(line),
      })
      expect(streamResult.exitCode).toBe(0)
      expect(streamed).toEqual(["first", "second"])

      await execSandbox(sandbox, "git config user.name 'Sandbox Test'")
      await execSandbox(sandbox, "git config user.email 'sandbox@example.invalid'")
      await execSandbox(sandbox, "printf 'committed\\n' > committed.txt && git add committed.txt && git commit -q -m committed")
      await execSandbox(sandbox, "printf 'staged\\n' > staged.txt && git add staged.txt")
      await execSandbox(sandbox, "printf 'unstaged\\n' > tracked.txt")
      await execSandbox(sandbox, "printf '\\000\\001\\002\\377' > binary.bin")
      await execSandbox(sandbox, "printf 'untracked\\n' > untracked.txt")

      const remoteHead = await runGit(remotePath, ["rev-parse", "HEAD"])
      const remoteStatus = await runGit(remotePath, ["status", "--porcelain"])
      const result = await runSyncBarrier(sandbox)

      expect(result.iterations).toHaveLength(1)
      expect(result.stdout).toBe("")
      expect(result.completionSignal).toBeUndefined()
      expect(result.commits).toHaveLength(1)
      expect(fake.handles[0]?.commands.some((command) => command.trim() === "true")).toBe(true)
      expect(fake.handles[0]?.commands.some((command) => /(^|\s)opencode(?:\s|$)/.test(command))).toBe(false)
      expect(await runGit(remotePath, ["rev-parse", "HEAD"])).toBe(remoteHead)
      expect(await runGit(remotePath, ["status", "--porcelain"])).toBe(remoteStatus)

      expect(await runGit(worktree.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(branch)
      expect(await readFile(join(worktree.worktreePath, "committed.txt"), "utf8")).toBe("committed\n")
      expect(await readFile(join(worktree.worktreePath, "staged.txt"), "utf8")).toBe("staged\n")
      expect(await readFile(join(worktree.worktreePath, "tracked.txt"), "utf8")).toBe("unstaged\n")
      expect(await readFile(join(worktree.worktreePath, "binary.bin"))).toEqual(Buffer.from([0, 1, 2, 255]))
      expect(await readFile(join(worktree.worktreePath, "untracked.txt"), "utf8")).toBe("untracked\n")

      const status = await runGit(worktree.worktreePath, ["status", "--porcelain"])
      expect(status).toContain(" M tracked.txt")
      expect(status).toContain("?? staged.txt")
      expect(status).toContain("?? untracked.txt")
      expect(await runGit(repository, ["rev-parse", "HEAD"])).not.toBe(await runGit(worktree.worktreePath, ["rev-parse", "HEAD"]))
      expect(await runGit(repository, ["status", "--porcelain"])).toBe("")
      expect(fake.handles[0]?.closed).toBe(false)
    } finally {
      await sandbox.close()
      preservedWorktreePath = (await worktree.close()).preservedWorktreePath
    }

    expect(fake.handles[0]?.closed).toBe(true)
    expect(preservedWorktreePath).toBe(worktree.worktreePath)
  })

  it("leaves recovery artifacts and the provider handle open when sync fails", async () => {
    const repository = await createRepository()
    const fake = createFakeProvider({ failCopyFileOut: true })
    const worktree = await createWorktree({
      cwd: repository,
      branchStrategy: { type: "branch", branch: "opencode/sandcastle-failure" },
    })
    const sandbox = await worktree.createSandbox({ sandbox: fake.provider })

    try {
      await execSandbox(sandbox, "git config user.name 'Sandbox Test'")
      await execSandbox(sandbox, "git config user.email 'sandbox@example.invalid'")
      await execSandbox(sandbox, "printf 'committed\\n' > committed.txt && git add committed.txt && git commit -q -m committed")

      await expect(runSyncBarrier(sandbox)).rejects.toThrow()

      expect(fake.handles[0]?.closed).toBe(false)
      const patchRoot = join(worktree.worktreePath, ".sandcastle", "patches")
      expect((await readdir(patchRoot)).length).toBeGreaterThan(0)
    } finally {
      await sandbox.close()
      await worktree.close()
    }
  })

  it("supports concurrent named worktree creation for the pinned package", async () => {
    // Keep this check before lifecycle integration; failures require local serialization.
    const repository = await createRepository()
    const results = await Promise.allSettled([
      createWorktree({
        cwd: repository,
        branchStrategy: { type: "branch", branch: "opencode/sandcastle-concurrent-a" },
      }),
      createWorktree({
        cwd: repository,
        branchStrategy: { type: "branch", branch: "opencode/sandcastle-concurrent-b" },
      }),
    ])

    for (const result of results) {
      if (result.status === "fulfilled") await result.value.close()
    }

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"])
    if (results[0]?.status === "fulfilled" && results[1]?.status === "fulfilled") {
      expect(results[0].value.worktreePath).not.toBe(results[1].value.worktreePath)
      expect(results[0].value.branch).not.toBe(results[1].value.branch)
    }
  })
})

describe("Sandcastle lifecycle", () => {
  it("removes the OpenCode workspace when start fails after creation", async () => {
    const setup = await setupFakeLifecycle({ workspaceMismatch: true })

    const result = await setup.controller.handle({ operation: "start", force: false, capability: setup.capability })

    expect(result).toMatchObject({ ok: false, state: "error", stage: "provision", error: { code: "WORKSPACE_IDENTITY" } })
    expect(result.message).toMatch(/requested owner/)
    expect(setup.calls).toContain("workspace:remove")
    expect(setup.resources.handle?.closed).toBe(true)
  })

  it("retains a Sandcastle session when start cleanup fails", async () => {
    const setup = await setupFakeLifecycle({ workspaceMismatch: true, closeFailures: 2 })

    await expect(setup.controller.handle({ operation: "start", force: false, capability: setup.capability })).resolves.toMatchObject({ ok: false })
    expect(setup.resources.handle?.closed).toBe(false)
    await expect(setup.controller.dispose()).resolves.toBeUndefined()
    expect(setup.resources.handle?.closed).toBe(true)
  })

  it("does not supersede a failed stop, delete, or recover with direct Sandcastle start", async () => {
    const captureCalls: string[] = []
    const setup = await setupFakeLifecycle({ captureCalls })
    const timestamp = new Date(1000).toISOString()

    for (const kind of ["stop", "delete", "recover"] as const) {
      const record: SandboxRecord = {
        sessionId: "ses_1",
        workspaceId: "wrk_failed",
        projectId: "prj_1",
        provider: "fake",
        providerState: { resourceId: "fake-ses_1" },
        generation: 7,
        directory: setup.repository,
        branch: "opencode/failed-start",
        baseSha: setup.sourceHead,
        preservedWorktreePath: join(setup.repository, "preserved-worktree"),
        state: "error",
        operation: { kind, phase: kind === "recover" ? "adopt_failed" : "awaiting_idle" },
        createdAt: timestamp,
        updatedAt: timestamp,
        lastError: { code: `${kind.toUpperCase()}_FAILED`, stage: "remove", message: `${kind} failed` },
      }
      await setup.store.write(record)
      const before = await setup.store.get(record.sessionId)

      const result = await setup.controller.handle({
        operation: "start",
        force: false,
        capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" }),
      })

      expect(result).toMatchObject({ ok: false, operation: "start", stage: "transition", error: { code: "SESSION_ERROR" } })
      const after = await setup.store.get(record.sessionId)
      expect(after?.journal).toHaveLength(1)
      expect(JSON.stringify({ ...after, journal: undefined })).toBe(JSON.stringify({ ...before, journal: undefined }))
      expect(setup.calls).toEqual([])
      expect(captureCalls).toEqual([])
    }
  })

  it("allows an authorized retry of a failed Sandcastle start", async () => {
    const options = { workspaceMismatch: true, captureCalls: [] as string[] }
    const setup = await setupFakeLifecycle(options)

    try {
      await expect(setup.controller.handle({ operation: "start", force: false, capability: setup.capability })).resolves.toMatchObject({
        ok: false,
        state: "error",
      })
      const failed = await setup.store.get("ses_1")
      if (!failed) throw new Error("failed start record was not written")

      options.workspaceMismatch = false
      await expect(setup.controller.handle({ operation: "retry", force: false, capability: setup.capability })).resolves.toMatchObject({
        ok: true,
        operation: "start",
        state: "activation_pending",
      })

      const retried = await setup.store.get("ses_1")
      expect(retried).toMatchObject({
        generation: failed.generation + 1,
        operation: { kind: "start", phase: "awaiting_idle" },
      })
      expect(retried?.lastError).toBeUndefined()
      expect(options.captureCalls).toHaveLength(2)
      expect(setup.calls.filter((call) => call === "worktree:create")).toHaveLength(2)
      expect(setup.calls.filter((call) => call === "workspace:create")).toHaveLength(2)
    } finally {
      await setup.controller.dispose()
    }
  })

  it("starts from dirty input, waits to warp, and stops into a clean branch", async () => {
    const setup = await setupFakeLifecycle()
    const { controller, capability, calls, repository, resources } = setup

    const started = await controller.handle({ operation: "start", force: false, capability })
    expect(started).toMatchObject({ ok: true, operation: "start", state: "activation_pending" })
    const activationTarget = controller.targetFor("ses_1")
    expect(activationTarget).toBeInstanceOf(Promise)
    expect(controller.targetForWorkspace(started.workspaceId ?? "")).toBeInstanceOf(Promise)
    expect(calls).toEqual(["worktree:create", "sandbox:create", "capture", "workspace:create"])
    expect(await runGit(repository, ["rev-parse", "HEAD"])).toBe(setup.sourceHead)
    expect(await runGit(repository, ["status", "--porcelain"])).toBe(setup.sourceStatus)
    const handle = resources.handle
    if (!handle) throw new Error("fake provider handle was not retained")
    expect(await readFile(join(handle.worktreePath, "tracked.txt"), "utf8")).toBe("unstaged input\n")
    expect(await readFile(join(handle.worktreePath, "staged.txt"), "utf8")).toBe("staged input\n")
    expect(await readFile(join(handle.worktreePath, "binary.bin"))).toEqual(Buffer.from([0, 1, 2, 255]))
    expect(await readFile(join(handle.worktreePath, "untracked.txt"), "utf8")).toBe("untracked input\n")
    expect(await pathExists(join(handle.worktreePath, "deleted.txt"))).toBe(false)

    await controller.onSessionIdle("ses_1")
    expect((await setup.store.get("ses_1"))?.state).toBe("remote")
    expect(await activationTarget).toEqual({ type: "remote", url: "https://fake.example.test" })
    expect(await controller.targetFor("ses_1")).toEqual({ type: "remote", url: "https://fake.example.test" })
    expect(calls).toContain("warp:remote")
    expect(calls).toContain("replay")
    expect(calls).not.toContain("sync")

    const callsBeforeIdle = [...calls]
    await controller.onSessionIdle("ses_1")
    expect(calls).toEqual(callsBeforeIdle)

    const sandbox = resources.sandbox
    if (!sandbox) throw new Error("fake sandbox was not created")
    await execSandbox(sandbox, "git config user.name 'Sandbox Test' && git config user.email 'sandbox@example.invalid' && git add -A && printf 'implementation\\n' > implementation.txt && git add implementation.txt && git commit -q -m implementation")

    const stopped = await controller.handle({ operation: "stop", force: false, capability })
    expect(stopped).toMatchObject({ ok: true, operation: "stop", state: "stop_pending" })
    const detachTarget = controller.targetFor("ses_1")
    expect(detachTarget).toBeInstanceOf(Promise)
    expect(calls).not.toContain("warp:local")

    await controller.onSessionIdle("ses_1")
    const record = await setup.store.get("ses_1")
    expect(record?.state).toBe("detached")
    expect(await detachTarget).toEqual({ type: "local", directory: repository })
    expect(record?.preservedWorktreePath).toBeUndefined()
    expect((await controller.handle({ operation: "status", force: false, capability })).details).toMatchObject({
      branch: record?.branch,
      provider: "fake",
    })
    expect(await runGit(repository, ["show-ref", "--verify", `refs/heads/${record?.branch}`])).toContain(record?.branch ?? "")
    expect(await pathExists(resources.worktreePath)).toBe(false)
    expect(calls.indexOf("sync")).toBeGreaterThan(calls.indexOf("warp:remote"))
    expect(calls.indexOf("warp:local")).toBeGreaterThan(calls.indexOf("sync"))
    expect(calls.indexOf("sandbox:close")).toBeGreaterThan(calls.indexOf("warp:local"))
    expect(calls.indexOf("worktree:close")).toBeGreaterThan(calls.indexOf("sandbox:close"))
    expect(calls.indexOf("workspace:remove")).toBeGreaterThan(calls.indexOf("worktree:close"))
    expect(await runGit(repository, ["rev-parse", "HEAD"])).toBe(setup.sourceHead)
    expect(await runGit(repository, ["status", "--porcelain"])).toBe(setup.sourceStatus)

    const deleted = await controller.handle({ operation: "delete", force: true, capability })
    expect(deleted).toMatchObject({ ok: true, operation: "delete", state: "deleted" })
    expect(calls.filter((call) => call === "workspace:remove")).toHaveLength(2)
  })

  it("preserves and closes an attached runtime before normal deletion", async () => {
    const setup = await setupFakeLifecycle()
    const { controller, capability, calls, resources, store } = setup

    await controller.handle({ operation: "start", force: false, capability })
    await controller.onSessionIdle("ses_1")
    if (!resources.sandbox) throw new Error("fake sandbox was not created")
    await execSandbox(resources.sandbox, "printf 'delete me\n' > remote-delete.txt")
    const branch = (await store.get("ses_1"))?.branch
    if (!branch) throw new Error("sandbox branch was not recorded")

    await expect(controller.handle({ operation: "delete", force: false, capability })).resolves.toMatchObject({
      ok: true,
      state: "delete_pending",
    })
    await controller.onSessionIdle("ses_1")

    expect(await store.get("ses_1")).toMatchObject({ state: "deleted" })
    expect(resources.handle?.closed).toBe(true)
    expect(calls).toContain("sync")
    expect(calls).toContain("workspace:remove")
    expect(await runGit(setup.repository, ["show", `${branch}:remote-delete.txt`])).toBe("delete me")
  })

  it("commits dirty output before removing the Sandcastle worktree", async () => {
    const setup = await setupFakeLifecycle()
    const { controller, capability, repository, resources } = setup

    await controller.handle({ operation: "start", force: false, capability })
    await controller.onSessionIdle("ses_1")
    const sandbox = resources.sandbox
    if (!sandbox) throw new Error("fake sandbox was not created")
    await execSandbox(sandbox, "printf 'unfinished\\n' > unfinished.txt")
    await controller.handle({ operation: "stop", force: false, capability })
    await controller.onSessionIdle("ses_1")

    const record = await setup.store.get("ses_1")
    const worktreePath = resources.worktreePath
    if (!worktreePath) throw new Error("fake worktree was not created")
    expect(record?.state).toBe("detached")
    expect(record?.preservedWorktreePath).toBeUndefined()
    expect(await pathExists(worktreePath)).toBe(false)
    expect(await runGit(repository, ["show", `${record?.branch}:unfinished.txt`])).toBe("unfinished")
    expect((await controller.handle({ operation: "status", force: false, capability })).details).toMatchObject({
      branch: record?.branch,
    })
    expect(await runGit(repository, ["rev-parse", "HEAD"])).toBe(setup.sourceHead)
    expect(await runGit(repository, ["status", "--porcelain"])).toBe(setup.sourceStatus)
  })

  it("keeps a failed sync retryable without reprovisioning", async () => {
    const setup = await setupFakeLifecycle({ syncFailures: 1 })
    const { controller, capability, calls, resources } = setup

    await controller.handle({ operation: "start", force: false, capability })
    await controller.onSessionIdle("ses_1")
    const sandbox = resources.sandbox
    if (!sandbox) throw new Error("fake sandbox was not created")
    await execSandbox(sandbox, "printf 'retry me\\n' > retry.txt")

    await controller.handle({ operation: "stop", force: false, capability })
    await controller.onSessionIdle("ses_1")

    const failed = await setup.store.get("ses_1")
    expect(failed).toMatchObject({ state: "sync_failed", lastError: { stage: "sync" } })
    expect(resources.handle?.closed).toBe(false)
    expect(calls.filter((call) => call === "worktree:create")).toHaveLength(1)
    expect(calls).not.toContain("warp:local")

    const retried = await controller.handle({ operation: "retry", force: false, capability })

    expect(retried).toMatchObject({ ok: true, operation: "retry", state: "detached" })
    expect(calls.filter((call) => call === "worktree:create")).toHaveLength(1)
    expect(calls.filter((call) => call === "sandbox:create")).toHaveLength(1)
    expect(calls.filter((call) => call === "sync")).toHaveLength(2)
    expect(resources.handle?.closed).toBe(true)
  })

  it("persists the preserved worktree when stop cleanup fails", async () => {
    const setup = await setupFakeLifecycle({ closeFailures: 2 })
    await setup.controller.handle({ operation: "start", force: false, capability: setup.capability })
    await setup.controller.onSessionIdle("ses_1")
    if (!setup.resources.sandbox || !setup.resources.worktreePath) throw new Error("fake Sandcastle resources were not created")
    await writeFile(join(setup.resources.worktreePath, "preserve.txt"), "preserve me\n")

    await setup.controller.handle({ operation: "stop", force: false, capability: setup.capability })
    await setup.controller.onSessionIdle("ses_1")

    expect(await setup.store.get("ses_1")).toMatchObject({
      state: "error",
      preservedWorktreePath: setup.resources.worktreePath,
    })
  })

  it("keeps the preserved worktree when workspace removal fails after close", async () => {
    const setup = await setupFakeLifecycle({ workspaceRemoveFailures: 1 })
    await setup.controller.handle({ operation: "start", force: false, capability: setup.capability })
    await setup.controller.onSessionIdle("ses_1")
    if (!setup.resources.worktreePath) throw new Error("fake worktree was not created")
    await writeFile(join(setup.resources.worktreePath, "preserve.txt"), "preserve me\n")

    await setup.controller.handle({ operation: "stop", force: false, capability: setup.capability })
    await setup.controller.onSessionIdle("ses_1")

    expect(await setup.store.get("ses_1")).toMatchObject({
      state: "error",
      preservedWorktreePath: setup.resources.worktreePath,
    })
  })

  it("persists the preserved worktree when disposal closes a dirty session", async () => {
    const setup = await setupFakeLifecycle()
    await setup.controller.handle({ operation: "start", force: false, capability: setup.capability })
    await setup.controller.onSessionIdle("ses_1")
    if (!setup.resources.sandbox || !setup.resources.worktreePath) throw new Error("fake Sandcastle resources were not created")
    await writeFile(join(setup.resources.worktreePath, "preserve.txt"), "preserve me\n")

    await setup.controller.dispose()

    expect(await setup.store.get("ses_1")).toMatchObject({ preservedWorktreePath: setup.resources.worktreePath })
  })

  it("requires explicit host force before discarding a failed sync", async () => {
    const setup = await setupFakeLifecycle({ syncFailures: Number.POSITIVE_INFINITY })
    const { controller, capability, calls, resources } = setup

    await controller.handle({ operation: "start", force: false, capability })
    await controller.onSessionIdle("ses_1")
    const sandbox = resources.sandbox
    if (!sandbox) throw new Error("fake sandbox was not created")
    await execSandbox(sandbox, "printf 'discard me\\n' > discard.txt")
    await controller.handle({ operation: "stop", force: false, capability })
    await controller.onSessionIdle("ses_1")

    const refused = await controller.handle({ operation: "delete", force: false, capability })
    expect(refused).toMatchObject({ ok: false, state: "sync_failed" })
    expect(resources.handle?.closed).toBe(false)

    const remoteCapability = createCapability({ sessionId: "ses_1", generation: 1, role: "remote" })
    const remoteRefused = await controller.handle({ operation: "delete", force: true, capability: remoteCapability })
    expect(remoteRefused).toMatchObject({ ok: false, state: "sync_failed" })
    expect(resources.handle?.closed).toBe(false)

    const discarded = await controller.handle({ operation: "delete", force: true, capability })
    expect(discarded).toMatchObject({ ok: true, operation: "delete", state: "deleted" })
    expect(calls.filter((call) => call === "sync")).toHaveLength(1)
    expect(resources.handle?.closed).toBe(true)
  })

  it("does not replace a Sandcastle workspace while delete is pending", async () => {
    const setup = await setupFakeLifecycle()
    await setup.controller.handle({ operation: "start", force: false, capability: setup.capability })
    await setup.controller.onSessionIdle("ses_1")
    await setup.controller.handle({ operation: "delete", force: false, capability: setup.capability })

    const restarted = await setup.controller.handle({ operation: "start", force: false, capability: setup.capability })

    expect(restarted).toMatchObject({ ok: false, state: "delete_pending", stage: "transition" })
    expect(setup.calls.filter((call) => call === "worktree:create")).toHaveLength(1)
    await setup.controller.onSessionIdle("ses_1")
    expect(await setup.store.get("ses_1")).toMatchObject({ state: "deleted" })
  })

  it("reports an attached runtime and its structured stop action", async () => {
    const setup = await setupFakeLifecycle()
    try {
      await setup.controller.handle({ operation: "start", force: false, capability: setup.capability })
      await setup.controller.onSessionIdle("ses_1")

      const result = await setup.controller.handle({ operation: "inspect", force: false, capability: setup.capability })

      expect(result).toMatchObject({
        schemaVersion: 2,
        operation: "inspect",
        classification: "attached",
        effectiveTarget: { kind: "remote", resourceId: "fake-ses_1" },
        recommendedAction: { operation: "stop", reasonCode: "ATTACHED_RUNTIME" },
      })
      expect(result.allowedActions).toContainEqual(expect.objectContaining({ operation: "stop", waitFor: "session_idle" }))
    } finally {
      await setup.controller.dispose()
    }
  })

  it("inspects the live Sandcastle worktree and reports its observed HEAD", async () => {
    let inspectedPath = ""
    const runtimeHead = "abcdefabcdefabcdefabcdefabcdefabcdefabcd"
    const setup = await setupFakeLifecycle({
      gitInspect: async (_record, worktreePath) => {
        inspectedPath = worktreePath
        return { head: runtimeHead, branch: "opencode/runtime", dirty: true, evidence: ["fixture"] }
      },
    })
    try {
      await setup.controller.handle({ operation: "start", force: false, capability: setup.capability })
      await setup.controller.onSessionIdle("ses_1")

      const result = await setup.controller.handle({ operation: "inspect", force: false, capability: setup.capability })

      if (!setup.resources.worktreePath) throw new Error("live worktree path was not recorded")
      expect(inspectedPath).toBe(setup.resources.worktreePath)
      expect(result.work).toMatchObject({ runtimeHead, sync: "dirty" })
    } finally {
      await setup.controller.dispose()
    }
  })

  it("does not guess an orphan from a missing restart handle", async () => {
    const setup = await setupFakeLifecycle()
    const record = {
      sessionId: "ses_1",
      workspaceId: "wrk_orphaned",
      projectId: "prj_1",
      provider: "fake",
      providerState: { resourceId: "sandbox-1" },
      generation: 1,
      directory: setup.repository,
      branch: "opencode/sandbox-orphaned",
      baseSha: setup.sourceHead,
      state: "remote" as const,
      createdAt: new Date(1000).toISOString(),
      updatedAt: new Date(1000).toISOString(),
    }
    await setup.store.write(record)

    let provisioned = false
    const restarted = new LifecycleController({
      store: setup.store,
      providerType: "fake",
      sandcastle: {
        createAdapter: async () => {
          provisioned = true
          throw new Error("must not reprovision an orphan")
        },
      },
      workspace: {
        async create() {
          throw new Error("must not create a workspace")
        },
        async warp() {
          throw new Error("must not warp an orphan")
        },
        async remove() {
          throw new Error("must not remove an orphan")
        },
      },
    })

    await restarted.reconcile("prj_1")

    expect(provisioned).toBe(false)
    expect(await setup.store.get("ses_1")).toMatchObject({ state: "remote" })
    expect((await setup.store.get("ses_1"))?.lastError).toBeUndefined()
    const inspection = await restarted.handle({
      operation: "inspect",
      force: false,
      capability: createCapability({ sessionId: "ses_1", generation: 1, role: "host" }),
    })
    expect(inspection).toMatchObject({
      classification: "control_lost",
      recommendedAction: { operation: "inspect", reasonCode: "RESOURCE_STATE_UNKNOWN" },
    })
    expect(inspection.allowedActions?.some((action) => action.operation === "recover")).toBe(false)
    const status = await restarted.handle({
      operation: "status",
      force: false,
      capability: createCapability({ sessionId: "ses_1", generation: 1, role: "host" }),
    })
    expect(status).toMatchObject({ state: "remote" })
    expect(status.details).toMatchObject({
      branch: record.branch,
      provider: "fake",
      recoveryMetadata: { resourceId: "sandbox-1" },
    })
    expect(JSON.stringify(status)).not.toContain("token")
  })

  it("does not mark a pending deletion complete without its runtime handle", async () => {
    const setup = await setupFakeLifecycle()
    await setup.store.write({
      sessionId: "ses_1",
      workspaceId: "wrk_missing_handle",
      projectId: "prj_1",
      provider: "fake",
      providerState: {},
      generation: 1,
      directory: setup.repository,
      branch: "opencode/sandbox-missing-handle",
      baseSha: setup.sourceHead,
      state: "delete_pending",
      operation: { kind: "delete", phase: "awaiting_idle" },
      createdAt: new Date(1000).toISOString(),
      updatedAt: new Date(1000).toISOString(),
    })
    const calls: string[] = []
    const restarted = new LifecycleController({
      store: setup.store,
      providerType: "fake",
      sandcastle: { createAdapter: async () => { throw new Error("must not create") } },
      workspace: {
        async create() { throw new Error("must not create a workspace") },
        async warp() { calls.push("warp") },
        async remove() { calls.push("remove") },
      },
    })

    await restarted.onSessionIdle("ses_1")

    expect(await setup.store.get("ses_1")).toMatchObject({ state: "error", lastError: { code: "SANDCASTLE_HANDLE" } })
    expect(calls).toEqual([])
  })

  it("awaits idempotent disposal and closes every owned session", async () => {
    const setup = await setupParallelFakeLifecycle()
    const capabilityA = createCapability({ sessionId: "ses_a", generation: 1, role: "host" })
    const capabilityB = createCapability({ sessionId: "ses_b", generation: 1, role: "host" })
    await Promise.all([
      setup.controller.handle({ operation: "start", force: false, capability: capabilityA }),
      setup.controller.handle({ operation: "start", force: false, capability: capabilityB }),
    ])

    const targetA = setup.controller.targetFor("ses_a")
    const first = setup.controller.dispose()
    const second = setup.controller.dispose()

    expect(second).toBe(first)
    await first
    await expect(targetA).rejects.toMatchObject({ code: "PLUGIN_DISPOSED" })
    expect(setup.resources.get("ses_a")?.handle?.closed).toBe(true)
    expect(setup.resources.get("ses_b")?.handle?.closed).toBe(true)
    expect(setup.controller.targetFor("ses_a")).toBeUndefined()
    expect(setup.controller.targetFor("ses_b")).toBeUndefined()
  })

  it("cancels scheduled idle work during disposal", async () => {
    const setup = await setupFakeLifecycle()
    await setup.controller.handle({ operation: "start", force: false, capability: setup.capability })
    setup.controller.scheduleSessionIdle("ses_1")

    await setup.controller.dispose()
    await new Promise((resolve) => setTimeout(resolve, 550))

    expect(setup.calls).not.toContain("warp:remote")
    expect(setup.calls).not.toContain("replay")
    expect(setup.resources.handle?.closed).toBe(true)
  })

  it("retains a failed session so disposal can retry it", async () => {
    const setup = await setupFakeLifecycle({ closeFailures: 2 })
    await setup.controller.handle({ operation: "start", force: false, capability: setup.capability })

    await expect(setup.controller.dispose()).rejects.toThrow("fake close failure")
    expect(setup.calls).toContain("worktree:close")
    expect(setup.resources.handle?.closed).toBe(false)

    await expect(setup.controller.dispose()).resolves.toBeUndefined()
    expect(setup.resources.handle?.closed).toBe(true)
  })

  it("keeps parallel session ownership isolated", async () => {
    const setup = await setupParallelFakeLifecycle()
    const capabilityA = createCapability({ sessionId: "ses_a", generation: 1, role: "host" })
    const capabilityB = createCapability({ sessionId: "ses_b", generation: 1, role: "host" })

    const [startedA, startedB] = await Promise.all([
      setup.controller.handle({ operation: "start", force: false, capability: capabilityA }),
      setup.controller.handle({ operation: "start", force: false, capability: capabilityB }),
    ])
    expect(startedA).toMatchObject({ ok: true, state: "activation_pending" })
    expect(startedB).toMatchObject({ ok: true, state: "activation_pending" })
    expect(startedA.workspaceId).not.toBe(startedB.workspaceId)

    const recordA = await setup.store.get("ses_a")
    const recordB = await setup.store.get("ses_b")
    expect(recordA?.branch).not.toBe(recordB?.branch)
    expect(setup.resources.get("ses_a")?.worktreePath).not.toBe(setup.resources.get("ses_b")?.worktreePath)
    expect(setup.controller.targetFor("ses_a")).toBeInstanceOf(Promise)
    expect(setup.controller.targetFor("ses_b")).toBeInstanceOf(Promise)

    await Promise.all([setup.controller.onSessionIdle("ses_a"), setup.controller.onSessionIdle("ses_b")])
    expect((await setup.store.get("ses_a"))?.state).toBe("remote")
    expect((await setup.store.get("ses_b"))?.state).toBe("remote")
    expect(await setup.controller.targetFor("ses_a")).toEqual({ type: "remote", url: "https://fake-ses_a.example.test" })
    expect(await setup.controller.targetFor("ses_b")).toEqual({ type: "remote", url: "https://fake-ses_b.example.test" })

    const sandboxA = setup.resources.get("ses_a")?.sandbox
    const sandboxB = setup.resources.get("ses_b")?.sandbox
    if (!sandboxA || !sandboxB) throw new Error("parallel fake sandboxes were not created")
    await execSandbox(sandboxA, "printf 'session a\\n' > session-a.txt")
    await execSandbox(sandboxB, "printf 'session b\\n' > session-b.txt")

    await setup.controller.handle({ operation: "stop", force: false, capability: capabilityA })
    await setup.controller.onSessionIdle("ses_a")
    expect((await setup.store.get("ses_a"))?.state).toBe("detached")
    expect((await setup.store.get("ses_b"))?.state).toBe("remote")
    expect(setup.resources.get("ses_a")?.handle?.closed).toBe(true)
    expect(setup.resources.get("ses_b")?.handle?.closed).toBe(false)

    const statusB = await setup.controller.handle({ operation: "status", force: false, capability: capabilityB })
    expect(statusB).toMatchObject({ ok: true, state: "remote", sessionId: "ses_b" })

    await setup.controller.handle({ operation: "stop", force: false, capability: capabilityB })
    await setup.controller.onSessionIdle("ses_b")
    expect((await setup.store.get("ses_b"))?.state).toBe("detached")
    expect(setup.resources.get("ses_b")?.handle?.closed).toBe(true)
  })
})

interface FakeLifecycleSetup {
  controller: LifecycleController
  capability: ReturnType<typeof createCapability>
  repository: string
  store: FileStateStore
  calls: string[]
  resources: FakeSessionResources
  sourceHead: string
  sourceStatus: string
}

interface FakeSessionResources {
  sandbox?: Sandbox
  handle?: FakeHandle
  worktreePath?: string
}

async function setupFakeLifecycle(options: {
  syncFailures?: number
  workspaceMismatch?: boolean
  workspaceRemoveFailures?: number
  closeFailures?: number
  captureCalls?: string[]
  gitInspect?: (record: SandboxRecord, worktreePath: string) => Promise<GitWorkingTreeObservation>
} = {}): Promise<FakeLifecycleSetup> {
  const repository = await createRepository()
  await writeFile(join(repository, "deleted.txt"), "delete me\n")
  await runGit(repository, ["add", "deleted.txt"])
  await runGit(repository, ["commit", "-q", "-m", "deletion fixture"])
  await writeFile(join(repository, "tracked.txt"), "unstaged input\n")
  await writeFile(join(repository, "staged.txt"), "staged input\n")
  await runGit(repository, ["add", "staged.txt"])
  await rm(join(repository, "deleted.txt"))
  await writeFile(join(repository, "binary.bin"), Buffer.from([0, 1, 2, 255]))
  await writeFile(join(repository, "untracked.txt"), "untracked input\n")

  const sourceHead = await runGit(repository, ["rev-parse", "HEAD"])
  const sourceStatus = await runGit(repository, ["status", "--porcelain"])
  const stateRoot = await temporaryDirectory()
  const store = new FileStateStore(stateRoot)
  const calls: string[] = []
  const resources: FakeSessionResources = {}
  let workspaceInfo: WorkspaceInfo | undefined
  const context: SessionContext = {
    sessionId: "ses_1",
    projectId: "prj_1",
    directory: repository,
    worktree: repository,
  }
  const controller = new LifecycleController({
    store,
    capture: (value) => {
      options.captureCalls?.push("capture")
      return captureWorkingTree(value)
    },
    providerType: "fake",
    sandcastle: createFakeSessionFactory(calls, resources, options),
    gitInspect: options.gitInspect,
    workspace: {
      async create(input) {
        calls.push("workspace:create")
        workspaceInfo = {
          id: options.workspaceMismatch ? "wrk_wrong" : input.id ?? "wrk_1",
          type: input.type,
          name: "fake-workspace",
          branch: input.branch,
          directory: input.directory,
          projectID: input.projectId,
          extra: {
            owner: "opencode-sandbox",
            sessionId: context.sessionId,
            generation: 1,
            workspaceId: input.id ?? "wrk_1",
            projectId: input.projectId,
            provider: input.type,
          },
        }
        return workspaceInfo
      },
      async warp(input) {
        calls.push(input.workspaceId ? "warp:remote" : "warp:local")
      },
      async replaySession() {
        calls.push("replay")
      },
      async startSync() {
        calls.push("sync:start")
      },
      async waitForSync() {
        calls.push("sync:connected")
      },
      async remove() {
        calls.push("workspace:remove")
        if ((options.workspaceRemoveFailures ?? 0) > 0) {
          options.workspaceRemoveFailures = (options.workspaceRemoveFailures ?? 0) - 1
          throw new Error("fake workspace removal failure")
        }
        workspaceInfo = undefined
      },
      async inspect() {
        return workspaceInfo
      },
    },
  })
  controller.registerContext(context)

  return {
    controller,
    capability: createCapability({ sessionId: context.sessionId, generation: 1, role: "host" }),
    repository,
    store,
    calls,
    resources,
    sourceHead,
    sourceStatus,
  }
}

interface ParallelFakeLifecycleSetup {
  controller: LifecycleController
  store: FileStateStore
  resources: Map<string, FakeSessionResources & { branch: string }>
}

async function setupParallelFakeLifecycle(): Promise<ParallelFakeLifecycleSetup> {
  const repository = await createRepository()
  const store = new FileStateStore(await temporaryDirectory())
  const resources = new Map<string, FakeSessionResources & { branch: string }>()
  const controller = new LifecycleController({
    store,
    capture: (context) => captureWorkingTree(context),
    providerType: "fake",
    sandcastle: {
      createAdapter: async (input) => {
        const fake = createFakeProvider()
        const resource: FakeSessionResources & { branch: string } = { branch: input.branch }
        resources.set(input.sessionId, resource)
        return {
          provider: fake.provider,
          async inspect() {
            return {
              resourceId: `fake-${input.sessionId}`,
              resource: "present",
              ownership: "verified",
              health: "healthy",
              evidence: ["fake provider inventory"],
            }
          },
          async applyCapture({ sandbox, capture }) {
            resource.sandbox = sandbox
            const handle = fake.handles.at(-1)
            if (!handle) throw new Error("fake provider did not create a handle")
            resource.handle = handle
            if (capture.patch) {
              const result = await sandbox.exec("git apply --binary -", { stdin: capture.patch })
              if (result.exitCode !== 0) throw new Error(result.stderr || "capture patch failed")
            }
          },
          target() {
            return { type: "remote", url: `https://fake-${input.sessionId}.example.test` }
          },
          async close() {
            await resource.handle?.close()
          },
        }
      },
      async createWorktree(options) {
        const worktree = await createWorktree(options)
        const branch = options.branchStrategy.type === "branch" ? options.branchStrategy.branch : undefined
        const resource = [...resources.values()].find((candidate) => candidate.branch === branch)
        if (resource) resource.worktreePath = worktree.worktreePath
        return worktree
      },
    },
    workspace: {
      async create(input) {
        return {
          id: input.id ?? "wrk_missing",
          type: input.type,
          name: input.type,
          branch: input.branch,
          directory: input.directory,
          projectID: input.projectId,
          extra: {},
        }
      },
      async warp() {},
      async replaySession() {},
      async startSync() {},
      async waitForSync() {},
      async remove() {},
    },
  })
  for (const sessionId of ["ses_a", "ses_b"]) {
    controller.registerContext({ sessionId, projectId: "prj_1", directory: repository, worktree: repository })
  }
  return { controller, store, resources }
}

function createFakeSessionFactory(calls: string[], resources: FakeSessionResources, options: { syncFailures?: number; closeFailures?: number } = {}): SandcastleSessionFactory {
  const fake = createFakeProvider({
    failCopyFileOutCount: options.syncFailures,
    closeFailures: options.closeFailures,
    onCommand(command) {
      if (command.trim() === "true") calls.push("sync")
    },
  })
  return {
    createAdapter: async (input) => ({
      provider: fake.provider,
      async applyCapture({ sandbox, capture }) {
        calls.push("capture")
        if (capture.patch) {
          const result = await sandbox.exec("git apply --binary -", { stdin: capture.patch })
          if (result.exitCode !== 0) throw new Error(result.stderr || "capture patch failed")
        }
        const handle = fake.handles.at(-1)
        if (!handle) throw new Error("fake provider did not create a handle")
        resources.handle = handle
        for (const file of capture.untracked) {
          const root = await mkdtemp(join(tmpdir(), "opencode-capture-"))
          temporaryDirectories.push(root)
          const hostPath = join(root, file.path)
          await mkdir(dirname(hostPath), { recursive: true })
          await writeFile(hostPath, file.content)
          await handle.copyIn(hostPath, join(handle.worktreePath, file.path))
        }
      },
      target() {
        if (!fake.handles.at(-1)) throw new Error("fake provider did not create a handle")
        return { type: "remote", url: "https://fake.example.test" }
      },
      async inspect() {
        return {
          resourceId: `fake-${input.sessionId}`,
          resource: "present",
          ownership: "verified",
          health: "healthy",
          evidence: ["fake provider inventory"],
        }
      },
      async close() {
        await fake.handles.at(-1)?.close()
      },
      recoveryMetadata: () => ({ runtime: "fake" }),
    }),
    async createWorktree(options) {
      calls.push("worktree:create")
      const worktree = await createWorktree(options)
      resources.worktreePath = worktree.worktreePath
      return instrumentWorktree(worktree, calls, resources)
    },
  }
}

function instrumentWorktree(worktree: Worktree, calls: string[], resources: FakeSessionResources): Worktree {
  return {
    ...worktree,
    async createSandbox(options) {
      const sandbox = await worktree.createSandbox(options)
      resources.sandbox = sandbox
      calls.push("sandbox:create")
      return {
        ...sandbox,
        async close() {
          calls.push("sandbox:close")
          return sandbox.close()
        },
      }
    },
    async close() {
      calls.push("worktree:close")
      return worktree.close()
    },
  }
}

async function pathExists(path: string | undefined): Promise<boolean> {
  if (!path) return false
  try {
    await readdir(path)
    return true
  } catch {
    return false
  }
}

interface FakeHandle extends IsolatedSandboxHandle {
  closed: boolean
  commands: string[]
}

function createFakeProvider(options: { failCopyFileOut?: boolean; failCopyFileOutCount?: number; closeFailures?: number; onCommand?: (command: string) => void } = {}) {
  const handles: FakeHandle[] = []
  const provider = createIsolatedSandboxProvider({
    name: "fake-isolated",
    create: async () => {
      const root = await mkdtemp(join(tmpdir(), "opencode-sandcastle-test-"))
      temporaryDirectories.push(root)
      const worktreePath = join(root, "workspace")
      const homePath = join(root, "home")
      await mkdir(worktreePath)
      await mkdir(homePath)
      const environment = {
        ...process.env,
        HOME: homePath,
        GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
      }
      const handle: FakeHandle = {
        worktreePath,
        closed: false,
        commands: [],
        exec: (command, execOptions) => {
          handle.commands.push(command)
          options.onCommand?.(command)
          return execute(command, worktreePath, environment, execOptions)
        },
        async copyIn(hostPath, sandboxPath) {
          await mkdir(dirname(sandboxPath), { recursive: true })
          await cp(hostPath, sandboxPath, { recursive: true })
        },
        async copyFileOut(sandboxPath, hostPath) {
          if (options.failCopyFileOut || (options.failCopyFileOutCount ?? 0) > 0) {
            if (options.failCopyFileOutCount !== undefined) options.failCopyFileOutCount--
            throw new Error("fake copy failure")
          }
          await mkdir(dirname(hostPath), { recursive: true })
          await copyFile(sandboxPath, hostPath)
        },
        async close() {
          if ((options.closeFailures ?? 0) > 0) {
            options.closeFailures = (options.closeFailures ?? 0) - 1
            throw new Error("fake close failure")
          }
          handle.closed = true
          await rm(root, { recursive: true, force: true })
        },
      }
      handles.push(handle)
      return handle
    },
  })

  return { provider, handles }
}

async function createRepository(): Promise<string> {
  const repository = await temporaryDirectory()
  await runGit(repository, ["init", "-q"])
  await runGit(repository, ["config", "user.name", "Repository Test"])
  await runGit(repository, ["config", "user.email", "repository@example.invalid"])
  await writeFile(join(repository, ".gitignore"), ".sandcastle/\n")
  await writeFile(join(repository, "tracked.txt"), "base\n")
  await runGit(repository, ["add", "."])
  await runGit(repository, ["commit", "-q", "-m", "initial"])
  return repository
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-sandcastle-repo-"))
  temporaryDirectories.push(directory)
  return directory
}

async function execSandbox(sandbox: { exec(command: string): Promise<{ exitCode: number; stderr: string }> }, command: string): Promise<void> {
  const result = await sandbox.exec(command)
  if (result.exitCode !== 0) throw new Error(result.stderr || `sandbox command failed: ${command}`)
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await nodeProcessRunner.run({ argv: ["git", "-C", cwd, ...args], cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args[0]} failed`)
  return result.stdout.trimEnd()
}

async function execute(
  command: string,
  defaultCwd: string,
  environment: NodeJS.ProcessEnv,
  options: { onLine?: (line: string) => void; cwd?: string; stdin?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = spawn("/bin/sh", ["-c", command], {
    cwd: options.cwd ?? defaultCwd,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  })

  let stdout = ""
  let stderr = ""
  let pendingLine = ""
  const emitLines = (chunk: Buffer) => {
    if (!options.onLine) return
    pendingLine += chunk.toString("utf8")
    const lines = pendingLine.split("\n")
    pendingLine = lines.pop() ?? ""
    for (const line of lines) options.onLine(line.replace(/\r$/, ""))
  }

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8")
    emitLines(chunk)
  })
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8")
  })
  child.stdin.end(options.stdin)

  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (exitCode) => {
      if (options.onLine && pendingLine) options.onLine(pendingLine.replace(/\r$/, ""))
      resolve({ stdout, stderr, exitCode: exitCode ?? -1 })
    })
  })
}
