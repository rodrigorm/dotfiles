#!/usr/bin/env bash

if [ -z "${NVM_DIR:-}" ]; then
    if [ -d "/usr/local/share/nvm" ]; then
        export NVM_DIR="/usr/local/share/nvm"
    else
        export NVM_DIR="$HOME/.nvm"
    fi
fi

if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    source "$NVM_DIR/nvm.sh" --no-use
fi

__nvm_prioritize_bin() {
    if [ -z "${NVM_BIN:-}" ] || [ ! -d "$NVM_BIN" ]; then
        return
    fi

    PATH=":$PATH:"
    PATH="${PATH//:$NVM_BIN:/:}"
    PATH="${PATH#:}"
    PATH="${PATH%:}"
    export PATH="$NVM_BIN:$PATH"
}

if [ -n "$PS1" ]; then
    case ";$PROMPT_COMMAND;" in
    *";__nvm_prioritize_bin;"*) ;;
    *) PROMPT_COMMAND="__nvm_prioritize_bin${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
    esac
fi

__nvm_prioritize_bin
