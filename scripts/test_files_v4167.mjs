/* ============================================================================
 * v4.16.7 专项：自定义取件码 / 上传归属与管理端
 * ----------------------------------------------------------------------------
 * 直接用 mock KV 跑 api/files.js 的 handler，不碰线上数据。
 * 覆盖：自定义码格式与查重 / owner+edit 落库 / 管理端 list 分组字段 /
 *       admin-edit 改名·改次数·改天数·改码 / edit=false 只读 / 鉴权。
 * ========================================================================= */
import handler from '../api/files.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '  ' + JSON.stringify(extra === undefined ? '' : extra)); }
};

class MockKV {
  constructor() { this.m = new Map(); }
  async get(key, type) {
    const v = this.m.get(key);
    if (!v) return null;
    if (v.expAt && v.expAt < Date.now()) return null;
    if (type === 'arrayBuffer') return v.buf ? v.buf.buffer.slice(v.buf.byteOffset, v.buf.byteOffset + v.buf.byteLength) : null;
    if (type === 'json') return v.val ? JSON.parse(v.val) : null;
    return v.val == null ? null : v.val;
  }
  async put(key, value, opts = {}) {
    const rec = { metadata: opts.metadata || null };
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      rec.buf = value instanceof Uint8Array ? value : new Uint8Array(value);
      rec.val = '';
    } else {
      rec.val = String(value);
      rec.buf = null;
    }
    if (opts.expirationTtl) rec.expAt = Date.now() + opts.expirationTtl * 1000;
    this.m.set(key, rec);
  }
  async delete(key) { this.m.delete(key); }
  async list({ prefix = '', limit = 1000, cursor } = {}) {
    const keys = [];
    for (const [k, v] of this.m) {
      if (v.expAt && v.expAt < Date.now()) continue;
      if (k.startsWith(prefix)) keys.push({ name: k, metadata: v.metadata });
      if (keys.length >= limit) break;
    }
    return { keys, list_complete: true };
  }
}
function mkRes() {
  const state = { statusCode: 200, headers: {}, body: null };
  const res = {
    get statusCode() { return state.statusCode; }, set statusCode(v) { state.statusCode = v; },
    setHeader(k, v) { state.headers[String(k).toLowerCase()] = v; },
    getHeader(k) { return state.headers[String(k).toLowerCase()]; },
    end(b) { state.body = b; return res; },
  };
  return { res, state };
}
async function call(kv, { method = 'GET', query = {}, buf = null, jsonBody = null, testAdmin = true } = {}) {
  const req = {
    method, query, headers: {}, body: jsonBody ? JSON.stringify(jsonBody) : '',
    __rawBuf: buf, __env: { SITE_KV: kv, ...(testAdmin ? { TEST_ADMIN: true } : {}) },
  };
  const { res, state } = mkRes();
  await handler(req, res);
  let json = null;
  if (typeof state.body === 'string') { try { json = JSON.parse(state.body); } catch (e) { json = null; } }
  return { status: state.statusCode, headers: state.headers, body: state.body, json };
}
const bytesOf = (s) => new TextEncoder().encode(s);
const up = (kv, name, content, extra = {}) => call(kv, {
  method: 'POST', query: { action: 'upb', name, type: 'text/plain', ttl: '3', maxGet: '0', ...extra }, buf: bytesOf(content),
});

/* ================= ① 自定义取件码格式与查重 ================= */
console.log('① 自定义取件码格式与查重');
const kv = new MockKV();
ok('两位大写字母可用', (await call(kv, { query: { action: 'code-check', code: 'AB2345' } })).json.free === true);
ok('全是数字不可用', (await call(kv, { query: { action: 'code-check', code: '123456' } })).json.free === false);
ok('只有一位大写不可用', (await call(kv, { query: { action: 'code-check', code: 'A23456' } })).json.free === false);
ok('含易混字符 O 不可用', (await call(kv, { query: { action: 'code-check', code: 'AB23O5' } })).json.free === false);
ok('长度不对不可用', (await call(kv, { query: { action: 'code-check', code: 'ABC' } })).json.free === false);
ok('小写自动转大写判定', (await call(kv, { query: { action: 'code-check', code: 'ab2345' } })).json.free === true);
const up1 = await up(kv, 'a.txt', 'aaa', { custom: 'AB2345', owner: '张三', edit: '1' });
ok('自定义码上传成功', up1.status === 200 && up1.json.code === 'AB2345', up1.json);
ok('上传返回归属与开关', up1.json.owner === '张三' && up1.json.edit === true, up1.json);
ok('占用后查重报已占用', (await call(kv, { query: { action: 'code-check', code: 'AB2345' } })).json.free === false);
const upDup = await up(kv, 'b.txt', 'bbb', { custom: 'AB2345' });
ok('重复码上传被拒 409', upDup.status === 409, upDup.json);
const upBad = await up(kv, 'c.txt', 'ccc', { custom: '123456' });
ok('非法自定义码上传被拒 400', upBad.status === 400, upBad.json);

