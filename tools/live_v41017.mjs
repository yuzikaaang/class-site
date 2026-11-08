/* v4.10.17 线上真机验收：等宽分栏 / 考试卡原宽 / 日期栏折叠 */
import { chromium } from 'playwright-core';
const SITE = 'https://yuzikaaang.github.io/class-site/';
const CH = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const OUT = '/workspace/classsite-v41017/';
let pass = 0, fail = 0;
const t = (n, ok, x) => { if (ok) { pass++; console.log('  ✓ ' + n + (x ? '  [' + x + ']' : '')); } else { fail++; console.log('  ✗ ' + n + (x ? '  [' + x + ']' : '')); } };

const HW = [{
  id: 'w2026-11-02', title: '高二上 · 第10周作业', start: '2026-11-02', end: '2026-11-06',
  items: [
    { subject: '语文', tasks: [{ text: '背《赤壁赋》全文并默写', due: '2026-11-13T22:00' }, { text: '周记一篇' }] },
    { subject: '数学', tasks: [{ text: '试卷第 12 套全部完成，压轴题写出完整推导过程，错题整理到错题本上', due: '2026-11-13T22:00' }] },
    { subject: '英语', tasks: [{ text: 'Unit 4 单词默写', due: '2026-11-13T22:00' }] },
    { subject: '物理', tasks: [{ text: '电场强度专题卷，最后两道大题要画图并写清每一步受力分析', due: '2026-11-13T22:00' }] },
    { subject: '化学', tasks: [{ text: '有机化学基础练习册 P30-32' }] },
    { subject: '生物', tasks: [{ text: '整理减数分裂流程图' }] }
  ]
}];
const EXAMS = {
  ok: true, at: 1, today: '2026-11-04',
  groups: [{
    id: 'major_a', name: '2026 高二上第二次段考', temporary: false,
    start: '2026-11-04', end: '2026-11-05', daysN: 2, count: 4,
    onCnt: 0, allOn: false, anyOn: false, auto: true,
    days: [
      { date: '2026-11-04', wd: '周三', onCnt: 0, allOn: false, anyOn: false, items: [
        { id: 'a1', name: '语文', start: '09:00', end: '11:30', pin: false, by: '' },
        { id: 'a2', name: '数学', start: '14:30', end: '16:30', pin: false, by: '' } ] },
      { date: '2026-11-05', wd: '周四', onCnt: 0, allOn: false, anyOn: false, items: [
        { id: 'a3', name: '物理', start: '08:30', end: '09:45', pin: false, by: '' },
        { id: 'a4', name: '外语', start: '10:00', end: '12:00', pin: false, by: '' } ] }
    ]
  }], items: [], pins: { majors: [], days: [], items: [] }
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
    BIG.openHw(); BIG.hwJumpTo('2026-11-04');
  }, HW);
  await p.waitForTimeout(1000);
}

const c = await b.newContext({ viewport: { width: 1600, height: 900 } });
const p = await c.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.clock.install({ time: new Date('2026-11-04T10:00:00') });
await mock(p);
await p.goto(SITE + '?big=1&r=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout(2800);
await enter(p);

const ver = await p.evaluate(() => ({ site: typeof SITE_VERSION !== 'undefined' ? SITE_VERSION : '',
  ds: typeof BIG.dsToggle, foldBtn: !!document.getElementById('bhwDsBtn') }));
t('线上版本为 4.10.17 且新接口已加载', ver.site === '4.10.17' && ver.ds === 'function' && ver.foldBtn, JSON.stringify(ver));

const geo = await p.evaluate(() => {
  const a = document.getElementById('bhwColA'), b2 = document.getElementById('bhwColB');
  const ex = document.getElementById('bhwExam');
  return { a: a.getBoundingClientRect().width, b: b2.getBoundingClientRect().width,
    ex: ex ? ex.getBoundingClientRect().width : 0 };
});
t('线上两栏等宽（各 1/2）', geo.a > 100 && Math.abs(geo.a - geo.b) < 1.5,
  geo.a.toFixed(1) + ' / ' + geo.b.toFixed(1));
t('线上考试卡保持改前宽度（左栏 2/3）',
  geo.ex > 0 && Math.abs(geo.ex - geo.a * 2 / 3) < 3, geo.ex.toFixed(1));

await p.screenshot({ path: OUT + '线上-等宽分栏-日期栏展开.png' });

const before = await p.evaluate(() => ({
  disp: getComputedStyle(document.getElementById('bhwDateStrip')).display,
  days: document.querySelectorAll('#bhwDateStrip .ds-day').length,
  pad: getComputedStyle(document.getElementById('bigHw')).paddingBottom }));
t('线上日期栏展开：七天齐全、底部留白 178px',
  before.disp !== 'none' && before.days === 7 && before.pad === '178px', JSON.stringify(before));

await p.locator('#bhwDateStrip .ds-fold').click();
await p.waitForTimeout(300);
const after = await p.evaluate(() => ({
  disp: getComputedStyle(document.getElementById('bhwDateStrip')).display,
  cls: document.documentElement.classList.contains('bhw-ds-fold'),
  stored: localStorage.getItem('cls_bhw_ds_fold'),
  pad: getComputedStyle(document.getElementById('bigHw')).paddingBottom,
  add: getComputedStyle(document.querySelector('.bhw-addsubj')).bottom }));
t('线上点收起后日期栏整条隐藏、留白减到 132px',
  after.disp === 'none' && after.cls && after.stored === '1'
  && after.pad === '132px' && after.add === '58px', JSON.stringify(after));
await p.screenshot({ path: OUT + '线上-日期栏已折叠.png' });

await p.locator('#bhwDsBtn').click();
await p.waitForTimeout(300);
const back = await p.evaluate(() => ({
  disp: getComputedStyle(document.getElementById('bhwDateStrip')).display,
  days: document.querySelectorAll('#bhwDateStrip .ds-day').length }));
t('线上工具条「日期」可展开回来', back.disp !== 'none' && back.days === 7);

t('线上无 JS 运行时报错', errs.length === 0, errs.slice(0, 2).join(' | '));
console.log('\n线上验收：' + pass + ' 通过 / ' + fail + ' 失败');
await c.close(); await b.close();
process.exit(fail ? 1 : 0);
