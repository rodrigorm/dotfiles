---
description: Move the current OpenCode session to or from its sandbox runtime.
agent: build
---

Execute the requested sandbox lifecycle operation.

Supported operations are exactly: `start`, `stop`, `status`, `delete`, `logs`, `diagnose`, and `retry`. The only optional argument is `--force` for `delete`.

Run `retry` from the host. A remote capability must not retry a failed `start`; report that host recovery is required instead.

Run `sandboxctl $ARGUMENTS` exactly once. Treat its single JSON document on stdout as authoritative. Present `message`, `operation`, `state`, `stage`, and non-secret `details` when present. Mark omitted facts as unknown; do not infer provider health, resource existence, ownership, or completed cleanup from the persisted state alone.

Never run provider infrastructure commands, access a control socket directly, construct infrastructure commands, or retry an operation yourself. If the JSON contains `diagnosticOperation: "diagnose"`, run `sandboxctl diagnose` exactly once and present that result.
