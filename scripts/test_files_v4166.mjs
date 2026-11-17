/* ============================================================================
 * v4.16.6 专项：一个取件码挂多个文件
 * ----------------------------------------------------------------------------
 * 直接用 mock KV 跑 api/files.js 的 handler，不碰线上数据。
 * 覆盖：逐个上传共用一码 / 逐文件改名 / 按 id 下载 / 取件只算一次 /
 *       取满作废 / 删除连字节一起清 / 单文件不带 id 直接下载 / 容量统计。
 * ========================================================================= */
import handler from '../api/files.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '  ' + JSON.stringify(extra === undefined ? '' : extra)); }
};

/* ---------------- mock KV ---------------- */
class MockKV {
  constructor() { this.m = new Map(); }
  async get(key, type) {
    const v = this.m.get(key);
    if (!v) return null;
    if (type === 'arrayBuffer') return v.buf ? v.buf.buffer.slice(v.buf.byteOffset, v.buf.byteOffset + v.buf.byteLength) : null;
    if (type === 'json') return v.val ? JSON.parse(v.val) : null;
    return v.val == null ? null : v.val;
  }
  async put(key, value, opts = {}) {
    const rec = { metadata: opts.metadata || null, exp: opts.expirationTtl || null };
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      rec.buf = value instanceof Uint8Array ? value : new Uint8Array(value);
      rec.val = '';
    } else {
      rec.val = String(value);
      rec.buf = null;
    }
    this.m.set(key, rec);
  }
  async delete(key) { this.m.delete(key); }
  async list({ prefix = '', limit = 1000 } = {}) {
    const keys = [];
    for (const [k, v] of this.m) {
      if (k.startsWith(prefix)) keys.push({ name: k, metadata: v.metadata });
      if (keys.length >= limit) break;
    }
    return { keys, list_complete: true };
  }
}

function mkRes() {
  const state = { statusCode: 200, headers: {}, body: null };
  const res = {
    get statusCode() { return state.statusCode; },
    set statusCode(v) { state.statusCode = v; },
    setHeader(k, v) { state.headers[String(k).toLowerCase()] = v; },
    getHeader(k) { return state.headers[String(k).toLowerCase()]; },
    end(b) { state.body = b; return res; },
  };
  return { res, state };
}
async function call(kv, { method = 'GET', query = {}, buf = null } = {}) {
  const req = { method, query, headers: {}, body: '', __rawBuf: buf, __env: { SITE_KV: kv } };
  const { res, state } = mkRes();
  await handler(req, res);
  let json = null;
  if (typeof state.body === 'string') { try { json = JSON.parse(state.body); } catch (e) { json = null; } }
  return { status: state.statusCode, headers: state.headers, body: state.body, json };
}
const bytesOf = (s) => new TextEncoder().encode(s);
const up = (kv, name, content, extra = {}) => call(kv, {
  method: 'POST',
  query: { action: 'upb', name, type: 'text/plain', ttl: '3', maxGet: '0', ...extra },
  buf: bytesOf(content),
});

/* ================= ① 三个文件共用一个取件码 ================= */
console.log('① 上传三个文件，共用一个取件码');
const kv = new MockKV();
const a = await up(kv, '语文笔记.txt', 'AAA');
ok('第一个文件建出取件码', a.status === 200 && /^[2-9A-HJ-NP-Z]{6}$/.test(a.json.code), a.json);
const code = a.json.code, delKey = a.json.delKey;
ok('第一个返回 1/1', a.json.count === 1 && a.json.index === 0, a.json);
const b = await up(kv, '数学卷.pptx', 'BBB', { code, delKey });
ok('第二个挂到同一个码', b.status === 200 && b.json.code === code, b.json);
ok('第二个返回 2/2', b.json.count === 2, b.json);
const c = await up(kv, '英语听力.mp3', 'CCC', { code, delKey });
ok('第三个也挂上', c.status === 200 && c.json.count === 3 && c.json.code === code, c.json);
ok('三次拿到的是三个不同 itemId', new Set([a.json.itemId, b.json.itemId, c.json.itemId]).size === 3,
  [a.json.itemId, b.json.itemId, c.json.itemId]);
ok('口令不对加不进去', (await up(kv, 'x.txt', 'x', { code, delKey: 'wrong' })).status === 403);
ok('码不存在时明确报错', (await up(kv, 'x.txt', 'x', { code: 'ZZZZZZ', delKey: 'k' })).status === 404);

