# ~/.profile: executed by the command interpreter for login shells.
# This file is not read by bash(1), if ~/.bash_profile or ~/.bash_login
# exists.
# see /usr/share/doc/bash/examples/startup-files for examples.
# the files are located in the bash-doc package.

# the default umask is set in /etc/profile; for setting the umask
# for ssh logins, install and configure the libpam-umask package.
#umask 022

# Disable Caps Lock
xmodmap -e "remove lock = Caps_Lock"
nohup "$HOME/bin/caps_lock_off" > /dev/null 2>&1 &

# Disable Beep
xset -b

# if running bash
if [ -n "$BASH_VERSION" ]; then
    # include .bashrc if it exists
    if [ -f "$HOME/.bashrc" ]; then
	. "$HOME/.bashrc"
    fi
fi

# set PATH so it includes user's private bin if it exists
if [ -d "$HOME/bin" ] ; then
    PATH="$HOME/bin:$PATH"
fi

#
# setup ssh-agent
#

# set environment variables if user's agent already exists
SSH_AUTH_SOCK=$(ls -l /tmp/ssh-*/agent.* 2> /dev/null | grep $(whoami) | awk '{print $9}')
SSH_AGENT_PID=$(echo $SSH_AUTH_SOCK | cut -d. -f2)
[ -n "$SSH_AUTH_SOCK" ] && export SSH_AUTH_SOCK
[ -n "$SSH_AGENT_PID" ] && export SSH_AGENT_PID

# start agent if necessary
if [ -z $SSH_AGENT_PID ] && [ -z $SSH_TTY ]; then  # if no agent & not in ssh
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
