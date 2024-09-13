#!/usr/bin/env bash

[ -z ${__usage+x} ] && read -r -d '' __usage <<-EOF || true # exits non-zero when EOF encountered
  -v                      Enable verbose mode, print script as it is executed
  -D --debug              Enables debug mode
  -h --help               This page
	-N --no-color           Disable color output
EOF

source "${BASH_SOURCE%/*}/home/bin/lib/bash3boilerplate.sh"


### Command-line argument switches (like -d for debugmode, -h for showing helppage)
##############################################################################

# debug mode
if [ "${arg_D}" = "1" ]; then
  set -o xtrace
  LOG_LEVEL="7"
fi

# verbose mode
if [ "${arg_v}" = "1" ]; then
  set -o verbose
fi

# no color mode
if [ "${arg_N}" = "1" ]; then
  NO_COLOR="true"
fi

# help mode
if [ "${arg_h}" = "1" ]; then
  # Help exists with code 1
  help "${__base} - manage screen session"
fi

### Validation. Error out if the things required for your script are not present
##############################################################################

[ -z "${LOG_LEVEL:-}" ] && emergency "Cannot continue without LOG_LEVEL. "

### Runtime
##############################################################################

info "__file: ${__file}"
info "__dir: ${__dir}"
info "__base: ${__base}"
info "OSTYPE: ${OSTYPE}"

info "arg_D: ${arg_D}"
info "arg_v: ${arg_v}"
info "arg_h: ${arg_h}"
info "arg_N: ${arg_N}"

# Do we have the essentials?
if ! command -v curl >/dev/null 2>&1
then
	echo "Dependencies failed to found: curl"
	exit 1
fi

if ! command -v cc >/dev/null 2>&1
then
	echo "Dependencies failed to found: cc"
	exit 1
fi

# Do we have Comtrya?
if ! command -v comtrya >/dev/null 2>&1
then
	echo "Installing Rust ..."
	curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
	source "${HOME}/.cargo/env"

	echo "Installing Comtrya ..."
	cargo install comtrya
fi

echo "Running a full Comtrya apply ..."
cd "${BASH_SOURCE%/*}"
comtrya apply