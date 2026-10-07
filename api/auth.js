/* ============================================================
   POST /api/auth?action=register|login|logout|me|change-password
   ------------------------------------------------------------
   用 query 参数分子动作，好处是函数数量少（Vercel 免费版有
   函数数量限制），部署轻。
   ============================================================ */

import { getSql, cfg } from './_lib/db.js';
import {
  cors, handlePreflight, ok, fail, body,
  requireUser, requireUserSlim, newToken, audit, ensureSchema,
} from './_lib/http.js';
import {
  hashPassword, verifyPassword, needsRehash, DECOY_HASH, sha256Hex, needsDowngrade,
} from './_lib/password.js';

/* 用户名规则：3–20 位，字母/数字/下划线/中文 */
function normUsername(s) {
  return String(s || '').trim().toLowerCase();
}
function validUsername(u) {
  /* 2026-10-06 放宽到 2 位：按姓名导入账号，两字姓名（余倩、张炜…）也要能注册 */
  return /^[a-z0-9_\u4e00-\u9fa5]{2,20}$/.test(u);
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
      case 'ping':     return await ping(req, res);
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
    return fail(res, 400, '用户名需 2–20 位，仅限中英文、数字、下划线');
  }
  if (password.length < 6 || password.length > 64) {
    return fail(res, 400, '密码长度需 6–64 位');
  }

  const sql = getSql();

  /* 查重（用 lower 索引，避免 Tom/tom 重复注册） */
  const dup = await sql`select id from users where lower(username) = ${username} limit 1`;
  if (dup.length) return fail(res, 409, '这个用户名已经被注册了，换一个吧');

  const hash = await hashPassword(password);

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

  /* 先补全可能缺失的列/表，避免引用新列时直接 500（详见 ensureSchema 注释） */
  await ensureSchema(sql);

  /* 登录限流：同一用户名连续失败 5 次 → 锁 15 分钟（防暴力破解） */
  const lockedMin = await lockRemain(sql, username);
  if (lockedMin > 0) {
    return fail(res, 429, '密码连续输错次数过多，请 ' + lockedMin + ' 分钟后再试');
  }

  const rows = await sql`
    select id, username, display_name, role, status, password_hash, created_at,
           coalesce(must_change_password, false) as must_change_password
      from users where lower(username) = ${username} limit 1
  `;

  /* 用户不存在时也走一次密码比对，避免通过响应时间探测用户名是否存在。
     ⚠️ 这个陪跑串必须是**合法且能被真正计算的**哈希，否则会提前返回、
        防护等于没做。（历史上踩过两次坑：
          2026-09-30 —— 假 bcrypt 串是 66 位非法长度，bcryptjs 直接返回 false；
          2026-10-05 —— 换 PBKDF2 后，假串同步改为合法的 pbkdf2 格式。） */
  const u = rows[0];
  const hash = u ? u.password_hash : DECOY_HASH;
  const good = await verifyPassword(password, hash);

  if (!u || !good) {
    await bumpFail(sql, u ? u.id : null, username);
    return fail(res, 401, '用户名或密码不对');
  }
  if (u.status !== 'active') return fail(res, 403, '该账号已被禁用，请联系管理员');

  await clearFail(sql, u.id);

  /* 旧算法的哈希在登录成功后顺手升级（bcrypt → pbkdf2，或提高迭代次数）。
     换算法不影响老用户：能登录就说明密码对，这里只是把它重新存成新格式。 */
  if (needsRehash(u.password_hash)) {
    try {
      const upgraded = await hashPassword(password);
      await sql`update users set password_hash = ${upgraded} where id = ${u.id}`;
    } catch (e) {
      console.warn('[auth] 密码哈希升级失败（不影响登录）：', e.message);
    }
  }

  await sql`update users set last_login_at = now(), last_seen_at = now() where id = ${u.id}`;
  await logLogin(sql, req, u.id);
  const token = await issueSession(sql, u.id);

  /* 头衔一并返回：前端据此显示「课代表编辑」入口（2026-10-06）。
     登录不频繁，多一次查询可接受；老库无 profiles 表时静默跳过。 */
  let loginTitle = '';
  try {
    const pr = await sql`select title from profiles where user_id = ${u.id} limit 1`;
    if (pr.length) loginTitle = pr[0].title || '';
  } catch (e) { /* ignore */ }

  return ok(res, {
    message: '登录成功',
    token,
    user: Object.assign(shape(u), { title: loginTitle }),
    /* 首次登录（或管理员重置过密码）→ 前端强制弹改密，不给跳过 */
    mustChangePassword: !!u.must_change_password,
  });
}

/**
 * 记录一次登录（写入 login_log）。
 * 失败不影响登录本身 —— 老库若没执行过建表脚本，这里静默跳过。
 */
