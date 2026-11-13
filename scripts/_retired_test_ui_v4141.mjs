/* ⚠️ 已退役（v4.15.3）：本脚本检验的是「100 关平铺 + 6 列自适应 + 固定滚动区」
   那一版选关面板。吃豆人按 1980 街机原版重制后，选关改为 255 关、每 20 关一组
   折叠，整套 DOM 结构与交互都换了，这些断言不再对应任何现存实现。
   现行断言见 scripts/test_ui_v4153.mjs（C1–C5）。文件保留仅作历史参照。 */
/**
 * v4.14.1 专项测试 —— 两个游戏（下落砖块 / 迷宫吃豆）
 *
 * 用法：先起本地静态服务（python3 -m http.server 8899），再 node scripts/test_ui_v4141.mjs
 *
 * 为什么用 ?selftest=1：
 *   两个游戏都包在 IIFE 里，外部拿不到内部状态。页面只在带这个参数时才挂
 *   window.__clsBk / window.__clsPm，线上正常访问拿不到（否则谁都能在控制台
 *   调 win() 白嫖星星、调 press() 硬改局面）。
 */
import { chromium } from 'playwright-core';

const CH = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const BASE = 'http://localhost:8899/games/';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '  [' + JSON.stringify(extra) + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + '  [' + JSON.stringify(extra) + ']'); }
}

const b = await chromium.launch({ executablePath: CH, args: ['--no-sandbox'] });

function watch(p) {
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  return errs;
}

