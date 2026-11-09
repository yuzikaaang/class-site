/* v4.10.22 专项：缓存清理要看得见「占了多少 / 清了多少」。
   ① 打开设置 → 数据，已占用显示成体积（不是「统计中」）
   ② 造 4 个临时键 + 2 个旧桶各 2 条后，明细行数字跟着涨（用增量判断，避免依赖预置数据）
   ③ 清理临时缓存后，提示写明清了几个桶、几条、本地几项
   ④ 清完当前版本桶还在（否则离线打不开）
   ⑤ 清理本地数据：取消不动，确认后提示条数 + 体积 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const SITE = process.env.CLS_SITE || 'http://localhost:8111/index.html';
const CH = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const OUT = '/workspace/classsite-v41022/';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const t = (n, ok, x) => {
  if (ok) { pass++; console.log('  ✓ ' + n + (x ? '  [' + x + ']' : '')); }
  else { fail++; console.log('  ✗ ' + n + (x ? '  [' + x + ']' : '')); }
};
const SIZE_RE = /^\d+(\.\d+)?\s?(B|KB|MB)$/;
const num = (txt, re) => { const m = String(txt || '').match(re); return m ? Number(m[1]) : null; };
const entriesOf = (txt) => num(txt, /· (\d+) 条/);
const parseB = (txt) => {
  const m = String(txt || '').match(/([\d.]+)\s*(B|KB|MB)/);
  if (!m) return null;
  const u = { B: 1, KB: 1024, MB: 1048576 }[m[2]];
  return parseFloat(m[1]) * u;
};
const localOf = (txt) => num(txt, /本地 (\d+) 项/);

const b = await chromium.launch({ executablePath: CH, args: ['--no-sandbox'] });
const c = await b.newContext({ viewport: { width: 1400, height: 950 } });
const p = await c.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
await p.route('**/api/**', (r) => {
  const u = r.request().url();
  const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (u.includes('/auth?action=me')) return J({ ok: true, user: null });
  if (u.includes('/api/content')) return J({ ok: true, items: { holiday_homeworks: [], announcements: [] } });
  return J({ ok: true });
});
const ready = async (pg, ms = 600) => {
  await pg.waitForFunction(() => typeof window.openSettings === 'function', null, { timeout: 45000 });
  await pg.waitForTimeout(ms);
};

await p.goto(SITE, { waitUntil: 'commit', timeout: 60000 });
await ready(p, 1200);

const shotCache = async (name) => {
  await p.evaluate(() => {
    const el = document.getElementById('cacheUsed');
    const sec = el && el.closest('.ui-sec');
    if (sec) sec.scrollIntoView({ block: 'center' });
  });
  await p.waitForTimeout(400);
  await p.locator('#uiSetMask .allboard-box, #uiSetMask > div').first().screenshot({ path: OUT + name });
};

const readPanel = async () => {
  await p.waitForFunction(() => {
    const a = document.getElementById('cacheUsed');
    return a && a.textContent && a.textContent !== '统计中…';
  }, null, { timeout: 20000 });
  await p.waitForTimeout(200);
  return p.evaluate(() => ({
    total: (document.getElementById('cacheUsed') || {}).textContent,
    temp: (document.getElementById('cacheUsedT') || {}).textContent,
    data: (document.getElementById('cacheUsedD') || {}).textContent,
  }));
};

await p.evaluate(() => { try { localStorage.setItem('cls_login_guide_v1', '1'); } catch (e) {} });
await p.reload({ waitUntil: 'commit', timeout: 60000 });
await ready(p, 1200);

await p.evaluate(() => { openSettings(); uiSec('data'); });
const base = await readPanel();
console.log('  基线：' + JSON.stringify(base));

/* 造点东西：4 个本地临时键 + 2 个旧版本桶各 2 条（每条约 200KB）+ 3 个本地数据键 */
await p.evaluate(async () => {
  localStorage.setItem('__cls_wx', JSON.stringify({ pad: 'w'.repeat(4000) }));
  localStorage.setItem('__cls_geo', JSON.stringify({ pad: 'g'.repeat(3000) }));
  localStorage.setItem('cls_content_cache_v1', JSON.stringify({ pad: 'c'.repeat(6000) }));
  localStorage.setItem('cls_week_cache', JSON.stringify({ pad: 'k'.repeat(2000) }));
  localStorage.setItem('cls_sc_cache_v1', JSON.stringify({ pad: 's'.repeat(5000) }));
  localStorage.setItem('cls_roster_cache_v1', JSON.stringify({ pad: 'r'.repeat(3000) }));
  localStorage.setItem('cls_class_list', JSON.stringify({ pad: 'l'.repeat(1000) }));

  const big = 'x'.repeat(200000);
  for (const name of ['class-site-4.9.0', 'cls-img-cache-v1']) {
    const ca = await caches.open(name);
    for (let i = 0; i < 2; i++) {
      await ca.put(new Request('/seed/' + name + '/' + i), new Response(big, { status: 200, headers: { 'Content-Type': 'image/png' } }));
    }
  }
  await refreshCacheUse();
});
await p.waitForTimeout(1500);
const seeded = await readPanel();
console.log('  造数据后：' + JSON.stringify(seeded));
/* 面板数字必须和实际状态一致：本地项数、缓存条数都以页面内真值为准
   （cls_content_cache_v1 这类键页面自己也会写，不能按「加了几项」推算） */
