---
id: df-s9s.4
status: closed
deps: [df-s9s.2, df-s9s.3]
links: []
created: 2025-12-11T17:40:00.829194-03:00
type: task
priority: 1
---
# Update bootstrap.sh for chezmoi

Update bootstrap.sh to use chezmoi instead of Comtrya.

## Purpose
bootstrap.sh is the entry point for:
- VS Code devcontainers
- Devpod
- Manual bootstrap on new machines

## New bootstrap.sh Content

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Dotfiles Bootstrap ==="

# Ensure ~/.local/bin exists and is in PATH (for chezmoi)
mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"

# Install chezmoi if not present
if ! command -v chezmoi &> /dev/null; then
    echo "Installing chezmoi..."
    sh -c "$(curl -fsLS get.chezmoi.io)" -- -b "$HOME/.local/bin"
fi

# Determine if running from local clone or needs remote init
if [[ -f "$SCRIPT_DIR/.chezmoiignore" ]]; then
    # Local clone (devcontainer/devpod scenario)
    echo "Using local dotfiles from: $SCRIPT_DIR"
    chezmoi init --source "$SCRIPT_DIR" --apply --verbose
else
    # Remote scenario - clone from GitHub
    echo "Cloning dotfiles from GitHub..."
    chezmoi init --apply rodrigorm --verbose
fi

echo "=== Bootstrap complete ==="
```

## Key Differences from Current bootstrap.sh

| Current | New |
|---------|-----|
| `curl get.comtrya.dev \| sudo bash` | `sh -c "$(curl get.chezmoi.io)" -- -b ~/.local/bin` |
| `comtrya apply` | `chezmoi init --source $DIR --apply` |
| Requires sudo for install | No sudo needed |
| No local/remote detection | Detects local clone vs remote |

## Usage Scenarios

### 1. Devcontainer / Devpod
The dotfiles repo is cloned/mounted into the container. bootstrap.sh detects the local `.chezmoiignore` file and uses `--source` to point chezmoi at the existing directory.

```bash
# Inside container where dotfiles are at /workspace/dotfiles
cd /workspace/dotfiles
./bootstrap.sh
```

### 2. Fresh Machine (Remote)
Preferred one-liner (doesn't need bootstrap.sh):
```bash
sh -c "$(curl -fsLS get.chezmoi.io)" -- init --apply rodrigorm
```

If bootstrap.sh is run without the repo:
```bash
curl -O https://raw.githubusercontent.com/rodrigorm/dotfiles/main/bootstrap.sh
chmod +x bootstrap.sh
./bootstrap.sh  # Will clone from GitHub
```

### 3. Existing chezmoi User
```bash
chezmoi update  # Pull and apply changes
```

## Technical Notes

1. **No sudo required**: chezmoi installs to `~/.local/bin` by default
2. **PATH setup**: Script ensures `~/.local/bin` is in PATH before running chezmoi
3. **Detection method**: Checks for `.chezmoiignore` to detect if in source directory
4. **Verbose output**: Using `--verbose` for visibility during bootstrap
5. **Idempotent**: Safe to run multiple times

## Acceptance Criteria
- [ ] bootstrap.sh updated with new content
- [ ] Script passes shellcheck
- [ ] Works in Docker test environment (`make test`)
- [ ] Correctly detects local vs remote scenario
- [ ] No sudo required for chezmoi installation