async function logLogin(sql, req, userId) {
  try {
    const h = req.headers || {};
    /* Cloudflare 走 CF-Connecting-IP；Node/Vercel 走 x-forwarded-for（取第一段） */
    const ip = String(
      h['cf-connecting-ip']
      || (h['x-forwarded-for'] ? String(h['x-forwarded-for']).split(',')[0] : '')
      || h['x-real-ip']
      || ''
    ).trim().slice(0, 64);
    const ua = String(h['user-agent'] || '').slice(0, 500);
    await sql`
      insert into login_log (user_id, ip, user_agent)
      values (${userId}, ${ip || null}, ${ua || null})
    `;
  } catch (e) {
    console.warn('[auth] 登录记录写入失败（可能缺少 login_log 表）：', e.message);
  }
}

/* ---------------- 登录限流（基于 users 表，跨实例生效） ----------------
   需要 schema.sql 里的 failed_count / locked_until 两列；
   若老库没执行过 ALTER，这里会静默降级（不阻断登录），并在日志里提示。 */
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

async function lockRemain(sql, username) {
  try {
    const rows = await sql`
      select locked_until from users where lower(username) = ${username} limit 1
    `;
    if (!rows.length || !rows[0].locked_until) return 0;
    const until = toTime(rows[0].locked_until);
    if (!until) return 0;
    const ms = until - Date.now();
    return ms > 0 ? Math.ceil(ms / 60000) : 0;
  } catch (e) {
    return 0; /* 列不存在 → 不限流 */
  }
}

/**
 * 把数据库返回的时间值转成毫秒时间戳。
 *
 * ⚠️ 这里踩过一个坑（2026-10-05）：
 * Neon 的 HTTP 驱动返回 timestamptz 是**字符串**（形如 "2026-10-05 05:52:28"），
 * 不是 JS Date 对象。而带空格的这种格式在 Safari / 部分 WebView 里
 * `new Date("2026-10-05 05:52:28")` 会得到 Invalid Date，
 * getTime() 返回 NaN —— NaN > 0 恒为 false，限流会**静默失效**。
 * 所以这里手动解析，并把空格换成 T、补上时区标识，确保各端一致。
 *
 * @returns {number} 毫秒时间戳；无法解析时返回 0
 */
function toTime(v) {
  if (!v) return 0;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? t : 0;
  }
  /* 数字（epoch 毫秒或秒） */
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const s = String(v).trim();
  /* 纯数字字符串 */
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 1e12 ? n : n * 1000;
  }
  /* "YYYY-MM-DD HH:MM:SS"（Postgres 默认格式）→ ISO 8601 并补 UTC 标识。
     Neon 返回的时间已是 UTC，但不带时区后缀，直接 new Date 会被当成本地时间，
     导致误差一个时区（国内差 8 小时）。这里统一按 UTC 处理。 */
  const iso = s.replace(' ', 'T');
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z';
  const t = Date.parse(withZone);
  return Number.isFinite(t) ? t : 0;
}

async function bumpFail(sql, userId, username) {
  try {
    await sql`
      update users
         set failed_count = failed_count + 1,
             locked_until = case when failed_count + 1 >= ${MAX_FAILS}
                                 then now() + (${LOCK_MINUTES} || ' minutes')::interval
                                 else locked_until end
       where lower(username) = ${username}
    `;
  } catch (e) {
    console.warn('[auth] 限流未生效（可能缺少 failed_count/locked_until 列）：', e.message);
  }
}

async function clearFail(sql, userId) {
  try {
    await sql`update users set failed_count = 0, locked_until = null where id = ${userId}`;
  } catch (e) { /* 忽略 */ }
}

/* ---------------- 登出 ---------------- */
async function logout(req, res) {
  if (req.method !== 'POST') return fail(res, 405, '请用 POST');
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (m) {
    const raw = m[1].trim();
    /* 会话表存的是 sha256(token)；同时为兼容升级前的明文老会话，
       这里两种都删（老会话自然过期后只剩哈希行）。 */
    const th = await sha256Hex(raw);
    const sql = getSql();
    await sql`delete from sessions where token = ${th} or token = ${raw}`;
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
      /* 头衔与班级身份（来自 profiles，currentUser 已查好）：
         前端「课代表编辑作业」按钮的判定依据 */
      title: u.title || '', profileRole: u.profileRole || '',
    },
    isAdmin: u.role === 'admin',
    cloudKeys: keys.map((k) => ({ key: k.data_key, updatedAt: k.updated_at })),
  });
}

/* ---------------- 在线心跳（2026-10-07） ----------------
   GET /api/auth?action=ping

   用途：后台「用户管理」要看的是同学**最后一次在线**的时间，
   而不是最后一次输密码登录的时间（登录一次 token 能用很多天，
   只看 last_login_at 会以为人家好几天没来，其实天天在站上）。

   前端在页面可见时每 60 秒打一次；切到后台标签页就不打了。
   写库很轻（一条 update），但为了不白白刷库，做了 30 秒节流：
   30 秒内的重复心跳直接回 ok 不写库。 */
const PING_THROTTLE_MS = 30 * 1000;
async function ping(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;
  const sql = getSql();
  try {
    await sql`
      update users set last_seen_at = now()
       where id = ${u.id}
         and (last_seen_at is null or last_seen_at < now() - interval '30 seconds')
    `;
  } catch (e) {
    /* last_seen_at 列还没建出来（老库首次部署）时不能让心跳把前端搞崩 */
    console.warn('[auth] ping 更新失败：', e.message);
  }
  return ok(res, { pong: Date.now() });
}