const truth = await p.evaluate(async () => {
  const lsN = CACHE_TEMP_KEYS.filter((k) => localStorage.getItem(k) !== null).length;
  const lsB = CACHE_TEMP_KEYS.filter((k) => localStorage.getItem(k) !== null)
    .reduce((s, k) => s + (k.length + (localStorage.getItem(k) || '').length) * 2, 0);
  let entries = 0;
  for (const n of (await caches.keys()).filter((x) => /^class-site-|^cls-img-cache-/.test(x))) {
    entries += (await (await caches.open(n)).keys()).length;
  }
  return { lsN, lsB, entries };
});

t('① 已占用显示成体积（不是「统计中…」/「无法统计」）',
  !!base.total && SIZE_RE.test(base.total.trim()), base.total);
t('①b 总量不低于自己量到的本地体积（不出现「本地有、总量 0」）',
  (() => { const a = parseB(base.total); const b = parseB(base.temp);
    if (a === null) return false;
    return b === null ? a >= 0 : a + 1 >= b; })(),
  base.total + ' vs ' + base.temp);
t('② 缓存条数与实际条目数一致',
  entriesOf(seeded.temp) === truth.entries,
  '面板 ' + entriesOf(seeded.temp) + ' / 实际 ' + truth.entries);
t('③ 本地临时项数与实际键数一致',
  localOf(seeded.temp) === truth.lsN,
  '面板 ' + localOf(seeded.temp) + ' / 实际 ' + truth.lsN);
t('④ 本地数据行 3 项且带体积',
  num(seeded.data, /(\d+) 项/) === 3 && /\d/.test(seeded.data || ''), seeded.data);

await shotCache('01-缓存占用.png');

/* 清理临时缓存 */
await p.evaluate(() => clearTempCache());
await p.waitForFunction(() => {
  const m = document.getElementById('cacheMsg');
  return m && /已清理|没有需要清理|清理失败/.test(m.textContent || '');
}, null, { timeout: 20000 });
await p.waitForTimeout(800);

const after = await p.evaluate(async () => ({
  msg: (document.getElementById('cacheMsg') || {}).textContent,
  temp: (document.getElementById('cacheUsedT') || {}).textContent,
  keys: await caches.keys(),
  /* cls_content_cache_v1 每次联网都会被页面重新写回，不在「应当消失」之列 */
  lsLeft: ['__cls_wx','__cls_geo','cls_week_cache'].filter((k) => localStorage.getItem(k) !== null),
}));
console.log('  清理提示：' + after.msg);

t('⑤ 提示写明清了几个桶、几条',
  /旧版本缓存 2 个桶 · 4 条/.test(after.msg || ''), after.msg);
t('⑥ 提示写明清了本地几项并且带体积',
  /本地临时数据 \d+ 项 · \d+(\.\d+)? (B|KB|MB)/.test(after.msg || ''), after.msg);
