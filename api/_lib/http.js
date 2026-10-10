/* ============================================================
   HTTP 工具：CORS、统一响应、鉴权
   ------------------------------------------------------------
   鉴权用 Authorization: Bearer <token>，不依赖 Cookie。
   原因：前端在 GitHub Pages、API 在 Vercel，属于跨站请求，
   Cookie 需要 SameSite=None + Secure 才可能带上，而微信内置浏览器
   （X5 内核）对第三方 Cookie 限制很严，登录态会莫名其妙掉。
   用 Bearer token 存 localStorage，跨域一样稳定。
   ============================================================ */

import { getSql, cfg } from './db.js';
import { sha256Hex } from './password.js';

/* ============================================================
   表结构自愈（全站公共）
   ------------------------------------------------------------
   背景：2026-10-05 上线「首次登录强制改密 + 登录记录」时新增了
   users.must_change_password 列与 login_log 表。站主如果没在 Neon
   执行建表脚本，任何引用新列的查询都会直接 500 —— 表现为
   「无法登录，服务器内部问题」，且完全依赖人工记得执行 SQL。

   这里做一次幂等的结构补全：缺列补列、缺表建表。Postgres 的
   IF NOT EXISTS 语义保证重复执行无副作用，配合下面的内存标记，
   每个进程生命周期内只真正跑一次，开销可忽略。

   任何失败都只记录警告、不抛错：自愈逻辑绝不能变成新的故障点。
   （若数据库账号没有 DDL 权限，补全失败，但老库的基本登录仍可正常。）
   ------------------------------------------------------------ */
