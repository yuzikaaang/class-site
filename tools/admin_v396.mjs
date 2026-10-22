/* v3.9.6 后台验证：单行横幅 / 多行临时改 / 填入课表 / 编辑 / 复用 / 照片 */
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 200)); });

let lastPost = null;
await page.route('**/api/**', async (route) => {
  const req = route.request();
  const url = req.url();
  if (req.method() === 'POST' && url.includes('/api/island')) {
    lastPost = req.postDataJSON();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: lastPost.data }) });
  }
  if (url.includes('/api/auth?action=me')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, user: { id: 4, username: 'aibot', displayName: 'AI 助手', role: 'admin', status: 'active', title: '' } }) });
  }
  if (url.includes('/api/island')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {
      on: true, term: '2026 年秋季 · 高二上', startDate: '2026-09-01',
      components: ['time', 'weather', 'week', 'term'],
      banner: { mon: '升 数数语英化 物物体劳 听自语语自', tue: '英 英备备备语 化生物数 练自化化自', wed: '语 语数物英英 音生化班 听自英英自', thu: '生 微语生生英 物健自自 练自数数自', fri: '英 数语语化化 体生英物 听自生生自', sat: '自自 自自 读自自', sun: '读自 物理 物自' },
      days: { '2026-10-23': { text: '数学 08:00-09:30', off: false, label: '' } },
      holidays: [{ id: 'h1', from: '2026-10-01', to: '2026-10-07', label: '国庆' }],
      photo: './badge.png',
    } }) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
});

await page.goto('http://localhost:8111/admin.html', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  localStorage.setItem('cls_auth', JSON.stringify({ token: 'x', user: { id: 4, username: 'aibot', displayName: 'AI 助手', role: 'admin', status: 'active', title: '' } }));
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1600);
await page.evaluate(() => {
  const els = [...document.querySelectorAll('a,button,li,div,span')];
  const el = els.find((e) => /班级岛/.test(e.textContent) && e.textContent.trim().length < 20);
  if (el) el.click();
});
await page.waitForTimeout(1500);

const errs = await page.evaluate(() => document.body.innerText.slice(0, 300));
console.log('page text:', JSON.stringify(errs));
const dump = await page.evaluate(() => ({
  view: (document.getElementById('view') || {}).innerHTML ? 'has' : 'empty',
  head: document.body.innerText.slice(0, 120).replace(/\n/g, ' | '),
}));
console.log('dump:', JSON.stringify(dump));
const ui = await page.evaluate(() => ({
  hasPanel: !!document.getElementById('aiBanner'),
  bannerTag: (document.querySelector('#aiBanner [data-bk="mon"]') || {}).tagName,
  adTextTag: (document.getElementById('adText') || {}).tagName,
  adTextRows: document.getElementById('adText').rows,
  hasFill: !!document.getElementById('adFill'),
  photoVal: (document.getElementById('aiPhoto') || {}).value,
  dayItems: document.querySelectorAll('#aiDayList [data-dayedit]').length,
  holItems: document.querySelectorAll('#aiHolList [data-holedit]').length,
  holCopy: document.querySelectorAll('#aiHolList [data-hcopy]').length,
}));
console.log('UI:', JSON.stringify(ui));

// 1) 选 10-24（周六）点「填入当天课表」
await page.evaluate(() => {
  document.getElementById('adDate').value = '2026-10-24';
  document.getElementById('adFill').click();
});
await page.waitForTimeout(400);
const filled = await page.evaluate(() => document.getElementById('adText').value);
console.log('填入课表(周六):', JSON.stringify(filled));

// 2) 改一个字 → 添加
await page.evaluate(() => {
  document.getElementById('adText').value = '自自 自自 读自自\n语文学考';
  document.getElementById('adAdd').click();
});
await page.waitForTimeout(500);
console.log('添加后条目数:', await page.evaluate(() => document.querySelectorAll('#aiDayList [data-dayedit]').length));

// 3) 点已有条目 → 编辑
await page.evaluate(() => {
  document.querySelector('#aiDayList [data-dayedit="2026-10-23"]').click();
});
await page.waitForTimeout(400);
const editState = await page.evaluate(() => ({
  date: document.getElementById('adDate').value,
  text: document.getElementById('adText').value,
  btn: document.getElementById('adAdd').textContent,
}));
console.log('编辑态:', JSON.stringify(editState));

// 4) 假期：点条目编辑
await page.evaluate(() => document.querySelector('#aiHolList [data-holedit]').click());
await page.waitForTimeout(400);
const holEdit = await page.evaluate(() => ({
  label: document.getElementById('ahLabel').value,
  from: document.getElementById('ahFrom').value,
  to: document.getElementById('ahTo').value,
  btn: document.getElementById('ahAdd').textContent,
}));
console.log('假期编辑态:', JSON.stringify(holEdit));

// 5) 复用
await page.evaluate(() => document.querySelector('#aiHolList [data-hcopy]').click());
await page.waitForTimeout(400);
const holCopy = await page.evaluate(() => ({
  label: document.getElementById('ahLabel').value,
  from: document.getElementById('ahFrom').value,
  btn: document.getElementById('ahAdd').textContent,
}));
console.log('假期复用:', JSON.stringify(holCopy));

// 6) 保存，看 payload
await page.evaluate(() => document.getElementById('aiSave').click());
await page.waitForTimeout(1200);
console.log('payload.photo:', lastPost && lastPost.data.photo);
console.log('payload.days keys:', lastPost && Object.keys(lastPost.data.days));
console.log('payload.days[2026-10-24]:', JSON.stringify(lastPost && lastPost.data.days['2026-10-24']));
await page.screenshot({ path: '/tmp/admin_isl_396.png', fullPage: false });
await browser.close();
