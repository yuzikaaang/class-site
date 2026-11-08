/* v4.10.18 专项：①快捷作业卡（科目按钮）移到作业卡上方；②日期条「回今天」回到真·今天
   跑法：本地 8111 静态服务 → node test_ui_v41018.mjs */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = 'http://localhost:8111';
const CHROME = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const OUT = '/workspace/classsite-v41018';
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
};

/* 固定「今天」= 2026-11-08（周日，落在第 10 周周末作业 11/07~11/08 里）。
   关键：周末作业 start=11/07。旧逻辑「回今天」会亮到 11/07（期次第一天），
   正确应该是 11/08 本身。 */
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

const EXAMS = { ok: true, at: Date.now(), today: '2026-11-08', groups: [], items: [], pins: { majors: [], days: [], items: [] } };

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

function mock(page) {
  return page.route('**/api/**', (r) => {
    const u = r.request().url();
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.includes('/api/exams')) return J(EXAMS);
    if (u.includes('/api/island')) return J({ ok: true, data: { on: true, startDate: '2026-09-01', endDate: '2027-01-30', enrollDate: '2025-09-01', term: '高二上', holidays: [] } });
    if (u.includes('/auth?action=me')) return J({ ok: true, user: { username: 'aibot', role: 'admin' } });
    if (u.includes('/api/content')) return J({ ok: true, items: { holiday_homeworks: HW, announcements: [] } });
    return J({ ok: true });
  });
}

const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.clock.install({ time: new Date('2026-11-08T10:00:00') });
await mock(page);
await page.goto(BASE + '/index.html?big=1', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
await page.evaluate((hw) => {
  AUTH.user = { username: 'aibot', role: 'admin' };
  SITE_DATA.holidayHomeworks = hw;
  try { closeLoginGuide(false); } catch (e) {}
  const g = document.getElementById('loginGuideMask'); if (g) g.style.display = 'none';
  BIG.openHw();               /* 不传 id、不跳日期 —— 就按「今天」看 */
}, HW);
await page.waitForTimeout(900);

/* ---------- ① 默认锚点就是今天 11/08（周日），不是周末作业第一天 11/07 ---------- */
const cur0 = await page.evaluate(() => {
  const c = document.querySelector('#bhwDateStrip .ds-day.cur');
  return c ? c.title.slice(0, 10) : null;
});
t('① 进作业页默认日期条高亮「今天」11/08', cur0 === '2026-11-08', 'cur=' + cur0);

/* ---------- ② 跳到第 11 周（点 11/09），出现「回今天」 ---------- */
await page.evaluate(() => BIG.hwJumpTo('2026-11-09'));
await page.waitForTimeout(300);
const jumped = await page.evaluate(() => {
  const c = document.querySelector('#bhwDateStrip .ds-day.cur');
  const b = document.querySelector('#bhwDateStrip .ds-today');
  return { cur: c ? c.title.slice(0, 10) : null, hasToday: !!b };
});
t('② 跳到 11/09 后高亮 11/09，并出现「回今天」',
  jumped.cur === '2026-11-09' && jumped.hasToday, 'cur=' + jumped.cur);

/* ---------- ③ 点「回今天」回到 11/08，而不是周末作业第一天 11/07 ---------- */
await page.locator('#bhwDateStrip .ds-today').click();
await page.waitForTimeout(300);
const back = await page.evaluate(() => {
  const c = document.querySelector('#bhwDateStrip .ds-day.cur');
  const b = document.querySelector('#bhwDateStrip .ds-today');
  const wk = document.querySelector('#bhwDateStrip .ds-weekno');
  return { cur: c ? c.title.slice(0, 10) : null, hasToday: !!b, week: wk ? wk.textContent : '' };
});
t('③ 点「回今天」后高亮回到 11/08（真·今天）', back.cur === '2026-11-08', 'cur=' + back.cur);
t('③ 「回今天」按钮随之隐藏（已在今天）', back.hasToday === false);

/* ---------- ④ 快捷作业卡（科目按钮）移到作业卡上方 ---------- */
await page.evaluate(() => { BIG.hwEditToggle(); });
await page.waitForTimeout(400);
const addsubj = await page.evaluate(() => {
  const a = document.getElementById('bhwAddSubj');
  const g = document.querySelector('.bhw-grid');
  const colA = document.getElementById('bhwColA');
  if (!a || !g || !colA) return null;
  const ar = a.getBoundingClientRect();
  const gr = g.getBoundingClientRect();
  return {
    pos: getComputedStyle(a).position,
    display: getComputedStyle(a).display,
    btns: a.querySelectorAll('.bhw-subjbtn').length,
    above: ar.bottom <= gr.top + 1,        /* 科目按钮整块在网格（作业卡）上方 */
    inGrid: a.compareDocumentPosition(colA) & Node.DOCUMENT_POSITION_FOLLOWING
  };
});
t('④ 科目按钮不再固定底部（position 非 fixed）', addsubj && addsubj.pos !== 'fixed', addsubj && addsubj.pos);
t('④ 编辑态下七个科目按钮渲染出来', addsubj && addsubj.btns === 7, addsubj && 'btns=' + addsubj.btns);
t('④ 科目按钮整块排在作业卡上方', addsubj && addsubj.above, addsubj && ('above=' + addsubj.above));
t('④ DOM 顺序：科目按钮在作业卡（bhwColA）之前', addsubj && !!addsubj.inGrid);

await page.screenshot({ path: OUT + '/01-科目按钮在作业卡上方-编辑态.png', fullPage: false });

/* ---------- ⑤ 只读态科目按钮隐藏（不占位） ---------- */
await page.evaluate(() => { BIG.hwEditToggle(); });
await page.waitForTimeout(300);
const readonly = await page.evaluate(() => {
  const a = document.getElementById('bhwAddSubj');
  return a ? getComputedStyle(a).display : 'none';
});
t('⑤ 退出编辑（只读态）科目按钮整块隐藏', readonly === 'none', readonly);

/* ---------- ⑥ 无脚本报错 ---------- */
t('⑥ 全程无 JS 运行时报错', errs.length === 0, errs.slice(0, 2).join(' | '));

console.log('\nv4.10.18 专项：' + pass + ' 通过 / ' + fail + ' 失败');
await ctx.close();
await browser.close();
process.exit(fail ? 1 : 0);
