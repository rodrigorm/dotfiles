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

## Common Pitfalls

### String Quoting
- **Always quote variables** to prevent word splitting: `"$var"` not `$var`
- **Always quote command substitutions**: `"$(command)"` not `$(command)`
- Use single quotes when you want literal expansion: `'$HOME'` keeps `$HOME` as literal

### Function Scope
- Declare local variables in functions: `local var="$1"`
- Don't leak variables to global scope unintentionally

### Exit Code Handling
- `set -e` stops on errors but can be too aggressive
- Check exit codes explicitly when failure is expected: `command || handle_error`
- Use `set -o pipefail` to catch errors in pipes

### Variable Operations
- Don't use uninitialized variables: `set -u` catches these
- Use `[[ ]]` over `[ ]` for conditional expressions (handles empty strings better)
- Use `(( ))` for arithmetic, not `expr`

### Command Substitution
- Prefer `"$()"` over backticks `` ` ` `` for nesting
- Preserve newlines in output: use `"$(cat file)"` not `$(cat file)`

### Array Handling
- Use arrays for lists: `files=("file1" "file2")`
- Iterate with: `for f in "${files[@]}"; do ... done`
- The `[@]` and quotes are required for proper handling of spaces in filenames
