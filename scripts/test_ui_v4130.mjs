/* v4.13.0 专项：
   ① 教程入口只在侧边栏；首页顶部悬浮按钮已移除
   ② 教程页：11 章、32 个条目、13 张截图、搜索可过滤
   ③ 首页导览 8 步，第三块是「今日班级签」，全站不再出现「签到」表述
   ④ 板块导览：常用服务 2 步 / 作业弹窗 3 步 / 设置 6 步 / 文件中转站 3 步 / 成绩分析 2 步
   ⑤ 大屏导览 3 步（桌面视口）
   ⑥ 设置「帮助」页签显示 8 段进度 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = (process.env.CLS_SITE || 'http://localhost:8899').replace(/\/$/, '');
const SITE = BASE + '/index.html';
const GUIDE = BASE + '/guide.html';
const CH = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const OUT = '/workspace/classsite-v4130/';
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
    if (u.includes('/api/content')) return J({ ok: true, items: { announcements: [
      { id: 'a1', text: 'v4.13 更新！内容如下：\n【界面】使用教程改为图文版', date: '2026-11-11 20:00', pinned: true },
    ] } });
    if (u.includes('auth')) return J({ ok: true });
    return J({ ok: true });
  });
}

async function open(opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: opts.width || 412, height: opts.height || 900 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
  await mock(page);
  await page.addInitScript((preset) => {
    try {
      localStorage.setItem('cls_login_guide_v1', '1');
      localStorage.setItem('cls_theme', 'light');
      localStorage.setItem('cls_theme_auto2', 'off');
      if (preset === null) localStorage.removeItem('cls_tour_v1');
      else localStorage.setItem('cls_tour_v1', JSON.stringify(preset));
    } catch (e) {}
  }, opts.preset === undefined ? {
    login: { done: 1 }, home: { done: 1 }, services: { done: 1 }, hwpop: { done: 1 },
    scores: { done: 1 }, big: { done: 1 }, settings: { done: 1 }, files: { done: 1 },
  } : opts.preset);
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(opts.wait || 2600);
  await killPopups(page);
  return { ctx, page, errs };
}

async function killPopups(page) {
  for (const sel of ['.welcome-mask.show button', '#loginGuideMask button:has-text("暂不登录")', '.allboard-mask.show .allboard-head button']) {
    const el = await page.$(sel);
    if (el) { try { await el.click({ timeout: 700 }); await page.waitForTimeout(400); } catch (e) {} }
  }
}

async function walk(page, max = 10) {
  const seq = [];
  for (let i = 0; i < max; i++) {
    const alive = await page.evaluate(() => !!document.querySelector('.tour-title'));
    if (!alive) break;
    const d = await page.evaluate(() => ({
      k: document.querySelector('.tour-kicker').textContent,
      ti: document.querySelector('.tour-title').textContent,
      n: document.querySelectorAll('.tour-dot').length,
      nx: document.querySelector('.tour-next').textContent,
    }));
    seq.push(d.ti);
    if (d.nx === '完成') { await page.click('.tour-next'); break; }
    await page.click('.tour-next');
    await page.waitForTimeout(760);
  }
  return seq;
}

const browser = await chromium.launch({ executablePath: CH, args: ['--no-sandbox'] });

/* ============ A. 入口 ============ */
console.log('\nA. 教程入口');
{
  const { ctx, page, errs } = await open();
  const r = await page.evaluate(() => {
    const g = (id) => document.getElementById(id);
    const box = (e) => e ? [Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)] : null;
    return { top: box(g('guideBtn')), side: box(g('sideGuideBtn')), sidebar: box(g('sidebar')) };
  });
  t('A1 首页顶部不再有悬浮教程按钮', r.top === null, JSON.stringify(r.top));
  t('A2 侧边栏「使用教程」存在', !!r.side && r.side[0] > 0, JSON.stringify(r.side));
  t('A3 侧边栏带 data-topic=more', await page.evaluate(() => document.getElementById('sidebar').getAttribute('data-topic') === 'more'));
  t('A4 首屏无脚本报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.evaluate(() => { const f = document.querySelector('.fab'); if (f) f.click(); });
  await page.waitForTimeout(600);
  await page.click('#sideGuideBtn');
  await page.waitForTimeout(1200);
  t('A5 点侧边栏进入 guide.html', /guide\.html$/.test(page.url()), page.url());
  await ctx.close();
}

