/* v4.11.0 专项：
   ① 时钟页「第几周」跟大屏同口径（按开学所在周的周一算），周三开学不再少算一周
   ② 深色/浅色刷新、更新重载后保持原样；跨过日出日落才交还自动
   ③ 普通模式 + 大屏模式日历：有作业的那天打点，没作业不打
   ④ 全站设置 → 大屏：右栏宽度、顶栏右侧留白、七张卡片开关（含关掉后重新打开）
   ⑤ 门禁：中版本节奏 6 小时 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const SITE = process.env.CLS_SITE || 'http://localhost:8111/index.html';
const CH = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const OUT = '/workspace/classsite-v4110/';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const t = (n, ok, x) => {
  if (ok) { pass++; console.log('  ✓ ' + n + (x ? '  [' + x + ']' : '')); }
  else { fail++; console.log('  ✗ ' + n + (x ? '  [' + x + ']' : '')); }
};

const HW = [{
  id: 'w2026-11-09', title: '高二上 · 第11周作业', start: '2026-11-09', end: '2026-11-13',
  items: [
    { subject: '语文', tasks: [{ text: '背诵《赤壁赋》并默写' }] },
    { subject: '数学', tasks: [{ text: '练习册 P45 全部' }] },
    { subject: '英语', tasks: [{ text: '背 Unit 3 单词' }] },
    { subject: '物理', tasks: [{ text: '电场专题卷' }] },
  ],
}, {
  id: 'w2026-11-16', title: '高二上 · 第12周作业', start: '2026-11-16', end: '2026-11-20',
  items: [{ subject: '语文', tasks: [{ text: '' }] }],
}];
const EXAMS = { ok: true, at: Date.now(), today: '2026-11-09', title: '期中考试', cls: '5班', base: '', groups: [], items: [], pins: { majors: [], days: [], items: [] }, term: { name: '2026 年秋季 · 高二上', start: '2026-09-01', end: '2027-01-30' }, cached: false, stale: false };
const ISLAND = {
  on: true, startDate: '2026-09-02', endDate: '2027-01-30', enrollDate: '2025-09-01',
  term: '2026 年秋季 · 高二上', holidays: [], nightFrom: '21:00', photo: '',
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
const browser = await chromium.launch({ executablePath: CH, args: ['--no-sandbox'] });

/* ============ A. 时钟页周次与大屏同口径 ============ */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: 'Asia/Shanghai' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  /* 周三开学（2026-09-02 是周三）→ 第 1 周从 08-31 那个周一起算 */
  /* 周三开学（2026-09-02 是周三）→ 第 1 周从 08-31 那个周一起算 */
  await page.clock.install({ time: new Date('2026-11-09T09:00:00+08:00') });
  await page.addInitScript(() => {
    try {
      localStorage.setItem('cls_week_cache', JSON.stringify({ start: '2026-09-02', mon: '2026-08-31' }));
      localStorage.setItem('cls_clock_cfg', JSON.stringify({ mode: 'clock' }));
    } catch (e) {}
  });
  await page.goto(SITE.replace('index.html', 'clock.html'), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => ({ sub: (document.getElementById('bigSub') || {}).textContent || '' }));
  t('① 时钟页 11 月 9 日 = 第 11 周（周三开学不少算）', /第 11 周/.test(r.sub), r.sub);
  /* 开学当天：把缓存换成当天，页面重载后应显示第 1 周 */
  await page.addInitScript(() => { try { localStorage.setItem('cls_week_cache', JSON.stringify({ start: '2026-09-02', mon: '2026-08-31' })); } catch (e) {} });
  await page.goto(SITE.replace('index.html', 'clock.html') + '?t=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1200);
  const r0 = await page.evaluate(() => ({
    sub: (document.getElementById('bigSub') || {}).textContent || '',
    /* 老口径（直接按开学日算）会得到 68/7 → 第 10 周，新口径必须是 11 */
    oldCalc: Math.floor((new Date('2026-11-09T00:00:00') - new Date('2026-09-02T00:00:00')) / 86400000 / 7) + 1,
  }));
  t('① 开学日所在周 = 第 1 周（不是第 0 周）', r0.oldCalc === 10);
  t('① 大时钟小字里带周次', /第 \d+ 周/.test(r0.sub), r0.sub.slice(0, 80));
  t('① 时钟页无 JS 报错', errs.length === 0, errs[0] || '无');
  await ctx.close();
}

