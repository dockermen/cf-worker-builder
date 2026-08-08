/**
 * Worker 在线构建器 - 主入口
 *
 * 功能：
 * 1. 配置 OpenAI 兼容大模型（Base URL / Key / 模型），接入 DeepSeek 等 Agent
 * 2. 以项目为单位对话式生成 Worker 代码，自动部署到 Cloudflare Workers 并返回地址
 * 3. 内置 Cloudflare 登录态：支持「设备码在线登录」（类似 wrangler login）与手动 API Token，
 *    Token 持久化在 KV 且自动刷新，无需每次登录
 */

import { json, slugify, extractCode, maskKey, DEFAULT_CODE } from './util.js';
import { makeStore } from './store.js';
import { callChatCompletion, SYSTEM_PROMPT } from './agent.js';
import {
  getClientId,
  startDeviceFlow,
  pollDeviceFlow,
  refreshOAuthToken,
  logoutOAuth,
  getCredentials,
  publicOAuth,
} from './oauth.js';
import { login, checkAuth, changePassword } from './auth.js';
import { deployWorker, getAccountSubdomain, testCloudflareConnection, deleteWorker, fetchWorkerCode } from './deploy.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const store = makeStore(env.BUILDER_KV);

    try {
      if (url.pathname.startsWith('/api/')) {
        // 访问密码鉴权：登录与状态检查接口豁免，其余 API 需携带有效 token
        const AUTH_FREE = ['/api/auth/login', '/api/auth/check'];
        if (!AUTH_FREE.includes(url.pathname)) {
          const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
          const authed = await checkAuth(store, token);
          if (!authed) {
            return json({ error: '未授权，请先输入访问密码', code: 'UNAUTHORIZED' }, 401);
          }
        }
        return await handleApi(request, url, env, store);
      }
      // 非 API 请求：交给静态资源（前端页面）
      return await env.ASSETS.fetch(request);
    } catch (err) {
      console.error('[worker-builder]', err);
      return json({ error: err.message || '服务器内部错误' }, 500);
    }
  },
};

