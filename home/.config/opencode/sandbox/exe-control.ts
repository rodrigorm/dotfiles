import { isRecord, SandboxError, type CopyVmInput, type CreateVmInput, type ProcessRunner, type VmIdentity, type VmInfo } from "./types"
import { identityMatches, assertSafeComment, assertSafeSshDestination, assertSafeTag, assertSafeVmName, quoteRemoteCommandPart } from "./naming"
import { nodeProcessRunner, sanitizeEnvironment } from "./process"
import { redactError } from "./redaction"
import { DEFAULT_SSH_BIN, fixedSshOptions } from "./remote-runtime"

export interface ExeControl {
  create(input: CreateVmInput): Promise<VmInfo>
  copy(input: CopyVmInput): Promise<VmInfo>
  list(): Promise<VmInfo[]>
  remove(identity: VmIdentity): Promise<void>
  tag(name: string, tags: string[]): Promise<void>
  replaceTags?(identity: VmIdentity, tags: string[]): Promise<void>
  comment?(name: string, comment: string): Promise<void>
}

export interface SshExeControlOptions {
  sshBin?: string
  lobby: string
  knownHostsFile: string
  runner?: ProcessRunner
}

export function buildExeDevSshArgv(
  options: { sshBin: string; lobby: string; knownHostsFile: string },
  command: readonly string[],
): string[] {
  if (!options.sshBin || !options.lobby || !options.knownHostsFile || command.length === 0) {
    throw new SandboxError("validate", "SSH command configuration is incomplete", "SSH_CONFIG")
  }
  return [
    options.sshBin,
    ...fixedSshOptions(options.knownHostsFile),
    options.lobby,
    ...command.map(quoteRemoteCommandPart),
  ]
}

export class SshExeControl implements ExeControl {
  private readonly options: Required<Omit<SshExeControlOptions, "runner">> & { runner: ProcessRunner }

  constructor(options: SshExeControlOptions) {
    this.options = {
      sshBin: options.sshBin ?? DEFAULT_SSH_BIN,
      lobby: options.lobby,
      knownHostsFile: options.knownHostsFile,
      runner: options.runner ?? nodeProcessRunner,
    }
  }

  async create(input: CreateVmInput): Promise<VmInfo> {
    assertSafeVmName(input.name)
    input.tags.forEach(assertSafeTag)
    assertSafeComment(input.comment)
    const command = [
      "new",
      "--name",
      input.name,
      "--cpu",
      String(input.cpu),
      "--memory",
      input.memory,
      "--no-email",
      "--comment",
      input.comment,
      ...input.tags.flatMap((tag) => ["--tag", tag]),
      "--json",
    ]
    return this.runVmCommand(command)
  }

  async copy(input: CopyVmInput): Promise<VmInfo> {
    assertSafeVmName(input.name)
    assertSafeVmName(input.baseVm)
    input.tags.forEach(assertSafeTag)
    assertSafeComment(input.comment)
    const command = [
      "cp",
      input.baseVm,
      input.name,
      "--copy-tags=false",
      "--cpu",
      String(input.cpu),
      "--memory",
      input.memory,
      "--json",
    ]
    const vm = await this.runVmCommand(command)
    await this.tag(input.name, input.tags)
    await this.comment(input.name, input.comment)
    return {
      ...vm,
      identity: {
        ...vm.identity,
        name: input.name,
        tags: [...input.tags],
        comment: input.comment,
      },
    }
  }

  async list(): Promise<VmInfo[]> {
    const result = await this.runJson(["ls", "--json"])
    return parseVmList(result)
  }

  async remove(identity: VmIdentity): Promise<void> {
    assertSafeVmName(identity.name)
    assertSafeSshDestination(identity.sshDest)
    const matches = (await this.list()).filter((item) => identityMatches(identity, item.identity))
    if (matches.length !== 1) {
    throw new SandboxError("remove", "VM identity did not match exactly one observed VM", "VM_IDENTITY_MISMATCH")
    }
    await this.runJson(["rm", identity.name, "--json"])
  }

  async tag(name: string, tags: string[]): Promise<void> {
    assertSafeVmName(name)
    if (tags.length === 0) throw new SandboxError("validate", "at least one VM tag is required", "TAG_EMPTY")
    tags.forEach(assertSafeTag)
    await this.runJson(["tag", name, ...tags, "--json"])
  }

  async comment(name: string, comment: string): Promise<void> {
    assertSafeVmName(name)
    assertSafeComment(comment)
    await this.runJson(["comment", name, comment, "--json"])
  }

  async replaceTags(identity: VmIdentity, tags: string[]): Promise<void> {
    assertSafeVmName(identity.name)
    tags.forEach(assertSafeTag)
    if (identity.tags.length > 0) await this.runJson(["tag", "-d", identity.name, ...identity.tags, "--json"])
    if (tags.length > 0) await this.runJson(["tag", identity.name, ...tags, "--json"])
  }

  private async runVmCommand(command: string[]): Promise<VmInfo> {
    const value = await this.runJson(command)
    return parseVm(value)
  }

  private async runJson(command: string[]): Promise<unknown> {
    const result = await this.options.runner.run({
      argv: buildExeDevSshArgv(this.options, command),
      env: sanitizeEnvironment(),
      maxOutputBytes: 512 * 1024,
    })
    if (result.exitCode !== 0) {
    throw new SandboxError("discover", redactError(result.stderr || result.stdout), "EXEDEV_COMMAND")
    }
    try {
      return JSON.parse(result.stdout.trim())
    } catch {
    throw new SandboxError("discover", "exe.dev returned invalid JSON", "EXEDEV_JSON")
    }
  }
}

export function parseVmList(value: unknown): VmInfo[] {
  if (Array.isArray(value)) return value.map(parseVm)
  if (isRecord(value) && Array.isArray(value.vms)) return value.vms.map(parseVm)
  if (isRecord(value) && value.vm !== undefined) return [parseVm(value.vm)]
  return [parseVm(value)]
}

export function parseVm(value: unknown): VmInfo {
  if (!isRecord(value)) throw new SandboxError("discover", "exe.dev VM response is not an object", "EXEDEV_SCHEMA")
  const name = stringField(value, "vm_name", "name")
  const sshDest = stringField(value, "ssh_dest", "sshDest")
  assertSafeVmName(name)
  assertSafeSshDestination(sshDest)

  const tags = value.tags === undefined ? [] : value.tags
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
    throw new SandboxError("discover", "exe.dev returned invalid VM tags", "EXEDEV_SCHEMA")
  }
  tags.forEach(assertSafeTag)

  const identity: VmIdentity = {
    name,
    sshDest,
    tags: [...tags],
    comment: typeof value.comment === "string" ? value.comment : "",
  }
  const id = optionalString(value.id ?? value.vm_id)
  const sshUser = optionalString(value.ssh_user ?? value.sshUser)
  const sshHost = optionalString(value.ssh_host ?? value.sshHost)
  const region = optionalString(value.region)
  if (id) identity.id = id
  if (sshUser) identity.sshUser = sshUser
  if (sshHost) identity.sshHost = sshHost
  if (region) identity.region = region
  return { identity, status: optionalString(value.status) }
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key].length > 0) return value[key]
  }
  throw new SandboxError("discover", `exe.dev response is missing ${keys[0]}`, "EXEDEV_SCHEMA")
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
