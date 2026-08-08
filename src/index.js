/**
 * Worker 在线构建器 - 主入口
 *
 * 功能：
 * 1. 配置 OpenAI 兼容大模型（Base URL / Key / 模型），接入 DeepSeek 等 Agent
 * 2. 以项目为单位对话式生成 Worker 代码，自动部署到 Cloudflare Workers 并返回地址
 * 3. 内置 Cloudflare 登录态：支持「设备码在线登录」（类似 wrangler login）与手动 API Token，
 *    Token 持久化在 KV 且自动刷新，无需每次登录
 */

import { json, slugify, extractCode, maskKey, DEFAULT_CODE, pushVersion } from './util.js';
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
} from './oauth.js';
import { login, checkAuth, changePassword } from './auth.js';
import { extractHttpTest, executeHttpTest, formatTestResult } from './tools.js';
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
      versions: [],
      nextVersion: 1,
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
      versions: [],
      nextVersion: 1,
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

  // ============ 项目版本控制 ============
  const versionsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/versions$/);
  if (versionsMatch && method === 'GET') {
    const project = await store.getProject(versionsMatch[1]);
    if (!project) return json({ error: '项目不存在' }, 404);
    const versions = (project.versions || []).slice().reverse(); // 新版在前
    return json({ versions, nextVersion: project.nextVersion || 1 });
  }

  const versionMatch = pathname.match(/^\/api\/projects\/([^/]+)\/versions\/(\d+)(?:\/restore)?$/);
  if (versionMatch && (method === 'GET' || method === 'POST')) {
    const project = await store.getProject(versionMatch[1]);
    if (!project) return json({ error: '项目不存在' }, 404);
    const v = Number(versionMatch[2]);
    const ver = (project.versions || []).find((x) => x.v === v);
    if (!ver) return json({ error: '版本不存在' }, 404);
    if (method === 'GET') return json({ version: ver });

    // POST：恢复版本（可选立即部署）
    const body = await readBody();
    project.code = ver.code;
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
      } catch (e) {
        project.history.push({ role: 'system', content: `⚠️ 恢复后重新部署失败：${e.message}` });
      }
    }
    await store.saveProject(project);
    return json({ project, deployed, url });
  }

  // ============ 对话进行中状态查询 ============
  const statusMatch = pathname.match(/^\/api\/projects\/([^/]+)\/chat-status$/);
  if (statusMatch && method === 'GET') {
    const status = await store.getChatStatus(statusMatch[1]);
    return json({ status });
  }

  // ============ 项目子操作：chat / chat/stream / deploy / code / clear ============
  const actionMatch = pathname.match(/^\/api\/projects\/([^/]+)\/(chat(?:\/stream)?|deploy|code|clear)$/);
  if (actionMatch) {
    const id = actionMatch[1];
    const action = actionMatch[2];

    if (action === 'chat' && method === 'POST') {
      return await chatAction(request, store, id);
    }
    if (action === 'chat/stream' && method === 'POST') {
      return await streamChatAction(request, store, id);
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

  // 追加用户消息（立即持久化：即使后续失败，切换页面后记录也不会丢失）
  const lastMsg = project.history[project.history.length - 1];
  if (lastMsg && lastMsg.role === 'user' && lastMsg.content === message) {
    project.history.pop(); // 上次失败重试去重
  }
  project.history.push({ role: 'user', content: message });
  await store.saveProject(project);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...project.history.slice(-40),
  ];

  let reply;
  try {
    reply = await callChatCompletion(settings, messages);
  } catch (e) {
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
        const r = await doDeploy(store, settings, project, '对话生成并部署');
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
      smokeTest = await executeHttpTest(`GET ${url}`);
      project.history.push({ role: 'system', content: formatTestResult(smokeTest, '冒烟测试：') });
    } catch (_) { /* ignore */ }
  }

  await store.saveProject(project);
  return json({ project, reply, code, deployed, url, deployError, testResult, smokeTest });
}

/**
 * 流式对话：SSE 逐字输出，结束时提取代码并自动部署
 * 事件：delta（增量文本）/ done（{reply, code, deployed, url, deployError, project}）/ error（{error}）
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

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...project.history.slice(-40),
  ];

  let llm;
  try {
    llm = await streamChatCompletion(settings, messages);
  } catch (e) {
    project.history.push({ role: 'system', content: `⚠️ 对话调用失败：${e.message}` });
    await store.saveProject(project);
    await store.clearChatStatus(id);
    return json({ error: e.message }, 502);
  }

  const { response: llmRes, isResponses } = llm;
  const reader = llmRes.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let fullText = '';

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
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
                // OpenAI Responses 流式增量事件类型为 response.output_text.delta（兼容简写）
                if (evt.type === 'response.output_text.delta' || evt.type === 'output_text.delta') {
                  delta = evt.delta || '';
                }
              } else if (evt.choices && evt.choices[0] && evt.choices[0].delta) {
                delta = evt.choices[0].delta.content || '';
              }
              if (delta) {
                fullText += delta;
                send('delta', { text: delta });
              }
            }
          }
        }

        // 流结束：保存回复 → 提取代码 → 自动部署 → 执行测试工具与冒烟测试
        const cur = await store.getProject(id);
        cur.history.push({ role: 'assistant', content: fullText });
        cur.updatedAt = Date.now();
        let deployed = false;
        let url = cur.url || '';
        let deployError = null;
        const code = extractCode(fullText);
        if (code) {
          cur.code = code;
          if (body.autoDeploy !== false) {
            try {
              const r = await doDeploy(store, settings, cur, '对话生成并部署');
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

        // Agent 工具：test-http（等效 curl，由模型按需发起）
        let testResult = null;
        const testSpec = extractHttpTest(fullText);
        if (testSpec) {
          testResult = await executeHttpTest(testSpec);
          cur.history.push({ role: 'system', content: formatTestResult(testResult, 'HTTP ') });
        }

        // 自动冒烟测试：部署成功后自动请求一次首页
        let smokeTest = null;
        if (deployed) {
          try {
            smokeTest = await executeHttpTest(`GET ${url}`);
            cur.history.push({
              role: 'system',
              content: formatTestResult(smokeTest, '冒烟测试：'),
            });
          } catch (_) { /* ignore */ }
        }

        await store.saveProject(cur);
        await store.clearChatStatus(id);
        send('done', { reply: fullText, code, deployed, url, deployError, testResult, smokeTest, project: cur });
        controller.close();
      } catch (e) {
        // 中断：保留已生成内容（若有）并记录错误
        try {
          const cur = await store.getProject(id);
          if (fullText.trim()) {
            cur.history.push({ role: 'assistant', content: fullText });
          }
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
    await store.saveProject(project);
    return json({ project, url: r.url });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}

/** 执行部署：解析凭据（OAuth 优先，自动刷新）→ 缓存子域 → 上传脚本 → 存档版本 → 返回访问地址 */
async function doDeploy(store, settings, project, note) {
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
  pushVersion(project, note || '部署', url);
  return { url };
}
