/* v4.10.19 专项：作业卡分栏从「按折行」改成「按高度贪心均衡」。
   验证：多科短作业不再全堆左栏，左右两栏高度接近（省空间）。
   跑法：本地 8111 静态服务 → node test_ui_v41019.mjs */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = 'http://localhost:8111';
const CHROME = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const OUT = '/workspace/classsite-v41019';
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
};

/* 6 科都是「一行放得下」的短作业 —— 旧逻辑会全堆左栏；新逻辑应均衡分到两栏 */
const HW = [
  { id: 'w2026-11-09', title: '高二上 · 第11周作业', start: '2026-11-09', end: '2026-11-13',
    items: [
      { subject: '语文', tasks: [{ text: '背诵《赤壁赋》' }, { text: '整理文言实词' }] },
      { subject: '数学', tasks: [{ text: '练习册 P45' }, { text: '错题本整理' }] },
      { subject: '英语', tasks: [{ text: '背 Unit 4 单词' }] },
      { subject: '物理', tasks: [{ text: '电场专题卷' }, { text: '预习磁场' }] },
      { subject: '化学', tasks: [{ text: '方程式默写' }, { text: '实验报告' }, { text: '复习氧化还原' }] },
      { subject: '生物', tasks: [{ text: '遗传题 10 道' }] }
    ] }
];

const EXAMS = {
  ok: true, at: Date.now(), today: '2026-11-09', title: '2026 高二上第二次段考', cls: '5班',
  base: 'https://examboard.dpdns.org',
  groups: [
    { id: 'major_a', name: '2026 高二上第二次段考', temporary: false, start: '2026-11-09', end: '2026-11-10', daysN: 2, count: 6, onCnt: 0, allOn: false, anyOn: false, auto: true,
      days: [
        { date: '2026-11-09', wd: '周一', onCnt: 0, allOn: false, anyOn: false, items: [
          { id: 'a1', name: '语文', start: '09:00', end: '11:30', pin: false, by: '' },
          { id: 'a2', name: '数学', start: '14:30', end: '16:30', pin: false, by: '' } ] },
        { date: '2026-11-10', wd: '周二', onCnt: 0, allOn: false, anyOn: false, items: [
          { id: 'a3', name: '物理', start: '08:30', end: '09:45', pin: false, by: '' },
          { id: 'a4', name: '外语', start: '10:00', end: '12:00', pin: false, by: '' },
          { id: 'a5', name: '化学', start: '14:30', end: '15:45', pin: false, by: '' },
          { id: 'a6', name: '生物', start: '15:50', end: '17:05', pin: false, by: '' } ] }
      ] }
  ],
  items: [], pins: { majors: [], days: [], items: [] }, pinAt: 0,
  term: { name: '2026 年秋季 · 高二上', start: '2026-09-01', end: '2027-01-30' }, cached: false, stale: false
};

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
await page.clock.install({ time: new Date('2026-11-09T10:00:00') });
await mock(page);
await page.goto(BASE + '/index.html?big=1', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
await page.evaluate((hw) => {
  AUTH.user = { username: 'aibot', role: 'admin' };
  SITE_DATA.holidayHomeworks = hw;
  try { closeLoginGuide(false); } catch (e) {}
  const g = document.getElementById('loginGuideMask'); if (g) g.style.display = 'none';
  BIG.openHw();
}, HW);
await page.waitForTimeout(1200);

/* ---------- ① 两栏都有卡片（不再全堆左栏） ---------- */
const dist = await page.evaluate(() => {
  const A = document.querySelectorAll('#bhwColA .bhw-subj').length;
  const B = document.querySelectorAll('#bhwColB .bhw-subj').length;
  return { A, B };
});
t('① 左栏与右栏都有作业卡（不是全堆一边）', dist.A > 0 && dist.B > 0, '左=' + dist.A + ' 右=' + dist.B);

/* ---------- ② 两栏总高接近（省空间） ---------- */
const bal = await page.evaluate(() => {
  const A = document.getElementById('bhwColA').getBoundingClientRect().height;
  const B = document.getElementById('bhwColB').getBoundingClientRect().height;
  return { A: Math.round(A), B: Math.round(B) };
});
const hi = Math.max(bal.A, bal.B), lo = Math.min(bal.A, bal.B);
t('② 两栏高度接近（较高栏不超过较矮栏 1.6 倍）', hi > 0 && hi <= lo * 1.6, '左' + bal.A + 'px / 右' + bal.B + 'px');

/* ---------- ③ 考试卡固定在左栏顶部 ---------- */
const examPos = await page.evaluate(() => {
  const e = document.getElementById('bhwExam');
  const A = document.getElementById('bhwColA');
  return !!(e && A && e.parentNode === A && A.firstElementChild === e);
});
t('③ 考试卡仍在左栏最顶部', examPos);

/* ---------- ④ 无 JS 报错 ---------- */
t('④ 页面无 JS 报错', errs.length === 0, errs.join(' | ').slice(0, 160));

await page.screenshot({ path: OUT + '/01-均衡分栏-只读态.png', fullPage: false });
/* 编辑态再截一张，确认输入时不会被搬动 */
await page.evaluate(() => { try { BIG.hwEditToggle(true); } catch (e) {} });
await page.waitForTimeout(700);
const distEdit = await page.evaluate(() => ({
  A: document.querySelectorAll('#bhwColA .bhw-subj').length,
  B: document.querySelectorAll('#bhwColB .bhw-subj').length
}));
t('⑤ 编辑态两栏也都有卡', distEdit.A > 0 && distEdit.B > 0, '左=' + distEdit.A + ' 右=' + distEdit.B);
await page.screenshot({ path: OUT + '/02-均衡分栏-编辑态.png', fullPage: false });

await browser.close();
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