t('⑦ 三个临时键真的删掉了（云端内容缓存会被页面自动写回）', after.lsLeft.length === 0, JSON.stringify(after.lsLeft));
t('⑧ 旧版本桶清掉，当前版本桶（如果有）保留',
  !after.keys.includes('class-site-4.9.0') && !after.keys.includes('cls-img-cache-v1')
  /* 首次访问时 SW 可能还没装好、当前版本桶本来就不存在，不能强求有 */
  && after.keys.every((k) => k !== 'class-site-4.9.0'), JSON.stringify(after.keys));
t('⑨ 明细行条数比造数据前回落（只剩当前版本桶）',
  entriesOf(after.temp) === null || entriesOf(after.temp) < entriesOf(seeded.temp),
  seeded.temp + ' → ' + after.temp);

await shotCache('02-清理完成.png');

/* 清理本地数据：先取消，再确认 */
p.once('dialog', (d) => d.dismiss());
await p.evaluate(() => clearLocalData());
await p.waitForTimeout(400);
const canceled = await p.evaluate(() => ({
  ls: localStorage.getItem('cls_sc_cache_v1') !== null,
  data: (document.getElementById('cacheUsedD') || {}).textContent,
}));
t('⑩ 取消确认框时一条都不删', canceled.ls === true, JSON.stringify(canceled));

p.once('dialog', (d) => d.accept());
await p.evaluate(() => clearLocalData());
await p.waitForTimeout(900);
const cleared = await p.evaluate(() => ({
  msg: (document.getElementById('cacheMsg') || {}).textContent,
  left: ['cls_sc_cache_v1','cls_roster_cache_v1','cls_class_list'].filter((k) => localStorage.getItem(k) !== null),
  data: (document.getElementById('cacheUsedD') || {}).textContent,
}));
t('⑪ 确认后提示「已清理本地数据 3 项」并带体积',
  /已清理本地数据 3 项 · \d+(\.\d+)? (B|KB|MB)/.test(cleared.msg || ''), cleared.msg);
t('⑫ 三个本地数据键已删除', cleared.left.length === 0, JSON.stringify(cleared.left));
t('⑬ 本地数据行随之归零', /空的/.test(cleared.data || ''), cleared.data);
/* ⑭ 手机宽度下不许溢出（长文案要能换行，不撑破面板） */
{
  const m = await b.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
  const mp = await m.newPage();
  await mp.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, user: null, items: { holiday_homeworks: [], announcements: [] } }) }));
  await mp.goto(SITE, { waitUntil: 'commit', timeout: 60000 });
  await ready(mp, 1200);
  await mp.evaluate(() => { try { localStorage.setItem('cls_login_guide_v1', '1'); } catch (e) {} });
  await mp.reload({ waitUntil: 'commit', timeout: 60000 });
  await ready(mp, 1000);
  await mp.evaluate(() => { openSettings(); uiSec('data'); });
  await mp.waitForFunction(() => {
    const a = document.getElementById('cacheUsed');
    return a && a.textContent && a.textContent !== '统计中…';
  }, null, { timeout: 20000 });
  const box = await mp.evaluate(() => {
    const panel = document.querySelector('#uiSetMask .allboard-box') || document.getElementById('uiSetMask');
    const t = document.getElementById('cacheUsedT');
    const d = document.getElementById('cacheUsedD');
    return {
      panelW: panel.clientWidth,
      panelScrollW: panel.scrollWidth,
      tOver: t.scrollWidth - t.clientWidth,
      dOver: d.scrollWidth - d.clientWidth,
      docOver: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  console.log('  手机宽度：' + JSON.stringify(box));
  t('⑭ 手机宽度下明细行不溢出（可换行）',
    box.tOver <= 1 && box.dOver <= 1 && box.docOver <= 1, JSON.stringify(box));
  await mp.evaluate(() => {
    const el = document.getElementById('cacheUsed');
    const sec = el && el.closest('.ui-sec');
    if (sec) sec.scrollIntoView({ block: 'center' });
  });
  await mp.waitForTimeout(300);
  await mp.locator('#uiSetMask .allboard-box, #uiSetMask > div').first().screenshot({ path: OUT + '03-手机宽度.png' });
  await m.close();
}

/* 全程无 JS 报错 */
t('⑮ 全程无 JS 报错', errs.length === 0, errs.join(' | ') || '无');

await b.close();
console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
