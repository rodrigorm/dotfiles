---
id: dot-vjlx
status: closed
deps: []
links: []
created: 2026-08-13T14:56:31Z
type: feature
priority: 1
assignee: Rodrigo Moyle
parent: dot-fhny
---
# Make oc background and force-restartable

Remove the DIRECTORY argument, start OpenCode from HOME in a detached background process, replace Node JSON parsing with jq, keep normal execution idempotent, add safe --force restart, and install dependencies in bootstrap.sh.

## Acceptance Criteria

oc exits after convergence; starts in HOME; jq replaces Node; normal reruns do not restart or rewrite; --force recreates only healthy OpenCode and compatible Serve route; bootstrap installs jq, lsof, and Tailscale; tests and quality gates pass.


## Notes

**2026-08-13T15:08:20Z**

Implemented home/bin/oc as a detached, HOME-rooted, jq-based convergent wrapper. Normal runs reuse healthy OpenCode and an exact compatible Tailscale Serve route without mutation; --force recreates only that healthy listener and exact route while refusing conflicts. Added jq/lsof/Tailscale bootstrap dependencies and mock-backed regression coverage. Validation: bash -n passed; ShellCheck passed; dedicated tests passed; make shellcheck passed; make test passed 22/22; git diff --check passed. ap-host and ax unchanged.
