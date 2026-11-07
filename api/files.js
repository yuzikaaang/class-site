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

const MAX_BYTES = 24 * 1024 * 1024;      /* 24MB —— 二进制直存，KV 单值上限 25MiB */
const MAX_BYTES_LEGACY = 15 * 1024 * 1024; /* 老通道（base64 塞 JSON）只能用 15MB */
const MAX_TEXT = 20000;                  /* 纯文本最多 2 万字 */
/* 去掉容易看错的 0 O 1 I L */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
/* v4.10.5（站主第 3 条）：保存天数自己设，1~15 天。
   站主原话：「保存的天数我可以自己设置 1~15 天」。超过 50MB 的文件最多只能存 1 天
   （目前单件上限 24MB，这条自动兜底，等以后换存储就生效）。 */
const TTL_MIN = 1;
const TTL_MAX = 15;
const DEFAULT_TTL = 3;
const BIG_FILE = 50 * 1024 * 1024;       /* 超过这个体积 → 只给 1 天 */
/* 软上限 700MB：给同名/临时键留出余量，到这儿就拒绝新上传，绝不撞 1GB 硬墙 */
const SOFT_QUOTA = 700 * 1024 * 1024;
/* 键前缀：
     f:  —— 老记录（JSON，文件在里面以 base64 躺着）
     b:  —— v4.10.5 起的文件字节（二进制直存，省掉 base64 的 33% 膨胀）
     fm: —— v4.10.5 起的元数据（单独一个几百字节的小键，
            这样「只看信息」和「改名」都不用把 24MB 整个读出来） */
const KB = 'b:';
const KM = 'fm:';
const KF = 'f:';
const KC = 'fc:';

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
function normTtl(v, size) {
  let t = Math.round(Number(v || DEFAULT_TTL));
  if (!isFinite(t) || t < TTL_MIN) t = DEFAULT_TTL;
  if (t > TTL_MAX) t = TTL_MAX;
  /* 站主：超过 50MB 的最多存 1 天（现在单件上限 24MB，等以后换存储自动生效） */
  if (Number(size) > BIG_FILE) t = 1;
  return t;
}
/* ----------------------------------------------------------------------------
 * 已用容量：list 一次带 metadata 就够（metadata.size 是上传时写进去的），
 * 不用把每个文件都读出来。返回近似值 —— 只用来「快到顶了就别再传」，
 * 不需要精确到字节。
 * ------------------------------------------------------------------------- */
