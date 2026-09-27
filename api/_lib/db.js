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

  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    throw new Error(
      '缺少 DATABASE_URL 环境变量。请在 Vercel 项目 → Settings → Environment Variables 里配置 Neon 的连接串。'
    );
  }
  _sql = neon(url);
  return _sql;
}

/** 配置：管理员账号、允许的前端来源、会话有效期 */
export function cfg() {
  return {
    /* 站点管理员用户名（首个管理员）。多个用英文逗号分隔 */
    adminUsers: (process.env.ADMIN_USERS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),

    /* 允许跨域的前端来源。前端在 GitHub Pages、API 在 Vercel，属于跨站，
       必须显式列白名单（不能用 * ，否则带凭据的请求会被浏览器拒绝）。
       多个用英文逗号分隔；填 '*' 表示放行全部（仅建议本地调试） */
    allowOrigins: (process.env.ALLOW_ORIGINS || '*')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    /* 会话 token 有效期（天） */
    sessionDays: Number(process.env.SESSION_DAYS || 30),

    /* 是否允许自助注册 */
    allowRegister: (process.env.ALLOW_REGISTER || '1') !== '0',
  };
}
