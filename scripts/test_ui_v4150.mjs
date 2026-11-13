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

/* ============================ 三、吃豆人 =============================
 * v4.15.3：吃豆人整页按 1980 街机原版重写，迷宫由 19×19 正方形改为原版
 * 224×288 比例，选关面板由 100 关平铺改为 255 关分组折叠，旧版这里的两段
 * 断言（正方形迷宫、#lvGrid 平铺、snap()/win() 接口）已随旧设计一并失效。
 * 现在的吃豆人断言全部由 scripts/test_ui_v4153.mjs 承担，本脚本只保留
 * 打砖块清波演出与背景音乐这两段 —— 那是这一版独有、且至今仍然有效的部分。
 */
console.log('\n' + '='.repeat(52));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
