import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createCapability } from "./control-channel"
import { LifecycleController } from "./lifecycle"
import { FileStateStore } from "./state-store"
import {
  MAX_OPERATION_JOURNAL_BYTES,
  MAX_OPERATION_JOURNAL_EVIDENCE_BYTES,
  MAX_OPERATION_JOURNAL_EVIDENCE_REFS,
  MAX_OPERATION_JOURNAL_ENTRIES,
  MAX_OPERATION_JOURNAL_STRING_BYTES,
  PERSISTED_SANDBOX_SCHEMA_VERSION,
  SandboxError,
  type GitWorkingTreeObservation,
  type PersistedSandboxRecord,
  type ProviderResourceObservation,
  type RuntimeDriver,
  type SandboxAllowedAction,
  type SandboxErrorRecord,
  type SandboxIntentPhase,
  type SandboxJournalEntry,
  type SandboxOperation,
  type SandboxRecord,
  type SandboxResultV2,
  type SandboxDesiredLocation,
  type WorkspaceGateway,
  type WorkspaceInfo,
} from "./types"

const temporaryDirectories: string[] = []
const NOW = new Date("2026-09-08T12:00:00.000Z")
const PRIVATE_TOKEN = "phase4-private-token"

type ExpectedAction = {
  operation: SandboxOperation
  role: "host" | "remote"
  waitFor: SandboxAllowedAction["waitFor"]
  reasonCode: string
} | null

type RecordSpec = {
  desiredLocation: SandboxDesiredLocation
  phase?: SandboxIntentPhase
  provider?: string
  operation?: NonNullable<SandboxRecord["operation"]>
  lastError?: SandboxErrorRecord
  preservedWorktreePath?: string
  journalOperation?: SandboxOperation
  journalResultCode?: string
}

type Scenario = {
  id: string
  incidentIds: readonly string[]
  record?: RecordSpec
  evidence: {
    provider: ProviderResourceObservation
    handle: "present" | "absent" | "unknown"
    workspace: "exact" | "absent"
    git?: GitWorkingTreeObservation
    providerFailure?: SandboxError
  }
  runtimeDriver?: boolean
  classification: SandboxResultV2["classification"]
  action: ExpectedAction
  diagnoseOk?: boolean
  work?: Partial<SandboxResultV2["work"]>
}

type DocumentedIncident = {
  id: string
  scenarioId: string
  classification: SandboxResultV2["classification"]
}

const DOCUMENTED_INCIDENTS: readonly DocumentedIncident[] = [
  { id: "clean-baseline", scenarioId: "clean", classification: "clean" },
  { id: "attached-runtime", scenarioId: "attached", classification: "attached" },
  { id: "runtime-handle-loss", scenarioId: "control-lost", classification: "control_lost" },
  { id: "cloudflare-post-restart", scenarioId: "control-lost", classification: "control_lost" },
  { id: "legacy-sbx-detached-runtime", scenarioId: "control-lost", classification: "control_lost" },
  { id: "missing-handle-with-unavailable-evidence", scenarioId: "control-lost", classification: "control_lost" },
  { id: "unsupported-provider-inspection", scenarioId: "control-lost", classification: "control_lost" },
  { id: "plugin-disposal-final-state", scenarioId: "control-lost", classification: "control_lost" },
  { id: "verified-orphan", scenarioId: "orphan", classification: "orphan" },
  { id: "stale-control-plane", scenarioId: "stale-record", classification: "stale_record" },
  { id: "verified-preserved-leak", scenarioId: "leaked-resource", classification: "leaked_resource" },
  { id: "ownership-conflict", scenarioId: "conflict", classification: "conflict" },
  { id: "duplicate-provider-resource", scenarioId: "conflict", classification: "conflict" },
  { id: "checkout-mismatch", scenarioId: "conflict", classification: "conflict" },
  { id: "sync-failure", scenarioId: "work-at-risk", classification: "work_at_risk" },
  { id: "unknown-provider-evidence", scenarioId: "unknown", classification: "unknown" },
  { id: "cloudflare-known-resource-without-owner", scenarioId: "unknown", classification: "unknown" },
  { id: "legacy-sbx-marker", scenarioId: "unknown", classification: "unknown" },
  { id: "stopped-or-unknown-provider-status", scenarioId: "stopped-resource", classification: "orphan" },
  { id: "provider-cleanup-before-record", scenarioId: "unrecorded-resource", classification: "unknown" },
  { id: "provider-inspection-timeout", scenarioId: "provider-timeout", classification: "control_lost" },
  { id: "failed-recovery", scenarioId: "failed-recovery", classification: "control_lost" },
]

