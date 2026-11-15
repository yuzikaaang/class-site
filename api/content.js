/* ============================================================
 * /api/content —— 班级站点「云端内容」读写接口
 * ------------------------------------------------------------
 * 主站 index.html 里其实早就写好了读取逻辑：
 *   syncCloudContent()  →  api('/content' + (since ? '?since=' + since : ''))
 *   applyCloudContent() →  把云端 items 合并进 window.SITE_DATA
 * 但后端从来没有这个接口，一直 404，被前端的 .catch 静默吞掉，
 * 于是公告/作业一直用 SITE_DATA 里的硬编码兜底。
 *
 * 本文件把这个缺口补上。前端**一行都不用改**即可生效。
 *
 * 存储：复用 user_data 表，不新建表。内容存在「系统账号」名下
 *      （优先 aibot，其次最早的管理员），这样管理员换人也不会丢内容。
 *
 *   GET  /api/content?since=<毫秒时间戳>   读取（登录用户即可，内容本来就是全公开的）
 *   PUT  /api/content                      写入（管理员或 AI 助手）
 * ============================================================ */

import { getSql, jsonCol, systemUserId } from './_lib/db.js';
import {
  cors, handlePreflight, ok, fail, body, requireUser,
  audit, currentUser,
} from './_lib/http.js';

/* 云端内容键 ↔ 前端 CONTENT_MAP 的对应关系见 index.html:4649-4658。
   这里只负责「把这些键存哪儿」。 */
const CONTENT_KEY = 'cls_site_contents';        // 通用内容（作业通知/活动/值日…）
const ANNOUNCE_KEY = 'cls_site_announcements';  // 公告（历史遗留的独立键，一并兼容）

/* 允许通过本接口写入的内容键白名单。
   必须与前端 CONTENT_MAP 保持一致，否则写了前端也不认。
   ⚠️ 只放「前端真的会读」的键。历史上这里放过 song_config / activities，
      但主站根本没有消费它们（song_config 改成直连 VoiceHub，
      活动用的是单数 SITE_DATA.activity），结果是「后台存进去了、首页没反应」，
      排查了很久。加键之前先在 index.html 里搜有没有读取方。 */
const ALLOW_CONTENT_KEYS = [
  'announcements',      // 公告列表
  'holiday_homeworks',  // 假期作业
  'homework_notice',    // 作业通知
  'important_dates',    // 重要日期 / 考试范围
  'daily_quote',        // 每日一言
  'quote_source',       // v3.5.9 每日一言来源 { net: 0|1 }（后台统一配：联网 / 本地库）
  'quote_schedule',     // v3.5.11 本地库排期 { mode, start, every, fixed:{ 'YYYY-MM-DD':[i] } }
  'study_card',         // v2.6.0 学习卡片默认配置（开关/类型/学科），前端首屏读它
  'site_config',        // 站点通用配置
  'popups',             // 通用弹窗引擎（第二十七轮）：开屏弹 + 板块弹
  'dj_schedule',        // 抽歌排期批次（第二十八轮）：从主站本机 localStorage 迁到云端
  'dj_excluded',        // 抽歌排除清单（第二十八轮）：{ songs:[id], reqs:[点歌人] }
  'release_notes',      // 版本更新记录（第二十八轮）：仅后台可见，前台不展示
  'vote_pub',           // v3.5.13 投票公示：{ templates:[{id,name,template}], byVote:{ [voteId]:{tplId,on} } }
  'pick_history',       // v4.4.0 随机点名抽取记录：[{id,at,cond,n,names[],note}]
  'pick_exclude',       // v4.7.0 随机点名的请假 / 不参与名单：{ 姓名: 'leave'|'out' }
  'pick_hist_del',      // v4.7.11 抽取历史墓碑：['pk...'] —— 让「删掉的记录」在所有设备都不再复活
  'hw_settings',        // v4.16.4 作业看板全局设置：{ alertMin, hideMin }（截止前提醒 / 截止后隐藏）
];

