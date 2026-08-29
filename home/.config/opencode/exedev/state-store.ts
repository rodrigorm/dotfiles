import { createHash, randomBytes } from "node:crypto"
import { lstat, readFile, readdir, rename, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"

import { ExedevError, isExedevState, type ExedevRecord } from "./types"
import { assertPrivateDirectory, assertPrivateFile, ensurePrivateDirectory, openExclusive } from "./secure-fs"

export class FileStateStore {
  readonly root: string
  private readonly now: () => Date

  constructor(root: string, now: () => Date = () => new Date()) {
    this.root = root
    this.now = now
  }

  async get(sessionId: string): Promise<ExedevRecord | undefined> {
    await ensurePrivateDirectory(this.root)
    const path = this.recordPath(sessionId)
    try {
      const stats = await lstat(path)
      if (stats.isSymbolicLink() || !stats.isFile()) throw new ExedevError("validate", "state record is not a regular file", "STATE_FILE")
      if (process.getuid?.() !== undefined && stats.uid !== process.getuid()) {
        throw new ExedevError("validate", "state record has an unexpected owner", "STATE_OWNER")
      }
      if ((stats.mode & 0o077) !== 0) throw new ExedevError("validate", "state record is accessible by another user", "STATE_MODE")
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined
      throw error
    }

    const text = await readFile(path, "utf8")
    return validateRecord(JSON.parse(text), sessionId)
  }

  async list(): Promise<ExedevRecord[]> {
    await ensurePrivateDirectory(this.root)
    const entries = await readdir(this.root, { withFileTypes: true })
    const records: ExedevRecord[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      const path = join(this.root, entry.name)
      await assertPrivateFile(path)
      const text = await readFile(path, "utf8")
      records.push(validateRecord(JSON.parse(text)))
    }
    return records.sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  }

  recordPath(sessionId: string): string {
    return join(this.root, `${hash(sessionId)}.json`)
  }

  async write(record: ExedevRecord): Promise<void> {
    validateRecord(record)
    await ensurePrivateDirectory(this.root)
    await this.withLock(record.sessionId, async () => {
      await this.writeUnlocked(record)
    })
  }

  async compareAndSwap(
    sessionId: string,
    expectedGeneration: number,
    next: ExedevRecord,
  ): Promise<boolean> {
    if (next.sessionId !== sessionId) throw new ExedevError("validate", "state session does not match CAS key", "STATE_SESSION")
    validateRecord(next)
    await ensurePrivateDirectory(this.root)
    return this.withLock(sessionId, async () => {
      const current = await this.get(sessionId)
      const currentGeneration = current?.generation ?? 0
      if (currentGeneration !== expectedGeneration) return false
      if (next.generation !== expectedGeneration + 1) {
        throw new ExedevError("validate", "CAS generation must advance exactly once", "STATE_GENERATION")
      }
      await this.writeUnlocked(next)
      return true
    })
  }

  async withLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    await ensurePrivateDirectory(this.root)
    const lockPath = join(this.root, `.${hash(sessionId)}.lock`)
    let handle
    try {
      handle = await openExclusive(lockPath)
      await handle.writeFile(`${process.pid}\n`)
      return await operation()
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        throw new ExedevError("validate", `session is already locked: ${sessionId}`, "STATE_LOCKED")
      }
      throw error
    } finally {
      await handle?.close().catch(() => undefined)
      await unlink(lockPath).catch(() => undefined)
    }
  }

  async withRecordLock<T>(
    sessionId: string,
    operation: (
      current: ExedevRecord | undefined,
      write: (record: ExedevRecord) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    return this.withLock(sessionId, async () => {
      const current = await this.get(sessionId)
      const write = async (record: ExedevRecord): Promise<void> => {
        if (record.sessionId !== sessionId) {
          throw new ExedevError("validate", "state session does not match lock key", "STATE_SESSION")
        }
        validateRecord(record)
        await this.writeUnlocked(record)
      }
      return operation(current, write)
    })
  }

  private async writeUnlocked(record: ExedevRecord): Promise<void> {
    const path = this.recordPath(record.sessionId)
    await assertPrivateDirectory(dirname(path))
    await rejectSymlink(path)

    const temporaryPath = join(this.root, `.${hash(record.sessionId)}.${randomBytes(8).toString("hex")}.tmp`)
    const handle = await openExclusive(temporaryPath)
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, path)
  }
}

function validateRecord(value: unknown, expectedSessionId?: string): ExedevRecord {
  if (!isRecord(value)) throw new ExedevError("validate", "state record must be an object", "STATE_SCHEMA")
  if (containsCredentialKey(value)) throw new ExedevError("validate", "state record contains a credential field", "STATE_SECRET")

  const requiredStrings = ["sessionId", "workspaceId", "projectId", "vmName", "directory", "branch", "baseSha", "createdAt", "updatedAt"]
  for (const key of requiredStrings) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new ExedevError("validate", `state field ${key} is invalid`, "STATE_SCHEMA")
    }
  }
  if (expectedSessionId !== undefined && value.sessionId !== expectedSessionId) {
    throw new ExedevError("validate", "state record session does not match filename", "STATE_SESSION")
  }
  if (typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1) {
    throw new ExedevError("validate", "state generation is invalid", "STATE_SCHEMA")
  }
  if (!isExedevState(value.state)) throw new ExedevError("validate", "state lifecycle value is invalid", "STATE_SCHEMA")
  if (!isRecord(value.vmIdentity) || typeof value.vmIdentity.name !== "string" || typeof value.vmIdentity.sshDest !== "string") {
    throw new ExedevError("validate", "VM identity is invalid", "STATE_SCHEMA")
  }
  if (!Array.isArray(value.vmIdentity.tags) || value.vmIdentity.tags.some((tag) => typeof tag !== "string")) {
    throw new ExedevError("validate", "VM tags are invalid", "STATE_SCHEMA")
  }
  return value as unknown as ExedevRecord
}

function containsCredentialKey(value: Record<string, unknown>): boolean {
  for (const [key, item] of Object.entries(value)) {
    if (/(?:password|token|secret|credential|auth(?:orization|_content)?)/i.test(key)) return true
    if (isRecord(item) && containsCredentialKey(item)) return true
    if (Array.isArray(item) && item.some((entry) => isRecord(entry) && containsCredentialKey(entry))) return true
  }
  return false
}

async function rejectSymlink(path: string): Promise<void> {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) throw new ExedevError("validate", `refusing to replace symlink: ${path}`, "STATE_SYMLINK")
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return
    throw error
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}
