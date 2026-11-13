/* v4.15.3 专项：吃豆人按 1980 街机原版重制
 * ------------------------------------------------------------
 * 上一版是「19×19 随机迷宫 + 100 关 + 技能卡」，和原版是两套东西。
 * 这一版整页重写成原版规则，本脚本守的是这些**可核对的事实**：
 *   · 28×31 固定迷宫、240 豆 + 4 能量豆（改一格就会挂）
 *   · 四只幽灵的目标格算法（含 Pinky / Inky 朝上时的坐标溢出 bug）
 *   · 速度表、惊吓时长表、水果表、scatter/chase 秒表
 *   · 吃幽灵→眼睛→回巢→复出的完整链路
 *   · 255 关、每 20 关一组的折叠选关
 */
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const CH = process.env.CHROME_PATH || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://127.0.0.1:8899';

let pass = 0, fail = 0;
const out = [];
function ok(cond, name, extra) {
  if (cond) { pass++; out.push(`  ✓ ${name}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`); }
  else { fail++; out.push(`  ✗ ${name}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`); }
}
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const pm = read('games/pacman.html');

/* ---------- A. 静态：地图与原版一致 ---------- */
{
  const i = pm.indexOf('var MAP = [');
  const j = pm.indexOf('];', i);
  const rows = [...pm.slice(i, j).matchAll(/'([^']*)'/g)].map((m) => m[1]);
  ok(rows.length === 31, 'A1 迷宫 31 行', rows.length);
  ok(rows.every((r) => r.length === 28), 'A2 每行 28 列', rows.map((r) => r.length).filter((n) => n !== 28));
  const flat = rows.join('');
  const dots = flat.split('.').length - 1;
  const ener = flat.split('o').length - 1;
  ok(dots === 240, 'A3 普通豆 240 颗', dots);
  ok(ener === 4, 'A4 能量豆 4 颗', ener);
  ok(dots + ener === 244, 'A5 合计 244 颗', dots + ener);

  ok(/MAXLV\s*=\s*255/.test(pm), 'A6 关卡数 255（原版）');
  ok(!/genMaze|openRate|技能卡/.test(pm), 'A7 旧版随机迷宫 / 技能卡已移除');
  ok(/'12,11':\s*1,\s*'15,11':\s*1,\s*'12,23':\s*1,\s*'15,23':\s*1/.test(pm), 'A8 4 个禁上格（原版 no-up zones）');
  ok(/GHOST_COLOR\s*=\s*\['#ff0000',\s*'#ffb8ff',\s*'#00ffff',\s*'#ffb852'\]/.test(pm),
     'A9 四只幽灵用原版四色');
}

/* ---------- B. 原版参数表 ---------- */
{
  ok(/level === 1 \? 0\.80 : level <= 4 \? 0\.90 : level <= 20 \? 1\.00 : 0\.90/.test(pm),
     'B1 吃豆人速度 80/90/100/90%');
  ok(/level === 1 \? 0\.71 : level <= 4 \? 0\.79 : level <= 20 \? 0\.87 : 0\.79/.test(pm),
     'B2 吃豆时减速 71/79/87/79%');
  ok(/level === 1 \? 0\.75 : level <= 4 \? 0\.85 : 0\.95/.test(pm),
     'B3 幽灵速度 75/85/95%');
  ok(/level === 1 \? 0\.40 : level <= 4 \? 0\.45 : 0\.50/.test(pm),
     'B4 隧道减速 40/45/50%');
  ok(/FRIGHT_T\s*=\s*\[6,5,4,3,2,5,2,2,1,5,2,1,1,3,1,1,0,1,0\]/.test(pm),
     'B5 惊吓时长表与原版一致（第 17 关 0 秒）');
  ok(/\['scatter',7\],\s*\['chase',20\],\s*\['scatter',7\],\s*\['chase',20\]/.test(pm),
     'B6 scatter/chase 每段 7/20 秒');
  ok(/if \(pd\.y === -1\) bx -= 4;/.test(pm), 'B7 复刻 Pinky 朝上时的坐标 bug');
  ok(/if \(pd\.y === -1\) ax -= 2;/.test(pm), 'B8 复刻 Inky 朝上时的坐标 bug');
  ok(/dx \* dx \+ dy \* dy >= 64/.test(pm), 'B9 Clyde 8 格阈值');
  ok(/dotEaten === 70 \|\| dotEaten === 170/.test(pm), 'B10 水果在第 70 / 170 颗豆出现');
  ok(/200 \* Math\.pow\(2, Math\.min\(3, chain - 1\)\)/.test(pm), 'B11 连吃 200/400/800/1600');
}

