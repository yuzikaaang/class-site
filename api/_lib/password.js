/* ============================================================
   密码哈希（PBKDF2-SHA256，Web Crypto 原生实现）
   ------------------------------------------------------------
   ⚠️ 为什么要从 bcrypt 换成 PBKDF2：

   Cloudflare Workers 免费版每次请求的 CPU 上限是 **10ms**
   （官方文档：CPU time per HTTP request = 10 ms）。
   bcrypt 10 轮实测约 72ms，直接触发 Error 1102（超出资源限制），
   而且这个限制在免费版**无法调高**（付费版才能配 limits.cpu_ms）。

   PBKDF2 是 Web Crypto（crypto.subtle）原生支持的算法，
   不依赖任何第三方库，Workers 上能跑。

   🔴 第二十七轮（2026-10-07）踩坑：改密码接口 500「服务器错误」。
      根因：改密码要「校验原密码（1 次派生）+ 生成新哈希（1 次派生）」，
      合计 2 次 PBKDF2。迭代次数取 50000 时：
        1 次 ≈ 9.3ms（登录勉强卡在 10ms 内，正常）
        2 次 ≈ 18.7ms（改密码直接超出 10ms → 被掐断 → 500）
      原密码填错只走 1 次派生就 return 了，所以「错密码」正常、「对密码」500。
      实测把迭代次数降到 25000 后：
        1 次 ≈ 4.5ms，2 次 ≈ 9.1ms —— 改密码也能稳稳落在 10ms 内。
      故迭代次数从 50000 降到 **25000**，并在 needsRehash 里不再按
      「迭代次数偏低」触发重哈希（否则老账号登录会被迫多算 1 次派生，
      反而又把登录也拖爆）。

   存储格式：pbkdf2$<迭代次数>$<base64url 盐>$<base64url 派生密钥>
     - 迭代次数写进串里，将来调高也不影响老用户登录
     - 盐 16 字节随机、每条独立
     - 派生密钥 32 字节

   ♻️ 兼容旧 bcrypt：
     换算法前注册的账号，库里存的是 $2b$10$... 开头的 bcrypt 串。
     verifyPassword() 会自动识别前缀走 bcrypt 比对，
     老用户照样能登录；下次改密码时自动升级成 PBKDF2。
   ============================================================ */

import bcrypt from 'bcryptjs';

/** 默认迭代次数。
 *  选 25000 的考量（2026-10-07）：改密码路径要算 2 次派生，
 *  2 × 25000 ≈ 9.1ms，稳稳低于 Workers 免费版 10ms CPU 上限；
 *  同时仍远高于「在线爆破」的可行成本（有登录限流兜底）。
 *  若线上仍偶发 1102，可继续下调到 20000 / 15000。 */
export const ITERATIONS = 25000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

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

/** 生成密码哈希 */
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

/**
 * 校验密码。
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

  /* 新格式：pbkdf2$iterations$salt$hash */
  const parts = s.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
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

/**
 * 这个哈希串是否需要升级（仅 bcrypt → pbkdf2 这种「算法」层面的升级）。
 *
 * ⚠️ 2026-10-07 第二十七轮重要约束：
 *    绝不能因为「迭代次数偏低」就触发重哈希。
 *    原因：登录流程是「校验原密码（1 次派生）+ 升级写回（第 2 次派生）」，
 *    对仍存着 50000 次老哈希的账号，登录一旦触发重哈希就会变成 2 次派生，
 *    合计 ≈ 14ms 直接超 10ms CPU 上限 → 登录也跟着 500。
 *    所以这里只认「算法是否还是 bcrypt」，迭代次数差异一律忽略，
 *    老账号保持 1 次派生登录，平稳过渡。
 */
export function needsRehash(stored) {
  const s = String(stored || '');
  if (/^\$2[aby]\$/.test(s)) return true;
  const parts = s.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return true;
  return false;
}

/* ---------------- SHA-256（用于会话 token 哈希存储） ----------------
   会话表 sessions.token 不再存明文 token，改存 sha256(token)。
   这样即便数据库被拖库，拿到的也只是不可逆的哈希，无法伪造登录态。
   查询时先把客户端传来的明文 token 哈希再比对主键。 */

export async function sha256Hex(str) {
  const data = new TextEncoder().encode(String(str));
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 假哈希（用于「用户不存在时也走一次比对」）。
 * 必须是一条**合法的 PBKDF2 串**，否则 verifyPassword 会快速返回，
 * 时序防护就失效了（历史上踩过坑：旧的假 bcrypt 串是 66 位非法长度，
 * bcryptjs 直接返回 false 不做计算）。
 */
export const DECOY_HASH =
  'pbkdf2$25000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
