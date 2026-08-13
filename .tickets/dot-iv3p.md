---
id: dot-iv3p
status: closed
deps: []
links: []
created: 2026-08-13T00:19:05Z
type: task
priority: 1
assignee: Rodrigo Moyle
parent: dot-fhny
---
# Verify OpenCode TUI multi-workdir behavior

Confirm whether opencode attach TUI can select arbitrary remote workdirs like the Web UI before simplifying home/bin/oc.

## Acceptance Criteria

Primary-source conclusion distinguishes Web, local TUI, attached TUI, project directories/worktrees, and --dir.


## Notes

**2026-08-13T00:25:06Z**

Verified OpenCode v1.18.17 at SHA 02546dfc. One serve process is multi-directory, but each TUI is scoped to one startup directory/project. Web has a multi-project picker; TUI /sessions and /move remain within the current project. Remote selection uses opencode attach URL --dir /absolute/path/on/host. Research saved in history/opencode-tui-multi-workdir-v1.18.17.md. No scripts changed.
