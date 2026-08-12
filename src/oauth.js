/**
 * Cloudflare 在线登录（OAuth 2.0 设备码流程）
 *
 * 与 `wrangler login --device` 等价：
 * 1. 后端向 dash.cloudflare.com/oauth2/device/auth 请求设备码（无需 client secret）
 * 2. 用户在新标签页打开验证地址、输入设备码并授权
 * 3. 后端轮询 token 端点换取 access_token + refresh_token
 * 4. access_token 过期后自动用 refresh_token 刷新 —— 登录态持久内置，无需每次登录
 *
 * 默认复用 Cloudflare 官方（wrangler）公开的 OAuth 客户端 ID，用户零配置即可登录；
 * 若官方客户端被限制，可通过 wrangler.toml 的 [vars] OAUTH_CLIENT_ID 换成自建客户端。
 */

import { makeStore } from './store.js';

export const DEFAULT_CLIENT_ID = '54d11594-84e4-41aa-b438-e81b8fa78ee7';
const AUTH_DOMAIN = 'https://dash.cloudflare.com';
const DEVICE_AUTH_URL = `${AUTH_DOMAIN}/oauth2/device/auth`;
const TOKEN_URL = `${AUTH_DOMAIN}/oauth2/token`;
const API_BASE = 'https://api.cloudflare.com/client/v4';

/** 部署 Worker 所需的最小权限集（对应 Cloudflare API Token 权限名） */
const OAUTH_SCOPES = [
  'account:read',
  'user:read',
  'workers:write',
  'workers_kv:write',
  'workers_routes:write',
  'workers_scripts:write',
  'offline_access', // 请求 refresh_token
].join(' ');

export function getClientId(env) {
  return (env && env.OAUTH_CLIENT_ID) || DEFAULT_CLIENT_ID;
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

/** 发起设备码授权，返回需要展示给用户的信息 */
export async function startDeviceFlow(store, clientId) {
  const { res, data } = await postForm(DEVICE_AUTH_URL, {
    client_id: clientId,
    scope: OAUTH_SCOPES,
  });
  if (!res.ok || !data.device_code) {
    throw new Error(
      `发起设备授权失败（${res.status}）：${JSON.stringify(data).slice(0, 300)}`
    );
  }
  await store.saveOAuthDevice({
    clientId,
    deviceCode: data.device_code,
    expiresAt: Date.now() + (data.expires_in || 300) * 1000,
    interval: data.interval || 5,
  });
  return {
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    verification_uri_complete:
      data.verification_uri_complete ||
      `${data.verification_uri}?user_code=${encodeURIComponent(data.user_code)}`,
    expires_in: data.expires_in,
    interval: data.interval || 5,
  };
}

/** 轮询授权状态；用户授权完成后自动换取并保存令牌 */
export async function pollDeviceFlow(store) {
  const dev = await store.getOAuthDevice();
  if (!dev) return { status: 'error', error: '没有进行中的登录流程，请重新发起' };

  if (Date.now() > dev.expiresAt) {
    await store.clearOAuthDevice();
    return { status: 'error', error: '设备码已过期，请重新发起登录' };
  }

  const { res, data } = await postForm(TOKEN_URL, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: dev.deviceCode,
    client_id: dev.clientId,
  });

  if (res.ok && data.access_token) {
    await store.clearOAuthDevice();
    const oauth = {
      clientId: dev.clientId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || '',
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      accountId: '',
      accountName: '',
      email: '',
      loggedInAt: Date.now(),
    };
    // 获取账号与用户信息（失败不阻塞，token 本身已有效）
    try {
      const info = await fetchAccountInfo(oauth.accessToken);
      oauth.accountId = info.accountId;
      oauth.accountName = info.accountName;
      oauth.email = info.email;
    } catch (_) {
      /* ignore */
    }
    await store.saveOAuth(oauth);
    return { status: 'success', oauth: publicOAuth(oauth) };
  }

  const error = data.error || '';
  if (error === 'authorization_pending' || error === 'slow_down') {
    return { status: 'pending', wait: error === 'slow_down' ? dev.interval + 5 : dev.interval };
  }
  if (error) {
    await store.clearOAuthDevice();
    return { status: 'error', error: data.error_description || error };
  }
  await store.clearOAuthDevice();
  return { status: 'error', error: `授权响应异常（${res.status}）` };
}

