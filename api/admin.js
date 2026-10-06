/* ============================================================
   /api/admin  —— 管理员后台接口
   ------------------------------------------------------------
   GET    /api/admin?action=users                     用户列表（含数据条数）
   GET    /api/admin?action=user&id=1                 单个用户详情 + 其云端数据
   GET    /api/admin?action=stats                     简单统计
   GET    /api/admin?action=audit                     操作日志
   POST   /api/admin?action=reset-password            重置某用户密码
   POST   /api/admin?action=set-status                启用/禁用
   POST   /api/admin?action=set-role                  设为管理员/普通用户
   POST   /api/admin?action=set-data                  改某用户的某条数据
   POST   /api/admin?action=delete-data               删某用户的某条数据
   POST   /api/admin?action=delete-user               删号（连带其数据）
   POST   /api/admin?action=clear-sessions            强制某用户全部设备下线

   班级通讯录 / 个人资料（2026-10-05 新增）
   GET    /api/admin?action=profiles                  资料列表（可按状态/关键词筛）
   GET    /api/admin?action=profile&id=1              单条资料详情
   GET    /api/admin?action=profile-requests          待审核的联系方式列表
   GET    /api/admin?action=view-logs                 资料查看日志（谁看了谁）
   POST   /api/admin?action=review-contact            审核联系方式：通过 / 驳回
   POST   /api/admin?action=save-profile              新增或修改资料（姓名/学号/政治面貌）
   POST   /api/admin?action=delete-profile            删除一条资料
   POST   /api/admin?action=batch-profiles            批量导入资料

   头衔任命 / AI 交接（2026-10-05 新增）
   GET    /api/admin?action=titles                    头衔列表（谁担任什么职务）
   GET    /api/admin?action=ai-account                当前 AI 助手账号是谁
   POST   /api/admin?action=set-title                 任命/撤销头衔
   POST   /api/admin?action=handover-ai               把 AI 助手身份转交给另一个账号
   ============================================================ */

import { getSql } from './_lib/db.js';
import {
  cors, handlePreflight, ok, fail, body, requireAdmin, audit,
} from './_lib/http.js';
import { hashPassword } from './_lib/password.js';
import { listSecrets, saveSecret, deleteSecret } from './_lib/secrets-store.js';

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  cors(req, res);

  const me = await requireAdmin(req, res);
  if (!me) return;

  const action = String(req.query.action || 'users').toLowerCase();

  try {
    /* 读操作 */
    if (req.method === 'GET') {
      if (action === 'users')      return await listUsers(req, res);
      if (action === 'user')       return await userDetail(req, res);
      if (action === 'stats')      return await stats(req, res);
      if (action === 'audit')      return await listAudit(req, res);
      if (action === 'login-logs') return await loginLogs(req, res);
      if (action === 'export')     return await exportUsers(req, res);
      if (action === 'profiles')         return await listProfiles(req, res);
      if (action === 'profile')          return await profileDetail(req, res);
      if (action === 'profile-requests') return await profileRequests(req, res);
      if (action === 'view-logs')        return await viewLogs(req, res);
      if (action === 'titles')           return await listTitles(req, res);
      if (action === 'ai-account')       return await aiAccount(req, res);
      if (action === 'secrets')          return await listAdminSecrets(req, res);
      return fail(res, 404, '未知的 action：' + action);
    }

    /* 写操作 */
    if (req.method === 'POST') {
      const b = await body(req);
      switch (action) {
        case 'create-user':    return await createUser(req, res, me, b);
        case 'batch-create':   return await batchCreate(req, res, me, b);
        case 'reset-password': return await resetPassword(req, res, me, b);
        case 'set-status':     return await setStatus(req, res, me, b);
        case 'set-role':       return await setRole(req, res, me, b);
        case 'set-data':       return await setData(req, res, me, b);
        case 'delete-data':    return await deleteData(req, res, me, b);
        case 'delete-user':    return await deleteUser(req, res, me, b);
        case 'clear-sessions': return await clearSessions(req, res, me, b);
        case 'review-contact': return await reviewContact(req, res, me, b);
        case 'save-profile':   return await saveProfile(req, res, me, b);
        case 'delete-profile': return await deleteProfile(req, res, me, b);
        case 'batch-profiles': return await batchProfiles(req, res, me, b);
        case 'bind-profiles':  return await bindProfiles(req, res, me, b);
        case 'set-title':      return await setTitle(req, res, me, b);
        case 'handover-ai':    return await handoverAi(req, res, me, b);
        case 'save-secret':    return await saveAdminSecret(req, res, me, b);
        case 'delete-secret':  return await deleteAdminSecret(req, res, me, b);
        default:               return fail(res, 404, '未知的 action：' + action);
      }
    }

    return fail(res, 405, '不支持的方法');
  } catch (e) {
    console.error('[admin]', action, e);
    return fail(res, 500, '服务器内部错误，请稍后重试');
  }
}

/* ---------------- 用户名 / 密码校验（与 auth.js 保持一致） ---------------- */
function normUsername(s) {
  return String(s || '').trim().toLowerCase();
}
function validUsername(u) {
  /* 与 auth.js 保持一致（2026-10-06 放宽到 2 位）；此副本曾漏改导致两字姓名导入被拒 */
  return /^[a-z0-9_\u4e00-\u9fa5]{2,20}$/.test(u);
}

/* ---------------- 读：用户列表 ---------------- */
async function listUsers(req, res) {
  const sql = getSql();
  const q = String(req.query.q || '').trim().toLowerCase();
  const limit = Math.min(Number(req.query.limit || 200), 500);
  const offset = Math.max(Number(req.query.offset || 0), 0);

  const rows = await sql`
    select u.id, u.username, u.display_name, u.role, u.status,
           u.created_at, u.last_login_at,
           coalesce(u.must_change_password, false) as must_change_password,
           coalesce(d.n, 0)::int as data_count
      from users u
      left join (
        select user_id, count(*)::int as n from user_data group by user_id
      ) d on d.user_id = u.id
     where (${q} = '' or lower(u.username) like '%' || ${q} || '%'
                         or lower(coalesce(u.display_name,'')) like '%' || ${q} || '%')
     order by u.id
     limit ${limit} offset ${offset}
  `;
  const total = (await sql`select count(*)::int as n from users`)[0].n;

  return ok(res, {
    total,
    users: rows.map((r) => ({
      id: Number(r.id),
      username: r.username,
      displayName: r.display_name,
      role: r.role,
      status: r.status,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
      mustChangePassword: !!r.must_change_password,
      dataCount: r.data_count,
    })),
  });
}

