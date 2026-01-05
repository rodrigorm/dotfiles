---
id: df-s9s.6
status: closed
deps: [df-s9s.5]
links: []
created: 2025-12-11T17:40:04.2905-03:00
type: task
priority: 2
---
# Remove Comtrya artifacts and home/ directory

Remove Comtrya artifacts after migration is verified working.

## Prerequisites
- [ ] Task .5 must pass completely
- [ ] Run `make test` and verify all tools work in container
- [ ] All 11 verification checks from task .5 pass

**DO NOT START THIS TASK** until testing is complete and passing.

## Files and Directories to Delete

### 1. Comtrya.yaml
Main Comtrya configuration file at repository root.

### 2. dev/ directory (entire tree)
All Comtrya manifests:
```
dev/
├── aptitude/main.yaml
├── bash/main.yaml
├── dotfiles/main.yaml
├── git/main.yaml
├── homeshick/main.yml
├── lazygit/main.yaml
├── neovim/main.yaml
├── nodejs/main.yaml
├── nvim/main.yaml
├── nvm/main.yaml
├── pyenv/main.yml
├── screen/main.yaml
├── ssh/main.yaml
├── starship/main.yml
├── vim/main.yaml
└── vimrc/main.yaml
```

### 3. home/ directory (entire tree)
Original dotfiles location (now migrated):
```
home/
├── .bash_profile
├── .bashrc
├── .bashrc.d/
├── .config/
├── .ctags
├── .editorconfig
├── .gitconfig
├── .grcat
├── .hyper.js
├── .i3/
├── .i3status.conf
├── .my.cnf
├── .profile
├── .screenrc
└── bin/
```

## Cleanup Commands

```bash
# Delete Comtrya config
rm Comtrya.yaml

# Delete all Comtrya manifests
rm -rf dev/

# Delete original home directory (contents now at root with chezmoi naming)
rm -rf home/

# Verify deletion
ls -la
# Should NOT see: Comtrya.yaml, dev/, home/
# SHOULD see: dot_bashrc, dot_bashrc.d/, bin/, etc.
```

## Post-Cleanup Updates

### Update .chezmoiignore
Remove the legacy entries that are no longer needed:

```diff
- # Legacy Comtrya files (until cleanup in task .6)
- Comtrya.yaml
- dev
- dev/**
```

The .chezmoiignore should now only contain:
```
# Build/test files
Makefile
Dockerfile

# Documentation
README.md
AGENTS.md
LICENSE

# Git/lint config
.gitattributes
.shellcheckrc

# Development directories
.devcontainer
.devcontainer/**
.beads
.beads/**
history
history/**

# Other non-dotfiles
Solarized Dark.terminal
bootstrap.sh
```

### Update .shellcheckrc (if needed)
Current config references `home` as source-path:
```
external-sources=true
source-path=home
```

Update to:
```
external-sources=true
source-path=SCRIPTDIR
```

Or remove the source-path line if not needed.

## Post-Cleanup Verification

```bash
# 1. Ensure tests still pass
make test

# 2. Check shellcheck still works
make shellcheck

# 3. Verify git status shows only deletions (no unexpected changes)
git status

# 4. Verify chezmoi source state is clean
chezmoi verify
```

## Git Commit Message
```
chore: remove legacy Comtrya files after chezmoi migration

- Delete Comtrya.yaml configuration
- Delete dev/ directory with all Comtrya manifests
- Delete home/ directory (migrated to chezmoi naming)
- Update .chezmoiignore to remove legacy exclusions
- Update .shellcheckrc source-path

Part of chezmoi migration (dotfiles-s9s)
```

## Acceptance Criteria
- [ ] Comtrya.yaml deleted
- [ ] dev/ directory deleted
- [ ] home/ directory deleted
- [ ] .chezmoiignore updated (legacy entries removed)
- [ ] .shellcheckrc updated
- [ ] `make test` still passes after cleanup
- [ ] `make shellcheck` still passes
- [ ] Git shows only expected deletions