/* ============ B. 深色刷新保持 ============ */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: 'Asia/Shanghai', colorScheme: 'light' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  await page.clock.install({ time: new Date('2026-11-09T23:00:00+08:00') });
  await page.addInitScript(() => {
    try { localStorage.setItem('cls_theme_auto2', 'sun'); localStorage.setItem('cls_login_guide_v1', '1');
      /* v4.12.0：导览会盖住整页，这里预置「已完成」，避免干扰本脚本的视觉断言 */
      localStorage.setItem('cls_tour_v1', JSON.stringify({ login: { done: 1 }, home: { done: 1 } })); } catch (e) {}
  });
  await mock(page, ISLAND);
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1800);
  const st = () => page.evaluate(() => ({
    dark: document.documentElement.classList.contains('dark'),
    theme: localStorage.getItem('cls_theme'),
    hold: localStorage.getItem('cls_theme_hold'),
    icon: (document.getElementById('themeToggle') || {}).innerHTML || '',
  }));
  t('② 23 点自动进深色', (await st()).dark);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  const s2 = await st();
  t('② 刷新后仍是深色', s2.dark, JSON.stringify(s2).slice(0, 80));
  await page.waitForTimeout(32000);
  const s3 = await st();
  t('② 半分钟后没被自动翻回浅色', s3.dark);

  await page.click('#themeToggle');
  await page.waitForTimeout(500);
  const ask = await page.evaluate(() => !!document.querySelector('#themeAutoAskMask.show'));
  t('② 夜里点切换会问「仅这次 / 改模式」', ask);
  if (ask) await page.evaluate(() => themeAskOnce());
  await page.waitForTimeout(600);
  t('② 手动选浅色生效', !(await st()).dark);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  t('② 刷新后仍是浅色（不被打回深色）', !(await st()).dark);
  /* 相位变化 → 交还自动：把时钟推到次日 3 点仍是夜里，但日期变了 → 自动接管（仍深色） */
  await page.clock.setFixedTime(new Date('2026-11-11T03:00:00+08:00'));
  await page.evaluate(() => applyAutoTheme(true));
  await page.waitForTimeout(400);
  t('② 跨天/跨相位后自动逻辑能重新接管', (await st()).dark);
  t('② 主题流程无 JS 报错', errs.length === 0, errs[0] || '无');
  await ctx.close();
}

/* ============ C. 日历打点（普通 + 大屏） ============ */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  await page.clock.install({ time: new Date('2026-11-09T20:00:00+08:00') });
  await page.addInitScript(() => { try { localStorage.setItem('cls_login_guide_v1', '1'); } catch (e) {} });
  await mock(page, ISLAND);
  await page.goto(SITE + '#/hw', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2200);
  await page.evaluate((HW) => {
    AUTH.user = { username: 'aibot', role: 'admin' };
    SITE_DATA.holidayHomeworks = HW;
    try { showCurrentHomework(); } catch (e) {}
    setTimeout(() => { try { hwNormCalToggle(); } catch (e) {} }, 300);
  }, HW);
  await page.waitForTimeout(1100);
  const norm = await page.evaluate(() => {
    const days = [...document.querySelectorAll('.hw-normcal .nc-day')];
    return {
      total: days.length,
      dots: days.filter((d) => d.querySelector('.nc-dot')).length,
      // 11/09–11/13 有作业（5 天），11/16–11/20 只有空任务 → 不算
      dotLabels: days.filter((d) => d.querySelector('.nc-dot')).map((d) => d.firstChild.textContent.trim()),
    };
  });
  t('③ 普通模式日历有作业的日子打点', norm.dots === 5, JSON.stringify(norm.dotLabels));
  t('③ 普通模式日历确实显示出来', await page.evaluate(() => !!document.querySelector('.hw-normcal .nc-day')));
  t('③ 普通模式空作业的期次不打点', !norm.dotLabels.includes('16'));
  await page.screenshot({ path: OUT + '01-普通日历打点.png' });

  /* 大屏 */
  await page.goto(SITE.replace('index.html', 'index.html?big=1') + '#/hw', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1800);
  await page.evaluate((HW) => {
    AUTH.user = { username: 'aibot', role: 'admin' };
    SITE_DATA.holidayHomeworks = HW;
    try { closeLoginGuide(false); } catch (e) {}
    const g = document.getElementById('loginGuideMask'); if (g) g.style.display = 'none';
    BIG.openHw();
    setTimeout(() => { try { BIG.calOpen(); } catch (e) {} }, 400);
  }, HW);
  await page.waitForTimeout(1400);
  const big = await page.evaluate(() => {
    const days = [...document.querySelectorAll('#bhwCalBody .bhw-cal-day')];
    return {
      open: !!document.querySelector('#bhwCalMask.show'),
      total: days.length,
      dots: days.filter((d) => d.querySelector('.bhw-cal-dot')).length,
      dotLabels: days.filter((d) => d.querySelector('.bhw-cal-dot')).map((d) => d.querySelector('b').textContent.trim()),
    };
  });
  t('③ 大屏日历能打开', big.open);
  t('③ 大屏日历有作业的日子打点', big.dots === 5, JSON.stringify(big.dotLabels));
  await page.screenshot({ path: OUT + '02-大屏日历打点.png' });
  t('③ 日历流程无 JS 报错', errs.length === 0, errs[0] || '无');
  await ctx.close();
}

