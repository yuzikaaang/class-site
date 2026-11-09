/* v4.10.26 专项：
   ① 大屏作业页：点「编辑」后，学科预选栏出现但右侧功能栏顶端不动
   ② 任何字号 / 编辑态下，右侧功能栏最底那块（离高中还有多久）都完整落在工具栏上方
   ③ 刷新后侧边栏当前板块仍然高亮
   ④ 全屏按钮按「当前真的是不是全屏」写字
   ⑤ 班级岛「几点后看明日事项」可改，大屏作业页跟着变；今日事项可点开照片
   ⑥ 窄屏（单列）右侧功能栏回到文档流，不锁高度 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const SITE = process.env.CLS_SITE || 'http://localhost:8111/index.html';
const CH = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const OUT = '/workspace/classsite-v41026/';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const t = (n, ok, x) => {
  if (ok) { pass++; console.log('  ✓ ' + n + (x ? '  [' + x + ']' : '')); }
  else { fail++; console.log('  ✗ ' + n + (x ? '  [' + x + ']' : '')); }
};

const HW = [{
  id: 'w2026-11-09', title: '高二上 · 第11周作业', start: '2026-11-09', end: '2026-11-13',
  items: [
    { subject: '语文', tasks: [{ text: '背诵《赤壁赋》并默写' }, { text: '作文素材积累 3 页' }] },
    { subject: '数学', tasks: [{ text: '练习册 P45 全部' }] },
    { subject: '英语', tasks: [{ text: '背 Unit 3 单词' }] },
    { subject: '物理', tasks: [{ text: '电场专题卷' }] },
    { subject: '化学', tasks: [{ text: '离子反应练习' }] },
    { subject: '生物', tasks: [{ text: '遗传题 10 道' }] },
  ],
}];
const EXAMS = { ok: true, at: Date.now(), today: '2026-11-09', title: '期中考试', cls: '5班', base: '', groups: [], items: [], pins: { majors: [], days: [], items: [] }, term: { name: '2026 年秋季 · 高二上', start: '2026-09-01', end: '2027-01-30' }, cached: false, stale: false };
const ISLAND = {
  on: true, startDate: '2026-09-01', endDate: '2027-01-30', enrollDate: '2025-09-01',
  term: '2026 年秋季 · 高二上', holidays: [], nightFrom: '21:00',
  photo: 'https://example.com/photo.png',
  banner: { mon: '语文 数学', tue: '英语 物理', wed: '化学 生物', thu: '', fri: '', sat: '', sun: '' },
  days: {},
};

function mock(page, island) {
  return page.route('**/api/**', (r) => {
    const u = r.request().url();
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.includes('/api/exams')) return J(EXAMS);
    if (u.includes('/api/island')) return J({ ok: true, data: island });
    if (u.includes('/auth?action=me')) return J({ ok: true, user: { username: 'aibot', role: 'admin' } });
    if (u.includes('/api/content')) return J({ ok: true, items: { holiday_homeworks: HW, announcements: [] } });
    return J({ ok: true });
  });
}
const hhmm = (d) => ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
const now = new Date();
const before = new Date(now.getTime() - 2 * 60000);
const after = new Date(now.getTime() + 60 * 60000);

const browser = await chromium.launch({ executablePath: CH, args: ['--no-sandbox'] });

/* ============ A. 1366×768：编辑不动右栏 + 全内容可见 ============ */
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  await mock(page, ISLAND);
  await page.goto(SITE.replace('index.html', 'index.html?big=1'), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1600);
  await page.evaluate((HW) => {
    AUTH.user = { username: 'aibot', role: 'admin' };
    SITE_DATA.holidayHomeworks = HW;
    try { closeLoginGuide(false); } catch (e) {}
    const g = document.getElementById('loginGuideMask'); if (g) g.style.display = 'none';
    BIG.openHw();
  }, HW);
  await page.waitForTimeout(900);

  const geom = () => page.evaluate(() => {
    const side = document.getElementById('bhwSide');
    const grid = document.querySelector('.bhw-grid');
    const prog = document.getElementById('bhwProg');
    const bar = document.querySelector('.bhw-bar');
    const sr = side.getBoundingClientRect();
    const pr = prog.getBoundingClientRect();
    return {
      sideTop: Math.round(sr.top), gridTop: Math.round(grid.getBoundingClientRect().top),
      sideBottom: Math.round(sr.bottom), progBottom: Math.round(pr.bottom),
      barTop: Math.round(bar.getBoundingClientRect().top),
      addH: Math.round(document.getElementById('bhwAddSubj').getBoundingClientRect().height),
      scale: BIG._sideScale,
    };
  });

  const pre = await geom();
  t('① 只读态：右栏顶端与作业网格对齐', pre.sideTop === pre.gridTop, JSON.stringify(pre));

  await page.evaluate(() => BIG.hwEditToggle());
  await page.waitForTimeout(700);
  const edit = await geom();
  t('② 点编辑后出现学科预选栏', edit.addH > 20, 'addH=' + edit.addH);
  t('③ 学科预选栏不把右栏顶下去（顶端不动）',
    edit.sideTop === pre.sideTop && edit.sideTop === edit.gridTop, JSON.stringify({ pre: pre.sideTop, edit: edit.sideTop, grid: edit.gridTop }));
  t('④ 右栏最底一块完整落在工具栏上方',
    edit.progBottom <= edit.barTop + 1 && edit.sideBottom <= edit.barTop + 1,
    'progBottom=' + edit.progBottom + ' barTop=' + edit.barTop);
  await page.screenshot({ path: OUT + '01-1366-编辑.png' });

  await page.evaluate(() => BIG.fsSet(150));
  await page.waitForTimeout(700);
  const big = await geom();
  t('⑤ 字号 150% + 编辑态仍然全部可见',
    big.progBottom <= big.barTop + 1 && big.sideTop === pre.sideTop, JSON.stringify(big));
  await page.screenshot({ path: OUT + '02-1366-编辑-字号150.png' });

  /* 全屏按钮：伪造「窗口满屏」 */
  const fsBtn = await page.evaluate(() => {
    try { Object.defineProperty(window.screen, 'height', { value: window.innerHeight, configurable: true }); } catch (e) {}
    BIG.renderHw();
    return document.getElementById('bhwFullBtn').textContent;
  });
  t('⑥ 窗口满屏时按钮写「退出全屏」', /退出全屏/.test(fsBtn), fsBtn);
  const fsBtn2 = await page.evaluate(() => {
    try { Object.defineProperty(window.screen, 'height', { value: window.innerHeight + 300, configurable: true }); } catch (e) {}
    BIG.renderHw();
    return document.getElementById('bhwFullBtn').textContent;
  });
  t('⑦ 非全屏时按钮写「全屏」', /^⛶ 全屏$/.test(fsBtn2.trim()), fsBtn2);

  /* 明日事项时刻：改成 1 分钟前 → 一定看明天；改成 1 小时后 → 一定看今天 */
  await page.evaluate((v) => { ISLAND.nightFrom = v; BIG.renderHw(); }, hhmm(before));
  await page.waitForTimeout(500);
  const tomorrow = await page.evaluate(() => ({
    k: (document.querySelector('#bhwCourses .bhw-mini-k') || {}).textContent,
    v: (document.querySelector('#bhwCourses .bhw-mini-v') || {}).textContent,
  }));
  t('⑧ 时刻设成刚刚过去 → 右栏显示「明日事项」', tomorrow.k === '明日事项' && !!tomorrow.v, JSON.stringify(tomorrow));

  await page.evaluate((v) => { ISLAND.nightFrom = v; BIG.renderHw(); }, hhmm(after));
  await page.waitForTimeout(500);
  const today = await page.evaluate(() => ({
    k: (document.querySelector('#bhwCourses .bhw-mini-k') || {}).textContent,
  }));
  t('⑨ 时刻设到一小时后 → 右栏回到「今日事项」', today.k === '今日事项', today.k);

  /* 点今日事项看照片（同一个弹层） */
  await page.evaluate(() => {
    const c = document.getElementById('bhwCourses');
    c.scrollIntoView({ block: 'center' });
    c.click();
  });
  await page.waitForTimeout(400);
  const photo = await page.evaluate(() => document.getElementById('islPhotoMask').classList.contains('show'));
  t('⑩ 点右栏今日事项能打开照片弹层', photo === true);
  await page.evaluate(() => { try { islPhotoClose(); } catch (e) {} });
  await page.screenshot({ path: OUT + '03-1366-照片.png' });

  t('⑪ 全程无 JS 报错', errs.length === 0, errs.join(' | ') || '无');
  await ctx.close();
}