let schemaReady = false;
export async function ensureSchema(sql) {
  if (schemaReady) return;
  /* 先置位再执行：无论成功失败都只尝试一次，避免每次请求都刷一遍日志 */
  schemaReady = true;
  const s = sql || getSql();
  try {
    await s`
      alter table users add column if not exists must_change_password
        boolean not null default false
    `;
    /* 🔴 2026-10-07 第二十七轮·真根因：
       登录限流用的这两列只写在 schema.sql 里（需要人工执行才生效），
       但 ensureSchema（自动自愈）**漏了它们**。线上库没跑过 schema.sql 的话，
       这两列根本不存在，于是任何写它们的 SQL 都会 500：
         · auth.js 的 bumpFail / clearFail → 有 try-catch，静默失败
           （所以「登录」表面正常，其实限流一直没生效）
         · admin.js 的 reset-password、auth.js 的 change-password
           → 裸写无保护 → 直接 500「服务器内部错误」
       这就是「后台重置密码 500」「改密码 500」真正的、唯一的原因
       （而不是之前以为的 CPU 派生次数——那个是次要影响因素）。
       补进自愈后，部署即自动建列，不必手动跑 SQL。 */
    await s`alter table users add column if not exists failed_count int not null default 0`;
    await s`alter table users add column if not exists locked_until timestamptz`;
    /* 2026-10-07「最后上线」：与 last_login_at（登录时刻）区分，
       由前端心跳 /api/auth?action=ping 刷新，关掉页面后停更 */
    await s`
      alter table users add column if not exists last_seen_at timestamptz
    `;
    /* v2.5.0「真·在线检测」：会话粒度的在线时间。
       以前只有 users.last_seen_at（用户粒度），只能知道「这个人最近在不在」，
       分不清同一账号的多台设备，也无法精确到「此刻这个会话还在不在」。
       心跳每 60 秒刷新该列，后台按「90 秒内有更新」判定在线。 */
    await s`
      alter table sessions add column if not exists last_seen_at timestamptz
    `;
    await s`
      create table if not exists login_log (
        id         bigserial   primary key,
        user_id    bigint      not null references users(id) on delete cascade,
        ip         text,
        user_agent text,
        created_at timestamptz not null default now()
      )
    `;
    await s`
      create index if not exists login_log_user_idx
        on login_log (user_id, created_at desc)
    `;
    await s`
      create index if not exists login_log_time_idx
        on login_log (created_at desc)
    `;
    /* 班级通讯录 / 个人资料（与 schema.sql 保持一致，见该文件的说明） */
    await s`
      create table if not exists profiles (
        id             bigserial   primary key,
        name           text,
        name_hash      text        unique,
        student_id     text        unique,
        politics       text,
        exam_no        text,
        role           text        not null default '学生',
        wechat         text,
        qq             text,
        phone          text,
        contact_status text        not null default 'none',
        reject_reason  text,
        user_id        bigint      references users(id) on delete set null,
        created_at     timestamptz not null default now(),
        updated_at     timestamptz not null default now()
      )
    `;
    /* 老库补列：exam_no 是后加的（2026-10-05 导入名单时需要）。 */
    await s`alter table profiles add column if not exists exam_no text`;
    /* 头衔（班长/团支书/课代表…），2026-10-05 新增。
       存英文逗号分隔的纯文本，如 '团支书,课代表'——一个人可兼多职。
       授权判定只认本列的服务端值，绝不接受前端传参。 */
    await s`alter table profiles add column if not exists title text`;
    /* 本人可见性意愿（2026-10-08 新增）：JSON 文本，存本人愿意公开的字段。
       最终可见性 = 全班默认（profile_field_meta.visibility）∩ 本人意愿 ∩ 单人例外，取最严一侧。 */
    await s`alter table profiles add column if not exists visibility_pref text`;
    /* 单人字段可见性例外（2026-10-09 新增）：JSON 文本，管理员给某一条资料设的例外。
       与 visibility_pref 的区别见 schema.sql 该列的注释。 */
    await s`alter table profiles add column if not exists field_vis text`;
    /* 资料字段元数据（2026-10-08 新增）：可见性分档 + 自定义字段的地基。
       详见 schema.sql 中该表的注释。 */
    await s`
      create table if not exists profile_field_meta (
        field       text        primary key,
        label       text        not null,
        visibility  text        not null default 'public',
        sort_order  int         not null default 100,
        is_custom   boolean     not null default false,
        vis_locked  boolean     not null default false,
        updated_at  timestamptz not null default now(),
        constraint pfm_vis_chk check (visibility in ('public','committee','self'))
      )
    `;
    /* vis_locked 补列（2026-10-09 v2.4.1）：老库升级用。
       true = 站主在后台设过该字段的可见性 → 以站主为准，同学自己的
       「仅自己可见」不再生效（站主要求「后台权力最大」）。
       ⚠️ 不能靠「visibility 是否等于出厂值」来判断「动没动过」——
          站主可能把字段设成它本来就有的档（值没变），比对法分辨不出来。 */
    await s`alter table profile_field_meta add column if not exists vis_locked boolean not null default false`;
    /* 预置字段元数据。on conflict do nothing —— 后台改过之后重跑不会覆盖。 */
    await s`
      insert into profile_field_meta (field, label, visibility, sort_order, is_custom) values
        ('name',            '姓名',         'public', 10,  false),
        ('student_id',      '学号',         'public', 20,  false),
        ('politics',        '政治面貌',      'public', 30,  false),
        ('exam_no',         '智学网账号',    'public', 40,  false),
        ('role',            '身份',         'public', 50,  false),
        ('title',           '头衔',         'public', 60,  false),
        ('wechat',          '微信',         'public', 70,  false),
        ('qq',              'QQ',          'public', 80,  false),
        ('phone',           '手机号',       'public', 90,  false),
        ('id_card',         '身份证号',      'self',   100, false),
        ('youth_league_no', '发展团员编号',   'self',   110, false)
      on conflict (field) do nothing
    `;
    /* 2026-10-09（v2.4.0）：让上面两个「只登记未建列」的字段真正有列。
       ⚠️ 这里只补**预置**字段的列。
          后台新增的自定义字段**绝不能**放进来：
          schemaReady 是「每实例只跑一次」的标记，而本 try-catch 一旦在
          某条 DDL 上报错就会吞掉异常、跳过后面所有语句 —— 把动态字段
          塞进来，一个坏字段就能让整段自愈失效。自定义字段一律在
          api/admin.js 的 addField 里「当场 alter table」。 */
    await s`alter table profiles add column if not exists id_card text`;
    await s`alter table profiles add column if not exists youth_league_no text`;
    /* 标记 AI 账号，2026-10-05 新增。用于「AI 可编辑云端内容」与后续交接。 */
    await s`
      alter table users add column if not exists is_ai
        boolean not null default false
    `;
    await s`
      create table if not exists profile_view_log (
        id          bigserial   primary key,
        viewer_id   bigint      not null references users(id) on delete cascade,
        target_id   bigint      references profiles(id) on delete set null,
        target_name text,
        keyword     text,
        ip          text,
        created_at  timestamptz not null default now()
      )
    `;
    await s`create index if not exists profiles_name_idx    on profiles (name)`;
    await s`create index if not exists profiles_exam_idx    on profiles (exam_no)`;
    await s`create index if not exists profiles_sid_idx     on profiles (student_id)`;
    await s`create index if not exists profiles_user_idx    on profiles (user_id)`;
    await s`create index if not exists profiles_status_idx  on profiles (contact_status)`;
    await s`create index if not exists pvl_viewer_idx on profile_view_log (viewer_id, created_at desc)`;
    await s`create index if not exists pvl_target_idx on profile_view_log (target_id, created_at desc)`;
    await s`create index if not exists pvl_time_idx   on profile_view_log (created_at desc)`;
  } catch (e) {
    /* 自愈失败不抛错：老库的基本功能仍可用（只是少了强制改密与登录记录）。
       只警告一次，避免每次请求都刷日志把真正的问题淹没。
       （测试桩 SQLite 不支持 ADD COLUMN IF NOT EXISTS，会走到这里，属预期。） */
    console.warn('[schema] 表结构自愈未完成（不影响基本功能）：', e.message);
  }
}

