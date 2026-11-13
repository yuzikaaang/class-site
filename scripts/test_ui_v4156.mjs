/* v4.15.6 回归：班级岛多行/空格/强调、大屏右栏排版与溢出、后台手机端编辑器、考试可见性 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const EXE = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://127.0.0.1:8899';
const OUT = '/workspace/classsite-v4156';
fs.mkdirSync(OUT, { recursive: true });

const dstr = (() => {
  const d = new Date(); const z = (n) => ('0' + n).slice(-2);
  return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
})();

const ISL_TXT = [
  '#第一节 08:00-08:45 数学',
  '  第二节 08:55-09:40 语文（**重点**）',
  '',
  '第三节 10:00-10:45 英语 {22b听力}',
  '晚自习 19:00-21:30 物理 ~~化学~~',
  '  值日：张三、李四',
].join('\n');

const ISL = {
  on: true, term: '2026 年秋季 · 高二上', startDate: '2026-09-01', endDate: '2027-01-20',
  components: ['time', 'weather', 'week', 'term'],
  banner: {}, days: { [dstr]: { text: ISL_TXT, center: false, bold: true, size: 0 } },
  holidays: [], photo: '',
};

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
}

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

/* ---------------- A. 首页班级岛 ---------------- */
console.log('\n[A] 首页班级岛：一行一块 / 空格 / 空行 / 强调 / 字号');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await p.route('**/api/**', (r) => {
    const u = r.request().url();
    if (u.includes('/api/island')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: ISL }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await p.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2600);
  await p.evaluate(() => { const m = document.getElementById('loginGuideMask'); if (m) m.style.display = 'none'; });

  const info = await p.evaluate(() => {
    const host = document.querySelector('#islBannerRow .txt');
    if (!host) return null;
    const lns = [...host.querySelectorAll('.ln')];
    const pos = lns.map((el) => {
      const tn = el.firstChild;
      if (!tn || tn.nodeType !== 3) return { text: el.textContent, x: null };
      const s = tn.nodeValue, i = s.search(/\S/);
      if (i < 0) return { text: s, x: null };
      const rr = document.createRange(); rr.setStart(tn, i); rr.setEnd(tn, i + 1);
      return { text: s.trim(), x: Math.round(rr.getBoundingClientRect().left) };
    });
    const big = host.querySelector('span[style*="font-size:22px"]');
    return {
      nLn: lns.length,
      nBlank: host.querySelectorAll('.ln-blank').length,
      nEm: host.querySelectorAll('.ln-em').length,
      emText: (host.querySelector('.ln-em') || {}).textContent || '',
      pos,
      bigSize: big ? getComputedStyle(big).fontSize : '',
      nB: host.querySelectorAll('b').length,
      nS: host.querySelectorAll('s').length,
      html: host.innerHTML.slice(0, 300),
    };
  });
  ok('渲染出 6 个行块', info && info.nLn === 6, info && info.nLn);
  ok('保留 1 个空行', info && info.nBlank === 1, info && info.nBlank);
  ok('只有第一行有强调且只包第一行', info && info.nEm === 1 && /^第一节/.test(info.emText.trim()) && !/第二节/.test(info.emText), info && info.emText);
  const x2 = info && info.pos.find((o) => o.text.indexOf('第二节') === 0);
  const x3 = info && info.pos.find((o) => o.text.indexOf('第三节') === 0);
  ok('第二行行首缩进比第三行靠右（空格保留）', !!(x2 && x3) && x2.x - x3.x >= 4, { second: x2, third: x3 });
  ok('{22b} 字号 22px 生效', info && info.bigSize === '22px', info && info.bigSize);
  ok('**粗体** 与 ~~删除线~~ 生效', info && info.nB === 1 && info.nS === 1, info && { b: info.nB, s: info.nS });
  await (await p.$('#classIsland')).screenshot({ path: OUT + '/banner-390.png' });
  await ctx.close();
}

