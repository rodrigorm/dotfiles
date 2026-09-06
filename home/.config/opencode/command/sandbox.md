---
description: Move the current OpenCode session to or from its sandbox runtime.
agent: build
---

Execute the requested sandbox lifecycle operation.

Supported operations are exactly: `start`, `stop`, `status`, `inspect`, `inventory`, `delete`, `logs`, `diagnose`, `retry`, host-only `recover`, and host-only `repair`. The only optional argument is `--force` for `delete`. `inventory` is host-only and project-scoped.

`adopt` is provider vocabulary, not a public command. Run `recover` or delete a verified orphan only when a host result advertises the runtime-driver action with fresh provider, ownership, and runtime-handle preconditions. Run `repair` only when a host result advertises it with fresh provider, runtime-handle, and workspace preconditions.

Run `retry` using the role listed in `allowedActions`. A remote capability must not retry a failed `start` or a forced delete; report that host recovery is required instead.

Run `sandboxctl $ARGUMENTS` exactly once. Treat its single JSON document on stdout as authoritative. Present `schemaVersion`, `requestId`, `ok`, `operation`, `message`, `session`, `intent`, `effectiveTarget`, `observations`, `classification`, `work`, `allowedActions`, `recommendedAction`, and `error`, plus legacy `state`, `stage`, and non-secret `details` when present. Preserve every `observations` entry, including `observed: false`; do not infer provider health, resource existence, ownership, target, or completed cleanup from persisted state or prose. Do not automatically execute a recommended action; report its role, preconditions, and wait behavior.

Never infer or execute provider infrastructure commands (`sbx`, exe.dev/SSH, Cloudflare, or other provider tools), access a control socket directly, construct infrastructure commands, or retry an operation yourself. If the JSON contains `diagnosticOperation: "diagnose"`, run only `sandboxctl diagnose` exactly once and present that result.
