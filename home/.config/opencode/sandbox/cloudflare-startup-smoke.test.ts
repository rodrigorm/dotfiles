import { afterEach, describe, expect, it, vi } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  connectorSnapshotScript,
  main,
  parseCloudflaredTokenIdentity,
  parseConnectorSnapshotOutput,
  parseTelemetryEvents,
  publicHealthDetails,
  queryTelemetry,
  runSmoke,
  sanitizeSmokeOutput,
} from "./cloudflare-startup-smoke"
import type { CloudflareSandboxClient } from "./cloudflare-bridge"
import { CloudflareProvider } from "./cloudflare-provider"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function smokeWorktree(): Promise<string> {
  const worktree = await mkdtemp(join(process.cwd(), ".cloudflare-startup-smoke-"))
  temporaryDirectories.push(worktree)
  await mkdir(join(worktree, ".opencode"))
  await writeFile(join(worktree, ".opencode", "sandbox.json"), JSON.stringify({
    provider: "sbx",
    apiUrl: "https://bridge.example.test",
    apiKey: "api-key",
  }))
  return worktree
}

describe("Cloudflare provider defaults", () => {
  it.serial("uses the 180-second direct-constructor health deadline", async () => {
    vi.useFakeTimers({ now: Date.now() })
    try {
      let requests = 0
      const provider = new CloudflareProvider({
        worktree: process.cwd(),
        client: {} as CloudflareSandboxClient,
        fetcher: (async () => {
          requests++
          return Response.json({ healthy: false }, { status: 503 })
        }) as unknown as typeof fetch,
      })
      const waitForHealth = (provider as unknown as { waitForHealth(activation: unknown): Promise<void> }).waitForHealth.bind(provider)
      const pending = waitForHealth({ tunnel: { id: "tunnel-1", port: 4096, url: "https://sandbox.example.test" }, password: "private" })

      for (let elapsed = 0; elapsed < 179_750; elapsed += 250) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        vi.advanceTimersByTime(250)
      }

      let settled = false
      const observed = pending.then(() => { settled = true }, () => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(requests).toBeGreaterThan(0)

      await new Promise<void>((resolve) => setImmediate(resolve))
      vi.advanceTimersByTime(250)
      await expect(observed).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("Cloudflare project identity", () => {
  it("seeds the host project identity before starting OpenCode", async () => {
    const projectId = "project-host"
    const baseSha = "a".repeat(40)
    const calls: string[] = []
    const files: Array<{ path: string; content: Uint8Array }> = []
    const client: CloudflareSandboxClient = {
      async createSandbox() { return "sandboxa2" },
      async destroySandbox() { calls.push("destroy-sandbox") },
      async destroyTunnel() { calls.push("destroy-tunnel") },
      async running() { return true },
      async exec(_sandboxId, input) {
        calls.push(input.argv[2]?.includes("opencode serve") ? "server-start" : "exec")
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
      async putFile(_sandboxId, path, content) {
        files.push({ path, content })
        calls.push(`put:${path}`)
      },
      async getFile() { return new Uint8Array() },
      async hydrate() {},
      async tunnel() {
        return { id: "tunnel-1", port: 4096, url: "https://sandbox.example.test" }
      },
    }
    const provider = new CloudflareProvider({
      worktree: process.cwd(),
      client,
      runner: { run: async () => ({ exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }) },
      fetcher: (async () => Response.json({ healthy: true }, { status: 200 })) as unknown as typeof fetch,
      deferActivation: true,
    })
    const info = {
      id: "workspace-1",
      type: "cloudflare" as const,
      name: "workspace",
      branch: "opencode/sandbox-workspace-1",
      directory: "/workspace/.opencode-worktree",
      projectID: projectId,
      extra: { sessionId: "session-1", generation: 1, workspaceId: "workspace-1", projectId, baseSha },
    }

    try {
      await provider.prepare(info, { OPENCODE_AUTH_CONTENT: "{}" })
      await provider.activate(info.id)
    } finally {
      await provider.close(info)
    }

    const identityPath = "/workspace/.opencode-worktree/.git/opencode"
    const identity = files.find((file) => file.path === identityPath)
    expect(identity).toBeDefined()
    expect(new TextDecoder().decode(identity?.content)).toBe(projectId)
    expect(calls.indexOf(`put:${identityPath}`)).toBeLessThan(calls.indexOf("server-start"))
  })
})

describe("Cloudflare startup smoke telemetry", () => {
  it("parses the nested event schema and actual worker/request fields", () => {
    expect(parseTelemetryEvents({
      result: {
        events: {
          count: 1,
          events: [{
            "$workers": { scriptName: "bridge-worker", requestId: "request-1", outcome: "ok" },
            "$metadata": { id: "event-1", level: "info", message: "run-1" },
          }],
        },
      },
    })).toEqual({
      count: 1,
      truncated: false,
      events: [{
        id: "event-1",
        scriptName: "bridge-worker",
        requestId: "request-1",
        outcome: "ok",
        level: "info",
        message: "run-1",
      }],
    })
  })

  it("uses the Workers Logs script-name field and a read-only bounded query", async () => {
    let body: Record<string, unknown> | undefined
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ result: { events: { count: 1, events: [{ "$metadata": { id: "event-1" } }] } } }))
    }) as typeof fetch

    await expect(queryTelemetry({
      accountId: "account-1",
      apiToken: "private-token",
      workerName: "bridge-worker",
      runId: "run-1",
      from: 100,
      to: 200,
      fetcher,
      timeoutMs: 1_000,
    })).resolves.toMatchObject({ events: [{ id: "event-1" }], truncated: false })

    expect(body).toMatchObject({
      timeframe: { from: 100, to: 200 },
      view: "events",
      limit: 25,
      dry: true,
      parameters: {
        filterCombination: "and",
        needle: { value: "run-1", matchCase: true },
        filters: [{ key: "$workers.scriptName", operation: "eq", type: "string", value: "bridge-worker" }],
      },
    })
  })
})

describe("Cloudflare startup smoke", () => {
  it("runs normal health checks, reports safe resources, and cleans up once", async () => {
    const worktree = await smokeWorktree()
    const tunnelId = "550e8400-e29b-41d4-a716-446655440000"
    const calls: string[] = []
    const apiPaths: string[] = []
    let publicHealthRequests = 0
    let telemetryBody: Record<string, unknown> | undefined
    const client: CloudflareSandboxClient = {
      async createSandbox() { calls.push("create"); return "sandboxa2" },
      async destroySandbox() { calls.push("destroy-sandbox") },
      async destroyTunnel() { calls.push("destroy-tunnel") },
      async running() { calls.push("running"); return true },
      async exec(_sandboxId, input) {
        const command = input.argv[2] ?? ""
        if (input.argv[0] === "bun") {
          if (input.stdin === undefined) {
            calls.push("connector")
            return { exitCode: 0, signal: null, stdout: JSON.stringify({
              status: "ok",
              tokenIdentity: { tunnelId },
              processes: [{ pid: 42, role: "cloudflared", state: "running" }],
              listeners: [{ pid: 42, role: "metrics", state: "LISTEN", port: 43123 }],
              endpoints: [{
                port: 43123,
                ready: { status: 200, ok: true, body: { status: "ready", readyConnections: 4 } },
                metrics: { status: 200, ok: true, metrics: { cloudflared_tunnel_config_version: 1, cloudflared_tunnel_ha_connections: 4 } },
              }],
            }), stderr: "" }
          }
          calls.push("loopback")
          return { exitCode: 0, signal: null, stdout: JSON.stringify({ status: 200, body: '{"healthy":true,"version":"test"}' }), stderr: "" }
        }
        if (command.includes("opencode serve")) calls.push("server-start")
        else if (command.includes("server.log")) {
          calls.push("server-log")
          return { exitCode: 0, signal: null, stdout: "META:14:0\nserver started\n", stderr: "" }
        } else if (command.includes("server.pid")) calls.push("cleanup-runtime")
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
      async putFile() {},
      async getFile() { return new Uint8Array() },
      async hydrate() {},
      async tunnel() { calls.push("tunnel"); return { id: tunnelId, port: 4096, url: "https://public.example.test" } },
    }
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? "GET"
      if (url.origin === "https://bridge.example.test") return new Response('{"ok":true}')
      if (url.origin === "https://public.example.test") {
        publicHealthRequests++
        return Response.json({ healthy: true, version: "test" }, { status: 200, headers: { "CF-Ray": `ray-${publicHealthRequests}` } })
      }
      if (url.hostname === "api.cloudflare.com" && url.pathname.endsWith("/workers/observability/telemetry/query")) {
        apiPaths.push(`${method} ${url.pathname}`)
        telemetryBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ result: { events: { count: 1, events: [{ "$workers": { scriptName: "bridge-worker", requestId: "request-1" }, "$metadata": { id: "event-1" } }] } } }))
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch

    const result = await runSmoke({
      client,
      fetcher,
      worktree,
      runId: "normal-run",
      telemetryTimeoutMs: 1_000,
      telemetryPollMs: 1,
      env: {
        HOME: process.env.HOME ?? "/tmp",
        OPENCODE_AUTH_CONTENT: "{}",
        CLOUDFLARE_ACCOUNT_ID: "account-1",
        CLOUDFLARE_API_TOKEN: "telemetry-token",
        CLOUDFLARE_WORKER_NAME: "bridge-worker",
      },
    })

    expect(result).toMatchObject({ outcome: "pass", cleanup: { method: "provider.close", ownership: "verified", ok: true } })
    expect(result.stages).toHaveLength(7)
    expect(result.stages.every((stage) => stage.status === "PASS" && stage.startedAt && stage.endedAt)).toBe(true)
    expect(result.stages.find((stage) => stage.name === "config")).toMatchObject({ details: { healthTimeoutMs: 180_000 } })
    expect(result.resources).toEqual({ sandboxId: "sandboxa2", tunnelUrl: "https://public.example.test", tunnelHostname: "public.example.test", tunnelPort: 4096 })
    expect(sanitizeSmokeOutput(result.resources)).toMatchObject({ tunnelUrl: "[REDACTED]", tunnelHostname: "public.example.test" })
    expect(result.evidence).toMatchObject({
      loopback: { available: true, ok: true, status: 200, healthy: true, authenticated: true },
      serverLog: { available: true, text: "server started\n" },
      connector: { status: "ok", tokenIdentity: { tunnelId }, config_version: 1, ha_connections: 4, readyConnections: 4 },
    })
    expect(result.telemetry).toMatchObject({ status: "correlated", events: [{ id: "event-1", scriptName: "bridge-worker", requestId: "request-1" }] })
    expect(telemetryBody).toMatchObject({ dry: true, parameters: { needle: { value: "normal-run" } } })
    expect(apiPaths).toEqual(["POST /client/v4/accounts/account-1/workers/observability/telemetry/query"])
    expect(publicHealthRequests).toBe(2)
    expect(calls.indexOf("connector")).toBeLessThan(calls.indexOf("cleanup-runtime"))
    expect(calls.indexOf("server-log")).toBeLessThan(calls.indexOf("cleanup-runtime"))
    expect(calls.indexOf("cleanup-runtime")).toBeLessThan(calls.indexOf("destroy-tunnel"))
    expect(calls.filter((call) => call === "destroy-tunnel")).toHaveLength(1)
    expect(calls.filter((call) => call === "destroy-sandbox")).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain("telemetry-token")
  })

  it("retains public health error context without leaking the body", () => {
    const body = [
      "<!doctype html><html><head><title>Cloudflare Tunnel error</title>",
      `<style>${"x".repeat(700)}</style><script>${"y".repeat(700)}</script>`,
      "</head><body><h1>Cloudflare Tunnel error</h1><p>Error <span>1033</span></p>",
      "<p>https://secret.example.test Cookie: session=private Authorization: Bearer private</p></body></html>",
    ].join("")
    const details = publicHealthDetails(530, body, false, "ray-123", ["private"])

    expect(details).toMatchObject({ status: 530, subcode: 1033, cfRay: "ray-123", body: expect.stringContaining("Error 1033") })
    expect(String(details.body)).not.toContain("<html>")
    expect(String(details.body)).not.toContain("secret.example.test")
    expect(String(details.body)).not.toContain("session=private")
    expect(String(details.body)).not.toContain("Bearer private")
    expect(Buffer.byteLength(String(details.body))).toBeLessThanOrEqual(1024)
    expect(publicHealthDetails(530, "", false, null, [])).toMatchObject({ status: 530, body: "", subcode: null, cfRay: null })
  })
})

