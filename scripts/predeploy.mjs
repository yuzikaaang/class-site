#!/usr/bin/env node
/* ============================================================================
 * predeploy.mjs —— 部署前检查（v3.6.1）
 * ----------------------------------------------------------------------------
 * 站主原话：
 *   「后台新增数据管理，以后每次更新都先自动备份所有数据（通过检测在部署前
 *     先备份后部署），包括作业、公告、用户数据等等全部云端内容，默认存储最近
 *     14 个版本更新，方便有问题随时回档」
 *   「还有那个版本更新数据，如果没填写就不能部署」
 *
 * 这个脚本就是那道闸门。按顺序做四件事，任何一步不过就直接退出（不部署）：
 *   ① 读 index.html 的 SITE_VERSION，确认四处版本号一致
 *      （index / admin / sw.js / api/worker.mjs）
 *   ② 确认 admin.html 的 REL_BUILTIN 里有这个版本（源码里的更新记录）
 *   ③ 确认云端 release_notes 里也有这个版本（后台「版本更新」里能看到）
 *   ④ 调 /api/admin?action=backup 生成一份 predeploy 备份
 *
 * 用法：
 *   node scripts/predeploy.mjs            # 检查 + 备份，通过退出码 0
 *   node scripts/predeploy.mjs --dry-run  # 只检查，不备份
 *
 * 环境变量（可选）：
 *   CLS_API     默认 https://api.classsite.dpdns.org
 *   CLS_AI_USER 默认 aibot
 *   CLS_AI_PASS 默认 ai202505
 * ========================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.CLS_API || 'https://api.classsite.dpdns.org';
const USER = process.env.CLS_AI_USER || 'aibot';
const PASS = process.env.CLS_AI_PASS || 'ai202505';
const DRY = process.argv.includes('--dry-run');

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
console.log('① 版本号四周一致：' + VER);

/* ---------- ② 源码里有更新记录 ---------- */
const relBlock = adm.slice(adm.indexOf('var REL_BUILTIN'), adm.indexOf('var REL_BUILTIN') + 20000);
if (!relBlock.includes("version: '" + VER + "'")) {
  die('admin.html 的 REL_BUILTIN 里没有 ' + VER + ' 这一条。'
    + '\n   请先在 REL_BUILTIN 最前面补一条（标题 + 几条改了什么），再部署。');
}
console.log('② 源码 REL_BUILTIN 已填写 ' + VER);

/* ---------- ③ 云端版本记录已填写 ---------- */
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

let notes = [];
try {
  const r = await fetch(API + '/api/content', { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json();
  const raw = j.items && j.items.release_notes;
  notes = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(notes)) throw new Error('release_notes 结构异常');
} catch (e) {
  die('读取云端版本记录失败：' + (e.message || e));
}
if (!notes.some((n) => n && n.version === VER)) {
  die('云端 release_notes 里没有 ' + VER + ' 这一条。'
    + '\n   先在后台「版本更新」里补上（或让维护方写入），再部署。'
    + '\n   云端当前最新：' + ((notes[0] && notes[0].version) || '空'));
}
console.log('③ 云端版本记录已包含 ' + VER + '（共 ' + notes.length + ' 条）');

/* ---------- ③b 云端公告已发布（站主 v3.6.4 立规，v3.7.5 细化） ----------
   「每次小更新或主版本更新时添加公告，没有更新公告就无法推送更新部署。
     公告格式 ⅴ主版本.小更新 更新！内容如下：」
   ⚠️ v3.7.5 站主补充：「公告的发布只有前两个数字改了才发，最后一个数字改了是不发的」

   也就是：
     3.6 → 3.7（小更新）要发公告，标题写「v3.7 更新！」
     3.7.0 → 3.7.1（修修补补）**不发**公告
   所以这里只取前两段去匹配，并且刻意排除「v3.7.1」这类三段号
   （断言后面不能紧跟数字或点），避免拿补丁号的旧公告顶替。 */
const VER2 = VER.split('.').slice(0, 2).join('.');   /* 3.7.4 → 3.7 */
let announcements = [];
try {
  const r = await fetch(API + '/api/content', { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json();
  const raw = j.items && j.items.announcements;
  announcements = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(announcements)) announcements = [];
} catch (e) {
  die('读取云端公告失败：' + (e.message || e));
}
const ver2Re = new RegExp('v' + VER2.replace(/\./g, '\\.') + '(?![0-9.])');
const hit = announcements.find((a) => a && ver2Re.test(String(a.text || '')));
if (!hit) {
  die('云端公告里没有「v' + VER2 + '」这一条。'
    + '\n   站主规矩：主版本 / 小更新（前两位）变化时必须发公告，格式「v' + VER2 + ' 更新！内容如下：」，'
    + '没发就不许部署；只改最后一位（修修补补）不用发。'
    + '\n   公告只写给同学看：按类别分好、简短，不要写后台 / 隐私内容。'
    + '\n   最新公告：' + String((announcements[0] && announcements[0].text) || '空').slice(0, 60));
}
console.log('③b 云端公告已发布 v' + VER2 + '（' + String(hit.text).slice(0, 40).replace(/\n/g, ' ') + '…）');

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
