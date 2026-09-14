# OpenCode sandbox system

Read this before changing `home/.config/opencode/sandbox/`, `home/.config/opencode/plugin/sandbox.ts`, `home/bin/sandboxctl`, or the OpenCode workspace integration. Read [the operations runbook](opencode-sandbox-operations.md) when diagnosing a live session or cleaning resources.

The glossary in [`CONTEXT.md`](../CONTEXT.md) defines the domain terms used here.

## Purpose

The system moves one OpenCode session between its host checkout and an isolated runtime without making the agent manage infrastructure. The agent states intent through `/sandbox`; the lifecycle controller owns provisioning, workspace registration, routing, synchronization, recovery state, and cleanup.

The central invariant is:

> A session has one authoritative target, and every runtime resource is attributable to one session generation before the system mutates it.

The design must fail closed when ownership or synchronization is uncertain. Preserve work rather than guessing. Return enough structured evidence for the next action instead of forcing an agent to infer state from provider output. The known gaps near the end of this document identify where the current implementation falls short.

## System shape

```text
human or agent intent
        |
        v
/sandbox command -> sandboxctl -> authenticated control channel
                                      |
                                      v
                              LifecycleController
                               /      |       \
                              /       |        \
                  lifecycle record  workspace  runtime session
                    and per-session   gateway    and provider
                         lock            |            |
                                         v            v
                                  OpenCode warp   exe.dev / sbx /
                                   and replay      Cloudflare
                                         \            /
                                          \          /
                                           Git capture
                                            and sync
```

This is one control system, not three provider launchers. Provider commands are implementation details below the lifecycle seam.

## Module tower

| Module | Interface | Owns | Does not own |
|---|---|---|---|
| Command | One lifecycle operation and optional `delete --force` | Intent validation and faithful presentation of the result | Provider selection or retries |
| Control channel | Authenticated `ControlRequest -> SandboxResponse` | Role, scope, session, generation, expiry, and transport framing | Lifecycle decisions or producer-side log limits |
| Lifecycle controller | Session context plus lifecycle operation | State transitions, serialization, target changes, cleanup order | Provider command syntax |
| Workspace gateway | Create, warp, replay, sync status, remove | OpenCode workspace protocol | Runtime provisioning |
| Runtime session | Apply capture, expose target, sync, close | One worktree and one runtime handle | Cross-session policy |
| Provider adapter | Provider-specific runtime behavior | Resource creation, bootstrap, transport, health, destruction | User-facing operation semantics |
| State store | Snapshot reads plus locked atomic mutation | Versioned durable intent/phase record and file safety | Provider health or other observed facts |

`LifecycleController` is the deep module. Callers ask for lifecycle outcomes; they do not coordinate the modules beneath it. Tests should cross the same interface unless they exercise a provider adapter directly.

## Identity and ownership

The ownership tuple is:

```text
projectId + sessionId + generation + workspaceId + provider
```

`baseSha` and `branch` bind the Git lineage. Provider metadata binds the external resource. A control capability binds `sessionId`, `generation`, and role. Any destructive operation must establish this chain from the lifecycle record to the observed resource.

SBX and exe.dev require this tuple to match the provider's observed resource metadata before reuse, stop, or destruction. New SBX resources store the tuple and a random ownership ID in an external marker read through `sbx cp`; read-only inspection can therefore verify ownership after restart without starting a stopped sandbox. Legacy fingerprint-only markers remain verifiable only by their creating process. Names are conveniences, not proof of ownership. Cloudflare can inspect a known sandbox while its live adapter exists, but its bridge has no durable owner lookup or inventory, so post-restart provider ownership remains unavailable or unknown.

## Authoritative state

No single current data source proves the whole situation:

