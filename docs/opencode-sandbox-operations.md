# OpenCode sandbox operations

Use this runbook to establish what exists, who owns it, whether work is preserved, and which action is safe. The architecture and invariants are in [`opencode-sandbox.md`](opencode-sandbox.md).

## Normal agent path

Inside an OpenCode session, use `/sandbox <operation>`. The command delegates to `sandboxctl` with a session-scoped capability, or the host project capability for `inventory`. Treat the JSON result as authoritative for the lifecycle record and use its structured action fields for decisions.

| Intent | Command | Completion criterion |
|---|---|---|
| Inspect persisted session state | `/sandbox status` | Record-only intent, freshness, and explicit unobserved external sources are visible; classification is `unknown` |
| Inspect one session | `/sandbox inspect` | Classification, effective target, work risk, ownership, and safe next action are returned from bounded probes |
| Inventory this project | `/sandbox inventory` from the host | Project lifecycle records and provider resources are listed without mutation when a provider inventory adapter exists |
| Move execution to a runtime | `/sandbox start` | Response says activation is pending or remote; the next message confirms the remote target |
| Return execution to the host | `/sandbox stop` | A later status is `detached`, and preserved worktree details are reported if present |
| Inspect a failure | `/sandbox diagnose` | A fixed, redacted diagnostic bundle is returned; optional configured-hook details are included, and `{ "configured": false }` means that hook is absent |
| Repeat the recorded failed operation | `/sandbox retry` using the role in `allowedActions` | The recorded `start`, `stop`, `delete`, or `recover` operation is retried only when the typed action is advertised; start and force-delete retries require the host |
| Recover a verified orphan | `/sandbox recover` from the host when advertised | The exact resource is adopted through the configured runtime driver and the existing workspace returns to `remote`; failed or stale recovery remains inspectable without destruction |
| Reconcile a proved stale control-plane record | `/sandbox repair` from the host | State becomes `local` or `detached`; an exact stale workspace registration is removed and no provider resource is mutated |
| Preserve changes and remove | `/sandbox delete` | A verified orphan is adopted first; state becomes `deleted` after synchronization, close/preservation, exact workspace removal, and a fresh ownership check |
| Discard a `sync_failed`, detached, or verified orphan runtime | `/sandbox delete --force` from host | State becomes `deleted`; force may skip synchronization only after verified adoption, and unknown ownership remains blocked |

`/sandbox status` remains record-only and does not query provider, workspace, runtime-target, or Git sources. Use `/sandbox inspect` for one session or `/sandbox inventory` for the project. Do not read `intent.desiredLocation`, `remote`, or the compatibility projections `orphaned` and `recovery_pending` as proof that a resource is healthy or stopped.

## Decision fields

Every result is `SandboxResultV2` with response `schemaVersion: 2`. Disk records use `schemaVersion: 1`; they persist only canonical intent (`desiredLocation` and `phase`) plus lifecycle metadata. Read `effectiveTarget` for the proved execution target; `null` means no target was proved. Read `observations` for the five sources (`record`, `handle`, `workspace`, `provider`, and `git`); an `observed: false` entry is not evidence of absence. Read `classification` for the situation, `work` for preservation risk, `allowedActions` for the complete permitted action set, `recommendedAction` for the controller's recommendation, and `error` for a stable failure code, stage, and retryability.

The result also includes `requestId`, `ok`, `operation`, `message`, `session`, and `intent`. Compatibility fields `state`, `stage`, and non-secret `details` may also be present. The desired location is intent, not a target proof, and prose never overrides `allowedActions`. Observations are fresh response facts, not durable state.

Legacy state-only records are migrated on read under the per-session lock. The store validates the old record, derives canonical intent and phase, writes a private temporary file, syncs it, and renames it atomically. The migration is idempotent and does not query a provider. A normal write omits the compatibility `state` field.

## Observation budget

