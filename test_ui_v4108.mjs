/* v4.10.8 专项：考试看板只读接入 —— 查看全部 / 手动挑一场 / 大屏作业页限管理员 / 高中天数 / 下线板块 */
import { chromium } from '/root/.nvm/versions/node/v22.13.1/lib/node_modules/playwright/index.mjs';
const BASE = 'http://localhost:8112';
let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
};

const pad = (n) => (n < 10 ? '0' : '') + n;
const dayStr = (off) => {
  const d = new Date(Date.now() + off * 86400000);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};
const TODAY = dayStr(0), D1 = dayStr(1), D2 = dayStr(2);

/* 今天一场段考（跨 3 天），另外还有一场下个月的（只能手动挑） */
const DAYS = [
  { date: TODAY, isToday: true, items: [
    { date: TODAY, id: 'i1', name: '语文', start: '09:00', end: '11:30', major: '第二次段考', pinned: false },
    { date: TODAY, id: 'i2', name: '数学', start: '14:30', end: '16:30', major: '第二次段考', pinned: false },
  ] },
  { date: D1, isToday: false, items: [
    { date: D1, id: 'i3', name: '物理', start: '08:30', end: '09:45', major: '第二次段考', pinned: false },
  ] },
];
const ITEMS = [
  { id: 'i1', date: TODAY, start: '09:00', end: '11:30', name: '语文', major: '第二次段考', auto: true, pinned: false },
  { id: 'i2', date: TODAY, start: '14:30', end: '16:30', name: '数学', major: '第二次段考', auto: true, pinned: false },
  { id: 'i3', date: D1, start: '08:30', end: '09:45', name: '物理', major: '第二次段考', auto: true, pinned: false },
  { id: 'i9', date: '2026-12-20', start: '08:00', end: '09:30', name: '历史', major: '第三次月考', auto: false, pinned: false },
];
const HOMEWORK = { id: 'hw1', title: '本周作业', items: [
  { subject: '语文', tasks: [{ text: '文言文背诵' }] },
  { subject: '数学', tasks: [{ text: '试卷一张' }] },
] };

function mockApi(page, opt) {
  const o = opt || {};
  return page.route('**/api/**', (route) => {
    const u = route.request().url();
    const m = route.request().method();
    const J = (obj) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });

    if (u.includes('/api/exams')) {
      if (u.includes('action=pin')) {
        o.pinBody = JSON.parse(route.request().postData() || '{}');
        return J({ ok: true, ids: [o.pinBody.id], at: Date.now() });
      }
      if (u.includes('action=list')) {
        const items = (o.items || ITEMS).map(x => ({ ...x,
          pinned: o.pinnedIds ? o.pinnedIds.includes(x.id) : x.pinned }));
        return J({ ok: true, at: Date.now(), today: TODAY, base: 'https://examboard.dpdns.org',
          title: '第二次段考', cls: '5班', items, pins: [] });
      }
      if (u.includes('action=state')) {
        return J({ ok: true, cfg: { base: 'https://examboard.dpdns.org', classId: '', className: '' },
          kv: true, classes: [{ id: 'c1', name: '5班', gradeId: 'g1' }], pins: [],
          data: { at: Date.now(), title: '第二次段考', cls: '5班', srcAt: 1, dirty: false, pushedAt: 0, majors: [] } });
      }
      if (u.includes('action=sync')) return J({ ok: true, at: Date.now(), title: '第二次段考', cls: '5班', majors: 3 });
      return J({ ok: true, at: Date.now(), today: TODAY, days: o.days || DAYS,
        title: '第二次段考', cls: '5班', pins: [] });
    }
    if (u.includes('/api/island')) {
      return J({ ok: true, data: { on: true, startDate: '2026-09-01', endDate: '2027-01-30',
        enrollDate: '2025-09-01', term: '2026 年秋季 · 高二上', holidays: [] } });
    }
    if (u.includes('/auth?action=me')) {
      return J({ ok: true, user: { username: 'aibot', role: o.role || 'admin' } });
    }
    if (u.includes('/api/content')) {
      return J({ ok: true, items: { holiday_homeworks: { hw1: HOMEWORK }, announcements: [] } });
    }
    return J({ ok: true });
  });
}