/* 课代表能改的字段——只有作业相关。
   这是用户明确确认的授权范围（「仅作业可编辑」），
   课代表碰不了公告、每日一言、重要日期等内容。 */
const HW_EDITABLE_KEYS = ['holiday_homeworks', 'homework_notice'];

/* 单条内容体积上限（字符数）。公告/作业都是纯文本，200KB 绰绰有余；
   设这个上限是防止有人往云端塞大文件把库撑爆。 */
/* v3.7.0：这几个键只有后台用（版本记录 150KB+、抽歌排期、排除清单），
   普通同学拉 /api/content 时直接剔掉 —— 既省流量也省解析时间，
   首屏快好几拍。管理员带着 token 请求时照旧全量返回。 */
const ADMIN_ONLY_KEYS = ['release_notes', 'dj_schedule', 'dj_excluded'];

const MAX_CHARS = 200 * 1024;
/* 单个数组内容的条目上限 */
const MAX_ITEMS = 2000;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  cors(req, res);

  try {
    if (req.method === 'GET') return await readContent(req, res);
    if (req.method === 'PUT') return await writeContent(req, res);
    if (req.method === 'POST' && String(req.query.action || '').toLowerCase() === 'ca-save-subject') {
      return await caSaveSubject(req, res);
    }
    /* v4.16.3：作业合并保存 —— 班级电脑的编辑开关不依赖登录，
       所以给它单独一条「只写作业、按 id 合并」的通道，见 hwSaveMerge 的说明。 */
    if (req.method === 'POST' && String(req.query.action || '').toLowerCase() === 'hw-save') {
      return await hwSaveMerge(req, res);
    }
    /* v4.16.4：作业看板的全局设置（截止前提醒 / 截止后隐藏）单独一条通道。
       跟作业一样不要求登录 —— 班级电脑是改这些的主要设备。 */
    if (req.method === 'POST' && String(req.query.action || '').toLowerCase() === 'hw-prefs') {
      return await hwPrefsSave(req, res);
    }
    return fail(res, 405, '不支持的方法');
  } catch (e) {
    console.error('[content]', req.method, e);
    return fail(res, 500, '服务器内部错误，请稍后重试');
  }
}

/* ---------------- 读取 ----------------
   公开接口：内容（公告、作业）本来就是给全班看的，登录与否都能读。
   这里不做登录校验，是为了让「还没登录的同学」也能看到公告——
   否则开屏引导登录的那个弹窗就没法展示内容了。 */
/** 把数据库给的时间串解析成毫秒；兼容带/不带时区、带/不带毫秒、±HH / ±HHMM / ±HH:MM */
function parseDbTime(v) {
  if (v instanceof Date) return v.getTime() || 0;
  const s = String(v == null ? '' : v).trim();
  if (!s) return 0;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?/);
  if (!m) return Date.parse(s) || 0;
  const ms = m[7] ? Number((m[7] + '000').slice(0, 3)) : 0;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), ms);
  const off = s.match(/([+-])(\d{2}):?(\d{2})?$/);
  if (off) t -= (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3] || 0)) * 60000;
  return t;
}

/* ---------------- v4.10.5（站主第 6 条）：内容读取的内存缓存 ----------------
   站主原话：「还要尽量去省 Neon 数据库……我怕免费额度不够用，可以想想有没有什么办法可以降这个」。
   /api/content 是全班每台设备最频繁的接口（前台每轮同步都要读一次），
   内容是「很多人读、很少人写」的典型 —— 所以缓存在 Worker 实例内存里：
     · 同一个热点实例上 60 秒内只查一次库；
     · 任何一次写入（含 AI 助手 / 课代表改作业）都会立刻把缓存清掉，
       管理员改完公告刷新就能看到，不会出现「改了没生效」的错觉。
   命中率不高的时候也只是回落到原来的一次查询，没有任何副作用。 */
const CONTENT_CACHE_MS = 60 * 1000;
let _cCache = { at: 0, items: null, latest: 0 };

