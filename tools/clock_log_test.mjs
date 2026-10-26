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

const goTop = (pg, m) => pg.evaluate((mm) => {
  document.getElementById('modeBtn').click();
  const b = document.querySelector('#modeMenu [data-m="' + mm + '"]');
  if (b) b.click();
  document.getElementById('modeMenu').className = '';
}, m);
const goSub = (pg, k) => pg.evaluate((kk) => {
  let b = document.querySelector('#subTabs button[data-k="' + kk + '"]');
  if (!b) {
    document.getElementById('modeBtn').click();
    const want = (kk === 'up' || kk === 'down' || kk === 'pomo') ? 'timer' : 'clock';
    const tb = document.querySelector('#modeMenu [data-m="' + want + '"]');
    if (tb) tb.click();
    document.getElementById('modeMenu').className = '';
    b = document.querySelector('#subTabs button[data-k="' + kk + '"]');
  }
  if (b) b.click();
}, k);

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
await goSub(page, 'flip');
await page.waitForTimeout(4200);

/* 1. 本地记账 */
const local = await page.evaluate(() => {
  const key = Object.keys(localStorage).find((k) => k.indexOf('cls_clock_log_') === 0);
  return { key, val: key ? JSON.parse(localStorage.getItem(key)) : null };
});
t('本地按天存了记录', /^cls_clock_log_\d{4}-\d{2}-\d{2}$/.test(local.key || ''), local.key);
t('切模式会落一段', !!(local.val && local.val.segs && local.val.segs.length), JSON.stringify(local.val && local.val.segs));
t('刚打开那段记的是「计时/数字/翻页」之类', local.val && local.val.segs[0]
  && ['pomo:focus', 'timer', 'clock', 'flip'].indexOf(local.val.segs[0].m) >= 0, local.val && local.val.segs[0] && local.val.segs[0].m);
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
/* v3.11.0：自习并进「计时」了 —— 设 2 轮，跳过专注直接进休息，两段都能落盘 */
await goTop(page, 'timer');
await page.waitForTimeout(200);
await goSub(page, 'pomo');
await page.waitForTimeout(200);
await page.evaluate(() => {
  document.getElementById('timerTime').click();
  document.getElementById('roundsInp').value = '2';
  document.getElementById('restInp').value = '1';
  document.getElementById('dsOk').click();
});
await page.waitForTimeout(300);
await page.evaluate(() => document.getElementById('timerBtn').click());
await page.waitForTimeout(4500);
await page.evaluate(() => document.getElementById('skipBtn').click());   /* 进休息 */
await page.waitForTimeout(4200);
/* 休息那段还在计时，切个模式让它落盘（不切的话只有结束才写） */
await goSub(page, 'clock');
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
await goSub(page, 'clock');
await page.waitForTimeout(1200);
/* 用计时模块造一段（跑够 3 秒再切走）—— 段落结束才会触发上传 */
await goTop(page, 'timer');
await page.waitForTimeout(200);
/* 先停掉上一段遗留的计时再重新开，保证这一段是全新的、跑够 3 秒 */
await page.evaluate(() => {
  document.getElementById('timerReset').click();
  document.getElementById('timerBtn').click();
});
await page.waitForTimeout(4500);
await goSub(page, 'clock');
await page.waitForTimeout(5000);   /* 先拉一次对账 + 2.5 秒推送防抖，留够时间 */
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

