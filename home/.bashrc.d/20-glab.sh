#!/usr/bin/env bash

# GitLab CLI
if [ -f "$HOMEBREW_PREFIX/share/bash-completion/completions/glab" ]; then
    # shellcheck source=/dev/null
    source "$HOMEBREW_PREFIX/share/bash-completion/completions/glab"
fi