async function loadContentPack(sql) {
  const now = Date.now();
  if (_cCache.items && now - _cCache.at < CONTENT_CACHE_MS) {
    return { items: JSON.parse(JSON.stringify(_cCache.items)), latest: _cCache.latest, cached: true };
  }

  const uid = await systemUserId(sql);
  if (!uid) {
    /* 一个管理员都没有（全新库）：返回空，前端会继续用本地兜底 */
    return { items: {}, latest: 0, empty: true, cached: false };
  }

  /* ⚠️ 必须用「整个数组当一个参数」的写法（与 api/data.js:212 的 unnest 同一套路），
     不要写成 `in (${a}, ${b})`。

     实测（2026-10-06）：写成 `in (${CONTENT_KEY}, ${ANNOUNCE_KEY})` 时，
     查询**不报错、但永远返回 0 行** —— 于是出现
     「写入成功（cloudKeys 里能看到键）、读取为空」的诡异现象，排查了很久。
     根因是 @neondatabase/serverless 的模板标签对这种散装占位展开不正确。 */
  const wantKeys = [CONTENT_KEY, ANNOUNCE_KEY];
  const rows = await sql`
    select data_key, data_value, updated_at
      from user_data
     where user_id = ${uid}
       and data_key = any(${wantKeys}::text[])
  `;

  const items = {};
  let latest = 0;

  rows.forEach((r) => {
    const val = jsonCol(r.data_value);
    if (val === null || val === undefined) return;
    const t = parseDbTime(r.updated_at);
    if (t > latest) latest = t;

    if (r.data_key === ANNOUNCE_KEY) {
      items.announcements = val;
    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
      Object.keys(val).forEach((k) => {
        if (ALLOW_CONTENT_KEYS.includes(k)) items[k] = val[k];
      });
    }
  });

  _cCache = { at: now, items: JSON.parse(JSON.stringify(items)), latest };
  return { items, latest, cached: false };
}

/* 写入 / 删除后一定要调它，否则最多 60 秒后大家才看到新内容 */
function contentCacheDrop() { _cCache = { at: 0, items: null, latest: 0 }; }

async function readContent(req, res) {
  const sql = getSql();
  const since = Number(req.query.since) || 0;

  const pack = await loadContentPack(sql);
  const items = pack.items;
  const latest = pack.latest;
  if (pack.empty) {
    return ok(res, { items: {}, serverTime: Date.now(), empty: true });
  }

  /* v3.7.0：非管理员请求不带后台专用键（见 ADMIN_ONLY_KEYS 注释）。
     判断身份失败时按「普通同学」处理 —— 宁可少给，不能多漏。 */
  let isAdmin = false;
  try {
    if (req.headers && (req.headers.authorization || req.headers.Authorization)) {
      const u = await currentUser(req);
      isAdmin = !!(u && u.role === 'admin');
    }
  } catch (e) { isAdmin = false; }
  if (!isAdmin) {
    ADMIN_ONLY_KEYS.forEach((k) => { delete items[k]; });
  }

  /* v3.9.10（站主）：`since` 以前只回显、不筛选 —— 每 60 秒的轮询都要白拉
     16.6KB（约 1MB/小时）。现在真做增量：内容没变就回空包。 */
  const upToDate = since > 0 && latest > 0 && latest <= since + 1000;
  if (upToDate) {
    return ok(res, {
      items: {},
      serverTime: latest,
      since,
      count: 0,
      notModified: true,
      slim: !isAdmin,
    });
  }

  return ok(res, {
    items,
    serverTime: latest || Date.now(),
    since: since || null,
    count: Object.keys(items).length,
    slim: !isAdmin,
  });
}

/* ---------------- 写入 ----------------
   权限分两档：
     ① 管理员 / AI 助手 → 可改全部内容字段；
     ② 持有「课代表」类头衔的同学 → **只能改作业相关字段**。
   （用户确认过的规则：头衔权限仅作业可编辑。）

   ⚠️ 头衔取自服务端 profiles.title（currentUser 查出来的），前端传什么都不作数。 */
