import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createCapability, ControlChannel } from "./control-channel"
import { runCli } from "./cli"
import { LifecycleController } from "./lifecycle"
import { createSandboxPlugin } from "./plugin-runtime"
import { trackedProcessObservation } from "./process"
import { redactText } from "./redaction"
import { FileStateStore } from "./state-store"
import { HttpWorkspaceGateway } from "./workspace-http"
import type {
  ProcessHandle,
  ProviderResourceObservation,
  SandboxRecord,
  WorkspaceGateway,
  WorkspaceInfo,
} from "./types"

const roots: string[] = []
const NOW = new Date("2026-09-08T12:00:00.000Z")

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("diagnostic bundle", () => {
  it("returns fixed, fresh observations and preserves version provenance", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = makeRecord({
      provider: "sbx",
      providerState: { resourceId: "sandbox-1", remoteWorktreePath: "/workspace/project/.opencode-worktree" },
      preservedWorktreePath: "/tmp/preserved-worktree",
    })
    await store.write(record)
    const calls: string[] = []
    const provider: ProviderResourceObservation = {
      resourceId: "sandbox-1",
      resource: "present",
      ownership: "verified",
      health: "healthy",
      remoteVersion: "1.18.24",
      evidence: ["fixture provider"],
    }
    const controller = new LifecycleController({
      store,
      now: () => NOW,
      diagnosticSources: () => ({ configured: "1.18.25", local: "1.18.23", dependency: "1.18.23" }),
      providerInspect: async () => {
        calls.push("provider")
        return provider
      },
      gitInspect: async () => {
        calls.push("git")
        return { head: record.baseSha, branch: record.branch, dirty: false, evidence: ["fixture git"] }
      },
      workspace: diagnosticWorkspace(record, calls),
    })

    const result = await controller.handle({
      operation: "diagnose",
      force: false,
      capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" }),
    })
    const details = result.details as Record<string, any>
    const versions = details.results.versions

    expect(result).toMatchObject({ ok: true, operation: "diagnose", state: "remote" })
    expect(details).toMatchObject({ schemaVersion: 1, generatedAt: NOW.toISOString(), capabilities: { readOnly: true, restart: "unknown" } })
    expect(details.limits).toMatchObject({ maxSeconds: 30, maxProbes: 5, maxResponseBytes: 64 * 1024 })
    expect(versions).toMatchObject({
      configured: { value: "1.18.25", observed: true, provenance: "sandbox configuration", freshAt: NOW.toISOString() },
      local: { value: "1.18.23", observed: true },
      dependency: { value: "1.18.23", observed: true },
      remote: { value: "1.18.24", observed: true, provenance: "provider health observation" },
    })
    expect(details.results.providerObservation).toMatchObject({ resource: "present", ownership: "verified", health: "healthy" })
    expect(details.results.workspaceAssociation).toMatchObject({ observed: true, ownership: "verified" })
    expect(details.results.processOwnership).toMatchObject({ observed: false, process: "unknown", ownership: "unknown" })
    expect(details.results.summary).toBe("provider=sbx state=remote classification=unknown resource=present ownership=verified health=healthy")
    expect(calls.sort()).toEqual(["git", "provider", "workspace"])
  })

  it("marks missing sources unknown and reconstructs the persisted journal", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = makeRecord({
      desiredLocation: "remote",
      phase: "idle",
      state: "error",
      operation: { kind: "start", phase: "remote", requestId: "start-1" },
      lastError: { stage: "sync", code: "SYNC_FAILED", message: "argv=private sync failed" },
      journal: [{
        requestId: "start-1",
        operation: "start",
        startedAt: NOW.toISOString(),
        endedAt: new Date(NOW.getTime() + 1_000).toISOString(),
        resultCode: "SYNC_FAILED",
        evidence: ["phase:remote"],
      }],
    })
    await store.write(record)
    const controller = new LifecycleController({
      store,
      now: () => NOW,
      workspace: diagnosticWorkspace(record, []),
    })

    const result = await controller.handle({
      operation: "diagnose",
      force: false,
      capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" }),
    })
    const details = result.details as Record<string, any>
    const versions = details.results.versions

    expect(versions.configured).toMatchObject({ value: null, observed: false })
    expect(versions.local).toMatchObject({ value: null, observed: false })
    expect(versions.dependency).toMatchObject({ value: null, observed: false })
    expect(versions.remote).toMatchObject({ value: null, observed: false })
    expect(details.results.providerObservation).toMatchObject({ resource: "unknown", ownership: "unknown", health: "unknown", value: null })
    expect(details.results.processOwnership).toMatchObject({ observed: false, process: "unknown", liveness: "unknown" })
    expect(details.results.operationJournal).toEqual(record.journal)
    expect(details.results.state).toMatchObject({ desiredLocation: "remote", phase: "idle", compatibilityState: "sync_failed" })
    expect(details.results.state.lastError.message).toBe("argv=[REDACTED] sync failed")
  })

  it("reports only tracked process ownership and liveness", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = makeRecord()
    await store.write(record)
    const handle: ProcessHandle = {
      pid: 1234,
      alive: true,
      result: Promise.resolve({ exitCode: null, signal: null, stdout: "", stderr: "" }),
      terminate() {},
    }
    const controller = new LifecycleController({
      store,
      now: () => NOW,
      processInspect: () => trackedProcessObservation(handle),
      workspace: diagnosticWorkspace(record, []),
    })

    const result = await controller.handle({
      operation: "diagnose",
      force: false,
      capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" }),
    })

    expect(result.details).toMatchObject({ results: { processOwnership: {
      observed: true,
      process: "present",
      ownership: "verified",
      liveness: "running",
      pid: 1234,
    } } })
  })

  it("redacts arbitrary diagnostics and stays below the transport limit", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = makeRecord()
    await store.write(record)
    const controller = new LifecycleController({
      store,
      now: () => NOW,
      infrastructure: {
        diagnose: async () => ({
          token: "private-token",
          headers: { Authorization: "Bearer private-token" },
          argv: ["opencode", "--password", "private-token"],
          env: { SECRET: "private-token" },
          output: `https://private.example.test token=private-token ${"x".repeat(200_000)}`,
        }),
      },
      workspace: diagnosticWorkspace(record, []),
    })
    const capability = createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" })
    const channel = new ControlChannel({
      socketPath: join(await temporaryDirectory(), "control.sock"),
      handler: (request) => controller.handle(request),
    })
    channel.register(capability)
    await channel.start()

    try {
      const output: string[] = []
      await expect(runCli(["diagnose"], {
        SANDBOX_CONTROL_SOCKET: channel.socketPath,
        SANDBOX_CONTROL_TOKEN: capability.token,
      }, { stdout: (text) => output.push(text) })).resolves.toBe(0)
      const text = output[0] ?? ""
      const result = JSON.parse(text) as { details: Record<string, any> }

      expect(Buffer.byteLength(text)).toBeLessThan(64 * 1024)
      expect(result.details).toMatchObject({ truncated: true, summary: expect.any(String) })
      expect(text).not.toContain("private-token")
      expect(text).not.toContain("https://private.example.test")
      expect(text).not.toContain("Authorization")
      expect(text).not.toContain("argv")
      expect(text).not.toContain("SECRET")
    } finally {
      await channel.close()
    }
  })

  it("bounds stalled diagnostic hooks and consumes late rejection", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = makeRecord()
    await store.write(record)
    const controller = new LifecycleController({
      store,
      diagnosticTimeoutMs: 10,
      diagnosticSources: () => new Promise((_, reject) => {
        setTimeout(() => reject(new Error("late diagnostic failure")), 40)
      }),
      infrastructure: {
        diagnose: () => new Promise<Record<string, unknown>>(() => {}),
      },
      workspace: diagnosticWorkspace(record, []),
    })
    const started = Date.now()

    const result = await controller.handle({
      operation: "diagnose",
      force: false,
      capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" }),
    })

    expect(Date.now() - started).toBeLessThan(1_000)
    expect(result).toMatchObject({ ok: false, error: { code: "DIAGNOSTIC_TIMEOUT" } })
    expect((result.details as Record<string, any>).results).toMatchObject({
      errors: ["DIAGNOSTIC_TIMEOUT", "DIAGNOSTIC_TIMEOUT"],
      probeBudget: { used: 3, timedOut: 2 },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  it("cancels a stalled diagnostic response body", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = makeRecord()
    await store.write(record)
    let cancelled = false
    const workspace = new HttpWorkspaceGateway({
      serverUrl: "http://127.0.0.1:4096",
      directory: record.directory,
      projectId: record.projectId,
      fetcher: async () => new Response(new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode("["))
        },
        cancel() {
          cancelled = true
        },
      }), { status: 200 }),
    })
    const controller = new LifecycleController({ store, diagnosticTimeoutMs: 10, workspace })

    const result = await controller.handle({
      operation: "diagnose",
      force: false,
      capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" }),
    })

    expect(result).toMatchObject({ ok: false, error: { code: "DIAGNOSTIC_TIMEOUT" } })
    expect((result.details as Record<string, any>).results.workspaceAssociation).toMatchObject({
      observed: true,
      evidence: ["diagnostic probe timed out"],
    })
    expect(cancelled).toBe(true)
  })

  it("uses at most five actual diagnostic probes", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = makeRecord({ preservedWorktreePath: "/tmp/preserved-worktree" })
    await store.write(record)
    const calls: string[] = []
    const controller = new LifecycleController({
      store,
      diagnosticSources: () => { calls.push("versions"); return { configured: "1.18.25" } },
      providerDiagnose: async () => {
        calls.push("provider")
        return { resourceId: "resource-1", resource: "present", ownership: "verified", health: "healthy", evidence: [] }
      },
      gitInspect: async () => {
        calls.push("git")
        return { head: record.baseSha, branch: record.branch, dirty: false, evidence: [] }
      },
      infrastructure: { diagnose: async () => { calls.push("infrastructure"); return { status: "ok" } } },
      workspace: diagnosticWorkspace(record, calls),
    })

    const result = await controller.handle({
      operation: "diagnose",
      force: false,
      capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" }),
    })
    const details = result.details as Record<string, any>

    expect(calls).toHaveLength(5)
    expect(details.results.probeBudget).toMatchObject({ max: 5, used: 5, timedOut: 0 })
  })

  it("preserves completed diagnostic sources when another probe times out", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = makeRecord({ preservedWorktreePath: "/tmp/preserved-worktree" })
    await store.write(record)
    const controller = new LifecycleController({
      store,
      diagnosticTimeoutMs: 10,
      diagnosticSources: async () => ({ configured: "1.18.25" }),
      providerDiagnose: () => new Promise<ProviderResourceObservation>(() => {}),
      gitInspect: async () => ({ head: record.baseSha, branch: record.branch, dirty: false, evidence: ["git completed"] }),
      workspace: diagnosticWorkspace(record, []),
    })

    const result = await controller.handle({
      operation: "diagnose",
      force: false,
      capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" }),
    })
    const details = result.details as Record<string, any>

    expect(result.ok).toBe(false)
    expect(details.results.versions.configured).toMatchObject({ value: "1.18.25", observed: true })
    expect(details.results.providerObservation).toMatchObject({
      observed: true,
      resource: "unknown",
      evidence: ["diagnostic probe timed out"],
    })
    expect(details.results.gitObservation).toMatchObject({ observed: true, evidence: ["git completed"] })
    expect(details.results.errors).toContain("DIAGNOSTIC_TIMEOUT")
  })

  it("keeps normal inspect independent from diagnostic probes", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = makeRecord()
    await store.write(record)
    const calls: string[] = []
    const controller = new LifecycleController({
      store,
      diagnosticSources: () => { calls.push("versions"); return { configured: "1.18.25" } },
      providerInspect: async () => {
        calls.push("inspect")
        return { resourceId: "resource-1", resource: "present", ownership: "verified", health: "healthy", evidence: [] }
      },
      providerDiagnose: async () => {
        calls.push("diagnose")
        return { resourceId: "resource-1", resource: "present", ownership: "verified", health: "healthy", remoteVersion: "1.18.24", evidence: [] }
      },
      infrastructure: { diagnose: async () => { calls.push("infrastructure"); return { status: "ok" } } },
      workspace: diagnosticWorkspace(record, calls),
    })
    const capability = createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" })

    await controller.handle({ operation: "inspect", force: false, capability })
    expect(calls).toContain("inspect")
    expect(calls).not.toContain("versions")
    expect(calls).not.toContain("diagnose")
    expect(calls).not.toContain("infrastructure")

    await controller.handle({ operation: "diagnose", force: false, capability })
    expect(calls.filter((call) => call === "inspect")).toHaveLength(1)
    expect(calls.filter((call) => call === "diagnose")).toHaveLength(1)
    expect(calls.filter((call) => call === "versions")).toHaveLength(1)
    expect(calls.filter((call) => call === "infrastructure")).toHaveLength(1)
  })

  it("redacts cookie, SSH key, and credentialless endpoint values", async () => {
    const text = [
      "cookie=private-cookie",
      "Set-Cookie: session=private-cookie",
      "sshKey=private-key",
      "ssh://user:private-password@host.example",
      "https://host.example/health",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "private-key-material",
      "-----END OPENSSH PRIVATE KEY-----",
      "-----BEGIN RSA PRIVATE KEY-----",
      "pem-private-key-material",
      "-----END RSA PRIVATE KEY-----",
      "-----BEGIN EC PRIVATE KEY-----",
      "ec-material",
      "-----END EC PRIVATE KEY-----",
      "-----BEGIN PRIVATE KEY-----",
      "pkcs8-material",
      "-----END PRIVATE KEY-----",
      "-----BEGIN ENCRYPTED PRIVATE KEY-----",
      "encrypted-pkcs8-material",
      "-----END ENCRYPTED PRIVATE KEY-----",
      String.raw`{"url":"https:\/\/user:private-password@host.example\/health"}`,
    ].join(" ")
    const redacted = redactText(text)

    expect(redacted).not.toContain("private-cookie")
    expect(redacted).not.toContain("private-key")
    expect(redacted).not.toContain("private-key-material")
    expect(redacted).not.toContain("pem-private-key-material")
    expect(redacted).not.toContain("ec-material")
    expect(redacted).not.toContain("pkcs8-material")
    expect(redacted).not.toContain("encrypted-pkcs8-material")
    expect(redacted).not.toContain("private-password")
    expect(redacted).not.toContain("ssh://")
    expect(redacted).not.toContain("https://")
    expect(redacted).not.toContain(String.raw`https:\/\/`)
    expect(redacted).toContain("Set-Cookie: [REDACTED]")
    expect(redactText("--password=private-password")).toBe("--password=[REDACTED]")

    const store = new FileStateStore(await temporaryDirectory())
    const record = makeRecord({
      journal: [{
        requestId: "diagnostic-redaction",
        operation: "start",
        startedAt: NOW.toISOString(),
        resultCode: "OK",
        evidence: [text],
      }],
    })
    await store.write(record)
    const controller = new LifecycleController({ store, workspace: diagnosticWorkspace(record, []) })
    const result = await controller.handle({
      operation: "diagnose",
      force: false,
      capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" }),
    })

    const diagnosticText = JSON.stringify(result)
    expect(diagnosticText).not.toContain("private-cookie")
    expect(diagnosticText).not.toContain("private-key")
    expect(diagnosticText).not.toContain("private-password")
    expect(diagnosticText).not.toContain("ssh://")
    expect(diagnosticText).not.toContain("https://")
    expect(diagnosticText).not.toContain(String.raw`https:\/\/`)
  })

  it("bounds diagnostic hook traversal before serializing untrusted values", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = makeRecord()
    await store.write(record)
    let reads = 0
    let enumerations = 0
    const payload = new Proxy({
      message: "x".repeat(100_000),
      nested: { nested: { nested: { nested: { message: "too deep" } } } },
    }, {
      get(target, property, receiver) {
        reads++
        return Reflect.get(target, property, receiver)
      },
      ownKeys() {
        enumerations++
        throw new Error("diagnostic hook must not enumerate untrusted keys")
      },
    })
    const controller = new LifecycleController({
      store,
      infrastructure: {
        diagnose: async () => payload as unknown as Record<string, unknown>,
      },
      workspace: diagnosticWorkspace(record, []),
    })

    const result = await controller.handle({
      operation: "diagnose",
      force: false,
      capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" }),
    })
    const details = result.details as Record<string, unknown>

    expect(result.ok).toBe(true)
    expect(details).toMatchObject({ configured: true, truncated: true })
    expect(enumerations).toBe(0)
    expect(reads).toBeLessThan(100)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64 * 1024)
    expect(JSON.stringify(result)).not.toContain("too deep")
  })

  it("uses the default plugin wiring for the diagnostic operation", async () => {
    const root = await temporaryDirectory()
    let registeredType = ""
    const hooks = await createSandboxPlugin(
      {
        project: { id: "prj_1" },
        directory: root,
        worktree: root,
        serverUrl: new URL("http://127.0.0.1:4096"),
        experimental_workspace: { register: (type) => { registeredType = type } },
      },
      {
        config: { provider: "sbx" },
        env: { HOME: root, XDG_RUNTIME_DIR: root, OPENCODE_EXPERIMENTAL_WORKSPACES: "1" },
      },
    )
    if (!hooks) throw new Error("default sandbox plugin did not initialize")

    try {
      const shell = { env: {} as Record<string, string> }
      await hooks["shell.env"]({ cwd: root, sessionID: "ses_default" }, shell)
      const output: string[] = []
      await expect(runCli(["diagnose"], {
        SANDBOX_CONTROL_SOCKET: shell.env.SANDBOX_CONTROL_SOCKET,
        SANDBOX_CONTROL_TOKEN: shell.env.SANDBOX_CONTROL_TOKEN,
      }, { stdout: (text) => output.push(text) })).resolves.toBe(0)
      const result = JSON.parse(output[0] ?? "") as { details: Record<string, any> }

      expect(registeredType).toBe("sbx")
      expect(result.details).toMatchObject({
        schemaVersion: 1,
        results: { versions: {
          configured: { value: "1.18.23", observed: true },
          dependency: { value: "1.18.23", observed: true },
        } },
      })
    } finally {
      await hooks.dispose()
    }
  })
})

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opencode-diagnostics-test-"))
  roots.push(root)
  return root
}

function makeRecord(overrides: Partial<SandboxRecord> = {}): SandboxRecord {
  return {
    sessionId: "ses_1",
    workspaceId: "wrk_1",
    projectId: "prj_1",
    provider: "sbx",
    providerState: { resourceId: "resource-1" },
    generation: 1,
    directory: "/tmp/project",
    branch: "opencode/sandbox-test",
    baseSha: "0123456789012345678901234567890123456789",
    state: "remote",
    desiredLocation: "remote",
    phase: "idle",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  }
}

function diagnosticWorkspace(record: SandboxRecord, calls: string[]): WorkspaceGateway {
  const directory = typeof record.providerState.remoteWorktreePath === "string"
    ? record.providerState.remoteWorktreePath
    : record.directory
  const info: WorkspaceInfo = {
    id: record.workspaceId,
    type: record.provider,
    name: "workspace",
    branch: record.branch,
    directory,
    projectID: record.projectId,
    extra: { owner: "opencode-sandbox" },
  }
  return {
    async create() { throw new Error("diagnose must not create a workspace") },
    async warp() { throw new Error("diagnose must not warp a workspace") },
    async remove() { throw new Error("diagnose must not remove a workspace") },
    async inspect() {
      calls.push("workspace")
      return info
    },
  }
}