/* ---------------- 修改自己的密码 ---------------- */
async function changePassword(req, res) {
  if (req.method !== 'POST') return fail(res, 405, '请用 POST');
  /* ⚠️ 这里用「轻量鉴权」而不是完整 requireUser：
     改密码要跑两次 PBKDF2（校验 + 生成新哈希），CPU 预算很紧；
     完整的 requireUser 还会先跑 ensureSchema（多条 DDL）并查 profiles，
     叠加两次派生会越过 Workers 10ms CPU 上限，表现为「原密码正确却 500」。
     轻量版只查会话与用户，把预算全部留给密码计算。（2026-10-07 第二十七轮） */
  const u = await requireUserSlim(req, res);
  if (!u) return;

  const b = await body(req);
  const oldPwd = String(b.oldPassword || '');
  const newPwd = String(b.newPassword || '');
  if (newPwd.length < 6 || newPwd.length > 64) {
    return fail(res, 400, '新密码长度需 6–64 位');
  }

  const sql = getSql();
  const rows = await sql`select password_hash from users where id = ${u.id}`;
  if (!rows.length) return fail(res, 400, '账号数据异常，请联系管理员');
  const oldHash = rows[0].password_hash;
  /* 🛡️ 老账号护栏（2026-10-07 第二十七轮）：
     若该账号的哈希还停留在旧的高迭代档位（> 当前 ITERATIONS，例如 50000），
     那么「校验原密码」这一次 PBKDF2 就要约 10ms，Android Workers 免费版
     CPU 上限只有 10ms，再叠加「生成新哈希」必然 Error 1102 → 前端看到的
     就是「服务器错误」，而用户完全猜不到原因。
     这里提前拦下并给出可操作提示：让管理员到后台「重置密码」——
     重置是**单次派生**（只用新档位生成新哈希，不需要校验老哈希），
     既不会超限，又能把该账号顺势迁到新档位，之后自助改密就正常了。 */
  if (needsDowngrade(oldHash)) {
    return fail(res, 409,
      '你的账号还使用旧版密码加密格式，直接修改会超出服务器计算限制。'
      + '请让管理员在后台「用户管理」里给你点一次「重置密码」（重置后你就能自己改密码了）。',
      { needsAdminReset: true });
  }
  const good = await verifyPassword(oldPwd, oldHash);
  if (!good) return fail(res, 401, '原密码不对');

  /* 生成新哈希（新档位 10000）。此时本次请求的累计逻辑是：
       轻量鉴权（1 次会话查询 + 1 次 sha256）
       + verifyPassword（1 次 PBKDF2，档位=老哈希档位）
       + hashPassword（1 次 PBKDF2，档位=10000）
     对新账号（老哈希也是 10000）：约 3.8ms 派生，余量充足。
     对老账号（老哈希 50000）：verify 单次就约 10ms，本就贴着上限 —— 见下方护栏。 */
  const hash = await hashPassword(newPwd);
  /* 核心更新：只写一定存在的列（password_hash）。
     ⚠️ 2026-10-07：以前这条 UPDATE 一并写 must_change_password / failed_count /
        locked_until，但线上库若没跑过 schema.sql，后两列不存在 → 整条 500。
       现在把「可能不存在的列」拆成单独的、带保护的一步（见下），
       保证即使列还没补上，改密码本身也能成功。 */
  await sql`update users set password_hash = ${hash} where id = ${u.id}`;
  /* 次要字段（可能因库结构未升级而缺失）：单独一次、失败不影响改密结果 */
  try {
    await sql`
      update users
         set must_change_password = false,
             failed_count = 0,
             locked_until = null
       where id = ${u.id}
    `;
  } catch (e) {
    console.warn('[auth] 改密后清零附带字段失败（不影响改密）：', e.message);
  }
  /* 改密码后踢掉其他设备的登录，只保留当前这台 */
  await sql`delete from sessions where user_id = ${u.id}`;
  const token = await issueSession(sql, u.id);

  await audit(u.id, 'user.change_password', 'user', String(u.id), null);
  return ok(res, { message: '密码已修改，其他设备已退出登录', token, mustChangePassword: false });
}

/* ---------------- 内部工具 ---------------- */
async function issueSession(sql, userId) {
  const { sessionDays } = cfg();
  const token = newToken();
  /* 🔒 第二十七轮（2026-10-07）：会话表不再存明文 token，改存 sha256(token)。
     明文 token 只回给客户端、永不落库；查询时先哈希再比对主键。
     这样既防拖库伪造，又能平滑迁移：升级前的老会话仍是明文 token，
     靠 currentUser / logout 里的「哈希 OR 明文」双匹配继续可用，
     无需强制全员重新登录。 */
  const tokenHash = await sha256Hex(token);
  await sql`
    insert into sessions (token, user_id, expires_at)
    values (${tokenHash}, ${userId}, now() + (${sessionDays} || ' days')::interval)
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