async function handleApi(request, url, env, store) {
  const { pathname } = url;
  const method = request.method;
  const readBody = async () => {
    try {
      return await request.json();
    } catch {
      return {};
    }
  };

  // ============ 访问密码 ============
  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readBody();
    const r = await login(store, body.password);
    return r.ok ? json({ ok: true, token: r.token }) : json({ error: r.error }, 401);
  }

  if (pathname === '/api/auth/check' && method === 'GET') {
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const authed = await checkAuth(store, token);
    return json({ authed });
  }

  if (pathname === '/api/auth/password' && method === 'POST') {
    const body = await readBody();
    const r = await changePassword(store, body.oldPassword, body.newPassword);
    return r.ok ? json({ ok: true }) : json({ error: r.error }, 400);
  }

  // ============ 全局状态 ============
  if (pathname === '/api/state' && method === 'GET') {
    const settings = await store.getSettings();
    const projects = await store.listProjects();
    const oauth = await store.getOAuth();
    return json({
      settings: {
        openaiBaseUrl: settings.openaiBaseUrl || '',
        openaiModel: settings.openaiModel || '',
        openaiApiType: settings.openaiApiType || 'chat',
        openaiKeyMasked: maskKey(settings.openaiKey),
        hasOpenAIKey: !!settings.openaiKey,
        cfTokenMasked: maskKey(settings.cfToken),
        hasCfToken: !!settings.cfToken,
        cfAccountId: settings.cfAccountId || '',
        cfSubdomain: settings.cfSubdomain || '',
      },
      oauth: publicOAuth(oauth),
      projects,
    });
  }

  // ============ 设置（LLM + 手动 Cloudflare Token） ============
  if (pathname === '/api/settings' && method === 'POST') {
    const body = await readBody();
    const settings = await store.getSettings();
    const next = {
      openaiBaseUrl: String(body.openaiBaseUrl || '').trim() || settings.openaiBaseUrl || '',
      openaiKey: String(body.openaiKey || '').trim() || settings.openaiKey || '',
      openaiModel: String(body.openaiModel || '').trim() || settings.openaiModel || '',
      openaiApiType:
        body.openaiApiType === 'responses' ? 'responses' : settings.openaiApiType === 'responses' ? 'responses' : 'chat',
      cfToken: String(body.cfToken || '').trim() || settings.cfToken || '',
      cfAccountId: String(body.cfAccountId || '').trim() || settings.cfAccountId || '',
      cfSubdomain: settings.cfSubdomain || '',
    };

    if (!next.openaiBaseUrl || !next.openaiKey || !next.openaiModel) {
      return json({ error: '请填写完整的 OpenAI 兼容配置（Base URL、Key、模型）' }, 400);
    }

    // 手动 Token 方式下：可选校验 Cloudflare 凭据并缓存 workers.dev 子域
    let cfTestError = null;
    if (next.cfToken && next.cfAccountId) {
      try {
        const r = await testCloudflareConnection(next.cfToken, next.cfAccountId);
        next.cfSubdomain = r.subdomain;
      } catch (e) {
        cfTestError = e.message;
      }
    }

    await store.saveSettings(next);
    return json({
      ok: true,
      cfTestError,
      settings: {
        openaiBaseUrl: next.openaiBaseUrl,
        openaiModel: next.openaiModel,
        openaiApiType: next.openaiApiType,
        openaiKeyMasked: maskKey(next.openaiKey),
        hasOpenAIKey: !!next.openaiKey,
        cfTokenMasked: maskKey(next.cfToken),
        hasCfToken: !!next.cfToken,
        cfAccountId: next.cfAccountId,
        cfSubdomain: next.cfSubdomain,
      },
    });
  }

  // ============ 测试 Cloudflare 连接 ============
  if (pathname === '/api/test-cf' && method === 'POST') {
    const body = await readBody();
    const settings = await store.getSettings();
    let token = String(body.cfToken || '').trim() || settings.cfToken || '';
    let accountId = String(body.cfAccountId || '').trim() || settings.cfAccountId || '';
    // 表单与手动 Token 都为空时，回退测试在线登录凭据
    if (!token || !accountId) {
      try {
        const cred = await getCredentials(store, settings);
        token = cred.token;
        accountId = cred.accountId;
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }
    try {
      const r = await testCloudflareConnection(token, accountId);
      return json({ ok: true, subdomain: r.subdomain });
    } catch (e) {
      return json({ ok: false, error: e.message }, 400);
    }
  }

  // ============ Cloudflare 在线登录（设备码 OAuth，类似 wrangler login --device） ============
  if (pathname === '/api/oauth/start' && method === 'POST') {
    try {
      const flow = await startDeviceFlow(store, getClientId(env));
      return json({ ok: true, ...flow });
    } catch (e) {
      return json({ error: e.message }, 502);
    }
  }

  if (pathname === '/api/oauth/status' && method === 'GET') {
    const r = await pollDeviceFlow(store);
    if (r.status === 'success') {
      // 登录成功后探测并缓存 workers.dev 子域
      let subdomain = '';
      try {
        const cred = await getCredentials(store, await store.getSettings());
        const sd = await getAccountSubdomain(cred.token, cred.accountId);
        subdomain = sd;
        const settings = await store.getSettings();
        settings.cfSubdomain = sd;
        await store.saveSettings(settings);
      } catch (_) {
        /* ignore */
      }
      return json({ ...r, subdomain });
    }
    return json(r);
  }

  if (pathname === '/api/oauth/refresh' && method === 'POST') {
    try {
      const oauth = await refreshOAuthToken(store);
      return json({ ok: true, oauth: publicOAuth(oauth) });
    } catch (e) {
      return json({ error: e.message }, 401);
    }
  }

  if (pathname === '/api/oauth/logout' && method === 'POST') {
    await logoutOAuth(store);
    return json({ ok: true });
  }

  // ============ 项目列表 ============
  if (pathname === '/api/projects' && method === 'GET') {
    return json({ projects: await store.listProjects() });
  }

  // ============ 创建项目 ============
  if (pathname === '/api/projects' && method === 'POST') {
    const body = await readBody();
    const name = String(body.name || '').trim();
    if (!name) return json({ error: '项目名称不能为空' }, 400);

    const id = crypto.randomUUID();
    const workerName = `${slugify(name)}-${id.slice(0, 4)}`;
    const now = Date.now();
    const project = {
      id,
      name,
      description: String(body.description || '').trim(),
      workerName,
      source: 'created', // created=构建器创建，linked=关联已有 Worker
      code: DEFAULT_CODE,
      url: '',
      deployed: false,
      deployedAt: null,
      history: [],
      createdAt: now,
      updatedAt: now,
    };
    await store.saveProject(project);
    return json({ project });
  }

  // ============ 单个项目：GET / DELETE ============
  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch) {
    const id = projectMatch[1];
    if (method === 'GET') {
      const project = await store.getProject(id);
      if (!project) return json({ error: '项目不存在' }, 404);
      return json({ project });
    }
    if (method === 'DELETE') {
      const project = await store.getProject(id);
      if (!project) return json({ error: '项目不存在' }, 404);

      // 构建器创建的项目：删除时联动删除对应的远程 Worker；
      // 关联已有 Worker 的项目（linked）：只移除本地项目，不影响远程 Worker
      let workerDeleted = null;
      if (project.source !== 'linked' && project.workerName) {
        try {
          const cred = await getCredentials(store, await store.getSettings());
          const r = await deleteWorker(cred.token, cred.accountId, project.workerName);
          workerDeleted = r.deleted ? true : { skipped: 'not_found' };
        } catch (e) {
          workerDeleted = { error: e.message };
        }
      }
      await store.deleteProject(id);
      return json({ ok: true, workerDeleted });
    }
  }

  // ============ 关联已有 Cloudflare Worker ============
  if (pathname === '/api/projects/import' && method === 'POST') {
    const body = await readBody();
    const workerName = String(body.workerName || '').trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(workerName)) {
      return json({ error: 'Worker 名称不合法（仅支持字母、数字、下划线、短横线）' }, 400);
    }
    const settings = await store.getSettings();
    let cred;
    try {
      cred = await getCredentials(store, settings);
    } catch (e) {
      return json({ error: e.message }, 400);
    }
    // 拉取已有代码
    const { code, isModule } = await fetchWorkerCode(cred.token, cred.accountId, workerName);
    if (!code) return json({ error: '未能获取到该 Worker 的代码' }, 400);
    const id = crypto.randomUUID();
    const now = Date.now();
    const project = {
      id,
      name: body.name ? String(body.name).trim() : workerName,
      description: `已关联 Cloudflare Worker：${workerName}（${isModule ? 'ES Module' : 'Service Worker'} 格式）`,
      workerName,
      source: 'linked', // 关联项目：删除时只移除本地，不影响远程 Worker
      code,
      url: '',
      deployed: true,
      deployedAt: now,
      history: [
        { role: 'system', content: `🔗 已关联已有 Cloudflare Worker：${workerName}，可在对话中描述需求进行修改，修改后自动部署覆盖该 Worker。` },
      ],
      createdAt: now,
      updatedAt: now,
    };
    // 探测子域并拼接访问地址
    try {
      const sd = await getAccountSubdomain(cred.token, cred.accountId);
      settings.cfSubdomain = sd;
      await store.saveSettings(settings);
      project.url = `https://${workerName}.${sd}.workers.dev`;
    } catch (_) { /* ignore */ }
    await store.saveProject(project);
    return json({ project });
  }

  // ============ 项目子操作：chat / deploy / code / clear ============
  const actionMatch = pathname.match(/^\/api\/projects\/([^/]+)\/(chat|deploy|code|clear)$/);
  if (actionMatch) {
    const id = actionMatch[1];
    const action = actionMatch[2];

    if (action === 'chat' && method === 'POST') {
      return await chatAction(request, store, id);
    }
    if (action === 'deploy' && method === 'POST') {
      return await deployAction(store, id);
    }
    if (action === 'code' && method === 'PUT') {
      const project = await store.getProject(id);
      if (!project) return json({ error: '项目不存在' }, 404);
      const body = await readBody();
      const code = String(body.code || '').trim();
      if (!code) return json({ error: '代码不能为空' }, 400);
      project.code = code;
      project.updatedAt = Date.now();
      await store.saveProject(project);
      return json({ project });
    }
    if (action === 'clear' && method === 'POST') {
      const project = await store.getProject(id);
      if (!project) return json({ error: '项目不存在' }, 404);
      project.history = [];
      project.updatedAt = Date.now();
      await store.saveProject(project);
      return json({ project });
    }
  }

  return json({ error: '接口不存在' }, 404);
}

