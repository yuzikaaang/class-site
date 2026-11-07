#!/usr/bin/env node
/* ============================================================================
 * publish_release.mjs —— 把当前版本的更新记录写到云端（release_notes / 公告）
 * ----------------------------------------------------------------------------
 * 用法：
 *   node tools/publish_release.mjs              # 读 admin-3.js 的 REL_BUILTIN 首条
 *   node tools/publish_release.mjs --dry        # 只打印要写的内容，不落库
 *
 * 为什么需要它：
 *   scripts/predeploy.mjs 的门禁要求「云端 release_notes 里必须有当前版本这一条」，
 *   否则不许部署。而云端条目只能由有后台权限的账号写入 ——
 *   这个脚本就是把那一步自动化，避免每次都手点后台。
 *
 * 安全：
 *   口令不写进仓库（环境变量 CLS_AI_PASS，或 ~/.cls_ai_pass）。
 * ========================================================================== */
import fs from 'node:fs';

const API = process.env.CLS_API || 'https://api.classsite.dpdns.org';
const USER = process.env.CLS_AI_USER || 'aibot';
const PASS = process.env.CLS_AI_PASS
  || (fs.existsSync(process.env.HOME + '/.cls_ai_pass')
      ? fs.readFileSync(process.env.HOME + '/.cls_ai_pass', 'utf8').trim()
      : '');
const DRY = process.argv.includes('--dry');

if (!PASS) {
  console.error('✗ 找不到后台口令：设置环境变量 CLS_AI_PASS，或写进 ~/.cls_ai_pass');
  process.exit(1);
}

/* ---------- 1. 从 admin-3.js 的 REL_BUILTIN 取首条 ---------- */
const src = fs.readFileSync(new URL('../admin-3.js', import.meta.url), 'utf8');
/* 抓第一条记录：从 { version: 起，到这一条的 ], pub: [...] }, 为止。
   注意 items 数组里也有 '], ' 之类，所以要抓 pub 块作为结束锚点。 */
const m = src.match(/var REL_BUILTIN = \[\s*\{ version: '([\d.]+)'([\s\S]*?)\], pub: \[([\s\S]*?)\]\s*\}/);
if (!m) {
  console.error('✗ 没能从 admin-3.js 的 REL_BUILTIN 解析出首条记录');
  process.exit(1);
}
const VER = m[1];
const body = m[2];
const pubBody = m[3];

const pick = (re, label) => {
  const g = body.match(re);
  if (!g) { console.error('✗ REL_BUILTIN 首条缺 ' + label); process.exit(1); }
  return g[1];
};
const date = pick(/date: '([^']+)'/, 'date');
const type = pick(/type: '([^']+)'/, 'type');
const title = pick(/title: '([^']+)'/, 'title');
/* items 数组的范围：从 items: [ 到 ], pub: 之前 —— 只取这一段里的字符串 */
/* body 是从 version 之后到 ], pub: 之前的片段，
   所以 items 数组在这里是**未闭合**的（结尾的 '],' 被切掉了）。
   直接取 items: [ 之后的全部内容即可。 */
const itemsBody = body.split('items: [')[1] || '';
const items = [...itemsBody.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(x => x[1]);
const pubs = [...pubBody.matchAll(/\{ cat: '([^']+)', text: '((?:[^'\\]|\\.)*)' \}/g)]
  .map(x => ({ cat: x[1], text: x[2] }));

if (!items.length || !pubs.length) {
  console.error('✗ items / pub 解析失败（items=' + items.length + ' pubs=' + pubs.length + '）');
  process.exit(1);
}

const note = {
  version: VER, date, type, title,
  items: items.map(s => s.replace(/\\'/g, "'")),
  pub: pubs.map(p => ({ cat: p.cat, text: p.text.replace(/\\'/g, "'") })),
};

console.log('准备发布：');
console.log('  版本：' + note.version + '（' + note.date + '）');
console.log('  标题：' + note.title);
console.log('  条目：' + note.items.length + ' 条，公告口径 ' + note.pub.length + ' 条');
if (DRY) { console.log('\n--dry：只打印，不写库。'); process.exit(0); }

/* ---------- 2. 登录 ---------- */
const lr = await fetch(API + '/api/auth?action=login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
});
const lj = await lr.json();
if (!lj.token) { console.error('✗ 登录失败：' + JSON.stringify(lj).slice(0, 200)); process.exit(1); }
const token = lj.token;
console.log('\n✓ 已登录');

/* ---------- 3. 读现有 release_notes ---------- */
const gr = await fetch(API + '/api/content', { headers: { Authorization: 'Bearer ' + token } });
const gj = await gr.json();
const items0 = (gj && gj.items) || {};
let notes = items0.release_notes;
if (typeof notes === 'string') { try { notes = JSON.parse(notes); } catch { notes = []; } }
if (!Array.isArray(notes)) notes = [];

const idx = notes.findIndex(n => n && String(n.version) === VER);
if (idx >= 0) {
  console.log('  云端已有 ' + VER + ' → 覆盖更新');
  notes[idx] = note;
} else {
  console.log('  云端没有 ' + VER + ' → 追加到最前');
  notes.unshift(note);
}

/* ---------- 4. 写回 ---------- */
const wr = await fetch(API + '/api/content', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({ items: { release_notes: notes } }),
});
const wj = await wr.json();
if (!wj || wj.ok === false) {
  console.error('✗ 写入失败：' + JSON.stringify(wj).slice(0, 300));
  process.exit(1);
}
console.log('✓ release_notes 已写入（当前 ' + notes.length + ' 条）');

/* ---------- 5. 顺带把公告也发出去 ---------- */
let anns = items0.announcements;
if (typeof anns === 'string') { try { anns = JSON.parse(anns); } catch { anns = []; } }
if (!Array.isArray(anns)) anns = [];

/* 公告口径：把 pub 拼成一条，格式跟历史公告一致 */
const text = 'v' + note.version.split('.').slice(0, 2).join('.') + ' 更新！内容如下：'
  + note.pub.map(p => '【' + p.cat + '】' + p.text).join(' ');
/* 公告是否已存在：按**完整版本号**判，不按前两位 ——
   前两位判会把 v4.10.1 的公告误当成 v4.10.2 的，导致新公告永远发不出去。 */
const exists = anns.some(a => String(a && a.text || '').indexOf('v' + note.version + ' ') === 0
  || String(a && a.text || '').indexOf('v' + note.version + '！') === 0);
if (exists) {
  console.log('· 公告已存在 v' + note.version.split('.').slice(0, 2).join('.') + '，不重复发');
} else {
  anns.unshift({ date: note.date + ' 12:00', text });
  const ar = await fetch(API + '/api/content', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ items: { announcements: anns } }),
  });
  const aj = await ar.json();
  if (!aj || aj.ok === false) {
    console.error('⚠ 公告写入失败（版本记录已写成功，可稍后手动补）：' + JSON.stringify(aj).slice(0, 200));
  } else {
    console.log('✓ 公告已发布：' + text);
  }
}

console.log('\n完成。');
