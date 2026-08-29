import { createHash, randomBytes } from "node:crypto"

import { ExedevError, type VmIdentity, type VmPlan } from "./types"

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SAFE_DESTINATION = /^[A-Za-z0-9][A-Za-z0-9._+@:-]{0,253}$/
const SAFE_TAG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10)
}

export function makeVmPlan(
  input: { workspaceId: string; projectId: string; generation: number },
  random: () => string = () => randomBytes(16).toString("hex"),
): VmPlan {
  assertId(input.workspaceId, "workspaceId")
  assertId(input.projectId, "projectId")
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new ExedevError("validate", "generation must be a positive integer", "GENERATION_INVALID")
  }

  const workspaceHash = shortHash(input.workspaceId)
  const projectHash = shortHash(input.projectId)
  const randomValue = random()
  if (!/^[a-f0-9]{16,64}$/i.test(randomValue)) {
    throw new ExedevError("validate", "random generation value is invalid", "GENERATION_RANDOM_INVALID")
  }

  const vmName = `oc-${workspaceHash}`
  const branch = `opencode/exedev-${workspaceHash}`
  const tags = [
    "opencode-exedev",
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
  if (!SAFE_NAME.test(value)) throw new ExedevError("validate", "VM name is unsafe", "VM_NAME_INVALID")
}

export function assertSafeBranch(value: string): void {
  if (
    value.length === 0 ||
    value.length > 255 ||
    value.startsWith("-") ||
    value.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
  ) {
    throw new ExedevError("validate", "branch name is unsafe", "BRANCH_INVALID")
  }
}

export function assertSafeTag(value: string): void {
  if (!SAFE_TAG.test(value)) throw new ExedevError("validate", "VM tag is unsafe", "TAG_INVALID")
}

export function assertSafeSshDestination(value: string): void {
  if (!SAFE_DESTINATION.test(value) || value.includes("..@") || value.startsWith("-")) {
    throw new ExedevError("validate", "SSH destination is unsafe", "SSH_DESTINATION_INVALID")
  }
}

function assertId(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new ExedevError("validate", `${field} is unsafe`, "IDENTIFIER_INVALID")
  }
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index])
}
