import { afterEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, truncate, utimes, writeFile } from "node:fs/promises"
import { createConnection, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createWorktree, type IsolatedSandboxHandle, type Sandbox } from "@ai-hero/sandcastle"

import { DEFAULT_CONFIG, parseConfig } from "./config"
import { ControlChannel, createCapability, parseControlRequest } from "./control-channel"
import { buildExeDevSshArgv, DEFAULT_EXEDEV_COMMAND_TIMEOUT_MS, SshExeControl } from "./exe-control"
import { FileStateStore } from "./state-store"
import { buildRemoteCommandArgv, buildSupervisorArgv, MAX_UNIX_SOCKET_PATH_BYTES } from "./remote-runtime"
import { parseCliArgs, requestControl, requestControlMailbox, runCli } from "./cli"
import { identityMatches, makeVmPlan, shortHash } from "./naming"
import { redactText } from "./redaction"
import { LifecycleController } from "./lifecycle"
import { createSandboxPlugin, readSessionEvents, resolveAuthContent, type WorkspaceAdapterLike } from "./plugin-runtime"
import { nodeProcessRunner, nodeProcessSupervisor } from "./process"
import { createExedevSandcastleAdapter, ensureExeDevVmHostKey, ExedevProvider, REMOTE_WRITE_FILE, remoteWorkspaceDirectory } from "./exedev-provider"
import { createSbxSandcastleAdapter, SbxProvider } from "./sbx-provider"
import { CloudflareBridgeClient, type CloudflareSandboxClient } from "./cloudflare-bridge"
import { CloudflareProvider, createCloudflareSandcastleAdapter } from "./cloudflare-provider"
import { captureWorkingTree, inspectWorkingTree } from "./working-tree"
import {
  HttpWorkspaceGateway,
  MAX_REPLAY_EVENTS,
  MAX_REPLAY_HISTORY_BYTES,
  MAX_REPLAY_REQUEST_BYTES,
  readLimitedBody,
} from "./workspace-http"
import { runSyncBarrier } from "./sync-barrier"
import type { ExeControl } from "./exe-control"
import { isWorkspaceSyncResult } from "./types"
import { SandboxError, type GitWorkingTreeObservation, type ProviderResourceObservation, type RuntimeDriver, type SandboxRecord, type ProcessHandle, type ProcessResult, type ProcessRunner, type ProcessSupervisor, type VmInfo } from "./types"

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
    expect(parseCliArgs(["repair"], false)).toEqual({ operation: "repair", force: false })
    expect(parseCliArgs(["recover"], false)).toEqual({ operation: "recover", force: false })
    expect(() => parseCliArgs(["recover"], true)).toThrow(/host/i)
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

  it("preserves the validation error code in its JSON response", async () => {
    const cases = [
      { argv: ["unknown"], env: {}, code: "CLI_OPERATION" },
      { argv: ["delete", "--force"], env: { SANDBOX_CONTROL_ROLE: "remote" }, code: "CLI_FORCE" },
      { argv: ["start"], env: { SANDBOX_CONTROL_ROLE: "remote" }, code: "CLI_START" },
      { argv: ["inventory"], env: { SANDBOX_CONTROL_ROLE: "remote" }, code: "CLI_INVENTORY" },
      { argv: ["repair"], env: { SANDBOX_CONTROL_ROLE: "remote" }, code: "CLI_REPAIR" },
      { argv: ["recover"], env: { SANDBOX_CONTROL_ROLE: "remote" }, code: "CLI_RECOVER" },
      { argv: ["status", "unexpected"], env: {}, code: "CLI_ARGUMENT" },
    ] as const

    for (const testCase of cases) {
      const stdout: string[] = []
      await expect(runCli(testCase.argv, testCase.env, { stdout: (text) => stdout.push(text) })).resolves.toBe(2)
      expect(JSON.parse(stdout[0] ?? "")).toMatchObject({ error: { code: testCase.code, stage: "validate" } })
    }
  })

  it("reports stable V2 endpoint and project-auth errors", async () => {
    const cases = [
      { argv: ["status"], env: {}, code: "CONTROL_ENDPOINT" },
      { argv: ["inventory"], env: { SANDBOX_CONTROL_SOCKET: "/tmp/control.sock", SANDBOX_CONTROL_TOKEN: "session-token" }, code: "CONTROL_TOKEN" },
    ] as const

    for (const testCase of cases) {
      const stdout: string[] = []
      await expect(runCli(testCase.argv, testCase.env, { stdout: (text) => stdout.push(text) })).resolves.toBe(1)
      expect(JSON.parse(stdout[0] ?? "")).toMatchObject({ schemaVersion: 2, error: { code: testCase.code } })
    }
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
    expect(parseConfig({ provider: "cloudflare", apiUrl: "https://bridge.example.test", apiKey: "test-key" }, { HOME: "/tmp" }).provider).toBe("cloudflare")
    expect(parseConfig({ openCodeVersion: "1.2.3" }, { HOME: "/tmp" }).openCodeVersion).toBe("1.2.3")
    expect(() => parseConfig({ unexpected: true }, { HOME: "/tmp" })).toThrow(/unknown configuration key/i)
    expect(() => parseConfig({ baseVm: "vm; rm -rf /" }, { HOME: "/tmp" })).toThrow(/baseVm/i)
    expect(() => parseConfig({ sshLobby: "exe.dev && whoami" }, { HOME: "/tmp" })).toThrow(/sshLobby/i)
  })

  it("uses a longer Cloudflare health default without changing other providers", () => {
    const cloudflare = { provider: "cloudflare", apiUrl: "https://bridge.example.test", apiKey: "test-key" }

    expect(parseConfig(cloudflare, { HOME: "/tmp" }).healthTimeoutMs).toBe(180_000)
    expect(parseConfig({ provider: "sbx" }, { HOME: "/tmp" }).healthTimeoutMs).toBe(DEFAULT_CONFIG.healthTimeoutMs)
    expect(parseConfig({ provider: "exedev" }, { HOME: "/tmp" }).healthTimeoutMs).toBe(DEFAULT_CONFIG.healthTimeoutMs)
    expect(parseConfig({ ...cloudflare, healthTimeoutMs: 15_000 }, { HOME: "/tmp" }).healthTimeoutMs).toBe(15_000)
  })

  it("validates optional Cloudflare settings without exposing credentials", () => {
    expect(parseConfig({ provider: "sbx", apiUrl: null, apiKey: null }, { HOME: "/tmp" })).toMatchObject({ apiUrl: null, apiKey: null })
    expect(() => parseConfig({ provider: "cloudflare" }, { HOME: "/tmp" })).toThrow(/requires apiUrl and apiKey/i)
    expect(() => parseConfig({ provider: "cloudflare", apiUrl: "https://bridge.example.test" }, { HOME: "/tmp" })).toThrow(/requires apiUrl and apiKey/i)
    expect(() => parseConfig({ apiUrl: "" }, { HOME: "/tmp" })).toThrow(/apiUrl/i)
    expect(() => parseConfig({ apiKey: "" }, { HOME: "/tmp" })).toThrow(/apiKey/i)
    expect(() => parseConfig({ apiUrl: 42 }, { HOME: "/tmp" })).toThrow(/apiUrl/i)

    const secret = "config-secret-that-must-not-escape"
    let error: unknown
    try {
      parseConfig({ apiUrl: `https://${secret}@bridge.example.test` }, { HOME: "/tmp" })
    } catch (value) {
      error = value
    }
    expect(String(error)).not.toContain(secret)
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

  it("redacts camelCase credential keys without matching benign fields", () => {
    const text = redactText(JSON.stringify({
      controlToken: "control-secret",
      serverPassword: "password-secret",
      authContent: "auth-secret",
      author: "keep-author",
      tokenCount: 3,
      passwordHint: "keep-hint",
    }))

    expect(text).not.toContain("control-secret")
    expect(text).not.toContain("password-secret")
    expect(text).not.toContain("auth-secret")
    expect(text).toContain('"author":"keep-author"')
    expect(text).toContain('"tokenCount":3')
    expect(text).toContain('"passwordHint":"keep-hint"')
  })

  it("redacts escaped JSON credential keys without parsing the whole value", () => {
    const text = redactText(String.raw`{"pass\u0077ord":"escaped-password","\u0074oken":"escaped-token","author":"keep-author"} trailing text`)

    expect(text).not.toContain("escaped-password")
    expect(text).not.toContain("escaped-token")
    expect(text).toContain(String.raw`"pass\u0077ord":"[REDACTED]"`)
    expect(text).toContain(String.raw`"\u0074oken":"[REDACTED]"`)
    expect(text).toContain(String.raw`"author":"keep-author"`)
  })

  it("redacts quoted credential assignments without consuming adjacent fields", () => {
    const cases = [
      ['password="foo bar" adjacent="keep this"', 'password=[REDACTED] adjacent="keep this"'],
      ["password='foo bar' adjacent='keep this'", "password=[REDACTED] adjacent='keep this'"],
      ['{"password":"foo bar","message":"keep this"}', '{"password":"[REDACTED]","message":"keep this"}'],
    ] as const

    for (const [input, expected] of cases) expect(redactText(input)).toBe(expected)
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
    expect(argv[argv.indexOf("-F") + 1]).toBe("/dev/null")
    expect(argv).toEqual(expect.arrayContaining(["-l", "user", "StrictHostKeyChecking=yes", "ForwardAgent=no"]))
    expect(argv).not.toContain("ClearAllForwardings=yes")
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

  it("rejects a local Unix socket at the OpenSSH path limit", () => {
    const localControlSocket = `/${"x".repeat(MAX_UNIX_SOCKET_PATH_BYTES - 1)}`

    expect(() => buildSupervisorArgv({
      sshBin: "/usr/bin/ssh",
      knownHostsFile: "/tmp/known_hosts",
      destination: "vm.exe.xyz",
      remotePort: 4096,
      localPort: 4100,
      localControlSocket,
      remoteControlSocket: "/tmp/oe-r/c.sock",
      remoteLauncherPath: "/tmp/oe-r/launcher",
    })).toThrow(/socket.*too long/i)
  })
})

describe("exe.dev VM host keys", () => {
  const official = "SHA256:JJOP/lwiBGOMilfONPWZCXUrfK154cnJFXcqlsi6lPo"
  const vmHost = "oc-ccd6b03545.exe.xyz"
  const scanned = `${vmHost} ssh-rsa AAAATESTKEY\n`
  const identity = { name: "oc-test", sshDest: vmHost, tags: [], comment: "test" }

  it("registers the exact VM hostname while preserving existing entries and mode", async () => {
    const root = await temporaryDirectory()
    const knownHostsFile = join(root, "state", "known_hosts")
    await mkdir(join(root, "state"))
    const existing = "other.example ssh-rsa AAAAOTHER\n"
    await writeFile(knownHostsFile, existing, { mode: 0o600 })
    const calls: string[][] = []
    const runner: ProcessRunner = {
      async run(input) {
        calls.push(input.argv)
        if (input.argv[0] === "/usr/bin/ssh-keyscan") return { exitCode: 0, signal: null, stdout: scanned, stderr: "" }
        if (input.argv[0] === "/usr/bin/ssh-keygen" && input.argv[1] === "-F") {
          const path = input.argv[input.argv.indexOf("-f") + 1]
          return path?.endsWith(".tmp")
            ? { exitCode: 0, signal: null, stdout: scanned, stderr: "" }
            : { exitCode: 1, signal: null, stdout: "", stderr: "" }
        }
        if (input.argv[0] === "/usr/bin/ssh-keygen" && input.argv[1] === "-lf") {
          return { exitCode: 0, signal: null, stdout: `256 ${official} ${vmHost} (RSA)\n`, stderr: "" }
        }
        throw new Error(`unexpected command: ${input.argv.join(" ")}`)
      },
    }

    await ensureExeDevVmHostKey(knownHostsFile, identity, runner)

    expect(await readFile(knownHostsFile, "utf8")).toBe(`${existing}${scanned}`)
    expect((await stat(knownHostsFile)).mode & 0o777).toBe(0o600)
    expect(calls).toContainEqual(["/usr/bin/ssh-keyscan", "-T", "5", "-t", "rsa", vmHost])
    expect(await readFile(knownHostsFile, "utf8")).not.toContain("*.exe.xyz")
  })

  it("does not scan an unknown destination outside exe.xyz", async () => {
    const root = await temporaryDirectory()
    const knownHostsFile = join(root, "known_hosts")
    await writeFile(knownHostsFile, "other.example ssh-rsa AAAAOTHER\n", { mode: 0o600 })
    const calls: string[][] = []
    const runner: ProcessRunner = {
      async run(input) {
        calls.push(input.argv)
        return { exitCode: 1, signal: null, stdout: "", stderr: "" }
      },
    }

    await expect(ensureExeDevVmHostKey(knownHostsFile, { ...identity, sshDest: "other.example" }, runner)).rejects.toMatchObject({
      code: "VM_HOST_KEY_UNKNOWN",
    })
    expect(calls.some((argv) => argv[0] === "/usr/bin/ssh-keyscan")).toBe(false)
  })

  it("rejects a wildcard scan entry even with the official fingerprint", async () => {
    const root = await temporaryDirectory()
    const knownHostsFile = join(root, "known_hosts")
    const existing = "other.example ssh-rsa AAAAOTHER\n"
    await writeFile(knownHostsFile, existing, { mode: 0o600 })
    const runner: ProcessRunner = {
      async run(input) {
        if (input.argv[0] === "/usr/bin/ssh-keyscan") return { exitCode: 0, signal: null, stdout: "*.exe.xyz ssh-rsa AAAATESTKEY\n", stderr: "" }
        if (input.argv[0] === "/usr/bin/ssh-keygen" && input.argv[1] === "-F") return { exitCode: 1, signal: null, stdout: "", stderr: "" }
        throw new Error(`unexpected command: ${input.argv.join(" ")}`)
      },
    }

    await expect(ensureExeDevVmHostKey(knownHostsFile, identity, runner)).rejects.toMatchObject({
      code: "VM_HOST_KEY_SCAN",
    })
    expect(await readFile(knownHostsFile, "utf8")).toBe(existing)
  })

  it("rejects a divergent fingerprint before writing the scan", async () => {
    const root = await temporaryDirectory()
    const knownHostsFile = join(root, "known_hosts")
    const existing = "other.example ssh-rsa AAAAOTHER\n"
    await writeFile(knownHostsFile, existing, { mode: 0o600 })
    const runner: ProcessRunner = {
      async run(input) {
        if (input.argv[0] === "/usr/bin/ssh-keyscan") return { exitCode: 0, signal: null, stdout: scanned, stderr: "" }
        if (input.argv[0] === "/usr/bin/ssh-keygen" && input.argv[1] === "-F") {
          const path = input.argv[input.argv.indexOf("-f") + 1]
          return path?.endsWith(".tmp")
            ? { exitCode: 0, signal: null, stdout: scanned, stderr: "" }
            : { exitCode: 1, signal: null, stdout: "", stderr: "" }
        }
        if (input.argv[0] === "/usr/bin/ssh-keygen" && input.argv[1] === "-lf") {
          return { exitCode: 0, signal: null, stdout: `256 ${official} ${vmHost} (RSA)\n256 SHA256:divergent ${vmHost} (RSA)\n`, stderr: "" }
        }
        throw new Error(`unexpected command: ${input.argv.join(" ")}`)
      },
    }

    await expect(ensureExeDevVmHostKey(knownHostsFile, identity, runner)).rejects.toMatchObject({
      code: "HOST_KEY_MISMATCH",
    })
    expect(await readFile(knownHostsFile, "utf8")).toBe(existing)
    expect((await stat(knownHostsFile)).mode & 0o777).toBe(0o600)
  })
})

describe("exe.dev control", () => {
  it("applies one bounded default timeout to every VM command", async () => {
    const vm = {
      name: "oc-0123456789",
      sshDest: "vm.exe.xyz",
      tags: ["opencode-sandbox"],
      comment: "opencode-test",
      status: "running",
    }
    const inputs: Array<{ timeoutMs?: number }> = []
    const control = new SshExeControl({
      lobby: "exe.dev",
      knownHostsFile: "/tmp/known_hosts",
      runner: {
        async run(input) {
          inputs.push({ timeoutMs: input.timeoutMs })
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify(input.argv.includes("ls") ? [vm] : vm),
            stderr: "",
          }
        },
      },
    })

    await control.create({ name: vm.name, cpu: 2, memory: "8GB", tags: vm.tags, comment: vm.comment })
    await control.copy({ baseVm: vm.name, name: vm.name, cpu: 2, memory: "8GB", tags: vm.tags, comment: vm.comment })
    await control.list()
    await control.remove({ ...vm, tags: [...vm.tags] })
    await control.tag(vm.name, vm.tags)
    await control.comment(vm.name, vm.comment)
    await control.replaceTags?.({ ...vm, tags: [...vm.tags] }, ["opencode-sandbox"])

    expect(inputs.length).toBeGreaterThan(0)
    expect(inputs.every((input) => input.timeoutMs === DEFAULT_EXEDEV_COMMAND_TIMEOUT_MS)).toBe(true)
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

  it("terminates a child when an unterminated line exceeds the output limit", async () => {
    const lines: string[] = []
    const handle = await nodeProcessSupervisor.start({
      argv: [globalThis.process.execPath, "-e", "process.stdout.write('x'.repeat(2049)); setInterval(() => {}, 1000)"],
      maxOutputBytes: 1024,
      onLine: (line) => lines.push(line),
    })
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => reject(new Error("process was not terminated")), 1_000)
    })

    try {
      await expect(Promise.race([
        handle.result,
        timeout,
      ])).rejects.toMatchObject({ code: "OUTPUT_LIMIT" })
      expect(lines).toEqual([])
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      handle.terminate()
    }
  })

  it("cleans spawn-error timers and abort listeners", async () => {
    const listeners = new Set<unknown>()
    const signal = {
      aborted: false,
      addEventListener(_type: string, listener: unknown) {
        listeners.add(listener)
      },
      removeEventListener(_type: string, listener: unknown) {
        listeners.delete(listener)
      },
    } as unknown as AbortSignal

    await expect(nodeProcessRunner.run({
      argv: ["/definitely/missing/opencode-sandbox-process"],
      timeoutMs: 1_000,
      signal,
    })).rejects.toMatchObject({ code: "PROCESS_START" })

    expect(listeners.size).toBe(0)
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

  it("maps malformed stored event JSON to a stable redacted history error", async () => {
    const databasePath = join(await temporaryDirectory(), "opencode.db")
    const database = new Database(databasePath)
    database.run("CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL)")
    database.run("INSERT INTO event VALUES (?, ?, ?, ?, ?)", ["evt_bad", "ses_bad", 0, "session.updated.1", '{"password":"private"'])
    database.close()

    let error: unknown
    try {
      readSessionEvents(databasePath, "ses_bad")
    } catch (value) {
      error = value
    }

    expect(error).toMatchObject({ code: "WORKSPACE_HISTORY", stage: "sync" })
    expect(String((error as Error).message)).not.toContain("private")
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

  it("aborts a never-resolving sync status request at its deadline", async () => {
    let aborted = false
    const gateway = new HttpWorkspaceGateway({
      serverUrl: "http://127.0.0.1:4096",
      directory: "/project",
      projectId: "prj_1",
      fetcher: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) {
          reject(new Error("missing abort signal"))
          return
        }
        signal.addEventListener("abort", () => {
          aborted = true
          reject(new Error("request aborted"))
        }, { once: true })
      }),
    })

    await expect(gateway.waitForSync({ workspaceId: "wrk_1", directory: "/project", timeoutMs: 20 })).rejects.toMatchObject({
      code: "WORKSPACE_SYNC_TIMEOUT",
    })
    expect(aborted).toBe(true)
  })

  it("bounds a fetch that ignores the abort signal", async () => {
    let aborted = false
    const gateway = new HttpWorkspaceGateway({
      serverUrl: "http://127.0.0.1:4096",
      directory: "/project",
      projectId: "prj_1",
      requestTimeoutMs: 20,
      fetcher: async (_input, init) => {
        init?.signal?.addEventListener("abort", () => { aborted = true }, { once: true })
        return new Promise<Response>(() => {})
      },
    })

    await expect(gateway.create({
      type: "sbx",
      projectId: "prj_1",
      directory: "/project",
      id: "wrk_1",
      branch: "opencode/test",
      extra: {},
    })).rejects.toMatchObject({ code: "WORKSPACE_HTTP_TIMEOUT" })
    expect(aborted).toBe(true)
  })

  it("cancels an already-aborted response body without starting a reader", async () => {
    let cancelStarted!: () => void
    let releaseCancel!: () => void
    let readStarted = false
    const cancelCalled = new Promise<void>((resolve) => { cancelStarted = resolve })
    const cancelFinished = new Promise<void>((resolve) => { releaseCancel = resolve })
    const body = new ReadableStream<Uint8Array>({
      pull() {
        readStarted = true
      },
      cancel() {
        cancelStarted()
        return cancelFinished
      },
    })
    const controller = new AbortController()
    controller.abort()
    const pending = readLimitedBody(new Response(body), controller.signal, "control_channel")

    await cancelCalled
    let settled = false
    const observed = pending.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(readStarted).toBe(false)
    releaseCancel()
    await expect(pending).rejects.toBeDefined()
    await observed
  })

  it("rejects replay history beyond its explicit event cap", async () => {
    let requests = 0
    const gateway = new HttpWorkspaceGateway({
      serverUrl: "http://127.0.0.1:4096",
      directory: "/project",
      projectId: "prj_1",
      sessionEvents: () => Array.from({ length: MAX_REPLAY_EVENTS + 1 }, (_, seq) => ({
        id: `evt_${seq}`,
        aggregateID: "ses_1",
        seq,
        type: "session.updated.1",
        data: {},
      })),
      fetcher: async () => {
        requests++
        return new Response(null, { status: 204 })
      },
    })

    await expect(gateway.replaySession({ sessionId: "ses_1", directory: "/project", target: { type: "remote", url: "https://sandbox.example.test" } })).rejects.toMatchObject({
      code: "WORKSPACE_REPLAY_LIMIT",
    })
    expect(requests).toBe(0)
  })

  it("rejects an oversized replay event before sending it", async () => {
    let requests = 0
    const gateway = new HttpWorkspaceGateway({
      serverUrl: "http://127.0.0.1:4096",
      directory: "/project",
      projectId: "prj_1",
      sessionEvents: () => [{
        id: "evt_large",
        aggregateID: "ses_1",
        seq: 0,
        type: "session.updated.1",
        data: { payload: "x".repeat(MAX_REPLAY_REQUEST_BYTES) },
      }],
      fetcher: async () => {
        requests++
        return new Response(null, { status: 204 })
      },
    })

    await expect(gateway.replaySession({ sessionId: "ses_1", directory: "/project", target: { type: "remote", url: "https://sandbox.example.test" } })).rejects.toMatchObject({
      code: "WORKSPACE_REPLAY_LIMIT",
    })
    expect(requests).toBe(0)
  })

  it("rejects replay history beyond its aggregate byte cap", async () => {
    let requests = 0
    const payload = "x".repeat(40_000)
    const events = Array.from({ length: Math.ceil(MAX_REPLAY_HISTORY_BYTES / 40_000) + 1 }, (_, seq) => ({
      id: `evt_${seq}`,
      aggregateID: "ses_1",
      seq,
      type: "session.updated.1",
      data: { payload },
    }))
    const gateway = new HttpWorkspaceGateway({
      serverUrl: "http://127.0.0.1:4096",
      directory: "/project",
      projectId: "prj_1",
      sessionEvents: () => events,
      fetcher: async () => {
        requests++
        return new Response(null, { status: 204 })
      },
    })

    await expect(gateway.replaySession({ sessionId: "ses_1", directory: "/project", target: { type: "remote", url: "https://sandbox.example.test" } })).rejects.toMatchObject({
      code: "WORKSPACE_REPLAY_LIMIT",
    })
    expect(requests).toBe(0)
  })

  it("aborts a never-resolving replay request at its target timeout", async () => {
    let aborted = false
    const gateway = new HttpWorkspaceGateway({
      serverUrl: "http://127.0.0.1:4096",
      directory: "/project",
      projectId: "prj_1",
      replayTimeoutMs: 20,
      sessionEvents: () => [{ id: "evt_1", aggregateID: "ses_1", seq: 0, type: "session.created.1", data: {} }],
      fetcher: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) {
          reject(new Error("missing abort signal"))
          return
        }
        signal.addEventListener("abort", () => {
          aborted = true
          reject(new Error("request aborted"))
        }, { once: true })
      }),
    })

    await expect(gateway.replaySession({ sessionId: "ses_1", directory: "/project", target: { type: "remote", url: "https://sandbox.example.test" } })).rejects.toMatchObject({
      code: "WORKSPACE_REPLAY_TIMEOUT",
    })
    expect(aborted).toBe(true)
  })

  it("inspects a workspace through the filtered list route and validates the list response", async () => {
    const requests: Array<{ method: string; url: URL }> = []
    const gateway = new HttpWorkspaceGateway({
      serverUrl: "http://127.0.0.1:4096",
      directory: "/project",
      projectId: "prj_1",
      fetcher: async (input, init) => {
        const url = new URL(String(input))
        requests.push({ method: init?.method ?? "GET", url })
        return Response.json([{
          id: "wrk_1",
          type: "sbx",
          name: "sandbox",
          branch: "opencode/test",
          directory: "/project",
          extra: null,
          projectID: "prj_1",
          timeUsed: 0,
        }])
      },
    })

    await expect(gateway.inspect({ workspaceId: "wrk_1", directory: "/project" })).resolves.toMatchObject({ id: "wrk_1", projectID: "prj_1" })
    expect(requests[0]).toMatchObject({ method: "GET" })
    expect(requests[0]?.url.pathname).toBe("/experimental/workspace")
    expect(requests[0]?.url.searchParams.get("workspace")).toBe("wrk_1")

    const invalidGateway = new HttpWorkspaceGateway({
      serverUrl: "http://127.0.0.1:4096",
      directory: "/project",
      projectId: "prj_1",
      fetcher: async () => Response.json({ id: "wrk_1" }),
    })
    await expect(invalidGateway.inspect({ workspaceId: "wrk_1", directory: "/project" })).rejects.toMatchObject({ code: "WORKSPACE_SCHEMA" })
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

  it("limits inventory to a host project capability", () => {
    const project = createCapability({ sessionId: "project_prj_1", generation: 1, role: "host", scope: "project", projectId: "prj_1" })
    expect(parseControlRequest({ operation: "inventory" }, project)).toEqual({ operation: "inventory", force: false })
    expect(() => parseControlRequest({ operation: "status" }, project)).toThrow()
    expect(() => parseControlRequest({ operation: "inventory" }, createCapability({ sessionId: "ses_1", generation: 1, role: "host" }))).toThrow()
    expect(() => parseControlRequest({ operation: "inventory" }, createCapability({ sessionId: "ses_1", generation: 1, role: "remote" }))).toThrow()
    expect(() => parseControlRequest({ operation: "repair" }, project)).toThrow(/project/i)
    expect(() => parseControlRequest({ operation: "repair" }, createCapability({ sessionId: "ses_1", generation: 1, role: "remote" }))).toThrow(/host/i)
    expect(() => parseControlRequest({ operation: "recover" }, createCapability({ sessionId: "ses_1", generation: 1, role: "remote" }))).toThrow(/host/i)
  })

  it("returns bounded V2 envelopes with stable transport and handler codes", async () => {
    const root = await temporaryDirectory()
    const channel = new ControlChannel({
      socketPath: join(root, "control.sock"),
      handler: async (request) => {
        if (request.operation === "diagnose") throw new SandboxError("diagnose", "handler failed", "HANDLER_FAILURE")
        if (request.operation === "logs") return { ok: true, operation: request.operation, state: "local", message: "large", details: { output: "x".repeat(70 * 1024) } }
        return { ok: true, operation: request.operation, state: "local", message: "handled" }
      },
    })
    const capability = createCapability({ sessionId: "ses_1", generation: 1, role: "host" })
    channel.register(capability)
    await channel.start()

    try {
      const unauthorized = await requestControl(channel.socketPath, "wrong", { operation: "status" })
      expect(unauthorized.body).toMatchObject({ schemaVersion: 2, error: { code: "CONTROL_AUTH" } })

      const invalid = await requestControl(channel.socketPath, capability.token, { operation: "status", extra: true })
      expect(invalid.body).toMatchObject({ schemaVersion: 2, error: { code: "REQUEST_FIELDS" } })

      const failed = await requestControl(channel.socketPath, capability.token, { operation: "diagnose" })
      expect(failed.body).toMatchObject({ schemaVersion: 2, error: { code: "HANDLER_FAILURE" } })

      const oversized = await requestControl(channel.socketPath, capability.token, { operation: "logs" })
      expect(oversized.body).toMatchObject({ schemaVersion: 2, error: { code: "RESPONSE_LIMIT" } })
      expect(Buffer.byteLength(JSON.stringify(oversized.body))).toBeLessThan(64 * 1024)
    } finally {
      await channel.close()
    }
  })
})

