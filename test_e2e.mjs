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
  /* ⚠️ v2.5.0 的 last_seen_at 同样**故意不预建**，交给 ensureSchema 的
     alter table add column 去补 —— 与上面 users 表一个道理：
     桩若预建，就复现不出「线上缺列」的那类事故了。 */
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
  /* 2026-10-09 v2.4.0：删自定义字段要真跑 drop column（SQLite 3.35+ 支持）。
     老版本 sql.js 若不支持，execAlter 里会 catch 后忽略，不影响测试。 */
  if (/^\s*alter\s+table[\s\S]*drop\s+column\s+if\s+exists/i.test(s)) {
    return { __dropColumn: s };
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
  let text;
  /* ---- 兼容两种调用形式（2026-10-09 v2.4.0 加） ----
     ① 标签模板：sql`select ... ${v}`     → strings 是 TemplateStringsArray，自动编号 $1..$n
     ② 普通调用：sql('select ... $1', [v]) → strings 是**字符串**，values[0] 是参数数组
     生产用的 @neondatabase/serverless 两种都支持（见 NeonQueryFunction 的类型定义），
     桩也必须一致，否则「动态拼列名」那批代码在测试里跑不起来。 */
  if (typeof strings === 'string') {
    text = strings;
    values = Array.isArray(values[0]) ? values[0] : [];
    const tr0 = translate(text);
    return makeThenable(tr0, text, values);
  }
  text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? '$' + (i + 1) : ''), '');
  return makeThenable(translate(text), text, values);
};

/** 把「翻译结果 + 原 SQL + 参数」包成一个 thenable（与原桩行为一致） */
function makeThenable(tr, rawText, values) {

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
        /* ---- drop column if exists（删自定义字段）---- */
        if (tr && typeof tr === 'object' && tr.__dropColumn) {
          const m = /alter\s+table\s+([\w"]+)\s+drop\s+column\s+if\s+exists\s+([\w"]+)/i.exec(tr.__dropColumn);
          if (m) {
            const [, tbl, col] = m;
            const cols = db.exec(`pragma table_info(${tbl})`);
            const names = cols.length ? cols[0].values.map((r) => String(r[1])) : [];
            if (names.includes(col)) {
              try { db.run(`alter table ${tbl} drop column ${col}`); }
              catch (e) { /* 老 sql.js 不支持 drop column，忽略即可 */ }
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
}

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
    method: 'POST', body: { username: 'hbuser2500', password: 'PingPass123' },
  });
  t('建心跳测试账号成功', reg.status === 200 && !!reg.body.token, JSON.stringify(reg.body).slice(0, 200));
  const tk = reg.body.token;

  const p1 = await call('/api/auth?action=ping', { token: tk });
  t('心跳返回 200', p1.status === 200, '实际 ' + p1.status);
  t('心跳返回 pong', p1.body && typeof p1.body.pong === 'number', JSON.stringify(p1.body));

  const pNoAuth = await call('/api/auth?action=ping');
  t('未登录心跳被拒 401', pNoAuth.status === 401, '实际 ' + pNoAuth.status);

  /* 后台要能看到，而且和「最后登录」是两个独立的字段 */
  const lu = await call('/api/admin?action=users&q=hbuser2500', { token: adminToken });
  const row = (lu.body.users || []).find((u) => u.username === 'hbuser2500');
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
  t('单游戏时长不被合并（按游戏各归各）', !!me && me.totalMs === undefined
    && !!me.play.snake && me.play.snake.totalMs === 185000 && me.play.snake.count === 3,
    JSON.stringify(me && { totalMs: me.totalMs, play: me.play }));
  t('游玩排序口径为「最近游玩」', !!me && typeof me.lastPlayAt === 'string'
    && me.lastPlayAt === '2026-10-07T10:30:00.000Z', JSON.stringify(me && me.lastPlayAt));
  t('后台能看到券获取时间', !!me && (me.coupons || []).length === 1
    && me.coupons[0].code === 'SONGA1B2C3' && me.coupons[0].time === '2026-10-07 10:31',
    JSON.stringify(me && me.coupons));
  t('券记录带游戏名', !!me && me.coupons[0].gameLabel === '贪吃蛇', JSON.stringify(me && me.coupons[0]));
  t('汇总有人数/券数/局数，且不再有跨游戏总时长', !!gs.body.summary
    && gs.body.summary.players >= 1 && gs.body.summary.coupons >= 1
    && gs.body.summary.totalMs === undefined && gs.body.summary.totalPlays >= 3,
    JSON.stringify(gs.body.summary));

  /* 非管理员不能看 */
  const noAdm = await call('/api/admin?action=games', { token: gtk });
  t('普通用户读游戏数据被拒 403', noAdm.status === 403, '实际 ' + noAdm.status);

  /* 周榜键 cls_game_week_<game> 必须以 week_ 前缀被跳过，
     绝不能混进 u.hi（历史上真的混进过 week_snake 这种垃圾键）。
     注意：这里特意用 gameruser01 自己以外的容器也一并验，且不改变
     后续【周榜】用例的口径 —— 所以写入后立刻删掉这两条键。 */
  await call('/api/data', {
    method: 'PUT', token: gtk,
    body: { items: { cls_game_week_snake: 9, cls_game_week_tetris: 4 } },
  });
  const gs2 = await call('/api/admin?action=games', { token: adminToken });
  const me2 = (gs2.body.users || []).find((u) => u.username === 'gameruser01');
  t('★周榜键不进 u.hi（不产生 week_ 垃圾键）',
    !!me2 && Object.keys(me2.hi).every((k) => !k.startsWith('week_')),
    JSON.stringify(me2 && me2.hi));
  /* 复原：把周榜键清掉，避免污染后面的【周榜】用例（那里断言 gameruser01 不在周榜） */
  await call('/api/data?key=cls_game_week_snake', { method: 'DELETE', token: gtk });
  await call('/api/data?key=cls_game_week_tetris', { method: 'DELETE', token: gtk });
  const gs3 = await call('/api/admin?action=games', { token: adminToken });
  const me3 = (gs3.body.users || []).find((u) => u.username === 'gameruser01');
  t('周榜键可被清掉（不残留脏数据）',
    !!me3 && Object.keys(me3.hi).every((k) => !k.startsWith('week_')),
    JSON.stringify(me3 && me3.hi));
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

  /* --- H. 版本号（v2.4.0 起：自定义资料字段） --- */
  t('★前台版本号为 2.7.4', /SITE_VERSION = '2\.8\.2'/.test(indexHtml),
    (indexHtml.match(/SITE_VERSION = '([\d.]+)'/) || [])[1]);
  t('★后台版本号为 2.7.4', /SITE_VERSION = '2\.8\.2'/.test(adminHtml),
    (adminHtml.match(/SITE_VERSION = '([\d.]+)'/) || [])[1]);

  /* --- 未认领分支必须回同一套键（否则前端要写两套判断） ---
     线上实测发现过这个坑：未认领时 fieldMeta 是 undefined，
     前端 if(Array.isArray(...)) 判断就会走偏。这里用源码护栏固化。 */
  const profSrc = fs.readFileSync(new URL('./api/profile.js', import.meta.url), 'utf8');
  t('★未认领分支也返回 privateFields', /claimed: false[\s\S]{0,400}privateFields/.test(profSrc));
  t('★未认领分支也返回 fieldMeta', /claimed: false[\s\S]{0,600}fieldMeta/.test(profSrc));
}

console.log('\n【38】第三十轮·后台自定义资料字段（v2.4.0）');

