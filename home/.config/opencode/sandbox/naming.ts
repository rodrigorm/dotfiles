import { createHash, randomBytes } from "node:crypto"

import { SandboxError, type VmIdentity, type VmPlan } from "./types"

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SAFE_DESTINATION = /^[A-Za-z0-9][A-Za-z0-9._+@:-]{0,253}$/
const SAFE_TAG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_COMMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const SAFE_REMOTE_COMMAND_PART = /^[A-Za-z0-9_.,:/@%+=-]+$/

export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10)
}

export function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

export function makeVmPlan(
  input: { workspaceId: string; projectId: string; generation: number },
  random: () => string = () => randomBytes(16).toString("hex"),
): VmPlan {
  assertId(input.workspaceId, "workspaceId")
  assertId(input.projectId, "projectId")
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new SandboxError("validate", "generation must be a positive integer", "GENERATION_INVALID")
  }

  const workspaceHash = shortHash(input.workspaceId)
  const projectHash = shortHash(input.projectId)
  const randomValue = random()
  if (!/^[a-f0-9]{16,64}$/i.test(randomValue)) {
    throw new SandboxError("validate", "random generation value is invalid", "GENERATION_RANDOM_INVALID")
  }

  const vmName = `oc-${workspaceHash}`
  const branch = `opencode/sandbox-${workspaceHash}`
  const tags = [
    "opencode-sandbox",
    `opencode-workspace-${workspaceHash}`,
    `opencode-project-${projectHash}`,
    `opencode-generation-${randomValue}`,
  ]
  const comment = `opencode-${randomValue}`

  assertSafeVmName(vmName)
  assertSafeBranch(branch)
  tags.forEach((tag) => assertSafeTag(tag))

  return { vmName, branch, tags, comment }
}

export function identityMatches(expected: VmIdentity, observed: VmIdentity): boolean {
  if (expected.id !== observed.id) return false
  if (expected.name !== observed.name) return false
  if (expected.sshDest !== observed.sshDest) return false
  if (expected.sshUser !== observed.sshUser) return false
  if (expected.sshHost !== observed.sshHost) return false
  if (expected.region !== observed.region) return false
  if (expected.comment !== observed.comment) return false
  return sameSet(expected.tags, observed.tags)
}

export function assertSafeVmName(value: string): void {
  if (!SAFE_NAME.test(value)) throw new SandboxError("validate", "VM name is unsafe", "VM_NAME_INVALID")
}

export function assertSafeBranch(value: string): void {
  if (
    value.length === 0 ||
    value.length > 255 ||
    value.startsWith("-") ||
    value.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
  ) {
    throw new SandboxError("validate", "branch name is unsafe", "BRANCH_INVALID")
  }
}

export function assertSha(value: string): void {
  if (!/^[a-f0-9]{40}$/i.test(value)) throw new SandboxError("checkout", "workspace SHA is invalid", "GIT_HEAD")
}

export function assertSafeTag(value: string): void {
  if (!SAFE_TAG.test(value)) throw new SandboxError("validate", "VM tag is unsafe", "TAG_INVALID")
}

export function assertSafeComment(value: string): void {
  if (!SAFE_COMMENT.test(value)) throw new SandboxError("validate", "VM comment is unsafe", "COMMENT_INVALID")
}

export function quoteRemoteCommandPart(value: string): string {
  return SAFE_REMOTE_COMMAND_PART.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`
}

export function assertSafeSshDestination(value: string): void {
  if (!SAFE_DESTINATION.test(value) || value.includes("..@") || value.startsWith("-")) {
    throw new SandboxError("validate", "SSH destination is unsafe", "SSH_DESTINATION_INVALID")
  }
}

export function assertRelativePath(value: string): void {
  if (!value || value.startsWith("/") || value.includes("\0") || value.includes("\r") || value.includes("\n") || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new SandboxError("sync", "untracked path is unsafe", "CAPTURE_PATH")
  }
}

export function isSafeSandboxPath(value: unknown): value is string {
  return typeof value === "string" && /^\/[A-Za-z0-9._/-]+$/.test(value) && !value.includes("..")
}

function assertId(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new SandboxError("validate", `${field} is unsafe`, "IDENTIFIER_INVALID")
  }
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index])
}
