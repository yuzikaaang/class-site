/* v3.9.26：成绩图表入场动画（柱子长高 / 横条撑开 / 数字滚动 / 轻量模式不动画） */
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

/* 每页都塞一份「假图表」，直接喂给 window.__scAnim */
const FIXTURE = `
<div class="sc-card">
  <svg viewBox="0 0 640 180" class="sc-svg">
    <rect class="sc-bar" x="10" y="100" width="20" height="60" fill="#f0c9a3"></rect>
    <rect class="sc-bar" x="40" y="80" width="20" height="80" fill="#f0c9a3"></rect>
    <rect class="sc-bar" x="70" y="120" width="20" height="40" fill="#f0c9a3"></rect>
    <line class="sc-axis" x1="0" y1="160" x2="640" y2="160" stroke="#e2d5c8"></line>
    <text class="sc-bar-num">3</text>
    <polygon class="sc-mine-poly" points="320,54 400,154 240,154" fill="rgba(192,57,43,.16)"></polygon>
  </svg>
  <div class="sc-stats">
    <div class="sc-stat"><b>612.5</b><span>均分</span></div>
    <div class="sc-stat"><b>58</b><span>人数</span></div>
  </div>
  <div class="sc-segrow"><div class="sc-seg-bar" style="width:40%"><span>23</span></div></div>
  <div class="sc-subs"><div class="sc-sub"><div class="sc-sub-bar"><i style="width:76%"></i></div></div></div>
  <table class="sc-tbl"><tbody><tr><td>1</td></tr><tr><td>2</td></tr></tbody></table>
</div>`;

async function open(lite) {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 860 } });
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
  await page.waitForTimeout(2600);
  await page.evaluate(() => {
    document.querySelectorAll('.welcome-mask,#loginGuideMask,#welcomeMask,#guestMask')
      .forEach((m) => { m.classList.remove('show'); if (m.parentNode) m.parentNode.removeChild(m); });
  });
  return { ctx, page, errs };
}

