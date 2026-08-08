/**
 * LLM Agent：调用 OpenAI 兼容的 chat/completions 接口
 * 支持 DeepSeek / OpenAI / Moonshot 等任意兼容服务
 */

import { normalizeBaseUrl } from './util.js';

export const SYSTEM_PROMPT = `你是「Worker 在线构建器」的智能体，负责根据用户需求生成或修改一个完整的 Cloudflare Worker 代码，并由系统自动部署。

## 输出协议
1. 需要生成或修改代码时：先简短说明实现思路（1-3 句话），然后输出「完整可部署」的代码，代码必须放在单个 \`\`\`javascript 代码块中。
2. 代码必须是 ES Module 格式的完整 Worker 文件，例如：
   export default {
     async fetch(request, env, ctx) {
       return new Response('Hello', { status: 200 });
     }
   };
3. 禁止使用任何 npm 第三方包，只能使用 Workers 运行时内置的 Web API（fetch、Response、Request、crypto、atob/btoa、TextEncoder 等）。
4. 用户要求修改功能时，输出修改后的「完整」代码，不要输出 diff、省略号或占位注释。
5. 如果用户只是提问、不涉及代码改动，正常回答即可，不要输出代码块。

## 代码质量要求
- 处理异常并返回合理的 HTTP 状态码；
- 需要跨域时添加 CORS 响应头；
- 默认让用户能直接在浏览器里看到效果（返回一个像样的 HTML 页面或 JSON）；
- 代码简洁、可读，并加上必要的中文注释；
- 不要把 API Key 等敏感信息硬编码进代码；确需密钥时，在注释中说明用环境变量绑定（wrangler.toml 的 [vars] 或 secrets），并给出配置建议。`;

/**
 * 调用 OpenAI 兼容 chat/completions
 * @param {{openaiBaseUrl:string, openaiKey:string, openaiModel:string}} settings
 * @param {Array<{role:string, content:string}>} messages
 */
export async function callChatCompletion(settings, messages) {
  const base = normalizeBaseUrl(settings.openaiBaseUrl);
  const url = `${base}/chat/completions`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.openaiKey}`,
    },
    body: JSON.stringify({
      model: settings.openaiModel,
      messages,
      temperature: 0.4,
      max_tokens: 8192,
      stream: false,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`大模型调用失败（HTTP ${res.status}）：${text.slice(0, 400)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('大模型返回内容为空');
  return content;
}
