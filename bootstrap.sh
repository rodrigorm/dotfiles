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

# Install remaining packages (including bash-completion which conflicts with util-linux)
brew install \
    anomalyco/tap/opencode \
    bash \
    bash-completion \
    frpc \
    frps \
    fzf \
    gh \
    glab \
    jq \
    lazygit \
    libnotify \
    lsof \
    luarocks \
    neovim \
    node \
    oven-sh/bun/bun \
    ripgrep \
    screen \
    starship \
    tmux \
    unzip \
    vim

# Linux uses the Homebrew CLI and daemon. Tailscale installation on macOS is manual.
if [[ "$(uname -s)" == "Linux" ]]; then
    brew install tailscale
fi

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
bun install -g agent-browser
# Fix permissions for the installed binary
chmod +x "$HOME/.bun/install/global/node_modules/agent-browser/bin/"* 2>/dev/null || true

bun install -g @fission-ai/openspec@latest

# Skills.sh
rm -rf "$HOME/.agents/skills/"
bunx skills add brianlovin/claude-config --skill simplify --agent opencode --agent codex --global --yes
bunx skills add cursor/plugins --skill unslop --agent opencode --agent codex --global --yes
bunx skills add humanlayer/skills --skill show-me --agent opencode --agent codex --global --yes
bunx skills add mattpocock/skills \
    --skill ask-matt \
    --skill code-review \
    --skill codebase-design \
    --skill diagnosing-bugs \
    --skill domain-modeling \
    --skill grill-with-docs \
    --skill implement \
    --skill improve-codebase-architecture \
    --skill prototype \
    --skill research \
    --skill setup-matt-pocock-skills \
    --skill tdd \
    --skill to-spec \
    --skill to-tickets \
    --skill triage \
    --skill wayfinder \
    --skill wizard \
    --skill implement-spec \
    --skill retro \
    --skill grill-me \
    --skill grilling \
    --skill teach \
    --skill writing-for-agents \
    --agent opencode --agent codex --global --yes
bunx skills add vercel-labs/agent-browser --skill agent-browser --agent opencode --agent codex --global --yes
bunx skills add vercel-labs/skills --skill find-skills --agent opencode --agent codex --global --yes