/* ---------- 1. 正常模式：动画要真的跑 ---------- */
{
  const { ctx, page, errs } = await open(false);
  await page.evaluate((html) => {
    let box = document.getElementById('scPaneBox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'scPaneBox';
      document.body.appendChild(box);
    }
    box.innerHTML = html;
    window.__scAnim(box);
  }, FIXTURE);

  const at0 = await page.evaluate(() => {
    const bars = [...document.querySelectorAll('#scPaneBox .sc-bar')];
    return {
      cls: document.getElementById('scPaneBox').className,
      h: bars.map((b) => Number(b.getAttribute('height'))),
      y: bars.map((b) => Number(b.getAttribute('y'))),
      num: document.querySelector('#scPaneBox .sc-stat b').textContent,
    };
  });
  t('渲染后给容器打上 sc-anim 标记', /sc-anim/.test(at0.cls), at0.cls);
  t('柱子在起点时高度接近 0', at0.h.every((h) => h < 6), JSON.stringify(at0.h));
  t('柱子底边先落在 x 轴上', at0.y.every((y) => Math.abs(y - 160) < 2), JSON.stringify(at0.y));
  t('概览数字从 0 开始滚', /^0/.test(at0.num), at0.num);

  await page.waitForTimeout(320);
  const mid = await page.evaluate(() => ({
    h: [...document.querySelectorAll('#scPaneBox .sc-bar')].map((b) => Number(b.getAttribute('height'))),
    num: document.querySelector('#scPaneBox .sc-stat b').textContent,
  }));
  t('300ms 时柱子已经长到一半上下',
    mid.h.some((h) => h > 20) && mid.h.some((h) => h < 60), JSON.stringify(mid.h));

  await page.waitForTimeout(900);
  const end = await page.evaluate(() => ({
    h: [...document.querySelectorAll('#scPaneBox .sc-bar')].map((b) => Math.round(Number(b.getAttribute('height')))),
    y: [...document.querySelectorAll('#scPaneBox .sc-bar')].map((b) => Math.round(Number(b.getAttribute('y')))),
    num: document.querySelector('#scPaneBox .sc-stat b').textContent,
    num2: document.querySelectorAll('#scPaneBox .sc-stat b')[1].textContent,
    seg: document.querySelector('#scPaneBox .sc-seg-bar').style.width,
    sub: document.querySelector('#scPaneBox .sc-sub-bar i').style.width,
    rise: document.querySelectorAll('#scPaneBox .sc-rise').length,
  }));
  t('柱子最终停在真实高度', JSON.stringify(end.h) === JSON.stringify([60, 80, 40]), JSON.stringify(end.h));
  t('柱子顶边跟着高度一起抬', JSON.stringify(end.y) === JSON.stringify([100, 80, 120]), JSON.stringify(end.y));
  t('数字滚到真实值（带小数）', end.num === '612.5' && end.num2 === '58', end.num + ' / ' + end.num2);
  t('分数段横条撑到 40%', end.seg === '40%', end.seg);
  t('单科得分率条撑到 76%', end.sub === '76%', end.sub);
  t('表格行参与错峰动画', end.rise >= 2, String(end.rise));
  t('正常模式无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

/* ---------- 2. 轻量模式：一点动画都不许有 ---------- */
{
  const { ctx, page, errs } = await open(true);
  await page.evaluate((html) => {
    let box = document.getElementById('scPaneBox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'scPaneBox';
      document.body.appendChild(box);
    }
    box.innerHTML = html;
    window.__scAnim(box);
  }, FIXTURE);

  const st = await page.evaluate(() => ({
    cls: document.getElementById('scPaneBox').className,
    h: [...document.querySelectorAll('#scPaneBox .sc-bar')].map((b) => Math.round(Number(b.getAttribute('height')))),
    num: document.querySelector('#scPaneBox .sc-stat b').textContent,
    seg: document.querySelector('#scPaneBox .sc-seg-bar').style.width,
    rise: document.querySelectorAll('#scPaneBox .sc-rise').length,
    anims: [...document.querySelectorAll('#scPaneBox .sc-bar-num')]
      .map((e) => getComputedStyle(e).animationName),
  }));
  t('轻量模式下不挂 sc-anim', !/sc-anim/.test(st.cls), st.cls);
  t('轻量模式下柱子直接是最终高度', JSON.stringify(st.h) === JSON.stringify([60, 80, 40]), JSON.stringify(st.h));
  t('轻量模式下数字直接是最终值', st.num === '612.5', st.num);
  t('轻量模式下横条不归零', st.seg === '40%', st.seg);
  t('轻量模式下没有错峰行', st.rise === 0, String(st.rise));
  t('轻量模式无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

/* ---------- 3. 精简动效（UI.motion = 0）：也不动画 ---------- */
{
  const { ctx, page } = await open(false);
  await page.evaluate((html) => {
    /* 模拟「自定义设置 → 动效 → 精简」 */
    window.__uiForceLite = null;
    const box = document.getElementById('scPaneBox') || (() => {
      const d = document.createElement('div'); d.id = 'scPaneBox'; document.body.appendChild(d); return d;
    })();
    box.innerHTML = html;
    /* 直接改内存里的 UI：applyUI 会读它 */
    try {
      var cfg = JSON.parse(localStorage.getItem('cls_ui_cfg') || '{}');
      cfg.motion = 0;
      localStorage.setItem('cls_ui_cfg', JSON.stringify(cfg));
    } catch (e) {}
  }, FIXTURE);
  /* 重新载入让 UI.motion 生效 */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);
  await page.evaluate((html) => {
    const box = document.getElementById('scPaneBox') || (() => {
      const d = document.createElement('div'); d.id = 'scPaneBox'; document.body.appendChild(d); return d;
    })();
    box.innerHTML = html;
    window.__scAnim(box);
  }, FIXTURE);
  const st = await page.evaluate(() => ({
    cls: document.getElementById('scPaneBox').className,
    h: [...document.querySelectorAll('#scPaneBox .sc-bar')].map((b) => Math.round(Number(b.getAttribute('height')))),
  }));
  t('精简动效下同样不播动画', !/sc-anim/.test(st.cls) && JSON.stringify(st.h) === JSON.stringify([60, 80, 40]),
    st.cls + ' ' + JSON.stringify(st.h));
  await ctx.close();
}

await browser.close();
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
