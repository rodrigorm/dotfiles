import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FIXED_EDIT_COMMAND } from "./cloudflare-e2e"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("Cloudflare E2E fixed edit", () => {
  it("runs through OpenCode eval with simulated remote commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloudflare-e2e-fixed-edit-"))
    temporaryDirectories.push(root)
    const worktree = join(root, "worktree")
    await mkdir(worktree)
    const file = join(worktree, "host-e2e-untracked.txt")
    await writeFile(file, "host-e2e-untracked:test\n")
    await writeFile(join(worktree, "README.md"), "<!-- opencode-cloudflare-e2e:test -->\n")

    expect(FIXED_EDIT_COMMAND).not.toMatch(/[$]/)
    expect(FIXED_EDIT_COMMAND).not.toContain("\n")
    const child = Bun.spawn(["/bin/sh", "-c", `uname() { printf 'Linux\\n'; }; pwd() { printf '/workspace/.opencode-worktree\\n'; }; eval ${JSON.stringify(FIXED_EDIT_COMMAND)}`], {
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
})
