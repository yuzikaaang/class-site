/* ============================================================
   Neon 连接层
   ------------------------------------------------------------
   ⚠️ 为什么不用普通的 `pg`：
   Vercel 的 Serverless 每次请求可能落在不同实例上，如果用 pg 的连接池，
   并发一上来每个实例都开自己的池，会瞬间把 Neon 的连接数上限打满
   （免费版只有几十个），表现为大面积的 "too many connections"。

   @neondatabase/serverless 走的是 HTTP/WebSocket 传输，
   每次查询就是一次 HTTP 请求，不占用长连接，天生适合 Serverless。

   用法：
     const sql = getSql();
     const rows = await sql`select * from users where id = ${id}`;
     // 参数用模板变量传入，自动参数化，不存在 SQL 注入
   ============================================================ */

import { neon } from '@neondatabase/serverless';
import { getEnv } from './env.js';

let _sql = null;

/** 取数据库连接（单例，同一实例内复用） */
export function getSql() {
  if (_sql) return _sql;

  /* 本地测试挂钩：local_bridge.js 会注入一个等价的 sql 模板函数，
     让 api/ 代码能连本地 Postgres 跑端到端测试（生产环境不会走到这里） */
  if (globalThis.__LOCAL_SQL_BRIDGE__) {
    _sql = globalThis.__LOCAL_SQL_BRIDGE__();
    return _sql;
  }

  const url = getEnv('DATABASE_URL') || getEnv('POSTGRES_URL');
  if (!url) {
    throw new Error(
      '缺少 DATABASE_URL 环境变量。请在部署平台的环境变量里配置 Neon 的连接串。'
    );
  }
  _sql = neon(url);
  return _sql;
}

/**
 * 把 user_data.data_value 这一列的值还原成 JS 值。
 *
 * ⚠️ 这个列是 **jsonb**（见 schema.sql:72），不同驱动返回的东西不一样：
 *      · Neon 服务端驱动（@neondatabase/serverless）→ **已经解析好的 JS 对象**
 *      · 部分驱动 / 本地 SQLite 测试桩            → JSON 文本字符串
 *   所以绝对不能无脑 `JSON.parse(raw)`。
 *
 *   实测踩过的坑（2026-10-06）：对象是对象时 JSON.parse 会抛
 *   `SyntaxError: "[object Object]" is not valid JSON`，异常被 catch 吞掉后，
 *   表现为「PUT 返回 200、/api/data 里能看到数据、GET /api/content 永远 count=0」，
 *   排查了很久才定位到是列类型而不是 SQL 语句的问题。
 *
 * @returns {*} 解析后的值；解析不出来返回 null（调用方要据此决定是「空」还是「出错」）
 */
export function jsonCol(raw) {
  if (raw === null || raw === undefined) return null;
  /* 已经是对象/数组：jsonb 被驱动解析过了，直接用 */
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** 配置：管理员账号、允许的前端来源、会话有效期 */
/** 找「系统账号」：优先 AI 助手，其次最早的管理员。
 *  内容/令牌等站点级数据挂在这个账号下，避免具体管理员毕业后数据丢失。 */
export async function systemUserId(sql) {
  const s = sql || getSql();
  const ai = await s`
    select id from users
     where is_ai = true and status = 'active'
     order by id limit 1
  `;
  if (ai.length) return Number(ai[0].id);

  const adm = await s`
    select id from users
     where role = 'admin' and status = 'active'
     order by id limit 1
  `;
  if (adm.length) return Number(adm[0].id);

  return null;
}

export function cfg() {
  return {
    /* 站点管理员用户名（首个管理员）。多个用英文逗号分隔 */
    adminUsers: getEnv('ADMIN_USERS')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),

    /* 允许跨域的前端来源。前端在 GitHub Pages、API 在 Cloudflare Workers，属于跨站，
       必须显式列白名单（不能用 * ，否则带凭据的请求会被浏览器拒绝）。
       多个用英文逗号分隔；填 '*' 表示放行全部（仅建议本地调试）。

       ⚠️ 2026-09-30 改为「默认不放行」：以前漏配环境变量会静默放行所有站点，
       等于把 API 敞开。现在漏配 = 跨域请求全部被浏览器拒绝，问题立刻暴露。 */
    allowOrigins: getEnv('ALLOW_ORIGINS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    /* 会话 token 有效期（天） */
    sessionDays: Number(getEnv('SESSION_DAYS') || 30),

    /* 是否允许自助注册 */
    allowRegister: (getEnv('ALLOW_REGISTER') || '1') !== '0',
  };
}

/* ---------------- 站点设置（v2.10.0，单行 jsonb 表） ----------------
   后台【系统设置】可改的站点级开关。与 cfg() 的环境变量分工：
     · cfg()        = 部署期变量（Worker 环境变量，改要重新部署）
     · site_settings = 运行期开关（管理员在后台随时改，立即生效）
   已知键：
     register_open   是否开放自助注册（未设置时回退到 env ALLOW_REGISTER）
     register_review 注册是否需管理员审核（默认 true）
   读取全部容错：表不存在 / 行为空都返回 fallback，绝不让设置读失败拖垮业务。 */
export async function getSiteSetting(sql, key, fallback = null) {
  try {
    const s = sql || getSql();
    const rows = await s`select data from site_settings where id = 1`;
    if (!rows.length || !rows[0].data) return fallback;
    const v = rows[0].data[key];
    return v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

/** 合并写入一个键（不动其他键）。value 会被 JSON 序列化后以 jsonb 并入。 */
export async function setSiteSetting(sql, key, value) {
  const s = sql || getSql();
  const patch = JSON.stringify({ [key]: value });
  await s`
    insert into site_settings (id, data, updated_at)
    values (1, ${patch}::jsonb, now())
    on conflict (id) do update
      set data = site_settings.data || excluded.data,
          updated_at = now()
  `;
}