/* ================= ② 取件（只算一次） ================= */
console.log('② 取件：一次算一次，票据能反复下这一批');
const p1 = await call(kv, { query: { action: 'pick', code } });
ok('pick 成功', p1.status === 200 && p1.json.ok, p1.json);
ok('拿到 3 个文件', Array.isArray(p1.json.items) && p1.json.items.length === 3, p1.json.items);
ok('文件名按上传时的样子', p1.json.items.map((x) => x.name).join('|') === '语文笔记.txt|数学卷.pptx|英语听力.mp3', p1.json.items);
ok('给了票据', typeof p1.json.ticket === 'string' && p1.json.ticket.length >= 12, p1.json.ticket);
ok('不限次数时 gets 保持 0', p1.json.gets === 0, p1.json.gets);
const tk = p1.json.ticket;
const pickCount = async () => Number((await kv.get('fbc:' + code)) || 0);
ok('不限次数不写计数键（省 KV 写）', (await pickCount()) === 0, await pickCount());

/* ================= ③ 逐个下载 + 改名 ================= */
console.log('③ 按 id 下载，文件名用改过之后的');
const d1 = await call(kv, { query: { code, id: c.json.itemId, tk } });
ok('第三个下下来是 CCC', d1.status === 200 && new TextDecoder().decode(d1.body) === 'CCC', d1.status);
ok('Content-Disposition 带原名', /filename\*=UTF-8''%E8%8B%B1%E8%AF%AD/.test(d1.headers['content-disposition']), d1.headers['content-disposition']);
/* ren 走 body，不是 query —— 直接发一次 */
const renRes = await (async () => {
  const req = {
    method: 'POST', query: { action: 'ren' }, headers: {},
    body: JSON.stringify({ code, delKey, id: c.json.itemId, name: '听力材料（第 3 单元）.mp3' }),
    __env: { SITE_KV: kv },
  };
  const { res, state } = mkRes();
  await handler(req, res);
  return { status: state.statusCode, json: JSON.parse(state.body || '{}') };
})();
ok('改名成功', renRes.status === 200 && renRes.json.ok, renRes.json);
const d2 = await call(kv, { query: { code, id: c.json.itemId, tk } });
const cd2 = d2.headers['content-disposition'] || '';
ok('再下载用的是新名字', /%E5%90%AC%E5%8A%9B%E6%9D%90%E6%96%99/.test(cd2), cd2);
ok('带票据反复下载不写计数键', (await pickCount()) === 0, await pickCount());

/* ================= ④ 不带 id 打开 ================= */
console.log('④ 不带 id：单个直接下，多个给列表页');
const multi = await call(kv, { query: { code } });
ok('多个文件时返回列表页', multi.status === 200 && /text\/html/.test(multi.headers['content-type'] || ''), multi.headers['content-type']);
ok('列表页里有 3 个文件名', ['语文笔记.txt', '数学卷.pptx', '听力材料（第 3 单元）.mp3'].every((n) => String(multi.body).includes(n)), '');
/* HTML 里 & 会写成 &amp;（合法转义），所以只看参数名在不在 */
ok('列表页链接带 id 和票据', /[?&]amp;id=/.test(String(multi.body)) && /[?&]amp;tk=/.test(String(multi.body)));

const mb1 = await call(kv, { query: { code, meta: '1' } });
ok('meta 给旧页面留了 name / size', mb1.json.name === '语文笔记.txt' && mb1.json.size === 9, [mb1.json.name, mb1.json.size]);

const kv2 = new MockKV();
const one = await up(kv2, '单件.pdf', 'PDF');
const solo = await call(kv2, { query: { code: one.json.code } });
ok('单文件不带 id 直接下字节', solo.status === 200 && new TextDecoder().decode(solo.body) === 'PDF', solo.status);

/* ================= ⑤ 取满作废 ================= */
console.log('⑤ 设了「可取 1 次」：取一次还能下，再取就作废');
const kv3 = new MockKV();
const m1 = await up(kv3, '限一次.txt', 'ONCE', { maxGet: '1' });
const code3 = m1.json.code;
const q1 = await call(kv3, { query: { action: 'pick', code: code3 } });
ok('第一次取到', q1.status === 200 && q1.json.left === 0, q1.json);
const dl3 = await call(kv3, { query: { code: code3, id: m1.json.itemId, tk: q1.json.ticket } });
ok('拿着票据仍然能下', dl3.status === 200 && new TextDecoder().decode(dl3.body) === 'ONCE');
const q2 = await call(kv3, { query: { action: 'pick', code: code3 } });
ok('第二次取件被拒（410）', q2.status === 410, q2.status);
ok('作废后字节也清掉了', (await kv3.get('fbi:' + code3 + ':' + m1.json.itemId)) === null);