describe("lifecycle controller", () => {
  it("reports structured classifications and selects only allowed actions", async () => {
    const cases = [
      { state: "local", provider: { resource: "absent", ownership: "unknown", health: "unknown" }, workspace: false, classification: "clean", action: "start" },
      { state: "local", provider: { resource: "present", ownership: "unknown", health: "unknown" }, workspace: false, classification: "unknown", action: "inspect" },
      { state: "remote", provider: { resource: "unknown", ownership: "unknown", health: "unknown" }, workspace: false, classification: "control_lost", action: "inspect" },
      { state: "remote", provider: { resource: "absent", ownership: "unknown", health: "unknown" }, workspace: false, classification: "stale_record", action: "repair" },
      { state: "remote", provider: { resource: "present", ownership: "verified", health: "healthy" }, workspace: false, classification: "orphan", action: "inspect" },
      { state: "detached", provider: { resource: "present", ownership: "verified", health: "healthy" }, workspace: false, preservedWorktreePath: "/tmp/preserved", classification: "leaked_resource", action: "delete" },
      { state: "detached", provider: { resource: "present", ownership: "verified", health: "healthy" }, workspace: false, classification: "leaked_resource", action: "inspect" },
      { state: "recovery_pending", provider: { resource: "absent", ownership: "unknown", health: "unknown" }, workspace: false, classification: "stale_record", action: "repair", retryable: true },
      { state: "remote", provider: { resource: "present", ownership: "conflict", health: "unknown" }, workspace: false, classification: "conflict", action: "inspect" },
      { state: "sync_failed", provider: { resource: "unknown", ownership: "unknown", health: "unknown" }, workspace: false, classification: "work_at_risk", action: "retry" },
    ] as const

    for (const scenario of cases) {
      const root = await temporaryDirectory()
      const store = new FileStateStore(root)
      const preservedWorktreePath = "preservedWorktreePath" in scenario ? scenario.preservedWorktreePath : undefined
      const record = {
        ...makeRecord(),
        state: scenario.state,
        ...(scenario.action === "retry" || "retryable" in scenario ? { operation: { kind: "start" as const, phase: "provisioning" as const } } : {}),
        ...(preservedWorktreePath ? { preservedWorktreePath } : {}),
      }
      await store.write(record)
      let providerCalls = 0
      const controller = new LifecycleController({
        store,
        capture: async () => ({ baseSha: record.baseSha, patch: "", untracked: [] }),
        providerInspect: async () => {
          providerCalls++
          return { resourceId: "resource-1", ...scenario.provider, evidence: ["fixture"] }
        },
        providerTarget: async () => undefined,
        gitInspect: async () => ({ head: record.baseSha, branch: record.branch, dirty: false, evidence: ["fixture"] }),
        workspace: {
          async create() { throw new Error("must not create") },
          async warp() {},
          async remove() {},
          async inspect() {
            return scenario.workspace
              ? { id: record.workspaceId, type: record.provider, name: "workspace", branch: record.branch, directory: record.directory, extra: null, projectID: record.projectId }
              : undefined
          },
        },
      })
      const capability = createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" })
      controller.registerContext({ sessionId: record.sessionId, projectId: record.projectId, directory: record.directory, worktree: record.directory })

      const status = await controller.handle({ operation: "status", force: false, capability })
      expect(providerCalls).toBe(0)
      expect(status.observations?.find((observation) => observation.source === "provider")?.observed).toBe(false)

      const result = await controller.handle({ operation: "inspect", force: false, capability })
      expect(result.schemaVersion).toBe(2)
      expect(result.classification).toBe(scenario.classification)
      const action = result.recommendedAction
      expect(action?.operation).toBe(scenario.action)
      expect(result.allowedActions?.some((allowed) => allowed.operation === action?.operation && allowed.role === "host")).toBe(true)
      if ("retryable" in scenario) expect(result.allowedActions?.some((allowed) => allowed.operation === "retry")).toBe(true)
      if (scenario.classification !== "leaked_resource") {
        expect(result.allowedActions?.some((allowed) => allowed.operation === "delete")).toBe(false)
      }
      expect(providerCalls).toBe(1)
    }
  })

  it("repairs a stale record after fresh provider, handle, and workspace absence", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = {
      ...makeRecord(),
      state: "remote" as const,
      operation: { kind: "stop" as const, phase: "remote" },
      lastError: { stage: "reconcile", message: "stale" },
    }
    await store.write(record)
    let removed = 0
    let providerMutations = 0
    const controller = new LifecycleController({
      store,
      providerInspect: async () => ({ resourceId: "resource-1", resource: "absent", ownership: "unknown", health: "unknown", evidence: ["fixture"] }),
      providerTarget: async () => { throw new SandboxError("tunnel", "runtime is not active", "RUNTIME_UNAVAILABLE") },
      providerRelease: async () => { providerMutations++ },
      providerDestroy: async () => { providerMutations++ },
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() { throw new Error("must not warp") },
        async remove() { removed++ },
        async inspect() { return undefined },
      },
    })
    const capability = createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" })

    const inspection = await controller.handle({ operation: "inspect", force: false, capability })
    expect(inspection).toMatchObject({
      classification: "stale_record",
      recommendedAction: { operation: "repair", reasonCode: "STALE_CONTROL_PLANE" },
    })
    expect(inspection.allowedActions).toContainEqual(expect.objectContaining({ operation: "repair", role: "host" }))

    const repaired = await controller.handle({ operation: "repair", force: false, capability })

    expect(repaired).toMatchObject({ schemaVersion: 2, ok: true, operation: "repair", state: "detached", classification: "clean" })
    expect(repaired.observations?.find((observation) => observation.source === "provider")).toMatchObject({ observed: true, resource: "absent" })
    expect(repaired.observations?.find((observation) => observation.source === "handle")).toMatchObject({ observed: true, resource: "absent" })
    expect(repaired.observations?.find((observation) => observation.source === "workspace")).toMatchObject({ observed: true, resource: "absent" })
    expect(removed).toBe(0)
    expect(providerMutations).toBe(0)
    expect(await store.get(record.sessionId)).toMatchObject({ state: "detached", providerState: {} })
    expect((await store.get(record.sessionId))?.operation).toMatchObject({ kind: "stop", phase: "detached" })
    expect((await store.get(record.sessionId))?.lastError).toBeUndefined()
  })

  it("removes only an exactly owned stale workspace during repair", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = { ...makeRecord(), state: "remote" as const }
    await store.write(record)
    let inspections = 0
    let removedInput: { workspaceId: string; directory: string } | undefined
    const controller = new LifecycleController({
      store,
      providerInspect: async () => ({ resourceId: "resource-1", resource: "absent", ownership: "unknown", health: "unknown", evidence: ["fixture"] }),
      providerTarget: async () => undefined,
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() {},
        async remove(input) { removedInput = input },
        async inspect() {
          inspections++
          return matchingWorkspace(record)
        },
      },
    })

    const result = await controller.handle({
      operation: "repair",
      force: false,
      capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" }),
    })

    expect(result).toMatchObject({ ok: true, state: "detached", classification: "clean" })
    expect(inspections).toBe(2)
    expect(removedInput).toEqual({ workspaceId: record.workspaceId, directory: record.directory })
  })

  it("does not repair mismatched, unknown, or conflicting observations", async () => {
    const cases: Array<{
      provider?: ProviderResourceObservation
      providerError?: SandboxError
      workspace: (record: SandboxRecord) => ReturnType<typeof matchingWorkspace> | undefined
    }> = [
      {
        provider: { resourceId: "resource-1", resource: "absent", ownership: "unknown", health: "unknown", evidence: ["fixture"] },
        workspace: (record: SandboxRecord) => matchingWorkspace(record, { directory: "/foreign/project" }),
      },
      {
        provider: undefined,
        providerError: new SandboxError("inspect", "provider unavailable", "PROVIDER_UNAVAILABLE"),
        workspace: () => undefined,
      },
      {
        provider: { resourceId: "resource-1", resource: "present", ownership: "conflict", health: "unknown", evidence: ["fixture"] },
        workspace: () => undefined,
      },
    ]

    for (const testCase of cases) {
      const store = new FileStateStore(await temporaryDirectory())
      const record = { ...makeRecord(), state: "remote" as const }
      await store.write(record)
      let removed = 0
      const controller = new LifecycleController({
        store,
        providerInspect: async () => {
          if (testCase.providerError) throw testCase.providerError
          return testCase.provider!
        },
        providerTarget: async () => undefined,
        workspace: {
          async create() { throw new Error("must not create") },
          async warp() {},
          async remove() { removed++ },
          async inspect() { return testCase.workspace(record) },
        },
      })
      const before = JSON.stringify(await store.get(record.sessionId))

      const result = await controller.handle({
        operation: "repair",
        force: false,
        capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" }),
      })

      expect(result.ok).toBe(false)
      expect(result.error?.code).toMatch(/^REPAIR_(?:EVIDENCE|CONFLICT)$/)
      expect(removed).toBe(0)
      const after = await store.get(record.sessionId)
      expect(JSON.stringify(after && { ...after, journal: undefined })).toBe(before)
    }
  })

  it("denies repair to a remote lifecycle capability", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = { ...makeRecord(), state: "remote" as const }
    await store.write(record)
    let inspected = false
    const controller = new LifecycleController({
      store,
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() {},
        async remove() {},
        async inspect() { inspected = true; return undefined },
      },
    })

    const result = await controller.handle({
      operation: "repair",
      force: false,
      capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "remote" }),
    })

    expect(result).toMatchObject({ ok: false, error: { code: "REQUEST_REPAIR", stage: "validate" } })
    expect(inspected).toBe(false)
  })

  it("rejects a reconciliation plan when the record changes before the lock", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = {
      ...makeRecord(),
      state: "remote" as const,
      operation: { kind: "stop" as const, phase: "remote" },
    }
    await store.write(record)
    let releaseProvider!: () => void
    let providerStarted!: () => void
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve })
    const started = new Promise<void>((resolve) => { providerStarted = resolve })
    let syncOutCalls = 0
    const controller = new LifecycleController({
      store,
      providerInspect: async () => {
        providerStarted()
        await providerGate
        return { resourceId: "resource-1", resource: "present", ownership: "verified", health: "healthy", evidence: ["fixture"] }
      },
      providerTarget: async () => ({ type: "remote", url: "https://remote.example.test" }),
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() {},
        async remove() {},
        async syncOut(input) {
          syncOutCalls++
          return { kind: "control-plane", baseSha: input.baseSha }
        },
        async inspect() { return undefined },
      },
    })

    const reconciliation = controller.reconcile(record.projectId)
    await providerStarted
    const changed = { ...record, updatedAt: new Date(2000).toISOString() }
    await store.write(changed)
    releaseProvider()
    await reconciliation

    expect(syncOutCalls).toBe(0)
    expect(await store.get(record.sessionId)).toMatchObject({ state: "remote", updatedAt: changed.updatedAt, operation: record.operation })
  })

  it("classifies a live direct provider only when its target is observed", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = { ...makeRecord(), state: "remote" as const }
    await store.write(record)
    const controller = new LifecycleController({
      store,
      providerInspect: async () => ({ resourceId: "resource-1", resource: "present", ownership: "verified", health: "healthy", evidence: ["fixture"] }),
      providerTarget: async () => ({ type: "remote", url: "https://remote.example.test" }),
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() { throw new Error("must not warp") },
        async remove() { throw new Error("must not remove") },
      },
    })

    const result = await controller.handle({
      operation: "inspect",
      force: false,
      capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" }),
    })

    expect(result).toMatchObject({
      classification: "attached",
      effectiveTarget: { kind: "remote", resourceId: "resource-1" },
    })
    expect(result.observations?.find((observation) => observation.source === "handle")).toMatchObject({
      resource: "present",
      evidence: ["direct provider runtime target"],
    })
  })

  it("does not classify a detached resource as leaked when target inspection fails", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = { ...makeRecord(), state: "detached" as const, preservedWorktreePath: "/tmp/preserved" }
    await store.write(record)
    const controller = new LifecycleController({
      store,
      providerInspect: async () => ({
        resourceId: "resource-1",
        resource: "present",
        ownership: "verified",
        health: "healthy",
        evidence: ["fixture"],
      }),
      providerTarget: async () => {
        throw new SandboxError("tunnel", "runtime target is unavailable", "TARGET_UNAVAILABLE")
      },
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() { throw new Error("must not warp") },
        async remove() { throw new Error("must not remove") },
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
      classification: "unknown",
      recommendedAction: { operation: "inspect" },
      error: { code: "TARGET_UNAVAILABLE" },
    })
    expect(result.observations?.find((observation) => observation.source === "handle")).toMatchObject({
      observed: true,
      resource: "unknown",
      evidence: ["runtime target inspection failed:TARGET_UNAVAILABLE"],
    })
    expect(result.allowedActions?.some((action) => action.operation === "delete")).toBe(false)
  })

  it("does not infer an absent runtime handle when target inspection is unavailable", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = { ...makeRecord(), state: "detached" as const, preservedWorktreePath: "/tmp/preserved" }
    await store.write(record)
    const controller = new LifecycleController({
      store,
      providerInspect: async () => ({ resourceId: "resource-1", resource: "present", ownership: "verified", health: "healthy", evidence: ["fixture"] }),
      gitInspect: async () => ({ head: record.baseSha, branch: record.branch, dirty: false, evidence: ["fixture"] }),
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

    expect(result.classification).toBe("unknown")
    expect(result.observations?.find((observation) => observation.source === "handle")).toMatchObject({
      observed: false,
      evidence: ["runtime target inspection is unavailable"],
    })
    expect(result.allowedActions?.some((action) => action.operation === "delete")).toBe(false)
  })

  it("blocks clean and start when local or deleted state lacks observed workspace absence", async () => {
    for (const state of ["local", "deleted"] as const) {
      for (const workspaceState of ["present", "unavailable"] as const) {
        const store = new FileStateStore(await temporaryDirectory())
        const record = { ...makeRecord(), state }
        await store.write(record)
        const controller = new LifecycleController({
          store,
          providerInspect: async () => ({
            resourceId: "resource-1",
            resource: "absent",
            ownership: "unknown",
            health: "unknown",
            evidence: ["fixture"],
          }),
          workspace: {
            async create() { throw new Error("must not create") },
            async warp() { throw new Error("must not warp") },
            async remove() { throw new Error("must not remove") },
            ...(workspaceState === "present" ? {
              async inspect() {
                return {
                  id: record.workspaceId,
                  type: record.provider,
                  name: "workspace",
                  branch: record.branch,
                  directory: record.directory,
                  extra: null,
                  projectID: record.projectId,
                }
              },
            } : {}),
          },
        })

        const result = await controller.handle({
          operation: "inspect",
          force: false,
          capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" }),
        })

        expect(result.classification).toBe("unknown")
        expect(result.recommendedAction).toMatchObject({ operation: "inspect" })
        expect(result.allowedActions?.some((action) => action.operation === "start")).toBe(false)
      }
    }
  })

  it("keeps record-only local and deleted status unknown without provider calls", async () => {
    for (const state of ["local", "deleted"] as const) {
      const store = new FileStateStore(await temporaryDirectory())
      const record = { ...makeRecord(), state }
      await store.write(record)
      let providerCalls = 0
      const controller = new LifecycleController({
        store,
        providerInspect: async () => {
          providerCalls++
          throw new Error("status must not inspect")
        },
        workspace: {
          async create() { throw new Error("status must not create") },
          async warp() { throw new Error("status must not warp") },
          async remove() { throw new Error("status must not remove") },
          async inspect() { throw new Error("status must not inspect") },
        },
      })

      const result = await controller.handle({
        operation: "status",
        force: false,
        capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" }),
      })

      expect(providerCalls).toBe(0)
      expect(result.classification).toBe("unknown")
      expect(result.recommendedAction).toMatchObject({ operation: "inspect" })
      expect(result.allowedActions?.some((action) => action.operation === "start" || action.operation === "delete")).toBe(false)
      for (const source of ["workspace", "provider", "handle", "git"] as const) {
        expect(result.observations?.find((observation) => observation.source === source)?.observed).toBe(false)
      }
    }
  })

  it("does not advertise retry when a failed record has no operation", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = { ...makeRecord(), state: "error" as const }
    await store.write(record)
    const controller = new LifecycleController({
      store,
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() {},
        async remove() {},
        async inspect() { return undefined },
      },
    })
    const capability = createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" })

    const inspection = await controller.handle({ operation: "inspect", force: false, capability })
    expect(inspection.allowedActions?.some((action) => action.operation === "retry")).toBe(false)
    expect(inspection.recommendedAction).toMatchObject({ operation: "inspect" })

    await expect(controller.handle({ operation: "retry", force: false, capability })).resolves.toMatchObject({
      ok: false,
      error: { code: "RETRY_UNAVAILABLE" },
    })
  })

  it("does not advertise start when capture is unavailable", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = { ...makeRecord(), state: "local" as const }
    await store.write(record)
    const controller = new LifecycleController({
      store,
      providerTarget: async () => undefined,
      providerInspect: async () => ({ resourceId: "resource-1", resource: "absent", ownership: "unknown", health: "unknown", evidence: ["fixture"] }),
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() {},
        async remove() {},
        async inspect() { return undefined },
      },
    })
    controller.registerContext({ sessionId: record.sessionId, projectId: record.projectId, directory: record.directory, worktree: record.directory })
    const capability = createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" })

    const result = await controller.handle({ operation: "inspect", force: false, capability })

    expect(result.classification).toBe("clean")
    expect(result.allowedActions?.some((action) => action.operation === "start")).toBe(false)
    expect(result.recommendedAction).toBeNull()
  })

  it("does not advertise start without session context", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = { ...makeRecord(), state: "local" as const }
    await store.write(record)
    const controller = new LifecycleController({
      store,
      capture: async () => ({ baseSha: record.baseSha, patch: "", untracked: [] }),
      providerTarget: async () => undefined,
      providerInspect: async () => ({ resourceId: "resource-1", resource: "absent", ownership: "unknown", health: "unknown", evidence: ["fixture"] }),
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

    expect(result.classification).toBe("clean")
    expect(result.allowedActions?.some((action) => action.operation === "start")).toBe(false)
    expect(result.recommendedAction).toBeNull()
  })

  it("reports a local effective target only from an observed workspace route", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = { ...makeRecord(), state: "local" as const }
    await store.write(record)
    const controller = new LifecycleController({
      store,
      providerInspect: async () => ({ resourceId: "resource-1", resource: "absent", ownership: "unknown", health: "unknown", evidence: ["fixture"] }),
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() {},
        async remove() {},
        async inspect() {
          return {
            id: record.workspaceId,
            type: record.provider,
            name: "workspace",
            branch: record.branch,
            directory: record.directory,
            extra: null,
            projectID: record.projectId,
          }
        },
      },
    })
    const capability = createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" })

    const result = await controller.handle({ operation: "inspect", force: false, capability })

    expect(result.effectiveTarget).toEqual({ kind: "local", directory: record.directory })
  })

  it("recovers a verified orphan through the runtime driver and stops it without creating", async () => {
    const fixture = await setupRecoveryFixture()
    const inspection = await fixture.controller.handle({ operation: "inspect", force: false, capability: fixture.capability })

    expect(inspection).toMatchObject({
      classification: "orphan",
      recommendedAction: { operation: "recover", reasonCode: "VERIFIED_ORPHAN" },
    })
    expect(inspection.allowedActions).toContainEqual(expect.objectContaining({ operation: "recover", role: "host" }))

    const recovered = await fixture.controller.handle({ operation: "recover", force: false, capability: fixture.capability })

    expect(recovered).toMatchObject({
      ok: true,
      operation: "recover",
      state: "remote",
      classification: "attached",
      effectiveTarget: { kind: "remote", resourceId: "resource-1" },
    })
    expect(fixture.calls).toEqual([
      "inspect:resource-1",
      "inspect:resource-1",
      "adopt",
      "warp:remote",
      "sync:start",
      "sync:connected",
      "replay",
    ])
    expect(fixture.calls).not.toContain("worktree:create")
    expect(fixture.calls).not.toContain("sandbox:create")
    expect(JSON.stringify(await fixture.store.get(fixture.record.sessionId))).not.toContain("https://")

    await expect(fixture.controller.handle({ operation: "stop", force: false, capability: fixture.capability })).resolves.toMatchObject({ state: "stop_pending" })
    await fixture.controller.onSessionIdle(fixture.record.sessionId)

    expect(await fixture.store.get(fixture.record.sessionId)).toMatchObject({ state: "detached" })
    expect(fixture.calls.slice(-4)).toEqual(["sync", "warp:local", "close", "workspace:remove"])
    expect(fixture.calls).not.toContain("destroy")

    await expect(fixture.controller.handle({ operation: "delete", force: true, capability: fixture.capability })).resolves.toMatchObject({ state: "deleted" })
    expect(fixture.calls.slice(-3)).toEqual(["workspace:remove", "inspect:resource-1", "destroy"])
  })

  it("blocks an attached stop without known runtime health", async () => {
    const fixture = await setupRecoveryFixture({
      observations: [
        { resource: "present", ownership: "verified", health: "healthy" },
        { resource: "present", ownership: "verified", health: "unknown" },
      ],
    })

    await expect(fixture.controller.handle({ operation: "recover", force: false, capability: fixture.capability })).resolves.toMatchObject({ state: "remote" })
    await expect(fixture.controller.handle({ operation: "stop", force: false, capability: fixture.capability })).resolves.toMatchObject({
      ok: false,
      error: { code: "STOP_EVIDENCE" },
    })
    expect(await fixture.store.get(fixture.record.sessionId)).toMatchObject({ state: "remote" })
    expect(fixture.calls).toEqual(["inspect:resource-1", "adopt", "warp:remote", "sync:start", "sync:connected", "replay", "inspect:resource-1"])
  })

  it("denies recover to a remote capability with a stable V2 error", async () => {
    const fixture = await setupRecoveryFixture()

    const result = await fixture.controller.handle({
      operation: "recover",
      force: false,
      capability: createCapability({ sessionId: fixture.record.sessionId, generation: fixture.record.generation, role: "remote" }),
    })

    expect(result).toMatchObject({ ok: false, operation: "recover", error: { code: "REQUEST_RECOVER", stage: "validate", retryable: false } })
    expect(fixture.calls).toEqual([])
  })

  it("does not adopt an unknown or conflicting resource", async () => {
    for (const observation of [
      { resource: "unknown", ownership: "unknown" },
      { resource: "present", ownership: "conflict" },
    ] as const) {
      const fixture = await setupRecoveryFixture({ observation: { ...observation, health: "unknown" } })

      const result = await fixture.controller.handle({ operation: "recover", force: false, capability: fixture.capability })

      expect(result.ok).toBe(false)
      expect(result.error?.code).toMatch(/^RECOVER_(?:EVIDENCE|CONFLICT)$/)
      expect(fixture.calls).toEqual(["inspect:resource-1"])
      expect(await fixture.store.get(fixture.record.sessionId)).toMatchObject({ state: "orphaned" })
      expect(fixture.calls).not.toContain("adopt")
    }
  })

  it("blocks recovery and orphan deletion without fresh workspace ownership evidence", async () => {
    for (const scenario of [
      { workspaceObservation: "foreign" as const, recoverCode: "RECOVER_CONFLICT", deleteCode: "DELETE_CONFLICT" },
      { workspaceObservation: "unavailable" as const, recoverCode: "RECOVER_EVIDENCE", deleteCode: "DELETE_EVIDENCE" },
    ]) {
      const recovery = await setupRecoveryFixture(scenario)
      const recovered = await recovery.controller.handle({ operation: "recover", force: false, capability: recovery.capability })

      expect(recovered).toMatchObject({ ok: false, error: { code: scenario.recoverCode } })
      expect(recovered.allowedActions?.some((action) => action.operation === "recover")).toBe(false)
      expect(recovered.recommendedAction?.operation).not.toBe("recover")
      expect(recovery.calls).not.toContain("adopt")
      expect(recovery.calls).not.toContain("workspace:remove")
      expect(recovery.calls).not.toContain("destroy")

      const deletion = await setupRecoveryFixture(scenario)
      const deleted = await deletion.controller.handle({ operation: "delete", force: false, capability: deletion.capability })

      expect(deleted).toMatchObject({ ok: false, state: "orphaned", error: { code: scenario.deleteCode } })
      expect(deletion.calls).not.toContain("adopt")
      expect(deletion.calls).not.toContain("workspace:remove")
      expect(deletion.calls).not.toContain("destroy")
    }
  })

  it("stops a runtime whose workspace reports its remote checkout directory", async () => {
    const fixture = await setupRecoveryFixture({
      provider: "exedev",
      state: "remote",
      workspaceDirectory: remoteWorkspaceDirectory("wrk_1"),
    })
    const pending = {
      ...fixture.record,
      state: "stop_pending" as const,
      desiredLocation: "local" as const,
      phase: "detaching" as const,
      operation: { kind: "stop" as const, phase: "adopting" },
    }
    await fixture.store.write(pending)

    await fixture.controller.onSessionIdle(pending.sessionId)

    expect(await fixture.store.get(pending.sessionId)).toMatchObject({
      state: "detached",
      operation: { kind: "stop", phase: "detached" },
    })
    expect(fixture.calls).toEqual(["inspect:resource-1", "adopt", "sync", "warp:local", "close", "workspace:remove"])
  })

  it("stops an SBX runtime when the registry and host directories differ", async () => {
    const remoteWorktreePath = "/workspace/project/.opencode-worktree"
    const fixture = await setupRecoveryFixture({
      provider: "sbx",
      state: "remote",
      providerState: { remoteWorktreePath },
      workspaceDirectory: remoteWorktreePath,
    })
    const pending = {
      ...fixture.record,
      state: "stop_pending" as const,
      desiredLocation: "local" as const,
      phase: "detaching" as const,
      operation: { kind: "stop" as const, phase: "adopting" },
    }
    await fixture.store.write(pending)

    await fixture.controller.onSessionIdle(pending.sessionId)

    expect(pending.directory).not.toBe(remoteWorktreePath)
    expect(await fixture.store.get(pending.sessionId)).toMatchObject({
      state: "detached",
      operation: { kind: "stop", phase: "detached" },
    })
    expect(fixture.workspaceRemovals).toEqual([{ workspaceId: pending.workspaceId, directory: pending.directory }])
    expect(fixture.calls).toEqual(["inspect:resource-1", "adopt", "sync", "warp:local", "close", "workspace:remove"])
  })

  it("rejects SBX workspace matches without a valid remote worktree path", async () => {
    for (const providerState of [{}, { remoteWorktreePath: "/workspace/../project" }]) {
      const fixture = await setupRecoveryFixture({
        provider: "sbx",
        state: "remote",
        providerState,
        workspaceDirectory: "/tmp/project",
      })
      const pending = {
        ...fixture.record,
        state: "stop_pending" as const,
        desiredLocation: "local" as const,
        phase: "detaching" as const,
        operation: { kind: "stop" as const, phase: "adopting" },
      }
      await fixture.store.write(pending)

      await fixture.controller.onSessionIdle(pending.sessionId)

      expect(await fixture.store.get(pending.sessionId)).toMatchObject({
        state: "error",
        lastError: { code: "STOP_CONFLICT" },
      })
      expect(fixture.calls).toEqual(["inspect:resource-1"])
      expect(fixture.workspaceRemovals).toEqual([])
    }
  })

  it("rejects stop when the workspace ownership tuple diverges", async () => {
    const fixture = await setupRecoveryFixture({
      provider: "exedev",
      state: "remote",
      workspaceDirectory: remoteWorkspaceDirectory("wrk_1"),
      workspaceExtra: {
        owner: "opencode-sandbox",
        sessionId: "ses_other",
        generation: 1,
        workspaceId: "wrk_1",
        projectId: "prj_1",
        provider: "exedev",
      },
    })
    const pending = {
      ...fixture.record,
      state: "stop_pending" as const,
      desiredLocation: "local" as const,
      phase: "detaching" as const,
      operation: { kind: "stop" as const, phase: "adopting" },
    }
    await fixture.store.write(pending)

    await fixture.controller.onSessionIdle(pending.sessionId)

    expect(await fixture.store.get(pending.sessionId)).toMatchObject({
      state: "error",
      lastError: { code: "STOP_CONFLICT" },
    })
    expect(fixture.calls).toEqual(["inspect:resource-1"])
  })

  it("single-flights concurrent recovery and adopts the resource once", async () => {
    let releaseAdoption!: () => void
    let signalAdoptionStarted!: () => void
    const adoptionStarted = new Promise<void>((resolve) => { signalAdoptionStarted = resolve })
    const adoptionReleased = new Promise<void>((resolve) => { releaseAdoption = resolve })
    const fixture = await setupRecoveryFixture({ adoptGate: { started: signalAdoptionStarted, wait: adoptionReleased } })

    const first = fixture.controller.handle({ operation: "recover", force: false, capability: fixture.capability })
    await adoptionStarted
    const second = fixture.controller.handle({ operation: "recover", force: false, capability: fixture.capability })
    releaseAdoption()
    const results = await Promise.all([first, second])

    expect(results[0]).toMatchObject({ ok: true, operation: "recover", state: "remote" })
    expect(results[1]).toMatchObject({ ok: true, operation: "recover", state: "remote" })
    expect(fixture.calls.filter((call) => call === "adopt")).toHaveLength(1)
  })

  it("rejects Cloudflare recovery before runtime inspection", async () => {
    const fixture = await setupRecoveryFixture()
    await fixture.store.write({ ...fixture.record, provider: "cloudflare" })

    const result = await fixture.controller.handle({ operation: "recover", force: false, capability: fixture.capability })

    expect(result).toMatchObject({ ok: false, error: { code: "RECOVER_UNSUPPORTED", stage: "reconcile" } })
    expect(fixture.calls).toEqual([])
  })

  it("fails a stale recovery plan before claiming the adopted session", async () => {
    const fixture = await setupRecoveryFixture({
      onAdopt: async () => {
        await writeFile(fixture.store.recordPath(fixture.record.sessionId), `${JSON.stringify({ ...fixture.record, updatedAt: new Date(2000).toISOString() })}\n`)
      },
    })

    const result = await fixture.controller.handle({ operation: "recover", force: false, capability: fixture.capability })

    expect(result).toMatchObject({ ok: false, operation: "recover", error: { code: "RECOVER_STALE", stage: "validate" } })
    expect(fixture.calls).toEqual(["inspect:resource-1", "adopt", "abort"])
    expect(fixture.calls).not.toContain("warp:remote")
    expect(await fixture.store.get(fixture.record.sessionId)).toMatchObject({ state: "orphaned", updatedAt: new Date(2000).toISOString() })
  })

  it("aborts a failed recovered session without closing the provider resource", async () => {
    const fixture = await setupRecoveryFixture({
      routeError: new SandboxError("tunnel", "recovered target failed", "RECOVER_ROUTE"),
      abortPreservedWorktreePath: "/tmp/aborted-recovery",
    })

    const result = await fixture.controller.handle({ operation: "recover", force: false, capability: fixture.capability })

    expect(result).toMatchObject({
      ok: false,
      state: "recovery_pending",
      error: { code: "RECOVER_ROUTE" },
      work: { preservedWorktreePath: "/tmp/aborted-recovery" },
    })
    expect(result.allowedActions).toContainEqual(expect.objectContaining({ operation: "recover", role: "host" }))
    expect(result.allowedActions).toContainEqual(expect.objectContaining({ operation: "retry", role: "host" }))
    expect(await fixture.store.get(fixture.record.sessionId)).toMatchObject({
      state: "recovery_pending",
      operation: { kind: "recover", phase: "adopt_failed" },
      preservedWorktreePath: "/tmp/aborted-recovery",
    })
    expect(fixture.calls).toEqual(["inspect:resource-1", "adopt", "warp:remote", "abort"])
    expect(fixture.calls).not.toContain("close")
    expect(fixture.calls).not.toContain("destroy")
  })

  it("keeps adoption failure inspectable and recoverable without destroying the resource", async () => {
    const fixture = await setupRecoveryFixture({ adoptError: new SandboxError("adopt", "fake adoption failed", "FAKE_ADOPT") })

    const result = await fixture.controller.handle({ operation: "recover", force: false, capability: fixture.capability })

    expect(result).toMatchObject({ ok: false, state: "recovery_pending", error: { code: "FAKE_ADOPT" } })
    expect(await fixture.store.get(fixture.record.sessionId)).toMatchObject({
      state: "recovery_pending",
      operation: { kind: "recover", phase: "adopt_failed" },
      lastError: { code: "FAKE_ADOPT" },
    })
    expect(fixture.calls).toEqual(["inspect:resource-1", "adopt"])
    expect(fixture.calls).not.toContain("destroy")

    const inspection = await fixture.controller.handle({ operation: "inspect", force: false, capability: fixture.capability })
    expect(inspection).toMatchObject({ classification: "orphan", recommendedAction: { operation: "recover" } })
    expect(inspection.allowedActions).toContainEqual(expect.objectContaining({ operation: "recover", role: "host" }))
  })

  it("does not host-inspect a provider-local adopted checkout", async () => {
    const inspectedPaths: string[] = []
    const fixture = await setupRecoveryFixture({
      gitInspect: async (_record, worktreePath) => {
        inspectedPaths.push(worktreePath)
        return { head: "0123456789012345678901234567890123456789", branch: "opencode/recovered", dirty: false, evidence: ["fixture"] }
      },
    })

    await expect(fixture.controller.handle({ operation: "recover", force: false, capability: fixture.capability })).resolves.toMatchObject({
      ok: true,
      state: "remote",
    })
    const result = await fixture.controller.handle({ operation: "inspect", force: false, capability: fixture.capability })

    expect(inspectedPaths).toEqual([])
    expect(result.observations?.find((observation) => observation.source === "git")).toMatchObject({
      observed: false,
      evidence: ["runtime worktree is unavailable"],
    })
  })

  it("deletes a freshly observed orphan only after adoption and preservation", async () => {
    const fixture = await setupRecoveryFixture({ state: "remote" })

    await expect(fixture.controller.handle({ operation: "delete", force: false, capability: fixture.capability })).resolves.toMatchObject({
      ok: true,
      state: "delete_pending",
    })
    await fixture.controller.onSessionIdle(fixture.record.sessionId)

    expect(await fixture.store.get(fixture.record.sessionId)).toMatchObject({
      state: "deleted",
      operation: { kind: "delete", phase: "deleted", providerDestroyed: true },
    })
    expect(fixture.calls).toEqual([
      "inspect:resource-1",
      "inspect:resource-1",
      "adopt",
      "sync",
      "warp:local",
      "close",
      "workspace:remove",
      "inspect:resource-1",
      "destroy",
    ])
  })

  it("does not destroy an orphan when preservation sync fails", async () => {
    const fixture = await setupRecoveryFixture({
      syncError: new SandboxError("sync", "fake sync failed", "FAKE_SYNC"),
    })

    await fixture.controller.handle({ operation: "delete", force: false, capability: fixture.capability })
    await fixture.controller.onSessionIdle(fixture.record.sessionId)

    expect(await fixture.store.get(fixture.record.sessionId)).toMatchObject({
      state: "sync_failed",
      operation: { kind: "delete", phase: "adopting" },
      lastError: { code: "FAKE_SYNC" },
    })
    expect(fixture.calls).toEqual(["inspect:resource-1", "inspect:resource-1", "adopt", "sync"])
    expect(fixture.calls).not.toContain("close")
    expect(fixture.calls).not.toContain("destroy")
  })

  it("keeps orphan deletion adoption failure retryable without destroying", async () => {
    const fixture = await setupRecoveryFixture({ adoptError: new SandboxError("adopt", "fake adoption failed", "FAKE_ADOPT") })

    await fixture.controller.handle({ operation: "delete", force: false, capability: fixture.capability })
    await fixture.controller.onSessionIdle(fixture.record.sessionId)

    expect(await fixture.store.get(fixture.record.sessionId)).toMatchObject({
      state: "error",
      operation: { kind: "delete", phase: "adopting" },
      lastError: { code: "FAKE_ADOPT" },
    })
    expect(fixture.calls).toEqual(["inspect:resource-1", "inspect:resource-1", "adopt"])
    expect(fixture.calls).not.toContain("destroy")
  })

  it("blocks destruction when ownership changes after preservation", async () => {
    const fixture = await setupRecoveryFixture({
      observations: [
        { resource: "present", ownership: "verified", health: "healthy" },
        { resource: "present", ownership: "verified", health: "healthy" },
        { resource: "present", ownership: "conflict", health: "unknown" },
      ],
    })

    await fixture.controller.handle({ operation: "delete", force: false, capability: fixture.capability })
    await fixture.controller.onSessionIdle(fixture.record.sessionId)

    expect(await fixture.store.get(fixture.record.sessionId)).toMatchObject({
      state: "error",
      operation: { kind: "delete", phase: "destroying" },
      lastError: { code: "DELETE_OWNERSHIP_UNVERIFIED" },
    })
    expect(fixture.calls).toEqual([
      "inspect:resource-1",
      "inspect:resource-1",
      "adopt",
      "sync",
      "warp:local",
      "close",
      "workspace:remove",
      "inspect:resource-1",
    ])
    expect(fixture.calls).not.toContain("destroy")
  })

  it("requires ownership proof before force-discarding an orphan and skips sync only after adoption", async () => {
    const blocked = await setupRecoveryFixture({
      observations: [{ resource: "present", ownership: "conflict", health: "unknown" }],
    })

    await expect(blocked.controller.handle({ operation: "delete", force: true, capability: blocked.capability })).resolves.toMatchObject({
      ok: false,
      state: "orphaned",
      error: { code: "DELETE_CONFLICT" },
    })
    expect(blocked.calls).toEqual(["inspect:resource-1"])

    const discarded = await setupRecoveryFixture()
    await expect(discarded.controller.handle({ operation: "delete", force: true, capability: discarded.capability })).resolves.toMatchObject({
      ok: true,
      state: "deleted",
    })
    expect(discarded.calls).toEqual([
      "inspect:resource-1",
      "inspect:resource-1",
      "adopt",
      "warp:local",
      "close",
      "workspace:remove",
      "inspect:resource-1",
      "destroy",
    ])
    expect(discarded.calls).not.toContain("sync")
  })

  it("retries orphan deletion after workspace cleanup fails without readopting", async () => {
    const fixture = await setupRecoveryFixture({ workspaceRemoveFailures: 1 })

    await fixture.controller.handle({ operation: "delete", force: false, capability: fixture.capability })
    await fixture.controller.onSessionIdle(fixture.record.sessionId)
    expect(await fixture.store.get(fixture.record.sessionId)).toMatchObject({
      state: "error",
      operation: { kind: "delete", phase: "removing" },
    })

    await expect(fixture.controller.handle({ operation: "retry", force: false, capability: fixture.capability })).resolves.toMatchObject({
      ok: true,
      state: "deleted",
    })
    expect(fixture.calls.filter((call) => call === "adopt")).toHaveLength(1)
    expect(fixture.calls.filter((call) => call === "sync")).toHaveLength(1)
    expect(fixture.calls.filter((call) => call === "destroy")).toHaveLength(1)
    expect(fixture.calls.filter((call) => call === "workspace:remove")).toHaveLength(2)
  })

  it("does not repeat a persisted provider destruction while finalizing delete", async () => {
    const fixture = await setupRecoveryFixture()
    await fixture.store.write({
      ...fixture.record,
      state: "delete_pending",
      operation: { kind: "delete", phase: "destroying", providerDestroyed: true },
    })

    await fixture.controller.onSessionIdle(fixture.record.sessionId)

    expect(await fixture.store.get(fixture.record.sessionId)).toMatchObject({ state: "deleted" })
    expect(fixture.calls).toEqual([])
  })

  it("completes a persisted delete after fresh provider absence", async () => {
    const fixture = await setupRecoveryFixture({
      observation: { resource: "absent", ownership: "unknown", health: "unknown" },
    })
    const record = {
      ...fixture.record,
      state: "delete_pending" as const,
      operation: { kind: "delete" as const, phase: "destroying", providerDestroyed: true },
    }
    await fixture.store.write(record)

    await fixture.controller.reconcile(record.projectId)

    expect(await fixture.store.get(record.sessionId)).toMatchObject({
      state: "deleted",
      operation: { kind: "delete", phase: "deleted", providerDestroyed: true },
    })
    expect(fixture.calls).toEqual(["inspect:resource-1", "workspace:remove"])
    expect(fixture.calls).not.toContain("adopt")
    expect(fixture.calls).not.toContain("destroy")
  })

  it("does not clean up an unknown or conflicting workspace during persisted delete recovery", async () => {
    for (const workspaceObservation of ["unavailable", "foreign"] as const) {
      const fixture = await setupRecoveryFixture({
        observation: { resource: "absent", ownership: "unknown", health: "unknown" },
        workspaceObservation,
      })
      const record = {
        ...fixture.record,
        state: "delete_pending" as const,
        operation: { kind: "delete" as const, phase: "destroying", providerDestroyed: true },
      }
      await fixture.store.write(record)
      const before = await fixture.store.get(record.sessionId)

      await fixture.controller.reconcile(record.projectId)

      expect(await fixture.store.get(record.sessionId)).toEqual(before)
      expect(fixture.calls).toEqual(["inspect:resource-1"])
      expect(fixture.calls).not.toContain("workspace:remove")
      expect(fixture.calls).not.toContain("destroy")
    }
  })

  it("does not destroy again when retry finishes a provider-absent delete", async () => {
    const fixture = await setupRecoveryFixture({
      observation: { resource: "absent", ownership: "unknown", health: "unknown" },
    })
    const record = {
      ...fixture.record,
      state: "error" as const,
      operation: { kind: "delete" as const, phase: "removing", providerDestroyed: true },
    }
    await fixture.store.write(record)

    await expect(fixture.controller.handle({
      operation: "retry",
      force: false,
      capability: fixture.capability,
    })).resolves.toMatchObject({ ok: true, operation: "retry", state: "deleted" })

    expect(fixture.calls).toEqual(["inspect:resource-1", "workspace:remove"])
    expect(fixture.calls).not.toContain("adopt")
    expect(fixture.calls).not.toContain("destroy")
  })

  it("normalizes a crashed adopting delete into a fresh retry", async () => {
    const fixture = await setupRecoveryFixture()
    await fixture.store.write({
      ...fixture.record,
      state: "delete_pending",
      operation: { kind: "delete", phase: "adopting" },
    })

    await fixture.controller.reconcile("prj_1")

    expect(await fixture.store.get(fixture.record.sessionId)).toMatchObject({
      state: "recovery_pending",
      operation: { kind: "delete", phase: "adopting" },
      lastError: { code: "DELETE_RECOVERY_REQUIRED" },
    })
    const inspection = await fixture.controller.handle({ operation: "inspect", force: false, capability: fixture.capability })
    expect(inspection.allowedActions).toContainEqual(expect.objectContaining({ operation: "retry", role: "host" }))

    const retry = await fixture.controller.handle({ operation: "retry", force: false, capability: fixture.capability })

    expect(retry).toMatchObject({ ok: true, operation: "retry", state: "deleted" })
    expect(fixture.calls.filter((call) => call === "adopt")).toHaveLength(1)
    expect(fixture.calls).toContain("destroy")
  })

  it("preserves the close path when final workspace cleanup fails", async () => {
    const fixture = await setupRecoveryFixture({ closePreservedWorktreePath: "/tmp/closed-recovery", workspaceRemoveFailures: 1 })

    await fixture.controller.handle({ operation: "recover", force: false, capability: fixture.capability })
    await fixture.controller.handle({ operation: "stop", force: false, capability: fixture.capability })
    await fixture.controller.onSessionIdle(fixture.record.sessionId)

    expect(await fixture.store.get(fixture.record.sessionId)).toMatchObject({
      state: "error",
      preservedWorktreePath: "/tmp/closed-recovery",
    })
    expect(fixture.calls).toContain("close")
  })

  it("does not mutate a record during conflict reconciliation", async () => {
    const fixture = await setupRecoveryFixture({ state: "remote", workspaceObservation: "foreign" })
    const before = await fixture.store.get(fixture.record.sessionId)

    await fixture.controller.reconcile("prj_1")

    expect(await fixture.store.get(fixture.record.sessionId)).toEqual(before)
    expect(fixture.calls).not.toContain("adopt")
    expect(fixture.calls).not.toContain("workspace:remove")
    expect(fixture.calls).not.toContain("destroy")
  })

  it("leaves an unknown pending deletion unchanged during reconciliation", async () => {
    const fixture = await setupRecoveryFixture({
      observation: { resource: "unknown", ownership: "unknown", health: "unknown" },
    })
    const record = {
      ...fixture.record,
      state: "delete_pending" as const,
      operation: { kind: "delete" as const, phase: "awaiting_idle", force: true },
    }
    await fixture.store.write(record)
    const before = await fixture.store.get(record.sessionId)

    await fixture.controller.reconcile(record.projectId)

    expect(await fixture.store.get(record.sessionId)).toEqual(before)
    expect(fixture.calls).toEqual(["inspect:resource-1"])
  })

  it("leaves a conflicting pending deletion unchanged during reconciliation", async () => {
    const fixture = await setupRecoveryFixture({
      observation: { resource: "present", ownership: "conflict", health: "unknown" },
    })
    const record = {
      ...fixture.record,
      state: "delete_pending" as const,
      operation: { kind: "delete" as const, phase: "awaiting_idle", force: false },
    }
    await fixture.store.write(record)
    const before = await fixture.store.get(record.sessionId)

    await fixture.controller.reconcile(record.projectId)

    expect(await fixture.store.get(record.sessionId)).toEqual(before)
    expect(fixture.calls).toEqual(["inspect:resource-1"])
  })

  it("turns a verified pending stop into retryable recovery without provider mutation", async () => {
    const fixture = await setupRecoveryFixture({ state: "remote" })
    const record = {
      ...fixture.record,
      state: "stop_pending" as const,
      operation: { kind: "stop" as const, phase: "awaiting_idle" },
    }
    await fixture.store.write(record)

    await fixture.controller.reconcile(record.projectId)

    expect(await fixture.store.get(record.sessionId)).toMatchObject({
      state: "recovery_pending",
      operation: { kind: "stop", phase: "adopting" },
      lastError: { code: "STOP_RECOVERY_REQUIRED" },
    })
    expect(fixture.calls).toEqual(["inspect:resource-1"])
    const inspection = await fixture.controller.handle({
      operation: "inspect",
      force: false,
      capability: fixture.capability,
    })
    expect(inspection.allowedActions).toContainEqual(expect.objectContaining({ operation: "retry", role: "host" }))

    const retry = await fixture.controller.handle({ operation: "retry", force: false, capability: fixture.capability })

    expect(retry).toMatchObject({ ok: true, operation: "retry", state: "detached" })
    expect(fixture.calls).toEqual([
      "inspect:resource-1",
      "inspect:resource-1",
      "inspect:resource-1",
      "adopt",
      "sync",
      "warp:local",
      "close",
      "workspace:remove",
    ])
    expect(fixture.calls).not.toContain("destroy")
  })

  it("resumes verified pending deletion by adopting, preserving, and destroying once", async () => {
    const fixture = await setupRecoveryFixture({ state: "remote" })
    const record = {
      ...fixture.record,
      state: "delete_pending" as const,
      operation: { kind: "delete" as const, phase: "awaiting_idle", force: false },
    }
    await fixture.store.write(record)

    await fixture.controller.reconcile(record.projectId)

    expect(await fixture.store.get(record.sessionId)).toMatchObject({
      state: "recovery_pending",
      operation: { kind: "delete", phase: "adopting", force: false },
      lastError: { code: "DELETE_RECOVERY_REQUIRED" },
    })
    expect(fixture.calls).toEqual(["inspect:resource-1"])

    const retry = await fixture.controller.handle({ operation: "retry", force: false, capability: fixture.capability })

    expect(retry).toMatchObject({ ok: true, operation: "retry", state: "deleted" })
    expect(fixture.calls).toEqual([
      "inspect:resource-1",
      "inspect:resource-1",
      "adopt",
      "sync",
      "warp:local",
      "close",
      "workspace:remove",
      "inspect:resource-1",
      "destroy",
    ])
  })

  it("does not duplicate verified pending deletion effects across reconciliation and retry", async () => {
    const fixture = await setupRecoveryFixture({ state: "remote" })
    const record = {
      ...fixture.record,
      state: "delete_pending" as const,
      operation: { kind: "delete" as const, phase: "awaiting_idle", force: true },
    }
    await fixture.store.write(record)

    await fixture.controller.reconcile(record.projectId)
    await fixture.controller.reconcile(record.projectId)
    expect(fixture.calls).toEqual(["inspect:resource-1", "inspect:resource-1"])

    await expect(fixture.controller.handle({ operation: "retry", force: false, capability: fixture.capability })).resolves.toMatchObject({
      ok: true,
      state: "deleted",
    })
    await expect(fixture.controller.handle({ operation: "retry", force: false, capability: fixture.capability })).resolves.toMatchObject({
      ok: true,
      state: "deleted",
    })

    expect(fixture.calls.filter((call) => call === "adopt")).toHaveLength(1)
    expect(fixture.calls.filter((call) => call === "sync")).toHaveLength(0)
    expect(fixture.calls.filter((call) => call === "close")).toHaveLength(1)
    expect(fixture.calls.filter((call) => call === "destroy")).toHaveLength(1)
  })

  it("does not replay a recovery operation without fresh observations", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = {
      ...makeRecord(),
      state: "recovery_pending" as const,
      operation: { kind: "stop" as const, phase: "remote" },
    }
    await store.write(record)
    const calls: string[] = []
    const controller = new LifecycleController({
      store,
      providerRelease: async () => { calls.push("release") },
      workspace: {
        async create() { throw new Error("must not create") },
        async syncOut(input) {
          calls.push("sync")
          return { kind: "control-plane", baseSha: input.baseSha }
        },
        async warp() { calls.push("warp") },
        async remove() { calls.push("remove") },
      },
    })

    await controller.reconcile("prj_1")

    expect(calls).toEqual([])
    expect(await store.get(record.sessionId)).toMatchObject({ state: "recovery_pending", operation: record.operation })
  })

  it("replays Sandcastle recovery when its in-memory session handle is still available", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = {
      ...makeRecord(),
      state: "recovery_pending" as const,
      operation: { kind: "stop" as const, phase: "remote" },
    }
    await store.write(record)
    const calls: string[] = []
    const controller = new LifecycleController({
      store,
      sandcastle: { createAdapter: async () => { throw new Error("must not create") } },
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() { calls.push("warp") },
        async remove() { calls.push("remove") },
        async inspect() { return undefined },
      },
    })
    const session = {
      workspaceId: record.workspaceId,
      branch: record.branch,
      worktree: { worktreePath: "/tmp/worktree" },
      sandbox: {},
      target: { type: "remote", url: "https://sandbox.example.test" },
      recoveryMetadata: {},
      async inspect() {
        return { resourceId: "resource-1", resource: "present", ownership: "verified", health: "healthy", evidence: ["fixture"] }
      },
      async sync() { calls.push("sync"); return {} },
      async applyCapture() {},
      async close() { calls.push("close"); return {} },
    }
    const sessions = (controller as unknown as { sessions: Map<string, typeof session> }).sessions
    sessions.set(record.sessionId, session)

    await controller.reconcile("prj_1")

    expect(calls).toEqual(["sync", "warp", "close", "remove"])
    expect(await store.get(record.sessionId)).toMatchObject({
      state: "detached",
      operation: { kind: "stop", phase: "detached", providerDestroyed: true },
    })
  })

  it("does not destroy a preserved path until Git preservation is verified", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = { ...makeRecord(), state: "detached" as const, preservedWorktreePath: "/tmp/not-verified" }
    await store.write(record)
    let destroyed = false
    const controller = new LifecycleController({
      store,
      providerInspect: async () => ({ resourceId: "oc-0123456789", resource: "present", ownership: "verified", health: "healthy", evidence: ["fixture"] }),
      providerTarget: async () => undefined,
      providerDestroy: async () => { destroyed = true },
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() {},
        async remove() {},
        async inspect() { return undefined },
      },
    })

    const result = await controller.handle({
      operation: "delete",
      force: false,
      capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" }),
    })

    expect(result).toMatchObject({ ok: false, error: { code: "PRESERVATION_UNVERIFIED" } })
    expect(destroyed).toBe(false)
    expect(await store.get(record.sessionId)).toMatchObject({ state: "detached", preservedWorktreePath: record.preservedWorktreePath })
  })

  it("does not complete Sandcastle deletion without persisted destruction evidence", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = { ...makeRecord(), state: "detached" as const, preservedWorktreePath: "/tmp/preserved" }
    await store.write(record)
    const controller = new LifecycleController({
      store,
      sandcastle: { createAdapter: async () => { throw new Error("must not create") } },
      providerInspect: async () => ({ resourceId: "oc-0123456789", resource: "present", ownership: "verified", health: "healthy", evidence: ["fixture"] }),
      providerTarget: async () => undefined,
      gitInspect: async () => ({ head: record.baseSha, branch: record.branch, dirty: false, evidence: ["fixture"] }),
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() {},
        async remove() {},
        async inspect() { return undefined },
      },
    })
    const capability = createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" })

    await expect(controller.handle({ operation: "delete", force: false, capability })).resolves.toMatchObject({ state: "delete_pending" })
    await controller.onSessionIdle(record.sessionId)

    expect(await store.get(record.sessionId)).toMatchObject({ state: "error", lastError: { code: "SANDCASTLE_HANDLE" } })
  })

  it("allows Sandcastle deletion after a stopped session recorded provider destruction", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = {
      ...makeRecord(),
      state: "detached" as const,
      operation: { kind: "stop" as const, phase: "detached", providerDestroyed: true },
    }
    await store.write(record)
    let removed = 0
    const controller = new LifecycleController({
      store,
      sandcastle: { createAdapter: async () => { throw new Error("must not create") } },
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() {},
        async remove() { removed++ },
      },
    })
    const capability = createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" })

    await expect(controller.handle({ operation: "delete", force: false, capability })).resolves.toMatchObject({ state: "delete_pending" })
    await controller.onSessionIdle(record.sessionId)

    expect(removed).toBe(1)
    expect(await store.get(record.sessionId)).toMatchObject({ state: "deleted", operation: { kind: "delete", providerDestroyed: true } })
  })

  it("uses a preserved worktree for Git evidence and leaves runtime HEAD unknown without one", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const record = { ...makeRecord(), state: "detached" as const, preservedWorktreePath: "/tmp/preserved-worktree" }
    await store.write(record)
    const inspectedPaths: string[] = []
    const runtimeHead = "abcdefabcdefabcdefabcdefabcdefabcdefabcd"
    const controller = new LifecycleController({
      store,
      gitInspect: async (_record, worktreePath) => {
        inspectedPaths.push(worktreePath)
        return { head: runtimeHead, branch: "opencode/preserved", dirty: false, evidence: ["fixture"] }
      },
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() {},
        async remove() {},
      },
    })
    const capability = createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" })

    const preserved = await controller.handle({ operation: "inspect", force: false, capability })

    expect(inspectedPaths).toEqual([record.preservedWorktreePath])
    expect(preserved.work).toMatchObject({ runtimeHead, sync: "clean", preservation: "preserved" })

    await store.write({ ...record, state: "local", preservedWorktreePath: undefined })
    const local = await controller.handle({ operation: "inspect", force: false, capability })

    expect(inspectedPaths).toHaveLength(1)
    expect(local.work).toMatchObject({ runtimeHead: null })
    expect(local.observations?.find((observation) => observation.source === "git")).toMatchObject({
      observed: false,
      evidence: ["runtime worktree is unavailable"],
    })
  })

  it("inventories only the project records and provider listing", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    await store.write(makeRecord())
    await store.write({ ...makeRecord(), sessionId: "ses_other", projectId: "prj_other" })
    let inventoryCalls = 0
    const controller = new LifecycleController({
      store,
      providerInventory: async () => {
        inventoryCalls++
        return [{ resourceId: "resource-1", projectId: "prj_1", resource: "present", ownership: "unknown", health: "unknown", evidence: ["fixture"] }]
      },
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() {},
        async remove() {},
      },
    })

    const result = await controller.handle({
      operation: "inventory",
      force: false,
      capability: createCapability({ sessionId: "project_prj_1", generation: 1, role: "host", scope: "project", projectId: "prj_1" }),
    })

    expect(inventoryCalls).toBe(1)
    expect(result).toMatchObject({ operation: "inventory", state: "local", classification: "unknown", recommendedAction: null })
    expect(result.observations?.find((observation) => observation.source === "provider")?.health).toBe("unknown")
    expect(result.allowedActions).toEqual([expect.objectContaining({ operation: "inventory", role: "host" })])
    expect(result.details).toMatchObject({
      records: [expect.objectContaining({ sessionId: "ses_1", projectId: "prj_1" })],
      providerResources: [expect.objectContaining({ resourceId: "resource-1" })],
    })
  })

  it("keeps provider inventory scope unknown when any resource lacks project metadata", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const controller = new LifecycleController({
      store,
      providerInventory: async () => [
        { resourceId: "resource-project", projectId: "prj_1", resource: "present", ownership: "unknown", health: "healthy", evidence: ["fixture"] },
        { resourceId: "resource-unscoped", resource: "present", ownership: "verified", health: "healthy", evidence: ["fixture"] },
      ],
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() {},
        async remove() {},
      },
    })

    const result = await controller.handle({
      operation: "inventory",
      force: false,
      capability: createCapability({ sessionId: "project_prj_1", generation: 1, role: "host", scope: "project", projectId: "prj_1" }),
    })

    expect(result.classification).toBe("unknown")
    expect(result.observations?.find((observation) => observation.source === "provider")).toMatchObject({
      resource: "unknown",
      ownership: "unknown",
      health: "unknown",
    })
    expect(result.details?.providerResources).toEqual([expect.objectContaining({ resourceId: "resource-project" })])
  })

  it("keeps aggregate provider health unknown when one resource is unknown", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const controller = new LifecycleController({
      store,
      providerInventory: async () => [
        { resourceId: "resource-healthy", projectId: "prj_1", resource: "present", ownership: "unknown", health: "healthy", evidence: ["fixture"] },
        { resourceId: "resource-unknown", projectId: "prj_1", resource: "present", ownership: "unknown", health: "unknown", evidence: ["fixture"] },
      ],
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() {},
        async remove() {},
      },
    })

    const result = await controller.handle({
      operation: "inventory",
      force: false,
      capability: createCapability({ sessionId: "project_prj_1", generation: 1, role: "host", scope: "project", projectId: "prj_1" }),
    })

    expect(result.observations?.find((observation) => observation.source === "provider")?.health).toBe("unknown")
  })

  it("bounds inventory details before returning the control response", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const controller = new LifecycleController({
      store,
      providerInventory: async () => Array.from({ length: 1_000 }, (_, index) => ({
        resourceId: `resource-${index}`,
        projectId: "prj_1",
        resource: "present" as const,
        ownership: "unknown" as const,
        health: "healthy" as const,
        evidence: ["x".repeat(1_000)],
      })),
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() {},
        async remove() {},
      },
    })

    const result = await controller.handle({
      operation: "inventory",
      force: false,
      capability: createCapability({ sessionId: "project_prj_1", generation: 1, role: "host", scope: "project", projectId: "prj_1" }),
    })

    expect(result.details).toMatchObject({ truncated: true })
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64 * 1024)
  })

  it("keeps start and stop responses on their source side before warping", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    const calls: string[] = []
    const controller = new LifecycleController({
      store,
      providerInspect: async () => ({ resourceId: "oc-0123456789", resource: "present", ownership: "verified", health: "healthy", evidence: ["fixture"] }),
      providerTarget: async () => ({ type: "remote", url: "https://remote.example.test" }),
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

  it("does not supersede a failed stop, delete, or recover with direct start", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const effects: string[] = []
    const controller = new LifecycleController({
      store,
      capture: async () => {
        effects.push("capture")
        return { baseSha: makeRecord().baseSha, patch: "", untracked: [] }
      },
      providerInspect: async () => {
        effects.push("provider:inspect")
        return { resourceId: "resource-1", resource: "present", ownership: "verified", health: "healthy", evidence: ["fixture"] }
      },
      providerTarget: async () => {
        effects.push("provider:target")
        return undefined
      },
      gitInspect: async () => {
        effects.push("git:inspect")
        return { head: makeRecord().baseSha, branch: makeRecord().branch, dirty: false, evidence: ["fixture"] }
      },
      workspace: {
        async create() {
          effects.push("workspace:create")
          throw new Error("must not create")
        },
        async warp() { effects.push("workspace:warp") },
        async remove() { effects.push("workspace:remove") },
        async inspect() {
          effects.push("workspace:inspect")
          return undefined
        },
      },
    })
    controller.registerContext({ sessionId: "ses_1", projectId: "prj_1", directory: "/tmp/project", worktree: "/tmp/project" })

    for (const kind of ["stop", "delete", "recover"] as const) {
      const record: SandboxRecord = {
        ...makeRecord(),
        generation: 7,
        state: "error",
        preservedWorktreePath: "/tmp/preserved",
        operation: { kind, phase: kind === "recover" ? "adopt_failed" : "awaiting_idle" },
        lastError: { code: `${kind.toUpperCase()}_FAILED`, stage: "remove", message: `${kind} failed` },
      }
      await store.write(record)
      const before = await store.get(record.sessionId)

      const result = await controller.handle({
        operation: "start",
        force: false,
        capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" }),
      })

      expect(result).toMatchObject({ ok: false, operation: "start", stage: "transition", error: { code: "SESSION_ERROR" } })
      const after = await store.get(record.sessionId)
      expect(after?.journal).toHaveLength(1)
      expect(JSON.stringify({ ...after, journal: undefined })).toBe(JSON.stringify({ ...before, journal: undefined }))
      expect(effects).toEqual([])
    }
  })

  it("allows an authorized retry of a failed direct start", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    const effects: string[] = []
    let failApply = true
    const controller = new LifecycleController({
      store,
      capture: async () => {
        effects.push("capture")
        return { baseSha: makeRecord().baseSha, patch: "patch", untracked: [] }
      },
      workspace: {
        async create(input) {
          effects.push("workspace:create")
          return {
            id: input.id ?? "wrk_1",
            type: input.type,
            name: "workspace",
            branch: input.branch,
            directory: input.directory,
            projectID: input.projectId,
            extra: null,
          }
        },
        async applyCapture() {
          effects.push("workspace:applyCapture")
          if (failApply) {
            failApply = false
            throw new SandboxError("sync", "initial start failed", "CAPTURE_FAILED")
          }
        },
        async warp() {},
        async remove() { effects.push("workspace:remove") },
      },
    })
    controller.registerContext({ sessionId: "ses_1", projectId: "prj_1", directory: "/tmp/project", worktree: "/tmp/project" })
    const capability = createCapability({ sessionId: "ses_1", generation: 1, role: "host" })

    await expect(controller.handle({ operation: "start", force: false, capability })).resolves.toMatchObject({ ok: false, state: "error" })
    const failed = await store.get("ses_1")
    if (!failed) throw new Error("failed start record was not written")

    await expect(controller.handle({ operation: "retry", force: false, capability })).resolves.toMatchObject({
      ok: true,
      operation: "start",
      state: "activation_pending",
    })

    const retried = await store.get("ses_1")
    expect(retried).toMatchObject({
      generation: failed.generation,
      workspaceId: failed.workspaceId,
      operation: { kind: "start", phase: "awaiting_idle" },
    })
    expect(retried?.lastError).toBeUndefined()
    expect(effects.filter((effect) => effect === "capture")).toHaveLength(2)
    expect(effects.filter((effect) => effect === "workspace:create")).toHaveLength(2)
    expect(effects.filter((effect) => effect === "workspace:applyCapture")).toHaveLength(2)
    expect(effects.filter((effect) => effect === "workspace:remove")).toHaveLength(2)
  })

  it("blocks detach when sync returns a different base revision", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    const record = { ...makeRecord(), state: "remote" as const }
    await store.write(record)
    const calls: string[] = []
    const controller = new LifecycleController({
      store,
      providerInspect: async () => ({ resourceId: "oc-0123456789", resource: "present", ownership: "verified", health: "healthy", evidence: ["fixture"] }),
      providerTarget: async () => ({ type: "remote", url: "https://remote.example.test" }),
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
      providerInspect: async () => ({ resourceId: "resource-1", resource: "absent", ownership: "unknown", health: "unknown", evidence: ["fixture"] }),
      providerTarget: async () => undefined,
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
        async inspect() { return undefined },
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

  it("holds the record lock through force-delete destruction", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    await store.write({ ...makeRecord(), state: "detached" })
    let unblockDestroy!: () => void
    let destroyStarted!: () => void
    const started = new Promise<void>((resolve) => { destroyStarted = resolve })
    const controller = new LifecycleController({
      store,
      providerInspect: async () => ({ resourceId: "oc-0123456789", resource: "present", ownership: "verified", health: "healthy", evidence: ["fixture"] }),
      providerTarget: async () => undefined,
      providerDestroy: async () => {
        destroyStarted()
        await new Promise<void>((resolve) => { unblockDestroy = resolve })
      },
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() {},
        async remove() {},
        async inspect() { return undefined },
      },
    })
    const capability = createCapability({ sessionId: "ses_1", generation: 1, role: "host" })

    const deleting = controller.handle({ operation: "delete", force: true, capability })
    await started
    const concurrent = await controller.handle({ operation: "delete", force: true, capability })
    unblockDestroy()

    expect(concurrent).toMatchObject({ ok: false, stage: "validate" })
    expect(concurrent.message).toMatch(/locked/)
    await expect(deleting).resolves.toMatchObject({ ok: true, state: "deleted" })
  })

  it("allows only one concurrent retry to perform destruction", async () => {
    let unblockReads!: () => void
    let readsStarted!: () => void
    const readsReady = new Promise<void>((resolve) => { readsStarted = resolve })
    const readGate = new Promise<void>((resolve) => { unblockReads = resolve })
    const store = new (class extends FileStateStore {
      private reads = 0

      override async get(sessionId: string) {
        const record = await super.get(sessionId)
        if (this.reads < 2) {
          this.reads++
          if (this.reads === 2) readsStarted()
          await readGate
        }
        return record
      }
    })(await temporaryDirectory())
    await store.write({
      ...makeRecord(),
      state: "error",
      operation: { kind: "delete", phase: "destroying" },
      lastError: { stage: "remove", message: "destroy failed" },
    })
    let unblockDestroy!: () => void
    let destroyStarted!: () => void
    let destroyCalls = 0
    const destroying = new Promise<void>((resolve) => { destroyStarted = resolve })
    const controller = new LifecycleController({
      store,
      providerDestroy: async () => {
        destroyCalls++
        destroyStarted()
        await new Promise<void>((resolve) => { unblockDestroy = resolve })
      },
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() {},
        async remove() {},
      },
    })
    const capability = createCapability({ sessionId: "ses_1", generation: 1, role: "host" })

    const retries = [
      controller.handle({ operation: "retry", force: false, capability }),
      controller.handle({ operation: "retry", force: false, capability }),
    ]
    await readsReady
    unblockReads()
    await destroying
    const concurrent = await Promise.race(retries)
    expect(concurrent).toMatchObject({ ok: false, stage: "validate" })
    expect(concurrent.message).toMatch(/locked/)
    unblockDestroy()
    const results = await Promise.all(retries)

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(destroyCalls).toBe(1)
    expect(await store.get("ses_1")).toMatchObject({ state: "deleted" })
  })

  it("holds the record lock through reconciliation effects", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    await store.write({ ...makeRecord(), state: "remote", operation: { kind: "stop", phase: "remote" } })
    let unblockRelease!: () => void
    let releaseStarted!: () => void
    const started = new Promise<void>((resolve) => { releaseStarted = resolve })
    const controller = new LifecycleController({
      store,
      providerInspect: async () => ({ resourceId: "resource-1", resource: "present", ownership: "verified", health: "healthy", evidence: ["fixture"] }),
      providerTarget: async () => ({ type: "remote", url: "https://remote.example.test" }),
      providerRelease: async () => {
        releaseStarted()
        await new Promise<void>((resolve) => { unblockRelease = resolve })
      },
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() {},
        async syncOut(input) { return { kind: "control-plane", baseSha: input.baseSha } },
        async remove() {},
        async inspect() { return undefined },
      },
    })
    const capability = createCapability({ sessionId: "ses_1", generation: 1, role: "host" })

    const reconciliation = controller.reconcile("prj_1")
    await started
    const concurrent = await controller.handle({ operation: "delete", force: false, capability })
    unblockRelease()
    await reconciliation

    expect(concurrent).toMatchObject({ ok: false, stage: "validate" })
    expect(concurrent.message).toMatch(/locked/)
    expect(await store.get("ses_1")).toMatchObject({ state: "detached" })
  })

  it("leaves an unobserved restart recovery record unchanged", async () => {
    const store = new FileStateStore(await temporaryDirectory())
    await store.write({ ...makeRecord(), state: "remote" })
    const calls: string[] = []
    const controller = new LifecycleController({
      store,
      providerRelease: async () => { calls.push("release") },
      workspace: {
        async create() { throw new Error("must not create") },
        async syncOut() { calls.push("sync"); return { kind: "control-plane", baseSha: makeRecord().baseSha } },
        async warp() { calls.push("warp") },
        async remove() { calls.push("remove") },
      },
    })

    await controller.reconcile("prj_1")

    expect(calls).toEqual([])
    expect(await store.get("ses_1")).toMatchObject({ state: "remote" })
  })

  it("does not apply a plan made from a stale list snapshot", async () => {
    let unblockList!: () => void
    let listStarted!: () => void
    const started = new Promise<void>((resolve) => { listStarted = resolve })
    const store = new (class extends FileStateStore {
      override async list() {
        const records = await super.list()
        listStarted()
        await new Promise<void>((resolve) => { unblockList = resolve })
        return records
      }
    })(await temporaryDirectory())
    await store.write({ ...makeRecord(), state: "remote", providerState: { resourceId: "resource-1" } })
    let destroyCalls = 0
    const controller = new LifecycleController({
      store,
      runtimeDriver: {
        async inspect() { return { resourceId: "resource-1", resource: "present", ownership: "verified", health: "healthy", evidence: ["fixture"] } },
        async adopt() { throw new Error("must not adopt") },
        async sync() {},
        async close() { return {} },
        async destroy() {},
      },
      providerDestroy: async () => { destroyCalls++ },
      workspace: {
        async create() { throw new Error("must not create") },
        async warp() {},
        async syncOut(input) { return { kind: "control-plane", baseSha: input.baseSha } },
        async remove() {},
        async inspect() { return undefined },
      },
    })
    const capability = createCapability({ sessionId: "ses_1", generation: 1, role: "host" })

    const reconciliation = controller.reconcile("prj_1")
    await started
    await expect(controller.handle({ operation: "delete", force: false, capability })).resolves.toMatchObject({ state: "delete_pending" })
    unblockList()
    await reconciliation

    expect(await store.get("ses_1")).toMatchObject({ state: "delete_pending" })
    expect(destroyCalls).toBe(0)
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

  it("does not let a direct start supersede a pending delete retry", async () => {
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
    const directStart = await controller.handle({
      operation: "start",
      force: false,
      capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" }),
    })
    expect(directStart).toMatchObject({ ok: false, stage: "transition", state: "error", error: { code: "SESSION_ERROR" } })
    unblock()

    const result = await remoteRetry

    expect(result).toMatchObject({ ok: true, operation: "retry", state: "deleted" })
    expect(destroyed).toBe(true)
    expect(await store.get(record.sessionId)).toMatchObject({ state: "deleted" })
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
    const record = { ...makeRecord(), state: "orphaned" as const, providerState: { metadata: "y".repeat(100_000) } }
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
    expect(Buffer.byteLength(JSON.stringify(logs))).toBeLessThan(64 * 1024)
    expect(Buffer.byteLength(JSON.stringify(diagnostics))).toBeLessThan(64 * 1024)
    expect(`${JSON.stringify(logs)}${JSON.stringify(diagnostics)}`).not.toContain("private")
  })

  it("does not finish detached delete recovery without fresh observations", async () => {
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

    expect(destroyed).toBe(false)
    expect(await store.get("ses_1")).toMatchObject({
      state: "delete_pending",
      operation: { kind: "delete", phase: "destroying" },
    })
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
    expect(shellEnv.env.SANDBOX_CONTROL_PROJECT_TOKEN).toHaveLength(43)
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
    const registeredAdapter = adapter
    cleanups.push(hooks.dispose)

    expect(registeredAdapter.name).toBe("Docker Sandbox")
    expect(registeredType).toBe("sbx")

    const workspace = await registeredAdapter.configure({
      id: "wrk_sbx_registry",
      type: "sbx",
      name: "workspace",
      branch: "opencode/sbx-registry",
      directory: root,
      projectID: "prj_1",
      extra: {
        owner: "opencode-sandbox",
        sessionId: "ses_sbx_registry",
        generation: 2,
        workspaceId: "wrk_sbx_registry",
        projectId: "prj_1",
        provider: "sbx",
        remoteWorktreePath: "/workspace/project/.opencode-worktree",
      },
    })
    expect(workspace.directory).toBe("/workspace/project/.opencode-worktree")
    expect(workspace.extra).toEqual(expect.objectContaining({
      owner: "opencode-sandbox",
      sessionId: "ses_sbx_registry",
      generation: 2,
      workspaceId: "wrk_sbx_registry",
      projectId: "prj_1",
      provider: "sbx",
      remoteWorktreePath: "/workspace/project/.opencode-worktree",
    }))
    expect(() => registeredAdapter.configure({
      ...workspace,
      extra: { ...workspace.extra as Record<string, unknown>, remoteWorktreePath: undefined },
    })).toThrow("SBX remote worktree path is invalid")
    expect(() => registeredAdapter.configure({
      ...workspace,
      extra: { ...workspace.extra as Record<string, unknown>, remoteWorktreePath: "/workspace/../project" },
    })).toThrow("SBX remote worktree path is invalid")
  })

  it("registers the exe.dev checkout path without replacing ownership metadata", async () => {
    const root = await temporaryDirectory()
    let adapter: WorkspaceAdapterLike | undefined
    const hooks = await createSandboxPlugin(
      {
        project: { id: "prj_1" },
        directory: root,
        worktree: root,
        serverUrl: new URL("http://127.0.0.1:4096"),
        experimental_workspace: { register: (_type, value) => { adapter = value } },
      },
      {
        config: { provider: "exedev" },
        env: { HOME: root, XDG_RUNTIME_DIR: root, OPENCODE_EXPERIMENTAL_WORKSPACES: "1" },
      },
    )
    if (!hooks || !adapter) throw new Error("plugin did not initialize")
    cleanups.push(hooks.dispose)

    const remoteDirectory = "/tmp/oe-control"
    const remoteWorktreePath = remoteWorkspaceDirectory("wrk_exedev_registry")
    const workspace = await adapter.configure({
      id: "wrk_exedev_registry",
      type: "exedev",
      name: "oc-exedev-registry",
      branch: "opencode/exedev-registry",
      directory: root,
      projectID: "prj_1",
      extra: {
        owner: "opencode-sandbox",
        sessionId: "ses_exedev_registry",
        generation: 2,
        workspaceId: "wrk_exedev_registry",
        projectId: "prj_1",
        provider: "exedev",
        providerState: { provider: "exedev", remoteDirectory, remoteWorktreePath },
      },
    })

    expect(workspace.directory).toBe(remoteWorktreePath)
    expect(workspace.directory).not.toBe(remoteDirectory)
    expect(workspace.extra).toEqual(expect.objectContaining({
      owner: "opencode-sandbox",
      sessionId: "ses_exedev_registry",
      generation: 2,
      workspaceId: "wrk_exedev_registry",
      projectId: "prj_1",
      provider: "exedev",
      providerState: { provider: "exedev", remoteDirectory, remoteWorktreePath },
    }))
    expect(() => adapter!.configure({
      ...workspace,
      extra: { ...workspace.extra as Record<string, unknown>, providerState: { remoteDirectory } },
    })).toThrow("exe.dev remote worktree path is invalid")
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
    expect((await adapter.configure({
      id: "wrk_1",
      type: "cloudflare",
      name: "workspace",
      branch: null,
      directory: null,
      extra: null,
      projectID: "prj_1",
    })).directory).toBe("/workspace/.opencode-worktree")
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
    const apiKey = "project-file-test-key"
    await writeFile(join(root, ".opencode", "sandbox.json"), JSON.stringify({
      provider: "cloudflare",
      apiUrl: "https://bridge.example.test",
      apiKey,
    }))
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

    expect(registeredType).toBe("cloudflare")
    const shell = { env: {} as Record<string, string> }
    await hooks["shell.env"]({ cwd: root, sessionID: "ses_project_file" }, shell)
    const output: string[] = []
    await expect(runCli(["diagnose"], {
      SANDBOX_CONTROL_SOCKET: shell.env.SANDBOX_CONTROL_SOCKET,
      SANDBOX_CONTROL_TOKEN: shell.env.SANDBOX_CONTROL_TOKEN,
    }, { stdout: (text) => output.push(text) })).resolves.toBe(0)
    expect(output[0]).not.toContain(apiKey)
  })

  it("applies SANDBOX_CONFIG before present per-field API environment overrides", async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, ".opencode"))
    await writeFile(join(root, ".opencode", "sandbox.json"), JSON.stringify({
      provider: "cloudflare",
      apiUrl: "https://file.example.test",
      apiKey: "file-key",
    }))
    const input = {
      project: { id: "prj_1" },
      directory: root,
      worktree: root,
      serverUrl: new URL("http://127.0.0.1:4096"),
      experimental_workspace: { register: () => {} },
    }
    const baseEnv = { HOME: root, XDG_RUNTIME_DIR: root, OPENCODE_EXPERIMENTAL_WORKSPACES: "1" }
    const configLogs: string[] = []
    await expect(createSandboxPlugin(input, {
      env: {
        ...baseEnv,
        SANDBOX_CONFIG: JSON.stringify({ apiUrl: "http://public.example.test", apiKey: "json-key" }),
      },
      log: (message) => configLogs.push(message),
    })).resolves.toBeUndefined()
    expect(configLogs.join(" ")).not.toContain("json-key")

    const hooks = await createSandboxPlugin(input, {
      env: {
        ...baseEnv,
        SANDBOX_CONFIG: JSON.stringify({ apiUrl: "http://public.example.test", apiKey: "" }),
        SANDBOX_API_URL: "https://env.example.test",
        SANDBOX_API_KEY: "env-key",
      },
    })
    if (!hooks) throw new Error("environment-overridden sandbox plugin did not initialize")
    cleanups.push(hooks.dispose)

    const emptyLogs: string[] = []
    await expect(createSandboxPlugin(input, {
      env: { ...baseEnv, SANDBOX_API_KEY: "" },
      log: (message) => emptyLogs.push(message),
    })).resolves.toBeUndefined()
    expect(emptyLogs.join(" ")).not.toContain("file-key")
  })
})

