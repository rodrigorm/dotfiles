import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { buildE2EConfig, buildFixedEditCommand, cleanupE2EClone, cleanupE2ERuntimeDirectory, createE2ERuntimeDirectory, prepareE2EClone, selectE2EProvider } from "./cloudflare-e2e"

const temporaryDirectories: string[] = []

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr || stdout}`)
  return stdout
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("sandbox E2E provider selection", () => {
  it("defaults to Cloudflare and accepts SBX or exe.dev explicitly", () => {
    expect(selectE2EProvider({})).toBe("cloudflare")
    expect(selectE2EProvider({ SANDBOX_E2E_PROVIDER: "cloudflare" })).toBe("cloudflare")
    expect(selectE2EProvider({ SANDBOX_E2E_PROVIDER: "sbx" })).toBe("sbx")
    expect(selectE2EProvider({ SANDBOX_E2E_PROVIDER: "exedev" })).toBe("exedev")
    expect(() => selectE2EProvider({ SANDBOX_E2E_PROVIDER: "other" })).toThrow(/cloudflare, sbx, or exedev/i)
  })

  it("does not carry Cloudflare credentials into non-Cloudflare configs", () => {
    const source = { provider: "sbx", apiUrl: "https://source.example.test", apiKey: "source-key" }
    const environment = { provider: "cloudflare", apiUrl: "https://environment.example.test", apiKey: "environment-key" }

    const sbx = buildE2EConfig("sbx", source, environment, {
      SANDBOX_API_URL: "https://env.example.test",
      SANDBOX_API_KEY: "env-key",
    })
    expect(sbx).toMatchObject({ provider: "sbx" })
    expect(sbx).not.toHaveProperty("apiUrl")
    expect(sbx).not.toHaveProperty("apiKey")
    expect(JSON.stringify(sbx)).not.toContain("env-key")

    const exedev = buildE2EConfig("exedev", source, environment, {
      SANDBOX_API_URL: "https://env.example.test",
      SANDBOX_API_KEY: "env-key",
    })
    expect(exedev).toMatchObject({ provider: "exedev" })
    expect(exedev).not.toHaveProperty("apiUrl")
    expect(exedev).not.toHaveProperty("apiKey")
    expect(JSON.stringify(exedev)).not.toContain("env-key")

    expect(buildE2EConfig("cloudflare", source, environment, {
      SANDBOX_API_URL: "https://env.example.test",
      SANDBOX_API_KEY: "env-key",
    })).toMatchObject({ provider: "cloudflare", apiUrl: "https://env.example.test", apiKey: "env-key" })
  })
})

describe("sandbox E2E Git fixture", () => {
  it("checks out a captured revision in an independent clone and cleans only that clone", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloudflare-e2e-git-fixture-"))
    temporaryDirectories.push(root)
    const source = join(root, "source")
    const clone = join(source, "clone")
    await mkdir(source)
    await git(source, ["init", "-q"])
    await writeFile(join(source, "README.md"), "captured\n")
    await git(source, ["add", "README.md"])
    await git(source, ["-c", "user.name=E2E", "-c", "user.email=e2e@example.test", "commit", "-qm", "captured"])
    const revision = (await git(source, ["rev-parse", "HEAD"])).trim()

    const prepared = await prepareE2EClone(source, clone)
    expect(prepared.revision).toBe(revision)
    expect((await stat(join(clone, ".git"))).isDirectory()).toBe(true)
    expect(await readFile(join(clone, "README.md"), "utf8")).toBe("captured\n")
    await expect(readFile(join(clone, ".git", "objects", "info", "alternates"), "utf8")).rejects.toThrow()

    const skipped = await cleanupE2EClone(source, false)
    expect(skipped.attempted).toBe(false)
    expect(await readFile(join(source, "README.md"), "utf8")).toBe("captured\n")

    const cleaned = await cleanupE2EClone(clone, true)
    expect(cleaned.removed).toBe(true)
    await expect(stat(clone)).rejects.toThrow()
    expect(await readFile(join(source, "README.md"), "utf8")).toBe("captured\n")
  })
})

describe("sandbox E2E runtime directory", () => {
  it("uses a private short directory independent of preserved evidence", async () => {
    const evidence = await mkdtemp(join(tmpdir(), "cloudflare-e2e-long-evidence-directory-"))
    temporaryDirectories.push(evidence)

    const runtime = await createE2ERuntimeDirectory()
    expect(basename(runtime)).toMatch(/^oe-e2e-/)
    expect(runtime.startsWith(evidence)).toBe(false)
    expect((await stat(runtime)).mode & 0o777).toBe(0o700)

    await expect(cleanupE2ERuntimeDirectory(runtime, false)).resolves.toMatchObject({ attempted: false, preserved: true })
    await expect(stat(runtime)).resolves.toBeTruthy()
    await expect(cleanupE2ERuntimeDirectory(runtime, true)).resolves.toMatchObject({ attempted: true, removed: true })
    await expect(stat(runtime)).rejects.toThrow()
    await expect(stat(evidence)).resolves.toBeTruthy()
  })
})

describe("sandbox E2E fixed edit", () => {
  it("runs through OpenCode eval with simulated remote commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloudflare-e2e-fixed-edit-"))
    temporaryDirectories.push(root)
    const worktree = join(root, "worktree")
    await mkdir(worktree)
    const file = join(worktree, "host-e2e-untracked.txt")
    await writeFile(file, "host-e2e-untracked:test\n")
    await writeFile(join(worktree, "README.md"), "<!-- opencode-cloudflare-e2e:test -->\n")

    const remoteWorktreePath = "/workspace/.opencode-worktree"
    const command = buildFixedEditCommand(remoteWorktreePath)
    expect(command).not.toMatch(/[$]/)
    expect(command).not.toContain("\n")
    const child = Bun.spawn(["/bin/sh", "-c", `uname() { printf 'Linux\\n'; }; pwd() { printf '${remoteWorktreePath}\\n'; }; eval ${JSON.stringify(command)}`], {
      cwd: worktree,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(await child.exited).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).toBe("Linux\n/workspace/.opencode-worktree\ncloudflare-e2e-remote-edit\ncloudflare-e2e-remote-readme\ncloudflare-e2e-remote-created\nremote-uname=Linux\nremote-cwd=/workspace/.opencode-worktree\n")
    expect(await readFile(file, "utf8")).toBe("host-e2e-untracked:test\ncloudflare-e2e-remote-edit\n")
    expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("<!-- opencode-cloudflare-e2e:test -->\ncloudflare-e2e-remote-readme\n")
    expect(await readFile(join(worktree, "remote-e2e-created.txt"), "utf8")).toBe("cloudflare-e2e-remote-created\n")
  })

  it("uses the runtime path supplied by metadata", () => {
    const remoteWorktreePath = "/workspace/project/.opencode-worktree"
    const command = buildFixedEditCommand(remoteWorktreePath)

    expect(command).toContain(`grep -Fx -- '${remoteWorktreePath}'`)
    expect(command).not.toContain("/workspace/.opencode-worktree")
  })
})
