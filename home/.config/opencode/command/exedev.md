---
description: Move the current OpenCode session to or from its exe.dev runtime.
agent: build
---

Execute the requested exe.dev lifecycle operation.

Supported operations are exactly: `start`, `stop`, `status`, `delete`, `logs`, `diagnose`, and `retry`. Parse `$ARGUMENTS` as one operation with an optional `--force` only for `delete`.

Run `exedevctl <operation>` exactly once. For `delete --force`, run `exedevctl delete --force` exactly once. Treat its single JSON document on stdout as authoritative and present its `message` without changing `operation`, `state`, or `stage`.

Never run `ssh exe.dev`, access a control socket directly, construct infrastructure commands, or retry an operation yourself. If the JSON contains `diagnosticOperation: "diagnose"`, run `exedevctl diagnose` exactly once and present that result.
