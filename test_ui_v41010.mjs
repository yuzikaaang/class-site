/* v4.10.10 专项：考试看板筛选与折叠、作业看板三层排布、三级挑选、刷新与缓存 */
import { chromium } from '/root/.nvm/versions/node/v22.13.1/lib/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8112';
let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
};

const pad = (n) => (n < 10 ? '0' : '') + n;
const dstr = (off) => {
  const d = new Date(Date.now() + off * 86400000);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};
const WD = (s) => '周' + '日一二三四五六'[new Date(s + 'T00:00:00').getDay()];
const T = dstr(0), Y = dstr(-1), D1 = dstr(1), D2 = dstr(2);

const MAJOR = {
  id: 'm1', name: '高二上第二次段考', temporary: false,
  start: T, end: D1, daysN: 2, count: 6, onCnt: 0, allOn: false, anyOn: false, auto: true,
  days: [
    { date: T, wd: WD(T), onCnt: 0, allOn: false, anyOn: false, items: [
      { id: 'i1', name: '语文', start: '09:00', end: '11:30', pin: false, by: '' },
      { id: 'i2', name: '数学', start: '14:30', end: '16:30', pin: false, by: '' },
    ] },
    { date: D1, wd: WD(D1), onCnt: 0, allOn: false, anyOn: false, items: [
      { id: 'i3', name: '物理', start: '08:30', end: '09:45', pin: false, by: '' },
      { id: 'i4', name: '外语', start: '10:00', end: '12:00', pin: false, by: '' },
      { id: 'i5', name: '化学', start: '14:30', end: '15:45', pin: false, by: '' },
      { id: 'i6', name: '生物', start: '15:50', end: '17:05', pin: false, by: '' },
    ] },
  ],
};

/* 昨天的周测：已经挑了，用来验证「压暗 + 合并 + 6 科截断」 */
const PAST = {
  id: 'm2', name: '数学周测', temporary: false,
  start: Y, end: Y, daysN: 1, count: 2, onCnt: 2, allOn: true, anyOn: true, auto: false,
  days: [
    { date: Y, wd: WD(Y), onCnt: 2, allOn: true, anyOn: true, items: [
      { id: 'p1', name: '数学', start: '19:00', end: '20:00', pin: true, by: 'major' },
      { id: 'p2', name: '物理', start: '20:10', end: '21:10', pin: true, by: 'major' },
    ] },
  ],
};

/* 下个月：只能靠筛选加 */
const NEXT = {
  id: 'm3', name: '第三次月考', temporary: false,
  start: '2026-12-20', end: '2026-12-21', daysN: 2, count: 3, onCnt: 0, allOn: false, anyOn: false, auto: false,
  days: [
    { date: '2026-12-20', wd: WD('2026-12-20'), onCnt: 0, allOn: false, anyOn: false, items: [
      { id: 'n1', name: '历史', start: '08:00', end: '09:30', pin: false, by: '' },
    ] },
    { date: '2026-12-21', wd: WD('2026-12-21'), onCnt: 0, allOn: false, anyOn: false, items: [
      { id: 'n2', name: '地理', start: '08:00', end: '09:30', pin: false, by: '' },
      { id: 'n3', name: '政治', start: '10:00', end: '11:30', pin: false, by: '' },
    ] },
  ],
};

const HOMEWORK = { id: 'hw1', title: '本周作业', items: [
  { subject: '语文', tasks: [{ text: '文言文背诵' }] },
  { subject: '数学', tasks: [{ text: '试卷一张' }] },
] };

function payload(groups) {
  return {
    ok: true, at: Date.now(), today: T, title: '高二上第二次段考', cls: '5班',
    base: 'https://examboard.dpdns.org', groups: groups, items: [],
    pins: { majors: [], days: [], items: [] }, pinAt: 0,
    term: { name: '2026 年秋季 · 高二上', start: '2026-09-01', end: '2027-01-30' },
    cached: false, stale: false,
  };
}

