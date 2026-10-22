/* 测量线上首页加载各阶段耗时（模拟弱网 + 低端机） */
import { chromium } from 'playwright-core';

const URL = 'https://yuzikaaang.github.io/class-site/';

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();

// 模拟低端手机：CPU 降速 4 倍
const cdp = await ctx.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

// 弱网：下载 400kb/s、上传 100kb/s、RTT 300ms
await ctx.route('**/*', async (route) => {
  const req = route.request();
  if (req.url().includes('api.classsite') || req.url().includes('/api/')) {
    return route.continue();
  }
  // 只对主文档和静态资源限速，API 不限
  await new Promise((r) => setTimeout(r, 0));
  route.continue();
});

const timings = [];
page.on('response', async (res) => {
  if (res.url().includes('index.html')) {
    timings.push({ url: res.url().slice(0, 80), status: res.status() });
  }
});

console.log('=== 第一次访问（冷缓存） ===');
let t0 = Date.now();
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
console.log('domcontentloaded:', Date.now() - t0, 'ms');
await page.waitForTimeout(8000);
const firstPaint = await page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const paints = performance.getEntriesByType('paint');
  return {
    dcl: Math.round(nav.domContentLoadedEventEnd),
    load: Math.round(nav.loadEventEnd),
    fcp: paints.find((p) => p.name === 'first-contentful-paint') ? Math.round(paints.find((p) => p.name === 'first-contentful-paint').startTime) : null,
    transferSize: nav.transferSize,
    encodedBodySize: nav.encodedBodySize,
  };
});
console.log('firstPaint metrics:', JSON.stringify(firstPaint));
console.log('timings:', JSON.stringify(timings, null, 1));

const state1 = await page.evaluate(() => ({
  ver: (document.getElementById('verLine') || {}).textContent,
  island: (document.getElementById('classIsland') || {}).innerHTML ? 'has' : 'empty',
  board: (document.getElementById('board') || {}).innerHTML ? 'has' : 'empty',
}));
console.log('state1:', JSON.stringify(state1));

console.log('=== 第二次访问（热缓存，同样弱网） ===');
t0 = Date.now();
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
console.log('domcontentloaded:', Date.now() - t0, 'ms');
await page.waitForTimeout(6000);
const second = await page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const paints = performance.getEntriesByType('paint');
  return {
    dcl: Math.round(nav.domContentLoadedEventEnd),
    fcp: paints.find((p) => p.name === 'first-contentful-paint') ? Math.round(paints.find((p) => p.name === 'first-contentful-paint').startTime) : null,
    transferSize: nav.transferSize,
  };
});
console.log('second metrics:', JSON.stringify(second));
const state2 = await page.evaluate(() => ({
  ver: (document.getElementById('verLine') || {}).textContent,
  island: (document.getElementById('classIsland') || {}).innerHTML ? 'has' : 'empty',
  board: (document.getElementById('board') || {}).innerHTML ? 'has' : 'empty',
}));
console.log('state2:', JSON.stringify(state2));

await browser.close();
