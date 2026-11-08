/* v4.10.16 专项：小时间挪到返回旁 + 每项截止时间 + 过期折叠 + 日历跳转
   + 导出带灰字 + 历史拦截 + 普通模式新增作业/日历合入 */
import { chromium } from 'playwright-core';

const BASE = 'http://localhost:8111';
const CHROME = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
};

const HW = [{
  id: 'w2026-11-02', title: '高二上 · 第10周作业', start: '2026-11-02', end: '2026-11-06',
  items: [
    { subject: '语文', tasks: [
      { text: '背课文', due: '2026-11-04T22:00' },      /* 已过期 */
      { text: '写作文', due: '2026-11-13T22:00' },      /* 未过期 */
      { text: '没有截止时间' }
    ] },
    { subject: '数学', tasks: [{ text: '卷子', due: '2026-11-01T22:00' }] }  /* 全过期 */
  ]
}];

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

function mock(page) {
  return page.route('**/api/**', (r) => {
    const u = r.request().url();
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.includes('/api/exams')) return J({ ok: true, at: Date.now(), today: '2026-11-08', groups: [], items: [], pins: { majors: [], days: [], items: [] } });
    if (u.includes('/api/island')) return J({ ok: true, data: { on: true, startDate: '2026-09-01', endDate: '2027-01-30', enrollDate: '2025-09-01', term: '高二上', holidays: [] } });
    if (u.includes('/auth?action=me')) return J({ ok: true, user: { username: 'aibot', role: 'admin' } });
    if (u.includes('/api/content')) return J({ ok: true, items: { holiday_homeworks: HW, announcements: [] } });
    return J({ ok: true });
  });
}

async function openBig(fixedTime) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  if (fixedTime) await page.clock.install({ time: new Date(fixedTime) });
  await mock(page);
  await page.goto(BASE + '/index.html?big=1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  await page.evaluate((hw) => {
    AUTH.user = { username: 'aibot', role: 'admin' };
    SITE_DATA.holidayHomeworks = hw;
    try { closeLoginGuide(false); } catch (e) {}
    const g = document.getElementById('loginGuideMask'); if (g) g.style.display = 'none';
    BIG.openHw();
    BIG.hwJumpTo('2026-11-04');
  }, HW);
  await page.waitForTimeout(700);
  return { ctx, page, errs };
}