/* 6-2. v3.11.1：看昨天的时候，卡片得写「昨日自习」，不能还写「今天」 */
{
  const ctxY = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pY = await ctxY.newPage();
  await pY.addInitScript(() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    const p2 = (n) => String(n).padStart(2, '0');
    const k = 'cls_clock_log_' + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    const base = d.getTime() - 3 * 3600e3;
    localStorage.setItem(k, JSON.stringify({ v: 2, pomo: 2, segs: [
      { m: 'pomo:focus', s: base, e: base + 1500e3, d: 1500, n: '数学·试卷' },
      { m: 'pomo:rest', s: base + 1500e3, e: base + 1800e3, d: 300 },
    ] }));
  });
  await pY.goto(BASE + '/clock.html?m=timer', { waitUntil: 'domcontentloaded' });
  await pY.waitForTimeout(900);

  await pY.evaluate(() => document.getElementById('logBtn').click());
  await pY.waitForTimeout(400);
  const today = await pY.evaluate(() => document.getElementById('logSum').textContent);
  t('看今天时卡片写「今日自习」', /今日自习/.test(today), today.slice(0, 40));

  await pY.evaluate(() => document.getElementById('logPrev').click());
  await pY.waitForTimeout(600);
  const yest = await pY.evaluate(() => ({
    day: document.getElementById('logDay').textContent,
    sum: document.getElementById('logSum').textContent.replace(/\s+/g, ' ').trim(),
  }));
  t('切到昨天，标题变「昨天」', yest.day === '昨天', yest.day);
  t('昨天的卡片写「昨日自习」而不是「今天自习」', /昨日自习/.test(yest.sum) && !/今天自习|今日自习/.test(yest.sum), yest.sum.slice(0, 60));
  t('休息 / 番茄也带上「昨日」', /昨日休息/.test(yest.sum) && /昨日番茄/.test(yest.sum), yest.sum.slice(0, 80));

  /* 再往前翻两天 → 写具体日期 */
  await pY.evaluate(() => document.getElementById('logPrev').click());
  await pY.waitForTimeout(500);
  await pY.evaluate(() => document.getElementById('logPrev').click());
  await pY.waitForTimeout(500);
  const older = await pY.evaluate(() => ({
    day: document.getElementById('logDay').textContent,
    sum: document.getElementById('logSum').textContent.replace(/\s+/g, ' ').trim(),
  }));
  t('更早的日期用「10 月 24 日 自习」这种写法', /月\s*\d+\s*日\s*自习/.test(older.sum), older.sum.slice(0, 60));
  await ctxY.close();
}

/* 6-3. v3.13.0：每段记录带上「哪台设备」，抽屉里能看出在哪儿用的 */
{
  const ctxD = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pD = await ctxD.newPage();
  const errsD = [];
  pD.on('pageerror', (e) => errsD.push(e.message));
  await pD.goto(BASE + '/clock.html?m=timer', { waitUntil: 'domcontentloaded' });
  await pD.waitForTimeout(900);

  const dev = await pD.evaluate(() => document.body && (window.__clk.dev ? window.__clk.dev() : null));
  t('页面能识别出设备名', !!dev && dev.length >= 2, String(dev));

  /* 记一段，看段落里有没有 dv */
  await pD.evaluate(() => { document.getElementById('doingInp').value = '数学'; });
  await pD.evaluate(() => document.getElementById('timerBtn').click());
  await pD.waitForTimeout(4200);
  await pD.evaluate(() => { document.getElementById('modeBtn').click(); document.querySelector('#modeMenu [data-m="clock"]').click(); });
  await pD.waitForTimeout(600);
  const segDev = await pD.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.indexOf('cls_clock_log_') === 0);
    const v = k ? JSON.parse(localStorage.getItem(k)) : null;
    const last = v && v.segs[v.segs.length - 1];
    return last ? { dv: last.dv, n: last.n } : null;
  });
  t('记下的那一段带上了设备名', !!(segDev && segDev.dv === dev), JSON.stringify(segDev));

  /* 抽屉里：行上有设备徽标，汇总里有「设备：」那一行 */
  await pD.evaluate(() => document.getElementById('logBtn').click());
  await pD.waitForTimeout(600);
  const view = await pD.evaluate(() => ({
    chips: [...document.querySelectorAll('#logList .lg-dev')].map((x) => x.textContent),
    sum: document.getElementById('logSum').textContent.replace(/\s+/g, ' ').trim(),
  }));
  t('记录列表每条都标了设备', view.chips.length > 0 && view.chips[0] === dev, JSON.stringify(view.chips));
  t('汇总里有「设备：…」这一行', /设备：/.test(view.sum) && view.sum.indexOf(dev) >= 0, view.sum.slice(-60));
  t('设备标记无 JS 报错', errsD.length === 0, errsD.join(' | '));
  await ctxD.close();
}

/* ================= v3.10.4 云同步重做 =================
   站主反馈：手机上记的，iPad 上什么都没有（新设备本地空 → 第一次推把云端冲掉了） */
