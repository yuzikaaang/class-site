#!/usr/bin/env node
/* ============================================================================
 * predeploy.mjs —— 部署前检查（版本号规则 v3.8.3 重写）
 * ----------------------------------------------------------------------------
 * 站主原话（2026-10-20）：
 *   「以后一天就是一个版本。上午我说了一些要求，你把它更新到 3.9；下午我又
 *     说了一些要求，你就不用更新到 3.10 了，还是 3.9 —— 一整天同一个版本，
 *     把它放到小的那个更新里面去（3.9.1、3.9.2）。」
 *   「公告每次只写前两个数字，比如 3.8 更新、3.9 更新，但公告内容是可以一直
 *     修改的：3.8.1 更新了什么放进去，3.8.2 又更新了什么也放进去，全都堆成
 *     同一条公告，不要 3.8.1 一个公告、3.8.2 一个公告，那样太多了。」
 *   「公告要注意检查能不能给同学看 —— 像『后台切换到前台』这种就不要加进去。
 *     语言一定要官方，不官方不能通过。一定要官方、简洁，按分类分好。」
 *   「版本更新的云端文字说明 + 公告，这两个没做你就不能部署，一定要加到门禁里。」
 *
 * 所以这道闸门按顺序做六件事，任何一步不过直接退出（不部署）：
 *   ① 版本号四处一致（index / admin / sw.js / api/worker.mjs）
 *   ② 源码 REL_BUILTIN 有这一条，并且写了 pub（给同学看的公告口径）
 *   ③ 云端 release_notes 有这一条，并且也有 pub
 *   ③b 云端里存在「v主.小」这条公告（同一批次共用一条，不新开）
 *   ③c 本次的 pub 条目**已经追加进那条公告**（没追加 → 阻止；可 --fix-announce 自动补）
 *   ③d 公告措辞能见人：无内部词、无口语、以「vX.Y 更新」开头、按【分类】分好、不超长
 *   ④ 调 /api/admin?action=backup 生成一份 predeploy 备份
 *
 * 用法：
 *   node scripts/predeploy.mjs                  # 检查 + 备份，通过退出码 0
 *   node scripts/predeploy.mjs --dry-run        # 只检查，不备份
 *   node scripts/predeploy.mjs --fix-announce   # 把本次 pub 自动追加进云端公告后再检查
 *
 * 环境变量（可选）：
 *   CLS_API     默认 https://api.classsite.dpdns.org
 *   CLS_AI_USER 默认 aibot
 *   CLS_AI_PASS 口令（不写进仓库）：优先环境变量，其次读 ~/.cls_ai_pass
 * ========================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.CLS_API || 'https://api.classsite.dpdns.org';
const USER = process.env.CLS_AI_USER || 'aibot';
/* 🔐 v3.9.10：口令不进仓库。优先环境变量，其次读本机私有文件 ~/.cls_ai_pass */
const PASS = process.env.CLS_AI_PASS
  || (() => { try { return fs.readFileSync(path.join(os.homedir(), '.cls_ai_pass'), 'utf8').trim(); } catch (e) { return ''; } })();
const DRY = process.argv.includes('--dry-run');
const FIX = process.argv.includes('--fix-announce');

function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function die(msg) {
  console.error('\n❌ 部署已阻止：' + msg + '\n');
  process.exit(1);
}

/* ---------- ① 版本号四处一致 ---------- */
const idx = read('index.html');
const adm = read('admin.html');
const sw = read('sw.js');
const wk = read('api/worker.mjs');