| Source | Proves | Cannot prove |
|---|---|---|
| Lifecycle record | Last committed intent, phase, identity, provider metadata, and last error | Current provider health, ownership, resource state, or a live handle |
| In-memory runtime session | This plugin instance can control the runtime | Survival across plugin restart |
| OpenCode workspace registry | Session routing association | Provider resource ownership |
| Provider inventory and ownership metadata | Resource existence and provider status; durable SBX or exe.dev ownership only when the provider-specific proof matches | Runtime control or unpreserved work |
| Git branch/worktree | Preserved code lineage | Runtime process health |

Reconciliation means comparing these sources. `status` intentionally reads only the record; `inspect` joins the record with bounded workspace, provider, runtime-handle, and Git observations, while host-only `inventory` lists project records and provider resources when the configured provider exposes an inventory adapter. The current contract is described below; the remaining recovery design is recorded in [`history/opencode-sandbox-agent-system-plan.md`](../history/opencode-sandbox-agent-system-plan.md).

`clean` requires observed absence of the provider resource, runtime handle, and workspace registration. A failed or unavailable ownership or resource probe remains unknown and cannot authorize a destructive action or a new start.

## Persistence and response schemas

The disk and response schemas are intentionally different:

| Surface | Schema | Canonical fields | Compatibility or observed fields |
|---|---:|---|---|
| Private `*.json` lifecycle record | `schemaVersion: 1` | `desiredLocation` and `phase`, plus identity, operation, and error data | `state` is not emitted by normal writes |
| `SandboxResultV2` control response | `schemaVersion: 2` | `intent.desiredLocation` and `intent.phase` | Compatibility `state`, plus fresh `observations`, classification, target, work, actions, and error |

Legacy records that contain only `state` are validated, deterministically mapped to schema-1 intent and phase, and rewritten under the per-session state lock. The rewrite is atomic: the store writes and syncs a private temporary file, then renames it into place. Migration is idempotent, does not probe a provider, and returns the compatibility state for the current response. A schema-1 record with an extra legacy `state` field still uses canonical intent; the next normal write removes that non-canonical field.

`desiredLocation` and `phase` are durable intent. Control, resource, ownership, health, classification, and effective target are observations or derivations and are not durable truth. An `observed: false` or unknown response entry is not evidence of absence. In particular, a persisted `remote` intent or compatibility `state` never proves that a runtime exists, is healthy, or is stopped.

### Failure evidence

When an eligible mutating request (`start`, `stop`, `delete`, `retry`, `recover`, or `repair`) reaches a lifecycle record, it appends a journal entry using the validated control request ID. The entry is persisted as `PENDING` before lifecycle mutation; a synchronous completion adds `endedAt`, a result code, and bounded evidence. Start, stop, and normal delete may return at an idle boundary, so the idle handler completes the same entry later. A pending entry is not evidence of success. Read-only operations do not append entries, and a retry receives a new request ID while retaining the earlier entry.

The journal retains only the newest 32 entries and stays below 16 KiB. Each text value is capped at 256 bytes, evidence at eight references and 4 KiB, and state-store writes redact credential-shaped values. It is a reconstruction index, not a copy of provider or OpenCode logs. A failed operation can be reconstructed only while its lifecycle record and retained entry exist; a resource created before its ID reached the record remains unattributed and unknown-safe.

## Phase 1 decision contract

Phase 1 is implemented. The public read operations are:

| Operation | Scope | Behavior |
|---|---|---|
| `status` | Session capability, host or remote | Reads the lifecycle record only. It makes no provider, workspace, runtime-target, or Git probe. Non-record sources have `observed: false`; classification remains `unknown`. |
| `inspect` | Session capability, host or remote | Runs bounded workspace, provider, runtime-target, and Git probes concurrently for one session. It is read-only and returns the decision fields below, including partial evidence when a probe is unavailable. |
| `inventory` | Host project capability only | Lists lifecycle records for the project and one configured-provider inventory when available. It does not inspect individual resources, mutate state, or prove that a listed resource belongs to a session. |

Every normal control response is a `SandboxResultV2` with `schemaVersion: 2`. The result always carries the following decision fields:

| Field | Meaning |
|---|---|
| `requestId`, `ok`, `operation`, `message` | Correlation, outcome, requested operation, and redacted human-readable summary. |
| `session` | `null` or the project, session, workspace, generation, and provider identity. |
| `intent` | Canonical desired location (`local`, `remote`, or `deleted`) and persisted phase (`idle`, `capturing`, `provisioning`, `activating`, `syncing`, `detaching`, or `deleting`). |
| `effectiveTarget` | `null`, a proved local directory, or a proved remote resource ID. Desired location alone never fills this field; remote targets also require a verified provider observation. URLs, headers, and credentials are excluded. |
| `observations` | One entry for each `record`, `handle`, `workspace`, `provider`, and `git` source. Each entry has `observed`, `freshAt`, bounded evidence, and any applicable resource, ownership, and health values. These facts exist in the response only. |
| `classification` | One of `clean`, `attached`, `control_lost`, `orphan`, `stale_record`, `leaked_resource`, `conflict`, `work_at_risk`, or `unknown`. |
| `work` | Capture base SHA, observed runtime HEAD, sync state (`clean`, `dirty`, `failed`, or `unknown`), preservation state, and any preserved worktree path. |
| `allowedActions` | The controller's complete action set. Each action names the public operation, required role, arguments, preconditions, and wait behavior (`none`, `session_idle`, or `operation_completion`). |
| `recommendedAction` | One allowed operation plus a reason code, or `null` when no safe recommendation exists. It is a recommendation, not permission to invent another operation. |
| `error` | `null` or a stable code, stage, and retryability flag. Probe failures are represented as unknown evidence rather than guessed facts; retryability never grants permission by itself. |

`status` and `inspect` use session capabilities. `inventory` uses a host-only project capability; remote capabilities cannot request it. `recover`, `repair`, and verified-orphan deletion use host session capabilities and are host-only. Inventory details contain bounded `records` and `providerResources` arrays. The CLI still exposes the compatibility projection `state`, `stage`, and non-secret `details` where present. `recover` and orphan deletion are available only when an injected runtime driver and fresh inspection prove their preconditions; `repair` remains the stale-control-plane operation.

### Observation budgets

| Operation | Observation budget | Deadline and fallback |
|---|---|---|
| `status` | Lifecycle record read only | File-read latency; provider, workspace, handle, and Git sources remain `observed: false`. |
| Session `inspect` | At most one controller probe each for workspace, provider, Git, and runtime target; probes run in parallel | Each controller probe has a 5-second deadline. A timeout or unavailable ownership/resource adapter yields unknown or unobserved evidence and does not authorize a new start or destructive ownership action. There is no separate 15-second aggregate budget. |
| Project `inventory` | One lifecycle-record scan and one configured-provider listing; no per-resource deep probes | Provider listing has a 10-second deadline. Records remain available if provider inventory fails; provider scope is unknown when resources cannot be tied to the requested project. |
| `diagnose` | Fixed diagnostic bundle plus optional configured diagnostics, separate from `inspect` | The bundle reports a five-probe/30-second diagnostic budget. Returned details are redacted and bounded; an unconfigured optional hook returns `{ "configured": false }`. |

Provider inspection is currently available through the exe.dev and SBX adapters and through the live Cloudflare adapter. SBX inspection checks an exact inventory match and its ownership marker; exe.dev inspection checks an exact durable VM identity and owner tag; Cloudflare inspection is limited to a known sandbox's running state, while `diagnose` may add active health. The `RuntimeDriver` seam has five methods: `inspect`, `adopt`, `sync`, `close`, and `destroy`. The default SBX and exe.dev Sandcastle factories wire production drivers: recovery requires one exact live inventory entry, durable ownership proof, and a safe matching checkout; SBX also requires its published OpenCode port, while exe.dev rebuilds a fresh SSH supervisor and tunnel. Cloudflare has no durable post-restart lookup or runtime-adoption adapter, so it remains unsupported for recovery.

