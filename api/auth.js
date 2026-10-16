/* ============================================================
   POST /api/auth?action=register|login|logout|me|change-password|salt
   ------------------------------------------------------------
   用 query 参数分子动作，好处是函数数量少（Vercel 免费版有
   函数数量限制），部署轻。

   v2.9.9（2026-10-15 第五十六轮）新增 salt 动作 + 登录/改密的
   「凭证路径」：PBKDF2 派生搬到浏览器做，服务端零派生。
   详见 _lib/password.js 顶部说明。
   ============================================================ */

import { getSql, cfg, getSiteSetting, setSiteSetting } from './_lib/db.js';
import {
  cors, handlePreflight, ok, fail, body,
  requireUser, requireUserSlim, newToken, audit, ensureSchema,
} from './_lib/http.js';
import {
  hashPassword, verifyPassword, verifyCredential, validateClientHash,
  needsRehash, DECOY_HASH, sha256Hex, parseHashParams,
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
      case 'salt':      return await saltParams(req, res);
      /* v2.10.0：公开的注册配置（登录页据此显示/隐藏注册入口、提示审核）。
         不需要登录 —— 没登录的人才是需要看这个的人。 */
      case 'register-config': return await registerConfig(req, res);
      default:
        return fail(res, 404, '未知的 action：' + (action || '(空)'));
    }
  } catch (e) {
    console.error('[auth]', action, e);
    return fail(res, 500, '服务器内部错误，请稍后重试');
  }
}

/* ---------------- 注册 ----------------
   v2.10.0（2026-10-16 第六十轮）注册权限后台管控：
     · 总开关：site_settings.register_open（未设置时回退 env ALLOW_REGISTER）
     · 审核流：site_settings.register_review（默认 true）——
       开启时注册用户 status='pending'，不签发 token，
       管理员在后台审核通过（→active）后才能登录。 */
async function register(req, res) {
  if (req.method !== 'POST') return fail(res, 405, '请用 POST');

  const sql = getSql();
  await ensureSchema(sql);

  /* 总开关：DB 优先，未配置过回退部署期环境变量（保持老行为） */
  const registerOpen = await getSiteSetting(sql, 'register_open', cfg().allowRegister);
  if (!registerOpen) return fail(res, 403, '本站暂未开放自助注册，请联系管理员开号');

  const review = await getSiteSetting(sql, 'register_review', true);

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

  /* 查重（用 lower 索引，避免 Tom/tom 重复注册） */
  const dup = await sql`select id from users where lower(username) = ${username} limit 1`;
  if (dup.length) return fail(res, 409, '这个用户名已经被注册了，换一个吧');

  const hash = await hashPassword(password);

  /* 首个注册者 / 配置里指定的用户名，自动成为管理员。
     ⚠️ 管理员不走审核：第一个账号往往是站主自己，卡审核会把站主关在门外。 */
  const { adminUsers } = cfg();
  const isFirst = (await sql`select count(*)::int as n from users`)[0].n === 0;
  const role = (isFirst || adminUsers.includes(username)) ? 'admin' : 'user';
  const status = review && role !== 'admin' ? 'pending' : 'active';

  const rows = await sql`
    insert into users (username, display_name, password_hash, role, status)
    values (${username}, ${displayName}, ${hash}, ${role}, ${status})
    returning id, username, display_name, role, status, created_at
  `;
  const u = rows[0];

  /* 待审核：不签发 token，也拿不到登录态 —— 审核通过前无法登录 */
  if (u.status === 'pending') {
    return ok(res, {
      message: '注册成功，等待管理员审核。审核通过后即可登录，请耐心等待。',
      pending: true,
    });
  }

  const token = await issueSession(sql, u.id);

  return ok(res, {
    message: role === 'admin' ? '注册成功，你已成为管理员' : '注册成功',
    token,
    user: shape(u),
  });
}

/** 公开：注册配置（总开关 + 是否需审核）。无需登录。 */
async function registerConfig(req, res) {
  const sql = getSql();
  const registerOpen = await getSiteSetting(sql, 'register_open', cfg().allowRegister);
  const review = await getSiteSetting(sql, 'register_review', true);
  return ok(res, { open: !!registerOpen, review: !!review });
}

