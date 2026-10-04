# 🐳 Docker 部署

## 🚀 快速开始

```bash
git clone https://github.com/PaiMonCai/opencode-gateway.git
cd opencode-gateway
cp .env.example .env      # 至少填 API_KEY 与 OPENCODE_SERVER_PASSWORD
docker compose up -d

# 验证
curl http://127.0.0.1:10000/health
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:10000/v1/models
```

镜像默认从 `ghcr.io/paimoncai/opencode-gateway:latest` 拉取；`docker compose build` 也可以用仓库里的 `Dockerfile` 本地构建（compose 文件里同时写了 `image:` 和 `build:`）。

## 🧱 镜像与运行方式

- 基础镜像 `node:24-slim`；生产依赖用 `npm ci --omit=dev` 单独一层安装，改源码不会重装依赖。
- 镜像内装有 `opencode-ai` CLI（`OPENCODE_PATH=opencode` 的默认值），所以默认由代理自己拉起并管理后端（`OPENCODE_PROXY_MANAGE_BACKEND=true`）。
- **容器不是 root 运行**：`entrypoint.sh` 先按 `PUID`/`PGID` 调整 `node` 账户、修正两个 OpenCode 卷的属主，然后用 `gosu` 切到 `node` 执行 `node index.js`。信号与退出码都归属真正的主进程。
- `PUID`/`PGID` 默认取镜像内 `node` 账户的 id（1000:1000），NAS 上按自己的用户改即可；用 `docker run --user` 自带用户启动时，入口脚本会跳过这步。
- `OPENCODE_PROXY_PROMPT_MODE=plugin-inject` 时，入口脚本会在配置卷里生成一个空插件与对应的 `opencode.json`（`/home/node/.config/opencode/`），让后端插件保持无操作；其余模式不动配置卷。

## ⚙️ 配置

配置优先级：**环境变量 > config.json > 默认值**。compose 已把 `docs/zh/configuration.md` 里的变量全部透传（值写成 `${VAR:-默认值}`），所以只改 `.env` 就够了；完整清单与含义见[配置详解](./configuration.md)。

常用项：

```env
# 必填
API_KEY=change-me
OPENCODE_SERVER_PASSWORD=change-me-too

# 上游凭据：配好后 Go/付费 Zen 走直连，免费档走本地 runtime
OPENCODE_ZEN_API_KEY=your-opencode-key

# 安全：默认就禁用模型内置工具
OPENCODE_DISABLE_TOOLS=true

# 会话：网关透传不了自定义头时打开推导模式
OPENCODE_PROXY_SESSION_REUSE=true
OPENCODE_PROXY_SESSION_DERIVE=true

# 提示词：客户端自己管 prompt 时常用这一组
OPENCODE_PROXY_PROMPT_MODE=plugin-inject
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
```

## 📦 卷与目录

| 卷名 | 容器内路径 | 说明 |
|:-----|:----------|:-----|
| `opencode-data` | `/home/node/.local/share/opencode` | OpenCode 数据目录 |
| `opencode-config` | `/home/node/.config/opencode` | OpenCode 配置目录（`plugin-inject` 生成的文件也在这里） |

源码在构建时复制到镜像内的 `/home/node/project`，默认不挂载宿主机目录，避免覆盖镜像里的 `node_modules`。需要自定义 `config.json` 时，单独挂载一个文件即可：

```bash
-v "$PWD/config.json:/home/node/project/config.json:ro"
```

## 🔨 自定义构建与单容器运行

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

只想用 Go 订阅或付费 Zen 时，可以完全不要本地 runtime：设置 `OPENCODE_ZEN_API_KEY`、把 `OPENCODE_PROXY_MANAGE_BACKEND=false`，模型清单与请求都由直连上游提供。

## ✅ 健康检查

镜像自带 `HEALTHCHECK`，compose 里也有一份等价配置；两者都在**容器内**请求 `/health`，所以发布到宿主机的端口与 `OPENCODE_PROXY_PORT` 不同也能正常工作：

```yaml
healthcheck:
  test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:$${OPENCODE_PROXY_PORT:-10000}/health"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 60s
```

## 📊 日志

```bash
docker compose logs -f
```

compose 已配置 json-file 轮转（单个 10 MB、保留 3 个），避免日志把磁盘写满：

```yaml
logging:
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"
```

`OPENCODE_PROXY_DEBUG=true` 时日志变成人类可读格式（默认是 JSON 行）。

## 🧪 测试

```bash
npm run test:integration   # 构建镜像 + 起容器 + 跑 HTTP 集成检查，需要 Docker
npm run test:stream        # 对真实网关跑流式冒烟，需要真机模型（可用 test:streaming-real）
```

`test:integration` 的退出码：`0` 全通过、`1` 有检查失败、`2` 缺少 Docker/守护进程/curl（此时不会做任何测试，只打印原因）。常用环境变量：`TEST_PORT`、`TEST_API_KEY`、`IMAGE_TAG`、`KEEP_CONTAINER=1`（保留容器排查）、`SKIP_MODEL_TESTS=1`（离线跳过需要真实模型的检查）、`PROBE_VIA=exec`（用 `docker exec` 在容器内发请求；发布端口在宿主机不可达时——rootless/远程守护进程——用这个）。

`test:stream` 的退出码：`0` 通过、`1` 有检查失败、`2` 网关不可达。常用环境变量：`BASE_URL`、`API_KEY`、`MODEL`、`CHECK_TOOLS=1`（额外验证流式工具调用）。

### 走代理出网

只能通过 SOCKS 出网时（例如公司代理）：

```bash
docker run -d --name opencode-gateway \
  -p 10000:10000 \
  -e API_KEY=your-key \
  -e OPENCODE_SERVER_PASSWORD=your-password \
  -e OPENCODE_PROXY_UPSTREAM_PROXY=socks5h://user:pass@10.0.0.9:1080 \
  -e OPENCODE_ZEN_API_KEY=your-opencode-key \
  -v opencode-data:/home/node/.local/share/opencode \
  -v opencode-config:/home/node/.config/opencode \
  ghcr.io/paimoncai/opencode-gateway:latest
```

该变量同时作用于**直连上游**与**托管的 runtime**（免费档的出站也走代理）。只想让直连走代理时加 `-e OPENCODE_PROXY_UPSTREAM_PROXY_FOR_RUNTIME=false`；也可以用标准 `-e ALL_PROXY=...`（此时子进程本来就继承，效果相同）。环回流量（runtime/健康检查）永不走代理。

## ❓ 常见问题

- **容器起不来**：`docker compose logs` 看日志；确认宿主端口没被占用。
- **挂载目录权限不对**：把 `PUID`/`PGID` 设成宿主机上的用户 id；入口脚本会在启动时修正两个卷的属主。
- **免费档模型报 403 FreeTierError**：这是上游对官方客户端身份的校验，保持 `OPENCODE_PROXY_MANAGE_BACKEND=true` 让代理拉起后端即可。
- **想换镜像命名空间**：改 compose 里的 `image:`，或只用 `build:`。
