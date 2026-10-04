#!/usr/bin/env bash
#
# Manual streaming smoke test against a live gateway (and therefore a live
# OpenCode backend). Deliberately not part of CI: it needs real models and a
# reachable upstream, so it answers "does streaming still work end to end?"
# after a deployment or a provider change.
#
#   BASE_URL=http://127.0.0.1:10000 API_KEY=your-key npm run test:stream
#
# Exit codes:  0 every check passed
#              1 a check failed
#              2 the gateway could not be reached (nothing was tested)
#
# Overrides: BASE_URL, API_KEY, MODEL, REQUEST_TIMEOUT_S, CHECK_TOOLS=1.

set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:10000}"
API_KEY="${API_KEY:-test-key}"
MODEL="${MODEL:-opencode/kimi-k2.5}"
REQUEST_TIMEOUT_S="${REQUEST_TIMEOUT_S:-180}"
CHECK_TOOLS="${CHECK_TOOLS:-0}"

PASSED=0
FAILED=0

log() {
    printf '\n== %s\n' "$*"
}

pass() {
    PASSED=$((PASSED + 1))
    printf '   ok    %s\n' "$*"
}

fail() {
    FAILED=$((FAILED + 1))
    printf '   FAIL  %s\n' "$*" >&2
}

die() {
    printf '!!! %s\n' "$*" >&2
    exit 1
}

# A 200 is not required: an upstream error is still a useful, readable answer.
chat() {
    local payload="$1"
    shift

    curl --silent --show-error --no-buffer --max-time "${REQUEST_TIMEOUT_S}" \
        --request POST \
        --header 'Content-Type: application/json' \
        --header "Authorization: Bearer ${API_KEY}" \
        --data "${payload}" \
        "$@" \
        "${BASE_URL}/v1/chat/completions"
}

contains() {
    local haystack="$1" needle="$2" label="$3"

    if printf '%s' "${haystack}" | grep -qF -- "${needle}"; then
        pass "${label}"
    else
        fail "${label} (missing '${needle}')"
    fi
}

require_gateway() {
    command -v curl >/dev/null 2>&1 || { printf '!!! curl is required.\n' >&2; exit 2; }

    if ! curl --silent --fail --max-time 10 "${BASE_URL}/health" >/dev/null; then
        printf '!!! no gateway answering on %s/health\n' "${BASE_URL}" >&2
        printf '    Start the gateway (docker compose up -d) or fix BASE_URL, then retry.\n' >&2
        exit 2
    fi
}

check_streaming_text() {
    local response

    log "streaming chat completion (model ${MODEL})"
    response="$(chat "{
        \"model\": \"${MODEL}\",
        \"messages\": [{\"role\": \"user\", \"content\": \"Reply with exactly three words.\"}],
        \"stream\": true
    }")" || die "the streaming request failed before answering"

    contains "${response}" '"object":"chat.completion.chunk"' "SSE chunk with an OpenAI object"
    contains "${response}" 'data: [DONE]' "stream terminated with [DONE]"
    contains "${response}" '"delta"' "at least one delta was emitted"
}

check_non_streaming() {
    local response

    log "non-streaming chat completion"
    response="$(chat "{
        \"model\": \"${MODEL}\",
        \"messages\": [{\"role\": \"user\", \"content\": \"Say hello.\"}],
        \"stream\": false
    }")" || die "the non-streaming request failed before answering"

    contains "${response}" '"choices"' "answer carries a choices array"
    contains "${response}" '"usage"' "answer carries token usage"
    contains "${response}" "\"model\":\"${MODEL}\"" "the client-facing model name is echoed back"
}

check_streaming_tool_call() {
    local response

    log "streaming tool call (CHECK_TOOLS=1)"
    response="$(chat "{
        \"model\": \"${MODEL}\",
        \"messages\": [{\"role\": \"user\", \"content\": \"Call probe_tool with value 1. Do not answer directly.\"}],
        \"stream\": true,
        \"tools\": [{
            \"type\": \"function\",
            \"function\": {
                \"name\": \"probe_tool\",
                \"description\": \"probe\",
                \"parameters\": {\"type\": \"object\", \"properties\": {\"value\": {\"type\": \"number\"}}}
            }
        }]
    }")" || die "the streaming tool request failed before answering"

    contains "${response}" '"tool_calls"' "tool_calls delta is streamed"
    contains "${response}" 'data: [DONE]' "tool stream terminated with [DONE]"
}

main() {
    require_gateway

    check_streaming_text
    check_non_streaming
    if [ "${CHECK_TOOLS}" = "1" ]; then
        check_streaming_tool_call
    fi

    printf '\n== %d checks passed, %d failed (base URL %s)\n' "${PASSED}" "${FAILED}" "${BASE_URL}"
    [ "${FAILED}" -eq 0 ] || exit 1
}

main "$@"
