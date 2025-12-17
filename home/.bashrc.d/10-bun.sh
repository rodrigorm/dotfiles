#!/usr/bin/env bash

# Bun Runtime Setup
# Initialize Bun environment and add to PATH

# Set Bun installation directory
export BUN_INSTALL="$HOME/.bun"

# Prepend Bun binary to PATH if not already present
if [[ ":$PATH:" != *":$BUN_INSTALL/bin:"* ]]; then
    export PATH="$BUN_INSTALL/bin:$PATH"
fi

