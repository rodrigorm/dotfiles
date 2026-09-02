import { setTimeout as delay } from "node:timers/promises"

import {
  copyVmIdentity,
  isRecord,
  SandboxError,
  isWorkspaceSyncResult,
  type WorkingTreeCapture,
  type WorkspaceCreateInput,
  type WorkspaceGateway,
  type WorkspaceInfo,
  type WorkspaceSyncOutInput,
  type WorkspaceSyncResult,
  type WorkspaceRuntimeMetadata,
  type WorkspaceTarget,
  type WorkspaceReplayEvent,
} from "./types"
import { redactText } from "./redaction"

const RESPONSE_LIMIT_BYTES = 512 * 1024
const DEFAULT_SYNC_TIMEOUT_MS = 30_000

export interface HttpWorkspaceGatewayOptions {
  serverUrl: string | URL
  directory: string
  projectId: string
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  captureApplier?: (input: { workspaceId: string; capture: WorkingTreeCapture }) => Promise<void>
  syncOut?: (input: WorkspaceSyncOutInput) => Promise<WorkspaceSyncResult>
  runtimeMetadata?: (workspaceId: string) => WorkspaceRuntimeMetadata | undefined
  sessionEvents?: (sessionId: string) => Promise<WorkspaceReplayEvent[]> | WorkspaceReplayEvent[]
}

export class HttpWorkspaceGateway implements WorkspaceGateway {
  private readonly serverUrl: URL
  private readonly directory: string
  private readonly projectId: string
  private readonly fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  private readonly captureApplier?: (input: { workspaceId: string; capture: WorkingTreeCapture }) => Promise<void>
  private readonly runtimeMetadata?: (workspaceId: string) => WorkspaceRuntimeMetadata | undefined
  private readonly sessionEvents?: HttpWorkspaceGatewayOptions["sessionEvents"]
  readonly syncOut?: (input: WorkspaceSyncOutInput) => Promise<WorkspaceSyncResult>

  constructor(options: HttpWorkspaceGatewayOptions) {
    this.serverUrl = new URL(options.serverUrl)
    this.directory = options.directory
    this.projectId = options.projectId
    this.fetcher = options.fetcher ?? fetch
    this.captureApplier = options.captureApplier
    this.runtimeMetadata = options.runtimeMetadata
    this.sessionEvents = options.sessionEvents
    if (options.syncOut) {
      this.syncOut = async (input) => {
        const result = await options.syncOut!(input)
        if (!isWorkspaceSyncResult(result)) {
          throw new SandboxError("sync", "workspace provider returned an invalid sync result", "WORKSPACE_SYNC_RESULT")
        }
        return result
      }
    }
  }

  async create(input: WorkspaceCreateInput): Promise<WorkspaceInfo> {
    const value = await this.request("/experimental/workspace", {
      method: "POST",
      body: {
        id: input.id,
        type: input.type,
        branch: input.branch,
        extra: input.extra,
      },
    })
    const info = parseWorkspaceInfo(value, this.projectId)
    const metadata = this.runtimeMetadata?.(info.id)
    if (!metadata) return info
    return {
      ...info,
      extra: {
        ...(isRecord(info.extra) ? info.extra : {}),
        ...(metadata.providerState ? { providerState: metadata.providerState } : {}),
        ...(metadata.vmName ? { vmName: metadata.vmName } : {}),
        ...(metadata.vmIdentity ? { vmIdentity: copyVmIdentity(metadata.vmIdentity) } : {}),
      },
    }
  }

  async applyCapture(input: { workspaceId: string; directory: string; capture: WorkingTreeCapture }): Promise<void> {
    if (this.captureApplier) {
      await this.captureApplier({ workspaceId: input.workspaceId, capture: input.capture })
      return
    }
    if (input.capture.untracked.length > 0) {
      throw new SandboxError("sync", "untracked files require the remote capture helper", "UNTRACKED_APPLY_UNAVAILABLE")
    }
    if (!input.capture.patch) return
    await this.request("/vcs/apply", {
      method: "POST",
      directory: input.directory,
      workspace: input.workspaceId,
      body: { patch: input.capture.patch },
    })
  }

  async warp(input: { sessionId: string; workspaceId: string | null; directory: string }): Promise<void> {
    await this.request("/experimental/workspace/warp", {
      method: "POST",
      directory: input.directory,
      body: {
        id: input.workspaceId,
        sessionID: input.sessionId,
        copyChanges: false,
      },
    })
  }

