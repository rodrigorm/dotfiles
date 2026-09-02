import { afterEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { createConnection, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createWorktree, type IsolatedSandboxHandle } from "@ai-hero/sandcastle"

import { DEFAULT_CONFIG, parseConfig } from "./config"
import { ControlChannel, createCapability, parseControlRequest } from "./control-channel"
import { buildExeDevSshArgv } from "./exe-control"
import { canTransition } from "./state"
import { FileStateStore } from "./state-store"
import { buildRemoteCommandArgv, buildSupervisorArgv } from "./remote-runtime"
import { parseCliArgs, requestControl, requestControlMailbox, runCli } from "./cli"
import { identityMatches, makeVmPlan } from "./naming"
import { redactText } from "./redaction"
import { LifecycleController } from "./lifecycle"
import { createSandboxPlugin, readSessionEvents, resolveAuthContent, type WorkspaceAdapterLike } from "./plugin-runtime"
import { nodeProcessRunner } from "./process"
import { createExedevSandcastleAdapter, ExedevProvider, remoteWorkspaceDirectory } from "./exedev-provider"
import { createSbxSandcastleAdapter, SbxProvider } from "./sbx-provider"
import { CloudflareBridgeClient, type CloudflareSandboxClient } from "./cloudflare-bridge"
import { CloudflareProvider, createCloudflareSandcastleAdapter } from "./cloudflare-provider"
import { captureWorkingTree } from "./working-tree"
import { HttpWorkspaceGateway } from "./workspace-http"
import { runSyncBarrier } from "./sync-barrier"
import type { ExeControl } from "./exe-control"
import { isWorkspaceSyncResult } from "./types"
import { SandboxError, type SandboxRecord, type ProcessHandle, type ProcessResult, type ProcessRunner, type ProcessSupervisor, type VmInfo } from "./types"

const temporaryDirectories: string[] = []
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "oe-test-"))
  temporaryDirectories.push(directory)
  return directory
}

describe("sandboxctl parser", () => {
  it("accepts only the documented operations", () => {
    expect(parseCliArgs(["start"], false)).toEqual({ operation: "start", force: false })
    expect(parseCliArgs(["delete", "--force"], false)).toEqual({ operation: "delete", force: true })
    expect(parseCliArgs(["stop"], true)).toEqual({ operation: "stop", force: false })
  })

  it("rejects arbitrary commands and remote force", () => {
    expect(() => parseCliArgs(["sh", "-c", "rm -rf /"], false)).toThrow()
    expect(() => parseCliArgs(["delete", "--force"], true)).toThrow()
    expect(() => parseCliArgs(["status", "unexpected"], false)).toThrow()
  })

  it("writes one JSON document even for invalid input", async () => {
    const stdout: string[] = []
    const code = await runCli(["sh", "-c", "rm -rf /"], {}, { stdout: (text) => stdout.push(text) })

    expect(code).toBe(2)
    expect(stdout).toHaveLength(1)
    expect(() => JSON.parse(stdout[0] ?? "")).not.toThrow()
  })

  it("uses a mailbox transport when the remote sandbox has no socket route", async () => {
    const mailbox = await temporaryDirectory()
    const pending = requestControlMailbox(mailbox, "private", { operation: "status" }, 2_000)
    let requestName = ""
    for (let attempt = 0; attempt < 20 && !requestName; attempt++) {
      requestName = (await readdir(mailbox)).find((name) => name.endsWith(".request")) ?? ""
      if (!requestName) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(requestName).toMatch(/^[0-9a-f-]{36}\.request$/)
    const request = JSON.parse(await readFile(join(mailbox, requestName), "utf8"))
    expect(request).toMatchObject({ token: "private", body: { operation: "status" } })
    await writeFile(join(mailbox, requestName.replace(/\.request$/, ".response")), JSON.stringify({ status: 200, body: { ok: true } }))
    await expect(pending).resolves.toEqual({ status: 200, body: { ok: true } })
  })
})

describe("configuration", () => {
  it("fills the personal defaults and expands the state path", () => {
    const config = parseConfig({}, { HOME: "/Users/tester" })

    expect(config).toMatchObject({
      ...DEFAULT_CONFIG,
      stateDirectory: "/Users/tester/.local/state/opencode-sandbox",
      knownHostsFile: "/Users/tester/.local/state/opencode-sandbox/known_hosts",
    })
  })

  it("rejects unknown keys and unsafe provider identifiers", () => {
    expect(parseConfig({ provider: "sbx" }, { HOME: "/tmp" }).provider).toBe("sbx")
    expect(parseConfig({ provider: "cloudflare" }, { HOME: "/tmp" }).provider).toBe("cloudflare")
    expect(parseConfig({ openCodeVersion: "1.2.3" }, { HOME: "/tmp" }).openCodeVersion).toBe("1.2.3")
    expect(() => parseConfig({ unexpected: true }, { HOME: "/tmp" })).toThrow(/unknown configuration key/i)
    expect(() => parseConfig({ baseVm: "vm; rm -rf /" }, { HOME: "/tmp" })).toThrow(/baseVm/i)
    expect(() => parseConfig({ sshLobby: "exe.dev && whoami" }, { HOME: "/tmp" })).toThrow(/sshLobby/i)
  })
})

describe("lifecycle state", () => {
  it("allows only the documented transitions", () => {
    expect(canTransition("local", "provisioning")).toBe(true)
    expect(canTransition("remote", "detached")).toBe(false)
    expect(canTransition("stop_pending", "sync_failed")).toBe(true)
    expect(canTransition("sync_failed", "stop_pending")).toBe(true)
    expect(canTransition("sync_failed", "orphaned")).toBe(true)
  })
})

describe("VM identity", () => {
  it("keeps VM names private and tags tied to the generation", () => {
    const plan = makeVmPlan(
      { workspaceId: "wrk_01", projectId: "prj_01", generation: 2 },
      () => "0123456789abcdef0123456789abcdef",
    )

    expect(plan.vmName).toMatch(/^oc-[0-9a-f]{10}$/)
    expect(plan.vmName).not.toContain("project")
    expect(plan.branch).toMatch(/^opencode\/sandbox-[0-9a-f]{10}$/)
    expect(plan.tags).toContain("opencode-generation-0123456789abcdef0123456789abcdef")
    expect(plan.comment).toBe("opencode-0123456789abcdef0123456789abcdef")
  })

  it("requires every observed identity field to match before deletion", () => {
    const identity = {
      id: "vm-1",
      name: "oc-0123456789",
      sshDest: "vm.exe.xyz",
      sshUser: "user",
      sshHost: "vm.exe.xyz",
      region: "lon",
      tags: ["opencode-sandbox", "opencode-generation-abc"],
      comment: "opencode-abc",
    }

    expect(identityMatches(identity, { ...identity, tags: [...identity.tags].reverse() })).toBe(true)
    expect(identityMatches(identity, { ...identity, sshDest: "other.exe.xyz" })).toBe(false)
    expect(identityMatches(identity, { ...identity, tags: ["opencode-sandbox"] })).toBe(false)
  })
})

describe("redaction", () => {
  it("redacts exact secrets and common credential headers", () => {
    const text = redactText("token=private auth=Bearer abc123", ["private", "abc123"])

    expect(text).not.toContain("private")
    expect(text).not.toContain("abc123")
    expect(text).toContain("[REDACTED]")
  })
})

describe("SSH argv", () => {
  it("builds lifecycle argv without a shell command string", () => {
    const argv = buildExeDevSshArgv(
      {
        sshBin: "/usr/bin/ssh",
        lobby: "exe.dev",
        knownHostsFile: "/tmp/known_hosts",
      },
      ["new", "--name", "oc-0123456789", "--json"],
    )

    expect(argv).toEqual([
      "/usr/bin/ssh",
      "-F",
      "/dev/null",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "UserKnownHostsFile=/tmp/known_hosts",
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "ForwardAgent=no",
      "-o",
      "IdentityAgent=none",
      "-o",
      "ProxyCommand=none",
      "-o",
      "ProxyJump=none",
      "-o",
      "SendEnv=none",
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
      "-o",
      "RemoteCommand=none",
      "-o",
      "PermitLocalCommand=no",
      "-o",
      "UpdateHostkeys=no",
      "-o",
      "ClearAllForwardings=yes",
      "exe.dev",
      "new",
      "--name",
      "oc-0123456789",
      "--json",
    ])
    expect(argv.join(" ")).not.toContain("private")
  })

  it("keeps frame secrets out of the supervisor argv", () => {
    const argv = buildSupervisorArgv({
      sshBin: "/usr/bin/ssh",
      knownHostsFile: "/tmp/known_hosts",
      destination: "vm.exe.xyz",
      sshUser: "user",
      remotePort: 4096,
      localPort: 4100,
      localControlSocket: "/tmp/oe-control.sock",
      remoteControlSocket: "/tmp/oe-r/c.sock",
      remoteLauncherPath: "/tmp/oe-r/launcher",
    })

    expect(argv).toContain("-R")
    expect(argv).toContain("/tmp/oe-r/c.sock:/tmp/oe-control.sock")
    expect(argv).toContain("-L")
    expect(argv).toContain("127.0.0.1:4100:127.0.0.1:4096")
    expect(argv).toContain("StreamLocalBindUnlink=yes")
    expect(argv).not.toContain("control-token")
  })

  it("quotes remote command arguments before OpenSSH serializes them", () => {
    const argv = buildRemoteCommandArgv(
      {
        sshBin: "/usr/bin/ssh",
        knownHostsFile: "/tmp/known_hosts",
        destination: "vm.exe.xyz",
      },
      ["printf", "value; touch /tmp/untrusted"],
    )

    expect(argv.at(-1)).toBe("'value; touch /tmp/untrusted'")
  })
})

describe("process runner", () => {
  it("streams complete stdout lines before returning", async () => {
    const lines: string[] = []
    const result = await nodeProcessRunner.run({
      argv: ["/bin/sh", "-c", "printf 'first\\nsecond\\nlast'"],
      onLine: (line) => lines.push(line),
    })

    expect(result.exitCode).toBe(0)
    expect(lines).toEqual(["first", "second", "last"])
  })
})

describe("state store", () => {
  it("writes records atomically", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    const record = makeRecord()

    await store.write(record)

    const saved = await readFile(store.recordPath(record.sessionId), "utf8")
    expect(JSON.parse(saved)).toMatchObject({ generation: record.generation })
  })

  it("rejects credential fields in persisted provider state", async () => {
    const store = new FileStateStore(await temporaryDirectory())

    await expect(store.write({ ...makeRecord(), providerState: { apiKey: "private" } })).rejects.toMatchObject({
      code: "STATE_SECRET",
    })
  })

  it("does not remove a lock owned by another operation", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const enteredOperation = new Promise<void>((resolve) => {
      entered = resolve
    })
    const first = store.withLock("ses_1", async () => {
      entered()
      await held
    })
    await enteredOperation

    await expect(store.withLock("ses_1", async () => {})).rejects.toMatchObject({ code: "STATE_LOCKED" })
    await expect(store.withLock("ses_1", async () => {})).rejects.toMatchObject({ code: "STATE_LOCKED" })
    release()
    await first
  })

  it("recovers a lock whose owner process no longer exists", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    const lockName = createHash("sha256").update("ses_stale").digest("hex").slice(0, 24)
    await writeFile(join(root, `.${lockName}.lock`), "99999999\n")

    await expect(store.withLock("ses_stale", async () => {})).resolves.toBeUndefined()
  })

  it("recovers an old lock left before its owner was recorded", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    const lockName = createHash("sha256").update("ses_interrupted").digest("hex").slice(0, 24)
    const lockPath = join(root, `.${lockName}.lock`)
    await writeFile(lockPath, "")
    await utimes(lockPath, new Date(0), new Date(0))

    await expect(store.withLock("ses_interrupted", async () => {})).resolves.toBeUndefined()
  })
})

