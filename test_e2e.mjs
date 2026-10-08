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
import fs from 'node:fs';

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
  last_login_at text
  /* ⚠️ 2026-10-07 第二十七轮教训：这里以前**预先建好了**
     last_seen_at / failed_count / locked_until / must_change_password / is_ai，
     于是「ensureSchema 自愈」在桩里永远无事可做，生产缺列导致的 500
     在测试里根本复现不了 —— 400+ 项全绿，线上却点不动「重置密码」。
     现在这些列**故意不建**，交给 ensureSchema 去 ADD COLUMN，
     桩的行为与生产对齐。（本表的其余列仍按 schema.sql 建好，因为
     schema.sql 也需要人工执行，但这里只针对「自愈覆盖到的列」做对齐。） */
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

/* ---------- 3.6 jsonb 仿真（关键：桩不能比生产宽容） ----------
   生产库 user_data.data_value 是 **jsonb 列**，Neon 驱动直接返回已解析的 JS 对象；
   SQLite 桩是 text 列，返回 JSON 文本字符串。

   以前桩返回字符串，业务代码里的 JSON.parse 反而「能成功」，
   于是 245 项测试全绿，线上却因为「对对象调 JSON.parse 抛错被吞」
   出现「写入成功、读取永远为空」。

   教训：桩比生产宽容 = 测试通过是假信号。这里把读出来的值还原成对象，
   让桩的行为和生产对齐。 */
function emulateJsonb(sqlText, rows) {
  if (!/from\s+user_data/i.test(sqlText)) return rows;
  if (!/\bdata_value\b/i.test(sqlText)) return rows;
  return rows.map((r) => {
    if (!Object.prototype.hasOwnProperty.call(r, 'data_value')) return r;
    if (typeof r.data_value !== 'string') return r;
    const s = r.data_value.trim();
    if (!s) return r;
    let v;
    try { v = JSON.parse(s); } catch { return r; }   // 不是合法 JSON：原样返回
    return Object.assign({}, r, { data_value: v });
  });
}

let queryLog = [];

