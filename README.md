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
- 🔧 Agent 内置 HTTP 测试工具（`test-http`，等效 curl）：生成代码并部署后可直接请求接口验证，结果回填对话；部署成功自动冒烟测试（404 中性提示）；浏览器级验证可让 Agent 生成 Playwright 脚本本机运行；
- 🕘 每个项目支持版本控制：每次部署自动存档，⭐ 标记的版本永久保留（不受上限），未标记版本最多保留 20 个；可查看代码、恢复、恢复并部署；
- 🔁 递归对话：同一轮对话内 Agent 可自动多轮调用工具（curl 网页源码/开源代码、MARKDOWN 获取网页资料），基于结果继续生成与测试，无需用户反复发消息；
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
# （wrangler.toml 中默认是占位符 REPLACE_WITH_YOUR_KV_NAMESPACE_ID，部署前必须替换）

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
9. **访问密码**：进入页面需输入密码（默认 `123456`），**首次登录会强制提示修改**，登录后也可在「设置 → ③ 访问密码」中随时修改。

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

## 🔒 安全模型（开源注意）

本项目是**单用户自托管**工具：用户配置的 OpenAI Key / Cloudflare Token / OAuth 令牌以明文保存在构建器自己的 Cloudflare KV 中；访问密码默认 `123456`，**首次登录后必须立即修改**。**请勿部署到多人共享环境**。

详细安全说明与已知限制见 [SECURITY.md](./SECURITY.md)。

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

- **2026-08-10**：v1.10.0 开源准备
  - 脱敏 wrangler.toml（KV id / 自定义域改为占位符），移除个人部署信息
  - 新增 LICENSE（MIT）、SECURITY.md、CONTRIBUTING.md、.dev.vars.example
  - package.json 补全（license / keywords / engines）
  - 安全增强：默认密码（123456）首次登录强制提示修改
- **2026-08-08**：v1.9.5 项目记忆详细文档化并注入代码生成
  - 记忆升级为结构化 Markdown 文档：一、需求 二、功能 三、技术信息 四、变更记录（保留历史并追加每次改动）
  - 关联导入时 LLM 分析代码生成详细记忆文档；部署成功后 LLM 整合需求/代码更新文档
  - 项目记忆注入每次 LLM 调用，作为后续代码生成的依据（模型可直接引用记忆中的需求与功能）
  - 前端：header 摘要 + 弹窗渲染完整记忆文档
- **2026-08-08**：v1.9.4 项目功能记忆
  - 新建项目：根据描述或默认模板初始化功能记忆
  - 关联导入：LLM 分析远程代码，把实现的功能写入项目记忆
  - 对话部署成功：LLM 整合本次需求更新项目记忆（含更新记录列表，失败降级记录需求）
  - 版本快照包含当时的项目记忆；恢复版本时同步恢复记忆
  - 前端：项目 header 显示记忆摘要，点击查看详情；版本列表显示各版本记忆
- **2026-08-08**：v1.9.3 关联导入版本基线与智能冒烟测试
  - 关联导入的远程 Worker 原始代码自动存为版本 #1（修改后可对比/恢复初始状态）
  - 冒烟测试智能路由探测：从代码提取路由（/ping、/page/ 等）逐个测试，找到正常响应即通过；根路径未处理不再误报 404
- **2026-08-08**：v1.9.2 修复代码提取误吞工具块
  - extractCode 跳过 test-http/curl/markdown 等工具块，仅提取具备 Worker 特征（export default 或 fetch 监听）的代码块，防止项目代码被改成无关内容
  - deployWorker 部署前校验代码合法性，无效代码明确报错取消部署（避免 10021 multipart 错误）
- **2026-08-08**：v1.9.1 代理类 Worker 最佳实践
  - 提示词：反向代理默认转发所有路径并透传状态码；转发请求头时只保留必要头，清理 cf-connecting-ip / x-forwarded-for 等 CF 注入头（目标站常据此反爬返回 404/403）
  - 提示词：测试自建 worker（xxx.workers.dev）返回 404 时，先用 test-http 直连目标站同路径对比诊断，避免盲试
- **2026-08-08**：v1.9.0 上下文压缩与思维链折叠
  - 上下文压缩：历史超过 35 条时自动把早期消息交给 LLM 生成要点摘要（保留核心需求/已完成/遗留事项），LLM 上下文只保留最近 20 条完整消息 + 摘要，长对话不再遗忘早期需求；history 完整保留供 UI 展示
  - 思维链代码折叠：流式输出时代码块分段展示并自动滚动最新行；完成态代码块默认折叠（点击展开），保留复制按钮