const m = idx.match(/var SITE_VERSION\s*=\s*'([^']+)'/);
if (!m) die('index.html 里找不到 SITE_VERSION');
const VER = m[1];
const checks = [
  ['index.html', VER],
  ['admin.html', (adm.match(/var SITE_VERSION\s*=\s*'([^']+)'/) || [])[1]],
  ['sw.js', (sw.match(/const SITE_VER\s*=\s*'([^']+)'/) || [])[1]],
  ['api/worker.mjs', (wk.match(/const API_VER\s*=\s*'([^']+)'/) || [])[1]],
];
const bad = checks.filter(([, v]) => v !== VER);
if (bad.length) {
  die('版本号不一致：' + checks.map(([f, v]) => f + '=' + (v || '缺失')).join('，')
    + '（以 index.html 的 ' + VER + ' 为准，四处必须相同）');
}
console.log('① 版本号四处一致：' + VER);

/* 三段号规约：主.小.修 —— 第一段只有站主发话才动，第二段一天只加一次 */
const seg = VER.split('.');
if (seg.length !== 3 || !seg.every((s) => /^\d+$/.test(s))) {
  die('版本号必须是三段「主.小.修」，当前是 ' + VER);
}

/* ---------- ② 源码里有更新记录 + 公告口径 ---------- */
const relStart = adm.indexOf('var REL_BUILTIN');
const relBlock = relStart < 0 ? '' : adm.slice(relStart, relStart + 40000);
if (!relBlock.includes("version: '" + VER + "'")) {
  die('admin.html 的 REL_BUILTIN 里没有 ' + VER + ' 这一条。'
    + '\n   请先在 REL_BUILTIN 最前面补一条（标题 + 几条改了什么），再部署。');
}
const srcRow = relBlock.slice(relBlock.indexOf("version: '" + VER + "'"));
/* 取到「下一条版本记录」之前为止：不能就地 indexOf，否则会命中它自己那行 */
const nextVerAt = srcRow.indexOf("version: '", "version: '".length + VER.length + 1);
const srcPubBlock = nextVerAt > 0 ? srcRow.slice(0, nextVerAt) : srcRow;
if (!/pub:\s*\[/.test(srcPubBlock)) {
  die('源码 REL_BUILTIN 的 ' + VER + ' 条目缺少 pub 字段。'
    + '\n   pub 是「写给同学看的公告口径」，例如：'
    + '\n   pub: [{ cat: \'资料\', text: \'「我的资料」字色加深，亮色暗色下都看得清\' }]'
    + '\n   没写就不知道这次该往公告里加什么，不许部署。');
}
console.log('② 源码 REL_BUILTIN 已填写 ' + VER + '（含 pub 公告口径）');

/* ---------- 登录 + 读云端 ---------- */
let token = '';
try {
  const r = await fetch(API + '/api/auth?action=login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const j = await r.json();
  token = j.token || '';
  if (!token) throw new Error(JSON.stringify(j).slice(0, 120));
} catch (e) {
  die('登录后台失败，无法核对云端版本记录：' + (e.message || e));
}

async function readContent() {
  const r = await fetch(API + '/api/content', { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json();
  const items = (j && j.items) || {};
  const pick = (k) => {
    const raw = items[k];
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return null; } }
    return raw;
  };
  return { pick };
}

let notes = [], announcements = [];
try {
  const c = await readContent();
  notes = c.pick('release_notes');
  announcements = c.pick('announcements') || [];
  if (!Array.isArray(notes)) notes = [];
  if (!Array.isArray(announcements)) announcements = [];
} catch (e) {
  die('读取云端内容失败：' + (e.message || e));
}

/* ---------- ③ 云端版本记录 ---------- */
const cloudRow = notes.find((n) => n && n.version === VER);
if (!cloudRow) {
  die('云端 release_notes 里没有 ' + VER + ' 这一条。'
    + '\n   先在后台「版本更新」里补上（或让维护方写入），再部署。'
    + '\n   云端当前最新：' + ((notes[0] && notes[0].version) || '空'));
}
const PUB = Array.isArray(cloudRow.pub) ? cloudRow.pub.filter((p) => p && p.text) : [];
if (!PUB.length) {
  die('云端 release_notes 的 ' + VER + ' 条目缺少 pub（给同学看的公告口径）。'
    + '\n   门禁靠它判断「这次的内容有没有真的写进公告」，不能省。');
}
console.log('③ 云端版本记录已包含 ' + VER + '（共 ' + notes.length + ' 条，pub ' + PUB.length + ' 条）');

/* ---------- ③b 公告：同一批次共用一条 ----------
   只取前两段（3.8.3 → 3.8），并且刻意排除「v3.8.3」这类三段号
   （断言后面不能紧跟数字或点），免得拿补丁号顶替。 */
const VER2 = seg.slice(0, 2).join('.');
const ver2Re = new RegExp('v' + VER2.replace(/\./g, '\\.') + '(?![0-9.])');
let hit = announcements.find((a) => a && ver2Re.test(String(a.text || '')));
if (!hit) {
  die('云端公告里没有「v' + VER2 + '」这一条。'
    + '\n   站主规矩：一个版本批次共用一条公告，标题写「v' + VER2 + ' 更新！内容如下：」。'
    + '\n   只有第二段变了（3.8 → 3.9）才新起一条；同一天后面的 3.8.3、3.8.4 都追加到这一条里。');
}
console.log('③b 云端公告存在 v' + VER2 + '：' + String(hit.text).slice(0, 34).replace(/\n/g, ' ') + '…');

/* ---------- ③c 本次内容已追加进公告 ---------- */
/* 规范化：去掉空白、标点、项目符号后再比对，避免「；」和「，」的差异误判 */
function norm(s) {
  return String(s || '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[·・\-—–、,，。.！!？?：:；;（）()\[\]【】「」"'"'']/g, '');
}
function missingPub(text) {
  const hay = norm(text);
  return PUB.filter((p) => !hay.includes(norm(p.text)));
}
let miss = missingPub(hit.text);
if (miss.length) {
  if (FIX) {
    const merged = appendToAnnouncement(hit.text, miss);
    const list = announcements.map((a) => (a === hit ? { ...a, text: merged, date: nowStamp() } : a));
    const r = await fetch(API + '/api/content', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ key: 'announcements', value: list }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) die('自动追加公告失败：' + (j.error || ('HTTP ' + r.status)));
    hit.text = merged;
    announcements = list;
    miss = missingPub(hit.text);
    if (miss.length) die('自动追加后仍未匹配，请手动检查公告文本。');
    console.log('③c 已自动把 ' + PUB.length + ' 条更新并入 v' + VER2 + ' 公告');
  } else {
    die('本次更新还没写进 v' + VER2 + ' 公告，缺 ' + miss.length + ' 条：\n'
      + miss.map((p) => '     · 【' + (p.cat || '其他') + '】' + p.text).join('\n')
      + '\n\n   站主规矩：每次部署都要把「同学能看懂的部分」追加进同一版本的公告。'
      + '\n   可以直接跑：node scripts/predeploy.mjs --fix-announce（自动按分类并入）'
      + '\n   也可以在后台「班级内容」里手动补，再重新部署。');
  }
}
console.log('③c 本次 ' + PUB.length + ' 条更新都已在 v' + VER2 + ' 公告里');

/* ---------- ③d 公告措辞能见人 ----------
   站主原话：「像『后台切换到前台』这种公告你就不要加进去，一定要检查这些东西
             能不能给同学们看；语言一定要官方，不官方是不能通过的；
             一定要官方、简洁，按分类分好。」 */
const TEXT = String(hit.text || '');

/* 内部事项：同学看不懂、也不需要知道 */
const BAN_INTERNAL = [
  '后台', '管理端', '管理员', '数据库', '数据表', '字段管理', '接口', '脚本',
  '部署', '门禁', '缓存', '服务器', '回档', '备份', '版本记录', '权限', '调试',
  '报错', '前端', '后端', '代码', '源码', '仓库', '环境变量', '命令行', '终端',
  '子请求', '重构',
];
/* 技术缩写单独按不区分大小写匹配，避免误伤正文里的普通英文 */
const BAN_TECH = /\b(api|sql|jsonb|sw|git|worker|cloudflare|neon|bug|crash|http)\b/i;
/* 口语化：公告是正式通知，不能像聊天 */
const BAN_CASUAL = ['搞定', '弄好', '弄了', '啥', '咋', '啦', '呗', '哈哈', '嘿嘿', '咱们', '咱班', '小伙伴们', '真香'];

const badInternal = BAN_INTERNAL.filter((w) => TEXT.includes(w));
if (badInternal.length) {
  die('公告里有同学不该看到的内部事项：' + badInternal.join('、')
    + '\n\n   v' + VER2 + ' 公告原文：\n' + TEXT
    + '\n\n   改法：把「后台 / 管理端 / 缓存 / 数据库」这类过程描述删掉，只留同学能感知到的结果。'
    + '\n   例：「后台切换回前台加载更快」→「再次打开站点时加载更快」。');
}
const techHit = TEXT.match(BAN_TECH);
if (techHit) {
  die('公告里出现技术缩写「' + techHit[0] + '」，同学看不懂，也不该出现在公告里。');
}
const badCasual = BAN_CASUAL.filter((w) => TEXT.includes(w));
if (badCasual.length) {
  die('公告语气不够官方：出现口语词「' + badCasual.join('、') + '」。'
    + '\n   公告是正式通知，请改成书面表达（例：「搞定」→「已完成」，「弄好」→「修复」）。');
}

if (!new RegExp('^\\s*v' + VER2.replace(/\./g, '\\.') + '\\s*更新').test(TEXT)) {
  die('公告开头必须是「v' + VER2 + ' 更新！内容如下：」，当前开头是：' + TEXT.slice(0, 30));
}

const cats = [...TEXT.matchAll(/【([^】]{1,8})】/g)].map((x) => x[1]);
const CAT_OK = ['学习', '作业', '成绩', '资料', '公告', '班级', '界面', '速度', '资源',
  '点歌', '投票', '活动', '考勤', '修复', '体验', '安全', '其他'];
const badCats = cats.filter((c) => !CAT_OK.includes(c));
if (cats.length < 2) {
  die('公告要按分类分好，至少两个【分类】标记（如【成绩】【资料】【速度】），当前只有 ' + cats.length + ' 个。');
}
if (badCats.length) {
  die('公告里出现了不认识的分类：' + badCats.join('、')
    + '\n   允许的分类：' + CAT_OK.map((c) => '【' + c + '】').join(' '));
}
/* 每个分类行不能只有标签没有内容 */
const emptyCat = TEXT.split('\n').some((l) => /^\s*【[^】]+】\s*$/.test(l));
if (emptyCat) die('公告里有【分类】后面没写内容的空行，请补上或删掉。');

const CN = (TEXT.match(/[\u4e00-\u9fa5]/g) || []).length;
if (CN > 1200) {
  die('公告太长了（' + CN + ' 个汉字，上限 1200）—— 站主要求「简洁」。'
    + '\n   同一条公告会随着 3.8.1、3.8.2… 一直追加，请合并同类项、去掉重复表述。');
}
console.log('③d 公告措辞通过（' + cats.length + ' 个分类，' + CN + ' 字）');

/* ---------- ③e 资源清单完整性（v3.9.10）----------
   起因：badge.png 一直不在 deploy-pages.yml 的白名单里 → Pages 上 404 →
   首页只好改走 /api/badge 代理（110KB、3.8s）。这类「引用了但没发布」
   的问题肉眼很难发现，所以让门禁自己扫。 */
const pagesYml = read('.github/workflows/deploy-pages.yml');
const listMatch = pagesYml.match(/SOURCE_FILES=\(([\s\S]*?)\)/);
const published = listMatch
  ? listMatch[1].split('\n').map((x) => x.trim()).filter(Boolean)
  : [];
function isPublished(rel) {
  const clean = rel.replace(/^\.\//, '').split('?')[0];
  if (!clean || /^https?:|^\/\//.test(clean)) return true;
  return published.some((p) => clean === p || clean.startsWith(p + '/'));
}
const refs = new Set();
for (const f of ['index.html', 'app.js', 'share-card.js']) {
  const t = read(f);
  const re = /['"(](\.\/[A-Za-z0-9_\-./]+\.(?:js|css|png|jpg|jpeg|svg|webmanifest|woff2?))['")]/g;
  let m;
  while ((m = re.exec(t))) refs.add(m[1].replace(/^\.\//, ''));
}
const missing = [...refs].filter((r) => !isPublished(r));
if (missing.length) {
  die('这些文件被页面引用，但没在 .github/workflows/deploy-pages.yml 的发布清单里：\n   '
    + missing.join('\n   ') + '\n   线上会 404（badge.png 就是这么丢的）。');
}
console.log('③e 资源清单完整（引用 ' + refs.size + ' 个文件，全部会发布）');

/* ---------- ③f 体积预算（v3.9.10）----------
   弱网下的「几十秒」主要来自首屏字节数。超预算不阻止发布，但要当面提醒 ——
   数字摆出来，才不会一边喊慢一边继续加代码。 */
const budget = [
  ['index.html', 130 * 1024, '首屏 HTML（gzip）'],
  ['app.js', 400 * 1024, '主脚本（gzip）'],
  ['admin.html', 340 * 1024, '后台（gzip）'],
];
const gz = (p) => zlib.gzipSync(Buffer.from(read(p))).length;
const over = [];
for (const [f, limit, label] of budget) {
  const size = gz(f);
  const kb = (size / 1024).toFixed(0);
  if (size > limit) over.push(`${f} ${kb}KB > 预算 ${(limit / 1024).toFixed(0)}KB`);
  console.log('   · ' + label + '：' + kb + 'KB');
}
if (over.length) {
  console.warn('⚠️ 体积超预算（不阻止发布，但请记账）：\n   ' + over.join('\n   '));
}

/* ---------- ③g 重复定义 & 明文口令（v3.9.10）----------
   ① admin.html 曾有 startAdminHeartbeat 两份：后一份覆盖前一份，且没有
      __adminHbTimer 守卫 → 每进一次后台多一个 60 秒定时器。
   ② 公开仓库里曾躺着管理员明文口令。两件事都靠肉眼发现太晚。 */
const dupFiles = ['app.js', 'admin.html', 'index.html'];
const dupHit = [];
for (const f of dupFiles) {
  const t = read(f);
  const names = [...t.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
  const seen = new Set(), dup = new Set();
  for (const n of names) (seen.has(n) ? dup : seen).add(n);
  if (dup.size) dupHit.push(f + ' → ' + [...dup].join(', '));
}
if (dupHit.length) die('有重复的顶层函数定义（后者会静默覆盖前者）：\n   ' + dupHit.join('\n   '));
console.log('③g 无重复顶层函数');

const secretHits = [];
const scanFiles = ['app.js', 'admin.html', 'index.html', 'sw.js',
  '.github/workflows/backup-data.yml', '.github/workflows/deploy-pages.yml',
  'api/worker.mjs', 'api/auth.js', 'scripts/predeploy.mjs'];
for (const f of scanFiles) {
  let t = '';
  try { t = read(f); } catch (e) { continue; }
  const lines = t.split('\n');
  lines.forEach((line, i) => {
    /* 只抓「密码/口令 = 字面值」，排除空串、变量、模板 */
    const m = line.match(/(?:^|[^A-Za-z_])(password|passwd|pwd|PASS|PASSWORD)\s*[:=]\s*['"]([^'"]{4,})['"]/);
    if (!m) return;
    const val = m[2];
    /* 排除：变量引用 / 中文文案 / 明显的占位符 */
    if (/^\$/.test(val) || /[\u4e00-\u9fa5]/.test(val)) return;
    if (/process\.env|placeholder|CHANGE_?ME|xxx/i.test(val)) return;
    secretHits.push(f + ':' + (i + 1) + '  ' + m[1] + '=<疑似>');
  });
}
if (secretHits.length) die('疑似明文口令（仓库是公开的，口令只能放 Secrets / 本机）：\n   ' + secretHits.join('\n   '));
console.log('③h 无明文口令');

/* ---------- ④ 部署前备份 ---------- */
if (DRY) {
  console.log('④ 跳过备份（--dry-run）\n✅ 检查通过（未备份、未部署）');
  process.exit(0);
}

try {
  const r = await fetch(API + '/api/admin?action=backup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ version: VER, kind: 'predeploy', note: '部署前自动备份' }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  console.log('④ 已备份：' + (j.message || ('id=' + j.id)));
  console.log('   ' + (j.summary || ''));
} catch (e) {
  const msg = String(e.message || e);
  /* 首次上线这套备份接口时，线上还是旧版 API（没有 backup 这个 action）。
     这种情况不能把部署卡死，否则永远装不上 —— 给一条明确的警告，
     部署完立刻在后台点一次「立即备份」补上。除此之外任何失败都阻止部署。 */
  if (/未知的 action|404|not found/i.test(msg)) {
    console.warn('⚠️ 线上 API 还没有备份接口（应是首次上线）。');
    console.warn('   本次跳过自动备份 —— 部署完成后请立刻到「安全 → 数据管理」点一次「立即备份」。');
  } else {
    die('部署前备份失败：' + msg + '\n   备份不成功就不部署 —— 这是站主定的规矩。');
  }
}

console.log('\n✅ 全部通过，可以部署 ' + VER + '\n');

/* ============================================================================
 * 辅助：把「本次要公告的条目」按分类并入公告正文
 * ----------------------------------------------------------------------------
 *  · 已经有同名分类 → 接在该行末尾，用「；」分隔（一行一个分类，不重复标签）
 *  · 没有该分类     → 末尾新起一行「【分类】内容」
 *  · 同样的内容     → 跳过（重复部署不会写两遍）
 * ========================================================================= */
function appendToAnnouncement(text, pubs) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
  for (const p of pubs) {
    const cat = String(p.cat || '其他').trim();
    const body = String(p.text || '').trim();
    if (!body) continue;
    const tag = '【' + cat + '】';
    let at = -1;
    for (let i = lines.length - 1; i >= 1; i--) {
      if (lines[i].startsWith(tag)) { at = i; break; }
    }
    if (at >= 0) {
      const cur = lines[at].slice(tag.length).replace(/[；;]\s*$/, '');
      if (cur.split(/[；;]/).some((s) => norm(s) === norm(body))) continue;
      lines[at] = tag + cur + '；' + body;
    } else {
      lines.push(tag + body);
    }
  }
  return lines.join('\n');
}

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
