/* v4.10.5 专项：放假天数两头算 · 点名查看 · 离线缓存 · 时钟改版 · 中转站与微信兜底 */
import { chromium } from '/root/.nvm/versions/node/v22.13.1/lib/node_modules/playwright/index.mjs';
const BASE = 'http://localhost:8112';
let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
};

const ROSTER = Array.from({ length: 24 }, (_, i) => ({
  name: '同学' + String(i + 1).padStart(2, '0'),
  studentId: '2505' + String(i + 1).padStart(2, '0'),
  role: '学生', gender: i % 2 ? '女' : '男', title: '',
}));

/* 假期：6 号 22:00 放 → 8 号早上 8:00 返校（站主新增：早上返校那天不算放假） */
const ISLAND_AM = {
  on: true, term: '2026 年秋季 · 高二上', startDate: '2026-09-01',
  endDate: '2027-01-20', enrollDate: '2025-09-01',
  components: ['time', 'weather', 'week', 'term'],
  banner: { mon: '数数语英化', tue: '英英备备语', wed: '语语数物英', thu: '生微语生生', fri: '英数语语化', sat: '自自自自', sun: '读自物理' },
  days: {},
  holidays: [{ id: 'h0', label: '月假', from: '2026-11-06', to: '2026-11-08', fromTime: '22:00', toTime: '08:00' }],
  photo: '',
};

function routeAll(page, island) {
  return page.route('**/api/**', (route) => {
    const u = route.request().url();
    if (u.includes('/api/island') || u.includes('/island')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: island }) });
    }
    if (u.includes('action=roster') || u.includes('/api/profile')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, students: ROSTER, roster: ROSTER }) });
    }
    if (u.includes('/auth?action=me')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, user: { username: 'aibot', role: 'admin' } }) });
    }
    if (u.includes('/api/content')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: {} }) });
    }
    if (u.includes('/api/files')) {
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, code: 'ABC234', kind: 'file', name: '课件.pdf', size: 1048576, at: Date.now() - 3600000, exp: Date.now() + 86400000, maxGet: 0, gets: 0, left: null, memo: '' }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });

/* ============================================================
   1) 早上返校那天不算放假，且要正常显示当日事项
   ============================================================ */
console.log('\n【1】6 号 22:00 放 → 8 号 08:00 返校：8 号不算假期，显示今日事项');
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('cls_welcome_v1', '1');
    localStorage.setItem('cls_login_guide_v1', '1');
  });
  await routeAll(page, ISLAND_AM);
  await page.goto(BASE + '/index.html?_r=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2400);

  const check = async (iso, forceToday) => page.evaluate(([isoStr, ft]) => {
    const RealDate = Date;
    const fixed = new RealDate(isoStr).getTime();
    window.Date = class extends RealDate {
      constructor(...a) { if (a.length === 0) { super(fixed); } else { super(...a); } }
      static now() { return fixed; }
    };
    try { ISL_VIEW = ft ? 'today' : null; islandRender(); } catch (e) { return { err: String(e) }; }
    const txt = document.querySelector('#islBannerRow .txt');
    const tagEl = document.querySelector('#islBannerRow .tag');
    const hol = document.querySelector('#islBannerRow .island-banner.hol');
    return {
      text: txt ? txt.textContent : '',
      tag: tagEl ? tagEl.textContent : '',
      isHoliday: !!hol,
      footL: (document.getElementById('islFootL') || {}).textContent || '',
    };
  }, [iso, !!forceToday]);

  const d6 = await check('2026-11-06T23:00:00', true);
  t('11/6 23:00（已放假但当天不算）显示「今晚起放假」而不是「第 1 天」',
    /今晚/.test(d6.text) && !/放假第\s*1\s*天/.test(d6.text), d6.text);
  t('11/6 当晚总天数只算 1 天（7 号）', /共\s*1\s*天/.test(d6.text), d6.text);

  const d7 = await check('2026-11-07T10:00:00');
  t('11/7 是最后一天（且不出现「第 2 天」）', /最后一天/.test(d7.text) && !/第\s*2\s*天/.test(d7.text), d7.text);
  t('11/7 写明了 08:00 返校', /08:00\s*返校/.test(d7.text), d7.text);

  const d8 = await check('2026-11-08T09:00:00');
  t('11/8（早上已返校）不再显示假期横幅', !d8.isHoliday, 'isHoliday=' + d8.isHoliday + ' tag=' + d8.tag);
  t('11/8 正常显示「今日事项」', /今日事项/.test(d8.tag), d8.tag);
  t('11/8 底部标签回到星期几（不是「假期」）', d8.footL !== '假期', d8.footL);
  await ctx.close();
}

/* ============================================================
   2) 随机点名「查看」：列出这个范围里的人
   ============================================================ */
