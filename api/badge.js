/* ============================================================================
 * /api/badge —— 班徽图片代理（v3.6.4）
 * ----------------------------------------------------------------------------
 * 站主原话：「班徽目前还是 404，所以我把直链加到了后台的系统设置的地址里面，
 *            以后获取从这来」
 *
 * 为什么需要代理：
 *   · 后台配的图片多半在图床（ax1x 之类）。图床不返回 Access-Control-Allow-Origin，
 *     前端 <img crossOrigin> 加载会失败，就算画进 canvas 也会被判「污染」，
 *     toBlob 直接抛 SecurityError —— 导出图就废了。
 *   · 站点自己的 badge.png 又受 GitHub Pages 新文件同步慢的影响（一直 404）。
 *
 * 所以让 Worker 去取：服务端不受 CORS 限制，取回来加上 CORS 头再吐给前端，
 * 等于给任何图床都套了一层「同源可画」的壳。
 *
 * 缓存：图片不常变，给 1 小时浏览器缓存 + 5 分钟边缘缓存，省流量也够快。
 * 失败：404 并带一句中文说明，前端会退回「兜底徽标」，不影响导出。
 * ========================================================================= */

import { getSql, jsonCol, systemUserId } from './_lib/db.js';
import { cors, handlePreflight, fail } from './_lib/http.js';

const CONTENT_KEY = 'cls_site_contents';
const MAX_BYTES = 4 * 1024 * 1024;   /* 4MB，够 2000px 的 PNG */

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  cors(req, res);

  try {
    const sql = getSql();
    const uid = await systemUserId(sql);
    if (!uid) return fail(res, 500, '没有可用的系统账号');

    const rows = await sql`
      select data_value from user_data
       where user_id = ${uid} and data_key = ${CONTENT_KEY} limit 1
    `;
    let doc = {};
    if (rows.length) {
      const p = jsonCol(rows[0].data_value);
      if (p && typeof p === 'object' && !Array.isArray(p)) doc = p;
    }
    const cfg = (doc.site_config && typeof doc.site_config === 'object') ? doc.site_config : {};
    const url = String(cfg.badgeUrl || '').trim();

    /* 没配就直接 404，前端用兜底徽标 —— 不要在这里返回一张空白图 */
    if (!url) return fail(res, 404, '没有配置班徽地址');

    /* 只允许 http(s)，防止有人写 file:// 或 javascript: */
    if (!/^https?:\/\//i.test(url)) return fail(res, 400, '班徽地址必须是 http(s) 链接');

    const r = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (!r.ok) return fail(res, 502, '图床返回 ' + r.status + '，取不到班徽');

    const type = r.headers.get('content-type') || '';
    if (!/^image\//i.test(type)) return fail(res, 415, '这个地址不是图片（' + (type || '未知类型') + '）');

    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return fail(res, 413, '班徽图片太大（超过 4MB）');

    res.statusCode = 200;
    res.setHeader('Content-Type', type);
    /* 1 小时浏览器缓存；边缘也缓存，避免每次导出都回源 */
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Badge-Source', 'proxy');
    res.end(Buffer.from(buf));
  } catch (e) {
    console.error('[badge]', e);
    return fail(res, 500, '取班徽失败：' + String(e.message || e).slice(0, 120));
  }
}