`diagnose` combines the retained journal with one bounded fresh observation bundle. It is the only read path that adds active provider health/version probes; normal `inspect` remains inventory/marker-only. Version values identify their provenance: configured values come from sandbox configuration, local values from the host OpenCode source, dependency values from package metadata, and remote values only from a provider health observation. Every value carries `observed` and `freshAt`; a missing source is `null` rather than an inferred version. The optional diagnostic hook is additive, redacted, and capped; it is not authoritative and cannot restore discarded journal entries. Process ownership covers only a tracked runtime handle, not a system-wide process scan. Cloudflare's live known-resource result remains read-only because its post-restart owner lookup is unavailable.

### Classifications and actions

| Classification | Required observed situation | Safe action surface |
|---|---|---|
| `clean` | Provider, runtime handle, and workspace are all observed absent for a local, detached, or deleted record | `start` may be advertised only to a host with session context and capture available; otherwise read-only inspection remains the choice. |
| `attached` | Runtime handle is present, provider resource is present and ownership-verified, and provider health is known | `stop` is recommended; normal `stop` or `delete` waits for session idle and preserves work first. |
| `control_lost` | A non-local record has no handle and provider state is unavailable or unknown | Inspect only; do not treat `remote` intent or the compatibility `orphaned` label as proof that the resource exists or stopped. |
| `orphan` | Handle is absent, provider resource is present, ownership is verified, and the desired location is remote | Host `recover` can adopt the exact resource without destruction; host `delete` can adopt it, preserve or explicitly discard its work, remove the exact workspace, and then destroy it. |
| `stale_record` | A non-local record has observed absence of its provider resource, handle, and workspace | Host `repair` is allowed only when those observations are fresh and workspace ownership is absent or exact; otherwise inspect. |
| `leaked_resource` | Desired location is local or deleted, handle is absent, and a provider resource is present with verified ownership | Host `delete` is allowed only after preservation is verified or discard was explicitly recorded; otherwise inspect. |
| `conflict` | Any ownership evidence conflicts | Read-only actions only. |
| `work_at_risk` | The compatibility projection is `sync_failed` or the durable record has a sync error | Retry the recorded operation when it is present and allowed; preserve work before any discard. |
| `unknown` | Required evidence is missing, unavailable, or inconsistent without a more specific safe classification | Inspect again or require an operator; no inferred provider action. |

The action list is authoritative. `recommendedAction` must be present in `allowedActions` when non-null. A post-restart active or control-lost runtime can be recovered or deleted only through an injected runtime driver after exact resource and ownership verification; Cloudflare remains explicitly unsupported for recovery and destruction. Host `repair` can reconcile only a stale control-plane record after fresh provider and runtime-handle absence plus an absent or exactly owned workspace registration. Orphan deletion adopts before preservation, rechecks ownership immediately before destruction, and persists the destruction phase so retries do not repeat it. Recovery itself never destroys a provider resource.

### Output bounds

- Control responses are kept below the 64 KiB transport limit; the lifecycle controller reserves a 1 KiB margin. Oversized detail payloads become a redacted `truncated` preview, and an irreducibly oversized response returns `RESPONSE_LIMIT` with minimal structured fields.
- Inventory returns at most 1,000 project records and 1,000 provider resources. Record and resource detail buckets are bounded and set `truncated: true` when the limit cuts them off.
- Logs, diagnostics, and persisted provider metadata are redacted and capped at 48 KiB. Evidence is limited to eight entries, 256 bytes per entry, and 4 KiB total; resource IDs are capped at 128 bytes.
- Provider and process adapters cap command output before it becomes public evidence. Raw credentials, headers, URLs, and unbounded logs do not cross the control response.

## Current lifecycle

The durable lifecycle model is `schemaVersion: 1` with canonical `desiredLocation` and `phase`. Legal phases are `idle`, `syncing`, and `detaching` for local intent; `idle`, `capturing`, `provisioning`, `activating`, and `syncing` for remote intent; and `idle`, `syncing`, and `deleting` for deleted intent. The old `state` values remain a compatibility projection for responses and legacy callers, not a second durable state machine.

