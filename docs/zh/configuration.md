# ⚙️ 配置详解

配置优先级：**环境变量 > config.json > 默认值**。

环境变量统一使用 `OPENCODE_` 前缀；config.json 使用对应的短名（见下表）。

### 变量分三档

- **核心（必须知道）**：`API_KEY`、`OPENCODE_SERVER_PASSWORD`（这两个建议都设）；`OPENCODE_ZEN_API_KEY`（要用 Go 订阅 / 付费 Zen 才需要）；`OPENCODE_PROXY_PORT`；`PUID`/`PGID`（NAS 权限）。
- **常用**：`OPENCODE_PROXY_OPS`、`OPENCODE_PROXY_STORAGE_CLEANUP`、`OPENCODE_DISABLE_TOOLS`、`OPENCODE_INTERNAL_ALLOWED_TOOLS`、`OPENCODE_PROXY_SESSION_DERIVE`、`OPENCODE_PROXY_REQUEST_TIMEOUT_MS`、`OPENCODE_PROXY_UPSTREAM_PROXY`、`OPENCODE_PROXY_DEBUG`。
- **高级**：表里其余项（上游 URL、事件超时、重试、提示词模式、会话头名单等），默认值已按免费档调好，通常不需要碰。

### 已收敛 / 已废弃的变量

下面这些名字**仍然可用**（设置了会生效），但启动时会打印一条废弃警告并给出替代写法；它们不再出现在本页的常规表格里。

- `OPENCODE_HEALTH_DETAILS_ENABLED` / `_REQUIRE_AUTH`、`OPENCODE_METRICS_ENABLED` / `_REQUIRE_AUTH` → 用 `OPENCODE_PROXY_OPS=off|health|full`
- `OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS`、`OPENCODE_PROXY_CLEANUP_INTERVAL_MS`、`OPENCODE_PROXY_CLEANUP_MAX_AGE_MS` → 用 `OPENCODE_PROXY_STORAGE_CLEANUP=off|hourly|daily`
- `OPENCODE_PROXY_DIRECT_FREE_VIA_RUNTIME` → 已移除：免费档的服务端闸门是“官方客户端身份”，**只能**由 runtime 代发，直连必然 403
- `OPENCODE_INTERNAL_TOOL_METRICS_ENABLED` → 已移除：内部工具计数始终收集；要用 `OPENCODE_PROXY_OPS=full` 暴露 `/metrics`
- `OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY` → 已移除：只有一种策略（同名工具加命名空间）
- `OPENCODE_TOOL_DISCOVERY_FIXTURE` → 已移除：测试专用开关

> 行为差异只有一处：`/health/details` 现在**总是**带上 `internal_tools.metrics` 计数（以前那个开关能把它置为 `null`）。

## 🔧 环境变量

### 服务与认证

| 环境变量 | config.json | 默认值 | 说明 |
|:---------|:------------|:-------|:-----|
| `OPENCODE_PROXY_PORT` / `PORT` | `PORT` | `10000` | 代理监听端口 |
| `BIND_HOST` | `BIND_HOST` | `0.0.0.0` | 监听地址 |
| `OPENCODE_SERVER_PORT` | - | `10001` | 后端端口，仅用于生成默认 `OPENCODE_SERVER_URL` |
| `OPENCODE_SERVER_URL` | `OPENCODE_SERVER_URL` | `http://127.0.0.1:10001` | OpenCode 后端地址 |
| `OPENCODE_SERVER_PASSWORD` | `OPENCODE_SERVER_PASSWORD` | (空) | 后端认证密码 |
| `API_KEY` | `API_KEY` | (空) | 代理的 Bearer 认证密钥，未配置则不鉴权 |
| `OPENCODE_PROXY_MANAGE_BACKEND` | `MANAGE_BACKEND` | `true` | 由代理拉起并管理 OpenCode 后端进程，后端会加载工具锁插件 |
| `OPENCODE_PATH` | `OPENCODE_PATH` | `opencode` | OpenCode 可执行文件路径 |
| `OPENCODE_ZEN_API_KEY` | `ZEN_API_KEY` | (空) | Zen API Key，以 `OPENCODE_API_KEY` 传给代理拉起的后端，用于付费模型 |
| `OPENCODE_USE_ISOLATED_HOME` | `USE_ISOLATED_HOME` | `false` | 使用隔离的 OpenCode 配置目录 |

