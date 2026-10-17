/* ============================================================
   成员档案字段加密（v3.5.0）
   ------------------------------------------------------------
   站主原话：「成员档案里的所有信息，比如姓名，学号，身份证，微信等等
   全部也加密储存」。

   设计要点（**先想清楚再动手，这里每一步都是有原因的**）：

   ① 加密算法与令牌库保持同一套：AES-256-GCM（Web Crypto 原生，
       Workers 免费版也能跑），密钥来自环境变量 ADMIN_SECRETS_KEY。
       —— 不新开一个密钥变量：站主已经配好一个，再让他配第二个是自找麻烦；
          同一个密钥保护「令牌」和「档案」两处，安全等级是一样的。

   ② 密文格式 `enc:v1:<base64(iv|ct)>`，前缀 `enc:v1:` 作为哨兵。
      · 存量明文逐行迁移：读到明文就照常返回，管理员保存时顺手加密
        —— 不做一次性批量迁移（几十条 UPDATE 会把免费版子请求打爆）。
      · 迁移期间明文/密文混存是**正常状态**，decrypt 对非哨兵值原样返回。

   ③ **只有能精确检索的列才做盲索引（blind index）**，其余一律只加密：
      · name / student_id —— 后台按姓名、学号搜索，导入按学号去重，
        必须有 `name_bidx` / `student_id_bidx` = HMAC-SHA256(密钥, 规范化原值)。
        **姓名在界面上支持「包含」模糊查**，盲索引只能等值匹配 ——
        所以姓名搜索的语义变为「全名精确匹配」（在后台提示里写明）。
      · exam_no（准考证号）、politics、微信、QQ、手机、身份证等 ——
        不做索引，只在整行读出后解密、在内存里过滤。

   ④ 没配 ADMIN_SECRETS_KEY 时**整体退化为明文**，行为与改造前完全一致，
      绝不因为缺密钥把后台打死（与令牌库同一套降级策略）。

   ⑤ 密文长度会超过原列宽（GCM 的 IV 12B + 认证标签 16B + base64 膨胀 33%），
      schema.sql 里已把这些列统一扩到 text，无需担心超长。
   ============================================================ */

const ENC_PREFIX = 'enc:v1:';

/* base64 编解码：Workers 与 Node 都要能跑（与 secrets-store 同写法） */
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

function getCrypto() {
  if (globalThis.crypto && globalThis.crypto.subtle) return globalThis.crypto;
  if (typeof require !== 'undefined') {
    const { webcrypto } = require('crypto');
    return webcrypto;
  }
  throw new Error('当前环境没有 Web Crypto API，无法加密档案字段');
}

/** 缓存已导入的密钥（同一请求内多字段复用，避免每次都 importKey） */
const KEY_CACHE = new WeakMap();

/**
 * 从 req.__env 取 ADMIN_SECRETS_KEY 并导入成 CryptoKey。
 * 返回的对象上额外挂 `__raw`（原始字节）：盲索引要用同字节导 HMAC key，
 * 而 CryptoKey 本身不可导出，所以这里留一份原始字节。
 * @returns {Promise<object|null>} 没配置/配置不合法时返回 null（调用方退化为明文）
 */
export async function profileKey(req) {
  const env = (req && req.__env) || {};
  const raw = String(env.ADMIN_SECRETS_KEY || '').trim();
  if (!raw) return null;
  if (KEY_CACHE.has(req)) return KEY_CACHE.get(req);
  let key = null;
  try {
    const buf = b64ToBuf(raw);
    if (buf.length !== 32) throw new Error('ADMIN_SECRETS_KEY 必须是 32 字节 Base64');
    key = await getCrypto().subtle.importKey('raw', buf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    key.__raw = buf;   /* 非标准属性，仅本模块内部用（盲索引用） */
  } catch (e) {
    console.warn('[profile-crypt] 密钥不可用，退化为明文：', e.message);
    key = null;
  }
  KEY_CACHE.set(req, key);
  return key;
}

/** 加密一个值；key 为 null 或值为空时原样返回（空值不产生密文噪声） */
export async function encField(key, plain) {
  if (!key) return plain == null ? plain : String(plain);
  if (plain == null || plain === '') return plain;
  const c = getCrypto();
  const iv = c.getRandomValues(new Uint8Array(12));
  const ct = await c.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(String(plain)));
  const all = new Uint8Array(iv.length + ct.byteLength);
  all.set(iv, 0);
  all.set(new Uint8Array(ct), iv.length);
  return ENC_PREFIX + bufToB64(all);
}

/**
 * 解密失败时返回的占位符前缀。
 * 🔴 这是**有安全含义**的标记，不只是给人看的提示文案：
 *    解不出来时前端会把这段占位符回显给管理员。如果管理员随后点了保存，
 *    这段占位符就会被当成真值写回数据库 —— 原来的密文被覆盖，数据永久丢失。
 *    所以写入侧（admin.js 的 upsertProfileCore）必须用 isUndecryptable() 拦一道：
 *    占位符一律当作「本次没改这个字段」，保留库里原值。
 */
const UNDEC_PREFIX = '【已加密';

/** 判断一个值是不是「解密失败」的占位符（写入侧要挡住它，别回写库） */
export function isUndecryptable(v) {
  return typeof v === 'string' && v.indexOf(UNDEC_PREFIX) === 0;
}

/** 解密一个值；不是密文（存量明文 / 空值）时原样返回 —— 迁移期混存是常态 */
export async function decField(key, stored) {
  if (stored == null || stored === '') return stored;
  const s = String(stored);
  if (s.slice(0, ENC_PREFIX.length) !== ENC_PREFIX) return s;   /* 明文，直接给 */
  if (!key) return '【已加密，但未配置 ADMIN_SECRETS_KEY，无法解密】';
  try {
    const all = b64ToBuf(s.slice(ENC_PREFIX.length));
    const iv = all.slice(0, 12);
    const ct = all.slice(12);
    const pt = await getCrypto().subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch (e) {
    return '【解密失败】';
  }
}

/** 判断某个存储值是不是密文（后台用来显示「已加密」标记） */
export function isEnc(v) {
  return typeof v === 'string' && v.slice(0, ENC_PREFIX.length) === ENC_PREFIX;
}

/**
 * 盲索引：HMAC-SHA256(密钥, 规范化原值) 的 base64。
 * 用途 ONLY 是「按等值检索」——姓名全名精确匹配、学号去重。
 * 不配密钥时返回 null，调用方跳过索引写入（搜索退化为解密后内存过滤）。
 */
export async function blindIndex(key, plain) {
  if (!key || plain == null || plain === '') return null;
  const norm = String(plain).replace(/\s+/g, ' ').trim();
  if (!norm) return null;
  const c = getCrypto();
  /* HMAC 的密钥：从同一份原始字节单独导入（CryptoKey 不可导出） */
  const hmacKey = await c.subtle.importKey(
    'raw', key.__raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  ).catch(() => null);
  if (!hmacKey) return null;
  const sig = await c.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(norm));
  return bufToB64(sig);
}