Legacy state-only records migrate on first read under a per-session lock and are atomically replaced with the canonical record. A failed operation keeps its desired intent and phase, records a stable `lastError`, and exposes `retry` only when an unchanged `start`, `stop`, `delete`, or `recover` operation is present and the caller role is authorized. A retryable error is not permission to mutate.

Startup reconciliation reads a bounded observation plan before any recovery mutation, revalidates record identity, generation, and `updatedAt` under lock, and mutates only after fresh evidence proves the action. Control, resource, ownership, health, classification, and effective target are derived from observations; missing or conflicting evidence remains unknown-safe. The compatibility labels `recovery_pending` and `orphaned` may still appear in responses while provider recovery support is incomplete.

### Start

1. Capture `HEAD`, the binary diff, and untracked regular files from the host worktree.
2. Allocate a new generation, workspace ID, and branch.
3. Create the Sandcastle worktree and provider runtime.
4. Apply the capture and register the OpenCode workspace.
5. Wait for the current response to become idle.
6. Warp locally for synchronization setup, start remote sync, replay session events, then route the session to the remote target.

The command returns while activation is pending. The next message runs remotely after the idle transition completes.

### Stop

1. Mark detachment pending.
2. Wait for the current response to become idle.
3. Commit runtime changes, run the sync barrier, and warp the session back to the host.
4. Close the runtime and worktree, remove the OpenCode workspace, and preserve a worktree when automatic integration cannot safely finish.

### Delete

Normal deletion attempts to preserve changes before destruction. A verified orphan is adopted first, then synchronized, closed, removed from the exact workspace, freshly ownership-checked, and destroyed. `delete --force` is host-only and is limited to a detached runtime, an orphan after verified adoption, or explicit discard after sync failure; it may skip synchronization only after adoption. SBX and Cloudflare block unknown ownership even when force is requested. A control-lost resource requires a configured runtime driver for automatic recovery or deletion; otherwise use the operator preflight in the runbook.

### Recovery

Startup reconciliation does not replay a pending operation when its fresh observation plan is unknown or conflicting. Sandcastle state still depends on an in-memory handle for control; after restart, a missing handle remains `control_lost` unless provider presence and ownership are verified, in which case the response may expose the compatibility label `orphaned`. Host `recover` then performs a locked fresh preflight, adopts the exact resource through the runtime driver, routes the existing workspace, and persists remote intent; host `delete` uses the same adoption gate before preservation and destruction. Stale plans, failed adoption, preservation failures, and ownership changes remain inspectable and retryable without destruction. Host `repair` handles only the proved stale case: provider absent, handle absent, and workspace absent or exactly owned.

## Control and trust

The plugin injects a short-lived capability into the shell environment. Session capabilities are scoped to one session generation and either the host or remote role; the host-only project capability is reserved for `inventory`. Both the CLI and lifecycle controller block remote `start`, `recover`, and `repair`; retry cannot bypass those rules. `delete --force` is also host-only. The control channel accepts only loopback TCP, a private Unix socket, or the provider mailbox transport.

State files reject credential-shaped keys, use private permissions, write atomically, and redact errors. Workspace metadata strips secret-shaped fields before it reaches OpenCode. Do not weaken these checks to improve diagnostics; diagnostics must expose evidence without credentials.

## Providers

| Provider | Runtime | Transport | Required host configuration | Resource observation |
|---|---|---|---|---|
| `sbx` | Docker Sandbox clone | Published OpenCode port plus supervised SSH control proxy | `sbx` CLI and Docker Sandbox support | Session inspect plus project inventory; inspect reads the durable ownership marker |
| `exedev` | exe.dev VM | SSH and remote control socket | exe.dev access, SSH lobby, pinned host key | Session inspect plus project inventory; inspect matches durable VM identity and owner tag |
| `cloudflare` | Cloudflare Sandbox | Sandbox API plus mailbox control bridge | `apiUrl` and `apiKey` in the project config, or matching `SANDBOX_API_URL` and `SANDBOX_API_KEY` environment variables | Live known-resource inspection; `diagnose` may add active health; no durable post-restart lookup, inventory, or runtime-adoption adapter. Exec stdin is staged through the bridge file PUT contract. |

