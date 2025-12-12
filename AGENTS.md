# Instructions for AI Agents

> For detailed bd (beads) documentation, run `bd onboard` or `bd prime`.

## Project Overview

This is a **personal dotfiles repository** for Unix configuration files, using:

- **Comtrya** - Declarative provisioning tool for installing/configuring tools
- **Homeshick** - Dotfile management via git + symlinks
- **Homebrew** - Package management (macOS/Linux)

**Directory Structure:**

| Directory | Purpose |
|-----------|---------|
| `home/` | Dotfiles (symlinked to `$HOME` via Homeshick) |
| `home/.bashrc.d/` | Modular bash config (numbered scripts: `00-reset.sh`, `10-*.sh`, etc.) |
| `home/.config/` | XDG config files (starship, etc.) |
| `home/bin/` | Custom scripts and utilities |
| `dev/` | Comtrya manifests (`dev/{tool}/main.yaml`) |

**Installation:** See `README.md` for setup instructions.

## Development Guidelines

**Build/Lint/Test Commands:**
```bash
make test       # Test entire dotfiles setup in Docker
make shellcheck # Lint all shell scripts
make image      # Build Docker image for testing
make benchmark  # Benchmark bashrc loading performance
make prune      # Clean up Docker resources
```

**Shell/Bash Scripts:**
- Use bash3boilerplate template (see `home/bin/lib/bash3boilerplate.sh`)
- Enable strict error handling: `set -euo pipefail`
- Follow modular approach with numbered scripts in `.bashrc.d/`
- Use 4-space indentation
- Cross-platform detection required (see `.bashrc.d/.init.sh`)

**YAML Configuration (Comtrya manifests):**
- Use `main.yaml` for tool manifests in `dev/` directories
- Follow existing naming conventions for package managers
- Include cross-platform package installation logic

**Testing:**
- All changes must pass `make test` (Docker validation)
- All shell scripts must pass `make shellcheck`
- Test in Ubuntu 24.04 container environment

**Error Handling:**
- Use proper exit codes in shell scripts
- Validate dependencies before installation
- Handle missing packages gracefully across platforms

## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

**Why bd?**
- Dependency-aware: Track blockers and relationships between issues
- Git-friendly: Auto-syncs to JSONL for version control
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

**Quick Start:**

```bash
# Check for ready work
bd ready --json

# Create new issues
bd create "Issue title" -t bug|feature|task -p 0-4 --json
bd create "Issue title" -p 1 --deps discovered-from:df-123 --json

# Claim and update
bd update df-42 --status in_progress --json

# Complete work
bd close df-42 --reason "Completed" --json
```

**Issue Types:**
- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

**Priorities:**
- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

**Workflow for AI Agents:**
1. **Check ready work**: `bd ready` shows unblocked issues
2. **Claim your task**: `bd update <id> --status in_progress`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `bd create "Found bug" -p 1 --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Done"`
6. **Commit together**: Always commit `.beads/issues.jsonl` with code changes

**Learn More:**
- Run `bd onboard` for comprehensive setup and workflow documentation
- Run `bd prime` for a compact workflow reference
- Run `bd <command> --help` for command-specific help

**Managing AI-Generated Planning Documents:**

AI assistants often create planning docs (PLAN.md, IMPLEMENTATION.md, etc.).

**Best Practice:** Store in `history/` directory:
- Create `history/` in project root for ALL AI-generated planning docs
- Keep repository root clean and focused on permanent files
- Only access `history/` when explicitly asked to review past planning

**Important Rules:**
- ✅ Use bd for ALL task tracking
- ✅ Always use `--json` flag for programmatic use
- ✅ Link discovered work with `discovered-from` dependencies
- ✅ Check `bd ready` before asking "what should I work on?"
- ✅ Store AI planning docs in `history/` directory
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems
- ❌ Do NOT clutter repo root with planning documents

## Landing the Plane

**When the user says "let's land the plane"**, you MUST complete ALL steps below. The plane is NOT landed until `git push` succeeds. NEVER stop before pushing. NEVER say "ready to push when you are!" - that is a FAILURE.

**MANDATORY WORKFLOW - COMPLETE ALL STEPS:**

1. **File beads issues for any remaining work** that needs follow-up

2. **Run quality gates** (only if code changes were made):
   ```bash
   make shellcheck
   make test
   ```
   File P0 issues if broken.

3. **Update beads issues** - close finished work, update status

4. **PUSH TO REMOTE - NON-NEGOTIABLE** - Execute ALL commands:
   ```bash
   git pull --rebase

   # If conflicts in .beads/issues.jsonl:
   #   git checkout --theirs .beads/issues.jsonl
   #   bd import -i .beads/issues.jsonl

   bd sync
   git push
   git status  # MUST show "up to date with origin/main"
   ```

5. **Clean up git state**:
   ```bash
   git stash clear
   git remote prune origin
   ```

6. **Verify clean state** - All changes committed AND pushed, no untracked files

7. **Choose a follow-up issue for next session** - Provide prompt:
   > "Continue work on df-X: [issue title]. [Brief context about what's been done and what's next]"

**CRITICAL RULES:**
- The plane has NOT landed until `git push` completes successfully
- NEVER stop before `git push` - that leaves work stranded locally
- NEVER say "ready to push when you are!" - YOU must push, not the user
- If `git push` fails, resolve the issue and retry until it succeeds
- Unpushed work breaks coordination workflow