/** 对话：调用大模型 → 提取代码 → 自动部署 */
async function chatAction(request, store, id) {
  const project = await store.getProject(id);
  if (!project) return json({ error: '项目不存在' }, 404);

  const body = await request.json().catch(() => ({}));
  const message = String(body.message || '').trim();
  if (!message) return json({ error: '消息不能为空' }, 400);

  const settings = await store.getSettings();
  if (!settings.openaiBaseUrl || !settings.openaiKey || !settings.openaiModel) {
    return json({ error: '请先在「设置」中配置 OpenAI Base URL、Key 和模型' }, 400);
  }

  // 追加用户消息
  project.history.push({ role: 'user', content: message });

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...project.history.slice(-40),
  ];

  let reply;
  try {
    reply = await callChatCompletion(settings, messages);
  } catch (e) {
    // 调用失败时回滚用户消息，避免重试产生重复
    project.history.pop();
    return json({ error: e.message }, 502);
  }

  project.history.push({ role: 'assistant', content: reply });
  project.updatedAt = Date.now();

  // 提取代码块
  const code = extractCode(reply);
  let deployed = false;
  let url = project.url || '';
  let deployError = null;

  if (code) {
    project.code = code;
    if (body.autoDeploy !== false) {
      try {
        const r = await doDeploy(store, settings, project);
        deployed = true;
        url = r.url;
        project.url = r.url;
        project.deployed = true;
        project.deployedAt = Date.now();
        project.history.push({ role: 'system', content: `✅ 已自动部署到：${r.url}` });
      } catch (e) {
        deployError = e.message;
        project.history.push({
          role: 'system',
          content: `⚠️ 代码已生成，但自动部署失败：${e.message}（可稍后在「代码」页手动重新部署）`,
        });
      }
    }
  }

  await store.saveProject(project);
  return json({ project, reply, code, deployed, url, deployError });
}