async function writeContent(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;

  const b = await body(req);
  /* 支持两种入参：
       { items: { announcements: [...], homework_notice: {...} } }   批量
       { key: 'announcements', value: [...] }                        单条
     单条写法是为了方便 AI 直接用。 */
  let incoming = {};
  if (b && b.items && typeof b.items === 'object' && !Array.isArray(b.items)) {
    incoming = b.items;
  } else if (b && b.key) {
    incoming = { [String(b.key)]: b.value };
  }

  const keys = Object.keys(incoming);
  if (!keys.length) return fail(res, 400, '没有要写入的内容');

  const bad = keys.filter((k) => !ALLOW_CONTENT_KEYS.includes(k));
  if (bad.length) return fail(res, 400, '不支持的内容键：' + bad.join(', '));

  /* --- 权限判定 ---
     2026-10-06 收紧：课代表不再走 PUT 整包写入（原来只限字段级，
     但整包语义下可以把别的科目清空、改 homework_notice，与
     「课代表只能修改对应科目」的要求冲突）。课代表改作业请走
     POST ?action=ca-save-subject 专用通道，服务端强校验科目头衔。 */
  const isAdmin = u.role === 'admin';
  const isAI = !!u.isAI;

  if (!isAdmin && !isAI) {
    return fail(res, 403, '需要管理员权限');
  }

  /* 体积与结构校验：宁可拒绝，也不要写进去一堆前端渲染不了的东西 */
  for (const k of keys) {
    const v = incoming[k];
    if (v === undefined) return fail(res, 400, `字段 ${k} 的值为 undefined`);
    const s = JSON.stringify(v);
    if (s === undefined) return fail(res, 400, `字段 ${k} 无法序列化`);
    if (s.length > MAX_CHARS) {
      return fail(res, 400, `字段 ${k} 太大（${Math.round(s.length / 1024)}KB，上限 ${MAX_CHARS / 1024}KB）`);
    }
    if (Array.isArray(v) && v.length > MAX_ITEMS) {
      return fail(res, 400, `字段 ${k} 条目过多（${v.length} 条，上限 ${MAX_ITEMS} 条）`);
    }
  }

  const sql = getSql();
  const uid = await systemUserId(sql);
  if (!uid) return fail(res, 500, '没有可用的系统账号，无法保存云端内容');

  /* 先读出现有内容再合并——PUT 是「局部更新」语义，
     避免前端只想改公告却把作业冲掉。 */
  const cur = await sql`
    select data_value from user_data
     where user_id = ${uid} and data_key = ${CONTENT_KEY}
  `;
  /* ⚠️ 这里如果解析失败，绝不能静默当成空文档往下走：
     那会让这次 PUT 只写新内容、把库里的存量（公告/作业…）整包冲掉。
     实测（2026-10-06）就因为 jsonb 解析失败发生过一次「70 条公告被覆盖」。
     读不出来 = 拒绝写入，宁可报错也不能丢数据。 */
  let doc = {};
  if (cur.length) {
    const p = jsonCol(cur[0].data_value);
    if (cur[0].data_value === null || cur[0].data_value === undefined) {
      /* 行存在、值为 NULL → 视作空文档，可以正常初始化 */
      doc = {};
    } else if (p && typeof p === 'object' && !Array.isArray(p)) {
      doc = p;
    } else {
      return fail(res, 500,
        '云端现有内容读不出来，已中止保存以防覆盖历史数据，请联系管理员检查数据库');
    }
  }

  const changed = [];
  keys.forEach((k) => {
    /* 公告走历史键，其余走通用键——与前端的读取路径保持一致 */
    if (k === 'announcements') doc[k] = incoming[k];
    else doc[k] = incoming[k];
    changed.push(k);
  });

  await sql`
    insert into user_data (user_id, data_key, data_value, updated_at)
    values (${uid}, ${CONTENT_KEY}, ${JSON.stringify(doc)}, now())
    on conflict (user_id, data_key)
    do update set data_value = excluded.data_value, updated_at = now()
  `;

  /* 公告同步写一份历史键：老版本前端只认 cls_site_announcements，
     保证「新旧前端混用」时公告也不会丢。 */
  if (incoming.announcements !== undefined) {
    const arrRaw = JSON.stringify(incoming.announcements);
    await sql`
      insert into user_data (user_id, data_key, data_value, updated_at)
      values (${uid}, ${ANNOUNCE_KEY}, ${arrRaw}, now())
      on conflict (user_id, data_key)
      do update set data_value = excluded.data_value, updated_at = now()
    `;
  }

  await audit(u.id, 'content-update', 'site_content', null,
    '更新云端内容：' + changed.join(', '));

  /* v4.10.5：写完立刻清缓存 —— 管理员改完公告刷新就要看到，不能等 60 秒 */
  contentCacheDrop();

  return ok(res, {
    message: '已保存',
    updated: changed,
    serverTime: Date.now(),
  });
}

