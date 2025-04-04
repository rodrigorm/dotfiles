#!/usr/bin/env bash

# Setup shell for Homebrew
if command -v brew >/dev/null 2>&1; then
    eval "$(brew shellenv)"

    if [ -f "$HOMEBREW_PREFIX/etc/profile.d/bash_completion.sh" ]; then
        # shellcheck source=/dev/null
        source "$HOMEBREW_PREFIX/etc/profile.d/bash_completion.sh"
    fi
fi
