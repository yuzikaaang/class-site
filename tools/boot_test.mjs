/* 验证 v3.9.4：接口慢（8s）时，首屏内容是否立即渲染（不等接口） */
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();

// 拦截 API：boards 延迟 8 秒，其余放行（本地没有后端，全部模拟）
await page.route('**/api/**', async (route) => {
  const url = route.request().url();
  if (url.includes('/api/boards?action=meta')) {
    await new Promise((r) => setTimeout(r, 8000));   // 模拟慢接口
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"meta":{}}' });
  }
  if (url.includes('/api/content')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"items":{},"serverTime":"2026-10-21T00:00:00Z"}' });
  }
  if (url.includes('/api/island')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"data":{"on":true,"banner":{"wed":"语 语数物英英 音生化班 听自英英自"},"days":{},"holidays":[]}}' });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
});

const t0 = Date.now();
await page.goto('http://localhost:8111/index.html', { waitUntil: 'domcontentloaded' });
const dcl = Date.now() - t0;

// 立刻检查（接口还没回来）：首页区块有没有内容
const early = await page.evaluate(() => ({
  board: (document.getElementById('board') || {}).innerHTML ? 'has' : 'EMPTY',
  daily: (document.getElementById('dailyNews') || {}).innerHTML ? 'has' : 'EMPTY',
  quote: (document.getElementById('dailyQuoteBar') || {}).innerHTML ? 'has' : 'EMPTY',
  countdown: (document.getElementById('countdown') || {}).innerHTML ? 'has' : 'EMPTY',
  gridCards: document.querySelectorAll('#grid .card, #grid .cat').length,
  ver: (document.getElementById('verLine') || {}).textContent,
}));
console.log('dcl:', dcl, 'ms');
console.log('接口未返回时的首屏:', JSON.stringify(early));

// 等 9 秒（接口回来了）再看一次
await page.waitForTimeout(9000);
const late = await page.evaluate(() => ({
  board: (document.getElementById('board') || {}).innerHTML ? 'has' : 'EMPTY',
  gridCards: document.querySelectorAll('#grid .card, #grid .cat').length,
}));
console.log('接口返回后:', JSON.stringify(late));
await browser.close();