/* ---------------- 作业合并保存（v4.16.3·站主第 3 条） ----------------
   POST ?action=hw-save   body: { list: [...], dels?: ['期次 id'], dev?: '设备名' }

   为什么单独开一条通道：
     大屏作业页的「编辑」开关刻意做成不依赖登录（班级电脑登不了管理员，
     也常年没空去登），但 PUT /api/content 要求 admin / AI。
     结果就是：班级电脑改的作业只落在本机，云端永远等不到，
     手机端再加一科，云端还是一份没有电脑改动的旧数据 —— 两边互相覆盖。

   为什么是「按 id 合并」而不是整包替换：
     两台设备各自只在手里那份上改，谁先上传谁的整包就赢，
     另一台的改动当场消失（站主实测：电脑改了语文，手机加了化学，语文被冲掉）。
     这里先把云端那份读出来，按 id 逐期合并，只让「出发的这台机器明确改过的期次」
     覆盖同 id 的旧记录，其余期次原样保留。这样电脑的语文和手机的化学可以共存。

   安全口径：
     · 只认 holiday_homeworks 这一个键，别的键一律不动（公告等仍要管理员）；
     · 不接受整包清空（list 与 dels 都为空直接拒）；
     · 体积上限与 PUT 一致；
     · 每次写入记一条审计，出问题能倒查。 */
/* 按 id 合并两份作业列表（导出以便脚本直接测，不依赖数据库）：
     · 云端已有的期次先占位（保序），
     · 提交上来的同 id 期次就地覆盖（这是「这台机器明确改过的那一期」），
     · 提交上来的新 id 追加到末尾，
     · dels 里的 id 删掉（给整期删除留的口子，当前前端还没有整期删除）。 */
export function mergeHwById(prev, incoming, dels) {
  const byId = new Map();
  const order = [];
  const put = (h) => {
    if (!h || typeof h !== 'object') return;
    if (h.id === undefined || h.id === null || h.id === '') return;
    const id = String(h.id);
    if (!byId.has(id)) order.push(id);
    byId.set(id, h);
  };
  (Array.isArray(prev) ? prev : []).forEach(put);
  (Array.isArray(incoming) ? incoming : []).forEach(put);
  (Array.isArray(dels) ? dels : []).forEach((id) => { byId.delete(String(id)); });
  return order.filter((id) => byId.has(id)).map((id) => byId.get(id));
}

