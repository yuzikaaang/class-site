/* ============================================================
   Workers 入口端到端测试
   ------------------------------------------------------------
   不用真 Neon，用 sql.js（SQLite 内存库）搭一个 SQL 桥接桩，
   把 Postgres 风格的模板查询翻译成 SQLite 执行。
   这样测的是**真实 SQL 流程**，不是硬编码返回值。

   覆盖：路由 / CORS / 注册 / 登录 / 限流 / 会话 / 数据读写 / 权限
   ============================================================ */

import initSqlJs from 'sql.js';
import crypto from 'crypto';

/* ---------- 1. 桥接环境变量 ---------- */
globalThis.__ENV__ = {
  ALLOW_ORIGINS: 'https://yuzikaaang.github.io',
  ADMIN_USERS: 'yuzikang',
  SESSION_DAYS: '30',
  ALLOW_REGISTER: '1',
  DATABASE_URL: 'postgres://stub',   // 实际不连，走桥接
};

/* ---------- 2. 起 SQLite 并建表（对应 schema.sql） ---------- */
const SQL = await initSqlJs();
const db = new SQL.Database();

db.run(`
create table users (
  id integer primary key autoincrement,
  username text not null unique,
  display_name text,
  password_hash text not null,
  role text not null default 'user',
  status text not null default 'active',
  created_at text not null default (datetime('now')),
  last_login_at text,
  failed_count integer not null default 0,
  locked_until text
);
create table sessions (
  token text primary key,
  user_id integer not null,
  created_at text not null default (datetime('now')),
  expires_at text not null
);
create table user_data (
  user_id integer not null,
  data_key text not null,
  data_value text,
  updated_at text not null default (datetime('now')),
  primary key (user_id, data_key)
);
create table audit_log (
  id integer primary key autoincrement,
  actor_id integer,
  action text not null,
  target_type text,
  target_id text,
  detail text,
  created_at text not null default (datetime('now'))
);
`);

/* ---------- 3.5 SQLite 兼容：补上 Postgres 有、SQLite 没有的函数 ---------- */
db.create_function('pg_unnest_probe', () => 1);

/* ---------- 3. 模板查询桥接 ----------
   业务代码写的是 sql`... ${a} ...`，这里收到的是 (strings, ...values)。
   把 $1 $2 换成 sqlite 的 ? ，并做几处 Postgres→SQLite 语法翻译。 */

let queryLog = [];

function translate(sqlText) {
  let s = sqlText;
  /* 此时占位符还是 $1 $2 的形式（PG_to_Q 在之后才跑），所以按 \$N 匹配。
     第一步：把 ( $N || ' days' )::interval 压成 datetime 参数片段 */
  s = s.replace(
    /now\(\)\s*\+\s*\(\s*\$(\d+)\s*\|\|\s*'\s*(\w+)\s*'\s*\)\s*::\s*interval/gi,
    (m, n, unit) => "datetime('now', '+' || $" + n + " || ' " + unit + "')"
  );
  /* 兜底：不带 now() + 前缀的裸 ( $N || 'x' )::interval */
  s = s.replace(
    /\(\s*\$(\d+)\s*\|\|\s*'\s*(\w+)\s*'\s*\)\s*::\s*interval/gi,
    (m, n, unit) => "($" + n + " || ' " + unit + "')"
  );
  /* 剩余 now() */
  s = s.replace(/\bnow\(\)/gi, "datetime('now')");
  /* 剥掉其余类型转换 */
  s = s.replace(/::\s*(int|integer|text|jsonb|boolean|bigint|timestamptz|interval)(\s*\[\s*\])?/gi, '');
  return s;
}

/** 把字符串里的 $1/$2 换成 ? （sql.js 只认 ?） */
function PG_to_Q(s) {
  return s.replace(/\$(\d+)/g, '?');
}

