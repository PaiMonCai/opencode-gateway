# Rewrite verification (T5)

Independent verification of the assembled rewrite against
`docs/{zh,en}/api-reference.md` (highest authority), `docs/BEHAVIOUR-SPEC.md`
and `docs/ARCHITECTURE.md` §2. Written by the verification role, which never
modified `src/**`: every defect below is reported with a reproduction, not a fix.

- **Verdict**: the assembled gateway matches the published contract on every
  item that could be exercised offline. Ten contract deviations were found: nine
  were fixed in code (`FINDING-1..4,6,7,8,9,11` — every probe asserts the fixed
  behaviour and no `test.failing` wrapper remains), `FINDING-5` was ruled
  intentional and is now asserted as behaviour, and one pre-existing throughput
  limit (`FINDING-10`) was ruled a documented behaviour.
- **Gates**: `npm run typecheck` 0 errors · `npm run lint` clean ·
  `npm run format:check` clean · `npm test` 625 · `npm run test:contract` 132 ·
  `npm run test:verify` 244 (23 suites).
- **Environment**: no OpenCode runtime and no `opencode` CLI in this sandbox
  (§8), so no real turn was executed end to end; the real *direct* upstream was
  reachable and **was** exercised (§7).

## 1. What was verified and how

Two independent suites live under `tests/verification/` (write scope of the
verification role):

| Suite | Files | Cases | What it pins |
|:--|:--|:--|:--|
| `tests/verification/modules/**` | 14 | 126 | Conversation identity/store/planner/baseline and the upstream clients **in isolation**, against ARCHITECTURE §2's 8 invariants and the routing matrix |
| `tests/verification/contract/**` | 9 | 118 | The **assembled app** over real HTTP (`BEHAVIOUR-SPEC` §1–§8), endpoints, SSE streams, error semantics, tool bridge, plugin policy |
| `tests/verification/smoke/*.mjs` | 2 | — | Real upstream direct smoke and the real-runtime environment check (not part of CI) |

Method and independence:

- the harness (`tests/verification/contract/harness.js`) builds the app with the
  **production assembly function** `buildRuntime()` from `src/bootstrap.js` —
  the same graph `index.js` uses — so a wiring mistake cannot hide behind a
  hand-built app. Only two dependencies are replaced: the SDK client (a
  stateful fake runtime that keeps per-session messages) and the direct upstream
  base URLs (a stub HTTP server on port 0);
- fixtures are written from scratch (`tests/verification/modules/fixtures.js`,
  `contract/harness.js`) and never import `tests/unit/**/helpers.js`; the
  authors' assertions are not reused;
- no test needs the network, a fixed port or a real runtime: `npm run test:verify`
  is offline and repeatable (three consecutive clean runs were observed during
  the pass);
- convention used for defects: the suite asserts the **expected** behaviour; a
  defect that was not fixed yet is wrapped in `test.failing(...)` so it stays
  green while the defect is present and turns red the moment it is fixed. As of
  commit `9a0a21a` **no `test.failing` wrapper remains**: every finding was fixed
  and its probe flipped to assert the fixed behaviour.

## 2. Gates

| Command | Result |
|:--|:--|
| `npm run typecheck` | 0 errors |
| `npm run lint` | clean |
| `npm run format:check` | clean |
| `npm test` (unit) | 26 suites / 625 tests passed |
| `npm run test:contract` | 6 suites / 132 tests passed |
| `npm run test:verify` | 23 suites / 244 tests passed |
| `npm run test:all` | all three phases, exit 0 |

`npm run test:verify` must run under `NODE_OPTIONS=--experimental-vm-modules`
(the repository scripts already set it); a bare `npx jest` cannot run any ESM
suite in this repository, which is pre-existing and not a defect of the rewrite.

## 3. BEHAVIOUR-SPEC coverage

### §1 Endpoints and auth — verified