async function hwSaveMerge(req, res) {
  const b = await body(req);
  const incoming = Array.isArray(b && b.list) ? b.list : null;
  if (!incoming) return fail(res, 400, 'list 必须是数组');
  const dels = Array.isArray(b && b.dels) ? b.dels.map(String) : [];
  if (!incoming.length && !dels.length) return fail(res, 400, '没有要保存的作业');

  for (const h of incoming) {
    if (!h || typeof h !== 'object' || Array.isArray(h)) {
      return fail(res, 400, '作业期次格式不对');
    }
  }
  const rawLen = JSON.stringify(incoming).length;
  if (rawLen > MAX_CHARS) {
    return fail(res, 400, `作业内容太大（${Math.round(rawLen / 1024)}KB，上限 ${MAX_CHARS / 1024}KB）`);
  }
  if (incoming.length > MAX_ITEMS) {
    return fail(res, 400, `作业期次过多（${incoming.length} 条，上限 ${MAX_ITEMS} 条）`);
  }

  const sql = getSql();
  const uid = await systemUserId(sql);
  if (!uid) return fail(res, 500, '没有可用的系统账号，无法保存云端作业');

  const cur = await sql`
    select data_value from user_data
     where user_id = ${uid} and data_key = ${CONTENT_KEY}
  `;
  /* 同 writeContent：读不出来就拒绝，绝不把整包存量冲掉 */
  let doc = {};
  if (cur.length) {
    const p = jsonCol(cur[0].data_value);
    if (cur[0].data_value === null || cur[0].data_value === undefined) doc = {};
    else if (p && typeof p === 'object' && !Array.isArray(p)) doc = p;
    else {
      return fail(res, 500,
        '云端现有内容读不出来，已中止保存以防覆盖历史数据，请联系管理员检查数据库');
    }
  }

  const prev = Array.isArray(doc.holiday_homeworks) ? doc.holiday_homeworks : [];
  const merged = mergeHwById(prev, incoming, dels);

  /* v4.16.4（站主）：「作业上传可以不匿名」—— 谁改的就记在谁名下，
     不再是一份没有作者的公共文档。登录了就记用户名；班级电脑通常没登录，
     就记这台设备报上来的名字，再退回设备标识。
     ⚠️ 署名只用于「这是谁改的」这类追溯，不参与权限判断 ——
        写作业的门槛仍然只看这条通道本身（只认作业、按 id 合并）。 */
  let who = '';
  try {
    const u = await currentUser(req);
    if (u) who = String(u.displayName || u.username || '').trim();
  } catch (e) { /* 没带 token / 会话过期，按未登录处理 */ }
  if (!who && b && b.by) who = String(b.by).trim().slice(0, 40);
  if (!who && b && b.dev) who = String(b.dev).trim().slice(0, 40);
  if (!who) who = '未署名设备';
  const nowIso = new Date().toISOString();
  const touched = new Set(incoming.map((h) => String(h.id)));
  merged.forEach((h) => {
    if (!h || typeof h !== 'object' || !touched.has(String(h.id))) return;
    h.by = who;
    h.at = nowIso;
  });

  doc.holiday_homeworks = merged;

  await sql`
    insert into user_data (user_id, data_key, data_value, updated_at)
    values (${uid}, ${CONTENT_KEY}, ${JSON.stringify(doc)}, now())
    on conflict (user_id, data_key)
    do update set data_value = excluded.data_value, updated_at = now()
  `;

  contentCacheDrop();

  try {
    await audit(uid, 'hw-save-merge', 'site_content', null,
      '作业合并保存：提交 ' + incoming.length + ' 期 / 云端共 ' + merged.length + ' 期'
      + (dels.length ? ' / 删除 ' + dels.length + ' 期' : '')
      + ' / 修改人 ' + who);
  } catch (e) { /* 审计失败不影响保存 */ }

  return ok(res, {
    message: '已保存',
    list: merged,
    count: merged.length,
    by: who,
    serverTime: Date.now(),
  });
}

/* ---------------- v4.16.4：作业看板的全局设置 ----------------
   站主原话：「作业看板里面的那个设置……也包含修改就是全局的，
   比如说截止前 n 分钟强调提醒、过了截止 n 分钟隐藏该项，
   这个设置是要上传云端的，所以呢我修改是同步的」。
   两个 n 都是「分钟」，范围 0–1440（一天），0 表示关掉这项行为。
   跟作业同一条匿名通道：班级电脑是主要操作设备，不能卡在登录上。 */
