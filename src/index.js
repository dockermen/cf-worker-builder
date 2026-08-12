/**
 * Worker 在线构建器 - 主入口
 *
 * 功能：
 * 1. 配置 OpenAI 兼容大模型（Base URL / Key / 模型），接入 DeepSeek 等 Agent
 * 2. 以项目为单位对话式生成 Worker 代码，自动部署到 Cloudflare Workers 并返回地址
 * 3. 内置 Cloudflare 登录态：支持「设备码在线登录」（类似 wrangler login）与手动 API Token，
 *    Token 持久化在 KV 且自动刷新，无需每次登录
 */

// 任务回传地址默认值：固定使用 workers.dev 永久域名（不随自定义域更换而变化；
// GitHub/CNB runner 均在海外或走代理，可正常访问 workers.dev）。
export const DEFAULT_BUILDER_BASE_URL = 'https://cf-worker-builder.zhilong.workers.dev';

import { json, slugify, extractCode, maskKey, DEFAULT_CODE, pushVersion, normalizeBaseUrl } from './util.js';
import { makeStore } from './store.js';
import { callChatCompletion, streamChatCompletion, SYSTEM_PROMPT } from './agent.js';
import {
  getClientId,
  startDeviceFlow,
  pollDeviceFlow,
  refreshOAuthToken,
  logoutOAuth,
  getCredentials,
  publicOAuth,
  switchOAuth,
} from './oauth.js';
import { login, checkAuth, changePassword } from './auth.js';
import { extractHttpTest, extractAllHttpTests, executeHttpTest, formatTestResult, formatToolResult, extractRoutes, detectProxyWorker } from './tools.js';
import { triggerCnbBuild } from './cnb.js';
import { triggerGithubWorkflow } from './github.js';
import { deployWorker, getAccountSubdomain, testCloudflareConnection, deleteWorker, fetchWorkerCode, listWorkers } from './deploy.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const store = makeStore(env.BUILDER_KV);

    try {
      if (url.pathname.startsWith('/api/')) {
        // 访问密码鉴权：登录与状态检查接口豁免，其余 API 需携带有效 token
        const AUTH_FREE = ['/api/auth/login', '/api/auth/check'];
        // CNB 外部执行器回调用任务自身 token 鉴权，不走访问密码
        const isTaskEndpoint = url.pathname.startsWith('/api/tasks/');
        if (!AUTH_FREE.includes(url.pathname) && !isTaskEndpoint) {
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

  /**
   * 当前账号归属 key：OAuth 激活账号的 accountId（同一邮箱授权不同空间时以 accountId 区分）；
   * 手动 API Token 模式为 'token'；未配置任何凭据返回 ''。
   */
  const currentOwnerKey = async (settings) => {
    const oauth = await store.getOAuth();
    if (oauth && oauth.accessToken && oauth.accountId) return oauth.accountId;
    if (settings && settings.cfToken) return 'token';
    return '';
  };

  /** 项目列表可见性：旧项目（ownerKey 为空）所有账号可见；新项目仅归属账号可见 */
  const visibleProjects = (list, ownerKey) => (list || []).filter((p) => !p.ownerKey || p.ownerKey === ownerKey);

  /** 校验项目归属：返回 { ok, project? }；归属不符视为不存在（404），兼容旧项目 */
  const assertProjectOwner = async (id, settings) => {
    const project = await store.getProject(id);
    if (!project) return { ok: false, status: 404 };
    const ownerKey = await currentOwnerKey(settings);
    if (project.ownerKey && project.ownerKey !== ownerKey) return { ok: false, status: 404 };
    return { ok: true, project };
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
    const ownerKey = await currentOwnerKey(settings);
    const oauth = await store.getOAuth();
    const oauthAccounts = await store.listOAuthAccounts();
    const activeOAuthId = await store.getActiveOAuthId();
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
        cfSubdomain: (settings.cfSubdomains || {})[(await currentOwnerKey(settings))] || settings.cfSubdomain || '',
        cnbRepo: settings.cnbRepo || '',
        cnbBranch: settings.cnbBranch || 'main',
        cnbFallbackIp: settings.cnbFallbackIp || '',
        cnbProxySub: settings.cnbProxySub || '',
        cnbProxySubMasked: maskKey(settings.cnbProxySub),
        cnbTokenMasked: maskKey(settings.cnbToken),
        hasCnb: !!(settings.cnbRepo && settings.cnbToken),
        // GitHub Actions
        ghEnabled: settings.ghEnabled !== false,
        ghRepo: settings.ghRepo || '',
        ghRef: settings.ghRef || 'main',
        ghTokenMasked: maskKey(settings.ghToken),
        hasGh: !!(settings.ghRepo && settings.ghToken),
        // 后台执行器选择：github / cnb / none（仅流式）
        executor: settings.executor || (settings.ghRepo && settings.ghToken ? 'github' : 'none'),
        builderBaseUrl: settings.builderBaseUrl || DEFAULT_BUILDER_BASE_URL,
        maxToolRounds: Number(settings.maxToolRounds) || 8,
      },
      oauth: {
        ...publicOAuth(oauth),
        activeId: activeOAuthId,
        accounts: oauthAccounts.map((a) => ({
          ...publicOAuth(a),
          key: a.accountId || a.email || '',
          email: a.email || '',
          accountName: a.accountName || '',
        })),
      },
      // 账号隔离：只返回当前账号（或手动 Token）归属的项目；旧项目（无 ownerKey）对所有账号可见
      projects: visibleProjects(projects, ownerKey),
    });
  }

  // ============ 探测模型列表（OpenAI 兼容 /models） ============
  if (pathname === '/api/models' && method === 'GET') {
    const settings = await store.getSettings();
    if (!settings.openaiBaseUrl || !settings.openaiKey) {
      return json({ error: '请先填写 OpenAI Base URL 和 API Key 再获取模型列表' }, 400);
    }
    const base = normalizeBaseUrl(settings.openaiBaseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${settings.openaiKey}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json().catch(() => ({}));
      const models = (Array.isArray(data.data) ? data.data : [])
        .map((m) => (m && m.id ? String(m.id) : ''))
        .filter(Boolean)
        .sort();
      if (!models.length) throw new Error('返回的模型列表为空');
      return json({ ok: true, models, count: models.length });
    } catch (e) {
      const msg = e && e.name === 'AbortError' ? '请求超时（12 秒）' : String(e.message || '未知错误');
      return json(
        {
          ok: false,
          error: `模型列表接口不可用：${msg}（该服务商可能未开放 /models 接口，请手动填写模型名称）`,
        },
        200
      );
    } finally {
      clearTimeout(timer);
    }
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
      cnbRepo: String(body.cnbRepo || '').trim() || settings.cnbRepo || '',
      cnbToken: String(body.cnbToken || '').trim() || settings.cnbToken || '',
      cnbBranch: String(body.cnbBranch || '').trim() || settings.cnbBranch || 'main',
      cnbFallbackIp: String(body.cnbFallbackIp || '').trim() || settings.cnbFallbackIp || '',
      cnbProxySub: String(body.cnbProxySub || '').trim() || settings.cnbProxySub || '',
      // GitHub Actions
      ghEnabled: typeof body.ghEnabled === 'boolean' ? body.ghEnabled : settings.ghEnabled !== false,
      ghRepo: String(body.ghRepo || '').trim() || settings.ghRepo || '',
      ghToken: String(body.ghToken || '').trim() || settings.ghToken || '',
      ghRef: String(body.ghRef || '').trim() || settings.ghRef || 'main',
      // 后台执行器选择：github / cnb / none
      executor: ['github', 'cnb', 'none'].includes(body.executor) ? body.executor : (settings.executor || (settings.ghRepo && settings.ghToken ? 'github' : 'none')),
      // 各账号 workers.dev 子域缓存（按 accountId），切换账号不串域
      cfSubdomains: settings.cfSubdomains || {},
      // 任务回传地址（默认 workers.dev 永久域名）
      builderBaseUrl: String(body.builderBaseUrl || '').trim() || settings.builderBaseUrl || DEFAULT_BUILDER_BASE_URL,
      // Agent 工具循环轮数上限（2-30，默认 8；模型不再调用工具时自动提前结束）
      maxToolRounds: Math.min(30, Math.max(2, Number(body.maxToolRounds) || Number(settings.maxToolRounds) || 8)),
    };

    if (!next.openaiBaseUrl || !next.openaiKey || !next.openaiModel) {
      return json({ error: '请填写完整的 OpenAI 兼容配置（Base URL、Key、模型）' }, 400);
    }

    // 手动 Token 方式下：可选校验 Cloudflare 凭据并缓存 workers.dev 子域（按 accountId）
    let cfTestError = null;
    if (next.cfToken && next.cfAccountId) {
      try {
        const r = await testCloudflareConnection(next.cfToken, next.cfAccountId);
        next.cfSubdomain = r.subdomain;
        const subs = next.cfSubdomains || {};
        subs[next.cfAccountId] = r.subdomain;
        next.cfSubdomains = subs;
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
        cnbRepo: next.cnbRepo,
        cnbBranch: next.cnbBranch,
        cnbFallbackIp: next.cnbFallbackIp,
        cnbProxySub: next.cnbProxySub,
        cnbProxySubMasked: maskKey(next.cnbProxySub),
        cnbTokenMasked: maskKey(next.cnbToken),
        hasCnb: !!(next.cnbRepo && next.cnbToken),
        ghEnabled: next.ghEnabled !== false,
        ghRepo: next.ghRepo,
        ghRef: next.ghRef,
        ghTokenMasked: maskKey(next.ghToken),
        hasGh: !!(next.ghRepo && next.ghToken),
        executor: next.executor,
        builderBaseUrl: next.builderBaseUrl || DEFAULT_BUILDER_BASE_URL,
        maxToolRounds: Number(next.maxToolRounds) || 8,
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
        const settings = await store.getSettings();
        const cred = await getCredentials(store, settings);
        subdomain = await getSubdomainForAccount(store, settings, cred.token, cred.accountId);
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
    const body = await readBody();
    await logoutOAuth(store, String(body.accountId || ''));
    const accounts = await store.listOAuthAccounts();
    const activeId = await store.getActiveOAuthId();
    const active = accounts.find((a) => (a.accountId || a.email) === activeId) || null;
    return json({
      ok: true,
      oauth: {
        ...publicOAuth(active),
        activeId,
        accounts: accounts.map((a) => ({
          ...publicOAuth(a),
          key: a.accountId || a.email || '',
          email: a.email || '',
          accountName: a.accountName || '',
        })),
      },
    });
  }

  // 切换当前激活账号（多账号登录态各自保留）
  if (pathname === '/api/oauth/switch' && method === 'POST') {
    const body = await readBody();
    try {
      const oauth = await switchOAuth(store, String(body.accountId || ''));
      const accounts = await store.listOAuthAccounts();
      const activeId = await store.getActiveOAuthId();
      return json({
        ok: true,
        oauth: {
          ...publicOAuth(oauth),
          activeId,
          accounts: accounts.map((a) => ({
            ...publicOAuth(a),
            key: a.accountId || a.email || '',
            email: a.email || '',
            accountName: a.accountName || '',
          })),
        },
      });
    } catch (e) {
      return json({ error: e.message }, 400);
    }
  }

  // ============ 项目列表（按账号隔离） ============
  if (pathname === '/api/projects' && method === 'GET') {
    const settings = await store.getSettings();
    const ownerKey = await currentOwnerKey(settings);
    return json({ projects: visibleProjects(await store.listProjects(), ownerKey) });
  }

  // ============ 创建项目 ============
  if (pathname === '/api/projects' && method === 'POST') {
    const body = await readBody();
    const name = String(body.name || '').trim();
    if (!name) return json({ error: '项目名称不能为空' }, 400);

    const id = crypto.randomUUID();
    const workerName = `${slugify(name)}-${id.slice(0, 4)}`;
    const now = Date.now();
    const settings = await store.getSettings();
    const ownerKey = await currentOwnerKey(settings);
    const project = {
      id,
      name,
      description: String(body.description || '').trim(),
      workerName,
      ownerKey, // 归属当前 Cloudflare 账号（accountId）；手动 Token 模式为 'token'
      source: 'created', // created=构建器创建，linked=关联已有 Worker
      code: DEFAULT_CODE,
      url: '',
      deployed: false,
      deployedAt: null,
      history: [],
      versions: [],
      nextVersion: 1,
      memory: {
        doc: `# 项目记忆\n\n## 一、需求\n${body.description ? String(body.description).trim() : '（待通过对话补充需求）'}\n\n## 二、功能\n- 基础 Hello Worker 模板，尚未实现具体功能。\n\n## 三、技术信息\n- 平台：Cloudflare Workers（ES Module 格式）\n- 入口：export default { async fetch(request, env, ctx) }\n\n## 四、变更记录\n- 暂无`,
        updatedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    };
    await store.saveProject(project);
    return json({ project });
  }

  // ============ 单个项目：GET / DELETE（按账号隔离） ============
  // 注意：import 是子路径（/api/projects/import），必须排除，否则会被当成项目 id 走归属校验返回 404
  const projectMatch = pathname.match(/^\/api\/projects\/(?!import$)([^/]+)$/);
  if (projectMatch) {
    const id = projectMatch[1];
    {
      const guard = await assertProjectOwner(id, await store.getSettings());
      if (!guard.ok) return json({ error: '项目不存在' }, 404);
    }
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

  // ============ 列出账号下已有 Worker（关联下拉选择） ============
  if (pathname === '/api/workers/list' && method === 'GET') {
    const settings = await store.getSettings();
    let cred;
    try {
      cred = await getCredentials(store, settings);
    } catch (e) {
      return json({ error: e.message }, 400);
    }
    try {
      const workers = await listWorkers(cred.token, cred.accountId);
      return json({ workers });
    } catch (e) {
      return json({ error: e.message }, 400);
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
    const ownerKey = await currentOwnerKey(settings);
    const project = {
      id,
      name: body.name ? String(body.name).trim() : workerName,
      description: `已关联 Cloudflare Worker：${workerName}（${isModule ? 'ES Module' : 'Service Worker'} 格式）`,
      workerName,
      ownerKey, // 归属当前账号（accountId / token）
      source: 'linked', // 关联项目：删除时只移除本地，不影响远程 Worker
      code,
      url: '',
      deployed: true,
      deployedAt: now,
      history: [
        { role: 'system', content: `🔗 已关联已有 Cloudflare Worker：${workerName}，可在对话中描述需求进行修改，修改后自动部署覆盖该 Worker。` },
      ],
      versions: [],
      nextVersion: 1,
      memory: {
        doc: `# 项目记忆\n\n## 一、需求\n（待分析）\n\n## 二、功能\n（待分析）\n\n## 三、技术信息\n- 关联 Worker：${workerName}\n\n## 四、变更记录\n- 关联导入`,
        updatedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    };
    // 用 LLM 分析远程代码，生成详细的项目记忆文档（需求/功能/技术信息），作为后续代码生成依据
    try {
      const analysis = await callChatCompletion(settings, [
        {
          role: 'system',
          content:
            '你是代码分析器。请分析下面的 Cloudflare Worker 代码，输出详细的项目记忆文档（Markdown），必须包含：## 一、需求（推断用户核心需求）## 二、功能（逐条列出已实现功能）## 三、技术信息（路由、外部依赖、关键实现与注意事项）## 四、变更记录（初始：关联导入）。要求详细准确，500 字以内，不要输出代码。',
        },
        { role: 'user', content: String(code || '').slice(0, 4000) },
      ]);
      if (analysis) {
        project.memory = { doc: String(analysis).slice(0, 3000), updatedAt: now };
      }
    } catch (_) { /* 降级保留默认记忆 */ }
    // 探测子域并拼接访问地址
    try {
      const sd = await getAccountSubdomain(cred.token, cred.accountId);
      settings.cfSubdomain = sd;
      await store.saveSettings(settings);
      project.url = `https://${workerName}.${sd}.workers.dev`;
    } catch (_) { /* ignore */ }
    // 版本基线：关联导入的原始远程代码固定为版本 #1，便于后续对比/恢复
    pushVersion(project, '关联导入：远程 Worker 原始代码', project.url);
    await store.saveProject(project);
    return json({ project });
  }

  // ============ 项目版本控制 ============
  const versionsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/versions$/);
  if (versionsMatch && method === 'GET') {
    const guard = await assertProjectOwner(versionsMatch[1], await store.getSettings());
    if (!guard.ok) return json({ error: '项目不存在' }, 404);
    const project = guard.project;
    if (!project) return json({ error: '项目不存在' }, 404);
    const versions = (project.versions || []).slice().reverse(); // 新版在前
    return json({ versions, nextVersion: project.nextVersion || 1 });
  }

  const versionMatch = pathname.match(/^\/api\/projects\/([^/]+)\/versions\/(\d+)(?:\/restore)?$/);
  if (versionMatch && (method === 'GET' || method === 'POST')) {
    const guard = await assertProjectOwner(versionMatch[1], await store.getSettings());
    if (!guard.ok) return json({ error: '项目不存在' }, 404);
    const project = guard.project;
    if (!project) return json({ error: '项目不存在' }, 404);
    const v = Number(versionMatch[2]);
    const ver = (project.versions || []).find((x) => x.v === v);
    if (!ver) return json({ error: '版本不存在' }, 404);
    if (method === 'GET') return json({ version: ver });

    // POST：恢复版本（可选立即部署），同时恢复该版本对应的项目功能记忆
    const body = await readBody();
    project.code = ver.code;
    if (ver.memory) project.memory = JSON.parse(JSON.stringify(ver.memory));
    project.updatedAt = Date.now();
    project.history.push({ role: 'system', content: `↩️ 已恢复到版本 #${v}（${ver.note || ''}）` });
    let deployed = false;
    let url = project.url || '';
    if (body.deploy) {
      try {
        const settings = await store.getSettings();
        const r = await doDeploy(store, settings, project, `恢复版本 #${v} 并部署`);
        deployed = true;
        url = r.url;
        project.url = r.url;
        project.deployed = true;
        project.deployedAt = Date.now();
        project.history.push({ role: 'system', content: `✅ 版本 #${v} 已重新部署到：${r.url}` });
        pushVersion(project, `恢复版本 #${v} 并部署`, r.url);
      } catch (e) {
        project.history.push({ role: 'system', content: `⚠️ 恢复后重新部署失败：${e.message}` });
      }
    }
    await store.saveProject(project);
    return json({ project, deployed, url });
  }

  // ============ 版本打 tag（标记版本永久保留，不受数量上限限制） ============
  const tagMatch = pathname.match(/^\/api\/projects\/([^/]+)\/versions\/(\d+)\/tag$/);
  if (tagMatch && method === 'POST') {
    const guard = await assertProjectOwner(tagMatch[1], await store.getSettings());
    if (!guard.ok) return json({ error: '项目不存在' }, 404);
    const project = guard.project;
    if (!project) return json({ error: '项目不存在' }, 404);
    const v = Number(tagMatch[2]);
    const ver = (project.versions || []).find((x) => x.v === v);
    if (!ver) return json({ error: '版本不存在' }, 404);
    const body = await readBody();
    ver.tagged = body.tag === true || body.tag === 'true';
    project.updatedAt = Date.now();
    await store.saveProject(project);
    return json({ version: ver, tagged: ver.tagged });
  }

  // ============ 对话进行中状态查询 ============
  const statusMatch = pathname.match(/^\/api\/projects\/([^/]+)\/chat-status$/);
  if (statusMatch && method === 'GET') {
    const guard = await assertProjectOwner(statusMatch[1], await store.getSettings());
    if (!guard.ok) return json({ error: '项目不存在' }, 404);
    const status = await store.getChatStatus(statusMatch[1]);
    return json({ status });
  }
  // 手动结束卡死的后台任务（执行器挂了但状态未清时，前端提供「结束等待」按钮）
  const statusClearMatch = pathname.match(/^\/api\/projects\/([^/]+)\/chat-status\/clear$/);
  if (statusClearMatch && method === 'POST') {
    const guard = await assertProjectOwner(statusClearMatch[1], await store.getSettings());
    if (!guard.ok) return json({ error: '项目不存在' }, 404);
    await store.clearChatStatus(statusClearMatch[1]);
    return json({ ok: true });
  }

  // ============ 项目子操作：chat / chat/stream / deploy / code / clear ============
  const actionMatch = pathname.match(/^\/api\/projects\/([^/]+)\/(chat(?:\/stream|\/async)?|deploy|code|clear)$/);
  if (actionMatch) {
    const id = actionMatch[1];
    const action = actionMatch[2];
    {
      const guard = await assertProjectOwner(id, await store.getSettings());
      if (!guard.ok) return json({ error: '项目不存在' }, 404);
    }

    if (action === 'chat' && method === 'POST') {
      return await chatAction(request, store, id);
    }
    if (action === 'chat/stream' && method === 'POST') {
      return await streamChatAction(request, store, id);
    }
    if (action === 'chat/async' && method === 'POST') {
      return await asyncChatAction(request, store, id);
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

  // ============ CNB 外部执行器任务（runner 用任务 token 鉴权，不走访问密码） ============
  const taskProgressMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/progress$/);
  if (taskProgressMatch && method === 'POST') {
    return await taskProgressAction(store, taskProgressMatch[1], await readBody());
  }
  const taskResultMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/result$/);
  if (taskResultMatch && method === 'POST') {
    return await taskResultAction(store, taskResultMatch[1], await readBody());
  }
  const taskFetchMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskFetchMatch && method === 'GET') {
    return await taskFetchAction(store, taskFetchMatch[1], url);
  }

  return json({ error: '接口不存在' }, 404);
}

/**
 * 异步对话（方案 B：CNB 外部执行器）
 * - 保存用户消息 → 生成一次性任务（含 LLM 配置与 Cloudflare 凭据快照）→ 触发 CNB 流水线 → 立即返回
 * - CNB runner（agent-runner/run.js，无时长限制）执行 LLM 循环/工具/部署/冒烟，结果回调写回项目
 * - 前端轮询 chat-status 获取实时进度（stage/note），任务完成时状态清除并刷新项目
 */
async function asyncChatAction(request, store, id) {
  const project = await store.getProject(id);
  if (!project) return json({ error: '项目不存在' }, 404);

  const body = await request.json().catch(() => ({}));
  const message = String(body.message || '').trim();
  if (!message) return json({ error: '消息不能为空' }, 400);

  const settings = await store.getSettings();
  // 任务回传地址：固定使用配置值（默认 workers.dev 永久域名），不随当前自定义域变化
  const baseUrl = String(settings.builderBaseUrl || DEFAULT_BUILDER_BASE_URL).replace(/\/+$/, '');
  if (!settings.openaiBaseUrl || !settings.openaiKey || !settings.openaiModel) {
    return json({ error: '请先在「设置」中配置 OpenAI Base URL、Key 和模型' }, 400);
  }
  // 后台执行器：github / cnb / none
  const executor = settings.executor === 'cnb' ? 'cnb' : settings.executor === 'github' ? 'github' : 'none';
  if (executor === 'none') {
    return json({ error: '尚未选择后台执行器（设置 → ④ 后台执行器：GitHub Actions / CNB），无法使用后台长任务对话；或直接使用普通流式对话' }, 400);
  }
  if (executor === 'github' && (!settings.ghRepo || !settings.ghToken)) {
    return json({ error: '已选择 GitHub Actions，但未配置仓库路径或 PAT（设置 → ④ 后台执行器）' }, 400);
  }
  if (executor === 'cnb' && (!settings.cnbRepo || !settings.cnbToken)) {
    return json({ error: '已选择 CNB，但未配置仓库路径或 Token（设置 → ④ 后台执行器）' }, 400);
  }

  // 用户消息立即持久化（重试去重；即使后续失败，切换页面后记录也不丢失）
  const lastMsg = project.history[project.history.length - 1];
  if (lastMsg && lastMsg.role === 'user' && lastMsg.content === message) {
    project.history.pop();
  }
  project.history.push({ role: 'user', content: message });
  project.updatedAt = Date.now();
  await store.saveProject(project);

  await maybeCompact(store, settings, project); // 长对话自动压缩早期上下文
  await store.setChatStatus(id, { status: 'running', executor, taskId: '', startedAt: Date.now(), stage: 'preparing', note: '正在准备任务…', updatedAt: Date.now() });

  // 解析 Cloudflare 凭据（OAuth 自动刷新），快照进任务，runner 不依赖构建器登录态
  let cf;
  try {
    const cred = await getCredentials(store, settings);
    cf = { token: cred.token, accountId: cred.accountId };
    cf.subdomain = await getSubdomainForAccount(store, settings, cf.token, cf.accountId);
  } catch (e) {
    await store.clearChatStatus(id);
    return json({ error: `Cloudflare 凭据不可用：${e.message}` }, 400);
  }

  // 任务快照：一次性 token，LLM Key / CF Token 只经构建器 → runner 的单次拉取，不进 GitHub 环境/日志
  const taskId = crypto.randomUUID();
  const taskToken = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const task = {
    id: taskId,
    projectId: id,
    token: taskToken,
    executor,
    createdAt: Date.now(),
    autoDeploy: body.autoDeploy !== false,
    userMessage: message,
    workerName: project.workerName,
    url: project.url || '',
    messages: buildMessages(project),
    settings: {
      openaiBaseUrl: settings.openaiBaseUrl,
      openaiKey: settings.openaiKey,
      openaiModel: settings.openaiModel,
      openaiApiType: settings.openaiApiType || 'chat',
    },
    maxToolRounds: Number(settings.maxToolRounds) || 8,
    cf,
    ghRunUrl: '',
    cnbSn: '',
    buildLogUrl: '',
    status: 'queued',
  };
  await store.saveTask(task);

  let queuedNote = '';
  if (executor === 'github') {
    // 触发 GitHub Actions workflow_dispatch（runner 在 .github/workflows/builder-task.yml）
    try {
      await triggerGithubWorkflow({
        repo: settings.ghRepo,
        token: settings.ghToken,
        ref: settings.ghRef || 'main',
        taskId,
        taskToken,
        baseUrl,
      });
      task.ghRunUrl = `https://github.com/${settings.ghRepo}/actions`;
      task.status = 'running';
      await store.saveTask(task);
    } catch (e) {
      await store.deleteTask(taskId);
      project.history.push({ role: 'system', content: `⚠️ GitHub Actions 任务提交失败：${e.message}` });
      project.updatedAt = Date.now();
      await store.saveProject(project);
      await store.clearChatStatus(id);
      return json({ error: e.message }, 502);
    }
    queuedNote = `任务已提交到 GitHub Actions（${settings.ghRepo}），排队等待执行… 运行日志：${task.ghRunUrl}`;
  } else {
    // 触发 CNB 云原生构建（api_trigger_builder 事件；可选 Clash 代理订阅解决访问 Cloudflare 网络问题）
    try {
      const r = await triggerCnbBuild({
        repo: settings.cnbRepo,
        token: settings.cnbToken,
        branch: settings.cnbBranch || 'main',
        taskId,
        taskToken,
        baseUrl,
        fallbackIp: settings.cnbFallbackIp || '',
        proxySub: settings.cnbProxySub || '',
      });
      task.cnbSn = r.sn || '';
      task.buildLogUrl = r.buildLogUrl || '';
      task.status = 'running';
      await store.saveTask(task);
    } catch (e) {
      await store.deleteTask(taskId);
      project.history.push({ role: 'system', content: `⚠️ CNB 任务提交失败：${e.message}` });
      project.updatedAt = Date.now();
      await store.saveProject(project);
      await store.clearChatStatus(id);
      return json({ error: e.message }, 502);
    }
    queuedNote = `任务已提交到 CNB 云构建（${settings.cnbRepo}${task.cnbSn ? ` SN ${task.cnbSn}` : ''}），排队等待执行…${
      task.buildLogUrl ? ` 日志：${task.buildLogUrl}` : ''
    }`;
  }
  await store.setChatStatus(id, {
    status: 'running',
    executor,
    taskId,
    startedAt: Date.now(),
    stage: 'queued',
    round: 0,
    note: queuedNote,
    updatedAt: Date.now(),
  });
  return json({ ok: true, taskId, status: 'queued' });
}

/** CNB runner 拉取任务（一次性 token 鉴权） */
async function taskFetchAction(store, taskId, url) {
  const token = url.searchParams.get('token') || '';
  const task = await store.getTask(taskId);
  if (!task || !task.token || task.token !== token) {
    return json({ error: '任务不存在或令牌无效' }, 404);
  }
  await store.touchTask(taskId);
  return json({
    taskId: task.id,
    workerName: task.workerName,
    url: task.url,
    autoDeploy: task.autoDeploy,
    messages: task.messages,
    settings: task.settings,
    maxToolRounds: Number(task.maxToolRounds) || 8,
    cf: task.cf,
  });
}

/** CNB runner 上报进度：更新 chat-status，前端轮询即可看到实时阶段 */
async function taskProgressAction(store, taskId, body) {
  const token = String(body.token || '');
  const task = await store.getTask(taskId);
  if (!task || task.token !== token) {
    return json({ error: '任务不存在或令牌无效' }, 404);
  }
  await store.touchTask(taskId);
  await store.setChatStatus(task.projectId, {
    status: 'running',
    executor: task.executor || 'github',
    taskId,
    startedAt: Date.now(),
    stage: String(body.stage || 'running'),
    round: Number(body.round) || 0,
    note: String(body.note || '执行中…'),
    updatedAt: Date.now(),
  });
  return json({ ok: true });
}

/** CNB runner 回传结果：写回对话历史/代码/版本/记忆，并清理状态 */
async function taskResultAction(store, taskId, body) {
  const token = String(body.token || '');
  const task = await store.getTask(taskId);
  if (!task || task.token !== token) {
    return json({ error: '任务不存在或令牌无效' }, 404);
  }
  const r = await finishAsyncTask(store, task, body);
  return json(r.ok ? { ok: true } : { error: r.error }, r.ok ? 200 : 500);
}

/** 把 CNB runner 的执行结果合并进项目（与流式路径的落库逻辑保持一致） */
async function finishAsyncTask(store, task, payload) {
  const project = await store.getProject(task.projectId);
  if (!project) return { ok: false, error: '项目不存在' };

  const error = String(payload.error || '').trim();
  const reply = String(payload.reply || '').trim();
  if (error) {
    const logLink = task.ghRunUrl ? `（运行日志：${task.ghRunUrl}）` : (task.buildLogUrl ? `（构建日志：${task.buildLogUrl}）` : '');
    project.history.push({ role: 'system', content: `⚠️ 对话任务执行失败：${error.slice(0, 500)}${logLink}` });
  } else {
    if (reply) project.history.push({ role: 'assistant', content: reply });
    const code = payload.code || null;
    if (code) project.code = code;
    const deployed = !!payload.deployed;
    const deployError = payload.deployError ? String(payload.deployError) : '';
    if (deployed && payload.url) {
      project.url = payload.url;
      project.deployed = true;
      project.deployedAt = Date.now();
      project.history.push({ role: 'system', content: `✅ 已自动部署到：${payload.url}` });
    } else if (deployError) {
      project.history.push({
        role: 'system',
        content: `⚠️ 代码已生成，但自动部署失败：${deployError}（可稍后在「代码」页手动重新部署）`,
      });
    }
    const toolResults = Array.isArray(payload.toolResults) ? payload.toolResults : [];
    toolResults.forEach((r, i) => {
      project.history.push({ role: 'system', content: formatToolResult(r, i + 1) });
    });
    const smokeTest = payload.smokeTest || null;
    if (smokeTest) {
      if (!smokeTest.error && smokeTest.status < 400) {
        project.history.push({
          role: 'system',
          content: `🌐 冒烟测试：${smokeTest.route === '/' ? '根路径 /' : smokeTest.route} → HTTP ${smokeTest.status} ✅`,
        });
      } else {
        project.history.push({ role: 'system', content: formatTestResult(smokeTest, '冒烟测试：') });
      }
    }
    if (deployed) {
      // 先更新项目功能记忆，再存档版本（版本快照包含最新记忆）
      const settings = await store.getSettings();
      await updateProjectMemory(store, settings, project, task.userMessage);
      pushVersion(project, String(task.userMessage || '对话生成并部署').slice(0, 40) || '对话生成并部署', payload.url || '');
    }
  }
  project.updatedAt = Date.now();
  await store.saveProject(project);
  await store.clearChatStatus(project.id);
  await store.deleteTask(task.id);
  return { ok: true };
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

  // 追加用户消息（立即持久化：即使后续失败，切换页面后记录也不会丢失）
  const lastMsg = project.history[project.history.length - 1];
  if (lastMsg && lastMsg.role === 'user' && lastMsg.content === message) {
    project.history.pop(); // 上次失败重试去重
  }
  project.history.push({ role: 'user', content: message });
  await store.saveProject(project);

  await store.setChatStatus(id, { status: 'running', startedAt: Date.now(), stage: 'thinking', round: 1, note: '正在思考…', updatedAt: Date.now() });
  await maybeCompact(store, settings, project); // 长对话自动压缩早期上下文
  const messages = buildMessages(project);

  let reply;
  try {
    reply = await callChatCompletion(settings, messages);
  } catch (e) {
    await store.clearChatStatus(id);
    // 保留用户消息，并记录失败原因（便于切换页面后看到）
    project.history.push({ role: 'system', content: `⚠️ 对话调用失败：${e.message}` });
    project.updatedAt = Date.now();
    await store.saveProject(project);
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
        const r = await doDeploy(store, settings, project, message.slice(0, 40) || '对话生成并部署');
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

  // Agent 工具：test-http + 自动冒烟测试（非流式路径）
  let testResult = null;
  let smokeTest = null;
  const testSpec = extractHttpTest(reply);
  if (testSpec) {
    testResult = await executeHttpTest(testSpec);
    project.history.push({ role: 'system', content: formatTestResult(testResult, 'HTTP ') });
  }
  if (deployed) {
    try {
      smokeTest = await smartSmokeTest(url, project.code);
      if (smokeTest && !smokeTest.error && smokeTest.status < 400) {
        project.history.push({
          role: 'system',
          content: `🌐 冒烟测试：${smokeTest.route === '/' ? '根路径 /' : smokeTest.route} → HTTP ${smokeTest.status} ✅`,
        });
      } else if (smokeTest) {
        project.history.push({ role: 'system', content: formatTestResult(smokeTest, '冒烟测试：') });
      }
    } catch (_) { /* ignore */ }
  }

  // 部署成功：先更新项目功能记忆，再存档版本（版本快照包含最新记忆）
  if (deployed && message) {
    await updateProjectMemory(store, settings, project, message);
  }
  if (deployed) {
    pushVersion(project, message.slice(0, 40) || '对话生成并部署', url);
  }
  await store.saveProject(project);
  await store.clearChatStatus(id);
  return json({ project, reply, code, deployed, url, deployError, testResult, smokeTest });
}

/**
 * 流式对话（递归工具循环）：
 * - SSE 逐字输出；若模型输出 test-http / MARKDOWN 工具块，系统在同一轮对话内自动执行并把结果回填给模型，
 *   模型可基于结果继续输出（修改代码、再次测试…），直到无工具调用或达到轮次上限（MAX_TOOL_ROUNDS）
 * 事件：delta（增量文本）/ tool（工具执行摘要）/ toolnote（提示）/ done / error
 */
async function streamChatAction(request, store, id) {
  const project = await store.getProject(id);
  if (!project) return json({ error: '项目不存在' }, 404);

  const body = await request.json().catch(() => ({}));
  const message = String(body.message || '').trim();
  if (!message) return json({ error: '消息不能为空' }, 400);

  const settings = await store.getSettings();
  if (!settings.openaiBaseUrl || !settings.openaiKey || !settings.openaiModel) {
    return json({ error: '请先在「设置」中配置 OpenAI Base URL、Key 和模型' }, 400);
  }

  // 用户消息立即持久化（重试去重）
  const lastMsg = project.history[project.history.length - 1];
  if (lastMsg && lastMsg.role === 'user' && lastMsg.content === message) {
    project.history.pop();
  }
  project.history.push({ role: 'user', content: message });
  project.updatedAt = Date.now();
  await store.saveProject(project);
  await store.setChatStatus(id, { status: 'running', startedAt: Date.now() });

  await maybeCompact(store, settings, project); // 长对话自动压缩早期上下文
  let messages = buildMessages(project);

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const MAX_TOOL_ROUNDS = Math.min(30, Math.max(2, Number(settings.maxToolRounds) || 8));
  const allToolResults = [];

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const taskStartedAt = Date.now();
      const MAX_TASK_MS = 600000; // 任务总时长兜底（10 分钟）
      let forcedEnd = false;
      try {
        let lastRoundText = '';
        const allRoundTexts = []; // 聚合所有轮次文本（代码可能出现在任意一轮）
        // ============ 递归工具循环 ============
        for (let round = 0; ; round++) {
          await store.setChatStatus(id, {
            status: 'running',
            startedAt: (await store.getChatStatus(id))?.startedAt || Date.now(),
            stage: 'thinking',
            round: round + 1,
            note: `第 ${round + 1} 轮生成中…`,
            updatedAt: Date.now(),
          });
          // 长会话：每轮都用最新项目代码重建上下文
          const curCtx = await store.getProject(id);
          messages = buildMessages(curCtx);
          const { response: llmRes, isResponses } = await streamChatCompletion(settings, messages);
          const reader = llmRes.body.getReader();
          let buffer = '';
          let roundText = '';
          // 可靠心跳：Promise.race 让「读流」与「20 秒定时器」竞争。
          // 即使模型长时间无输出（read 挂起），心跳分支也会定期刷新 chat-status，避免前端误判中断。
          let nextBeat = Date.now() + 20000; // 心跳绝对到期时间（数据密集也不会推迟心跳）
          while (true) {
            const raced = await Promise.race([
              reader.read().then(
                (v) => ({ type: 'data', v }),
                (e) => ({ type: 'error', e })
              ),
              new Promise((r) => setTimeout(() => r({ type: 'beat' }), Math.max(0, nextBeat - Date.now()))),
            ]);
            if (raced.type === 'beat') {
              if (Date.now() >= nextBeat) {
                nextBeat = Date.now() + 20000;
                await store.setChatStatus(id, {
                  status: 'running',
                  startedAt: taskStartedAt,
                  stage: 'thinking',
                  round: round + 1,
                  note: `第 ${round + 1} 轮生成中（已输出 ${roundText.length} 字，等待模型输出…）`,
                  updatedAt: Date.now(),
                });
                // 总时长兜底：超时强制结束，避免任务永久悬挂
                if (Date.now() - taskStartedAt > MAX_TASK_MS) {
                  forcedEnd = true;
                  try { await reader.cancel(); } catch (_) { /* ignore */ }
                  break;
                }
              }
              continue;
            }
            if (raced.type === 'error') break; // 流被 cancel 或网络错误
            const { done, value } = raced.v;
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf('\n\n')) >= 0) {
              const chunk = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              for (const line of chunk.split('\n')) {
                if (!line.startsWith('data:')) continue;
                const dataStr = line.slice(5).trim();
                if (dataStr === '[DONE]') continue;
                let evt;
                try { evt = JSON.parse(dataStr); } catch { continue; }
                let delta = '';
                if (isResponses) {
                  if (evt.type === 'response.output_text.delta' || evt.type === 'output_text.delta') {
                    delta = evt.delta || '';
                  }
                } else if (evt.choices && evt.choices[0] && evt.choices[0].delta) {
                  delta = evt.choices[0].delta.content || '';
                }
                if (delta) {
                  roundText += delta;
                  send('delta', { text: delta });
                }
              }
            }
          }
          lastRoundText = roundText;
          allRoundTexts.push(roundText);

          if (forcedEnd) {
            // 任务超时：记录中断并结束整个对话（跳过部署），避免前端永久等待
            const curT = await store.getProject(id);
            curT.history.push({
              role: 'system',
              content: `⚠️ 对话超时（超过 ${Math.round(MAX_TASK_MS / 60000)} 分钟），已自动结束；已发送的内容保留在记录中，可重新发送或拆分需求。`,
            });
            curT.updatedAt = Date.now();
            await store.saveProject(curT);
            await store.clearChatStatus(id);
            send('error', {
              error: `任务超时（${Math.round(MAX_TASK_MS / 60000)} 分钟上限），请重试或拆分需求`,
            });
            controller.close();
            return;
          }

          // 保存本论回复
          const cur = await store.getProject(id);
          cur.history.push({ role: 'assistant', content: roundText });
          cur.updatedAt = Date.now();

          // 检查工具调用
          const tests = extractAllHttpTests(roundText);
          if (!tests.length) {
            await store.saveProject(cur);
            break; // 无工具调用，结束递归
          }

          // 执行工具并回填结果
          let toolIdx = 0;
          for (const spec of tests) {
            toolIdx++;
            await store.setChatStatus(id, {
              status: 'running',
              startedAt: (await store.getChatStatus(id))?.startedAt || Date.now(),
              stage: 'tool',
              round: round + 1,
              note: `正在执行工具：${String(spec).split('\n')[0] || 'HTTP 请求'}`,
              updatedAt: Date.now(),
            });
            const r = await executeHttpTest(spec);
            allToolResults.push(r);
            cur.history.push({ role: 'system', content: formatToolResult(r, toolIdx) });
            send('tool', { result: r });
          }
          await store.saveProject(cur);

          if (round >= MAX_TOOL_ROUNDS - 1) {
            send('toolnote', { message: `已达到工具自动调用轮次上限（${MAX_TOOL_ROUNDS}），如需继续可再发一条消息` });
            break;
          }
          // 更新上下文后自动进入下一轮（递归对话的核心）
          messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...cur.history.slice(-40)];
        }

        // ============ 循环结束：部署 + 冒烟测试 ============
        await store.setChatStatus(id, {
          status: 'running',
          startedAt: (await store.getChatStatus(id))?.startedAt || Date.now(),
          stage: 'deploying',
          round: 0,
          note: '正在部署与测试…',
          updatedAt: Date.now(),
        });
        const cur = await store.getProject(id);
        let deployed = false;
        let url = cur.url || '';
        let deployError = null;
        const fullReply = allRoundTexts.join('\n'); // 全部轮次合并（代码可能出现在任意一轮）
        const code = extractCode(fullReply);
        if (code) {
          cur.code = code;
          if (body.autoDeploy !== false) {
            try {
              const r = await doDeploy(store, settings, cur, message.slice(0, 40) || '对话生成并部署');
              deployed = true;
              url = r.url;
              cur.url = r.url;
              cur.deployed = true;
              cur.deployedAt = Date.now();
              cur.history.push({ role: 'system', content: `✅ 已自动部署到：${r.url}` });
            } catch (e) {
              deployError = e.message;
              cur.history.push({
                role: 'system',
                content: `⚠️ 代码已生成，但自动部署失败：${e.message}（可稍后在「代码」页手动重新部署）`,
              });
            }
          }
        }

        let smokeTest = null;
        if (deployed) {
          try {
            smokeTest = await smartSmokeTest(url, cur.code);
            if (smokeTest && !smokeTest.error && smokeTest.status < 400) {
              cur.history.push({
                role: 'system',
                content: `🌐 冒烟测试：${smokeTest.route === '/' ? '根路径 /' : smokeTest.route} → HTTP ${smokeTest.status} ✅`,
              });
            } else if (smokeTest) {
              cur.history.push({ role: 'system', content: formatTestResult(smokeTest, '冒烟测试：') });
            }
          } catch (_) { /* ignore */ }
        }

        // 部署成功：先更新项目功能记忆，再存档版本（版本快照包含最新记忆）
        if (deployed && message) {
          await updateProjectMemory(store, settings, cur, message);
        }
        if (deployed) {
          pushVersion(cur, message.slice(0, 40) || '对话生成并部署', url);
        }
        await store.saveProject(cur);
        await store.clearChatStatus(id);
        send('done', {
          reply: fullReply,
          code,
          deployed,
          url,
          deployError,
          testResult: allToolResults.length ? allToolResults[allToolResults.length - 1] : null,
          smokeTest,
          toolRounds: allToolResults.length ? undefined : 0,
          project: cur,
        });
        controller.close();
      } catch (e) {
        try {
          const cur = await store.getProject(id);
          cur.history.push({ role: 'system', content: `⚠️ 对话中断：${e.message}` });
          cur.updatedAt = Date.now();
          await store.saveProject(cur);
        } catch (_) { /* ignore */ }
        await store.clearChatStatus(id);
        send('error', { error: e.message });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

/**
 * 更新项目功能记忆：部署成功后把本次需求与功能变更并入项目简介。
 * 优先用 LLM 整合摘要，失败时降级为只记录需求更新列表。
 */
async function updateProjectMemory(store, settings, project, userMessage) {
  // 兼容旧格式：doc 优先，旧 summary/updates 回退
  const oldMemory = project.memory || {};
  const oldDoc = oldMemory.doc || oldMemory.summary || '（暂无记录）';
  const oldUpdates = (oldMemory.updates || []).map((u) => `${new Date(u.at).toLocaleString()}：${u.text}`).join('\n');
  const prompt = [
    {
      role: 'system',
      content:
        '你是项目记忆维护者。根据「旧记忆文档」「本次用户需求」「当前代码」，输出更新后的详细项目记忆文档（Markdown），必须包含：## 一、需求（用户核心需求，保留历史并合并新增）## 二、功能（已实现功能清单，逐条说明）## 三、技术信息（路由、外部依赖、关键实现与注意事项）## 四、变更记录（保留历史，末尾追加本次：时间+需求+改动）。要求详细准确，作为后续代码生成的依据，600 字以内，不要输出代码。',
    },
    {
      role: 'user',
      content: `旧记忆文档：\n${oldDoc}\n\n旧更新记录：\n${oldUpdates || '（无）'}\n\n本次用户需求：\n${String(userMessage || '').slice(0, 300)}\n\n当前项目代码开头（供参考）：\n${String(project.code || '').slice(0, 1500)}`,
    },
  ];
  try {
    const doc = await callChatCompletion(settings, prompt);
    project.memory = { doc: String(doc || '').slice(0, 3000), updatedAt: Date.now() };
  } catch (_) {
    // 降级：在记忆文档末尾追加变更记录
    const append = `\n- ${new Date().toLocaleString()}：${String(userMessage || '').slice(0, 200)}`;
    project.memory = {
      doc: `${oldDoc}${oldUpdates ? '' : ''}\n\n## 变更记录（降级追加）${append}`.slice(0, 3000),
      updatedAt: Date.now(),
    };
  }
}

/** 上下文参数：早期对话压缩后只保留最近 N 条完整消息 */
const CONTEXT_KEEP = 20;
const COMPACT_THRESHOLD = 35;

/** 组装 LLM 上下文：系统提示词 + 当前项目代码 + 历史（长会话锚定当前代码状态，支持压缩摘要） */
function buildMessages(project) {
  const history = project.history || [];
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'system',
      content: `当前项目代码（${project.workerName || ''}，修改请基于此代码，这是最新工作副本）：
\`\`\`javascript
${project.code || '(暂无代码)'}
\`\`\``,
    },
  ];
  // 注入项目详细记忆（需求/功能/技术信息），作为后续代码生成的依据
  if (project.memory && (project.memory.doc || project.memory.summary)) {
    messages.push({
      role: 'system',
      content: `【项目功能记忆：后续代码生成的依据，请据此理解项目并继续开发】\n${project.memory.doc || project.memory.summary}`,
    });
  }

  if (project.compacted && project.compacted.summary) {
    // 早期对话已压缩为摘要，保留要点；最近消息完整保留
    messages.push({
      role: 'system',
      content: `以下是更早对话的压缩摘要（约 ${project.compacted.count || 0} 条消息，请始终遵守其中的用户需求与已完成/遗留事项）：\n${project.compacted.summary}`,
    });
    messages.push(...history.slice(-CONTEXT_KEEP));
  } else {
    messages.push(...history.slice(-40));
  }
  return messages;
}

