#!/usr/bin/env node
/**
 * v4.15.1 专项测试 —— 基础版补作业成绩 / 404 兜底 / 打砖块提速 / 吃豆人布局
 *
 * 用法：先起本地静态服务（python3 -m http.server 8899），再 node scripts/test_ui_v4151.mjs
 *
 * 这一版的重点不是「新功能」，是「站主实测踩到的坑」：
 *   · 基础版点「作业」404（链接指向不存在的目录）
 *   · 游戏页返回落到空地址
 *   · 打砖块手机上卡（逐帧 shadowBlur + 每帧重建背景渐变）
 *   · 吃豆人方向键「下」还在屏幕外
 * 所以断言都落在「真实位置 / 真实渲染 / 源码里那行东西还在不在」。
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CH = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const BASE = 'http://localhost:8899/';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '  [' + JSON.stringify(extra) + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + '  [' + JSON.stringify(extra) + ']'); }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ---------------- 静态断言（先跑，不用浏览器） ---------------- */
console.log('\nA. 基础版 · 静态');
const basic = read('basic.html');
ok(!/href="\.\/homework\/"/.test(basic), 'A1 不再引用不存在的 ./homework/ 目录');
ok(/href="#hw"/.test(basic) && /href="#score"/.test(basic), 'A2 导航改走页内锚点');
ok(/holiday_homeworks/.test(basic), 'A3 会读云端假期作业');
ok(/api\/scores\?action=me/.test(basic), 'A4 会读「我的成绩」');
ok(/cls_auth/.test(basic), 'A5 与完整版共用 cls_auth 登录态');
ok(/XMLHttpRequest/.test(basic) && !/\bfetch\s*\(/.test(basic) && !/=>/.test(basic), 'A6 仍是纯 ES5 + XHR（老设备可跑）');

console.log('\nB. 404 兜底');
ok(fs.existsSync(path.join(ROOT, '404.html')), 'B1 404.html 存在');
const nf = read('404.html');
ok(/location\.replace/.test(nf), 'B2 会自动跳回首页');
ok(/\/class-site\//.test(nf), 'B3 认得 GitHub Pages 的 /class-site/ 子路径');

console.log('\nC. 游戏页返回');
const gameFiles = fs.readdirSync(path.join(ROOT, 'games')).filter((f) => f.endsWith('.html'));
const noBack = gameFiles.filter((f) => !/class="back"/.test(read('games/' + f)));
ok(noBack.length === 0, 'C1 每个游戏页都有返回入口', noBack);
/* 只查「返回」那个 <a> 的 href；页面里的「去主站登录」还指着 ../index.html，那是另一件事 */
const badHref = gameFiles.filter((f) => /<a class="back" href="\.\.\/index\.html"/.test(read('games/' + f)));
ok(badHref.length === 0, 'C2 返回按钮不再写 ../index.html', badHref);
const noHist = gameFiles.filter((f) => !/history\.back\(\)/.test(read('games/' + f)));
ok(noHist.length === 0, 'C3 返回带 history.back() 兜底', noHist);

console.log('\nD. 打砖块 · 渲染成本');
const bk = read('games/breakout.html');
ok(/Math\.min\(1\.5,/.test(bk), 'D1 DPR 上限压到 1.5');
ok(/function buildBg\(/.test(bk), 'D2 背景预渲染成离屏画布');
ok(/function brickSprite\(/.test(bk), 'D3 砖块外观走贴图缓存');
const drawBrickBody = bk.slice(bk.indexOf('function drawBrick('), bk.indexOf('function drawDrop('));
ok(!/ctx\.shadowBlur\s*=/.test(drawBrickBody), 'D4 drawBrick 里不再有实时阴影');
const shadowCount = (bk.match(/ctx\.shadowBlur\s*=/g) || []).length;
ok(shadowCount <= 1, 'D5 主画布上实时阴影降至 ≤1 处', shadowCount);
ok(/i < 36;/.test(bk), 'D6 清波碎片降到 36');
ok(/i < 18;/.test(bk), 'D7 背景尘埃降到 18');

console.log('\nE. 吃豆人 · 尺寸自适配');
const pm = read('games/pacman.html');
ok(/function fitStage\(/.test(pm), 'E1 有 fitStage() 实测布局');
const stageRule = pm.slice(pm.indexOf('#stage{'), pm.indexOf('canvas{'));
ok(!/dvh/.test(stageRule), 'E2 #stage 不再靠 dvh 减固定值', stageRule.slice(0, 60));

/* ---------------- 浏览器实测 ---------------- */
const b = await chromium.launch({ executablePath: CH, args: ['--no-sandbox'] });

const CONTENT = JSON.stringify({
  ok: true,
  items: {
    announcements: [{ date: '2026-11-12 22:43', text: 'v4.15 更新！内容如下：\n【体验】打砖块画面重做' }],
    holiday_homeworks: [
      { id: 'hw-2', title: '高二上·第10周 周末作业', start: '2026-11-07', end: '2026-11-08',
        items: [{ subject: '语文', tasks: ['背诵 屈原列传 第三段'] },
                { subject: '数学', tasks: ['试卷1张（含答题卡）'] }] },
      { id: 'hw-1', title: '国庆假期作业', start: '2026-10-01', end: '2026-10-07',
        items: [{ subject: '物理', tasks: ['同步练习 p36–42'] }] }
    ]
  }
});
const ISLAND = JSON.stringify({ ok: true, data: { on: true, banner: { thu: '语 数 英 物 化 生' } } });
const SCORES = JSON.stringify({ ok: true, items: [{
  examId: 1, name: '期中考试', date: '2026-11-06', type: '期中',
  subjects: [{ key: 'chinese', name: '语文', full: 150 }, { key: 'math', name: '数学', full: 150 }],
  s: { chinese: 112, math: 128 }, schoolRank: 186
}] });

async function newPage(w, h) {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: h > 500, hasTouch: h > 500 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push(m.text()); });
  return { p, errs };
}

console.log('\nF. 基础版 · 实跑（接口用真实结构 mock）');
{
  const { p, errs } = await newPage(390, 844);
  await p.route('**/api/**', (route) => {
    const u = route.request().url();
    const h = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
    if (u.includes('/api/content')) return route.fulfill({ headers: h, body: CONTENT });
    if (u.includes('/api/island')) return route.fulfill({ headers: h, body: ISLAND });
    if (u.includes('/api/scores')) return route.fulfill({ headers: h, body: SCORES });
    if (u.includes('/api/auth')) return route.fulfill({ headers: h, body: JSON.stringify({ ok: true, token: 'tk_demo', user: { displayName: '余子康' } }) });
    return route.continue();
  });
  await p.goto(BASE + 'basic.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(900);

  const hw = await p.textContent('#hwBody');
  ok(/第10周/.test(hw), 'F1 作业区渲染出最近一份');
  ok(!(await p.isVisible('#hwOld')), 'F2 更早的作业默认折叠');
  ok(await p.isVisible('#hwMore'), 'F3 有「展开更早」入口');
  await p.click('#hwMore');
  await p.waitForTimeout(200);
  ok(/国庆假期作业/.test(await p.textContent('#hwBody')), 'F4 点击后展开更早作业');

  const sc = await p.textContent('#scoreBody');
  ok(/登录/.test(sc), 'F5 未登录显示登录表单');

  await p.fill('#lgUser', '余子康');
  await p.fill('#lgPwd', 'demo1234');
  await p.click('#lgBtn');
  await p.waitForTimeout(700);
  const sc2 = await p.textContent('#scoreBody');
  ok(/期中考试/.test(sc2), 'F6 登录后显示最近一次考试');
  ok(/112/.test(sc2) && /128/.test(sc2), 'F7 各科分数都在');
  ok(/原始总分\s*240/.test(sc2.replace(/\s+/g, ' ')) || /240/.test(sc2), 'F8 总分按科目求和');
  ok(/校排名第 186/.test(sc2), 'F9 显示校排名');
  ok(errs.length === 0, 'F10 无 JS 报错', errs);
  await p.close();
}

console.log('\nG. 404 页 · 子路径跳转');
{
  const { p } = await newPage(390, 700);
  await p.route('**/class-site/nope/**', (route) => route.fulfill({ status: 404, headers: { 'content-type': 'text/html' }, body: nf }));
  await p.goto('http://localhost:8899/class-site/nope/x.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
  const href = await p.getAttribute('#go', 'href');
  ok(href === '/class-site/', 'G1 在 /class-site/ 下会跳回 /class-site/', href);
  await p.close();
}

console.log('\nH. 打砖块 · 实跑');
{
  const { p, errs } = await newPage(390, 780);
  await p.goto(BASE + 'games/breakout.html?selftest=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(400);
  const dpr = await p.evaluate(() => {
    const cv = document.getElementById('cv');
    return { w: cv.width, h: cv.height };
  });
  ok(dpr.w <= 480 * 1.5 && dpr.h <= 720 * 1.5, 'H1 画布实际像素没超 1.5 倍', dpr);
  await p.click('#btnStart');
  await p.waitForTimeout(500);
  await p.evaluate(() => window.__clsBk && window.__clsBk.clearAll && window.__clsBk.clearAll());
  await p.waitForTimeout(400);
  const fps = await p.evaluate(() => new Promise((r) => {
    let n = 0; const t0 = performance.now();
    function f(t) { n++; if (t - t0 < 1000) requestAnimationFrame(f); else r(Math.round(n * 1000 / (t - t0))); }
    requestAnimationFrame(f);
  }));
  ok(fps >= 50, 'H2 清波演出期间仍跑满 50 帧以上', fps);
  ok(errs.length === 0, 'H3 无 JS 报错', errs);
  await p.close();
}

console.log('\nI. 吃豆人 · 窄屏方向键');
{
  const { p } = await newPage(320, 568);
  await p.goto(BASE + 'games/pacman.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(600);
  const m = await p.evaluate(() => {
    const d = document.querySelector('#dpad [data-d="d"]').getBoundingClientRect();
    return { bottom: Math.round(d.bottom), vh: innerHeight };
  });
  ok(m.bottom <= m.vh, 'I1 320×568 下「▼」完整在屏幕内', m);
  await p.close();
}

await b.close();
console.log('\n====================================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
