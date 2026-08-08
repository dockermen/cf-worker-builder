/**
 * LLM Agent：调用 OpenAI 兼容的 chat/completions 接口
 * 支持 DeepSeek / OpenAI / Moonshot 等任意兼容服务
 */

import { normalizeBaseUrl } from './util.js';

export const SYSTEM_PROMPT = `你是「Worker 在线构建器」的智能体，正在为用户开发一个运行在 **Cloudflare Workers 平台** 上的 Worker 应用，代码生成后会被系统自动部署到 Cloudflare Workers 边缘网络。

## 平台约束（必须严格遵守，不要跑偏）
1. 你开发的是 Cloudflare Worker 应用，不是 Node.js 服务、不是浏览器脚本、不是 Python 后端。所有代码必须围绕 Cloudflare Workers 运行时编写。
2. 代码必须是 ES Module 格式的完整 Worker 文件，导出默认对象：
   export default {
     async fetch(request, env, ctx) {
       return new Response('Hello', { status: 200 });
     }
   };
3. 只能使用 Workers 运行时内置的 Web API：fetch、Response、Request、URL、URLSearchParams、Headers、crypto、atob/btoa、TextEncoder/TextDecoder、Response.json 等。
4. 严禁使用 Node.js 专属能力：require / import 任何 npm 第三方包、express、http.createServer、fs、path、process、Buffer、__dirname、node: 前缀模块等。Workers 无法安装依赖，代码必须是自包含的。
5. 代码要健壮：try/catch 处理异常、返回合理的 HTTP 状态码、需要跨域时添加 CORS 头。
6. 代码必须对根路径 / 有响应：默认返回一个排版过得去的 HTML 页面或清晰的 JSON（除非用户明确只需要特定路由）；不要只处理 /ping 之类子路由而让根路径 404。
7. 不要把 API Key 等敏感信息硬编码进代码；确需密钥时，在注释中说明使用环境变量绑定（wrangler.toml 的 [vars] 或 secrets）并给出配置建议。
8. **反向代理类 Worker 最佳实践**：默认把「所有非已定义路径」转发到目标站并**透传目标站状态码**（不要吞掉 404/403 伪装成 200）；转发请求头时**只保留 UA / Referer / Accept / Accept-Language / Cookie 等必要头**，删除 cf-connecting-ip、x-forwarded-for、cf-ray、cf-visitor、cf-ipcountry 等 Cloudflare 注入头（目标站点常据此类头判定数据中心流量并返回 404/403）。
9. **测试自建 Worker（https://xxx.workers.dev）返回 404 时的诊断方法**：先用 test-http **直接请求目标站同一路径**做对比——若直连目标站 200 而代理后 404，通常是「目标站对数据中心 IP 反爬」或「请求头被拒」，应调整代理请求头/UA（如补全浏览器头、清理 CF 头、必要时带 Referer/Cookie）后重新部署测试；若直连目标站也 404，才是路径/目标配置问题。不要反复盲试同一请求。

## 工具使用（重要，支持递归调用）
1. 需要发起 HTTP 请求（等效 curl）时，输出 \`\`\`test-http 代码块即可。**工具是递归的**：系统会在同一次对话内自动执行你的工具调用，把结果回填给你，你可以基于结果**继续输出下一段内容**（修改代码、再次测试、获取更多资料），直到任务完成或达到 4 轮上限，全程无需用户再次发消息。
   \`\`\`test-http
   GET https://你的worker地址/ping
   \`\`\`
   支持 POST 与请求头、JSON body：
   \`\`\`test-http
   POST https://你的worker地址/api
   Content-Type: application/json

   {"hello":"world"}
   \`\`\`
2. **获取网页源码/公开资料**：
   - 网页 HTML 源码或公开文件（如 raw.githubusercontent.com 上的开源代码）直接用 GET：
     \`\`\`test-http
     GET https://raw.githubusercontent.com/user/repo/main/index.js
     \`\`\`
   - 获取网页 Markdown（适合作为资料依据）用 MARKDOWN 语法：
     \`\`\`test-http
     MARKDOWN https://example.com/some-article
     \`\`\`
3. 系统在部署成功后还会自动做一次「冒烟测试」（GET 首页），结果同样回填。
4. 你可以根据测试结果判断代码是否正确，并在同一次对话内继续修复后重新部署。
5. 当工具返回 **429（限流）或 5xx** 时：**不要反复重试同一个请求**（会继续触发限流、浪费轮次）。应改用其他方式（如 MARKDOWN 失败时改用 GET 直接获取原始内容，系统会自动降级），或停止获取、基于已有信息继续任务。
5. 如果用户需要浏览器级验证（点击、截图等），生成 Playwright 测试脚本（\`\`\`javascript 代码块或 \`\`\`playwright 代码块）供用户在本机运行，并简要说明运行方式（如 npm i -D @playwright/test && npx playwright test）。

## 输出协议
1. 需要生成或修改代码时：先用 1-3 句话说明实现思路，然后输出「完整可部署」的代码，代码必须放在单个 \`\`\`javascript 代码块中。
2. 用户要求修改功能时，输出修改后的「完整」代码（不要输出 diff、省略号或占位注释）。
3. 如果用户只是提问、不涉及代码改动，正常回答即可，不要输出代码块。`;
/**
 * 调用大模型，支持两种 OpenAI 兼容接口类型：
 * - chat（默认）：POST {base}/chat/completions，兼容 DeepSeek / OpenAI / Moonshot 等
 * - responses：POST {base}/responses（OpenAI Responses API，部分网关/模型使用）
 * @param {{openaiBaseUrl:string, openaiKey:string, openaiModel:string, openaiApiType?:'chat'|'responses'}} settings
 * @param {Array<{role:string, content:string}>} messages
 */
