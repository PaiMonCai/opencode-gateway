#!/usr/bin/env bash
#
# End-to-end integration test: build the image, run one container, and check the
# HTTP contract from the outside — health, models, a chat completion, the
# operational endpoints (including their auth gating) and the internal-tool
# counters the gateway exposes for each tool mode.
#
# Entry point:  npm run test:integration
# Exit codes:   0 all checks passed
#               1 a check failed (or the container never became healthy)
#               2 a prerequisite is missing (no docker / no daemon / no curl)
#
# Useful overrides (environment):
#   TEST_PORT=14096        host port to publish and query
#   TEST_API_KEY=test-key  bearer key handed to the container and used by curl
#   IMAGE_TAG=...          image tag to build (default opencode-gateway:integration)
#   KEEP_CONTAINER=1       leave the container behind for inspection
#   SKIP_MODEL_TESTS=1     skip the checks that call a real upstream model
#   MANAGE_BACKEND=false   run the container without a managed OpenCode backend
#   PROBE_VIA=exec         send the HTTP probes from inside the container with
#                          `docker exec` instead of the published host port. Use
#                          it with rootless/remote daemons, or in CI where the
#                          published port is not reachable from the job.
#
# Written for bash, but kept parseable by a plain POSIX shell (`sh -n`).

set -euo pipefail

readonly EXIT_FAIL=1
readonly EXIT_PREREQ=2
readonly CONTAINER_PORT=10000

TEST_PORT="${TEST_PORT:-14096}"
TEST_API_KEY="${TEST_API_KEY:-test-key}"
IMAGE_TAG="${IMAGE_TAG:-opencode-gateway:integration}"
CONTAINER_NAME="${CONTAINER_NAME:-opencode-gateway-it-${TEST_PORT}}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-90}"
HTTP_TIMEOUT_S="${HTTP_TIMEOUT_S:-30}"
KEEP_CONTAINER="${KEEP_CONTAINER:-0}"
SKIP_MODEL_TESTS="${SKIP_MODEL_TESTS:-0}"
MANAGE_BACKEND="${MANAGE_BACKEND:-true}"
PROBE_VIA="${PROBE_VIA:-host}"

MODEL_ID=""
PASSED=0

log() {
    printf '==> %s\n' "$*"
}

note() {
    printf '    %s\n' "$*"
}

fail() {
    printf '!!! %s\n' "$*" >&2
    exit "${EXIT_FAIL}"
}

skip() {
    printf '%s\n' "--- skipped: $*"
}

ok() {
    PASSED=$((PASSED + 1))
    printf '%s\n' "--- ok: $*"
}

on_exit() {
    status=$?
    if [ "${KEEP_CONTAINER}" != "1" ]; then
        docker rm --force "${CONTAINER_NAME}" >/dev/null 2>&1 || true
    else
        note "container ${CONTAINER_NAME} kept (KEEP_CONTAINER=1)"
    fi
    exit "${status}"
}
trap on_exit EXIT

require_prerequisites() {
    command -v docker >/dev/null 2>&1 ||
        { printf '!!! docker CLI not found: this test builds and runs a container.\n' >&2; exit "${EXIT_PREREQ}"; }

    if ! docker info >/dev/null 2>&1; then
        printf '!!! Docker daemon not reachable.\n' >&2
        printf '    Start Docker (or set DOCKER_HOST) and re-run; nothing was tested.\n' >&2
        exit "${EXIT_PREREQ}"
    fi

    command -v curl >/dev/null 2>&1 ||
        { printf '!!! curl not found: this test drives the container over HTTP.\n' >&2; exit "${EXIT_PREREQ}"; }

    command -v node >/dev/null 2>&1 ||
        { printf '!!! node not found: this test parses JSON responses with it.\n' >&2; exit "${EXIT_PREREQ}"; }

    case "${PROBE_VIA}" in
        host | exec) ;;
        *) printf "!!! PROBE_VIA must be 'host' or 'exec', got '%s'.\n" "${PROBE_VIA}" >&2; exit "${EXIT_PREREQ}" ;;
    esac
}

# http <path> [curl options...]
#
# Sends one request with curl and prints the body: through the published host
# port by default, or from inside the container with `docker exec` when
# PROBE_VIA=exec. The curl exit code (and therefore `--fail`) is preserved.
http() {
    path="$1"
    shift

    if [ "${PROBE_VIA}" = "exec" ]; then
        docker exec "${CONTAINER_NAME}" \
            curl --silent --show-error --max-time "${HTTP_TIMEOUT_S}" \
            "$@" "http://127.0.0.1:${CONTAINER_PORT}${path}"
    else
        curl --silent --show-error --max-time "${HTTP_TIMEOUT_S}" \
            "$@" "http://127.0.0.1:${TEST_PORT}${path}"
    fi
}

# authenticated request that does not fail the whole script on a non-2xx status
auth_http() {
    path="$1"
    shift
    http "$path" -H "Authorization: Bearer ${TEST_API_KEY}" "$@"
}

# read one dotted path out of a JSON document on stdin
json_get() {
    node -e '
        const path = process.argv[1].split(".");
        let value = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
        for (const key of path) value = value?.[key];
        process.stdout.write(value === undefined || value === null ? "" : String(value));
    ' "$1"
}

start_container() {
    docker rm --force "${CONTAINER_NAME}" >/dev/null 2>&1 || true

    docker run --detach --name "${CONTAINER_NAME}" \
        --publish "${TEST_PORT}:${CONTAINER_PORT}" \
        --env API_KEY="${TEST_API_KEY}" \
        --env OPENCODE_PROXY_MANAGE_BACKEND="${MANAGE_BACKEND}" \
        --env OPENCODE_INTERNAL_ALLOWED_TOOLS="web_fetch,filesystem" \
        --env OPENCODE_TOOL_DISCOVERY_FIXTURE="web_fetch,filesystem,bash" \
        --env OPENCODE_HEALTH_DETAILS_ENABLED=true \
        --env OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH=true \
        --env OPENCODE_METRICS_ENABLED=true \
        --env OPENCODE_METRICS_REQUIRE_AUTH=true \
        "${IMAGE_TAG}" >/dev/null
}

