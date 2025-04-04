#!/usr/bin/env bash

if [ -f "$HOME/.homesick/repos/homeshick/homeshick.sh" ]; then
    # shellcheck source=/dev/null
    source "$HOME/.homesick/repos/homeshick/homeshick.sh"
fi

if [ -f "$HOME/.homesick/repos/homeshick/completions/homeshick-completion.bash" ]; then
    # shellcheck source=/dev/null
    source "$HOME/.homesick/repos/homeshick/completions/homeshick-completion.bash"
fi
