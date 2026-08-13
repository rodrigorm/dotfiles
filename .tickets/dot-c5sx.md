---
id: dot-c5sx
status: closed
deps: []
links: []
created: 2026-08-12T23:17:30Z
type: feature
priority: 1
assignee: Rodrigo Moyle
parent: dot-fhny
---
# Add safe OpenCode Tailscale Serve wrapper

Add home/bin/oc without changing ap-host or ax. Reuse/start OpenCode on loopback port 4096, safely reuse or configure Tailscale Serve HTTPS 4096, and refuse conflicts.

## Acceptance Criteria

oc reuses a healthy local OpenCode; starts one when absent; exposes https://<MagicDNS>:4096 through Tailscale Serve; never overwrites conflicting Serve config; tests cover free, compatible, conflict, offline, and occupied-local-port cases.


## Notes

**2026-08-12T23:30:30Z**

Implemented home/bin/oc and tests/oc.sh. The wrapper binds OpenCode to 127.0.0.1:4096, inspects Tailscale Serve JSON before mutation, reuses only an exact compatible HTTPS :4096 route, leaves unrelated Serve ports alone, and refuses conflicts. Validation passed: bash -n, direct shellcheck, tests/oc.sh, make shellcheck, and make test (17/17 Docker tests).
