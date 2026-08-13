---
id: dot-3vcg
status: closed
deps: []
links: []
created: 2026-08-13T15:33:34Z
type: bug
priority: 1
assignee: Rodrigo Moyle
parent: dot-fhny
---
# Associate Tailscale CLI with the platform client


## Notes

**2026-08-13T15:53:05Z**

Implemented the minimal platform association flow. bootstrap.sh now installs the Homebrew Tailscale formula and starts its matching tailscaled service on Linux (without login), or installs tailscale-app and its official /usr/local/bin launcher on macOS (without opening/authenticating the app). oc no longer falls back to the macOS bundle executable, forces CLI mode for every call, and tells the user to run bootstrap when association is missing. Removed the over-engineered helper/test file after review. Validation: real macOS repro now returns the actionable bootstrap message; oc regression suite passed; make shellcheck passed; make test passed 22/22; git diff --check passed.
