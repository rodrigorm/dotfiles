---
id: df-s9s.3
status: closed
deps: []
links: []
created: 2025-12-11T17:40:00.093419-03:00
type: task
priority: 1
---
# Create chezmoi installation scripts

Create chezmoi run scripts to replace Comtrya manifests for package/tool installation.

## Directory Structure
Create `.chezmoiscripts/` directory at repository root. Scripts in this directory:
- Run without creating a corresponding directory in the target
- Must have `run_` prefix to be recognized as scripts
- Are executed in alphabetical order within their timing category

## Script Naming Convention
| Prefix | Behavior |
|--------|----------|
| `run_before_` | Run every time, before dotfiles are applied |
| `run_after_` | Run every time, after dotfiles are applied |
| `run_once_before_` | Run once (tracked by content hash), before dotfiles |
| `run_once_` | Run once, during normal application |
| `run_onchange_` | Run when script content changes (good for version bumps) |

Add `.tmpl` suffix to process as template (required for OS detection).

## Scripts to Create

### 1. .chezmoiscripts/run_once_before_00-install-packages.sh.tmpl
Install base packages needed by subsequent scripts.

```bash
#!/bin/bash
set -euo pipefail

{{ if eq .chezmoi.os "darwin" -}}
# macOS - Homebrew packages
if ! command -v brew &> /dev/null; then
    echo "Homebrew not found. Please install it first."
    exit 1
fi

brew install bash bash-completion@2 git vim neovim lazygit
{{ else if eq .chezmoi.os "linux" -}}
# Linux (Ubuntu/Debian) - apt packages
sudo apt-get update
sudo apt-get install -y \
    software-properties-common \
    bash \
    bash-completion \
    git \
    vim \
    build-essential \
    unzip \
    python3-venv \
    ripgrep \
    fzf \
    libncurses5-dev \
    curl \
    ca-certificates
{{ end -}}
```

**Note:** macOS installs neovim and lazygit via Homebrew here. Linux installs them separately.

### 2. .chezmoiscripts/run_once_10-install-nvm.sh.tmpl
Install NVM (Node Version Manager).

```bash
#!/bin/bash
set -euo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

if [[ ! -d "$NVM_DIR" ]]; then
    echo "Installing NVM {{ .nvm_version }}..."
    curl -o- "https://raw.githubusercontent.com/nvm-sh/nvm/{{ .nvm_version }}/install.sh" | bash
fi
```

### 3. .chezmoiscripts/run_onchange_11-install-nodejs.sh.tmpl
Install Node.js via NVM. Uses `run_onchange_` so version changes trigger re-run.

```bash
#!/bin/bash
# nodejs_version: {{ .nodejs_version }}
set -euo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

echo "Installing Node.js {{ .nodejs_version }}..."
nvm install {{ .nodejs_version }}
nvm alias default {{ .nodejs_version }}
```

**Note:** The comment with `{{ .nodejs_version }}` ensures the script re-runs when version changes.

### 4. .chezmoiscripts/run_once_20-install-pyenv.sh.tmpl
Install pyenv for Python version management.

```bash
#!/bin/bash
set -euo pipefail

if [[ ! -d "$HOME/.pyenv" ]]; then
    echo "Installing pyenv..."
    curl https://pyenv.run | bash
fi
```

### 5. .chezmoiscripts/run_once_30-install-starship.sh.tmpl
Install Starship cross-shell prompt.

```bash
#!/bin/bash
set -euo pipefail

if ! command -v starship &> /dev/null; then
    echo "Installing Starship..."
    curl -sS https://starship.rs/install.sh | sh -s -- -y
fi
```

### 6. .chezmoiscripts/run_onchange_40-install-neovim.sh.tmpl
Install Neovim binary (Linux only - macOS uses Homebrew).

