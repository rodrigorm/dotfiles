import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ControlChannel, createCapability } from "./control-channel"
import { runCli } from "./cli"
import { LifecycleController } from "./lifecycle"
import {
  boundOperationJournal,
  FileStateStore,
} from "./state-store"
import {
  MAX_OPERATION_JOURNAL_BYTES,
  MAX_OPERATION_JOURNAL_ENTRIES,
  MAX_OPERATION_JOURNAL_EVIDENCE_BYTES,
  MAX_OPERATION_JOURNAL_EVIDENCE_REFS,
  MAX_OPERATION_JOURNAL_STRING_BYTES,
  SandboxError,
  type RuntimeDriver,
  type SandboxJournalEntry,
  type SandboxRecord,
} from "./types"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("operation journal", () => {
  it("retains the newest bounded, redacted entries", () => {
    const entries: SandboxJournalEntry[] = Array.from({ length: MAX_OPERATION_JOURNAL_ENTRIES + 8 }, (_, index) => ({
      requestId: `request-${index}`,
      operation: "start",
      startedAt: new Date(index * 1_000).toISOString(),
      endedAt: new Date(index * 1_000 + 1).toISOString(),
      resultCode: `RESULT_${index}`,
      evidence: [`token=private-${index}`, "x".repeat(MAX_OPERATION_JOURNAL_STRING_BYTES * 2)],
    }))

    const bounded = boundOperationJournal(entries)

    expect(bounded).toHaveLength(MAX_OPERATION_JOURNAL_ENTRIES)
    expect(bounded[0]?.requestId).toBe("request-8")
    expect(bounded.at(-1)?.requestId).toBe("request-39")
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(MAX_OPERATION_JOURNAL_BYTES)
    expect(JSON.stringify(bounded)).not.toContain("private-")
    expect(bounded.every((entry) => entry.evidence.length <= MAX_OPERATION_JOURNAL_EVIDENCE_REFS)).toBe(true)
    expect(bounded.every((entry) => Buffer.byteLength(entry.resultCode) <= MAX_OPERATION_JOURNAL_STRING_BYTES)).toBe(true)
  })

  it("preserves and whitelists an optional journal during legacy migration", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    const base = makeRecord({ state: "remote" })
    const { desiredLocation: _desiredLocation, phase: _phase, ...legacy } = base
    const journal = {
      requestId: "migration-request",
      operation: "start" as const,
      startedAt: new Date(1_000).toISOString(),
      endedAt: new Date(2_000).toISOString(),
      resultCode: "OK",
      evidence: ["token=private", "kept"],
      ignored: "not persisted",
    }
    await writeFile(store.recordPath(base.sessionId), `${JSON.stringify({ ...legacy, state: "remote", journal: [journal] })}\n`, { encoding: "utf8", mode: 0o600 })

    const migrated = await store.get(base.sessionId)
    const persisted = JSON.parse(await readFile(store.recordPath(base.sessionId), "utf8")) as Record<string, unknown>

    expect(migrated?.journal).toEqual([{
      requestId: "migration-request",
      operation: "start",
      startedAt: new Date(1_000).toISOString(),
      endedAt: new Date(2_000).toISOString(),
      resultCode: "OK",
      evidence: ["token=[REDACTED]", "kept"],
    }])
    expect(persisted).toMatchObject({ schemaVersion: 1, journal: migrated?.journal })
    expect(JSON.stringify(persisted)).not.toContain("ignored")
    expect(JSON.stringify(persisted)).not.toContain("private")
  })

  it("uses the same request ID in the V2 response and durable entry", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    const controller = new LifecycleController({
      store,
      capture: async () => ({ baseSha: makeRecord().baseSha, patch: "", untracked: [] }),
      workspace: workspaceGateway(),
    })
    const capability = createCapability({ sessionId: "ses_1", generation: 1, role: "host" })
    controller.registerContext({ sessionId: "ses_1", projectId: "prj_1", directory: "/tmp/project", worktree: "/tmp/project" })

    const response = await controller.handle({ operation: "start", force: false, requestId: "start-request", capability })
    const record = await store.get("ses_1")

    expect(response.requestId).toBe("start-request")
    expect(record?.journal?.[0]).toMatchObject({ requestId: "start-request", operation: "start", resultCode: "PENDING" })
  })

  it("completes an immediate result without a second record lock", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    await store.write(makeRecord())
    const withRecordLock = store.withRecordLock.bind(store)
    let lockCalls = 0
    store.withRecordLock = (async (sessionId, operation) => {
      lockCalls++
      if (lockCalls === 2) throw new SandboxError("validate", "session is already locked", "STATE_LOCKED")
      return withRecordLock(sessionId, operation)
    }) as FileStateStore["withRecordLock"]

    const controller = new LifecycleController({ store, workspace: workspaceGateway() })
    const capability = createCapability({ sessionId: "ses_1", generation: 1, role: "host" })
    const response = await controller.handle({ operation: "stop", force: false, requestId: "locked-stop", capability })
    const entry = (await store.get("ses_1"))?.journal?.[0]

    expect(response).toMatchObject({ requestId: "locked-stop", ok: true })
    expect(lockCalls).toBe(1)
    expect(entry).toMatchObject({ requestId: "locked-stop", resultCode: "OK" })
    expect(entry?.endedAt).toBeString()
  })

  it("rejects reused request IDs before same- or different-operation mutation", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    await store.write(makeRecord())
    let creates = 0
    const workspace = workspaceGateway()
    const create = workspace.create
    workspace.create = async (input) => {
      creates++
      return create(input)
    }
    const controller = new LifecycleController({
      store,
      capture: async () => ({ baseSha: makeRecord().baseSha, patch: "", untracked: [] }),
      workspace,
    })
    const capability = createCapability({ sessionId: "ses_1", generation: 1, role: "host" })
    controller.registerContext({ sessionId: "ses_1", projectId: "prj_1", directory: "/tmp/project", worktree: "/tmp/project" })

    await expect(controller.handle({ operation: "stop", force: false, requestId: "reused", capability })).resolves.toMatchObject({ ok: true, requestId: "reused" })
    const sameOperation = await controller.handle({ operation: "stop", force: false, requestId: "reused", capability })
    const differentOperation = await controller.handle({ operation: "start", force: false, requestId: "reused", capability })
    const record = await store.get("ses_1")

    expect(sameOperation).toMatchObject({ ok: false, requestId: "reused", error: { code: "REQUEST_ID_REUSED" } })
    expect(differentOperation).toMatchObject({ ok: false, requestId: "reused", error: { code: "REQUEST_ID_REUSED" } })
    expect(creates).toBe(0)
    expect(record?.journal).toHaveLength(1)
    expect(record?.journal?.[0]).toMatchObject({ requestId: "reused", operation: "stop", resultCode: "OK" })
  })

  it("records and redacts a failed asynchronous completion", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    const controller = new LifecycleController({
      store,
      capture: async () => ({ baseSha: makeRecord().baseSha, patch: "", untracked: [] }),
      workspace: workspaceGateway(async () => {
        throw new SandboxError("sync", "token=private", "ASYNC_FAILED")
      }),
    })
    const capability = createCapability({ sessionId: "ses_1", generation: 1, role: "host" })
    controller.registerContext({ sessionId: "ses_1", projectId: "prj_1", directory: "/tmp/project", worktree: "/tmp/project" })

    await controller.handle({ operation: "start", force: false, requestId: "async-start", capability })
    await controller.onSessionIdle("ses_1")
    const record = await store.get("ses_1")
    const entry = record?.journal?.[0]

    expect(entry).toMatchObject({ requestId: "async-start", resultCode: "ASYNC_FAILED" })
    expect(entry?.endedAt).toBeString()
    expect(JSON.stringify(record)).not.toContain("private")
  })

  it("does not create records for read-only or unauthorized requests", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    const controller = new LifecycleController({ store, workspace: workspaceGateway() })
    const host = createCapability({ sessionId: "ses_1", generation: 1, role: "host" })
    const remote = createCapability({ sessionId: "ses_2", generation: 1, role: "remote" })
    await store.write(makeRecord())
    const before = await readFile(store.recordPath("ses_1"), "utf8")

    await controller.handle({ operation: "status", force: false, capability: host })
    await controller.handle({ operation: "inspect", force: false, capability: host })
    await controller.handle({ operation: "start", force: false, requestId: "unauthorized", capability: remote })

    expect(await readFile(store.recordPath("ses_1"), "utf8")).toBe(before)
    expect((await store.list()).filter((record) => record.sessionId === "ses_2")).toHaveLength(0)
    expect((await readdir(root)).filter((name) => name.endsWith(".json"))).toHaveLength(1)
  })

  it("keeps concurrent recovery requests correlated without duplicate adoption", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    const record = makeRecord({
      provider: "fake",
      providerState: { resourceId: "resource-1" },
      state: "remote",
      desiredLocation: "remote",
      phase: "idle",
    })
    await store.write(record)

    let adoptCount = 0
    let signalAdoptionStarted: () => void = () => undefined
    const adoptionStarted = new Promise<void>((resolve) => { signalAdoptionStarted = resolve })
    let releaseAdoption: () => void = () => undefined
    const adoptionReleased = new Promise<void>((resolve) => { releaseAdoption = resolve })
    const runtimeDriver: RuntimeDriver = {
      async inspect() {
        return { resourceId: "resource-1", resource: "present", ownership: "verified", health: "healthy", evidence: [] }
      },
      async adopt({ owner }) {
        adoptCount++
        signalAdoptionStarted()
        await adoptionReleased
        return {
          workspaceId: owner.workspaceId,
          target: { type: "remote", url: "https://runtime.example.test" },
        }
      },
      async sync() {},
      async close() { return {} },
      async destroy() {},
    }
    const controller = new LifecycleController({
      store,
      runtimeDriver,
      workspace: {
        async create() { throw new Error("not used") },
        async warp() {},
        async remove() {},
        async startSync() {},
        async waitForSync() {},
        async replaySession() {},
        async inspect() { return undefined },
      },
    })
    const capability = createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" })
    const first = controller.handle({ operation: "recover", force: false, requestId: "recover-1", capability })
    await adoptionStarted
    const second = controller.handle({ operation: "recover", force: false, requestId: "recover-2", capability })
    releaseAdoption()
    const results = await Promise.all([first, second])
    const journal = (await store.get(record.sessionId))?.journal ?? []

    expect(results.map((result) => result.requestId)).toEqual(["recover-1", "recover-2"])
    expect(results.every((result) => result.ok)).toBe(true)
    expect(adoptCount).toBe(1)
    expect(journal).toHaveLength(2)
    expect(journal.map((entry) => entry.requestId)).toEqual(["recover-1", "recover-2"])
    expect(journal.every((entry) => entry.resultCode === "OK" && entry.endedAt)).toBe(true)
  })
})

