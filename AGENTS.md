# Instructions for AI Agents

## Project Overview

Personal dotfiles repository using **Homeshick** (git + symlinks) and **Homebrew**.

| Directory       | Purpose                                          |
|-----------------|--------------------------------------------------|
| `home/`         | Dotfiles (symlinked to `$HOME`)                  |
| `home/.bashrc.d/` | Modular bash config (`00-reset.sh`, `10-*.sh`, etc.) |
| `home/.config/` | XDG config files (starship, etc.)                |
| `home/bin/`     | Custom scripts and utilities                     |

## Commands

| Command         | Purpose                       |
|-----------------|-------------------------------|
| `make test`       | Test dotfiles setup in Docker |
| `make shellcheck` | Lint all shell scripts        |
| `make image`      | Build Docker test image       |
| `make benchmark`  | Benchmark bashrc loading      |
| `make prune`      | Clean up Docker resources     |

## Guidelines

- [Shell Scripts](.agents/shell-scripts.md) - Bash conventions, testing, error handling
- [tk Workflow](.agents/tk-workflow.md) - Issue tracking with tk (REQUIRED)
- [Landing the Plane](.agents/landing-the-plane.md) - Session completion checklist

## Common Gotchas

### Symlinks and Homeshick
- Files in `home/` are symlinked to `$HOME` by Homeshick
- **Never** manually edit files in `$HOME` - edit in `home/` and let Homeshick sync
- Existing symlinks are overwritten without warning
- Test changes with `make test` before pushing

### Platform Differences
- Homebrew behaves differently on macOS vs Linux
- Some tools (GNU coreutils) are not available on macOS by default
- Use `home/.bashrc.d/.init.sh` to detect platform and handle differences

### Docker Testing
- Tests run in Ubuntu 24.04 container - verify Linux compatibility there
- Docker must be running for `make test` and `make image`
- Clean up with `make prune` to avoid disk usage growth

### Bashrc Loading
- Files in `home/.bashrc.d/` load in alphanumeric order
- `00-*.sh` loads first, then `10-*.sh`, etc.
- Avoid circular dependencies between bashrc scripts