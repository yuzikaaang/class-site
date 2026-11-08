/* v4.10.17 专项：作业两栏 1/2 + 1/2（考试卡保持改前宽度）、底部日期条可折叠
   跑法：本地 8111 静态服务 → node test_ui_v41017.mjs */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = 'http://localhost:8111';
const CHROME = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const OUT = '/workspace/classsite-v41017';
let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
};

const HW = [{
  id: 'w2026-11-02', title: '高二上 · 第10周作业', start: '2026-11-02', end: '2026-11-06',
  items: [
    { subject: '语文', tasks: [
      { text: '背《赤壁赋》全文并默写', due: '2026-11-13T22:00' },
      { text: '周记一篇' }
    ] },
    { subject: '数学', tasks: [
      { text: '试卷第 12 套全部完成，压轴题写出完整推导过程，错题整理到错题本上', due: '2026-11-13T22:00' },
      { text: '课本习题 P78 1-8' }
    ] },
    { subject: '英语', tasks: [{ text: 'Unit 4 单词默写', due: '2026-11-13T22:00' }] },
    { subject: '物理', tasks: [
      { text: '电场强度专题卷，最后两道大题要画图并写清每一步受力分析', due: '2026-11-13T22:00' }
    ] },
    { subject: '化学', tasks: [{ text: '有机化学基础练习册 P30-32' }] },
    { subject: '生物', tasks: [{ text: '整理减数分裂流程图' }] }
  ]
}];

