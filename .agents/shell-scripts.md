# Shell Scripts Guidelines

## Overview

All shell scripts in this repository follow bash3boilerplate conventions for consistency and reliability across platforms.

## Conventions

### Template
Use `home/bin/lib/bash3boilerplate.sh` as the base template for new scripts.

### Error Handling
Always enable strict error handling at the top of scripts:
```bash
set -euo pipefail
```

### Structure
- Modular bash config scripts live in `home/.bashrc.d/`
- Use numbered prefixes: `00-reset.sh`, `10-feature.sh`, `20-another.sh`
- Numbers determine load order (lower = earlier)

### Formatting
- Use 4-space indentation (not tabs)
- Use descriptive variable and function names

### Cross-Platform Support
- Detect platform early (see `home/.bashrc.d/.init.sh`)
- Handle macOS/Linux differences gracefully
- Validate dependencies before installation

## Testing Requirements

All shell scripts must pass:
- `make shellcheck` - Lint all scripts
- `make test` - Test in Ubuntu 24.04 Docker container

## Error Handling Rules

- Use proper exit codes (`0` for success, `1` for errors)
- Validate required dependencies before installation
- Handle missing packages gracefully across platforms
- Provide helpful error messages for common failures
