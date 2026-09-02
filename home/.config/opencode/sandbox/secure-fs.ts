import { lstat, mkdir, chmod, unlink } from "node:fs/promises"
import { dirname, isAbsolute } from "node:path"

import { isNodeError, SandboxError } from "./types"

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  if (!isAbsolute(directory)) throw new SandboxError("validate", "managed directory must be absolute", "PATH_INVALID")

  const missing: string[] = []
  let current = directory
  while (true) {
    try {
      await assertExistingDirectory(current)
      break
    } catch (error) {
      if (!(error instanceof SandboxError) || error.code !== "PATH_MISSING") throw error
      missing.push(current)
      const parent = dirname(current)
      if (parent === current) throw new SandboxError("validate", "could not create managed directory", "PATH_CREATE")
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
    throw new SandboxError("validate", `managed directory is accessible by another user: ${directory}`, "PATH_MODE")
  }
}

async function assertExistingDirectory(directory: string): Promise<void> {
  let stats
  try {
    stats = await lstat(directory)
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new SandboxError("validate", `managed directory does not exist: ${directory}`, "PATH_MISSING")
    }
    throw error
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new SandboxError("validate", `managed path is not a directory: ${directory}`, "PATH_INVALID")
  }
}

export async function assertPrivateFile(path: string): Promise<void> {
  const stats = await lstat(path).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) throw new SandboxError("validate", `file does not exist: ${path}`, "PATH_MISSING")
    throw error
  })
  if (!stats.isFile() || stats.isSymbolicLink()) throw new SandboxError("validate", `path is not a file: ${path}`, "PATH_INVALID")
  assertOwner(stats.uid, path)
  if ((stats.mode & 0o077) !== 0) throw new SandboxError("validate", `file is accessible by another user: ${path}`, "PATH_MODE")
}

export async function preparePrivateSocket(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new SandboxError("validate", "socket path must be absolute", "SOCKET_PATH")
  await ensurePrivateDirectory(dirname(path))

  try {
    const stats = await lstat(path)
    if (!stats.isSocket() || stats.isSymbolicLink()) {
      throw new SandboxError("validate", `refusing to unlink non-socket path: ${path}`, "SOCKET_PATH")
    }
    assertOwner(stats.uid, path)
    if ((stats.mode & 0o077) !== 0) throw new SandboxError("validate", `socket is accessible by another user: ${path}`, "SOCKET_MODE")
    await unlink(path)
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return
    throw error
  }
}

function assertOwner(uid: number, path: string): void {
  const expected = process.getuid?.()
  if (expected !== undefined && uid !== expected) {
      throw new SandboxError("validate", `managed path has unexpected owner: ${path}`, "PATH_OWNER")
  }
}
