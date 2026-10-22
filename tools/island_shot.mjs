/* 班级岛新配色截图：浅色 / 深色 */
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
      banner: { mon: '升 数数语英化 物物体劳 听自语语自', tue: '英 英备备备语 化生物数 练自化化自', wed: '语 语数物英英 音生化班 听自英英自', thu: '生 微语生生英 物健自自 练自数数自', fri: '英 数语语化化 体生英物 听自生生自', sat: '自自 自自 读自自', sun: '读自 物理 物自' },
      days: {}, holidays: [],
    } }) });
  }
  if (url.includes('/api/content')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"items":{},"serverTime":"2026-10-22T00:00:00Z"}' });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
};

for (const [name, theme] of [['light', 'light'], ['dark', 'dark']]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript((t) => {
    localStorage.setItem('cls_theme', t);
    localStorage.setItem('cls_theme_auto2', 'off');
    localStorage.setItem('cls_login_guide_v1', '1');
    localStorage.setItem('cls_welcome_v1', '1');
    localStorage.setItem('cls_study_notice_dismissed', '1');
  }, theme);
  await page.route('**/api/**', mock);
  await page.goto('http://localhost:8111/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);
  const el = await page.$('#classIsland');
  if (el) await el.screenshot({ path: `/tmp/single_island_${name}.png` });
  const info = await page.evaluate(() => {
    const i = document.getElementById('classIsland');
    const cs = getComputedStyle(i);
    const chip = i.querySelector('.island-chip .v');
    const txt = i.querySelector('.island-banner .txt');
    return {
      islandBg: cs.backgroundImage.slice(0, 60),
      chipColor: chip ? getComputedStyle(chip).color : null,
      bannerColor: txt ? getComputedStyle(txt).color : null,
      bannerAlign: txt ? getComputedStyle(txt).textAlign : null,
      islandAlign: cs.textAlign,
      height: Math.round(i.getBoundingClientRect().height),
    };
  });
  console.log(name, JSON.stringify(info));
  await ctx.close();
}
await browser.close();
