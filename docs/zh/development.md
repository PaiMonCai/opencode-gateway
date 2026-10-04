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

## ✅ 测试与门禁

```bash
npm run lint          # ESLint（flat config，含 plugin/）
npm run format:check  # Prettier 校验
npm run typecheck     # tsc --checkJs（JSDoc 类型）
npm test              # 单元测试（tests/unit）
npm run test:contract # 对外契约（tests/contract，api-reference 逐条）
npm run test:verify   # 独立验证套件（tests/verification）
npm run test:all      # 以上三套测试一次跑完
npm run test:coverage # 覆盖率
npm run test:one -- tests/unit/conversation/registry.test.js --runInBand  # 跑单个文件
```

> 所有 Jest 调用都必须经过 npm 脚本（脚本已带 `NODE_OPTIONS=--experimental-vm-modules`）；裸 `npx jest` 在 ESM 下会报 `Cannot use import statement outside a module`。
> 测试不依赖网络、不依赖真实 OpenCode runtime、不绑定固定端口（stub 服务器用端口 0）。CI（`.github/workflows/ci.yml`）在 push/PR 上跑 lint → format:check → typecheck → 单测 → 契约测试。

## 📂 项目结构

```
opencode-gateway/
├── index.js                       # 组装与启动（加载配置 → 建 registry/router → 起 HTTP）
├── src/
│   ├── app.js                     # createApp：把 http 层与 routes 装到 express
│   ├── server.js                  # 监听、优雅退出、托管 runtime 子进程、启动横幅
│   ├── config/                    # env + config.json → 校验后的 Config（生效默认值、脱敏）
│   ├── logging/                   # 结构化日志（JSON 行/人类可读、child scope、自动脱敏）
│   ├── errors/                    # GatewayError 体系 + OpenAI 形状映射 + 瞬态判定
│   ├── http/                      # CORS、body 限制、Bearer 鉴权、请求 id、abort signal
│   ├── conversation/              # 会话层：identity / store / planner / baseline / registry
│   ├── upstreams/                 # direct 客户端、runtime 客户端、router（含免费档学习）
│   ├── tools/                     # 文本工具契约：contract / parser / registry / policy / validator / router
│   └── routes/                    # health / models / chat / responses / engine
├── plugin/                        # 后端插件：按会话标题里的策略拦截工具
├── tests/
│   ├── unit/                      # 逐模块单测（npm test）
│   ├── contract/                  # 对外 HTTP 契约（api-reference 逐条）
│   ├── verification/              # 独立验证（不依赖模块作者的自测夹具）
│   ├── integration/               # Docker 集成测试
│   └── manual/                    # 真机流式冒烟，不进 CI
├── docs/                          # 文档（zh/ + en/）+ ARCHITECTURE.md / BEHAVIOUR-SPEC.md
├── entrypoint.sh / Dockerfile / docker-compose.yml
└── 工具链：eslint.config.js · .prettierrc · tsconfig.json(checkJs) · .nvmrc · .github/workflows/ci.yml
```

> 分层依赖是单向的：`routes` → `conversation` + `upstreams` → `config`/`logging`/`errors`；只有 `upstreams` 知道 SDK 与 fetch，只有 `http`/`routes` 知道 `req`/`res`。改动的验收口径见 `docs/ARCHITECTURE.md`（契约与 8 条会话不变量）与 `docs/BEHAVIOUR-SPEC.md`（线级行为）。

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
2. 提交更改，确保 `npm run test:all` 通过（unit + contract + 独立验证三套）
3. 推送分支并创建 Pull Request；推送 `main` 会触发镜像构建（`.github/workflows/docker-publish.yml`）

详见 [CONTRIBUTING.md](../../CONTRIBUTING.md)。

## 📄 许可证

MIT License · 详见 [LICENSE](../../LICENSE.md)
