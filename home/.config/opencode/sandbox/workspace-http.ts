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
export const DEFAULT_WORKSPACE_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_SYNC_TIMEOUT_MS = DEFAULT_WORKSPACE_REQUEST_TIMEOUT_MS
const INSPECTION_TIMEOUT_MS = 5_000
const REPLAY_BATCH_SIZE = 10
export const MAX_REPLAY_EVENTS = 10_000
export const MAX_REPLAY_HISTORY_BYTES = 8 * 1024 * 1024
export const MAX_REPLAY_REQUEST_BYTES = RESPONSE_LIMIT_BYTES
export const DEFAULT_REPLAY_TIMEOUT_MS = DEFAULT_WORKSPACE_REQUEST_TIMEOUT_MS

export interface HttpWorkspaceGatewayOptions {
  serverUrl: string | URL
  directory: string
  projectId: string
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  captureApplier?: (input: { workspaceId: string; capture: WorkingTreeCapture }) => Promise<void>
  syncOut?: (input: WorkspaceSyncOutInput) => Promise<WorkspaceSyncResult>
  runtimeMetadata?: (workspaceId: string) => WorkspaceRuntimeMetadata | undefined
  sessionEvents?: (sessionId: string) => Promise<WorkspaceReplayEvent[]> | WorkspaceReplayEvent[]
  requestTimeoutMs?: number
  replayTimeoutMs?: number
}

export class HttpWorkspaceGateway implements WorkspaceGateway {
  private readonly serverUrl: URL
  private readonly directory: string
  private readonly projectId: string
  private readonly fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  private readonly captureApplier?: (input: { workspaceId: string; capture: WorkingTreeCapture }) => Promise<void>
  private readonly runtimeMetadata?: (workspaceId: string) => WorkspaceRuntimeMetadata | undefined
  private readonly sessionEvents?: HttpWorkspaceGatewayOptions["sessionEvents"]
  private readonly requestTimeoutMs: number
  private readonly replayTimeoutMs: number
  readonly syncOut?: (input: WorkspaceSyncOutInput) => Promise<WorkspaceSyncResult>

