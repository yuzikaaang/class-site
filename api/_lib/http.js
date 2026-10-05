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

  let allow = '*';
  if (!allowOrigins.includes('*')) {
    allow = allowOrigins.includes(origin) ? origin : allowOrigins[0] || '';
  } else if (origin) {
    /* 白名单是 * 时，回显具体来源，方便本地调试 */
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
 * 解析当前登录用户。
 * @returns {Promise<{id:number,username:string,role:string}|null>}
 */
export async function currentUser(req) {
  const token = bearer(req);
  if (!token) return null;
  const sql = getSql();
  const rows = await sql`
    select u.id, u.username, u.role, u.status, u.display_name, u.created_at,
           s.expires_at
      from sessions s
      join users u on u.id = s.user_id
     where s.token = ${token}
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
    createdAt: u.created_at,
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