describe("control request correlation", () => {
  it("keeps the CLI request ID through the control channel", async () => {
    const root = await temporaryDirectory()
    const channel = new ControlChannel({
      socketPath: join(root, "control.sock"),
      handler: async (request) => ({
        ok: true,
        operation: request.operation,
        state: "local",
        message: "ok",
        details: { receivedRequestId: request.requestId },
      }),
    })
    const capability = createCapability({ sessionId: "ses_1", generation: 1, role: "host" })
    channel.register(capability)
    await channel.start()

    try {
      const output: string[] = []
      await expect(runCli(["status"], {
        SANDBOX_CONTROL_SOCKET: channel.socketPath,
        SANDBOX_CONTROL_TOKEN: capability.token,
      }, { stdout: (text) => output.push(text) })).resolves.toBe(0)
      const result = JSON.parse(output[0] ?? "") as { requestId: string; details: { receivedRequestId: string } }

      expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/)
      expect(result.details.receivedRequestId).toBe(result.requestId)
    } finally {
      await channel.close()
    }
  })

  it("keeps the sent request ID on a transport schema failure", async () => {
    let sentRequestId = ""
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
      request.on("end", () => {
        sentRequestId = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { requestId: string }).requestId
        response.statusCode = 200
        response.end("{}")
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("test server did not expose a port")
      const output: string[] = []
      await expect(runCli(["status"], {
        SANDBOX_CONTROL_HOST: "127.0.0.1",
        SANDBOX_CONTROL_PORT: String(address.port),
        SANDBOX_CONTROL_TOKEN: "private",
      }, { stdout: (text) => output.push(text) })).resolves.toBe(1)

      expect(sentRequestId).toMatch(/^[0-9a-f-]{36}$/)
      expect(JSON.parse(output[0] ?? "")).toMatchObject({ requestId: sentRequestId, error: { code: "RESPONSE_SCHEMA" } })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("keeps the sent request ID when the control transport disconnects", async () => {
    let sentRequestId = ""
    const server = createServer((request) => {
      const chunks: Buffer[] = []
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
      request.on("end", () => {
        sentRequestId = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { requestId: string }).requestId
        request.socket.destroy()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("test server did not expose a port")
      const output: string[] = []
      await expect(runCli(["status"], {
        SANDBOX_CONTROL_HOST: "127.0.0.1",
        SANDBOX_CONTROL_PORT: String(address.port),
        SANDBOX_CONTROL_TOKEN: "private",
      }, { stdout: (text) => output.push(text) })).resolves.toBe(1)

      expect(sentRequestId).toMatch(/^[0-9a-f-]{36}$/)
      expect(JSON.parse(output[0] ?? "")).toMatchObject({ requestId: sentRequestId, error: { code: "CONTROL_CHANNEL" } })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("truncates journal strings and evidence on UTF-8 boundaries", () => {
    const splitCodePoint = `${"a".repeat(MAX_OPERATION_JOURNAL_STRING_BYTES - 1)}😀`
    const bounded = boundOperationJournal([{
      requestId: "utf8",
      operation: "start",
      startedAt: splitCodePoint,
      endedAt: splitCodePoint,
      resultCode: splitCodePoint,
      evidence: [splitCodePoint, "😀".repeat(MAX_OPERATION_JOURNAL_STRING_BYTES)],
    }])
    const entry = bounded[0]

    expect(entry).toBeDefined()
    expect(Buffer.byteLength(entry?.startedAt ?? "")).toBeLessThanOrEqual(MAX_OPERATION_JOURNAL_STRING_BYTES)
    expect(Buffer.byteLength(entry?.endedAt ?? "")).toBeLessThanOrEqual(MAX_OPERATION_JOURNAL_STRING_BYTES)
    expect(Buffer.byteLength(entry?.resultCode ?? "")).toBeLessThanOrEqual(MAX_OPERATION_JOURNAL_STRING_BYTES)
    expect(entry?.startedAt).not.toContain("\uFFFD")
    expect(entry?.evidence.every((value) => Buffer.byteLength(value) <= MAX_OPERATION_JOURNAL_STRING_BYTES)).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(entry?.evidence ?? []))).toBeLessThanOrEqual(MAX_OPERATION_JOURNAL_EVIDENCE_BYTES)
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(MAX_OPERATION_JOURNAL_BYTES)
  })
})

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opencode-journal-test-"))
  roots.push(root)
  return root
}

function makeRecord(overrides: Partial<SandboxRecord> = {}): SandboxRecord {
  return {
    sessionId: "ses_1",
    workspaceId: "wrk_1",
    projectId: "prj_1",
    provider: "exedev",
    providerState: {},
    generation: 1,
    directory: "/tmp/project",
    branch: "opencode/sandbox-test",
    baseSha: "0123456789012345678901234567890123456789",
    state: "local",
    desiredLocation: "local",
    phase: "idle",
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(1_000).toISOString(),
    ...overrides,
  }
}

function workspaceGateway(waitForSync: () => Promise<void> = async () => undefined) {
  return {
    async create(input: { id?: string; type: string; branch: string; directory: string; projectId: string }) {
      return {
        id: input.id ?? "wrk_1",
        type: input.type,
        name: "sandbox",
        branch: input.branch,
        directory: input.directory,
        projectID: input.projectId,
        extra: null,
      }
    },
    async warp() {},
    async remove() {},
    async waitForSync() { await waitForSync() },
  }
}
