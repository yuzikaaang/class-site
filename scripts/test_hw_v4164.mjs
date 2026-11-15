/* v4.16.4 专项：长开不卡（计时对齐）、考试逐科变灰、截止提醒与隐藏、
   看板设置（云端）、两段式预设截止时间、刷新连带右侧、上传署名。
   站主原话：
     「过了一个小时两个小时之后，整个页面会变得比较卡一点点。包括那个时钟计时，
       它有时候都开始跳秒了，虽然说显示秒数是正确，但是它这个秒就是时快时慢」
     「不一定说一定要整天过完了才变整天的，你只要考完一科就变一科」
     「距离截止时间还剩前 n 分钟的时候，对应科目的作业要有一个强调提醒……框出来 + 动画；
       过了截止时间 n 分钟后，隐藏该项。这两个 n 都可以在设置里面修改」
     「预设截止时间改成分为时间点和时间……先点明天，再点 6:50」
     「刷新的时候要把右侧也都刷新一下……比如我修改了班级岛里面的今日事项」
     「作业上传可以不匿名……实名上传，这个是没关系的」
*/
import { chromium } from 'playwright-core';

const EXE = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://127.0.0.1:8899';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x === undefined ? '' : ' → ' + JSON.stringify(x))); } };

const pad = n => (n < 10 ? '0' : '') + n;
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = ymd(new Date());
const isoLocal = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

async function open(opts = {}) {
  const { w = 1440, h = 900, edit = true } = opts;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('  [pageerror]', e.message));

  const now = Date.now();
  const dueSoon = isoLocal(new Date(now + 10 * 60000));      /* 还差 10 分钟 */
  const dueOver = isoLocal(new Date(now - 10 * 60000));      /* 刚过 10 分钟 */
  const dueOld = isoLocal(new Date(now - 120 * 60000));      /* 过了 2 小时 */

  const seen = { posts: [], prefs: [], islandGets: 0, contentGets: 0 };
  let cloudPrefs = { alertMin: 30, hideMin: 60 };   /* 云端那份设置的活副本 */

  const hw = {
    id: 'w', title: '本周', start: '2026-11-09', end: '2026-11-15',
    by: '余子康', at: new Date(now - 3600000).toISOString(),
    items: [
      { subject: '语文', tasks: [
        { text: '背诵课文', due: dueSoon },
        { text: '默写第三单元', due: dueOver },
        { text: '整理错题本', due: dueOld },
        { text: '阅读课外书' }
      ] },
      { subject: '数学', tasks: [{ text: '练习册 P44' }] }
    ]
  };

  await p.route('**/api/**', async r => {
    const u = r.request().url();
    const J = (o, st = 200) => r.fulfill({ status: st, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.includes('/api/exams')) {
      return J({ ok: true, today, pins: { majors: [], days: [], items: [] }, groups: [{
        id: 'g1', name: '月考', start: '08:00',
        days: [{ date: today, items: [
          { name: '语文', start: '08:00', end: '10:00' },
          { name: '物理', start: '23:50', end: '23:59' }
        ] }]
      }] });
    }
    if (u.includes('/api/island')) {
      seen.islandGets++;
      return J({ ok: true, data: { on: 1, startDate: '2026-09-01', tasks: [], photo: '' } });
    }
    if (u.includes('/api/content')) {
      if (u.includes('action=hw-prefs')) {
        let b = {}; try { b = JSON.parse(r.request().postData() || '{}'); } catch (e) {}
        seen.prefs.push(b);
        const pr = b.prefs || {};
        cloudPrefs = { alertMin: Number(pr.alertMin) || 0, hideMin: Number(pr.hideMin) || 0 };
        return J({ ok: true, prefs: cloudPrefs, serverTime: Date.now() });
      }
      if (u.includes('action=hw-save')) {
        let b = {}; try { b = JSON.parse(r.request().postData() || '{}'); } catch (e) {}
        seen.posts.push(b);
        return J({ ok: true, list: [hw], count: 1, by: b.by || '', serverTime: Date.now() });
      }
      if (r.request().method() === 'POST') {
        let b = {}; try { b = JSON.parse(r.request().postData() || '{}'); } catch (e) {}
        seen.posts.push(b);
        return J({ ok: true, list: [hw] });
      }
      seen.contentGets++;
      return J({ ok: true, items: { holiday_homeworks: [hw], announcements: [], hw_settings: cloudPrefs } });
    }
    if (u.includes('/auth?action=me')) return J({ ok: true, user: { id: 4, username: 'aibot', displayName: '余子康', role: 'admin' } });
    return J({ ok: true });
  });

  await p.addInitScript((ed) => {
    try {
      localStorage.setItem('cls_welcome_v1', '1');
      localStorage.setItem('cls_login_guide_v1', '1');
      /* 站主要看的是只读态的效果（收起、变灰都只在这一态出现），
         所以折叠相关的用例要显式关掉编辑开关 */
      if (ed) localStorage.setItem('cls_hw_edit', '1'); else localStorage.removeItem('cls_hw_edit');
    } catch (e) {}
  }, edit);

  await p.goto(BASE + '/index.html?big=1&_r=' + Date.now(), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2600);
  await p.evaluate(() => {
    window.isAdmin = () => true;
    /* 模拟管理员登录：署名要取这个人的名字 */
    try {
      AUTH.token = 'test-token';
      AUTH.user = { id: 4, username: 'aibot', displayName: '余子康', role: 'admin' };
    } catch (e) {}
    ['popMask', 'loginGuideMask'].forEach(id => { const e = document.getElementById(id); if (e) e.remove(); });
    BIG.openHw();
  });
  await p.waitForTimeout(1400);
  return { ctx, p, seen, hw };
}

