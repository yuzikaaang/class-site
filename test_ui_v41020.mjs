/* v4.10.20 专项：日期条默认收起 / 字号归整 / 空期次不落库 / 导出图片批量选择。
   跑法：本地 8111 静态服务 → node test_ui_v41020.mjs */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = 'http://localhost:8111';
const CHROME = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const OUT = '/workspace/classsite-v41020';
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
};

/* 两份期次：一份当前、一份上一周 —— 触发「多期批量选择」弹层 */
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
/* 空期次：有科目但科目里没内容 —— 应该被过滤掉，不出现在导出清单里 */
const EMPTY = { id: 'w2026-11-16', title: '高二上 · 第12周作业', start: '2026-11-16', end: '2026-11-20',
  items: [{ subject: '化学', tasks: [{ text: '' }] }] };

const EXAMS = {
  ok: true, at: Date.now(), today: '2026-11-09', title: '2026 高二上第二次段考', cls: '5班',
  base: 'https://examboard.dpdns.org', groups: [], items: [], pins: { majors: [], days: [], items: [] }, pinAt: 0,
  term: { name: '2026 年秋季 · 高二上', start: '2026-09-01', end: '2027-01-30' }, cached: false, stale: false
};

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

function mock(page, hwList) {
  return page.route('**/api/**', (r) => {
    const u = r.request().url();
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.includes('/api/exams')) return J(EXAMS);
    if (u.includes('/api/island')) return J({ ok: true, data: { on: true, startDate: '2026-09-01', endDate: '2027-01-30', enrollDate: '2025-09-01', term: '高二上', holidays: [] } });
    if (u.includes('/auth?action=me')) return J({ ok: true, user: { username: 'aibot', role: 'admin' } });
    if (u.includes('/api/content')) return J({ ok: true, items: { holiday_homeworks: hwList, announcements: [] } });
    if (u.includes('/boards?action=ensure-link')) return J({ ok: true, url: 'https://yuzikaaang.github.io/class-site/?board=hw' });
    return J({ ok: true });
  });
}

/* ============ A. 大屏：日期条默认收起 + 字号归整 + 空期次不落库 ============ */
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await mock(page, HW.concat([EMPTY]));
  await page.goto(BASE + '/index.html?big=1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.evaluate((hw) => {
    AUTH.user = { username: 'aibot', role: 'admin' };
    SITE_DATA.holidayHomeworks = hw;
    try { closeLoginGuide(false); } catch (e) {}
    const g = document.getElementById('loginGuideMask'); if (g) g.style.display = 'none';
    BIG.openHw();
  }, HW.concat([EMPTY]));
  await page.waitForTimeout(800);

  /* ① 日期条默认收起 */
  const folded = await page.evaluate(() => document.documentElement.classList.contains('bhw-ds-fold'));
  t('① 日期条默认收起（首次进入 html 带 bhw-ds-fold）', folded === true);

  /* ② 点「日期」展开，再收起 */
  await page.evaluate(() => BIG.dsToggle());
  const expanded = await page.evaluate(() => !document.documentElement.classList.contains('bhw-ds-fold'));
  t('② 点「日期」后日期条展开', expanded === true);
  await page.evaluate(() => BIG.dsToggle());
  const refolded = await page.evaluate(() => document.documentElement.classList.contains('bhw-ds-fold'));
  t('③ 再点一次又能收起', refolded === true);

  /* ④ 字号归整：非 5 倍数先归到最近的 5 的倍数 */
  const fs = await page.evaluate(() => {
    BIG.fs = 103; BIG.fsStep(1); const a = BIG.fs;
    BIG.fs = 103; BIG.fsStep(-1); const b = BIG.fs;
    BIG.fs = 100; BIG.fsStep(1); const c = BIG.fs;
    return { a, b, c };
  });
  t('④ 字号归整（103 → 加=105、减=100；100 → 加=105）',
    fs.a === 105 && fs.b === 100 && fs.c === 105, JSON.stringify(fs));

  /* ⑤ 空期次不落库：没内容的期次 hwPeriodEmpty 为真、有内容的为假 */
  const isEmpty = await page.evaluate(() => {
    const empty = { items: [{ subject: '化学', tasks: [{ text: '' }] }] };
    const full = { items: [{ subject: '语文', tasks: [{ text: '背课文' }] }] };
    return { empty: typeof hwPeriodEmpty === 'function' ? hwPeriodEmpty(empty) : null,
             full: typeof hwPeriodEmpty === 'function' ? hwPeriodEmpty(full) : null };
  });
  t('⑤ 空期次判定（没内容=空、有内容=非空）', isEmpty.empty === true && isEmpty.full === false, JSON.stringify(isEmpty));

  t('⑥ 大屏无 JS 报错', errs.length === 0, errs.join(' | ').slice(0, 160));
  await page.screenshot({ path: OUT + '/01-日期条默认收起.png', fullPage: false });
  await ctx.close();
}

