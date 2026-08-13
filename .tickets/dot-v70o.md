---
id: dot-v70o
status: closed
deps: []
links: []
created: 2026-08-13T16:01:50Z
type: bug
priority: 1
assignee: Rodrigo Moyle
parent: dot-fhny
---
# Avoid Tailscale CLI AppleEvent timeout on macOS


## Notes

**2026-08-13T16:03:36Z**

Root cause: bootstrap delegated launcher creation to Tailscale's bundled AppleScript, which timed out waiting for an AppleEvent (-1712). Replaced it with direct creation of the same two-line launcher and privileged install into /usr/local/bin; no app opening or authentication added. The red repro detecting the AppleScript dependency now passes. Validation: bash -n passed, make shellcheck passed, oc tests passed, git diff --check passed. The full Docker suite had passed 22/22 immediately before this macOS-only launcher change; Docker does not exercise the Darwin branch.

**2026-08-13T16:07:21Z**

Follow-up simplification per user: removed the temporary home/bin wrapper approach and removed sudo entirely from macOS launcher installation. bootstrap now installs the launcher at /opt/homebrew/bin/tailscale, refuses to overwrite a conflicting CLI, and uses no AppleScript. Installed and verified the launcher at /opt/homebrew/bin/tailscale on the current machine; no home/bin/tailscale exists. CLI association executes successfully but reports BackendState NeedsLogin, matching scutil's currently disconnected VPN state, so authentication remains the intended manual step.

**2026-08-13T16:09:48Z**

Corrected the contract after user clarification: bootstrap only installs Tailscale on Linux and macOS. Removed automatic tailscaled service startup, all Tailscale-related sudo usage, and the Docker skip-service flag. Starting, connecting, and authenticating Tailscale are fully manual on both platforms. Validation: bash -n, make shellcheck, oc tests, git diff --check, and forbidden-command scan all passed.

**2026-08-13T16:21:31Z**

Final root cause: two macOS Tailscale apps were installed. /Applications/Tailscale.app (Standalone 1.94.1) reported NeedsLogin, while /Applications/Tailscale.localized/Tailscale.app (App Store 1.98.9) owned the active tunnel and reported Running. Updated bootstrap to inspect both known app locations and point the Homebrew-prefix launcher at the Running backend; it refuses ambiguous multiple-disconnected installs and unrelated CLI conflicts. Updated the live /opt/homebrew/bin/tailscale launcher; original repro is green with BackendState Running, MagicDNS macmini.tailb55486.ts.net, and no health errors. No apps/profiles were removed. Validations passed: bash -n, make shellcheck, oc tests, diff check.

**2026-08-13T16:24:10Z**

Corrected design after user rejection of runtime selection: bootstrap no longer invokes status, reads BackendState, or chooses the running installation. macOS behavior is now structural only: install when none exists; configure launcher when exactly one exists; fail when both Standalone and App Store variants exist and print explicit removal choices. No removal is automatic. Validated with bash -n, make shellcheck, oc tests, diff check, and scan proving no runtime-state selection remains.

**2026-08-13T18:00:48Z**

Final scope correction: bootstrap now has zero macOS Tailscale logic. It only runs brew install tailscale on Linux; macOS installation and CLI integration are treated as host-managed. Removed dual-install detection, removal recommendations, app selection, launcher creation, MAS, runtime checks, and macOS policy. oc consumes the tailscale command already on PATH and gives a direct CLI-integration error when absent. Current host validation: /opt/homebrew/bin/tailscale reports Running, macmini.tailb55486.ts.net, IP 100.115.158.97, no health errors. bash -n, make shellcheck, oc tests, and diff check passed.
