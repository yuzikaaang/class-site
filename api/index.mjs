/* ============================================================
   阿里云函数计算（FC）统一入口
   ------------------------------------------------------------
   一个函数搞定三个接口：/api/auth、/api/data、/api/admin。
   好处：冷启动只发生一次、控制台只需配一套环境变量、路由集中。

   与 Vercel 版本的关系：
     auth.js / data.js / admin.js 里的 `export default async function handler(req,res)`
     原样保留，Vercel 继续按文件生成函数；本文件只是把同一个 handler
     接到 FC 的 HTTP 入口上。两套部署互不干扰。
   ============================================================ */

import authHandler from './auth.js';
import dataHandler from './data.js';
import adminHandler from './admin.js';
import profileHandler from './profile.js';
import contentHandler from './content.js';
import gamesHandler from './games.js';
import { cors } from './_lib/http.js';

/* FC 的 resp 是 Express 风格（有 send / setHeader / setStatusCode）。
   现有代码写的是 Node 原生 res（statusCode + end），这里做一层兼容，
   保证两种写法都能跑，将来换回 Vercel 也不用改业务代码。 */
function wrapRes(resp) {
  if (resp.__wrapped) return resp;
  const shim = {
    __wrapped: true,
    setHeader: (k, v) => resp.setHeader(k, v),
    get statusCode() { return resp.statusCode; },
    set statusCode(v) { resp.statusCode = v; if (typeof resp.setStatusCode === 'function') resp.setStatusCode(v); },
    end: (body) => (typeof resp.send === 'function' ? resp.send(body) : resp.end(body)),
    send: (body) => (typeof resp.send === 'function' ? resp.send(body) : resp.end(body)),
  };
  return shim;
}

/* 把 FC 的 req 补齐成 Vercel 的形状（业务代码只认 req.query / req.method / req.headers） */
function wrapReq(req) {
  if (!req.query && req.queries) req.query = req.queries;
  if (!req.query) req.query = {};
  return req;
}

export const handler = async (req, resp, context) => {
  const r = wrapReq(req);
  const res = wrapRes(resp);

  /* 取出路径里 /api/ 之后的那一段；兼容 FC 默认域名可能带前缀的情况 */
  const raw = (r.path || r.url || '').split('?')[0];
  const m = /\/api\/([a-zA-Z0-9_-]+)/.exec(raw);
  const seg = m ? m[1].toLowerCase() : '';

  try {
    switch (seg) {
      case 'auth':  return await authHandler(r, res);
      case 'data':  return await dataHandler(r, res);
      case 'admin': return await adminHandler(r, res);
      case 'profile': return await profileHandler(r, res);
      case 'content': return await contentHandler(r, res);
      case 'games': return await gamesHandler(r, res);
      default:
        /* 这里也要回 CORS 头：否则跨域下浏览器会把 404 响应整个拦掉，
           前端只能看到一句含糊的 "Failed to fetch"，看不出到底是接口名写错还是没配后端 */
        cors(r, res);
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, error: '未知接口：/api/' + (seg || '(空)') }));
        return;
    }
  } catch (e) {
    console.error('[fc]', seg, e);
    cors(r, res);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: '服务器内部错误' }));
  }
};

/* Vercel 兼容（若将来仍走 Vercel，可忽略本文件） */
export default handler;
