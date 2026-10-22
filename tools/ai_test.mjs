/* 验证 v3.9.4：后台横幅 textarea 渲染 / 自适应高度 / 换行保存 */
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

let lastPost = null;
await page.route('**/api/**', async (route) => {
  const req = route.request();
  const url = req.url();
  if (req.method() === 'POST' && url.includes('/api/island')) {
    lastPost = req.postDataJSON();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: lastPost.data }) });
  }
  if (url.includes('/api/island')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {
      on: true, term: '2026 年秋季 · 高二上', startDate: '2026-09-01',
      components: ['time', 'weather', 'week', 'term'],
      banner: { mon: '升 数数语英化 物物体劳 听自语语自', tue: '英 英备备备语 化生物数 练自化化自', wed: '语 语数物英英 音生化班 听自英英自', thu: '生 微语生生英 物健自自 练自数数自', fri: '英 数语语化化 体生英物 听自生生自', sat: '自自 自自 读自自', sun: '读自 物理 物自' },
      days: {}, holidays: [],
    } }) });
  }
  if (url.includes('/api/auth?action=me')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, user: { id: 4, username: 'aibot', displayName: 'AI 助手', role: 'admin' } }) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
});

await page.goto('http://localhost:8111/admin.html', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  localStorage.setItem('cls_auth', JSON.stringify({ token: 'x', user: { id: 4, username: 'aibot', displayName: 'AI 助手', role: 'admin', status: 'active', title: '' } }));
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// 打开班级岛面板
await page.evaluate(() => {
  const els = [...document.querySelectorAll('a,button,li,div,span')];
  const el = els.find((e) => /班级岛/.test(e.textContent) && e.textContent.trim().length < 20);
  if (el) el.click();
});
await page.waitForTimeout(1200);

const ta = await page.evaluate(() => {
  const t = document.querySelector('#aiBanner textarea[data-bk="mon"]');
  if (!t) return { ok: false };
  return { ok: true, tag: t.tagName, rows: t.getAttribute('rows'), max: t.getAttribute('maxlength'), h: t.style.height };
});
console.log('textarea:', JSON.stringify(ta));

// 输入多行文本，看高度是否自适应
await page.evaluate(() => {
  const t = document.querySelector('#aiBanner textarea[data-bk="mon"]');
  t.value = '升 数数语英化 物物体劳 听自语语自\n数学 08:00-09:30\n语文 10:00-11:30';
  t.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(300);
const grown = await page.evaluate(() => {
  const t = document.querySelector('#aiBanner textarea[data-bk="mon"]');
  return { h: t.style.height, lines: t.value.split('\n').length };
});
console.log('多行输入后:', JSON.stringify(grown));

// 保存，看 payload 里的换行是否完整
await page.evaluate(() => document.getElementById('aiSave').click());
await page.waitForTimeout(1500);
console.log('POST payload banner.mon =', JSON.stringify(lastPost && lastPost.data && lastPost.data.banner && lastPost.data.banner.mon));
console.log('POST payload days =', JSON.stringify(lastPost && lastPost.data && lastPost.data.days));
await browser.close();
