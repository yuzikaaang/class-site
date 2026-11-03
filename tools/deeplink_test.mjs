/* v3.18.0 验证：统一登录态总线 + 全站深链 + 登录后回跳
   跑法：先 `python3 -m http.server 8111`，再 node tools/deeplink_test.mjs */
import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:8111';
const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
let pass = 0, fail = 0;
const t = (n, ok, x) => { ok ? pass++ : fail++; console.log((ok ? '  ✓ ' : '  ✗ ') + n + (ok || !x ? '' : '  → ' + x)); };

const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const SUBJECTS = [
  { key: 'chinese', name: '语文', full: 150, graded: false },
  { key: 'math', name: '数学', full: 150, graded: false },
];
const exam = { id: 901, name: '冒烟测试月考', date: '2026-10-01', subjects: SUBJECTS, cutlines: [] };
function mkRows() {
  const plan = [['张三', 300], ['李四', 290], ['王五', 280], ['赵六', 270]];
  return plan.map(([name, total], i) => {
    const r = { id: 900 + i, uid: 900 + i, name, s: {} };
    SUBJECTS.forEach((s, k) => { r.s[s.key] = { raw: k === 0 ? total - 140 : 140, assigned: null, rank: i + 1 }; });
    return r;
  });
}
const votes = Array.from({ length: 5 }, (_, i) => ({
  id: 1200 + i, title: '第 ' + (i + 1) + ' 个投票', open: true, multi: false,
  options: [{ id: 'o1', label: 'A' }, { id: 'o2', label: 'B' }],
  results: [{ id: 'o1', label: 'A', n: 3 }, { id: 'o2', label: 'B', n: 1 }],
  myChoices: [], deadline: null, status: 'open',
}));

async function mkPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript((a) => {
    localStorage.setItem('cls_login_guide_v1', '1');
    localStorage.setItem('cls_welcome_v1', '1');
    if (a.token) {
      localStorage.setItem('cls_auth', JSON.stringify({
        token: a.token, user: { id: 900, displayName: '张三', role: 'user' },
      }));
    }
  }, { token: opts.token || '' });
  await page.route('**/api/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.endsWith('/api/scores')) {
      const a = u.searchParams.get('action');
      if (a === 'list') return route.fulfill(json({ ok: true, exams: [exam], config: { access: 'published' } }));
      if (a === 'board') return route.fulfill(json({ ok: true, exam, rows: mkRows() }));
      if (a === 'me') return route.fulfill(json({ ok: true, items: [] }));
    }
    if (u.pathname.endsWith('/api/votes')) {
      return route.fulfill(json({ ok: true, votes, isAdmin: false }));
    }
    if (u.pathname.endsWith('/api/boards')) {
      if (u.searchParams.get('action') === 'meta') {
        return route.fulfill(json({ ok: true, cats: {}, cards: {}, catalog: null, noShare: [] }));
      }
    }
    return route.fulfill(json({ ok: true }));
  });
  return { ctx, page };
}

