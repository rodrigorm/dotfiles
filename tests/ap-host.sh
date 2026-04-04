#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AP_HOST="$REPO_ROOT/home/bin/ap-host"
LEAKED_CONFIG="/tmp/ap-host-frps.XXXXXX.toml"
TEST_TMPDIR="$(mktemp -d)"

cleanup() {
    rm -f "$LEAKED_CONFIG"
    rm -rf "$TEST_TMPDIR"
}

trap cleanup EXIT

cat > "$TEST_TMPDIR/frps" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$1" != "-c" || ! -f "$2" ]]; then
    exit 1
fi
EOF

chmod +x "$TEST_TMPDIR/frps"
rm -f "$LEAKED_CONFIG"

AP_HOST_FRPS_BIN="$TEST_TMPDIR/frps" "$AP_HOST" >/dev/null

if [[ -e "$LEAKED_CONFIG" ]]; then
    printf 'ap-host leaked config file %s\n' "$LEAKED_CONFIG" >&2
    exit 1
fi

AP_HOST_FRPS_BIN="$TEST_TMPDIR/frps" "$AP_HOST" >/dev/null
