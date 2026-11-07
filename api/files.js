/* ============================================================================
 * /api/files —— 班级文件中转站（v4.7.11 起，v4.9.1 扩充）
 * ----------------------------------------------------------------------------
 * 站主原话：「有时候我要下载/传一些文件、图片、文本，手机、U 盘、电脑、班级电脑
 *   之间互通比较麻烦，我想拿你这个网站做媒介。文件不大，最多几兆。」
 *
 * 为什么不用 R2：免费额度是真的，但开户要绑银行卡 / PayPal（见 wrangler.toml
 *   里那段说明），对一个班级站点来说门槛太高。站里本来就有 KV 绑定（SITE_KV），
 *   十几兆的文件完全够放，于是直接用它 —— 不开新账号、不加新依赖。
 *
 * v4.9.1 新增（站主第 5、12 条）：
 *   · 单件上限 4MB → 15MB（KV 单值上限是 25MiB，base64 后约 20MB，留足余量）
 *   · 不止发文件，也能**直接发一段文本**（作业答案、链接、题目……）
 *   · 保存期只给 1 天 / 3 天（v4.9.2：站主算过账，KV 总共 1GB，宁可短不能满）
 *   · 可设「最多被取几次」，取满自动删除原件（防乱传）
 *   · 可以改名（凭删除口令），也可以随时提前删
 *   · 下载直链就是取件链接，直接发群里也能下
 *
 * KV 免费额度（2026 官方）：读 10 万次/天、写 1000 次/天、列表 1000 次/天、
 * **存储合计 1GB**、单值 25MiB。1GB ≈ 66 个 15MB 的文件，所以：
 *   · 保存期硬上限 3 天，到点由 KV 自己过期删除，不用人记着清理；
 *   · 上传前先算一次已用量，到 700MB 就不让再传了，永远不会把 1GB 撑爆。
 * ========================================================================= */

import { handlePreflight } from './_lib/http.js';

const MAX_BYTES = 15 * 1024 * 1024;      /* 15MB */
const MAX_TEXT = 20000;                  /* 纯文本最多 2 万字 */
/* 去掉容易看错的 0 O 1 I L */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
/* v4.9.2（站主）：KV 一共就 1GB，能留 3 天已经是上限，不再给 7/30/180 天 */
const TTL_CHOICES = [1, 3];
const DEFAULT_TTL = 3;
/* 软上限 700MB：给同名/临时键留出余量，到这儿就拒绝新上传，绝不撞 1GB 硬墙 */
const SOFT_QUOTA = 700 * 1024 * 1024;

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
function normTtl(v) {
  const t = Number(v || DEFAULT_TTL);
  return TTL_CHOICES.indexOf(t) >= 0 ? t : DEFAULT_TTL;
}
/* ----------------------------------------------------------------------------
 * 已用容量：list 一次带 metadata 就够（metadata.size 是上传时写进去的），
 * 不用把每个文件都读出来。返回近似值 —— 只用来「快到顶了就别再传」，
 * 不需要精确到字节。
 * ------------------------------------------------------------------------- */
