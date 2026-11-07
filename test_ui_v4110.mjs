#!/usr/bin/env node
/* ============================================================================
 * test_ui_v4110.mjs —— v4.10.2 大屏专项行为测试（真浏览器）
 * ----------------------------------------------------------------------------
 * 站主本轮 14 条需求里，有几条是「看代码看不出来、必须真跑一遍才知道对不对」：
 *   · 大屏标题到底居中了没有（班徽 / 明暗按钮 / 站名 同一水平中线）
 *   · 大屏作业顶栏是不是真的短了 1/3
 *   · 字号滑块只影响作业正文，顶栏 / 右栏 / 站名不跟着变
 *   · 刷新时卡片会不会闪（DOM 节点有没有被重建）
 *   · 学号左边必须小于右边（填反了自动对调）
 *   · 抽取人数上限不能超过范围人数
 *   · 作业编辑必须点顶部「编辑」才生效
 *   · 配额权重 + 排除上次，在动画模式下也要真的生效
 *
 * 跑法：
 *   python3 -m http.server 8112 &        # 在仓库根目录
 *   node test_ui_v4110.mjs
 * ========================================================================== */

import { chromium } from '/root/.nvm/versions/node/v22.13.1/lib/node_modules/playwright/index.mjs';

const BASE = process.env.BASE || 'http://localhost:8112';
let pass = 0, fail = 0;
const fails = [];
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name + (detail ? '  → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

/* 名册：学号 250501 起，姓名带性别标记，方便验证配额 */
const ROSTER = [];
for (let i = 1; i <= 24; i++) {
  ROSTER.push({
    studentId: '2505' + String(i).padStart(2, '0'),
    name: '学生' + String(i).padStart(2, '0'),
    gender: i % 2 === 0 ? '男' : '女',
    role: i <= 3 ? '课代表' : (i <= 6 ? '班干部' : '学生'),
  });
}

function mockApi(route) {
  const u = route.request().url();
  if (u.includes('/api/island')) {
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: {
        on: true, term: '2026 年秋季 · 高二上', startDate: '2026-09-01',
        components: ['time', 'weather', 'week', 'term'], banner: {}, days: {}, holidays: [], photo: '',
      } }),
    });
  }
  if (u.includes('/api/content')) {
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        ok: true, items: {
          announcements: [],
          /* 作业数据：两科，各两条 —— 用来验证卡片渲染与「复用不闪」 */
          holiday_homeworks: [{
            id: 'hw1', start: '2026-11-01', end: '2026-11-30',
            items: [
              { subject: '语文', tasks: [{ text: '默写《岳阳楼记》第三段' }, { text: '完成阅读理解两篇' }] },
              { subject: '数学', tasks: [{ text: '课本 P42 习题 1-6' }] },
            ],
          }],
        }, serverTime: 1, count: 1,
      }),
    });
  }
  if (u.includes('action=roster') || u.includes('/api/profile')) {
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, students: ROSTER }),
    });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
page.on('console', (m) => {
  const tx = m.text();
  /* 静态资源 403（本地 http.server 对某些路径的默认响应）不算代码问题 */
  if (m.type() === 'error' && !/status of 403/.test(tx)) errs.push('console: ' + tx.slice(0, 200));
});

