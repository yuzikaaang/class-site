/* v4.10.6 专项：考试看板接入 —— 大屏左栏考试块 · 跨天分组 · 新增考试 · 后台同步页 */
import { chromium } from '/root/.nvm/versions/node/v22.13.1/lib/node_modules/playwright/index.mjs';
const BASE = 'http://localhost:8112';
let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
};

const pad = (n) => (n < 10 ? '0' : '') + n;
function dayStr(off) {
  const d = new Date(Date.now() + off * 86400000);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/* 一场跨 3 天的段考：今天 2 场、明天 1 场、后天 1 场 */
const TODAY = dayStr(0);
const D1 = dayStr(1);
const D2 = dayStr(2);
const DAYS = [
  { date: TODAY, isToday: true, items: [
    { date: TODAY, name: '语文', start: '09:00', end: '11:30', major: '第二次段考' },
    { date: TODAY, name: '数学', start: '14:30', end: '16:30', major: '第二次段考' },
  ] },
  { date: D1, isToday: false, items: [
    { date: D1, name: '物理', start: '08:30', end: '09:45', major: '第二次段考' },
  ] },
  { date: D2, isToday: false, items: [
    { date: D2, name: '化学', start: '14:30', end: '15:45', major: '第二次段考' },
  ] },
];

const HOMEWORK = {
  id: 'hw1', title: '本周作业',
  items: [
    { subject: '语文', tasks: [{ text: '文言文背诵' }] },
    { subject: '数学', tasks: [{ text: '试卷一张' }] },
    { subject: '英语', tasks: [{ text: '单词默写' }] },
  ],
};

function routeAll(page, opt) {
  const o = opt || {};
  return page.route('**/api/**', (route) => {
    const u = route.request().url();
    if (u.includes('/api/exams')) {
      if (o.examAbort) return route.abort();
      if (u.includes('action=add') && route.request().method() === 'POST') {
        o.lastAdd = route.request().postData();
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ ok: true, id: 'm_new', name: '数学', pushed: true, note: '', dirty: false }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, at: Date.now(), today: TODAY, days: o.days || DAYS, title: '第二次段考', cls: '5班', dirty: false }) });
    }
    if (u.includes('/api/island')) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { on: true, startDate: '2026-09-01', holidays: [] } }) });
    }
    if (u.includes('/auth?action=me')) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, user: { username: 'aibot', role: o.role || 'admin' } }) });
    }
    if (u.includes('/api/content')) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, items: { holiday_homeworks: { hw1: HOMEWORK } } }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
}

async function openBig(page, opt) {
  await page.addInitScript(() => {
    localStorage.setItem('cls_bigscreen', '1');
    localStorage.setItem('cls_welcome_v1', '1');
    localStorage.setItem('cls_login_guide_v1', '1');
    localStorage.setItem('cls_auth', JSON.stringify({ token: 'TESTTOKEN', user: { username: 'aibot', role: 'admin' } }));
  });
  await routeAll(page, opt);
  await page.goto(BASE + '/index.html?_r=' + Date.now() + '#/hw', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3600);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });

/* ============ 1. 大屏作业页左栏显示今天（含跨天）的考试 ============ */
console.log('\n【1】大屏作业页：左栏最上面一块考试，一行一场，左科目右时间');
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();
  await openBig(page);

  const r = await page.evaluate(() => {
    const box = document.getElementById('bhwExam');
    const colA = document.getElementById('bhwColA');
    if (!box) return { missing: true };
    const rows = [...box.querySelectorAll('.bhex-row')].map(x => ({
      sub: (x.querySelector('.bhex-sub') || {}).textContent || '',
      time: (x.querySelector('.bhex-time') || {}).textContent || '',
      cls: x.className,
      subX: x.querySelector('.bhex-sub') ? x.querySelector('.bhex-sub').getBoundingClientRect().left : 0,
      timeX: x.querySelector('.bhex-time') ? x.querySelector('.bhex-time').getBoundingClientRect().right : 0,
    }));
    return {
      missing: false,
      first: colA ? colA.firstElementChild === box : false,
      visible: getComputedStyle(box).display !== 'none',
      head: (box.querySelector('.bhex-h') || {}).textContent || '',
      rows,
      days: [...box.querySelectorAll('.bhex-day')].map(x => x.textContent.trim()),
    };
  });

  t('考试块出现在左栏', !r.missing && r.visible, r.missing ? 'missing' : 'ok');
  t('钉在左栏最上面', r.first === true);
  t('标题写「考试安排」并给出场次/天数', /考试安排/.test(r.head) && /4\s*场/.test(r.head) && /3\s*天/.test(r.head), r.head);
  t('一共 4 行（一天一场的也是一行一场）', r.rows.length === 4, String(r.rows.length));
  t('第一行：科目「语文」+ 时间 09:00–11:30', r.rows[0] && r.rows[0].sub === '语文' && /09:00.11:30/.test(r.rows[0].time), JSON.stringify(r.rows[0]));
  t('行内左科目、右时间（科目靠左、时间靠右）', r.rows[0] && r.rows[0].subX < r.rows[0].timeX - 40, r.rows[0] ? Math.round(r.rows[0].subX) + '<' + Math.round(r.rows[0].timeX) : '');
  t('跨天分别有小标题（今天 / 明天 / 后天）', r.days.length === 3, JSON.stringify(r.days));
  t('今天那组带「今天」字样', r.days[0] && /今天/.test(r.days[0]), r.days[0]);
  await ctx.close();
}