/* ================= ⑥ 删除 ================= */
console.log('⑥ 删除：连文件字节一起清');
const kv4 = new MockKV();
const x1 = await up(kv4, 'a.txt', 'A');
const x2 = await up(kv4, 'b.txt', 'B', { code: x1.json.code, delKey: x1.json.delKey });
const preKeys = [...kv4.m.keys()].filter((k) => k.includes(x1.json.code));
ok('删之前有 2 个文件 + 元数据', preKeys.length >= 3, preKeys);
const del = await (async () => {
  const req = {
    method: 'POST', query: { action: 'del' }, headers: {},
    body: JSON.stringify({ code: x1.json.code, delKey: x1.json.delKey }),
    __env: { SITE_KV: kv4 },
  };
  const { res, state } = mkRes();
  await handler(req, res);
  return { status: state.statusCode, json: JSON.parse(state.body || '{}') };
})();
ok('删除成功', del.status === 200 && del.json.deleted, del.json);
ok('删完一个键都不剩', [...kv4.m.keys()].filter((k) => k.includes(x1.json.code)).length === 0);
ok('再取就是 404', (await call(kv4, { query: { action: 'pick', code: x1.json.code } })).status === 404);

/* ================= ⑦ 容量统计 ================= */
console.log('⑦ 容量：按批次总大小算，不重复计');
const kv5 = new MockKV();
const s1 = await up(kv5, 'big1.txt', 'x'.repeat(1000));
await up(kv5, 'big2.txt', 'y'.repeat(2000), { code: s1.json.code, delKey: s1.json.delKey });
const quota = await call(kv5, { query: { action: 'quota' } });
ok('已用 ≈ 3000 字节', quota.json.used === 3000, quota.json);
ok('件数按批次算 1 件', quota.json.count === 1, quota.json);

/* ================= ⑧ 上限 ================= */
console.log('⑧ 一个码最多 20 个文件');
const kv6 = new MockKV();
const first6 = await up(kv6, 'f0.txt', '0');
let last = first6;
for (let i = 1; i < 20; i++) {
  last = await up(kv6, 'f' + i + '.txt', String(i), { code: first6.json.code, delKey: first6.json.delKey });
}
ok('第 20 个还能加', last.status === 200 && last.json.count === 20, last.json && last.json.count);
const over = await up(kv6, 'f20.txt', '20', { code: first6.json.code, delKey: first6.json.delKey });
ok('第 21 个被拦下', over.status === 400, over.status);

/* ================= ⑨ 老记录仍然能取 ================= */
console.log('⑨ 老格式（单件 / 文本）不受影响');
const kv7 = new MockKV();
const oldCode = 'ABC234';
const oldAt = Date.now();
await kv7.put('b:' + oldCode, bytesOf('OLD'), { metadata: { size: 3, at: oldAt, kind: 'file' } });
await kv7.put('fm:' + oldCode, JSON.stringify({
  v: 2, kind: 'file', name: '老文件.pdf', type: 'application/pdf', size: 3, at: oldAt,
  exp: oldAt + 3 * 86400000, ttl: 3, maxGet: 0, memo: '', del: 'oldkey',
}), { metadata: { size: 3, at: oldAt, kind: 'file' } });
const op = await call(kv7, { query: { action: 'pick', code: oldCode } });
ok('老记录也能取件', op.status === 200 && op.json.ok, op.json);
ok('老记录给一条 items', op.json.items && op.json.items.length === 1, op.json.items);
ok('老记录文件名照旧', op.json.items[0].name === '老文件.pdf', op.json.items[0]);
const od = await call(kv7, { query: { code: oldCode } });
ok('老记录不带 id 直接下载', od.status === 200 && new TextDecoder().decode(od.body) === 'OLD', od.status);
const om = await call(kv7, { query: { code: oldCode, meta: '1' } });
ok('meta=1 仍是老结构（给缓存的旧页面用）', om.json.kind === 'file' && om.json.name === '老文件.pdf', om.json);

const kv8 = new MockKV();
const tCode = 'TXT234';
await kv8.put('f:' + tCode, JSON.stringify({
  kind: 'text', name: '文本 1', type: 'text/plain', size: 5, text: 'hello',
  at: oldAt, exp: oldAt + 86400000, del: 'tk', ttl: 1, maxGet: 0, memo: '',
}), { metadata: { size: 5, at: oldAt, kind: 'text' } });
const tp = await call(kv8, { query: { action: 'pick', code: tCode } });
ok('老文本取件返回 kind=text', tp.json.kind === 'text', tp.json.kind);
ok('老文本内容带回来', tp.json.text === 'hello', tp.json.text);

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