/* ---------------- 读：单个用户 + 其数据 ---------------- */
async function userDetail(req, res) {
  const id = Number(req.query.id);
  if (!id) return fail(res, 400, '缺少 id 参数');
  const sql = getSql();

  const rows = await sql`
    select id, username, display_name, role, status, created_at, last_login_at
      from users where id = ${id}
  `;
  if (!rows.length) return fail(res, 404, '用户不存在');
  const u = rows[0];

  const data = await sql`
    select data_key, data_value, updated_at
      from user_data where user_id = ${id} order by data_key
  `;
  const sessions = await sql`
    select token, created_at, expires_at from sessions
     where user_id = ${id} and expires_at > now() order by created_at desc
  `;

  return ok(res, {
    user: {
      id: Number(u.id),
      username: u.username,
      displayName: u.display_name,
      role: u.role,
      status: u.status,
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at,
    },
    data: data.map((d) => ({
      key: d.data_key,
      value: d.data_value,
      updatedAt: d.updated_at,
    })),
    /* token 只显示前 8 位，避免完整凭据出现在前端 */
    sessions: sessions.map((s) => ({
      tokenPrefix: String(s.token).slice(0, 8) + '…',
      createdAt: s.created_at,
      expiresAt: s.expires_at,
    })),
  });
}

/* ---------------- 读：统计 ---------------- */
async function stats(req, res) {
  const sql = getSql();
  const [u] = await sql`
    select count(*)::int as total,
           count(*) filter (where status = 'banned')::int as banned,
           count(*) filter (where role = 'admin')::int as admins,
           count(*) filter (where coalesce(must_change_password,false))::int as pending_pwd,
           count(*) filter (where last_login_at > now() - interval '7 days')::int as active7,
           count(*) filter (where last_login_at >= date_trunc('day', now()))::int as today_active
      from users
  `;
  const [d] = await sql`select count(*)::int as rows, coalesce(sum(pg_column_size(data_value)),0)::bigint as bytes from user_data`;
  const [s] = await sql`select count(*)::int as n from sessions where expires_at > now()`;

  /* 哪些键用得最多（了解同学最在意什么功能） */
  const topKeys = await sql`
    select data_key, count(*)::int as n from user_data
     group by data_key order by n desc limit 10
  `;

  /* 登录相关统计 + 最近登录记录。login_log 表不存在时静默降级为 0/空数组，
     避免老库没执行建表脚本时整个概览页报错。 */
  let loginTotal = 0;
  let loginToday = 0;
  let recentLogins = [];
  try {
    const [lt] = await sql`select count(*)::int as n from login_log`;
    loginTotal = lt.n;
    const [ld] = await sql`
      select count(*)::int as n from login_log where created_at >= date_trunc('day', now())
    `;
    loginToday = ld.n;
    const rl = await sql`
      select l.user_id, l.ip, l.created_at, u.username
        from login_log l
        left join users u on u.id = l.user_id
       order by l.created_at desc
       limit 15
    `;
    recentLogins = rl.map((r) => ({
      userId: Number(r.user_id),
      username: r.username,
      ip: r.ip,
      createdAt: r.created_at,
    }));
  } catch (e) {
    console.warn('[admin] login_log 不可用（可能未执行建表脚本）：', e.message);
  }

  /* 通讯录统计：资料总数、待审核数、已认领数、近 7 天查看量。
     与上面同理，表不存在时静默降级，不影响概览页其他部分。 */
  let profileStats = { total: 0, pending: 0, approved: 0, claimed: 0, views7: 0, viewsTotal: 0 };
  try {
    const [p] = await sql`
      select count(*)::int as total,
             count(*) filter (where contact_status = 'pending')::int  as pending,
             count(*) filter (where contact_status = 'approved')::int as approved,
             count(*) filter (where user_id is not null)::int         as claimed
        from profiles
    `;
    profileStats = { ...profileStats, ...p };
    const [v1] = await sql`select count(*)::int as n from profile_view_log`;
    const [v2] = await sql`
      select count(*)::int as n from profile_view_log
       where created_at > now() - interval '7 days'
    `;
    profileStats.viewsTotal = v1.n;
    profileStats.views7 = v2.n;
  } catch (e) {
    console.warn('[admin] profiles / profile_view_log 不可用：', e.message);
  }

  return ok(res, {
    users: u,
    data: { rows: d.rows, bytes: Number(d.bytes) },
    activeSessions: s.n,
    topKeys: topKeys.map((k) => ({ key: k.data_key, count: k.n })),
    login: { total: loginTotal, today: loginToday, recent: recentLogins },
    profiles: profileStats,
  });
}

/* ---------------- 读：操作日志 ---------------- */
async function listAudit(req, res) {
  const sql = getSql();
  const limit = Math.min(Number(req.query.limit || 100), 300);
  const rows = await sql`
    select a.id, a.action, a.target_type, a.target_id, a.detail, a.created_at,
           u.username as actor
      from audit_log a
      left join users u on u.id = a.actor_id
     order by a.created_at desc
     limit ${limit}
  `;
  return ok(res, { logs: rows });
}

/* ---------------- 写：重置密码 ---------------- */
async function resetPassword(req, res, me, b) {
  const id = Number(b.id);
  const newPwd = String(b.newPassword || '');
  if (!id) return fail(res, 400, '缺少 id');
  if (newPwd.length < 6 || newPwd.length > 64) return fail(res, 400, '新密码需 6–64 位');

  const sql = getSql();
  const hash = await hashPassword(newPwd);
  /* 管理员重置的密码等同「新的初始密码」→ 把强制改密标记置回 true，
     要求对方下次登录时再自行设置。否则管理员会一直知道对方密码。 */
  const rows = await sql`
    update users
       set password_hash = ${hash},
           must_change_password = true,
           failed_count = 0,
           locked_until = null
     where id = ${id}
    returning username
  `;
  if (!rows.length) return fail(res, 404, '用户不存在');

  /* 重置密码后踢掉该用户所有登录 */
  await sql`delete from sessions where user_id = ${id}`;
  await audit(me.id, 'user.reset_password', 'user', String(id), rows[0].username);

  return ok(res, {
    message: '已重置 ' + rows[0].username + ' 的密码，该用户需用新密码登录并自行修改',
  });
}

