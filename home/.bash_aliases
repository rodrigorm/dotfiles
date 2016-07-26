export PATH="$PATH:$HOME/bin:/opt/chefdk/bin"

namescreen() {
	printf "\033k$1\033\\"
	screen -U -Rad -S "$1"
}

alias mainscreen='cd "$HOME" && namescreen Main'
alias subscreen='namescreen $(basename $(pwd))'
alias gitscreen='git status && cd $(git rev-parse --show-toplevel) && subscreen'

export PATH="/opt/adt-bundle-linux/sdk/platform-tools:$PATH"
export PATH="/opt/adt-bundle-linux/sdk/tools:$PATH"
export PATH="/opt/adt-bundle-linux/sdk/build-tools/android-4.4:$PATH"