/* ===================== ① 考试：考完一科灰一科 ===================== */
console.log('\n① 考试卡按单场结束时间变灰');
{
  const { ctx, p } = await open();
  const rows = await p.evaluate(() => {
    const box = document.getElementById('bhwExam');
    if (!box) return { found: false };
    return {
      found: true,
      rows: [...box.querySelectorAll('.bhex-row')].map(el => ({
        txt: el.textContent.replace(/\s+/g, ' ').trim(),
        off: el.classList.contains('bhex-off')
      })),
      dayPast: [...box.querySelectorAll('.bhex-date')].map(el => el.classList.contains('bhex-past'))
    };
  });
  ok('考试卡渲染出来了', rows.found, rows);
  const lan = (rows.rows || []).find(r => /语文/.test(r.txt));
  const phy = (rows.rows || []).find(r => /物理/.test(r.txt));
  ok('上午 8:00–10:00 的语文已经变灰', !!lan && lan.off, lan);
  ok('晚上 23:50 的物理还没变灰', !!phy && !phy.off, phy);
  ok('整天还没结束，日期标题不灰', Array.isArray(rows.dayPast) && rows.dayPast.every(v => v === false), rows.dayPast);
  await ctx.close();
}

/* ===================== ② 截止提醒：框出来 + 还剩多少 ===================== */
console.log('\n② 截止前 n 分钟强调、截止后 n 分钟收起');
{
  const { ctx, p } = await open({ edit: false });
  const st = await p.evaluate(() => {
    const tasks = [...document.querySelectorAll('#bhwColA .bhw-task,#bhwColB .bhw-task,#bhwOther .bhw-task')];
    const pick = kw => tasks.find(el => (el.textContent || '').indexOf(kw) >= 0);
    const t1 = pick('背诵课文'), t2 = pick('默写第三单元');
    const hidden = document.querySelector('.bhw-duehidden');
    const t3inHidden = !!(hidden && (hidden.textContent || '').indexOf('整理错题本') >= 0);
    const t3inBody = !!tasks.filter(el => !hidden || !hidden.contains(el))
      .find(el => (el.textContent || '').indexOf('整理错题本') >= 0);
    const fold = document.querySelector('.bhw-duefold');
    return {
      soon: t1 ? t1.classList.contains('due-soon') : null,
      soonTxt: t1 ? (t1.querySelector('.bhw-dueleft') || {}).textContent || '' : '',
      justOver: t2 ? { over: t2.classList.contains('over'), soon: t2.classList.contains('due-soon') } : null,
      oldHidden: t3inHidden && !t3inBody,
      foldTxt: fold ? fold.textContent.replace(/\s+/g, ' ').trim() : ''
    };
  });
  ok('还差 10 分钟的项被框出来（due-soon）', st.soon === true, st);
  ok('同时写明还剩多少时间', /还剩/.test(st.soonTxt), st.soonTxt);
  ok('刚过点 10 分钟的仍留在正文，标为已截止、不再闪', !!st.justOver && st.justOver.over && !st.justOver.soon, st.justOver);
  ok('过了 2 小时的收进「已截止」折叠里', st.oldHidden === true && /已截止/.test(st.foldTxt), st);
  await ctx.close();
}