/* ---------------- ① 未登录：深链照样落到目标板块 ---------------- */
{
  const { ctx, page } = await mkPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 140)));
  await page.goto(BASE + '/index.html#/board/7', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);

  const st = await page.evaluate(() => ({
    cat: window.__activeCat, hash: location.hash,
    tab7: !!document.querySelector('#tab-cat-7.active'),
    txt: (document.getElementById('voteBody') || {}).textContent || '',
  }));
  t('#/board/7 直接落到投票板块', st.cat === 7 && st.tab7, JSON.stringify(st));
  t('地址栏被规范化成 #/votes', /#\/votes$/.test(st.hash), st.hash);
  /* v3.19.0（站主）：未登录不再只给一张「请登录」的空板 ——
     先看到有哪些投票、各多少票，想投票再登录。 */
  t('未登录时能看投票与结果，并提示登录后投票',
    /登录后投票/.test(st.txt) && /票/.test(st.txt), st.txt.slice(0, 80));
  t('没有 JS 报错', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ---------------- ② 未登录：登录引导把「想去哪」记下来 ---------------- */
{
  const { ctx, page } = await mkPage();
  await page.goto(BASE + '/index.html#/scores', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  const before = await page.evaluate(() => ({
    cat: window.__activeCat,
    pane: (document.getElementById('scPaneBox') || {}).textContent || '',
  }));
  t('#/scores 落到成绩板块', before.cat === 3, String(before.cat));
  t('未登录时成绩页给出登录引导', /需要登录/.test(before.pane), before.pane.slice(0, 60));

  await page.evaluate(() => {
    const b = document.querySelector('#scPaneBox button');
    if (b) b.click();
  });
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({
    next: sessionStorage.getItem('cls_next') || '',
    shown: !!document.querySelector('#acctMask.show'),
    hash: location.hash,
  }));
  t('点「去登录」会弹登录框', after.shown);
  t('同时记下回跳地址（含 hash）', /#\/scores$/.test(after.next), after.next);
  t('回跳地址是站内相对路径', after.next.indexOf('http') !== 0, after.next);
  await ctx.close();
}

/* ---------------- ③ 已登录：登录后回跳落回原处 ---------------- */
{
  const { ctx, page } = await mkPage({ token: 'tok-a' });
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);

  const resumed = await page.evaluate(async () => {
    sessionStorage.setItem('cls_next', location.pathname + '#/scores/me');
    if (typeof afterLoginResume === 'function') afterLoginResume();
    await new Promise((r) => setTimeout(r, 900));
    return { hash: location.hash, cat: window.__activeCat, tab: (window.SC || {}).tab };
  });
  t('登录后按记录回跳到 #/scores/me', /#\/scores\/me$/.test(resumed.hash), resumed.hash);
  t('回跳后成绩板块被打开', resumed.cat === 3, String(resumed.cat));
  t('回跳后切到「我的画像」', resumed.tab === 'me', String(resumed.tab));
  t('next 用掉后被清空', (await page.evaluate(() => sessionStorage.getItem('cls_next'))) === null);
  await ctx.close();
}

/* ---------------- ④ 已登录：投票深链定位到那一条 ---------------- */
{
  const { ctx, page } = await mkPage({ token: 'tok-a' });
  await page.goto(BASE + '/index.html#/vote/1203', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);
  const st = await page.evaluate(() => ({
    cat: window.__activeCat,
    cur: (window.VOTE || {}).curId,
    pos: (document.getElementById('votePosTxt') || {}).textContent || '',
  }));
  t('#/vote/1203 打开投票板块', st.cat === 7, String(st.cat));
  t('轮播定位到第 4 个（id 1203）', st.cur === 1203, String(st.cur));
  t('页码显示「第 4 / 5 个」', /第\s*4\s*\/\s*5/.test(st.pos), st.pos);
  const btn = await page.evaluate(() => !!document.querySelector('.vote-head .vote-link'));
  t('投票区有「复制链接」入口', btn);
  await ctx.close();
}

/* ---------------- ⑤ 复制链接：当前视图 → 可直达的地址 ---------------- */
{
  const { ctx, page } = await mkPage({ token: 'tok-a' });
  await page.goto(BASE + '/index.html#/board/7', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const links = await page.evaluate(() => {
    const out = { votes: shareHere() };
    goHomeView();
    out.home = shareHere();
    openCat(3);
    out.scores = shareHere();
    if (window.SC) scSetTab('me');
    out.me = shareHere();
    return out;
  });
  t('投票页链接是 #/votes', /#\/votes$/.test(links.votes), links.votes);
  t('首页链接不带 hash', !/#/.test(links.home), links.home);
  t('成绩页链接是 #/scores', /#\/scores$/.test(links.scores), links.scores);
  t('我的画像链接是 #/scores/me', /#\/scores\/me$/.test(links.me), links.me);
  t('链接里不含任何 token', !/token|tok-a|k=/.test(links.votes + links.scores), links.votes);
  await ctx.close();
}

/* ---------------- ⑥ 分享页复用登录态 ---------------- */
{
  /* 未登录：没有「你已登录」条 */
  const a = await mkPage();
  await a.page.route('**/share.html*', (r) => r.continue());
  await a.page.route('**/api/scores?action=share-get**', (r) => r.fulfill(json({
    ok: true,
    share: { ownerName: '张三', scope: 'class', expiresAt: null },
    exams: [{ id: 901, name: '冒烟测试月考', date: '2026-10-01', endDate: '', subjects: SUBJECTS }],
    rows: [],
  })));
  await a.page.goto(BASE + '/share.html?t=demo-token', { waitUntil: 'domcontentloaded' });
  await a.page.waitForTimeout(1500);
  const noLogin = await a.page.evaluate(() => ({
    bar: !!document.querySelector('.mebar.show'),
    foot: document.body.textContent.slice(-60),
  }));
  t('未登录打开分享页：不显示已登录条', !noLogin.bar);
  await a.ctx.close();

  /* 已登录：显示「你已经登录」+ 去看我的成绩 */
  const b = await mkPage({ token: 'tok-b' });
  await b.page.route('**/api/scores?action=share-get**', (r) => r.fulfill(json({
    ok: true,
    share: { ownerName: '张三', scope: 'class', expiresAt: null },
    exams: [{ id: 901, name: '冒烟测试月考', date: '2026-10-01', endDate: '', subjects: SUBJECTS }],
    rows: [],
  })));
  await b.page.goto(BASE + '/share.html?t=demo-token', { waitUntil: 'domcontentloaded' });
  await b.page.waitForTimeout(1500);
  const logged = await b.page.evaluate(() => {
    const bar = document.querySelector('.mebar.show');
    return {
      bar: !!bar,
      txt: bar ? bar.textContent : '',
      href: bar ? (bar.querySelector('a') || {}).getAttribute('href') : '',
    };
  });
  t('已登录打开分享页：出现已登录条', logged.bar, logged.txt);
  t('条里说明身份（不用再登 / 是你自己的）', /不用再登一次|你自己分享/.test(logged.txt), logged.txt);
  t('提供「看我的成绩」直达入口', /#\/scores$/.test(logged.href || ''), logged.href);
  await b.ctx.close();
}

/* ---------------- ⑦ 登录态跨页共享（主站 ↔ 时钟） ---------------- */
{
  const { ctx, page } = await mkPage({ token: 'tok-cross' });
  await page.goto(BASE + '/clock.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() => ({
    bus: typeof ClsAuth,
    tok: (typeof ClsAuth !== 'undefined') ? ClsAuth.token : '',
    wants: (window.__clkAuthProbe || 0),
  }));
  t('时钟页能加载登录态总线', r.bus === 'object');
  t('主站登录态在时钟页可直接读到', r.tok === 'tok-cross', r.tok);
  /* clock.html 的脚本包在 IIFE 里，clkToken 不在全局 —— 改为源码级检查 + 发请求验证 */
  const src = (await import('node:fs')).readFileSync(new URL('../clock.html', import.meta.url), 'utf8');
  t('时钟页取 token 的地方改走总线', /ClsAuth\.token/.test(src));
  await ctx.close();
}

/* ---------------- ⑧ 登录过期：记住现场 ---------------- */
{
  const { ctx, page } = await mkPage({ token: 'tok-expired' });
  await page.goto(BASE + '/index.html#/scores/me', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  await page.route('**/api/auth?action=me', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '未登录或登录已过期' }) }));
  const st = await page.evaluate(async () => {
    try { await api('/auth?action=me'); } catch (e) {}
    await new Promise((r) => setTimeout(r, 300));
    return {
      next: sessionStorage.getItem('cls_next') || '',
      hash: location.hash,
      logged: isLoggedIn(),
      mask: !!document.querySelector('#acctMask.show'),
    };
  });
  t('401 后本地登录态被清掉', st.logged === false);
  t('401 后记下当前所在位置', /#\/scores\/me$/.test(st.next), st.next + ' (hash=' + st.hash + ')');
  t('401 后弹出登录框', st.mask);
  await ctx.close();
}

/* ---------------- ⑨ 短名字入口 + 游戏跳转的解析 ---------------- */
{
  const { ctx, page } = await mkPage({ token: 'tok-a' });
  await page.goto(BASE + '/index.html#/music', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  const st = await page.evaluate(() => ({
    cat: window.__activeCat, hash: location.hash,
    parsed: JSON.stringify(parseRoute('#/game/tetris')),
    home: JSON.stringify(parseRoute('#/homework')),
  }));
  t('#/music 落到「常用服务」', st.cat === 1, String(st.cat));
  t('#/music 地址栏归一成 #/board/1', /#\/board\/1$/.test(st.hash), st.hash);
  t('#/game/xxx 解析出游戏名', /"v":"game".*"name":"tetris"/.test(st.parsed), st.parsed);
  t('#/homework 解析成卡片 2', /"cat":1.*"card":"2"/.test(st.home), st.home);
  await ctx.close();
}

/* ---------------- ⑩ 老格式仍然可用 ---------------- */
{
  const { ctx, page } = await mkPage();
  await page.goto(BASE + '/index.html?b=7', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  const st = await page.evaluate(() => ({
    cat: window.__activeCat,
    mask: !!document.querySelector('#acctMask.show'),
    next: sessionStorage.getItem('cls_next') || '',
  }));
  t('老链接 ?b=7 未登录时弹登录（行为不变）', st.mask === true);
  await ctx.close();
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
await browser.close();
process.exit(fail ? 1 : 0);
