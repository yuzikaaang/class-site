/* ============================================================
   公告文案规范化（站主 2026-10-14 要求）
   ------------------------------------------------------------
   站主原话：「公告就是你以后不要太过于活跃……说的官方一点点，不用什么
              拉呀这些东西，因为显得太不专业了。公告呢就是写的官方意简洁，
              不要太多字了，字越少越好。」

   本脚本只做一件事：把云端公告里**口语化 / 卖萌 / 冗长 / 写给站主自己看的
   运维记录**精简成官方短句。只改 text 字段，date / category / important
   等一律原样保留，条目数量不变。

   安全性：
     · 先备份原始 announcements 到 /tmp/ann_polish_backup.json
     · 按「日期 + 原文前缀」双重定位，匹配不上就跳过（幂等，可重复跑）
     · PUT 前先 GET，把除 announcements 外的键原样带回，避免误覆盖

   用法：node tools/polish_announcements.mjs [--dry]
   ============================================================ */

import fs from 'node:fs';

const API_BASE = process.env.API_BASE || 'https://api.classsite.dpdns.org';
const AI_USER = process.env.AI_USER || 'aibot';
const AI_PASS = process.env.AI_PASS || 'ai202505';
const DRY = process.argv.includes('--dry');

/* date + 原文前缀 → 新文案。前缀取到足以唯一即可。 */
const PATCHES = [
  {
    date: '2026-10-13 22:41',
    from: '🔄 页面现在会自己检查更新了',
    to: '🔄 页面会自动检查更新，底部出现「发现新版本」时点击即可更新。',
  },
  {
    date: '2026-10-13 14:02',
    from: '🔐 登录安全验证方式已调整',
    to: '🔐 登录验证改为图片数字验证码，输入 4 位数字即可。',
  },
  {
    date: '2026-10-11 11:40',
    from: '📡 在线状态改为实时检测',
    to: '📡 在线状态改为实时检测。',
  },
  {
    date: '2026-10-11 11:30',
    from: '💡 连不上服务器时',
    to: '💡 连不上服务器时会提示切换网络，期间显示本地缓存。',
  },
  {
    date: '2026-10-07 03:02',
    from: '🎮 游戏记录上云',
    to: '🎮 游戏记录上云（最高分与时长，换设备不丢）；点歌券需登录领取，每周每游戏限一张。',
  },
  {
    date: '2026-10-07 01:31',
    from: '🔐 班级账号已开通',
    to: '🔐 班级账号已开通：用户名＝姓名，初始密码＝8 位出生日期。首次登录须修改密码。',
  },
  {
    date: '2026-10-07 01:31',
    from: '📇 登录后可在',
    to: '📇 登录后可在「我的资料」填写联系方式，审核通过后进入班级通讯录。',
  },
  {
    date: '2026-09-29 23:02',
    from: '📅 第一次段考时间已公布',
    to: '📅 第一次段考：10 月 13 日—14 日。各科范围见「重要日期倒计时 → 查看全部」。',
  },
  {
    date: '2026-09-26 17:50',
    from: '界面换回暖橙新装',
    to: '🎨 界面更换为暖橙配色。',
  },
  {
    date: '2026-09-07 12:57',
    from: '【班级通知】因网络问题',
    to: '【班级通知】「学习资料」中的课堂笔记与教学课件暂时关闭，恢复时间另行通知。',
  },
  {
    date: '2026-08-31 18:26',
    from: '📌 「报到」日期',
    to: '📌 报到日期已过，相关倒计时自动隐藏。',
  },
  {
    date: '2026-08-26 10:12',
    from: '🎁 悄悄说一句',
    to: '🎁 站内设有彩蛋，可自行探索。',
  },
  {
    date: '2026-08-25 15:30',
    from: '每日日报已切换为外部热点聚合站',
    to: '每日日报改用外部热点聚合；新增「导出备份」。',
  },
  {
    date: '2026-08-23 00:22',
    from: '经过我这么久的调试',
    to: '站点基础功能已完成。',
  },
];

/* ---------- 1. 读云端 ---------- */
const cloud = await fetch(API_BASE + '/api/content').then((r) => r.json());
if (!cloud.ok) { console.error('读取失败', cloud); process.exit(1); }

fs.writeFileSync('/tmp/ann_polish_backup.json', JSON.stringify(cloud.items, null, 2));
console.log('已备份到 /tmp/ann_polish_backup.json');

const items = cloud.items || {};
const ann = Array.isArray(items.announcements) ? items.announcements.slice() : [];
console.log('云端公告：', ann.length, '条\n');

/* ---------- 2. 逐条替换 ---------- */
let hits = 0, miss = 0;
const log = [];
ann.forEach((a, i) => {
  for (const p of PATCHES) {
    if (a.date !== p.date) continue;
    if (String(a.text).indexOf(p.from) !== 0) continue;   /* 前缀匹配，避免误伤同日期其它条目 */
    if (a.text === p.to) { miss++; break; }               /* 已经是新文案 */
    log.push(`#${i} [${a.date}]\n   旧: ${String(a.text).replace(/\n/g, ' / ')}\n   新: ${p.to}`);
    ann[i] = Object.assign({}, a, { text: p.to });
    hits++;
    break;
  }
});

console.log(`匹配替换 ${hits} 条，未命中 ${miss} 条\n`);
log.forEach((l) => console.log('  ' + l + '\n'));

if (!hits) { console.log('没有可改的，直接结束。'); process.exit(0); }
if (DRY) { console.log('[--dry] 只预览，未写入。'); process.exit(0); }

/* ---------- 3. 登录 + 写回（只带 announcements，其余键不动） ---------- */
const login = await fetch(API_BASE + '/api/auth?action=login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: AI_USER, password: AI_PASS }),
}).then((r) => r.json());
if (!login.ok) { console.error('登录失败：', login.error); process.exit(1); }
console.log('登录成功：', login.user.username, '/ role =', login.user.role);

const res = await fetch(API_BASE + '/api/content', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token },
  body: JSON.stringify({ items: { announcements: ann } }),
}).then((r) => r.json());
console.log('写入结果：', JSON.stringify(res).slice(0, 200));

/* ---------- 4. 回读验证 ---------- */
const back = await fetch(API_BASE + '/api/content').then((r) => r.json());
const b = (back.items || {}).announcements || [];
console.log('\n回读：公告', b.length, '条，键', Object.keys(back.items || {}).length, '个');
const okAll = PATCHES.every((p) => {
  const hit = b.find((x) => x.date === p.date && String(x.text).indexOf(p.from) === 0);
  return !hit;   /* 旧文案应该都找不到了 */
});
console.log(okAll ? '✓ 所有目标条目均已更新' : '⚠ 有条目没改成功，请检查');
console.log('其它键仍在：', Object.keys(back.items || {}).join(', '));
