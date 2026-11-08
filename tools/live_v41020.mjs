/* v4.10.20 线上真机验收：日期条默认收起 / 字号归整 / 导出图片批量选择 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const SITE = 'https://yuzikaaang.github.io/class-site/';
const CH = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const OUT = '/workspace/classsite-v41020/';
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const t = (n, ok, x) => { if (ok) { pass++; console.log('  ✓ ' + n + (x ? '  [' + x + ']' : '')); } else { fail++; console.log('  ✗ ' + n + (x ? '  [' + x + ']' : '')); } };

const HW = [
  { id: 'w2026-11-09', title: '高二上 · 第11周作业', start: '2026-11-09', end: '2026-11-13',
    items: [
      { subject: '语文', tasks: [{ text: '背诵《赤壁赋》', due: '2026-11-13 18:00' }] },
      { subject: '数学', tasks: [{ text: '练习册 P45' }] }
    ] },
  { id: 'w2026-11-02', title: '高二上 · 第10周作业', start: '2026-11-02', end: '2026-11-06',
    items: [
      { subject: '英语', tasks: [{ text: '背 Unit 3 单词' }] },
      { subject: '物理', tasks: [{ text: '电场专题卷' }] }
    ] }
];

const b = await chromium.launch({ executablePath: CH, args: ['--no-sandbox'] });
function mock(p) {
  return p.route('**/api/**', (r) => {
    const u = r.request().url();
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.includes('/api/exams')) return J({ ok: true, at: 1, today: '2026-11-09', title: '2026 高二上第二次段考', cls: '5班', base: 'https://examboard.dpdns.org', groups: [], items: [], pins: { majors: [], days: [], items: [] }, pinAt: 0, term: { name: '2026 年秋季 · 高二上', start: '2026-09-01', end: '2027-01-30' }, cached: false, stale: false });
    if (u.includes('/api/island')) return J({ ok: true, data: { on: true, startDate: '2026-09-01', endDate: '2027-01-30', enrollDate: '2025-09-01', term: '高二上', holidays: [] } });
    if (u.includes('/auth?action=me')) return J({ ok: true, user: { username: 'aibot', role: 'admin' } });
    if (u.includes('/api/content')) return J({ ok: true, items: { holiday_homeworks: HW, announcements: [] } });
    if (u.includes('/boards')) return J({ ok: true, url: 'https://example.com/x' });
    return J({ ok: true });
  });
}

/* ---- A. 大屏：版本 + 日期条默认收起 + 字号归整 ---- */
{
  const c = await b.newContext({ viewport: { width: 1600, height: 900 } });
  const p = await c.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await mock(p);
  await p.goto(SITE + '?big=1&r=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(2800);
  await p.evaluate((hw) => {
    AUTH.user = { username: 'aibot', role: 'admin' };
    SITE_DATA.holidayHomeworks = hw;
    try { closeLoginGuide(false); } catch (e) {}
    const g = document.getElementById('loginGuideMask'); if (g) g.style.display = 'none';
    document.querySelectorAll('.allboard-mask.show,.gate.show').forEach(m => m.classList.remove('show'));
    BIG.openHw();
  }, HW);
  await p.waitForTimeout(1200);

  const ver = await p.evaluate(() => (typeof SITE_VERSION !== 'undefined' ? SITE_VERSION : ''));
  t('线上版本为 4.10.20', ver === '4.10.20', ver);

  const folded = await p.evaluate(() => document.documentElement.classList.contains('bhw-ds-fold'));
  t('线上日期条默认收起', folded === true);

  const fs = await p.evaluate(() => {
    BIG.fs = 103; BIG.fsStep(1); const a = BIG.fs;
    BIG.fs = 103; BIG.fsStep(-1); const b2 = BIG.fs;
    return { a, b: b2 };
  });
  t('线上字号归整（103 → 加=105、减=100）', fs.a === 105 && fs.b === 100, JSON.stringify(fs));

  t('线上大屏无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await p.screenshot({ path: OUT + '线上-日期条默认收起.png' });
  await c.close();
}

/* ---- B. 普通模式：导出图片批量选择 ---- */
{
  const c = await b.newContext({ viewport: { width: 420, height: 860 } });
  const p = await c.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.clock.install({ time: new Date('2026-11-09T10:00:00') });
  await mock(p);
  await p.goto(SITE + '?r=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(2600);
  await p.evaluate((hw) => {
    AUTH.user = { username: 'aibot', role: 'admin' };
    SITE_DATA.holidayHomeworks = hw;
    try { closeLoginGuide(false); } catch (e) {}
    const g = document.getElementById('loginGuideMask'); if (g) g.style.display = 'none';
    showCurrentHomework();
  }, HW);
  await p.waitForTimeout(700);
  await p.evaluate(() => hwExportImage('download'));
  await p.waitForTimeout(500);
  const info = await p.evaluate(() => {
    const mask = document.getElementById('hwExPickMask');
    return { shown: !!mask, n: mask ? mask.querySelectorAll('[data-hw-exidx]').length : 0 };
  });
  t('线上导出图片弹多期选择层（2 份）', info.shown && info.n === 2, JSON.stringify(info));
  await p.screenshot({ path: OUT + '线上-导出批量选择.png' });
  t('线上普通模式无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await c.close();
}

console.log('\nv4.10.20 线上验收：' + pass + ' 通过 / ' + fail + ' 失败');
await b.close();
process.exit(fail ? 1 : 0);