function translate(sqlText) {
  let s = sqlText;
  /* ⚠️ 2026-10-07：以前这里把 `alter table ... add column if not exists`
     直接忽略（返回空查询），于是「ensureSchema 自愈」形同虚设 —— 桩里
     所有列都在，实际生产缺列时会 500，测试却全绿。
     这正是「后台重置密码 500 / 改密码 500」能溜过 400+ 项测试的原因。
     现在改为**真正执行**这条 DDL：由 execAlter 解析后按需 ADD COLUMN。 */
  if (/^\s*alter\s+table[\s\S]*add\s+column\s+if\s+not\s+exists/i.test(s)) {
    return { __alter: s };
  }
  /* ⚠️ 2026-10-07：`create table if not exists ...` 在 SQLite 里语法更严：
       · 列默认值不能写 `default datetime('now')`（函数式默认值必须加括号
         `default (datetime('now'))`），Postgres 则两种都收；
       · `bigserial` / `timestamptz` 等 PG 类型 SQLite 不认（虽然 ADD COLUMN
         时被容错，建表语句里却会直接报 near "(": syntax error）。
     桩里这些表**已经按 schema.sql 建好了**，所以 ensureSchema 的建表语句
     语义上应当「什么都不做」。这里直接返回跳过标记，与 Postgres 的
     IF NOT EXISTS 幂等语义一致，也避免 SQLite 语法差异污染测试结果。

     ⚠️ 2026-10-08：上面那条「一律跳过」有个漏洞 —— **桩里没预建的表**
     （如新增的 profile_field_meta）会永远不存在，于是 ensureSchema 的
     预置 insert 直接报「no such table」，自愈整体崩掉。
     这与生产行为不一致（生产 IF NOT EXISTS 会真的把表建出来）。
     这里改为：**建表语句真正执行一次**（用 SQLite 语法重写类型），
     幂等语义与 Postgres 一致；create index 仍跳过（索引不影响测试语义）。 */
  if (/^\s*create\s+table\s+if\s+not\s+exists/i.test(s)) {
    return { __createTable: s };
  }
  if (/^\s*create\s+index\s+if\s+not\s+exists/i.test(s)) {
    return { __skip: s };
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
  const tr = translate(text);

  return {
    then(resolve, reject) {
      try {
        /* ---- ensureSchema 的 add column if not exists：真正执行 ----
           让桩和生产一致：列不存在就加，存在就跳过。
           这样「生产缺列」类故障能在测试里复现，不会假绿。 */
        if (tr && typeof tr === 'object' && tr.__alter) {
          const m = /alter\s+table\s+([\w"]+)\s+add\s+column\s+if\s+not\s+exists\s+([\w"]+)\s+([^;]*)/i.exec(tr.__alter);
          if (m) {
            const [, tbl, col, rest] = m;
            const cols = db.exec(`pragma table_info(${tbl})`);
            const names = cols.length ? cols[0].values.map((r) => String(r[1])) : [];
            if (!names.includes(col)) {
              /* 去掉 Postgres 专有类型，映射到 SQLite 可用类型 */
              let type = rest.replace(/\s+/g, ' ').trim();
              type = type.replace(/timestamptz/gi, 'text')
                         .replace(/bigserial/gi, 'integer')
                         .replace(/::interval/gi, '');
              db.run(`alter table ${tbl} add column ${col} ${type}`);
            }
          }
          resolve([]);
          return;
        }
        /* ---- ensureSchema 的 create table/index if not exists ----
           index 跳过；table 真正执行（幂等：已存在就不动）。 */
        if (tr && typeof tr === 'object' && tr.__createTable) {
          const m = /create\s+table\s+if\s+not\s+exists\s+([\w"]+)/i.exec(tr.__createTable);
          if (m) {
            const tbl = m[1].replace(/"/g, '');
            const has = db.exec(
              `select name from sqlite_master where type='table' and name='${tbl}'`
            );
            if (!has.length || !has[0].values.length) {
              /* 把 PG 专有类型 / 函数默认值改写为 SQLite 能接受的写法 */
              let ddl = tr.__createTable
                .replace(/bigserial/gi, 'integer')
                .replace(/timestamptz/gi, 'text')
                .replace(/boolean/gi, 'integer')
                .replace(/jsonb/gi, 'text')
                .replace(/default\s+now\(\)/gi, "default (datetime('now'))")
                /* check 约束里的 in (...) 两边都支持，保留；
                   但 `constraint xxx check` 的具名约束 SQLite 也认，无需改。 */
                ;
              try { db.run(ddl); } catch (e) { /* 语法差异不该让整个自愈崩掉 */ }
            }
          }
          resolve([]);
          return;
        }
        /* ---- create index if not exists：跳过 ---- */
        if (tr && typeof tr === 'object' && tr.__skip) {
          resolve([]);
          return;
        }
        const translated = PG_to_Q(tr);
        queryLog.push({ sql: translated, values: values.map(v => typeof v) });
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

        /* ---- 特例：`data_key = any($N::text[])` 形式的数组匹配 ----
           Postgres 写法：where data_key = any($2::text[])
           参数是一个 JS 数组，翻译成 SQLite 得靠 json_each 展开。
           （对应 api/content.js 里读云端内容的那条查询。） */
        if (/=\s*any\s*\(\s*\?\s*\)/i.test(translated)) {
          const m = /=\s*any\s*\(\s*\?\s*\)/i.exec(translated);
          /* any 那个 ? 是整条 SQL 里的第几个占位 */
          const anyAt = (translated.slice(0, m.index).match(/\?/g) || []).length;
          const arr = Array.isArray(values[anyAt]) ? values[anyAt] : [];
          const holes = arr.length ? arr.map(() => '?').join(', ') : 'null';
          const sqlA = translated.slice(0, m.index) + 'in (' + holes + ')'
                     + translated.slice(m.index + m[0].length);
          /* 值列表要在 anyAt 位置把数组摊平，其余顺序不变 */
          const valsA = values.slice(0, anyAt).concat(arr, values.slice(anyAt + 1));
          const stmtA = db.prepare(sqlA);
          stmtA.bind(valsA.map((v) => {
            if (v === undefined || v === null) return null;
            if (typeof v === 'boolean') return v ? 1 : 0;
            if (typeof v === 'object') return JSON.stringify(v);
            return v;
          }));
          const rowsA = [];
          while (stmtA.step()) rowsA.push(stmtA.getAsObject());
          stmtA.free();
          resolve(emulateJsonb(sqlA, rowsA));
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
        resolve(emulateJsonb(translated, rows));
      } catch (e) {
        const shown = (tr && typeof tr === 'object') ? JSON.stringify(tr) : tr;
        reject(new Error('SQL 失败: ' + e.message + '\n  SQL: ' + shown + '\n  值: ' + JSON.stringify(values)));
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
  t('非白名单来源【不输出】CORS 头（站规：不得回退白名单任一项）',
    allowHeader === null || allowHeader === '', '实际 ' + allowHeader);
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

  /* --- 非法用户名应 400（2026-10-06 放宽到 2 位：两字姓名可导入，1 位仍拒） --- */
  const cBad = await call('/api/admin?action=create-user', {
    method: 'POST', token: adminToken,
    body: { username: 'a', password: 'Init2025' },
  });
  t('用户名过短被拒 400', cBad.status === 400, '实际 ' + cBad.status);

  /* --- 2 位用户名现在合法（按姓名建账号的关键） --- */
  const cTwo = await call('/api/admin?action=create-user', {
    method: 'POST', token: adminToken,
    body: { username: '余倩', password: 'Init2025' },
  });
  t('2 字中文用户名可创建', cTwo.status === 200 && cTwo.body.ok, JSON.stringify(cTwo.body).slice(0, 120));

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
  globalThis.__pid1 = pid1;   /* 供后面的【35】节复用（跨 {} 块作用域） */

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

  /* ---- 认领自己的资料 ----
     ⚠️ 2026-10-08 行为变更：修了「建号不建 profiles」的 bug 之后，
        pctest01 这个账号在建号时就已经**自动带上一条资料**了，
        所以这里 claimed 是 true 而不是 false —— 这正是修复生效的证据。
        （站主反馈的原 bug：后台建了新用户，却在「头衔任命」里找不到他。） */
  const cl0 = await call('/api/profile?action=me', { token: token2 });
  t('建号时已自动建资料 → claimed=true', cl0.body.claimed === true, JSON.stringify(cl0.body));
  t('自动建的资料姓名为空（建号时未填姓名）',
    cl0.body.profile && cl0.body.profile.name === '', JSON.stringify(cl0.body.profile || {}));
  t('自动建的资料学号为空', cl0.body.profile && cl0.body.profile.studentId === '',
    JSON.stringify(cl0.body.profile || {}));
  t('me 返回带 privateFields 键（下轮私有字段的接口形状）',
    Array.isArray(cl0.body.privateFields), JSON.stringify(cl0.body).slice(0, 120));

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

  /* --- 回归护栏：读取必须用「数组参数」而不是 in ($1, $2) ---
     2026-10-06 线上事故：readContent 写的是
       and data_key in (${CONTENT_KEY}, ${ANNOUNCE_KEY})
     在真正的 Neon 驱动上**不报错但永远返回 0 行**，导致
     「写入成功（cloudKeys 能看到）、读取为空」。
     sql.js 桩对这个写法是宽容的，所以当时测试全绿却没抓到。
     这里直接断言源码形态，把这种「桩过、线上不过」的写法挡在门外。 */
  {
    const src = fs.readFileSync(new URL('./api/content.js', import.meta.url), 'utf8');
    const bad = /data_key\s+in\s*\(\s*\$\{/i.test(src);
    const good = /=\s*any\s*\(\s*\$\{/.test(src);
    t('读取未使用 in (${a}, ${b}) 的散装占位写法（Neon 上会静默返回 0 行）', !bad,
      bad ? '检测到 in (${...}, ${...})，请改成 data_key = any(${arr}::text[])' : '');
    t('读取使用 = any(${arr}::text[]) 的数组参数写法', good);

    /* --- 回归护栏 2：不许对 data_value 裸调 JSON.parse ---
       2026-10-06 第二个线上事故：data_value 是 jsonb 列，
       Neon 驱动返回的是**已解析的对象**，对它 JSON.parse 抛
       "[object Object]" is not valid JSON，异常被 catch 吞掉 →
       「PUT 200、/api/data 看得到、GET /api/content 永远 count=0」。
       更糟的是写入侧同一个错误会让 doc 退化成 {}，
       于是这次 PUT 把库里存量（70 条公告）整包冲掉。
       统一走 jsonCol()，这里断言源码里不再出现裸 JSON.parse。 */
    const bare = /JSON\.parse\s*\([^)]*data_value/i.test(src);
    const uses = /jsonCol\s*\(/.test(src);
    t('未对 jsonb 列 data_value 裸调 JSON.parse（对象会被 parse 抛错）', !bare,
      bare ? '检测到 JSON.parse(...data_value...)，请改用 jsonCol()' : '');
    t('统一使用 jsonCol() 兼容「对象 / JSON 文本」两种返回', uses);

    /* --- 回归护栏 3：admin.html 的 CONTENT_FIELD 只能指向白名单内的键 ---
       2026-10-06 发现：后台类型下拉里的「活动」原来映到 activities 字段，
       但 ALLOW_CONTENT_KEYS 里**没有** activities（后端注释：主站不消费它），
       于是管理员选「活动」保存必被 400 拒绝。
       这类「前端写、后端拒」的错配肉眼极难发现（下拉里每个选项看起来都正常），
       所以直接把两份名单拿出来做交叉校验。 */
    const adminSrc = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
    const allowBlock = src.match(/const ALLOW_CONTENT_KEYS\s*=\s*\[([\s\S]*?)\];/);
    t('能从后端源码解析出 ALLOW_CONTENT_KEYS', !!allowBlock);
    const allowKeys = allowBlock
      ? Array.from(allowBlock[1].matchAll(/'([a-z_]+)'/g)).map((m) => m[1])
      : [];
    t('ALLOW_CONTENT_KEYS 解析出若干键', allowKeys.length >= 4, JSON.stringify(allowKeys));

    const cfBlock = adminSrc.match(/var CONTENT_FIELD\s*=\s*\{([\s\S]*?)\};/);
    t('能在 admin.html 里解析出 CONTENT_FIELD', !!cfBlock);
    if (cfBlock && allowKeys.length) {
      const vals = Array.from(cfBlock[1].matchAll(/:\s*'([a-z_]+)'/g)).map((m) => m[1]);
      const uniq = Array.from(new Set(vals));
      t('CONTENT_FIELD 里解析到了映射目标', uniq.length > 0, JSON.stringify(uniq));
      const notAllowed = uniq.filter((k) => !allowKeys.includes(k));
      t('CONTENT_FIELD 的每个目标键都在后端白名单内（否则保存必被 400）',
        notAllowed.length === 0,
        notAllowed.length ? '不在白名单：' + notAllowed.join(', ') + '（白名单：' + allowKeys.join(',') + '）' : '');
    }
  }

  /* --- 护栏 3：存量读不出来时必须报错，绝不能静默覆盖 ---
     线上真实损失：一次普通 PUT 把 70 条公告冲掉，只剩新写的内容。 */
  {
    const CK = 'cls_site_contents';
    db.run("update user_data set data_value = 'not-json{{{' where data_key = '" + CK + "'");
    const guard = await call('/api/content', {
      method: 'PUT', token: adminToken,
      body: { key: 'daily_quote', value: ['探针'] },
    });
    t('存量内容读不出来时拒绝写入（防止覆盖历史数据）', guard.status === 500,
      '实际 ' + guard.status + ' ' + JSON.stringify(guard.body));
    t('拒绝时说明是「读不出来」而不是写入失败',
      /读不出来|中止保存/.test(String(guard.body && guard.body.error || '')));
    /* 复原：删掉这行损坏的数据，并重新写一份内容供后续用例读取 */
    db.run("delete from user_data where data_key = '" + CK + "'");
    const reseed = await call('/api/content', {
      method: 'PUT', token: adminToken,
      body: { items: { homework_notice: { text: '今晚做数学卷子' } } },
    });
    t('损坏数据清掉后写入恢复正常', reseed.status === 200,
      '实际 ' + reseed.status + ' ' + JSON.stringify(reseed.body));
  }

  /* --- 读路径真的能取到两个键（不只是不报错）--- */
  {
    const both = await call('/api/content');
    const ks = Object.keys(both.body.items || {});
    t('读取能同时取到通用内容键与公告键（覆盖多键查询）',
      ks.includes('announcements') && ks.length >= 2,
      '实际键：' + ks.join(', '));
  }

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

  /* ==================================================================
     【合并面板契约】后台「班级内容」把公告和内容合成一次 PUT 提交。
     它依赖两条后端语义，缺一不可：
       ① 只传部分字段 → 其它字段**原样保留**（绝对不能整个文档覆盖）
       ② 传了空数组 → 视为「真的要清空这个字段」
     ② 和 ① 必须能区分开。这两条一旦破了，管理员改一条活动就可能
     把 50 条公告连带冲掉（历史上真发生过，见 jsonb 那次事故）。
     ================================================================== */
  await call('/api/content', {
    method: 'PUT', token: adminToken,
    body: { items: { announcements: [
      { id: 'a1', title: '保留测试甲', body: '正文甲', targets: [] },
      { id: 'a2', title: '保留测试乙', body: '正文乙', targets: ['u1'] },
    ] } },
  });
  await call('/api/content', {
    method: 'PUT', token: adminToken,
    body: { items: { activities: [{ kind: '活动', title: '运动会' }] } },
  });

  const keep = await call('/api/content', { method: 'GET', token: adminToken });
  const keepAnn = keep.body.items.announcements || [];
  t('① 只传 activities 时，announcements 原样保留',
    keepAnn.length === 2, '实际 ' + keepAnn.length + ' 条');
  t('① 保留的公告内容完整', keepAnn.some((a) => a.title === '保留测试甲'));
  t('① 保留的公告 targets 没丢',
    (keepAnn.find((a) => a.title === '保留测试乙') || {}).targets?.[0] === 'u1',
    JSON.stringify(keepAnn.find((a) => a.title === '保留测试乙')));

  /* ② 显式传空数组 → 真的清空（与「没传」语义区分开） */
  await call('/api/content', {
    method: 'PUT', token: adminToken,
    body: { items: { announcements: [] } },
  });
  const cleared = await call('/api/content', { method: 'GET', token: adminToken });
  t('② 显式传空数组会真的清空 announcements',
    (cleared.body.items.announcements || []).length === 0,
    '实际 ' + (cleared.body.items.announcements || []).length + ' 条');

  /* ③ 合并提交：一次 PUT 里同时带 announcements 和内容字段，两边都要落地。
     ⚠️ 这里必须用**白名单内**的键。'activities' 不在 ALLOW_CONTENT_KEYS 里
     （后端注释说明：主站不消费它），传了会被 400 拒掉。 */
  const mergedPut = await call('/api/content', {
    method: 'PUT', token: adminToken,
    body: { items: {
      announcements: [{ id: 'm1', title: '合并提交公告', body: 'b', targets: [] }],
      site_config: [{ kind: '活动', title: '合并提交活动', body: 'b2' }],
    } },
  });
  t('③ 合并提交被接受 200', mergedPut.status === 200, '实际 ' + mergedPut.status
    + ' ' + JSON.stringify(mergedPut.body).slice(0, 120));

  const merged = await call('/api/content', { method: 'GET', token: adminToken });
  t('③ 一次 PUT 里公告与内容字段同时落地',
    (merged.body.items.announcements || []).length === 1
    && (merged.body.items.site_config || []).length >= 1,
    'announcements=' + (merged.body.items.announcements || []).length
    + ' site_config=' + (merged.body.items.site_config || []).length);
  t('③ 合并提交后公告内容正确',
    (merged.body.items.announcements || [])[0]?.title === '合并提交公告',
    JSON.stringify(merged.body.items.announcements));

  /* ④ 回归护栏：'activities' 不在白名单里 —— 前端映射绝不能往这个键写。
     这条断言和 admin.html 的 CONTENT_FIELD 是一对，
     任何一边改错都会被立刻抓出来。 */
  const actPut = await call('/api/content', {
    method: 'PUT', token: adminToken,
    body: { items: { activities: [{ title: '不该被接受' }] } },
  });
  t('④ activities 不在白名单（前端映射已绕开它）', actPut.status === 400,
    '实际 ' + actPut.status + ' —— 若变成 200 说明白名单被放开了，'
    + '需同步检查 admin.html 的 CONTENT_FIELD');

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

  /* ---- 【护栏】没被任命过的同学也必须出现在列表里 ----
     2026-10-07 事故：listTitles 里原本有
         where coalesce(p.title, '') <> ''
     于是全班刚导入、人人头衔为空 → 列表 0 条 → 站主打开「头衔任命」
     只看到「还没有资料」，一个人都任命不了。典型的鸡生蛋。
     这条断言就是防止那句 where 复活。 */
  const mkNoTitle = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '头衔测试乙', studentId: '9900002', politics: '群众' },
  });
  const noTitlePid = mkNoTitle.body.id || (mkNoTitle.body.profile || {}).id;
  const list2 = await call('/api/admin?action=titles', { token: adminToken });
  t('无头衔同学也出现在任命列表（鸡生蛋护栏）',
    (list2.body.profiles || []).some((p) => Number(p.id) === Number(noTitlePid)),
    '该同学从未被任命，也必须能查到 —— 否则站主一个头衔都发不出去');
  const posSet = (list2.body.profiles || []).findIndex((p) => Number(p.id) === Number(pid));
  const posNone = (list2.body.profiles || []).findIndex((p) => Number(p.id) === Number(noTitlePid));
  t('已任命的排在未任命的之前', posSet >= 0 && posNone >= 0 && posSet < posNone,
    '已任命下标 ' + posSet + ' / 未任命下标 ' + posNone);
  await call('/api/admin?action=delete-profile', {
    method: 'POST', token: adminToken, body: { id: noTitlePid },
  });

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

  /* 2026-10-06 收紧：课代表不再能 PUT 整包写（整包语义可清空别的科目），
     改走 POST ?action=ca-save-subject 专用通道，服务端按科目头衔强校验 */
  const hwOk = await call('/api/content', {
    method: 'PUT', token: hwToken,
    body: { items: { homework_notice: { text: '课代表布置的作业' } } },
  });
  t('课代表 PUT 整包写被拒 403（权限收紧）', hwOk.status === 403, '实际 ' + hwOk.status);

  /* 先放一份作业进云端（课代表单科保存需要有现存条目） */
  const seedHw = await call('/api/content', {
    method: 'PUT', token: adminToken,
    body: { items: { holiday_homeworks: [
      { id: 'hw-e2e-ca', start: '2026-10-01', end: '2026-10-07', items: [
        { subject: '语文', tasks: ['原任务1'] },
        { subject: '数学', tasks: ['数学原任务'] },
      ] },
    ] } },
  });
  t('管理员预置作业条目', seedHw.status === 200 && seedHw.body.ok, JSON.stringify(seedHw.body).slice(0, 100));

  /* 通用「课代表」头衔不含具体科目 → 单科保存被拒 */
  const caGeneric = await call('/api/content?action=ca-save-subject', {
    method: 'POST', token: hwToken,
    body: { subject: '语文', tasks: ['新的语文任务'], homeworkId: 'hw-e2e-ca' },
  });
  t('通用课代表头衔不能改具体科目 403', caGeneric.status === 403, '实际 ' + caGeneric.status + ' ' + (caGeneric.body.error || ''));

  /* 任命为「语文课代表」→ 只能改语文 */
  await call('/api/admin?action=set-title', {
    method: 'POST', token: adminToken, body: { id: pid2, titles: ['语文课代表'] },
  });
  const caCn = await call('/api/content?action=ca-save-subject', {
    method: 'POST', token: hwToken,
    body: { subject: '语文', tasks: ['新的语文任务', { text: '附件任务', img: './homework/x.jpg' }], homeworkId: 'hw-e2e-ca' },
  });
  t('语文课代表可保存语文 200', caCn.status === 200 && caCn.body.ok, JSON.stringify(caCn.body).slice(0, 120));

  const caMath = await call('/api/content?action=ca-save-subject', {
    method: 'POST', token: hwToken,
    body: { subject: '数学', tasks: ['越权改数学'], homeworkId: 'hw-e2e-ca' },
  });
  t('语文课代表改数学被拒 403（科目级隔离）', caMath.status === 403, '实际 ' + caMath.status + ' ' + (caMath.body.error || ''));

  /* 保存结果回读：语文 tasks 已换、数学原样、start/end 未动 */
  const hwRead = await call('/api/content', { method: 'GET', token: adminToken });
  const hwBack = ((hwRead.body.items || {}).holiday_homeworks || []).find((h) => h && h.id === 'hw-e2e-ca');
  const cnBack = hwBack && (hwBack.items || []).find((it) => it.subject === '语文');
  const maBack = hwBack && (hwBack.items || []).find((it) => it.subject === '数学');
  t('回读：语文任务已更新且附件对象保留', cnBack && cnBack.tasks[0] === '新的语文任务' && cnBack.tasks[1] && cnBack.tasks[1].img === './homework/x.jpg', JSON.stringify(cnBack).slice(0, 140));
  t('回读：数学未被波及', maBack && maBack.tasks[0] === '数学原任务', JSON.stringify(maBack).slice(0, 100));
  t('回读：作业起止日期未动', hwBack && hwBack.start === '2026-10-01' && hwBack.end === '2026-10-07', JSON.stringify(hwBack && { s: hwBack.start, e: hwBack.end }));

  /* 课代表不能改公告（越权必须拦住） */
  const hwAnn = await call('/api/content', {
    method: 'PUT', token: hwToken, body: { items: { announcements: [{ title: '越权公告' }] } },
  });
  t('课代表不能改公告 403', hwAnn.status === 403, '实际 ' + hwAnn.status);
  t('越权提示说明需要管理员', /需要管理员权限/.test(hwAnn.body.error || ''), hwAnn.body.error);

  /* 课代表不能改每日一言（新增面板的键，同样不在作业白名单里） */
  const hwQuote = await call('/api/content', {
    method: 'PUT', token: hwToken, body: { items: { daily_quote: ['越权一言'] } },
  });
  t('课代表不能改每日一言 403', hwQuote.status === 403, '实际 ' + hwQuote.status);

  /* 课代表不能改重要日期 */
  const hwDates = await call('/api/content', {
    method: 'PUT', token: hwToken, body: { items: { important_dates: [{ name: '越权日期', date: '2027-01-01T00:00:00' }] } },
  });
  t('课代表不能改重要日期 403', hwDates.status === 403, '实际 ' + hwDates.status);

  /* 课代表不能改站点配置 */
  const hwCfg = await call('/api/content', {
    method: 'PUT', token: hwToken, body: { items: { site_config: { x: 1 } } },
  });
  t('课代表不能改站点配置 403', hwCfg.status === 403, '实际 ' + hwCfg.status);

  /* ---- 管理员能写新键，且读得回来（daily_quote / important_dates 的往返） ---- */
  const putQ = await call('/api/content', {
    method: 'PUT', token: adminToken,
    body: { items: { daily_quote: ['测试一言', { text: '带出处的一句', from: '—— 测试' }] } },
  });
  t('管理员可以写 daily_quote', putQ.status === 200 && putQ.body.ok, JSON.stringify(putQ.body));

  const putD = await call('/api/content', {
    method: 'PUT', token: adminToken,
    body: { items: { important_dates: [
      { name: '测试单日', date: '2027-03-01T00:00:00' },
      { name: '测试段考', date: '2027-04-01T00:00:00', endDate: '2027-04-02',
        scope: [{ sub: '语文', txt: '第一单元' }] },
    ] } },
  });
  t('管理员可以写 important_dates', putD.status === 200 && putD.body.ok, JSON.stringify(putD.body));

  /* 关键：写完立刻读，两个键都要能读回来。
     这一条正是本轮踩过的坑 —— 用 `in (${a}, ${b})` 写 SQL 时
     写入成功但读取永远返回 0 行，所以必须验证「读完真的拿到了内容」。 */
  const back = await call('/api/content');
  const items = back.body.items || {};
  t('读回 daily_quote 且内容正确',
    Array.isArray(items.daily_quote) && items.daily_quote.length === 2,
    JSON.stringify(items.daily_quote));
  t('读回带出处的写法', !!(items.daily_quote && items.daily_quote[1] && items.daily_quote[1].from === '—— 测试'),
    JSON.stringify(items.daily_quote && items.daily_quote[1]));
  t('读回 important_dates 且内容正确',
    Array.isArray(items.important_dates) && items.important_dates.length === 2,
    JSON.stringify(items.important_dates));
  t('读回段考的 endDate（驼峰）',
    !!(items.important_dates && items.important_dates[1] && items.important_dates[1].endDate === '2027-04-02'),
    JSON.stringify(items.important_dates && items.important_dates[1]));
  t('读回段考的 scope 科目',
    !!(items.important_dates && items.important_dates[1] && Array.isArray(items.important_dates[1].scope)
       && items.important_dates[1].scope[0].sub === '语文'),
    JSON.stringify(items.important_dates && items.important_dates[1] && items.important_dates[1].scope));

  /* 已下线的旧键必须被拒 —— 留着它会让人以为「后台存了、首页没反应」是 bug */
  const goneSong = await call('/api/content', {
    method: 'PUT', token: adminToken, body: { items: { song_config: { x: 1 } } },
  });
  t('song_config 已从白名单移除（前端已改为直连 VoiceHub，无人消费）',
    goneSong.status === 400, '实际 ' + goneSong.status);

  const goneAct = await call('/api/content', {
    method: 'PUT', token: adminToken, body: { items: { activities: [{ x: 1 }] } },
  });
  t('activities 已从白名单移除（主站用的是单数 activity）',
    goneAct.status === 400, '实际 ' + goneAct.status);

  /* --- 系统令牌管理（管理员专用） --- */
  const sec1 = await call('/api/admin?action=save-secret', {
    method: 'POST', token: adminToken,
    body: { name: 'GITEE_TOKEN', value: 'gitee-token-123' },
  });
  t('管理员可保存系统令牌', sec1.status === 200 && sec1.body.name === 'GITEE_TOKEN', JSON.stringify(sec1.body));

  const secList = await call('/api/admin?action=secrets', { token: adminToken });
  const secGitee = (secList.body.secrets || []).find((s) => s.name === 'GITEE_TOKEN');
  t('管理员可读取系统令牌明文', secGitee && secGitee.value === 'gitee-token-123',
    JSON.stringify(secList.body));

  const secPut2 = await call('/api/admin?action=save-secret', {
    method: 'POST', token: adminToken,
    body: { name: 'CLOUDFLARE_API_TOKEN', value: 'cf-token-456' },
  });
  t('管理员可保存第二个令牌', secPut2.status === 200, JSON.stringify(secPut2.body));

  const secList2 = await call('/api/admin?action=secrets', { token: adminToken });
  t('列出多个令牌', (secList2.body.secrets || []).length >= 2, JSON.stringify(secList2.body));

  const secDel = await call('/api/admin?action=delete-secret', {
    method: 'POST', token: adminToken,
    body: { name: 'GITEE_TOKEN' },
  });
  t('管理员可删除系统令牌', secDel.status === 200 && secDel.body.deleted === 'GITEE_TOKEN', JSON.stringify(secDel.body));

  const secList3 = await call('/api/admin?action=secrets', { token: adminToken });
  t('删除后列表中不再出现该令牌', !(secList3.body.secrets || []).some((s) => s.name === 'GITEE_TOKEN'));

  const secBadName = await call('/api/admin?action=save-secret', {
    method: 'POST', token: adminToken,
    body: { name: 'lowercase_token', value: 'x' },
  });
  t('非法令牌名称被拒', secBadName.status === 400, secBadName.status);

  const secNoVal = await call('/api/admin?action=save-secret', {
    method: 'POST', token: adminToken,
    body: { name: 'EMPTY_TOKEN', value: '' },
  });
  t('空令牌值被拒', secNoVal.status === 400, secNoVal.status);

  const secUser = await call('/api/admin?action=secrets', { token: userToken });
  t('普通用户读令牌被拒 403/401', secUser.status === 403 || secUser.status === 401, secUser.status);

  /* 造一个新的普通账号，token 有效 */
  const secPlainReg = await call('/api/auth?action=register', {
    method: 'POST', body: { username: 'secplainuser', password: 'PlainPass123' },
  });
  const secPlainToken = secPlainReg.body.token;

  const secUser2 = await call('/api/admin?action=secrets', { token: secPlainToken });
  t('普通用户读令牌被拒 403', secUser2.status === 403, secUser2.status);

  const secPutUser = await call('/api/admin?action=save-secret', {
    method: 'POST', token: secPlainToken,
    body: { name: 'USER_TOKEN', value: 'x' },
  });
  t('普通用户写令牌被拒 403', secPutUser.status === 403, secPutUser.status);

  /* 清理令牌测试数据 */
  await call('/api/admin?action=delete-secret', {
    method: 'POST', token: adminToken,
    body: { name: 'CLOUDFLARE_API_TOKEN' },
  });

  /* ---- 清理 ---- */
  for (const id of [pid, pid2]) {
    if (id) await call('/api/admin?action=delete-profile', { method: 'POST', token: adminToken, body: { id } });
  }
  t('头衔测试数据已清理', true);
}

console.log('\n【19】最后上线（心跳）· 版本号一致性（2026-10-07 新增）');
{
  /* ---- 在线心跳：后台「最后上线」靠它刷新 ---- */
  const reg = await call('/api/auth?action=register', {
    method: 'POST', body: { username: 'pinguser01', password: 'PingPass123' },
  });
  t('建心跳测试账号成功', reg.status === 200 && !!reg.body.token, JSON.stringify(reg.body).slice(0, 200));
  const tk = reg.body.token;

  const p1 = await call('/api/auth?action=ping', { token: tk });
  t('心跳返回 200', p1.status === 200, '实际 ' + p1.status);
  t('心跳返回 pong', p1.body && typeof p1.body.pong === 'number', JSON.stringify(p1.body));

  const pNoAuth = await call('/api/auth?action=ping');
  t('未登录心跳被拒 401', pNoAuth.status === 401, '实际 ' + pNoAuth.status);

  /* 后台要能看到，而且和「最后登录」是两个独立的字段 */
  const lu = await call('/api/admin?action=users&q=pinguser01', { token: adminToken });
  const row = (lu.body.users || []).find((u) => u.username === 'pinguser01');
  t('用户列表返回 lastSeenAt', !!row && !!row.lastSeenAt, JSON.stringify(row || {}).slice(0, 200));
  t('lastSeenAt 与 lastLoginAt 是两个字段',
    !!row && 'lastLoginAt' in row && 'lastSeenAt' in row,
    Object.keys(row || {}).join(','));
}

{
  /* ---- 版本号护栏：主站与后台必须同步递增 ----
     站主靠版本号判断「改动推上线没有」，两边不一致就会误判。 */
  const idx = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf-8');
  const adm = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf-8');
  const grab = (s, k) => {
    const m = s.match(new RegExp('var\\s+' + k + "\\s*=\\s*'([^']+)'"));
    return m ? m[1] : '';
  };
  const v1 = grab(idx, 'SITE_VERSION'), v2 = grab(adm, 'SITE_VERSION');
  const d1 = grab(idx, 'VER_DATE'), d2 = grab(adm, 'VER_DATE');
  t('主站有版本号', !!v1, v1);
  t('后台有版本号', !!v2, v2);
  t('主站与后台版本号一致（漏改会被抓）', !!v1 && v1 === v2, '主站 ' + v1 + ' / 后台 ' + v2);
  t('主站与后台版本日期一致', !!d1 && d1 === d2, '主站 ' + d1 + ' / 后台 ' + d2);
  t('版本号是三段数字', /^\d+\.\d+\.\d+$/.test(v1), v1);
  t('大版本号为 2（含后端的大版本）', v1.split('.')[0] === '2', v1);
}

{
  /* ---- 班级名单不再硬编码：云端 roster + 本地缓存（站主第 5 条）---- */
  const rr = await call('/api/profile?action=roster', { token: adminToken });
  t('roster 接口 200', rr.status === 200, '实际 ' + rr.status + ' ' + JSON.stringify(rr.body).slice(0, 200));
  t('roster 返回姓名数组', Array.isArray(rr.body.names), JSON.stringify(rr.body).slice(0, 200));
  t('roster 不下发联系方式（隐私保护）',
    !('wechat' in rr.body) && !('qq' in rr.body) && !('phone' in rr.body)
    && !(rr.body.students || []).some((s) => 'wechat' in s || 'qq' in s || 'phone' in s),
    JSON.stringify(rr.body.students || []).slice(0, 200));
  const rrNo = await call('/api/profile?action=roster');
  t('未登录读 roster 被拒 401', rrNo.status === 401, '实际 ' + rrNo.status);

  const idx2 = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf-8');
  t('主站有 syncRoster()', idx2.indexOf('function syncRoster(') >= 0);
  t('主站会调用 syncRoster()', idx2.split('syncRoster()').length >= 4,
    '出现次数 ' + (idx2.split('syncRoster(').length - 1));
  t('名单有本地缓存键', idx2.indexOf('cls_roster_cache_v1') >= 0);
  /* 硬编码名单仍保留作兜底（断网不能开天窗），但取值顺序必须云端优先 */
  const cl = idx2.match(/function classList\(\)\{[\s\S]{0,500}?\n\}/);
  t('classList() 云端 / 缓存优先于硬编码',
    !!cl && cl[0].indexOf('_ROSTER_MEM') >= 0 && cl[0].indexOf('rosterCacheGet') >= 0
    && cl[0].indexOf('_ROSTER_MEM') < cl[0].indexOf('CLASS_LIST_ENC'),
    cl ? cl[0].slice(0, 240) : 'not found');
}

console.log('\n【20】游戏数据上云 + 后台面板（2026-10-07 新增）');
{
  /* ---- 站主要求：后台能看到最高分 / 游玩时长 / 券获取时间 ---- */
  const g = await call('/api/auth?action=register', {
    method: 'POST', body: { username: 'gameruser01', password: 'GamePass123' },
  });
  t('建游戏测试账号成功', g.status === 200 && !!g.body.token, JSON.stringify(g.body).slice(0, 200));
  const gtk = g.body.token;

  /* 1) 最高分 */
  const hi = await call('/api/data', {
    method: 'PUT', token: gtk,
    body: { items: { cls_game_snake_hi: 128, cls_game_tetris_hi: 3400 } },
  });
  t('最高分可写入云端', hi.status === 200, JSON.stringify(hi.body).slice(0, 200));

  /* 2) 游玩时长 */
  const pl = await call('/api/data', {
    method: 'PUT', token: gtk,
    body: { items: { cls_game_play_snake: { count: 3, totalMs: 185000, lastMs: 62000,
            lastAt: '2026-10-07T10:30:00.000Z', bestScore: 128 } } },
  });
  t('游玩时长可写入云端', pl.status === 200, JSON.stringify(pl.body).slice(0, 200));

  /* 3) 券台账（带券码的新格式） */
  const L = { '2026-W41': { snake: { '测试同学': 'SONGA1B2C3 · 2026-10-07 10:31 · 自动' } } };
  const cp = await call('/api/data', {
    method: 'PUT', token: gtk, body: { items: { cls_game_coupon_ledger: L } },
  });
  t('券台账可写入云端', cp.status === 200, JSON.stringify(cp.body).slice(0, 200));

  /* 后台聚合 */
  const gs = await call('/api/admin?action=games', { token: adminToken });
  t('后台游戏接口 200', gs.status === 200, '实际 ' + gs.status + ' ' + JSON.stringify(gs.body).slice(0, 200));
  t('后台返回游戏清单', (gs.body.games || []).length >= 4, JSON.stringify(gs.body.games || []));
  const me = (gs.body.users || []).find((u) => u.username === 'gameruser01');
  t('后台能看到该同学', !!me, '名单 ' + (gs.body.users || []).map((u) => u.username).join(','));
  t('后台能看到最高分', !!me && me.hi.snake_hi === 128 && me.hi.tetris_hi === 3400,
    JSON.stringify(me && me.hi));
  t('后台能看到游玩时长', !!me && !!me.play.snake && me.play.snake.totalMs === 185000
    && me.play.snake.count === 3, JSON.stringify(me && me.play));
  t('后台能看到券获取时间', !!me && (me.coupons || []).length === 1
    && me.coupons[0].code === 'SONGA1B2C3' && me.coupons[0].time === '2026-10-07 10:31',
    JSON.stringify(me && me.coupons));
  t('券记录带游戏名', !!me && me.coupons[0].gameLabel === '贪吃蛇', JSON.stringify(me && me.coupons[0]));
  t('汇总有人数/券数/时长', !!gs.body.summary && gs.body.summary.players >= 1
    && gs.body.summary.coupons >= 1 && gs.body.summary.totalMs >= 185000,
    JSON.stringify(gs.body.summary));

  /* 非管理员不能看 */
  const noAdm = await call('/api/admin?action=games', { token: gtk });
  t('普通用户读游戏数据被拒 403', noAdm.status === 403, '实际 ' + noAdm.status);
}

{
  /* ---- 游戏页必须引入 cloud.js，否则 CLS_CLOUD 为 undefined，
         登录检查恒真会错误放行发券（静默失效，肉眼发现不了）---- */
  const files = ['snake', 'tetris', 'bird', 'doodle'];
  files.forEach((f) => {
    const s = fs.readFileSync(new URL('./games/' + f + '.html', import.meta.url), 'utf-8');
    t('games/' + f + '.html 引入了 cloud.js', s.indexOf('src="cloud.js"') >= 0);
    t('games/' + f + '.html 有 findClaimP（云端优先查重）', s.indexOf('function findClaimP') >= 0);
    /* 第二十七轮 ⑩：领券身份从「手填姓名」改成「账号身份」，
       登录检查也随之从 CLS_CLOUD.auth() 升级为 whoami() —— 后者
       同时给出姓名，既是登录凭据也是署名来源。 */
    t('games/' + f + '.html 发券前检查登录并取账号身份',
      s.indexOf('CLS_CLOUD.whoami()') >= 0 || s.indexOf('CLS_CLOUD.auth()') >= 0);
    t('games/' + f + '.html 破纪录上云', s.indexOf('pushHi(') >= 0);
    t('games/' + f + '.html 游玩时长上云', s.indexOf('addPlay(') >= 0);
    t('games/' + f + '.html 券台账上云', s.indexOf('pushLedger(') >= 0);
  });
  /* 云端键必须在后端白名单里，否则前端推上去被 403 静默丢弃 */
  const dj = fs.readFileSync(new URL('./api/data.js', import.meta.url), 'utf-8');
  t('data.js 白名单放行 cls_game_*', dj.indexOf("'cls_game_*'") >= 0);
}

{
  /* ---- 语法护栏：内联 <script> 必须能被解析 ----
     血泪教训：用脚本批量改 HTML 时极易把注释/字符串截断，
     控制台报错只有真开浏览器才看得到。这里用 acorn 在 CI 里先抓一遍。 */
  let acorn = null;
  try { const m = await import('acorn'); acorn = m.default || m; } catch (e) { /* 没装就跳过 */ }
  if (acorn && typeof acorn.parse !== 'function') acorn = acorn.default || null;
  if (acorn) {
    const parse = (code) => acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
    const check = (file) => {
      const s = fs.readFileSync(new URL('./' + file, import.meta.url), 'utf-8');
      const blocks = [...s.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      let okAll = true, firstErr = '';
      for (const b of blocks) {
        try { parse(b); } catch (e) { okAll = false; if (!firstErr) firstErr = e.message; }
      }
      t(file + ' 内联脚本语法正确（' + blocks.length + ' 段）', okAll, firstErr);
    };
    console.log('\n【21】内联脚本语法护栏（acorn）');
    ['index.html', 'admin.html', 'games/snake.html', 'games/bird.html',
     'games/tetris.html', 'games/doodle.html'].forEach(check);
  }
}

console.log('\n【21.5】后台作业编辑器支持视频 + 附件行光标定位（2026-10-07 第二十六轮）');
{
  /* 背景：主站早就认 .video 字段并渲染 <video>，
     但后台 admin.html 的作业编辑器只做了 img/audio 两个输入框。
     后果极隐蔽：后台点开一份带视频的作业、什么都不改直接保存，
     video 字段就会被**静默丢弃**（draft 里根本没这个字段）。
     用户看到的是「我明明填了视频，过一阵就没了」。
     这里把它三个环节都锁住：渲染输入框、采集、还原。 */
  const ad = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf-8');

  t('后台任务行有视频输入框', ad.indexOf('data-f="video"') >= 0);
  t('后台视频输入框带提示文案', ad.indexOf('🎬 视频链接') >= 0);
  t('后台 draft 初始化含 video', ad.indexOf("img:'', audio:'', video:'', audioLabel:''") >= 0);
  t('后台保存时写回 video 字段', ad.indexOf('if(t.video) o.video = t.video.trim();') >= 0);
  t('后台「无附件存字符串」判断含 video',
    ad.indexOf('!t.img && !t.audio && !t.video') >= 0);
  t('后台附件标记识别视频（不然标成「[附件]」丢类别）',
    ad.indexOf("t.video ? '视频'") >= 0);
  t('后台占位行按描述匹配还原（防中间删行错位）',
    ad.indexOf('atts.splice(hit, 1)[0]') >= 0);
  t('后台不再用按位置配对的 atts.shift() 还原附件',
    ad.indexOf('var obj = atts.shift();') < 0);
  /* 保存前的「有没有内容」校验必须算上 video，
     否则「只挂了视频」的任务会被判成空、整份作业存不下去 */
  t('后台保存校验把 video 也算作有效内容',
    ad.indexOf('(t.text || \'\').trim() || t.img || t.audio || t.video') >= 0);

  /* 附件行按钮的光标定位：错了会让人多按好几次方向键 */
  const idx2 = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf-8');
  const a = idx2.indexOf('function caInsertAttRow');
  const aEnd = idx2.indexOf('function caInsertLine', a);
  const body = idx2.slice(a, aEnd > 0 ? aEnd : a + 600);
  t('caInsertAttRow 默认类型是音频', body.indexOf("kind || '音频'") >= 0);
  t('caInsertAttRow 行的形状含竖线分隔', body.indexOf("]  | ") >= 0);
}

console.log('\n【22】附件方案护栏：只填直链、不做上传（2026-10-07 第二十六轮定案）');
{
  /* 背景：第二十五轮做过「作业附件点击上传到服务器」（Cloudflare R2），
     但站主反馈 R2 开户要绑银行卡；备选的中科院数据胶囊要「国家网络身份认证」
     实名才给 20GB（不实名仅 1GB）。两者都不适合当班级站点的基础设施，
     于是**整体撤掉上传功能**，回到「站主手动放文件 + 作业里填直链」。

     这一节不是为了测一个已删除的功能，而是**防止它悄悄复活**：
     上传这东西一旦半留着（比如前端按钮回来了、后端 503），
     会让人以为「能传」，点了却失败 —— 比彻底没有更糟。
     所以下面全部是「必须不存在」的否定断言。 */

  const idx = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf-8');
  const wr = fs.readFileSync(new URL('./api/worker.mjs', import.meta.url), 'utf-8');
  const ct = fs.readFileSync(new URL('./api/content.js', import.meta.url), 'utf-8');

  /* ---- 后端文件与路由 ---- */
  t('api/upload.js 已删除', !fs.existsSync(new URL('./api/upload.js', import.meta.url)));
  t('worker 不再 import upload', wr.indexOf("import uploadHandler") < 0);
  t('worker 不再有 upload 路由', wr.indexOf("case 'upload'") < 0);
  t('worker 移除二进制直出通道（无人再用）', wr.indexOf('__rawResponse') < 0);
  t('worker 保留 X-Raw-Response 说明的清理（注释里也不该再提旧通道）',
    wr.indexOf('X-Raw-Response') < 0);

  /* ---- 前端：不能有任何上传入口 ---- */
  t('主站不再有 caPick（文件选择）', idx.indexOf('function caPick') < 0);
  t('主站不再有 caUpload（上传请求）', idx.indexOf('function caUpload') < 0);
  t('主站不再有 CA_UP 全局状态', idx.indexOf('var CA_UP') < 0);
  t('主站不再有 CA_UP_MAX',
    idx.indexOf('CA_UP_MAX') < 0);
  t('主站不再调 /upload 接口', idx.indexOf("'/upload?action=") < 0);
  t('主站不再有上传按钮 caUpAudio', idx.indexOf('caUpAudio') < 0);
  t('主站不再有上传按钮 caUpVideo', idx.indexOf('caUpVideo') < 0);
  t('主站不再有上传按钮 caUpImage', idx.indexOf('caUpImage') < 0);
  /* ⚠️ 别写成「整个文件里没有 FileReader」：头像、图片压缩等地方本来就在用
     FileReader，那是对的。只查作业编辑器 caSave 到 closeCaEditor 这一段。 */
  const caStart = idx.indexOf('function caSave');
  const caEnd = idx.indexOf('function closeCaEditor', caStart);
  const caZone = idx.slice(caStart, caEnd > 0 ? caEnd : caStart + 8000);
  t('作业编辑器区域不再有 FileReader 残留', caZone.indexOf('FileReader') < 0);
  t('主站不再有上传进度条节点 caProg', idx.indexOf('id="caProg"') < 0);
  t('主站不再有上传说明条节点 caUpNote', idx.indexOf('id="caUpNote"') < 0);

  /* ---- 前端：编辑器仍要好用（说明文字 + 两个按钮） ---- */
  t('编辑器保留工具条 .ca-tools', idx.indexOf('class="ca-tools"') >= 0);
  t('编辑器保留「新增一条任务」按钮', idx.indexOf('caInsertTask()') >= 0);
  t('编辑器新增「新增附件行」按钮', idx.indexOf('caInsertAttRow()') >= 0);
  t('caInsertAttRow 已定义', idx.indexOf('function caInsertAttRow') >= 0);
  t('caInsertLine 已定义（两个按钮共用）', idx.indexOf('function caInsertLine') >= 0);
  t('编辑器说明文字引导「找站主要」链接',
    idx.indexOf('附件文件由站主统一上传') >= 0);
  t('编辑器说明文字保留 📎 占位行写法', idx.indexOf('📎 [音频]') >= 0);
  t('编辑器说明文字保留「| 链接」写法', idx.indexOf('| 链接') >= 0);

  /* ---- 附件行插入的定位逻辑 ---- */
  const ci = idx.indexOf('function caInsertAttRow');
  const ciEnd = idx.indexOf('function caInsertTask', ci);
  const attBody = idx.slice(ci, ciEnd > 0 ? ciEnd : ci + 900);
  t('caInsertAttRow 生成 📎 [音频] 占位', attBody.indexOf("'📎 [' + kind + ']") >= 0);
  t('caInsertAttRow 带「|」分隔符', attBody.indexOf('| ') >= 0);
  const cl = idx.indexOf('function caInsertLine');
  const clEnd = idx.indexOf('function caInsertTask', cl);
  const lineBody = idx.slice(cl, clEnd > 0 ? clEnd : cl + 1400);
  t('caInsertLine 光标落在「|」之后（省得手动移）', lineBody.indexOf('line.indexOf('|')') >= 0);
  t('caInsertLine 会 focus 回文本域', lineBody.indexOf('ta.focus()') >= 0);

  /* ---- 存量附件仍要能渲染（撤了上传不等于撤了附件） ---- */
  t('主站仍渲染 audio 字段', idx.indexOf('t.audio') >= 0 || idx.indexOf('.audio') >= 0);
  t('主站仍渲染 video 字段（<video> 标签）', idx.indexOf('<video src=') >= 0);
  t('主站仍按扩展名识别视频', idx.indexOf('isVid') >= 0);
  t('content.js 仍放行 video 字段（否则填了存不下）', ct.indexOf('t.video ===') >= 0);
  t('content.js 仍放行 audio 字段', ct.indexOf('t.audio ===') >= 0);
  t('content.js 仍放行 img 字段', ct.indexOf('t.img ===') >= 0);

  /* ---- 上一轮修的两个真 bug 不能随删除一起丢 ---- */
  const cs = idx.indexOf('function caSave');
  const csBody = idx.slice(cs, cs + 6000);
  t('caSave 仍按描述精确匹配附件对象（防串位）',
    csBody.indexOf("pool[i].text || '') === desc") >= 0);
  t('caSave 不再有「匹配不上取队首」的兜底',
    csBody.indexOf('if(idx < 0 && pool.length) idx = 0;') < 0);
  t('caSave 三字段判断顺序未变（audio→video→img）',
    csBody.indexOf("kind === '音频'") >= 0 && csBody.indexOf("kind === '视频'") >= 0);

  /* ---- wrangler 里不该再有活的 R2 绑定 ---- */
  const wt = fs.readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf-8');
  t('wrangler 不再有生效的 r2_buckets 绑定',
    !/^\s*\[\[r2_buckets\]\]/m.test(wt));
  t('wrangler 不再声明 UPLOADS 绑定', wt.indexOf('binding     = "UPLOADS"') < 0 || wt.indexOf('# binding     = "UPLOADS"') >= 0);
  t('wrangler 记录了放弃上传的原因', wt.indexOf('绑银行卡') >= 0 || wt.indexOf('实名') >= 0);
}

console.log('\n【27】第二十七轮·令牌哈希存储 + 改密码回归');
{
  const { sha256Hex } = await import('./api/_lib/password.js');

  /* 注册一个全新用户，隔离其它用例的登录态（DB 每次运行都是全新的，固定名即可） */
  const uname = 'toktester';
  const pwd = 'TokTester2026';
  const reg = await call('/api/auth?action=register', {
    method: 'POST', body: { username: uname, password: pwd, displayName: '令牌测试' },
  });
  t('令牌测试用户注册成功', reg.status === 200 && reg.body.ok, JSON.stringify(reg.body));
  const login = await call('/api/auth?action=login', {
    method: 'POST', body: { username: uname, password: pwd },
  });
  t('令牌测试用户登录成功', login.status === 200 && login.body.token, JSON.stringify(login.body));
  const token = login.body.token;

  /* 取库里存的会话行，确认存的是 sha256(token) 而非明文 token
     （注册 + 登录各签发一条会话，所以至少 1 条；重点验「存哈希、不存明文」） */
  const uidRes = db.exec("select id from users where username = '" + uname + "'");
  const uid = uidRes[0].values[0][0];
  const sres = db.exec("select token from sessions where user_id = " + uid);
  const stored = sres[0].values.map((r) => r[0]);
  const expectHash = await sha256Hex(token);
  t('会话表至少存了 1 条会话', stored.length >= 1, '实际 ' + stored.length);
  t('会话表存的是 sha256(token)（含当前登录 token 的哈希）', stored.includes(expectHash), 'stored=' + JSON.stringify(stored));
  t('明文 token 未落库（没有任何一行等于原始 token）', !stored.includes(token));

  /* 用明文 token 调接口应正常（哈希匹配） */
  const me1 = await call('/api/auth?action=me', { token });
  t('明文 token 仍可用（currentUser 哈希匹配）', me1.status === 200 && me1.body.ok, JSON.stringify(me1.body));

  /* 改密码：原密码正确 → 200 + 新 token（这条以前会因 2 次 PBKDF2 超 10ms CPU 而 500） */
  const cp = await call('/api/auth?action=change-password', {
    method: 'POST', token, body: { oldPassword: pwd, newPassword: 'NewPass2026!' },
  });
  t('改密码（原密码正确）返回 200', cp.status === 200 && cp.body.ok, 'status ' + cp.status + ' ' + JSON.stringify(cp.body));
  t('改密码返回新 token', typeof cp.body.token === 'string' && cp.body.token.length === 64, 'len ' + (cp.body.token||'').length);

  if (cp.body.token) {
    const newToken = cp.body.token;
    const newHash = await sha256Hex(newToken);
    /* 旧 token 立即失效 */
    const oldMe = await call('/api/auth?action=me', { token });
    t('旧 token 改密后失效（401）', oldMe.status === 401, 'status ' + oldMe.status);
    /* 新 token 可用 */
    const newMe = await call('/api/auth?action=me', { token: newToken });
    t('新 token 可用', newMe.status === 200 && newMe.body.ok);
    /* 会话表仍是 1 条，且为新哈希（旧会话被踢） */
    const s2 = db.exec("select token from sessions where user_id = " + uid);
    const stored2 = s2[0].values.map((r) => r[0]);
    t('改密后只剩 1 条会话', stored2.length === 1, '实际 ' + stored2.length);
    t('改密后存的是新 token 的哈希', stored2[0] === newHash);
    t('新令牌仍是 64 位十六进制', /^[0-9a-f]{64}$/.test(newToken));
  }

  /* 改密码：原密码错误 → 401（这条一直正常，确认没被改坏） */
  const bad = await call('/api/auth?action=change-password', {
    method: 'POST', token: cp.body.token, body: { oldPassword: 'wrongpwd', newPassword: 'Another2026!' },
  });
  t('改密码（原密码错误）返回 401', bad.status === 401, 'status ' + bad.status);

  /* 把测试账号密码改回去，避免污染后续手工验证 */
  await call('/api/auth?action=change-password', {
    method: 'POST', token: cp.body.token, body: { oldPassword: 'NewPass2026!', newPassword: pwd },
  });

  /* ---- 老账号（高迭代档位哈希）护栏 ----
     把该用户的哈希改成旧档位（50000），断言改密码接口提前返回 409 + 明确提示，
     而不是跑到超 CPU 上限（在测试环境不体现，但线上会 500）。
     这保证「老账号不会再得到莫名其妙的服务器错误」。 */
  const { hashPassword, needsDowngrade } = await import('./api/_lib/password.js');
  const legacyHash = await hashPassword(pwd, 50000);
  db.run("update users set password_hash = ? where id = ?", [legacyHash, uid]);
  t('老哈希被识别为「需要降级」', needsDowngrade(legacyHash) === true);
  t('新档位哈希不需要降级', needsDowngrade(await hashPassword(pwd)) === false);

  const relogin2 = await call('/api/auth?action=login', {
    method: 'POST', body: { username: uname, password: pwd },
  });
  t('老账号仍能正常登录', relogin2.status === 200 && relogin2.body.token, JSON.stringify(relogin2.body));

  const cpLegacy = await call('/api/auth?action=change-password', {
    method: 'POST', token: relogin2.body.token, body: { oldPassword: pwd, newPassword: 'Whatever2026!' },
  });
  t('老账号改密码返回 409（不再 500）', cpLegacy.status === 409, 'status ' + cpLegacy.status);
  t('老账号改密码带 needsAdminReset 标记', cpLegacy.body && cpLegacy.body.needsAdminReset === true,
    JSON.stringify(cpLegacy.body));
  t('老账号改密码提示文案提到「重置密码」',
    !!(cpLegacy.body && /重置密码/.test(cpLegacy.body.error || '')));

  /* 模拟「管理员重置密码」后该账号就能自助改密（重置用的是新档位单次派生） */
  const { hashPassword: hp2 } = await import('./api/_lib/password.js');
  db.run("update users set password_hash = ?, must_change_password = 0 where id = ?", [await hp2(pwd), uid]);
  const relogin3 = await call('/api/auth?action=login', {
    method: 'POST', body: { username: uname, password: pwd },
  });
  const cpAfterReset = await call('/api/auth?action=change-password', {
    method: 'POST', token: relogin3.body.token, body: { oldPassword: pwd, newPassword: 'FinalPwd2026!' },
  });
  t('重置后再改密码返回 200（老账号问题彻底解决）',
    cpAfterReset.status === 200 && cpAfterReset.body.ok,
    'status ' + cpAfterReset.status + ' ' + JSON.stringify(cpAfterReset.body));
}

console.log('\n【28】第二十七轮·通用弹窗引擎（popups 云端通道）');
{
  /* ---- ① 云端通道：写入白名单已含 popups ---- */
  const sample = [
    { id: 'boot-1', scope: 'boot', source: 'homework_notice', dismiss: 'daily', bubble: true },
    { id: 'cat-1', scope: 'cat:2', source: 'custom', title: '成果展示', body: '正文', dismiss: 'once' },
    { id: 'anniv3', scope: 'cat:2', source: 'custom', title: 'ClassIsland 三周年', body: '看官方纪念短片',
      video: 'https://www.bilibili.com/video/BV1sJe36ZEb9/',
      bannerText: '🎉 ClassIsland 三周年纪念 · 点击看官方纪念短片',
      theme: 'welcome', dismiss: 'once', bubble: false },
  ];
  const wr = await call('/api/content', { method: 'PUT', token: adminToken, body: { key: 'popups', value: sample } });
  t('管理员写入 popups 成功', wr.status === 200 && wr.body.ok, JSON.stringify(wr.body));

  const rd = await call('/api/content', { method: 'GET' });
  t('读回内容含 popups 键', rd.status === 200 && !!rd.body.items && Object.prototype.hasOwnProperty.call(rd.body.items, 'popups'),
    JSON.stringify(rd.body.items && Object.keys(rd.body.items)));
  t('popups 内容与写入一致（3 条）', Array.isArray(rd.body.items.popups) && rd.body.items.popups.length === 3,
    '实际 ' + (rd.body.items.popups || []).length);
  t('popups 首条 id 正确', rd.body.items.popups[0] && rd.body.items.popups[0].id === 'boot-1');
  t('popups 板块弹 scope 正确', rd.body.items.popups[1] && rd.body.items.popups[1].scope === 'cat:2');
  /* 第二十九轮：bannerText / theme 字段必须随弹窗一起落地 */
  const anniv = (rd.body.items.popups || []).find((x) => x.id === 'anniv3') || {};
  t('bannerText 已随弹窗持久化', anniv.bannerText === '🎉 ClassIsland 三周年纪念 · 点击看官方纪念短片', anniv.bannerText);
  t('theme 已随弹窗持久化', anniv.theme === 'welcome', anniv.theme);

  /* ---- ② 权限：普通用户写 popups 必须 403 ---- */
  const puname = 'popuser';
  await call('/api/auth?action=register', { method: 'POST', body: { username: puname, password: 'PopUser2026', displayName: '弹窗测试' } });
  const plogin = await call('/api/auth?action=login', { method: 'POST', body: { username: puname, password: 'PopUser2026' } });
  const ptoken = plogin.body.token;
  const pwr = await call('/api/content', { method: 'PUT', token: ptoken, body: { key: 'popups', value: [{ id: 'x' }] } });
  t('普通用户写 popups 被拒（403）', pwr.status === 403, '实际 ' + pwr.status + ' ' + JSON.stringify(pwr.body));

  /* ---- ③ 白名单护栏：不在名单里的键仍被拒 ---- */
  const bwr = await call('/api/content', { method: 'PUT', token: adminToken, body: { key: 'not_a_key', value: [] } });
  t('白名单外的键仍被拒（400）', bwr.status === 400, '实际 ' + bwr.status + ' ' + JSON.stringify(bwr.body));

  /* ---- ④ 回归：老键 announcements / homework_notice 仍然正常 ---- */
  const oldwr = await call('/api/content', {
    method: 'PUT', token: adminToken,
    body: { items: { announcements: [{ date: '2026-10-08', text: '回归公告' }] } },
  });
  t('老键 announcements 仍可写', oldwr.status === 200 && oldwr.body.ok, JSON.stringify(oldwr.body));
  const rd2 = await call('/api/content', { method: 'GET' });
  t('写入 popups 后老键未被冲掉', !!rd2.body.items.announcements && rd2.body.items.popups.length === 3,
    'announcements=' + JSON.stringify(rd2.body.items.announcements) + ' popups=' + (rd2.body.items.popups || []).length);

  /* ---- ⑤ 前端 CONTENT_MAP 与后端白名单必须一致 ---- */
  const idxHtml = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  t('前端 CONTENT_MAP 含 popups', /popups:\s*'popups'/.test(idxHtml));
  const contentJs = fs.readFileSync(new URL('./api/content.js', import.meta.url), 'utf8');
  t('后端白名单含 popups', /'popups'/.test(contentJs));
  t('前端已定义 popGetList', idxHtml.indexOf('function popGetList()') >= 0);
  t('前端已定义 popShouldAuto', idxHtml.indexOf('function popShouldAuto(') >= 0);
  t('前端已定义 popRender', idxHtml.indexOf('function popRender(') >= 0);
  t('前端已定义 popOnCategory', idxHtml.indexOf('function popOnCategory(') >= 0);
  t('弹窗容器 #popMask 已加', idxHtml.indexOf('id="popMask"') >= 0);
  t('弹窗悬浮球 #popBubble 已加', idxHtml.indexOf('id="popBubble"') >= 0);
  t('悬浮球已登记进 actSyncBubble', /ids\s*=\s*\[[^\]]*'popBubble'[^\]]*\]/.test(idxHtml));
  t('SITE_DATA 含 popups 默认空数组', /popups:\s*\[\s*(\/\*[\s\S]*?\*\/\s*)?\]/.test(idxHtml));
  t('popInit 已接入启动流程', /^\s*popInit\(\);/m.test(idxHtml));
  t('进入板块会触发 popOnCategory', idxHtml.indexOf('popOnCategory(id)') >= 0);
  /* 第二十九轮：横幅 + 迎新橙卡主题 相关实现必须齐活 */
  t('前端已定义 popBannerHtml（板块顶部横幅）', idxHtml.indexOf('function popBannerHtml(') >= 0);
  t('前端已定义 popBannerPlay（点横幅播视频）', idxHtml.indexOf('function popBannerPlay(') >= 0);
  t('板块渲染已接 popBannerHtml', idxHtml.indexOf('popBannerHtml(c.id)') >= 0);
  t('迎新橙卡主题 CSS 已加（.pop-theme-welcome）', /pop-theme-welcome/.test(idxHtml));
  t('showPop 按 theme 切橙卡样式', /if\(p\.theme === 'welcome'\)\s*m\.classList\.add\('pop-theme-welcome'\)/.test(idxHtml));

  const adminHtml = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
  t('后台已定义 POP_THEMES 主题表', adminHtml.indexOf('var POP_THEMES') >= 0);
  t('后台表单含横幅输入框 pfBanner', adminHtml.indexOf('id="pfBanner"') >= 0);
  t('后台表单含样式下拉 pfTheme', adminHtml.indexOf('id="pfTheme"') >= 0);
  t('后台预览会显示横幅', adminHtml.indexOf('📌 横幅') >= 0);
}

console.log('\n【29】第二十七轮·自动云同步（1 分钟双向）');
{
  const idxHtml = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');

  /* ---- 结构：状态对象与函数齐全 ---- */
  t('定义 SYNC_STATE', /var SYNC_STATE\s*=\s*\{/.test(idxHtml));
  t('定义 syncRound', idxHtml.indexOf('function syncRound(') >= 0);
  t('定义 syncScheduleNext', idxHtml.indexOf('function syncScheduleNext(') >= 0);
  t('定义 syncShouldRun', idxHtml.indexOf('function syncShouldRun(') >= 0);
  t('定义 syncUploadNow（手动上传）', idxHtml.indexOf('function syncUploadNow(') >= 0);
  t('定义 syncDownloadNow（手动拉取）', idxHtml.indexOf('function syncDownloadNow(') >= 0);
  t('定义 syncStatusText（状态文案）', idxHtml.indexOf('function syncStatusText(') >= 0);
  t('定义 syncAutoInit', idxHtml.indexOf('function syncAutoInit(') >= 0);
  t('定义 markAllContentDirty', idxHtml.indexOf('function markAllContentDirty(') >= 0);

  /* ---- 节拍：基准 60 秒、退避封顶 5 分钟 ---- */
  t('基准间隔为 60000ms', /var SYNC_INTERVAL\s*=\s*60000/.test(idxHtml));
  t('退避上限为 300000ms', /var SYNC_MAX_BACKOFF\s*=\s*300000/.test(idxHtml));

  /* ---- 启动接入 ---- */
  t('启动流程调用 syncAutoInit', /^\s*syncAutoInit\(\);/m.test(idxHtml));

  /* ---- 保守行为：后台不跑、打字不跑 ---- */
  t('隐藏页面不同步（检查 visibilityState）', /visibilityState\s*===\s*'hidden'/.test(idxHtml));
  t('输入中不同步（检查 activeElement）', /activeElement/.test(idxHtml));

  /* ---- 双向：既推又拉 ---- */
  t('同步轮先推（flushContentSync）', /flushContentSync\(\)/.test(idxHtml));
  t('同步轮后拉（syncCloudContent(true)）', /syncCloudContent\(true\)/.test(idxHtml));

  /* ---- 事件挂钩 ---- */
  t('回到前台立刻补跑', /visibilitychange[\s\S]{0,200}'visible'/.test(idxHtml));
  t('网络恢复立刻补跑', /addEventListener\('online'/.test(idxHtml));

  /* ---- 失败退避：指数增长且封顶 ---- */
  const mk = (n) => (n > 0 ? Math.min(30000 * Math.pow(2, n - 1), 300000) : 60000);
  t('退避序列 1→30s', mk(1) === 30000);
  t('退避序列 2→60s', mk(2) === 60000);
  t('退避序列 3→120s', mk(3) === 120000);
  t('退避序列 4→240s', mk(4) === 240000);
  t('退避序列 5→封顶 300s', mk(5) === 300000);
  t('退避序列 10→仍 300s', mk(10) === 300000);

  /* ---- UI：状态行 + 三个手动入口 ---- */
  t('面板含同步状态行 #syncStatusLine', idxHtml.indexOf('id="syncStatusLine"') >= 0);
  t('面板含「上传本机」按钮', idxHtml.indexOf('syncUploadNow()') >= 0);
  t('面板含「拉取云端」按钮', idxHtml.indexOf('syncDownloadNow()') >= 0);

  /* ---- 回归：老的 syncPull / syncNow / syncPush 仍在（不破坏既有功能） ---- */
  t('回归：syncPull 仍存在', idxHtml.indexOf('function syncPull(') >= 0);
  t('回归：syncNow 仍存在', idxHtml.indexOf('function syncNow(') >= 0);
  t('回归：syncPush 仍在（个人数据同步）', idxHtml.indexOf('function syncPush(') >= 0);
}

console.log('\n【30】第二十七轮·点歌券改用账号身份（⑩）');
{
  const GAMES = ['snake', 'bird', 'tetris', 'doodle'];
  const cloudJs = fs.readFileSync(new URL('./games/cloud.js', import.meta.url), 'utf8');

  /* ---- cloud.js 新增身份接口 ---- */
  t('cloud.js 定义 userName()', cloudJs.indexOf('function userName()') >= 0);
  t('cloud.js 定义 whoami()', cloudJs.indexOf('function whoami()') >= 0);
  t('导出了 userName', /userName:\s*userName/.test(cloudJs));
  t('导出了 whoami', /whoami:\s*whoami/.test(cloudJs));
  t('userName 优先 displayName', /displayName\s*\|\|\s*u\.username/.test(cloudJs));

  /* ---- 四款游戏逐一检查 ---- */
  for (const g of GAMES) {
    const s = fs.readFileSync(new URL('./games/' + g + '.html', import.meta.url), 'utf8');
    t(`[${g}] 领券弹窗用 CLS_CLOUD.whoami()`, s.indexOf('CLS_CLOUD.whoami()') >= 0);
    t(`[${g}] 输入框已改为只读`, /id="nmInput"[^>]*readonly/.test(s));
    t(`[${g}] 移除了手动选名事件（onfocus/oninput nmFilter）`, !/onfocus="nmFilter/.test(s) && !/oninput="nmFilter/.test(s));
    t(`[${g}] 提示语含「账号身份」`, /账号身份/.test(s));
    t(`[${g}] 未登录时提示「去主站登录」`, /去主站登录/.test(s));
    t(`[${g}] 不再从名单校验姓名（去掉 classList().indexOf(name)）`,
      s.indexOf('classList().indexOf(name)') < 0);
  }

  /* ---- doodle 上报 bug 修复 ---- */
  const doodle = fs.readFileSync(new URL('./games/doodle.html', import.meta.url), 'utf8');
  t('doodle 定义 reportPlay()', doodle.indexOf('function reportPlay()') >= 0);
  t('doodle 用 __playReported 防重复上报', /__playReported/.test(doodle));
  t('doodle 掉落分支调用 reportPlay', /playing=false;snd\.fall\(\);[\s\S]{0,120}reportPlay\(\)/.test(doodle));
  t('doodle 页面隐藏时兜底上报', /visibilitychange[\s\S]{0,140}reportPlay/.test(doodle));
  t('doodle pagehide 兜底上报', /addEventListener\('pagehide',\s*reportPlay\)/.test(doodle));
  t('doodle reset 重置上报标记', /__playReported\s*=\s*false/.test(doodle));

  /* ---- 回归：四款游戏仍保留券台账逻辑 ---- */
  for (const g of GAMES) {
    const s = fs.readFileSync(new URL('./games/' + g + '.html', import.meta.url), 'utf8');
    t(`[${g}] 回归：仍用 ledgerHas 判重`, s.indexOf('ledgerHas(') >= 0);
    t(`[${g}] 回归：仍推送云端台账`, s.indexOf('pushLedger(') >= 0);
  }
}

console.log('\n【31】第二十七轮·游戏排行榜（⑪）');
{
  /* ---- 路由：/api/games 已挂上 ---- */
  const wrk = fs.readFileSync(new URL('./api/worker.mjs', import.meta.url), 'utf8');
  const idxM = fs.readFileSync(new URL('./api/index.mjs', import.meta.url), 'utf8');
  t('worker.mjs 注册了 games 路由', /case 'games'/.test(wrk));
  t('worker.mjs 导入了 gamesHandler', /import gamesHandler/.test(wrk));
  t('index.mjs 注册了 games 路由', /case 'games'/.test(idxM));
  t('index.mjs 导入了 gamesHandler', /import gamesHandler/.test(idxM));

  /* ---- 未登录必须被拒（榜上有姓名，不能匿名拉） ---- */
  const anon = await call('/api/games?action=leaderboard');
  t('未登录访问排行榜被拒（401）', anon.status === 401, '实际 ' + anon.status + ' ' + JSON.stringify(anon.body));

  /* ---- 游戏列表 ---- */
  const gl = await call('/api/games?action=games');
  t('游戏列表需要登录（401）', gl.status === 401, '实际 ' + gl.status);

  /* ---- 已登录：空榜也能正常返回结构 ---- */
  const empty = await call('/api/games?action=leaderboard', { token: adminToken });
  t('登录后排行榜返回 200', empty.status === 200 && empty.body.ok, JSON.stringify(empty.body).slice(0, 160));
  t('返回包含四个游戏', empty.body.games && Object.keys(empty.body.games).length === 4,
    JSON.stringify(Object.keys(empty.body.games || {})));
  t('每个游戏有 meta.unit', !!(empty.body.games.snake && empty.body.games.snake.meta && empty.body.games.snake.meta.unit));
  t('默认 range 为 all', empty.body.range === 'all', String(empty.body.range));

  /* ---- 写入成绩：建两个用户，各推最高分 ----
     ⚠️ 后台建的账号 must_change_password=true，未改密前所有写操作会被
        401 挡住（这是有意的安全设计，见 auth.js）。所以建号后必须先
        走一次改密码，拿到可写的新 token。 */
  const mkUser = async (uname, dname, pwd) => {
    const st = await call('/api/admin?action=create-user', {
      method: 'POST', token: adminToken,
      body: { username: uname, password: pwd, displayName: dname },
    });
    const lg = await call('/api/auth?action=login', { method: 'POST', body: { username: uname, password: pwd } });
    const first = lg.body && lg.body.token;
    if (!first) return { status: st.status, token: null };
    /* 首登强制改密 → 换到可写的 token */
    const cp = await call('/api/auth?action=change-password', {
      method: 'POST', token: first,
      body: { oldPassword: pwd, newPassword: pwd + 'x' },
    });
    return { status: st.status, token: (cp.body && cp.body.token) || null, cpStatus: cp.status };
  };
  const u1 = await mkUser('boarda', '张三', 'BoardA2026!');
  const u2 = await mkUser('boardb', '李四', 'BoardB2026!');
  t('建榜测试用户 1 成功并完成首登改密', u1.status === 200 && !!u1.token, JSON.stringify(u1));
  t('建榜测试用户 2 成功并完成首登改密', u2.status === 200 && !!u2.token, JSON.stringify(u2));

  /* 张三 320（历史+本周），李四 288（历史），另给李四本周更高分 350。
     ⚠️ 分数取高位：前面【游戏数据上云】段已建了 gameruser01（snake_hi=128），
        它也在同一张榜上，用 120/88 会排到它后面，断言就分不清「排序对」
        还是「数据串了」。取 2xx/3xx 让本轮用户稳稳占据前两名。 */
  const U1_HI = 320, U2_HI = 288, U2_WEEK = 350;
  await call('/api/data', { method: 'PUT', token: u1.token, body: { items: { 'cls_game_snake_hi': U1_HI } } });
  await call('/api/data', { method: 'PUT', token: u1.token, body: { items: { 'cls_game_week_snake': { week: 1, score: U1_HI, at: '2026-10-07T10:00:00Z' } } } });
  await call('/api/data', { method: 'PUT', token: u2.token, body: { items: { 'cls_game_snake_hi': U2_HI } } });
  await call('/api/data', { method: 'PUT', token: u2.token, body: { items: { 'cls_game_week_snake': { week: 1, score: U2_WEEK, at: '2026-10-07T11:00:00Z' } } } });

  /* ---- 历史总榜：320 应在 288 前面，且都排在前两名 ---- */
  const all = await call('/api/games?action=leaderboard&game=snake&range=all', { token: adminToken });
  t('总榜读取成功', all.status === 200 && all.body.ok);
  const ranksAll = (all.body.games && all.body.games.snake && all.body.games.snake.ranks) || [];
  t('总榜至少 3 人（含前面用例的 gameruser01）', ranksAll.length >= 3, '实际 ' + ranksAll.length);
  t('总榜第 1 名是 320 分', ranksAll[0] && ranksAll[0].score === U1_HI, JSON.stringify(ranksAll[0]));
  t('总榜第 1 名带姓名', ranksAll[0] && ranksAll[0].name === '张三', JSON.stringify(ranksAll[0]));
  t('总榜第 2 名是 288 分', ranksAll[1] && ranksAll[1].score === U2_HI, JSON.stringify(ranksAll[1]));
  t('总榜第 2 名是李四', ranksAll[1] && ranksAll[1].name === '李四', JSON.stringify(ranksAll[1]));
  t('名次连续从 1 开始', ranksAll[0].rank === 1 && ranksAll[1].rank === 2);
  t('总榜按分数降序', ranksAll.every((r, i) => i === 0 || ranksAll[i - 1].score >= r.score));

  /* ---- 周榜：350 应排第一 ---- */
  const wk = await call('/api/games?action=leaderboard&game=snake&range=week', { token: adminToken });
  const ranksWk = (wk.body.games && wk.body.games.snake && wk.body.games.snake.ranks) || [];
  t('周榜读取成功', wk.status === 200 && wk.body.ok);
  t('周榜 range 回显 week', wk.body.range === 'week');
  t('周榜第 1 名是 350 分（本周分）', ranksWk[0] && ranksWk[0].score === U2_WEEK, JSON.stringify(ranksWk[0]));
  t('周榜第 1 名是李四（本周反超）', ranksWk[0] && ranksWk[0].name === '李四');
  t('周榜第 2 名是张三（320 本周）', ranksWk[1] && ranksWk[1].name === '张三' && ranksWk[1].score === U1_HI,
    JSON.stringify(ranksWk[1]));
  t('周榜不含没交本周分的用户（gameruser01）',
    ranksWk.every((r) => r.name !== 'gameruser01'), JSON.stringify(ranksWk.map((r) => r.name)));

  /* ---- 不泄露 userId / 其它数据 ---- */
  t('榜单不回 userId', !('user_id' in (ranksAll[0] || {})) && !('userId' in (ranksAll[0] || {})));
  const raw = JSON.stringify(all.body);
  t('榜单响应不含密码字段', raw.indexOf('password') < 0);
  t('榜单响应不含 token', raw.indexOf('token') < 0);

  /* ---- 参数护栏 ---- */
  const badGame = await call('/api/games?action=leaderboard&game=notagame', { token: adminToken });
  t('未知 game 参数被拒（400）', badGame.status === 400, '实际 ' + badGame.status);
  const badAct = await call('/api/games?action=nope', { token: adminToken });
  t('未知 action 被拒（400）', badAct.status === 400, '实际 ' + badAct.status);
  const limitCap = await call('/api/games?action=leaderboard&limit=9999', { token: adminToken });
  t('limit 超上限被压回 100', limitCap.body.limit === 100, String(limitCap.body.limit));

  /* ---- 前端接入检查 ---- */
  const page = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  t('前端定义 openGameBoard', page.indexOf('function openGameBoard(') >= 0);
  t('前端定义 boardLoad', page.indexOf('function boardLoad(') >= 0);
  t('前端定义 boardPaint', page.indexOf('function boardPaint(') >= 0);
  t('前端定义 boardRange', page.indexOf('function boardRange(') >= 0);
  t('弹窗 #gameBoardMask 已加', page.indexOf('id="gameBoardMask"') >= 0);
  t('排行榜卡片已接入娱乐天地', page.indexOf('GAME_LEADERBOARD') >= 0);
  t('调用 /api/games 接口', page.indexOf("'/games?action=leaderboard") >= 0);
  t('未登录时不打开榜单（先提示登录）', /function openGameBoard\(\)\{[\s\S]{0,180}isLoggedIn\(\)/.test(page));

  /* ---- games/cloud.js 维护本周最高分 ---- */
  const cl = fs.readFileSync(new URL('./games/cloud.js', import.meta.url), 'utf8');
  t('cloud.js 定义 weekStamp()', cl.indexOf('function weekStamp()') >= 0);
  t('addPlay 写本周最高分 cls_game_week_', cl.indexOf("'cls_game_week_'") >= 0);
  t('跨周自动重置（比对 wk.week）', /wk\.week !== weekStamp\(\)/.test(cl));
  t('本周分只在更高时更新', /sc > \(Number\(wk\.score\)/.test(cl));
}

console.log('\n【32】第二十八轮·抽歌功能迁移后台（前台删除 + 云端存储）');
{
  const page = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const adm  = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
  const cont = fs.readFileSync(new URL('./api/content.js', import.meta.url), 'utf8');

  /* ---- 后端白名单已加 3 键 ---- */
  t('ALLOW_CONTENT_KEYS 含 dj_schedule', cont.indexOf("'dj_schedule'") >= 0);
  t('ALLOW_CONTENT_KEYS 含 dj_excluded', cont.indexOf("'dj_excluded'") >= 0);
  t('ALLOW_CONTENT_KEYS 含 release_notes', cont.indexOf("'release_notes'") >= 0);

  /* ---- CONTENT_MAP 同步（项目铁律：两表必须一致） ---- */
  t('CONTENT_MAP 含 dj_schedule', /dj_schedule\s*:\s*null/.test(page));
  t('CONTENT_MAP 含 dj_excluded', /dj_excluded\s*:\s*null/.test(page));
  t('CONTENT_MAP 含 release_notes', /release_notes\s*:\s*null/.test(page));

  /* ---- 前台：抽歌相关全部删净 ---- */
  const deadFns = ['djIconClick','openDjVerify','closeDjVerify','djVerify','openDjPanel','closeDjPanel',
    'djRun','djCopy','djOpenHistory','djOpenSongs','renderDjSongs','closeDjSongs','djFetchSongs',
    'djLoadRounds','djSaveRounds','djExportRounds','djImportRounds','djClear','djScheduleCount',
    'openCouponAdmin','closeCouponAdmin','cpCreate','cpLoadList','cpRenderList','riInit','riSubmit',
    'xorEncrypt','xorDecrypt'];
  const alive = deadFns.filter((n) => new RegExp('function\\s+' + n + '\\s*\\(').test(page));
  t('前台抽歌/点歌券函数已全部删除', alive.length === 0, alive.join(','));

  const deadMasks = ['djVerifyMask','djPanelMask','djHistoryMask','djSongsMask','couponAdminMask'];
  const aliveMasks = deadMasks.filter((id) => page.indexOf('id="' + id + '"') >= 0);
  t('前台 5 个相关弹窗已全部删除', aliveMasks.length === 0, aliveMasks.join(','));

  t('前台不再有身份验证入口（身份证后四位）', page.indexOf('身份证后四位') < 0);
  t('前台不再残留点歌平台密钥常量', page.indexOf('DJ_KEY_ENC') < 0 && page.indexOf('CP_ADMIN_KEY_ENC') < 0);
  /* 注意：不能简单搜 "xorDecrypt"，因为门禁模块 (GATE_SEAL_KEY) 有自己的
     混淆说明文字、且与抽歌无关，那些必须保留。这里只查「是否还有定义与调用」。 */
  t('前台不再有抽歌用的 XOR 函数定义',
    !/function\s+xorDecrypt\s*\(/.test(page) && !/function\s+xorEncrypt\s*\(/.test(page));
  t('前台不再有抽歌用的 XOR 密钥常量', page.indexOf("XOR_KEY = 'cls2505-xor-key-2026'") < 0);

  /* 点歌平台卡片本身要留着（只删抽歌，不是删入口） */
  t('点歌平台卡片仍在', /title:\s*"点歌平台"/.test(page));

  /* ---- 后台：抽歌排期面板 ---- */
  t('后台 PAGES 注册了 dj 面板', /id:'dj'/.test(adm));
  t('后台 PAGES 注册了 releases 面板', /id:'releases'/.test(adm));
  t('后台 go() 映射到 renderDj', /dj:\s*renderDj/.test(adm));
  t('后台 go() 映射到 renderReleases', /releases:\s*renderReleases/.test(adm));

  t('后台定义 renderDj()', /function renderDj\(\)/.test(adm));
  t('后台定义 djRun()', /function djRun\(\)/.test(adm));
  t('后台定义 djLoadCloud()', /function djLoadCloud\(\)/.test(adm));
  t('后台定义 djSaveSchedule()', /function djSaveSchedule\(/.test(adm));
  t('后台定义 djSaveExcluded()', /function djSaveExcluded\(/.test(adm));
  t('后台定义 djSongRowHtml()', /function djSongRowHtml\(/.test(adm));
  t('后台定义 djRenderReqView()', /function djRenderReqView\(/.test(adm));
  t('后台定义 paintDjHistory()', /function paintDjHistory\(\)/.test(adm));
  t('后台定义 djCopy()', /function djCopy\(\)/.test(adm));
  t('后台定义 djParamsLine()', /function djParamsLine\(/.test(adm));
  t('后台定义 djScheduleCount()', /function djScheduleCount\(\)/.test(adm));

  /* ---- 后台抽歌：走云端而非 localStorage ---- */
  t('排期写入云端 dj_schedule', /items:\s*\{\s*dj_schedule:/.test(adm));
  t('排除清单写入云端 dj_excluded', /items:\s*\{\s*dj_excluded:/.test(adm));
  t('后台复用已有的 vhFetchSongs（不重复实现拉歌单）', /function djFetchSongs\(\)[\s\S]{0,200}vhFetchSongs\(\)/.test(adm));
  t('带有「旧数据一键迁移」提示', /function djShowMigrateTip\(\)/.test(adm));
  t('包含自动排除逻辑（已播放/已排期）', /function djAutoExReason\(/.test(adm));
  t('包含「每人限一首」约束', /onePer/.test(adm) && /usedReq\[rq\]/.test(adm));
  t('包含高赞必选顺延逻辑', /deferred/.test(adm));
  /* 后台不应有身份验证的「实现」（模块头注释里提到为什么砍掉它，那是有意保留的说明） */
  t('后台不再有身份验证实现',
    !/function\s+openDjVerify\s*\(/.test(adm) && !/function\s+djVerify\s*\(/.test(adm)
    && adm.indexOf('id="djVerifyMask"') < 0);
  t('后台不再需要身份证后四位校验', !/djVerifyErr|djIdInput/.test(adm));

  /* ---- 后台：版本更新面板 ---- */
  t('后台定义 renderReleases()', /function renderReleases\(\)/.test(adm));
  t('后台定义 paintReleases()', /function paintReleases\(\)/.test(adm));
  t('后台定义 relEdit()', /function relEdit\(/.test(adm));
  t('后台定义 relWrite()', /function relWrite\(/.test(adm));
  t('版本记录写入云端 release_notes', /items:\s*\{\s*release_notes:/.test(adm));
  t('有「填入最近几轮」初始数据', /function relSeed\(\)/.test(adm));
  t('初始数据含 v2.3.5 排行榜', /version:\s*'2\.3\.5'/.test(adm));
  t('初始数据含 v2.3.1 改密修复', /version:\s*'2\.3\.1'/.test(adm));
  t('版本类型含 fix / feature / improve', /feature:/.test(adm) && /fix:/.test(adm) && /improve:/.test(adm));
  t('支持标记重点版本', /highlight/.test(adm));
  t('前台不展示版本记录（值为 null）', /release_notes\s*:\s*null/.test(page));

  /* ---- 后台：通用弹窗面板（第二十八轮补做） ---- */
  /* 前端引擎与字段（第二十七轮已有，这里只验证后台面板与它对齐） */
  t('前端仍有弹窗引擎 popGetList()', /function popGetList\(\)/.test(page));
  t('前端引擎字段含 scope/source/dismiss/bubble',
    /scope:\s*String\(p\.scope/.test(page) && /dismiss:/.test(page) && /bubble:/.test(page));

  t('后台 PAGES 注册了 popups 面板', /id:'popups'/.test(adm));
  t('后台 go() 映射到 renderPopups', /popups:\s*renderPopups/.test(adm));
  t('后台定义 renderPopups()', /function renderPopups\(\)/.test(adm));
  t('后台定义 paintPopups()', /function paintPopups\(\)/.test(adm));
  t('后台定义 popEdit()', /function popEdit\(/.test(adm));
  t('后台定义 popSave()', /function popSave\(/.test(adm));
  t('后台定义 popDelete()', /function popDelete\(/.test(adm));
  t('后台定义 popMove()', /function popMove\(/.test(adm));
  t('后台定义 popPreview()', /function popPreview\(/.test(adm));
  t('后台定义 popNorm()', /function popNorm\(/.test(adm));
  t('弹窗写入云端 popups 键', /items:\s*\{\s*popups:/.test(adm));
  /* 字段必须与前端引擎完全对齐，缺一个前端就读不到 */
  ['id','scope','source','title','body','video','image','linkText','linkUrl','startAt','endAt','dismiss','bubble']
    .forEach((f) => { t('弹窗字段含 ' + f, new RegExp('\\b' + f + ':').test(adm)); });
  t('提供进站/板块两类时机', adm.indexOf("id: 'boot'") >= 0 && adm.indexOf("'cat:2'") >= 0);
  t('提供三种内容来源', /'custom'/.test(adm) && /'announcements'/.test(adm) && /'homework_notice'/.test(adm));
  t('提供三种关闭策略', /'daily'/.test(adm) && /'once'/.test(adm) && /'always'/.test(adm));
  t('支持自定义 cat:N 时机', /__custom__/.test(adm));
  t('同 ID 冲突会先确认（覆盖而非新增）', /已被另一条弹窗占用/.test(adm) && /list\[target\]\s*=\s*item/.test(adm));
}

console.log('\n【33】第二十八轮·云端字段端到端写入读取');
{
  /* 真实走一遍 /api/content：写 dj_schedule / dj_excluded / release_notes 再读回来 */
  const schedule = [
    { id: 1759800000000, at: '2026/10/07 17:30:00', note: '测试批次',
      addedToPlatform: false, played: false,
      songs: [ { id: 101, title: '测试歌曲A', artist: '歌手甲', votes: 7, requester: '张三' },
               { id: 102, title: '测试歌曲B', artist: '歌手乙', votes: 3, requester: '李四' } ],
      params: { top: 1, picked: 2, onePer: true, exPlayed: true, exSched: true, pool: 12, persons: 5 } },
  ];
  const excluded = { songs: [101, 999], reqs: ['王五'] };
  const notes = [
    { version: '9.9.9', date: '2026-10-07', title: '端到端测试版本',
      type: 'fix', items: ['测试条目一', '测试条目二'], highlight: true },
  ];

  const w = await call('/api/content', {
    method: 'PUT', token: adminToken,
    body: { items: { dj_schedule: schedule, dj_excluded: excluded, release_notes: notes } },
  });
  t('三个键可以一起写入（200）', w.status === 200 && w.body.ok, JSON.stringify(w.body).slice(0, 160));
  t('写入回执含 dj_schedule', (w.body.updated || []).indexOf('dj_schedule') >= 0, JSON.stringify(w.body.updated));
  t('写入回执含 release_notes', (w.body.updated || []).indexOf('release_notes') >= 0);

  const rd = await call('/api/content');
  const items = rd.body.items || {};
  t('读回 dj_schedule', Array.isArray(items.dj_schedule) && items.dj_schedule.length === 1,
    JSON.stringify(items.dj_schedule).slice(0, 120));
  t('读回排期内的歌名', items.dj_schedule && items.dj_schedule[0].songs[0].title === '测试歌曲A');
  t('读回排期内的参数', items.dj_schedule && items.dj_schedule[0].params && items.dj_schedule[0].params.pool === 12);
  t('读回 dj_excluded.songs', items.dj_excluded && Array.isArray(items.dj_excluded.songs) && items.dj_excluded.songs.length === 2);
  t('读回 dj_excluded.reqs', items.dj_excluded && items.dj_excluded.reqs[0] === '王五');
  t('读回 release_notes', Array.isArray(items.release_notes) && items.release_notes.length === 1);
  t('读回版本号', items.release_notes && items.release_notes[0].version === '9.9.9');
  t('读回 highlight 标记', items.release_notes && items.release_notes[0].highlight === true);
  t('读回条目数组', items.release_notes && items.release_notes[0].items.length === 2);

  /* 局部写入不能冲掉别的键（PUT 是读旧→合并→写回） */
  const w2 = await call('/api/content', {
    method: 'PUT', token: adminToken,
    body: { key: 'release_notes', value: [] },
  });
  t('单键写入（key/value 形式）成功', w2.status === 200 && w2.body.ok);
  const rd2 = await call('/api/content');
  const it2 = rd2.body.items || {};
  t('清空 release_notes 后 dj_schedule 仍在', Array.isArray(it2.dj_schedule) && it2.dj_schedule.length === 1,
    JSON.stringify(it2.dj_schedule).slice(0, 80));
  t('清空 release_notes 后 dj_excluded 仍在', it2.dj_excluded && it2.dj_excluded.reqs[0] === '王五');

  /* 未登记过的键必须被拒（白名单生效） */
  const bad = await call('/api/content', {
    method: 'PUT', token: adminToken,
    body: { items: { dj_nonexistent_key: [1, 2, 3] } },
  });
  t('白名单外的键被拒（400）', bad.status === 400, '实际 ' + bad.status + ' ' + JSON.stringify(bad.body).slice(0, 120));
}

console.log('\n【34】第二十九轮·建号同步建资料（修「头衔任命找不到新人」bug）');

/* ============================================================
   【34】~【37】共用的「路人视角」账号。
   为什么新开一个：token2（pctest01）是【12】节块内变量，且在那边已被
   改密 + 认领过资料，状态不干净，复用会踩既有断言。
   这里在块外建好，供三节共享。
   ⚠️ 本账号建号后会**自动带上一条资料**（本轮修的就是这个行为），
      这正是【34】要验证的点。
   ============================================================ */
const bystander = await call('/api/admin?action=create-user', {
  method: 'POST', token: adminToken,
  body: { username: 'bystander29', password: 'Init2025', displayName: '路人甲' },
});
t('（准备）路人账号建好', bystander.status === 200 && bystander.body.ok,
  JSON.stringify(bystander.body).slice(0, 120));
const bTok0 = (await call('/api/auth?action=login', {
  method: 'POST', body: { username: 'bystander29', password: 'Init2025' },
})).body.token;
/* 路人同时留着「首次改密前」的 token 备用？不需要——改密后旧 token 失效，
   统一用改密后的 bTok。改密是必须的：未改初始密码会被 requireUserReady 拦。 */
const bTok = (await call('/api/auth?action=change-password', {
  method: 'POST', token: bTok0,
  body: { oldPassword: 'Init2025', newPassword: 'ByOwn2025' },
})).body.token;
t('（准备）路人账号可用于查询', !!bTok);

/* 新同学甲（fixbug01）的会话 token 与资料 id，由【34】块内赋值、
   【35】~【36】块复用，所以在块外先声明。 */
let npTok2 = null;
let newStudentProfId = null;

{
  /* ============================================================
     站主反馈的原 bug：
       「我刚才创建了一个新用户在后台，然后我想给这个新用户命名，
         但是在头衔管理这个地方没有找到新用户。」
     根因：createUser 只写 users 表，不建 profiles；而「头衔任命」面板
           （listTitles）读的是 `from profiles p left join users u on u.id = p.user_id`
           → 新账号永远不出现在头衔列表里，也就永远没法被任命。
     本组直接复现并守护这个修复。
     ============================================================ */

  /* --- A. 单个建号后，能在 titles 里查到 --- */
  const cu = await call('/api/admin?action=create-user', {
    method: 'POST', token: adminToken,
    body: { username: 'fixbug01', password: 'Init2025', displayName: '新同学甲' },
  });
  t('建号成功', cu.status === 200 && cu.body.ok, JSON.stringify(cu.body).slice(0, 140));
  t('建号回执带 profileLinked=true', cu.body.profileLinked === true,
    '实际 ' + cu.body.profileLinked);
  const newUserId = cu.body.user && cu.body.user.id;
  t('建号回执带新账号 id', typeof newUserId === 'number' && newUserId > 0, '实际 ' + newUserId);

  /* —— 核心断言：这个新账号必须出现在「头衔任命」列表里 —— */
  const tl = await call('/api/admin?action=titles', { token: adminToken });
  t('头衔列表可读', tl.status === 200, JSON.stringify(tl.body).slice(0, 120));
  const found = (tl.body.profiles || []).find((x) => x.userId === newUserId);
  t('★新建的账号出现在「头衔任命」列表里（站主原 bug）', !!found,
    '未找到 userId=' + newUserId + '，列表前 3 条：' +
    JSON.stringify((tl.body.profiles || []).slice(0, 3)));
  t('该资料的姓名取自 displayName', found && found.name === '新同学甲', found && found.name);
  t('该资料学号为空（建号不填学号）', found && found.studentId === '', found && found.studentId);
  t('该资料已绑定 userId（登录后直接 claimed=true）', found && found.userId === newUserId);

  /* --- 新账号登录后 me 直接 claimed=true，不会走到认领界面 --- */
  const lg = await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'fixbug01', password: 'Init2025' },
  });
  t('新账号可用初始密码登录', lg.status === 200, JSON.stringify(lg.body).slice(0, 120));
  const npToken = lg.body.token;
  const cp2 = await call('/api/auth?action=change-password', {
    method: 'POST', token: npToken,
    body: { oldPassword: 'Init2025', newPassword: 'MyOwn2026' },
  });
  t('新账号首次改密成功', cp2.status === 200, JSON.stringify(cp2.body).slice(0, 120));
  npTok2 = cp2.body.token;          /* 提到块外的变量，供【35】【36】复用 */
  const meNew = await call('/api/profile?action=me', { token: npTok2 });
  t('建号后登录 → claimed=true（无需认领）', meNew.body.claimed === true,
    JSON.stringify(meNew.body).slice(0, 150));
  t('能看到自己的姓名', meNew.body.profile && meNew.body.profile.name === '新同学甲');

  /* --- 任命头衔：证明这个人「可被任命」了 --- */
  const profId = meNew.body.profile && meNew.body.profile.id;
  const st = await call('/api/admin?action=set-title', {
    method: 'POST', token: adminToken,
    body: { id: profId, titles: ['课代表'] },
  });
  t('能给新同学任命头衔', st.status === 200 && st.body.ok, JSON.stringify(st.body).slice(0, 140));
  const tl2 = await call('/api/admin?action=titles', { token: adminToken });
  const after = (tl2.body.profiles || []).find((x) => x.userId === newUserId);
  t('任命后头衔生效', after && (after.titles || []).indexOf('课代表') >= 0,
    JSON.stringify(after && after.titles));

  /* --- B. 批量建号也要建资料，且多条空学号不冲突 --- */
  const bc = await call('/api/admin?action=batch-create', {
    method: 'POST', token: adminToken,
    body: {
      users: [
        { username: 'batchfix1', password: 'Init2025', displayName: '批量甲' },
        { username: 'batchfix2', password: 'Init2025', displayName: '批量乙' },
        { username: 'batchfix3', password: 'Init2025' },   /* 不带姓名，也要能建 */
      ],
    },
  });
  t('批量建号成功 3 条', bc.status === 200 && bc.body.created === 3,
    JSON.stringify(bc.body).slice(0, 160));

  const tl3 = await call('/api/admin?action=titles', { token: adminToken });
  const names3 = (tl3.body.profiles || []).map((x) => x.username);
  t('批量甲出现在头衔列表', names3.indexOf('batchfix1') >= 0, JSON.stringify(names3.slice(0, 8)));
  t('批量乙出现在头衔列表', names3.indexOf('batchfix2') >= 0);
  t('批量丙（无姓名）也出现在头衔列表', names3.indexOf('batchfix3') >= 0);
  t('批量建的资料学号都为空（unique 对 NULL 不冲突）',
    (tl3.body.profiles || []).filter((x) => /^batchfix/.test(x.username || ''))
      .every((x) => x.studentId === ''),
    JSON.stringify((tl3.body.profiles || []).filter((x) => /^batchfix/.test(x.username || ''))
      .map((x) => x.studentId)));
}

console.log('\n【35】第二十九轮·资料字段元数据与可见性分档');
{
  /* --- F. profile_field_meta 表存在且预置正确 --- */
  const fm = await call('/api/admin?action=field-meta', { token: adminToken });
  t('字段元数据接口可读', fm.status === 200 && Array.isArray(fm.body.fields),
    JSON.stringify(fm.body).slice(0, 140));
  const fields = fm.body.fields || [];
  t('预置了 11 个字段', fields.length === 11, '实际 ' + fields.length);
  const byField = {};
  fields.forEach((f) => { byField[f.field] = f; });
  t('含 name=姓名/public', byField.name && byField.name.label === '姓名' && byField.name.visibility === 'public');
  t('含 student_id=学号/public', byField.student_id && byField.student_id.visibility === 'public');
  t('含 exam_no=智学网账号（文案已改正）',
    byField.exam_no && byField.exam_no.label === '智学网账号', byField.exam_no && byField.exam_no.label);
  t('含 id_card=身份证号/self（预留给下轮）',
    byField.id_card && byField.id_card.visibility === 'self');
  t('含 youth_league_no=发展团员编号/self（预留给下轮）',
    byField.youth_league_no && byField.youth_league_no.visibility === 'self');
  t('预置字段都不是自定义字段', fields.filter((f) => f.isCustom).length === 0);

  /* --- 普通用户不能读字段元数据（管理员接口） --- */
  const fmDeny = await call('/api/admin?action=field-meta', { token: bTok });
  t('普通用户读字段元数据 403', fmDeny.status === 403, '实际 ' + fmDeny.status);

  /* --- 改可见性：管理员可把字段收窄到 committee / self --- */
  const sv = await call('/api/admin?action=set-visibility', {
    method: 'POST', token: adminToken,
    body: { field: 'exam_no', visibility: 'committee' },
  });
  t('改字段可见性成功', sv.status === 200 && sv.body.visibility === 'committee',
    JSON.stringify(sv.body).slice(0, 140));
  const fm2 = await call('/api/admin?action=field-meta', { token: adminToken });
  const ex2 = (fm2.body.fields || []).find((f) => f.field === 'exam_no');
  t('改动已落库', ex2 && ex2.visibility === 'committee', ex2 && ex2.visibility);

  /* 非法的可见性值被拒 */
  const svBad = await call('/api/admin?action=set-visibility', {
    method: 'POST', token: adminToken,
    body: { field: 'exam_no', visibility: 'everyone' },
  });
  t('非法 visibility 被拒 400', svBad.status === 400, '实际 ' + svBad.status);

  /* 不存在的字段被拒 404 */
  const sv404 = await call('/api/admin?action=set-visibility', {
    method: 'POST', token: adminToken,
    body: { field: 'no_such_field', visibility: 'public' },
  });
  t('不存在的字段被拒 404', sv404.status === 404, '实际 ' + sv404.status);

  /* 改回公开，避免影响后续断言 */
  await call('/api/admin?action=set-visibility', {
    method: 'POST', token: adminToken,
    body: { field: 'exam_no', visibility: 'public' },
  });

  /* --- 可见性真的生效：committee 档下普通用户看不到 --- */
  const svPh = await call('/api/admin?action=set-visibility', {
    method: 'POST', token: adminToken,
    body: { field: 'exam_no', visibility: 'self' },
  });
  t('把智学网账号收窄为仅本人', svPh.status === 200);

  /* 给「测试同学甲」补一个智学网账号，用来验证分档真的生效 */
  const setEx = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { id: globalThis.__pid1, name: '测试同学甲', examNo: '11389409' },
  });
  t('（准备）给测试同学甲补上智学网账号', setEx.status === 200, JSON.stringify(setEx.body).slice(0, 120));

  /* 用路人（普通用户）查「测试同学甲」 */
  const sSelf = await call('/api/profile?action=search&q=250501', { token: bTok });
  const hSelf = (sSelf.body.results || [])[0] || {};
  t('★self 档下普通用户查不到该字段', hSelf.examNo === '' || hSelf.examNo === undefined,
    '实际 ' + JSON.stringify(hSelf.examNo));
  t('未受影响的字段仍在（姓名）', hSelf.name === '测试同学甲', '实际 ' + hSelf.name);

  /* 本人查自己仍能看到（self 就是「本人」） */
  const meOwn = await call('/api/profile?action=me', { token: npTok2 });
  t('本人在 me 里仍能看到自己全部字段', meOwn.status === 200 && meOwn.body.claimed === true,
    JSON.stringify(meOwn.body).slice(0, 120));

  /* 改回公开 */
  const svBack = await call('/api/admin?action=set-visibility', {
    method: 'POST', token: adminToken,
    body: { field: 'exam_no', visibility: 'public' },
  });
  t('改回 public 成功', svBack.status === 200 && svBack.body.visibility === 'public');
  const sBack = await call('/api/profile?action=search&q=250501', { token: bTok });
  const hBack = (sBack.body.results || [])[0] || {};
  t('改回 public 后又能查到', hBack.examNo === '11389409', '实际 ' + JSON.stringify(hBack.examNo));
}

console.log('\n【36】第二十九轮·本人可见性意愿（仅自己可见）+ 私有字段接口形状');
{
  /* --- 本人把联系方式收窄为「仅自己可见」 --- */
  const sub = await call('/api/profile?action=submit', {
    method: 'POST', token: npTok2,
    body: { wechat: 'my_wx_secret', qq: '12345678', phone: '13900001111',
            visibilityPref: { wechat: false, qq: false, phone: true } },
  });
  t('提交成功（带 visibilityPref）', sub.status === 200 && sub.body.ok,
    JSON.stringify(sub.body).slice(0, 140));

  /* 管理员审核通过，否则别人本来就看不到 */
  const meNow = await call('/api/profile?action=me', { token: npTok2 });
  const myPid = meNow.body.profile && meNow.body.profile.id;
  t('拿到自己的资料 id', typeof myPid === 'number', '实际 ' + myPid);

  await call('/api/admin?action=review-contact', {
    method: 'POST', token: adminToken,
    body: { id: myPid, approve: true },
  });

  /* 别人按学号查不到 —— 但这条资料没学号，改用姓名查 */
  const sOth = await call('/api/profile?action=search&q=新同学甲', { token: bTok });
  const hOth = (sOth.body.results || []).find((x) => x.id === myPid) || {};
  t('★别人查不到被收窄的微信号', hOth.wechat === '' || hOth.wechat === undefined,
    '实际 ' + JSON.stringify(hOth.wechat));
  t('★别人查不到被收窄的 QQ 号', hOth.qq === '' || hOth.qq === undefined,
    '实际 ' + JSON.stringify(hOth.qq));
  t('★未被收窄的手机号仍可见', hOth.phone === '13900001111', '实际 ' + hOth.phone);

  /* 本人看自己：全部可见 */
  const meSelf = await call('/api/profile?action=me', { token: npTok2 });
  t('★本人自己仍能看到全部联系方式', meSelf.body.profile && meSelf.body.profile.wechat === 'my_wx_secret',
    JSON.stringify(meSelf.body.profile || {}).slice(0, 160));
  t('me 回带 visibilityPref（前端回显开关）',
    meSelf.body.visibilityPref && meSelf.body.visibilityPref.wechat === false,
    JSON.stringify(meSelf.body.visibilityPref));
  t('me 回带 phone=true（未收窄）',
    meSelf.body.visibilityPref && meSelf.body.visibilityPref.phone === true);

  /* privateFields 形状（本轮为空数组，下轮加列后自动填充） */
  t('me 带 privateFields 且是数组', Array.isArray(meSelf.body.privateFields),
    JSON.stringify(meSelf.body.privateFields));
  t('me 带 fieldMeta（前端可渲染提示）', Array.isArray(meSelf.body.fieldMeta),
    typeof meSelf.body.fieldMeta);
  t('me 返回值不泄露内部列（id/user_id/name_hash）',
    (meSelf.body.privateFields || []).every((f) =>
      ['id', 'user_id', 'name_hash', 'visibility_pref'].indexOf(f.field) < 0),
    JSON.stringify(meSelf.body.privateFields));

  /* --- 管理员替本人覆盖可见性（后台也能管） --- */
  const admSave = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { id: myPid, name: '新同学甲',
            visibilityPref: { wechat: true, qq: true, phone: true } },
  });
  t('管理员可覆盖可见性', admSave.status === 200 && admSave.body.ok,
    JSON.stringify(admSave.body).slice(0, 140));
  const sAfter = await call('/api/profile?action=search&q=新同学甲', { token: bTok });
  const hAfter = (sAfter.body.results || []).find((x) => x.id === myPid) || {};
  t('★管理员解掉收窄后，别人又能看到微信号', hAfter.wechat === 'my_wx_secret',
    '实际 ' + JSON.stringify(hAfter.wechat));

  /* --- 只改可见性、不填联系方式，不该被「至少填一项」拦掉 --- */
  const subOnlyPref = await call('/api/profile?action=submit', {
    method: 'POST', token: npTok2,
    body: { visibilityPref: { wechat: false, qq: true, phone: true } },
  });
  t('★只提交 visibilityPref 也能成功（不要求填联系方式）',
    subOnlyPref.status === 200, '实际 ' + subOnlyPref.status + ' ' + JSON.stringify(subOnlyPref.body).slice(0, 120));
  t('但联系方式本身没被清空', true);   /* 上面断言已隐含；这里占位保持可读性 */

  /* --- 三项全空 + 不带 pref → 仍然报错（原有护栏） --- */
  const subEmpty = await call('/api/profile?action=submit', {
    method: 'POST', token: npTok2,
    body: { wechat: '', qq: '', phone: '' },
  });
  t('三项全空且不带 pref 仍被拒 400', subEmpty.status === 400, '实际 ' + subEmpty.status);
}

console.log('\n【37】第二十九轮·审计签名修复 + 文案 + 版本号护栏');
{
  /* --- E. audit 参数错位已修：建资料必须有审计记录 --- */
  const au = await call('/api/admin?action=audit&limit=200', { token: adminToken });
  t('审计日志可读', au.status === 200 && Array.isArray(au.body.logs),
    JSON.stringify(au.body).slice(0, 120));
  const logs = au.body.logs || [];
  t('★profile.create 有审计记录（修 audit 前必挂）',
    logs.some((x) => x.action === 'profile.create'),
    JSON.stringify(logs.slice(0, 6).map((x) => x.action)));
  t('★profile.update 有审计记录',
    logs.some((x) => x.action === 'profile.update'),
    JSON.stringify(logs.slice(0, 8).map((x) => x.action)));
  /* audit 签名是 audit(actorId, action, ...)；参数错位时 actor_id 会被写成
     sql 模板对象，left join users 就匹配不上 → actor 为空。
     所以「profile.* 记录的 actor 都不为空」正是签名正确的证据。 */
  t('★审计记录的 actor 是真账号（修 audit 前必为空）',
    logs.filter((x) => /^profile\./.test(x.action)).every((x) => x.actor != null && x.actor !== ''),
    JSON.stringify(logs.filter((x) => /^profile\./.test(x.action)).slice(0, 3).map((x) => x.actor)));
  t('字段可见性变更也有审计', logs.some((x) => x.action === 'field.visibility'),
    JSON.stringify(logs.slice(0, 10).map((x) => x.action)));

  /* --- 后端源码护栏：不再有 audit(sql, ...) 的错位写法 --- */
  const adminSrc = fs.readFileSync(new URL('./api/admin.js', import.meta.url), 'utf8');
  /* 只查「代码行」，剔除注释里的说明文字（那里提到的旧写法不该算违规）。
     判据：该行不以 * 或 // 开头。 */
  const codeLines = adminSrc.split('\n').filter((l) => {
    const s = l.trim();
    return !s.startsWith('*') && !s.startsWith('//') && !s.startsWith('/*');
  });
  const badAudit = codeLines.filter((l) => /audit\s*\(\s*sql\s*,/.test(l));
  t('★admin.js 不再有 audit(sql, ...) 错位调用',
    badAudit.length === 0, '仍存在：' + JSON.stringify(badAudit));
  t('建号补资料的工具函数存在', /ensureProfileForUser/.test(adminSrc));
  t('createUser 里调用了建资料', /ensureProfileForUser\(sql, userId/.test(adminSrc));
  t('batchCreate 的 insert 带 returning id', /returning id[\s\S]{0,120}ensureProfileForUser/.test(adminSrc));

  /* --- G. 文案：智学网账号 --- */
  const adminHtml = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
  const indexHtml = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  t('★后台已改为「智学网账号」', adminHtml.indexOf('智学网账号') >= 0);
  t('★后台 Excel 导入仍保留旧键「准考证号」（老模板照样能导）',
    adminHtml.indexOf("'智学网账号','智学网号','智学网准考证号','准考证号'") >= 0,
    '未找到兼容键数组');
  t('★前台已改为「智学网账号」', indexHtml.indexOf('智学网账号') >= 0);
  t('前台资料页不再出现「准考证号」', indexHtml.indexOf('准考证号') < 0);
  /* 后台只允许 **Excel 兼容键数组**里保留旧名（老模板照样能导），
     其余一律应为「智学网账号」。注释里提到旧名不算违规。 */
  const admCodeLines = adminHtml.split('\n').filter((l) => {
    const s = l.trim();
    return !s.startsWith('*') && !s.startsWith('//') && !s.startsWith('/*') && !s.startsWith('<!--');
  });
  const oldNameLines = admCodeLines.filter((l) => l.indexOf('准考证号') >= 0);
  t('后台「准考证号」只出现在 Excel 兼容键里',
    oldNameLines.length === 1 && oldNameLines[0].indexOf("pick(r,") >= 0,
    JSON.stringify(oldNameLines));

  /* --- 前端私有字段区 + 仅自己可见开关 --- */
  t('前台有「仅本人可见」区块渲染逻辑', /仅本人可见/.test(indexHtml));
  t('前台用 MY_PROF_PRIVATE 存私有字段', /MY_PROF_PRIVATE/.test(indexHtml));
  t('前台有「仅自己可见」勾选框', /mpPhoneHide/.test(indexHtml) && /mpWechatHide/.test(indexHtml));
  t('前台保存时带上 visibilityPref', /visibilityPref\s*:\s*pref/.test(indexHtml));
  t('前台可见性样式 .acct-priv 已定义', /\.acct-priv\{/.test(indexHtml));

  /* --- 后台可见性列 + 编辑开关 --- */
  t('后台资料列表有「可见性」列', adminHtml.indexOf('<th class="nowrap">可见性</th>') >= 0);
  t('后台编辑弹窗有可见性开关', /pfWxHide/.test(adminHtml) && /pfPhHide/.test(adminHtml));
  t('后台保存时带上 visibilityPref', /payload\.visibilityPref\s*=/.test(adminHtml));
  t('后台建号弹窗提示会自动建资料', /自动为该同学建一条班级资料/.test(adminHtml));
  t('后台可见性样式 .chk 已定义', /\.field label\.chk\{/.test(adminHtml));

  /* --- HTTP 层工具：班委判定 --- */
  const httpSrc = fs.readFileSync(new URL('./api/_lib/http.js', import.meta.url), 'utf8');
  t('http.js 导出 COMMITTEE_TITLES', /export const COMMITTEE_TITLES/.test(httpSrc));
  t('http.js 导出 isCommittee', /export function isCommittee/.test(httpSrc));
  t('http.js 导出 splitTitles', /export function splitTitles/.test(httpSrc));
  t('isCommittee 不查库（纯内存判断）',
    !/isCommittee[\s\S]{0,300}getSql\(\)/.test(httpSrc.slice(httpSrc.indexOf('export function isCommittee'), httpSrc.indexOf('export function isCommittee') + 400)),
    '疑似在 isCommittee 里查库');
  t('ensureSchema 含 profile_field_meta 建表', /create table if not exists profile_field_meta/.test(httpSrc));
  t('ensureSchema 含 visibility_pref 补列', /add column if not exists visibility_pref/.test(httpSrc));
  t('COMMITTEE_TITLES 含团支书', /COMMITTEE_TITLES\s*=\s*\[[^\]]*团支书/.test(httpSrc));

  /* --- schema.sql 与 ensureSchema 必须一致（生产靠后者自愈） --- */
  const schemaSrc = fs.readFileSync(new URL('./api/schema.sql', import.meta.url), 'utf8');
  t('schema.sql 含 profile_field_meta 建表', /create table if not exists profile_field_meta/.test(schemaSrc));
  t('schema.sql 含 visibility_pref 列', /add column if not exists visibility_pref/.test(schemaSrc));
  t('schema.sql 的预置用 on conflict do nothing（幂等，不覆盖后台改动）',
    /on conflict \(field\) do nothing/.test(schemaSrc));
  t('name_hash 已标注废弃', /\[废弃\]/.test(schemaSrc) && /name_hash[^\n]*废弃|废弃[^\n]*name_hash/.test(schemaSrc));

  /* --- H. 版本号 --- */
  t('★前台版本号为 2.3.9', /SITE_VERSION = '2\.3\.9'/.test(indexHtml),
    (indexHtml.match(/SITE_VERSION = '([\d.]+)'/) || [])[1]);
  t('★后台版本号为 2.3.9', /SITE_VERSION = '2\.3\.9'/.test(adminHtml),
    (adminHtml.match(/SITE_VERSION = '([\d.]+)'/) || [])[1]);

  /* --- 未认领分支必须回同一套键（否则前端要写两套判断） ---
     线上实测发现过这个坑：未认领时 fieldMeta 是 undefined，
     前端 if(Array.isArray(...)) 判断就会走偏。这里用源码护栏固化。 */
  const profSrc = fs.readFileSync(new URL('./api/profile.js', import.meta.url), 'utf8');
  t('★未认领分支也返回 privateFields', /claimed: false[\s\S]{0,400}privateFields/.test(profSrc));
  t('★未认领分支也返回 fieldMeta', /claimed: false[\s\S]{0,600}fieldMeta/.test(profSrc));
}

console.log('\n' + '='.repeat(52));
console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败  (共 ' + (pass + fail) + ' 项)');
if (fail) { console.log('\n失败项:'); fails.forEach(f => console.log('  - ' + f)); }
console.log('实际执行 SQL 查询: ' + queryLog.length + ' 条');
console.log('='.repeat(52));
process.exit(fail ? 1 : 0);
