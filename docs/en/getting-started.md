# 🚀 Getting Started

This project is the compatibility layer between an **OpenAI-compatible gateway** and **OpenCode**:

```
local client → NewAPI / LiteLLM (optional) → opencode-gateway → OpenCode
```

It removes the friction between a gateway and OpenCode: stateless OpenAI requests are reassembled into conversations OpenCode accepts (including the conversation header the upstream expects and multi-turn context reuse), and each model is sent to the upstream that can serve it.

## 📋 Requirements

- **Docker**: Docker 20.10+ and Docker Compose
- **Local Node**: Node.js 20+
- **OpenCode CLI**: required only for the **free tier** (the middleware manages the backend). A Go subscription or paid Zen credit needs no runtime — see below.

## 🎯 Two upstreams, pick what you need

| Your quota | Local runtime needed? | Configuration |
|:--|:--|:--|
| Go subscription (`opencode-go/*`) | ❌ no | `OPENCODE_ZEN_API_KEY=<your key>`; `OPENCODE_PROXY_MANAGE_BACKEND=false` and `OPENCODE_SERVER_URL` may point anywhere unreachable |
| Paid Zen (`opencode/<paid models>`) | ❌ no | same as above |
| Zen **free tier** (`opencode/*-free`) | ✅ yes | install the opencode CLI and keep `OPENCODE_PROXY_MANAGE_BACKEND=true` (default) |
| Both | ✅ yes | key + CLI: Go/paid go direct, free-tier models use the runtime automatically |

> The free tier's gate is an official-client identity that a plain HTTP client cannot reproduce (verified `403 FreeTierError`), so free-tier models must be served by the runtime. Everything else goes direct: the body is forwarded as-is and tool calls pass through natively.

## 🏁 Docker Deploy (Recommended)

```bash
git clone https://github.com/PaiMonCai/opencode-gateway.git
cd opencode-gateway
cp .env.example .env        # Edit .env, API_KEY and OPENCODE_SERVER_PASSWORD are required
docker compose up -d
```

## 💻 Local Node Deploy

```bash
# Install OpenCode CLI
npm install -g opencode-ai
# Or curl -fsSL https://opencode.ai/install | bash

git clone https://github.com/PaiMonCai/opencode-gateway.git
cd opencode-gateway
npm install
cp config.json.example config.json
npm start
```

## ✅ Verify

```bash
# Health check
curl http://127.0.0.1:10000/health

# List models
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:10000/v1/models
```

## 💡 Quick Test

```bash
curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "messages": [{"role": "user", "content": "hi"}],
    "stream": false
  }'
```

## ➡️ Next Steps

- ⚙️ [Configuration](./configuration.md) — All options
- 🐳 [Docker Deployment](./docker.md) — Docker details