const SCENARIOS: readonly Scenario[] = [
  {
    id: "clean",
    incidentIds: ["clean-baseline"],
    record: { desiredLocation: "local" },
    evidence: {
      provider: provider("clean", "absent", "unknown", "unknown", ["provider resource absent"]),
      handle: "absent",
      workspace: "absent",
    },
    classification: "clean",
    action: { operation: "start", role: "host", waitFor: "none", reasonCode: "NO_RUNTIME" },
  },
  {
    id: "attached",
    incidentIds: ["attached-runtime"],
    record: { desiredLocation: "remote" },
    evidence: {
      provider: provider("attached", "present", "verified", "healthy", ["provider resource attached"], "1.18.24"),
      handle: "present",
      workspace: "exact",
    },
    classification: "attached",
    action: { operation: "stop", role: "host", waitFor: "session_idle", reasonCode: "ATTACHED_RUNTIME" },
  },
  {
    id: "control-lost",
    incidentIds: [
      "runtime-handle-loss",
      "cloudflare-post-restart",
      "legacy-sbx-detached-runtime",
      "missing-handle-with-unavailable-evidence",
      "unsupported-provider-inspection",
      "plugin-disposal-final-state",
    ],
    record: { desiredLocation: "remote" },
    evidence: {
      provider: provider("control-lost", "unknown", "unknown", "unknown", ["provider lookup unavailable"]),
      handle: "absent",
      workspace: "absent",
    },
    classification: "control_lost",
    action: { operation: "inspect", role: "host", waitFor: "none", reasonCode: "RESOURCE_STATE_UNKNOWN" },
  },
  {
    id: "orphan",
    incidentIds: ["verified-orphan"],
    record: { desiredLocation: "remote" },
    evidence: {
      provider: provider("orphan", "present", "verified", "healthy", ["durable owner marker matches"]),
      handle: "absent",
      workspace: "exact",
    },
    runtimeDriver: true,
    classification: "orphan",
    action: { operation: "recover", role: "host", waitFor: "operation_completion", reasonCode: "VERIFIED_ORPHAN" },
  },
  {
    id: "stale-record",
    incidentIds: ["stale-control-plane"],
    record: {
      desiredLocation: "remote",
      operation: { kind: "start", phase: "awaiting_idle" },
    },
    evidence: {
      provider: provider("stale-record", "absent", "unknown", "unknown", ["provider resource absent"]),
      handle: "absent",
      workspace: "absent",
    },
    classification: "stale_record",
    action: { operation: "repair", role: "host", waitFor: "operation_completion", reasonCode: "STALE_CONTROL_PLANE" },
  },
  {
    id: "leaked-resource",
    incidentIds: ["verified-preserved-leak"],
    record: {
      desiredLocation: "local",
      preservedWorktreePath: "/tmp/phase4-preserved-worktree",
    },
    evidence: {
      provider: provider("leaked-resource", "present", "verified", "healthy", ["resource remains after detach"]),
      handle: "absent",
      workspace: "absent",
      git: {
        head: "0123456789012345678901234567890123456789",
        branch: "opencode/phase4-preserved",
        dirty: false,
        evidence: ["preserved worktree has a valid HEAD"],
      },
    },
    classification: "leaked_resource",
    action: { operation: "delete", role: "host", waitFor: "operation_completion", reasonCode: "VERIFIED_LEAK" },
    work: { sync: "clean", preservation: "preserved" },
  },
  {
    id: "conflict",
    incidentIds: ["ownership-conflict", "duplicate-provider-resource", "checkout-mismatch"],
    record: { desiredLocation: "remote" },
    evidence: {
      provider: provider("conflict", "present", "conflict", "unknown", ["ownership evidence conflicts"]),
      handle: "absent",
      workspace: "absent",
    },
    classification: "conflict",
    action: { operation: "inspect", role: "host", waitFor: "none", reasonCode: "OWNERSHIP_CONFLICT" },
  },
  {
    id: "work-at-risk",
    incidentIds: ["sync-failure"],
    record: {
      desiredLocation: "local",
      operation: { kind: "stop", phase: "remote" },
      lastError: { stage: "sync", code: "SYNC_FAILED", message: `preservation failed token=${PRIVATE_TOKEN}` },
      journalOperation: "stop",
      journalResultCode: "SYNC_FAILED",
    },
    evidence: {
      provider: provider("work-at-risk", "unknown", "unknown", "unknown", ["provider evidence unavailable"]),
      handle: "unknown",
      workspace: "absent",
    },
    classification: "work_at_risk",
    action: { operation: "retry", role: "host", waitFor: "operation_completion", reasonCode: "WORK_AT_RISK" },
    work: { sync: "failed", preservation: "at_risk" },
  },
  {
    id: "unknown",
    incidentIds: [
      "unknown-provider-evidence",
      "cloudflare-known-resource-without-owner",
      "legacy-sbx-marker",
    ],
    record: { desiredLocation: "remote" },
    evidence: {
      provider: provider("unknown", "present", "unknown", "unknown", ["status or owner proof is unknown"]),
      handle: "unknown",
      workspace: "absent",
    },
    classification: "unknown",
    action: { operation: "inspect", role: "host", waitFor: "none", reasonCode: "INSUFFICIENT_EVIDENCE" },
  },
  {
    id: "stopped-resource",
    incidentIds: ["stopped-or-unknown-provider-status"],
    record: { desiredLocation: "remote" },
    evidence: {
      provider: provider("stopped-resource", "present", "verified", "degraded", ["provider status:stopped"]),
      handle: "absent",
      workspace: "exact",
    },
    classification: "orphan",
    action: { operation: "inspect", role: "host", waitFor: "none", reasonCode: "VERIFIED_ORPHAN_READ_ONLY" },
  },
  {
    id: "unrecorded-resource",
    incidentIds: ["provider-cleanup-before-record"],
    evidence: {
      provider: provider("unrecorded-resource", "unknown", "unknown", "unknown", ["resource cannot be attributed without a record"]),
      handle: "unknown",
      workspace: "absent",
    },
    classification: "unknown",
    action: null,
  },
  {
    id: "provider-timeout",
    incidentIds: ["provider-inspection-timeout"],
    record: { desiredLocation: "remote" },
    evidence: {
      provider: provider("provider-timeout", "unknown", "unknown", "unknown", []),
      handle: "absent",
      workspace: "absent",
      providerFailure: new SandboxError("inspect", "provider inspection timed out", "INSPECTION_TIMEOUT"),
    },
    classification: "control_lost",
    action: { operation: "inspect", role: "host", waitFor: "none", reasonCode: "RESOURCE_STATE_UNKNOWN" },
    diagnoseOk: false,
  },
  {
    id: "failed-recovery",
    incidentIds: ["failed-recovery"],
    record: {
      desiredLocation: "remote",
      operation: { kind: "recover", phase: "adopt_failed" },
      lastError: { stage: "reconcile", code: "RECOVER_EVIDENCE", message: `recovery needs evidence token=${PRIVATE_TOKEN}` },
      journalOperation: "recover",
      journalResultCode: "RECOVER_EVIDENCE",
    },
    evidence: {
      provider: provider("failed-recovery", "unknown", "unknown", "unknown", ["recovery preflight is unavailable"]),
      handle: "absent",
      workspace: "absent",
    },
    classification: "control_lost",
    action: { operation: "retry", role: "host", waitFor: "operation_completion", reasonCode: "RECOVERY_RETRY" },
  },
]

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("Phase 4 incident scenarios", () => {
  it("joins evidence, typed actions, and bounded diagnosis for every incident class", async () => {
    const seenClasses = new Set<SandboxResultV2["classification"]>()
    const mappedIncidentIds = new Set<string>()

    for (const scenario of SCENARIOS) {
      for (const incidentId of scenario.incidentIds) mappedIncidentIds.add(incidentId)
      const result = await runScenario(scenario)
      seenClasses.add(result.inspect.classification as SandboxResultV2["classification"])

      expect(result.inspect).toMatchObject({
        schemaVersion: 2,
        requestId: `inspect-${scenario.id}`,
        operation: "inspect",
        classification: scenario.classification,
      })
      expect(result.inspect.observations).toHaveLength(5)
      for (const observation of result.inspect.observations ?? []) {
        expect(observation.freshAt).toBeString()
        expect(observation.evidence.length).toBeLessThanOrEqual(MAX_OPERATION_JOURNAL_EVIDENCE_REFS)
        expect(Buffer.byteLength(JSON.stringify(observation.evidence))).toBeLessThanOrEqual(MAX_OPERATION_JOURNAL_EVIDENCE_BYTES)
      }

      const expectedProvider = !scenario.record
        ? { observed: false }
        : scenario.evidence.providerFailure
          ? { observed: true, resource: "unknown", ownership: "unknown", health: "unknown" }
          : {
              observed: true,
              resource: scenario.evidence.provider.resource,
              ownership: scenario.evidence.provider.ownership,
              health: scenario.evidence.provider.health,
            }
      expect(observation(result.inspect, "provider")).toMatchObject(expectedProvider)
      expect(observation(result.inspect, "handle")).toMatchObject(expectedHandle(scenario))
      expect(observation(result.inspect, "workspace")).toMatchObject(expectedWorkspace(scenario))
      if (scenario.evidence.git) expect(observation(result.inspect, "git")).toMatchObject({ observed: true })

      expect(result.inspect.allowedActions).toBeArray()
      for (const action of result.inspect.allowedActions ?? []) {
        expect(action.arguments).toEqual([])
        expect(["none", "session_idle", "operation_completion"]).toContain(action.waitFor)
        if (!["status", "inspect", "logs", "diagnose"].includes(action.operation)) {
          expect(action.preconditions.length).toBeGreaterThan(0)
        }
      }
      assertExpectedAction(result.inspect, scenario.action)
      if (["control_lost", "conflict", "unknown"].includes(scenario.classification) && scenario.action?.operation === "inspect") {
        expect(result.inspect.allowedActions?.every((action) => ["status", "inspect", "logs", "diagnose"].includes(action.operation))).toBe(true)
      }
      if (scenario.work) expect(result.inspect.work).toMatchObject(scenario.work)

      const details = result.diagnose.details ?? {}
      const diagnosticText = JSON.stringify(details)
      expect(result.diagnose).toMatchObject({
        requestId: `diagnose-${scenario.id}`,
        operation: "diagnose",
        ok: scenario.diagnoseOk ?? true,
      })
      expect(Buffer.byteLength(diagnosticText)).toBeLessThanOrEqual(48 * 1024)
      expect(diagnosticText).not.toContain(PRIVATE_TOKEN)
      expect(diagnosticText).not.toContain("https://phase4.private")
      expect(details).toMatchObject({
        schemaVersion: 1,
        generatedAt: NOW.toISOString(),
        capabilities: { role: "host", readOnly: true },
        limits: {
          maxSeconds: 30,
          maxProbes: 5,
          maxResponseBytes: 64 * 1024,
          maxJournalEntries: MAX_OPERATION_JOURNAL_ENTRIES,
          maxJournalBytes: MAX_OPERATION_JOURNAL_BYTES,
        },
      })
      const diagnosticResults = details.results as Record<string, unknown>
      expect(diagnosticResults.operationJournal).toEqual(result.record?.journal ?? [])
      expect(diagnosticResults.versions).toMatchObject({
        configured: { value: "1.18.25", observed: true, provenance: "sandbox configuration" },
        local: { value: "1.18.23", observed: true, provenance: "host OpenCode health/source" },
        dependency: { value: "1.18.23", observed: true, provenance: "@opencode-ai/plugin package metadata" },
      })
      const versions = diagnosticResults.versions as Record<string, Record<string, unknown>>
      expect(versions.remote).toMatchObject(
        scenario.evidence.provider.remoteVersion
          ? { value: scenario.evidence.provider.remoteVersion, observed: true, provenance: "provider health observation" }
          : { value: null, observed: false, provenance: "provider health observation" },
      )
      expect(result.mutations).toEqual([])

      expect(Buffer.byteLength(JSON.stringify(result.record?.journal ?? []))).toBeLessThanOrEqual(MAX_OPERATION_JOURNAL_BYTES)
      for (const entry of result.record?.journal ?? []) {
        expect(entry.requestId).toMatch(/^phase4-/)
        expect(entry.operation).toBeString()
        expect(entry.startedAt).toBeString()
        expect(entry.resultCode).toBeString()
        expect(entry.evidence.length).toBeLessThanOrEqual(MAX_OPERATION_JOURNAL_EVIDENCE_REFS)
        expect(entry.evidence.every((value) => Buffer.byteLength(value) <= MAX_OPERATION_JOURNAL_STRING_BYTES)).toBe(true)
      }
    }

    expect([...seenClasses].sort()).toEqual([
      "attached",
      "clean",
      "conflict",
      "control_lost",
      "leaked_resource",
      "orphan",
      "stale_record",
      "unknown",
      "work_at_risk",
    ])
    expect([...mappedIncidentIds].sort()).toEqual([...new Set(DOCUMENTED_INCIDENTS.map((incident) => incident.id))].sort())
    for (const incident of DOCUMENTED_INCIDENTS) {
      const scenario = SCENARIOS.find((candidate) => candidate.id === incident.scenarioId)
      expect(scenario).toBeDefined()
      expect(scenario?.incidentIds).toContain(incident.id)
      expect(scenario?.classification).toBe(incident.classification)
    }
  })
})