const HW_PREF_DEF = { alertMin: 30, hideMin: 60 };
const HW_PREF_MAX = 1440;

function hwPrefNum(v, def) {
  const n = Number(v);
  if (!isFinite(n)) return def;
  return Math.max(0, Math.min(HW_PREF_MAX, Math.round(n)));
}

async function hwPrefsSave(req, res) {
  const b = await body(req);
  const src = (b && b.prefs && typeof b.prefs === 'object') ? b.prefs : b;
  const prefs = {
    alertMin: hwPrefNum(src && src.alertMin, HW_PREF_DEF.alertMin),
    hideMin: hwPrefNum(src && src.hideMin, HW_PREF_DEF.hideMin),
  };

  const sql = getSql();
  const uid = await systemUserId(sql);
  if (!uid) return fail(res, 500, '没有可用的系统账号，无法保存看板设置');

  const cur = await sql`
    select data_value from user_data
     where user_id = ${uid} and data_key = ${CONTENT_KEY}
  `;
  let doc = {};
  if (cur.length) {
    const p = jsonCol(cur[0].data_value);
    if (cur[0].data_value === null || cur[0].data_value === undefined) doc = {};
    else if (p && typeof p === 'object' && !Array.isArray(p)) doc = p;
    else return fail(res, 500, '云端现有内容读不出来，已中止保存以防覆盖历史数据');
  }

  doc.hw_settings = prefs;

  await sql`
    insert into user_data (user_id, data_key, data_value, updated_at)
    values (${uid}, ${CONTENT_KEY}, ${JSON.stringify(doc)}, now())
    on conflict (user_id, data_key)
    do update set data_value = excluded.data_value, updated_at = now()
  `;

  contentCacheDrop();

  try {
    await audit(uid, 'hw-prefs-save', 'site_content', null,
      '作业看板设置：截止前 ' + prefs.alertMin + ' 分钟提醒 / 截止后 '
      + prefs.hideMin + ' 分钟隐藏'
      + (b && b.dev ? ' / 来自 ' + String(b.dev).slice(0, 40) : ''));
  } catch (e) { /* 审计失败不影响保存 */ }

  return ok(res, { message: '已保存', prefs, serverTime: Date.now() });
}

/* ---------------- 课代表：单科作业保存（2026-10-06） ----------------
   POST ?action=ca-save-subject   body: { subject, tasks, homeworkId? }

   规则（站主拍板「课代表只能修改对应科目」）：
     · 持有「语文课代表」头衔 → 只能改 subject=语文 的任务；
       通用「课代表」头衔不含具体科目，不给作业编辑权。
     · 管理员 / AI 助手不受限（调试与兜底）。
     · 目标条目：homeworkId 指定；缺省取 holiday_homeworks 里 end 最大的一条
       （= 当前生效的那份作业）。
     · tasks 的条目要么是字符串，要么是 {text, img?, audio?, audioLabel?} 对象
       （附件 URL 由前端保真回传，服务端只做形状校验，不重建对象）。
   本接口只动该科目的 tasks，作业的 start/end 与其他科目原样保留。 */
