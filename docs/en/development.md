# 💻 Development Guide

## 📋 Setup

```bash
node --version    # Requires 18+
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
npm run test:verify   # independent verification suite (tests/verification)
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
> typecheck → unit → contract on every push and pull request.

Docker verification:

```bash
docker compose up -d --build
docker compose logs -f
```

## 📂 Project Layout

```
opencode-gateway/
├── index.js                       # Entry point: config → registry/router → HTTP
├── src/
│   ├── app.js                     # createApp：createApp: wire the http layer and routes
│   ├── server.js                  # listen, graceful shutdown, managed runtime, banner
│   ├── config/                    # env + config.json → validated Config (effective defaults, redacted)
│   ├── logging/                   # structured logging (JSON lines / human, child scopes, redaction)
│   ├── errors/                    # error taxonomy, OpenAI mapping, transient classification
│   ├── http/                      # CORS, body limits, bearer auth, request id, abort signal
│   ├── conversation/              # conversation layer: identity / store / planner / baseline / registry
│   ├── upstreams/                 # direct client, runtime client, router (free-tier learning)
│   ├── tools/                     # text tool contract: contract / parser / registry / policy / validator / router
│   └── routes/                    # health / models / chat / responses / engine
├── plugin/                        # backend plugin: enforces the policy in the session title
├── tests/
│   ├── unit/                      # per-module unit tests (npm test)
│   ├── contract/                  # HTTP contract, api-reference item by item
│   ├── verification/              # independent verification (own fixtures)
│   ├── integration/               # Docker integration test
│   └── manual/                    # live streaming smoke test, not in CI
├── docs/                          # docs (zh/ + en/) + ARCHITECTURE.md / BEHAVIOUR-SPEC.md
├── entrypoint.sh / Dockerfile / docker-compose.yml
└── tooling: eslint.config.js · .prettierrc · tsconfig.json(checkJs) · .nvmrc · .github/workflows/ci.yml
```

> 分层依赖是单向的：`routes` → `conversation` + `upstreams` → `config`/`logging`/`errors`；只有 `upstreams` 知道 SDK 与 fetch，只有 `http`/`routes` 知道 `req`/`res`。改动的验收口径见 `docs/ARCHITECTURE.md`（契约与 8 条会话不变量）与 `docs/BEHAVIOUR-SPEC.md`（线级行为）。

> Two upstream paths: the conversation layer in `src/proxy.js` keeps "one conversation = one session identity", and `src/upstream/direct-client.js` speaks to OpenCode directly. The local runtime only serves free-tier models. When you touch either, run `tests/unit/session-reuse.test.js` and `tests/unit/direct-upstream.test.js` too.

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
