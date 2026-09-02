# Plan: make the OpenCode sandbox agent-native

Status: active plan, proposed on 2026-09-02. It lives in `history/` because this repository stores agent-generated plans there, and `AGENTS.md` links it explicitly while active. Publish its delivery phases as tracer tickets when `tk` is available. Current behavior remains documented in [`docs/opencode-sandbox.md`](../docs/opencode-sandbox.md).

## Outcome

An agent should be able to answer five questions from one bounded inspection:

1. Where will the next tool call execute?
2. Which resources exist, and who owns each one?
3. Is any code at risk of being lost?
4. Which actions are valid now?
5. What is the cheapest safe action that reaches the requested state?

The lifecycle controller should answer those questions without asking the agent to interpret `sbx`, SSH, Cloudflare, OpenCode workspace, and Git outputs separately.

## Design rules

- Keep one intent interface. Agents request outcomes such as local, remote, inspected, or deleted.
- Keep provider commands below the lifecycle seam.
- Separate desired state, transition phase, observed health, and ownership classification.
- Make every destructive action prove ownership and preservation first.
- Prefer local records for cheap status. Probe providers only for inspection, diagnosis, recovery, or destructive preflight.
- Return typed next actions. Prose explains a decision but never carries the only copy of it.
- Keep the file state store. Do not add a daemon, database, telemetry system, or event-sourcing layer.
- Turn a fixed incident into one regression. Add documentation only when the invariant or operating procedure changed.

## Target situation model

The current `SandboxState` combines several dimensions. Replace it with a versioned record that keeps them separate:

```text
desiredLocation: local | remote | deleted
phase: idle | capturing | provisioning | activating | syncing | detaching | deleting
health: healthy | degraded | unknown
control: attached | lost | not_required
resource: present | absent | unknown
ownership: verified | unknown | conflict
```

Keep the last operation and stable error code beside these dimensions. Persist `schemaVersion` and migrate existing records because they already exist outside the repository.

Derive situation labels such as attached, orphan, stale record, leaked resource, and conflict from those facts. A verified orphan can be adopted, preserved and removed, or explicitly discarded. Control loss without provider observation remains unknown. A conflict remains blocked.

## Target result contract

The current response has no schema version and remains the compatibility contract until Phase 1. Version 2 is normative:

```ts
type PublicOperation =
  | "start"
  | "stop"
  | "status"
  | "inspect"
  | "inventory"
  | "logs"
  | "diagnose"
  | "retry"
  | "recover"
  | "repair"
  | "delete"

type SandboxResultV2 = {
  schemaVersion: 2
  requestId: string
  ok: boolean
  operation: PublicOperation
  message: string
  session: null | {
    projectId: string
    sessionId: string
    workspaceId: string
    generation: number
    provider: "sbx" | "exedev" | "cloudflare"
  }
  intent: {
    desiredLocation: "local" | "remote" | "deleted"
    phase: "idle" | "capturing" | "provisioning" | "activating" | "syncing" | "detaching" | "deleting"
  }
  effectiveTarget: null | { kind: "local"; directory: string } | { kind: "remote"; resourceId: string }
  observations: Array<{
    source: "record" | "handle" | "workspace" | "provider" | "git"
    observed: boolean
    freshAt: string
    resource?: "present" | "absent" | "unknown"
    ownership?: "verified" | "unknown" | "conflict"
    health?: "healthy" | "degraded" | "unknown"
    evidence: string[]
  }>
  classification: "clean" | "attached" | "control_lost" | "orphan" | "stale_record" | "leaked_resource" | "conflict" | "work_at_risk" | "unknown"
  work: {
    captureBaseSha: string | null
    runtimeHead: string | null
    sync: "clean" | "dirty" | "failed" | "unknown"
    preservation: "not_needed" | "preserved" | "at_risk" | "discard_authorized"
    preservedWorktreePath: string | null
  }
  allowedActions: Array<{
    operation: PublicOperation
    role: "host" | "remote"
    arguments: string[]
    preconditions: string[]
    waitFor: "none" | "session_idle" | "operation_completion"
  }>
  recommendedAction: null | { operation: PublicOperation; reasonCode: string }
  error: null | { code: string; stage: string; retryable: boolean }
}
```

