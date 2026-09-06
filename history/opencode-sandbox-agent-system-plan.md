# Plan: make the OpenCode sandbox agent-native

Status: Phase 2 SBX and exe.dev adoption plus verified-orphan deletion completed on 2026-09-06 for the default Sandcastle path; Cloudflare recovery remains deferred. This file lives in `history/` for the remaining proposal and its concise delivery record. Current behavior is documented in [`docs/opencode-sandbox.md`](../docs/opencode-sandbox.md).

## Outcome

For providers with observation adapters, an agent should be able to answer five questions from one bounded inspection:

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

Derive situation labels such as attached, orphan, stale record, leaked resource, and conflict from those facts. A verified orphan can be adopted only through a configured runtime driver; preservation and destruction remain separate actions. Control loss without provider observation remains unknown. A conflict remains blocked.

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
| Current public commands | `start`, `stop`, `status`, `inspect`, `inventory`, `delete`, `logs`, `diagnose`, `retry`, `recover`, `repair` | Lifecycle operations plus the Phase 1 read paths, verified orphan recovery, and stale-record repair |
| Host-only runtime commands | `recover` when advertised; `repair` | Reacquire an exact runtime or reconcile only a freshly proven stale control-plane record |
| Controller operations | Current verbs | Authorize roles, serialize decisions, and return the versioned result contract |
| Provider methods | `create`, `inspect`, `adopt`, `sync`, `close`, `destroy` | Implement provider behavior; provider methods never appear in `/sandbox` output as user actions |

`adopt` is provider vocabulary. The public intent is host-only `recover`, advertised only when the configured runtime driver can reacquire the exact resource. `inventory` is host-only and read-only. `repair` is host-only and may change only the control plane after fresh inspection proves provider and handle absence plus workspace absence or an exact owned registration. `delete` remains the sole public destruction verb for provider resources.

The capability gains `scope: "session" | "project"`. Normal commands use session scope. Host `inventory` requires project scope and remains read-only. No remote capability receives project scope.

| Operation | Role | Scope | Mutation | Transport |
|---|---|---|---|---|
| `status`, `inspect`, `logs`, `diagnose` | host or remote | session | no | Existing control channel |
| `start` | host | session | yes | Existing control channel |
| `stop` | host or remote | session | yes | Existing control channel |
| `retry` | role required by the recorded operation | session | yes | Existing control channel |
| `delete` | host or remote without force; host with force | session | yes | Existing control channel |
| `repair` | host | session | yes, control plane only | Existing control channel |
| `recover` | host, when advertised | session | yes, runtime adoption only | Existing control channel |
| `inventory` | host | project | no | Existing control channel with project capability |

## Delivery sequence

Each phase leaves one useful vertical path working. Do not begin the state redesign before resource cleanup is safe.

### Phase 0: close the existing safety holes (completed 2026-09-02)

- Kept the shared SBX control proxy alive across active workspaces and made plugin disposal idempotent and awaited.
- Enforced host-only start, including retry, and serialized delete, retry, reconciliation, and final state writes.
- Added provider ownership checks, Cloudflare cleanup/checkout validation, correct workspace directory and replay transport, and failed-start workspace cleanup.
- Removed the unshipped Node fallback and bounded/redacted logs, diagnostics, and recovery metadata.

### Phase 1: make inspection decision-ready (completed 2026-09-02)

The completed vertical path is recorded here; its current contract and operating limits live in [`docs/opencode-sandbox.md`](../docs/opencode-sandbox.md) and [`docs/opencode-sandbox-operations.md`](../docs/opencode-sandbox-operations.md).

- Added versioned `SandboxResultV2` responses with effective target, five-source observations, work preservation state, classifications, allowed actions, recommendations, and stable errors.
- Added read-only session `inspect` and host-only project `inventory`; `status` remains a provider-free record read with explicit freshness and `observed: false` markers.
- Added bounded parallel workspace, provider, runtime-target, and Git probes, a 5-second per-probe inspection deadline, and a 10-second provider inventory deadline.
- Added exe.dev identity/owner-tag inspection and SBX inventory/ownership-marker inspection. Provider inventory remains a listing, not session ownership proof.
- Added session/project capability authorization, redaction, response bounds, and inventory bounds.
- Deferred recovery, adoption, and destructive control of a post-restart control-lost runtime to Phase 2. Cloudflare has no Phase 1 provider inspection or inventory adapter and remains unknown-safe.

