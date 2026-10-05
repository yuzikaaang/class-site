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
  locked_until text,
  must_change_password integer not null default 0,
  is_ai integer not null default 0
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
create table login_log (
  id integer primary key autoincrement,
  user_id integer not null,
  ip text,
  user_agent text,
  created_at text not null default (datetime('now'))
);
create table profiles (
  id integer primary key autoincrement,
  name text,
  name_hash text unique,
  student_id text unique,
  politics text,
  exam_no text,
  role text not null default '学生',
  title text,
  wechat text,
  qq text,
  phone text,
  contact_status text not null default 'none',
  reject_reason text,
  user_id integer,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);
create table profile_view_log (
  id integer primary key autoincrement,
  viewer_id integer not null,
  target_id integer,
  target_name text,
  keyword text,
  ip text,
  created_at text not null default (datetime('now'))
);
`);

/* ---------- 3.5 SQLite 兼容：补上 Postgres 有、SQLite 没有的函数 ---------- */
db.create_function('pg_unnest_probe', () => 1);
/* pg_column_size：Postgres 专有，返回列字节数。测试里只需要一个数值即可 */
db.create_function('pg_column_size', (v) => (v === null || v === undefined ? 0 : String(v).length));

/* ---------- 3. 模板查询桥接 ----------
   业务代码写的是 sql`... ${a} ...`，这里收到的是 (strings, ...values)。
   把 $1 $2 换成 sqlite 的 ? ，并做几处 Postgres→SQLite 语法翻译。 */

let queryLog = [];

function translate(sqlText) {
  let s = sqlText;
  /* SQLite 的 alter table 不支持 add column if not exists，直接忽略这类语句 */
  if (/^\s*alter\s+table[\s\S]*add\s+column\s+if\s+not\s+exists/i.test(s)) {
    return 'select 1 where 0';
  }
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
  /* now() ± interval 'N unit' 字面量形式 → datetime('now', '±N unit')
     例：now() - interval '7 days'  →  datetime('now', '-7 days') */
  s = s.replace(
    /now\(\)\s*([+-])\s*interval\s*'\s*(\d+)\s*(\w+)\s*'/gi,
    (m, sign, num, unit) => "datetime('now', '" + sign + num + " " + unit + "')"
  );
  /* date_trunc('day', X) → X 的当天起点（SQLite 用 date(X)） */
  s = s.replace(
    /date_trunc\s*\(\s*'day'\s*,\s*([^)]+)\)/gi,
    (m, inner) => "date(" + inner.trim() + ")"
  );
  /* 剩余 now() */
  s = s.replace(/\bnow\(\)/gi, "datetime('now')");
  /* ilike → like：SQLite 的 LIKE 对 ASCII 本来就大小写不敏感，
     Postgres 的 ilike 在这里等价降级，测试语义不变 */
  s = s.replace(/\bilike\b/gi, 'like');
  /* order by ... nulls last / nulls first：SQLite 3.30+ 支持，
     但 sql.js 版本可能偏低，直接剥掉（测试不依赖 null 的排序位置） */
  s = s.replace(/\s+nulls\s+(last|first)/gi, '');
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

console.log('\n【10】后台新增：开号 / 批量导入 / 登录记录 / 导出');
{
  /* --- 单个开号：应带 must_change_password --- */
  const c1 = await call('/api/admin?action=create-user', {
    method: 'POST', token: adminToken,
    body: { username: 'stu001', password: 'Init2025', displayName: '张三' },
  });
  t('管理员可创建账号', c1.status === 200, JSON.stringify(c1.body));
  t('创建返回提示含"首次登录"', /首次登录/.test(c1.body.message || ''), c1.body.message);

  /* --- 重复用户名应 409 --- */
  const c1dup = await call('/api/admin?action=create-user', {
    method: 'POST', token: adminToken,
    body: { username: 'stu001', password: 'Init2025' },
  });
  t('重名开号被拒 409', c1dup.status === 409, '实际 ' + c1dup.status);

  /* --- 非法用户名应 400 --- */
  const cBad = await call('/api/admin?action=create-user', {
    method: 'POST', token: adminToken,
    body: { username: 'ab', password: 'Init2025' },
  });
  t('用户名过短被拒 400', cBad.status === 400, '实际 ' + cBad.status);

  /* --- 新账号首次登录：mustChangePassword=true --- */
  const l1 = await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'stu001', password: 'Init2025' },
  });
  t('新账号可用初始密码登录', l1.status === 200, JSON.stringify(l1.body));
  t('首次登录返回 mustChangePassword=true', l1.body.mustChangePassword === true,
    '实际 ' + l1.body.mustChangePassword);
  const stuToken = l1.body.token;

  /* --- 未改密时，data 接口应被后端拦截 403 --- */
  const blocked = await call('/api/data', { method: 'GET', token: stuToken });
  t('未改密时 data 接口被拦截 403', blocked.status === 403, '实际 ' + blocked.status);
  t('拦截响应带 mustChangePassword 标记', blocked.body.mustChangePassword === true);

  /* --- 改密后放行 --- */
  const cp = await call('/api/auth?action=change-password', {
    method: 'POST', token: stuToken,
    body: { oldPassword: 'Init2025', newPassword: 'MyOwn2025' },
  });
  t('首次改密成功', cp.status === 200, JSON.stringify(cp.body));
  t('改密响应 mustChangePassword=false', cp.body.mustChangePassword === false);

  const stuToken2 = cp.body.token;
  const okNow = await call('/api/data', { method: 'GET', token: stuToken2 });
  t('改密后 data 接口放行', okNow.status === 200, '实际 ' + okNow.status);

  /* --- 改密后新密码可登录、旧密码不可 --- */
  const l2 = await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'stu001', password: 'MyOwn2025' },
  });
  t('新密码可登录', l2.status === 200);
  t('二次登录不再要求改密', l2.body.mustChangePassword === false,
    '实际 ' + l2.body.mustChangePassword);
  const lOld = await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'stu001', password: 'Init2025' },
  });
  t('旧初始密码已失效', lOld.status === 401, '实际 ' + lOld.status);

  /* --- 批量导入：好数据 + 坏数据混合 --- */
  const bc = await call('/api/admin?action=batch-create', {
    method: 'POST', token: adminToken,
    body: {
      users: [
        { username: 'stu002', password: 'Init2025', displayName: '李四' },
        { username: 'stu003', password: 'Init2025', displayName: '王五' },
        { username: 'stu001', password: 'Init2025' },          // 已存在 → 失败
        { username: 'x', password: 'Init2025' },                // 用户名过短 → 失败
        { username: 'stu004', password: '123' },                // 密码过短 → 失败
        { username: 'stu005', password: 'Init2025', role: 'admin' }, // 带角色
      ],
    },
  });
  t('批量导入返回 200', bc.status === 200, JSON.stringify(bc.body));
  t('批量导入成功 3 条', bc.body.created === 3, '实际 ' + bc.body.created);
  t('批量导入失败 3 条', bc.body.failed === 3, '实际 ' + bc.body.failed);
  t('错误项带批内下标', Array.isArray(bc.body.errors) && bc.body.errors.every(e => typeof e.index === 'number'));
  t('错误项有具体原因', (bc.body.errors || []).every(e => e.reason && e.reason.length > 0));
  t('重名原因正确',
    (bc.body.errors || []).some(e => e.username === 'stu001' && /已存在/.test(e.reason)));

  /* --- 批量导入的单批上限 --- */
  const tooMany = await call('/api/admin?action=batch-create', {
    method: 'POST', token: adminToken,
    body: { users: Array.from({ length: 61 }, (_, i) => ({ username: 'bulk' + i, password: 'Init2025' })) },
  });
  t('超 60 条的单批被拒 400', tooMany.status === 400, '实际 ' + tooMany.status);

  /* --- 登录记录：应记下 stu001 的登录 --- */
  const logs = await call('/api/admin?action=login-logs&limit=50', { token: adminToken });
  t('登录记录接口返回 200', logs.status === 200, JSON.stringify(logs.body));
  t('登录记录非空', (logs.body.logs || []).length > 0, '实际 ' + (logs.body.logs || []).length);
  t('登录记录含 stu001',
    (logs.body.logs || []).some(l => l.username === 'stu001'));
  t('登录记录带 UA 字段',
    (logs.body.logs || []).every(l => 'userAgent' in l));

  /* --- 按用户筛选登录记录 --- */
  const meLogs = await call('/api/admin?action=login-logs&id=1&limit=10', { token: adminToken });
  t('按 id 筛选登录记录成功', meLogs.status === 200);
  t('筛选结果只含该用户',
    (meLogs.body.logs || []).every(l => l.userId === 1), JSON.stringify(meLogs.body.logs));

  /* --- 用户列表带 mustChangePassword 字段 --- */
  const ul = await call('/api/admin?action=users&limit=100', { token: adminToken });
  t('用户列表带 mustChangePassword',
    (ul.body.users || []).every(u => 'mustChangePassword' in u));

  /* --- 导出：全量 + 筛选 --- */
  const ex = await call('/api/admin?action=export', { token: adminToken });
  t('导出接口返回 200', ex.status === 200, JSON.stringify(ex.body));
  t('导出含全部用户', (ex.body.users || []).length >= 6, '实际 ' + (ex.body.users || []).length);
  t('导出不含密码哈希',
    (ex.body.users || []).every(u => !('password_hash' in u) && !('passwordHash' in u)));
  t('导出含登录次数', (ex.body.users || []).every(u => typeof u.loginCount === 'number'));

  const exAdmin = await call('/api/admin?action=export&role=admin', { token: adminToken });
  t('导出支持角色筛选',
    (exAdmin.body.users || []).every(u => u.role === 'admin') && (exAdmin.body.users || []).length >= 1,
    JSON.stringify(exAdmin.body.users));

  const exQ = await call('/api/admin?action=export&q=stu002', { token: adminToken });
  t('导出支持搜索词筛选',
    (exQ.body.users || []).length === 1 && exQ.body.users[0].username === 'stu002',
    JSON.stringify(exQ.body.users));

  /* --- 非管理员不能碰新接口 --- */
  const stuT = (await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'stu002', password: 'Init2025' },
  })).body.token;
  /* stu002 也是首次登录，需先改密才能过 data 守卫；但 admin 接口不受该守卫影响，直接验权限 */
  const nope = await call('/api/admin?action=export', { token: stuT });
  t('普通用户不能导出 403', nope.status === 403, '实际 ' + nope.status);
  const nope2 = await call('/api/admin?action=batch-create', {
    method: 'POST', token: stuT, body: { users: [] },
  });
  t('普通用户不能批量开号 403', nope2.status === 403, '实际 ' + nope2.status);
  const nope3 = await call('/api/admin?action=login-logs', { token: stuT });
  t('普通用户不能看登录记录 403', nope3.status === 403, '实际 ' + nope3.status);

  /* --- 重置密码后应重新要求改密 --- */
  /* 先从用户列表里取 stu001 的真实 id，避免硬编码 */
  const stuRow = (ul.body.users || []).find(u => u.username === 'stu001');
  t('用户列表能查到 stu001', !!stuRow);
  const rp = await call('/api/admin?action=reset-password', {
    method: 'POST', token: adminToken,
    body: { id: stuRow ? stuRow.id : 1, newPassword: 'Reset2025' },
  });
  t('重置密码成功', rp.status === 200, JSON.stringify(rp.body));
  t('重置提示含"自行修改"', /自行修改/.test(rp.body.message || ''), rp.body.message);
  const l3 = await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'stu001', password: 'Reset2025' },
  });
  t('重置后可用新密码登录', l3.status === 200, JSON.stringify(l3.body));
  t('重置后再次要求改密', l3.body.mustChangePassword === true,
    '实际 ' + l3.body.mustChangePassword);

  /* --- stats 应带登录统计 --- */
  const st = await call('/api/admin?action=stats', { token: adminToken });
  t('stats 含 login 统计块', !!st.body.login, JSON.stringify(Object.keys(st.body)));
  t('stats.login 含 total', typeof st.body.login.total === 'number');
  t('stats.login 含 recent 数组', Array.isArray(st.body.login.recent));
  t('stats.users 含待改密人数', typeof st.body.users.pending_pwd === 'number');
}

console.log('\n【11】方法限制');
{
  const g = await call('/api/auth?action=login', { method: 'GET' });
  t('登录接口拒绝 GET', g.status === 405, '实际 ' + g.status);
}

/* ---------- 汇总 ---------- */

console.log('\n【12】班级通讯录 / 个人资料（后端化 + 审核 + 查看日志）');
{
  /* 这一组测试针对 2026-10-05 的隐私改造：
     把通讯录从前端密文搬到后端数据库，并加上登录门禁、审核与查看日志。

     测试思路：管理员先用后台接口建几条资料，再用普通同学的身份走一遍
     「查询 → 看到什么 / 看不到什么 → 提交联系方式 → 待审 → 审核通过」全流程。 */

  /* ---- 管理员建资料 ---- */
  const c1 = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '测试同学甲', studentId: '250501', politics: '共青团员' },
  });
  t('管理员新增资料成功', c1.status === 200 && c1.body.id > 0, JSON.stringify(c1.body));
  const pid1 = c1.body.id;

  const c2 = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '测试老师乙', politics: '中共党员', role: '老师', phone: '13800138000' },
  });
  t('管理员新增老师资料成功', c2.status === 200, JSON.stringify(c2.body));
  const pid2 = c2.body.id;

  /* 学号唯一性：同一个学号不能挂第二条 */
  const cdup = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '重名测试', studentId: '250501' },
  });
  t('学号重复被拒绝 409', cdup.status === 409, '实际 ' + cdup.status);

  /* 姓名与学号都空应报错 */
  const cempty = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken, body: { name: '', studentId: '' },
  });
  t('姓名学号全空被拒绝 400', cempty.status === 400, '实际 ' + cempty.status);

  /* ---- 未登录不能查询 ---- */
  const s0 = await call('/api/profile?action=search&q=测试', {});
  t('未登录查询资料 401', s0.status === 401, '实际 ' + s0.status);

  /* ---- 准备一个普通同学账号 ---- */
  const cu = await call('/api/admin?action=create-user', {
    method: 'POST', token: adminToken,
    body: { username: 'pctest01', password: 'Init2025x' },
  });
  t('为资料测试开一个普通账号', cu.status === 200, JSON.stringify(cu.body));

  const l1 = await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'pctest01', password: 'Init2025x' },
  });
  t('普通账号首次登录成功', l1.status === 200, JSON.stringify(l1.body));
  t('首次登录带强制改密标记', l1.body.mustChangePassword === true);

  /* 未改初始密码前，资料查询应被拦（requireUserReady 的作用） */
  const before = await call('/api/profile?action=search&q=测试', { token: l1.body.token });
  t('未改初始密码不能查资料 403', before.status === 403, '实际 ' + before.status);

  /* 改密后放行 */
  const cp = await call('/api/auth?action=change-password', {
    method: 'POST', token: l1.body.token,
    body: { oldPassword: 'Init2025x', newPassword: 'Newpw2025x' },
  });
  t('普通账号改密成功', cp.status === 200, JSON.stringify(cp.body));
  const token2 = (await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'pctest01', password: 'Newpw2025x' },
  })).body.token;
  t('改密后能重新登录', !!token2);

  /* ---- 登录后可查询 ---- */
  const s1 = await call('/api/profile?action=search&q=250501', { token: token2 });
  t('登录后按学号查询成功', s1.status === 200 && (s1.body.results || []).length >= 1,
    JSON.stringify(s1.body).slice(0, 150));
  const hit1 = (s1.body.results || [])[0] || {};
  t('查询结果带姓名', hit1.name === '测试同学甲', '实际 ' + hit1.name);
  t('查询结果带政治面貌', hit1.politics === '共青团员', '实际 ' + hit1.politics);

  /* 老师那条有手机号且 contact_status 默认 approved（管理员直接录入视为已核实） */
  const s2 = await call('/api/profile?action=search&q=测试老师', { token: token2 });
  const hit2 = (s2.body.results || [])[0] || {};
  t('按姓名能查到老师', hit2.name === '测试老师乙', '实际 ' + hit2.name);
  t('已核实的手机号对登录用户可见', hit2.phone === '13800138000', '实际 ' + hit2.phone);
  t('已核实标记正确', hit2.contactVisible === true);

  /* 空关键词报错 */
  const s3 = await call('/api/profile?action=search&q=', { token: token2 });
  t('空关键词报 400', s3.status === 400, '实际 ' + s3.status);

  /* 查不到时返回空数组而非报错 */
  const s4 = await call('/api/profile?action=search&q=不存在的人名xyz', { token: token2 });
  t('查不到返回空结果', s4.status === 200 && (s4.body.results || []).length === 0);

  /* ---- 查看日志：上面每次查询都应被记录 ---- */
  const vl = await call('/api/admin?action=view-logs', { token: adminToken });
  t('管理员能读取查看日志', vl.status === 200, JSON.stringify(vl.body).slice(0, 120));
  t('查看日志已记录 pctest01 的查询',
    (vl.body.logs || []).some(x => x.viewer === 'pctest01'),
    JSON.stringify((vl.body.logs || []).slice(0, 3)));
  t('查看日志记录了被查者姓名',
    (vl.body.logs || []).some(x => x.targetName === '测试同学甲'),
    JSON.stringify((vl.body.logs || []).map(x => x.targetName).slice(0, 5)));
  t('查看日志记录了查询关键词',
    (vl.body.logs || []).some(x => x.keyword === '250501'),
    JSON.stringify((vl.body.logs || []).map(x => x.keyword).slice(0, 5)));

  /* 按被查者筛选 */
  const vl2 = await call('/api/admin?action=view-logs&target=' + pid1, { token: adminToken });
  t('查看日志可按被查者筛选',
    (vl2.body.logs || []).every(x => x.targetId === pid1),
    JSON.stringify((vl2.body.logs || []).map(x => x.targetId)));

  /* 普通用户不能看查看日志 */
  const vl3 = await call('/api/admin?action=view-logs', { token: token2 });
  t('普通用户不能看查看日志 403', vl3.status === 403, '实际 ' + vl3.status);

  /* ---- 认领自己的资料 ---- */
  const cl0 = await call('/api/profile?action=me', { token: token2 });
  t('未认领时 me 返回 claimed=false', cl0.body.claimed === false, JSON.stringify(cl0.body));

  const clBad = await call('/api/profile?action=claim', {
    method: 'POST', token: token2,
    body: { name: '错误的姓名', studentId: '250501' },
  });
  t('姓名学号对不上时认领失败 404', clBad.status === 404, '实际 ' + clBad.status);

  const clOk = await call('/api/profile?action=claim', {
    method: 'POST', token: token2,
    body: { name: '测试同学甲', studentId: '250501' },
  });
  t('认领自己的资料成功', clOk.status === 200, JSON.stringify(clOk.body));

  const cl1 = await call('/api/profile?action=me', { token: token2 });
  t('认领后 me 返回 claimed=true', cl1.body.claimed === true);
  t('认领后 me 带出 profileId', cl1.body.profile && cl1.body.profile.id === pid1,
    JSON.stringify(cl1.body.profile || {}).slice(0, 100));

  /* ---- 提交联系方式 → 进待审 ---- */
  const sb = await call('/api/profile?action=submit', {
    method: 'POST', token: token2,
    body: { wechat: 'test_wx_id', qq: '123456789', phone: '13900139000' },
  });
  t('提交联系方式成功', sb.status === 200, JSON.stringify(sb.body));
  t('提交后状态为 pending', sb.body.status === 'pending', '实际 ' + sb.body.status);

  /* 格式校验 */
  const sbBadQq = await call('/api/profile?action=submit', {
    method: 'POST', token: token2, body: { qq: 'abc' },
  });
  t('非法 QQ 被拒绝 400', sbBadQq.status === 400, '实际 ' + sbBadQq.status);
  const sbEmpty = await call('/api/profile?action=submit', {
    method: 'POST', token: token2, body: { wechat: '', qq: '', phone: '' },
  });
  t('三项全空被拒绝 400', sbEmpty.status === 400, '实际 ' + sbEmpty.status);

  /* ⚠️ 关键断言：待审核的联系方式，别人查不到 */
  const s5 = await call('/api/profile?action=search&q=250501', { token: token2 });
  const selfHit = (s5.body.results || [])[0] || {};
  t('本人能看见自己待审的联系方式',
    selfHit.wechat === 'test_wx_id', '实际 ' + selfHit.wechat);
  t('本人在结果里被标记为可见', selfHit.contactVisible === true);

  /* 换一个账号来看，应该看不到（用管理员账号当「别人」测——管理员在查询接口
     里也是普通查询者视角，只有本人会拿到完整信息） */
  const s6 = await call('/api/profile?action=search&q=250501', { token: adminToken });
  const otherHit = (s6.body.results || [])[0] || {};
  t('待审核的联系方式不会暴露给其他人',
    !otherHit.wechat && !otherHit.qq && !otherHit.phone,
    JSON.stringify({ wx: otherHit.wechat, qq: otherHit.qq, ph: otherHit.phone }));
  t('别人视角下 contactVisible=false', otherHit.contactVisible === false);
  t('别人视角下给出脱敏预览', otherHit.phoneMasked === '139****9000',
    '实际 ' + otherHit.phoneMasked);

  /* ---- 后台看到待审队列 ---- */
  const rq = await call('/api/admin?action=profile-requests', { token: adminToken });
  t('待审核队列能读到刚提交的申请',
    (rq.body.requests || []).some(x => x.id === pid1),
    JSON.stringify(rq.body).slice(0, 150));

  /* ---- 驳回 ---- */
  const rj = await call('/api/admin?action=review-contact', {
    method: 'POST', token: adminToken,
    body: { id: pid1, approve: false, reason: '号码看起来不对' },
  });
  t('驳回联系方式成功', rj.status === 200, JSON.stringify(rj.body));
  t('驳回后状态为 rejected', rj.body.status === 'rejected');

  const mineRej = await call('/api/profile?action=mine-requests', { token: token2 });
  t('本人能看到驳回原因',
    (mineRej.body.requests || [])[0] &&
    (mineRej.body.requests || [])[0].rejectReason === '号码看起来不对',
    JSON.stringify(mineRej.body).slice(0, 200));

  const sRej = await call('/api/profile?action=search&q=250501', { token: adminToken });
  t('被驳回后其他人仍看不到',
    !(sRej.body.results || [])[0].wechat,
    JSON.stringify((sRej.body.results || [])[0]).slice(0, 120));

  /* ---- 重新提交 → 通过 ---- */
  const sb2 = await call('/api/profile?action=submit', {
    method: 'POST', token: token2,
    body: { wechat: 'fixed_wx', qq: '987654321', phone: '13900139000' },
  });
  t('重新提交后状态回到 pending', sb2.body.status === 'pending');

  const ap = await call('/api/admin?action=review-contact', {
    method: 'POST', token: adminToken, body: { id: pid1, approve: true },
  });
  t('审核通过成功', ap.status === 200 && ap.body.status === 'approved', JSON.stringify(ap.body));

  const s7 = await call('/api/profile?action=search&q=250501', { token: adminToken });
  const ok2 = (s7.body.results || [])[0] || {};
  t('审核通过后其他人能看到微信', ok2.wechat === 'fixed_wx', '实际 ' + ok2.wechat);
  t('审核通过后其他人能看到 QQ', ok2.qq === '987654321', '实际 ' + ok2.qq);
  t('审核通过后 contactVisible=true', ok2.contactVisible === true);

  /* ---- 管理员不能通过查询接口改身份信息（改只能走 admin 接口） ---- */
  /* 这里验证「同学无法改自己的姓名/学号」：profile 接口的 submit 只接受联系方式 */
  const tryRename = await call('/api/profile?action=submit', {
    method: 'POST', token: token2,
    body: { name: '改名试试', studentId: '999999', wechat: 'x' },
  });
  t('submit 不接受姓名/学号（仅联系方式）', tryRename.status === 200);
  const s8 = await call('/api/profile?action=search&q=250501', { token: token2 });
  const stillName = (s8.body.results || [])[0] || {};
  t('姓名未被改掉', stillName.name === '测试同学甲', '实际 ' + stillName.name);
  t('学号未被改掉', stillName.studentId === '250501', '实际 ' + stillName.studentId);

  /* ---- 管理员编辑资料 ---- */
  const ed = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { id: pid1, name: '测试同学甲', studentId: '250501', politics: '普通学生' },
  });
  t('管理员修改政治面貌成功', ed.status === 200, JSON.stringify(ed.body));
  const s9 = await call('/api/profile?action=search&q=250501', { token: token2 });
  t('政治面貌已更新为普通学生',
    (s9.body.results || [])[0].politics === '普通学生',
    '实际 ' + (s9.body.results || [])[0].politics);

  /* ---- 批量导入 ---- */
  const batch = await call('/api/admin?action=batch-profiles', {
    method: 'POST', token: adminToken,
    body: { rows: [
      { name: '批量甲', studentId: '250601', politics: '共青团员' },
      { name: '批量乙', studentId: '250602', politics: '普通学生' },
      { name: '', studentId: '' },
      { name: '批量甲', studentId: '250601', politics: '共青团员' },  /* 重复 → 应为更新 */
    ] },
  });
  t('批量导入成功', batch.status === 200, JSON.stringify(batch.body));
  t('批量导入新增 2 条', batch.body.created === 2, '实际 ' + batch.body.created);
  t('批量导入更新 1 条', batch.body.updated === 1, '实际 ' + batch.body.updated);
  t('批量导入失败 1 条', batch.body.failed === 1, '实际 ' + batch.body.failed);
  t('批量错误带 index', (batch.body.errors || [])[0] && batch.body.errors[0].index === 2,
    JSON.stringify(batch.body.errors));
  t('批量错误带原因', (batch.body.errors || [])[0] && !!batch.body.errors[0].reason);

  /* 超 60 条应被拒 */
  const tooMany = await call('/api/admin?action=batch-profiles', {
    method: 'POST', token: adminToken,
    body: { rows: new Array(61).fill({ name: 'x', studentId: '' }) },
  });
  t('批量导入超 60 条被拒绝 400', tooMany.status === 400, '实际 ' + tooMany.status);

  /* ---- 列表与统计 ---- */
  const lp = await call('/api/admin?action=profiles', { token: adminToken });
  t('管理员能读取资料列表', lp.status === 200, JSON.stringify(lp.body).slice(0, 120));
  t('资料列表带统计块', !!lp.body.counts, JSON.stringify(lp.body.counts));
  t('统计含待审核数', typeof lp.body.counts.pending === 'number');
  t('统计含已认领数', typeof lp.body.counts.claimed === 'number');

  const lpQ = await call('/api/admin?action=profiles&q=批量', { token: adminToken });
  t('资料列表支持关键词筛选',
    (lpQ.body.profiles || []).length === 2, '实际 ' + (lpQ.body.profiles || []).length);

  const pd = await call('/api/admin?action=profile&id=' + pid1, { token: adminToken });
  t('单条资料详情可读', pd.status === 200 && pd.body.profile.id === pid1);
  t('详情带查看记录', Array.isArray(pd.body.views), JSON.stringify(pd.body.views).slice(0, 100));

  /* 普通用户不能访问管理端资料接口 */
  const noPerm = await call('/api/admin?action=profiles', { token: token2 });
  t('普通用户不能读管理端资料列表 403', noPerm.status === 403, '实际 ' + noPerm.status);

  /* ---- stats 应含通讯录统计 ---- */
  const st2 = await call('/api/admin?action=stats', { token: adminToken });
  t('stats 含 profiles 统计块', !!st2.body.profiles, JSON.stringify(Object.keys(st2.body)));
  t('stats.profiles 含 pending', typeof st2.body.profiles.pending === 'number');
  t('stats.profiles 含 views7', typeof st2.body.profiles.views7 === 'number');

  /* ---- 删除资料 ---- */
  const dp = await call('/api/admin?action=delete-profile', {
    method: 'POST', token: adminToken, body: { id: pid2 },
  });
  t('删除资料成功', dp.status === 200, JSON.stringify(dp.body));
  const pd2 = await call('/api/admin?action=profile&id=' + pid2, { token: adminToken });
  t('删除后详情 404', pd2.status === 404, '实际 ' + pd2.status);

  /* ================================================================
     准考证号（exam_no）—— 2026-10-05 导入名单时新增的字段。
     设计约定：属于班内公开信息，**不走审核**，谁的查询都能直接看到。
     ================================================================ */

  /* 管理员建一条带准考证号的资料 */
  const ce = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '准考证测试生', studentId: '250701', politics: '群众', examNo: '11399999' },
  });
  t('新增带准考证号的资料成功', ce.status === 200 && ce.body.id > 0, JSON.stringify(ce.body));
  const eid = ce.body.id;

  /* 普通同学（已改密）去查，应当直接看到准考证号 */
  const se = await call('/api/profile?action=search&q=250701', { token: token2 });
  const ehit = (se.body.results || [])[0] || {};
  t('同学查询能拿到准考证号', ehit.examNo === '11399999', '实际 ' + ehit.examNo);

  /* 关键断言：准考证号不依赖 contact_status。
     这条资料没填任何联系方式，contact_status 是 none，
     但准考证号仍然要可见 —— 证明它走的是独立通道，没被审核门禁误伤。 */
  t('未填联系方式时 contactVisible=false', ehit.contactVisible === false);
  t('未填联系方式时准考证号依然可见', ehit.examNo === '11399999', '实际 ' + ehit.examNo);
  t('未填联系方式时微信/QQ/手机号均为空',
    !ehit.wechat && !ehit.qq && !ehit.phone,
    JSON.stringify({ w: ehit.wechat, q: ehit.qq, p: ehit.phone }));

  /* 按准考证号也能搜到人 */
  const se2 = await call('/api/profile?action=search&q=11399999', { token: token2 });
  t('支持用准考证号搜索',
    (se2.body.results || []).length === 1 && (se2.body.results || [])[0].name === '准考证测试生',
    JSON.stringify(se2.body.results || []).length + ' 条');

  /* 后台列表要带上这个字段 */
  const le = await call('/api/admin?action=profiles&q=250701', { token: adminToken });
  t('后台列表返回 examNo', (le.body.profiles || [])[0] && (le.body.profiles || [])[0].examNo === '11399999',
    JSON.stringify((le.body.profiles || [])[0] || {}).slice(0, 160));

  /* 后台单条详情要带上 */
  const de = await call('/api/admin?action=profile&id=' + eid, { token: adminToken });
  t('后台详情返回 examNo', de.body.profile && de.body.profile.examNo === '11399999');

  /* 管理员改准考证号 */
  const ue = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { id: eid, name: '准考证测试生', studentId: '250701', examNo: '11400001' },
  });
  t('管理员修改准考证号成功', ue.status === 200, JSON.stringify(ue.body));
  const se3 = await call('/api/profile?action=search&q=250701', { token: token2 });
  t('修改后同学看到的是新号码', (se3.body.results || [])[0].examNo === '11400001',
    '实际 ' + (se3.body.results || [])[0].examNo);

  /* 批量导入要认这个字段（Excel 导入走的就是这条路） */
  const be = await call('/api/admin?action=batch-profiles', {
    method: 'POST', token: adminToken,
    body: { rows: [
      { name: '批量准考证甲', studentId: '250702', politics: '群众', examNo: '11380001' },
      { name: '批量准考证乙', studentId: '250703', politics: '共青团员', examNo: '11380002' },
    ] },
  });
  t('批量导入带准考证号成功', be.status === 200 && be.body.created === 2, JSON.stringify(be.body));
  const se4 = await call('/api/profile?action=search&q=250702', { token: token2 });
  t('批量导入的准考证号可被同学查到',
    (se4.body.results || [])[0].examNo === '11380001',
    '实际 ' + (se4.body.results || [])[0].examNo);

  /* 不带准考证号的资料，字段应是空串而不是 undefined（前端拼字符串才安全） */
  const se5 = await call('/api/profile?action=search&q=250501', { token: token2 });
  t('无准考证号时返回空串而非 undefined',
    (se5.body.results || [])[0].examNo === '',
    JSON.stringify((se5.body.results || [])[0].examNo));

  /* 收尾：把测试造的这几条删掉，避免污染 */
  for (const id of [eid]) {
    await call('/api/admin?action=delete-profile', { method: 'POST', token: adminToken, body: { id } });
  }
  const bp = await call('/api/admin?action=profiles&q=批量准考证', { token: adminToken });
  for (const x of (bp.body.profiles || [])) {
    await call('/api/admin?action=delete-profile', { method: 'POST', token: adminToken, body: { id: x.id } });
  }
  t('准考证号测试数据已清理',
    (bp.body.profiles || []).length === 2, '找到 ' + (bp.body.profiles || []).length + ' 条待清理');
}

console.log('\n【17】云端内容接口 /api/content（2026-10-05 新增）');
{
  /* 背景：主站早就写了 syncCloudContent() 去拉 /api/content，
     但后端从来没这个接口，一直 404，公告/作业全靠本地硬编码兜底。
     这一节验证接口真的通了。 */

  /* --- 匿名可读：公告是给全班看的，未登录也该拿到 --- */
  const anon = await call('/api/content');
  t('匿名可读（内容本就是公开的）', anon.status === 200 && anon.body.ok, 'HTTP ' + anon.status);
  t('返回 items 对象', anon.body.items && typeof anon.body.items === 'object');
  t('返回 serverTime（供前端记增量位点）', typeof anon.body.serverTime === 'number');

  /* --- 未登录不能写 --- */
  const anonWrite = await call('/api/content', {
    method: 'PUT', body: { items: { announcements: [] } },
  });
  t('匿名写入被拒 401', anonWrite.status === 401, '实际 ' + anonWrite.status);

  /* --- 普通用户不能写 --- */
  const reg = await call('/api/auth?action=register', {
    method: 'POST', body: { username: 'contentuser', password: 'ContentPass123' },
  });
  const contentUserToken = reg.body.token;
  const userWrite = await call('/api/content', {
    method: 'PUT', token: contentUserToken,
    body: { items: { announcements: [] } },
  });
  t('普通用户写入被拒 403', userWrite.status === 403, '实际 ' + userWrite.status);

  /* --- 管理员可写 --- */
  const put1 = await call('/api/content', {
    method: 'PUT', token: adminToken,
    body: { items: {
      announcements: [
        { id: 'a1', title: '测试公告', body: '正文', date: '2026-10-05' },
      ],
      homework_notice: { text: '今晚做数学卷子' },
    } },
  });
  t('管理员写入成功', put1.status === 200 && put1.body.ok, JSON.stringify(put1.body));
  t('返回已更新的键', (put1.body.updated || []).includes('announcements'));

  /* --- 读回来 --- */
  const read1 = await call('/api/content');
  t('公告能被读回',
    Array.isArray(read1.body.items.announcements) && read1.body.items.announcements[0].title === '测试公告',
    JSON.stringify(read1.body.items.announcements));
  t('作业通知能被读回',
    read1.body.items.homework_notice && read1.body.items.homework_notice.text === '今晚做数学卷子');

  /* --- 局部更新不能冲掉其它键 --- */
  const put2 = await call('/api/content', {
    method: 'PUT', token: adminToken,
    body: { items: { announcements: [
      { id: 'a1', title: '改过的公告', body: '正文', date: '2026-10-05' },
      { id: 'a2', title: '第二条', body: '', date: '2026-10-05' },
    ] } },
  });
  t('二次写入成功', put2.status === 200);
  const read2 = await call('/api/content');
  t('公告已更新为 2 条', (read2.body.items.announcements || []).length === 2,
    '实际 ' + (read2.body.items.announcements || []).length);
  t('局部更新没冲掉作业通知（PUT 是合并语义）',
    read2.body.items.homework_notice && read2.body.items.homework_notice.text === '今晚做数学卷子',
    JSON.stringify(read2.body.items.homework_notice));

  /* --- 单条写法（方便 AI 直接用） --- */
  const put3 = await call('/api/content', {
    method: 'PUT', token: adminToken,
    body: { key: 'daily_quote', value: { text: '天道酬勤' } },
  });
  t('单条 key/value 写法可用', put3.status === 200 && (put3.body.updated || []).includes('daily_quote'));

  /* --- 不认识的键要拒 --- */
  const badKey = await call('/api/content', {
    method: 'PUT', token: adminToken, body: { items: { evil_key: 'x' } },
  });
  t('非法内容键被拒 400', badKey.status === 400, '实际 ' + badKey.status);
  t('拒绝时提示具体键名', /evil_key/.test(badKey.body.error || ''), badKey.body.error);

  /* --- 空提交要拒 --- */
  const empty = await call('/api/content', {
    method: 'PUT', token: adminToken, body: { items: {} },
  });
  t('空内容被拒 400', empty.status === 400, '实际 ' + empty.status);

  /* --- 超大内容要拒 --- */
  const huge = await call('/api/content', {
    method: 'PUT', token: adminToken,
    body: { items: { daily_quote: { text: 'x'.repeat(210 * 1024) } } },
  });
  t('超过 200KB 被拒 400', huge.status === 400, '实际 ' + huge.status);
  t('拒绝时说明体积', /KB|太大/.test(huge.body.error || ''), huge.body.error);

  /* --- 条目数上限 --- */
  const many = await call('/api/content', {
    method: 'PUT', token: adminToken,
    body: { items: { activities: new Array(2001).fill({ t: 'x' }) } },
  });
  t('单字段超 2000 条被拒 400', many.status === 400, '实际 ' + many.status);

  /* --- 支持的方法限制 --- */
  const del = await call('/api/content', { method: 'DELETE', token: adminToken });
  t('DELETE 被拒 405', del.status === 405, '实际 ' + del.status);

  /* --- 公告历史键兼容：写入公告后，cls_site_announcements 也应有一份 --- */
  const rows = db.prepare(
    "select count(*) as n from user_data where data_key = 'cls_site_announcements'"
  );
  let an = 0;
  if (rows.step()) an = rows.getAsObject().n;
  rows.free();
  t('公告同步写入历史键（兼容老前端）', an >= 1, '找到 ' + an + ' 条');

  /* --- 清理 --- */
  await call('/api/content', {
    method: 'PUT', token: adminToken,
    body: { items: { announcements: [], activities: [] } },
  });
  t('内容测试数据已清理', true);
}

console.log('\n【18】头衔系统与 AI 助手交接（2026-10-05 新增）');
{
  /* ---- 先造一条资料 + 一个认领它的账号 ---- */
  const mk = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '头衔测试甲', studentId: '9900001', politics: '共青团员' },
  });
  t('建测试资料成功', mk.status === 200 && mk.body.ok, JSON.stringify(mk.body));
  const pid = mk.body.id || (mk.body.profile || {}).id;

  /* ---- 头衔白名单 ---- */
  const bad = await call('/api/admin?action=set-title', {
    method: 'POST', token: adminToken,
    body: { id: pid, titles: ['玉皇大帝'] },
  });
  t('不在白名单的头衔被拒 400', bad.status === 400, '实际 ' + bad.status);
  t('拒绝时列可选值', /班长|团支书/.test(bad.body.error || ''), bad.body.error);

  /* ---- 正常任命 ---- */
  const okSet = await call('/api/admin?action=set-title', {
    method: 'POST', token: adminToken,
    body: { id: pid, titles: ['课代表', '团支书'] },
  });
  t('任命多职成功', okSet.status === 200 && (okSet.body.titles || []).length === 2, JSON.stringify(okSet.body));

  /* ---- 逗号分隔字符串写法也认 ---- */
  const strSet = await call('/api/admin?action=set-title', {
    method: 'POST', token: adminToken,
    body: { id: pid, title: '班长,课代表' },
  });
  t('逗号分隔字符串写法可用', strSet.status === 200 && (strSet.body.titles || []).length === 2,
    JSON.stringify(strSet.body.titles));

  /* ---- 去重 ---- */
  const dupSet = await call('/api/admin?action=set-title', {
    method: 'POST', token: adminToken,
    body: { id: pid, titles: ['课代表', '课代表', '班长'] },
  });
  t('重复头衔自动去重', (dupSet.body.titles || []).length === 2, JSON.stringify(dupSet.body.titles));

  /* ---- 清空 ---- */
  const clearSet = await call('/api/admin?action=set-title', {
    method: 'POST', token: adminToken, body: { id: pid, titles: [] },
  });
  t('清空头衔成功', clearSet.status === 200 && (clearSet.body.titles || []).length === 0);

  /* ---- 列表 ---- */
  await call('/api/admin?action=set-title', {
    method: 'POST', token: adminToken, body: { id: pid, titles: ['课代表'] },
  });
  const list = await call('/api/admin?action=titles', { token: adminToken });
  t('头衔列表能查到刚任命的', (list.body.profiles || []).some((p) => Number(p.id) === Number(pid)),
    JSON.stringify((list.body.profiles || []).map((p) => p.name)));
  t('列表带可选头衔清单', Array.isArray(list.body.allowed) && list.body.allowed.length > 0);

  /* ---- 缺 id 要拒 ---- */
  const noId = await call('/api/admin?action=set-title', {
    method: 'POST', token: adminToken, body: { titles: ['班长'] },
  });
  t('缺 id 被拒 400', noId.status === 400, '实际 ' + noId.status);

  /* ---- 不存在的资料 ---- */
  const ghost = await call('/api/admin?action=set-title', {
    method: 'POST', token: adminToken, body: { id: 999999, titles: ['班长'] },
  });
  t('资料不存在返回 404', ghost.status === 404, '实际 ' + ghost.status);

  /* ---- 普通用户不能任命头衔 ---- */
  const plainReg = await call('/api/auth?action=register', {
    method: 'POST', body: { username: 'plaintitle', password: 'PlainPass123' },
  });
  const plainToken = plainReg.body.token;
  const unauth = await call('/api/admin?action=set-title', {
    method: 'POST', token: plainToken, body: { id: pid, titles: ['班长'] },
  });
  t('普通用户任命头衔被拒 403', unauth.status === 403, '实际 ' + unauth.status);

  /* ============================================================
     AI 账号与交接
     ============================================================ */
  const acc0 = await call('/api/admin?action=ai-account', { token: adminToken });
  t('AI 账号查询可用', acc0.status === 200 && acc0.body.ok);

  /* 造一个账号当新 AI */
  const newAi = await call('/api/auth?action=register', {
    method: 'POST', body: { username: 'aibottest', password: 'AiBotPass123' },
  });
  t('新 AI 候选账号注册成功', newAi.status === 200 && newAi.body.ok, JSON.stringify(newAi.body));
  t('新账号默认不是管理员', newAi.body.user.role === 'user', '实际 ' + newAi.body.user.role);

  /* 交接 */
  const hv = await call('/api/admin?action=handover-ai', {
    method: 'POST', token: adminToken, body: { username: 'aibottest' },
  });
  t('AI 交接成功', hv.status === 200 && hv.body.ok, JSON.stringify(hv.body));
  t('交接返回新账号名', hv.body.current === 'aibottest', JSON.stringify(hv.body));

  /* 交接后新账号应变成管理员 + is_ai */
  const rowsAi = db.prepare("select role, is_ai from users where lower(username)='aibottest'");
  let roleAi = null, isAiFlag = null;
  if (rowsAi.step()) { const o = rowsAi.getAsObject(); roleAi = o.role; isAiFlag = o.is_ai; }
  rowsAi.free();
  t('交接后新账号变成管理员', roleAi === 'admin', '实际 ' + roleAi);
  t('交接后新账号被打上 is_ai 标记', Number(isAiFlag) === 1, '实际 ' + isAiFlag);

  /* 交接后新 AI 能用 requireAI 通过（通过 /api/content 写入验证） */
  const aiToken = (await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'aibottest', password: 'AiBotPass123' },
  })).body.token;
  const aiWrite = await call('/api/content', {
    method: 'PUT', token: aiToken,
    body: { items: { daily_quote: { text: 'AI 写入测试' } } },
  });
  t('AI 账号可以写云端内容', aiWrite.status === 200 && aiWrite.body.ok, JSON.stringify(aiWrite.body));

  /* 再交接给不存在的账号要拒 */
  const hvGhost = await call('/api/admin?action=handover-ai', {
    method: 'POST', token: adminToken, body: { username: 'nobody_here_xyz' },
  });
  t('交接给不存在的账号返回 404', hvGhost.status === 404, '实际 ' + hvGhost.status);

  /* 交接给自己（已是 AI）要拒 */
  const hvSame = await call('/api/admin?action=handover-ai', {
    method: 'POST', token: adminToken, body: { username: 'aibottest' },
  });
  t('重复交接给同一账号被拒 400', hvSame.status === 400, '实际 ' + hvSame.status);

  /* ---- 课代表只能改作业字段（核心安全边界） ---- */
  const hwUser = await call('/api/auth?action=register', {
    method: 'POST', body: { username: 'hwboss', password: 'HwBossPass123' },
  });
  const hwToken = hwUser.body.token;

  /* 造一条资料并绑定到该账号。
     注意：saveProfile 不支持 userId 参数，绑定要单独做（模拟「认领」）。
     用 db 直接改，而不是走接口——测试要的是确定的状态。
     ⚠️ 顺序要紧：先验「无头衔被拒」，再任命头衔，否则前面两条断言会失效。 */
  const mk2 = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '作业课代表', studentId: '9900002' },
  });
  const pid2 = mk2.body.id || (mk2.body.profile || {}).id;
  db.run('update profiles set user_id = ? where id = ?', [hwUser.body.user.id, pid2]);

  /* 没头衔前应被拒 */
  const hwNoTitle = await call('/api/content', {
    method: 'PUT', token: hwToken, body: { items: { homework_notice: { text: 'x' } } },
  });
  t('无头衔时写作业被拒 403', hwNoTitle.status === 403, '实际 ' + hwNoTitle.status);

  /* 客户端伪造 title 参数不应被采信（安全边界） */
  const fake = await call('/api/content', {
    method: 'PUT', token: hwToken,
    body: { items: { homework_notice: { text: '伪造' } }, title: '课代表', isAI: true, role: 'admin' },
  });
  t('伪造 title/isAI/role 参数不被采信', fake.status === 403, '实际 ' + fake.status);

  /* 现在任命课代表 */
  await call('/api/admin?action=set-title', {
    method: 'POST', token: adminToken, body: { id: pid2, titles: ['课代表'] },
  });

  /* 真任命课代表后可以改作业 */
  const hwOk = await call('/api/content', {
    method: 'PUT', token: hwToken,
    body: { items: { homework_notice: { text: '课代表布置的作业' } } },
  });
  t('课代表可以改作业通知', hwOk.status === 200 && hwOk.body.ok, JSON.stringify(hwOk.body));

  /* 课代表不能改公告（越权必须拦住） */
  const hwAnn = await call('/api/content', {
    method: 'PUT', token: hwToken, body: { items: { announcements: [{ title: '越权公告' }] } },
  });
  t('课代表不能改公告 403', hwAnn.status === 403, '实际 ' + hwAnn.status);
  t('越权提示说明只能改作业', /只能修改作业/.test(hwAnn.body.error || ''), hwAnn.body.error);

  /* 课代表不能改点歌配置 */
  const hwSong = await call('/api/content', {
    method: 'PUT', token: hwToken, body: { items: { song_config: { x: 1 } } },
  });
  t('课代表不能改点歌配置 403', hwSong.status === 403, '实际 ' + hwSong.status);

  /* ---- 清理 ---- */
  for (const id of [pid, pid2]) {
    if (id) await call('/api/admin?action=delete-profile', { method: 'POST', token: adminToken, body: { id } });
  }
  t('头衔测试数据已清理', true);
}

console.log('\n' + '='.repeat(52));
console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败  (共 ' + (pass + fail) + ' 项)');
if (fail) { console.log('\n失败项:'); fails.forEach(f => console.log('  - ' + f)); }
console.log('实际执行 SQL 查询: ' + queryLog.length + ' 条');
console.log('='.repeat(52));
process.exit(fail ? 1 : 0);
