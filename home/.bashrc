#!/usr/bin/env bash

# ~/.bashrc: executed by bash(1) for non-login shells.
# see /usr/share/doc/bash/examples/startup-files (in the package bash-doc)
# for examples

# Initialize `~/.bashrc.d`
[[ -s "${HOME}/.bashrc.d/.init.sh" ]] && source "${HOME}/.bashrc.d/.init.sh"
