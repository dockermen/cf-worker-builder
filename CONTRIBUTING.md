# 贡献指南（Contributing）

感谢你对 Worker 在线构建器感兴趣！

## 开发环境

```bash
npm install
npm run dev        # 本地开发 http://localhost:8787
```

本地开发使用内置本地 KV，无需真实 Cloudflare 凭据即可体验界面与 API 流程。

## 提交规范

- 提交信息使用**中文**，遵循约定式提交风格：
  - `feat: 新增 xxx`
  - `fix: 修复 xxx`
  - `docs: 更新文档`
  - `refactor: 重构 xxx`
- 提交粒度：一个逻辑改动一个提交。

## 代码结构

```
src/
  index.js   # 主入口 + API 路由 + 对话/部署流程
  agent.js   # LLM Agent（chat/completions 与 responses）
  auth.js    # 访问密码认证
  deploy.js  # Cloudflare 部署层
  oauth.js   # Cloudflare 在线登录（设备码 OAuth）
  store.js   # KV 数据访问层
  tools.js   # Agent 工具（test-http / 冒烟测试 / 路由提取）
  util.js    # 工具函数
public/
  index.html # 前端单页应用
```

## 提 PR 前检查

- [ ] `node --check` 通过所有改动文件
- [ ] 纯函数改动（`util.js` / `tools.js`）补充/更新单元测试
- [ ] README 的「更新记录」追加本次改动
- [ ] 未引入新的敏感信息（密钥、账号、域名）
