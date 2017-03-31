# ~/.bashrc: executed by bash(1) for non-login shells.
# see /usr/share/doc/bash/examples/startup-files (in the package bash-doc)
# for examples

# If not running interactively, don't do anything
case $- in
    *i*) ;;
      *) return;;
esac

# don't put duplicate lines or lines starting with space in the history.
# See bash(1) for more options
HISTCONTROL=ignoreboth

# append to the history file, don't overwrite it
shopt -s histappend

# for setting history length see HISTSIZE and HISTFILESIZE in bash(1)
HISTSIZE=1000
HISTFILESIZE=2000

# check the window size after each command and, if necessary,
# update the values of LINES and COLUMNS.
shopt -s checkwinsize

# If set, the pattern "**" used in a pathname expansion context will
# match all files and zero or more directories and subdirectories.
#shopt -s globstar

# make less more friendly for non-text input files, see lesspipe(1)
[ -x /usr/bin/lesspipe ] && eval "$(SHELL=/bin/sh lesspipe)"

# set variable identifying the chroot you work in (used in the prompt below)
if [ -z "${debian_chroot:-}" ] && [ -r /etc/debian_chroot ]; then
    debian_chroot=$(cat /etc/debian_chroot)
fi

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

# If this is an xterm set the title to user@host:dir
case "$TERM" in
xterm*|rxvt*)
    PS1="\[\e]0;${debian_chroot:+($debian_chroot)}\u@\h: \w\a\]$PS1"
    ;;
*)
    ;;
esac

# enable color support of ls and also add handy aliases
if [ -x /usr/bin/dircolors ]; then
    test -r ~/.dircolors && eval "$(dircolors -b ~/.dircolors)" || eval "$(dircolors -b)"
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

if [ -f ~/.bash_aliases ]; then
    . ~/.bash_aliases
fi

# enable programmable completion features (you don't need to enable
# this, if it's already enabled in /etc/bash.bashrc and /etc/profile
# sources /etc/bash.bashrc).
if ! shopt -oq posix; then
  if [ -f /usr/share/bash-completion/bash_completion ]; then
    . /usr/share/bash-completion/bash_completion
  elif [ -f `brew --prefix`/etc/bash_completion ]; then
    . `brew --prefix`/etc/bash_completion
  elif [ -f /etc/bash_completion ]; then
    . /etc/bash_completion
  fi
fi

source "$HOME/.homesick/repos/homeshick/homeshick.sh"
source "$HOME/.homesick/repos/homeshick/completions/homeshick-completion.bash"

if [ ! "$TERM" == "linux" ]; then
	if [ ! -f "$HOME/.homesick/repos/pure/pure.bash" ]; then
		homeshick clone rodrigorm/pure
	fi

	if [ -f /usr/local/git/contrib/completion/git-prompt.sh ]; then
		source /usr/local/git/contrib/completion/git-prompt.sh
	elif [ -f /usr/share/git-core/contrib/completion/git-prompt.sh ]; then
		source /usr/share/git-core/contrib/completion/git-prompt.sh
	fi
	source "$HOME/.homesick/repos/pure/pure.bash"
fi

if [ ! -f "$HOME/.homesick/repos/vim/vimrc" ]; then
	homeshick clone rodrigorm/vim
	$(homeshick cd vim && git submodule update --init)
fi

if [ -f "$HOME/.rvm/scripts/rvm" ]; then
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
	export PATH="/home/rmoyle/.phpenv/bin:$PATH"
	export PATH="/home/rmoyle/.phpenv/shims:$PATH"
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

if [ -d "/usr/local/opt/android-sdk" ] ; then
    export ANDROID_HOME="/usr/local/opt/android-sdk"
    export PATH="$PATH:$ANDROID_HOME/tools"
    export PATH="$PATH:$ANDROID_HOME/platform-tools"
fi

if [ -d "$HOME/Android/Sdk" ] ; then
    export ANDROID_HOME="$HOME/Android/Sdk"
    export PATH="$PATH:$ANDROID_HOME/tools"
    export PATH="$PATH:$ANDROID_HOME/platform-tools"
fi

#
# setup ssh-agent
#

# start agent if necessary
if [ -z $SSH_AUTH_SOCK ] && [ -z $SSH_TTY ]; then  # if no agent & not in ssh
	eval `ssh-agent -s` > /dev/null
fi

# setup addition of keys when needed
if [ -z "$SSH_TTY" ] ; then                     # if not using ssh
	ssh-add -l > /dev/null                        # check for keys
	if [ $? -ne 0 ] ; then
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

PERL_MB_OPT="--install_base \"/Users/rmoyle/perl5\""; export PERL_MB_OPT;
PERL_MM_OPT="INSTALL_BASE=/Users/rmoyle/perl5"; export PERL_MM_OPT;
export DEVKITPRO=$HOME/workspace/devkitARM-downloader
export DEVKITARM=$DEVKITPRO/devkitARM
export GTEST_DIR=$HOME/workspace/github/google/googletest/googletest

export NVM_DIR="/home/rodrigomoyle/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