async function openBig(page, opt) {
  await page.addInitScript((role) => {
    localStorage.setItem('cls_bigscreen', '1');
    localStorage.setItem('cls_welcome_v1', '1');
    localStorage.setItem('cls_login_guide_v1', '1');
    localStorage.setItem('cls_auth', JSON.stringify({ token: 'TESTTOKEN', user: { username: 'aibot', role } }));
  }, (opt && opt.role) || 'admin');
  await mockApi(page, opt);
  await page.goto(BASE + '/index.html?_r=' + Date.now() + '#/hw', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3600);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });

/* ============ 1. 大屏考试块：科目 + 时间 + 考试名称 ============ */
console.log('\n【1】大屏作业页：考试块带考试名称');
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();
  await openBig(page);
  const r = await page.evaluate(() => {
    const box = document.getElementById('bhwExam');
    if (!box) return { missing: true };
    return {
      missing: false,
      days: [...box.querySelectorAll('.bhex-day')].map(x => x.textContent.trim()),
      names: [...box.querySelectorAll('.bhex-day-m')].map(x => x.textContent.trim()),
      rows: [...box.querySelectorAll('.bhex-row')].map(x => ({
        sub: (x.querySelector('.bhex-sub') || {}).textContent || '',
        tm: (x.querySelector('.bhex-time') || {}).textContent || '',
      })),
      head: (box.querySelector('.bhex-h') || {}).textContent.trim(),
    };
  });
  t('考试块出现', !r.missing);
  t('标题给出场次与天数', /3\s*场/.test(r.head) && /2\s*天/.test(r.head), r.head);
  t('每一天的小标题带考试名称', r.names.length === 2 && r.names.every(x => x === '第二次段考'), JSON.stringify(r.names));
  t('第一天标题是「今天」', /今天/.test(r.days[0] || ''), r.days[0]);
  t('行内是科目 + 起止时间', r.rows.length === 3 && r.rows[0].sub === '语文' && /09:00.11:30/.test(r.rows[0].tm),
    JSON.stringify(r.rows[0]));
  await ctx.close();
}

/* ============ 2. 「考试看板」按钮 → 全部考试 + 加号 ============ */
console.log('\n【2】点名下方「考试看板」：列出全部考试，右侧加号');
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();
  const opt = {};
  await openBig(page, opt);

  const btn = await page.evaluate(() => {
    const b = document.getElementById('bhwExamAdd');
    if (!b) return { missing: true };
    return {
      missing: false,
      text: b.textContent.replace(/\s+/g, ''),
      shown: getComputedStyle(b).display !== 'none',
      afterPick: !!(b.previousElementSibling && b.previousElementSibling.classList.contains('bhw-pick')),
      h: Math.round(b.getBoundingClientRect().height),
    };
  });
  t('按钮存在且在随机点名下面', !btn.missing && btn.afterPick, JSON.stringify(btn));
  t('文案是「考试看板」', /考试看板/.test(btn.text || ''), btn.text);
  t('管理员可见，且是小按钮', btn.shown === true && btn.h > 0 && btn.h <= 40, btn.h + 'px');

  await page.click('#bhwExamAdd');
  await page.waitForTimeout(500);
  const panel = await page.evaluate(() => {
    const m = document.getElementById('bexMask');
    if (!m) return { missing: true };
    return {
      missing: false,
      go: (() => { const a = document.getElementById('bexGo'); return a ? { href: a.getAttribute('href'), text: a.textContent } : null; })(),
      tip: (document.getElementById('bexTip') || {}).textContent || '',
      groups: [...m.querySelectorAll('.bex-g')].map(x => x.textContent.trim()),
      rows: [...m.querySelectorAll('.bex-it')].map(x => ({
        sub: (x.querySelector('.bex-it-sub') || {}).textContent || '',
        tm: (x.querySelector('.bex-it-tm') || {}).textContent || '',
        add: !!x.querySelector('.bex-it-add'),
        on: !!x.querySelector('.bex-it-add.on'),
        auto: !!x.querySelector('.bex-it-on'),
      })),
    };
  });
  t('弹窗打开', !panel.missing);
  t('顶部有「前往考试看板」外链，指向 examboard', !!panel.go && /examboard\.dpdns\.org/.test(panel.go.href || ''),
    JSON.stringify(panel.go));
  t('列出全部 4 场，按日期分成 3 组', panel.rows.length === 4 && panel.groups.length === 3,
    panel.rows.length + '行 / ' + panel.groups.length + '组');
  t('今天那组标「今天」', /今天/.test(panel.groups[0] || ''), panel.groups[0]);
  t('每行有科目与起止时间', panel.rows[0].sub === '语文' && /09:00.11:30/.test(panel.rows[0].tm),
    JSON.stringify(panel.rows[0]));
  t('今天本来就会显示的三场标「已显示」、不给加号', panel.rows.slice(0, 3).every(x => x.auto && !x.add),
    JSON.stringify(panel.rows.slice(0, 3)));
  t('不是今天的（12/20 历史）给加号', panel.rows[3].add === true && panel.rows[3].auto === false,
    JSON.stringify(panel.rows[3]));
  t('提示里给出总场次', /共\s*4\s*场/.test(panel.tip || ''), panel.tip);

  /* 点加号 → 发 pin 请求 */
  await page.click('.bex-it-add');
  await page.waitForTimeout(600);
  t('点加号发出 pin 请求，body 带 id 与 on:true',
    !!opt.pinBody && opt.pinBody.action === 'pin' && opt.pinBody.id === 'i9' && opt.pinBody.on === true,
    JSON.stringify(opt.pinBody));
  await ctx.close();
}

