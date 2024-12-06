#!/usr/bin/env bash

#
# setup ssh-agent
#

# start agent if necessary
if [ -z "$SSH_AUTH_SOCK" ] && [ -z "$SSH_TTY" ]; then  # if no agent & not in ssh
    eval "$(ssh-agent -s)" > /dev/null
fi

# redirect $SSH_AUTH_SOCK from connection to keep screen sessions connected with agent
if [[ -S "$SSH_AUTH_SOCK" && ! -h "$SSH_AUTH_SOCK" ]]; then
    ln -sf "$SSH_AUTH_SOCK" "$HOME/.ssh/ssh_auth_sock"
    export SSH_AUTH_SOCK=$HOME/.ssh/ssh_auth_sock;
fi

# setup addition of keys when needed
if [ -z "$SSH_TTY" ] ; then                     # if not using ssh
    if ! ssh-add -l > /dev/null; then                        # check for keys
        alias ssh='ssh-add -l > /dev/null || ssh-add && unalias ssh ; ssh'
        if [ -f "/usr/lib/ssh/x11-ssh-askpass" ] ; then
            SSH_ASKPASS="/usr/lib/ssh/x11-ssh-askpass" ; export SSH_ASKPASS
        fi
    fi
fi