  async replaySession(input: { sessionId: string; target: Extract<WorkspaceTarget, { type: "remote" }> }): Promise<void> {
    const events = await this.sessionEvents?.(input.sessionId) ?? []
    if (events.length === 0) throw new SandboxError("sync", "OpenCode session history is empty", "WORKSPACE_HISTORY")
    for (let index = 0; index < events.length; index += 10) {
      await this.requestTarget(input.target, "/sync/replay", { directory: "", events: events.slice(index, index + 10) })
    }
  }

  async startSync(input: { directory: string }): Promise<void> {
    await this.request("/sync/start", { method: "POST", directory: input.directory })
    await delay(100)
  }

  async remove(input: { workspaceId: string; directory: string }): Promise<void> {
    await this.request(`/experimental/workspace/${encodeURIComponent(input.workspaceId)}`, {
      method: "DELETE",
      directory: input.directory,
    })
  }

  async waitForSync(input: { workspaceId: string; directory: string; timeoutMs: number }): Promise<void> {
    const deadline = Date.now() + Math.min(input.timeoutMs, DEFAULT_SYNC_TIMEOUT_MS)
    while (Date.now() < deadline) {
      const value = await this.request("/experimental/workspace/status", {
        method: "GET",
        directory: input.directory,
      })
      if (Array.isArray(value)) {
        const status = value.find((entry) => isRecord(entry) && entry.workspaceID === input.workspaceId)
        if (isRecord(status) && status.status === "connected") return
        if (isRecord(status) && status.status === "error") {
          throw new SandboxError("sync", "workspace synchronization failed", "WORKSPACE_SYNC")
        }
      }
      await delay(100)
    }
    throw new SandboxError("sync", "timed out waiting for workspace synchronization", "WORKSPACE_SYNC_TIMEOUT")
  }

  private async request(
    path: string,
    options: {
      method: "GET" | "POST" | "DELETE"
      directory?: string
      workspace?: string
      body?: unknown
    },
  ): Promise<unknown> {
    const url = new URL(this.serverUrl)
    url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`
    url.search = new URLSearchParams(
      Object.entries({
        directory: options.directory ?? this.directory,
        workspace: options.workspace,
      }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ).toString()

    const response = await this.fetcher(url, {
      method: options.method,
      headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    const text = await readLimitedBody(response)
    if (!response.ok) {
      throw new SandboxError("control_channel", redactText(text), `WORKSPACE_HTTP_${response.status}`)
    }
    if (response.status === 204 || text.length === 0) return undefined
    try {
      return JSON.parse(text)
    } catch {
      throw new SandboxError("control_channel", "OpenCode workspace response is not valid JSON", "WORKSPACE_JSON")
    }
  }

  private async requestTarget(target: Extract<WorkspaceTarget, { type: "remote" }>, path: string, body: unknown): Promise<void> {
    const url = new URL(target.url)
    url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`
    url.search = ""
    const headers = new Headers(target.headers)
    headers.set("Content-Type", "application/json")
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
    const text = await readLimitedBody(response)
    if (!response.ok) throw new SandboxError("sync", redactText(text), `WORKSPACE_HTTP_${response.status}`)
  }
}

function parseWorkspaceInfo(value: unknown, projectId: string): WorkspaceInfo {
  if (!isRecord(value)) throw new SandboxError("control_channel", "workspace response is not an object", "WORKSPACE_SCHEMA")
  if (typeof value.id !== "string" || value.id.length === 0 || typeof value.type !== "string" || typeof value.name !== "string") {
    throw new SandboxError("control_channel", "workspace response is missing identity fields", "WORKSPACE_SCHEMA")
  }
  if (value.projectID !== projectId) {
    throw new SandboxError("control_channel", "workspace belongs to another project", "WORKSPACE_PROJECT")
  }
  return {
    id: value.id,
    type: value.type,
    name: value.name,
    branch: value.branch === null || typeof value.branch === "string" ? value.branch : null,
    directory: value.directory === null || typeof value.directory === "string" ? value.directory : null,
    extra: value.extra ?? null,
    projectID: value.projectID,
  }
}

async function readLimitedBody(response: Response): Promise<string> {
  if (!response.body) return response.text()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > RESPONSE_LIMIT_BYTES) {
        await reader.cancel()
        throw new SandboxError("control_channel", "workspace response is too large", "WORKSPACE_RESPONSE_LIMIT")
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder().decode(Buffer.concat(chunks, size))
}
