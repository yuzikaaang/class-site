/* v3.9.19：天气详情 = 修水 + 从现在起 24 小时 */
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })).newPage();

let pass = 0, fail = 0;
const t = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d ? '  → ' + d : '')); }
};

/* 48 小时数据：今天 00:00 起 */
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

await page.route('**/api/**', async (route) => {
  const u = route.request().url();
  if (u.includes('/api/island'))
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"data":{"on":true,"term":"2026 年秋季 · 高二上","startDate":"2026-09-01","components":["time","weather","week"],"banner":{"mon":"数数语英化"},"days":{},"holidays":[]}}' });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
});

await page.route('**api.open-meteo.com/**', async (route) => {
  const u = route.request().url();
  const hs = hours();
  if (u.indexOf('hourly=') >= 0) {
    return route.fulfill({
      status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        hourly: {
          time: hs,
          temperature_2m: hs.map((_, i) => 12 + Math.round(Math.sin(i / 3) * 6)),
          weather_code: hs.map((_, i) => (i % 5 === 0 ? 61 : 0)),
          precipitation_probability: hs.map((_, i) => (i % 5 === 0 ? 70 : 0)),
        },
      }),
    });
  }
  return route.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ current: { temperature_2m: 21.4, weather_code: 1 } }),
  });
});

await page.goto('http://localhost:8111/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

await page.evaluate(() => { if (window.islWxOpen) islWxOpen(); });
await page.waitForTimeout(1200);

const info = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#islWxBody .isl-wx-row')];
  return {
    title: (document.getElementById('islWxTitle') || {}).textContent,
    sub: (document.getElementById('islWxSub') || {}).textContent,
    n: rows.length,
    first: rows[0] && rows[0].querySelector('.t').textContent,
    days: [...document.querySelectorAll('#islWxBody .isl-wx-day')].map((e) => e.textContent),
    nowCount: document.querySelectorAll('#islWxBody .isl-wx-row.now').length,
  };
});

t('标题写明修水', /修水/.test(info.title || ''), info.title);
t('正好 24 小时', info.n === 24, String(info.n));
t('第一行是「现在」', info.first === '现在', info.first);
t('只有一条高亮为当前', info.nowCount === 1, String(info.nowCount));
t('跨天有日期分隔', info.days.length >= 1, JSON.stringify(info.days));
t('副标题是这 24 小时的温度范围', /未来 24 小时/.test(info.sub || ''), info.sub);

/* 第一行的小时应当等于当前小时 */
const hh = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#islWxBody .isl-wx-row')];
  return rows.slice(1, 3).map((r) => r.querySelector('.t').textContent);
});
const nowH = new Date().getHours();
const expect1 = ('0' + ((nowH + 1) % 24)).slice(-2) + ':00';
t('第二行是下一个小时', hh[0] === expect1, JSON.stringify(hh) + ' 期望 ' + expect1);

await browser.close();
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
