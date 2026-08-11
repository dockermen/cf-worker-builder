/**
 * Cloudflare Workers 部署层：通过官方 REST API 上传脚本并启用 workers.dev 子域
 * 使用持久化的 API Token（内置登录态），用户无需重复登录。
 */

/** 获取账号的 workers.dev 子域（如 abc123.workers.dev 中的 abc123） */
export async function getAccountSubdomain(cfToken, accountId, apiBase = 'https://api.cloudflare.com/client/v4', fetchImpl = fetch) {
  const res = await fetchImpl(
    `${apiBase}/accounts/${accountId}/workers/subdomain`,
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
export async function deployWorker({ cfToken, accountId, scriptName, code, apiBase = 'https://api.cloudflare.com/client/v4', fetchImpl = fetch }) {
  // 部署前校验：必须是合法的 Worker 代码（ES Module 或 service worker），防止垃圾内容上传
  const isModule = /export\s+default/.test(code);
  const isValidWorker = isModule || /addEventListener\s*\(\s*['"]fetch/.test(code);
  if (!code || !isValidWorker) {
    throw new Error('代码无效（不是合法的 Cloudflare Worker 代码，缺少 export default 或 fetch 监听），已取消部署');
  }
  const boundary = '----cf-worker-builder-' + Math.random().toString(36).slice(2);
  const metadata = isModule
    ? JSON.stringify({
        main_module: 'index.js',
        compatibility_date: '2025-01-01',
        bindings: [],
      })
    : JSON.stringify({
        compatibility_date: '2025-01-01',
        bindings: [],
      });

  // 手工构造 multipart/form-data，兼容 Workers 运行时
  let body = `--${boundary}\r\n`;
  body += `Content-Disposition: form-data; name="metadata"\r\n`;
  body += `Content-Type: application/json\r\n\r\n`;
  body += metadata;
  body += `\r\n--${boundary}\r\n`;
  // 注意：文件 part 必须带 filename（否则 10021 No such module）；
  // module 格式 Content-Type 必须是 application/javascript+module（否则被当普通脚本解析，报 export 语法错误）
  body += `Content-Disposition: form-data; name="index.js"; filename="index.js"\r\n`;
  body += `Content-Type: ${isModule ? 'application/javascript+module' : 'application/javascript'}\r\n\r\n`;
  body += code;
  body += `\r\n--${boundary}--\r\n`;

  const res = await fetchImpl(
    `${apiBase}/accounts/${accountId}/workers/scripts/${scriptName}`,
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
    await fetchImpl(
      `${apiBase}/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`,
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

/** 删除远程 Worker 脚本（构建器创建的项目删除时联动清理） */
export async function deleteWorker(cfToken, accountId, scriptName) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${cfToken}` } }
  );
  if (res.status === 404) return { deleted: false, reason: 'not_found' };
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    throw new Error(
      `删除 Worker 失败（${res.status}）：${JSON.stringify(data.errors || data).slice(0, 200)}`
    );
  }
  return { deleted: true };
}

/**
 * 拉取已有 Worker 的代码（用于「关联已有 Worker 项目」）
 * @returns {{code:string, mainModule:string, isModule:boolean}}
 */
export async function fetchWorkerCode(cfToken, accountId, scriptName) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${cfToken}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`获取 Worker 失败（${res.status}）：${text.slice(0, 200)}`);
  }

  let code = '';
  let mainModule = 'index.js';
  const clone = res.clone(); // formData 会消费 body，失败时用 clone 回退读文本
  try {
    const form = await res.formData();
    const metadataPart = form.get('metadata');
    if (metadataPart) {
      const metadataRaw = typeof metadataPart === 'string' ? metadataPart : await metadataPart.text();
      const metadata = JSON.parse(metadataRaw || '{}');
      if (metadata.main_module) mainModule = metadata.main_module;
    }
    // 优先取 main_module 文件
    for (const name of [mainModule, 'index.js', 'worker.js', 'src/index.js']) {
      const file = form.get(name);
      if (file) {
        code = typeof file === 'string' ? file : await file.text();
        if (code) break;
      }
    }
  } catch (_) {
    /* formData 解析失败则回退文本 */
  }
  if (!code) {
    // service worker 格式：响应体可能是纯脚本文本
    const text = await clone.text().catch(() => '');
    code = text;
  }
  return { code, mainModule, isModule: /export\s+default/.test(code) };
}

/** 列出账号下已有 Worker 脚本（用于「关联已有 Worker」下拉选择） */
export async function listWorkers(cfToken, accountId) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts?per_page=100`,
    { headers: { Authorization: `Bearer ${cfToken}` } }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    throw new Error(
      `获取 Worker 列表失败（${res.status}）：${JSON.stringify(data.errors || data).slice(0, 200)}`
    );
  }
  return (data.result || []).map((w) => ({
    name: w.id,
    createdOn: w.created_on || '',
    modifiedOn: w.modified_on || '',
  }));
}