describe("exe.dev provisioner", () => {
  it("rejects an oversized local control socket before VM creation", async () => {
    const root = await temporaryDirectory()
    const localControlSocket = `/${"x".repeat(MAX_UNIX_SOCKET_PATH_BYTES - 1)}`
    let created = false

    expect(() => new ExedevProvider({
      config: parseConfig({}, { HOME: root }),
      control: {
        async create() {
          created = true
          throw new Error("must not create")
        },
      } as unknown as ExeControl,
      worktree: root,
      localControlSocket,
    })).toThrow(/socket.*too long/i)
    expect(created).toBe(false)
  })

  it("writes below a literal root and rejects an encoded root", async () => {
    const root = await realpath(await temporaryDirectory())
    const relative = Buffer.from("nested.txt").toString("base64url")
    const runWriter = (rootArgument: string, content: string) => nodeProcessRunner.run({
      argv: ["python3", "-c", REMOTE_WRITE_FILE, rootArgument, relative],
      cwd: root,
      stdin: content,
    })

    await expect(runWriter(root, "literal root\n")).resolves.toMatchObject({ exitCode: 0 })
    expect(await readFile(join(root, "nested.txt"), "utf8")).toBe("literal root\n")

    const encodedRoot = Buffer.from(root).toString("base64url")
    const rejected = await runWriter(encodedRoot, "encoded root\n")
    expect(rejected.exitCode).not.toBe(0)
    expect(rejected.stderr).toContain("runtime directory must be absolute")
    await expect(readFile(join(root, encodedRoot, "nested.txt"))).rejects.toThrow()
  })

  it("rejects an unsafe host worktree alias before provisioning", () => {
    expect(() => new ExedevProvider({
      config: parseConfig({}, { HOME: "/tmp" }),
      control: {} as ExeControl,
      worktree: "/tmp/../project",
      localControlSocket: "/tmp/control.sock",
    })).toThrow(/host worktree alias path is unsafe/)
  })

  it("reports verified, absent, and ambiguous live VM states", async () => {
    const root = await temporaryDirectory()
    const identity = {
      name: "oc-0123456789",
      sshDest: "owned.exe.xyz",
      tags: ["opencode-sandbox", `opencode-owner-${shortHash("prj_1:ses_1:wrk_1:1")}`],
      comment: "opencode-test",
    }
    const foreign = { ...identity, sshDest: "foreign.exe.xyz" }
    let inventory: unknown[] = [{ identity, status: "running" }]
    const provider = new ExedevProvider({
      config: parseConfig({}, { HOME: root }),
      control: {
        async create() { throw new Error("must not create") },
        async copy() { throw new Error("must not copy") },
        async list() { return inventory as VmInfo[] },
        async remove() { throw new Error("must not remove") },
        async tag() {},
      },
      worktree: root,
      localControlSocket: join(root, "control.sock"),
    })
    const info = {
      id: "wrk_1",
      type: "exedev",
      name: identity.name,
      branch: "opencode/sandbox-0123456789",
      directory: remoteWorkspaceDirectory("wrk_1"),
      projectID: "prj_1",
      extra: { sessionId: "ses_1", generation: 1, vmIdentity: identity },
    }

    await expect(provider.inspect(info)).resolves.toMatchObject({ resource: "present", ownership: "verified", health: "healthy" })
    inventory = [{ identity }, { identity: foreign, status: "running" }]
    await expect(provider.inspect(info)).resolves.toMatchObject({ resource: "present", ownership: "conflict", health: "unknown" })
    inventory = []
    await expect(provider.inspect(info)).resolves.toMatchObject({ resource: "absent", ownership: "unknown", health: "unknown" })
  })

  it("does not use VM status as authenticated OpenCode health", async () => {
    const root = await temporaryDirectory()
    const identity = {
      name: "oc-0123456789",
      sshDest: "owned.exe.xyz",
      tags: ["opencode-sandbox", `opencode-owner-${shortHash("prj_1:ses_health:wrk_health:1")}`],
      comment: "opencode-test",
    }
    const info = {
      id: "wrk_health",
      type: "exedev",
      name: identity.name,
      branch: "opencode/sandbox-health",
      directory: remoteWorkspaceDirectory("wrk_health"),
      projectID: "prj_1",
      extra: { sessionId: "ses_health", generation: 1, vmIdentity: identity },
    }
    let authorization = ""
    const provider = new ExedevProvider({
      config: parseConfig({}, { HOME: root }),
      control: {
        async list() { return [{ identity, status: "running" }] }
      } as unknown as ExeControl,
      worktree: root,
      localControlSocket: join(root, "control.sock"),
      fetcher: (async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? ""
        return new Response(JSON.stringify({ healthy: true }), { status: 503 })
      }) as typeof fetch,
    })
    ;(provider as unknown as { active: Map<string, unknown> }).active.set(info.id, {
      process: { alive: true },
      localPort: 4100,
      password: "private",
    })

    await expect(provider.inspect(info)).resolves.toMatchObject({ resource: "present", ownership: "verified", health: "healthy" })
    await expect(provider.diagnose(info)).resolves.toMatchObject({ resource: "present", ownership: "verified", health: "unknown" })
    expect(authorization).toMatch(/^Basic /)
  })

  it("uses authenticated health for exe.dev Sandcastle inspection", async () => {
    const root = await temporaryDirectory()
    const calls: string[] = []
    const provider = {
      name: "exe.dev",
      async inspect() {
        calls.push("inspect")
        return { resourceId: "vm-1", resource: "present" as const, ownership: "verified" as const, health: "healthy" as const, evidence: ["VM status"] }
      },
      async diagnose() {
        calls.push("diagnose")
        return { resourceId: "vm-1", resource: "present" as const, ownership: "verified" as const, health: "unknown" as const, evidence: ["authenticated health unavailable"] }
      },
    } as unknown as ExedevProvider
    const adapter = createExedevSandcastleAdapter({
      provider,
      config: parseConfig({}, { HOME: root }),
      control: {} as ExeControl,
      worktree: root,
      localControlSocket: join(root, "control.sock"),
      input: {
        sessionId: "ses_adapter_health",
        projectId: "prj_1",
        workspaceId: "wrk_adapter_health",
        generation: 1,
        branch: "opencode/sandbox-health",
        baseSha: "0123456789012345678901234567890123456789",
        context: { sessionId: "ses_adapter_health", projectId: "prj_1", directory: root, worktree: root },
      },
    })

    await expect(adapter.inspect?.()).resolves.toMatchObject({ resource: "present", ownership: "verified", health: "unknown" })
    expect(calls).toEqual(["diagnose"])
  })

  it("fails closed for malformed ExeDev workspace and inventory data", async () => {
    const root = await temporaryDirectory()
    const identity = {
      name: "oc-0123456789",
      sshDest: "owned.exe.xyz",
      tags: ["opencode-sandbox", `opencode-owner-${shortHash("prj_1:ses_1:wrk_1:1")}`],
      comment: "opencode-test",
    }
    let inventory: unknown[] = [{ identity, status: "running" }]
    const provider = new ExedevProvider({
      config: parseConfig({}, { HOME: root }),
      control: {
        async create() { throw new Error("must not create") },
        async copy() { throw new Error("must not copy") },
        async list() { return inventory as VmInfo[] },
        async remove() { throw new Error("must not remove") },
        async tag() {},
      },
      worktree: root,
      localControlSocket: join(root, "control.sock"),
    })
    const info = {
      id: "wrk_1",
      type: "exedev",
      name: identity.name,
      branch: "opencode/sandbox-0123456789",
      directory: remoteWorkspaceDirectory("wrk_1"),
      projectID: "prj_1",
      extra: { sessionId: "ses_1", generation: 1, vmIdentity: identity },
    }

    await expect(provider.inspect({ ...info, name: 42 } as never)).rejects.toMatchObject({ code: "EXEDEV_WORKSPACE_INVALID" })
    inventory = [{ identity: { ...identity, sshDest: 42 }, status: "running" }]
    await expect(provider.inspect(info)).rejects.toMatchObject({ code: "EXEDEV_SCHEMA" })
    inventory = [{ identity, status: 42 }]
    await expect(provider.inspect(info)).rejects.toMatchObject({ code: "EXEDEV_SCHEMA" })
    await expect(provider.inspect({ ...info, extra: { ...info.extra, vmIdentity: null, providerState: { vmIdentity: identity } } })).rejects.toMatchObject({ code: "VM_IDENTITY_INVALID" })
  })

  it("reports a same-name foreign VM as an ownership conflict", async () => {
    const root = await temporaryDirectory()
    const expected = {
      name: "oc-0123456789",
      sshDest: "owned.exe.xyz",
      tags: ["opencode-sandbox"],
      comment: "opencode-test",
    }
    const foreign = { ...expected, sshDest: "foreign.exe.xyz" }
    const provider = new ExedevProvider({
      config: parseConfig({}, { HOME: root }),
      control: {
        async create() { throw new Error("must not create") },
        async copy() { throw new Error("must not copy") },
        async list() { return [{ identity: foreign, status: "running" }] },
        async remove() { throw new Error("must not remove") },
        async tag() {},
      },
      worktree: root,
      localControlSocket: join(root, "control.sock"),
    })

    await expect(provider.inspect({
      id: "wrk_1",
      type: "exedev",
      name: expected.name,
      branch: "opencode/sandbox-0123456789",
      directory: remoteWorkspaceDirectory("wrk_1"),
      projectID: "prj_1",
      extra: { sessionId: "ses_1", generation: 1, vmIdentity: expected },
    })).resolves.toMatchObject({ resource: "present", ownership: "conflict" })
  })

  it("does not destroy a same-name foreign VM from persisted metadata", async () => {
    const root = await temporaryDirectory()
    const foreign = {
      name: "oc-0123456789",
      sshDest: "foreign.exe.xyz",
      tags: ["opencode-sandbox", "opencode-owner-foreign"],
      comment: "opencode-foreign",
    }
    let removed = false
    const provider = new ExedevProvider({
      config: parseConfig({}, { HOME: root }),
      control: {
        async create() { throw new Error("must not create") },
        async copy() { throw new Error("must not copy") },
        async list() { return [{ identity: foreign, status: "running" }] },
        async remove() { removed = true },
        async tag() {},
      },
      worktree: root,
      localControlSocket: join(root, "control.sock"),
    })

    await expect(provider.destroy({
      id: "wrk_1",
      type: "exedev",
      name: foreign.name,
      branch: "opencode/sandbox-0123456789",
      directory: remoteWorkspaceDirectory("wrk_1"),
      projectID: "prj_1",
      extra: { sessionId: "ses_1", generation: 1, vmIdentity: foreign },
    })).rejects.toMatchObject({ code: "EXEDEV_OWNERSHIP_UNVERIFIED" })
    expect(removed).toBe(false)
  })

  it("restarts an owned exe.dev runtime through inspect, adopt, sync, close, and destroy without creating", async () => {
    const fixture = await createExedevRuntimeFixture()
    const resource = { provider: "exedev", resourceId: fixture.vm.identity.name }

    await expect(fixture.driver.inspect(resource)).resolves.toMatchObject({
      resource: "present",
      ownership: "verified",
      health: "healthy",
    })
    const session = await fixture.driver.adopt({ resource, owner: fixture.owner })
    expect(session.target).toMatchObject({ type: "remote", url: "http://127.0.0.1:4100" })
    expect(session.worktreePath).toBeUndefined()
    expect(session.remoteWorktreePath).toBe(remoteWorkspaceDirectory(fixture.owner.workspaceId))
    expect(session.recoveryMetadata).toMatchObject({
      provider: "exedev",
      remoteDirectory: fixture.remoteDirectory,
      vmName: fixture.vm.identity.name,
    })
    expect(session.recoveryMetadata).not.toHaveProperty("localPort")
    expect(session.recoveryMetadata).not.toHaveProperty("controlToken")

    await fixture.driver.sync(session)
    await expect(fixture.driver.close(session)).resolves.toEqual({})
    expect(fixture.created).toBe(0)
    expect(fixture.copied).toBe(0)
    expect(fixture.started).toBe(1)
    expect(fixture.terminated).toBe(1)
    expect(fixture.revoked).toBe(1)
    expect(fixture.removed).toBe(0)
    expect(fixture.calls.some((argv) => argv.includes("git") && argv.includes("add"))).toBe(true)
    expect(fixture.calls.some((argv) => argv.includes("rm") && argv.includes("-rf"))).toBe(true)

    await fixture.driver.destroy(resource, fixture.owner)
    expect(fixture.removed).toBe(1)
  })

  it("rejects exe.dev adoption for divergent or unrelated history before local control starts", async () => {
    for (const head of [
      "fedcba9876543210fedcba9876543210fedcba98",
      "abcdef0123456789abcdef0123456789abcdef01",
    ]) {
      const fixture = await createExedevRuntimeFixture()
      fixture.setRemoteState({ head, lineage: false })

      await expect(fixture.driver.adopt({
        resource: { provider: "exedev", resourceId: fixture.vm.identity.name },
        owner: fixture.owner,
      })).rejects.toMatchObject({ code: "EXEDEV_ADOPT_CHECKOUT" })

      const lineageProbe = fixture.calls.find((argv) => argv.includes("merge-base"))
      expect(lineageProbe).toEqual(expect.arrayContaining(["--is-ancestor", fixture.owner.baseSha, head]))
      expect(fixture.started).toBe(0)
      expect(fixture.created).toBe(0)
      expect(fixture.copied).toBe(0)
      expect(fixture.removed).toBe(0)
    }
  })

  it("adopts an exe.dev checkout whose HEAD is a valid descendant of the lifecycle base", async () => {
    const fixture = await createExedevRuntimeFixture()
    const head = "fedcba9876543210fedcba9876543210fedcba98"
    fixture.setRemoteState({ head, lineage: true })

    const session = await fixture.driver.adopt({
      resource: { provider: "exedev", resourceId: fixture.vm.identity.name },
      owner: fixture.owner,
    })

    const lineageProbe = fixture.calls.find((argv) => argv.includes("merge-base"))
    expect(lineageProbe).toEqual(expect.arrayContaining(["--is-ancestor", fixture.owner.baseSha, head]))
    expect(fixture.started).toBe(1)
    await session.abort?.()
    expect(fixture.removed).toBe(0)
  })

  it("aborts an adopted exe.dev runtime locally and is idempotent", async () => {
    const fixture = await createExedevRuntimeFixture()
    const session = await fixture.driver.adopt({
      resource: { provider: "exedev", resourceId: fixture.vm.identity.name },
      owner: fixture.owner,
    })
    if (!session.abort) throw new Error("adopted exe.dev session did not expose abort")

    await session.abort()
    await session.abort()

    expect(fixture.started).toBe(1)
    expect(fixture.terminated).toBe(1)
    expect(fixture.revoked).toBe(1)
    expect(fixture.removed).toBe(0)
    expect(fixture.calls.some((argv) => argv.includes("rm") && argv.includes("-rf"))).toBe(false)
  })

  it("rejects exe.dev preservation before staging when the adopted branch changes", async () => {
    const fixture = await createExedevRuntimeFixture()
    const session = await fixture.driver.adopt({
      resource: { provider: "exedev", resourceId: fixture.vm.identity.name },
      owner: fixture.owner,
    })
    fixture.setRemoteState({ branch: "opencode/foreign" })

    await expect(fixture.driver.sync(session)).rejects.toMatchObject({ code: "BRANCH_MISMATCH" })
    expect(fixture.calls.some((argv) => argv.includes("add"))).toBe(false)
    expect(fixture.calls.some((argv) => argv.includes("commit"))).toBe(false)
  })

  it("rejects exe.dev preservation before staging when the adopted history diverges", async () => {
    const fixture = await createExedevRuntimeFixture()
    const session = await fixture.driver.adopt({
      resource: { provider: "exedev", resourceId: fixture.vm.identity.name },
      owner: fixture.owner,
    })
    fixture.setRemoteState({ head: "fedcba9876543210fedcba9876543210fedcba98", lineage: false })

    await expect(fixture.driver.sync(session)).rejects.toMatchObject({ code: "REMOTE_LINEAGE_MISMATCH" })
    expect(fixture.calls.some((argv) => argv.includes("add"))).toBe(false)
    expect(fixture.calls.some((argv) => argv.includes("commit"))).toBe(false)
  })

  it("reconciles and recovers a persisted exe.dev runtime without recreating the VM", async () => {
    const fixture = await createExedevRuntimeFixture()
    const record: SandboxRecord = {
      ...makeRecord(),
      sessionId: fixture.owner.sessionId,
      workspaceId: fixture.owner.workspaceId,
      projectId: fixture.owner.projectId,
      provider: "exedev",
      providerState: fixture.metadata,
      vmName: fixture.vm.identity.name,
      vmIdentity: fixture.vm.identity,
      generation: fixture.owner.generation,
      directory: fixture.owner.directory,
      branch: fixture.owner.branch,
      baseSha: fixture.owner.baseSha,
      state: "remote",
    }
    const store = new FileStateStore(await temporaryDirectory())
    await store.write(record)
    const calls: string[] = []
    const controller = new LifecycleController({
      store,
      providerType: "exedev",
      runtimeDriver: fixture.driver,
      workspace: {
        async create() { throw new Error("must not create a workspace") },
        async warp(input) { calls.push(input.workspaceId ? "warp:remote" : "warp:local") },
        async startSync() { calls.push("sync:start") },
        async waitForSync() { calls.push("sync:connected") },
        async replaySession() { calls.push("replay") },
        async remove() { calls.push("workspace:remove") },
         async inspect() { return matchingWorkspace(record) },
      },
    })
    const capability = createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" })

    await controller.reconcile(record.projectId)
    expect(await store.get(record.sessionId)).toMatchObject({ state: "orphaned", lastError: { code: "SANDCASTLE_HANDLE" } })
    await expect(controller.handle({ operation: "inspect", force: false, capability })).resolves.toMatchObject({
      classification: "orphan",
      recommendedAction: { operation: "recover", reasonCode: "VERIFIED_ORPHAN" },
    })
    await expect(controller.handle({ operation: "recover", force: false, capability })).resolves.toMatchObject({
      ok: true,
      state: "remote",
      effectiveTarget: { kind: "remote", resourceId: fixture.vm.identity.name },
    })
    expect(calls).toEqual(["warp:remote", "sync:start", "sync:connected", "replay"])
    expect(fixture.created).toBe(0)
    expect(fixture.copied).toBe(0)

    await expect(controller.handle({ operation: "stop", force: false, capability })).resolves.toMatchObject({ state: "stop_pending" })
    await controller.onSessionIdle(record.sessionId)
    expect(await store.get(record.sessionId)).toMatchObject({ state: "detached" })
    expect(calls.slice(-2)).toEqual(["warp:local", "workspace:remove"])
    expect(fixture.removed).toBe(0)

    await expect(controller.handle({ operation: "delete", force: true, capability })).resolves.toMatchObject({ state: "deleted" })
    expect(fixture.removed).toBe(1)
  })

  it("deletes a verified exe.dev orphan directly through adoption and destruction", async () => {
    const fixture = await createExedevRuntimeFixture()
    const record: SandboxRecord = {
      ...makeRecord(),
      sessionId: fixture.owner.sessionId,
      workspaceId: fixture.owner.workspaceId,
      projectId: fixture.owner.projectId,
      provider: "exedev",
      providerState: fixture.metadata,
      vmName: fixture.vm.identity.name,
      vmIdentity: fixture.vm.identity,
      generation: fixture.owner.generation,
      directory: fixture.owner.directory,
      branch: fixture.owner.branch,
      baseSha: fixture.owner.baseSha,
      state: "orphaned",
    }
    const store = new FileStateStore(await temporaryDirectory())
    await store.write(record)
    const events: string[] = []
    const controller = createOrphanDeletionController(store, record, fixture.driver, events)
    const capability = createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" })

    await expect(controller.handle({ operation: "delete", force: false, capability })).resolves.toMatchObject({
      ok: true,
      state: "delete_pending",
    })
    await controller.onSessionIdle(record.sessionId)

    expect(await store.get(record.sessionId)).toMatchObject({
      state: "deleted",
      operation: { kind: "delete", phase: "deleted", providerDestroyed: true },
    })
    expect(events).toEqual([
      "inspect",
      "inspect",
      "adopt",
      "sync",
      "warp:local",
      "close",
      "workspace:remove",
      "inspect",
      "destroy",
    ])
    expect(fixture.created).toBe(0)
    expect(fixture.copied).toBe(0)
    expect(fixture.removed).toBe(1)
  })

  it("never mutates an exe.dev VM when adoption evidence is conflicting, stopped, unknown, or unreachable", async () => {
    const cases = [
      { foreign: true, code: "EXEDEV_ADOPT_CONFLICT" },
      { status: "stopped", code: "EXEDEV_ADOPT_UNSUPPORTED" },
      { status: "mystery", code: "EXEDEV_ADOPT_UNKNOWN" },
      { listError: true, code: "EXEDEV_ADOPT_UNKNOWN" },
    ] as const

    for (const testCase of cases) {
      const fixture = await createExedevRuntimeFixture(testCase)
      await expect(fixture.driver.adopt({
        resource: { provider: "exedev", resourceId: fixture.vm.identity.name },
        owner: fixture.owner,
      })).rejects.toMatchObject({ code: testCase.code })
      expect(fixture.created).toBe(0)
      expect(fixture.copied).toBe(0)
      expect(fixture.started).toBe(0)
      expect(fixture.removed).toBe(0)
      expect(fixture.calls.some((argv) => argv.some((part) => part.endsWith("/ssh")))).toBe(false)
    }
  })

  it("cleans partial exe.dev adoption locally when health fails without touching the VM", async () => {
    const fixture = await createExedevRuntimeFixture({ healthy: false })

    await expect(fixture.driver.adopt({
      resource: { provider: "exedev", resourceId: fixture.vm.identity.name },
      owner: fixture.owner,
    })).rejects.toMatchObject({ code: "REMOTE_HEALTH_TIMEOUT" })

    expect(fixture.started).toBe(1)
    expect(fixture.terminated).toBe(1)
    expect(fixture.revoked).toBe(1)
    expect(fixture.created).toBe(0)
    expect(fixture.copied).toBe(0)
    expect(fixture.removed).toBe(0)
    expect(fixture.calls.some((argv) => argv.includes("rm") && argv.includes("-rf"))).toBe(false)
  })

  it("creates a VM, checks out the local revision, starts the target, and preserves untracked files", async () => {
    const root = await temporaryDirectory()
    const baseSha = "0123456789012345678901234567890123456789"
    const commands: string[][] = []
    let failRemote = false
    let removedVm = false
    let removeCalls = 0
    let supervisorInput: { argv: string[]; stdin?: string | Uint8Array } | undefined
    let bootstrapInput = ""
    let launcherInput = ""
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
        if (typeof input.stdin === "string" && input.stdin.startsWith("set -eu\ncommand -v git")) bootstrapInput = input.stdin
        if (typeof input.stdin === "string" && input.stdin.includes('print("remote launcher:')) launcherInput = input.stdin
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
        tags: ["opencode-sandbox", `opencode-owner-${shortHash("prj_1:ses_1:wrk_1:1")}`],
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
        removeCalls++
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

    expect(bootstrapInput).toContain('export BUN_INSTALL="$HOME/.bun"')
    expect(bootstrapInput).toContain('curl -fsSL https://bun.sh/install | bash -s -- "bun-v1.3.14"')
    expect(bootstrapInput).not.toContain("npm")
    expect(bootstrapInput).not.toMatch(/\bnode(?:js)?\b/)
    expect(bootstrapInput).toContain('opencode="$BUN_INSTALL/bin/opencode"')
    expect(bootstrapInput).toContain('package="$BUN_INSTALL/install/global/node_modules/opencode-ai"')
    expect(bootstrapInput).toContain('--ignore-scripts')
    expect(bootstrapInput).toContain('"$bun" "$package/postinstall.mjs"')
    expect(bootstrapInput).toContain('OpenCode version mismatch: expected %s, got %s')
    expect(launcherInput).toContain('shutil.which("opencode", path=bun_directory)')
    expect(launcherInput).not.toContain('shutil.which("bun", path=bun_directory)')
    expect(launcherInput).toContain('os.execvpe(command, [command, "serve"')
    expect(launcherInput).not.toContain("os.execve(bun")
    expect(launcherInput).toContain("refusing to run OpenCode as root")
    expect(launcherInput).toContain("os.lstat")
    expect(launcherInput).toContain('socket_path != os.path.join(runtime, "c.sock")')
    expect(launcherInput).toContain('frame["directory"] != expected_directory')
    expect(launcherInput).toContain("read_control_socket(0, 0)")
    expect(launcherInput).toContain('"/usr/bin/sudo", "-n", "--", "/usr/bin/chown"')
    expect(launcherInput).toContain('f"{uid}:{gid}"')
    expect(launcherInput).toContain("read_control_socket(uid, gid)")
    expect(launcherInput).toContain("stat.S_ISLNK")
    expect(launcherInput).toContain("stat.S_IMODE")
    expect(commands.some((argv) => argv.includes("clone"))).toBe(true)
    expect(supervisorInput?.argv).toContain("127.0.0.1:4100:127.0.0.1:4096")
    expect(supervisorInput?.argv.join(" ")).not.toContain("control-token")
    expect(JSON.parse(String(supervisorInput?.stdin))).toMatchObject({ authContent: "{}", controlToken: "remote-token" })

    const foreignInfo = {
      ...info,
      extra: {
        ...info.extra,
        vmIdentity: { ...vm.identity, sshDest: "foreign.exe.xyz" },
      },
    }
    await expect(provisioner.release(foreignInfo)).rejects.toMatchObject({ code: "EXEDEV_OWNERSHIP_UNVERIFIED" })
    await expect(provisioner.destroy(foreignInfo)).rejects.toMatchObject({ code: "EXEDEV_OWNERSHIP_UNVERIFIED" })
    expect(removedVm).toBe(false)

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
    expect(removeCalls).toBe(0)
    await expect(provisioner.target(info)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" })
  })

  it("removes a VM created before bootstrap fails", async () => {
    const root = await temporaryDirectory()
    const baseSha = "0123456789012345678901234567890123456789"
    let removed = false
    const vm: VmInfo = {
      identity: { name: "oc-0123456789", sshDest: "vm.exe.xyz", tags: ["opencode-sandbox", `opencode-owner-${shortHash("prj_1:wrk_failed:wrk_failed:1")}`], comment: "opencode-test" },
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
        async list() { return [vm] },
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
      name: vm.identity.name,
      branch: "opencode/sandbox-failed",
      directory: remoteWorkspaceDirectory("wrk_failed"),
      projectID: "prj_1",
      extra: { tags: ["opencode-sandbox"], comment: "opencode-test" },
    }, { OPENCODE_AUTH_CONTENT: "{}" })).rejects.toMatchObject({ code: "REMOTE_COMMAND" })
    expect(removed).toBe(true)
  })

  it("removes a VM when identity verification fails immediately after creation", async () => {
    const root = await temporaryDirectory()
    const baseSha = "0123456789012345678901234567890123456789"
    const vm: VmInfo = {
      identity: {
        name: "oc-0123456789",
        sshDest: "vm.exe.xyz",
        tags: ["opencode-sandbox", `opencode-owner-${shortHash("prj_1:wrk_verify:wrk_verify:1")}`],
        comment: "opencode-test",
      },
      status: "running",
    }
    let listCalls = 0
    let removed: VmInfo["identity"] | undefined
    const runner: ProcessRunner = {
      async run(input) {
        if (input.argv[0] === "git" && input.argv.includes("remote")) return { exitCode: 0, signal: null, stdout: "https://github.com/owner/repo.git\n", stderr: "" }
        if (input.argv[0] === "git" && input.argv.includes("rev-parse")) return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
    }
    const provider = new ExedevProvider({
      config: parseConfig({}, { HOME: root }),
      control: {
        async create() { return vm },
        async copy() { return vm },
        async list() {
          listCalls++
          return listCalls === 1 ? [] : [vm]
        },
        async remove(identity) { removed = identity },
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
      id: "wrk_verify",
      type: "exedev",
      name: vm.identity.name,
      branch: "opencode/sandbox-verify",
      directory: remoteWorkspaceDirectory("wrk_verify"),
      projectID: "prj_1",
      extra: { tags: ["opencode-sandbox", `opencode-owner-${shortHash("prj_1:wrk_verify:wrk_verify:1")}`], comment: "opencode-test" },
    }, { OPENCODE_AUTH_CONTENT: "{}" })).rejects.toMatchObject({ code: "EXEDEV_OWNERSHIP_UNVERIFIED" })
    expect(listCalls).toBe(2)
    expect(removed).toEqual(vm.identity)
  })

  it("normalizes an incomplete create receipt from the confirmed inventory snapshot", async () => {
    const root = await temporaryDirectory()
    const baseSha = "0123456789012345678901234567890123456789"
    const ownerTag = `opencode-owner-${shortHash("prj_1:ses_incomplete:wrk_incomplete:1")}`
    const created: VmInfo = {
      identity: {
        name: "oc-0123456789",
        sshDest: "vm.exe.xyz",
        tags: [],
        comment: "new-comment",
        region: "new-region",
      },
      status: "running",
    }
    const observed: VmInfo = {
      ...created,
      identity: {
        ...created.identity,
        id: "opaque-provider-id",
        tags: ["opencode-sandbox", ownerTag],
        comment: "opencode-test",
        region: "iad",
      },
    }
    let removeCalls = 0
    const runner: ProcessRunner = {
      async run(input) {
        if (input.argv[0] === "git" && input.argv.includes("rev-parse")) {
          return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
        }
        if (input.argv.includes("test") && input.argv.includes("-L")) {
          return { exitCode: 1, signal: null, stdout: "", stderr: "" }
        }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
    }
    const provider = new ExedevProvider({
      config: parseConfig({}, { HOME: root }),
      control: {
        async create() { return created },
        async copy() { throw new Error("must not copy") },
        async list() { return [observed] },
        async remove() { removeCalls++ },
        async tag() {},
      },
      worktree: root,
      localControlSocket: join(root, "control.sock"),
      runner,
      ensureHostKey: async () => {},
      ensureVmHostKey: async () => {},
      reservePort: async () => 4100,
      controlTokenFor: async () => "token",
      deferActivation: true,
    })

    const info = {
      id: "wrk_incomplete",
      type: "exedev",
      name: created.identity.name,
      branch: "opencode/sandbox-incomplete",
      directory: remoteWorkspaceDirectory("wrk_incomplete"),
      projectID: "prj_1",
      extra: { sessionId: "ses_incomplete", generation: 1, baseSha, tags: ["opencode-sandbox"], comment: "opencode-test" },
    }

    await expect(provider.prepare(info, { OPENCODE_AUTH_CONTENT: "{}" })).resolves.toBeUndefined()
    expect(info.extra).toMatchObject({ vmName: observed.identity.name, vmIdentity: observed.identity })
    expect(removeCalls).toBe(0)
  })

  it("rejects a newly-created VM when its owner tag or receipt ID diverges", async () => {
    const root = await temporaryDirectory()
    const baseSha = "0123456789012345678901234567890123456789"
    const ownerTag = `opencode-owner-${shortHash("prj_1:ses_divergent:wrk_divergent:1")}`
    let variant: "owner" | "id" = "owner"
    const receipt: VmInfo = {
      identity: { name: "oc-0123456789", sshDest: "vm.exe.xyz", id: "provider-id", tags: [], comment: "new-comment", region: "new-region" },
      status: "running",
    }
    const provider = new ExedevProvider({
      config: parseConfig({}, { HOME: root }),
      control: {
        async create() { return receipt },
        async copy() { throw new Error("must not copy") },
        async list() {
          return [{
            identity: {
              ...receipt.identity,
              id: variant === "id" ? "foreign-id" : "provider-id",
              tags: variant === "owner" ? ["opencode-sandbox"] : ["opencode-sandbox", ownerTag],
              comment: "opencode-test",
              region: "iad",
            },
            status: "running",
          }]
        },
        async remove() { throw new Error("must not remove") },
        async tag() {},
      },
      worktree: root,
      localControlSocket: join(root, "control.sock"),
      runner: {
        async run(input) {
          if (input.argv[0] === "git" && input.argv.includes("remote")) {
            return { exitCode: 0, signal: null, stdout: "https://github.com/owner/repo.git\n", stderr: "" }
          }
          if (input.argv[0] === "git" && input.argv.includes("rev-parse")) {
            return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
          }
          return { exitCode: 0, signal: null, stdout: "", stderr: "" }
        },
      },
      ensureHostKey: async () => {},
      ensureVmHostKey: async () => {},
      reservePort: async () => 4100,
    })

    for (const current of ["owner", "id"] as const) {
      variant = current
      await expect(provider.prepare({
        id: "wrk_divergent",
        type: "exedev",
        name: receipt.identity.name,
        branch: "opencode/sandbox-divergent",
        directory: remoteWorkspaceDirectory("wrk_divergent"),
        projectID: "prj_1",
        extra: { sessionId: "ses_divergent", generation: 1, baseSha, tags: ["opencode-sandbox"], comment: "opencode-test" },
      }, { OPENCODE_AUTH_CONTENT: "{}" })).rejects.toMatchObject({ code: "EXEDEV_OWNERSHIP_UNVERIFIED" })
    }
  })

  for (const failure of ["tag", "comment"] as const) {
    it(`removes the exact VM when copy ${failure} fails`, async () => {
      const root = await temporaryDirectory()
      const baseSha = "0123456789012345678901234567890123456789"
      const vmName = "oc-0123456789"
      const created = { name: vmName, sshDest: "vm.exe.xyz", tags: [] as string[], comment: "" }
      const foreign = { name: "oc-foreign", sshDest: "foreign.exe.xyz", tags: ["foreign"], comment: "foreign" }
      let inventory = [foreign, created]
      let removedTarget: string | undefined
      const commands: string[][] = []
      const runner: ProcessRunner = {
        async run(input) {
          commands.push(input.argv)
          if (input.argv[0] === "git" && input.argv.includes("remote")) {
            return { exitCode: 0, signal: null, stdout: "https://github.com/owner/repo.git\n", stderr: "" }
          }
          if (input.argv[0] === "git" && input.argv.includes("rev-parse")) {
            return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
          }
          if (input.argv.includes("cp")) return { exitCode: 0, signal: null, stdout: JSON.stringify(created), stderr: "" }
          if (input.argv.includes("tag")) {
            if (failure === "tag") return { exitCode: 1, signal: null, stdout: "", stderr: "tag failed" }
            const tags = input.argv.slice(input.argv.indexOf("tag") + 2, -1)
            inventory = inventory.map((vm) => vm.name === vmName ? { ...vm, tags } : vm)
            return { exitCode: 0, signal: null, stdout: "{}", stderr: "" }
          }
          if (input.argv.includes("comment")) {
            if (failure === "comment") return { exitCode: 1, signal: null, stdout: "", stderr: "comment failed" }
            return { exitCode: 0, signal: null, stdout: "{}", stderr: "" }
          }
          if (input.argv.includes("ls")) return { exitCode: 0, signal: null, stdout: JSON.stringify(inventory), stderr: "" }
          if (input.argv.includes("rm")) {
            removedTarget = input.argv[input.argv.indexOf("rm") + 1]
            return { exitCode: 0, signal: null, stdout: "{}", stderr: "" }
          }
          return { exitCode: 0, signal: null, stdout: "", stderr: "" }
        },
      }
      const provider = new ExedevProvider({
        config: parseConfig({ baseVm: "base-vm" }, { HOME: root }),
        control: new SshExeControl({ lobby: "exe.dev", knownHostsFile: join(root, "known_hosts"), runner }),
        worktree: root,
        localControlSocket: join(root, "control.sock"),
        runner,
        ensureHostKey: async () => {},
        ensureVmHostKey: async () => {},
        reservePort: async () => 4100,
      })

      await expect(provider.prepare({
        id: "wrk_copy_failure",
        type: "exedev",
        name: vmName,
        branch: "opencode/sandbox-copy-failure",
        directory: remoteWorkspaceDirectory("wrk_copy_failure"),
        projectID: "prj_1",
        extra: { sessionId: "ses_copy_failure", generation: 1, baseSha, tags: ["opencode-sandbox"], comment: "opencode-test" },
      }, { OPENCODE_AUTH_CONTENT: "{}" })).rejects.toMatchObject({ code: "EXEDEV_COMMAND" })

      expect(removedTarget).toBe(vmName)
      expect(commands.filter((argv) => argv.includes("rm"))).toHaveLength(1)
      expect(commands.some((argv) => argv.includes("comment"))).toBe(failure === "comment")
    })
  }

  it("exposes Exe.dev as an isolated Sandcastle provider with streaming exec and failure evidence", async () => {
    const root = await temporaryDirectory()
    const repository = await temporaryDirectory()
    await runGit(repository, ["init", "-q"])
    await runGit(repository, ["config", "user.email", "test@example.invalid"])
    await runGit(repository, ["config", "user.name", "Test"])
    await writeFile(join(repository, "tracked.txt"), "base\n")
    await runGit(repository, ["add", "."])
    await runGit(repository, ["commit", "-q", "-m", "initial"])
    await runGit(repository, ["remote", "add", "origin", repository])
    const branch = "opencode/sandbox-adapter"
    const projectId = "project-host"
    const authContent = '{"apiKey":"activation-auth-secret"}'
    const head = await nodeProcessRunner.run({ argv: ["git", "-C", repository, "rev-parse", "HEAD"], cwd: repository })
    const baseSha = head.stdout.trim()
    const checkoutDirectory = remoteWorkspaceDirectory("wrk_adapter")
    const identityPath = `${checkoutDirectory}/.git/opencode`
    const vm: VmInfo = {
      identity: { name: `oc-${shortHash("wrk_adapter")}`, sshDest: "vm.exe.xyz", tags: ["opencode-sandbox", `opencode-owner-${shortHash(`${projectId}:ses_adapter:wrk_adapter:1`)}`], comment: "opencode-test" },
      status: "running",
    }
    let removed = 0
    let terminated = 0
    let provisionedVm = vm
    const calls: string[][] = []
    const startup: string[] = []
    const lifecycle: string[] = []
    let checkoutMode = 0o700
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
        calls.push(input.argv)
        if (input.argv.includes("mkdir") && input.argv.includes(checkoutDirectory)) lifecycle.push("mkdir-checkout")
        if (input.argv.some((value) => value.includes("mktemp -d -t sandcastle-"))) lifecycle.push("sandcastle-mktemp")
        if (input.argv.includes(identityPath)) {
          startup.push("project-identity")
          expect(input.stdin).toBe(projectId)
        }
        const command = input.argv.at(-1) ?? ""
        if (command.includes(`rm -rf "${checkoutDirectory}" && mv "${checkoutDirectory}_clone" "${checkoutDirectory}"`)) {
          checkoutMode = 0o755
          startup.push("sandcastle-swap")
        }
        if (input.argv.some((value) => value.includes("os.fchmod")) && input.argv.includes(checkoutDirectory)) {
          expect(checkoutMode).toBe(0o755)
          checkoutMode = 0o700
          startup.push("checkout-private")
        }
        if (input.argv[0] === "git" && input.argv.includes("remote")) {
          return { exitCode: 0, signal: null, stdout: `file://${repository}\n`, stderr: "" }
        }
        if (input.argv[0] === "git" && input.argv.includes("rev-parse")) {
          return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
        }
        if (input.argv[0]?.endsWith("/ssh")) {
          const command = input.argv.at(-1) ?? ""
          if (input.argv.includes("test") && (input.argv.includes("-d") || input.argv.includes("-L"))) return { exitCode: 1, signal: null, stdout: "", stderr: "" }
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
        projectId,
        workspaceId: "wrk_adapter",
        generation: 1,
        branch,
        baseSha,
        context: { sessionId: "ses_adapter", projectId, directory: repository, worktree: repository },
      },
      config: parseConfig({}, { HOME: root }),
      control: {
        async create(input) {
          provisionedVm = { ...vm, identity: { ...vm.identity, tags: [...input.tags], comment: input.comment } }
          return provisionedVm
        },
        async copy() { return provisionedVm },
        async list() { return [provisionedVm] },
        async remove() { removed++ },
        async tag() {},
      },
      worktree: repository,
      localControlSocket: join(root, "control.sock"),
      runner,
      supervisor: { async start(input) { expect(checkoutMode).toBe(0o700); startup.push("server-start"); supervisorInput = input; return process } },
      reservePort: async () => 4100,
      ensureHostKey: async () => {},
      ensureVmHostKey: async () => {},
      controlTokenFor: async () => "remote-token",
      authContent,
      fetcher: (async () => new Response(JSON.stringify({ healthy: true, version: "1.18.23" }), { status: 200 })) as unknown as typeof fetch,
    })
    const worktree = await createWorktree({
      cwd: repository,
      branchStrategy: { type: "branch", branch, baseBranch: baseSha },
    })

    let sandbox
    try {
      sandbox = await worktree.createSandbox({ sandbox: adapter.provider })
      expect(lifecycle).toEqual(["mkdir-checkout", "sandcastle-mktemp"])
      const metadata = adapter.recoveryMetadata?.() ?? {}
      expect(projectId).not.toBe(baseSha)
      expect(metadata).toMatchObject({ provider: "exedev", projectId, sessionId: "ses_adapter", workspaceId: "wrk_adapter", generation: 1, branch, baseSha })
      expect(metadata.remoteWorktreePath).toBe(remoteWorkspaceDirectory("wrk_adapter"))
      expect(metadata.remoteDirectory).toMatch(/^\/tmp\/oe-/)
      expect(metadata.remoteWorktreePath).not.toBe(metadata.remoteDirectory)
      expect(calls.some((argv) => argv[0] === "git" && argv.includes("remote") && argv.includes("get-url"))).toBe(false)
      expect(calls.some((argv) => argv.includes("clone") && argv.includes("--no-checkout"))).toBe(false)
      expect(supervisorInput).toBeUndefined()
      await adapter.applyCapture({ sandbox, capture: { baseSha, patch: "", untracked: [] } })
      expect(startup).toEqual(["sandcastle-swap", "checkout-private", "project-identity", "server-start"])
      await expect(adapter.target()).resolves.toMatchObject({ type: "remote", url: "http://127.0.0.1:4100" })
      expect(supervisorInput?.argv).toContain("-R")
      expect(supervisorInput?.argv.some((value) => value.endsWith(`:${join(root, "control.sock")}`))).toBe(true)
      expect(JSON.parse(String(supervisorInput?.stdin))).toMatchObject({ authContent, controlToken: "remote-token" })
      const lines: string[] = []
      await expect(sandbox.exec("printf 'first\\nsecond\\n'", { onLine: (line) => lines.push(line) })).resolves.toMatchObject({
        exitCode: 0,
        stdout: "first\nsecond\n",
      })
      expect(lines).toEqual(["first", "second"])

      const frame = JSON.parse(String(supervisorInput?.stdin)) as { serverPassword: string; controlToken: string }
      const stdout = `supervisor stdout password=${frame.serverPassword} controlToken=${frame.controlToken} auth=${authContent} ${"o".repeat(4_000)}`
      const stderr = `supervisor stderr password=${frame.serverPassword} controlToken=${frame.controlToken} auth=${authContent} ${"e".repeat(4_000)}`
      finishProcess({ exitCode: 17, signal: null, stdout, stderr })
      await new Promise((resolve) => setTimeout(resolve, 0))

      let failure: unknown
      try {
        await sandbox.exec("true")
      } catch (error) {
        failure = error
      }
      if (!(failure instanceof SandboxError)) throw new Error("expected a supervisor failure")
      expect(failure.message).toContain("SSH supervisor exited")
      expect(failure.message).toContain("exit code 17")
      expect(failure.message).toContain("signal null")
      expect(failure.message).toContain("supervisor stdout")
      expect(failure.message).toContain("supervisor stderr")
      expect(failure.message).toContain("[REDACTED]")
      for (const secret of [frame.serverPassword, frame.controlToken, authContent]) {
        expect(failure.message).not.toContain(secret)
      }
      expect(failure.message.length).toBeLessThan(5_000)

      expect(sandbox.worktreePath).toBe(worktree.worktreePath)
      const aliasCommand = calls.find((argv) => argv.includes("sudo") && argv.includes("-n") && argv.at(-1)?.includes("ln -s --"))
      expect(aliasCommand).toEqual(expect.arrayContaining(["sudo", "-n", "--", "sh", "-lc"]))
      expect(aliasCommand?.at(-1)).toContain(`alias_path=`)
      expect(aliasCommand?.at(-1)).toContain(repository)
      expect(aliasCommand?.at(-1)).toContain(remoteWorkspaceDirectory("wrk_adapter"))
      expect(supervisorInput?.argv).not.toContain("sudo")
    } finally {
      await sandbox?.close()
      await sandbox?.close()
      await worktree.close()
    }

    expect(terminated).toBe(1)
    expect(removed).toBe(1)
  })

  it("syncs exe.dev adapter output through the safe host delta", async () => {
    const repository = await temporaryDirectory()
    await runGit(repository, ["init", "-q"])
    await runGit(repository, ["config", "user.email", "test@example.invalid"])
    await runGit(repository, ["config", "user.name", "Test"])
    await writeFile(join(repository, "tracked.txt"), "base\n")
    await runGit(repository, ["add", "."])
    await runGit(repository, ["commit", "-q", "-m", "initial"])
    const context = { sessionId: "ses_exedev_sync", projectId: "prj_1", directory: repository, worktree: repository }
    const capture = await captureWorkingTree(context)
    const branch = "opencode/exedev-sync"
    const worktree = await createWorktree({
      cwd: repository,
      branchStrategy: { type: "branch", branch, baseBranch: capture.baseSha },
    })
    const provider = {
      name: "exe.dev",
      async syncIn() {},
      async activate() {},
      async target() { return { type: "remote" as const, url: "http://127.0.0.1:4100" } },
      async close() {},
    } as unknown as ExedevProvider
    const adapter = createExedevSandcastleAdapter({
      provider,
      config: parseConfig({}, { HOME: repository }),
      control: {} as ExeControl,
      localControlSocket: join(repository, "control.sock"),
      worktree: repository,
      input: {
        sessionId: context.sessionId,
        projectId: context.projectId,
        workspaceId: "wrk_exedev_sync",
        generation: 1,
        branch,
        baseSha: capture.baseSha,
        context,
      },
    })
    let remoteTree = ""
    const sandbox = {
      async exec(command: string) {
        expect(command).toBe("git rev-parse HEAD^{tree}")
        return { exitCode: 0, stdout: `${remoteTree}\n`, stderr: "" }
      },
    } as unknown as Sandbox
    const syncBack = adapter.syncBackWorkingTree
    if (!syncBack) throw new Error("exe.dev adapter did not expose sync-back")
    const readTree = async () => {
      const result = await nodeProcessRunner.run({
        argv: ["git", "-C", worktree.worktreePath, "rev-parse", "HEAD^{tree}"],
        cwd: worktree.worktreePath,
      })
      if (result.exitCode !== 0) throw new Error(result.stderr || "could not read remote tree")
      return result.stdout.trim()
    }

    try {
      await adapter.applyCapture({ sandbox, capture })
      await writeFile(join(worktree.worktreePath, "remote.txt"), "first\n")
      await runGit(worktree.worktreePath, ["add", "."])
      await runGit(worktree.worktreePath, ["commit", "-q", "-m", "remote-first"])
      remoteTree = await readTree()
      const head = await nodeProcessRunner.run({ argv: ["git", "-C", repository, "rev-parse", "HEAD"], cwd: repository })
      const index = await nodeProcessRunner.run({ argv: ["git", "-C", repository, "ls-files", "--stage"], cwd: repository })

      await syncBack({ sandbox, worktreePath: worktree.worktreePath })

      expect(await readFile(join(repository, "remote.txt"), "utf8")).toBe("first\n")
      expect((await nodeProcessRunner.run({ argv: ["git", "-C", repository, "rev-parse", "HEAD"], cwd: repository })).stdout.trim()).toBe(head.stdout.trim())
      expect((await nodeProcessRunner.run({ argv: ["git", "-C", repository, "ls-files", "--stage"], cwd: repository })).stdout).toBe(index.stdout)

      await writeFile(join(worktree.worktreePath, "remote.txt"), "second\n")
      await runGit(worktree.worktreePath, ["add", "."])
      await runGit(worktree.worktreePath, ["commit", "-q", "-m", "remote-second"])
      remoteTree = await readTree()
      await syncBack({ sandbox, worktreePath: worktree.worktreePath })

      expect(await readFile(join(repository, "remote.txt"), "utf8")).toBe("second\n")
    } finally {
      await worktree.close()
    }
  })
})

