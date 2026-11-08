/* v4.10.18 线上真机验收：快捷作业卡移到作业卡上方 + 回今天回到当天 */
import { chromium } from 'playwright-core';
const SITE = 'https://yuzikaaang.github.io/class-site/';
const CH = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const OUT = '/workspace/classsite-v41018/';
import fs from 'node:fs';
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const t = (n, ok, x) => { if (ok) { pass++; console.log('  ✓ ' + n + (x ? '  [' + x + ']' : '')); } else { fail++; console.log('  ✗ ' + n + (x ? '  [' + x + ']' : '')); } };

/* 今天 = 2026-11-08（周日，落在第 10 周周末作业 11/07~11/08） */
const HW = [
  { id: 'w2026-11-02', title: '高二上 · 第10周作业', start: '2026-11-02', end: '2026-11-06',
    items: [{ subject: '语文', tasks: [{ text: '背《赤壁赋》' }] }] },
  { id: 'w2026-11-02we', title: '高二上 · 第10周周末作业', start: '2026-11-07', end: '2026-11-08',
    items: [
      { subject: '数学', tasks: [{ text: '周末试卷一套' }] },
      { subject: '英语', tasks: [{ text: '背 Unit 4 单词' }] }
    ] },
  { id: 'w2026-11-09', title: '高二上 · 第11周作业', start: '2026-11-09', end: '2026-11-13',
    items: [{ subject: '物理', tasks: [{ text: '电场专题' }] }] }
];
const EXAMS = { ok: true, at: 1, today: '2026-11-08', groups: [], items: [], pins: { majors: [], days: [], items: [] } };

const b = await chromium.launch({ executablePath: CH, args: ['--no-sandbox'] });
async function mock(p) {
  return p.route('**/api/**', (r) => {
    const u = r.request().url();
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.includes('/api/exams')) return J(EXAMS);
    if (u.includes('/api/island')) return J({ ok: true, data: { on: true, startDate: '2026-09-01', endDate: '2027-01-30', enrollDate: '2025-09-01', term: '高二上', holidays: [] } });
    if (u.includes('/auth?action=me')) return J({ ok: true, user: { username: 'aibot', role: 'admin' } });
    if (u.includes('/api/content')) return J({ ok: true, items: { holiday_homeworks: HW, announcements: [] } });
    if (u.includes('/boards')) return J({ ok: true, url: 'https://example.com/x' });
    return J({ ok: true });
  });
}
async function enter(p) {
  await p.evaluate((hw) => {
    AUTH.user = { username: 'aibot', role: 'admin' };
    SITE_DATA.holidayHomeworks = hw;
    try { closeLoginGuide(false); } catch (e) {}
    const g = document.getElementById('loginGuideMask'); if (g) g.style.display = 'none';
    document.querySelectorAll('.allboard-mask.show,.gate.show').forEach(m => m.classList.remove('show'));
    BIG.openHw();               /* 不跳日期，按今天看 */
  }, HW);
  await p.waitForTimeout(1000);
}

const c = await b.newContext({ viewport: { width: 1600, height: 900 } });
const p = await c.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.clock.install({ time: new Date('2026-11-08T10:00:00') });
await mock(p);
await p.goto(SITE + '?big=1&r=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout(2800);
await enter(p);

const ver = await p.evaluate(() => ({
  site: typeof SITE_VERSION !== 'undefined' ? SITE_VERSION : '',
  ds: typeof BIG.dsToggle,
  pad: getComputedStyle(document.getElementById('bigHw')).paddingBottom
}));
t('线上版本为 4.10.18，展开态底部留白 104px', ver.site === '4.10.18' && ver.pad === '104px', JSON.stringify(ver));

/* 回今天 */
const cur0 = await p.evaluate(() => {
  const c = document.querySelector('#bhwDateStrip .ds-day.cur');
  return c ? c.title.slice(0, 10) : null;
});
t('线上默认日期条高亮今天 11/08', cur0 === '2026-11-08', 'cur=' + cur0);

await p.evaluate(() => BIG.hwJumpTo('2026-11-09'));
await p.waitForTimeout(300);
await p.locator('#bhwDateStrip .ds-today').click();
await p.waitForTimeout(300);
const back = await p.evaluate(() => {
  const c = document.querySelector('#bhwDateStrip .ds-day.cur');
  return c ? c.title.slice(0, 10) : null;
});
t('线上点「回今天」回到 11/08（非周末作业第一天 11/07）', back === '2026-11-08', 'cur=' + back);

/* 科目按钮移到作业卡上方 */
await p.evaluate(() => { BIG.hwEditToggle(); });
await p.waitForTimeout(400);
const addsubj = await p.evaluate(() => {
  const a = document.getElementById('bhwAddSubj');
  const g = document.querySelector('.bhw-grid');
  if (!a || !g) return null;
  const ar = a.getBoundingClientRect(), gr = g.getBoundingClientRect();
  return { pos: getComputedStyle(a).position, btns: a.querySelectorAll('.bhw-subjbtn').length, above: ar.bottom <= gr.top + 1 };
});
t('线上科目按钮不再固定底部（position 非 fixed）', addsubj && addsubj.pos !== 'fixed', addsubj && addsubj.pos);
t('线上编辑态七个科目按钮排在作业卡上方', addsubj && addsubj.btns === 7 && addsubj.above);

await p.screenshot({ path: OUT + '线上-科目按钮在作业卡上方.png' });
t('线上全程无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));

console.log('\nv4.10.18 线上验收：' + pass + ' 通过 / ' + fail + ' 失败');
await c.close(); await b.close();
process.exit(fail ? 1 : 0);
