/* v3.9.7 后台：实时保存 / 加粗居中 / 照片靠前 */
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 950 } })).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

let posts = [];
await page.route('**/api/**', async (route) => {
  const req = route.request();
  const url = req.url();
  if (url.includes('/api/auth?action=me')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, user: { id: 4, username: 'aibot', displayName: 'AI 助手', role: 'admin', status: 'active', title: '' } }) });
  }
  if (req.method() === 'POST' && url.includes('/api/island')) {
    const j = req.postDataJSON();
    posts.push(j.data);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: j.data }) });
  }
  if (url.includes('/api/island')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {
      on: true, term: '2026 年秋季 · 高二上', startDate: '2026-09-01',
      components: ['time', 'weather', 'week', 'term'],
      banner: { mon: '升 数数语英化 物物体劳 听自语语自', tue: '英 英备备备语 化生物数 练自化化自', wed: '语 语数物英英 音生化班 听自英英自', thu: '生 微语生生英 物健自自 练自数数自', fri: '英 数语语化化 体生英物 听自生生自', sat: '自自 自自 读自自', sun: '读自 物理 物自' },
      days: {}, holidays: [], photo: '',
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

console.log('结构:', JSON.stringify(await page.evaluate(() => ({
  stage: (document.getElementById('aiStage') || {}).textContent,
  saveBtn: !!document.getElementById('aiSave'),
  photoIdx: [...document.querySelectorAll('#view .panel h3')].map((h) => h.textContent).indexOf('今日事项照片'),
  bold: !!document.getElementById('adBold'),
  centerChecked: document.getElementById('adCenter').checked,
}))));

// 1) 改横幅 → 自动保存
await page.evaluate(() => {
  const el = document.querySelector('#aiBanner [data-bk="mon"]');
  el.value = '升 数数语英化 物物体劳 听自语语自（改）';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(1400);
console.log('自动保存横幅:', posts.length, posts.length ? posts[posts.length - 1].banner.mon : '');

// 2) 加粗预览
await page.evaluate(() => {
  document.getElementById('adDate').value = '2026-10-23';
  document.getElementById('adFill').click();
  document.getElementById('adText').value = '数学 08:00-09:30\n语文 10:00-11:30';
  document.getElementById('adBold').checked = true;
  document.getElementById('adBold').dispatchEvent(new Event('change'));
});
await page.waitForTimeout(300);
console.log('预览样式:', JSON.stringify(await page.evaluate(() => {
  const t = document.getElementById('adText');
  return { weight: t.style.fontWeight, align: t.style.textAlign };
})));

// 3) 添加 → 自动保存 + 列表标记
await page.evaluate(() => document.getElementById('adAdd').click());
await page.waitForTimeout(1500);
console.log('保存 days:', JSON.stringify(posts[posts.length - 1].days));
console.log('列表标记:', JSON.stringify(await page.evaluate(() => {
  const it = document.querySelector('#aiDayList [data-dayedit]');
  return it ? it.innerText.replace(/\n/g, ' | ') : null;
})));

// 4) 改居中 → 预览变左
await page.evaluate(() => {
  document.getElementById('adCenter').checked = false;
  document.getElementById('adCenter').dispatchEvent(new Event('change'));
});
await page.waitForTimeout(300);
console.log('不居中预览:', JSON.stringify(await page.evaluate(() => document.getElementById('adText').style.textAlign)));

// 5) 照片：填地址自动保存 + 预览
await page.evaluate(() => {
  const p = document.getElementById('aiPhoto');
  p.value = './icon-512.png';
  p.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(1600);
console.log('照片保存:', posts[posts.length - 1].photo, '| 缩略图:', await page.evaluate(() => document.getElementById('aiPhotoPrev').style.display !== 'none'));

await page.screenshot({ path: '/tmp/admin397.png', fullPage: true });
await browser.close();