function mockApi(page, opt) {
  const o = opt || {};
  return page.route('**/api/**', (route) => {
    const u = route.request().url();
    const J = (x) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (u.includes('/api/exams')) {
      if (u.includes('action=pin')) { o.pinBody = JSON.parse(route.request().postData() || '{}'); return J({ ok: true, pins: {}, at: Date.now() }); }
      if (u.includes('action=bulk')) { o.bulkBody = JSON.parse(route.request().postData() || '{}'); return J({ ok: true, pins: {}, at: Date.now(), hit: 3 }); }
      if (u.includes('action=state')) return J({ ok: true, cfg: { base: 'https://examboard.dpdns.org', classId: '', className: '5班' }, pins: {}, kv: true, classes: [], data: null });
      o.listCalls = (o.listCalls || 0) + 1;
      if (o.listCalls > 0 && u.includes('fresh=1')) o.freshCalls = (o.freshCalls || 0) + 1;
      return J(payload(o.groups || [MAJOR]));
    }
    if (u.includes('/api/island')) {
      return J({ ok: true, data: { on: true, startDate: '2026-09-01', endDate: '2027-01-30',
        enrollDate: '2025-09-01', term: '2026 年秋季 · 高二上', holidays: [] } });
    }
    if (u.includes('/auth?action=me')) return J({ ok: true, user: { username: 'aibot', role: o.role || 'admin' } });
    if (u.includes('/api/content')) return J({ ok: true, items: { holiday_homeworks: { hw1: HOMEWORK }, announcements: [] } });
    return J({ ok: true });
  });
}

async function openBig(page, opt) {
  const o = opt || {};
  await page.addInitScript((args) => {
    localStorage.setItem('cls_bigscreen', '1');
    localStorage.setItem('cls_welcome_v1', '1');
    localStorage.setItem('cls_login_guide_v1', '1');
    localStorage.setItem('cls_auth', JSON.stringify({ token: 'TESTTOKEN', user: { username: 'aibot', role: args.role } }));
    if (args.cache) localStorage.setItem('cls_big_exam_v2', JSON.stringify(args.cache));
    else localStorage.removeItem('cls_big_exam_v2');
  }, { role: o.role || 'admin', cache: o.cache || null });
  await mockApi(page, o);
  await page.goto(BASE + '/index.html?_r=' + Date.now() + '#/hw', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3400);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });

/* ============ 1. 作业看板：考试名 → 日期周几 → 科目时间 ============ */
console.log('\n【1】作业看板：三层排布、字号跟作业、昨天压暗');
{
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 960 } });
  const page = await ctx.newPage();
  await openBig(page, { groups: [MAJOR] });
  const r = await page.evaluate(() => {
    const b = document.getElementById('bhwExam');
    if (!b) return { missing: true };
    const sub = b.querySelector('.bhex-sub');
    const tm = b.querySelector('.bhex-time');
    return {
      missing: false,
      head: (b.querySelector('.bhex-h b') || {}).textContent || '',
      meta: (b.querySelector('.bhex-h span') || {}).textContent || '',
      dates: [...b.querySelectorAll('.bhex-date')].map((x) => x.textContent.trim()),
      rows: [...b.querySelectorAll('.bhex-row')].map((x) => ({
        s: (x.querySelector('.bhex-sub') || {}).textContent || '',
        t: (x.querySelector('.bhex-time') || {}).textContent || '',
      })),
      fs: sub ? parseFloat(getComputedStyle(sub).fontSize) : 0,
      color: sub ? getComputedStyle(sub).color : '',
      tcolor: tm ? getComputedStyle(tm).color : '',
      fsVar: getComputedStyle(b).getPropertyValue('--bhw-fs'),
    };
  });
  t('考试块出现', !r.missing);
  t('块头是考试名', r.head === '高二上第二次段考', r.head);
  t('右侧标场次与天数', /6\s*场/.test(r.meta) && /2\s*天/.test(r.meta), r.meta);
  t('每天一个日期小标题且带周几', r.dates.length === 2 && /今天/.test(r.dates[0]) && /周[日一二三四五六]/.test(r.dates[0]),
    JSON.stringify(r.dates));
  t('第二天标题带「明天」', /明天/.test(r.dates[1] || ''), r.dates[1]);
  t('每科一行，科目 + 起止时间', r.rows.length === 6 && r.rows[0].s === '语文' && /09:00.11:30/.test(r.rows[0].t),
    JSON.stringify(r.rows[0]));
  t('字号走 --bhw-fs（跟作业一起缩放）', /1\.5/.test(String(r.fsVar)) && r.fs > 20, r.fs + 'px / var=' + r.fsVar);
  t('科目用亮色（--fg），时间用次级亮色', r.color === 'rgb(41, 37, 36)' && r.tcolor === 'rgb(87, 83, 78)',
    r.color + ' / ' + r.tcolor);
  await ctx.close();
}

