---
id: df-d2j
status: closed
deps: []
links: []
created: 2025-12-12T10:54:01.111686-03:00
type: bug
priority: 0
---
# Fix failing Docker tests (5/17 tests failing)

Identified root causes of Docker test failures:

1. **Neovim GLIBC incompatibility**: Neovim binaries require GLIBC 2.38+ but Ubuntu 22.04 has 2.35
2. **NodeJS installation failure**: NVM installs but NodeJS fails, breaking Comtrya apply
3. **Missing .bashrc.d linking**: Dotfiles manifest doesn't link .bashrc.d directory
4. **Comtrya stops on first failure**: When NodeJS fails, subsequent manifests don't run

**Fixed:**
- Added .bashrc.d directory linking to dotfiles manifest
- Fixed YAML indentation issues

**Still failing:**
- Neovim installation (GLIBC issue)
- Aliases loading (requires .bashrc.d to be linked)
- OS detection (requires .bashrc.d/.init.sh)
- PATH setup (requires bashrc loading)

**Next steps:**
1. Fix NodeJS installation or make it non-blocking
2. Resolve Neovim GLIBC issue (build from source or use compatible version)
3. Ensure all dotfiles are linked before tests run