/* ============================ 一、下落砖块 ============================ */
console.log('\nA. 下落砖块');
{
  const p = await b.newPage({ viewport: { width: 412, height: 915 } });
  const errs = watch(p);
  await p.goto(BASE + 'breakout.html?selftest=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(600);

  const init = await p.evaluate(() => window.__clsBk.snap());
  ok(init.bricks === 35, 'A1 砖墙 7×5 = 35 块', init.bricks);
  ok(init.kinds.filter(k => k === 'skill').length === 3, 'A2 第一波 3 块技能砖', init.kinds);
  ok(init.kinds.filter(k => k === 'bomb').length === 0, 'A3 第一波不出炸弹砖（第 3 波起）');
  ok(init.fallEvery === 10, 'A4 首波下压间隔 10 秒', init.fallEvery);

  const skills = await p.evaluate(() => window.__clsBk.skills.map(s => s.k));
  ok(skills.length === 5, 'A5 五种技能齐全', skills);

  await p.evaluate(() => window.__clsBk.start());
  await p.waitForTimeout(2200);
  const run = await p.evaluate(() => window.__clsBk.snap());
  ok(run.st === 'play', 'A6 开局后进入 play', run.st);
  ok(run.bricks < 35, 'A7 球能打碎砖块', { left: run.bricks });
  ok(run.balls === 1, 'A8 开局一颗球', run.balls);
  ok(run.survive > 1.5, 'A9 生存计时在走', +run.survive.toFixed(1));

  /* 技能生效 */
  const fxr = await p.evaluate(() => {
    const sk = window.__clsBk.skills;
    sk.forEach(s => window.__clsBk.applySkill(s));
    return window.__clsBk.snap().fx;
  });
  ok(fxr.pierce === 8 && fxr.slow === 10 && fxr.wide === 12, 'A10 穿透/时缓/宽板时长正确', fxr);
  ok(fxr.shield === 1, 'A11 护盾计次生效', fxr.shield);

  /* 下压到底：15 次左右应该结束（GY=110，5 行，DANGER=652） */
  const press = await p.evaluate(() => {
    let n = 0;
    while (window.__clsBk.snap().st === 'play' && n < 40) { window.__clsBk.press(); n++; }
    return { n: n, st: window.__clsBk.snap().st };
  });
  ok(press.st === 'over', 'A12 砖墙压到底即结束', press);
  ok(press.n >= 12 && press.n <= 18, 'A13 触底需要 12~18 次下压', press.n);
  ok(errs.length === 0, 'A14 无脚本报错', errs.slice(0, 2));
  await p.close();
}

/* 电脑端键盘：按住右方向键必须连续移动 */
{
  const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
  const errs = watch(p);
  await p.goto(BASE + 'breakout.html?selftest=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(400);
  await p.evaluate(() => window.__clsBk.start());
  await p.waitForTimeout(300);
  const x0 = (await p.evaluate(() => window.__clsBk.snap())).padX;
  await p.keyboard.down('ArrowRight');
  await p.waitForTimeout(500);
  await p.keyboard.up('ArrowRight');
  const x1 = (await p.evaluate(() => window.__clsBk.snap())).padX;
  ok(x1 - x0 > 100, 'A15 电脑端按住右键连续移动（不是瞬移 26px）', { x0: Math.round(x0), x1: Math.round(x1) });
  ok(errs.length === 0, 'A16 无脚本报错');
  await p.close();
}

/* ============================ 二、迷宫吃豆 ============================ */
console.log('\nB. 迷宫吃豆');
{
  const p = await b.newPage({ viewport: { width: 412, height: 915 } });
  const errs = watch(p);
  await p.goto(BASE + 'pacman.html?selftest=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(600);

  const menu = await p.evaluate(() => ({
    total: document.querySelectorAll('#lvGrid button').length,
    enabled: document.querySelectorAll('#lvGrid button:not([disabled])').length
  }));
  ok(menu.total === 100, 'B1 关卡数 100', menu.total);
  ok(menu.enabled === 1, 'B2 新玩家只解锁第 1 关', menu.enabled);

  await p.evaluate(() => window.__clsPm.start(1));
  await p.waitForTimeout(1400);
  const s1 = await p.evaluate(() => window.__clsPm.snap());
  ok(s1.st === 'play', 'B3 第 1 关能开', s1.st);
  ok(s1.total > 150, 'B4 第 1 关豆子数 > 150', s1.total);
  ok(s1.ghosts === 2, 'B5 前期 2 只追捕者', s1.ghosts);
  ok(s1.life === 3, 'B6 三条命', s1.life);
  ok(s1.left < s1.total, 'B7 吃豆人自动开吃', { left: s1.left, total: s1.total });

  /* 100 关全跑：生成速度 + 数据合法性 */
  const sweep = await p.evaluate(() => {
    const bad = [];
    const t0 = performance.now();
    let slowest = 0, minBeans = 1e9;
    for (let L = 1; L <= 100; L++) {
      const a = performance.now();
      window.__clsPm.load(L);
      slowest = Math.max(slowest, performance.now() - a);
      const s = window.__clsPm.snap();
      const g = window.__clsPm.grid();
      if (s.total < 60) bad.push(['beans', L, s.total]);
      if (g[s.pac.y][s.pac.x] !== 0) bad.push(['pacInWall', L]);
      if (s.ghosts < 2) bad.push(['ghosts', L, s.ghosts]);
      if (s.timeLimit < 30) bad.push(['timeLimit', L, s.timeLimit]);
      for (const gp of s.ghostPos) if (g[gp.y][gp.x] !== 0) bad.push(['ghostInWall', L]);
      minBeans = Math.min(minBeans, s.total);
    }
    return { ms: Math.round(performance.now() - t0), slowest: Math.round(slowest), minBeans, bad: bad.slice(0, 5) };
  });
  ok(sweep.bad.length === 0, 'B8 100 关全部生成合法（无人卡墙 / 无空气关）', sweep.bad);
  ok(sweep.ms < 800, 'B9 100 关生成总耗时 < 800ms', sweep.ms);
  ok(sweep.slowest < 60, 'B10 单关生成最慢 < 60ms', sweep.slowest);
  ok(sweep.minBeans > 60, 'B11 豆子最少的关也 > 60 颗', sweep.minBeans);

  /* 难度逐关平滑：不能出现大跳 */
  const curve = await p.evaluate(() => {
    const arr = [];
    for (let L = 1; L <= 100; L++) arr.push(window.__clsPm.param(L));
    let maxJump = 0;
    for (let i = 1; i < arr.length; i++) {
      maxJump = Math.max(maxJump, Math.abs(arr[i].gspeed - arr[i - 1].gspeed));
    }
    return {
      s1: +arr[0].gspeed.toFixed(2), s100: +arr[99].gspeed.toFixed(2),
      w1: +arr[0].wander.toFixed(2), w100: +arr[99].wander.toFixed(2),
      e1: arr[0].energizers, e100: arr[99].energizers,
      maxJump: +maxJump.toFixed(3)
    };
  });
  ok(curve.s1 === 4 && curve.s100 === 5.6, 'B12 追捕者速度 4.0 → 5.6', [curve.s1, curve.s100]);
  ok(curve.w1 > 0.2 && curve.w100 === 0, 'B13 迷路率 0.26 → 0（前期会拐错弯）', [curve.w1, curve.w100]);
  ok(curve.e1 === 4 && curve.e100 === 1, 'B14 能量豆 4 颗 → 1 颗', [curve.e1, curve.e100]);
  ok(curve.maxJump < 0.03, 'B15 相邻两关速度差 < 0.03（逐关微调，不是跳档）', curve.maxJump);

  ok(errs.length === 0, 'B16 无脚本报错', errs.slice(0, 2));
  await p.close();
}

/* 通关 → 解锁下一关 → 只能选已解锁的 */
{
  const p = await b.newPage({ viewport: { width: 412, height: 915 } });
  const errs = watch(p);
  await p.goto(BASE + 'pacman.html?selftest=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(600);
  await p.evaluate(() => window.__clsPm.start(1));
  await p.waitForTimeout(300);
  await p.evaluate(() => window.__clsPm.win());
  await p.waitForTimeout(400);
  const w = await p.evaluate(() => ({
    max: window.__clsPm.save().max,
    ls: JSON.parse(localStorage.getItem('cls_pm_save_v1') || 'null'),
    stars: document.querySelectorAll('#overStars i.on').length,
    overShown: !document.getElementById('ovOver').classList.contains('hide')
  }));
  ok(w.overShown, 'B17 通关弹结算页');
  ok(w.stars >= 1, 'B18 结算页有星级', w.stars);
  ok(w.max === 2, 'B19 通关后解锁下一关', w.max);
  ok(w.ls && w.ls.max === 2, 'B20 解锁状态写进 localStorage', w.ls && w.ls.max);

  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(600);
  const after = await p.evaluate(() => document.querySelectorAll('#lvGrid button:not([disabled])').length);
  ok(after === 2, 'B21 重载后 2 关可选', after);

  /* 锁着的关点了不该有反应 */
  await p.evaluate(() => localStorage.setItem('cls_pm_save_v1', JSON.stringify({ max: 5, stars: {} })));
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(600);
  await p.click('#lvGrid button[data-lv="9"]', { force: true });
  await p.waitForTimeout(300);
  const stillMenu = await p.evaluate(() => window.__clsPm.snap().st);
  ok(stillMenu === 'menu', 'B22 点未解锁的关没反应', stillMenu);
  await p.click('#lvGrid button[data-lv="4"]');
  await p.waitForTimeout(500);
  const opened = await p.evaluate(() => window.__clsPm.snap());
  ok(opened.st === 'play' && opened.lv === 4, 'B23 点已解锁的关能进', [opened.st, opened.lv]);

  /* 超时 */
  await p.evaluate(() => window.__clsPm.setTime(0.3));
  await p.waitForTimeout(900);
  const to = await p.evaluate(() => ({
    st: window.__clsPm.snap().st,
    title: document.getElementById('overTitle').textContent
  }));
  ok(to.st === 'over' && to.title === '挑战失败', 'B24 时间到判负', to);
  ok(errs.length === 0, 'B25 无脚本报错', errs.slice(0, 2));
  await p.close();
}

/* 手机端：方向键可见 + 点击能走 */
{
  const ctx = await b.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36'
  });
  const p = await ctx.newPage();
  const errs = watch(p);
  await p.goto(BASE + 'pacman.html?selftest=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(700);
  const shown = await p.evaluate(() => {
    const d = document.getElementById('dpad');
    return getComputedStyle(d).display !== 'none' && d.getBoundingClientRect().height > 120;
  });
  ok(shown, 'B26 手机端显示虚拟方向键');

  await p.evaluate(() => window.__clsPm.start(1));
  await p.waitForTimeout(400);
  const before = await p.evaluate(() => window.__clsPm.snap());
  for (const d of ['u', 'l', 'd', 'r']) {
    await p.click(`#dpad button[data-d="${d}"]`);
    await p.waitForTimeout(400);
  }
  const after = await p.evaluate(() => window.__clsPm.snap());
  ok(after.left < before.left || after.score > before.score,
    'B27 点方向键后吃豆人真的动了', { moved: before.left - after.left });
  ok(errs.length === 0, 'B28 无脚本报错', errs.slice(0, 2));
  await ctx.close();
}

/* ============================ 三、入口与云端 ============================ */
console.log('\nC. 入口与云端');
{
  const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
  await p.goto('http://localhost:8899/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(800);
  const links = await p.evaluate(() => HIDDEN_FUN_LINKS
    .filter(l => /games\//.test(l.url))
    .map(l => ({ t: l.title, u: l.url })));
  ok(links.some(l => /breakout/.test(l.u) && l.t === '下落砖块'), 'C1 娱乐天地有「下落砖块」入口', links.find(l => /breakout/.test(l.u)));
  ok(links.some(l => /pacman/.test(l.u) && l.t === '迷宫吃豆'), 'C2 娱乐天地有「迷宫吃豆」入口', links.find(l => /pacman/.test(l.u)));

  /* 排行榜两个新签：直接调 boardPaint，灌假数据 */
  const tabs = await p.evaluate(() => {
    BOARD_STATE.data = { breakout: { meta: { unit: '秒' }, ranks: [] }, pacman: { meta: { unit: '关' }, ranks: [] } };
    BOARD_STATE.loading = false;
    document.getElementById('gameBoardMask').classList.add('show');
    boardPaint();
    return Array.from(document.querySelectorAll('#boardTabs .board-tab')).map(x => x.textContent.trim());
  });
  ok(tabs.some(t => /下落砖块/.test(t)), 'C3 排行榜有「下落砖块」签', tabs);
  ok(tabs.some(t => /迷宫吃豆/.test(t)), 'C4 排行榜有「迷宫吃豆」签', tabs);
  await p.close();
}

await b.close();
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