All three use the Sandcastle workspace path by default. The older direct `WorkspaceProviderBase` path remains for injected tests and compatibility. New lifecycle behavior belongs above the provider seam unless the behavior is truly provider-specific.

The five-method `RuntimeDriver` seam is exercised by the fake adapter and the default SBX and exe.dev Sandcastle adapters. Both real drivers are fail-closed: duplicate resources, unknown or stopped status, timeouts, conflicts, and checkout mismatches remain unsupported or unknown without provider mutation. Cloudflare needs a bridge resource lookup returning durable owner metadata plus a runtime driver before it can support recovery or post-restart deletion; the current bridge only checks `running(sandboxId)`, while `CloudflareProvider` keeps ownership in a process-local map. Its live inspection is read-only and never receives an inferred destructive action.

## Configuration

Configuration precedence, lowest to highest:

1. Defaults in `sandbox/config.ts` (`apiUrl` and `apiKey` are `null`).
2. `<project-worktree>/.opencode/sandbox.json`.
3. The JSON object in `SANDBOX_CONFIG`.
4. `SANDBOX_PROVIDER` for provider selection.
5. A present `SANDBOX_API_URL` or `SANDBOX_API_KEY`, independently overriding its matching field. An empty value is still an override and is invalid.

Cloudflare project configuration can use these literal fields:

```json
{
  "provider": "cloudflare",
  "apiUrl": "https://<worker>.<subdomain>.workers.dev",
  "apiKey": "<sandbox-api-key>"
}
```

`apiUrl` and `apiKey` may be absent or `null` for other providers. Cloudflare
requires both. The URL must use HTTPS, or HTTP on an allowed loopback host,
and must not contain credentials.

This repository's `.opencode/sandbox.json` is tracked and intentionally keeps
its existing provider and version settings. Do not put a real Cloudflare key
in that file. A secret-bearing project file must be untracked and ignored
before use; adding a `.gitignore` rule does not stop an already tracked file
from being tracked. Tracked configuration is eligible for Git capture/archive
and provider checkout, so credentials in the file are not automatically
excluded. Prefer environment variables or `SANDBOX_CONFIG` for secrets.

This repository selects `sbx` and OpenCode `1.18.25` in `.opencode/sandbox.json`. The tracked plugin dependency and default remote version remain `1.18.23`; the project override is deliberate. `/sandbox diagnose` reports these configured, dependency, and observed remote version sources when available, without inferring a missing local version.

`OPENCODE_EXPERIMENTAL_WORKSPACES=1` enables the OpenCode workspace hooks. `home/.bashrc.d/20-opencode.sh` sets it for interactive shells.

### Cloudflare worker image

The Cloudflare E2E requires the worker image to run as the non-root `sandbox` user with a writable `/Users` directory. Before `USER sandbox` in `bridge/worker/Dockerfile`, create `/Users` and assign it to the sandbox user:

```dockerfile
RUN mkdir -p /Users \
    && chown sandbox:sandbox /Users
```

### Standalone Cloudflare smoke check

From the repository root, run:

```bash
bun home/.config/opencode/sandbox/cloudflare-startup-smoke.ts
```

The script defaults to the current directory, loads `<worktree>/.opencode/sandbox.json` through the same loader as the plugin, and accepts the loader's `SANDBOX_CONFIG` and API URL/key environment overrides. It selects `cloudflare` in code for this check, so `SANDBOX_PROVIDER`, `SANDBOX_WORKTREE`, `SANDBOX_API_URL`, and `SANDBOX_API_KEY` are not required when bridge access is already in the project file. This does not change the plugin's configured `sbx` provider. The smoke then checks the bridge, bootstraps one sandbox, verifies the owned resource, activates the server, checks authenticated loopback and public tunnel health separately, and best-effort reads a bounded server log. Evidence collection runs before cleanup even when activation or public health fails. It does not create an OpenCode session or invoke an LLM.

