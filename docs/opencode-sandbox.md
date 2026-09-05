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
| State store | Snapshot reads plus locked atomic mutation | Durable lifecycle record and file safety | Provider health |

`LifecycleController` is the deep module. Callers ask for lifecycle outcomes; they do not coordinate the modules beneath it. Tests should cross the same interface unless they exercise a provider adapter directly.

## Identity and ownership

The ownership tuple is:

```text
projectId + sessionId + generation + workspaceId + provider
```

`baseSha` and `branch` bind the Git lineage. Provider metadata binds the external resource. A control capability binds `sessionId`, `generation`, and role. Any destructive operation must establish this chain from the lifecycle record to the observed resource.

SBX and exe.dev require this tuple to match the provider's observed resource metadata before reuse, stop, or destruction. New SBX resources store the tuple and a random ownership ID in an external marker read through `sbx cp`; read-only inspection can therefore verify ownership after restart without starting a stopped sandbox. Legacy fingerprint-only markers remain verifiable only by their creating process. Names are conveniences, not proof of ownership. Cloudflare currently checks this tuple only in the live provider instance; it has no Phase 1 resource inspection or inventory adapter, so a Cloudflare provider observation remains unavailable or unknown.

## Authoritative state

No single current data source proves the whole situation:

| Source | Proves | Cannot prove |
|---|---|---|
| Lifecycle record | Last committed intent, phase, identity, provider metadata, error | Current provider health or a live handle |
| In-memory runtime session | This plugin instance can control the runtime | Survival across plugin restart |
| OpenCode workspace registry | Session routing association | Provider resource ownership |
| Provider inventory and ownership metadata | Resource existence and provider status; durable SBX or exe.dev ownership only when the provider-specific proof matches | Runtime control or unpreserved work |
| Git branch/worktree | Preserved code lineage | Runtime process health |

Reconciliation means comparing these sources. `status` intentionally reads only the record; `inspect` joins the record with bounded workspace, provider, runtime-handle, and Git observations, while host-only `inventory` lists project records and provider resources when the configured provider exposes an inventory adapter. The current contract is described below; the remaining recovery design is recorded in [`history/opencode-sandbox-agent-system-plan.md`](../history/opencode-sandbox-agent-system-plan.md).

`clean` requires observed absence of the provider resource, runtime handle, and workspace registration. A failed or unavailable ownership or resource probe remains unknown and cannot authorize a destructive action or a new start.

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
| `intent` | Persisted desired location (`local`, `remote`, or `deleted`) and derived phase (`idle`, `capturing`, `provisioning`, `activating`, `syncing`, `detaching`, or `deleting`). |
| `effectiveTarget` | `null`, a proved local directory, or a proved remote resource ID. Desired location alone never fills this field; remote targets also require a verified provider observation. URLs, headers, and credentials are excluded. |
| `observations` | One entry for each `record`, `handle`, `workspace`, `provider`, and `git` source. Each entry has `observed`, `freshAt`, bounded evidence, and any applicable resource, ownership, and health values. |
| `classification` | One of `clean`, `attached`, `control_lost`, `orphan`, `stale_record`, `leaked_resource`, `conflict`, `work_at_risk`, or `unknown`. |
| `work` | Capture base SHA, observed runtime HEAD, sync state (`clean`, `dirty`, `failed`, or `unknown`), preservation state, and any preserved worktree path. |
| `allowedActions` | The controller's complete action set. Each action names the public operation, required role, arguments, preconditions, and wait behavior (`none`, `session_idle`, or `operation_completion`). |
| `recommendedAction` | One allowed operation plus a reason code, or `null` when no safe recommendation exists. It is a recommendation, not permission to invent another operation. |
| `error` | `null` or a stable code, stage, and retryability flag. Probe failures are represented as unknown evidence rather than guessed facts. |

`status` and `inspect` use session capabilities. `inventory` uses a host-only project capability; remote capabilities cannot request it. Inventory details contain bounded `records` and `providerResources` arrays. The CLI still exposes the compatibility fields `state`, `stage`, and non-secret `details` where present. `recover` and `repair` are reserved result vocabulary, not current `sandboxctl` commands.

### Observation budgets

