/* ============================================================
   POST /api/auth?action=register|login|logout|me|change-password
   ------------------------------------------------------------
   用 query 参数分子动作，好处是函数数量少（Vercel 免费版有
   函数数量限制），部署轻。
   ============================================================ */

import bcrypt from 'bcryptjs';
import { getSql, cfg } from './_lib/db.js';
import {
  cors, handlePreflight, ok, fail, body,
  requireUser, newToken, audit,
} from './_lib/http.js';

const SALT_ROUNDS = 10;

/* 用户名规则：3–20 位，字母/数字/下划线/中文 */
function normUsername(s) {
  return String(s || '').trim().toLowerCase();
}
function validUsername(u) {
  return /^[a-z0-9_\u4e00-\u9fa5]{3,20}$/.test(u);
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  cors(req, res);

  const action = String(req.query.action || '').toLowerCase();

  try {
    switch (action) {
      case 'register': return await register(req, res);
      case 'login':    return await login(req, res);
      case 'logout':   return await logout(req, res);
      case 'me':       return await me(req, res);
      case 'change-password': return await changePassword(req, res);
      default:
        return fail(res, 404, '未知的 action：' + (action || '(空)'));
    }
  } catch (e) {
    console.error('[auth]', action, e);
    return fail(res, 500, '服务器内部错误，请稍后重试');
  }
}

/* ---------------- 注册 ---------------- */
async function register(req, res) {
  if (req.method !== 'POST') return fail(res, 405, '请用 POST');

  const { allowRegister } = cfg();
  if (!allowRegister) return fail(res, 403, '本站暂未开放自助注册，请联系管理员开号');

  const b = await body(req);
  const username = normUsername(b.username);
  const password = String(b.password || '');
  const displayName = String(b.displayName || b.display_name || '').trim().slice(0, 30) || null;

  if (!validUsername(username)) {
    return fail(res, 400, '用户名需 3–20 位，仅限中英文、数字、下划线');
  }
  if (password.length < 6 || password.length > 64) {
    return fail(res, 400, '密码长度需 6–64 位');
  }

  const sql = getSql();

  /* 查重（用 lower 索引，避免 Tom/tom 重复注册） */
  const dup = await sql`select id from users where lower(username) = ${username} limit 1`;
  if (dup.length) return fail(res, 409, '这个用户名已经被注册了，换一个吧');

  const hash = await bcrypt.hash(password, SALT_ROUNDS);

  /* 首个注册者 / 配置里指定的用户名，自动成为管理员 */
  const { adminUsers } = cfg();
  const isFirst = (await sql`select count(*)::int as n from users`)[0].n === 0;
  const role = (isFirst || adminUsers.includes(username)) ? 'admin' : 'user';

  const rows = await sql`
    insert into users (username, display_name, password_hash, role)
    values (${username}, ${displayName}, ${hash}, ${role})
    returning id, username, display_name, role, status, created_at
  `;
  const u = rows[0];

  const token = await issueSession(sql, u.id);

  return ok(res, {
    message: role === 'admin' ? '注册成功，你已成为管理员' : '注册成功',
    token,
    user: shape(u),
  });
}

/* ---------------- 登录 ---------------- */
async function login(req, res) {
  if (req.method !== 'POST') return fail(res, 405, '请用 POST');

  const b = await body(req);
  const username = normUsername(b.username);
  const password = String(b.password || '');

  if (!username || !password) return fail(res, 400, '请填写用户名和密码');

  const sql = getSql();
  const rows = await sql`
    select id, username, display_name, role, status, password_hash, created_at
      from users where lower(username) = ${username} limit 1
  `;

  /* 用户不存在时也走一次 bcrypt 比对，避免通过响应时间探测用户名是否存在 */
  const u = rows[0];
  const hash = u ? u.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const good = await bcrypt.compare(password, hash);

  if (!u || !good) return fail(res, 401, '用户名或密码不对');
  if (u.status !== 'active') return fail(res, 403, '该账号已被禁用，请联系管理员');

  await sql`update users set last_login_at = now() where id = ${u.id}`;
  const token = await issueSession(sql, u.id);

  return ok(res, { message: '登录成功', token, user: shape(u) });
}

/* ---------------- 登出 ---------------- */
async function logout(req, res) {
  if (req.method !== 'POST') return fail(res, 405, '请用 POST');
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (m) {
    const sql = getSql();
    await sql`delete from sessions where token = ${m[1].trim()}`;
  }
  return ok(res, { message: '已退出登录' });
}

/* ---------------- 当前用户 ---------------- */
async function me(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;
  const sql = getSql();
  /* 顺带返回已同步的键名列表，前端可据此判断云端有什么 */
  const keys = await sql`select data_key, updated_at from user_data where user_id = ${u.id}`;
  return ok(res, {
    user: {
      id: u.id, username: u.username, displayName: u.displayName,
      role: u.role, createdAt: u.createdAt,
    },
    isAdmin: u.role === 'admin',
    cloudKeys: keys.map((k) => ({ key: k.data_key, updatedAt: k.updated_at })),
  });
}

/* ---------------- 修改自己的密码 ---------------- */
async function changePassword(req, res) {
  if (req.method !== 'POST') return fail(res, 405, '请用 POST');
  const u = await requireUser(req, res);
  if (!u) return;

  const b = await body(req);
  const oldPwd = String(b.oldPassword || '');
  const newPwd = String(b.newPassword || '');
  if (newPwd.length < 6 || newPwd.length > 64) {
    return fail(res, 400, '新密码长度需 6–64 位');
  }

  const sql = getSql();
  const rows = await sql`select password_hash from users where id = ${u.id}`;
  const good = await bcrypt.compare(oldPwd, rows[0].password_hash);
  if (!good) return fail(res, 401, '原密码不对');

  const hash = await bcrypt.hash(newPwd, SALT_ROUNDS);
  await sql`update users set password_hash = ${hash} where id = ${u.id}`;
  /* 改密码后踢掉其他设备的登录，只保留当前这台 */
  await sql`delete from sessions where user_id = ${u.id}`;
  const token = await issueSession(sql, u.id);

  await audit(u.id, 'user.change_password', 'user', String(u.id), null);
  return ok(res, { message: '密码已修改，其他设备已退出登录', token });
}

/* ---------------- 内部工具 ---------------- */
async function issueSession(sql, userId) {
  const { sessionDays } = cfg();
  const token = newToken();
  await sql`
    insert into sessions (token, user_id, expires_at)
    values (${token}, ${userId}, now() + (${sessionDays} || ' days')::interval)
  `;
  return token;
}

function shape(u) {
  return {
    id: Number(u.id),
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    status: u.status,
  };
}
