# OpenCode sandbox operations

Use this runbook to establish what exists, who owns it, whether work is preserved, and which action is safe. The architecture and invariants are in [`opencode-sandbox.md`](opencode-sandbox.md).

## Normal agent path

Inside an OpenCode session, use `/sandbox <operation>`. The command delegates to `sandboxctl` with a session-scoped capability. Treat the JSON result as authoritative for the lifecycle record.

| Intent | Command | Completion criterion |
|---|---|---|
| Inspect persisted session state | `/sandbox status` | State, provider, branch, and any recovery metadata are visible; missing phase, generation, and error data are treated as unknown |
| Move execution to a runtime | `/sandbox start` | Response says activation is pending or remote; the next message confirms the remote target |
| Return execution to the host | `/sandbox stop` | A later status is `detached`, and preserved worktree details are reported if present |
| Inspect a failure | `/sandbox diagnose` | Provider-safe details are captured when diagnostics are configured; `{ "configured": false }` means provider inspection remains manual |
| Repeat the recorded failed operation | `/sandbox retry` from the host | State leaves `error`, `sync_failed`, or `recovery_pending`; do not retry a failed start from a remote capability |
| Preserve changes and remove | `/sandbox delete` | State becomes `deleted` after the idle transition |
| Discard a `sync_failed` or detached runtime | `/sandbox delete --force` from host | State becomes `deleted`; separately verify ownership because the current adapters do not always do so |

The current `/sandbox status` is record-only. It does not query provider inventory. Do not read "remote" as proof that a resource is healthy, or "orphaned" as proof that it stopped.

## Situation report

Before mutating provider resources, collect this minimal report:

1. Run `/sandbox status` or read the private lifecycle record when the session command is unavailable.
2. Record `sessionId`, `workspaceId`, `generation`, `provider`, branch, `baseSha`, operation phase, and last error.
3. Inspect the OpenCode workspace association.
4. Inspect the matching provider resource and its creation/runtime metadata.
5. Inspect the Git branch and `.sandcastle/worktrees/` path for unpreserved changes.
6. Classify the result using the table below.

Completion means every known resource is assigned to an ownership tuple or marked unknown. A provider name match by itself does not complete the report.

## Drift classification

| Record | Handle | Provider resource | Classification | Safe default |
|---|---|---|---|---|
| absent/deleted | absent | absent | clean | No action |
| remote/pending | present | healthy | attached | Continue the lifecycle operation |
| remote/pending | absent | unknown | control lost | Inspect the provider before classifying or mutating |
| remote/pending | absent | present, ownership verified | orphan | Preserve or recover, then remove through an explicit operator action |
| remote/pending | absent | absent | stale record | Repair the record only after checking workspace and Git evidence |
| detached | absent | present | leaked resource | Verify ownership and preservation, then destroy |
| any | any | present, ownership conflicts | conflict | Stop automation and require a human decision |
| sync_failed | present | present | work at risk | Preserve first; discard only on explicit host request |

## Current SBX orphan procedure

This section is a temporary, human operator-only escape hatch. Do not execute it from the `/sandbox` command agent. `sandboxctl` cannot recover an orphan yet. An operator may clean one manually only after observing the resource and matching the state record to it. The current `orphaned` state alone is not that proof.

```bash
sbx ls
ps -o pid,lstart,etime,command -ax | rg '(/usr/bin/ssh|sbx ssh proxy).*oc-sbx-'
```

Match the exact sandbox name from `providerState`, the repository workspace, session generation, worktree, and branch. Inspect or preserve changes before removal. Then stop and remove only that exact resource:

```bash
sbx stop <exact-sandbox-name>
sbx rm --force <exact-sandbox-name>
sbx ls
```

The final `sbx ls` must show that the named resource is absent. Remove no sibling resource merely because it belongs to OpenCode.

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