/* ============ B. 教程页 ============ */
console.log('\nB. 教程页');
{
  const ctx = await browser.newContext({ viewport: { width: 412, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
  await page.goto(GUIDE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(900);

  const s = await page.evaluate(() => ({
    secs: document.querySelectorAll('section.card').length,
    topics: [...new Set([...document.querySelectorAll('[data-topic]')].map((e) => e.getAttribute('data-topic')))].length,
    imgs: document.querySelectorAll('figure img').length,
    toc: document.querySelectorAll('.toc a').length,
    sign: /签到/.test(document.body.textContent),
    dark: getComputedStyle(document.querySelector('section.card')).backgroundColor,
  }));
  t('B1 共 11 章', s.secs === 11, String(s.secs));
  t('B2 教程条目 32 个', s.topics === 32, String(s.topics));
  t('B3 截图 13 张', s.imgs === 13, String(s.imgs));
  t('B4 目录 11 项', s.toc === 11, String(s.toc));
  t('B5 教程里不再出现「签到」', s.sign === false);
  t('B6 无脚本报错', errs.length === 0, errs.slice(0, 2).join(' | '));

  /* 图片真实可解码：逐张滚到视口里触发 lazy 加载，再统计 */
  {
    const n = await page.evaluate(() => document.querySelectorAll('figure img').length);
    for (let i = 0; i < n; i++) {
      await page.evaluate((k) => {
        document.querySelectorAll('figure img')[k].scrollIntoView({ block: 'center' });
      }, i);
      await page.waitForTimeout(320);
    }
    await page.waitForTimeout(800);
  }
  const broken = await page.evaluate(() => [...document.querySelectorAll('figure img')]
    .filter((i) => !i.naturalWidth)
    .map((i) => i.getAttribute('src')));
  t('B7 截图全部可解码', broken.length === 0, broken.slice(0, 3).join(','));

  /* 搜索 */
  await page.fill('#q', '作业');
  await page.waitForTimeout(400);
  const hit = await page.evaluate(() => ({
    shown: [...document.querySelectorAll('.item')].filter((x) => !x.classList.contains('no-hit')).length,
    cards: [...document.querySelectorAll('section.card')].filter((x) => !x.classList.contains('no-hit')).length,
  }));
  t('B8 搜索「作业」有结果且收窄了章节', hit.shown >= 3 && hit.cards < 11, JSON.stringify(hit));
  await page.fill('#q', '');
  await page.waitForTimeout(300);
  const all = await page.evaluate(() => [...document.querySelectorAll('.item')].filter((x) => !x.classList.contains('no-hit')).length);
  t('B9 清空搜索恢复全部条目', all === 32, String(all));

  await page.screenshot({ path: OUT + 'guide-mobile.png' });
  await ctx.close();
}

/* ============ C. 首页导览 ============ */
console.log('\nC. 首页导览');
{
  const { ctx, page, errs } = await open({ preset: null });
  let shown = false;
  for (let i = 0; i < 24; i++) { if (await page.$('.tour-hole')) { shown = true; break; } await page.waitForTimeout(500); }
  t('C1 首次进入自动出现导览', shown);

  const first = await page.evaluate(() => ({
    ti: document.querySelector('.tour-title').textContent,
    n: document.querySelectorAll('.tour-dot').length,
  }));
  t('C2 第一步是班级岛', first.ti === '班级岛', first.ti);
  t('C3 首页共 8 步', first.n === 8, String(first.n));

  const seq = await walk(page, 10);
  t('C4 顺序与首页一致', seq.join('|') === '班级岛|班级公告|今日班级签|每日日报|每日一言|学习卡片|倒计时|侧边栏', seq.join('|'));
  t('C5 不含「签到」步骤', seq.indexOf('签到') < 0);
  await page.waitForTimeout(500);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('cls_tour_v1') || '{}'));
  t('C6 走完后记录 done', !!(st.home && st.home.done), JSON.stringify(st.home));
  t('C7 无脚本报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

/* ============ D. 板块导览 ============ */
console.log('\nD. 板块导览');
{
  const { ctx, page, errs } = await open({ preset: { login: { done: 1 }, home: { done: 1 } } });

  await page.evaluate(() => openCat(1));
  await page.waitForTimeout(1800);
  const svc = await walk(page, 6);
  t('D1 常用服务 2 步', svc.join('|') === '点歌平台|作业查看', svc.join('|'));

  await page.evaluate(() => openCat(1));
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    document.querySelectorAll('#tab-cat-1 .card-fold').forEach((c) => c.classList.add('open'));
    const b = [...document.querySelectorAll('#tab-cat-1 button')].find((x) => /查看当前作业/.test(x.textContent));
    if (b) b.click();
  });
  await page.waitForTimeout(2200);
  const hw = await walk(page, 6);
  t('D2 作业弹窗 3 步', hw.length === 3 && hw[0] === '期次与日期', hw.join('|'));
  await page.screenshot({ path: OUT + 'tour-hwpop.png' });

  await page.evaluate(() => { if (typeof closeHwCurrent === 'function') closeHwCurrent(); openCat(3); });
  await page.waitForTimeout(2400);
  const sc = await walk(page, 6);
  t('D3 成绩分析至少 2 步且首步为成绩来源', sc.length >= 2 && sc[0] === '成绩来源', sc.join('|'));

  await page.evaluate(() => openSettings());
  await page.waitForTimeout(1600);
  const set = await walk(page, 8);
  t('D4 设置 6 步', set.length === 6 && set[5] === '帮助', set.join('|'));

  await page.evaluate(() => { closeSettings(); openFiles(); });
  await page.waitForTimeout(1600);
  const fl = await walk(page, 6);
  t('D5 文件中转站 3 步', fl.length === 3 && fl[2] === '取件', fl.join('|'));

  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('cls_tour_v1') || '{}'));
  t('D6 各场景分别记录完成', ['services', 'hwpop', 'scores', 'settings', 'files'].every((k) => st[k] && st[k].done), Object.keys(st).join(','));
  t('D7 无脚本报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

/* ============ E. 大屏导览 ============ */
console.log('\nE. 大屏导览');
{
  const { ctx, page } = await open({ width: 1440, height: 810, preset: { login: { done: 1 }, home: { done: 1 } } });
  await page.evaluate(() => { localStorage.setItem('cls_bigscreen', '1'); });
  await page.evaluate(() => { if (typeof bigToggle === 'function' && !(window.BIG && BIG.on)) bigToggle(); });
  await page.waitForTimeout(2400);
  const big = await walk(page, 6);
  t('E1 大屏 3 步', big.join('|') === '顶部导航|功能分组|进入功能', big.join('|'));
  await ctx.close();
}

/* ============ F. 帮助页签 ============ */
console.log('\nF. 设置「帮助」页签');
{
  const { ctx, page } = await open();
  await page.evaluate(() => openSettings());
  await page.waitForTimeout(1200);
  await page.evaluate(() => uiSec('help'));
  await page.waitForTimeout(800);
  const s = await page.evaluate(() => ({
    txt: document.getElementById('uiSetBody').textContent.replace(/\s+/g, ' '),
    rows: document.querySelectorAll('#uiSetBody .up-row').length,
  }));
  t('F1 显示总体进度「已完成 8 / 8 段」', /8 \/ 8 段已完成/.test(s.txt), s.txt.slice(0, 80));
  t('F2 逐段列出 8 项 + 1 行总体 = 9 行', s.rows === 9, String(s.rows));
  t('F3 列出八个板块名', ['登录', '首页', '常用服务', '作业弹窗', '成绩分析', '大屏模式', '全站设置', '文件中转站'].every((k) => s.txt.indexOf(k) >= 0));
  await page.screenshot({ path: OUT + 'settings-help.png' });
  await ctx.close();
}

await browser.close();
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