/* ---------------- 登录 ---------------- */
async function login(req, res) {
  if (req.method !== 'POST') return fail(res, 405, '请用 POST');

  const b = await body(req);
  const username = normUsername(b.username);
  const password = String(b.password || '');
  /* 客户端派生路径（v2.9.9）：浏览器本地跑 PBKDF2，把派生密钥发来，
     服务端零派生、只做一次 sha256 比对。credential 为空时走旧路径
     （服务端自己派生），兼容老客户端 / 不支持 WebCrypto 的浏览器。 */
  const credential = String(b.credential || '');

  if (!username || (!password && !credential)) return fail(res, 400, '请填写用户名和密码');

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
  let good;
  if (credential) {
    /* 凭证路径：比对浏览器派生的密钥。bcrypt 账号此路不通（返回 false），
        客户端从 salt 接口看到 algo='bcrypt' 时会改走明文路径。 */
    good = await verifyCredential(credential, hash);
  } else {
    good = await verifyPassword(password, hash);
  }

  if (!u || !good) {
    await bumpFail(sql, u ? u.id : null, username);
    return fail(res, 401, '用户名或密码不对');
  }
  if (u.status !== 'active') {
    /* v2.10.0：区分「待审核」与「已禁用」—— 提示语不同，
       待审核用户要知道的是「等着，不是被封了」。 */
    if (u.status === 'pending') {
      return fail(res, 403, '账号正在审核中，管理员通过后即可登录');
    }
    return fail(res, 403, '该账号已被禁用，请联系管理员');
  }

  await clearFail(sql, u.id);

  /* 旧算法的哈希在登录成功后顺手升级（bcrypt → pbkdf2）。
     换算法不影响老用户：能登录就说明密码对，这里只是把它重新存成新格式。
     ⚠️ 只在明文路径做：凭证路径没有明文可派生；且 pbkdf2c 已是当前格式，
        needsRehash 对它返回 false，不会触发。 */
  if (!credential && needsRehash(u.password_hash)) {
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
  /* v2.9.9：强制改密标志随 me 下发 —— 刷新页面后前端据此恢复强制改密态
     （以前该标志只有登录响应里有，一刷新就丢，用户被迫退出重登）。
     coalesce 兜底老库没有这一列的情况（与 login 同款写法）。 */
  let mustChange = false;
  try {
    const mu = await sql`
      select coalesce(must_change_password, false) as must_change_password
        from users where id = ${u.id} limit 1`;
    mustChange = !!(mu[0] && mu[0].must_change_password);
  } catch (e) { /* 老库缺列时按 false 处理，不影响 me 的其他字段 */ }
  return ok(res, {
    user: {
      id: u.id, username: u.username, displayName: u.displayName,
      role: u.role, createdAt: u.createdAt,
      /* 头衔与班级身份（来自 profiles，currentUser 已查好）：
         前端「课代表编辑作业」按钮的判定依据 */
      title: u.title || '', profileRole: u.profileRole || '',
    },
    isAdmin: u.role === 'admin',
    mustChangePassword: mustChange,
    cloudKeys: keys.map((k) => ({ key: k.data_key, updatedAt: k.updated_at })),
  });
}

/* ---------------- 在线心跳（v2.5.0 升级为双向） ----------------
   GET /api/auth?action=ping

   站主要求：「每隔一分钟双向发一个数据包，收到就说明在线」。
   所以这个接口从「单向写一下 last_seen_at」升级成**真正的双向握手**：
     · 前端带 token 请求（去程）
     · 服务端校验 token 有效 → 回 { pong, serverTime, online:true }（回程）
   前端只有**真的收到 pong** 才算「在线」，超时/网络错误即判离线。
   这比 navigator.onLine 可靠得多（后者只看网卡，连不上服务器照样 true）。

   在线粒度：**会话级**（sessions.last_seen_at），而不是用户级。
   同一个账号在两台设备登录，是两个会话，各自有自己的心跳时间。

   判定窗口：90 秒（心跳间隔 60 秒 + 抖动余量）。后台按
   「last_seen_at > now() - 90s」判在线。 */
const PING_THROTTLE_MS = 30 * 1000;
/* 与后台判定口径保持一致，前端也用它做本地急判 */
const ONLINE_WINDOW_SEC = 90;

async function ping(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;
  const sql = getSql();
  const now = Date.now();
  try {
    /* 🚀 2026-10-11 v2.5.2 性能修复（站主反馈「正常联网却显示连不到服务器」）：
       ------------------------------------------------------------
       这里原本是**两条串行的 UPDATE**：
         ① update sessions set last_seen_at = now() where ...   ← 等它回来
         ② update users    set last_seen_at = now() where ...   ← 再发第二次
       Neon 走 HTTP 传输（见 db.js 注释），**每条 SQL 就是一次 HTTPS 往返**。
       串行 → 心跳光这一段就 2 次往返；叠加上游 requireUser 的若干次，
       实测最慢一次要 10.1 秒，而前端超时只有 12 秒 —— 差 1.9 秒就误判离线，
       于是「网络明明是好的却弹连不到服务器」。

       修复：两条 UPDATE **并发发出**（Promise.all），耗时 ≈ 较慢的那一条，
       而不是两者之和。用 allSettled 是为了让「其中一条失败」不影响另一条，
       与原来的 try-catch 宽处理保持一致。

       ⚠️ 两条 UPDATE 里的**过滤条件是刻意的节流**：只在 30 秒没更新过时才写，
       避免每次心跳都产生一次写盘。并发不改变这个语义。 */
    const jobs = [
      /* 用户级 last_seen_at（后台旧视图仍用它看「最近活跃」） */
      sql`
        update users set last_seen_at = now()
         where id = ${u.id}
           and (last_seen_at is null or last_seen_at < now() - interval '30 seconds')
      `,
    ];
    /* 会话级 last_seen_at（v2.5.0 起「是否在线」的真正依据）。
       currentUser 已把 sha256(token) 放在 sessionToken 里；
       万一拿不到（老数据 / 兼容分支），退化为按 user_id 更新该用户所有会话。 */
    if (u.sessionToken) {
      jobs.push(sql`
        update sessions set last_seen_at = now()
         where token = ${u.sessionToken}
           and (last_seen_at is null or last_seen_at < now() - interval '30 seconds')
      `);
    } else {
      jobs.push(sql`
        update sessions set last_seen_at = now()
         where user_id = ${u.id}
           and (last_seen_at is null or last_seen_at < now() - interval '30 seconds')
      `);
    }
    const settled = await Promise.allSettled(jobs);
    settled.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.warn('[auth] ping 更新失败(' + (i ? 'sessions' : 'users') + ')：', r.reason && r.reason.message);
      }
    });
  } catch (e) {
    /* sessions.last_seen_at 列还没建出来（老库首次部署）时不能让心跳把前端搞崩 */
    console.warn('[auth] ping 更新异常：', e.message);
  }
  /* 回程数据包：前端收到它才认为「在线」 */
  return ok(res, {
    pong: now,
    serverTime: new Date().toISOString(),
    online: true,
    windowSec: ONLINE_WINDOW_SEC,
    mustChangePassword: !!u.mustChangePassword,
    username: u.username,
  });
}