describe("Docker Sandbox provider", () => {
  it("syncs SBX adapter output through the safe host delta", async () => {
    const repository = await temporaryDirectory()
    await runGit(repository, ["init", "-q"])
    await runGit(repository, ["config", "user.email", "test@example.invalid"])
    await runGit(repository, ["config", "user.name", "Test"])
    await writeFile(join(repository, "tracked.txt"), "base\n")
    await runGit(repository, ["add", "."])
    await runGit(repository, ["commit", "-q", "-m", "initial"])
    const context = { sessionId: "ses_sbx_sync", projectId: "prj_1", directory: repository, worktree: repository }
    const capture = await captureWorkingTree(context)
    const branch = "opencode/sbx-sync"
    const worktree = await createWorktree({
      cwd: repository,
      branchStrategy: { type: "branch", branch, baseBranch: capture.baseSha },
    })
    const provider = {
      name: "Docker Sandbox",
      async syncIn() {},
      async activate() {},
      async target() { return { type: "remote" as const, url: "http://127.0.0.1:4100" } },
      async close() {},
    } as unknown as SbxProvider
    const adapter = createSbxSandcastleAdapter({
      provider,
      worktree: repository,
      input: {
        sessionId: context.sessionId,
        projectId: context.projectId,
        workspaceId: "wrk_sbx_sync",
        generation: 1,
        branch,
        baseSha: capture.baseSha,
        context,
      },
    })
    let remoteTree = ""
    const sandbox = {
      async exec(command: string) {
        expect(command).toBe("git rev-parse HEAD^{tree}")
        return { exitCode: 0, stdout: `${remoteTree}\n`, stderr: "" }
      },
    } as unknown as Sandbox
    const syncBack = adapter.syncBackWorkingTree
    if (!syncBack) throw new Error("SBX adapter did not expose sync-back")
    const readTree = async () => {
      const result = await nodeProcessRunner.run({
        argv: ["git", "-C", worktree.worktreePath, "rev-parse", "HEAD^{tree}"],
        cwd: worktree.worktreePath,
      })
      if (result.exitCode !== 0) throw new Error(result.stderr || "could not read remote tree")
      return result.stdout.trim()
    }

    try {
      await adapter.applyCapture({ sandbox, capture })
      await writeFile(join(worktree.worktreePath, "remote.txt"), "first\n")
      await runGit(worktree.worktreePath, ["add", "."])
      await runGit(worktree.worktreePath, ["commit", "-q", "-m", "remote-first"])
      remoteTree = await readTree()
      const head = await nodeProcessRunner.run({ argv: ["git", "-C", repository, "rev-parse", "HEAD"], cwd: repository })
      const index = await nodeProcessRunner.run({ argv: ["git", "-C", repository, "ls-files", "--stage"], cwd: repository })

      await syncBack({ sandbox, worktreePath: worktree.worktreePath })

      expect(await readFile(join(repository, "remote.txt"), "utf8")).toBe("first\n")
      expect((await nodeProcessRunner.run({ argv: ["git", "-C", repository, "rev-parse", "HEAD"], cwd: repository })).stdout.trim()).toBe(head.stdout.trim())
      expect((await nodeProcessRunner.run({ argv: ["git", "-C", repository, "ls-files", "--stage"], cwd: repository })).stdout).toBe(index.stdout)

      await writeFile(join(worktree.worktreePath, "remote.txt"), "second\n")
      await runGit(worktree.worktreePath, ["add", "."])
      await runGit(worktree.worktreePath, ["commit", "-q", "-m", "remote-second"])
      remoteTree = await readTree()
      await syncBack({ sandbox, worktreePath: worktree.worktreePath })

      expect(await readFile(join(repository, "remote.txt"), "utf8")).toBe("second\n")
    } finally {
      await worktree.close()
    }
  })

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
    const sandboxWorktree = clone
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
      expect(sandbox.worktreePath).toBe(worktree.worktreePath)
      expect(sandbox.worktreePath).not.toBe(sandboxWorktree)
      expect(adapter.recoveryMetadata?.()).toMatchObject({ remoteWorktreePath: sandboxWorktree })
      const managedAuth = inputs.find(({ argv }) => argv.includes("secret") && argv.includes("set"))
      expect(managedAuth?.stdin).toBe("test-access\n")
      expect(calls.some((call) => call.includes("npm install --global opencode-ai@1.18.25"))).toBe(true)
      const swapCommand = inputs.map(({ argv }) => argv.at(-1)).find((command) => command?.includes(`for entry in "${sandboxWorktree}"/*`))
      expect(swapCommand).toContain(`cd -- ${sandboxWorktree} &&`)
      expect(swapCommand).toContain(`"${sandboxWorktree}_clone"`)
      expect(swapCommand).not.toContain(`rm -rf "${sandboxWorktree}" && mv "${sandboxWorktree}_clone" "${sandboxWorktree}"`)
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

  it("swaps the initial SBX clone in place and preserves it on failure", async () => {
    const sandboxRoot = await temporaryDirectory()
    const worktreePath = join(sandboxRoot, "project")
    const clonePath = `${worktreePath}_clone`
    const externalPath = join(sandboxRoot, "external.txt")
    const baseSha = "0123456789012345678901234567890123456789"
    const branch = "opencode/sbx-swap"
    await mkdir(worktreePath)
    await mkdir(clonePath)
    await writeFile(join(worktreePath, "stale.txt"), "stale\n")
    await writeFile(join(clonePath, "prepared.txt"), "prepared\n")
    await writeFile(externalPath, "keep\n")

    const ownership = fakeSbxOwnership()
    const runner: ProcessRunner = {
      async run(input) {
        if (input.argv[0] !== "sbx") return { exitCode: 0, signal: null, stdout: "", stderr: "" }
        if (input.argv.includes("--show-toplevel")) return { exitCode: 0, signal: null, stdout: `${worktreePath}\n`, stderr: "" }
        if (input.argv.includes("opencode") && input.argv.includes("--version")) return { exitCode: 0, signal: null, stdout: "1.18.23\n", stderr: "" }
        if (input.argv.includes("symbolic-ref")) return { exitCode: 0, signal: null, stdout: `${branch}\n`, stderr: "" }
        if (input.argv.some((value) => value.includes("rev-parse"))) return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
        if (input.argv[3] === "sh" && input.argv[4] === "-lc") {
          return nodeProcessRunner.run({ argv: ["/bin/sh", "-lc", input.argv[5] ?? ""], cwd: worktreePath, onLine: input.onLine })
        }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
    }
    const provider = new SbxProvider({
      ...ownership,
      worktree: sandboxRoot,
      deferActivation: true,
      runner,
      reservePort: async () => 4101,
      fetcher: (async () => new Response(JSON.stringify({ healthy: true }), { status: 200 })) as unknown as typeof fetch,
    })
    const info = {
      id: "wrk_sbx_swap",
      type: "sbx",
      name: "workspace",
      branch,
      directory: sandboxRoot,
      projectID: "prj_1",
      extra: { baseSha, sessionId: "ses_sbx_swap", generation: 1 },
    }
    await provider.prepare(info, { OPENCODE_AUTH_CONTENT: "{}" })
    const handle = provider.createIsolatedHandle(info)
    const swap = `rm -rf "${worktreePath}" && mv "${clonePath}" "${worktreePath}"`
    const inode = (await stat(worktreePath)).ino

    try {
      await chmod(worktreePath, 0o500)
      const failedSwap = await handle.exec(swap)
      expect(failedSwap.exitCode).not.toBe(0)
      expect((await stat(clonePath)).isDirectory()).toBe(true)

      await chmod(worktreePath, 0o700)
      await expect(handle.exec(swap)).resolves.toMatchObject({ exitCode: 0 })
      expect((await stat(worktreePath)).ino).toBe(inode)
      expect(await readFile(join(worktreePath, "prepared.txt"), "utf8")).toBe("prepared\n")
      await expect(stat(join(worktreePath, "stale.txt"))).rejects.toThrow()
      expect(await readFile(externalPath, "utf8")).toBe("keep\n")
      await expect(stat(clonePath)).rejects.toThrow()

      await expect(handle.exec("printf normal")).resolves.toMatchObject({ exitCode: 0, stdout: "normal" })
    } finally {
      await chmod(worktreePath, 0o700)
      await handle.close()
    }
  })

  it("uses a private clone, streams the capture, and exports an isolated branch", async () => {
    const root = await temporaryDirectory()
    const baseSha = "0123456789012345678901234567890123456789"
    const branch = "opencode/sbx-0123456789"
    const clone = "/workspace/project"
    const commands: Array<{ argv: string[]; stdin?: string | Uint8Array }> = []
    let failStop = false
    const runner: ProcessRunner = {
      async run(input) {
        commands.push({ argv: input.argv, stdin: input.stdin })
        if (failStop && input.argv[0] === "sbx" && input.argv[1] === "stop") {
          return { exitCode: 1, signal: null, stdout: "", stderr: "already stopped" }
        }
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
    failStop = true
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

  it("rejects unsafe SBX clone roots before checking out", async () => {
    const directories = [
      "/",
      "//",
      "/.",
      "/run",
      "/run/sandbox",
      "/run/sandbox/source",
      "/run/sandbox/source/child",
      "/tmp",
      "/tmp/oe-runtime",
      "/tmp/opencode-sandbox-owner",
    ]

    for (const directory of directories) {
      const calls: string[][] = []
      const provider = new SbxProvider({
        worktree: "/tmp/project",
        runner: {
          async run(input) {
            calls.push(input.argv)
            return { exitCode: 0, signal: null, stdout: `${directory}\n`, stderr: "" }
          },
        },
      })
      const cloneDirectory = (provider as unknown as { cloneDirectory(sandbox: string): Promise<string> }).cloneDirectory.bind(provider)

      await expect(cloneDirectory("oc-sbx-test")).rejects.toMatchObject({
        code: "SBX_CLONE_DIRECTORY",
      })
      expect(calls).toHaveLength(1)
    }
  })

  it("uses the writable SBX clone root and rejects readonly clones", async () => {
    const clone = "/workspace/project"
    let writable = true
    const calls: string[][] = []
    const provider = new SbxProvider({
      worktree: "/tmp/project",
      runner: {
        async run(input) {
          calls.push(input.argv)
          if (input.argv.includes("--show-toplevel")) return { exitCode: 0, signal: null, stdout: `${clone}\n`, stderr: "" }
          return { exitCode: writable ? 0 : 1, signal: null, stdout: "", stderr: "" }
        },
      },
    })
    const cloneDirectory = (provider as unknown as { cloneDirectory(sandbox: string): Promise<string> }).cloneDirectory.bind(provider)

    await expect(cloneDirectory("oc-sbx-test")).resolves.toBe(clone)
    writable = false
    await expect(cloneDirectory("oc-sbx-test")).rejects.toMatchObject({ code: "SBX_CLONE_READONLY" })
    expect(calls.filter((argv) => argv.includes("--show-toplevel"))).toHaveLength(2)
    expect(calls.filter((argv) => argv.includes("test"))).toHaveLength(2)
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

  it("preserves bounded create failure evidence when ownership verification fails", async () => {
    const baseSha = "0123456789012345678901234567890123456789"
    const createStdout = `create stdout token=stdout-secret ${"o".repeat(8_000)}`
    const createStderr = `create stderr Authorization: Bearer stderr-secret ${"e".repeat(8_000)}`
    const commands: string[][] = []
    const provider = new SbxProvider({
      ...fakeSbxOwnership(),
      worktree: await temporaryDirectory(),
      reservePort: async () => 4101,
      runner: {
        async run(input) {
          commands.push(input.argv)
          if (input.argv[0] === "sbx" && input.argv[1] === "create") {
            return { exitCode: 17, signal: null, stdout: createStdout, stderr: createStderr }
          }
          return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
        },
      },
    })

    let failure: unknown
    try {
      await provider.prepare({
        id: "wrk_sbx_create_failure",
        type: "sbx",
        name: "workspace",
        branch: "opencode/sbx-create-failure",
        directory: "/tmp/project",
        projectID: "prj_1",
        extra: { baseSha, sessionId: "ses_create_failure", generation: 1 },
      }, { OPENCODE_AUTH_CONTENT: "{}" })
    } catch (error) {
      failure = error
    }

    if (!(failure instanceof SandboxError)) throw new Error("expected a SandboxError")
    expect(failure.code).toBe("SBX_OWNERSHIP_UNVERIFIED")
    expect(failure.message).toContain("sbx create exit code 17")
    expect(failure.message).toContain("create stderr")
    expect(failure.message).toContain("[REDACTED]")
    expect(failure.message).not.toContain("stderr-secret")
    expect(failure.message.length).toBeLessThanOrEqual("SBX resource ownership could not be verified; sbx create exit code 17: ".length + 2_048)
    const create = failure.details?.create
    if (!create || typeof create !== "object") throw new Error("create failure evidence is unavailable")
    const createEvidence = create as { exitCode: unknown; stdout: unknown; stderr: unknown }
    expect(createEvidence.exitCode).toBe(17)
    expect(String(createEvidence.stdout)).toContain("create stdout")
    expect(String(createEvidence.stderr)).toContain("create stderr")
    expect(JSON.stringify(create)).not.toContain("stdout-secret")
    expect(JSON.stringify(create)).not.toContain("stderr-secret")
    expect(String(createEvidence.stdout)).toContain("token=[REDACTED]")
    expect(String(createEvidence.stderr)).toContain("[REDACTED]")
    expect(String(createEvidence.stdout).length).toBeLessThan(createStdout.length)
    expect(String(createEvidence.stderr).length).toBeLessThan(createStderr.length)
    expect(commands).toHaveLength(1)
  })

  it("observes SBX presence, health, and durable ownership without starting it", async () => {
    const ownershipId = "x".repeat(43)
    const sandbox = "oc-sbx-observed"
    const owner = {
      provider: "sbx",
      ownershipId,
      sessionId: "ses_observed",
      generation: 2,
      workspaceId: "wrk_observed",
      projectId: "prj_observed",
    }
    let sandboxes: unknown[] = [{ name: sandbox, status: "running" }]
    let marker: unknown = owner
    const calls: string[][] = []
    const provider = new SbxProvider({
      worktree: await temporaryDirectory(),
      runner: {
        async run(input) {
          calls.push(input.argv)
          if (input.argv[1] === "ls") {
            expect(input.timeoutMs).toBe(5_000)
            return { exitCode: 0, signal: null, stdout: JSON.stringify({ sandboxes }), stderr: "" }
          }
          if (input.argv[1] === "cp") {
            expect(input.timeoutMs).toBe(5_000)
            await writeFile(input.argv.at(-1)!, JSON.stringify(marker))
            return { exitCode: 0, signal: null, stdout: "", stderr: "" }
          }
          throw new Error(`unexpected command: ${input.argv.join(" ")}`)
        },
      },
    })
    const info = {
      id: owner.workspaceId,
      type: "sbx",
      name: sandbox,
      branch: "opencode/sbx-observed",
      directory: "/tmp/project",
      projectID: owner.projectId,
      extra: { providerState: { ...owner, sandbox } },
    }

    await expect(provider.inspect(info)).resolves.toEqual({
      resourceId: sandbox,
      resource: "present",
      ownership: "verified",
      health: "healthy",
      evidence: [`sbx inventory:${sandbox}`, `sbx owner marker:${sandbox}`],
    })
    sandboxes = [{ name: sandbox, status: "running" }, { name: sandbox, status: "stopped" }]
    await expect(provider.inspect(info)).resolves.toMatchObject({ resource: "present", ownership: "conflict", health: "unknown" })
    marker = { ...owner, sessionId: "ses_other" }
    await expect(provider.inspect(info)).resolves.toMatchObject({ resource: "present", ownership: "conflict" })
    sandboxes = []
    await expect(provider.inspect(info)).resolves.toMatchObject({ resource: "absent", ownership: "unknown", health: "unknown" })
    sandboxes = [{ status: "running" }]
    await expect(provider.inspect(info)).rejects.toMatchObject({ code: "SBX_INVENTORY_INVALID" })
    expect(calls.some((argv) => argv.includes("exec"))).toBe(false)
  })

  it("reconciles and recovers a persisted SBX runtime without recreating the sandbox", async () => {
    const fixture = await createSbxRuntimeFixture()
    const store = new FileStateStore(await temporaryDirectory())
    const record: SandboxRecord = {
      ...makeRecord(),
      sessionId: fixture.owner.sessionId,
      workspaceId: fixture.owner.workspaceId,
      projectId: fixture.owner.projectId,
      provider: "sbx",
      providerState: {
        provider: "sbx",
        ownershipId: fixture.owner.ownershipId,
        sessionId: fixture.owner.sessionId,
        generation: fixture.owner.generation,
        workspaceId: fixture.owner.workspaceId,
        projectId: fixture.owner.projectId,
         sandbox: fixture.sandbox,
         hostPort: fixture.hostPort,
         remoteWorktreePath: fixture.remoteDirectory,
         branch: fixture.owner.branch,
         baseSha: fixture.owner.baseSha,
      },
      generation: fixture.owner.generation,
      directory: fixture.owner.directory,
      branch: fixture.owner.branch,
      baseSha: fixture.owner.baseSha,
      state: "remote",
    }
    await store.write(record)
    const calls: string[] = []
    const controller = new LifecycleController({
      store,
      providerType: "sbx",
      runtimeDriver: fixture.driver,
      workspace: {
        async create() { throw new Error("must not create a workspace") },
        async warp(input) { calls.push(input.workspaceId ? "warp:remote" : "warp:local") },
        async startSync() { calls.push("sync:start") },
        async waitForSync() { calls.push("sync:connected") },
        async replaySession() { calls.push("replay") },
        async remove() { calls.push("workspace:remove") },
        async inspect() { return matchingWorkspace(record, { directory: fixture.remoteDirectory }) },
      },
    })
    const capability = createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" })

    await controller.reconcile(record.projectId)
    expect(await store.get(record.sessionId)).toMatchObject({ state: "orphaned", lastError: { code: "SANDCASTLE_HANDLE" } })
    await expect(controller.handle({ operation: "inspect", force: false, capability })).resolves.toMatchObject({
      classification: "orphan",
      recommendedAction: { operation: "recover", reasonCode: "VERIFIED_ORPHAN" },
    })
    await expect(controller.handle({ operation: "recover", force: false, capability })).resolves.toMatchObject({
      ok: true,
      state: "remote",
      effectiveTarget: { kind: "remote", resourceId: fixture.sandbox },
    })
    expect(await controller.targetFor(record.sessionId)).toEqual({
      type: "remote",
      url: `http://127.0.0.1:${fixture.hostPort}`,
      headers: { Authorization: expect.any(String) },
    })
    expect(calls).toEqual(["warp:remote", "sync:start", "sync:connected", "replay"])

    await expect(controller.handle({ operation: "stop", force: false, capability })).resolves.toMatchObject({ state: "stop_pending" })
    await controller.onSessionIdle(record.sessionId)
    expect(await store.get(record.sessionId)).toMatchObject({ state: "detached" })
    expect(calls.slice(-2)).toEqual(["warp:local", "workspace:remove"])
    expect(fixture.calls.some((argv) => argv.includes("create"))).toBe(false)
    expect(fixture.calls.some((argv) => argv.includes("rm"))).toBe(false)
    expect(fixture.calls.some((argv) => argv.includes("exec"))).toBe(true)
    expect(fixture.calls.some((argv) => argv.includes(fixture.remoteDirectory))).toBe(true)
    expect(fixture.started).toBe(1)
    expect(fixture.terminated).toBe(1)

    await expect(controller.handle({ operation: "delete", force: true, capability })).resolves.toMatchObject({ state: "deleted" })
    expect(fixture.calls.filter((argv) => argv.includes("rm") && argv.includes("--force"))).toHaveLength(1)
  })

  it("deletes a verified SBX orphan directly through adoption and destruction", async () => {
    const fixture = await createSbxRuntimeFixture()
    const record: SandboxRecord = {
      ...makeRecord(),
      sessionId: fixture.owner.sessionId,
      workspaceId: fixture.owner.workspaceId,
      projectId: fixture.owner.projectId,
      provider: "sbx",
      providerState: {
        provider: "sbx",
        ownershipId: fixture.owner.ownershipId,
        sessionId: fixture.owner.sessionId,
        generation: fixture.owner.generation,
        workspaceId: fixture.owner.workspaceId,
        projectId: fixture.owner.projectId,
         sandbox: fixture.sandbox,
         hostPort: fixture.hostPort,
         remoteWorktreePath: fixture.remoteDirectory,
         branch: fixture.owner.branch,
         baseSha: fixture.owner.baseSha,
      },
      vmName: undefined,
      vmIdentity: undefined,
      generation: fixture.owner.generation,
      directory: fixture.owner.directory,
      branch: fixture.owner.branch,
      baseSha: fixture.owner.baseSha,
      state: "orphaned",
    }
    const store = new FileStateStore(await temporaryDirectory())
    await store.write(record)
    const events: string[] = []
    const controller = createOrphanDeletionController(store, record, fixture.driver, events, fixture.remoteDirectory)
    const capability = createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" })

    await expect(controller.handle({ operation: "delete", force: false, capability })).resolves.toMatchObject({
      ok: true,
      state: "delete_pending",
    })
    await controller.onSessionIdle(record.sessionId)

    expect(await store.get(record.sessionId)).toMatchObject({
      state: "deleted",
      operation: { kind: "delete", phase: "deleted", providerDestroyed: true },
    })
    expect(events).toEqual([
      "inspect",
      "inspect",
      "adopt",
      "sync",
      "warp:local",
      "close",
      "workspace:remove",
      "inspect",
      "destroy",
    ])
    expect(fixture.calls.some((argv) => argv.includes("create"))).toBe(false)
    expect(fixture.calls.filter((argv) => argv.includes("rm") && argv.includes("--force"))).toHaveLength(1)
  })

  it("separates the remote SBX checkout path and aborts locally", async () => {
    const fixture = await createSbxRuntimeFixture()
    const session = await fixture.driver.adopt({
      resource: { provider: "sbx", resourceId: fixture.sandbox },
      owner: fixture.owner,
    })
    expect(session.worktreePath).toBeUndefined()
    expect(session.remoteWorktreePath).toBe(fixture.remoteDirectory)
    if (!session.abort) throw new Error("adopted SBX session did not expose abort")

    await session.abort()
    await session.abort()

    expect(fixture.started).toBe(1)
    expect(fixture.terminated).toBe(1)
    expect(fixture.revoked).toBe(1)
    expect(fixture.calls.some((argv) => argv.includes("stop"))).toBe(false)
    expect(fixture.calls.some((argv) => argv.includes("rm"))).toBe(false)
  })

  it("rejects SBX adoption for divergent or unrelated history before local control starts", async () => {
    for (const head of [
      "fedcba9876543210fedcba9876543210fedcba98",
      "abcdef0123456789abcdef0123456789abcdef01",
    ]) {
      const fixture = await createSbxRuntimeFixture({ head, lineage: false })

      await expect(fixture.driver.adopt({
        resource: { provider: "sbx", resourceId: fixture.sandbox },
        owner: fixture.owner,
      })).rejects.toMatchObject({ code: "SBX_ADOPT_CHECKOUT" })

      const lineageProbe = fixture.calls.find((argv) => argv.includes("merge-base"))
      expect(lineageProbe).toEqual(expect.arrayContaining(["--is-ancestor", fixture.owner.baseSha, head]))
      expect(fixture.started).toBe(0)
      expect(fixture.revoked).toBe(0)
      expect(fixture.calls.some((argv) => argv.includes("create") || argv.includes("stop") || argv.includes("rm"))).toBe(false)
    }
  })

  it("adopts an SBX checkout whose HEAD is a valid descendant of the lifecycle base", async () => {
    const head = "fedcba9876543210fedcba9876543210fedcba98"
    const fixture = await createSbxRuntimeFixture({
      head,
      lineage: true,
    })

    const session = await fixture.driver.adopt({
      resource: { provider: "sbx", resourceId: fixture.sandbox },
      owner: fixture.owner,
    })

    const lineageProbe = fixture.calls.find((argv) => argv.includes("merge-base"))
    expect(lineageProbe).toEqual(expect.arrayContaining(["--is-ancestor", fixture.owner.baseSha, head]))
    expect(fixture.started).toBe(1)
    await session.abort?.()
    expect(fixture.calls.some((argv) => argv.includes("stop") || argv.includes("rm"))).toBe(false)
  })

  it("never starts an SBX runtime from conflicting, legacy, stopped, or unknown evidence", async () => {
    const cases = [
      { marker: { sessionId: "ses_foreign" }, status: "running", code: "SBX_ADOPT_CONFLICT" },
      { marker: "x".repeat(43), status: "running", code: "SBX_ADOPT_UNKNOWN" },
      { marker: undefined, status: "stopped", code: "SBX_ADOPT_UNSUPPORTED" },
      { marker: undefined, status: "mystery", code: "SBX_ADOPT_UNKNOWN" },
    ] as const

    for (const testCase of cases) {
      const fixture = await createSbxRuntimeFixture(testCase)
      await expect(fixture.driver.adopt({
        resource: { provider: "sbx", resourceId: fixture.sandbox },
        owner: fixture.owner,
      })).rejects.toMatchObject({ code: testCase.code })
      expect(fixture.started).toBe(0)
      expect(fixture.calls.some((argv) => argv.includes("create"))).toBe(false)
      expect(fixture.calls.some((argv) => argv.includes("exec"))).toBe(false)
      expect(fixture.calls.some((argv) => argv.includes("stop"))).toBe(false)
      expect(fixture.calls.some((argv) => argv.includes("rm"))).toBe(false)
    }
  })

  it("cleans partial adoption locally without stopping or destroying the owned sandbox", async () => {
    const fixture = await createSbxRuntimeFixture({ healthy: false })

    await expect(fixture.driver.adopt({
      resource: { provider: "sbx", resourceId: fixture.sandbox },
      owner: fixture.owner,
    })).rejects.toMatchObject({ code: "REMOTE_HEALTH_TIMEOUT" })

    expect(fixture.started).toBe(1)
    expect(fixture.terminated).toBe(1)
    expect(fixture.revoked).toBe(1)
    expect(fixture.calls.some((argv) => argv.includes("stop"))).toBe(false)
    expect(fixture.calls.some((argv) => argv.includes("rm"))).toBe(false)
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
  it("uses HTTPS or loopback HTTP and rejects URL credentials", () => {
    const options = { apiKey: "test-key" }
    expect(() => new CloudflareBridgeClient({ ...options, apiUrl: "https://user:password@bridge.example.test" })).toThrow(/credentials/i)
    expect(() => new CloudflareBridgeClient({ ...options, apiUrl: "http://bridge.example.test" })).toThrow(/HTTPS/i)
    expect(() => new CloudflareBridgeClient({ ...options, apiUrl: "http://127.0.0.1" })).not.toThrow()
  })

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

  it("adapts stdin to the official PUT and argv-only exec contract", async () => {
    const requests: Array<{ path: string; method: string; body: Uint8Array | string }> = []
    const client = new CloudflareBridgeClient({
      apiUrl: "https://bridge.example.test",
      apiKey: "private",
      fetcher: (async (input, init) => {
        const url = new URL(String(input))
        const body = init?.body instanceof Uint8Array || init?.body instanceof ArrayBuffer
          ? new Uint8Array(init.body instanceof ArrayBuffer ? init.body : init.body.buffer)
          : String(init?.body ?? "")
        requests.push({ path: url.pathname, method: init?.method ?? "GET", body })
        if (url.pathname.endsWith("/exec")) {
          return new Response(JSON.stringify({ exit_code: 0, stdout: "", stderr: "" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
        return new Response(null, { status: 204 })
      }) as typeof fetch,
    })

    await client.exec("sandboxa2", { argv: ["printf", "-n", "quoted 'arg'"], stdin: new Uint8Array([0, 255, 10]) })
    await client.exec("sandboxa2", { argv: ["cat"], stdin: "" })
    await client.exec("sandboxa2", { argv: ["printf", "no stdin"] })

    const puts = requests.filter((request) => request.method === "PUT")
    const execs = requests.filter((request) => request.path.endsWith("/exec"))
    expect(puts).toHaveLength(2)
    expect(Buffer.from(puts[0]?.body as Uint8Array)).toEqual(Buffer.from([0, 255, 10]))
    expect(Buffer.from(puts[1]?.body as Uint8Array)).toHaveLength(0)
    expect(new Set(puts.map((request) => request.path)).size).toBe(2)
    const payloads = execs.map((request) => JSON.parse(String(request.body)) as { argv: string[]; stdin?: unknown })
    expect(payloads.every((payload) => payload.stdin === undefined)).toBe(true)
    expect(payloads[0]?.argv).toEqual(["mkdir", "-m", "700", "--", expect.any(String)])
    expect(payloads[1]?.argv).toEqual(["chmod", "600", "--", expect.any(String)])
    expect(payloads[2]?.argv.slice(0, 3)).toEqual(["sh", "-lc", expect.stringContaining("exec \"$0\" \"$@\" < /workspace/.opencode-stdin-")])
    expect(payloads[2]?.argv.slice(3)).toEqual(["printf", "-n", "quoted 'arg'"])
    expect(payloads[3]?.argv).toEqual(["rm", "-rf", "--", expect.any(String)])
    expect(payloads.at(-1)?.argv).toEqual(["printf", "no stdin"])
  })

  it("bounds file PUTs and rejects the reserved tunnel port before fetch", async () => {
    let calls = 0
    const client = new CloudflareBridgeClient({
      apiUrl: "https://bridge.example.test",
      apiKey: "private",
      fetcher: (async () => {
        calls++
        return new Response(null, { status: 204 })
      }) as unknown as typeof fetch,
    })

    await expect(client.putFile("sandboxa2", "/workspace/input", new Uint8Array(32 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: "CLOUDFLARE_ARCHIVE_LIMIT" })
    await expect(client.hydrate("sandboxa2", new Uint8Array(32 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: "CLOUDFLARE_ARCHIVE_LIMIT" })
    await expect(client.tunnel("sandboxa2", 3000, "test")).rejects.toMatchObject({ code: "CLOUDFLARE_PORT" })
    expect(calls).toBe(0)
  })

  it("does not request the bridge for an already-aborted stdin operation", async () => {
    const controller = new AbortController()
    controller.abort("cancelled")
    let calls = 0
    const client = new CloudflareBridgeClient({
      apiUrl: "https://bridge.example.test",
      apiKey: "private",
      fetcher: (async () => {
        calls++
        return new Response(null, { status: 204 })
      }) as unknown as typeof fetch,
    })

    await expect(client.exec("sandboxa2", { argv: ["cat"], stdin: "secret", signal: controller.signal })).rejects.toMatchObject({ name: "Error" })
    expect(calls).toBe(0)
  })

  it("cleans staged stdin and redacts it from bridge failures", async () => {
    const secret = "stdin-secret-should-not-escape"
    const requests: string[] = []
    const client = new CloudflareBridgeClient({
      apiUrl: "https://bridge.example.test",
      apiKey: "private",
      fetcher: (async (input, init) => {
        const url = new URL(String(input))
        requests.push(url.pathname)
        if (init?.method === "PUT") return new Response(secret, { status: 500 })
        return new Response(JSON.stringify({ exit_code: 0, stdout: "", stderr: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }) as typeof fetch,
    })

    let failure: unknown
    try {
      await client.exec("sandboxa2", { argv: ["cat"], stdin: secret })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).not.toContain(secret)
    expect(requests.filter((path) => path.endsWith("/exec"))).toHaveLength(2)
  })

  it("cleans staged stdin when the command returns a failure exit code", async () => {
    const commands: string[] = []
    const client = new CloudflareBridgeClient({
      apiUrl: "https://bridge.example.test",
      apiKey: "private",
      fetcher: (async (_input, init) => {
        if (init?.method === "PUT") return new Response(null, { status: 204 })
        const payload = JSON.parse(String(init?.body ?? "{}")) as { argv: string[] }
        commands.push(payload.argv[0] ?? "")
        const exitCode = payload.argv[0] === "sh" ? 7 : 0
        return new Response(JSON.stringify({ exit_code: exitCode, stdout: "", stderr: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }) as typeof fetch,
    })

    await expect(client.exec("sandboxa2", { argv: ["cat"], stdin: "input" })).resolves.toMatchObject({ exitCode: 7 })
    expect(commands).toEqual(["mkdir", "chmod", "sh", "rm"])
  })

  it("does not claim or remove a directory when mkdir fails", async () => {
    const commands: string[] = []
    let puts = 0
    const client = new CloudflareBridgeClient({
      apiUrl: "https://bridge.example.test",
      apiKey: "private",
      fetcher: (async (_input, init) => {
        if (init?.method === "PUT") {
          puts++
          return new Response(null, { status: 204 })
        }
        const payload = JSON.parse(String(init?.body ?? "{}")) as { argv: string[] }
        commands.push(payload.argv[0] ?? "")
        return new Response(JSON.stringify({ exit_code: payload.argv[0] === "mkdir" ? 1 : 0, stdout: "", stderr: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }) as typeof fetch,
    })

    await expect(client.exec("sandboxa2", { argv: ["cat"], stdin: "input" })).rejects.toMatchObject({ code: "CLOUDFLARE_COMMAND" })
    expect(commands).toEqual(["mkdir"])
    expect(puts).toBe(0)
  })

  it("cleans the owned directory when chmod fails before command execution", async () => {
    const commands: string[] = []
    const client = new CloudflareBridgeClient({
      apiUrl: "https://bridge.example.test",
      apiKey: "private",
      fetcher: (async (_input, init) => {
        if (init?.method === "PUT") return new Response(null, { status: 204 })
        const payload = JSON.parse(String(init?.body ?? "{}")) as { argv: string[] }
        commands.push(payload.argv[0] ?? "")
        const exitCode = payload.argv[0] === "chmod" ? 1 : 0
        return new Response(JSON.stringify({ exit_code: exitCode, stdout: "", stderr: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }) as typeof fetch,
    })

    await expect(client.exec("sandboxa2", { argv: ["cat"], stdin: "input" })).rejects.toMatchObject({ code: "CLOUDFLARE_COMMAND" })
    expect(commands).toEqual(["mkdir", "chmod", "rm"])
  })

  it("surfaces a nonzero cleanup result when the command succeeds", async () => {
    const commands: string[] = []
    const client = new CloudflareBridgeClient({
      apiUrl: "https://bridge.example.test",
      apiKey: "private",
      fetcher: (async (_input, init) => {
        if (init?.method === "PUT") return new Response(null, { status: 204 })
        const payload = JSON.parse(String(init?.body ?? "{}")) as { argv: string[] }
        commands.push(payload.argv[0] ?? "")
        const exitCode = payload.argv[0] === "rm" ? 1 : 0
        return new Response(JSON.stringify({ exit_code: exitCode, stdout: "", stderr: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }) as typeof fetch,
    })

    await expect(client.exec("sandboxa2", { argv: ["cat"], stdin: "input" })).rejects.toMatchObject({ code: "CLOUDFLARE_COMMAND" })
    expect(commands).toEqual(["mkdir", "chmod", "sh", "rm"])
  })

  it("cleans staged stdin after caller cancellation within the shared deadline", async () => {
    const controller = new AbortController()
    let commandStarted!: () => void
    let cleanupStarted!: () => void
    const command = new Promise<void>((resolve) => { commandStarted = resolve })
    const cleanup = new Promise<void>((resolve) => { cleanupStarted = resolve })
    const requests: string[] = []
    const client = new CloudflareBridgeClient({
      apiUrl: "https://bridge.example.test",
      apiKey: "private",
      requestTimeoutMs: 1_000,
      fetcher: (async (_input, init) => {
        if (init?.method === "PUT") return new Response(null, { status: 204 })
        const payload = JSON.parse(String(init?.body ?? "{}")) as { argv: string[] }
        requests.push(payload.argv[0] ?? "")
        if (payload.argv[0] === "sh") {
          commandStarted()
          return new Promise<Response>(() => {})
        }
        if (payload.argv[0] === "rm") {
          cleanupStarted()
          return new Response(JSON.stringify({ exit_code: 0, stdout: "", stderr: "" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
        return new Response(JSON.stringify({ exit_code: 0, stdout: "", stderr: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }) as typeof fetch,
    })

    const request = client.exec("sandboxa2", { argv: ["cat"], stdin: "cancel-me", signal: controller.signal })
    await command
    controller.abort()
    await expect(request).rejects.toBeDefined()
    await cleanup
    expect(requests).toEqual(["mkdir", "chmod", "sh", "rm"])
  })

  it("reserves deadline time for cleanup after an exec timeout", async () => {
    let commandStarted!: () => void
    const started = new Promise<void>((resolve) => { commandStarted = resolve })
    const commands: string[] = []
    const client = new CloudflareBridgeClient({
      apiUrl: "https://bridge.example.test",
      apiKey: "private",
      requestTimeoutMs: 100,
      fetcher: (async (_input, init) => {
        if (init?.method === "PUT") return new Response(null, { status: 204 })
        const payload = JSON.parse(String(init?.body ?? "{}")) as { argv: string[] }
        commands.push(payload.argv[0] ?? "")
        if (payload.argv[0] === "sh") {
          commandStarted()
          return new Promise<Response>(() => {})
        }
        return new Response(JSON.stringify({ exit_code: 0, stdout: "", stderr: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }) as typeof fetch,
    })

    const request = client.exec("sandboxa2", { argv: ["cat"], stdin: "input" })
    await started
    await expect(request).rejects.toBeDefined()
    expect(commands).toEqual(["mkdir", "chmod", "sh", "rm"])
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

  it("bounds an unterminated SSE line", async () => {
    const client = new CloudflareBridgeClient({
      apiUrl: "https://bridge.example.test",
      apiKey: "private",
      requestTimeoutMs: 1_000,
      fetcher: (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.alloc(512 * 1024 + 1, "x"))
          controller.close()
        },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } })) as unknown as typeof fetch,
    })

    await expect(client.exec("sandboxa2", { argv: ["cat"] })).rejects.toMatchObject({ code: "CLOUDFLARE_RESPONSE_LIMIT" })
  })

  it("cancels a diagnostic response body after headers arrive", async () => {
    const diagnostic = new AbortController()
    let signal: AbortSignal | undefined
    let cancel: (() => void) | undefined
    let cancelled = false
    const bodyRead = new Promise<void>((resolve) => { cancel = resolve })
    const client = new CloudflareBridgeClient({
      apiUrl: "https://bridge.example.test",
      apiKey: "private",
      requestTimeoutMs: 600_000,
      fetcher: (async (_input, init) => {
        signal = init?.signal ?? undefined
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"running":'))
          },
          pull() {
            cancel?.()
          },
          cancel() {
            cancelled = true
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } })
      }) as typeof fetch,
    })

    const request = client.running("sandboxa2", diagnostic.signal)
    await bodyRead
    diagnostic.abort()

    await expect(request).rejects.toBeDefined()
    expect(signal?.aborted).toBe(true)
    expect(cancelled).toBe(true)
  })

  it("settles a diagnostic fetch when the injected fetcher ignores abort", async () => {
    const diagnostic = new AbortController()
    let signal: AbortSignal | undefined
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const client = new CloudflareBridgeClient({
      apiUrl: "https://bridge.example.test",
      apiKey: "private",
      requestTimeoutMs: 600_000,
      fetcher: (async (_input, init) => {
        signal = init?.signal ?? undefined
        markStarted()
        return new Promise<Response>(() => {})
      }) as typeof fetch,
    })

    const request = client.running("sandboxa2", diagnostic.signal)
    await started
    diagnostic.abort()

    await expect(request).rejects.toMatchObject({ code: "CLOUDFLARE_REQUEST" })
    expect(signal?.aborted).toBe(true)
  })

  it("cancels a late diagnostic response body after fetch aborts", async () => {
    const diagnostic = new AbortController()
    let signal: AbortSignal | undefined
    let markStarted!: () => void
    let releaseResponse!: () => void
    let resolveCancelled!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const cancelled = new Promise<void>((resolve) => { resolveCancelled = resolve })
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() {
        resolveCancelled()
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })
    const client = new CloudflareBridgeClient({
      apiUrl: "https://bridge.example.test",
      apiKey: "private",
      requestTimeoutMs: 600_000,
      fetcher: (async (_input, init) => {
        signal = init?.signal ?? undefined
        markStarted()
        return new Promise<Response>((resolve) => { releaseResponse = () => resolve(response) })
      }) as typeof fetch,
    })

    const request = client.running("sandboxa2", diagnostic.signal)
    await started
    diagnostic.abort()
    await expect(request).rejects.toMatchObject({ code: "CLOUDFLARE_REQUEST" })
    releaseResponse()

    let failureTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        cancelled,
        new Promise<never>((_, reject) => {
          failureTimer = setTimeout(() => reject(new Error("late response body was not canceled")), 100)
        }),
      ])
    } finally {
      if (failureTimer) clearTimeout(failureTimer)
    }
    expect(signal?.aborted).toBe(true)
  })
})

describe("provider health responses", () => {
  it("bounds oversized health response bodies for every provider", async () => {
    const root = await temporaryDirectory()
    const sbxHealth = oversizedHealthFetcher()
    const exedevHealth = oversizedHealthFetcher()
    const cloudflareHealth = oversizedHealthFetcher()
    const providers = [
      {
        provider: new SbxProvider({ worktree: root, healthTimeoutMs: 1, fetcher: sbxHealth.fetcher }),
        activation: { hostPort: 4101, password: "private" },
        health: sbxHealth,
      },
      {
        provider: new ExedevProvider({
          config: parseConfig({ healthTimeoutMs: 1 }, { HOME: root }),
          control: {} as ExeControl,
          worktree: root,
          localControlSocket: join(root, "control.sock"),
          fetcher: exedevHealth.fetcher,
        }),
        activation: { localPort: 4101, password: "private" },
        health: exedevHealth,
      },
      {
        provider: new CloudflareProvider({
          worktree: root,
          client: {} as CloudflareSandboxClient,
          healthTimeoutMs: 1,
          fetcher: cloudflareHealth.fetcher,
        }),
        activation: { tunnel: { id: "tunnel_1", port: 4096, url: "https://sandbox.example.test" }, password: "private" },
        health: cloudflareHealth,
      },
    ]

    for (const testCase of providers) {
      let error: unknown
      try {
        await invokeHealthCheck(testCase.provider, testCase.activation)
      } catch (value) {
        error = value
      }
      expect(error).toMatchObject({ code: "REMOTE_HEALTH_TIMEOUT" })
      expect(String((error as Error).message)).not.toContain("private")
      expect(testCase.health.cancelled()).toBe(true)
    }
  })

  it("retains safe Cloudflare health status and subcode diagnostics", async () => {
    const body = [
      "<!doctype html><html><head><title>Cloudflare Tunnel error</title>",
      `<style>${"x".repeat(700)}</style><script>${"y".repeat(700)}</script>`,
      "</head><body><h1>Cloudflare Tunnel error</h1><p>Error <span>1033</span></p>",
      "<p>https://secret.example.test Cookie: session=private Authorization: Bearer private</p></body></html>",
    ].join("")
    expect(Buffer.byteLength(body)).toBeGreaterThan(1024)
    const provider = new CloudflareProvider({
      worktree: await temporaryDirectory(),
      client: {} as CloudflareSandboxClient,
      healthTimeoutMs: 100,
      fetcher: (async () => new Response(body, { status: 530, headers: { "CF-Ray": "ray-123" } })) as unknown as typeof fetch,
    })

    let error: unknown
    try {
      await invokeHealthCheck(provider, { tunnel: { id: "tunnel-health-1033", url: "https://sandbox.example.test" }, password: "private" })
    } catch (value) {
      error = value
    }

    expect(error).toMatchObject({ code: "REMOTE_HEALTH_TIMEOUT" })
    const message = String((error as Error).message)
    expect(message).toContain("530")
    expect(message).toContain("1033")
    expect(message).not.toContain("<html>")
    expect(message).not.toContain("secret.example.test")
    expect(message).not.toContain("session=private")
    expect(message).not.toContain("Bearer private")
    const details = (error as { details?: Record<string, unknown> }).details
    expect(details).toMatchObject({ status: 530, subcode: 1033, hostname: "sandbox.example.test", tunnelId: "tunnel-health-1033", cfRay: "ray-123" })
    expect(details?.elapsedMs).toEqual(expect.any(Number))
    expect(String(details?.body)).toContain("Error 1033")
    expect(String(details?.body)).not.toContain("secret.example.test")
    expect(String(details?.body)).not.toContain("session=private")
    expect(String(details?.body)).not.toContain("Bearer private")
    expect(Buffer.byteLength(String(details?.body))).toBeLessThanOrEqual(1024)
  })

  it("cancels oversized non-OK Cloudflare health bodies", async () => {
    const health = oversizedHealthFetcher(530)
    const provider = new CloudflareProvider({
      worktree: await temporaryDirectory(),
      client: {} as CloudflareSandboxClient,
      healthTimeoutMs: 1,
      fetcher: health.fetcher,
    })

    await expect(invokeHealthCheck(provider, { tunnel: { url: "https://sandbox.example.test" }, password: "private" })).rejects.toMatchObject({
      code: "REMOTE_HEALTH_TIMEOUT",
    })
    expect(health.cancelled()).toBe(true)
  })

  it("settles Cloudflare diagnostic health when the injected fetcher ignores abort", async () => {
    const diagnostic = new AbortController()
    let signal: AbortSignal | undefined
    let markStarted!: () => void
    let releaseResponse!: () => void
    let resolveCancelled!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const cancelled = new Promise<void>((resolve) => { resolveCancelled = resolve })
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() {
        resolveCancelled()
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })
    const provider = new CloudflareProvider({
      worktree: await temporaryDirectory(),
      client: {} as CloudflareSandboxClient,
      fetcher: (async (_input, init) => {
        signal = init?.signal ?? undefined
        markStarted()
        return new Promise<Response>((resolve) => { releaseResponse = () => resolve(response) })
      }) as typeof fetch,
    })
    const activeHealth = (provider as unknown as {
      activeHealth(activation: { tunnel: { url: string }; password: string }, signal?: AbortSignal): Promise<unknown>
    }).activeHealth.bind(provider)

    const health = activeHealth({ tunnel: { url: "https://sandbox.example.test" }, password: "private" }, diagnostic.signal)
    await started
    diagnostic.abort()
    await expect(health).resolves.toBeUndefined()
    releaseResponse()

    let failureTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        cancelled,
        new Promise<never>((_, reject) => {
          failureTimer = setTimeout(() => reject(new Error("late health response body was not canceled")), 100)
        }),
      ])
    } finally {
      if (failureTimer) clearTimeout(failureTimer)
    }
    expect(signal?.aborted).toBe(true)
  })
})

describe("Cloudflare Sandbox provider", () => {
  it("uses authenticated health for Sandcastle inspection", async () => {
    const root = await temporaryDirectory()
    await runGit(root, ["init", "-q"])
    await runGit(root, ["config", "user.email", "test@example.invalid"])
    await runGit(root, ["config", "user.name", "Sandbox Test"])
    await writeFile(join(root, "tracked.txt"), "base\n")
    await runGit(root, ["add", "tracked.txt"])
    await runGit(root, ["commit", "-q", "-m", "initial"])
    const head = await nodeProcessRunner.run({ argv: ["git", "-C", root, "rev-parse", "HEAD"], cwd: root })
    const baseSha = head.stdout.trim()
    const authorization: string[] = []
    const client: CloudflareSandboxClient = {
      async createSandbox() { return "sandboxa2" },
      async destroySandbox() {},
      async destroyTunnel() {},
      async running() { return true },
      async exec(_id, input) {
        const command = input.argv.at(-1) ?? ""
        if ((input.argv.includes("rev-parse") && input.argv.at(-1) === "HEAD") || command.includes("git rev-parse HEAD")) {
          return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
        }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
      async putFile() {},
      async getFile() { return new Uint8Array() },
      async hydrate() {},
      async tunnel(_id, port, name) { return { id: "tunnel_1", port, url: `https://${name}.example.test` } },
    }
    const adapter = createCloudflareSandcastleAdapter({
      input: {
        sessionId: "ses_cf_inspect",
        projectId: "prj_1",
        workspaceId: "wrk_cf_inspect",
        generation: 1,
        branch: "opencode/cloudflare-inspect",
        baseSha,
        context: { sessionId: "ses_cf_inspect", projectId: "prj_1", directory: root, worktree: root },
      },
      worktree: root,
      client,
      authContent: "{}",
      fetcher: (async (_input, init) => {
        authorization.push(new Headers(init?.headers).get("authorization") ?? "")
        return new Response(JSON.stringify({ healthy: true }), { status: 200 })
      }) as typeof fetch,
    })
    const worktree = await createWorktree({
      cwd: root,
      branchStrategy: { type: "branch", branch: "opencode/cloudflare-inspect", baseBranch: baseSha },
    })
    let sandbox: Awaited<ReturnType<typeof worktree.createSandbox>> | undefined
    try {
      sandbox = await worktree.createSandbox({ sandbox: adapter.provider })
      await adapter.applyCapture({ sandbox, capture: { baseSha, patch: "", untracked: [] } })

      await expect(adapter.inspect?.()).resolves.toMatchObject({
        resource: "present",
        ownership: "verified",
        health: "healthy",
      })
    } finally {
      await sandbox?.close()
      await worktree.close()
    }

    expect(authorization.length).toBeGreaterThanOrEqual(2)
    expect(authorization.every((value) => value.startsWith("Basic "))).toBe(true)
  })

  it("creates the host worktree alias before starting OpenCode", async () => {
    const commands: string[] = []
    const client = {
      async exec(_sandboxId: string, input: { argv: string[] }) {
        if (input.argv[0] === "sh" && input.argv[1] === "-lc") commands.push(input.argv[2] ?? "")
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
      async putFile() {},
    } as unknown as CloudflareSandboxClient
    const provider = new CloudflareProvider({ worktree: "/Users/tester/project with space", client, deferActivation: true })
    const startServer = (provider as unknown as { startServer(activation: unknown): Promise<void> }).startServer.bind(provider)

    await startServer({ sandboxId: "sandboxa2", workspaceId: "wrk_cf_alias", authContent: "{}", password: "private" })

    const aliasIndex = commands.findIndex((command) => command.includes("ln -s --"))
    const serverIndex = commands.findIndex((command) => command.includes("opencode serve"))
    expect(aliasIndex).toBeGreaterThanOrEqual(0)
    expect(aliasIndex).toBeLessThan(serverIndex)
    expect(commands[aliasIndex]).toContain("alias_path='/Users/tester/project with space'")
    expect(commands[aliasIndex]).toContain("checkout_path='/workspace/.opencode-worktree'")
  })

  it("rejects an incompatible existing host worktree alias", async () => {
    const commands: string[] = []
    const client = {
      async exec(_sandboxId: string, input: { argv: string[] }) {
        if (input.argv[0] === "sh" && input.argv[1] === "-lc") {
          const command = input.argv[2] ?? ""
          commands.push(command)
          if (command.includes("ln -s --")) return { exitCode: 1, signal: null, stdout: "", stderr: "alias conflict" }
        }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
    } as unknown as CloudflareSandboxClient
    const provider = new CloudflareProvider({ worktree: "/Users/tester/project", client, deferActivation: true })
    const startServer = (provider as unknown as { startServer(activation: unknown): Promise<void> }).startServer.bind(provider)

    await expect(startServer({ sandboxId: "sandboxa2", workspaceId: "wrk_cf_alias", authContent: "{}", password: "private" })).rejects.toMatchObject({
      stage: "bootstrap",
      code: "CLOUDFLARE_COMMAND",
    })
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain("conflicts with an existing remote path")
    expect(commands.some((command) => command.includes("opencode serve"))).toBe(false)
  })

  it("uses builtin-test-compatible argv when copying a regular file out", async () => {
    const root = await temporaryDirectory()
    const remoteRoot = await temporaryDirectory()
    const sandboxPath = join(remoteRoot, "output.bin")
    const hostPath = join(root, "output.bin")
    const content = new Uint8Array([0, 1, 2, 255])
    const testArgv: string[][] = []
    await writeFile(sandboxPath, content)

    const client: CloudflareSandboxClient = {
      async createSandbox() { return "sandboxa2" },
      async destroySandbox() {},
      async destroyTunnel() {},
      async running() { return true },
      async exec(_id, input) {
        if (input.argv[0] === "test") {
          testArgv.push(input.argv)
          return nodeProcessRunner.run({ argv: ["/bin/sh", "-c", 'test "$@"', "test", ...input.argv.slice(1)] })
        }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
      async putFile() {},
      async getFile() { return content },
      async hydrate() {},
      async tunnel(_id, port, name) { return { id: "tunnel_1", port, url: `https://${name}.example.test` } },
    }
    const provider = new CloudflareProvider({ worktree: root, client, deferActivation: true })
    const info = {
      id: "wrk_cf_copy",
      type: "cloudflare",
      name: "workspace",
      branch: "opencode/cloudflare-copy",
      directory: root,
      projectID: "prj_1",
      extra: { baseSha: "0123456789012345678901234567890123456789", sessionId: "ses_cf_copy", generation: 1 },
    }

    await provider.prepare(info, { OPENCODE_AUTH_CONTENT: "{}" })
    const handle = provider.createIsolatedHandle(info)
    try {
      await handle.copyFileOut(sandboxPath, hostPath)
      expect(await readFile(hostPath)).toEqual(Buffer.from(content))
    } finally {
      await handle.close()
    }

    expect(testArgv).toEqual([
      ["test", "-f", sandboxPath],
      ["test", "-L", sandboxPath],
    ])
  })

  it("hydrates a private checkout, starts OpenCode, and syncs captures", async () => {
    const root = await temporaryDirectory()
    const baseSha = "0123456789012345678901234567890123456789"
    const checkoutHead = "fedcba9876543210fedcba9876543210fedcba98"
    let observedHead = checkoutHead
    const calls: string[] = []
    const remoteCommands: string[] = []
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
        if (input.argv[0] === "sh" && input.argv[1] === "-lc") remoteCommands.push(input.argv[2] ?? "")
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
    expect(remoteCommands.some((command) => command.includes('export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"'))).toBe(true)
    expect(remoteCommands.some((command) => command.includes('export PATH="$runtime/bin:${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"'))).toBe(true)
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
    let sandboxDestroyed = false
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
        async destroySandbox() { sandboxDestroyed = true },
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
    await expect(provider.close(info)).resolves.toBeUndefined()
    expect(sandboxDestroyed).toBe(true)
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
      expect(adapter.recoveryMetadata?.()).toMatchObject({ remoteWorktreePath: "/workspace/.opencode-worktree" })
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

  it("keeps Cloudflare control assets when Sandcastle recreates the checkout", async () => {
    const root = await temporaryDirectory()
    await runGit(root, ["init", "-q"])
    await runGit(root, ["config", "user.email", "test@example.invalid"])
    await runGit(root, ["config", "user.name", "Sandbox Test"])
    await writeFile(join(root, "tracked.txt"), "base\n")
    await runGit(root, ["add", "tracked.txt"])
    await runGit(root, ["commit", "-q", "-m", "initial"])
    const head = await nodeProcessRunner.run({ argv: ["git", "-C", root, "rev-parse", "HEAD"], cwd: root })
    const baseSha = head.stdout.trim()
    const remoteFiles = new Set<string>()
    const client: CloudflareSandboxClient = {
      async createSandbox() { return "sandboxa2" },
      async destroySandbox() {},
      async destroyTunnel() {},
      async running() { return true },
      async exec(_id, input) {
        const command = input.argv.at(-1) ?? ""
        const removedPath = command.match(/rm -rf(?: --)? ["']([^"']+)["']/)?.[1]
        if (removedPath) {
          for (const path of remoteFiles) {
            if (path === removedPath || path.startsWith(`${removedPath}/`)) remoteFiles.delete(path)
          }
        }
        const exactRemovedPath = input.argv[0] === "rm" && input.argv[1] === "-f" ? input.argv.at(-1) : undefined
        if (exactRemovedPath) remoteFiles.delete(exactRemovedPath)
        if (command.includes("rev-parse HEAD") || input.argv.at(-1) === "HEAD") {
          return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
        }
        if (command.includes("symbolic-ref")) {
          return { exitCode: 0, signal: null, stdout: "opencode/cloudflare-sandcastle\n", stderr: "" }
        }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
      async putFile(_id, path) { remoteFiles.add(path) },
      async getFile() { return new Uint8Array() },
      async hydrate() {},
      async tunnel(_id, port, name) { return { id: "tunnel_1", port, url: `https://${name}.example.test` } },
    }
    const adapter = createCloudflareSandcastleAdapter({
      input: {
        sessionId: "ses_cf",
        projectId: "prj_1",
        workspaceId: "wrk_cf_path",
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
      fetcher: (async () => new Response(JSON.stringify({ healthy: true }), { status: 200 })) as unknown as typeof fetch,
    })
    const worktree = await createWorktree({
      cwd: root,
      branchStrategy: { type: "branch", branch: "opencode/cloudflare-sandcastle", baseBranch: baseSha },
    })

    let sandbox: Awaited<ReturnType<typeof worktree.createSandbox>> | undefined
    const assetPath = () => [...remoteFiles].find((path) => path.endsWith("/.config/opencode/sandbox/cli.ts"))
    try {
      sandbox = await worktree.createSandbox({ sandbox: adapter.provider })
      expect(assetPath()).toBeDefined()
      await adapter.applyCapture({ sandbox, capture: { baseSha, patch: "", untracked: [] } })
      expect(assetPath()).toBeDefined()
    } finally {
      await sandbox?.close()
      await worktree.close()
    }
  })
})

describe("provider-owned deletion", () => {
  it("deletes a non-VM provider through its destroy callback", async () => {
    const record = { ...makeRecord(), provider: "sbx", providerState: { sandbox: "oc-sbx-test" }, vmName: undefined, vmIdentity: undefined, state: "detached" as const, preservedWorktreePath: "/tmp/preserved" }
    const store = new FileStateStore(await temporaryDirectory())
    await store.write(record)
    let destroyed = false
    const controller = new LifecycleController({
      store,
      providerType: "sbx",
      providerInspect: async () => ({ resourceId: "oc-sbx-test", resource: "present", ownership: "verified", health: "healthy", evidence: ["fixture"] }),
      providerTarget: async () => undefined,
      gitInspect: async () => ({ head: record.baseSha, branch: record.branch, dirty: false, evidence: ["fixture"] }),
      providerDestroy: async () => {
        destroyed = true
      },
      workspace: {
        async create() {
          throw new Error("must not create")
        },
        async warp() {},
        async remove() {},
        async inspect() { return undefined },
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
  it("does not count porcelain branch headers as changes", async () => {
    const root = await temporaryDirectory()
    await runGit(root, ["init", "-q"])
    await runGit(root, ["config", "user.email", "test@example.invalid"])
    await runGit(root, ["config", "user.name", "Test"])
    await writeFile(join(root, "tracked.txt"), "base\n")
    await runGit(root, ["add", "tracked.txt"])
    await runGit(root, ["commit", "-q", "-m", "initial"])

    await expect(inspectWorkingTree(root)).resolves.toMatchObject({ dirty: false })
  })

  it("inspects Git state without reading untracked file contents", async () => {
    const root = await temporaryDirectory()
    await runGit(root, ["init", "-q"])
    await runGit(root, ["config", "user.email", "test@example.invalid"])
    await runGit(root, ["config", "user.name", "Test"])
    await writeFile(join(root, "tracked.txt"), "base\n")
    await runGit(root, ["add", "tracked.txt"])
    await runGit(root, ["commit", "-q", "-m", "initial"])
    await writeFile(join(root, "tracked.txt"), "changed\n")
    await writeFile(join(root, "untracked.txt"), "new\n")

    const result = await inspectWorkingTree(root)

    expect(result.head).toMatch(/^[a-f0-9]{40}$/)
    expect(result.branch).toBeTruthy()
    expect(result.dirty).toBe(true)
  })

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

  it("rejects untracked content beyond the aggregate capture limit", async () => {
    const root = await temporaryDirectory()
    const first = join(root, "first.bin")
    const second = join(root, "second.bin")
    const third = join(root, "third.bin")
    await writeFile(first, "")
    await writeFile(second, "")
    await writeFile(third, "x")
    await truncate(first, 32 * 1024 * 1024)
    await truncate(second, 32 * 1024 * 1024)

    const baseSha = "0123456789012345678901234567890123456789"
    const runner: ProcessRunner = {
      async run(input) {
        if (input.argv.includes("rev-parse")) return { exitCode: 0, signal: null, stdout: `${baseSha}\n`, stderr: "" }
        if (input.argv.includes("ls-files")) return { exitCode: 0, signal: null, stdout: "first.bin\0second.bin\0third.bin\0", stderr: "" }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
    }

    await expect(captureWorkingTree({
      sessionId: "ses_1",
      projectId: "prj_1",
      directory: root,
      worktree: root,
    }, runner)).rejects.toMatchObject({ code: "GIT_CAPTURE_LIMIT" })
  })

  it("bounds a file read when an untracked file grows after it is checked", async () => {
    const root = await temporaryDirectory()
    const path = join(root, "growing.bin")
    await writeFile(path, "x")
    await truncate(path, 1)
    let grow!: Promise<void>
    const runner: ProcessRunner = {
      async run(input) {
        if (input.argv.includes("rev-parse")) return { exitCode: 0, signal: null, stdout: `${"0".repeat(40)}\n`, stderr: "" }
        if (input.argv.includes("ls-files")) {
          grow = new Promise<void>((resolve) => {
            setImmediate(async () => {
              await truncate(path, 32 * 1024 * 1024 + 1)
              resolve()
            })
          })
          return { exitCode: 0, signal: null, stdout: "growing.bin\0", stderr: "" }
        }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
    }

    await expect(captureWorkingTree({
      sessionId: "ses_1",
      projectId: "prj_1",
      directory: root,
      worktree: root,
    }, runner)).rejects.toMatchObject({ code: "GIT_UNTRACKED_SIZE" })
    await grow
  })

  it("aborts a capture that exceeds its total deadline", async () => {
    const root = await temporaryDirectory()
    let aborted = false
    const runner: ProcessRunner = {
      async run(input) {
        input.signal?.addEventListener("abort", () => { aborted = true }, { once: true })
        await new Promise((resolve) => setTimeout(resolve, 100))
        return { exitCode: 0, signal: null, stdout: "0123456789012345678901234567890123456789\n", stderr: "" }
      },
    }

    await expect(captureWorkingTree({
      sessionId: "ses_1",
      projectId: "prj_1",
      directory: root,
      worktree: root,
    }, runner, 10)).rejects.toMatchObject({ code: "GIT_CAPTURE_TIMEOUT" })
    expect(aborted).toBe(true)
  })

  it("waits for capture cancellation cleanup before returning its timeout", async () => {
    const root = await temporaryDirectory()
    let cleanupFinished = false
    const runner: ProcessRunner = {
      async run(input) {
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => {
            setTimeout(() => {
              cleanupFinished = true
              resolve()
            }, 5)
          }, { once: true })
        })
        return { exitCode: 0, signal: null, stdout: "0123456789012345678901234567890123456789\n", stderr: "" }
      },
    }

    await expect(captureWorkingTree({
      sessionId: "ses_1",
      projectId: "prj_1",
      directory: root,
      worktree: root,
    }, runner, 10)).rejects.toMatchObject({ code: "GIT_CAPTURE_TIMEOUT" })
    expect(cleanupFinished).toBe(true)
  })
})

function oversizedHealthFetcher(status = 200): { fetcher: typeof fetch; cancelled: () => boolean } {
  let cancelled = false
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  const body = Buffer.concat([
    Buffer.from('{"healthy":true,"version":"1.18.23","password":"private","padding":"'),
    Buffer.alloc(512 * 1024, "x"),
    Buffer.from('"}'),
  ])
  return {
    fetcher: (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body)
        closeTimer = setTimeout(() => {
          try {
            controller.close()
          } catch {
            // The bounded reader may have already canceled the stream.
          }
        }, 10)
      },
      cancel() {
        cancelled = true
        if (closeTimer) clearTimeout(closeTimer)
      },
    }), { status })) as unknown as typeof fetch,
    cancelled: () => cancelled,
  }
}

function createOrphanDeletionController(
  store: FileStateStore,
  record: SandboxRecord,
  driver: RuntimeDriver,
  events: string[],
  workspaceDirectory = record.directory,
): LifecycleController {
  return new LifecycleController({
    store,
    providerType: record.provider,
    runtimeDriver: instrumentRuntimeDriver(driver, events),
    workspace: {
      async create() {
        events.push("workspace:create")
        throw new Error("orphan deletion must not create a workspace")
      },
      async warp(input) {
        events.push(input.workspaceId ? "warp:remote" : "warp:local")
      },
      async remove() {
        events.push("workspace:remove")
      },
      async inspect() {
        return matchingWorkspace(record, { directory: workspaceDirectory })
      },
    },
  })
}

function instrumentRuntimeDriver(driver: RuntimeDriver, events: string[]): RuntimeDriver {
  return {
    async inspect(resource) {
      events.push("inspect")
      return driver.inspect(resource)
    },
    async adopt(input) {
      events.push("adopt")
      return driver.adopt(input)
    },
    async sync(session) {
      events.push("sync")
      return driver.sync(session)
    },
    async close(session) {
      events.push("close")
      return driver.close(session)
    },
    async destroy(resource, owner) {
      events.push("destroy")
      return driver.destroy(resource, owner)
    },
  }
}

interface RecoveryFixture {
  controller: LifecycleController
  capability: ReturnType<typeof createCapability>
  store: FileStateStore
  record: SandboxRecord
  calls: string[]
  workspaceRemovals: Array<{ workspaceId: string; directory: string }>
}

async function setupRecoveryFixture(options: {
  observation?: Pick<ProviderResourceObservation, "resource" | "ownership" | "health">
  observations?: Array<Pick<ProviderResourceObservation, "resource" | "ownership" | "health">>
  state?: "orphaned" | "remote"
  adoptError?: SandboxError
  syncError?: SandboxError
  workspaceRemoveFailures?: number
  destroyFailures?: number
  provider?: string
  providerState?: Record<string, unknown>
  workspaceDirectory?: string
  workspaceExtra?: unknown
  onAdopt?: () => Promise<void>
  workspaceObservation?: "matching" | "foreign" | "unavailable"
  routeError?: SandboxError
  abortPreservedWorktreePath?: string
  closePreservedWorktreePath?: string
  adoptGate?: { started(): void; wait: Promise<void> }
  gitInspect?: (record: SandboxRecord, worktreePath: string) => Promise<GitWorkingTreeObservation>
} = {}): Promise<RecoveryFixture> {
  const store = new FileStateStore(await temporaryDirectory())
  const record: SandboxRecord = {
    ...makeRecord(),
    provider: options.provider ?? "fake",
    providerState: { resourceId: "resource-1", ...options.providerState },
    state: options.state ?? "orphaned",
  }
  await store.write(record)
  const calls: string[] = []
  const workspaceRemovals: Array<{ workspaceId: string; directory: string }> = []
  const observation: ProviderResourceObservation = {
    resourceId: "resource-1",
    resource: options.observation?.resource ?? "present",
    ownership: options.observation?.ownership ?? "verified",
    health: options.observation?.health ?? "healthy",
    evidence: ["fake runtime driver"],
  }
  let inspection = 0
  const runtimeDriver: RuntimeDriver = {
    async inspect(resource) {
      calls.push(`inspect:${resource.resourceId}`)
      const next = options.observations?.[inspection++]
      return next ? { resourceId: "resource-1", ...next, evidence: ["fake runtime driver"] } : observation
    },
    async adopt({ owner }) {
      calls.push("adopt")
      options.adoptGate?.started()
      if (options.adoptGate) await options.adoptGate.wait
      await options.onAdopt?.()
      if (options.adoptError) throw options.adoptError
      return {
        workspaceId: owner.workspaceId,
        target: { type: "remote" as const, url: "https://runtime.example.test", headers: { Authorization: "private" } },
        remoteWorktreePath: "/tmp/recovered-runtime",
        async abort() {
          calls.push("abort")
          return options.abortPreservedWorktreePath
            ? { preservedWorktreePath: options.abortPreservedWorktreePath }
            : {}
        },
      }
    },
    async sync() {
      calls.push("sync")
      if (options.syncError) throw options.syncError
    },
    async close() {
      calls.push("close")
      return options.closePreservedWorktreePath
        ? { preservedWorktreePath: options.closePreservedWorktreePath }
        : {}
    },
    async destroy() {
      calls.push("destroy")
      if ((options.destroyFailures ?? 0) > 0) {
        options.destroyFailures!--
        throw new SandboxError("remove", "fake destroy failed", "FAKE_DESTROY")
      }
    },
  }
  const controller = new LifecycleController({
    store,
    providerType: "fake",
    runtimeDriver,
    sandcastle: {
      createAdapter: async () => {
        calls.push("adapter:create")
        throw new Error("recovery must not create an adapter")
      },
      createWorktree: async () => {
        calls.push("worktree:create")
        throw new Error("recovery must not create a worktree")
      },
    },
    gitInspect: options.gitInspect,
    workspace: {
      async create() {
        calls.push("workspace:create")
        throw new Error("recovery must not create a workspace")
      },
      async warp(input) {
        calls.push(input.workspaceId ? "warp:remote" : "warp:local")
        if (input.workspaceId && options.routeError) throw options.routeError
      },
      async startSync() {
        calls.push("sync:start")
      },
      async waitForSync() {
        calls.push("sync:connected")
      },
      async replaySession() {
        calls.push("replay")
      },
      async remove(input) {
        calls.push("workspace:remove")
        workspaceRemovals.push(input)
        if ((options.workspaceRemoveFailures ?? 0) > 0) {
          options.workspaceRemoveFailures!--
          throw new Error("fake workspace removal failed")
        }
      },
      ...(options.workspaceObservation === "unavailable" ? {} : {
        async inspect() {
          return matchingWorkspace(record, {
            directory: options.workspaceDirectory ?? (options.workspaceObservation === "foreign" ? "/foreign/project" : record.directory),
            ...(options.workspaceExtra !== undefined ? { extra: options.workspaceExtra } : {}),
          })
        },
      }),
    },
  })

  return {
    controller,
    capability: createCapability({ sessionId: record.sessionId, generation: record.generation, role: "host" }),
    store,
    record,
    calls,
    workspaceRemovals,
  }
}

function invokeHealthCheck(provider: unknown, activation: unknown): Promise<void> {
  return (provider as { waitForHealth(activation: unknown): Promise<void> }).waitForHealth(activation)
}

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

function matchingWorkspace(record: SandboxRecord, overrides: Record<string, unknown> = {}) {
  return {
    id: record.workspaceId,
    type: record.provider,
    name: "workspace",
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
    ...overrides,
  }
}

async function createExedevRuntimeFixture(options: {
  status?: string
  foreign?: boolean
  healthy?: boolean
  listError?: boolean
} = {}) {
  const root = await temporaryDirectory()
  const owner = {
    provider: "exedev" as const,
    projectId: "prj_1",
    sessionId: "ses_exedev_restart",
    generation: 2,
    workspaceId: "wrk_exedev_restart",
    directory: root,
    branch: "opencode/exedev-restart",
    baseSha: "0123456789012345678901234567890123456789",
  }
  const identity = {
    id: "vm_exedev_1",
    name: "oc-exedev-restart",
    sshDest: "vm.exe.xyz",
    tags: ["opencode-sandbox", `opencode-owner-${shortHash(`${owner.projectId}:${owner.sessionId}:${owner.workspaceId}:${owner.generation}`)}`],
    comment: "opencode-test",
  }
  const vm: VmInfo = {
    identity,
    status: options.status ?? "running",
  }
  const foreign = { ...vm, identity: { ...identity, sshDest: "foreign.exe.xyz" } }
  const metadata = {
    provider: "exedev",
    projectId: owner.projectId,
    sessionId: owner.sessionId,
    generation: owner.generation,
    workspaceId: owner.workspaceId,
    branch: owner.branch,
    baseSha: owner.baseSha,
    remoteDirectory: "/tmp/oe-0123456789ab",
    remoteWorktreePath: remoteWorkspaceDirectory(owner.workspaceId),
    vmName: identity.name,
    vmIdentity: identity,
  }
  const remoteState = {
    branch: owner.branch,
    head: owner.baseSha,
    lineage: true,
  }
  const calls: string[][] = []
  let started = 0
  let terminated = 0
  let revoked = 0
  let created = 0
  let copied = 0
  let removed = 0
  let finishProcess!: (result: ProcessResult) => void
  const process: ProcessHandle = {
    pid: 901,
    result: new Promise((resolve) => { finishProcess = resolve }),
    terminate() {
      terminated++
      finishProcess({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" })
    },
  }
  const runner: ProcessRunner = {
    async run(input) {
      calls.push(input.argv)
      if (input.argv[0] === "git") return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      if (input.argv.some((part) => part.endsWith("/ssh"))) {
        if (input.argv.includes("symbolic-ref")) return { exitCode: 0, signal: null, stdout: `${remoteState.branch}\n`, stderr: "" }
        if (input.argv.includes("merge-base")) return { exitCode: remoteState.lineage ? 0 : 1, signal: null, stdout: "", stderr: "" }
        if (input.argv.includes("rev-parse")) return { exitCode: 0, signal: null, stdout: `${remoteState.head}\n`, stderr: "" }
        if (input.argv.includes("diff") && input.argv.includes("--cached")) return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "" }
    },
  }
  const provider = new ExedevProvider({
    config: parseConfig({ healthTimeoutMs: 1 }, { HOME: root }),
    control: {
      async create() {
        created++
        throw new Error("exe.dev create must not be called during adoption")
      },
      async copy() {
        copied++
        throw new Error("exe.dev copy must not be called during adoption")
      },
      async list() {
        if (options.listError) throw new SandboxError("discover", "inventory unavailable", "EXEDEV_COMMAND")
        return options.foreign ? [vm, foreign] : [vm]
      },
      async remove() {
        removed++
      },
      async tag() {},
    },
    worktree: root,
    localControlSocket: join(root, "control.sock"),
    runner,
    supervisor: {
      async start() {
        started++
        return process
      },
    },
    reservePort: async () => 4100,
    ensureVmHostKey: async () => {},
    controlTokenFor: async () => "remote-token",
    revokeControlToken: () => { revoked++ },
    authContent: "{}",
    durableMetadataForResource: async (resourceId, requested) => {
      if (resourceId !== identity.name && resourceId !== identity.id) return undefined
      if (requested && (
        requested.projectId !== owner.projectId ||
        requested.sessionId !== owner.sessionId ||
        requested.generation !== owner.generation ||
        requested.workspaceId !== owner.workspaceId ||
        requested.directory !== owner.directory ||
        requested.branch !== owner.branch ||
        requested.baseSha !== owner.baseSha
      )) return undefined
      return metadata
    },
    fetcher: (async () => Response.json({ healthy: options.healthy ?? true, version: "1.18.23" })) as unknown as typeof fetch,
  })

  return {
    driver: provider.runtimeDriver(),
    owner,
    vm,
    metadata,
    remoteDirectory: metadata.remoteDirectory,
    calls,
    setRemoteState(state: Partial<typeof remoteState>) {
      Object.assign(remoteState, state)
    },
    get started() { return started },
    get terminated() { return terminated },
    get revoked() { return revoked },
    get created() { return created },
    get copied() { return copied },
    get removed() { return removed },
  }
}

async function createSbxRuntimeFixture(options: { marker?: unknown; status?: string; healthy?: boolean; head?: string; lineage?: boolean } = {}) {
  const root = await temporaryDirectory()
  const owner = {
    provider: "sbx" as const,
    ownershipId: "o".repeat(43),
    sessionId: "ses_sbx_restart",
    generation: 2,
    workspaceId: "wrk_sbx_restart",
    projectId: "prj_1",
    directory: root,
    branch: "opencode/sbx-restart",
    baseSha: "0123456789012345678901234567890123456789",
  }
  const marker = options.marker && typeof options.marker === "object" && !Array.isArray(options.marker)
    ? { ...owner, ...(options.marker as Record<string, unknown>) }
    : options.marker ?? { ...owner }
  const sandbox = "oc-sbx-restart"
  const hostPort = 4101
  const remoteDirectory = "/workspace/project"
  const remoteState = {
    head: options.head ?? owner.baseSha,
    lineage: options.lineage ?? true,
  }
  const calls: string[][] = []
  let started = 0
  let terminated = 0
  let revoked = 0
  let finishProcess!: (result: ProcessResult) => void
  const process: ProcessHandle = {
    pid: 900,
    result: new Promise((resolve) => { finishProcess = resolve }),
    terminate() {
      terminated++
      finishProcess({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" })
    },
  }
  const provider = new SbxProvider({
    worktree: root,
    deferActivation: true,
    localControlSocket: join(root, "control.sock"),
    remotePort: 4096,
    healthTimeoutMs: 100,
    authContent: "{}",
    ownerForResource: async (resourceId, requested) => {
      if (resourceId !== sandbox) return undefined
      if (requested && (
        requested.sessionId !== owner.sessionId ||
        requested.generation !== owner.generation ||
        requested.workspaceId !== owner.workspaceId ||
        requested.projectId !== owner.projectId
      )) return undefined
      return owner
    },
    controlTokenFor: async () => "t".repeat(43),
    revokeControlToken: () => { revoked++ },
    supervisor: {
      async start() {
        started++
        return process
      },
    },
    fetcher: (async () => Response.json({ healthy: options.healthy ?? true })) as unknown as typeof fetch,
    runner: {
      async run(input) {
        calls.push(input.argv)
        if (input.argv[0] === "git") {
          if (input.argv.includes("remote")) return { exitCode: 0, signal: null, stdout: "sandbox remote\n", stderr: "" }
          return { exitCode: 0, signal: null, stdout: "", stderr: "" }
        }
        if (input.argv[0] !== "sbx") return { exitCode: 0, signal: null, stdout: "", stderr: "" }
        const args = input.argv.slice(1)
        if (args[0] === "ls") {
          return { exitCode: 0, signal: null, stdout: JSON.stringify({ sandboxes: [{ name: sandbox, status: options.status ?? "running" }] }), stderr: "" }
        }
        if (args[0] === "cp") {
          await writeFile(input.argv.at(-1)!, JSON.stringify(marker))
          return { exitCode: 0, signal: null, stdout: "", stderr: "" }
        }
        if (args[0] === "ports") {
          return { exitCode: 0, signal: null, stdout: JSON.stringify([{ hostIp: "127.0.0.1", hostPort, sandboxPort: 4096 }]), stderr: "" }
        }
        if (args[0] === "create") throw new Error("SBX create must not be called during adoption")
        if (args[0] === "exec") {
          if (input.argv.includes("--show-toplevel")) return { exitCode: 0, signal: null, stdout: "/workspace/project\n", stderr: "" }
          if (input.argv.includes("symbolic-ref")) return { exitCode: 0, signal: null, stdout: `${owner.branch}\n`, stderr: "" }
          if (input.argv.includes("merge-base")) return { exitCode: remoteState.lineage ? 0 : 1, signal: null, stdout: "", stderr: "" }
          if (input.argv.includes("rev-parse")) return { exitCode: 0, signal: null, stdout: `${remoteState.head}\n`, stderr: "" }
          if (input.argv.includes("diff") && input.argv.includes("--cached")) return { exitCode: 1, signal: null, stdout: "", stderr: "" }
          return { exitCode: 0, signal: null, stdout: "", stderr: "" }
        }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" }
      },
    },
  })

  return {
    driver: provider.runtimeDriver(),
    provider,
    owner,
    sandbox,
    hostPort,
    remoteDirectory,
    calls,
    get started() { return started },
    get terminated() { return terminated },
    get revoked() { return revoked },
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
