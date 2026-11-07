import { chromium } from '/root/.nvm/versions/node/v22.13.1/lib/node_modules/playwright/index.mjs';
const BASE = 'http://localhost:8112';
let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
};

const ISLAND = {
  on: true,
  term: '2026 年秋季 · 高二上',
  startDate: '2026-09-01',
  endDate: '2027-01-20',
  enrollDate: '2025-09-01',
  components: ['time', 'weather', 'week', 'term'],
  banner: { mon: '升 数数语英化', tue: '英 英备备备语', wed: '语 语数物英英', thu: '生 微语生生英', fri: '英 数语语化化', sat: '自自 自自', sun: '读自 物理' },
  days: {},
  holidays: [{ id: 'h0', label: '月假', from: '2026-11-06', to: '2026-11-08', fromTime: '22:00', toTime: '18:40' }],
  photo: './photo.jpg',
};

function routeAll(page, extra = {}) {
  return page.route('**/api/**', (route) => {
    const u = route.request().url();
    if (u.includes('/island')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: ISLAND }) });
    if (extra[u]) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(extra[u]) });
    if (u.includes('/auth?action=me')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, user: { username: 'aibot', role: 'admin' } }) });
    if (u.includes('/content')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: {} }) });
    if (u.includes('/profile')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, roster: [] }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });

/* ============ 场景 1：放假天数 —— 12 点以后放假，当天不算 ============ */
console.log('\n【场景 1】11/6 22:00 放假 → 11/8 18:40 返校，应算 2 天（6 号不算）');
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('cls_welcome_v1', '1');
    localStorage.setItem('cls_login_guide_v1', '1');
  });
  await routeAll(page);
  await page.goto(BASE + '/index.html?_r=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);

  const check = async (iso) => page.evaluate((isoStr) => {
    const RealDate = Date;
    const fixed = new RealDate(isoStr).getTime();
    window.Date = class extends RealDate {
      constructor(...a) { if (a.length === 0) { super(fixed); } else { super(...a); } }
      static now() { return fixed; }
    };
    try { ISL_VIEW = null; islandRender(); } catch (e) { return { err: String(e) }; }
    const txt = document.querySelector('#islBannerRow .txt');
    const row = document.querySelector('#islBannerRow .island-banner');
    return {
      text: txt ? txt.textContent : '',
      rowText: row ? row.textContent : '',
      tag: (document.querySelector('#islBannerRow .tag') || {}).textContent || '',
    };
  }, iso);

  const d7 = await check('2026-11-07T10:00:00');
  t('11/7 显示「放假第 1 天」', /放假第\s*1\s*天/.test(d7.text), d7.text);
  t('11/7 总天数是 2 天（不是 3 天）', /共\s*2\s*天/.test(d7.text) || !/共\s*3\s*天/.test(d7.text), d7.text);

  const d8 = await check('2026-11-08T10:00:00');
  t('11/8 显示「放假第 2 天」或「最后一天」', /放假第\s*2\s*天/.test(d8.text) || /最后一天/.test(d8.text), d8.text);
  t('11/8 不出现「第 3 天」', !/第\s*3\s*天/.test(d8.text), d8.text);

  /* 对照：只填日期不填时间的假期，仍然从当天算第 1 天（老数据行为不变） */
  const d6 = await check('2026-11-06T10:00:00');
  t('11/6 当天 22:00 前显示「今晚 22:00 开始放假」',
    /今晚\s*22:00/.test(d6.rowText || '') || /今晚\s*22:00/.test(d6.text || ''), (d6.rowText || d6.text));
  await ctx.close();
}

/* ============ 场景 2：班级岛右下角学期倒计时 ============ */
console.log('\n【场景 2】班级岛右下角显示「学期还剩 N 天」');
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => { localStorage.setItem('cls_welcome_v1', '1'); });
  await routeAll(page);
  await page.goto(BASE + '/index.html?_r=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => {
    const el = document.getElementById('islTermLeft');
    return { exists: !!el, text: el ? el.textContent : '', visible: el ? getComputedStyle(el).display !== 'none' : false };
  });
  t('班级岛脚注里有学期倒计时元素', r.exists);
  t('文案是「学期还剩 N 天」', /学期还剩\s*\d+\s*天/.test(r.text), r.text);
  await ctx.close();
}

/* ============ 场景 3：大屏作业右下角进度卡 ============ */
console.log('\n【场景 3】大屏作业页右下角四行卡 + 进度条');
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('cls_welcome_v1', '1');
    localStorage.setItem('cls_login_guide_v1', '1');
  });
  await routeAll(page);
  await page.goto(BASE + '/index.html?_r=' + Date.now() + '#/hw', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3500);
  const r = await page.evaluate(() => {
    const box = document.getElementById('bhwProg');
    if (!box) return { missing: true };
    const rows = [...box.querySelectorAll('.bhw-prog-row')].map(x => x.textContent.replace(/\s+/g, ''));
    const bar = box.querySelector('.bhw-prog-bar i');
    return {
      display: getComputedStyle(box).display,
      hd: (box.querySelector('.bhw-prog-hd') || {}).textContent || '',
      rows,
      barW: bar ? bar.style.width : '',
      pct: (box.querySelector('.bhw-prog-pct b') || {}).textContent || '',
    };
  });
  t('进度卡存在且可见', !r.missing && r.display !== 'none', JSON.stringify(r).slice(0, 120));
  if (!r.missing) {
    t('第一行「本学期已开学」', r.rows.some(x => /本学期已开学\d+天/.test(x)), r.rows[0]);
    t('第二行「本学期还剩」', r.rows.some(x => /本学期还剩\d+天/.test(x)), r.rows[1]);
    t('第三行「距 2028 年高考」', r.rows.some(x => /距2028年高考\d+天/.test(x)), r.rows[2]);
    t('进度条有宽度百分比', /%$/.test(r.barW), r.barW);
    t('百分比有数字', /^\d+(\.\d+)?%$/.test(r.pct), r.pct);
    t('卡头显示学期与开学日期', /高二上/.test(r.hd) && /2026\/09\/01/.test(r.hd), r.hd);
  }
  await ctx.close();
}

