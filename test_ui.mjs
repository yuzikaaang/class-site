#!/usr/bin/env node
/* ============================================================================
 * test_ui.mjs —— 真跑浏览器的冒烟测试（v3.9.15 新增）
 * ----------------------------------------------------------------------------
 * 背景（站主 2026-10-23）：「根据你已有的 skill 去自动选择」+ 之前审计指出的
 *   「3136 项测试里 64% 只是源码正则，4 个真实 bug 全被放过」。
 *
 * 这个文件补的是「行为」而不是「代码长得像」：
 *   · 真的用 Chromium 打开页面，量高度、点数、拖滑块、断脚本
 *   · 不依赖线上网络：接口统一 mock，本地起 http server 即可跑
 *
 * 跑法：
 *   python3 -m http.server 8111 &        # 在仓库根目录
 *   node test_ui.mjs                     # 默认连 http://localhost:8111
 *   BASE=http://localhost:8111 node test_ui.mjs
 * ========================================================================= */

import { chromium } from '/root/.nvm/versions/node/v22.13.1/lib/node_modules/playwright/index.mjs';

const BASE = process.env.BASE || 'http://localhost:8111';
let pass = 0;
let fail = 0;
const fails = [];

function t(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    fails.push(name + (detail ? '  → ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? '  → ' + detail : ''));
  }
}

/* 统一的接口桩：岛屿 + 内容 + 其它一律 ok */
function mockApi(route) {
  const u = route.request().url();
  if (u.includes('/api/island')) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: {
          on: true,
          term: '2026 年秋季 · 高二上',
          startDate: '2026-09-01',
          components: ['time', 'weather', 'week', 'term'],
          banner: { fri: '英 数语语化化 体生英物 听自生生自' },
          days: {},
          holidays: [],
          photo: '',
        },
      }),
    });
  }
  if (u.includes('/api/content')) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        items: {
          announcements: [
            { date: '2026-10-23 12:00', text: '冒烟测试用公告：明天第三节数学测验。' },
          ],
        },
        serverTime: 1,
        count: 1,
      }),
    });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });

/* ---------------------------------------------------------------- 1) 手机端密度 */
console.log('\n【1】手机端首屏密度（390×844）');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
  await page.addInitScript(() => {
    localStorage.setItem('cls_login_guide_v1', '1');
    localStorage.setItem('cls_welcome_v1', '1');
  });
  await page.route('**/api/**', mockApi);
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => document.querySelectorAll('.allboard-mask,.mask').forEach((m) => { m.classList.remove('show'); m.style.display = 'none'; }));

  const r = await page.evaluate(() => {
    const hd = document.querySelector('header');
    const isl = document.getElementById('classIsland');
    const meta = document.querySelector('.island-meta');
    const chips = document.querySelector('.island-row.isl-chips');
    const cs = (el) => (el ? getComputedStyle(el).display : 'missing');
    return {
      header: hd ? Math.round(hd.getBoundingClientRect().height) : -1,
      island: isl ? Math.round(isl.getBoundingClientRect().height) : -1,
      meta: cs(meta),
      chips: cs(chips),
      cards: document.querySelectorAll('#grid .card').length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  t('头部收成一行（< 80px）', r.header < 80, '实际 ' + r.header + 'px');
  t('班级岛默认收起（< 130px）', r.island < 130, '实际 ' + r.island + 'px');
  t('信息条存在且可见、四格默认隐藏', r.meta === 'flex' && r.chips === 'none',
    'meta=' + r.meta + ' chips=' + r.chips + '（meta=missing 说明 app.js 没更新）');
  t('8 张卡片正常渲染', r.cards === 8, '实际 ' + r.cards);
  t('无横向溢出', r.overflow <= 0, '溢出 ' + r.overflow + 'px');

  /* 展开 / 收起 */
  await page.click('#islMeta');
  await page.waitForTimeout(400);
  const open = await page.evaluate(() => ({
    h: Math.round(document.getElementById('classIsland').getBoundingClientRect().height),
    chips: getComputedStyle(document.querySelector('.island-row.isl-chips')).display,
    cue: document.getElementById('islCue').textContent,
  }));
  t('点「详情」展开四格', open.chips !== 'none' && open.h > r.island, JSON.stringify(open));
  t('按钮文案变成「收起」', open.cue === '收起', open.cue);
  await page.click('#islMeta');
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => getComputedStyle(document.querySelector('.island-row.isl-chips')).display);
  t('再点一次收起', back === 'none', back);
  t('无 JS 报错', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ---------------------------------------------------------------- 2) 老内核滑块 */
console.log('\n【2】老内核（无 PointerEvent）拖字号滑块');
{
  const ctx = await browser.newContext({ viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    try { delete window.PointerEvent; } catch (e) {}
    localStorage.setItem('cls_login_guide_v1', '1');
    localStorage.setItem('cls_welcome_v1', '1');
  });
  await page.route('**/api/**', mockApi);
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(2000);
  await page.evaluate(() => { try { openSettings(); uiSec('look'); } catch (e) {} });
  await page.waitForTimeout(700);
  const box = await page.evaluate(() => {
    const el = document.getElementById('snapFs');
    if (!el) return null;
    const r = el.querySelector('.snap-line').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, fs: UI.fs };
  });
  t('设置里能找到字号滑块', !!box);
  if (box) {
    const cdp = await ctx.newCDPSession(page);
    const y = box.y + box.h / 2;
    const x0 = box.x + box.w * 0.2;
    const x1 = box.x + box.w * 0.92;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
    for (let i = 1; i <= 5; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * i / 5, y }] });
      await page.waitForTimeout(60);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => UI.fs);
    t('触摸拖动可改字号（100% → 更大）', after > box.fs, box.fs + ' → ' + after);
  }
  await ctx.close();
}