- **2026-08-08**：v1.8.2 修复对话卡死与限流
  - chat-status 残留判定改为「最后心跳 updatedAt + 90 秒」，请求中断后前端及时提示而非无限显示部署中，并自动刷新记录
  - MARKDOWN 工具：r.jina.ai 返回 429/403/5xx 时自动降级为直接 GET 原始内容
  - 工具结果 429 明确提示模型不要重复请求同一 URL；提示词补充限流应对规则
- **2026-08-08**：v1.8.1 版本打 tag
  - 版本新增 tagged 字段；标记的版本永久保留（不受 20 个上限限制），未标记版本自动清理最旧的（≤20）
  - 新增 tag API（POST /versions/:v/tag），前端版本弹窗支持标记/取消标记并显示 ⭐ 已标记徽章
- **2026-08-08**：v1.8.0 版本摘要与关联 Worker 列表
  - 版本标题：对话生成并部署时取用户需求消息作为代码改动摘要（截断 40 字），恢复版本保持「恢复版本 #xx 并部署」格式
  - 关联已有 Worker：新增 /api/workers/list 列出账号下全部 Worker，前端下拉选择（可手动输入兜底）
  - 修复：工具循环中代码提取改为聚合所有轮次文本（代码可能出现在第一轮而非最后一轮）
- **2026-08-08**：v1.7.0 后台运行恢复与长会话上下文
  - 当前代码注入：每次 LLM 调用（含工具循环每轮）都把最新项目代码放入上下文，模型始终基于真实代码状态修改
  - chat_status 实时进度：stage（thinking/tool/deploying）+ 轮次 + 备注，前端轮询展示后台执行状态
  - 断线自动恢复：网络中断/超时时自动轮询 chat-status，后台任务完成后自动刷新结果，切换页面也不丢失
  - 长会话：每轮用最新代码重建上下文，配合历史与工具结果，持续 Agent 对话更稳定
- **2026-08-08**：v1.6.0 递归对话（Agent 工具循环）
  - 同一轮对话内模型可自动多次调用工具（最多 4 轮）：输出 test-http / MARKDOWN 块 → 系统执行并回填 → 模型基于结果继续，无需用户干预
  - 新增 MARKDOWN 语法（r.jina.ai reader 获取网页 Markdown 作为资料依据）；支持一次回复多个工具块
  - tool/toolnote SSE 事件，前端分段渲染工具执行过程
- **2026-08-08**：v1.5.0 版本控制与冒烟测试优化
  - 版本控制：每次部署自动存档（最多 20 个），versions API 支持查看/恢复/恢复并部署，前端「代码」页新增版本历史弹窗
  - 冒烟测试：404 中性化提示（Worker 未处理根路径属正常，不再误报为失败），仅 5xx/网络错误标红
  - 提示词：要求代码默认响应根路径 /，避免部署后首页 404
- **2026-08-08**：v1.4.0 Agent 工具能力
  - test-http 工具（等效 curl）：模型输出 test-http 代码块即发起 GET/POST 请求，状态码与响应体回填对话，可据此迭代修复
  - 部署成功后自动冒烟测试（GET 首页）并回填结果
  - SSRF 防护：仅允许公网 http/https，禁止内网/本地地址
  - 提示词支持生成 Playwright 测试脚本供用户本机运行（Workers 环境无法运行真浏览器）
- **2026-08-08**：v1.3.3 修复 responses 流式事件解析
  - 真实模型流式事件类型为 `response.output_text.delta`（此前只匹配简写导致输出为空），已兼容两种格式
- **2026-08-08**：v1.3.2 修复手机端输入框异常
  - 发送期间输入框保持可用（此前 busy 状态禁用输入框，请求挂起时中文输入无反应）
  - 流式请求 150s 超时兜底；回车发送对中文输入法合成事件加保护；iOS 输入框字号 16px
- **2026-08-08**：v1.3.0 访问密码与远程 Worker 联动
  - 访问密码：默认 123456，SHA-256 存储，登录签发 7 天 token，/api/* 统一鉴权，后台可修改密码
  - 删除联动：构建器创建的项目删除时同步删除远程 Worker；关联项目只移除本地
  - 关联已有 Worker：导入接口拉取远程代码建项目，可对话修改并覆盖部署，显示「外部 Worker」徽章
  - 修复：补充通用 .hidden 样式（此前多个 UI 元素隐藏失效）
- **2026-08-08**：v1.2.1 修复设置保存与对话等待
  - 前端：保存设置时 Key 留空视为沿用已保存值（修复误报缺配置）；所有请求加 120s 超时，模型响应慢时给出明确提示
  - 后端：LLM 调用（chat/completions 与 responses）加 90s 超时并返回明确错误
- **2026-08-08**：v1.2.0 修复部署与接口兼容
  - 部署：修复 10021 错误（模块 part Content-Type 改为 application/javascript+module）
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
