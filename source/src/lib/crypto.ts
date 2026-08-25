/**
 * 前端安全工具：哈希对比 + 简单混淆加密
 *
 * 说明：
 * - 学习资料答案、联系人姓名：以「盐 + 输入」做 SHA-256 哈希后与存储值对比，
 *   静态源码中不出现明文答案 / 名单。
 * - 联系方式（微信号、电话）：以 XOR + Base64 混淆存储，查询命中后解密显示，
 *   源码中不直接暴露联系方式明文。
 * - 前端纯静态应用的加密强度有限，目的是避免「抓后台源码直接看到明文」，
 *   兼顾微信/QQ 内直接可用（无需后端）。
 */

/* 盐：修改答案/名单后若需旧记录失效，可同时改盐 */
export const GATE_SALT = 'cls2505-gate-salt'
export const CONTACT_SALT = 'cls2505-contact-salt'

/* 联系方式混淆密钥 */
const XOR_KEY = 'cls2505-xor-key-2026'

/* ---------- SHA-256（同步实现，兼容所有浏览器与本地打开） ---------- */
function sha256Raw(latin1: string): string {
  const rightRotate = (v: number, amt: number) => (v >>> amt) | (v << (32 - amt))
  const mathPow = Math.pow
  const maxWord = mathPow(2, 32)
  let result = ''
  const words: number[] = []
  const asciiBitLength = latin1.length * 8
  let hash = ((sha256Raw as unknown as Record<string, unknown>).h as number[]) || []
  const k = ((sha256Raw as unknown as Record<string, unknown>).k as number[]) || []
  let primeCounter = k.length
  const isComposite: Record<number, number> = {}
  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (let i = 0; i < 313; i += candidate) isComposite[i] = candidate
      hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0
      k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0
    }
  }
  ;(sha256Raw as unknown as Record<string, unknown>).h = hash
  ;(sha256Raw as unknown as Record<string, unknown>).k = k
  latin1 += '\x80'
  while (latin1.length % 64 - 56) latin1 += '\x00'
  for (let i = 0; i < latin1.length; i++) {
    const j = latin1.charCodeAt(i)
    if (j >> 8) return '' // 仅支持 Latin1（调用前已转码）
    words[i >> 2] |= j << (((3 - i) % 4) * 8)
  }
  words[words.length] = (asciiBitLength / maxWord) | 0
  words[words.length] = asciiBitLength
  for (let j = 0; j < words.length; ) {
    const w = words.slice(j, (j += 16))
    const oldHash = hash.slice(0)
    hash = hash.slice(0, 8)
    for (let i = 0; i < 64; i++) {
      const w15 = w[i - 15]
      const w2 = w[i - 2]
      const a = hash[0]
      const e = hash[4]
      const temp1 =
        hash[7] +
        (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) +
        ((e & hash[5]) ^ (~e & hash[6])) +
        k[i] +
        (w[i] =
          i < 16
            ? w[i]
            : (w[i - 16] +
                (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) +
                w[i - 7] +
                (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) |
              0)
      const temp2 =
        (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) +
        ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]))
      hash = [(temp1 + temp2) | 0].concat(hash)
      hash[4] = (hash[4] + temp1) | 0
    }
    for (let i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0
  }
  for (let i = 0; i < 8; i++) {
    for (let j = 3; j + 1; j--) {
      const b = (hash[i] >> (j * 8)) & 255
      result += (b < 16 ? '0' : '') + b.toString(16)
    }
  }
  return result
}

/** 任意字符串 → UTF-8 → SHA-256 十六进制（同步） */
export function sha256Hex(input: string): string {
  return sha256Raw(unescape(encodeURIComponent(input)))
}

/** 答案/姓名哈希：盐 + 规范化（去首尾空格、转小写）后哈希 */
export function hashSecret(value: string, salt: string): string {
  return sha256Hex(salt + '::' + value.trim().toLowerCase())
}

/* ---------- XOR + Base64 混淆（用于联系方式等 ASCII 内容） ---------- */
function toUtf8Bytes(str: string): number[] {
  const enc = new TextEncoder()
  return Array.from(enc.encode(str))
}

function bytesToUtf8(bytes: number[]): string {
  return new TextDecoder().decode(new Uint8Array(bytes))
}

function b64FromBytes(bytes: number[]): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function bytesFromB64(b64: string): number[] {
  const bin = atob(b64)
  const out: number[] = []
  for (let i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i))
  return out
}

/** 混淆加密（明文 → 密文） */
export function xorEncrypt(plain: string, key: string = XOR_KEY): string {
  const kb = toUtf8Bytes(key)
  const bytes = toUtf8Bytes(plain)
  for (let i = 0; i < bytes.length; i++) bytes[i] = bytes[i] ^ kb[i % kb.length]
  return b64FromBytes(bytes)
}

/** 解密（密文 → 明文） */
export function xorDecrypt(cipher: string, key: string = XOR_KEY): string {
  const kb = toUtf8Bytes(key)
  const bytes = bytesFromB64(cipher)
  for (let i = 0; i < bytes.length; i++) bytes[i] = bytes[i] ^ kb[i % kb.length]
  return bytesToUtf8(bytes)
}
