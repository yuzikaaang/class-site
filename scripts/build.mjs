#!/usr/bin/env node
/* ============================================================================
 * scripts/build.mjs —— 产出「实际发布」的两个大文件
 * ----------------------------------------------------------------------------
 * 目标（站主 2026-10-23）：「你现在还没有做这两个，你现在就可以做掉了」
 *   ① app.js  →  app.min.js   （压缩，首屏少下约 135KB）
 *   ② admin.html 里的 742KB 内联脚本 →  admin.js（拆包，HTML 只剩骨架）
 *
 * 为什么先压缩再拆包：
 *   app.js 77 万字符里相当一部分是注释和缩进，esbuild 去掉后 gzip 从 328KB
 *   降到 193KB；拆包只能省「第二次访问」的重复下载，压缩是每次都省。
 *   两件事一起做，admin 也顺带拆开。
 *
 * 源文件 app.js / admin.html 保持可读，随时可改；build 幂等，可反复跑。
 * 跑法：node scripts/build.mjs
 * ========================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const write = (p, s) => fs.writeFileSync(path.join(ROOT, p), s);
const gz = (s) => zlib.gzipSync(Buffer.from(s)).length;
const kb = (n) => (n / 1024).toFixed(0) + 'KB';

const VER = (read('index.html').match(/var SITE_VERSION = '([\d.]+)'/) || [])[1];
if (!VER) throw new Error('读不到 index.html 里的 SITE_VERSION');
const TAG = '?v=' + VER.replace(/\./g, '');

/* ---------------- ① app.js → app.min.js ---------------- */
const appSrc = read('app.js');
const appOut = await esbuild.transform(appSrc, {
  minify: true,
  keepNames: true,          /* 保留函数名：错误栈与线上排障都还要看名字 */
  target: 'es2017',
  legalComments: 'none',
  charset: 'utf8',
});
const banner = `/* app.min.js · 由 scripts/build.mjs 从 app.js 生成，请勿直接编辑 · v${VER} */\n`;
const appMin = banner + appOut.code;
write('app.min.js', appMin);
const hash = crypto.createHash('sha1').update(appMin).digest('hex').slice(0, 8);
write('.build-meta.json', JSON.stringify({ version: VER, appMin: hash, at: new Date().toISOString() }, null, 2));

/* ---------------- ①-b version.json：前端启动时检查有没有新版 ----------------
   v4.7.11（站主第 2 条）：「每次打开自动检查一次，有新版就弹窗告诉他改了什么」。
   只写版本号 + 最近一条更新内容，几十字节，随便拉。
   更新内容直接从 admin-3.js 的 REL_BUILTIN 取第一条 —— 那是后台「版本更新」里
   站主看到的那份，不会出现「弹窗说的和公告不一样」。 */
let updRel = null;
try {
  const relSrc = fs.readFileSync(path.join(ROOT, 'admin-3.js'), 'utf8');
  const i = relSrc.indexOf('var REL_BUILTIN = [');
  const j = relSrc.indexOf('\n];', i);
  if (i >= 0 && j > i) {
    const arr = Function('return ' + relSrc.slice(i + 'var REL_BUILTIN = '.length, j + 2))();
    if (Array.isArray(arr) && arr.length) updRel = arr[0];
  }
} catch (e) { updRel = null; }
/* v4.11.0：日期取版本记录里那一天，避免凌晨发布时 UTC 与本地差一天
   （首页页脚写「11-10 更新」，version.json 却是 11-09，对不上） */
const _ld = new Date();
const _localYmd = _ld.getFullYear() + '-'
  + String(_ld.getMonth() + 1).padStart(2, '0') + '-' + String(_ld.getDate()).padStart(2, '0');
const updJson = {
  v: VER,
  at: (updRel && updRel.date) || _localYmd,
  title: (updRel && updRel.title) || '',
  items: (updRel && Array.isArray(updRel.items)) ? updRel.items.slice(0, 8) : [],
};
write('version.json', JSON.stringify(updJson, null, 2));

/* ---------------- ② admin.html 内联大脚本 → admin.js ---------------- */
let adm = read('admin.html');
/* v3.19.0：后台脚本已拆成 admin-1/2/3.js 三个普通脚本，admin.html 里不再有大段内联。
   这里只在「还没拆过」时才做一次性抽取，拆完就跳过。 */
const ADM_SPLIT = /src="\.\/admin-1\.js/.test(adm);
if (!ADM_SPLIT && !/src="\.\/admin\.js/.test(adm)) {
  /* 找最后一个 <script>…</script>（742KB 的那个主脚本） */
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  let target = null;
  while ((m = re.exec(adm))) {
    if (m[1].length > 100000) target = m;
  }
  if (!target) throw new Error('admin.html 里没找到大脚本块（可能已经拆过）');

  let body = target[1];
  /* 版本号留在 HTML：部署门禁只读 HTML 这一处 */
  const verLine = (body.match(/var SITE_VERSION = '([\d.]+)';/) || [])[1] || VER;
  const dateLine = (body.match(/var VER_DATE = '([\d-]+)';/) || [])[1] || '';
  body = body
    .replace(/var SITE_VERSION = '[\d.]+';\s*/, '')
    .replace(/var VER_DATE = '[\d-]+';\s*/, '');

  /* admin 只拆包、不压缩：后台脚本里有大量行为断言是从源码里抽函数名跑的，
     压成一行会让「按函数边界抽取」失效。拆包本身已经解决了
     「改后台 HTML 要重下 742KB」的问题，不再为了几十 KB 牺牲可测性。 */
  write('admin.js', `/* admin.js · 由 scripts/build.mjs 从 admin.html 抽出（未压缩） · v${VER} */\n` + body);

  const replacement = '<script>\n/* 版本号留在 HTML：部署门禁只读这一处 */\n'
    + `var SITE_VERSION = '${verLine}';\n`
    + (dateLine ? `var VER_DATE = '${dateLine}';\n` : '')
    + '</script>\n'
    + `<script src="./admin.js${TAG}"></script>`;
  adm = adm.slice(0, target.index) + replacement + adm.slice(target.index + target[0].length);
  write('admin.html', adm);
}