/** 允许的请求头 / 方法 */
const ALLOW_HEADERS = 'Content-Type, Authorization';
const ALLOW_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';

/**
 * 按白名单设置 CORS 响应头。
 * 跨站请求必须回显具体 Origin，不能回 '*'（带 Authorization 时浏览器会拒绝）。
 */
export function cors(req, res) {
  const origin = req.headers.origin || '';
  const { allowOrigins } = cfg();

  /* 站规（2026-09-30 第十八轮立）：不在白名单就【不输出】Access-Control-Allow-Origin，
     不得回退到白名单任一项——旧写法 `includes(origin) ? origin : allowOrigins[0]`
     会让任意来源都收到白名单第一项，构成防御纵深缺失。Workers 版 2026-10-06 补落实。 */
  let allow = '';
  if (allowOrigins.includes('*')) {
    /* 白名单是 * 时，回显具体来源，方便本地调试 */
    allow = origin;
  } else if (allowOrigins.includes(origin)) {
    allow = origin;
  }

  if (allow) res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
  res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
  /* 预检结果缓存 24 小时，减少 OPTIONS 请求 */
  res.setHeader('Access-Control-Max-Age', '86400');
}

/** 预检请求直接放行 */
export function handlePreflight(req, res) {
  if (req.method === 'OPTIONS') {
    /* 注意：Vercel 的 res 是原生 Node ServerResponse，没有 Express 的 res.status()，
       必须用 statusCode + end()。这里曾经用 res.status(204) 导致预检 500。 */
    cors(req, res);
    res.statusCode = 204;
    res.setHeader('Content-Length', '0');
    res.end();
    return true;
  }
  return false;
}

/** 统一 JSON 响应 */
export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  /* 接口一律不缓存，避免拿到过期的登录态/数据 */
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.end(JSON.stringify(body));
}

export function ok(res, data) {
  json(res, 200, { ok: true, ...data });
}

export function fail(res, status, msg, extra) {
  json(res, status, { ok: false, error: msg, ...(extra || {}) });
}

/** 读取请求体。
 *  - Workers：入口已把请求体预读成字符串挂在 req.__rawBody
 *  - Vercel / FC：body 可能已是对象、字符串或 Buffer，做兼容
 *  - 兜底：手动读流（仅 Node 环境有流事件）
 */
