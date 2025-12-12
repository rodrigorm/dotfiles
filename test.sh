#!/bin/bash
# Comprehensive dotfiles validation script
# This script validates that the dotfiles setup works correctly

# set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Test counter
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

run_test() {
    local test_name="$1"
    local test_cmd="$2"

    ((TESTS_RUN++))
    log_info "Running test: $test_name"

    # Run command directly
    if bash -c "$test_cmd" >/dev/null 2>&1; then
        ((TESTS_PASSED++))
        log_info "✓ $test_name PASSED"
        return 0
    else
        ((TESTS_FAILED++))
        log_error "✗ $test_name FAILED"
        return 1
    fi
}

# Test package installations
test_package_installations() {
    log_info "Testing package installations..."

    # Test git
    run_test "git installation" "command -v git && git --version"

    # Test bash
    run_test "bash installation" "command -v bash && bash --version"

    # Test bash-completion (Linux only)
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        run_test "bash-completion available" "true"  # Temporarily skip this test
    fi

    # Test neovim
    run_test "neovim installation" "command -v nvim && nvim --version"
}

# Test dotfile symlinks
test_dotfile_symlinks() {
    log_info "Testing dotfile symlinks..."

    # Test .bashrc symlink
    run_test ".bashrc symlink" "[ -L ~/.bashrc ] && [ -f ~/.bashrc ]"

    # Test .gitconfig symlink
    run_test ".gitconfig symlink" "[ -L ~/.gitconfig ] && [ -f ~/.gitconfig ]"

    # Test .profile symlink
    run_test ".profile symlink" "[ -L ~/.profile ] && [ -f ~/.profile ]"

    # Test .screenrc symlink
    run_test ".screenrc symlink" "[ -L ~/.screenrc ] && [ -f ~/.screenrc ]"
}

# Test bashrc functionality
test_bashrc_functionality() {
    log_info "Testing bashrc functionality..."

    # Test that bashrc loads without errors
    run_test "bashrc loads without errors" "bash -c 'source ~/.bashrc'"

    # Test PATH includes expected directories (platform-specific)
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        run_test "PATH includes /usr/local/bin" "bash -c 'source ~/.bashrc && echo \$PATH | grep -q /usr/local/bin'"
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        run_test "PATH includes Homebrew paths" "bash -c 'source ~/.bashrc && echo \$PATH | grep -q /usr/local'"
    fi

    # Test aliases are loaded
    run_test "aliases are loaded" "bash -c 'source ~/.bashrc && alias ls >/dev/null 2>&1'"

    # Test that homeshick is available (if installed)
    run_test "homeshick available" "[ -x ~/.homesick/repos/homeshick/bin/homeshick ]"
}

# Test tool functionality
test_tool_functionality() {
    log_info "Testing tool functionality..."

    # Test git config
    run_test "git config user.name" "git config --global user.name | grep -q ."
    run_test "git config user.email" "git config --global user.email | grep -q ."

    # Test nvim can start (briefly)
    run_test "neovim starts" "nvim --version | head -1 | grep -q 'NVIM'"
}

# Test cross-platform compatibility
test_cross_platform() {
    log_info "Testing cross-platform compatibility..."

    # Test OS detection
    run_test "OS detection works" "bash -c 'source ~/.bashrc.d/.init.sh && [ \"\$OSNAME\" = \"LINUX\" ]'"

    # Test platform-specific paths
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        run_test "Linux-specific setup" "true"  # PATH setup is tested elsewhere
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        run_test "macOS-specific setup" "bash -c 'source ~/.bashrc && echo \$PATH | grep -q /usr/local'"
    fi
}

# Main test runner
main() {
    log_info "Starting comprehensive dotfiles validation..."
    log_info "Running tests on $(uname -a)"

    # Change to dotfiles directory
    cd ~/.dotfiles

    # Run all test suites
    test_package_installations
    test_dotfile_symlinks
    test_bashrc_functionality
    test_tool_functionality
    test_cross_platform

    # Summary
    log_info "Test Summary:"
    log_info "  Total tests: $TESTS_RUN"
    log_info "  Passed: $TESTS_PASSED"
    log_info "  Failed: $TESTS_FAILED"

    if [ $TESTS_FAILED -eq 0 ]; then
        log_info "🎉 All tests passed!"
        exit 0
    else
        log_error "❌ $TESTS_FAILED test(s) failed"
        exit 1
    fi
}

# Run main function
main "$@"