/* ============ 2. 多场合并 + 6 科上限 + 昨天压暗 ============ */
console.log('\n【2】多场合并去重、6 科上限、昨天压暗');
{
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 960 } });
  const page = await ctx.newPage();
  await openBig(page, { groups: [PAST, MAJOR] });
  const r = await page.evaluate(() => {
    const b = document.getElementById('bhwExam');
    return {
      head: (b.querySelector('.bhex-h b') || {}).textContent || '',
      mnames: [...b.querySelectorAll('.bhex-mname')].map((x) => x.textContent.trim()),
      pastOp: [...b.querySelectorAll('.bhex-row.bhex-off')].map((x) => getComputedStyle(x).opacity),
      rowN: b.querySelectorAll('.bhex-row').length,
      more: (b.querySelector('.bhex-more') || {}).textContent || '',
      dup: (() => {
        const keys = [...b.querySelectorAll('.bhex-row')].map((x) => x.textContent.trim());
        return keys.length !== new Set(keys).size;
      })(),
    };
  });
  t('混着多场时块头写「考试安排」类文案', /考试安排/.test(r.head), r.head);
  t('每场先写考试名', r.mnames.length === 2 && r.mnames[0] === '数学周测', JSON.stringify(r.mnames));
  t('昨天的科目压暗', r.pastOp.length === 2 && r.pastOp.every((x) => Number(x) < 0.6), JSON.stringify(r.pastOp));
  t('按 6 科上限截断（昨天 2 科 + 今天 2 科，明天整天放不下）', r.rowN === 4, String(r.rowN));
  t('超出部分提示还剩多少', /还有\s*4\s*科/.test(r.more), r.more);
  t('同一天同科目不重复出现', r.dup === false);
  await ctx.close();
}

/* ============ 3. 弹窗：筛档位、折叠、三级加号 ============ */
console.log('\n【3】考试看板弹窗：筛档位 / 折叠 / 三级加号');
{
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 960 } });
  const page = await ctx.newPage();
  const opt = { groups: [PAST, MAJOR, NEXT] };
  await openBig(page, opt);
  await page.click('#bhwExamAdd');
  await page.waitForTimeout(900);

  const r = await page.evaluate(() => ({
    go: (() => { const a = document.getElementById('bexGo'); return a ? a.getAttribute('href') : ''; })(),
    tabs: [...document.querySelectorAll('#bexTabs .bex-tab')].map((b) => ({
      t: b.textContent.trim(), on: b.className.includes('on'),
    })),
    bulk: (document.getElementById('bexBulk') || {}).textContent || '',
    groups: [...document.querySelectorAll('.bex-grp')].map((x) => ({
      n: (x.querySelector('.bex-gn') || {}).textContent || '',
      m: (x.querySelector('.bex-gm') || {}).textContent || '',
      open: x.classList.contains('open'),
      body: !!x.querySelector('.bex-gb'),
    })),
    tip: (document.getElementById('bexTip') || {}).textContent || '',
  }));
  t('顶部有前往考试看板的外链', /examboard\.dpdns\.org/.test(r.go), r.go);
  t('六个时段档位齐全', r.tabs.length === 6
    && ['本周', '下周', '本月', '下月', '本学期', '全部'].every((x, i) => r.tabs[i].t === x),
    JSON.stringify(r.tabs.map((x) => x.t)));
  t('默认停在本周', r.tabs[0].on === true, JSON.stringify(r.tabs.filter((x) => x.on)));
  t('批量按钮跟随档位显示「＋本周」', r.bulk === '＋本周', r.bulk);
  t('默认全部收起（没有展开体）', r.groups.every((g) => !g.open && !g.body), JSON.stringify(r.groups));
  t('收起时给出日期范围与场次数', /·\s*6\s*场/.test(r.groups[1].m || ''), r.groups[1].m);
  t('提示里给出本档场次', /本周\s*4\s*场/.test(r.tip), r.tip);

  /* 切到「全部」，展开第三场 */
  await page.click('#bexTabs [data-scope="all"]');
  await page.waitForTimeout(300);
  const bulk2 = await page.evaluate(() => (document.getElementById('bexBulk') || {}).textContent);
  t('切到「全部」后批量按钮变「＋全部」并被隐藏', bulk2 === '＋全部', bulk2);
  const hidden = await page.evaluate(() => getComputedStyle(document.getElementById('bexBulk')).display === 'none');
  t('「全部」档不出批量按钮，避免一键加满', hidden === true);

  const carets = await page.$$('.bex-caret');
  await carets[carets.length - 1].click();
  await page.waitForTimeout(300);
  const ex = await page.evaluate(() => {
    const grp = [...document.querySelectorAll('.bex-grp')].pop();
    return {
      open: grp.classList.contains('open'),
      days: [...grp.querySelectorAll('.bex-day')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()),
      items: [...grp.querySelectorAll('.bex-it')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()),
      dayBtn: grp.querySelectorAll('.bex-add').length,
      dots: grp.querySelectorAll('.bex-dot').length,
      majorBtn: (grp.querySelector('.bex-gh .bex-add') || {}).textContent || '',
    };
  });
  t('点箭头展开', ex.open === true);
  t('展开后按天分组，每天有「这天」按钮', ex.days.length === 2 && ex.dayBtn === 3, JSON.stringify(ex.days));
  t('每个科目一个圆形加号', ex.dots === 3, String(ex.dots));
  t('整场按钮在组头', /整场/.test(ex.majorBtn), ex.majorBtn);

  /* 点整场 → 发 pin scope=major */
  await page.click('.bex-grp:last-child .bex-gh .bex-add');
  await page.waitForTimeout(600);
  t('点整场发出 scope=major 的请求',
    !!opt.pinBody && opt.pinBody.scope === 'major' && opt.pinBody.id === 'm3' && opt.pinBody.on === true,
    JSON.stringify(opt.pinBody));
  await ctx.close();
}

