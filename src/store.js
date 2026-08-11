/**
 * KV 数据访问层
 *
 * 数据模型：
 * - settings           => { openaiBaseUrl, openaiKey, openaiModel, cfToken, cfAccountId, cfSubdomain }
 * - oauth_device       => { clientId, deviceCode, expiresAt, interval }（进行中的设备码登录）
 * - cf_oauth           => { clientId, accessToken, refreshToken, expiresAt, accountId, accountName, email }（在线登录态）
 * - projects           => [{ id, name, workerName, url, deployed, updatedAt }]（项目列表索引）
 * - project:{id}       => 完整项目（含代码与对话历史）
 */

export function makeStore(kv) {
  return {
    async getSettings() {
      const raw = await kv.get('settings', 'json');
      return raw || {};
    },

    async saveSettings(settings) {
      await kv.put('settings', JSON.stringify(settings));
      return settings;
    },

    async listProjects() {
      const raw = await kv.get('projects', 'json');
      return raw || [];
    },

    async saveProjectList(list) {
      await kv.put('projects', JSON.stringify(list));
    },

    async getProject(id) {
      const raw = await kv.get(`project:${id}`, 'json');
      return raw || null;
    },

    /** 保存完整项目，并同步更新项目列表索引（按更新时间倒序） */
    async saveProject(project) {
      await kv.put(`project:${project.id}`, JSON.stringify(project));

      const list = await this.listProjects();
      const meta = {
        id: project.id,
        name: project.name,
        workerName: project.workerName,
        url: project.url || '',
        deployed: !!project.deployed,
        updatedAt: project.updatedAt || Date.now(),
      };
      const idx = list.findIndex((p) => p.id === project.id);
      if (idx >= 0) list[idx] = meta;
      else list.unshift(meta);
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      await this.saveProjectList(list);
    },

    async deleteProject(id) {
      await kv.delete(`project:${id}`);
      const list = await this.listProjects();
      await this.saveProjectList(list.filter((p) => p.id !== id));
    },

    // ============ CNB 异步任务（外部执行器） ============
    // task:{id} => { id, projectId, token, createdAt, autoDeploy, userMessage, workerName,
    //                url, messages, settings, cf, cnbSn, status }（含 expirationTtl 自动清理）

    async getTask(id) {
      const raw = await kv.get(`task:${id}`, 'json');
      return raw || null;
    },

    async saveTask(task, ttl = 14400) {
      await kv.put(`task:${task.id}`, JSON.stringify(task), { expirationTtl: ttl });
    },

    async touchTask(id, ttl = 14400) {
      // 续期：任务进行中防止 KV 过期（进度上报时调用）
      const task = await this.getTask(id);
      if (task) await this.saveTask(task, ttl);
    },

    async deleteTask(id) {
      await kv.delete(`task:${id}`);
    },

    // ============ 对话进行中状态（用于页面切换后恢复提示） ============

  async getChatStatus(id) {
    const raw = await kv.get(`chat_status:${id}`, 'json');
    return raw || null;
  },

  async setChatStatus(id, status) {
    // TTL 10 分钟：runner 心跳每 2 分钟续期；若执行器挂掉，状态自动过期，前端不再无限显示「执行中」
    await kv.put(`chat_status:${id}`, JSON.stringify(status), { expirationTtl: 600 });
  },

  async clearChatStatus(id) {
    await kv.delete(`chat_status:${id}`);
  },

  // ============ 访问密码与登录会话 ============

  async getAccessConfig() {
    const raw = await kv.get('access_config', 'json');
    return raw || null;
  },

  async saveAccessConfig(cfg) {
    await kv.put('access_config', JSON.stringify(cfg));
  },

  async saveAuthSession(token, ttl) {
    await kv.put(`auth_session:${token}`, '1', { expirationTtl: ttl });
  },

  async hasAuthSession(token) {
    return !!(await kv.get(`auth_session:${token}`));
  },

  // ============ OAuth（Cloudflare 在线登录） ============

    /** 进行中的设备码流程 */
    async getOAuthDevice() {
      const raw = await kv.get('oauth_device', 'json');
      return raw || null;
    },

    async saveOAuthDevice(device) {
      await kv.put('oauth_device', JSON.stringify(device));
    },

    async clearOAuthDevice() {
      await kv.delete('oauth_device');
    },

    /** 已登录的 OAuth 凭据（access/refresh token 等） */
    async getOAuth() {
      const raw = await kv.get('cf_oauth', 'json');
      return raw || null;
    },

    async saveOAuth(oauth) {
      await kv.put('cf_oauth', JSON.stringify(oauth));
    },

    async clearOAuth() {
      await kv.delete('cf_oauth');
    },
  };
}
