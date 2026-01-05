---
id: df-s9s.7
status: closed
deps: [df-s9s.5]
links: []
created: 2025-12-11T17:40:06.187533-03:00
type: task
priority: 2
---
# Update README.md with chezmoi instructions

Update README.md with chezmoi installation and usage instructions.

## Current README
Review existing README.md and replace Comtrya references with chezmoi.

## New README.md Content

```markdown
# Dotfiles

Personal dotfiles managed with [chezmoi](https://chezmoi.io/).

## Quick Install

On a fresh machine, run:

```bash
sh -c "$(curl -fsLS get.chezmoi.io)" -- init --apply rodrigorm
```

## What Gets Installed

### All Platforms
- Bash configuration with modular scripts
- Git configuration
- GNU Screen configuration
- [Starship](https://starship.rs/) cross-shell prompt
- [NVM](https://github.com/nvm-sh/nvm) + Node.js 20
- [pyenv](https://github.com/pyenv/pyenv)
- [Neovim](https://neovim.io/) configuration (from [rodrigorm/nvim](https://github.com/rodrigorm/nvim))
- [Vim](https://www.vim.org/) configuration (from [rodrigorm/vim](https://github.com/rodrigorm/vim))

### macOS (via Homebrew)
- neovim, lazygit, screen, vim, git, bash-completion

### Linux (Ubuntu)
- Neovim (pre-built binary)
- [Lazygit](https://github.com/jesseduffield/lazygit) (pre-built binary)
- GNU Screen 5.0.0 (compiled from source)
- Build tools and development packages

## Devcontainer / Devpod

For VS Code devcontainers or [DevPod](https://devpod.sh/):

```bash
./bootstrap.sh
```

## Daily Usage

```bash
# Pull latest changes and apply
chezmoi update

# See what would change
chezmoi diff

# Apply changes
chezmoi apply

# Edit a dotfile
chezmoi edit ~/.bashrc

# Add a new file to chezmoi
chezmoi add ~/.newconfig
```

## Development

```bash
# Test in Docker container
make test

# Lint shell scripts
make shellcheck

# Build Docker image only
make image

# Benchmark shell startup time
make benchmark
```

## Repository Structure

```
.
├── .chezmoiscripts/          # Installation scripts (packages, tools)
├── .chezmoidata.yaml         # Version numbers for tools
├── .chezmoiexternal.toml.tmpl # External git repos (nvim, vim configs)
├── .chezmoiignore            # Files excluded from home directory
├── dot_bashrc                # → ~/.bashrc
├── dot_bashrc.d/             # → ~/.bashrc.d/
├── dot_config/               # → ~/.config/
├── dot_gitconfig             # → ~/.gitconfig
├── dot_screenrc              # → ~/.screenrc
├── bin/                      # → ~/bin/
├── private_dot_ssh/          # → ~/.ssh/ (mode 0700)
├── bootstrap.sh              # Devcontainer bootstrap script
├── Dockerfile                # Test container
└── Makefile                  # Development commands
```

## Customization

### Adding New Dotfiles

```bash
# Add existing file to chezmoi management
chezmoi add ~/.newfile

# Add with specific attributes
chezmoi add --template ~/.config/app.conf  # As template
chezmoi add --private ~/.secrets           # With restricted permissions
```

### Modifying Versions

Edit `.chezmoidata.yaml` to change tool versions:

```yaml
neovim_version: "v0.10.4"
lazygit_version: "v0.44.1"
nodejs_version: "20"
```

Then run `chezmoi apply` to update.

## License

[LGPL](LICENSE)
```

## Key Changes from Current README
1. Replace all Comtrya references with chezmoi
2. Update install one-liner
3. Add daily usage section
4. Document repository structure with chezmoi naming
5. Add customization guide
6. Keep it concise and scannable

## Acceptance Criteria
- [ ] README.md updated with new content
- [ ] All chezmoi commands are correct and tested
- [ ] Repository structure matches actual file layout (after task .2)
- [ ] No references to Comtrya remain
- [ ] Links work (chezmoi.io, GitHub repos)


