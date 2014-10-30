export PATH="$PATH:$HOME/bin:/opt/chefdk/bin"

alias mainscreen='cd $HOME && screen -Rad -S Main'
alias subscreen='printf "\033k$(basename $(pwd))\033\\" && screen -Rad -S $(basename $(pwd))'
alias gitscreen='git status && cd $(git rev-parse --show-toplevel) && subscreen'

export PATH="/opt/adt-bundle-linux/sdk/platform-tools:$PATH"
export PATH="/opt/adt-bundle-linux/sdk/tools:$PATH"
export PATH="/opt/adt-bundle-linux/sdk/build-tools/android-4.4:$PATH"