/* ================= ② edit=0 的批次落库 ================= */
console.log('② edit=0 关闭管理员编辑');
const up2 = await up(kv, '私密.txt', 'ppp', { custom: 'CD5678', owner: '李四', edit: '0' });
ok('edit=0 落库', up2.status === 200 && up2.json.edit === false, up2.json);

/* ================= ③ 管理端 list ================= */
console.log('③ 管理端总览');
const list = await call(kv, { query: { action: 'admin-list' } });
ok('list 需要管理员（无 token 真鉴权会 401）', list.status === 200 && Array.isArray(list.json.list));
ok('列出两条', list.json.list.length >= 2, list.json.list.length);
const rowZhang = list.json.list.find((x) => x.code === 'AB2345');
const rowLi = list.json.list.find((x) => x.code === 'CD5678');
ok('张三那条带 owner/edit', rowZhang && rowZhang.owner === '张三' && rowZhang.edit === true, rowZhang);
ok('李四那条 edit=false', rowLi && rowLi.edit === false, rowLi);
ok('每条带文件明细', rowZhang && rowZhang.files && rowZhang.files[0].name === 'a.txt', rowZhang);
const noAuth = await call(kv, { query: { action: 'admin-list' }, testAdmin: false });
ok('无管理员 token 被拦', noAuth.status === 401, noAuth.json);

/* ================= ④ admin-edit 改名/次数/天数 ================= */
console.log('④ 管理端改名·改次数·改天数');
const eName = await call(kv, { method: 'POST', query: { action: 'admin-edit' }, jsonBody: { code: 'AB2345', op: 'name', id: up1.json.itemId, name: '语文.txt' } });
ok('改名成功', eName.status === 200 && eName.json.name === '语文.txt', eName.json);
const pickAfter = await call(kv, { query: { action: 'pick', code: 'AB2345' } });
ok('取件看到改名后的名字', pickAfter.json.items[0].name === '语文.txt', pickAfter.json.items);
const eMax = await call(kv, { method: 'POST', query: { action: 'admin-edit' }, jsonBody: { code: 'AB2345', op: 'max', maxGet: '5' } });
ok('改次数成功', eMax.status === 200 && eMax.json.maxGet === 5, eMax.json);
const eTtl = await call(kv, { method: 'POST', query: { action: 'admin-edit' }, jsonBody: { code: 'AB2345', op: 'ttl', ttl: '7' } });
ok('改天数成功', eTtl.status === 200 && eTtl.json.ttl === 7, eTtl.json);
const eLocked = await call(kv, { method: 'POST', query: { action: 'admin-edit' }, jsonBody: { code: 'CD5678', op: 'name', name: '偷改.txt' } });
ok('edit=false 禁止改名', eLocked.status === 403, eLocked.json);

/* ================= ⑤ 改码迁移文件 ================= */
console.log('⑤ 管理端改取件码');
const eCode = await call(kv, { method: 'POST', query: { action: 'admin-edit' }, jsonBody: { code: 'AB2345', op: 'recode', newCode: 'ZZ8899' } });
ok('改码成功', eCode.status === 200 && eCode.json.code === 'ZZ8899', eCode.json);
const pickNew = await call(kv, { query: { action: 'pick', code: 'ZZ8899' } });
ok('新码能取到文件', pickNew.status === 200 && pickNew.json.items[0].name === '语文.txt', pickNew.json);
const pickOld = await call(kv, { query: { action: 'pick', code: 'AB2345' } });
ok('旧码作废', pickOld.status === 404, pickOld.json);
const dl = await call(kv, { query: { code: 'ZZ8899', id: pickNew.json.items[0].id } });
ok('新码下载到原内容', dl.status === 200 && Buffer.from(dl.body).toString() === 'aaa', dl.status);
const eCodeDup = await call(kv, { method: 'POST', query: { action: 'admin-edit' }, jsonBody: { code: 'ZZ8899', op: 'recode', newCode: 'CD5678' } });
ok('改成已占用的码被拒', eCodeDup.status === 409, eCodeDup.json);

/* ================= ⑥ 文本走自定义码 + 归属 ================= */
console.log('⑥ 文本也支持自定义码与归属');
const txt = await call(kv, {
  method: 'POST', query: { action: 'text' },
  jsonBody: { text: '作业答案', custom: 'TX6688', owner: '王五', ttl: 3, maxGet: 0 },
});
ok('文本自定义码成功', txt.status === 200 && txt.json.code === 'TX6688', txt.json);
ok('文本带归属', txt.json.owner === '王五', txt.json);
const pickTxt = await call(kv, { query: { action: 'pick', code: 'TX6688' } });
ok('文本能取回', pickTxt.status === 200 && pickTxt.json.kind === 'text', pickTxt.json);

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
