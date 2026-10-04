# 🐳 Docker 部署

## 🚀 快速开始

```bash
git clone https://github.com/PaiMonCai/opencode-gateway.git
cd opencode-gateway
cp .env.example .env    # 编辑 .env，必填 API_KEY 与 OPENCODE_SERVER_PASSWORD
docker compose up -d

# 验证
curl http://127.0.0.1:10000/health
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:10000/v1/models
```

## ⚙️ 配置

`.env` 常用项（完整列表见 [配置详解](./configuration.md)）：

```env
# 必填
API_KEY=change-me
OPENCODE_SERVER_PASSWORD=change-me-too

# 上游凭据：配好后 Go/付费 Zen 走直连，免费档走本地 runtime
OPENCODE_ZEN_API_KEY=your-opencode-key

# 安全
OPENCODE_DISABLE_TOOLS=true

# 会话（网关无法透传自定义头时打开推导模式）
OPENCODE_PROXY_SESSION_REUSE=true
OPENCODE_PROXY_SESSION_DERIVE=true

# 可选
OPENCODE_PROXY_PROMPT_MODE=plugin-inject
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=true
```

> 镜像名默认 `ghcr.io/paimoncai/opencode-gateway:latest`；自建时改成自己的命名空间。只用 Go/付费 Zen 时可以把 `OPENCODE_SERVER_URL` 指向不可达地址（`OPENCODE_PROXY_MANAGE_BACKEND=false`），镜像里不需要跑 runtime。

## 📦 卷挂载

| 卷名 | 容器内路径 | 说明 |
|:-----|:----------|:-----|
| `opencode-data` | `/home/node/.local/share/opencode` | OpenCode 数据目录 |
| `opencode-config` | `/home/node/.config/opencode` | OpenCode 配置目录 |

项目源码在构建时复制到镜像内的 `/home/node/project`，默认不挂载宿主机目录，避免覆盖镜像内已安装的 `node_modules`。

## 🔨 自定义构建

```bash
# 构建镜像
docker build -t my-opencode-gateway .

# 运行单个容器
docker run -d \
  -p 10000:10000 \
  -e API_KEY=your-key \
  -e OPENCODE_SERVER_PASSWORD=your-password \
  -v opencode-data:/home/node/.local/share/opencode \
  -v opencode-config:/home/node/.config/opencode \
  my-opencode-gateway
```

## 📊 日志管理

```bash
# 查看日志
docker compose logs -f
```

推荐在 Compose 中配置日志轮转：

```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
```

## ✅ 健康检查

Compose 已内置健康检查：

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:10000/health"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 60s
```

## ❓ 常见问题

- **容器无法启动**：`docker compose logs` 查看日志，确认端口未被占用。
- **挂载权限问题**：确保 PUID/PGID 配置正确（默认 1000:1000）。
