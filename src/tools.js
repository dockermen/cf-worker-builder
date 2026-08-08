/**
 * Agent 工具：HTTP 测试（等效 curl）
 *
 * Agent 在回复中输出 ```test-http 代码块即可发起请求，语法：
 *   GET https://xxx.workers.dev/ping
 *   POST https://xxx.workers.dev/api
 *   Content-Type: application/json
 *
 *   {"hello":"world"}
 */

const PRIVATE_HOST =
  /^(localhost|127(\.\d{1,3}){3}|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|169\.254(\.\d{1,3}){2}|0\.0\.0\.0|::1|0:0:0:0:0:0:0:1)$/i;

/** 从回复文本中提取第一个 test-http 代码块 */
export function extractHttpTest(text) {
  const m = String(text || '').match(/```test-http\s*\n([\s\S]*?)```/i);
  if (!m) return null;
  return m[1];
}

/** 从回复文本中提取全部 test-http 代码块（递归工具循环用） */
export function extractAllHttpTests(text) {
  const re = /```test-http\s*\n([\s\S]*?)```/gi;
  const specs = [];
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    specs.push(m[1]);
  }
  return specs;
}

/** 解析 test-http 规格：首行 METHOD URL，其余为 Header，空行后为 body */
export function parseHttpTestSpec(spec) {
  const lines = String(spec || '').split('\n');
  const first = (lines.shift() || '').trim();
  const fm = first.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|MARKDOWN)\s+(\S+)/i);
  if (!fm) return null;
  const method = fm[1].toUpperCase();
  const url = fm[2];
  const headers = {};
  let body = '';
  let readingBody = false;
  for (const line of lines) {
    if (readingBody) {
      body += line + '\n';
      continue;
    }
    if (line.trim() === '') {
      readingBody = true;
      continue;
    }
    const hm = line.match(/^([^:]+):\s*(.+)$/);
    if (hm) headers[hm[1].trim()] = hm[2].trim();
  }
  return { method, url, headers, body: body.trim() };
}

/** SSRF 防护：仅允许公网 http/https，禁止内网/本地地址 */
export function validateTargetUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: 'URL 无效' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, error: '仅支持 http/https' };
  }
  const host = u.hostname.toLowerCase();
  if (PRIVATE_HOST.test(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, error: '出于安全考虑，禁止访问内网/本地地址' };
  }
  return { ok: true };
}

/** 执行一次 HTTP 请求（10 秒超时，响应体截断） */
export async function executeHttpTest(specOrSpecText) {
  const parsed =
    typeof specOrSpecText === 'string' ? parseHttpTestSpec(specOrSpecText) : specOrSpecText;
  if (!parsed) return { error: 'test-http 格式无法解析' };
  const check = validateTargetUrl(parsed.url);
  if (!check.ok) return { error: check.error };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  // MARKDOWN 模式：通过 r.jina.ai reader 获取网页 Markdown（作为资料依据）
  let target = parsed.url;
  let method = parsed.method;
  let fallback = false;
  if (method === 'MARKDOWN') {
    target = `https://r.jina.ai/${parsed.url}`;
    method = 'GET';
  }

  try {
    let res = await fetch(target, {
      method,
      headers: parsed.headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : parsed.body || undefined,
      signal: controller.signal,
      redirect: 'follow',
    });
    // MARKDOWN 服务限流/失败时自动降级：直接 GET 原 URL 获取原始内容（HTML 源码同样有参考价值）
    if (parsed.method === 'MARKDOWN' && (res.status === 429 || res.status === 403 || res.status >= 500)) {
      fallback = true;
      const fallbackRes = await fetch(parsed.url, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'follow',
      });
      res = fallbackRes;
    }
    const bodyText = await res.text().catch(() => '');
    return {
      method: fallback ? 'GET(降级)' : parsed.method,
      url: parsed.url,
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get('content-type') || '',
      fallback,
      body: bodyText.slice(0, 3000),
    };
  } catch (e) {
    return {
      error: e && e.name === 'AbortError' ? '请求超时（15 秒）' : String(e.message || '请求失败'),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 把工具结果格式化为对话回填消息（供模型下一轮继续使用） */
export function formatToolResult(result, index) {
  if (!result) return '';
  if (result.error) return `🔧 工具结果（#${index || 1}）请求失败：${result.error}`;
  const bodyPreview = (result.body || '').slice(0, 1500);
  let tip = '';
  if (result.status === 429) {
    tip = '\n⚠️ 该目标服务限流（429）。**不要重复请求同一 URL**：可改用 GET 直接获取原始内容，或停止获取、基于已有信息继续。';
  } else if (result.fallback) {
    tip = '\n（注：MARKDOWN 服务限流/不可用，已自动降级为直接 GET 原始内容）';
  }
  return `🔧 工具结果（#${index || 1}）[${result.method} ${result.url}]：HTTP ${result.status}${tip}${bodyPreview ? '\n```\n' + bodyPreview + '\n```' : ''}`;
}

/** 把测试结果格式化为对话中展示的消息 */
export function formatTestResult(result, label = '测试') {
  if (!result) return '';
  if (result.error) return `🔧 ${label}请求失败：${result.error}`;
  const bodyPreview = (result.body || '').replace(/\n/g, ' ').slice(0, 240);
  // 冒烟测试 404：多半是 Worker 未处理根路径，属正常，给出友好说明而非报错
  if (label.startsWith('冒烟测试') && result.status === 404) {
    return `🌐 冒烟测试结果：HTTP 404（Worker 未处理根路径 /，可能只响应特定路由，属正常现象）`;
  }
  return `🔧 ${label}结果：${result.status} ${result.statusText || ''}${bodyPreview ? '\n' + bodyPreview : ''}`;
}


/** 从 Worker 代码中提取路由路径（用于智能冒烟测试），始终包含根路径 / */
export function extractRoutes(code) {
  const routes = new Set(['/']);
  const re = /url\.pathname(?:\s*(?:===|==)\s*|\.startsWith\s*\()\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = re.exec(String(code || ''))) !== null) {
    const p = m[1];
    if (p && p.startsWith('/') && p.length <= 40) routes.add(p);
  }
  return [...routes].slice(0, 6);
}