/* ============ 2. 今天没有考试 → 整块不出现 ============ */
console.log('\n【2】今天没有考试：不留空白盒子');
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();
  await openBig(page, { days: [] });
  const has = await page.evaluate(() => !!document.getElementById('bhwExam'));
  t('没有考试时不渲染考试块', has === false);
  await ctx.close();
}

/* ============ 3. 断网时用本机缓存 ============ */
console.log('\n【3】教室断网：用上次缓存的考试安排');
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();
  await page.addInitScript((payload) => {
    localStorage.setItem('cls_bigscreen', '1');
    localStorage.setItem('cls_welcome_v1', '1');
    localStorage.setItem('cls_big_exam_v1', JSON.stringify(payload));
  }, { at: Date.now() - 3600e3, today: TODAY, days: DAYS });
  await routeAll(page, { examAbort: true });
  await page.goto(BASE + '/index.html?_r=' + Date.now() + '#/hw', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  const r = await page.evaluate(() => {
    const b = document.getElementById('bhwExam');
    return b ? { rows: b.querySelectorAll('.bhex-row').length } : null;
  });
  t('接口挂了仍然显示缓存的 4 行', !!r && r.rows === 4, JSON.stringify(r));
  await ctx.close();
}

/* ============ 4. 点名下面的「新增考试」 ============ */
console.log('\n【4】随机点名下面：新增考试按钮 → 表单 → 写回');
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();
  const opt = {};
  await openBig(page, opt);

  const btn = await page.evaluate(() => {
    const b = document.getElementById('bhwExamAdd');
    if (!b) return { missing: true };
    const pr = b.previousElementSibling;
    return {
      missing: false,
      shown: getComputedStyle(b).display !== 'none',
      afterPick: !!pr && pr.classList.contains('bhw-pick'),
      text: b.textContent.replace(/\s+/g, ''),
      h: Math.round(b.getBoundingClientRect().height),
    };
  });
  t('按钮存在且在随机点名下面', !btn.missing && btn.afterPick, JSON.stringify(btn));
  t('管理员能看到', btn.shown === true);
  t('按钮是小号的（高度 ≤ 40）', btn.h > 0 && btn.h <= 40, btn.h + 'px');
  t('文案是「新增考试」', /新增考试/.test(btn.text || ''), btn.text);

  await page.click('#bhwExamAdd');
  await page.waitForTimeout(200);
  const form = await page.evaluate(() => {
    const m = document.getElementById('bexMask');
    if (!m) return { missing: true };
    return {
      missing: false,
      sub: !!document.getElementById('bexSub'),
      date: (document.getElementById('bexDate') || {}).value || '',
      st: (document.getElementById('bexSt') || {}).value || '',
    };
  });
  t('点开有表单，日期默认今天', !form.missing && form.sub && form.date === TODAY, JSON.stringify(form));

  /* 结束早于开始 → 不提交，给提示 */
  await page.fill('#bexSub', '数学');
  await page.fill('#bexSt', '10:00');
  await page.fill('#bexEn', '09:00');
  await page.click('#bexSave');
  await page.waitForTimeout(200);
  const msg = await page.evaluate(() => (document.getElementById('bexMsg') || {}).textContent || '');
  t('时间反了要拦住', /结束时间要晚于开始时间/.test(msg), msg);
  t('被拦住时没有发请求', !opt.lastAdd, String(opt.lastAdd));

  /* 改成合法时间 → 提交并带 push:true */
  await page.fill('#bexEn', '11:00');
  await page.click('#bexSave');
  await page.waitForTimeout(600);
  const body = opt.lastAdd ? JSON.parse(opt.lastAdd) : null;
  t('提交到 /exams?action=add', !!body && body.action === 'add', String(opt.lastAdd).slice(0, 80));
  t('提交内容含科目/日期/起止/写回标记', !!body && body.subject === '数学' && body.date === TODAY
    && body.start === '10:00' && body.end === '11:00' && body.push === true, JSON.stringify(body));
  const closed = await page.evaluate(() => !document.getElementById('bexMask'));
  t('写回成功后自动关闭弹窗', closed === true);
  await ctx.close();
}