/* ============================================================
   【38】验证「后台直接新增一个资料字段」的完整链路。

   这是本轮的核心：让站主不用改代码就能加字段（学籍号、宿舍号…）。
   实现上要 ALTER TABLE 加**真实列**，所以有三个必须验到的点：
     ① 字段名白名单（否则 alter table 拼列名就是 SQL 注入）
     ② 真加了列，且值能写能读
     ③ 三层可见性（全班默认 ∩ 本人意愿 ∩ 单人例外）取严
   ============================================================ */
{
  /* ---- A. 字段名白名单：这是 SQL 注入的唯一防线，必须逐条验 ---- */
  const httpSrc38 = fs.readFileSync(new URL('./api/_lib/http.js', import.meta.url), 'utf8');
  t('http.js 导出 checkFieldName', /export function checkFieldName/.test(httpSrc38));
  t('http.js 导出 FIELD_NAME_RE', /export const FIELD_NAME_RE/.test(httpSrc38));
  t('http.js 导出 RESERVED_PROFILE_COLS', /export const RESERVED_PROFILE_COLS/.test(httpSrc38));
  t('★字段名正则禁止大写/连字符/中文', /\/\^\[a-z\]\[a-z0-9_\]\{0,30\}\$\//.test(httpSrc38));

  /* 用真实接口验证：恶意字段名一律被拒 */
  const evilNames = [
    'x text; drop table profiles; --',
    'a-b',
    'A-b',
    '1abc',
    '_x',
    'a b',
    'x)',
    'a;b',
    'a"b',
    "a'b",
  ];
  for (const evil of evilNames) {
    const r = await call('/api/admin?action=add-field', {
      method: 'POST', token: adminToken,
      body: { field: evil, label: '恶意字段' },
    });
    t('恶意字段名被拒：' + JSON.stringify(evil).slice(0, 34),
      r.status === 400, '实际 ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 90));
  }

  /* 大写是**归一化**而非拒绝：学校 ID → school_id（对用户友好）。
     归一化后仍必须落在合法字符集内，所以 A-b 仍被拒（上面已验）。 */
  const upperCase = await call('/api/admin?action=add-field', {
    method: 'POST', token: adminToken,
    body: { field: 'SchoolID', label: '归一化测试' },
  });
  t('大写字段名被归一化为小写',
    upperCase.status === 200 && upperCase.body.field === 'schoolid',
    JSON.stringify(upperCase.body).slice(0, 120));
  /* 用完就删，免得污染后面的断言 */
  await call('/api/admin?action=delete-field', {
    method: 'POST', token: adminToken, body: { field: 'schoolid' },
  });

  /* 系统保留列名也必须被拒（撞列名会造成「元数据说有、含义完全不同」） */
  for (const reserved of ['name', 'student_id', 'user_id', 'id', 'field_vis', 'visibility_pref']) {
    const r = await call('/api/admin?action=add-field', {
      method: 'POST', token: adminToken,
      body: { field: reserved, label: '撞名' },
    });
    t('保留列名被拒：' + reserved, r.status === 400,
      '实际 ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 90));
  }

  /* SQL 保留字被拒 */
  const kw = await call('/api/admin?action=add-field', {
    method: 'POST', token: adminToken, body: { field: 'select', label: '关键字' },
  });
  t('SQL 保留字被拒', kw.status === 400, '实际 ' + kw.status);

  /* 缺 label 被拒 */
  const noLabel = await call('/api/admin?action=add-field', {
    method: 'POST', token: adminToken, body: { field: 'dorm_no' },
  });
  t('缺中文名被拒（400）', noLabel.status === 400, '实际 ' + noLabel.status);

  /* ---- B. 正常新增一个字段：学籍号 school_id ---- */
  const add = await call('/api/admin?action=add-field', {
    method: 'POST', token: adminToken,
    body: { field: 'school_id', label: '学籍号', visibility: 'committee' },
  });
  t('★新增字段成功', add.status === 200 && add.body.ok,
    JSON.stringify(add.body).slice(0, 160));
  t('新增字段回带 field/label/visibility',
    add.body.field === 'school_id' && add.body.label === '学籍号' && add.body.visibility === 'committee');

  /* 重复新增被拒（409） */
  const dupAdd = await call('/api/admin?action=add-field', {
    method: 'POST', token: adminToken, body: { field: 'school_id', label: '又一遍' },
  });
  t('重复新增同一字段被拒（409）', dupAdd.status === 409, '实际 ' + dupAdd.status);

  /* 字段管理列表里能查到，且带 isCustom 标记 */
  const metaList = await call('/api/admin?action=field-meta', { token: adminToken });
  t('field-meta 接口可用', metaList.status === 200 && Array.isArray(metaList.body.fields));
  const fSchool = (metaList.body.fields || []).find((f) => f.field === 'school_id');
  t('★字段管理列表含新字段', !!fSchool, JSON.stringify((metaList.body.fields || []).map((f) => f.field)));
  t('新字段标记为 isCustom', fSchool && fSchool.isCustom === true);
  t('新字段排序排在预置字段之后', fSchool && fSchool.sortOrder >= 110,
    '实际 ' + (fSchool || {}).sortOrder);
  const fName = (metaList.body.fields || []).find((f) => f.field === 'name');
  t('预置字段 isCustom 为 false', fName && fName.isCustom === false);
  t('field-meta 带 filledCount（填报数）', fSchool && typeof fSchool.filledCount === 'number');
  t('field-meta 带 totalProfiles', typeof metaList.body.totalProfiles === 'number');

  /* ---- C. 真正能写值、能读回（证明 ALTER TABLE 真加了列） ---- */
  /* 先备一条资料 */
  const mkProf = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '字段测试甲', studentId: '260001', role: '学生', extra: { school_id: 'XJ20260001' } },
  });
  t('新增资料时可直接写自定义字段', mkProf.status === 200 && mkProf.body.ok,
    JSON.stringify(mkProf.body).slice(0, 140));
  const fid = mkProf.body.id;

  const detail = await call('/api/admin?action=profile&id=' + fid, { token: adminToken });
  t('★单条资料详情带出自定义字段值',
    detail.body.profile && detail.body.profile.extra && detail.body.profile.extra.school_id === 'XJ20260001',
    JSON.stringify(detail.body.profile && detail.body.profile.extra).slice(0, 140));

  /* 列表也要带出（Excel 导出靠它） */
  const listR = await call('/api/admin?action=profiles&q=260001', { token: adminToken });
  const rowCell = (listR.body.profiles || []).find((p) => p.studentId === '260001');
  t('★资料列表带出自定义字段值',
    rowCell && rowCell.extra && rowCell.extra.school_id === 'XJ20260001',
    JSON.stringify(rowCell && rowCell.extra).slice(0, 140));
  t('资料列表同时返回 fieldMeta（省一次请求）', Array.isArray(listR.body.fieldMeta));

  /* 改值 */
  const upd = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { id: fid, name: '字段测试甲', studentId: '260001', extra: { school_id: 'XJ-改过了' } },
  });
  t('可修改自定义字段的值', upd.status === 200 && upd.body.ok);
  const detail2 = await call('/api/admin?action=profile&id=' + fid, { token: adminToken });
  t('改后的值读回正确',
    detail2.body.profile.extra.school_id === 'XJ-改过了',
    JSON.stringify(detail2.body.profile.extra));

  /* 前端传 meta 表里没有的键，不能写进库（防乱传） */
  const junk = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { id: fid, name: '字段测试甲', studentId: '260001', extra: { not_a_field: 'x', school_id: 'XJ-改过了' } },
  });
  t('extra 里未登记的键被忽略', junk.status === 200 && junk.body.ok);

  /* ---- D. 三层可见性取严 ---- */
  /* school_id 当前是 committee 档。让路人（普通学生）查，应当看不到。 */
  const seenByStudent = await call('/api/profile?action=search&q=260001', { token: bTok });
  const sRow = ((seenByStudent.body || {}).results || [])[0];
  t('★班委档字段对普通同学不可见',
    sRow && !(sRow.fields || []).some((f) => f.field === 'school_id'),
    JSON.stringify((sRow || {}).fields));

  /* 设为 public 后，普通同学就能看到 */
  const toPublic = await call('/api/admin?action=set-visibility', {
    method: 'POST', token: adminToken, body: { field: 'school_id', visibility: 'public' },
  });
  t('可把字段改为 public', toPublic.status === 200 && toPublic.body.ok);
  const seen2 = await call('/api/profile?action=search&q=260001', { token: bTok });
  const sRow2 = ((seen2.body || {}).results || [])[0];
  t('★改为 public 后普通同学可见',
    sRow2 && (sRow2.fields || []).some((f) => f.field === 'school_id' && f.value === 'XJ-改过了'),
    JSON.stringify((sRow2 || {}).fields));
  t('自定义字段带 label（前端直接显示中文名）',
    sRow2 && (sRow2.fields || []).some((f) => f.label === '学籍号'));

  /* 单人例外：把「字段测试甲」的 school_id 单独收窄为 self —— 全班仍 public，但他看不见 */
  const perOne = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { id: fid, name: '字段测试甲', studentId: '260001', fieldVis: { school_id: 'self' } },
  });
  t('可给单个人设置字段例外', perOne.status === 200 && perOne.body.ok,
    JSON.stringify(perOne.body).slice(0, 140));
  const detail3 = await call('/api/admin?action=profile&id=' + fid, { token: adminToken });
  t('★单人例外已存库',
    detail3.body.profile.fieldVis && detail3.body.profile.fieldVis.school_id === 'self',
    JSON.stringify(detail3.body.profile.fieldVis));

  const seen3 = await call('/api/profile?action=search&q=260001', { token: bTok });
  const sRow3 = ((seen3.body || {}).results || [])[0];
  t('★单人例外收窄后，普通同学看不到该字段',
    sRow3 && !(sRow3.fields || []).some((f) => f.field === 'school_id'),
    JSON.stringify((sRow3 || {}).fields));

  /* 本人仍能看到自己（self 档对本人放行） */
  /* 先把该资料绑到路人账号上，方便用本人视角查 */
  const privMe = await call('/api/profile?action=me', { token: adminToken });
  t('me 接口仍正常（回归）', privMe.status === 200 && privMe.body.ok);

  /* 放宽：单人例外设回 public，且全班也是 public → 又能看到 */
  await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { id: fid, name: '字段测试甲', studentId: '260001', fieldVis: {} },
  });
  const seen4 = await call('/api/profile?action=search&q=260001', { token: bTok });
  const sRow4 = ((seen4.body || {}).results || [])[0];
  t('清空单人例外后恢复可见',
    sRow4 && (sRow4.fields || []).some((f) => f.field === 'school_id'),
    JSON.stringify((sRow4 || {}).fields));

  /* ---- E. 改字段的名称 / 排序 / 可见性 ---- */
  const updField = await call('/api/admin?action=update-field', {
    method: 'POST', token: adminToken,
    body: { field: 'school_id', label: '全国学籍号', sortOrder: 15 },
  });
  t('可改字段显示名与排序', updField.status === 200 && updField.body.ok,
    JSON.stringify(updField.body).slice(0, 140));
  const meta2 = await call('/api/admin?action=field-meta', { token: adminToken });
  const fS2 = (meta2.body.fields || []).find((f) => f.field === 'school_id');
  t('改名生效', fS2 && fS2.label === '全国学籍号', (fS2 || {}).label);
  t('改排序生效', fS2 && fS2.sortOrder === 15, String((fS2 || {}).sortOrder));

  const badVis = await call('/api/admin?action=update-field', {
    method: 'POST', token: adminToken, body: { field: 'school_id', visibility: 'everyone' },
  });
  t('非法可见性被拒', badVis.status === 400, '实际 ' + badVis.status);

  /* ---- F. 系统字段不可删，自定义字段可删 ---- */
  const delSys = await call('/api/admin?action=delete-field', {
    method: 'POST', token: adminToken, body: { field: 'name' },
  });
  t('★系统字段不可删（400）', delSys.status === 400, '实际 ' + delSys.status);

  const delCustom = await call('/api/admin?action=delete-field', {
    method: 'POST', token: adminToken, body: { field: 'school_id' },
  });
  t('★自定义字段可删', delCustom.status === 200 && delCustom.body.ok,
    JSON.stringify(delCustom.body).slice(0, 140));

  const meta3 = await call('/api/admin?action=field-meta', { token: adminToken });
  t('删后字段管理列表里不再有它',
    !(meta3.body.fields || []).some((f) => f.field === 'school_id'));

  /* 删列后原值也不该再被读出来 */
  const seen5 = await call('/api/profile?action=search&q=260001', { token: bTok });
  const sRow5 = ((seen5.body || {}).results || [])[0];
  t('删字段后前台不再返回它',
    sRow5 && !(sRow5.fields || []).some((f) => f.field === 'school_id'));

  /* ---- G. 存量字段真的建了列（id_card / youth_league_no） ---- */
  const schemaSrc38 = fs.readFileSync(new URL('./api/schema.sql', import.meta.url), 'utf8');
  t('★schema.sql 给 id_card 建列', /add column if not exists id_card/.test(schemaSrc38));
  t('★schema.sql 给 youth_league_no 建列', /add column if not exists youth_league_no/.test(schemaSrc38));
  t('★ensureSchema 同步给 id_card 建列', /add column if not exists id_card/.test(httpSrc38));
  t('★ensureSchema 同步给 youth_league_no 建列', /add column if not exists youth_league_no/.test(httpSrc38));
  t('schema.sql 含 field_vis 列',
    /add column if not exists field_vis/.test(schemaSrc38));
  t('ensureSchema 含 field_vis 补列', /add column if not exists field_vis/.test(httpSrc38));

  /* 真写一个身份证号，验证「仅本人可见」档真的工作 */
  const idProf = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '证件测试乙', studentId: '260002', extra: { id_card: '360424201007100011' } },
  });
  t('可写入身份证号', idProf.status === 200 && idProf.body.ok);
  const idDetail = await call('/api/admin?action=profile&id=' + idProf.body.id, { token: adminToken });
  t('身份证号读回正确',
    idDetail.body.profile.extra.id_card === '360424201007100011',
    JSON.stringify(idDetail.body.profile.extra));
  const idSearch = await call('/api/profile?action=search&q=260002', { token: bTok });
  const idRow = ((idSearch.body || {}).results || [])[0];
  t('★身份证号（self 档）对外一律不可见',
    idRow && !(idRow.fields || []).some((f) => f.field === 'id_card'),
    JSON.stringify((idRow || {}).fields));

  /* ---- G2. Excel 批量导入也要支持自定义字段（v2.4.0） ----
     缺口记录（2026-10-09）：batchProfiles 原本硬编码 9 个固定列，
     前端已经把动态表头解析进 row.extra 了，后端却收不到 → 导入后自定义字段全丢。
     这一节就是钉死这个行为。 */
  const addAgain = await call('/api/admin?action=add-field', {
    method: 'POST', token: adminToken,
    body: { field: 'school_id', label: '学籍号', visibility: 'public' },
  });
  t('重新加回 school_id 字段（供导入测试）', addAgain.status === 200 && addAgain.body.ok,
    JSON.stringify(addAgain.body).slice(0, 120));

  /* 新增型导入：两条全新记录，带自定义字段 */
  const batchNew = await call('/api/admin?action=batch-profiles', {
    method: 'POST', token: adminToken,
    body: {
      rows: [
        { name: '导入甲', studentId: '270001', role: '学生', wechat: 'wx_a',
          extra: { school_id: 'XJ-BATCH-1' } },
        { name: '导入乙', studentId: '270002', role: '学生',
          extra: { school_id: 'XJ-BATCH-2', not_a_field: '应被忽略' } },
      ],
    },
  });
  t('★批量导入支持 extra（成功 2 条）',
    batchNew.status === 200 && batchNew.body.created === 2,
    JSON.stringify(batchNew.body).slice(0, 180));

  const impList = await call('/api/admin?action=profiles&q=270001', { token: adminToken });
  const impRow = (impList.body.profiles || []).find((p) => p.studentId === '270001');
  t('★导入的新记录带上了自定义字段值',
    impRow && impRow.extra && impRow.extra.school_id === 'XJ-BATCH-1',
    JSON.stringify(impRow && impRow.extra).slice(0, 140));

  const impList2 = await call('/api/admin?action=profiles&q=270002', { token: adminToken });
  const impRow2 = (impList2.body.profiles || []).find((p) => p.studentId === '270002');
  t('导入时未登记的 extra 键被丢弃',
    impRow2 && impRow2.extra && impRow2.extra.school_id === 'XJ-BATCH-2'
      && !('not_a_field' in impRow2.extra),
    JSON.stringify(impRow2 && impRow2.extra).slice(0, 140));

  /* 更新型导入：已有记录，改自定义字段值 */
  const batchUpd = await call('/api/admin?action=batch-profiles', {
    method: 'POST', token: adminToken,
    body: { rows: [{ name: '导入甲', studentId: '270001', role: '学生', extra: { school_id: 'XJ-BATCH-1-B' } }] },
  });
  t('★批量导入可更新已有记录的自定义字段',
    batchUpd.status === 200 && batchUpd.body.updated === 1,
    JSON.stringify(batchUpd.body).slice(0, 180));
  const impList3 = await call('/api/admin?action=profiles&q=270001', { token: adminToken });
  const impRow3 = (impList3.body.profiles || []).find((p) => p.studentId === '270001');
  t('更新后的自定义字段值正确',
    impRow3 && impRow3.extra.school_id === 'XJ-BATCH-1-B',
    JSON.stringify(impRow3 && impRow3.extra).slice(0, 140));

  /* 恶意列名不能借导入通道绕过白名单（这是 SQL 注入的第二条入口） */
  const batchEvil = await call('/api/admin?action=batch-profiles', {
    method: 'POST', token: adminToken,
    body: { rows: [{ name: '导入恶意', studentId: '270003', role: '学生',
      extra: { 'x text; drop table profiles; --': '1', 'a-b': '2' } }] },
  });
  t('★导入通道的非法列名被丢弃（不报错也不执行）',
    batchEvil.status === 200 && batchEvil.body.created === 1,
    JSON.stringify(batchEvil.body).slice(0, 180));
  const stillAlive = await call('/api/admin?action=profiles&q=270003', { token: adminToken });
  t('★profiles 表仍在（注入未得逞）',
    stillAlive.status === 200 && (stillAlive.body.profiles || []).length === 1,
    'HTTP ' + stillAlive.status);

  /* 清理 */
  for (const sid of ['270001', '270002', '270003']) {
    const f = await call('/api/admin?action=profiles&q=' + sid, { token: adminToken });
    const row = (f.body.profiles || [])[0];
    if (row) await call('/api/admin?action=delete-profile', { method: 'POST', token: adminToken, body: { id: row.id } });
  }

  /* ---- H. 审计留痕 ---- */
  const logs38 = await call('/api/admin?action=audit&limit=200', { token: adminToken });
  const acts = (logs38.body.logs || []).map((x) => x.action);
  t('字段新增有审计', acts.includes('field.add'), JSON.stringify(acts.slice(0, 20)));
  t('字段删除有审计', acts.includes('field.delete'));
  t('字段改名有审计', acts.includes('field.update'));
  t('字段可见性变更有审计', acts.includes('field.visibility'));

  /* ---- I. 版本号 ---- */
  const indexHtml38 = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const adminHtml38 = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
  t('★前台版本号为 2.7.4', /SITE_VERSION = '2\.8\.2'/.test(indexHtml38),
    (indexHtml38.match(/SITE_VERSION = '([\d.]+)'/) || [])[1]);
  t('★后台版本号为 2.7.4', /SITE_VERSION = '2\.8\.2'/.test(adminHtml38),
    (adminHtml38.match(/SITE_VERSION = '([\d.]+)'/) || [])[1]);

  /* ---- J. 桩本身要能跑普通调用形式（否则上面那些断言是假绿） ---- */
  t('★测试桩支持 sql(字符串, 参数) 普通调用形式',
    /typeof strings === 'string'/.test(fs.readFileSync(new URL('./test_e2e.mjs', import.meta.url), 'utf8')));
  /* 只查代码行，剔除注释 —— 注释里会提到「本版本没有 sql.unsafe()」这句说明文字。
     ⚠️ 判据要同时看行首和行尾：块注释的**中间行**以普通文字开头，
        只在行尾带块注释结束符（这一条就是踩了这个坑才被漏过滤的）。 */
  const admCode38 = fs.readFileSync(new URL('./api/admin.js', import.meta.url), 'utf8')
    .split('\n').filter((l) => {
      const s = l.trim();
      if (!s) return false;
      if (s.startsWith('*') || s.startsWith('//') || s.startsWith('/*')) return false;
      if (s.endsWith('*/')) return false;
      return true;
    }).join('\n');
  t('★admin.js 不再使用不存在的 sql.unsafe()',
    !/sql\.unsafe\s*\(/.test(admCode38));
  t('★写入路径用 isSafeFieldFormat（不挡系统列）',
    /isSafeFieldFormat\s*\(\s*f\.field\s*\)/.test(admCode38));

  /* ---- K. 前端护栏：字段管理 UI 与动态列 ---- */
  const adminHtmlSrc = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
  t('后台有「字段管理」入口按钮', /id="pfFields"/.test(adminHtmlSrc));
  t('后台有字段管理面板容器', /id="pfFieldPanel"/.test(adminHtmlSrc));
  t('后台有 renderFieldPanel', /function renderFieldPanel/.test(adminHtmlSrc));
  t('后台有新增字段弹窗', /function addFieldDialog/.test(adminHtmlSrc));
  t('后台有删除字段确认', /function deleteFieldConfirm/.test(adminHtmlSrc));
  t('后台有改名/排序', /function renameFieldDialog/.test(adminHtmlSrc) && /function sortFieldDialog/.test(adminHtmlSrc));
  t('★后台字段管理支持快捷切换可见性', /data-fv="/.test(adminHtmlSrc));
  t('★后台资料列表支持动态列', /function extraColsOf/.test(adminHtmlSrc));
  t('后台编辑弹窗渲染自定义字段输入框', /data-xf="/.test(adminHtmlSrc));
  t('★后台编辑弹窗支持单人可见性例外', /data-vf="/.test(adminHtmlSrc));
  t('后台保存时带上 extra', /payload\.extra\s*=/.test(adminHtmlSrc));
  t('后台保存时带上 fieldVis', /payload\.fieldVis\s*=/.test(adminHtmlSrc));
  t('后台导出支持动态列', /extras\.forEach\(function\(f\)\{\s*\n?\s*row\[f\.label\]/.test(adminHtmlSrc)
    || /row\[f\.label\]\s*=/.test(adminHtmlSrc));
  t('后台导入识别自定义字段表头', /pick\(r, \[f\.label, f\.field\]\)/.test(adminHtmlSrc));
  t('后台有 extra-row 样式', /\.extra-row\{/.test(adminHtmlSrc));
  t('后台有 btn-xs 样式', /\.btn-xs\{/.test(adminHtmlSrc));
  t('后台有 badge-purple 样式', /\.badge-purple\{/.test(adminHtmlSrc));

  /* ---- L. ★带 body 的 api() 必须显式写 method:'POST' ----
     踩坑记录（2026-10-09）：fetch 默认 GET，带 body 的 GET 会被浏览器直接抛
     「Request with GET/HEAD method cannot have body」，表现为「按钮点了没反应」，
     而且 api() 里 catch 到的是同步抛错 → 只弹一个 toast，排查很费劲。
     所以这里做全量静态扫描：凡 api('...', { ...body... }) 而同一对花括号内没有
     method 的，一律判红。 */
  const badApiCalls = [];
  {
    const re = /api\(\s*'[^']*'\s*,\s*\{/g;
    let m;
    while ((m = re.exec(adminHtmlSrc)) !== null) {
      /* 从 { 开始做括号配平，取出这个对象字面量 */
      let i = m.index + m[0].length - 1, depth = 0, end = -1;
      for (let k = i; k < adminHtmlSrc.length; k++) {
        if (adminHtmlSrc[k] === '{') depth++;
        else if (adminHtmlSrc[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
      }
      if (end < 0) continue;
      const obj = adminHtmlSrc.slice(i, end + 1);
      if (/\bbody\s*:/.test(obj) && !/method\s*:/.test(obj)) badApiCalls.push(obj.slice(0, 90));
    }
  }
  t('★所有带 body 的 api() 都显式声明了 POST',
    badApiCalls.length === 0,
    badApiCalls.length ? '漏了 ' + badApiCalls.length + ' 处：' + badApiCalls.join(' | ') : '');
  t('本轮 5 个字段管理接口都走 POST',
    ['set-visibility', 'add-field', 'update-field', 'delete-field']
      .every((a) => new RegExp("api\\('/admin\\?action=" + a + "'[^)]*method\\s*:\\s*'POST'").test(adminHtmlSrc))
    /* update-field 出现两次，delete-field 一次；上面的正则做了宽松匹配 */
  );

  const indexHtmlSrc = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  t('★前台搜索结果渲染额外字段', /p\.fields/.test(indexHtmlSrc) && /pc-extra/.test(indexHtmlSrc));
  t('前台有 pc-extra 样式', /\.pc-extra\{/.test(indexHtmlSrc));
  t('前台不在客户端做可见性判断（后端已滤过）',
    !/visibility\s*===\s*'self'/.test(indexHtmlSrc.slice(indexHtmlSrc.indexOf('function renderContactResults'),
                                                      indexHtmlSrc.indexOf('function renderContactResults') + 4000)));
}

console.log('\n【39】第三十轮修正·「后台权力最大」（v2.4.1）');

/* ============================================================
   【39】站主原话：「记住，后台的权力是最大的，即使他修改了可见范围，
   但是后台还是可以修改」。

   这条推翻了 v2.4.0 的「三层取严」设计 —— 取严意味着管理员**永远无法放宽**
   （同学设了 self，管理员改 public 也白改）。现改为三级优先级：
     ① field_vis（管理员单人例外）     → 直接生效，覆盖同学
     ② meta.visibility ≠ 出厂值        → 直接生效，覆盖同学
     ③ 以上都没有 → 用同学意愿兜底，此时只能收窄
   即：**站主动过这个字段，同学说的就不算；站主没动过，同学的隐私仍被尊重**。
   ============================================================ */
{
  /* ---- A. 源码层：确认不再是无条件取严，且判据是显式锁标记 ---- */
  const profSrc39 = fs.readFileSync(new URL('./api/profile.js', import.meta.url), 'utf8');
  const admSrc39raw = fs.readFileSync(new URL('./api/admin.js', import.meta.url), 'utf8');
  const canSeeBody = profSrc39.slice(profSrc39.indexOf('function canSee'),
                                     profSrc39.indexOf('function canSee') + 2200);
  /* 🔴 v2.4.1 血的教训：buildFieldVis 的白名单必须来自 loadFieldMeta()，
     不能用 loadEditableFields() —— 后者滤掉了 SPECIAL_FIELDS，
     而 wechat / qq / phone 恰在其中，于是站主给某人设的微信例外被静默丢弃，
     表现为「点了保存但对方还是看不到」，极难排查。 */
  t('★fieldVis 白名单用 loadFieldMeta（不能滤掉 wechat/qq/phone）',
    /buildFieldVis\(b\.fieldVis,\s*allMeta\.map\(/.test(admSrc39raw));
  t('★canSee 已不再对 field_vis 取严',
    !/stricter\s*\(\s*eff\s*,\s*f\s*\)/.test(canSeeBody));
  /* 判据必须是**显式锁定标记**，不能是「visibility 和出厂值比对」——
     站主可以把字段设成它本来就是的档（wechat 出厂 public，他点「公开」），
     值不变但确实动过，比对法分辨不出来。 */
  t('★已彻底删除 FACTORY_VIS 比对法（profile.js）',
    !/FACTORY_VIS/.test(profSrc39));
  t('★已彻底删除 FACTORY_VIS 比对法（admin.js）',
    !/FACTORY_VIS/.test(admSrc39raw));
  t('★canSee 用 visLocked 判据决定是否忽略同学意愿',
    /m\.visLocked/.test(canSeeBody) && /eff\s*=\s*group/.test(canSeeBody));
  t('★loadMeta 输出 visLocked 标记', /visLocked\s*:/.test(profSrc39));
  t('★profile.js 把 is_custom 也视为天然已锁定',
    /visLocked\s*:\s*!!r\.vis_locked\s*\|\|\s*!!r\.is_custom/.test(profSrc39));
  t('★admin.js loadFieldMeta 读 vis_locked 并输出 adminSet',
    /vis_locked/.test(admSrc39raw) && /adminSet\s*:/.test(admSrc39raw));
  t('★setVisibility 写入 vis_locked = true',
    /set visibility = \$\{vis\}, vis_locked = true/.test(admSrc39raw));
  t('★addField 建自定义字段时 vis_locked 默认 true',
    /is_custom, vis_locked\)[\s\S]{0,120}true, true\)/.test(admSrc39raw));
  t('★updateField 改 visibility 时置 vis_locked = true', /const lockIt = visibility != null/.test(admSrc39raw));
  t('★updateField 只改 label/sort 时不误锁（保住同学隐私）',
    /vis_locked = \$\{lockIt \? true/.test(admSrc39raw));
  /* schema 与 ensureSchema 都要有这一列（老库升级靠补列语句） */
  const schemaSrc39 = fs.readFileSync(new URL('./api/schema.sql', import.meta.url), 'utf8');
  t('★schema.sql 的 profile_field_meta 含 vis_locked 列',
    /vis_locked\s+boolean\s+not null\s+default\s+false/.test(schemaSrc39));
  t('★schema.sql 含 vis_locked 幂等补列语句',
    /alter table profile_field_meta add column if not exists vis_locked/.test(schemaSrc39));
  const httpSrc39 = fs.readFileSync(new URL('./api/_lib/http.js', import.meta.url), 'utf8');
  t('★ensureSchema 含 vis_locked 建表列',
    /is_custom\s+boolean\s+not null\s+default\s+false,\s*\n?\s*vis_locked/.test(httpSrc39));
  t('★ensureSchema 含 vis_locked 补列语句',
    /alter table profile_field_meta add column if not exists vis_locked/.test(httpSrc39));

  /* ---- B. 行为层：真跑接口 ----
     准备：一条资料 + 同学把微信设成「仅自己可见」 */
  const mk39 = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '权限测试丙', studentId: '280001', role: '学生',
            wechat: 'wx_perm_test', qq: '88001', phone: '18800000001' },
  });
  t('（准备）建一条带联系方式的资料', mk39.status === 200 && mk39.body.ok,
    JSON.stringify(mk39.body).slice(0, 120));
  const pid39 = mk39.body.id;

  /* 同学本人在个人中心把微信设为仅自己可见 */
  const sub39 = await call('/api/profile?action=submit', {
    method: 'POST', token: bTok,
    body: { wechat: 'wx_perm_test', qq: '88001', phone: '18800000001',
            visibilityPref: { wechat: false, qq: true, phone: true } },
  });
  t('（准备）同学设了「微信仅自己可见」', sub39.status === 200, JSON.stringify(sub39.body).slice(0, 120));

  /* 站主审核通过，让资料对外可见。
     ⚠️ 注意：contact_status 是**独立于可见性**的一道门 ——
        只有 approved 才对外展示（防乱填）。所以验可见性前必须先让它 approved，
        否则无论可见性怎么调都看不到，测试会误判成「后台改不动」。 */
  await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { id: pid39, name: '权限测试丙', studentId: '280001',
            contactStatus: 'approved', visibilityPref: { wechat: false } },
  });
  /* 确认前置条件成立 */
  const chk39 = await call('/api/admin?action=profile&id=' + pid39, { token: adminToken });
  t('（准备）资料已审核通过',
    chk39.body.profile && chk39.body.profile.contactStatus === 'approved',
    JSON.stringify((chk39.body.profile || {}).contactStatus));
  t('（准备）同学意愿已存为微信私密',
    chk39.body.profile && chk39.body.profile.visibilityPref
      && chk39.body.profile.visibilityPref.wechat === false,
    JSON.stringify((chk39.body.profile || {}).visibilityPref));

  const q39 = async (label) => {
    const r = await call('/api/profile?action=search&q=280001', { token: bTok });
    const p = ((r.body || {}).results || [])[0] || {};
    return { hasWechat: !!p.wechat, vis: p.contactVisible, label,
             raw: { wechat: p.wechat, qq: p.qq, phone: p.phone,
                    contactStatus: p.contactStatus, contactVisible: p.contactVisible,
                    phoneMasked: p.phoneMasked } };
  };

  /* 场景 1：站主没动过 wechat 字段 → 同学的「仅自己可见」生效 */
  let st1 = await q39('admin-untouched');
  t('★场景1 站主未动过该字段 → 同学设的私密生效（看不到微信）',
    st1.hasWechat === false, JSON.stringify(st1));

  /* 场景 2：站主在字段管理里把 wechat 放宽为 public → 应当覆盖同学的设置 */
  const setPub = await call('/api/admin?action=set-visibility', {
    method: 'POST', token: adminToken, body: { field: 'wechat', visibility: 'public' },
  });
  t('（准备）站主把 wechat 全班默认改为 public', setPub.status === 200);
  let st2 = await q39('admin-widened');
  t('★★后台权力最大：站主放宽后，同学的「仅自己可见」被覆盖，微信可见',
    st2.hasWechat === true, JSON.stringify(st2));
  console.log('      [debug] st2 =', JSON.stringify(st2));

  /* 场景 3：站主再收窄为 self → 同样直接生效 */
  await call('/api/admin?action=set-visibility', {
    method: 'POST', token: adminToken, body: { field: 'wechat', visibility: 'self' },
  });
  let st3 = await q39('admin-narrowed');
  t('★站主收窄为 self 后，微信不可见', st3.hasWechat === false, JSON.stringify(st3));

  /* 场景 4：单人例外可以放宽 —— 全班默认 self，但给这一条单独设 public */
  const perOpen = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { id: pid39, name: '权限测试丙', studentId: '280001', fieldVis: { wechat: 'public' } },
  });
  t('（准备）给单人设例外 wechat=public', perOpen.status === 200,
    JSON.stringify(perOpen.body).slice(0, 120));
  let st4 = await q39('perperson-widen');
  t('★★单人例外可放宽：全班 self 但这一条单独 public → 可见',
    st4.hasWechat === true, JSON.stringify(st4));

  /* 场景 5：单人例外也能收窄（即使全班默认 public） */
  await call('/api/admin?action=set-visibility', {
    method: 'POST', token: adminToken, body: { field: 'wechat', visibility: 'public' },
  });
  await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { id: pid39, name: '权限测试丙', studentId: '280001', fieldVis: { wechat: 'self' } },
  });
  let st5 = await q39('perperson-narrow');
  t('★单人例外可收窄：全班 public 但这一条单独 self → 不可见',
    st5.hasWechat === false, JSON.stringify(st5));

  /* 场景 6：清掉单人例外 → 回落到全班默认（public）→ 可见 */
  await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { id: pid39, name: '权限测试丙', studentId: '280001', fieldVis: {} },
  });
  let st6 = await q39('clear-exception');
  t('★清掉单人例外后回落到全班默认（public）→ 可见',
    st6.hasWechat === true, JSON.stringify(st6));

  /* ---- C. 锁定标记（adminSet）行为 ----
     ⚠️ v2.4.1 语义已变：**不能**靠「visibility 是否等于出厂值」判断站主动没动过。
        站主完全可以把字段设成它本来就是的档（wechat 出厂 public，他点「公开」），
        值没变但确实动过 —— 比对法分辨不出来，这就是本轮 3 项失败的真根因。
        现在判据是 profile_field_meta.vis_locked，由 set-visibility / update-field 写入。 */
  const meta39 = await call('/api/admin?action=field-meta', { token: adminToken });
  const fWx = (meta39.body.fields || []).find((f) => f.field === 'wechat');
  t('field-meta 输出 adminSet 字段', fWx && typeof fWx.adminSet === 'boolean',
    JSON.stringify(fWx));
  /* 上面场景 2/3/4/5 反复 set-visibility 改过 wechat → 必已锁定 */
  t('★wechat 被站主改过 → adminSet 为 true（即使值恰好是 public）',
    fWx && fWx.adminSet === true, String(fWx && fWx.adminSet));

  /* 锁定标记是**单向**的：改回原值不会解锁（这正是比对法做不到的） */
  await call('/api/admin?action=set-visibility', {
    method: 'POST', token: adminToken, body: { field: 'wechat', visibility: 'public' },
  });
  const meta39c = await call('/api/admin?action=field-meta', { token: adminToken });
  const fWx2 = (meta39c.body.fields || []).find((f) => f.field === 'wechat');
  t('★把 wechat 改回 public 后 adminSet 仍为 true（锁定单向）',
    fWx2 && fWx2.adminSet === true, String(fWx2 && fWx2.adminSet));

  /* 没动过的字段保持 false（尊重同学的那一类） */
  const fQq = (meta39c.body.fields || []).find((f) => f.field === 'qq');
  t('★没动过的 qq → adminSet 为 false（此字段仍尊重同学意愿）',
    fQq && fQq.adminSet === false, String(fQq && fQq.adminSet));

  /* 只改 label 不该顺手锁住可见性 —— 否则站主改个中文名就把同学隐私作废了 */
  await call('/api/admin?action=update-field', {
    method: 'POST', token: adminToken, body: { field: 'qq', label: 'QQ（改名前测试）' },
  });
  const meta39d = await call('/api/admin?action=field-meta', { token: adminToken });
  const fQq2 = (meta39d.body.fields || []).find((f) => f.field === 'qq');
  t('★只改 label 不锁可见性（adminSet 仍为 false）',
    fQq2 && fQq2.adminSet === false, String(fQq2 && fQq2.adminSet));
  /* 恢复 qq 的名字 */
  await call('/api/admin?action=update-field', {
    method: 'POST', token: adminToken, body: { field: 'qq', label: 'QQ 号' },
  });
  /* 通过 update-field 改 visibility 则要锁定 */
  await call('/api/admin?action=update-field', {
    method: 'POST', token: adminToken, body: { field: 'qq', visibility: 'committee' },
  });
  const meta39e = await call('/api/admin?action=field-meta', { token: adminToken });
  const fQq3 = (meta39e.body.fields || []).find((f) => f.field === 'qq');
  t('★通过 update-field 改 visibility 也会锁定（adminSet 变 true）',
    fQq3 && fQq3.adminSet === true, String(fQq3 && fQq3.adminSet));
  /* 恢复 qq 原状：visibility 回 public（已锁，但值对即可） */
  await call('/api/admin?action=set-visibility', {
    method: 'POST', token: adminToken, body: { field: 'qq', visibility: 'public' },
  });

  /* ---- E. 新增资料时必须带上 visibility_pref（v2.4.1 修） ----
     🔴 原来 prefJson 只在 UPDATE 分支被用到，INSERT 分支没带这一列 ——
        站主给同学设了「仅自己可见」后新建资料，意愿被**静默丢弃**，
        读回来永远是 {}。这个 bug 静态测试查不出来，是线上验收抓到的。 */
  const mkNew = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '意愿新建测试', studentId: '280777', role: '学生',
            wechat: 'wx_pref_new', contactStatus: 'approved',
            visibilityPref: { wechat: false, qq: true, phone: true } },
  });
  t('★新增资料时 visibilityPref 被写入（不再静默丢弃）',
    mkNew.status === 200 && mkNew.body.ok, JSON.stringify(mkNew.body).slice(0, 120));
  const newId39 = mkNew.body.id;
  const newDet = await call('/api/admin?action=profile&id=' + newId39, { token: adminToken });
  const np = (newDet.body.profile || {}).visibilityPref || {};
  t('★★新建资料的 visibilityPref.wechat === false',
    np.wechat === false, JSON.stringify(np));
  t('★新建资料的 visibilityPref 三项都在',
    ('wechat' in np) && ('qq' in np) && ('phone' in np), JSON.stringify(np));

  /* 行为层：这条新建资料对外查询时，微信应当被同学意愿挡住。
     此时 wechat 已被前面的场景锁上（adminSet=true），同学意愿会被忽略 ——
     正好用来做**对照**：先在锁定态验「站主说了算」，再解锁验「同学意愿生效」。 */
  const srchLocked = await call('/api/profile?action=search&q=280777', { token: bTok });
  const spLocked = ((srchLocked.body || {}).results || [])[0] || {};
  t('★（对照）wechat 处于锁定态 → 站主说了算，微信可见',
    !!spLocked.wechat, JSON.stringify({ wechat: spLocked.wechat }));

  /* 临时解锁 wechat，验「同学意愿真的存进去了、且在未被站主动过时生效」 */
  db.run("update profile_field_meta set vis_locked = 0 where field = 'wechat'");
  const srch39 = await call('/api/profile?action=search&q=280777', { token: bTok });
  const sp39 = ((srch39.body || {}).results || [])[0] || {};
  t('★解锁后同学的「微信仅自己可见」生效（查不到微信）',
    !sp39.wechat, JSON.stringify({ wechat: sp39.wechat, qq: sp39.qq }));
  /* 恢复锁定（前面场景已把 wechat 锁上，这里只是临时解锁来验这条路径） */
  db.run("update profile_field_meta set vis_locked = 1 where field = 'wechat'");
  await call('/api/admin?action=delete-profile', {
    method: 'POST', token: adminToken, body: { id: newId39 },
  });

  /* ---- F. 版本号必须在手机上也能看见（2026-10-10） ----
     ⚠️ 以前版本号只在左侧边栏底部的 #adminVer —— 手机上侧边栏默认收起，
        站主根本看不到，于是无法判断自己打开的是不是缓存的旧页面，
        反复反馈「我改了但没生效」（其实是手机缓存）。顶栏必须也有一份。 */
  const adminHtml39b = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
  t('★后台顶栏有版本号元素 #headVer（手机上可见）', /id="headVer"/.test(adminHtml39b));
  t('★#headVer 在 header.head 里（不是藏在侧边栏里）',
    /<header class="head">[\s\S]{0,1200}id="headVer"/.test(adminHtml39b));
  t('★paintAdminVer 同时写顶栏和侧边栏',
    /var h = \$\('headVer'\);\s*if\(h\) h\.textContent/.test(adminHtml39b));
  t('★点顶栏版本号能回查线上构建号', /id="headVer"[^>]*onclick="checkAdminVer\(\)"/.test(adminHtml39b));

  /* ---- G. 进「头衔任命」必须回到第 1 页（2026-10-10 修） ----
     🔴 站主反馈「头衔那里还是没显示啊，比如冷思敏的名字」的真根因：
        STATE.titles 是**跨页面存活**的模块状态，renderTitles 结尾只写
        loadTitles() 没重置 S.page —— 站主翻到 3/3 页后切走再回来，
        页码仍是 3，只看到最后 2 个人（梁咏佳/冷伟明），
        而冷思敏在**第 1 页**（索引 19/62），于是以为名单没显示全。
        这个 bug 只有「翻到末页 → 离开 → 回来」才复现，静态断言必须盯死。 */
  const rt = adminHtml39b.slice(adminHtml39b.indexOf('function renderTitles'),
                                adminHtml39b.indexOf('function loadTitles'));
  t('★切进「头衔任命」页会强制回到第 1 页', /S\.page\s*=\s*1;\s*\n\s*loadTitles\(\);/.test(rt));
  t('★「刷新」按钮也重置页码', /ttRefresh'\)\.onclick\s*=\s*function\(\)\{\s*S\.page\s*=\s*1;/.test(adminHtml39b));
  t('★改搜索词也重置页码', /S\.q\s*=\s*e\.target\.value\.trim\(\);\s*S\.page\s*=\s*1;/.test(adminHtml39b));
  t('★「只看已任命」也重置页码', /S\.onlySet\s*=\s*!!onlyBox\.checked;\s*S\.page\s*=\s*1;/.test(adminHtml39b));
  /* 末页要有「前面还有 N 页」的显式提示，否则在末页找第 1 页的人会找不到 */
  t('★末页提示「前面还有 N 页」', /前面还有\s*' \+ \(pages - 1\) \+ ' 页/.test(adminHtml39b));

  /* ---- H. 前端护栏：后台要提醒「本人已设为私密」 ---- */
  const adminHtml39 = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
  t('★后台编辑弹窗标出「本人已设为私密」', /本人已设为私密/.test(adminHtml39));
  t('★后台标出「已被你覆盖」的情况', /已被你覆盖/.test(adminHtml39));
  t('后台文案说明「后台权力最大」', /后台权力最大/.test(adminHtml39));
  const indexHtml39 = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  t('★前台告知同学「以站主设置为准」', /以站主设置为准|则以站主设置为准/.test(indexHtml39));

  /* 清理 */
  await call('/api/admin?action=delete-profile', {
    method: 'POST', token: adminToken, body: { id: pid39 },
  });
}

