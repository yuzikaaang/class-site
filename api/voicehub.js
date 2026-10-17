/* ============================================================
   /api/vh —— VoiceHub 点歌平台代理（v3.5.13 新增，站主 #3）
   ------------------------------------------------------------
   GET /api/vh?action=songs&base=https://xsyzc2505.dpdns.org

   为什么需要这一层：
     实测站主的 VoiceHub 实例（xsyzc2505.dpdns.org）**不返回 CORS 头**，
     浏览器直连 /api/songs/public 会被同源策略拦掉，必须服务端中转。

   设计要点：
     ① 只读代理，只放行 GET /api/songs/public —— 不碰任何需要凭据的
        接口（投稿 / 改状态 / 排期都要登录或令牌，本轮不做，见 notes）。
     ② base 必须是 https 且 host 含点号（防内网地址）；路径写死，不做
        通用代理（避免变成开放转发器）。
     ③ 上游 6s 超时；失败返回 ok:false + error，前端自己降级。
     ④ 5 分钟实例级内存缓存 —— 公开歌单变化不频繁，省上游配额。
   ============================================================ */

import { cors, handlePreflight, ok, fail } from './_lib/http.js';

const UPSTREAM_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();   /* base -> { at, data } */

export default async function voicehubHandler(req, res) {
  if (handlePreflight(req, res)) return;
  cors(req, res);

  const u = new URL(req.url, 'http://x');
  const q = u.searchParams;
  const action = q.get('action') || '';

  if (req.method !== 'GET') return fail(res, 405, '仅支持 GET');

  if (action !== 'songs') return fail(res, 400, '未知动作：' + action);

  let base = String(q.get('base') || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/i.test(base)) {
    return fail(res, 400, 'base 必须是 https:// 开头的完整站点地址');
  }

  /* 缓存 */
  const hit = cache.get(base);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return ok(res, { songs: hit.data, cached: true });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(base + '/api/songs/public', {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!r.ok) return fail(res, 502, 'VoiceHub 返回 HTTP ' + r.status);
    const ct = String(r.headers.get('content-type') || '');
    if (!ct.includes('json')) return fail(res, 502, 'VoiceHub 返回了非 JSON 内容');
    const data = await r.json();
    if (!Array.isArray(data)) return fail(res, 502, 'VoiceHub 数据格式变了（不是数组）');
    cache.set(base, { at: Date.now(), data });
    return ok(res, { songs: data, cached: false });
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? 'VoiceHub 连接超时' : (e && e.message) || '连接失败';
    return fail(res, 502, '读取 VoiceHub 失败：' + msg);
  } finally {
    clearTimeout(timer);
  }
}
