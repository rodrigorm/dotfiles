#!/usr/bin/env bash

# Ensure UTF-8 locale for proper Unicode rendering (terminals, TUIs, etc.)

if [[ -z "${LANG}" || "${LANG}" == "POSIX" || "${LANG}" == "C" ]]; then
    # Prefer C.UTF-8 (minimal, always available on modern Linux)
    # Fall back to en_US.UTF-8 if available
    if locale -a 2>/dev/null | grep -qE "^C\.(UTF-8|utf8)$"; then
        export LANG="C.UTF-8"
        export LC_ALL="C.UTF-8"
    elif locale -a 2>/dev/null | grep -qE "^en_US\.(UTF-8|utf8)$"; then
        export LANG="en_US.UTF-8"
        export LC_ALL="en_US.UTF-8"
    fi
fi