async function runScenario(scenario: Scenario): Promise<{
  inspect: SandboxResultV2
  diagnose: { details?: Record<string, unknown>; ok: boolean; requestId: string; operation: SandboxOperation }
  record?: PersistedSandboxRecord
  mutations: string[]
}> {
  const root = await temporaryDirectory()
  const store = new FileStateStore(root)
  const record = scenario.record ? makeRecord(scenario.id, scenario.record) : undefined
  if (record) await store.write(record)
  const stored = record ? await store.get(record.sessionId) as PersistedSandboxRecord : undefined
  const mutations: string[] = []
  const runtimeDriver = scenario.runtimeDriver ? runtimeDriverFor(scenario) : undefined
  const providerFailure = scenario.evidence.providerFailure
  const git = scenario.evidence.git
  const controller = new LifecycleController({
    store,
    now: () => NOW,
    capture: async () => ({ baseSha: "0123456789012345678901234567890123456789", patch: "", untracked: [] }),
    diagnosticSources: () => ({ configured: "1.18.25", local: "1.18.23", dependency: "1.18.23" }),
    providerInspect: async () => {
      if (providerFailure) throw providerFailure
      return scenario.evidence.provider
    },
    ...(scenario.evidence.handle === "unknown"
      ? {}
      : { providerTarget: async () => scenario.evidence.handle === "present" ? { type: "remote" as const, url: "https://phase4.private/runtime" } : undefined }),
    ...(git ? { gitInspect: async () => git } : {}),
    ...(runtimeDriver ? { runtimeDriver } : {}),
    workspace: workspaceGateway(record, scenario, mutations),
  })
  if (record) {
    controller.registerContext({
      sessionId: record.sessionId,
      projectId: record.projectId,
      directory: record.directory,
      worktree: record.directory,
    })
  }

  const sessionId = record?.sessionId ?? `ses_phase4_${scenario.id}`
  const capability = createCapability({ sessionId, generation: record?.generation ?? 1, role: "host" })
  const inspect = await controller.handle({ operation: "inspect", force: false, requestId: `inspect-${scenario.id}`, capability })
  const diagnose = await controller.handle({ operation: "diagnose", force: false, requestId: `diagnose-${scenario.id}`, capability })
  return {
    inspect: inspect as SandboxResultV2,
    diagnose: diagnose as { details?: Record<string, unknown>; ok: boolean; requestId: string; operation: SandboxOperation },
    record: stored,
    mutations,
  }
}

