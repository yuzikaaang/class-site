#!/usr/bin/env node
/* ============================================================================
 * copycheck.mjs —— 站内文案书面化检查（v4.4.5）
 * ----------------------------------------------------------------------------
 * 站主原话（2026-11-05）：
 *   「站内的语言需要用官方的，平常你跟我聊天可以用通俗一点的，包括站内的公告啊，
 *     一些文字提示什么都要官方。」
 *   「这个以后要进入你们部署前的一个文件就检查，没有出现这种语言才可以部署。」
 *
 * 所以：扫描「同学能看到的文案」，命中口语 / 第二人称 / 内部词就报错，
 * 由 predeploy.mjs 调用；不过就不许部署。
 *
 * 用法：
 *   node scripts/copycheck.mjs            # 只报错，退出码 1（门禁用这个）
 *   node scripts/copycheck.mjs --list     # 打印全部命中（修文案时用）
 *
 * 豁免方式：
 *   · 行尾加 `/* copy-ok *\/`        → 该行不检查
 *   · 在文件里加 `<!-- copy-ok-start -->` / `<!-- copy-ok-end -->` 区块
 * ========================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIST = process.argv.includes('--list');

/* 只扫「用户可见文案」所在的文件。
   ⚠️ 不要扫 api/ 与 scripts/ —— 那里是接口与工具，不是给人看的。 */
const FILES = [
  'index.html', 'app.js', 'big.js', 'pickfx.js', 'clock.html',
  'admin.html', 'admin-1.js', 'admin-2.js', 'admin-3.js',
  'share.html', 'share-card.js', 'basic.html', 'info.html',
  /* v4.12.0：教程页与导览文案同样是同学直接看到的，一并检查 */
  'guide.html', 'tour.js',
];

/* ---------- 规则表 ----------
   re 命中即算；name 是给人看的解释，why 是改法提示。 */
