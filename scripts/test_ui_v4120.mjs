/* v4.12.0 专项：
   ① 进站问答层已整段删除（DOM / 函数 / 存储键）
   ② 教程入口：顶栏书签 + 侧边栏，点击进 guide.html
   ③ 首页导览：清空记录后自动出现，8 步走完，末步写入 done
   ④ Esc 退出保留断点，重载从断点续播
   ⑤ 登录弹层导览 4 步，目标依次为用户名 / 密码 / 验证码 / 登录
   ⑥ 教程页：7 章 12 条目，搜索能过滤
   ⑦ 设置「帮助」页签：状态、重看、重置 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.env.CLS_SITE || 'http://localhost:8899';
const SITE = BASE.replace(/\/$/, '') + '/index.html';
const CH = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const OUT = '/workspace/classsite-v4120/';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const t = (n, ok, x) => {
  if (ok) { pass++; console.log('  ✓ ' + n + (x ? '  [' + x + ']' : '')); }
  else { fail++; console.log('  ✗ ' + n + (x ? '  [' + x + ']' : '')); }
};

const ISLAND = {
  on: true, startDate: '2026-09-02', endDate: '2027-01-30', enrollDate: '2025-09-01',
  term: '2026 年秋季 · 高二上', holidays: [], nightFrom: '21:00', photo: '',
  banner: { mon: '语文 数学', tue: '英语 物理', wed: '化学 生物', thu: '', fri: '', sat: '', sun: '' },
  days: {},
};

function mock(page) {
  return page.route('**/api/**', (r) => {
    const u = r.request().url();
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.includes('/api/island')) return J({ ok: true, data: ISLAND });
    if (u.includes('/api/content')) return J({ ok: true, items: { announcements: [{ id: 'a1', text: 'v4.12 更新！内容如下：\n【界面】新增使用教程', date: '2026-11-11 12:00', pinned: true }] } });
    if (u.includes('/auth?action=me')) return J({ ok: true });
    return J({ ok: true });
  });
}

const browser = await chromium.launch({ executablePath: CH, args: ['--no-sandbox'] });

/* ============ A. 进站问答已删除 ============ */
console.log('\nA. 进站问答层');
{
  const ctx = await browser.newContext({ viewport: { width: 412, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
  await mock(page);
  await page.addInitScript(() => {
    try {
      localStorage.setItem('cls_login_guide_v1', '1');
      localStorage.setItem('cls_tour_v1', JSON.stringify({ login: { done: 1 }, home: { done: 1 } }));
    } catch (e) {}
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  const s = await page.evaluate(() => ({
    dom: !!document.getElementById('siteGate'),
    fn: typeof window.submitSiteGate,
    key: localStorage.getItem('cls_site_gate'),
    css: [...document.styleSheets].some((sh) => {
      try { return [...sh.cssRules].some((r) => r.selectorText && r.selectorText.indexOf('.site-gate') >= 0); }
      catch (e) { return false; }
    }),
  }));
  t('A1 页面里没有 #siteGate', s.dom === false);
  t('A2 全局没有 submitSiteGate', s.fn === 'undefined', s.fn);
  t('A3 没有残留的 .site-gate 样式', s.css === false);
  t('A4 没有 cls_site_gate 存储键', s.key === null);
  t('A5 没有脚本报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

/* ============ B. 教程入口 ============ */
console.log('\nB. 教程入口');
{
  const ctx = await browser.newContext({ viewport: { width: 412, height: 900 } });
  const page = await ctx.newPage();
  await mock(page);
  await page.addInitScript(() => {
    try {
      localStorage.setItem('cls_login_guide_v1', '1');
      localStorage.setItem('cls_tour_v1', JSON.stringify({ login: { done: 1 }, home: { done: 1 } }));
    } catch (e) {}
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1600);
  const r = await page.evaluate(() => {
    const g = (id) => {
      const e = document.getElementById(id);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height), left: Math.round(b.left), top: Math.round(b.top) };
    };
    return { top: g('guideBtn'), side: g('sideGuideBtn') };
  });
  t('B1 顶栏书签按钮存在且有尺寸', !!r.top && r.top.w > 20 && r.top.h > 20, JSON.stringify(r.top));
  t('B2 侧边栏「使用教程」存在', !!r.side && r.side.w > 0, JSON.stringify(r.side));

  const noOverlap = r.top && (await page.evaluate(() => {
    const a = document.getElementById('themeToggle').getBoundingClientRect();
    const b = document.getElementById('guideBtn').getBoundingClientRect();
    return b.right <= a.left + 1 || a.right <= b.left + 1;
  }));
  t('B3 书签与主题按钮不重叠', !!noOverlap);

  await page.click('#guideBtn');
  await page.waitForTimeout(1200);
  t('B4 点击书签进入 guide.html', /guide\.html$/.test(page.url()), page.url());
  await ctx.close();
}

/* ============ C. 首页导览 8 步 ============ */
console.log('\nC. 首页导览');
{
  const ctx = await browser.newContext({ viewport: { width: 412, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
  await mock(page);
  await page.addInitScript(() => {
    try { localStorage.removeItem('cls_tour_v1'); localStorage.setItem('cls_login_guide_v1', '1'); } catch (e) {}
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });

  let shown = false;
  for (let i = 0; i < 24; i++) {
    if (await page.$('.tour-hole')) { shown = true; break; }
    await page.waitForTimeout(500);
  }
  t('C1 首次进入自动出现导览', shown);

  const titles = [];
  for (let i = 0; i < 10; i++) {
    if (!(await page.$('.tour-next'))) break;
    const info = await page.evaluate(() => {
      const h = document.querySelector('.tour-hole');
      const b = h && h.getBoundingClientRect();
      return {
        k: (document.querySelector('.tour-kicker') || {}).textContent || '',
        ti: (document.querySelector('.tour-title') || {}).textContent || '',
        rect: b && [Math.round(b.width), Math.round(b.height)],
        last: (document.querySelector('.tour-next') || {}).textContent === '完成',
      };
    });
    titles.push(info.ti);
    if (i === 0) t('C2 第 1 步是班级岛', info.ti === '班级岛', info.ti);
    t('C3-' + (i + 1) + ' 第 ' + (i + 1) + ' 步光洞有尺寸', !!info.rect && info.rect[0] > 20 && info.rect[1] > 10, JSON.stringify(info.rect));
    if (info.last) break;
    await page.click('.tour-next');
    await page.waitForTimeout(700);
  }
  /* 目标塌陷的板块会被跳过（mock 里一言/倒计时可能没内容），
     所以要求「是应有顺序的子序列，且最后一步是教程入口」 */
  const EXPECT = ['班级岛', '班级公告', '签到', '今日班级签', '每日一言', '学习卡片', '倒计时', '大屏与使用教程'];
  let hit = 0;
  titles.forEach((x) => { if (x === EXPECT[hit]) hit++; });
  t('C4 顺序与首页一致（允许跳过塌陷板块）',
    hit >= 6 && titles[titles.length - 1] === '大屏与使用教程', titles.join('|'));

  await page.click('.tour-next');
  await page.waitForTimeout(600);
  const st = await page.evaluate(() => ({
    hollow: !!document.querySelector('.tour-hole'),
    raw: localStorage.getItem('cls_tour_v1'),
  }));
  t('C5 走完自动关闭', st.hollow === false);
  t('C6 完成后写入 done', /"home":\{"done":1\}/.test(st.raw || ''), st.raw);
  t('C7 全程无脚本报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

/* ============ D. Esc 退出 + 断点续播 ============ */
console.log('\nD. 断点续播');
{
  const ctx = await browser.newContext({ viewport: { width: 412, height: 900 } });
  const page = await ctx.newPage();
  await mock(page);
  await page.addInitScript(() => {
    try {
      /* reload 会重跑 init script —— 用 sessionStorage 守卫，只清一次，否则断点会被自己抹掉 */
      if (!sessionStorage.getItem('tour_once')) { sessionStorage.setItem('tour_once', '1'); localStorage.removeItem('cls_tour_v1'); }
      localStorage.setItem('cls_login_guide_v1', '1');
    } catch (e) {}
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 24; i++) {
    if (await page.$('.tour-hole')) break;
    await page.waitForTimeout(500);
  }
  await page.click('.tour-next');
  await page.waitForTimeout(600);
  await page.click('.tour-next');
  await page.waitForTimeout(600);
  const atThird = (await page.evaluate(() => document.querySelector('.tour-title').textContent));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const k = await page.evaluate(() => localStorage.getItem('cls_tour_v1'));
  t('D1 Esc 能退出', (await page.evaluate(() => !document.querySelector('.tour-hole'))));
  t('D2 退出时记下断点', /"at":2/.test(k || ''), k + ' / 当时在 ' + atThird);

  await page.reload({ waitUntil: 'domcontentloaded' });
  let back = '';
  for (let i = 0; i < 24; i++) {
    if (await page.$('.tour-hole')) { back = await page.evaluate(() => document.querySelector('.tour-title').textContent); break; }
    await page.waitForTimeout(500);
  }
  t('D3 重载后从第 3 步继续（签到）', back === '签到', back);
  await ctx.close();
}

/* ============ E. 登录弹层导览 ============ */
console.log('\nE. 登录导览');
{
  const ctx = await browser.newContext({ viewport: { width: 412, height: 900 } });
  const page = await ctx.newPage();
  await mock(page);
  await page.addInitScript(() => {
    try { localStorage.setItem('cls_tour_v1', JSON.stringify({ home: { done: 1 } })); localStorage.setItem('cls_login_guide_v1', '1'); } catch (e) {}
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.evaluate(() => { if (typeof openAccount === 'function') openAccount(); });
  let shown = false;
  for (let i = 0; i < 20; i++) {
    if (await page.$('.tour-hole')) { shown = true; break; }
    await page.waitForTimeout(400);
  }
  t('E1 打开登录弹层后出现导览', shown);

  const order = [];
  for (let i = 0; i < 4; i++) {
    order.push(await page.evaluate(() => document.querySelector('.tour-title').textContent));
    if (i === 3) break;
    await page.click('.tour-next');
    await page.waitForTimeout(600);
  }
  t('E2 四步顺序正确', order.join('|') === '用户名|密码|安全验证|登录', order.join('|'));

  const st = await page.evaluate(() => localStorage.getItem('cls_tour_v1'));
  await page.click('.tour-next');
  await page.waitForTimeout(500);
  const st2 = await page.evaluate(() => localStorage.getItem('cls_tour_v1'));
  t('E3 走完写入 login.done', /"login":\{"done":1\}/.test(st2 || ''), st + ' → ' + st2);
  await ctx.close();
}

/* ============ F. 教程页 ============ */
console.log('\nF. 教程页');
{
  const ctx = await browser.newContext({ viewport: { width: 412, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
  await page.goto(BASE + '/guide.html', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(400);
  const s = await page.evaluate(() => ({
    cards: document.querySelectorAll('section.card').length,
    topics: [...document.querySelectorAll('[data-topic]')].map((x) => x.getAttribute('data-topic')),
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
  t('F1 七个章节', s.cards === 7, s.cards);
  t('F2 十二个说明条目', s.topics.length === 12, s.topics.length);
  t('F3 手机端无横向溢出', s.overflow === false);

  await page.fill('#q', '大屏');
  await page.waitForTimeout(350);
  const vis = await page.evaluate(() => [...document.querySelectorAll('section.card')].filter((c) => c.style.display !== 'none').length);
  t('F4 搜索「大屏」能过滤', vis > 0 && vis < 7, '可见 ' + vis + ' 章');
  await page.fill('#q', 'zzzz');
  await page.waitForTimeout(300);
  const none = await page.evaluate(() => ({
    vis: [...document.querySelectorAll('section.card')].filter((c) => c.style.display !== 'none').length,
    empty: getComputedStyle(document.getElementById('empty')).display !== 'none',
  }));
  t('F5 无结果时给空态', none.vis === 0 && none.empty, JSON.stringify(none));
  t('F6 教程页无脚本报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

/* ============ G. 设置帮助页签 ============ */
console.log('\nG. 设置「帮助」页签');
{
  const ctx = await browser.newContext({ viewport: { width: 412, height: 900 } });
  const page = await ctx.newPage();
  await mock(page);
  await page.addInitScript(() => {
    try { localStorage.setItem('cls_login_guide_v1', '1'); localStorage.setItem('cls_tour_v1', JSON.stringify({ home: { done: 1 } })); } catch (e) {}
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1800);
  await page.evaluate(() => { openSettings(); uiSec('help'); });
  await page.waitForTimeout(600);
  const s = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.ui-tab[data-sec]')].map((x) => x.getAttribute('data-sec')),
    btns: [...document.querySelectorAll('#uiSetBody button')].map((b) => b.textContent.trim()),
    rows: [...document.querySelectorAll('#uiSetBody .up-row .v')].map((b) => b.textContent.trim()),
    clipped: (() => { const b = document.querySelector('.ui-tabs'); return b.scrollWidth > b.clientWidth + 1; })(),
  }));
  t('G1 有「帮助」页签', s.tabs.indexOf('help') >= 0, s.tabs.join(','));
  t('G2 三个按钮齐全', ['重看新手导览', '重置导览记录', '打开使用教程'].every((x) => s.btns.indexOf(x) >= 0), s.btns.join(','));
  t('G3 显示两段导览状态', s.rows.length >= 2, s.rows.join(' / '));
  t('G4 六个页签不被裁切', s.clipped === false);

  await page.evaluate(() => document.querySelector('#uiSetBody button[onclick="tourReset()"]').click());
  await page.waitForTimeout(400);
  t('G5 重置清掉记录', (await page.evaluate(() => localStorage.getItem('cls_tour_v1'))) === null);
  await ctx.close();
}

await browser.close();
console.log('\n' + (fail ? '✗ ' : '✅ ') + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
