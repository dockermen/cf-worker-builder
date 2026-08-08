# ⚡ Worker 在线构建器（Cloudflare Worker 版）

一个部署在 **Cloudflare Workers** 上的「对话式 Worker 在线构建器」：

- 配置任意 **OpenAI 兼容** 大模型（Base URL / Key / 模型），即可接入 **DeepSeek**、OpenAI、Moonshot、GLM 等作为构建 Agent；
- 以 **项目** 为单位，用对话描述需求，Agent 生成完整的 Worker 代码并 **自动发布到 Cloudflare Workers**，直接返回可访问地址；
- **内置 Cloudflare 登录态**：支持「在线登录」（设备码 OAuth，类似 `wrangler login --device`，零配置浏览器授权）与手动 API Token，令牌持久化在 KV 且到期自动刷新，无需每次登录。

## ✨ 功能特性

| 需求 | 实现 |
| --- | --- |
| 1. 可配置 OpenAI Baseurl / Key / 模型 | 设置面板中保存，支持任意 OpenAI 兼容服务（DeepSeek 等），密钥脱敏显示 |
| 2. 以项目为单位创建，自动发布并给地址 | 项目 CRUD + 对话生成代码 + 自动部署到 workers.dev 并返回 URL，后续可在对话框继续提需求迭代修改 |
| 3. 内置 Cloudflare 登录态 | 支持「在线登录」（设备码 OAuth，类似 `wrangler login --device`，零配置浏览器授权）与手动 API Token；令牌持久化在 KV 且**到期自动刷新**，无需每次登录 |
| 4. 访问密码保护 | 进入构建器需输入密码（默认 `123456`），登录签发 7 天有效 token，后台可随时修改密码 |
| 5. 项目与远程 Worker 联动 | 构建器创建的项目删除时**同步删除远程 Worker**；支持**关联已有 Worker 项目**（拉取代码、对话修改、覆盖部署，删除项目不影响远程） |

其他细节：

- 💬 每个项目独立保存对话历史，支持多轮迭代修改（改功能、加路由、换样式…）；
- 🚀 自动部署 + 手动「部署」按钮 + 代码页「保存并部署」；
- 📄 内置代码编辑器，可手动改代码再部署；
- 🔁 部署失败不丢代码，对话里给出原因，可稍后重试；
- 🔗 可关联已有 Cloudflare Worker 项目继续编辑（显示「外部 Worker」徽章，删除仅移除本地）；
- 🎨 深色现代化界面，无需任何前端构建步骤。

## 🧱 技术架构

```
浏览器（public/index.html 单页应用）
        │  fetch
        ▼
Cloudflare Worker（src/index.js）
   ├── /api/* 路由
   │     ├── settings  → KV 保存 LLM 配置 + Cloudflare 登录态
   │     ├── projects  → KV 保存项目/对话历史/代码
   │     ├── chat      → 调用 OpenAI 兼容 chat/completions（Agent）
   │     └── deploy    → 调用 Cloudflare Workers REST API 上传脚本
   └── 其他路径 → env.ASSETS 静态资源
```

- **存储**：Workers KV（`BUILDER_KV`）——设置、项目列表、项目详情（含代码与对话历史）
- **Agent**：`src/agent.js` 封装 OpenAI 兼容接口，系统提示词约束模型输出「完整 ES Module Worker 代码」到 ```javascript 代码块
- **部署**：`src/deploy.js` 使用 Cloudflare 官方 REST API 上传脚本（multipart）并启用 workers.dev 子域
- **在线登录**：`src/oauth.js` 实现 OAuth 2.0 设备码流程（复用 Cloudflare 官方公开客户端 ID，零配置），access_token 过期后自动用 refresh_token 刷新

## 📁 目录结构

```
cf-worker-builder/
├── package.json          # 依赖与脚本（wrangler）
├── wrangler.toml         # Worker 配置（KV 绑定、静态资源）
├── public/
│   └── index.html        # 前端单页应用（对话/代码/设置）
└── src/
    ├── index.js          # 主入口 + API 路由
    ├── agent.js          # LLM Agent（OpenAI 兼容 chat/completions）
    ├── deploy.js         # Cloudflare 部署层（上传脚本、启用子域）
    ├── oauth.js          # Cloudflare 在线登录（设备码 OAuth + 令牌刷新）
    ├── store.js          # KV 数据访问层
    └── util.js           # 工具函数（slug、代码提取、脱敏等）
