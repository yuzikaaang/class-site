/* v4.15.8 专项：考试卡占满作业区整行
   站主原话：「考试卡它是只占左侧 1/2 那个栏，右侧那个是不算的，所以呢它只剩左侧 1/2 栏。」
   覆盖：
     ① 考试卡脱离左栏，挂到 .bhw-grid 上、横跨两列
     ② 考试卡排在作业卡上方，两栏整体下移
     ③ 宽屏下日期打头、当天各科横向并排，不再一科一行
     ④ 考试卡出现后整页不再多滚一屏
     ⑤ 手机单列时顺序仍是 考试卡 → 作业卡
     ⑥ 没有考试时不渲染，期次为空时考试卡照样占满
*/
import { chromium } from 'playwright-core';

const EXE = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://127.0.0.1:8899';
const today = (() => { const d = new Date(); const z = n => ('0' + n).slice(-2); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); })();

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))); }
};

const ISL = { on: true, term: '2026 年秋季 · 高二上', startDate: '2026-09-01', endDate: '2027-01-20', components: ['time'], banner: {}, days: {}, holidays: [], photo: '' };
const mkItem = (s, n) => ({ subject: s, tasks: Array.from({ length: n }, (_, i) => ({ text: s + '作业第' + (i + 1) + '项：完成课本练习与错题整理' })) });
const HWS = [
  { id: 'w11we', title: '第11周周末作业', start: '2026-11-14', end: '2026-11-15',
    items: [mkItem('语文', 3), mkItem('数学', 4), mkItem('英语', 3), mkItem('物理', 3), mkItem('化学', 2), mkItem('生物', 2)] },
];
const mkDay = (date, names, wd) => ({ date, wd, anyOn: false, items: names.map((n, i) => ({ id: date + '_' + i, name: n, start: '08:20', end: '10:20', pin: false })) });
const EXAMS = {
  ok: true, today, base: '', title: '高二', cls: '',
  groups: [
    { id: 'g11', name: '第11周周末限时训练', start: '2026-11-14', end: '2026-11-15', auto: false, count: 6,
      days: [mkDay('2026-11-14', ['数学', '物理', '化学', '语文'], '六'), mkDay('2026-11-15', ['生物', '英语'], '日')] },
  ],
  pins: { majors: [], days: [], items: [] },
  term: { name: '高二上', start: '2026-09-01', end: '2027-01-31' },
};
const NO_EXAMS = { ok: true, today, base: '', title: '高二', cls: '', groups: [], pins: { majors: [], days: [], items: [] }, term: {} };

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

async function open(opts = {}) {
  const { w = 1920, h = 1080, hws = HWS, exams = EXAMS, mobile = false } = opts;
  const ctx = await browser.newContext(mobile
    ? { viewport: { width: w, height: h }, isMobile: true, hasTouch: true }
    : { viewport: { width: w, height: h } });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('  [pageerror]', e.message));
  await p.route('**/api/**', r => {
    const u = r.request().url();
    const J = o => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.includes('/api/island')) return J({ ok: true, data: ISL });
    if (u.includes('/api/content')) return J({ ok: true, items: { holiday_homeworks: hws, announcements: [] } });
    if (u.includes('/auth?action=me')) return J({ ok: true, user: { id: 4, username: 'aibot', displayName: 'AI', role: 'admin', status: 'active' } });
    if (u.includes('/api/exams')) return J(exams);
    return J({ ok: true });
  });
  await p.addInitScript(() => {
    try {
      localStorage.setItem('cls_welcome_v1', '1');
      localStorage.setItem('cls_login_guide_v1', '1');
      localStorage.removeItem('cls_hw_local_v1');
    } catch (e) {}
  });
  await p.goto(BASE + '/index.html?big=1&_r=' + Date.now(), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2600);
  await p.evaluate(() => {
    window.isAdmin = () => true;
    ['popMask', 'loginGuideMask'].forEach(id => { const e = document.getElementById(id); if (e) e.remove(); });
    BIG.openHw();
  });
  await p.waitForTimeout(1800);
  return { ctx, p };
}

const geom = p => p.evaluate(() => {
  const ex = document.getElementById('bhwExam');
  const g = document.querySelector('.bhw-grid');
  const ca = document.getElementById('bhwColA');
  const cb = document.getElementById('bhwColB');
  const R = e => e.getBoundingClientRect();
  const gr = R(g), er = ex ? R(ex) : null, ar = R(ca), br = R(cb);
  const cs = ex ? getComputedStyle(ex) : null;
  const inner = (() => { const s = getComputedStyle(g); return gr.width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight); })();
  return {
    has: !!ex,
    parentIsGrid: ex ? ex.parentNode === g : false,
    parentId: ex && ex.parentNode ? (ex.parentNode.id || ex.parentNode.className) : '',
    gridRow: cs ? cs.gridRowStart : '',
    gridCol: cs ? cs.gridColumnStart + '/' + cs.gridColumnEnd : '',
    examW: er ? Math.round(er.width) : 0,
    examH: er ? Math.round(er.height) : 0,
    examY: er ? Math.round(er.y) : null,
    colAw: Math.round(ar.width), colBw: Math.round(br.width),
    colAy: Math.round(ar.y), colBy: Math.round(br.y),
    innerW: Math.round(inner),
    docW: document.documentElement.scrollWidth, vw: innerWidth,
    docH: document.documentElement.scrollHeight, vh: innerHeight,
    days: ex ? [...ex.querySelectorAll('.bhex-day')].map(d => ({ y: Math.round(R(d).y), h: Math.round(R(d).height) })) : [],
    rows: ex ? [...ex.querySelectorAll('.bhex-row')].map(d => Math.round(R(d).y)) : [],
    subjN: { a: ca.querySelectorAll('.bhw-subj').length, b: cb.querySelectorAll('.bhw-subj').length },
  };
});

