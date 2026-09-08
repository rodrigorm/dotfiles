import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  isLegalIntentPhase,
  compatibilityStateForIntent,
} from "./state"
import { FileStateStore } from "./state-store"
import { createCapability } from "./control-channel"
import { LifecycleController } from "./lifecycle"
import {
  PERSISTED_SANDBOX_SCHEMA_VERSION,
  type PersistedSandboxRecord,
  type SandboxDesiredLocation,
  type SandboxIntentPhase,
  type SandboxRecord,
  type SandboxState,
} from "./types"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("persisted sandbox state migration", () => {
  it("migrates every legacy state to a legal intent and canonical projection", async () => {
    const cases: Array<{
      state: SandboxState
      desiredLocation: SandboxDesiredLocation
      phase: SandboxIntentPhase
      operation?: SandboxRecord["operation"]
      lastError?: SandboxRecord["lastError"]
      compatibilityState?: SandboxState
    }> = [
      { state: "local", desiredLocation: "local", phase: "idle" },
      {
        state: "provisioning",
        desiredLocation: "remote",
        phase: "idle",
        operation: { kind: "start", phase: "provisioning" },
        lastError: { stage: "migrate", message: "legacy start operation is missing at provisioning; retry start to continue", code: "LEGACY_OPERATION_MISSING" },
        compatibilityState: "error",
      },
      {
        state: "activation_pending",
        desiredLocation: "remote",
        phase: "activating",
        operation: { kind: "start", phase: "awaiting_idle" },
      },
      { state: "remote", desiredLocation: "remote", phase: "idle" },
      {
        state: "stop_pending",
        desiredLocation: "local",
        phase: "detaching",
        operation: { kind: "stop", phase: "awaiting_idle" },
      },
      {
        state: "sync_failed",
        desiredLocation: "local",
        phase: "idle",
        lastError: { stage: "sync", message: "legacy sync failure", code: "LEGACY_SYNC" },
      },
      { state: "detached", desiredLocation: "local", phase: "idle", operation: { kind: "stop", phase: "detached" } },
      {
        state: "delete_pending",
        desiredLocation: "deleted",
        phase: "deleting",
        operation: { kind: "delete", phase: "awaiting_idle" },
      },
      { state: "deleted", desiredLocation: "deleted", phase: "idle" },
      {
        state: "recovery_pending",
        desiredLocation: "local",
        phase: "idle",
        lastError: { stage: "reconcile", message: "legacy recovery is pending", code: "LEGACY_RECOVERY" },
      },
      {
        state: "orphaned",
        desiredLocation: "remote",
        phase: "idle",
        lastError: { stage: "reconcile", message: "legacy orphaned runtime", code: "LEGACY_ORPHANED" },
      },
      {
        state: "error",
        desiredLocation: "local",
        phase: "idle",
        lastError: { stage: "transition", message: "legacy lifecycle error", code: "LEGACY_ERROR" },
      },
    ]
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)

    for (const testCase of cases) {
      const sessionId = `ses_${testCase.state}`
      const legacy = legacyRecord(sessionId, testCase.state)
      await writeLegacy(store, legacy)

      await expect(store.get(sessionId)).resolves.toMatchObject({
        state: testCase.compatibilityState ?? testCase.state,
        schemaVersion: PERSISTED_SANDBOX_SCHEMA_VERSION,
        desiredLocation: testCase.desiredLocation,
        phase: testCase.phase,
        ...(testCase.operation ? { operation: testCase.operation } : {}),
        ...(testCase.lastError ? { lastError: testCase.lastError } : {}),
      })
      const saved = JSON.parse(await readFile(store.recordPath(sessionId), "utf8"))
      expect(saved).toMatchObject({
        schemaVersion: PERSISTED_SANDBOX_SCHEMA_VERSION,
        desiredLocation: testCase.desiredLocation,
        phase: testCase.phase,
        ...(testCase.operation ? { operation: testCase.operation } : {}),
        ...(testCase.lastError ? { lastError: testCase.lastError } : {}),
      })
      expect(saved.state).toBeUndefined()
    }
  })

  it("derives failed intent from the recorded operation and keeps unknown failures local", async () => {
    const operations = [
      ["start", "remote"],
      ["recover", "remote"],
      ["stop", "local"],
      ["delete", "deleted"],
    ] as const
    const failureStates: SandboxState[] = ["sync_failed", "recovery_pending", "orphaned", "error"]
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)

    for (const state of failureStates) {
      for (const [kind, desiredLocation] of operations) {
        const sessionId = `ses_${state}_${kind}`
        const legacy = legacyRecord(sessionId, state, {
          operation: { kind, phase: "failed" },
          lastError: { stage: "sync", message: "retained failure", code: "FAILED" },
        })
        await writeLegacy(store, legacy)

        const expectedState = kind === "recover" ? "recovery_pending" : "sync_failed"
        const first = await store.get(sessionId)
        expect(first).toMatchObject({
          state: expectedState,
          desiredLocation,
          phase: "idle",
          operation: legacy.operation,
          lastError: legacy.lastError,
        })
        await expect(store.get(sessionId)).resolves.toEqual(first)
      }
    }

    const orphanId = "ses_orphan_without_operation"
    await writeLegacy(store, legacyRecord(orphanId, "orphaned", {
      lastError: { stage: "reconcile", message: "ownership was verified" },
    }))
    await expect(store.get(orphanId)).resolves.toMatchObject({ desiredLocation: "remote", phase: "idle" })

    const unknownId = "ses_unknown_failure"
    await writeLegacy(store, legacyRecord(unknownId, "error", {
      operation: { kind: "inspect", phase: "failed" },
      lastError: { stage: "inspect", message: "unknown failure" },
    }))
    await expect(store.get(unknownId)).resolves.toMatchObject({ desiredLocation: "local", phase: "idle", state: "error" })
  })

  it("preserves record identity, provider metadata, operation, error, path, and timestamps", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    const legacy = legacyRecord("ses_preserved", "error", {
      provider: "sbx",
      providerState: { resourceId: "sandbox-1", generation: 4 },
      vmName: "oc-0123456789",
      vmIdentity: {
        name: "oc-0123456789",
        sshDest: "sandbox.example.test",
        tags: ["opencode-sandbox"],
        comment: "opencode-preserved",
      },
      preservedWorktreePath: "/tmp/preserved-worktree",
      operation: { kind: "stop", phase: "syncing", force: true, providerDestroyed: false },
      lastError: { stage: "sync", message: "preserve this error", code: "SYNC_FAILED" },
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-02T00:00:00.000Z",
    })
    await writeLegacy(store, legacy)

    const migrated = await store.get(legacy.sessionId)

    expect(migrated).toMatchObject({
      sessionId: legacy.sessionId,
      workspaceId: legacy.workspaceId,
      projectId: legacy.projectId,
      provider: legacy.provider,
      providerState: legacy.providerState,
      vmName: legacy.vmName,
      vmIdentity: legacy.vmIdentity,
      generation: legacy.generation,
      directory: legacy.directory,
      branch: legacy.branch,
      baseSha: legacy.baseSha,
      preservedWorktreePath: legacy.preservedWorktreePath,
      operation: legacy.operation,
      lastError: legacy.lastError,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
    })
  })

  it("dual-reads new records and does not write a legacy state shadow", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    const record = persistedRecord("ses_new", "remote", "activating")

    await store.write(record)

    const saved = JSON.parse(await readFile(store.recordPath(record.sessionId), "utf8"))
    expect(saved).toEqual({ ...record, operation: { kind: "start", phase: "awaiting_idle" } })
    expect(saved.state).toBeUndefined()
    await expect(store.get(record.sessionId)).resolves.toMatchObject({
      schemaVersion: PERSISTED_SANDBOX_SCHEMA_VERSION,
      desiredLocation: "remote",
      phase: "activating",
      state: "activation_pending",
    })
  })

  it("uses canonical intent when disk contains a contradictory legacy state", async () => {
    const cases = [
      { desiredLocation: "local", phase: "idle", legacyState: "remote", state: "local" },
      { desiredLocation: "remote", phase: "activating", legacyState: "deleted", state: "activation_pending" },
      { desiredLocation: "deleted", phase: "deleting", legacyState: "local", state: "delete_pending" },
    ] as const

    for (const [index, testCase] of cases.entries()) {
      const root = await temporaryDirectory()
      const store = new FileStateStore(root)
      const record = {
        ...legacyRecord(`ses_canonical_${index}`, "error"),
        schemaVersion: PERSISTED_SANDBOX_SCHEMA_VERSION,
        desiredLocation: testCase.desiredLocation,
        phase: testCase.phase,
        state: testCase.legacyState,
      }

      await writeFile(store.recordPath(record.sessionId), JSON.stringify(record), { mode: 0o600 })

      await expect(store.get(record.sessionId)).resolves.toMatchObject({
        desiredLocation: testCase.desiredLocation,
        phase: testCase.phase,
        state: testCase.state,
      })
      let saved = JSON.parse(await readFile(store.recordPath(record.sessionId), "utf8"))
      expect(saved).toMatchObject({
        schemaVersion: PERSISTED_SANDBOX_SCHEMA_VERSION,
        desiredLocation: testCase.desiredLocation,
        phase: testCase.phase,
      })
      expect(saved.state).toBeUndefined()

      await store.write((await store.get(record.sessionId))!)
      saved = JSON.parse(await readFile(store.recordPath(record.sessionId), "utf8"))
      expect(saved.state).toBeUndefined()
    }
  })

  it("rejects malformed and future-version records before any migration", async () => {
    const cases = [
      { name: "future", value: { ...persistedRecord("ses_future", "remote", "idle"), schemaVersion: 2 } },
      { name: "missing version", value: { ...persistedRecord("ses_missing_version", "remote", "idle"), schemaVersion: undefined } },
      { name: "missing intent", value: { ...persistedRecord("ses_missing_intent", "remote", "idle"), desiredLocation: undefined } },
      { name: "malformed json", value: undefined },
    ] as const

    for (const testCase of cases) {
      const root = await temporaryDirectory()
      const store = new FileStateStore(root)
      const sessionId = testCase.value?.sessionId ?? `ses_${testCase.name.replaceAll(" ", "_")}`
      const path = store.recordPath(sessionId)
      await writeFile(path, testCase.value === undefined ? "{" : JSON.stringify(testCase.value), { mode: 0o600 })

      await expect(store.get(sessionId)).rejects.toMatchObject({
        code: testCase.name === "future" || testCase.name === "missing version" ? "STATE_VERSION" : "STATE_SCHEMA",
      })
      expect(await readFile(path, "utf8")).toBe(testCase.value === undefined ? "{" : JSON.stringify(testCase.value))
    }
  })

  it("keeps migration idempotent and serializes concurrent legacy reads", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    const legacy = legacyRecord("ses_idempotent", "remote")
    await writeLegacy(store, legacy)

    const first = await store.get(legacy.sessionId)
    const migratedText = await readFile(store.recordPath(legacy.sessionId), "utf8")
    const concurrent = legacyRecord("ses_concurrent", "remote")
    await writeLegacy(store, concurrent)
    const results = await Promise.all([
      store.get(concurrent.sessionId),
      store.get(concurrent.sessionId),
      store.get(concurrent.sessionId),
    ])

    expect(results).toHaveLength(3)
    expect(results.every((result) => result?.desiredLocation === first?.desiredLocation && result?.phase === first?.phase)).toBe(true)
    expect(await readFile(store.recordPath(legacy.sessionId), "utf8")).toBe(migratedText)
    expect((await readdir(root)).filter((name) => name.endsWith(".lock") || name.endsWith(".tmp"))).toEqual([])
  })

  it("does not inspect providers while a legacy record is migrated for status", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    const legacy = legacyRecord("ses_status_migration", "remote")
    await writeLegacy(store, legacy)
    let providerCalls = 0
    const controller = new LifecycleController({
      store,
      providerInspect: async () => {
        providerCalls++
        return { resourceId: "resource-1", resource: "present", ownership: "verified", health: "healthy", evidence: [] }
      },
      providerTarget: async () => undefined,
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() {},
        async remove() {},
      },
    })

    const response = await controller.handle({
      operation: "status",
      force: false,
      capability: createCapability({ sessionId: legacy.sessionId, generation: legacy.generation, role: "host" }),
    })

    expect(response).toMatchObject({
      schemaVersion: 2,
      ok: true,
      operation: "status",
      state: "remote",
      intent: { desiredLocation: "remote", phase: "idle" },
    })
    expect(response.observations?.filter((observation) => observation.source !== "record").every((observation) => observation.observed === false)).toBe(true)
    const saved = JSON.parse(await readFile(store.recordPath(legacy.sessionId), "utf8"))
    expect(saved).toMatchObject({ schemaVersion: PERSISTED_SANDBOX_SCHEMA_VERSION, desiredLocation: "remote", phase: "idle" })
    expect(saved.state).toBeUndefined()
    expect(saved.observations).toBeUndefined()
    expect(providerCalls).toBe(0)
  })

  it("accepts only the legal desired-location and phase matrix", async () => {
    const locations: SandboxDesiredLocation[] = ["local", "remote", "deleted"]
    const phases: SandboxIntentPhase[] = ["idle", "capturing", "provisioning", "activating", "syncing", "detaching", "deleting"]

    for (const desiredLocation of locations) {
      for (const phase of phases) {
        const root = await temporaryDirectory()
        const store = new FileStateStore(root)
        const record = {
          ...persistedRecord(`ses_${desiredLocation}_${phase}`, desiredLocation, phase),
          ...(phase === "syncing" ? { operation: syncingOperation(desiredLocation) } : {}),
        }
        await store.write(record).then(
          () => expect(isLegalIntentPhase(desiredLocation, phase)).toBe(true),
          (error: unknown) => {
            expect(isLegalIntentPhase(desiredLocation, phase)).toBe(false)
            expect(error).toMatchObject({ code: "STATE_INTENT" })
          },
        )
      }
    }
  })

  it("rejects canonical syncing without a blocking operation and keeps valid reads consistent", async () => {
    for (const desiredLocation of ["local", "remote", "deleted"] as const) {
      const root = await temporaryDirectory()
      const store = new FileStateStore(root)
      const sessionId = `ses_syncing_${desiredLocation}`
      const missing = persistedRecord(sessionId, desiredLocation, "syncing")
      const path = store.recordPath(sessionId)
      await writeFile(path, JSON.stringify(missing), { mode: 0o600 })

      const expectedError = {
        stage: "validate",
        code: "STATE_SCHEMA",
        message: "state syncing phase requires a blocking operation",
      }
      await expect(store.get(sessionId)).rejects.toMatchObject(expectedError)
      await expect(store.get(sessionId)).rejects.toMatchObject(expectedError)
      expect(await readFile(path, "utf8")).toBe(JSON.stringify(missing))

      const nonBlocking = { ...missing, operation: { kind: "status", phase: "syncing" } }
      await writeFile(path, JSON.stringify(nonBlocking), { mode: 0o600 })
      await expect(store.get(sessionId)).rejects.toMatchObject(expectedError)
      expect(await readFile(path, "utf8")).toBe(JSON.stringify(nonBlocking))

      const valid = { ...missing, operation: syncingOperation(desiredLocation) }
      await store.write(valid)
      const first = await store.get(sessionId)
      const second = await store.get(sessionId)
      const listed = await store.list()
      const saved = JSON.parse(await readFile(path, "utf8"))

      if (!first) throw new Error("valid syncing record was not returned")
      expect(first).toMatchObject({ desiredLocation, phase: "syncing", operation: valid.operation })
      expect(second).toEqual(first)
      expect(listed).toEqual([first])
      expect(saved).toEqual(valid)
    }
  })

  it("uses the canonical compatibility state when a new record has no legacy projection", async () => {
    const record = persistedRecord("ses_projection", "deleted", "deleting")
    expect(compatibilityStateForIntent(record)).toBe("delete_pending")
  })

  it("returns one canonical projection across first get, repeated get, list, and disk", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    const cases: Array<[SandboxState, SandboxRecord["operation"]]> = [
      ["activation_pending", { kind: "start", phase: "awaiting_idle" }],
      ["stop_pending", { kind: "stop", phase: "awaiting_idle" }],
      ["delete_pending", { kind: "delete", phase: "awaiting_idle" }],
    ]

    for (const [state, operation] of cases) {
      const sessionId = `ses_repeat_${state}`
      await writeLegacy(store, legacyRecord(sessionId, state))

      const first = await store.get(sessionId)
      const second = await store.get(sessionId)
      const listed = (await store.list()).find((record) => record.sessionId === sessionId)
      const raw = JSON.parse(await readFile(store.recordPath(sessionId), "utf8"))

      expect(first).toMatchObject({ state, operation })
      expect(second).toEqual(first)
      expect(listed).toEqual(first)
      expect(raw).toMatchObject({ operation, schemaVersion: PERSISTED_SANDBOX_SCHEMA_VERSION })
      expect(raw.state).toBeUndefined()
    }
  })

  it("whitelists canonical fields and keeps durable provider identifiers without observed truth", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    const record = {
      ...persistedRecord("ses_adversarial", "remote", "idle"),
      providerState: {
        resourceId: "resource-1",
        sandboxId: "sandbox-1",
        ownershipId: "owner-1",
        health: "healthy",
        observations: { resource: "present" },
        effectiveTarget: { resourceId: "resource-1" },
      },
      observations: [{ observed: true }],
      classification: "attached",
      work: { preservation: "at_risk" },
      control: { present: true },
      health: "healthy",
      effectiveTarget: { kind: "remote", resourceId: "resource-1" },
      unknownTopLevel: "discarded",
      operation: { kind: "stop", phase: "awaiting_idle", force: true, providerDestroyed: false, extra: "discarded" },
      lastError: { stage: "sync", message: "failed", code: "SYNC_FAILED", extra: "discarded" },
    } as unknown as PersistedSandboxRecord

    await writeFile(store.recordPath(record.sessionId), JSON.stringify(record), { mode: 0o600 })
    const migrated = await store.get(record.sessionId)
    const saved = JSON.parse(await readFile(store.recordPath(record.sessionId), "utf8"))

    expect(migrated?.providerState).toEqual({ resourceId: "resource-1", sandboxId: "sandbox-1", ownershipId: "owner-1" })
    expect(saved).toMatchObject({
      providerState: { resourceId: "resource-1", sandboxId: "sandbox-1", ownershipId: "owner-1" },
      operation: { kind: "stop", phase: "awaiting_idle", force: true, providerDestroyed: false },
      lastError: { stage: "sync", message: "failed", code: "SYNC_FAILED" },
    })
    for (const key of ["observations", "classification", "work", "control", "health", "effectiveTarget", "unknownTopLevel", "state"]) {
      expect(saved[key]).toBeUndefined()
    }
    expect(saved.operation.extra).toBeUndefined()
    expect(saved.lastError.extra).toBeUndefined()
  })

  it("rejects malformed nested operation and error data", async () => {
    const cases = [
      { operation: null },
      { operation: { kind: "start" } },
      { operation: { kind: "start", phase: "awaiting_idle", force: "yes" } },
      { lastError: null },
      { lastError: { stage: "sync" } },
      { lastError: { stage: "sync", message: "failed", code: 1 } },
    ]

    for (const [index, nested] of cases.entries()) {
      const root = await temporaryDirectory()
      const store = new FileStateStore(root)
      const record = { ...persistedRecord(`ses_nested_${index}`, "local", "idle"), ...nested }
      const path = store.recordPath(record.sessionId)
      await writeFile(path, JSON.stringify(record), { mode: 0o600 })

      await expect(store.get(record.sessionId)).rejects.toMatchObject({ code: "STATE_SCHEMA" })
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(record)
    }
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "oe-state-migration-"))
  temporaryDirectories.push(directory)
  return directory
}