```

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 本地开发

```bash
npm run dev
# 打开 http://localhost:8787
```

本地开发使用内置的本地 KV（`wrangler.toml` 中的占位 id），无需真实 Cloudflare 账号即可体验界面与 API 流程；
配置真实的大模型 Key 后即可在本地完整跑通「对话 → 生成代码 →（配置真实 Cloudflare 凭据后）部署」。

### 3. 部署到 Cloudflare

```bash
# 3.1 创建 KV 命名空间（只需一次）
npx wrangler kv namespace create BUILDER_KV
# 把输出中的 id 填到 wrangler.toml 的 [[kv_namespaces]]

# 3.2 登录（首次部署需要，之后由构建器自己保存的 Token 承担运行时登录态）
npx wrangler login

# 3.3 发布
npm run deploy
# 发布后访问 https://cf-worker-builder.<你的子域>.workers.dev
```

## 🎯 使用说明

1. **配置大模型**：左下角「设置」→ 填写 OpenAI 兼容 Base URL（如 `https://api.deepseek.com`）、API Key、模型（如 `deepseek-chat`）。模型下拉框已内置常见模型预设。「接口类型」支持两种：`chat/completions`（兼容 DeepSeek 等，默认）与 `responses`（OpenAI Responses API，部分网关/模型使用）。
2. **配置 Cloudflare**（二选一，推荐方式一）：
   - **方式一 · 在线登录（推荐）**：点击「开始在线登录」，浏览器自动打开 Cloudflare 官方授权页，输入设备码并授权即可。无需手动创建任何 Token，登录态自动保存并在到期时自动刷新。
   - **方式二 · 手动 API Token**：填写 API Token 与 Account ID，点击「测试连接」验证并自动获取 workers.dev 子域。保存后即内置登录态，后续无需再登录。
3. **新建项目**：点击「＋ 新建项目」，填写名称与描述。
4. **对话构建**：在对话框描述需求，例如「做一个天气查询 API，GET /weather?city=北京 返回 JSON」。Agent 生成完整代码后自动部署，聊天记录中会出现 `✅ 已自动部署到：https://xxx.workers.dev`。
5. **迭代修改**：继续在对话框提新需求（如「加一个 /about 页面」），Agent 会基于历史对话修改代码并重新部署，地址保持不变。
6. **手动部署**：对话页「🚀 部署」按钮；或切到「代码」页编辑后点「保存并部署」。
7. **关联已有 Worker**：新建项目对话框切到「关联已有 Worker」，输入 Cloudflare 中的脚本名，构建器自动拉取代码；之后可在对话中修改并覆盖部署。该项目显示「外部 Worker」徽章，删除时只移除本地记录、不影响远程。
8. **删除联动**：构建器自己创建的项目删除时会同时删除 Cloudflare 上对应的 Worker；关联的外部 Worker 项目不会被删除。
9. **访问密码**：进入页面需输入密码（默认 `123456`），登录后可在「设置 → ③ 访问密码」中修改。

## 🔌 API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 全局状态（脱敏设置 + 项目列表） |
| POST | `/api/settings` | 保存 LLM 配置与 Cloudflare 登录态（留空字段保持原值） |
| POST | `/api/test-cf` | 测试 Cloudflare 凭据并返回 workers.dev 子域 |
| POST | `/api/oauth/start` | 发起在线登录（设备码），返回授权地址与设备码 |
| GET | `/api/oauth/status` | 轮询授权状态；授权完成后自动换取并保存令牌 |
| POST | `/api/oauth/refresh` | 手动刷新 access_token |
| POST | `/api/oauth/logout` | 退出登录（撤销令牌） |
| POST | `/api/auth/login` | 访问密码登录，返回 7 天有效 token |
| GET | `/api/auth/check` | 校验当前 token 是否有效 |
| POST | `/api/auth/password` | 修改访问密码（需旧密码） |
| POST | `/api/projects/import` | 关联已有 Cloudflare Worker 项目 |
| GET/POST | `/api/projects` | 项目列表 / 创建项目 |
| GET/DELETE | `/api/projects/:id` | 项目详情 / 删除 |
| POST | `/api/projects/:id/chat` | 对话（`{message, autoDeploy}`），自动提取代码并部署 |
| POST | `/api/projects/:id/deploy` | 手动部署当前代码 |
| PUT | `/api/projects/:id/code` | 更新代码 |
| POST | `/api/projects/:id/clear` | 清空对话历史 |

## 🔑 Cloudflare 凭据获取

### 方式一：在线登录（推荐，无需创建 Token）

在构建器「设置 → ② Cloudflare」中点击「开始在线登录」：

1. 构建器向 Cloudflare 申请设备码，并自动打开官方授权页面 `dash.cloudflare.com/oauth2/device/verify`；
2. 在弹出的页面中输入显示的**设备码**（或直接确认已自动打开的授权页）；
3. 登录你的 Cloudflare 账号并点击 **Allow / 授权**；
4. 构建器自动完成登录，显示已登录账号与 workers.dev 子域。

