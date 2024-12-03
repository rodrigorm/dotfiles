#!/usr/bin/env bash

# ~/.bashrc: executed by bash(1) for non-login shells.
# see /usr/share/doc/bash/examples/startup-files (in the package bash-doc)
# for examples

# set a fancy prompt (non-color, unless we know we "want" color)
case "$TERM" in
    xterm-color) color_prompt=yes;;
esac

# uncomment for a colored prompt, if the terminal has the capability; turned
# off by default to not distract the user: the focus in a terminal window
# should be on the output of commands, not on the prompt
#force_color_prompt=yes

if [ -n "$force_color_prompt" ]; then
    if [ -x /usr/bin/tput ] && tput setaf 1 >&/dev/null; then
	# We have color support; assume it's compliant with Ecma-48
	# (ISO/IEC-6429). (Lack of such support is extremely rare, and such
	# a case would tend to support setf rather than setaf.)
	color_prompt=yes
    else
	color_prompt=
    fi
fi

if [ "$color_prompt" = yes ]; then
    PS1='${debian_chroot:+($debian_chroot)}\[\033[01;32m\]\u@\h\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ '
else
    PS1='${debian_chroot:+($debian_chroot)}\u@\h:\w\$ '
fi
unset color_prompt force_color_prompt

# enable color support of ls and also add handy aliases
if [ -x /usr/bin/dircolors ]; then
    if test -r "$HOME/.dircolors"; then
      eval "$(dircolors -b "$HOME/.dircolors")"
    else
      commandeval "$(dircolors -b)"
    fi

    alias ls='ls --color=auto'
    #alias dir='dir --color=auto'
    #alias vdir='vdir --color=auto'

    alias grep='grep --color=auto'
    alias fgrep='fgrep --color=auto'
    alias egrep='egrep --color=auto'
fi

# some more ls aliases
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'

# Add an "alert" alias for long running commands.  Use like so:
#   sleep 10; alert
alias alert='notify-send --urgency=low -i "$([ $? = 0 ] && echo terminal || echo error)" "$(history|tail -n1|sed -e '\''s/^\s*[0-9]\+\s*//;s/[;&|]\s*alert$//'\'')"'

# Alias definitions.
# You may want to put all your additions into a separate file like
# ~/.bash_aliases, instead of adding them here directly.
# See /usr/share/doc/bash-doc/examples in the bash-doc package.

if [ -f "$HOME/.bash_aliases" ]; then
    source "$HOME/.bash_aliases"
fi

# shellcheck source=/dev/null
source "$HOME/.homesick/repos/homeshick/homeshick.sh"
# shellcheck source=/dev/null
source "$HOME/.homesick/repos/homeshick/completions/homeshick-completion.bash"

if [ ! "$TERM" == "linux" ]; then
	if [ -f /usr/local/git/contrib/completion/git-prompt.sh ]; then
        # shellcheck source=/dev/null
		source /usr/local/git/contrib/completion/git-prompt.sh
	elif [ -f /usr/share/git-core/contrib/completion/git-prompt.sh ]; then
        # shellcheck source=/dev/null
		source /usr/share/git-core/contrib/completion/git-prompt.sh
    elif [ -f /usr/lib/git-core/git-sh-prompt ]; then
        # shellcheck source=/dev/null
        source /usr/lib/git-core/git-sh-prompt
	fi
	# source "$HOME/.homesick/repos/pure/pure.bash"
    # export TOLASTLINE=$(tput cup "$LINES")
    # export PS1="\[$TOLASTLINE\]$PS1"
    export PS1='\[$(tput cup "$LINES")\]'$PS1
fi

if [ -f "$HOME/.rvm/scripts/rvm" ]; then
    # shellcheck source=/dev/null
	source "$HOME/.rvm/scripts/rvm"
fi

# set PATH so it includes user's private bin if it exists
if [ -d "$HOME/bin" ] ; then
    PATH="$HOME/bin:$PATH"
fi

if [ -d "$HOME/.rvm/bin" ] ; then
	export PATH="$PATH:$HOME/.rvm/bin" # Add RVM to PATH for scripting
fi

if [ -d "$HOME/.phpenv/bin" ] ; then
	export PATH="$HOME/.phpenv/bin:$PATH"
	export PATH="$HOME/.phpenv/shims:$PATH"
	eval "$(phpenv init -)"
fi

if [ -d "/usr/local/sbin" ] ; then
    export PATH="/usr/local/sbin:$PATH"
fi

if [ -d "$HOME/bin:/opt/chefdk/bin" ] ; then
    export PATH="$PATH:$HOME/bin:/opt/chefdk/bin"
fi

if [ -d "$HOME/.composer/vendor/bin" ] ; then
	export PATH="$PATH:$HOME/.composer/vendor/bin" # Add RVM to PATH for scripting
fi

if [ -d "$HOME/Library/Android/sdk" ] ; then
    export ANDROID_HOME="$HOME/Library/Android/sdk"
    export PATH="$PATH:$ANDROID_HOME/emulator"
    export PATH="$PATH:$ANDROID_HOME/tools"
    export PATH="$PATH:$ANDROID_HOME/tools/bin"
    export PATH="$PATH:$ANDROID_HOME/platform-tools"
fi

if [ -d "$HOME/.virtualenv/bin" ] ; then
    export PATH="$HOME/.virtualenv/bin:$PATH"
fi

if [ -d "/usr/local/go/bin" ] ; then
    export PATH="$PATH:/usr/local/go/bin"
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