export async function body(req) {
  if (req.body && typeof req.body === 'object' && !isBuffer(req.body)) return req.body;

  /* Workers 入口预读的原始串 */
  let raw = req.__rawBody !== undefined ? req.__rawBody : req.body;

  if (isBuffer(raw)) raw = raw.toString('utf-8');
  if (typeof raw === 'string' && raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (raw === '' || raw === undefined || raw === null) {
    /* Workers 下没有流事件，直接返回空对象 */
    if (!req.on) return {};
  }

  /* 兜底：Node 环境手动读流 */
  if (!req.on) return {};
  return await new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/** 兼容判断 Buffer（Workers 里没有 Buffer 全局） */
function isBuffer(v) {
  return typeof Buffer !== 'undefined' && Buffer.isBuffer(v);
}

/* ---------------- 会话与鉴权 ---------------- */

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : '';
}

/**
 * 轻量版当前用户：只查会话 → 用户，不做 ensureSchema、不查 profiles。
 *
 * 用途（2026-10-07 第二十七轮）：改密码这种「还要再跑两次 PBKDF2」的接口，
 * CPU 预算本来就紧。完整的 currentUser 会先跑一遍 ensureSchema（多条 DDL）
 * 再查 profiles，叠加两次派生很容易越过 Workers 的 10ms CPU 上限 →
 * 表现为「原密码正确却 500」。这里只取鉴权与改密必需的字段，把预算留给密码计算。
 *
 * 注意：它**不保证** must_change_password 列存在，所以绝不能拿它当通用鉴权用。
 */
async function currentUserSlim(req) {
  const token = bearer(req);
  if (!token) return null;
  const sql = getSql();
  const tokenHash = await sha256Hex(token);
  const rows = await sql`
    select u.id, u.username, u.role, u.status, u.display_name
      from sessions s
      join users u on u.id = s.user_id
     where (s.token = ${tokenHash} or s.token = ${token})
       and s.expires_at > now()
     limit 1
  `;
  if (!rows.length) return null;
  const u = rows[0];
  if (u.status !== 'active') return null;
  return {
    id: Number(u.id),
    username: u.username,
    role: u.role,
    displayName: u.display_name,
    isAI: false,
  };
}

/** 轻量鉴权：给「CPU 预算紧张」的接口用（目前是改密码）。 */
export async function requireUserSlim(req, res) {
  const u = await currentUserSlim(req);
  if (!u) {
    fail(res, 401, '未登录或登录已过期，请重新登录');
    return null;
  }
  return u;
}

/**
 * 解析当前登录用户。
 * @returns {Promise<{id:number,username:string,role:string}|null>}
 */
export async function currentUser(req) {
  const token = bearer(req);
  if (!token) return null;
  const sql = getSql();
  /* 确保 must_change_password 列存在，否则下面的 select 会整条失败 */
  await ensureSchema(sql);
  /* 会话表存的是 sha256(token)；升级前的老会话仍是明文 token，
     这里两种都匹配，保证平滑迁移、不强制重登。 */
  const tokenHash = await sha256Hex(token);
  const rows = await sql`
    select u.id, u.username, u.role, u.status, u.display_name, u.created_at,
           coalesce(u.must_change_password, false) as must_change_password,
           coalesce(u.is_ai, false) as is_ai,
           s.expires_at, s.token as session_token
      from sessions s
      join users u on u.id = s.user_id
     where (s.token = ${tokenHash} or s.token = ${token})
       and s.expires_at > now()
     limit 1
  `;
  if (!rows.length) return null;
  const u = rows[0];
  if (u.status !== 'active') return null;

  /* 查该账号认领的班级资料（可能没有）。
     profiles 表由 ensureSchema 保证存在；查询失败不阻断登录态。
     这里一并取出 role/title：role 是「学生/老师/管理员」的展示字段（与
     users.role 的 user/admin 是两套东西，别混），title 是头衔，授权时要用。 */
  let profileId = null;
  let profileRole = null;
  let title = '';
  try {
    const pr = await sql`select id, role, title from profiles where user_id = ${u.id} limit 1`;
    if (pr.length) {
      profileId = Number(pr[0].id);
      profileRole = pr[0].role || null;
      title = pr[0].title || '';
    }
  } catch (e) {
    /* 老库或无 DDL 权限时可能查不到，忽略即可 */
  }

  return {
    id: Number(u.id),
    username: u.username,
    role: u.role,
    displayName: u.display_name,
    createdAt: u.created_at,
    mustChangePassword: !!u.must_change_password,
    profileId,
    profileRole,
    title,
    isAI: !!u.is_ai,
    /* 当前会话标识（sha256 后的 token）。心跳拿它精确更新「这个会话」的
       last_seen_at，从而支持按设备/会话判定在线；不下发给前端。 */
    sessionToken: u.session_token || '',
  };
}

/** 要求已登录；未登录时直接写入 401 并返回 null */
export async function requireUser(req, res) {
  const u = await currentUser(req);
  if (!u) {
    fail(res, 401, '未登录或登录已过期，请重新登录');
    return null;
  }
  return u;
}

/** 要求管理员；权限不足时写入 403 并返回 null */
export async function requireAdmin(req, res) {
  const u = await requireUser(req, res);
  if (!u) return null;
  if (u.role !== 'admin') {
    fail(res, 403, '需要管理员权限');
    return null;
  }
  return u;
}

/**
 * 班委头衔清单（2026-10-08 新增）。
 *
 * 用途：资料字段可见性里的 `committee` 档——「班委可见」的字段，
 * 只有持有下列头衔之一的人（或管理员 / AI 账号）才能查到。
 *
 * ⚠️ name 里的值必须与后台「头衔任命」所用的字面量完全一致
 *    （见 api/admin.js 的 ALLOWED_TITLES）。
 * ⚠️ 这是**服务端**常量，不接受任何前端传参。
 */
export const COMMITTEE_TITLES = ['班长', '副班长', '团支书', '副团支书', '课代表', '电教委', '劳动委员', '纪律委员', '宣传委员', '体育委员', '文娱委员', '卫生委员', '生活委员', '学习委员'];

/** 把 profiles.title 的文本切成头衔数组（与 requireTitle 同一套切分规则） */
export function splitTitles(raw) {
  return String(raw || '')
    .split(/[,，、\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * 判断当前用户是否算「班委」（可见性 committee 档的门槛）。
 *
 * 管理员与 AI 账号天然算（它们本就该能看一切）。
 * 注意：**不要**把这个判定塞进 currentUser()——那会让每个请求都多算一次；
 * 只在 profile.js 真正需要分档的接口里调用。
 *
 * @param {{role?:string,isAI?:boolean,title?:string}|null} u
 */
export function isCommittee(u) {
  if (!u) return false;
  if (u.role === 'admin' || u.isAI) return true;
  const list = splitTitles(u.title);
  return list.some((t) => COMMITTEE_TITLES.includes(t));
}

/* ============================================================
   自定义资料字段：字段名校验（2026-10-09 v2.4.0 新增）
   ------------------------------------------------------------
   🔴 这是本功能**唯一的 SQL 注入防线**，改动前请先读完本段。

   为什么必须白名单：
     站主需求是「后台直接新增一个资料字段」，实现上要执行
       alter table profiles add column <字段名> text
     —— 而 `sql` 模板标记只能参数化**值**，**列名/表名无法参数化**。
     字段名只能字符串拼接进 SQL。若不校验，管理员（或任何拿到管理员
     令牌的人）传 field = `x text; drop table profiles; --`
     就是一条完整的 SQL 注入。
     所以：**只允许严格匹配下面正则的字段名**，其余一律拒绝。

   为什么要黑名单：
     即便格式合法，若字段名撞上 profiles 已有列，`add column` 会报错
     或被 if not exists 静默跳过 —— 而 meta 表却新增了一行，
     造成「元数据说有、列也有但含义完全不同」的错位。
     最危险的是 name_hash / user_id / visibility_pref 这类**有业务语义**的列。
     所以格式校验通过后还要再挡一层列名黑名单。
   ============================================================ */

/** 字段名格式：小写字母开头，后跟小写字母/数字/下划线，总长 ≤ 31 */
export const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,30}$/;

/**
 * profiles 表**已有**的列名 —— 自定义字段禁止占用。
 * 与 api/schema.sql 的 profiles 建表保持一致；加列后请同步更新本清单。
 */
export const RESERVED_PROFILE_COLS = [
  'id', 'name', 'name_hash', 'student_id', 'politics', 'exam_no', 'role',
  'wechat', 'qq', 'phone', 'contact_status', 'reject_reason', 'user_id',
  'created_at', 'updated_at',
  'title', 'visibility_pref', 'field_vis',
  'id_card', 'youth_league_no',
];

/**
 * 校验自定义字段名是否可用。
 * @param {string} raw 前端传来的字段名
 * @returns {{ok:true, field:string} | {ok:false, reason:string}}
 */
export function checkFieldName(raw) {
  const field = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!field) return { ok: false, reason: '缺少字段名' };
  if (field.length > 31) return { ok: false, reason: '字段名最长 31 个字符' };
  if (!FIELD_NAME_RE.test(field)) {
    return {
      ok: false,
      reason: '字段名只能用小写字母开头，由小写字母、数字、下划线组成（如 school_id）',
    };
  }
  /* SQL 关键字也挡一下：虽然加了引号后 PG 能容忍，但拼进 SQL 容易出意外 */
  if (SQL_KEYWORDS.has(field)) {
    return { ok: false, reason: '「' + field + '」是数据库保留字，请换一个名字' };
  }
  if (RESERVED_PROFILE_COLS.includes(field)) {
    return { ok: false, reason: '「' + field + '」与系统已有字段重名，请换一个名字' };
  }
  return { ok: true, field };
}

/**
 * 只验「格式是否合法」，不查重名黑名单。
 *
 * 用途：写入路径校验**已在 meta 表里登记过**的字段名。
 *   meta 表里的字段当初都过了 checkFieldName（含重名检查），
 *   所以这里只需防「历史脏数据 / 迁移异常」混进非法字符即可。
 *
 * ⚠️ 不要用它替代 checkFieldName 的「新增字段」入口校验 ——
 *    新增字段必须用 checkFieldName（要挡住撞名与保留字）。
 *    两者混用的典型 bug：id_card 这类**系统字段**在
 *    RESERVED_PROFILE_COLS 里，若写入路径也用 checkFieldName，
 *    它会被自己的黑名单挡掉，表现为「保存成功但值没写进去」
 *    （2026-10-09 实际踩过，测试第 38 节抓出来的）。
 *
 * @param {string} raw
 * @returns {{ok:true, field:string} | {ok:false, reason:string}}
 */
export function isSafeFieldFormat(raw) {
  const field = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!field) return { ok: false, reason: '缺少字段名' };
  if (field.length > 31) return { ok: false, reason: '字段名最长 31 个字符' };
  if (!FIELD_NAME_RE.test(field)) return { ok: false, reason: '字段名格式非法' };
  if (SQL_KEYWORDS.has(field)) return { ok: false, reason: '字段名是数据库保留字' };
  return { ok: true, field };
}

/** 常见 SQL 保留字（做成字段名会跟拼接逻辑打架，一律挡掉） */
const SQL_KEYWORDS = new Set([
  'select', 'insert', 'update', 'delete', 'drop', 'table', 'where', 'from',
  'order', 'group', 'by', 'index', 'view', 'user', 'column', 'constraint',
  'primary', 'foreign', 'references', 'check', 'default', 'null', 'and', 'or',
  'not', 'join', 'left', 'right', 'inner', 'outer', 'union', 'values', 'set',
  'into', 'alter', 'add', 'create', 'grant', 'revoke', 'limit', 'offset',
  'distinct', 'having', 'case', 'when', 'then', 'else', 'end', 'as', 'on',
  'text', 'int', 'bigint', 'boolean', 'json', 'jsonb', 'timestamp', 'timestamptz',
]);

/**
 * 可见性三档的严格程度排序（数字越大越严）。
 * 用于「三方取严」：全班默认 ∩ 本人意愿 ∩ 单人例外。
 */
export const VIS_RANK = { public: 0, committee: 1, self: 2 };

/** 取两档中更严的一档；任一为 undefined 时返回另一方 */
export function stricterVis(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  const ra = VIS_RANK[a];
  const rb = VIS_RANK[b];
  if (ra == null) return b;
  if (rb == null) return a;
  return ra >= rb ? a : b;
}

/**
 * 要求持有某个头衔（班长 / 课代表 / 团支书…）。
 *
 * ⚠️ 安全边界：头衔一律以数据库 profiles.title 为准，**绝不接受前端传参**、
 * 也不从 token 里解。前端传什么都无关紧要，这里只认服务端读出来的值。
 *
 * 管理员与 AI 账号天然通过（管理员本来就该能改一切；AI 账号见 is_ai）。
 *
 * ⚠️ 现状（2026-10-08 核查）：本函数当前**没有任何调用方**——课代表改作业的
 *    授权是内联在 api/content.js 的 caSaveSubject 里的。保留它供后续复用，
 *    但**不要**以为改了这里就能改全站授权。
 *
 * @param {string} need 需要的头衔，如 '课代表'
 */
export async function requireTitle(req, res, need) {
  const u = await requireUser(req, res);
  if (!u) return null;
  if (u.role === 'admin' || u.isAI) return u;
  const list = splitTitles(u.title);
  if (!list.includes(String(need || '').trim())) {
    fail(res, 403, `需要「${need}」头衔才能操作`);
    return null;
  }
  return u;
}

/**
 * 要求 AI 账号（users.is_ai = true 且是管理员）。
 * 用于「AI 助手可编辑云端公告/作业」这类能力，也便于以后排查 AI 的动作。
 */
export async function requireAI(req, res) {
  const u = await requireUser(req, res);
  if (!u) return null;
  if (!u.isAI || u.role !== 'admin') {
    fail(res, 403, '需要 AI 助手账号才能操作');
    return null;
  }
  return u;
}

/**
 * 要求「管理员 或 AI 助手」。云端内容的写入走这个。
 * 单独抽出来是因为 content 接口既要给管理员用，也要给 AI 用。
 */
export async function requireAdminOrAI(req, res) {
  const u = await requireUser(req, res);
  if (!u) return null;
  if (u.role === 'admin' || u.isAI) return u;
  fail(res, 403, '需要管理员权限');
  return null;
}

/**
 * 要求「已完成首次改密」的用户。
 *
 * 首次登录被强制改密时，前端会弹一个不可关闭的弹窗；但光靠前端不够——
 * 有人可以拿 token 直接调接口绕过。所以后端这里再拦一道：
 * must_change_password = true 的用户，除 /auth?action=me|change-password|logout
 * 之外的接口一律 403 拒绝。
 *
 * @param {string} allowAction 当前 action 名，命中白名单则放行
 */
export async function requireUserReady(req, res, allowAction) {
  const ALLOW = ['me', 'change-password', 'logout'];
  const u = await requireUser(req, res);
  if (!u) return null;
  if (u.mustChangePassword && !ALLOW.includes(String(allowAction || '').toLowerCase())) {
    fail(res, 403, '首次登录请先修改初始密码', { mustChangePassword: true });
    return null;
  }
  return u;
}

/** 生成随机会话 token（32 字节十六进制） */
export function newToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 记录管理操作日志（审计用，失败不影响主流程） */
export async function audit(actorId, action, targetType, targetId, detail) {
  try {
    const sql = getSql();
    await sql`
      insert into audit_log (actor_id, action, target_type, target_id, detail)
      values (${actorId}, ${action}, ${targetType}, ${targetId || null}, ${detail || null})
    `;
  } catch {
    /* 审计失败不阻断业务 */
  }
}