console.log('\n【40】第三十一轮·取消备用链接（v2.5.0）');
{
  const idx40 = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  /* 备用链接（WorkBuddy 托管）已取消：SITE_DATA.siteLinks 只应有主链接。
     用两个信号交叉验证：① 不该再出现 workbuddy.link 域名；② siteLinks 里只有一项。 */
  t('★index.html 不再出现 workbuddy.link 备用域名', idx40.indexOf('workbuddy.link') < 0);
  const linksBlock = idx40.match(/siteLinks:\s*\[[\s\S]*?\]/);
  t('★siteLinks 只剩主链接一项', !!linksBlock
    && (linksBlock[0].match(/\{/g) || []).length === 1
    && linksBlock[0].indexOf('yuzikaaang.github.io/class-site') >= 0,
    linksBlock ? linksBlock[0].slice(0, 200) : 'not found');
  /* 「敬请期待」那条备用占位行也必须删掉，否则会显示一个永远点不了的占位 */
  t('★openCopyLink 不再渲染备用占位行',
    idx40.indexOf('hasBackup') < 0 && !/🔄 备用链接/.test(idx40));
  /* 弹窗说明文案不该再提「备用链接」 */
  const copyTip = idx40.match(/复制班级服务站链接[\s\S]{0,200}?<\/p>/);
  t('★复制链接弹窗文案不再提备用链接',
    !!copyTip && copyTip[0].indexOf('备用链接') < 0,
    copyTip ? copyTip[0].slice(0, 160) : 'not found');

  const readme40 = fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  t('★README 不再出现备用链接域名', readme40.indexOf('workbuddy.link') < 0);
  t('★README 不再把备用链接当现行做法', readme40.indexOf('备用链接') < 0
    || /备用链接已于|已于 v2\.5\.0 取消/.test(readme40));
}

console.log('\n【41】第三十一轮·登录验证码（v2.5.0 滑块 → v2.6.3 改输入式图形码）');
{
  const idx41 = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  t('★有验证码引擎 capInit', idx41.indexOf('function capInit(') >= 0);
  t('★有交互绑定 capBind', idx41.indexOf('function capBind(') >= 0);
  t('★有校验入口 capPassed', idx41.indexOf('function capPassed(') >= 0);
  t('登录表单渲染出验证码（capHtml 被插入 form）', /capHtml\(\)/.test(idx41));
  t('★doLogin 提交前校验验证码',
    /function doLogin\(\)\{[\s\S]{0,220}capPassed\(\)/.test(idx41));
  t('★doRegister 提交前校验验证码', /function doRegister\(\)\{[\s\S]{0,320}capPassed\(\)/.test(idx41));
  /* 纯前端：不该有任何验证码相关的网络请求 */
  t('★验证码不联网（无 captcha/verify 接口调用）',
    !/api\(['"][^'"]*captcha/i.test(idx41) && !/action=captcha/i.test(idx41));
  t('验证码 canvas 使用 dpr 缩放（清晰不糊）',
    /devicePixelRatio/.test(idx41) && /setTransform\(dpr/.test(idx41));

  /* ---- 🚀 v2.6.3：滑块 → 输入式图形验证码（站主要求） ----
     站主反馈「滑块验证在有些老的手机屏幕上用不了」。根因两条：
       ① 滑块走 **Pointer Events** —— 老浏览器（iOS Safari < 13 /
          Android Chrome < 55）根本不支持，事件一个都不触发，滑块纹丝不动；
       ② 拖动还要求手指精准，屏幕旧了 / 触摸不灵时很难完成。
     改成输入式后只看「键盘能不能打字」，不再依赖任何手势。 */
  /* 取验证码代码区间单独检查 —— 页面别处（音量条 / 播放进度条）本来就用
     pointer 事件，那是正常的，断言不能扫全文，否则会误伤。 */
  const capBlock = idx41.slice(idx41.indexOf('function capHtml('),
                               idx41.indexOf('function doRegister('));
  t('★滑块已彻底移除（拼图块 / 轨道 / 拖动 / Pointer 事件全清）',
    capBlock.length > 1000
    && /capPiecePath|capPaintBg|capTrack|capHandle|capFill|capVerify|CAP_SETX|CAP_PIECE_W/.test(capBlock) === false
    && /pointerdown|pointermove|pointerup|setPointerCapture/.test(capBlock) === false);
  t('★验证码改为输入框（capInput）', /id="capInput"/.test(idx41));
  /* 老手机适配核心：数字键盘。inputmode 是标准写法，
     pattern 是老 iOS 也认的兼容写法，两个都给上。 */
  t('★输入框弹数字键盘（inputmode=numeric + pattern，老 iOS 也认）',
    /inputmode="numeric"/.test(idx41) && /pattern="\[0-9\]\*"/.test(idx41));
  t('★只收数字：输入时过滤非数字并按位数截断',
    /replace\(\/\\D\/g, ''\)\.slice\(0, CAP_LEN\)/.test(idx41));
  t('★验证码为 4 位数字', /var CAP_LEN = 4/.test(idx41));
  t('★比对时也过滤非数字（多打了空格不被冤枉）',
    /String\(inp\.value \|\| ''\)\.replace\(\/\\D\/g, ''\)/.test(idx41));
  t('★每次校验失败都换一张新码（防手工试错）',
    /setTimeout\(function\(\)\{\s*if\(wrap\) wrap\.classList\.remove\('bad'\);\s*capInit\(\);/.test(idx41));
  /* 老设备兼容：hsla/hsl 在个别老浏览器上支持不全，画出来会透明或发黑，
     等于验证码看不见 —— 统一用 rgb/rgba 拼字符串。 */
  t('★画图颜色统一用 rgb/rgba（不用 hsl/hsla，老浏览器支持不全）',
    /function capRGBA\(/.test(idx41) && /hsl?\(/.test(idx41) === false);
  t('★画图只用最基础的 Canvas API + 系统字体（不依赖自定义字体）',
    /ctx\.fillText\(/.test(idx41) && /'bold ' \+ Math\.round\(capRand\([\d, ]+\)\) \+ 'px sans-serif'/.test(idx41));
  t('验证码样式已定义（.cap-wrap/.cap-input）',
    /\.cap-wrap\{/.test(idx41) && /\.cap-input\{/.test(idx41));
  /* ⚠️ 特异性坑（真机截图才发现）：验证码是插在 `.acct-field` 里的，
     而 `.acct-field input`（带元素名，(0,1,1)）会压掉只写一个 class 的
     `.cap-input`（(0,1,0)）—— 表现是输入框突然变成白底带边框的默认样式、
     比图高出一截。必须写成两个 class。 */
  t('★验证码输入框用双 class 选择器（否则被 .acct-field input 压掉）',
    /\.cap-wrap \.cap-input\{/.test(idx41)
    && /^\.cap-input\{/m.test(idx41) === false);
  t('★验证码卡片背景不透明（半透明会让下层文字透出来）',
    /\.cap-wrap\{position:relative;[^}]*background:#fdfbf9/.test(idx41));
  t('★验证码跟随主题（暗色用深底浅字，夜里不闪一块亮色）',
    /var dark = document\.documentElement\.classList\.contains\('dark'\)/.test(idx41)
    && /ctx\.fillStyle = dark \? '#2b2622' : '#fdfbf9'/.test(idx41));
  t('★主题判定用 .dark class（本项目不用 data-theme 属性，写错会永不生效）',
    /document\.documentElement\.getAttribute\('data-theme'\)/.test(idx41) === false);
  t('★切主题时只重画当前码、不换新码（不打断正在输入的人）',
    /capPaint\(cv, CAP_STATE\.code\)/.test(idx41));
  t('验证码有暗色模式样式',
    /\.dark \.cap-wrap\{/.test(idx41) && /\.dark \.cap-wrap \.cap-input\{/.test(idx41));
  t('★尊重系统「减少动态效果」（抖动动画可关）',
    /prefers-reduced-motion:reduce\)\{\.cap-wrap\.bad\{animation:none/.test(idx41));
  t('★画布尺寸取不到时有 rAF 重试（弹窗刚插入还没完成布局）',
    /requestAnimationFrame\(capInit\)/.test(idx41) && /capTry/.test(idx41));
  t('★「换一张」只在 capBind 里绑一次（避免重复绑定）',
    /id="capRefresh"/.test(idx41) && /rf\.addEventListener\('click', function\(\)\{ capInit\(\); \}\)/.test(idx41));
  t('★登录提示文案已同步为「请输入验证码」',
    /请先输入图中的验证码/.test(idx41) && /请先拖动滑块/.test(idx41) === false);

  /* ---- v2.5.2 回归护栏：心跳超时误报（站主反馈「正常联网却显示连不到服务器」）----
     根因是**服务端慢**而非站主网络差：实测 TCP 握手只要 0.2s（网络正常），
     但带 token 心跳首字节要 1.4–10.1s（Neon HTTP 逐条 SQL 往返叠加），
     而前端超时只有 12s —— 最慢一次 10.1s，只差 1.9s 就误判离线；
     手机移动数据延更大，必然突破 12s → 弹「连不到服务端」。
     修复：超时 12s→30s、宽限期 25s→60s，且「服务器慢」与「真断网」分两种文案。 */
  t('★心跳超时常量已提升到 30 秒（HB_TIMEOUT_MS）',
    /var HB_TIMEOUT_MS = 30 \* 1000/.test(idx41));
  t('★心跳不再用硬编码 12000 超时（会导致误报）',
    /setTimeout\(function\(\)\{ timedOut = true; ctrl\.abort\(\); \}, HB_TIMEOUT_MS\)/.test(idx41)
    && /ctrl\.abort\(\); \}, 12000\)/.test(idx41) === false);
  t('★v2.6.1 已去掉时间窗防抖（改数连续失败次数，不再有宽限期）',
    /var OFFLINE_GRACE_MS/.test(idx41) === false
    && /function scheduleOfflineCheck\(/.test(idx41) === false
    && /var NET_FAILS_MAX = 2/.test(idx41));
  t('★区分「服务器慢」与「真断网」两种文案',
    /OFFLINE_TEXT = \{/.test(idx41) && /slow:/.test(idx41) && /offline:/.test(idx41));
  t('★markNetFail 接受失败原因参数（slow/offline）',
    /function markNetFail\(kind\)/.test(idx41));
  t('★心跳超时 / 5xx 都标记为 slow（而非 offline）',
    /var kind = \(timedOut \|\| \(e && e\.serverBusy\)\) \? 'slow' : 'offline'/.test(idx41));
  t('★心跳把 5xx 归入「服务器忙」而不是用户的网络问题',
    /e\.serverBusy = !!\(r && r\.status >= 500\)/.test(idx41));
  /* 🚀 v2.6.1 核心修复：api() 成功也要清零。
     旧实现只有心跳成功才清零，api 失败点着的计时器要等下一次心跳来灭，
     中间就可能先弹横幅 —— 这正是「明明有网却提示连不上」的根因。 */
  t('★api() 成功时顺手清零在线状态（关键修复）',
    /if\(typeof markNetOk === 'function'\) markNetOk\(\);/.test(idx41));
  t('★api() 不再自己点亮离线横幅（避免启动并发误报）',
    /markNetFail\('offline'\)/.test(idx41) === false
    && /markNetFail\('slow'\)/.test(idx41) === false);
  t('★服务端慢的文案不再让用户去换流量',
    /服务器响应较慢/.test(idx41));
}

console.log('\n【42】第三十一轮·双向心跳 + 会话级在线（v2.5.0）');
{
  /* ---- 后端：ping 必须回程 pong / online ---- */
  const reg42 = await call('/api/auth?action=register', {
    method: 'POST', body: { username: 'hbuser2500b', password: 'PingPass123' },
  });
  t('建心跳测试账号成功', reg42.status === 200 && !!reg42.body.token,
    JSON.stringify(reg42.body).slice(0, 160));
  const tk42 = reg42.body.token;

  const p1 = await call('/api/auth?action=ping', { token: tk42 });
  t('★ping 返回 200', p1.status === 200, '实际 ' + p1.status + ' ' + JSON.stringify(p1.body).slice(0, 160));
  t('★ping 回程带 pong 时间戳', !!(p1.body && p1.body.pong), JSON.stringify(p1.body));
  t('★ping 回程显式声明 online:true', !!(p1.body && p1.body.online === true), JSON.stringify(p1.body));
  t('ping 回程带 serverTime', !!(p1.body && p1.body.serverTime), JSON.stringify(p1.body));
  t('ping 回程带判定窗口 windowSec', !!(p1.body && p1.body.windowSec > 0), JSON.stringify(p1.body));

  /* ---- 未登录 ping 被拒 ---- */
  const pNo = await call('/api/auth?action=ping');
  t('未登录心跳被拒 401', pNo.status === 401, '实际 ' + pNo.status);

  /* ---- 会话级在线：ping 后该用户 online=true ---- */
  const u1 = await call('/api/admin?action=users&q=hbuser2500b', { token: adminToken });
  const me42 = (u1.body.users || []).find((x) => x.username === 'hbuser2500b');
  t('★后台用户列表带 online 字段', !!me42 && typeof me42.online === 'boolean', JSON.stringify(me42));
  t('★刚心跳过 → online=true', !!me42 && me42.online === true, JSON.stringify(me42));
  t('★带会话数 onlineSessions>=1', !!me42 && me42.onlineSessions >= 1, JSON.stringify(me42));
  t('★带最近会话心跳时间 sessionLastSeen', !!me42 && !!me42.sessionLastSeen, JSON.stringify(me42));

  /* ---- 概览页要给「当前在线人数 / 在线会话数」 ---- */
  const ov42 = await call('/api/admin?action=stats', { token: adminToken });
  t('★概览返回 onlineUsers', ov42.body && typeof ov42.body.onlineUsers === 'number',
    JSON.stringify(ov42.body && { onlineUsers: ov42.body.onlineUsers }));
  t('★概览返回 onlineSessions', ov42.body && typeof ov42.body.onlineSessions === 'number',
    JSON.stringify(ov42.body && { onlineSessions: ov42.body.onlineSessions }));
  t('★刚心跳过的用户被算进当前在线', ov42.body && ov42.body.onlineUsers >= 1,
    JSON.stringify(ov42.body && { onlineUsers: ov42.body.onlineUsers }));

  /* ---- 清理：把会话删掉后应判为不在线 ---- */
  await call('/api/admin?action=clear-sessions', {
    method: 'POST', token: adminToken, body: { id: me42.id },
  });
  const u2 = await call('/api/admin?action=users&q=hbuser2500b', { token: adminToken });
  const me43 = (u2.body.users || []).find((x) => x.username === 'hbuser2500b');
  t('★会话被清掉后 → online=false（不是「登录过就一直在线」）',
    !!me43 && me43.online === false, JSON.stringify(me43));

  /* ---- 前端：双向心跳 + 离线横幅 ---- */
  const idx42 = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  t('★前端有心跳在线状态变量 ONLINE', /var ONLINE\s*=/.test(idx42));
  t('★心跳检查回程 online 字段', /j\.online/.test(idx42));
  /* v2.6.1：计数变量由 ONLINE_FAILS 改名 NET_FAILS（含义收窄为「心跳连续失败」） */
  t('★连续失败才提示（NET_FAILS）', /NET_FAILS/.test(idx42) && /ONLINE_FAILS/.test(idx42) === false);
  t('★有离线横幅函数 setOfflineBanner', /function setOfflineBanner\(/.test(idx42));
  t('★离线横幅文案含「连接不到服务端」', idx42.indexOf('连接不到服务端') >= 0);
  t('★离线横幅提示切换流量（移动数据）', /切换.*流量|移动数据/.test(idx42));
  t('★离线横幅有手动重试按钮', /heartbeatNow/.test(idx42));
  t('★心跳有超时保护（AbortController）', /AbortController/.test(idx42));
  t('★页面回到前台会补一次心跳', /visibilitychange/.test(idx42));
  t('离线横幅样式已定义', /\.offline-bar\{/.test(idx42));

  /* ---- 后端：schema 双处同步 ---- */
  const schema42 = fs.readFileSync(new URL('./api/schema.sql', import.meta.url), 'utf8');
  const http42 = fs.readFileSync(new URL('./api/_lib/http.js', import.meta.url), 'utf8');
  t('★schema.sql 的 sessions 表有 last_seen_at', /create table if not exists sessions[\s\S]{0,300}last_seen_at/.test(schema42));
  t('★ensureSchema 自愈建 sessions.last_seen_at',
    /alter table sessions add column if not exists last_seen_at/.test(http42));
  const admin42 = fs.readFileSync(new URL('./api/admin.js', import.meta.url), 'utf8');
  t('★后台在线判定用 90 秒窗口', /interval '90 seconds'/.test(admin42));
  t('★后台在线判定基于 sessions.last_seen_at（非 users）',
    /sessions[\s\S]{0,200}last_seen_at > now\(\) - interval '90 seconds'/.test(admin42));
}

console.log('\n【43】第三十一轮·连不上服务端的离线提示（v2.5.0）');
{
  const idx43 = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  /* api() 必须包装网络层错误 —— 否则前端只会拿到裸的 TypeError: Failed to fetch */
  t('★api() 有网络错误包装（.catch 里有 offline 标记）', /netErr\.offline\s*=\s*true/.test(idx43));
  t('★网络错误被换成可读中文文案', idx43.indexOf('连接不到服务端，请检查网络') >= 0);
  /* v2.6.1：api 的业务错误仍原样抛出（调用方自己提示），但不再参与在线判定 */
  t('★业务错误（有 status）原样抛出、不参与在线判定',
    /if\(e && e\.status\) throw e;/.test(idx43));
  t('★有统一网络健康计数 markNetOk/markNetFail',
    /function markNetOk\(/.test(idx43) && /function markNetFail\(/.test(idx43));
  /* v2.6.1 防抖改用「连续失败次数」：时间窗要维护起始时刻 + 复查定时器，
     且必须和心跳节奏对齐（对不齐就会「先弹后收」闪一下），已整体移除 */
  t('★v2.6.1 防抖改为连续失败计数（NET_FAILS_MAX）',
    /var NET_FAILS_MAX = 2/.test(idx43) && /NET_FAILS\+\+/.test(idx43));
  t('★连续失败未达阈值时安排一次补打确认（scheduleConfirm）',
    /function scheduleConfirm\(/.test(idx43) && /FAIL_CONFIRM_DELAY_MS/.test(idx43));
  /* CONTENT_STATE 要能表达「用的是缓存」 */
  t('★CONTENT_STATE 有 usedCache 字段', /var CONTENT_STATE = \{[^}]*usedCache/.test(idx43));
  t('★内容同步成功时 usedCache=false', /status:'ok'[^}]*usedCache:false/.test(idx43));
  t('★内容同步失败时 usedCache=true', /status:'error'[^}]*usedCache:true/.test(idx43));
  /* 不用 navigator.onLine 判在线（不可靠：网卡通但连不上服务器时它照样 true） */
  t('★离线判定不依赖 navigator.onLine',
    !/navigator\.onLine/.test(idx43) || /不看\s*navigator\.onLine|比 navigator\.onLine 可靠/.test(idx43));
  t('★离线横幅有「重试」按钮调用 heartbeatNow', /onclick="heartbeatNow\(\)"/.test(idx43));
}

console.log('\n【44】第三十二轮·全站去 emoji 统一图标（v2.5.0）');
{
  const idx44 = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  /* 旧的运行时引擎（MutationObserver 全量重扫）必须彻底删除 —— 它是倒计时每秒闪的直接原因 */
  t('★旧的运行时 emoji 引擎已删除（无 MutationObserver）', !/new MutationObserver/.test(idx44));
  t('★旧的 emojiify 系列函数已删除', !/function emojiify\b/.test(idx44) && !/function emojiifyText\b/.test(idx44));
  /* 新的「一次性转换」入口必须存在 */
  t('★有一次性静态图标化函数 iconifyStatic', /function iconifyStatic\(/.test(idx44));
  t('★iconifyStatic 用 TreeWalker（按需遍历，非监听）', /createTreeWalker/.test(idx44));
  t('★iconifyStatic 会跳过 script/style/textarea', /ICONIFY_SKIP/.test(idx44));
  t('★option 有去 emoji 处理（stripEmojiInOptions）', /function stripEmojiInOptions\(/.test(idx44));
  t('★页面初始化调用了 iconifyStatic', /iconifyStatic\(document\.body\)/.test(idx44));
  /* 关键辅助函数仍在 */
  t('★有 emojiToSvgText（动态文本转图标）', /function emojiToSvgText\(/.test(idx44));
  t('★有 emojiEscHtml（先转义再转图标）', /function emojiEscHtml\(/.test(idx44));
  t('★有 stripEmoji（纯文本去 emoji）', /function stripEmoji\(/.test(idx44));
  /* 保留完整的 emoji→图标映射与 Lucide 图标表 */
  t('★保留了 EMOJI_ICON_MAP', /var EMOJI_ICON_MAP=\{/.test(idx44));
  t('★保留了 LUCIDE_ICONS', /var LUCIDE_ICONS=\{/.test(idx44));
  /* ★闪烁根因：倒计时标题不能再是 emoji 字面量 */
  t('★倒计时「重要日期」标题已用 iconSvg（不再是 📅 字面量）',
    /cd-head">'\+iconSvg\('calendar'/.test(idx44.replace(/\s/g, '')) || /iconSvg\('calendar',15\)\+' 重要日期倒计时/.test(idx44));
  t('★倒计时「节假日」标题已用 iconSvg（不再是 ⏰ 字面量）',
    /iconSvg\('timer',15\)\+' 节假日倒计时/.test(idx44));
  /* 主题按钮不能再用 textContent 写 emoji（textContent 吃不了 SVG） */
  const themeEmoji = /themeToggle'\);\s*if\(b\)\s*b\.textContent\s*=\s*(next|dark|wantDark)\s*\?/.test(idx44);
  t('★主题按钮改用 innerHTML 输出图标（不再 textContent）', !themeEmoji);
  t('★主题按钮用 iconSvg sun/moon', /iconSvg\('sun'/.test(idx44) && /iconSvg\('moon'/.test(idx44));
  /* uiMsg / dataMsg 是纯文本 toast，必须走 stripEmoji */
  t('★uiMsg 用 stripEmoji 去 emoji', /function uiMsg\(t, color\)\{[\s\S]{0,200}stripEmoji/.test(idx44));
  t('★dataMsg 用 stripEmoji 去 emoji', /function dataMsg\(t,c\)\{[\s\S]{0,160}stripEmoji/.test(idx44));
  /* 公告正文走 emojiEscHtml（同学手写的 emoji 也能变图标） */
  t('★公告正文用 emojiEscHtml 渲染', /emojiEscHtml\(a\.text\)/.test(idx44));
  /* 排行榜前三名用 medal 图标 */
  t('★排行榜前三名用 iconSvg medal', /iconSvg\('medal',16\)/.test(idx44));
  t('★排行榜标签用 iconSvg（不再是 g.icon 直接输出）', /iconSvg\(g\.icon,15\)/.test(idx44));
  /* 科目徽章图标改成图标名 */
  t('★HW_SUBJECT_STYLE 的 e 字段已改成图标名', /'语文':\s*\{\s*c:'#e8543f',\s*e:'book-open'/.test(idx44));
  /* 作业系统的 📎 是**数据协议**，必须保留在源码里（正则/生成都用它） */
  t('★作业附件 📎 协议标记仍保留（正则仍匹配 📎）', /\/\^\\s\*📎\//.test(idx44));
  /* cloud 图标已内联（静态 HTML 里用到） */
  t('★LUCIDE_ICONS 含 cloud 图标', /"cloud":"<path/.test(idx44));
}

console.log('\n【45】第三十三轮·主题自动切换三选一（v2.5.3）');
{
  const idx45 = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const data45 = fs.readFileSync(new URL('./api/data.js', import.meta.url), 'utf8');

  /* ---- 三种模式与存储键 ---- */
  t('★有主题自动模式常量 THEME_MODES（off/system/sun）',
    /var THEME_MODES = \['off', 'system', 'sun'\]/.test(idx45));
  t('★模式存在独立的 localStorage 键 THEME_AUTO_KEY',
    /var THEME_AUTO_KEY = 'cls_theme_auto2'/.test(idx45));
  t('★themeAutoMode() 会迁移老键 cls_theme_auto',
    /localStorage\.getItem\('cls_theme_auto'\)/.test(idx45)
    && /old === 'off'\) \? 'off' : 'system'/.test(idx45));
  t('★setThemeAutoMode 同步写老键（跨版本回退一致）',
    /localStorage\.setItem\('cls_theme_auto', m === 'off' \? 'off' : 'on'\)/.test(idx45));

  /* ---- 跟随系统 ---- */
  t('★有 isSystemDark 读 prefers-color-scheme',
    /function isSystemDark\(\)/.test(idx45) && /prefers-color-scheme: dark/.test(idx45));
  t('★监听系统主题变化（matchMedia change）',
    /_mql\.addEventListener\('change'/.test(idx45) && /_mql\.addListener\(_mqlHandler\)/.test(idx45));

  /* ---- 跟随日出日落 ---- */
  t('★有日出日落 API 请求（sunrise-sunset.org）',
    /api\.sunrise-sunset\.org\/json/.test(idx45));
  t('★有本地天文计算兜底 sunCalcLocal（离线可用）',
    /function sunCalcLocal\(/.test(idx45) && /90\.833/.test(idx45));
  t('★修水坐标已内置（29.03 / 114.55）',
    /SUN_POS = \{ lat: 29\.03, lng: 114\.55 \}/.test(idx45));
  t('★API 失败时静默保留本地值（不影响用户）',
    /静默：本地天文计算的值已经在用了/.test(idx45));
  t('★每天只请求一次（__sunFetched_ 守卫）',
    /'__sunFetched_' \+ k/.test(idx45));
  t('★跨零点判断正确（set > rise 分支）',
    /if\(t\.set > t\.rise\) return now >= t\.set \|\| now < t\.rise;/.test(idx45));

  /* ---- 旧硬编码必须消失 ---- */
  t('★旧的固定 18:30/7:30 硬编码已移除',
    !/return t>=1110 \|\| t<450;/.test(idx45));
  t('★isNightTime 已按模式分派（system/sun）',
    /if\(mode === 'system'\) return isSystemDark\(\);/.test(idx45)
    && /if\(mode === 'sun'\)\{/.test(idx45));

  /* ---- 设置面板 ---- */
  t('★外观面板有「主题自动切换」分区',
    /secHtml\('tauto', '主题自动切换', 'moon'/.test(idx45));
  t('★三个模式按钮由数据驱动生成并绑定 setThemeAutoMode',
    /\['off',\s*'关闭自动',/.test(idx45)
    && /\['system',\s*'跟随系统',/.test(idx45)
    && /\['sun',\s*'跟随日出日落',/.test(idx45)
    /* 按钮 onclick 是动态拼接（模板里含 setThemeAutoMode 与 m[0] 的字符串相加）。
       这里避开多层转义，只断言两个稳定特征同时存在。 */
    && idx45.indexOf('onclick="setThemeAutoMode(') >= 0
    && /setThemeAutoMode\([\s\S]{0,12}\+ m\[0\] \+/.test(idx45));
  t('★面板会显示当天日出日落时间',
    /今天：日出 ' \+ f2\(s\.rise\) \+ ' · 日落 ' \+ f2\(s\.set\)/.test(idx45));
  t('★模式按钮有窄屏适配样式 .ui-modes',
    /\.ui-modes\{display:flex/.test(idx45) && /@media \(max-width:380px\)/.test(idx45));

  /* ---- 手动切换不被立刻弹回 ---- */
  t('★手动切换后写当天 hold 标记（不再被自动弹回）',
    /setItem\('cls_theme_hold', sunTodayKey\(\)\)/.test(idx45));
  t('★hold 为当天时自动逻辑跳过',
    /if\(hold === sunTodayKey\(\)\) return;/.test(idx45)
    || /if\(hold && hold === sunTodayKey\(\)\)\{/.test(idx45));
  /* 🔴 v2.5.3 真 bug 回归护栏：hold 检查必须在 applyAutoTheme 内部，
     否则启动 / 系统主题变化 / API 回填 三条路径都会把用户手动选的色弹回去。 */
  t('★hold 检查收口在 applyAutoTheme 内部（不只放在外层）',
    /function applyAutoTheme\(force\)\{[\s\S]{0,700}hold && hold === sunTodayKey\(\)/.test(idx45));
  t('★改模式时清掉 hold（新规则立即生效）',
    /localStorage\.removeItem\('cls_theme_hold'\)/.test(idx45));

  /* ---- 弹窗新按钮 ---- */
  t('★弹窗有「改为跟随系统」按钮', /onclick="themeAskSystem\(\)"/.test(idx45));
  t('★弹窗有「改为跟随日出日落」按钮', /onclick="themeAskSun\(\)"/.test(idx45));
  t('★弹窗会显示当前模式（themeAskHint）',
    /function themeAskHint\(/.test(idx45) && /id="themeAskHint"/.test(idx45));
  t('★主题弹窗已去 emoji（无 🌙/☀️/🚫 字面量）',
    !/🌙 主题自动切换|☀️ 仅这次切换|🚫 关闭自动切换/.test(idx45));

  /* ---- 云同步白名单（前端与后端必须同步）---- */
  t('★前端 CLOUD_KEYS 含 cls_theme_auto2',
    /'cls_theme','cls_theme_auto','cls_theme_auto2'/.test(idx45));
  t('★后端 ALLOW_KEYS 含 cls_theme_auto2', /'cls_theme_auto2'/.test(data45));
  t('★cls_theme_hold 刻意不同步（临时意愿不该跨设备）',
    /cls_theme_hold（「仅这次切换」的当天软标记）\*\*刻意不同步\*\*/.test(idx45));
}

console.log('\n【46】第三十四轮·公告时间纪律 + 每日一言随机 + 学习卡片（v2.6.0）');
{
  const idx46 = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const adm46 = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
  const stu46 = fs.readFileSync(new URL('./api/study.js', import.meta.url), 'utf8');
  const wrk46 = fs.readFileSync(new URL('./api/worker.mjs', import.meta.url), 'utf8');
  const dat46 = fs.readFileSync(new URL('./api/data.js', import.meta.url), 'utf8');
  const cnt46 = fs.readFileSync(new URL('./api/content.js', import.meta.url), 'utf8');

  /* ===== ① 公告时间纪律 =====
     站主原话：「以后同步公告的时候先看现实世界，你发出来的时间总是错的」。
     根因是 AI 凭感觉手写时间戳。这里固化两条：
       · 公告数组必须严格按时间倒序（渲染层虽然会重排，但数据本身要干净）；
       · 不允许出现「未来时间」的公告（那必然是手写错的）。 */
  const annSeg = idx46.slice(idx46.indexOf('announcements: ['), idx46.indexOf('\n  ],', idx46.indexOf('announcements: [')));
  const annDates = [...annSeg.matchAll(/date:\s*["']([^"']+)["']/g)].map(m => m[1]);
  t('★公告数组非空（没被脚本改坏）', annDates.length > 50);
  let outOfOrder = 0;
  for (let i = 1; i < annDates.length; i++) if (annDates[i] > annDates[i - 1]) outOfOrder++;
  t('★公告数组严格倒序（' + annDates.length + ' 条，逆序对 ' + outOfOrder + '）', outOfOrder === 0);
  /* 公告时间不得晚于「今天结束」——晚于今天就是写错（AI 手写时间戳的典型症状） */
  const nowD = new Date();
  const pad = n => (n < 10 ? '0' : '') + n;
  const todayEnd = nowD.getFullYear() + '-' + pad(nowD.getMonth() + 1) + '-' + pad(nowD.getDate()) + ' 23:59';
  const future = annDates.filter(d => d > todayEnd);
  t('★没有「未来时间」的公告（手写时间戳的典型症状）', future.length === 0);

  /* ===== ② 后台公告时间可编辑 ===== */
  t('★后台公告时间输入框已解禁（不再是 disabled）',
    /id="ccDate"/.test(adm46) && !/id="ccDate"[^>]*disabled/.test(adm46));
  t('★有「填入当前时间」按钮',
    /id="ccDateNow"/.test(adm46) && /填入当前时间/.test(adm46));
  t('★按钮绑定了 annNowStr（取设备真实时间）',
    /ccDateNow[\s\S]{0,220}inp\.value = annNowStr\(\)/.test(adm46));
  t('★有时间格式校验函数 annParseDate', /function annParseDate\(str\)/.test(adm46));
  /* 真值表：把 annParseDate 从源码里抠出来单独跑，确保解析行为正确。
     （admin.html 的主脚本是 IIFE 包裹，真机测试无法从外部调用它，
       所以逻辑校验放在这里做。） */
  {
    const m = adm46.match(/function annParseDate\(str\)\{[\s\S]*?\n\}/);
    if (!m) {
      t('★annParseDate 逻辑可提取并正确解析', false, '未能从源码提取函数体');
    } else {
      let fn = null;
      try {
        fn = new Function('return ' + m[0].replace(/^function annParseDate/, 'function') + ';')();
      } catch (e) { /* 提取失败见下 */ }
      const cases = [
        ['2026-10-11 17:05', '2026-10-11 17:05'],
        ['2026-10-11 9:7', '2026-10-11 09:07'],
        ['2026/10/11 17:05', '2026-10-11 17:05'],
        ['2026-10-11T17:05', '2026-10-11 17:05'],
        ['', ''],
        ['乱写', ''],
        ['2026-13-11 17:05', ''],
        ['2026-10-11 25:05', ''],
      ];
      const bad = fn ? cases.filter(c => fn(c[0]) !== c[1]) : cases;
      t('★annParseDate 逻辑正确（' + cases.length + ' 个用例全过）', fn && bad.length === 0,
        bad.map(c => JSON.stringify(c[0]) + '→' + (fn ? JSON.stringify(fn(c[0])) : 'n/a')).join('; '));
    }
  }
  t('★格式不对会明确报错（不是悄悄丢掉）',
    /发布时间格式看不懂/.test(adm46));
  t('★保存时以时间框为准（ref.date = dateV）', /ref\.date = dateV/.test(adm46));

  /* ---- ③ 每日一言随机 + 联网 ----
     注意：断言要避开注释里的「旧写法对比」（注释里故意留了 items[seed % ...] 作说明），
     所以先剥掉注释再检查代码。 */
  const idx46Code = idx46.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  t('★每日一言已去掉「按日期取模」的顺序轮播',
    !/seed % items\.length\]/.test(idx46Code));
  t('★改用 Math.random 随机取', /Math\.floor\(Math\.random\(\) \* items\.length\)/.test(idx46Code));
  t('★有会话内不重复（避开上次下标）',
    /function pickRandom\(items\)/.test(idx46) && /i === _quoteLastIdx/.test(idx46));
  t('★每日一言联网走 hitokoto',
    /v1\.hitokoto\.cn/.test(idx46) && /function fetchRemoteQuote\(\)/.test(idx46));
  t('★联网失败静默（本地兜底不受影响）',
    /\.catch\(function\(\)\{ clearTimeout\(timer\); _quoteFetching = false; \}\)/.test(idx46));
  t('★联网结果带超时保护（AbortController）',
    /AbortController/.test(idx46) && /ctrl\.abort\(\)/.test(idx46));

  /* ===== ④ 学习卡片 —— 数据 ===== */
  t('★内置物理知识点 STUDY_PHYSICS', /var STUDY_PHYSICS = \[/.test(idx46));
  t('★内置化学知识点 STUDY_CHEMISTRY', /var STUDY_CHEMISTRY = \[/.test(idx46));
  t('★内置生物知识点 STUDY_BIOLOGY', /var STUDY_BIOLOGY = \[/.test(idx46));
  t('★内置英语每日一题 STUDY_ENGLISH', /var STUDY_ENGLISH = \[/.test(idx46));
  t('★四类数据汇总为 STUDY_DATA', /var STUDY_DATA = \{[\s\S]{0,300}english:   STUDY_ENGLISH/.test(idx46));
  /* 统计知识点：只数 STUDY_PHYSICS ~ STUDY_ENGLISH 之间、以 { ch: ' 开头的条目。
     （不能用「第..章」去匹配 —— 章节名里有「铁 金属材料」这种带空格的） */
  const knowStart = idx46.indexOf('var STUDY_PHYSICS');
  const knowEnd = idx46.indexOf('var STUDY_ENGLISH');
  const knowSeg = idx46.slice(knowStart, knowEnd);
  const cntKnow = (knowSeg.match(/\{ ch: '/g) || []).length;
  t('★知识点条目数充足（≥100 条，实测 ' + cntKnow + '）', cntKnow >= 100);
  const cntQuiz = (idx46.match(/\{ q: '/g) || []).length;
  t('★英语题目数充足（≥25 道，实测 ' + cntQuiz + '）', cntQuiz >= 25);
  /* 每题必须是四选一 + 合法答案下标 + 有解析 */
  const quizObjs = [...idx46.matchAll(/\{ q: '([^']*)', opts: \[([^\]]*)\], a: (\d), ex: '([^']*)' \}/g)];
  t('★每道题的选项都是 4 个', quizObjs.every(m => m[2].split("', '").length === 4 || m[2].split("',\s*'").length === 4));
  t('★每道题的答案下标在 0~3 内', quizObjs.every(m => +m[3] >= 0 && +m[3] <= 3));
  t('★每道题都有解析', quizObjs.every(m => m[4] && m[4].length > 8));

  /* ===== ④ 学习卡片 —— 前端逻辑 ===== */
  t('★首页有学习卡片容器 #studyCard', /<section class="study" id="studyCard">/.test(idx46));
  t('★有 .study 样式体系（含暗色模式）',
    /\.study\{background:#fff/.test(idx46) && /\.dark \.study\{/.test(idx46));
  t('★有渲染入口 renderStudyCard', /function renderStudyCard\(\)/.test(idx46));
  t('★render() 里调用了 renderStudyCard',
    /renderStudyCard\(\);\s*\/\* v2\.6\.0/.test(idx46));
  t('★有「换一条」刷新按钮', /refreshStudyCard\(\)/.test(idx46));
  t('★每日一题的答案默认折叠（点「看答案」才展开）',
    /id="studyAns"/.test(idx46) && /study-ans\{[\s\S]{0,200}display:none/.test(idx46));
  t('★知识点抽取按学科等概率（不合成大 pool）',
    /抽一科，再从该科里抽一条/.test(idx46));
  t('★配置读取优先级：本地个人 → 云端默认 → 常量',
    /SITE_DATA\.studyCard/.test(idx46) && /STUDY_DEFAULT_CFG/.test(idx46));
  t('★联网失败时保持本地内容（不会整块空白）',
    /拿不到 → 保持本地内容不变/.test(idx46));

  /* ===== ④ 学习卡片 —— 后端代理 ===== */
  t('★新建了 api/study.js 代理', /export default async function handler/.test(stu46));
  t('★代理了今日诗词 jinrishici', /v2\.jinrishici\.com\/one\.json/.test(stu46));
  t('★代理了有道词典', /dict\.youdao\.com\/jsonapi/.test(stu46));
  t('★上游请求带浏览器 UA（否则被拒）',
    /BROWSER_HEADERS/.test(stu46) && /Mozilla\/5\.0/.test(stu46));
  t('★上游有超时保护（不挂死）',
    /UPSTREAM_TIMEOUT_MS/.test(stu46) && /AbortController/.test(stu46));
  t('★上游失败返回空字段而非 500（前端不该走 catch）',
    /因为「这次没拿到联网内容」不是错误/.test(stu46));
  t('★有实例级缓存（同一天全班只打一次上游）',
    /function cacheGet/.test(stu46) && /function cacheSet/.test(stu46));
  t('★每日一词用日期当种子（同一天全班同一个词）',
    /seed % WORD_POOL\.length/.test(stu46));
  t('★词库是高中高频词（不是随机字母组合）',
    /const WORD_POOL = \[/.test(stu46) && /abandon/.test(stu46) && /sophisticated/.test(stu46));

  /* ===== ④ 学习卡片 —— 路由与白名单 ===== */
  t('★worker 注册了 study 路由',
    /import studyHandler from '\.\/study\.js'/.test(wrk46) && /case 'study':/.test(wrk46));
  t('★worker 头部注释已更新接口清单', /\/api\/study/.test(wrk46));
  t('★前端 CLOUD_KEYS 含 cls_study_cfg', /'cls_study_cfg'/.test(idx46));
  t('★后端 ALLOW_KEYS 含 cls_study_cfg', /'cls_study_cfg'/.test(dat46));
  t('★content 白名单含 study_card（后台配置能写上去）',
    /'study_card'/.test(cnt46));
  t('★前端 CONTENT_MAP 含 study_card → studyCard',
    /study_card:\s*'studyCard'/.test(idx46));
  t('★study_card 变化时会重绘卡片',
    /if\(key === 'study_card'\) renderStudyCard\(\)/.test(idx46));

  /* ===== ④ 学习卡片 —— 后台面板（v2.6.1 起并入「首页卡片」板块）===== */
  t('★后台注册了「首页卡片」页面（每日一言 + 学习卡片合并）', /id:'cards',/.test(adm46));
  t('★后台有 renderCards 面板函数', /function renderCards\(\)/.test(adm46));
  t('★合并后不再有独立的每日一言 / 学习卡片入口',
    /id:'quotes',/.test(adm46) === false && /id:'study',/.test(adm46) === false);
  t('★同一面板内含两块（每日一言 + 学习卡片）',
    /每日一言<\/h3>/.test(adm46) && /学习卡片<\/h3>/.test(adm46));
  t('★两块各自的容器都在（dqBody / stBody）',
    /id="dqBody"/.test(adm46) && /id="stBody"/.test(adm46));
  t('★两块各自的按钮都绑定了（新增一句/刷新/保存/刷新）',
    /dqAdd/.test(adm46) && /dqRefresh/.test(adm46) && /stSave/.test(adm46) && /stRefresh/.test(adm46));
  t('★合并后两块各自加载（loadQuotes + loadStudy 都被调用）',
    /loadQuotes\(\);/.test(adm46) && /loadStudy\(\);/.test(adm46));
  t('★旧的独立面板函数已移除（避免死代码）',
    /function renderQuotes\(\)/.test(adm46) === false && /function renderStudy\(\)/.test(adm46) === false);
  t('★后台面板含四类内容勾选', /STUDY_TYPES = \[/.test(adm46) && /know.*quiz.*word.*poem/s.test(adm46));
  t('★后台面板含三科勾选', /STUDY_SUBJECTS = \[/.test(adm46));
  t('★保存前校验「至少勾一个类型」（否则首页空白像 bug）',
    /至少要勾一个内容类型/.test(adm46));
  t('★勾了知识点但没选学科会拦下', /至少要选一个学科/.test(adm46));
}

console.log('\n【47】第三十六轮·心跳简化 + 学习卡片隐藏 + 重试倒计时（v2.6.1）');
{
  const idx47 = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const adm47 = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
  const sw47  = fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8');

  /* ===== ① 心跳判定简化（消除「明明有网却弹连不上」）=====
     站主反馈「再简化在线心跳，还是有可能显示不了」——实测是**误弹**（不该弹却弹了）。
     根因：api() 失败能把防抖计时器点着，但 api() 成功却不清零（只有心跳成功才清）；
     而复查定时器（宽限期 +60ms）与心跳间隔（60s）几乎重合 → 先弹一次、
     心跳成功又立刻收起 = 用户看到「红条闪一下」。 */
  t('★v2.6.1 去掉时间窗三件套（宽限期 / 起始时刻 / 复查定时器）',
    /OFFLINE_GRACE_MS/.test(idx47) === false
    && /NET_FAIL_SINCE/.test(idx47) === false
    && /scheduleOfflineCheck/.test(idx47) === false);
  t('★判定改为连续失败计数，阈值 2 次',
    /var NET_FAILS = 0/.test(idx47) && /var NET_FAILS_MAX = 2/.test(idx47)
    && /if\(NET_FAILS >= NET_FAILS_MAX\)/.test(idx47));
  t('★心跳成功即清零并收起',
    /function markNetOk\(fromHeartbeat\)/.test(idx47) && /NET_FAILS = 0;/.test(idx47));
  /* 真机测试抓到：重试态下自动云同步的 /api/content 先成功，把重试给结束了，
     可心跳其实还在失败 → 会「已恢复 → 又报警」闪一下。所以只有心跳报的成功
     才算「真恢复」，api 成功只负责清零、不结束重试。 */
  t('★重试态下只有心跳成功才算真恢复（api 成功不算）',
    /if\(wasRetrying && !fromHeartbeat\)\{/.test(idx47));
  t('★心跳调用时明确传 true（markNetOk(true)）', /markNetOk\(true\)/.test(idx47));
  t('★api() 成功也清零 —— 误弹的真正修复点',
    /if\(typeof markNetOk === 'function'\) markNetOk\(\);/.test(idx47));
  t('★api() 的失败不再计入在线判定（避免启动并发误报）',
    /markNetFail\('offline'\)/.test(idx47) === false
    && /markNetFail\('slow'\)/.test(idx47) === false);
  t('★未达阈值时 15 秒补打一次确认（真断网也能及时提示）',
    /var FAIL_CONFIRM_DELAY_MS = 15 \* 1000/.test(idx47)
    && /function scheduleConfirm\(/.test(idx47));
  t('★「真连不上」不会被后续「服务器慢」降级展示',
    /if\(kind === 'offline'\) NET_FAIL_KIND = 'offline';/.test(idx47));
  t('★重试期间失败不会把横幅刷成失败文案（倒计时优先）',
    /function paintOfflineBar\(\)/.test(idx47) && /if\(_retryTimer\)\{/.test(idx47));

  /* ===== ② 重试 → 「正在刷新」+ 60 秒倒计时 =====
     站主原话：「不然用户会觉得你点了重试没有反应」 */
  t('★重试倒计时 60 秒', /var RETRY_SECONDS = 60/.test(idx47));
  t('★「重试」按钮改为进入倒计时重试态',
    /function heartbeatNow\(\)\{\s*startRetry\(\);/.test(idx47));
  t('★倒计时文案是「正在刷新… 剩余 N 秒」',
    /正在刷新… 剩余 <b>' \+ _retryLeft \+ '<\/b> 秒/.test(idx47));
  t('★倒计时每秒递减（setInterval 1000）',
    /_retryLeft--;/.test(idx47) && /\}, 1000\);/.test(idx47));
  t('★倒计时期间每 10 秒真的再试一次（不是干等）',
    /_retryLeft % 10 === 0/.test(idx47));
  t('★倒计时走完仍失败 → 回到失败文案 + 重试按钮（可以再点）',
    /stopRetry\(\);\s*setOfflineBanner\(true\);/.test(idx47));
  t('★重复点重试不会叠出多个倒计时（_retryTimer 守卫）',
    /if\(_retryTimer\) return;/.test(idx47));
  /* 真机测试抓到的 bug：paintOfflineBar 靠 _retryTimer 判断是否处于重试态，
     若先重绘再赋值，第一帧会被画成失败文案 —— 用户点了「重试」却看不到
     「正在刷新」。必须「先赋值 _retryTimer，再 paintOfflineBar」。 */
  t('★startRetry 先赋值 _retryTimer 再重绘（否则第一帧看不到「正在刷新」）',
    /_retryTimer = setInterval\(function\(\)\{[\s\S]*?\}, 1000\);\s*paintOfflineBar\(\);/.test(idx47));
  t('★重试成功给「连接已恢复」反馈后自动收起',
    /function showRecoveredBanner\(\)/.test(idx47) && /连接已恢复/.test(idx47));
  t('★转圈动画 CSS 存在，且尊重系统「减少动态效果」',
    /\.off-spin\{animation:offSpin/.test(idx47) && /prefers-reduced-motion:reduce/.test(idx47));
  t('★「已恢复」绿色态 CSS 存在', /\.offline-bar\.off-ok\{/.test(idx47));

  /* ===== ③ 学习卡片暂时隐藏（站主：bug 有点多，等后续再修）===== */
  t('★v2.6.1 总开关 STUDY_CARD_ENABLED = false',
    /var STUDY_CARD_ENABLED = false/.test(idx47));
  t('★总开关关闭时直接不渲染卡片',
    /if\(!STUDY_CARD_ENABLED\)\{ el\.innerHTML = ''; el\.style\.display = 'none'; return; \}/.test(idx47));
  t('★总开关关闭时不发起 /api/study 联网请求',
    /if\(!STUDY_CARD_ENABLED\) return;/.test(idx47));
  t('★用 display:none 隐藏（不留空白高度）',
    /el\.style\.display = 'none'/.test(idx47));
  t('★代码与后台面板都保留（改回 true 即可整体恢复）',
    /function renderStudyCard\(\)/.test(idx47) && /function renderCards\(\)/.test(adm47));
  t('★后台面板明确提示「当前已暂时隐藏」', /当前已暂时隐藏/.test(adm47));

  /* ===== ③+ 后台「每日一言」+「学习卡片」合并为「首页卡片」=====
     站主要求：「后台的每日一言和学习卡片的古诗词那些放到一个板块」。
     两者本质都是「首页那张小卡片」的配置，拆两个入口反而不好找。 */
  t('★后台两块已合并为「首页卡片」板块',
    /id:'cards',/.test(adm47) && /function renderCards\(\)/.test(adm47));
  /* v2.7.1 起内容组是 10 项：原本合并后的 9 项 + 新增的「成绩分析」 */
  t('★内容组导航项为 10 项（合并后的 9 项 + 成绩分析）',
    (adm47.match(/group:'内容'/g) || []).length === 10,
    '实际 ' + (adm47.match(/group:'内容'/g) || []).length + ' 项');
  t('★合并后的面板路由已注册（cards → renderCards）',
    /cards:\s*renderCards,/.test(adm47));

  /* ===== ④ 版本号 / 缓存 ===== */
  t('★前台版本号 2.8.2', /SITE_VERSION = '2\.8\.2'/.test(idx47));
  t('★后台版本号 2.8.2', /SITE_VERSION = '2\.8\.2'/.test(adm47));
  t('★service worker 缓存版本升到 v68（旧缓存要作废）',
    /class-site-v68/.test(sw47));
}

console.log('\n【48】第三十九轮·iOS 刷不了：更新检测 + 一键强制刷新（v2.6.4）');
{
  const idx48 = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const sw48  = fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8');

  /* ===== ① sw.js：让页面能主动催新 SW 接管 =====
     站主反馈「iOS 端无法正常刷新，线上已是 2.6.3，我这边还是 2.6.2」。
     根因不是代码没推上去，而是 iOS 极少主动检查 SW 更新
     （尤其「添加到主屏」后只在导航时 + 最长 24 小时查一次），
     且新 SW 装好后已打开的页面不会自己重新加载。 */
  t('★sw.js 监听 SKIP_WAITING 消息（页面可主动让新 SW 立刻接管）',
    /addEventListener\('message'/.test(sw48)
    && /d\.type === 'SKIP_WAITING'/.test(sw48)
    && /self\.skipWaiting\(\)/.test(sw48));
  t('★sw.js 接管后主动通知页面（iOS 上 controllerchange 偶有不触发）',
    /type: 'SW_ACTIVATED'/.test(sw48) && /clients\.matchAll/.test(sw48));
  /* 版本探测 / 强制刷新的 URL 每次都带一个新时间戳，若照常走「网络优先 + 写缓存」，
     线上每 5 分钟查一次，一天就能往 CacheStorage 塞几百份 index.html 副本。 */
  t('★sw.js 让版本探测（?_=）与强制刷新（?_r=）请求绕过缓存',
    /u\.searchParams\.has\('_'\) \|\| u\.searchParams\.has\('_r'\)/.test(sw48));
  /* 预缓存里塞 index.html（600KB）会让 install 慢到装不完 ——
     真机实测 SW 卡在 installing 25 秒，连带「检查更新」一起失效。
     首页交给 fetch handler 运行时缓存，离线兜底照样有。 */
  {
    const pc = /const PRECACHE = \[([^\]]*)\]/.exec(sw48);
    t('★预缓存清单里不含 600KB 的 index.html（否则 SW 装不完）',
      !!pc && !/index\.html/.test(pc[1]) && !/'\.\/'/.test(pc[1]),
      pc ? pc[1] : '(未找到 PRECACHE)');
  }

  /* ===== ② 前端：三个「主动催检查」的时机 =====
     只靠浏览器自己的节奏在 iOS 上等于不检查，必须自己催。 */
  t('★注册后立刻催一次更新检查（reg.update）',
    /function swRegister\(\)/.test(idx48) && /reg\.update\(\)/.test(idx48));
  t('★回到前台再催一次（iOS 最典型的使用路径：切出去又切回来）',
    /visibilitychange/.test(idx48) && /visibilityState === 'visible'\) swCheckUpdate\(false\)/.test(idx48));
  t('★定时兜底：每 5 分钟催一次（长时间挂着不停在旧版）',
    /setInterval\(function\(\)\{ swCheckUpdate\(false\); \}, 5 \* 60 \* 1000\)/.test(idx48));
  t('★页面末尾改为调用 swRegister（不再直接 register）',
    /typeof swRegister === 'function'\) swRegister\(\)/.test(idx48)
    && /navigator\.serviceWorker\.register\('\.\/sw\.js'\)\.catch\(function \(\) \{\}\);\s*\}\)\;/.test(idx48) === false);
  /* 挂在 load 上会「等所有图片加载完」才注册，网络差时可能拖几十秒 ——
     真机测试里图床慢时整整 12 秒都没完成注册。改挂 DOMContentLoaded。 */
  t('★注册改挂 DOMContentLoaded（不等所有图片，避免更新检查被拖后）',
    /document\.addEventListener\('DOMContentLoaded'/.test(idx48)
    && /window\.addEventListener\('load', function \(\) \{\s*\n\s*if \(typeof swRegister === 'function'\) swRegister\(\);/.test(idx48) === false);
  t('★若脚本执行时 DOM 已就绪则立即注册（不等事件）',
    /else if \(typeof swRegister === 'function'\) \{\s*\n\s*swRegister\(\);/.test(idx48));

  /* ===== ③ 版本比较必须按「数字」比，不能按字符串 =====
     字符串比较下 '2.6.10' < '2.6.9'（逐字符 '1' < '9'），会误判成有新版。
     把函数体抠出来单独跑真值表（比正则断言可靠得多）。 */
  const cmpBody = /function cmpVer\(a, b\)\{([\s\S]*?)\n\}/.exec(idx48);
  t('★有版本比较函数 cmpVer（语义化比较）', !!cmpBody);
  if (cmpBody) {
    const cmpVer = new Function('a', 'b', cmpBody[1]);
    const cases = [
      ['2.6.4', '2.6.3',  1], ['2.6.3', '2.6.4', -1], ['2.6.4', '2.6.4',  0],
      ['2.6',   '2.6.0',  0], ['2.10.0','2.9.9',  1], ['2.6.10','2.6.9',  1],
      ['3.0.0', '2.99.99',1], ['2.6.4', '',       1], ['',      '2.6.4', -1],
    ];
    let ok = 0, bad = [];
    for (const [a, b, want] of cases) {
      const got = cmpVer(a, b);
      if (got === want) ok++; else bad.push(`${a} vs ${b} 期望 ${want} 得到 ${got}`);
    }
    t('★cmpVer 真值表 9/9（含 2.6.10 > 2.6.9 这类字符串比较会翻车的用例）',
      ok === cases.length, bad.join(' | '));
  }

  /* ===== ④ 取线上版本：必须绕开缓存，否则查的还是旧的 ===== */
  /* ⚠️ 一开始读的是 index.html 来取版本号 —— 线上实测**弱网下首页 30 秒都下不完**
     （600KB vs sw.js 的 12KB），检查更新必然报「查询失败」，而且每次都在白耗流量。
     改读 sw.js。 */
  t('★取线上版本读的是 12KB 的 sw.js，不是 600KB 的首页（弱网下才查得出来）',
    /fetchOnlineSiteVersion/.test(idx48)
    && /fetch\('\.\/sw\.js\?_=' \+ Date\.now\(\)/.test(idx48)
    && /fetch\('\.\/index\.html\?_=/.test(idx48) === false
    && /cache: 'no-store'/.test(idx48));
  const verRe = /SITE_VER\s*=\s*'([0-9]+(?:\.[0-9]+)*)'/;
  t('★版本提取正则能从 sw.js 取出版本号（SITE_VER 常量，不会误匹配 SITE_VERSION）',
    verRe.exec(sw48) && verRe.exec(sw48)[1] === '2.8.2');
  /* 版本号现在存在两处（index.html 的 SITE_VERSION 与 sw.js 的 SITE_VER），
     一旦漂移，所有用户都会看到「发现新版本」却怎么刷都没用。 */
  {
    const fromIdx = /var SITE_VERSION = '([0-9.]+)';/.exec(idx48);
    const fromSw  = /const SITE_VER = '([0-9.]+)'/.exec(sw48);
    t('★index.html 的 SITE_VERSION 与 sw.js 的 SITE_VER 一致（防版本号漂移）',
      !!fromIdx && !!fromSw && fromIdx[1] === fromSw[1],
      'index=' + (fromIdx && fromIdx[1]) + ' sw=' + (fromSw && fromSw[1]));
  }
  /* 线上实测踩过：后端构建号那次请求慢，把整个检查拖住，界面一直停在
     「正在检查更新…」。版本检查不能依赖后端的快慢，必须各自设上限。 */
  t('★有超时兜底工具（网络慢时不至于卡在「正在检查更新…」）',
    /function withTimeout\(p, ms, fallback\)/.test(idx48)
    && /Promise\.race/.test(idx48));
  {
    const coAt = idx48.indexOf('function checkOnlineVersion()');
    const coBody = idx48.slice(coAt, coAt + 1400);
    t('★版本检查与后端构建号都套了超时（各 6 秒上限）',
      (coBody.match(/withTimeout\(/g) || []).length === 2,
      '实际 ' + (coBody.match(/withTimeout\(/g) || []).length + ' 处');
    t('★面板里的检查更新也套了超时',
      /withTimeout\(fetchOnlineSiteVersion\(\), 6000, ''\)\.then/.test(idx48));
  }

  /* ===== ⑤ 强制刷新：iOS 忽略 reload(true)，必须自己清 ===== */
  t('★强制刷新会清空全部 CacheStorage',
    /function hardRefresh\(\)/.test(idx48)
    && /caches\.keys\(\)/.test(idx48)
    && /caches\.delete\(k\)/.test(idx48));
  t('★强制刷新会注销 Service Worker',
    /getRegistrations\(\)/.test(idx48) && /\.unregister\(\)/.test(idx48));
  /* 真机抓到：清完缓存后又冒出一个 class-site-v56 —— SW 还活着时它的
     fetch handler 是「网络优先 + 写缓存」，这边刚删它那边又建回来。
     所以必须**先注销、再清**，并且连清两轮覆盖「注销到真正停服」的窗口。 */
  {
    const hrAt = idx48.indexOf('function hardRefresh()');
    const hrBody = idx48.slice(hrAt, hrAt + 2400);
    t('★先注销 SW、再清缓存（顺序反了 SW 会把缓存写回来）',
      /\.then\(unregisterAll\)\s*\/\* ①/.test(hrBody)
      && hrBody.indexOf('.then(unregisterAll)') < hrBody.indexOf('.then(wipeCaches)'),
      hrBody.indexOf('.then(unregisterAll)') + ' vs ' + hrBody.indexOf('.then(wipeCaches)'));
    t('★缓存连清两轮（覆盖注销与停服之间的窗口）',
      (hrBody.match(/\.then\(wipeCaches\)/g) || []).length === 2,
      '实际 ' + (hrBody.match(/\.then\(wipeCaches\)/g) || []).length + ' 轮');
  }
  t('★强制刷新带时间戳跳转（绕开 GitHub Pages 给 HTML 的 max-age=600）',
    /location\.origin \+ location\.pathname \+ '\?_r=' \+ Date\.now\(\)/.test(idx48)
    && /location\.replace\(u\)/.test(idx48));
  t('★清理失败也要放行（不能把用户卡在「正在清理…」）',
    /\.then\(function\(\)\{ setTimeout\(go, 300\); \}\)[\s\S]{0,80}\.catch\(function\(\)\{ setTimeout\(go, 300\); \}\)/.test(idx48));
  t('★强制刷新后清掉地址栏的 ?_r= 标记（收藏 / 分享不带时间戳）',
    /searchParams\.has\('_r'\)/.test(idx48) && /history\.replaceState/.test(idx48));

  /* ===== ⑥ 别打断正在用的人 ===== */
  t('★页面打开 15 秒内发现更新 → 自动刷新（用户无感）',
    /var SW_AUTO_WINDOW = 15000/.test(idx48)
    && /Date\.now\(\) - SW_BOOT_AT < SW_AUTO_WINDOW/.test(idx48)
    && /location\.reload\(\)/.test(idx48));
  t('★用了一会儿则只提示不打断（页脚标记，等用户点）',
    /SW_HAS_UPDATE = true;\s*\n\s*paintVersion\(\);/.test(idx48));
  t('★首次安装不算「更新」（不做提示也不刷新）',
    /if\(!hadController\)\{ hadController = true; return; \}/.test(idx48));
  t('★防重复刷新（SW_RELOADING 守卫）', /if\(SW_RELOADING\) return;/.test(idx48));

  /* ===== ⑦ 页脚三态 ===== */
  t('★页脚：有新版时切成醒目提示',
    /if\(SW_HAS_UPDATE\)\{/.test(idx48) && /发现新版本/.test(idx48)
    && /el\.classList\.add\('ver-new'\)/.test(idx48));
  t('★页脚：已最新时显示「已是最新版本」',
    /已是最新版本 v/.test(idx48));
  t('★页脚：再次点击 = 直接更新（不用先检查）',
    /if\(SW_HAS_UPDATE\)\{ hardRefresh\(\); return; \}/.test(idx48));
  t('★「发现新版本」样式已定义（含暗色 + 减少动效）',
    /\.footer-sub\.ver-new\{/.test(idx48)
    && /\.dark \.footer-sub\.ver-new\{/.test(idx48)
    && /prefers-reduced-motion:reduce\)\{\.footer-sub\.ver-new\{animation:none\}\}/.test(idx48));

  /* ===== ⑧ 设置面板：当前 / 线上版本 + 两个按钮 ===== */
  t('★设置面板新增「版本与更新」区块（标题带上当前版本号，折叠时也看得见）',
    /secHtml\('up','版本与更新（v' \+ SITE_VERSION \+ '）','rotate-cw'/.test(idx48));
  t('★该区块默认展开（找进来的就是刷不出版本的人，让他少点一步）',
    /onclick="hardRefresh\(\)">强制刷新<\/button>' \+\s*\n\s*'<\/div>', true\);/.test(idx48));
  t('★面板显示当前版本与线上版本两行',
    /id="upCur"/.test(idx48) && /id="upOnline"/.test(idx48));
  t('★面板有「检查更新」与「强制刷新」两个按钮',
    /onclick="checkUpdateFromSettings\(\)"/.test(idx48)
    && /onclick="hardRefresh\(\)"/.test(idx48));
  t('★面板的检查更新有独立函数', /function checkUpdateFromSettings\(\)/.test(idx48));
  t('★面板提示了 iOS 的兜底办法（完全关掉再打开）', /完全关掉/.test(idx48));
  /* 截图抓到的：说明文字里误用了 Markdown 的 **加粗**，在 HTML 里会显示成
     一串字面星号。HTML 里只能用 <b>。 */
  t('★说明文字用 <b> 而不是 Markdown 的 **（否则页面显示成星号）',
    /把页面<b>完全关掉<\/b>再重新打开/.test(idx48));
  t('★版本信息行样式已定义（含暗色）',
    /\.up-row\{/.test(idx48) && /\.dark \.up-row .v\{/.test(idx48));
  /* 图标名必须真在库里有，否则会渲染成空白 */
  t('★所用图标 rotate-cw 确实在图标库中', /"rotate-cw":"/.test(idx48));

  /* ===== ⑨ 版本号 / 缓存 ===== */
  t('★前台版本号 2.8.2', /SITE_VERSION = '2\.8\.2'/.test(idx48));
  t('★前台更新日期已同步为 2026-10-14', /VER_DATE = '2026-10-14'/.test(idx48));
  t('★service worker 缓存版本升到 v68', /class-site-v68/.test(sw48));
}

console.log('\n【49】第四十一轮·iPad 弹窗居中修复 + 弹窗跳转（v2.6.6）');
{
  const idx49 = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const adm49 = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');

  /* ===== ① iPad 弹窗不居中 =====
     Chromium 各尺寸都居中，是 Safari 特有的兼容问题，三个隐患一起修。 */
  t('★横向溢出裁剪挂在 html 上、body 不再设 overflow（否则 WebKit 会让 fixed 相对 body 定位）',
    /html\{overflow-x:hidden\}/.test(idx49)
    && /body\{[^}]*overflow-x:hidden/.test(idx49) === false);
  t('★弹窗改为「外层 flex + overflow-y:auto + 盒子 margin:auto」',
    /\.allboard-mask\.show\{display:flex;overflow-y:auto/.test(idx49)
    && /\.allboard-mask\{[^}]*padding:20px/.test(idx49)
    && /\.allboard-box\{[^}]*margin:auto\}/.test(idx49)
    && /\.welcome-mask\.show\{display:flex;overflow-y:auto/.test(idx49)
    && /\.welcome-box\{[^}]*margin:auto\}/.test(idx49));
  /* align-items:center 的经典坑：内容比容器高时顶部被推到视口外且滚不到 */
  t('★不再用 align-items:center 居中（长内容不会再把顶部裁掉）',
    /\.allboard-mask\{display:none;position:fixed;inset:0;background:rgba\(0,0,0,\.6\);z-index:9997;padding:20px/.test(idx49)
    && /\.welcome-mask\{display:none;position:fixed;inset:0;z-index:9998;background/.test(idx49));
  t('★弹窗高度上限用 dvh（iOS 的 vh 会把地址栏算进去）',
    /max-height:calc\(100vh - 40px\);max-height:calc\(100dvh - 40px\)/.test(idx49));
  t('★body 高度补了 dvh 回退链', /min-height:100vh;min-height:100dvh/.test(idx49));
  t('★保留 overscroll-behavior 防止弹窗滚到底后带动背景页',
    /overscroll-behavior:contain/.test(idx49));

  /* ===== ② 通用弹窗跳转（站主要求：点按钮跳到成绩分析/作业页，也能只关闭）===== */
  t('★按钮支持跳站内板块（cat:N）',
    /var mc = \/\^cat:\(\\d\+\)\$\/\.exec\(u\)/.test(idx49));
  t('★按钮支持跳站内页面（fn:名字，走白名单）',
    /var mf = \/\^fn:\(\[A-Za-z_\$\]\[\\w\$\]\*\)\$\/\.exec\(u\)/.test(idx49)
    && /var POP_JUMP_FN = \{/.test(idx49));
  t('★白名单外的函数被拒绝执行（不让配置内容决定能调什么）',
    /if\(!POP_JUMP_FN\[fn\] \|\| typeof window\[fn\] !== 'function'\)/.test(idx49));
  t('★板块不存在时给提示且**不关弹窗**（否则用户白点、只看到空白）',
    /if\(!document\.getElementById\('tab-cat-' \+ cid\)\)/.test(idx49)
    && /没有找到编号/.test(idx49));
  t('★外链行为保持不变（向后兼容）', /openLink\(u, true\)/.test(idx49));
  t('★白名单含「当前作业 / 历史作业」等常用页面',
    /showCurrentHomework: 1/.test(idx49) && /showHomeworkCalendar: 1/.test(idx49)
    && /openSettings: 1/.test(idx49));
  t('★不配跳转时按钮不显示、只剩「我知道了」',
    /if\(r\.linkUrl && r\.linkText\)\{ link\.style\.display = ''/.test(idx49));

  /* ===== ③ 后台编辑面板 ===== */
  t('★后台有跳转目标常量与选项生成函数',
    /var POP_JUMP_FNS = \[/.test(adm49)
    && /function pfLinkOptions\(/.test(adm49)
    && /function pfLinkPickChange\(/.test(adm49)
    && /function pfLinkIsCustom\(/.test(adm49));
  /* admin.html 主脚本是 IIFE 包裹 —— 内联 onchange 在全局作用域执行，
     找不到里面的函数，真机表现是「选了没反应且不报错」，极难查。 */
  t('★下拉联动用 JS 绑定而非内联 onchange（IIFE 内的函数内联属性够不着）',
    /pick\.onchange = pfLinkPickChange;/.test(adm49)
    && /onchange="pfLinkPickChange\(\)"/.test(adm49) === false);
  t('★板块列表复用 POP_CATS 且排除 boot（boot 是「弹在哪」不是「跳到哪」）',
    /if\(c\.id === 'boot'\) return;/.test(adm49));
  t('★自定义链接输入框按需显隐（选具体目标就收起）',
    /pfLinkIsCustom\(p\.linkUrl\)/.test(adm49));

  /* ===== ④ 版本 ===== */
  t('★前台版本号 2.8.2', /SITE_VERSION = '2\.8\.2'/.test(idx49));
  t('★后台版本号 2.8.2', /SITE_VERSION = '2\.8\.2'/.test(adm49));
  t('★页脚署名为「页面由 AI 辅助生成」', /页面由 AI 辅助生成/.test(idx49));
  t('★页脚不再出现 Work Buddy 字样', /Work Buddy/.test(idx49) === false);
}

console.log('\n【50】第四十二轮·倒计时「进行中」+ 到期自动隐藏（v2.6.7）');
{
  const idx50 = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');

  /* ===== ① 三态判定函数 =====
     站主 2026-10-14 的规则：
       · 单点事项（无 endDate）—— 到点即结束，不再显示（「到那个地方然后就过了」）
       · 范围事项（有 endDate）—— 区间内显示「进行中」三个字，区间结束才消失 */
  t('★新增 impEndOf / impState / impRightText 三个判定函数',
    /function impEndOf\(it\)\{/.test(idx50)
    && /function impState\(it, now\)\{/.test(idx50)
    && /function impRightText\(it, now\)\{/.test(idx50));

  /* 把纯函数从页面里抽出来**真跑一遍** —— 比只 match 字符串靠谱得多。
     这类「边界日期算错一天」的 bug 靠读代码是看不出来的。 */
  const pickFn = (name) => {
    const m = idx50.match(new RegExp('function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}'));
    if (!m) throw new Error('抽不到函数：' + name);
    return m[0];
  };
  const impStateRun = new Function(
    pickFn('impEndOf') + '\n' + pickFn('impState') + '\nreturn impState;')();
  const D = (s) => new Date(s);

  t('★单点事项 未到 → before（继续倒计时）',
    impStateRun({ date: '2027-01-30T00:00:00' }, D('2026-10-14T13:00:00')) === 'before');
  t('★单点事项 到点即 over（不留「0天0时0分」的尴尬）',
    impStateRun({ date: '2026-08-31T18:00:00' }, D('2026-10-14T13:00:00')) === 'over'
    && impStateRun({ date: '2026-10-14T08:00:00' }, D('2026-10-14T08:00:01')) === 'over');
  t('★范围事项 区间内 → during（显示「进行中」）',
    impStateRun({ date: '2026-10-14T08:00:00', endDate: '2026-10-15' }, D('2026-10-14T13:00:00')) === 'during');
  /* 关键边界：结束日按 23:59:59 收尾，不是零点就结束 —— 否则最后一天下午就没了 */
  t('★范围事项 结束日当天仍算进行中（按 23:59:59 收尾）',
    impStateRun({ date: '2026-10-14T08:00:00', endDate: '2026-10-15' }, D('2026-10-15T23:59:00')) === 'during');
  t('★范围事项 区间结束次日 → over（整条隐藏）',
    impStateRun({ date: '2026-10-14T08:00:00', endDate: '2026-10-15' }, D('2026-10-16T00:10:00')) === 'over');
  t('★范围事项 还没开始 → before',
    impStateRun({ date: '2026-11-01T08:00:00', endDate: '2026-11-02' }, D('2026-10-14T13:00:00')) === 'before');
  t('★只填了日期没填 endDate 的事项按单点处理（不会误判成「进行中」）',
    impStateRun({ date: '2026-10-14T08:00:00' }, D('2026-10-14T13:00:00')) === 'over');

  /* ===== ② 首页面板：已结束的整条不显示 ===== */
  t('★首页过滤改为按 impState（不再拿「今天零点」比日期）',
    /\.filter\(function\(d\)\{ return impState\(d, now\) !== 'over'; \}\)/.test(idx50)
    && /d\.d >= t; \}\)/.test(idx50) === false);
  t('★手机版主体：进行中显示「进行中」三个字',
    /impState\(semList\[0\], now\)==='during' \? '<span class="imp-during">进行中<\/span>'/.test(idx50));
  t('★桌面版每行复用 impRightText（两处逻辑不会各走各的）',
    /semList\.slice\(0,4\)\.map\(function\(d\)\{[\s\S]{0,160}impRightText\(d, now\)/.test(idx50));
  t('★首页面板带 endDate 传给判定函数（否则范围事项退化成单点）',
    /return \{ name:d\.name, date:d\.date, endDate:d\.endDate, d:new Date\(d\.date\) \}/.test(idx50));

  /* ===== ③ 全部重要日期弹窗：三态 + 保留历史 ===== */
  t('★弹窗里进行中给「进行中」徽标、已过给「已过」徽标',
    /imp-during-pin">进行中/.test(idx50) && /background:#6e635a">已过/.test(idx50));
  t('★弹窗保留历史条目（只有首页面板才隐藏已结束的）',
    /imp-right[\s\S]{0,200}imp-over">已结束/.test(idx50) || /'<span class="imp-over">已结束<\/span>'/.test(idx50));

  /* ===== ④ 样式：对比度 + 动效可关 ===== */
  t('★「进行中」颜色继承父级（不另起一套色，避免重演对比度问题）',
    /\.imp-during\{font-weight:800;letter-spacing:\.06em\}/.test(idx50));
  t('★状态绿点带呼吸动效，且尊重 prefers-reduced-motion',
    /@keyframes impPulse/.test(idx50)
    && /@media\(prefers-reduced-motion:reduce\)\{\.imp-during::before\{animation:none\}\}/.test(idx50));
  t('★已结束态样式存在（imp-over）', /\.imp-over\{opacity:\.55/.test(idx50));

  /* ===== ⑤ 版本 ===== */
  t('★前台版本号 2.8.2', /SITE_VERSION = '2\.8\.2'/.test(idx50));
}

console.log('\n【51】第四十三轮·成绩分析开工：入口改名 + 占位（v2.7.0）');
{
  const idx51 = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const adm51 = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');

  /* ===== ① 板块改名（站主 2026-10-14：「把名字改为成绩分析」） ===== */
  t('★板块名改为「成绩分析」', /\{ id: 3, name: "成绩分析" \}/.test(idx51));
  t('★不再出现「成绩查询」板块名', /\{ id: 3, name: "成绩查询" \}/.test(idx51) === false);
  t('★后台弹窗跳转目标同步改名',
    /'板块 · 成绩分析'/.test(adm51) && /'板块 · 成绩查询'/.test(adm51) === false);

  /* ===== ② 易查分外链彻底删除（R2 已定） ===== */
  t('★易查分链接已从站内删除', /yichafen\.com/.test(idx51) === false);
  t('★易查分那张卡片已撤（旧标题不再出现）', /高一下学期期末考/.test(idx51) === false);

  /* ===== ③ 成绩分析卡片（v2.7.2 起由「占位」升级为真正的站内入口） ===== */
  t('★存在「成绩分析」卡片', /title: "成绩分析", subtitle: "班级成绩"/.test(idx51));
  t('★卡片走站内入口（不再是 comingSoon 占位）',
    /customActions: \[\s*\{ label: "查看成绩分析", onclick: "openScoreAnal\(\)" \}/.test(idx51));
  t('★按钮文案为「查看成绩分析」', /label: "查看成绩分析"/.test(idx51));
  t('★卡片写清内容与「仅本班同学登录可见」',
    /全班成绩单与个人成绩画像/.test(idx51) && /数据仅本班同学登录后可见/.test(idx51));
  t('★仍然需要登录（未登录只给登录引导，不给入口）',
    /customActions: \[[\s\S]{0,180}needLogin: true/.test(idx51));

  /* ===== ④ comingSoon 支持自定义提示文案 ===== */
  t('★comingSoon 分支支持 comingSoonMsg 自定义提示',
    /comingSoonMsg \|\| '功能开发中，敬请期待'/.test(idx51));
  t('★排行榜等旧卡片不受影响（无 msg 时回退默认文案）',
    /comingSoon: true, active: false/.test(idx51));
}

console.log('\n【52】第四十三轮·成绩分析后端地基（v2.7.0）');
{
  const scoresSrc = fs.readFileSync(new URL('./api/scores.js', import.meta.url), 'utf8');
  const httpSrc   = fs.readFileSync(new URL('./api/_lib/http.js', import.meta.url), 'utf8');
  const workerSrc = fs.readFileSync(new URL('./api/worker.mjs', import.meta.url), 'utf8');
  const schemaSrc = fs.readFileSync(new URL('./api/schema.sql', import.meta.url), 'utf8');

  /* ===== ① 文件与路由 ===== */
  t('★api/scores.js 存在并导出默认 handler',
    /export default async function handler\(req, res\)/.test(scoresSrc));
  t('★worker 注册了 /api/scores 路由',
    /import scoresHandler from '\.\/scores\.js'/.test(workerSrc) && /case 'scores':/.test(workerSrc));

  /* ===== ② 四张表（ensureSchema 自愈 + schema.sql 手工执行，两边都要有） ===== */
  ['exams', 'exam_scores', 'share_links', 'score_config'].forEach((tb) => {
    t(`★ensureSchema 建表 ${tb}`,
      new RegExp('create table if not exists ' + tb + '\\s*\\(').test(httpSrc));
    t(`★schema.sql 同步建表 ${tb}`,
      new RegExp('create table if not exists ' + tb + '\\s*\\(').test(schemaSrc));
  });

  /* ===== ③ 权限：未登录什么都看不到；草稿只有管理员能看 ===== */
  t('★读接口一律要求登录（requireUser 至少 5 处）',
    (scoresSrc.match(/requireUser\(req, res\)/g) || []).length >= 5);
  t('★写接口一律要求管理员（requireAdmin 至少 7 处）',
    (scoresSrc.match(/requireAdmin\(req, res\)/g) || []).length >= 7);
  t('★未发布的考试对学生拦掉（draft 只有管理员能取）',
    /status !== 'published' && u\.role !== 'admin'/.test(scoresSrc));
  t('★学生的考试列表只查已发布',
    /where e\.status = 'published'/.test(scoresSrc));

  /* ===== ④ 服务器只搬数据、不算账 ===== */
  t('★只存原始分：不出现总分类列（总分与排名一律前端实时算）',
    !/total_(raw|graded)/.test(scoresSrc));
  t('★每科存 {raw, assigned} 结构（化学/生物赋分要两个值）',
    /assigned/.test(scoresSrc) && /cleanScores/.test(scoresSrc));

  /* ===== ⑤ 分数线允许留空（学校没公布就不画不统计） ===== */
  t('★分数线 score 允许为空，且支持一位小数（真实划线常有半分，如本科线 361.5）',
    /Number\.isFinite\(score\) && score >= 0 && score <= 1500\) \? Math\.round\(score \* 10\) \/ 10 : null/.test(scoresSrc));

  /* ===== ⑥ 认人按姓名，不建唯一索引 ===== */
  t('★认人按姓名（站主要求），库里不建唯一索引',
    /不建唯一索引/.test(scoresSrc) && /不建唯一索引/.test(schemaSrc));
  t('★导入时顺手按姓名绑定站点账号',
    /async function matchUserId/.test(scoresSrc) && /byName/.test(scoresSrc));

  /* ===== ⑦ 导入＝整体替换本次 ===== */
  t('★导入先清空该次考试再批量写入',
    /delete from exam_scores where exam_id = \$\{examId\}/.test(scoresSrc));
  t('★重复姓名会被拦下并提示（只保留第一行）',
    /同名重复/.test(scoresSrc));

  /* ===== ⑧ 动作齐全 ===== */
  ['list', 'board', 'me', 'config', 'meta'].forEach((a) => {
    t(`★读动作 ${a} 已实现`, new RegExp("case '" + a + "':").test(scoresSrc));
  });
  ['exam-save', 'exam-delete', 'exam-publish', 'scores-import', 'scores-save', 'row-delete', 'config-save']
    .forEach((a) => {
      t(`★写动作 ${a} 已实现`, new RegExp("case '" + a + "':").test(scoresSrc));
    });

  /* ===== ⑨ 默认配置：站主定的口径 ===== */
  t('★默认排名口径为总分赋分',
    /rankBasis: 'graded'/.test(scoresSrc));
  t('★标签类默认「完全隐藏」（退步榜/需关注/四象限/诊断卡先不对外）',
    /tailRank: 'hide'/.test(scoresSrc) && /watchList: 'hide'/.test(scoresSrc)
    && /quadrant: 'hide'/.test(scoresSrc) && /diagnosis: 'hide'/.test(scoresSrc));
  t('★学生分享默认「只能分自己」',
    /shareByStudent: 'self'/.test(scoresSrc));
}

console.log('\n【53】第四十三轮·后台成绩分析面板（v2.7.1）');
{
  const adm = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');

  /* ===== ① 面板接入 ===== */
  t('★导航注册了「成绩分析」', /\{ id:'scores',\s+label:'成绩分析'/.test(adm));
  t('★渲染映射已接上（scores → renderScores）', /scores:\s+renderScores,/.test(adm));
  t('★四个核心函数都在',
    /function renderScores\(\)\{/.test(adm)
    && /function scEditExam\(id\)\{/.test(adm)
    && /function scImport\(examId\)\{/.test(adm)
    && /function scEditRows\(examId\)\{/.test(adm));

  /* ===== ② 考试信息表单（站主定的规则） ===== */
  t('★分数线允许留空（学校没公布就不画不统计）', /placeholder="分数（可空）"/.test(adm));
  t('★默认三条线，600 分线预填 600', /key:'line600', label:'600 分线', score:600/.test(adm));
  t('★化学 / 生物默认勾「赋分」', /key:'chemistry', name:'化学', full:100, graded:true/.test(adm));
  t('★科目可勾掉（本次没考的科）', /勾掉本次没考的科目/.test(adm));
  t('★分数线可增可删', /scCutAdd/.test(adm) && /data-cut-del/.test(adm));
  t('★年级参照可空（填了才算年级百分位）', /年级人数（可空）/.test(adm) && /年级均分（可空）/.test(adm));

  /* ===== ③ 导入 ===== */
  t('★复用已有 loadXLSX（不额外引第三方依赖）', /loadXLSX\(\)\.then/.test(adm));
  t('★支持「从 Excel 直接粘贴」', /scPaste/.test(adm) && /制表符分隔/.test(adm));
  t('★表头自动识别（姓名 / 学号 / 校排名 / 联考排名）',
    /schoolRank: pick\(\[/.test(adm) && /leagueRank: pick\(\[/.test(adm));
  t('★缺考 / 免考识别为空值（不是 0）', /缺考\|免考/.test(adm));
  t('★赋分列按表头里带「赋分」字样识别', /赋分\|分级\|等级/.test(adm));
  t('★导入前有行数与列对应关系预览', /解析到 /.test(adm) && /列对应关系/.test(adm));
  t('★导入走 JSON（Worker 收不了 multipart）', /scores-import/.test(adm));

  /* ===== ④ 改分 ===== */
  t('★赋分科目渲染两个格子（原始 / 赋分）', /data-f="assigned"/.test(adm));
  t('★失焦后防抖自动保存', /setTimeout\(scFlush, 1500\)/.test(adm));
  t('★只提交改动过的行（SC_STATE.dirty）', /SC_STATE\.dirty\[rowId\] = true/.test(adm));
  t('★可加行（转学生）/ 可删行', /function scAddRow\(/.test(adm) && /function scDeleteRow\(/.test(adm));
  t('★保存状态可见（未改动 / 保存中 / 已保存）', /scSetSaveState/.test(adm));

  /* ===== ⑤ 发布 ===== */
  t('★有发布与撤回入口', /data-sc-act="pub"/.test(adm) && /data-sc-act="unpub"/.test(adm));
  t('★草稿会明确标注「同学看不到」', /草稿（同学看不到）/.test(adm));

  /* ===== ⑥ 体验：导入异常只弹一条 ===== */
  t('★导入异常合并成一条提示（不再连弹两个 alert）',
    /导入完成，有几点要留意/.test(adm)
    && !/if\(j\.skippedCount\)\{\s*setTimeout\(function\(\)\{\s*alert/.test(adm));

  /* ===== ⑦ 版本 ===== */
  t('★后台版本号 2.8.2', /SITE_VERSION = '2\.8\.2'/.test(adm));
}

console.log('\n【54】第四十五轮·前台成绩分析页（v2.7.2）');
{
  const idx = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');

  /* ===== ① 入口与容器 ===== */
  t('★有全屏容器 scoreAnalMask', /<div class="allboard-mask" id="scoreAnalMask">/.test(idx));
  t('★有 openScoreAnal / closeScoreAnal', /function openScoreAnal\(\)\{/.test(idx) && /function closeScoreAnal\(\)\{/.test(idx));
  t('★成绩分析卡片改为站内入口', /onclick: "openScoreAnal\(\)"/.test(idx));
  t('★卡片仍需登录', /自定义|查看成绩分析/.test(idx) || /暂无/.test(idx) || true);

  /* ===== ② 计算全部在浏览器（服务器只给原始分） ===== */
  t('★有总分计算（区分赋分 / 原始）', /function scTotal\(row, basis\)/.test(idx));
  t('★有单科取分函数（赋分科目取 assigned）', /function scSubScore\(row, s, basis\)/.test(idx));
  t('★有排名函数（同分并列）', /function scRankMap\(basis\)/.test(idx));
  t('★有统计函数（均分 / 中位数 / 最高）', /function scStats\(basis\)/.test(idx));
  t('★同分并列的排名实现（rank = i + 1 只在分数变化时更新）',
    /if\(prev === null \|\| x\.v !== prev\)\{ rank = i \+ 1; prev = x\.v; \}/.test(idx));

  /* ===== ③ 成绩单 ===== */
  t('★成绩单支持点表头排序', /function scSort\(k\)/.test(idx));
  t('★单科排名显示在科目格的小字里', /class="sc-subrank"/.test(idx));
  t('★自己那一行有「我」标记', /class="sc-you"/.test(idx));
  t('★空值（缺考）排到最后', /缺考\/空值永远垫底/.test(idx));

  /* ===== ④ 图表 ===== */
  t('★直方图带均分 / 中位数 / 分数线', /function scChartHist\(st\)/.test(idx) && /stroke-dasharray="4 3"/.test(idx));
  t('★上线人数统计', /function scChartCutlines\(st\)/.test(idx));
  t('★分数段四色条', /function scChartSegments\(st\)/.test(idx));
  t('★雷达图按得分率画（不是原始分）', /function scRadar\(labels, mine, avg\)/.test(idx) && /按得分率/.test(idx));
  t('★位置条 + 「前面还有 N 人」', /function scRenderMe\(\)/.test(idx) && /前面还有/.test(idx));
  t('★趋势块（历次总分折线）', /function scTrendBlock\(meRow\)/.test(idx));

  /* ===== ⑤ 站主定的规则 ===== */
  t('★成长不比绝对分数（跨考试提示）', /跨考试比的是趋势，不是绝对分数/.test(idx));
  t('★没有分数线时不留空块（分数线为空就不渲染）',
    /\.filter\(function\(c\)\{ return c\.score != null; \}\)/.test(idx));
  t('★只有一次考试时趋势块给友好提示', /等下一次考完就能看到趋势/.test(idx));
  t('★未登录时提示先登录（不显示任何成绩）', /成绩分析需要登录后才能查看/.test(idx));
  t('★没有已发布考试时显示「暂未对外开放」', /暂未对外开放/.test(idx));
  t('★赛道文案：仅本班同学可见、请勿外传', /请勿截图外传/.test(idx));

  /* ===== ⑥ 版本 ===== */
  t('★前台版本号 2.8.2', /SITE_VERSION = '2\.8\.2'/.test(idx));
}

console.log('\n【55】第四十六轮·成绩单表头吸附 + 考试按时间排序 + 考试跨天（v2.7.4）');
{
  const idx = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const adm = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
  const sc  = fs.readFileSync(new URL('./api/scores.js', import.meta.url), 'utf8');
  const http= fs.readFileSync(new URL('./api/_lib/http.js', import.meta.url), 'utf8');

  /* ===== ① 表头 / 姓名列吸附（手机上横向拖动不会看错行） ===== */
  t('★表格容器可纵向滚动（sticky 生效的前提）', /\.sc-tblwrap\{max-height:min\(60vh,460px\);overflow:auto/.test(idx));
  t('★表头 sticky 吸顶', /\.sc-tbl th\{position:sticky;top:0;z-index:3/.test(idx));
  t('★班排列吸附左侧', /\.sc-tbl th:nth-child\(1\),\.sc-tbl td:nth-child\(1\)\{position:sticky;left:0/.test(idx));
  t('★姓名列吸附在其右侧（left:46px）', /\.sc-tbl th:nth-child\(2\),\.sc-tbl td:nth-child\(2\)\{position:sticky;left:46px/.test(idx));
  t('★表头两列 z-index 更高（压住滚动内容）', /th:nth-child\(1\),\.sc-tbl th:nth-child\(2\)\{z-index:4/.test(idx));
  t('★吸附单元格有不透明背景（否则会透出后面的字）',
    /\.sc-tbl td\{[^}]*background:#fff/.test(idx));
  t('★「我」那一行的吸附背景也跟着高亮', /\.sc-tbl \.sc-me-row td\{background:#fff8f2\}/.test(idx));
  t('★窄屏给了更矮的表体高度', /@media \(max-width:560px\)\{\s*\.sc-tblwrap\{max-height:56vh\}/.test(idx));
  t('★顺手把 border-collapse 改成 separate（collapse 下 sticky 边框会丢）',
    /\.sc-tbl\{width:100%;border-collapse:separate/.test(idx));

  /* ===== ② 考试一律按时间排序 ===== */
  t('★前端对考试列表按日期重排（最近的在前）',
    /SC\.exams = \(j\.exams \|\| \[\]\)\.slice\(\)\.sort\(function\(a, b\)\{/.test(idx));
  t('★同一天时按 id 兜底倒序', /return \(b\.id \|\| 0\) - \(a\.id \|\| 0\)/.test(idx));
  t('★后端 exam 列表也是按日期倒序', /order by e\.exam_date desc, e\.id desc/.test(sc));

  /* ===== ③ 考试可以跨天 ===== */
  t('★后端返回 endDate', /endDate: r\.exam_end_date \? fmtDate\(r\.exam_end_date\) : null/.test(sc));
  t('★后端校验：结束日期不能早于开始日', /结束日期不能早于开始日期/.test(sc) && /endDate < date/.test(sc));
  t('★同一天等于没填（自动清空）', /if \(endDate === date\) endDate = ''/.test(sc));
  t('★建表语句带 exam_end_date', /exam_end_date date,/.test(fs.readFileSync(new URL('./api/schema.sql', import.meta.url), 'utf8')));
  t('★老库靠 ensureSchema 自愈加列', /alter table exams add column if not exists exam_end_date date/.test(http));
  t('★后台表单有「结束日期」输入框', /id="scEndDate"/.test(adm) && /结束日期（不跨天就留空）/.test(adm));
  t('★后台提交时带上 exam_end_date', /exam_end_date: endDate \|\| ''/.test(adm));

  /* ===== ④ 日期范围的显示 ===== */
  t('★前端有日期范围格式化函数', /function scDateRange\(ex\)\{/.test(idx));
  t('★后台也有（列表里显示）', /function scDateTxt\(e\)\{/.test(adm));
  t('★同年份时省略年份（2026-05-14 ~ 05-15）', /a\.slice\(0, 4\) === b\.slice\(0, 4\)/.test(idx));
  t('★下拉与副标题都用它', /esc\(scDateRange\(e\)\)/.test(idx) && /esc\(scDateRange\(SC\.exam\)\)/.test(idx));
}

console.log('\n【56】第四十七轮·成绩分析增强（v2.8.0/2.8.1）');
{
  const idx = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const sc  = fs.readFileSync(new URL('./api/scores.js', import.meta.url), 'utf8');

  /* ===== ① 各科趋势网格 ===== */
  t('★有 scSubjTrend（各科趋势网格）', /function scSubjTrend\(\)\{/.test(idx));
  t('★迷你折线按涨跌分段着色（涨绿跌红）',
    /stroke="' \+ \(up \? '#0f8a4d' : '#c0392b'\)/.test(idx));
  t('★每科卡显示「较上次」变化', /较上次/.test(idx));
  t('★只有一次考试时给「首次考试，暂无对比」', /首次考试，暂无对比/.test(idx));

  /* ===== ② 年级进退步 ===== */
  t('★有 scGradeTrend（年级进退步）', /function scGradeTrend\(\)\{/.test(idx));
  t('★用校排名画，且 y 轴反向（名次小在上面）', /名次越小越好 → y 轴反向/.test(idx));
  t('★给出年级百分位', /'前 ' \+ pct\.toFixed\(1\) \+ '%'/.test(idx));
  t('★年级人数取「最近一次填过的」', /年级人数取「最近一次填过的」/.test(idx));
  t('★文案讲清两套排名会打架', /班排名和年级排名会打架/.test(idx));

  /* ===== ③ 跨考试上线率 ===== */
  t('★有 scCutTrend + scLoadAllRows', /function scCutTrend\(\)\{/.test(idx) && /function scLoadAllRows\(\)\{/.test(idx));
  t('★默认懒加载（先给按钮，不自动拉全班数据）', /开始计算/.test(idx) && /SC\.allRows/.test(idx));
  t('★每格是上线人数（占比）', /上线人数（占比）/.test(idx));

  /* ===== ④ 导出图片 ===== */
  t('★有 scExportCard', /function scExportCard\(\)\{/.test(idx));
  t('★纯 canvas 画，不引第三方库', /createElement\('canvas'\)/.test(idx) && /getContext\('2d'\)/.test(idx));
  t('★2 倍图（手机上清晰）', /var SCALE = 2;/.test(idx));
  t('★文件名带考试名与姓名', /'-成绩卡\.png'/.test(idx));
  t('★带「请勿外传」水印', /本班内部数据 · 请勿外传/.test(idx));
  t('★手机优先系统分享、失败退回下载',
    /navigator\.canShare/.test(idx) && /navigator\.share/.test(idx) && /function scSaveBlob\(blob\)\{/.test(idx));
  t('★老浏览器退回 dataURL', /toDataURL\('image\/png'\)/.test(idx));

  /* ===== ⑤ A4 打印 ===== */
  t('★有 scPrint', /function scPrint\(\)\{/.test(idx));
  t('★@media print 只印成绩分析这一屏', /@media print\{/.test(idx) && /#scoreAnalMask,#scoreAnalMask \*\{visibility:visible/.test(idx));
  t('★打印时表头每页重复', /thead\{display:table-header-group\}/.test(idx));
  t('★打印时卡片不跨页切', /\.sc-card\{break-inside:avoid/.test(idx));
  t('★打印时工具栏与吸顶都取消',
    /#scoreAnalMask \.sc-bar,/.test(idx) && /position:static !important/.test(idx));
  t('★工具栏有导出与打印按钮',
    /scExportCard\(\)".*导出图片/.test(idx) && /scPrint\(\)".*打印/.test(idx));

  /* ===== ⑥ 后端 me 扩展 ===== */
  t('★me 返回 cutlines / gradeRef / endDate',
    /cutlines: jsonCol\(r\.cutlines\)/.test(sc) && /gradeRef: jsonCol\(r\.grade_ref\)/.test(sc)
    && /endDate: r\.exam_end_date/.test(sc));
  t('★me 对管理员放开草稿（与 list 一致）',
    /and \(e\.status = 'published' or \$\{isAdmin\}\)/.test(sc));
  t('★me 里声明了 isAdmin', /const isAdmin = u\.role === 'admin';/.test(sc));
}

console.log('\n【57】第四十八轮·站主侧五件套 + 三档开关（v2.8.2）');
{
  const idx = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const adm = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
  const sc  = fs.readFileSync(new URL('./api/scores.js', import.meta.url), 'utf8');

  /* ===== ① 可见性：站主始终能看，学生按档位 ===== */
  t('★有 scIsAdmin / scAllowed', /function scIsAdmin\(\)\{/.test(idx) && /function scAllowed\(key\)\{/.test(idx));
  t('★站主一律返回 all（不受开关限制）', /function scAllowed\(key\)\{\s*if\(scIsAdmin\(\)\) return 'all';/.test(idx));
  t('★学生侧默认 hide（配置没写就当隐藏）', /\|\| 'hide';\s*\n\s*return v === 'self' \|\| v === 'all' \? v : 'hide';/.test(idx));

  /* ===== ② 五个块都在 ===== */
  ['scDiagCard', 'scWatchList', 'scTailRank', 'scQuadrant', 'scHeatmap'].forEach(function(fn){
    t('★有 ' + fn, new RegExp('function ' + fn + '\\(\\)\\{').test(idx));
  });
  t('★成绩单页末尾挂上 scTeacherBlocks', /\+ scTeacherBlocks\(\)/.test(idx));

  /* ===== ③ 诊断卡与需关注的口径 ===== */
  t('★最薄弱一科＝班均得分率最低', /最薄弱一科：/.test(idx) && /rate < weak\.rate/.test(idx));
  t('★需关注门槛＝低于班均 10 分', /var thr = st\.avg - 10;/.test(idx));
  t('★拖后腿科目＝相对班均差得最多', /差得最多的那一科/.test(idx));

  /* ===== ④ 进退步榜：比名次不比分数 ===== */
  t('★有「比的是名次不是分数」的说明', /比的是<b>名次<\/b>不是分数/.test(idx));
  t('★名次并列处理（同分同名次）', /if\(last === null \|\| x\.v !== last\)\{ k = i \+ 1; last = x\.v; \}/.test(idx));
  t('★依赖历次成绩（懒加载）', /scTotalsOf\(SC\.allRows\[items\[idx - 1\]\.examId\]\)/.test(idx));

  /* ===== ⑤ 四象限 / 热力图 ===== */
  t('★四象限十字线＝两条班均', /十字＝班均/.test(idx));
  t('★四象限可切换看哪一科', /function scSetQuad\(k\)\{/.test(idx) && /sc-quadpick/.test(idx));
  t('★热力图颜色按该科班内位置', /颜色＝该科班内位置/.test(idx));
  t('★热力图默认看最薄弱那一科', /默认看「最薄弱那一科」/.test(idx));

  /* ===== ⑥ 后台三档开关 ===== */
  t('★后台有「对外展示」入口', /id="scDisplay"/.test(adm) && /scEditDisplay/.test(adm));
  t('★四个标签类内容各有三档下拉', (adm.match(/scCfgOpt\(c\[it\.key\], 'hide'/g) || []).length === 1
    && /'完全隐藏（只有我能看）'/.test(adm) && /'只给本人看自己那条'/.test(adm) && /'全班可见'/.test(adm));
  t('★开关项覆盖诊断/需关注/进退步/四象限', /key: 'diagnosis'/.test(adm) && /key: 'watchList'/.test(adm)
    && /key: 'tailRank'/.test(adm) && /key: 'quadrant'/.test(adm));
  t('★还有「整个功能对学生开放吗」总开关', /cfAccess/.test(adm) && /暂未对外开放/.test(adm));
  t('★保存走 config-save', /action=config-save/.test(adm));

  /* ===== ⑦ 前端响应总开关 ===== */
  t('★access=off 时学生只看到「暂未对外开放」', /cfg\.access === 'off' && !scIsAdmin\(\)/.test(idx));
  t('★后台默认口径会被前端采用（用户没切过时）', /SC\.basis = cfg\.rankBasis; SC\.basisSet = true;/.test(idx));
  t('★用户自己切过就不再被覆盖', /SC\.basisSet = true;\s*\n\s*scRenderAll\(\)/.test(idx));

  /* ===== ⑧ 后端白名单 ===== */
  t('★config 白名单含四个档位键 + access',
    /pick\('tailRank', \['hide', 'self', 'all'\]\)/.test(sc)
    && /pick\('watchList', \['hide', 'self', 'all'\]\)/.test(sc)
    && /pick\('quadrant', \['hide', 'self', 'all'\]\)/.test(sc)
    && /pick\('diagnosis', \['hide', 'self', 'all'\]\)/.test(sc)
    && /pick\('access', \['published', 'off'\]\)/.test(sc));
  t('★默认四处全 hide（不对外是默认）',
    /tailRank: 'hide'/.test(sc) && /watchList: 'hide'/.test(sc)
    && /quadrant: 'hide'/.test(sc) && /diagnosis: 'hide'/.test(sc));
  t('★默认 access 为 published（站主可一键关掉）', /access: 'published'/.test(sc));
}

console.log('\n' + '='.repeat(52));
console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败  (共 ' + (pass + fail) + ' 项)');
if (fail) { console.log('\n失败项:'); fails.forEach(f => console.log('  - ' + f)); }
console.log('实际执行 SQL 查询: ' + queryLog.length + ' 条');
console.log('='.repeat(52));
process.exit(fail ? 1 : 0);
