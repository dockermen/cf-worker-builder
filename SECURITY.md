# 安全说明（Security）

## 安全模型

本项目是**单用户自托管**工具，采用「用户自己的凭据 + 用户自己的账号」模型：

- 用户配置的 **OpenAI Key / Cloudflare Token / OAuth 令牌** 以明文形式保存在构建器自己的 Cloudflare KV 中；
- 访问构建器需要**访问密码**（首次部署默认 `123456`，**首次登录后必须立即修改**，否则视为未初始化）；
- Cloudflare OAuth 登录态支持自动刷新，令牌到期自动续期。

## 已知限制（请勿用于多人共享环境）

1. **KV 明文存储**：API Key 与 Token 明文存储，部署到 Cloudflare KV。这是"免重复登录"的代价，任何能读取该 KV namespace 的角色都能拿到凭据。
2. **单租户**：所有访问者共享同一份配置与项目数据，没有多用户隔离。
3. **访问密码强度**：默认 `123456` 极弱，部署后**必须第一时间修改**；若用于公网，建议同时启用 Cloudflare Access 等额外保护层。
4. **SSRF 防护**：`test-http` / 冒烟测试工具仅允许公网 http/https 并拦截常见内网地址，但无法完全防御 DNS rebinding 等高级绕过。
5. **前端 token 存储**：访问令牌保存在浏览器 localStorage，存在 XSS 泄露风险；建议部署时配置 CSP 头。

## 凭据保护建议

- Cloudflare API Token 使用最小权限（仅 Workers Scripts → Edit、Account Settings → Read）；
- OpenAI Key 使用受限/可轮换的密钥；
- 定期在「设置」中更换访问密码与 API Key。

## 报告漏洞

请通过 GitHub Issues（Security 标签）提交，或直接联系维护者。请勿在公开渠道贴出你的真实密钥。