const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const D = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
const K = 'cls_clock_log_' + D;

/* 7. 新设备：一进页面就自动把云端记录拉进本地 */
const ctx7 = await browser.newContext({ viewport: { width: 1100, height: 800 } });
const p7 = await ctx7.newPage();
const errs7 = [];
p7.on('pageerror', (e) => errs7.push(e.message));
const puts7 = [];
const order7 = [];
await p7.route('**/api/data**', async (route) => {
  const req = route.request();
  const url = req.url();
  if (req.method() === 'PUT') {
    order7.push('PUT');
    puts7.push(JSON.parse(req.postData() || '{}'));
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  }
  order7.push('GET');
  return route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, items: { [K]: { v: 2, pomo: 3, segs: [
      { m: 'pomo:focus', s: Date.now() - 3 * 3600e3, e: Date.now() - 2.5 * 3600e3, d: 1800, n: '语文·试卷' },
    ] } } }),
  });
});
await p7.addInitScript(() => {
  localStorage.setItem('cls_auth', JSON.stringify({ token: 'tok7', user: { id: 9, username: 'x' } }));
});
await p7.goto(BASE + '/clock.html', { waitUntil: 'domcontentloaded' });
await p7.waitForTimeout(2500);
const got7 = await p7.evaluate((k) => {
  const raw = localStorage.getItem(k);
  return raw ? JSON.parse(raw) : null;
}, K);
t('新设备一进页面就把云端记录拉进本地（不用点抽屉）',
  !!(got7 && got7.segs.some((x) => x.n === '语文·试卷')), JSON.stringify(got7 && got7.segs));
t('番茄数也一起拉下来了', !!(got7 && got7.pomo === 3), String(got7 && got7.pomo));

/* 8. 推送前先合并：写这一天的记录不会把云端那段冲掉 */
await p7.evaluate(() => {
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await p7.waitForTimeout(1500);
const put8 = (puts7[puts7.length - 1] || {}).items || {};
const segs8 = (put8[K] || {}).segs || [];
t('切后台会立刻推一次', puts7.length > 0, 'put 次数 ' + puts7.length);
t('推上去的内容包含云端原有的那段（没被覆盖）',
  segs8.some((x) => x.n === '语文·试卷'), JSON.stringify(segs8.map((x) => x.n || x.m)));
t('推送前先 GET 对过账', order7.indexOf('GET') >= 0 && order7.indexOf('GET') < order7.indexOf('PUT'), order7.join('→'));
t('新设备无 JS 报错', errs7.length === 0, errs7.slice(0, 2).join(' | '));
await ctx7.close();

/* 9. 推送失败会重试，数据不丢 */
const ctx9 = await browser.newContext({ viewport: { width: 1100, height: 800 } });
const p9 = await ctx9.newPage();
let put9 = 0;
await p9.route('**/api/data**', async (route) => {
  const req = route.request();
  if (req.method() === 'PUT') {
    put9++;
    if (put9 === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"items":{}}' });
});
await p9.addInitScript(() => {
  localStorage.setItem('cls_auth', JSON.stringify({ token: 'tok9', user: { id: 9, username: 'x' } }));
});
await p9.goto(BASE + '/clock.html', { waitUntil: 'domcontentloaded' });
await p9.waitForTimeout(1200);
await p9.evaluate(() => {
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await p9.waitForTimeout(9500);
t('推送失败后会自动重试（数据没丢）', put9 >= 2, 'put 次数 ' + put9);
t('重试后底部显示已同步', /已同步/.test(await p9.evaluate(() => document.getElementById('logFoot').textContent)),
  await p9.evaluate(() => document.getElementById('logFoot').textContent));

/* 10. 点「返回」先上传再跳走 */
await p9.route('**/index.html', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>stub</body></html>' }));
const before10 = put9;
await p9.evaluate(() => { document.getElementById('back').click(); });
await p9.waitForTimeout(700);
t('点「返回」会先把当天记录推一次', put9 > before10, before10 + ' → ' + put9);
await p9.waitForTimeout(800);
t('推完真的跳回首页了', /index\.html/.test(p9.url()), p9.url());
await ctx9.close();

await browser.close();
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