### 工具控制

| 环境变量 | config.json | 默认值 | 说明 |
|:---------|:------------|:-------|:-----|
| `OPENCODE_DISABLE_TOOLS` | `DISABLE_TOOLS` | `true` | 禁用 OpenCode 内置工具 |
| `OPENCODE_EXTERNAL_TOOLS_MODE` | `EXTERNAL_TOOLS_MODE` | `proxy-bridge` | 外部工具桥接模式，当前仅支持 `proxy-bridge` |
| `OPENCODE_INTERNAL_ALLOWED_TOOLS` | `INTERNAL_ALLOWED_TOOLS` | (空) | 请求未带 `tools` 时放行的内置工具，逗号分隔 |
| `OPENCODE_INTERNAL_WEB_FETCH_ENABLED` | `INTERNAL_WEB_FETCH_ENABLED` | `false` | 旧开关：未显式配置 allowlist 时，启用后默认放行 `web_fetch` |

### 提示词与会话

| 环境变量 | config.json | 默认值 | 说明 |
|:---------|:------------|:-------|:-----|
| `OPENCODE_PROXY_PROMPT_MODE` | `PROMPT_MODE` | `standard` | `standard` 或 `plugin-inject` |
| `OPENCODE_PROXY_OMIT_SYSTEM_PROMPT` | `OMIT_SYSTEM_PROMPT` | `false` | 忽略传入的 system prompt |
| `OPENCODE_PROXY_STORAGE_CLEANUP` | `STORAGE_CLEANUP` | `off` | 会话存储清理：`off` / `hourly` / `daily` |
| `OPENCODE_PROXY_REQUEST_TIMEOUT_MS` | `REQUEST_TIMEOUT_MS` | `180000` | 请求超时（毫秒） |
| `OPENCODE_PROXY_SESSION_REUSE` | `SESSION_REUSE_ENABLED` | `true` | 客户端带会话标识头时复用同一后端会话 |
| `OPENCODE_PROXY_SESSION_TTL_MS` | `SESSION_TTL_MS` | `1800000` | 会话空闲多久后关闭（毫秒） |
| `OPENCODE_PROXY_SESSION_HEADERS` | `SESSION_HEADER_NAMES` | (见下) | 识别会话身份的请求头，逗号分隔，按顺序取第一个非空值 |
| `OPENCODE_PROXY_SESSION_DERIVE` | `SESSION_DERIVE_ENABLED` | `false` | 没有会话头时，从请求内容推导会话身份（网关透传不了自定义头时用） |
| `OPENCODE_PROXY_DIRECT` | `DIRECT_ENABLED` | `true` | 直接请求 OpenCode 自有的 OpenAI 兼容端点（Go 订阅 / 付费 Zen） |
| `OPENCODE_PROXY_DIRECT_GO_URL` | `DIRECT_GO_BASE_URL` | `https://opencode.ai/zen/go/v1` | Go 订阅端点 |
| `OPENCODE_PROXY_DIRECT_ZEN_URL` | `DIRECT_ZEN_BASE_URL` | `https://opencode.ai/zen/v1` | 付费 Zen 端点 |
| `OPENCODE_PROXY_DIRECT_FALLBACK` | `DIRECT_FALLBACK_TO_RUNTIME` | `true` | 直连被拒绝（401/403）或网络失败时回退 runtime |
| `OPENCODE_PROXY_UPSTREAM_PROXY` | `UPSTREAM_PROXY` | (空) | 上游出站代理：`socks5h://`、`socks5://`、`socks4a://`、`socks4://`、`http://`、`https://`（支持 `user:pass@`）；也识别标准 `ALL_PROXY`/`HTTPS_PROXY`/`HTTP_PROXY` |
| `OPENCODE_PROXY_UPSTREAM_PROXY_FOR_RUNTIME` | `UPSTREAM_PROXY_FOR_RUNTIME` | `true` | 把同一个代理也交给托管的 runtime（免费档的出站同样需要代理时保持开启） |

