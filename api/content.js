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

import { getSql } from './_lib/db.js';
import {
  cors, handlePreflight, ok, fail, body, requireUser,
  audit,
} from './_lib/http.js';

/* 云端内容键 ↔ 前端 CONTENT_MAP 的对应关系见 index.html:4649-4658。
   这里只负责「把这些键存哪儿」。 */
const CONTENT_KEY = 'cls_site_contents';        // 通用内容（作业通知/活动/值日…）
const ANNOUNCE_KEY = 'cls_site_announcements';  // 公告（历史遗留的独立键，一并兼容）

/* 允许通过本接口写入的内容键白名单。
   必须与前端 CONTENT_MAP 保持一致，否则写了前端也不认。 */
const ALLOW_CONTENT_KEYS = [
  'announcements',      // 公告列表
  'holiday_homeworks',  // 假期作业
  'homework_notice',    // 作业通知
  'important_dates',    // 重要日期
  'daily_quote',        // 每日一句
  'song_config',        // 点歌配置
  'activities',         // 活动列表
  'site_config',        // 站点通用配置
];

/* 课代表能改的字段——只有作业相关。
   这是用户明确确认的授权范围（「仅作业可编辑」），
   课代表碰不了公告、点歌配置等其它内容。 */
const HW_EDITABLE_KEYS = ['holiday_homeworks', 'homework_notice'];

/* 单条内容体积上限（字符数）。公告/作业都是纯文本，200KB 绰绰有余；
   设这个上限是防止有人往云端塞大文件把库撑爆。 */
const MAX_CHARS = 200 * 1024;
/* 单个数组内容的条目上限 */
const MAX_ITEMS = 2000;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  cors(req, res);

  try {
    if (req.method === 'GET') return await readContent(req, res);
    if (req.method === 'PUT') return await writeContent(req, res);
    return fail(res, 405, '不支持的方法');
  } catch (e) {
    console.error('[content]', req.method, e);
    return fail(res, 500, '服务器内部错误，请稍后重试');
  }
}

/* ---------------- 找「系统账号」 ----------------
   内容挂在谁名下？优先 AI 助手（它不会毕业、不会换人），
   没有就退回到最早创建的管理员。
   这样即使具体管事的同学毕业了、账号被删了，内容也不会跟着丢。 */
async function systemUserId(sql) {
  const ai = await sql`
    select id from users
     where is_ai = true and status = 'active'
     order by id limit 1
  `;
  if (ai.length) return Number(ai[0].id);

  const adm = await sql`
    select id from users
     where role = 'admin' and status = 'active'
     order by id limit 1
  `;
  if (adm.length) return Number(adm[0].id);

  return null;
}

/* ---------------- 读取 ----------------
   公开接口：内容（公告、作业）本来就是给全班看的，登录与否都能读。
   这里不做登录校验，是为了让「还没登录的同学」也能看到公告——
   否则开屏引导登录的那个弹窗就没法展示内容了。 */
async function readContent(req, res) {
  const sql = getSql();
  const since = Number(req.query.since) || 0;

  const uid = await systemUserId(sql);
  if (!uid) {
    /* 一个管理员都没有（全新库）：返回空，前端会继续用本地兜底 */
    return ok(res, { items: {}, serverTime: Date.now(), empty: true });
  }

  const rows = await sql`
    select data_key, data_value, updated_at
      from user_data
     where user_id = ${uid}
       and data_key in (${CONTENT_KEY}, ${ANNOUNCE_KEY})
  `;

  const items = {};
  let latest = 0;

  rows.forEach((r) => {
    const raw = r.data_value;
    if (!raw) return;
    let val;
    try { val = JSON.parse(raw); } catch { return; }
    if (val === null || val === undefined) return;

    /* 时间戳：用于增量判断。数据库给的是 SQL 字符串，交给 JS 解析。 */
    const t = Date.parse(String(r.updated_at).replace(' ', 'T') + 'Z') || 0;
    if (t > latest) latest = t;

    if (r.data_key === ANNOUNCE_KEY) {
      /* 历史键：里面直接就是公告数组 */
      items.announcements = val;
    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
      /* 通用键：里面是 { contentKey: value } 的字典 */
      Object.keys(val).forEach((k) => {
        if (ALLOW_CONTENT_KEYS.includes(k)) items[k] = val[k];
      });
    }
  });

  /* since 之后的增量：这里直接把全量返回。
     内容总量很小（几 KB），做增量反而容易因为客户端时间不准而漏内容。
     保留 since 参数是为了兼容前端的调用方式，不改变行为。 */
  return ok(res, {
    items,
    serverTime: latest || Date.now(),
    since: since || null,
    count: Object.keys(items).length,
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

  /* --- 权限判定 --- */
  const isAdmin = u.role === 'admin';
  const isAI = !!u.isAI;
  const myTitles = String(u.title || '')
    .split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
  /* 有「课代表」或某个具体科目的课代表，都算作业可编辑 */
  const canEditHw = myTitles.some((t) => t === '课代表' || /课代表$/.test(t));

  if (!isAdmin && !isAI && !canEditHw) {
    return fail(res, 403, '需要管理员权限');
  }
  /* 课代表只能碰作业相关字段 */
  if (!isAdmin && !isAI && canEditHw) {
    const illegal = keys.filter((k) => !HW_EDITABLE_KEYS.includes(k));
    if (illegal.length) {
      return fail(res, 403, '你只能修改作业相关内容，不能改：' + illegal.join(', '));
    }
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
  let doc = {};
  if (cur.length && cur[0].data_value) {
    try {
      const p = JSON.parse(cur[0].data_value);
      if (p && typeof p === 'object' && !Array.isArray(p)) doc = p;
    } catch { doc = {}; }
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

  return ok(res, {
    message: '已保存',
    updated: changed,
    serverTime: Date.now(),
  });
}
