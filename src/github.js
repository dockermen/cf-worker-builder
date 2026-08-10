/**
 * GitHub Actions 外部执行器接入层
 *
 * 解决 Cloudflare Workers 同步长连接（SSE 流式对话）容易超时/中断的问题：
 * 方案 B —— 对话任务提交到 GitHub Actions（workflow_dispatch，最长 6 小时）后台执行，
 * 执行器脚本（agent-runner/run.js）完成「LLM 生成 → 工具调用 → 部署 → 冒烟测试」，
 * 结果通过回调写回构建器，前端轮询进度。
 *
 * 触发 API：POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches
 * workflow 文件：仓库根目录 .github/workflows/builder-task.yml
 */

/**
 * 触发一次 GitHub Actions workflow_dispatch
 * @param {{repo:string, token:string, ref?:string, taskId:string, taskToken:string, baseUrl:string}} params
 * 成功返回 { ok:true }（GitHub 返回 204 No Content）
 */
export async function triggerGithubWorkflow({ repo, token, ref = 'main', taskId, taskToken, baseUrl }) {
  const workflow = 'builder-task.yml';
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'cf-worker-builder',
    },
    body: JSON.stringify({
      ref,
      inputs: {
        task_id: taskId,
        task_token: taskToken,
        builder_base_url: baseUrl,
      },
    }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const d = await res.json();
      detail = d.message || JSON.stringify(d);
    } catch {
      detail = (await res.text().catch(() => '')).slice(0, 200);
    }
    // 404 通常表示：仓库不存在 / workflow 文件不在该分支 / Token 无 Actions 权限（GitHub 刻意混淆）
    if (res.status === 404) {
      throw new Error(
        `触发 GitHub Actions 失败（404）：${detail}。请检查：① GitHub 仓库路径是否正确且包含 .github/workflows/builder-task.yml（已推送到 ${ref} 分支）；② PAT 是否有 Actions 写权限（workflow 或 repo scope）`
      );
    }
    throw new Error(`触发 GitHub Actions 失败（${res.status}）：${detail}`);
  }
  // 204 No Content = dispatch 已接受
  return { ok: true };
}
