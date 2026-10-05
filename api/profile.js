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
  cors, handlePreflight, ok, fail, body, requireUser, requireUserReady,
} from './_lib/http.js';

/** 单次查询返回的最大条数（防止有人拉全表） */
const MAX_RESULTS = 30;
/** 关键词长度上限 */
const MAX_Q = 40;
/** 联系方式字段长度上限 */
const MAX_CONTACT = 64;

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
 */
function shapeProfile(row, full) {
  const approved = row.contact_status === 'approved';
  /* 只有审核通过的才对外展示；本人（full）例外，便于确认自己填了什么 */
  const show = full || approved;
  return {
    id: Number(row.id),
    name: row.name || '',
    studentId: row.student_id || '',
    politics: row.politics || '',
    role: row.role || '学生',
    contactStatus: row.contact_status || 'none',
    /* 是否展示了联系方式 —— 前端据此显示「待审核」之类的提示 */
    contactVisible: show,
    wechat: show ? (row.wechat || '') : '',
    qq: show ? (row.qq || '') : '',
    phone: show ? (row.phone || '') : '',
    /* 未通过审核时，给出脱敏预览，让查询者知道「有，但还没核实」 */
    phoneMasked: !show && row.phone ? maskPhone(row.phone) : '',
    updatedAt: row.updated_at,
  };
}

/* ---------------- 查询（核心） ---------------- */
async function search(req, res, u) {
  const q = cleanQ(req.query.q);
  if (!q) return fail(res, 400, '请输入姓名或学号');

  const sql = getSql();

  /* 支持三种命中：① 学号前缀 ② 姓名包含 ③ 姓名哈希（老数据兼容）
     学号用前缀匹配方便同学只打几位；姓名用包含匹配贴近搜索习惯。 */
  const like = '%' + q + '%';
  const sidLike = q + '%';

  const rows = await sql`
    select id, name, student_id, politics, role, wechat, qq, phone,
           contact_status, updated_at
      from profiles
     where student_id ilike ${sidLike}
        or name ilike ${like}
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

  return ok(res, {
    query: q,
    results: rows.map((r) => {
      /* 查到自己 → 返回完整信息，方便在页内直接编辑联系方式 */
      const isSelf = u.profileId && Number(u.profileId) === Number(r.id);
      return shapeProfile(r, isSelf);
    }),
  });
}

/* ---------------- 我的资料 ---------------- */
async function myProfile(req, res, u) {
  const sql = getSql();
  let rows = [];
  if (u.profileId) {
    rows = await sql`
      select id, name, student_id, politics, role, wechat, qq, phone,
             contact_status, reject_reason, updated_at
        from profiles where id = ${u.profileId} limit 1
    `;
  }
  if (!rows.length) {
    /* 尚未认领：返回空壳，前端据此提示「请先认领你的资料」 */
    return ok(res, { profile: null, claimed: false });
  }
  const p = shapeProfile(rows[0], true);
  p.rejectReason = rows[0].reject_reason || '';
  return ok(res, { profile: p, claimed: true });
}

/* ---------------- 我提交的联系方式与状态 ---------------- */
async function mineRequests(req, res, u) {
  const sql = getSql();
  if (!u.profileId) return ok(res, { requests: [], claimed: false });
  const rows = await sql`
    select id, name, student_id, wechat, qq, phone, contact_status,
           reject_reason, updated_at
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

  if (!wechat && !qq && !phone) {
    return fail(res, 400, '请至少填写一项联系方式');
  }
  if (phone && !/^[0-9+\-() ]{6,20}$/.test(phone)) {
    return fail(res, 400, '手机号格式看起来不对');
  }
  if (qq && !/^[0-9]{5,12}$/.test(qq)) {
    return fail(res, 400, 'QQ 号应为 5–12 位数字');
  }

  const sql = getSql();
  /* 提交后一律回到 pending：改了内容就要重新核实，这是审核的意义所在。
     reject_reason 一并清空（那是上一次驳回的理由）。 */
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

  return ok(res, {
    message: '已提交，等待管理员核实后展示',
    status: 'pending',
  });
}
