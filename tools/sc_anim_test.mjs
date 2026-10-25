/* v3.10.0：成绩图表动画改成「滚到才播 + 出视口复位 + 回来重播」，以及卡片折叠 */
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

const FIXTURE = `
<div class="sc-card" data-scblk="t_hist" id="tHist">
  <div class="sc-card-h">总分分布</div>
  <svg viewBox="0 0 640 180" class="sc-svg">
    <rect class="sc-bar" x="10" y="100" width="20" height="60" fill="#f0c9a3"></rect>
    <rect class="sc-bar" x="40" y="80" width="20" height="80" fill="#f0c9a3"></rect>
    <line class="sc-axis" x1="0" y1="160" x2="640" y2="160" stroke="#e2d5c8"></line>
    <text class="sc-bar-num">3</text>
  </svg>
</div>
<div class="sc-card" data-scblk="t_stat" id="tStat">
  <div class="sc-card-h">概览</div>
  <div class="sc-stats"><div class="sc-stat"><b>612.5</b><span>均分</span></div></div>
</div>
<div class="sc-card" data-scblk="t_band" id="tBand">
  <div class="sc-card-h">分数段</div>
  <div class="sc-segrow"><div class="sc-seg-bar" style="width:40%"><span>23</span></div></div>
</div>
<div style="height:2400px"></div>`;

async function open(lite) {
  /* SW 是缓存优先，会把旧的 app.min.js 顶回来 → 测试里禁掉 */
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate((lite) => {
    localStorage.setItem('cls_seen_welcome', '1');
    if (lite) localStorage.setItem('cls_lite_mode', '1');
    else localStorage.removeItem('cls_lite_mode');
  }, lite);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    document.querySelectorAll('.welcome-mask,#loginGuideMask,#welcomeMask,#guestMask')
      .forEach((m) => { m.classList.remove('show'); if (m.parentNode) m.parentNode.removeChild(m); });
  });
  return { ctx, page, errs };
}

/* ⚠️ 首页 DOM 里本来就有一个隐藏的 #scPaneBox（成绩面板容器，display:none）。
   直接复用它会导致 rect 全 0 → 观察器认为「不在视口」→ 什么都不播。
   所以先把它的 id 摘掉，再新建一个可见的同 id 容器（CSS 选择器照样命中）。 */
const mount = async (page, html) => page.evaluate((h) => {
  const stale = document.getElementById('scPaneBox');
  if (stale) stale.id = 'scPaneBoxHidden';
  const box = document.createElement('div');
  box.id = 'scPaneBox';
  box.style.cssText = 'position:relative;z-index:9999;background:#fdfbf7;padding:12px';
  box.innerHTML = h;
  document.body.insertBefore(box, document.body.firstChild);
  window.__scAnim(box);
}, html);

const barH = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#scPaneBox .sc-bar')].map((b) => Math.round(Number(b.getAttribute('height')))));