describe("workspace sync contract", () => {
  const baseSha = "0123456789012345678901234567890123456789"

  it("reads complete history for a session that predates the plugin", async () => {
    const databasePath = join(await temporaryDirectory(), "opencode.db")
    const database = new Database(databasePath)
    database.run("CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL)")
    database.run("INSERT INTO event VALUES (?, ?, ?, ?, ?)", ["evt_0", "ses_existing", 0, "session.created.1", JSON.stringify({ sessionID: "ses_existing" })])
    database.run("INSERT INTO event VALUES (?, ?, ?, ?, ?)", ["evt_other", "ses_other", 0, "session.created.1", JSON.stringify({ sessionID: "ses_other" })])
    database.run("INSERT INTO event VALUES (?, ?, ?, ?, ?)", ["evt_1", "ses_existing", 1, "session.updated.1", JSON.stringify({ sessionID: "ses_existing" })])
    database.close()

    expect(readSessionEvents(databasePath, "ses_existing")).toEqual([
      { id: "evt_0", aggregateID: "ses_existing", seq: 0, type: "session.created.1", data: { sessionID: "ses_existing" } },
      { id: "evt_1", aggregateID: "ses_existing", seq: 1, type: "session.updated.1", data: { sessionID: "ses_existing" } },
    ])
  })

  it("accepts only control-plane or isolated branch results", () => {
    expect(isWorkspaceSyncResult({ kind: "control-plane", baseSha })).toBe(true)
    expect(isWorkspaceSyncResult({ kind: "branch", baseSha, branch: "opencode/1" })).toBe(true)
    expect(isWorkspaceSyncResult({ kind: "worktree", baseSha, directory: "/tmp/project" })).toBe(false)
    expect(isWorkspaceSyncResult({ kind: "branch", baseSha, branch: "../main" })).toBe(false)
  })

  it("rejects a provider result that would target a worktree", async () => {
    const gateway = new HttpWorkspaceGateway({
      serverUrl: "http://127.0.0.1:4096",
      directory: "/tmp/project",
      projectId: "prj_1",
      syncOut: async () => ({ kind: "worktree", baseSha, directory: "/tmp/project" }) as never,
    })

    await expect(gateway.syncOut!({ workspaceId: "wrk_1", directory: "/tmp/project", baseSha })).rejects.toMatchObject({
      code: "WORKSPACE_SYNC_RESULT",
    })
  })

  it("routes workspace creation and replay through the requested directory and transport", async () => {
    const requests: Array<{ url: URL; body: unknown }> = []
    const gateway = new HttpWorkspaceGateway({
      serverUrl: "http://127.0.0.1:4096",
      directory: "/default",
      projectId: "prj_1",
      fetcher: async (input, init) => {
        const url = new URL(String(input))
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        requests.push({ url, body })
        if (url.pathname === "/experimental/workspace") {
          return Response.json({ id: "wrk_1", type: "sbx", name: "sandbox", branch: "opencode/test", directory: "/requested", extra: null, projectID: "prj_1" })
        }
        return new Response(null, { status: 204 })
      },
      sessionEvents: () => [{ id: "evt_1", aggregateID: "ses_1", seq: 0, type: "session.created", data: {} }],
    })

    await gateway.create({ type: "sbx", projectId: "prj_1", directory: "/requested", id: "wrk_1", branch: "opencode/test", extra: {} })
    await gateway.replaySession({ sessionId: "ses_1", directory: "/requested", target: { type: "remote", url: "https://sandbox.example.test" } })

    expect(requests[0]?.url.searchParams.get("directory")).toBe("/requested")
    expect(requests[1]?.url.href).toBe("https://sandbox.example.test/sync/replay")
    expect(requests[1]?.body).toMatchObject({ directory: "/requested" })
  })
})

describe("control channel", () => {
  it("authorizes only the capability owner and operation allowlist", async () => {
    const root = await temporaryDirectory()
    const socketPath = join(root, "control.sock")
    const channel = new ControlChannel({ socketPath, now: () => 1000 })
    const capability = createCapability({ sessionId: "ses_1", generation: 1, role: "host", now: 1000 })
    channel.register(capability)
    await channel.start()

    try {
      const unauthorized = await requestControl(socketPath, "wrong", { operation: "status" })
      expect(unauthorized.status).toBe(401)

      const response = await requestControl(socketPath, capability.token, { operation: "status" })
      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ operation: "status", sessionId: "ses_1" })

      const invalid = await requestControl(socketPath, capability.token, {
        operation: "status",
        sessionId: "ses_other",
      })
      expect(invalid.status).toBe(400)
      expect(() => parseControlRequest({ operation: "status", force: null }, capability)).toThrow()
    } finally {
      await channel.close()
    }
  })
})

describe("lifecycle controller", () => {
  it("keeps start and stop responses on their source side before warping", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    const calls: string[] = []
    const controller = new LifecycleController({
      store,
      capture: async () => ({ baseSha: "0123456789012345678901234567890123456789", patch: "", untracked: [] }),
      workspace: {
        async create(input) {
          calls.push(`create:${input.type}`)
          return {
            id: input.id ?? "wrk_1",
            type: "exedev",
            name: "oc-workspace",
            branch: input.branch,
            directory: "/tmp/remote-project",
            projectID: input.projectId,
            extra: {
              vmName: "oc-0123456789",
              vmIdentity: {
                name: "oc-0123456789",
                sshDest: "vm.exe.xyz",
                tags: ["opencode-sandbox"],
                comment: "opencode-abc",
              },
            },
          }
        },
        async warp(input) {
          calls.push(`warp:${input.workspaceId ?? "local"}`)
        },
        async syncOut(input) {
          calls.push(`syncOut:${input.baseSha}`)
          return { kind: "control-plane", baseSha: input.baseSha }
        },
        async remove(input) {
          calls.push(`remove:${input.workspaceId}`)
        },
      },
    })
    controller.registerContext({
      sessionId: "ses_1",
      projectId: "prj_1",
      directory: "/tmp/project",
      worktree: "/tmp/project",
    })
    const capability = createCapability({ sessionId: "ses_1", generation: 1, role: "host" })

    const started = await controller.handle({ operation: "start", force: false, capability })
    expect(started).toMatchObject({ ok: true, operation: "start", state: "activation_pending" })
    expect(calls).toEqual(["create:exedev"])

    await controller.onSessionIdle("ses_1")
    expect((await store.get("ses_1"))?.state).toBe("remote")
    expect(calls.some((call) => call.startsWith("warp:") && call !== "warp:local")).toBe(true)

    await controller.onSessionIdle("ses_1")
    expect(calls.filter((call) => call.startsWith("syncOut:"))).toHaveLength(1)

    const stopped = await controller.handle({ operation: "stop", force: false, capability })
    expect(stopped).toMatchObject({ ok: true, operation: "stop", state: "stop_pending" })
    await controller.onSessionIdle("ses_1")
    expect((await store.get("ses_1"))?.state).toBe("detached")
    expect(calls.filter((call) => call.startsWith("syncOut:"))).toHaveLength(2)
    expect(calls).toContain("warp:local")
    expect(calls.some((call) => call.startsWith("remove:") && call !== "remove:undefined")).toBe(true)
  })

  it("destroys a provisioned workspace when capture application fails", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    let released = false
    let removed = false
    let destroyed = false
    const controller = new LifecycleController({
      store,
      capture: async () => ({ baseSha: "0123456789012345678901234567890123456789", patch: "patch", untracked: [] }),
      providerRelease: async () => { released = true },
      providerDestroy: async () => { destroyed = true },
      workspace: {
        async create(input) {
          return {
            id: input.id ?? "wrk_1",
            type: input.type,
            name: "workspace",
            branch: input.branch,
            directory: input.directory,
            projectID: input.projectId,
            extra: { vmName: "oc-test", vmIdentity: makeRecord().vmIdentity },
          }
        },
        async applyCapture() {
          throw new SandboxError("sync", "capture failed", "CAPTURE_FAILED")
        },
        async warp() {},
        async remove() { removed = true },
      },
    })
    controller.registerContext({ sessionId: "ses_1", projectId: "prj_1", directory: "/tmp/project", worktree: "/tmp/project" })

    const result = await controller.handle({
      operation: "start",
      force: false,
      capability: createCapability({ sessionId: "ses_1", generation: 1, role: "host" }),
    })

    expect(result).toMatchObject({ ok: false, state: "error", stage: "sync" })
    expect(released).toBe(true)
    expect(removed).toBe(true)
    expect(destroyed).toBe(true)
  })

  it("blocks detach when sync returns a different base revision", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    const record = { ...makeRecord(), state: "remote" as const }
    await store.write(record)
    const calls: string[] = []
    const controller = new LifecycleController({
      store,
      workspace: {
        async create() {
          throw new Error("must not create")
        },
        async warp(input) {
          calls.push(`warp:${input.workspaceId ?? "local"}`)
        },
        async syncOut() {
          return { kind: "branch", baseSha: "fedcba9876543210fedcba9876543210fedcba98", branch: "opencode/1" }
        },
        async remove() {},
      },
    })
    const capability = createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" })

    await expect(controller.handle({ operation: "stop", force: false, capability })).resolves.toMatchObject({
      ok: true,
      state: "stop_pending",
    })
    await controller.onSessionIdle(record.sessionId)

    expect((await store.get(record.sessionId))?.state).toBe("sync_failed")
    expect(calls).not.toContain("warp:local")
  })

  it("reuses the VM identity and branch when resuming a detached session", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
  const existing = { ...makeRecord(), state: "detached" as const, vmName: "oc-existing", branch: "opencode/sandbox-existing" }
    await store.write(existing)
    let createdBranch = ""
    const controller = new LifecycleController({
      store,
      capture: async () => ({ baseSha: existing.baseSha, patch: "", untracked: [] }),
      workspace: {
        async create(input) {
          createdBranch = input.branch
          return {
            id: input.id ?? "wrk-resumed",
            type: "exedev",
            name: "resumed",
            branch: input.branch,
            directory: existing.directory,
            projectID: existing.projectId,
            extra: { vmName: existing.vmName, vmIdentity: existing.vmIdentity },
          }
        },
        async warp() {},
        async remove() {},
      },
    })
    controller.registerContext({ sessionId: existing.sessionId, projectId: existing.projectId, directory: existing.directory, worktree: existing.directory })

    const result = await controller.handle({
      operation: "start",
      force: false,
      capability: createCapability({ sessionId: existing.sessionId, generation: existing.generation, role: "host" }),
    })

    expect(result).toMatchObject({ ok: true, state: "activation_pending" })
    expect(createdBranch).toBe(existing.branch)
    expect((await store.get(existing.sessionId))?.vmName).toBe(existing.vmName)
  })

  it("retries failed stop and delete operations without repeating completed cleanup", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    let syncFailures = 1
    let destroyFailures = 1
    let removeCalls = 0
    let destroyCalls = 0
    const controller = new LifecycleController({
      store,
      providerDestroy: async () => {
        destroyCalls++
        if (destroyFailures-- > 0) throw new Error("destroy failed")
      },
      workspace: {
        async create() {
          throw new Error("must not create")
        },
        async warp() {},
        async syncOut(input) {
          if (syncFailures-- > 0) throw new Error("sync failed")
          return { kind: "control-plane", baseSha: input.baseSha }
        },
        async remove() {
          removeCalls++
        },
      },
    })
    const capability = createCapability({ sessionId: "ses_1", generation: 1, role: "host" })

    await store.write({
      ...makeRecord(),
      state: "error",
      operation: { kind: "stop", phase: "awaiting_idle" },
      lastError: { stage: "sync", message: "sync failed" },
    })
    await expect(controller.handle({ operation: "retry", force: false, capability })).resolves.toMatchObject({ state: "sync_failed" })
    await expect(controller.handle({ operation: "retry", force: false, capability })).resolves.toMatchObject({ state: "detached" })
    expect(removeCalls).toBe(1)

    await store.write({
      ...makeRecord(),
      state: "error",
      operation: { kind: "delete", phase: "removing" },
      lastError: { stage: "remove", message: "destroy failed" },
    })
    await expect(controller.handle({ operation: "retry", force: false, capability })).resolves.toMatchObject({ state: "error" })
    expect((await store.get("ses_1"))?.operation?.phase).toBe("destroying")
    await expect(controller.handle({ operation: "retry", force: false, capability })).resolves.toMatchObject({ state: "deleted" })
    expect(removeCalls).toBe(2)
    expect(destroyCalls).toBe(2)
  })

  it("does not let a remote capability retry a failed start", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = { ...makeRecord(), state: "error" as const, operation: { kind: "start" as const, phase: "provisioning" } }
    await store.write(record)
    let created = false
    const controller = new LifecycleController({
      store,
      workspace: {
        async create() { created = true; throw new Error("must not create") },
        async warp() {},
        async remove() {},
      },
    })

    const result = await controller.handle({
      operation: "retry",
      force: false,
      capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "remote" }),
    })

    expect(result).toMatchObject({ ok: false, stage: "validate", state: "error" })
    expect(result.message).toMatch(/host/)
    expect(created).toBe(false)
  })

  it("does not let a remote capability retry a failed force delete", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = {
      ...makeRecord(),
      state: "error" as const,
      operation: { kind: "delete" as const, phase: "discarding", force: true },
    }
    await store.write(record)
    let destroyed = false
    const controller = new LifecycleController({
      store,
      providerDestroy: async () => { destroyed = true },
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() { throw new Error("must not warp") },
        async remove() { throw new Error("must not remove") },
      },
    })

    const result = await controller.handle({
      operation: "retry",
      force: false,
      capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "remote" }),
    })

    expect(result).toMatchObject({ ok: false, stage: "validate", state: "error" })
    expect(result.message).toMatch(/host/)
    expect(destroyed).toBe(false)
    expect((await store.get(record.sessionId))?.state).toBe("error")
  })

  it("does not let a stale retry overwrite a new start", async () => {
    let unblock!: () => void
    let readStarted!: () => void
    const initialRead = new Promise<void>((resolve) => { readStarted = resolve })
    const store = new (class extends FileStateStore {
      private pause = true

      override async get(sessionId: string) {
        const record = await super.get(sessionId)
        if (this.pause) {
          this.pause = false
          readStarted()
          await new Promise<void>((resolve) => { unblock = resolve })
        }
        return record
      }
    })(await temporaryDirectory())
    const record = {
      ...makeRecord(),
      state: "error" as const,
      operation: { kind: "delete" as const, phase: "destroying", force: false },
    }
    await store.write(record)
    let destroyed = false
    const controller = new LifecycleController({
      store,
      capture: async () => ({ baseSha: record.baseSha, patch: "", untracked: [] }),
      providerDestroy: async () => { destroyed = true },
      workspace: {
        async create(input) {
          return {
            id: input.id ?? record.workspaceId,
            type: input.type,
            name: "workspace",
            branch: input.branch,
            directory: input.directory,
            projectID: input.projectId,
            extra: null,
          }
        },
        async warp() {},
        async remove() {},
      },
    })
    controller.registerContext({
      sessionId: record.sessionId,
      projectId: record.projectId,
      directory: record.directory,
      worktree: record.directory,
    })

    const remoteRetry = controller.handle({
      operation: "retry",
      force: false,
      capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "remote" }),
    })
    await initialRead
    await expect(controller.handle({
      operation: "start",
      force: false,
      capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" }),
    })).resolves.toMatchObject({ ok: true, state: "activation_pending" })
    unblock()

    const result = await remoteRetry

    expect(result).toMatchObject({ ok: false, stage: "validate", state: "activation_pending" })
    expect(result.message).toMatch(/changed while retry/i)
    expect(destroyed).toBe(false)
    expect((await store.get(record.sessionId))?.state).toBe("activation_pending")
  })

  it("redacts credentials from diagnostics while keeping recovery metadata", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = { ...makeRecord(), state: "orphaned" as const, providerState: { resourceId: "sandbox-1" } }
    await store.write(record)
    const controller = new LifecycleController({
      store,
      infrastructure: {
        diagnose: async () => ({ resourceId: "sandbox-1", token: "private", nested: { apiKey: "secret", healthy: true } }),
      },
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() { throw new Error("must not warp") },
        async remove() { throw new Error("must not remove") },
      },
    })
    const capability = createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" })

    const result = await controller.handle({ operation: "diagnose", force: false, capability })

    expect(result.details).toMatchObject({ recoveryMetadata: { resourceId: "sandbox-1" }, resourceId: "sandbox-1", nested: { healthy: true } })
    expect(JSON.stringify(result)).not.toContain("private")
    expect(JSON.stringify(result)).not.toContain("secret")
  })

  it("redacts and bounds logs and diagnostics before returning them", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = { ...makeRecord(), state: "orphaned" as const }
    await store.write(record)
    const controller = new LifecycleController({
      store,
      infrastructure: {
        diagnose: async () => ({ output: `token=private ${"x".repeat(100_000)}` }),
        logs: async () => [`Authorization: Bearer private`, "x".repeat(100_000)],
      },
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() { throw new Error("must not warp") },
        async remove() { throw new Error("must not remove") },
      },
    })
    const capability = createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" })

    const logs = await controller.handle({ operation: "logs", force: false, capability })
    const diagnostics = await controller.handle({ operation: "diagnose", force: false, capability })

    expect(logs.details).toMatchObject({ truncated: true })
    expect(diagnostics.details).toMatchObject({ truncated: true })
    expect(Buffer.byteLength(JSON.stringify(logs))).toBeLessThan(140_000)
    expect(Buffer.byteLength(JSON.stringify(diagnostics))).toBeLessThan(70_000)
    expect(`${JSON.stringify(logs)}${JSON.stringify(diagnostics)}`).not.toContain("private")
  })

  it("finishes a detached delete recovery", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    await store.write({
      ...makeRecord(),
      state: "delete_pending",
      operation: { kind: "delete", phase: "destroying" },
    })
    let destroyed = false
    const controller = new LifecycleController({
      store,
      providerDestroy: async () => { destroyed = true },
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() { throw new Error("must not warp") },
        async remove() { throw new Error("workspace was already removed") },
      },
    })

    await controller.reconcile("prj_1")

    expect(destroyed).toBe(true)
    expect((await store.get("ses_1"))?.state).toBe("deleted")
  })
})

