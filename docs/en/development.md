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

| Command | Description |
|:-----|:-----|
| `npm test` | All unit tests (Jest, `tests/unit`) |
| `npm run test:integration` | Docker-backed integration tests |
| `npm run test:stream` | Live-backend streaming smoke test (manual) |

Docker verification:

```bash
docker compose up -d --build
docker compose logs -f
```

## 📂 Project Layout

```
opencode-gateway/
├── index.js                       # Entry point and config loading (env / config.json / startup banner)
├── src/
│   ├── proxy.js                   # The middleware: routing, conversations, dual upstream, tool policy
│   ├── upstream/
│   │   └── direct-client.js       # Direct OpenCode endpoints: fingerprint headers, SSE rewrite, model catalog
│   └── tool-runtime/              # Text tool contract (runtime path only: contracts/parser/policy/registry/router/validator)
├── plugin/
│   ├── opencode-gateway-tool-lock.js  # Backend plugin: enforces the policy carried in the session title
│   └── tool-lock.js                   # Deny-everything variant
├── tests/
│   ├── unit/                      # Jest suites (npm test): app / session-reuse / direct-upstream / tool-lock / parser
│   ├── integration/               # Docker integration test
│   └── manual/                    # Real-backend smoke test, not in CI
├── docs/                          # Documentation (zh/ + en/)
├── entrypoint.sh                  # Docker entrypoint
├── Dockerfile
└── docker-compose.yml
```

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
