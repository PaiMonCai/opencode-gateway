# Contributing to opencode-gateway

Thank you for your interest in contributing to opencode-gateway!

## Scope

This project is a **compatibility layer between an OpenAI-format gateway and OpenCode**. In scope:

- making an OpenAI-shaped request work against OpenCode (conversations, headers, model mapping, error shapes);
- keeping the two upstream paths honest: direct to OpenCode's OpenAI-compatible endpoints, and the local runtime for the free tier;
- reliability of the conversation layer (reuse, incremental delivery, rotation, cleanup, bounded waits);
- documentation that matches the code.

Out of scope: general gateway features (multi-upstream routing, billing, quotas, tenancy, key pools), and reimplementing the model provider itself.

The design lives in `src/`: routing and conversations in `src/conversation/` and
`src/routes/`, the two upstream paths in `src/upstreams/` (direct client, runtime
client, router), and the tool policy in `src/tools/` plus `plugin/`. Read
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) before changing a boundary.

## Code of Conduct

Please be respectful and professional. We follow the [Contributor Covenant](https://www.contributor-covenant.org/).

## How to Contribute

### Reporting Bugs

1. Check if the issue already exists
2. Create a detailed issue with:
   - Clear title and description
   - Steps to reproduce
   - Environment details
   - Relevant logs

### Suggesting Features

1. Open an issue with `[Feature Request]` prefix
2. Describe the use case
3. Propose a solution or API design

### Pull Requests

1. Fork the repository (maintainers branch off `main` directly)
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes
4. Run tests: `npm run test:all` (unit + contract + verification; the conversation layer and the direct upstream each have their own suite)
5. Commit with clear messages (see Commit Style below)
6. Push to your fork
7. Submit a Pull Request

> Pushing to `main` triggers the Docker image build (`.github/workflows/docker-publish.yml`), so let a PR settle before merging.

## Commit Style

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation
- `style`: Code style (formatting)
- `refactor`: Code refactoring
- `test`: Tests
- `chore`: Build/ci updates

Examples:
```
feat(api): add streaming support for Responses API
fix(proxy): resolve memory leak in long-running sessions
docs: update configuration documentation
```

## Development Setup

```bash
# Clone and install
git clone https://github.com/PaiMonCai/opencode-gateway.git
cd opencode-gateway
npm install

# Run tests
npm test

# Start locally
npm start
```

## Testing

- Unit tests (`tests/unit/`): `npm test`
- HTTP contract tests (`tests/contract/`): `npm run test:contract`
- Verification suite (`tests/verification/`): `npm run test:verify`
- Integration tests (Docker, `tests/integration/`): `npm run test:integration`
- Live streaming smoke test (manual, `tests/manual/`): `npm run test:stream`
- Real-runtime end-to-end smoke (manual, `tests/e2e/`): `npm run test:e2e` (= `bash tests/e2e/smoke.sh`)

## Code Review Process

1. All submissions require review
2. Address feedback promptly
3. Squash commits before merge

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE.md).