const sqlBridge = (strings, ...values) => {
  let text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? '$' + (i + 1) : ''), '');
  const translated = PG_to_Q(translate(text));
  queryLog.push({ sql: translated, values: values.map(v => typeof v) });

  return {
    then(resolve, reject) {
      try {
        /* ---- 特例：data.js 的 unnest 批量 upsert ----
           Postgres 写法：insert ... select $1, k, v::jsonb, now()
                          from unnest($2::text[], $3::text[]) as t(k, v)
                          on conflict (user_id, data_key) do update ...
           SQLite 无 unnest，这里按业务语义展开成逐条 upsert。
           注意：这是为了让测试桩能跑通，生产环境走真正的 Postgres unnest。 */
        if (/from\s+unnest\s*\(/i.test(translated)) {
          const userId = values[0];
          const keys = values[1];
          const vals = values[2];
          const stmt = db.prepare(
            `insert into user_data (user_id, data_key, data_value, updated_at)
             values (?, ?, ?, datetime('now'))
             on conflict (user_id, data_key)
             do update set data_value = excluded.data_value, updated_at = datetime('now')`
          );
          const n = Array.isArray(keys) ? keys.length : 0;
          for (let i = 0; i < n; i++) {
            stmt.run([userId, keys[i], vals[i]]);
          }
          stmt.free();
          resolve([]);
          return;
        }

        const stmt = db.prepare(translated);
        stmt.bind(values.map((v) => {
          if (v === undefined || v === null) return null;
          if (typeof v === 'boolean') return v ? 1 : 0;
          if (typeof v === 'object') return JSON.stringify(v);
          return v;
        }));
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        resolve(rows);
      } catch (e) {
        reject(new Error('SQL 失败: ' + e.message + '\n  SQL: ' + translated + '\n  值: ' + JSON.stringify(values)));
      }
    },
  };
};

globalThis.__LOCAL_SQL_BRIDGE__ = () => sqlBridge;

/* ---------- 4. 自定义 SQL 函数：lower() 已在 SQLite 内置 ---------- */

/* ---------- 5. 加载 Worker ---------- */
const worker = (await import('/tmp/class-site/api/worker.mjs')).default;

/* ---------- 6. 测试工具 ---------- */
let pass = 0, fail = 0;
const fails = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name); console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

const ORIGIN = 'https://yuzikaaang.github.io';
function req(path, { method = 'GET', body, token, origin = ORIGIN, headers = {} } = {}) {
  const url = 'https://api.example.workers.dev' + path;
  const h = { ...headers };
  if (origin) h.origin = origin;
  if (token) h.authorization = 'Bearer ' + token;
  if (body !== undefined) h['content-type'] = 'application/json';
  return new Request(url, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function call(path, opts) {
  const res = await worker.fetch(req(path, opts), globalThis.__ENV__, {});
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, body: json, text };
}

/* ============================================================
   开始测试
   ============================================================ */

console.log('\n【1】路由与 CORS');
{
  const r404 = await call('/api/nope');
  t('未知接口返回 404', r404.status === 404, '实际 ' + r404.status);
  t('404 响应带 CORS 头', r404.headers.get('access-control-allow-origin') === ORIGIN,
    '实际 ' + r404.headers.get('access-control-allow-origin'));
  t('404 返回 JSON 错误', r404.body && r404.body.ok === false);

  const pre = await call('/api/auth?action=login', { method: 'OPTIONS' });
  t('预检 OPTIONS 返回 204', pre.status === 204, '实际 ' + pre.status);
  t('预检带回显 Origin', pre.headers.get('access-control-allow-origin') === ORIGIN);

  const bad = await call('/api/auth?action=login', { method: 'POST', body: {}, origin: 'https://evil.com' });
  const allowHeader = bad.headers.get('access-control-allow-origin');
  t('非白名单来源不回显（防跨站盗用）', allowHeader !== 'https://evil.com',
    '实际 ' + allowHeader);
}

console.log('\n【2】注册（首个用户自动成为管理员）');
let adminToken = null;
{
  const r = await call('/api/auth?action=register', {
    method: 'POST',
    body: { username: 'yuzikang', password: 'MyStrongPass123', displayName: '余子康' },
  });
  t('注册成功', r.status === 200 && r.body.ok, JSON.stringify(r.body));
  t('首个用户成为管理员', r.body.user && r.body.user.role === 'admin', '角色 ' + (r.body.user||{}).role);
  t('返回会话 token', typeof r.body.token === 'string' && r.body.token.length === 64,
    '长度 ' + (r.body.token || '').length);
  t('响应不含密码哈希', !r.text.includes('password_hash') && !r.text.includes('pbkdf2$'));
  adminToken = r.body.token;

  const dup = await call('/api/auth?action=register', {
    method: 'POST', body: { username: 'yuzikang', password: 'Another123' },
  });
  t('重复用户名被拒', dup.status === 409, '实际 ' + dup.status);

  const weak = await call('/api/auth?action=register', {
    method: 'POST', body: { username: 'someone', password: '123' },
  });
  t('弱密码（<6位）被拒', weak.status === 400, '实际 ' + weak.status);

  const badName = await call('/api/auth?action=register', {
    method: 'POST', body: { username: 'a', password: 'GoodPass123' },
  });
  t('非法用户名被拒', badName.status === 400, '实际 ' + badName.status);
}

console.log('\n【3】登录');
let userToken = null;
{
  const r = await call('/api/auth?action=register', {
    method: 'POST', body: { username: 'chenxi', password: 'Student2026', displayName: '陈曦' },
  });
  t('普通用户注册成功', r.status === 200 && r.body.user.role === 'user', '角色 ' + (r.body.user||{}).role);
  userToken = r.body.token;

  const login = await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'chenxi', password: 'Student2026' },
  });
  t('正确密码登录成功', login.status === 200 && login.body.ok);

  const wrong = await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'chenxi', password: 'WrongPass999' },
  });
  t('错误密码被拒 401', wrong.status === 401, '实际 ' + wrong.status);

  const noUser = await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'ghost_user', password: 'Anything123' },
  });
  t('不存在的用户被拒 401', noUser.status === 401, '实际 ' + noUser.status);
  t('不存在的用户与错误密码返回同样提示（防用户名探测）',
    noUser.body.error === wrong.body.error,
    '"' + noUser.body.error + '" vs "' + wrong.body.error + '"');

  const upper = await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'CHENXI', password: 'Student2026' },
  });
  t('用户名大小写不敏感', upper.status === 200, '实际 ' + upper.status);
}