/* ============ 3. 已挑的显示 ✓，再点移出 ============ */
console.log('\n【3】已挑的考试：显示 ✓，再点一次移出');
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();
  const opt = { pinnedIds: ['i9'] };
  await openBig(page, opt);
  await page.click('#bhwExamAdd');
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => {
    const last = [...document.querySelectorAll('.bex-it')].pop();
    const b = last && last.querySelector('.bex-it-add');
    return {
      pinned: last ? last.classList.contains('pinned') : false,
      on: b ? b.classList.contains('on') : false,
      txt: b ? b.textContent.trim() : '',
      title: b ? b.getAttribute('title') : '',
    };
  });
  t('已挑的那行高亮', r.pinned === true);
  t('按钮是 ✓ 且标了可移出', r.on === true && /✓/.test(r.txt) && /移出/.test(r.title || ''), JSON.stringify(r));

  await page.click('.bex-it:last-child .bex-it-add');
  await page.waitForTimeout(600);
  t('再点一次发 on:false', !!opt.pinBody && opt.pinBody.id === 'i9' && opt.pinBody.on === false,
    JSON.stringify(opt.pinBody));
  await ctx.close();
}

/* ============ 4. 大屏作业看板仅管理员 ============ */
console.log('\n【4】大屏作业看板：普通用户进不去');
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();
  await openBig(page, { role: 'student' });
  const st = await page.evaluate(() => {
    const hw = document.getElementById('bigHw');
    const tiles = [...document.querySelectorAll('.big-tile')].map(x => ({
      t: (x.querySelector('.bt-t') || {}).textContent || '',
      s: (x.querySelector('.bt-s') || {}).textContent || '',
    }));
    const hwTile = tiles.find(x => x.t === '作业查看') || {};
    return { hwShown: hw ? getComputedStyle(hw).display !== 'none' : false, sub: hwTile.s || '' };
  });
  t('学生打开 #/hw 不会进入作业页', st.hwShown === false);
  t('大屏首页作业卡标「仅管理员」', /仅管理员/.test(st.sub), st.sub);

  /* 点作业卡：仍在首页 */
  await page.evaluate(() => { const b = [...document.querySelectorAll('.big-tile')].find(x => /作业查看/.test(x.textContent)); if (b) b.click(); });
  await page.waitForTimeout(400);
  const still = await page.evaluate(() => {
    const hw = document.getElementById('bigHw');
    return hw ? getComputedStyle(hw).display === 'none' : true;
  });
  t('点击作业卡也不会进入', still === true);
  await ctx.close();
}

