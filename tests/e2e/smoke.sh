#!/usr/bin/env bash
# Real-runtime smoke test (optional; not part of CI).
#
# Starts the gateway with the SDK-driven runtime path, waits for /health, then
# exercises a non-streaming and a streaming chat completion plus a Responses
# call. It needs a real `opencode` binary and a reachable runtime, so it is run
# manually, never by `npm test`.
#
# Usage:
#   OPENCODE_PATH=/path/to/opencode bash tests/e2e/smoke.sh
#
# Environment:
#   OPENCODE_PATH        OpenCode CLI (defaults to PATH lookup)
#   E2E_MODEL            Model to call (default: opencode/kimi-k2.5-free)
#   E2E_PORT             Gateway port (default: a random free-ish high port)
#   E2E_TIMEOUT_SECONDS  Overall timeout (default: 120)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${E2E_PORT:-$((20000 + RANDOM % 10000))}"
BACKEND_PORT="${E2E_BACKEND_PORT:-$((PORT + 1))}"
MODEL="${E2E_MODEL:-opencode/kimi-k2.5-free}"
API_KEY="${E2E_API_KEY:-e2e-key}"
TIMEOUT="${E2E_TIMEOUT_SECONDS:-120}"
BASE="http://127.0.0.1:${PORT}"
LOG="$(mktemp -t opencode-gateway-e2e.XXXXXX.log)"
FAILURES=0

fail() { echo "FAIL: $*"; FAILURES=$((FAILURES + 1)); }
pass() { echo "ok: $*"; }

cleanup() {
    if [[ -n "${GATEWAY_PID:-}" ]] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
        kill "$GATEWAY_PID" 2>/dev/null || true
        wait "$GATEWAY_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

echo "e2e: starting gateway on ${BASE} (log: ${LOG})"
API_KEY="$API_KEY" \
OPENCODE_PATH="${OPENCODE_PATH:-opencode}" \
OPENCODE_PROXY_PORT="$PORT" \
OPENCODE_SERVER_PORT="$BACKEND_PORT" \
OPENCODE_PROXY_MANAGE_BACKEND=true \
node "$ROOT/index.js" >"$LOG" 2>&1 &
GATEWAY_PID=$!

deadline=$((SECONDS + TIMEOUT))
until curl -fsS --noproxy '*' -m 2 "${BASE}/health" >/dev/null 2>&1; do
    if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
        echo "FAIL: gateway exited during startup"; tail -40 "$LOG"; exit 1
    fi
    if (( SECONDS > deadline )); then
        echo "FAIL: gateway did not become healthy in ${TIMEOUT}s"; tail -40 "$LOG"; exit 1
    fi
    sleep 1
done
pass "gateway healthy"

health_body="$(curl -fsS --noproxy '*' "${BASE}/health")"
[[ "$health_body" == *'"status":"ok"'* ]] && pass "GET /health -> ${health_body}" || fail "GET /health -> ${health_body}"

if curl -fsS --noproxy '*' -m 10 -H "Authorization: Bearer ${API_KEY}" "${BASE}/v1/models" | grep -q '"object":"list"'; then
    pass "GET /v1/models -> list"
else
    fail "GET /v1/models did not answer a list"
fi

chat_payload=$(cat <<JSON
{"model":"${MODEL}","messages":[{"role":"user","content":"Reply with the single word: pong"}],"stream":false}
JSON
)
chat_body="$(curl -fsS --noproxy '*' -m "$TIMEOUT" -H "Authorization: Bearer ${API_KEY}" -H 'Content-Type: application/json' \
    -d "$chat_payload" "${BASE}/v1/chat/completions")"
[[ "$chat_body" == *'"object":"chat.completion"'* ]] && pass "POST /v1/chat/completions (non-stream)" || fail "chat body: ${chat_body:0:200}"

stream_body="$(curl -fsS --noproxy '*' -N -m "$TIMEOUT" -H "Authorization: Bearer ${API_KEY}" -H 'Content-Type: application/json' \
    -d "${chat_payload/\"stream\":false/\"stream\":true}" "${BASE}/v1/chat/completions")"
[[ "$stream_body" == *'data: [DONE]'* ]] && pass "POST /v1/chat/completions (stream) ended with [DONE]" || fail "stream missing [DONE]"

responses_body="$(curl -fsS --noproxy '*' -m "$TIMEOUT" -H "Authorization: Bearer ${API_KEY}" -H 'Content-Type: application/json' \
    -d "{\"model\":\"${MODEL}\",\"input\":\"Reply with the single word: pong\"}" "${BASE}/v1/responses")"
[[ "$responses_body" == *'"object":"response"'* ]] && pass "POST /v1/responses" || fail "responses body: ${responses_body:0:200}"

# A clean SIGTERM must shut the process down.
kill -TERM "$GATEWAY_PID" 2>/dev/null || true
for _ in $(seq 1 20); do
    kill -0 "$GATEWAY_PID" 2>/dev/null || break
    sleep 0.5
done
if kill -0 "$GATEWAY_PID" 2>/dev/null; then
    fail "gateway did not exit after SIGTERM"
else
    pass "SIGTERM shut the gateway down"
fi

if (( FAILURES > 0 )); then
    echo "e2e: ${FAILURES} check(s) failed"
    exit 1
fi
echo "e2e: all checks passed"
