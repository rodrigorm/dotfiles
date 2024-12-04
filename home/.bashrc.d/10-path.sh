#!/usr/bin/env bash

# set PATH so it includes user's private bin if it exists
[ -d "$HOME/bin" ] && PATH="$HOME/bin:$PATH"

# Add RVM to PATH for scripting
[ -d "$HOME/.rvm/bin" ] && PATH="$HOME/.rvm/bin:$PATH" 

[ -d "/usr/local/sbin" ] && PATH="/usr/local/sbin:$PATH"

[ -d "/opt/chefdk/bin" ] && PATH="/opt/chefdk/bin:$PATH"

[ -d "$HOME/.composer/vendor/bin" ] && PATH="$HOME/.composer/vendor/bin:$PATH"

if [ -d "$HOME/Library/Android/sdk" ] ; then
  export ANDROID_HOME="$HOME/Library/Android/sdk"
  export PATH="$ANDROID_HOME/emulator:$PATH"
  export PATH="$ANDROID_HOME/tools:$PATH"
  export PATH="$ANDROID_HOME/tools/bin:$PATH"
  export PATH="$ANDROID_HOME/platform-tools:$PATH"
fi

[ -d "$HOME/.virtualenv/bin" ] && PATH="$HOME/.virtualenv/bin:$PATH"

[ -d "/usr/local/go/bin" ] && PATH="/usr/local/go/bin:$PATH"

[ -d "$HOME/.cargo/bin" ] && PATH="$HOME/.cargo/bin:$PATH"
