# 🔧 故障排查

## ❓ 常见问题

### 请求卡住，但 `/v1/models` 正常

设置 `OPENCODE_USE_ISOLATED_HOME=false`，让 OpenCode 复用本机登录态：

```env
OPENCODE_USE_ISOLATED_HOME=false
```

### 免费模型报 `free tier can only be used from within OpenCode`

两种成因，先看是谁报的：

1. **直连上游报 `403 FreeTierError`**（响应体是 `{"type":"error","error":{"type":"FreeTierError",...}}`）：说明这个模型属于免费档，而免费档只能在官方客户端里用。中间件会自动把它记成"仅 runtime 可用"并回退到本地 runtime；若你关掉了 `OPENCODE_PROXY_DIRECT_FALLBACK`，打开即可。带 `-free` 后缀的模型本来就会直接走 runtime，不会出现这个错。
2. **本地 runtime 报同样的错误**：后端没有加载工具锁插件。让代理自己拉起后端（默认 `MANAGE_BACKEND=true`），或把 `plugin/opencode-gateway-tool-lock.js` 加入自建后端的 `plugin` 配置。

### 直连返回 `401 Invalid API key.` / 上游额度相关错误

```json
{"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}
```

这是**上游原生响应**，说明直连链路正常但凭据不对/无该额度：检查 `OPENCODE_ZEN_API_KEY`（Go 订阅需要该账号有 Go 权益；付费 Zen 需要余额）。想让它自动回退到 runtime，保持 `OPENCODE_PROXY_DIRECT_FALLBACK=true`（默认）。

### 直连返回 `ModelError: ... is not supported for format openai`

上游 `/responses` 是**按模型**提供格式的：部分模型只有 `chat/completions` 格式。换用 `POST /v1/chat/completions`，或换一个支持该格式的模型。

### 报 `503 conversation_busy`

同一段对话的上一个请求还没结束（超过「请求超时 + 60 秒」）。常见于客户端并发发同一 `session-id`，或某轮上游卡住。稍等重试；若频繁出现，检查上游是否在长时间不响应。

### 报 `503 session_state_unavailable`

复用会话时读不到会话状态，代理拒绝返回可能过期的内容。直接重试；若持续出现，说明后端（runtime）不稳定，检查后端日志与 `/global/health`。

### 直连模式下客户端拿不到 usage / 字段缺失

中间件在直连时**原样转发**，因此上游不支持的可选字段（如 `stream_options.include_usage`）也不会被补齐。需要严格 OpenAI 语义时，改用 runtime 路径的模型（`-free`）或在上游支持后再开。

### 模型不存在（`model_not_found`）

确认模型 ID 与后端一致：

```bash
curl http://127.0.0.1:10000/v1/models
```

### 发送了 `reasoning_effort` 但没有推理输出

使用 `stream: true` 的 Responses API，并传 `reasoning.effort` 或 `reasoning_effort`。

### 客户端意外触发 OpenCode 内置工具

保持 `OPENCODE_DISABLE_TOOLS=true`。

### 端口冲突（`EADDRINUSE`）

```bash
# 检查占用
lsof -i :10000
lsof -i :10001

# 更换端口
OPENCODE_PROXY_PORT=10002
OPENCODE_SERVER_PORT=10003
```

### OpenCode 未安装（`Cannot verify OpenCode installation`）

```bash
npm install -g opencode-ai
# 或 curl -fsSL https://opencode.ai/install | bash
```

也可通过 `OPENCODE_PATH` 指定可执行文件完整路径。

### Docker 容器无法启动

```bash
docker compose logs
netstat -tulpn | grep -E '10000|10001'
```

### 认证失败（`401 Unauthorized`）

确认请求携带了与 `API_KEY` 一致的 Bearer Token：

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" ...
```

## 🔍 调试模式

```env
OPENCODE_PROXY_DEBUG=true
```

调试日志会输出详细的请求和响应信息。

## 🆘 获取帮助

- 🐛 [GitHub Issues](https://github.com/PaiMonCai/opencode-gateway/issues)
