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
  cors, handlePreflight, ok, fail, body, requireUser, requireUserReady, requireUserSlim, audit,
} from './_lib/http.js';
import { sha256Hex, verifyPassword, verifyCredential } from './_lib/password.js';

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
  'cls_theme_auto',         // 旧的「是否自动」开关（v2.5.3 起降级为兼容键）
  'cls_theme_auto2',        // v2.5.3 主题自动模式：off / system / sun
  'cls_study_cfg',          // v2.6.0 学习卡片配置（开关 / 类型 / 学科）
  /* v3.5.34：cls_ui_cfg / cls_ui_bgimg 已移出白名单 ——
     自定义设置只存本机，不跨设备（每台设备屏幕和使用习惯不同，站主明确要求）。
     老账号云端残留的这两个键读下来会被 isCloudKey() 挡掉，不再覆盖本机。 */
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
  /* 游戏（2026-10-07）：最高分 / 游玩时长 / 券台账全部上云
     cls_game_<本地键>（如 cls_game_snake_hi）、cls_game_play_<游戏>、
     cls_game_coupon_ledger（券台账云端副本，发放前以它判重） */
  'cls_game_*',
  /* v3.9.25（站主）：全屏时钟的使用记录。
     cls_clock_log_<YYYY-MM-DD>  当天的时间线（每段用了几分钟、用的哪个模式）
     cls_clock_pomo_<YYYY-MM-DD> 当天的番茄数（离线补写用，正常随 log 一起）
     后台「时钟记录」面板按这两类键汇总，别的键一概不碰。 */
  'cls_clock_*',
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

/* ============================================================
   云端数据分类元数据（v2.10.0 第六十一轮 #178）
   ------------------------------------------------------------
   站主要求「分类细化到条目 + 英文键名翻中文」。ALLOW_KEYS 管
   「能不能同步」，这里管「怎么展示」——两个关注点，故意分开。
   个人端「我的云端数据」与管理员后台的用户详情共用这一份，
   两边翻译永远一致。

   前缀类（prefix）的键按条目展开：cls_hw_done_42 展示为
   「作业完成标记 · 42」，具体到每一条作业。

   预留 KV（站主明确「预留但不开发」）：分类表里先占好 kv 位，
   但 ALLOW_KEYS 不放行任何 kv_ 键、分类视图不渲染它。
   将来要做时只需两步：ALLOW_KEYS 加 'kv_*' + 取消下面注释。
   ============================================================ */
const KEY_GROUPS = [
  { cat: 'appearance', label: '外观与界面', keys: {
    'cls_theme':            '主题（亮/暗）',
    'cls_theme_auto':       '主题自动切换（旧版兼容键）',
    'cls_theme_auto2':      '主题自动模式',
    'cls_study_cfg':        '学习卡片配置',
    /* cls_ui_cfg / cls_ui_bgimg 已于 v3.5.34 移出白名单，分类表同步删掉，
       否则「我的云端数据」里会留一个永远空的分类项。 */
    'cls_sfx':              '音效开关',
  } },
  { cat: 'seen', label: '已看过标记', keys: {
    'cls_welcome_v1':            '欢迎弹窗已看过',
    'cls_login_guide_v1':        '登录引导已看过',
    'cls_study_notice_dismissed': '学习资料提示已关闭',
    'cls_welcome_hide':          '欢迎语已隐藏',
    'cls_exam_tip_seen':         '考试提示已看过',
    'cls_holiday_tip_seen':      '假期提示已看过',
    'cls_exam_scope_seen':       '成绩范围提示已看过',
  } },
  { cat: 'dj', label: '点歌', keys: {
    'cls_dj_excluded':     '点歌排除曲目',
    'cls_dj_excluded_req': '点歌排除申请',
    'cls_dj_note':         '点歌备注',
    'cls_dj_schedule':     '点歌排期',
    'cls_dj_my_songs':     '我点过的歌',
    'cls_dj_pending':      '点歌待审核',
    'cls_dj_history':      '点歌历史记录',
    'cls_dj_copy_note':    '点歌复制备注',
  } },
  { cat: 'study', label: '学习与班级事务', keys: {
    'cls_study_plan':  '学习计划',
    'cls_notice_read': '通知已读位点',
    'cls_class_list':  '班级名单（自存）',
  } },
  { cat: 'pref', label: '站内偏好', keys: {
    'cls_ann_filter':     '公告分类筛选',
    'cls_board_collapsed': '公告栏折叠',
    'cls_side_open':      '侧边栏展开',
    'cls_return_view':    '上次停留的视图',
  } },
  { cat: 'hw',     label: '作业完成标记',   prefix: 'cls_hw_done_' },
  { cat: 'sign',   label: '每日班级签',     prefix: 'cls_sign_' },
  { cat: 'coupon', label: '点歌券领取台账', prefix: 'cls_claim_' },
  { cat: 'act',    label: '每日活动记录',   prefix: 'cls_act_' },
  { cat: 'game',   label: '游戏数据',       prefix: 'cls_game_' },
  /* —— 预留位（不开发，见上方说明）——将来要做时取消下面一行的注释、
     并在 ALLOW_KEYS 加 'kv_*'，两步即可，UI 与接口零改动。
     // { cat: 'kv', label: '预留键值', prefix: 'kv_' }, */
];