/* ---------- 1. 视口内才播 ---------- */
{
  const { ctx, page, errs } = await open(false);

  /* 挂上去的同时开始逐帧采样柱子总高度（不靠固定等待，避免时序脆弱） */
  const seq = await page.evaluate((h) => new Promise((resolve) => {
    const stale = document.getElementById('scPaneBox');
    if (stale) stale.id = 'scPaneBoxHidden';
    const box = document.createElement('div');
    box.id = 'scPaneBox';
    box.style.cssText = 'position:relative;z-index:9999;background:#fdfbf7;padding:12px';
    box.innerHTML = h;
    document.body.insertBefore(box, document.body.firstChild);
    window.__scAnim(box);
    const out = [];
    let n = 0;
    const sum = () => [...document.querySelectorAll('#scPaneBox .sc-bar')]
      .reduce((a, b) => a + Number(b.getAttribute('height')), 0);
    const tick = () => {
      out.push({ t: sum(), inView: document.getElementById('tHist').classList.contains('sc-in') });
      if (++n < 48) requestAnimationFrame(tick);
      else resolve(out);
    };
    requestAnimationFrame(tick);
  }), FIXTURE);

  const seenIn = seq.some((x) => x.inView);
  const first = seq[0].t;
  const max = Math.max(...seq.map((x) => x.t));
  t('卡片滚进视口后开始播', seenIn, JSON.stringify(seq.slice(0, 3)));
  t('柱子是从 0 长上来的', first < 10 && max > 130, first.toFixed(1) + ' → ' + max.toFixed(1));
  t('中途有过渡帧（不是一步到位）',
    seq.filter((x) => x.t > 5 && x.t < 135).length >= 3,
    JSON.stringify(seq.filter((x) => x.t > 5 && x.t < 135).slice(0, 5).map((x) => Math.round(x.t))));
  t('柱子最终到真实高度', JSON.stringify(await barH(page)) === JSON.stringify([60, 80]),
    JSON.stringify(await barH(page)));

  await page.waitForTimeout(500);
  const num1 = await page.evaluate(() => document.querySelector('#tStat .sc-stat b').textContent);
  t('概览数字滚到真实值', num1 === '612.5', num1);
  const seg = await page.evaluate(() => document.querySelector('#tBand .sc-seg-bar').style.width);
  t('横条撑到 40%', seg === '40%', seg);

  /* 滚出视口 → 复位 */
  await page.evaluate(() => window.scrollTo(0, 1400));
  await page.waitForTimeout(400);
  const c = await barH(page);
  const inView2 = await page.evaluate(() => document.querySelectorAll('#scPaneBox .sc-card.sc-in').length);
  t('滚出视口后柱子归零', c.every((h) => h === 0), JSON.stringify(c));
  t('滚出视口后摘掉 sc-in', inView2 === 0, String(inView2));

  /* 滚回来 → 重播 */
  await page.evaluate(() => window.scrollTo(0, 0));
  const seq2 = await page.evaluate(() => new Promise((resolve) => {
    const out = [];
    let n = 0;
    const sum = () => [...document.querySelectorAll('#scPaneBox .sc-bar')]
      .reduce((a, b) => a + Number(b.getAttribute('height')), 0);
    const tick = () => {
      out.push(sum());
      if (++n < 48) requestAnimationFrame(tick);
      else resolve(out);
    };
    requestAnimationFrame(tick);
  }));
  t('滚回来会重新播一遍', seq2[0] < 60 && Math.max(...seq2) > 130,
    seq2[0].toFixed(1) + ' → ' + Math.max(...seq2).toFixed(1));

  const num2 = await page.evaluate(() => document.querySelector('#tStat .sc-stat b').textContent);
  t('文字数字不跟着重播（保持在真实值）', num2 === '612.5', num2);

  /* ---------- 折叠 ---------- */
  const hasBtn = await page.evaluate(() => !!document.querySelector('#tHist .sc-fold-btn'));
  t('每张卡右上角都有折叠按钮', hasBtn, String(hasBtn));
  await page.locator('#tHist .sc-fold-btn').click();
  await page.waitForTimeout(250);
  const folded = await page.evaluate(() => {
    const card = document.getElementById('tHist');
    /* 折叠后内容都收进 .sc-fold-body 并 hidden */
    const body = card.querySelector('.sc-fold-body');
    return { cls: card.classList.contains('sc-folded'),
             hasBody: !!body,
             hidden: !!(body && body.hidden),
             h: body ? Math.round(body.getBoundingClientRect().height) : -1,
             cardCls: card.className };
  });
  t('点一下能收起（内容隐藏）', folded.cls && folded.hidden, JSON.stringify(folded));
  await page.locator('#tHist .sc-fold-btn').click();
  await page.waitForTimeout(250);
  const back = await page.evaluate(() => document.getElementById('tHist').classList.contains('sc-folded'));
  t('再点一下能展开', back === false, String(back));

  t('无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

/* ---------- 2. 轻量模式：不动画，折叠照旧 ---------- */
{
  const { ctx, page, errs } = await open(true);
  await mount(page, FIXTURE);
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => ({
    cls: document.getElementById('scPaneBox').className,
    h: [...document.querySelectorAll('#scPaneBox .sc-bar')].map((b) => Math.round(Number(b.getAttribute('height')))),
    seg: document.querySelector('#tBand .sc-seg-bar').style.width,
    fold: document.querySelectorAll('#scPaneBox .sc-fold-btn').length,
  }));
  t('轻量模式不挂 sc-anim', !/sc-anim/.test(r.cls), r.cls);
  t('轻量模式柱子直接是真值', JSON.stringify(r.h) === JSON.stringify([60, 80]), JSON.stringify(r.h));
  t('轻量模式横条不归零', r.seg === '40%', r.seg);
  t('轻量模式折叠按钮照旧存在', r.fold >= 3, String(r.fold));
  t('轻量模式无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

await browser.close();
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
