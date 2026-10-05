/* ============================================================
   环境适配层（Node / Cloudflare Workers 双环境）
   ------------------------------------------------------------
   为什么需要它：
     - Node（Vercel / 阿里云 FC）：环境变量在 process.env
     - Cloudflare Workers：没有 process 对象，绑定放在 env 参数里，
       Worker 入口会把 env 挂到 globalThis.__ENV__ 上

   这个文件把两者统一成 getEnv(name)，业务代码只认它。
   ============================================================ */

/** 统一读取环境变量 */
export function getEnv(name) {
  /* Workers：入口注入的绑定对象 */
  const g = globalThis.__ENV__;
  if (g && g[name] !== undefined && g[name] !== null && g[name] !== '') {
    return String(g[name]);
  }
  /* Node：Vercel / FC / 本地 */
  if (typeof process !== 'undefined' && process.env && process.env[name] !== undefined) {
    return String(process.env[name]);
  }
  return '';
}

/** 当前是否运行在 Cloudflare Workers 上 */
export function isWorkers() {
  return typeof globalThis.__ENV__ === 'object' && globalThis.__ENV__ !== null;
}

/**
 * 运行环境是否为 Node（有 Buffer / 流）。
 * http.js 的 body() 需要按环境选解析方式。
 */
export function hasNodeRuntime() {
  return typeof process !== 'undefined' && !!process.versions && !!process.versions.node;
}
