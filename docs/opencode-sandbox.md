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
| Control channel | Authenticated `ControlRequest -> SandboxResponse` | Role, session, generation, expiry, and transport framing | Lifecycle decisions or producer-side log limits |
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

This is the required ownership rule. The current provider adapters do not enforce it consistently. Names are conveniences, not proof of ownership. A matching `oc-sbx-*` prefix alone is insufficient for deletion.

## Authoritative state

No single current data source proves the whole situation:

| Source | Proves | Cannot prove |
|---|---|---|
| Lifecycle record | Last committed intent, phase, identity, provider metadata, error | Current provider health or a live handle |
| In-memory runtime session | This plugin instance can control the runtime | Survival across plugin restart |
| OpenCode workspace registry | Session routing association | Provider resource ownership |
| Provider inventory | Resource existence and provider status | Correct OpenCode session owner unless metadata matches |
| Git branch/worktree | Preserved code lineage | Runtime process health |

Reconciliation means comparing these sources. The current implementation only performs part of that comparison. The target design is recorded in [`history/opencode-sandbox-agent-system-plan.md`](../history/opencode-sandbox-agent-system-plan.md).

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

The states currently mix stable location, transition phase, and failure classification. `orphaned` is terminal in the current state machine. The current reconciliation code assigns it when a lifecycle record looks active but the new plugin instance has no in-memory session handle. No provider observation occurs, so the label proves control was lost, not that the runtime still exists. The target model reserves "orphan" for a resource that was actually observed.

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

Normal deletion attempts to preserve changes before destruction. `delete --force` is host-only and is limited to a detached runtime or explicit discard after sync failure. The lifecycle should block unknown ownership, but the current SBX and Cloudflare adapters can destroy by recorded name or ID without independent ownership proof. Perform the operator preflight in the runbook until Phase 0 closes this gap.

### Recovery

Non-Sandcastle pending states enter `recovery_pending` during plugin startup and replay their cleanup path. Sandcastle state currently depends on an in-memory handle; after restart it becomes `orphaned` and requires operator cleanup. This is the largest break in the control loop.

## Control and trust

The plugin injects a short-lived capability into the shell environment. The capability is scoped to one session generation and either the host or remote role. Both the CLI and lifecycle controller block remote `start`; retry cannot bypass that rule. `delete --force` is also host-only. The control channel accepts only loopback TCP, a private Unix socket, or the provider mailbox transport.

State files reject credential-shaped keys, use private permissions, write atomically, and redact errors. Workspace metadata strips secret-shaped fields before it reaches OpenCode. Do not weaken these checks to improve diagnostics; diagnostics must expose evidence without credentials.

## Providers

| Provider | Runtime | Transport | Required host configuration |
|---|---|---|---|
| `sbx` | Docker Sandbox clone | Published OpenCode port plus supervised SSH control proxy | `sbx` CLI and Docker Sandbox support |
| `exedev` | exe.dev VM | SSH and remote control socket | exe.dev access, SSH lobby, pinned host key |
| `cloudflare` | Cloudflare Sandbox | Sandbox API plus mailbox control bridge | `SANDBOX_API_URL` and `SANDBOX_API_KEY` |

All three use the Sandcastle workspace path by default. The older direct `WorkspaceProviderBase` path remains for injected tests and compatibility. New lifecycle behavior belongs above the provider seam unless the behavior is truly provider-specific.

## Configuration

Configuration precedence, lowest to highest:

1. Defaults in `sandbox/config.ts`.
2. `<project-worktree>/.opencode/sandbox.json`.
3. The JSON object in `SANDBOX_CONFIG`.
4. `SANDBOX_PROVIDER` for provider selection.

This repository selects `sbx` and OpenCode `1.18.25` in `.opencode/sandbox.json`. The tracked plugin dependency and default remote version remain `1.18.23`; the project override is deliberate. Current diagnostics do not expose this drift. The plan requires them to do so.

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

- Plugin disposal drops Sandcastle handles without closing their sessions.
- A restarted plugin cannot inspect, adopt, or delete a control-lost runtime through `sandboxctl`.
- SBX and Cloudflare reuse or destruction do not consistently prove provider-resource ownership.
- `delete`, `retry`, and reconciliation do not hold the record lock across their complete decision and write.
- A Sandcastle start failure can leave an OpenCode workspace registration behind, and a missing handle can be marked deleted without proving the provider resource is absent.
- `status` omits phase, generation, `baseSha`, freshness, last error, observed resources, allowed actions, and a recommended next action.
- Default `diagnose` reports only that diagnostics are not configured. Log production is not redacted or bounded before transport.
- `sandboxctl` advertises a Node fallback file that is not shipped; Bun is currently required.

The ordered fix plan and acceptance criteria live in [`history/opencode-sandbox-agent-system-plan.md`](../history/opencode-sandbox-agent-system-plan.md).

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
