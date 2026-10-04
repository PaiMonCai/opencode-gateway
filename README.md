# OpenCode Gateway

<p align="center">
  <img src="https://img.shields.io/badge/version-3.0.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/Node.js-18+-orange" alt="Node">
</p>

简体中文 | [English](./README.en.md)

**任何 OpenAI 兼容网关（NewAPI / LiteLLM / one-api …）与 [OpenCode](https://opencode.ai) 之间的兼容层。**

客户端照常用 OpenAI 协议请求，中间件负责消除 NewAPI ⇄ OpenCode 之间的不兼容：把无状态对话重组成 OpenCode 的会话（上游要的会话身份头、多轮上下文复用），并把请求规范化成 OpenCode 能接受的样子。Go 订阅 / 付费 Zen 模型**直连** OpenCode 的 OpenAI 兼容端点，免费档模型交给本地 runtime 代发。

## ✨ 功能特性

- **OpenAI 兼容** — `/v1/models`、`/v1/chat/completions`、`/v1/responses`，完整 SSE 流式输出
- **推理控制** — 支持 `reasoning_effort` 与 `reasoning: {"effort": "high"}`
- **会话续接** — Responses API 支持 `previous_response_id`，30 分钟 TTL，到期自动清理上游会话
- **双上游** — Go 订阅/付费 Zen 模型直连 OpenCode 的 OpenAI 兼容端点（请求原样转发、工具原生直通、响应原样回传），免费档模型由本地 runtime 代发（其闸门无法用请求头绕过）
- **会话复用** — 客户端用 `session-id` / `x-deepseek-harness-session-id` 等请求头标识对话时，多轮请求复用同一个后端会话，只有新增轮次发给上游；网关透传不了自定义头时可用 `SESSION_DERIVE_ENABLED` 从请求内容推导会话
- **外部工具桥接** — 客户端传入 `tools`，代理返回标准 `tool_calls` / `function_call`，不触发 OpenCode 内置工具
- **内置工具 allowlist** — 请求未带 `tools` 时，仅放行 `OPENCODE_INTERNAL_ALLOWED_TOOLS` 声明的内置工具
- **可观测性** — `/health/details` 结构化诊断，`/metrics` Prometheus 指标
- **Docker 部署** — 一键启动，自动拉起 OpenCode 后端

## 🚀 快速开始

### Docker（推荐）

```bash
git clone https://github.com/PaiMonCai/opencode-gateway.git
cd opencode-gateway
cp .env.example .env        # 编辑 .env，必填 API_KEY 与 OPENCODE_SERVER_PASSWORD
docker compose up -d
curl http://127.0.0.1:10000/health
```

> 默认 Compose 配置不挂载宿主机项目目录，避免覆盖镜像内已安装的 `node_modules`。需要源码热更新时，请单独使用开发用的 Compose 覆盖文件。

> 只使用 Go 订阅 / 付费 Zen 时，可以完全不要本地 runtime：设 `OPENCODE_ZEN_API_KEY`，并把 `OPENCODE_SERVER_URL` 指向一个不可达地址即可（模型清单与模型解析会自动改用上游公开目录）。想用免费档才需要安装 OpenCode CLI 并由中间件托管后端。

### Node.js（本地开发）

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

## 💡 使用示例

### Chat Completions

```bash
curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "messages": [{"role": "user", "content": "你好!"}],
    "stream": false
  }'
```

### Responses API（流式 + 推理）

```bash
curl -N -X POST http://127.0.0.1:10000/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt5-nano",
    "input": "用一句话打招呼",
    "reasoning": {"effort": "high"},
    "stream": true
  }'
```

### 外部工具

```bash
curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "messages": [{"role": "user", "content": "帮我获取 https://example.com 的标题"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "web_fetch",
        "description": "Fetch a URL and return its content summary",
        "parameters": {
          "type": "object",
          "properties": {"url": {"type": "string"}},
          "required": ["url"]
        }
      }
    }]
  }'
```

模型决定调用工具时，非流式响应返回 `message.tool_calls`，流式响应返回 `delta.tool_calls`。

## ⚙️ 配置

| 环境变量 | 默认值 | 说明 |
|:--------|:-------|:-----|
| `API_KEY` | (空) | 代理的 Bearer 认证密钥 |
| `OPENCODE_SERVER_PASSWORD` | (空) | OpenCode 后端密码 |
| `OPENCODE_PROXY_PORT` / `PORT` | `10000` | 代理端口 |
| `OPENCODE_SERVER_PORT` | `10001` | 后端端口（未显式配置 `OPENCODE_SERVER_URL` 时生效） |
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:10001` | 后端地址（纯直连部署可指向不可达地址） |
| `OPENCODE_ZEN_API_KEY` | (空) | OpenCode 账号/订阅 key：配好后 Go 与付费 Zen 走直连，同时传给托管的 runtime |
| `OPENCODE_DISABLE_TOOLS` | `true` | 禁用 OpenCode 内置工具 |
| `OPENCODE_INTERNAL_ALLOWED_TOOLS` | (空) | 请求未带 `tools` 时放行的内置工具，逗号分隔 |
| `OPENCODE_PROXY_PROMPT_MODE` | `standard` | `standard` 或 `plugin-inject` |
| `OPENCODE_PROXY_OMIT_SYSTEM_PROMPT` | `false` | 忽略传入的 system prompt |
| `OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS` | `false` | 自动清理会话存储 |
| `OPENCODE_PROXY_SESSION_REUSE` | `true` | 客户端带会话标识头时复用同一后端会话 |
| `OPENCODE_PROXY_SESSION_TTL_MS` | `1800000` | 会话空闲多久后关闭（毫秒） |
| `OPENCODE_PROXY_SESSION_HEADERS` | (见文档) | 识别会话身份的请求头，逗号分隔 |
| `OPENCODE_PROXY_SESSION_DERIVE` | `false` | 无会话头时从请求内容推导会话身份（网关无法透传自定义头时用） |
| `OPENCODE_PROXY_DIRECT` | `true` | Go/付费 Zen 模型直连 OpenCode 端点（免费档仍走 runtime） |
| `OPENCODE_PROXY_DIRECT_GO_URL` | `https://opencode.ai/zen/go/v1` | Go 订阅端点 |
| `OPENCODE_PROXY_DIRECT_ZEN_URL` | `https://opencode.ai/zen/v1` | 付费 Zen 端点 |
| `OPENCODE_PROXY_DIRECT_FREE_VIA_RUNTIME` | `true` | 免费档模型仍走 runtime |
| `OPENCODE_PROXY_DIRECT_FALLBACK` | `true` | 直连被拒时回退 runtime |
| `OPENCODE_USE_ISOLATED_HOME` | `false` | 使用隔离的 OpenCode 配置目录 |
| `OPENCODE_PROXY_DEBUG` | `false` | 调试日志 |

> 📄 完整配置见 [配置详解](./docs/zh/configuration.md)

推荐生产配置：

```env
# 认证与后端
API_KEY=your-secret-key
OPENCODE_SERVER_PASSWORD=your-password

# 上游凭据（Go / 付费 Zen 走直连，免费档走 runtime）
OPENCODE_ZEN_API_KEY=your-opencode-key

# 会话：网关透传自定义头时用显式头；透传不了就开推导模式
OPENCODE_PROXY_SESSION_REUSE=true
OPENCODE_PROXY_SESSION_DERIVE=true

# 工具与提示词
OPENCODE_DISABLE_TOOLS=true
OPENCODE_INTERNAL_ALLOWED_TOOLS=web_fetch
OPENCODE_PROXY_PROMPT_MODE=plugin-inject
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=true
```

## 🔌 API 端点

| 方法 | 路径 | 说明 |
|:-----|:-----|:-----|
| `GET` | `/health` | 健康检查 |
| `GET` | `/health/details` | 结构化诊断（可配置开关/鉴权） |
| `GET` | `/metrics` | Prometheus 指标（可配置开关/鉴权） |
| `GET` | `/v1/models` | 模型列表 |
| `POST` | `/v1/chat/completions` | Chat Completions |
| `POST` | `/v1/responses` | Responses API |

模型名称写法：`opencode/big-pickle`、`gpt5-nano`（自动解析为 `gpt-5-nano`）、`opencode/gpt5-nano`。

> 📖 详见 [API 参考](./docs/zh/api-reference.md)

## 🔧 故障排查

- **请求卡住但 `/v1/models` 正常** — 设 `OPENCODE_USE_ISOLATED_HOME=false` 复用本地登录态
- **模型找不到** — `curl http://127.0.0.1:10000/v1/models` 确认模型 ID
- **没有推理输出** — 用 `stream: true` 的 Responses API，并传 `reasoning.effort`

> 📖 更多见 [故障排查](./docs/zh/troubleshooting.md)

## 📚 文档

| 文档 | 说明 |
|:-----|:-----|
| [快速开始](./docs/zh/getting-started.md) | 安装与首次运行 |
| [配置详解](./docs/zh/configuration.md) | 全部环境变量与 config.json |
| [API 参考](./docs/zh/api-reference.md) | 端点、参数与错误码 |
| [Docker 部署](./docs/zh/docker.md) | 部署与运维 |
| [故障排查](./docs/zh/troubleshooting.md) | 常见问题 |
| [开发指南](./docs/zh/development.md) | 本地开发与测试 |

## 📄 许可证

MIT · 详见 [LICENSE](./LICENSE.md)
