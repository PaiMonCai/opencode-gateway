# 💻 开发指南

## 📋 环境准备

```bash
node --version    # 需要 18+
npm install

# 安装 OpenCode CLI
npm install -g opencode-ai
# 或 curl -fsSL https://opencode.ai/install | bash
```

## 🚀 本地运行

```bash
cp config.json.example config.json
npm start
```

启动后会按需拉起 OpenCode 后端并启动代理服务。

## ✅ 测试

| 命令 | 说明 |
|:-----|:-----|
| `npm test` | 全部单元测试（Jest，`tests/unit`） |
| `npm run test:integration` | Docker 集成测试 |
| `npm run test:stream` | 真机流式冒烟测试（手动） |

Docker 环境验证：

```bash
docker compose up -d --build
docker compose logs -f
```

## 📂 项目结构

```
opencode-gateway/
├── index.js                       # 入口与配置加载（env / config.json / 启动横幅）
├── src/
│   ├── proxy.js                   # 中间件主体：路由、会话、双上游、工具策略
│   ├── upstream/
│   │   └── direct-client.js       # 直连 OpenCode 端点：指纹头、SSE 回写、模型目录
│   └── tool-runtime/              # 文本工具契约（仅 runtime 路径用：contracts/parser/policy/registry/router/validator）
├── plugin/
│   ├── opencode-gateway-tool-lock.js  # 后端插件：按会话标题里的策略拦截工具
│   └── tool-lock.js                   # 全禁用版本
├── tests/
│   ├── unit/                      # Jest 单元测试（npm test）：app / session-reuse / direct-upstream / tool-lock / parser
│   ├── integration/               # Docker 集成测试
│   └── manual/                    # 真机冒烟测试，不进 CI
├── docs/                          # 文档（zh/ + en/）
├── entrypoint.sh                  # Docker 入口脚本
├── Dockerfile
└── docker-compose.yml
```

> 两条上游路径：`src/proxy.js` 里的会话层负责"同一个对话 = 同一个会话身份"，`src/upstream/direct-client.js` 负责直连；本地 runtime 只服务免费档模型。改这两处时请一起跑 `tests/unit/session-reuse.test.js` 与 `tests/unit/direct-upstream.test.js`。

## 📝 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat: add new feature
fix: fix bug
docs: update documentation
refactor: refactor code
test: add tests
chore: update build/ci
```

## 🔄 贡献流程

1. 从 `main` 拉功能分支：`git checkout -b feature/your-feature`
2. 提交更改，确保 `npm test` 通过（当前 197 个用例）
3. 推送分支并创建 Pull Request；推送 `main` 会触发镜像构建（`.github/workflows/docker-publish.yml`）

详见 [CONTRIBUTING.md](../../CONTRIBUTING.md)。

## 📄 许可证

MIT License · 详见 [LICENSE](../../LICENSE.md)
