/**
 * CNB 外部执行器（方案 B）
 *
 * 在 cnb.cool 云原生构建（node:20 容器，无 Workers 长连接超时限制）中执行
 * 「LLM 生成 → 工具调用 → 部署 → 冒烟测试」完整 Agent 循环，解决构建器
 * Workers 同步长对话容易超时/中断的问题。
 *
 * 运行方式（由根目录 .cnb.yml 的 api_trigger_builder 事件触发）：
 *   node agent-runner/run.js
 *
 * 环境变量（由构建器通过 CNB StartBuild 的 env 传入）：
 *   TASK_ID            任务 ID
 *   TASK_TOKEN         一次性任务令牌（用于向构建器拉取任务/上报进度/回传结果）
 *   BUILDER_BASE_URL   构建器地址，如 https://worker.logg.click
 *   BUILDER_FALLBACK_IP 可选：构建器域名解析失败/被污染时，用该 IP 直连（SNI 仍为域名）
 *   CLASH_PROXY         可选：Clash/HTTP 代理地址（如 http://127.0.0.1:7890）。
 *                       启用后「构建器交互 + Cloudflare 部署」走代理（解决 CNB 容器访问 Cloudflare 网络问题），
 *                       LLM 调用保持直连（DeepSeek 等国内 API 无需代理）。
 *
 * LLM Key / Cloudflare Token 不会出现在 CNB 环境变量或构建日志中，
 * 而是通过一次性 token 从构建器拉取，任务结束后自动销毁。
 */

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { callChatCompletion } from '../src/agent.js';
import { extractCode } from '../src/util.js';
import { extractAllHttpTests, executeHttpTest, formatToolResult, formatTestResult, extractRoutes, detectProxyWorker } from '../src/tools.js';
import { deployWorker } from '../src/deploy.js';
import { browserFetchText } from './browser.js';

const TASK_ID = process.env.TASK_ID || '';
const TASK_TOKEN = process.env.TASK_TOKEN || '';
const BASE_URL = String(process.env.BUILDER_BASE_URL || '').replace(/\/+$/, '');
const FALLBACK_IP = String(process.env.BUILDER_FALLBACK_IP || '').trim();

const MAX_ROUNDS = 5; // 工具递归轮次上限（与构建器流式路径一致）
const MAX_LLM_MS = 300000; // 单轮 LLM 超时 5 分钟（比 Workers 内 90 秒宽裕很多）

// ============ Clash 代理支持（CNB 场景：解决容器访问 Cloudflare 网络问题） ============
// 构建器交互 + Cloudflare 部署走代理；LLM（国内 API）保持直连。
const CLASH_PROXY = String(process.env.CLASH_PROXY || process.env.HTTP_PROXY || process.env.http_proxy || '').trim();

let proxiedFetch = null; // 走代理的 fetch（未启用代理时 = 全局 fetch）
let proxyAgent = null;
if (CLASH_PROXY) {
  try {
    const { ProxyAgent } = await import('undici');
    proxyAgent = new ProxyAgent(CLASH_PROXY);
    proxiedFetch = (url, opts = {}) => fetch(url, { ...opts, dispatcher: proxyAgent });
    // 代理健康检查：走代理请求构建器。url-test 组首次测速可能需数秒，重试 4 次（间隔 3 秒）再降级
    let proxyOk = false;
    for (let i = 0; i < 4 && !proxyOk; i++) {
      try {
        const probe = await proxiedFetch(`${BASE_URL}/api/auth/check`, { signal: AbortSignal.timeout(12000) });
        if (probe.status < 500) {
          proxyOk = true;
        } else {
          throw new Error(`probe HTTP ${probe.status}`);
        }
      } catch (pe) {
        if (i < 3) await sleep(3000);
      }
    }
    if (proxyOk) {
      log(`已启用 Clash 代理：${CLASH_PROXY}（构建器/Cloudflare 请求走代理，LLM 直连）`);
    } else {
      proxiedFetch = fetch;
      log(`⚠️ Clash 代理健康检查失败（重试 4 次后仍不可用），已降级为直连`);
    }
  } catch (e) {
    proxiedFetch = fetch;
    log(`⚠️ 已设置 CLASH_PROXY 但无法加载 undici（需 npm i undici），代理未生效：${e.message}`);
  }
} else {
  proxiedFetch = fetch;
}

