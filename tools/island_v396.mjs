/* v3.9.6 验证：气泡样式 / 窄屏字号 / 照片弹层 */
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});

const mock = async (route) => {
  const url = route.request().url();
  if (url.includes('/api/island')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {
      on: true, term: '2026 年秋季 · 高二上', startDate: '2026-09-01',
      components: ['time', 'weather', 'week', 'term'],
      banner: { mon: '升 数数语英化 物物体劳 听自语语自', tue: '英 英备备备语 化生物数 练自化化自', wed: '语 语数物英英 音生化班 听自英英自', thu: '生 微语生生英 物健自自 练自数数自\n数学 08:00-09:30', fri: '英 数语语化化 体生英物 听自生生自', sat: '自自 自自 读自自', sun: '读自 物理 物自' },
      days: {}, holidays: [], photo: './badge.png',
    } }) });
  }
  if (url.includes('/api/content')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"items":{},"serverTime":"2026-10-22T00:00:00Z"}' });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
};

for (const [w, theme] of [[390, 'light'], [390, 'dark'], [360, 'light']]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript((t) => {
    localStorage.setItem('cls_theme', t);
    localStorage.setItem('cls_theme_auto2', 'off');
    localStorage.setItem('cls_login_guide_v1', '1');
    localStorage.setItem('cls_welcome_v1', '1');
  }, theme);
  await page.route('**/api/**', mock);
  await page.goto('http://localhost:8111/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);
  await page.evaluate(() => {
    document.querySelectorAll('.allboard-mask,.mask,.qr-mask').forEach((m) => { m.classList.remove('show'); m.style.display = 'none'; });
  });
  await page.waitForTimeout(300);
  const el = await page.$('#classIsland');
  if (el) await el.screenshot({ path: `/tmp/isl_${w}_${theme}.png` });
  const info = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('#classIsland .island-chip')];
    return {
      overflow: chips.map((c) => {
        const v = c.querySelector('.v');
        return v.scrollWidth > v.clientWidth + 1;
      }),
      texts: chips.map((c) => c.querySelector('.v').textContent),
    };
  });
  console.log(w, theme, JSON.stringify(info));
  if (w === 390) {
    // 点横幅 → 照片弹层
    await page.click('#classIsland .island-banner');
    await page.waitForTimeout(700);
    const st = await page.evaluate(() => {
      const m = document.getElementById('islPhotoMask');
      const img = document.getElementById('islPhotoImg');
      return { show: m.classList.contains('show'), src: img.getAttribute('src'),
        natural: img.naturalWidth + 'x' + img.naturalHeight, transform: getComputedStyle(img).transform };
    });
    console.log('photo modal:', JSON.stringify(st));
    await page.screenshot({ path: `/tmp/isl_photo_${theme}.png` });
    // 双击放大
    await page.dblclick('#islPhotoStage');
    await page.waitForTimeout(400);
    const z = await page.evaluate(() => getComputedStyle(document.getElementById('islPhotoImg')).transform);
    console.log('after dblclick scale:', z);
    // 关闭
    await page.click('.isl-photo-close');
    await page.waitForTimeout(300);
    const closed = await page.evaluate(() => !document.getElementById('islPhotoMask').classList.contains('show'));
    console.log('closed:', closed);
  }
  await ctx.close();
}
await browser.close();