/* ---------------- 写：启用/禁用 ---------------- */
async function setStatus(req, res, me, b) {
  const id = Number(b.id);
  const status = String(b.status || '');
  if (!id) return fail(res, 400, '缺少 id');
  if (!['active', 'banned'].includes(status)) return fail(res, 400, 'status 只能是 active 或 banned');
  if (id === me.id) return fail(res, 400, '不能禁用自己的账号');

  const sql = getSql();
  const rows = await sql`
    update users set status = ${status} where id = ${id}
    returning username
  `;
  if (!rows.length) return fail(res, 404, '用户不存在');

  if (status === 'banned') await sql`delete from sessions where user_id = ${id}`;
  await audit(me.id, 'user.set_status', 'user', String(id), status);

  return ok(res, { message: (status === 'banned' ? '已禁用 ' : '已启用 ') + rows[0].username });
}

/* ---------------- 写：设为管理员/普通用户 ---------------- */
async function setRole(req, res, me, b) {
  const id = Number(b.id);
  const role = String(b.role || '');
  if (!id) return fail(res, 400, '缺少 id');
  if (!['user', 'admin'].includes(role)) return fail(res, 400, 'role 只能是 user 或 admin');
  if (id === me.id && role !== 'admin') return fail(res, 400, '不能取消自己的管理员身份');

  const sql = getSql();
  const rows = await sql`
    update users set role = ${role} where id = ${id}
    returning username
  `;
  if (!rows.length) return fail(res, 404, '用户不存在');

  await audit(me.id, 'user.set_role', 'user', String(id), role);
  return ok(res, { message: '已把 ' + rows[0].username + ' 设为' + (role === 'admin' ? '管理员' : '普通用户') });
}

/* ============================================================================
 * 头衔系统（2026-10-05 新增）
 * ----------------------------------------------------------------------------
 * 班级职务，由管理员任命。头衔存在 profiles.title 里，英文逗号分隔，
 * 一个人可以兼多个职务（如「团支书,课代表」）。
 *
 * 授权方面：目前只有「课代表」参与实际授权——可以编辑云端作业
 * （见 api/content.js 里的 requireTitle 判定）。其余头衔先只做展示，
 * 以后要扩权就在对应接口换上 requireTitle('xxx') 即可。
 *
 * ⚠️ 安全边界：头衔只写进 profiles.title，接口授权时只读这个字段。
 *    前端传什么头衔都不作数，否则谁都能自称课代表去改作业。
 * ========================================================================= */

/* 允许的头衔白名单。不在这个表里的值一律拒绝，避免脏数据。 */
const ALLOWED_TITLES = [
  '班长', '副班长', '团支书', '学习委员', '纪律委员',
  '生活委员', '体育委员', '文艺委员', '电教委',
  '语文课代表', '数学课代表', '英语课代表', '物理课代表',
  '化学课代表', '生物课代表', '政治课代表', '历史课代表',
  '地理课代表', '课代表',
];

/** 规范化头衔字符串：拆开、去空、去重、校验白名单 */
function normTitles(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[,，、\s]+/);
  const out = [];
  const bad = [];
  raw.forEach((x) => {
    const v = String(x || '').trim();
    if (!v) return;
    if (!ALLOWED_TITLES.includes(v)) { bad.push(v); return; }
    if (!out.includes(v)) out.push(v);
  });
  return { list: out, bad };
}

/* ---------------- 读：头衔一览 ---------------- */
async function listTitles(req, res) {
  const sql = getSql();
  const rows = await sql`
    select p.id, p.name, p.student_id, p.title, p.role, p.user_id,
           u.username, u.display_name
      from profiles p
      left join users u on u.id = p.user_id
     where coalesce(p.title, '') <> ''
     order by p.id
  `;
  const ai = await sql`
    select id, username, display_name from users
     where is_ai = true order by id limit 1
  `;
  return ok(res, {
    profiles: rows.map((r) => ({
      id: Number(r.id),
      name: r.name || '',
      studentId: r.student_id || '',
      title: r.title || '',
      titles: normTitles(r.title).list,
      role: r.role || '学生',
      userId: r.user_id ? Number(r.user_id) : null,
      username: r.username || null,
      displayName: r.display_name || null,
    })),
    allowed: ALLOWED_TITLES,
    aiAccount: ai.length
      ? { id: Number(ai[0].id), username: ai[0].username, displayName: ai[0].display_name || 'ai助手' }
      : null,
  });
}

/* ---------------- 写：任命 / 撤销头衔 ---------------- */
async function setTitle(req, res, me, b) {
  const id = Number(b.id);
  if (!id) return fail(res, 400, '缺少资料 id');

  const { list, bad } = normTitles(b.titles !== undefined ? b.titles : b.title);
  if (bad.length) {
    return fail(res, 400, '不认识的头衔：' + bad.join('、') + '。可选：' + ALLOWED_TITLES.join('、'));
  }

  const sql = getSql();
  /* 空字符串而不是 null：前端判断更省事，也不会把「已清空」和「从没设过」混起来 */
  const val = list.join(',');
  const rows = await sql`
    update profiles set title = ${val}, updated_at = now()
     where id = ${id}
    returning name
  `;
  if (!rows.length) return fail(res, 404, '资料不存在');

  await audit(me.id, 'profile.set_title', 'profile', String(id),
    (rows[0].name || '') + ' → ' + (val || '（已清空）'));
  return ok(res, {
    message: list.length
      ? '已把 ' + (rows[0].name || '该同学') + ' 任命为：' + list.join('、')
      : '已清空 ' + (rows[0].name || '该同学') + ' 的头衔',
    titles: list,
  });
}

/* ============================================================================
 * AI 助手账号与交接（2026-10-05 新增）
 * ----------------------------------------------------------------------------
 * AI 助手是一个真实的管理员账号（users.role='admin' 且 is_ai=true），
 * 它能通过 /api/content 编辑云端公告与作业。
 *
 * 交接设计（为什么需要）：
 *   现在用的 AI 助手将来可能换人/换模型，如果账号写死在代码里，
 *   每次交接都要改代码重新部署。所以把「谁是 AI」做成数据库的一个标记位
 *   （users.is_ai），换的时候调一次 handover-ai 就行，代码一行不动。
 *
 *   交接后：旧账号降回普通用户并取消 is_ai；新账号提为管理员并打上 is_ai。
 *   会话 token 不迁移——新 AI 用新密码重新登录，避免旧 token 继续有效。
 * ========================================================================= */

