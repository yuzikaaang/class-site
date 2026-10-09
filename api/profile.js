/* ============================================================
   /api/profile —— 班级通讯录 / 个人资料查询
   ------------------------------------------------------------
   GET    ?action=search&q=关键词      按姓名或学号查询（需登录）
   GET    ?action=me                   读自己认领的那条资料（需登录）
   GET    ?action=mine-requests        看自己提交的联系方式与审核状态
   POST   ?action=submit               提交 / 修改自己的微信、QQ、手机号（进待审）
   POST   ?action=claim                用学号认领本人资料（关联到登录账号）

   ⚠️ 隐私设计（务必遵守，改代码前先读完）
   ① 资料只存数据库，前端不含任何通讯录数据。
      旧方案把 XOR 密文放进 index.html，而密钥同在 JS 里 = 等于公开，
      这正是本次要解决的问题，不要走回头路。
   ② 查询必须登录。未登录一律 401，不给任何「先看看有什么」的机会。
   ③ 联系方式（微信/QQ/手机号）只有 contact_status='approved' 才返回；
      pending / rejected 一律不回给「别人」，但本人可见自己的状态与驳回原因。
   ④ 每次成功查询都写 profile_view_log —— 谁在什么时候查了谁，
      站主在后台可查。这是对查询行为的约束，不是可选功能。
   ⑤ 姓名 / 学号 / 政治面貌 是身份信息，本接口一律不接受同学修改，
      只能由管理员在后台维护。
   ============================================================ */

import { getSql } from './_lib/db.js';
import {
  cors, handlePreflight, ok, fail, body, requireUser, requireUserReady, isCommittee,
} from './_lib/http.js';

/** 单次查询返回的最大条数（防止有人拉全表） */
const MAX_RESULTS = 30;
/** 关键词长度上限 */
const MAX_Q = 40;
/** 联系方式字段长度上限 */
const MAX_CONTACT = 64;

/* ============================================================
   字段可见性分档（2026-10-08 新增，2026-10-09 v2.4.0 升级为三层）
   ------------------------------------------------------------
   三档：public 公开 / committee 班委 / self 仅本人。
   元数据住在 profile_field_meta 表（见 schema.sql）。

   ⚠️ 三层取严语义（v2.4.0 起）：
     最终可见性 = 全班默认 ∩ 本人意愿 ∩ 单人例外  →  取最严的一侧
       · profile_field_meta.visibility = 全班默认上限（管理员在「字段管理」里改）
       · profiles.visibility_pref      = 本人意愿（只收窄不放宽，键限 wechat/qq/phone）
       · profiles.field_vis            = 单人例外（管理员在编辑弹窗/快捷切换里改，
                                          可放宽也可收窄）

   预置值不改变现有行为：联系方式默认仍是 public，
   本人可在个人中心勾选「仅自己可见」自行收窄 —— 所以不会出现
   「同学突然发现联系方式查不到了」这种意外。
   ============================================================ */

/** 可见性档位排序：数字越大越严（用于「取更严的一侧」） */
const VIS_RANK = { public: 0, committee: 1, self: 2 };

/** 从两档里取更严的那个 */
function stricter(a, b) {
  const ra = VIS_RANK[a] == null ? 0 : VIS_RANK[a];
  const rb = VIS_RANK[b] == null ? 0 : VIS_RANK[b];
  return ra >= rb ? (a || 'public') : (b || 'public');
}

/**
 * 读一次字段元数据，返回 { field: {visibility,label,sortOrder,isCustom} } 的映射。
 *
 * ⚠️ 只在 profile.js 的接口里各查一次，**绝不要**放进 currentUser()——
 *    那会让全站每个请求都多一次查询。
 * ⚠️ 查询失败（老库尚未自愈）时返回空对象，调用方一律按 'public' 兜底，
 *    保持改动前的行为，不因新功能把老库打死。
 */
async function loadMeta(sql) {
  try {
    const rows = await sql`select field, visibility, label, sort_order, is_custom, vis_locked from profile_field_meta order by sort_order, field`;
    const map = {};
    for (const r of rows) {
      map[r.field] = {
        visibility: r.visibility || 'public',
        label: r.label || r.field,
        sortOrder: Number(r.sort_order || 100),
        isCustom: !!r.is_custom,
        /* 站主是否设过这个字段的可见性（2026-10-09 v2.4.1）。
           设过 → 以站主为准，同学自己的「仅自己可见」不再生效。
           自定义字段由站主新增时指定可见性，视为天然已锁定。 */
        visLocked: !!r.vis_locked || !!r.is_custom,
      };
    }
    return map;
  } catch (e) {
    console.warn('[profile] 读字段元数据失败（按公开处理）：', e.message);
    return {};
  }
}

