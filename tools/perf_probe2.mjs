/* 精确测量：HTML 已缓存的前提下，JS 解析+执行各阶段耗时 */
import { chromium } from 'playwright-core';

const URL = 'https://yuzikaaang.github.io/class-site/';
const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});

for (const rate of [1, 2, 4]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  if (rate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate });

  // 第一次：让 SW 装上并缓存 HTML
  await page.goto(URL, { waitUntil: 'load', timeout: 180000 });
  await page.waitForTimeout(3000);

  // 第二次：从 SW 缓存加载，测 JS 执行
  const t0 = Date.now();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 180000 });
  const dcl = Date.now() - t0;
  await page.waitForTimeout(3000);
  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const paints = performance.getEntriesByType('paint');
    const fcp = paints.find((p) => p.name === 'first-contentful-paint');
    const lcp = paints.find((p) => p.name === 'largest-contentful-paint');
    return {
      transferSize: nav.transferSize,
      dcl: Math.round(nav.domContentLoadedEventEnd),
      fcp: fcp ? Math.round(fcp.startTime) : null,
      lcp: lcp ? Math.round(lcp.startTime) : null,
      domNodes: document.querySelectorAll('*').length,
    };
  });
  console.log(`CPU x${rate}: dcl=${m.dcl}ms fcp=${m.fcp}ms lcp=${m.lcp}ms transfer=${m.transferSize} nodes=${m.domNodes}`);
  await ctx.close();
}
await browser.close();