// ---------- ① 1920 宽屏 ----------
console.log('\n① 1920 宽屏：考试卡横跨作业区整行');
{
  const { ctx, p } = await open({ w: 1920, h: 1080 });
  const g = await geom(p);
  ok('考试卡渲染出来了', g.has, g);
  ok('它挂在 .bhw-grid 上，不再塞在左栏里', g.parentIsGrid && g.parentId.indexOf('bhwCol') < 0, g.parentId);
  ok('宽度等于作业区整行（两栏 + 中间间隙）', Math.abs(g.examW - g.innerW) <= 2 || g.examW > g.colAw + g.colBw - 4,
    { examW: g.examW, innerW: g.innerW, colAw: g.colAw, colBw: g.colBw });
  ok('宽度接近两栏之和（不是只剩一半）', g.examW >= (g.colAw + g.colBw) - 16, { examW: g.examW, sum: g.colAw + g.colBw });
  ok('排在两栏作业卡上方', g.examY < g.colAy, { examY: g.examY, colAy: g.colAy });
  ok('占网格第 2 行、跨两列', g.gridRow === '2' && /^1\/(3|span 2)$/.test(g.gridCol), { row: g.gridRow, col: g.gridCol });
  ok('六科作业分到两栏，没被挤成一栏', g.subjN.a >= 1 && g.subjN.b >= 1, g.subjN);

  console.log('\n② 宽屏下日期打头、各科横向并排');
  ok('至少有两个科目排在同一行（不是一科一行）',
    (() => { const m = {}; g.rows.forEach(y => m[y] = (m[y] || 0) + 1); return Object.values(m).some(v => v >= 2); })(), g.rows);
  ok('两天考试各自成块', g.days.length === 2, g.days);
  ok('每块只占一行高（日期和科目在一行里，没有竖着堆）', g.days.every(d => d.h <= 60), g.days);

  console.log('\n③ 考试卡不再把整页顶出一屏');
  ok('没有横向滚动', g.docW <= g.vw, { docW: g.docW, vw: g.vw });
  ok('纵向没有多出空白滚动区', g.docH <= g.vh + 8, { docH: g.docH, vh: g.vh });
  await p.screenshot({ path: '/workspace/classsite-v4158/test-1920.png' });
  await ctx.close();
}

// ---------- ④ 1366 笔记本 ----------
console.log('\n④ 1366 宽屏');
{
  const { ctx, p } = await open({ w: 1366, h: 768 });
  const g = await geom(p);
  ok('考试卡仍是整行宽', g.examW >= (g.colAw + g.colBw) - 16, { examW: g.examW, sum: g.colAw + g.colBw });
  ok('仍在两栏作业卡上方', g.examY < g.colAy, { examY: g.examY, colAy: g.colAy });
  ok('没有横向滚动', g.docW <= g.vw, { docW: g.docW, vw: g.vw });
  await p.screenshot({ path: '/workspace/classsite-v4158/test-1366.png' });
  await ctx.close();
}

// ---------- ⑤ 手机单列 ----------
console.log('\n⑤ 手机单列：顺序是 考试卡 → 作业卡');
{
  const { ctx, p } = await open({ w: 390, h: 844, mobile: true });
  const g = await geom(p);
  ok('手机上也渲染考试卡', g.has, g);
  ok('考试卡在作业卡上方（顺序没反）', g.examY < g.colAy, { examY: g.examY, colAy: g.colAy });
  ok('手机上没有横向溢出', g.docW <= g.vw + 1, { docW: g.docW, vw: g.vw });
  ok('单列下两栏折叠成一栏', g.colBw === 0 || g.colBw === g.colAw, { colAw: g.colAw, colBw: g.colBw });
  await p.screenshot({ path: '/workspace/classsite-v4158/test-390.png' });
  await ctx.close();
}

// ---------- ⑥ 没有考试 / 期次为空 ----------
console.log('\n⑥ 没有考试时不占位');
{
  const { ctx, p } = await open({ w: 1920, h: 1080, exams: NO_EXAMS });
  const g = await geom(p);
  ok('没有考试时整块不渲染', !g.has, g.has);
  ok('作业卡直接贴到顶部，不留空白', g.colAy < 200, { colAy: g.colAy });
  await ctx.close();
}

console.log('\n⑦ 当期一科作业都没有时，考试卡照样占满整行');
{
  const { ctx, p } = await open({ w: 1920, h: 1080, hws: [{ id: 'empty', title: '第11周周末作业', start: '2026-11-14', end: '2026-11-15', items: [] }] });
  const g = await geom(p);
  ok('考试卡还在', g.has, g);
  ok('仍然横跨整行', g.examW >= (g.colAw + g.colBw) - 16 || g.examW >= g.innerW - 2, { examW: g.examW, innerW: g.innerW, colAw: g.colAw });
  await ctx.close();
}

await browser.close();
console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败');
process.exit(fail ? 1 : 0);