### Phase 2: close the recovery loop (completed 2026-09-06 for SBX and exe.dev)

Delivered in this slice:

- Added host-only `repair` for stale records and exactly owned workspace registrations; it writes a safe `local` or `detached` record and does not delete state files.
- Made startup reconciliation produce a read-only observation plan first, then apply only an attached or provider-verified orphan decision after locked record identity/generation/`updatedAt` revalidation. Unknown and conflicting plans do not mutate.
- Added the five-method `RuntimeDriver` seam (`inspect`, `adopt`, `sync`, `close`, `destroy`) and extended Sandcastle sessions with default SBX and exe.dev implementations.
- Added host-only `recover` with locked fresh preflight, exact resource/ownership checks, stale-plan rejection, existing-workspace routing, safe adoption failure persistence, and fake-driver tests proving normal creation is not called.
- Added exe.dev restart adoption with durable VM identity/owner-tag proof, read-only checkout verification, fresh local credentials and supervisor state, VM-preserving sync/close, and exact-identity destruction tests.
- Added verified-orphan deletion with host-only runtime adoption, preservation-before-destruction ordering, fresh ownership rechecks, explicit force-discard semantics, persisted destruction state, and retry-safe lifecycle tests.

Deferred:

- Add a Cloudflare bridge resource lookup returning the durable sandbox ID and owner tuple, then add a runtime driver before claiming Cloudflare recovery or deletion support. The current bridge can query `running(sandboxId)` only; `CloudflareProvider` keeps ownership in a process-local map, so a restarted record cannot prove ownership.
- Add destructive post-restart control only after Cloudflare passes recovery and ownership proof; unsupported control-lost/orphaned resources remain read-only until then.

Completion criteria:

- Met: restart an active SBX session, observe the resource, recover control, stop it, and return to the host without create commands.
- Met: restart an active session with a missing provider resource and repair the stale record.
- Met: present a conflicting resource and prove that reconciliation performs no mutation.
- Met: remove a verified orphan without invoking provider commands outside the controller for SBX and exe.dev.

`recover` and `repair` are exposed by `sandboxctl`; `recover` and verified-orphan deletion are actionable only when a runtime driver is configured. SBX and exe.dev adoption and deletion are now available for exact running resources; Cloudflare recovery and deletion remain deferred.

### Phase 3: separate state dimensions

Changes:

- Introduce the versioned situation model and migrate current records.
- Derive compatibility responses for existing operations during the migration.
- Make transitions functions of desired location plus observed situation, rather than a growing graph of mixed states.
- Remove `recovery_pending` and simplify the `orphaned` recovery gate only after all provider recovery paths pass.

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
| `LifecycleDependencies.sandcastle` | Optional runtime driver creates and adopts runtime handles | All providers pass create, restart-recover, sync, and destroy scenarios |
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

Phase 1 adds `inspect` where an adapter can observe a provider and `inventory` as a host-only project read. Phase 2 adds host-only `recover` where a runtime driver can reacquire a verified external resource. Use `retry` for repeating an unchanged failed operation and `repair` only for reconciling stale control-plane records. These verbs describe different actions and should not be aliases.

System-wide inventory and repair must be host-only. Remote capabilities remain session-scoped and cannot start, force-delete, adopt, recover, or repair resources.

## Resource budget

The implemented read budgets and output bounds are maintained in [`docs/opencode-sandbox.md`](../docs/opencode-sandbox.md). Future recovery, and any expansion of repair, must retain bounded, read-before-mutate behavior.

Do not poll when an operation can wait on an existing event or process result. Do not retain provider clients after their owning lifecycle scope closes. Do not copy full logs into state; retain references and stable result codes.

## Documentation maintenance

- `CONTEXT.md` owns terminology only.
- `docs/opencode-sandbox.md` owns current architecture and invariants.
- `docs/opencode-sandbox-operations.md` owns live diagnosis and cleanup procedure.
- This file owns the remaining proposed delivery sequence and concise completion records.
- Tests own detailed behavioral examples.
- Historical research keeps its original conclusions with a superseded notice.

When implementation changes current behavior, update the architecture and runbook in the same commit. Remove completed plan sections rather than leaving them as sediment.