/** 把英文键名翻译成「分类 + 中文名」；未命中分类表的归「其他」。
 *  @returns {{cat:string, label:string, name:string}} */
export function classifyKey(key) {
  const k = String(key || '');
  for (const g of KEY_GROUPS) {
    if (g.keys && Object.prototype.hasOwnProperty.call(g.keys, k)) {
      return { cat: g.cat, label: g.label, name: g.keys[k] };
    }
    if (g.prefix && k.startsWith(g.prefix)) {
      const suffix = k.slice(g.prefix.length);
      return { cat: g.cat, label: g.label, name: g.label + ' · ' + suffix };
    }
  }
  return { cat: 'other', label: '其他', name: k };
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

  /* v2.10.0 用户操作日志上报通道（高频，走轻量鉴权）：
     前端把点击/跳转/提交事件攒批后 POST 到这里。
     body: { events: [{a:'click',p:'成绩分析',t:'成绩对比',d:'',ts:1690000000000}, ...] }
     单次最多 50 条；字段服务端再截一次断（防脏数据撑库）。 */
  if (req.query.action === 'log') {
    if (req.method !== 'POST') return fail(res, 405, 'log 通道只接受 POST');
    const u = await requireUserSlim(req, res);
    if (!u) return;
    try {
      return await writeActionLog(req, res, u);
    } catch (e) {
      console.error('[data/log]', e);
      return fail(res, 500, '服务器内部错误');
    }
  }

  /* v2.10.0 删除前密码验证（#178）：通过后发一枚 5 分钟有效的
     wipeToken，DELETE 时带 wt 参数才放行。轻量鉴权（同 change-password：
     完整版会跑 ensureSchema，把预算留给密码比对）。 */
  if (req.query.action === 'verify') {
    if (req.method !== 'POST') return fail(res, 405, '请用 POST');
    const uv = await requireUserSlim(req, res);
    if (!uv) return;
    try {
      return await verifyBeforeWipe(req, res, uv);
    } catch (e) {
      console.error('[data/verify]', e);
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
  /* 会话表存 sha256(token)；兼容升级前的明文老会话用 OR 双匹配 */
  const tokenHash = await sha256Hex(token);
  const rows = await sql`
    select u.id, u.username, u.role, u.status, u.display_name, u.created_at
      from sessions s join users u on u.id = s.user_id
     where (s.token = ${tokenHash} or s.token = ${token}) and s.expires_at > now() limit 1
  `;
  if (!rows.length || rows[0].status !== 'active') { fail(res, 401, '未登录或登录已过期'); return null; }
  const u = rows[0];
  return { id: Number(u.id), username: u.username, role: u.role, displayName: u.display_name };
}

/* ---------------- 读取 ---------------- */
async function readData(req, res, u) {
  const sql = getSql();

  /* #178 分类视图：按 KEY_GROUPS 分组、键名翻中文，给「我的云端数据」用 */
  if (String(req.query.view || '') === 'cats') return await readDataCats(req, res, u);

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
  /* #178：删除云端数据前必须先过密码验证（wt = wipeToken，见 verifyBeforeWipe）。
     管理员在后台删用户数据走 admin?action=delete-data，不受这条限制。 */
  const wt = String(req.query.wt || '');
  if (!checkWipeToken(wt, u.id)) {
    return fail(res, 403, '删除云端数据前需要验证登录密码');
  }
  const sql = getSql();

  /* all=1：清空当前用户全部云端数据（前端「清空全部」按钮） */
  if (String(req.query.all || '') === '1') {
    const rows = await sql`delete from user_data where user_id = ${u.id} returning data_key`;
    wipeTokens.delete(wt);   /* 用掉即焚：清空后这枚令牌没有存在意义 */
    return ok(res, { message: '已清空云端全部数据', deleted: rows.length });
  }

  const key = req.query.key;
  if (!key) return fail(res, 400, '缺少 key 参数');
  await sql`delete from user_data where user_id = ${u.id} and data_key = ${String(key)}`;
  return ok(res, { message: '已删除', key: String(key) });
}

/* ============================================================
   #178 分类视图 + 删除前密码验证（v2.10.0 第六十一轮）
   ------------------------------------------------------------
   站主要求三件事：分类细化到条目、英文键名翻中文、删除前验密码。
   分类元数据 KEY_GROUPS / classifyKey 见文件上部，管理员后台
   的用户详情直接 import classifyKey 复用，保证两边翻译一致。
   ============================================================ */
async function readDataCats(req, res, u) {
  const sql = getSql();
  const rows = await sql`
    select data_key, data_value, updated_at
      from user_data where user_id = ${u.id}
     order by data_key
  `;
  const bytesOf = (v) => {
    try { return JSON.stringify(v === undefined ? null : v).length; } catch { return 0; }
  };
  const byCat = new Map();
  let total = 0, bytes = 0;
  for (const r of rows) {
    const c = classifyKey(r.data_key);
    const b = bytesOf(r.data_value);
    total++; bytes += b;
    if (!byCat.has(c.cat)) byCat.set(c.cat, { cat: c.cat, label: c.label, count: 0, bytes: 0, items: [] });
    const g = byCat.get(c.cat);
    g.count++; g.bytes += b;
    g.items.push({ key: r.data_key, name: c.name, bytes: b, updatedAt: r.updated_at });
  }
  /* 输出顺序按 KEY_GROUPS 定义走，「其他」恒在末尾——展示稳定，
     不随数据键的字典序飘。 */
  const groups = [];
  for (const g of KEY_GROUPS) if (byCat.has(g.cat)) groups.push(byCat.get(g.cat));
  if (byCat.has('other')) groups.push(byCat.get('other'));
  return ok(res, { total, bytes, groups });
}

/* ---- 删除前密码验证：通过 → 发 wipeToken（5 分钟有效） ----
   为什么是「令牌」而不是「每次都带密码」：用户可能连删几条数据，
   每条都输一遍密码太劝退。令牌把「验证一次」和「删多条」解耦。
   内存 Map 在 Workers 多实例间不共享——删数据是低频操作，偶尔
   落到别的实例只需再验一次，可接受（换取零存储、零过期任务）。 */
const WIPE_TTL_MS = 5 * 60 * 1000;
const wipeTokens = new Map();        /* token -> { userId, exp } */
const verifyHits = new Map();        /* userId -> { n, t } 限流计数 */

function issueWipeToken(userId) {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  wipeTokens.set(token, { userId, exp: Date.now() + WIPE_TTL_MS });
  if (wipeTokens.size > 200) {   /* 顺手清理过期令牌，防 Map 无限增长 */
    const now = Date.now();
    for (const [k, v] of wipeTokens) if (v.exp < now) wipeTokens.delete(k);
  }
  return token;
}
function checkWipeToken(token, userId) {
  const rec = wipeTokens.get(String(token || ''));
  if (!rec) return false;
  if (rec.exp < Date.now()) { wipeTokens.delete(String(token || '')); return false; }
  return rec.userId === userId;
}

async function verifyBeforeWipe(req, res, u) {
  /* 限流：同一用户每分钟最多 10 次——防的是拿着已登录会话
     暴力试探密码（会话可能是借来的、设备可能没锁屏）。 */
  const now = Date.now();
  let hit = verifyHits.get(u.id);
  if (!hit || now - hit.t > 60000) { hit = { n: 0, t: now }; verifyHits.set(u.id, hit); }
  hit.n++;
  if (hit.n > 10) return fail(res, 429, '验证太频繁了，稍等一分钟再试');

  const b = await body(req);
  /* 双路径与登录一致：credential = 浏览器派生的密钥（零服务端派生）；
     password = 明文（老浏览器 / bcrypt 账号的回退路径）。 */
  const credential = String(b.credential || '');
  const password = String(b.password || '');
  if (!credential && !password) return fail(res, 400, '请输入登录密码');

  const sql = getSql();
  const rows = await sql`select password_hash from users where id = ${u.id} limit 1`;
  if (!rows.length) return fail(res, 401, '账号不存在');
  const hash = rows[0].password_hash;
  const good = credential
    ? await verifyCredential(credential, hash)
    : await verifyPassword(password, hash);
  if (!good) return fail(res, 401, '密码不对');

  return ok(res, {
    ok: true,
    wipeToken: issueWipeToken(u.id),
    expiresIn: Math.floor(WIPE_TTL_MS / 1000),
  });
}

/* ============================================================
   v2.10.0 用户操作日志（2026-10-16 第六十轮）
   ------------------------------------------------------------
   站主要求「记录全部点击交互行为：页面跳转、按钮点击、切换标签、
   表单提交等，每一次点击都作为操作上报日志」。

   实现要点：
     · 前端攒批（20 条或 30 秒）POST 到本通道，避免每次点击一个请求
     · 单次最多 50 条，字段服务端再截断（page/target/detail 各 ≤120 字符）
     · 保留 90 天：写日志时顺手做「节流清理」（每实例最多 1 小时一次），
       不引入 Cron 依赖 —— 班级站量级下这样足够
   ============================================================ */
const LOG_MAX_BATCH = 50;
const LOG_FIELD_MAX = 120;
const LOG_KEEP_DAYS = 90;
/* 每实例最多 1 小时跑一次清理（Workers 多实例各自为政，够了） */
let __logLastCleanup = 0;

async function writeActionLog(req, res, u) {
  const b = await body(req);
  const events = Array.isArray(b.events) ? b.events.slice(0, LOG_MAX_BATCH) : [];
  if (!events.length) return ok(res, { written: 0 });

  const sql = getSql();
  const cut = (s) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').slice(0, LOG_FIELD_MAX);

  const rows = [];
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const action = cut(ev.a).slice(0, 20) || 'click';
    const page = cut(ev.p);
    const target = cut(ev.t);
    const detail = cut(ev.d);
    /* 时间戳以前端为准（本地时区更准），缺失/非法用服务端时间 */
    let ts = null;
    const n = Number(ev.ts);
    if (n && isFinite(n) && n > 1e12 && n < 4e12) ts = new Date(n);
    rows.push({ action, page, target, detail, ts });
  }
  if (!rows.length) return ok(res, { written: 0 });

  const ip = String(
    (req.headers || {})['cf-connecting-ip']
    || String((req.headers || {})['x-forwarded-for'] || '').split(',')[0]
    || (req.headers || {})['x-real-ip']
    || ''
  ).trim().slice(0, 64) || null;

  /* 逐条插入：一批最多 50 条，逐条比 unnest 好写且好容错（坏行不影响好行） */
  let written = 0;
  for (const r of rows) {
    try {
      await sql`
        insert into user_action_log (user_id, action, page, target, detail, ip, created_at)
        values (${u.id}, ${r.action}, ${r.page}, ${r.target}, ${r.detail}, ${ip}, coalesce(${r.ts}, now()))
      `;
      written++;
    } catch (e) {
      console.warn('[data/log] 单条写入失败（跳过）：', e.message);
    }
  }

  /* 节流清理：90 天前的明细删掉（统计聚合约了长期价值，明细只留一季） */
  const now = Date.now();
  if (now - __logLastCleanup > 3600 * 1000) {
    __logLastCleanup = now;
    try {
      await sql`delete from user_action_log where created_at < now() - interval '90 days'`;
    } catch (e) { /* 清理失败不不影响上报 */ }
  }

  return ok(res, { written });
}