```bash
#!/bin/bash
# neovim_version: {{ .neovim_version }}
{{ if eq .chezmoi.os "linux" -}}
set -euo pipefail

NVIM_VERSION="{{ .neovim_version }}"
NVIM_VERSION_NUM="${NVIM_VERSION#v}"  # Remove leading v

# Check if already installed with correct version
if [[ -x /opt/nvim/bin/nvim ]]; then
    INSTALLED=$(/opt/nvim/bin/nvim --version | head -1 | grep -oP "v\d+\.\d+\.\d+" || echo "")
    if [[ "$INSTALLED" == "$NVIM_VERSION" ]]; then
        echo "Neovim $NVIM_VERSION already installed"
        exit 0
    fi
fi

echo "Installing Neovim $NVIM_VERSION..."
cd /tmp
curl -LO "https://github.com/neovim/neovim/releases/download/${NVIM_VERSION}/nvim-linux-x86_64.tar.gz"
tar xzf nvim-linux-x86_64.tar.gz
sudo rm -rf /opt/nvim
sudo mv nvim-linux-x86_64 /opt/nvim
rm -f nvim-linux-x86_64.tar.gz
echo "Neovim installed to /opt/nvim"
{{ end -}}
```

**Note:** Empty output on macOS means script won't run there.

### 7. .chezmoiscripts/run_onchange_50-install-screen.sh.tmpl
Install GNU Screen (Linux: compile from source, macOS: already in packages script).

```bash
#!/bin/bash
# screen_version: {{ .screen_version }}
{{ if eq .chezmoi.os "linux" -}}
set -euo pipefail

SCREEN_VERSION="{{ .screen_version }}"

# Check if already installed with correct version
if command -v screen &> /dev/null; then
    INSTALLED=$(screen --version 2>&1 | grep -oP "\d+\.\d+\.\d+" | head -1 || echo "")
    if [[ "$INSTALLED" == "$SCREEN_VERSION" ]]; then
        echo "Screen $SCREEN_VERSION already installed"
        exit 0
    fi
fi

echo "Compiling Screen $SCREEN_VERSION from source..."
cd /tmp
curl -fsSL "https://ftp.gnu.org/gnu/screen/screen-${SCREEN_VERSION}.tar.gz" -o screen.tar.gz
tar xzf screen.tar.gz
cd "screen-${SCREEN_VERSION}"

./configure \
    --prefix=/usr/local \
    --infodir=/usr/share/info \
    --mandir=/usr/share/man \
    --disable-pam \
    --enable-socket-dir=/run/screen \
    --with-pty-group=5

make -j$(nproc)
sudo make install
sudo install -m 644 etc/etcscreenrc /etc/screenrc

cd /tmp
rm -rf "screen-${SCREEN_VERSION}" screen.tar.gz
echo "Screen $SCREEN_VERSION installed"
{{ end -}}
```

### 8. .chezmoiscripts/run_once_60-create-local-bin.sh.tmpl
Ensure ~/.local/bin exists for user binaries.

```bash
#!/bin/bash
set -euo pipefail

mkdir -p "$HOME/.local/bin"
```

**Note:** This runs before externals that need ~/.local/bin (like lazygit).

### 9. .chezmoiscripts/run_once_70-symlink-vimrc.sh.tmpl
Create ~/.vimrc symlink to the vim repo (cloned by .chezmoiexternal).

```bash
#!/bin/bash
set -euo pipefail

# Wait for .vim to be cloned by externals
if [[ -d "$HOME/.vim" && -f "$HOME/.vim/vimrc" ]]; then
    if [[ ! -L "$HOME/.vimrc" ]]; then
        ln -sf "$HOME/.vim/vimrc" "$HOME/.vimrc"
        echo "Created ~/.vimrc symlink"
    fi
fi
```

## Important Notes

1. **Shebang required**: Every script needs `#!/bin/bash`
2. **Error handling**: Always use `set -euo pipefail`
3. **Template rendering**: Scripts with empty output after template processing don't run
4. **Idempotency**: All scripts should be safe to run multiple times
5. **Order**: Scripts run alphabetically; use number prefixes (00-, 10-, etc.)
6. **Sudo**: Scripts run as current user; use `sudo` for privileged operations
7. **Dependencies**: NVM scripts must source nvm.sh before using nvm commands

## Acceptance Criteria
- [ ] .chezmoiscripts/ directory exists
- [ ] All 9 scripts created with correct names
- [ ] Scripts are valid bash (run `bash -n script.sh` to check)
- [ ] Template syntax is valid (test with `chezmoi execute-template < script`)
- [ ] macOS scripts install neovim/lazygit via Homebrew
- [ ] Linux scripts install neovim binary and compile screen


