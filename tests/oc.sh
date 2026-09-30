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

cat > "$MOCK_BIN/plutil" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == -convert && "$2" == xml1 ]]
# Keep JSON so launchctl's mock can inspect the exact plist contents on Linux.
"$MOCK_JQ_BIN" -e '.ProgramArguments and .EnvironmentVariables' "$3" >/dev/null
EOF

cat > "$MOCK_BIN/launchctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

stop_server() {
    local pid
    local attempts=0
    if [[ -f "$MOCK_LISTENER_PID_FILE" ]]; then
        pid="$(cat "$MOCK_LISTENER_PID_FILE")"
        kill "$pid"
        while [[ -f "$MOCK_OPENCODE_RUNNING" ]] && (( attempts < 50 )); do
            sleep 0.1
            attempts=$((attempts + 1))
        done
        [[ ! -f "$MOCK_OPENCODE_RUNNING" ]]
    fi
}

start_server() {
    local executable
    local home
    local port
    executable="$("$MOCK_JQ_BIN" -r '.ProgramArguments[0]' "$MOCK_LOADED_PLIST")"
    home="$("$MOCK_JQ_BIN" -r '.WorkingDirectory' "$MOCK_LOADED_PLIST")"
    port="$("$MOCK_JQ_BIN" -r '.ProgramArguments[5]' "$MOCK_LOADED_PLIST")"
    (
        cd "$home"
        nohup "$executable" serve --hostname 127.0.0.1 --port "$port" \
            > "$MOCK_SERVICE_LOG" 2>&1 < /dev/null &
    )
}

if [[ "$1" == print ]]; then
    [[ -f "$MOCK_SERVICE_LOADED" ]]
    exit
fi
printf '%s\n' "$*" >> "$MOCK_LAUNCHCTL_LOG"
case "$1" in
    enable) ;;
    bootstrap)
        [[ ! -f "$MOCK_SERVICE_LOADED" ]]
        if "$MOCK_JQ_BIN" -e . "$3" >/dev/null 2>&1; then
            cp "$3" "$MOCK_LOADED_PLIST"
        else
            "$MOCK_REAL_PLUTIL" -convert json -o "$MOCK_LOADED_PLIST" "$3"
        fi
        touch "$MOCK_SERVICE_LOADED"
        start_server
        ;;
    bootout)
        stop_server
        rm -f "$MOCK_SERVICE_LOADED"
        ;;
    kickstart)
        [[ -f "$MOCK_SERVICE_LOADED" ]]
        if [[ "${2:-}" == -k ]]; then
            stop_server
        fi
        [[ -f "$MOCK_OPENCODE_RUNNING" ]] || start_server
        ;;
    *) printf 'unexpected launchctl invocation: %s\n' "$*" >&2; exit 1 ;;
esac
EOF

chmod +x "$MOCK_BIN/tailscale" "$MOCK_BIN/opencode" "$MOCK_BIN/curl" "$MOCK_BIN/lsof" \
    "$MOCK_BIN/plutil" "$MOCK_BIN/launchctl"

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
export OC_PLATFORM=Linux
export OC_LAUNCHCTL_BIN="$MOCK_BIN/launchctl"
export OC_PLUTIL_BIN="$MOCK_BIN/plutil"
export OC_LAUNCH_AGENTS_DIR="$TEST_TMPDIR/LaunchAgents"
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
export MOCK_SERVICE_LOADED="$STATE_DIR/service.loaded"
export MOCK_LOADED_PLIST="$STATE_DIR/service.plist"
export MOCK_LAUNCHCTL_LOG="$STATE_DIR/launchctl.log"
export MOCK_SERVICE_LOG="$STATE_DIR/service.log"