/**
 * 解析本人可见性意愿（profiles.visibility_pref，JSON 文本）。
 * 形状：{ wechat:false, qq:false, phone:true } —— false 表示本人不愿公开。
 * 解析失败一律当空对象，绝不让脏数据把接口搞崩。
 */
function parsePref(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const o = JSON.parse(String(raw));
    return o && typeof o === 'object' ? o : {};
  } catch (e) {
    return {};
  }
}

/**
 * 解析单人可见性例外（profiles.field_vis，JSON 文本，v2.4.0 新增）。
 * 形状：{ student_id:'self', wechat:'public' } —— 值为三档之一。
 * 与 visibility_pref 不同，这里**可以放宽**（管理员有最终裁量权）。
 */
function parseFieldVis(raw) {
  return parsePref(raw);
}

/**
 * 把「本人意愿」里某一字段的值换算成一档可见性。
 * 兼容两种写法：布尔（老：false=收窄到 self）与档位字符串（新，自定义字段用）。
 */
function visFromPref(v) {
  if (v === false) return 'self';           /* 老写法：仅自己可见 */
  if (v === true) return null;              /* 老写法：同意公开，不额外收窄 */
  if (typeof v === 'string' && VIS_RANK[v] != null) return v;
  return null;
}

/**
 * 算出某个字段对「当前查询者」到底能不能看。
 *
 * v2.4.0 起为**三层取严**：全班默认 ∩ 本人意愿 ∩ 单人例外。
 *
 * @param {string} field   字段名
 * @param {object} meta    loadMeta 的结果
 * @param {object} pref    该资料的本人意愿（visibility_pref）
 * @param {object} fvis    该资料的单人例外（field_vis）
 * @param {{self:boolean, committee:boolean}} ctx 查询者身份
 */
/**
 * 单条字段对当前访客是否可见。
 *
 * 优先级（2026-10-09 v2.4.1 改，站主要求「后台权力最大」）：
 *   ① 管理员为该同学设的单人例外 profiles.field_vis —— **直接生效，不取严**
 *      （可以放宽也可以收窄，覆盖同学自己的意愿）
 *   ② 管理员在「字段管理」里设过可见性的字段（meta.vis_locked = true）—— 同样直接生效
 *   ③ 以上都没有 → 用同学自己的意愿 profiles.visibility_pref 兜底，且只能收窄
 *
 * 即：**站主动过这个字段，同学说的就不算；站主没动过，同学的隐私仍被尊重**。
 *
 * ⚠️ 判断「站主动过没有」用的是 meta.vis_locked 这个**显式标记**，
 *    而不是「visibility 是否等于出厂值」—— 后者分辨不出「站主把它设成了
 *    它本来就是这个档」的情况（值没变，但意图是存在的），会表现为
 *    「站主明明改了，同学的私密设置却依然生效」。
 */
function canSee(field, meta, pref, fvis, ctx) {
  const m = meta[field] || {};
  const group = m.visibility || 'public';

  let eff;

  /* ① 单人例外：站主为这一个人专门设的，最强 */
  const f = visFromPref(fvis[field]);
  if (f) {
    eff = f;
  } else if (m.visLocked) {
    /* ② 站主在字段管理里设过 → 以站主为准，忽略同学意愿 */
    eff = group;
  } else {
    /* ③ 站主没动过 → 用同学自己的意愿兜底（只能收窄） */
    eff = group;
    const p = visFromPref(pref[field]);
    if (p) eff = stricter(eff, p);
  }

  if (eff === 'self') return ctx.self;
  if (eff === 'committee') return ctx.self || ctx.committee;
  return true;
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  cors(req, res);

  const action = String(req.query.action || 'search').toLowerCase();

  /* 所有动作都要求「已登录且已改过初始密码」。
     用 requireUserReady 而非 requireUser：首次登录被强制改密的人
     在改密前不该能查询同学资料。

     ⚠️ 第二个参数是「允许放行的动作名」，必须显式传实际动作，不能偷懒传 'me'。
        原因：requireUserReady 的白名单是 ['me','change-password','logout']，
        如果这里传固定的 'me'，那 search 也会被当成白名单动作放行 ——
        未改初始密码的人就能查全班资料了。这个坑已经踩过一次，别重蹈。 */
  const u = await requireUserReady(req, res, action);
  if (!u) return;

  try {
    switch (action) {
      case 'search':         return await search(req, res, u);
      case 'roster':         return await roster(req, res);
      case 'me':             return await myProfile(req, res, u);
      case 'mine-requests':  return await mineRequests(req, res, u);
      case 'claim':          return await claim(req, res, u);
      case 'submit':         return await submit(req, res, u);
      default:
        return fail(res, 404, '未知的 action：' + action);
    }
  } catch (e) {
    console.error('[profile]', action, e);
    return fail(res, 500, '服务器内部错误，请稍后重试');
  }
}

