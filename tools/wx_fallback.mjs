/* v3.9.21：天气「不显示温度」的兜底行为验证 */
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

function hours() {
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const out = [];
  for (let i = 0; i < 48; i++) {
    const d = new Date(d0.getTime() + i * 3600000);
    const p = (n) => ('0' + n).slice(-2);
    out.push(d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':00');
  }
  return out;
}
const HS = hours();
const TMP = HS.map((_, i) => 14 + Math.round(Math.sin(i / 4) * 5));

async function open({ payload, state, mode = 'ok' }) {
  /* SW 会把请求转出去，page.route 拦不到 → 测试里禁掉 SW */
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  let calls = 0;
  await page.route('**/v1/forecast**', (r) => {
    const u = r.request().url();
    if (u.indexOf('hourly=') < 0) {
      return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"current":{"temperature_2m":21.4,"weather_code":1}}' });
    }
    calls++;
    if (mode === 'fail') return r.abort('failed');
    return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(payload) });
  });
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('cls_seen_welcome', '1'));
  if (state) await page.evaluate((s) => { Object.keys(s).forEach((k) => localStorage.setItem(k, s[k])); }, state);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);
  await page.evaluate(() => {
    document.querySelectorAll('#welcomeMask,#loginGuideMask,#guestMask').forEach((m) => m.classList.remove('show'));
    if (window.islWxOpen) islWxOpen();
  });
  await page.waitForTimeout(1500);
  return { page, ctx, calls: () => calls };
}

/* 1. 正常：24 行都有温度 */
{
  const { page, ctx } = await open({ payload: { hourly: { time: HS, temperature_2m: TMP, weather_code: HS.map(() => 0), precipitation_probability: HS.map(() => 0) } } });
  const r = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#islWxBody .isl-wx-row')];
    return {
      n: rows.length,
      noT: rows.filter((x) => x.classList.contains('no-t')).length,
      first: rows[0] && rows[0].querySelector('.tp').textContent,
      sub: (document.getElementById('islWxSub') || {}).textContent,
      cached: !!localStorage.getItem('__cls_wx_h2'),
    };
  });
  t('正常数据：24 行', r.n === 24, String(r.n));
  t('正常数据：没有缺温度的格子', r.noT === 0, String(r.noT));
  t('正常数据：第一行有温度', /\d+°/.test(r.first || ''), r.first);
  t('正常数据：会写缓存', r.cached);
  await ctx.close();
}

/* 2. 温度整段缺失：要提示，而不是一屏「—」，且不写缓存 */
{
  const { page, ctx } = await open({ payload: { hourly: { time: HS, weather_code: HS.map(() => 0), precipitation_probability: HS.map(() => 0) } } });
  const r = await page.evaluate(() => ({
    sub: (document.getElementById('islWxSub') || {}).textContent,
    hasLink: !!document.querySelector('#islWxSub a'),
    cached: !!localStorage.getItem('__cls_wx_h2'),
    rows: document.querySelectorAll('#islWxBody .isl-wx-row').length,
  }));
  t('温度缺失：副标题给出说明', /温度暂时没取到/.test(r.sub || ''), r.sub);
  t('温度缺失：有「重新获取」入口', r.hasLink);
  t('温度缺失：不把残缺数据写进缓存', r.cached === false);
  await ctx.close();
}

/* 3. 缓存残缺（老版本写坏的）：应忽略并重新请求 */
{
  const bad = JSON.stringify({ t: Date.now(), v: { time: HS, temp: [], code: [], rain: [] } });
  const { page, ctx, calls } = await open({
    payload: { hourly: { time: HS, temperature_2m: TMP, weather_code: HS.map(() => 0), precipitation_probability: HS.map(() => 0) } },
    state: { __cls_wx_h2: bad },
  });
  const r = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#islWxBody .isl-wx-row')];
    return { n: rows.length, noT: rows.filter((x) => x.classList.contains('no-t')).length };
  });
  t('残缺缓存：会重新联网', calls() >= 1, String(calls()));
  t('残缺缓存：最后能显示温度', r.n === 24 && r.noT === 0, JSON.stringify(r));
  await ctx.close();
}

/* 4. 请求失败 + 有有效旧缓存：显示旧数据并说明 */
{
  const good = JSON.stringify({ t: Date.now() - 3600000, v: { time: HS, temp: TMP, code: HS.map(() => 0), rain: HS.map(() => 0) } });
  const { page, ctx } = await open({ mode: 'fail', state: { __cls_wx_h2: good } });
  const r = await page.evaluate(() => ({
    sub: (document.getElementById('islWxSub') || {}).textContent,
    rows: document.querySelectorAll('#islWxBody .isl-wx-row').length,
    noT: document.querySelectorAll('#islWxBody .isl-wx-row.no-t').length,
  }));
  t('请求失败但有旧数据：仍然显示温度', r.rows === 24 && r.noT === 0, JSON.stringify(r));
  t('请求失败但有旧数据：说明是上次的数据', /上次的数据/.test(r.sub || ''), r.sub);
  await ctx.close();
}

/* 5. 请求失败 + 无缓存：错误提示 + 重试按钮可用 */
{
  const { page, ctx } = await open({ mode: 'fail' });
  const r1 = await page.evaluate(() => ({
    txt: (document.getElementById('islWxBody') || {}).textContent,
    btn: !!document.querySelector('.isl-wx-retry'),
  }));
  t('请求失败无缓存：给出可重试提示', /天气没取到/.test(r1.txt || '') && r1.btn, r1.txt);
  await ctx.close();
}

/* 6. 首页格子：接口挂了也要显示上次的温度，而不是「—」 */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.route('**/api/**', (r) => {
    const u = r.request().url();
    if (u.includes('/api/island')) return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"data":{"on":true,"term":"x","startDate":"2026-09-01","components":["time","weather","week"],"banner":{},"days":{},"holidays":[]}}' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/v1/forecast**', (r) => r.abort('failed'));
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.setItem('cls_seen_welcome', '1');
    /* 一小时前的成功值：超过 30 分钟，会触发刷新 */
    localStorage.setItem('__cls_wx', JSON.stringify({ t: Date.now() - 3600000, v: { t: 23, s: '多云' } }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const r = await page.evaluate(() => {
    const el = document.querySelector('#islWx');
    return { txt: el ? el.textContent : '', retry: typeof islWxRetry === 'function' };
  });
  t('首页格子失败时保留上次温度', /23°/.test(r.txt || ''), r.txt);
  t('失败后会自动重试一次（钩子存在）', r.retry);
  await ctx.close();
}

await browser.close();
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
