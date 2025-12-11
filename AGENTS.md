# Dotfiles Repository - Agent Guidelines

## Build/Lint/Test Commands
```bash
# Test the entire dotfiles setup in Docker
make test

# Lint all shell scripts with shellcheck
make shellcheck

# Build Docker image for testing
make image

# Benchmark bashrc loading performance
make benchmark

# Clean up Docker resources
make prune
```

## Code Style Guidelines

### Shell/Bash Scripts
- Use bash3boilerplate template (see `home/bin/lib/bash3boilerplate.sh`)
- Enable strict error handling with `set -euo pipefail`
- Follow modular approach with numbered scripts in `.bashrc.d/`
- Use 4-space indentation for shell scripts
- Cross-platform detection required (see `.bashrc.d/.init.sh`)

### YAML Configuration (Comtrya manifests)
- Use `main.yaml` for tool manifests in `dev/` directories
- Follow existing naming conventions for package managers
- Include cross-platform package installation logic

### File Organization
- Tool manifests go in `dev/{tool}/main.yaml`
- Actual dotfiles go in `home/` directory
- Custom scripts in `home/bin/`
- Config files in `home/.config/`

### Testing
- All changes must pass `make test` (Docker validation)
- All shell scripts must pass `make shellcheck`
- Test in Ubuntu 22.04 container environment

### Error Handling
- Use proper exit codes in shell scripts
- Validate dependencies before installation
- Handle missing packages gracefully across platforms