| Operation | Calls | Deadline and fallback |
|---|---|---|
| `status` | Lifecycle record read only | File-read latency; external sources are `observed: false`. |
| Session `inspect` | One controller probe each for workspace, provider, Git, and runtime target, run in parallel | 5 seconds per probe. Timeout or unavailable provider evidence stays unknown and cannot authorize a new start or ownership-based destruction. There is no separate 15-second aggregate budget. |
| Project `inventory` | One record scan and one configured-provider listing; no per-resource deep probes | 10 seconds for provider inventory. Records remain reportable when provider inventory fails or cannot be scoped to the project. |
| `diagnose` | Fixed bundle plus optional configured diagnostics | The bundle reports its five-probe/30-second diagnostic budget. Controller observations are bounded and redacted; optional hook details are capped at 48 KiB. An absent hook contributes `{ "configured": false }`. |

Provider resource inspection and inventory are implemented for exe.dev and SBX. The default SBX and exe.dev Sandcastle runtime drivers adopt only one running resource with exact durable ownership proof and a matching checkout; SBX also requires a published port, while exe.dev creates fresh local SSH/tunnel state after proof. For exe.dev, keep the durable `remoteDirectory` control path separate from the registered `remoteWorktreePath` checkout. Legacy markers, stopped or unknown status, timeouts, and conflicts remain read-only. The live Cloudflare adapter can inspect a known sandbox's running state; `diagnose` may add active health, but it has no durable resource lookup, inventory, or runtime-adoption adapter after restart. `running(sandboxId)` alone cannot prove ownership, so post-restart provider observation remains unavailable or unknown.

## Situation report

Before mutating provider resources, collect this minimal report:

1. Run `/sandbox status` or read the private lifecycle record when the session command is unavailable.
2. Record `sessionId`, `workspaceId`, `generation`, `provider`, branch, `baseSha`, desired location, phase, operation, and last error.
3. Run `/sandbox inspect` for the session and retain all five observation entries.
4. Inspect the Git branch and `.sandcastle/worktrees/` path for unpreserved changes when the result names a worktree or preservation risk.
5. Classify the result using the table below.

Completion means every known resource is assigned to an ownership tuple or marked unknown. A provider name match, persisted intent, or compatibility state by itself does not complete the report.

Treat a present or unavailable workspace registration, and a failed runtime-target probe, as unknown evidence. Do not classify the session as clean or recommend starting it until provider, runtime handle, and workspace absence are all observed. A provider inventory result with unscoped resources is also unknown for this project.

## Drift classification

| Classification | Required evidence | Safe default |
|---|---|---|
| `clean` | Provider, handle, and workspace are observed absent for a local, detached, or deleted record | Start only when `allowedActions` advertises host `start` with context and capture available; otherwise inspect |
| `attached` | Handle present; provider present, ownership verified, and health known | Follow `recommendedAction` (`stop`); normal stop or delete waits for session idle and preserves work |
| `control_lost` | Non-local record with no handle and unavailable or unknown provider state | Inspect; do not infer resource absence or health |
| `orphan` | Handle absent; provider present with verified ownership; desired location remote | Recover or delete only when `allowedActions` advertises the host runtime-driver path; delete adopts before preservation and destruction |
| `stale_record` | Non-local record with observed absence of provider, handle, and workspace | Host repair when fresh observations prove the preconditions; otherwise inspect |
| `leaked_resource` | Desired location local or deleted; handle absent; provider present with verified ownership | Delete only when `allowedActions` includes host delete and preservation is verified or explicit discard is recorded |
| `conflict` | Any ownership evidence conflicts | Read-only actions; require a human decision |
| `work_at_risk` | Compatibility projection is `sync_failed` or the durable record has a sync error | Retry the recorded operation when listed; preserve work before discard |
| `unknown` | Required evidence is missing, unavailable, or inconsistent | Inspect again or require an operator; take no inferred provider action |