/* ---------------- 清洗输入 ---------------- */
function clean(s, max) {
  return String(s == null ? '' : s).trim().slice(0, max);
}
function cleanQ(s) {
  /* 去掉可能干扰 SQL / 展示的字符，同时限制长度 */
  return clean(s, MAX_Q).replace(/[%_\\]/g, '');
}

/** 联系方式只保留数字/常见符号，避免有人填 HTML 或超长串 */
function cleanContact(s) {
  return clean(s, MAX_CONTACT).replace(/[<>"']/g, '');
}

/**
 * 脱敏：把中间字符换成 *，用于「搜索结果列表」这类不需要完整信息的场景。
 * 例：13812345678 → 138****5678
 */
function maskPhone(v) {
  const s = String(v || '');
  if (s.length < 7) return s ? '***' : '';
  return s.slice(0, 3) + '****' + s.slice(-4);
}
function maskHalf(v) {
  const s = String(v || '');
  if (s.length <= 2) return s ? '*' : '';
  const keep = Math.ceil(s.length / 3);
  return s.slice(0, keep) + '*'.repeat(s.length - keep * 2 > 0 ? s.length - keep * 2 : 1) +
         (s.length - keep * 2 > 0 ? s.slice(-keep) : '');
}

/**
 * 组装对外的资料对象。
 * @param {object} row     profiles 表的一行
 * @param {boolean} full   true = 查询者本人或管理员，返回完整联系方式
 * @param {object} [meta]  loadMeta 的结果（不传则一切按 public 兜底）
 * @param {object} [ctx]   查询者身份 {self, committee}；用于让可见性分档生效
 *
 * ⚠️ 与改动前保持一致：`full` 仍然能让本人看到自己全部联系方式，
 *    即使字段被设为 self —— 本人看自己当然看得到。
 *
 * v2.4.0：新增 `fields` 数组，装自定义 / 非固定字段的值（按可见性过滤）。
 *    前端把它当「额外字段」渲染，不用再为每个新字段改代码。
 */
function shapeProfile(row, full, meta, ctx) {
  const approved = row.contact_status === 'approved';
  /* 只有审核通过的才对外展示；本人（full）例外，便于确认自己填了什么 */
  const show = full || approved;

  const m = meta || {};
  const pref = parsePref(row.visibility_pref);
  const fvis = parseFieldVis(row.field_vis);
  const who = ctx || { self: !!full, committee: false };
  /* 联系方式若被收窄到「仅本人」，则对别人隐藏（但仍给出脱敏预览） */
  const contactOpen = canSee('phone', m, pref, fvis, who);

  const out = {
    id: Number(row.id),
    name: canSee('name', m, pref, fvis, who) ? (row.name || '') : '',
    studentId: canSee('student_id', m, pref, fvis, who) ? (row.student_id || '') : '',
    politics: canSee('politics', m, pref, fvis, who) ? (row.politics || '') : '',
    /* 智学网账号（原「准考证号」文案，2026-10-08 改正）：
       管理员从名单导入，属于班内公开信息，不走审核。 */
    examNo: canSee('exam_no', m, pref, fvis, who) ? (row.exam_no || '') : '',
    role: row.role || '学生',
    contactStatus: row.contact_status || 'none',
    /* 是否展示了联系方式 —— 前端据此显示「待审核」之类的提示 */
    contactVisible: show && contactOpen,
    wechat: show && contactOpen && canSee('wechat', m, pref, fvis, who) ? (row.wechat || '') : '',
    qq: show && contactOpen && canSee('qq', m, pref, fvis, who) ? (row.qq || '') : '',
    phone: show && contactOpen && canSee('phone', m, pref, fvis, who) ? (row.phone || '') : '',
    /* 未通过审核时，给出脱敏预览，让查询者知道「有，但还没核实」 */
    phoneMasked: !(show && contactOpen) && row.phone ? maskPhone(row.phone) : '',
    updatedAt: row.updated_at,
  };

  /* ---- 额外字段（v2.4.0）：自定义字段 + id_card/youth_league_no 这类
     不在固定输出里的字段。按三层可见性逐个过筛，看不到的直接不出现
     （连键都不给），避免前端从「键存在但值为空」推断出信息是否存在。 ---- */
  const fields = [];
  for (const field of Object.keys(m)) {
    if (FIXED_FIELDS.has(field)) continue;
    /* 表里没这列就跳过（元数据有、列还没建的历史状态） */
    if (!(field in row)) continue;
    const v = row[field];
    if (v == null || v === '') continue;
    if (!canSee(field, m, pref, fvis, who)) continue;
    fields.push({ field, label: m[field].label || field, value: String(v) });
  }
  out.fields = fields;

  return out;
}

/**
 * 已经由 shapeProfile 固定输出的字段 —— 不要在 `fields` 里重复它们。
 * ⚠️ 改这里的清单时，记得同步 admin.js 的 SPECIAL_FIELDS。
 */
const FIXED_FIELDS = new Set(['name', 'student_id', 'politics', 'exam_no', 'role']);

/* ---------------- 查询（核心） ---------------- */
async function search(req, res, u) {
  const q = cleanQ(req.query.q);
  if (!q) return fail(res, 400, '请输入姓名或学号');

  const sql = getSql();

  /* 支持四种命中：① 学号前缀 ② 姓名包含 ③ 智学网账号前缀 ④ 姓名哈希（老数据兼容）
     学号/智学网账号用前缀匹配方便同学只打几位；姓名用包含匹配贴近搜索习惯。 */
  const like = '%' + q + '%';
  const sidLike = q + '%';

  /* ⚠️ 2026-10-08：不再「不返回任何记录」。
     过去是 if (!rows.length) return ok(... 空结果)；现在保持同样语义，
     但把 meta 查询提到前面 —— 每个请求只查**一次**字段元数据，循环里复用。 */
  const meta = await loadMeta(sql);

  const rows = await sql`
    select *
      from profiles
     where student_id ilike ${sidLike}
        or name ilike ${like}
        or exam_no like ${sidLike}
     order by student_id nulls last, name
     limit ${MAX_RESULTS}
  `;

  if (!rows.length) {
    return ok(res, { query: q, results: [], message: '未找到匹配的资料' });
  }

  /* 写查看日志：每个命中都记一条。日志失败不影响查询结果。 */
  try {
    const h = req.headers || {};
    const ip = String(h['cf-connecting-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || h['x-real-ip'] || '').slice(0, 64);
    for (const r of rows) {
      await sql`
        insert into profile_view_log (viewer_id, target_id, target_name, keyword, ip)
        values (${u.id}, ${r.id}, ${r.name || r.student_id || ''}, ${q}, ${ip || null})
      `;
    }
  } catch (e) {
    console.warn('[profile] 写查看日志失败（不影响查询）：', e.message);
  }

  /* 查询者是不是班委，只算一次（isCommittee 不查库，纯内存判断） */
  const committee = isCommittee(u);

  return ok(res, {
    query: q,
    results: rows.map((r) => {
      /* 查到自己 → 返回完整信息，方便在页内直接编辑联系方式 */
      const isSelf = !!(u.profileId && Number(u.profileId) === Number(r.id));
      return shapeProfile(r, isSelf, meta, { self: isSelf, committee });
    }),
  });
}

/* ---------------- 班级名单（2026-10-07）----------------
   用途：领券人选择、补发券等「只要姓名」的场景。
   背景：这些名字原先硬编码在 index.html 的 CLASS_LIST_ENC 里（XOR + Base64，
        但密钥就在同一份 JS 中，等于公开），新人转班、改名都要改代码重发版。
   现在改为登录后从云端拉，前端缓存到 localStorage 供离线 / 小游戏读取。
   ⚠️ 只返回姓名与学号，**不含任何联系方式**（微信 / QQ / 手机号一律不下发）。 */
async function roster(req, res) {
  const sql = getSql();
  const rows = await sql`
    select name, student_id
      from profiles
     where coalesce(name, '') <> ''
     order by student_id nulls last, name
  `;
  return ok(res, {
    count: rows.length,
    names: rows.map((r) => r.name),
    /* 学号只在前端做排序 / 去重备用，同样是班内公开信息 */
    students: rows.map((r) => ({ name: r.name, studentId: r.student_id || '' })),
  });
}

/* ---------------- 我的资料 ---------------- */
async function myProfile(req, res, u) {
  const sql = getSql();
  let rows = [];
  if (u.profileId) {
    /* 2026-10-08：改为 `select p.*` —— 以后 profiles 加列（学籍号、身份证号…）
       自动带出来，不用回来改这个 select。字段过滤统一交给私有区逻辑处理。 */
    rows = await sql`select * from profiles where id = ${u.profileId} limit 1`;
  }
  if (!rows.length) {
    /* 尚未认领：返回空壳，前端据此提示「请先认领你的资料」。
       ⚠️ 未认领也要回同一套键（privateFields / visibilityPref / fieldMeta），
          否则前端得写两套判断；接口形状一致比省一次查询更值。 */
    const meta0 = await loadMeta(sql);
    return ok(res, {
      profile: null,
      claimed: false,
      privateFields: [],
      visibilityPref: {},
      fieldMeta: Object.keys(meta0).map((f) => ({
        field: f, label: meta0[f].label, visibility: meta0[f].visibility, sortOrder: meta0[f].sortOrder,
      })),
    });
  }
  const row = rows[0];
  const meta = await loadMeta(sql);
  /* 本人看自己：一律 full=true，可见性一律放行（self 就是「本人」） */
  const p = shapeProfile(row, true, meta, { self: true, committee: true });
  p.rejectReason = row.reject_reason || '';

  /* 私有字段：元数据里 visibility='self' 的那些（身份证号、发展团员编号…）。
     v2.4.0 起这些列真的存在了（schema.sql 已补列），所以能真正取到值。

     ⚠️ 这里的白名单思路：只把「profiles 表里真的有的列」吐出去，
        避免把 id / user_id / name_hash 之类内部列漏给前端。 */
  const privateFields = [];
  const skip = new Set(['id', 'name_hash', 'user_id', 'visibility_pref', 'field_vis', 'created_at', 'updated_at', 'reject_reason']);
  for (const field of Object.keys(meta)) {
    if (skip.has(field)) continue;
    if (meta[field].visibility !== 'self') continue;
    /* 表里没这列就跳过（老库还没自愈出列时的兜底） */
    if (!(field in row)) continue;
    const val = row[field];
    if (val == null || val === '') continue;
    privateFields.push({
      field,
      label: meta[field].label,
      value: String(val),
      sortOrder: meta[field].sortOrder,
    });
  }
  privateFields.sort((a, b) => a.sortOrder - b.sortOrder);

  /* ⚠️ privateFields 与 p.fields 会重叠：本人看自己时 shapeProfile 的 canSee
     一律放行，self 档字段会同时进 fields。这里把 self 档从 fields 里摘掉，
     让前端的分工清晰：fields = 可对外展示的额外字段，privateFields = 仅本人可见。 */
  const privSet = new Set(privateFields.map((f) => f.field));
  if (p.fields) p.fields = p.fields.filter((f) => !privSet.has(f.field));

  return ok(res, {
    profile: p,
    claimed: true,
    privateFields,
    /* 本人当前的可见性意愿，供前端回显开关状态 */
    visibilityPref: parsePref(row.visibility_pref),
    /* 字段元数据（仅含公开档位信息，不含敏感内容），前端可用来渲染提示 */
    fieldMeta: Object.keys(meta).map((f) => ({
      field: f, label: meta[f].label, visibility: meta[f].visibility,
      sortOrder: meta[f].sortOrder, isCustom: !!meta[f].isCustom,
    })),
  });
}

/* ---------------- 我提交的联系方式与状态 ---------------- */
async function mineRequests(req, res, u) {
  const sql = getSql();
  if (!u.profileId) return ok(res, { requests: [], claimed: false });
  const rows = await sql`
    select id, name, student_id, wechat, qq, phone, contact_status,
           reject_reason, visibility_pref, updated_at
      from profiles where id = ${u.profileId} limit 1
  `;
  if (!rows.length) return ok(res, { requests: [], claimed: false });
  const r = rows[0];
  return ok(res, {
    claimed: true,
    requests: [{
      id: Number(r.id),
      name: r.name || '',
      studentId: r.student_id || '',
      wechat: r.wechat || '',
      qq: r.qq || '',
      phone: r.phone || '',
      status: r.contact_status || 'none',
      rejectReason: r.reject_reason || '',
      updatedAt: r.updated_at,
    }],
    /* 本人可见性意愿，供「仅自己可见」开关回显 */
    visibilityPref: parsePref(r.visibility_pref),
  });
}

/* ---------------- 认领本人资料（学号 + 姓名双重校验） ---------------- */
async function claim(req, res, u) {
  if (req.method !== 'POST') return fail(res, 405, '请用 POST');
  const b = await body(req);
  const sid = clean(b.studentId, 20);
  const name = clean(b.name, 20);
  if (!sid || !name) return fail(res, 400, '请填写学号与姓名');

  const sql = getSql();

  /* 已被别人认领过就拒绝，避免互相顶掉 */
  const exists = await sql`
    select id, user_id, name, student_id from profiles
     where student_id = ${sid} and name = ${name} limit 1
  `;
  if (!exists.length) {
    return fail(res, 404, '学号与姓名对不上，请核对后重试；若确有误请联系管理员');
  }
  const row = exists[0];
  if (row.user_id && Number(row.user_id) !== Number(u.id)) {
    return fail(res, 409, '该资料已被其他账号认领，如有疑问请联系管理员');
  }

  await sql`
    update profiles set user_id = ${u.id}, updated_at = now()
     where id = ${row.id}
  `;
  return ok(res, { message: '认领成功', profileId: Number(row.id) });
}

/* ---------------- 提交 / 修改自己的联系方式 ---------------- */
async function submit(req, res, u) {
  if (req.method !== 'POST') return fail(res, 405, '请用 POST');
  if (!u.profileId) return fail(res, 400, '请先认领你的资料，再填写联系方式');

  const b = await body(req);
  const wechat = cleanContact(b.wechat);
  const qq     = cleanContact(b.qq);
  const phone  = cleanContact(b.phone);

  /* 2026-10-08：可以只改可见性、不动联系方式。
     前端「仅自己可见」开关是靠 visibilityPref 单独提交的，
     若仍然要求「至少填一项联系方式」，已经填过的人想改开关就会被拦。
     所以只要本次带了 visibilityPref，就跳过「至少一项」校验。 */
  const hasPref = b.visibilityPref && typeof b.visibilityPref === 'object';

  if (!hasPref && !wechat && !qq && !phone) {
    return fail(res, 400, '请至少填写一项联系方式');
  }
  if (phone && !/^[0-9+\-() ]{6,20}$/.test(phone)) {
    return fail(res, 400, '手机号格式看起来不对');
  }
  if (qq && !/^[0-9]{5,12}$/.test(qq)) {
    return fail(res, 400, 'QQ 号应为 5–12 位数字');
  }

  const sql = getSql();

  /* 可见性意愿：只接受下面这三个键，值是布尔。
     ⚠️ 本人意愿**只收窄不放宽**——把它写成 false 会把该字段压到 self；
        写成 true 只是「我不反对公开」，最终仍受后台上限约束。
        想放宽（本来 self 想改 public）必须走管理员，见下方注释。 */
  let prefJson = null;
  if (hasPref) {
    const allow = ['wechat', 'qq', 'phone'];
    const cleanPref = {};
    for (const k of allow) {
      if (k in b.visibilityPref) cleanPref[k] = !!b.visibilityPref[k];
    }
    prefJson = JSON.stringify(cleanPref);
  }

  /* 提交后一律回到 pending：改了内容就要重新核实，这是审核的意义所在。
     reject_reason 一并清空（那是上一次驳回的理由）。
     visibility_pref 只在本次带了新值时覆盖，避免「改联系方式顺手把开关重置」。 */
  if (prefJson != null) {
    await sql`
      update profiles
         set wechat = ${wechat || null},
             qq = ${qq || null},
             phone = ${phone || null},
             contact_status = 'pending',
             reject_reason = null,
             visibility_pref = ${prefJson},
             updated_at = now()
       where id = ${u.profileId}
    `;
  } else {
    await sql`
      update profiles
         set wechat = ${wechat || null},
             qq = ${qq || null},
             phone = ${phone || null},
             contact_status = 'pending',
             reject_reason = null,
             updated_at = now()
       where id = ${u.profileId}
    `;
  }

  return ok(res, {
    message: '已提交，等待管理员核实后展示',
    status: 'pending',
  });
}
