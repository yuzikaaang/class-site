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
import { execFileSync } from 'node:child_process';
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
/* v3.9.16：后台脚本已拆到 admin.js，读发布记录要两份拼起来 */
/* v3.19.0：后台脚本拆成 admin-1/2/3.js，更新记录（REL_BUILTIN）现在在 admin-3.js 里 ——
   这里必须把三段都拼进来，否则门禁永远说「没有这一条」。 */
const adm = read('admin.html') + ['admin-1.js', 'admin-2.js', 'admin-3.js']
  .filter((f) => fs.existsSync(path.join(ROOT, f)))
  .map((f) => read(f)).join('\n');
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

/* ---------- ③a 中版本节奏：6 小时内只许升小版本 ----------
 * 站主原话（2026-11-07）：
 *   「如果你是 12 个小时内一直更新的东西的话，它属于一个小更新，你不能说
 *     4.6、4.7、4.8、4.9，你这几个小时就更新这么多个版本不太现实。12 个小时内
 *     更新的东西，即使更新再大它也算是同一个版本里面的，你只能给它更新小版本，
 *     不能更新中版本。」
 *
 * v4.11.0（站主）：「这个版本部署规则改一下，是 6 个小时，从之前的 12 个小时改为 6 个
 * 小时。以后想改一个中版本，只要中途超过 6 个小时就可以。」—— 于是 HOURS 12 → 6。
 *
 * 判定基准：**距上一次升中版本的时间**（不是距上一次任意发版）——
 *   否则连着发几个小版本会把中版本无限往后拖。
 *   例：4.7.0 发于 11-06 14:42，那么在 11-07 02:42 之前只能发 4.7.x；
 *       过了这个点，才允许发 4.8.0。
 *
 * 首现时间取自 git 提交历史（提交信息以 vX.Y.Z 开头）。
 * 取不到（浅克隆 / 无 git）就放行，只提示，不阻断 —— 门禁不能因为环境缺失误杀。 */
const vnum = (s) => String(s || '').split('.').map((x) => parseInt(x, 10) || 0);

function cmpVer(a, b) {
  const A = vnum(a), B = vnum(b);
  for (let i = 0; i < 3; i++) {
    if (A[i] !== B[i]) return A[i] > B[i] ? 1 : -1;
  }
  return 0;
}

/** 某个「主.小」第一次出现的提交时间（毫秒），取不到返回 0 */
function minorFirstSeen(v2) {
  try {
    const out = execFileSync('git', ['log', '--format=%at%x09%s'], { cwd: ROOT, encoding: 'utf8' });
    const re = new RegExp('v' + v2.replace(/\./g, '\\.') + '\\.0(?![0-9.])');
    let ts = 0;
    for (const line of out.split('\n')) {
      const at = Number((line.split('\t')[0] || '').trim()) || 0;
      if (at && re.test(line)) ts = at;   /* git log 是新→旧，最后一次命中的就是最早 */
    }
    return ts * 1000;
  } catch (e) { return 0; }
}

