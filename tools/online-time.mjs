/* ============================================================
   线上取时工具（2026-10-11 站主立规）

   为什么需要它：
     站主明确要求「公告的时间要**线上获取**，而不是用沙箱内部的」。
     此前多次踩坑 —— 曾把公告写成未来时刻，也曾为了排序好看**人为编造
     递进时间**（如 17:20 / 17:24 / 17:30），站主每次都能一眼看出时间是错的。

   取时原理：
     向后端发一次请求，读 HTTP 响应头 `Date` —— 该头由 Cloudflare 生成，
     就是真实世界时间（UTC）。再 +8 小时换算成北京时间。

   ⚠️ 实测沙箱时钟与线上 Date 头是秒级一致的，但**仍然统一走这里**，
      因为「不信任本地时钟」是更稳的做法，也符合站主的要求。

   用法：
     node tools/online-time.mjs          # 直接打印当前线上北京时间
     import { onlineNow, onlineNowSec } from './online-time.mjs';
   ============================================================ */

const API_BASE = process.env.API_BASE || 'https://api.classsite.dpdns.org';

/* 后端前面挂了 Cloudflare，不带浏览器 UA 会被拦（error 1010） */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const pad = (n) => (n < 10 ? '0' : '') + n;

/**
 * 取线上真实时间。
 * @returns {Promise<{ date: Date, utc: string, bj: string, bjSec: string }>}
 *   bj    —— 北京时间，形如 `2026-10-11 18:30`（**公告 date 用这个**）
 *   bjSec —— 带秒，形如 `2026-10-11 18:30:07`（同一分钟内要多条时用它区分）
 */
export async function onlineNow(){
  let serverDate = null;
  try{
    const r = await fetch(API_BASE + '/api/content', {
      method: 'HEAD', headers: { 'User-Agent': UA },
    });
    const h = r.headers.get('date');
    if (h) serverDate = new Date(h);
  }catch(e){
    /* 线上取不到就**报错，不要静默退回本地时钟** —— 静默退回正是历史上
       "时间错了却没人发现"的成因。宁可让脚本失败，也不写一个可能不对的时间。 */
    throw new Error('取线上时间失败：' + e.message);
  }
  if (!serverDate || isNaN(serverDate.getTime())){
    throw new Error('后端未返回可解析的 Date 头，拒绝用本地时钟兜底');
  }
  const bjDate = new Date(serverDate.getTime() + 8 * 3600 * 1000);
  const Y = bjDate.getUTCFullYear(), M = bjDate.getUTCMonth() + 1, D = bjDate.getUTCDate();
  const h = bjDate.getUTCHours(), m = bjDate.getUTCMinutes(), s = bjDate.getUTCSeconds();
  return {
    date: bjDate,
    utc: serverDate.toISOString(),
    bj: `${Y}-${pad(M)}-${pad(D)} ${pad(h)}:${pad(m)}`,
    bjSec: `${Y}-${pad(M)}-${pad(D)} ${pad(h)}:${pad(m)}:${pad(s)}`,
  };
}

/* 直接运行则打印，便于在 shell 里核对 */
if (import.meta.url === `file://${process.argv[1]}`){
  const t = await onlineNow();
  console.log('线上 UTC      :', t.utc);
  console.log('线上北京时间  :', t.bj, ' (公告 date 用这个)');
  console.log('带秒          :', t.bjSec);
  console.log('');
  console.log('本地时钟对照  :', new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '));
}
