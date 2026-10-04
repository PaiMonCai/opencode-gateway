# 🐳 Docker Deployment

## 🚀 Quick Start

```bash
git clone https://github.com/PaiMonCai/opencode-gateway.git
cd opencode-gateway
cp .env.example .env      # set at least API_KEY and OPENCODE_SERVER_PASSWORD
docker compose up -d

# Verify
curl http://127.0.0.1:10000/health
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:10000/v1/models
```

The default image is `ghcr.io/paimoncai/opencode-gateway:latest`; `docker compose build` builds the same thing from the repository's `Dockerfile` (the compose file declares both `image:` and `build:`).

## 🧱 Image and Runtime

- Base image `node:24-slim`; production dependencies are installed in their own layer with `npm ci --omit=dev`, so editing the source never reinstalls them.
- The image ships the `opencode-ai` CLI, which is what `OPENCODE_PATH=opencode` resolves to. That is why the gateway starts and supervises its own backend by default (`OPENCODE_PROXY_MANAGE_BACKEND=true`).
- **The container does not run as root.** `entrypoint.sh` first applies `PUID`/`PGID` to the `node` account, fixes ownership of the two OpenCode volumes, then uses `gosu` to run `node index.js` as `node`. Signals and the exit code belong to that process.
- `PUID`/`PGID` default to the image's `node` account (1000:1000); set them to your NAS user. When you start with `docker run --user`, the entrypoint notices it is not root and skips the remapping.
- With `OPENCODE_PROXY_PROMPT_MODE=plugin-inject`, the entrypoint writes a no-op plugin and a matching `opencode.json` into the config volume (`/home/node/.config/opencode/`). Other modes leave the volume alone.

## ⚙️ Configuration

Precedence is **environment > config.json > default**. The compose file passes every variable from `docs/en/configuration.md` through as `${VAR:-default}`, so editing `.env` is enough; the complete list lives in [Configuration](./configuration.md).

Common entries:

```env
# Required
API_KEY=change-me
OPENCODE_SERVER_PASSWORD=change-me-too

# Upstream credential: Go and paid Zen then go direct, the free tier stays on the local runtime
OPENCODE_ZEN_API_KEY=your-opencode-key

# Safety: built-in model tools are disabled by default
OPENCODE_DISABLE_TOOLS=true

# Conversations: turn derivation on when your gateway cannot forward a custom header
OPENCODE_PROXY_SESSION_REUSE=true
OPENCODE_PROXY_SESSION_DERIVE=true

# Prompts: typical for clients that manage the prompt themselves
OPENCODE_PROXY_PROMPT_MODE=plugin-inject
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
```

## 📦 Volumes and Directories

| Volume | Container Path | Description |
|:-----|:----------|:-----|
| `opencode-data` | `/home/node/.local/share/opencode` | OpenCode data directory |
| `opencode-config` | `/home/node/.config/opencode` | OpenCode config directory (also holds the `plugin-inject` files) |

The source tree is copied into the image at `/home/node/project` and no host directory is mounted by default, so the image's `node_modules` stays intact. To use your own `config.json`, mount that single file:

```bash
-v "$PWD/config.json:/home/node/project/config.json:ro"
```

## 🔨 Custom Build and Single Container

```bash
docker build -t my-opencode-gateway .
docker run -d --name my-gateway \
  -p 10000:10000 \
  -e API_KEY=your-key \
  -e OPENCODE_SERVER_PASSWORD=your-password \
  -v opencode-data:/home/node/.local/share/opencode \
  -v opencode-config:/home/node/.config/opencode \
  my-opencode-gateway
```

For a Go subscription or paid Zen credit only, no local runtime is needed: set `OPENCODE_ZEN_API_KEY` and `OPENCODE_PROXY_MANAGE_BACKEND=false`; the model list and the requests are then served by the direct upstream.

## ✅ Health Check

The image declares a `HEALTHCHECK` and compose carries an equivalent one. Both query `/health` **inside the container**, so they keep working when the published host port differs from `OPENCODE_PROXY_PORT`:

```yaml
healthcheck:
  test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:$${OPENCODE_PROXY_PORT:-10000}/health"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 60s
```

## 📊 Logs

```bash
docker compose logs -f
```

Compose already rotates json-file logs (10 MB each, 3 files) so a long-running gateway cannot fill the disk:

```yaml
logging:
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"
```

Set `OPENCODE_PROXY_DEBUG=true` for human-readable log lines instead of JSON.

## 🧪 Tests

```bash
npm run test:integration   # build image, run a container, exercise HTTP; needs Docker
npm run test:stream        # streaming smoke test against a live gateway (alias: test:streaming-real)
```

`test:integration` exit codes: `0` all checks passed, `1` a check failed, `2` a prerequisite is missing (no Docker CLI, no daemon, no curl) — in that case nothing is tested and the reason is printed. Useful overrides: `TEST_PORT`, `TEST_API_KEY`, `IMAGE_TAG`, `KEEP_CONTAINER=1` (leave the container for inspection), `SKIP_MODEL_TESTS=1` (skip the checks that need a real model), `PROBE_VIA=exec` (send the probes with `docker exec` inside the container; use it when the published port is unreachable from the host, e.g. with rootless or remote daemons).

`test:stream` exit codes: `0` passed, `1` a check failed, `2` the gateway is unreachable. Useful overrides: `BASE_URL`, `API_KEY`, `MODEL`, `CHECK_TOOLS=1` (also verify streamed tool calls).

## ❓ FAQ

- **Container will not start**: read `docker compose logs` and check that the host port is free.
- **Ownership problems on the mounts**: set `PUID`/`PGID` to the host user; the entrypoint repairs the two volumes at startup.
- **Free-tier models answer 403 FreeTierError**: that gate checks for the official client, so keep `OPENCODE_PROXY_MANAGE_BACKEND=true` and let the gateway start the backend.
- **Different registry namespace**: change `image:` in the compose file, or drop it and use `build:` only.