console.log('\n【4】登录限流（连续失败 5 次锁 15 分钟）');
{
  for (let i = 0; i < 5; i++) {
    await call('/api/auth?action=login', {
      method: 'POST', body: { username: 'chenxi', password: 'BadPass' + i },
    });
  }
  /* 确认失败计数与锁定时间确实落库（回归验证：这两个字段此前因
     new Date(字符串) 解析失败而静默失效） */
  const dbg = db.exec("select failed_count, locked_until from users where username='chenxi'");
  const st = dbg[0] ? dbg[0].values[0] : null;
  t('失败计数已累加到 5', st && Number(st[0]) === 5, JSON.stringify(st));
  t('锁定时间已写入库', st && !!st[1], JSON.stringify(st));

  const locked = await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'chenxi', password: 'Student2026' },
  });
  t('第 6 次尝试被锁定 429', locked.status === 429, '实际 ' + locked.status);
  t('锁定提示含分钟数', /分钟/.test(locked.body.error || ''), locked.body.error);
  t('锁定时即使密码正确也拒绝', locked.status === 429);
}

console.log('\n【5】会话与鉴权');
{
  const me = await call('/api/data', { method: 'GET', token: adminToken });
  t('带 token 可访问受保护接口', me.status === 200, '实际 ' + me.status);

  const noTok = await call('/api/data', { method: 'GET' });
  t('无 token 返回 401', noTok.status === 401, '实际 ' + noTok.status);

  const badTok = await call('/api/data', { method: 'GET', token: 'f'.repeat(64) });
  t('伪造 token 返回 401', badTok.status === 401, '实际 ' + badTok.status);

  const meInfo = await call('/api/auth?action=me', { method: 'GET', token: adminToken });
  t('me 接口返回用户信息', meInfo.status === 200 && meInfo.body.user.username === 'yuzikang');
  t('me 标识管理员身份', meInfo.body.isAdmin === true);
}

