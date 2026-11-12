/**
 * v4.15.0 专项测试 —— 游戏画面重做 / 选关面板 / 方向键布局 / 循环 BGM
 *
 * 用法：先起本地静态服务（python3 -m http.server 8899），再 node scripts/test_ui_v4150.mjs
 *
 * 这一版全是「看得见才对」的改动，所以除了逻辑断言，还量了真实像素位置：
 *   · 方向键最后一个「▼」的 rect.bottom 是否还在视口内（站主报的 bug 就是这个）
 *   · 选关面板 100 个按钮会不会溢出、滚动区是不是真的能滚
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
  p.on('console', m => {
    if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push(m.text());
  });
  return errs;
}

/* ============================ 一、下落砖块：清波演出 ============================ */
console.log('\nA. 下落砖块 · 清波演出');
{
  const p = await b.newPage({ viewport: { width: 412, height: 915 } });
  const errs = watch(p);
  await p.goto(BASE + 'breakout.html?selftest=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(600);

  await p.evaluate(() => window.__clsBk.start());
  await p.waitForTimeout(900);

  const before = await p.evaluate(() => window.__clsBk.snap().fxLive);
  ok(before.flash === 0 && before.rings === 0, 'A1 开打时没有残留特效', before);

  const cleared = await p.evaluate(() => {
    window.__clsBk.clearAll();
    return window.__clsBk.snap();
  });
  ok(cleared.bricks === 0, 'A2 砖被清空');
  ok(cleared.fxLive.flash > 0.3, 'A3 触发白闪', +cleared.fxLive.flash.toFixed(2));
  ok(cleared.fxLive.rings >= 3, 'A4 三层冲击波都排上了', cleared.fxLive.rings);
  ok(cleared.fxLive.pops >= 2, 'A5 中央大字 + 加分飘字', cleared.fxLive.pops);
  ok(cleared.fxLive.slowMo > 0.3, 'A6 慢动作计时器已启动', +cleared.fxLive.slowMo.toFixed(2));

  /* 慢动作只该影响游戏时间，生存秒数涨得比真实时间慢 */
  const t0 = await p.evaluate(() => window.__clsBk.snap().survive);
  await p.waitForTimeout(1000);
  const t1 = await p.evaluate(() => window.__clsBk.snap().survive);
  ok((t1 - t0) < 0.75, 'A7 慢动作期间游戏时间被拉慢', +(t1 - t0).toFixed(2));

  await p.waitForTimeout(2600);
  const w2 = await p.evaluate(() => window.__clsBk.snap());
  ok(w2.wave === 2, 'A8 庆祝结束后自动续下一波', w2.wave);
  ok(w2.bricks > 0, 'A9 新一波砖墙已铺好', w2.bricks);
  ok(w2.fxLive.flash === 0, 'A10 白闪已淡出（不会一直泛白）', +w2.fxLive.flash.toFixed(2));

  /* 硬度曲线：第 2 波起才有中砖，第 4 波起才有硬砖 */
  const dist = await p.evaluate(() => [1, 2, 3, 4, 8, 12, 20].map(w => window.__clsBk.dist(w)));
  ok(dist[0].p2 === 0 && dist[0].p3 === 0, 'A11 第 1 波全是 1 击砖', dist[0]);
  ok(dist[1].p2 > 0, 'A12 第 2 波开始掺中砖', dist[1]);
  ok(dist[2].p3 === 0 && dist[3].p3 > 0, 'A13 第 4 波起出硬砖', { w3: dist[2].p3, w4: dist[3].p3 });
  ok(dist[6].p3 === 0.4 && dist[6].p2 === 0.5, 'A14 高波次封顶 50% 中砖 / 40% 硬砖', dist[6]);

  /* 死因文案：以前「球掉了」也会显示「砖墙压到底」（三元条件写反了） */
  const wall = await p.evaluate(() => {
    /* 必须开新局后**同步**连按：不重开的话球早掉出去了，测到的是「球掉了」 */
    window.__clsBk.start();
    for (let i = 0; i < 30; i++) window.__clsBk.press();
    return { st: window.__clsBk.snap().st, sub: document.getElementById('ovOverSub').textContent };
  });
  ok(wall.st === 'over', 'A15 砖墙压到危险线即结束', wall.st);
  ok(wall.sub === '砖墙压到底了', 'A16 结算说明与实际死因一致', wall.sub);

  ok(errs.length === 0, 'A17 无 JS 报错', errs.slice(0, 2));
  await p.close();
}

/* ============================ 二、循环 BGM ============================ */
console.log('\nB. 循环背景音乐');
{
  const p = await b.newPage({ viewport: { width: 412, height: 915 } });
  const errs = watch(p);
  await p.goto(BASE + 'breakout.html?selftest=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(400);

  const idle = await p.evaluate(() => (window.CLS_BGM ? window.CLS_BGM.status() : null));
  ok(!!idle, 'B1 bgm 引擎已加载');
  ok(idle.playing === false, 'B2 没点开始前不出声（浏览器要求用户手势）', idle);

  await p.evaluate(() => window.__clsBk.start());
  await p.waitForTimeout(600);
  const on = await p.evaluate(() => window.CLS_BGM.status());
  ok(on.playing === true, 'B3 开局后开始播放');
  ok(on.state === 'running', 'B4 AudioContext 处于 running', on.state);
  ok(on.song === 'breakout', 'B5 打砖块用自己的曲子', on.song);

  const muted = await p.evaluate(() => {
    document.getElementById('bgmBtn').click();
    return { st: window.CLS_BGM.status(), label: document.getElementById('bgmBtn').textContent,
             saved: localStorage.getItem('cls_bgm_muted') };
  });
  ok(muted.st.muted === true, 'B6 点一下静音');
  ok(muted.label === '🔇', 'B7 图标变成静音', muted.label);
  ok(muted.saved === '1', 'B8 静音状态写进本地存储', muted.saved);

  const unmuted = await p.evaluate(() => {
    document.getElementById('bgmBtn').click();
    return { st: window.CLS_BGM.status(), label: document.getElementById('bgmBtn').textContent };
  });
  ok(unmuted.st.muted === false && unmuted.label === '🎵', 'B9 再点一下恢复', unmuted.label);

  /* 刷新后应该记住静音 */
  await p.evaluate(() => { window.CLS_BGM.toggle(); });
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(300);
  const persisted = await p.evaluate(() => ({
    muted: window.CLS_BGM.muted(),
    label: document.getElementById('bgmBtn').textContent,
  }));
  ok(persisted.muted === true, 'B10 刷新后仍是静音');
  ok(persisted.label === '🔇', 'B11 刷新后图标跟着状态', persisted.label);
  await p.evaluate(() => localStorage.removeItem('cls_bgm_muted'));

  ok(errs.length === 0, 'B12 无音频相关报错', errs.slice(0, 2));
  await p.close();
}

/* ============================ 三、吃豆人：布局不再超出屏幕 ============================ */
console.log('\nC. 迷宫吃豆 · 布局');
for (const [tag, w, h] of [['320×568', 320, 568], ['360×640', 360, 640], ['390×844', 390, 844], ['412×915', 412, 915]]) {
  const ctx = await b.newContext({
    viewport: { width: w, height: h }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
  });
  const p = await ctx.newPage();
  const errs = watch(p);
  await p.goto(BASE + 'pacman.html?selftest=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(700);

  const geo = await p.evaluate(() => {
    const dpad = document.getElementById('dpad').getBoundingClientRect();
    const down = document.querySelector('#dpad button[data-d="d"]').getBoundingClientRect();
    const stage = document.getElementById('stage').getBoundingClientRect();
    return {
      vh: innerHeight,
      dpadBottom: Math.round(dpad.bottom),
      downBottom: Math.round(down.bottom),
      stageW: Math.round(stage.width),
      stageH: Math.round(stage.height),
      dpadW: Math.round(dpad.width),
    };
  });
  ok(geo.downBottom <= geo.vh + 0.5, tag + ' 方向键「▼」完整在屏幕内', { 底边: geo.downBottom, 屏高: geo.vh });
  ok(geo.dpadBottom <= geo.vh + 0.5, tag + ' 整个方向键面板未被裁切', geo.dpadBottom);
  ok(Math.abs(geo.stageW - geo.stageH) <= 1, tag + ' 迷宫保持正方形', [geo.stageW, geo.stageH]);

  /* 100 关的选关网格：有滚动区，且最后一条在滚动内容里（不是被直接切掉） */
  const menu = await p.evaluate(() => {
    const wrap = document.getElementById('lvWrap');
    const grid = document.getElementById('lvGrid');
    const btns = grid.querySelectorAll('button').length;
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    return {
      btns, cols,
      wrapH: Math.round(wrap.clientHeight),
      scrollH: wrap.scrollHeight,
      canScroll: getComputedStyle(wrap).overflowY,
      menuFits: document.getElementById('ovMenu').getBoundingClientRect().bottom <= innerHeight + 0.5,
    };
  });
  ok(menu.btns === 100, tag + ' 选关面板 100 个按钮齐全', menu.btns);
  ok(menu.cols >= 8, tag + ' 列数自适应（≥8 列）', menu.cols);
  ok(menu.canScroll === 'auto' || menu.canScroll === 'scroll', tag + ' 列表是独立滚动区', menu.canScroll);
  ok(menu.menuFits, tag + ' 选关面板整体不超出屏幕', { 高: menu.wrapH, 内容: menu.scrollH });

  await p.close();
  await ctx.close();
}

/* ============================ 四、吃豆人：交互 ============================ */
console.log('\nD. 迷宫吃豆 · 交互');
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errs = watch(p);
  await p.goto(BASE + 'pacman.html?selftest=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(600);

  /* 打一关出来，存档里 max 会变成 2，选关应自动滚到第 2 关 */
  await p.evaluate(() => {
    window.__clsPm.start(1);
    window.__clsPm.teleport(1, 1);
    window.__clsPm.setTime(window.__clsPm.snap().timeLimit * 0.8);
    window.__clsPm.win();
  });
  await p.waitForTimeout(300);
  const afterWin = await p.evaluate(() => window.__clsPm.save());
  ok(afterWin.max === 2, 'D1 通关解锁下一关', afterWin.max);

  const over = await p.evaluate(() => ({
    shown: !document.getElementById('ovOver').classList.contains('hide'),
    title: document.getElementById('overTitle').textContent,
    stars: document.querySelectorAll('#overStars i.on').length,
  }));
  ok(over.shown && over.title === '通关', 'D2 结算面板正常弹出', over);
  ok(over.stars === 3, 'D3 剩余时间充足给三星', over.stars);

  await p.click('#btnToMenu');
  await p.waitForTimeout(400);
  const back = await p.evaluate(() => {
    const wrap = document.getElementById('lvWrap');
    const cur = document.querySelector('#lvGrid .cur');
    const r1 = cur ? cur.getBoundingClientRect() : null;
    const r2 = wrap.getBoundingClientRect();
    return {
      menuShown: !document.getElementById('ovMenu').classList.contains('hide'),
      curLv: cur ? cur.getAttribute('data-lv') : null,
      inView: r1 ? (r1.top >= r2.top - 2 && r1.bottom <= r2.bottom + 2) : false,
      scrollTop: Math.round(wrap.scrollTop),
    };
  });
  ok(back.menuShown, 'D4 返回选关面板');
  ok(back.curLv === '2', 'D5 当前关标了高亮', back.curLv);

  /* 暂停面板 */
  await p.click('#lvGrid button[data-lv="2"]');
  await p.waitForTimeout(700);
  await p.click('#dpad button[data-d="s"]');
  await p.waitForTimeout(200);
  const pause = await p.evaluate(() => ({
    st: window.__clsPm.snap().st,
    shown: !document.getElementById('ovPause').classList.contains('hide'),
  }));
  ok(pause.st === 'pause' && pause.shown, 'D6 点 II 弹出暂停面板', pause);

  await p.click('#btnResume');
  await p.waitForTimeout(200);
  const resumed = await p.evaluate(() => ({
    st: window.__clsPm.snap().st,
    hidden: document.getElementById('ovPause').classList.contains('hide'),
  }));
  ok(resumed.st === 'play' && resumed.hidden, 'D7 点继续回到游戏', resumed);

  const music = await p.evaluate(() => window.CLS_BGM.status());
  ok(music.playing && music.song === 'pacman', 'D8 吃豆人用自己的曲子', music.song);

  ok(errs.length === 0, 'D9 无 JS 报错', errs.slice(0, 2));
  await p.close();
  await ctx.close();
}

await b.close();

console.log('\n' + '='.repeat(52));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