### 会话复用

OpenAI 协议本身是无状态的，代理默认每个请求新建一个后端会话。但部分上游（OpenCode Zen/Go 的 `x-opencode-session`）要求同一次对话的每一轮都带上同一个会话身份，否则每轮都是"新对话"，提示词缓存与路由亲和全部失效。

开启复用后（默认开启），客户端只要在请求头里带上会话身份，代理就会：

1. 把该身份映射到一个后端会话，后续轮次复用同一个会话（上游因此看到稳定的 `x-opencode-session`）；
2. 只把**新增的轮次**发给后端（会话里已经有前面的轮次），客户端回显的上一轮 assistant 回答会自动跳过；
3. 会话身份 + 模型 + 工具策略共同决定映射关系，任一变化都会新建会话；
4. 只要客户端改写**已发送前缀的任何位置**（编辑、截断、重排），代理都会察觉并新建干净会话、重发完整历史；
5. 重试（上游瞬时错误）会轮换到新会话，并把完整历史重新发过去，不会让新会话只剩半截对话；
6. 空闲超过 TTL 后自动关闭该会话（默认 30 分钟，和 Responses API 的 `previous_response_id` 一致）；轮换、失败或超出会话上限时也会关闭旧会话。

默认识别的请求头（按优先级）：`x-opencode-session`、`x-session-id`、`x-thread-id`、`x-conversation-id`、`x-deepseek-harness-session-id`、`session-id`、`session_id`、`thread-id`、`thread_id`、`conversation-id`、`conversation_id`。

```bash
# 同一次对话的两轮请求：第二轮只发送新增内容，上游会话保持一致
curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" -H "session-id: conv-42" \
  -d '{"model":"opencode-go/kimi-k3","messages":[{"role":"user","content":"记住 41"}]}'

curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" -H "session-id: conv-42" \
  -d '{"model":"opencode-go/kimi-k3","messages":[
      {"role":"user","content":"记住 41"},
      {"role":"assistant","content":"OK"},
      {"role":"user","content":"我刚才让你记的数字是多少？"}]}'
```

> 不带任何会话头的客户端行为完全不变（每请求一个会话）。需要关闭时可设 `OPENCODE_PROXY_SESSION_REUSE=false`。

**错误码**：复用会话时如果读不到会话状态（无法区分上一轮与本轮的回答），请求会以 `503 session_state_unavailable` 失败而不是返回陈旧内容；同一会话已有请求在处理时，并发请求会拿到 `503 conversation_busy`（等待上限为请求超时 + 60 秒）。

### 双上游：直连与 runtime

中间件有两条通往 opencode 的路径，按模型自动选择：

| 模型 | 上游 | 说明 |
|:--|:--|:--|
| `opencode/*-free`（免费档） | **本地 runtime** | 免费档的服务端闸门是"官方客户端身份"，**普通 HTTP 客户端伪造全部头也过不去**（实测 `403 FreeTierError: OpenCode's free tier can only be used from within OpenCode`），只能由官方 runtime 代发 |
| `opencode-go/*`（Go 订阅） | **直连** `…/zen/go/v1` | 只校验 key，无客户端闸门（实测无 key 时为 `401 AuthError`） |
| `opencode/<付费>`（Zen 按量） | **直连** `…/zen/v1` | 同上，需 Zen 额度 |