/* ============ 5. 学期卡：已步入高中在本学期已开学上面 ============ */
console.log('\n【5】大屏右下角：已步入高中 N 天');
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();
  await openBig(page);
  const r = await page.evaluate(() => {
    const box = document.getElementById('bhwProg');
    if (!box) return { missing: true };
    const rows = [...box.querySelectorAll('.bhw-prog-row')].map(x => ({
      k: (x.querySelector('span') || {}).textContent || '',
      v: (x.querySelector('b') || {}).textContent || '',
    }));
    return { missing: false, rows };
  });
  t('进度卡有内容', !r.missing && r.rows.length >= 3, JSON.stringify(r.rows));
  t('第一行是「已步入高中」', r.rows[0] && /已步入高中/.test(r.rows[0].k), r.rows[0] && r.rows[0].k);
  t('第二行是「本学期已开学」', r.rows[1] && /本学期已开学/.test(r.rows[1].k), r.rows[1] && r.rows[1].k);
  /* 2025-09-01 入学 → 到今天是第几天，只校验是正整数、带「天」 */
  t('高中天数是个正经天数', /^\d+天$/.test(r.rows[0].v || ''), r.rows[0] && r.rows[0].v);
  await ctx.close();
}

/* ============ 6. 后台考试同步页：只读 ============ */
console.log('\n【6】后台「考试同步」：只读，无账号密码、无写回');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('cls_welcome_v1', '1');
    localStorage.setItem('cls_auth', JSON.stringify({ token: 'TESTTOKEN', user: { username: 'aibot', role: 'admin' } }));
  });
  await mockApi(page, {});
  await page.goto(BASE + '/admin.html?_r=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2600);
  await page.evaluate(() => { try { go('exams'); } catch (e) {} });
  await page.waitForTimeout(2200);

  const r = await page.evaluate(() => {
    const v = document.getElementById('view');
    return {
      hasBase: !!document.getElementById('exBase'),
      hasUser: !!document.getElementById('exUser'),
      hasPass: !!document.getElementById('exPass'),
      hasSync: !!document.getElementById('exSync'),
      hasList: !!document.getElementById('exList'),
      rows: document.querySelectorAll('#exList tbody tr').length,
      addBtns: document.querySelectorAll('#exList [data-expin]').length,
      autoTxt: document.querySelectorAll('#exList tbody tr').length
        ? [...document.querySelectorAll('#exList tbody tr')].map(tr => tr.lastElementChild.textContent.trim())
        : [],
      txt: v ? v.textContent.replace(/\s+/g, ' ') : '',
    };
  });
  t('有看板地址输入框', r.hasBase === true);
  t('不再要账号密码', r.hasUser === false && r.hasPass === false);
  t('有「立即同步」与考试列表', r.hasSync === true && r.hasList === true);
  t('列出全部 4 场', r.rows === 4, String(r.rows));
  t('只有非今天的给「加入」按钮（1 个）', r.addBtns === 1, String(r.addBtns));
  t('今天自动显示的标「已显示」', r.autoTxt.slice(0, 3).every(x => /已显示/.test(x)), JSON.stringify(r.autoTxt));
  t('页面不再出现「写回」字样', !/写回/.test(r.txt));
  await ctx.close();
}

/* ============ 7. 首页不再有被下线的板块 ============ */
console.log('\n【7】首页：学习资料 / 私人云盘 / 排行榜 / 屏幕批注 已下线');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('cls_welcome_v1', '1');
    localStorage.setItem('cls_login_guide_v1', '1');
  });
  await mockApi(page, {});
  await page.goto(BASE + '/?t=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3600);
  const r = await page.evaluate(() => {
    const txt = document.body.innerText || '';
    return {
      cats: [...document.querySelectorAll('#sideCats .side-btn')].map(x => x.textContent.replace(/\s+/g, '')),
      hasStudy: /学习资料/.test(txt),
      hasDisk: /私人云盘/.test(txt),
      hasRank: /排行榜/.test(txt),
      hasAnno: /屏幕批注/.test(txt),
      hasProfile: (window.SITE_DATA && SITE_DATA.links || []).some(l => Number(l.id) === 10),
    };
  });
  t('侧栏没有「学习资料」', !r.hasStudy && !r.cats.some(x => /学习资料/.test(x)), JSON.stringify(r.cats));
  t('没有「私人云盘」', !r.hasDisk);
  t('没有「排行榜」', !r.hasRank);
  t('没有「屏幕批注」', !r.hasAnno);
  t('「个人资料查询」保留', r.hasProfile === true);
  await ctx.close();
}

await browser.close();
console.log('\n' + '='.repeat(52));
console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
console.log('='.repeat(52));
process.exit(fail ? 1 : 0);