const cloudTopVer = (notes[0] && notes[0].version) || '';
if (cloudTopVer) {
  if (cmpVer(VER, cloudTopVer) < 0) {
    die('版本号倒退了：本地是 ' + VER + '，云端已发布到 ' + cloudTopVer + '。'
      + '\n   降版本要连云端 release_notes 一起改，否则同学看到的是「越更越旧」。');
  }
  const cm = vnum(cloudTopVer), lm = vnum(VER);
  const bumpedMinor = lm[1] > cm[1] || lm[0] > cm[0];
  if (bumpedMinor) {
    const HOURS = 6;
    const prev2 = cm[0] + '.' + cm[1];
    const seenAt = minorFirstSeen(prev2);
    if (seenAt && Date.now() - seenAt < HOURS * 3600 * 1000) {
      const left = Math.ceil((HOURS * 3600 * 1000 - (Date.now() - seenAt)) / 3600000);
      die('中版本升得太快：v' + prev2 + ' 系列第一次发布距今不到 ' + HOURS + ' 小时'
        + '（约 ' + new Date(seenAt).toLocaleString('zh-CN') + ' 首发，还差 ' + left + ' 小时）。'
        + '\n   站主规矩：6 小时内只许升小版本 —— 把这次的改动挂到 v' + prev2 + '.x 上，'
        + '\n   等过了 ' + HOURS + ' 小时再开新的中版本。');
    }
  }
  console.log('③a 中版本节奏正常：' + VER + '（云端 ' + cloudTopVer + '）');
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

/* v4.8.0（站主）：「公告要像之前那样简洁、要官方；不用解释它有什么用，
   只解释更新了什么。这样看着就特别 AI 化。」
   所以再加两道硬闸：
     · 不许解释来龙去脉 —— 以前 / 原来 / 现在 / 因为 / 所以 / 避免 / 不然…
       公告只陈述「更新了什么」，不写「为什么改、怎么改的、改完有什么好处」；
     · 每条不超过 28 个汉字 —— 一句话说清一件事，长了就是解释。 */
const BAN_EXPLAIN = ['以前', '原来', '现在', '这样', '否则', '因为', '所以', '避免',
  '不用', '不再', '才能', '就可以', '不然', '导致', '由于', '从而', '其实', '实际上',
  '若是', '这样一来', '好处', '目的是'];
const badExplain = BAN_EXPLAIN.filter((w) => TEXT.includes(w));
if (badExplain.length) {
  die('公告里出现了解释性表述：' + badExplain.join('、')
    + '\n\n   v' + VER2 + ' 公告原文：\n' + TEXT
    + '\n\n   站主规矩：公告只写「更新了什么」，不解释用途与来龙去脉。'
    + '\n   例：「刷新不再打断输入，因为原来会整页重绘」→「作业刷新不打断输入」。');
}
if (/[你您]/.test(TEXT)) {
  die('公告里出现第二人称（你 / 您），公告用无主语的陈述句。');
}
const LONG_LINE = TEXT.split('\n')
  .map((l) => l.trim())
  .filter((l) => /^【[^】]+】/.test(l))
  .filter((l) => (l.match(/[\u4e00-\u9fa5]/g) || []).length > 28);
if (LONG_LINE.length) {
  die('公告有条目过长（超过 28 个汉字），请拆短：\n'
    + LONG_LINE.map((l) => '     · ' + l).join('\n')
    + '\n\n   站主要求「简洁」：一条只写一个结果。');
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

/* ---------- ③d2 站内文案书面化（v4.4.5）----------
   站主原话：「对应软件的简介，你没有进行官方化文字修改，比如作业、意见反馈等，
             还有这个以后要进入你们部署前的一个文件就检查，没有出现这种语言才可以部署。」
   所以把「文案检查」做成硬闸门：scripts/copycheck.mjs 不过，这里直接退出。
   规则与豁免都在那个文件里，改文案时用 `node scripts/copycheck.mjs --list` 看全部命中。 */
{
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'copycheck.mjs')], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(((r.stdout || '') + (r.stderr || '')).trim());
    die('站内文案不够书面化（见上）。'
      + '\n\n   站主要求：站内提示、软件简介、公告一律用书面表述 ——'
      + '\n   · 不出现第二人称（你 / 您），改为「本人」「当前账号」或无主语句'
      + '\n   · 不出现口语动词与语气词（点一下 / 试试 / 搞定 / 啦 / 哦 / 吧）'
      + '\n   · 动作统一「点击」，状态统一「已 / 暂无 / 无法」'
      + '\n\n   跑 node scripts/copycheck.mjs --list 可以看全部命中位置。');
  }
  console.log((r.stdout || '').trim());
}

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
/* v3.19.0：后台脚本拆成 admin-1/2/3.js 之后，引用它们的是 admin.html ——
   扫描清单里必须有 admin.html，否则「引用了但没发布」这类问题又会被漏掉。 */