/* 考试块：auto:true 的段考，落在 11/04–11/05，固定 today 后必定画出来 */
const EXAMS = {
  ok: true, at: Date.now(), today: '2026-11-04',
  groups: [{
    id: 'major_a', name: '2026 高二上第二次段考', temporary: false,
    start: '2026-11-04', end: '2026-11-05', daysN: 2, count: 4,
    onCnt: 0, allOn: false, anyOn: false, auto: true,
    days: [
      { date: '2026-11-04', wd: '周三', onCnt: 0, allOn: false, anyOn: false, items: [
        { id: 'a1', name: '语文', start: '09:00', end: '11:30', pin: false, by: '' },
        { id: 'a2', name: '数学', start: '14:30', end: '16:30', pin: false, by: '' }
      ] },
      { date: '2026-11-05', wd: '周四', onCnt: 0, allOn: false, anyOn: false, items: [
        { id: 'a3', name: '物理', start: '08:30', end: '09:45', pin: false, by: '' },
        { id: 'a4', name: '外语', start: '10:00', end: '12:00', pin: false, by: '' }
      ] }
    ]
  }],
  items: [], pins: { majors: [], days: [], items: [] }
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

async function enterHw(page) {
  await page.evaluate((hw) => {
    AUTH.user = { username: 'aibot', role: 'admin' };
    SITE_DATA.holidayHomeworks = hw;
    try { closeLoginGuide(false); } catch (e) {}
    const g = document.getElementById('loginGuideMask'); if (g) g.style.display = 'none';
    BIG.openHw();
    BIG.hwJumpTo('2026-11-04');
  }, HW);
  await page.waitForTimeout(900);
}

async function newPage(ctx) {
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.clock.install({ time: new Date('2026-11-04T10:00:00') });
  await mock(page);
  await page.goto(BASE + '/index.html?big=1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  await enterHw(page);
  return { page, errs };
}

const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const { page, errs } = await newPage(ctx);

/* ---------- ① 两栏等宽 1/2 + 1/2 ---------- */
const geo = await page.evaluate(() => {
  const grid = document.querySelector('.bhw-grid');
  const a = document.getElementById('bhwColA');
  const b = document.getElementById('bhwColB');
  const side = document.querySelector('.bhw-side');
  const ex = document.getElementById('bhwExam');
  const cs = getComputedStyle(grid);
  return {
    cols: cs.gridTemplateColumns,
    a: a.getBoundingClientRect().width,
    b: b.getBoundingClientRect().width,
    side: side.getBoundingClientRect().width,
    ex: ex ? ex.getBoundingClientRect().width : 0,
    exBox: ex ? getComputedStyle(ex).boxSizing : ''
  };
});
t('① .bhw-grid 三列解析为两栏等宽 + 300px 侧栏',
  geo.a > 100 && Math.abs(geo.a - geo.b) < 1.5 && Math.abs(geo.side - 300) < 1,
  'colA=' + geo.a.toFixed(1) + ' colB=' + geo.b.toFixed(1) + ' side=' + geo.side.toFixed(1));
t('① 两栏各占一半（不再 1:2）',
  Math.abs(geo.a - geo.b) < 1.5, geo.cols);

/* ---------- ② 考试卡宽度不改（= 改前 1/3 内容区 / 现左栏 2/3） ---------- */
t('② 考试卡仍画在左栏且比左栏窄', geo.ex > 0 && geo.ex < geo.a - 20,
  '考试卡=' + geo.ex.toFixed(1) + ' 左栏=' + geo.a.toFixed(1));
t('② 考试卡宽度 = 左栏 2/3（即改前的 1/3 内容区）',
  geo.ex > 0 && Math.abs(geo.ex - geo.a * 2 / 3) < 3 && geo.exBox === 'border-box',
  '实测 ' + geo.ex.toFixed(1) + ' 期望 ' + (geo.a * 2 / 3).toFixed(1));

/* ---------- ③ 日期条初始展开 ---------- */
const init = await page.evaluate(() => {
  const ds = document.getElementById('bhwDateStrip');
  const btn = document.getElementById('bhwDsBtn');
  return {
    display: getComputedStyle(ds).display,
    fold: !!ds.querySelector('.ds-fold'),
    days: ds.querySelectorAll('.ds-day').length,
    cal: !!ds.querySelector('.ds-cal'),
    on: btn.classList.contains('on'),
    pressed: btn.getAttribute('aria-pressed'),
    pad: getComputedStyle(document.getElementById('bigHw')).paddingBottom,
    addBottom: getComputedStyle(document.querySelector('.bhw-addsubj')).bottom
  };
});
t('③ 日期条初始展开，七天 + 日历 + 收起按钮齐全',
  init.display !== 'none' && init.days === 7 && init.cal && init.fold,
  'days=' + init.days + ' display=' + init.display);
t('③ 工具条「日期」开关展开态点亮', init.on && init.pressed === 'true');
t('③ 展开态占位：#bigHw 178px / 科目按钮 104px',
  init.pad === '178px' && init.addBottom === '104px', init.pad + ' / ' + init.addBottom);

await page.screenshot({ path: OUT + '/01-等宽分栏-日期展开.png', fullPage: false });

/* ---------- ④ 点「收起」折叠 ---------- */
await page.locator('#bhwDateStrip .ds-fold').click();
await page.waitForTimeout(260);
const folded = await page.evaluate(() => {
  const ds = document.getElementById('bhwDateStrip');
  const btn = document.getElementById('bhwDsBtn');
  return {
    cls: document.documentElement.classList.contains('bhw-ds-fold'),
    display: getComputedStyle(ds).display,
    stored: localStorage.getItem('cls_bhw_ds_fold'),
    on: btn.classList.contains('on'),
    pressed: btn.getAttribute('aria-pressed'),
    title: btn.title,
    pad: getComputedStyle(document.getElementById('bigHw')).paddingBottom,
    addBottom: getComputedStyle(document.querySelector('.bhw-addsubj')).bottom
  };
});
t('④ 点收起后 html 带 bhw-ds-fold，日期条整条不占位',
  folded.cls && folded.display === 'none');
t('④ 收起状态写进本机 localStorage', folded.stored === '1');
t('④ 收起后底部留白减 46px（178→132），科目按钮下移（104→58）',
  folded.pad === '132px' && folded.addBottom === '58px', folded.pad + ' / ' + folded.addBottom);
t('④ 工具条开关变为收起态（不高亮、提示可展开）',
  !folded.on && folded.pressed === 'false' && /展开/.test(folded.title), folded.title);

await page.screenshot({ path: OUT + '/02-日期条已折叠.png', fullPage: false });

/* ---------- ⑤ 点工具条「日期」展开回来 ---------- */
await page.locator('#bhwDsBtn').click();
await page.waitForTimeout(260);
const opened = await page.evaluate(() => ({
  cls: document.documentElement.classList.contains('bhw-ds-fold'),
  display: getComputedStyle(document.getElementById('bhwDateStrip')).display,
  stored: localStorage.getItem('cls_bhw_ds_fold'),
  days: document.querySelectorAll('#bhwDateStrip .ds-day').length,
  pad: getComputedStyle(document.getElementById('bigHw')).paddingBottom
}));
t('⑤ 点工具条「日期」可展开回来，七天重新出现',
  !opened.cls && opened.display !== 'none' && opened.days === 7 && opened.pad === '178px');
t('⑤ 展开状态同样写回 localStorage', opened.stored === '0');

/* ---------- ⑥ 折叠状态刷新后仍在 ---------- */
await page.locator('#bhwDateStrip .ds-fold').click();
await page.waitForTimeout(200);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
await enterHw(page);
const persisted = await page.evaluate(() => ({
  cls: document.documentElement.classList.contains('bhw-ds-fold'),
  display: getComputedStyle(document.getElementById('bhwDateStrip')).display,
  stored: localStorage.getItem('cls_bhw_ds_fold'),
  pad: getComputedStyle(document.getElementById('bigHw')).paddingBottom
}));
t('⑥ 折叠后刷新页面，仍是收起状态（只记本机）',
  persisted.cls && persisted.display === 'none' && persisted.stored === '1' && persisted.pad === '132px');

/* ---------- ⑦ 无脚本报错 ---------- */
t('⑦ 全程无 JS 运行时报错', errs.length === 0, errs.slice(0, 2).join(' | '));

console.log('\nv4.10.17 专项：' + pass + ' 通过 / ' + fail + ' 失败');
await ctx.close();
await browser.close();
process.exit(fail ? 1 : 0);