describe("plugin runtime", () => {
  it("loads persisted OpenCode auth when OPENCODE_AUTH_CONTENT is absent", async () => {
    const root = await temporaryDirectory()
    const data = join(root, "data")
    await mkdir(join(data, "opencode"), { recursive: true })
    await writeFile(join(data, "opencode", "auth.json"), '{"openai":{"type":"api","key":"private"}}')

    expect(await resolveAuthContent({ HOME: root, XDG_DATA_HOME: data })).toContain('"openai"')
  })

  it("does not register when experimental workspaces are disabled", async () => {
    const root = await temporaryDirectory()
    let registered = 0
    const logs: string[] = []

    const hooks = await createSandboxPlugin(
      {
        project: { id: "prj_1" },
        directory: root,
        worktree: root,
        serverUrl: new URL("http://127.0.0.1:4096"),
        experimental_workspace: { register: () => registered++ },
      },
      { env: { HOME: root, XDG_RUNTIME_DIR: root }, log: (message) => logs.push(message) },
    )

    expect(hooks).toBeUndefined()
    expect(registered).toBe(0)
    expect(logs[0]).toMatch(/experimental workspaces are disabled/i)
  })

  it("registers the adapter and injects a session capability", async () => {
    const root = await temporaryDirectory()
    let adapter: WorkspaceAdapterLike | undefined
    const hooks = await createSandboxPlugin(
      {
        project: { id: "prj_1" },
        directory: root,
        worktree: root,
        serverUrl: new URL("http://127.0.0.1:4096"),
        experimental_workspace: { register: (_type, value) => (adapter = value) },
      },
      { env: { HOME: root, XDG_RUNTIME_DIR: root, OPENCODE_EXPERIMENTAL_WORKSPACES: "1" } },
    )
    if (!hooks || !adapter) throw new Error("plugin did not initialize")
    cleanups.push(hooks.dispose)

    const shellEnv = { env: {} as Record<string, string> }
    await hooks["shell.env"]({ cwd: root, sessionID: "ses_1" }, shellEnv)

    expect(shellEnv.env.SANDBOX_CONTROL_SOCKET).toContain("/c.sock")
    expect(shellEnv.env.SANDBOX_CONTROL_TOKEN).toHaveLength(43)
    expect(shellEnv.env.SANDBOX_CONTROL_ROLE).toBe("host")
    expect(adapter.name).toBe("exe.dev")
    await expect(adapter.create({} as never, {})).resolves.toBeUndefined()
    await expect(hooks["chat.message"]({ sessionID: "ses_1" })).resolves.toBeUndefined()
  })

  it("selects the sbx provider from configuration without starting it", async () => {
    const root = await temporaryDirectory()
    let adapter: WorkspaceAdapterLike | undefined
    let registeredType = ""
    const hooks = await createSandboxPlugin(
      {
        project: { id: "prj_1" },
        directory: root,
        worktree: root,
        serverUrl: new URL("http://127.0.0.1:4096"),
        experimental_workspace: { register: (type, value) => { registeredType = type; adapter = value } },
      },
      {
        config: { provider: "sbx" },
        env: { HOME: root, XDG_RUNTIME_DIR: root, OPENCODE_EXPERIMENTAL_WORKSPACES: "1" },
      },
    )
    if (!hooks || !adapter) throw new Error("plugin did not initialize")
    cleanups.push(hooks.dispose)

    expect(adapter.name).toBe("Docker Sandbox")
    expect(registeredType).toBe("sbx")
  })

  it("selects the Cloudflare provider from configuration without starting it", async () => {
    const root = await temporaryDirectory()
    let adapter: WorkspaceAdapterLike | undefined
    let registeredType = ""
    const hooks = await createSandboxPlugin(
      {
        project: { id: "prj_1" },
        directory: root,
        worktree: root,
        serverUrl: new URL("http://127.0.0.1:4096"),
        experimental_workspace: { register: (type, value) => { registeredType = type; adapter = value } },
      },
      {
        config: { provider: "cloudflare" },
        env: {
          HOME: root,
          XDG_RUNTIME_DIR: root,
          OPENCODE_EXPERIMENTAL_WORKSPACES: "1",
          SANDBOX_API_URL: "https://bridge.example.test",
          SANDBOX_API_KEY: "private",
        },
      },
    )
    if (!hooks || !adapter) throw new Error("plugin did not initialize")
    cleanups.push(hooks.dispose)

    expect(adapter.name).toBe("Cloudflare Sandbox")
    expect(registeredType).toBe("cloudflare")
  })

  it("registers a Sandcastle workspace adapter without the legacy provider", async () => {
    const root = await temporaryDirectory()
    let adapter: WorkspaceAdapterLike | undefined
    let registeredType = ""
    const hooks = await createSandboxPlugin(
      {
        project: { id: "prj_1" },
        directory: root,
        worktree: root,
        serverUrl: new URL("http://127.0.0.1:4096"),
        experimental_workspace: { register: (type, value) => { registeredType = type; adapter = value } },
      },
      {
        env: { HOME: root, XDG_RUNTIME_DIR: root, OPENCODE_EXPERIMENTAL_WORKSPACES: "1" },
        sandcastle: {
          type: "fake",
          name: "Fake Sandcastle",
          description: "test adapter",
          createAdapter: async () => { throw new Error("must not create during plugin setup") },
        },
      },
    )
    if (!hooks || !adapter) throw new Error("plugin did not initialize")
    const registeredAdapter = adapter
    cleanups.push(hooks.dispose)

    expect(registeredType).toBe("fake")
    expect(registeredAdapter.name).toBe("Fake Sandcastle")
    await expect(registeredAdapter.create({} as never, {})).resolves.toBeUndefined()
    expect(() => registeredAdapter.target({ id: "wrk_1" } as never)).toThrow(/target is unavailable/i)
  })

  it("loads provider configuration from the project file", async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, ".opencode"))
    await writeFile(join(root, ".opencode", "sandbox.json"), JSON.stringify({ provider: "sbx" }))
    let registeredType = ""
    const hooks = await createSandboxPlugin(
      {
        project: { id: "prj_1" },
        directory: root,
        worktree: root,
        serverUrl: new URL("http://127.0.0.1:4096"),
        experimental_workspace: { register: (type) => { registeredType = type } },
      },
      { env: { HOME: root, XDG_RUNTIME_DIR: root, OPENCODE_EXPERIMENTAL_WORKSPACES: "1" } },
    )
    if (!hooks) throw new Error("plugin did not initialize")
    cleanups.push(hooks.dispose)

    expect(registeredType).toBe("sbx")
  })
})