`allowedActions` is authoritative. Each action carries its role, arguments, preconditions, and `waitFor` behavior. Use `recommendedAction` only when it is present in that list. A `null` recommendation means the controller has no safe next action to automate. `error.retryable` describes whether repeating the operation may be useful; it does not authorize a retry, and `retry` is allowed only for the recorded operation when the typed action lists it.

## Reconstructing a failed operation

1. Run `/sandbox status` and retain `requestId`, `intent`, compatibility `state`, `error`, and the recorded identity fields. Status is record-only and does not establish provider or workspace facts.
2. Run `/sandbox diagnose` once. Read `details.results.state.operation`, `details.results.state.lastError`, and `details.results.operationJournal`; correlate the failed response `requestId` with the journal entry. A retry has its own request ID and must not replace the earlier entry.
3. Use the entry's `startedAt`, optional `endedAt`, `resultCode`, and evidence references to reconstruct the lifecycle stage. `PENDING` without `endedAt` means the request crossed an asynchronous boundary or was interrupted; it does not mean the operation succeeded.
4. Use the fresh `diagnose` observations and then `/sandbox inspect` when a current action decision is needed. Preserve all five sources and follow `allowedActions`; do not fill missing facts from provider logs or compatibility prose.
5. Before any destructive action, name the ownership tuple and confirm preservation or an explicit discard authorization. A missing record, missing provider owner proof, or missing journal entry remains unknown-safe.

The journal is bounded to the newest 32 entries and 16 KiB, with 256-byte text values, eight evidence references, and 4 KiB of evidence per entry. State writes and diagnostic output redact credential-shaped values and cap diagnostic details at 48 KiB; the control response remains below 64 KiB. `diagnose` reports version provenance and freshness, but it does not scan global logs, recreate expired history, or prove Cloudflare ownership after restart. Its process result covers tracked lifecycle handles only.

## Documented incident mappings

The focused Phase4 fixture uses these IDs as aliases into the nine classification classes. No additional class is needed for the current recorded conditions.

| Fixture ID | Classification | Safe typed outcome |
|---|---|---|
| `clean-baseline` | `clean` | `start` only when host context and capture are advertised |
| `attached-runtime` | `attached` | `stop` after session idle |
| `runtime-handle-loss` | `control_lost` | inspect; do not infer resource state |
| `cloudflare-post-restart` | `control_lost` | inspect; no post-restart owner proof |
| `legacy-sbx-detached-runtime` | `control_lost` | inspect; legacy path fails closed |
| `missing-handle-with-unavailable-evidence` | `control_lost` | inspect; preserve uncertainty |
| `unsupported-provider-inspection` | `control_lost` | inspect; no provider mutation |
| `plugin-disposal-final-state` | `control_lost` | inspect; final provider state is not durable |
| `verified-orphan` | `orphan` | host `recover` only with an advertised runtime driver |
| `stale-control-plane` | `stale_record` | host `repair` after fresh absence evidence |
| `verified-preserved-leak` | `leaked_resource` | host `delete` only after preservation is verified |
| `ownership-conflict` | `conflict` | inspect; require an operator decision |
| `duplicate-provider-resource` | `conflict` | inspect; do not select a resource by name |
| `checkout-mismatch` | `conflict` | inspect; do not mutate the mismatched checkout |
| `sync-failure` | `work_at_risk` | retry the recorded operation when advertised; preserve first |
| `unknown-provider-evidence` | `unknown` | inspect; take no inferred provider action |
| `cloudflare-known-resource-without-owner` | `unknown` | inspect; live health is not ownership proof |
| `legacy-sbx-marker` | `unknown` | inspect; legacy marker is not restart-proof ownership |
| `stopped-or-unknown-provider-status` | `orphan` | inspect; status is not a safe destructive precondition |
| `provider-cleanup-before-record` | `unknown` | no inferred action; the resource is unattributed |
| `provider-inspection-timeout` | `control_lost` | inspect; timeout is not absence evidence |
| `failed-recovery` | `control_lost` | retry only when typed action is advertised; otherwise inspect |

