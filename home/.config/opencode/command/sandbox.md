---
description: Move the current OpenCode session to or from its sandbox runtime.
agent: build
---

Execute the requested sandbox lifecycle operation.

Supported operations are exactly: `start`, `stop`, `status`, `delete`, `logs`, `diagnose`, and `retry`. The only optional argument is `--force` for `delete`.

Run `sandboxctl $ARGUMENTS` exactly once. Treat its single JSON document on stdout as authoritative and present its `message` without changing `operation`, `state`, or `stage`.

Never run provider infrastructure commands, access a control socket directly, construct infrastructure commands, or retry an operation yourself. If the JSON contains `diagnosticOperation: "diagnose"`, run `sandboxctl diagnose` exactly once and present that result.
