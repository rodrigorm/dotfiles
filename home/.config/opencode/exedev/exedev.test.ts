import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DEFAULT_CONFIG, parseConfig } from "./config"
import { ControlChannel, createCapability, parseControlRequest } from "./control-channel"
import { buildExeDevSshArgv } from "./exe-control"
import { canTransition, nextStateFor } from "./state"
import { FileStateStore } from "./state-store"
import { buildSupervisorArgv } from "./remote-runtime"
import { parseCliArgs, requestControl, runCli } from "./cli"
import { identityMatches, makeVmPlan } from "./naming"
import { redactText } from "./redaction"
import { LifecycleController } from "./lifecycle"
import { createExedevPlugin, type WorkspaceAdapterLike } from "./plugin-runtime"
import { nodeProcessRunner } from "./process"
import { captureWorkingTree } from "./working-tree"
import type { ExedevRecord } from "./types"

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

describe("exedevctl parser", () => {
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
})

describe("configuration", () => {
  it("fills the personal defaults and expands the state path", () => {
    const config = parseConfig({}, { HOME: "/Users/tester" })

    expect(config).toMatchObject({
      ...DEFAULT_CONFIG,
      stateDirectory: "/Users/tester/.local/state/opencode-exedev",
      knownHostsFile: "/Users/tester/.local/state/opencode-exedev/known_hosts",
    })
  })

  it("rejects unknown keys and unsafe provider identifiers", () => {
    expect(() => parseConfig({ unexpected: true }, { HOME: "/tmp" })).toThrow(/unknown configuration key/i)
    expect(() => parseConfig({ baseVm: "vm; rm -rf /" }, { HOME: "/tmp" })).toThrow(/baseVm/i)
    expect(() => parseConfig({ sshLobby: "exe.dev && whoami" }, { HOME: "/tmp" })).toThrow(/sshLobby/i)
  })
})

