/* ============================================================
   Cloudflare Workers 统一入口
   ------------------------------------------------------------
   一个 Worker 接管三个接口：/api/auth、/api/data、/api/admin。
   与 Vercel / 阿里云 FC 版本的 auth.js / data.js / admin.js
   共用同一套业务代码，互不干扰（那些文件保持原样即可）。

   为什么需要这一层：
     Workers 的运行时是 Web 标准（Request / Response / fetch），
     没有 Node 的 req.on / res.end。这里把 Request 转换成
     业务代码认识的 { method, headers, query, body }，
     再把业务代码写出的 { statusCode, headers, body } 转回 Response。

   关键点：请求体是一次性流
     Workers 里 Request.body 只能读一次，而我们的 body() 工具
     可能在多处被调用。所以这里**先读成字符串**再挂到 req.__rawBody，
     彻底避开「Body has already been used」这个经典错误。
   ============================================================ */

import authHandler from './auth.js';
import dataHandler from './data.js';
import adminHandler from './admin.js';
import profileHandler from './profile.js';
import { cors } from './_lib/http.js';

/** 把 Workers 的 Request 适配成业务代码熟悉的形状 */
async function adaptRequest(request, env) {
  const url = new URL(request.url);

  /* 预读请求体（Get / Head 没有 body，跳过） */
  let rawBody = '';
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      rawBody = await request.text();
    } catch {
      rawBody = '';
    }
  }

  /* headers 转成普通对象（业务代码用 req.headers.origin / authorization） */
  const headers = {};
  for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;

  /* query 转成普通对象；同名参数取第一个（业务代码只用单值） */
  const query = {};
  for (const [k, v] of url.searchParams) query[k] = v;

  return {
    method: request.method,
    url: request.url,
    path: url.pathname,
    headers,
    query,
    body: rawBody,
    __rawBody: rawBody,
    __env: env,
    __isWorkers: true,
  };
}

/** 采集业务代码写出的响应，最后一次性转成 Workers 的 Response */
function makeResCollector() {
  const state = { statusCode: 200, headers: {}, body: '' };
  const res = {
    get statusCode() {
      return state.statusCode;
    },
    set statusCode(v) {
      state.statusCode = v;
    },
    setHeader(k, v) {
      state.headers[k] = v;
    },
    getHeader(k) {
      /* 大小写不敏感查找 */
      const key = Object.keys(state.headers).find((x) => x.toLowerCase() === String(k).toLowerCase());
      return key ? state.headers[key] : undefined;
    },
    end(body) {
      if (body !== undefined && body !== null) {
        state.body = typeof body === 'string' ? body : String(body);
      }
      return res;
    },
    send(body) {
      return res.end(body);
    },
  };
  return { res, state };
}

/* 各接口的 CORS 预检和响应头由业务代码自己设置，这里只负责路由 */
export default {
  async fetch(request, env, ctx) {
    /* 把 Workers 的绑定暴露给 _lib/env.js 的 getEnv()，
       bcryptjs / neon 等模块在任意深度都能读到环境变量 */
    globalThis.__ENV__ = env || {};

    const req = await adaptRequest(request, env);
    const { res, state } = makeResCollector();

    /* 取出路径里 /api/ 之后的那一段 */
    const m = /\/api\/([a-zA-Z0-9_-]+)/.exec(req.path || '');
    const seg = m ? m[1].toLowerCase() : '';

    try {
      switch (seg) {
        case 'auth':
          await authHandler(req, res);
          break;
        case 'data':
          await dataHandler(req, res);
          break;
        case 'admin':
          await adminHandler(req, res);
          break;
        case 'profile':
          await profileHandler(req, res);
          break;
        default:
          /* 404 也要回 CORS 头，否则跨域下浏览器会把响应整个拦掉，
             前端只看到含糊的 "Failed to fetch"，分不清是路径写错还是后端没配 */
          cors(req, res);
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: false, error: '未知接口：/api/' + (seg || '(空)') }));
      }
    } catch (e) {
      console.error('[worker]', seg, e && e.stack ? e.stack : e);
      cors(req, res);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, error: '服务器内部错误' }));
    }

    /* 204/304 在 Web 标准里不允许带响应体，Workers 的 Response 构造器
       会对非空 body 直接抛 TypeError。必须传 null。
       （Vercel 的 Node ServerResponse 没这个限制，所以这里要单独处理。） */
    const noBody = state.statusCode === 204 || state.statusCode === 304;
    return new Response(noBody ? null : state.body, {
      status: state.statusCode,
      headers: state.headers,
    });
  },
};
