/**
 * Cloudflare Workers 部署层：通过官方 REST API 上传脚本并启用 workers.dev 子域
 * 使用持久化的 API Token（内置登录态），用户无需重复登录。
 */

/** 获取账号的 workers.dev 子域（如 abc123.workers.dev 中的 abc123） */
export async function getAccountSubdomain(cfToken, accountId) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
    { headers: { Authorization: `Bearer ${cfToken}` } }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    throw new Error(
      `获取 workers.dev 子域失败（${res.status}）：${JSON.stringify(data.errors || data).slice(0, 300)}`
    );
  }
  return data.result?.subdomain || '';
}

/**
 * 部署（或更新）一个 Worker 脚本
 * @param {{cfToken:string, accountId:string, scriptName:string, code:string}} params
 * @returns {Promise<object>} Cloudflare API 返回的 result
 */
export async function deployWorker({ cfToken, accountId, scriptName, code }) {
  const boundary = '----cf-worker-builder-' + Math.random().toString(36).slice(2);
  const metadata = JSON.stringify({
    main_module: 'index.js',
    compatibility_date: '2025-01-01',
    bindings: [],
  });

  // 手工构造 multipart/form-data，兼容 Workers 运行时
  let body = `--${boundary}\r\n`;
  body += `Content-Disposition: form-data; name="metadata"\r\n`;
  body += `Content-Type: application/json\r\n\r\n`;
  body += metadata;
  body += `\r\n--${boundary}\r\n`;
  body += `Content-Disposition: form-data; name="index.js"\r\n`;
  body += `Content-Type: application/javascript\r\n\r\n`;
  body += code;
  body += `\r\n--${boundary}--\r\n`;

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${cfToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    throw new Error(
      `部署失败（${res.status}）：${JSON.stringify(data.errors || data).slice(0, 400)}`
    );
  }

  // 启用 workers.dev 访问（幂等；失败不阻塞部署结果）
  try {
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabled: true }),
      }
    );
  } catch (_) {
    /* ignore */
  }

  return data.result;
}

/** 测试 Cloudflare 凭据：验证 Token + Account ID 并返回子域 */
export async function testCloudflareConnection(cfToken, accountId) {
  const subdomain = await getAccountSubdomain(cfToken, accountId);
  return { ok: true, subdomain };
}
