/* ============================================================================
 * /api/img —— 通用图片代理（v4.7.9）
 * ----------------------------------------------------------------------------
 * 站主原话：「作业导出图片的时候，那个图片直链你没有把它转换成直接查看的照片」。
 *
 * 原因：作业里的图片直链大多来自图床（ax1x、smms、bilibili 图床…），
 *   这些站**不给 CORS 头**，浏览器 fetch 直接失败，画进 canvas 还会污染画布。
 *   以前只能退回一行「图片：https://…」的文字，等于没画。
 *
 * 做法：服务端取图 → 加 CORS 头吐回来，前端就当成同源图片，能画能存。
 *   和 /api/badge 是同一套思路，只是把这个能力开放给了作业里的任意图片。
 *
 * 安全：
 *   · 只代理 http/https，只接受 image/* 的响应；
 *   · 拒绝内网 / 回环 / 链路本地地址（防 SSRF）；
 *   · 单张上限 8MB、超时 10 秒，超了直接 502，不让导出卡死；
 *   · 结果进 Cloudflare 边缘缓存 1 天，同一张图第二次是命中缓存。
 * ========================================================================= */

import { handlePreflight } from './_lib/http.js';

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10000;

function bad(res, code, msg) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify({ ok: false, error: msg }));
}

/* 内网地址一律不代理 */
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h === '0.0.0.0' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  const m = /^172\.(\d+)\./.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  return false;
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');

  const raw = req.query && (req.query.u || req.query.url);
  let u = '';
  try { u = decodeURIComponent(String(raw || '').trim()); } catch (e) { u = String(raw || '').trim(); }
  if (!u) return bad(res, 400, '缺少 u 参数');

  let target;
  try { target = new URL(u); } catch (e) { return bad(res, 400, '地址不合法'); }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return bad(res, 400, '只支持 http / https');
  if (isPrivateHost(target.hostname)) return bad(res, 403, '不允许代理内网地址');

  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) {} }, TIMEOUT_MS) : null;

  try {
    const opts = {
      /* 有些图床会看 Referer 防盗链，这里伪装成直接访问 */
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClassSiteImg/1.0)', Accept: 'image/*,*/*;q=0.8' },
      redirect: 'follow',
      cf: { cacheTtl: 86400, cacheEverything: true },
    };
    if (ctl) opts.signal = ctl.signal;
    const r = await fetch(target.href, opts);
    if (!r.ok) return bad(res, 502, '上游返回 HTTP ' + r.status);

    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\//.test(type)) return bad(res, 415, '上游不是图片（' + (type || '未知类型') + '）');

    const buf = await r.arrayBuffer();
    if (!buf || buf.byteLength === 0) return bad(res, 502, '图片是空的');
    if (buf.byteLength > MAX_BYTES) return bad(res, 413, '图片超过 8MB，建议先压一下');

    res.statusCode = 200;
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Img-Source', 'proxy');
    res.end(Buffer.from(buf));
  } catch (e) {
    return bad(res, 504, '取图失败：' + String((e && e.message) || e).slice(0, 80));
  } finally {
    if (timer) clearTimeout(timer);
  }
}