describe("Cloudflare startup smoke output", () => {
  it("extracts the tunnel UUID from a documented cloudflared token", () => {
    const tunnelId = "550e8400-e29b-41d4-a716-446655440000"
    const token = Buffer.from(JSON.stringify({ a: "a".repeat(32), t: tunnelId, s: "connector-secret" })).toString("base64")
    expect(parseCloudflaredTokenIdentity(token)).toEqual({ tunnelId })
  })

  it("records bounded connector output without exposing labels or credential fields", () => {
    expect(parseConnectorSnapshotOutput(JSON.stringify({
      status: "ok",
      processes: [{ pid: 42, role: "cloudflared", state: "running" }],
      listeners: [{ pid: 42, role: "metrics", state: "LISTEN", port: 43123 }],
      endpoints: [{ port: 43123, ready: { status: 200, ok: true, body: { status: "ready" } }, metrics: { status: 200, ok: true, metrics: { cloudflared_tunnel_config_version: 1, cloudflared_tunnel_ha_connections: 4 } }, token: "private-token" }],
    }), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z", ["private-token"])).toMatchObject({
      status: "ok",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
      endpoints: [{ metrics: { metrics: { cloudflared_tunnel_config_version: 1, cloudflared_tunnel_ha_connections: 4 } }, token: "[REDACTED]" }],
      config_version: 1,
      ha_connections: 4,
    })
  })

  it("executes the connector snippet locally when proc is inaccessible", async () => {
    const worktree = await mkdtemp(join(process.cwd(), ".cloudflare-startup-smoke-"))
    temporaryDirectories.push(worktree)
    const child = Bun.spawn(["bun", "-e", connectorSnapshotScript(join(worktree, "missing-proc"))], { stdout: "pipe", stderr: "pipe" })
    const output = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    expect(JSON.parse(output)).toMatchObject({ status: "inaccessibleproc", processes: [], listeners: [] })
  })

  it("maps a synthetic cloudflared socket and keeps token contents out of output", async () => {
    const procRoot = await mkdtemp(join(process.cwd(), ".cloudflare-startup-smoke-proc-"))
    temporaryDirectories.push(procRoot)
    await mkdir(join(procRoot, "42", "fd"), { recursive: true })
    await mkdir(join(procRoot, "net"))
    const tunnelId = "550e8400-e29b-41d4-a716-446655440000"
    const token = Buffer.from(JSON.stringify({ a: "a".repeat(32), t: tunnelId, s: "connector-secret" })).toString("base64")
    await writeFile(join(procRoot, "42", "comm"), "cloudflared\n")
    await writeFile(join(procRoot, "42", "cmdline"), `/usr/bin/cloudflared\0tunnel\0run\0--token\0${token}\0`)
    await symlink("socket:[12345]", join(procRoot, "42", "fd", "3"))
    await symlink("socket:[12346]", join(procRoot, "42", "fd", "4"))
    await writeFile(join(procRoot, "net", "tcp"), "sl local_address rem_address st tx_queue tr tm->when retrnsmt uid timeout inode\n0: 0100007F:FFFF 00000000:0000 0A 00000000:0000 00:00000000 00000000 1000 0 12345\n")
    await writeFile(join(procRoot, "net", "tcp6"), "sl local_address rem_address st tx_queue tr tm->when retrnsmt uid timeout inode\n0: 00000000000000000000000001000000:FFFF 00000000000000000000000000000000:0000 0A 00000000:0000 00:00000000 00000000 1000 0 12346\n")

    const child = Bun.spawn(["bun", "-e", connectorSnapshotScript(procRoot)], { stdout: "pipe", stderr: "pipe" })
    const output = await new Response(child.stdout).text()
    const snapshot = JSON.parse(output) as Record<string, unknown>
    expect(await child.exited).toBe(0)
    expect(snapshot).toMatchObject({ status: "fetchfail", processes: [{ pid: 42, role: "cloudflared", state: "running" }], tokenIdentity: { tunnelId } })
    expect(output).not.toContain(token)
    expect(output).not.toContain("connector-secret")
    expect(snapshot.listeners).toEqual(expect.arrayContaining([
      { pid: 42, role: "metrics", state: "LISTEN", port: 65535, family: "tcp", host: "127.0.0.1" },
      { pid: 42, role: "metrics", state: "LISTEN", port: 65535, family: "tcp6", host: "::1" },
    ]))
  })

  it("redacts credential fields and embedded secrets", () => {
    expect(sanitizeSmokeOutput({ apiKey: "private-api-key", sshKey: "private-ssh-key", nested: { password: "private-password" }, message: "token=private-api-key" }, ["private-api-key", "private-password"])).toEqual({
      apiKey: "[REDACTED]",
      sshKey: "[REDACTED]",
      nested: { password: "[REDACTED]" },
      message: "token=[REDACTED]",
    })
  })

  it("handles help without loading configuration or creating resources", async () => {
    let output = ""
    await expect(main(["--help"], { stdout: (text) => { output += text } })).resolves.toBe(0)
    expect(output).toContain("Usage: bun home/.config/opencode/sandbox/cloudflare-startup-smoke.ts")
  })
})
