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

# Never prompt for confirmation; fail instead of asking.
export NONINTERACTIVE=1

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

export PATH="$HOME/.local/bin:$PATH"
if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "x86_64" ]]; then
    printf '%s\n' 'Skipping the T3 CLI: native releases do not support Intel Macs.'
elif command -v t3 >/dev/null 2>&1; then
    printf '%s\n' "T3 CLI already installed: $(t3 --version)"
else
    # install.sh discovers the version through the anonymous GitHub API,
    # which is often rate-limited (HTTP 403); `gh` gets a higher quota.
    t3_version="$(gh api repos/pingdotgg/t3code/releases/latest --jq '.tag_name | ltrimstr("v")' 2>/dev/null || true)"
    if curl -fsSL https://t3.codes/install.sh | T3CODE_VERSION="$t3_version" sh; then
        printf '%s\n' "T3 CLI installed: $(t3 --version)"
    else
        printf '%s\n' 'T3 CLI install failed (likely GitHub API rate limit); re-run bootstrap.sh later.'
    fi
fi

# Desktop app: Homebrew cask on macOS, AppImage on Linux (best effort).
if [[ "$(uname -s)" == "Darwin" ]]; then
    brew install --cask t3-code
fi
if [[ "$(uname -s)" == "Linux" && -x "$HOME/.local/bin/t3" ]]; then
    case "$(uname -m)" in
        x86_64) t3_appimage_arch="x86_64" ;;
        aarch64 | arm64) t3_appimage_arch="arm64" ;;
        *) t3_appimage_arch="" ;;
    esac
    if [[ -n "$t3_appimage_arch" ]]; then
        t3_version="$("$HOME/.local/bin/t3" --version | awk '{print $2}')"
        t3_version="${t3_version#v}"
        mkdir -p "$HOME/.local/bin"
        if curl -fsSL -o "$HOME/.local/bin/T3-Code.AppImage" \
            "https://github.com/pingdotgg/t3code/releases/download/v${t3_version}/T3-Code-${t3_version}-${t3_appimage_arch}.AppImage"; then
            chmod +x "$HOME/.local/bin/T3-Code.AppImage"
        else
            printf '%s\n' 'Could not download the T3 Code desktop AppImage; continuing without it.'
        fi
    fi
fi

# Setup homeshick (clone only if missing)
if [[ -d "$HOME/.homesick/repos/homeshick/.git" ]]; then
    git -C "$HOME/.homesick/repos/homeshick" pull
else
    rm -rf "$HOME/.homesick/repos/homeshick"
    git clone https://github.com/andsens/homeshick.git "$HOME/.homesick/repos/homeshick"
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
if [[ -d "$HOME/.config/nvim/.git" ]]; then
    git -C "$HOME/.config/nvim" pull origin main
else
    rm -rf "$HOME/.config/nvim"
    git clone https://github.com/rodrigorm/nvim.git "$HOME/.config/nvim"
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
bunx skills add mattpocock/skills --skill '*' --agent opencode --agent codex --global --yes
bunx skills add vercel-labs/agent-browser --skill agent-browser --agent opencode --agent codex --global --yes
bunx skills add vercel-labs/skills --skill find-skills --agent opencode --agent codex --global --yes