function makeRecord(id: string, spec: RecordSpec): PersistedSandboxRecord {
  const sessionId = `ses_phase4_${id}`
  const requestId = `phase4-${id}`
  const operation = spec.operation
    ? { ...spec.operation, requestId: spec.operation.requestId ?? requestId }
    : undefined
  const journal: SandboxJournalEntry = {
    requestId,
    operation: spec.journalOperation ?? operation?.kind ?? "start",
    startedAt: NOW.toISOString(),
    endedAt: new Date(NOW.getTime() + 1_000).toISOString(),
    resultCode: spec.journalResultCode ?? spec.lastError?.code ?? "OK",
    evidence: [
      `incident:${id}`,
      `token=${PRIVATE_TOKEN}`,
      "https://phase4.private/evidence",
      "x".repeat(20_000),
    ],
  }
  return {
    sessionId,
    workspaceId: `wrk_${id}`,
    projectId: "prj_phase4",
    provider: spec.provider ?? "exedev",
    providerState: { resourceId: `resource-${id}` },
    generation: 1,
    directory: "/tmp/phase4-project",
    branch: "opencode/phase4",
    baseSha: "0123456789012345678901234567890123456789",
    schemaVersion: PERSISTED_SANDBOX_SCHEMA_VERSION,
    desiredLocation: spec.desiredLocation,
    phase: spec.phase ?? "idle",
    ...(operation ? { operation } : {}),
    journal: [journal],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...(spec.lastError ? { lastError: spec.lastError } : {}),
    ...(spec.preservedWorktreePath ? { preservedWorktreePath: spec.preservedWorktreePath } : {}),
  }
}

