/**
 * Playwright 浏览器工具（仅 GitHub Actions runner 环境可用）
 *
 * 当 test-http 普通请求被目标站 Cloudflare 人机验证（"Just a moment..." 挑战页）拦截时，
 * 用真实无头浏览器（Chromium）访问页面：执行挑战页 JS，等待跳转，抓取真实内容。
 * 这是「构建器可以用 curl 或 Playwright 等工具吗」的落地实现 —— 浏览器级抓取。
 */

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * 用无头浏览器抓取页面文本
 * @param {string} url 目标 URL
 * @param {{waitMs?:number, maxWaitChallengeMs?:number}} options
 * @returns {Promise<{status:number, url:string, method:string, body:string, challenge?:boolean}>}
 */
export async function browserFetchText(url, options = {}) {
  const waitMs = options.waitMs || 30000;
  const maxWaitChallengeMs = options.maxWaitChallengeMs || 12000;
  const { chromium } = await import('playwright');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
  });
  try {
    const context = await browser.newContext({
      userAgent: BROWSER_UA,
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
    });
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: waitMs });
    let status = response ? response.status() : 200;

    // 等待 Cloudflare 挑战自动通过（JS 执行 + 自动重定向）
    const waitedAt = Date.now();
    while (Date.now() - waitedAt < maxWaitChallengeMs) {
      const title = await page.title().catch(() => '');
      const content = await page.content().catch(() => '');
      if (!/just a moment/i.test(title) && !/challenges\.cloudflare\.com/i.test(content)) {
        break;
      }
      await page.waitForTimeout(1000);
    }

    const body = await page.content().catch(() => '');
    const finalUrl = page.url();
    const isStillChallenge = /just a moment/i.test(body) || /challenges\.cloudflare\.com/i.test(body);
    return {
      status: isStillChallenge ? (status === 200 ? 403 : status) : status,
      url: finalUrl || url,
      method: 'GET(browser)',
      body: body.slice(0, 3000),
      challenge: isStillChallenge,
    };
  } finally {
    await browser.close();
  }
}
