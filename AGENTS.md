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