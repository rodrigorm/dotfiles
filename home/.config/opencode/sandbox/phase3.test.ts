import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createCapability } from "./control-channel"
import { LifecycleController } from "./lifecycle"
import { FileStateStore } from "./state-store"
import {
  PERSISTED_SANDBOX_SCHEMA_VERSION,
  type PersistedSandboxRecord,
  type ProviderResourceObservation,
  type SandboxAllowedAction,
  type SandboxDesiredLocation,
  type SandboxOperation,
  type SandboxRecord,
  type SandboxResultV2,
} from "./types"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

type ControlState = "present" | "absent" | "unknown"

type ExpectedAction = {
  operation: SandboxOperation
  role: "host" | "remote"
  waitFor: SandboxAllowedAction["waitFor"]
  reasonCode: string
}

type SituationCase = {
  name: string
  desiredLocation: SandboxDesiredLocation
  control: ControlState
  resource: ProviderResourceObservation["resource"]
  ownership: ProviderResourceObservation["ownership"]
  health: ProviderResourceObservation["health"]
  classification: SandboxResultV2["classification"]
  role?: "host" | "remote"
  operation?: SandboxRecord["operation"]
  lastError?: SandboxRecord["lastError"]
  action: ExpectedAction | null
}

describe("Phase 3 situation model", () => {
  it("derives legal classifications from canonical intent and fresh observations", async () => {
    const cases: SituationCase[] = [
      {
        name: "local-clean",
        desiredLocation: "local",
        control: "absent",
        resource: "absent",
        ownership: "unknown",
        health: "unknown",
        classification: "clean",
        action: { operation: "start", role: "host", waitFor: "none", reasonCode: "NO_RUNTIME" },
      },
      {
        name: "deleted-clean",
        desiredLocation: "deleted",
        control: "absent",
        resource: "absent",
        ownership: "unknown",
        health: "unknown",
        classification: "clean",
        action: null,
      },
      {
        name: "remote-attached",
        desiredLocation: "remote",
        control: "present",
        resource: "present",
        ownership: "verified",
        health: "healthy",
        classification: "attached",
        role: "remote",
        action: { operation: "stop", role: "remote", waitFor: "session_idle", reasonCode: "ATTACHED_RUNTIME" },
      },
      {
        name: "remote-control-lost",
        desiredLocation: "remote",
        control: "absent",
        resource: "unknown",
        ownership: "unknown",
        health: "unknown",
        classification: "control_lost",
        action: { operation: "inspect", role: "host", waitFor: "none", reasonCode: "RESOURCE_STATE_UNKNOWN" },
      },
      {
        name: "remote-stale-record",
        desiredLocation: "remote",
        control: "absent",
        resource: "absent",
        ownership: "unknown",
        health: "unknown",
        classification: "stale_record",
        action: { operation: "repair", role: "host", waitFor: "operation_completion", reasonCode: "STALE_CONTROL_PLANE" },
      },
      {
        name: "remote-orphan",
        desiredLocation: "remote",
        control: "absent",
        resource: "present",
        ownership: "verified",
        health: "healthy",
        classification: "orphan",
        action: { operation: "inspect", role: "host", waitFor: "none", reasonCode: "VERIFIED_ORPHAN_READ_ONLY" },
      },
      {
        name: "local-leaked-resource",
        desiredLocation: "local",
        control: "absent",
        resource: "present",
        ownership: "verified",
        health: "healthy",
        classification: "leaked_resource",
        action: { operation: "inspect", role: "host", waitFor: "none", reasonCode: "PRESERVATION_UNVERIFIED" },
      },
      {
        name: "deleted-leaked-resource",
        desiredLocation: "deleted",
        control: "absent",
        resource: "present",
        ownership: "verified",
        health: "healthy",
        classification: "leaked_resource",
        action: { operation: "inspect", role: "host", waitFor: "none", reasonCode: "PRESERVATION_UNVERIFIED" },
      },
      {
        name: "remote-unknown-ownership",
        desiredLocation: "remote",
        control: "absent",
        resource: "present",
        ownership: "unknown",
        health: "healthy",
        classification: "unknown",
        action: { operation: "inspect", role: "host", waitFor: "none", reasonCode: "INSUFFICIENT_EVIDENCE" },
      },
      {
        name: "remote-control-unobserved",
        desiredLocation: "remote",
        control: "unknown",
        resource: "present",
        ownership: "verified",
        health: "healthy",
        classification: "unknown",
        action: { operation: "inspect", role: "host", waitFor: "none", reasonCode: "INSUFFICIENT_EVIDENCE" },
      },
      {
        name: "remote-ownership-conflict",
        desiredLocation: "remote",
        control: "absent",
        resource: "present",
        ownership: "conflict",
        health: "unknown",
        classification: "conflict",
        action: { operation: "inspect", role: "host", waitFor: "none", reasonCode: "OWNERSHIP_CONFLICT" },
      },
      {
        name: "local-work-at-risk",
        desiredLocation: "local",
        control: "unknown",
        resource: "unknown",
        ownership: "unknown",
        health: "unknown",
        classification: "work_at_risk",
        operation: { kind: "stop", phase: "remote" },
        lastError: { stage: "sync", message: "preservation failed", code: "SYNC_FAILED" },
        action: { operation: "retry", role: "host", waitFor: "operation_completion", reasonCode: "WORK_AT_RISK" },
      },
    ]

    const seenDesired = new Set<SandboxDesiredLocation>()
    const seenControl = new Set<ControlState>()
    const seenResource = new Set<ProviderResourceObservation["resource"]>()
    const seenOwnership = new Set<ProviderResourceObservation["ownership"]>()
    const seenClassifications = new Set<SandboxResultV2["classification"]>()

    for (const [index, testCase] of cases.entries()) {
      seenDesired.add(testCase.desiredLocation)
      seenControl.add(testCase.control)
      seenResource.add(testCase.resource)
      seenOwnership.add(testCase.ownership)
      seenClassifications.add(testCase.classification)

      const root = await temporaryDirectory()
      const store = new FileStateStore(root)
      const record = persistedRecord(`ses_phase3_${index}`, testCase)
      await store.write(record)

      const controller = new LifecycleController({
        store,
        capture: async () => ({ baseSha: record.baseSha, patch: "", untracked: [] }),
        providerInspect: async () => ({
          resourceId: "resource-phase3",
          resource: testCase.resource,
          ownership: testCase.ownership,
          health: testCase.health,
          evidence: [testCase.name],
        }),
        ...(testCase.control === "unknown"
          ? {}
          : { providerTarget: async () => testCase.control === "present" ? { type: "remote" as const, url: "https://remote.example.test" } : undefined }),
        workspace: {
          async create() { throw new Error("must not create") },
          async warp() {},
          async remove() {},
          async inspect() { return undefined },
        },
      })
      controller.registerContext({
        sessionId: record.sessionId,
        projectId: record.projectId,
        directory: record.directory,
        worktree: record.directory,
      })

      const result = await controller.handle({
        operation: "inspect",
        force: false,
        capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: testCase.role ?? "host" }),
      })

      expect(result).toMatchObject({
        schemaVersion: 2,
        intent: { desiredLocation: testCase.desiredLocation, phase: "idle" },
        classification: testCase.classification,
      })
      expect(observation(result, "provider")).toMatchObject({
        observed: true,
        resource: testCase.resource,
        ownership: testCase.ownership,
        health: testCase.health,
      })
      expect(observation(result, "handle")).toMatchObject(expectedHandle(testCase.control))

      for (const action of result.allowedActions ?? []) {
        expect(action.arguments).toEqual([])
        if (!["status", "inspect"].includes(action.operation)) expect(action.preconditions.length).toBeGreaterThan(0)
        expect(["none", "session_idle", "operation_completion"]).toContain(action.waitFor)
      }

      if (testCase.action) {
        expect(result.recommendedAction).toEqual({ operation: testCase.action.operation, reasonCode: testCase.action.reasonCode })
        expect(result.allowedActions).toContainEqual(expect.objectContaining({
          operation: testCase.action.operation,
          role: testCase.action.role,
          waitFor: testCase.action.waitFor,
        }))
      } else {
        expect(result.recommendedAction).toBeNull()
      }

      if (["control_lost", "orphan", "leaked_resource", "conflict", "unknown"].includes(testCase.classification)) {
        expect(result.allowedActions?.every((action) => ["status", "inspect", "logs", "diagnose"].includes(action.operation))).toBe(true)
      }
      if (testCase.lastError) {
        expect(result.error).toMatchObject({ code: "SYNC_FAILED", stage: "sync", retryable: true })
      }
    }

    expect([...seenDesired].sort()).toEqual(["deleted", "local", "remote"])
    expect([...seenControl].sort()).toEqual(["absent", "present", "unknown"])
    expect([...seenResource].sort()).toEqual(["absent", "present", "unknown"])
    expect([...seenOwnership].sort()).toEqual(["conflict", "unknown", "verified"])
    expect([...seenClassifications].sort()).toEqual([
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
  })

  it("keeps probe failures retryable but never turns them into destructive actions", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    const record = persistedRecord("ses_probe_error", {
      desiredLocation: "remote",
    })
    await store.write(record)
    const controller = new LifecycleController({
      store,
      providerInspect: async () => { throw new Error("provider unavailable") },
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() {},
        async remove() {},
        async inspect() { return undefined },
      },
    })

    const result = await controller.handle({
      operation: "inspect",
      force: false,
      capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" }),
    })

    expect(result).toMatchObject({
      ok: false,
      schemaVersion: 2,
      classification: "control_lost",
      recommendedAction: { operation: "inspect", reasonCode: "RESOURCE_STATE_UNKNOWN" },
      error: { code: "SANDBOX_ERROR", stage: "inspect", retryable: true },
    })
    expect(result.allowedActions?.every((action) => ["status", "inspect", "logs", "diagnose"].includes(action.operation))).toBe(true)
  })
})