const RULES = [
  /* ① 口语动词 / 语气 */
  { re: /点一下|点一下|点开|点右边|点左边|点这里/, name: '口语动作', why: '统一用「点击」，并写清点击对象' },
  { re: /试试|试一下|试了|尝试一下/, name: '口语劝说', why: '改为「请重试」「请检查后重试」' },
  { re: /搞定|弄好|弄了|弄一下|搞一下|搞定啦/, name: '口语动词', why: '改为「完成」「修复」「处理」' },
  { re: /别忘|记得点|千万别|不用怕|不用担心|放心用|放心使用/, name: '口语劝告', why: '改为「请注意」「无需」「可放心使用」→「可正常使用」' },
  { re: /敬请期待|敬请关注|即将上线|马上就来/, name: '宣传腔', why: '改为「开发中」「暂未开放」' },
  { re: /咱们|咱班|咱|小伙伴|同学们快|快来/, name: '口语称谓', why: '改为「本班」「成员」' },
  { re: /啥|咋|干嘛|整一下|搞事情/, name: '方言口语', why: '改为书面词' },
  { re: /其实|反正|随便|蛮好|挺好|挺不错|特别好|超级|贼/, name: '口语副词', why: '改为「实际」「任意」「较好」等' },
  { re: /一目了然|一眼看清|一眼就能|一看就懂|轻松搞定/, name: '口语描述', why: '改为客观陈述' },
  { re: /还没有[^，。！？]{0,12}[。]/, name: '空态口语', why: '改为「暂无……」「尚未……」' },
  { re: /就会出现|就能看到|就会显示|即可进入|就可以了|盯一下|勾一下|点一下/, name: '口语收尾', why: '改为「将显示」「可查看」「请勾选」' },
  { re: /啦|呗|咯|哈(?![希])|嘿嘿|哈哈|嘻嘻/, name: '语气词', why: '删除语气词（「哈希」等术语除外）' },
  /* ② 句末语气词：「……吧。」「……哦！」 */
  { re: /[吧哦呀嘛呢]\s*[。！？…」』"']/, name: '句末语气词', why: '改为陈述句，去掉语气词' },
  /* ③ 第二人称：站内文案用第三人称 / 无主语 */
  { re: /你(可以|能够|需要|要|的|设|填|点|选|看|查|改|们)|您/, name: '第二人称', why: '改为「可」「需」或无主语句，或「当前账号」' },
  /* ④ 内部事项（公告已经查过，这里覆盖页面提示） */
  /* 注：「后台 / 缓存 / 服务器」这类词在说明里是必要的技术背景（如「显示本地缓存」），
     不算口语，不在这里拦。只有公告里才禁止出现内部过程（由 predeploy 的 ③d 管）。 */
];

/* 学习资料正文（成语、古诗、英文例句、知识点）会出现「吧」「呢」等，
   不按文案管。用区块标记跳过：app.js 里 STUDY_DATA 段。 */
const SKIP_BLOCKS = [
  /* app.js：学习卡片 / 每日一言 / 班级签 / 彩蛋语料，都是内容素材，不按界面文案管 */
  { file: 'app.js', start: 'var STUDY_CARDS', end: '];' },
  { file: 'app.js', start: 'var CLASS_SIGN_POOL', end: '];' },
  { file: 'app.js', start: 'function confettiEgg', end: 'SFX.fanfare' },
];

function blankKeepLines(s) {
  return s.replace(/[^\n]/g, ' ');
}

function stripComments(s, file) {
  let out = s.replace(/\/\*[\s\S]*?\*\//g, blankKeepLines);
  if (file.endsWith('.html')) out = out.replace(/<!--[\s\S]*?-->/g, blankKeepLines);
  return out;
}

const hits = [];
for (const f of FILES) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  let raw = fs.readFileSync(p, 'utf8');

  /* 区块豁免 */
  const skipLines = new Set();
  for (const b of SKIP_BLOCKS.filter((x) => x.file === f)) {
    const a = raw.indexOf(b.start);
    if (a < 0) continue;
    const e = raw.indexOf(b.end, a);
    const from = raw.slice(0, a).split('\n').length;
    const to = raw.slice(0, e < 0 ? raw.length : e).split('\n').length;
    for (let i = from; i <= to; i++) skipLines.add(i);
  }
  /* HTML 区块豁免 */
  const reBlock = /<!--\s*copy-ok-start\s*-->([\s\S]*?)<!--\s*copy-ok-end\s*-->/g;
  let bm;
  while ((bm = reBlock.exec(raw))) {
    const from = raw.slice(0, bm.index).split('\n').length;
    const to = raw.slice(0, bm.index + bm[0].length).split('\n').length;
    for (let i = from; i <= to; i++) skipLines.add(i);
  }

  const src = stripComments(raw, f);
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    const ln = i + 1;
    if (skipLines.has(ln)) return;
    if (/^\s*\/\//.test(line)) return;             /* 行注释 */
    if (/copy-ok/.test(raw.split('\n')[i] || '')) return;
    /* 只检查含中文的行，且该行要像「文案」（有引号或 > 文本 <） */
    if (!/[\u4e00-\u9fa5]/.test(line)) return;
    /* 纯代码行（只含变量名/函数）跳过：中文字符必须落在引号或标签文本里 */
    const strings = extractStrings(line);
    if (!strings.length) return;
    for (const text of strings) {
      for (const r of RULES) {
        const m = text.match(r.re);
        if (!m) continue;
        hits.push({
          file: f, line: ln, rule: r.name, why: r.why,
          word: m[0], text: text.trim().slice(0, 80),
        });
      }
    }
  });
}

/* 从一行里抠出「文案片段」：引号内的字符串 + 标签之间的文本 */
function extractStrings(line) {
  const out = [];
  const reQ = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
  let m;
  while ((m = reQ.exec(line))) {
    const t = m[1] || m[2] || m[3] || '';
    if (/[\u4e00-\u9fa5]/.test(t)) out.push(t);
  }
  const reTag = />([^<>]+)</g;
  while ((m = reTag.exec(line))) {
    if (/[\u4e00-\u9fa5]/.test(m[1])) out.push(m[1]);
  }
  return out;
}

/* 同一行同类问题只报一次，避免刷屏 */
const seen = new Set();
const uniq = hits.filter((h) => {
  const k = h.file + ':' + h.line + ':' + h.rule + ':' + h.word;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

if (LIST) {
  for (const h of uniq) {
    console.log(h.file + ':' + h.line + '  [' + h.rule + '] 「' + h.word + '」');
    console.log('    ' + h.text);
  }
}

if (uniq.length) {
  const byFile = {};
  for (const h of uniq) byFile[h.file] = (byFile[h.file] || 0) + 1;
  console.error('\n❌ 站内文案不够书面化，共 ' + uniq.length + ' 处：'
    + Object.entries(byFile).map(([f, n]) => f + ' ' + n).join('，'));
  const show = uniq.slice(0, 12);
  for (const h of show) {
    console.error('   · ' + h.file + ':' + h.line + '  [' + h.rule + '] 「' + h.word + '」 → ' + h.why);
    console.error('     ' + h.text);
  }
  if (uniq.length > show.length) console.error('   …还有 ' + (uniq.length - show.length) + ' 处（node scripts/copycheck.mjs --list 看全部）');
  console.error('\n   站主要求：站内提示与说明用书面表述（陈述句、无第二人称、无语气词）。');
  process.exit(1);
}
console.log('✅ 站内文案检查通过（' + FILES.length + ' 个文件，0 处口语）');
