/* ============================================================
   存量数据上云：把 index.html 里硬编码的 SITE_DATA 推到 /api/content
   ------------------------------------------------------------
   为什么要这么做：
     /api/content 是本轮新建的「共享内容通道」，但**只有读、没有写** ——
     前端 index.html 从来没写过它，所以云端一直是空的，
     后台三个面板（公告 / 作业 / 点歌）读到的自然也是空。

   本脚本：
     1. 从 index.html 里把 SITE_DATA 抽出来（不执行页面代码，纯文本解析）
     2. 映射成本轮约定的 8 个内容键
     3. 用 aibot 的 token 走 PUT /api/content 写上去

   幂等性：可以重复跑，后跑的覆盖先跑的（内容型数据，覆盖即最新）。
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';

const SITE = process.env.SITE_DIR || '/tmp/class-site';
const API_BASE = process.env.API_BASE || 'https://api.classsite.dpdns.org';
const AI_USER = process.env.AI_USER || 'aibot';
const AI_PASS = process.env.AI_PASS || 'ai202505';

/* ---------- 1. 从 index.html 里抽 SITE_DATA ---------- */

const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');

/* SITE_DATA = { ... };  这个对象后面跟着的是页面其它代码，
   所以不能用贪婪匹配。用括号配平的方式手工扫一遍最稳。
   起始符可以是 { 或 [（IMPORTANT_DATES 是数组）。 */
function extractObjectLiteral(src, startMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('找不到锚点：' + startMarker);
  const after = i + startMarker.length;
  const b1 = src.indexOf('{', after);
  const b2 = src.indexOf('[', after);
  let braceStart;
  if (b1 < 0) braceStart = b2;
  else if (b2 < 0) braceStart = b1;
  else braceStart = Math.min(b1, b2);
  if (braceStart < 0) throw new Error('锚点后没有 { 或 [');

  let depth = 0;
  let inStr = null;      // 当前字符串引号种类
  let inLine = false;    // //
  let inBlock = false;   // /* */
  let esc = false;

  for (let p = braceStart; p < src.length; p++) {
    const c = src[p];
    const n = src[p + 1];

    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; p++; } continue; }
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }

    if (c === '/' && n === '/') { inLine = true; p++; continue; }
    if (c === '/' && n === '*') { inBlock = true; p++; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }

    if (c === '{' || c === '[') { depth++; continue; }
    if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return src.slice(braceStart, p + 1);
      continue;
    }
  }
  throw new Error('括号没有配平，抽取失败');
}

const literal = extractObjectLiteral(html, 'SITE_DATA =');
console.log('抽取到 SITE_DATA 字面量：', literal.length, '字符');

/* 字面量里有注释、尾逗号，并且引用了同文件里的常量（如 ICON 之类）。
   最稳的求值方式：把它丢进 Function 里跑，但给一个不含任何页面依赖的环境。 */
let SITE_DATA;
try {
  SITE_DATA = new Function('return (' + literal + ');')();
} catch (e) {
  console.error('直接求值失败：', e.message);
  console.error('退而求其次：剥掉注释再试一次');
  const noComment = literal
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  SITE_DATA = new Function('return (' + noComment + ');')();
}

console.log('SITE_DATA 键：', Object.keys(SITE_DATA).join(', '));

/* ---------- 2. 映射到内容键 ---------- */

const items = {};

function put(key, v) {
  if (v === undefined || v === null) return;
  if (Array.isArray(v) && v.length === 0) return;
  items[key] = v;
}

put('announcements', SITE_DATA.announcements);
put('holiday_homeworks', SITE_DATA.holidayHomeworks);
put('homework_notice', SITE_DATA.homeworkNotice);

/* ⚠️ 下面三个以前写的是 SITE_DATA.xxx，但主站根本没有那几个字段 ——
   它们是 CONTENT_MAP 里的死映射（见本轮诊断）。真实来源如下： */

/* important_dates 的真实来源是**独立变量** IMPORTANT_DATES，不在 SITE_DATA 里 */
const impLiteral = extractObjectLiteral(html, 'IMPORTANT_DATES =');
const IMPORTANT_DATES = new Function('return (' + impLiteral + ');')();
console.log('抽取到 IMPORTANT_DATES：', IMPORTANT_DATES.length, '条');
put('important_dates', IMPORTANT_DATES);

/* daily_quote 主站以前压根没这功能（本轮新做），先灌一批默认句子 */
const DEFAULT_QUOTES = [
  '把今天过好，明天自然会有答案。',
  '你现在偷的每一个懒，都是给未来挖的坑。',
  '不是因为看到希望才坚持，而是因为坚持才看到希望。',
  '所有逆袭，都是有备而来。',
  '与其临渊羡鱼，不如退而结网。',
  '慢慢来，比较快。',
  '你只需要比昨天的自己好一点点。',
  '静下心来，答案就在书里。',
  '每一次早起，都是在和昨天的自己拉开距离。',
  '把简单的事做到极致，就是绝招。',
  '别急，该来的都在路上。',
  '熬得住就出众，熬不住就出局。',
  '现在多流汗，将来少流泪。',
  '专注眼前这一题，别想整张卷子。',
  '努力的意义是，以后的日子里放眼望去，全是自己喜欢的人和事。',
  '心之所向，素履以往。',
  '不驰于空想，不骛于虚声。',
  '日拱一卒，功不唐捐。',
  '山高路远，看世界，也找自己。',
  '你努力的样子，就是最好的运气。',
];
put('daily_quote', DEFAULT_QUOTES);

/* site_config 是特殊键：装站点名、门禁、问候语等散字段 */
const siteConfig = {};
['siteName', 'siteSubtitle', 'gateQuestion', 'gateAnswer', 'welcomeTitle'].forEach((k) => {
  if (SITE_DATA[k] !== undefined && SITE_DATA[k] !== null) siteConfig[k] = SITE_DATA[k];
});
put('site_config', Object.keys(siteConfig).length ? siteConfig : null);

console.log('\n准备写入的内容键与体量：');
Object.keys(items).forEach((k) => {
  const v = items[k];
  const n = Array.isArray(v) ? v.length + ' 条' : (typeof v === 'object' ? Object.keys(v).length + ' 个字段' : String(v).slice(0, 40));
  console.log('  ' + k.padEnd(20) + n);
});

/* ---------- 3. 登录拿 token ---------- */

const login = await fetch(API_BASE + '/api/auth?action=login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: AI_USER, password: AI_PASS }),
}).then((r) => r.json());

if (!login.ok) {
  console.error('\n登录失败：', login.error);
  process.exit(1);
}
console.log('\n登录成功：', login.user.username, '/ role =', login.user.role);
const token = login.token;

/* ---------- 4. PUT 上去 ---------- */

const dry = process.argv.includes('--dry');
if (dry) {
  console.log('\n[--dry] 只预览，不写入');
  process.exit(0);
}

const res = await fetch(API_BASE + '/api/content', {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + token,
  },
  body: JSON.stringify({ items }),
}).then((r) => r.json());

console.log('\n写入结果：', JSON.stringify(res).slice(0, 300));

/* ---------- 5. 回读验证 ---------- */

const back = await fetch(API_BASE + '/api/content').then((r) => r.json());
console.log('\n===== 云端回读 =====');
console.log('ok =', back.ok, ' count =', back.count);
Object.keys(back.items || {}).forEach((k) => {
  const v = back.items[k];
  const n = Array.isArray(v) ? v.length + ' 条' : (v && typeof v === 'object' ? Object.keys(v).length + ' 个字段' : String(v).slice(0, 40));
  console.log('  ' + k.padEnd(20) + n);
});
