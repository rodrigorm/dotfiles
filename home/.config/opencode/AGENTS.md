# Global Agent Instructions

## Communication

- Concise, direct responses
- No emojis unless asked
- Minimal explanations - trust me to read diffs
- Be autonomous - make reasonable decisions, report after

## Environment

| Tool            | Value                    |
| --------------- | ------------------------ |
| Shell           | bash                     |
| Editor          | nvim                     |
| Package Manager | Homebrew                 |

## Workflow

### Always Do
- Run tests/linting before claiming done
- Use skills proactively when available
- Write meaningful commit messages
- File issues for discovered scope creep (don't just do it)

### Ask First
- Adding new dependencies
- Major architectural changes or refactors

## Agent Delegation

Delegate work based on intent:

| Task Type | Delegate To | Notes |
| --- | --- | --- |
| Planning and deep analysis | `@plan` | Prefer for research-heavy or ambiguous work |
| External docs or API research | `@plan` | Keep research consolidated |
| Codebase recon (find where X lives) | `@explore` | Fast, read-only |
| Implementation | `@general` | Keep tasks scoped and concrete |
| Quick lookups | (do it) | Main agent can use research tools |

Rules:

- Treat `@general` as an implementer; it should not delegate.
- If a subagent needs work outside its scope, it should return to the main thread.
- Avoid delegation chains; keep handoffs explicit.

## Verification Checklist

Before claiming done on any task:

1. **Run diagnostics**: `lsp_diagnostics` or equivalent linter
2. **Run tests**: Any available test suite for the changed code
3. **Review diff**: Read your own changes before claiming success
4. **Check for generated files**: Don't commit lockfiles, build artifacts, or generated code unless intended
5. **Verify cleanup**: No stray debug output, temporary files, or uncommitted changes

## Git Workflow

### Commits
- Write meaningful commit messages (focus on why, not just what)
- Commit related changes together
- Don't commit generated files, build artifacts, or lockfiles unless intended
- Always commit project AGENTS.md alongside code changes that affect agent behavior

### Branching
- Never force push to main/master
- Never rebase shared/remote branches
- Prefer feature branches for new work
- Clean up local branches after merge

### Pushing
- Push before session end to avoid stranded work
- Pull with rebase: `git pull --rebase` before push
- Verify push succeeded before claiming done

## Code Style

- [Shell Scripts](guidelines/shell.md)
- [TypeScript](guidelines/typescript.md)

## Meta

- Project AGENTS.md files override global settings
- Skills available in `~/.config/opencode/skills/`
- Use TDD when implementing features