/* ---------------- 读：当前 AI 账号是谁 ---------------- */
async function aiAccount(req, res) {
  const sql = getSql();
  const rows = await sql`
    select id, username, display_name, status, created_at, last_login_at
      from users where is_ai = true order by id limit 1
  `;
  return ok(res, {
    account: rows.length ? {
      id: Number(rows[0].id),
      username: rows[0].username,
      displayName: rows[0].display_name || 'ai助手',
      status: rows[0].status,
      lastLoginAt: rows[0].last_login_at || null,
    } : null,
  });
}

/* ---------------- 写：把 AI 身份转交给另一个账号 ---------------- */
async function handoverAi(req, res, me, b) {
  const username = normUsername(b.username);
  if (!username) return fail(res, 400, '请填写要接管的账号名');
  if (!validUsername(username)) return fail(res, 400, '账号名格式不对');

  const sql = getSql();

  /* 找目标账号 */
  const target = await sql`
    select id, username, role from users where lower(username) = ${username} limit 1
  `;
  if (!target.length) {
    return fail(res, 404, '找不到账号「' + username + '」。请先让新账号自行注册，再来这里交接。');
  }
  const newId = Number(target[0].id);

  /* 看当前是谁 */
  const cur = await sql`select id, username from users where is_ai = true order by id limit 1`;
  if (cur.length && Number(cur[0].id) === newId) {
    return fail(res, 400, '「' + username + '」已经是 AI 助手账号了');
  }

  /* 旧账号：取消标记并降回普通用户（不删号，他的其它数据都还在） */
  if (cur.length) {
    await sql`
      update users set is_ai = false, role = 'user' where id = ${Number(cur[0].id)}
    `;
  }

  /* 新账号：提为管理员并打标记 */
  await sql`
    update users set is_ai = true, role = 'admin' where id = ${newId}
  `;

  await audit(me.id, 'ai.handover', 'user', String(newId),
    'AI 助手：' + (cur.length ? cur[0].username : '(无)') + ' → ' + username);

  return ok(res, {
    message: '已把 AI 助手身份交给「' + username + '」。'
      + (cur.length ? '旧账号 ' + cur[0].username + ' 已降回普通用户，' : '')
      + '请用新账号重新登录。',
    previous: cur.length ? cur[0].username : null,
    current: username,
  });
}


/* ---------------- 写：修改某用户的某条数据 ---------------- */
async function setData(req, res, me, b) {
  const userId = Number(b.userId);
  const key = String(b.key || '');
  if (!userId) return fail(res, 400, '缺少 userId');
  if (!key) return fail(res, 400, '缺少 key');

  /* 值与 data.js 保持一致：JSON 序列化后不超过 200KB */
  const serialized = JSON.stringify(b.value === undefined ? null : b.value);
  if (serialized.length > 200 * 1024) return fail(res, 400, '内容过大，超过 200KB');

  const sql = getSql();
  await sql`
    insert into user_data (user_id, data_key, data_value, updated_at)
    values (${userId}, ${key}, ${serialized}::jsonb, now())
    on conflict (user_id, data_key)
    do update set data_value = excluded.data_value, updated_at = now()
  `;
  await audit(me.id, 'data.update', 'data', userId + '/' + key, null);
  return ok(res, { message: '已保存', key });
}

/* ---------------- 写：删除某用户的某条数据 ---------------- */
async function deleteData(req, res, me, b) {
  const userId = Number(b.userId);
  const key = String(b.key || '');
  if (!userId || !key) return fail(res, 400, '缺少 userId 或 key');

  const sql = getSql();
  await sql`delete from user_data where user_id = ${userId} and data_key = ${key}`;
  await audit(me.id, 'data.delete', 'data', userId + '/' + key, null);
  return ok(res, { message: '已删除', key });
}

/* ---------------- 写：删号 ---------------- */
async function deleteUser(req, res, me, b) {
  const id = Number(b.id);
  if (!id) return fail(res, 400, '缺少 id');
  if (id === me.id) return fail(res, 400, '不能删除自己的账号');

  const sql = getSql();
  const rows = await sql`delete from users where id = ${id} returning username`;
  if (!rows.length) return fail(res, 404, '用户不存在');

  /* user_data / sessions 由外键 on delete cascade 自动清理 */
  await audit(me.id, 'user.delete', 'user', String(id), rows[0].username);
  return ok(res, { message: '已删除账号 ' + rows[0].username + '（其云端数据一并清除）' });
}

/* ---------------- 写：强制下线 ---------------- */
async function clearSessions(req, res, me, b) {
  const id = Number(b.id);
  if (!id) return fail(res, 400, '缺少 id');
  const sql = getSql();
  await sql`delete from sessions where user_id = ${id}`;
  await audit(me.id, 'user.clear_sessions', 'user', String(id), null);
  return ok(res, { message: '已让该用户在所有设备退出登录' });
}

/* ============================================================
 * 以下为 2026-10-05 新增：后台专用开号 / 批量导入 / 登录记录 / 导出
 * ------------------------------------------------------------
 * 设计要点：
 *   ① 关闭自助注册后，账号一律由管理员在后台创建
 *   ② 新建的账号 must_change_password = true —— 同学首次登录必须改密
 *   ③ 管理员始终看不到明文密码（库里只有 PBKDF2 哈希），只能重置
 * ============================================================ */

/* ---------------- 写：创建单个用户 ---------------- */
async function createUser(req, res, me, b) {
  const username = normUsername(b.username);
  const password = String(b.password || '');
  const displayName = String(b.displayName || '').trim().slice(0, 30) || null;
  const role = b.role === 'admin' ? 'admin' : 'user';

  if (!validUsername(username)) {
    return fail(res, 400, '用户名需 3–20 位，仅限中英文、数字、下划线');
  }
  if (password.length < 6 || password.length > 64) {
    return fail(res, 400, '初始密码长度需 6–64 位');
  }

  const sql = getSql();
  const dup = await sql`select id from users where lower(username) = ${username} limit 1`;
  if (dup.length) return fail(res, 409, '用户名 ' + username + ' 已存在');

  const hash = await hashPassword(password);
  const rows = await sql`
    insert into users (username, display_name, password_hash, role, must_change_password)
    values (${username}, ${displayName}, ${hash}, ${role}, true)
    returning id, username
  `;
  await audit(me.id, 'user.create', 'user', String(rows[0].id), username);

  return ok(res, {
    message: '已创建账号 ' + username + '，该同学首次登录需自行修改密码',
    user: { id: Number(rows[0].id), username: rows[0].username },
  });
}