| Operation | Observation budget | Deadline and fallback |
|---|---|---|
| `status` | Lifecycle record read only | File-read latency; provider, workspace, handle, and Git sources remain `observed: false`. |
| Session `inspect` | At most one controller probe each for workspace, provider, Git, and runtime target; probes run in parallel | Each controller probe has a 5-second deadline. A timeout or unavailable ownership/resource adapter yields unknown or unobserved evidence and does not authorize a new start or destructive ownership action. There is no separate 15-second aggregate budget. |
| Project `inventory` | One lifecycle-record scan and one configured-provider listing; no per-resource deep probes | Provider listing has a 10-second deadline. Records remain available if provider inventory fails; provider scope is unknown when resources cannot be tied to the requested project. |
| `diagnose` | Explicit configured diagnostics, separate from `inspect` | The lifecycle controller supplies no generic probe-count or wall-clock budget for diagnostics. Returned details are still redacted and bounded; an unconfigured hook returns `{ "configured": false }`. |

Provider inspection is currently available through the exe.dev and SBX adapters. SBX inspection checks an exact inventory match and its ownership marker; exe.dev inspection checks an exact durable VM identity and owner tag. Cloudflare has no resource inspection or inventory adapter in this phase, so its provider source cannot establish presence, health, or ownership.

### Classifications and actions

| Classification | Required observed situation | Safe action surface |
|---|---|---|
| `clean` | Provider, runtime handle, and workspace are all observed absent for a local, detached, or deleted record | `start` may be advertised only to a host with session context and capture available; otherwise read-only inspection remains the choice. |
| `attached` | Runtime handle is present, provider resource is present and ownership-verified, and provider health is known | `stop` is recommended; normal `stop` or `delete` waits for session idle and preserves work first. |
| `control_lost` | A non-local record has no handle and provider state is unavailable or unknown | Inspect only; do not treat `remote` or `orphaned` state as proof that the resource exists or stopped. |
| `orphan` | Handle is absent, provider resource is present, ownership is verified, and the desired location is remote | Read-only `inspect` only in Phase 1. Recovery, adoption, and destruction are deferred. |
| `stale_record` | A non-local record has observed absence of its provider resource, handle, and workspace | Inspect only; `repair` is deferred. |
| `leaked_resource` | Desired location is local or deleted, handle is absent, and a provider resource is present with verified ownership | Host `delete` is allowed only after preservation is verified or discard was explicitly recorded; otherwise inspect. |
| `conflict` | Any ownership evidence conflicts | Read-only actions only. |
| `work_at_risk` | The recorded state is `sync_failed` | Retry the recorded operation when it is present and allowed; preserve work before any discard. |
| `unknown` | Required evidence is missing, unavailable, or inconsistent without a more specific safe classification | Inspect again or require an operator; no inferred provider action. |

The action list is authoritative. `recommendedAction` must be present in `allowedActions` when non-null. A post-restart active or control-lost runtime cannot be adopted, recovered, repaired, or destroyed through `sandboxctl` in Phase 1. A detached leaked resource is the narrower exception: it can be deleted after inspection proves ownership and preservation, but that is not post-restart recovery.

### Output bounds

- Control responses are kept below the 64 KiB transport limit; the lifecycle controller reserves a 1 KiB margin. Oversized detail payloads become a redacted `truncated` preview, and an irreducibly oversized response returns `RESPONSE_LIMIT` with minimal structured fields.
- Inventory returns at most 1,000 project records and 1,000 provider resources. Record and resource detail buckets are bounded and set `truncated: true` when the limit cuts them off.
- Logs, diagnostics, and persisted provider metadata are redacted and capped at 48 KiB. Evidence is limited to eight entries, 256 bytes per entry, and 4 KiB total; resource IDs are capped at 128 bytes.
- Provider and process adapters cap command output before it becomes public evidence. Raw credentials, headers, URLs, and unbounded logs do not cross the control response.

## Current lifecycle

The persisted states are defined in `sandbox/state.ts`.

```text
local -> provisioning -> activation_pending -> remote
                                              |
                                              v
                                      stop_pending -> detached
                                              |
                                              v
                                      delete_pending -> deleted

failures -> error | sync_failed | recovery_pending | orphaned
```

The states currently mix stable location, transition phase, and failure classification. `orphaned` is terminal in the current state machine. The current reconciliation code assigns it when a lifecycle record looks active but the new plugin instance has no in-memory session handle. Reconciliation itself performs no provider observation, so the label proves control was lost, not that the runtime still exists. The target model reserves `orphan` for a resource that was actually observed.

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

