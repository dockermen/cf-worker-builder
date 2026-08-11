/**
 * CNB（cnb.cool 云原生构建）外部执行器接入层
 *
 * 解决 Cloudflare Workers 同步长连接（SSE 流式对话）容易超时/中断的问题：
 * 方案 B —— 对话任务提交到 CNB 流水线（Node 20 容器，无时长限制）后台执行，
 * 执行器脚本（agent-runner/run.js）完成「LLM 生成 → 工具调用 → 部署 → 冒烟测试」，
 * 结果通过回调写回构建器，前端轮询进度。
 *
 * 触发 API：POST https://api.cnb.cool/{repo}/-/build/start
 * 状态 API：GET  https://api.cnb.cool/{repo}/-/build/status/{sn}
 */

/** 触发一次 CNB 流水线（事件名需与仓库根目录 .cnb.yml 中 api_trigger_ 开头的事件一致） */
export async function triggerCnbBuild({ repo, token, branch = 'main', taskId, taskToken, baseUrl, fallbackIp = '', proxySub = '' }) {
  const res = await fetch(`https://api.cnb.cool/${repo}/-/build/start`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.cnb.api+json',
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      event: 'api_trigger_builder',
      branch,
      title: `builder-task-${String(taskId || '').slice(0, 8)}`,
      env: {
        TASK_ID: taskId,
        TASK_TOKEN: taskToken,
        BUILDER_BASE_URL: baseUrl,
        // 可选：CNB 容器访问构建器域名失败（DNS/网络污染）时用固定 IP 直连
        BUILDER_FALLBACK_IP: fallbackIp,
        // 可选：Clash 代理订阅地址（CNB 容器内启动 mihomo，解决访问 Cloudflare/workers.dev 网络问题）
        CNB_PROXY_SUB: proxySub,
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `触发 CNB 构建失败（${res.status}）：${JSON.stringify(data).slice(0, 300)}（请检查设置中的 CNB 仓库路径与 Token 权限）`
    );
  }
  // 关键校验：HTTP 200 只代表请求被接受，success=false 或缺少 sn 说明流水线并未真正创建。
  // 最常见原因：仓库「设置 → 云原生构建」未勾选「允许自动触发」。
  if (data.success === false || !data.sn) {
    throw new Error(
      `CNB 未创建构建：${data.message || '仓库可能未开启云原生构建自动触发'}` +
        '（请到 cnb.cool 仓库 → 设置 → 云原生构建 → 勾选「允许自动触发」，并确认 Token 有流水线触发权限；构建日志：https://cnb.cool/' +
        `${repo}/-/build/logs）`
    );
  }
  return {
    sn: data.sn,
    buildLogUrl: data.buildLogUrl || `https://cnb.cool/${repo}/-/build/logs`,
    message: data.message || '',
  };
}

/** 查询 CNB 构建状态（sn 为构建号），用于诊断与日志链接 */
export async function queryCnbBuildStatus(repo, token, sn) {
  if (!sn) return null;
  const res = await fetch(`https://api.cnb.cool/${repo}/-/build/status/${sn}`, {
    headers: {
      Accept: 'application/vnd.cnb.api+json',
      Authorization: token,
    },
  });
  const data = await res.json().catch(() => ({}));
  return res.ok ? data : { error: `查询 CNB 构建状态失败（${res.status}）` };
}
