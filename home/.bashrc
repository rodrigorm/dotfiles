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
# Exit from sc when exiting from shell
#
function __sc_exit() {
    if [ "${STY:-}" != "" ]; then
        sc -d
    fi
}
# trap __sc_exit EXIT

[ -s "/usr/local/lib/node_modules/full-icu" ] && export NODE_ICU_DATA="/usr/local/lib/node_modules/full-icu"

# added by travis gem
# shellcheck source=/dev/null
[ -f "$HOME/.travis/travis.sh" ] && source "$HOME/.travis/travis.sh"

# shellcheck source=/dev/null
if [ -e "$HOME/.nix-profile/etc/profile.d/nix.sh" ]; then source "$HOME/.nix-profile/etc/profile.d/nix.sh"; fi # added by Nix installer

# Initialize `~/.bashrc.d`
[[ -s "${HOME}/.bashrc.d/.init.sh" ]] && source "${HOME}/.bashrc.d/.init.sh"