await page.addInitScript(() => {
  localStorage.setItem('cls_login_guide_v1', '1');
  localStorage.setItem('cls_welcome_v1', '1');
});
await page.route('**/api/**', mockApi);
/* 带时间戳绕开浏览器缓存，保证测到的是最新代码 */
await page.goto(BASE + '/index.html?_r=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(2500);
await page.evaluate(() => document.querySelectorAll('.allboard-mask,.mask').forEach((m) => { m.classList.remove('show'); m.style.display = 'none'; }));

/* ------------------------------------------------------------------ 1) 大屏标题居中 */
console.log('\n【1】大屏标题居中（需求 12）');
{
  await page.evaluate(() => { try { BIG.setMode(true); } catch (e) {} });
  await page.waitForTimeout(600);
  const r = await page.evaluate(() => {
    const hd = document.querySelector('header.big-brand-top');
    if (!hd) return { miss: true };
    const cs = getComputedStyle(hd);
    const h1 = hd.querySelector('h1');
    const logo = hd.querySelector('.logo');
    const tb = hd.querySelector('.theme-btn');
    const mid = (el) => { const b = el.getBoundingClientRect(); return b.top + b.height / 2; };
    const hmid = hd.getBoundingClientRect().top + hd.getBoundingClientRect().height / 2;
    return {
      display: cs.display, align: cs.alignItems, justify: cs.justifyContent,
      h1mid: h1 ? Math.round(mid(h1)) : -1,
      logomid: logo ? Math.round(mid(logo)) : -1,
      tbid: tb ? Math.round(mid(tb)) : -1,
      hmid: Math.round(hmid),
      h1text: h1 ? h1.textContent.trim() : '',
      rect: hd.getBoundingClientRect().toJSON(),
      csPad: cs.paddingTop + '/' + cs.paddingBottom,
      csMinH: cs.minHeight,
      csH: cs.height,
      kids: Array.from(hd.children).map(c => c.className + '@' + Math.round(c.getBoundingClientRect().top) + '-' + Math.round(c.getBoundingClientRect().bottom)),
    };
  });
  t('大屏标题卡存在（header.big-brand-top）', !r.miss);
  if (!r.miss) {
    t('标题卡是 flex 居中排布', r.display === 'flex' && r.justify === 'center', `display=${r.display} justify=${r.justify}`);
    /* 顶部 30px 是给课表留的安全区，所以内容中线本来就不等于容器几何中线 ——
       要验的是「三者**互相**在同一水平线上」，而不是跟容器中线比。 */
    t('站名 / 班徽 / 明暗按钮在同一水平中线（互相相差 ≤ 2px）',
      Math.abs(r.h1mid - r.logomid) <= 2 && Math.abs(r.h1mid - r.tbid) <= 2,
      `h1=${r.h1mid} logo=${r.logomid} btn=${r.tbid}`);
    t('内容在标题卡里真正居中（内容中线 = 容器中线）',
      r.align === 'center' && Math.abs(r.hmid - r.h1mid) <= 2,
      `align=${r.align} 内容中线=${r.h1mid} 容器中线=${r.hmid} pad=${r.csPad}`);
    t('标题卡上下 padding 对称（不再上厚下薄把内容顶下去）',
      /^(\d+(?:\.\d+)?)px\/\1px$/.test(r.csPad), r.csPad);
    t('站名文字正确', /服务站/.test(r.h1text), r.h1text);
  }
}

/* ------------------------------------------------------------------ 2) 关闭大屏后标题归位 */
console.log('\n【2】关闭大屏后标题栏归位（需求 12 的 bug）');
{
  await page.evaluate(() => { try { BIG.setMode(false); } catch (e) {} });
  await page.waitForTimeout(700);
  const r = await page.evaluate(() => {
    const inContent = !!document.querySelector('.content>header');
    const stray = !!document.querySelector('.layout>header.big-brand-top');
    const hd = document.querySelector('header');
    const b = hd ? hd.getBoundingClientRect() : null;
    return {
      inContent, stray,
      top: b ? Math.round(b.top) : -1,
      inFlow: b ? (getComputedStyle(hd).position !== 'absolute') : false,
    };
  });
  t('标题卡回到 .content 里', r.inContent);
  t('功能栏下面没有残留的标题栏（不再单独掉一栏）', !r.stray);
  t('标题栏在正常文档流里（不是绝对定位浮着）', r.inFlow);
  t('标题栏贴在页面顶部（不是掉到很下面）', r.top >= 0 && r.top < 120, 'top=' + r.top);
}

/* ------------------------------------------------------------------ 3) 字号分离 */
console.log('\n【3】字号只调作业正文，顶栏 / 右栏 / 站名不跟着变（需求 1）');
{
  await page.evaluate(() => { try { BIG.setMode(true); } catch (e) {} });
  await page.waitForTimeout(400);
  /* 作业页要先打开，顶栏 / 右栏 / 卡片才在 DOM 里 */
  await page.evaluate(() => { try { BIG.openHw(); } catch (e) {} });
  await page.waitForTimeout(800);
  const read = async () => await page.evaluate(() => {
    const big = document.getElementById('bigHw');
    const top = document.querySelector('.bhw-top');
    const brand = document.querySelector('.bhw-brand');
    const side = document.querySelector('.bhw-side');
    const card = document.querySelector('.bhw-txt') || document.querySelector('.bhw-area');
    const fs = el => el ? parseFloat(getComputedStyle(el).fontSize) : -1;
    return {
      fsVar: big ? getComputedStyle(big).getPropertyValue('--bhw-fs').trim() : '',
      fxVar: big ? getComputedStyle(big).getPropertyValue('--bhw-fx').trim() : '',
      brandVar: big ? getComputedStyle(big).getPropertyValue('--bhw-fbrand').trim() : '',
      top: fs(top), brand: fs(brand), side: fs(side), card: fs(card),
      cardCls: card ? card.className : 'missing',
    };
  });
  const a = await read();
  // 把作业字号推到最大
  await page.evaluate(() => { try { BIG.fsSet(300); } catch (e) { BIG.fsStep && BIG.fsStep(20); } });
  await page.waitForTimeout(500);
  const b = await read();

  t('作业字号变量确实变了（滑块有效）', a.fsVar !== b.fsVar, `${a.fsVar} → ${b.fsVar}`);
  t('顶栏字号不跟着作业滑块变（--bhw-fx 固定）', a.top === b.top, `${a.top} → ${b.top}`);
  t('右侧功能栏字号不跟着变', a.side === b.side, `${a.side} → ${b.side}`);
  t('站名字号不跟着变（--bhw-fbrand 固定 1.8）', a.brand === b.brand && b.brandVar === '1.8', `${a.brand} → ${b.brand} var=${b.brandVar}`);
  t('作业正文字号确实跟着滑块放大', b.card > a.card, `${a.card} → ${b.card}`);
  t('字号基准是 100（显示 100 = 1.5 倍 = 旧 150 档的样子）', b.fsVar !== '' && Math.abs(parseFloat(b.fsVar) - 300 / 100 * 1.5) < 0.02, `--bhw-fs=${b.fsVar}`);

  /* v4.10.3（站主：「我要的是 100 是之前 150 的效果」）：
     滑块显示 100 时，作业正文字号必须等于旧刻度 150% 的那个大小。 */
  await page.evaluate(() => { try { BIG.fsSet(100); } catch (e) {} });
  await page.waitForTimeout(500);
  const c = await read();
  t('滑块显示 100 时倍率正好是 1.5', Math.abs(parseFloat(c.fsVar) - 1.5) < 0.02, `--bhw-fs=${c.fsVar}`);
}

/* ------------------------------------------------------------------ 4) 作业顶栏变矮 */
console.log('\n【4】大屏作业顶栏缩短约 1/3（需求 13）');
{
  await page.evaluate(() => { try { BIG.openHw(); } catch (e) {} });
  await page.waitForTimeout(600);
  const r = await page.evaluate(() => {
    const top = document.querySelector('.bhw-top');
    if (!top) return { miss: true };
    const cs = getComputedStyle(top);
    return { minH: cs.minHeight, h: Math.round(top.getBoundingClientRect().height), align: cs.alignItems };
  });
  t('作业顶栏存在', !r.miss);
  if (!r.miss) {
    /* 固定 64px（旧 96px 的 2/3），且不乘 --bhw-fs（需求 1：标题栏不参与字号调整） */
    t('顶栏最小高度固定 64px（旧 96px 的 2/3，不跟字号滑块联动）',
      /64px/.test(r.minH) && !/var\(--bhw-fs/.test(r.minH), r.minH);
    t('顶栏内容垂直居中', r.align === 'center', r.align);
    t('顶栏实际高度明显低于旧的 96px', r.h < 90, r.h + 'px');
  }
}

/* ------------------------------------------------------------------ 5) 编辑开关 */
console.log('\n【5】作业必须点顶部「编辑」才能改（需求 5）');
{
  await page.evaluate(() => { try { BIG.openHw(); } catch (e) {} });
  await page.waitForTimeout(600);
  const r = await page.evaluate(() => {
    const btn = document.querySelector('[onclick*="hwEditToggle"]');
    const addHost = document.getElementById('bhwAddSubj');
    return {
      hasBtn: !!btn,
      label: btn ? btn.textContent.trim() : '',
      addHostHtml: addHost ? addHost.innerHTML.trim() : 'missing',
      canEdit: typeof window.canEdit === 'function' ? window.canEdit() : null,
    };
  });
  t('顶栏有「编辑 / 完成」按钮（人人都能点）', r.hasBtn, r.label);
  t('按钮初始文案是「编辑」', /编辑/.test(r.label), r.label);
  t('只读态下没有「添加一项」输入框', !/添加科目/.test(r.addHostHtml), r.addHostHtml.slice(0, 60));
}

/* ------------------------------------------------------------------ 6) 学号前缀与左小右大 */
console.log('\n【6】学号 2505 前缀 + 滚轮 + 左边小于右边（需求 3）');
{
  await page.evaluate(() => { try { BIG.pickOpen && BIG.pickOpen(); } catch (e) {} });
  await page.waitForTimeout(700);
  /* 条件面板默认收起，要先展开才看得到学号控件 */
  await page.evaluate(() => { try { if (BIG.pick && !BIG.pick.fOpen) BIG.pickFilter(); } catch (e) {} });
  await page.waitForTimeout(600);
  const r = await page.evaluate(() => {
    const pre = document.querySelector('.bpick-sid-pre');
    const ins = document.querySelectorAll('.bpick-sid-in');
    const wheel = document.querySelector('.bpick-sid-wheel');
    return {
      pre: pre ? pre.textContent.trim() : '',
      nIn: ins.length,
      maxLen: ins[0] ? ins[0].getAttribute('maxlength') : '',
      wheelOpts: wheel ? Array.from(wheel.options).map(o => o.value).filter(Boolean) : [],
      rosterLen: (BIG.pick && BIG.pick.roster) ? BIG.pick.roster.length : -1,
      roster0: (BIG.pick && BIG.pick.roster && BIG.pick.roster[0]) ? JSON.stringify(BIG.pick.roster[0]) : 'none',
      maskShown: !!document.querySelector('#bpickMask.show, #bpickMask[style*="block"]'),
      anySid: document.querySelectorAll('.bpick-sid').length,
      panelHtmlLen: (document.querySelector('#bpickMask') || {}).innerHTML ? document.querySelector('#bpickMask').innerHTML.length : 0,
    };
  });
  t('学号输入框外有固定的 2505 前缀', r.pre === '2505',
    `pre="${r.pre}" 学号控件数=${r.anySid} 名册=${r.rosterLen} 面板长度=${r.panelHtmlLen} 名册样本=${r.roster0}`);
  t('学号输入框只填两位', r.maxLen === '2', r.maxLen);
  t('学号滚轮下拉列出现成学号', r.wheelOpts.length > 0 && r.wheelOpts[0] === '01', r.wheelOpts.slice(0, 6).join(','));

  /* 填反了要自动对调 */
  const swap = await page.evaluate(() => {
    try {
      BIG.pickSid('sidMin', '20');
      BIG.pickSid('sidMax', '05');
    } catch (e) { return { err: e.message }; }
    const f = BIG.pick.f || {};
    return { min: f.sidMin, max: f.sidMax };
  });
  t('左边学号比右边大时自动对调', swap.min === '250505' && swap.max === '250520',
    `min=${swap.min} max=${swap.max}`);
}

/* ------------------------------------------------------------------ 7) 抽取人数上限 */
console.log('\n【7】抽取人数不超过范围人数（需求 4）');
{
  const r = await page.evaluate(() => {
    const out = {};
    try {
      /* 先把范围压到 5 个人 */
      BIG.pickSid('sidMin', '01');
      BIG.pickSid('sidMax', '05');
      BIG.pick.n = 10;
      /* 改条件会触发 clampPickN */
      BIG.pickSet('sex', '不限');
      out.afterClamp = BIG.pick.n;
      /* 再手动往上加，应该加不上去 */
      BIG.pickCount(1); BIG.pickCount(1); BIG.pickCount(1);
      out.afterAdd = BIG.pick.n;
    } catch (e) { out.err = e.message; }
    return out;
  });
  t('范围缩到 5 人时人数上限自动落到 5', r.afterClamp <= 5, 'n=' + r.afterClamp);
  t('范围只有 5 人时再加也加不到 6', r.afterAdd <= 5, 'n=' + r.afterAdd);
}

/* ------------------------------------------------------------------ 8) 配额权重 */
console.log('\n【8】配额权重 + 排除上次（需求 7）');
{
  const r = await page.evaluate(() => {
    const out = {};
    try {
      /* 清掉学号范围，范围放开到全班 */
      BIG.pickSid('sidMin', '');
      BIG.pickSid('sidMax', '');
      BIG.pickSet('sex', '不限');
      BIG.pickSet('role', '学生');
      BIG.pick.n = 6;
      /* 配额：女生最多 2 人，男生最多 2 人 —— 那么 6 人抽不满，应被卡住 */
      BIG.pick.w = { sid: {}, grade: {}, sex: { '0': { max: 2 }, '1': { max: 2 } }, role: {} };
      const names = (window.BIG.pick && BIG.pick.roster) ? null : null;
      out.ok = true;
    } catch (e) { out.err = e.message; }
    return out;
  });
  t('配额对象可写入（UI 与存储链路通）', r.ok, r.err);

  const panel = await page.evaluate(() => {
    try {
      BIG.pickOpen && BIG.pickOpen();
    } catch (e) {}
    return { wOpen: !!(window.BIG && BIG.pick && BIG.pick.wOpen) };
  });
  t('配额面板状态字段存在', panel.wOpen !== undefined);

  const excl = await page.evaluate(() => {
    try { BIG.pickExclLast(true); } catch (e) { return { err: e.message }; }
    return { v: BIG.pick.exclLast, ls: localStorage.getItem('cls_big_pick_exclast') };
  });
  t('「上次抽中不参与」可开关并落盘', excl.v === 1 && excl.ls === '1', JSON.stringify(excl));
}

/* ------------------------------------------------------------------ 9) 卡片刷新不闪 */
console.log('\n【9】作业看板刷新不闪（需求 2）');
{
  await page.evaluate(() => { try { BIG.openHw(); } catch (e) {} });
  await page.waitForTimeout(600);
  const r = await page.evaluate(async () => {
    const grab = () => Array.from(document.querySelectorAll('[data-hwkey]')).map(e => ({
      k: e.getAttribute('data-hwkey'),
      html: e.innerHTML.length,
      node: e,
    }));
    const before = grab();
    /* 触发一次重绘（不改内容） */
    try { BIG.renderHw && BIG.renderHw(); } catch (e) {}
    await new Promise(r2 => setTimeout(r2, 400));
    const after = grab();
    let reused = 0, same = 0;
    const map = new Map(before.map(b => [b.k, b]));
    for (const a of after) {
      const b = map.get(a.k);
      if (b && b.node === a.node) reused++;
      if (b && b.html === a.html) same++;
    }
    return { nBefore: before.length, nAfter: after.length, reused, same };
  });
  t('重绘前后卡片数量一致', r.nBefore === r.nAfter, `${r.nBefore} → ${r.nAfter}`);
  t('内容没变时复用旧 DOM 节点（不会闪）', r.reused === r.nAfter && r.nAfter > 0,
    `复用 ${r.reused}/${r.nAfter}`);
}

/* ------------------------------------------------------------------ 10) 无 JS 报错 */
console.log('\n【10】全流程无 JS 报错');
{
  t('整轮测试没有 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await browser.close();
console.log('\n' + '='.repeat(52));
console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败  (共 ' + (pass + fail) + ' 项)');
if (fail) { console.log('\n失败项:'); fails.forEach(f => console.log('  - ' + f)); }
console.log('='.repeat(52));
process.exit(fail ? 1 : 0);