/* ============ 4. 批量加一整段 ============ */
console.log('\n【4】批量按钮：把当前档位的考试一次加上');
{
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 960 } });
  const page = await ctx.newPage();
  const opt = { groups: [PAST, MAJOR, NEXT] };
  await openBig(page, opt);
  await page.click('#bhwExamAdd');
  await page.waitForTimeout(900);
  await page.click('#bexBulk');
  await page.waitForTimeout(700);
  const b = opt.bulkBody || {};
  t('批量请求带 action=bulk', b.action === 'bulk', JSON.stringify(b));
  t('区间是本周一到周日', /^\d{4}-\d{2}-\d{2}$/.test(b.from || '') && /^\d{4}-\d{2}-\d{2}$/.test(b.to || '')
    && b.from <= b.to, b.from + ' ~ ' + b.to);
  t('本周区间包含今天', b.from <= T && T <= b.to, b.from + ' ~ ' + b.to);
  await ctx.close();
}

/* ============ 5. 断网：读本机缓存 ============ */
console.log('\n【5】断网时仍能看上次的考试（本机缓存）');
{
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 960 } });
  const page = await ctx.newPage();
  const cache = Object.assign(payload([MAJOR]), { cacheAt: Date.now() - 12 * 60000 });
  await openBig(page, { cache });
  await page.route('**/api/exams**', (r) => r.abort());
  await page.click('#bhwExamAdd');
  await page.waitForTimeout(900);
  const r = await page.evaluate(() => ({
    groups: document.querySelectorAll('.bex-grp').length,
    tip: (document.getElementById('bexTip') || {}).textContent || '',
    box: document.getElementById('bhwExam') ? true : false,
  }));
  t('断网时弹窗仍列出缓存的考试', r.groups >= 1, String(r.groups));
  t('提示里标明是缓存/离线', /缓存|离线/.test(r.tip), r.tip);
  t('作业看板也还有考试块', r.box === true);
  await ctx.close();
}

/* ============ 6. 打开弹窗会回源（fresh=1） ============ */
console.log('\n【6】打开弹窗自动刷新（fresh=1），刷新按钮同样回源');
{
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 960 } });
  const page = await ctx.newPage();
  const opt = { groups: [MAJOR] };
  await openBig(page, opt);
  await page.click('#bhwExamAdd');
  await page.waitForTimeout(900);
  t('打开弹窗发出带 fresh=1 的请求', (opt.freshCalls || 0) >= 1, String(opt.freshCalls || 0));
  const before = opt.freshCalls || 0;
  await page.click('#bexReload');
  await page.waitForTimeout(700);
  t('点「刷新」再回源一次', (opt.freshCalls || 0) > before, String(opt.freshCalls || 0) + ' > ' + before);
  await ctx.close();
}

