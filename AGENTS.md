# Instructions for AI Agents

> Run `tk help` when you need to use the ticket system.

## Project Overview

This is a **personal dotfiles repository** for Unix configuration files, using:

- **Homeshick** - Dotfile management via git + symlinks
- **Homebrew** - Package management (macOS/Linux)

**Directory Structure:**

| Directory | Purpose |
|-----------|---------|
| `home/` | Dotfiles (symlinked to `$HOME` via Homeshick) |
| `home/.bashrc.d/` | Modular bash config (numbered scripts: `00-reset.sh`, `10-*.sh`, etc.) |
| `home/.config/` | XDG config files (starship, etc.) |
| `home/bin/` | Custom scripts and utilities |

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

**Testing:**
- All changes must pass `make test` (Docker validation)
- All shell scripts must pass `make shellcheck`
- Test in Ubuntu 24.04 container environment

**Error Handling:**
- Use proper exit codes in shell scripts
- Validate dependencies before installation
- Handle missing packages gracefully across platforms

## Issue Tracking with tk

**IMPORTANT**: This project uses **tk (ticket)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

**Why tk?**
- Git-native: Tickets are markdown files in `.tickets/`, version controlled with git
- Dependency-aware: Track blockers and relationships between issues
- Agent-optimized: Easily searchable markdown files, partial ID matching
- Zero setup: Single bash script, no database or background daemon

**Quick Start:**

```bash
# Check for ready work
tk ready

# Create new tickets
tk create "Issue title" -t bug|feature|task|epic|chore
tk create "Issue title" -p 1 --parent df-123

# Claim and update
tk start df-42
tk close df-42
```

**Ticket Types:**
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
1. **Check ready work**: `tk ready` shows unblocked issues
2. **Claim your task**: `tk start <id>`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked ticket:
   - `tk create "Found bug" -p 1 --parent <parent-id>`
5. **Complete**: `tk close <id>`
6. **Commit together**: Always commit `.tickets/` with code changes

**Learn More:**
- Run `tk help` for command reference
- Run `tk <command> --help` for command-specific help

**Managing AI-Generated Planning Documents:**

AI assistants often create planning docs (PLAN.md, IMPLEMENTATION.md, etc.).

**Best Practice:** Store in `history/` directory:
- Create `history/` in project root for ALL AI-generated planning docs
- Keep repository root clean and focused on permanent files
- Only access `history/` when explicitly asked to review past planning

**Important Rules:**
- ✅ Use tk for ALL task tracking
- ✅ Link discovered work with `--parent` dependencies
- ✅ Check `tk ready` before asking "what should I work on?"
- ✅ Store AI planning docs in `history/` directory
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems
- ❌ Do NOT clutter repo root with planning documents

## Landing the Plane

**When the user says "let's land the plane"**, you MUST complete ALL steps below. The plane is NOT landed until `git push` succeeds. NEVER stop before pushing. NEVER say "ready to push when you are!" - that is a FAILURE.

**MANDATORY WORKFLOW - COMPLETE ALL STEPS:**

1. **File tk issues for any remaining work** that needs follow-up

2. **Run quality gates** (only if code changes were made):
   ```bash
   make shellcheck
   make test
   ```
   File P0 issues if broken.

3. **Update tk issues** - close finished work, update status

4. **PUSH TO REMOTE - NON-NEGOTIABLE** - Execute ALL commands:
   ```bash
   git pull --rebase
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