直连模式下的行为：

- 请求体**原样转发**（上游本来就是 OpenAI 兼容协议）——工具调用原生直通，不再走文本契约，`tools` / `tool_choice` / `stream` / `reasoning_effort` 等字段照传；
- 只加三样东西：上游 key（`OPENCODE_ZEN_API_KEY`）、官方客户端指纹头（`User-Agent` / `x-opencode-client` / `x-opencode-project` / `x-opencode-request`）、会话身份头 `x-opencode-session`（值 = 上一节讲的会话亲和 id，同一对话始终相同）；
- 上游响应**原样回传**（含错误码、限流、SSE 流），只把 `model` 字段改回客户端请求的模型名；
- 直连返回 `401/403`（key 无效 / 无该额度）或网络失败时，自动回退到本地 runtime（可用 `OPENCODE_PROXY_DIRECT_FALLBACK=false` 关掉，让错误原样暴露）。

> 没配 `OPENCODE_ZEN_API_KEY` 时直连不会启用，全部请求仍走 runtime（免费档照常可用）。

### 出站代理（SOCKS / HTTP）

直连上游的出站请求可以走代理，部署在只能用 SOCKS 出网的环境时用得上：

```bash
# SOCKS5（由代理解析目标主机名，推荐）
OPENCODE_PROXY_UPSTREAM_PROXY=socks5h://user:pass@10.0.0.9:1080

# 也可以用标准变量，优先级更低：OPENCODE_PROXY_UPSTREAM_PROXY > ALL_PROXY > HTTPS_PROXY > HTTP_PROXY
ALL_PROXY=socks5h://10.0.0.9:1080
```

行为要点：

- **只影响上游出站**（直连 `opencode.ai` 的 chat/responses 与模型目录）；本地 runtime、健康检查、SDK 这些环回流量**永远直连**——`localhost`、`127.0.0.0/8`、`::1` 自动绕过，避免把本地调用发到外部代理；
- `NO_PROXY`（逗号分隔，支持域名后缀如 `.example.com`、`host:port`、`*`）与上面这套绕行规则叠加生效；
- 免费档由本地 runtime 代发，**runtime 自己的出站也要走代理**才有用：默认开启透传，会把该代理写成子进程的 `ALL_PROXY`/`HTTPS_PROXY`/`HTTP_PROXY`（并附带 `NODE_USE_ENV_PROXY=1` 与含环回地址的 `NO_PROXY`）。只想让代理作用于直连上游时设 `OPENCODE_PROXY_UPSTREAM_PROXY_FOR_RUNTIME=false`；
- 只用标准 `ALL_PROXY`/`HTTPS_PROXY` 时**不会**自动透传给 runtime（子进程本来就继承容器环境，效果相同）；
- 启动横幅只打印 `scheme://***@host:port`，**不会泄漏凭据**；非法 scheme 在启动时直接报错（fail fast）。

直连覆盖的端点：

- `POST /v1/chat/completions` 与 `POST /v1/responses`（上游两个路由都存在）：请求体原样转发，`previous_response_id` 直接用上游返回的 id，代理不做干预；
- `GET /v1/models`：runtime 不可用（或列不出模型）时，自动改用直连上游的模型目录——`/models` 是公开接口，因此**没有 runtime 的部署也能提供模型清单**（结果 `opencode-go/<id>` 与 `opencode/<id>`，缓存 10 分钟）；模型**解析**（`model` 字段 → provider/model）也走同一目录，所以无 runtime 时 `chat/completions`、`responses`、`models` 三个端点都能独立工作；
- **免费档自动学习**：免费档模型不总是带 `-free` 后缀（例如 `opencode/big-pickle` 是免费但没后缀）。直连若收到 `403 FreeTierError`，代理会记住这个模型并从此直接走 runtime（1 小时内不再试探），因此"回退"最多只付一次代价。

