/* v3.9.25：全屏时钟的「使用记录」—— 本地记账 / 抽屉展示 / 上云 */
import { chromium } from 'playwright-core';

const BASE = 'http://localhost:8111';
const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
let pass = 0, fail = 0;
const t = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d ? '  → ' + d : '')); }
};

const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

/* 云端交互全部拦下来，只看它发了什么 */
const puts = [];
await page.route('**/api/data**', async (route) => {
  const req = route.request();
  if (req.method() === 'PUT') {
    puts.push(JSON.parse(req.postData() || '{}'));
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  }
  return route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, key: 'x', value: null, updatedAt: null }),
  });
});

await page.goto(BASE + '/clock.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await page.evaluate(() => { document.querySelector('[data-m="flip"]').click(); });
await page.waitForTimeout(4200);

/* 1. 本地记账 */
const local = await page.evaluate(() => {
  const key = Object.keys(localStorage).find((k) => k.indexOf('cls_clock_log_') === 0);
  return { key, val: key ? JSON.parse(localStorage.getItem(key)) : null };
});
t('本地按天存了记录', /^cls_clock_log_\d{4}-\d{2}-\d{2}$/.test(local.key || ''), local.key);
t('切模式会落一段', !!(local.val && local.val.segs && local.val.segs.length), JSON.stringify(local.val && local.val.segs));
t('刚打开那段记的是「数字/倒计时」之类', local.val && local.val.segs[0]
  && ['timer', 'clock', 'flip'].indexOf(local.val.segs[0].m) >= 0, local.val && local.val.segs[0] && local.val.segs[0].m);
t('每段带起止和秒数', local.val && local.val.segs.every((x) => x.s > 0 && x.e > x.s && x.d >= 3), JSON.stringify(local.val && local.val.segs));

/* 2. 抽屉 */
await page.evaluate(() => document.getElementById('logBtn').click());
await page.waitForTimeout(700);
const panel = await page.evaluate(() => ({
  shown: document.getElementById('logPanel').className,
  day: document.getElementById('logDay').textContent,
  sum: document.getElementById('logSum').textContent,
  rows: [...document.querySelectorAll('.lg-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
  foot: document.getElementById('logFoot').textContent,
}));
t('点「记录」打开右侧抽屉', /show/.test(panel.shown), panel.shown);
t('日期显示「今天」', panel.day === '今天', panel.day);
t('概览有自习 / 休息 / 番茄三张卡',
  /自习/.test(panel.sum) && /休息/.test(panel.sum) && /番茄/.test(panel.sum), panel.sum);
t('时间线列出了刚才那几段', panel.rows.length >= 1, JSON.stringify(panel.rows));
t('未登录时说明只在本机', /未登录/.test(panel.foot), panel.foot);

/* 3. 自习按「专注 / 休息」两段记 */
await page.evaluate(() => document.getElementById('logClose').click());
await page.evaluate(() => {
  document.querySelector('[data-m="pomo"]').click();
  const pf = document.getElementById('pf');
  pf.value = 1; pf.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(300);
await page.evaluate(() => document.getElementById('pomoBtn').click());
await page.waitForTimeout(4500);
await page.evaluate(() => document.getElementById('pomoSkip').click());   /* 进休息 */
await page.waitForTimeout(4200);
/* 休息那段还在计时，切个模式让它落盘（不切的话只有结束才写） */
await page.evaluate(() => { document.querySelector('[data-m="clock"]').click(); });
await page.waitForTimeout(400);

const segs = await page.evaluate(() => {
  const key = Object.keys(localStorage).find((k) => k.indexOf('cls_clock_log_') === 0);
  return JSON.parse(localStorage.getItem(key)).segs;
});
const modes = segs.map((s) => s.m);
t('自习记成 pomo:focus / pomo:rest 两段',
  modes.indexOf('pomo:focus') >= 0 && modes.indexOf('pomo:rest') >= 0, JSON.stringify(modes));
t('专注那段有实际时长', segs.filter((s) => s.m === 'pomo:focus').every((s) => s.d >= 3),
  JSON.stringify(segs.filter((s) => s.m === 'pomo:focus')));

await page.evaluate(() => document.getElementById('logBtn').click());
await page.waitForTimeout(600);
const sum2 = await page.evaluate(() => document.getElementById('logSum').textContent.replace(/\s+/g, ' ').trim());
t('抽屉里能看出自习了多久 / 休息多久', /自习/.test(sum2) && /秒|分钟/.test(sum2), sum2);
await page.evaluate(() => document.getElementById('logClose').click());

/* 4. 登录后自动上云 */
await page.evaluate(() => {
  localStorage.setItem('cls_auth', JSON.stringify({ token: 'tok_test', user: { id: 4, username: 'aibot' } }));
});
await page.evaluate(() => { document.querySelector('[data-m="clock"]').click(); });
await page.waitForTimeout(1200);
/* 用秒表造一段，跑够 3 秒再切走 —— 段落结束才会触发上传 */
await page.evaluate(() => { document.querySelector('[data-m="stop"]').click(); });
await page.waitForTimeout(4200);
await page.evaluate(() => { document.querySelector('[data-m="clock"]').click(); });
await page.waitForTimeout(3500);   /* 等 2.5 秒的推送防抖 */
t('登录后把当天记录 PUT 到 /api/data', puts.length > 0, 'put 次数 ' + puts.length);
const putBody = puts[puts.length - 1] || {};
const putKey = Object.keys(putBody.items || {})[0] || '';
t('推送的键是 cls_clock_log_<日期>', /^cls_clock_log_\d{4}-\d{2}-\d{2}$/.test(putKey), putKey);
t('推送内容带 segs 数组', Array.isArray((putBody.items || {})[putKey] && putBody.items[putKey].segs),
  JSON.stringify(putBody.items && putBody.items[putKey] && Object.keys(putBody.items[putKey])));

/* 5. 打开抽屉时把云端那份合并进来 */
await page.unroute('**/api/data**');
await page.route('**/api/data**', async (route) => {
  const req = route.request();
  if (req.method() === 'PUT') {
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  }
  const day = (await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.indexOf('cls_clock_log_') === 0);
    return k.slice('cls_clock_log_'.length);
  }));
  const base = new Date(day + 'T08:00:00').getTime();
  return route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, key: 'k', value: {
      v: 2, pomo: 2,
      segs: [{ m: 'pomo:focus', s: base, e: base + 1500000, d: 1500 }],
    } }),
  });
});
await page.evaluate(() => document.getElementById('logBtn').click());
await page.waitForTimeout(1500);
const merged = await page.evaluate(() => ({
  sum: document.getElementById('logSum').textContent.replace(/\s+/g, ' ').trim(),
  rows: [...document.querySelectorAll('.lg-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
  foot: document.getElementById('logFoot').textContent,
}));
t('云端那份会合并进本机（多出早上那段）', merged.rows.some((r) => /08:00/.test(r)), JSON.stringify(merged.rows));
t('番茄数取两边的较大值', /2\s*个/.test(merged.sum), merged.sum);
t('登录后底部显示已同步', /已同步/.test(merged.foot), merged.foot);

/* 6. 切后台不计时 */
await page.evaluate(() => document.getElementById('logClose').click());
const before = await page.evaluate(() => {
  const k = Object.keys(localStorage).find((x) => x.indexOf('cls_clock_log_') === 0);
  return JSON.parse(localStorage.getItem(k)).segs.length;
});
await page.evaluate(() => {
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await page.waitForTimeout(4000);
const afterHide = await page.evaluate(() => {
  const k = Object.keys(localStorage).find((x) => x.indexOf('cls_clock_log_') === 0);
  const segs = JSON.parse(localStorage.getItem(k)).segs;
  return { n: segs.length, last: segs[segs.length - 1] };
});
t('切到后台会立刻收账', afterHide.n > before, before + ' → ' + afterHide.n);

t('全程无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
