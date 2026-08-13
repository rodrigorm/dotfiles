#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OC="$REPO_ROOT/home/bin/oc"
TEST_TMPDIR="$(mktemp -d)"
MOCK_BIN="$TEST_TMPDIR/bin"
STATE_DIR="$TEST_TMPDIR/state"

mkdir -p "$MOCK_BIN" "$STATE_DIR"

stop_mock_opencode() {
    local pid
    local attempts=0

    if [[ -f "$MOCK_LISTENER_PID_FILE" ]]; then
        pid="$(cat "$MOCK_LISTENER_PID_FILE")"
        kill "$pid" >/dev/null 2>&1 || true
        while kill -0 "$pid" 2>/dev/null && (( attempts < 50 )); do
            sleep 0.1
            attempts=$((attempts + 1))
        done
    fi
    rm -f "$MOCK_OPENCODE_RUNNING" "$MOCK_LISTENER_PID_FILE"
}

cleanup() {
    stop_mock_opencode
    rm -rf "$TEST_TMPDIR"
}

trap cleanup EXIT

cat > "$MOCK_BIN/tailscale" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

[[ "${TAILSCALE_BE_CLI:-}" == 1 ]] || {
    printf 'TAILSCALE_BE_CLI was not set\n' >&2
    exit 1
}

if [[ "${1:-}" == "status" && "${2:-}" == "--json" ]]; then
    printf '{"BackendState":"%s","Self":{"DNSName":"%s."}}\n' \
        "${MOCK_TAILSCALE_STATE:-Running}" "${MOCK_DNS_NAME}"
    exit 0
fi

if [[ "${1:-}" == "serve" && "${2:-}" == "status" && "${3:-}" == "--json" ]]; then
    cat "$MOCK_SERVE_STATUS_FILE"
    exit 0
fi