console.log('\n【6】数据云同步');
{
  const w = await call('/api/data', {
    method: 'PUT', token: adminToken,
    body: { items: { cls_theme: 'dark', cls_sfx: true } },
  });
  t('批量写入成功', w.status === 200 && w.body.written === 2, JSON.stringify(w.body));

  const r = await call('/api/data?key=cls_theme', { method: 'GET', token: adminToken });
  /* 注意：真实 Postgres 的 jsonb 列会自动反序列化成 JS 对象，读出就是 'dark'；
     测试桩是 SQLite，jsonb 退化成文本列，读出的字符串带一层 JSON 引号。
     两种都算通过，这里做兼容断言。 */
  const valTheme = r.body.value;
  const themeOk = valTheme === 'dark' || valTheme === '"dark"';
  t('按 key 读回正确', r.status === 200 && themeOk, JSON.stringify(r.body));

  const all = await call('/api/data', { method: 'GET', token: adminToken });
  t('读全部返回 2 条', all.body.count === 2, '实际 ' + all.body.count);

  const badKey = await call('/api/data', {
    method: 'PUT', token: adminToken, body: { items: { evil_key: 'x' } },
  });
  t('白名单外的 key 被拒', badKey.status === 400, '实际 ' + badKey.status);

  const d = await call('/api/data?key=cls_theme', { method: 'DELETE', token: adminToken });
  t('删除成功', d.status === 200);
  const after = await call('/api/data', { method: 'GET', token: adminToken });
  t('删除后只剩 1 条', after.body.count === 1, '实际 ' + after.body.count);

  // 用户隔离
  const other = await call('/api/data?key=cls_sfx', { method: 'GET', token: userToken });
  t('用户之间数据隔离（看不到别人的）', other.body.value === null, JSON.stringify(other.body));
}

console.log('\n【7】管理员权限');
{
  const deny = await call('/api/admin?action=users', { method: 'GET', token: userToken });
  t('普通用户访问 admin 返回 403', deny.status === 403, '实际 ' + deny.status);

  const allow = await call('/api/admin?action=users', { method: 'GET', token: adminToken });
  t('管理员可列用户', allow.status === 200, '实际 ' + allow.status);
  t('用户列表含 2 人', allow.body.users && allow.body.users.length === 2,
    '实际 ' + (allow.body.users || []).length);
  t('用户列表不泄露密码哈希',
    allow.body.users && allow.body.users.every(u => !('password_hash' in u) && !('passwordHash' in u)));
}

console.log('\n【8】beacon 通道');
{
  const beacon = await call('/api/data?action=beacon&t=' + adminToken, {
    method: 'POST', body: { key: 'cls_sfx', value: false },
  });
  t('beacon POST 写入成功', beacon.status === 200, JSON.stringify(beacon.body));

  const beaconGet = await call('/api/data?action=beacon&t=' + adminToken, { method: 'GET' });
  t('beacon 拒绝 GET（防 token 进日志）', beaconGet.status === 405, '实际 ' + beaconGet.status);

  const beaconNoTok = await call('/api/data?action=beacon', { method: 'POST', body: { key: 'cls_sfx', value: 1 } });
  t('beacon 无 token 被拒', beaconNoTok.status === 401, '实际 ' + beaconNoTok.status);
}

console.log('\n【9】登出');
{
  const out = await call('/api/auth?action=logout', { method: 'POST', token: userToken });
  t('登出成功', out.status === 200);
  const after = await call('/api/data', { method: 'GET', token: userToken });
  t('登出后 token 失效', after.status === 401, '实际 ' + after.status);
}

console.log('\n【10】方法限制');
{
  const g = await call('/api/auth?action=login', { method: 'GET' });
  t('登录接口拒绝 GET', g.status === 405, '实际 ' + g.status);
}

/* ---------- 汇总 ---------- */
console.log('\n' + '='.repeat(52));
console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败  (共 ' + (pass + fail) + ' 项)');
if (fail) { console.log('\n失败项:'); fails.forEach(f => console.log('  - ' + f)); }
console.log('实际执行 SQL 查询: ' + queryLog.length + ' 条');
console.log('='.repeat(52));
process.exit(fail ? 1 : 0);
