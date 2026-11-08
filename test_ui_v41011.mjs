/* v4.10.11 专项：倒计时按本机时间实时走、导出图配图归位、作业卡片 1/3 与 2/3 分栏 */
import { chromium } from '/root/.nvm/versions/node/v22.13.1/lib/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const BASE = 'http://localhost:8112';
let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
};
const pad = (n) => (n < 10 ? '0' : '') + n;
const dstr = (off) => {
  const d = new Date(Date.now() + off * 86400000);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};
const T = dstr(0);

/* 一张 600×300 的测试图（红底），data URL 同源可直接画进 canvas */
const PNG = 'data:image/png;base64,' + fs.readFileSync('/tmp/shots/_t.png').toString('base64');

const HW = {
  id: 'hw11', title: '第11周作业', start: dstr(-6), end: dstr(6),
  items: [
    { subject: '语文', tasks: [{ text: '背诵《赤壁赋》全文' }, { text: '实词整理' }] },
    { subject: '数学', tasks: [{ text: '必刷题 P45–P48' }, { text: '错题本第 12 套' }] },
    { subject: '英语', tasks: [
      { text: 'Unit 4 单词默写' },
      { text: '完成语法填空专项训练（第 3 套），并把错题抄到积累本上，标注每道题的考点与出处与编号', img: PNG },
      { text: '听力训练 15 分钟' },
    ] },
    { subject: '物理', tasks: [{ text: '练习册 P30' }] },
    { subject: '化学', tasks: [{ text: '整理氧化还原反应方程式的配平方法，把课本上的八个例子全部重写一遍并标注电子转移方向与数目' }] },
    { subject: '生物', tasks: [{ text: '第三章思维导图' }, { text: '课后习题 1–5' }] },
  ],
};

function mkRoute(page) {
  return page.route('**/api/**', (route) => {
    const u = route.request().url();
    const J = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.includes('/api/exams')) {
      if (u.includes('action=state')) return J({ ok: true, cfg: { base: 'x', classId: '', className: '5班' }, pins: {}, kv: true, classes: [], data: null });
      return J({ ok: true, at: Date.now(), today: T, groups: [], items: [], pins: { majors: [], days: [], items: [] } });
    }
    if (u.includes('/api/island')) {
      return J({ ok: true, data: { on: true, startDate: '2026-09-01', endDate: '2027-01-30',
        enrollDate: '2025-09-01', term: '高二上', holidays: [] } });
    }
    if (u.includes('/auth?action=me')) return J({ ok: true, user: { username: 'aibot', role: 'admin' } });
    if (u.includes('/api/content')) return J({ ok: true, items: { holiday_homeworks: [HW], announcements: [] } });
    return J({ ok: true });
  });
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });

/* ① 分栏 1/3 与 2/3 */
{
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { fail++; console.log('  ✗ [pageerror] ' + e.message); });
  await page.addInitScript(() => {
    localStorage.setItem('cls_bigscreen', '1');
    localStorage.setItem('cls_welcome_v1', '1');
    localStorage.setItem('cls_login_guide_v1', '1');
    localStorage.setItem('cls_auth', JSON.stringify({ token: 'T', user: { username: 'aibot', role: 'admin' } }));
  });
  await mkRoute(page);
  await page.goto(BASE + '/index.html?_r=' + Date.now() + '#/hw', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3800);

  const r = await page.evaluate(() => {
    const A = document.getElementById('bhwColA'), B = document.getElementById('bhwColB');
    const nm = (el) => { const b = el.querySelector('.bhw-subj-h b'); return b ? b.textContent.trim() : '?'; };
    return {
      wa: Math.round(A.getBoundingClientRect().width),
      wb: Math.round(B.getBoundingClientRect().width),
      a: [...A.children].filter((e) => e.classList.contains('bhw-subj')).map(nm),
      b: [...B.children].filter((e) => e.classList.contains('bhw-subj')).map(nm),
    };
  });
  t('左栏宽约为右栏的一半（1 : 2）', Math.abs(r.wb / r.wa - 2) < 0.08, r.wa + ' : ' + r.wb);
  t('短文本科目留在左 1/3 栏', r.a.includes('语文') && r.a.includes('物理'), JSON.stringify(r.a));
  t('长文本科目进右 2/3 栏', r.b.includes('英语') && r.b.includes('化学'), JSON.stringify(r.b));
  t('左栏按科目顺序排（不乱跳）', JSON.stringify(r.a) === JSON.stringify(['语文', '数学', '物理', '生物']), JSON.stringify(r.a));

  /* ② 导出图：配图挂在对应那一项上 */
  await page.evaluate(() => { try { hwExportImage('download'); } catch (e) {} });
  await page.waitForTimeout(4200);
  const ex = await page.evaluate(() => {
    const E = window.EX;
    if (!E || !E.card) return { missing: true };
    const en = (E.card.sections || []).find((s) => s.heading === '英语');
    if (!en) return { missing: true };
    return {
      rowMedia: (en.rows || []).map((x) => (x.media || []).length),
      secMedia: (en.media || []).length,
      cv: !!document.querySelector('#exStage canvas'),
      h: document.querySelector('#exStage canvas') ? document.querySelector('#exStage canvas').height : 0,
    };
  });
  t('英语第 2 项自带 1 张图、第 1/3 项没有', ex.rowMedia && ex.rowMedia[0] === 0 && ex.rowMedia[1] === 1 && ex.rowMedia[2] === 0, JSON.stringify(ex.rowMedia));
  t('科目级 media 已清空（不再统一堆到科尾）', ex.secMedia === 0, String(ex.secMedia));
  t('导出预览真的画出来了', ex.cv === true, 'h=' + ex.h);

  /* ③ 倒计时：把最近一条重要日期设成 70 秒后，看它自己走 */
  const v0 = await page.evaluate(() => {
    window.IMPORTANT_DATES.length = 0;
    const d = new Date(Date.now() + 70000);
    window.IMPORTANT_DATES.push({ name: '测试倒计时',
      date: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
        + 'T' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0') });
    window.BIG.renderCd();
    const v = document.querySelector('#bhwCd .bhw-cd-v');
    return v ? v.textContent.trim() : '(无)';
  });
  await page.waitForTimeout(15000);
  const v1 = await page.evaluate(() => {
    const v = document.querySelector('#bhwCd .bhw-cd-v');
    return v ? v.textContent.trim() : '(无)';
  });
  t('倒计时开屏是「1 分」', v0 === '1 分', v0);
  t('15 秒后自己走到「不到 1 分」（没有重新请求接口）', v1 === '不到 1 分', v1);

  /* ④ 每 30 秒一次整块重建是设计内的兜底（跨天换条），这条留给端到端断言去管；
        这里只确认倒计时块本身没被 tick 弄丢 */
  const alive = await page.evaluate(() => !!document.querySelector('#bhwCd .bhw-cd-v'));
  t('倒计时块在连续 tick 后仍在页面上', alive);

  await ctx.close();
}

/* ⑤ 班级岛：islandTick 已改成 1 秒，且带假期文本热更新 */
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('cls_welcome_v1', '1');
    localStorage.setItem('cls_login_guide_v1', '1');
  });
  await page.route('**/api/**', (route) => {
    const u = route.request().url();
    const J = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.includes('/api/island')) {
      const now = new Date();
      const to = new Date(Date.now() + 130000);
      return J({ ok: true, data: { on: true, startDate: '2026-09-01', endDate: '2027-01-30',
        enrollDate: '2025-09-01', term: '高二上',
        holidays: [{ from: T, to: T, fromTime: '06:00',
          toTime: String(to.getHours()).padStart(2, '0') + ':' + String(to.getMinutes()).padStart(2, '0'),
          label: '月假' }], courses: [], days: {} } });
    }
    if (u.includes('/auth?action=me')) return J({ ok: true, user: null });
    if (u.includes('/api/content')) return J({ ok: true, items: { announcements: [] } });
    return J({ ok: true });
  });
  await page.goto(BASE + '/index.html?_r=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3600);
  const has = await page.evaluate(() => !!document.getElementById('islHolTxt') && typeof window.islHolTick === 'function');
  t('班级岛假期横幅有独立文本节点、有热更新函数', has);
  /* 直接数调用次数：islandTick 每秒调一次 islHolTick 才叫「按本机时间实时走」 */
  const n = await page.evaluate(async () => {
    let c = 0;
    const orig = window.islHolTick;
    window.islHolTick = function () { c++; return orig.apply(this, arguments); };
    await new Promise((r) => setTimeout(r, 5200));
    window.islHolTick = orig;
    return c;
  });
  t('班级岛倒计时 5 秒内被刷了 4 次以上（每秒一次）', n >= 4, 'tick=' + n);
  await ctx.close();
}

await browser.close();
console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