if [[ "${1:-}" == "serve" && "${2:-}" != "status" ]]; then
    port=""
    for argument in "$@"; do
        case "$argument" in
            --https=*) port="${argument#--https=}" ;;
        esac
    done
    [[ -n "$port" ]] || {
        printf 'tailscale serve invocation missing HTTPS port: %s\n' "$*" >&2
        exit 1
    }

    endpoint="${MOCK_DNS_NAME}:${port}"
    printf '%s\n' "$*" >> "$MOCK_TAILSCALE_LOG"
    if [[ "${!#}" == "off" ]]; then
        "$MOCK_JQ_BIN" --arg port "$port" --arg endpoint "$endpoint" '
        .TCP = ((.TCP // {}) | del(.[$port])) |
        .Web = ((.Web // {}) | del(.[$endpoint])) |
        .AllowFunnel = ((.AllowFunnel // {}) | del(.[$endpoint]))
        ' "$MOCK_SERVE_STATUS_FILE" > "${MOCK_SERVE_STATUS_FILE}.tmp"
    else
        target="${!#}"
        "$MOCK_JQ_BIN" --arg port "$port" --arg endpoint "$endpoint" --arg target "$target" '
        .TCP = (.TCP // {}) |
        .Web = (.Web // {}) |
        .TCP[$port] = {"HTTPS": true} |
        .Web[$endpoint] = {"Handlers": {"/": {"Proxy": $target}}}
        ' "$MOCK_SERVE_STATUS_FILE" > "${MOCK_SERVE_STATUS_FILE}.tmp"
    fi
    mv "${MOCK_SERVE_STATUS_FILE}.tmp" "$MOCK_SERVE_STATUS_FILE"
    exit 0
fi

printf 'unexpected tailscale invocation: %s\n' "$*" >&2
exit 1
EOF

cat > "$MOCK_BIN/opencode" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" > "$MOCK_OPENCODE_ARGS"
pwd > "$MOCK_OPENCODE_CWD"
printf '%s\n' "${XDG_DATA_HOME:-}" > "$MOCK_OPENCODE_DATA_HOME"
printf '%s\n' "$$" > "$MOCK_LISTENER_PID_FILE"
printf '%s\n' "$$" >> "$MOCK_OPENCODE_STARTS"
touch "$MOCK_OPENCODE_RUNNING"

cleanup() {
    if [[ -f "$MOCK_LISTENER_PID_FILE" ]] && \
        [[ "$(cat "$MOCK_LISTENER_PID_FILE")" == "$$" ]]; then
        rm -f "$MOCK_OPENCODE_RUNNING" "$MOCK_LISTENER_PID_FILE"
    fi
}

trap cleanup EXIT
trap 'exit 0' INT TERM

while true; do
    sleep 1
done
EOF

cat > "$MOCK_BIN/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ -f "$MOCK_OPENCODE_RUNNING" ]]; then
    printf '{"healthy":true,"version":"test"}\n'
    exit 0
fi

exit 22
EOF

cat > "$MOCK_BIN/lsof" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ -f "$MOCK_OPENCODE_RUNNING" && -f "$MOCK_LISTENER_PID_FILE" ]]; then
    cat "$MOCK_LISTENER_PID_FILE"
    exit 0
fi

if [[ "${MOCK_OTHER_LISTENER:-false}" == true ]]; then
    printf '999999\n'
    exit 0
fi

exit 1
EOF

chmod +x "$MOCK_BIN/tailscale" "$MOCK_BIN/opencode" "$MOCK_BIN/curl" "$MOCK_BIN/lsof"

export PATH="$MOCK_BIN:$PATH"
export OC_OPENCODE_BIN="$MOCK_BIN/opencode"
export OC_TAILSCALE_BIN="$MOCK_BIN/tailscale"
export OC_JQ_BIN
OC_JQ_BIN="$(command -v jq)"
export OC_CURL_BIN="$MOCK_BIN/curl"
export OC_LSOF_BIN="$MOCK_BIN/lsof"
export OC_STATE_DIR="$STATE_DIR/oc"
export OC_LISTEN_TIMEOUT=3
export OC_STOP_TIMEOUT=3
export OC_REMOTE_TIMEOUT=3
export OC_PROBE_TIMEOUT=1
export MOCK_JQ_BIN="$OC_JQ_BIN"
export MOCK_DNS_NAME="macmini.tailb55486.ts.net"
export MOCK_SERVE_STATUS_FILE="$STATE_DIR/serve.json"
export MOCK_TAILSCALE_LOG="$STATE_DIR/tailscale.log"
export MOCK_OPENCODE_ARGS="$STATE_DIR/opencode.args"
export MOCK_OPENCODE_CWD="$STATE_DIR/opencode.cwd"
export MOCK_OPENCODE_DATA_HOME="$STATE_DIR/opencode.data-home"
export MOCK_OPENCODE_STARTS="$STATE_DIR/opencode.starts"
export MOCK_OPENCODE_RUNNING="$STATE_DIR/opencode.running"
export MOCK_LISTENER_PID_FILE="$STATE_DIR/listener.pid"

reset_state() {
    stop_mock_opencode
    rm -rf "$OC_STATE_DIR"
    rm -f \
        "$MOCK_SERVE_STATUS_FILE" \
        "$MOCK_TAILSCALE_LOG" \
        "$MOCK_OPENCODE_ARGS" \
        "$MOCK_OPENCODE_CWD" \
        "$MOCK_OPENCODE_DATA_HOME" \
        "$MOCK_OPENCODE_STARTS" \
        "$MOCK_OPENCODE_RUNNING" \
        "$MOCK_LISTENER_PID_FILE"
    unset MOCK_OTHER_LISTENER MOCK_TAILSCALE_STATE
}

write_free_serve_status() {
    printf '{}\n' > "$MOCK_SERVE_STATUS_FILE"
}

write_compatible_serve_status() {
    printf '{"TCP":{"4096":{"HTTPS":true}},"Web":{"%s:4096":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:4096"}}}}}\n' \
        "$MOCK_DNS_NAME" > "$MOCK_SERVE_STATUS_FILE"
}

write_other_serve_service() {
    printf '{"TCP":{"3000":{"HTTPS":true}},"Web":{"%s:3000":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}\n' \
        "$MOCK_DNS_NAME" > "$MOCK_SERVE_STATUS_FILE"
}

write_conflicting_serve_status() {
    printf '{"TCP":{"4096":{"HTTPS":true}},"Web":{"%s:4096":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}\n' \
        "$MOCK_DNS_NAME" > "$MOCK_SERVE_STATUS_FILE"
}

assert_file_missing() {
    local file="$1"
    [[ ! -e "$file" ]] || { printf 'unexpected file: %s\n' "$file" >&2; return 1; }
}

wait_for_pid_to_exit() {
    local pid="$1"
    local attempts=0

    while kill -0 "$pid" 2>/dev/null && (( attempts < 50 )); do
        sleep 0.1
        attempts=$((attempts + 1))
    done
    ! kill -0 "$pid" 2>/dev/null
}

test_starts_in_home_and_is_idempotent() {
    local output="$STATE_DIR/start.out"
    local pid

    reset_state
    write_free_serve_status

    "$OC" > "$output" 2>&1

    grep -Fq "Started OpenCode in $HOME" "$output"
    grep -Fxq 'serve --hostname 127.0.0.1 --port 4096' "$MOCK_OPENCODE_ARGS"
    grep -Fxq "$HOME" "$MOCK_OPENCODE_CWD"
    grep -Fxq 'serve --bg --yes --https=4096 http://127.0.0.1:4096' "$MOCK_TAILSCALE_LOG"
    pid="$(cat "$OC_STATE_DIR/opencode.pid")"
    kill -0 "$pid"

    : > "$MOCK_TAILSCALE_LOG"
    "$OC" > "$STATE_DIR/reuse.out" 2>&1

    [[ "$(wc -l < "$MOCK_OPENCODE_STARTS" | tr -d ' ')" == 1 ]]
    [[ ! -s "$MOCK_TAILSCALE_LOG" ]]
    grep -Fq 'Reusing OpenCode' "$STATE_DIR/reuse.out"
    grep -Fq 'Reusing compatible Tailscale Serve route' "$STATE_DIR/reuse.out"
}

test_force_restarts_owned_resources() {
    local output="$STATE_DIR/force.out"
    local old_pid
    local new_pid

    reset_state
    write_free_serve_status
    "$OC" > /dev/null 2>&1
    old_pid="$(cat "$OC_STATE_DIR/opencode.pid")"
    : > "$MOCK_TAILSCALE_LOG"

    "$OC" --force > "$output" 2>&1

    new_pid="$(cat "$OC_STATE_DIR/opencode.pid")"
    [[ "$new_pid" != "$old_pid" ]]
    wait_for_pid_to_exit "$old_pid"
    kill -0 "$new_pid"
    grep -Fxq 'serve --yes --https=4096 off' "$MOCK_TAILSCALE_LOG"
    grep -Fxq 'serve --bg --yes --https=4096 http://127.0.0.1:4096' "$MOCK_TAILSCALE_LOG"
    grep -Fq 'Started OpenCode in' "$output"
}

test_preserves_other_serve_services() {
    reset_state
    write_other_serve_service

    "$OC" > "$STATE_DIR/other-service.out" 2>&1

    "$OC_JQ_BIN" -e '.TCP["3000"].HTTPS == true' "$MOCK_SERVE_STATUS_FILE" >/dev/null
    "$OC_JQ_BIN" -e '.TCP["4096"].HTTPS == true' "$MOCK_SERVE_STATUS_FILE" >/dev/null
}

test_refuses_conflicting_serve_route_even_with_force() {
    local output="$STATE_DIR/conflict.out"

    reset_state
    write_conflicting_serve_status

    if "$OC" --force > "$output" 2>&1; then
        printf 'oc unexpectedly accepted a conflicting Serve route\n' >&2
        return 1
    fi

    grep -Fq 'configuration was not changed' "$output"
    assert_file_missing "$MOCK_OPENCODE_STARTS"
    assert_file_missing "$MOCK_TAILSCALE_LOG"
}

test_refuses_non_opencode_local_listener() {
    local output="$STATE_DIR/listener.out"

    reset_state
    write_free_serve_status
    export MOCK_OTHER_LISTENER=true

    if "$OC" > "$output" 2>&1; then
        printf 'oc unexpectedly accepted a non-OpenCode listener\n' >&2
        return 1
    fi

    grep -Fq 'occupied by something other than OpenCode' "$output"
    assert_file_missing "$MOCK_OPENCODE_STARTS"
    assert_file_missing "$MOCK_TAILSCALE_LOG"
}

test_refuses_offline_tailscale() {
    local output="$STATE_DIR/offline.out"

    reset_state
    write_free_serve_status
    export MOCK_TAILSCALE_STATE=Stopped

    if "$OC" > "$output" 2>&1; then
        printf 'oc unexpectedly accepted an offline Tailscale client\n' >&2
        return 1
    fi

    grep -Fq 'Tailscale is not running' "$output"
    assert_file_missing "$MOCK_OPENCODE_STARTS"
}

test_requires_associated_macos_cli() {
    local output="$STATE_DIR/missing-cli.out"

    reset_state
    unset OC_TAILSCALE_BIN

    if PATH=/usr/bin:/bin OC_PLATFORM=Darwin \
        "$OC" > "$output" 2>&1; then
        printf 'oc unexpectedly accepted a missing macOS CLI integration\n' >&2
        return 1
    fi

    grep -Fq 'install its command-line integration' "$output"
    export OC_TAILSCALE_BIN="$MOCK_BIN/tailscale"
}

test_rejects_directory_argument() {
    local output="$STATE_DIR/directory.out"

    reset_state
    if "$OC" "$REPO_ROOT" > "$output" 2>&1; then
        printf 'oc unexpectedly accepted a directory argument\n' >&2
        return 1
    fi

    grep -Fq 'unknown argument' "$output"
}

test_uses_custom_port_and_data_home() {
    local data_home="$TEST_TMPDIR/client-data"
    local output="$STATE_DIR/custom-instance.out"

    reset_state
    write_free_serve_status

    PORT=4097 XDG_DATA_HOME="$data_home" "$OC" > "$output" 2>&1

    grep -Fxq 'serve --hostname 127.0.0.1 --port 4097' "$MOCK_OPENCODE_ARGS"
    grep -Fxq "$data_home" "$MOCK_OPENCODE_DATA_HOME"
    grep -Fxq 'serve --bg --yes --https=4097 http://127.0.0.1:4097' "$MOCK_TAILSCALE_LOG"
    grep -Fq 'OpenCode: https://macmini.tailb55486.ts.net:4097' "$output"
}

test_isolates_default_operational_state_by_port() {
    local instance_state="$TEST_TMPDIR/instance-state"
    local output="$STATE_DIR/isolated-state.out"

    reset_state
    write_free_serve_status

    env -u OC_STATE_DIR XDG_STATE_HOME="$instance_state" PORT=4097 \
        "$OC" > "$output" 2>&1

    [[ -s "$instance_state/oc/4097/opencode.pid" ]]
    [[ -e "$instance_state/oc/4097/opencode.log" ]]
    [[ ! -e "$instance_state/oc/opencode.pid" ]]
}

test_rejects_invalid_port() {
    local output="$STATE_DIR/invalid-port.out"

    reset_state

    if PORT=invalid "$OC" > "$output" 2>&1; then
        printf 'oc unexpectedly accepted an invalid port\n' >&2
        return 1
    fi

    grep -Fq 'PORT must be an integer between 1 and 65535' "$output"
    assert_file_missing "$MOCK_OPENCODE_STARTS"
}

test_starts_in_home_and_is_idempotent
test_force_restarts_owned_resources
test_preserves_other_serve_services
test_refuses_conflicting_serve_route_even_with_force
test_refuses_non_opencode_local_listener
test_refuses_offline_tailscale
test_requires_associated_macos_cli
test_rejects_directory_argument
test_uses_custom_port_and_data_home
test_isolates_default_operational_state_by_port
test_rejects_invalid_port

printf 'oc tests passed\n'