/* ① 大屏：截止时间、过期折叠、时钟按钮位置 */
{
  const { ctx, page, errs } = await openBig('2026-11-08T15:00:00');
  const ro = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#bhwColA .bhw-subj, #bhwColB .bhw-subj')];
    const yw = cards.find((c) => /语文/.test(c.textContent));
    const sh = cards.find((c) => /数学/.test(c.textContent));
    return {
      ywTasks: yw ? (yw.querySelectorAll('.bhw-task').length - yw.querySelectorAll('.bhw-duehidden .bhw-task').length) : -1,
      ywFold: yw ? (yw.querySelector('.bhw-duefold') || {}).textContent : null,
      ywHidden: yw ? yw.querySelectorAll('.bhw-duehidden .bhw-task').length : -1,
      shFold: sh ? (sh.querySelector('.bhw-duefold') || {}).textContent : null,
      dueTag: [...document.querySelectorAll('.bhw-due')].map((x) => x.textContent),
    };
  });
  t('只读态语文只显示未过期的 2 项', ro.ywTasks === 2, JSON.stringify(ro.ywTasks));
  t('语文把过期的 1 项收进「已截止 1 项」', /已截止 1 项/.test(ro.ywFold || ''), String(ro.ywFold));
  t('折叠区里确实有那 1 项', ro.ywHidden === 1, String(ro.ywHidden));
  t('数学整科都过期也照常折叠', /已截止 1 项/.test(ro.shFold || ''), String(ro.shFold));
  t('未过期项显示淡色小字「截止 11/13 22:00」', ro.dueTag.some((x) => /截止 11\/13 22:00/.test(x)), JSON.stringify(ro.dueTag));

  /* 展开折叠 */
  await page.evaluate(() => {
    const b = document.querySelector('.bhw-duefold'); if (b) BIG.dueFold(b, 's0');
  });
  await page.waitForTimeout(300);
  t('点开折叠能看到已截止的项', await page.evaluate(() => {
    const b = document.querySelector('.bhw-duefold');
    return !!(b && b.nextElementSibling && !b.nextElementSibling.hasAttribute('hidden'));
  }));

  /* 进编辑：全部项可见 + 每项右侧都有时钟按钮。
     这里直接开本机编辑开关，历史拦截放到后面单独验。 */
  await page.evaluate(() => { localStorage.setItem('cls_hw_edit', '1'); BIG.renderHw(); });
  await page.waitForTimeout(500);
  const ed = await page.evaluate(() => {
    const yw = [...document.querySelectorAll('.bhw-subj')].find((c) => /语文/.test(c.innerHTML));
    const tasks = yw ? yw.querySelectorAll('.bhw-task') : [];
    return {
      n: tasks.length,
      clocks: yw ? yw.querySelectorAll('.bhw-task .bhw-duebtn').length : -1,
      lastChildIsBtn: tasks.length ? /bhw-duebtn|bhw-x/.test(tasks[0].lastElementChild.className) : false,
    };
  });
  t('编辑态过期项也可见（语文 3 项）', ed.n === 3, String(ed.n));
  t('每一项右侧都有截止时间时钟按钮', ed.clocks === 3, String(ed.clocks));
  t('时钟按钮在行尾（正文之后）', ed.lastChildIsBtn === true, String(ed.lastChildIsBtn));

  /* 设截止时间 */
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.bhw-subj')].find((c) => /语文/.test(c.innerHTML)).querySelectorAll('.bhw-duebtn');
    btns[2].click();
  });
  await page.waitForTimeout(300);
  const dueOpen = await page.evaluate(() => ({
    show: /show/.test(document.getElementById('bhwDueMask').className),
    title: document.getElementById('bhwDueTitle').textContent,
  }));
  t('点时钟按钮打开截止时间弹窗', dueOpen.show, JSON.stringify(dueOpen));
  t('弹窗标题指向具体科目和项', /语文/.test(dueOpen.title) && /第 3 项/.test(dueOpen.title), dueOpen.title);
  await page.evaluate(() => {
    document.getElementById('bhwDueInput').value = '2026-11-20T21:30';
    BIG.dueSave();
  });
  await page.waitForTimeout(500);
  t('保存后这一项有了 due 字段', await page.evaluate(() => {
    const hw = BIG.ensurePeriod(new Date(2026, 10, 4));
    return String(hw.items[0].tasks[2].due || '') === '2026-11-20T21:30';
  }));

  /* 日历：日期条 + 跳到周末期次 */
  const cal = await page.evaluate(() => {
    const days = [...document.querySelectorAll('#bhwDateStrip .ds-day')];
    return { n: days.length, hasCal: !!document.querySelector('#bhwDateStrip .ds-cal') };
  });
  t('底部日期条是整整一周 7 天', cal.n === 7, String(cal.n));
  t('日期条上有「日历」按钮', cal.hasCal);
  const jump = await page.evaluate(() => {
    BIG.hwJumpTo('2026-11-14');
    const hw = BIG.ensurePeriod(new Date(2026, 10, 14));
    return { title: hw.title, start: hw.start, end: hw.end, id: hw.id };
  });
  t('点 11/14 落到「第11周周末作业」', /第11周周末作业/.test(jump.title), JSON.stringify(jump));
  t('周末期次范围是 11/14 ~ 11/15', /11-14/.test(jump.start) && /11-15/.test(jump.end), JSON.stringify(jump));

  const wk = await page.evaluate(() => {
    BIG.calOpen();
    const m = document.getElementById('bhwCalMask');
    return { show: /show/.test(m.className), days: m.querySelectorAll('.bhw-cal-day').length, title: document.getElementById('bhwCalTitle').textContent };
  });
  t('「日历」能弹出整月网格', wk.show && wk.days >= 28, JSON.stringify(wk));

  /* 历史拦截 */
  const hist = await page.evaluate(() => {
    BIG.calClose();
    localStorage.setItem('cls_hw_edit', '0');
    BIG.hwJumpTo('2026-11-04');
    BIG.hwEditToggle();
    const m = document.getElementById('bhwHistMask');
    return { show: /show/.test(m.className), text: document.getElementById('bhwHistText').textContent };
  });
  t('改已结束的那一周，进编辑先弹拦截', hist.show, JSON.stringify(hist));
  t('拦截文案点明是哪一期', /第10周作业/.test(hist.text), hist.text);
  await page.evaluate(() => BIG.histConfirm());
  await page.waitForTimeout(300);
  t('点「仍要编辑」才真正进编辑态', await page.evaluate(() => BIG.hwEditOn()));
  /* 未来期次进编辑不拦 */
  const noHist = await page.evaluate(() => {
    localStorage.setItem('cls_hw_edit', '0');
    BIG.hwJumpTo('2026-11-20');
    BIG.hwEditToggle();
    return /show/.test(document.getElementById('bhwHistMask').className);
  });
  t('提前编辑未来那一周不弹历史拦截', noHist === false, String(noHist));
  await page.evaluate(() => { localStorage.setItem('cls_hw_edit', '0'); });

  t('大屏流程无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

/* ② 导出图带截止时间灰字 */
{
  const { ctx, page } = await openBig('2026-11-08T15:00:00');
  const r = await page.evaluate(() => ({
    overdue: hwDueShort({ due: '2026-11-01T22:00' }),
    future: hwDueShort({ due: '2026-11-13T22:00' }),
    none: hwDueShort({ text: '没有' }),
  }));
  t('导出：过期项右列写「已截止」灰字', /已截止 11\/1 22:00/.test(r.overdue), JSON.stringify(r));
  t('导出：未过期项右列写「截止」', /截止 11\/13 22:00/.test(r.future), JSON.stringify(r));
  t('导出：没设时间的项不写右列', r.none === '', JSON.stringify(r));
  await ctx.close();
}

/* ③ 普通模式：仅管理员新增 + 日历合入 + 弹窗内编辑 */
async function openNormal(isAdmin) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.clock.install({ time: new Date('2026-11-08T15:00:00') });
  await mock(page);
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  await page.evaluate(({ hw, adm }) => {
    SITE_DATA.holidayHomeworks = hw;
    AUTH.user = adm ? { username: 'aibot', role: 'admin' } : { username: 'stu', role: 'user' };
    try { document.querySelectorAll('.allboard-mask.show,.gate.show').forEach((m) => m.classList.remove('show')); } catch (e) {}
    showCurrentHomework();
  }, { hw: HW, adm: isAdmin });
  await page.waitForTimeout(500);
  return { ctx, page, errs };
}
{
  const { ctx, page, errs } = await openNormal(true);
  const v = await page.evaluate(() => ({
    addBtn: getComputedStyle(document.getElementById('hwAddBtn')).display,
    days: document.querySelectorAll('#hwNormStrip .ns-day').length,
    calInSameMask: !!(document.getElementById('hwCurrentMask').querySelector('#hwNormCal')),
    dueTags: [...document.querySelectorAll('#hwCurrentList .hw-due')].map((x) => x.textContent),
    fold: (document.querySelector('#hwCurrentList .hw-duefold') || {}).textContent,
  }));
  t('管理员能看到「＋ 新增作业」', v.addBtn !== 'none', String(v.addBtn));
  t('普通模式日期条也是一周 7 天', v.days === 7, String(v.days));
  t('整月日历就合在作业查看弹窗里（不另开弹窗）', v.calInSameMask);
  t('普通模式也显示淡色截止时间小字', v.dueTags.some((x) => /截止 11\/13 22:00/.test(x)), JSON.stringify(v.dueTags));
  t('普通模式过期项也折叠', /已截止 1 项/.test(v.fold || ''), String(v.fold));

  /* 点 11/14 → 周末期次 */
  const j = await page.evaluate(() => {
    hwNormJump('2026-11-14');
    return { title: document.getElementById('hwCurrentTitle').textContent, viewing: (window.__HW_VIEWING || {}).title };
  });
  t('普通模式点 11/14 落到第11周周末作业', /第11周周末作业/.test(j.viewing || ''), JSON.stringify(j));

  /* 整月日历展开 */
  const c = await page.evaluate(() => {
    hwNormCalToggle();
    return { disp: getComputedStyle(document.getElementById('hwNormCal')).display, days: document.querySelectorAll('#hwNormCal .nc-day').length };
  });
  t('点日历按钮在弹窗内展开整月网格', c.disp !== 'none' && c.days >= 28, JSON.stringify(c));

  /* 弹窗内编辑：默认写「今天所在周」的空期次，走一遍真实操作 */
  await page.evaluate(() => { hwNormToday(); openHwAdd(); });
  await page.waitForTimeout(400);
  const e = await page.evaluate(() => {
    const z = document.getElementById('hwEditZone');
    return {
      disp: getComputedStyle(z).display,
      subjBtns: z.querySelectorAll('.hwa-subj button').length,
      listHidden: getComputedStyle(document.getElementById('hwCurrentList')).display,
      periodTitle: (HW_ADD && HW_ADD.period.title) || '',
    };
  });
  t('「＋ 新增作业」在弹窗内直接展开编辑区', e.disp !== 'none' && e.listHidden === 'none', JSON.stringify(e));
  t('编辑区有 7 个科目按钮', e.subjBtns === 7, String(e.subjBtns));
  t('默认落在今天所在周的自动期次', /第10周|第11周/.test(e.periodTitle), e.periodTitle);

  /* 点「语文」建卡 → 再加两项 → 每项右侧都有时钟按钮 */
  await page.evaluate(() => { hwAddSubj('语文'); hwAddTask(0); hwAddTask(0); });
  await page.waitForTimeout(300);
  const e2 = await page.evaluate(() => {
    const z = document.getElementById('hwEditZone');
    return { tasks: z.querySelectorAll('.hwa-task').length, clocks: z.querySelectorAll('.hwa-task .hwa-clock').length };
  });
  t('点一下科目按钮就建出对应科目卡', e2.tasks === 3, JSON.stringify(e2));
  t('编辑区每一项右侧都有时钟按钮', e2.clocks === 3, JSON.stringify(e2));

  /* 设一项截止时间并保存（云端请求被 mock） */
  const pid = await page.evaluate(() => HW_ADD.period.id);
  await page.evaluate(() => {
    hwAddDueSet(0, 2, '2026-11-25T20:15');
    hwAddSetTask(0, 0, '背课文（改）');
    hwAddSave();
  });
  await page.waitForTimeout(700);
  const saved = await page.evaluate((id) => {
    var p = SITE_DATA.holidayHomeworks.find((x) => String(x.id) === String(id));
    return { found: !!p, due: p && p.items[0].tasks[2].due, text: p && p.items[0].tasks[0].text,
      zone: getComputedStyle(document.getElementById('hwEditZone')).display };
  }, pid);
  t('弹窗内设的截止时间保存进同一份数据', saved.found && saved.due === '2026-11-25T20:15', JSON.stringify(saved));
  t('弹窗内改的文字也保存了', saved.text === '背课文（改）', JSON.stringify(saved));
  t('保存后编辑区收起、回到查看', saved.zone === 'none', saved.zone);
  t('普通模式流程无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}
{
  const { ctx, page } = await openNormal(false);
  t('非管理员看不到「＋ 新增作业」', await page.evaluate(() => getComputedStyle(document.getElementById('hwAddBtn')).display === 'none'));
  await ctx.close();
}

/* ④ 全屏时钟：小时间在「返回」旁边 */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await ctx.newPage();
  await page.goto(BASE + '/clock.html?m=timer', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const r = await page.evaluate(() => {
    const g = (s) => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) }; };
    const back = g('#back'), now = g('#tmNow'), log = g('#logBtn');
    const hit = (a, c) => !(a.r <= c.l || a.l >= c.r || a.b <= c.t || a.t >= c.b);
    return { back, now, log, disp: getComputedStyle(document.getElementById('tmNow')).display,
      gap: now.l - back.r, sameRow: Math.abs(now.t - back.t) <= 4, ovBack: hit(now, back), ovLog: hit(now, log), txt: document.getElementById('tmNow').textContent };
  });
  t('计时页的小时间显示在左上角', r.disp === 'flex' && r.now.l < 200 && r.now.t < 60, JSON.stringify(r.now));
  t('紧挨「← 返回」右侧（间距 1~20px）', r.gap >= 1 && r.gap <= 20, String(r.gap));
  t('跟返回按钮同一行', r.sameRow, JSON.stringify({ nowT: r.now.t, backT: r.back.t }));
  t('不压住返回、也不压住「记录」', !r.ovBack && !r.ovLog, JSON.stringify({ ovBack: r.ovBack, ovLog: r.ovLog }));
  t('小时间每秒走字（HH:MM:SS）', /^\d{2}:\d{2}:\d{2}$/.test(r.txt), r.txt);
  await ctx.close();
}

await browser.close();
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