reset_state() {
    stop_mock_opencode
    rm -rf "$OC_STATE_DIR"
    rm -rf "$OC_LAUNCH_AGENTS_DIR"
    rm -f \
        "$MOCK_SERVE_STATUS_FILE" \
        "$MOCK_TAILSCALE_LOG" \
        "$MOCK_OPENCODE_ARGS" \
        "$MOCK_OPENCODE_CWD" \
        "$MOCK_OPENCODE_DATA_HOME" \
        "$MOCK_OPENCODE_STARTS" \
        "$MOCK_OPENCODE_RUNNING" \
        "$MOCK_LISTENER_PID_FILE" \
        "$MOCK_SERVICE_LOADED" \
        "$MOCK_LOADED_PLIST" \
        "$MOCK_LAUNCHCTL_LOG" \
        "$MOCK_SERVICE_LOG"
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

test_macos_installs_and_reuses_service() {
    local plist="$OC_LAUNCH_AGENTS_DIR/com.rodrigorm.opencode.4096.plist"
    local original="$STATE_DIR/original.plist"

    reset_state
    write_free_serve_status
    OC_PLATFORM=Darwin "$OC" > "$STATE_DIR/service-start.out" 2>&1

    [[ -f "$MOCK_SERVICE_LOADED" ]]
    # shellcheck disable=SC2016
    "$OC_JQ_BIN" -e --arg home "$HOME" --arg executable "$OC_OPENCODE_BIN" '
        .Label == "com.rodrigorm.opencode.4096" and
        .ProgramArguments == [$executable, "serve", "--hostname", "127.0.0.1", "--port", "4096"] and
        .RunAtLoad == true and .KeepAlive == true and .WorkingDirectory == $home and
        .EnvironmentVariables.HOME == $home
    ' "$plist" >/dev/null
    [[ ! -e "$OC_STATE_DIR/opencode.pid" ]]
    cp "$plist" "$original"
    : > "$MOCK_LAUNCHCTL_LOG"
    : > "$MOCK_TAILSCALE_LOG"

    OC_PLATFORM=Darwin "$OC" > "$STATE_DIR/service-reuse.out" 2>&1
    cmp -s "$original" "$plist"
    [[ ! -s "$MOCK_LAUNCHCTL_LOG" && ! -s "$MOCK_TAILSCALE_LOG" ]]
    [[ "$(wc -l < "$MOCK_OPENCODE_STARTS" | tr -d ' ')" == 1 ]]
}

test_macos_force_restarts_managed_service() {
    local old_pid
    local new_pid

    reset_state
    write_free_serve_status
    OC_PLATFORM=Darwin "$OC" > /dev/null 2>&1
    old_pid="$(cat "$MOCK_LISTENER_PID_FILE")"
    : > "$MOCK_LAUNCHCTL_LOG"

    OC_PLATFORM=Darwin "$OC" --force > "$STATE_DIR/service-force.out" 2>&1
    new_pid="$(cat "$MOCK_LISTENER_PID_FILE")"
    [[ "$new_pid" != "$old_pid" ]]
    wait_for_pid_to_exit "$old_pid"
    [[ "$(wc -l < "$MOCK_OPENCODE_STARTS" | tr -d ' ')" == 2 ]]
    grep -Fxq "bootout gui/$(id -u)/com.rodrigorm.opencode.4096" "$MOCK_LAUNCHCTL_LOG"
    [[ "$(wc -l < "$MOCK_LAUNCHCTL_LOG" | tr -d ' ')" == 3 ]]
}

test_macos_defers_unmanaged_server_until_force() {
    local old_pid

    reset_state
    write_free_serve_status
    "$OC" > /dev/null 2>&1
    old_pid="$(cat "$MOCK_LISTENER_PID_FILE")"

    OC_PLATFORM=Darwin "$OC" > "$STATE_DIR/service-deferred.out" 2>&1
    [[ -f "$OC_LAUNCH_AGENTS_DIR/com.rodrigorm.opencode.4096.plist" ]]
    assert_file_missing "$MOCK_SERVICE_LOADED"
    assert_file_missing "$MOCK_LAUNCHCTL_LOG"
    kill -0 "$old_pid"
    grep -Fq 'take over at next login' "$STATE_DIR/service-deferred.out"

    OC_PLATFORM=Darwin "$OC" --force > "$STATE_DIR/service-migrate.out" 2>&1
    [[ -f "$MOCK_SERVICE_LOADED" ]]
    wait_for_pid_to_exit "$old_pid"
    [[ "$(wc -l < "$MOCK_OPENCODE_STARTS" | tr -d ' ')" == 2 ]]
    assert_file_missing "$OC_STATE_DIR/opencode.pid"
}

test_macos_applies_deferred_configuration_on_force() {
    local data_home="$TEST_TMPDIR/data & <custom>"
    local old_pid

    reset_state
    write_free_serve_status
    OC_PLATFORM=Darwin "$OC" > /dev/null 2>&1
    old_pid="$(cat "$MOCK_LISTENER_PID_FILE")"
    : > "$MOCK_LAUNCHCTL_LOG"

    OC_PLATFORM=Darwin XDG_DATA_HOME="$data_home" "$OC" > "$STATE_DIR/service-update.out" 2>&1
    [[ ! -s "$MOCK_LAUNCHCTL_LOG" ]]
    [[ "$(cat "$MOCK_LISTENER_PID_FILE")" == "$old_pid" ]]
    grep -Fq 'Updated service settings apply' "$STATE_DIR/service-update.out"

    OC_PLATFORM=Darwin XDG_DATA_HOME="$data_home" "$OC" --force > "$STATE_DIR/service-reload.out" 2>&1
    grep -Fxq "bootout gui/$(id -u)/com.rodrigorm.opencode.4096" "$MOCK_LAUNCHCTL_LOG"
    # shellcheck disable=SC2016
    "$OC_JQ_BIN" -e --arg data "$data_home" '.EnvironmentVariables.XDG_DATA_HOME == $data' \
        "$MOCK_LOADED_PLIST" >/dev/null
    wait_for_pid_to_exit "$old_pid"
}

test_macos_starts_previously_installed_agent() {
    reset_state
    write_free_serve_status
    OC_PLATFORM=Darwin "$OC" > /dev/null 2>&1
    stop_mock_opencode
    rm -f "$MOCK_SERVICE_LOADED"
    : > "$MOCK_LAUNCHCTL_LOG"

    OC_PLATFORM=Darwin "$OC" > "$STATE_DIR/service-load.out" 2>&1
    [[ -f "$MOCK_SERVICE_LOADED" && -f "$MOCK_OPENCODE_RUNNING" ]]
    grep -Fq 'bootstrap' "$MOCK_LAUNCHCTL_LOG"
}

test_macos_preserves_environment_and_custom_port() {
    local data_home="$TEST_TMPDIR/data & <custom>"
    local plist="$OC_LAUNCH_AGENTS_DIR/com.rodrigorm.opencode.4097.plist"

    reset_state
    write_free_serve_status
    OC_PLATFORM=Darwin PORT=04097 XDG_DATA_HOME="$data_home" OPENCODE_SERVER_PASSWORD='test & <password>' \
        "$OC" > "$STATE_DIR/service-custom.out" 2>&1
    # shellcheck disable=SC2016
    "$OC_JQ_BIN" -e --arg data "$data_home" '
        .ProgramArguments[5] == "4097" and
        .EnvironmentVariables.XDG_DATA_HOME == $data and
        .EnvironmentVariables.OPENCODE_SERVER_PASSWORD == "test & <password>" and
        .EnvironmentVariables.MOCK_OPENCODE_RUNNING == null
    ' "$plist" >/dev/null
    [[ ! -e "$OC_LAUNCH_AGENTS_DIR/com.rodrigorm.opencode.04097.plist" ]]
}

test_macos_conflicts_do_not_install_service() {
    reset_state
    write_conflicting_serve_status
    if OC_PLATFORM=Darwin "$OC" --force > "$STATE_DIR/service-conflict.out" 2>&1; then
        return 1
    fi
    [[ ! -d "$OC_LAUNCH_AGENTS_DIR" ]]
    assert_file_missing "$MOCK_LAUNCHCTL_LOG"

    reset_state
    write_free_serve_status
    export MOCK_OTHER_LISTENER=true
    if OC_PLATFORM=Darwin "$OC" --force > "$STATE_DIR/service-port-conflict.out" 2>&1; then
        return 1
    fi
    [[ ! -d "$OC_LAUNCH_AGENTS_DIR" ]]
    assert_file_missing "$MOCK_LAUNCHCTL_LOG"
}

test_macos_native_plist_serialization() {
    local plist="$OC_LAUNCH_AGENTS_DIR/com.rodrigorm.opencode.4096.plist"
    local data_home="$TEST_TMPDIR/data & <custom>"

    [[ "$(uname -s)" == Darwin ]] || return 0
    reset_state
    write_free_serve_status
    MOCK_REAL_PLUTIL=/usr/bin/plutil OC_PLUTIL_BIN=/usr/bin/plutil OC_PLATFORM=Darwin \
        XDG_DATA_HOME="$data_home" OPENCODE_SERVER_PASSWORD='test & <password>' \
        "$OC" > "$STATE_DIR/service-native.out" 2>&1

    /usr/bin/plutil -lint "$plist" >/dev/null
    [[ "$(stat -f '%Lp' "$plist")" == 600 ]]
    # shellcheck disable=SC2016
    "$OC_JQ_BIN" -e --arg data "$data_home" '
        .EnvironmentVariables.XDG_DATA_HOME == $data and
        .EnvironmentVariables.OPENCODE_SERVER_PASSWORD == "test & <password>"
    ' "$MOCK_LOADED_PLIST" >/dev/null
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
test_macos_installs_and_reuses_service
test_macos_force_restarts_managed_service
test_macos_defers_unmanaged_server_until_force
test_macos_applies_deferred_configuration_on_force
test_macos_starts_previously_installed_agent
test_macos_preserves_environment_and_custom_port
test_macos_conflicts_do_not_install_service
test_macos_native_plist_serialization

printf 'oc tests passed\n'