该方式复用 Cloudflare 官方（wrangler）公开的 OAuth 客户端，**零配置**；若官方客户端被限制，可在 `wrangler.toml` 的 `[vars]` 中配置自建 OAuth 客户端的 `OAUTH_CLIENT_ID`（创建位置：dash.cloudflare.com → 账号 → **Manage Account → OAuth clients** → Create client，流程选 Authorization Code，权限勾选 Workers Scripts → Edit 等）。

### 方式二：手动 API Token

1. 打开 [dash.cloudflare.com](https://dash.cloudflare.com) 并登录；
2. 点击右上角**头像 → My Profile（我的个人资料）→ API Tokens → Create Token（创建令牌）**；
3. 模板区选择 **「Edit Cloudflare Workers（编辑 Cloudflare Workers）」** → Use template（或自定义，权限至少勾选：Account → Workers Scripts → **Edit**、Account Settings → Read）；
4. 点击 **Continue to summary → Create Token**，复制生成的 Token；
5. **Account ID** 在 dashboard 首页右侧「Account ID」字段，或 头像 → My Profile 页面查看。

## 🔒 安全说明

- API Key 与 Cloudflare Token 保存在构建器自己的 KV 中（明文存储）。这是单用户自托管工具，**请勿部署到多人共享环境**。
- 建议 Cloudflare Token 使用最小权限：仅「Workers Scripts → 编辑」。
- 若需更强的安全性，可改用 Cloudflare OAuth 或 Workers Secrets，当前版本采用「持久化 Token」以满足"内置登录态、免重复登录"的需求。

## ❓ 常见问题

- **大模型调用 401/403**：检查 Base URL、Key、模型是否正确；DeepSeek 官方 Base URL 为 `https://api.deepseek.com`，模型 `deepseek-chat`。
- **部署失败**：确认 Token 有 Workers 脚本编辑权限、Account ID 正确；错误信息会展示在对话与 Toast 中。
- **workers.dev 地址打不开**：确认账号已启用 workers.dev 子域；部署时系统会自动调用接口启用。
- **修改代码后想重新部署**：代码页「保存并部署」即可，worker 名称不变，地址不变。

## 📝 更新记录

- **2026-08-08**：v1.3.0 访问密码与远程 Worker 联动
  - 访问密码：默认 123456，SHA-256 存储，登录签发 7 天 token，/api/* 统一鉴权，后台可修改密码
  - 删除联动：构建器创建的项目删除时同步删除远程 Worker；关联项目只移除本地
  - 关联已有 Worker：导入接口拉取远程代码建项目，可对话修改并覆盖部署，显示「外部 Worker」徽章
  - 修复：补充通用 .hidden 样式（此前多个 UI 元素隐藏失效）
- **2026-08-08**：v1.2.1 修复设置保存与对话等待
  - 前端：保存设置时 Key 留空视为沿用已保存值（修复误报缺配置）；所有请求加 120s 超时，模型响应慢时给出明确提示
  - 后端：LLM 调用（chat/completions 与 responses）加 90s 超时并返回明确错误
- **2026-08-08**：v1.2.0 修复部署与接口兼容
  - 部署：修复 10021 错误（模块 part Content-Type 改为 application/javascript+module）；已远程部署到 https://builder.logg.asia
  - Agent：新增 responses 接口类型（OpenAI Responses API），设置面板可切换 chat/completions / responses
  - 前端：登录态提示识别 OAuth 在线登录，登录后不再误报未配置 Cloudflare
  - 提示词：强化 Cloudflare Worker 平台约束（禁 Node.js 特性、禁 npm 依赖、输出完整模块代码）
- **2026-08-08**：v1.1.0 新增 Cloudflare 在线登录
  - 后端：`src/oauth.js` 设备码 OAuth 流程（复用官方客户端零配置）、access_token 自动刷新、凭据解析重构（OAuth 优先）
  - 前端：设置面板新增「在线登录」卡片与授权弹窗（设备码展示、自动打开授权页、轮询、倒计时），登录后显示账号与子域
  - 文档：补充 Cloudflare Token 获取位置与在线登录说明
- **2026-08-08**：v1.0.0 首个版本
  - 后端：API 路由、KV 存储、OpenAI 兼容 LLM Agent、Cloudflare 自动部署（上传脚本 + 启用 workers.dev 子域）
  - 前端：深色单页应用（项目列表 / 对话 / 代码编辑器 / 设置面板），支持自动部署开关、代码复制、地址复制
  - 文档：README 使用说明