function log(...args) {
  console.log(`[runner ${TASK_ID}]`, ...args);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 提取 fetch 错误的可读原因（DNS/连接/TLS/超时等） */
function describeFetchError(e) {
  const cause = e && e.cause ? e.cause : e;
  const code = cause && cause.code ? cause.code : (e && e.code ? e.code : '');
  const detail = cause && cause.message ? cause.message : (e && e.message ? e.message : String(e));
  return code ? `${code}: ${detail}` : String(detail);
}

/** 使用固定 IP 发起请求（绕过 DNS；SNI/Host 仍是原域名，TLS 证书校验正常） */
function requestWithIp(url, options = {}, ip) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(e);
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      {
        method: options.method || 'GET',
        headers: options.headers || {},
        // 覆盖 DNS 解析：直接使用指定 IP
        lookup: (host, opts, cb) => cb(null, ip, 4),
        timeout: options.timeout || 20000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode,
              headers: res.headers,
            })
          )
        );
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时（20 秒）')));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** 带诊断与重试的 GET（拉取任务） */
async function fetchTask() {
  const url = `${BASE_URL}/api/tasks/${TASK_ID}?token=${TASK_TOKEN}`;
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      // 先打印 DNS 解析结果，便于定位 ENOTFOUND/EAI_AGAIN
      try {
        const host = new URL(url).hostname;
        const addrs = await dns.lookup(host, { all: true });
        log(`DNS 解析 ${host} →`, addrs.map((a) => a.address).join(', '));
      } catch (de) {
        log(`⚠️ DNS 解析失败：${describeFetchError(de)}`);
      }
      const res = await proxiedFetch(url);
      if (!res.ok) {
        throw new Error(`拉取任务失败（HTTP ${res.status}）：${(await res.text().catch(() => '')).slice(0, 300)}`);
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      log(`拉取任务失败（第 ${i + 1}/3 次）：${describeFetchError(e)}`);
      if (FALLBACK_IP && i === 1) {
        // 常规 fetch 连续失败时，尝试用固定 IP 直连（绕过 DNS 污染/解析失败）
        try {
          log(`尝试固定 IP 直连：${FALLBACK_IP}`);
          const res = await requestWithIp(url, {}, FALLBACK_IP);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return await res.json();
        } catch (fe) {
          log(`固定 IP 直连也失败：${describeFetchError(fe)}`);
        }
      }
      await sleep(3000 * (i + 1));
    }
  }
  throw lastErr;
}

/** 带重试的 POST（进度/结果回调，网络抖动时重试） */
async function postWithRetry(path, payload, tries = 3) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const url = `${BASE_URL}${path}`;
      const res = await proxiedFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TASK_TOKEN, ...payload }),
      });
      if (res.ok) return await res.json().catch(() => ({}));
      lastErr = new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
      log(`回传 ${path} 失败（第 ${i + 1}/${tries} 次）：${describeFetchError(e)}`);
      if (FALLBACK_IP && i === Math.floor(tries / 2)) {
        try {
          const url = `${BASE_URL}${path}`;
          const res = await requestWithIp(
            url,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: TASK_TOKEN, ...payload }),
            },
            FALLBACK_IP
          );
          if (res.ok) return await res.json().catch(() => ({}));
        } catch (fe) {
          log(`回传固定 IP 直连也失败：${describeFetchError(fe)}`);
        }
      }
    }
    await sleep(2000 * (i + 1));
  }
  throw lastErr || new Error('POST 失败');
}

