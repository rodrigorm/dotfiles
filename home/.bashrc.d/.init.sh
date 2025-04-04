#!/usr/bin/env bash

THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"

# Common utilities
case "${OSTYPE}" in
solaris*) export OSNAME="SOLARIS" ;;
darwin*) export OSNAME="MACOSX" ;;
linux*) export OSNAME="LINUX" ;;
bsd*) export OSNAME="BSD" ;;
msys*) export OSNAME="WINDOWS" ;;
*) export OSNAME="${OSTYPE}" ;;
esac

# Source all the 'bashrc.d' files
for BASHRC_D_FILE in "${THIS_DIR}"/*.sh; do
    # shellcheck source=/dev/null
    source "${BASHRC_D_FILE}"
done

# Colorful logging helper: INFO (green) level
function info() {
    echo -e "\e[32m* ${*}\e[39m"
}

# Colorful logging helper: WARN (orange) level
function warn() {
    echo -e "\e[33m* ${*}\e[39m"
}

# Colorful logging helper: ERROR (red) level
function error() {
    echo -e "\e[31m* ${*}\e[39m"
}

# Colorful logging helper: just a new line
function nln() {
    echo ""
}