## Restart boundary

`adopt` remains provider vocabulary. Host `repair` is available only after fresh inspection proves provider absence, runtime-handle absence, and either workspace absence or an exactly owned workspace registration. It removes only that exact registration, never a mismatch, then writes a safe `local` or `detached` record. After a plugin restart, an active Sandcastle record with only a missing handle remains unchanged; verified provider presence may produce the compatibility label `orphaned`, and `recover` or `delete` may reacquire it only when `allowedActions` advertises the configured runtime-driver path. Orphan deletion preserves work before removing the exact workspace, rechecks ownership immediately before destruction, and records completed destruction for retry safety. Recovery itself never destroys a provider resource.

The live Cloudflare path can report read-only running evidence for its known sandbox, and `diagnose` can add active health while the runtime is tracked. It still has no durable provider lookup, inventory, or runtime-adoption adapter after restart; no Cloudflare command, recovery, or destructive action is implied by an `allowedActions` or recommendation field.

## Current SBX orphan procedure

This section is a temporary, human operator-only escape hatch for providers without a production runtime driver or for unsupported SBX evidence. Do not execute it from the `/sandbox` command agent. `sandboxctl recover` and verified-orphan `sandboxctl delete` handle an exact running SBX resource through the injected runtime-driver seam; stopped, legacy-marker, duplicate, timed-out, conflicting, or otherwise unknown resources still require an operator to observe the resource and match the state record before manual cleanup. The compatibility `orphaned` label alone is not that proof.

```bash
sbx ls
ps -o pid,lstart,etime,command -ax | rg '(/usr/bin/ssh|sbx ssh proxy).*oc-sbx-'
```

Match the exact sandbox name and ownership tuple from `providerState`, the repository workspace, session generation, worktree, and branch. New SBX resources also carry that tuple in an external marker, which `/sandbox inspect` verifies when available. Legacy fingerprint-only markers do not prove ownership after a restart. Inspect or preserve changes before removal. Then stop and remove only that exact resource:

```bash
sbx stop <exact-sandbox-name>
sbx rm --force <exact-sandbox-name>
sbx ls
```

The final `sbx ls` must show that the named resource is absent. Remove no sibling resource merely because it belongs to OpenCode.

## Output bounds

- The control response stays below the 64 KiB transport limit. Oversized details are replaced by a redacted `truncated` preview; an irreducibly oversized response returns `RESPONSE_LIMIT` with minimal structured fields.
- Inventory includes at most 1,000 project records and 1,000 provider resources, with bounded detail buckets and a `truncated` marker when needed.
- Logs, diagnostics, and persisted provider metadata are redacted and capped at 48 KiB. Evidence is limited to eight entries, 256 bytes per entry, and 4 KiB total; resource IDs are capped at 128 bytes.
- Provider and process output is capped before it becomes public evidence. Credentials, headers, URLs, and unbounded logs stay out of the result.

## Evidence locations

```text
~/.local/state/opencode-sandbox/       lifecycle records
~/.local/share/opencode/opencode.db    session event history
~/.local/share/opencode/log/           OpenCode logs
.sandcastle/logs/                      Sandcastle logs
.sandcastle/worktrees/                 generated worktrees and preserved code
```

Use `rg -a` for OpenCode logs that contain NUL bytes. Redact tokens, passwords, authorization headers, API keys, and auth files from reports.

## Incident completion

An incident is complete when:

- The session target agrees with the lifecycle record.
- Every provider resource has a verified owner or has been removed.
- Runtime changes are integrated or their preserved worktree is named.
- No stale SSH proxy, control proxy, workspace registration, or lock remains.
- One focused regression fails on the original defect and passes on the fix.
- A changed invariant is updated in the architecture document; routine incidents do not accumulate prose.