/* ===================== ③ 设置面板：两个 n 存云端 ===================== */
console.log('\n③ 看板设置：本周起止 + 两个阈值，阈值上传云端');
{
  const { ctx, p, seen } = await open();
  const opened = await p.evaluate(() => {
    BIG.hwCfgOpen();
    const m = document.getElementById('bhwCfgMask');
    return {
      show: !!(m && m.classList.contains('show')),
      alert: (document.getElementById('bhwCfgAlert') || {}).value,
      hide: (document.getElementById('bhwCfgHide') || {}).value,
      by: (document.getElementById('bhwCfgBy') || {}).textContent || '',
      start: (document.getElementById('bhwCfgStart') || {}).value
    };
  });
  ok('设置面板打开了', opened.show === true, opened);
  ok('两个阈值按当前值预填（30 / 60）', String(opened.alert) === '30' && String(opened.hide) === '60', opened);
  ok('面板里写明这一期最后是谁改的', /余子康/.test(opened.by), opened.by);
  ok('本周起止也带进来了', opened.start === '2026-11-09', opened.start);

  await p.evaluate(() => {
    document.getElementById('bhwCfgAlert').value = '5';
    document.getElementById('bhwCfgHide').value = '15';
    BIG.hwCfgSave();
  });
  await p.waitForTimeout(900);
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('cls_hw_settings') || 'null'));
  ok('本机设置已更新为 5 / 15', saved && saved.alertMin === 5 && saved.hideMin === 15, saved);
  ok('设置发到了云端（hw-prefs）', seen.prefs.length > 0 && Number(seen.prefs[0].prefs.alertMin) === 5, seen.prefs[0]);

  await p.waitForTimeout(600);
  const after = await p.evaluate(() => {
    const tasks = [...document.querySelectorAll('#bhwColA .bhw-task,#bhwColB .bhw-task,#bhwOther .bhw-task')];
    const t1 = tasks.find(el => (el.textContent || '').indexOf('背诵课文') >= 0);
    return { soon: t1 ? t1.classList.contains('due-soon') : null, total: tasks.length };
  });
  ok('提醒窗口收紧到 5 分钟后，还差 10 分钟的那项不再闪', after.soon === false, after);
  await ctx.close();
}

/* ===================== ④ 两段式预设截止时间 ===================== */
console.log('\n④ 预设截止时间：先点日期，再点时间点');
{
  const { ctx, p } = await open();
  await p.evaluate(() => { BIG.dueOpen(0, 3); });
  await p.waitForTimeout(300);
  const open1 = await p.evaluate(() => {
    const m = document.getElementById('bhwDueMask');
    return { show: !!(m && m.classList.contains('show')), days: document.querySelectorAll('[data-due-day]').length,
      times: document.querySelectorAll('[data-due-time]').length };
  });
  ok('截止弹层打开，日期 3 个、时间点 3 个', open1.show && open1.days === 3 && open1.times === 3, open1);

  await p.evaluate(() => {
    const d = [...document.querySelectorAll('[data-due-day]')].find(b => b.getAttribute('data-due-day') === '1');
    d.click();
  });
  await p.waitForTimeout(200);
  const afterDay = await p.evaluate(() => ({
    v: document.getElementById('bhwDueInput').value,
    on: [...document.querySelectorAll('[data-due-day].on')].map(b => b.textContent.trim()),
    hint: (document.getElementById('bhwDueHint') || {}).textContent || ''
  }));
  ok('点「明天」后日期落到明天、并高亮', /^\d{4}-\d{2}-\d{2}T22:00$/.test(afterDay.v) && afterDay.on.join() === '明天', afterDay);
  ok('下方提示说清楚是明天', /明天/.test(afterDay.hint), afterDay.hint);

  await p.evaluate(() => {
    const t = [...document.querySelectorAll('[data-due-time]')].find(b => b.getAttribute('data-due-time') === '18:50');
    t.click();
  });
  await p.waitForTimeout(200);
  const afterTime = await p.evaluate(() => ({
    v: document.getElementById('bhwDueInput').value,
    on: [...document.querySelectorAll('[data-due-time].on')].map(b => b.textContent.trim()),
    hint: (document.getElementById('bhwDueHint') || {}).textContent || ''
  }));
  ok('再点「18:50」→ 时间点是明天 18:50', /T18:50$/.test(afterTime.v), afterTime);
  ok('时间点高亮，提示同步更新', afterTime.on.join() === '18:50' && /18:50/.test(afterTime.hint), afterTime);

  /* 输入框仍可直接改（比如 6:45） */
  await p.evaluate(() => {
    const inp = document.getElementById('bhwDueInput');
    inp.value = inp.value.replace('18:50', '18:45');
    BIG.dueHint();
  });
  const edited = await p.evaluate(() => (document.getElementById('bhwDueHint') || {}).textContent || '');
  ok('在输入框里改成 18:45，提示跟着变', /18:45/.test(edited), edited);
  await ctx.close();
}