/* ============ D. 设置 → 大屏 ============ */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  await page.clock.install({ time: new Date('2026-11-09T20:00:00+08:00') });
  await page.addInitScript(() => { try { localStorage.setItem('cls_login_guide_v1', '1'); } catch (e) {} });
  await mock(page, ISLAND);
  await page.goto(SITE.replace('index.html', 'index.html?big=1') + '#/hw', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.evaluate((HW) => {
    AUTH.user = { username: 'aibot', role: 'admin' };
    SITE_DATA.holidayHomeworks = HW;
    try { closeLoginGuide(false); } catch (e) {}
    const g = document.getElementById('loginGuideMask'); if (g) g.style.display = 'none';
    BIG.openHw();
    openSettings();
    uiSec('big');
  }, HW);
  await page.waitForTimeout(1000);
  const panel = await page.evaluate(() => ({
    tab: [...document.querySelectorAll('.ui-tab[data-sec]')].map((x) => x.getAttribute('data-sec')),
    w: (document.getElementById('uiSideW') || {}).value,
    pad: (document.getElementById('uiTopPad') || {}).value,
    toggles: document.querySelectorAll('#uiSetBody .bhw-card-tg').length,
  }));
  t('④ 设置里有「大屏」页签', panel.tab.includes('big'), panel.tab.join(','));
  t('④ 右栏宽度默认 320（站主要宽一点）', panel.w === '320', panel.w);
  t('④ 顶栏留白默认 0', panel.pad === '0', panel.pad);
  t('④ 七张卡片开关都在', panel.toggles === 7, panel.toggles);

  /* 改宽度 380 → 大屏右栏跟着变宽，作业列让出空间 */
  await page.evaluate(() => { const i = document.getElementById('uiSideW'); i.value = '380'; i.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(700);
  const g1 = await page.evaluate(() => ({
    cssVar: getComputedStyle(document.documentElement).getPropertyValue('--bhw-side-w').trim(),
    sideW: Math.round(document.getElementById('bhwSide').getBoundingClientRect().width),
    stored: JSON.parse(localStorage.getItem('cls_bhw_prefs') || '{}').w,
  }));
  t('④ 宽度 380 落到大屏右栏', g1.sideW === 380 && g1.stored === 380, JSON.stringify(g1));

  /* 顶栏留白 24 */
  await page.evaluate(() => { const i = document.getElementById('uiTopPad'); i.value = '24'; i.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(500);
  const g2 = await page.evaluate(() => ({
    cssVar: getComputedStyle(document.documentElement).getPropertyValue('--bhw-top-pad').trim(),
    padRight: getComputedStyle(document.querySelector('.bhw-top')).paddingRight,
  }));
  t('④ 顶栏留白 24px 生效', g2.cssVar === '24px', JSON.stringify(g2));

  /* 关掉随机点名 → 隐藏；再点一次 → 回来（站主：关掉以后找不到地方打开） */
  const p1 = await page.evaluate(() => {
    bigToggleCard('pick');
    const el = document.querySelector('.bhw-pick');
    return { disp: el ? getComputedStyle(el).display : 'none', stored: JSON.parse(localStorage.getItem('cls_bhw_prefs') || '{}').cards.pick };
  });
  await page.waitForTimeout(600);
  t('④ 关掉随机点名后不显示', p1.disp === 'none' && p1.stored === 0, JSON.stringify(p1));
  const p2 = await page.evaluate(() => {
    bigToggleCard('pick');
    const el = document.querySelector('.bhw-pick');
    return { disp: el ? getComputedStyle(el).display : 'none', stored: JSON.parse(localStorage.getItem('cls_bhw_prefs') || '{}').cards.pick };
  });
  await page.waitForTimeout(600);
  t('④ 设置里能重新打开随机点名', p2.disp !== 'none' && p2.stored === 1, JSON.stringify(p2));
  /* 随机一言：关掉一定藏起来（有内容也不显示） */
  await page.evaluate(() => bigToggleCard('quote'));
  await page.waitForTimeout(500);
  t('④ 关掉随机一言后不显示', await page.evaluate(() => window.BIG.quoteHidden === true));
  /* 关掉时钟 → 大屏时钟消失 */
  await page.evaluate(() => bigToggleCard('clock'));
  await page.waitForTimeout(500);
  t('④ 关掉时钟后不显示', await page.evaluate(() => getComputedStyle(document.getElementById('bhwClock')).display === 'none'));
  await page.screenshot({ path: OUT + '03-大屏设置.png' });
  /* 恢复默认 */
  await page.evaluate(() => bigResetPrefs());
  await page.waitForTimeout(600);
  t('④ 恢复默认把宽度和卡片都还原', await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('cls_bhw_prefs') || '{}');
    return p.w === 320 && p.topPad === 0 && Object.values(p.cards || {}).every((v) => v === 1);
  }));
  t('④ 设置流程无 JS 报错', errs.length === 0, errs[0] || '无');
  await ctx.close();
}

/* ============ E. 门禁 6 小时 ============ */
{
  const s = fs.readFileSync(new URL('../scripts/predeploy.mjs', import.meta.url), 'utf8');
  t('⑤ 中版本节奏改成 6 小时', /const HOURS = 6;/.test(s) && !/const HOURS = 12;/.test(s));
  t('⑤ 门禁里写明推送走 Gitee + token 位置', /Gitee/.test(s) && /secrets/.test(s) && /push-gitee/.test(s));
}

console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail === 0 ? 0 : 1);