`status` sets `observed: false` for provider, workspace, handle, and Git sources it did not query. `inspect` fills those observations. `effectiveTarget` is non-null only when the workspace route or live handle proves it. URLs, headers, capabilities, and credentials stay out of the response. `/sandbox` presents classification, effective target, work risk, error, recommended action, and the chosen action's preconditions and wait behavior; it does not dump empty fields.

## Target module seams

### Lifecycle controller

Expose one operation interface and return the target result contract. Own locking, desired state, transition order, preservation policy, and action selection.

### Runtime driver

Replace the split between the default Sandcastle path and the older direct provider path with one internal interface:

```text
create(owner, capture) -> resource reference and target
inspect(resource reference) -> observed resource
adopt(resource reference, owner) -> controllable runtime session
sync(runtime session) -> preservation result
close(runtime session) -> preservation result
destroy(resource reference, verified owner) -> result
```

`exe.dev`, `sbx`, and Cloudflare are real adapters at this seam. Sandcastle remains an implementation helper, not a second lifecycle architecture.

Provider inspection, diagnostics, logs, preservation preflight, and destruction move behind this interface. Remove `InfrastructureOperations` after all three adapters cover those behaviors; do not keep both seams.

### Workspace gateway

Keep OpenCode workspace routing behind one interface. Every method must carry the intended directory, use the injected transport, and return validated values.

### Situation inspector

Build a read-only view by joining the lifecycle record, workspace registry, runtime handle, provider observation, and Git evidence. Keep probes bounded and parallel. Cache nothing until measurements show a need.

## Command layers

| Layer | Verbs | Meaning |
|---|---|---|
| Current public commands | `start`, `stop`, `status`, `delete`, `logs`, `diagnose`, `retry` | Preserve compatibility while safety work lands |
| Proposed public session commands | `inspect`, `recover`, `repair` | Observe the current ownership tuple, reacquire a verified runtime, or reconcile stale records |
| Proposed public host command | `inventory` | Compare all lifecycle records with provider resources without mutation |
| Controller operations | current verbs plus inspect/recover/repair/inventory | Authorize roles, serialize decisions, and return the result contract |
| Provider methods | `create`, `inspect`, `adopt`, `sync`, `close`, `destroy` | Implement provider behavior; never appear in `/sandbox` output as user actions |

`adopt` is provider vocabulary. The public intent is `recover`. `inventory` is host-only and read-only. `repair` is also host-only and changes control-plane records only after inspection proves the external situation. `delete` remains the sole public destruction verb.

The capability gains `scope: "session" | "project"`. Normal commands use session scope. Host `inventory` requires project scope and remains read-only. No remote capability receives project scope.

| Operation | Role | Scope | Mutation | Transport |
|---|---|---|---|---|
| `status`, `inspect`, `logs`, `diagnose` | host or remote | session | no | Existing control channel |
| `start` | host | session | yes | Existing control channel |
| `stop` | host or remote | session | yes | Existing control channel |
| `retry` | role required by the recorded operation | session | yes | Existing control channel |
| `delete` | host or remote without force; host with force | session | yes | Existing control channel |
| `recover`, `repair` | host | session | yes | Existing control channel |
| `inventory` | host | project | no | Existing control channel with project capability |

## Delivery sequence

Each phase leaves one useful vertical path working. Do not begin the state redesign before resource cleanup is safe.

### Phase 0: close the existing safety holes

Progress on 2026-09-02:

- Completed: keep the shared SBX control proxy alive until its provider has no active workspace.
- Completed: enforce host-only start in the lifecycle controller, including retry.
- Completed: fail Cloudflare cleanup on a non-zero remote exit and verify `HEAD` before reuse.
- Completed: route workspace creation and replay through the requested directory and injected transport.
- Remaining: disposal, ownership proof, serialization, failed-start workspace cleanup, bounded diagnostics, and launcher fallback.

Changes:

