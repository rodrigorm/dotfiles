#!/usr/bin/env bash
# Bash3 Boilerplate. Copyright (c) 2014, kvz.io
# https://kvz.io/blog/bash-best-practices.html

set -o errexit
set -o pipefail
# set -o nounset
# set -o xtrace

# Set magic variables for current file & dir
__dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Install Homebrew if not already installed
if ! command -v brew >/dev/null 2>&1; then
    NONINTERACTIVE=1 bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

if command -v /opt/homebrew/bin/brew >/dev/null 2>&1; then
    export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:${PATH}"
elif command -v /home/linuxbrew/.linuxbrew/bin/brew >/dev/null 2>&1; then
    export PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"
fi
eval "$(brew shellenv)"
brew update

# Install packages that may pull in util-linux first
brew install gcc git

# Unlink util-linux on Linux (conflicts with bash-completion)
if [[ "$(uname)" == "Linux" ]]; then
    brew unlink util-linux 2>/dev/null || true
fi

# Tap additional repositories
brew tap wedow/tools

# Install Bun via Homebrew
brew install oven-sh/bun/bun

# Install remaining packages (including bash-completion which conflicts with util-linux)
brew install bash bash-completion neovim lazygit screen tmux starship fzf luarocks ripgrep unzip node@22 opencode libnotify ticket

# Setup homeshick (clone only if missing)
if [[ ! -d "$HOME/.homesick/repos/homeshick" ]]; then
    git clone https://github.com/andsens/homeshick.git "$HOME/.homesick/repos/homeshick"
else
    git -C "$HOME/.homesick/repos/homeshick" pull
fi

# Link dotfiles via homeshick (symlink if missing or different target)
if [[ ! -L "$HOME/.homesick/repos/dotfiles" ]] || [[ "$(readlink "$HOME/.homesick/repos/dotfiles")" != "$__dir" ]]; then
    rm -rf "$HOME/.homesick/repos/dotfiles"
    ln -sf "$__dir" "$HOME/.homesick/repos/dotfiles"
fi
"$HOME/.homesick/repos/homeshick/bin/homeshick" link dotfiles --force

# Setup directories
mkdir -p "$HOME/.ssh"

# Clone/update nvim config
if [[ ! -d "$HOME/.config/nvim" ]]; then
    git clone https://github.com/rodrigorm/nvim.git "$HOME/.config/nvim"
else
    git -C "$HOME/.config/nvim" pull origin main
fi

# Agent Browser
npm install -g agent-browser
agent-browser install --with-deps

# Skills.sh
npx -y skills add obra/superpowers --agent opencode --global -y
npx -y skills add vercel-labs/agent-browser --skill agent-browser --global -y
npx -y skills add https://github.com/brianlovin/claude-config --skill simplify --agent opencode --global -y
npx -y skills add https://github.com/alvinunreal/oh-my-opencode-slim --skill cartography --agent opencode --global -y
npx -y skills add softaworks/agent-toolkit --skill agent-md-refactor --agent opencode --global -y
npx -y skills add softaworks/agent-toolkit --skill crafting-effective-readmes --agent opencode --global -y
npx -y skills add softaworks/agent-toolkit --skill skill-judge --agent opencode --global -y
npx -y skills add softaworks/agent-toolkit --skill writing-clearly-and-concisely --agent opencode --global -y