async function kvUsage(kv) {
  let used = 0, n = 0;
  /* v4.10.5：新记录拆成 fm:（元数据，metadata.size 就是文件大小）+ b:（字节），
     老记录仍在 f: 里。统计只看「有 size 的那一层」，不会把同一个文件算两遍。 */
  for (const prefix of [KM, KF]) {
    let cursor;
    for (let page = 0; page < 5; page++) {
      let r;
      try {
        r = await kv.list({ prefix, limit: 1000, cursor });
      } catch (e) { break; }
      const keys = (r && r.keys) || [];
      for (const k of keys) {
        n++;
        const m = k && k.metadata;
        used += Number((m && m.size) || 0);
      }
      if (!r || r.list_complete) break;
      cursor = r.cursor;
    }
  }
  return { used, n, cap: SOFT_QUOTA };
}
function mb(n) { return Math.round((Number(n) || 0) / 1048576 * 10) / 10; }
function normMax(v) {
  const n = Number(v || 0);
  if (!isFinite(n) || n <= 0) return 0;      /* 0 = 不限次数 */
  /* v4.10.5（站主第 3 条）：取用次数可以设 1~50 次，或者不限 */
  return Math.max(1, Math.min(50, Math.floor(n)));
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');

  const kv = getKV(req);
  if (!kv) return bad(res, 503, '站点没有配置文件存储（KV 未绑定），暂时用不了');

  const q = (req.query || {});
  const action = String(q.action || '').toLowerCase();
  const method = String(req.method || 'GET').toUpperCase();

  /* ---------------- 上传文件（二进制直传，v4.10.5） ----------------
     为什么加这一条：老通道是「FileReader 读成 base64 → 塞进 JSON POST」，
     base64 会让体积 ×4/3，15MB 的文件在 KV 里要占 20MB，离 25MiB 单值上限很近，
     所以老通道只能到 15MB。现在直接把 File 当请求体发过来（Content-Type:
     application/octet-stream），worker 用 arrayBuffer() 接住，KV 里存原始字节 ——
     24MB 的文件就占 24MB，不膨胀。
     元数据单独放一个几百字节的 fm: 小键：
       · 查信息（?meta=1）不用把 24MB 整个读出来；
       · 改名只重写小键，不用重写 24MB 的字节（KV 写次数省着用）。 */
  if (method === 'POST' && action === 'upb') {
    const buf = req.__rawBuf;
    if (!buf || !buf.byteLength) return bad(res, 400, '没有收到文件内容');
    const size = buf.byteLength;
    if (size > MAX_BYTES) {
      return bad(res, 413, '文件太大了（上限 ' + mb(MAX_BYTES) + 'MB）。更大的课件建议放网盘，这里只挂个链接。');
    }
    const name = String(q.name || '未命名文件').slice(0, 120);
    const type = String(q.type || 'application/octet-stream').slice(0, 120);
    const memo = String(q.memo || '').slice(0, 60);
    const ttl = normTtl(q.ttl, size);
    const maxGet = normMax(q.maxGet);
    const at = Date.now();

    const usage = await kvUsage(kv);
    if (usage.used + size > SOFT_QUOTA) {
      return bad(res, 507,
        '存储快满了（已用 ' + mb(usage.used) + 'MB / ' + mb(SOFT_QUOTA) + 'MB），'
        + '先到「历史」里删掉一些不用的，或者等它们到期自动清掉再传。');
    }

    const code = randStr(6);
    const delKey = randStr(20);
    const meta = {
      v: 2, kind: 'file', name, type, size, at,
      exp: at + ttl * 86400000, ttl, maxGet, memo, del: delKey,
    };
    try {
      await kv.put(KB + code, buf, { expirationTtl: ttl * 86400 });
      await kv.put(KM + code, JSON.stringify(meta), {
        expirationTtl: ttl * 86400,
        metadata: { size, at, kind: 'file' },
      });
    } catch (e) {
      /* 只写进去一半就失败 → 把可能残留的字节清掉，别白占 24MB */
      try { await kv.delete(KB + code); } catch (e2) {}
      try { await kv.delete(KM + code); } catch (e2) {}
      return bad(res, 500, '存不进去：' + (e && e.message ? e.message : '未知错误'));
    }
    return ok(res, {
      code, delKey, kind: 'file', name, size, ttl, maxGet, exp: meta.exp,
      quota: { used: usage.used + size, cap: SOFT_QUOTA },
    });
  }

  /* ---------------- 上传（文本 / 老 base64 通道） ---------------- */
  if (method === 'POST' && (action === 'up' || action === 'text')) {
    let body = {};
    try { body = JSON.parse(req.body || '{}'); } catch (e) { return bad(res, 400, '请求格式不对'); }

    const isText = action === 'text' || String(body.kind || '') === 'text';
    const maxGet = normMax(body.maxGet);
    const memo = String(body.memo || '').slice(0, 60);
    const delKey = randStr(20);
    const at = Date.now();
    let ttl = normTtl(body.ttl);
    let rec = null;

    if (isText) {
      const text = String(body.text || '');
      if (!text.trim()) return bad(res, 400, '文本是空的');
      if (text.length > MAX_TEXT) return bad(res, 413, '文本太长了（上限 2 万字）');
      ttl = normTtl(body.ttl, new TextEncoder().encode(text).length);
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
      if (approx > MAX_BYTES_LEGACY) {
        return bad(res, 413, '文件太大了（老通道上限 15MB）。请刷新页面重试，新通道可以到 24MB。');
      }
      ttl = normTtl(body.ttl, approx);
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
    /* v4.10.5：新记录（fm: + b:） */
    const metaRaw = await kv.get(KM + code);
    if (metaRaw) {
      let m = null;
      try { m = JSON.parse(metaRaw); } catch (e) { m = null; }
      if (m && m.del && m.del !== delKey) return bad(res, 403, '删除口令不对');
      await kv.delete(KM + code);
      try { await kv.delete(KB + code); } catch (e) {}
      try { await kv.delete(KC + code); } catch (e) {}
      return ok(res, { deleted: true });
    }
    const raw = await kv.get(KF + code);
    if (!raw) return ok(res, { deleted: true, already: true });
    let rec = null;
    try { rec = JSON.parse(raw); } catch (e) { rec = null; }
    if (rec && rec.del && rec.del !== delKey) return bad(res, 403, '删除口令不对');
    await kv.delete(KF + code);
    try { await kv.delete(KC + code); } catch (e) {}
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
    /* v4.10.5：新记录的元数据在 fm: 小键里 —— 改名只用重写几百字节，
       不用把 24MB 的文件字节再读一遍再写一遍（KV 写次数省着用）。 */
    const metaRaw = await kv.get(KM + code);
    if (metaRaw) {
      let m = null;
      try { m = JSON.parse(metaRaw); } catch (e) { return bad(res, 500, '记录损坏'); }
      if (m.del && m.del !== delKey) return bad(res, 403, '删除口令不对');
      m.name = name;
      const left = Math.max(60, Math.floor((m.exp - Date.now()) / 1000));
      try {
        await kv.put(KM + code, JSON.stringify(m), {
          expirationTtl: left,
          metadata: { size: m.size, at: m.at, kind: m.kind },
        });
      } catch (e) { return bad(res, 500, '改名没存上：' + (e && e.message ? e.message : '')); }
      return ok(res, { code, name });
    }
    const raw = await kv.get(KF + code);
    if (!raw) return bad(res, 404, '取件码不存在或已过期');
    let rec = null;
    try { rec = JSON.parse(raw); } catch (e) { return bad(res, 500, '记录损坏'); }
    if (rec.del && rec.del !== delKey) return bad(res, 403, '删除口令不对');
    rec.name = name;
    const left = Math.max(60, Math.floor((rec.exp - Date.now()) / 1000));
    try {
      await kv.put(KF + code, JSON.stringify(rec), {
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

  /* v4.10.5：新记录先看 fm:（元数据小键），没有再回落到老的 f: */
  let rec = null;
  const metaRaw = await kv.get(KM + code);
  if (metaRaw) {
    try { rec = JSON.parse(metaRaw); } catch (e) { rec = null; }
  }
  if (!rec) {
    const raw = await kv.get(KF + code);
    if (!raw) return bad(res, 404, '取件码不存在或已过期');
    try { rec = JSON.parse(raw); } catch (e) { rec = null; }
  }
  if (!rec) return bad(res, 404, '取件码不存在或已过期');
  if (rec.kind !== 'text' && !rec.b64 && !metaRaw) return bad(res, 404, '这个取件码的内容已经失效');

  const maxGet = Number(rec.maxGet || 0);
  let gets = 0;
  try { gets = Number(await kv.get(KC + code)) || 0; } catch (e) { gets = 0; }

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

  /* 「取满次数就作废」要同时清掉新旧两套键 */
  async function dropAll() {
    try { await kv.delete(KM + code); } catch (e) {}
    try { await kv.delete(KB + code); } catch (e) {}
    try { await kv.delete(KF + code); } catch (e) {}
    try { await kv.delete(KC + code); } catch (e) {}
  }

  if (maxGet && gets >= maxGet) {
    await dropAll();
    return bad(res, 410, '这个取件码的取用次数已经用完了');
  }

  /* 计数 +1（单独一个短键，避免每次下载都重写整份文件） */
  try {
    const n = gets + 1;
    const leftTtl = Math.max(60, Math.floor((rec.exp - Date.now()) / 1000));
    await kv.put(KC + code, String(n), { expirationTtl: leftTtl });
    if (maxGet && n >= maxGet) {
      /* 取满了：把原件删掉，取件码立即作废（这次下载照常给） */
      await dropAll();
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
  let bytes = null;
  if (!rec.b64) {
    try {
      const buf = await kv.get(KB + code, 'arrayBuffer');
      if (buf) bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    } catch (e) { bytes = null; }
    if (!bytes) return bad(res, 404, '文件内容已经过期了，让对方重新发一次');
  } else {
    try { bytes = base64ToBytes(rec.b64); } catch (e) { return bad(res, 500, '文件解码失败'); }
  }
  res.statusCode = 200;
  /* 类型按上传时记的走：图片在浏览器里能直接预览，其他一律按下载处理 */
  res.setHeader('Content-Type', /^(image|application\/pdf|audio|video)\//i.test(String(rec.type || ''))
    ? String(rec.type) : 'application/octet-stream');
  res.setHeader('Content-Disposition', cdHeader(rec.name));
  res.setHeader('Content-Length', String(bytes.length));
  res.setHeader('Cache-Control', 'private, max-age=0, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(bytes);
}
