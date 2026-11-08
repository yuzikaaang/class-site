/* v4.10.21 专项：复查 v4.10.20 后修的几处问题，逐条做实机验证。
   ① 多期导出：同一张图出现在两期，两期都要保留
   ② 导出清单：本机未上传的作业 / 正在看的自动期次都要能进
   ③ 首屏主题：sun 档按真实日出日落判定，不误闪 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const SITE = process.env.CLS_SITE || 'http://localhost:8111/index.html';
const CH = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const OUT = '/workspace/classsite-v41021/';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const t = (n, ok, x) => {
  if (ok) { pass++; console.log('  ✓ ' + n + (x ? '  [' + x + ']' : '')); }
  else { fail++; console.log('  ✗ ' + n + (x ? '  [' + x + ']' : '')); }
};
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const b = await chromium.launch({ executablePath: CH, args: ['--no-sandbox'] });

function mockApi(p) {
  return p.route('**/api/**', (r) => {
    const u = r.request().url();
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.includes('/auth?action=me')) return J({ ok: true, user: null });
    if (u.includes('/api/content')) return J({ ok: true, items: { holiday_homeworks: [], announcements: [] } });
    if (u.includes('/boards')) return J({ ok: true, url: 'https://example.com/x' });
    return J({ ok: true });
  });
}

/* ---------- ① + ② 导出数据源与跨期同图 ---------- */
{
  const c = await b.newContext({ viewport: { width: 1400, height: 900 } });
  const p = await c.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  await mockApi(p);
  await p.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(2000);

  /* 本机未上传的那份，与云端旧数据故意不同 */
  await p.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('cls_hw_local_v1', JSON.stringify({
      at: Date.now(),
      list: [{ id: 'local-new', title: '本机改的', start: '2026-11-09', end: '2026-11-13',
        items: [{ subject: '数学', tasks: [{ text: '本机未上传的内容' }] }] }]
    }));
  });
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1800);

  const src = await p.evaluate(() => {
    SITE_DATA.holidayHomeworks = [{ id: 'cloud-old', title: '云端旧的', start: '2026-11-02', end: '2026-11-06',
      items: [{ subject: '语文', tasks: [{ text: '云端旧内容' }] }] }];
    const ex = hwExportPeriods().map((x) => x.id);
    window.__HW_VIEWING = { id: 'auto-x', start: '2026-11-16', end: '2026-11-20',
      items: [{ subject: '物理', tasks: [{ text: '自动期次内容' }] }] };
    const ex2 = hwExportPeriods().map((x) => x.id);
    return { ex, ex2 };
  });
  t('① 导出清单用本机未上传的版本（不是云端旧的）', src.ex.includes('local-new') && !src.ex.includes('cloud-old'), JSON.stringify(src.ex));
  t('② 正在看的自动期次能补进导出清单', src.ex2.includes('auto-x'), JSON.stringify(src.ex2));

  /* ③ 两期用同一张图：导出结构里应保留 2 张 */
  const multi = await p.evaluate(async (png) => {
    window.__HW_VIEWING = null;
    const hw1 = { id: 'p1', title: '第10周', start: '2026-11-02', end: '2026-11-06',
      items: [{ subject: '语文', tasks: [{ text: '同一张图', img: png }] }] };
    const hw2 = { id: 'p2', title: '第11周', start: '2026-11-09', end: '2026-11-13',
      items: [{ subject: '英语', tasks: [{ text: '同一张图', img: png }] }] };
    SITE_DATA.holidayHomeworks = [hw1, hw2];
    hwExportBuild([hw1, hw2], 'download');
    await new Promise((r) => setTimeout(r, 2000));
    const card = window.EX && EX.card;
    if (!card) return { err: 'EX.card 为空' };
    let imgs = 0, heads = [];
    (card.sections || []).forEach((s) => {
      (s.rows || []).forEach((r) => (r.media || []).forEach((m) => { if (m.kind === 'image') imgs++; }));
      (s.media || []).forEach((m) => { if (m.kind === 'image') imgs++; });
      heads.push(String(s.heading || ''));
    });
    return { imgs, heads, title: card.title };
  }, PNG);
  t('③ 多期同图各留一份（2 张，不是 1 张）', multi.imgs === 2, JSON.stringify({ imgs: multi.imgs, title: multi.title }));
  t('④ 多期有分隔标题（第10周 / 第11周都在）',
    (multi.heads || []).some((h) => h.indexOf('第10周') >= 0) && (multi.heads || []).some((h) => h.indexOf('第11周') >= 0),
    JSON.stringify(multi.heads));

  /* ⑤ 关闭多选弹窗后，页面里不留空壳 */
  const shell = await p.evaluate(() => {
    document.querySelectorAll('#hwExPickHost,#hwExPickMask').forEach((el) => el.remove());
    const hw1 = { id: 'q1', title: 'A', start: '2026-11-02', end: '2026-11-06', items: [{ subject: '语文', tasks: [{ text: 'x' }] }] };
    const hw2 = { id: 'q2', title: 'B', start: '2026-11-09', end: '2026-11-13', items: [{ subject: '数学', tasks: [{ text: 'y' }] }] };
    SITE_DATA.holidayHomeworks = [hw1, hw2];
    hwExportPick([hw1, hw2], 'download');
    const opened = !!document.getElementById('hwExPickHost');
    hwExportPickClose();
    return { opened, left: document.querySelectorAll('#hwExPickHost,#hwExPickMask').length };
  });
  t('⑤ 多选弹窗能开、关闭后不留空壳', shell.opened && shell.left === 0, JSON.stringify(shell));
  t('⑥ 导出流程无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await p.screenshot({ path: OUT + '导出多期同图.png' });
  await c.close();
}

/* ---------- ⑦ 首屏 sun 档判定（只留 head 内联脚本） ---------- */
{
  const cases = [
    { name: '夏季 18:30（日落 19:24，应亮）', iso: '2026-07-15T18:30:00+08:00', want: false },
    { name: '夏季 20:00（已日落，应暗）', iso: '2026-07-15T20:00:00+08:00', want: true },
    { name: '冬季 18:00（日落 17:46，应暗）', iso: '2026-01-15T18:00:00+08:00', want: true },
    { name: '冬季 12:00（正午，应亮）', iso: '2026-01-15T12:00:00+08:00', want: false },
  ];
  for (const cs of cases) {
    const c = await b.newContext({ viewport: { width: 1000, height: 700 }, timezoneId: 'Asia/Shanghai' });
    await c.clock.install({ time: new Date(cs.iso) });
    const p = await c.newPage();
    await p.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.evaluate(() => {
      localStorage.setItem('cls_theme_auto2', 'sun');
      localStorage.setItem('cls_theme', 'light');
      localStorage.removeItem('cls_theme_hold');
    });
    for (const f of ['app.min.js', 'big.js', 'auth-bus.js', 'fs-keep.js', 'pickfx.js']) {
      await p.route('**/' + f + '*', (r) => r.abort());
    }
    await p.goto(SITE + '?onlyinline=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForTimeout(500);
    const got = await p.evaluate(() => ({
      dark: document.documentElement.classList.contains('dark'),
      noApp: typeof window.initTheme !== 'function',
    }));
    t('⑦ ' + cs.name, got.dark === cs.want && got.noApp, 'dark=' + got.dark);
    await c.close();
  }
}

console.log('\nv4.10.21 专项：' + pass + ' 通过 / ' + fail + ' 失败');
await b.close();
process.exit(fail ? 1 : 0);
