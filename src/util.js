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
 * 从 LLM 回复中提取第一个代码块。
 * 支持 ```javascript / ```js / ```（无语言标注）三种围栏。
 */
export function extractCode(text) {
  if (!text) return null;
  const m = String(text).match(/```(?:javascript|js)?\s*\n?([\s\S]*?)```/i);
  return m ? m[1].trim() : null;
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