| Item | Evidence |
|:--|:--|
| `GET /health` → `{"status":"ok","proxy":true}`, always 200, no auth | `http-edge.test.js › GET /health is always 200 …`; `… /health stays 200 while the runtime is broken` |
| Unknown route → `{"error":{"message":"Route not found: GET /nope","type":"not_found_error"}}` (no `code`) | `http-edge.test.js › an unknown route answers the informative 404 shape` |
| Malformed JSON → 400 `Invalid JSON in request body` (full envelope) | `… malformed JSON answers 400 …`; `ops-config.test.js › a malformed-JSON error keeps the envelope` |
| Oversized body → 400 `Request body too large`; limit is 50 MB | `… the JSON body limit is the documented 50 MB` (a real 51 MB body) |
| Auth failure → 401 `{message,invalid_request_error,invalid_api_key}`; off when `API_KEY` unset | `… auth: missing or wrong bearer key …`; `… auth is off when API_KEY is unset` |
| CORS: any origin, GET/POST/OPTIONS, `Authorization` + every conversation header | `… CORS allows the configured conversation headers …` |
| `GET /v1/models`: runtime catalog → upstream catalogs → one fallback model | `… GET /v1/models lists the runtime catalog …`; `ops-config.test.js › a single fallback model …`; `… the upstream catalog is used when only the runtime catalog is gone` |
| Conversation headers: 11 spellings, first non-empty wins, `x-opencode-session` first | `modules/invariants.identity-headers.test.js` (independent of the authors' identity suite) |

### §2 Chat Completions — verified

- Request fields: honoured fields reach the upstream (`chat-completions.test.js ›
  the documented body shape`, `… the request body passes through …`); the
  silently-ignored set and the `opencode` extension never reach the prompt
  (`… ignored fields and the opencode extension never reach the upstream prompt`,
  checked with marker strings).
- Validation before any session: `messages array is required`, and
  `messages must include at least one non-system text message` (asserted with
  `fake.calls.created` empty).
- Non-streaming shape: `id chatcmpl-…`, `object`, `created`, `model` as
  requested, `choices[0].message`, `finish_reason`; `usage` incl.
  `completion_tokens_details.reasoning_tokens`; `reasoning_content` only when
  the model produced reasoning.
- Token estimates: `prompt_tokens === ceil(renderedChars/4)` and, on a reused
  conversation, it covers the **whole** conversation while only the appended
  turn is sent (`… a reused conversation reports prompt_tokens over the whole
  conversation`).
- Streaming: chunk envelope, `delta.content`, `delta.reasoning_content` before
  the answer, final chunk with `finish_reason` + `usage`, `[DONE]`, stable id
  and model, keep-alive comments preserved.
- Tools: text-contract call → public `tool_calls` with
  `call_external__<tool>_<n>` id and the client's tool name; no external tools →
  markup stripped and no `tool_calls`; echoed call ids preserved.

### §3 Responses API — verified

- Input forms: string, `prompt`, `messages`, item array; `input` missing/empty →
  400 `input is required` (the empty-string case was a defect, see `FINDING-7`).
- Non-streaming shape incl. `output`, `usage` details, reasoning omitted when
  absent, and **empty answer text → empty `output` array** (defect
  `FINDING-8`, now asserted fixed).
- Streaming: `response.created` … `response.completed` in the documented order,
  strictly increasing `sequence_number`, reasoning events, function-call events
  (`response.function_call_arguments.delta/.done`, `output_item.done`), `[DONE]`.
- Failure after headers: `response.failed` followed by `[DONE]`, never a second
  JSON body.
- `previous_response_id`: known id continues the same upstream session; unknown
  id → 400 `Invalid or expired previous_response_id`; in direct mode the id is
  forwarded untouched; the chain TTL is 30 minutes (unit-level, clock-injected).
- `reasoning_effort` mapping `minimal→none, low, medium, high, xhigh→high`.

### §4 Tool bridge — verified

- Client tools are exposed as a text contract with `external__<name>` and the
  contract **reminder** is appended as the last prompt part (this is also the
  independent re-check of the reminder regression, §6).
- Accepted output formats all parse into public tool calls: canonical
  container (single and array), DSML `|<…>|invoke` markup, and
  `<function=name><parameter=key>` markup.
- Call ids and names: `call_external__weather_<n>` with `function.name` the
  client's tool name (no internal name leak).
- Replayed history renders `ASSISTANT: <function_calls>…` and
  `TOOL_RESULT: {…}` lines with the namespaced tool name.
- `tool_choice: "required"` (and a forced function) answered with prose triggers
  exactly one forced follow-up asking for `<function_calls>` only.
- Plugin policy (`plugin/opencode-gateway-tool-lock.js`, verified directly with a
  fake SDK client): the title format the proxy writes is the format the plugin
  reads; `*` allows, `none` denies with the documented text (tool name +
  “disabled”), allowlists match by name and namespace suffix, missing/unreadable
  policies deny everything, child sessions inherit the parent policy, and native
  `external__*` calls are steered back to the text contract with the
  `<function_calls>` instruction.

### §5 Upstream routing — verified

| Condition | Result | Evidence |
|:--|:--|:--|
| no upstream key | runtime, no HTTP to the direct upstream | `upstream-routing.test.js › with no upstream key …` |
| `opencode-go/*` | direct `…/zen/go/v1`, official fingerprint headers, `ses_…` session label | `… opencode-go goes direct to the Go endpoint …` |
| paid `opencode/*` | direct `…/zen/v1`, bare model id upstream, client name restored | `… paid opencode goes direct to the Zen endpoint` |
| `*-free` (case-insensitive) | runtime | `… a -free model stays on the runtime …` |
| `DIRECT_ENABLED=false` / `DIRECT_FREE_VIA_RUNTIME=false` | runtime / direct `-free` | `… DIRECT_ENABLED=false …`, `… DIRECT_FREE_VIA_RUNTIME=false …` |
| `403 FreeTierError` | runtime fallback for that turn, learned (next turn skips the direct upstream) | `… a 403 FreeTierError falls back …`; TTL boundary in `modules/upstreams.matrix.test.js` |
| transport failure | runtime fallback | `… a transport failure falls back …` |
| other upstream errors (401/402/429/500) | status, body and content-type relayed verbatim, no taxonomy rewrite | `… a plain direct 402/429/500 is relayed verbatim …`, `… 401/403 are relayed verbatim when DIRECT_FALLBACK_TO_RUNTIME=false`, `… a direct Responses error body is relayed byte-for-byte` |
| body/stream passthrough | extra fields preserved, `opencode` extension stripped, SSE framing preserved and model rewritten | `… the request body passes through …`, `… a relayed SSE stream …` |

### §6 Errors — verified

`504 timeout` · `402 insufficient_quota` · `429 rate_limit_exceeded` ·
`400/404` envelopes · `503 conversation_busy` (verified on `/v1/responses`) ·
`503 session_state_unavailable` (chat and responses) · `response.failed` on a
post-header failure. Deviations found and fixed: `FINDING-11` (500 body leaked the
internal error class) and `FINDING-9` (responses 503 rewritten to 502). See §9.
`docs/BEHAVIOUR-SPEC.md` §6's 500 row was aligned with the api-reference wording
(`server_error` / `internal_error`) in the same fix.

### §7 Operational surfaces — verified

`/health/details` (404 while disabled, plain-text 401 with auth, documented
`internal_tools` keys with `metrics` null when disabled) · `/metrics` (404/401,
content type, all six metric names) · startup banner (`printBanner`, the same
function `index.js` calls): documented fields present, secrets never printed
(only `Configured|Not configured`), and the effective event-timeout defaults
`8000ms`/`30000ms` reported instead of the word “default”.

### §8 Configuration — verified

Malformed `config.json` fails fast; `PORT=abc|0|-1` rejected; an empty
environment variable means “unset” (defaults apply, not `false`); precedence
environment > `config.json` > default.

## 4. ARCHITECTURE §2 invariants

| # | Invariant | Result |
|:--|:--|:--|
| 1 | one identity → one upstream session, same session id every turn | ✅ `modules/invariants.session-identity.test.js`; on the wire in `upstream-routing.test.js › opencode-go …` (same `x-opencode-session` across turns) |
| 2 | only appended turns are sent; an echoed answer is not duplicated | ✅ `modules/invariants.session-identity.test.js`, `chat-completions.test.js › a reused conversation …`; a stale-snapshot duplication defect was found and fixed (`FINDING-1`) |
| 3 | any edit/reorder/truncation anywhere in the prefix rotates, full history | ✅ `modules/invariants.prefix.test.js` (first/middle/last message, reorder, truncation, replay, plus system-message handling) |
| 4 | a retry that rotates re-sends the full history | ✅ `modules/invariants.prefix.test.js`, and the engine retry path re-prompts from index 0 |
| 5 | look-alike conversations are never merged; the echo selects exactly | ✅ `modules/invariants.merge.test.js` |
| 6 | never report the previous answer; a failed snapshot fails the turn | ✅ `modules/invariants.baseline.test.js`, `modules/upstreams.events-baseline.test.js` (with control cases proving the fixtures can detect the bug), `contract/errors-and-locking.test.js` |
| 7 | turns of one conversation are serialized; a waiter times out busy | ✅ at the registry level (`modules/invariants.lock.test.js`); on the chat surface the engine serializes **all** turns process-wide (`FINDING-10`, ruled a documented parity behaviour) |
| 8 | only untracked sessions are closed; direct and chain-held sessions are kept | ✅ `modules/invariants.eviction.test.js` (TTL boundary, LRU, candidate cap, lock exemption, direct/chain exceptions) |

## 5. Assembly-level `baseline === null` vs `ok === false`

Verified explicitly (`contract/errors-and-locking.test.js`):

- a **reused runtime** turn whose snapshot fails answers 503
  `session_state_unavailable` (fail-closed, never unfiltered polling);
- a **pinned runtime** turn (`previous_response_id`) does the same after the
  `FINDING-9` fix;
- a **direct** conversation never asks the runtime for a baseline: the test
  breaks `session.messages` and the second direct turn still succeeds, which also
  pins the interface footgun for callers — `assertBaseline(null)` throws by
  design, so it may only be called when `baseline.ok === false` (runtime), never
  for the `null` of direct mode.

## 6. Legacy test replacement audit (104 cases)

Method: extract the deleted suites from git (`4c4e42f^`), extract every case
name from them and from the current contract suites, and compare counts, names
and assertion density; scan the whole `tests/**` tree for `skip`/`only`/`todo`
and for hollow assertions.

| Legacy suite | Cases | Current counterpart | Result |
|:--|:--|:--|:--|
| `tests/unit/app.test.js` | 60 | `tests/contract/app.test.js` | 60/60 identical names, 225/225 `expect()` calls |
| `tests/unit/session-reuse.test.js` | 31 | `tests/contract/session-reuse.test.js` | 31/31 identical names, 100/100 `expect()` calls |
| `tests/unit/direct-upstream.test.js` | 13 | `tests/contract/direct-upstream.test.js` | 13/13 identical names, 73/73 `expect()` calls |

- No test name was silently dropped, renamed away or weakened: the moved suites
  are verbatim (same names, same counts, same assertion density).
- The client-disconnect case is `contract/session-reuse.test.js › releases the
  conversation when the client disconnects mid-stream`; the verification suite
  re-proves the same behaviour independently with a real socket abort
  (`errors-and-locking.test.js › a client disconnect releases the conversation
  lock`, using a real `app.listen(0)` server and `AbortController`).
- The two rewritten unit suites kept their case counts (`tool-lock` 14/14,
  `parser-foreign-formats` 69/69).
- No `skip`/`only`/`todo` markers and no placeholder assertions exist anywhere in
  `tests/unit` or `tests/contract`; the only intentional `test.failing` is the
  wrapper for an open finding as of `9a0a21a`.
- No other test file disappeared: the file-level diff against `4c4e42f^` shows
  only the three moves, the new contract/verification files and the e2e smoke.

## 7. Real upstream direct smoke (executed)

`node tests/verification/smoke/real-upstream-smoke.mjs` — the assembled app with
a dummy key, pointed at the real endpoints:

```
[evidence] direct upstream https://opencode.ai/zen/go/v1/chat/completions -> 401
[evidence] upstream body bytes: "{\"type\":\"error\",\"error\":{\"type\":\"AuthError\",\"message\":\"Invalid API key.\"}}"
[evidence] gateway -> 401, content-type=text/plain; charset=utf-8
[evidence] gateway body bytes: "{\"type\":\"error\",\"error\":{\"type\":\"AuthError\",\"message\":\"Invalid API key.\"}}"
[pass] real direct upstream: status and body relayed byte-for-byte, no taxonomy rewrite
```

The upstream itself answers `text/plain;charset=UTF-8`, so the relayed content
type is faithful (not a re-typed body). Additionally, the real-runtime smoke
below showed `GET /v1/models` reaching the **public upstream catalogs** over the
network when the runtime is absent, returning real model ids
(`opencode-go/minimax-m3`, …).

## 8. Real runtime smoke — not verifiable here (environment)

Evidence (`node tests/verification/smoke/real-runtime-smoke.mjs`):

```
[evidence] `which opencode` -> (not found)
[evidence] runtime health http://127.0.0.1:4096/global/health -> unreachable (ECONNREFUSED)
[evidence] rewritten app GET /v1/models -> HTTP 200 (upstream catalogs fallback)
[evidence] rewritten app POST /v1/chat/completions (opencode-go/minimax-m3)
           -> HTTP 500 {"error":{"message":"Internal server error","type":"server_error","code":"internal_error"}}
```

The last line was re-run after the `FINDING-11` fix: on the real transport
failure the gateway now answers the documented 500 body, so this smoke doubles
as the real-link confirmation of that fix (before it, the same line read
`{"message":"fetch failed","type":"internal_error","code":"TypeError"}`).

So a real chat/responses turn cannot be exercised in this sandbox. Exclusion
method — this is an environment problem, not a rewrite regression:

1. the runtime is absent independently of this project (`which opencode` empty,
   `/global/health` refused) — the lead confirmed the same with a direct `curl`
   against `opencode serve`;
2. the failure happens at the **transport boundary** (`fetch failed`) before any
   gateway logic runs;
3. the lead additionally ran the **pre-rewrite monolith** in this environment and
   observed the same runtime timeouts and the same `/v1/models` fallback. My
   script attempted the same comparison automatically; the monolith did not start
   standalone (it resolves its own module paths), so it is recorded as
   *attempted*, and the lead's run remains the evidence for that leg;
4. the runtime client itself **is** covered offline against a fake SDK: session
   lifecycle, prompt timeout/client-abort, polling baseline filtering, event
   collection baseline filtering (`tests/verification/modules/upstreams.events-baseline.test.js`)
   and the plugin policy.

## 9. Findings

Severity legend: **major** = published contract or documented invariant is
violated in a realistic path; **minor** = contract deviation on an edge;
**parity** = the behaviour predates the rewrite (verified in
`4c4e42f^:src/proxy.js`), still reported because the docs are authoritative.

### Fixed during verification (probe now asserts the fixed behaviour)

| # | Sev | Symptom | Spec | Evidence |
|:--|:--|:--|:--|:--|
| 1 | major | a queued turn refreshed only the session id, so it re-sent turns the session already held | ARCHITECTURE §2 inv. 2 | `modules/findings.probes.test.js › [FINDING-1 fixed] …` |
| 2 | major | direct mode + `previous_response_id` forced a runtime baseline read → 503 before the upstream call | ARCHITECTURE §2 (`baseline` null in direct mode), api-reference §Session Resume | `… › [FINDING-2 fixed] a direct pinned turn never touches the runtime session state` |
| 3 | minor | one failing `/models` provider dropped the other provider's last good models | task/api-reference “falls back to the public upstream catalogs” | `modules/upstreams.catalog.test.js › [FINDING-3 fixed] …` |
| 4 | minor | an unterminated SSE tail record gained a synthetic `\n\n` and framing was re-emitted | passthrough contract | `modules/upstreams.sse.test.js › [FINDING-4 fixed] …` |
| 6 | minor | CRLF-framed SSE records mangled (`\r\n\r\n` → `\n\r\n`) and every record after the first kept the upstream model name | §5 `model` mapped both ways | `modules/upstreams.sse.test.js` (now asserts CRLF framing + rewriting) |
| 7 | minor | `input: ""` accepted, opened an upstream session for an empty turn | BEHAVIOUR-SPEC §3 “missing/empty → 400” | `contract/responses.test.js › [FINDING-7 fixed] …` |
| 8 | major | empty answer text leaked `JSON.stringify(sdkResult)` as the answer (`{"parts":[]}`) | BEHAVIOUR-SPEC §3 “empty output text → empty `output` array” | `contract/responses.test.js › [FINDING-8 fixed] …` |
| 9 | major | responses baseline failure answered **502 server_error** instead of **503 session_state_unavailable** | §6 + api-reference §503 | `contract/errors-and-locking.test.js › [FINDING-9 fixed] …` |
| 11 | major | an unexpected failure of ours answered `{"message":"fetch failed","type":"internal_error","code":"TypeError"}` (constructor name leaked; the streamed `response.failed` payload carried `code:"Object"`) | api-reference §500 + BEHAVIOUR-SPEC §6 | `contract/errors-and-locking.test.js › [FINDING-11 fixed] …`, plus the independent suite `contract/error-sanitization.test.js` |

### FINDING-11 — fixed in `9a0a21a` (independently re-verified)

The fix splits the default branch by *whose* failure it is: a built-in JS error
class (or a nameless value) is “ours” and answers the documented body
`{"message":"Internal server error","type":"server_error","code":"internal_error"}`,
while a failure the runtime named keeps its message and code so the turn stays
diagnosable. `docs/BEHAVIOUR-SPEC.md` §6's 500 row was aligned with the
api-reference wording in the same commit.

Independent re-verification (`tests/verification/contract/error-sanitization.test.js`,
15 cases, driven through the assembled app over HTTP):

| Property | Cases | Result |
|:--|:--|:--|
| our own failures are sanitized | `Error`, `TypeError`, `RangeError`, `ReferenceError`, `SyntaxError`, `URIError`, `EvalError`, `AggregateError`, an error renamed `Object`, a nameless object, a bare string | 500 with exactly the documented body; the body is asserted not to contain the original message or any built-in class name |
| runtime-reported failures stay diagnosable | `MessageAbortedError` → `{message:"Aborted", code:"MessageAbortedError"}`; explicit `code` wins (`OPENCODE_BOOM`); streamed `response.failed` carries `{message:"Aborted", type:"server_error", code:"MessageAbortedError"}` and no `"code":"Object"`; the non-streaming error-only turn keeps the documented 502 row (`{message:"Aborted", type:"MessageAbortedError"}`) | all pass |

Real-link evidence: with `MANAGE_BACKEND=false` and an unreachable backend the
lead measured `HTTP 500 {"error":{"message":"Internal server error",
"type":"server_error","code":"internal_error"}}` (120.8 s, see the parity note
below), and my own real-runtime smoke reproduces the same body on its
transport-failure path (`tests/verification/smoke/real-runtime-smoke.mjs`);
before the fix both lines carried `{"message":"fetch failed","type":"internal_error","code":"TypeError"}`.

Also closed: `FINDING-5` (echo-skip semantics) was ruled **intentional** and is
now asserted as “skip, and report a mismatch against `replyDigest` at debug
level”; the tool-contract reminder (`externalToolContext.reminder`) regression is
independently re-verified below.

### Ruled a documented behaviour (not a defect)

**FINDING-10 (parity) — chat turns are serialized process-wide.**
`handleChat` runs every turn under a module-level mutex
(`src/routes/engine.js:583/1828`, the same in `4c4e42f^:src/proxy.js`), so a slow
chat turn delays chat traffic of other conversations, and
`503 conversation_busy` is effectively observable on `/v1/responses` only.
The lead documented this in `docs/{zh,en}/api-reference.md` (503 section) and
`docs/BEHAVIOUR-SPEC.md` §1, and ruled it out of scope for this rewrite. The
probe now asserts the documented behaviour
(`contract/errors-and-locking.test.js › [PARITY-DOCUMENTED] chat turns are
serialized process-wide`) and `503 conversation_busy` is verified on the
responses surface. **Preconditions for any future change**: prove the engine's
shared state (tool-policy metrics, `cachedToolIds`, response-chain index) and the
managed backend are concurrency-safe, then scope the mutex to the plugin
critical section and re-run this suite plus a concurrency soak.

### Observations (unspecified by the spec, parity, not counted as defects)

- a chat SSE turn whose only upstream outcome is a message error ends as a normal
  empty `finish_reason:"stop"` chunk with no error signal (the non-streaming path
  answers 502);
- the 404 `model_not_found` body carries an extra `available_models` array;
- 400 validation bodies carry only `message` (matching the literals in
  BEHAVIOUR-SPEC §2, while §6 describes the general envelope);
- the final streaming usage chunk omits `object`/`model`/`created` (BEHAVIOUR-SPEC
  §2.2 lists only `choices` + `usage` for it);
- a learned free-tier model is remembered case-sensitively
  (`Mystery-Model` ≠ `mystery-model`), so each casing may cost one extra direct
  attempt per hour;
- the LRU hard cap (default 1000) can evict a *locked* conversation, closing an
  upstream session under an in-flight turn; the store documents “hard cap wins”
  and ARCHITECTURE is silent;
- with `MANAGE_BACKEND=false` and an unreachable backend, the first request waits
  out the startup probe (`STARTUP_WAIT_ITERATIONS(60) × 2000ms` ≈ **120 s**) before
  answering 500. Same source in the pre-rewrite monolith, so it is a parity
  behaviour, not a regression; the lead reproduced it on the real link
  (`HTTP 500  120.8s`). It is worth a follow-up note for operators: the wait is
  not configurable and a dead backend turns the first turn into a two-minute
  stall.

## 10. `externalToolContext.reminder` regression — independent conclusion

Confirmed fixed, independently of the author's new test: in the tool-bridge
suite the prompt captured from the fake runtime contains the reminder
(`REMINDER: External tools are called by emitting markup…`), names the exposed
tools (`Available names: external__weather`), appears **exactly once**, is
positioned after the user turn (i.e. last, right before generation, which is
where the parser-rate effect comes from), and is absent when no tools are
declared. `contract/tool-bridge.test.js › declared tools are exposed as
external__ names with the reminder`.

## 11. Not verified / uncertain

| Item | Why |
|:--|:--|
| a real runtime turn (chat non-streaming/streaming, responses) | no `opencode` CLI and no runtime in the sandbox (§8); covered by fake-SDK tests + the lead's monolith comparison |
| a real CRLF-framed SSE stream from the upstream | the fix is verified against synthetic CRLF streams; the real upstream was only observed answering a non-streaming 401 |
| streaming from the real direct upstream (rewritten model fields on a real stream) | the real upstream rejects the dummy key before streaming; stub streams are byte-checked |
| the plugin running inside a live OpenCode server | verified against the plugin module with a fake SDK client, not a live backend |
| the 30-minute chain TTL in wall-clock time | verified with an injected clock; no 30-minute real-time run |
| the 60 s response-state/registry sweep timer in production | the sweep is unit-verified; the interval itself is not exercised in real time |
| Docker image / entrypoint / compose behaviour | outside this task's scope (packaging task) |
| exact `prompt_tokens` for tool-call-heavy transcripts | estimates are asserted for text transcripts; tool-call rendering is not |

## 12. How to reproduce

```bash
npm run typecheck
npm run lint
npm run format:check
npm test                 # unit
npm run test:contract
npm run test:verify      # independent verification (offline, port 0 only)
npm run test:all         # all three

# real upstream (needs network)
node tests/verification/smoke/real-upstream-smoke.mjs

# real runtime / environment check (needs a runtime; documents its absence)
node tests/verification/smoke/real-runtime-smoke.mjs

# one case, e.g. the error-sanitization re-verification of FINDING-11
npm run test:one -- tests/verification/contract/error-sanitization.test.js --runInBand
```
