/* v4.15.2 专项：吃豆人「方向键出屏」真因回归
 * ------------------------------------------------------------
 * 上一版是拿 calc(100dvh - 276px) 估，后来又改成量 offsetHeight 算 —— 两次都
 * 通过，因为 playwright 没有地址栏，innerHeight 和 dvh 恒等。真机上安卓 Edge
 * 的 100dvh 是「地址栏收起后」的高度，比可视区高 40~60px，body 被撑大后
 * #stage 的 auto margin 把多出来的空间分到上下，▼ 就被顶出屏幕。
 *
 * 这一版改成：body 高度 = min(visualViewport, innerHeight, clientHeight)，
 * 写成 --app-h 钉住；再量 ▼ 的底边做反馈校正。本脚本就是守这两条。
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
  if (cond) { pass++; out.push(`  ✓ ${name}${extra ? '  ' + JSON.stringify(extra) : ''}`); }
  else { fail++; out.push(`  ✗ ${name}${extra ? '  ' + JSON.stringify(extra) : ''}`); }
}
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const b = await chromium.launch({ executablePath: CH, args: ['--no-sandbox'] });

/* A. 静态：body 不再用视口单位撑高 */
{
  const pm = read('games/pacman.html');
  const bodyRule = pm.slice(pm.indexOf('body{'), pm.indexOf('.bar{'));
  ok(!/height\s*:\s*100(d)?vh/.test(bodyRule), 'A1 body 高度不再写 100vh/100dvh', bodyRule.match(/height:[^;]+;/g));
  ok(/--app-h/.test(bodyRule), 'A2 body 高度改读 --app-h');
  ok(/function viewH\(/.test(pm), 'A3 有 viewH() 量视口');
  ok(/Math\.min\.apply\(null/.test(pm), 'A4 三个高度来源取最小值（最保守）');
  ok(/getBoundingClientRect\(\)\.bottom - \(vh - padB\)/.test(pm), 'A5 有「量 ▼ 底边」的反馈校正');
  ok(/visualViewport[\s\S]{0,200}addEventListener\('resize'/.test(pm), 'A6 监听 visualViewport 尺寸变化');
}

/* B. 多尺寸实跑：body 高度 = 视口，▼ 不出屏 */
const SIZES = [[390, 844], [412, 915], [393, 851], [360, 640], [320, 568], [390, 700]];
for (const [w, h] of SIZES) {
  const p = await b.newPage({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(`${BASE}/games/pacman.html?selftest=1`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(800);
  const L = await p.evaluate(() => window.__clsPm.layout());
  const tag = `${w}×${h}`;

  ok(Math.abs(L.body[2] - L.vh) <= 1, `B ${tag} body 高度跟着实测视口`, { body: L.body[2], vh: L.vh });
  ok(L.down && L.down[1] <= L.vh, `B ${tag} 「▼」底边在屏内`, { downB: L.down && L.down[1], vh: L.vh });
  ok(L.dpad && L.dpad[2] > 0, `B ${tag} 方向键有实际高度`, { dpadH: L.dpad && L.dpad[2] });
  ok(L.stage[2] >= 240, `B ${tag} 迷宫没有被压扁`, { stage: L.stage[2] });
  ok(errs.length === 0, `B ${tag} 无 JS 报错`, errs);
  await p.close();
}

/* C. 地址栏收放：视口高度来回变，每次都要重新贴合 */
{
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await p.goto(`${BASE}/games/pacman.html?selftest=1`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(700);
  for (const h of [700, 640, 844]) {
    await p.setViewportSize({ width: 390, height: h });
    await p.waitForTimeout(400);
    const L = await p.evaluate(() => window.__clsPm.layout());
    ok(L.down[1] <= L.vh && Math.abs(L.body[2] - L.vh) <= 1, `C 视口切到 ${h} 后仍贴合`, { vh: L.vh, downB: L.down[1] });
  }
  await p.close();
}

/* D. 真机上「dvh 偏大」的等价场景：把 innerHeight 报大 60px */
{
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await p.addInitScript(() => {
    /* 模拟安卓 Edge：innerHeight / clientHeight 仍是「地址栏收起后」的大视口，
       只有 visualViewport 是真实可视区。旧代码信了假高度，新代码取最小值。 */
    Object.defineProperty(window, 'innerHeight', { get: () => 904, configurable: true });
    Object.defineProperty(Document.prototype, 'clientHeight', {
      get() { return this === document.documentElement ? 904 : 0; }, configurable: true
    });
  });
  await p.goto(`${BASE}/games/pacman.html?selftest=1`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(800);
  const L = await p.evaluate(() => window.__clsPm.layout());
  ok(L.vh === 844, 'D1 假的大视口被识破，取到真实可见高度', { vh: L.vh, inner: L.inner, client: L.client });
  ok(Math.abs(L.body[2] - 844) <= 1, 'D2 body 按真实高度撑，不用假的 904', { body: L.body[2] });
  ok(L.down[1] <= 844, 'D3 「▼」没有被顶出屏幕', { downB: L.down[1] });
  await p.close();
}

await b.close();

console.log(out.join('\n'));
console.log('\n' + '='.repeat(52));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
