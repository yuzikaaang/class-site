/* ============================================================
   密码哈希（PBKDF2-SHA256，Web Crypto 原生实现）
   ------------------------------------------------------------
   ⚠️ 为什么要从 bcrypt 换成 PBKDF2：

   Cloudflare Workers 每次请求有 CPU 上限（免费版 10ms），
   bcrypt 10 轮实测约 72ms，直接触发 Error 1102（超出资源限制），
   而且这个限制在免费版**无法调高**（付费版才能配 limits.cpu_ms）。

   PBKDF2 是 Web Crypto（crypto.subtle）原生支持的算法，
   不依赖任何第三方库，Workers 上能跑。

   🔴 第二十七轮（2026-10-07）踩坑：改密码接口 500「服务器错误」。
      当时归因为「2 次 PBKDF2 超 CPU 预算」，把迭代次数从 50000 一路
      降到 10000，并加了 needsDowngrade 护栏（>10000 的账号不让自助改密，
      只能找管理员重置）。

   🔴 第五十六轮（2026-10-15）推翻上述归因 + 彻底重构：
      ① **真根因不是 CPU，是缺列**。ensureSchema 漏了 failed_count /
         locked_until 两列（http.js 已修），改密/重置的裸写 UPDATE 撞到
         「列不存在」才 500。降迭代次数属于治标。
      ② **线上实测 CPU 预算很宽**：临时诊断端点单请求连跑 60 次
         PBKDF2(10000)（合计 60 万次迭代）稳定返回 200。所谓
         「10ms 装不下两次派生」在这套部署上不成立。
      ③ **但 needsDowngrade 护栏已经造成真实伤害**：线上 63 个账号里
         61 个是导入名单时的 50000 次档位，全部被护栏拦住，首次登录
         强制改密时人人卡死（站主截图反馈）。护栏防的是一个不存在的
         500，却 100% 挡住真人。——**已拆除**（见 auth.js change-password）。
      ④ **根子上的解法：把派生搬到浏览器**。浏览器没有 Workers 那种
         单请求 CPU 预算，PBKDF2 在本地跑；服务端只做「比对 / 存储」，
         单请求 CPU 开销降到一次 sha256。从此改密、登录都不再受服务端
         CPU 预算影响，付费/免费套餐怎么变都不怕。

   ────────────────────────────────────────────────────────────
   存储格式（三种，全部支持）：
     pbkdf2$<迭代次数>$<base64url 盐>$<base64url 派生密钥>
       旧格式：派生密钥直接存库。登录/改密（明文路径）由服务端派生。
     pbkdf2c$<迭代次数>$<base64url 盐>$<base64url sha256(派生密钥)>
       新格式（v2.9.9）：派生在**浏览器**完成，库里只存 sha256(dk)。
       即使数据库被拖库，拿到的也只是不可逆摘要，无法拿它直接当密码登录
       （必须逆推原密码，成本 = 一次 PBKDF2 爆破）。
     $2b$10$...
       bcrypt 老格式（线上实测 0 个，保留兼容路径）。

   新密码一律由客户端生成 pbkdf2c 串（CLIENT_ITERATIONS = 50000，
   与名单导入时的档位一致，老手机也能在几百毫秒内算完）；
   服务端 hashPassword() 只留给管理后台的建号/重置（单次派生、
   批量有上限，保持便宜的 10000 档，输出 pbkdf2$ 旧格式）。
   ============================================================ */

import bcrypt from 'bcryptjs';

/** 服务端派生的默认迭代次数（仅管理后台建号/重置用，单次派生）。 */
export const ITERATIONS = 10000;

/** 客户端派生（浏览器）的迭代次数。
 *  浏览器没有 Workers 那种 10ms 请求预算，可以取高一些；
 *  50000 与名单导入时的档位一致，老手机上一次派生约几十到几百毫秒，
 *  换来比 10000 强 5 倍的抗离线爆破能力。 */
export const CLIENT_ITERATIONS = 50000;

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const DIGEST_BYTES = 32;

/* ---------------- base64url 编解码（Workers 与 Node 通用） ---------------- */

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------------- PBKDF2 ---------------- */

async function pbkdf2(password, salt, iterations, keyBytes) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(password)),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    keyBytes * 8
  );
  return new Uint8Array(bits);
}

/** 生成密码哈希（**服务端**派生，仅管理后台建号/重置用）。
 *  输出旧格式 pbkdf2$：单次派生、成本低；用户自助改密走客户端派生
 *  （见 validateClientHash / auth.js 的凭证路径），不经过这个函数。 */
