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
| Inspect a failure | `/sandbox diagnose` | Provider-safe details are captured when diagnostics are configured; `{ "configured": false }` means no diagnostics hook is configured |
| Repeat the recorded failed operation | `/sandbox retry` using the role in `allowedActions` | State leaves `error`, `sync_failed`, or `recovery_pending`; start and force-delete retries require the host |
| Recover a verified orphan | `/sandbox recover` from the host when advertised | The exact resource is adopted through the configured runtime driver and the existing workspace returns to `remote`; failed or stale recovery remains inspectable without destruction |
| Reconcile a proved stale control-plane record | `/sandbox repair` from the host | State becomes `local` or `detached`; an exact stale workspace registration is removed and no provider resource is mutated |
| Preserve changes and remove | `/sandbox delete` | A verified orphan is adopted first; state becomes `deleted` after synchronization, close/preservation, exact workspace removal, and a fresh ownership check |
| Discard a `sync_failed`, detached, or verified orphan runtime | `/sandbox delete --force` from host | State becomes `deleted`; force may skip synchronization only after verified adoption, and unknown ownership remains blocked |

`/sandbox status` remains record-only and does not query provider, workspace, runtime-target, or Git sources. Use `/sandbox inspect` for one session or `/sandbox inventory` for the project. Do not read `intent.desiredLocation`, `remote`, or `orphaned` state as proof that a resource is healthy or stopped.

## Decision fields

Every result is `SandboxResultV2` with `schemaVersion: 2`. Read `effectiveTarget` for the proved execution target; `null` means no target was proved. Read `observations` for the five sources (`record`, `handle`, `workspace`, `provider`, and `git`); an `observed: false` entry is not evidence of absence. Read `classification` for the situation, `work` for preservation risk, `allowedActions` for the complete permitted action set, `recommendedAction` for the controller's recommendation, and `error` for a stable failure code, stage, and retryability.

The result also includes `requestId`, `ok`, `operation`, `message`, `session`, and `intent`. Compatibility fields `state`, `stage`, and non-secret `details` may also be present. The desired location is intent, not a target proof, and prose never overrides `allowedActions`.

## Observation budget

| Operation | Calls | Deadline and fallback |
|---|---|---|
| `status` | Lifecycle record read only | File-read latency; external sources are `observed: false`. |
| Session `inspect` | One controller probe each for workspace, provider, Git, and runtime target, run in parallel | 5 seconds per probe. Timeout or unavailable provider evidence stays unknown and cannot authorize a new start or ownership-based destruction. There is no separate 15-second aggregate budget. |
| Project `inventory` | One record scan and one configured-provider listing; no per-resource deep probes | 10 seconds for provider inventory. Records remain reportable when provider inventory fails or cannot be scoped to the project. |
| `diagnose` | Configured diagnostics only | No generic controller probe-count or wall-clock budget. Returned details are redacted and capped at 48 KiB; an unconfigured hook returns `{ "configured": false }`. |

Provider resource inspection and inventory are implemented for exe.dev and SBX. The default SBX and exe.dev Sandcastle runtime drivers adopt only one running resource with exact durable ownership proof and a matching checkout; SBX also requires a published port, while exe.dev creates fresh local SSH/tunnel state after proof. Legacy markers, stopped or unknown status, timeouts, and conflicts remain read-only. The Cloudflare adapter has neither inspection nor inventory, and its bridge has no resource lookup returning durable owner metadata; `running(sandboxId)` alone cannot prove ownership after restart, so its provider observation is unavailable or unknown.

## Situation report

Before mutating provider resources, collect this minimal report:

1. Run `/sandbox status` or read the private lifecycle record when the session command is unavailable.
2. Record `sessionId`, `workspaceId`, `generation`, `provider`, branch, `baseSha`, operation phase, and last error.
3. Run `/sandbox inspect` for the session and retain all five observation entries.
4. Inspect the Git branch and `.sandcastle/worktrees/` path for unpreserved changes when the result names a worktree or preservation risk.
5. Classify the result using the table below.

Completion means every known resource is assigned to an ownership tuple or marked unknown. A provider name match by itself does not complete the report.

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
| `work_at_risk` | Recorded state is `sync_failed` | Retry the recorded operation when listed; preserve work before discard |
| `unknown` | Required evidence is missing, unavailable, or inconsistent | Inspect again or require an operator; take no inferred provider action |

`allowedActions` is authoritative. Each action carries its role, arguments, preconditions, and `waitFor` behavior. Use `recommendedAction` only when it is present in that list. A `null` recommendation means the controller has no safe next action to automate.

## Restart boundary

`adopt` remains provider vocabulary. Host `repair` is available only after fresh inspection proves provider absence, runtime-handle absence, and either workspace absence or an exactly owned workspace registration. It removes only that exact registration, never a mismatch, then writes a safe `local` or `detached` record. After a plugin restart, an active Sandcastle record with only a missing handle remains unchanged; verified provider presence may be recorded as `orphaned`, and `recover` or `delete` may reacquire it only when `allowedActions` advertises the configured runtime-driver path. Orphan deletion preserves work before removing the exact workspace, rechecks ownership immediately before destruction, and records completed destruction for retry safety. Recovery itself never destroys a provider resource.

The Cloudflare path has no provider inspection or inventory adapter. Its provider observation remains unavailable or unknown, and no Cloudflare command is implied by an `allowedActions` or recommendation field.

## Current SBX orphan procedure

This section is a temporary, human operator-only escape hatch for providers without a production runtime driver or for unsupported SBX evidence. Do not execute it from the `/sandbox` command agent. `sandboxctl recover` and verified-orphan `sandboxctl delete` handle an exact running SBX resource through the injected runtime-driver seam; stopped, legacy-marker, duplicate, timed-out, conflicting, or otherwise unknown resources still require an operator to observe the resource and match the state record before manual cleanup. The current `orphaned` state alone is not that proof.

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