/* ---------------- 盐参数查询（客户端派生用，v2.9.9 新增） ----------------
   POST /api/auth?action=salt  {username}
   → {algo:'pbkdf2', iterations, salt}   真实账号（含 pbkdf2 / pbkdf2c 两种格式）
   → {algo:'bcrypt'}                     老 bcrypt 账号（客户端改走明文路径）
   → {algo:'pbkdf2', iterations, salt}   不存在的账号（诱饵参数，形状与真实一致）

   为什么不直接下发 password_hash：哈希串的后半段是验证器，泄露等于把
   离线爆破的材料递出去。盐和迭代次数不是秘密（任何 KDF 方案都默认公开），
   客户端拿它们就能在本地完成派生，服务端因此一次 PBKDF2 都不用跑。 */
async function saltParams(req, res) {
  if (req.method !== 'POST') return fail(res, 405, '请用 POST');

  const b = await body(req);
  const username = normUsername(b.username);
  if (!username) return fail(res, 400, '请填写用户名');

  /* 轻量限流：同一用户名每分钟最多 30 次（内存计数，单 colo 近似生效）。
     这个接口本身不泄密，限流只是防「批量探用户名」和脚本刷派生。 */
  const now = Date.now();
  let hit = saltHits.get(username);
  if (!hit || now - hit.t > 60000) { hit = { n: 0, t: now }; saltHits.set(username, hit); }
  hit.n++;
  if (hit.n > 30) {
    return fail(res, 429, '查询太频繁了，稍等一分钟再试');
  }
  /* 顺手清理过期键，避免 Map 无限增长（班级规模下永远到不了几百条） */
  if (saltHits.size > 500) {
    for (const [k, v] of saltHits) { if (now - v.t > 60000) saltHits.delete(k); }
  }

  const sql = getSql();
  /* 故意不跑 ensureSchema：只查一定存在的 password_hash 列，
     把 CPU 预算留给密码相关的真正计算（改密链路的第一课）。 */
  const rows = await sql`
    select password_hash from users where lower(username) = ${username} limit 1
  `;

  const stored = rows.length ? rows[0].password_hash : DECOY_HASH;
  const p = parseHashParams(stored);
  if (!p) {
    /* bcrypt 或无法识别的格式：让客户端走明文路径（服务端派生），
        行为与 v2.9.9 之前完全一致。线上实测 bcrypt 账号数为 0。 */
    return ok(res, { algo: 'bcrypt' });
  }
  return ok(res, { algo: 'pbkdf2', iterations: p.iterations, salt: p.salt });
}
const saltHits = new Map();