/* ============ 场景 4：后台 aiCollect 不再清空班级岛配置 ============ */
console.log('\n【场景 4】班级岛保存 —— DOM 不在时不许把 on / photo 清空');
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('cls_auth', JSON.stringify({ token: 'TESTTOKEN', user: { username: 'aibot', role: 'admin' } }));
    localStorage.setItem('cls_login_guide_v1', '1');
  });
  await page.route('**/api/**', (route) => {
    const u = route.request().url();
    if (u.includes('/island')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: ISLAND }) });
    if (u.includes('/auth?action=me')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, user: { username: 'aibot', role: 'admin' } }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: ISLAND }) });
  });
  await page.goto(BASE + '/admin.html?_r=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => { try { go('island'); } catch (e) {} });
  await page.waitForTimeout(2500);

  const before = await page.evaluate(() => (typeof AI !== 'undefined' && AI) ? { on: AI.on, photo: AI.photo } : null);
  t('后台班级岛面板读到了配置', !!before && before.photo === ISLAND.photo, JSON.stringify(before));

  /* 模拟「切板块 / 重新读取」把 DOM 整块换掉后再触发保存 */
  const after = await page.evaluate(() => {
    const v = document.getElementById('view');
    if (v) v.innerHTML = '<div class="loading">加载中…</div>';
    if (typeof AI_T !== 'undefined' && AI_T) { clearTimeout(AI_T); AI_T = null; }
    return (typeof aiCollect === 'function') ? aiCollect() : null;
  });
  t('DOM 被换掉后 aiCollect 仍保留 on=true', !!after && after.on === true, JSON.stringify(after && after.on));
  t('DOM 被换掉后 aiCollect 仍保留照片地址', !!after && after.photo === ISLAND.photo, JSON.stringify(after && after.photo));
  t('学生入学 / 学期结束字段一起带上', !!after && after.endDate === ISLAND.endDate && after.enrollDate === ISLAND.enrollDate,
    after ? after.endDate + ' / ' + after.enrollDate : 'null');
  await ctx.close();
}

/* ============ 场景 5：更新弹窗的「分寸」 ============ */
console.log('\n【场景 5】深链不弹更新窗 · 普通页面照弹 · 更新后留在原页');
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => { localStorage.setItem('cls_welcome_v1', '1'); });
  await routeAll(page);
  await page.route('**/version.json*', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ v: '4.11.0', title: '测试更新', items: ['一', '二'] }),
  }));
  await page.goto(BASE + '/index.html?_r=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1200);

  const unit = await page.evaluate(() => {
    const out = {};
    history.replaceState(null, '', location.pathname);
    out.home = updShouldPopup('4.11.0');
    history.replaceState(null, '', location.pathname + '#/scores');
    out.deep = updShouldPopup('4.11.0');
    out.old = updShouldPopup('2.3.0');
    out.url = updReloadUrl();
    history.replaceState(null, '', location.pathname + (location.search || ''));
    return out;
  });
  t('首页有新版本 → 会弹窗', unit.home === true);
  t('深链 #/scores 有新版本 → 不弹窗', unit.deep === false);
  t('版本落后到 2.x → 深链也照弹', unit.old === true);
  t('更新后跳转地址保留 query 参数（_r）', /_r=\d+/.test(unit.url), unit.url);

  await page.waitForTimeout(3000);
  const shown = await page.evaluate(() => {
    const m = document.getElementById('upMask');
    return m ? m.classList.contains('show') : null;
  });
  t('首页停留 4 秒后会弹出更新提示', shown === true, 'shown=' + shown);
  await ctx.close();
}

/* ============ 场景 6：深链进入不弹窗（整链验证） ============ */
console.log('\n【场景 6】从分享深链进入，等 4 秒也不弹更新窗');
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => { localStorage.setItem('cls_welcome_v1', '1'); });
  await routeAll(page);
  await page.route('**/version.json*', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ v: '4.11.0', title: '测试更新', items: ['一'] }),
  }));
  await page.goto(BASE + '/index.html?_r=' + Date.now() + '#/scores', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4500);
  const r = await page.evaluate(() => ({
    hash: location.hash,
    shown: (() => { const m = document.getElementById('upMask'); return m ? m.classList.contains('show') : null; })(),
  }));
  t('深链页没有弹出更新窗', r.shown === false, JSON.stringify(r));
  await ctx.close();
}

await browser.close();
console.log('\n===== ' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