for (const f of ['index.html', 'app.js', 'big.js', 'share-card.js', 'admin.html', 'clock.html', 'share.html']) {
  if (!fs.existsSync(path.join(ROOT, f))) continue;
  const t = read(f);
  /* v3.18.0：允许带 ?v= 查询串（之前只认「引号紧跟文件名」，
     于是 <script src="./auth-bus.js?v=3180"> 这种完全扫不到 —— 线上直接 404）。 */
  const re = /['"(](\.\/[A-Za-z0-9_\-./]+\.(?:js|css|png|jpg|jpeg|svg|webmanifest|woff2?))(?:\?[^'"\s)]*)?['")]/g;
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
  ['app.min.js', 240 * 1024, '主脚本（gzip，实际发布）'],
  ['admin.html', 60 * 1024, '后台 HTML（gzip，拆包后）'],
  ['admin-1.js', 150 * 1024, '后台脚本第 1 段（gzip）'],
  ['admin-2.js', 150 * 1024, '后台脚本第 2 段（gzip）'],
  ['admin-3.js', 180 * 1024, '后台脚本第 3 段（gzip）'],
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
/* v3.19.0：后台拆成三段后，重复定义还可能在「不同段之间」——
   所以三段合成一份虚拟文件再查，否则跨段覆盖查不出来。 */
