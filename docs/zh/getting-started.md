# 🚀 快速开始

本项目是 **OpenAI 兼容网关 ⇄ OpenCode** 之间的兼容层：

```
本地客户端 → NewAPI / LiteLLM（可选）→ opencode-gateway → OpenCode
```

它负责消除网关与 OpenCode 之间的不兼容：把无状态的 OpenAI 请求重组成 OpenCode 能接受的会话（含上游要的会话身份头、多轮上下文复用），并按模型把请求送到最合适的上游。

## 📋 环境要求

- **Docker 方式**：Docker 20.10+ 与 Docker Compose
- **本地 Node 方式**：Node.js 24+
- **OpenCode CLI**：仅在需要**免费档模型**时必须（由中间件托管后端）；只用 Go 订阅 / 付费 Zen 时不需要，见下方说明

## 🎯 两种上游，按需选择

| 你的额度 | 需要本地 runtime 吗 | 配置 |
|:--|:--|:--|
| Go 订阅（`opencode-go/*`） | ❌ 不需要 | `OPENCODE_ZEN_API_KEY=<你的 key>`；`OPENCODE_PROXY_MANAGE_BACKEND=false`，`OPENCODE_SERVER_URL` 可指向不可达地址 |
| 付费 Zen（`opencode/<付费模型>`） | ❌ 不需要 | 同上 |
| Zen **免费档**（`opencode/*-free`） | ✅ 需要 | 安装 opencode CLI，保持 `OPENCODE_PROXY_MANAGE_BACKEND=true`（默认） |
| 两者都要 | ✅ 需要 | 配 key + 装 CLI：付费/Go 走直连，免费档自动走 runtime |

> 免费档的服务端闸门是"官方客户端身份"，普通 HTTP 客户端伪造请求头也过不去（实测 `403 FreeTierError`），所以免费档必须由 runtime 代发；其余模型直连即可，请求体原样转发、工具调用原生直通。

## 🏁 Docker 部署（推荐）

```bash
git clone https://github.com/PaiMonCai/opencode-gateway.git
cd opencode-gateway
cp .env.example .env        # 编辑 .env，必填 API_KEY 与 OPENCODE_SERVER_PASSWORD
docker compose up -d
```

## 💻 本地 Node 部署

```bash
# 安装 OpenCode CLI
npm install -g opencode-ai
# 或 curl -fsSL https://opencode.ai/install | bash

git clone https://github.com/PaiMonCai/opencode-gateway.git
cd opencode-gateway
npm install
cp config.json.example config.json
npm start
```

## ✅ 验证服务

```bash
# 健康检查
curl http://127.0.0.1:10000/health

# 模型列表
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:10000/v1/models
```

## 💡 快速测试

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

## ➡️ 下一步

- ⚙️ [Configuration](./configuration.md) — 全部配置选项
- 🐳 [Docker Deployment](./docker.md) — Docker 部署详情