/* ============ B. 1920×1080：内容本来就装得下 → 不缩放 ============ */
{
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  await mock(page, ISLAND);
  await page.goto(SITE.replace('index.html', 'index.html?big=1'), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.evaluate((HW) => {
    AUTH.user = { username: 'aibot', role: 'admin' };
    SITE_DATA.holidayHomeworks = HW;
    try { closeLoginGuide(false); } catch (e) {}
    const g = document.getElementById('loginGuideMask'); if (g) g.style.display = 'none';
    BIG.openHw();
  }, HW);
  await page.waitForTimeout(800);
  const r = await page.evaluate(() => {
    const prog = document.getElementById('bhwProg').getBoundingClientRect();
    const bar = document.querySelector('.bhw-bar').getBoundingClientRect();
    return { scale: BIG._sideScale, progBottom: Math.round(prog.bottom), barTop: Math.round(bar.top) };
  });
  t('⑫ 1080 高：右栏不缩放且完整', r.scale === 1 && r.progBottom <= r.barTop + 1, JSON.stringify(r));
  await page.screenshot({ path: OUT + '04-1920.png' });
  await ctx.close();
}

/* ============ C. 窄屏单列：右栏回文档流 ============ */
{
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const page = await ctx.newPage();
  await mock(page, ISLAND);
  await page.goto(SITE.replace('index.html', 'index.html?big=1'), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.evaluate((HW) => {
    AUTH.user = { username: 'aibot', role: 'admin' };
    SITE_DATA.holidayHomeworks = HW;
    try { closeLoginGuide(false); } catch (e) {}
    const g = document.getElementById('loginGuideMask'); if (g) g.style.display = 'none';
    BIG.openHw();
  }, HW);
  await page.waitForTimeout(700);
  const r = await page.evaluate(() => ({
    pos: getComputedStyle(document.getElementById('bhwSide')).position,
    h: document.getElementById('bhwSide').style.height,
    prog: !!document.getElementById('bhwProg'),
  }));
  t('⑬ 单列时右栏不锁高度（文档流）', r.pos === 'static' && !r.h, JSON.stringify(r));
  await ctx.close();
}

/* ============ D. 刷新后侧边栏高亮仍在 ============ */
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 } });
  const page = await ctx.newPage();
  await mock(page, ISLAND);
  await page.goto(SITE + '#/scores', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => ({
    cat: window.__activeCat,
    active: [...document.querySelectorAll('#sideCats .side-btn.active')].map((x) => x.dataset.cat),
    page: [...document.querySelectorAll('.tab-page.active')].map((x) => x.id),
  }));
  t('⑭ 刷新后侧边栏当前板块仍然高亮',
    r.cat === 3 && r.active.length === 1 && r.active[0] === '3' && r.page[0] === 'tab-cat-3', JSON.stringify(r));
  await page.screenshot({ path: OUT + '05-刷新高亮.png' });
  await ctx.close();
}

await browser.close();
console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