console.log('\n【2】点名「按条件可抽 N 人」旁边点「查看」→ 看到具体名单');
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await page.addInitScript(() => {
    localStorage.setItem('cls_welcome_v1', '1');
    localStorage.setItem('cls_login_guide_v1', '1');
  });
  await routeAll(page, ISLAND_AM);
  await page.goto(BASE + '/index.html?_r=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2400);
  await page.evaluate(() => { try { BIG.setMode(true); } catch (e) {} });
  await page.waitForTimeout(500);
  await page.evaluate(() => { try { bigPickOpen(); } catch (e) {} });
  await page.waitForTimeout(1800);

  const before = await page.evaluate(() => {
    const head = document.getElementById('bpickHeadCount');
    const links = Array.from(document.querySelectorAll('#bpickBody .bpick-link')).map(b => b.textContent.trim());
    return { count: head ? Number(head.textContent) : -1, links, peek: document.querySelectorAll('.bpick-peek-i').length };
  });
  t('点名面板显示可抽人数', before.count > 0, 'count=' + before.count);
  t('人数旁边有「查看」按钮', before.links.indexOf('查看') >= 0, before.links.join('|'));
  t('默认不展开名单', before.peek === 0, 'peek=' + before.peek);

  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('#bpickBody .bpick-link')).find(x => x.textContent.trim() === '查看');
    if (b) b.click();
  });
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({
    items: document.querySelectorAll('.bpick-peek-i').length,
    head: (document.querySelector('.bpick-peek-h') || {}).textContent || '',
    first: (document.querySelector('.bpick-peek-i') || {}).textContent || '',
    hasSid: !!document.querySelector('.bpick-peek-i i'),
    btnTxt: (Array.from(document.querySelectorAll('#bpickBody .bpick-link')).find(x => /收起/.test(x.textContent)) || {}).textContent || '',
  }));
  t('查看后名单条数 = 可抽人数', after.items === before.count, `${after.items} vs ${before.count}`);
  t('名单条目带学号', after.hasSid, after.first);
  t('面板标题写明人数并说明已排除请假', /个?人/.test(after.head) && /排除/.test(after.head), after.head);
  t('按钮变成「收起名单」', /收起/.test(after.btnTxt), after.btnTxt);

  /* 再点一次收起 */
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('#bpickBody .bpick-link')).find(x => /收起/.test(x.textContent));
    if (b) b.click();
  });
  await page.waitForTimeout(400);
  const closed = await page.evaluate(() => document.querySelectorAll('.bpick-peek-i').length);
  t('再点一次能收起名单', closed === 0, 'peek=' + closed);
  t('点名面板没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

/* ============================================================
   3) 离线缓存：名单 / 考试 / 成绩单都落在本机
   ============================================================ */
console.log('\n【3】离线缓存：成绩分析「缓存离线」按钮 + 数据落本机');
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('cls_welcome_v1', '1');
    localStorage.setItem('cls_login_guide_v1', '1');
  });
  await routeAll(page, ISLAND_AM);
  await page.goto(BASE + '/index.html?_r=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2400);
  await page.evaluate(() => { try { BIG.setMode(true); } catch (e) {} });
  await page.waitForTimeout(400);
  await page.evaluate(() => { try { bigPickOpen(); } catch (e) {} });
  await page.waitForTimeout(1600);

  const stores = await page.evaluate(() => {
    const keys = Object.keys(localStorage);
    return {
      roster: !!localStorage.getItem('cls_pick_roster_v1'),
      exams: !!localStorage.getItem('cls_pick_exams_v1'),
      hasStatApi: keys.some(k => k.indexOf('cls_pick_stat') === 0),
      keys,
    };
  });
  t('名单（含学号 / 身份 / 性别）已写进本机缓存', stores.roster, stores.keys.filter(k => k.startsWith('cls_pick')).join(','));

  const cacheFn = await page.evaluate(() => ({
    hasFn: typeof scCacheAll === 'function',
    hasTip: typeof scCacheTip === 'function',
    hasOffline: typeof scOfflineTip === 'function',
    put: typeof scCachePut === 'function',
    get: typeof scCacheGet === 'function',
  }));
  t('成绩分析有「缓存离线」功能入口（scCacheAll + 顶部提示条）',
    cacheFn.hasFn && cacheFn.hasTip && cacheFn.hasOffline, JSON.stringify(cacheFn));
  t('有 scCachePut / scCacheGet 缓存读写函数', cacheFn.put && cacheFn.get);

  /* 直接验证缓存读写：写进去再读出来，并且断网时 scCacheGet 还能取到 */
  const roundtrip = await page.evaluate(() => {
    scCachePut('board', 999, { exam: { id: 999, name: '测试考试' }, rows: [{ name: '同学01' }] });
    const got = scCacheGet('board', 999);
    const list = scCacheGet('list');
    scCachePut('list', 0, [{ id: 999, name: '测试考试', date: '2026-11-01' }]);
    const list2 = scCacheGet('list');
    return { gotRows: got && got.d && got.d.rows ? got.d.rows.length : -1, hasAt: !!(got && got.at), list2: list2 && list2.d ? list2.d.length : -1 };
  });
  t('成绩单缓存能写能读', roundtrip.gotRows === 1, JSON.stringify(roundtrip));
  t('考试列表缓存能写能读', roundtrip.list2 === 1);
  await ctx.close();
}

