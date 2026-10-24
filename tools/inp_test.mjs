/* v3.9.20：输入框样式一致性审计（后台全页面 + 前台关键弹窗） */
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

const COLLECT = () => {
  const out = [];
  document.querySelectorAll('input,select,textarea').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    if (['checkbox', 'radio', 'hidden', 'file', 'range', 'submit', 'button'].includes(el.type)) return;
    const cs = getComputedStyle(el);
    out.push({
      h: Math.round(r.height), r: cs.borderRadius, bd: cs.borderTopColor,
      bg: cs.backgroundColor, fs: cs.fontSize,
      tag: el.tagName.toLowerCase(),
    });
  });
  return out;
};

/* ---------------- 后台 ---------------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await page.route('**/api/**', async (r) => {
    const u = r.request().url();
    if (u.includes('/api/auth?action=me')) return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"user":{"id":4,"username":"aibot","displayName":"AI","role":"admin"}}' });
    if (u.includes('/api/island')) return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"data":{"on":true,"term":"x","startDate":"2026-09-01","components":[],"banner":{},"days":{},"holidays":[]}}' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('cls_auth', JSON.stringify({ token: 'x', user: { id: 4, username: 'aibot', displayName: 'AI', role: 'admin', status: 'active', title: '' } })));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1600);

  const names = await page.evaluate(() => [...document.querySelectorAll('[data-page]')].map((e) => e.textContent.trim()));
  t('后台导航加载出来了', names.length >= 20, String(names.length));

  const groups = new Map();
  for (let i = 0; i < names.length; i++) {
    await page.evaluate((i) => { document.querySelectorAll('[data-page]')[i].click(); }, i);
    await page.waitForTimeout(600);
    const rows = await page.evaluate(COLLECT);
    rows.forEach((r) => {
      const k = r.h + '|' + r.r;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(names[i] + ':' + r.tag);
    });
  }
  const keys = [...groups.keys()];
  console.log('    后台组合：' + keys.join(' ; '));
  t('后台输入框尺寸不超过 5 类', keys.length <= 5, keys.join(' | '));
  t('后台主尺寸是 42/12px', keys.some((k) => k === '42|12px'), keys.join(' | '));
  t('后台工具栏小号是 34/10px', keys.some((k) => k === '34|10px'), keys.join(' | '));

  /* 边框色 / 底色统一 */
  const colors = await page.evaluate(() => {
    const set = new Set();
    document.querySelectorAll('input,select,textarea').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.height < 2) return;
      if (['checkbox', 'radio', 'hidden', 'file', 'range'].includes(el.type)) return;
      const cs = getComputedStyle(el);
      set.add(cs.borderTopColor + ' / ' + cs.backgroundColor);
    });
    return [...set];
  });
  console.log('    后台配色：' + colors.join(' ; '));
  t('后台输入框配色只有 1~2 组', colors.length <= 2, colors.join(' | '));

  /* 聚焦有光晕 */
  const focus = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.gate-input, .inp, input[type="text"], input[type="password"], input[type="date"], select')]
      .find((x) => x.offsetParent !== null && x.getClientRects().length);
    if (!el) return null;
    el.focus();
    const cs = getComputedStyle(el);
    return { shadow: cs.boxShadow, bd: cs.borderTopColor };
  });
  t('后台输入框聚焦有光晕', !!focus && focus.shadow !== 'none', JSON.stringify(focus));
  await ctx.close();
}

/* ---------------- 前台 ---------------- */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  await page.route('**/api/**', async (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('cls_seen_welcome', '1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2800);
  await page.evaluate(() => {
    document.querySelectorAll('#welcomeMask,#loginGuideMask,#guestMask').forEach((m) => m.classList.remove('show'));
    try { openAccount(); } catch (e) {}
    const m = document.getElementById('allBoardMask');
    if (m) m.classList.add('show');
  });
  await page.waitForTimeout(1000);
  const rows = await page.evaluate(COLLECT);
  const main = rows.filter((r) => r.tag !== 'input' || r.fs !== '16.32px');
  const keys = [...new Set(rows.map((r) => r.h + '|' + r.r))];
  console.log('    前台组合：' + keys.join(' ; '));
  t('前台有输入框', rows.length >= 3, String(rows.length));
  t('前台主尺寸是 44/12px', keys.includes('44|12px'), keys.join(' | '));
  t('前台没有 40/10 这种旧尺寸', !keys.includes('40|10px') && !keys.includes('40|11px'), keys.join(' | '));
  t('搜索框高度是 44', rows.some((r) => r.h === 44 && r.r === '12px'));

  const shadow = await page.evaluate(() => {
    const el = document.getElementById('allSearchInput');
    if (!el) return null;
    el.focus();
    return getComputedStyle(el).boxShadow;
  });
  t('前台搜索框聚焦有光晕', !!shadow && shadow !== 'none', String(shadow));
  await ctx.close();
}

await browser.close();
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