/* ---------------- B. 大屏作业看板右栏 ---------------- */
console.log('\n[B] 大屏作业看板：今日事项同款排版 + 内容过长时整栏不被挤出屏幕');
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  const many = Array.from({ length: 12 }, (_, i) =>
    (i % 4 === 0 ? '# ' : '') + '第' + (i + 1) + '节 0' + (8 + Math.floor(i / 2)) + ':00 数学作业 P' + (30 + i) + '-P' + (36 + i) + '　**重点**：订正错题并交回').join('\n');
  const longIsl = JSON.parse(JSON.stringify(ISL));
  longIsl.days[dstr].text = many;
  await p.route('**/api/**', (r) => {
    const u = r.request().url();
    if (u.includes('/api/island')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: longIsl }) });
    if (u.includes('/auth?action=me')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, user: { id: 4, username: 'aibot', role: 'admin' } }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await p.goto(BASE + '/index.html?big=1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2600);
  await p.evaluate(() => { window.isAdmin = () => true; const m = document.getElementById('loginGuideMask'); if (m) m.style.display = 'none'; window.BIG.openHw(); });
  await p.waitForTimeout(1800);

  const info = await p.evaluate(() => {
    const side = document.getElementById('bhwSide'), inn = document.getElementById('bhwSideIn');
    const c = document.getElementById('bhwCourses');
    const sr = side.getBoundingClientRect();
    const cards = [...inn.children]
      .filter((e) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0)
      .map((e) => e.getBoundingClientRect());
    return {
      tight: side.classList.contains('tight'),
      sideBottom: Math.round(sr.bottom),
      cardsBottom: Math.max(...cards.map((r) => Math.round(r.bottom))),
      vh: innerHeight,
      coursesH: Math.round(c.getBoundingClientRect().height),
      coursesScroll: c.scrollHeight,
      nLn: c.querySelectorAll('.bhw-ln').length,
      nEm: c.querySelectorAll('.bhw-ln.em').length,
      nB: c.querySelectorAll('.bhw-ln b').length,
      emText: (c.querySelector('.bhw-ln.em') || {}).textContent || '',
    };
  });
  ok('长内容触发「压缩今日事项」模式', info.tight === true, info.tight);
  ok('右侧所有卡片都在屏幕内', info.cardsBottom <= info.sideBottom + 1 && info.sideBottom <= info.vh + 1, info);
  ok('今日事项内部可滚动（没有硬截断）', info.coursesScroll > info.coursesH, { h: info.coursesH, sh: info.coursesScroll });
  ok('今日事项按行渲染且有 3 行强调', info.nLn === 12 && info.nEm === 3, { ln: info.nLn, em: info.nEm });
  ok('**重点** 在大屏上变成真加粗', info.nB === 12, info.nB);
  await p.screenshot({ path: OUT + '/big-1366.png' });
  await ctx.close();
}