Normal deletion attempts to preserve changes before destruction. `delete --force` is host-only and is limited to a detached runtime or explicit discard after sync failure. SBX and Cloudflare block unknown ownership even when force is requested. A control-lost resource still requires the operator preflight in the runbook because automatic recovery and adoption are not available.

### Recovery

Non-Sandcastle pending states enter `recovery_pending` during plugin startup and replay their cleanup path. Sandcastle state still depends on an in-memory handle for control; after restart it becomes `orphaned`. Phase 1 inspection can verify SBX ownership from its durable marker and exe.dev ownership from durable VM identity, but Cloudflare has no provider inspection adapter. Recovery, adoption, repair, and destructive control of a post-restart control-lost runtime remain unavailable.

## Control and trust

The plugin injects a short-lived capability into the shell environment. Session capabilities are scoped to one session generation and either the host or remote role; the host-only project capability is reserved for `inventory`. Both the CLI and lifecycle controller block remote `start`; retry cannot bypass that rule. `delete --force` is also host-only. The control channel accepts only loopback TCP, a private Unix socket, or the provider mailbox transport.

State files reject credential-shaped keys, use private permissions, write atomically, and redact errors. Workspace metadata strips secret-shaped fields before it reaches OpenCode. Do not weaken these checks to improve diagnostics; diagnostics must expose evidence without credentials.

## Providers

| Provider | Runtime | Transport | Required host configuration | Phase 1 resource observation |
|---|---|---|---|---|
| `sbx` | Docker Sandbox clone | Published OpenCode port plus supervised SSH control proxy | `sbx` CLI and Docker Sandbox support | Session inspect plus project inventory; inspect reads the durable ownership marker |
| `exedev` | exe.dev VM | SSH and remote control socket | exe.dev access, SSH lobby, pinned host key | Session inspect plus project inventory; inspect matches durable VM identity and owner tag |
| `cloudflare` | Cloudflare Sandbox | Sandbox API plus mailbox control bridge | `SANDBOX_API_URL` and `SANDBOX_API_KEY` | No provider inspect or inventory adapter; provider observations stay unavailable or unknown |

All three use the Sandcastle workspace path by default. The older direct `WorkspaceProviderBase` path remains for injected tests and compatibility. New lifecycle behavior belongs above the provider seam unless the behavior is truly provider-specific.

## Configuration

Configuration precedence, lowest to highest:

1. Defaults in `sandbox/config.ts`.
2. `<project-worktree>/.opencode/sandbox.json`.
3. The JSON object in `SANDBOX_CONFIG`.
4. `SANDBOX_PROVIDER` for provider selection.

This repository selects `sbx` and OpenCode `1.18.25` in `.opencode/sandbox.json`. The tracked plugin dependency and default remote version remain `1.18.23`; the project override is deliberate. Current diagnostics do not expose this drift; it is outside the Phase 1 inspection contract.

`OPENCODE_EXPERIMENTAL_WORKSPACES=1` enables the OpenCode workspace hooks. `home/.bashrc.d/20-opencode.sh` sets it for interactive shells.

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
- A restarted plugin cannot recover, adopt, or delete a control-lost runtime through `sandboxctl`; inspection is read-only. A detached, verified, preserved leak is the separate deletion path.
- SBX ownership can be inspected after restart from its durable marker, and exe.dev from durable VM identity and owner metadata; mutation still requires the creating provider instance. Cloudflare has no provider inspection or inventory adapter and remains unknown-safe.
- The legacy direct SBX path cannot resume a detached runtime under a new generation; it fails closed. The default Sandcastle path recreates the runtime.
- A missing Sandcastle handle during an in-progress deletion leaves the record orphaned; an already-detached deletion can finish workspace cleanup, while recovery and adoption remain unavailable.
- Provider cleanup failure before workspace registration can leave a resource whose ID never reached the lifecycle record.
- Unsupported provider inspection returns unknown observations and no destructive action.
- Default `diagnose` reports only that diagnostics are not configured.

The remaining recovery plan and the concise Phase 1 completion record live in [`history/opencode-sandbox-agent-system-plan.md`](../history/opencode-sandbox-agent-system-plan.md).

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