/* ===================== ⑤ 刷新连带右侧 ===================== */
console.log('\n⑤ 点刷新：右侧今日事项一起重新拉');
{
  const { ctx, p, seen } = await open();
  const before = seen.islandGets;
  await p.evaluate(() => { BIG.hwRefreshNow(); });
  await p.waitForTimeout(1500);
  ok('刷新会再拉一次班级岛（右侧数据源）', seen.islandGets > before, { before, after: seen.islandGets });
  const applied = await p.evaluate(() => {
    /* 刷新时同一次请求回来的其它键也要应用上 */
    return typeof window.applyCloudContent === 'function';
  });
  ok('云端内容应用函数在位', applied === true, applied);
  await ctx.close();
}

/* ===================== ⑥ 上传署名 ===================== */
console.log('\n⑥ 上传不再匿名');
{
  const { ctx, p, seen } = await open();
  await p.evaluate(() => {
    const l = BIG.hwList();
    l[0].items[0].tasks[0].text = '背诵课文（改）';
    BIG.touch();
  });
  await p.waitForTimeout(2600);
  ok('上传请求带上了署名', seen.posts.length > 0 && !!seen.posts[0].by, seen.posts[0] && seen.posts[0].by);
  ok('署名取自当前登录用户', seen.posts.length > 0 && /余子康/.test(String(seen.posts[0].by)), seen.posts[0] && seen.posts[0].by);
  await ctx.close();
}

/* ===================== ⑦ 计时对齐（源码口径 + 运行验证） ===================== */
console.log('\n⑦ 计时不再累积漂移');
{
  const fs = await import('fs');
  const src = fs.readFileSync(new URL('../big.js', import.meta.url), 'utf8');
  ok('改用「对齐到下一个整秒」的自排队', /1000 - \(Date\.now\(\) % 1000\) \+ 6/.test(src), null);
  ok('秒数没变就不写 DOM', /if\(d\.getSeconds\(\) === lastSec\) return;/.test(src), null);
  ok('倒计时同一套口径', /BIG\._cdRun = 1;/.test(src), null);
  ok('分贝仪降到 400 毫秒', /setInterval\(dbTick, 400\)/.test(src), null);
  ok('换考试节点时摘掉旧观察器', /_exRo\.unobserve\(old\)/.test(src), null);

  const { ctx, p } = await open();
  const t1 = await p.evaluate(() => (document.getElementById('bhwClockT') || {}).textContent || '');
  await p.waitForTimeout(2100);
  const t2 = await p.evaluate(() => (document.getElementById('bhwClockT') || {}).textContent || '');
  ok('大屏时钟还在正常走秒', !!t1 && !!t2 && t1 !== t2, { t1, t2 });
  await ctx.close();
}

await browser.close();
console.log('\n合计 ' + pass + ' 过 / ' + fail + ' 未过');
process.exit(fail ? 1 : 0);
