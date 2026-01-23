# Shell Scripts Guidelines

All shell scripts follow bash3boilerplate conventions for consistency and reliability.

## Error Handling

Enable strict mode at the top of every script:
```bash
set -euo pipefail
```

## Structure

- Scripts in `home/.bashrc.d/` use numbered prefixes (`00-reset.sh`, `10-feature.sh`)
- Numbers determine load order (lower = earlier)

## Formatting

- 4-space indentation (not tabs)
- Descriptive variable and function names

## Cross-Platform

- Detect platform early (macOS vs Linux)
- Handle differences gracefully
- Validate dependencies before use

## Testing

All scripts must pass:
- `make shellcheck` - Lint all scripts
- `make test` - Test in Docker container
