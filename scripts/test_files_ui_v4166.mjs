/* ============================================================================
 * v4.16.6 前端专项：多文件排队 → 确认上传 → 共用取件码 → 取件列表 → 历史
 * ----------------------------------------------------------------------------
 * 后端用 route 拦成一套内存批次，只看前端行为：不点上传不发请求、
 * 第一个文件建码、后面两个挂同一个码、文件名可改而后缀锁死、取件页列全。
 * ========================================================================= */
import { chromium } from 'playwright-core';

const CH = process.env.CHROME || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://127.0.0.1:8899';
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + '  ' + JSON.stringify(x === undefined ? '' : x)); }
};

const b = await chromium.launch({ executablePath: CH, args: ['--no-sandbox'] });
const c = await b.newContext({ viewport: { width: 430, height: 932 }, serviceWorkers: 'block' });
const p = await c.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));

/* ---------------- mock /api/files ---------------- */
const st = { code: '', delKey: '', items: [], ups: [], picked: 0 };
await p.route('**/api/files**', async (r) => {
  const u = new URL(r.request().url());
  const act = u.searchParams.get('action') || '';
  const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (act === 'upb') {
    const name = u.searchParams.get('name') || '';
    const inCode = u.searchParams.get('code') || '';
    const inDel = u.searchParams.get('delKey') || '';
    st.ups.push({ name, code: inCode, delKey: inDel });
    if (inCode && (inCode !== st.code || inDel !== st.delKey)) {
      return r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '删除口令不对' }) });
    }
    if (!inCode) { st.code = 'Q7M4XZ'; st.delKey = 'dkey-1234567'; st.items = []; }
    const id = 'it' + (st.items.length + 1);
    const size = 1024 * (st.items.length + 1);
    st.items.push({ id, name, size });
    return J({ ok: true, code: st.code, delKey: st.delKey, itemId: id, name, size, count: st.items.length, ttl: 3, maxGet: 0, exp: Date.now() + 3 * 864e5 });
  }
  if (act === 'pick') {
    st.picked++;
    return J({
      ok: true, code: st.code, kind: 'files', count: st.items.length, items: st.items,
      ttl: 3, exp: Date.now() + 3 * 864e5, at: Date.now(), maxGet: 0, gets: 1, left: null, ticket: 'tk-abcdef123456',
    });
  }
  if (act === 'quota') return J({ ok: true, used: 0, cap: 1, count: 0 });
  if (act === 'ren') {
    const body = JSON.parse(r.request().postData() || '{}');
    const it = st.items.find((x) => x.id === body.id);
    if (it) it.name = body.name;
    return J({ ok: true, code: st.code, id: body.id, name: body.name });
  }
  return J({ ok: true });
});
await p.route('**/api/island**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"data":{"on":false}}' }));
await p.route('**/api/content**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"items":{}}' }));

await p.addInitScript(() => {
  localStorage.setItem('cls_welcome_v1', '1');
  localStorage.setItem('cls_login_guide_v1', '1');
  localStorage.setItem('cls_tour_v1', JSON.stringify({ login: { done: 1 }, home: { done: 1 }, services: { done: 1 }, files: { done: 1 } }));
  localStorage.removeItem('cls_fl_hist_v1');
});
await p.goto(BASE + '/index.html?_r=' + Date.now(), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2200);
await p.evaluate(() => {
  document.querySelectorAll('.mask.show,[id$="Mask"].show').forEach((m) => m.classList.remove('show'));
  document.querySelectorAll('[class*="tour"]').forEach((e) => e.remove());
  openFiles();
});
await p.waitForTimeout(700);

/* ================= ① 多选入队，不自动上传 ================= */
console.log('① 一次选三个文件：只排队，不上传');
const addRes = await p.evaluate(() => {
  const inp = document.getElementById('flFile');
  const mk = (name, txt) => new File([txt], name, { type: 'text/plain' });
  const dt = new DataTransfer();
  dt.items.add(mk('语文笔记.txt', 'aa'));
  dt.items.add(mk('数学卷子.pptx', 'bbbb'));
  dt.items.add(mk('英语听力.MP3', 'cccccc'));
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  return { multiple: inp.multiple, n: dt.files.length };
});
await p.waitForTimeout(400);
ok('input 支持多选', addRes.multiple === true);
const q1 = await p.evaluate(() => ({
  n: document.querySelectorAll('#flQueue .fl-qitem').length,
  exts: [...document.querySelectorAll('#flQueue .fl-qext')].map((e) => e.textContent.trim()),
  mains: [...document.querySelectorAll('#flQueue .fl-qin')].map((e) => e.value),
  foot: (document.getElementById('flQFoot') || {}).style.display,
  go: (document.getElementById('flQGo') || {}).textContent,
  sum: (document.getElementById('flQSum') || {}).textContent,
}));
ok('队列里 3 行', q1.n === 3, q1.n);
ok('后缀单独显示在框后面', JSON.stringify(q1.exts) === JSON.stringify(['.txt', '.pptx', '.MP3']), q1.exts);
ok('文件名里只剩主名（后缀已剥掉）', JSON.stringify(q1.mains) === JSON.stringify(['语文笔记', '数学卷子', '英语听力']), q1.mains);
ok('底部出现上传按钮', q1.foot !== 'none' && /上传 3 个/.test(q1.go), q1.go);
ok('合计写着「共用一个取件码」', /共 3 个/.test(q1.sum) && /共用一个取件码/.test(q1.sum), q1.sum);
ok('没点上传就一个请求都没发', st.ups.length === 0, st.ups);

