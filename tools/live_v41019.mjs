/* v4.10.19 线上真机验收：作业卡两栏按顺序切分 + 高度均衡（不再一边挤一边空） */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const SITE = 'https://yuzikaaang.github.io/class-site/';
const CH = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const OUT = '/workspace/classsite-v41019/';
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const t = (n, ok, x) => { if (ok) { pass++; console.log('  ✓ ' + n + (x ? '  [' + x + ']' : '')); } else { fail++; console.log('  ✗ ' + n + (x ? '  [' + x + ']' : '')); } };

/* 6 科短作业：旧逻辑会全堆左栏；新逻辑应顺序切分、均衡到两栏 */
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
  ok: true, at: 1, today: '2026-11-09', title: '2026 高二上第二次段考', cls: '5班',
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
    BIG.openHw();
  }, HW);
  await p.waitForTimeout(1200);
}

const c = await b.newContext({ viewport: { width: 1600, height: 900 } });
const p = await c.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.clock.install({ time: new Date('2026-11-09T10:00:00') });
await mock(p);
await p.goto(SITE + '?big=1&r=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout(2800);
await enter(p);

const ver = await p.evaluate(() => (typeof SITE_VERSION !== 'undefined' ? SITE_VERSION : ''));
t('线上版本为 4.10.19', ver === '4.10.19', ver);

const dist = await p.evaluate(() => {
  const A = document.querySelectorAll('#bhwColA .bhw-subj').length;
  const B = document.querySelectorAll('#bhwColB .bhw-subj').length;
  const hA = document.getElementById('bhwColA').getBoundingClientRect().height;
  const hB = document.getElementById('bhwColB').getBoundingClientRect().height;
  const exam = document.getElementById('bhwExam');
  const examTop = !!(exam && exam.parentNode === document.getElementById('bhwColA')
    && document.getElementById('bhwColA').firstElementChild === exam);
  return { A, B, hA: Math.round(hA), hB: Math.round(hB), examTop };
});
t('线上左栏与右栏都有作业卡（不堆一边）', dist.A > 0 && dist.B > 0, '左=' + dist.A + ' 右=' + dist.B);
t('线上两栏高度接近（较高不超过较矮 1.6 倍）',
  Math.max(dist.hA, dist.hB) <= Math.min(dist.hA, dist.hB) * 1.6, '左' + dist.hA + '/右' + dist.hB);
t('线上考试卡仍在左栏最顶部', dist.examTop);

await p.screenshot({ path: OUT + '线上-均衡分栏.png' });
t('线上全程无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));

console.log('\nv4.10.19 线上验收：' + pass + ' 通过 / ' + fail + ' 失败');
await c.close(); await b.close();
process.exit(fail ? 1 : 0);