export async function hashPassword(password, iterations = ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const dk = await pbkdf2(password, salt, iterations, KEY_BYTES);
  return `pbkdf2$${iterations}$${bytesToB64url(salt)}$${bytesToB64url(dk)}`;
}

/* ---------------- 比对 ---------------- */

/** 等时比对：避免通过响应时间推断密码是否正确 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function sha256Bytes(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(buf);
}

/**
 * 校验密码（**明文路径**：旧客户端 / 无 WebCrypto 的浏览器回退用）。
 * 服务端自己跑 PBKDF2，成本 = 该账号哈希串里写的迭代次数。
 * @param {string} password 用户输入的明文
 * @param {string} stored   库里存的哈希串
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  const s = String(stored || '');

  /* 旧账号：bcrypt 串（$2a$ / $2b$） */
  if (/^\$2[aby]\$/.test(s)) {
    try {
      return await bcrypt.compare(String(password), s);
    } catch {
      return false;
    }
  }

  /* pbkdf2$iterations$salt$dk（dk 直接存库）*/
  if (s.startsWith('pbkdf2$')) {
    const parts = s.split('$');
    if (parts.length !== 4) return false;
    const iterations = Number(parts[1]);
    if (!Number.isFinite(iterations) || iterations <= 0) return false;

    let salt, expected;
    try {
      salt = b64urlToBytes(parts[2]);
      expected = b64urlToBytes(parts[3]);
    } catch {
      return false;
    }

    const actual = await pbkdf2(password, salt, iterations, expected.length);
    return timingSafeEqual(actual, expected);
  }

  /* pbkdf2c$iterations$salt$sha256(dk)（客户端派生，库里存摘要）：
     明文路径下服务端补做「派生 dk → sha256 → 比摘要」。 */
  if (s.startsWith('pbkdf2c$')) {
    const parts = s.split('$');
    if (parts.length !== 4) return false;
    const iterations = Number(parts[1]);
    if (!Number.isFinite(iterations) || iterations <= 0) return false;

    let salt, expected;
    try {
      salt = b64urlToBytes(parts[2]);
      expected = b64urlToBytes(parts[3]);
    } catch {
      return false;
    }

    const dk = await pbkdf2(password, salt, iterations, KEY_BYTES);
    const actual = await sha256Bytes(dk);
    return timingSafeEqual(actual, expected);
  }

  return false;
}

/* ---------------- 客户端派生（v2.9.9 第五十六轮新增） ----------------
   浏览器本地跑 PBKDF2，把派生密钥（dk）随请求发来；服务端**不再派生**，
   只做常量时间比对。单请求 CPU 开销降到一次 sha256，改密/登录从此
   与 Workers 的 CPU 预算脱钩（线上实测 60 次派生都没事，但没必要赌）。 */

/** 从哈希串里取出「盐 + 迭代次数」——盐和迭代次数不是秘密，可以下发给
 *  尚未登录的客户端（它需要这两个参数才能本地派生）。
 *  bcrypt 账号返回 {algo:'bcrypt'}（客户端改走明文路径）；
 *  无法识别的串返回 null（调用方按「不明格式」处理）。 */
export function parseHashParams(stored) {
  const s = String(stored || '');
  if (/^\$2[aby]\$/.test(s)) return { algo: 'bcrypt' };
  const parts = s.split('$');
  if (parts.length !== 4) return null;
  if (parts[0] !== 'pbkdf2' && parts[0] !== 'pbkdf2c') return null;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations <= 0 || iterations > 10000000) return null;
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(parts[2])) return null;
  return { algo: 'pbkdf2', iterations, salt: parts[2] };
}

/** 校验「客户端传来的新哈希串」是否可以直接入库。
 *  防的是畸形/恶意串把账号锁死（存进去谁也验不过）或把强度降到地板下：
 *    · 必须是 pbkdf2c$ 四段式
 *    · 迭代次数 10000–1000000
 *    · 盐、摘要都是合法 base64url，长度在合理区间
 *  @returns {{ok:true}|{ok:false,reason:string}} */
