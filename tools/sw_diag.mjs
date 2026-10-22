/* 诊断 SW 是否真正接管导航 */
import { chromium } from 'playwright-core';

const URL = 'https://yuzikaaang.github.io/class-site/';
const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();

await page.goto(URL, { waitUntil: 'load', timeout: 120000 });
await page.waitForTimeout(4000);

const diag = await page.evaluate(async () => {
  const out = {};
  out.hasSW = 'serviceWorker' in navigator;
  out.controller = !!navigator.serviceWorker.controller;
  const reg = await navigator.serviceWorker.getRegistration();
  out.regScope = reg ? reg.scope : null;
  out.regActive = reg && reg.active ? reg.active.state : null;
  out.regInstalling = reg && reg.installing ? reg.installing.state : null;
  out.regWaiting = reg && reg.waiting ? reg.waiting.state : null;
  out.cacheKeys = await caches.keys();
  // 逐个缓存里找 index 相关条目
  const found = {};
  for (const k of out.cacheKeys) {
    const c = await caches.open(k);
    const keys = await c.keys();
    found[k] = keys.map((r) => r.url).filter((u) => u.indexOf('index') >= 0 || u.endsWith('/class-site/'));
  }
  out.indexEntries = found;
  return out;
});
console.log(JSON.stringify(diag, null, 1));

// 再导航一次，看响应走的是网络还是 SW
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
const nav2 = await page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  return { transferSize: nav.transferSizeSize || nav.transferSize, type: nav.type, dcl: Math.round(nav.domContentLoadedEventEnd) };
});
console.log('nav2:', JSON.stringify(nav2));
await browser.close();
