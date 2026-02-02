#!/usr/bin/env bash

#
# setup ssh-agent
#

# Start agent and add keys if not already running
if [ -z "$SSH_AUTH_SOCK" ]; then
    eval "$(ssh-agent -s)" >/dev/null
    ssh-add 2>/dev/null || true
fi

# redirect $SSH_AUTH_SOCK from connection to keep screen sessions connected with agent
if [[ -S "$SSH_AUTH_SOCK" && ! -L "$SSH_AUTH_SOCK" ]]; then
    ln -sf "$SSH_AUTH_SOCK" "$HOME/.ssh/ssh_auth_sock"
    export SSH_AUTH_SOCK=$HOME/.ssh/ssh_auth_sock
fi
