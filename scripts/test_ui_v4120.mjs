/* v4.12.0 专项（历史保留）
   ⚠️ v4.13.0 起：顶部书签按钮已移除、教程改 11 章图文版、导览扩到八个场景，
   本文件的入口与章节断言已不适用，现行断言见 test_ui_v4130.mjs。
   这里只保留一条：进站问答层确实已被删除（防止回退）。 */
import { chromium } from 'playwright-core';

const SITE = (process.env.CLS_SITE || 'http://localhost:8899').replace(/\/$/, '') + '/index.html';
const CH = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const browser = await chromium.launch({ executablePath: CH, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 412, height: 900 } });
const page = await ctx.newPage();
await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
await page.addInitScript(() => {
  try { localStorage.setItem('cls_login_guide_v1', '1'); localStorage.setItem('cls_tour_v1', '{"home":{"done":1},"login":{"done":1}}'); } catch (e) {}
});
await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1600);
const s = await page.evaluate(() => ({
  dom: !!document.getElementById('siteGate'),
  fn: typeof window.submitSiteGate,
  key: localStorage.getItem('cls_site_gate'),
}));
const ok = !s.dom && s.fn === 'undefined' && s.key === null;
console.log((ok ? '✅' : '❌') + ' 4.12.0 遗留项：进站问答层已删除'
  + (ok ? '' : '  ' + JSON.stringify(s)));
await browser.close();
process.exit(ok ? 0 : 1);