/* ---------------- 写：批量创建（Excel 导入用） ----------------
   接收 { users: [{ username, password, displayName, role }] }，
   逐条 try-catch，返回 created / failed / errors[{index, username, reason}]。
   index 是**批内下标**，前端据此换算回 Excel 真实行号。

   为避免一次请求算太久（Workers 免费版 CPU 时间有限，PBKDF2 每次约 5–10ms），
   这里限制单批最多 60 条 —— 由前端分片调用。 */
const BATCH_LIMIT = 60;

async function batchCreate(req, res, me, b) {
  const list = Array.isArray(b.users) ? b.users : null;
  if (!list) return fail(res, 400, 'users 必须是数组');
  if (list.length === 0) return ok(res, { created: 0, failed: 0, errors: [] });
  if (list.length > BATCH_LIMIT) {
    return fail(res, 400, '单批最多 ' + BATCH_LIMIT + ' 条，请分片提交');
  }

  const sql = getSql();
  const errors = [];
  let created = 0;

  /* ① 先做一次批内查重，减少无谓的哈希计算 */
  const seen = new Set();

  for (let i = 0; i < list.length; i++) {
    const raw = list[i] || {};
    const username = normUsername(raw.username);
    const password = String(raw.password || '');
    const displayName = String(raw.displayName || raw.name || '').trim().slice(0, 30) || null;
    const role = raw.role === 'admin' ? 'admin' : 'user';

    /* 各项校验，失败就记原因继续下一条 */
    if (!username) { errors.push({ index: i, reason: '用户名为空' }); continue; }
    if (!validUsername(username)) {
      errors.push({ index: i, username, reason: '用户名格式不对（2–20 位中英文/数字/下划线）' });
      continue;
    }
    if (password.length < 6 || password.length > 64) {
      errors.push({ index: i, username, reason: '密码长度需 6–64 位' });
      continue;
    }
    if (seen.has(username)) {
      errors.push({ index: i, username, reason: '本批次内重复' });
      continue;
    }
    seen.add(username);

    try {
      const dup = await sql`select id from users where lower(username) = ${username} limit 1`;
      if (dup.length) {
        errors.push({ index: i, username, reason: '用户名已存在' });
        continue;
      }
      const hash = await hashPassword(password);
      await sql`
        insert into users (username, display_name, password_hash, role, must_change_password)
        values (${username}, ${displayName}, ${hash}, ${role}, true)
      `;
      created++;
    } catch (e) {
      /* 唯一索引冲突等并发情况也走这里，不中断整批 */
      errors.push({ index: i, username, reason: '写入失败：' + (e.message || '未知错误') });
    }
  }

  await audit(
    me.id, 'user.batch_create', 'user', null,
    'created=' + created + ' failed=' + errors.length
  );

  return ok(res, { created, failed: errors.length, errors });
}

/* ---------------- 读：登录记录 ----------------
   GET ?action=login-logs&id=1&limit=50&offset=0   → 某人的登录历史
   GET ?action=login-logs&limit=50&offset=0        → 全站最近登录（不传 id）
   ------------------------------------------------------------ */
async function loginLogs(req, res) {
  const sql = getSql();
  const id = Number(req.query.id || 0);
  const limit = Math.min(Number(req.query.limit || 50), 300);
  const offset = Math.max(Number(req.query.offset || 0), 0);

  let rows;
  let total;

  if (id) {
    rows = await sql`
      select l.id, l.user_id, l.ip, l.user_agent, l.created_at, u.username
        from login_log l
        left join users u on u.id = l.user_id
       where l.user_id = ${id}
       order by l.created_at desc
       limit ${limit} offset ${offset}
    `;
    total = (await sql`select count(*)::int as n from login_log where user_id = ${id}`)[0].n;
  } else {
    rows = await sql`
      select l.id, l.user_id, l.ip, l.user_agent, l.created_at, u.username
        from login_log l
        left join users u on u.id = l.user_id
       order by l.created_at desc
       limit ${limit} offset ${offset}
    `;
    total = (await sql`select count(*)::int as n from login_log`)[0].n;
  }

  return ok(res, {
    total,
    logs: rows.map((r) => ({
      id: Number(r.id),
      userId: Number(r.user_id),
      username: r.username,
      ip: r.ip,
      userAgent: r.user_agent,
      createdAt: r.created_at,
    })),
  });
}

/* ---------------- 读：导出（按筛选返回全量，前端生成 xlsx） ----------------
   带上与列表页相同的筛选条件，做到「所见即所得」的导出。
   不返回密码哈希——只导出非敏感字段。 */
async function exportUsers(req, res) {
  const sql = getSql();
  const q = String(req.query.q || '').trim().toLowerCase();
  const role = String(req.query.role || '').trim().toLowerCase();
  const status = String(req.query.status || '').trim().toLowerCase();

  const rows = await sql`
    select u.id, u.username, u.display_name, u.role, u.status,
           u.created_at, u.last_login_at,
           coalesce(u.must_change_password, false) as must_change_password,
           coalesce(l.n, 0)::int as login_count
      from users u
      left join (
        select user_id, count(*)::int as n from login_log group by user_id
      ) l on l.user_id = u.id
     where (${q} = '' or lower(u.username) like '%' || ${q} || '%'
                         or lower(coalesce(u.display_name,'')) like '%' || ${q} || '%')
       and (${role} = ''   or u.role = ${role})
       and (${status} = '' or u.status = ${status})
     order by u.id
     limit 5000
  `;

  return ok(res, {
    total: rows.length,
    users: rows.map((r) => ({
      id: Number(r.id),
      username: r.username,
      displayName: r.display_name,
      role: r.role,
      status: r.status,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
      mustChangePassword: !!r.must_change_password,
      loginCount: r.login_count,
    })),
  });
}

/* ============================================================
   班级通讯录 / 个人资料 管理
   ------------------------------------------------------------
   分工：
     · 姓名 / 学号 / 政治面貌 —— 身份信息，只有管理员能改（本人无权限）
     · 微信 / QQ / 手机号     —— 同学自填，管理员审核后才对外展示
     · 查看日志               —— 记录谁在什么时候查了谁，管理员可查
   ============================================================ */

