/* 验证 v3.9.4：前端横幅按换行原样展示 */
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();

await page.route('**/api/**', async (route) => {
  const url = route.request().url();
  if (url.includes('/api/island')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {
      on: true, term: '2026 年秋季 · 高二上', startDate: '2026-09-01',
      components: ['time', 'weather', 'week', 'term'],
      banner: { mon: 1, tue: 2, wed: 3, thu: "升 数数语英化 物物体劳 听自语语自\n数学 08:00-09:30\n语文 10:00-11:30", fri: '英', sat: '自', sun: '读' },
      days: {}, holidays: [],
    } }) });
  }
  if (url.includes('/api/content')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"items":{},"serverTime":"2026-10-21T00:00:00Z"}' });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
});

await page.goto('http://localhost:8111/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const r = await page.evaluate(() => {
  const el = document.querySelector('#classIsland .island-banner .txt');
  if (!el) return { ok: false };
  const cs = getComputedStyle(el);
  return {
    ok: true,
    text: el.textContent,
    whiteSpace: cs.whiteSpace,
    lineClamp: cs.webkitLineClamp,
    lines: Math.round(el.getBoundingClientRect().height / parseFloat(cs.lineHeight)),
    islandVisible: document.getElementById('classIsland').style.display !== 'none',
  };
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
