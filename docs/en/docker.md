# 🐳 Docker Deployment

## 🚀 Quick Start

```bash
git clone https://github.com/PaiMonCai/opencode-gateway.git
cd opencode-gateway
cp .env.example .env    # Edit .env, API_KEY and OPENCODE_SERVER_PASSWORD are required
docker compose up -d

# Verify
curl http://127.0.0.1:10000/health
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:10000/v1/models
```

## ⚙️ Configuration

Common `.env` items (full list in [Configuration](./configuration.md)):

```env
# Required
API_KEY=change-me
OPENCODE_SERVER_PASSWORD=change-me-too

# Upstream credential: with this set, Go and paid Zen go direct and the free tier uses the local runtime
OPENCODE_ZEN_API_KEY=your-opencode-key

# Safety
OPENCODE_DISABLE_TOOLS=true

# Conversations (enable derivation when your gateway cannot forward a custom header)
OPENCODE_PROXY_SESSION_REUSE=true
OPENCODE_PROXY_SESSION_DERIVE=true
```

> The default image is `ghcr.io/paimoncai/opencode-gateway:latest`; change the namespace if you build your own. With a Go subscription or paid Zen credit only, point `OPENCODE_SERVER_URL` at an unreachable address with `OPENCODE_PROXY_MANAGE_BACKEND=false` — the image then needs no runtime.

## 📦 Volumes

| Volume | Container Path | Description |
|:-----|:----------|:-----|
| `opencode-data` | `/home/node/.local/share/opencode` | OpenCode data directory |
| `opencode-config` | `/home/node/.config/opencode` | OpenCode config directory |

Project source is copied into the image at `/home/node/project` at build time. The host directory is not mounted by default, so `node_modules` in the image is not overwritten.

## 🔨 Custom Build

```bash
# Build image
docker build -t my-opencode-gateway .

# Run a single container
docker run -d \
  -p 10000:10000 \
  -e API_KEY=your-key \
  -e OPENCODE_SERVER_PASSWORD=your-password \
  -v opencode-data:/home/node/.local/share/opencode \
  -v opencode-config:/home/node/.config/opencode \
  my-opencode-gateway
```

## 📊 Log Management

```bash
# View logs
docker compose logs -f
```

Log rotation in Compose is recommended:

```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
```

## ✅ Health Check

Compose has a built-in health check:

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:10000/health"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 60s
```

## ❓ FAQ

- **Container fails to start**: check logs with `docker compose logs`, confirm ports are free.
- **Mount permission issues**: check PUID/PGID (default 1000:1000).