describe("exe.dev provisioner", () => {
  it("creates a VM, checks out the local revision, starts the target, and preserves untracked files", async () => {
    const root = await temporaryDirectory()
    const baseSha = "0123456789012345678901234567890123456789"
    const commands: string[][] = []
    let failRemote = false
    let removedVm = false
    let supervisorInput: { argv: string[]; stdin?: string | Uint8Array } | undefined
    let terminated = false
    let finishProcess: ((result: { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }) => void) | undefined
    const process: ProcessHandle = {
      pid: 123,
      result: new Promise((resolve) => {
        finishProcess = resolve
      }),
      terminate() {
        terminated = true
        finishProcess?.({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" })
      },
    }
    const runner: ProcessRunner = {
      async run(input) {
        commands.push(input.argv)
        if (failRemote && input.argv[0]?.endsWith("/ssh") && input.argv.includes("mkdir")) {
          return { exitCode: 1, signal: null, stdout: "", stderr: "mkdir failed" }
        }
        if (input.argv[0] === "git" && input.argv.includes("remote")) {
          return { exitCode: 0, signal: null, stdout: "git@github.com:owner/repo.git\n", stderr: "" }
        }
        if (input.argv[0] === "git" && input.argv.includes("rev-parse")) {
          return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
        }
        if (input.argv[0]?.endsWith("/ssh") && input.argv.includes("test")) {
          return { exitCode: 1, signal: null, stdout: "", stderr: "" }
        }
        if (input.argv[0]?.endsWith("/ssh") && input.argv.includes("rev-parse")) {
          return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
        }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
    }
    const vm: VmInfo = {
      identity: {
        name: "oc-0123456789",
        sshDest: "vm.exe.xyz",
        tags: ["opencode-sandbox"],
        comment: "opencode-test",
      },
      status: "running",
    }
    const control: ExeControl = {
      async create() {
        return vm
      },
      async copy() {
        return vm
      },
      async list() {
        return [vm]
      },
      async remove() {
        removedVm = true
      },
      async tag() {},
    }
    const supervisor: ProcessSupervisor = {
      async start(input) {
        supervisorInput = input
        return process
      },
    }
    const provisioner = new ExedevProvider({
      config: parseConfig({}, { HOME: root }),
      control,
      worktree: root,
      localControlSocket: join(root, "control.sock"),
      runner,
      supervisor,
      reservePort: async () => 4100,
      ensureHostKey: async () => {},
      ensureVmHostKey: async () => {},
      controlTokenFor: async () => "remote-token",
      fetcher: (async () => new Response(JSON.stringify({ healthy: true, version: "1.18.23" }), { status: 200 })) as unknown as typeof fetch,
    })
    const info = {
      id: "wrk_1",
      type: "exedev",
      name: "oc-0123456789",
      branch: "opencode/sandbox-0123456789",
      directory: remoteWorkspaceDirectory("wrk_1"),
      projectID: "prj_1",
      extra: {
        sessionId: "ses_1",
        generation: 1,
        baseSha,
        tags: ["opencode-sandbox"],
        comment: "opencode-test",
      },
    }

    await provisioner.prepare(info, { OPENCODE_AUTH_CONTENT: "{}" })

    expect(commands.some((argv) => argv.includes("clone"))).toBe(true)
    expect(supervisorInput?.argv).toContain("127.0.0.1:4100:127.0.0.1:4096")
    expect(supervisorInput?.argv.join(" ")).not.toContain("control-token")
    expect(JSON.parse(String(supervisorInput?.stdin))).toMatchObject({ authContent: "{}", controlToken: "remote-token" })
    await expect(provisioner.target(info)).resolves.toMatchObject({
      type: "remote",
      url: "http://127.0.0.1:4100",
    })

    const content = new TextEncoder().encode("untracked\n")
    await provisioner.syncIn("wrk_1", {
      baseSha,
      patch: "",
      untracked: [{ path: "nested.txt", sha256: sha256ForTest(content), content }],
    })
    expect(commands.some((argv) => argv.some((part) => part.endsWith("/write-file")))).toBe(true)

    const runtime = provisioner.runtimeMetadata("wrk_1")
    const remoteDirectory = runtime?.providerState?.remoteDirectory
    expect(remoteDirectory).toMatch(/^\/tmp\/oe-/)
    await provisioner.release(info)
    expect(terminated).toBe(true)
    expect(commands.some((argv) => argv.includes("rm") && argv.includes("-rf"))).toBe(true)

    const restarted = new ExedevProvider({
      config: parseConfig({}, { HOME: root }),
      control,
      worktree: root,
      localControlSocket: join(root, "control.sock"),
      runner,
      ensureHostKey: async () => {},
      ensureVmHostKey: async () => {},
      reservePort: async () => 4100,
    })
    await restarted.release({ ...info, extra: { ...info.extra, providerState: runtime?.providerState } })
    expect(commands.filter((argv) => argv.includes("rm") && argv.includes("-rf"))).toHaveLength(2)

    failRemote = true
    await expect(provisioner.prepare(info, { OPENCODE_AUTH_CONTENT: "{}" })).rejects.toMatchObject({ code: "REMOTE_COMMAND" })
    expect(removedVm).toBe(false)
    await expect(provisioner.target(info)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" })
  })

  it("removes a VM created before bootstrap fails", async () => {
    const root = await temporaryDirectory()
    const baseSha = "0123456789012345678901234567890123456789"
    let removed = false
    const vm: VmInfo = {
      identity: { name: "oc-0123456789", sshDest: "vm.exe.xyz", tags: ["opencode-sandbox"], comment: "opencode-test" },
      status: "running",
    }
    const runner: ProcessRunner = {
      async run(input) {
        if (input.argv[0] === "git" && input.argv.includes("remote")) return { exitCode: 0, signal: null, stdout: "https://github.com/owner/repo.git\n", stderr: "" }
        if (input.argv[0] === "git" && input.argv.includes("rev-parse")) return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
        if (input.argv[0]?.endsWith("/ssh")) return { exitCode: 1, signal: null, stdout: "", stderr: "bootstrap failed" }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
    }
    const provider = new ExedevProvider({
      config: parseConfig({}, { HOME: root }),
      control: {
        async create() { return vm },
        async copy() { return vm },
        async list() { return [] },
        async remove() { removed = true },
        async tag() {},
      },
      worktree: root,
      localControlSocket: join(root, "control.sock"),
      runner,
      ensureHostKey: async () => {},
      ensureVmHostKey: async () => {},
      reservePort: async () => 4100,
    })

    await expect(provider.prepare({
      id: "wrk_failed",
      type: "exedev",
      name: "workspace",
      branch: "opencode/sandbox-failed",
      directory: remoteWorkspaceDirectory("wrk_failed"),
      projectID: "prj_1",
      extra: {},
    }, { OPENCODE_AUTH_CONTENT: "{}" })).rejects.toMatchObject({ code: "REMOTE_COMMAND" })
    expect(removed).toBe(true)
  })

  it("exposes Exe.dev as an isolated Sandcastle provider with streaming exec", async () => {
    const root = await temporaryDirectory()
    const repository = await temporaryDirectory()
    await runGit(repository, ["init", "-q"])
    await runGit(repository, ["config", "user.email", "test@example.invalid"])
    await runGit(repository, ["config", "user.name", "Test"])
    await writeFile(join(repository, "tracked.txt"), "base\n")
    await runGit(repository, ["add", "."])
    await runGit(repository, ["commit", "-q", "-m", "initial"])
    const head = await nodeProcessRunner.run({ argv: ["git", "-C", repository, "rev-parse", "HEAD"], cwd: repository })
    const baseSha = head.stdout.trim()
    const vm: VmInfo = {
      identity: { name: "oc-0123456789", sshDest: "vm.exe.xyz", tags: ["opencode-sandbox"], comment: "opencode-test" },
      status: "running",
    }
    let removed = 0
    let terminated = 0
    let supervisorInput: { argv: string[]; stdin?: string | Uint8Array } | undefined
    let finishProcess!: (result: { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }) => void
    const process: ProcessHandle = {
      pid: 123,
      result: new Promise((resolve) => { finishProcess = resolve }),
      terminate() {
        terminated++
        finishProcess({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" })
      },
    }
    const runner: ProcessRunner = {
      async run(input) {
        if (input.argv[0] === "git" && input.argv.includes("remote")) {
          return { exitCode: 0, signal: null, stdout: "https://github.com/owner/repo.git\n", stderr: "" }
        }
        if (input.argv[0] === "git" && input.argv.includes("rev-parse")) {
          return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
        }
        if (input.argv[0]?.endsWith("/ssh")) {
          const command = input.argv.at(-1) ?? ""
          if (input.argv.includes("test") && input.argv.includes("-d")) return { exitCode: 1, signal: null, stdout: "", stderr: "" }
          if (input.argv.includes("rev-parse") || command.includes("rev-parse")) return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
          if (command.includes("printf")) {
            input.onLine?.("first")
            input.onLine?.("second")
            return { exitCode: 0, signal: null, stdout: "first\nsecond\n", stderr: "" }
          }
        }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
    }
    const adapter = createExedevSandcastleAdapter({
      input: {
        sessionId: "ses_adapter",
        projectId: "prj_1",
        workspaceId: "wrk_adapter",
        generation: 1,
        branch: "opencode/sandbox-adapter",
        baseSha,
        context: { sessionId: "ses_adapter", projectId: "prj_1", directory: repository, worktree: repository },
      },
      config: parseConfig({}, { HOME: root }),
      control: {
        async create() { return vm },
        async copy() { return vm },
        async list() { return [vm] },
        async remove() { removed++ },
        async tag() {},
      },
      worktree: repository,
      localControlSocket: join(root, "control.sock"),
      runner,
      supervisor: { async start(input) { supervisorInput = input; return process } },
      reservePort: async () => 4100,
      ensureHostKey: async () => {},
      ensureVmHostKey: async () => {},
      controlTokenFor: async () => "remote-token",
      authContent: "{}",
      fetcher: (async () => new Response(JSON.stringify({ healthy: true, version: "1.18.23" }), { status: 200 })) as unknown as typeof fetch,
    })
    const worktree = await createWorktree({
      cwd: repository,
      branchStrategy: { type: "branch", branch: "opencode/sandbox-adapter", baseBranch: baseSha },
    })

    let sandbox
    try {
      sandbox = await worktree.createSandbox({ sandbox: adapter.provider })
      expect(supervisorInput).toBeUndefined()
      await adapter.applyCapture({ sandbox, capture: { baseSha, patch: "", untracked: [] } })
      await expect(adapter.target()).resolves.toMatchObject({ type: "remote", url: "http://127.0.0.1:4100" })
      expect(supervisorInput?.argv).toContain("-R")
      expect(supervisorInput?.argv.some((value) => value.endsWith(`:${join(root, "control.sock")}`))).toBe(true)
      expect(JSON.parse(String(supervisorInput?.stdin))).toMatchObject({ authContent: "{}", controlToken: "remote-token" })
      const lines: string[] = []
      await expect(sandbox.exec("printf 'first\\nsecond\\n'", { onLine: (line) => lines.push(line) })).resolves.toMatchObject({
        exitCode: 0,
        stdout: "first\nsecond\n",
      })
      expect(lines).toEqual(["first", "second"])
      expect(sandbox.worktreePath).toBe(worktree.worktreePath)
    } finally {
      await sandbox?.close()
      await sandbox?.close()
      await worktree.close()
    }

    expect(terminated).toBe(1)
    expect(removed).toBe(1)
  })
})

describe("Docker Sandbox provider", () => {
  it("adapts an isolated sandbox to Sandcastle with authenticated remote stop", async () => {
    const root = await temporaryDirectory()
    const repository = await temporaryDirectory()
    await runGit(repository, ["init", "-q"])
    await runGit(repository, ["config", "user.email", "test@example.invalid"])
    await runGit(repository, ["config", "user.name", "Test"])
    await writeFile(join(repository, "tracked.txt"), "base\n")
    await writeFile(join(repository, "deleted.txt"), "delete me\n")
    await writeFile(join(repository, "staged.txt"), "staged base\n")
    await writeFile(join(repository, "binary.bin"), Buffer.from([9, 8, 7]))
    await runGit(repository, ["add", "."])
    await runGit(repository, ["commit", "-q", "-m", "initial"])
    await writeFile(join(repository, "tracked.txt"), "unstaged change\n")
    await writeFile(join(repository, "staged.txt"), "staged change\n")
    await runGit(repository, ["add", "staged.txt"])
    await rm(join(repository, "deleted.txt"))
    await writeFile(join(repository, "binary.bin"), Buffer.from([0, 1, 2, 255]))
    await writeFile(join(repository, "untracked.txt"), "untracked change\n")
    const capture = await captureWorkingTree({
      sessionId: "ses_sbx_adapter",
      projectId: "prj_1",
      directory: repository,
      worktree: repository,
    })
    const head = await nodeProcessRunner.run({ argv: ["git", "-C", repository, "rev-parse", "HEAD"], cwd: repository })
    const baseSha = head.stdout.trim()
    const branch = "opencode/sbx-adapter"
    const clone = "/workspace/project"
    const sandboxWorktree = join(clone, ".opencode-worktree")
    const calls: string[] = []
    const inputs: Array<{ argv: string[]; stdin?: string | Uint8Array }> = []
    let supervisorInput: { argv: string[]; stdin?: string | Uint8Array; timeoutMs?: number } | undefined
    let terminateCount = 0
    let failCopyFileOut = false
    let installedVersion = "1.18.23"
    const operations: string[] = []
    const authContent = JSON.stringify({ openai: { type: "oauth", access: "test-access" } })
    const capability = createCapability({ sessionId: "ses_sbx_adapter", generation: 1, role: "remote" })
    const channel = new ControlChannel({
      socketPath: join(root, "control.sock"),
      handler: async (request) => {
        operations.push(request.operation)
        return { ok: true, operation: request.operation, state: "remote", message: "handled" }
      },
    })
    channel.register(capability)
    let finishProcess!: (result: ProcessResult) => void
    const process: ProcessHandle = {
      pid: 456,
      result: new Promise((resolve) => { finishProcess = resolve }),
      terminate() {
        terminateCount++
        finishProcess({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" })
      },
    }
    const runner: ProcessRunner = {
      async run(input) {
        calls.push(input.argv.join(" "))
        inputs.push({ argv: input.argv, stdin: input.stdin })
        if (input.argv[0] === "git" && input.argv.includes("remote")) return { exitCode: 0, signal: null, stdout: "git@github.com:owner/repo.git\n", stderr: "" }
        if (input.argv[0] !== "sbx") return { exitCode: 0, signal: null, stdout: "", stderr: "" }
        if (input.argv.includes("npm") && input.argv.includes("install")) installedVersion = "1.18.25"
        if (input.argv.includes("opencode") && input.argv.includes("--version")) return { exitCode: 0, signal: null, stdout: `${installedVersion}\n`, stderr: "" }
        if (input.argv.includes("--show-toplevel")) return { exitCode: 0, signal: null, stdout: `${clone}\n`, stderr: "" }
        if (input.argv.includes("symbolic-ref")) return { exitCode: 0, signal: null, stdout: `${branch}\n`, stderr: "" }
        if (input.argv.some((value) => value.includes("rev-parse"))) return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
        const command = input.argv.at(-1) ?? ""
        if (command.includes("git rev-list")) return { exitCode: 0, signal: null, stdout: "0\n", stderr: "" }
        if (command.includes("git diff HEAD")) return { exitCode: 0, signal: null, stdout: "", stderr: "" }
        if (command.includes("git ls-files")) return { exitCode: 0, signal: null, stdout: "new.txt\n", stderr: "" }
        if (input.argv.some((value) => value.includes("base64.b64encode"))) {
          if (failCopyFileOut) return { exitCode: 1, signal: null, stdout: "", stderr: "copy failed" }
          return { exitCode: 0, signal: null, stdout: Buffer.from([0, 1, 2, 255]).toString("base64"), stderr: "" }
        }
        if (input.argv.includes("mktemp") && input.argv.includes("-d")) return { exitCode: 0, signal: null, stdout: "/tmp/sbx-temp\n", stderr: "" }
        if (command.includes("printf")) {
          input.onLine?.("first")
          input.onLine?.("second")
          return { exitCode: 0, signal: null, stdout: "first\nsecond\n", stderr: "" }
        }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
    }
    const adapter = createSbxSandcastleAdapter({
      ...fakeSbxOwnership(),
      input: {
        sessionId: "ses_sbx_adapter",
        projectId: "prj_1",
        workspaceId: "wrk_sbx_adapter",
        generation: 1,
        branch,
        baseSha,
        context: { sessionId: "ses_sbx_adapter", projectId: "prj_1", directory: repository, worktree: repository },
      },
      worktree: repository,
      localControlSocket: join(root, "control.sock"),
      runner,
      supervisor: { async start(input) { supervisorInput = input; return process } },
      reservePort: async () => 4102,
      openCodeVersion: "1.18.25",
      fetcher: (async () => new Response(JSON.stringify({ healthy: true }), { status: 200 })) as unknown as typeof fetch,
      controlTokenFor: async () => capability.token,
      authContent,
    })
    const worktree = await createWorktree({
      cwd: repository,
      branchStrategy: { type: "branch", branch, baseBranch: baseSha },
    })

    let sandbox
    try {
      await channel.start()
      sandbox = await worktree.createSandbox({ sandbox: adapter.provider })
      const managedAuth = inputs.find(({ argv }) => argv.includes("secret") && argv.includes("set"))
      expect(managedAuth?.stdin).toBe("test-access\n")
      expect(calls.some((call) => call.includes("npm install --global opencode-ai@1.18.25"))).toBe(true)
      const swapCommand = inputs.map(({ argv }) => argv.at(-1)).find((command) => command?.includes(`rm -rf "${sandboxWorktree}" && mv "${sandboxWorktree}_clone" "${sandboxWorktree}"`))
      expect(swapCommand).toContain(`cd -- ${sandboxWorktree} &&`)
      expect(supervisorInput).toBeUndefined()
      await adapter.applyCapture({ sandbox, capture })
      expect(calls.some((call) => call.includes("remote set-url origin https://github.com/owner/repo.git"))).toBe(true)
      await expect(adapter.target()).resolves.toMatchObject({ type: "remote", url: "http://127.0.0.1:4102" })
       expect(supervisorInput?.argv).toContain("-R")
       expect(supervisorInput?.argv).not.toContain("ClearAllForwardings=yes")
      expect(supervisorInput?.argv.some((value) => /^oc-sbx-[0-9a-f]{10}\.sbx$/.test(value))).toBe(true)
      expect(supervisorInput?.argv.some((value) => /^127\.0\.0\.1:9419:127\.0\.0\.1:\d+$/.test(value))).toBe(true)
      expect(supervisorInput?.timeoutMs).toBeUndefined()
      expect(JSON.parse(String(supervisorInput?.stdin))).toMatchObject({ authContent, controlToken: capability.token, directory: sandboxWorktree })
      expect(inputs.find(({ argv }) => argv.includes("apply"))?.stdin).toBe(capture.patch)
      const untrackedInput = inputs.find(({ argv }) => argv.at(-1) === "untracked.txt")
      expect(Buffer.from(untrackedInput?.stdin ?? "")).toEqual(Buffer.from("untracked change\n"))

      const lines: string[] = []
      await expect(sandbox.exec("printf 'first\\nsecond\\n'", { onLine: (line) => lines.push(line) })).resolves.toMatchObject({
        exitCode: 0,
        stdout: "first\nsecond\n",
      })
      expect(lines).toEqual(["first", "second"])
      const remoteOutput: string[] = []
      await expect(runCli(
        ["stop"],
        { SANDBOX_CONTROL_SOCKET: join(root, "control.sock"), SANDBOX_CONTROL_TOKEN: capability.token, SANDBOX_CONTROL_ROLE: "remote" },
        { stdout: (text) => remoteOutput.push(text) },
      )).resolves.toBe(0)
      expect(operations).toEqual(["stop"])
      expect(JSON.parse(remoteOutput[0] ?? "")).toMatchObject({ ok: true, operation: "stop", state: "remote" })
      await runSyncBarrier(sandbox)
      expect(await readFile(join(worktree.worktreePath, "new.txt"))).toEqual(Buffer.from([0, 1, 2, 255]))
      failCopyFileOut = true
      await expect(runSyncBarrier(sandbox)).rejects.toThrow()
      expect(calls.some((call) => call.includes(" stop "))).toBe(false)
      expect(calls.some((call) => call.includes(" rm --force "))).toBe(false)
    } finally {
      await sandbox?.close()
      await sandbox?.close()
      await worktree.close()
      await channel.close()
    }

    expect(terminateCount).toBe(1)
    expect(calls.some((call) => call.includes(" stop "))).toBe(true)
    expect(calls.some((call) => call.includes(" rm --force "))).toBe(true)
  })

  it("satisfies the isolated Sandcastle handle contract", async () => {
    const fixture = await prepareSbxHandleFixture()
    const handle: IsolatedSandboxHandle = fixture.provider.createIsolatedHandle(fixture.info)
    const binary = Buffer.from([0, 1, 2, 255])
    const outputPath = join(fixture.root, "output.bin")

    try {
      const lines: string[] = []
      await expect(handle.exec("printf 'first\nsecond\n'", { onLine: (line) => lines.push(line) })).resolves.toEqual({
        exitCode: 0,
        stdout: "first\nsecond\n",
        stderr: "",
      })
      expect(lines).toEqual(["first", "second"])

      await handle.copyIn(fixture.inputPath, "/workspace/project/input.bin")
      const copyIn = fixture.inputs.find(({ argv }) => argv.at(-1) === "/workspace/project/input.bin")
      expect(Buffer.from(copyIn?.stdin ?? "")).toEqual(binary)

      await handle.copyFileOut("/workspace/project/output.bin", outputPath)
      expect(await readFile(outputPath)).toEqual(binary)
    } finally {
      await handle.close()
      await handle.close()
    }

    expect(fixture.calls.filter((call) => call.includes(" stop "))).toHaveLength(1)
    expect(fixture.calls.filter((call) => call.includes(" rm --force "))).toHaveLength(1)
  })

  it("uses a private clone, streams the capture, and exports an isolated branch", async () => {
    const root = await temporaryDirectory()
    const baseSha = "0123456789012345678901234567890123456789"
    const branch = "opencode/sbx-0123456789"
    const clone = "/workspace/project"
    const commands: Array<{ argv: string[]; stdin?: string | Uint8Array }> = []
    const runner: ProcessRunner = {
      async run(input) {
        commands.push({ argv: input.argv, stdin: input.stdin })
        if (input.argv[0] === "sbx" && input.argv.includes("--show-toplevel")) {
          return { exitCode: 0, signal: null, stdout: `${clone}\n`, stderr: "" }
        }
        if (input.argv.includes("opencode") && input.argv.includes("--version")) return { exitCode: 0, signal: null, stdout: "1.18.23\n", stderr: "" }
        if (input.argv[0] === "sbx" && input.argv.includes("symbolic-ref")) {
          return { exitCode: 0, signal: null, stdout: `${branch}\n`, stderr: "" }
        }
        if (input.argv[0] === "sbx" && input.argv.includes("rev-parse")) {
          return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
        }
        if (input.argv[0] === "sbx" && input.argv.includes("diff") && input.argv.includes("--cached")) {
          return { exitCode: 1, signal: null, stdout: "", stderr: "" }
        }
        if (input.argv[0] === "git" && input.argv.includes("remote")) {
          return { exitCode: 0, signal: null, stdout: "sandbox remote\n", stderr: "" }
        }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
    }
    const ownership = fakeSbxOwnership()
    const provider = new SbxProvider({
      ...ownership,
      worktree: root,
      runner,
      reservePort: async () => 4101,
      fetcher: (async () => new Response(JSON.stringify({ healthy: true }), { status: 200 })) as unknown as typeof fetch,
    })
    const info = {
      id: "wrk_sbx",
      type: "sbx",
      name: "workspace",
      branch,
      directory: root,
      projectID: "prj_1",
      extra: { baseSha, sessionId: "ses_sbx", generation: 1 },
    }

    await provider.prepare(info, { OPENCODE_AUTH_CONTENT: "{}" })
    expect(commands.some(({ argv }) => argv.includes("--clone"))).toBe(true)
    const startup = commands.find(({ argv }) => argv.includes("python3") && argv.includes("-c"))
    expect(startup?.argv).not.toContain("{}")
    expect(JSON.parse(String(startup?.stdin))).toMatchObject({ authContent: "{}", port: 4096 })

    const content = new TextEncoder().encode("new\n")
    await provider.syncIn("wrk_sbx", { baseSha, patch: "", untracked: [{ path: "new.txt", sha256: sha256ForTest(content), content }] })
    const result = await provider.syncOut({ workspaceId: "wrk_sbx", directory: root, baseSha })
    expect(result).toEqual({ kind: "branch", baseSha, branch })
    expect(commands.some(({ argv }) => argv[0] === "git" && argv.includes("fetch") && argv.some((part) => part.startsWith("sandbox-")))).toBe(true)

    const create = commands.find(({ argv }) => argv.includes("create"))?.argv ?? []
    const sandbox = create[create.indexOf("--name") + 1]
    const ownershipId = sandbox ? await ownership.readOwnership(sandbox) : undefined
    if (!sandbox || !ownershipId) throw new Error("SBX ownership fixture is unavailable")
    ownership.setOwnership(sandbox, "x".repeat(43))
    await expect(provider.destroy(info)).rejects.toMatchObject({ code: "SBX_OWNERSHIP_UNVERIFIED" })
    ownership.setOwnership(sandbox, ownershipId)
    await provider.destroy(info)
    expect(commands.some(({ argv }) => argv.includes("stop"))).toBe(true)
    expect(commands.some(({ argv }) => argv.includes("rm") && argv.includes("--force"))).toBe(true)
  })

  it("does not reset a clean sandbox checkout with an unexpected commit", async () => {
    const root = await temporaryDirectory()
    const baseSha = "0123456789012345678901234567890123456789"
    const remoteSha = "fedcba9876543210fedcba9876543210fedcba98"
    const branch = "opencode/sbx-0123456789"
    const provider = new SbxProvider({
      ...fakeSbxOwnership(),
      worktree: root,
      reservePort: async () => 4101,
      runner: {
        async run(input) {
          if (input.argv[0] !== "sbx") return { exitCode: 0, signal: null, stdout: "", stderr: "" }
          if (input.argv.includes("create")) return { exitCode: 0, signal: null, stdout: "", stderr: "" }
          if (input.argv.includes("--show-toplevel")) return { exitCode: 0, signal: null, stdout: "/workspace/project\n", stderr: "" }
          if (input.argv.includes("opencode") && input.argv.includes("--version")) return { exitCode: 0, signal: null, stdout: "1.18.23\n", stderr: "" }
          if (input.argv.includes("rev-parse")) return { exitCode: 0, signal: null, stdout: `${remoteSha}\n`, stderr: "" }
          if (input.argv.includes("symbolic-ref")) return { exitCode: 0, signal: null, stdout: `${branch}\n`, stderr: "" }
          return { exitCode: 0, signal: null, stdout: "", stderr: "" }
        },
      },
    })

    await expect(provider.prepare({
      id: "wrk_sbx_mismatch",
      type: "sbx",
      name: "workspace",
      branch,
      directory: root,
      projectID: "prj_1",
      extra: { baseSha, sessionId: "ses_sbx_mismatch", generation: 1 },
    }, { OPENCODE_AUTH_CONTENT: "{}" })).rejects.toMatchObject({ code: "REMOTE_SHA_MISMATCH" })
  })

  it("does not inspect, reuse, or destroy an unowned SBX name", async () => {
    const baseSha = "0123456789012345678901234567890123456789"
    const commands: string[][] = []
    const provider = new SbxProvider({
      ...fakeSbxOwnership(),
      worktree: await temporaryDirectory(),
      reservePort: async () => 4101,
      runner: {
        async run(input) {
          commands.push(input.argv)
          if (input.argv[0] === "sbx" && input.argv.includes("create")) {
            return { exitCode: 1, signal: null, stdout: "", stderr: "name already exists" }
          }
          return { exitCode: 0, signal: null, stdout: "", stderr: "" }
        },
      },
    })
    const info = {
      id: "wrk_sbx_collision",
      type: "sbx",
      name: "workspace",
      branch: "opencode/sbx-collision",
      directory: "/tmp/project",
      projectID: "prj_1",
      extra: { baseSha, sessionId: "ses_1", generation: 1 },
    }

    await expect(provider.prepare({ ...info, extra: { baseSha } }, { OPENCODE_AUTH_CONTENT: "{}" })).rejects.toMatchObject({ code: "SBX_OWNERSHIP_UNVERIFIED" })
    await expect(provider.prepare({ ...info, extra: { ...info.extra, provider: "cloudflare" } }, { OPENCODE_AUTH_CONTENT: "{}" })).rejects.toMatchObject({ code: "SBX_OWNERSHIP_UNVERIFIED" })
    expect(commands).toHaveLength(0)
    await expect(provider.prepare(info, { OPENCODE_AUTH_CONTENT: "{}" })).rejects.toMatchObject({ code: "SBX_OWNERSHIP_UNVERIFIED" })
    const create = commands[0] ?? []
    const sandbox = create[create.indexOf("--name") + 1]
    await expect(provider.destroy({
      ...info,
      extra: { providerState: { ...info.extra, workspaceId: info.id, projectId: info.projectID, sandbox } },
    })).rejects.toMatchObject({ code: "SBX_OWNERSHIP_UNVERIFIED" })
    expect(commands).toHaveLength(1)
  })

  it("keeps the shared control proxy alive while another workspace is active", async () => {
    const root = await temporaryDirectory()
    const socketPath = join(root, "control.sock")
    const controlServer = createServer((socket) => socket.end())
    await new Promise<void>((resolve, reject) => {
      controlServer.once("error", reject)
      controlServer.listen(socketPath, resolve)
    })
    const baseSha = "0123456789012345678901234567890123456789"
    const supervisorInputs: string[][] = []
    const provider = new SbxProvider({
      ...fakeSbxOwnership(),
      worktree: root,
      deferActivation: true,
      localControlSocket: socketPath,
      controlTokenFor: async (sessionId) => `token-${sessionId}`,
      reservePort: async () => 4101 + supervisorInputs.length,
      fetcher: (async () => Response.json({ healthy: true })) as unknown as typeof fetch,
      supervisor: {
        async start(input) {
          supervisorInputs.push(input.argv)
          let finish!: (result: ProcessResult) => void
          const result = new Promise<ProcessResult>((resolve) => { finish = resolve })
          return {
            pid: 100 + supervisorInputs.length,
            result,
            terminate: () => finish({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" }),
          }
        },
      },
      runner: {
        async run(input) {
          if (input.argv[0] === "sbx" && input.argv.includes("--show-toplevel")) return { exitCode: 0, signal: null, stdout: "/workspace/project\n", stderr: "" }
          if (input.argv[0] === "sbx" && input.argv.includes("opencode") && input.argv.includes("--version")) return { exitCode: 0, signal: null, stdout: "1.18.23\n", stderr: "" }
          return { exitCode: 0, signal: null, stdout: "", stderr: "" }
        },
      },
    })
    const info = (id: string) => ({
      id,
      type: "sbx",
      name: id,
      branch: `opencode/${id}`,
      directory: root,
      projectID: "prj_1",
      extra: { baseSha, sessionId: `ses_${id}`, generation: 1 },
    })
    const first = info("first")
    const second = info("second")

    try {
      await Promise.all([
        provider.prepare(first, { OPENCODE_AUTH_CONTENT: "{}" }),
        provider.prepare(second, { OPENCODE_AUTH_CONTENT: "{}" }),
      ])
      await Promise.all([provider.activate(first.id), provider.activate(second.id)])
      const controlPorts = supervisorInputs.map((argv) => Number((argv[argv.indexOf("-R") + 1] ?? "").split(":").at(-1)))
      expect(new Set(controlPorts).size).toBe(1)
      const forwarding = supervisorInputs[0]?.at(supervisorInputs[0]!.indexOf("-R") + 1) ?? ""
      const controlPort = Number(forwarding.split(":").at(-1))

      await expect(provider.destroy({ ...info("missing"), extra: {} })).rejects.toMatchObject({ code: "SBX_OWNERSHIP_UNVERIFIED" })
      await expect(canConnect(controlPort)).resolves.toBeUndefined()

      await provider.release(first)

      await expect(canConnect(controlPort)).resolves.toBeUndefined()
    } finally {
      await provider.dispose().catch(() => undefined)
      await new Promise<void>((resolve) => controlServer.close(() => resolve()))
    }
  })

  it("removes a sandbox created before checkout fails", async () => {
    const root = await temporaryDirectory()
    const baseSha = "0123456789012345678901234567890123456789"
    let removed = false
    const provider = new SbxProvider({
      ...fakeSbxOwnership(),
      worktree: root,
      reservePort: async () => 4101,
      runner: {
        async run(input) {
          if (input.argv[0] === "git" && input.argv.includes("rev-parse")) return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
          if (input.argv[0] === "sbx" && input.argv.includes("create")) return { exitCode: 0, signal: null, stdout: "", stderr: "" }
          if (input.argv[0] === "sbx" && input.argv.includes("--show-toplevel")) return { exitCode: 1, signal: null, stdout: "", stderr: "checkout failed" }
          if (input.argv[0] === "sbx" && input.argv.includes("rm")) {
            removed = true
            return { exitCode: 0, signal: null, stdout: "", stderr: "" }
          }
          return { exitCode: 0, signal: null, stdout: "", stderr: "" }
        },
      },
    })

    await expect(provider.prepare({
      id: "wrk_failed_sbx",
      type: "sbx",
      name: "workspace",
      branch: "opencode/sbx-failed",
      directory: root,
      projectID: "prj_1",
      extra: { baseSha, sessionId: "ses_failed_sbx", generation: 1 },
    }, { OPENCODE_AUTH_CONTENT: "{}" })).rejects.toMatchObject({ code: "SBX_COMMAND" })
    expect(removed).toBe(true)
  })
})

describe("Cloudflare Sandbox bridge", () => {
  it("sends bearer authentication and parses streamed command output", async () => {
    const requests: Array<{ url: string; headers: Headers; body: string }> = []
    const output = Buffer.from("hello\n").toString("base64")
    const client = new CloudflareBridgeClient({
      apiUrl: "https://bridge.example.test/",
      apiKey: "private",
      fetcher: (async (input, init) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body ?? "") })
        return new Response(`event: stdout\ndata: ${output}\n\nevent: exit\ndata: {"exit_code":0}\n\n`, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      }) as typeof fetch,
    })

    await expect(client.exec("sandboxa2", { argv: ["printf", "hello"] })).resolves.toEqual({
      exitCode: 0,
      signal: null,
      stdout: "hello\n",
      stderr: "",
    })
    expect(requests[0]).toMatchObject({
      url: "https://bridge.example.test/v1/sandbox/sandboxa2/exec",
    })
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer private")
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ argv: ["printf", "hello"] })
  })

  it("delivers Cloudflare output before the command exits", async () => {
    const output = Buffer.from("hello\n").toString("base64")
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    let resolveLine: (() => void) | undefined
    const lineSeen = new Promise<void>((resolve) => { resolveLine = resolve })
    const client = new CloudflareBridgeClient({
      apiUrl: "https://bridge.example.test",
      apiKey: "private",
      fetcher: (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller
          controller.enqueue(new TextEncoder().encode(`event: stdout\ndata: ${output}\n\n`))
        },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } })) as unknown as typeof fetch,
    })
    const lines: string[] = []
    const result = client.exec("sandboxa2", {
      argv: ["cat"],
      stdin: "input",
      onLine: (line) => {
        lines.push(line)
        resolveLine?.()
      },
    })

    await lineSeen
    expect(lines).toEqual(["hello"])
    streamController?.enqueue(new TextEncoder().encode('event: exit\ndata: {"exit_code":0}\n\n'))
    streamController?.close()
    await expect(result).resolves.toMatchObject({ exitCode: 0, stdout: "hello\n" })
  })
})

describe("Cloudflare Sandbox provider", () => {
  it("hydrates a private checkout, starts OpenCode, and syncs captures", async () => {
    const root = await temporaryDirectory()
    const baseSha = "0123456789012345678901234567890123456789"
    const checkoutHead = "fedcba9876543210fedcba9876543210fedcba98"
    let observedHead = checkoutHead
    const calls: string[] = []
    const client: CloudflareSandboxClient = {
      async createSandbox() {
        calls.push("create")
        return "sandboxa2"
      },
      async destroySandbox(id) {
        calls.push(`destroy:${id}`)
      },
      async destroyTunnel(id, port) {
        calls.push(`destroy-tunnel:${id}:${port}`)
      },
      async running(id) {
        calls.push(`running:${id}`)
        return true
      },
      async exec(id, input) {
        calls.push(`exec:${id}:${input.argv[0] ?? ""}`)
        if (input.argv.includes("--is-inside-work-tree")) return { exitCode: 0, signal: null, stdout: "true\n", stderr: "" }
        if (input.argv.includes("rev-parse") && input.argv.at(-1) === "HEAD") return { exitCode: 0, signal: null, stdout: `${observedHead}\n`, stderr: "" }
        if (input.argv.includes("symbolic-ref")) return { exitCode: 0, signal: null, stdout: "opencode/sandbox-cf\n", stderr: "" }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
      async putFile(id, path) {
        calls.push(`put:${id}:${path}`)
      },
      async getFile(id, path) {
        calls.push(`get:${id}:${path}`)
        return new Uint8Array()
      },
      async hydrate(id, content) {
        calls.push(`hydrate:${id}:${content.byteLength}`)
      },
      async tunnel(id, port, name) {
        calls.push(`tunnel:${id}:${port}:${name}`)
        return { id: "tunnel_1", port, url: "https://sandbox.example.test" }
      },
    }
    const runner: ProcessRunner = {
      async run(input) {
        calls.push(`local:${input.argv.join(" ")}`)
        const output = input.argv.indexOf("-o")
        if (output >= 0) await writeFile(input.argv[output + 1] ?? "", "tar")
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
    }
    const provider = new CloudflareProvider({
      worktree: root,
      client,
      runner,
      fetcher: (async () => new Response(JSON.stringify({ healthy: true }), { status: 200 })) as unknown as typeof fetch,
    })
    const info = {
      id: "wrk_cf",
      type: "cloudflare",
      name: "workspace",
      branch: "opencode/sandbox-cf",
      directory: root,
      projectID: "prj_1",
      extra: { baseSha, sessionId: "ses_cf", generation: 1 },
    }

    await provider.prepare(info, { OPENCODE_AUTH_CONTENT: "{}" })
    expect(calls).toContain("create")
    expect(calls.some((call) => call.startsWith("hydrate:sandboxa2:"))).toBe(true)
    expect(calls.some((call) => call.startsWith("tunnel:sandboxa2:4096:oc-"))).toBe(true)
    await expect(provider.target(info)).resolves.toMatchObject({
      type: "remote",
      url: "https://sandbox.example.test",
      headers: { Authorization: expect.stringMatching(/^Basic /) },
    })

    const content = new TextEncoder().encode("new\n")
    await provider.syncIn("wrk_cf", {
      baseSha,
      patch: "diff --git a/a b/a\n",
      untracked: [{ path: "nested.txt", sha256: sha256ForTest(content), content }],
    })
    expect(calls.some((call) => call.includes("capture-") && call.startsWith("put:"))).toBe(true)
    expect(calls.some((call) => call.endsWith(":/workspace/nested.txt"))).toBe(true)

    await provider.release(info)
    await provider.prepare(info, { OPENCODE_AUTH_CONTENT: "{}" })
    expect(calls.filter((call) => call === "create")).toHaveLength(1)
    await provider.release(info)
    observedHead = baseSha
    await expect(provider.prepare(info, { OPENCODE_AUTH_CONTENT: "{}" })).rejects.toMatchObject({ code: "REMOTE_SHA_MISMATCH" })
    await provider.destroy(info)
    expect(calls).toContain("destroy-tunnel:sandboxa2:4096")
    expect(calls).toContain("destroy:sandboxa2")
  })

  it("fails cleanup when the remote cleanup command fails", async () => {
    const root = await temporaryDirectory()
    const baseSha = "0123456789012345678901234567890123456789"
    let tunnelDestroyed = false
    const provider = new CloudflareProvider({
      worktree: root,
      deferActivation: true,
      runner: {
        async run(input) {
          const output = input.argv.indexOf("-o")
          if (output >= 0) await writeFile(input.argv[output + 1] ?? "", "tar")
          return { exitCode: 0, signal: null, stdout: "", stderr: "" }
        },
      },
      client: {
        async createSandbox() { return "sandboxa2" },
        async destroySandbox() {},
        async destroyTunnel() { tunnelDestroyed = true },
        async running() { return true },
        async exec(_id, input) {
          if (input.argv[0] === "sh" && input.argv[2]?.includes("rm -rf --")) {
            return { exitCode: 1, signal: null, stdout: "", stderr: "cleanup failed" }
          }
          if (input.argv.includes("rev-parse")) return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
          return { exitCode: 0, signal: null, stdout: "", stderr: "" }
        },
        async putFile() {},
        async getFile() { return new Uint8Array() },
        async hydrate() {},
        async tunnel(_id, port) { return { id: "tunnel_1", port, url: "https://sandbox.example.test" } },
      },
    })
    const info = {
      id: "wrk_cf_cleanup",
      type: "cloudflare",
      name: "workspace",
      branch: "opencode/cloudflare-cleanup",
      directory: root,
      projectID: "prj_1",
      extra: { baseSha, sessionId: "ses_1", generation: 1 },
    }

    await provider.prepare(info, { OPENCODE_AUTH_CONTENT: "{}" })
    await expect(provider.release(info)).rejects.toMatchObject({ code: "CLOUDFLARE_COMMAND" })
    expect(tunnelDestroyed).toBe(true)
  })

  it("does not inspect or reuse an unowned Cloudflare sandbox ID", async () => {
    const baseSha = "0123456789012345678901234567890123456789"
    let inspected = false
    const provider = new CloudflareProvider({
      worktree: await temporaryDirectory(),
      client: {
        async createSandbox() { throw new Error("must not create") },
        async destroySandbox() {},
        async destroyTunnel() {},
        async running() { inspected = true; return true },
        async exec(_id, input) {
          inspected = true
          if (input.argv.includes("--is-inside-work-tree")) return { exitCode: 0, signal: null, stdout: "true\n", stderr: "" }
          if (input.argv.includes("rev-parse") && input.argv.at(-1) === "HEAD") return { exitCode: 0, signal: null, stdout: "fedcba9876543210fedcba9876543210fedcba98\n", stderr: "" }
          return { exitCode: 0, signal: null, stdout: "opencode/cloudflare-reuse\n", stderr: "" }
        },
        async putFile() {},
        async getFile() { return new Uint8Array() },
        async hydrate() {},
        async tunnel(_id, port) { return { id: "tunnel_1", port, url: "https://sandbox.example.test" } },
      },
    })

    const info = {
      id: "wrk_cf_reuse",
      type: "cloudflare",
      name: "workspace",
      branch: "opencode/cloudflare-reuse",
      directory: "/tmp/project",
      projectID: "prj_1",
      extra: { providerState: { sandboxId: "sandboxa2", baseSha, checkoutHead: baseSha, branch: "opencode/cloudflare-reuse", sessionId: "ses_1", generation: 1 } },
    }

    await expect(provider.prepare({ ...info, extra: { baseSha } }, { OPENCODE_AUTH_CONTENT: "{}" })).rejects.toMatchObject({ code: "CLOUDFLARE_OWNERSHIP_UNVERIFIED" })
    await expect(provider.prepare({ ...info, extra: { ...info.extra, provider: "sbx" } }, { OPENCODE_AUTH_CONTENT: "{}" })).rejects.toMatchObject({ code: "CLOUDFLARE_OWNERSHIP_UNVERIFIED" })
    await expect(provider.prepare(info, { OPENCODE_AUTH_CONTENT: "{}" })).rejects.toMatchObject({ code: "CLOUDFLARE_OWNERSHIP_UNVERIFIED" })
    expect(inspected).toBe(false)
  })

  it("routes Cloudflare mailbox control through the local capability channel", async () => {
    const root = await temporaryDirectory()
    await runGit(root, ["init", "-q"])
    await runGit(root, ["config", "user.email", "test@example.invalid"])
    await runGit(root, ["config", "user.name", "Sandbox Test"])
    await writeFile(join(root, "tracked.txt"), "base\n")
    await runGit(root, ["add", "tracked.txt"])
    await runGit(root, ["commit", "-q", "-m", "initial"])
    const head = await nodeProcessRunner.run({ argv: ["git", "-C", root, "rev-parse", "HEAD"], cwd: root })
    const baseSha = head.stdout.trim()
    const socketPath = join(root, "control.sock")
    const requestName = "01234567-89ab-cdef-0123-456789abcdef.request"
    const capability = createCapability({ sessionId: "ses_cf", generation: 1, role: "remote" })
    const operations: string[] = []
    let requestVisible = false
    let responseText = ""
    const channel = new ControlChannel({
      socketPath,
      handler: async (request) => {
        operations.push(request.operation)
        return { ok: true, operation: request.operation, state: "remote", message: "handled" }
      },
    })
    channel.register(capability)
    await channel.start()
    const client: CloudflareSandboxClient = {
      async createSandbox() { return "sandboxa2" },
      async destroySandbox() {},
      async destroyTunnel() {},
      async running() { return true },
      async exec(id, input) {
        if (input.argv[0] === "find" && requestVisible) {
          return { exitCode: 0, signal: null, stdout: `${input.argv[1]}/${requestName}\n`, stderr: "" }
        }
        if (input.argv.includes("rev-parse") && input.argv.at(-1) === "HEAD") {
          return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
        }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
      async putFile(_id, path, content) {
        if (path.endsWith(".response.writing")) responseText = new TextDecoder().decode(content)
      },
      async getFile(_id, path) {
        requestVisible = false
        return new TextEncoder().encode(JSON.stringify({ token: capability.token, body: { operation: "status" } }))
      },
      async hydrate() {},
      async tunnel(_id, port, name) { return { id: "tunnel_1", port, url: `https://${name}.example.test` } },
    }
    const provider = new CloudflareProvider({
      worktree: root,
      client,
      deferActivation: true,
      localControlSocket: socketPath,
      controlTokenFor: async () => capability.token,
      fetcher: (async () => new Response(JSON.stringify({ healthy: true }), { status: 200 })) as unknown as typeof fetch,
    })
    const info = {
      id: "wrk_cf_control",
      type: "cloudflare",
      name: "workspace",
      branch: "opencode/cloudflare-control",
      directory: root,
      projectID: "prj_1",
      extra: { baseSha, sessionId: "ses_cf", generation: 1 },
    }

    try {
      await provider.prepare(info, { OPENCODE_AUTH_CONTENT: "{}" })
      await provider.activate(info.id)
      requestVisible = true
      for (let attempt = 0; attempt < 100 && !responseText; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(operations).toEqual(["status"])
      expect(JSON.parse(responseText)).toMatchObject({ status: 200, body: { ok: true, operation: "status" } })
    } finally {
      await provider.release(info).catch(() => undefined)
      await provider.destroy(info).catch(() => undefined)
      await channel.close()
    }
  })

  it("exposes Cloudflare as an isolated Sandcastle provider", async () => {
    const root = await temporaryDirectory()
    await runGit(root, ["init", "-q"])
    await runGit(root, ["config", "user.email", "test@example.invalid"])
    await runGit(root, ["config", "user.name", "Sandbox Test"])
    await writeFile(join(root, "tracked.txt"), "base\n")
    await runGit(root, ["add", "tracked.txt"])
    await runGit(root, ["commit", "-q", "-m", "initial"])
    const head = await nodeProcessRunner.run({ argv: ["git", "-C", root, "rev-parse", "HEAD"], cwd: root })
    const baseSha = head.stdout.trim()
    const calls: string[] = []
    const client: CloudflareSandboxClient = {
      async createSandbox() {
        calls.push("create")
        return "sandboxa2"
      },
      async destroySandbox(id) {
        calls.push(`destroy:${id}`)
      },
      async destroyTunnel(id, port) {
        calls.push(`destroy-tunnel:${id}:${port}`)
      },
      async running() {
        return true
      },
      async exec(id, input) {
        calls.push(`exec:${id}:${input.argv[0] ?? ""}`)
        if (input.argv.includes("rev-parse") && input.argv.at(-1) === "HEAD") return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
        if (input.onLine) {
          input.onLine("first")
          input.onLine("second")
          return { exitCode: 0, signal: null, stdout: "first\nsecond\n", stderr: "" }
        }
        if (input.argv[0] === "test" && input.argv[1] === "-L") {
          return { exitCode: 1, signal: null, stdout: "", stderr: "" }
        }
        const command = input.argv.at(-1) ?? ""
        if (command.includes("git rev-parse HEAD")) return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
        if (command.includes("git symbolic-ref --short HEAD")) return { exitCode: 0, signal: null, stdout: "opencode/cloudflare-sandcastle\n", stderr: "" }
        if (command.includes("git ls-files --others")) return { exitCode: 0, signal: null, stdout: "download.txt\n", stderr: "" }
        if (command.includes("mktemp -d")) return { exitCode: 0, signal: null, stdout: "/tmp/cloudflare-sbx\n", stderr: "" }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
      async putFile(id, path) {
        calls.push(`put:${id}:${path}`)
      },
      async getFile(id, path) {
        calls.push(`get:${id}:${path}`)
        return new TextEncoder().encode("downloaded\n")
      },
      async hydrate(id) {
        calls.push(`hydrate:${id}`)
      },
      async tunnel(id, port, name) {
        calls.push(`tunnel:${id}:${port}:${name}`)
        return { id: "tunnel_1", port, url: "https://sandbox.example.test" }
      },
    }
    const adapter = createCloudflareSandcastleAdapter({
      input: {
        sessionId: "ses_cf",
        projectId: "prj_1",
        workspaceId: "wrk_cf_sandcastle",
        generation: 1,
        branch: "opencode/cloudflare-sandcastle",
        baseSha,
        context: { sessionId: "ses_cf", projectId: "prj_1", directory: root, worktree: root },
      },
      worktree: root,
      client,
      authContent: "{}",
      localControlSocket: join(root, "control.sock"),
      controlTokenFor: async () => "private",
      revokeControlToken: (token) => calls.push(`revoke:${token}`),
      fetcher: (async () => new Response(JSON.stringify({ healthy: true }), { status: 200 })) as unknown as typeof fetch,
    })
    const worktree = await createWorktree({
      cwd: root,
      branchStrategy: { type: "branch", branch: "opencode/cloudflare-sandcastle", baseBranch: baseSha },
    })
    let sandbox
    try {
      sandbox = await worktree.createSandbox({ sandbox: adapter.provider })
      expect(calls).not.toContain("tunnel:sandboxa2:4096:oc-wrk-cf-sandcastle")
      await adapter.applyCapture({ sandbox, capture: { baseSha, patch: "", untracked: [] } })
      expect(calls.some((call) => call.startsWith("tunnel:sandboxa2:4096:oc-"))).toBe(true)
      await expect(adapter.target()).resolves.toMatchObject({ type: "remote", url: "https://sandbox.example.test" })

      const lines: string[] = []
      await expect(sandbox.exec("printf output", { onLine: (line) => lines.push(line) })).resolves.toMatchObject({ exitCode: 0 })
      expect(lines).toEqual(["first", "second"])
      await runSyncBarrier(sandbox)
      expect(await readFile(join(worktree.worktreePath, "download.txt"), "utf8")).toBe("downloaded\n")
    } finally {
      await sandbox?.close()
      await worktree.close()
    }

    expect(calls).toContain("destroy:sandboxa2")
    expect(calls).toContain("revoke:private")
  })
})

describe("provider-owned deletion", () => {
  it("deletes a non-VM provider through its destroy callback", async () => {
    const record = { ...makeRecord(), provider: "sbx", providerState: { sandbox: "oc-sbx-test" }, vmName: undefined, vmIdentity: undefined, state: "detached" as const }
    const store = new FileStateStore(await temporaryDirectory())
    await store.write(record)
    let destroyed = false
    const controller = new LifecycleController({
      store,
      providerType: "sbx",
      providerDestroy: async () => {
        destroyed = true
      },
      workspace: {
        async create() {
          throw new Error("must not create")
        },
        async warp() {},
        async remove() {},
      },
    })
    const capability = createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" })

    await expect(controller.handle({ operation: "delete", force: false, capability })).resolves.toMatchObject({ ok: true, state: "delete_pending" })
    await controller.onSessionIdle(record.sessionId)

    expect(destroyed).toBe(true)
    expect((await store.get(record.sessionId))?.state).toBe("deleted")
  })
})

describe("working tree capture", () => {
  it("ignores Sandcastle worktrees while capturing user files", async () => {
    const root = await temporaryDirectory()
    await runGit(root, ["init", "-q"])
    await runGit(root, ["config", "user.email", "test@example.invalid"])
    await runGit(root, ["config", "user.name", "Test"])
    await writeFile(join(root, "tracked.txt"), "base\n")
    await runGit(root, ["add", "tracked.txt"])
    await runGit(root, ["commit", "-q", "-m", "initial"])
    await writeFile(join(root, "untracked.txt"), "user input\n")
    const managedWorktree = join(root, ".sandcastle", "worktrees", "active")
    await mkdir(managedWorktree, { recursive: true })
    await runGit(managedWorktree, ["init", "-q"])

    const capture = await captureWorkingTree({
      sessionId: "ses_1",
      projectId: "prj_1",
      directory: root,
      worktree: root,
    })

    expect(capture.untracked.map((file) => file.path)).toEqual(["untracked.txt"])
  })

  it("captures tracked patches and untracked files without a shell", async () => {
    const root = await temporaryDirectory()
    await runGit(root, ["init", "-q"])
    await runGit(root, ["config", "user.email", "test@example.invalid"])
    await runGit(root, ["config", "user.name", "Test"])
    await writeFile(join(root, "tracked.txt"), "before\n")
    await runGit(root, ["add", "tracked.txt"])
    await runGit(root, ["commit", "-q", "-m", "initial"])
    await writeFile(join(root, "tracked.txt"), "after\n")
    await writeFile(join(root, "untracked.txt"), "new\n")

    const capture = await captureWorkingTree({
      sessionId: "ses_1",
      projectId: "prj_1",
      directory: root,
      worktree: root,
    })

    expect(capture.baseSha).toMatch(/^[a-f0-9]{40}$/)
    expect(capture.patch).toContain("before")
    expect(capture.patch).toContain("after")
    expect(capture.untracked).toHaveLength(1)
    expect(capture.untracked[0]?.path).toBe("untracked.txt")
    expect(new TextDecoder().decode(capture.untracked[0]?.content)).toBe("new\n")
  })
})

async function runGit(cwd: string, args: string[]): Promise<void> {
  const result = await nodeProcessRunner.run({ argv: ["git", "-C", cwd, ...args], cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args[0]} failed`)
}

async function prepareSbxHandleFixture() {
  const root = await temporaryDirectory()
  const inputPath = join(root, "input.bin")
  await writeFile(inputPath, Buffer.from([0, 1, 2, 255]))
  const baseSha = "0123456789012345678901234567890123456789"
  const branch = "opencode/sbx-contract"
  const clone = "/workspace/project"
  const calls: string[] = []
  const inputs: Array<{ argv: string[]; stdin?: string | Uint8Array }> = []
  const runner: ProcessRunner = {
    async run(input) {
      calls.push(input.argv.join(" "))
      inputs.push({ argv: input.argv, stdin: input.stdin })
      if (input.argv[0] !== "sbx") return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      if (input.argv.includes("--show-toplevel")) return { exitCode: 0, signal: null, stdout: `${clone}\n`, stderr: "" }
      if (input.argv.includes("opencode") && input.argv.includes("--version")) return { exitCode: 0, signal: null, stdout: "1.18.23\n", stderr: "" }
      if (input.argv.includes("symbolic-ref")) return { exitCode: 0, signal: null, stdout: `${branch}\n`, stderr: "" }
      if (input.argv.some((value) => value.includes("rev-parse"))) return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
      if (input.argv.some((value) => value.includes("base64.b64encode"))) {
        return { exitCode: 0, signal: null, stdout: Buffer.from([0, 1, 2, 255]).toString("base64"), stderr: "" }
      }
      const command = input.argv.at(-1) ?? ""
      if (command.includes("printf")) {
        input.onLine?.("first")
        input.onLine?.("second")
        return { exitCode: 0, signal: null, stdout: "first\nsecond\n", stderr: "" }
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "" }
    },
  }
  const provider = new SbxProvider({
    ...fakeSbxOwnership(),
    worktree: root,
    runner,
    reservePort: async () => 4101,
    fetcher: (async () => new Response(JSON.stringify({ healthy: true }), { status: 200 })) as unknown as typeof fetch,
  })
  const info = {
    id: "wrk_sbx_contract",
    type: "sbx",
    name: "workspace",
    branch,
    directory: root,
    projectID: "prj_1",
    extra: { baseSha, sessionId: "ses_sbx_contract", generation: 1 },
  }

  await provider.prepare(info, { OPENCODE_AUTH_CONTENT: "{}" })
  return { provider, info, root, inputPath, calls, inputs }
}

function makeRecord(): SandboxRecord {
  return {
    sessionId: "ses_1",
    workspaceId: "wrk_1",
    projectId: "prj_1",
    provider: "exedev",
    providerState: {},
    vmName: "oc-0123456789",
    vmIdentity: {
      name: "oc-0123456789",
      sshDest: "vm.exe.xyz",
      tags: ["opencode-sandbox"],
      comment: "opencode-abc",
    },
    generation: 1,
    directory: "/tmp/project",
    branch: "opencode/sandbox-0123456789",
    baseSha: "0123456789012345678901234567890123456789",
    state: "local",
    createdAt: new Date(1000).toISOString(),
    updatedAt: new Date(1000).toISOString(),
  }
}

function sha256ForTest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function fakeSbxOwnership(): {
  writeOwnership(sandbox: string, ownershipId: string): Promise<void>
  readOwnership(sandbox: string): Promise<string | undefined>
  setOwnership(sandbox: string, ownershipId: string): void
} {
  const values = new Map<string, string>()
  return {
    async writeOwnership(sandbox, ownershipId) { values.set(sandbox, ownershipId) },
    async readOwnership(sandbox) { return values.get(sandbox) },
    setOwnership(sandbox, ownershipId) { values.set(sandbox, ownershipId) },
  }
}

function canConnect(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port })
    socket.once("connect", () => {
      socket.end()
      resolve()
    })
    socket.once("error", reject)
  })
}
