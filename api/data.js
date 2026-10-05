/* ============================================================
   /api/data  —— 个人数据云同步
   ------------------------------------------------------------
   GET    /api/data              列出当前用户云端所有键与更新时间
   GET    /api/data?key=xxx      取某一条
   PUT    /api/data              写入/覆盖（body: { items: { key: value, ... } }）
   DELETE /api/data?key=xxx      删除某一条

   设计：只允许同步「个人数据」，不允许同步站内容。
   前端传上来的 key 必须在白名单里，避免有人往里塞垃圾把库撑爆。
   ============================================================ */

import { getSql } from './_lib/db.js';
import {
  cors, handlePreflight, ok, fail, body, requireUser, requireUserReady, audit,
} from './_lib/http.js';

/* 允许云同步的键白名单。新增同步项时在这里加一行即可。
   前缀匹配用结尾的 *，如 'cls_dj_note_*'

   ⚠️ 2026-10-05：按用户要求「尽量都同步」做过一次扩充。
      改这里**必须同步改前端** index.html 的 CLOUD_KEYS，
      两边对不上会出现「前端以为能同步、后端 403 拒绝」的静默失败。

   有意不放行的键（安全 / 设备相关）：
     cls_auth / cls_site_gate / cls_lock_* / cls_gate_* / cls_device_id */
const ALLOW_KEYS = [
  /* 外观与界面 */
  'cls_theme',              // 主题（亮/暗）
  'cls_theme_auto',         // 是否跟随系统
  'cls_ui_cfg',             // 界面设置（字号/背景/排序/动效）
  'cls_ui_bgimg',           // 自定义背景图
  'cls_sfx',                // 音效开关
  /* 各种「已看过 / 已关闭」的标记：换设备不该重复打扰 */
  'cls_welcome_v1',         // 欢迎弹窗是否已看过
  'cls_login_guide_v1',     // 登录引导弹窗是否已看过（2026-10-05 加）
  'cls_study_notice_dismissed',
  'cls_welcome_hide',
  'cls_exam_tip_seen',
  'cls_holiday_tip_seen',
  'cls_exam_scope_seen',
  /* 点歌相关 */
  'cls_dj_excluded',        // 点歌：自己排除的曲目
  'cls_dj_excluded_req',    // 点歌：申请排除
  'cls_dj_note',            // 点歌：备注
  'cls_dj_schedule',        // 点歌：排期
  'cls_dj_my_songs',        // 点歌：我点过的歌
  'cls_dj_pending',         // 点歌：待审核
  'cls_dj_history',         // 点歌：历史记录
  'cls_dj_copy_note',       // 点歌：复制备注
  /* 学习与班级事务 */
  'cls_study_plan',         // 学习计划
  'cls_notice_read',        // 通知已读位点
  'cls_class_list',         // 班级名单（用户自存）
  /* 站内偏好 */
  'cls_ann_filter',         // 公告分类筛选
  'cls_board_collapsed',    // 公告栏折叠
  'cls_side_open',          // 侧边栏展开
  'cls_return_view',        // 上次停留的视图
  /* 前缀匹配 */
  'cls_hw_done_*',          // 作业完成标记（按作业 id 展开）
  'cls_sign_*',             // 每日班级签（按日期展开）
  'cls_claim_*',            // 点歌券领取台账
  'cls_act_*',              // 每日活动记录
];

/** 单条数据体积上限（字符数），防止有人塞大文件进来 */
const MAX_VALUE_CHARS = 200 * 1024;   // 200KB
/** 单用户最多同步多少条 */
const MAX_ITEMS_PER_USER = 2000;

