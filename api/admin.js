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
   ============================================================ */

import { getSql } from './_lib/db.js';
import {
  cors, handlePreflight, ok, fail, body, requireAdmin, audit,
} from './_lib/http.js';
import { hashPassword } from './_lib/password.js';

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  cors(req, res);

  const me = await requireAdmin(req, res);
  if (!me) return;

  const action = String(req.query.action || 'users').toLowerCase();

  try {
    /* 读操作 */
    if (req.method === 'GET') {
      if (action === 'users')   return await listUsers(req, res);
      if (action === 'user')    return await userDetail(req, res);
      if (action === 'stats')   return await stats(req, res);
      if (action === 'audit')   return await listAudit(req, res);
      return fail(res, 404, '未知的 action：' + action);
    }

    /* 写操作 */
    if (req.method === 'POST') {
      const b = await body(req);
      switch (action) {
        case 'reset-password': return await resetPassword(req, res, me, b);
        case 'set-status':     return await setStatus(req, res, me, b);
        case 'set-role':       return await setRole(req, res, me, b);
        case 'set-data':       return await setData(req, res, me, b);
        case 'delete-data':    return await deleteData(req, res, me, b);
        case 'delete-user':    return await deleteUser(req, res, me, b);
        case 'clear-sessions': return await clearSessions(req, res, me, b);
        default:               return fail(res, 404, '未知的 action：' + action);
      }
    }

    return fail(res, 405, '不支持的方法');
  } catch (e) {
    console.error('[admin]', action, e);
    return fail(res, 500, '服务器内部错误，请稍后重试');
  }
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
           count(*) filter (where last_login_at > now() - interval '7 days')::int as active7
      from users
  `;
  const [d] = await sql`select count(*)::int as rows, coalesce(sum(pg_column_size(data_value)),0)::bigint as bytes from user_data`;
  const [s] = await sql`select count(*)::int as n from sessions where expires_at > now()`;

  /* 哪些键用得最多（了解同学最在意什么功能） */
  const topKeys = await sql`
    select data_key, count(*)::int as n from user_data
     group by data_key order by n desc limit 10
  `;

  return ok(res, {
    users: u,
    data: { rows: d.rows, bytes: Number(d.bytes) },
    activeSessions: s.n,
    topKeys: topKeys.map((k) => ({ key: k.data_key, count: k.n })),
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
  const rows = await sql`
    update users set password_hash = ${hash} where id = ${id}
    returning username
  `;
  if (!rows.length) return fail(res, 404, '用户不存在');

  /* 重置密码后踢掉该用户所有登录 */
  await sql`delete from sessions where user_id = ${id}`;
  await audit(me.id, 'user.reset_password', 'user', String(id), rows[0].username);

  return ok(res, { message: '已重置 ' + rows[0].username + ' 的密码，该用户需重新登录' });
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
