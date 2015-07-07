# ~/.profile: executed by the command interpreter for login shells.
# This file is not read by bash(1), if ~/.bash_profile or ~/.bash_login
# exists.
# see /usr/share/doc/bash/examples/startup-files for examples.
# the files are located in the bash-doc package.

# the default umask is set in /etc/profile; for setting the umask
# for ssh logins, install and configure the libpam-umask package.
#umask 022

# Disable Caps Lock
if [ -x xmodmap ]; then
    xmodmap -e "remove lock = Caps_Lock"
    nohup "$HOME/bin/caps_lock_off" > /dev/null 2>&1 &
fi

# Disable Beep
if [ -x xset ]; then
    xset -b
fi

# if running bash
if [ -n "$BASH_VERSION" ]; then
    # include .bashrc if it exists
    if [ -f "$HOME/.bashrc" ]; then
	. "$HOME/.bashrc"
    fi
fi