> 注意：上游 `/responses` 路由存在，但**按模型区分**——部分模型只提供 OpenAI 的 `chat/completions` 格式，直连时会原样收到 `ModelError: ... is not supported for format openai`；这属于上游语义，代理不干预。

**没有会话头怎么办（推导模式）**：把 `OPENCODE_PROXY_SESSION_DERIVE=true` 打开后，代理用「客户端作用域（凭据 + 客户端地址 + 模型 + 工具策略）+ 首条消息」作为对话锚点，再用「已发送前缀」匹配续接：

- 任何只发标准 OpenAI 字段的网关都能拿到会话亲和性，无需透传任何头；
- 锚点相同、前缀也相同的**多重对话**（例如两个客户端都从 `hello` 开始、模型的回答也一字不差）**不会被合并**——代理宁可新开一个会话，也不把两个人的上下文混在一起；一旦两个对话的内容出现分歧，下一轮就能自动区分；
- 前缀相同时优先用「客户端回显的上一轮回答」来区分是哪一个对话。

**超时与断连**：`/v1/responses` 的非流式请求同样受 `REQUEST_TIMEOUT_MS` 保护（超时返回 `504 timeout`，不再无限等待上游）；客户端中途断开连接时，本轮会立即收尾，占用的会话锁随之释放，不会把该对话卡到空闲/请求超时。

**安全提示**：会话标识是**客户端可控**的输入。默认名单里的通用头（`session-id`、`thread-id` 等）如果被中间层统一填成同一个常量，多个客户端会共享同一个上游会话；需要严格隔离时请把 `OPENCODE_PROXY_SESSION_HEADERS` 收窄成你自己使用的那一个（例如 `x-deepseek-harness-session-id`）。另外 `prompt_tokens` / `input_tokens` 仍按完整对话估算，即使只发送了新增轮次。

### 诊断与调试

| 环境变量 | config.json | 默认值 | 说明 |
|:---------|:------------|:-------|:-----|
| `OPENCODE_PROXY_OPS` | `OPS` | `health` | 运维端点：`off`（只留 `/health`）/ `health`（加 `/health/details`）/ `full`（再加 `/metrics`）；两个详情端点始终要求 Bearer |
| `OPENCODE_PROXY_DEBUG` | `DEBUG` | `false` | 调试日志 |
| `OPENCODE_GATEWAY_EVENT_FIRST_DELTA_TIMEOUT_MS` | - | `30000` | 流式响应首个 delta 的超时 |
| `OPENCODE_GATEWAY_EVENT_IDLE_TIMEOUT_MS` | - | `8000` | 流式响应的空闲超时 |

## 📄 config.json 示例

```json
{
    "PORT": 10000,
    "API_KEY": "your-secret-api-key",
    "BIND_HOST": "0.0.0.0",
    "DISABLE_TOOLS": true,
    "EXTERNAL_TOOLS_MODE": "proxy-bridge",
    "INTERNAL_ALLOWED_TOOLS": ["web_fetch"],
    "USE_ISOLATED_HOME": false,
    "PROMPT_MODE": "standard",
    "OMIT_SYSTEM_PROMPT": false,
    "STORAGE_CLEANUP": "off",
    "REQUEST_TIMEOUT_MS": 180000,
    "DEBUG": false,
    "OPENCODE_SERVER_URL": "http://127.0.0.1:10001",
    "OPENCODE_PATH": "opencode"
}
```

## 🛠️ 工具控制详解

### 外部工具桥接

- 客户端传入的 `tools` 不会注册为 OpenCode 内置工具，由代理虚拟化后交给模型使用。
- 模型输出会被整理为 OpenAI 兼容的 `tool_calls` / `function_call` 返回给客户端。
- 同名冲突通过内部命名空间隔离（如 `external__web_fetch`），命名空间名是内部实现细节，不属于公开 API。
- 一旦请求显式传入 `tools`，OpenCode 内置工具在该请求中保持禁用。

