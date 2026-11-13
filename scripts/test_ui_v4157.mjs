/* v4.15.7 专项：考试块跟随作业期次 + 两栏分栏顺序
   覆盖：
     ① 今天有考试 → 自动出现在当前期次（不用手动＋）
     ② 翻到上一周期次 → 只显示那一期的考试
     ③ 今天没有任何作业 → 考试照样显示
     ④ 考试弹窗默认停在「本期」
     ⑤ 逐科添加作业 → 按科目顺序切成两栏，保持语数英 / 物化生顺序
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
const HWS = [
  { id: 'w10', title: '第10周作业', start: '2026-11-02', end: '2026-11-06', items: [{ subject: '语文', tasks: [{ text: '背诵' }] }] },
  { id: 'w10we', title: '第10周周末作业', start: '2026-11-07', end: '2026-11-08', items: [{ subject: '数学', tasks: [{ text: '试卷一张' }] }] },
  { id: 'w11', title: '第11周作业', start: '2026-11-09', end: '2026-11-13', items: [{ subject: '英语', tasks: [{ text: '单词默写' }] }] },
  { id: 'w11we', title: '第11周周末作业', start: '2026-11-14', end: '2026-11-15', items: [{ subject: '物理', tasks: [{ text: '练习册' }] }] },
];
const mkDay = (date, names, wd) => ({ date, wd, anyOn: false, items: names.map((n, i) => ({ id: date + '_' + i, name: n, start: '08:20', end: '10:20', pin: false })) });
const EXAMS = {
  ok: true, today, base: '', title: '高二', cls: '',
  groups: [
    { id: 'g11', name: '第11周周末限时训练', start: '2026-11-14', end: '2026-11-15', auto: false, count: 5, days: [mkDay('2026-11-14', ['数学', '物理', '化学', '语文'], '六'), mkDay('2026-11-15', ['生物'], '日')] },
    { id: 'g10', name: '第10周周测', start: '2026-11-05', end: '2026-11-05', auto: false, count: 1, days: [mkDay('2026-11-05', ['数学'], '四')] },
    { id: 'g11w', name: '第11周随堂测', start: '2026-11-11', end: '2026-11-11', auto: false, count: 1, days: [mkDay('2026-11-11', ['英语'], '三')] },
  ],
  pins: { majors: [], days: [], items: [] },
  term: { name: '高二上', start: '2026-09-01', end: '2027-01-31' },
};

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

async function open(hws, edit) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('  [pageerror]', e.message));
  await p.route('**/api/**', r => {
    const u = r.request().url();
    const J = o => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.includes('/api/island')) return J({ ok: true, data: ISL });
    if (u.includes('/api/content')) return J({ ok: true, items: { holiday_homeworks: hws, announcements: [] } });
    if (u.includes('/auth?action=me')) return J({ ok: true, user: { id: 4, username: 'aibot', displayName: 'AI', role: 'admin', status: 'active' } });
    if (u.includes('/api/exams')) return J(EXAMS);
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
  await p.evaluate((ed) => {
    window.isAdmin = () => true;
    ['popMask', 'loginGuideMask'].forEach(id => { const e = document.getElementById(id); if (e) e.remove(); });
    if (ed) localStorage.setItem('cls_hw_edit', '1');
    BIG.openHw();
  }, !!edit);
  await p.waitForTimeout(1700);
  return { ctx, p };
}
const examText = p => p.evaluate(() => document.getElementById('bhwExam')?.innerText.replace(/\n+/g, ' | ') || '');
const cards = p => p.evaluate(() => {
  BIG.layoutCards();
  const nm = e => { const h = e.querySelector('.bhw-subj-h'); if (!h) return '空态'; const i = h.querySelector('input'); return String((i ? i.value : (h.querySelector('b') || {}).textContent) || '?').trim(); };
  const list = id => [...document.getElementById(id).children].filter(e => e.classList && e.classList.contains('bhw-subj'));
  const A = list('bhwColA'), B = list('bhwColB');
  const sum = a => a.reduce((s, e) => s + e.getBoundingClientRect().height, 0);
  const exam = document.getElementById('bhwExam');
  return {
    A: A.map(nm), B: B.map(nm),
    hA: Math.round(sum(A) + (exam ? exam.getBoundingClientRect().height : 0)),
    hB: Math.round(sum(B)),
  };
});

// ---------- A：今天有考试，自动显示 ----------
console.log('\n① 今天有考试是否自动出现');
{
  const { ctx, p } = await open(HWS);
  let t = await examText(p);
  ok('今天这一期显示「第11周周末限时训练」', t.indexOf('第11周周末限时训练') >= 0, t.slice(0, 80));
  ok('今天的数学/物理/化学/语文四科都在', t.indexOf('数学') >= 0 && t.indexOf('物理') >= 0 && t.indexOf('化学') >= 0 && t.indexOf('语文') >= 0, t);
  ok('明天的生物也在', t.indexOf('生物') >= 0, t);
  ok('没有出现上一期的周测', t.indexOf('第10周周测') < 0, t);

  // ---------- B：翻到上一周期次 ----------
  console.log('\n② 翻到上一期作业');
  await p.evaluate(() => BIG.hwJumpTo('2026-11-04'));
  await p.waitForTimeout(1200);
  t = await examText(p);
  ok('显示第10周周测', t.indexOf('第10周周测') >= 0, t.slice(0, 80));
  ok('不再显示第11周周末训练', t.indexOf('第11周周末限时训练') < 0, t);

  console.log('\n③ 翻到再上一周的周末（那期没有考试）');
  await p.evaluate(() => BIG.hwJumpTo('2026-11-08'));
  await p.waitForTimeout(1000);
  t = await examText(p);
  ok('没有考试时整块隐藏，不留空盒', t === '', t);

  console.log('\n④ 翻到第11周工作日');
  await p.evaluate(() => BIG.hwJumpTo('2026-11-11'));
  await p.waitForTimeout(1000);
  t = await examText(p);
  ok('显示第11周随堂测', t.indexOf('第11周随堂测') >= 0, t);
  ok('不显示周末那场', t.indexOf('第11周周末限时训练') < 0, t);

  console.log('\n⑤ 考试弹窗默认档位');
  await p.evaluate(() => BIG.examPanel());
  await p.waitForTimeout(700);
  ok('默认停在「本期」', await p.evaluate(() => BIG.examScope) === 'cur', await p.evaluate(() => BIG.examScope));
  ok('标签栏有「本期」并高亮', await p.evaluate(() => !!document.querySelector('#bexTabs .bex-tab.on')));
  ok('一键按钮文案是「＋本期」', await p.evaluate(() => (document.getElementById('bexBulk') || {}).textContent || '') === '＋本期');
  await p.evaluate(() => BIG.examPanelClose());
  await ctx.close();
}

// ---------- F：今天完全没有作业 ----------
console.log('\n⑥ 今天没有任何作业');
{
  const { ctx, p } = await open([]);
  const t = await examText(p);
  ok('考试块照样显示今天的考试', t.indexOf('第11周周末限时训练') >= 0, t.slice(0, 80));
  ok('作业区是空态', (await p.evaluate(() => !!document.querySelector('#bhwColA .bhw-empty'))));
  await p.screenshot({ path: '/workspace/classsite-v4157/exam-no-hw.png' });
  await ctx.close();
}

// ---------- G：逐科添加 → 两栏按顺序切分 ----------
console.log('\n⑦ 逐科添加作业分两栏');
{
  const { ctx, p } = await open([], true);
  for (const s of ['语文', '数学', '英语', '物理', '化学', '生物']) {
    await p.evaluate(n => BIG.hwQuickSubj(n), s);
    await p.waitForTimeout(800);
  }
  const c = await cards(p);
  ok('六科都在，一个没丢', [...c.A, ...c.B].length === 6, c);
  ok('两栏都排到了卡片（没有全挤一栏）', c.A.length >= 1 && c.B.length >= 1, c);
  ok('科目顺序不断开（语文→数学→英语→物理→化学→生物）', c.A.concat(c.B).join(',') === '语文,数学,英语,物理,化学,生物', c);
  ok('两栏高度接近（差额不超过一张卡）', Math.abs(c.hA - c.hB) <= 220, { hA: c.hA, hB: c.hB });
  await p.screenshot({ path: '/workspace/classsite-v4157/split-6subj.png' });

  // 四科时 2/2
  const { ctx: c2, p: p2 } = await open([], true);
  for (const s of ['语文', '数学', '英语', '物理']) {
    await p2.evaluate(n => BIG.hwQuickSubj(n), s);
    await p2.waitForTimeout(700);
  }
  const d = await cards(p2);
  ok('四科时也分成两栏', d.A.length >= 1 && d.B.length >= 1, d);
  ok('四科时顺序不断开', d.A.concat(d.B).join(',') === '语文,数学,英语,物理', d);
  ok('四科时两栏高度接近', Math.abs(d.hA - d.hB) <= 220, { hA: d.hA, hB: d.hB });
  await c2.close();
  await ctx.close();
}

await browser.close();
console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败');
process.exit(fail ? 1 : 0);