function provider(
  id: string,
  resource: ProviderResourceObservation["resource"],
  ownership: ProviderResourceObservation["ownership"],
  health: ProviderResourceObservation["health"],
  evidence: string[],
  remoteVersion?: string,
): ProviderResourceObservation {
  return {
    resourceId: `resource-${id}`,
    resource,
    ownership,
    health,
    evidence,
    ...(remoteVersion ? { remoteVersion } : {}),
  }
}

function runtimeDriverFor(scenario: Scenario): RuntimeDriver {
  return {
    async inspect() { return scenario.evidence.provider },
    async adopt() { throw new Error("scenario does not adopt a runtime") },
    async sync() {},
    async close() { return {} },
    async destroy() {},
  }
}

function workspaceGateway(record: PersistedSandboxRecord | undefined, scenario: Scenario, mutations: string[]): WorkspaceGateway {
  return {
    async create() { mutations.push("create"); throw new Error("scenario must not create a workspace") },
    async warp() { mutations.push("warp") },
    async remove() { mutations.push("remove") },
    async inspect() {
      if (!record || scenario.evidence.workspace === "absent") return undefined
      return workspaceInfo(record)
    },
  }
}

function workspaceInfo(record: PersistedSandboxRecord): WorkspaceInfo {
  return {
    id: record.workspaceId,
    type: record.provider,
    name: "phase4-scenario",
    branch: record.branch,
    directory: record.directory,
    projectID: record.projectId,
    extra: {
      owner: "opencode-sandbox",
      sessionId: record.sessionId,
      generation: record.generation,
      workspaceId: record.workspaceId,
      projectId: record.projectId,
      provider: record.provider,
    },
  }
}