/* ============ 5. 普通同学看不到这个按钮 ============ */
console.log('\n【5】非管理员：新增考试按钮隐藏');
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();
  await openBig(page, { role: 'student' });
  const shown = await page.evaluate(() => {
    const b = document.getElementById('bhwExamAdd');
    return b ? getComputedStyle(b).display : 'missing';
  });
  t('学生身份看不到「新增考试」', shown === 'none', shown);
  await ctx.close();
}

/* ============ 6. 后台「考试同步」页 ============ */
console.log('\n【6】后台考试同步页：状态 / 同步 / 写回 / 新增');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('cls_welcome_v1', '1');
    localStorage.setItem('cls_auth', JSON.stringify({ token: 'TESTTOKEN', user: { username: 'aibot', role: 'admin' } }));
  });
  await page.route('**/api/**', (route) => {
    const u = route.request().url();
    if (u.includes('/api/exams')) {
      if (u.includes('action=state')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          ok: true,
          cfg: { base: 'https://examboard.dpdns.org', user: 'admin', hasPass: true, classId: '', className: '', autoPush: false },
          kv: true,
          classes: [{ id: 'c1', name: '5班', gradeId: 'g1' }],
          data: { at: Date.now(), title: '第二次段考', cls: '5班', srcAt: 123, dirty: false, pushedAt: 0,
            majors: [{ id: 'm1', name: '第二次段考', temporary: false, local: false, startAt: Date.now(), endAt: Date.now(), count: 2,
              items: [{ id: 'i1', name: '语文', startTime: TODAY + 'T09:00', endTime: TODAY + 'T11:30' }] },
            { id: 'm2', name: '数学（临时）', temporary: true, local: true, startAt: Date.now(), endAt: Date.now(), count: 1,
              items: [{ id: 'i2', name: '数学', startTime: TODAY + 'T14:00', endTime: TODAY + 'T15:00' }] }] },
        }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    if (u.includes('/auth?action=me')) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, user: { username: 'aibot', role: 'admin' } }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.goto(BASE + '/admin.html?_r=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2600);
  await page.evaluate(() => { try { go('exams'); } catch (e) {} });
  await page.waitForTimeout(2200);

  const r = await page.evaluate(() => {
    const v = document.getElementById('view');
    const txt = v ? v.textContent : '';
    return {
      txt: txt.replace(/\s+/g, ' ').slice(0, 400),
      navHas: [...document.querySelectorAll('#nav [data-page]')].some(b => b.dataset.page === 'exams'),
      hasBase: !!document.getElementById('exBase'),
      hasSync: !!document.getElementById('exSync'),
      hasPush: !!document.getElementById('exPush'),
      hasAdd: !!document.getElementById('exAdd'),
      stat: (document.getElementById('exStat') || {}).textContent || '',
      clsOpts: [...document.querySelectorAll('#exCls option')].map(o => o.textContent),
      listRows: document.querySelectorAll('#exList tbody tr').length,
      delBtns: document.querySelectorAll('#exList [data-exdel]').length,
    };
  });
  t('侧栏有「考试同步」入口', r.navHas === true);
  t('页面有地址 / 账号输入框', r.hasBase === true);
  t('有「立即同步」「写回考试看板」按钮', r.hasSync && r.hasPush);
  t('有「新增考试」表单', r.hasAdd === true);
  t('状态区读到标题与场次', /第二次段考/.test(r.stat) && /2\s*场/.test(r.stat.replace(/\s/g, '')), r.stat.replace(/\s+/g, ' ').slice(0, 60));
  t('班级下拉有云端班级', r.clsOpts.some(x => /5班/.test(x)), JSON.stringify(r.clsOpts));
  t('列出了现有考试（2 行）', r.listRows === 2, String(r.listRows));
  t('只有本站新增的才给删除按钮', r.delBtns === 1, String(r.delBtns));
  await ctx.close();
}

await browser.close();
console.log('\n' + '='.repeat(52));
console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
console.log('='.repeat(52));
process.exit(fail ? 1 : 0);