/* ============ 7. 大屏作业看板仅管理员 ============ */
console.log('\n【7】大屏作业看板：普通用户进不去');
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();
  await openBig(page, { role: 'student' });
  const st = await page.evaluate(() => {
    const hw = document.getElementById('bigHw');
    const tiles = [...document.querySelectorAll('.big-tile')].map((x) => ({
      t: (x.querySelector('.bt-t') || {}).textContent || '',
      s: (x.querySelector('.bt-s') || {}).textContent || '',
    }));
    const hwTile = tiles.find((x) => x.t === '作业查看') || {};
    return { hwShown: hw ? getComputedStyle(hw).display !== 'none' : false, sub: hwTile.s || '' };
  });
  t('学生打开 #/hw 不会进入作业页', st.hwShown === false);
  t('大屏首页作业卡标「仅管理员」', /仅管理员/.test(st.sub), st.sub);
  await ctx.close();
}

/* ============ 8. 学期卡：已步入高中在开学之上 ============ */
console.log('\n【8】大屏右下角：已步入高中 N 天');
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();
  await openBig(page, { groups: [MAJOR] });
  const r = await page.evaluate(() => {
    const box = document.getElementById('bhwProg');
    if (!box) return { missing: true };
    return { missing: false, rows: [...box.querySelectorAll('.bhw-prog-row')].map((x) => ({
      k: (x.querySelector('span') || {}).textContent || '',
      v: (x.querySelector('b') || {}).textContent || '',
    })) };
  });
  t('第一行是「已步入高中」', !r.missing && r.rows[0] && /已步入高中/.test(r.rows[0].k), r.rows && r.rows[0] && r.rows[0].k);
  t('第二行是「本学期已开学」', r.rows && r.rows[1] && /本学期已开学/.test(r.rows[1].k), r.rows && r.rows[1] && r.rows[1].k);
  t('高中天数是个正经天数', /^\d+天$/.test((r.rows && r.rows[0] && r.rows[0].v) || ''), r.rows && r.rows[0] && r.rows[0].v);
  await ctx.close();
}

/* ============ 9. 后台：刷新按钮 + 分组折叠 + 三级加号 ============ */
console.log('\n【9】后台「考试同步」：刷新、分组、三级加号');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  const opt = { groups: [PAST, MAJOR, NEXT] };
  await page.addInitScript(() => {
    localStorage.setItem('cls_welcome_v1', '1');
    localStorage.setItem('cls_auth', JSON.stringify({ token: 'TESTTOKEN', user: { username: 'aibot', role: 'admin' } }));
  });
  await mockApi(page, opt);
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
      hasReload: !!document.getElementById('exRefresh'),
      details: document.querySelectorAll('#exList details').length,
      majorBtn: document.querySelectorAll('#exList [data-pin^="major:"]').length,
      txt: v ? v.textContent.replace(/\s+/g, ' ') : '',
      stat: (document.getElementById('exStat') || {}).textContent || '',
    };
  });
  t('有看板地址输入框', r.hasBase === true);
  t('不再要账号密码', r.hasUser === false && r.hasPass === false);
  t('有「刷新」和「立即同步」两个按钮', r.hasReload === true && r.hasSync === true);
  t('按考试分成 3 个可折叠块', r.details === 3, String(r.details));
  t('每场都有「整场」按钮', r.majorBtn === 3, String(r.majorBtn));
  t('统计里有副本更新时间', /本站副本更新于/.test(r.stat), r.stat.slice(0, 60));
  t('页面不再出现「写回」字样', !/写回/.test(r.txt));
  await ctx.close();
}

/* ============ 10. 首页下线板块 ============ */
console.log('\n【10】首页：学习资料 / 私人云盘 / 排行榜 / 屏幕批注 已下线');
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
      cats: [...document.querySelectorAll('#sideCats .side-btn')].map((x) => x.textContent.replace(/\s+/g, '')),
      hasStudy: /学习资料/.test(txt), hasDisk: /私人云盘/.test(txt),
      hasRank: /排行榜/.test(txt), hasAnno: /屏幕批注/.test(txt),
      hasProfile: (window.SITE_DATA && SITE_DATA.links || []).some((l) => Number(l.id) === 10),
    };
  });
  t('侧栏没有「学习资料」', !r.hasStudy && !r.cats.some((x) => /学习资料/.test(x)), JSON.stringify(r.cats));
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