async function writeLegacy(store: FileStateStore, record: SandboxRecord): Promise<void> {
  await writeFile(store.recordPath(record.sessionId), JSON.stringify(record), { mode: 0o600 })
}

function legacyRecord(sessionId: string, state: SandboxState, overrides: Partial<SandboxRecord> = {}): SandboxRecord {
  return {
    sessionId,
    workspaceId: `wrk_${sessionId}`,
    projectId: "prj_1",
    provider: "exedev",
    providerState: { resourceId: `resource-${sessionId}` },
    generation: 1,
    directory: "/tmp/project",
    branch: "opencode/sandbox-test",
    baseSha: "0123456789012345678901234567890123456789",
    state,
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-02T00:00:00.000Z",
    ...overrides,
  }
}

function persistedRecord(sessionId: string, desiredLocation: SandboxDesiredLocation, phase: SandboxIntentPhase): PersistedSandboxRecord {
  const { state: _state, ...record } = legacyRecord(sessionId, "local")
  return {
    ...record,
    schemaVersion: PERSISTED_SANDBOX_SCHEMA_VERSION,
    desiredLocation,
    phase,
  }
}

function syncingOperation(desiredLocation: SandboxDesiredLocation): NonNullable<SandboxRecord["operation"]> {
  return {
    kind: desiredLocation === "local" ? "stop" : desiredLocation === "remote" ? "start" : "delete",
    phase: "syncing",
  }
}