### 工具锁插件

OpenCode Zen 免费模型只接受工具列表与官方客户端一致的请求，按请求关闭工具会被拒绝（`free tier can only be used from within OpenCode`）。因此代理拉起后端时会加载 `plugin/opencode-gateway-tool-lock.js`：工具列表保持原样，工具策略写在会话标题里，由插件在执行时拦截。

- 使用自行启动的后端（`MANAGE_BACKEND=false`）时，需要把该文件的绝对路径加入后端配置的 `plugin` 列表，否则代理退回按请求关闭工具，免费模型会被拒绝。

### 内置工具 allowlist

- 请求 **未传入** `tools` 时，代理进入 internal allowlist 模式，只允许 `OPENCODE_INTERNAL_ALLOWED_TOOLS` 声明的内置工具。
- 工具名比较时忽略大小写和下划线，`web_fetch` 等同于 OpenCode 的 `webfetch`。
- `OPENCODE_INTERNAL_WEB_FETCH_ENABLED=true` 是兼容旧配置的快捷方式：未显式配置 allowlist 时视为 `web_fetch`。
- 内部工具计数（模式选择、工具发现、命中结果、降级原因）**始终收集**，只在 `/metrics` 暴露；日志里不记录工具返回内容。

### 请求级 allowlist 覆盖

请求未传入 `tools` 时，可在请求体中传 `opencode.internal_allowed_tools` 覆盖服务端默认 allowlist。出于安全隔离，覆盖**只能缩小（求交集），不能扩大**：

```json
{
  "model": "opencode/kimi-k2.5",
  "messages": [{"role": "user", "content": "Fetch this URL"}],
  "opencode": {
    "internal_allowed_tools": ["web_fetch"]
  }
}
```

## 📊 健康诊断与指标

- `/health` 始终是轻量健康检查。
- `/health/details` 返回结构化诊断 JSON（`OPENCODE_HEALTH_DETAILS_ENABLED=false` 时返回 404，`OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH=true` 时要求认证）：

```json
{
  "status": "ok",
  "proxy": true,
  "internal_tools": {
    "config": {
      "allowed_tools": ["web_fetch"],
      "metrics_enabled": true,
      "discovery_fixture": []
    },
    "metrics": {
      "externalBridgeRequests": 12,
      "internalAllowlistRequests": 8,
      "disabledRequests": 21,
      "discoveryFailures": 1,
      "fallbackToDisabled": 2
    },
    "cache": {
      "tool_ids_cached": true,
      "tool_id_count": 1,
      "age_ms": 12000
    }
  }
}
```

- `/metrics` 返回 Prometheus 文本格式（`OPENCODE_METRICS_ENABLED=false` 时返回 404）：

```text
opencode_internal_tool_mode_requests_total{mode="external_bridge"}
opencode_internal_tool_mode_requests_total{mode="internal_allowlist"}
opencode_internal_tool_mode_requests_total{mode="disabled"}
opencode_internal_tool_discovery_failures_total
opencode_internal_tool_fallback_disabled_total
opencode_internal_tool_cache_ids
```

## 🎯 Prompt Mode

| 模式 | 说明 |
|:-----|:-----|
| `standard`（默认） | 标准模式，完整处理提示词 |
| `plugin-inject` | 插件注入模式，减小模型侧提示词大小，通常与 `OMIT_SYSTEM_PROMPT=true` 配合使用 |

## ⭐ 推荐配置

### Docker 生产环境

```env
API_KEY=your-secret-key
OPENCODE_SERVER_PASSWORD=your-password
OPENCODE_DISABLE_TOOLS=true
OPENCODE_INTERNAL_ALLOWED_TOOLS=web_fetch
OPENCODE_PROXY_PROMPT_MODE=plugin-inject
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=true
```

### 本地开发

```env
OPENCODE_DISABLE_TOOLS=false
OPENCODE_PROXY_DEBUG=true
```