/** 用 refresh_token 刷新 access_token（登录态持久化的关键） */
export async function refreshOAuthToken(store) {
  const oauth = await store.getOAuth();
  if (!oauth || !oauth.refreshToken) {
    throw new Error('没有可用的刷新令牌，请重新登录');
  }
  const { res, data } = await postForm(TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: oauth.refreshToken,
    client_id: oauth.clientId,
  });
  if (!res.ok || !data.access_token) {
    await store.clearOAuth();
    throw new Error(
      `刷新令牌失败（${res.status}）：${JSON.stringify(data).slice(0, 200)}，请重新登录`
    );
  }
  oauth.accessToken = data.access_token;
  if (data.refresh_token) oauth.refreshToken = data.refresh_token;
  oauth.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  await store.saveOAuth(oauth);
  return oauth;
}

/**
 * 退出登录：撤销令牌并移除指定账号（默认当前激活账号）。
 * 多账号下只移除目标账号，其余账号登录态保留；移除当前账号后自动切换到剩余第一个。
 */
export async function logoutOAuth(store, accountId = '') {
  const accounts = await store.getOAuthAccounts();
  const targetId = accountId || (await store.getActiveOAuthId());
  const oauth = accounts[targetId];
  if (oauth && oauth.accessToken) {
    try {
      await fetch(`${AUTH_DOMAIN}/oauth2/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: oauth.accessToken,
          client_id: oauth.clientId,
        }).toString(),
      });
    } catch (_) {
      /* ignore */
    }
  }
  await store.removeOAuthAccount(targetId);
}

/**
 * 按指定账号刷新令牌（用于项目归属账号的 token 过期时刷新；不切换当前激活账号）
 */
export async function refreshOAuthAccount(store, accountId) {
  const accounts = await store.getOAuthAccounts();
  const oauth = accounts[accountId];
  if (!oauth || !oauth.refreshToken) {
    throw new Error('该账号没有可用的刷新令牌，请重新登录该账号');
  }
  const { res, data } = await postForm(TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: oauth.refreshToken,
    client_id: oauth.clientId,
  });
  if (!res.ok || !data.access_token) {
    throw new Error(
      `刷新令牌失败（${res.status}）：${JSON.stringify(data).slice(0, 200)}，请重新登录该账号`
    );
  }
  oauth.accessToken = data.access_token;
  if (data.refresh_token) oauth.refreshToken = data.refresh_token;
  oauth.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  await store.updateOAuthAccount(accountId, oauth);
  return oauth;
}

/** 切换当前激活账号（多账号登录态各自保留） */
export async function switchOAuth(store, accountId) {
  const ok = await store.switchOAuthAccount(accountId);
  if (!ok) throw new Error('账号不存在或已失效');
  const oauth = await store.getOAuth();
  return oauth;
}

/**
 * 获取当前可用的部署凭据：
 * 优先 OAuth（过期自动刷新），否则回退到手动配置的 API Token
 * @returns {{token:string, accountId:string, source:'oauth'|'token'}}
 */
export async function getCredentials(store, settings) {
  const oauth = await store.getOAuth();
  if (oauth && oauth.accessToken) {
    let token = oauth.accessToken;
    if (Date.now() > oauth.expiresAt - 60_000) {
      const refreshed = await refreshOAuthToken(store);
      token = refreshed.accessToken;
    }
    if (!oauth.accountId) {
      throw new Error('OAuth 登录成功但未能获取 Account ID，请重新登录或手动填写 API Token');
    }
    return { token, accountId: oauth.accountId, source: 'oauth' };
  }
  if (settings.cfToken && settings.cfAccountId) {
    return { token: settings.cfToken, accountId: settings.cfAccountId, source: 'token' };
  }
  throw new Error('未配置 Cloudflare 凭据：请先「在线登录」或填写 API Token + Account ID');
}

/** 脱敏后的 OAuth 状态（供前端展示） */
export function publicOAuth(oauth) {
  if (!oauth || !oauth.accessToken) return { loggedIn: false };
  return {
    loggedIn: true,
    email: oauth.email || '',
    accountName: oauth.accountName || '',
    accountId: oauth.accountId ? `${oauth.accountId.slice(0, 6)}****` : '',
    expiresAt: oauth.expiresAt || 0,
  };
}

/** 获取账号信息（email + 第一个账号 id/名称） */
async function fetchAccountInfo(accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  let email = '';
  let accountId = '';
  let accountName = '';

  try {
    const u = await fetch(`${API_BASE}/user`, { headers });
    const ud = await u.json();
    if (u.ok && ud.result && ud.result.email) email = ud.result.email;
  } catch (_) {
    /* ignore */
  }
  try {
    const a = await fetch(`${API_BASE}/accounts`, { headers });
    const ad = await a.json();
    if (a.ok && ad.result && ad.result.length) {
      accountId = ad.result[0].id;
      accountName = ad.result[0].name;
    }
  } catch (_) {
    /* ignore */
  }
  return { email, accountId, accountName };
}