export function validateClientHash(s) {
  const str = String(s || '');
  if (str.length > 400) return { ok: false, reason: '哈希串过长' };
  const parts = str.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2c') {
    return { ok: false, reason: '格式应为 pbkdf2c$迭代次数$盐$摘要' };
  }
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 10000 || iterations > 1000000) {
    return { ok: false, reason: '迭代次数需在 10000–1000000 之间' };
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(parts[2])) return { ok: false, reason: '盐格式不对' };
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(parts[3])) return { ok: false, reason: '摘要格式不对' };
  try {
    const salt = b64urlToBytes(parts[2]);
    const dig = b64urlToBytes(parts[3]);
    if (salt.length < 8 || salt.length > 64) return { ok: false, reason: '盐长度需 8–64 字节' };
    if (dig.length < 16 || dig.length > 64) return { ok: false, reason: '摘要长度需 16–64 字节' };
  } catch {
    return { ok: false, reason: 'base64 解码失败' };
  }
  return { ok: true };
}

/**
 * 校验「客户端派生密钥」是否与库里哈希匹配（零派生，一次 sha256）。
 * @param {string} credential base64url 的派生密钥（浏览器 PBKDF2 输出）
 * @param {string} stored     库里存的哈希串
 * @returns {Promise<boolean>}
 */
export async function verifyCredential(credential, stored) {
  const s = String(stored || '');
  const cred = String(credential || '');
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(cred)) return false;

  let credBytes;
  try {
    credBytes = b64urlToBytes(cred);
  } catch {
    return false;
  }
  if (credBytes.length < 16 || credBytes.length > 64) return false;

  /* pbkdf2c：库里存的是 sha256(dk)，把收到的 dk 也哈希一遍再比 */
  if (s.startsWith('pbkdf2c$')) {
    const parts = s.split('$');
    if (parts.length !== 4) return false;
    let expected;
    try {
      expected = b64urlToBytes(parts[3]);
    } catch {
      return false;
    }
    const actual = await sha256Bytes(credBytes);
    return timingSafeEqual(actual, expected);
  }

  /* pbkdf2：dk 直接存库，拿来就比 */
  if (s.startsWith('pbkdf2$')) {
    const parts = s.split('$');
    if (parts.length !== 4) return false;
    let expected;
    try {
      expected = b64urlToBytes(parts[3]);
    } catch {
      return false;
    }
    return timingSafeEqual(credBytes, expected);
  }

  /* bcrypt / 不明格式：凭证路径不适用（调用方应改走明文路径） */
  return false;
}

/**
 * 这条哈希串的迭代次数（诊断/展示用）。
 * 非 pbkdf2/pbkdf2c（bcrypt 老串 / 非法串）一律返回 0，由调用方单独处理。
 */
export function hashIterations(stored) {
  const s = String(stored || '');
  if (/^\$2[aby]\$/.test(s)) return 0;
  const parts = s.split('$');
  if (parts.length !== 4) return 0;
  if (parts[0] !== 'pbkdf2' && parts[0] !== 'pbkdf2c') return 0;
  const n = Number(parts[1]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 这个哈希串是否需要升级（仅 bcrypt → pbkdf2 这种「算法」层面的升级）。
 *
 * ⚠️ 2026-10-15 第五十六轮纠正（推翻第二十七轮的结论）：
 *    · 绝不因为「迭代次数偏高」触发重哈希 —— 50000 次档位的账号登录时
 *      只跑 1 次派生，线上实测完全在预算内（诊断端点单请求连跑 60 次
 *      派生都正常），为它重算一次反而白白多花一次派生。
 *    · pbkdf2c（客户端派生的新格式）视为「当前格式」，不需要升级。
 */
export function needsRehash(stored) {
  const s = String(stored || '');
  if (/^\$2[aby]\$/.test(s)) return true;
  const parts = s.split('$');
  if (parts.length !== 4) return true;
  if (parts[0] !== 'pbkdf2' && parts[0] !== 'pbkdf2c') return true;
  return false;
}

/* ---------------- SHA-256 ----------------
   两个用途：
   ① 会话 token 哈希存储：sessions.token 不存明文，拖库也伪造不了登录态；
   ② pbkdf2c 格式的摘要：库里存 sha256(dk)，拖库也拿不到可直接登录的密钥。 */

export async function sha256Hex(str) {
  const data = new TextEncoder().encode(String(str));
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 假哈希（用于「用户不存在时也走一次比对」）。
 * 必须是一条**合法且能被真正计算**的串，否则 verifyPassword / verifyCredential
 * 会快速返回，时序防护就失效（历史上踩过两次坑：假 bcrypt 串长度非法直接
 * 返回 false；换 PBKDF2 后假串同步换成合法 pbkdf2 格式）。
 * 形状与真实新账号一致（pbkdf2c$50000），两条校验路径都能走到真正的计算。
 */
export const DECOY_HASH =
  'pbkdf2c$50000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