/* ================= ② 改文件名 ================= */
console.log('② 改主名：后缀不动');
await p.evaluate(() => {
  const el = document.querySelectorAll('#flQueue .fl-qin')[1];
  el.value = '数学卷子（第 3 章）';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await p.waitForTimeout(200);
const q2 = await p.evaluate(() => ({
  main: document.querySelectorAll('#flQueue .fl-qin')[1].value,
  ext: document.querySelectorAll('#flQueue .fl-qext')[1].textContent.trim(),
}));
ok('主名改过来了', q2.main === '数学卷子（第 3 章）', q2.main);
ok('后缀还是 .pptx', q2.ext === '.pptx', q2.ext);

/* 只剩一个后缀在框里时，输入点号不会带进去 */
const dblExt = await p.evaluate(() => {
  const r = flSplitName('a.b.pdf');
  return [r.main, r.ext];
});
ok('只把最后一段当后缀', dblExt[0] === 'a.b' && dblExt[1] === '.pdf', dblExt);
const noExt = await p.evaluate(() => flSplitName('README'));
ok('没后缀的文件不会被硬造一个', noExt.main === 'README' && noExt.ext === '', noExt);

/* ================= ③ 点上传：一个一个来，共用一码 ================= */
console.log('③ 点「上传」之后才发请求，三个共用一个码');
await p.click('#flQGo');
await p.waitForTimeout(2600);
ok('发了 3 次上传', st.ups.length === 3, st.ups.length);
ok('第一个不带 code', st.ups[0] && st.ups[0].code === '', st.ups[0]);
ok('第二个带第一个的 code', st.ups[1] && st.ups[1].code === 'Q7M4XZ', st.ups[1]);
ok('第三个也带同一个 code', st.ups[2] && st.ups[2].code === 'Q7M4XZ', st.ups[2]);
ok('上传的名字是改过的', st.ups[1].name === '数学卷子（第 3 章）.pptx', st.ups[1].name);
const doneSt = await p.evaluate(() => ({
  pane: (document.getElementById('flDonePane') || {}).style.display,
  code: (document.getElementById('flCode') || {}).textContent,
  list: [...document.querySelectorAll('#flDoneList .fl-dl-i b')].map((e) => e.textContent),
  tip: (document.getElementById('flCodeTip') || {}).textContent,
  upPane: (document.getElementById('flPaneUp') || {}).style.display,
}));
ok('出结果页并显示取件码', doneSt.pane === '' && doneSt.code === 'Q7M4XZ', doneSt);
ok('结果页列出 3 个文件', doneSt.list.length === 3, doneSt.list);
ok('结果页用的是改过的名字', doneSt.list[1] === '数学卷子（第 3 章）.pptx', doneSt.list);
ok('结果页说明「共用一个取件码」', /3 个文件共用一个取件码/.test(doneSt.tip), doneSt.tip);
const hist = await p.evaluate(() => JSON.parse(localStorage.getItem('cls_fl_hist_v1') || '[]'));
ok('历史里记成一条', hist.length === 1, hist.length);
ok('历史里带 3 个文件名', hist[0] && hist[0].files && hist[0].files.length === 3, hist[0] && hist[0].files);

/* ================= ④ 取件页：列出整批 ================= */
console.log('④ 取件：一个码看到整批文件');
await p.evaluate(() => { flShowDone(false); flTab('get'); document.getElementById('flIn').value = 'Q7M4XZ'; });
await p.click('#flQuery');
await p.waitForTimeout(900);
const got = await p.evaluate(() => ({
  rows: [...document.querySelectorAll('#flCard .fl-get-i')].map((e) => ({
    nm: (e.querySelector('.nm') || {}).textContent || '',
    href: (e.querySelector('a') || {}).getAttribute ? e.querySelector('a').getAttribute('href') : '',
  })),
  head: (document.querySelector('#flCard b') || {}).textContent || '',
  all: !!document.getElementById('flDlAll'),
}));
ok('列出 3 个文件', got.rows.length === 3, got.rows);
ok('标题写「3 个文件」', got.head === '3 个文件', got.head);
ok('每项名字是改过的', /数学卷子（第 3 章）.pptx/.test(got.rows[1].nm), got.rows[1]);
ok('下载链接带 id 与票据', /id=it2/.test(got.rows[1].href) && /tk=tk-abcdef123456/.test(got.rows[1].href), got.rows[1].href);
ok('有「全部下载」按钮', got.all === true);

/* ================= ⑤ 历史页 ================= */
console.log('⑤ 历史：显示 N 个文件，逐个能改名');
await p.evaluate(() => flTab('hist'));
await p.waitForTimeout(500);
const hi = await p.evaluate(() => ({
  tag: (document.querySelector('#flHist .fl-hist-tag') || {}).textContent || '',
  title: (document.querySelector('#flHist .fl-hist-top b') || {}).textContent || '',
  files: [...document.querySelectorAll('#flHist .fl-hf span')].map((e) => e.textContent),
  renBtns: document.querySelectorAll('#flHist [data-flact="renitem"]').length,
  oneRen: document.querySelectorAll('#flHist [data-flact="ren"]').length,
}));
ok('标签写「3 个文件」', hi.tag === '3 个文件', hi.tag);
ok('标题带「等 3 个」', /等 3 个/.test(hi.title), hi.title);
ok('列出 3 个文件名', hi.files.length === 3, hi.files);
ok('每个文件各有一个改名按钮', hi.renBtns === 3, hi.renBtns);
ok('多文件时不再有整条改名', hi.oneRen === 0, hi.oneRen);

console.log('\npageerror: ' + errs.length + (errs.length ? ' → ' + errs.slice(0, 2).join(' | ') : ''));
if (errs.length) { fail++; }
await p.screenshot({ path: '/workspace/classsite-fl66/hist.png' });
await b.close();
console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