async function caSaveSubject(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;

  const b = await body(req);
  const subject = String(b.subject || '').trim();
  const KNOWN_SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理', '其他'];
  if (!KNOWN_SUBJECTS.includes(subject)) {
    return fail(res, 400, '不认识的科目：' + (subject || '（空）'));
  }

  const isAdmin = u.role === 'admin' || !!u.isAI;
  if (!isAdmin) {
    const titles = String(u.title || '')
      .split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
    if (!titles.includes(subject + '课代表')) {
      return fail(res, 403, '你不是「' + subject + '课代表」，不能修改该科目');
    }
  }

  const tasks = b.tasks;
  if (!Array.isArray(tasks)) return fail(res, 400, 'tasks 必须是数组');
  if (tasks.length > 100) return fail(res, 400, '任务条数过多（上限 100 条）');
  for (const t of tasks) {
    if (typeof t === 'string') {
      if (t.length > 500) return fail(res, 400, '单条任务太长（上限 500 字）');
      continue;
    }
    if (t && typeof t === 'object' && !Array.isArray(t)) {
      /* video 字段是 2026-10-07 第二十五轮加的，第二十六轮保留了它 ——
         虽然「上传到服务器」的功能已经撤掉（R2 要绑卡、数据胶囊要实名），
         但附件改走「站主手动放文件 + 填直链」后，视频仍然需要独立字段：
         ⚠️ 前端 _renderHwItems 会读 .video 并渲染 <video>，
            校验这里漏放行会导致「前端填上去、保存时报格式不对」，
            表现是「链接填了但存不了」，很难从报错里看出是校验问题。 */
      const shapeOk = typeof t.text === 'string' && t.text.length <= 500 &&
        (t.img === undefined || t.img === null || typeof t.img === 'string') &&
        (t.audio === undefined || t.audio === null || typeof t.audio === 'string') &&
        (t.video === undefined || t.video === null || typeof t.video === 'string') &&
        (t.audioLabel === undefined || t.audioLabel === null || typeof t.audioLabel === 'string');
      if (!shapeOk) return fail(res, 400, '任务条目格式不对（应为文本或 {text, img/audio/video} 附件对象）');
      continue;
    }
    return fail(res, 400, '任务条目格式不对（应为文本或附件对象）');
  }

  const sql = getSql();
  const uid = await systemUserId(sql);
  if (!uid) return fail(res, 500, '没有可用的系统账号');

  /* 读现有文档。与 writeContent 相同的铁律：读不出来 = 拒绝写入，
     绝不静默当空文档，防止把 70 条公告 + 全部作业冲掉。 */
  const cur = await sql`
    select data_value from user_data
     where user_id = ${uid} and data_key = ${CONTENT_KEY}
  `;
  let doc = {};
  if (cur.length) {
    const p = jsonCol(cur[0].data_value);
    if (cur[0].data_value === null || cur[0].data_value === undefined) {
      doc = {};
    } else if (p && typeof p === 'object' && !Array.isArray(p)) {
      doc = p;
    } else {
      return fail(res, 500, '云端现有内容读不出来，已中止保存以防覆盖历史数据，请联系管理员');
    }
  }

  const list = Array.isArray(doc.holiday_homeworks) ? doc.holiday_homeworks : [];
  let hw = null;
  if (b.homeworkId) {
    hw = list.find((h) => h && String(h.id) === String(b.homeworkId)) || null;
    if (!hw) return fail(res, 404, '找不到指定的作业条目：' + b.homeworkId);
  } else {
    for (const h of list) {
      if (h && (!hw || String(h.end || '') > String(hw.end || ''))) hw = h;
    }
    if (!hw) return fail(res, 404, '云端还没有作业条目，请先让管理员发布一份作业');
  }
  if (!Array.isArray(hw.items)) hw.items = [];

  const entry = { subject, tasks: tasks };
  const hit = hw.items.some((it) => it && it.subject === subject);
  hw.items = hit
    ? hw.items.map((it) => (it && it.subject === subject) ? entry : it)
    : hw.items.concat([entry]);
  doc.holiday_homeworks = list;

  await sql`
    insert into user_data (user_id, data_key, data_value, updated_at)
    values (${uid}, ${CONTENT_KEY}, ${JSON.stringify(doc)}, now())
    on conflict (user_id, data_key)
    do update set data_value = excluded.data_value, updated_at = now()
  `;

  await audit(u.id, 'content-ca-subject', 'site_content', String(hw.id || ''),
    (isAdmin ? '管理员' : '课代表') + '修改作业科目「' + subject + '」（' + tasks.length + ' 条）');

  contentCacheDrop();   /* v4.10.5：同上，改完立刻可见 */

  return ok(res, {
    message: subject + ' 已保存',
    homeworkId: hw.id || null,
    serverTime: Date.now(),
  });
}