/**
 * 上下文压缩：历史消息过多时，把早期消息交给 LLM 生成要点摘要存入 project.compacted。
 * history 本身完整保留（供 UI 展示），仅 LLM 上下文使用压缩版，防止长对话遗忘早期需求。
 */
async function maybeCompact(store, settings, project) {
  const history = project.history || [];
  if (history.length <= COMPACT_THRESHOLD) return false;
  const old = history.slice(0, history.length - CONTEXT_KEEP);
  if (!old.length) return false;
  const text = old
    .map((m) => `[${m.role}] ${String(m.content || '').slice(0, 300)}`)
    .join('\n')
    .slice(0, 8000);
  const summaryPrompt = [
    {
      role: 'system',
      content:
        '你是一个对话摘要器。请把下面的对话压缩成中文要点摘要，必须保留：1) 用户的核心需求与约束（尤其早期提过、后续容易遗忘的需求）；2) 已完成的功能与改动（解决了哪些问题）；3) 当前代码状态；4) 待办/遗留问题。不要输出代码，控制在 250 字以内。',
    },
    { role: 'user', content: text },
  ];
  try {
    const summary = await callChatCompletion(settings, summaryPrompt);
    project.compacted = { at: Date.now(), summary: String(summary).slice(0, 800), count: old.length };
    project.updatedAt = Date.now();
    await store.saveProject(project);
    return true;
  } catch (e) {
    console.error('[compact]', e && e.message);
    return false;
  }
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
    const r = await doDeploy(store, settings, project, '手动部署');
    project.url = r.url;
    project.deployed = true;
    project.deployedAt = Date.now();
    project.updatedAt = Date.now();
    project.history.push({ role: 'system', content: `✅ 已部署到：${r.url}` });
    pushVersion(project, '手动部署', r.url);
    await store.saveProject(project);
    return json({ project, url: r.url });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 智能冒烟测试：从代码提取路由，逐个探测，找到第一个正常响应。
 * - 部署后先等待 3 秒（Cloudflare 边缘传播），降低「刚部署就 404」的误报；
 * - 对 404/5xx/网络错误最多重试 3 次（间隔 4 秒），排除边缘同步与上游抖动；
 * - 代理类 Worker（透传上游状态码）命中 404 时标记 proxyHint，提示文案区分「上游 404」与「未处理根路径」。
 */
async function smartSmokeTest(url, code) {
  const routes = extractRoutes(code || '');
  const proxyHint = detectProxyWorker(code);
  let last = null;
  await sleep(3000); // 部署后等待边缘传播
  for (const r of routes) {
    const target = r === '/' ? url : `${url}${r}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await executeHttpTest(`GET ${target}`);
      last = { ...res, route: r, proxyHint };
      if (!res.error && res.status < 400) return last; // 找到正常响应即通过
      if (res.error || res.status === 404 || res.status >= 500) {
        await sleep(4000); // 网络错误 / 404 / 5xx：可能传播延迟或上游抖动，等待后重试
      } else {
        break; // 其他状态（如 401/403）不重试，进入下一路由
      }
    }
  }
  return last;
}

/**
 * 获取指定账号的 workers.dev 子域（按 accountId 缓存）。
 * 不同 Cloudflare 账号/空间子域不同，必须按账号隔离，避免切换账号后串用旧账号子域。
 */
async function getSubdomainForAccount(store, settings, token, accountId) {
  const subs = settings.cfSubdomains || {};
  if (subs[accountId]) return subs[accountId];
  const r = await getAccountSubdomain(token, accountId);
  subs[accountId] = r.subdomain;
  settings.cfSubdomains = subs;
  await store.saveSettings(settings);
  return r.subdomain;
}

/** 执行部署：解析凭据（OAuth 优先，自动刷新）→ 按账号缓存子域 → 上传脚本 → 存档版本 → 返回访问地址 */
async function doDeploy(store, settings, project, note) {
  const cred = await getCredentials(store, settings);
  const subdomain = await getSubdomainForAccount(store, settings, cred.token, cred.accountId);
  await deployWorker({
    cfToken: cred.token,
    accountId: cred.accountId,
    scriptName: project.workerName,
    code: project.code,
  });
  const url = `https://${project.workerName}.${subdomain}.workers.dev`;
  return { url };
}