/** 手动部署当前代码 */
async function deployAction(store, id) {
  const project = await store.getProject(id);
  if (!project) return json({ error: '项目不存在' }, 404);

  const settings = await store.getSettings();
  const oauth = await store.getOAuth();
  const hasCred =
    (oauth && oauth.accessToken) || (settings.cfToken && settings.cfAccountId);
  if (!hasCred) {
    return json(
      { error: '请先在「设置」中完成 Cloudflare 在线登录，或填写 API Token + Account ID' },
      400
    );
  }
  if (!project.code) return json({ error: '项目还没有可部署的代码' }, 400);

  try {
    const r = await doDeploy(store, settings, project);
    project.url = r.url;
    project.deployed = true;
    project.deployedAt = Date.now();
    project.updatedAt = Date.now();
    project.history.push({ role: 'system', content: `✅ 已部署到：${r.url}` });
    await store.saveProject(project);
    return json({ project, url: r.url });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}

/** 执行部署：解析凭据（OAuth 优先，自动刷新）→ 缓存子域 → 上传脚本 → 返回访问地址 */
async function doDeploy(store, settings, project) {
  const cred = await getCredentials(store, settings);
  if (!settings.cfSubdomain) {
    const r = await getAccountSubdomain(cred.token, cred.accountId);
    settings.cfSubdomain = r.subdomain;
    await store.saveSettings(settings);
  }
  await deployWorker({
    cfToken: cred.token,
    accountId: cred.accountId,
    scriptName: project.workerName,
    code: project.code,
  });
  const url = `https://${project.workerName}.${settings.cfSubdomain}.workers.dev`;
  return { url };
}