/* ---------------- 修改自己的密码 ---------------- */
async function changePassword(req, res) {
  if (req.method !== 'POST') return fail(res, 405, '请用 POST');
  /* ⚠️ 这里用「轻量鉴权」而不是完整 requireUser：
     完整版会先跑 ensureSchema（多条 DDL）并查 profiles。
     轻量版只查会话与用户，把预算留给密码计算。（2026-10-07 第二十七轮） */
  const u = await requireUserSlim(req, res);
  if (!u) return;

  const b = await body(req);
  const oldPwd = String(b.oldPassword || '');
  const newPwd = String(b.newPassword || '');
  /* 客户端派生路径（v2.9.9）：oldCredential = 浏览器对「原密码」派生的密钥；
     newHash = 浏览器对「新密码」生成的完整哈希串（pbkdf2c$…）。
     两个都在，就零派生办完改密。 */
  const oldCred = String(b.oldCredential || '');
  const newHash = String(b.newHash || '');
  const useClientPath = !!oldCred && !!newHash;

  if (!useClientPath && (newPwd.length < 6 || newPwd.length > 64)) {
    return fail(res, 400, '新密码长度需 6–64 位');
  }
  if (useClientPath) {
    const v = validateClientHash(newHash);
    if (!v.ok) return fail(res, 400, '新密码数据格式不对：' + v.reason);
  }

  const sql = getSql();
  const rows = await sql`select password_hash from users where id = ${u.id}`;
  if (!rows.length) return fail(res, 400, '账号数据异常，请联系管理员');
  const oldHash = rows[0].password_hash;

  let good;
  if (useClientPath) {
    /* 凭证路径：比对浏览器派生的旧密钥（一次 sha256，零 PBKDF2）。
       老账号的 50000 次档位哈希在这里与 10000 次的一视同仁。 */
    good = await verifyCredential(oldCred, oldHash);
  } else {
    good = await verifyPassword(oldPwd, oldHash);
  }
  if (!good) return fail(res, 401, '原密码不对');

  /* 生成新哈希：
       凭证路径 —— 直接用客户端生成的 pbkdf2c 串（零派生）；
       明文路径 —— 服务端派生一次（10000 档，约几毫秒）。
     第五十六轮实测：线上单请求连跑 60 次派生都正常，CPU 预算不是瓶颈；
     真正卡过改密的是缺列（http.js ensureSchema 已修）和已拆除的
     needsDowngrade 护栏（它把 61 个 50000 档位的账号全拦在了自助改密外）。 */
  const hash = useClientPath ? newHash : await hashPassword(newPwd);
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