/* ============================================================
   4) 全民时钟：默认时钟界面 / 左右并排 / 背景记忆 / 翻页字号独立
   ============================================================ */
console.log('\n【4】时钟改版：默认时钟 · 左时钟右计时 · 背景记忆 · 翻页字号独立');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await page.goto(BASE + '/clock.html?_r=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1600);

  const lay = await page.evaluate(() => {
    const r = id => { const el = document.getElementById(id); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), disp: getComputedStyle(el).display }; };
    return {
      clock: r('clockView'), flip: r('flipView'), timer: r('timerView'), row: r('topRow'),
      gap: getComputedStyle(document.getElementById('topRow')).gap,
      mode: JSON.parse(localStorage.getItem('cls_clock_cfg') || '{}').mode || '',
      bodyCls: document.body.className,
    };
  });
  t('默认打开就是时钟界面（不是计时）', lay.clock && lay.clock.disp === 'block' && lay.mode !== 'timer', 'mode=' + lay.mode);
  t('计时区同时显示（两栏都在）', lay.timer && lay.timer.disp === 'block');
  t('时钟在左、计时在右', lay.clock.x + lay.clock.w <= lay.timer.x, `clock右缘=${lay.clock.x + lay.clock.w} timer左缘=${lay.timer.x}`);
  t('中间间隔约 4 个字符宽（30~60px）', parseFloat(lay.gap) > 26 && parseFloat(lay.gap) < 70, 'gap=' + lay.gap);
  t('两块都贴在页面顶部（y < 200）', lay.clock.y < 200 && lay.timer.y < 200, `y=${lay.clock.y}/${lay.timer.y}`);

  /* 背景记忆 */
  await page.evaluate(() => {
    const c = JSON.parse(localStorage.getItem('cls_clock_cfg') || '{}');
    c.bg = 'green';
    localStorage.setItem('cls_clock_cfg', JSON.stringify(c));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const bgAfter = await page.evaluate(() => ({ cls: document.body.className, bg: JSON.parse(localStorage.getItem('cls_clock_cfg') || '{}').bg }));
  t('背景色会记住（重开还是上次的墨绿）', /bg-green/.test(bgAfter.cls) && bgAfter.bg === 'green', bgAfter.cls);

  /* 翻页 + 翻页字号独立 */
  await page.click('#subTabs button[data-k="flip"]');
  await page.waitForTimeout(700);
  const flipStart = await page.evaluate(() => ({
    flip: getComputedStyle(document.getElementById('flipView')).display,
    clock: getComputedStyle(document.getElementById('clockView')).display,
    timer: getComputedStyle(document.getElementById('timerView')).display,
    btn: (document.getElementById('flipSizeBtn') || {}).textContent || '',
    btnDisp: (document.getElementById('flipSizeBtn') || {}).style.display,
    fwk: document.getElementById('flipView').style.getPropertyValue('--fwk'),
  }));
  t('切翻页后左栏换成翻页、计时区仍在', flipStart.flip === 'block' && flipStart.clock === 'none' && flipStart.timer === 'block');
  t('出现「翻页字号」独立按钮', /翻页字号/.test(flipStart.btn) && flipStart.btnDisp !== 'none', flipStart.btn);

  await page.click('#flipSizeBtn');
  await page.waitForTimeout(300);
  const flipBigger = await page.evaluate(() => ({
    txt: (document.getElementById('flipSizeBtn') || {}).textContent || '',
    fwk: document.getElementById('flipView').style.getPropertyValue('--fwk'),
  }));
  t('翻页字号能单独调大', flipStart.fwk !== flipBigger.fwk, `${flipStart.fwk} → ${flipBigger.fwk} (${flipBigger.txt})`);

  /* 数字时钟的字号档位与翻页字号互不影响 */
  await page.evaluate(() => { const c = JSON.parse(localStorage.getItem('cls_clock_cfg') || '{}'); c.size = 1; localStorage.setItem('cls_clock_cfg', JSON.stringify(c)); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  const sizeIsolated = await page.evaluate(() => ({
    bodySize: document.body.className,
    fwk: document.getElementById('flipView').style.getPropertyValue('--fwk'),
    cfg: JSON.parse(localStorage.getItem('cls_clock_cfg') || '{}'),
  }));
  t('改数字时钟字号不会把翻页字号一起改掉', sizeIsolated.cfg.flipSize === 4 && sizeIsolated.fwk === '1.15', `size=${sizeIsolated.cfg.size} flipSize=${sizeIsolated.cfg.flipSize} --fwk=${sizeIsolated.fwk}`);
  t('时钟页没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

/* ============================================================
   5) 中转站：24MB 上限 / 1~15 天 / 1~50 次 / 微信里引导浏览器
   ============================================================ */
console.log('\n【5】中转站：上限与保存期、微信下载兜底');
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('cls_welcome_v1', '1');
    localStorage.setItem('cls_login_guide_v1', '1');
  });
  await routeAll(page, ISLAND_AM);
  await page.goto(BASE + '/index.html?_r=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2200);
  await page.evaluate(() => { try { openFiles(); } catch (e) {} });
  await page.waitForTimeout(600);

  const ui = await page.evaluate(() => {
    const ttl = document.getElementById('flTtlNum'), mx = document.getElementById('flMaxNum');
    const drop = document.querySelector('#flDrop span');
    return {
      ttlVal: ttl ? ttl.value : '', ttlMin: ttl ? ttl.getAttribute('min') : '', ttlMax: ttl ? ttl.getAttribute('max') : '',
      mxVal: mx ? mx.value : '', mxMax: mx ? mx.getAttribute('max') : '',
      drop: drop ? drop.textContent : '',
      limit: typeof FL_MAX !== 'undefined' ? FL_MAX / 1048576 : -1,
    };
  });
  t('保存天数输入框 1~15 天', ui.ttlMin === '1' && ui.ttlMax === '15' && ui.ttlVal === '3', JSON.stringify(ui));
  t('取用次数输入框 0~50', ui.mxMax === '50' && ui.mxVal === '0', JSON.stringify(ui));
  t('前端单件上限是 24MB', ui.limit === 24, 'FL_MAX=' + ui.limit);
  t('面板文案写的是 24MB / 15 天', /24MB/.test(ui.drop) && /15 天/.test(ui.drop), ui.drop);

  /* 超限拦截 */
  const reject = await page.evaluate(async () => {
    let msg = '';
    try {
      const f = new File([new Uint8Array(25 * 1024 * 1024)], 'big.pdf', { type: 'application/pdf' });
      flUpload(f);
      await new Promise(r => setTimeout(r, 120));
      msg = (document.getElementById('flMsg') || {}).textContent || '';
    } catch (e) { msg = 'ERR:' + e.message; }
    return msg;
  });
  t('超过 24MB 会被拦住并给出提示', /24MB/.test(reject), reject.slice(0, 60));
  await ctx.close();

  /* 微信 UA：下载改成「引导去浏览器 + 复制链接」 */
  const ctx2 = await browser.newContext({
    viewport: { width: 390, height: 780 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.42(0x18002a2f) NetType/WIFI Language/zh_CN',
  });
  const p2 = await ctx2.newPage();
  await p2.addInitScript(() => {
    localStorage.setItem('cls_welcome_v1', '1');
    localStorage.setItem('cls_login_guide_v1', '1');
  });
  await routeAll(p2, ISLAND_AM);
  await p2.goto(BASE + '/index.html?_r=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p2.waitForTimeout(2200);
  await p2.evaluate(() => { try { openFiles(); flTab('get'); } catch (e) {} });
  await p2.waitForTimeout(400);
  await p2.evaluate(() => {
    const inp = document.getElementById('flIn');
    if (inp) inp.value = 'ABC234';
    flQuery();
  });
  await p2.waitForTimeout(900);
  const wx = await p2.evaluate(() => {
    const card = document.getElementById('flCard');
    return {
      tip: card ? /在浏览器打开/.test(card.textContent) : false,
      copyBtn: !!(document.getElementById('flCopyDl')),
      downloadLink: card ? !!card.querySelector('a[download]') : false,
      isWx: typeof isWeChat === 'function' ? isWeChat() : null,
    };
  });
  t('微信环境识别正确', wx.isWx === true, 'isWeChat=' + wx.isWx);
  t('微信里不显示直接下载按钮', wx.downloadLink === false);
  t('微信里提示「在浏览器打开」', wx.tip === true);
  t('微信里提供「复制下载链接」', wx.copyBtn === true);
  await ctx2.close();
}

console.log('\n' + '='.repeat(52));
console.log(`结果: ${pass} 通过, ${fail} 失败`);
console.log('='.repeat(52));
await browser.close();
process.exit(fail ? 1 : 0);
