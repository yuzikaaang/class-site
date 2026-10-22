/* 后台横屏：顶栏与汉堡按钮滚动后的位置 */
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
await page.goto('http://localhost:8111/admin.html', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  localStorage.setItem('cls_auth', JSON.stringify({ token: 'x', user: { id: 4, username: 'aibot', displayName: 'AI 助手', role: 'admin', status: 'active', title: '' } }));
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);

const info = await page.evaluate(async () => {
  const html = document.documentElement;
  html.classList.add('force-landscape');
  await new Promise((r) => setTimeout(r, 300));
  // 撑高内容，让页面真的能滚
  const tall = document.createElement('div');
  tall.style.height = '3000px';
  document.querySelector('.content').appendChild(tall);
  await new Promise((r) => setTimeout(r, 200));
  const head = document.querySelector('.head');
  const burger = document.getElementById('burger');
  const b0 = head.getBoundingClientRect();
  const g0 = burger.getBoundingClientRect();
  const scrollables = [...document.querySelectorAll('html,body,.main,.content,.view,#view')]
    .map((el) => ({ tag: el.tagName + (el.id ? '#' + el.id : '.' + (el.className || '')), sh: el.scrollHeight, ch: el.clientHeight, st: el.scrollTop }));
  document.body.scrollTop = 900;
  window.scrollTo(0, 900);
  document.documentElement.scrollTop = 900;
  const se = document.scrollingElement;
  se.scrollTop = 900;
  await new Promise((r) => setTimeout(r, 300));
  const scrolled = { scrollables, se: se.tagName, seTop: se.scrollTop, bodyTop: document.body.scrollTop };
  const b1 = head.getBoundingClientRect();
  const g1 = burger.getBoundingClientRect();
  return {
    scrollTop: document.body.scrollTop,
    scrolled,
    headPos: getComputedStyle(head).position,
    headBefore: { x: Math.round(b0.x), y: Math.round(b0.y) },
    headAfter: { x: Math.round(b1.x), y: Math.round(b1.y) },
    burgerBefore: { x: Math.round(g0.x), y: Math.round(g0.y) },
    burgerAfter: { x: Math.round(g1.x), y: Math.round(g1.y) },
    burgerVisible: g1.x >= 0 && g1.x <= 390 && g1.y >= 0 && g1.y <= 844,
  };
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
