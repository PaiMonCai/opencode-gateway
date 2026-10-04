# 🔧 Troubleshooting

## ❓ FAQ

### Requests hang, but `/v1/models` works

Set `OPENCODE_USE_ISOLATED_HOME=false` so OpenCode reuses the host login state:

```env
OPENCODE_USE_ISOLATED_HOME=false
```

### Free models fail with `free tier can only be used from within OpenCode`

Two causes — check who reported it:

1. **The direct upstream returned `403 FreeTierError`** (body `{"type":"error","error":{"type":"FreeTierError",...}}`): the model belongs to the free tier, which is only served to the official client. The proxy remembers it as runtime-only and falls back to the local runtime; if you disabled `OPENCODE_PROXY_DIRECT_FALLBACK`, re-enable it. Models with the `-free` suffix already go to the runtime and never show this.
2. **The local runtime reported it**: the backend is not loading the tool-lock plugin. Let the proxy start the backend (default `MANAGE_BACKEND=true`), or add `plugin/opencode-gateway-tool-lock.js` to your own backend's `plugin` config.

### Direct mode returns `401 Invalid API key.` or quota errors

```json
{"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}
```

That is the **upstream's native response**: the direct path works, but the credential is wrong or lacks entitlement. Check `OPENCODE_ZEN_API_KEY` (a Go subscription needs Go on that account; paid Zen needs credit). Keep `OPENCODE_PROXY_DIRECT_FALLBACK=true` (default) if you want an automatic runtime fallback.

### Direct mode returns `ModelError: ... is not supported for format openai`

The upstream `/responses` route is **per model**: some models are only offered in the `chat/completions` format. Use `POST /v1/chat/completions`, or pick a model that supports the format.

### `503 conversation_busy`

The previous request on this conversation has not finished (it waited longer than the request timeout plus 60 seconds). Usually a client sending several requests with one `session-id`, or a turn stuck upstream. Retry shortly; if it happens often, check whether the upstream stops responding for long stretches.

### `503 session_state_unavailable`

The session state could not be read while reusing a conversation, and the proxy refuses to return possibly stale content. Just retry; if it persists the backend (runtime) is unhealthy — check its logs and `/global/health`.

### Usage or fields missing in direct mode

In direct mode the middleware **forwards as-is**, so optional fields the upstream does not implement (for example `stream_options.include_usage`) are not synthesised. If you need strict OpenAI semantics, use a runtime-path model (a `-free` one) or wait for the upstream.

### Model not found (`model_not_found`)

Check the model ID against the backend:

```bash
curl http://127.0.0.1:10000/v1/models
```

### Sent `reasoning_effort` but got no reasoning output

Use the Responses API with `stream: true`, and pass `reasoning.effort` or `reasoning_effort`.

### Client unexpectedly triggers OpenCode built-in tools

Keep `OPENCODE_DISABLE_TOOLS=true`.

### Port conflict (`EADDRINUSE`)

```bash
# Check usage
lsof -i :10000
lsof -i :10001

# Change ports
OPENCODE_PROXY_PORT=10002
OPENCODE_SERVER_PORT=10003
```

### OpenCode not installed (`Cannot verify OpenCode installation`)

```bash
npm install -g opencode-ai
# Or curl -fsSL https://opencode.ai/install | bash
```

You can also point to the full binary path via `OPENCODE_PATH`.

### Docker container fails to start

```bash
docker compose logs
netstat -tulpn | grep -E '10000|10001'
```

### Auth failure (`401 Unauthorized`)

Confirm the request carries the same Bearer token as `API_KEY`:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" ...
```

## 🔍 Debug Mode

```env
OPENCODE_PROXY_DEBUG=true
```

Debug logs print detailed request and response info.

## 🆘 Get Help

- 🐛 [GitHub Issues](https://github.com/PaiMonCai/opencode-gateway/issues)

### Every turn answers 500 with `TypeError: null is not an object` (plugin loader contract)

Symptom: the runtime is up, `/global/health` is green and sessions are created,
yet **every turn fails** (on the gateway side it shows up as waiting until
`Request timeout after 180000ms`), while the runtime's file log says:

```
"plugin config hook failed" error="null is not an object (evaluating 'N.config')"
failed error="TypeError: null is not an object (evaluating 'z[G]')"
  at Plugin.trigger → SessionPrompt.createUserMessage → SessionPrompt.prompt
```

Cause: opencode 1.18's plugin system has two hard requirements (both satisfied in
`plugin/`; keep them when editing):

1. **the plugin file may export nothing but `default`.** The loader registers
   *every function export* as a plugin of its own, and the broken entries it
   creates make `Plugin.trigger` throw on every turn. Pure helpers live in
   `plugin/tool-policy.js`, which must **never** be listed in the runtime's
   `plugin` configuration.
2. **the plugin must return every hook the runtime calls**
   (`config`/`event`/`dispose`/`chat.message`/`chat.params`/`tool.execute.after`
   plus `tool.execute.before`). `Plugin.trigger` resolves a hook by name and calls
   it without checking that it exists; defining only `tool.execute.before` fails
   the turn before the model is reached.

Self-check (needs no model credit):

```bash
docker exec opencode-gateway node -e "import('/home/node/project/plugin/opencode-gateway-tool-lock.js').then(async m => { const h = await m.default({client:{session:{get:async()=>({data:{title:'opencode-gateway [tools:*]'}})}}}); console.log(Object.keys(m), Object.keys(h)) })"
# expect: [ 'default' ] [ 'tool.execute.before', 'config', 'event', 'dispose', 'chat.message', 'chat.params', 'tool.execute.after' ]
```