async function reportProgress(payload) {
  try {
    await postWithRetry(`/api/tasks/${TASK_ID}/progress`, payload, 2);
  } catch (e) {
    log('进度上报失败（忽略继续）:', e.message);
  }
}

async function reportResult(payload) {
  await postWithRetry(`/api/tasks/${TASK_ID}/result`, payload, 4);
}

/** LLM 调用（带重试，超时放宽到 5 分钟） */
async function callLLM(settings, messages) {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      return await callChatCompletion(settings, messages, MAX_LLM_MS);
    } catch (e) {
      lastErr = e;
      log(`LLM 调用失败（第 ${i + 1} 次）:`, e.message);
      await sleep(3000 * (i + 1));
    }
  }
  throw lastErr;
}

/**
 * LLM 长任务心跳：生成期间每 2 分钟上报一次进度（同时续期任务 KV 与 chat-status），
 * 防止构建器侧状态 KV 过期导致前端误判「任务已完成」。
 */
async function callLLMWithBeat(settings, messages) {
  const beat = setInterval(() => {
    reportProgress({ stage: 'thinking', note: '模型生成中（长任务心跳，请稍候）…' }).catch(() => {});
  }, 120000);
  beat.unref?.();
  try {
    return await callLLM(settings, messages);
  } finally {
    clearInterval(beat);
  }
}

/**
 * 智能冒烟测试：探测代码中的路由，找到第一个正常响应（与构建器逻辑一致）。
 * - 部署后等待 3 秒（Cloudflare 边缘传播），404/5xx/网络错误最多重试 3 次；
 * - 代理类 Worker 命中 404 时标记 proxyHint，文案区分「上游 404」与「未处理根路径」。
 */
