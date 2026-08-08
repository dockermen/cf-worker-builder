/**
 * 通用工具函数
 */

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** 把项目名转成合法的 Worker 名称片段 */
export function slugify(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'project';
}

/** 归一化 OpenAI 兼容 Base URL（去尾部斜杠、补协议头） */
export function normalizeBaseUrl(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  u = u.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

/**
 * 从 LLM 回复中提取 Worker 代码块。
 * - 跳过工具/命令块（test-http、curl、markdown 等），避免把工具调用误当项目代码；
 * - 校验代码具备 Worker 特征（export default 或 fetch 监听），防止普通文本污染项目代码。
 */
const TOOL_CODE_LANGS = new Set(['test-http', 'tool', 'markdown', 'curl', 'bash', 'sh', 'shell', 'http', 'json', 'text', 'txt']);

export function extractCode(text) {
  if (!text) return null;
  const re = /```([a-zA-Z0-9_-]*)\s*\n?([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    const lang = (m[1] || '').trim().toLowerCase();
    if (TOOL_CODE_LANGS.has(lang)) continue; // 跳过工具/命令块
    const code = m[2].trim();
    if (!code) continue;
    // Worker 代码特征校验
    if (/export\s+default/.test(code) || /addEventListener\s*\(\s*['"]fetch/.test(code)) {
      return code;
    }
    if (lang === 'javascript' || lang === 'js') {
      return code;
    }
    // 无语言标注：需有明显 JS 特征才接受
    if (lang === '' && /new\s+Response|\(async\s*\)?\s*=>|async\s+function|function\s+fetch/.test(code)) {
      return code;
    }
  }
  return null;
}

/** 脱敏显示密钥 */
export function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

/** 新项目默认代码（Hello Worker，ES Module 格式） */
export const DEFAULT_CODE = `export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 示例接口：/api/hello
    if (url.pathname === '/api/hello') {
      return Response.json({ hello: 'world', time: Date.now() });
    }

    return new Response('Hello from Worker Builder!', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
`;


/**
 * 项目版本存档：每次部署自动记录一个快照
 * 最多保留 MAX_VERSIONS 个（超出删除最旧）
 */
export const MAX_VERSIONS = 20;

export function pushVersion(project, note, url) {
  const versions = project.versions || [];
  const v = project.nextVersion || 1;
  versions.push({
    v,
    code: project.code || '',
    note: note || `版本 ${v}`,
    url: url || project.url || '',
    deployed: !!url,
    tagged: false, // 打 tag 的版本永久保留，不受上限限制
    memory: project.memory ? JSON.parse(JSON.stringify(project.memory)) : null, // 快照当时的项目功能记忆
    createdAt: Date.now(),
  });
  // 上限策略：仅清理「未打 tag」的最旧版本，tagged 版本永久保留
  let untagged = versions.filter((x) => !x.tagged);
  while (untagged.length > MAX_VERSIONS) {
    const oldest = untagged.shift();
    const idx = versions.indexOf(oldest);
    if (idx >= 0) versions.splice(idx, 1);
  }
  project.versions = versions;
  project.nextVersion = v + 1;
}
