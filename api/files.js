/* ============================================================================
 * /api/files —— 班级文件中转站（v4.7.11 站主第 6 条）
 * ----------------------------------------------------------------------------
 * 站主原话：「有时候我要下载/传一些文件、图片、文本，手机、U 盘、电脑、班级电脑
 *   之间互通比较麻烦，我想拿你这个网站做媒介。文件不大，最多几兆。」
 *
 * 为什么不用 R2：免费额度是真的，但开户要绑银行卡 / PayPal（见 wrangler.toml
 *   里那段说明），对一个班级站点来说门槛太高。站里本来就有 KV 绑定（SITE_KV），
 *   几兆的文件完全够放，于是直接用它 —— 不开新账号、不加新依赖。
 *
 * 形态：上传 → 拿到 6 位取件码 → 在任意设备输入取件码下载。
 *   · 单文件上限 4MB（base64 后约 5.4MB，KV 单值上限 25MB，留足余量）
 *   · 默认存 7 天，也可以选 1 天 / 30 天；到期自动从 KV 消失
 *   · 下载一律 Content-Disposition: attachment，绝不当网页渲染（防 XSS）
 *   · 上传时返回一个 20 位删除口令，凭它可以在任何设备提前删除
 *
 * KV 免费额度：写 1000 次/天、读 10 万次/天、存储 1GB —— 班级用量远远够。
 * ========================================================================= */

import { handlePreflight } from './_lib/http.js';

const MAX_BYTES = 4 * 1024 * 1024;
/* 去掉容易看错的 0 O 1 I L */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const TTL_CHOICES = [1, 7, 30];

function ok(res, obj) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify({ ok: true, ...obj }));
}
function bad(res, code, msg) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify({ ok: false, error: msg }));
}
function randStr(n) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
}
function getKV(req) {
  const env = req && req.__env;
  const kv = env && env.SITE_KV;
  if (!kv || typeof kv.get !== 'function') return null;
  return kv;
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}
/* 中文文件名也能安全出现在 Content-Disposition 里 */
function cdHeader(name) {
  const ascii = String(name || 'file').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(name || 'file');
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');

  const kv = getKV(req);
  if (!kv) return bad(res, 503, '站点没有配置文件存储（KV 未绑定），暂时用不了');

  const q = (req.query || {});
  const action = String(q.action || '').toLowerCase();
  const method = String(req.method || 'GET').toUpperCase();

  /* ---------------- 上传 ---------------- */
  if (method === 'POST' && action === 'up') {
    let body = {};
    try { body = JSON.parse(req.body || '{}'); } catch (e) { return bad(res, 400, '请求格式不对'); }

    const name = String(body.name || '未命名文件').slice(0, 120);
    const type = String(body.type || 'application/octet-stream').slice(0, 120);
    const b64 = String(body.data || '');
    if (!b64) return bad(res, 400, '没有收到文件内容');

    /* base64 长度 → 原始字节数（粗略，够用来卡上限） */
    const approx = Math.floor(b64.length * 3 / 4);
    if (approx > MAX_BYTES) {
      return bad(res, 413, '文件太大了（上限 4MB）。大文件建议还是用 U 盘或网盘。');
    }

    let ttl = Number(body.ttl || 7);
    if (TTL_CHOICES.indexOf(ttl) < 0) ttl = 7;

    const code = randStr(6);
    const delKey = randStr(20);
    const at = Date.now();
    const rec = {
      name, type,
      size: approx,
      at,
      exp: at + ttl * 86400000,
      del: delKey,
      b64,
    };
    try {
      await kv.put('f:' + code, JSON.stringify(rec), { expirationTtl: ttl * 86400 });
    } catch (e) {
      return bad(res, 500, '存不进去：' + (e && e.message ? e.message : '未知错误'));
    }
    return ok(res, { code, delKey, size: approx, ttl, exp: rec.exp });
  }

  /* ---------------- 删除 ---------------- */
  if (method === 'POST' && action === 'del') {
    let body = {};
    try { body = JSON.parse(req.body || '{}'); } catch (e) { return bad(res, 400, '请求格式不对'); }
    const code = String(body.code || '').toUpperCase().trim();
    const delKey = String(body.delKey || '');
    if (!code || !delKey) return bad(res, 400, '缺少取件码或删除口令');
    const raw = await kv.get('f:' + code);
    if (!raw) return ok(res, { deleted: true, already: true });
    let rec = null;
    try { rec = JSON.parse(raw); } catch (e) { rec = null; }
    if (rec && rec.del && rec.del !== delKey) return bad(res, 403, '删除口令不对');
    await kv.delete('f:' + code);
    return ok(res, { deleted: true });
  }

  /* ---------------- 查询 / 下载 ---------------- */
  const code = String(q.code || '').toUpperCase().trim();
  if (!code) return bad(res, 400, '缺少取件码');
  if (!/^[2-9A-HJ-NP-Z]{6}$/.test(code)) return bad(res, 400, '取件码格式不对（6 位，不含 0 O 1 I L）');

  const raw = await kv.get('f:' + code);
  if (!raw) return bad(res, 404, '取件码不存在或已过期');

  let rec = null;
  try { rec = JSON.parse(raw); } catch (e) { rec = null; }
  if (!rec || !rec.b64) return bad(res, 404, '这个取件码的文件已经失效');

  /* 只查信息，不下载 */
  if (q.meta === '1' || q.meta === 'true') {
    return ok(res, {
      code,
      name: rec.name,
      type: rec.type,
      size: rec.size,
      at: rec.at,
      exp: rec.exp,
    });
  }

  /* 真下载：二进制直出，绝不按网页渲染 */
  let bytes;
  try { bytes = base64ToBytes(rec.b64); } catch (e) { return bad(res, 500, '文件解码失败'); }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', cdHeader(rec.name));
  res.setHeader('Content-Length', String(bytes.length));
  res.setHeader('Cache-Control', 'private, max-age=0, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(bytes);
}
