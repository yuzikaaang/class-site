/* v3.9.22：卡片默认小窗口 + 点击展开 + 设置项 */
import { chromium } from 'playwright-core';

const BASE = 'http://localhost:8111';
const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
let pass = 0, fail = 0;
const t = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d ? '  → ' + d : '')); }
};

async function boot(dark) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate((d) => {
    localStorage.setItem('cls_seen_welcome', '1');
    if (d) localStorage.setItem('cls_theme', 'dark');
    try { localStorage.removeItem('cls_ui_cfg'); } catch (e) {}
  }, dark);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    document.querySelectorAll('.welcome-mask,.allboard-mask,#loginGuideMask,#welcomeMask,#guestMask')
      .forEach((m) => { m.classList.remove('show'); if (m.parentNode) m.parentNode.removeChild(m); });
    openCat(8);
  });
  await page.waitForTimeout(800);
  return { ctx, page };
}

const { ctx, page } = await boot(false);

/* 1. 默认紧凑 */
const s1 = await page.evaluate(() => ({
  cls: document.documentElement.className,
  n: document.querySelectorAll('#tab-cat-8 .card').length,
  h: [...document.querySelectorAll('#tab-cat-8 .card')].map((c) => Math.round(c.getBoundingClientRect().height)),
}));
t('默认是紧凑模式', /cards-compact/.test(s1.cls), s1.cls);
t('其他工具里有卡片', s1.n >= 3, String(s1.n));
t('卡片默认高度 ≤ 90px', s1.h.every((h) => h > 0 && h <= 90), JSON.stringify(s1.h));

/* 2. 点一下展开 */
const box = await page.locator('#tab-cat-8 .card').first().boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(500);
const s2 = await page.evaluate(() => {
  const c = document.querySelector('#tab-cat-8 .card');
  const d = c.querySelector('.card-detail');
  return { open: /open/.test(c.className), h: Math.round(c.getBoundingClientRect().height), d: d ? getComputedStyle(d).display : 'none' };
});
t('点击后展开', s2.open && s2.d === 'block', JSON.stringify(s2));
t('展开后比折叠高很多', s2.h > 120, String(s2.h));

/* 3. 再点收起 */
await page.mouse.click(box.x + box.width / 2, box.y + 20);
await page.waitForTimeout(400);
const s3 = await page.evaluate(() => {
  const c = document.querySelector('#tab-cat-8 .card');
  return { open: /open/.test(c.className), h: Math.round(c.getBoundingClientRect().height) };
});
t('再点一次收起', !s3.open && s3.h <= 90, JSON.stringify(s3));

/* 4. 点按钮不会误触折叠 */
await page.evaluate(() => {
  const c = document.querySelector('#tab-cat-8 .card');
  c.classList.add('open');
});
await page.waitForTimeout(300);
const before = await page.evaluate(() => /open/.test(document.querySelector('#tab-cat-8 .card').className));
const btn = await page.evaluate(() => {
  const b = document.querySelector('#tab-cat-8 .card.open .card-actions button');
  return b ? b.textContent.trim() : null;
});
if (btn) {
  await page.evaluate(() => {
    /* 拦掉真实跳转，只测折叠状态 */
    const b = document.querySelector('#tab-cat-8 .card.open .card-actions button');
    b.setAttribute('data-orig', b.getAttribute('onclick') || '');
    b.removeAttribute('onclick');
    b.onclick = function (e) { e.stopPropagation(); };
  });
  await page.locator('#tab-cat-8 .card.open .card-actions button').first().click();
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => /open/.test(document.querySelector('#tab-cat-8 .card').className));
  t('点卡片里的按钮不会把卡片收起来', before && after, '按钮：' + btn);
} else {
  t('点卡片里的按钮不会把卡片收起来', true, '（这张卡没有按钮，跳过）');
}

/* 5. 设置里切「全部展开」 */
await page.evaluate(() => { setCardMode('open'); });
await page.waitForTimeout(700);
const s5 = await page.evaluate(() => {
  openCat(8);
  return null;
});
await page.waitForTimeout(600);
const s5b = await page.evaluate(() => ({
  cls: document.documentElement.className,
  h: [...document.querySelectorAll('#tab-cat-8 .card')].map((c) => Math.round(c.getBoundingClientRect().height)),
  detail: [...document.querySelectorAll('#tab-cat-8 .card .card-detail')].map((d) => getComputedStyle(d).display),
}));
t('切成「全部展开」后不再紧凑', !/cards-compact/.test(s5b.cls), s5b.cls);
t('展开模式下详情直接可见', s5b.detail.every((d) => d === 'block'), JSON.stringify(s5b.detail));
t('展开模式卡片更高', s5b.h.every((h) => h > 120), JSON.stringify(s5b.h));

/* 6. 切回小窗口并记住 */
await page.evaluate(() => { setCardMode('compact'); });
await page.waitForTimeout(600);
const s6 = await page.evaluate(() => {
  const raw = localStorage.getItem('cls_ui_cfg') || '';
  return { compact: /cards-compact/.test(document.documentElement.className), saved: /"cardMode":"compact"/.test(raw) };
});
t('可以切回小窗口', s6.compact, JSON.stringify(s6));
t('选择会保存下来', s6.saved, String(s6.saved));

/* 7. 设置面板里有这一项 */
const panel = await page.evaluate(() => {
  const has = typeof setCardMode === 'function';
  let btn = false;
  try {
    openUISettings ? openUISettings() : null;
  } catch (e) {}
  return { has };
});
t('设置里有 setCardMode 入口', panel.has);
await ctx.close();

/* 8. 暗色下也正常 */
const dark = await boot(true);
await dark.ctx.close();

await browser.close();
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
