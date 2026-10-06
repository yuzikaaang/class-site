/* ============================================================
   管理员令牌库（Cloudflare / Gitee / VoiceHub 等）
   ------------------------------------------------------------
   仅管理员可读写。存储位置是 user_data 的 `admin_secrets_v1` 键，
   挂在系统账号名下，避免某个管理员毕业后令牌跟着他走。

   安全模型：
     · 读写接口本身要求 role = admin（已在外层 admin.js 校验）
     · 库中默认**明文**存储；如果配了环境变量 ADMIN_SECRETS_KEY，
       则启用 AES-256-GCM 加密，即使 Neon 数据泄露也读不出明文
     · 环境变量 ADMIN_SECRETS_KEY 不在仓库里，走 Cloudflare Workers
       的 secrets / vars 配置；本地调试不配置就退化成明文

   注意：这不是「绝对保密」，管理员本人本来就能看到明文；
   它的核心意义是「非管理员看不到」+「数据库泄露时不直接裸奔」。
   ============================================================ */

import { getSql, jsonCol, systemUserId } from './db.js';

const STORE_KEY = 'admin_secrets_v1';

/* ---------------- 基础64 ---------------- */
function bufToB64(buf) {
  if (typeof btoa === 'function') {
    let s = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  return Buffer.from(buf).toString('base64');
}
function b64ToBuf(s) {
  if (typeof atob === 'function') {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(s, 'base64'));
}

/* ---------------- AES-GCM 加密（可选） ---------------- */
function getCrypto() {
  if (globalThis.crypto && globalThis.crypto.subtle) return globalThis.crypto;
  /* Node 环境 */
  if (typeof require !== 'undefined') {
    const { webcrypto } = require('crypto');
    return webcrypto;
  }
  throw new Error('当前环境没有 Web Crypto API，无法启用令牌加密');
}

async function importKey(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const c = getCrypto();
  const buf = b64ToBuf(s);
  if (buf.length !== 32) {
    throw new Error('ADMIN_SECRETS_KEY 必须是 32 字节 Base64（建议 openssl rand -base64 32）');
  }
  return c.subtle.importKey('raw', buf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encryptValue(plain, key) {
  const c = getCrypto();
  const iv = c.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ct = await c.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain));
  return JSON.stringify({
    v: 1,
    iv: bufToB64(iv),
    ct: bufToB64(new Uint8Array(ct)),
  });
}

async function decryptValue(pkg, key) {
  const p = JSON.parse(pkg);
  if (p.v !== 1) throw new Error('不支持的密文版本');
  const c = getCrypto();
  const iv = b64ToBuf(p.iv);
  const ct = b64ToBuf(p.ct);
  const pt = await c.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

/* ---------------- 读写库 ---------------- */
async function loadDoc(sql) {
  const uid = await systemUserId(sql);
  if (!uid) return { doc: {}, uid: null, encrypted: false };
  const rows = await sql`
    select data_value from user_data
     where user_id = ${uid} and data_key = ${STORE_KEY}
  `;
  if (!rows.length || !rows[0].data_value) {
    return { doc: {}, uid, encrypted: false };
  }
  const raw = rows[0].data_value;
  const val = jsonCol(raw);
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return { doc: val, uid, encrypted: false };
  }
  /* 兼容：如果存的是加密后的字符串，外层 jsonCol 会返回字符串，
     需要按加密流程解。这里简单判断：字符串且以 {"v": 开头视为加密包。 */
  if (typeof raw === 'string' && raw.trim().startsWith('{"v":')) {
    return { doc: { __encryptedPackage: raw }, uid, encrypted: true };
  }
  return { doc: {}, uid, encrypted: false };
}

async function saveDoc(sql, uid, doc) {
  await sql`
    insert into user_data (user_id, data_key, data_value, updated_at)
    values (${uid}, ${STORE_KEY}, ${JSON.stringify(doc)}, now())
    on conflict (user_id, data_key)
    do update set data_value = excluded.data_value, updated_at = now()
  `;
}

/* ---------------- 对外 API ---------------- */

/** 列出所有令牌（name -> value，明文返回给管理员） */
export async function listSecrets(req) {
  const sql = getSql();
  const key = await importKey((req.__env || {}).ADMIN_SECRETS_KEY);
  const { doc, uid, encrypted } = await loadDoc(sql);
  if (!uid) return { secrets: [], encrypted: false, warning: '没有系统账号，无法存储令牌' };

  const out = [];
  let isEncrypted = encrypted || false;
  for (const name of Object.keys(doc)) {
    if (name === '__encryptedPackage') continue;
    let value = doc[name];
    if (typeof value === 'string' && value.startsWith('{"v":')) {
      isEncrypted = true;
      if (key) {
        try { value = await decryptValue(value, key); } catch (e) {
          value = '【解密失败：' + e.message + '】';
        }
      } else {
        value = '【已加密，但未配置 ADMIN_SECRETS_KEY，无法解密】';
      }
    }
    out.push({ name, value });
  }
  return { secrets: out, encrypted: isEncrypted, hasKey: !!key };
}

/** 保存或更新一个令牌 */
export async function saveSecret(req, name, value) {
  const n = String(name || '').trim();
  if (!n) throw new Error('令牌名称不能为空');
  if (!/^[A-Z][A-Z0-9_]*$/.test(n)) {
    throw new Error('令牌名称只能是大写字母、数字、下划线，且以大写字母开头（如 CLOUDFLARE_API_TOKEN）');
  }
  if (n.length > 64) throw new Error('令牌名称太长');

  const sql = getSql();
  const key = await importKey((req.__env || {}).ADMIN_SECRETS_KEY);
  const { doc, uid } = await loadDoc(sql);
  if (!uid) throw new Error('没有系统账号，无法存储令牌');

  let stored = value;
  if (key) stored = await encryptValue(value, key);

  doc[n] = stored;
  await saveDoc(sql, uid, doc);
  return { name: n, encrypted: !!key };
}

/** 删除一个令牌 */
export async function deleteSecret(req, name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('令牌名称不能为空');
  const sql = getSql();
  const { doc, uid } = await loadDoc(sql);
  if (!uid) throw new Error('没有系统账号');
  if (!(n in doc)) throw new Error('令牌不存在');
  delete doc[n];
  await saveDoc(sql, uid, doc);
  return { deleted: n };
}
