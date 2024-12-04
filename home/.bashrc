#!/usr/bin/env bash

# ~/.bashrc: executed by bash(1) for non-login shells.
# see /usr/share/doc/bash/examples/startup-files (in the package bash-doc)
# for examples

if [ -f "$HOME/.rvm/scripts/rvm" ]; then
    # shellcheck source=/dev/null
	source "$HOME/.rvm/scripts/rvm"
fi

if [ -d "$HOME/.phpenv/bin" ] ; then
	export PATH="$HOME/.phpenv/bin:$PATH"
	export PATH="$HOME/.phpenv/shims:$PATH"
	eval "$(phpenv init -)"
fi

# Setup workspace directory
mkdir -p "$HOME/workspace"
export GOPATH="$HOME/workspace"
export PATH="$PATH:$GOPATH/bin"

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

#
# Exit from sc when exiting from shell
#
function __sc_exit() {
    if [ "${STY:-}" != "" ]; then
        sc -d
    fi
}
# trap __sc_exit EXIT

export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "${NVM_DIR}/nvm.sh" ] && source "${NVM_DIR}/nvm.sh"  # This loads nvm
# shellcheck source=/dev/null
[ -s "${NVM_DIR}/bash_completion" ] && source "${NVM_DIR}/bash_completion"  # This loads nvm bash_completion

[ -s "/usr/local/lib/node_modules/full-icu" ] && export NODE_ICU_DATA="/usr/local/lib/node_modules/full-icu"

# added by travis gem
# shellcheck source=/dev/null
[ -f "$HOME/.travis/travis.sh" ] && source "$HOME/.travis/travis.sh"

# shellcheck source=/dev/null
if [ -e "$HOME/.nix-profile/etc/profile.d/nix.sh" ]; then source "$HOME/.nix-profile/etc/profile.d/nix.sh"; fi # added by Nix installer

# Initialize `~/.bashrc.d`
[[ -s "${HOME}/.bashrc.d/.init.sh" ]] && source "${HOME}/.bashrc.d/.init.sh"
