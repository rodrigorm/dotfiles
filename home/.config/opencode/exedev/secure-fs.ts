import { lstat, mkdir, open, chmod, unlink } from "node:fs/promises"
import { dirname, isAbsolute } from "node:path"

import { ExedevError } from "./types"

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  if (!isAbsolute(directory)) throw new ExedevError("validate", "managed directory must be absolute", "PATH_INVALID")

  const missing: string[] = []
  let current = directory
  while (true) {
    try {
      await assertExistingDirectory(current)
      break
    } catch (error) {
      if (!(error instanceof ExedevError) || error.code !== "PATH_MISSING") throw error
      missing.push(current)
      const parent = dirname(current)
      if (parent === current) throw new ExedevError("validate", "could not create managed directory", "PATH_CREATE")
      current = parent
    }
  }

  for (const path of missing.reverse()) {
    await mkdir(path, { mode: 0o700 })
    await assertPrivateDirectory(path)
  }
  await chmod(directory, 0o700)
  await assertPrivateDirectory(directory)
}

export async function assertPrivateDirectory(directory: string): Promise<void> {
  await assertExistingDirectory(directory)
  const stats = await lstat(directory)
  assertOwner(stats.uid, directory)
  if ((stats.mode & 0o077) !== 0) {
    throw new ExedevError("validate", `managed directory is accessible by another user: ${directory}`, "PATH_MODE")
  }
}

async function assertExistingDirectory(directory: string): Promise<void> {
  let stats
  try {
    stats = await lstat(directory)
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new ExedevError("validate", `managed directory does not exist: ${directory}`, "PATH_MISSING")
    }
    throw error
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ExedevError("validate", `managed path is not a directory: ${directory}`, "PATH_INVALID")
  }
}

export async function assertPrivateFile(path: string): Promise<void> {
  const stats = await lstat(path).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) throw new ExedevError("validate", `file does not exist: ${path}`, "PATH_MISSING")
    throw error
  })
  if (!stats.isFile() || stats.isSymbolicLink()) throw new ExedevError("validate", `path is not a file: ${path}`, "PATH_INVALID")
  assertOwner(stats.uid, path)
  if ((stats.mode & 0o077) !== 0) throw new ExedevError("validate", `file is accessible by another user: ${path}`, "PATH_MODE")
}

export async function preparePrivateSocket(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new ExedevError("validate", "socket path must be absolute", "SOCKET_PATH")
  await ensurePrivateDirectory(dirname(path))

  try {
    const stats = await lstat(path)
    if (!stats.isSocket() || stats.isSymbolicLink()) {
      throw new ExedevError("validate", `refusing to unlink non-socket path: ${path}`, "SOCKET_PATH")
    }
    assertOwner(stats.uid, path)
    if ((stats.mode & 0o077) !== 0) throw new ExedevError("validate", `socket is accessible by another user: ${path}`, "SOCKET_MODE")
    await unlink(path)
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return
    throw error
  }
}

export async function assertPrivateSocket(path: string, allowMissing = false): Promise<void> {
  try {
    const stats = await lstat(path)
    if (!stats.isSocket() || stats.isSymbolicLink()) throw new ExedevError("validate", `path is not a socket: ${path}`, "SOCKET_PATH")
    assertOwner(stats.uid, path)
    if ((stats.mode & 0o077) !== 0) throw new ExedevError("validate", `socket is accessible by another user: ${path}`, "SOCKET_MODE")
  } catch (error) {
    if (allowMissing && isNodeError(error, "ENOENT")) return
    throw error
  }
}

export async function openExclusive(path: string, mode = 0o600) {
  return open(path, "wx", mode)
}

function assertOwner(uid: number, path: string): void {
  const expected = process.getuid?.()
  if (expected !== undefined && uid !== expected) {
    throw new ExedevError("validate", `managed path has unexpected owner: ${path}`, "PATH_OWNER")
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}
