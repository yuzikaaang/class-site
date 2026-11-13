/* v4.15.4 专项：幽灵出巢与寻路小修
 * ------------------------------------------------------------
 * 用户反馈：豆子快吃完了，还有两只幽灵蹲在出生点不出来。
 * 根因有两条，本脚本各守一条：
 *   1) 巢门对普通状态的幽灵也开放 —— 被逼到巢口时会钻进屋里，
 *      屋里的贪心寻路绕不回出口，看起来就是「不出来」。
 *   2) 出巢只靠「吃够豆数」这一个门槛，而 houseTimer 会被每次吃豆清零，
 *      原版那个「等够时间也放行」的保底实际上永远走不到。
 * 现在：门只对 leave / eyes 开放；出巢有三道保险（豆数 / 计时 / 豆子剩太少）。
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

/* ---------- A. 静态：两处根因确实被改掉 ---------- */
{
  ok(/function doorBlocked\(/.test(pm), 'A1 存在巢门拦截 doorBlocked');
  const choose = pm.slice(pm.indexOf('function ghostChoose'), pm.indexOf('function inTunnel'));
  ok(/doorBlocked\(g, d\)/.test(choose), 'A2 路口决策里调用了 doorBlocked');

  const eat = pm.slice(pm.indexOf('function eatAt'), pm.indexOf('function eatPellet'));
  ok(!/houseTimer\s*=\s*0/.test(eat), 'A3 吃豆不再清零出巢计时');

  const rel = pm.slice(pm.indexOf('function releaseCheck'), pm.indexOf('function stepMode'));
  ok(/g\.homeT/.test(rel), 'A4 每只幽灵有独立的在巢计时');
  ok(/force/.test(rel) && /dotsLeft/.test(rel), 'A5 豆子剩太少时无条件放行');
  ok(/houseTimer\s*>=\s*0\.45/.test(rel), 'A6 放行有 0.45 秒间隔，避免叠在门口');

  ok(/g\.leaveT\s*>\s*6/.test(pm), 'A7 出巢超时有兜底，直接摆到巢口');
  ok(/g\.state === 'run' \|\| g\.state === 'fright'/.test(pm), 'A8 普通状态出现在屋里有自救');

  /* 地图与豆数不能被这轮改坏 */
  const i = pm.indexOf('var MAP = ['), j = pm.indexOf('];', i);
  const rows = [...pm.slice(i, j).matchAll(/'([^']*)'/g)].map((m) => m[1]);
  ok(rows.length === 31 && rows.every((r) => r.length === 28), 'A9 迷宫仍是 31×28');
  const flat = rows.join('');
  ok(flat.split('.').length - 1 === 240 && flat.split('o').length - 1 === 4, 'A10 仍是 240 豆 + 4 能量豆');
}

const browser = await chromium.launch({ executablePath: CH, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${BASE}/games/pacman.html?selftest=1`, { waitUntil: 'load' });
await page.evaluate(() => window.__clsPm.mute(true));

const SAFE = [[1, 29], [26, 29], [1, 1], [26, 1], [14, 23], [6, 8], [21, 8]];
const inHouse = (g) => g.y >= 13 && g.y <= 15 && g.x >= 11 && g.x <= 16;

/* ---------- B. 出巢保底：不吃豆也要全部出来 ---------- */
for (const lv of [1, 2, 6]) {
  await page.evaluate((l) => window.__clsPm.start(l), lv);
  await page.waitForTimeout(2300);
  const t0 = Date.now();
  let worst = 4, worstT = 0;
  while (Date.now() - t0 < 12000) {
    await page.evaluate((safe) => {
      const gs = window.__clsPm.ghosts();
      let best = safe[0], bestD = -1;
      for (const p of safe) {
        let d = 999;
        for (const g of gs) d = Math.min(d, Math.abs(g.x - p[0]) + Math.abs(g.y - p[1]));
        if (d > bestD) { bestD = d; best = p; }
      }
      window.__clsPm.teleport(best[0], best[1]);
      window.__clsPm.revive();
    }, SAFE);
    await page.waitForTimeout(200);
    const gs = await page.evaluate(() => window.__clsPm.ghosts());
    const stuck = gs.filter((g) => g.state === 'home' || inHouse(g)).length;
    if (stuck < worst || worst === 4) { worst = stuck; worstT = (Date.now() - t0) / 1000; }
  }
  const gs = await page.evaluate(() => window.__clsPm.ghosts());
  const outNow = gs.filter((g) => !inHouse(g) && g.state !== 'home' && g.state !== 'leave').length;
  ok(worst === 0, `B LV${lv} 12 秒内四只全部离开出生点（最少滞留 ${worst} 只）`, Math.round(worstT * 10) / 10);
  ok(outNow >= 3, `B LV${lv} 结束时至少 3 只在场上活动`, outNow);
}

/* ---------- C. 门禁：普通状态不能穿巢门进屋 ---------- */
await page.evaluate(() => window.__clsPm.start(4));
await page.waitForTimeout(2300);
await page.evaluate(() => {
  window.__clsPm.ghostAt(1, 14, 11); window.__clsPm.setGhostState(1, 'run');
  window.__clsPm.ghostAt(2, 15, 11); window.__clsPm.setGhostState(2, 'run');
  window.__clsPm.forceMode('chase', 1);
});
let bad = 0, seen = [];
for (let k = 0; k < 60; k++) {
  await page.waitForTimeout(120);
  const gs = await page.evaluate(() => window.__clsPm.ghosts());
  for (const g of gs) {
    if (g.id !== 1 && g.id !== 2) continue;
    if ((g.state === 'run' || g.state === 'fright') && inHouse(g)) {
      bad++; seen.push(`${g.id}@${g.x},${g.y}`);
    }
  }
}
ok(bad === 0, 'C1 跑动中的幽灵 7 秒内没有一次钻进屋里', seen.slice(0, 5));

/* ---------- D. 屋内自救：硬塞进屋里也能自己走出来 ---------- */
await page.evaluate(() => {
  window.__clsPm.start(3);
  window.__clsPm.ghostAt(2, 12, 14);
  window.__clsPm.setGhostState(2, 'run');
});
let rescued = false;
for (let k = 0; k < 40; k++) {
  await page.waitForTimeout(150);
  const g = await page.evaluate(() => window.__clsPm.ghosts()[2]);
  if (!inHouse(g) && g.state !== 'home') { rescued = true; break; }
}
ok(rescued, 'D1 被塞进屋里的幽灵 6 秒内自己回到迷宫');

/* ---------- E. 惊吓态不会把幽灵吓进屋里 ---------- */
await page.evaluate(() => {
  window.__clsPm.start(5);
  window.__clsPm.ghostAt(3, 14, 11);
  window.__clsPm.setGhostState(3, 'fright');
});
let bad2 = 0;
for (let k = 0; k < 40; k++) {
  await page.waitForTimeout(120);
  const g = await page.evaluate(() => window.__clsPm.ghosts()[3]);
  if (inHouse(g)) bad2++;
}
ok(bad2 === 0, 'E1 变蓝后随机走也不会退回出生点', bad2);

ok(errs.length === 0, 'F1 全程无 JS 报错', errs);

await page.screenshot({ path: '/workspace/classsite-v4154/pacman.png' }).catch(() => {});
await browser.close();

console.log(out.join('\n'));
console.log('\n' + '='.repeat(52));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
