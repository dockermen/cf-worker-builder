/**
 * 访问密码认证
 *
 * - 密码以 SHA-256(salt + password) 形式存入 KV，默认密码 123456
 * - 登录成功后签发随机 token，存入 KV（TTL 7 天），前端持 token 访问受保护 API
 * - 支持后台修改密码（需旧密码）
 */

const DEFAULT_PASSWORD = '123456';
const SESSION_TTL = 7 * 24 * 3600; // 7 天

/** SHA-256 十六进制摘要 */
async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 读取访问配置；首次使用时以默认密码初始化 */
async function getAccessConfig(store) {
  let cfg = await store.getAccessConfig();
  if (!cfg || !cfg.passwordHash) {
    const salt = crypto.randomUUID();
    cfg = { passwordHash: await sha256(DEFAULT_PASSWORD + ':' + salt), salt };
    await store.saveAccessConfig(cfg);
  }
  return cfg;
}

/** 密码登录，成功返回 7 天有效的 token */
export async function login(store, password) {
  const cfg = await getAccessConfig(store);
  const hash = await sha256(String(password || '') + ':' + cfg.salt);
  if (hash !== cfg.passwordHash) {
    return { ok: false, error: '密码错误' };
  }
  const token = crypto.randomUUID();
  await store.saveAuthSession(token, SESSION_TTL);
  return { ok: true, token };
}

/** 校验请求 token 是否有效 */
export async function checkAuth(store, token) {
  if (!token) return false;
  return await store.hasAuthSession(token);
}

/** 修改访问密码（需旧密码） */
export async function changePassword(store, oldPassword, newPassword) {
  const cfg = await getAccessConfig(store);
  const oldHash = await sha256(String(oldPassword || '') + ':' + cfg.salt);
  if (oldHash !== cfg.passwordHash) {
    return { ok: false, error: '旧密码错误' };
  }
  const np = String(newPassword || '');
  if (np.length < 4) {
    return { ok: false, error: '新密码至少 4 位' };
  }
  const salt = crypto.randomUUID();
  cfg.passwordHash = await sha256(np + ':' + salt);
  cfg.salt = salt;
  await store.saveAccessConfig(cfg);
  return { ok: true };
}