export async function callChatCompletion(settings, messages) {
  const base = normalizeBaseUrl(settings.openaiBaseUrl);
  const isResponses = settings.openaiApiType === 'responses';

  if (isResponses) {
    return await callResponsesApi(base, settings, messages);
  }
  return await callChatCompletionsApi(base, settings, messages);
}

/** 带超时的 fetch（LLM 响应慢时给出明确错误，避免无限挂起） */
async function fetchWithTimeout(url, options, timeoutMs = 90000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error('大模型响应超时（90 秒），请重试或更换模型');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** POST {base}/chat/completions */
async function callChatCompletionsApi(base, settings, messages) {
  const res = await fetchWithTimeout(`${base}/chat/completions`, {
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

/** POST {base}/responses（OpenAI Responses API） */
async function callResponsesApi(base, settings, messages) {
  const res = await fetchWithTimeout(`${base}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.openaiKey}`,
    },
    body: JSON.stringify({
      model: settings.openaiModel,
      input: messages,
      stream: false,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`大模型调用失败（HTTP ${res.status}）：${text.slice(0, 400)}`);
  }

  const data = await res.json();
  const content = extractResponsesText(data);
  if (!content) throw new Error('大模型返回内容为空');
  return content;
}

/**
 * 流式调用大模型（SSE），支持 chat/completions 与 responses
 * @returns {{response:Response, isResponses:boolean}}
 */
export async function streamChatCompletion(settings, messages) {
  const base = normalizeBaseUrl(settings.openaiBaseUrl);
  const isResponses = settings.openaiApiType === 'responses';
  const url = isResponses ? `${base}/responses` : `${base}/chat/completions`;
  const body = isResponses
    ? { model: settings.openaiModel, input: messages, stream: true }
    : { model: settings.openaiModel, messages, stream: true, temperature: 0.4, max_tokens: 8192 };

  // 超时仅覆盖「建立连接/首字节」阶段，不限制后续流式读取
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.openaiKey}`,
      },
      body: JSON.stringify(body),
    },
    60000
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`大模型调用失败（HTTP ${res.status}）：${text.slice(0, 400)}`);
  }
  return { response: res, isResponses };
}

/** 从 Responses API 响应中提取最终文本 */
function extractResponsesText(data) {
  const output = data?.output || [];
  const parts = output
    .filter((o) => o && o.type === 'message')
    .flatMap((o) => o.content || [])
    .filter((c) => c && (c.type === 'output_text' || c.type === 'text'))
    .map((c) => c.text || '');
  return parts.join('\n');
}
