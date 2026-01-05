---
id: df-s9s.2
status: closed
deps: []
links: []
created: 2025-12-11T17:39:58.149573-03:00
type: task
priority: 1
---
# Migrate dotfiles from home/ to chezmoi naming

Migrate all dotfiles from home/ directory to chezmoi naming conventions at repository root.

## Chezmoi Naming Conventions
- `dot_` prefix → becomes `.` (e.g., `dot_bashrc` → `.bashrc`)
- `executable_` prefix → sets executable bit on target file
- `private_` prefix → sets 0600/0700 permissions (files/dirs)
- `readonly_` prefix → removes write permissions
- **Order matters:** `private_dot_` not `dot_private_`
- Directories do NOT use `executable_` prefix

## Complete File Migration Map

### Root Dotfiles (home/*.* → repo root)
| Source | Target | Notes |
|--------|--------|-------|
| home/.bashrc | dot_bashrc | |
| home/.bash_profile | dot_bash_profile | |
| home/.profile | dot_profile | |
| home/.gitconfig | dot_gitconfig | |
| home/.screenrc | dot_screenrc | |
| home/.ctags | dot_ctags | |
| home/.editorconfig | dot_editorconfig | |
| home/.grcat | dot_grcat | |
| home/.hyper.js | dot_hyper.js | |
| home/.my.cnf | dot_my.cnf | |
| home/.i3status.conf | dot_i3status.conf | **Often missed!** |

### Directories (preserve internal structure)
| Source | Target | Notes |
|--------|--------|-------|
| home/.bashrc.d/ | dot_bashrc.d/ | Directory, no executable_ |
| home/.bashrc.d/.init.sh | dot_bashrc.d/dot_init.sh | Hidden file inside |
| home/.bashrc.d/*.sh | dot_bashrc.d/*.sh | Keep same names (not hidden) |
| home/.config/ | dot_config/ | |
| home/.config/starship.toml | dot_config/starship.toml | Not private |
| home/.i3/ | dot_i3/ | |
| home/.i3/config | dot_i3/config | |
| home/bin/ | bin/ | No dot_ (not hidden) |
| home/bin/lib/ | bin/lib/ | Subdirectory |

### Executable Scripts in bin/
| Source | Target | Notes |
|--------|--------|-------|
| home/bin/sc | bin/executable_sc | Has shebang, is run directly |
| home/bin/caps_lock_off | bin/executable_caps_lock_off | Has shebang, is run directly |
| home/bin/screen-git-branch | bin/executable_screen-git-branch | Has shebang, is run directly |
| home/bin/lib/bash3boilerplate.sh | bin/lib/bash3boilerplate.sh | **NO executable_** - sourced, not run |

## Content Changes Required

### DELETE: dot_bashrc.d/10-homeshick.sh
This file must be completely removed - homeshick is replaced by chezmoi.
Do NOT migrate this file.

### MODIFY: dot_bashrc.d/10-path.sh
Add `~/.local/bin` to PATH for user-installed binaries (lazygit, chezmoi, etc.).

Current file ends at line 29. Add this near the top (after the shebang and before other PATH additions):

```bash
# User local bin (for chezmoi, lazygit, etc.)
[ -d "$HOME/.local/bin" ] && PATH="$HOME/.local/bin:$PATH"
```

Insert after line 4 (the ~/bin check) to keep similar patterns together.

### VERIFY: dot_bashrc.d/.init.sh reference
The file `home/.bashrc.d/.init.sh` is referenced by `home/.bashrc`. After migration:
- Source: dot_bashrc.d/dot_init.sh
- Target: ~/.bashrc.d/.init.sh (the dot_ becomes .)

Verify that `dot_bashrc` sources `~/.bashrc.d/.init.sh` (it should already be correct).

## Migration Commands
```bash
# Create directories first
mkdir -p dot_bashrc.d dot_config dot_i3 bin/lib

# Move root dotfiles
mv home/.bashrc dot_bashrc
mv home/.bash_profile dot_bash_profile
mv home/.profile dot_profile
mv home/.gitconfig dot_gitconfig
mv home/.screenrc dot_screenrc
mv home/.ctags dot_ctags
mv home/.editorconfig dot_editorconfig
mv home/.grcat dot_grcat
mv home/.hyper.js dot_hyper.js
mv home/.my.cnf dot_my.cnf
mv home/.i3status.conf dot_i3status.conf

# Move .bashrc.d contents (rename hidden .init.sh)
mv home/.bashrc.d/.init.sh dot_bashrc.d/dot_init.sh
mv home/.bashrc.d/00-reset.sh dot_bashrc.d/
mv home/.bashrc.d/10-aliases.sh dot_bashrc.d/
mv home/.bashrc.d/10-homebrew.sh dot_bashrc.d/
mv home/.bashrc.d/10-nvm.sh dot_bashrc.d/
mv home/.bashrc.d/10-path.sh dot_bashrc.d/
mv home/.bashrc.d/10-ssh.sh dot_bashrc.d/
mv home/.bashrc.d/21-starship.sh dot_bashrc.d/
mv home/.bashrc.d/30-pyenv.sh dot_bashrc.d/
# NOTE: Skip 10-homeshick.sh - delete it instead
rm home/.bashrc.d/10-homeshick.sh

# Move .config
mv home/.config/starship.toml dot_config/

# Move .i3
mv home/.i3/config dot_i3/

# Move bin (with executable_ prefix for scripts)
mv home/bin/sc bin/executable_sc
mv home/bin/caps_lock_off bin/executable_caps_lock_off
mv home/bin/screen-git-branch bin/executable_screen-git-branch
mv home/bin/lib/bash3boilerplate.sh bin/lib/
```

## Acceptance Criteria
- [ ] All 11 root dotfiles migrated with dot_ prefix
- [ ] dot_bashrc.d/ contains 9 files (10 original minus homeshick)
- [ ] dot_bashrc.d/dot_init.sh exists (was .init.sh)
- [ ] 10-homeshick.sh is NOT present
- [ ] 10-path.sh includes ~/.local/bin in PATH
- [ ] bin/ contains 3 executable_ prefixed scripts
- [ ] bin/lib/bash3boilerplate.sh exists WITHOUT executable_ prefix
- [ ] dot_config/starship.toml exists
- [ ] dot_i3/config exists
- [ ] dot_i3status.conf exists