function observation(result: { observations?: SandboxResultV2["observations"] }, source: string) {
  const value = result.observations?.find((item) => item.source === source)
  if (!value) throw new Error(`missing ${source} observation`)
  return value
}

function expectedHandle(control: ControlState): Record<string, unknown> {
  if (control === "present") return { observed: true, resource: "present" }
  if (control === "absent") return { observed: true, resource: "absent" }
  return { observed: false }
}

function persistedRecord(sessionId: string, testCase: Pick<SituationCase, "desiredLocation" | "operation" | "lastError">): PersistedSandboxRecord {
  return {
    sessionId,
    workspaceId: `wrk_${sessionId}`,
    projectId: "prj_phase3",
    provider: "exedev",
    providerState: { resourceId: "resource-phase3" },
    generation: 1,
    directory: "/tmp/phase3-project",
    branch: "opencode/phase3",
    baseSha: "0123456789012345678901234567890123456789",
    schemaVersion: PERSISTED_SANDBOX_SCHEMA_VERSION,
    desiredLocation: testCase.desiredLocation,
    phase: "idle",
    ...(testCase.operation ? { operation: testCase.operation } : {}),
    ...(testCase.lastError ? { lastError: testCase.lastError } : {}),
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-02T00:00:00.000Z",
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "oe-phase3-"))
  temporaryDirectories.push(directory)
  return directory
}