describe("lifecycle state", () => {
  it("allows only the documented transitions", () => {
    expect(canTransition("local", "provisioning")).toBe(true)
    expect(canTransition("remote", "detached")).toBe(false)
    expect(nextStateFor("detached", "start")).toBe("provisioning")
    expect(nextStateFor("remote", "start")).toBe("remote")
    expect(nextStateFor("remote", "stop")).toBe("stop_pending")
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
    expect(plan.branch).toMatch(/^opencode\/exedev-[0-9a-f]{10}$/)
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
      tags: ["opencode-exedev", "opencode-generation-abc"],
      comment: "opencode-abc",
    }

    expect(identityMatches(identity, { ...identity, tags: [...identity.tags].reverse() })).toBe(true)
    expect(identityMatches(identity, { ...identity, sshDest: "other.exe.xyz" })).toBe(false)
    expect(identityMatches(identity, { ...identity, tags: ["opencode-exedev"] })).toBe(false)
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
})

describe("state store", () => {
  it("writes records atomically and compare-and-swaps generations", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    const record = makeRecord()

    await store.write(record)
    await expect(store.compareAndSwap(record.sessionId, 0, { ...record, generation: 2 })).resolves.toBe(false)
    await expect(store.compareAndSwap(record.sessionId, 1, { ...record, generation: 2 })).resolves.toBe(true)

    const saved = await readFile(store.recordPath(record.sessionId), "utf8")
    expect(JSON.parse(saved)).toMatchObject({ generation: 2 })
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
      fence: { supported: true },
      capture: async () => ({ baseSha: "0123456789012345678901234567890123456789", patch: "", untracked: [] }),
      workspace: {
        async create(input) {
          calls.push(`create:${input.type}`)
          return {
            id: "wrk_1",
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
                tags: ["opencode-exedev"],
                comment: "opencode-abc",
              },
            },
          }
        },
        async warp(input) {
          calls.push(`warp:${input.workspaceId ?? "local"}`)
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
    expect(calls).toContain("warp:wrk_1")

    const stopped = await controller.handle({ operation: "stop", force: false, capability })
    expect(stopped).toMatchObject({ ok: true, operation: "stop", state: "stop_pending" })
    await controller.onSessionIdle("ses_1")
    expect((await store.get("ses_1"))?.state).toBe("detached")
    expect(calls).toContain("warp:local")
    expect(calls).toContain("remove:wrk_1")
  })

  it("fails closed when the real OpenCode fencing seam is unavailable", async () => {
    const controller = new LifecycleController({
      store: new FileStateStore(await temporaryDirectory()),
      fence: { supported: false, reason: "no pre-routing admission hook" },
      workspace: {
        async create() {
          throw new Error("must not create")
        },
        async warp() {},
        async remove() {},
      },
      capture: async () => ({ baseSha: "0123456789012345678901234567890123456789", patch: "", untracked: [] }),
    })
    controller.registerContext({ sessionId: "ses_2", projectId: "prj_1", directory: "/tmp/project", worktree: "/tmp/project" })

    const result = await controller.handle({
      operation: "start",
      force: false,
      capability: createCapability({ sessionId: "ses_2", generation: 1, role: "host" }),
    })
    expect(result).toMatchObject({ ok: false, operation: "start", state: "error", stage: "fencing" })
  })

  it("reuses the VM identity and branch when resuming a detached session", async () => {
    const root = await temporaryDirectory()
    const store = new FileStateStore(root)
    const existing = { ...makeRecord(), state: "detached" as const, vmName: "oc-existing", branch: "opencode/exedev-existing" }
    await store.write(existing)
    let createdBranch = ""
    const controller = new LifecycleController({
      store,
      fence: { supported: true },
      capture: async () => ({ baseSha: existing.baseSha, patch: "", untracked: [] }),
      workspace: {
        async create(input) {
          createdBranch = input.branch
          return {
            id: "wrk-resumed",
            type: "exedev",
            name: "resumed",
            branch: input.branch,
            directory: existing.directory,
            projectID: existing.projectId,
            extra: null,
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
})

describe("plugin runtime", () => {
  it("does not register when experimental workspaces are disabled", async () => {
    const root = await temporaryDirectory()
    let registered = 0
    const logs: string[] = []

    const hooks = await createExedevPlugin(
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
    const hooks = await createExedevPlugin(
      {
        project: { id: "prj_1" },
        directory: root,
        worktree: root,
        serverUrl: new URL("http://127.0.0.1:4096"),
        experimental_workspace: { register: (_type, value) => (adapter = value) },
      },
      {
        env: { HOME: root, XDG_RUNTIME_DIR: root, OPENCODE_EXPERIMENTAL_WORKSPACES: "1" },
        fence: { supported: false, reason: "test fence" },
      },
    )
    if (!hooks || !adapter) throw new Error("plugin did not initialize")
    cleanups.push(hooks.dispose)

    const shellEnv = { env: {} as Record<string, string> }
    await hooks["shell.env"]({ cwd: root, sessionID: "ses_1" }, shellEnv)

    expect(shellEnv.env.EXEDEV_CONTROL_SOCKET).toContain("/c.sock")
    expect(shellEnv.env.EXEDEV_CONTROL_TOKEN).toHaveLength(43)
    expect(shellEnv.env.EXEDEV_CONTROL_ROLE).toBe("host")
    expect(adapter.name).toBe("exe.dev")
  })
})

describe("working tree capture", () => {
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

function makeRecord(): ExedevRecord {
  return {
    sessionId: "ses_1",
    workspaceId: "wrk_1",
    projectId: "prj_1",
    vmName: "oc-0123456789",
    vmIdentity: {
      name: "oc-0123456789",
      sshDest: "vm.exe.xyz",
      tags: ["opencode-exedev"],
      comment: "opencode-abc",
    },
    generation: 1,
    directory: "/tmp/project",
    branch: "opencode/exedev-0123456789",
    baseSha: "0123456789012345678901234567890123456789",
    state: "local",
    createdAt: new Date(1000).toISOString(),
    updatedAt: new Date(1000).toISOString(),
  }
}