wait_for_health() {
    waited=0

    while [ "${waited}" -lt "${HEALTH_TIMEOUT_S}" ]; do
        if http /health --fail >/dev/null 2>&1; then
            return 0
        fi
        if [ "$(docker inspect --format '{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null)" != "true" ]; then
            docker logs "${CONTAINER_NAME}" || true
            fail "container exited before becoming healthy"
        fi
        sleep 1
        waited=$((waited + 1))
    done

    docker logs "${CONTAINER_NAME}" || true
    fail "no /health answer after ${HEALTH_TIMEOUT_S}s (probe: ${PROBE_VIA})"
}

check_health() {
    body="$(http /health --fail)" || fail "GET /health failed"

    status="$(printf '%s' "${body}" | json_get status)"
    [ "${status}" = "ok" ] || fail "GET /health body was ${body}"
    ok "GET /health"
}

check_models() {
    body="$(auth_http /v1/models --fail)" || fail "GET /v1/models failed"

    printf '%s' "${body}" | grep -q "opencode" ||
        fail "GET /v1/models listed no opencode model: ${body}"
    ok "GET /v1/models"

    MODEL_ID="$(printf '%s' "${body}" | json_get data.0.id)"
    [ -n "${MODEL_ID}" ] || fail "GET /v1/models returned an empty model list"
    note "using model ${MODEL_ID}"
}

check_chat_completion() {
    body="$(auth_http /v1/chat/completions --fail \
        --header 'Content-Type: application/json' \
        --data "{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}")" ||
        fail "POST /v1/chat/completions failed"

    printf '%s' "${body}" | grep -q '"chat.completion"' ||
        fail "unexpected chat completion body: ${body}"
    ok "POST /v1/chat/completions (non-streaming)"
}

check_operational_auth() {
    auth_http /health/details --fail >/dev/null || fail "authorized GET /health/details failed"
    ok "GET /health/details with a valid key"

    metrics="$(auth_http /metrics --fail)" || fail "authorized GET /metrics failed"
    printf '%s' "${metrics}" | grep -q "opencode_internal_tool_mode_requests_total" ||
        fail "/metrics did not expose the internal tool counters"
    ok "GET /metrics with a valid key"

    if http /health/details --fail >/dev/null 2>&1; then
        fail "/health/details answered without a key although OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH=true"
    fi
    ok "GET /health/details rejects a missing key"

    if http /metrics --fail >/dev/null 2>&1; then
        fail "/metrics answered without a key although OPENCODE_METRICS_REQUIRE_AUTH=true"
    fi
    ok "GET /metrics rejects a missing key"
}

# POST one chat request with the given JSON body; the answer itself is not checked.
post_chat() {
    auth_http /v1/chat/completions --fail \
        --header 'Content-Type: application/json' \
        --data "$1" >/dev/null
}

read_metric() {
    auth_http /health/details --fail | json_get "internal_tools.metrics.$1"
}

expect_metric_at_least() {
    name="$1"
    minimum="$2"
    actual="$(read_metric "${name}")"

    [ -n "${actual}" ] || fail "/health/details did not report internal_tools.metrics.${name}"
    [ "${actual}" -ge "${minimum}" ] ||
        fail "${name} = ${actual}, expected at least ${minimum} (a request did not take the expected tool mode)"
}

check_tool_modes() {
    log "tool mode routing (allowlist, bridge, partial, disabled)"

    post_chat "{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"use a built-in tool\"}]}"
    expect_metric_at_least internalAllowlistRequests 1
    ok "no tools -> internal allowlist mode"

    post_chat "{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"use an external tool\"}],\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"probe_tool\",\"description\":\"probe\",\"parameters\":{\"type\":\"object\",\"properties\":{}}}}]}"
    expect_metric_at_least externalBridgeRequests 1
    ok "client tools -> external bridge mode"

    post_chat "{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"partial overlap\"}],\"opencode\":{\"internal_allowed_tools\":[\"filesystem\",\"not_configured\"]}}"
    expect_metric_at_least internalAllowlistRequests 2
    ok "request-scoped allowlist narrows the server list"

    post_chat "{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"no overlap\"}],\"opencode\":{\"internal_allowed_tools\":[\"not_configured\"]}}"
    expect_metric_at_least disabledRequests 1
    ok "no overlap -> tools disabled for the request"
}

main() {
    log "integration test: image ${IMAGE_TAG}, container ${CONTAINER_NAME}, port ${TEST_PORT}, probes via ${PROBE_VIA}"
    require_prerequisites

    log "building the image"
    # shellcheck disable=SC2086  # DOCKER_BUILD_ARGS is intentionally word-split
    docker build --tag "${IMAGE_TAG}" ${DOCKER_BUILD_ARGS:-} . || fail "docker build failed"

    log "starting the container"
    start_container
    log "waiting for /health (up to ${HEALTH_TIMEOUT_S}s)"
    wait_for_health

    check_health
    check_operational_auth

    if [ "${SKIP_MODEL_TESTS}" = "1" ]; then
        skip "model-dependent checks (SKIP_MODEL_TESTS=1): /v1/models, chat completion, tool modes"
    else
        check_models
        check_chat_completion
        check_tool_modes
    fi

    printf '\n==> integration test passed (%d checks)\n' "${PASSED}"
}

main "$@"