async function smartSmokeTest(url, code) {
  const routes = extractRoutes(code || '');
  const proxyHint = detectProxyWorker(code);
  let last = null;
  await sleep(3000);
  for (const r of routes) {
    const target = r === '/' ? url : `${url}${r}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await executeHttpTest(`GET ${target}`, proxiedFetch);
      last = { ...res, route: r, proxyHint };
      if (!res.error && res.status < 400) return last;
      if (res.error || res.status === 404 || res.status >= 500) {
        await sleep(4000);
      } else {
        break;
      }
    }
  }
  return last;
}

async function main() {
  if (!TASK_ID || !TASK_TOKEN || !BASE_URL) {
    throw new Error('缺少环境变量：TASK_ID / TASK_TOKEN / BUILDER_BASE_URL');
  }
  log(`构建器地址：${BASE_URL}${FALLBACK_IP ? `（备用 IP：${FALLBACK_IP}）` : ''}`);

  // 1. 拉取任务（一次性 token，带 DNS 诊断与重试）
  log('拉取任务…');
  const task = await fetchTask();
  log('任务已获取：worker =', task.workerName, '，autoDeploy =', task.autoDeploy);

  await reportProgress({ stage: 'thinking', round: 1, note: '已连接构建器，开始第 1 轮生成…' });

  // 2. Agent 递归循环（LLM → 工具 → 继续，直到无工具调用或到达轮次上限）
  const messages = Array.isArray(task.messages) ? task.messages : [];
  const allRoundTexts = [];
  const toolResults = [];
  let code = null;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    await reportProgress({ stage: 'thinking', round: round + 1, note: `第 ${round + 1} 轮生成中…` });
    const reply = await callLLMWithBeat(task.settings, messages);
    messages.push({ role: 'assistant', content: reply });
    allRoundTexts.push(reply);
    log(`第 ${round + 1} 轮完成，输出 ${reply.length} 字`);

    const specs = extractAllHttpTests(reply);
    if (!specs.length) break;

    for (const spec of specs) {
      await reportProgress({
        stage: 'tool',
        round: round + 1,
        note: `正在执行工具：${String(spec).split('\n')[0] || 'HTTP 请求'}`,
      });
      let r = await executeHttpTest(spec, proxiedFetch);
      // 代理节点抖动导致的网络错误：自动重试一次（url-test 已切换到其他节点后大概率恢复）
      if (r && r.error) {
        await sleep(1500);
        const r2 = await executeHttpTest(spec, proxiedFetch);
        if (r2 && !r2.error) {
          log('工具请求首次失败，重试成功:', r2.status || '', r2.url || '');
          r = r2;
        } else {
          r = r2 || r;
        }
      }
      // Cloudflare 人机验证挑战页：普通请求被拦，自动用 Playwright 无头浏览器重抓真实内容
      if (r && !r.error && r.challenge && r.url) {
        await reportProgress({ stage: 'tool', round: round + 1, note: `目标站有人机验证，正在用浏览器（Playwright）抓取：${r.url}` });
        log('检测到 Cloudflare 挑战，尝试浏览器抓取:', r.url);
        try {
          const b = await browserFetchText(r.url, { waitMs: 40000, maxWaitChallengeMs: 15000 });
          if (b && !b.error && !b.challenge) {
            r = { ...r, ...b, viaBrowser: true };
            log('浏览器抓取成功:', b.status, b.url);
          } else {
            log('浏览器抓取仍被挑战拦截（保留原结果）:', b && b.status);
          }
        } catch (e) {
          log('浏览器抓取失败（保留原结果）:', e && e.message);
        }
      }
      toolResults.push(r);
      messages.push({ role: 'system', content: formatToolResult(r, toolResults.length) });
      log('工具结果:', r.status || r.error, r.url || '');
    }

    if (round >= MAX_ROUNDS - 1) {
      await reportProgress({ stage: 'tool', round: round + 1, note: `已达到工具自动调用轮次上限（${MAX_ROUNDS}）` });
      break;
    }
  }

  // 3. 提取代码
  const fullReply = allRoundTexts.join('\n');
  code = extractCode(fullReply);
  if (code) log('已提取 Worker 代码（', code.length, '字符）');
  else log('本轮未提取到 Worker 代码');

  // 4. 部署 + 冒烟测试
  let deployed = false;
  let url = task.url || '';
  let deployError = null;
  let smokeTest = null;

  if (code && task.autoDeploy !== false) {
    await reportProgress({ stage: 'deploying', note: '正在部署到 Cloudflare Workers…' });
    try {
      await deployWorker({
        cfToken: task.cf.token,
        accountId: task.cf.accountId,
        scriptName: task.workerName,
        code,
        // 本地/联调可用 CF_API_BASE 指向 mock 服务；生产默认 Cloudflare 官方 API
        apiBase: process.env.CF_API_BASE || undefined,
        // Clash 代理启用时，Cloudflare 部署请求也走代理
        fetchImpl: proxiedFetch,
      });
      deployed = true;
      url = `https://${task.workerName}.${task.cf.subdomain}.workers.dev`;
      log('部署成功:', url);
      try {
        smokeTest = await smartSmokeTest(url, code);
      } catch (e) {
        log('冒烟测试异常（忽略）:', e.message);
      }
    } catch (e) {
      deployError = e.message;
      log('部署失败:', e.message);
    }
  }

  // 5. 回传结果（构建器负责：写回历史/记忆/版本并清理状态）
  await reportResult({
    reply: fullReply,
    code: code || null,
    deployed,
    url,
    deployError: deployError || null,
    toolResults,
    smokeTest: smokeTest || null,
  });
  log('结果已回传，任务完成');
}

main()
  .catch(async (e) => {
    console.error('[runner] 任务失败:', e && e.message ? e.message : e);
    try {
      await reportResult({ error: String((e && e.message) || e).slice(0, 500) });
    } catch (e2) {
      console.error('[runner] 结果回传失败:', describeFetchError(e2));
      process.exit(1);
    }
  })
  .finally(() => {
    // 强制退出：确保 fetch 等未决句柄不阻塞容器结束
    setTimeout(() => process.exit(0), 3000);
  });