Workers Logs correlation is optional, bounded, and read-only. The bridge `apiKey` authenticates bridge routes but cannot query account Observability, so set the separate `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` only when telemetry is needed; do not add them to the bridge config. Workers Observability Write is optional and separate from the smoke's bridge access. `CLOUDFLARE_WORKER_NAME` filters on the Workers Observability `$workers.scriptName` field. Bridge requests carry the generated smoke run ID in the URL and header, and returned events retain their actual `$metadata.id` and `$workers.requestId`. A query with no event is reported as `incomplete`; missing credentials or a query failure is `unavailable`, not a runtime failure claim. `SANDBOX_SMOKE_OUTPUT=/absolute/path/result.json` is optional and writes the same redacted JSON result with mode `0600`.

The normal command requires no extra account, zone, or token environment variables. Cloudflare's health timeout defaults to 180 seconds; `SANDBOX_HEALTH_TIMEOUT_MS` is an explicit override and is honored. SBX and exe.dev retain their 30-second default. The config stage reports the effective `healthTimeoutMs`, and successful reports preserve the validated `tunnelHostname` alongside the redacted tunnel URL. Each health wait exits early when the response is healthy. The smoke does not configure tunnel ingress or DNS, so no manual ingress setup is required. It does not exercise the full OpenCode workspace warp/session path.

### Diagnóstico verificado

The failure was startup convergence, not missing ingress configuration. On 2026-09-12 UTC, the official run with the 30-second health budget aborted during activation from `2026-09-12T21:57:03.024Z` to `2026-09-12T21:57:40.724Z`; the last recorded failure was HTTP 530/1033 with CF-Ray `a3a22b4fb9806d53-GRU`. The normal follow-up on 2026-09-13 used tunnel config version 0 and made no PUT: activation ran from `2026-09-13T14:27:23.095Z` to `2026-09-13T14:29:31.538Z` (128.443 seconds), then public health returned HTTP 200 from `2026-09-13T14:29:36.304Z` to `2026-09-13T14:29:36.547Z`. The evidence files are outside this repository: `cloudflare-startup-smoke-identity-official.json` and `cloudflare-startup-smoke-time-only.json`.

The command exits nonzero for a failed stage, missing required configuration, or failed cleanup. Logs and telemetry are diagnostic and do not turn an otherwise healthy run into a pass/fail claim. A failed loopback command records `commandFailed` explicitly rather than treating missing output as a runtime result. Cleanup addresses only the provider-observed sandbox ID from this run, deletes its tunnel before the sandbox through one provider-owned close, and never probes with `running()` after deletion. If ownership is not observed, cleanup fails closed and does not guess at a resource.

### Full Cloudflare E2E

From the repository root, run:

```bash
bun home/.config/opencode/sandbox/cloudflare-e2e.ts
```

This validated command runs without an LLM or subagents. It uses the local `.opencode/sandbox.json` configuration, with the same `SANDBOX_CONFIG`, `SANDBOX_API_URL`, and `SANDBOX_API_KEY` overrides, and selects Cloudflare for the run. It creates an isolated local host/session and worktree, invokes `sandboxctl start`, waits for the OpenCode Warp and replay to establish the remote session, applies fixed remote edits, invokes `sandboxctl stop`, verifies sync-back and the return to the local session, then performs bounded cleanup of the sandbox, host, and worktree. Failures preserve the `.cloudflare-e2e-*` evidence directory because it can contain private credentials and artifacts.

Validation status: **PASS**, 2026-09-14. `SANDBOX_E2E_OUTPUT=/absolute/path/result.json` is optional; when set, the command writes the redacted JSON report with mode `0600`.

## Files and evidence

