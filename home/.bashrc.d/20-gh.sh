#!/usr/bin/env bash

# GitHub CLI
if [ -f "$HOMEBREW_PREFIX/share/bash-completion/completions/gh" ]; then
    # shellcheck source=/dev/null
    source "$HOMEBREW_PREFIX/share/bash-completion/completions/gh"
fi