async function kvUsage(kv) {
  let used = 0, n = 0, cursor;
  try {
    for (let page = 0; page < 5; page++) {
      const r = await kv.list({ prefix: 'f:', limit: 1000, cursor });
      const keys = (r && r.keys) || [];
      for (const k of keys) {
        n++;
        const m = k && k.metadata;
        used += Number((m && m.size) || 0);
      }
      if (!r || r.list_complete) break;
      cursor = r.cursor;
    }
  } catch (e) { /* 统计失败不影响主流程，按 0 算 */ }
  return { used, n, cap: SOFT_QUOTA };
}
function mb(n) { return Math.round((Number(n) || 0) / 1048576 * 10) / 10; }
function normMax(v) {
  const n = Number(v || 0);
  if (!isFinite(n) || n <= 0) return 0;      /* 0 = 不限次数 */
  return Math.max(1, Math.min(999, Math.floor(n)));
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');

  const kv = getKV(req);
  if (!kv) return bad(res, 503, '站点没有配置文件存储（KV 未绑定），暂时用不了');

  const q = (req.query || {});
  const action = String(q.action || '').toLowerCase();
  const method = String(req.method || 'GET').toUpperCase();

  /* ---------------- 上传（文件 / 文本） ---------------- */
  if (method === 'POST' && (action === 'up' || action === 'text')) {
    let body = {};
    try { body = JSON.parse(req.body || '{}'); } catch (e) { return bad(res, 400, '请求格式不对'); }

    const isText = action === 'text' || String(body.kind || '') === 'text';
    const ttl = normTtl(body.ttl);
    const maxGet = normMax(body.maxGet);
    const memo = String(body.memo || '').slice(0, 60);
    const delKey = randStr(20);
    const at = Date.now();
    let rec = null;

    if (isText) {
      const text = String(body.text || '');
      if (!text.trim()) return bad(res, 400, '文本是空的');
      if (text.length > MAX_TEXT) return bad(res, 413, '文本太长了（上限 2 万字）');
      rec = {
        kind: 'text',
        name: String(body.name || ('文本 ' + new Date(at).toLocaleString('zh-CN', { hour12: false }))).slice(0, 120),
        type: 'text/plain; charset=utf-8',
        size: new TextEncoder().encode(text).length,
        text, at, exp: at + ttl * 86400000, del: delKey, ttl, maxGet, memo,
      };
    } else {
      const name = String(body.name || '未命名文件').slice(0, 120);
      const type = String(body.type || 'application/octet-stream').slice(0, 120);
      const b64 = String(body.data || '');
      if (!b64) return bad(res, 400, '没有收到文件内容');

      /* base64 长度 → 原始字节数（粗略，够用来卡上限） */
      const approx = Math.floor(b64.length * 3 / 4);
      if (approx > MAX_BYTES) {
        return bad(res, 413, '文件太大了（上限 15MB）。更大的课件建议放在网盘，这里放链接。');
      }
      rec = {
        kind: 'file',
        name, type, size: approx, at, exp: at + ttl * 86400000,
        del: delKey, ttl, maxGet, memo, b64,
      };
    }

    /* v4.9.2：传之前先看一眼还剩多少地方 —— 满了就明说，别等 KV 写失败 */
    const usage = await kvUsage(kv);
    if (usage.used + rec.size > SOFT_QUOTA) {
      return bad(res, 507,
        '存储快满了（已用 ' + mb(usage.used) + 'MB / ' + mb(SOFT_QUOTA) + 'MB），'
        + '先到「历史」里删掉一些不用的，或者等它们 3 天到期自动清掉再传。');
    }

    const code = randStr(6);
    try {
      await kv.put('f:' + code, JSON.stringify(rec), {
        expirationTtl: ttl * 86400,
        /* size/at/kind 放进 metadata：list 时不用读值就知道占了多少 */
        metadata: { size: rec.size, at: rec.at, kind: rec.kind },
      });
    } catch (e) {
      return bad(res, 500, '存不进去：' + (e && e.message ? e.message : '未知错误'));
    }
    return ok(res, {
      code, delKey, kind: rec.kind, name: rec.name,
      size: rec.size, ttl, maxGet, exp: rec.exp,
      quota: { used: usage.used + rec.size, cap: SOFT_QUOTA },
    });
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
    try { await kv.delete('fc:' + code); } catch (e) {}
    return ok(res, { deleted: true });
  }

  /* ---------------- 改名 ---------------- */
  if (method === 'POST' && action === 'ren') {
    let body = {};
    try { body = JSON.parse(req.body || '{}'); } catch (e) { return bad(res, 400, '请求格式不对'); }
    const code = String(body.code || '').toUpperCase().trim();
    const delKey = String(body.delKey || '');
    const name = String(body.name || '').trim().slice(0, 120);
    if (!code || !delKey) return bad(res, 400, '缺少取件码或删除口令');
    if (!name) return bad(res, 400, '新名字是空的');
    const raw = await kv.get('f:' + code);
    if (!raw) return bad(res, 404, '取件码不存在或已过期');
    let rec = null;
    try { rec = JSON.parse(raw); } catch (e) { return bad(res, 500, '记录损坏'); }
    if (rec.del && rec.del !== delKey) return bad(res, 403, '删除口令不对');
    rec.name = name;
    const left = Math.max(60, Math.floor((rec.exp - Date.now()) / 1000));
    try {
      await kv.put('f:' + code, JSON.stringify(rec), {
        expirationTtl: left,
        metadata: { size: rec.size, at: rec.at, kind: rec.kind },
      });
    }
    catch (e) { return bad(res, 500, '改名没存上：' + (e && e.message ? e.message : '')); }
    return ok(res, { code, name });
  }

  /* ---------------- 剩余容量（面板上那行小字用） ---------------- */
  if (method === 'GET' && action === 'quota') {
    const u = await kvUsage(kv);
    return ok(res, { used: u.used, cap: u.cap, count: u.n, maxTtl: DEFAULT_TTL });
  }

  /* ---------------- 查询 / 下载 ---------------- */
  const code = String(q.code || '').toUpperCase().trim();
  if (!code) return bad(res, 400, '缺少取件码');
  if (!/^[2-9A-HJ-NP-Z]{6}$/.test(code)) return bad(res, 400, '取件码格式不对（6 位，不含 0 O 1 I L）');

  const raw = await kv.get('f:' + code);
  if (!raw) return bad(res, 404, '取件码不存在或已过期');

  let rec = null;
  try { rec = JSON.parse(raw); } catch (e) { rec = null; }
  if (!rec || (!rec.b64 && !rec.text)) return bad(res, 404, '这个取件码的内容已经失效');

  const maxGet = Number(rec.maxGet || 0);
  let gets = 0;
  try { gets = Number(await kv.get('fc:' + code)) || 0; } catch (e) { gets = 0; }

  /* 只查信息，不下载也不计数 */
  if (q.meta === '1' || q.meta === 'true') {
    return ok(res, {
      code,
      kind: rec.kind || 'file',
      name: rec.name,
      type: rec.type,
      size: rec.size,
      at: rec.at,
      exp: rec.exp,
      memo: rec.memo || '',
      maxGet, gets,
      left: maxGet ? Math.max(0, maxGet - gets) : null,
      /* 纯文本直接回内容，取件页里能看能复制（2 万字以内，够用） */
      text: (rec.kind === 'text') ? String(rec.text || '') : '',
    });
  }

  if (maxGet && gets >= maxGet) {
    try { await kv.delete('f:' + code); } catch (e) {}
    return bad(res, 410, '这个取件码的取用次数已经用完了');
  }

  /* 计数 +1（单独一个短键，避免每次下载都重写整份文件） */
  try {
    const n = gets + 1;
    const leftTtl = Math.max(60, Math.floor((rec.exp - Date.now()) / 1000));
    await kv.put('fc:' + code, String(n), { expirationTtl: leftTtl });
    if (maxGet && n >= maxGet) {
      /* 取满了：把原件删掉，取件码立即作废（这次下载照常给） */
      try { await kv.delete('f:' + code); } catch (e) {}
      try { await kv.delete('fc:' + code); } catch (e) {}
    }
  } catch (e) { /* 计数失败不影响这次下载 */ }

  /* 纯文本：直接按 txt 下载；?inline=1 时当纯文本显示（手机上方便看） */
  if (rec.kind === 'text') {
    const text = String(rec.text || '');
    const bytes = new TextEncoder().encode(text);
    res.statusCode = 200;
    res.setHeader('Content-Type', q.inline === '1' ? 'text/plain; charset=utf-8' : 'application/octet-stream');
    if (q.inline !== '1') res.setHeader('Content-Disposition', cdHeader((rec.name || '文本') + '.txt'));
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'private, max-age=0, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(bytes);
    return;
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