  constructor(options: HttpWorkspaceGatewayOptions) {
    this.serverUrl = new URL(options.serverUrl)
    this.directory = options.directory
    this.projectId = options.projectId
    this.fetcher = options.fetcher ?? fetch
    this.captureApplier = options.captureApplier
    this.runtimeMetadata = options.runtimeMetadata
    this.sessionEvents = options.sessionEvents
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_WORKSPACE_REQUEST_TIMEOUT_MS
    assertTimeout(this.requestTimeoutMs, "workspace request timeout", "WORKSPACE_HTTP_TIMEOUT")
    this.replayTimeoutMs = options.replayTimeoutMs ?? DEFAULT_REPLAY_TIMEOUT_MS
    assertTimeout(this.replayTimeoutMs, "workspace replay timeout", "WORKSPACE_REPLAY_TIMEOUT")
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
      directory: input.directory,
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

  async replaySession(input: { sessionId: string; directory: string; target: Extract<WorkspaceTarget, { type: "remote" }> }): Promise<void> {
    const events = await this.sessionEvents?.(input.sessionId) ?? []
    if (events.length === 0) throw new SandboxError("sync", "OpenCode session history is empty", "WORKSPACE_HISTORY")
    if (events.length > MAX_REPLAY_EVENTS) {
      throw replayLimitError()
    }
    let historyBytes = 2
    for (let index = 0; index < events.length; index++) {
      historyBytes += serializedReplayEventBytes(events[index]!) + (index === 0 ? 0 : 1)
      if (historyBytes > MAX_REPLAY_HISTORY_BYTES) throw replayLimitError()
    }
    for (let index = 0; index < events.length; index += REPLAY_BATCH_SIZE) {
      const body = serializeReplayRequest(input.directory, events.slice(index, index + REPLAY_BATCH_SIZE))
      await this.requestTarget(input.target, "/sync/replay", body)
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

  async inspect(input: { workspaceId: string; directory: string; signal?: AbortSignal }): Promise<WorkspaceInfo | undefined> {
    try {
      const value = await this.request("/experimental/workspace", {
        method: "GET",
        directory: input.directory,
        workspace: input.workspaceId,
        timeoutMs: INSPECTION_TIMEOUT_MS,
        signal: input.signal,
      })
      if (!Array.isArray(value)) throw new SandboxError("control_channel", "workspace list response is not an array", "WORKSPACE_SCHEMA")
      return value.map((entry) => parseWorkspaceInfo(entry, this.projectId)).find((info) => info.id === input.workspaceId)
    } catch (error) {
      if (error instanceof SandboxError && error.code === "WORKSPACE_HTTP_404") return undefined
      throw error
    }
  }

  async waitForSync(input: { workspaceId: string; directory: string; timeoutMs: number }): Promise<void> {
    const deadline = Date.now() + Math.min(input.timeoutMs, DEFAULT_SYNC_TIMEOUT_MS)
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      let value: unknown
      try {
        value = await this.request("/experimental/workspace/status", {
          method: "GET",
          directory: input.directory,
          timeoutMs: remaining,
        })
      } catch (error) {
        if (error instanceof SandboxError && error.code === "WORKSPACE_HTTP_TIMEOUT") {
          throw new SandboxError("sync", "timed out waiting for workspace synchronization", "WORKSPACE_SYNC_TIMEOUT")
        }
        throw error
      }
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
      timeoutMs?: number
      signal?: AbortSignal
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

    const signal = options.signal
      ? AbortSignal.any([options.signal, createTimeoutSignal(options.timeoutMs ?? this.requestTimeoutMs)])
      : createTimeoutSignal(options.timeoutMs ?? this.requestTimeoutMs)
    try {
      const response = await waitForAbort(
        () => this.fetcher(url, {
          method: options.method,
          headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal,
        }),
        signal,
        cancelResponseBody,
      )
      const text = await readLimitedBody(response, signal, "control_channel")
      if (!response.ok) {
        throw new SandboxError("control_channel", redactText(text), `WORKSPACE_HTTP_${response.status}`)
      }
      if (response.status === 204 || text.length === 0) return undefined
      try {
        return JSON.parse(text)
      } catch {
        throw new SandboxError("control_channel", "OpenCode workspace response is not valid JSON", "WORKSPACE_JSON")
      }
    } catch (error) {
      if (signal?.aborted) throw new SandboxError("control_channel", "workspace request timed out", "WORKSPACE_HTTP_TIMEOUT")
      throw error
    }
  }

  private async requestTarget(target: Extract<WorkspaceTarget, { type: "remote" }>, path: string, body: string): Promise<void> {
    const url = new URL(target.url)
    url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`
    url.search = ""
    const headers = new Headers(target.headers)
    headers.set("Content-Type", "application/json")
    if (Buffer.byteLength(body) > MAX_REPLAY_REQUEST_BYTES) throw replayLimitError()
    const signal = createTimeoutSignal(this.replayTimeoutMs)
    try {
      const response = await waitForAbort(
        () => this.fetcher(url, { method: "POST", headers, body, signal }),
        signal,
        cancelResponseBody,
      )
      const text = await readLimitedBody(response, signal, "sync")
      if (!response.ok) throw new SandboxError("sync", redactText(text), `WORKSPACE_HTTP_${response.status}`)
    } catch (error) {
      if (signal.aborted) throw new SandboxError("sync", "workspace replay request timed out", "WORKSPACE_REPLAY_TIMEOUT")
      throw error
    }
  }
}

export function serializedReplayEventBytes(event: WorkspaceReplayEvent): number {
  return Buffer.byteLength(serializeReplayValue(event))
}

function serializeReplayRequest(directory: string, events: WorkspaceReplayEvent[]): string {
  const serialized = serializeReplayValue({ directory, events })
  if (Buffer.byteLength(serialized) > MAX_REPLAY_REQUEST_BYTES) throw replayLimitError()
  return serialized
}

function serializeReplayValue(value: unknown): string {
  try {
    const serialized = JSON.stringify(value)
    if (typeof serialized !== "string") throw new Error("history value is not serializable")
    return serialized
  } catch {
    throw new SandboxError("sync", "OpenCode session history is invalid", "WORKSPACE_HISTORY")
  }
}

function replayLimitError(): SandboxError {
  return new SandboxError("sync", "OpenCode session history exceeds the replay limit", "WORKSPACE_REPLAY_LIMIT")
}

function assertTimeout(value: number, label: string, code: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new SandboxError("validate", `${label} is invalid`, code)
}

function createTimeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs)
}

function waitForAbort<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  onLateValue?: (value: T) => void | Promise<void>,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("operation timed out"))
  return new Promise<T>((resolve, reject) => {
    let aborted = false
    const onAbort = () => {
      aborted = true
      cleanup()
      reject(signal.reason ?? new Error("operation timed out"))
    }
    const cleanup = () => signal.removeEventListener("abort", onAbort)
    signal.addEventListener("abort", onAbort, { once: true })
    let pending: Promise<T>
    try {
      pending = operation()
    } catch (error) {
      cleanup()
      reject(error)
      return
    }
    pending.then(
      (value) => {
        if (aborted) {
          void Promise.resolve().then(() => onLateValue?.(value)).catch(() => undefined)
          return
        }
        cleanup()
        resolve(value)
      },
      (error) => {
        if (aborted) return
        cleanup()
        reject(error)
      },
    )
  })
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

export async function readLimitedBody(response: Response, signal: AbortSignal, stage: string): Promise<string> {
  if (!response.body) {
    const text = await waitForAbort(() => response.text(), signal)
    if (Buffer.byteLength(text) > RESPONSE_LIMIT_BYTES) {
      throw new SandboxError(stage, "workspace response is too large", "WORKSPACE_RESPONSE_LIMIT")
    }
    return text
  }
  if (signal.aborted) {
    await cancelResponseBody(response)
    throw signal.reason ?? new Error("operation timed out")
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let cancellation: Promise<void> | undefined
  const cancel = (): Promise<void> => {
    if (!cancellation) {
      try {
        cancellation = reader.cancel().then(() => undefined, () => undefined)
      } catch {
        cancellation = Promise.resolve()
      }
    }
    return cancellation
  }
  const onAbort = () => { void cancel() }
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    while (true) {
      const next = await waitForAbort(() => reader.read(), signal)
      if (next.done) break
      size += next.value.byteLength
      if (size > RESPONSE_LIMIT_BYTES) {
        throw new SandboxError(stage, "workspace response is too large", "WORKSPACE_RESPONSE_LIMIT")
      }
      chunks.push(next.value)
    }
  } catch (error) {
    await cancel()
    throw error
  } finally {
    signal.removeEventListener("abort", onAbort)
    try {
      reader.releaseLock()
    } catch {
      // The timeout may have interrupted an in-flight stream read.
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks, size))
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The response may already have been consumed or canceled.
  }
}
