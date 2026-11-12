import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = 'http://localhost:8899';
const CH = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const OUT = '/workspace/classsite-v4140/';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CH, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
page.on('requestfailed', (r) => errs.push('failed: ' + r.url().slice(0, 100)));

await page.route('**/api/**', (r) => {
  const u = r.request().url();
  const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (u.includes('/api/island')) return J({ ok: true, data: null });
  if (u.includes('/api/content')) return J({ ok: true, items: { announcements: [] } });
  if (u.includes('auth')) return J({ ok: true });
  return J({ ok: true });
});
await page.addInitScript(() => {
  localStorage.setItem('cls_login_guide_v1', '1');
  localStorage.setItem('cls_theme', 'light');
  localStorage.setItem('cls_theme_auto2', 'off');
  localStorage.setItem('cls_tour_v1', JSON.stringify({ login: { done: 1 }, home: { done: 1 }, services: { done: 1 }, hwpop: { done: 1 }, scores: { done: 1 }, big: { done: 1 }, settings: { done: 1 }, files: { done: 1 } }));
});
await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2600);
for (const sel of ['.welcome-mask.show button', '.allboard-mask.show .allboard-head button']) {
  const el = await page.$(sel);
  if (el) { try { await el.click({ timeout: 600 }); await page.waitForTimeout(300); } catch (e) {} }
}

/* 打开板块 3，注入假成绩行 */
const rows = [
  { id: 11, name: '陈曦', studentId: '250512', total: 600 },
  { id: 12, name: '李四', studentId: '250503', total: 580 },
  { id: 13, name: '张三', studentId: '250501', total: 590 },
  { id: 14, name: '王五', studentId: '250515', total: 570 },
  { id: 15, name: '赵六', studentId: '', total: 560 },
  { id: 16, name: '阿明', studentId: '250508', total: 550 },
];
await page.evaluate((rows) => {
  window.AUTH.user = { id: 0, role: 'admin', name: '班级电脑' };
  SC.rows = rows; SC.viewAs = null; SC.tab = 'me'; SC.exam = { subjects: [], cutlines: [] };
  SC.loaded = true;
  openCat(3);
  scLoad = function(){};
  scEnsureMounted = function(){};
}, rows);
await page.waitForTimeout(900);
await page.evaluate(() => {
  document.getElementById('scPaneBox').innerHTML = scViewBar()
    + '<div class="sc-hint">（测试用：仅验证选择条本身的排版）</div>';
  scVPickOpen();
  scVPickType('');
});
await page.waitForTimeout(600);
await page.screenshot({ path: OUT + '01-picker.png', fullPage: false });

const geo = await page.evaluate(() => {
  const b = document.getElementById('scVPickBtn').getBoundingClientRect();
  const p = document.getElementById('scVPickPop').getBoundingClientRect();
  const pane = document.getElementById('scPaneBox').getBoundingClientRect();
  return { btn: [b.x, b.y, b.width, b.height], pop: [p.x, p.y, p.width, p.height], pane: [pane.x, pane.y, pane.width, pane.height], vh: innerHeight };
});
console.log('geometry:', JSON.stringify(geo));

/* 搜索「张」 */
await page.fill('#scVPickInp', '张');
await page.waitForTimeout(300);
console.log('filtered:', await page.evaluate(() => [...document.querySelectorAll('#scVPickList .sc-vpick-item')].map((x) => x.textContent.replace(/\s+/g, ' ').trim())));
await page.screenshot({ path: OUT + '02-picker-search.png' });

/* 点搜索框不应收起 */
await page.click('#scVPickInp');
await page.waitForTimeout(200);
console.log('click input keeps open:', await page.evaluate(() => {
  const p = document.getElementById('scVPickPop'); return p ? p.hidden === false : 'gone';
}));
/* 点选第一条 */
await page.evaluate(() => { scVPickType('李'); });
await page.waitForTimeout(150);
await page.click('#scVPickList .sc-vpick-item');
await page.waitForTimeout(500);
console.log('after choose:', await page.evaluate(() => ({
  viewAs: SC.viewAs,
  popInBody: !!document.querySelector('body > .sc-vpick-pop'),
  bar: document.querySelector('.sc-viewbar') ? document.querySelector('.sc-viewbar').textContent.replace(/\s+/g,' ').trim() : null
})));

/* 密码强度：注册表单 */
const pwd = await page.evaluate(() => {
  const box = document.getElementById('acctBody');
  box.innerHTML = '<div class="acct-field"><label>密码</label><input id="acctP" type="password" data-pwm="1">' + pwmHtml() + '</div>';
  document.getElementById('acctMask').classList.add('show');
  const inp = document.getElementById('acctP');
  inp.value = 'Abc12345';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
});
await page.waitForTimeout(400);
const pwdState = await page.evaluate(() => {
  const m = document.querySelector('#acctBody .pwm');
  return { lv: m.getAttribute('data-lv'), txt: m.querySelector('.pwm-txt').textContent, bars: [...m.querySelectorAll('i')].map((i) => getComputedStyle(i).backgroundColor) };
});
console.log('pwm strong:', JSON.stringify(pwdState));
await page.screenshot({ path: OUT + '03-pwm.png' });

await page.evaluate(() => {
  document.getElementById('acctMask').classList.remove('show');
  document.getElementById('scPaneBox').innerHTML = scViewBar();
  document.getElementById('scVPickBtn').click();
  const inp = document.getElementById('scVPickInp');
  inp.value = '1';
  scVPickType('1');
});
await page.waitForTimeout(500);
await page.screenshot({ path: OUT + '04-picker-darkcheck.png' });

console.log('errors:', JSON.stringify(errs.slice(0, 6)));
await browser.close();