/* ---------------- ③ index.html 指向 app.min.js ---------------- */
let idx = read('index.html');
const before = idx;
idx = idx.replace(/<script src="\.\/app(?:\.min)?\.js(\?v=\d+)?" defer><\/script>/,
  `<script src="./app.min.js${TAG}" defer></script>`);
/* v3.18.0：登录态总线也要跟着版本号走，否则 SW 缓存优先会一直递旧的那份 */
idx = idx.replace(/<script src="\.\/auth-bus\.js(\?v=\d+)?" defer><\/script>/,
  `<script src="./auth-bus.js${TAG}" defer></script>`);
/* v3.19.0：大屏脚本也带版本号，否则 SW 缓存优先会一直递旧的那份 */
idx = idx.replace(/<script src="\.\/big\.js(\?v=\d+)?" defer><\/script>/,
  `<script src="./big.js${TAG}" defer></script>`);
/* v4.7.3：抽取动画脚本一直是手写 ?v=472，升级后没跟着变 —— 浏览器与 SW 可能继续发旧的那份 */
idx = idx.replace(/<script src="\.\/pickfx\.js(\?v=\d+)?" defer><\/script>/,
  `<script src="./pickfx.js${TAG}" defer></script>`);
/* v4.12.0：新手导览脚本必须排在 app.min.js 之前（defer 按顺序执行），
   否则 app.js 启动时 TOUR 还不存在，首页导览会被静默跳过。
   ⚠️ 这里用**内容指纹**而不是版本号：tour.js 不在 app.min.js 里，
   改两句文案不会升版本号，用版本号做串会让老设备的 SW 一直递旧的那一份。 */
const tourHash = crypto.createHash('sha1').update(read('tour.js')).digest('hex').slice(0, 6);
idx = idx.replace(/<script src="\.\/tour\.js(\?[^"]*)?" defer><\/script>/,
  `<script src="./tour.js?v=${tourHash}" defer></script>`);
/* 教程页里的「重看导览」也引用同一个文件，同样换指纹 */
{
  const g = read('guide.html');
  const g2 = g.replace(/<script src="\.\/tour\.js(\?[^"]*)?"><\/script>/,
    `<script src="./tour.js?v=${tourHash}"></script>`);
  if (g2 !== g) write('guide.html', g2);
}
if (idx !== before) write('index.html', idx);

/* ---------------- ④ admin.html 引用的 admin.js 也要带新版本号 ----------------
   v3.9.19 发现：拆包那次写死了 ?v=3915，之后每次升版本都没再改，
   结果是后台改了、浏览器还拿旧缓存（尤其配合 SW 的缓存优先）。
   这里每次构建都同步一次，避免再漏。 */
let adm3 = read('admin.html');
const adm3Before = adm3;
/* v3.19.0：三段各自带版本号，否则 SW / 浏览器缓存会让后台停在旧版。
   注意 \.js 后面必须跟引号或 ?，别把 admin-1.js 也当成 admin.js。 */
adm3 = adm3.replace(/<script src="\.\/admin(-\d+)?\.js(\?v=\d+)?"><\/script>/g,
  (m, part) => `<script src="./admin${part || ''}.js${TAG}"></script>`);
if (adm3 !== adm3Before) write('admin.html', adm3);

/* v4.8.0：全屏守护脚本三个页面都在用（index / clock / admin），
   版本号跟构建走，否则升级后 SW 会一直递旧的那份。 */
for (const f of ['index.html', 'clock.html', 'admin.html']) {
  const src = read(f);
  const out = src.replace(/<script src="\.\/fs-keep\.js(\?v=\d+)?"( defer)?><\/script>/,
    (m, q, d) => `<script src="./fs-keep.js${TAG}"${d || ''}></script>`);
  if (out !== src) write(f, out);
}

/* ---------------- 报告 ---------------- */
const admHtml = read('admin.html');
const admParts = [1, 2, 3].map((i) => 'admin-' + i + '.js').filter((f) => fs.existsSync(path.join(ROOT, f)));
console.log('构建完成 v' + VER);
console.log('  app.js      ' + kb(appSrc.length).padStart(7) + ' raw / ' + kb(gz(appSrc)).padStart(7) + ' gzip');
console.log('  app.min.js  ' + kb(appMin.length).padStart(7) + ' raw / ' + kb(gz(appMin)).padStart(7) + ' gzip   ← 首屏用这个');
console.log('  admin.html  ' + kb(admHtml.length).padStart(7) + ' raw / ' + kb(gz(admHtml)).padStart(7) + ' gzip');
let admTotalRaw = 0, admTotalGz = 0;
for (const f of admParts) {
  const t = read(f);
  admTotalRaw += Buffer.byteLength(t); admTotalGz += gz(t);
  console.log('  ' + f.padEnd(11) + kb(Buffer.byteLength(t)).padStart(6) + ' raw / ' + kb(gz(t)).padStart(6) + ' gzip');
}
if (admParts.length) console.log('  后台脚本合计 ' + kb(admTotalRaw) + ' raw / ' + kb(admTotalGz) + ' gzip（拆成 ' + admParts.length + ' 段）');
