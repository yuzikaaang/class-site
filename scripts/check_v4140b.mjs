import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = 'http://localhost:8899';
const CH = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const OUT = '/workspace/classsite-v4140/';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CH, args: ['--no-sandbox'] });

async function prep(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1.5 });
  const page = await ctx.newPage();
  await page.route('**/api/**', (r) => {
    const u = r.request().url();
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.includes('/api/island')) return J({ ok: true, data: null });
    if (u.includes('/api/content')) return J({ ok: true, items: { announcements: [] } });
    return J({ ok: true });
  });
  await page.addInitScript(() => {
    localStorage.setItem('cls_login_guide_v1', '1');
    localStorage.setItem('cls_theme', 'light');
    localStorage.setItem('cls_theme_auto2', 'off');
    localStorage.setItem('cls_tour_v1', JSON.stringify({ login: { done: 1 }, home: { done: 1 }, services: { done: 1 }, hwpop: { done: 1 }, scores: { done: 1 }, big: { done: 1 }, settings: { done: 1 }, files: { done: 1 } }));
  });
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2400);
  for (const sel of ['.welcome-mask.show button']) {
    const el = await page.$(sel);
    if (el) { try { await el.click({ timeout: 600 }); } catch (e) {} }
  }
  return { ctx, page };
}

const rows = [
  { id: 11, name: '陈曦', studentId: '250512' },
  { id: 13, name: '张三', studentId: '250501' },
  { id: 15, name: '赵六', studentId: '' },
  { id: 16, name: '阿明', studentId: '250508' },
];

/* 桌面 1280 */
{
  const { ctx, page } = await prep(1280, 800);
  await page.evaluate((rows) => {
    window.AUTH.user = { id: 0, role: 'admin', name: '班级电脑' };
    SC.rows = rows; SC.viewAs = null; SC.tab = 'me'; SC.exam = { subjects: [], cutlines: [] };
    SC.loaded = true; openCat(3); scLoad = function(){}; scEnsureMounted = function(){};
  }, rows);
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    document.getElementById('scPaneBox').innerHTML = scViewBar();
    scVPickOpen();
  });
  await page.waitForTimeout(400);
  console.log('desktop pop:', await page.evaluate(() => {
    const p = document.getElementById('scVPickPop').getBoundingClientRect();
    return [Math.round(p.x), Math.round(p.y), Math.round(p.width), Math.round(p.height)];
  }));
  await page.screenshot({ path: OUT + '05-desktop.png' });
  await ctx.close();
}

/* 暗色手机 */
{
  const { ctx, page } = await prep(412, 900);
  await page.evaluate(() => { document.documentElement.classList.add('dark'); });
  await page.evaluate((rows) => {
    window.AUTH.user = { id: 0, role: 'admin', name: '班级电脑' };
    SC.rows = rows; SC.viewAs = null; SC.tab = 'me'; SC.exam = { subjects: [], cutlines: [] };
    SC.loaded = true; openCat(3); scLoad = function(){}; scEnsureMounted = function(){};
  }, rows);
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    document.getElementById('scPaneBox').innerHTML = scViewBar();
    document.getElementById('scVPickBtn').click();
    const inp = document.getElementById('scVPickInp');
    inp.value = '2'; scVPickType('2');
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + '06-dark.png' });
  await ctx.close();
}

/* 后台修改密码面板 */
{
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    document.body.innerHTML = '<div style="max-width:420px;margin:60px auto;padding:24px;background:var(--panel);border-radius:16px">'
      + '<div class="field"><label for="pwNew">新密码</label>'
      + '<input id="pwNew" type="password" placeholder="6–64 位" oninput="pwmInput(this)">'
      + '<div class="pwm"><span class="pwm-bars"><i></i><i></i><i></i><i></i></span><span class="pwm-txt"></span></div>'
      + '<p class="hint">建议使用字母与数字组合，且不同于登录名。</p></div></div>';
    const inp = document.getElementById('pwNew');
    inp.value = '20100710'; pwmInput(inp);
  });
  await page.waitForTimeout(400);
  console.log('admin meter:', await page.evaluate(() => {
    const m = document.querySelector('.pwm');
    return { lv: m.getAttribute('data-lv'), txt: m.querySelector('.pwm-txt').textContent, bars: [...m.querySelectorAll('i')].map((i) => getComputedStyle(i).backgroundColor) };
  }));
  await page.screenshot({ path: OUT + '07-admin.png' });
  await ctx.close();
}

await browser.close();
