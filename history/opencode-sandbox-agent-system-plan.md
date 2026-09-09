# Plan: make the OpenCode sandbox agent-native

Status: Phases 0-4 evidence criteria are complete for the default Sandcastle path; Cloudflare recovery and provider-seam unification remain deferred. This file lives in `history/` for the remaining work and concise completion record. Current behavior is documented in [`docs/opencode-sandbox.md`](../docs/opencode-sandbox.md).

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

The former `SandboxState` combined several dimensions. The current versioned record keeps them separate:

```text
desiredLocation: local | remote | deleted
phase: idle | capturing | provisioning | activating | syncing | detaching | deleting
health: healthy | degraded | unknown
control: attached | lost | not_required
resource: present | absent | unknown
ownership: verified | unknown | conflict
```

Keep the last operation and stable error code beside these dimensions. Disk records use `schemaVersion: 1`; control responses use `schemaVersion: 2`. Migrate existing records because they already exist outside the repository.

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

`exe.dev` and `sbx` implement this seam for recovery; Cloudflare has only its current live provider path and no runtime driver. Sandcastle remains an implementation helper, not a second lifecycle architecture.

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

## Completion summary

| Phase | Status | Completion record |
|---|---|---|
| 0: safety holes | Complete, 2026-09-02 | Control-proxy lifetime, host-only mutation, ownership checks, cleanup, and bounded diagnostics were closed. |
| 1: decision-ready inspection | Complete, 2026-09-02 | `SandboxResultV2`, bounded five-source inspection, project inventory, capabilities, redaction, and response bounds were delivered. |
| 2: recovery loop | Complete for SBX and exe.dev, 2026-09-06 | Host-only repair/recover, durable ownership adoption, preservation-before-destruction, stale-plan rejection, and retry-safe orphan deletion were delivered. Cloudflare recovery remains unsupported. |
| 3: persisted state dimensions | Complete for the state-model criteria | Schema-1 disk migration, canonical intent/phase, legal observation matrix, deterministic compatibility projection, and typed action/error coverage are tested. Provider-seam cleanup remains deferred. |
| 4: make learning accretive | Evidence criteria complete, 2026-09-08 | State records carry a bounded request journal; `diagnose` returns a fixed, redacted bundle with version provenance, identities, state, workspace/provider/process observations, and explicit limits; one focused scenario fixture covers the documented incident mappings. |

The current contract and operating limits live in [`docs/opencode-sandbox.md`](../docs/opencode-sandbox.md) and [`docs/opencode-sandbox-operations.md`](../docs/opencode-sandbox-operations.md). `recover` and `repair` are exposed by `sandboxctl`; recovery and verified-orphan deletion are actionable only when a configured runtime driver and fresh evidence prove their preconditions.

## Phase 3 state-model record

The state-model completion criteria are met:

- Every old `SandboxState` value has deterministic schema-1 intent/phase migration, including operation-derived failure intent and compatibility projection.
- `phase3.test.ts` covers every desired location, control observation, resource value, ownership value, and classification, with legal action fields and safe recommendations.
- Normal `SandboxResultV2` responses carry typed `allowedActions` and `recommendedAction`; prose is not the only copy of a safe next action.

Persist intent and phase. Derive control, resource, ownership, health, classification, and effective target from fresh observations rather than treating them as durable truth. Disk uses schema 1; responses use schema 2.

The deterministic migration mapping is:

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

Legal phase pairs and situation classifications are executable contracts in `state-migration.test.ts` and `phase3.test.ts`; the architecture document owns their operating meaning.

## Deferred seams and providers

- The compatibility labels `recovery_pending` and `orphaned` remain response projections until every provider recovery path is supported. They are not durable facts.
- `LifecycleController` still accepts legacy provider release/destroy and infrastructure operations for injected compatibility paths. One runtime-driver seam is not yet the removal gate; do not claim this migration complete.
- Cloudflare can inspect a known sandbox after restart, but ownership remains unknown without durable owner metadata; recovery, adoption, and destructive control remain unsupported. Add a bridge lookup with durable owner metadata and a runtime driver before changing that status.

### Phase 4: make learning accretive

Status: Evidence criteria complete, 2026-09-08. The journal, diagnostic bundle, and shared incident scenario fixture are covered by focused regression tests; provider-seam cleanup and Cloudflare recovery remain deferred.

Changes:

- Record a bounded operation journal in each state record: request ID, operation, start/end time, result code, and evidence references. Keep only the latest entries.
- Add a redacted diagnostic bundle command that captures versions, identities, state, workspace association, provider observation, and process ownership.
- Add one lifecycle-interface scenario fixture for every incident class and documented failure mapping. Prefer one end-to-end fixture over provider-specific copies when the lifecycle behavior is shared.
- Generate command reference tables from the operation and state constants if documentation drift recurs. Do not add generation preemptively.

Completion criteria:

- A failed operation can be reconstructed without scanning global logs.
- Diagnostic output is bounded, redacted, and deterministic enough for a regression fixture.
- Every production incident maps to an existing scenario class or adds exactly one new class.

The focused `phase4.test.ts` fixture is the executable record for these criteria. It covers all nine classes, checks typed action preconditions, reconstructs retained journal entries through `diagnose`, and maps each documented condition without adding a tenth class.

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
- This file owns remaining work and concise completion records.
- Tests own detailed behavioral examples.
- Historical research keeps its original conclusions with a superseded notice.

When implementation changes current behavior, update the architecture and runbook in the same commit. Remove completed plan sections rather than leaving them as sediment.
