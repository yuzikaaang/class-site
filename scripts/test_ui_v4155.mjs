/* v4.15.5 专项：大屏作业看板的中文输入
 * ------------------------------------------------------------
 * 站主反馈：班级大屏用软键盘打中文，拼音和候选字都不出来，英文正常，
 * 同一台机器换别的网站可以正常打中文。
 * 根因：作业卡片整块 innerHTML 重建，输入框节点被替换；IME 的组合状态
 * 绑在节点上，节点一换组合就作废。英文逐字符写入 value，不受影响。
 * 本脚本用 CDP 的 imeSetComposition 复现「拼音打到一半被重绘打断」。
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
const big = read('big.js');

/* ---------- A. 静态 ---------- */
{
  ok(/compositionstart/.test(big) && /compositionend/.test(big), 'A1 作业区监听输入法组合事件');
  const rh = big.slice(big.indexOf('BIG.renderHw = function'), big.indexOf('function renderHwRaw'));
  ok(/_imeOn \|\| _imeT/.test(rh) && /_imePending/.test(rh), 'A2 组合中重绘改为排队');
  const dirty = big.slice(big.indexOf('function hwDirty'), big.indexOf('function hwBusy'));
  ok(/if\(_imeOn\) return true/.test(dirty), 'A3 组合中判定为正在编辑');
  const grow = big.slice(big.indexOf('BIG.autoGrow = function'), big.indexOf('function growAll'));
  ok(/if\(_imeOn\) return/.test(grow), 'A4 组合中不调整文本框高度');
}

const browser = await chromium.launch({ executablePath: CH, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${BASE}/index.html?big=1`, { waitUntil: 'load' });
await page.waitForTimeout(2600);
await page.evaluate(() => { window.isAdmin = () => true; window.BIG.openHw('hw-2026-guocing'); });
await page.waitForTimeout(1200);
await page.evaluate(() => { localStorage.setItem('cls_hw_edit', '1'); window.BIG.renderHw(); });
await page.waitForTimeout(600);
await page.evaluate(() => {
  const m = document.getElementById('loginGuideMask');
  if (m) { m.classList.remove('show'); m.style.display = 'none'; }
});
await page.waitForTimeout(200);

const n = await page.evaluate(() => document.querySelectorAll('#bigHw textarea').length);
ok(n > 5, 'B1 编辑态渲染出作业输入框', n);

await page.evaluate(() => {
  window.__ime = { start: 0, end: 0, mut: 0 };
  const host = document.getElementById('bigHw');
  host.addEventListener('compositionstart', () => window.__ime.start++, true);
  host.addEventListener('compositionend', () => window.__ime.end++, true);
  new MutationObserver((ms) => { window.__ime.mut += ms.length; }).observe(host, { childList: true, subtree: true });
});

const ta = page.locator('#bigHw textarea').first();
await ta.click();
const cdp = await ctx.newCDPSession(page);

/* ---------- C. 组合中被重绘 / 重排 / 刷内容 ---------- */
await cdp.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 });
await page.waitForTimeout(220);
await page.evaluate(() => { window.__ime.mut = 0; window.BIG.renderHw(); window.BIG.relayout(); try { window.rerenderAll && window.rerenderAll(); } catch (e) {} });
await page.waitForTimeout(350);
const during = await page.evaluate(() => ({ mut: window.__ime.mut, busy: window.BIG.imeBusy(), start: window.__ime.start }));
ok(during.start === 1, 'C1 组合已开始');
ok(during.mut === 0, 'C2 组合中三次刷新都没有动过输入框节点', during.mut);
ok(during.busy === true, 'C3 imeBusy() 报告正在组合');

/* ---------- D. 上屏 ---------- */
await cdp.send('Input.insertText', { text: '中文' });
await page.waitForTimeout(600);
const val1 = await ta.inputValue();
ok(val1.includes('中文'), 'D1 上屏文字进入输入框', val1.slice(0, 26));
ok(await page.evaluate(() => document.activeElement && document.activeElement.tagName === 'TEXTAREA'), 'D2 上屏后焦点仍在输入框');
const after = await page.evaluate(() => ({ end: window.__ime.end, busy: window.BIG.imeBusy() }));
ok(after.end === 1 && after.busy === false, 'D3 组合结束后恢复空闲', after);

/* ---------- E. 连续多段中文 ---------- */
await cdp.send('Input.imeSetComposition', { text: 'zuoye', selectionStart: 5, selectionEnd: 5 });
await page.waitForTimeout(180);
await cdp.send('Input.insertText', { text: '作业' });
await page.waitForTimeout(450);
const val2 = await ta.inputValue();
ok(val2.includes('中文作业'), 'E1 可连续输入第二段中文', val2.slice(0, 30));

/* ---------- F. 英文照常 ---------- */
await page.keyboard.type('ABCD');
await page.waitForTimeout(250);
const val3 = await ta.inputValue();
ok(val3.includes('ABCD'), 'F1 英文输入不受影响', val3.slice(-14));

/* ---------- G. 值进入数据 ---------- */
await page.keyboard.press('Tab');
await page.waitForTimeout(500);
const saved = await page.evaluate(() => {
  const arr = window.SITE_DATA && window.SITE_DATA.holidayHomeworks || [];
  const hw = arr.find((x) => x && x.id === 'hw-2026-guocing');
  if (!hw) return null;
  const flat = JSON.stringify(hw);
  return flat.indexOf('中文作业') >= 0;
});
ok(saved === true, 'G1 失焦后中文写回作业数据');

ok(errs.length === 0, 'H1 全程无 JS 报错', errs);

await page.screenshot({ path: '/workspace/classsite-v4155/big-hw-ime.png' });
await browser.close();

console.log(out.join('\n'));
console.log('\n' + '='.repeat(52));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