| Path | Purpose |
|---|---|
| `~/.local/state/opencode-sandbox/*.json` | Private lifecycle records keyed by a hash of session ID |
| `${XDG_RUNTIME_DIR:-$TMPDIR}/oe-*/c.sock` | Per-process host control socket |
| `.sandcastle/worktrees/` | Generated Sandcastle worktrees |
| `.sandcastle/logs/` | Generated Sandcastle logs |
| `opencode.db` under the OpenCode data directory | Session events used for replay |
| Provider inventory and daemon logs | Observed external resource state |

`.sandcastle/` is ignored by Git. Untracked-file capture also excludes it explicitly. A file already tracked under that path would still appear in the tracked diff, so the Git ignore rule is the primary guard. The directory is evidence during an incident, not project source.

## Separate host access system

`home/bin/oc` is independent. It starts or reuses one host OpenCode server on loopback and publishes it with Tailscale Serve. It controls access to the host OpenCode instance; it does not create isolated runtimes, warp sessions, or own sandbox resources.

`ax` and `ap-host` are older FRP-era tools. Their removal is tracked separately and must not be folded into sandbox lifecycle changes without an explicit scope decision.

## Verification

Run all three checks after sandbox changes:

```bash
cd home/.config/opencode && bun test ./sandbox && bun run typecheck
make shellcheck
make test
```

The Bun tests are the executable sandbox contract. `make test` validates the wider dotfiles installation but does not run the TypeScript sandbox suite.

## Known control-loop gaps

The current implementation has documented gaps, not hidden assumptions:

- Plugin disposal syncs and closes owned remote Sandcastle sessions and cancels pending idle work, but it does not yet persist a provider-observed final state.
- The Cloudflare production factory does not yet inject a runtime driver, so restarted Cloudflare runtimes remain inspect-only with unknown provider ownership. The bridge has no resource lookup that returns durable owner metadata, and the provider's ownership map is process-local; add that bridge contract before recovery can prove a persisted sandbox ID belongs to the session. The default SBX and exe.dev factories recover only running resources with exact durable ownership proof; a detached, verified, preserved leak is still the separate deletion path.
- SBX ownership can be inspected after restart from its durable marker, and exe.dev from durable VM identity and owner metadata. Recovery and orphan deletion create only fresh local credentials, ports, and supervisors; provider mutation remains gated by exact ownership observations. Cloudflare's live adapter can report a known resource's running/health state but remains unknown-safe after restart.
- The legacy direct SBX path cannot resume a detached runtime under a new generation; it fails closed. The default Sandcastle path can adopt an exact running runtime without recreating it, but stopped runtimes remain unsupported.
- A missing Sandcastle handle during reconciliation remains unchanged when provider or workspace evidence is unavailable or conflicting; recovery remains unavailable without a runtime driver.
- Provider cleanup failure before workspace registration can leave a resource whose ID never reached the lifecycle record.
- Unsupported provider inspection returns unknown observations and no destructive action.
- Default `diagnose` returns a fixed, bounded, redacted bundle; an optional configured diagnostics hook contributes additional bounded details.

The remaining provider-seam work and concise completion summary live in [`history/opencode-sandbox-agent-system-plan.md`](../history/opencode-sandbox-agent-system-plan.md).

## Navigation

| Concern | Start here |
|---|---|
| Operations and state transitions | `sandbox/lifecycle.ts`, `sandbox/state.ts` |
| Public data contracts | `sandbox/types.ts` |
| Plugin wiring and configuration precedence | `sandbox/plugin-runtime.ts`, `sandbox/config.ts` |
| Command transport and capabilities | `sandbox/cli.ts`, `sandbox/control-channel.ts` |
| OpenCode workspace protocol | `sandbox/workspace-http.ts` |
| Git capture and synchronization | `sandbox/working-tree.ts`, `sandbox/sandcastle-session.ts`, `sandbox/sync-barrier.ts` |
| Provider behavior | `sandbox/exedev-provider.ts`, `sandbox/sbx-provider.ts`, `sandbox/cloudflare-provider.ts` |
| Persistent records | `sandbox/state-store.ts` |
| Integration contract | `sandbox/sandbox.test.ts`, `sandbox/sandcastle.test.ts` |
