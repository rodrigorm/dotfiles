# tk Workflow

## Why tk?

This project uses **tk (ticket)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

- **Git-native:** Tickets are markdown files in `.tickets/`, version controlled with git
- **Dependency-aware:** Track blockers and relationships between issues
- **Agent-optimized:** Easily searchable markdown files, partial ID matching
- **Zero setup:** Single bash script, no database or background daemon

## Quick Start

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

## Ticket Types

| Type     | Description                              |
|----------|------------------------------------------|
| `bug`    | Something broken                         |
| `feature`| New functionality                        |
| `task`   | Work item (tests, docs, refactoring)     |
| `epic`   | Large feature with subtasks              |
| `chore`  | Maintenance (dependencies, tooling)      |

## Priorities

| Priority | Meaning                              |
|----------|--------------------------------------|
| `0`      | Critical (security, data loss, broken builds) |
| `1`      | High (major features, important bugs) |
| `2`      | Medium (default, nice-to-have)        |
| `3`      | Low (polish, optimization)            |
| `4`      | Backlog (future ideas)                |

## Agent Workflow

1. **Check ready work:** `tk ready` shows unblocked issues
2. **Claim your task:** `tk start <id>`
3. **Work on it:** Implement, test, document
4. **Discover new work?** Create linked ticket:
   ```bash
   tk create "Found bug" -p 1 --parent <parent-id>
   ```
5. **Complete:** `tk close <id>`
6. **Commit together:** Always commit `.tickets/` with code changes

## Managing AI-Generated Planning Documents

AI assistants often create planning docs (PLAN.md, IMPLEMENTATION.md, etc.).

**Best Practice:** Store in `history/` directory:
- Create `history/` in project root for ALL AI-generated planning docs
- Keep repository root clean and focused on permanent files
- Only access `history/` when explicitly asked to review past planning

## Important Rules

- ✅ Use tk for ALL task tracking
- ✅ Link discovered work with `--parent` dependencies
- ✅ Check `tk ready` before asking "what should I work on?"
- ✅ Store AI planning docs in `history/` directory
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems
- ❌ Do NOT clutter repo root with planning documents

## Learn More

- Run `tk help` for command reference
- Run `tk <command> --help` for command-specific help
