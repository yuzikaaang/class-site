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

/* 公告口径：把 pub 拼成一条，格式跟历史公告一致。
 *
 * v4.10.3（站主两条明确要求）：
 *   ① 「同一个版本发同一个公告就可以了」
 *      —— 公告标题只带**前两段版本号**（v4.10），不是完整三段号。
 *      v4.10.0 / 4.10.1 / 4.10.2 / 4.10.3 全都往**同一条** v4.10 公告里追加，
 *      不要每次小版本都新开一条公告（那样首页会出现好几条「v4.10 更新」）。
 *      这条规矩在 scripts/predeploy.mjs 的 ③b / ③c 门禁里也是同一个口径。
 *   ② 「公告时间错误……首页那两个公告时间现在都显示 11 月 8 号 12 点，
 *      我现在都没有到 11 月 8 号」
 *      —— 以前日期写死成 note.date + ' 12:00'，note.date 又是发布日志里
 *      手填的日期（常常填了「明天」）。现在改成**用真实的当前时间**，
 *      并且跟着时区走（本地时间），保证「几点的公告就显示几点」。
 */
const VER2 = VER.split('.').slice(0, 2).join('.');   /* v4.10.3 → v4.10 */
/* 找同一条 v4.10 公告：标题以「v4.10 」开头，且后面不能紧跟数字或点
   （免得把 v4.10.3 这种三段号当成 v4.10 那条）。 */
const ver2Re = new RegExp('^v' + VER2.replace(/\./g, '\\.') + '(?![0-9.])');
let hit = anns.find(a => a && ver2Re.test(String(a.text || '')));

/* 真实当前时间（本地时区），格式 'YYYY-MM-DD HH:MM' —— 和前台
   annSortKey() 认的 'YYYY-MM-DD 23:59' 同一种格式。 */
function nowStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* 规范化后比对，避免「；」和「，」的差异误判 */
function norm(s) {
  return String(s || '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[·・\-—–、,，。.！!？?：:；;（）()\[\]【】「」"'’‘]/g, '');
}
/* 把这次要发的 pub 追加进公告正文（同分类合并成一行，用「；」隔开） */
function appendPubs(text, pubs) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
  for (const p of pubs) {
    const cat = String(p.cat || '其他').trim();
    const body = String(p.text || '').trim();
    if (!body) continue;
    const tag = '【' + cat + '】';
    /* v4.10.3：**先看所有行**有没有写过这一条（同一分类可能已经有多行，
       只看最后一行会漏判 → 重复发布同一条）。 */
    let already = false;
    for (const l of lines) {
      if (!l.startsWith(tag)) continue;
      const cur = l.slice(tag.length).replace(/[；;]\s*$/, '');
      if (cur.split(/[；;]/).some((s) => norm(s) === norm(body))) { already = true; break; }
    }
    if (already) continue;
    /* 找最后一条同分类的行，试着并进去 */
    let at = -1;
    for (let i = lines.length - 1; i >= 1; i--) {
      if (lines[i].startsWith(tag)) { at = i; break; }
    }
    if (at >= 0) {
      const cur = lines[at].slice(tag.length).replace(/[；;]\s*$/, '');
      /* v4.10.3：合并后如果一行超过 28 个汉字（门禁 ③d 的硬闸），
         就不再往这一行后面接，**另起一行**写这条 —— 一条只写一个结果。 */
      const mergedLine = tag + cur + '；' + body;
      const han = (mergedLine.match(/[\u4e00-\u9fa5]/g) || []).length;
      if (han > 28) lines.push(tag + body);
      else lines[at] = mergedLine;
    } else {
      lines.push(tag + body);
    }
  }
  return lines.join('\n');
}

if (hit) {
  /* 同一条公告：把这次的内容追加进去，并刷新时间为真实当前时间 */
  const merged = appendPubs(hit.text, note.pub);
  if (merged === hit.text) {
    console.log('· v' + VER2 + ' 公告已包含本次全部内容，不重复写');
  } else {
    hit.text = merged;
    hit.date = nowStamp();
    const ar = await fetch(API + '/api/content', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ items: { announcements: anns } }),
    });
    const aj = await ar.json().catch(() => ({}));
    if (!aj || aj.ok === false) {
      console.error('⚠ 公告写入失败（版本记录已写成功，可稍后手动补）：' + (aj.error || JSON.stringify(aj).slice(0, 200)));
    } else {
      console.log('✓ 已并入 v' + VER2 + ' 公告（时间 ' + hit.date + '）');
    }
  }
} else {
  /* 这一批还没有公告 → 新开一条（标题用两段版本号） */
  const text = 'v' + VER2 + ' 更新！内容如下：\n'
    + note.pub.map(p => '【' + p.cat + '】' + p.text).join('\n');
  anns.unshift({ date: nowStamp(), text });
  const ar = await fetch(API + '/api/content', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ items: { announcements: anns } }),
  });
  const aj = await ar.json().catch(() => ({}));
  if (!aj || aj.ok === false) {
    console.error('⚠ 公告写入失败（版本记录已写成功，可稍后手动补）：' + (aj.error || JSON.stringify(aj).slice(0, 200)));
  } else {
    console.log('✓ 公告已发布：' + text.split('\n')[0]);
  }
}

console.log('\n完成。');