const dupGroups = [
  ['app.js'],
  ['admin-1.js', 'admin-2.js', 'admin-3.js'],
  ['admin.html'],
  ['index.html'],
];
const dupHit = [];
for (const group of dupGroups) {
  const t = group.map((f) => read(f)).join('\n');
  const f = group.join('+');
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

/* ---------- ③i README 必须与本次版本同步 ----------
   站主（2026-10-25）：「以后 readme 也是有部署门禁，部署前确保 readme 已同步更新，
   确保删掉错误的，添加新增的」。
   三条硬规则：
     · 顶部「当前版本 vX.Y.Z」必须等于代码版本（改代码不改 README → 拦）
     · 更新日志的第一条必须是当前版本（只在中间塞一行不算）
     · 功能一览必须提到关键能力（新功能忘了写进 README → 拦）
   外加一份「错误的表述」黑名单，防止老描述被复制回去。 */
const rd = read('README.md');
const rdVer = (rd.match(/\*\*当前版本\s*v?([\d.]+)\*\*/) || [])[1];
if (!rdVer) {
  die('README.md 顶部没有「当前版本 **vX.Y.Z**」这一行。'
    + '\n   加在开头介绍下面，格式照抄：> **当前版本 v' + VER + '**（YYYY-MM-DD）· …');
}
if (rdVer !== VER) {
  die('README 写的是 v' + rdVer + '，代码是 v' + VER + '。'
    + '\n   这次改了功能却没同步 README —— 请把「当前版本」、更新日志、功能一览一起改。');
}
const logAt = rd.indexOf('## 更新日志');
if (logAt < 0) die('README.md 里找不到「## 更新日志」这一节。');
const firstLog = (rd.slice(logAt).match(/^### (v[\d.]+)/m) || [])[1] || '';
if (firstLog !== 'v' + VER) {
  die('README 更新日志的第一条是 ' + (firstLog || '空') + '，不是 v' + VER + '。'
    + '\n   新版本要写在更新日志最上面（旧的往下排），不能只塞在中间。');
}
const needWords = ['班级岛', '逐字', '成绩分析', '作业管理', '备份', '分享链接'];
const missWords = needWords.filter((w) => rd.indexOf(w) < 0);
if (missWords.length) {
  die('README 的「功能一览 / 后台能力」里缺这些关键词：' + missWords.join('、')
    + '\n   功能加了就写进去；确实是删掉的功能，同步删掉这条检查。');
}
const staleWords = [
  ['无需后端与数据库', '站点现在有 Cloudflare Worker + Neon，这句是错的'],
  ['v2.6.4 新增', '版本标注过时，改成「v2.6.4 起」或去掉'],
];
const hitStale = staleWords.filter(([k]) => rd.indexOf(k) >= 0);
if (hitStale.length) {
  die('README 里有过时表述：' + hitStale.map(([k, why]) => '「' + k + '」' + why).join('；'));
}
console.log('③i README 已同步到 ' + VER + '（当前版本 / 更新日志首条 / 功能关键词 / 无过时表述）');

/* ---------- ③j 教程 / 导览 / 首页板块 三方一致（v4.12.0）----------
   站主原话（2026-11-11）：「后续我可能会加一些新内容，新内容也需要同时去适配，
   所以这个也要加门禁 —— 以后如果添加了新内容，这两个地方要一起改。」

   四个来源必须给出同一份 key 集合，任何一处缺了就拦：
     · index.html 的 data-topic     —— 首页真实存在的板块（导览走到的对象）
     · tour.js  的 t: '…'           —— 导览步骤（含登录段）
     · guide.html 的 data-topic     —— 教程里对应的说明条目
     · scripts/tour-map.json        —— 唯一登记表（人写的那份）

   新增一个板块时漏掉任何一处，报错会直接点名缺哪个 key。 ------------------- */
{
  const mapPath = path.join(ROOT, 'scripts', 'tour-map.json');
  if (!fs.existsSync(mapPath)) {
    die('缺少 scripts/tour-map.json —— 它是导览与教程的唯一登记表。'
      + '\n   新增板块时要在这里登记，门禁靠它做三向比对。');
  }
  let tmap = null;
  try { tmap = JSON.parse(fs.readFileSync(mapPath, 'utf8')); }
  catch (e) { die('scripts/tour-map.json 不是合法 JSON：' + (e.message || e)); }

  const scenes = (tmap && tmap.scenes) || {};
  const flat = [];
  Object.keys(scenes).forEach((k) => (scenes[k].steps || []).forEach((s) => flat.push(s)));
  const mapKeys = [...new Set(flat)];

  const topicsOf = (html) => [...new Set([...String(html).matchAll(/data-topic="([^"]+)"/g)].map((m) => m[1]))];
  const idxTopics = topicsOf(idx);
  const guidePath = path.join(ROOT, 'guide.html');
  const guideTopics = fs.existsSync(guidePath) ? topicsOf(fs.readFileSync(guidePath, 'utf8')) : [];
  const tourPath = path.join(ROOT, 'tour.js');
  if (!fs.existsSync(tourPath)) {
    die('缺少 tour.js —— 首页导览脚本不在，站点的首次引导会整段失效。');
  }
  const tourSrc = read('tour.js');
  const tourPairs = [...tourSrc.matchAll(/\{\s*t:\s*'([^']+)',\s*sel:\s*'#([^']+)'/g)]
    .map((m) => ({ t: m[1], sel: m[2] }));
  const tourKeys = [...new Set(tourPairs.map((p) => p.t))];

  if (!mapKeys.length) {
    die('scripts/tour-map.json 里没有任何步骤登记（scenes 下的 steps 全为空）。');
  }

  const diff = (a, b) => a.filter((x) => b.indexOf(x) < 0);

  /* ① 首页场景 == index.html 的板块 */
  const homeSteps = ((scenes.home && scenes.home.steps) || []);
  const missInIdx = diff(homeSteps, idxTopics);
  const extraInIdx = diff(idxTopics, homeSteps);
  if (missInIdx.length || extraInIdx.length) {
    die('首页板块与导览登记不一致：'
      + (missInIdx.length ? '\n   · 登记了但首页没有 data-topic：' + missInIdx.join('、') : '')
      + (extraInIdx.length ? '\n   · 首页有 data-topic 但登记表没写：' + extraInIdx.join('、') : '')
      + '\n\n   新增板块五步：① index.html 加 data-topic ② tour-map.json 登记 '
      + '\n   ③ tour.js 加一步 ④ guide.html 加说明条目 ⑤ 重新跑门禁。');
  }

  /* ② 登记表 == tour.js 的步骤 */
  const missInTour = diff(mapKeys, tourKeys);
  const extraInTour = diff(tourKeys, mapKeys);
  if (missInTour.length || extraInTour.length) {
    die('tour-map.json 与 tour.js 不一致：'
      + (missInTour.length ? '\n   · 登记了但 tour.js 没写：' + missInTour.join('、') : '')
      + (extraInTour.length ? '\n   · tour.js 有但登记表没写：' + extraInTour.join('、') : '')
      + '\n\n   tour.js 的步骤格式：{ t: \'板块key\', sel: \'#元素id\', title: \'…\', text: \'…\' }');
  }

  /* ③ 登记表 == guide.html 的说明条目 */
  const missInGuide = diff(mapKeys, guideTopics);
  const extraInGuide = diff(guideTopics, mapKeys);
  if (missInGuide.length || extraInGuide.length) {
    die('使用教程与登记表不一致：'
      + (missInGuide.length ? '\n   · 登记了但 guide.html 没有说明条目：' + missInGuide.join('、') : '')
      + (extraInGuide.length ? '\n   · guide.html 有但登记表没写：' + extraInGuide.join('、') : '')
      + '\n\n   guide.html 里给条目加 data-topic="板块key"，教程与导览必须同时覆盖。');
  }

  /* ④ 首页那一段的锚点必须真的存在（id 写错时导览会定位到左上角） */
  const badSel = [];
  tourPairs.filter((p) => homeSteps.indexOf(p.t) >= 0).forEach((p) => {
    if (idx.indexOf('id="' + p.sel + '"') < 0) badSel.push(p.t + ' → #' + p.sel);
  });
  if (badSel.length) {
    die('tour.js 里的锚点在 index.html 找不到：\n   ' + badSel.join('\n   ')
      + '\n   元素被改名或删掉后，导览会定位到屏幕左上角。');
  }

  /* ⑤ 两个新文件必须进 Service Worker 预缓存（断网时打不开 = 白装） */
  if (!/['"]\.\/tour\.js['"]/.test(sw)) {
    die('sw.js 的 PRECACHE 里没有 ./tour.js —— 离线设备首次进入时导览会静默失效。');
  }
  if (!/['"]\.\/guide\.html['"]/.test(sw)) {
    die('sw.js 的 PRECACHE 里没有 ./guide.html —— 断网时教程页打不开。');
  }

  console.log('③j 教程 / 导览 / 板块一致：' + mapKeys.length + ' 个条目'
    + '（首页 ' + homeSteps.length + ' 步，登录 ' + ((scenes.login && scenes.login.steps.length) || 0) + ' 步）');
}

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
 * ④ 部署路线（写死在这里，省得每次重新摸一遍）
 * ----------------------------------------------------------------------------
 * 站主原话（2026-11-09）：「我们推送是推送到 Gitee 上的，你去找 GitHub 是没有用的；
 *   Gitee 会自动同步源码到 GitHub，推送用 token，token 在服务站后台的令牌管理里。
 *   这个一定要记住放在门禁里，省得每次都要搜一遍，浪费我时间，也浪费 token。」
 *
 *   · 远端只有一个：Gitee `zikang0529/class-site`（GitHub 是镜像，别直接查它的提交）
 *   · 推送：`node scripts/push-gitee.mjs`（令牌从 /api/admin?action=secrets 现取，
 *     用完即删，不落盘、不进仓库）
 *   · 生效等待：只改前端 → 最多 20 秒；动了 api/worker.mjs（Cloudflare）→ 最多 3 分钟，
 *     每 1 分钟看一次
 *   · 验收：用内置浏览器打开线上地址看真实效果（别把整页下载下来比对）
 * ========================================================================= */
console.log('④ 部署路线：Gitee zikang0529/class-site → 自动同步 GitHub → GitHub Pages');
console.log('   推送：node scripts/push-gitee.mjs   等待：前端 ≤20s / Worker ≤3min（每 1 分钟看一次）');
console.log('   验收：内置浏览器打开线上页看效果，不要整页下载比对\n');

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
