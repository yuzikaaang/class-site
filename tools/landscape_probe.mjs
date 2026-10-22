/* 横屏模式下 FAB 与后台顶栏在滚动后的实际位置 */
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
await page.addInitScript(() => { localStorage.setItem('cls_land', '1'); });
await page.goto('http://localhost:8111/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);

const info = await page.evaluate(async () => {
  const html = document.documentElement;
  // 用真实入口开启横屏（LAND_ON 落盘 + 重算 class）
  LAND_ON = true;
  try{ localStorage.setItem('cls_land', '1'); }catch(e){}
  syncLandscapeClass();
  if(typeof landscapePin === 'function') landscapePin();
  await new Promise((r) => setTimeout(r, 400));
  const fab = document.getElementById('fabBtn');
  const before = fab.getBoundingClientRect();
  const sc = document.querySelector('.layout') || document.body;
  document.body.scrollTop = 400;
  await new Promise((r) => setTimeout(r, 300));
  const after = fab.getBoundingClientRect();
  return {
    bodyScrollTop: document.body.scrollTop,
    bodyScrollHeight: document.body.scrollHeight,
    bodyClientHeight: document.body.clientHeight,
    fabStyle: { pos: getComputedStyle(fab).position, top: getComputedStyle(fab).top, left: getComputedStyle(fab).left },
    before: { x: Math.round(before.x), y: Math.round(before.y), w: Math.round(before.width), h: Math.round(before.height) },
    after: { x: Math.round(after.x), y: Math.round(after.y) },
  };
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