/* ============ B. 普通模式：导出图片批量选择 ============ */
{
  const ctx = await browser.newContext({ viewport: { width: 420, height: 860 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.clock.install({ time: new Date('2026-11-09T10:00:00') });
  await mock(page, HW.concat([EMPTY]));
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  await page.evaluate((hw) => {
    AUTH.user = { username: 'aibot', role: 'admin' };
    SITE_DATA.holidayHomeworks = hw;
    try { closeLoginGuide(false); } catch (e) {}
    const g = document.getElementById('loginGuideMask'); if (g) g.style.display = 'none';
    showCurrentHomework();
  }, HW.concat([EMPTY]));
  await page.waitForTimeout(600);

  /* ⑦ 点「导出图片」弹出多期选择层（空期次被过滤，只剩 2 份） */
  await page.evaluate(() => hwExportImage('download'));
  await page.waitForTimeout(400);
  const pickInfo = await page.evaluate(() => {
    const mask = document.getElementById('hwExPickMask');
    const cbs = mask ? Array.prototype.slice.call(mask.querySelectorAll('[data-hw-exidx]')) : [];
    const periods = hwExportPeriods();
    const vid = String((window.__HW_VIEWING && window.__HW_VIEWING.id) || '');
    let checkedN = 0, checkedIdx = -1;
    cbs.forEach((cb, i) => { if (cb.checked) { checkedN++; checkedIdx = i; } });
    const expectIdx = periods.findIndex((p) => String(p.id) === vid);
    return { shown: !!mask, n: cbs.length, checkedN, checkedIdx, expectIdx,
             checked: cbs.map((c) => c.checked), vid };
  });
  t('⑦ 导出弹多期选择层，且空期次被过滤（2 份，不是 3 份）', pickInfo.shown && pickInfo.n === 2, JSON.stringify(pickInfo));
  t('⑧ 默认只勾选「正在看的那一期」', pickInfo.checkedN === 1 && pickInfo.checkedIdx === pickInfo.expectIdx, JSON.stringify(pickInfo));

  /* ⑨ 全选 / 全不选 */
  await page.evaluate(() => {
    const b = document.querySelector('#hwExPickMask [data-hw-exall="1"]'); if (b) b.click();
  });
  const allOn = await page.evaluate(() =>
    Array.prototype.every.call(document.querySelectorAll('#hwExPickMask [data-hw-exidx]'), (c) => c.checked));
  t('⑨ 点「全选」两份都勾上', allOn === true);
  await page.evaluate(() => {
    const b = document.querySelector('#hwExPickMask [data-hw-exall="0"]'); if (b) b.click();
  });
  const allOff = await page.evaluate(() =>
    Array.prototype.every.call(document.querySelectorAll('#hwExPickMask [data-hw-exidx]'), (c) => !c.checked));
  t('⑩ 点「全不选」两份都取消', allOff === true);

  /* ⑪ 勾上两份点「导出图片」→ 打开预览（合一张长图） */
  await page.evaluate(() => {
    Array.prototype.forEach.call(document.querySelectorAll('#hwExPickMask [data-hw-exidx]'), (c) => { c.checked = true; });
    const go = document.getElementById('hwExPickGo'); if (go) go.click();
  });
  await page.waitForTimeout(1600);
  const preview = await page.evaluate(() => {
    const mask = document.getElementById('exMask');
    return { shown: mask ? mask.classList.contains('show') : false };
  });
  t('⑪ 确认后打开导出预览（合并长图）', preview.shown === true, JSON.stringify(preview));

  t('⑫ 普通模式无 JS 报错', errs.length === 0, errs.join(' | ').slice(0, 160));
  await page.screenshot({ path: OUT + '/02-导出批量选择.png', fullPage: false });
  await ctx.close();
}

await browser.close();
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
