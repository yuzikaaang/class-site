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

/* ---------------- ② admin.html 内联大脚本 → admin.js ---------------- */
let adm = read('admin.html');
if (!/src="\.\/admin\.js/.test(adm)) {
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
if (idx !== before) write('index.html', idx);

/* ---------------- ④ admin.html 引用的 admin.js 也要带新版本号 ----------------
   v3.9.19 发现：拆包那次写死了 ?v=3915，之后每次升版本都没再改，
   结果是后台改了、浏览器还拿旧缓存（尤其配合 SW 的缓存优先）。
   这里每次构建都同步一次，避免再漏。 */
let adm3 = read('admin.html');
const adm3Before = adm3;
adm3 = adm3.replace(/<script src="\.\/admin\.js(\?v=\d+)?"><\/script>/,
  `<script src="./admin.js${TAG}"></script>`);
if (adm3 !== adm3Before) write('admin.html', adm3);

/* ---------------- 报告 ---------------- */
const admHtml = read('admin.html');
const admJs = fs.existsSync(path.join(ROOT, 'admin.js')) ? read('admin.js') : '';
console.log('构建完成 v' + VER);
console.log('  app.js      ' + kb(appSrc.length).padStart(7) + ' raw / ' + kb(gz(appSrc)).padStart(7) + ' gzip');
console.log('  app.min.js  ' + kb(appMin.length).padStart(7) + ' raw / ' + kb(gz(appMin)).padStart(7) + ' gzip   ← 首屏用这个');
if (admJs) {
  console.log('  admin.html  ' + kb(admHtml.length).padStart(7) + ' raw / ' + kb(gz(admHtml)).padStart(7) + ' gzip');
  console.log('  admin.js    ' + kb(admJs.length).padStart(7) + ' raw / ' + kb(gz(admJs)).padStart(7) + ' gzip');
}