/* ---------------------------------------------------------------- 3) 轻量模式 */
console.log('\n【3】轻量模式：不拉外部资源');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('cls_login_guide_v1', '1');
    localStorage.setItem('cls_welcome_v1', '1');
    localStorage.setItem('cls_lite_mode', '1');
  });
  const external = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(BASE) && !u.includes('api.classsite.dpdns.org')) external.push(u);
  });
  await page.route('**/api/**', mockApi);
  await page.goto(BASE + '/index.html', { waitUntil: 'load', timeout: 120000 });
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => ({
    lite: document.documentElement.getAttribute('data-lite'),
    wx: (document.getElementById('islWx') || {}).textContent,
  }));
  t('data-lite 已置位', r.lite === '1', String(r.lite));
  t('天气不发请求（显示 —）', r.wx === '—', String(r.wx));
  t('零外部请求（统计/语录/图床都不拉）', external.length === 0, external.slice(0, 3).join(' | '));
  await ctx.close();
}

/* ---------------------------------------------------------------- 4) 脚本挂掉的兜底 */
console.log('\n【4】app.js 加载失败时不白屏');
{
  const ctx = await browser.newContext({ viewport: { width: 768, height: 1024 } });
  const page = await ctx.newPage();
  await page.route('**/app.min.js*', (r) => r.abort());
  await page.route('**/app.js*', (r) => r.abort());
  await page.route('**/api/**', mockApi);
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(13500);
  const r = await page.evaluate(() => {
    const el = document.getElementById('legacyFallback');
    return { shown: !!el, basic: el ? !!el.querySelector('a[href*="basic"]') : false };
  });
  t('出现兜底提示', r.shown);
  t('提供「基础版」入口', r.basic);
  await ctx.close();
}

/* ---------------------------------------------------------------- 5) 基础版页面 */
console.log('\n【5】基础版页面（老设备）');
{
  const ctx = await browser.newContext({ viewport: { width: 768, height: 1024 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
  await page.route('**/api/**', mockApi);
  await page.goto(BASE + '/basic.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => ({
    items: document.querySelectorAll('#annList .item').length,
    banner: (document.getElementById('islandText') || {}).textContent,
  }));
  t('公告渲染出来了', r.items >= 1, '条数 ' + r.items);
  t('今日事项显示', !!r.banner && r.banner !== '—', String(r.banner));
  t('无 JS 报错', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

await browser.close();

console.log('\n' + '='.repeat(46));
console.log(`结果: ${pass} 通过, ${fail} 失败（共 ${pass + fail} 项）`);
if (fail) {
  console.log('\n失败项:');
  fails.forEach((f) => console.log('  - ' + f));
}
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