function observation(result: SandboxResultV2, source: string) {
  const value = result.observations?.find((item) => item.source === source)
  if (!value) throw new Error(`missing ${source} observation`)
  return value
}

function expectedHandle(scenario: Scenario): Record<string, unknown> {
  if (scenario.evidence.handle === "present") return { observed: true, resource: "present" }
  if (scenario.evidence.handle === "absent" || scenario.runtimeDriver) return { observed: true, resource: "absent" }
  return { observed: false }
}

function expectedWorkspace(scenario: Scenario): Record<string, unknown> {
  if (!scenario.record) return { observed: false }
  return scenario.evidence.workspace === "absent"
    ? { observed: true, resource: "absent" }
    : { observed: true, resource: "present", ownership: "verified" }
}

function assertExpectedAction(result: SandboxResultV2, expected: ExpectedAction): void {
  if (!expected) {
    expect(result.recommendedAction).toBeNull()
    return
  }
  expect(result.recommendedAction).toEqual({ operation: expected.operation, reasonCode: expected.reasonCode })
  expect(result.allowedActions).toContainEqual(expect.objectContaining({
    operation: expected.operation,
    role: expected.role,
    waitFor: expected.waitFor,
  }))
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "oe-phase4-scenario-"))
  temporaryDirectories.push(directory)
  return directory
}