/* ---------- C. 运行时 ---------- */
const b = await chromium.launch({ executablePath: CH, args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(`${BASE}/games/pacman.html?selftest=1`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(500);

/* C1 选关面板 */
{
  const m = await p.evaluate(() => ({
    groups: document.querySelectorAll('.grp').length,
    btns: document.querySelectorAll('.grpB button').length,
    open: document.querySelectorAll('.grp.open').length,
    heads: [...document.querySelectorAll('.grpT .nm')].map((e) => e.textContent)
  }));
  ok(m.groups === 13, 'C1 255 关分成 13 组（20 关一组）', m.groups);
  ok(m.btns === 255, 'C2 关卡按钮共 255 个', m.btns);
  ok(m.open === 1, 'C3 默认只展开当前进度那一组', m.open);
  ok(m.heads[0] === '第 1–20 关' && m.heads[12] === '第 241–255 关', 'C4 组标题区间正确', [m.heads[0], m.heads[12]]);

  const heads = await p.$$('.grpT');
  await heads[3].click();
  await p.waitForTimeout(120);
  const openAfter = await p.evaluate(() => document.querySelectorAll('.grp.open').length);
  await heads[3].click();
  await p.waitForTimeout(120);
  const openBack = await p.evaluate(() => document.querySelectorAll('.grp.open').length);
  ok(openAfter === 2 && openBack === 1, 'C5 点组标题可展开 / 收起', [openAfter, openBack]);
}

/* C6 开局 */
await p.evaluate(() => { window.__clsPm.mute(true); window.__clsPm.start(1); });
await p.waitForTimeout(400);
let s = await p.evaluate(() => window.__clsPm.status());
ok(s.st === 'ready', 'C6 开局进入 READY', s.st);
ok(s.dotsLeft === 244, 'C7 开局 244 颗豆', s.dotsLeft);
ok(s.lives === 3, 'C8 三条命', s.lives);
ok(s.timeLimit > 60, 'C9 有倒计时（本站新增）', s.timeLimit);

await p.waitForTimeout(4100);
s = await p.evaluate(() => window.__clsPm.status());
ok(s.st === 'play', 'C10 READY 结束进入可玩', s.st);

/* C11 吃豆得分 */
await p.evaluate(() => window.__clsPm.teleport(1, 29));
await p.waitForTimeout(80);
const before = await p.evaluate(() => window.__clsPm.status());
await p.evaluate(() => window.__clsPm.setPacDir({ x: 1, y: 0 }));
await p.waitForTimeout(900);
const after = await p.evaluate(() => window.__clsPm.status());
ok(after.dotEaten > before.dotEaten, 'C11 走过能吃到豆', [before.dotEaten, after.dotEaten]);
ok(after.score >= before.score + 10 * (after.dotEaten - before.dotEaten), 'C12 每颗豆 +10 分', after.score);

/* C13 幽灵目标格：Pinky / Inky / Clyde */
{
  await p.evaluate(() => window.__clsPm.forceMode('chase', 1));
  await p.waitForTimeout(100);
  const chk = await p.evaluate(() => {
    const pac = window.__clsPm.pac();
    const gs = window.__clsPm.ghosts();
    const d = (pac.dir.x || pac.dir.y) ? pac.dir : { x: -1, y: 0 };
    const up = d.y === -1;
    const pinky = { x: pac.x + d.x * 4 - (up ? 4 : 0), y: pac.y + d.y * 4 };
    const ax = pac.x + d.x * 2 - (up ? 2 : 0), ay = pac.y + d.y * 2;
    const inky = { x: ax * 2 - gs[0].x, y: ay * 2 - gs[0].y };
    const dx = gs[3].x - pac.x, dy = gs[3].y - pac.y;
    const clyde = (dx * dx + dy * dy >= 64) ? { x: pac.x, y: pac.y } : { x: 0, y: 30 };
    return { pinky: [pinky, gs[1].target], inky: [inky, gs[2].target], clyde: [clyde, gs[3].target] };
  });
  const eq = (pair) => pair[0].x === pair[1].x && pair[0].y === pair[1].y;
  ok(eq(chk.pinky), 'C13 Pinky 目标是吃豆人前方 4 格', chk.pinky);
  ok(eq(chk.inky), 'C14 Inky 目标 = (前 2 格)×2 − Blinky', chk.inky);
  ok(eq(chk.clyde), 'C15 Clyde 8 格内回角落', chk.clyde);
}

/* C16 能量豆 → 全体变蓝 */
await p.evaluate(() => { window.__clsPm.teleport(1, 4); window.__clsPm.setPacDir({ x: 0, y: -1 }); });
await p.waitForTimeout(420);
{
  const s2 = await p.evaluate(() => window.__clsPm.status());
  const gs = await p.evaluate(() => window.__clsPm.ghosts());
  ok(s2.friT > 5 && s2.friT <= 6, 'C16 第 1 关吃能量豆变蓝约 6 秒', s2.friT && +s2.friT.toFixed(2));
  ok(gs.some((g) => g.state === 'fright'), 'C17 场上幽灵进入惊吓态', gs.map((g) => g.state));
}

/* C18 吃幽灵 → eyes */
await p.evaluate(() => {
  const gs = window.__clsPm.ghosts();
  const i = gs.findIndex((x) => x.state === 'fright');
  window.__clsPm.ghostAt(i, 6, 6);
  window.__clsPm.teleport(6, 6);
});
await p.waitForTimeout(220);
{
  const s2 = await p.evaluate(() => window.__clsPm.status());
  const gs = await p.evaluate(() => window.__clsPm.ghosts());
  ok(s2.chain === 1, 'C18 连吃计数从 1 开始', s2.chain);
  ok(gs.some((g) => g.state === 'eyes'), 'C19 被吃后变成眼睛', gs.map((g) => g.state));
}

/* C20 眼睛回巢并复出 */
await p.evaluate(() => window.__clsPm.teleport(1, 29));
let revived = false, sawHome = false;
for (let i = 0; i < 16; i++) {
  await p.waitForTimeout(400);
  const g = await p.evaluate(() => window.__clsPm.ghosts()[0]);
  if (g.state === 'home' || g.state === 'leave') sawHome = true;
  if (sawHome && g.state === 'run') { revived = true; break; }
}
ok(sawHome, 'C20 眼睛回到巢里（原版会复活）');
ok(revived, 'C21 复活后重新出来追');

/* C22 死亡 */
await p.evaluate(() => {
  window.__clsPm.teleport(6, 6);
  window.__clsPm.ghostAt(0, 6, 6);
  window.__clsPm.setGhostState(0, 'run');
});
await p.waitForTimeout(240);
{
  const s2 = await p.evaluate(() => window.__clsPm.status());
  ok(s2.st === 'dying', 'C22 撞到追捕者进入死亡动画', s2.st);
}
await p.waitForTimeout(1900);
{
  const s2 = await p.evaluate(() => window.__clsPm.status());
  const pc = await p.evaluate(() => window.__clsPm.pac());
  ok(s2.lives === 2, 'C23 掉一条命', s2.lives);
  ok(pc.x === 14 && pc.y === 23, 'C24 回到出生点', [pc.x, pc.y]);
}

/* C25 过关与星级 */
await p.waitForTimeout(1700);
await p.evaluate(() => {
  window.__clsPm.revive();
  window.__clsPm.setTime(window.__clsPm.status().timeLimit * 0.7);
  window.__clsPm.eatAllBut(1);
});
await p.waitForTimeout(80);
const last = await p.evaluate(() => {
  for (let y = 0; y < 31; y++) for (let x = 0; x < 28; x++) if (window.__clsPm.dotAt(x, y)) return { x, y };
  return null;
});
await p.evaluate(([x, y]) => { window.__clsPm.teleport(x, y); window.__clsPm.setPacDir({ x: 1, y: 0 }); }, [last.x, last.y]);
await p.waitForTimeout(1400);
{
  const s2 = await p.evaluate(() => window.__clsPm.status());
  ok(s2.st === 'clear' || s2.st === 'done', 'C25 吃完所有豆过关', s2.st);
}
await p.waitForTimeout(2200);
{
  const o = await p.evaluate(() => ({
    st: window.__clsPm.status().st,
    title: document.getElementById('overTitle').textContent,
    on: document.querySelectorAll('#overStars i.on').length,
    max: window.__clsPm.save.max
  }));
  ok(o.st === 'done', 'C26 弹出结算面板', o.st);
  ok(/CLEAR/.test(o.title), 'C27 标题为 STAGE N CLEAR', o.title);
  ok(o.on === 3, 'C28 剩余时间多给 3 星', o.on);
  ok(o.max === 2, 'C29 通关解锁下一关', o.max);
}

ok(errs.length === 0, 'C30 全程无 JS 报错', errs);

/* ---------- D. 布局 ---------- */
for (const [w, h] of [[390, 844], [360, 640], [320, 568]]) {
  const q = await b.newPage({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await q.goto(`${BASE}/games/pacman.html?selftest=1`, { waitUntil: 'domcontentloaded' });
  await q.waitForTimeout(700);
  const L = await q.evaluate(() => window.__clsPm.layout());
  const tag = `${w}×${h}`;
  ok(L.down[1] <= L.vh, `D1 ${tag} 「▼」在屏内`, { downB: L.down[1], vh: L.vh });
  ok(L.pause[1] <= L.vh, `D2 ${tag} 暂停键在屏内`, { pauseB: L.pause[1] });
  ok(L.stage[3] >= 240, `D3 ${tag} 迷宫没有被压得太小`, { w: L.stage[3] });
  await q.close();
}

/* ---------- E. 帧率 ---------- */
{
  const q = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await q.goto(`${BASE}/games/pacman.html?selftest=1`, { waitUntil: 'domcontentloaded' });
  await q.waitForTimeout(400);
  await q.evaluate(() => { window.__clsPm.mute(true); window.__clsPm.start(1); });
  await q.waitForTimeout(4200);
  const cdp = await q.context().newCDPSession(q);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const fps = await q.evaluate(() => new Promise((r) => {
    let n = 0; const t0 = performance.now();
    function f(t) { n++; if (t - t0 < 1500) requestAnimationFrame(f); else r(Math.round(n * 1000 / (t - t0))); }
    requestAnimationFrame(f);
  }));
  ok(fps >= 50, 'E1 CPU 降速 4 倍仍有 50fps 以上', fps);
  await q.close();
}

await b.close();

console.log(out.join('\n'));
console.log('\n' + '='.repeat(52));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
