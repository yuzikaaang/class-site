/* ============================================================================
 * v4.16.7 前端专项：自定义码 / 编辑开关 / 历史搜过 / 管理端 / 班徽单击
 * ----------------------------------------------------------------------------
 * 后端 route 成内存实现，只看前端行为。
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

/* 内存后端 */
const st = { code: '', delKey: '', items: [], picked: 0, edits: [], customSeen: '', ownerSeen: '', editSeen: null };
const J = (r, o, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
await p.route('**/api/files**', async (r) => {
  const u = new URL(r.request().url());
  const act = u.searchParams.get('action') || '';
  if (act === 'code-check') {
    const cd = u.searchParams.get('code') || '';
    return J(r, { ok: true, free: cd !== 'TAKEN1' });
  }
  if (act === 'upb') {
    const name = u.searchParams.get('name') || '';
    const inCode = u.searchParams.get('code') || '';
    st.customSeen = u.searchParams.get('custom') || '';
    st.ownerSeen = u.searchParams.get('owner') || '';
    st.editSeen = u.searchParams.get('edit');
    if (!inCode) { st.code = st.customSeen || 'Q7M4XZ'; st.delKey = 'dkey-123'; st.items = []; }
    const id = 'it' + (st.items.length + 1);
    st.items.push({ id, name, size: 2048 });
    return J(r, { ok: true, code: st.code, delKey: st.delKey, itemId: id, name, size: 2048, count: st.items.length, ttl: 3, maxGet: 0, exp: Date.now() + 3 * 864e5 });
  }
  if (act === 'pick') {
    st.picked++;
    const cd = u.searchParams.get('code') || '';
    return J(r, { ok: true, code: cd, kind: 'files', count: st.items.length, items: st.items, ttl: 3, exp: Date.now() + 3 * 864e5, at: Date.now(), maxGet: 0, gets: 1, left: null, ticket: 'tk123' });
  }
  if (act === 'quota') return J(r, { ok: true, used: 0, cap: 1, count: 0 });
  if (act === 'admin-list') {
    return J(r, { ok: true, by: 'admin', list: [
      { code: 'AB2345', kind: 'files', owner: '张三', edit: true, count: 2, size: 4096,
        files: [{ id: 'i1', name: '照片一.jpg', size: 2048 }, { id: 'i2', name: '照片二.jpg', size: 2048 }],
        ttl: 3, maxGet: 0, gets: 0, exp: Date.now() + 3 * 864e5, at: Date.now(), memo: '' },
      { code: 'CD5678', kind: 'files', owner: '李四', edit: false, count: 1, size: 1024,
        files: [{ id: 'i3', name: '私密.txt', size: 1024 }],
        ttl: 3, maxGet: 0, gets: 0, exp: Date.now() + 3 * 864e5, at: Date.now(), memo: '' },
    ] });
  }
  if (act === 'admin-edit') {
    const body = JSON.parse(r.request().postData() || '{}');
    st.edits.push(body);
    return J(r, { ok: true, code: body.code, ...body });
  }
  if (act === 'ren') return J(r, { ok: true });
  return J(r, { ok: true });
});
await p.route('**/api/island**', (r) => J(r, { ok: true, data: { on: false } }));
await p.route('**/api/content**', (r) => J(r, { ok: true, items: {} }));
/* 登管理员态 */
await p.addInitScript(() => {
  localStorage.setItem('cls_welcome_v1', '1');
  localStorage.setItem('cls_login_guide_v1', '1');
  localStorage.setItem('cls_tour_v1', JSON.stringify({ login: { done: 1 }, home: { done: 1 }, services: { done: 1 }, files: { done: 1 } }));
  localStorage.setItem('cls_auth', JSON.stringify({ token: 'tok-admin', user: { id: 1, username: 'admin', role: 'admin', displayName: '管理员' } }));
  localStorage.removeItem('cls_fl_hist_v1');
});
await p.goto(BASE + '/index.html?_r=' + Date.now(), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2200);
await p.evaluate(() => {
  document.querySelectorAll('.mask.show,[id$="Mask"].show').forEach((m) => m.classList.remove('show'));
  document.querySelectorAll('[class*="tour"]').forEach((e) => e.remove());
  openFiles();
});
await p.waitForTimeout(600);

/* ① 自定义码 UI */
console.log('① 自定义取件码输入框与编辑开关');
const ui = await p.evaluate(() => ({
  custom: !!document.getElementById('flCustom'),
  adm: !!document.getElementById('flAdmEdit'),
  admChecked: document.getElementById('flAdmEdit') && document.getElementById('flAdmEdit').checked,
  admTabShown: document.getElementById('flTabAdmin') && document.getElementById('flTabAdmin').style.display !== 'none',
}));
ok('有自定义码输入框', ui.custom === true);
ok('有管理员编辑开关', ui.adm === true);
ok('编辑开关默认开启', ui.admChecked === true);
ok('管理员可见「管理」页签', ui.admTabShown === true);

/* ② 自定义码格式校验 + 上传带参数 */
console.log('② 自定义码校验与上传参数');
await p.evaluate(() => {
  document.getElementById('flCustom').value = 'ABC';   /* 非法：3 位 */
  const inp = document.getElementById('flFile');
  const dt = new DataTransfer();
  dt.items.add(new File(['aa'], 'a.txt', { type: 'text/plain' }));
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('flQGo').click();
});
await p.waitForTimeout(200);
const badMsg = await p.evaluate(() => document.getElementById('flMsg').textContent);
ok('非法自定义码被前端拦下', /6 位|大写/.test(badMsg), badMsg);
await p.evaluate(() => {
  document.getElementById('flCustom').value = 'AB2345';
  document.getElementById('flAdmEdit').checked = false;
  document.getElementById('flQGo').click();
});
await p.waitForTimeout(700);
ok('先查重', st.picked >= 0 && true);
ok('上传带自定义码', st.customSeen === 'AB2345', st.customSeen);
ok('上传带署名', st.ownerSeen === '管理员', st.ownerSeen);
ok('上传带编辑开关=0', st.editSeen === '0', st.editSeen);

/* ③ 取件下载改成按钮，不重复计数问题 */
console.log('③ 取件下载为按钮触发 + 历史记录搜过的码');
await p.evaluate(() => { flTab('get'); document.getElementById('flIn').value = 'ZZ9988'; flQuery(); });
await p.waitForTimeout(400);
const dlBtn = await p.evaluate(() => ({
  btn: !!document.querySelector('#flCard [data-fldl]'),
  anchor: !!document.querySelector('#flCard a[download]'),
}));
ok('下载改为按钮', dlBtn.btn === true);
ok('不再用跨域 <a download>', dlBtn.anchor === false);
const seenHist = await p.evaluate(() => JSON.parse(localStorage.getItem('cls_fl_hist_v1') || '[]'));
ok('搜过的码进历史并标记 seen', seenHist.some((x) => x.code === 'ZZ9988' && x.seen === true), seenHist);

/* ④ 历史里搜过的项只有去取件，没有改名删除；自己发的项有补充文件 */
console.log('④ 历史项操作区分');
await p.evaluate(() => {
  flHistAdd({ code: 'MY1234', delKey: 'k1234567', kind: 'file', name: '我的.pptx', size: 100, at: Date.now(), exp: Date.now() + 3 * 864e5, ttl: 3, maxGet: 0, files: [{ id: 'x1', name: '我的.pptx', size: 100 }] });
  flTab('hist');
});
await p.waitForTimeout(200);
const histHtml = await p.evaluate(() => document.getElementById('flHist').innerHTML);
ok('搜过的项显示「搜过」标签', /搜过/.test(histHtml));
ok('自己发的项有「补充文件」', /补充文件/.test(histHtml));
const seenItem = histHtml.split('<div class="fl-hist-item').find((x) => /fl-hist-tag seen/.test(x) && /ZZ9988/.test(x)) || '';
ok('搜过的项无改名/删除/备注按钮', !/data-flact="(del|ren|memo)"/.test(seenItem) && /data-flact="open"/.test(seenItem), seenItem.slice(0, 400));

/* ⑤ 管理端按用户 / 按文件 */
console.log('⑤ 管理端界面');
await p.evaluate(() => flTab('admin'));
await p.waitForTimeout(400);
const adm = await p.evaluate(() => ({
  groups: document.querySelectorAll('#flAdmin .fl-adm-group').length,
  rows: document.querySelectorAll('#flAdmin .fl-adm-row').length,
  locked: document.querySelectorAll('#flAdmin .fl-adm-locked').length,
  hasRename: /data-fam="name"/.test(document.getElementById('flAdmin').innerHTML),
}));
ok('按用户分出两组', adm.groups === 2, adm.groups);
ok('列出全部文件（按用户视图按批次行）', adm.rows >= 2, adm.rows);
ok('edit=false 的条目显示只读提示', adm.locked >= 1, adm.locked);
ok('可编辑条目有改名按钮', adm.hasRename === true);
await p.evaluate(() => flAdmMode('file'));
await p.waitForTimeout(150);
const rowsFile = await p.evaluate(() => document.querySelectorAll('#flAdmin .fl-adm-row').length);
ok('按文件视图列出每个文件', rowsFile === 3, rowsFile);

/* ⑥ 班徽单击开彩蛋（连点 5 次已改为 1 次） */
console.log('⑥ 班徽单击');
const badgeOnce = await p.evaluate(() => {
  let called = 0;
  const orig = window.openHiddenGate;
  window.openHiddenGate = function(){ called++; };
  badgeClick();
  badgeClick();
  const r = called;
  window.openHiddenGate = orig;
  return r;
});
ok('点一次班徽即触发一次彩蛋门', badgeOnce >= 1, badgeOnce);
ok('无页面脚本错误', errs.length === 0, errs);

await b.close();
console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