/** 键是否在白名单内（支持结尾 * 前缀匹配） */
function keyAllowed(key) {
  if (typeof key !== 'string' || !key || key.length > 120) return false;
  /* 屏蔽明显危险的键名 */
  if (/[<>"']/.test(key)) return false;
  return ALLOW_KEYS.some((pat) => {
    if (pat.endsWith('*')) return key.startsWith(pat.slice(0, -1));
    return key === pat;
  });
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  cors(req, res);

  /* 特殊通道：页面关闭时用 navigator.sendBeacon 补推最后的改动。
     sendBeacon 只能发 POST 且不能带自定义头，所以 token 走 query 参数。
     这条通道只做「写入」，权限等同普通登录用户。 */
  if (req.query.action === 'beacon') {
    /* 只接受 POST：sendBeacon 本来就只发 POST，放行 GET 会让「带 token 的 URL」
       被浏览器历史、服务器日志、Referer 头记下来，等于把凭据写进日志。 */
    if (req.method !== 'POST') return fail(res, 405, 'beacon 通道只接受 POST');
    const u = await requireUserFromQuery(req, res);
    if (!u) return;
    try {
      return await writeData(req, res, u);
    } catch (e) {
      console.error('[data/beacon]', e);
      return fail(res, 500, '服务器内部错误');
    }
  }

  const u = await requireUserReady(req, res, 'data');
  if (!u) return;

  try {
    switch (req.method) {
      case 'GET':    return await readData(req, res, u);
      case 'PUT':    return await writeData(req, res, u);
      case 'DELETE': return await deleteData(req, res, u);
      default:       return fail(res, 405, '不支持的方法');
    }
  } catch (e) {
    console.error('[data]', req.method, e);
    return fail(res, 500, '服务器内部错误，请稍后重试');
  }
}

/** sendBeacon 通道专用：从 query 里取 token 鉴权 */
async function requireUserFromQuery(req, res) {
  const token = String(req.query.t || '').trim();
  if (!token) { fail(res, 401, '缺少登录凭据'); return null; }
  const sql = getSql();
  const rows = await sql`
    select u.id, u.username, u.role, u.status, u.display_name, u.created_at
      from sessions s join users u on u.id = s.user_id
     where s.token = ${token} and s.expires_at > now() limit 1
  `;
  if (!rows.length || rows[0].status !== 'active') { fail(res, 401, '未登录或登录已过期'); return null; }
  const u = rows[0];
  return { id: Number(u.id), username: u.username, role: u.role, displayName: u.display_name };
}

/* ---------------- 读取 ---------------- */
async function readData(req, res, u) {
  const sql = getSql();
  const key = req.query.key;

  if (key) {
    const rows = await sql`
      select data_key, data_value, updated_at
        from user_data where user_id = ${u.id} and data_key = ${String(key)}
    `;
    if (!rows.length) return ok(res, { key: String(key), value: null, updatedAt: null });
    return ok(res, {
      key: rows[0].data_key,
      value: rows[0].data_value,
      updatedAt: rows[0].updated_at,
    });
  }

  /* 不带 key：返回全部（前端做「登录后拉取云端数据」用） */
  const rows = await sql`
    select data_key, data_value, updated_at
      from user_data where user_id = ${u.id}
     order by data_key
  `;
  const items = {};
  const times = {};
  rows.forEach((r) => {
    items[r.data_key] = r.data_value;
    times[r.data_key] = r.updated_at;
  });
  return ok(res, { count: rows.length, items, times });
}

/* ---------------- 写入 ---------------- */
async function writeData(req, res, u) {
  const b = await body(req);

  /* 支持两种写法：
     { key: 'x', value: ... }          单条
     { items: { k1: v1, k2: v2 } }     批量（前端同步更省请求） */
  let items = {};
  if (b && b.items && typeof b.items === 'object') {
    items = b.items;
  } else if (b && typeof b.key === 'string') {
    items = { [b.key]: b.value };
  } else {
    return fail(res, 400, '请求体格式不对，需要 { key, value } 或 { items: {...} }');
  }

  const entries = Object.entries(items);
  if (entries.length === 0) return ok(res, { written: 0 });
  if (entries.length > 500) return fail(res, 400, '单次最多写入 500 条');

  /* 校验键白名单与体积 */
  const bad = [];
  for (const [k, v] of entries) {
    if (!keyAllowed(k)) { bad.push(k + '（不在允许同步的范围内）'); continue; }
    const len = JSON.stringify(v === undefined ? null : v).length;
    if (len > MAX_VALUE_CHARS) bad.push(k + '（内容过大，超过 200KB）');
  }
  if (bad.length) return fail(res, 400, '以下数据无法同步：' + bad.slice(0, 5).join('、'));

  const sql = getSql();

  /* 条数上限，防止无限膨胀 */
  const cnt = (await sql`select count(*)::int as n from user_data where user_id = ${u.id}`)[0].n;
  if (cnt + entries.length > MAX_ITEMS_PER_USER) {
    return fail(res, 400, '云端同步条数已达上限（' + MAX_ITEMS_PER_USER + ' 条）');
  }

  /* 先删同名的再批量插入：JSONB 批量 upsert 用 unnest 一次搞定 */
  const keys = entries.map(([k]) => k);
  const vals = entries.map(([, v]) => JSON.stringify(v === undefined ? null : v));

  await sql`
    insert into user_data (user_id, data_key, data_value, updated_at)
    select ${u.id}, k, v::jsonb, now()
      from unnest(${keys}::text[], ${vals}::text[]) as t(k, v)
    on conflict (user_id, data_key)
    do update set data_value = excluded.data_value, updated_at = now()
  `;

  return ok(res, { written: entries.length });
}

/* ---------------- 删除 ---------------- */
async function deleteData(req, res, u) {
  const key = req.query.key;
  if (!key) return fail(res, 400, '缺少 key 参数');
  const sql = getSql();
  await sql`delete from user_data where user_id = ${u.id} and data_key = ${String(key)}`;
  return ok(res, { message: '已删除', key: String(key) });
}