/* ---------------- C. 后台手机端富文本编辑 ---------------- */
console.log('\n[C] 后台编辑器（390×844 触屏）：整行强调只作用光标行 / 取消 / 加粗 / 字号 / 往返不丢格式');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  let saved = null;
  await p.route('**/api/**', async (r) => {
    const req = r.request(), u = req.url();
    if (u.includes('/api/auth?action=me')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, user: { id: 4, username: 'aibot', displayName: 'AI', role: 'admin', status: 'active', title: '' } }) });
    if (u.includes('/api/island')) {
      if (req.method() === 'POST') { saved = req.postDataJSON(); return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: saved.data }) }); }
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { on: true, term: 'x', startDate: '2026-09-01', endDate: '2027-01-20', components: ['time'], banner: {}, days: {}, holidays: [], photo: '' } }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await p.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => localStorage.setItem('cls_auth', JSON.stringify({ token: 'x', user: { id: 4, username: 'aibot', displayName: 'AI', role: 'admin', status: 'active', title: '' } })));
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(1300);
  await p.evaluate(() => {
    const el = [...document.querySelectorAll('a,button,li,div,span')].find((e) => /班级岛/.test(e.textContent) && e.textContent.trim().length < 20);
    if (el) el.click();
  });
  await p.waitForTimeout(1300);

  await p.locator('#adRich').click();
  await p.keyboard.type('第一行 数学 08:00');
  await p.keyboard.press('Enter');
  await p.keyboard.type('　　第二行 语文 09:00');
  await p.keyboard.press('Enter');
  await p.keyboard.press('Enter');
  await p.keyboard.type('第四行 英语 10:00');
  await p.waitForTimeout(300);

  const caret = async (needle, off) => {
    await p.evaluate(([n, o]) => {
      const box = document.getElementById('adRich');
      const tw = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      let t;
      while ((t = tw.nextNode())) {
        const i = t.nodeValue.indexOf(n);
        if (i >= 0) { const rg = document.createRange(); rg.setStart(t, i + o); rg.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(rg); return; }
      }
    }, [needle, off]);
    await p.waitForTimeout(150);
  };
  const val = () => p.evaluate(() => document.getElementById('adText').value);

  await caret('第四行', 2);
  await p.locator('[data-rt="h"]').tap();
  await p.waitForTimeout(400);
  let v = await val();
  ok('触屏点「整行强调」命中光标所在第 4 行', v.split('\n').filter((l) => l.indexOf('# ') === 0).length === 1 && v.split('\n')[3].indexOf('# ') === 0, v);

  await caret('第二行', 1);
  await p.locator('[data-rt="h"]').tap();
  await p.waitForTimeout(400);
  v = await val();
  ok('再强调第 2 行只加第 2 行', v.split('\n').filter((l) => l.indexOf('# ') === 0).length === 2 && v.split('\n')[1].indexOf('# ') === 0, v);

  await caret('第二行', 1);
  await p.locator('[data-rt="h"]').tap();
  await p.waitForTimeout(400);
  v = await val();
  ok('再点一次取消第 2 行，第 4 行保留', v.split('\n').filter((l) => l.indexOf('# ') === 0).length === 1 && v.split('\n')[3].indexOf('# ') === 0, v);

  await p.evaluate(() => {
    const box = document.getElementById('adRich');
    const tw = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = tw.nextNode())) {
      const i = t.nodeValue.indexOf('英语');
      if (i >= 0) { const rg = document.createRange(); rg.setStart(t, i); rg.setEnd(t, i + 2); const s = getSelection(); s.removeAllRanges(); s.addRange(rg); return; }
    }
  });
  await p.waitForTimeout(200);
  await p.locator('[data-rt="b"]').tap();
  await p.waitForTimeout(400);
  v = await val();
  ok('触屏选中「英语」后加粗生效', v.indexOf('**英语**') >= 0, v);

  await p.evaluate(() => {
    const box = document.getElementById('adRich');
    const tw = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = tw.nextNode())) {
      const i = t.nodeValue.indexOf('数学');
      if (i >= 0) { const rg = document.createRange(); rg.setStart(t, i); rg.setEnd(t, i + 2); const s = getSelection(); s.removeAllRanges(); s.addRange(rg); return; }
    }
  });
  await p.waitForTimeout(200);
  await p.selectOption('#adChSize', '22');
  await p.waitForTimeout(500);
  v = await val();
  ok('触屏选字号 22 只包住「数学」', v.indexOf('{22数学}') >= 0, v);

  const pv = await p.evaluate(() => {
    const el = document.getElementById('adPrev');
    const lns = [...el.querySelectorAll('.ln')];
    return {
      nLn: lns.length,
      nEm: el.querySelectorAll('.ln-em').length,
      emText: (el.querySelector('.ln-em') || {}).textContent || '',
      big: (el.querySelector('span[style*="font-size:22px"]') || {}).textContent || '',
      hasB: !!el.querySelector('b'),
    };
  });
  ok('后台预览：4 行 + 1 个强调行（第 4 行）', pv.nLn === 4 && pv.nEm === 1 && /^第四行/.test(pv.emText.trim()), pv);
  ok('后台预览：22px 与加粗都生效', pv.big === '数学' && pv.hasB, pv);

  await p.fill('#adDate', dstr);
  await p.locator('#adAdd').tap();
  await p.waitForTimeout(1200);
  const t = saved && saved.data && saved.data.days ? saved.data.days[dstr] : null;
  ok('提交内容保留缩进 / 空行 / 字号 / 加粗 / 强调',
    !!t && t.text.indexOf('\n\n') >= 0 && t.text.indexOf('{22数学}') >= 0 && t.text.indexOf('**英语**') >= 0 && t.text.split('\n')[3].indexOf('# ') === 0,
    t && t.text);
  ok('提交内容没有把行首空格吃掉', !!t && t.text.indexOf('\n　　第二行') >= 0, t && JSON.stringify(t.text));

  await p.locator('#adRich').screenshot({ path: OUT + '/editor-mobile.png' });
  await ctx.close();
}

await browser.close();
console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败');
process.exit(fail ? 1 : 0);
