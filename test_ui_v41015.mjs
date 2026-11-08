/* v4.10.15 专项：作业期次按学期自动按周生成 + 设置本周范围 + 底部七个科目按钮 */
import { chromium } from 'playwright-core';

const BASE = 'http://localhost:8111';
const CHROME = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
};

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

async function openHw(clockISO) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  if (clockISO) await page.clock.install({ time: new Date(clockISO) });
  await page.route('**/api/**', (r) => {
    const u = r.request().url();
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.includes('/api/exams')) return J({ ok: true, at: Date.now(), today: '2026-11-04', groups: [], items: [], pins: { majors: [], days: [], items: [] } });
    if (u.includes('/api/island')) return J({ ok: true, data: { on: true, startDate: '2026-09-01', endDate: '2027-01-30', enrollDate: '2025-09-01', term: '高二上', holidays: [] } });
    if (u.includes('/auth?action=me')) return J({ ok: true, user: { username: 'aibot', role: 'admin' } });
    if (u.includes('/api/content')) return J({ ok: true, items: { holiday_homeworks: [], announcements: [] } });
    return J({ ok: true });
  });
  await page.goto(BASE + '/index.html?big=1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    AUTH.user = { username: 'aibot', role: 'admin' };
    try { closeLoginGuide(false); } catch (e) {}
    const g = document.getElementById('loginGuideMask'); if (g) g.style.display = 'none';
    BIG.openHw();
  });
  await page.waitForTimeout(700);
  return { ctx, page, errs };
}

/* ① 周次与期次名 */
{
  const { ctx, page, errs } = await openHw('2026-11-04T10:00:00');
  const r = await page.evaluate(() => {
    const h = BIG.ensurePeriod(new Date(2026, 10, 4));
    const w = BIG.weekOf(new Date(2026, 10, 4));
    return { id: h.id, title: h.title, start: h.start, end: h.end, auto: !!h._auto, no: w.no };
  });
  t('11/4 落在第 10 周作业', r.no === 10 && /第10周作业$/.test(r.title), JSON.stringify(r));
  t('第 10 周作业默认周一 ~ 周五（11/2–11/6）', r.start === '2026-11-02' && r.end === '2026-11-06', JSON.stringify(r));
  t('期次名带学期前缀「高二上 · 」', r.title === '高二上 · 第10周作业', r.title);
  t('自动期次是内存里的（_auto）', r.auto === true, String(r.auto));

  const we = await page.evaluate(() => {
    const h = BIG.ensurePeriod(new Date(2026, 10, 8));
    return { id: h.id, title: h.title, start: h.start, end: h.end };
  });
  t('11/8 落到周末作业，范围周六 ~ 周日', we.id === 'w2026-11-02we' && we.start === '2026-11-07' && we.end === '2026-11-08', JSON.stringify(we));

  const store0 = await page.evaluate(() => localStorage.getItem('cls_hw_local_v1'));
  t('只看不改时不落库（空壳不存）', store0 === null, String(store0));

  const act = await page.evaluate(() => document.getElementById('bhwActions').innerText.replace(/\n+/g, '|'));
  t('顶栏没有「新建一期」', !/新建一期/.test(act), act);
  t('进编辑态后顶栏有「设置」', await page.evaluate(async () => {
    BIG.hwEditToggle();
    await new Promise((r) => setTimeout(r, 400));
    return /设置/.test(document.getElementById('bhwActions').innerText);
  }), act);

  const btns = await page.evaluate(() => [...document.querySelectorAll('#bhwAddSubj .bhw-subjbtn')].map((b) => b.textContent.trim()));
  t('底部正好七个科目按钮', btns.length === 7 && btns.join('/') === '语文/数学/英语/物理/化学/生物/其他', JSON.stringify(btns));

  await page.evaluate(() => { [...document.querySelectorAll('#bhwAddSubj .bhw-subjbtn')].find((b) => b.textContent.trim() === '语文').click(); });
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => {
    const h = BIG.ensurePeriod(new Date(2026, 10, 4));
    const raw = JSON.parse(localStorage.getItem('cls_hw_local_v1') || 'null');
    const btn = [...document.querySelectorAll('#bhwAddSubj .bhw-subjbtn')].find((b) => b.textContent.trim() === '语文');
    return { items: (h.items || []).map((i) => i.subject), stored: raw ? raw.list.map((x) => x.id) : null, gray: btn.classList.contains('has') };
  });
  t('点一下语文就在这一期建卡', after.items.indexOf('语文') >= 0, JSON.stringify(after.items));
  t('建卡之后自动收进列表并落库', !!after.stored && after.stored.indexOf('w2026-11-02') >= 0, JSON.stringify(after.stored));
  t('已经加过的科目按钮置灰', after.gray === true, String(after.gray));

  t('无 JS 报错', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ② 设置：把这一周推到周六 */
{
  const { ctx, page, errs } = await openHw('2026-11-04T10:00:00');
  await page.evaluate(async () => {
    BIG.hwEditToggle();
    await new Promise((r) => setTimeout(r, 300));
    BIG.hwWeekSetting();
  });
  await page.waitForTimeout(400);
  const f = await page.evaluate(() => ({
    open: document.getElementById('bhwFormMask').className.indexOf('show') >= 0,
    title: document.getElementById('bhwFormTitle').textContent,
    start: document.getElementById('bhwFormStart').value,
    end: document.getElementById('bhwFormEnd').value,
    nameHidden: getComputedStyle(document.getElementById('bhwFormName')).display === 'none',
  }));
  t('「设置」打开的是这一周的范围', f.open && /第10周作业/.test(f.title), JSON.stringify(f));
  t('设置里只有两个日期，不显示名称输入', f.nameHidden && f.start === '2026-11-02' && f.end === '2026-11-06', JSON.stringify(f));

  await page.evaluate(() => {
    document.getElementById('bhwFormEnd').value = '2026-11-07';
    BIG.formSave();
  });
  await page.waitForTimeout(700);
  const g = await page.evaluate(() => {
    const wk = BIG.ensurePeriod(new Date(2026, 10, 4));
    const we = BIG.ensurePeriod(new Date(2026, 10, 8));
    return { wk: { s: wk.start, e: wk.end }, we: we ? { s: we.start, e: we.end } : null };
  });
  t('这一周改到周六（11/2–11/7）', g.wk.s === '2026-11-02' && g.wk.e === '2026-11-07', JSON.stringify(g.wk));
  t('周末作业自动缩成只剩周日', g.we && g.we.s === '2026-11-08' && g.we.e === '2026-11-08', JSON.stringify(g.we));
  t('设置流程无 JS 报错', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

await browser.close();
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