- Make plugin disposal await an idempotent lifecycle disposal that closes every owned Sandcastle session, rejects target gates, cancels idle work, and closes provider resources at their correct scope.
- Clean up an OpenCode workspace registration when start fails after workspace creation, without claiming the provider resource is absent unless inspection proves it.
- Give the SBX control proxy provider lifetime or explicit reference counting; releasing one workspace must not break another.
- Hold the session record lock across the full `delete`, `retry`, and reconciliation decision and write.
- Centralize role authorization in the lifecycle controller so remote `retry` cannot invoke host-only start or destructive paths.
- Verify provider ownership before SBX or Cloudflare reuse, stop, or destruction. Force may waive preservation, never ownership.
- Treat non-zero Cloudflare cleanup commands as failures and verify checkout `HEAD` before reuse.
- Send the requested directory during workspace creation and use the injected fetcher for replay.
- Redact and bound logs and diagnostics before the control channel serializes them.
- Remove the broken Node fallback from `sandboxctl`, or ship and test the fallback artifact.

Completion criteria:

- A disposal regression leaves no owned runtime handle or supervisor process.
- A failure after workspace creation removes the workspace and reports unknown provider state until observed.
- Two concurrent SBX workspaces survive releasing either one.
- Concurrent delete, retry, and reconciliation tests prove one serialized outcome.
- A complete role matrix proves remote capabilities cannot reach host-only behavior through retry or another indirect operation.
- Name collisions and stale resource IDs block reuse and destruction until ownership is verified.
- Cloudflare cleanup and reuse tests fail on non-zero exit or mismatched `HEAD`.
- Workspace gateway tests assert directory and injected transport use.
- Oversized or secret-bearing diagnostics are bounded and redacted at the producer.

### Phase 1: make inspection decision-ready

Changes:

- Add a read-only `inspect` operation that returns the target result contract.
- Keep `status` as a cheap record read and include freshness plus an explicit `observed: false` marker.
- Add host-only inventory across lifecycle records and provider resources.
- Return effective target, observations with freshness, resource ownership, `allowedActions`, `recommendedAction`, stable error code, and preservation status from every operation.
- Include exact evidence references, not raw secrets or unbounded logs.

Completion criteria:

- One command distinguishes healthy attachment, control loss with unknown resource state, stale record, verified orphan, leak, and ownership conflict in tests.
- The command performs no provider calls in cheap status mode.
- An agent test chooses the safe next action using structured fields only.

Provider observation budget:

| Mode | Calls | Deadline | Unsupported ownership behavior |
|---|---|---|---|
| `status` | No provider calls | File-read latency only | Report `observed: false` |
| Session `inspect` | One provider inventory call plus at most two targeted probes | 5 seconds per call, 15 seconds total | Return `ownership: unknown`; permit no destructive action |
| Project `inventory` | One listing call per configured provider, in parallel | 10 seconds total | List lifecycle records and mark provider side unknown |
| `diagnose` | At most five targeted probes | 30 seconds total | Return partial observations and evidence for the failed probe |

SBX must expose inspectable owner metadata beyond its generated name. exe.dev must match durable VM identity and owner metadata. Cloudflare must expose a resource lookup that returns owner metadata. Until an adapter can prove ownership, inspection returns unknown and destruction stays blocked.

### Phase 2: close the recovery loop

Changes:

- Add `inspect` and `adopt` behavior to each provider adapter.
- Permit deletion of a verified orphan through the lifecycle controller.
- Preserve or name the worktree before destroying any recoverable runtime.
- Add a host-only repair path for stale records and workspace registrations.
- Make reconciliation produce a plan first; apply only actions allowed by ownership and preservation checks.

Completion criteria:

- Restart an active session, observe the resource, recover control, stop it, and return to the host in an integration test.
- Restart an active session with a missing provider resource and repair the stale record.
- Present a conflicting resource and prove that reconciliation performs no mutation.
- Remove a verified orphan without invoking provider commands outside the controller.

### Phase 3: separate state dimensions

Changes:

- Introduce the versioned situation model and migrate current records.
- Derive compatibility responses for existing operations during the migration.
- Make transitions functions of desired location plus observed situation, rather than a growing graph of mixed states.
- Remove `recovery_pending` and terminal `orphaned` only after all provider recovery paths pass.

Completion criteria:

- Every old `SandboxState` record migrates deterministically.
- A table-driven test covers every desired state, control state, resource state, and ownership classification.
- No state requires prose such as "manual recovery required" without a typed next action.

Persist intent and phase. Derive control, resource, ownership, health, classification, and effective target from fresh observations rather than treating them as durable truth.

Migration from current records:

| Current state | Desired location | Phase |
|---|---|---|
| no record, `local`, `detached` | local | idle |
| `provisioning` | remote | provisioning |
| `activation_pending` | remote | activating |
| `remote` | remote | idle |
| `stop_pending` | local | detaching |
| `delete_pending` | deleted | deleting |
| `deleted` | deleted | idle |
| `sync_failed`, `recovery_pending`, `orphaned`, `error` | derive from recorded operation: start=remote, stop=local, delete=deleted | idle until inspection selects a safe next phase |

Legal combinations:

- `capturing`, `provisioning`, and `activating` require desired remote.
- `detaching` requires desired local.
- `deleting` requires desired deleted.
- `syncing` may serve any desired location and must name the operation it blocks.
- `effectiveTarget` comes from an observed workspace route or live handle, never from desired location.
- `orphan` requires control lost, resource present, and ownership verified.
- `stale_record` requires resource absent and workspace absent.
- `leaked_resource` requires desired local or deleted, resource present, and ownership verified.
- `conflict` follows any ownership conflict and permits only read-only actions.
- Any missing required observation yields `control_lost` or `unknown`, not a guessed classification.

Test legal combinations and derived classifications, not the unconstrained Cartesian product.

### Seam migration

| Current seam | Migration | Removal gate |
|---|---|---|
| `LifecycleDependencies.sandcastle` | Runtime driver creates and adopts runtime handles | All providers pass create, restart-recover, sync, and destroy scenarios |
| `providerRelease` / `providerDestroy` | Runtime driver `close` / `destroy` | No lifecycle branch calls provider closures directly |
| `InfrastructureOperations` | Runtime driver inspection, diagnostics, and destruction preflight | Logs, diagnosis, ownership, and deletion tests use only the runtime driver |
| `WorkspaceProviderBase` direct path | Provider adapters behind the runtime driver | Injected provider tests use the same lifecycle path as production |
| `SandcastleSession` | Private runtime-handle implementation | Lifecycle imports only the runtime-driver interface |

The migration is complete only when `LifecycleController` has one runtime-driver seam and one workspace-gateway seam. Remove the old paths in the same phase; do not leave compatibility layers without an external consumer.

### Phase 4: make learning accretive

Changes:

- Record a bounded operation journal in each state record: request ID, operation, start/end time, result code, and evidence references. Keep only the latest entries.
- Add a redacted diagnostic bundle command that captures versions, identities, state, workspace association, provider observation, and process ownership.
- Add scenario fixtures for every incident class. Prefer one end-to-end fixture over provider-specific copies when the lifecycle behavior is shared.
- Generate command reference tables from the operation and state constants if documentation drift recurs. Do not add generation preemptively.

Completion criteria:

- A failed operation can be reconstructed without scanning global logs.
- Diagnostic output is bounded, redacted, and deterministic enough for a regression fixture.
- Every production incident maps to an existing scenario class or adds exactly one new class.

## Command vocabulary decision

Keep current verbs during the safety work. Add `inspect` only when it can observe providers. Use `retry` for repeating an unchanged failed operation. Use `recover` only for reacquiring a verified external resource. Use `repair` only for reconciling stale control-plane records. These verbs describe different actions and should not be aliases.

System-wide inventory and repair must be host-only. Remote capabilities remain session-scoped and cannot start, force-delete, adopt, or repair resources.

## Resource budget

- `status`: file read only.
- `inspect`: bounded concurrent probes for one ownership tuple.
- `inventory`: one state scan plus provider listings, with no per-resource deep probe by default.
- `diagnose`: deeper health and log checks, explicit and bounded.
- `start`, `stop`, `delete`, `recover`, `repair`: serialized mutation with before-and-after inspection.

Do not poll when an operation can wait on an existing event or process result. Do not retain provider clients after their owning lifecycle scope closes. Do not copy full logs into state; retain references and stable result codes.

## Documentation maintenance

- `CONTEXT.md` owns terminology only.
- `docs/opencode-sandbox.md` owns current architecture and invariants.
- `docs/opencode-sandbox-operations.md` owns live diagnosis and cleanup procedure.
- This file owns the proposed delivery sequence until the work is ticketed and completed.
- Tests own detailed behavioral examples.
- Historical research keeps its original conclusions with a superseded notice.

When implementation changes current behavior, update the architecture and runbook in the same commit. Remove completed plan sections rather than leaving them as sediment.
