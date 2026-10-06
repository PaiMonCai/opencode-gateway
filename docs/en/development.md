# 💻 Development Guide

## 📋 Setup

```bash
node --version    # Requires 20+
npm install

# Install OpenCode CLI
npm install -g opencode-ai
# Or curl -fsSL https://opencode.ai/install | bash
```

## 🚀 Run Locally

```bash
cp config.json.example config.json
npm start
```

On start, the OpenCode backend is launched on demand, then the proxy starts.

## ✅ Tests

```bash
npm run lint          # ESLint (flat config, plugin/ included)
npm run format:check  # Prettier check
npm run typecheck     # tsc --checkJs (JSDoc types)
npm test              # unit tests (tests/unit)
npm run test:contract # HTTP contract, api-reference item by item (tests/contract)
npm run test:verify   # verification suite (tests/verification)
npm run test:all      # all three test suites in one go
npm run test:coverage # coverage
npm run test:integration  # Docker-backed integration test
npm run test:stream       # live-backend streaming smoke test (manual)
npm run test:one -- tests/unit/conversation/registry.test.js --runInBand  # a single file
```

> Every Jest invocation must go through the npm scripts: they set
> `NODE_OPTIONS=--experimental-vm-modules`, without which a bare `npx jest` fails
> with `Cannot use import statement outside a module`.
> Tests need no network, no real OpenCode runtime and no fixed port (stub servers
> bind port 0). CI (`.github/workflows/ci.yml`) runs lint → format:check →
> typecheck → `npm run test:all` (unit → contract → verification) on every push
> and pull request.

Docker verification:

```bash
docker compose up -d --build
docker compose logs -f
```

Real-upstream smoke (not part of CI — it needs the network and a reachable upstream):

```bash
node tests/verification/smoke/real-upstream-smoke.mjs
```

It drives the direct upstream path against the real OpenCode Zen endpoints with a
deliberately invalid key, asserting that the upstream's native error surface
reaches the client byte-for-byte instead of being rewritten by our error taxonomy.

Real-runtime smoke (not part of CI — it needs a real `opencode` binary and a
reachable runtime):

```bash
bash tests/e2e/smoke.sh
```

It starts the gateway on the SDK-driven runtime path, waits for `/health`, then
exercises a non-streaming and a streaming chat completion plus a Responses call.
`OPENCODE_PATH`, `E2E_MODEL`, `E2E_PORT` and `E2E_TIMEOUT_SECONDS` tune it.

## 📂 Project Layout

```
opencode-gateway/
├── index.js                       # Entry point: config → registry/router → HTTP
├── src/
│   ├── app.js                     # createApp: wire the http layer and routes
│   ├── bootstrap.js               # buildRuntime: assemble config, logger, registry, router, tools
│   ├── server.js                  # listen, graceful shutdown, managed runtime, banner
│   ├── config/                    # env + config.json → validated Config (effective defaults, redacted)
│   ├── logging/                   # structured logging (JSON lines / human, child scopes, redaction)
│   ├── errors/                    # error taxonomy, OpenAI mapping, transient classification
│   ├── http/                      # CORS, body limits, bearer auth, request id, abort signal
│   ├── concurrency/               # bounded process-wide turn capacity (turn limiter)
│   ├── conversation/              # conversation layer: identity / store / planner / baseline / registry
│   ├── upstreams/                 # direct client, runtime client, router (free-tier learning)
│   ├── tools/                     # text tool contract: contract / parser / registry / policy / validator / router
│   └── routes/                    # health / models / chat / responses / engine
├── plugin/                        # backend plugin: enforces the policy in the session title
├── tests/
│   ├── unit/                      # per-module unit tests (npm test)
│   ├── contract/                  # HTTP contract, api-reference item by item
│   ├── verification/              # verification suite (own fixtures, plus smoke/ scripts outside CI)
│   ├── integration/               # Docker integration test
│   ├── manual/                    # live streaming smoke test, not in CI
│   └── e2e/                       # real-runtime smoke script, not in CI
├── docs/                          # ARCHITECTURE.md · BEHAVIOUR-SPEC.md · en/ + zh/ (README, getting-started, configuration, api-reference, docker, troubleshooting, development)
├── entrypoint.sh / Dockerfile / docker-compose.yml
└── tooling: eslint.config.js · .prettierrc · tsconfig.json(checkJs) · .nvmrc · .github/workflows/ci.yml
```

> Layering is one-directional: `routes` → `conversation` + `upstreams` → `config`/`logging`/`errors`; only `upstreams` knows about the SDK and `fetch`, and only `http`/`routes` touch `req`/`res`. The acceptance criteria for a change live in [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) (the contract and the 8 conversation invariants) and [`docs/BEHAVIOUR-SPEC.md`](../BEHAVIOUR-SPEC.md) (wire-level behaviour).

> Two upstream paths: the conversation layer in `src/conversation/` keeps "one conversation = one session identity", and `src/upstreams/direct-client.js` speaks to OpenCode directly. The local runtime only serves free-tier models. When you touch either, run `tests/contract/session-reuse.test.js` and `tests/contract/direct-upstream.test.js` too.

## 📝 Commit Style

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new feature
fix: fix bug
docs: update documentation
refactor: refactor code
test: add tests
chore: update build/ci
```

## 🔄 Contribute

1. Fork the repo and create a feature branch: `git checkout -b feature/your-feature`
2. Commit changes, make sure `npm test` passes
3. Push the branch and open a Pull Request

See [CONTRIBUTING.md](../../CONTRIBUTING.md).

## 📄 License

MIT License · See [LICENSE](../../LICENSE.md)
