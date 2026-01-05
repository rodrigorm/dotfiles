---
id: df-s9s.5
status: closed
deps: [df-s9s.4]
links: []
created: 2025-12-11T17:40:02.95989-03:00
type: task
priority: 1
---
# Update Dockerfile and Makefile for chezmoi testing

Update Dockerfile and Makefile to test the chezmoi-based setup.

## Dockerfile Changes

### Current Issues with Existing Dockerfile
- Multi-stage Rust build is slow and unnecessary
- Comtrya is built from source (takes minutes)
- chezmoi is a single pre-built binary

### New Dockerfile

```dockerfile
FROM ubuntu:22.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Restore full Ubuntu (unminimize) and install base packages
RUN yes | unminimize 2>/dev/null || true && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        adduser \
        sudo \
        curl \
        ca-certificates \
        git && \
    rm -rf /var/lib/apt/lists/*

# Create ubuntu user with passwordless sudo
RUN useradd -m -s /bin/bash ubuntu && \
    echo "ubuntu ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Install chezmoi system-wide
RUN sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin

# Copy dotfiles repository
COPY --chown=ubuntu:ubuntu . /home/ubuntu/.dotfiles

USER ubuntu
WORKDIR /home/ubuntu
ENV SHELL=/bin/bash
ENV TERM=xterm-256color
SHELL ["/bin/bash", "-c"]
```

### Key Changes
1. **Single stage**: No more Rust builder (saves ~5 minutes)
2. **Pre-built chezmoi**: Downloaded binary, not compiled
3. **System-wide install**: `-b /usr/local/bin` so it's available to all users
4. **Passwordless sudo**: Required for installation scripts
5. **DEBIAN_FRONTEND**: Prevents apt interactive prompts
6. **Minimal packages**: Only what's needed to bootstrap; rest installed by chezmoi

## Makefile Changes

### Current Makefile
```make
test: image
	docker run --rm -it dotfiles:latest sh -c "cd ~/.dotfiles && comtrya -vvv apply && cd ~ && bash"
```

### New Makefile test target
```make
test: image
	docker run --rm -it dotfiles:latest sh -c "chezmoi init --source ~/.dotfiles --apply -v && exec bash -l"
```

### Updated shellcheck target (after task .6 cleanup)
```make
shellcheck:
	shellcheck $$(find dot_bashrc.d -type f -name "*.sh") \
	           $$(find .chezmoiscripts -type f -name "*.sh.tmpl" -o -name "*.sh") \
	           bootstrap.sh
```

**Note:** shellcheck can't parse .tmpl files directly. Either:
- Run shellcheck on the rendered output, or
- Use `# shellcheck shell=bash` directive and ignore template syntax

### Complete New Makefile
```make
.PHONY: image test prune benchmark shellcheck

image:
	docker build -t dotfiles:latest .

test: image
	docker run --rm -it dotfiles:latest sh -c "chezmoi init --source ~/.dotfiles --apply -v && exec bash -l"

prune:
	docker system prune -f

benchmark:
	__bashrc_bench=1 bash -i

shellcheck:
	shellcheck $$(find dot_bashrc.d -type f -name "*.sh") bootstrap.sh
```

## Manual Verification Steps

After `make test`, inside the container run these checks:

```bash
# 1. Dotfiles in place
ls -la ~/
# Should see: .bashrc, .bash_profile, .gitconfig, .screenrc, etc.

# 2. Directories created
ls -la ~/.bashrc.d/
ls -la ~/.config/
ls ~/bin/

# 3. Neovim config cloned (via external)
ls ~/.config/nvim/
# Should see nvim config files

# 4. Vim config cloned (via external)
ls ~/.vim/
ls -la ~/.vimrc  # Should be symlink to ~/.vim/vimrc

# 5. Neovim binary installed (Linux)
/opt/nvim/bin/nvim --version
# Should show v0.10.4

# 6. Lazygit installed
~/.local/bin/lazygit --version
# Or just: lazygit --version (if PATH is set)

# 7. Screen compiled
screen --version
# Should show 5.0.0

# 8. NVM and Node.js
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm --version
node --version
# Should show Node 20.x

# 9. Starship
starship --version

# 10. pyenv
~/.pyenv/bin/pyenv --version

# 11. Shell works
bash -l
# Should start without errors, show starship prompt
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "chezmoi: command not found" | Check /usr/local/bin/chezmoi exists |
| Scripts fail with permission denied | Check NOPASSWD sudo is configured |
| Neovim not found | Check /opt/nvim/bin is in PATH (10-path.sh) |
| NVM commands fail | Source nvm.sh first |
| Template errors | Run `chezmoi execute-template < file.tmpl` to debug |

## Acceptance Criteria
- [ ] Dockerfile updated and builds successfully
- [ ] `make image` completes in < 2 minutes (vs ~10 minutes with Rust build)
- [ ] `make test` runs all chezmoi scripts without errors
- [ ] All 11 verification checks pass inside container
- [ ] Makefile shellcheck target works (after task .2 migration)


