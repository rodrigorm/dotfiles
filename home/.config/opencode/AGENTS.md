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

### Never
- Force push to main/master
- Rebase shared/remote branches
- Commit secrets, credentials, or .env files
- Skip verification before claiming success

## Code Style

- [Shell Scripts](guidelines/shell.md)
- [TypeScript](guidelines/typescript.md)

## Meta

- Project AGENTS.md files override global settings
- Skills available in `~/.config/opencode/skills/`
- Use TDD when implementing features
