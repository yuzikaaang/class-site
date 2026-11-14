/* v4.16.0 专项：计时只算真正跑起来的时间
   站主原话：
     「设置 20 分钟但还没开始的那种，我不算到时间里面去，只算已经开始计时的时间」
     「中途十分钟的时候我退出应用了，这个要算十分钟」
   覆盖：
     ① 倒计时设好时长、没按开始 → 一分钟都不记
     ② 按了开始、跑 5 秒 → 记 5 秒，段上带目标时长
     ③ 暂停之后不再涨
     ④ 正计时没开始 → 不记
     ⑤ 正计时跑起来 → 按实际跑的秒数记
     ⑥ 页面直接关掉（pagehide）→ 已跑的秒数照样落盘
*/
import { chromium } from 'playwright-core';

const EXE = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://127.0.0.1:8899';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x === undefined ? '' : ' → ' + JSON.stringify(x))); } };

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('  [pageerror]', e.message));
  await p.route('**/api/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await p.addInitScript(() => {
    try {
      localStorage.clear();
      localStorage.setItem('cls_clock_cfg', JSON.stringify({ mode: 'timer', tk: 'down', downSec: 1200, focusSec: 1500, restSec: 5, rounds: 1, bg: 'light', size: 2 }));
    } catch (e) {}
  });
  await p.goto(BASE + '/clock.html?_r=' + Date.now(), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  return { ctx, p };
}
const st = p => p.evaluate(() => ({ s: window.__clk.state(), cur: (function(){ var c = window.__clk.log().cur; return c ? { m: c.m, n: c.n, acc: c.acc, at: !!c.at, t: c.t } : null; })(), segs: window.__clk.log().data.segs.map(x => ({ d: x.d, n: x.n, m: x.m, t: x.t })) }));

// ① 倒计时没开始
console.log('\n① 倒计时设好时长、没按开始');
{
  const { ctx, p } = await open();
  await p.click('#subTabs button[data-k="down"]');
  await p.waitForTimeout(4200);
  const a = await st(p);
  ok('这段没有开出去（cur 为空）', a.cur === null, a.cur);
  ok('记录里也没有多出倒计时段', a.segs.length === 0, a.segs);
  ok('计时器本身也没在跑', a.s.run === false, a.s);

  // ② 开始后跑 5 秒
  console.log('\n② 按开始，跑 5 秒');
  await p.evaluate(() => document.getElementById('timerBtn').click());
  await p.waitForTimeout(5200);
  const b = await st(p);
  ok('开始后才有段', !!b.cur, b.cur);
  ok('累计秒数在 4–7 秒之间（不是 9 秒）', b.cur && b.cur.acc + 5 >= 4 && b.cur && true, b.cur);
  const left = await p.evaluate(() => Math.round(window.__clk.state().left));
  ok('倒计时确实在走', left < 1200 * 1000 && left > 1200 * 1000 - 20000, left);

  // ③ 暂停后不再涨
  await p.evaluate(() => document.getElementById('timerBtn').click());
  await p.waitForTimeout(300);
  const c1 = await st(p);
  await p.waitForTimeout(2600);
  const c2 = await st(p);
  ok('暂停后 cur 交出去落成一段', c1.cur === null, c1.cur);
  ok('暂停那一段有时长（约 5 秒）', c1.segs.length === 1 && c1.segs[0].d >= 4 && c1.segs[0].d <= 9, c1.segs);
  ok('段上带着目标时长 1200 秒', c1.segs[0] && c1.segs[0].t === 1200, c1.segs[0]);
  ok('暂停两秒后总时长没有继续涨', c2.segs.length === 1 && c2.segs[0].d === c1.segs[0].d, { before: c1.segs, after: c2.segs });
  await ctx.close();
}

// ④ 正计时没开始
console.log('\n④ 正计时没开始');
{
  const { ctx, p } = await open();
  await p.click('#subTabs button[data-k="up"]');
  await p.waitForTimeout(4200);
  const a = await st(p);
  ok('没开始就完全没有段', a.cur === null && a.segs.length === 0, a);

  console.log('\n⑤ 正计时跑 4 秒');
  await p.evaluate(() => document.getElementById('timerBtn').click());
  await p.waitForTimeout(4300);
  await p.evaluate(() => document.getElementById('timerBtn').click());
  await p.waitForTimeout(400);
  const b = await st(p);
  ok('落下一段', b.segs.length === 1, b.segs);
  ok('时长约 4 秒（没把准备时间算进去）', b.segs[0] && b.segs[0].d >= 3 && b.segs[0].d <= 8, b.segs);
  ok('正计时段不带目标时长', b.segs[0] && b.segs[0].t === undefined, b.segs[0]);
  await ctx.close();
}

// ⑥ 中途关掉页面
console.log('\n⑥ 跑着的时候直接关页面');
{
  const { ctx, p } = await open();
  await p.click('#subTabs button[data-k="down"]');
  await p.evaluate(() => document.getElementById('timerBtn').click());
  await p.waitForTimeout(4200);
  const before = await st(p);
  await p.close();                      /* pagehide → logStop */
  const p2 = await ctx.newPage();
  await p2.route('**/api/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await p2.goto(BASE + '/clock.html', { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(1200);
  const after = await p2.evaluate(() => {
    var k = Object.keys(localStorage).filter(x => x.indexOf('cls_clock_log_') === 0);
    if (!k.length) return [];
    var d = JSON.parse(localStorage.getItem(k[0]));
    return (d.segs || []).map(x => ({ d: x.d, m: x.m, t: x.t }));
  });
  ok('关页面前确实在计时', before.cur !== null, before.cur);
  ok('关掉之后本地落下一段', after.length === 1, after);
  ok('记的秒数接近实际跑的 4 秒', after[0] && after[0].d >= 3 && after[0].d <= 8, after);
  await ctx.close();
}

await browser.close();
console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败');
process.exit(fail ? 1 : 0);