/** 清洗文本输入 */
function cText(s, max) {
  return String(s == null ? '' : s).trim().slice(0, max || 60);
}
/** 联系方式去危险字符 */
function cContact(s) {
  return String(s == null ? '' : s).trim().slice(0, 64).replace(/[<>"']/g, '');
}

/**
 * 资料列表。支持按关键词（姓名/学号）与审核状态筛选。
 * 这个接口返回的是**管理端视图**：含联系方式原文与关联账号，仅管理员可调。
 */
async function listProfiles(req, res) {
  const sql = getSql();
  const q = cText(req.query.q, 40).replace(/[%_\\]/g, '');
  const st = cText(req.query.status, 16);   /* '' | none | pending | approved | rejected */

  const rows = await sql`
    select p.id, p.name, p.student_id, p.politics, p.exam_no, p.role,
           p.wechat, p.qq, p.phone, p.contact_status, p.reject_reason,
           p.user_id, p.created_at, p.updated_at,
           u.username as bound_username
      from profiles p
      left join users u on u.id = p.user_id
     where (${q} = '' or coalesce(p.name,'') like '%' || ${q} || '%'
                         or coalesce(p.student_id,'') like '%' || ${q} || '%')
       and (${st} = '' or p.contact_status = ${st})
     order by p.student_id nulls last, p.name
     limit 1000
  `;

  /* 统计各状态数量，供后台顶部标签显示 */
  const cnt = await sql`
    select
      count(*)::int as total,
      count(*) filter (where contact_status = 'pending')::int  as pending,
      count(*) filter (where contact_status = 'approved')::int as approved,
      count(*) filter (where user_id is not null)::int         as claimed
      from profiles
  `;

  return ok(res, {
    total: rows.length,
    counts: cnt[0] || { total: 0, pending: 0, approved: 0, claimed: 0 },
    profiles: rows.map((r) => ({
      id: Number(r.id),
      name: r.name || '',
      studentId: r.student_id || '',
      politics: r.politics || '',
      examNo: r.exam_no || '',
      role: r.role || '学生',
      wechat: r.wechat || '',
      qq: r.qq || '',
      phone: r.phone || '',
      contactStatus: r.contact_status || 'none',
      rejectReason: r.reject_reason || '',
      userId: r.user_id ? Number(r.user_id) : null,
      boundUsername: r.bound_username || '',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
}

/** 单条资料详情 */
async function profileDetail(req, res) {
  const id = Number(req.query.id || 0);
  if (!id) return fail(res, 400, '缺少 id');
  const sql = getSql();
  const rows = await sql`
    select p.*, u.username as bound_username
      from profiles p left join users u on u.id = p.user_id
     where p.id = ${id} limit 1
  `;
  if (!rows.length) return fail(res, 404, '资料不存在');
  const r = rows[0];

  /* 顺带给出该资料的查看记录（最近 20 条），管理员点开就能看到谁查过 */
  let views = [];
  try {
    views = await sql`
      select v.created_at, v.keyword, v.ip, u.username as viewer
        from profile_view_log v
        left join users u on u.id = v.viewer_id
       where v.target_id = ${id}
       order by v.created_at desc
       limit 20
    `;
  } catch (e) { /* 表可能还没建，忽略 */ }

  return ok(res, {
    profile: {
      id: Number(r.id),
      name: r.name || '',
      studentId: r.student_id || '',
      politics: r.politics || '',
      examNo: r.exam_no || '',
      role: r.role || '学生',
      wechat: r.wechat || '',
      qq: r.qq || '',
      phone: r.phone || '',
      contactStatus: r.contact_status || 'none',
      rejectReason: r.reject_reason || '',
      userId: r.user_id ? Number(r.user_id) : null,
      boundUsername: r.bound_username || '',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    },
    views: views.map((v) => ({
      viewer: v.viewer || '(已删除账号)',
      keyword: v.keyword || '',
      ip: v.ip || '',
      createdAt: v.created_at,
    })),
  });
}

/** 待审核列表（只返回 pending，后台「待审核」页用） */
async function profileRequests(req, res) {
  const sql = getSql();
  const rows = await sql`
    select p.id, p.name, p.student_id, p.politics, p.exam_no, p.wechat, p.qq, p.phone,
           p.contact_status, p.updated_at, u.username as bound_username
      from profiles p
      left join users u on u.id = p.user_id
     where p.contact_status = 'pending'
     order by p.updated_at desc
     limit 500
  `;
  return ok(res, {
    total: rows.length,
    requests: rows.map((r) => ({
      id: Number(r.id),
      name: r.name || '',
      studentId: r.student_id || '',
      politics: r.politics || '',
      examNo: r.exam_no || '',
      wechat: r.wechat || '',
      qq: r.qq || '',
      phone: r.phone || '',
      status: r.contact_status,
      boundUsername: r.bound_username || '',
      updatedAt: r.updated_at,
    })),
  });
}

/**
 * 审核联系方式。
 * body: { id, approve: true|false, reason?: '驳回原因' }
 * 通过 → approved（对外可见）；驳回 → rejected + 记下原因（本人可见）
 */
async function reviewContact(req, res, me, b) {
  const id = Number(b.id || 0);
  if (!id) return fail(res, 400, '缺少 id');
  const approve = b.approve !== false;
  const reason = cText(b.reason, 200);

  const sql = getSql();
  const rows = await sql`select id, name, student_id from profiles where id = ${id} limit 1`;
  if (!rows.length) return fail(res, 404, '资料不存在');

  await sql`
    update profiles
       set contact_status = ${approve ? 'approved' : 'rejected'},
           reject_reason  = ${approve ? null : (reason || '管理员驳回')},
           updated_at     = now()
     where id = ${id}
  `;

  const label = rows[0].name || rows[0].student_id || ('#' + id);
  await audit(sql, me, approve ? 'profile.contact_approve' : 'profile.contact_reject', 'profile', String(id), label);

  return ok(res, {
    message: approve ? ('已通过 ' + label + ' 的联系方式') : ('已驳回 ' + label + ' 的联系方式'),
    status: approve ? 'approved' : 'rejected',
  });
}

/**
 * 新增或修改资料（管理员专用）。
 * body: { id?, name, studentId, politics, examNo?, role, wechat?, qq?, phone?, contactStatus? }
 * 带 id = 修改，不带 = 新增。
 */
async function saveProfile(req, res, me, b) {
  const id = Number(b.id || 0);
  const name = cText(b.name, 30);
  const sid = cText(b.studentId, 20);
  const politics = cText(b.politics, 30);
  const examNo = cText(b.examNo, 24);
  const role = cText(b.role, 10) || '学生';
  const wechat = cContact(b.wechat);
  const qq = cContact(b.qq);
  const phone = cContact(b.phone);
  const stRaw = cText(b.contactStatus, 16);
  const st = ['none', 'pending', 'approved', 'rejected'].includes(stRaw) ? stRaw : null;

  if (!name && !sid) return fail(res, 400, '姓名与学号至少填一项');

  const sql = getSql();

  /* 学号唯一性检查：同一个学号不能挂两条资料 */
  if (sid) {
    const dup = await sql`select id from profiles where student_id = ${sid} limit 1`;
    if (dup.length && Number(dup[0].id) !== id) {
      return fail(res, 409, '学号 ' + sid + ' 已被另一条资料占用');
    }
  }

  if (id) {
    /* 修改：只更新传了的字段，避免把没传的字段清空 */
    const cur = await sql`select * from profiles where id = ${id} limit 1`;
    if (!cur.length) return fail(res, 404, '资料不存在');
    const c = cur[0];

    await sql`
      update profiles
         set name      = ${name || c.name},
             student_id = ${sid || c.student_id},
             politics  = ${politics || c.politics},
             exam_no   = ${examNo || c.exam_no},
             role      = ${role || c.role},
             wechat    = ${wechat !== '' ? wechat : c.wechat},
             qq        = ${qq !== '' ? qq : c.qq},
             phone     = ${phone !== '' ? phone : c.phone},
             contact_status = ${st || c.contact_status},
             updated_at = now()
       where id = ${id}
    `;
    await audit(sql, me, 'profile.update', 'profile', String(id), name || sid);
    return ok(res, { message: '已保存', id });
  }

  /* 新增 */
  const ins = await sql`
    insert into profiles (name, student_id, politics, exam_no, role, wechat, qq, phone, contact_status)
    values (${name || null}, ${sid || null}, ${politics || null}, ${examNo || null}, ${role},
            ${wechat || null}, ${qq || null}, ${phone || null},
            ${st || (wechat || qq || phone ? 'approved' : 'none')})
    returning id
  `;
  const newId = Number(ins[0].id);
  await audit(sql, me, 'profile.create', 'profile', String(newId), name || sid);
  return ok(res, { message: '已新增', id: newId });
}

/** 删除一条资料 */
async function deleteProfile(req, res, me, b) {
  const id = Number(b.id || 0);
  if (!id) return fail(res, 400, '缺少 id');
  const sql = getSql();
  const rows = await sql`select name, student_id from profiles where id = ${id} limit 1`;
  if (!rows.length) return fail(res, 404, '资料不存在');
  await sql`delete from profiles where id = ${id}`;
  await audit(sql, me, 'profile.delete', 'profile', String(id), rows[0].name || rows[0].student_id || '');
  return ok(res, { message: '已删除' });
}

/**
 * 批量导入资料。
 * body: { rows: [{ name, studentId, politics, examNo?, role, wechat?, qq?, phone? }, ...] }
 * 按学号或姓名判断是新增还是更新（有就更新，没有就插入）。
 * 单批上限与用户批量导入保持一致（60 条），由前端分片调用。
 * 逐条返回错误与行号，方便对照 Excel 修数据。
 */
async function batchProfiles(req, res, me, b) {
  const list = Array.isArray(b.rows) ? b.rows : [];
  if (!list.length) return ok(res, { created: 0, updated: 0, failed: 0, errors: [] });
  if (list.length > 60) return fail(res, 400, '单批最多 60 条，请分批提交');

  const sql = getSql();
  let created = 0, updated = 0;
  const errors = [];

  for (let i = 0; i < list.length; i++) {
    const raw = list[i] || {};
    try {
      const name = cText(raw.name, 30);
      const sid = cText(raw.studentId, 20);
      const politics = cText(raw.politics, 30);
      const examNo = cText(raw.examNo, 24);
      const role = cText(raw.role, 10) || '学生';
      const wechat = cContact(raw.wechat);
      const qq = cContact(raw.qq);
      const phone = cContact(raw.phone);

      if (!name && !sid) {
        errors.push({ index: i, name, studentId: sid, reason: '姓名与学号都为空' });
        continue;
      }

      /* 先按学号找，再按姓名找 */
      let hit = [];
      if (sid) hit = await sql`select id from profiles where student_id = ${sid} limit 1`;
      if (!hit.length && name) hit = await sql`select id from profiles where name = ${name} limit 1`;

      if (hit.length) {
        const pid = Number(hit[0].id);
        await sql`
          update profiles
             set name = ${name || null},
                 student_id = ${sid || null},
                 politics = ${politics || null},
                 exam_no = ${examNo || null},
                 role = ${role},
                 wechat = ${wechat || null},
                 qq = ${qq || null},
                 phone = ${phone || null},
                 contact_status = ${(wechat || qq || phone) ? 'approved' : 'none'},
                 updated_at = now()
           where id = ${pid}
        `;
        updated++;
      } else {
        await sql`
          insert into profiles (name, student_id, politics, exam_no, role, wechat, qq, phone, contact_status)
          values (${name || null}, ${sid || null}, ${politics || null}, ${examNo || null}, ${role},
                  ${wechat || null}, ${qq || null}, ${phone || null},
                  ${(wechat || qq || phone) ? 'approved' : 'none'})
        `;
        created++;
      }
    } catch (e) {
      errors.push({
        index: i,
        name: cText(raw.name, 30),
        studentId: cText(raw.studentId, 20),
        reason: String(e.message || e).slice(0, 120),
      });
    }
  }

  if (created || updated) {
    await audit(sql, me, 'profile.batch', 'profile', '', '新增 ' + created + ' / 更新 ' + updated);
  }

  return ok(res, { created, updated, failed: errors.length, errors });
}

/**
 * 资料查看日志：谁在什么时候查看了谁。
 * 支持 ?viewer=id 只看某人的查看行为，?target=id 只看某条资料被谁看过。
 */
async function viewLogs(req, res) {
  const sql = getSql();
  const viewer = Number(req.query.viewer || 0);
  const target = Number(req.query.target || 0);
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const offset = Math.max(Number(req.query.offset || 0), 0);

  let rows = [];
  try {
    rows = await sql`
      select v.id, v.created_at, v.keyword, v.ip, v.target_name,
             v.viewer_id, v.target_id,
             u.username as viewer_name, u.display_name as viewer_display,
             t.student_id as target_sid, t.name as target_real_name
        from profile_view_log v
        left join users u    on u.id = v.viewer_id
        left join profiles t on t.id = v.target_id
       where (${viewer} = 0 or v.viewer_id = ${viewer})
         and (${target} = 0 or v.target_id = ${target})
       order by v.created_at desc
       limit ${limit} offset ${offset}
    `;
  } catch (e) {
    /* 表还没建出来时返回空，避免后台整页报错 */
    console.warn('[admin] 读取查看日志失败：', e.message);
    return ok(res, { total: 0, logs: [] });
  }

  /* 近 7 天查看次数排行，供后台展示「谁最常查资料」 */
  let top = [];
  try {
    top = await sql`
      select u.username, count(*)::int as n
        from profile_view_log v
        left join users u on u.id = v.viewer_id
       where v.created_at > now() - interval '7 days'
       group by u.username
       order by n desc
       limit 10
    `;
  } catch (e) { /* 忽略 */ }

  return ok(res, {
    total: rows.length,
    logs: rows.map((r) => ({
      id: Number(r.id),
      viewerId: r.viewer_id ? Number(r.viewer_id) : null,
      viewer: r.viewer_display || r.viewer_name || '(已删除账号)',
      targetId: r.target_id ? Number(r.target_id) : null,
      targetName: r.target_real_name || r.target_name || '(已删除)',
      targetStudentId: r.target_sid || '',
      keyword: r.keyword || '',
      ip: r.ip || '',
      createdAt: r.created_at,
    })),
    top: top.map((t) => ({ username: t.username || '(已删除)', count: t.n })),
  });
}

/* ============================================================
   系统令牌管理（管理员专用）
   ------------------------------------------------------------
   存放 Cloudflare / Gitee / VoiceHub 等第三方令牌。
   仅 role=admin 可读写，非管理员连列表都看不到。
   ============================================================ */

async function listAdminSecrets(req, res) {
  try {
    const data = await listSecrets(req);
    return ok(res, data);
  } catch (e) {
    console.error('[admin] list secrets', e);
    return fail(res, 500, '读取令牌失败：' + e.message);
  }
}

async function saveAdminSecret(req, res, me, b) {
  const name = String(b.name || '').trim();
  const value = String(b.value || '');
  if (!value) return fail(res, 400, '令牌值不能为空');

  try {
    const result = await saveSecret(req, name, value);
    await audit(me.id, 'secret.save', 'secret', name, '保存/更新令牌 ' + name);
    return ok(res, { ...result, message: '已保存 ' + name });
  } catch (e) {
    console.error('[admin] save secret', e);
    return fail(res, 400, e.message);
  }
}

async function deleteAdminSecret(req, res, me, b) {
  const name = String(b.name || '').trim();
  if (!name) return fail(res, 400, '缺少 name');

  try {
    const result = await deleteSecret(req, name);
    await audit(me.id, 'secret.delete', 'secret', name, '删除令牌 ' + name);
    return ok(res, { ...result, message: '已删除 ' + name });
  } catch (e) {
    console.error('[admin] delete secret', e);
    return fail(res, 400, e.message);
  }
}

/* ---------------- 批量绑定「账号 ↔ 班级资料」（2026-10-06） ----------------
   POST admin?action=bind-profiles   body: { names: ['余子康', ...], dryRun?: true }

   背景：管理员按名单批量建账号（username=姓名）+ 批量导资料（name=姓名），
   两边同名但没关联。资料要靠同学自己在前端「认领」（学号+姓名双验）才能挂上，
   全班 60 人都去认领一遍体验不好。

   本接口按姓名把两边对上：profiles.user_id = users.id，
   之后同学登录 → /api/profile?action=me 直接返回自己的资料，
   「我的资料」里就能直接填 / 改微信、QQ、手机号。

   ⚠️ 只绑「资料还没被人认领」的条目；已认领且是本人 → 跳过；
      已认领且是别人 → 报冲突不覆盖（防互相顶掉）。
   dryRun=true 时只报告会做什么，不写库（先跑一遍心里有数）。 */
async function bindProfiles(req, res, me, b) {
  if (req.method !== 'POST') return fail(res, 405, '请用 POST');

  const names = Array.isArray(b.names) ? b.names : [];
  if (!names.length) return fail(res, 400, 'names 必须是非空数组');
  /* 与批量导入同一道子请求上限：Workers 单调用 50 个子请求，每条约 3 条 SQL */
  if (names.length > 15) {
    return fail(res, 400, '单次最多 15 条（Cloudflare Workers 子请求上限），请分片提交');
  }

  const dry = !!b.dryRun;
  const sql = getSql();
  const out = { bound: 0, skipped: 0, noAccount: [], noProfile: [], conflict: [], boundNames: [] };

  for (const raw of names) {
    const name = String(raw || '').trim().slice(0, 30);
    if (!name) continue;

    const acc = await sql`
      select id, username from users where username = ${name} limit 1
    `;
    if (!acc.length) { out.noAccount.push(name); continue; }
    const uid = Number(acc[0].id);

    const prof = await sql`
      select id, user_id, name from profiles where name = ${name} limit 1
    `;
    if (!prof.length) { out.noProfile.push(name); continue; }
    const pid = Number(prof[0].id);
    const owner = prof[0].user_id == null ? null : Number(prof[0].user_id);

    if (owner === uid) { out.skipped++; continue; }
    if (owner !== null && owner !== uid) { out.conflict.push(name); continue; }

    if (!dry) {
      await sql`update profiles set user_id = ${uid}, updated_at = now() where id = ${pid}`;
    }
    out.bound++;
    out.boundNames.push(name);
  }

  if (!dry && out.bound) {
    await audit(me.id, 'profile.bind', 'profile', null,
      '批量绑定账号与资料：' + out.bound + ' 人（' + out.boundNames.slice(0, 3).join('、') +
      (out.boundNames.length > 3 ? ' 等' : '') + '）');
  }

  return ok(res, Object.assign({ message: dry ? '预检完成（未写入）' : ('已绑定 ' + out.bound + ' 人') }, out));
}
