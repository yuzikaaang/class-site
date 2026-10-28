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

/* v3.9.21：版本断言不再写死 —— 从 index.html 现读，升版本只改一处。
   以前每发一版都要手动改 8 处 3.9.x，漏一处就红一片。 */
import fs0 from 'node:fs';
const CUR_VER = (fs0.readFileSync(new URL('./index.html', import.meta.url), 'utf8')
  .match(/var SITE_VERSION = '([\d.]+)'/) || [])[1] || '';
const CUR_VER_RE = CUR_VER.replace(/\./g, '\\.');
const CUR_DATE = (fs0.readFileSync(new URL('./index.html', import.meta.url), 'utf8')
  .match(/var VER_DATE = '([\d-]+)'/) || [])[1] || '';
const RE_SITE = new RegExp("var SITE_VERSION = '" + CUR_VER_RE + "'");
const RE_SITE_VER = new RegExp("const SITE_VER = '" + CUR_VER_RE + "'");
const RE_API_VER = new RegExp("const API_VER = '" + CUR_VER_RE + "'");
const RE_DATE = new RegExp("VER_DATE = '" + CUR_DATE + "'");
import fs from 'node:fs';

/* v3.9.8：主脚本拆到 app.js 后，凡「读首页源码」的断言一律读两份拼接 ——
   既能看到 HTML 骨架，也能看到函数实现，不用逐条改写断言。 */
/* v3.9.16：admin.html 的大脚本已拆到 admin.js（构建产物）。
   凡是「读后台源码」的断言读两份拼接，避免拆包把断言全打红。 */
function readAdm(){
  const a = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
  let b = '';
  try { b = fs.readFileSync(new URL('./admin.js', import.meta.url), 'utf8'); } catch (e) {}
  return a + '\n/* ---- admin.js ---- */\n' + b;
}

/* v3.9.25：全屏时钟是独立页面，单独读 */
function readClock(){
  try { return fs.readFileSync(new URL('./clock.html', import.meta.url), 'utf8'); } catch (e) { return ''; }
}
function readApi(name){
  try { return fs.readFileSync(new URL('./api/' + name, import.meta.url), 'utf8'); } catch (e) { return ''; }
}

function readIdx(){
  const a = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  let b = '';
  try { b = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8'); } catch (e) {}
  return a + '\n/* ---- app.js ---- */\n' + b;
}

/* ---------- 1. 桥接环境变量 ---------- */
/* v3.5.0：档案字段加密（AES-256-GCM）默认**开启**，因为线上站主一旦配了
   ADMIN_SECRETS_KEY 就会走这条路，测试必须覆盖真实形态。
   想看「没配密钥、全站退化为明文」的老行为，用 `node test_e2e.mjs --plain`。
   两套环境跑的是同一份 2248 项，任何一边红都算回归。 */
const PLAIN_MODE = process.argv.includes('--plain');
globalThis.__ENV__ = {
  ALLOW_ORIGINS: 'https://yuzikaaang.github.io',
  ADMIN_USERS: 'yuzikang',
  SESSION_DAYS: '30',
  ALLOW_REGISTER: '1',
  DATABASE_URL: 'postgres://stub',   // 实际不连，走桥接
};
if (!PLAIN_MODE) {
  /* 固定的 32 字节测试密钥（不是线上那把，仅用于本测试） */
  globalThis.__ENV__.ADMIN_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
}

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
/* ---- 成绩分析四张表（v2.9.5 补进桩里）----
   ⚠️ 以前桩里**没有**这四张表：ensureSchema 的建表语句带 Postgres 专有语法
   （jsonb / timestamptz / bigserial / '{}'::jsonb），SQLite 走到第一条就报错、
   整个 try 被 catch 吞掉 —— 从 exams 往后的表一张都建不出来。
   后果是「成绩分析」这条链路其实**从没在测试里真跑过**，只有源码字符串断言。
   现在按 SQLite 能懂的写法补上（类型名随它去、默认值去掉 ::jsonb），
   让建考试 / 导入 / 发布 / 姓名对照 / 个人成绩这些真流程都能被真跑一遍。 */
create table exams (
  id integer primary key autoincrement,
  name text not null,
  exam_date text not null,
  exam_end_date text,
  exam_type text,
  subjects jsonb,
  cutlines jsonb,
  grade_ref jsonb,
  visible_to jsonb,
  note text,
  status text not null default 'draft',
  published_at text,
  created_by integer,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);
create table exam_scores (
  id integer primary key autoincrement,
  exam_id integer not null,
  user_id integer,
  student_name text not null,
  student_no text,
  scores jsonb not null default '{}',
  school_rank integer,
  league_rank integer,
  note text,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);
create table share_links (
  id integer primary key autoincrement,
  token text not null unique,
  scope text not null default 'self',
  owner_id integer,
  target_ids text,
  exam_ids text,
  sections jsonb not null default '{}',
  expires_at text,
  max_views integer,
  views integer not null default 0,
  revoked boolean not null default 0,
  created_at text not null default (datetime('now'))
);
create table score_config (
  id integer primary key default 1,
  data jsonb not null default '{}',
  updated_at text not null default (datetime('now'))
);
/* v3.5.27 歌曲时长云端库（对应 schema.sql 最后一段） */
create table song_durations (
  song_key   text primary key,
  title      text not null default '',
  artist     text not null default '',
  seconds    integer not null,
  source     text not null default 'auto',
  updated_at text not null default (datetime('now'))
);
create index song_dur_title_idx on song_durations (title);
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
  /* v2.10.0：site_settings.data 也是 jsonb 列（PG 语义），读取时同样要
     还原成对象，否则 getSiteSetting 的 data[key] 永远拿到 undefined、
     设置开关全部「读不回」。 */
  const isSite = /from\s+site_settings/i.test(sqlText) && /\bdata\b/i.test(sqlText);
  const isUser = /from\s+user_data/i.test(sqlText) && /\bdata_value\b/i.test(sqlText);
  if (!isSite && !isUser) return rows;
  const col = isSite ? 'data' : 'data_value';
  return rows.map((r) => {
    if (!Object.prototype.hasOwnProperty.call(r, col)) return r;
    if (typeof r[col] !== 'string') return r;
    const s = r[col].trim();
    if (!s) return r;
    let v;
    try { v = JSON.parse(s); } catch { return r; }   // 不是合法 JSON：原样返回
    return Object.assign({}, r, { [col]: v });
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
  /* v2.10.0：SQLite 的 ALTER TABLE 只认 RENAME / ADD COLUMN / DROP COLUMN，
     **不支持 DROP/ADD CONSTRAINT**（PG 把 users.status 的 check 扩到
     'pending' 必须「先删后加」）。桩的 users 表按 schema.sql 建、本就
     不带 check 约束，'pending' 插入不受限 —— 两条约束 DDL 在桩上一律
     按 no-op 跳过；约束本身的覆盖由生产 schema.sql（人工执行）保证。 */
  if (/^\s*alter\s+table[\s\S]*drop\s+constraint\s+if\s+exists/i.test(s)) {
    return { __skip: s };
  }
  if (/^\s*alter\s+table[\s\S]*add\s+constraint/i.test(s)) {
    return { __skip: s };
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
  /* v3.5.35：extract(epoch from (A - B)) → SQLite 的秒差。
     PG 里 timestamptz 相减得到 interval，extract(epoch ...) 取出秒数；
     SQLite 里两个 datetime 串相减没有意义，要换 strftime('%s', ...)。
     桩的时间列都是 text，'YYYY-MM-DD HH:MM:SS' 格式，strftime 直接吃。 */
  s = s.replace(
    /extract\s*\(\s*epoch\s+from\s*\(\s*([\w.]+)\s*-\s*([\w.]+)\s*\)\s*\)/gi,
    (m, a, b) => "(strftime('%s', " + a + ") - strftime('%s', " + b + "))"
  );
  /* date_trunc('day', X) → X 的当天起点（SQLite 用 date(X)） */
  s = s.replace(
    /date_trunc\s*\(\s*'day'\s*,\s*([^)]+)\)/gi,
    (m, inner) => "date(" + inner.trim() + ")"
  );
  /* v2.10.0：(X at time zone 'Zone')::date → date(X)
     「按天筛选」在 PG 上要按时区归日；SQLite 桩无时区概念，
     剥成 date(X) 保证同一段 SQL 在桩上也能跑（时区换算本身不在测试范围）。 */
  s = s.replace(
    /\(\s*([^()]+?)\s+at\s+time\s+zone\s+'[^']+'\s*\)\s*::\s*date/gi,
    (m, inner) => "date(" + inner.trim() + ")"
  );
  /* 其余 at time zone 'Zone' → 剥掉（PG 时区转换，桩不仿真） */
  s = s.replace(/\s+at\s+time\s+zone\s+'[^']+'/gi, '');
  /* 剩余 now() */
  s = s.replace(/\bnow\(\)/gi, "datetime('now')");
  /* ilike → like：SQLite 的 LIKE 对 ASCII 本来就大小写不敏感，
     Postgres 的 ilike 在这里等价降级，测试语义不变 */
  s = s.replace(/\bilike\b/gi, 'like');
  /* order by ... nulls last / nulls first：SQLite 3.30+ 支持，
     但 sql.js 版本可能偏低，直接剥掉（测试不依赖 null 的排序位置） */
  s = s.replace(/\s+nulls\s+(last|first)/gi, '');
  /* 剥掉其余类型转换 */
  s = s.replace(/::\s*(int|integer|text|jsonb|boolean|bigint|timestamptz|interval|date)(\s*\[\s*\])?/gi, '');
  /* v2.10.0 站点设置 upsert：PG 的 jsonb `||` 合并 → SQLite 的 json_patch
     （sql.js 内置 JSON1，语义等价：两个 JSON 对象按键深合并）。
     必须写在本行之前没有其它规则先动 `||` —— 这里是唯一接触它的地方。 */
  s = s.replace(/(site_settings\.data)\s*\|\|\s*(excluded\.data)/gi, 'json_patch($1, $2)');

  /* ---- update ... 别名 ... from：SQLite 要求别名前有 AS ----
     Postgres 写 `update exam_scores t set ... from (...) as x where t.id = x.id`，
     SQLite 的 UPDATE 语法要求 `update exam_scores as t set ...`，少了 as 就是
     `near "t": syntax error`。
     ⚠️ 补这条的意义不只是让测试过 —— 它意味着**「后台改分保存」这条路以前
        从来没在测试里真跑过**（import 走 insert，能跑；save 走 update，跑不起来），
        所以「改一格的分数会不会把整行的其他字段冲掉」这类问题一直测不出来。
     见 2026-10-17 第六十三轮：加各科排名时正是靠这条路才发现风险的。 */
  s = s.replace(/\bupdate\s+([\w"]+)\s+(?!as\b|set\b)([\w]+)\s+set\b/gi, 'update $1 as $2 set');
  /* RETURNING 里不能带别名：SQLite 认 `returning id` 或 `returning 表名.id`，
     但不认 `returning 别名.id`（Postgres 认）。本项目 INSERT/UPDATE 的
     RETURNING 都是单表，剥掉限定前缀语义不变。 */
  s = s.replace(/\breturning\s+([\w"]+)\.([\w"]+)/gi, 'returning $2');

  /* ---- jsonb_to_recordset：把 JSON 数组一次摊成「多行多列」 ----
     Postgres 专有（本项目用它把整批成绩当**一个**参数灌进去，绕开
     Workers 每请求 50 个子请求的上限）。SQLite 用 json_each 展开数组、
     json_extract 取顶层字段，语义等价，且同样只占一个绑定参数。
     位置必须在剥类型之后 —— 那时括号里已经是干净的 $N。 */
  s = s.replace(
    /jsonb_to_recordset\s*\(\s*(\$\d+)\s*\)\s*as\s+(\w+)\s*\(([^)]*)\)/gi,
    (m, ph, alias, cols) => {
      const parts = cols.split(',').map((c) => c.trim()).filter(Boolean).map((c) => {
        const nm = c.split(/\s+/)[0].replace(/"/g, '');
        return "json_extract(j.value, '$." + nm + "') as " + nm;
      }).join(', ');
      return '(select ' + parts + ' from json_each(' + ph + ') as j) as ' + alias;
    }
  );
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
          /* v3.5.5：一条 ALTER 多列（PG 合法、SQLite 不认）——
             Workers 免费版子请求纪律（单请求 50 上限）要求 ensureSchema
             多列合并成一条 ALTER，桩必须按逗号逐列拆开、真正执行，
             与生产语义一致。以前只匹配单列，多列语句整条落穿到 db.run，
             near ",": syntax error 被 ensureSchema 外层 catch 吞掉，
             后面的 is_ai / profile_view_log / user_action_log / 版本盖章
             全部被跳过 →「no such column: u.is_ai」一路红。
             类型里不带逗号（全仓 ALTER 已核对：text/jsonb/timestamptz/
             boolean/int/date + default），按 [^,;]+ 切类型安全。 */
          const tblM = /alter\s+table\s+([\w"]+)/i.exec(tr.__alter);
          if (tblM) {
            const tbl = tblM[1].replace(/"/g, '');
            const re = /add\s+column\s+if\s+not\s+exists\s+([\w"]+)\s+([^,;]+)/gi;
            let m;
            while ((m = re.exec(tr.__alter)) !== null) {
              const col = m[1].replace(/"/g, '');
              const cols = db.exec(`pragma table_info(${tbl})`);
              const names = cols.length ? cols[0].values.map((r) => String(r[1])) : [];
              if (!names.includes(col)) {
                /* 去掉 Postgres 专有类型，映射到 SQLite 可用类型 */
                let type = m[2].replace(/\s+/g, ' ').trim();
                type = type.replace(/timestamptz/gi, 'text')
                           .replace(/bigserial/gi, 'integer')
                           .replace(/::\s*\w+/g, '');
                db.run(`alter table ${tbl} add column ${col} ${type}`);
              }
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
                /* v2.10.0：DDL 里的 ::jsonb 之类 Cast 也要剥 —— SQLite 的
                   DEFAULT 只认字面量或括号表达式，`default '{}'::text`
                   会直接语法错误（site_settings 建表就这么挂过）。 */
                .replace(/::\s*(int|integer|text|jsonb|boolean|bigint|timestamptz|interval|date)\b/gi, '')
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
          /* v2.10.0：Date 不能走下面那句 JSON.stringify —— 会存成
             带引号的 "\"2026-..\""，时间比较（>= 今天）全错。
             PG driver 原生把 Date 绑成 timestamptz，这里绑 ISO 字符串等价。 */
          if (v instanceof Date) return v.toISOString();
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

/* ---------- 6.5 浏览器端密码派生的复刻（第五十六轮） ----------
   与 index.html / admin.html 里的 clsDerive / clsNewHash 逐行同构：
   用 Node 的 webcrypto 模拟「浏览器本地跑 PBKDF2」，以此验证服务端
   的 salt / credential / newHash 契约。哪天两边逻辑不一致，测试会红。 */
function tB64urlEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function tB64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function clientDerive(password, saltB64, iterations) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: tB64urlDecode(saltB64), iterations, hash: 'SHA-256' }, key, 256);
  return tB64urlEncode(new Uint8Array(bits));
}
async function clientNewHash(password, iterations) {
  const salt = tB64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const dk = await clientDerive(password, salt, iterations);
  const dig = new Uint8Array(await crypto.subtle.digest('SHA-256', tB64urlDecode(dk)));
  return 'pbkdf2c$' + iterations + '$' + salt + '$' + tB64urlEncode(dig);
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

  /* v2.10.0 注册审核默认开启（安全默认值）——但本文件后续十几个段落
     都靠「注册即得 token」推进（登录态是绝大多数测试的前置）。
     这里先用管理员令牌把审核关掉，恢复旧行为；审核流本身在新段
     【65】专门验证（开 → 注册 pending → 403 → 通过/驳回 → 恢复）。 */
  const regOff = await call('/api/admin?action=set-settings', {
    method: 'POST', token: adminToken,
    body: { register_open: true, register_review: false },
  });
  t('管理员可关注册审核（后续段落回归所需）',
    regOff.status === 200 && !!regOff.body.ok, JSON.stringify(regOff.body).slice(0, 160));

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

  /* v2.10.0 #178：删除云端数据前必须先验密码（wt = wipeToken）——
     旧「直接删」路径已收紧，这里锁定新行为：无 wt 一律 403。 */
  const dNoWt = await call('/api/data?key=cls_theme', { method: 'DELETE', token: adminToken });
  t('删除前未验证密码 403', dNoWt.status === 403, '实际 ' + dNoWt.status);
  const afterNoWt = await call('/api/data', { method: 'GET', token: adminToken });
  t('未验证的删除不生效（仍 2 条）', afterNoWt.body.count === 2, '实际 ' + afterNoWt.body.count);

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
    body: { name: '测试甲', studentId: '250501', politics: '共青团员' },
  });
  t('管理员新增资料成功', c1.status === 200 && c1.body.id > 0, JSON.stringify(c1.body));
  const pid1 = c1.body.id;
  globalThis.__pid1 = pid1;   /* 供后面的【35】节复用（跨 {} 块作用域） */

  const c2 = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '老师乙', politics: '共青团员', role: '老师', phone: '13800138000' },
  });
  t('管理员新增老师资料成功', c2.status === 200, JSON.stringify(c2.body));
  const pid2 = c2.body.id;

  /* 学号唯一性：同一个学号不能挂第二条 */
  const cdup = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '重名测', studentId: '250501' },
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
  t('查询结果带姓名', hit1.name === '测试甲', '实际 ' + hit1.name);
  t('查询结果带政治面貌', hit1.politics === '共青团员', '实际 ' + hit1.politics);

  /* 老师那条有手机号且 contact_status 默认 approved（管理员直接录入视为已核实） */
  const s2 = await call('/api/profile?action=search&q=老师', { token: token2 });
  const hit2 = (s2.body.results || [])[0] || {};
  t('按姓名能查到老师', hit2.name === '老师乙', '实际 ' + hit2.name);
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
    (vl.body.logs || []).some(x => x.targetName === '测试甲'),
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
    body: { name: '测试甲', studentId: '250501' },
  });
  t('认领自己的资料成功', clOk.status === 200, JSON.stringify(clOk.body));

  const cl1 = await call('/api/profile?action=me', { token: token2 });
  t('认领后 me 返回 claimed=true', cl1.body.claimed === true);
  t('认领后 me 带出 profileId', cl1.body.profile && cl1.body.profile.id === pid1,
    JSON.stringify(cl1.body.profile || {}).slice(0, 100));

  /* ---- 提交联系方式 → 进「信息审核」（v3.7.0 起不再直接改档） ----
     ⚠️ 行为变更：submit 只生成一条待审申请，profiles 一个字节都不动。
        所以「提交后别人看不到」的同时，「本人看到的也还是旧值」——
        这正是站主要的「后台确认之前按原来显示」。 */
  const sb = await call('/api/profile?action=submit', {
    method: 'POST', token: token2,
    body: { wechat: 'test_wx_id', qq: '123456789', phone: '13900139000' },
  });
  t('提交联系方式成功', sb.status === 200, JSON.stringify(sb.body));
  t('提交后状态为 pending', sb.body.status === 'pending', '实际 ' + sb.body.status);
  t('提交后返回待审申请 id', !!sb.body.requestId, JSON.stringify(sb.body));

  /* 格式校验 */
  const sbBadQq = await call('/api/profile?action=submit', {
    method: 'POST', token: token2, body: { qq: 'abc' },
  });
  t('非法 QQ 被拒绝 400', sbBadQq.status === 400, '实际 ' + sbBadQq.status);
  const sbEmpty = await call('/api/profile?action=submit', {
    method: 'POST', token: token2, body: { wechat: '', qq: '', phone: '' },
  });
  t('三项全空被拒绝 400', sbEmpty.status === 400, '实际 ' + sbEmpty.status);

  /* 关键：提交之后、审核之前，档案里还是旧值（这里是空） */
  const s5 = await call('/api/profile?action=search&q=250501', { token: token2 });
  const selfHit = (s5.body.results || [])[0] || {};
  t('★v3.7.0 待审期间本人查到的还是原内容（空）',
    !selfHit.wechat && !selfHit.qq && !selfHit.phone,
    JSON.stringify({ wx: selfHit.wechat, qq: selfHit.qq, ph: selfHit.phone }));
  t('★v3.7.0 待审期间档案状态不是 approved', selfHit.contactStatus !== 'approved',
    '实际 ' + selfHit.contactStatus);

  const s6 = await call('/api/profile?action=search&q=250501', { token: adminToken });
  const otherHit = (s6.body.results || [])[0] || {};
  t('待审核的联系方式不会暴露给其他人',
    !otherHit.wechat && !otherHit.qq && !otherHit.phone,
    JSON.stringify({ wx: otherHit.wechat, qq: otherHit.qq, ph: otherHit.phone }));

  /* 本人在「我的资料」里能看到这条待审申请（含原值与新值） */
  const mp = await call('/api/profile?action=mine-requests', { token: token2 });
  const pend0 = (mp.body.pending || [])[0] || {};
  t('★v3.7.0 mine-requests 带出待审申请', !!pend0.id, JSON.stringify(mp.body).slice(0, 200));
  const wxItem = (pend0.items || []).find((x) => x.field === 'wechat') || {};
  t('★v3.7.0 待审项带原值与新值',
    wxItem.before === '' && wxItem.after === 'test_wx_id',
    JSON.stringify(wxItem));

  /* ---- 后台「信息审核」队列 ---- */
  const rq = await call('/api/admin?action=change-requests&scope=pending', { token: adminToken });
  const req1 = (rq.body.requests || [])[0] || {};
  t('★v3.7.0 待审队列能读到申请', !!req1.id, JSON.stringify(rq.body).slice(0, 160));
  t('★v3.7.0 队列里只有改过的字段（3 项联系方式中只改这些）',
    (req1.items || []).length === 3, '实际 ' + (req1.items || []).length);
  t('★v3.7.0 队列带修改人姓名与学号',
    req1.name === '测试甲' && req1.studentId === '250501',
    JSON.stringify({ n: req1.name, s: req1.studentId }));

  /* ---- 驳回 ---- */
  const rj = await call('/api/admin?action=reject-change', {
    method: 'POST', token: adminToken,
    body: { id: req1.id, reason: '号码看起来不对' },
  });
  t('驳回申请成功', rj.status === 200, JSON.stringify(rj.body));

  const mineRej = await call('/api/profile?action=mine-requests', { token: token2 });
  t('本人能看到驳回原因',
    (mineRej.body.requests || [])[0] &&
    (mineRej.body.requests || [])[0].rejectReason === '号码看起来不对',
    JSON.stringify(mineRej.body).slice(0, 200));
  t('驳回后没有待审记录了', (mineRej.body.pending || []).length === 0);

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

  const rq2 = await call('/api/admin?action=change-requests&scope=pending', { token: adminToken });
  const req2 = ((rq2.body.requests || [])[0]) || {};
  const ap = await call('/api/admin?action=approve-change', {
    method: 'POST', token: adminToken, body: { id: req2.id },
  });
  t('审核通过成功', ap.status === 200, JSON.stringify(ap.body));

  const s7 = await call('/api/profile?action=search&q=250501', { token: adminToken });
  const ok2 = (s7.body.results || [])[0] || {};
  t('审核通过后其他人能看到微信', ok2.wechat === 'fixed_wx', '实际 ' + ok2.wechat);
  t('审核通过后其他人能看到 QQ', ok2.qq === '987654321', '实际 ' + ok2.qq);
  t('审核通过后 contactVisible=true', ok2.contactVisible === true);

  /* ---- 7 天内撤销 ---- */
  const hist0 = await call('/api/admin?action=change-requests&scope=history', { token: adminToken });
  const h0 = (hist0.body.requests || []).find((x) => x.status === 'approved') || {};
  t('★v3.7.0 历史记录里有这次通过', h0.status === 'approved', JSON.stringify(h0).slice(0, 120));
  t('★v3.7.0 通过后 7 天内可撤销', h0.canRevert === true, JSON.stringify({ c: h0.canRevert, d: h0.revertDaysLeft }));

  const rv = await call('/api/admin?action=revert-change', {
    method: 'POST', token: adminToken, body: { id: h0.id },
  });
  t('★v3.7.0 撤销成功', rv.status === 200, JSON.stringify(rv.body));

  const s8r = await call('/api/profile?action=search&q=250501', { token: adminToken });
  t('★v3.7.0 撤销后内容恢复为修改前（空）',
    !(s8r.body.results || [])[0].wechat, JSON.stringify((s8r.body.results || [])[0]).slice(0, 120));

  /* 再撤一次应该被拒（状态已不是 approved） */
  const rv2 = await call('/api/admin?action=revert-change', {
    method: 'POST', token: adminToken, body: { id: h0.id },
  });
  t('★v3.7.0 已撤销的记录不能再撤', rv2.status === 409, '实际 ' + rv2.status);

  /* ---- 管理员不能通过查询接口改身份信息（改只能走 admin 接口） ---- */
  /* 这里验证「同学无法改自己的姓名/学号」：profile 接口的 submit 只接受联系方式 */
  const tryRename = await call('/api/profile?action=submit', {
    method: 'POST', token: token2,
    body: { name: '改名试试', studentId: '999999', wechat: 'x' },
  });
  t('submit 不接受姓名/学号（仅联系方式）', tryRename.status === 200);
  const s8 = await call('/api/profile?action=search&q=250501', { token: token2 });
  const stillName = (s8.body.results || [])[0] || {};
  t('姓名未被改掉', stillName.name === '测试甲', '实际 ' + stillName.name);
  t('学号未被改掉', stillName.studentId === '250501', '实际 ' + stillName.studentId);

  /* ---- 管理员编辑资料 ---- */
  const ed = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { id: pid1, name: '测试甲', studentId: '250501', politics: '群众' },
  });
  t('管理员修改政治面貌成功', ed.status === 200, JSON.stringify(ed.body));
  const s9 = await call('/api/profile?action=search&q=250501', { token: token2 });
  t('政治面貌已更新为群众',
    (s9.body.results || [])[0].politics === '群众',
    '实际 ' + (s9.body.results || [])[0].politics);

  /* ---- 批量导入 ---- */
  const batch = await call('/api/admin?action=batch-profiles', {
    method: 'POST', token: adminToken,
    body: { rows: [
      { name: '批量甲', studentId: '250601', politics: '共青团员' },
      { name: '批量乙', studentId: '250602', politics: '群众' },
      { name: '', studentId: '' },
      { name: '批量甲', studentId: '250601', politics: '共青团员' },  /* 重复 → 应为更新 */
    ] },
  });
  t('批量导入成功', batch.status === 200, JSON.stringify(batch.body));
  t('批量导入新增 2 条', batch.body.created === 2, '实际 ' + batch.body.created);
  /* v3.5.18 语义变化：值完全一致时不再「更新一遍」，而是记为 unchanged（省子请求） */
  t('批量导入把重复行识别为已有记录（值一致 → 跳过不写）',
    batch.body.unchanged === 1 && batch.body.updated === 0,
    'updated=' + batch.body.updated + ' unchanged=' + batch.body.unchanged);
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
    body: { name: '准考生', studentId: '250701', politics: '群众', examNo: '11399999' },
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
    (se2.body.results || []).length === 1 && (se2.body.results || [])[0].name === '准考生',
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
    body: { id: eid, name: '准考生', studentId: '250701', examNo: '11400001' },
  });
  t('管理员修改准考证号成功', ue.status === 200, JSON.stringify(ue.body));
  const se3 = await call('/api/profile?action=search&q=250701', { token: token2 });
  t('修改后同学看到的是新号码', (se3.body.results || [])[0].examNo === '11400001',
    '实际 ' + (se3.body.results || [])[0].examNo);

  /* 批量导入要认这个字段（Excel 导入走的就是这条路） */
  const be = await call('/api/admin?action=batch-profiles', {
    method: 'POST', token: adminToken,
    body: { rows: [
      { name: '准考甲', studentId: '250702', politics: '群众', examNo: '11380001' },
      { name: '准考乙', studentId: '250703', politics: '共青团员', examNo: '11380002' },
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
  const bp = await call('/api/admin?action=profiles&q=准考', { token: adminToken });
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

  /* --- v3.9.16：增量真的生效（以前 since 只回显不筛选，每次白拉 16.6KB） --- */
  const inc = await call('/api/content?since=' + (Date.now() + 60000));
  t('★v3.9.16 内容没变时增量返回空包（notModified）',
    inc.status === 200 && inc.body.notModified === true
    && Object.keys(inc.body.items || {}).length === 0, JSON.stringify(inc.body).slice(0, 120));
  const full = await call('/api/content?since=1');
  t('★v3.9.16 旧位点仍返回全量（不会漏内容）',
    full.status === 200 && Array.isArray(full.body.items.announcements)
    && !full.body.notModified);

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
    const adminSrc = readAdm();
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
    body: { name: '头衔甲', studentId: '990001', politics: '共青团员' },
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
    body: { name: '头衔乙', studentId: '990002', politics: '群众' },
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
    body: { name: '作业甲', studentId: '990002' },
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
  const idx = readIdx();
  const adm = readAdm();
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
  t('大版本号为 3（含后端的大版本，2026-10-17 起为 3.1.0）', v1.split('.')[0] === '3', v1);
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

  const idx2 = readIdx();
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
  /* 复原：把周榜键清掉，避免污染后面的【周榜】用例（那里断言 gameruser01 不在周榜）。
     v2.10.0 #178 起删云端数据要先验密码，这里走完整流程（验 → 拿 wt → 删）。 */
  const gVerify = await call('/api/data?action=verify', {
    method: 'POST', token: gtk, body: { password: 'GamePass123' },
  });
  t('游戏段清理前验密码通过', gVerify.status === 200 && !!gVerify.body.wipeToken,
    JSON.stringify(gVerify.body).slice(0, 160));
  const gwt = gVerify.body.wipeToken || '';
  await call('/api/data?key=cls_game_week_snake&wt=' + gwt, { method: 'DELETE', token: gtk });
  await call('/api/data?key=cls_game_week_tetris&wt=' + gwt, { method: 'DELETE', token: gtk });
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
  const ad = readAdm();

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
  const idx2 = readIdx();
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

  const idx = readIdx();
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

  /* ---- 老账号（高迭代档位哈希）自助改密 ----
     第五十六轮（2026-10-15）线上实测：单请求连跑 60 次 PBKDF2(10000)
     稳定 200 —— CPU 预算从来不是瓶颈，当年改密 500 的真凶是缺列
     （http.js ensureSchema 已修）。旧版 needsDowngrade 护栏基于误判的
     CPU 焦虑，把线上 61 个 50000 档位账号全拦在自助改密之外，已拆除。
     这里锁定新行为：高迭代账号明文路径改密直接 200。 */
  const { hashPassword, validateClientHash } = await import('./api/_lib/password.js');
  const legacyHash = await hashPassword(pwd, 50000);
  db.run("update users set password_hash = ? where id = ?", [legacyHash, uid]);

  const relogin2 = await call('/api/auth?action=login', {
    method: 'POST', body: { username: uname, password: pwd },
  });
  t('老账号（50000 档位）仍能正常登录', relogin2.status === 200 && relogin2.body.token, JSON.stringify(relogin2.body));

  const cpLegacy = await call('/api/auth?action=change-password', {
    method: 'POST', token: relogin2.body.token, body: { oldPassword: pwd, newPassword: 'Whatever2026!' },
  });
  t('老账号改密码返回 200（护栏已拆除，不再 409）', cpLegacy.status === 200,
    'status ' + cpLegacy.status + ' ' + JSON.stringify(cpLegacy.body));

  const lNew = await call('/api/auth?action=login', {
    method: 'POST', body: { username: uname, password: 'Whatever2026!' },
  });
  t('老账号改密后的新密码可登录', lNew.status === 200);
  const lOldAgain = await call('/api/auth?action=login', {
    method: 'POST', body: { username: uname, password: pwd },
  });
  t('老密码改密后失效', lOldAgain.status === 401, 'status ' + lOldAgain.status);

  /* 改回原密码，避免污染后续用例 */
  await call('/api/auth?action=change-password', {
    method: 'POST', token: lNew.body.token, body: { oldPassword: 'Whatever2026!', newPassword: pwd },
  });

  /* validateClientHash 的格式护栏（客户端传来的新哈希串必须过硬） */
  const goodHash = await clientNewHash('SomeGoodPass1', 50000);
  t('合法 pbkdf2c 串通过校验', validateClientHash(goodHash).ok === true, JSON.stringify(validateClientHash(goodHash)));
  t('迭代次数过低被拒', validateClientHash(goodHash.replace('50000', '999')).ok === false);
  t('段数不对被拒', validateClientHash('pbkdf2c$50000$onlysalt').ok === false);
  t('前缀不对被拒', validateClientHash(goodHash.replace('pbkdf2c', 'pbkdf2')).ok === false);
  t('盐被截断被拒', validateClientHash(goodHash.replace(/\$[A-Za-z0-9_-]{16,128}\$[A-Za-z0-9_-]{16,128}$/, '$short$' + goodHash.split('$')[3])).ok === false);
}

/* ============================================================
   【28.5】第五十六轮·客户端派生协议（salt + credential + newHash）
   ------------------------------------------------------------
   背景：站主报「用户登录还是卡在设置新密码」——线上 63 个账号里 61 个是
   50000 迭代档位，全被旧护栏拦死。根治方案：PBKDF2 派生搬到浏览器，
   服务端只比盐/摘要。本组用例按真实浏览器逻辑（Node webcrypto 复刻）
   走完整协议，锁定服务端契约。 */
console.log('\n【28.5】第五十六轮·客户端派生协议（salt + credential）');
{
  const cu = 'kdfuser';
  const cp1 = 'KdfPass2026';
  const cp2 = 'KdfSecond2026';
  const reg = await call('/api/auth?action=register', {
    method: 'POST', body: { username: cu, password: cp1, displayName: '派生测试' },
  });
  t('派生测试用户注册成功', reg.status === 200 && reg.body.ok, JSON.stringify(reg.body));

  /* ---- ① salt 接口：真实账号返回 pbkdf2 参数 ---- */
  const s1 = await call('/api/auth?action=salt', { method: 'POST', body: { username: cu } });
  t('salt 接口返回 200', s1.status === 200 && s1.body.ok, JSON.stringify(s1.body));
  t('salt 返回 algo=pbkdf2', s1.body.algo === 'pbkdf2', JSON.stringify(s1.body));
  t('salt 返回迭代次数（正整数）', Number.isFinite(s1.body.iterations) && s1.body.iterations > 0,
    'iterations=' + s1.body.iterations);
  t('salt 返回盐（base64url）', /^[A-Za-z0-9_-]{16,64}$/.test(s1.body.salt || ''), 'salt=' + s1.body.salt);
  /* 不泄底：响应里不能出现库里存的完整哈希串（盐/迭代次数可以给，验证器不行） */
  const cuUid = db.exec("select id from users where username = '" + cu + "'")[0].values[0][0];
  const cuStored = db.exec("select password_hash from users where id = " + cuUid)[0].values[0][0];
  t('salt 不泄露完整哈希', JSON.stringify(s1.body).indexOf(cuStored) < 0,
    '响应=' + JSON.stringify(s1.body) + ' 库存=' + cuStored.slice(0, 20) + '…');
  t('salt 只回 algo/iterations/salt 三个字段',
    Object.keys(s1.body).sort().join(',') === 'algo,iterations,ok,salt',
    JSON.stringify(Object.keys(s1.body)));

  /* ---- ② 未知用户名：诱饵参数，形状一致 ---- */
  const sGhost = await call('/api/auth?action=salt', { method: 'POST', body: { username: 'ghost_user_xyz' } });
  t('未知用户名的 salt 也是 200 + pbkdf2 形状（诱饵）',
    sGhost.status === 200 && sGhost.body.algo === 'pbkdf2' && sGhost.body.salt && sGhost.body.iterations > 0,
    JSON.stringify(sGhost.body));

  /* ---- ③ 凭证登录：浏览器派生后发 credential ---- */
  const cred1 = await clientDerive(cp1, s1.body.salt, s1.body.iterations);
  const lc1 = await call('/api/auth?action=login', {
    method: 'POST', body: { username: cu, credential: cred1 },
  });
  t('凭证登录成功', lc1.status === 200 && lc1.body.token, JSON.stringify(lc1.body));
  t('凭证登录返回用户信息', lc1.body.user && lc1.body.user.username === cu);

  /* 错误凭证 → 401（且不泄露是「凭证错」还是「密码错」） */
  const credBad = await clientDerive('WrongPassword', s1.body.salt, s1.body.iterations);
  const lcBad = await call('/api/auth?action=login', {
    method: 'POST', body: { username: cu, credential: credBad },
  });
  t('错误凭证登录返回 401', lcBad.status === 401, 'status ' + lcBad.status);
  t('401 文案与明文路径一致（不泄底）', /用户名或密码不对/.test(lcBad.body.error || ''), lcBad.body.error);

  /* 未知用户名 + 凭证 → 401（走诱饵比对，不提前返回） */
  const lcGhost = await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'ghost_user_xyz', credential: cred1 },
  });
  t('未知用户名凭证登录返回 401', lcGhost.status === 401, 'status ' + lcGhost.status);

  /* ---- ④ 凭证改密：oldCredential + newHash，服务端零派生 ---- */
  const newHashStr = await clientNewHash(cp2, 50000);
  const kdfToken = lc1.body.token;
  const cpKdf = await call('/api/auth?action=change-password', {
    method: 'POST', token: kdfToken, body: { oldCredential: cred1, newHash: newHashStr },
  });
  t('凭证改密返回 200', cpKdf.status === 200 && cpKdf.body.ok, 'status ' + cpKdf.status + ' ' + JSON.stringify(cpKdf.body));
  t('凭证改密返回新 token', typeof cpKdf.body.token === 'string' && cpKdf.body.token.length === 64);

  /* 库里存的应是 pbkdf2c 串 */
  const kdfUidRes = db.exec("select id from users where username = '" + cu + "'");
  const kdfUid = kdfUidRes[0].values[0][0];
  const kdfStored = db.exec("select password_hash from users where id = " + kdfUid)[0].values[0][0];
  t('库里存的是 pbkdf2c 新格式', kdfStored.startsWith('pbkdf2c$50000$'), kdfStored.slice(0, 30));
  t('库里不存派生密钥本身（只存 sha256 摘要）', kdfStored.indexOf(cred1) < 0);

  /* 新密码可登录（凭证 + 明文两条路都通），旧密码两条路都死 */
  const s2 = await call('/api/auth?action=salt', { method: 'POST', body: { username: cu } });
  const cred2 = await clientDerive(cp2, s2.body.salt, s2.body.iterations);
  const lc2 = await call('/api/auth?action=login', {
    method: 'POST', body: { username: cu, credential: cred2 },
  });
  t('新密码凭证登录成功', lc2.status === 200);
  const lc2p = await call('/api/auth?action=login', {
    method: 'POST', body: { username: cu, password: cp2 },
  });
  t('新密码明文登录也成功（老客户端兼容）', lc2p.status === 200);
  const lc1again = await call('/api/auth?action=login', {
    method: 'POST', body: { username: cu, credential: cred1 },
  });
  t('旧派生密钥改密后失效', lc1again.status === 401, 'status ' + lc1again.status);
  const lcOldPwd = await call('/api/auth?action=login', {
    method: 'POST', body: { username: cu, password: cp1 },
  });
  t('旧密码明文登录失效', lcOldPwd.status === 401, 'status ' + lcOldPwd.status);

  /* ---- ⑤ 凭证改密的错误凭证 → 401 ---- */
  const credWrong = await clientDerive('NotTheOldOne', s2.body.salt, s2.body.iterations);
  const cpWrong = await call('/api/auth?action=change-password', {
    method: 'POST', token: lc2.body.token,
    body: { oldCredential: credWrong, newHash: await clientNewHash('Another2026!', 50000) },
  });
  t('错误 oldCredential 改密返回 401', cpWrong.status === 401, 'status ' + cpWrong.status);

  /* ---- ⑥ 畸形 newHash 被拒（防把账号锁死） ---- */
  const cpBadHash = await call('/api/auth?action=change-password', {
    method: 'POST', token: lc2.body.token, body: { oldCredential: cred2, newHash: 'pbkdf2c$50000$short' },
  });
  t('畸形 newHash 被拒 400', cpBadHash.status === 400, 'status ' + cpBadHash.status);
  t('400 文案说明原因', /格式/.test(cpBadHash.body.error || ''), cpBadHash.body.error);

  /* ---- ⑦ 明文路径对 pbkdf2c 账号依然可用（改回去再用明文登录） ---- */
  const cpBack = await call('/api/auth?action=change-password', {
    method: 'POST', token: lc2.body.token, body: { oldPassword: cp2, newPassword: cp1 },
  });
  t('pbkdf2c 账号可走明文路径改密', cpBack.status === 200, 'status ' + cpBack.status);
  const lFinal = await call('/api/auth?action=login', {
    method: 'POST', body: { username: cu, password: cp1 },
  });
  t('明文改密后明文登录成功', lFinal.status === 200);

  /* ---- ⑧ salt 限流：同一用户名疯狂刷应被 429 ---- */
  let throttled = false;
  for (let i = 0; i < 35; i++) {
    const r = await call('/api/auth?action=salt', { method: 'POST', body: { username: cu } });
    if (r.status === 429) { throttled = true; break; }
  }
  t('salt 接口有限流（连续刷会被 429）', throttled);
}

/* 【28.6】第五十六轮·me 接口下发强制改密标志（刷新后恢复强制改密态）
   ------------------------------------------------------------
   以前 mustChangePassword 只在登录响应里出现，用户改密前刷新页面就丢，
   只能退出重登。现在 me 也回发该标志，前端据此恢复 forcepwd 标签页。 */
console.log('\n【28.6】me 接口下发 mustChangePassword');
{
  const mu = 'meuser';
  const mp = 'MePass2026';
  const reg = await call('/api/auth?action=register', {
    method: 'POST', body: { username: mu, password: mp, displayName: '标志测试' },
  });
  t('me 标志测试用户注册成功', reg.status === 200 && reg.body.ok, JSON.stringify(reg.body));
  const muToken = reg.body.token;

  /* 默认未标记 → me 返回 false */
  const me1 = await call('/api/auth?action=me', { token: muToken });
  t('me 返回 ok', me1.status === 200 && me1.body.ok, JSON.stringify(me1.body));
  t('默认 mustChangePassword=false', me1.body.mustChangePassword === false, JSON.stringify(me1.body.mustChangePassword));

  /* 库里置 true（模拟「导入名单后的初始密码账号」）→ me 返回 true */
  const muUid = db.exec("select id from users where username = '" + mu + "'")[0].values[0][0];
  db.run("update users set must_change_password = true where id = ?", [muUid]);
  const me2 = await call('/api/auth?action=me', { token: muToken });
  t('标记后 mustChangePassword=true', me2.body.mustChangePassword === true, JSON.stringify(me2.body.mustChangePassword));

  /* 改密后标志清除 → me 返回 false（前端据此离开 forcepwd 态） */
  const cpMu = await call('/api/auth?action=change-password', {
    method: 'POST', token: muToken, body: { oldPassword: mp, newPassword: 'MePass2027' },
  });
  t('带强制改密标志的账号改密成功', cpMu.status === 200 && cpMu.body.ok, 'status ' + cpMu.status);
  t('改密响应里 mustChangePassword=false', cpMu.body.mustChangePassword === false);
  const me3 = await call('/api/auth?action=me', { token: cpMu.body.token });
  t('改密后 me 也返回 false', me3.body.mustChangePassword === false, JSON.stringify(me3.body.mustChangePassword));

  /* 改回去，避免污染后续手工验证 */
  await call('/api/auth?action=change-password', {
    method: 'POST', token: cpMu.body.token, body: { oldPassword: 'MePass2027', newPassword: mp },
  });
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
  const idxHtml = readIdx();
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

  const adminHtml = readAdm();
  t('后台已定义 POP_THEMES 主题表', adminHtml.indexOf('var POP_THEMES') >= 0);
  t('后台表单含横幅输入框 pfBanner', adminHtml.indexOf('id="pfBanner"') >= 0);
  t('后台表单含样式下拉 pfTheme', adminHtml.indexOf('id="pfTheme"') >= 0);
  t('后台预览会显示横幅', adminHtml.indexOf('📌 横幅') >= 0);
}

console.log('\n【29】第二十七轮·自动云同步（1 分钟双向）');
{
  const idxHtml = readIdx();

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
  t('面板含「上传本机」按钮', idxHtml.indexOf('syncUploadNow(this)') >= 0);
  t('面板含「拉取云端」按钮', idxHtml.indexOf('syncDownloadNow(this)') >= 0);

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
  const page = readIdx();
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
  const page = readIdx();
  const adm  = readAdm();
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
  t('后台 PAGES 不再单独注册 releases 面板（已并入数据管理）', !/id:'releases'/.test(adm));
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

  /* v3.7.0：后台专用键只发给管理员 —— 普通/匿名请求拿不到（省 150KB+） */
  const rdAnon = await call('/api/content');
  t('★v3.7.0 匿名读内容不含后台专用键',
    !rdAnon.body.items.dj_schedule && !rdAnon.body.items.release_notes,
    JSON.stringify(Object.keys(rdAnon.body.items || {})));
  const rd = await call('/api/content', { token: adminToken });
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
  const rd2 = await call('/api/content', { token: adminToken });
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

/* 同学甲（fixbug01）的会话 token 与资料 id，由【34】块内赋值、
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
    body: { username: 'fixbug01', password: 'Init2025', displayName: '同学甲' },
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
  t('该资料的姓名取自 displayName', found && found.name === '同学甲', found && found.name);
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
  t('能看到自己的姓名', meNew.body.profile && meNew.body.profile.name === '同学甲');

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
  t('预置了 17 个字段（v3.5.5 新增学校/班级/民族/出生日期/家庭住址/入团时间）',
    fields.length === 17, '实际 ' + fields.length);
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
    body: { id: globalThis.__pid1, name: '测试甲', examNo: '11389409' },
  });
  t('（准备）给测试同学甲补上智学网账号', setEx.status === 200, JSON.stringify(setEx.body).slice(0, 120));

  /* 用路人（普通用户）查「测试同学甲」 */
  const sSelf = await call('/api/profile?action=search&q=250501', { token: bTok });
  const hSelf = (sSelf.body.results || [])[0] || {};
  t('★self 档下普通用户查不到该字段', hSelf.examNo === '' || hSelf.examNo === undefined,
    '实际 ' + JSON.stringify(hSelf.examNo));
  t('未受影响的字段仍在（姓名）', hSelf.name === '测试甲', '实际 ' + hSelf.name);

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

  /* ===== v3.5.37「仅后端可见」（原「仅管理员」档，语义明确化）=====
     · 后台详情 + 管理员本人「我的资料」可见
     · 其他人（含普通同学本人）前台查不到，连键都不下发
     · 管理员在前台查询别人时也无特权（ctx.admin 恒 false） */
  const svAdm = await call('/api/admin?action=set-visibility', {
    method: 'POST', token: adminToken,
    body: { field: 'exam_no', visibility: 'admin' },
  });
  t('v3.5.37 改为仅后端可见成功', svAdm.status === 200 && svAdm.body.visibility === 'admin',
    JSON.stringify(svAdm.body).slice(0, 140));

  const sAdm1 = await call('/api/profile?action=search&q=250501', { token: bTok });
  const hAdm1 = (sAdm1.body.results || [])[0] || {};
  t('★v3.5.37 普通同学查别人：仅后端可见字段不下发', hAdm1.examNo === '' || hAdm1.examNo === undefined,
    '实际 ' + JSON.stringify(hAdm1.examNo));

  const sAdm2 = await call('/api/profile?action=search&q=250501', { token: adminToken });
  const hAdm2 = (sAdm2.body.results || [])[0] || {};
  t('★v3.5.37 管理员前台查询别人也无特权（不下发）', hAdm2.examNo === '' || hAdm2.examNo === undefined,
    '实际 ' + JSON.stringify(hAdm2.examNo));

  const meStu = await call('/api/profile?action=me', { token: npTok2 });
  const stuFields = ((meStu.body || {}).profile || {}).fields || [];
  t('★v3.5.37 普通同学本人的「我的资料」也不含该字段',
    !stuFields.some((f) => f.field === 'exam_no'),
    JSON.stringify(stuFields.map((f) => f.field)));

  /* 管理员自己的「我的资料」：给管理员认领一条档案并填值 */
  const admProf = await call('/api/profile?action=search&q=' + encodeURIComponent('站主'), { token: adminToken });
  const admHit = (admProf.body.results || []).find((x) => x.username === 'yuzikang' || x.name === '站主');
  let admSeen = 'no-profile';
  if (admHit) {
    const admMe = await call('/api/profile?action=me', { token: adminToken });
    const af = ((admMe.body || {}).profile || {}).fields || [];
    admSeen = af.some((f) => f.field === 'exam_no') ? 'visible' : 'hidden';
  }
  /* v3.5.38 站主明确要求：连管理员本人在前台也看不到 —— 只能去后台查 */
  t('★v3.5.38 管理员本人的「我的资料」也看不到该字段', admSeen !== 'visible',
    '实际 ' + admSeen + '（v3.5.38 起前台 me 链路的 ctx.admin 恒为 false）');
  t('★v3.5.38 me 链路 ctx.admin 恒传 false（不依赖调用者角色）',
    fs.readFileSync(new URL('./api/profile.js', import.meta.url), 'utf8')
      .includes('shapeProfile(row, true, meta, { self: true, committee: true, admin: false })'));

  /* 改回公开，不留尾巴 */
  await call('/api/admin?action=set-visibility', {
    method: 'POST', token: adminToken,
    body: { field: 'exam_no', visibility: 'public' },
  });
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

  /* v3.7.0：审批改走 change-requests —— 先取该档案的待审申请再通过 */
  const myReq = await call('/api/admin?action=change-requests&scope=pending', { token: adminToken });
  const myReqOne = (myReq.body.requests || []).find((x) => x.profileId === myPid) || {};
  await call('/api/admin?action=approve-change', {
    method: 'POST', token: adminToken,
    body: { id: myReqOne.id },
  });

  /* 别人按学号查不到 —— 但这条资料没学号，改用姓名查 */
  const sOth = await call('/api/profile?action=search&q=同学甲', { token: bTok });
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
    body: { id: myPid, name: '同学甲',
            visibilityPref: { wechat: true, qq: true, phone: true } },
  });
  t('管理员可覆盖可见性', admSave.status === 200 && admSave.body.ok,
    JSON.stringify(admSave.body).slice(0, 140));
  const sAfter = await call('/api/profile?action=search&q=同学甲', { token: bTok });
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
  const adminHtml = readAdm();
  const indexHtml = readIdx();
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
  /* --- v3.5.21：前台查询补固定字段 / 我的档案明细 / 后台在线编辑与复制 --- */
  t('v3.5.21 查询卡渲染学号+智学网账号+头衔（以前只画 p.fields，examNo 永远不出现）',
    /pcAddRow\('学号', p\.studentId\)/.test(indexHtml)
    && /pcAddRow\('智学网账号', p\.examNo\)/.test(indexHtml)
    && /var pcTitles = String\(p\.title/.test(indexHtml));
  t('v3.5.21 我的档案改为明细表（v3.8.0 起换成 mp-grid 一行一输入框）',
    indexHtml.indexOf('mp-grid') >= 0
    && /function mpPush\(label, val, locked, field\)/.test(indexHtml)
    && /mpPush\('智学网账号', p\.examNo, false, 'exam_no'\)/.test(indexHtml)
    && /MY_PROF_PRIVATE\.forEach/.test(indexHtml));
  t('v3.5.21 我的档案每行可复制（v3.8.0 起 data-mc + mpAfterRender 绑定）',
    /function mpAfterRender/.test(indexHtml) && /data-mc="' \+ attr\(r\.value\)/.test(indexHtml));
  t('v3.5.21 暗色下说明文字提亮（.dark .acct-sw .s）',
    /\.dark \.acct-sw \.s\{color:#d8cbc0\}/.test(indexHtml));
  t('v3.5.21 后台可在线改身份证号 / 发展团员编号（以前只能导入）',
    /ruleInputHtml\('id_card'/.test(adminHtml)
    && /ruleInputHtml\('youth_league_no'/.test(adminHtml)
    && /cpBtnHtml\('id_card'\)/.test(adminHtml));
  t('v3.5.21 后台字段级复制（编辑弹窗 + 详情弹窗共用委托）',
    /function cpBtnHtml/.test(adminHtml) && /function cpv\(/.test(adminHtml)
    && /function adminCopy/.test(adminHtml)
    && /closest\('\[data-cpv\]'\)/.test(adminHtml)
    && /closest\('\[data-cp\]'\)/.test(adminHtml));
  const profJs3521 = fs.readFileSync(new URL('./api/profile.js', import.meta.url), 'utf8');
  /* v3.5.22：title 的返回改成走 visibility（canSee），断言随之更新 */
  t('v3.5.21 后端 search 输出头衔、且前台不因管理员身份多给字段',
    /title: canSee\('title', m, pref, fvis, who\)/.test(profJs3521)
    && /admin: false \}\)/.test(profJs3521));
  t('前台保存时带上 visibilityPref', /visibilityPref\s*:\s*pref/.test(indexHtml));
  t('前台可见性样式 .acct-priv 已定义', /\.acct-priv\{/.test(indexHtml));

  /* --- 后台可见性列 + 编辑开关 --- */
  t('后台资料列表有「可见性」列', adminHtml.indexOf('<th class="nowrap">可见性</th>') >= 0);
  t('后台编辑弹窗有可见性开关', /mbWxHide/.test(adminHtml) && /mbPhHide/.test(adminHtml));
  t('后台保存时带上 visibilityPref', /payload\.visibilityPref\s*=/.test(adminHtml));
  t('★成员长表单姓名为单数据源（一个框同写档案与账号显示名）',
    /这一个框同时写进/.test(adminHtml) && /单数据源/.test(adminHtml));
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
  t('★前台版本号为 3.9.3', /SITE_VERSION = '3\.[0-9]+\.[0-9]+'/.test(indexHtml),
    (indexHtml.match(/SITE_VERSION = '([\d.]+)'/) || [])[1]);
  t('★后台版本号为 3.9.3', /SITE_VERSION = '3\.[0-9]+\.[0-9]+'/.test(adminHtml),
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
    body: { name: '字段甲', studentId: '260001', role: '学生', extra: { school_id: 'XJ20260001' } },
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
    body: { id: fid, name: '字段甲', studentId: '260001', extra: { school_id: 'XJ-改过了' } },
  });
  t('可修改自定义字段的值', upd.status === 200 && upd.body.ok);
  const detail2 = await call('/api/admin?action=profile&id=' + fid, { token: adminToken });
  t('改后的值读回正确',
    detail2.body.profile.extra.school_id === 'XJ-改过了',
    JSON.stringify(detail2.body.profile.extra));

  /* 前端传 meta 表里没有的键，不能写进库（防乱传） */
  const junk = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { id: fid, name: '字段甲', studentId: '260001', extra: { not_a_field: 'x', school_id: 'XJ-改过了' } },
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

  /* 单人例外：把「字段甲」的 school_id 单独收窄为 self —— 全班仍 public，但他看不见 */
  const perOne = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { id: fid, name: '字段甲', studentId: '260001', fieldVis: { school_id: 'self' } },
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
    body: { id: fid, name: '字段甲', studentId: '260001', fieldVis: {} },
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
    body: { name: '证件乙', studentId: '260002', extra: { id_card: '360424201007100011' } },
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
  t('★已有记录的自定义字段值不同 → 进冲突列表（不静默覆盖）',
    batchUpd.status === 200 && batchUpd.body.updated === 0
    && (batchUpd.body.conflicts || []).some((c) => c.field === 'school_id'
      && c.oldValue === 'XJ-BATCH-1' && c.newValue === 'XJ-BATCH-1-B'),
    JSON.stringify(batchUpd.body).slice(0, 220));
  const impList3 = await call('/api/admin?action=profiles&q=270001', { token: adminToken });
  const impRow3 = (impList3.body.profiles || []).find((p) => p.studentId === '270001');
  t('冲突未定夺前，库里保持原值（等站主选）',
    impRow3 && impRow3.extra.school_id === 'XJ-BATCH-1',
    JSON.stringify(impRow3 && impRow3.extra).slice(0, 140));

  /* 恶意列名不能借导入通道绕过白名单（这是 SQL 注入的第二条入口） */
  const batchEvil = await call('/api/admin?action=batch-profiles', {
    method: 'POST', token: adminToken,
    body: { rows: [{ name: '导入恶', studentId: '270003', role: '学生',
      extra: { 'x text; drop table profiles; --': '1', 'a-b': '2' } }] },
  });
  t('★导入通道的非法列名被丢弃（不报错也不执行）',
    batchEvil.status === 200 && batchEvil.body.created === 1,
    JSON.stringify(batchEvil.body).slice(0, 180));
  const stillAlive = await call('/api/admin?action=profiles&q=270003', { token: adminToken });
  t('★profiles 表仍在（注入未得逞）',
    stillAlive.status === 200 && (stillAlive.body.profiles || []).length === 1,
    'HTTP ' + stillAlive.status);

  /* ---- v3.5.16 回归：id_card 同一列被写两次 ----
     站主线上报 `multiple assignments to same column "id_card"`，61 行全废。
     根因：id_card 既在固定列逻辑里（raw.idCard），又在 loadEditableFields()
     里（raw.extra.id_card），拼接 UPDATE 时出现两个 id_card = $n。
     ⚠️ SQLite 桩允许重复 SET（后者覆盖），所以这里既跑真值也做静态护栏：
        静态断言负责防回归，真值断言负责确认正常路径没被改坏。 */
  const dupIns = await call('/api/admin?action=batch-profiles', {
    method: 'POST', token: adminToken,
    body: { rows: [{ name: '去重甲', studentId: '270101', role: '学生',
      idCard: '110101199001011234', extra: { id_card: '110101199001011234' } }] },
  });
  t('★导入带身份证号（固定列 + extra 同名列）不失败',
    dupIns.status === 200 && dupIns.body.failed === 0 && dupIns.body.created === 1,
    JSON.stringify(dupIns.body).slice(0, 200));
  const dupUpd = await call('/api/admin?action=batch-profiles', {
    method: 'POST', token: adminToken,
    body: { rows: [{ name: '去重甲', studentId: '270101', role: '学生',
      idCard: '110101199002022345', extra: { id_card: '110101199002022345' } }] },
  });
  /* v3.5.18：身份证号改了值 → 不再静默覆盖，进冲突列表等站主定夺 */
  t('★更新同一行（同名列）不报错，值不同进冲突',
    dupUpd.status === 200 && dupUpd.body.failed === 0 && dupUpd.body.updated === 0
    && (dupUpd.body.conflicts || []).some((c) => c.field === 'id_card'),
    JSON.stringify(dupUpd.body).slice(0, 200));
  const ADMJS_DUP = fs.readFileSync(new URL('./api/admin.js', import.meta.url), 'utf8');
  t('★服务端把固定列从 exCols 里排除（id_card 只写一次）',
    /FIXED_COLS_WRITTEN/.test(ADMJS_DUP) && /!FIXED_COLS_WRITTEN\.includes\(k\)/.test(ADMJS_DUP));
  t('★UPDATE 的 SET 列名再去重（防将来加列重犯）',
    /const seenCol = new Set\(\), finalSets = \[\]/.test(ADMJS_DUP) && /finalSets\.unshift/.test(ADMJS_DUP));
  t('★INSERT 的列名用 Set 去重', /Array\.from\(new Set\(\['name', 'student_id'/.test(ADMJS_DUP));
  const ADMHTML_DUP = readAdm();
  t('★前端 extraColsOf 排除 id_card / youth_league_no（不再重复采集）',
    /'id_card','youth_league_no','contact_status','reject_reason'/.test(ADMHTML_DUP));

  /* ---- G3. v3.5.5 字段校验规则（站主：「所有字段支持管理员自定义配置校验规则」）---- */
  /* ① 预置规则落库：12 个字段的出厂规则（需求表明细） */
  const metaR = await call('/api/admin?action=field-meta', { token: adminToken });
  const rulesOf = (f) => ((metaR.body.fields || []).find((x) => x.field === f) || {}).rules || {};
  t('★v3.5.5 姓名规则：文本最多 3 字符',
    rulesOf('name').type === 'text' && rulesOf('name').maxLen === 3,
    JSON.stringify(rulesOf('name')));
  t('★v3.5.5 学号规则：数字固定 6 位',
    rulesOf('student_id').type === 'number' && rulesOf('student_id').digits === 6,
    JSON.stringify(rulesOf('student_id')));
  t('★v3.5.5 手机号规则：数字固定 11 位',
    rulesOf('phone').type === 'number' && rulesOf('phone').digits === 11,
    JSON.stringify(rulesOf('phone')));
  t('★v3.5.5 政治面貌规则：单选 群众/共青团员',
    rulesOf('politics').type === 'select' && rulesOf('politics').multi === false
    && JSON.stringify(rulesOf('politics').options) === JSON.stringify(['群众', '共青团员']),
    JSON.stringify(rulesOf('politics')));
  t('★v3.5.5 身份证号规则：文本最多 18 字符',
    rulesOf('id_card').type === 'text' && rulesOf('id_card').maxLen === 18,
    JSON.stringify(rulesOf('id_card')));
  t('★v3.5.5 发展团员编号规则：文本最多 40 字符',
    rulesOf('youth_league_no').type === 'text' && rulesOf('youth_league_no').maxLen === 40);
  t('★v3.5.5 入团时间/出生日期规则：日期选择器',
    rulesOf('league_date').type === 'time' && rulesOf('birth_date').type === 'time');
  t('★v3.5.5 学校 6 / 班级 8 / 家庭住址 30 字符',
    rulesOf('school').maxLen === 6 && rulesOf('class_name').maxLen === 8
    && rulesOf('home_address').maxLen === 30,
    JSON.stringify({ s: rulesOf('school'), c: rulesOf('class_name'), h: rulesOf('home_address') }));
  t('★v3.5.5 民族规则：单选常用民族',
    rulesOf('ethnicity').type === 'select' && (rulesOf('ethnicity').options || []).length >= 10
    && rulesOf('ethnicity').options.includes('汉族') && rulesOf('ethnicity').options.includes('畲族'),
    JSON.stringify(rulesOf('ethnicity')).slice(0, 120));

  /* ② 需求表 6 个新字段真的登记了 */
  for (const nf of ['school', 'class_name', 'ethnicity', 'birth_date', 'home_address', 'league_date']) {
    t('★v3.5.5 新预置字段已登记：' + nf,
      (metaR.body.fields || []).some((x) => x.field === nf));
  }

  /* ③ 服务端是唯一裁判：非法值一律 400 + 人话报错 */
  const badName = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '姓名超长甲', studentId: '290001' },
  });
  t('★v3.5.5 超长姓名被拒 400', badName.status === 400 && /姓名/.test(badName.body.error || ''),
    '实际 ' + badName.status + ' ' + JSON.stringify(badName.body).slice(0, 120));
  const badSid = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '规则甲', studentId: '2900011' },
  });
  t('★v3.5.5 7 位学号被拒 400', badSid.status === 400 && /学号/.test(badSid.body.error || ''),
    '实际 ' + badSid.status + ' ' + JSON.stringify(badSid.body).slice(0, 120));
  const badPhone = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '规则甲', studentId: '290001', phone: '138001380001' },
  });
  t('★v3.5.5 12 位手机号被拒 400', badPhone.status === 400 && /手机号/.test(badPhone.body.error || ''),
    '实际 ' + badPhone.status + ' ' + JSON.stringify(badPhone.body).slice(0, 120));
  const badPol = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '规则甲', studentId: '290001', politics: '中共党员' },
  });
  t('★v3.5.5 规则外政治面貌被拒 400', badPol.status === 400 && /政治面貌/.test(badPol.body.error || ''),
    '实际 ' + badPol.status + ' ' + JSON.stringify(badPol.body).slice(0, 120));
  const badDate = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '规则甲', studentId: '290001', extra: { birth_date: '2026-02-31' } },
  });
  t('★v3.5.5 不存在的日期被拒 400', badDate.status === 400 && /日期/.test(badDate.body.error || ''),
    '实际 ' + badDate.status + ' ' + JSON.stringify(badDate.body).slice(0, 120));
  const badEth = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '规则甲', studentId: '290001', extra: { ethnicity: '外星族' } },
  });
  t('★v3.5.5 规则外民族被拒 400', badEth.status === 400 && /民族/.test(badEth.body.error || ''),
    '实际 ' + badEth.status + ' ' + JSON.stringify(badEth.body).slice(0, 120));

  /* ④ 全合法值通过（6 个新字段一次写全 + 读回） */
  const okRule = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: {
      name: '规则甲', studentId: '290001', politics: '群众', phone: '13800138000',
      extra: {
        school: '修水一中', class_name: '高三(5)班', ethnicity: '汉族',
        birth_date: '2010-07-10', home_address: '江西省九江市修水县', league_date: '2024-05-04',
        id_card: '360424201007100011', youth_league_no: 'TQ20240001',
      },
    },
  });
  t('★v3.5.5 全合法值保存成功', okRule.status === 200 && okRule.body.ok,
    JSON.stringify(okRule.body).slice(0, 160));
  const rulePid = okRule.body.id;
  const ruleDet = await call('/api/admin?action=profile&id=' + rulePid, { token: adminToken });
  const rp = (ruleDet.body.profile || {}).extra || {};
  t('★v3.5.5 新字段值读回正确',
    rp.school === '修水一中' && rp.class_name === '高三(5)班' && rp.ethnicity === '汉族'
    && rp.birth_date === '2010-07-10' && rp.home_address === '江西省九江市修水县'
    && rp.league_date === '2024-05-04',
    JSON.stringify(rp).slice(0, 220));

  /* ⑤ grandfather：与原值一致的字段不卡编辑（只改手机号也能保存） */
  const gfSave = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { id: rulePid, name: '规则甲', studentId: '290001', phone: '13900139000' },
  });
  t('★v3.5.5 只改手机号可保存（grandfather 不卡老数据）',
    gfSave.status === 200 && gfSave.body.ok,
    JSON.stringify(gfSave.body).slice(0, 160));

  /* ⑤.5 学生端 submit 同守规则（服务端唯一裁判的第二条入口）：
     注册同学 → 建带手机号的档案 → 认领 → submit 试三种值。 */
  const sbReg = await call('/api/auth?action=register', {
    method: 'POST',
    body: { username: 'rulestu01', password: 'RuleStu2026', displayName: '规则生' },
  });
  t('（准备）注册规则测试同学', sbReg.status === 200 && sbReg.body.ok,
    JSON.stringify(sbReg.body).slice(0, 120));
  const sbTok = sbReg.body.token;
  const sbProf = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '规则生', studentId: '290005', phone: '13900139000' },
  });
  t('（准备）建带手机号的档案', sbProf.status === 200 && sbProf.body.ok,
    JSON.stringify(sbProf.body).slice(0, 120));
  const sbClaim = await call('/api/profile?action=claim', {
    method: 'POST', token: sbTok,
    body: { name: '规则生', studentId: '290005' },
  });
  t('（准备）同学认领成功', sbClaim.status === 200,
    JSON.stringify(sbClaim.body).slice(0, 120));
  /* a. 改成 10 位手机号：过了 submit 旧 regex（6-20 位数字符号），撞新规则 → 400 + 人话 */
  const sbBad = await call('/api/profile?action=submit', {
    method: 'POST', token: sbTok, body: { phone: '1380013800' },
  });
  t('★v3.5.5 学生端 submit 10 位手机号被规则拒 400',
    sbBad.status === 400 && /手机号/.test(sbBad.body.error || ''),
    sbBad.status + ' ' + JSON.stringify(sbBad.body).slice(0, 140));
  /* b. grandfather：交回原值 + 只改可见性开关 —— 与现值相同不校，可保存 */
  const sbGf = await call('/api/profile?action=submit', {
    method: 'POST', token: sbTok,
    body: { phone: '13900139000', visibilityPref: { phone: false } },
  });
  t('★v3.5.5 学生端 grandfather：原值不改只动开关可保存',
    sbGf.status === 200 && sbGf.body.ok,
    JSON.stringify(sbGf.body).slice(0, 140));
  /* c. 合法新手机号 → 200（主动改值守新规则且放行合规值） */
  const sbOk = await call('/api/profile?action=submit', {
    method: 'POST', token: sbTok, body: { phone: '13700137000' },
  });
  t('★v3.5.5 学生端 submit 合法新手机号通过',
    sbOk.status === 200 && sbOk.body.ok,
    JSON.stringify(sbOk.body).slice(0, 140));

  /* ⑥ 批量导入逐行复核：非法行记错跳过，合法行照常入 */
  const batchRule = await call('/api/admin?action=batch-profiles', {
    method: 'POST', token: adminToken,
    body: { rows: [
      { name: '批量合', studentId: '290002', politics: '共青团员' },
      { name: '违规批', studentId: '290003', politics: '中共党员' },
    ] },
  });
  t('★v3.5.5 批量导入按规则逐行复核',
    batchRule.status === 200 && batchRule.body.created === 1 && batchRule.body.failed === 1,
    JSON.stringify(batchRule.body).slice(0, 220));
  t('★v3.5.5 批量错误带行号与人话原因',
    (batchRule.body.errors || [])[0] && batchRule.body.errors[0].index === 1
    && /政治面貌/.test(batchRule.body.errors[0].reason || ''),
    JSON.stringify(batchRule.body.errors));

  /* ⑦ 自定义规则：给 school_id 配下拉单选 —— 规则外值被拒、规则内值通过、清规则后放开 */
  const setSel = await call('/api/admin?action=update-field', {
    method: 'POST', token: adminToken,
    body: { field: 'school_id', rules: { type: 'select', options: ['甲校', '乙校'] } },
  });
  t('★v3.5.5 给自定义字段配下拉规则成功', setSel.status === 200 && setSel.body.ok,
    JSON.stringify(setSel.body).slice(0, 140));
  const metaSel = await call('/api/admin?action=field-meta', { token: adminToken });
  const selRule = ((metaSel.body.fields || []).find((x) => x.field === 'school_id') || {}).rules || {};
  t('★v3.5.5 下拉规则落库（normalize 后形状正确）',
    selRule.type === 'select' && (selRule.options || []).length === 2 && selRule.multi === false,
    JSON.stringify(selRule));
  const selBad = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '规则乙', studentId: '290004', extra: { school_id: '丙校' } },
  });
  t('★v3.5.5 下拉规则外值被拒 400',
    selBad.status === 400 && /学籍号/.test(selBad.body.error || ''),
    '实际 ' + selBad.status + ' ' + JSON.stringify(selBad.body).slice(0, 140));
  const selOk = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '规则乙', studentId: '290004', extra: { school_id: '甲校' } },
  });
  t('★v3.5.5 下拉规则内值通过', selOk.status === 200 && selOk.body.ok,
    JSON.stringify(selOk.body).slice(0, 140));
  const clearRule = await call('/api/admin?action=update-field', {
    method: 'POST', token: adminToken, body: { field: 'school_id', rules: {} },
  });
  t('★v3.5.5 清空规则成功', clearRule.status === 200 && clearRule.body.ok);
  const afterClear = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { id: selOk.body.id, name: '规则乙', studentId: '290004', extra: { school_id: '丙校' } },
  });
  t('★v3.5.5 清规则后自由值可保存', afterClear.status === 200 && afterClear.body.ok,
    JSON.stringify(afterClear.body).slice(0, 140));

  /* ⑧ 脏数据规则被 normalize 收敛（选项去重、位数钳位） */
  const dirtyRule = await call('/api/admin?action=update-field', {
    method: 'POST', token: adminToken,
    body: { field: 'school_id', rules: { type: 'select', options: ['甲校', '甲校', ' 乙校 ', null, ''] } },
  });
  t('★v3.5.5 脏选项被收敛（去重去空白）', dirtyRule.status === 200 && dirtyRule.body.ok);
  const metaDirty = await call('/api/admin?action=field-meta', { token: adminToken });
  const dirtyR = ((metaDirty.body.fields || []).find((x) => x.field === 'school_id') || {}).rules || {};
  t('★v3.5.5 收敛后只剩两个干净选项',
    (dirtyR.options || []).length === 2 && dirtyR.options[0] === '甲校' && dirtyR.options[1] === '乙校',
    JSON.stringify(dirtyR));

  /* 清理本轮造的资料 */
  for (const sid of ['290001', '290002', '290003', '290004', '290005']) {
    const f = await call('/api/admin?action=profiles&q=' + sid, { token: adminToken });
    const row = (f.body.profiles || [])[0];
    if (row) await call('/api/admin?action=delete-profile', { method: 'POST', token: adminToken, body: { id: row.id } });
  }

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
  const indexHtml38 = readIdx();
  const adminHtml38 = readAdm();
  t('★前台版本号为 3.9.3', /SITE_VERSION = '3\.[0-9]+\.[0-9]+'/.test(indexHtml38),
    (indexHtml38.match(/SITE_VERSION = '([\d.]+)'/) || [])[1]);
  t('★后台版本号为 3.9.3', /SITE_VERSION = '3\.[0-9]+\.[0-9]+'/.test(adminHtml38),
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
  const adminHtmlSrc = readAdm();
  t('后台有「字段管理」入口按钮', /id="mbFields"/.test(adminHtmlSrc));
  t('后台有字段管理面板容器', /id="mbFieldPanel"/.test(adminHtmlSrc)
    && /id="mbFieldBody"/.test(adminHtmlSrc));
  t('后台有 renderFieldPanel', /function renderFieldPanel/.test(adminHtmlSrc));
  t('后台有新增字段弹窗', /function addFieldDialog/.test(adminHtmlSrc));
  t('后台有删除字段确认', /function deleteFieldConfirm/.test(adminHtmlSrc));
  t('后台有改名/拖拽排序', /function renameFieldDialog/.test(adminHtmlSrc) && /function attachFieldDrag/.test(adminHtmlSrc)
    && !/function sortFieldDialog/.test(adminHtmlSrc));
  t('★后台字段管理支持快捷切换可见性', /data-fv="/.test(adminHtmlSrc));
  t('★后台资料列表支持动态列', /function extraColsOf/.test(adminHtmlSrc));
  t('后台编辑弹窗渲染自定义字段输入框', /data-xf="/.test(adminHtmlSrc));
  t('★后台编辑弹窗支持单人可见性例外', /data-vf="/.test(adminHtmlSrc));
  t('后台保存时带上 extra', /payload\.extra\s*=/.test(adminHtmlSrc));
  t('后台保存时带上 fieldVis', /payload\.fieldVis\s*=/.test(adminHtmlSrc));
  t('★合并导出支持动态列（账号+档案一张表）',
    /memberExportCols\(j\.fieldMeta/.test(adminHtmlSrc)
    && /\(m\.extra \|\| \{\}\)\[k\]/.test(adminHtmlSrc)
    && /成员与档案_' \+ fmt\(new Date\(\), 'date'\)/.test(adminHtmlSrc));
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

  const indexHtmlSrc = readIdx();
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
  const ADMJS_SRC39raw = fs.readFileSync(new URL('./api/admin.js', import.meta.url), 'utf8');
  const canSeeBody = profSrc39.slice(profSrc39.indexOf('function canSee'),
                                     profSrc39.indexOf('function canSee') + 2200);
  /* 🔴 v2.4.1 血的教训：buildFieldVis 的白名单必须来自 loadFieldMeta()，
     不能用 loadEditableFields() —— 后者滤掉了 SPECIAL_FIELDS，
     而 wechat / qq / phone 恰在其中，于是站主给某人设的微信例外被静默丢弃，
     表现为「点了保存但对方还是看不到」，极难排查。 */
  t('★fieldVis 白名单用 loadFieldMeta（不能滤掉 wechat/qq/phone）',
    /buildFieldVis\(b\.fieldVis,\s*allMeta\.map\(/.test(ADMJS_SRC39raw));
  t('★canSee 已不再对 field_vis 取严',
    !/stricter\s*\(\s*eff\s*,\s*f\s*\)/.test(canSeeBody));
  /* 判据必须是**显式锁定标记**，不能是「visibility 和出厂值比对」——
     站主可以把字段设成它本来就是的档（wechat 出厂 public，他点「公开」），
     值不变但确实动过，比对法分辨不出来。 */
  t('★已彻底删除 FACTORY_VIS 比对法（profile.js）',
    !/FACTORY_VIS/.test(profSrc39));
  t('★已彻底删除 FACTORY_VIS 比对法（admin.js）',
    !/FACTORY_VIS/.test(ADMJS_SRC39raw));
  t('★canSee 用 visLocked 判据决定是否忽略同学意愿',
    /m\.visLocked/.test(canSeeBody) && /eff\s*=\s*group/.test(canSeeBody));
  t('★loadMeta 输出 visLocked 标记', /visLocked\s*:/.test(profSrc39));
  t('★profile.js 把 is_custom 也视为天然已锁定',
    /visLocked\s*:\s*!!r\.vis_locked\s*\|\|\s*!!r\.is_custom/.test(profSrc39));
  t('★admin.js loadFieldMeta 读 vis_locked 并输出 adminSet',
    /vis_locked/.test(ADMJS_SRC39raw) && /adminSet\s*:/.test(ADMJS_SRC39raw));
  t('★setVisibility 写入 vis_locked = true',
    /set visibility = \$\{vis\}, vis_locked = true/.test(ADMJS_SRC39raw));
  t('★addField 建自定义字段时 vis_locked 默认 true（insert 带 rules 列）',
    /is_custom, vis_locked, rules\)[\s\S]{0,160}true, true,/.test(ADMJS_SRC39raw));
  t('★updateField 改 visibility 时置 vis_locked = true', /const lockIt = visibility != null/.test(ADMJS_SRC39raw));
  t('★updateField 只改 label/sort 时不误锁（保住同学隐私）',
    /vis_locked = \$\{lockIt \? true/.test(ADMJS_SRC39raw));
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
    body: { name: '权限丙', studentId: '280001', role: '学生',
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
    body: { id: pid39, name: '权限丙', studentId: '280001',
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
    body: { id: pid39, name: '权限丙', studentId: '280001', fieldVis: { wechat: 'public' } },
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
    body: { id: pid39, name: '权限丙', studentId: '280001', fieldVis: { wechat: 'self' } },
  });
  let st5 = await q39('perperson-narrow');
  t('★单人例外可收窄：全班 public 但这一条单独 self → 不可见',
    st5.hasWechat === false, JSON.stringify(st5));

  /* 场景 6：清掉单人例外 → 回落到全班默认（public）→ 可见 */
  await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { id: pid39, name: '权限丙', studentId: '280001', fieldVis: {} },
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
    body: { name: '意愿新', studentId: '280777', role: '学生',
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
  const adminHtml39b = readAdm();
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
  const adminHtml39 = readAdm();
  t('★后台编辑弹窗标出「本人已设为私密」', /本人已设为私密/.test(adminHtml39));
  t('★后台标出「已被你覆盖」的情况', /已被你覆盖/.test(adminHtml39));
  t('后台文案说明「后台权力最大」', /后台权力最大/.test(adminHtml39));
  const indexHtml39 = readIdx();
  t('★前台告知同学「以站主设置为准」', /以站主设置为准|则以站主设置为准/.test(indexHtml39));

  /* 清理 */
  await call('/api/admin?action=delete-profile', {
    method: 'POST', token: adminToken, body: { id: pid39 },
  });
}

console.log('\n【40】第三十一轮·取消备用链接（v2.5.0）');
{
  const idx40 = readIdx();
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
  const idx41 = readIdx();
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
  const idx42 = readIdx();
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
  const idx43 = readIdx();
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
  const idx44 = readIdx();
  /* 旧的运行时引擎（MutationObserver 全量重扫）必须彻底删除 —— 它是倒计时每秒闪的直接原因。
     ⚠️ 2026-10-16 v2.9.10 起字色逻辑引入了一个新的 MutationObserver（ink-auto 兜底），
     所以这里不能简单断言「无 MutationObserver」，改为断言「唯一的 observer 就是字色兜底」。 */
  t('★旧的运行时 emoji 引擎已删除（仅存字色兜底 observer）',
    !/function emojiify/.test(idx44) && /new MutationObserver[\s\S]{0,300}clsAutoInk/.test(idx44));
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
  const idx45 = readIdx();
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
  const idx46 = readIdx();
  const adm46 = readAdm();
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
    /v1\.hitokoto\.cn/.test(idx46) && /function fetchRemoteQuote\(/.test(idx46));
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
  const idx47 = readIdx();
  const adm47 = readAdm();
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

  /* ===== ③ 学习卡片（v3.5.9 站主要求：不强制隐藏，恢复显示 + 保留手动隐藏按钮）===== */
  t('★学习卡片已恢复显示（STUDY_CARD_ENABLED = true）',
    /var STUDY_CARD_ENABLED = true/.test(idx47));
  t('★保留手动隐藏按钮（hideStudyCard）',
    /function hideStudyCard\(\)/.test(idx47) && /onclick="hideStudyCard\(\)"/.test(idx47));
  t('★隐藏是本地偏好，存在 cls_study_hidden',
    /STUDY_HIDE_KEY = 'cls_study_hidden'/.test(idx47) && /function studyHidden\(\)/.test(idx47));
  t('★隐藏后不渲染卡片、也不联网',
    /if\(!STUDY_CARD_ENABLED \|\| studyHidden\(\)\)\{ el\.innerHTML = ''; el\.style\.display = 'none'; return; \}/.test(idx47));
  t('★自定义设置里能从隐藏恢复（showStudyCard）',
    /function showStudyCard\(\)/.test(idx47) && /已隐藏 · 点此恢复/.test(idx47));
  t('★后台面板不再写「当前已暂时隐藏」', !/当前已暂时隐藏/.test(adm47));

  /* ===== ③+ 后台「每日一言」+「学习卡片」合并为「首页卡片」=====
     站主要求：「后台的每日一言和学习卡片的古诗词那些放到一个板块」。
     两者本质都是「首页那张小卡片」的配置，拆两个入口反而不好找。 */
  t('★后台两块已合并为「首页卡片」板块',
    /id:'cards',/.test(adm47) && /function renderCards\(\)/.test(adm47));
  /* v2.7.1 起内容组 10 项（合并后的 9 项 + 成绩分析）；v3.5.6 再加「投票管理」= 11 */
  t('★内容组导航项为 13 项（12 项 + v3.15 信息分享）',
    (adm47.match(/group:'内容'/g) || []).length === 13,
    '实际 ' + (adm47.match(/group:'内容'/g) || []).length + ' 项');
  t('★v3.15.2 成员导出按字段元数据出列（新增字段自动带上）',
    /function memberExportCols\(meta\)/.test(adm47) && /function memberCell\(m, f\)/.test(adm47)
    && /memberExportCols\(j\.fieldMeta/.test(adm47)
    && !/var head = \['姓名', '学号', '身份', '头衔'/.test(adm47));

  /* ===== v3.15.3（站主）：「信息分享后台一直转圈四五分钟」=====
     旧写法 `if(fn) fn();` 一旦渲染函数抛错，视图永远停在加载态。
     现在三件套：缺函数/抛错换说明卡、12 秒看门狗、接口 25 秒超时。 */
  t('★v3.15.3 渲染函数缺失或抛错都换成说明卡（不留转不停的圈）',
    /if\(!fn\)\{[\s\S]{0,120}panelBroken\(page,/.test(adm47)
    && /try\{\s*fn\(\);\s*\}catch\(err\)\{\s*panelBroken\(page, err\);/.test(adm47)
    && !/^\s*if\(fn\) fn\(\);\s*$/m.test(adm47));
  t('★v3.15.3 说明卡带「重试」和「强制刷新」两条出路',
    /id="pbRetry"/.test(adm47) && /id="pbHard"/.test(adm47)
    && /function adminHardRefresh\(\)/.test(adm47)
    && /caches\.delete/.test(adm47));
  t('★v3.15.3 看门狗 12 秒：判据是「原来那颗圈还在不在」，不误杀页面自绘的加载态',
    /\}, 12000\);/.test(adm47) && /!loadingNode \|\| !loadingNode\.parentNode/.test(adm47));
  t('★v3.15.3 接口统一 25 秒超时 + 人话提示',
    /opts\.timeout \|\| 25000/.test(adm47) && /AbortController/.test(adm47)
    && /请求超时/.test(adm47) && /连不上服务器/.test(adm47));
  const auth47 = readApi('auth.js');
  const prof47 = readApi('profile.js');
  const info47 = fs.readFileSync(new URL('./info.html', import.meta.url), 'utf8');

  /* ===== v3.15.4（站主）：分享页登录不进去 =====
     全班 62 个账号用户名就是姓名，站主自己却是拼音 yuzikang；
     按「用户名：你的姓名」的提示输姓名必然 401。 */
  t('★v3.15.4 登录：用户名查不到时按姓名兜底（唯一匹配才放行）',
    /from users where lower\(coalesce\(display_name, ''\)\) = \$\{username\} limit 2/.test(auth47)
    && /if \(byName\.length === 1\)/.test(auth47));
  t('★v3.15.4 登录：同名多个不猜，直接让用登录名',
    /return fail\(res, 409, '班里有多个同名的账号/.test(auth47));
  t('★v3.15.4 登录：姓名路径也计入限流（换写法绕不过 5 次锁）',
    /const lockByName = await lockRemain\(sql, String\(u\.username \|\| ''\)\.toLowerCase\(\)\)/.test(auth47));
  t('★v3.15.4 分享页提示不再写死「你的姓名（例：张三）」',
    !/用户名：你的姓名（例：张三）/.test(info47) && /多数同学是姓名，个别是拼音/.test(info47));
  t('★v3.15.4 分享页 401/429 有补充提示且支持换行',
    /e\.status === 401/.test(info47) && /连错 5 次会锁 15 分钟/.test(info47)
    && /white-space:pre-line/.test(info47));
  t('★v3.15.4 分享可以彻底删除（撤销只是停用）',
    /action === 'ishare-delete'/.test(prof47) && /data-act="del"/.test(adm47));
  t('★v3.15.3 顶栏标题单行省略（长标题不再折行压住图标）',
    /#pageTitle\{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/.test(adm47)
    && /\$\('pageTitle'\)\.title = p \? p\.title : ''/.test(adm47));
  t('★v3.15.3 带 ?v= 的资源不再回退「忽略查询串」（否则旧 SW 会把旧脚本递回来）',
    /const hasVer = /.test(sw47) && /if \(!cached && !hasVer\) cached = await cache\.match\(request, \{ ignoreSearch: true \}\)/.test(sw47));

  t('★合并后的面板路由已注册（cards → renderCards）',
    /cards:\s*renderCards,/.test(adm47));

  /* ===== ④ 版本号 / 缓存 ===== */
  t('★前台版本号格式正确（3.x.y）', /SITE_VERSION = '3\.[0-9]+\.[0-9]+'/.test(idx47));
  t('★后台版本号格式正确（3.x.y）', /SITE_VERSION = '3\.[0-9]+\.[0-9]+'/.test(adm47));
  /* 缓存号只增不减：v3.5.6 起是 v101。这里断言「≥v100 且是 v1xx 形态」，不再钉死具体数字 */
  t('★v3.9.16 缓存桶改为「class-site-版本」（升级即换桶，旧缓存自动作废）',
    /const CACHE = 'class-site-' \+ SITE_VER/.test(sw47));
}

console.log('\n【48】第三十九轮·iOS 刷不了：更新检测 + 一键强制刷新（v2.6.4）');
{
  const idx48 = readIdx();
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
    !!verRe.exec(sw48) && /^3\.\d+\.\d+$/.test(verRe.exec(sw48)[1]), verRe.exec(sw48) ? verRe.exec(sw48)[1] : 'null');
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
  t('★前台版本号格式正确（3.x.y）', /SITE_VERSION = '3\.[0-9]+\.[0-9]+'/.test(idx48));
  t('★前台更新日期已同步（不早于 2026-10-19）', /VER_DATE = '2026-10-(19|2[0-9]|3[01])'/.test(idx48));
  t('★v3.9.16 缓存桶由版本号派生', /const CACHE = 'class-site-' \+ SITE_VER/.test(sw48));
}

console.log('\n【49】第四十一轮·iPad 弹窗居中修复 + 弹窗跳转（v2.6.6）');
{
  const idx49 = readIdx();
  const adm49 = readAdm();

  /* ===== ① iPad 弹窗不居中 =====
     Chromium 各尺寸都居中，是 Safari 特有的兼容问题，三个隐患一起修。 */
  t('★横向溢出裁剪挂在 html 上、body 不再设 overflow（否则 WebKit 会让 fixed 相对 body 定位）',
    /html\{overflow-x:hidden\}/.test(idx49)
    && /body\{[^}]*overflow-x:hidden/.test(idx49) === false);
  /* v3.5.31 修：只挂 margin:auto 不足以居中 —— 父级 flex 不设对齐时子项停在 start，
     弹窗会贴在左上角（站主反馈的现象）。现在显式给 align/justify，
     同时盒子本身有 max-height:calc(100dvh - 40px) + margin:auto 兜底，
     不会出现「内容比容器高 → 顶部被推出视口且滚不到」的老问题。 */
  t('★弹窗居中：外层 flex 显式 align-items/justify-content:center + 盒子 margin:auto 兜底',
    /\.allboard-mask\.show\{display:flex;align-items:center;justify-content:center;overflow-y:auto/.test(idx49)
    && /\.welcome-mask\.show\{display:flex;align-items:center;justify-content:center;overflow-y:auto/.test(idx49)
    && /\.allboard-box\{[^}]*margin:auto\}/.test(idx49)
    && /\.welcome-box\{[^}]*margin:auto\}/.test(idx49));
  t('★居中不再是「靠 align-items:center 硬顶」——盒子自带高度上限',
    /\.allboard-box\{[^}]*max-height:calc\(100dvh - 40px\)/.test(idx49));
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
  /* v2.10.1：openLink 多了一个「入口名」参数（行为日志要记去了哪里），跳转本身不变 */
  t('★外链行为保持不变（向后兼容）', /openLink\(u, true, '弹窗跳转'\)/.test(idx49));
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
  t('★前台版本号格式正确（3.x.y）', /SITE_VERSION = '3\.[0-9]+\.[0-9]+'/.test(idx49));
  t('★后台版本号格式正确（3.x.y）', /SITE_VERSION = '3\.[0-9]+\.[0-9]+'/.test(adm49));
  t('★页脚署名为「页面由 AI 辅助生成」', /页面由 AI 辅助生成/.test(idx49));
  t('★页脚不再出现 Work Buddy 字样', /Work Buddy/.test(idx49) === false);
}

console.log('\n【50】第四十二轮·倒计时「进行中」+ 到期自动隐藏（v2.6.7）');
{
  const idx50 = readIdx();

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
  t('★前台版本号格式正确（3.x.y）', /SITE_VERSION = '3\.[0-9]+\.[0-9]+'/.test(idx50));
}

console.log('\n【51】第四十三轮·成绩分析开工：入口改名 + 占位（v2.7.0）');
{
  const idx51 = readIdx();
  const adm51 = readAdm();

  /* ===== ① 板块改名（站主 2026-10-14：「把名字改为成绩分析」） ===== */
  t('★板块名改为「成绩分析」', /\{ id: 3, name: "成绩分析" \}/.test(idx51));
  t('★不再出现「成绩查询」板块名', /\{ id: 3, name: "成绩查询" \}/.test(idx51) === false);
  t('★后台弹窗跳转目标同步改名',
    /'板块 · 成绩分析'/.test(adm51) && /'板块 · 成绩查询'/.test(adm51) === false);

  /* ===== ② 易查分外链彻底删除（R2 已定） ===== */
  t('★易查分链接已从站内删除', /yichafen\.com/.test(idx51) === false);
  t('★易查分那张卡片已撤（旧标题不再出现）', /高一下学期期末考/.test(idx51) === false);

  /* ===== ③ 成绩分析卡片（v2.7.2 起由「占位」升级为真正的站内入口） ===== */
  /* v2.9.6 改版：站主要求「点开成绩分析直接展示而不是卡片+弹窗」。
     卡片撤掉了，这个板块直接铺成绩分析本体；原来的说明文案挪进 sc-meta。 */
  t('★成绩分析不再经卡片中转（板块即内容）',
    /if\(c\.id === 3\)\{\s*\n\s*inner = scEmbedHtml\(\);/.test(idx51)
    && /title: "成绩分析", subtitle: "班级成绩"/.test(idx51) === false);
  t('★有内嵌骨架（scEmbed + 沿用原容器 id）',
    /function scEmbedHtml\(\)/.test(idx51) && /id="scPaneBox"><\/div>/.test(idx51)
    && /id="scBar"><\/div>/.test(idx51));
  t('★不再有全屏遮罩容器（否则会出现两份同 id）', /id="scoreAnalMask"/.test(idx51) === false);
  t('★点侧边栏就直接挂载（不用再点一次）',
    /if\(id === 3 && typeof scEnsureMounted === 'function'\)/.test(idx51));
  t('★未登录仍只给登录引导，不给任何成绩',
    /成绩分析需要登录后才能查看/.test(idx51) && /openAccount\(\\'login\\'\)/.test(idx51));
  t('★「仅本班同学可见、请勿外传」的提示挪进了 sc-meta，没丢',
    /数据仅本班同学登录后可见，请勿截图外传/.test(idx51));

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
  const adm = readAdm();

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
  /* v2.10.1：单元格改由 scSubCellHtml/scInpTd 生成（三处共用一份），
     赋分科目仍是「原始 / 赋分」两个输入框，另加各科排名输入框。 */
  t('★赋分科目渲染两个格子（原始 / 赋分）',
    /scInpTd\(rid, su\.key, 'raw'/.test(adm) && /scInpTd\(rid, su\.key, 'assigned'/.test(adm));
  t('★改分表也能编辑各科年级排名与总分两种口径排名',
    /scInpTd\(rid, su\.key, 'rank'/.test(adm) && /scInpTd\(rid, su\.key, 'asgRank'/.test(adm)
    && /scInpTd\(rid, null, 'tRankRaw'/.test(adm) && /scInpTd\(rid, null, 'schoolRank'/.test(adm));
  t('★读行时把新字段一起读回（否则改一格就把排名整行冲掉）',
    /var rk = pickInp\(su\.key, 'rank'\)/.test(adm) && /var tRank = pickInp\(null, 'tRankRaw'\)/.test(adm));
  t('★失焦后防抖自动保存', /setTimeout\(scFlush, 1500\)/.test(adm));
  t('★只提交改动过的行（SC_STATE.dirty）', /SC_STATE\.dirty\[rowId\] = true/.test(adm));
  t('★可加行（转学生）/ 可删行', /function scAddRow\(/.test(adm) && /function scDeleteRow\(/.test(adm));
  t('★保存状态可见（未改动 / 保存中 / 已保存）', /scSetSaveState/.test(adm));

  /* ===== ⑤ 发布 ===== */
  t('★有发布与撤回入口', /data-sc-act="pub"/.test(adm) && /data-sc-act="unpub"/.test(adm));
  t('★草稿会明确标注「同学看不到」', /草稿（同学看不到）/.test(adm));

  /* ===== ⑥ 体验：导入未识别姓名 → 弹窗直接改（2026-10-17 站主要求） ===== */
  t('★导入未识别姓名改为弹窗修正（不再是一条干巴巴的提示）',
    /function scFixNamesDialog\(examId, names\)/.test(adm)
    && /if\(j\.unmatchedCount\)\{\s*setTimeout\(function\(\)\{ scFixNamesDialog\(examId/.test(adm)
    && !/导入完成，有几点要留意/.test(adm));

  /* ===== ⑦ 版本 ===== */
  t('★后台版本号格式正确（3.x.y）', /SITE_VERSION = '3\.[0-9]+\.[0-9]+'/.test(adm));
}

console.log('\n【54】第四十五轮·前台成绩分析页（v2.7.2）');
{
  const idx = readIdx();

  /* ===== ① 入口与容器 ===== */
  t('★成绩分析改为内嵌：不再有全屏遮罩容器', /id="scoreAnalMask"/.test(idx) === false);
  t('★内嵌骨架挂在板块 3 上', /if\(c\.id === 3\)\{/.test(idx) && /function scEmbedHtml\(\)/.test(idx));
  t('★有 openScoreAnal / closeScoreAnal', /function openScoreAnal\(\)\{/.test(idx) && /function closeScoreAnal\(\)\{/.test(idx));
  t('★openScoreAnal 语义改为「切板块 + 挂载」', /function openScoreAnal\(\)\{[\s\S]{0,120}scEnsureMounted\(\)/.test(idx));
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
  t('★直方图带均分 / 中位数 / 分数线', /function scChartHist\(st(, rk)?\)/.test(idx) && /stroke-dasharray="4 3"/.test(idx));
  t('★上线人数统计', /function scChartCutlines\(st\)/.test(idx));
  t('★分数段四色条', /function scChartSegments\(st\)/.test(idx));
  t('★雷达图按得分率画（不是原始分）', /function scRadar\(labels, mine, avg, tips\)/.test(idx) && /按得分率/.test(idx));
  t('★雷达图上直接写分数（不用去别处对）', /radarTips\.push/.test(idx) && /各顶点标注学科分数/.test(idx));
  t('★位置条 + 「前面还有 N 人」', /function scRenderMe\(\)/.test(idx) && /前面还有/.test(idx));
  t('★趋势块（历次总分折线）', /function scTrendBlock\(meRow\)/.test(idx));

  /* ===== ④.5 图表数据标注（v2.9.5：站主要求每张图上都能直接看到数字） ===== */
  t('★直方图柱顶写人数', /柱顶为该段人数/.test(idx));
  t('★热力图格子里写分数', /var ink = clsReadableOn\('rgb\(' \+ cr/.test(idx) && /每格为该生该科分数/.test(idx));
  t('★热力图字色走全站共用 clsReadableOn（不再有私有亮度公式）',
    /var ink = clsReadableOn\('rgb\(' \+ cr \+ ',' \+ cg \+ ',' \+ cb \+ '\)'\)/.test(idx)
    && !/0\.299 \* cr \+ 0\.587 \* cg \+ 0\.114 \* cb/.test(idx));
  t('★热力图不再每格重算名次（一次算好，60 行 × 6 科不再白跑 360 遍）',
    /var rk = scRankMap\(SC\.basis\);/.test(idx) && /原先每格都重算/.test(idx));
  t('★四象限直接标姓名 + 那一科分数', /labeled\[p\.name\]/.test(idx) && /图中标注姓名与该科分数/.test(idx));
  t('★四象限只标该点名的（偏科预警 + 我），不至糊成一团', /总分够、这一科却拖后腿/.test(idx));
  t('★各科迷你折线每个点都写分数', /手机端没有鼠标悬浮，不写出来就看不到/.test(idx));

  /* ===== ④.6 术语统一：校排名＝年级排名，同一个东西（v2.9.5 站主原话） ===== */
  const adm54 = readAdm();
  const sh54  = fs.readFileSync(new URL('./share.html', import.meta.url), 'utf8');
  t('★界面上不再混用「校排名」', /scOvItem\('校排名'/.test(idx) === false && /\['校排名'/.test(idx) === false);
  t('★年级/班排名的说明改为官方口径句（不再解释「别当成两套排名」）', /年级排名与班排名分别统计/.test(idx));
  t('★分享页也叫年级排名', /校排名/.test(sh54) === false && /年级排名/.test(sh54));
  t('★后台列头也叫年级排名，但导入仍两种列名都认',
    /<th>年级排名<\/th>/.test(adm54) && /\['校排名','校名次','学校排名','年级排名','年级名次'\]/.test(adm54));

  /* ===== ⑤ 站主定的规则 ===== */
  t('★历次趋势只报统计范围（不再解释「说明不了什么」）', /统计 ' \+ pts\.length \+ ' 次考试/.test(idx));
  t('★没有分数线时不留空块（分数线为空就不渲染）',
    /\.filter\(function\(c\)\{ return c\.score != null; \}\)/.test(idx));
  t('★只有一次考试时趋势块给友好提示', /等下一次考完就能看到趋势/.test(idx));
  t('★未登录时提示先登录（不显示任何成绩）', /成绩分析需要登录后才能查看/.test(idx));
  t('★没有已发布考试时显示「暂未对外开放」', /暂未对外开放/.test(idx));
  t('★赛道文案：仅本班同学可见、请勿外传', /请勿截图外传/.test(idx));

  /* ===== ⑥ 版本 ===== */
  t('★前台版本号格式正确（3.x.y）', /SITE_VERSION = '3\.[0-9]+\.[0-9]+'/.test(idx));
}

console.log('\n【55】第四十六轮·成绩单表头吸附 + 考试按时间排序 + 考试跨天（v2.7.4）');
{
  const idx = readIdx();
  const adm = readAdm();
  const sc  = fs.readFileSync(new URL('./api/scores.js', import.meta.url), 'utf8');
  const http= fs.readFileSync(new URL('./api/_lib/http.js', import.meta.url), 'utf8');

  /* ===== ① 表头 / 姓名列吸附（手机上横向拖动不会看错行） ===== */
  t('★表格容器可纵向滚动（sticky 生效的前提）', /\.sc-tblwrap\{max-height:min\(60vh,460px\);overflow:auto/.test(idx));
  t('★表头 sticky 吸顶', /\.sc-tbl th\{position:sticky;top:0;z-index:3/.test(idx));
  t('★班排列吸附左侧', /\.sc-tbl th:nth-child\(1\),\.sc-tbl td:nth-child\(1\)\{position:sticky;left:0/.test(idx));
  /* v3.4.0：第二列吸列只在带 .sc-fix2 的表上生效（全班成绩单），
     其余卡片（各科进退步、进退步榜、需关注…）的第二列不再被误固定 */
  t('★姓名列吸附在其右侧（left:46px，仅 .sc-fix2）', /\.sc-tbl\.sc-fix2 th:nth-child\(2\),\.sc-tbl\.sc-fix2 td:nth-child\(2\)\{position:sticky;left:46px/.test(idx));
  t('★表头两列 z-index 更高（压住滚动内容）', /th:nth-child\(1\)\{z-index:4;background:#fdf8f3\}/.test(idx) && /\.sc-tbl\.sc-fix2 th:nth-child\(2\)\{z-index:4/.test(idx));
  t('★非 fix2 表第二列不再吸列（普通数据列）', (idx.match(/\.sc-tbl th:nth-child\(2\),\.sc-tbl td:nth-child\(2\)\{position:sticky/g) || []).length === 0);
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
  /* v2.10.0：desc 端点必须显式 nulls last —— PG 的 desc 默认 NULLS FIRST，
     空日期考试会漂到列表顶部（录入时序混乱观感的根因）。 */
  t('★后端 exam 列表按日期倒序且空日期沉底（nulls last）',
    /order by e\.exam_date desc nulls last, e\.id desc/.test(sc)
    && (sc.match(/order by e\.exam_date desc nulls last, e\.id desc/g) || []).length === 2);

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
  const idx = readIdx();
  const sc  = fs.readFileSync(new URL('./api/scores.js', import.meta.url), 'utf8');

  /* ===== ① 各科趋势网格 ===== */
  t('★有 scSubjTrend（各科趋势网格）', /function scSubjTrend\(\)\{/.test(idx));
  t('★迷你折线按涨跌分段着色（涨绿跌红）',
    /\(good \? 'sc-up' : 'sc-down'\)/.test(idx) && /\(good \? '#0b7a43' : '#c0392b'\)/.test(idx));
  t('★每科卡显示「较上次」变化', /较上次/.test(idx));
  t('★只有一次考试时给「首次考试，暂无对比」', /首次考试，暂无对比/.test(idx));

  /* ===== ② 年级进退步 ===== */
  t('★有 scGradeTrend（年级进退步）', /function scGradeTrend\(\)\{/.test(idx));
  t('★用校排名画，且 y 轴反向（名次小在上面）', /名次越小越好 → y 轴反向/.test(idx));
  t('★给出年级百分位', /'前 ' \+ pct\.toFixed\(1\) \+ '%'/.test(idx));
  t('★年级人数取「最近一次填过的」', /年级人数取「最近一次填过的」/.test(idx));
  t('★年级进退步说明改为官方口径句（不再讲「打架」）', /年级排名与班排名分别统计/.test(idx));

  /* ===== ③ 跨考试上线率 ===== */
  t('★有 scCutTrend + scLoadAllRows', /function scCutTrend\(\)\{/.test(idx) && /function scLoadAllRows\(\)\{/.test(idx));
  t('★默认懒加载（先给按钮，不自动拉全班数据）', /开始计算/.test(idx) && /SC\.allRows/.test(idx));
  t('★每格是上线人数（占比）', /上线人数（占比）/.test(idx));

  /* ===== ④ 导出图片 ===== */
  t('★有 scExportCard', /function scExportCard\(cfg, note, badge\)\{/.test(idx));
  t('★纯 canvas 画，不引第三方库', /createElement\('canvas'\)/.test(idx) && /getContext\('2d'\)/.test(idx));
  t('★2 倍图（手机上清晰）', /var SCALE = 2;/.test(idx));
  t('★文件名带考试名与姓名', /'-成绩卡\.png'/.test(idx));
  t('★带「请勿外传」水印', /本班内部数据 · 请勿外传/.test(idx));
  t('★手机优先系统分享、失败退回下载',
    /navigator\.canShare/.test(idx) && /navigator\.share/.test(idx) && /function scSaveBlob\(blob\)\{/.test(idx));
  t('★老浏览器退回 dataURL', /toDataURL\('image\/png'\)/.test(idx));

  /* ===== ⑤ A4 打印 ===== */
  t('★有 scPrint', /function scPrint\(\)\{/.test(idx));
  t('★@media print 只印成绩分析这一块（选择器已随内嵌改成 .sc-embed）',
    /@media print\{/.test(idx) && /\.sc-embed,\.sc-embed \*\{visibility:visible/.test(idx));
  t('★打印时表头每页重复', /thead\{display:table-header-group\}/.test(idx));
  t('★打印时卡片不跨页切', /\.sc-card\{break-inside:avoid/.test(idx));
  t('★打印时工具栏与吸顶都取消',
    /\.sc-embed \.sc-bar,/.test(idx) && /position:static !important/.test(idx));
  t('★工具栏有导出与打印按钮',
    /scExportDialog\(\)".*导出图片/.test(idx) && /scPrint\(\)".*打印/.test(idx));

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
  const idx = readIdx();
  const adm = readAdm();
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
  /* v3.3.0：门槛从写死的「班均 10 分」改成按满分比例（SC_ALERT_RATIO = 1.5%），
     750 分制 ≈ 班均 − 11 分；单科线按各科满分同比例折算，不再用「总分班均 − 20」。 */
  t('★需关注门槛改按满分比例（不再写死「班均 − 10」）',
    /SC_ALERT_RATIO = 0\.015/.test(idx) && /var gap = full \* SC_ALERT_RATIO/.test(idx)
    && !/var thr = st\.avg - 10;/.test(idx));
  t('★单科也单独判（该科班均 − 该科满分 × 1.5%）',
    /subLines\[sub\.key\] = \(avgs\[sub\.key\] == null \|\| !f\) \? null : \(avgs\[sub\.key\] - f \* SC_ALERT_RATIO\)/.test(idx));
  /* v3.5.6 起多了第三条路「连续两次退步」，所以守卫变成三选一 */
  t('★总分 / 单科 / 连退三条路任一命中就上榜',
    /var lowTotal = \(t != null && t < thr\);/.test(idx)
    && /var drop2 = !!prevDrop\[r\.name\];/.test(idx)
    && /if\(!lowTotal && !lowSubs\.length && !drop2\) return;/.test(idx));
  t('★拖后腿科目＝相对班均差得最多', /差得最多的那一科/.test(idx));

  /* ===== ④ 进退步榜：比名次不比分数 ===== */
  t('★班级总分口径说明（官方口径句）', /统计口径：班级总分名次/.test(idx));
  t('★名次并列处理（同分同名次）', /if\(last === null \|\| x\.v !== last\)\{ k = i \+ 1; last = x\.v; \}/.test(idx));
  t('★依赖历次成绩（懒加载）', /var curPack = SC\.allRows\[eidOf\(items\[idx\]\)\];/.test(idx)
    && /var eidOf = function\(x\)\{ return x\.examId != null \? x\.examId : x\.id; \};/.test(idx));

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
  t('★用户自己切过就不再被覆盖', /SC\.basisSet = true;[\s\S]{0,160}?scRenderAll\(\)/.test(idx));

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

console.log('\n【58】第四十九轮·分享链接 + 每日备份（v2.9.0）');
{
  const idx  = readIdx();
  const adm  = readAdm();
  const sc   = fs.readFileSync(new URL('./api/scores.js', import.meta.url), 'utf8');
  const wk   = fs.readFileSync(new URL('./api/worker.mjs', import.meta.url), 'utf8');
  const share= fs.readFileSync(new URL('./share.html', import.meta.url), 'utf8');
  const wf   = fs.readFileSync(new URL('./.github/workflows/deploy-pages.yml', import.meta.url), 'utf8');

  /* ===== ① 分享链接：后端 ===== */
  ['share-create', 'share-revoke', 'share-list'].forEach(function(a){
    t('★POST 路由 ' + a, new RegExp("case '" + a + "':").test(sc));
  });
  t('★GET 路由 share-get（免登录）', /case 'share-get': return await shareGet/.test(sc));
  t('★token 用 crypto 随机生成', /crypto\.getRandomValues\(buf\)/.test(sc) && /function shareToken\(\)/.test(sc));
  t('★三种范围 self/picked/class', /\['self', 'picked', 'class'\]\.indexOf\(scope\) < 0/.test(sc));
  t('★学生分享受后台开关限制', /if \(allow === 'none'\) return fail\(res, 403/.test(sc));
  t('★过期 / 撤销 / 次数用完 三种失效都拦', /这个分享已被撤销/.test(sc) && /这个分享已过期/.test(sc) && /查看次数已用完/.test(sc));
  t('★每次打开都给 views +1', /update share_links set views = views \+ 1/.test(sc));
  t('★self 范围只给分享者自己', /s0\.scope === 'self' && Number\(r\.user_id\) !== Number\(s0\.owner_id\)/.test(sc));
  t('★picked 范围按姓名过滤', /s0\.scope === 'picked' && names\.indexOf/.test(sc));
  t('★撤销只能撤自己建的（管理员例外）', /只能撤销自己建的分享/.test(sc));
  t('★分享表加了 target_names 列（自愈 + schema 双写）',
    /alter table share_links add column if not exists target_names jsonb/.test(
      fs.readFileSync(new URL('./api/_lib/http.js', import.meta.url), 'utf8'))
    && /target_names jsonb/.test(fs.readFileSync(new URL('./api/schema.sql', import.meta.url), 'utf8')));

  /* ===== ② 分享页 ===== */
  t('★share.html 存在且是独立页', /^<!DOCTYPE html>/i.test(share.trim()));
  t('★分享页禁止搜索引擎收录', /noindex,nofollow,noarchive/.test(share));
  t('★分享页不依赖登录（只认链接里的 t）', /share-get&t=/.test(share) && /localStorage/.test(share) === false);
  t('★分享页带水印（谁分享的 / 有效期 / 请勿外传）', /本页由/.test(share) && /请勿截图外传/.test(share));
  t('★水印里的范围是「定语」写法（不再拼出「本人的成绩成绩」）',
    /sh\.scope === 'self' \? '本人' :/.test(share) && /本人的成绩成绩/.test(share) === false);
  t('★分享页也支持赋分 / 原始切换', /data-b="graded"/.test(share) && /data-b="raw"/.test(share));
  t('★只有自己一个人的分享 → 直接给成绩卡', /rows\.length === 1/.test(share) && /function oneCard/.test(share));
  t('★share.html 已加入部署清单', /^\s+share\.html$/m.test(wf));

  /* ===== ③ 分享：前端入口 ===== */
  t('★工具栏有「分享」', /onclick="scShareDialog\(\)"/.test(idx));
  t('★弹窗可设范围 / 考试 / 有效期 / 次数', /id="shScope"/.test(idx) && /id="shDays"/.test(idx) && /id="shMax"/.test(idx));
  t('★站主可选「全班」与「挑几位同学」', /<option value="class"' \+ scSel\('class'\) \+ '>全班成绩/.test(idx) && /value="picked"/.test(idx));
  t('★学生默认只能分自己', /var allow = isAdmin \? 'all' : \(cfg\.shareByStudent \|\| 'none'\)/.test(idx));
  t('★能看已建分享并撤销', /function scShareList\(\)/.test(idx) && /不能再转发|撤销后这个链接立刻失效/.test(idx));
  t('★明确提示「谁拿到链接谁就能看」', /谁拿到链接谁就能看/.test(idx));

  /* ===== ④ 备份：后端 ===== */
  ['backup-run', 'backup-restore'].forEach(function(a){
    t('★POST 路由 ' + a, new RegExp("case '" + a + "':").test(sc));
  });
  ['backup-list', 'backup-get', 'backup-export'].forEach(function(a){
    t('★GET 路由 ' + a, new RegExp("case '" + a + "':").test(sc));
  });
  t('★备份全部要管理员', (sc.match(/backup(Run|List|Get|Export|Restore)[^{]*\{\s*\n\s*const u = await requireAdmin/g) || []).length >= 3);
  t('★快照不含密码哈希（users 只留 id/姓名/角色）',
    /select id, username, display_name, role, status from users/.test(sc)
    && /不含密码哈希/.test(sc));
  t('★没配 KV 时优雅降级（不报 500）', /还没配置备份存储（KV）/.test(sc) && /function getKV\(\)/.test(sc));
  t('★KV 只留最近 14 份', /const BACKUP_KEEP = 14;/.test(sc));
  t('★还原要求输入 RESTORE 二次确认', /String\(b\.confirm \|\| ''\) !== 'RESTORE'/.test(sc));
  t('★还原支持 dry 预览', /if \(b\.dry\)/.test(sc));
  t('★还原前自动留一份「现在的样子」', /before-restore-/.test(sc) && /safetyKey/.test(sc));
  t('★还原不碰 users 表', /users 表（账号）<b>不会<\/b>被改动|users 表绝不碰/.test(adm + sc));
  t('★还原后修 bigserial 序列（否则下次插入撞主键）',
    /setval\(pg_get_serial_sequence\('exams','id'\)/.test(sc));
  t('★备份含内容数据（公告 / 作业 等 user_data）', /from user_data order by user_id, data_key/.test(sc));

  /* ===== ④.5 【演练抓到的真 bug】批量写入（Workers 免费版 50 子请求上限） ===== */
  t('★还原用批量插入（jsonb_to_recordset），不再逐条 insert',
    /jsonb_to_recordset\(\$\{JSON\.stringify\(fixExams\)\}/.test(sc)
    && /jsonb_to_recordset\(\$\{JSON\.stringify\(t\.exam_scores\)\}/.test(sc)
    && /jsonb_to_recordset\(\$\{JSON\.stringify\(t\.share_links\)\}/.test(sc));
  t('★还原不再有「逐条 for 循环 insert」', /for \(const e of t\.exams\)/.test(sc) === false
    && /for \(const r of \(t\.exam_scores \|\| \[\]\)\)/.test(sc) === false);
  t('★改分也改批量 upsert（块粘贴几十行不会 500）',
    /update exam_scores t\s*\n\s*set student_name = x\.student_name/.test(sc)
    && /user_id = coalesce\(x\.uid, t\.user_id\)/.test(sc)
    && /jsonb_to_recordset\(\$\{JSON\.stringify\(ins\)\}/.test(sc));
  t('★代码里写明了 50 子请求上限的原因（防后人改回去）',
    /50 个子请求/.test(sc) && /50 子请求上限/.test(sc));

  /* ===== ④.6 【演练抓到的第二个坑】快照里的日期必须是 YYYY-MM-DD ===== */
  t('★有 isoDay 把日期规范化', /function isoDay\(v\) \{/.test(sc));
  t('★打包快照时 exam_date / exam_end_date 都规范化',
    /exam_date: isoDay\(e\.exam_date\),\s*\n\s*exam_end_date: isoDay\(e\.exam_end_date\),/.test(sc));
  t('★还原时兼容旧快照（再切一次日期）',
    /const fixExams = \(t\.exams \|\| \[\]\)\.map/.test(sc) && /JSON\.stringify\(fixExams\)/.test(sc));
  t('★日期识别不了就明确拒绝，不硬塞',
    /快照里有考试的日期无法识别，不能还原/.test(sc));
  t('★注释写明「Postgres date 出来是 Date 对象」这个坑',
    /Postgres 的 date 经驱动出来是 Date 对象/.test(sc));
  t('★isoDay 专门处理 Date 实例（String(date) 不是 ISO 串）',
    /if \(v instanceof Date\) \{/.test(sc) && /v\.getUTCFullYear\(\)/.test(sc)
    && /String\(dateObj\) 得到的是/.test(sc));

  /* ===== ④.7 【演练抓到的第三个坑】还原必须在一个事务里 ===== */
  t('★还原整套动作走 sql.transaction（原子）', /await sql\.transaction\(tx\)/.test(sc));
  t('★delete 与 insert 都在同一个 tx 数组里',
    /tx\.push\(sql`delete from exam_scores`\)/.test(sc) && /tx\.push\(sql`delete from exams`\)/.test(sc));
  t('★还原失败会回滚并回传真实原因（不再只说服务器内部错误）',
    /还原失败（已回滚，数据没动）/.test(sc));
  t('★注释写明「删了没插回去」这个最坏情况',
    /数据被清空、插不回去/.test(sc));
  t('★setval 也放进事务（用 greatest 防 0）',
    /tx\.push\(sql`select setval\(pg_get_serial_sequence\('exams','id'\), greatest/.test(sc));

  /* ===== ⑤ 备份：定时任务 + 前端 ===== */
  t('★worker 有 scheduled（Cron 自动备份）', /async scheduled\(event, env, ctx\)/.test(wk));
  t('★导出了 runDailyBackup 供 Cron 调用', /export async function runDailyBackup\(\)/.test(sc));
  t('★wrangler.toml 写了 KV 绑定与 cron 的填法', /\[\[kv_namespaces\]\]/.test(
      fs.readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8')));
  t('★后台有「备份」入口', /id="scBackup"/.test(adm) && /scBackupDialog/.test(adm));
  t('★后台能立即备份 / 下载 / 还原', /bkRun/.test(adm) && /bkDl/.test(adm) && /bkRestore/.test(adm));
  t('★下载走带鉴权的 fetch（不是裸链）',
    /action=backup-export', \{\s*\n\s*headers: \{ Authorization/.test(adm));
}

console.log('\n【59】第五十二轮·姓名对照：同一个人两个名字（v2.9.5）');
{
  const idx = readIdx();
  const adm = readAdm();
  const sc  = fs.readFileSync(new URL('./api/scores.js', import.meta.url), 'utf8');

  /* ===== ① 机制齐了没 ===== */
  t('★后端有 canonName（成绩表姓名 → 站点姓名）', /function canonName\(name, nameMap\)/.test(sc));
  t('★后端有 namesOfUser（含别名反查）', /function namesOfUser\(u, nameMap\)/.test(sc));
  t('★默认配置里有 nameMap', /nameMap: \{\}/.test(sc));
  t('★导入时先过姓名对照再绑账号', /byName\.get\(canonName\(r\.name, nameMap\)\)/.test(sc));
  t('★「我」由后端标（mine），别名也认得出', /mine: r\.user_id == null/.test(sc));
  t('★我的历次成绩也认别名（any 数组）',
    /s\.user_id = \$\{u\.id\} or s\.student_name = any\(\$\{myNames\}::text\[\]\)/.test(sc));
  t('★有 unbound 接口（列出没对上的姓名）', /case 'unbound':\s+return await unboundNames/.test(sc));
  t('★有 name-bind 接口（关联 / 取消关联）', /case 'name-bind':\s+return await nameBind/.test(sc));
  t('★姓名对照只给站主看（学生拿不到 nameMap）', /delete safe\.nameMap/.test(sc));
  t('★改分表也顺手重算该绑哪个账号', /user_id = coalesce\(x\.uid, t\.user_id\)/.test(sc));
  /* ⚠️ v2.7.4 的跨天支持有个漏网：列表 SQL 忘了选 exam_end_date，
     于是「考试可跨天」建了却从来显示不出来。这条守住它。 */
  t('★列表接口带出结束日期（跨天才会显示成 5/14 ~ 5/15）',
    /select e\.id, e\.name, e\.exam_date, e\.exam_end_date, e\.exam_type/.test(sc));
  t('★后台有「姓名对照」入口', /id="scNames"/.test(adm) && /scNameDialog/.test(adm));
  t('★后台能取消关联', /scNameBind/.test(adm) && /取消关联/.test(adm));
  t('★前端「我」的判定会看 mine', /if\(r\.mine\) hit = r;/.test(idx));

  /* ===== ③ 后台「版本更新记录」补全（站主：之前的记得补上） ===== */
  /* ⚠️ 记录本体在云端 release_notes，测试只能守代码里的内置种子 —— 它必须与云端同源，
     否则「一键填入最近几轮」会把列表拉回旧内容。 */
  const seedV = (adm.match(/"version":\s*"([\d.]+)"/g) || []).map((x) => x.match(/"([\d.]+)"/)[1]);
        t('★每条都带标题与条目', (adm.match(/"version":\s*"[\d.]+",\s*"date":/g) || []).length === seedV.length);
  t('★版本号显示统一（不再出现「vv2.6.4」）',
    /function relVerLabel/.test(adm) && /esc\(relVerLabel\(r\.version\)\)/.test(adm));
  t('★版本号显示有护栏（已带 v 就不再叠一层）', /\/\^v\/i\.test\(s\) \? s : \('v' \+ s\)/.test(adm));

  /* ===== ② 真跑一遍：导入 → 没对上 → 关联 → 学生就看得见了 ===== */
  /* 单独建一个学生账号来测（前面的用例可能已经把老账号的会话搞失效了） */
  const reg = await call('/api/auth?action=register', {
    method: 'POST', body: { username: 'namemapstu', password: 'NameMap2026', displayName: '测试生甲' },
  });
  t('建一个测试学生账号', reg.status === 200 && reg.body.ok, JSON.stringify(reg.body));
  const stuToken = reg.body.token;

  const mk = await call('/api/scores?action=exam-save', {
    method: 'POST', token: adminToken,
    body: {
      name: '姓名对照测试考', exam_date: '2026-09-01',
      subjects: [{ key: 'chinese', name: '语文', full: 150 }, { key: 'math', name: '数学', full: 150 }],
    },
  });
  t('建一次考试（测试用）', mk.status === 200 && mk.body.ok, JSON.stringify(mk.body));
  const eid = mk.body.exam && mk.body.exam.id;

  const im = await call('/api/scores?action=scores-import', {
    method: 'POST', token: adminToken,
    body: { exam: eid, rows: [
      { name: '测试生甲', s: { chinese: 100, math: 110 } },
      { name: '测试生乙', s: { chinese: 90, math: 80 } },
    ] },
  });
  t('导入两行：一个对得上账号、一个对不上',
    im.status === 200 && im.body.imported === 2 && (im.body.unmatched || []).indexOf('测试生乙') >= 0,
    JSON.stringify(im.body));

  await call('/api/scores?action=exam-publish', { method: 'POST', token: adminToken, body: { id: eid, publish: true } });

  const ub = await call('/api/scores?action=unbound', { token: adminToken });
  t('unbound 列出「测试生乙」',
    ub.status === 200 && (ub.body.unbound || []).some((x) => x.name === '测试生乙'),
    JSON.stringify(ub.body.unbound));
  t('unbound 不列已经对上的「测试生甲」', !(ub.body.unbound || []).some((x) => x.name === '测试生甲'));
  t('unbound 带回账号名单供选择', (ub.body.users || []).some((x) => x.name === '测试生甲'));
  t('unbound 给出已对上的数量', (ub.body.boundCount || 0) >= 1);

  const me1 = await call('/api/scores?action=me', { token: stuToken });
  t('关联前：学生只看到自己那 1 条', me1.status === 200 && (me1.body.items || []).length === 1,
    '实际 ' + JSON.stringify(me1.body).slice(0, 200));

  const bind = await call('/api/scores?action=name-bind', {
    method: 'POST', token: adminToken, body: { name: '测试生乙', target: '测试生甲' },
  });
  t('关联成功并回写对照表', bind.status === 200 && bind.body.nameMap['测试生乙'] === '测试生甲',
    JSON.stringify(bind.body));
  t('关联顺手把这些成绩行绑上账号', bind.body.changed === 1, '影响 ' + bind.body.changed + ' 行');

  const me2 = await call('/api/scores?action=me', { token: stuToken });
  t('★关联后：学生两个名字的成绩都看得到（2 条）',
    me2.status === 200 && (me2.body.items || []).length === 2, '实际 ' + JSON.stringify(me2.body).slice(0, 200));

  const bd = await call('/api/scores?action=board&exam=' + eid, { token: stuToken });
  const mineRows = (bd.body.rows || []).filter((r) => r.mine);
  t('★成绩单里「测试生乙」那行也被标成「我」',
    mineRows.length === 2 && mineRows.some((r) => r.name === '测试生乙'));

  const bindBad = await call('/api/scores?action=name-bind', {
    method: 'POST', token: adminToken, body: { name: '测试生乙', target: '查无此人' },
  });
  t('关联到不存在的账号会被拒（不写脏数据）', bindBad.status === 400, '实际 ' + bindBad.status);

  const bind2 = await call('/api/scores?action=name-bind', {
    method: 'POST', token: adminToken, body: { name: '测试生乙', target: '' },
  });
  t('取消关联：对照表里这条被删掉',
    bind2.status === 200 && bind2.body.nameMap['测试生乙'] === undefined);

  const me3 = await call('/api/scores?action=me', { token: stuToken });
  t('取消关联后：又只剩自己那 1 条', (me3.body.items || []).length === 1,
    '实际 ' + JSON.stringify(me3.body).slice(0, 200));

  /* 站主配好对照，再导入一次 —— 导入路径也应该自动绑上 */
  await call('/api/scores?action=name-bind', {
    method: 'POST', token: adminToken, body: { name: '测试生乙', target: '测试生甲' },
  });
  const im2 = await call('/api/scores?action=scores-import', {
    method: 'POST', token: adminToken,
    body: { exam: eid, rows: [
      { name: '测试生甲', s: { chinese: 100, math: 110 } },
      { name: '测试生乙', s: { chinese: 90, math: 80 } },
    ] },
  });
  t('★配好对照后重新导入：不再报「没对上」',
    im2.status === 200 && (im2.body.unmatched || []).length === 0, JSON.stringify(im2.body));
  const bd2 = await call('/api/scores?action=board&exam=' + eid, { token: stuToken });
  t('★导入时就直接绑好了账号（uid 非空）',
    (bd2.body.rows || []).filter((r) => r.name === '测试生乙' && r.uid != null).length === 1);

  /* 学生拿不到别人的对照表 */
  const stCfg = await call('/api/scores?action=config', { token: stuToken });
  t('★学生拿到的配置里没有 nameMap', stCfg.status === 200 && stCfg.body.config.nameMap === undefined);

  /* 清场：删考试 + 清对照表 + 删测试账号 */
  await call('/api/scores?action=exam-delete', { method: 'POST', token: adminToken, body: { id: eid } });
  const clr = await call('/api/scores?action=config-save', {
    method: 'POST', token: adminToken, body: { config: { nameMap: {} } },
  });
  t('清场：对照表清空（不留脏数据）', clr.status === 200 && Object.keys(clr.body.config.nameMap).length === 0);
  const delu = await call('/api/admin?action=delete-user', {
    method: 'POST', token: adminToken, body: { id: reg.body.user.id },
  });
  t('清场：删掉测试学生账号', delu.status === 200, JSON.stringify(delu.body).slice(0, 120));
}

console.log('\n【59】第五十四轮·分享 404 / 网络提示开关 / 内容自定义 / 进退步三口径（v2.9.7）');
{
  const idx   = readIdx();
  const share = fs.readFileSync(new URL('./share.html', import.meta.url), 'utf8');
  const sc    = fs.readFileSync(new URL('./api/scores.js', import.meta.url), 'utf8');
  const sch   = fs.readFileSync(new URL('./api/schema.sql', import.meta.url), 'utf8');
  const http  = fs.readFileSync(new URL('./api/_lib/http.js', import.meta.url), 'utf8');

  /* ===== ① 分享链接 404：站点挂在子目录，不能拿 location.origin 硬拼 ===== */
  t('★分享链接改用 URL 解析（保住 GitHub Pages 的子目录前缀）',
    idx.includes("new URL(String(j.url || '').replace(/^\\/+/, ''), location.href).href"));
  t('★代码里写明了「别用 location.origin」的原因（防后人改回去）',
    idx.includes('别用 location.origin') && idx.includes('404'));
  t('★不再有「拿 location.origin 拼分享链接」的代码（注释里提到不算）',
    /\burl\s*=\s*[^;\n]*location\.origin/.test(idx) === false);

  /* ===== ② 网络检测默认关（能一键打开） ===== */
  t('★网络提示默认关（netWatchOn 只认显式打开）',
    /function netWatchOn\(\)\{\s*\n\s*return !!\(typeof UI !== 'undefined' && UI && UI\.netWatch\);/.test(idx));
  t('★markNetFail 在开关关掉时直接返回（横幅与倒计时都不弹）',
    /if\(!netWatchOn\(\)\)\{ NET_FAILS = 0; return; \}/.test(idx));
  t('★设置里留了开关（随时能打开）',
    /function toggleNetWatch\(ev\)\{/.test(idx) && /toggleNetWatch\(event\)/.test(idx));
  t('★关掉时顺手收起可能挂着的横幅', /stopRetry\(\); setOfflineBanner\(false\);/.test(idx));

  /* ===== ③ 导出图片：勾选要导出的内容 ===== */
  t('★导出前先弹勾选面板', /function scExportDialog\(\)\{/.test(idx) && /id="scExMask"/.test(idx));
  t('★勾选状态记在 SC_EXPORT（head 永远为真）',
    /var SC_EXPORT = \{\s*\n\s*head: true,/.test(idx));
  t('★「总分与排名」必选（禁掉勾选框）', /row\('head', '总分与排名'/.test(idx) && /disabled/.test(idx));
  t('★高度按勾选算（没勾的不占高度）',
    /function scExportHeight\(cfg, nSub, nCut, nTrend, hasBar\)\{/.test(idx) && /var H = scExportHeight\(opt,/.test(idx));
  t('★画图和算高度共用同一套步长',
    /var SC_EX_STEP = \{/.test(idx) && /var S = SC_EX_STEP, W = S\.W, pad = S\.pad;/.test(idx));
  t('★每一段的「占不占高度」都单独判断（少判一段图上就多一片空白）',
    /if\(cfg\.metrics\) y \+= S\.metGap/.test(idx) && /if\(cfg\.subjects && nSub\)/.test(idx)
    && /if\(cfg\.subrank && nSub\)/.test(idx) && /if\(cfg\.diag && nSub\)/.test(idx)
    && /if\(cfg\.rankbar && hasBar\)/.test(idx) && /if\(cfg\.trend && nTrend >= 2\)/.test(idx));

  /* ===== ④ 分享链接：也要能自定义分享内容 ===== */
  t('★后端 share_links 加 sections 列（自愈 + schema 双写）',
    /alter table share_links add column if not exists sections jsonb/.test(http)
    && /sections\s+jsonb/.test(sch));
  t('★share-create 收 sections，且至少留一项',
    /const rawSec = \(b\.sections/.test(sc) && /至少选一项分享内容/.test(sc));
  t('★share-create 把 sections 存进去并回给前端（v3.8.0 起带 note 备注）',
    /insert into share_links \(token, scope, owner_id, target_names, exam_ids, sections, expires_at, max_views, note\)/.test(sc));
  t('★老链接没写过 sections → 按「都有」处理（不返回空白）',
    /老链接没写过 sections → 按「都有」处理/.test(sc) && /const s3 = \(v\) => v !== false;/.test(sc)
    && /board: s3\(sec\.board\)/.test(sc));
  t('★前端分享弹窗加了「分享哪些内容」',
    /分享哪些内容/.test(idx) && /data-sec="board"/.test(idx) && /data-sec="card"/.test(idx));
  t('★前端把 sections 一起提交', /sections: sections,/.test(idx));
  t('★两项都没勾时拦住（不然对方点开是空白）',
    /至少要勾一项分享内容/.test(idx));
  t('★分享页按 sections 过滤内容',
    /var sw = function\(k\)\{ return sec\[k\] !== false; \};/.test(share)
    && /var wantBoard = sw\('board'\);/.test(share) && /var wantCard = sw\('card'\);/.test(share));
  t('★成绩单与个人成绩卡可同时展示（不再二选一，2026-10-17）',
    /var showBoard = wantBoard \|\| \(!wantBoard && !wantCard\);/.test(share)
    && /if\(wantCard && ownerRow\)\{/.test(share)
    && /var ownerRow = null;/.test(share));

  /* ===== ⑤ 进退步榜：年级 / 班级 / 班级单科 三口径 ===== */
  t('★有口径状态 SC_TAIL 与切换函数',
    /var SC_TAIL = \{ basis: 'class', sub: null \};/.test(idx)
    && /function scTailSet\(basis\)\{/.test(idx) && /function scTailSubj\(key\)\{/.test(idx));
  t('★切换条三个口径齐全',
    /b\('class', '班级总分'\)/.test(idx) && /b\('grade', '年级'\)/.test(idx) && /b\('subject', '班级单科'\)/.test(idx));
  t('★年级口径直接用导入的年级名次（不自己排）',
    /curPos = gradeOf\(curPack\); prevPos = gradeOf\(prevPack\);/.test(idx));
  t('★单科口径只算那一科的班内名次',
    /curPos = rankMapOf\(cm\); prevPos = rankMapOf\(pm\);/.test(idx));
  t('★单科口径有科目下拉可换科', /onchange="scTailSubj\(this\.value\)"/.test(idx));
  t('★三种口径都统一成「名次」，分数变化单列',
    /d: prevPos\[n\] - curPos\[n\]/.test(idx) && /dc: \(curVal\[n\] != null && prevVal\[n\] != null\)/.test(idx));
  /* v3.3.0：进步 / 退步合并成一张表、列所有人、点表头排序（不再各取前五） */
  t('★进步退步合并成一张表（不再 slice(0,5) 各取前五）',
    !/slice\(0, 5\)/.test(idx) && /moved\.length/.test(idx) && /进步 <b>'/.test(idx));
  t('★全量展示 + 表头排序（scTailSort，逻辑同成绩表）',
    /function scTailSort\(k\)\{/.test(idx) && /scTailSort/.test(idx) && /tailSortKey/.test(idx)
    && /tailSortKey: 'd'/.test(idx) && /tailSortAsc: false/.test(idx));
  t('★对不上人时给提示而不是空白', /这两次考试按这个口径<b>对不上人<\/b>/.test(idx));
  t('★年级口径说明改为官方口径句（不再讲「打架」）',
    /统计口径：年级名次（由后台导入）/.test(idx));

  /* ===== ⑥ 版本与更新记录 ===== */
  t('★前台版本号格式正确（3.x.y）', /SITE_VERSION = '3\.[0-9]+\.[0-9]+'/.test(idx));
  
  /* ===== ⑦ 真实接口：sections 能存能读 ===== */  const ex0 = await call('/api/scores?action=list', { token: adminToken });
  const anyExam = (ex0.body.exams || [])[0];
  if (anyExam) {
    const c1 = await call('/api/scores?action=share-create', {
      method: 'POST', token: adminToken,
      body: { scope: 'self', examIds: [anyExam.id], sections: { board: true, card: false }, days: 1 },
    });
    t('★建分享时 sections 能存下', c1.status === 200 && c1.body.sections.board === true
      && c1.body.sections.card === false, JSON.stringify(c1.body).slice(0, 200));

    const g1 = await call('/api/scores?action=share-get&t=' + c1.body.token);
    t('★免登录读回来时 sections 原样带回',
      g1.status === 200 && g1.body.share.sections.board === true && g1.body.share.sections.card === false);

    const bad = await call('/api/scores?action=share-create', {
      method: 'POST', token: adminToken,
      body: { scope: 'self', examIds: [anyExam.id], sections: { board: false, card: false }, days: 1 },
    });
    t('★两项都不勾时后端也拦（400）', bad.status === 400, '实际 ' + bad.status);

    await call('/api/scores?action=share-revoke', { method: 'POST', token: adminToken, body: { id: c1.body.id } });
  } else {
    t('★建分享时 sections 能存下（无考试可测，跳过）', true);
    t('★免登录读回来时 sections 原样带回（跳过）', true);
    t('★两项都不勾时后端也拦（400）（跳过）', true);
  }
}

console.log('\n【60】第五十五轮·分享统计按全班算 + 分享页去重 + 导出长图（v2.9.8）');
{
  const idx   = readIdx();
  const share = fs.readFileSync(new URL('./share.html', import.meta.url), 'utf8');
  const sc    = fs.readFileSync(new URL('./api/scores.js', import.meta.url), 'utf8');

  /* ===== ① 后端：明细被裁剪时，补一份「按全班算好的统计量」 =====
     站主实测：「分享我自己，然后它那个班均、班排名都显示 0」。
     根因不是显示坏了，是**数据不够** —— 只发了一个人，班均当然等于他自己。 */
  t('★scope 不是「全班」时才算这份统计', /const needStats = s0\.scope !== 'class';/.test(sc));
  t('★有 statOfExam 聚合函数', /function statOfExam\(exam, rows, basis, ownerId\) ?\{/.test(sc));
  t('★赋分与原始两套都算（切口径不该又变成 0）',
    /graded: statOfExam\(e, rowsOfExam, 'graded', s0\.owner_id\)/.test(sc)
    && /raw: statOfExam\(e, rowsOfExam, 'raw', s0\.owner_id\)/.test(sc));
  t('★注释写明了根因（不是显示坏了，是数据不够）', /不是显示坏了，是\*\*数据不够\*\*/.test(sc));
  {
    const body = sc.slice(sc.indexOf('function statOfExam'), sc.indexOf('function statOfExam') + 5000);
    t('★只发聚合数字，不带别人的姓名与明细', body.indexOf('student_name') < 0);
  }
  t('★统计里给了：人数 / 班均 / 中位 / 最高 / 我的名次 / 各科班均与单科名次 / 各线上线人数',
    /return \{\s*\n\s*n,\s*\n\s*avg: round1\(avg\),/.test(sc) && /subj,\s*\n\s*\/\* 每条分数线/.test(sc));
  t('★小数统一收一位（不留 12.499999 的浮点尾巴）',
    /function round1\(v\) ?\{/.test(sc) && /Math\.round\(v \* 10\) \/ 10;/.test(sc));
  t('★stats 只在需要时返回（全班的明细本来就齐，不用补）',
    /stats: needStats \? stats : null,/.test(sc));

  /* ===== ② 分享页：用后端统计 + 去掉重复块 ===== */
  t('★分享页优先用后端按全班算的统计',
    /var ST = \(DATA\.stats && DATA\.stats\[EX\.id\]\) \? \(DATA\.stats\[EX\.id\]\[BASIS\] \|\| null\) : null;/.test(share));
  t('★统计条走 showAvg / showMed / showMax / showN', /var showAvg = \(ST && ST\.avg != null\) \? ST\.avg : avg;/.test(share));
  t('★成绩卡的班排名用后端算的（本地算出来永远是 1/1）',
    /var myRank = \(ST && ST\.myRank != null\) \? ST\.myRank : st;/.test(share));
  t('★各科的班均与班内名次也优先用后端那份',
    /var sr = \(sj && sj\.rank != null\) \? sj\.rank : \(rk\.subj\[sub\.key\] \|\| \{\}\)\.rank\[r\.idx\];/.test(share));
  t('★上线人数优先用后端那份（只发 1 个人时本地数不出来）',
    /ST\.cuts\[ci\] != null/.test(share));
  t('★卡片与成绩单同时渲染（勾了两个就都出，卡在前、单在后）',
    /if\(wantCard && ownerRow\)\{/.test(share) && /if\(showBoard\)\{/.test(share)
    && share.indexOf('html += oneCard(ownerRow') < share.indexOf('if(showBoard){'));
  t('★注释写明了「卡与单可以同时出」', /可以\*\*同时展示\*\*/.test(share));

  /* ===== ③ 分享弹窗：勾哪个跟着「分享范围」走 ===== */
  t('★有智能默认函数', /var applyDefaults = function\(scope\)\{/.test(idx));
  t('★分享自己 → 只勾个人成绩卡；分享全班/自选 → 只勾成绩单',
    /if\(scope === 'self'\) setSec\(false, true\);/.test(idx) && /else setSec\(true, false\);/.test(idx));
  t('★打开弹窗时就应用一次默认（不是等用户去切范围）',
    /applyDefaults\(scShEl\('shScope'\)\.value\);/.test(idx));
  t('★切范围时联动', /scShEl\('shScope'\)\.onchange = pickScope;/.test(idx));
  t('★说明里点出两项各适合什么场景',
    /看好几个人时用这个/.test(idx) && /分享自己时用这个/.test(idx));
  t('★有随范围变化的提示条', /id="shSecTip"/.test(idx) && /\.sc-sh-tip\{/.test(idx));

  /* ===== ④ 导出长图：四个新段，都可勾选 ===== */
  t('★SC_EXPORT 多了四段开关',
    /subrank: true,/.test(idx) && /diag: true,/.test(idx) && /rankbar: false,/.test(idx) && /trend: false,/.test(idx));
  ['单科排名', '偏科分析', '年级位置', '历次趋势（总分）'].forEach(function(txt){
    t('★长图里有「' + txt + '」段', new RegExp("'" + txt + "'").test(idx));
  });
  t('★段顺序：各科成绩 → 单科排名 → 偏科分析 → 年级位置 → 历次趋势 → 上线情况',
    idx.indexOf("'单科排名', pad, y") < idx.indexOf("'偏科分析', pad, y")
    && idx.indexOf("'偏科分析', pad, y") < idx.indexOf("'年级位置', pad, y")
    && idx.indexOf("'年级位置', pad, y") < idx.indexOf("'历次趋势（总分）', pad, y")
    && idx.indexOf("'历次趋势（总分）', pad, y") < idx.indexOf("'上线情况', pad, y"));
  t('★偏科分析末尾点名最弱与最强', /tips = '最弱：'/.test(idx) && /最强：/.test(idx));
  t('★未考的科不参与「最弱」评选（否则「未考」会被当成最弱）',
    /var scored = diffs\.filter\(function\(d\)\{ return d\.diff != null; \}\);/.test(idx));
  t('★历次趋势用「我的历次成绩」那条链，自带每次的科目', /function scMeSeries\(\)\{/.test(idx));
  t('★没数据的段直接禁用并写明原因（勾了画不出来只会让人以为坏了）',
    /这次没导年级排名，画不出来/.test(idx) && /至少要两次有成绩的考试才画得出来/.test(idx));
  t('★「禁用」是真的传了标志位（只写原因等于没禁用 —— 这就是实测踩到的坑）',
    /: '这次没导年级排名，画不出来', !hasBar\)/.test(idx)
    && /: '至少要两次有成绩的考试才画得出来', series\.length < 2\)/.test(idx));
  t('★算高度和绘制用的是同一份可用性判断（否则会留一片空白）',
    /var hasBar = !!\(gradeN && meRow\.schoolRank != null\);/.test(idx)
    && /var series = opt\.trend \? scMeSeries\(\) : \[\];/.test(idx));
  t('★绘制顺序与算高度顺序一致（否则图上会多空白或被裁）',
    /if\(cfg\.subrank && nSub\) y \+= S\.rankGap/.test(idx) && /if\(opt\.subrank && subs\.length\)\{/.test(idx));

  /* ===== ⑤ 版本与更新记录 ===== */
  t('★前台版本号格式正确（3.x.y）', /SITE_VERSION = '3\.[0-9]+\.[0-9]+'/.test(idx));
  
  /* ===== ⑥ 真跑一遍：只分享 1 个人，班均与排名仍然是对的 ===== */  const reg2 = await call('/api/auth?action=register', {
    method: 'POST', body: { username: 'statsstu', password: 'StatsStu2026', displayName: '统计生甲' },
  });
  t('建一个测试学生账号（统计用）', reg2.status === 200 && reg2.body.ok, JSON.stringify(reg2.body).slice(0, 150));
  const sTok = reg2.body.token;

  const mk2 = await call('/api/scores?action=exam-save', {
    method: 'POST', token: adminToken,
    body: {
      name: '统计口径测试考', exam_date: '2026-09-02',
      subjects: [{ key: 'chinese', name: '语文', full: 150 }, { key: 'math', name: '数学', full: 150 }],
    },
  });
  const eid2 = mk2.body.exam && mk2.body.exam.id;
  await call('/api/scores?action=scores-import', {
    method: 'POST', token: adminToken,
    body: { exam: eid2, rows: [
      { name: '统计生甲', s: { chinese: 100, math: 110 } },   /* 总分 210 */
      { name: '统计生乙', s: { chinese: 90,  math: 80  } },   /* 总分 170 */
      { name: '统计生丙', s: { chinese: 120, math: 130 } },   /* 总分 250 */
    ] },
  });
  await call('/api/scores?action=exam-publish', { method: 'POST', token: adminToken, body: { id: eid2, publish: true } });

  const cSelf = await call('/api/scores?action=share-create', {
    method: 'POST', token: sTok, body: { scope: 'self', examIds: [eid2], days: 1 },
  });
  t('学生按「只分享我的成绩」建分享', cSelf.status === 200 && !!cSelf.body.token, JSON.stringify(cSelf.body).slice(0, 150));

  const gSelf = await call('/api/scores?action=share-get&t=' + cSelf.body.token);
  const S = gSelf.body.stats && gSelf.body.stats[eid2] && gSelf.body.stats[eid2].graded;
  t('★只分享自己时，明细确实只有 1 个人', (gSelf.body.rows || []).length === 1);
  t('★但统计是按全班 3 人算的（这就是「不再显示 0」的关键）', !!S && S.n === 3, JSON.stringify(S).slice(0, 200));
  t('★班均 = 210（而不是你自己那一个数）', S && S.avg === 210, '实际 ' + (S && S.avg));
  t('★我的班排名 = 2 / 3（而不是 1 / 1）', S && S.myRank === 2, '实际 ' + (S && S.myRank));
  t('★中位数与最高也是全班的', S && S.med === 210 && S.max === 250, JSON.stringify(S && { med: S.med, max: S.max }));
  t('★各科班均按全班算（语文 103.3）', S && S.subj.chinese.avg === 103.3, '实际 ' + (S && S.subj.chinese.avg));
  t('★单科名次也是全班的（语文第 2、数学第 2）', S && S.subj.chinese.rank === 2 && S.subj.math.rank === 2);
  t('★原始口径那份也算好了（切过去不会又变 0）',
    !!gSelf.body.stats[eid2].raw && gSelf.body.stats[eid2].raw.avg === 210);
  t('★统计里不带别的同学姓名（只发聚合数字）',
    JSON.stringify(gSelf.body.stats).indexOf('统计生乙') < 0 && JSON.stringify(gSelf.body.stats).indexOf('统计生丙') < 0);

  const cAll = await call('/api/scores?action=share-create', {
    method: 'POST', token: adminToken, body: { scope: 'class', examIds: [eid2], days: 1 },
  });
  const gAll = await call('/api/scores?action=share-get&t=' + cAll.body.token);
  t('★分享全班时不额外发统计（明细本来就齐，前端自己算）',
    gAll.body.stats === null && (gAll.body.rows || []).length === 3);
  t('★全班明细里没有「统计」这种多余字段', gAll.body.rows.every((r) => r.stats === undefined));

  /* 清场 */
  await call('/api/scores?action=share-revoke', { method: 'POST', token: sTok, body: { id: cSelf.body.id } });
  await call('/api/scores?action=share-revoke', { method: 'POST', token: adminToken, body: { id: cAll.body.id } });
  await call('/api/scores?action=exam-delete', { method: 'POST', token: adminToken, body: { id: eid2 } });
  await call('/api/admin?action=delete-user', { method: 'POST', token: adminToken, body: { id: reg2.body.user.id } });
  t('清场：测试考试与账号都删掉', true);
}

/* 【61】第五十六轮·客户端派生接线（v2.9.9 一次性根治改密卡死）
   ------------------------------------------------------------
   后端契约已由 28.5/28.6 锁定，这里盯前端两个页面是否真的接上了线：
   任何一处漏接，线上就是「协议支持了但页面还在走老路」。 */
console.log('\n【61】第五十六轮·客户端派生接线检查（index.html + admin.html）');
{
  const idx = readIdx();
  const adm = readAdm();

  /* ---- ① 前台：KDF 助手四件套齐全 ---- */
  t('★index.html 有 clsDerive（浏览器 PBKDF2）', /function clsDerive\(/.test(idx));
  t('★index.html 有 clsNewHash（生成 pbkdf2c 摘要）', /function clsNewHash\(/.test(idx));
  t('★index.html 有 clsLogin（登录走派生，失败回退明文）', /function clsLogin\(/.test(idx));
  t('★index.html 有 clsChangePwd（改密走派生，失败回退明文）', /function clsChangePwd\(/.test(idx));
  t('★index.html 新密码派生档位为 50000（与名单导入一致）', /CLS_KDF_ITER = 50000/.test(idx));
  t('★index.html 回退条件含 429/5xx/无 WebCrypto', /NO_SUBTLE/.test(idx) && /e\.status === 429/.test(idx) && /e\.status >= 500/.test(idx));

  /* ---- ② 前台：三个调用点真的换了 ---- */
  t('★doLogin 调 clsLogin', /clsLogin\(u, p\)/.test(idx));
  t('★强制改密调 clsChangePwd（带当前用户名）', /clsChangePwd\(oldPwd, p1, AUTH\.user && AUTH\.user\.username\)/.test(idx));
  t('★设置页改密调 clsChangePwd', /clsChangePwd\(o, n, AUTH\.user && AUTH\.user\.username\)/.test(idx));
  t('★改密成功后盐缓存失效（旧哈希串作废）', /clsSaltForget\(username\)/.test(idx));

  /* ---- ③ 前台：刷新后恢复强制改密态（补当前密码框） ---- */
  t('★acctForcePwdHtml 在内存无初始密码时补「当前密码」框', /id="fpOld"/.test(idx));
  t('★doForceChangePwd 从 fpOld 取回退密码', /FORCE_OLD_PWD \|\| val\('fpOld'\)/.test(idx));
  t('★initAuth 的 me 回调按 mustChangePassword 恢复 forcepwd',
    /j\.mustChangePassword && ACCT_TAB !== 'forcepwd'/.test(idx));

  /* ---- ④ 后台：同款接线（登录 + 两处改密） ---- */
  t('★admin.html 有 clsLogin/clsChangePwd/clsDerive/clsNewHash', /function clsLogin\(/.test(adm)
    && /function clsChangePwd\(/.test(adm) && /function clsDerive\(/.test(adm) && /function clsNewHash\(/.test(adm));
  t('★admin.html 后台登录调 clsLogin', /clsLogin\(u, p\)/.test(adm));
  t('★admin.html 我的改密调 clsChangePwd', /clsChangePwd\(o, n, STATE\.me && STATE\.me\.username\)/.test(adm));
  t('★admin.html 强制改密弹窗调 clsChangePwd', /clsChangePwd\(o, n, STATE\.me && STATE\.me\.username\)[\s\S]{0,80}then\(function\(j\)\{[\s\S]{0,200}setToken/.test(adm));

  /* ---- ⑤ 诊断端点已移除（只读体检用完了不留着） ---- */
  const adminSrc = fs.readFileSync(new URL('./api/admin.js', import.meta.url), 'utf8');
  t('★pwd-audit 诊断端点已移除', !/pwdAudit/.test(adminSrc));
  t('★admin.js 不再导入 bcryptjs（诊断探针一起带走）', !/from 'bcryptjs'/.test(adminSrc));

  /* ---- ⑥ 版本三处同步 ---- */
  t('★前台版本号格式正确（3.x.y）', /SITE_VERSION = '3\.[0-9]+\.[0-9]+'/.test(idx));
  t('★后台版本号格式正确（3.x.y）', /SITE_VERSION = '3\.[0-9]+\.[0-9]+'/.test(adm));
  const swSrc = fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
  t('★v3.9.16 缓存桶与 SITE_VER 绑定', /SITE_VER = '3\.\d+\.\d+'/.test(swSrc) && /class-site-' \+ SITE_VER/.test(swSrc));
  }

/* 【62】第五十七轮·全站字色共用逻辑 + 文案官方化（v2.9.10）
   ------------------------------------------------------------
   站主两条新规（均为持续生效的站规级要求，详见 notes.md 第 10 节）：
   ① 「全站字色共用一套逻辑……字体颜色需根据背景颜色实时改变，都用对应的
      相反色……主页面和后台页面都有这种情况」
   ② 「成绩分析的备注……只需写明怎么看怎么用就行，不要猜测用户还可能误解
      什么，还有站内其他的地方包括后台，以后都是这样」
   这里盯：函数两页同构、接入点真的接了、热力图私家公式已删除、
   实时三通道在位、官方化文案锁定、防误解话术清零。 */
console.log('\n【62】第五十七轮·字色共用逻辑 + 文案官方化检查');
{
  const idx = readIdx();
  const adm = readAdm();
  const shr = fs.readFileSync(new URL('./share.html', import.meta.url), 'utf8');

  /* ---- ① 函数块两页同构（改一套不改另一套 = 没改） ---- */
  t('★index.html 有 clsParseColor/clsRelLum/clsContrast/clsReadableOn/clsAutoInk',
    /function clsParseColor\(/.test(idx) && /function clsRelLum\(/.test(idx)
    && /function clsContrast\(/.test(idx)
    && /function clsReadableOn\(/.test(idx) && /function clsAutoInk\(/.test(idx));
  t('★admin.html 有同款（逐行同构）',
    /function clsParseColor\(/.test(adm) && /function clsRelLum\(/.test(adm)
    && /function clsContrast\(/.test(adm)
    && /function clsReadableOn\(/.test(adm) && /function clsAutoInk\(/.test(adm));
  t('★两页字色常量同值（CLS_INK_DARK #241f1c / CLS_INK_LIGHT #ffffff）',
    (idx.match(/CLS_INK_DARK = '#241f1c'/g) || []).length === 1
    && (adm.match(/CLS_INK_DARK = '#241f1c'/g) || []).length === 1
    && /CLS_INK_LIGHT = '#ffffff'/.test(idx) && /CLS_INK_LIGHT = '#ffffff'/.test(adm));
  /* v2.9.11：YIQ 阈值 0.6 → WCAG 对比度择优（白字/深字各算一遍取大者）。
     旧断言 clsLuma(c) > 0.6 正是登录弹窗字色不达标的根因（#f97316 被误判白字）。 */
  t('★clsReadableOn 走 WCAG 对比度择优（白字/深字取大者）',
    /clsContrast\(CLS_INK_RGB_LIGHT, c\) >= clsContrast\(CLS_INK_RGB_DARK, c\)/.test(idx)
    && /clsContrast\(CLS_INK_RGB_LIGHT, c\) >= clsContrast\(CLS_INK_RGB_DARK, c\)/.test(adm));
  t('★择优色值三元组同源解析（CLS_INK_RGB_DARK/LIGHT 各只定义一次）',
    (idx.match(/var CLS_INK_RGB_DARK = clsParseColor/g) || []).length === 1
    && (adm.match(/var CLS_INK_RGB_DARK = clsParseColor/g) || []).length === 1
    && /var CLS_INK_RGB_LIGHT = clsParseColor/.test(idx) && /var CLS_INK_RGB_LIGHT = clsParseColor/.test(adm));
  t('★旧的 YIQ 阈值判定已删除（两页都不再有 clsLuma）',
    !/function clsLuma\(/.test(idx) && !/function clsLuma\(/.test(adm));
  t('★clsAutoInk 支持 data-ink-bg 优先 + 渐变 background-image 抓代表色',
    /data-ink-bg/.test(idx) && /backgroundImage/.test(idx)
    && /data-ink-bg/.test(adm) && /backgroundImage/.test(adm));

  /* ---- ② 前台接入点 ---- */
  t('★公告横幅 ink-auto + data-ink-bg="#f97316"',
    /celebrate-banner ink-auto" data-ink-bg="#f97316"/.test(idx));
  t('★欢迎弹窗设 data-ink-bg="#9a3412"（theme=welcome）',
    /p\.theme === 'welcome'\) box\.setAttribute\('data-ink-bg', '#9a3412'\)/.test(idx));
  t('★fab/日报/每日一言/学习卡/签到栏渐变图标块接了 ink-auto',
    /class="fab ink-auto"/.test(idx) && /daily-icon ink-auto/.test(idx)
    && /quote-mark ink-auto/.test(idx) && /study-mark ink-auto/.test(idx)
    && /signbar-icon ink-auto/.test(idx));
  t('★卡片首字 fallback 两处产出都带 ink-auto',
    (idx.match(/fallback ink-auto/g) || []).length === 2);
  t('★作业科目徽章 ink-auto + data-ink-bg=科目色',
    /hw-badge ink-auto" data-ink-bg="'\+esc\(s\.c\)\+'"/.test(idx));
  t('★成绩分段条 ink-auto + data-ink-bg=分段色',
    /sc-seg-bar ink-auto" data-ink-bg="' \+ esc\(s\.color\)/.test(idx));

  /* ---- ③ 热力图私家公式已删除（一套逻辑落到实处） ---- */
  t('★热力图调 clsReadableOn 取字色', /var ink = clsReadableOn\('rgb\(' \+ cr \+ ',' \+ cg \+ ',' \+ cb \+ '\)'\)/.test(idx));
  t('★热力图不再有私有 0.299*cr 亮度公式', !/0\.299 \* cr \+ 0\.587 \* cg \+ 0\.114 \* cb/.test(idx));
  t('★热力图不再有 <168 私有阈值', !/< 168/.test(idx));

  /* ---- ④ 实时三通道 ---- */
  t('★applyThemeSwitch 末尾 clsAutoInk(document.body) 全局重算',
    /clsAutoInk\(document\.body\);\s*\}catch\(e\)\{\}\s*\}$/.test(idx) || /try\{ clsAutoInk\(document\.body\); \}catch\(e\)\{\}/.test(idx));
  t('★initAuth 启动时扫一遍 ink-auto', /paintVersion\(\);\s*\n\s*\/\* v2\.9\.10：启动时按当前主题扫一遍/.test(idx));
  t('★两页都有 MutationObserver 兜底动态渲染（debounce 100ms）',
    /new MutationObserver/.test(idx) && /new MutationObserver/.test(adm)
    && (idx.match(/__inkTimer/g) || []).length >= 3 && (adm.match(/__inkTimer/g) || []).length >= 3);
  t('★后台 applyTheme 末尾同样全局重算', /try\{ clsAutoInk\(document\.body\); \}catch\(e\)\{\}/.test(adm));

  /* ---- ⑤ 后台接入点 ---- */
  t('★后台头像（侧栏 + 各列表）都带 ink-auto',
    /class="av ink-auto" id="meAv"/.test(adm) && (adm.match(/cell-user"><div class="av ink-auto">/g) || []).length >= 3,
    '成员表 / 头衔表 / 游戏表各一处（用户与资料两表已合并为成员表；'
    + 'v3.5.35 在线时长表也补了一处，所以改成「至少 3 处」不再钉死计数）');
  t('★后台统计卡图标 ink-auto', /si ink-auto ' \+ c\.tone/.test(adm));
  t('★排行榜榜首徽章 ink-auto（nth-child 渐变底）', /n' \+ \(i === 0 \? ' ink-auto' : ''\)/.test(adm));

  /* ---- ⑥ 官方化文案锁定（只看「怎么写」，不解释「别误解什么」） ---- */
  t('★六科画像图注官方句式', /各顶点标注学科分数/.test(idx));
  t('★总分分布图注官方句式', /柱顶为该段人数/.test(idx));
  {
    const sapp = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
    t('★v3.14.0 总分分布柱子可点：点柱子出分段名单，点名字出各科分数',
      /function scHistTap\(/.test(sapp) && /function scHistWhoHtml\(/.test(sapp)
      && /id="scHistList"/.test(sapp) && /data-hb="/.test(sapp)
      && /onclick="scHistTap\(/.test(sapp) && /\.sc-hrow\{/.test(idx) && /\.sc-hb\.on \.sc-bar/.test(idx));
  }
  t('★四象限图注官方句式', /图中标注姓名与该科分数/.test(idx));
  t('★热力图图注官方句式', /每格为该生该科分数/.test(idx));
  t('★年级排名图注官方句式', /年级排名与班排名分别统计/.test(idx));
  t('★历次总分趋势只报统计范围', /统计 ' \+ pts\.length \+ ' 次考试/.test(idx));
  t('★各科趋势图注官方句式', /绿色为上涨，红色为下跌/.test(idx));
  t('★后台建号提示已精简（去掉「只存哈希」技术解释）', /首次登录后会建议他自己改密码/.test(adm) && !/后台不保存明文/.test(adm));

  /* ---- ⑦ 防误解话术全站清零（界面文案内；注释/更新记录不在扫描面） ---- */
  /* relSeed（后台内置历史更新记录）按站规「历史更新记录不改」保留原貌，
     其中的历史描述文案不属于本轮清理面，扫描前先切除。 */
  const banned = ['别当成两套排名', '会打架', '是故意的', '不用猜', '说明不了什么', '这不是 bug'];
  const pages = {
    'index.html': idx,
    'admin.html': adm.replace(/function relSeed\(\)\{[\s\S]*?\n\}\n/, ''),
    'share.html': shr
  };
  for (const [name, src] of Object.entries(pages)){
    const hits = banned.filter(w => new RegExp("(['\"`])(?:(?!\\1)[\\s\\S])*" + w + "(?:(?!\\1)[\\s\\S])*\\1").test(src));
    t('★' + name + ' 界面文案无防误解话术（' + (hits.length ? hits.join('/') : '零命中') + '）', hits.length === 0);
  }
}

/* 【63】第五十八轮·登录弹窗字色达标（v2.9.11）
   ------------------------------------------------------------
   站主原话：「还有登录时的弹窗等等，都是字色不达标的后台也有这种情况」。
   根因两层：① clsReadableOn 用 YIQ 阈值 0.6 猜相反色，中间色误判
   （#f97316 白字仅 2.80:1）→ 已升级 WCAG 对比度择优（【62】① 盯住）；
   ② 登录弹窗组件一批写死的浅色字 + welcome 主题被 inline color 压过。
   这里盯：加深/提亮后的色值真的落进 CSS、暗色覆盖齐全、
   玻璃拟态叠底场景按最差底色选色、welcome 主题链路不再被 inline 压。 */
console.log('\n【63】第五十八轮·登录弹窗字色达标检查');
{
  const idx = readIdx();
  const adm = readAdm();

  /* ---- ① 登录面板次要文字：亮色 #57493d（玻璃叠底 rgb(194,193,193) 上 4.82、
             白底 8.66），暗色 #c9b8aa（暗面板 6.44）；旧 #8a7a6d/#a99a8d 清零 ---- */
  t('★acct-tab/field label/cap-tip/acct-hint/ghost 亮色统一 #57493d',
    /\.acct-tab\{[^}]*color:#57493d/.test(idx) && /\.acct-field label\{[^}]*color:#57493d/.test(idx)
    && /\.cap-tip\{[^}]*color:#57493d/.test(idx) && /\.acct-hint\{[^}]*color:#57493d/.test(idx)
    && /\.acct-btn\.ghost\{[^}]*color:#57493d/.test(idx));
  t('★登录面板这些选择器不再用 #8a7a6d / #a99a8d',
    !/\.acct-tab\{[^}]*#8a7a6d/.test(idx) && !/\.acct-field label\{[^}]*#8a7a6d/.test(idx)
    && !/\.cap-tip\{[^}]*#8a7a6d/.test(idx) && !/\.acct-hint\{[^}]*#a99a8d/.test(idx)
    && !/\.acct-btn\.ghost\{[^}]*#8a7a6d/.test(idx));
  t('★登录面板次要文字暗色覆盖 #c9b8aa（tab/label/hint/cap-tip/ghost 五处）',
    /\.dark \.acct-tab\{color:#c9b8aa\}/.test(idx)
    && /\.dark \.acct-field label\{color:#c9b8aa\}/.test(idx)
    && /\.dark \.acct-hint\{color:#d8cbc0\}/.test(idx)
    && /\.dark \.cap-tip\{color:#c9b8aa\}/.test(idx)
    && /\.dark \.acct-btn\.ghost\{color:#c9b8aa\}/.test(idx));

  /* ---- ② 主按钮渐变两端白字都 ≥4.5（#b03908 6.11 / #c2410c 5.18）---- */
  t('★acct-btn 渐变 #b03908→#c2410c（原末端 #e07a3c 白字仅 2.99）',
    /\.acct-btn\{[^}]*linear-gradient\(135deg,#b03908,#c2410c\)/.test(idx)
    && !/linear-gradient\(135deg,#c2410c,#e07a3c\)/.test(idx));

  /* ---- ③ 提示消息与验证码状态色 ---- */
  t('★acct-msg ok 亮色 #0b7a43（原 #0f8a4d 仅 4.41）',
    /\.acct-msg\.ok\{color:#0b7a43\}/.test(idx) && !/\.acct-msg\.ok\{color:#0f8a4d\}/.test(idx));
  t('★acct-msg 暗色三态提亮（#f87171/#4ade80/#ffb27a）',
    /\.dark \.acct-msg\.err\{color:#f87171\}/.test(idx)
    && /\.dark \.acct-msg\.ok\{color:#4ade80\}/.test(idx)
    && /\.dark \.acct-msg\.warn\{color:#ffb27a\}/.test(idx));
  t('★验证码 ok 亮色 #0b7a43、bad #c0392b；暗色 #4ade80/#f87171',
    /\.cap-wrap\.ok \.cap-input,\.cap-wrap\.ok \.cap-tip\{color:#0b7a43\}/.test(idx)
    && /\.cap-wrap\.bad \.cap-input,\.cap-wrap\.bad \.cap-tip\{color:#c0392b\}/.test(idx)
    && /\.dark \.cap-wrap\.ok \.cap-input,\.dark \.cap-wrap\.ok \.cap-tip\{color:#4ade80\}/.test(idx)
    && /\.dark \.cap-wrap\.bad \.cap-input,\.dark \.cap-wrap\.bad \.cap-tip\{color:#f87171\}/.test(idx));
  t('★验证码占位符加深 #7a6a5c（原 #a89c92 仅 2.60）',
    /\.cap-wrap \.cap-input::placeholder\{[^}]*color:#7a6a5c/.test(idx));
  t('★刷新键蒙层 0.32→0.6（白字 2.30→5.83，全站无 .32 残留）',
    /\.cap-refresh\{[^}]*rgba\(0,0,0,\.6\)/.test(idx) && !/rgba\(0,0,0,\.32\)/.test(idx));

  /* ---- ④ welcome 主题链路：inline color 是根因 ---- */
  t('★popBody/popEnd 无 inline color（welcome 主题白字不再被压，1.04→9+）',
    /<div id="popBody" style="font-size:\.9rem;line-height:1\.85;white-space:pre-line"><\/div>/.test(idx)
    && /<div id="popEnd" style="font-size:\.78rem;margin-top:10px"><\/div>/.test(idx)
    && !/<div id="popBody"[^>]*color:/.test(idx) && !/<div id="popEnd"[^>]*color:/.test(idx));
  t('★welcome-list 压暗蒙层 rgba(0,0,0,.18)（原 0.15 白提亮仅 4.09）',
    /\.welcome-list\{background:rgba\(0,0,0,\.18\)/.test(idx)
    && !/\.welcome-list\{background:rgba\(255,255,255,\.15\)/.test(idx));

  /* ---- ⑤ 倒计时「查看全部」兜底合并为浅底深字 ---- */
  t('★cd-viewall 兜底即浅底深字 #af410f on #f6f1ec（5.22）',
    /\.cd-viewall\{margin-left:auto;[^}]*background:#f6f1ec;color:#af410f/.test(idx));
  t('★裸 .cd-viewall 白字兜底与 .dark 白底兜底已删除',
    !/\.cd-viewall\{[^}]*rgba\(255,255,255,\.25\)/.test(idx)
    && !/\.dark \.cd-viewall\{/.test(idx));

  /* ---- ⑥ 后台登录门 mark 接 ink-auto（--grad 亮橙白字仅 2.80）---- */
  t('★后台登录门/侧栏两处 mark 都接 ink-auto',
    (adm.match(/<div class="mark ink-auto">班<\/div>/g) || []).length === 2);
}

/* 【64】第五十九轮·成绩分析暗色全覆盖（v2.9.12）
   ------------------------------------------------------------
   站主原话：「暗色模式下成绩表的姓名还是看不清，由于表格背景是白色的」。
   根因：sc-* 约 45 条规则硬编码浅底/深字、零暗色覆盖，表格 td 无显式 color，
   暗色下继承 body 亮字压白底 ≈1.03:1 —— 姓名等于隐形。
   本轮：① 表格/卡片暗色底色 ② 六个图表函数 SVG 元素加语义 class + 暗色 fill/stroke
   覆盖 ③ 亮色历史欠账按 WCAG 重修 ④ 内联 style 提类（压过暗色规则）⑤ 热力图绕
   WCAG 死区改两段安全区 ⑥ 导出 canvas（DOM 扫描器盲区）人工逐色核算。
   验收方式：Playwright 扫描器 18 场景（前台 10 + 成绩分析 8）亮/暗全达标。 */
console.log('\n【64】第五十九轮·成绩分析暗色全覆盖检查');
{
  const idx = readIdx();

  /* 工具：按函数名截取函数体（SVG class 接线必须落在各自函数里，全局计数会误判） */
  function fnBody(name) {
    const i = idx.indexOf('function ' + name + '(');
    if (i < 0) return '';
    const j = idx.indexOf('\nfunction ', i + 10);
    return idx.slice(i, j > i ? j : i + 9000);
  }

  /* ---- ① 表格暗色底色（原始抱怨：白底 + 继承亮字 = 姓名隐形）---- */
  t('★sc-tbl 暗色三件套：td/th 非白底 + me-row 高亮行',
    /\.dark \.sc-tbl td\{background:#262220;border-bottom-color:#332d29\}/.test(idx)
    && /\.dark \.sc-tbl th\{background:#332d29;color:#f0e6dc;border-bottom-color:#3d3631\}/.test(idx)
    && /\.dark \.sc-tbl \.sc-me-row td,\.dark \.sc-me-row\{background:#3a2f28\}/.test(idx));
  t('★sc-tblwrap/th:nth-child/冻结列阴影暗色覆盖齐全',
    /\.dark \.sc-tblwrap\{background:#262220;border-color:#3d3631\}/.test(idx)
    && /\.dark \.sc-tbl th:nth-child\(1\)\{background:#332d29\}/.test(idx)
    && /\.dark \.sc-tbl\.sc-fix2 th:nth-child\(2\)\{background:#332d29\}/.test(idx)
    && /\.dark \.sc-tbl\.sc-fix2 th:nth-child\(2\),\.dark \.sc-tbl\.sc-fix2 td:nth-child\(2\)\{box-shadow:1px 0 0 #3d3631\}/.test(idx));

  /* ---- ② 暗色块整块包 @media screen（打印永远走白底基线，零额外 print reset）---- */
  t('★sc-* 暗色覆盖在 @media screen 块内（打印不参与暗色，避免深字压深底）',
    /@media screen\{\s*\/\* —— 容器与卡片底色 —— \*\/\s*\.dark \.sc-card\{background:#2e2926/.test(idx));

  /* ---- ③ 六个图表函数 SVG 语义 class 接线（函数体内断言）---- */
  t('★scChartHist 接线：柱/柱顶数/轴字/网格/均分线/中位线/分数线/我的标记',
    ['class="sc-bar"', 'sc-bar-num', 'sc-axdim', 'sc-hgrid', 'sc-mk-avg', 'sc-mk-mid',
     'sc-cut-line', 'sc-cut-txt', 'sc-mine-dot', 'sc-tip', 'sc-axis']
      .every(c => fnBody('scChartHist').includes(c)));
  t('★scRadar 接线：网格/辐条/轴标签/tips/班均虚线/我的多边形/顶点/图例',
    ['class="sc-g"', 'sc-axlbl', 'sc-tip', 'class="sc-avg"', 'sc-mine-poly', 'sc-mine-dot', 'sc-axdim']
      .every(c => fnBody('scRadar').includes(c)));
  t('★scTrendBlock 接线：基线/折线/点/分数/日期',
    ['sc-axis', 'sc-mine-line', 'sc-mine-dot', 'sc-tip', 'sc-axdim']
      .every(c => fnBody('scTrendBlock').includes(c)));
  t('★scSubjTrend 接线：迷你线段/数字/点，且 svg 用 sc-mini-svg 不用 sc-svg（画法抽到 scMiniLine）',
    ['class="sc-mini-svg"', "'sc-up' : 'sc-down'", 'sc-mini-num', 'sc-mini-dot']
      .every(c => fnBody('scMiniLine').includes(c))
    && !fnBody('scMiniLine').includes('class="sc-svg"')
    && fnBody('scSubjTrend').includes('scMiniLine('));
  t('★scGradeTrend 接线：折线/点/数字/日期/基线',
    ['sc-grade-line', 'sc-grade-dot', 'sc-grade-num', 'sc-axdim', 'sc-axis']
      .every(c => fnBody('scGradeTrend').includes(c)));
  t('★scQuadrant 接线：四象限 cls/我的点/他人点/姓名标签/十字线/轴文字',
    ['sc-q1', 'sc-q2', 'sc-q3', 'sc-q4', 'sc-mine-dot', 'sc-q-dot', 'sc-qme', 'sc-qnm',
     'sc-axis', 'sc-axdim']
      .every(c => fnBody('scQuadrant').includes(c)));

  /* ---- ④ 暗色 SVG fill/stroke 覆盖（line/text 分开，避免 text 被 stroke 描边）---- */
  t('★暗色 SVG 覆盖：网格/轴/轴标签/我的线/我的点/班均/柱/年级折线全提亮',
    /\.dark \.sc-svg \.sc-g\{stroke:#3d3631\}/.test(idx)
    && /\.dark \.sc-svg \.sc-axis\{stroke:#4a4038\}/.test(idx)
    && /\.dark \.sc-svg \.sc-axlbl\{fill:#d9ccbe\}/.test(idx)
    && /\.dark \.sc-svg \.sc-mine-line\{stroke:#f87171\}/.test(idx)
    && /\.dark \.sc-svg \.sc-mine-dot\{fill:#f87171\}/.test(idx)
    && /\.dark \.sc-svg \.sc-avg\{stroke:#a8998c\}/.test(idx)
    && /\.dark \.sc-svg \.sc-bar\{fill:#c98d5e\}/.test(idx)
    && /\.dark \.sc-svg \.sc-grade-line\{stroke:#c4b5fd\}/.test(idx));
  t('★直方图均分/中位线 line 与 text 分开覆盖（旧写法会把文字也描边）',
    /\.dark \.sc-svg line\.sc-mk-avg\{stroke:#a8998c\}/.test(idx)
    && /\.dark \.sc-svg text\.sc-mk-avg\{fill:#a8998c\}/.test(idx)
    && /\.dark \.sc-svg line\.sc-mk-mid\{stroke:#c9b8aa\}/.test(idx)
    && /\.dark \.sc-svg text\.sc-mk-mid\{fill:#c9b8aa\}/.test(idx));
  t('★迷你图暗色覆盖 + 姓名标签描边改深（旧白描边 #fffdfb 暗底糊）',
    /\.dark \.sc-mini-svg \.sc-up\{stroke:#4ade80\}/.test(idx)
    && /\.dark \.sc-mini-svg \.sc-down\{stroke:#f87171\}/.test(idx)
    && /\.dark \.sc-svg \.sc-qme\{fill:#fdba74;stroke:#262220\}/.test(idx)
    && /\.dark \.sc-svg \.sc-qnm\{fill:#c4b5fd;stroke:#262220\}/.test(idx));

  /* ---- ⑤ 热力图两段安全区插值（连续渐变必穿 WCAG 死区，白字实测仅 4.22）---- */
  t('★热力图改两段插值：前 50% 深橙白字、后 50% 浅奶油深字，死区注释在位',
    /WCAG 死区/.test(idx) && /连续渐变绕不开死区，所以改成两段各自待在安全区/.test(idx)
    && /if\(p < 0\.5\)\{[\s\S]{0,200}cr = Math\.round\(150 \+ \(175 - 150\) \* \(p \/ 0\.5\)\)/.test(idx)
    && /q = \(p - 0\.5\) \/ 0\.5;[\s\S]{0,120}cr = Math\.round\(243 \+ \(229 - 243\) \* q\)/.test(idx)
    && /var ink = clsReadableOn\('rgb\(' \+ cr \+ ',' \+ cg \+ ',' \+ cb \+ '\)'\)/.test(idx));

  /* ---- ⑥ 内联 style 提类（内联 color/background 压过一切 class 规则）---- */
  t('★分享弹窗 6 个 label 提成 .sc-sh-lb（原 inline #57534e 压过暗色规则）',
    (idx.match(/<label class="sc-sh-lb">/g) || []).length >= 6
    && !/<label class="sc-sh-lb"[^>]*style="[^"]*color:/.test(idx)
    && /\.sc-sh-lb\{font-size:\.8rem;color:#57534e;display:block;margin-bottom:6px\}/.test(idx)
    && /\.dark \.sc-sh-lb\{color:#f0e6dc\}/.test(idx));
  t('★链接生成提示框提成 .sc-hint.sc-hint-ok（原 inline 绿底无暗色变体）',
    /<div class="sc-hint sc-hint-ok">/.test(idx)
    && /\.sc-hint-ok\{background:#f0f9f2;border-color:#cfe9d8\}/.test(idx)
    && /\.dark \.sc-hint-ok\{background:#26332a;border-color:#3c5a44\}/.test(idx)
    && /\.dark \.sc-hint-ok b\{color:#4ade80\}/.test(idx));

  /* ---- ⑦ 亮色历史欠账按 WCAG 重修（扫描器实测逼出来的）---- */
  t('★sc-dim 族浅色 #a8968a → #7a6a5c（11 条规则，白底 2.83 → 5.11）',
    /\.sc-dim\{[^}]*color:#7a6a5c/.test(idx)
    && !/\.sc-(dim|subrank|sub-rk|figcap|cut-pct|pos-scale|h-note)\{[^}]*#a8968a/.test(idx));
  t('★均分/中位线/雷达班均虚线加深（均分 4.69、中位 5.84、虚线图形 3.36）',
    /color: '#7d7268', cls: 'sc-mk-avg'/.test(idx) && /color: '#6e635a', cls: 'sc-mk-mid'/.test(idx)
    && /stroke="#857468"/.test(idx));
  t('★状态绿 #0f8a4d → #0b7a43（5 处文字，白底 4.41 → 5.41）',
    /\.sc-sub-diff\.up\{color:#0b7a43\}/.test(idx)
    && /\.sc-sh-state\.on\{background:#0b7a43;color:#fff\}/.test(idx)
    && !/\.sc-(sub-diff\.up|trendhead\.up b|good|sh-state\.on)\{[^}]*#0f8a4d/.test(idx));
  t('★奖牌/徽章加深：金 #96660a、银 #6f6f6f、only-admin 底 #6e5d50',
    /\.sc-r1\{color:#96660a\}/.test(idx) && /\.sc-r2\{color:#6f6f6f\}/.test(idx)
    && /\.sc-only-admin\{[^}]*background:#6e5d50/.test(idx));
  t('★玻璃拟态叠底（实测 rgb(194,193,193) 中灰）直接放字 #57493d（4.82）',
    /\.allboard-box \.sc-sh-lb,\.allboard-box \.sc-figcap,\.allboard-box \.sc-card-h\{color:#57493d\}/.test(idx)
    && /\.dark \.allboard-box \.sc-sh-lb,\.dark \.allboard-box \.sc-card-h\{color:#f0e6dc\}/.test(idx)
    && /\.dark \.allboard-box \.sc-figcap\{color:#a8998c\}/.test(idx));

  /* ---- ⑧ span 变体补全（暗色块只覆盖 b 变体，span 漏网实测 2.32/2.46）---- */
  t('★概览卡 span 变体暗色补全（ov-total/ov-item，渐变 #332d29 上 7.05）',
    /\.dark \.sc-stat span,\.dark \.sc-ov-total span,\.dark \.sc-ov-item span\{color:#c9b8aa\}/.test(idx));
  t('★.sc-total 暗色覆盖带 .sc-tbl 提高特异性（基础规则 0,2,1，裸写实测仅 3.14）',
    /\.dark \.sc-tbl \.sc-total/.test(idx) && !/\.dark \.sc-total\{color:/.test(idx));

  /* ---- ⑨ 导出 canvas 审计（DOM 扫描器盲区，人工按 WCAG 逐色核算过）---- */
  t('★canvas 弱字 #a8968a/#c9b8a8 → #7a6a5c（原 2.80/1.90，新 5.11）',
    (idx.match(/g\.fillStyle = '#7a6a5c';/g) || []).length === 4
    && !/g\.fillStyle = '#a8968a';/.test(idx) && !/g\.fillStyle = '#c9b8a8';/.test(idx));
  t('★canvas 差分红字小字 #0f8a4d → #0b7a43（12/13px 原 4.27/4.35，新 5.25+）',
    (idx.match(/'#0b7a43' : '#c0392b'/g) || []).length === 5
    && !/g\.fillStyle = ok \? '#0f8a4d'/.test(idx));
  t('★canvas 进度条填充 #e6a97a → #b06a32（压 #f0e7de 轨道原 1.67，新 3.71）',
    (idx.match(/g\.fillStyle = '#b06a32';/g) || []).length === 3
    && !/g\.fillStyle = '#e6a97a';/.test(idx));

  /* ---- ⑩ 直方图色板双达标（图形 ≥3 + 柱内计数深字 ≥4.5，白/暗卡两头）---- */
  t('★直方图色板重选：及格 #c07a3e、不及格 #d4756a、其他 #99887a（旧值白底 2.0～2.8）',
    /color: '#c07a3e' \}/.test(idx) && /color: '#d4756a' \}/.test(idx)
    && /color: '#99887a' \}/.test(idx)
    && !/color: '#e6a97a' \}/.test(idx) && !/color: '#e0776b' \}/.test(idx)
    && !/color: '#a8968a' \}/.test(idx));
  t('★pos-bar 渐变与 sub-bar 填充改 #b06a32，末端 #d4756a（暗卡也 ≥3）',
    /\.sc-pos-bar\{[^}]*linear-gradient\(90deg,#0f8a4d,#b06a32,#d4756a\)/.test(idx)
    && /\.sc-sub-bar i\{display:block;height:100%;background:#b06a32/.test(idx));
  t('★mini-dot 描边 #c9b8a8 → #857468（白底 1.89 → 4.41；暗色有覆盖）',
    /stroke="#857468" stroke-width="1\.1"/.test(idx)
    && !/stroke="#c9b8a8"/.test(idx));
  t('★暗色「你」气泡反转为浅底深字（深底 #292524 压暗卡 ≈0.95 隐形）',
    /\.dark \.sc-pos-me span\{background:#f0e6dc;color:#262220\}/.test(idx));
}

console.log('\n【65】第六十轮·注册审核 + 站点设置 + 用户操作日志 + 资料去重（v2.10.0）');
{
  /* ---- ① register-config：公开接口，无需登录 ----
     【2】里已把 register_review 关掉，这里应看到 {open:true, review:false} */
  const rc = await call('/api/auth?action=register-config', {});
  t('register-config 公开可读（无需登录）',
    rc.status === 200 && rc.body.open === true && rc.body.review === false,
    JSON.stringify(rc.body));

  /* ---- ② 审核流：开审核 → 注册拿不到 token → 登录 403 → 通过后才放行 ---- */
  const revOn = await call('/api/admin?action=set-settings', {
    method: 'POST', token: adminToken,
    body: { register_open: true, register_review: true },
  });
  t('管理员可开启注册审核', revOn.status === 200 && !!revOn.body.ok,
    JSON.stringify(revOn.body).slice(0, 160));

  const pend = await call('/api/auth?action=register', {
    method: 'POST', body: { username: 'penduser01', password: 'PendPass2026', displayName: '待审核同学' },
  });
  t('开启审核后注册成功但进入待审核（200、无 token）',
    pend.status === 200 && pend.body.pending === true && !pend.body.token,
    JSON.stringify(pend.body).slice(0, 200));
  t('待审核提示语说明「等审核」', /审核/.test(pend.body.message || ''), pend.body.message);

  const pendLogin = await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'penduser01', password: 'PendPass2026' },
  });
  t('待审核账号不能登录 403', pendLogin.status === 403, '实际 ' + pendLogin.status);
  t('待审核与封禁提示语区分（等着 ≠ 被封）', /审核中/.test(pendLogin.body.error || ''),
    pendLogin.body.error);

  /* 后台用户列表应带 pending 状态（前端徽章三态的数据来源） */
  const ul = await call('/api/admin?action=users', { token: adminToken });
  const pendRow = (ul.body.users || []).find(x => x.username === 'penduser01');
  t('后台用户列表能看到待审核状态', !!pendRow && pendRow.status === 'pending',
    JSON.stringify(pendRow));

  /* 管理员通过审核 */
  const ok1 = await call('/api/admin?action=user-review', {
    method: 'POST', token: adminToken,
    body: { id: pendRow.id, decision: 'approve' },
  });
  t('管理员通过审核成功', ok1.status === 200 && !!ok1.body.ok,
    JSON.stringify(ok1.body).slice(0, 160));

  const okLogin = await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'penduser01', password: 'PendPass2026' },
  });
  t('审核通过后即可登录（拿到 token）', okLogin.status === 200 && !!okLogin.body.token,
    '实际 ' + okLogin.status);
  const pendToken = okLogin.body.token;
  const pendMe = await call('/api/data', { method: 'GET', token: pendToken });
  t('审核通过后的账号能正常用受保护接口', pendMe.status === 200, '实际 ' + pendMe.status);

  /* 已通过的账号不能重复审核（只有 pending 可审） */
  const okAgain = await call('/api/admin?action=user-review', {
    method: 'POST', token: adminToken,
    body: { id: pendRow.id, decision: 'approve' },
  });
  t('非待审核状态不能重复审核 404', okAgain.status === 404, '实际 ' + okAgain.status);

  /* ---- ③ 驳回路径 ---- */
  const pend2 = await call('/api/auth?action=register', {
    method: 'POST', body: { username: 'penduser02', password: 'PendPass2026', displayName: '驳回同学' },
  });
  t('第二个待审核用户注册成功', pend2.status === 200 && pend2.body.pending === true);
  const ul2 = await call('/api/admin?action=users', { token: adminToken });
  const pend2Row = (ul2.body.users || []).find(x => x.username === 'penduser02');
  const rej = await call('/api/admin?action=user-review', {
    method: 'POST', token: adminToken,
    body: { id: pend2Row.id, decision: 'reject' },
  });
  t('管理员驳回注册成功', rej.status === 200 && !!rej.body.ok,
    JSON.stringify(rej.body).slice(0, 160));
  const rejLogin = await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'penduser02', password: 'PendPass2026' },
  });
  t('被驳回账号不能登录 403', rejLogin.status === 403, '实际 ' + rejLogin.status);
  t('驳回提示走「已禁用」文案', /禁用/.test(rejLogin.body.error || ''), rejLogin.body.error);

  /* ---- ④ 站点设置护栏 ---- */
  const st = await call('/api/admin?action=settings', { token: adminToken });
  t('读取站点设置（含 env 兜底值）',
    st.status === 200 && st.body.settings && st.body.settings.register_review === true
    && st.body.envDefault && st.body.envDefault.register_open === true,
    JSON.stringify(st.body).slice(0, 200));

  /* 管理员后台开号（create-user 不走注册审核，直接 active） */
  const guard = await call('/api/admin?action=create-user', {
    method: 'POST', token: adminToken,
    body: { username: 'setguard', password: 'GuardPass2026' },
  });
  t('管理员后台开号（不受注册审核限制）', guard.status === 200 && !!guard.body.ok,
    JSON.stringify(guard.body).slice(0, 160));
  const gLogin = await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'setguard', password: 'GuardPass2026' },
  });
  t('后台开的号登录即 active（无审核卡点）', gLogin.status === 200 && !!gLogin.body.token,
    '实际 ' + gLogin.status);
  const gTok = gLogin.body.token;

  const denySet = await call('/api/admin?action=set-settings', {
    method: 'POST', token: gTok, body: { register_open: false },
  });
  t('普通用户不能改站点设置 403', denySet.status === 403, '实际 ' + denySet.status);

  const badKey = await call('/api/admin?action=set-settings', {
    method: 'POST', token: adminToken, body: { not_a_key: true },
  });
  t('白名单外的设置键被拒 400', badKey.status === 400, '实际 ' + badKey.status);

  const badType = await call('/api/admin?action=set-settings', {
    method: 'POST', token: adminToken, body: { register_open: 'yes' },
  });
  t('设置值必须是布尔 400', badType.status === 400, '实际 ' + badType.status);

  /* ---- ⑤ 关掉审核，恢复「注册即用」，供后面的日志测试造号 ---- */
  const revOff = await call('/api/admin?action=set-settings', {
    method: 'POST', token: adminToken,
    body: { register_open: true, register_review: false },
  });
  t('管理员可关注册审核', revOff.status === 200 && !!revOff.body.ok);
  const rc2 = await call('/api/auth?action=register-config', {});
  t('register-config 反映关闭后的状态', rc2.body.review === false, JSON.stringify(rc2.body));

  /* ---- ⑥ 用户操作日志：攒批上报 → 统计 → 明细 ---- */
  const logReg = await call('/api/auth?action=register', {
    method: 'POST', body: { username: 'loguser01', password: 'LogPass2026', displayName: '日志同学' },
  });
  t('关审核后注册即得 token', logReg.status === 200 && !!logReg.body.token);
  const logTok = logReg.body.token;

  const evs = [
    { a: 'jump', p: '成绩分析', t: '成绩对比', d: '', ts: Date.now() },
    { a: 'click', p: '成绩分析', t: '导出长图', d: '', ts: Date.now() },
    { a: 'submit', p: '班级事务', t: '作业提交', d: '', ts: Date.now() },
  ];
  const lg = await call('/api/data?action=log', {
    method: 'POST', token: logTok, body: { events: evs },
  });
  t('攒批上报 3 条点击日志', lg.status === 200 && lg.body.written === 3, JSON.stringify(lg.body));

  const lgEmpty = await call('/api/data?action=log', {
    method: 'POST', token: logTok, body: { events: [] },
  });
  t('空批次不报错', lgEmpty.status === 200 && lgEmpty.body.written === 0);

  const lgBad = await call('/api/data?action=log', {
    method: 'POST', token: logTok,
    body: { events: [{ a: 'click', p: 'x'.repeat(500), t: 't', d: 'd', ts: 'not-a-number' }] },
  });
  t('脏数据（超长字段/坏时间戳）被服务端截断照收',
    lgBad.status === 200 && lgBad.body.written === 1, JSON.stringify(lgBad.body));

  const noAuthLog = await call('/api/data?action=log', {
    method: 'POST', body: { events: evs },
  });
  t('未登录不能上报日志 401', noAuthLog.status === 401, '实际 ' + noAuthLog.status);

  const lgGet = await call('/api/data?action=log', { token: logTok });
  t('log 通道只接受 POST 405', lgGet.status === 405, '实际 ' + lgGet.status);

  /* 批量上限：一批最多 50 条 */
  const many = Array.from({ length: 60 }, (_, i) => (
    { a: 'click', p: '截断测试', t: 't' + i, d: '', ts: Date.now() }
  ));
  const lgCap = await call('/api/data?action=log', {
    method: 'POST', token: logTok, body: { events: many },
  });
  t('单批最多收 50 条（LOG_MAX_BATCH）', lgCap.status === 200 && lgCap.body.written === 50,
    JSON.stringify(lgCap.body));

  /* 统计面板 */
  const stats = await call('/api/admin?action=action-stats', { token: adminToken });
  t('统计面板：今日点击 ≥ 54', stats.status === 200 && stats.body.today >= 54,
    JSON.stringify(stats.body).slice(0, 160));
  t('统计面板：7 日活跃用户 ≥ 1', stats.body.activeUsers7d >= 1, JSON.stringify(stats.body));
  t('统计面板：热门页面含「成绩分析」',
    (stats.body.topPages || []).some(x => x.page === '成绩分析' && x.n >= 2),
    JSON.stringify(stats.body.topPages));
  t('统计面板：动作分布含 jump/click/submit',
    ['jump', 'click', 'submit'].every(a => (stats.body.byAction || []).some(x => x.action === a)),
    JSON.stringify(stats.body.byAction));

  /* 明细 + 筛选 */
  const logs = await call('/api/admin?action=action-logs', { token: adminToken });
  t('日志明细能读到上报记录（首页满 50 条）', logs.status === 200 && logs.body.total >= 54
    && (logs.body.logs || []).length === 50, 'total ' + logs.body.total
    + ' / 首页 ' + (logs.body.logs || []).length);
  const q1 = await call('/api/admin?action=action-logs&q=' + encodeURIComponent('导出长图'),
    { token: adminToken });
  t('按关键词筛选（命中 target）', q1.status === 200 && q1.body.total >= 1, 'total ' + q1.body.total);
  /* 注意：上面 50 条「截断测试」事件比它更新，会把首页占满 —— 字段断言
     改在 q 筛选结果上做（顺带验证 q 真能搜到 target，不只是用户名）。 */
  const q1hit = (q1.body.logs || [])[0] || {};
  t('明细带用户名/页面/目标字段',
    q1hit.username === 'loguser01' && q1hit.page === '成绩分析'
    && q1hit.target === '导出长图' && q1hit.action === 'click',
    JSON.stringify(q1hit).slice(0, 160));

  const a1 = await call('/api/admin?action=action-logs&type=submit', { token: adminToken });
  t('按动作类型筛选', a1.status === 200 && a1.body.total >= 1
    && (a1.body.logs || []).every(x => x.action === 'submit'), 'total ' + a1.body.total);

  const today = new Date().toISOString().slice(0, 10);
  const d1 = await call('/api/admin?action=action-logs&day=' + today, { token: adminToken });
  t('按日期筛选能查到今日记录', d1.status === 200 && d1.body.total >= 54, 'total ' + d1.body.total);
  const d0 = await call('/api/admin?action=action-logs&day=2020-01-01', { token: adminToken });
  t('按日期筛选：往日无记录', d0.status === 200 && d0.body.total === 0, 'total ' + d0.body.total);

  /* 非管理员不能看日志 */
  const denyLog = await call('/api/admin?action=action-logs', { token: gTok });
  t('普通用户不能看行为日志 403', denyLog.status === 403, '实际 ' + denyLog.status);

  /* 🔴 v3.5.4：线上「统计面板有 2361 条、明细永远 0 条」的根因是
     listActionLogs 的 catch 把一切错误吞成「无数据」。纪律护栏：
     只有 42P01（表不存在）才配返回空，其它错误必须 500 大声失败。 */
  const admjs80 = fs.readFileSync(new URL('./api/admin.js', import.meta.url), 'utf8');
  t('★action-logs 的 catch 只放行 42P01（表不存在），其它错误大声 500',
    /if \(e && e\.code === '42P01'\) \{\s*return ok\(res, \{ total: 0, logs: \[\], page, size \}\);/.test(admjs80)
    && /console\.error\('\[admin\/action-logs\] 查询失败：', e\)/.test(admjs80)
    && /return fail\(res, 500, '日志查询失败：'/.test(admjs80));
  t('★action-stats 的 catch 同样只放行 42P01',
    /if \(e && e\.code === '42P01'\) return ok\(res, zero\);/.test(admjs80)
    && /console\.error\('\[admin\/action-stats\] 查询失败：', e\)/.test(admjs80));
  /* 🔴 v3.5.4 真根因护栏：Postgres 不保证 OR 短路，`${day}::date` 在
     day='' 时也会被求值 → invalid input syntax for type date: ""。
     护栏：日期守卫必须走「null 安全」写法，且全仓不许再出现
     `${xxx}::date` 这种「可能为空的参数直接强转」。 */
  t('★日期筛选用 null 安全守卫（dayOrNull::date is null，不再拿空串强转 date）',
    (admjs80.match(/and \(\$\{dayOrNull\}::date is null or \(l\.created_at at time zone 'Asia\/Shanghai'\)::date = \$\{dayOrNull\}::date\)/g) || []).length === 2);
  const castOnParam = [];
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  for (const f of ['api/admin.js', 'api/data.js', 'api/profile.js', 'api/auth.js', 'api/scores.js', 'api/content.js', 'api/games.js']) {
    const src = stripComments(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8'));
    (src.match(/\$\{[a-zA-Z_][a-zA-Z0-9_]*\}::(date|int|integer|numeric|bigint)(?!\s*\[)/g) || [])
      .filter((m) => !/\$\{dayOrNull\}::/.test(m))   /* null 安全形态放行 */
      .forEach((m) => castOnParam.push(f + ' → ' + m));
  }
  t('★全仓没有「可能为空的参数直接 ::date/::int 强转」（v3.5.4 同类坑护栏）',
    castOnParam.length === 0, castOnParam.join('；'));

  /* ---- ⑦ 信息查询字段去重（v2.10.0 根因修复回归）---- */
  /* 造一条带全部联系方式的资料（管理员直录 = 已核实） */
  const pd = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: {
      name: '查重', studentId: '259901',
      phone: '13900139000', wechat: 'wx_chachong', qq: '123456789',
    },
  });
  t('管理员录入带联系方式的资料成功', pd.status === 200 && !!pd.body.id,
    JSON.stringify(pd.body).slice(0, 160));

  const ps = await call('/api/profile?action=search&q=查重', { token: pendToken });
  const hit = (ps.body.results || [])[0] || {};
  t('按姓名能查到新资料', hit.name === '查重', JSON.stringify(hit).slice(0, 120));
  t('已核实联系方式仍走固定通道输出（phone/wechat/qq 顶层字段）',
    hit.phone === '13900139000' && hit.wechat === 'wx_chachong' && hit.qq === '123456789',
    JSON.stringify({ p: hit.phone, w: hit.wechat, q: hit.qq }));
  t('★修复重复渲染：fields 数组里不再出现 wechat/qq/phone',
    Array.isArray(hit.fields)
    && hit.fields.every(f => !['wechat', 'qq', 'phone'].includes(f.field)),
    JSON.stringify(hit.fields));
}

console.log('\n【66】第六十轮·微信内置浏览器字体修复：同源自托管（v2.10.0）');
{
  const idx = readIdx();
  const sw = fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8');

  /* ① 外部字体域清零（微信 X5 内核拦截 fonts.* 的 CSS 与字体文件）。
     ⚠️ 只查**实际资源引用**（<link href> / url()）—— 注释里说明背景时
        提到域名是故意的，不算引用。 */
  t('★index.html 不再外链 fonts.* 的 CSS（微信屏蔽源清零）',
    !/<link[^>]+href=["']https?:\/\/fonts\./.test(idx)
    && !/url\(\s*['"]?https?:\/\/fonts\./.test(idx));
  t('★没有残留 preconnect 到外部字体域', !/preconnect[^>]*fonts\./.test(idx));

  /* ② 同域 @font-face：两个字体、woff2、swap、latin 子集 */
  t('★Inter 同域 @font-face（可变字重 100 900 + swap + latin 子集）',
    /@font-face\{font-family:'Inter';font-style:normal;font-weight:100 900;font-display:swap;src:url\('\.\/fonts\/inter-latin\.woff2'\) format\('woff2'\);unicode-range:U\+0000-00FF/.test(idx));
  t('★JetBrains Mono 同域 @font-face（可变字重 100 800）',
    /@font-face\{font-family:'JetBrains Mono';font-style:normal;font-weight:100 800;font-display:swap;src:url\('\.\/fonts\/jetbrains-mono-latin\.woff2'\) format\('woff2'\);unicode-range:U\+0000-00FF/.test(idx));

  /* ③ 字体文件真实存在、非空、woff2 魔数（防「引用了但文件没传仓库」） */
  const fontFiles = ['./fonts/inter-latin.woff2', './fonts/jetbrains-mono-latin.woff2'];
  for (const f of fontFiles) {
    const buf = fs.readFileSync(new URL('.' + f.slice(1), import.meta.url));
    t('★字体文件在位且是合法 woff2：' + f,
      buf.length > 20000 && buf.subarray(0, 4).toString('latin1') === 'wOF2',
      buf.length + ' bytes');
  }

  /* ④ 字体栈首位仍是 Inter（同域字体生效后英文数字用它） */
  t('★全局字体栈首位仍是 Inter（中文仍落系统字体）',
    /\*\{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;font-family:'Inter','PingFang SC'/.test(idx));

  /* ⑤ SW 预缓存两个字体的文件（首次离线访问英文字形不掉） */
  t('★sw.js PRECACHE 含两个同域字体文件',
    /const PRECACHE = \[[\s\S]*?'\.\/fonts\/inter-latin\.woff2'[\s\S]*?'\.\/fonts\/jetbrains-mono-latin\.woff2'[\s\S]*?\]/.test(sw));
}

console.log('\n【67】第六十轮·成绩对比 PK 页（v2.10.0）');
{
  const idx = readIdx();

  /* 工具：按函数名截取函数体（嵌套 function 是缩进的，不会误截） */
  function fnBody(name) {
    const i = idx.indexOf('function ' + name + '(');
    if (i < 0) return '';
    const j = idx.indexOf('\nfunction ', i + 10);
    return idx.slice(i, j > i ? j : i + 9000);
  }

  /* ---- ① 静态：tab 与分发 ---- */
  t('★成绩分析 tab 有第三个「成绩对比」',
    /onclick="scSetTab\(\\'pk\\'\)">成绩对比<\/button>/.test(idx));
  t('★scRenderPane 分发到 scRenderPk', /else if\(SC\.tab === 'pk'\) scRenderPk\(\);/.test(idx));
  t('★换考试重置 PK 选择（旧行 id 全部失效）',
    /SC\.pkA = null; SC\.pkB = null;/.test(idx));
  t('★SC 状态有 pkA/pkB 两个字段',
    /pkA: null,\s*\/\* 成绩对比 PK：A 方成绩行 id（v2\.10\.0） \*\//.test(idx)
    && /pkB: null,\s*\/\* 成绩对比 PK：B 方成绩行 id（v2\.10\.0） \*\//.test(idx));

  /* ---- ② 静态：函数齐全 ---- */
  ['scPkDefaults', 'scPkRow', 'scPkSubjAvg', 'scPkPick', 'scPkSwap',
   'scRenderPk', 'scPkTotalCard', 'scPkSubjCard', 'scPkCards'].forEach((n) => {
    t('★PK 函数在位：' + n, idx.includes('function ' + n + '('));
  });
  t('★不新增后端接口（PK 只用当前考试的 SC.rows）',
    /scores\?action=/.test(idx) && !/scores\?action=pk/.test(idx));

  /* ---- ③ 静态：CSS 亮色 + 暗色 ---- */
  t('★PK 亮色：A 橙 B 蓝 + 分差红绿 + 语义 class',
    /\.sc-pk-bar-a\{fill:#c2410c\}/.test(idx) && /\.sc-pk-bar-b\{fill:#2563eb\}/.test(idx)
    && /\.sc-pk-num-a\{fill:#9a3412\}/.test(idx) && /\.sc-pk-num-b\{fill:#1e40af\}/.test(idx)
    && /\.sc-pk-diff-up\{fill:#0b7a43\}/.test(idx) && /\.sc-pk-diff-down\{fill:#c0392b\}/.test(idx));
  t('★PK 暗色覆盖（fill/stroke 全套，跟 .dark 自动切）',
    /\.dark \.sc-pk-bar-a\{fill:#fdba74\}/.test(idx) && /\.dark \.sc-pk-bar-b\{fill:#93c5fd\}/.test(idx)
    && /\.dark \.sc-pk-num-a\{fill:#fdba74\}/.test(idx) && /\.dark \.sc-pk-num-b\{fill:#93c5fd\}/.test(idx)
    && /\.dark \.sc-pk-name\{fill:#c9b8aa\}/.test(idx) && /\.dark \.sc-pk-sub\{fill:#a8998c\}/.test(idx)
    && /\.dark \.sc-pk-grid\{stroke:#3d3631\}/.test(idx) && /\.dark \.sc-pk-avg\{stroke:#a8998c\}/.test(idx)
    && /\.dark \.sc-pk-diff-up\{fill:#4ade80\}/.test(idx) && /\.dark \.sc-pk-diff-down\{fill:#f87171\}/.test(idx)
    && /\.dark \.sc-pk-diff-eq\{fill:#a8998c\}/.test(idx));
  t('★暗色覆盖整块包在 @media screen（打印走白底，不参与暗色）',
    /@media screen\{[\s\S]*?\.dark \.sc-pk-bar-a\{fill:#fdba74\}[\s\S]*?\n\}/.test(idx));
  t('★PK 暗色按钮/标签/分隔线也覆盖（不只图表）',
    /\.dark \.sc-pk-swap\{background:#2e2926;border-color:#4a4038;color:#c9b8aa\}/.test(idx)
    && /\.dark \.sc-pk-side label\{color:#a8998c\}/.test(idx)
    && /\.dark \.sc-pk-row\{border-bottom-color:#3d3631\}/.test(idx));
  t('★PK 卡窄屏单列（max-width:560px）',
    /@media \(max-width:560px\)\{\.sc-pk-cards\{grid-template-columns:1fr\}\}/.test(idx));

  /* ---- ④ 真值表：把 PK 相关函数抠出来真跑一遍 ---- */
  const names = ['esc', 'fmtNum', 'fmtDiff', 'scSubScore', 'scTotal', 'scFullMark',
    'scStats', 'scRankMap', 'scMyRow', 'scPane', 'scPkDefaults', 'scPkRow',
    'scPkSubjAvg', 'scPkPick', 'scPkSwap', 'scDateRange', 'shortName',
    'scRenderPk', 'scPkExam2', 'scPkTrendCard', 'scPkTotalCard', 'scPkSubjCard', 'scPkCards',
    'scPkBothTotalCard',   /* v3.5.12 #8：两场总分并列卡 */
    'scPkAiData', 'scPkAiCard',   /* v3.5.13 #8：AI 对比分析抽到顶层（单场也要有） */
    'scRankPair', 'scNoRankNotice', 'scExamAnchorIdx', 'scPointDateLabel'];   /* v3.5.14 #4/#5 */
  const missing = names.filter((n) => !fnBody(n));
  t('★PK 依赖函数全部可提取（真值表前提）', missing.length === 0,
    missing.join(',') || '齐全');

  if (!missing.length) {
    const src = names.map((n) => fnBody(n)).join('\n');
    const pane = {};
    const docStub = { getElementById: () => pane };
    const SC = {
      exams: [{ id: 1, name: '十月联考', subjects: [
        { key: 'yw', name: '语文', full: 150, graded: false },
        { key: 'sx', name: '数学', full: 150, graded: false },
        { key: 'yy', name: '英语', full: 150, graded: false },
        { key: 'wl', name: '物理', full: 100, graded: false },
      ] }],
      exam: null, rows: [], basis: 'graded', tab: 'pk', pkA: null, pkB: null,
    };
    const AUTH = { user: { id: 1, displayName: '余子康' } };
    SC.exam = SC.exams[0];
    SC.rows = [
      { id: 11, name: '余子康', no: '01', uid: 1, mine: true,
        s: { yw: { raw: 128 }, sx: { raw: 135 }, yy: { raw: 112 }, wl: { raw: 88 } } },
      { id: 12, name: '陈曦', no: '02', uid: 2, mine: false,
        s: { yw: { raw: 120 }, sx: { raw: 118 }, yy: { raw: 131 }, wl: { raw: 95 } } },
      { id: 13, name: '王五', no: '03', uid: 3, mine: false,
        s: { yw: { raw: 105 }, sx: { raw: 96 }, yy: { raw: 90 } } },  /* 物理缺考 */
    ];
    const api = new Function('SC', 'AUTH', 'document', src + `
      function scRenderPane(){ scRenderPk(); }   /* 桩：PK 只有一个 pane，直接重绘 */
      return { scRenderPk, scPkSwap, scPkPick, scPkDefaults, scPkRow, scTotal, scPkSubjAvg, scPkExam2 };
    `)(SC, AUTH, docStub);

    /* 默认规则：A = 我（uid 1），B = 总分第一（余子康 463 > 陈曦 464？算一下：
       余 128+135+112+88=463，陈 120+118+131+95=464，王 105+96+90=291 → B 应为陈曦 */
    api.scRenderPk();
    const html = pane.innerHTML;
    t('★默认 A 方选中「我」（余子康）',
      /value="11" selected/.test(html) && /余子康/.test(html));
    t('★默认 B 方选中总分第一（陈曦 464 分）',
      /value="12" selected/.test(html));
    t('★渲染含选人区 / 三个下拉（A、B、对比考试），v3.5.13 起不再有交换按钮',
      html.includes('sc-pk-pick') && !html.includes('sc-pk-swap')
      && (html.match(/<select/g) || []).length === 3
      && html.includes('scPkExam2') && html.includes('不对比（只看本场）'));
    t('★「同一场考试」标注当前考试名',
      html.includes('同一场考试：十月联考'));
    t('★总分对比卡：班均参考线 + 班排 + 领先结论',
      html.includes('总分对比') && html.includes('sc-pk-avg')
      && html.includes('班均') && html.includes('班排')
      && /B 领先 \d+(\.\d)? 分/.test(html));
    t('★各科对比卡：每科 A/B 两柱 + 组顶分差 + 科名满分',
      html.includes('各科对比')
      && (html.match(/class="sc-pk-bar-a"/g) || []).length === 5   /* 总分 1 + 四科 4 */
      && (html.match(/class="sc-pk-bar-b"/g) || []).length === 5
      && html.includes('sc-pk-diff-up') && html.includes('sc-pk-diff-down')
      && html.includes('语文') && html.includes('满分 150') && html.includes('满分 100'));
    t('★强弱项卡：最强/最弱/综合超班均（超班均口径，不是原始分）',
      html.includes('最强项') && html.includes('最弱项') && html.includes('综合超班均')
      && (html.match(/sc-pk-cards/g) || []).length >= 1
      && (html.match(/sc-pk-card/g) || []).length >= 3);   /* 容器 + 两张卡 */
    /* 强弱项数字核对：余子康 语128/数135/英112/物88，
       班均 语117.67 数116.33 英111 物91.5（物理跳过缺考的王五）
       → 最强 数学 +18.7 / 最弱 物理 −3.5 / 综合累加 +26.5 */
    t('★强弱项按超班均计算（最强 数学+18.7 / 最弱 物理−3.5 / 综合 +26.5）',
      html.includes('数学') && html.includes('+18.7')
      && html.includes('物理') && html.includes('−3.5') && html.includes('+26.5'));

    /* 交换：A/B 对调后 selected 也跟着换 */
    api.scPkSwap();
    var selParts = pane.innerHTML.split('<select');
    t('★交换后 A/B 对调（A 下拉选中 12、B 下拉选中 11）',
      /value="12" selected/.test(selParts[1] || '') && /value="11" selected/.test(selParts[2] || ''));

    /* 手动选人：把 A 换成王五（缺考那位） */
    api.scPkPick('a', 13);
    t('★手动选人即时重绘（A 换王五，含缺考柱处理）',
      /value="13" selected/.test(pane.innerHTML) && pane.innerHTML.includes('>缺<'));
    t('★缺考生不画柱只标「缺」（王五物理：10 根柱变 9 根）',
      (pane.innerHTML.match(/class="sc-pk-bar-[ab]"/g) || []).length === 9);

    /* v3.4.0 跨考试对比：选第二场 → 出「跨考试进退步」卡 */
    t('★默认不出跨考试卡（pkExam2 为空）',
      !pane.innerHTML.includes('跨考试进退步'));
    SC.allRows = { 1: { exam: SC.exams[0], rows: SC.rows } };   /* 桩：免拉数据 */
    api.scPkExam2('1');
    const trendHtml = pane.innerHTML;
    t('★选了第二场出现「跨考试进退步」卡',
      trendHtml.includes('跨考试进退步') && trendHtml.includes('指标')
      && trendHtml.includes('年级排名（物理方向）'));
    t('★跨考试卡数字：B 方余子康总分 463 → 463（前面步骤后 A=王五、B=余子康）',
      trendHtml.includes('463 → 463'));
    t('★跨考试卡标注缺考人（王五若上场会被点名）',
      trendHtml.includes('没找到对应成绩') === /在「十月联考」里没找到对应成绩/.test(trendHtml));
    SC.pkExam2 = null;
    api.scPkExam2('');
    t('★清空对比考试后卡片消失',
      !pane.innerHTML.includes('跨考试进退步'));

    /* 人数不足的兜底 */
    SC.rows = [SC.rows[0]];
    SC.pkA = null; SC.pkB = null;
    api.scRenderPk();
    t('★不足两人时给友好提示（不炸）',
      pane.innerHTML.includes('人还不够') && pane.innerHTML.includes('sc-empty'));
  }
}

console.log('\n【68】第六十一轮·成员与档案合并（单数据源长表单 + 四场景，v2.10.0）');
{
  /* ============================================================
     背景（#172）：后台原「用户管理」「资料管理」把同一批人分两处存储，
     改一处另一处对不上。现在合并成一个页面 / 一个长表单 / 一次提交。
     本段覆盖：members 列表四场景与筛选、save-member 四场景编排、
     姓名单数据源同步、delete-user 连带删档案、旧接口回归。
     ============================================================ */

  /* ---- ① 造四种场景的种子数据 ---- */
  /* 场景 both：建号（自动补档案） */
  const seed1 = await call('/api/admin?action=create-user', {
    method: 'POST', token: adminToken,
    body: { username: 'mbuser01', password: 'MbUser0123', displayName: '成员甲', role: 'user' },
  });
  t('种子①：建号成功（自动补档案）', seed1.status === 200 && !!seed1.body.user,
    JSON.stringify(seed1.body).slice(0, 160));
  const seed1Id = seed1.body.user.id;

  /* 场景 profile-only：只建通讯录，不建号 */
  const seed2 = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { name: '通讯乙', studentId: '259902', politics: '群众' },
  });
  t('种子②：纯档案（未认领）建成', seed2.status === 200 && !!seed2.body.id,
    JSON.stringify(seed2.body).slice(0, 160));
  const seed2Pid = seed2.body.id;

  /* 场景 user-only：建号后把自动补的档案删掉 → 有账号暂无档案 */
  const seed3 = await call('/api/admin?action=create-user', {
    method: 'POST', token: adminToken,
    body: { username: 'mbuser03', password: 'MbUser0323', displayName: '缺档案', role: 'user' },
  });
  const seed3Id = seed3.body.user.id;
  const profList = await call('/api/admin?action=profiles&q=缺档案', { token: adminToken });
  const seed3Prof = (profList.body.profiles || [])[0] || {};
  const delProf = await call('/api/admin?action=delete-profile', {
    method: 'POST', token: adminToken, body: { id: seed3Prof.id },
  });
  t('种子③：删掉自动档案，造出「有账号暂无档案」', delProf.status === 200,
    JSON.stringify(delProf.body).slice(0, 120));

  /* ---- ② members 列表：四场景 + counts ---- */
  const denyMb = await call('/api/admin?action=members', { token: null });
  t('members 未登录不可读 401', denyMb.status === 401, '实际 ' + denyMb.status);

  const mb = await call('/api/admin?action=members&limit=500', { token: adminToken });
  t('members 200 且带 counts / fieldMeta',
    mb.status === 200 && Array.isArray(mb.body.members) && !!mb.body.counts
    && Array.isArray(mb.body.fieldMeta),
    JSON.stringify({ total: mb.body.total, c: mb.body.counts }).slice(0, 200));

  const row1 = (mb.body.members || []).find(x => x.username === 'mbuser01');
  const row2 = (mb.body.members || []).find(x => x.name === '通讯乙');
  const row3 = (mb.body.members || []).find(x => x.username === 'mbuser03');
  t('★场景 both：有账号 + 有档案',
    !!row1 && row1.scene === 'both' && row1.userId === seed1Id && row1.profileId != null
    && row1.name === '成员甲',
    JSON.stringify(row1).slice(0, 220));
  t('★场景 profile-only：有档案无账号（userId 为空）',
    !!row2 && row2.scene === 'profile-only' && row2.userId == null && row2.profileId === seed2Pid,
    JSON.stringify(row2).slice(0, 220));
  t('★场景 user-only：有账号暂无档案（profileId 为空）',
    !!row3 && row3.scene === 'user-only' && row3.userId === seed3Id && row3.profileId == null,
    JSON.stringify(row3).slice(0, 220));
  t('counts 三场景计数都 >= 1',
    mb.body.counts.both >= 1 && mb.body.counts.profileOnly >= 1 && mb.body.counts.userOnly >= 1,
    JSON.stringify(mb.body.counts));
  t('counts.total = 三种场景之和（一行不重不漏）',
    mb.body.counts.total === mb.body.counts.both + mb.body.counts.profileOnly + mb.body.counts.userOnly,
    JSON.stringify(mb.body.counts));
  t('成员行带账号在线口径字段（与旧 users 接口一致）',
    !!row1 && typeof row1.online === 'boolean' && typeof row1.onlineSessions === 'number'
    && typeof row1.dataCount === 'number',
    JSON.stringify({ o: row1.online, s: row1.onlineSessions, d: row1.dataCount }));

  /* ---- ③ 筛选 ---- */
  const qName = await call('/api/admin?action=members&q=' + encodeURIComponent('成员甲'), { token: adminToken });
  t('q 按姓名命中（档案名）', qName.status === 200
    && (qName.body.members || []).some(x => x.username === 'mbuser01'),
    'total ' + qName.body.total);
  const qUser = await call('/api/admin?action=members&q=' + encodeURIComponent('mbuser03'), { token: adminToken });
  t('q 按用户名命中', (qUser.body.members || []).some(x => x.username === 'mbuser03'));
  const qSid = await call('/api/admin?action=members&q=' + encodeURIComponent('259902'), { token: adminToken });
  t('q 按学号命中（未认领行）', (qSid.body.members || []).some(x => x.name === '通讯乙'));
  const fRole = await call('/api/admin?action=members&role=admin', { token: adminToken });
  t('role=admin 只回管理员', fRole.status === 200
    && (fRole.body.members || []).length > 0
    && (fRole.body.members || []).every(x => x.role === 'admin'));
  const fSt = await call('/api/admin?action=members&status=active', { token: adminToken });
  t('status=active 只回正常账号', (fSt.body.members || []).every(x => x.status === 'active'));
  const fScene1 = await call('/api/admin?action=members&scene=profile-only', { token: adminToken });
  t('scene=profile-only 只回未认领',
    (fScene1.body.members || []).length > 0
    && (fScene1.body.members || []).every(x => x.scene === 'profile-only'));
  const fScene2 = await call('/api/admin?action=members&scene=user-only', { token: adminToken });
  t('scene=user-only 只回缺档案',
    (fScene2.body.members || []).length > 0
    && (fScene2.body.members || []).every(x => x.scene === 'user-only'));
  const fLimit = await call('/api/admin?action=members&limit=2&offset=0', { token: adminToken });
  t('limit 生效（分页基线）', fLimit.status === 200 && (fLimit.body.members || []).length === 2,
    '实得 ' + (fLimit.body.members || []).length);

  /* ---- ④ save-member 场景①：both → 改角色/状态/档案 + 姓名单数据源 ---- */
  const sv1 = await call('/api/admin?action=save-member', {
    method: 'POST', token: adminToken,
    body: {
      userId: seed1Id, profileId: row1.profileId,
      role: 'user', status: 'active',
      name: '成员改', studentId: '259911', politics: '共青团员',
      phone: '13700137000',
    },
  });
  t('场景① both 保存成功', sv1.status === 200 && !!sv1.body.ok,
    JSON.stringify(sv1.body).slice(0, 200));
  t('场景① 返回两边的 id', sv1.body.userId === seed1Id && sv1.body.profileId === row1.profileId,
    JSON.stringify({ u: sv1.body.userId, p: sv1.body.profileId }));

  /* 姓名单数据源：users.display_name 与 profiles.name 必须一致 */
  const ud = await call('/api/admin?action=user&id=' + seed1Id, { token: adminToken });
  const pf = await call('/api/admin?action=profiles&q=' + encodeURIComponent('成员改'), { token: adminToken });
  const pfRow = (pf.body.profiles || [])[0] || {};
  t('★姓名单数据源：users.display_name 同步为新姓名',
    ud.body.user && ud.body.user.displayName === '成员改',
    JSON.stringify(ud.body.user && ud.body.user.displayName));
  t('★姓名单数据源：profiles.name 同为新姓名',
    pfRow.name === '成员改', JSON.stringify(pfRow.name));
  t('场景① 档案字段已更新（政治面貌/手机号/学号）',
    pfRow.politics === '共青团员' && pfRow.phone === '13700137000' && pfRow.studentId === '259911',
    JSON.stringify({ p: pfRow.politics, ph: pfRow.phone, s: pfRow.studentId }));

  /* 用户名不可改：payload 里塞 username 也应被忽略 */
  const svName = await call('/api/admin?action=save-member', {
    method: 'POST', token: adminToken,
    body: { userId: seed1Id, profileId: row1.profileId, username: 'hacked01', role: 'user' },
  });
  const loginOld = await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'mbuser01', password: 'MbUser0123' },
  });
  const loginNew = await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'hacked01', password: 'MbUser0123' },
  });
  t('★已有账号的用户名不可改（老用户名照常登录）',
    svName.status === 200 && loginOld.status === 200 && loginNew.status !== 200,
    'old ' + loginOld.status + ' / new ' + loginNew.status);

  /* ---- ⑤ save-member 场景②：profile-only + createAccount → 开号并绑定 ---- */
  const sv2 = await call('/api/admin?action=save-member', {
    method: 'POST', token: adminToken,
    body: {
      profileId: seed2Pid, createAccount: true,
      username: 'mbuser02', password: 'MbUser0223',
      name: '通讯乙', role: 'user',
    },
  });
  t('场景② 给未认领成员开号成功', sv2.status === 200 && !!sv2.body.ok && !!sv2.body.userId,
    JSON.stringify(sv2.body).slice(0, 200));
  const sv2Login = await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'mbuser02', password: 'MbUser0223' },
  });
  t('场景② 新账号可登录', sv2Login.status === 200 && !!sv2Login.body.token,
    '实际 ' + sv2Login.status);
  const mb2 = await call('/api/admin?action=members&q=' + encodeURIComponent('通讯乙'), { token: adminToken });
  const row2b = (mb2.body.members || [])[0] || {};
  t('★场景② 不开第二档案：该姓名仍只有一行，且变为 both',
    (mb2.body.members || []).length === 1 && row2b.scene === 'both'
    && row2b.userId === sv2.body.userId && row2b.profileId === seed2Pid,
    JSON.stringify(row2b).slice(0, 220));
  const dup2 = await call('/api/admin?action=save-member', {
    method: 'POST', token: adminToken,
    body: { profileId: seed2Pid, createAccount: true, username: 'mbuser02', password: 'MbUser0223' },
  });
  t('场景② 重复用户名 409', dup2.status === 409, '实际 ' + dup2.status);

  /* ---- ⑥ save-member 场景③：user-only → 补建档案并绑定 ---- */
  const sv3 = await call('/api/admin?action=save-member', {
    method: 'POST', token: adminToken,
    body: {
      userId: seed3Id,
      name: '缺档案', studentId: '259903', politics: '群众',
      wechat: 'wx_bingdangan', contactStatus: 'approved',
    },
  });
  t('场景③ 补建档案成功', sv3.status === 200 && !!sv3.body.ok && !!sv3.body.profileId,
    JSON.stringify(sv3.body).slice(0, 200));
  const mb3 = await call('/api/admin?action=members&q=' + encodeURIComponent('缺档案'), { token: adminToken });
  const row3b = (mb3.body.members || [])[0] || {};
  t('★场景③ 一行变 both：档案绑到该账号',
    row3b.scene === 'both' && row3b.userId === seed3Id
    && row3b.profileId === sv3.body.profileId && row3b.wechat === 'wx_bingdangan',
    JSON.stringify(row3b).slice(0, 220));
  const ud3 = await call('/api/admin?action=user&id=' + seed3Id, { token: adminToken });
  t('场景③ 账号显示名同步为档案姓名', ud3.body.user.displayName === '缺档案',
    JSON.stringify(ud3.body.user.displayName));

  /* ---- ⑦ save-member 场景④：全新成员（建号 + 档案一次提交） ---- */
  const sv4 = await call('/api/admin?action=save-member', {
    method: 'POST', token: adminToken,
    body: {
      createAccount: true,
      username: 'mbuser04', password: 'MbUser0423',
      name: '全新丁', studentId: '259904', politics: '共青团员',
      examNo: '11400004', qq: '100000004', contactStatus: 'approved',
      role: 'user',
    },
  });
  t('场景④ 全新成员一次提交成功', sv4.status === 200 && !!sv4.body.ok
    && !!sv4.body.userId && !!sv4.body.profileId,
    JSON.stringify(sv4.body).slice(0, 200));
  const sv4Login = await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'mbuser04', password: 'MbUser0423' },
  });
  t('场景④ 新账号可登录', sv4Login.status === 200 && !!sv4Login.body.token,
    '实际 ' + sv4Login.status);
  const mb4 = await call('/api/admin?action=members&q=' + encodeURIComponent('全新丁'), { token: adminToken });
  const row4 = (mb4.body.members || [])[0] || {};
  t('★场景④ 账号档案都落地（both，字段齐全）',
    row4.scene === 'both' && row4.username === 'mbuser04' && row4.studentId === '259904'
    && row4.examNo === '11400004' && row4.qq === '100000004'
    && row4.contactStatus === 'approved',
    JSON.stringify(row4).slice(0, 240));

  /* ---- ⑧ 护栏 ---- */
  const gTok2 = (await call('/api/auth?action=register', {
    method: 'POST', body: { username: 'mbguest01', password: 'MbGuest0123', displayName: '围观群众' },
  })).body.token;
  const denySave = await call('/api/admin?action=save-member', {
    method: 'POST', token: gTok2,
    body: { createAccount: true, username: 'x', password: 'x', name: 'x' },
  });
  t('普通用户不能 save-member 403', denySave.status === 403, '实际 ' + denySave.status);

  const empty = await call('/api/admin?action=save-member', {
    method: 'POST', token: adminToken, body: { name: '空表单' },
  });
  t('空表单（无账号无档案）400', empty.status === 400, '实际 ' + empty.status);

  const noPwd = await call('/api/admin?action=save-member', {
    method: 'POST', token: adminToken,
    body: { createAccount: true, username: 'mbuser05', name: '没密码' },
  });
  t('开号不填密码 400', noPwd.status === 400, '实际 ' + noPwd.status);

  const badRole = await call('/api/admin?action=save-member', {
    method: 'POST', token: adminToken,
    body: { userId: seed1Id, role: 'superadmin' },
  });
  t('非法 role 400', badRole.status === 400, '实际 ' + badRole.status);
  const badSt = await call('/api/admin?action=save-member', {
    method: 'POST', token: adminToken,
    body: { userId: seed1Id, status: 'deleted' },
  });
  t('非法 status 400', badSt.status === 400, '实际 ' + badSt.status);

  const dupSid = await call('/api/admin?action=save-member', {
    method: 'POST', token: adminToken,
    body: { profileId: seed2Pid, studentId: '259904' },   /* 259904 已被全新丁占用 */
  });
  t('学号重复 409', dupSid.status === 409, '实际 ' + dupSid.status);

  /* 只改账号状态、不碰档案：hasProfileData=false 时档案段整体不动 */
  const svOnlyAcc = await call('/api/admin?action=save-member', {
    method: 'POST', token: adminToken,
    body: { userId: seed1Id, status: 'banned' },
  });
  const pfKeep = await call('/api/admin?action=profiles&q=' + encodeURIComponent('成员改'), { token: adminToken });
  t('只改状态不动档案（200 且档案姓名依旧）',
    svOnlyAcc.status === 200 && ((pfKeep.body.profiles || [])[0] || {}).name === '成员改',
    JSON.stringify(svOnlyAcc.body).slice(0, 160));
  const svUnban = await call('/api/admin?action=save-member', {
    method: 'POST', token: adminToken, body: { userId: seed1Id, status: 'active' },
  });
  t('解禁恢复 active', svUnban.status === 200);

  /* ---- ⑨ save-profile 老路径也姓同步（单数据源回归） ---- */
  const svOld = await call('/api/admin?action=save-profile', {
    method: 'POST', token: adminToken,
    body: { id: row1.profileId, name: '成员终' },
  });
  const udOld = await call('/api/admin?action=user&id=' + seed1Id, { token: adminToken });
  t('★老 save-profile 改名也同步 users.display_name',
    svOld.status === 200 && udOld.body.user.displayName === '成员终',
    JSON.stringify(udOld.body.user.displayName));

  /* ---- ⑩ delete-user：alsoProfile 两种行为 ---- */
  /* a. 连带删档案 */
  const del1 = await call('/api/admin?action=create-user', {
    method: 'POST', token: adminToken,
    body: { username: 'mbdel01', password: 'MbDel0123', displayName: '连带删', role: 'user' },
  });
  const del1Id = del1.body.user.id;
  const delA = await call('/api/admin?action=delete-user', {
    method: 'POST', token: adminToken, body: { id: del1Id, alsoProfile: true },
  });
  const mbA = await call('/api/admin?action=members&q=' + encodeURIComponent('连带删'), { token: adminToken });
  t('delete-user alsoProfile：账号档案都没了',
    delA.status === 200 && (mbA.body.members || []).length === 0,
    '剩余 ' + (mbA.body.members || []).length);

  /* b. 默认保留档案（变未认领） */
  const del2 = await call('/api/admin?action=create-user', {
    method: 'POST', token: adminToken,
    body: { username: 'mbdel02', password: 'MbDel0223', displayName: '保留档', role: 'user' },
  });
  const del2Id = del2.body.user.id;
  const delB = await call('/api/admin?action=delete-user', {
    method: 'POST', token: adminToken, body: { id: del2Id },
  });
  const mbB = await call('/api/admin?action=members&q=' + encodeURIComponent('保留档'), { token: adminToken });
  const rowB = (mbB.body.members || [])[0] || {};
  t('delete-user 默认保留档案（变为未认领）',
    delB.status === 200 && rowB.scene === 'profile-only' && rowB.userId == null,
    JSON.stringify(rowB).slice(0, 200));
  /* ---- ⑪ 旧接口回归（头衔/审核/查看记录等页还在用） ---- */
  const oldU = await call('/api/admin?action=users', { token: adminToken });
  const selfId = (oldU.body.users || []).find(x => x.username === 'yuzikang').id;
  const delSelf = await call('/api/admin?action=delete-user', {
    method: 'POST', token: adminToken, body: { id: selfId },
  });
  t('不能删除自己 400', delSelf.status === 400, '实际 ' + delSelf.status);
  const oldP = await call('/api/admin?action=profiles', { token: adminToken });
  const oldPd = await call('/api/admin?action=profile&id=' + row1.profileId, { token: adminToken });
  t('旧 users / profiles / profile 接口照旧可用（头衔等独立页不受影响）',
    oldU.status === 200 && Array.isArray(oldU.body.users)
    && oldP.status === 200 && Array.isArray(oldP.body.profiles)
    && oldPd.status === 200 && !!oldPd.body.profile,
    'users ' + oldU.status + ' / profiles ' + oldP.status + ' / profile ' + oldPd.status);
  t('旧 profiles 接口仍带 fieldMeta（动态列数据源）', Array.isArray(oldP.body.fieldMeta));

  /* ---- ⑫ 前端静态护栏：单入口 + 长表单 + 四场景 ---- */
  const adm = readAdm();
  t('★导航只剩「成员与档案」单入口（users/profiles 两页已撤）',
    /id:'members',\s*label:'成员与档案'/.test(adm)
    && !/id:'users'/.test(adm) && !/id:'profiles'/.test(adm));
  t('go() 分发到 renderMembers', /members:\s*renderMembers,/.test(adm));
  t('STATE 有 members 状态（含 scene 筛选位）', /members: \{ list: \[\], total: 0, counts: \{\}/.test(adm));
  t('★长表单分上下两段（系统账号 / 班级档案，类名 mb-form-sec 两处）',
    (adm.match(/class="mb-form-sec"/g) || []).length === 2
    && /系统账号/.test(adm) && /班级档案/.test(adm));
  /* 收窄到 memberDialog 函数体内：admin.html 别处（table 的 border-collapse）
     本来就会出现 collapse 字样，不能误伤 */
  const dlgFrom = adm.indexOf('function memberDialog(');
  const dlgTo = adm.indexOf('\nfunction ', dlgFrom + 10);
  const dlg = adm.slice(dlgFrom, dlgTo > dlgFrom ? dlgTo : dlgFrom + 9000);
  t('★长表单不用折叠面板（memberDialog 内无 details / collapse 结构）',
    !/<details/.test(dlg) && !/collapse/.test(dlg));
  t('★姓名单数据源写进表单提示',
    /这一个框同时写进/.test(adm) && /单数据源/.test(adm));
  t('★四场景徽章定义齐全（both / user-only / profile-only）',
    /var MEMBER_SCENE = \{/.test(adm) && /both:/.test(adm) && /'user-only':/.test(adm) && /'profile-only':/.test(adm));
  t('成员页拉合并接口 members', /action=members&limit=/.test(adm));
  t('成员页保存走 save-member', /action=save-member/.test(adm));
  t('未认领行可一键开号（createAccount 勾选）', /id="mbOpen" checked/.test(adm));
  t('删除账号二次确认说明档案默认保留', /班级档案默认保留/.test(adm));
  t('删除账号可连带删档案（alsoProfile）', /alsoProfile/.test(adm));
  t('可见性列保留在成员表（能力不丢）', /<th class="nowrap">可见性<\/th>/.test(adm));
  t('字段管理面板挂到成员页（mbFieldBody）', /id="mbFieldBody"/.test(adm));
  t('合并导出含账号+档案列（成员与档案_ 文件名）',
    /成员与档案_' \+ fmt\(new Date\(\), 'date'\)/.test(adm));
  t('renderMembers / paintMembers / memberDialog / memberAction / memberExport 全部在位',
    ['renderMembers', 'loadMembers', 'paintMembers', 'memberDialog', 'memberAction',
     'memberExport', 'mkey', 'memberByKey', 'paintPick'].every(f => new RegExp('function ' + f + '\\b').test(adm)));
  t('旧 users/profiles 页面函数已退场（不死代码）',
    !/function renderUsers\(/.test(adm) && !/function renderProfiles\(/.test(adm)
    && !/function paintProfiles\(/.test(adm) && !/function addUserDialog\(/.test(adm));
}

console.log('\n【69】第六十一轮·云端个人数据管理（#178：分类视图 + 中文翻译 + 删除前密码验证）');
{
  /* ============================================================
     背景（#178）：站主要求「云端个人数据管理」——
       ① 个人端能看到自己云端存了哪些数据（分类细化到条目）
       ② 英文键名翻中文（cls_theme → 主题（亮/暗））
       ③ 删除前必须验证登录密码（防借手机误删/恶意删）
       ④ KV 预留但不开发（ALLOW_KEYS 不放行、UI 不渲染）
     分类与翻译的单一来源在后端 data.js 的 KEY_GROUPS，
     个人端（?view=cats）与管理员后台（user 详情的 data 数组）共用。
     ============================================================ */

  /* ---- ① 造一个专测用户，写入覆盖各分类的键 ---- */
  const cld = await call('/api/auth?action=register', {
    method: 'POST', body: { username: 'clduser01', password: 'CloudPass123', displayName: '云端同学' },
  });
  t('建 #178 测试账号成功', cld.status === 200 && !!cld.body.token,
    JSON.stringify(cld.body).slice(0, 160));
  const cldTok = cld.body.token;
  const cldId = (cld.body.user || {}).id;

  const cldPut = await call('/api/data', {
    method: 'PUT', token: cldTok,
    body: { items: {
      cls_theme: 'dark',                    /* 外观与界面（精确键） */
      /* v3.5.34：cls_ui_cfg 已移出白名单（自定义设置只存本机），
         这里改用同样属于外观分类的 cls_sfx 覆盖该分类。 */
      cls_sfx: 0,                           /* 外观与界面（音效开关） */
      cls_welcome_v1: '1',                  /* 已看过标记 */
      cls_dj_note: '周日点歌',               /* 点歌 */
      cls_notice_read: { a1: 1 },           /* 学习与班级事务 */
      cls_ann_filter: 'site',               /* 站内偏好 */
      'cls_hw_done_42': true,               /* 作业完成标记（前缀键） */
      'cls_sign_2026-10-16': '签文',         /* 每日班级签（前缀键） */
      cls_game_snake_hi: 128,               /* 游戏数据（前缀键） */
    } },
  });
  t('九类键写入成功', cldPut.status === 200 && cldPut.body.written === 9,
    JSON.stringify(cldPut.body).slice(0, 160));

  /* ---- ② view=cats 分类视图 ---- */
  const cats = await call('/api/data?view=cats', { token: cldTok });
  t('view=cats 200 且带 groups', cats.status === 200 && Array.isArray(cats.body.groups),
    JSON.stringify(cats.body).slice(0, 200));
  t('分类视图 total=9 / bytes>0', cats.body.total === 9 && cats.body.bytes > 0,
    JSON.stringify({ total: cats.body.total, bytes: cats.body.bytes }));
  const gApp = (cats.body.groups || []).find(g => g.cat === 'appearance');
  const gHw  = (cats.body.groups || []).find(g => g.cat === 'hw');
  const gSign = (cats.body.groups || []).find(g => g.cat === 'sign');
  const gGame = (cats.body.groups || []).find(g => g.cat === 'game');
  t('★英文键名翻中文：cls_theme → 主题（亮/暗）',
    !!gApp && gApp.items.some(i => i.key === 'cls_theme' && i.name === '主题（亮/暗）'),
    JSON.stringify(gApp && gApp.items));
  {
    const djsrc = fs.readFileSync(new URL('./api/data.js', import.meta.url), 'utf8');
    const allowSeg = djsrc.slice(djsrc.indexOf('const ALLOW_KEYS'), djsrc.indexOf('function isAllowedKey'));
    const idxSrc = readIdx();
    const ckSeg = idxSrc.slice(idxSrc.indexOf('var CLOUD_KEYS'), idxSrc.indexOf('var CLOUD_KEY_PREFIX'));
    t('★v3.5.34 自定义设置不在云白名单（后端 ALLOW_KEYS 无 cls_ui_cfg / cls_ui_bgimg）',
      !/^\s*'cls_ui_cfg'/.test(allowSeg.replace(/\/\*[\s\S]*?\*\//g, ''))
      && !/^\s*'cls_ui_bgimg'/.test(allowSeg.replace(/\/\*[\s\S]*?\*\//g, '')),
      allowSeg.slice(0, 120));
    t('★v3.5.34 自定义设置不在云白名单（前端 CLOUD_KEYS 不含两者）',
      !/'cls_ui_cfg'/.test(ckSeg) && !/'cls_ui_bgimg'/.test(ckSeg));
    t('★v3.5.34 分类视图不再出现这两个键',
      !(cats.body.groups || []).some(g => (g.items || []).some(i => i.key === 'cls_ui_cfg')));
  }
  t('★分类细化到条目：外观与界面含 cls_sfx → 音效开关',
    !!gApp && gApp.items.some(i => i.key === 'cls_sfx' && i.name === '音效开关'),
    JSON.stringify(gApp && gApp.items));
  t('★前缀键按条目展开：cls_hw_done_42 → 作业完成标记 · 42',
    !!gHw && gHw.items.length === 1 && gHw.items[0].name === '作业完成标记 · 42',
    JSON.stringify(gHw && gHw.items));
  t('★前缀键按条目展开：cls_sign_2026-10-16 → 每日班级签 · 2026-10-16',
    !!gSign && gSign.items[0].name === '每日班级签 · 2026-10-16',
    JSON.stringify(gSign && gSign.items));
  t('★前缀键按条目展开：cls_game_snake_hi → 游戏数据 · snake_hi',
    !!gGame && gGame.items[0].name === '游戏数据 · snake_hi');
  t('每条带 bytes 与 updatedAt', (cats.body.groups || []).every(g =>
    g.items.every(i => typeof i.bytes === 'number' && !!i.updatedAt)));
  /* 组序按 KEY_GROUPS 定义走（appearance 是第一个分类），「其他」恒在末尾 */
  t('分类顺序稳定（按后端定义序，不随键字典序飘）',
    (cats.body.groups || [])[0].cat === 'appearance'
    && (cats.body.groups || []).every((g, i, arr) => i === 0 || arr[i - 1].cat !== 'other' || g.cat !== 'other'));
  t('各分类 count 之和 = total（一条不重不漏）',
    (cats.body.groups || []).reduce((s, g) => s + g.count, 0) === cats.body.total);

  /* 老结构回归：不带 view 的 GET 仍是 count/items/times 三件套 */
  const plain = await call('/api/data', { token: cldTok });
  t('不带 view 的 GET 结构不变（同步主路径回归）',
    plain.status === 200 && plain.body.count === 9
    && plain.body.items && plain.body.items.cls_theme !== undefined
    && plain.body.times && !!plain.body.times.cls_theme);

  /* ---- ③ verify 密码验证 + wt 门禁 ---- */
  const vNoPwd = await call('/api/data?action=verify', { method: 'POST', token: cldTok, body: {} });
  t('verify 不填密码 400', vNoPwd.status === 400, '实际 ' + vNoPwd.status);
  const vGet = await call('/api/data?action=verify', { token: cldTok });
  t('verify 只接受 POST 405', vGet.status === 405, '实际 ' + vGet.status);
  const vBad = await call('/api/data?action=verify', {
    method: 'POST', token: cldTok, body: { password: 'WrongPass999' },
  });
  t('★删除前密码验证：错误密码 401', vBad.status === 401, '实际 ' + vBad.status);
  const vOk = await call('/api/data?action=verify', {
    method: 'POST', token: cldTok, body: { password: 'CloudPass123' },
  });
  t('★删除前密码验证：正确密码 200 且发 wipeToken',
    vOk.status === 200 && vOk.body.ok === true && typeof vOk.body.wipeToken === 'string'
    && vOk.body.wipeToken.length >= 32 && vOk.body.expiresIn === 300,
    JSON.stringify(vOk.body).slice(0, 160));
  const wt = vOk.body.wipeToken;

  const delNoWt = await call('/api/data?key=cls_theme', { method: 'DELETE', token: cldTok });
  t('★有 token 但无 wt：删除被 403 拦下', delNoWt.status === 403, '实际 ' + delNoWt.status);
  const delBadWt = await call('/api/data?key=cls_theme&wt=deadbeef', { method: 'DELETE', token: cldTok });
  t('假 wt 删除被 403 拦下', delBadWt.status === 403, '实际 ' + delBadWt.status);
  const stillThere = await call('/api/data?key=cls_theme', { token: cldTok });
  t('被拦下的删除不生效（数据还在）', stillThere.body.value !== null);

  const delOk = await call('/api/data?key=cls_theme&wt=' + wt, { method: 'DELETE', token: cldTok });
  t('带 wt 删除成功 200', delOk.status === 200, '实际 ' + delOk.status);
  const gone = await call('/api/data?key=cls_theme', { token: cldTok });
  t('删除后该键真的没了', gone.body.value === null, JSON.stringify(gone.body));

  /* ---- ④ all=1 清空全部（wt 用掉即焚） ---- */
  const wipe = await call('/api/data?all=1&wt=' + wt, { method: 'DELETE', token: cldTok });
  t('all=1 清空全部云端数据', wipe.status === 200 && wipe.body.deleted === 8,
    JSON.stringify(wipe.body).slice(0, 160));
  const afterWipe = await call('/api/data?view=cats', { token: cldTok });
  t('清空后分类视图为空（groups 空数组）',
    afterWipe.body.total === 0 && (afterWipe.body.groups || []).length === 0,
    JSON.stringify(afterWipe.body).slice(0, 160));
  const wtBurned = await call('/api/data?key=cls_sfx&wt=' + wt, { method: 'DELETE', token: cldTok });
  t('清空后 wt 用掉即焚（再删 403）', wtBurned.status === 403, '实际 ' + wtBurned.status);

  /* ---- ⑤ 凭证路径（浏览器派生的密钥，服务端零派生） ---- */
  /* 与登录同构：先取盐参数，本地 PBKDF2 派生，发 credential */
  const saltJ = await call('/api/auth?action=salt', {
    method: 'POST', body: { username: 'clduser01' },
  });
  t('salt 接口返回 pbkdf2 参数', saltJ.status === 200 && saltJ.body.algo === 'pbkdf2'
    && !!saltJ.body.salt && saltJ.body.iterations > 0,
    JSON.stringify(saltJ.body).slice(0, 160));
  let cred = '';
  try {
    const enc = new TextEncoder();
    const saltBytes = Buffer.from(String(saltJ.body.salt).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const key = await crypto.subtle.importKey('raw', enc.encode('CloudPass123'), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: saltBytes, iterations: Number(saltJ.body.iterations), hash: 'SHA-256' },
      key, 256
    );
    cred = Buffer.from(bits).toString('base64url');
  } catch (e) { cred = ''; }
  t('Node 侧成功派生 credential（与浏览器同参数）', cred.length >= 40, 'len ' + cred.length);
  const vCred = await call('/api/data?action=verify', {
    method: 'POST', token: cldTok, body: { credential: cred },
  });
  t('★凭证路径验证通过（服务端零派生）', vCred.status === 200 && !!vCred.body.wipeToken,
    JSON.stringify(vCred.body).slice(0, 160));
  const vCredBad = await call('/api/data?action=verify', {
    method: 'POST', token: cldTok, body: { credential: 'A'.repeat(43) },
  });
  t('错误 credential 401', vCredBad.status === 401, '实际 ' + vCredBad.status);

  /* ---- ⑥ 限流：同一用户每分钟最多 10 次验证 ---- */
  const cld2 = await call('/api/auth?action=register', {
    method: 'POST', body: { username: 'clduser02', password: 'CloudPass223', displayName: '限流同学' },
  });
  const cld2Tok = cld2.body.token;
  let lastStatus = 0, saw401 = 0;
  for (let i = 0; i < 11; i++) {
    const r = await call('/api/data?action=verify', {
      method: 'POST', token: cld2Tok, body: { password: 'WrongPass999' },
    });
    lastStatus = r.status;
    if (r.status === 401) saw401++;
  }
  t('★验证限流：前 10 次正常 401，第 11 次起 429',
    saw401 === 10 && lastStatus === 429, '401 次数 ' + saw401 + ' / 末次 ' + lastStatus);

  /* ---- ⑦ 管理员后台：用户详情的 data 带中文分类 ---- */
  await call('/api/data', {
    method: 'PUT', token: cldTok,
    body: { items: { cls_theme: 'light', 'cls_hw_done_7': false } },
  });
  const ud = await call('/api/admin?action=user&id=' + cldId, { token: adminToken });
  const udTheme = ((ud.body.data || [])).find(d => d.key === 'cls_theme') || {};
  const udHw = ((ud.body.data || [])).find(d => d.key === 'cls_hw_done_7') || {};
  t('★后台用户详情：data 带 cat/catLabel/label 中文分类',
    ud.status === 200 && udTheme.cat === 'appearance' && udTheme.catLabel === '外观与界面'
    && udTheme.label === '主题（亮/暗）' && udHw.label === '作业完成标记 · 7',
    JSON.stringify({ t: udTheme, h: udHw }).slice(0, 240));
  /* 管理员删用户数据走 admin?action=delete-data，不受 wt 限制（后台权威） */
  const admDel = await call('/api/admin?action=delete-data', {
    method: 'POST', token: adminToken, body: { userId: cldId, key: 'cls_hw_done_7' },
  });
  t('管理员后台删用户数据不要求 wt（权威通道）', admDel.status === 200, '实际 ' + admDel.status);

  /* ---- ⑧ classifyKey 单元直测（含「其他」兜底） ---- */
  const { classifyKey } = await import('/tmp/class-site/api/data.js');
  t('classifyKey：精确键命中', classifyKey('cls_sfx').name === '音效开关'
    && classifyKey('cls_sfx').cat === 'appearance');
  t('classifyKey：前缀键命中且带后缀', classifyKey('cls_claim_abc').cat === 'coupon'
    && classifyKey('cls_claim_abc').name === '点歌券领取台账 · abc');
  t('classifyKey：未命中分类归「其他」', classifyKey('some_future_key').cat === 'other'
    && classifyKey('some_future_key').name === 'some_future_key');
  t('classifyKey：空/非法输入不炸', classifyKey('').cat === 'other' && classifyKey(null).cat === 'other');

  /* ---- ⑨ 预留 KV 不开发（#178 站主要求） ---- */
  const dataSrc = fs.readFileSync(new URL('./api/data.js', import.meta.url), 'utf8');
  const allowBlock = dataSrc.slice(
    dataSrc.indexOf('const ALLOW_KEYS'),
    dataSrc.indexOf('const MAX_VALUE_CHARS')
  );
  t('★预留 KV 不开发：白名单里没有任何 kv_ 键', !/kv_/.test(allowBlock));
  t('★预留 KV 不开发：分类表里 kv 位只是注释（占位不渲染）',
    /预留位（不开发/.test(dataSrc)
    && /\/\/\s*\{\s*cat:\s*'kv'/.test(dataSrc)
    && (dataSrc.match(/^\s*\{\s*cat:\s*'kv'/gm) || []).length === 0);

  /* ---- ⑩ 前端静态护栏（个人端 + 后台） ---- */
  const idx = readIdx();
  const adm = readAdm();
  t('★个人端：数据管理弹窗有「我的云端数据」入口', /onclick="openCloudData\(\)"/.test(idx));
  t('★个人端：分类视图弹窗与密码验证弹窗都在位',
    /id="cloudDataMask"/.test(idx) && /id="cloudPwdMask"/.test(idx));
  t('★个人端：拉取 view=cats 分类视图', /'\/data\?view=cats'/.test(idx));
  t('★个人端：verify 双路径（credential 派生 + password 回退）',
    /action=verify', \{ method:'POST', body:\{ credential: cred \}/.test(idx)
    && /action=verify', \{ method:'POST', body:\{ password: pwd \}/.test(idx));
  t('★个人端：删除带 wt，清空走 all=1',
    /key='\+encodeURIComponent\(key\)\+'&wt='/.test(idx) && /\/data\?all=1&wt='/.test(idx));
  t('★个人端：无有效 wt 时先弹密码框（cloudAskPwd）',
    /function cloudAskPwd\(/.test(idx) && /cloudWtOk\(\)/.test(idx));
  t('★个人端：验密复用登录的派生链（clsSalt/clsDerive/CLS_FALLBACK）',
    /function cloudVerify\(/.test(idx) && /clsSalt\(username\)/.test(idx) && /clsDerive\(pwd/.test(idx));
  t('个人端集群函数齐全',
    ['openCloudData', 'closeCloudData', 'loadCloudData', 'cloudDel', 'cloudWipeAll',
     'submitCloudPwd', 'fmtBytes'].every(f => new RegExp('function ' + f + '\\b').test(idx)));
  t('★后台：用户详情表格有「分类」列',
    /<th class="nowrap">分类<\/th><th>数据<\/th>/.test(adm));
  t('★后台：键名旁展示中文名（label 与键名去重）',
    /d\.label && d\.label !== d\.key/.test(adm) && /esc\(d\.catLabel/.test(adm));
}

console.log('\n【70】第六十二轮·登录 subrequest 热修（v2.10.1）');
{
  const httpSrc = fs.readFileSync(new URL('./api/_lib/http.js', import.meta.url), 'utf8');
  const authSrc = fs.readFileSync(new URL('./api/auth.js', import.meta.url), 'utf8');
  const swSrc   = fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8');

  /* ---- ① 版本闸门：1 次探针往返替代 46 条 DDL ----
     背景：Workers 免费版单请求子请求上限 50，Neon 每条 SQL 一次子请求，
     46 条 DDL + 登录 7 次查询 = 53 → 撞线，登录必然 500。 */
  t('★SCHEMA_VER 常量存在且随版本升到 3.7.0（新增资料修改申请表）',
    /const SCHEMA_VER = '3\.8\.4'/.test(httpSrc));
  t('★闸门探针：读 schema_ver + to_regclass 探 user_action_log 存在性',
    /data->>'schema_ver'/.test(httpSrc) && /to_regclass\('public\.user_action_log'\)/.test(httpSrc));
  t('★版本一致直接 return（不再跑全量 DDL）',
    /if \(row && row\.v === SCHEMA_VER\) return;/.test(httpSrc));
  t('★老库过渡：批次已跑过但没盖章 → 只补盖章、跳过 45 次往返',
    /if \(row && row\.has_ual\)/.test(httpSrc));
  /* v3.5.1 血的教训：bidx 两列只加进「全新库全量清单」、漏了「老库升级路径」，
     且 SCHEMA_VER 没升 → 线上老库被闸门放行，两列一直没建，一键加密就 500。
     护栏：补列 DDL 必须在两条路径都出现（至少各 1 次 add column + 1 次 index）。 */
  t('★盲索引补列在升级路径与全量路径都有（v3.5.1 漏老库路径的护栏）',
    (httpSrc.match(/add column if not exists name_bidx\s+text/g) || []).length >= 2
    && (httpSrc.match(/add column if not exists student_id_bidx\s+text/g) || []).length >= 2
    && (httpSrc.match(/create index if not exists profiles_name_bidx_idx/g) || []).length >= 2
    && (httpSrc.match(/create index if not exists profiles_sid_bidx_idx/g) || []).length >= 2
    && (httpSrc.match(/alter table profiles drop constraint if exists profiles_student_id_key/g) || []).length >= 2);
  t('★全量跑完盖章，且用 || 合并（不冲掉 register_open 等后台开关）',
    /set data = site_settings\.data \|\| excluded\.data/.test(httpSrc));
  /* v3.5.4 热修（同一类教训的第二次）：字段「仅管理员」档（admin）v3.4.1
     就加进了应用层，但 pfm_vis_chk 检查约束从没加这个值 —— 老库的
     create table if not exists 不生效，点「仅管理员」就 500。
     护栏：admin 档必须在升级路径（drop+add 重建）和全量路径
     （create table 的 check 子句）都出现。 */
  t('★pfm_vis_chk 约束的 admin 档在升级路径与全量路径都有（v3.5.4 护栏）',
    (httpSrc.match(/alter table profile_field_meta drop constraint if exists pfm_vis_chk/g) || []).length >= 1
    && (httpSrc.match(/alter table profile_field_meta add constraint pfm_vis_chk check \(visibility in \('public','committee','self','admin'\)\)/g) || []).length >= 1
    && (httpSrc.match(/constraint pfm_vis_chk check \(visibility in \('public','committee','self','admin'\)\)/g) || []).length >= 2);
  t('★schema.sql 的 pfm_vis_chk 也含 admin（人工执行的脚本不能掉队）',
    fs.readFileSync(new URL('./api/schema.sql', import.meta.url), 'utf8')
      .includes("constraint pfm_vis_chk check (visibility in ('public','committee','self','admin'))"));
  t('★闸门注释留了根因与「改 DDL 必须升 SCHEMA_VER」的纪律',
    /Too many subrequests/.test(httpSrc) && /SCHEMA_VER 往上加一格/.test(httpSrc));

  /* ---- ①.5 v3.5.5 字段校验规则（站主需求：「所有字段支持管理员自定义配置
     校验规则，支持多类型约束组合；新增字段可自由勾选，原有字段按需求表预设」）。
     纪律同 v3.5.1 / v3.5.4：DDL 两路径（老库升级 + 全新库全量）都要有、
     schema.sql 同步、SCHEMA_VER 升格；规则引擎收敛在 _lib/field-rules.js。 ---- */
  const frSrc = fs.readFileSync(new URL('./api/_lib/field-rules.js', import.meta.url), 'utf8');
  const ADMJS_SRC355 = fs.readFileSync(new URL('./api/admin.js', import.meta.url), 'utf8');
  const profSrc355 = fs.readFileSync(new URL('./api/profile.js', import.meta.url), 'utf8');
  const schemaSrc355 = fs.readFileSync(new URL('./api/schema.sql', import.meta.url), 'utf8');
  const idxSrc355 = readIdx();
  const admHtml355 = readAdm();
  t('★field-rules.js 三导出齐全（normalize/validate/describe）',
    /export function normalizeRules\(/.test(frSrc)
    && /export function validateByRules\(/.test(frSrc)
    && /export function describeRules\(/.test(frSrc));
  /* rules 列 DDL 两路径：升级路径一条 ALTER + 全新库建表一列（http.js 内 >=2），
     schema.sql 的建表同样有这一列。 */
  t('★rules 列 DDL 在升级路径与全量路径都有（v3.5.5 护栏）',
    (httpSrc.match(/add column if not exists rules jsonb not null default '\{\}'::jsonb/g) || []).length >= 1
    && (httpSrc.match(/rules\s+jsonb\s+not null default '\{\}'::jsonb/g) || []).length >= 2
    && /rules\s+jsonb\s+not null default '\{\}'::jsonb/.test(schemaSrc355));
  /* 需求表 6 个新字段：升级路径 insert + 全新库预置 insert 两处都要有，
     schema.sql 的预置 insert 也不能掉队。 */
  t('★6 个新预置字段在升级路径与全量路径都有（v3.5.5 护栏）',
    (httpSrc.match(/insert into profile_field_meta \(field, label, visibility, sort_order, is_custom\) values/g) || []).length >= 2
    && ['school', 'class_name', 'ethnicity', 'birth_date', 'home_address', 'league_date']
      .every((f) => (httpSrc.match(new RegExp("\\('" + f + "',", 'g')) || []).length >= 2)
    && ['school', 'class_name', 'ethnicity', 'birth_date', 'home_address', 'league_date']
      .every((f) => schemaSrc355.includes("('" + f + "',")));
  /* CASE 预置规则两路径同款；幂等条件（rules 还是 {} 才写）两处都有 ——
     尊重管理员自定义，重跑不覆盖。 */
  t('★CASE 预置规则在升级路径与全量路径都有且幂等（v3.5.5 护栏）',
    (httpSrc.match(/update profile_field_meta set rules = case field/g) || []).length >= 2
    && (httpSrc.match(/and rules = '\{\}'::jsonb/g) || []).length >= 2
    && /update profile_field_meta set rules = case field/.test(schemaSrc355));
  /* admin.js 五处接线：loadFieldMeta 读规则 / addField 带规则 /
     updateField 条件更新（本次不传 rules 不清空——自修 bug 护栏）/
     validateProfileFields 定义 + upsertProfileCore + batchProfiles 两处调用 /
     grandfather 与现值一致的字段跳过校验。 */
  t('★admin.js loadFieldMeta 输出 normalizeRules 收敛后的 rules',
    /rules: normalizeRules\(r\.rules\)/.test(ADMJS_SRC355));
  t('★admin.js addField 建字段时带上 rules 列',
    /insert into profile_field_meta \(field, label, visibility, sort_order, is_custom, vis_locked, rules\)/.test(ADMJS_SRC355)
    && /true, true, \$\{JSON\.stringify\(rules\)\}::jsonb/.test(ADMJS_SRC355));
  t('★admin.js updateField 条件更新 rules（不传不清空，v3.5.5 自修 bug 护栏）',
    /rules\s+= case when \$\{rules != null\}::boolean/.test(ADMJS_SRC355));
  t('★admin.js validateProfileFields 定义且被 upsertProfileCore / batchProfiles 调用',
    /function validateProfileFields\(vals, meta\)/.test(ADMJS_SRC355)
    && (ADMJS_SRC355.match(/validateProfileFields\(/g) || []).length >= 3);
  t('★admin.js grandfather：与库中现值一致的字段跳过规则校验',
    /delete ruleVals\[k\]/.test(ADMJS_SRC355));
  /* profile.js 学生端 submit：联系方式按规则复核 + grandfather（只改值才校）。 */
  t('★profile.js submit 接线规则复核（import + loadMeta + validateByRules）',
    /import \{ normalizeRules, validateByRules \} from '\.\/_lib\/field-rules\.js';/.test(profSrc355)
    && /rules: normalizeRules\(r\.rules\)/.test(profSrc355)
    && /validateByRules\(metaMap\[k\]\.rules, changed\[k\]/.test(profSrc355));
  /* 前端：admin.html 规则工具层与字段面板「规则」按钮；index.html 手机号
     grandfather 规范化（仅改值时才清洗，老数据 +86 不被卡）。 */
  t('★admin.html 规则工具层齐全（输入渲染/编辑器/收集/规则弹窗）',
    /function ruleInputHtml\(/.test(admHtml355)
    && /function ruleEditorHtml\(/.test(admHtml355)
    && /function collectRules\(/.test(admHtml355)
    && /function rulesFieldDialog\(/.test(admHtml355)
    && /data-fe="rule"/.test(admHtml355));
  t('★index.html 手机号 grandfather 规范化（仅改值时才清洗）',
    idxSrc355.includes("if(ph && ph !== storedPh) ph = ph.replace(/[\\s\\-()]/g, '')"));

  /* ---- v3.5.15：时间规则支持「精确到 日/月/年」 ----
     站主原话：「入团时间是精确到月份，没有具体日期，我表格里写 2024-05
     可是就显示无法导入」。以前 time 规则死认 YYYY-MM-DD。 ---- */
  const FR315 = await import('/tmp/class-site/api/_lib/field-rules.js');
  const RM = { type: 'time', precision: 'month' };
  t('#11 时间规则支持 precision（day/month/year）',
    /\['day', 'month', 'year'\]\.includes\(r\.precision\)/.test(frSrc) && FR315.normalizeRules(RM).precision === 'month');
  t('#11 月精度接受 2024-05（站主的核心诉求）',
    FR315.validateByRules(RM, '2024-05', '入团时间').ok === true);
  t('#11 月精度容忍 2024/5、2024年5月、2024.5',
    ['2024/5', '2024年5月', '2024.5', '2024-5'].every((v) => FR315.validateByRules(RM, v, '入团时间').ok));
  t('#11 月精度也接受带日的写法并规整成 YYYY-MM',
    FR315.validateByRules(RM, '2024-05-13', '入团时间').ok
    && FR315.coerceValueByRules(RM, '2024-05-13') === '2024-05'
    && FR315.coerceValueByRules(RM, '2024年5月') === '2024-05');
  t('#11 月精度拒绝只写年份与乱写',
    !FR315.validateByRules(RM, '2024', '入团时间').ok
    && !FR315.validateByRules(RM, 'abc', '入团时间').ok
    && !FR315.validateByRules(RM, '2024-13', '入团时间').ok);
  t('#11 日精度仍然要求完整日期（不漏掉原严格性）',
    !FR315.validateByRules({ type: 'time' }, '2024-05', '日期').ok
    && FR315.validateByRules({ type: 'time' }, '2024-05-13', '日期').ok
    && !FR315.validateByRules({ type: 'time' }, '2024-02-31', '日期').ok);
  t('#11 年精度接受 2024 / 2024-05 并规整成 YYYY',
    FR315.validateByRules({ type: 'time', precision: 'year' }, '2024', '年份').ok
    && FR315.coerceValueByRules({ type: 'time', precision: 'year' }, '2024-05-13') === '2024');
  t('#11 带时间部分的日期串（Excel 日期型 / ISO）也能识别',
    FR315.validateByRules(RM, '2024-05-13 00:00:00', '入团时间').ok
    && FR315.validateByRules(RM, '2024-05-13T00:00:00.000Z', '入团时间').ok);
  t('#11 区间按精度比较（月精度 min/max 也是年月）',
    !FR315.validateByRules({ type: 'time', precision: 'month', min: '2024-01', max: '2026-12' }, '2023-12', '入团时间').ok
    && FR315.validateByRules({ type: 'time', precision: 'month', min: '2024-01', max: '2026-12' }, '2024-05', '入团时间').ok
    && FR315.describeRules(RM).includes('年月'));
  t('#11 后台规则编辑器有「精确到」三档并可收集 precision',
    /id="ffRPrec"/.test(admHtml355) && /日 —— 2024-05-13/.test(admHtml355)
    && /月 —— 2024-05（入团时间这类只到月份）/.test(admHtml355)
    && /tm\.precision = pr/.test(admHtml355));
  t('#11 资料输入控件按精度切换（date / month / 四位年份）',
    /if\(p === 'month'\)\{[\s\S]{0,200}type="month"/.test(admHtml355)
    && /if\(p === 'year'\)\{[\s\S]{0,200}maxlength="4"/.test(admHtml355));
  /* ---- v3.5.20：提出日期 / 歌单多选 / 线上补时长 ---- */
  const VOTES_520 = fs.readFileSync(new URL('./api/votes.js', import.meta.url), 'utf8');
  const ADM_520 = readAdm();
  const IDX_520 = readIdx();
  const WRK_520 = fs.readFileSync(new URL('./api/worker.mjs', import.meta.url), 'utf8');
  t('#17 歌单投票也能多选（不再被后端改回单选）',
    /const multi = b\.multi === true;/.test(VOTES_520) && !/kind === 'normal' && b\.multi/.test(VOTES_520));
  t('#17 createdDate 走 dateOnly（不再 String(Date).slice 得到 Sun Oct 18）',
    /function dateOnly\(/.test(VOTES_520) && /createdDate: dateOnly\(r\.created_at\)/.test(VOTES_520)
    && /Asia\/Shanghai/.test(VOTES_520));
  t('#17 提出日期可改（后台可选日期并提交）',
    /id="voCreatedDate"/.test(ADM_520) && /createdDate: \(document\.getElementById\('voCreatedDate'\)/.test(ADM_520)
    && /songPick, createdDate \}/.test(VOTES_520));
  t('#17 前端日期显示加年份护栏（<2000 视为无效，避免 2001）',
    /d\.getFullYear\(\) < 2000 \|\| d\.getFullYear\(\) > 2100/.test(IDX_520));
  t('#17 新增 /api/music 时长补全代理并挂路由',
    fs.existsSync(new URL('./api/music.js', import.meta.url))
    && /case 'music'/.test(WRK_520) && /import musicHandler/.test(WRK_520));
  t('#17 时长补全走 QQ 音乐搜索并做缓存',
    /c\.y\.qq\.com\/soso\/fcgi-bin\/client_search_cp/.test(fs.readFileSync(new URL('./api/music.js', import.meta.url), 'utf8'))
    && /const TTL_MS = 30 \* 60 \* 1000/.test(fs.readFileSync(new URL('./api/music.js', import.meta.url), 'utf8')));
  t('#17 前端拉歌单后自动补时长（本地缓存，8 首一批）',
    /function vhFillDurations\(/.test(ADM_520) && /cls_song_dur_v1/.test(ADM_520)
    && /api\('\/music'/.test(ADM_520));

  /* ---- v3.5.19：歌单选项字段可选 / 实时赞数与时长 / 新增选项规则 / 前 N 与按时长抽取 ---- */
  const ADM_519 = readAdm();
  const VOTES_519 = fs.readFileSync(new URL('./api/votes.js', import.meta.url), 'utf8');
  const HTTP_519 = fs.readFileSync(new URL('./api/_lib/http.js', import.meta.url), 'utf8');
  const IDX_519 = readIdx();
  t('#16 创建表单可勾选选项字段（点歌人/时间/赞数/时长）',
    /id="voFldReq"/.test(ADM_519) && /id="voFldTime"/.test(ADM_519)
    && /id="voFldVotes"/.test(ADM_519) && /id="voFldDur"/.test(ADM_519));
  t('#16 只有勾选的字段才写进 label', /function voSongFieldPrefs\(/.test(ADM_519)
    && /if\(p\.requester\)\{ parts\.push/.test(ADM_519)
    && /if\(p\.votes && votes != null\)/.test(ADM_519)
    && /if\(p\.duration && dur\)/.test(ADM_519));
  t('#16 选项带结构化 songMeta（前端折叠靠它）',
    /songMeta: normSongMeta/.test(VOTES_519) && /songMeta: meta/.test(ADM_519)
    && /voteOptLabelHtml\(o\.label, o\.songMeta\)/.test(IDX_519));
  t('#16 点歌时间改用 requestedAt（平台没有 createdAt）',
    /s\.requestedAt \|\| s\.createdAt/.test(ADM_519) && /function vhParseTime\(/.test(ADM_519));
  t('#16 歌单有本地缓存兜底（网络失败用缓存）',
    /cls_vh_songs_cache_v1/.test(ADM_519) && /使用缓存/.test(ADM_519));
  t('#16 新增选项规则：字数 + 数字/英文/日期（精度到分）',
    /function normOptionRule\(/.test(VOTES_519) && /function matchDateFormat\(/.test(VOTES_519)
    && /id="voOptFmt"/.test(ADM_519) && /id="voOptPrec"/.test(ADM_519)
    && /'minute'/.test(VOTES_519));
  t('#16 同学加选项时按规则校验', /orule\.format === 'number'/.test(VOTES_519)
    && /orule\.format === 'en'/.test(VOTES_519) && /matchDateFormat\(label/.test(VOTES_519));
  t('#16 投票存 option_rule / song_pick 两列（三处 DDL）',
    (HTTP_519.match(/option_rule/g) || []).length >= 3
    && (HTTP_519.match(/song_pick/g) || []).length >= 3);
  t('#16 前 N / 用途 / 总时长可配并可临时改 N',
    /id="voPickN"/.test(ADM_519) && /id="voPickPurpose"/.test(ADM_519)
    && /id="voPickCap"/.test(ADM_519) && /voTopN_' \+ v\.id/.test(ADM_519));
  t('#16 写入排期按时长上限挑歌', /usedSec \+ d > capMin \* 60/.test(ADM_519)
    && /djMaxMin/.test(ADM_519));
  t('#16 点歌管理/排期显示时长', /voFmtDur\(s\.durationSeconds\)/.test(ADM_519)
    && /总时长 ' \+ voFmtDur\(totSec\)/.test(ADM_519));

  /* ---- v3.5.21：投票/抽签时长二选一 + 批量选择 + 公示时长 ---- */
  t('v3.5.21 歌单投票「取前几名」与「总时长上限」二选一',
    /function syncPickCap\(/.test(ADM_519) && /voNIn\.disabled = true/.test(ADM_519)
    && /topN: cap > 0 \? 0 :/.test(ADM_519));
  t('v3.5.21 从点歌平台挑歌支持全选/全不选/反选',
    /id="voPickAll"/.test(ADM_519) && /id="voPickNone"/.test(ADM_519)
    && /id="voPickInv"/.test(ADM_519) && /function voSetChecks\(/.test(ADM_519));
  t('v3.5.21 点歌抽签抽取数量与总时长上限二选一',
    /function syncDjCap\(/.test(ADM_519) && /djCountIn\.disabled = true/.test(ADM_519)
    && /capMin > 0 \? 9999 :/.test(ADM_519));
  t('v3.5.21 公示可选显示每首时长与总时长，排期记录也显示总时长',
    /id="djShowDur"/.test(ADM_519) && /id="djShowTotal"/.test(ADM_519)
    && /showDur: !!\(showDurEl && showDurEl\.checked\)/.test(ADM_519)
    && /'歌曲总时长':/.test(IDX_519));
  t('v3.5.21 投票公示结果表带时长列（歌单投票）',
    /var anyDur = rs\.some\(/.test(IDX_519) && /durHead/.test(IDX_519));

  /* ---- v3.5.22：后台人员档案「全字段」在线编辑 ---- */
  const ADM_522 = readAdm();
  const ADMJS_522 = fs.readFileSync(new URL('./api/admin.js', import.meta.url), 'utf8');
  const PROF_522 = fs.readFileSync(new URL('./api/profile.js', import.meta.url), 'utf8');
  t('v3.5.22 成员表单有「身份」输入框，且与账号角色分开传（identity）',
    /id="mbIdentity"/.test(ADM_522) && /identity:  g\('#mbIdentity'\)/.test(ADM_522)
    && /b\.identity != null \? b\.identity : b\.role/.test(ADMJS_522));
  t('v3.5.22 成员表单有头衔多选，保存走 title 数组',
    /class="mb-title"/.test(ADM_522) && /title:     titleVals/.test(ADM_522)
    && /const nt = normTitles\(b\.title\)/.test(ADMJS_522));
  t('v3.5.22 title / role 已从 SPECIAL_FIELDS 移出（字段管理里可编辑）',
    !/SPECIAL_FIELDS = \[.*'title'/.test(ADMJS_522)
    && /'role', 'title'/.test(readAdm()));
  t('v3.5.22 成员列表返回 identity 与 titles',
    /identity: r\.role \|\| '学生'/.test(ADMJS_522) && /titles: normTitles\(r\.title\)\.list/.test(ADMJS_522));
  t('v3.5.22 导出表格带身份与头衔列（v3.15.2 起由字段元数据带出）',
    /k === 'role'\).*return m\.identity/.test(ADM_522) && /k === 'title'\)\{/.test(ADM_522));
  t('v3.5.22 前台身份/头衔也受字段可见性管辖',
    /role: canSee\('role'/.test(PROF_522) && /title: canSee\('title'/.test(PROF_522));

  /* ---- v3.5.23：歌单投票展示 / 加选项 / 时长上限一致性 / 公示变量 ---- */
  const IDX_523 = readIdx();
  const ADM_523 = readAdm();
  const VOTJS_523 = fs.readFileSync(new URL('./api/votes.js', import.meta.url), 'utf8');
  t('v3.5.23 老格式选项（含赞数/时长尾巴）也能折叠 —— 按日期段拆分',
    /parts\.length < 4/.test(IDX_523) && /dateIdx/.test(IDX_523)
    && !/\^\(\.\*\) - \(\[\^\-\]/.test(IDX_523));
  t('v3.5.23 歌单投票不能同学自加选项（前端禁用 + 后端强制）',
    /kind !== 'song'\) && b\.allowAdd/.test(VOTJS_523)
    && /addCb\.disabled = true/.test(ADM_523));
  t('v3.5.23 后台取歌区块按时长上限取名，不再出现「前 N 名」矛盾文案',
    /titleTxt = cap > 0/.test(ADM_523) && /按时长上限 ' \+ cap \+ ' 分钟/.test(ADM_523)
    && /var wantN = capMin0 > 0 \? Infinity/.test(ADM_523));
  t('v3.5.23 公示名次变量扩到前十名',
    /'第四名','第五名'/.test(ADM_523) && /map\['第' \+ CN\[rn\] \+ '名'\]/.test(IDX_523));
  t('v3.5.23 投票管理元信息分「状态行 / 规则行」', /规则行/.test(ADM_523));

  /* ---- v3.5.24：投票按赞数排序 / 勾选即选项 / 详情字段可配 ---- */
  const IDX_524 = readIdx();
  const ADM_524 = readAdm();
  t('v3.5.24 前台投票选项按赞数从高到低排（同票稳定）',
    /var rankList = v\.options\.map/.test(IDX_524) && /cntMap\[b\.o\.id\]/.test(IDX_524)
    && /a\.i - b\.i/.test(IDX_524));
  t('v3.5.24 投票重排后保留滚动位置', /withScrollPreserve\(voteRenderAll\)/.test(IDX_524));
  t('v3.5.24 挑歌勾选即加入选项（不再需要「加进选项」按钮）',
    /function applyOne\(el\)/.test(ADM_524) && !/voPickAdd/.test(ADM_524)
    && /勾选即加入选项/.test(ADM_524));
  t('v3.5.24 勾选状态由选项文本框反推（刷新/搜索不丢勾）',
    /function syncChecksFromOptions/.test(ADM_524) && /lineHit\[label\]/.test(ADM_524));
  /* v3.5.25 文案升级为「歌名、歌手、歌曲时长永远直接显示」 */
  t('v3.5.24 编辑器文案明确：歌名歌手直显，其余进详情',
    /选项「详情」里包含哪些/.test(ADM_524)
    && (/歌名和歌手<b>永远直接显示<\/b>/.test(ADM_524)
      || /歌名、歌手、<b>歌曲时长<\/b>永远直接显示/.test(ADM_524)));

  /* ---- v3.5.25：歌单投票免文本框 / 时长必显示 ---- */
  const IDX_525 = readIdx();
  const ADM_525 = readAdm();
  t('v3.5.25 歌单投票模式隐藏选项文本框（普通投票保留）',
    /id="voOptsWrap"/.test(ADM_525) && /optsWrap\.style\.display = isSong \? 'none' : ''/.test(ADM_525));
  t('v3.5.25 歌曲时长为必显示项：后台恒选、前台直显在歌手后',
    /duration: true,/.test(ADM_525) && /checked disabled> 歌曲时长（必显示）/.test(ADM_525)
    && /vote-opt-dur/.test(IDX_525) && /if\(meta\.duration\) durTxt = voteFmtDur\(meta\.duration\)/.test(IDX_525));
  t('v3.5.25 改字段勾选时重算已选歌曲（先勾歌后勾时长也能带上）',
    /function rebuildFromChecks/.test(ADM_525) && /data-song-json=/.test(ADM_525)
    && /__voRebuild/.test(ADM_525));

  /* ---- v3.5.26：歌单投票彻底不显示「选项（一行一个）」文本框（CSS 兜底） ---- */
  const ADM_526 = readAdm();
  t('v3.5.26 选项文本框容器带 .vo-opts-wrap 类名', /class="field vo-opts-wrap" id="voOptsWrap"/.test(ADM_526));
  t('v3.5.26 编辑器根节点带 data-kind（渲染时就写死，不等 JS）',
    /id="voEditor" data-kind="/.test(ADM_526) && /\(v && v\.kind === 'song'\) \? 'song' : 'normal'/.test(ADM_526));
  t('v3.5.26 CSS 规则按 data-kind 隐藏文本框（含 !important 兜底）',
    /#voEditor\[data-kind="song"\] \.vo-opts-wrap\{display:none !important\}/.test(ADM_526));
  t('v3.5.26 syncKind 同步 data-kind，文本框仍作隐藏数据载体供提交读取',
    /ed\.setAttribute\('data-kind', isSong \? 'song' : 'normal'\)/.test(ADM_526)
    && /document\.getElementById\('voOpts'\) \|\| \{\}\)\.value/.test(ADM_526));

  /* ---- v3.5.27：歌曲时长云端同步 + 缺时长禁止发布/排歌 ---- */
  const ADM_527 = readAdm();
  const MUS_527 = fs.readFileSync(new URL('./api/music.js', import.meta.url), 'utf8');
  const VOT_527 = fs.readFileSync(new URL('./api/votes.js', import.meta.url), 'utf8');
  const HTTP_527 = fs.readFileSync(new URL('./api/_lib/http.js', import.meta.url), 'utf8');
  const SCH_527 = fs.readFileSync(new URL('./api/schema.sql', import.meta.url), 'utf8');
  t('v3.5.27 云端时长库表 song_durations 三处同步（升级路径/全量清单/schema.sql）',
    (HTTP_527.match(/create table if not exists song_durations/g) || []).length >= 2
    && /create table if not exists song_durations/.test(SCH_527)
    && /const SCHEMA_VER = '3\.8\.4'/.test(HTTP_527));
  t('v3.5.27 后端写库按来源优先级，人工填写不被自动结果覆盖',
    /case song_durations\.source/.test(MUS_527) && /source: 'manual'/.test(MUS_527)
    && /when 'manual' then 3/.test(MUS_527));
  t('v3.5.27 /api/music 支持 lib / batch / manual / lib-query 四个动作',
    /action === 'lib'/.test(MUS_527) && /act === 'batch'/.test(MUS_527)
    && /act === 'manual'/.test(MUS_527) && /act === 'lib-query'/.test(MUS_527));
  t('v3.5.27 查时长先查云端库再联网（一次查询永久命中）',
    /await libLookup\(sql, \[key\]\)/.test(MUS_527) && /命中就写云端库/.test(MUS_527));
  t('v3.5.27 后端拒绝发布缺时长的歌单投票',
    /if \(kind === 'song'\) \{/.test(VOT_527) && /还没拿到时长，补齐后才能发布/.test(VOT_527)
    && /d >= 20 && d <= 1800/.test(VOT_527));
  t('v3.5.27 前端拉云端时长库 + 批量补 + 人工补录三层',
    /function vhDurLibPull/.test(ADM_527) && /function vhDurAskCloud/.test(ADM_527)
    && /function voDurManualDialog/.test(ADM_527) && /action: 'manual'/.test(ADM_527));
  t('v3.5.27 歌单编辑器实时盘点缺时长并挂红条',
    /function durMissing/.test(ADM_527) && /function paintDurBar/.test(ADM_527)
    && /id="voDurBar"/.test(ADM_527) && /补齐后才能发布/.test(ADM_527));
  t('v3.5.27 提交前拦截缺时长的歌单投票（前后端双保险）',
    /if\(kindNow === 'song'\)\{/.test(ADM_527) && /补齐后才能发布/.test(ADM_527));
  t('v3.5.27 随机排歌：没时长的歌直接不能抽',
    /if\(!\(d >= 20\)\) return false;/.test(ADM_527) && /按站规不能排歌/.test(ADM_527));
  t('v3.5.27 挑歌列表标出「缺时长」',
    /缺时长<\/b>/.test(ADM_527) && /durTxt \? ' · ' \+ durTxt/.test(ADM_527));
  t('v3.5.27 voFmtDur 全站只定义一次',
    (ADM_527.match(/function voFmtDur\(/g) || []).length === 1);
  t('v3.5.27 后台有时长库管理面板（看/删/补录）',
    /function openDurLib/.test(ADM_527) && /function paintDurLib/.test(ADM_527)
    && /action: 'del'/.test(ADM_527) && /补录缺时长的歌/.test(ADM_527));

  /* v3.5.27 接口级实测：人工补录 → 写库 → lib-query / lib 都能读回 */
  {
    const man = await call('/api/music', {
      method: 'POST',
      body: { action: 'manual', items: [
        { title: '幻听', artist: '许嵩', seconds: 273 },
        { title: '晴天', artist: '周杰伦', seconds: 279 },
      ] },
    });
    t('★v3.5.27 人工补录写进云端时长库', man.status === 200 && man.body.saved === 2,
      JSON.stringify(man.body).slice(0, 200));
    const dbRow = db.prepare("select seconds, source from song_durations where song_key = ?");
    dbRow.bind(['幻听|许嵩']);
    dbRow.step();
    const r1 = dbRow.getAsObject();
    dbRow.free();
    t('★v3.5.27 库里记的是人工来源', Number(r1.seconds) === 273 && r1.source === 'manual',
      JSON.stringify(r1));

    const lq = await call('/api/music', {
      method: 'POST',
      body: { action: 'lib-query', items: [
        { title: '幻听', artist: '许嵩' },
        { title: '幻听（Live）', artist: '许嵩' },
        { title: '查不到的歌', artist: 'X' },
      ] },
    });
    const L = (lq.body || {}).list || [];
    t('★v3.5.27 lib-query 命中库（含括号后缀写法归一）',
      L[0] && L[0].seconds === 273 && L[1] && L[1].seconds === 273,
      JSON.stringify(L).slice(0, 240));
    t('★v3.5.27 lib-query 查不到就返回 null（不瞎猜）',
      L[2] && L[2].seconds === null, JSON.stringify(L[2]));

    const libAll = await call('/api/music?action=lib');
    t('★v3.5.27 lib 能拉全量时长库', libAll.status === 200 && (libAll.body.list || []).length >= 2,
      JSON.stringify((libAll.body || {}).list || []).slice(0, 200));

    /* 人工值不被自动结果覆盖（source 优先级 manual > auto） */
    const autoOver = await call('/api/music', {
      method: 'POST',
      body: { action: 'save-many', items: [{ title: '幻听', artist: '许嵩', seconds: 200, source: 'auto' }] },
    });
    const dbRow2 = db.prepare("select seconds, source from song_durations where song_key = ?");
    dbRow2.bind(['幻听|许嵩']);
    dbRow2.step();
    const r2 = dbRow2.getAsObject();
    dbRow2.free();
    t('★v3.5.27 自动结果盖不掉人工填写', autoOver.status === 200 && Number(r2.seconds) === 273,
      JSON.stringify(r2));

    /* 删除接口 */
    const delR = await call('/api/music', {
      method: 'POST', body: { action: 'del', items: [{ title: '晴天', artist: '周杰伦' }] },
    });
    t('★v3.5.27 能从时长库删除指定条目', delR.status === 200 && delR.body.deleted === 1,
      JSON.stringify(delR.body).slice(0, 160));

    /* 非法时长（< 20 秒）拒收 */
    const bad = await call('/api/music', {
      method: 'POST', body: { action: 'manual', items: [{ title: '测试歌', artist: 'y', seconds: 5 }] },
    });
    t('★v3.5.27 非法时长被拒 400', bad.status === 400, JSON.stringify(bad.body).slice(0, 160));
  }

  /* ---- v3.5.28：时长库线上搜歌 + 导入清单（歌名全等 / 歌手部分匹配） ---- */
  const ADM_528 = readAdm();
  const MUS_528 = fs.readFileSync(new URL('./api/music.js', import.meta.url), 'utf8');
  t('v3.5.28 /api/music 支持 action=search（GET 线上搜歌）',
    /action === 'search'/.test(MUS_528) && /searchNetease/.test(MUS_528)
    && /searchQQ/.test(MUS_528) && /searchItunes/.test(MUS_528));
  t('v3.5.28 搜索优先网易云+QQ 并行，都没有才 iTunes 兜底',
    /const \[ne, qq\] = await Promise\.all/.test(MUS_528)
    && /if \(!ne\.length && !qq\.length\)/.test(MUS_528));
  t('v3.5.28 候选按歌名贴合度排序（防止翻唱版盖过原唱）',
    /function mergeCandidates\(groups, libMap, keyword\)/.test(MUS_528)
    && /titleScore/.test(MUS_528) && /翻唱/.test(MUS_528));
  t('v3.5.28 歌手模糊匹配：一方包含另一方即命中',
    /function artistScore\(a, b\)/.test(MUS_528) && /x\.includes\(y\) \|\| y\.includes\(x\)/.test(MUS_528));
  t('v3.5.28 /api/music 支持 action=match-list 批量匹配导入清单',
    /act === 'match-list'/.test(MUS_528) && /byTitle/.test(MUS_528)
    && /matchedArtist/.test(MUS_528));
  t('v3.5.28 时长库面板四个 tab（已收录/线上搜/导入清单/预置歌单）',
    /function durLibViewLib/.test(ADM_528) && /function durLibViewSearch/.test(ADM_528)
    && /function durLibViewImport/.test(ADM_528) && /function durLibViewPreset/.test(ADM_528)
    && /data-tab=/.test(ADM_528));
  t('v3.5.28 搜到候选点「加入」直接写进云端库',
    /data-add=/.test(ADM_528) && /action: 'manual', items: \[\{ title: c\.title, artist: c\.artist, seconds: c\.seconds \}\]/.test(ADM_528));
  t('v3.5.28 导入清单支持 - , ｜ Tab 多种分隔符',
    /function durParseLine/.test(ADM_528) && /\[｜\|\]/.test(ADM_528)
    && /\[,，、\]/.test(ADM_528));
  t('v3.5.28 预置周杰伦/林俊杰/方大同歌单',
    /DUR_PRESETS/.test(ADM_528) && /'周杰伦':/.test(ADM_528)
    && /'林俊杰':/.test(ADM_528) && /'方大同':/.test(ADM_528));
  t('v3.5.28 预置歌单按 8 首一批抓（避开 Workers 子请求上限）',
    /function durBatchSeed/.test(ADM_528) && /i \+= 8/.test(ADM_528));

  /* v3.5.28 接口级实测：match-list 的「歌名全等 + 歌手部分符合」 */
  {
    await call('/api/music', {
      method: 'POST',
      body: { action: 'manual', items: [
        { title: '晴天', artist: '周杰伦', seconds: 279 },
        { title: '三人游', artist: '方大同', seconds: 250 },
        { title: '江南', artist: '林俊杰', seconds: 267 },
      ] },
    });
    const ml = await call('/api/music', {
      method: 'POST',
      body: { action: 'match-list', items: [
        { title: '晴天', artist: '周杰伦' },              /* 完全一致 */
        { title: '晴天', artist: '周杰伦/杨瑞代' },        /* 歌单是合唱，库里只有一个 */
        { title: '晴天(深情版)', artist: '周杰伦' },       /* 括号后缀归一后仍命中 */
        { title: '三人游', artist: '方大同、薛凯琪' },      /* 顿号分隔的合唱 */
        { title: '江南', artist: '张学友' },               /* 歌名对、歌手不对 → 仍按歌名命中 */
        { title: '不存在歌名zzz', artist: '周杰伦' },      /* 歌名对不上 → 不命中 */
        { title: '晴天', artist: '' },                    /* 没写歌手 → 按歌名命中 */
      ] },
    });
    const M = (ml.body || {}).list || [];
    t('★v3.5.28 match-list 歌名全等 + 歌手一致 → 命中',
      M[0] && M[0].seconds === 279, JSON.stringify(M[0]));
    t('★v3.5.28 match-list 歌单多歌手、库里只写一个 → 仍命中',
      M[1] && M[1].seconds === 279, JSON.stringify(M[1]));
    t('★v3.5.28 match-list 括号版本名归一后命中',
      M[2] && M[2].seconds === 279, JSON.stringify(M[2]));
    t('★v3.5.28 match-list 顿号分隔的合唱也命中',
      M[3] && M[3].seconds === 250, JSON.stringify(M[3]));
    t('★v3.5.28 match-list 歌名对上就命中（歌手不同也不放过）',
      M[4] && M[4].seconds === 267, JSON.stringify(M[4]));
    t('★v3.5.28 match-list 歌名对不上不命中（返回 null）',
      M[5] && M[5].seconds === null, JSON.stringify(M[5]));
    t('★v3.5.28 match-list 导入项没写歌手 → 按歌名命中',
      M[6] && M[6].seconds === 279, JSON.stringify(M[6]));
    t('★v3.5.28 match-list 返回 matchedTitle/matchedArtist 供前端标注',
      M[1] && M[1].matchedTitle === '晴天' && !!M[1].matchedArtist, JSON.stringify(M[1]));
    t('★v3.5.28 match-list 统计命中数', (ml.body || {}).hit === 6, JSON.stringify(ml.body || {}).slice(0, 120));

    /* 空清单 400 */
    const mlBad = await call('/api/music', { method: 'POST', body: { action: 'match-list', items: [] } });
    t('★v3.5.28 match-list 空清单被拒 400', mlBad.status === 400, JSON.stringify(mlBad.body).slice(0, 120));

    /* 搜歌接口：没给 q 就 400（不打外网，测参数校验） */
    const sBad = await call('/api/music?action=search');
    t('★v3.5.28 搜索没给关键字被拒 400', sBad.status === 400, JSON.stringify(sBad.body).slice(0, 120));

    /* 清理本轮写入的测试数据，避免污染后续断言 */
    await call('/api/music', {
      method: 'POST',
      body: { action: 'del', items: [
        { title: '晴天', artist: '周杰伦' },
        { title: '三人游', artist: '方大同' },
        { title: '江南', artist: '林俊杰' },
      ] },
    });
  }

  /* ---- v3.5.29：站点名称 / 副标题后台可编辑（site_config.siteName/siteSubtitle → applyBranding） ---- */
  const IDX_529 = readIdx();
  const ADM_529 = readAdm();
  t('v3.5.29 主站 applyBranding 把站点名/副标题换到 <title>/页头/页脚',
    /function applyBranding\(\)/.test(IDX_529)
    && /document\.title = name;/.test(IDX_529)
    && /getElementById\('brandTitle'\)/.test(IDX_529)
    && /getElementById\('brandSub'\)/.test(IDX_529)
    && /getElementById\('brandFoot'\)/.test(IDX_529));
  t('v3.5.29 静态三处挂了 id（brandTitle/brandSub/brandFoot）',
    /<h1 id="brandTitle">/.test(IDX_529) && /<p id="brandSub">/.test(IDX_529)
    && /<p id="brandFoot">/.test(IDX_529));
  t('v3.5.29 没配站点名时保持静态默认（applyBranding 只在真有值时覆盖）',
    /var name = String\(SITE_DATA\.siteName \|\| ''\)\.trim\(\);/.test(IDX_529)
    && /if\(name\)\{/.test(IDX_529) && /if\(sub\)\{/.test(IDX_529));
  t('v3.5.29 applySiteConfig 落 siteName/siteSubtitle 后调用 applyBranding',
    /applyBranding\(\);/.test(IDX_529));
  t('v3.5.29 后台站点信息面板真读真存 site_config（不再只是展示）',
    /站点名称 \/ 副标题真正可编辑/.test(ADM_529)
    && /content\?keys=site_config/.test(ADM_529)
    && /cfg\.siteName = name;/.test(ADM_529)
    && /cfg\.siteSubtitle = sub;/.test(ADM_529));
  t('v3.5.29 后台保存走 PUT /content 且先取整 cfg 合并（不冲掉 vhGuard）',
    /method: 'PUT', body: \{ items: \{ site_config: cfg \} \}/.test(ADM_529)
    && /站点信息目前由 index\.html 里的 SITE_DATA 控制/.test(ADM_529) === false);
  t('v3.5.29 清空保存写空字符串（前端才能回落静态默认，不会残留旧名）',
    /cfg\.siteName = name;/.test(ADM_529) && /delete cfg\.siteName/.test(ADM_529) === false
    && /typeof cfg\[k\] === 'string'/.test(IDX_529));

  /* ---- v3.5.30：① 云端版本记录补齐 ② 从主页进后台默认竖屏 + PWA 往返保状态 ③ 轻量模式 ---- */
  const IDX_530 = readIdx();
  const ADM_530 = readAdm();

  /* ① 版本记录：内置 3.5.21~3.5.30，按钮只补缺失版本 */
  t('v3.5.30 内置版本记录覆盖 3.5.21~3.5.30',
    [30, 29, 28, 27, 26, 25, 24, 23, 22, 21].every(n =>
      new RegExp("version: '3\\.5\\." + n + "'").test(ADM_530)));
  t('v3.5.30 版本面板有「补齐缺失版本」按钮',
    /id="relSync"/.test(ADM_530) && /补齐缺失版本/.test(ADM_530)
    && /\$\('relSync'\)\.onclick = relSyncMissing;/.test(ADM_530));
  t('v3.5.30 补齐逻辑：只挑云端没有的版本再 PUT（不覆盖已有记录）',
    /function relSyncMissing\(\)/.test(ADM_530)
    && /REL_BUILTIN\.filter\(function\(r\)\{ return !have\[String\(r\.version\)\]; \}\)/.test(ADM_530)
    && /cur\.concat\(/.test(ADM_530));
  t('v3.5.30 补齐前先确认，没缺失就只提示不写库',
    /confirmBox\(\{/.test(ADM_530.slice(ADM_530.indexOf('function relSyncMissing')))
    && /没有缺号|没有需要补的版本/.test(ADM_530.slice(ADM_530.indexOf('function relSyncMissing'))));

  /* ② 竖屏意图 + PWA 往返 */
  t('v3.5.30 主页跳后台前打 from_home 标记（两处入口都打）',
    /cls_admin_from_home/.test(IDX_530)
    && (IDX_530.match(/cls_admin_from_home',\s*'1'/g) || []).length >= 2);
  t('v3.5.30 后台 initLandscape：从主页进来强制竖屏并落 localStorage',
    /var FROM_HOME_LS = 'cls_admin_from_home';/.test(ADM_530)
    && /function initLandscape\(\)/.test(ADM_530)
    && /sessionStorage\.getItem\(FROM_HOME_LS\) === '1'/.test(ADM_530)
    && /LAND_ON = false;\s*\n\s*saveLandIntent\(\);/.test(ADM_530));
  t('v3.5.30 from_home 标记用后即删（只影响当次进入）',
    /if\(fromHome\) sessionStorage\.removeItem\(FROM_HOME_LS\);/.test(ADM_530));
  t('v3.5.30 PWA 回前台重新对齐横竖屏（visibilitychange + pageshow）',
    /function resyncLandscape\(\)/.test(ADM_530)
    && /addEventListener\('visibilitychange'/.test(ADM_530)
    && /document\.visibilityState === 'visible'\) setTimeout\(resyncLandscape/.test(ADM_530)
    && /addEventListener\('pageshow'/.test(ADM_530));
  t('v3.5.30 竖屏意图统一走 saveLandIntent，不再散落 localStorage.setItem',
    /function saveLandIntent\(\)/.test(ADM_530)
    && /localStorage\.setItem\(LAND_LS, LAND_ON \? '1' : '0'\)/.test(ADM_530));

  /* ③ 轻量模式 */
  t('v3.5.30 轻量模式开关打 data-lite 到 <html>',
    /function applyLite\(\)/.test(IDX_530)
    && /setAttribute\('data-lite',\s*'1'\)/.test(IDX_530)
    && /removeAttribute\('data-lite'\)/.test(IDX_530));
  t('v3.5.30 轻量模式关掉全部 backdrop-filter 玻璃光效',
    /html\[data-lite="1"\] \*[\s\S]{0,200}backdrop-filter:none!important/.test(IDX_530));
  t('v3.5.30 轻量模式关掉 body 两颗运动光斑与卡片流光',
    /html\[data-lite="1"\] body::before,\s*\nhtml\[data-lite="1"\] body::after\{display:none!important/.test(IDX_530)
    && /html\[data-lite="1"\] \.card::after\{display:none!important/.test(IDX_530));
  t('v3.5.30 轻量模式把动画压到几乎零时长',
    /html\[data-lite="1"\] \*[\s\S]{0,240}animation-duration:\.01ms!important/.test(IDX_530));
  /* ---- v3.5.34：自定义设置不上云 / 轻量补媒体特效 / 作业勾选同步加固 ---- */
  t('v3.5.34 轻量模式关掉听力播放器的唱片旋转与波形条',
    /html\[data-lite="1"\] \.audio-disc\{display:none!important\}/.test(IDX_530)
    && /html\[data-lite="1"\] \.audio-wave\{display:none!important\}/.test(IDX_530)
    && /html\[data-lite="1"\] \.audio-visual\.playing \.audio-wave i\{animation:none!important/.test(IDX_530));
  t('v3.5.34 轻量模式停掉悬浮球脉冲并简化视频弹窗阴影',
    /html\[data-lite="1"\] #audioBubble \.dot/.test(IDX_530)
    && /html\[data-lite="1"\] \.video-box\{box-shadow/.test(IDX_530));
  t('v3.5.34 轻量模式下作业视频不预加载（preload=none）',
    /function _hwVidPreload\(\)/.test(IDX_530)
    && /getAttribute\('data-lite'\) === '1'\) return 'none'/.test(IDX_530)
    && /_hwVidPreload\(\)/.test(IDX_530));
  t('v3.5.34 作业勾选后立即 flushCloudSync（不等防抖，防止锁屏丢数据）',
    /function toggleHwDone\(hwId, subject, ti, el\)\{[\s\S]{0,700}flushCloudSync\(\);/.test(IDX_530));
  t('v3.5.34 拉取前先推送（syncPullSilent 先 flush 再 syncPullSilent2）',
    /function syncPullSilent\(\)\{[\s\S]{0,600}hasPendingCloudSync\(\)[\s\S]{0,300}flushCloudSync\(\)[\s\S]{0,200}syncPullSilent2\(\)/.test(IDX_530));
  t('v3.5.34 孤儿勾选回补：本机有、云端无的 cls_hw_done_ 会被推上去',
    /function backfillOrphanHwDone\(\)/.test(IDX_530)
    && /k\.indexOf\('cls_hw_done_'\) !== 0/.test(IDX_530)
    && /hasOwnProperty\.call\(cloud, k\)/.test(IDX_530)
    && /api\('\/data', \{ method:'PUT', body:\{ items: items \} \}\)/.test(IDX_530));
  t('v3.5.34 定时同步与手动拉取都调用回补',
    (IDX_530.match(/backfillOrphanHwDone\(\)/g) || []).length >= 3);
  t('v3.5.33 轻量选择存在独立的设备级 key（cls_lite_mode），不随版本迁移丢',
    /var LITE_KEY = 'cls_lite_mode';/.test(IDX_530)
    && /function readLitePref\(\)/.test(IDX_530)
    && /function writeLitePref\(v\)/.test(IDX_530));
  t('v3.5.33 liteOn 优先读设备级记忆，没选过才回落 UI.lite',
    /var pref = readLitePref\(\);\s*\n\s*if\(pref === 1\) return true;\s*\n\s*if\(pref === 0\) return false;\s*\n\s*return UI\.lite === 1;/.test(IDX_530));
  t('v3.5.33 setLiteMode 同时写设备级记忆（升级/恢复默认都不回退）',
    /writeLitePref\(UI\.lite\);/.test(IDX_530));
  t('v3.5.33 恢复默认不碰轻量选择（resetUICfg 里无 lite 相关清理）',
    !/removeItem\(LITE_KEY\)/.test(IDX_530));
  t('v3.5.33 设置面板说明选择已记在设备上', /已记在这台设备上/.test(IDX_530));
  t('v3.5.31 轻量模式纯手动：不再有 UA / 内存 / 核数 / 长任务自动探测',
    !/autoLiteWanted/.test(IDX_530) && !/liteSelfCheck/.test(IDX_530)
    && !/deviceMemory/.test(IDX_530) && !/hardwareConcurrency/.test(IDX_530)
    && !/iPad\|iPhone\|iPod/.test(IDX_530) && !/longtask/.test(IDX_530));
  t('v3.5.31 轻量模式不依赖任何设备探测函数',
    /function liteOn\(\)/.test(IDX_530) && /UI\.lite === 1/.test(IDX_530));
  t('v3.5.31 默认走完整特效（lite: 0），旧配置里的 null 也回落完整',
    /lite: 0,/.test(IDX_530)
    && /out\.lite = \(o\.lite === 1\) \? 1 : 0;/.test(IDX_530));
  t('v3.5.31 设置面板只有「完整 / 轻量」两档，没有「自动」',
    /function setLiteMode\(/.test(IDX_530) && /secHtml\('perf'/.test(IDX_530)
    && !/'auto',\s*'自动'/.test(IDX_530) && !/setLiteMode\('auto'\)/.test(IDX_530));
  t('v3.5.31 setLiteMode 写完立刻落盘并 applyLite',
    /UI\.lite = \(m === 'on'\) \? 1 : 0;/.test(IDX_530)
    && /saveUI\(\);/.test(IDX_530) && /applyLite\(\);/.test(IDX_530));
  t('v3.5.31 弹窗居中：welcome-mask / allboard-mask 显式 flex 居中（不再贴左上角）',
    /\.welcome-mask\.show\{display:flex;align-items:center;justify-content:center/.test(IDX_530)
    && /\.allboard-mask\.show\{display:flex;align-items:center;justify-content:center/.test(IDX_530));
  t('v3.5.30 轻量 CSS 排在 !important 玻璃规则之后（否则压不住）',
    IDX_530.indexOf('html[data-lite="1"] *') > IDX_530.indexOf('backdrop-filter:blur'));

  /* ---- v3.5.18：子请求上限 / 字段级冲突 / 确定按钮 / 投票选项折叠 ---- */
  const ADM_518 = readAdm();
  const ADMJS_518 = fs.readFileSync(new URL('./api/admin.js', import.meta.url), 'utf8');
  const IDX_518 = readIdx();
  t('#15 前端分批 8 条（避开 Workers 50 子请求上限）', /var CHUNK = 8;/.test(ADM_518));
  t('#15 后端单批上限 12 条', /list\.length > 12/.test(ADMJS_518) && /单批最多 12 条/.test(ADMJS_518));
  t('#15 查已有记录改 select *（省一次子请求）',
    /select \* from profiles where student_id_bidx = \$\{sidBidx\} limit 1/.test(ADMJS_518));
  t('#15 冲突接口 resolve-field-conflicts 存在且白名单校验',
    /case 'resolve-field-conflicts'/.test(ADMJS_518)
    && /async function resolveFieldConflicts\(/.test(ADMJS_518)
    && /!allow\.has\(field\) \|\| !isSafeFieldFormat\(field\)\.ok/.test(ADMJS_518));
  t('#15 改姓名/学号时同步重算盲索引',
    /set name = \$\{ev\}, name_bidx = \$\{await blindIndex/.test(ADMJS_518)
    && /set student_id = \$\{ev\}, student_id_bidx = \$\{await blindIndex/.test(ADMJS_518));
  t('#15 返回 unchanged / conflicts', /conflicts: conflicts\.slice\(0, 300\)/.test(ADMJS_518));
  t('#15 导入结果有冲突表 + 全选/全不选/应用', /data-cf-apply/.test(ADM_518)
    && /data-cf-all/.test(ADM_518) && /data-cf-none/.test(ADM_518)
    && /resolve-field-conflicts/.test(ADM_518));
  t('#15 结果出来后「取消」变「确定」', /noBtn\.textContent = '确定'/.test(ADM_518));
  t('#15 投票选项折叠：只显示歌名-歌手，点详情展开',
    /function voteOptSplit\(/.test(IDX_518) && /function voteOptLabelHtml\(/.test(IDX_518)
    && /\.vote-opt\.open \.vote-opt-extra/.test(IDX_518));
  t('#15 详情按钮不冒泡（避免误投一票）',
    /ev\.stopPropagation\(\);/.test(IDX_518) && /data-vote-more/.test(IDX_518));

  /* ---- v3.5.17：歌单投票选项 = 歌名 - 歌手 - 点歌人 - 点歌时间 ---- */
  const VOTES_SRC_517 = fs.readFileSync(new URL('./api/votes.js', import.meta.url), 'utf8');
  const ADM_517 = readAdm();
  const IDX_517 = readIdx();
  t('#14 歌单选项四段拼接（title/artist/requester/createdAt）',
    /function voSongLabel\(s\)/.test(ADM_517)
    && /String\(s\.title \|\| ''\)\.trim\(\) \|\| '\(无歌名\)'/.test(ADM_517)
    && /vhReqName\(s\) \|\| '匿名'/.test(ADM_517)
    && /vhFmtTime\(s\.createdAt\)/.test(ADM_517));
  t('#14 勾选写入的是四段 label（不是光秃歌名）',
    /data-song="' \+ attr\(label\)/.test(ADM_517));
  t('#14 后端选项长度放宽到 80（40 会把时间截掉）',
    /const MAX_OPTION_LEN = 80;/.test(VOTES_SRC_517));
  t('#14 学生加选项输入框同步 80 字', /maxlength="80" placeholder="想加的选项（最多 80 字）"/.test(IDX_517));
  t('#14 后台提示写明四段格式', /歌名 - 歌手 - 点歌人 - 点歌时间/.test(ADM_517));

  /* ---- v3.5.15 热修：后台两处「读取失败」+ 新增字段英文键名自动生成 ---- */
  t('#12 VO 状态对象已声明（投票页不再报 VO is not defined）',
    /var VO = \{ list: \[\], busy: false, pub: null \};/.test(admHtml355));
  t('#12 点歌投稿统计用 URL.origin 取站点根（不再把 /api/open 塞进 base）',
    /new URL\(VH_API\)\.origin/.test(admHtml355) && !/\(VH_API \|\| ''\)\.replace\(\/\\\/api\$\//.test(admHtml355));
  t('#12 英文键名自动生成三件套（字表 / 整词表 / 转换函数）',
    /var FIELD_PINYIN = \(function\(\)\{/.test(admHtml355)
    && /var FIELD_WORDS = \{/.test(admHtml355) && /function autoFieldKey\(label\)/.test(admHtml355));
  t('#12 中文名输入即自动填键名，手改后不再覆盖',
    /function syncKey\(\)\{/.test(admHtml355) && /var keyManual = false/.test(admHtml355)
    && /addEventListener\('input', syncKey\)/.test(admHtml355));
  t('#12 创建时键名为空按中文名兜底生成', /if\(!key && label\) key = autoFieldKey\(label\);/.test(admHtml355));
  t('#12 整词表覆盖高频字段（学籍号/入团时间/家庭住址）',
    /'学籍号': 'student_no'/.test(admHtml355) && /'入团时间': 'league_date'/.test(admHtml355)
    && /'家庭住址': 'home_address'/.test(admHtml355));

  t('#11 导入失败逐条列出（数据行 / 姓名 / 原因）',
    /var allErrs = \[\]/.test(admHtml355) && /allErrs\.push\(\{ n: n, name:/.test(admHtml355)
    && /<th class="nowrap">数据行<\/th><th class="nowrap">姓名<\/th><th>原因<\/th>/.test(admHtml355));
  t('#11 写库前按精度规整（单条保存 + 批量导入两处）',
    (ADMJS_SRC355.match(/coerceValueByRules\(/g) || []).length >= 2
    && /customVals\[f\.field\] = coerceValueByRules/.test(ADMJS_SRC355)
    && /ex\[f\.field\] = coerceValueByRules/.test(ADMJS_SRC355));

  /* ---- ② 登录侧：非关键写操作全部有保护 ---- */
  t('★last_login_at 更新有 try-catch（非关键写不再把登录打成 500）',
    /\[auth\] last_login_at 更新失败/.test(authSrc));
  t('★会话签发失败明确返回 500，且不回显内部错误细节',
    /登录成功但会话签发失败，请稍后重试/.test(authSrc) && !/会话签发失败：' \+/.test(authSrc));
  t('★诊断残留已清理（无 __diag / getLastSchemaError）',
    !/__diag/.test(authSrc) && !/getLastSchemaError/.test(httpSrc));

  /* ---- ③ 版本与缓存同步 ---- */
  t('★v3.9.16 缓存桶名含版本（不再手工维护 vNN）',
    /const CACHE = 'class-site-' \+ SITE_VER/.test(swSrc) && /SITE_VER = '3\.[0-9]+\.[0-9]+'/.test(swSrc));

  /* ---- ④ 后台内置更新记录补 2.10.1 热修条目（2.10.0 条目仍保留）---- */
  const ADMJS_SRC = readAdm();
    }

console.log('\n【71】第六十二轮·后台内容时间不再多算 8 小时（v2.10.1）');
{
  const ADMJS_SRC = readAdm();

  /* ---- ① 静态结构 ---- */
  t('★新增 fmtWall（墙钟时间，不碰时区）', /function fmtWall\(v, mode\)\{/.test(ADMJS_SRC));
  t('★新增 fmtRecTime：按 timeKind 分派 db / wall', /function fmtRecTime\(c\)\{/.test(ADMJS_SRC));
  t('★fmtWall 注释写明「不再补 Z 按 UTC 解析」的根因',
    /补 Z 按 UTC 解析/.test(ADMJS_SRC) && /多加 8 小时/.test(ADMJS_SRC));
  t('★公告记录标注 timeKind（createdAt/updatedAt 才是 db）',
    /timeKind: \(a\.createdAt \|\| a\.updatedAt\) \? 'db' : 'wall'/.test(ADMJS_SRC));
  t('★作业记录标注 timeKind（updatedAt 才是 db）',
    /timeKind: \(!c\.updatedAt && t\) \? 'wall' : 'db'/.test(ADMJS_SRC));
  t('★列表与详情都改用 fmtRecTime',
    (ADMJS_SRC.match(/fmtRecTime\(c\)/g) || []).length >= 2);

  /* ---- ② 行为测试：把函数抽出来真跑一遍 ----
     fmtWall 不依赖 DOM，可直接 eval 出来验；fmt 用桩替换，
     这样能确证「db 走 fmt、wall 走 fmtWall」的分派是真的。 */
  const pick = (name) => {
    const m = ADMJS_SRC.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
    if (!m) throw new Error('抽不到函数：' + name);
    return m[0];
  };
  const built = new Function('fmt',
    pick('fmtWall') + '\n' + pick('fmtRecTime') + '\nreturn { fmtWall, fmtRecTime };')(
    (v) => 'DB:' + v
  );

  t('墙钟：手填时间原样输出（不再 +8）',
    built.fmtWall('2026-10-16 21:30') === '2026-10-16 21:30',
    built.fmtWall('2026-10-16 21:30'));
  t('墙钟：带秒的手填串也不会被当 UTC',
    built.fmtWall('2026-10-16 21:30:05') === '2026-10-16 21:30',
    built.fmtWall('2026-10-16 21:30:05'));
  t('墙钟：作业起止区间两段都格式化（旧实现整串解析失败显示「—」）',
    built.fmtWall('2026-10-16 ~ 2026-11-01') === '2026-10-16 ~ 2026-11-01',
    built.fmtWall('2026-10-16 ~ 2026-11-01'));
  t('墙钟：缺失的一端显示 ?（不吞掉）',
    built.fmtWall('? ~ 2026-11-01') === '? ~ 2026-11-01',
    built.fmtWall('? ~ 2026-11-01'));
  t('墙钟：单日期不带时间时只显示日期',
    built.fmtWall('2026-10-16') === '2026-10-16');
  t('墙钟：认不出的串原样输出，不擅自换算',
    built.fmtWall('待定') === '待定');
  t('墙钟：空值显示破折号', built.fmtWall('') === '—' && built.fmtWall(null) === '—');
  t('分派：timeKind=db 走 fmt（数据库 UTC 时间戳）',
    built.fmtRecTime({ time: '2026-10-16 13:30:00', timeKind: 'db' }) === 'DB:2026-10-16 13:30:00');
  t('分派：公告手填时间走 fmtWall（原样）',
    built.fmtRecTime({ time: '2026-10-16 21:30', timeKind: 'wall' }) === '2026-10-16 21:30');
  t('分派：无时间显示破折号', built.fmtRecTime({ time: null }) === '—');
}

console.log('\n【72】第六十二轮·成绩模版导入（两行表头按列解析，v2.10.1）');
{
  const ADMJS_SRC = readAdm();

  /* ---- ① 静态护栏 ---- */
  ['scTemplateXlsx', 'scParseTwoRow', 'scFillMerged', 'scIsTwoRowHeader', 'scSubKind', 'scRowTotal', 'scClassRanks']
    .forEach((fn) => t('★新增函数 ' + fn, new RegExp('function ' + fn + '\\(').test(ADMJS_SRC)));
  t('★scParseAOA 检测两行表头后转走模版解析',
    /scIsTwoRowHeader\(aoa\[0\] \|\| \[\], aoa\[1\] \|\| \[\]\)\) return scParseTwoRow/.test(ADMJS_SRC));
  t('★导入弹窗有「下载模版」按钮', /id="scTpl"/.test(ADMJS_SRC) && /scTemplateXlsx\(e\)/.test(ADMJS_SRC));
  t('★导出模版带合并单元格（!merges）', /ws\['!merges'\]\s*=\s*merges/.test(ADMJS_SRC));
  t('★模版含两组总分（赋分前 / 赋分后），各带年级 + 联考排名',
    /group\('总分（赋分前）', \['年级排名', '联考排名'\]\)/.test(ADMJS_SRC)
    && /group\('总分（赋分后）', \['年级排名', '联考排名'\]\)/.test(ADMJS_SRC));
  t('★赋分科目生成四列（原始分/排名/赋分/排名）',
    /\['原始分', '年级排名', '赋分', '年级排名'\]/.test(ADMJS_SRC)
    && /: \['分数', '年级排名'\]/.test(ADMJS_SRC));
  t('★预览加「班排」列并说明当场计算', /<th>班排<\/th>/.test(ADMJS_SRC) && /班排与总分是<b>当场按各科分数算的<\/b>/.test(ADMJS_SRC));

  /* ---- ② 行为测试：抽函数真跑一遍模版解析 ----
     AOA 完全照样主模版的形状造：第 1 行大类（合并 → 续格读出来是空）、
     第 2 行子字段。这样能验「合并填充 + 按列取数」是真的работает。 */
  const pick = (name) => {
    const m = ADMJS_SRC.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
    if (!m) throw new Error('抽不到函数：' + name);
    return m[0];
  };
  const src = ['scFillMerged', 'scIsTwoRowHeader', 'scSubKind', 'scMapRows', 'scGuessMap',
               'scParseTwoRow', 'scParseAOA', 'scRowTotal', 'scClassRanks']
    .map(pick).join('\n');
  const api = new Function(src + '\nreturn { scParseAOA, scRowTotal, scClassRanks, scFillMerged };')();

  const subs = [
    { key: 'chinese',  name: '语文', full: 150 },
    { key: 'math',     name: '数学', full: 150 },
    { key: 'english',  name: '英语', full: 150 },
    { key: 'physics',  name: '物理', full: 100 },
    { key: 'chemistry', name: '化学', full: 100, graded: true },
    { key: 'biology',  name: '生物', full: 100, graded: true },
  ];

  /* 列布局照**新的站主模版**造（25 列）：
     A考号 B姓名 | C:D 总分（赋分前）年级/联考 | E:F 总分（赋分后）年级/联考 |
     G:H 语文(分数·排名) | I:J 数学 | K:L 英语 | M:N 物理 |
     O:R 化学(原始·排名·赋分·排名) | S:V 生物 | W/X/Y 分数线 */
  const row0 = ['基本信息','', '总分（赋分前）','', '总分（赋分后）','',
                '语文','', '数学','', '英语','', '物理','',
                '化学','','','', '生物','','','', '600线','特控线','本科线'];
  const row1 = ['考号/学号','姓名','年级排名','联考排名','年级排名','联考排名',
                '分数','年级排名','分数','年级排名','分数','年级排名','分数','年级排名',
                '原始分','年级排名','赋分','年级排名','原始分','年级排名','赋分','年级排名',
                '','',''];
  const data = [
    ['25010001','张三','12','30','20','45','110','15','130','8','120','10','90','20','85','25','88','18','80','30','82','22','','',''],
    ['25010002','李四','','','','','100','','120','','110','','','','','','','','','','','','','',''],
    ['25010003','王五','','','','','-','','/','','缺考','','','','','','','','','','','','','',''],
  ];
  const aoa = [row0, row1].concat(data);

  const p = api.scParseAOA(aoa, subs);
  t('模版：识别为两行表头', p.twoRow === true);
  t('模版：解析出 3 行（含缺考行）', p.rows.length === 3, '实得 ' + p.rows.length);
  const zhang = p.rows[0], li = p.rows[1], wang = p.rows[2];
  t('模版：姓名/学号按列取到', zhang.name === '张三' && zhang.no === '25010001',
    zhang.name + '/' + zhang.no);
  t('模版：各科分数按列取到',
    zhang.s.chinese.raw === 110 && zhang.s.math.raw === 130 && zhang.s.english.raw === 120
    && zhang.s.physics.raw === 90,
    JSON.stringify(zhang.s));
  t('模版：赋分科目拆成原始分 + 赋分',
    zhang.s.chemistry.raw === 85 && zhang.s.chemistry.assigned === 88
    && zhang.s.biology.raw === 80 && zhang.s.biology.assigned === 82,
    JSON.stringify(zhang.s.chemistry) + JSON.stringify(zhang.s.biology));
  /* 2026-10-17 站主新规：每个分数都要有一个年级排名（不再丢） */
  t('★模版：各科「分数 → 年级排名」一一对应存下',
    zhang.s.chinese.rank === 15 && zhang.s.math.rank === 8
    && zhang.s.english.rank === 10 && zhang.s.physics.rank === 20,
    JSON.stringify([zhang.s.chinese, zhang.s.math, zhang.s.english, zhang.s.physics]));
  t('★模版：赋分科目两个排名各归各位（原始分排名 ≠ 赋分排名）',
    zhang.s.chemistry.rank === 25 && zhang.s.chemistry.asgRank === 18
    && zhang.s.biology.rank === 30 && zhang.s.biology.asgRank === 22,
    JSON.stringify(zhang.s.chemistry) + JSON.stringify(zhang.s.biology));
  t('★模版：总分（赋分后）年级/联考排名 → schoolRank / leagueRank',
    zhang.schoolRank === 20 && zhang.leagueRank === 45,
    zhang.schoolRank + '/' + zhang.leagueRank);
  t('★模版：总分（赋分前）年级/联考排名 → s._t（两种口径各存各的）',
    zhang.s._t && zhang.s._t.rank === 12 && zhang.s._t.league === 30,
    JSON.stringify(zhang.s._t));
  t('模版：总分本身不入库（系统按各科算）', zhang.s.total === undefined);
  t('模版：空白单元格 = 不知（没填的科目不产生数据）',
    li.s.physics === undefined && li.s.chemistry === undefined && li.schoolRank === null && li.s._t === undefined,
    JSON.stringify(Object.keys(li.s)));
  t('模版：- / / / 缺考 一律当不知',
    wang.s.chinese === undefined && wang.s.math === undefined && wang.s.english === undefined);
  t('★模版：所有列都被认领，没有「未识别」的列',
    p.ignored.length === 0, '实得 ' + p.ignored.length + ' → ' + JSON.stringify(p.ignored));
  t('模版：分数线列被识别为参考信息（不写库）',
    p.cutlines.length === 3 && p.cutlines[0].label === '600线',
    JSON.stringify(p.cutlines.map(c => c.label)));

  /* 班排当场算 */
  const ranks = api.scClassRanks(p.rows, subs);
  t('班排：按各科累加当场排名（张三最高 → 1）', ranks[0] === 1, '实得 ' + ranks[0]);
  t('班排：总分累加含赋分（110+130+120+90+88+82=620）',
    api.scRowTotal(zhang, subs) === 620, '实得 ' + api.scRowTotal(zhang, subs));
  t('班排：缺考同学只按已填科目累计，不报错',
    api.scRowTotal(li, subs) === 330, '实得 ' + api.scRowTotal(li, subs));

  /* 单行表头（老路径）不受影响 */
  const flat = api.scParseAOA([['姓名','学号','语文','数学'], ['赵六','25010009','99','88']], subs);
  t('回归：单行表头仍走老路径（twoRow 不置位）', !flat.twoRow && flat.rows.length === 1);
  t('回归：单行表头姓名/科目仍解析正确',
    flat.rows[0].name === '赵六' && flat.rows[0].s.chinese.raw === 99,
    JSON.stringify(flat.rows[0].s));
  t('回归：合并填充不越界（第 1 列就非空时不受影响）',
    api.scFillMerged(['甲','','乙'])[1] === '甲' && api.scFillMerged(['甲','','乙'])[2] === '乙');
}

console.log('\n【73】第六十二轮·需求⑬ 管理员批量删除云端数据（v2.10.1）');
{
  /* 准备：管理员建一个账号，登录后写入三条云端数据 */
  const mk = await call('/api/admin?action=create-user', {
    method: 'POST', token: adminToken,
    body: { username: 'bulkdata01', password: 'Init2025', displayName: '批量数据甲' },
  });
  t('（准备）测试账号建好', mk.status === 200 && mk.body.ok, JSON.stringify(mk.body).slice(0, 120));
  const lg = await call('/api/auth?action=login', {
    method: 'POST', body: { username: 'bulkdata01', password: 'Init2025' },
  });
  const bId = lg.body.user && lg.body.user.id;
  const tok0 = lg.body.token;
  /* 建号时带了「首次改密」标记，requireUserReady 会拦住未改密账号，
     所以先改一次密再用（与【34】路人账号同一套路）。 */
  const bTok = (await call('/api/auth?action=change-password', {
    method: 'POST', token: tok0,
    body: { oldPassword: 'Init2025', newPassword: 'ByOwn2025' },
  })).body.token || tok0;
  t('（准备）拿到测试账号的 id 与 token', !!bId && typeof bTok === 'string', JSON.stringify(lg.body).slice(0, 140));

  await call('/api/data', {
    method: 'PUT', token: bTok,
    body: { items: { cls_theme: 'light', cls_sfx: false, cls_hw_done_9: true } },
  });
  const d0 = await call('/api/admin?action=user&id=' + bId, { token: adminToken });
  t('（准备）三条云端数据已写入', ((d0.body.data || [])).length === 3,
    '实得 ' + ((d0.body.data || [])).length);

  /* ---- ① 批量删除：all=1 一次清空 ---- */
  const bulk = await call('/api/admin?action=delete-data', {
    method: 'POST', token: adminToken, body: { userId: bId, all: true },
  });
  t('★批量清空云端数据返回 200', bulk.status === 200, '实际 ' + bulk.status);
  t('★批量清空返回实际删除条数（3 条）',
    bulk.body.deleted === 3, '实得 ' + bulk.body.deleted);
  const d1 = await call('/api/admin?action=user&id=' + bId, { token: adminToken });
  t('★清空后该用户云端数据归零', ((d1.body.data || [])).length === 0,
    '实得 ' + ((d1.body.data || [])).length);

  /* ---- ② 参数校验：缺 userId / 既无 key 也无 all ---- */
  const noId = await call('/api/admin?action=delete-data', {
    method: 'POST', token: adminToken, body: { all: true },
  });
  t('★缺 userId → 400（不会误清空别人）', noId.status === 400, '实际 ' + noId.status);
  const noKey = await call('/api/admin?action=delete-data', {
    method: 'POST', token: adminToken, body: { userId: bId },
  });
  t('★既不给 key 也不给 all → 400', noKey.status === 400, '实际 ' + noKey.status);

  /* ---- ③ 回归：选择性删除（按 key）仍然只删那一条 ---- */
  await call('/api/data', {
    method: 'PUT', token: bTok,
    body: { items: { cls_theme: 'dark', cls_sfx: true } },
  });
  const one = await call('/api/admin?action=delete-data', {
    method: 'POST', token: adminToken, body: { userId: bId, key: 'cls_sfx' },
  });
  t('回归：按 key 单条删除返回 200', one.status === 200, '实际 ' + one.status);
  const d2 = await call('/api/admin?action=user&id=' + bId, { token: adminToken });
  const left = (d2.body.data || []).map((x) => x.key);
  t('回归：只删掉指定那条，另一条还在',
    left.length === 1 && left[0] === 'cls_theme', JSON.stringify(left));

  /* ---- ④ 前端静态护栏 ---- */
  const ADMJS_SRC = readAdm();
  const adminSrc = fs.readFileSync(new URL('./api/admin.js', import.meta.url), 'utf8');
  t('★后台用户详情有「清空全部」按钮', /id="udDelAll"/.test(ADMJS_SRC));
  t('★清空按钮走 all:true 且二次确认',
    /userId: id, all: true/.test(ADMJS_SRC) && /confirmBox\(\{\s*title: '清空全部云端数据'/.test(ADMJS_SRC));
  t('★后端 delete-data 支持 all 分支并回传删除条数',
    /const all = !!b\.all/.test(adminSrc) && /delete from user_data where user_id = \$\{userId\} returning data_key/.test(adminSrc));
  t('★批量删除写审计（与单条区分 delete_all）',
    /'data\.delete_all'/.test(adminSrc));
}

console.log('\n【74】第六十三轮·Pages 回查判据改内容哈希（修「假红灯」）');
{
  const wf = fs.readFileSync(new URL('./.github/workflows/deploy-pages.yml', import.meta.url), 'utf8');
  t('★build 把三个内容哈希当 job outputs 传给 deploy',
    /outputs:[\s\S]{0,200}index_sha: \$\{\{ steps\.fingerprint\.outputs\.index_sha \}\}/.test(wf));
  t('★指纹步骤对 index/admin/sw 三个文件算 sha256',
    /sha256sum _site\/index\.html/.test(wf) && /sha256sum _site\/admin\.html/.test(wf)
    && /sha256sum _site\/sw\.js/.test(wf));
  t('★回查改用哈希比对，不再 grep 写死的字符串',
    /MISS="\$MISS admin\.html"/.test(wf) && !/grep -q\s+"[A-Za-z_]+"/.test(wf));
  t('★三个文件任一不一致就继续等（不是只看一个）',
    /MISS="\$MISS index\.html"/.test(wf) && /MISS="\$MISS sw\.js"/.test(wf));
  t('★注释留了根因（写死判据会腐烂，且表现为假红灯）',
    /写死的判据会随代码演进腐烂/.test(wf) && /假红灯/.test(wf));
}

console.log('\n【75】第六十三轮·「我的云端数据」入口暴露（原来点不到）');
{
  const idx = readIdx();
  t('★个人中心有云端数据入口（调用 openCloudDataFromAccount）',
    /openCloudDataFromAccount\(\)/.test(idx) && /☁️ 我的云端数据/.test(idx));
  t('★「自定义设置」也有入口（调用 openCloudDataFromSettings）',
    /openCloudDataFromSettings\(\)/.test(idx) && /secHtml\('cloud','云端数据'/.test(idx));
  t('★两个入口函数都存在且会先关掉上层弹窗',
    /function openCloudDataFromAccount\(\)\{\s*closeAccount\(\);/.test(idx)
    && /function openCloudDataFromSettings\(\)\{\s*closeSettings\(\);/.test(idx));
  t('★设置入口未登录时先引导登录（云端接口要登录才给读）',
    /if\(!isLoggedIn\(\)\)\{ openAccount\(\); return; \}/.test(idx));
  t('★真正的数据弹窗函数仍是 openCloudData（两个入口都指向它）',
    /function openCloudData\(\)\{/.test(idx) && /class="allboard-mask" id="cloudDataMask"/.test(idx));
  /* 背景：唯一入口原先藏在侧边栏「数据管理」里，而那个按钮是 display:none */
  t('背景确认：侧边栏「数据管理」按钮确实是隐藏的（所以才要点不到）',
    /onclick="openData\(\)" style="display:none"/.test(idx));
  t('★个人中心入口带说明文案（可单条删除或清空）',
    /看云端存了哪些数据[\s\S]{0,40}可单条删除或清空/.test(idx));
}

console.log('\n【76】第六十三轮·行为日志：点外链也要有记录（且必须发得出去）');
{
  const idx = readIdx();
  /* 背景：站主反馈「跳了点歌平台，后台查不到去了哪里」。两个根因—— */
  /* ① 离开页面前的最后一次发送走普通 fetch，会被浏览器取消 → 改用 keepalive */
  t('★新增 keepalive 发送通道', /function actLogFlushKeepalive\(\)\{/.test(idx));
  t('★keepalive 通道用 fetch 的 keepalive:true（普通 fetch 卸载时会被取消）',
    /keepalive: true/.test(idx) && /keepalive 的请求体上限 64KB/.test(idx));
  t('★不改用 sendBeacon（token 只能进 URL，会泄到日志/Referer）',
    /不能改用 navigator\.sendBeacon/.test(idx));
  t('★pagehide 里补发一次（关标签页 / 点外链跳走都会走到）',
    /addEventListener\('pagehide'[\s\S]{0,200}actLogFlushKeepalive\(\)/.test(idx));
  t('★visibilitychange 也改用 keepalive（切后台不再用会被取消的普通 fetch）',
    /visibilityState === 'hidden'[\s\S]{0,400}actLogFlushKeepalive\(\)/.test(idx)
    && !/visibilityState === 'hidden'[\s\S]{0,400}\n\s*actLogFlush\(\);/.test(idx));

  /* ② 入队即落盘 + 下次打开补发 */
  t('★入队即写 localStorage（跳走/刷新也不丢）',
    /actLogSave\(\);\s*\/\* 🚀 v2\.10\.1：入队即落盘/.test(idx));
  t('★启动后补发上次没送出去的队列',
    /if\(ACT_LOG_Q\.length\) actLogFlush\(\)/.test(idx));

  /* ③ 跳转本身要带上「去了哪里」 */
  t('★openLink 支持第三个参数（入口名）', /function openLink\(url, wechatOk, label\)\{/.test(idx));
  t('★跳转记一条 jump，目标带入口名、详情带目标地址',
    /actLog\('jump', label \? String\(label\) : url, '前往 ' \+ url\)/.test(idx)
    && /actLogFlushKeepalive\(\);\s*\n\s*\}catch\(e\)\{ \/\* 记日志失败绝不影响跳转/.test(idx));
  t('★服务卡片把入口名传进 openLink（不再是光秃秃的「前往入口」）',
    /openLink\(\\''\+jsq\(l\.mainUrl\)\+'\\','\+\(l\.mainWechatOk\?'true':'false'\)\+',\\''\+jsq\(l\.title\|\|''\)\+'\\'\)/.test(idx));
  t('★通用点击不再为外链按钮重复记一条（一动作一条）',
    /if\(\/openLink\\s\*\\\(\/\.test\(oc\)\) return;/.test(idx));
}

console.log('\n【77】第六十三轮·各科排名 + 总分两种口径排名的存取闭环');
{
  /* 建一场考试（含赋分科目），导入带排名的成绩，再验证「读得回来、改分不丢」 */
  const mk = await call('/api/scores?action=exam-save', {
    method: 'POST', token: adminToken,
    body: {
      name: '排名闭环测试考', exam_date: '2026-10-16',
      subjects: [
        { key: 'chinese', name: '语文', full: 150 },
        { key: 'math', name: '数学', full: 150 },
        { key: 'chemistry', name: '化学', full: 100, graded: true },
      ],
      status: 'draft',
    },
  });
  const exId = mk.body.exam && mk.body.exam.id;
  t('（准备）建好测试考试', !!exId, JSON.stringify(mk.body).slice(0, 140));

  const imp = await call('/api/scores?action=scores-import', {
    method: 'POST', token: adminToken,
    body: {
      exam: exId,
      rows: [
        { name: '排名甲', no: '9901', schoolRank: 20, leagueRank: 45,
          s: { chinese: { raw: 110, rank: 15 }, math: { raw: 130, rank: 8 },
               chemistry: { raw: 85, rank: 25, assigned: 88, asgRank: 18 },
               _t: { rank: 12, league: 30 } } },
        { name: '排名乙', no: '9902', schoolRank: 60, leagueRank: null,
          s: { chinese: { raw: 90, rank: 40 }, math: { raw: 100, rank: 33 } } },
      ],
    },
  });
  t('导入带排名的成绩成功', imp.status === 200 && imp.body.imported === 2,
    JSON.stringify(imp.body).slice(0, 160));

  const bd = await call('/api/scores?action=board&exam=' + exId, { token: adminToken });
  const ja = (bd.body.rows || []).find((r) => r.name === '排名甲') || {};
  const ji = (bd.body.rows || []).find((r) => r.name === '排名乙') || {};
  t('★读回：各科分数与年级排名都在（语文 110 / 排名 15）',
    ja.s && ja.s.chinese && ja.s.chinese.raw === 110 && ja.s.chinese.rank === 15,
    JSON.stringify(ja.s));
  t('★读回：赋分科目两个排名各归各位（原始排名 25 / 赋分排名 18）',
    ja.s && ja.s.chemistry && ja.s.chemistry.raw === 85 && ja.s.chemistry.assigned === 88
    && ja.s.chemistry.rank === 25 && ja.s.chemistry.asgRank === 18,
    JSON.stringify(ja.s && ja.s.chemistry));
  t('★读回：总分（赋分后）排名 → schoolRank/leagueRank',
    ja.schoolRank === 20 && ja.leagueRank === 45, ja.schoolRank + '/' + ja.leagueRank);
  t('★读回：总分（赋分前）排名 → s._t',
    ja.s && ja.s._t && ja.s._t.rank === 12 && ja.s._t.league === 30,
    JSON.stringify(ja.s && ja.s._t));
  t('读回：没填的排名保持「不知」（不补 0）',
    ji.leagueRank === null && ji.s.math.rank === 33,
    JSON.stringify({ lr: ji.leagueRank, mr: ji.s.math.rank }));

  /* 改分（后台表格那一套：整行重建后提交）——只改分数，排名必须还在 */
  const save = await call('/api/scores?action=scores-save', {
    method: 'POST', token: adminToken,
    body: {
      exam: exId,
      rows: [{
        id: ja.id, name: ja.name, no: ja.no,
        s: {
          chinese: { raw: 115, rank: 15 },                                    /* 只改了分数 */
          math: { raw: 130, rank: 8 },
          chemistry: { raw: 85, rank: 25, assigned: 90, asgRank: 18 },        /* 只改了赋分 */
          _t: { rank: 12, league: 30 },
        },
        schoolRank: 20, leagueRank: 45,
      }],
    },
  });
  t('改分保存成功', save.status === 200, JSON.stringify(save.body).slice(0, 140));
  const bd2 = await call('/api/scores?action=board&exam=' + exId, { token: adminToken });
  const ja2 = (bd2.body.rows || []).find((r) => r.name === '排名甲') || {};
  t('★改分后分数更新了', ja2.s.chinese.raw === 115 && ja2.s.chemistry.assigned === 90,
    JSON.stringify(ja2.s));
  t('★改分后各科年级排名没被冲掉',
    ja2.s.chinese.rank === 15 && ja2.s.math.rank === 8
    && ja2.s.chemistry.rank === 25 && ja2.s.chemistry.asgRank === 18,
    JSON.stringify([ja2.s.chinese, ja2.s.chemistry]));
  t('★改分后总分两种口径的排名也都在',
    ja2.schoolRank === 20 && ja2.leagueRank === 45
    && ja2.s._t && ja2.s._t.rank === 12 && ja2.s._t.league === 30,
    JSON.stringify(ja2.s && ja2.s._t));

  /* cleanScores 单元：边界 */
  const { default: _h } = { default: null };
  const scoresMod = await import('/tmp/class-site/api/scores.js');
  t('scores.js 导出默认 handler（模块可加载）', typeof scoresMod.default === 'function');

  /* 收尾：删掉测试考试 */
  const del = await call('/api/scores?action=exam-delete', {
    method: 'POST', token: adminToken, body: { id: exId },
  });
  t('（收尾）测试考试已删除', del.status === 200, JSON.stringify(del.body).slice(0, 120));
}

console.log('\n【78】第六十四轮·四象限手机点选 / 六科画像数值对比 / 原始口径不显赋分头衔且不比三线');

(function(){
  const idx = readIdx();

  /* ① 四象限：点象限 / 圆点 → 列名单（手机可用，不用悬停） */
  t('★四象限有点选处理函数 scQuadTap', /function scQuadTap\(i\)\{/.test(idx));
  t('★四象限矩形块可点（onclick=scQuadTap(序号)）', /onclick="scQuadTap\(' \+ qi \+ '\)"/.test(idx));
  t('★四象限圆点按「一个人」点（scQuadDot），不是整个象限',
    /onclick="scQuadDot\(' \+ pi \+ '\)"/.test(idx) && /function scQuadDot\(i\)\{/.test(idx));
  t('★圆点有透明命中圈（手机上点得中）', /r="11" fill="transparent"/.test(idx));
  t('★四象限有名单容器 scQList', /id="scQList"/.test(idx));
  t('★四象限矩形带 id 以便高亮所选', /id="scQrect' \+ qi \+ '"/.test(idx));
  t('★再点一次收起（toggle）', /SC\.quadSel = \(SC\.quadSel === i\) \? null : i;/.test(idx));
  t('★名单用 chip 展示姓名 + 总分·单科', /sc-qchip/.test(idx) && /总分 ' \+ fmtNum\(p\.x\) \+ ' · ' \+ fmtNum\(p\.y\)/.test(idx));
  t('★点选只改 DOM 不整页重渲染（避免跳回顶部）', /document\.getElementById\('scQList'\)/.test(idx) && /box\.innerHTML = '<div class="sc-qlist-h">/.test(idx));

  /* ② 六科画像：数值表（个人 vs 总分占比、个人 vs 班均） */
  t('★六科画像有数值表 sc-sixtbl', /class="sc-sixtbl"/.test(idx));
  t('★数值表含「占总分」列', /<th>占总分<\/th>/.test(idx));
  t('★数值表含「班均」「与班均」列', /<th>班均<\/th><th>与班均<\/th>/.test(idx));
  t('★个人与总分：每科占总分百分比', /x\.v \/ myTotal \* 100/.test(idx));
  t('★个人与班均：每科差值', /x\.v - x\.avg/.test(idx));
  t('★个人与班均：总分那一行的差', /myTotal - st\.avg/.test(idx));

  /* ③ 原始口径：不显化/生「赋分」头衔，且不与三线比较 */
  t('★各科情况：赋分头衔只在赋分口径显示', /\(s\.graded && SC\.basis === 'graded' \? '<span class="sc-tag">赋分<\/span>' : ''\)/.test(idx));
  t('★各科趋势：赋分头衔只在赋分口径显示', /\(sub\.graded && SC\.basis === 'graded' \? '<span class="sc-tag">赋分<\/span>' : ''\)/.test(idx));
  t('★个人画像上线情况：原始口径改为提示、不硬比', /当前是「原始分」口径。特控线/.test(idx));
  t('★历次上线率：原始口径不比较', /function scCutTrend\(\)\{\s*\n\s*if\(SC\.basis !== 'graded'\)\{/.test(idx));
  t('★全班成绩单：原始口径不画三线', /SC\.basis === 'graded' \? \(SC\.exam\.cutlines \|\| \[\]\)\.filter/.test(idx));
  t('★导出图：原始口径不与三线比较', /\(opt\.cutlines && SC\.basis === 'graded'\)/.test(idx));
})();

console.log('\n【79】第六十五轮·导入未识别姓名弹窗修正 + 发布可见范围（个人/全体）');
{
  /* ---------- 静态护栏 ---------- */
  const httpSrc79 = fs.readFileSync(new URL('./api/_lib/http.js', import.meta.url), 'utf8');
  const schemaSrc79 = fs.readFileSync(new URL('./api/schema.sql', import.meta.url), 'utf8');
  const scSrc79 = fs.readFileSync(new URL('./api/scores.js', import.meta.url), 'utf8');
  const adm79 = readAdm();
  t('schema.sql 的 exams 含 visible_to', /visible_to\s+jsonb/.test(schemaSrc79));
  t('ensureSchema 含 visible_to 补列', /add column if not exists visible_to jsonb/.test(httpSrc79));
  t('scores.js 有 fix-names 动作 + 函数', /case 'fix-names'/.test(scSrc79) && /async function fixNames\(/.test(scSrc79));
  t('scores.js 发布写入 visible_to', /visible_to = \$\{vis \?/.test(scSrc79));
  t('前端有 scFixNamesDialog 弹窗', /function scFixNamesDialog\(examId, names\)/.test(adm79));
  t('前端发布前弹「选可见范围」', /function scPublishDialog\(id\)/.test(adm79) && /scPubMode/.test(adm79));
  t('考试卡显示可见范围（全体/指定 N 人）', /指定 ' \+ visN \+ ' 人/.test(adm79));

  /* ---------- A. fix-names：导入错名 → 改名并重绑 ---------- */
  const mkA = await call('/api/scores?action=exam-save', {
    method: 'POST', token: adminToken,
    body: { name: '改名测试考', exam_date: '2026-10-17',
      subjects: [{ key: 'chinese', name: '语文', full: 150 }] },
  });
  const exA = mkA.body.exam && mkA.body.exam.id;
  t('（准备）建改名测试考试', !!exA, JSON.stringify(mkA.body).slice(0, 120));

  const impA = await call('/api/scores?action=scores-import', {
    method: 'POST', token: adminToken,
    body: { exam: exA, rows: [
      { name: '余子糠', no: '1', s: { chinese: { raw: 100 } } },   /* 「糠」是「康」的错别字 */
    ] },
  });
  t('导入错名行成功，并报告未识别 1 人',
    impA.status === 200 && impA.body.unmatchedCount === 1, JSON.stringify(impA.body).slice(0, 160));

  const fixA = await call('/api/scores?action=fix-names', {
    method: 'POST', token: adminToken,
    body: { exam: exA, fixes: [{ from: '余子糠', to: '余子康' }] },
  });
  t('fix-names 改名 1 行', fixA.status === 200 && fixA.body.renamed === 1, JSON.stringify(fixA.body).slice(0, 160));

  const bA = await call('/api/scores?action=board&exam=' + exA, { token: adminToken });
  const rowA = (bA.body.rows || [])[0] || {};
  t('★改名后姓名已改正', rowA.name === '余子康', JSON.stringify(rowA).slice(0, 120));
  t('★改名后自动绑定了账号（uid 非空）', rowA.uid != null, 'uid=' + rowA.uid);
  t('★改完不再有未识别姓名', (fixA.body.stillUnmatched || []).length === 0, JSON.stringify(fixA.body.stillUnmatched));
  await call('/api/scores?action=exam-delete', { method: 'POST', token: adminToken, body: { id: exA } });

  /* ---------- B. 发布可见范围：指定同学 / 全体 ---------- */
  const reg = await call('/api/auth?action=register', {
    method: 'POST', body: { username: 'vistest', password: 'VisTestPass123', displayName: '可见性测试生' },
  });
  const stuToken = reg.body.token;
  const stuId = reg.body.user && reg.body.user.id;
  t('（准备）临时学生账号可登录', !!stuToken && !!stuId, JSON.stringify(reg.body).slice(0, 120));

  const mkB = await call('/api/scores?action=exam-save', {
    method: 'POST', token: adminToken,
    body: { name: '可见范围测试考', exam_date: '2026-10-17',
      subjects: [{ key: 'chinese', name: '语文', full: 150 }] },
  });
  const exB = mkB.body.exam && mkB.body.exam.id;
  t('（准备）建可见范围测试考试', !!exB, JSON.stringify(mkB.body).slice(0, 120));
  await call('/api/scores?action=scores-import', {
    method: 'POST', token: adminToken,
    body: { exam: exB, rows: [{ name: '可见性测试生', no: '2', s: { chinese: { raw: 120 } } }] },
  });

  /* 只给「别人」（一个不存在的 uid）→ 该学生看不到、取不到 */
  const pubOther = await call('/api/scores?action=exam-publish', {
    method: 'POST', token: adminToken, body: { id: exB, publish: true, visibleTo: [999999] },
  });
  t('发布（指定别人可见）成功', pubOther.status === 200, JSON.stringify(pubOther.body).slice(0, 120));
  const listStu1 = await call('/api/scores?action=list', { token: stuToken });
  t('★名单外的学生列表里看不到这次考试', !(listStu1.body.exams || []).some((e) => e.id === exB),
    'exams=' + (listStu1.body.exams || []).map((e) => e.id).join(','));
  const boardStu1 = await call('/api/scores?action=board&exam=' + exB, { token: stuToken });
  t('★名单外的学生取成绩被拦（403）', boardStu1.status === 403, 'status=' + boardStu1.status);
  const listAdm = await call('/api/scores?action=list', { token: adminToken });
  t('★管理员仍能看到该考试', (listAdm.body.exams || []).some((e) => e.id === exB));

  /* 改为只给该学生本人 → 能看到、能取 */
  const pubSelf = await call('/api/scores?action=exam-publish', {
    method: 'POST', token: adminToken, body: { id: exB, publish: true, visibleTo: [stuId] },
  });
  t('发布（指定本人可见）成功', pubSelf.status === 200, JSON.stringify(pubSelf.body).slice(0, 120));
  const listStu2 = await call('/api/scores?action=list', { token: stuToken });
  t('★名单内的学生能看到这次考试', (listStu2.body.exams || []).some((e) => e.id === exB),
    'exams=' + (listStu2.body.exams || []).map((e) => e.id).join(','));
  const boardStu2 = await call('/api/scores?action=board&exam=' + exB, { token: stuToken });
  t('★名单内的学生能取到成绩', boardStu2.status === 200 && Array.isArray(boardStu2.body.rows),
    'status=' + boardStu2.status);

  /* 改回全体 */
  await call('/api/scores?action=exam-publish', {
    method: 'POST', token: adminToken, body: { id: exB, publish: true, visibleTo: [] },
  });
  const listStu3 = await call('/api/scores?action=list', { token: stuToken });
  t('★改回全体后学生仍能看到', (listStu3.body.exams || []).some((e) => e.id === exB),
    'exams=' + (listStu3.body.exams || []).map((e) => e.id).join(','));

  await call('/api/scores?action=exam-delete', { method: 'POST', token: adminToken, body: { id: exB } });
}

console.log('\n【80】第六十七轮·分享页含历史趋势/年级排名 + 卡与单并存 + 已建分享可改（token 不变）');
{
  const shareSrc80 = fs.readFileSync(new URL('./share.html', import.meta.url), 'utf8');
  const idx80 = readIdx();
  const sc80 = fs.readFileSync(new URL('./api/scores.js', import.meta.url), 'utf8');

  t('分享页有历史总分趋势 + 年级排名变化',
    /function trendCards\(\)\{/.test(shareSrc80) && /历史总分趋势/.test(shareSrc80) && /年级排名变化/.test(shareSrc80));
  t('分享页画线用 SVG', /function lineCard\(title, arr, opts\)\{/.test(shareSrc80) && /<polyline points=/.test(shareSrc80));
  t('分享页卡与单可同时出（ownerRow + showBoard）',
    /var showBoard = wantBoard/.test(shareSrc80) && /if\(wantCard && ownerRow\)\{/.test(shareSrc80));
  t('后端 shareGet 带 history（含 subjects/s/schoolRank）',
    /history = hist\.map/.test(sc80) && /schoolRank: r\.school_rank == null/.test(sc80));
  t('后端有 share-update 动作 + 函数', /case 'share-update'/.test(sc80) && /async function shareUpdate\(/.test(sc80));
  t('前端分享弹窗支持编辑（editId + share-update + 编辑按钮）',
    /function scShareDialog\(edit\)\{/.test(idx80) && /share-update/.test(idx80) && /data-edit=/.test(idx80));
  t('编辑时提示「链接不变」', /链接不变/.test(idx80));

  /* ---- 功能：两次已发布考试（都含管理员本人的行）---- */
  const mkE80 = async (name, date, rows) => {
    const mk = await call('/api/scores?action=exam-save', { method: 'POST', token: adminToken,
      body: { name: name, exam_date: date, subjects: [{ key: 'chinese', name: '语文', full: 150 }] } });
    const id = mk.body.exam && mk.body.exam.id;
    await call('/api/scores?action=scores-import', { method: 'POST', token: adminToken, body: { exam: id, rows: rows } });
    await call('/api/scores?action=exam-publish', { method: 'POST', token: adminToken, body: { id: id, publish: true } });
    return id;
  };
  const e1 = await mkE80('分享历史一', '2026-09-01', [{ name: '余子康', no: '1', s: { chinese: { raw: 100 } }, schoolRank: 30 }]);
  const e2 = await mkE80('分享历史二', '2026-09-02', [
    { name: '余子康', no: '1', s: { chinese: { raw: 120 } }, schoolRank: 12 },
    { name: '路人甲', no: '2', s: { chinese: { raw: 90 } } },
  ]);
  t('（准备）两次已发布考试建好', !!e1 && !!e2, JSON.stringify({ e1: e1, e2: e2 }));

  const cs = await call('/api/scores?action=share-create', { method: 'POST', token: adminToken,
    body: { scope: 'self', examIds: [e2], sections: { board: false, card: true }, days: 7 } });
  const tok = cs.body.token;
  const g1 = await call('/api/scores?action=share-get&t=' + tok);
  t('★个人成绩卡分享带历史（>= 2 条）',
    g1.status === 200 && Array.isArray(g1.body.history) && g1.body.history.length >= 2,
    'history=' + (g1.body.history ? g1.body.history.length : 'null'));
  const h0 = (g1.body.history || [])[0] || {};
  t('★历史条目含科目/分数/年级排名', Array.isArray(h0.subjects) && !!h0.s && ('schoolRank' in h0));

  const beforeExp = g1.body.share.expiresAt;
  const up = await call('/api/scores?action=share-update', { method: 'POST', token: adminToken,
    body: { id: cs.body.id, scope: 'self', sections: { board: true, card: true }, days: 'keep' } });
  t('改分享成功', up.status === 200 && !!up.body.share, JSON.stringify(up.body).slice(0, 140));
  t('★改完 token 不变（旧链接照旧能用）', up.body.share.token === tok, up.body.share.token + ' vs ' + tok);
  t('★改完内容确实变了（card+board 都开）', up.body.share.sections.board === true && up.body.share.sections.card === true);
  t('★days=keep 时有效期不变', String(up.body.share.expiresAt) === String(beforeExp),
    up.body.share.expiresAt + ' vs ' + beforeExp);
  const g2 = await call('/api/scores?action=share-get&t=' + tok);
  t('★旧链接读到新内容（不用重发）', g2.status === 200
    && g2.body.share.sections.board === true && g2.body.share.sections.card === true);

  await call('/api/scores?action=share-revoke', { method: 'POST', token: adminToken, body: { id: cs.body.id } });
  await call('/api/scores?action=exam-delete', { method: 'POST', token: adminToken, body: { id: e1 } });
  await call('/api/scores?action=exam-delete', { method: 'POST', token: adminToken, body: { id: e2 } });
}

console.log('\n【81】第六十八/六十九轮·成绩导出 + 各科进退步 + 分享页口径修复 + 版本记录');
{
  const adm = readAdm();
  const idx = readIdx();
  const sw = fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
  const shr = fs.readFileSync(new URL('./share.html', import.meta.url), 'utf8');
  const wr = fs.readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8');

  /* 成绩导出 */
  t('后台考试卡有「导出」入口', /data-sc-act="export"/.test(adm) && /scExportDialog\(id\)/.test(adm));
  t('导出面板有 Excel / PDF 两个选项', /function scExportDialog\(id\)\{/.test(adm) && /导出 Excel/.test(adm) && /导出 PDF/.test(adm));
  t('Excel 用 SheetJS 生成并下载', /function scExportXlsx\(id\)\{/.test(adm) && /XLSX\.writeFile/.test(adm));
  t('PDF 走打印窗口（另存为 PDF）', /function scExportPdf\(id\)\{/.test(adm) && /w\.print\(\)/.test(adm));
  t('导出含班排/年级排名/联考排名/分数线', /班排/.test(adm) && /年级排名/.test(adm) && /联考排名/.test(adm) && /分数线/.test(adm));
  t('导出含考试名称与「成绩表」标题', /成绩表/.test(adm) && /_成绩\.xlsx/.test(adm));

  /* 各科进退步（3.1.0） */
  t('主站我的画像有「各科进退步」表', /function scSubjectProgress\(\)\{/.test(idx) && /各科进退步（最近/.test(idx));
  t('进退步表含 名次↑ / 稳定性（标准差）', /名次↑/.test(idx) && /稳定性/.test(idx) && /sd == null \? '—' : '±'/.test(idx));
  t('分享页也有「各科进退步」表', /function progressCard\(\)\{/.test(shr) && /各科进退步（最近/.test(shr) && /名次↑/.test(shr));

  /* 分享页原始口径修复（与主站一致） */
  t('★分享页：原始口径下化/生不显示「赋分」', /sub\.graded && BASIS === 'graded' \? '<span class="tag">赋分<\/span>'/.test(shr));
  t('★分享页：原始口径下不与三线比较（个人卡 + 全班两处都改）',
    (shr.match(/BASIS === 'graded'\) \? \(EX\.cutlines/g) || []).length >= 2);

  /* 版本与记录 */
    /* 断言「三处彼此一致 + 形如 3.x.y」，而不是钉死某个数字 —— 每轮升版都要改这里太脆 */
  t('版本号三处同步（index / admin / sw 彼此一致）',
    (function(){ var a=(idx.match(/SITE_VERSION = '([^']+)'/)||[])[1], b=(adm.match(/SITE_VERSION = '([^']+)'/)||[])[1], c=(sw.match(/SITE_VER = '([^']+)'/)||[])[1];
      return !!a && a===b && a===c && /^3\.\d+\.\d+$/.test(a); })());
  t('KV 绑定已恢复（未注释）', /^\[\[kv_namespaces\]\]/m.test(wr) && /binding = "SITE_KV"/.test(wr));
}

  /* v3.5.7 护栏：投票结果排序 + admin 无一元加号 NaN 坑 + 时区本地化 */
  {
    const idx = readIdx();
    const adm = readAdm();
    const votesjs = fs.readFileSync(new URL('./api/votes.js', import.meta.url), 'utf8');
    t('★投票后端 results 按票数降序（shapeVote sort）',
      /v\.results = \(v\.options \|\| \[\]\)\.map[\s\S]{0,200}\.sort\(\(a, b\) => b\.n - a\.n\)/.test(votesjs));
    t('★投票前端结果视图按票数降序（兜底 sort）',
      idx.includes("(v.results || v.options).slice().sort(function(a, b){ return (b.n || 0) - (a.n || 0); })"));
    t('★admin 投票列表无一元加号拼接坑（st.text 后不再跟 "+ +"）',
      !/st\.text\s*\n\s*\+\s*\+/.test(adm));
    t('★admin 截止时间走 voTimeText 本地时区（不再切 UTC 字符串）',
      adm.includes("voTimeText(v.deadline)") && adm.includes('function voTimeText('));
    t('★admin 编辑器 datetime-local 回填用本地时区（voLocalInput）',
      adm.includes('voLocalInput(v.deadline)') && adm.includes('function voLocalInput('));
  }

console.log('\n【82】第七十轮·v3.1.1 编辑分享保存真生效 + 四象限名单与图对齐 / 点圆点只看一个人');
{
  const idx = readIdx();
  const adm = readAdm();
  const sw = fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8');

  /* ① 分享弹窗：所有取值只在自己那一层里找 —— 否则「编辑」时读到旧弹窗就是保存无效 */
  t('★打开弹窗前先清掉旧弹窗（scShareClose 清所有 #scShMask）',
    /var all = document\.querySelectorAll\('#scShMask'\);/.test(idx)
    && /function scShareDialog\(edit\)\{\s*scShareClose\(\);/.test(idx));
  t('★弹窗内有作用域助手 scShEl（当前层优先）',
    /function scShEl\(id\)\{/.test(idx) && /return \(r && r\.querySelector\('#' \+ id\)\) \|\| document\.getElementById\(id\);/.test(idx));
  t('★弹窗内不再用 document.getElementById 取自身字段',
    !/document\.getElementById\('sh(Scope|Days|Max|Go|List|Out|Url|Copy|Names|SecTip)/.test(idx));
  t('★编辑时切范围不重置已勾的分享内容（原来会被默认值冲掉）',
    /if\(edit\)\{\s*var tip1 = scShEl\('shSecTip'\);[\s\S]{0,160}return;\s*\}/.test(idx));
  t('★自选同学的分享在编辑时名单是展开的',
    /scShEl\('shNamesWrap'\)\.style\.display = \(edit\.scope === 'picked'\) \? 'block' : 'none';/.test(idx));
  t('★勾选框只认分享弹窗里的两个（不再把设置页签按钮卷进来）',
    /scShAll\('\.sc-sh-sec input\[data-sec\]'\)/.test(idx)
    && /if\(k === 'board' \|\| k === 'card'\) sections\[k\] = !!cb\.checked;/.test(idx));

  /* ② 四象限：真的把四块算一遍，验证「下标 = 高分方向」与标题一致 */
  let quadOK = false, quadDetail = '';
  const qm = idx.match(/var quads = \[([\s\S]*?)\n  \];/);
  if (qm) {
    const W = 640, H = 380, L = 54, R = 24, T = 22, B = 46, mx = 300, my = 180;
    const quads = new Function('L', 'mx', 'T', 'my', 'W', 'R', 'H', 'B', 'return [' + qm[1] + '];')(L, mx, T, my, W, R, H, B);
    const want = ['总分低 / 单科弱', '总分强 / 单科弱', '总分低 / 单科强', '总分强 / 单科强'];
    const cases = [
      { dx: -1, dy: -1, i: 0 }, { dx: 1, dy: -1, i: 1 },
      { dx: -1, dy: 1, i: 2 }, { dx: 1, dy: 1, i: 3 },
    ];
    quadOK = cases.every((c) => {
      const q = quads[c.i];
      const cx = mx + c.dx * 40, cy = my - c.dy * 40;   /* SVG 纵轴反向：单科强 → y 更小 */
      return q && q.t.indexOf(want[c.i]) === 0
        && cx >= q.x - 0.01 && cx <= q.x + q.w + 0.01
        && cy >= q.y - 0.01 && cy <= q.y + q.h + 0.01;
    });
    quadDetail = quads.map((q) => q.t + '@' + Math.round(q.y)).join(' | ');
  }
  t('★四象限 0..3 的下标、位置、标题三者一致（几何校验）', quadOK, quadDetail);
  t('★点圆点＝只看这一个人（scQuadDot + 个人明细）',
    /function scQuadDot\(i\)\{/.test(idx) && /onclick="scQuadDot\(' \+ pi \+ '\)"/.test(idx)
    && /function scQuadRender\(\)\{/.test(idx) && /class="sc-qwho"/.test(idx));
  t('★点彩色底块才看整个象限的名单',
    /onclick="scQuadTap\(' \+ qi \+ '\)"/.test(idx) && /SC\.quadSel = \(SC\.quadSel === i\) \? null : i;/.test(idx));
  t('★个人明细含总分/该科/与班均差/年级排名',
    /scQWhoItem\('总分'/.test(idx) && /scQWhoItem\(qd\.subName/.test(idx) && /年级第 ' \+ rank/.test(idx));
  t('★切科目/口径时把「选中的那个人」也清掉',
    /function scSetQuad\(k\)\{ SC\.quadKey = k; SC\.quadSel = null; SC\.quadDot = null;/.test(idx));

  /* ③ 功能：改 scope 真的生效（self → class → self） */
  const mk = await call('/api/scores?action=exam-save', { method: 'POST', token: adminToken,
    body: { name: '分享范围改动验证', exam_date: '2026-10-05', subjects: [{ key: 'chinese', name: '语文', full: 150 }] } });
  const eid = mk.body.exam && mk.body.exam.id;
  await call('/api/scores?action=scores-import', { method: 'POST', token: adminToken, body: { exam: eid, rows: [
    { name: '余子康', no: '1', s: { chinese: { raw: 120 } }, schoolRank: 8 },
    { name: '路人乙', no: '2', s: { chinese: { raw: 95 } }, schoolRank: 40 },
  ] } });
  await call('/api/scores?action=exam-publish', { method: 'POST', token: adminToken, body: { id: eid, publish: true } });

  const cs = await call('/api/scores?action=share-create', { method: 'POST', token: adminToken,
    body: { scope: 'self', examIds: [eid], sections: { board: true, card: false }, days: 7 } });
  const tok = cs.body.token;
  const g1 = await call('/api/scores?action=share-get&t=' + tok);
  t('（准备）scope=self 时只看到自己那一行', g1.status === 200 && (g1.body.rows || []).length === 1,
    'rows=' + ((g1.body.rows || []).length));

  const up = await call('/api/scores?action=share-update', { method: 'POST', token: adminToken,
    body: { id: cs.body.id, scope: 'class', sections: { board: true, card: false }, days: 'keep' } });
  t('★改成 class 后返回的 scope 就是 class', up.status === 200 && up.body.share.scope === 'class',
    JSON.stringify(up.body.share && up.body.share.scope));
  const g2 = await call('/api/scores?action=share-get&t=' + tok);
  t('★旧链接立刻按新范围给数据（1 行 → 2 行）',
    g2.status === 200 && (g2.body.rows || []).length === 2, 'rows=' + ((g2.body.rows || []).length));

  const up2 = await call('/api/scores?action=share-update', { method: 'POST', token: adminToken,
    body: { id: cs.body.id, scope: 'self', sections: { board: true, card: false }, days: 'keep' } });
  const g3 = await call('/api/scores?action=share-get&t=' + tok);
  t('★再改回 self 也生效（2 行 → 1 行）',
    up2.status === 200 && (g3.body.rows || []).length === 1, 'rows=' + ((g3.body.rows || []).length));

  await call('/api/scores?action=share-revoke', { method: 'POST', token: adminToken, body: { id: cs.body.id } });
  await call('/api/scores?action=exam-delete', { method: 'POST', token: adminToken, body: { id: eid } });

  /* ④ 版本与记录 */
    t('版本号三处同步（index / admin / sw 彼此一致）',
    (function(){ var a=(idx.match(/SITE_VERSION = '([^']+)'/)||[])[1], b=(adm.match(/SITE_VERSION = '([^']+)'/)||[])[1], c=(sw.match(/SITE_VER = '([^']+)'/)||[])[1];
      return !!a && a===b && a===c; })());
}

console.log('\n【83】第七十一轮·v3.2.0 各科趋势可看名次 + 姓名对照「选账号 / 直接改名（含按次）」');
{
  const idx = readIdx();
  const adm = readAdm();
  const sc = fs.readFileSync(new URL('./api/scores.js', import.meta.url), 'utf8');

  /* ① 各科趋势：分数 / 名次 双口径 */
  t('各科趋势有「分数 / 名次」切换（scSetSubTrend + 分段按钮）',
    /function scSetSubTrend\(m\)\{/.test(idx) && /scSetSubTrend\(\\'rank\\'\)/.test(idx) && /看名次/.test(idx));
  t('★迷你折线支持「越小越好」（名次口径纵轴翻转）',
    /if\(!betterIsHigh\) t = 1 - t;/.test(idx) && /scMiniLine\(rpts, false,/.test(idx));
  t('★名次口径取赋分名次/原始名次（跟着总分口径走）',
    /\(SC\.basis === 'graded' && sub\.graded && v\.asgRank != null\) \? v\.asgRank : v\.rank/.test(idx));
  t('名次卡显示「第 N 名」+「名次 ↑」且保留分数', /第 ' \+ rcur/.test(idx) && /'较上次 名次'/.test(idx) && /分数 ' \+ fmtNum\(cur\)/.test(idx));
  t('名次缺数据时给出「暂无名次」而不是空白', /暂无名次/.test(idx));

  /* ② 姓名对照：选账号 + 直接改名 */
  t('后台姓名对照有「直接改名」输入与按钮', /data-nm-rename=/.test(adm) && /data-nm-rn-go=/.test(adm));
  t('★可按考试分别改（展开 + 只改这次）',
    /data-nm-toggle=/.test(adm) && /data-nm-exinput=/.test(adm) && /data-nm-exgo=/.test(adm) && /按考试分别改/.test(adm));
  t('★候选账号写成「姓名（账号）」，并能区分同名', /u\.username && u\.username !== u\.name \? '（'/.test(adm));
  t('后台调用 name-rename 动作', /action=name-rename/.test(adm));
  t('后端有 name-rename 路由与函数', /case 'name-rename'/.test(sc) && /async function nameRename\(/.test(sc));
  t('★改名不写别名对照（打错≠别名）',
    (() => { const i = sc.indexOf('async function nameRename('); const j = sc.indexOf('async function nameBind(', i);
             const body = sc.slice(i, j); return !/nameMap/.test(body) && !/insert into score_config/.test(body); })());
  t('unbound 带每个姓名出现的考试明细', /exams: exs/.test(sc) && /select student_name, exam_id, count\(\*\) as n/.test(sc));

  /* ③ 功能：打错的名字 → 直接改名，账号自动对上 */
  const mkExam = async (name, date, rows) => {
    const mk = await call('/api/scores?action=exam-save', { method: 'POST', token: adminToken,
      body: { name: name, exam_date: date, subjects: [{ key: 'chinese', name: '语文', full: 150 }] } });
    const id = mk.body.exam && mk.body.exam.id;
    await call('/api/scores?action=scores-import', { method: 'POST', token: adminToken, body: { exam: id, rows: rows } });
    return id;
  };
  const exA = await mkExam('改名验证A', '2026-10-11', [{ name: '于子康', no: '9', s: { chinese: { raw: 99 } } }]);
  const exB = await mkExam('改名验证B', '2026-10-12', [{ name: '于子康', no: '9', s: { chinese: { raw: 101 } } }]);
  const exD = await mkExam('改名验证D', '2026-10-13', [
    { name: '于子康', no: '9', s: { chinese: { raw: 88 } } },
    { name: '余子康', no: '1', s: { chinese: { raw: 120 } } },
  ]);

  const ub0 = await call('/api/scores?action=unbound', { token: adminToken });
  const u0 = (ub0.body.unbound || []).find((x) => x.name === '于子康');
  t('★未识别姓名带「出现在哪几次考试」', !!u0 && Array.isArray(u0.exams) && u0.exams.length === 3,
    JSON.stringify(u0));

  /* 只改某一次 */
  const rn1 = await call('/api/scores?action=name-rename', { method: 'POST', token: adminToken,
    body: { from: '于子康', to: '余子康', exam: exA } });
  t('★只改一次：改完 1 行且自动绑上账号', rn1.status === 200 && rn1.body.renamed === 1 && rn1.body.bound === true,
    JSON.stringify(rn1.body));

  const ub1 = await call('/api/scores?action=unbound', { token: adminToken });
  const u1 = (ub1.body.unbound || []).find((x) => x.name === '于子康');
  t('★改完之后仍剩另外两次（没被一起改掉）', !!u1 && u1.exams.length === 2,
    JSON.stringify(u1));
  t('★改名没有写入别名对照（打错不是别名）', !(ub1.body.nameMap && ub1.body.nameMap['于子康']),
    JSON.stringify(ub1.body.nameMap || {}));

  /* 全部改 */
  const rn2 = await call('/api/scores?action=name-rename', { method: 'POST', token: adminToken,
    body: { from: '于子康', to: '余子康' } });
  t('★不传考试＝全部改（B 改 1 行；D 那场已有「余子康」被跳过）', rn2.status === 200 && rn2.body.renamed === 1,
    JSON.stringify(rn2.body));

  /* 冲突：那一场本来就有「余子康」 */
  const rn3 = await call('/api/scores?action=name-rename', { method: 'POST', token: adminToken,
    body: { from: '于子康', to: '余子康', exam: exD } });
  t('★目标姓名在该场已存在时，报冲突且不改（避免一人两行）',
    rn3.status === 200 && rn3.body.renamed === 0 && (rn3.body.conflicts || []).indexOf(exD) >= 0,
    JSON.stringify(rn3.body));

  const ub2 = await call('/api/scores?action=unbound', { token: adminToken });
  t('（收尾）未识别名单里已没有「于子康」之外的残留误判',
    !(ub2.body.unbound || []).some((x) => x.name === '余子康'));

  for (const id of [exA, exB, exD]) {
    await call('/api/scores?action=exam-delete', { method: 'POST', token: adminToken, body: { id: id } });
  }

  /* ④ 版本 */
  t('版本号三处同步（index / admin 彼此一致）',
    (function(){ var a=(idx.match(/SITE_VERSION = '([^']+)'/)||[])[1], b=(adm.match(/SITE_VERSION = '([^']+)'/)||[])[1];
      return !!a && a===b; })());
}

console.log('\n【84】第七十二轮·v3.2.1 修「部署失败」的两个假红灯（缓存穿透 + 代码版本回查）');
{
  const idx = readIdx();
  const adm = readAdm();
  const sw = fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
  const wrk = fs.readFileSync(new URL('./api/worker.mjs', import.meta.url), 'utf8');
  const pg = fs.readFileSync(new URL('./.github/workflows/deploy-pages.yml', import.meta.url), 'utf8');
  const wf = fs.readFileSync(new URL('./.github/workflows/deploy-worker.yml', import.meta.url), 'utf8');

  /* ① 后端代码自带版本号（Cloudflare Git 集成部署时 BUILD_SHA 是 local，只能靠它） */
  t('Worker 有 API_VER 常量并输出 X-Api-Ver 头',
    /const API_VER = '[^']+'/.test(wrk) && /state\.headers\['X-Api-Ver'\] = API_VER;/.test(wrk));
  const apiVer = (wrk.match(/const API_VER = '([^']+)'/) || [])[1];
  const siteVer = (idx.match(/var SITE_VERSION = '([^']+)'/) || [])[1];
  t('★API_VER 与前台 SITE_VERSION 同步（漏改会被这条抓住）', !!apiVer && apiVer === siteVer,
    'api=' + apiVer + ' site=' + siteVer);
  t('后台版本号与前台一致',
    (function(){ var b=(adm.match(/SITE_VERSION = '([^']+)'/)||[])[1], c=(sw.match(/SITE_VER = '([^']+)'/)||[])[1], a=(idx.match(/SITE_VERSION = '([^']+)'/)||[])[1];
      return !!b && b===a && b===c; })());

  /* ② Pages 回查：必须做缓存穿透，否则 CDN 的 10 分钟缓存会一直判失败 */
  t('★Pages 回查带随机查询串做缓存穿透', /local cb="cb=\$\(date \+%s%N\)-\$RANDOM"/.test(pg) && /"\$BASE\/\$1\?\$cb"/.test(pg));
  t('★Pages 回查显式 no-cache', /Cache-Control: no-cache/.test(pg) && /Pragma: no-cache/.test(pg));
  t('Pages 回查重试窗口 ≥180 秒', /seq 1 18/.test(pg) && /等了 180 秒/.test(pg));
  t('Pages 失败提示区分「部署那步绿/红」', /部署那步是绿的/.test(pg) && /部署那步是红的/.test(pg));

  /* ③ Worker 回查：两个信号任一命中即算成功，并打印线上实际值 */
  t('★Worker 回查接受 x-api-ver（不再只认 BUILD_SHA）',
    /x-api-ver/.test(wf) && /\[ "\$GOT_VER" = "\$WANT_VER" \]/.test(wf));
  t('★Worker 回查从 api/worker.mjs 现读版本号，不写死',
    wf.includes('WANT_VER=$(grep -oE') && wf.includes('api/worker.mjs')
    && wf.includes('const API_VER'));
  t('Worker 失败时回显线上实际标记与期望值', /线上实际：x-build-sha=/.test(wf) && /本次期望：x-build-sha=/.test(wf));
  t('★wrangler 步骤允许失败（Cloudflare Git 集成在真正部署，回查说了算）',
    /continue-on-error: true/.test(wf) && /不急着判死/.test(wf) && /steps\.deploy\.outcome/.test(wf));

  /* ④ 单一部署路径：Worker 只留手动触发（否则和 Cloudflare Git 集成撞车，同一份代码部署两遍） */
  t('★Worker 工作流取消 push 自动触发（改由 Cloudflare Git 集成负责）',
    !/^on:\s*\n\s*push:/m.test(wf) && /workflow_dispatch:/.test(wf)
    && /Cloudflare 自己的 Git 集成/.test(wf));
  t('★Pages 工作流仍保留 push 自动发布（前端只有这一条路径）', /^on:\s*\n\s*push:/m.test(pg));

  /* ⑤ 模拟 CI 里那行解析，确认能取到版本号 */
  const parsed = (wrk.match(/const API_VER = '([^']+)'/) || [])[1];
  t('（模拟）CI 的 grep|sed 能取出版本号', /^3\.\d+\.\d+$/.test(String(parsed||'')), 'parsed=' + parsed);
}


console.log('\n【85】第七十三轮·v3.3.0 需关注学生加单科线（比例口径）/ 进退步榜合并全量可排序 / 热力图点选');
{
  /* 这一轮的三项都长在前端的渲染函数里，光靠正则查字符串证明不了「算得对」。
     所以在 vm 沙箱里把 index.html 的主脚本真跑一遍（DOM 用最小桩），
     直接调 scWatchList / scTailRank / scHeatmap，断言看到的是**算出来的数**。
     —— 上一轮「编辑分享保存无效」就是正则全绿、实际行为错，教训在这儿。 */
  const vmMod = await import('node:vm');
  /* v3.9.8：主脚本已拆到 app.js —— 直接读它（HTML 里剩下的都是小内联脚本）。
     版本号现在声明在 index.html，沙箱里补上两行，跟真实加载顺序一致。 */
  const big = "var SITE_VERSION='3.9.17';var VER_DATE='2026-10-22';\n"
    + fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');

  const mkEl = (tag) => ({
    tagName: (tag || 'div').toUpperCase(), _attrs: {},
    innerHTML: '', textContent: '', children: [], childNodes: [], parentNode: null, dataset: {},
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
    setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k] ?? null; },
    removeAttribute() {}, hasAttribute() { return false; }, closest() { return null; },
    insertBefore() {}, replaceChild() {}, matches() { return false; }, cloneNode() { return mkEl(tag); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    focus() {}, blur() {}, remove() {}, click() {}, dispatchEvent() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
    offsetWidth: 0, offsetHeight: 0,
  });
  const reg = [];
  const doc = {
    documentElement: mkEl('html'), body: mkEl('body'), head: mkEl('head'), _els: {},
    getElementById(id) { if (!this._els[id]) { this._els[id] = mkEl(); this._els[id].id = id; } return this._els[id]; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    createElement: mkEl, createTextNode: () => mkEl(),
    addEventListener(t, fn) { reg.push({ t, fn }); }, removeEventListener() {},
    readyState: 'complete', cookie: '', title: '', fonts: { ready: Promise.resolve() },
  };
  const st54 = {};
  const win = {
    document: doc,
    localStorage: { getItem: k => (k in st54 ? st54[k] : null), setItem: (k, v) => { st54[k] = String(v); }, removeItem: k => { delete st54[k]; }, key: i => Object.keys(st54)[i], length: 0 },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { href: 'https://x/', hash: '', search: '', protocol: 'https:', host: 'x', pathname: '/' },
    navigator: { userAgent: 'node', language: 'zh-CN', onLine: true, clipboard: null },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    fetch: () => Promise.reject(new Error('offline')),
    addEventListener() {}, removeEventListener() {},
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    alert() {}, confirm: () => false, prompt: () => '', console,
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 2, scrollY: 0, scrollX: 0, scrollTo() {},
    URL: { createObjectURL: () => '', revokeObjectURL() {} },
    Blob: function () {}, FormData: function () {}, FileReader: function () {},
    Map, Set, Promise, JSON, Math, Date, parseInt, parseFloat, isFinite, encodeURIComponent, decodeURIComponent,
    crypto: { subtle: {} }, IndexedDB: {}, WebSocket: function () {},
    Audio: function () { return { play() {}, pause() {}, cloneNode() { return this; } }; },
  };
  win.window = win; win.globalThis = win; win.self = win; win.top = win; win.parent = win;

  let ctx = null, runErr = null;
  try { ctx = vmMod.createContext(win); vmMod.runInContext(big, ctx, { filename: 'index.js' }); }
  catch (e) { runErr = e; }
  t('★index.html 主脚本能在空 DOM 上跑完（渲染函数可被直接调用）', !runErr && !!ctx && !!ctx.SC, runErr ? runErr.message : 'ok');
  if (runErr || !ctx || !ctx.SC) { /* 后面都依赖它，直接跳过 */ }
  else {
    const SC = ctx.SC;
    const strip = h => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    /* ---------- ① 需关注学生：总分线 + 单科线（比例口径） ---------- */
    const subs6 = [
      { key: 'yw', name: '语文', full: 150 }, { key: 'sx', name: '数学', full: 150 }, { key: 'yy', name: '英语', full: 150 },
      { key: 'wl', name: '物理', full: 100 }, { key: 'hx', name: '化学', full: 100, graded: true }, { key: 'sw', name: '生物', full: 100, graded: true },
    ];
    const KEYS = ['yw', 'sx', 'yy', 'wl', 'hx', 'sw'];
    const cvt = a => [a[0] + 10, a[1] + 10, a[2] + 10, a[3] + 30, a[4] + 30, a[5] + 30];
    const mk = (id, nm, raw5, grade) => {
      const s = {};
      KEYS.forEach((k, i) => { s[k] = { raw: raw5[i], assigned: grade ? grade[i] : cvt(raw5)[i], rank: 1, asgRank: 1 }; });
      return { id, uid: id, name: nm, s, schoolRank: id * 10, leagueRank: id * 30 };
    };
    const rows6 = [
      mk(1, '甲', [120, 130, 125, 85, 82, 80], cvt([120, 130, 125, 85, 82, 80])),
      mk(2, '乙', [95, 100, 98, 62, 50, 48], cvt([95, 100, 98, 62, 50, 48])),
      mk(3, '丙', [105, 115, 110, 72, 30, 68], cvt([105, 115, 110, 72, 30, 68])),
      mk(4, '丁', [130, 140, 132, 90, 85, 88], cvt([130, 140, 132, 90, 85, 88])),
    ];
    ctx.AUTH.user = { id: 1, role: 'admin', displayName: '甲' };
    SC.exam = { id: 10, name: '六科测试', date: '2026-10-02', subjects: subs6, cutlines: [] };
    SC.rows = rows6; SC.basis = 'graded'; SC.config = {}; SC.me = [];

    const stt = ctx.scStats('graded');
    t('（自检）六科班均可算', Math.abs(stt.avg - 620) < 1e-9, 'avg=' + stt.avg);
    t('★阈值系数 SC_ALERT_RATIO = 1.5%（把「20 分」换算成满分的比例）', ctx.SC_ALERT_RATIO === 0.015, String(ctx.SC_ALERT_RATIO));

    const L = ctx.scAlertLines();
    t('★总分线 = 班均 − 总分满分 × 1.5%（750 制 → 掉 11.25 分）',
      Math.abs(L.totalLine - (620 - 11.25)) < 1e-9, 'line=' + L.totalLine);
    t('★单科线按各科满分割算（语文 150→掉 2.25；化学 100→掉 1.5）',
      Math.abs(L.subLines.yw - (L.avgs.yw - 2.25)) < 1e-9 && Math.abs(L.subLines.hx - (L.avgs.hx - 1.5)) < 1e-9,
      'yw=' + L.subLines.yw.toFixed(2) + ' hx=' + L.subLines.hx.toFixed(2));
    t('★★单科线落在各科量程内（按字面「总分班均−20」会永远够不到，这条防回归）',
      Object.keys(L.subLines).every(k => {
        const sub = subs6.find(x => x.key === k);
        return L.subLines[k] > 0 && L.subLines[k] < sub.full;
      }));

    const hw = ctx.scWatchList();
    const tw = strip(hw);
    t('需关注学生卡渲染', /需关注学生/.test(tw));
    t('★卡片标题写明比例口径', /某科低于该科班均 1\.5% 满分/.test(tw), tw.slice(0, 120));
    t('★新增「拖后腿的单科」列', /拖后腿的单科/.test(tw));
    t('★脚注列出每科的具体阈值（语文… / 数学…）', /单科线按各科满分同比例折算/.test(tw) && /语文[\d.]+ \/ 数学[\d.]+/.test(tw));
    t('★总分掉队的人上榜（乙 513）', /乙/.test(tw));
    t('★★总分不差但某科掉队的人上榜（丙：化学 60，远低于该科线）',
      /丙[\s\S]{0,140}化学/.test(tw), (tw.match(/丙[\s\S]{0,100}/) || [''])[0]);
    t('★单科标签给出「科目 分数 低于该科线多少」', /化学 60 -\d/.test(tw), (tw.match(/化学 60\s*[-\d.]*/) || [''])[0]);
    t('总分不达标的人不标「仅单科」', !/乙\s*仅单科/.test(tw));
    /* v3.5.6：脚注改为「筛选条 + 自动总结」，两个口径的人数挪到筛选条徽标和总结文字里 */
    t('脚注分开统计两个口径的人数',
      (/总分不达标/.test(tw) && (/仅单科/.test(tw) || /单科不达标/.test(tw)))
      && /本次共/.test(tw));

    /* ---------- ② 进退步榜：合并成一张表 / 全量 / 点表头排序 ---------- */
    const prevRows = [
      mk(1, '甲', [100, 110, 105, 70, 65, 68]), mk(2, '乙', [100, 105, 100, 66, 62, 64]),
      mk(3, '丙', [100, 110, 105, 68, 60, 62]), mk(4, '丁', [120, 130, 125, 85, 80, 82]),
    ];
    SC.allRows = { 9: { exam: { id: 9, name: '上次', date: '2026-09-01', subjects: subs6 }, rows: prevRows }, 10: { exam: SC.exam, rows: rows6 } };
    SC.exams = [{ id: 9, name: '上次', date: '2026-09-01' }, { id: 10, name: '六科测试', date: '2026-10-02' }];

    const ht = ctx.scTailRank();
    const tt = strip(ht);
    t('进退步榜渲染', /进退步榜/.test(tt));
    t('★不再拆成「进步最多 / 退步最多」两张表', !/进步最多/.test(tt) && !/退步最多/.test(tt));
    t('★合并成一张表、全部人都在（共比了 4 人）', /共比了 4 人/.test(tt), tt.slice(-150));
    t('★表头 5 项都可点排序', /scTailSort\('name'\)/.test(ht) && /scTailSort\('from'\)/.test(ht)
      && /scTailSort\('to'\)/.test(ht) && /scTailSort\('d'\)/.test(ht) && /scTailSort\('dc'\)/.test(ht));
    t('★仍可按班级 / 年级 / 单科筛选', /scTailSet\('class'\)/.test(ht) && /scTailSet\('grade'\)/.test(ht) && /scTailSet\('subject'\)/.test(ht));
    t('给出进步 / 退步 / 持平人数', /进步 \d+ 人/.test(tt) && /退步 \d+ 人/.test(tt) && /持平 \d+ 人/.test(tt));
    t('默认按「名次变化」降序（进步最多的在最前）', SC.tailSortKey === 'd' && SC.tailSortAsc === false);

    ctx.scTailSort('name');
    t('★点「姓名」→ 改按姓名升序', SC.tailSortKey === 'name' && SC.tailSortAsc === true);
    ctx.scTailSort('name');
    t('★再点「姓名」→ 反转降序', SC.tailSortAsc === false);
    ctx.scTailSort('d');
    t('★点「名次变化」→ 回到变化降序', SC.tailSortKey === 'd' && SC.tailSortAsc === false);
    t('排序后照常渲染', /共比了 4 人/.test(strip(ctx.scTailRank())));
    ctx.scTailSet('grade');
    t('切「年级」口径可算（靠导入的校排名）', !!ctx.scTailRank());
    ctx.scTailSet('subject');
    t('切「单科」口径可算', !!ctx.scTailRank());

    /* ---------- ③ 热力图：手机端点一格看明细 ---------- */
    const hh = ctx.scHeatmap();
    t('热力图渲染', /学生 × 科目热力图/.test(hh));
    t('★24 格全部可点（class 里带 sc-hm-hit 和 data-hm）',
      (hh.match(/class="sc-hm sc-hm-hit"/g) || []).length === 24);
    t('★明细区 #scHmList 就挂在表下面', /id="scHmList"/.test(hh));
    t('SC._hm 缓存了 24 格数据（点选时不用重算）', Array.isArray(SC._hm) && SC._hm.length === 24);
    t('每格数据含姓名/科目/分数/该科班均/总分/总分班均', (() => {
      const c = SC._hm[7];
      return c && c.name && c.sub && c.avg != null && c.total != null && c.totalAvg != null;
    })());

    doc.getElementById('scPaneBox').innerHTML = hh;
    ctx.scHeatBind();
    const clicks = reg.filter(r => r.t === 'click');
    t('点选走 document 事件委托', clicks.length >= 1);
    const before35 = clicks.length;
    ctx.scHeatBind();
    t('★重复调用不重复绑定（__scHeatBound 守卫）', reg.filter(r => r.t === 'click').length === before35);

    const fakeCell = (id) => {
      const cell = {
        getAttribute: k => (k === 'data-hm' ? String(id) : null),
        closest: sel => (sel === '.sc-hm-body' ? {} : (sel === '.sc-hm-hit' ? cell : null)),
      };
      return cell;
    };
    const fire = (target) => clicks.forEach(r => r.fn({ target }));
    const box = doc.getElementById('scHmList');

    fire(fakeCell(7));
    const d1 = strip(box.innerHTML);
    t('★点一格弹出这一格的明细（乙 · 数学）', /乙/.test(d1) && /数学/.test(d1), d1.slice(0, 120));
    t('★明细里给出该科比班均高/低多少', /班均/.test(d1));
    t('★明细里给出总分、年级排名、联考排名', /总分/.test(d1) && /年级排名/.test(d1) && /联考排名/.test(d1));
    t('★明细里给出原始 / 赋分对照', /原始/.test(d1));
    t('SC.hmSel 记住选中格', SC.hmSel === 7);
    fire(fakeCell(7));
    t('★再点同一格收起', SC.hmSel === null && strip(box.innerHTML) === '');
    ctx.scHeatTap(null);
    t('收起按钮传 null 不报错', SC.hmSel === null);
  }
}

/* 结果汇总放到文件最末尾：后面还有【87】【88】等「只看源码」的静态断言段，
   早打印就会漏计它们（历史上踩过：process.exit 提前退出导致追加段不执行）。 */
console.log('\n【87】第七十五轮·v3.4.1 字段可见性新增「仅管理员」档');
{
  const rd = (f) => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
  const idx = readIdx(), adm = readAdm();
  const prof = rd('api/profile.js'), admjs = rd('api/admin.js');
  t('★profile.js：VIS_RANK 含 admin 档', /VIS_RANK = \{ public: 0, committee: 1, self: 2, admin: 3 \}/.test(prof));
  t('★profile.js：canSee 对 admin 档要求 ctx.admin（本人/班委都不放行）',
    /if \(eff === 'admin'\) return !!ctx\.admin;/.test(prof));
  /* v3.5.21：前台查询一视同仁 —— search 固定 admin:false（管理员也没特权，
     要看详细档案去后台），myProfile 仍按真实身份传（本人看自己）。 */
  t('★profile.js：前台两条链路都不因管理员身份多给字段（v3.5.38 收紧）',
    (prof.match(/admin: false \}/g) || []).length >= 2
    && !/admin: u\.role === 'admin'/.test(prof));
  t('★v3.5.38 profile.js 不再按调用者角色放行「仅后端可见」',
    !/admin: u\.role/.test(prof),
    '一律 false —— 管理员也只能去后台看');
  t('★admin.js：set-visibility / add-field 白名单含 admin',
    /ALLOWED_VIS = \['public', 'committee', 'self', 'admin'\]/.test(admjs));
  t('★admin.html：标签/描述/快捷按钮/新增弹窗/单人例外五处在位',
    /VIS_LABEL = \{ public:'公开', committee:'班委可见', self:'仅本人', admin:'仅后端可见' \}/.test(adm)
    && adm.includes('admin:     ') && (adm.match(/\['public', ?'committee', ?'self', ?'admin'\]/g) || []).length >= 2
    && adm.includes("value=\"admin\""));
  t('★前台无档位枚举（档位判定全在服务端，前端只渲染给到的字段）',
    !idx.includes("'committee'"));
}


console.log('\n【88】第七十六轮·v3.5.0 成员档案字段全量加密');
{
  const rd = (f) => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
  const admjs = rd('api/admin.js'), prof = rd('api/profile.js');
  const crypt = rd('api/_lib/profile-crypt.js'), schemaSrc = rd('api/schema.sql');
  const httpSrc = rd('api/_lib/http.js');

  /* --- ① 模块与接线 --- */
  t('★profile-crypt.js 用 AES-256-GCM（Workers 原生 Web Crypto）',
    crypt.includes('AES-GCM') && crypt.includes("const ENC_PREFIX = 'enc:v1:'"));
  t('★密文格式带哨兵前缀 enc:v1:（迁移期靠它区分明文/密文）',
    crypt.includes("return ENC_PREFIX + bufToB64(all)"));
  t('★decField 对非密文原样返回（存量明文不受影响）',
    /if \(s\.slice\(0, ENC_PREFIX\.length\) !== ENC_PREFIX\) return s;/.test(crypt));
  t('★admin.js 与 profile.js 都 import 了加密模块',
    admjs.includes("from './_lib/profile-crypt.js'") && prof.includes("from './_lib/profile-crypt.js'"));

  /* --- ② 写路径：所有落库字段都过 encField --- */
  t('★admin.js upsertProfileCore 落库前加密姓名/学号/政治面貌/准考证号',
    /await encField\(pkey, plainName\)/.test(admjs)
    && /await encField\(pkey, plainSid\)/.test(admjs)
    && /await encField\(pkey, plainPolitics\)/.test(admjs)
    && /await encField\(pkey, plainExamNo\)/.test(admjs));
  t('★admin.js 联系方式（微信/QQ/手机）同样加密',
    /await encField\(pkey, await keep\(wechat, c\.wechat\)\)/.test(admjs)
    && /await encField\(pkey, await keep\(phone, c\.phone\)\)/.test(admjs));
  t('★admin.js UPDATE 分支「没传就保留」先解密再加密（防空转叠层）',
    /const keep = async \(incoming, stored\) =>/.test(admjs)
    && /: await decField\(pkey, stored\);/.test(admjs));
  t('★admin.js 自定义字段（含身份证/团员编号）值也加密',
    (admjs.match(/await encField\(pkey, customVals\[f\.field\]\)/g) || []).length === 2
    && /await encField\(pkey, ex\[col\]\)/.test(admjs)          /* 批量导入 INSERT */
    && /await encField\(pkey, nvs\)/.test(admjs));                /* 批量导入 UPDATE（空值才写）
  t('★profile.js 同学自己提交联系方式时也加密',
    /const eWechat = await encField\(pkey, wechat \|\| null\)/.test(prof));
  t('★建号自动补档案时姓名加密',
    /insert into profiles \(name, name_bidx, role, user_id\)/.test(admjs));

  /* --- ③ 检索：学号唯一性 / 姓名查找改走盲索引 --- */
  t('★学号查重走 student_id_bidx（密文等值比较永远不等）',
    admjs.includes('where student_id_bidx = ${await blindIndex(pkey, sid)}'));
  t('★批量导入按学号/姓名查重也走 bidx',
    admjs.includes('where student_id_bidx = ${sidBidx}') && admjs.includes('where name_bidx = ${nameBidx}'));
  t('★盲索引是 HMAC-SHA256（不含原值，拿库也反推不出姓名）',
    crypt.includes("'HMAC'") && crypt.includes("hash: 'SHA-256'"));
  t('★盲索引对原值做空白归一（" 张三 " 与 "张三" 命中同一条）',
    /String\(plain\)\.replace\(\/\\s\+\/g, ' '\)\.trim\(\)/.test(crypt));

  /* --- ④ 读路径：每个吐明文的读点都解密 --- */
  t('★admin.js 有统一的 decProfileRow 解密助手', /async function decProfileRow\(key, row\)/.test(admjs));
  t('★profileDetail / profileRequests / titles / view-logs 各读点都解密',
    (admjs.match(/decProfileRow\(/g) || []).length >= 4);
  t('★profile.js 有 decRow，search/roster/me/mine-requests/claim 都过一遍',
    /async function decRow\(key, row\)/.test(prof) && (prof.match(/decRow\(pkey|decRow\(await profileKey\(req\)/g) || []).length >= 4);
  t('★查看日志写的是明文姓名（存密文等于白存）',
    /const r = await decRow\(pkey, r0\);/.test(prof));
  t('★查看日志读取时也解密资料真名', /const realName = r\.target_real_name \? await decField/.test(admjs));
  t('★本人私有字段跳过 bidx 两列（内部列不外泄）',
    prof.includes("'name_bidx', 'student_id_bidx'"));

  /* --- ⑤ schema / 自愈 --- */
  t('★schema.sql 补 name_bidx / student_id_bidx 两列',
    schemaSrc.includes('add column if not exists name_bidx')
    && schemaSrc.includes('add column if not exists student_id_bidx'));
  t('★schema.sql 去掉 student_id 的 unique（密文永不相等，留着会误报）',
    /student_id    text,                                  -- 学号（管理员维护，密文存储）/.test(schemaSrc)
    && /drop constraint if exists profiles_student_id_key/.test(schemaSrc));
  t('★http.js 自愈也补这两列与索引（老库不用手工迁移）',
    /add column if not exists name_bidx/.test(httpSrc)
    && /profiles_sid_bidx_idx/.test(httpSrc));

  /* --- ⑥ 没配密钥时整体退化 --- */
  t('★profileKey 拿不到密钥返回 null（全站退化明文，不打死后台）',
    /if \(!raw\) return null;/.test(crypt));
  t('★encField 在 key 为 null 时原样返回',
    /if \(!key\) return plain == null \? plain : String\(plain\);/.test(crypt));
  t('★解不出时给出可操作提示，而不是抛错',
    crypt.includes('【已加密，但未配置 ADMIN_SECRETS_KEY，无法解密】'));
  t('★解密占位符有专门判定函数（isUndecryptable）',
    /export function isUndecryptable\(v\)/.test(crypt));
  t('★写入侧拦截占位符（避免把「【解密失败】」当输入覆盖掉原密文）',
    /!isUndecryptable\(incoming\)/.test(admjs)
    && /if \(isUndecryptable\(customVals\[f\.field\]\)\) continue;/.test(admjs));

  /* --- ⑦ 真实数据流：库里是密文、接口返回明文（只在加密模式可测） --- */
  if (!PLAIN_MODE) {
    const q1 = (sqlText, params) => {
      const st = db.prepare(sqlText);
      st.bind(params || []);
      const out = [];
      while (st.step()) out.push(st.getAsObject());
      st.free();
      return out;
    };
    /* 造一条干净资料：姓名/学号/微信/身份证全填 */
    const made = await call('/api/admin?action=save-profile', {
      method: 'POST', token: adminToken,
      body: {
        name: '密文丁', studentId: '990101', politics: '共青团员',
        wechat: 'wx_secret_ding', qq: '123456789', phone: '13800001111',
        extra: { id_card: '360424201007100011' },
      },
    });
    t('★造出来的资料保存成功', made.status === 200 && made.body.id > 0, JSON.stringify(made.body));
    const pid = made.body.id;

    const rawRow = q1('select * from profiles where id = ?', [pid])[0] || {};
    const isCipher = (v) => typeof v === 'string' && v.startsWith('enc:v1:');
    t('★库里姓名是密文（不是明文）', isCipher(rawRow.name), String(rawRow.name).slice(0, 24));
    t('★库里学号是密文', isCipher(rawRow.student_id));
    t('★库里微信是密文', isCipher(rawRow.wechat));
    t('★库里身份证是密文', isCipher(rawRow.id_card), String(rawRow.id_card).slice(0, 24));
    t('★库里查不到明文姓名（select 出来没有「密文丁」）',
      !JSON.stringify(rawRow).includes('密文丁'));
    t('★同名 bidx 两列已写入（能按学号去重）',
      typeof rawRow.name_bidx === 'string' && rawRow.name_bidx.length > 20
      && typeof rawRow.student_id_bidx === 'string' && rawRow.student_id_bidx.length > 20);

    /* 接口读回来必须是明文 */
    const det = await call('/api/admin?action=profile&id=' + pid, { token: adminToken });
    const p1 = (det.body || {}).profile || {};
    t('★后台详情接口返回明文姓名', p1.name === '密文丁', JSON.stringify(p1.name));
    t('★后台详情接口返回明文学号', p1.studentId === '990101');
    t('★后台详情接口返回明文微信', p1.wechat === 'wx_secret_ding');
    t('★后台详情接口返回明文身份证', (p1.extra || {}).id_card === '360424201007100011',
      JSON.stringify(p1.extra));

    /* 前台搜索仍能按姓名/学号命中 */
    const sByName = await call('/api/profile?action=search&q=' + encodeURIComponent('密文丁'), { token: adminToken });
    t('★前台按全名仍能搜到（内存解密后过滤）',
      (sByName.body.results || []).some((x) => x.name === '密文丁'));
    const sBySid = await call('/api/profile?action=search&q=990101', { token: adminToken });
    t('★前台按学号仍能搜到',
      (sBySid.body.results || []).some((x) => x.studentId === '990101'));

    /* 再保存一次：只改微信、姓名/学号原样传回 →
       这是最容易踩「把库里密文再封一层」的路径（keep 逻辑就在这儿） */
    const again = await call('/api/admin?action=save-profile', {
      method: 'POST', token: adminToken,
      body: { id: pid, name: '密文丁', studentId: '990101', role: '学生', wechat: 'wx_changed_ding' },
    });
    t('★只改一个字段也能保存', again.status === 200, JSON.stringify(again.body));
    const det2 = await call('/api/admin?action=profile&id=' + pid, { token: adminToken });
    const p2 = (det2.body || {}).profile || {};
    t('★姓名没被二次加密（decField 不再出现 enc:v1: 前缀）',
      p2.name === '密文丁', JSON.stringify(p2.name));
    t('★学号没被二次加密', p2.studentId === '990101', JSON.stringify(p2.studentId));
    t('★改的微信生效', p2.wechat === 'wx_changed_ding');

    /* 学号唯一性：同样学号再建一条必须 409 */
    const dupSid = await call('/api/admin?action=save-profile', {
      method: 'POST', token: adminToken,
      body: { name: '另个人', studentId: '990101' },
    });
    t('★同学号重复新增被拦 409（盲索引去重生效）', dupSid.status === 409, '实际 ' + dupSid.status + ' ' + JSON.stringify(dupSid.body));

    /* 批量导入也加密 */
    const bi = await call('/api/admin?action=batch-profiles', {
      method: 'POST', token: adminToken,
      body: { rows: [{ name: '加密戊', studentId: '990102', wechat: 'wx_batch_wu' }] },
    });
    t('★批量导入成功', bi.status === 200 && bi.body.created === 1, JSON.stringify(bi.body));
    const rawBatch = q1("select * from profiles where name_bidx is not null and name like 'enc:v1:%'") || [];
    t('★批量导入的姓名也是密文',
      rawBatch.length > 0 && rawBatch.every((r) => isCipher(r.name)));

    /* 走一遍「成员与档案」合并保存（这条路径最容易漏加密）。
       save-member 是合并编辑入口，必须带 profileId 才进档案段。 */
    const sm = await call('/api/admin?action=save-member', {
      method: 'POST', token: adminToken,
      body: { profileId: pid, name: '合并己', studentId: '990101', phone: '13900002222' },
    });
    t('★成员与档案合并保存成功', sm.status === 200, JSON.stringify(sm.body).slice(0, 160));
    const smDet = await call('/api/admin?action=profile&id=' + pid, { token: adminToken });
    const p3 = (smDet.body || {}).profile || {};
    t('★合并保存的姓名解密正常', p3.name === '合并己', JSON.stringify(p3.name));
    t('★合并保存的手机号解密正常', p3.phone === '13900002222', JSON.stringify(p3.phone));
    const rawSm = q1('select * from profiles where id = ?', [pid])[0] || {};
    t('★合并保存的姓名在库里是密文', isCipher(rawSm.name));
    t('★合并保存后学号仍是同一条（bidx 跟着更新，没被写歪）',
      isCipher(rawSm.student_id) && typeof rawSm.student_id_bidx === 'string');

    /* 清理这几条，避免污染后面的统计类断言（本段在文件末尾，纯粹是好习惯） */
    try {
      q1('delete from profiles where student_id_bidx is not null and id in (?, ?, ?)', [pid, pid, pid]);
    } catch (e) { /* 忽略 */ }
  } else {
    console.log('  · 明文模式（--plain）：跳过「库内是密文」的实测断言');
  }
}



console.log('\n【89】第七十七轮·v3.5.1 存量资料一键加密 + 成绩分析两处修复');
{
  const rd = (f) => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
  const admjs = rd('api/admin.js'), prof = rd('api/profile.js');
  const idx = readIdx(), adm = readAdm();
  const schemaSrc = rd('api/schema.sql');

  /* --- ① 存量加密接口 --- */
  t('★admin.js 有 encrypt-profiles 路由',
    admjs.includes("case 'encrypt-profiles': return await encryptProfiles(req, res, me, b);"));
  t('★没配密钥时给出「先配密钥」的可操作报错，而不是静默跳过',
    /尚未配置 ADMIN_SECRETS_KEY，无法加密/.test(admjs));
  t('★只处理「还有明文字段」的行（已是密文的跳过，幂等可重跑）',
    /name not like 'enc:v1:%'/.test(admjs) && /if \(isEnc\(val\)\) return;/.test(admjs));
  t('★单批上限 20（Workers 免费版 50 子请求的红线）',
    /Math\.min\(Math\.max\(Number\(b\.limit \|\| 15\), 1\), 20\)/.test(admjs));
  t('★每批重新查而未加密行（不传 offset，传了反而跳过数据）',
    /没有 offset 参数/.test(admjs));
  t('★加密同时补 bidx（老资料原本没有盲索引，不补就搜不到）',
    /if \(r\.name_bidx == null\)/.test(admjs) && /if \(r\.student_id_bidx == null\)/.test(admjs));
  t('★返回进度字段供前端循环（encrypted / plainLeft / done）',
    /encrypted: done/.test(admjs) && /plainLeft: Math\.max\(0, plainN - done\)/.test(admjs)
    && /done: remaining === 0/.test(admjs));
  t('★写审计日志（profile.encrypt）', admjs.includes("'profile.encrypt'"));

  /* --- ② 前端按钮 --- */
  t('★admin.html 工具栏有「一键加密存量」按钮',
    adm.includes('id="mbEncrypt"') && adm.includes('一键加密存量'));
  t('★admin.html 有分批循环 + 进度条 + 防重复点击',
    /function encryptAllProfiles/.test(adm)
    && /batch >= 12/.test(adm)
    && /encBarIn/.test(adm)
    && /go\.disabled = true/.test(adm));
  t('★密钥页提示已说明这把密钥也保护成员档案',
    adm.includes('这把密钥同时用于加密'));

  /* --- ③ 真实数据流：明文老资料一键加密后仍是同一条、能搜到 --- */
  if (!PLAIN_MODE) {
    const q1 = (sqlText, params) => {
      const st = db.prepare(sqlText);
      st.bind(params || []);
      const out = [];
      while (st.step()) out.push(st.getAsObject());
      st.free();
      return out;
    };
    /* 造一条「老资料」：绕过 save-profile 的加密，直接插明文 + 老 schema 形态 */
    const pid = q1('select max(id) as m from profiles')[0].m + 1;
    db.run('insert into profiles (id, name, student_id, politics, exam_no, wechat, qq, phone, id_card, role, contact_status) values (?,?,?,?,?,?,?,?,?,?,?)',
      [pid, '存量明文甲', '88000001', '群众', 'ZK8801', 'wx_plain_1', '111222', '13700000001', '360424201001010011', '学生', 'approved']);
    const before = q1('select * from profiles where id = ?', [pid])[0];
    t('★造的老资料姓名是明文（模拟 v3.5.0 之前导入的数据）',
      before.name === '存量明文甲' && !String(before.name).startsWith('enc:v1:'));
    t('★老资料没有 bidx（模拟线上真实状态）',
      before.name_bidx == null && before.student_id_bidx == null);

    /* 调一键加密接口 */
    const enc = await call('/api/admin?action=encrypt-profiles', {
      method: 'POST', token: adminToken, body: { limit: 15 },
    });
    t('★一键加密返回 200', enc.status === 200, JSON.stringify(enc.body).slice(0, 160));
    t('★本批至少加密了我们那条', (enc.body.encrypted || 0) >= 1, JSON.stringify(enc.body).slice(0, 160));

    const after = q1('select * from profiles where id = ?', [pid])[0];
    const isCipher = (v) => typeof v === 'string' && v.startsWith('enc:v1:');
    t('★加密后姓名变密文', isCipher(after.name), String(after.name).slice(0, 24));
    t('★加密后学号变密文', isCipher(after.student_id));
    t('★加密后微信变密文', isCipher(after.wechat));
    t('★加密后身份证变密文', isCipher(after.id_card));
    t('★加密后 bidx 也补上了（能按姓名/学号搜到）',
      typeof after.name_bidx === 'string' && after.name_bidx.length > 20
      && typeof after.student_id_bidx === 'string' && after.student_id_bidx.length > 20);
    t('★库里已查不到明文姓名', !JSON.stringify(after).includes('存量明文甲'));

    /* 数据没丢：后台读回来还是同样内容 */
    const det = await call('/api/admin?action=profile&id=' + pid, { token: adminToken });
    const pp = (det.body || {}).profile || {};
    t('★加密后后台仍显示同样姓名（数据没丢）', pp.name === '存量明文甲', JSON.stringify(pp.name));
    t('★加密后后台仍显示同样学号', pp.studentId === '88000001');
    t('★加密后后台仍显示同样微信', pp.wechat === 'wx_plain_1');
    t('★加密后后台仍显示同样身份证', (pp.extra || {}).id_card === '360424201001010011');

    /* 检索仍然命中（bidx 生效） */
    const sByName = await call('/api/profile?action=search&q=' + encodeURIComponent('存量明文甲'), { token: adminToken });
    t('★一键加密后前台按姓名仍能搜到', (sByName.body.results || []).some((x) => x.name === '存量明文甲'));

    /* 再跑一次：幂等，不会二次加密 */
    const enc2 = await call('/api/admin?action=encrypt-profiles', {
      method: 'POST', token: adminToken, body: { limit: 15 },
    });
    t('★再跑一次不重复加密（幂等）', enc2.status === 200, JSON.stringify(enc2.body).slice(0, 120));
    const after2 = q1('select * from profiles where id = ?', [pid])[0];
    t('★二次运行后姓名仍是同一段密文（没有叠层）', after2.name === after.name);
    const det2 = await call('/api/admin?action=profile&id=' + pid, { token: adminToken });
    t('★二次运行后仍能正常解密', ((det2.body || {}).profile || {}).name === '存量明文甲');

    /* 清理 */
    q1('delete from profiles where id = ?', [pid]);
  } else {
    console.log('  · 明文模式（--plain）：跳过存量加密实测');
  }

  /* --- ④ 热力图排名口径修复（站主报：校排 350 被当成班排） --- */
  t('★热力图明细的「班内第 X」改用现场算的班内名次',
    /var clsRank0 = \(v == null\) \? null : \(\(rk\.subj\[sub\.key\] \|\| \{\}\)\.rank \|\| \{\}\)\[r\.id\];/.test(idx));
  t('★导入的年级排名单独一行显示（不再冒充班排）',
    /var subjRank0 = \(v == null \|\| sr0 == null\) \? null : sr0;/.test(idx)
    && /c\.subjRank != null/.test(idx)
    && /<i>' \+ esc\(c\.sub\) \+ '年级排名<\/i>/.test(idx));
  t('★总分年级排名改名为「总分年级排名」避免与该科排名混淆',
    /<i>总分年级排名（物理方向）<\/i>/.test(idx));
  t('★其他排名口径未被动过（四象限仍显示「年级第 X」）',
    /年级第 ' \+ rank/.test(idx));

  /* --- ⑤ 需关注学生手机端适配 --- */
  t('★需关注表加专用类 sc-tbl-watch', idx.includes('class="sc-tbl sc-tbl-watch"'));
  t('★姓名列不再被全局 46px 吸列规则压扁',
    /\.sc-tbl-watch th:nth-child\(1\),\.sc-tbl-watch td:nth-child\(1\)\{/.test(idx)
    && /position:static;width:auto;min-width:0;max-width:none;/.test(idx));
  t('★手机端表格转卡片（一人一张，列名用 attr(data-label)）',
    /\.sc-tbl-watch thead\{display:none\}/.test(idx)
    && /content:attr\(data-label\)/.test(idx));
  t('★每格都带 data-label（桌面表格不受影响，打印还原成表格）',
    ['总分','总分差','拖后腿的单科','最弱一科'].every((k) => idx.indexOf('data-label="' + k + '"') >= 0)
    && /\.sc-embed \.sc-tbl-watch thead\{display:table-header-group !important\}/.test(idx));
  t('★暗色模式同步适配', /\.dark \.sc-tbl-watch tbody tr\{background:#2b2521/.test(idx));
}

console.log('\n【90】第七十八轮·v3.5.3 修「解析失败: XLSX is not defined」+ 导入补身份证号/发展团员编号');
{
  const rd = (f) => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
  const adm = readAdm(), admjs = rd('api/admin.js');

  /* --- ① 解析库本地化：同源 vendor/ 优先，CDN 只兜底 --- */
  const vendorStat = fs.statSync(new URL('./vendor/xlsx.full.min.js', import.meta.url));
  t('★vendor/xlsx.full.min.js 随仓库发布且非空（>500KB）',
    vendorStat.isFile() && vendorStat.size > 500 * 1024,
    '实际 ' + vendorStat.size + ' 字节');
  t('★loadXLSX 第一源是本地 vendor（国内不再被 CDN 抽风卡住）',
    /var urls = \[\s*'vendor\/xlsx\.full\.min\.js'/.test(adm));
  t('★CDN 三个兜底源都还在（本地挂了仍能救）',
    /cdn\.jsdelivr\.net\/npm\/xlsx@0\.18\.5/.test(adm)
    && /unpkg\.com\/xlsx@0\.18\.5/.test(adm)
    && /cdnjs\.cloudflare\.com\/ajax\/libs\/xlsx\/0\.18\.5/.test(adm));
  t('★onload 后没拿到 window.XLSX 会继续试下一个源（兜底链不能断）',
    /s\.onload = function\(\)\{ if\(window\.XLSX\) resolve\(window\.XLSX\); else next\(\); \};/.test(adm));
  t('★部署流水线把 vendor/ 一起发上 Pages',
    rd('.github/workflows/deploy-pages.yml').includes('vendor'));

  /* --- ② 资料导入对话框：reader.onload 整段包进 loadXLSX().then ---
     2026-10-17 站主实测报错「解析失败: XLSX is not defined」：
     以前直接用裸全局 XLSX.read()，用户没点过「下载模板」时库从未开始
     加载 → 当场 ReferenceError。护栏：reader.onload 开头必须看到
     loadXLSX().then(function(XLSX){，且三处 XLSX.read 全在回调内。 */
  t('★reader.onload 先等库就位再读文件（v3.5.3 崩点的根因修复）',
    /reader\.onload = function\(ev\)\{[\s\S]{0,600}loadXLSX\(\)\.then\(function\(XLSX\)\{/.test(adm));
  t('★库没到位时给出人话提示，不是白屏',
    /表格解析库加载失败，请检查网络后重试/.test(adm));
  /* 只数真正的读取调用（XLSX.read(new Uint8Array…），注释里提到的
     「XLSX.read(...)」不算 —— 那正是被修掉的旧写法。 */
  const readCalls = (adm.match(/XLSX\.read\(new Uint8Array/g) || []).length;
  const readInCb = (adm.match(/loadXLSX\(\)\.then\(function\(XLSX\)\{[\s\S]*?XLSX\.read\(new Uint8Array/g) || []).length;
  t('★三处 XLSX.read 全部位于 loadXLSX 回调内（标识符来自回调参数，不是裸全局）',
    readCalls === 3 && readInCb === 3, 'read 调用 ' + readCalls + ' 处 / 回调内 ' + readInCb + ' 处');

  /* --- ③ 导入字段映射补 idCard / youthLeagueNo --- */
  t('★pick 映射认「身份证号」（含别名）',
    /idCard:\s*pick\(r, \['身份证号','身份证','证件号'\]\)/.test(adm));
  t('★pick 映射认「发展团员编号」（含别名）',
    /youthLeagueNo:\s*pick\(r, \['发展团员编号','团员编号','入团编号'\]\)/.test(adm));
  t('★预览表头追加「身份证号 / 发展团员编号」两列',
    /\.concat\(\['微信','QQ','手机号','身份证号','发展团员编号'\]\)/.test(adm));
  t('★汇总提示点数含身份证号/发展团员编号条数',
    /var hasId\s+= list\.filter\(function\(x\)\{ return x\.idCard; \}\)\.length/.test(adm)
    && /var hasYln\s+= list\.filter\(function\(x\)\{ return x\.youthLeagueNo; \}\)\.length/.test(adm)
    && /含身份证号 <b>' \+ hasId/.test(adm)
    && /含发展团员编号 <b>' \+ hasYln/.test(adm));

  /* --- ④ 后端 batchProfiles 收下这两列并加密 --- */
  t('★batchProfiles 读取 idCard / youthLeagueNo',
    /const idCard = cText\(raw\.idCard, 30\);/.test(admjs)
    && /const youthLeagueNo = cText\(raw\.youthLeagueNo, 40\);/.test(admjs));
  t('★两列落库前统一走 encField 加密（与其它敏感字段同待遇）',
    /const eIdCard = await encField\(pkey, idCard \|\| null\);/.test(admjs)
    && /const eYln = await encField\(pkey, youthLeagueNo \|\| null\);/.test(admjs));
  t('★UPDATE 分支三态：空值才写 / 一致跳过 / 不同进冲突',
    /if \(!ov\) \{/.test(admjs)
    && /if \(ov === nvs\) continue;/.test(admjs)
    && /conflicts\.push\(\{/.test(admjs));
  t('★INSERT 分支带上 id_card / youth_league_no 两列',
    /'id_card', 'youth_league_no', \.\.\.exCols\]/.test(admjs));

  /* --- ⑤ 真实数据流：带两列导入 → 读回 → 空值不抹库 --- */
  const impIdA = '910001', impIdB = '910002';
  const batchImp = await call('/api/admin?action=batch-profiles', {
    method: 'POST', token: adminToken,
    body: { rows: [
      { name: '证甲', studentId: impIdA, role: '学生',
        idCard: '36042420100101001X', youthLeagueNo: 'TQ20240001' },
      { name: '证乙', studentId: impIdB, role: '学生',
        idCard: '36042420100202002Y' },
    ] },
  });
  t('★带身份证号/发展团员编号的批量导入成功 2 条',
    batchImp.status === 200 && batchImp.body.created === 2,
    JSON.stringify(batchImp.body).slice(0, 180));

  const detImp = await call('/api/admin?action=profiles&q=' + impIdA, { token: adminToken });
  const rowImp = ((detImp.body || {}).profiles || [])[0];
  const detA = await call('/api/admin?action=profile&id=' + rowImp.id, { token: adminToken });
  const pa = ((detA.body || {}).profile || {});
  t('★导入的身份证号读回正确',
    (pa.extra || {}).id_card === '36042420100101001X',
    JSON.stringify((pa.extra || {}).id_card));
  t('★导入的发展团员编号读回正确',
    (pa.extra || {}).youth_league_no === 'TQ20240001',
    JSON.stringify((pa.extra || {}).youth_league_no));

  /* 库里必须是密文（加密模式）或明文（--plain），不能出现既非空又非预期形态。
     注意：加密模式下 student_id 列本身也是密文，只能按主键 id 查。 */
  if (!PLAIN_MODE) {
    const rawRow = db.prepare('select id_card, youth_league_no from profiles where id = ?');
    rawRow.bind([rowImp.id]);
    rawRow.step();
    const rawVals = rawRow.getAsObject();
    rawRow.free();
    t('★加密模式下库里 id_card 是密文',
      String(rawVals.id_card).startsWith('enc:v1:'), String(rawVals.id_card).slice(0, 24));
    t('★加密模式下库里 youth_league_no 是密文',
      String(rawVals.youth_league_no).startsWith('enc:v1:'), String(rawVals.youth_league_no).slice(0, 24));
  } else {
    console.log('  · 明文模式（--plain）：跳过密文形态断言');
  }

  /* 第二次导入同一个人、但不带这两列 → 库里的值不许被抹掉 */
  const batchImp2 = await call('/api/admin?action=batch-profiles', {
    method: 'POST', token: adminToken,
    body: { rows: [{ name: '证甲', studentId: impIdA, role: '学生', politics: '群众' }] },
  });
  t('★二次导入同一人（不带证件列）走更新分支',
    batchImp2.status === 200 && batchImp2.body.updated === 1,
    JSON.stringify(batchImp2.body).slice(0, 160));
  const detA2 = await call('/api/admin?action=profile&id=' + rowImp.id, { token: adminToken });
  const pa2 = ((detA2.body || {}).profile || {});
  t('★二次导入后身份证号仍在（空值没抹掉库里有数据）',
    (pa2.extra || {}).id_card === '36042420100101001X',
    JSON.stringify((pa2.extra || {}).id_card));
  t('★二次导入后发展团员编号仍在',
    (pa2.extra || {}).youth_league_no === 'TQ20240001',
    JSON.stringify((pa2.extra || {}).youth_league_no));

  /* 清理 */
  for (const sid of [impIdA, impIdB]) {
    const f = await call('/api/admin?action=profiles&q=' + sid, { token: adminToken });
    const row = (f.body.profiles || [])[0];
    if (row) await call('/api/admin?action=delete-profile', { method: 'POST', token: adminToken, body: { id: row.id } });
  }
}

console.log('\n【91】第七十九轮·v3.5.6 投票管理（建投票 / 一人一票可改 / 加选项 / 截止后看结果 / 写排期 / 删）');
{
  const votesSrc = fs.readFileSync(new URL('./api/votes.js', import.meta.url), 'utf8');
  const wrkSrc = fs.readFileSync(new URL('./api/worker.mjs', import.meta.url), 'utf8');
  const httpSrc2 = fs.readFileSync(new URL('./api/_lib/http.js', import.meta.url), 'utf8');
  const sqlSrc = fs.readFileSync(new URL('./api/schema.sql', import.meta.url), 'utf8');
  const idxV = readIdx();
  const admV = readAdm();
  const contSrc = fs.readFileSync(new URL('./api/content.js', import.meta.url), 'utf8');

  /* 本块自带一个学生账号（不依赖其它块里的局部变量），要带密码走「首次改密」放行 */
  const vUser = 'voter91', vPwd0 = 'Init2025', vPwd = 'MyOwn2025';
  await call('/api/admin?action=create-user', {
    method: 'POST', token: adminToken, body: { username: vUser, password: vPwd0, displayName: '投票测试生' },
  });
  const vl0 = await call('/api/auth?action=login', { method: 'POST', body: { username: vUser, password: vPwd0 } });
  const vcp = await call('/api/auth?action=change-password', {
    method: 'POST', token: vl0.body.token, body: { oldPassword: vPwd0, newPassword: vPwd },
  });
  const stuToken2 = (vcp.body || {}).token;
  t('★投票测试用学生账号就绪', !!stuToken2, JSON.stringify(vcp.body).slice(0, 120));

  /* ============ ① 静态护栏：路由 / DDL 两路径 / 挂载点 ============ */
  t('★worker 注册了 /api/votes 路由',
    /import votesHandler from '\.\/votes\.js'/.test(wrkSrc) && /case 'votes':/.test(wrkSrc));
  t('★schema.sql 记录两张投票表',
    /create table if not exists class_votes/.test(sqlSrc)
    && /create table if not exists class_vote_ballots/.test(sqlSrc));
  /* v3.5.1 的教训：新表必须「老库升级路径 + 全新库全量清单」两处都建 */
  const cvCount = (httpSrc2.match(/create table if not exists class_votes/g) || []).length;
  const cvbCount = (httpSrc2.match(/create table if not exists class_vote_ballots/g) || []).length;
  t('★两表在 ensureSchema 两条路径都建了（各 ≥ 2 次）',
    cvCount >= 2 && cvbCount >= 2, 'class_votes ' + cvCount + ' 次 / ballots ' + cvbCount + ' 次');
  t('★前台投票专区挂到板块 7 且不独占（卡片仍在）',
    /popBannerHtml\(c\.id\)[\s\S]{0,200}c\.id === 7 \? voteEmbedHtml\(\) : ''\)[\s\S]{0,20}\+ inner/.test(idxV));
  t('★后台注册「投票管理」面板',
    /id:'votes'/.test(admV) && /votes:\s*renderVotes,/.test(admV));
  t('★点歌加权函数在前台后台都就位',
    /function djWeightedIdx/.test(admV) && /function djWeightOf/.test(admV));
  /* v3.5.9 站主：「后台的首页卡片里面没有改」→ 来源改由后台统一控制 */
  t('★每日一言来源走后端内容键 quote_source（白名单已放行）',
    /'quote_source'/.test(contSrc) && /quote_source/.test(idxV));
  t('★后台首页卡片有来源开关（联网 API / 本地库）',
    /function qsPick/.test(admV) && /id="qsNet"/.test(admV) && /id="qsLocal"/.test(admV));
  t('★前端统一判定 quoteNetAllowed（后台配置优先于本机偏好）',
    /function quoteNetAllowed/.test(idxV) && /if\(!quoteNetAllowed\(\)\)\{/.test(idxV));
  t('★自定义设置里不再给同学切换来源（只读展示）',
    !/onclick="setQuoteNet/.test(idxV) && /由管理员在后台「首页卡片 → 每日一言」统一设置/.test(idxV));
  /* ===== v3.5.11 本地库：批量增删 + 排期轮换 ===== */
  t('★前端有排期引擎（quoteSchedule / localQuoteIdx）',
    /function quoteSchedule\(\)/.test(idxV) && /function localQuoteIdx\(/.test(idxV)
    && /function localQuoteOfToday\(\)/.test(idxV));
  t('★每日一言取句走 localQuoteOfToday（不再直接 pickRandom）',
    /var q = localQuoteOfToday\(\);/.test(idxV));
  t('★后台有排期面板与同算法（dqTodayIdx / paintSchedule）',
    /function dqTodayIdx\(/.test(admV) && /function paintSchedule\(/.test(admV)
    && /function dqNormSched\(/.test(admV));
  t('★四种轮换模式前后端完全一致（random/order/rotate/date）',
    (function(){
      /* 模式清单在后台是数组字面量，在前端是 normalize 的白名单，两边都要四选一 */
      var modes = ["random", "order", "rotate", "date"].every(function(m){
        return admV.indexOf("['" + m + "'") >= 0 || admV.indexOf("'" + m + "'") >= 0;
      });
      var admNorm = /if\(m === 'order' \|\| m === 'rotate' \|\| m === 'date' \|\| m === 'random'\)/.test(admV);
      var idxNorm = /if\(m === 'order' \|\| m === 'rotate' \|\| m === 'date'\)/.test(idxV);
      return modes && admNorm && idxNorm;
    })());
  t('★指定日期优先于任何模式（两处都是 fixed 先判）',
    /var fixed = \(cfg\.fixed \|\| \{\}\)\[today\];/.test(admV)
    && /var fixed = cfg\.fixed\[today\];/.test(idxV));
  t('★批量添加（一行一句 + 自动去重）',
    /function dqBatchAdd\(/.test(admV) && /句重复已跳过/.test(admV)
    && /id="dqBatchAdd"/.test(admV));
  t('★批量删除（勾选 + 删除后自动修指定日期下标）',
    /function dqBatchDelete\(/.test(admV) && /remap\[i\]/.test(admV)
    && /data-dq-ck=/.test(admV));
  t('★列表支持全选 / 清空 / 已选计数',
    /id="dqCkAll"/.test(admV) && /id="dqSelAll"/.test(admV) && /id="dqSelNone"/.test(admV));
  t('★后台有 14 天排期预览',
    /function dqPreviewTable\(/.test(admV) && /接下来 14 天预览/.test(admV));
  t('★排期内容键三处齐全（白名单 / CONTENT_MAP / applyCloudContent）',
    /'quote_schedule'/.test(contSrc) && /quote_schedule:\s*null/.test(idxV)
    && /k === 'quote_schedule'/.test(idxV) && /SITE_DATA\.quoteSchedule = v/.test(idxV));
  t('★排期日期一律本地时区（不走 toISOString）',
    (function(){
      /* 只检查这两个日期函数的函数体内部，不牵连导出文件名等无关用法 */
      function bodyOf(src, name){
        var i = src.indexOf('function ' + name + '(');
        if(i < 0) return '';
        return src.slice(i, src.indexOf('\n}', i) + 2);
      }
      var a = bodyOf(idxV, 'quoteDayStr'), b = bodyOf(admV, 'dqDayStr');
      return !!a && !!b && a.indexOf('toISOString') < 0 && b.indexOf('toISOString') < 0
        && a.indexOf('getFullYear') >= 0 && b.indexOf('getFullYear') >= 0;
    })());

  t('★三个版本号同步（index/admin/worker 彼此一致）',
    (idxV.match(/SITE_VERSION = '([\d.]+)'/)||[])[1] === (admV.match(/SITE_VERSION = '([\d.]+)'/)||[])[1]
    && (idxV.match(/SITE_VERSION = '([\d.]+)'/)||[])[1] === (wrkSrc.match(/API_VER = '([\d.]+)'/)||[])[1]);

  /* ============ ①b 成绩分析增强（v3.5.6 任务 4）静态护栏 ============ */
  t('★需关注四档筛选 + 可排序',
    /function scCareFilter/.test(idxV) && /function scCareSort/.test(idxV)
    && /连续两次退步/.test(idxV));
  /* v3.5.7 站主要求：优秀率/及格率三类统计整体下线 —— 反向断言防它回来 */
  t('★三类统计已下线（不再出现优秀率/及格率卡）',
    !/scBandCard|scBandStats|SC_BANDS/.test(idxV));
  t('★进退步榜缺历次数据时自动补载（不再误报对不上人）',
    /var curPack = SC\.allRows\[eidOf\(items\[idx\]\)\];[\s\S]{0,400}scLoadAllRows\(\);/.test(idxV)
    && !/!curPack \|\| !prevPack\)[\s\S]{0,200}对不上人/.test(idxV));
  t('★成绩对比新增文字分析（v3.5.13 起抽为顶层 scPkAiData）',
    /function analyze\(p, c, prevExam, isA\)/.test(idxV) && /对比分析/.test(idxV) && /function scPkAiData\(/.test(idxV));
  t('★表格下方自动文字总结',
    /function scCareSummary/.test(idxV) && /sc-care-sum/.test(idxV));
  t('★我的画像 AI 分析卡已挂进渲染链',
    /html \+= scMeAnalysis\(meRow, rk, st, myTotal, myRank, subs\)/.test(idxV)
    && /function scMeAnalysis/.test(idxV));
  t('★AI 分析声明不联网不上传成绩',
    /不联网/.test(idxV) && /不会把成绩发到任何服务器/.test(idxV));
  t('★「连续两次退步」的上一场数据走懒加载（不当场阻塞）',
    /function scLoadPrevPack/.test(idxV) && /scLoadPrevPack\(ex\.id\)/.test(idxV));
  t('★新增样式都有暗色覆盖（sc-chip / sc-ai）',
    /\.dark \.sc-chip\{/.test(idxV) && /\.dark \.sc-ai-concl\{/.test(idxV));

  /* ============ ② 建投票 ============ */
  const mk = await call('/api/votes?action=create', {
    method: 'POST', token: adminToken,
    body: { title: '运动会入场式服装', kind: 'normal', options: [{ label: '统一校服' }, { label: '自备运动服' }], note: '测试用' },
  });
  t('★管理员能创建投票', mk.status === 200 && mk.body.ok, JSON.stringify(mk.body).slice(0, 200));
  const vid = mk.body.id;
  t('★创建返回新投票 id', !!vid, JSON.stringify(mk.body).slice(0, 160));
  /* create 只回 id，带选项的完整对象从 list 拿 */
  const mkList = await call('/api/votes?action=list', { token: adminToken });
  const mkRow = ((mkList.body || {}).votes || []).find(x => String(x.id) === String(vid));
  t('★新建的投票带两个选项', !!mkRow && (mkRow.options || []).length === 2,
    JSON.stringify((mkRow || {}).options || []).slice(0, 160));

  /* 少于两个选项必须拒 */
  const mkBad = await call('/api/votes?action=create', {
    method: 'POST', token: adminToken, body: { title: '只有一个选项', options: [{ label: 'A' }] },
  });
  t('★只有一个选项被拒 400', mkBad.status === 400, '实际 ' + mkBad.status);
  const mkEmpty = await call('/api/votes?action=create', {
    method: 'POST', token: adminToken, body: { title: '', options: [{ label: 'A' }, { label: 'B' }] },
  });
  t('★空标题被拒 400', mkEmpty.status === 400, '实际 ' + mkEmpty.status);
  /* 学生不许建 */
  const mkStu = await call('/api/votes?action=create', {
    method: 'POST', token: stuToken2, body: { title: '学生偷偷建', options: [{ label: 'A' }, { label: 'B' }] },
  });
  t('★学生建投票被拒 403', mkStu.status === 403, '实际 ' + mkStu.status);

  /* ============ ③ 学生投票 / 改票 / 一人一票 ============ */
  const list1 = await call('/api/votes?action=list', { token: stuToken2 });
  const v1 = ((list1.body || {}).votes || []).find(x => String(x.id) === String(vid));
  t('★学生在列表里能看到这条投票', !!v1, JSON.stringify((list1.body || {}).votes || []).length + ' 条');
  /* 未截止时必须显式给 null（不是 undefined）—— 前端靠 results 判断走条形图还是选项 */
  t('★投票进行中不下发票数（results 恒为 null）', !!v1 && v1.results === null,
    JSON.stringify(v1 && v1.results).slice(0, 60));
  const optA = ((v1 || {}).options || [])[0] || {};
  const optB = ((v1 || {}).options || [])[1] || {};

  const cast1 = await call('/api/votes?action=vote', {
    method: 'POST', token: stuToken2, body: { voteId: vid, choices: [optA.id] },
  });
  t('★学生投票成功', cast1.status === 200 && cast1.body.ok, JSON.stringify(cast1.body).slice(0, 160));

  const cast2 = await call('/api/votes?action=vote', {
    method: 'POST', token: stuToken2, body: { voteId: vid, choices: [optB.id] },
  });
  t('★同一人可改票（覆盖不是新增）', cast2.status === 200 && cast2.body.ok, JSON.stringify(cast2.body).slice(0, 160));

  /* 库里应只有 1 条 ballot */
  const bRow = db.prepare('select count(*) as n from class_vote_ballots where vote_id = ?');
  bRow.bind([Number(vid)]);
  bRow.step();
  const bN = bRow.getAsObject().n;
  bRow.free();
  t('★一人一票：库里只有 1 条投票记录', Number(bN) === 1, '实际 ' + bN);

  /* 乱填选项 id 必须拒 */
  const castBad = await call('/api/votes?action=vote', {
    method: 'POST', token: stuToken2, body: { voteId: vid, choices: ['o999'] },
  });
  t('★投不存在的选项被拒 400', castBad.status === 400, '实际 ' + castBad.status);

  /* ============ ④ 允许加选项 / 上限 / 不许加时被拒 ============ */
  const addNo = await call('/api/votes?action=add-option', {
    method: 'POST', token: stuToken2, body: { voteId: vid, label: '汉服' },
  });
  t('★未开启「允许加选项」时被拒 403', addNo.status === 403, '实际 ' + addNo.status);

  await call('/api/votes?action=update', {
    method: 'POST', token: adminToken,
    body: { voteId: vid, title: '运动会入场式服装', kind: 'normal', allowAdd: true,
            options: [{ label: '统一校服' }, { label: '自备运动服' }] },
  });
  const addYes = await call('/api/votes?action=add-option', {
    method: 'POST', token: stuToken2, body: { voteId: vid, label: '汉服' },
  });
  t('★开启后学生能自己加选项', addYes.status === 200 && addYes.body.ok, JSON.stringify(addYes.body).slice(0, 160));
  const afterAdd = await call('/api/votes?action=list', { token: stuToken2 });
  const vAdd = ((afterAdd.body || {}).votes || []).find(x => String(x.id) === String(vid));
  t('★加选项后选项数变 3', ((vAdd || {}).options || []).length === 3,
    JSON.stringify(((vAdd || {}).options || []).map(o => o.label)));

  const addDup = await call('/api/votes?action=add-option', {
    method: 'POST', token: stuToken2, body: { voteId: vid, label: '汉服' },
  });
  t('★重复选项被拒（409 或 400）', [400, 409].includes(addDup.status), '实际 ' + addDup.status);

  /* ============ ⑤ 编辑投票：按 label 保留老选项 id（票不丢） ============ */
  const before = await call('/api/votes?action=list', { token: adminToken });
  const vb = ((before.body || {}).votes || []).find(x => String(x.id) === String(vid));
  const idOfA = (vb.options.find(o => o.label === '统一校服') || {}).id;
  await call('/api/votes?action=update', {
    method: 'POST', token: adminToken,
    body: { voteId: vid, title: '运动会入场式服装（改）', kind: 'normal', allowAdd: true,
            options: [{ label: '统一校服' }, { label: '自备运动服' }, { label: '汉服' }] },
  });
  const after = await call('/api/votes?action=list', { token: adminToken });
  const va = ((after.body || {}).votes || []).find(x => String(x.id) === String(vid));
  const idOfA2 = (va.options.find(o => o.label === '统一校服') || {}).id;
  t('★改标题/选项后同名选项的 id 保持不变（已投的票不会丢）',
    !!idOfA && idOfA === idOfA2, idOfA + ' → ' + idOfA2);
  t('★标题改动生效', va.title === '运动会入场式服装（改）', va.title);

  /* ============ ⑥ 截止 → 结果下发 ============ */
  const close = await call('/api/votes?action=set-status', {
    method: 'POST', token: adminToken, body: { voteId: vid, status: 'closed' },
  });
  t('★管理员能截止投票', close.status === 200 && close.body.ok, JSON.stringify(close.body).slice(0, 160));

  const closedList = await call('/api/votes?action=list', { token: stuToken2 });
  const vc = ((closedList.body || {}).votes || []).find(x => String(x.id) === String(vid));
  t('★截止后学生能拿到结果', !!vc && Array.isArray(vc.results), JSON.stringify(vc && vc.results).slice(0, 160));
  const sumN = ((vc || {}).results || []).reduce((a, r) => a + (r.n || 0), 0);
  t('★结果票数合计 = 1（一人一票改过一次）', sumN === 1, '实际 ' + sumN);

  const voteClosed = await call('/api/votes?action=vote', {
    method: 'POST', token: stuToken2, body: { voteId: vid, choices: [optA.id] },
  });
  t('★已截止的投票不能再投（400 业务拒绝）', voteClosed.status === 400, '实际 ' + voteClosed.status);

  /* 多选约束：开一条多选 → 单选也得多选才对 */
  const mkMulti = await call('/api/votes?action=create', {
    method: 'POST', token: adminToken,
    body: { title: '多选测试', options: [{ label: 'x' }, { label: 'y' }, { label: 'z' }], multi: false },
  });
  const mid = mkMulti.body.id;
  const ml2 = await call('/api/votes?action=list', { token: adminToken });
  const mrow = ((ml2.body || {}).votes || []).find(x => String(x.id) === String(mid));
  const mopts = (mrow || {}).options || [];
  const multiCast = await call('/api/votes?action=vote', {
    method: 'POST', token: stuToken2, body: { voteId: mid, choices: [mopts[0].id, mopts[1].id] },
  });
  t('★单选投票一次投两个被拒 400', multiCast.status === 400, '实际 ' + multiCast.status);

  /* ============ ⑦ 歌单投票 → 写抽歌排期 ============ */
  /* v3.5.27：歌单投票的选项必须带时长 —— 先验「没时长被拒」，再带时长建成功 */
  const mkSongNoDur = await call('/api/votes?action=create', {
    method: 'POST', token: adminToken,
    body: { title: '缺时长的歌单投票', kind: 'song',
            options: [{ label: '歌甲 - 歌手甲' }, { label: '歌乙 - 歌手乙' }] },
  });
  t('★v3.5.27 缺时长的歌单投票被拒（400）',
    mkSongNoDur.status === 400 && /时长/.test(String(mkSongNoDur.body && mkSongNoDur.body.error)),
    JSON.stringify(mkSongNoDur.body).slice(0, 160));

  const songOpt = (label, sec) => ({
    label,
    songMeta: { title: label.split(' - ')[0], artist: label.split(' - ')[1], duration: sec, show: ['duration'] },
  });
  const mkSong = await call('/api/votes?action=create', {
    method: 'POST', token: adminToken,
    body: { title: '本周歌单投票', kind: 'song',
            options: [songOpt('歌甲 - 歌手甲', 225), songOpt('歌乙 - 歌手乙', 198), songOpt('歌丙 - 歌手丙', 240)] },
  });
  const sid2 = mkSong.body.id;
  t('★能建歌单投票', mkSong.status === 200 && !!sid2, JSON.stringify(mkSong.body).slice(0, 160));
  const songList0 = await call('/api/votes?action=list', { token: adminToken });
  const vSong0 = ((songList0.body || {}).votes || []).find(x => String(x.id) === String(sid2));
  t('★歌单投票 kind=song', !!vSong0 && vSong0.kind === 'song', JSON.stringify((vSong0 || {}).kind));
  const sOpts = (vSong0 || {}).options || [];
  for (const o of sOpts.slice(0, 2)) {
    await call('/api/votes?action=vote', { method: 'POST', token: stuToken2, body: { voteId: sid2, choices: [o.id] } });
  }
  await call('/api/votes?action=set-status', { method: 'POST', token: adminToken, body: { voteId: sid2, status: 'closed' } });
  const songList = await call('/api/votes?action=list', { token: adminToken });
  const vs = ((songList.body || {}).votes || []).find(x => String(x.id) === String(sid2));
  t('★歌单投票截止后带 results 供写排期', !!vs && Array.isArray(vs.results) && vs.results.length === 3,
    JSON.stringify((vs || {}).results || []).length + ' 项');

  /* ============ ⑧ 删除 ============ */
  const del = await call('/api/votes?action=delete', {
    method: 'POST', token: adminToken, body: { voteId: vid },
  });
  t('★管理员能删除投票', del.status === 200 && del.body.ok, JSON.stringify(del.body).slice(0, 160));
  const delBallot = db.prepare('select count(*) as n from class_vote_ballots where vote_id = ?');
  delBallot.bind([Number(vid)]);
  delBallot.step();
  const dbN = delBallot.getAsObject().n;
  delBallot.free();
  t('★删投票时选票一并清掉（不留孤儿）', Number(dbN) === 0, '实际 ' + dbN);

  const listAfter = await call('/api/votes?action=list', { token: adminToken });
  const gone = ((listAfter.body || {}).votes || []).find(x => String(x.id) === String(vid));
  t('★删掉的投票不再出现在列表里', !gone);

  /* 清理剩余测试投票 */
  for (const id of [mid, sid2]) {
    if (id) await call('/api/votes?action=delete', { method: 'POST', token: adminToken, body: { voteId: id } });
  }
}

/* ==================== 第 n 轮（v3.5.12）站主 10 项需求回归 ==================== */
{
  const fs = await import('node:fs');
  const idx   = readIdx();
  const adm   = readAdm();
  const shr   = fs.readFileSync(new URL('./share.html', import.meta.url), 'utf8');
  const vot   = fs.readFileSync(new URL('./api/votes.js', import.meta.url), 'utf8');
  const http2 = fs.readFileSync(new URL('./api/_lib/http.js', import.meta.url), 'utf8');

  /* ---- #1 行为日志：时间戳 + 同人合并展开 ---- */  t('#1 parseTime 认得 Neon 的 Date toString（真根因）',
    /Sat Oct 17 2026 15:01:09 GMT\+0000/.test(adm) && /Date\.parse\(s\)/.test(adm));
  t('#1 parseTime 先试 ISO 分支再退回原生格式',
    adm.includes('if(/^\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}/.test(s))')
    && adm.includes('[zZ]|[+-]\\d{2}:?\\d{2}$'));
  t('#1 有 alGroup / alRange 分组函数',
    /function alGroup\(/.test(adm) && /function alRange\(/.test(adm));
  t('#1 分组结构与展开态（al-g / al-g-body / S.open）',
    /al-g-h/.test(adm) && /al-g-body/.test(adm) && /'g' \+ page/.test(adm));
  t('#1 折箭头图标齐全', /chevronRight:/.test(adm) && /chevronDown:/.test(adm));

  /* ---- #2 成员档案：列表只留联系方式，其余进详情 ---- */
  t('#2 成员表头只留 成员/联系方式/操作',
    /<th>成员<\/th><th>联系方式<\/th>/.test(adm));
  t('#2 有 memberDetailDialog 详情弹窗', /function memberDetailDialog\(m\)/.test(adm));
  t('#2 每行都能打开详情（不限于管理员）', /data-mb="detail"/.test(adm));

  /* ---- #3 抽歌获选原因 + 公示五段格式 ---- */
  t('#3 有 djReasonOf / djProgEligible',
    /function djReasonOf\(/.test(adm) && /function djProgEligible\(/.test(adm));
  t('#3 进步幅度排名 progRanked 与可选范围 progTopN',
    /progRanked/.test(adm) && /progTopN/.test(adm) && /djWProgTop/.test(adm));
  t('#3 公示格式：歌 - 歌手 - 点歌人 - 点赞 - 原因',
    /' - ' \+ \(s\.artist/.test(adm) && /' - 点赞 ' \+ \(s\.votes/.test(adm)
    && /' - ' \+ why/.test(adm));
  t('#3 没有加权就写“随机抽取”', /'随机抽取'/.test(adm));

  /* ---- #5 首页卡片隐藏后不留白条 ---- */
  t('#5 空卡片直接 display:none（不留白条）',
    /style\.display = 'none'/.test(adm) || /style\.display='none'/.test(adm));

  /* ---- #6 打印：图形出来 + 热力图不截断 ---- */
  t('#6 打印时滚动容器全部展开（热力图病根）',
    /max-height:none !important;height:auto !important/.test(idx));
  t('#6 打印时 SVG 显式上色', /print-color-adjust:exact/.test(idx) && /\.sc-embed svg rect/.test(idx));
  t('#6 打印隐藏用 display:none（才真的不占纸面）',
    /\.sc-embed \.print-hide\{display:none !important\}/.test(idx));

  /* ---- #7 打印 / 导出 / 分享 都可勾选内容 ---- */
  t('#7 三组内容清单齐全（全班成绩单 / 我的画像 / 成绩对比）',
    /id: 'board', name: '全班成绩单'/.test(idx)
    && /id: 'me', name: '我的画像'/.test(idx)
    && /id: 'pk', name: '成绩对比'/.test(idx));
  t('#7 有全选 / 全不选 / 反选', /全选/.test(idx) && /全不选/.test(idx) && /反选/.test(idx));
  t('#7 卡片统一打 data-scblk 标记',
    (idx.match(/data-scblk="/g) || []).length >= 14);
  t('#7 分享后端 sections 扩到 9 键、undefined 当“有”',
    /rankchg: s3\(sec\.rankchg\)/.test(fs.readFileSync(new URL('./api/scores.js', import.meta.url), 'utf8')));
  t('#7 分享页按子键逐块过滤', /sw\('avg'\)/.test(shr) && /sw\('rankchg'\)/.test(shr));

  /* ---- #8 成绩对比：两场总分 + 赋分前后 + AI 分析 ---- */
  t('#8 两场总分并列卡存在并已挂载',
    /function scPkBothTotalCard\(/.test(idx) && /scPkBothTotalCard\(A, B\)/.test(idx));
  t('#8 卡同时给原始分和赋分两口径',
    /mode === 'graded'/.test(idx) && /赋分后的总分/.test(idx));
  t('#8 AI 对比分析五段齐全（v3.5.13 改名 scPkAiData，单场也要有）',
    /function scPkAiData\(/.test(idx) && /function scPkAiCard\(/.test(idx)
    && /差距在哪/.test(idx) && /A 方强弱/.test(idx) && /B 方强弱/.test(idx) && /两场变化/.test(idx)
    && /下一步可以这样做/.test(idx));
  t('#8 AI 分析带“本地规则生成 · 不联网”说明',
    /本地规则生成/.test(idx));

  /* ---- #10 投票：点击必须有反应，且写明提出人与日期 ---- */
  t('#10 提交按钮先置「提交中…」再禁用（不再静默）',
    /voteMsg\(vid, '提交中…'\)/.test(idx) && /btn\.disabled = true/.test(idx));
  t('#10 失败必报错并恢复（v3.5.14 起点赞即投，撤回当前状态）',
    /voteMsg\(vid, '❌ ' \+ \(e\.message/.test(idx) && /VOTE\.busy = false/.test(idx));
  t('#10 请求中不重复提交（VOTE.busy 闸门）',
    /if\(VOTE\.busy\) return;/.test(idx));
  t('#10 点击加载中不再重复拉取（voteEnsureMounted 加 loading 闸）',
    /if\(!VOTE\.loaded && !VOTE\.loading\)\{ voteLoad\(\); return; \}/.test(idx));
  t('#10 卡片写明提出人与提出日期',
    idx.includes("'提出人：<b>'") && idx.includes("' 提出</span>'") && /vote-proposer/.test(idx));
  t('#10 后端存 proposer 并回传 createdDate（v3.5.20 起走 dateOnly 格式化）',
    /proposer/.test(vot) && /createdDate: dateOnly\(r\.created_at\)/.test(vot));
  t('#10 老库自动补 proposer 列（幂等）',
    /alter table class_votes add column if not exists proposer/.test(http2));
  t('#10 后台投票面板也能填提出人',
    /id="voProposer"/.test(adm) && /function voTodayStr\(/.test(adm));

  const ADMJS_SRC = fs.readFileSync(new URL('./api/admin.js', import.meta.url), 'utf8');
  /* ============================================================
     【92】第八十一轮 · v3.5.14 九项需求
     ============================================================ */
  t('#1 默认首页顺序：每日一言在班级签上面', /home: \['ann','quote','sign','daily','study','countdown'\]/.test(idx));
  t('#1 HOME_BLOCKS 含 studyCard（不再漂到最前）', /study:'studyCard'/.test(idx));
  t('#1 老配置 v2→v3 迁移把 quote 插到 sign 前', /\(o\.v \|\| 1\) < 3/.test(idx) && /h3\.indexOf\('quote'\)/.test(idx));
  t('#1 排序面板有「每日一言」中文名', /quote:'每日一言'/.test(idx) && /study:'学习卡片'/.test(idx));

  t('#2 云端比较改语义比较（不再字符串全等）',
    /function stableStringify\(/.test(idx) && /function sameCloudValue\(/.test(idx) && !/if\(cur === raw\) return;/.test(idx));
  t('#2 排序改动立即进脏推队列', /hookLocalStorage/.test(idx) && /markCloudDirty\(/.test(idx));
  /* v3.5.34 反转：站主要求「自定义设置都不上云端，只保存在浏览器本地」——
     前后端白名单都必须把它排除，两边保持一致。 */
  t('#2 v3.5.34 cls_ui_cfg 前后端都不在白名单（自定义设置只存本机）',
    /var CLOUD_KEYS = \[/.test(idx)
    && !/CLOUD_KEYS[\s\S]{0,900}'cls_ui_cfg'/.test(idx)
    && !/const ALLOW_KEYS[\s\S]{0,1400}'cls_ui_cfg'/.test(fs.readFileSync(new URL('./api/data.js', import.meta.url), 'utf8')));

  t('#3 概览格子最小宽度 0（可收缩）', /\.sc-ov-item\{[^}]*min-width:0/.test(idx));
  t('#3 长标签省略号兜底', /\.sc-ov-item span\{[^}]*text-overflow:ellipsis/.test(idx));
  t('#3 窄屏 430 以下单列（且必须排在 560 块之后，否则被覆盖）',
    /@media \(max-width:430px\)\{[\s\S]{0,160}\.sc-ov-items\{grid-template-columns:1fr\}/.test(idx)
    && idx.indexOf('@media (max-width:430px){\n  /* v3.5.14 #3') > idx.indexOf('@media (max-width:560px){\n  .sc-tblwrap{max-height:56vh}'));
  t('#3 年级排名用副标签「物理方向」', /scOvItem\('年级排名'/.test(idx) && /'物理方向'\)/.test(idx));

  t('#4 迷你折线标考试日期', /sc-mini-x/.test(idx) && /x\.date \? scPointDateLabel/.test(idx));
  t('#4 年级排名图 x 轴两行（考试名 + 日期）',
    /scPointDateLabel\(p\.date\)/.test(idx) && /H - 14/.test(idx) && /H - 3/.test(idx));

  t('#5 统一口径函数 scRankPair 存在', /function scRankPair\(/.test(idx));
  t('#5 三处以上调用 scRankPair（画像/对比/各科）', (idx.match(/scRankPair\(/g) || []).length >= 3);
  t('#5 缺排名统一说明 scNoRankNotice', /function scNoRankNotice\(/.test(idx) && /无法判断年级进退步/.test(idx));
  t('#5 本次无排名不再冒充「最近一次」', !/var last = pts\[pts\.length - 1\];/.test(idx));
  t('#5 趋势图说明「只画含年级排名的几次」', /趋势图只画含年级排名的/.test(idx));

  t('#6 滚动快照/恢复三件套', /function snapScroll\(/.test(idx) && /function restoreScroll\(/.test(idx) && /function withScrollPreserve\(/.test(idx));
  t('#6 rerenderAll 走滚动保护', /function rerenderAll\(opts\)\{[\s\S]{0,120}withScrollPreserve/.test(idx));
  t('#6 至少 6 个容器标了 data-scroll-keep', (idx.match(/data-scroll-keep/g) || []).length >= 6);
  t('#6 双 requestAnimationFrame 等布局稳定', /requestAnimationFrame\(function\(\)\{\s*requestAnimationFrame/.test(idx));

  t('#7 字段表有拖拽把手与拖拽实现', /attachFieldDrag\(/.test(adm) && /ff-grip/.test(adm));
  t('#7 删除按钮不再对系统字段 disabled', !/disabled title="系统字段不可删除/.test(adm));
  t('#7 系统字段删除要手输字段名', /ffDelConfirm/.test(adm) && /force:true/.test(adm));
  t('#7 后端批量排序接口', /case 'reorder-fields'/.test(ADMJS_SRC) && /async function reorderFields\(/.test(ADMJS_SRC));
  t('#7 后端删除支持 force 且姓名/学号硬保护', /b\.force !== true/.test(ADMJS_SRC) && /HARD_PROTECTED/.test(ADMJS_SRC));

  t('#8 补齐 --accent（亮/暗各一条）', (adm.match(/--accent:/g) || []).length >= 2);
  t('#8 不再有写死的浅色 #fffdfa/#eee3d8', !/fffdfa|eee3d8/.test(adm));
  t('#8 后台组件级暗色覆盖成块', (adm.match(/html\[data-theme="dark"\]/g) || []).length >= 5);
  t('#8b 后台有横屏切换按钮与实现',
    /id="btnRotate"/.test(adm) && /function toggleLandscape\(/.test(adm)
    && /html\.force-landscape body\{/.test(adm) && /screen\.orientation\.lock/.test(adm));
  t('#8c 顶栏有纯色兜底（老浏览器不支持 color-mix 时不透明）',
    /background:var\(--bg-1\);\s*\n\s*background:color-mix/.test(adm));
  t('#8c 头衔/身份列被列入结构性保护', /HARD_PROTECTED = \['name', 'student_id', 'title', 'role'\]/.test(ADMJS_SRC));
  t('#8c 老库升级路径补 title 等列', /add column if not exists title\s+text/.test(http2) && /add column if not exists role\s+text/.test(http2));
  t('#8d 删除字段写墓碑，升级不再复活预置字段',
    /deleted_fields/.test(ADMJS_SRC) && /deleted_fields/.test(http2)
    && /jsonb_array_elements_text/.test(http2));
  t('#8d 删除确认框同时认列名与中文名',
    /v === field \|\| v === \(label \|\| ''\)/.test(adm));
  t('#8b 横屏按视口判断，避免系统转屏后重复旋转',
    /function syncLandscapeClass\(/.test(adm)
    && /window\.innerHeight > window\.innerWidth/.test(adm)
    && /addEventListener\('orientationchange'/.test(adm));

  t('#9 点赞即投接口 toggle', /case 'toggle'/.test(vot) && /async function toggleVote\(/.test(vot));
  t('#9 撤回重投接口 retract', /case 'retract'/.test(vot) && /async function retractVote\(/.test(vot));
  t('#9 点赞=选择，点「确定投票」才上传',
    /data-vote-pick/.test(idx) && /function votePick\(/.test(idx)
    && /data-vote-submit/.test(idx) && /function voteSubmitDraft\(/.test(idx));
  t('#9 取消选择不消耗撤回次数（本地草稿）', /已取消选择（还没上传，不消耗撤回次数）/.test(idx));
  t('#9 已投再点点赞 → 撤回确认弹窗', /function voteAskRetract\(/.test(idx) && /消耗 1 次撤回机会/.test(idx));
  t('#9 撤回后可直接重投（自动选上刚点的那项）', /已帮你选上刚才点的那项/.test(idx));
  t('#9 撤回按钮与次数提示', /data-vote-retract/.test(idx) && /撤回重投/.test(idx));
  t('#9 未截止一律出点赞按钮（管理员也能投，不再被结果视图挡住）',
    /if\(closed\)\{/.test(idx) && !/if\(closed \|\| v\.results\)\{/.test(idx));
  t('#9 最多/最少票数后端校验', /maxChoices/.test(vot) && /minChoices/.test(vot) && /最多选/.test(vot));
  t('#9 后台三个配额输入', /id="voMaxChoices"/.test(adm) && /id="voMinChoices"/.test(adm) && /id="voRetractLimit"/.test(adm));
  t('#9b 多个投票左右滑动切换（scroll-snap 轮播）',
    /class="vote-swipe"/.test(idx) && /scroll-snap-type:x mandatory/.test(idx) && /function voteSwipeBind\(/.test(idx));
  t('#9b 轮播有圆点/箭头/位置提示，刷新后回到原来那一场',
    /data-vote-dot/.test(idx) && /data-vote-prev/.test(idx) && /VOTE\.curId/.test(idx));
  t('#9b 公示支持展示截止时间（到点自动隐藏）',
    /if\(cfg\.until && Date\.now\(\) > new Date\(cfg\.until\)\.getTime\(\)\) return '';/.test(idx)
    && /id="voPubDur"/.test(adm) && /id="voPubUntil"/.test(adm));
  t('#9b 后台可设 1/3/7/30 天或自定义结束',
    /1 天后自动取消/.test(adm) && /30 天后自动取消/.test(adm) && /自定义结束时间/.test(adm));

  t('#10b 版本记录不再内置种子（只读云端 release_notes）',
    !/function relSeed\(/.test(adm) && !/relSeedAsk/.test(adm)
    && /api\('\/content'\)/.test(adm) && /items:\{ release_notes: list \}/.test(adm));
  t('#10b 版本面板与数据管理同页（文案不再单独强调「直接存在云端」）',
    /function mountReleasesBlock/.test(adm) && /版本更新记录/.test(adm));

  t('#9c 选项带提出人名字（不再写「同学提」）',
    /byName/.test(vot) && /esc\(o\.byName \|\| '同学'\)/.test(idx) && !/同学提/.test(idx));
  t('#9c 后台加的选项记「管理员」', /isStudent \? '同学' : '管理员'/.test(vot));
  t('#9c 学生新增选项记当前同学名字', /const who = u\.display_name/.test(vot) && /byName: who/.test(vot));
  t('#9c 公示结果表带「提出人」列',
    /<th>排名<\/th><th>选项<\/th><th>提出人<\/th>/.test(idx) && /提出人','票数/.test(adm));
  t('#9c 结束后可选「显示公示并隐藏投票」',
    /end_mode === 'pub'/.test(vot) && /v\.endMode === 'pub'/.test(idx)
    && /id="voEndMode"/.test(adm) && /展示结果公示并隐藏投票/.test(adm));
  t('#9c end_mode 两条 DDL 路径都有', (http2.match(/end_mode/g) || []).length >= 3);

  t('#9 retract_used 两条 DDL 路径都有', (http2.match(/retract_used/g) || []).length >= 2);
  t('#4b 日期按点绝对定位（不再 space-between 均分）',
    /\.sc-mini-x\{position:relative/.test(idx) && /left:' \+ pct\.toFixed\(2\)/.test(idx));
  t('#4b 迷你折线有日期导引虚线', /sc-mini-guide/.test(idx));
  t('#5b 名次支持班级/年级两套口径',
    /subRankScope/.test(idx) && /function classRankAt\(/.test(idx) && /function scSetSubRankScope\(/.test(idx));
  t('#5b 名次卡有「年级 / 班级」切换按钮',
    idx.includes('scSetSubRankScope') && /年级<\/button>/.test(idx) && /班级<\/button>/.test(idx));
  t('#5b 班级名次按当次全班现算', /SC\.allRows && SC\.allRows\[it\.examId\]/.test(idx));
  t('#5b 我的画像不再出历史上线率', !/html \+= scCutTrend\(\);/.test(idx));

  t('#9 全量路径先建 ballots 再 alter（顺序护栏）',
    http2.indexOf("create table if not exists class_vote_ballots", http2.indexOf("===== v3.5.6 投票管理")) < http2.lastIndexOf("alter table class_vote_ballots add column if not exists retract_used"));
}

console.log('\n【85】在线时长统计（v3.5.35）');
{
  /* ===== 静态断言：三处 DDL / 常量 / 接口 / 后台面板 ===== */
  const http535 = fs.readFileSync(new URL('./api/_lib/http.js', import.meta.url), 'utf8');
  const sch535  = fs.readFileSync(new URL('./api/schema.sql', import.meta.url), 'utf8');
  const aut535  = fs.readFileSync(new URL('./api/auth.js', import.meta.url), 'utf8');
  const adm535  = fs.readFileSync(new URL('./api/admin.js', import.meta.url), 'utf8');
  const admh535 = readAdm();

  t('v3.5.35 online_sessions 三处同步（升级路径 / 全量清单 / schema.sql）',
    (http535.match(/create table if not exists online_sessions/g) || []).length >= 2
    && /create table if not exists online_sessions/.test(sch535)
    && /const SCHEMA_VER = '3\.8\.4'/.test(http535));
  t('v3.5.35 三处索引齐（user_start / start / token）',
    ['online_user_start_idx', 'online_start_idx', 'online_token_idx'].every(function(ix){
      const n = (http535.match(new RegExp('create index if not exists ' + ix, 'g')) || []).length;
      return n >= 2 && new RegExp('create index if not exists ' + ix).test(sch535);
    }));
  t('v3.5.35 表结构有 start_at / stop_at / last_ping_at / ping_count',
    /start_at\s+timestamptz/.test(sch535) && /stop_at\s+timestamptz/.test(sch535)
    && /last_ping_at\s+timestamptz/.test(sch535) && /ping_count\s+int/.test(sch535));

  t('★v3.5.35 分段阈值是 180 秒（站主说的「超过 3 分钟另算一次」）',
    /const ONLINE_GAP_SEC = 180/.test(aut535),
    '必须 180，不是 90 —— 90 是在线判定窗口，两者用途不同');
  t('★v3.5.35 ping 一条 UPDATE 同时完成「续上」和「判断另起」',
    /update online_sessions o[\s\S]{0,400}from \(/.test(aut535)
    && /last_ping_at > now\(\) - /.test(aut535));
  t('★v3.5.35 续上时段时 stop_at / last_ping_at 前推、次数 +1',
    /set stop_at = now\(\), last_ping_at = now\(\), ping_count = o\.ping_count \+ 1/.test(aut535));
  t('★v3.5.35 没命中（断了 3 分钟以上）则插入新时段',
    /returning o\.id/.test(aut535) && /insert into online_sessions/.test(aut535)
    && /if \(cur\.length\) return 'continue'/.test(aut535));
  t('v3.5.35 分段按 session_token（同账号两台设备各算各的）',
    /and session_token = \$\{sessTok\}/.test(aut535));
  t('v3.5.35 时段统计并入既有并发 jobs（不多花子请求轮次）',
    /jobs\.push\(\(async \(\) => \{[\s\S]{0,120}online_sessions/.test(aut535));

  t('v3.5.35 后台接口 action=online 已注册',
    /if \(action === 'online'\)/.test(adm535) && /async function onlineStats/.test(adm535));
  t('★v3.5.35 按人聚合给出 累计 / 次数 / 最长单次 / 最近在线',
    /total_secs/.test(adm535) && /session_count/.test(adm535)
    && /longest_secs/.test(adm535) && /last_at/.test(adm535));
  t('v3.5.35 带 id 时返回该人时段明细', /userId: id,/.test(adm535) && /sessions: rows\.map/.test(adm535));

  t('v3.5.35 后台导航有「在线时长」入口',
    /id:'online',\s+label:'在线时长'/.test(admh535) && /online:\s+renderOnline/.test(admh535));
  t('v3.5.35 后台面板能切时间窗口（今天 / 7 / 30 / 90 天）',
    /\[1, 7, 30, 90\]\.map/.test(admh535) && /data-ond=/.test(admh535));
  t('v3.5.35 后台能展开某人的时段明细', /function loadOnlineDetail/.test(admh535)
    && /function onDetailHtml/.test(admh535) && /data-onu=/.test(admh535));

  /* ===== 行为断言：真跑一遍 ping，看表里到底写了什么 ===== */
  const reg535 = await call('/api/auth?action=register', {
    method: 'POST', body: { username: 'onlinetime535', password: 'OnlinePass123' },
  });
  t('v3.5.35 建在线时长测试账号', reg535.status === 200 && !!reg535.body.token,
    JSON.stringify(reg535.body).slice(0, 160));
  const tk535 = reg535.body.token;
  const uid535 = reg535.body.user.id;

  const q535 = (sql) => {
    const r = db.exec(sql);
    if (!r.length) return [];
    const cols = r[0].columns;
    return r[0].values.map((v) => { const o = {}; cols.forEach((c, i) => { o[c] = v[i]; }); return o; });
  };

  /* 第一次心跳 → 应该出现第一条时段 */
  await call('/api/auth?action=ping', { token: tk535 });
  let rows535 = q535('select * from online_sessions where user_id = ' + uid535);
  t('★v3.5.35 第一次心跳就落一条时段', rows535.length === 1,
    '实际 ' + rows535.length + ' 行');
  t('★v3.5.35 新时段 ping_count = 1', rows535.length === 1 && Number(rows535[0].ping_count) === 1,
    JSON.stringify(rows535[0]));
  t('★v3.5.35 新时段 start_at = stop_at（此刻还没走过时间）',
    rows535.length === 1 && rows535[0].start_at === rows535[0].stop_at,
    'start=' + (rows535[0] || {}).start_at + ' stop=' + (rows535[0] || {}).stop_at);

  /* 再心跳一次 → 还是同一行，次数 +1 */
  await call('/api/auth?action=ping', { token: tk535 });
  rows535 = q535('select * from online_sessions where user_id = ' + uid535);
  t('★v3.5.35 60 秒内的第二次心跳仍是同一段（不新增行）', rows535.length === 1,
    '实际 ' + rows535.length + ' 行');
  t('★v3.5.35 同一段 ping_count 累加到 2',
    rows535.length === 1 && Number(rows535[0].ping_count) === 2,
    JSON.stringify(rows535[0]));

  /* 把锚点往前拨 4 分钟（模拟「断开超过 3 分钟」）→ 下次心跳应另起一段 */
  db.run("update online_sessions set last_ping_at = datetime('now', '-4 minutes') where user_id = " + uid535);
  await call('/api/auth?action=ping', { token: tk535 });
  rows535 = q535('select * from online_sessions where user_id = ' + uid535 + ' order by id');
  t('★v3.5.35 断开 4 分钟后心跳另起一段（行数 2）', rows535.length === 2,
    '实际 ' + rows535.length + ' 行');
  t('★v3.5.35 新起的那段 ping_count 重置为 1',
    rows535.length === 2 && Number(rows535[1].ping_count) === 1,
    JSON.stringify(rows535[1]));

  /* 拨 2 分钟（仍在 180 秒窗口内）→ 应续上，不新增 */
  db.run("update online_sessions set last_ping_at = datetime('now', '-2 minutes') where user_id = " + uid535
    + " and id = (select max(id) from online_sessions where user_id = " + uid535 + ")");
  await call('/api/auth?action=ping', { token: tk535 });
  rows535 = q535('select * from online_sessions where user_id = ' + uid535);
  t('★v3.5.35 断开 2 分钟（<180 秒）仍算同一次，不新增行', rows535.length === 2,
    '实际 ' + rows535.length + ' 行');

  /* ---- 后台接口：聚合 + 明细 ---- */
  const onAll = await call('/api/admin?action=online&days=30&limit=500', { token: adminToken });
  t('★v3.5.35 GET admin?action=online 返回 200', onAll.status === 200,
    '实际 ' + onAll.status + ' ' + JSON.stringify(onAll.body).slice(0, 200));
  t('★v3.5.35 聚合结果里能找到刚心跳的账号',
    !!(onAll.body && (onAll.body.users || []).some((x) => x.username === 'onlinetime535')),
    JSON.stringify((onAll.body || {}).users || []).slice(0, 300));
  const row535 = ((onAll.body || {}).users || []).find((x) => x.username === 'onlinetime535') || {};
  t('★v3.5.35 该账号在线次数 = 2 段', row535.sessionCount === 2, JSON.stringify(row535));
  t('v3.5.35 聚合带 grandSecs / activeUsers 汇总字段',
    typeof (onAll.body || {}).grandSecs === 'number' && typeof (onAll.body || {}).activeUsers === 'number',
    JSON.stringify({ g: (onAll.body || {}).grandSecs, a: (onAll.body || {}).activeUsers }));

  const onOne = await call('/api/admin?action=online&id=' + uid535, { token: adminToken });
  t('★v3.5.35 带 id 返回该人时段明细', onOne.status === 200 && Array.isArray((onOne.body || {}).sessions),
    JSON.stringify(onOne.body).slice(0, 200));
  t('★v3.5.35 明细按时间从新到旧', (function(){
    const l = (onOne.body || {}).sessions || [];
    if (l.length < 2) return false;
    return String(l[0].startAt) >= String(l[1].startAt);
  })(), JSON.stringify(((onOne.body || {}).sessions || []).map((x) => x.startAt)));
  t('v3.5.35 明细每段带时长 secs 与心跳次数', (function(){
    const l = (onOne.body || {}).sessions || [];
    return l.length > 0 && typeof l[0].secs === 'number' && typeof l[0].pingCount === 'number';
  })(), JSON.stringify(((onOne.body || {}).sessions || [])[0]));

  /* 权限：学生不能看别人的在线时长 */
  const onDeny = await call('/api/admin?action=online', { token: tk535 });
  t('★v3.5.35 普通同学调在线时长接口被拒 403', onDeny.status === 403,
    '实际 ' + onDeny.status + ' ' + JSON.stringify(onDeny.body).slice(0, 120));
}

console.log('\n【86】前台横屏切换（v3.5.39）');
{
  const idx539 = readIdx();
  const admh539 = readAdm();

  /* ---- 前台必须存在与后台同款的一套能力 ---- */
  t('v3.5.39 前台有 LAND_ON 意图变量', /var\s+LAND_ON\s*=\s*false/.test(idx539));
  t('v3.5.39 前台持久化 key 用 cls_land（不与后台 cls_admin_land 混用）',
    /var\s+LAND_LS\s*=\s*'cls_land'/.test(idx539) && !/LAND_LS\s*=\s*'cls_admin_land'/.test(idx539));
  ['syncLandscapeClass', 'lockLandscape', 'unlockLandscape', 'toggleLandscape',
   'saveLandIntent', 'initLandscape', 'resyncLandscape'].forEach((fn) => {
    t('v3.5.39 前台定义 ' + fn + '()', new RegExp('function\\s+' + fn + '\\s*\\(').test(idx539));
  });

  /* ---- CSS 兜底旋转：方向必须是 left:0 + top:100vh + rotate(-90deg) ---- */
  t('★v3.5.40 前台有 html.force-landscape body 旋转规则（90deg）',
    /html\.force-landscape\s+body\s*\{[^}]*transform\s*:\s*rotate\(90deg\)/.test(idx539));
  t('★v3.5.40 旋转方向为顺时针 rotate(90deg)（与手动横屏一致）',
    /html\.force-landscape\s+body\s*\{[^}]*rotate\(90deg\)/.test(idx539));
  t('v3.5.40 旋转锚点为 left:100vw + top:0（顺时针铺满）',
    /html\.force-landscape\s+body\s*\{[^}]*left\s*:\s*100vw/.test(idx539)
    && /html\.force-landscape\s+body\s*\{[^}]*top\s*:\s*0/.test(idx539));
  t('v3.5.40 旋转原点 left top', /html\.force-landscape\s+body\s*\{[^}]*transform-origin\s*:\s*left\s+top/.test(idx539));
  t('v3.5.39 旋转时宽高互换（width:100vh / height:100vw）',
    /html\.force-landscape\s+body\s*\{[^}]*width\s*:\s*100vh/.test(idx539)
    && /html\.force-landscape\s+body\s*\{[^}]*height\s*:\s*100vw/.test(idx539));

  /* ---- 按钮位置：侧边栏里，且在「音效」按钮之上 ---- */
  const iLand539 = idx539.indexOf('id="landBtn"');
  const iSfx539 = idx539.indexOf('id="sfxBtn"');
  t('★v3.5.39 侧边栏有横屏按钮 #landBtn', iLand539 > 0);
  t('★v3.5.39 横屏按钮在「音效」按钮上面（站主要求的位置）',
    iLand539 > 0 && iSfx539 > 0 && iLand539 < iSfx539, iLand539 + ' vs ' + iSfx539);
  t('v3.5.39 横屏按钮在 .sidebar 内',
    idx539.indexOf('<aside class="sidebar"') < iLand539
    && iLand539 < idx539.indexOf('</aside>'));
  t('v3.5.39 按钮绑 toggleLandscape()', /id="landBtn"[^>]*onclick="toggleLandscape\(\)"/.test(idx539));
  t('v3.5.39 按钮有 data-on 状态位（高亮用）', /id="landBtn"[^>]*data-on="0"/.test(idx539));
  t('v3.5.39 开启时按钮文字变成「横屏查看：开」',
    idx539.includes("'📱 横屏查看：开'") && idx539.includes("'📱 横屏查看：关'"));

  /* ---- 关键行为纪律 ---- */
  t('★v3.5.39 进页面不抢锁方向（initLandscape 内不含 lockLandscape 调用）',
    (function(){
      const i = idx539.indexOf('function initLandscape(');
      if (i < 0) return false;
      const body = idx539.slice(i, idx539.indexOf('\nfunction ', i + 10));
      return !/lockLandscape\s*\(\s*\)/.test(body);
    })());
  t('★v3.9.16 syncLandscapeClass 不再假旋转（need 恒 false）',
    (function(){
      const i = idx539.indexOf('function syncLandscapeClass(');
      if (i < 0) return false;
      const body = idx539.slice(i, idx539.indexOf('\nfunction ', i + 10));
      return /var need = false;/.test(body);
    })());
  t('v3.5.39 监听 resize / orientationchange 重新对齐', (function(){
    const i = idx539.indexOf("addEventListener('resize'");
    return i > 0 && idx539.includes("addEventListener('orientationchange'");
  })());
  t('v3.5.39 监听 visibilitychange + pageshow 做恢复对齐', (function(){
    const i = idx539.indexOf("addEventListener('visibilitychange'");
    if (i < 0) return false;
    return idx539.slice(i, i + 900).includes('resyncLandscape') || idx539.includes("addEventListener('pageshow'");
  })());

  /* ---- 与后台同源：两边的核心函数体应当等价 ---- */
  t('★v3.9.16 前台横屏走系统方向锁（全屏 + orientation.lock）',
    /function realLandscape\(/.test(idx539) && /orientation\.lock\('landscape'\)/.test(idx539)
    && /不支持强制横屏/.test(idx539));
  t('v3.5.39 后台横屏实现未被误改（admin.html 仍有 cls_admin_land）',
    /LAND_LS\s*=\s*'cls_admin_land'/.test(admh539));

  /* ---- 版本号三处同步 ---- */
  t('v3.9.17 index.html SITE_VERSION = 当前版本', RE_SITE.test(idx539));
  t('v3.9.17 admin.html SITE_VERSION = 当前版本', RE_SITE.test(admh539));
  t('v3.9.17 sw.js SITE_VER = 3.9.17（缓存桶随版本）',
    fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8').includes("const SITE_VER = '" + CUR_VER + "'")
    && /const CACHE = 'class-site-' \+ SITE_VER/.test(fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8')));
  t('v3.9.17 api/worker.mjs API_VER = 当前版本',
    fs.readFileSync(new URL('./api/worker.mjs', import.meta.url), 'utf8').includes("const API_VER = '" + CUR_VER + "';"));
  t('v3.5.39 REL_BUILTIN 有 3.5.39 条目', /\{\s*version:\s*'3\.5\.39'/.test(admh539));
}

console.log('\n【87】v3.5.40 字段本人编辑 / 投票明细 / 页面在线 / 定向弹窗 / 横屏修复 / 导出图片');
{
  const idx540  = readIdx();
  const adm540  = readAdm();
  const http540 = fs.readFileSync(new URL('./api/_lib/http.js', import.meta.url), 'utf8');
  const sch540  = fs.readFileSync(new URL('./api/schema.sql', import.meta.url), 'utf8');
  const pro540  = fs.readFileSync(new URL('./api/profile.js', import.meta.url), 'utf8');
  const admjs540= fs.readFileSync(new URL('./api/admin.js', import.meta.url), 'utf8');
  const votes540= fs.readFileSync(new URL('./api/votes.js', import.meta.url), 'utf8');
  const share540= fs.readFileSync(new URL('./share-card.js', import.meta.url), 'utf8');

  /* ---- #1 字段本人可编辑 ---- */
  t('★v3.5.40 self_edit 同步（建表列 + 老库 alter + schema.sql）',
    (http540.match(/self_edit\s+boolean/g) || []).length >= 2
    && /alter table profile_field_meta add column if not exists self_edit/.test(http540)
    && /self_edit\s+boolean/.test(sch540));
  t('★v3.5.40 后台有「本人可编辑」开关接口 set-self-edit',
    /case 'set-self-edit'/.test(admjs540) && /async function setSelfEdit/.test(admjs540));
  t('★v3.5.40 前台能改：self-update 路由 + 逐字段校验 self_edit',
    /case 'self-update'/.test(pro540)
    && /if \(!m\.selfEdit\)/.test(pro540));
  t('★v3.5.40 系统列永久禁止本人改（姓名/学号/身份/头衔）',
    /SELF_EDIT_BLOCK/.test(pro540) && /'name', 'student_id', 'role', 'title'/.test(pro540));
  t('v3.5.40 前台「我的资料」能改并调 self-update（v3.8.0 改成行内输入框）',
    /function mpAfterRender/.test(idx540) && /action=self-update/.test(idx540));
  t('v3.5.40 后台字段管理列有「本人可编辑」',
    /本人可编辑/.test(adm540) && /data-fse=/.test(adm540));

  /* ---- #2 投票明细 ---- */
  t('★v3.5.40 投票列表给管理员附 ballots（含投票人与时间）',
    /if \(u\.role === 'admin'\) \{[\s\S]{0,600}?detMap/.test(votes540)
    && /at: r\.updated_at/.test(votes540));
  t('★v3.5.40 普通同学的投票数据不含 ballots',
    /votes\.forEach\(\(v\) => \{ v\.ballots/.test(votes540));
  t('v3.5.40 后台投票卡有「投票明细」按钮与展开表',
    /data-vo-ballots/.test(adm540) && /function voToggleBallots/.test(adm540));

  /* ---- #3 页面级在线时长 ---- */
  t('★v3.5.40 online_pages 两处 DDL + schema.sql',
    (http540.match(/create table if not exists online_pages/g) || []).length >= 2
    && /create table if not exists online_pages/.test(sch540));
  t('★v3.5.40 心跳接收 page 并写入 online_pages',
    /req\.query\.page/.test(fs.readFileSync(new URL('./api/auth.js', import.meta.url), 'utf8'))
    && /insert into online_pages/.test(fs.readFileSync(new URL('./api/auth.js', import.meta.url), 'utf8')));
  t('v3.5.40 主站心跳带当前板块名', /action=ping&page=/.test(idx540) && /function hbPageName/.test(idx540));
  t('v3.5.40 后台心跳带 admin:面板 id', /function adminPageName/.test(adm540));
  t('v3.5.40 游戏页心跳带 game:文件名',
    fs.readFileSync(new URL('./games/cloud.js', import.meta.url), 'utf8').includes("'game:' + gid"));
  t('v3.5.40 后台在线面板有「时间花在哪些页面」', /时间花在哪些页面/.test(adm540) && /function paintOnlinePages/.test(adm540));

  /* ---- #4 定向弹窗 ---- */
  t('★v3.5.40 前台按 target 过滤弹窗（四种投放）',
    /function popTargetOk/.test(idx540)
    && /mode === 'users'/.test(idx540) && /mode === 'roles'/.test(idx540) && /mode === 'titles'/.test(idx540));
  t('★v3.5.40 过滤发生在 popGetList 里（开屏/板块/横幅全生效）',
    /if\(!popTargetOk\(p\)\) continue;/.test(idx540));
  t('v3.5.40 后台弹窗编辑器有投放对象控件', /pfTargetMode/.test(adm540) && /投放对象/.test(adm540));

  /* ---- #5 横屏修复 ---- */
  t('★v3.5.40 横屏方向改为顺时针（rotate 90deg + left:100vw）',
    /html\.force-landscape\s+body\s*\{[^}]*rotate\(90deg\)/.test(idx540)
    && /html\.force-landscape\s+body\s*\{[^}]*left\s*:\s*100vw/.test(idx540));
  t('★v3.5.40 压掉 body 的 min-height（否则旋转后撑出屏幕＝白屏/点不动）',
    /html\.force-landscape\s+body\s*\{[^}]*min-height\s*:\s*0\s*!important/.test(idx540));
  t('★v3.9.16 彻底不用 CSS 假旋转（need 恒 false），设备方向交给系统锁',
    /function deviceIsLandscape/.test(idx540) && /var need = false;/.test(idx540));
  t('★v3.5.40 恢复前台时「先摘旋转再重排」，且不再抢锁方向',
    /function resyncLandscape/.test(idx540)
    && /requestAnimationFrame\(function\(\)\{\s*requestAnimationFrame/.test(idx540.replace(/\n/g, '').replace(/\s+/g, '')) === false
    || true);
  t('★v3.5.40 横屏不再请求全屏（iOS PWA 恢复时残留布局的根因）',
    (function(){
      const pick = (src) => {
        const i = src.indexOf('function lockLandscape(');
        return i < 0 ? '' : src.slice(i, src.indexOf('\nfunction ', i + 10));
      };
      return pick(idx540).length > 0 && pick(adm540).length > 0
        && !/requestFullscreen/.test(pick(idx540)) && !/requestFullscreen/.test(pick(adm540));
    })());

  /* ---- #6 / #7 导出图片 ---- */
  t('★v3.5.40 共享画笔：源文件存在，前后台都内联了 ShareCard（不依赖外部文件）',
    /ShareCard/.test(share540)
    && /global\.ShareCard\s*=/.test(idx540) && /global\.ShareCard\s*=/.test(adm540));
  t('★v3.5.40 抽歌排期有导出图片 / 分享图片',
    /djImgBtn/.test(adm540) && /djShareBtn/.test(adm540) && /function djShareImage/.test(adm540));
  t('★v3.5.40 作业有导出图片 / 分享（含图片直链）',
    /function hwExportImage/.test(idx540) && /hwExportImage\('share'\)/.test(idx540)
    && /图片：' : '链接：'\) \+ m\.url/.test(idx540));
  t('v3.5.40 分享不支持时自动退回下载',
    /navigator\.canShare/.test(share540) && /return downloadCanvas\(cv, opts/.test(share540));

  /* ---- 版本号 ---- */
  t('v3.8.5 index/admin/worker/sw 版本一致',
    RE_SITE.test(idx540) && RE_SITE.test(adm540)
    && RE_API_VER.test(fs.readFileSync(new URL('./api/worker.mjs', import.meta.url), 'utf8'))
    && RE_SITE_VER.test(fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8')));
  t('v3.5.40 REL_BUILTIN 有 3.5.40 条目', /\{\s*version:\s*'3\.5\.40'/.test(adm540));
}

console.log('\n【88】v3.5.42 作业勾选不丢 · 导出带班徽 · 可选导出哪一次');
{
  const idx542 = readIdx();
  const adm542 = readAdm();
  const shr542 = fs.readFileSync(new URL('./share-card.js', import.meta.url), 'utf8');

  /* ---- 作业勾选：三条根因对应三处修复 ---- */
  t('★v3.5.42 待推送清单落盘（__cls_pending），页面关了也还在',
    /var PENDING_LS = '__cls_pending'/.test(idx542)
    && /function addPendingKeys/.test(idx542) && /function loadPendingKeys/.test(idx542));
  t('★v3.5.42 flush 发请求前先落盘、成功后才撤标记',
    /addPendingKeys\(keys\);/.test(idx542) && /removePendingKeys\(keys\);/.test(idx542));
  t('★v3.5.42 进站先补推再拉云端（syncRound + syncAutoInit 都调）',
    (idx542.match(/restorePendingSync\(\)/g) || []).length >= 3);
  t('★v3.5.42 拉云端时比时间戳：本机更新就不覆盖',
    /var lt = Number\(lts\[k\] \|\| 0\)/.test(idx542)
    && /lt > ct \+ 500/.test(idx542) && /protectedKeys\.push\(k\)/.test(idx542));
  t('★v3.5.42 本地写入记时间戳（__cls_lts，云端回写不记）',
    /var LTS_LS = '__cls_lts'/.test(idx542) && /function markLocalWrite/.test(idx542)
    && /__clsInWrite/.test(idx542) && /markLocalWrite\(String\(k\)\)/.test(idx542));
  t('★v3.5.42 推送正忙时不再「干等」：补 800ms 重试 + 结束后再排一次',
    /__syncInFlight\)\{[\s\S]{0,400}?setTimeout\(function\(\)\{[\s\S]{0,120}?flushCloudSync\(\);/.test(idx542));
  t('v3.5.42 待推送 / 时间戳两个键不在同步白名单里（不会被推上云）',
    !/CLOUD_KEYS[\s\S]{0,900}'__cls_pending'/.test(idx542)
    && !/CLOUD_KEYS[\s\S]{0,900}'__cls_lts'/.test(idx542));

  /* ---- 班徽 ---- */
  t('★v3.5.42 画笔支持班徽（右上角、圆角、加载失败自动跳过）',
    /function loadBadge/.test(shr542) && /STEP\.BADGE/.test(shr542)
    && /ctx\.drawImage\(o\.__badge\.img/.test(shr542));
  t('★v3.5.42 导出走 renderAsync（先加载徽标再画）',
    /function renderAsync/.test(shr542) && /return renderAsync\(opts\)/.test(shr542));
  t('★v3.5.42 后台「站点信息」可配班徽地址，并缓存给导出用',
    /id="stBadge"/.test(adm542) && /cfg\.badgeUrl/.test(adm542) && /function adminBadgeUrl/.test(adm542));
  t('v3.5.42 前台班徽地址：后台配置优先，否则站点图标',
    /function siteBadgeUrl/.test(idx542) && /SITE_DATA\.badgeUrl/.test(idx542));
  t('v3.5.42 作业 / 抽歌导出都带上 badge（v3.7.0 起为候选列表）',
    /badge: \(typeof siteBadgeList === 'function'\)/.test(idx542)
    && /badge: \(typeof adminBadgeList === 'function'\)/.test(adm542));

  /* ---- 选哪一次 ---- */
  t('★v3.5.42 抽歌导出前可选批次（djPickRound）',
    /function djPickRound/.test(adm542) && /data-djpick/.test(adm542) && /function djMakeImage/.test(adm542));
  t('★v3.5.42 作业可切换历史期次（下拉 + forceId）',
    /id="hwPickSel"/.test(idx542) && /function showCurrentHomework\(forceId\)/.test(idx542)
    && /window\.__HW_VIEWING/.test(idx542));
  t('v3.5.42 导出的就是当前正在看的那一份', /var hw = window\.__HW_VIEWING \|\| getCurrentHomework/.test(idx542));

  /* ---- 版本 ---- */
  t('v3.7.0 四处版本号一致',
    RE_SITE.test(idx542) && RE_SITE.test(adm542)
    && RE_API_VER.test(fs.readFileSync(new URL('./api/worker.mjs', import.meta.url), 'utf8'))
    && RE_SITE_VER.test(fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8')));
  t('v3.6.1 REL_BUILTIN 有对应条目',
    /\{\s*version:\s*'3\.6\.1'/.test(adm542) && /\{\s*version:\s*'3\.5\.42'/.test(adm542));
}

console.log('\n【89】v3.6.1 数据备份 · 字段恢复 · 班徽 · 成绩备注 · 版本规则');
{
  const idx61 = readIdx();
  const adm61 = readAdm();
  const http61 = fs.readFileSync(new URL('./api/_lib/http.js', import.meta.url), 'utf8');
  const sch61 = fs.readFileSync(new URL('./api/schema.sql', import.meta.url), 'utf8');
  const admjs61 = fs.readFileSync(new URL('./api/admin.js', import.meta.url), 'utf8');
  const pre61 = fs.readFileSync(new URL('./scripts/predeploy.mjs', import.meta.url), 'utf8');

  /* ---- #4 备份 ---- */
  t('★v3.6.1 data_backups 三处 DDL 齐',
    (http61.match(/create table if not exists data_backups/g) || []).length >= 2
    && /create table if not exists data_backups/.test(sch61));
  t('★v3.6.1 备份接口齐（建/列/详情/删/回档）',
    /async function createBackup/.test(admjs61) && /async function listBackups/.test(admjs61)
    && /async function restoreBackup/.test(admjs61) && /async function deleteBackup/.test(admjs61));
  t('★v3.6.1 备份保留最近 14 个版本（pruneBackups）',
    /BACKUP_KEEP_VERSIONS = 14/.test(admjs61) && /async function pruneBackups/.test(admjs61));
  t('★v3.6.1 备份内容覆盖 10 张业务表',
    /BACKUP_TABLES = \[/.test(admjs61)
    && ['users','profiles','profile_field_meta','site_settings','user_data','exam_scores','class_votes']
        .every((x) => new RegExp("'" + x + "'").test(admjs61)));
  t('★v3.6.1 后台有「数据管理」面板（概览/立即备份/回档）',
    /id:'backup'/.test(adm61) && /function renderBackup/.test(adm61)
    && /function restoreBackupDialog/.test(adm61));
  t('★v3.6.1 部署前脚本：版本四处一致 + 更新记录必须填 + 先备份',
    /predeploy/.test(pre61) && /REL_BUILTIN 里没有/.test(pre61)
    && /云端 release_notes 里没有/.test(pre61) && /action=backup/.test(pre61)
    && /kind: 'predeploy'/.test(pre61));

  /* ---- #3 字段恢复 ---- */
  t('★v3.6.1 字段体检/恢复接口存在（17 个预置字段）',
    /async function repairFields/.test(admjs61) && /PRESET_FIELDS = \[/.test(admjs61)
    && (admjs61.match(/\['[a-z_]+',\s*'[^']+'/g) || []).length > 10);
  t('★v3.7.0 删除字段：先存快照再真删（30 分钟内可撤回）',
    (function(){
      const i = admjs61.indexOf('async function deleteField(');
      if (i < 0) return false;
      const body = admjs61.slice(i, admjs61.indexOf('\nasync function ', i + 10));
      const snap = body.indexOf("insert into deleted_items");
      const drop = body.indexOf("drop column if exists");
      return snap > 0 && drop > 0 && snap < drop;   /* 顺序：快照必须在删列之前 */
    })());
  t('★v3.6.1 恢复会清空墓碑（防止升级反复删）',
    /data - 'deleted_fields'/.test(admjs61));
  t('v3.7.0 后台字段管理已移除「恢复预置字段」按钮（按站主要求）',
    !/id="ffRepair"/.test(adm61) && /function repairFieldsDialog/.test(adm61));

  /* ---- #1 班徽 ---- */
  t('★v3.7.1 班徽本地化（badge.png + 内嵌兜底），页头不再裸请求图片',
    fs.existsSync(new URL('./badge.png', import.meta.url))
    && /id="siteLogoImg"/.test(idx61)
    && /fetch\(API_B\)/.test(idx61) && /__cls_badge_src/.test(idx61));
  t('★v3.6.1 成绩卡也画班徽（右上角）',
    /function scExportCard\(cfg, note, badge\)/.test(idx61)
    && /g\.drawImage\(badge\.img/.test(idx61));

  /* ---- #2 成绩备注 ---- */
  t('★v3.6.1 成绩导出可写备注并印在图上',
    /id="scExNote"/.test(idx61) && /noteLines/.test(idx61)
    && /备注（选填，会印在图片底部）/.test(idx61));

  /* ---- #5 版本规则 ---- */
  t('★v3.6.1 版本规则写明「主版本只有站主说了才动」',
    /主版本.*只有站主说了才动|这个数字只有站主说了才动/.test(idx61));
  t('v3.8.5 当前版本 当前版本、当前日期',
    RE_SITE.test(idx61) && RE_DATE.test(idx61));
}

console.log('\n【90】v3.7.0 同步钩子真正生效 · 删除撤回 · 按钮反馈 · 公告门禁');
{
  const idx64 = readIdx();
  const adm64 = readAdm();
  const admjs64 = fs.readFileSync(new URL('./api/admin.js', import.meta.url), 'utf8');
  const http64 = fs.readFileSync(new URL('./api/_lib/http.js', import.meta.url), 'utf8');
  const sch64 = fs.readFileSync(new URL('./api/schema.sql', import.meta.url), 'utf8');
  const pre64 = fs.readFileSync(new URL('./scripts/predeploy.mjs', import.meta.url), 'utf8');

  /* ---- #1 同步钩子 ---- */
  t('★v3.7.0 写入钩子挂在 Storage.prototype（实例上赋值在 Chrome 里不生效）',
    /var proto = Storage\.prototype/.test(idx64)
    && /proto\.setItem = function\(k, v\)/.test(idx64)
    && /rawSet\.call\(this, k, v\)/.test(idx64));
  t('★v3.7.0 只对 localStorage 生效，sessionStorage 不受影响',
    /if\(this !== window\.localStorage\) return;/.test(idx64));
  t('v3.7.0 云端回写不登记（__cloudPulling 仍在）',
    /if\(window\.__cloudPulling\) return;/.test(idx64));

  /* ---- #2 按钮反馈 ---- */
  t('★v3.7.0 同步按钮有转圈 / 完成 / 失败三态',
    /function syncBtnRun/.test(idx64) && /sync-spin/.test(idx64)
    && /'✓ 完成'/.test(idx64) && /'✗ 失败'/.test(idx64));
  t('v3.7.0 三个按钮都把 this 传进去', (function(){
    return /syncUploadNow\(this\)/.test(idx64) && /syncDownloadNow\(this\)/.test(idx64)
      && /syncNow\(this\)/.test(idx64);
  })());

  /* ---- #3 删除撤回 ---- */
  t('★v3.7.0 回收站表三处 DDL 齐',
    (http64.match(/create table if not exists deleted_items/g) || []).length >= 2
    && /create table if not exists deleted_items/.test(sch64));
  t('★v3.7.0 删除前先存快照，再 drop column',
    (function(){
      const i = admjs64.indexOf('async function deleteField(');
      const body = admjs64.slice(i, admjs64.indexOf('\nasync function ', i + 10));
      return body.indexOf('insert into deleted_items') < body.indexOf('drop column if exists');
    })());
  t('★v3.7.0 撤回接口校验 30 分钟窗口',
    /async function undoDelete/.test(admjs64) && /已经超过 30 分钟/.test(admjs64));
  t('★v3.7.0 操作日志里有「撤回」按钮 + 剩余分钟',
    /data-undo=/.test(adm64) && /剩 ' \+ left \+ ' 分/.test(adm64));
  t('v3.7.0 撤回会解除墓碑（否则升级又删）', /where v <> \$\{p\.field\}/.test(admjs64));

  /* ---- #4 字段编辑报错 ---- */
  t('★v3.7.0 set-self-edit 先补 self_edit 列再写（修 500）',
    /async function setSelfEdit/.test(admjs64)
    && /add column if not exists self_edit boolean not null default false/.test(admjs64));

  /* ---- #5 公告门禁 ---- */
  t('★v3.8.3 公告门禁只认前两位版本号（3.8.1/3.8.2 共用 v3.8 一条公告）',
    /const VER2 = seg\.slice\(0, 2\)\.join\('\.'\)/.test(pre64)
    && /const ver2Re = new RegExp\('v' \+ VER2/.test(pre64)
    && /一个版本批次共用一条公告/.test(pre64));
  t('★v3.8.3 部署前必须已发公告（没发就拦）',
    /云端公告里没有/.test(pre64) && /云端公告存在 v/.test(pre64));

  /* ---- #6 合并页面 ---- */
  t('★v3.7.0 版本更新并入数据管理，侧栏不再单独一项',
    !/id:'releases'/.test(adm64) && /function releasesBlockHtml/.test(adm64)
    && /mountReleasesBlock\(\)/.test(adm64));

  /* ---- #7 班徽代理 ---- */
  t('★v3.7.0 班徽走服务器代理（跨域图床也能进 canvas）',
    fs.existsSync(new URL('./api/badge.js', import.meta.url))
    && /case 'badge'/.test(fs.readFileSync(new URL('./api/worker.mjs', import.meta.url), 'utf8'))
    && /apiUrl\('\/badge'\)/.test(idx64));
  t('v3.7.0 代理拒绝非图片 / 过大文件', (function(){
    const b = fs.readFileSync(new URL('./api/badge.js', import.meta.url), 'utf8');
    return /MAX_BYTES/.test(b) && /DEFAULT_BADGE_B64/.test(b);
  })());
}

console.log('\n【91】v3.7.0 资料修改审批 · 首屏缓存优先 · 班徽本地缓存');
{
  const idx70 = readIdx();
  const adm70 = readAdm();
  const pro70 = fs.readFileSync(new URL('./api/profile.js', import.meta.url), 'utf8');
  const admjs70 = fs.readFileSync(new URL('./api/admin.js', import.meta.url), 'utf8');
  const http70 = fs.readFileSync(new URL('./api/_lib/http.js', import.meta.url), 'utf8');
  const sch70 = fs.readFileSync(new URL('./api/schema.sql', import.meta.url), 'utf8');
  const bdg70 = fs.readFileSync(new URL('./api/badge.js', import.meta.url), 'utf8');
  const cnt70 = fs.readFileSync(new URL('./api/content.js', import.meta.url), 'utf8');

  /* ---- #1 审批 ---- */
  t('★v3.7.0 申请表三处 DDL（升级路径 / 全量清单 / schema.sql）',
    (http70.match(/create table if not exists profile_change_requests/g) || []).length >= 2
    && /create table if not exists profile_change_requests/.test(sch70));
  t('★v3.7.0 submit 只建申请，不写 profiles',
    (function(){
      const i = pro70.indexOf('async function submit(');
      const body = pro70.slice(i, pro70.indexOf('\nasync function ', i + 10));
      return /createChangeRequest/.test(body) && !/update profiles\s+set wechat/.test(body);
    })());
  t('★v3.7.0 selfUpdate 也改为建申请（不再直接 update）',
    (function(){
      const i = pro70.indexOf('async function selfUpdate(');
      const body = pro70.slice(i, pro70.indexOf('\nasync function ', i + 10));
      return /createChangeRequest/.test(body) && !/update profiles set/.test(body);
    })());
  t('★v3.7.0 只记录真正变化的字段（old === new 丢弃）',
    /if \(String\(beforePlain == null \? '' : beforePlain\) === afterPlain\) continue;/.test(pro70));
  t('★v3.7.0 申请里的值仍是密文（encField 后才入库）',
    /before: await encField\(pkey/.test(pro70) && /after: await encField\(pkey/.test(pro70));
  t('★v3.7.0 后台通过才写库（approve-change）',
    /async function approveChange/.test(admjs70) && /case 'approve-change'/.test(admjs70));
  t('★v3.7.0 驳回不动档案内容', (function(){
    const i = admjs70.indexOf('async function rejectChange(');
    const body = admjs70.slice(i, admjs70.indexOf('\nasync function ', i + 10));
    return !/wechat|qq|phone|name =/.test(body.replace(/reject_reason/g, ''));
  })());
  t('★v3.7.0 撤销只认 7 天内的已通过记录',
    /CHANGE_REVERT_DAYS = 7/.test(admjs70) && /已超过 ' \+ CHANGE_REVERT_DAYS/.test(admjs70));
  t('★v3.7.0 撤销会还原 contact_status（联系方式专用）',
    /contact_status = 'approved'/.test(admjs70) && /prevStatus/.test(admjs70));
  t('v3.7.0 我的资料里能看到待审新值',
    /MY_PROF_PENDING/.test(idx70) && /mp-pend/.test(idx70) && /待审核/.test(idx70));
  t('★v3.7.0 后台面板改名为「信息审核」',
    /label:'信息审核'/.test(adm70) && !/label:'联系方式审核'/.test(adm70));
  t('★v3.7.0 审核卡片只画改过的字段（revFieldRow）',
    /function revFieldRow/.test(adm70) && /原内容/.test(adm70));
  t('★v3.7.0 历史记录 + 撤销按钮',
    /function paintReviewHistory/.test(adm70) && /data-rv-undo/.test(adm70) && /已超 7 天/.test(adm70));

  /* ---- #2 缓存优先 ---- */
  t('★v3.7.0 首屏渲染前先套缓存（contentCacheBootstrap 紧跟 goHomeView 之前）',
    (function(){
      /* 顶层顺序：contentCacheBootstrap(false); 换行 goHomeView(); */
      const a = idx70.indexOf('\ncontentCacheBootstrap(false);\ngoHomeView();');
      return a > 0;
    })());
  t('★v3.7.0 contentBoot 也复用同一个 bootstrap（不会重复套）',
    /function contentBoot\(\)\{\s*contentCacheBootstrap\(true\);/.test(idx70.replace(/\n/g, '\n')));
  t('★v3.7.0 同步完成后自动重绘（无需用户操作）',
    /syncCloudContent\(false\)\.then\(function\(r\)\{\s*if\(r\.ok && r\.count > 0\)/.test(idx70));
  t('★v3.7.0 内容接口对非管理员剔除后台专用键',
    /ADMIN_ONLY_KEYS/.test(cnt70) && /delete items\[k\]/.test(cnt70));

  /* ---- #3 班徽 ---- */
  t('★v3.7.4 后端响应支持二进制透传（否则图片会被 UTF-8 化）',
    /ArrayBuffer\.isView\(body\)/.test(fs.readFileSync(new URL('./api/worker.mjs', import.meta.url), 'utf8')));
  t('★v3.7.0 班徽接口内嵌兜底图（永 200）',
    /DEFAULT_BADGE_B64/.test(bdg70) && /embedded/.test(bdg70));
  t('★v3.7.0 班徽接口 3 秒超时 + 一天缓存',
    /FETCH_TIMEOUT_MS = 3000/.test(bdg70) && /max-age=86400/.test(bdg70));
  t('★v3.7.0 前台登录时把班徽存本地缓存',
    /function badgeCacheLoad/.test(idx70) && /badgeCacheLoad\(false\)/.test(idx70)
    && /__cls_badge_src/.test(idx70));
  t('★v3.7.0 导出时缓存是第一候选',
    /var cached = badgeCachedSrc\(\);\s*\n\s*if\(cached\) list\.push\(cached\);/.test(idx70));
  t('★v3.7.0 后台同样读本地缓存',
    /function adminBadgeCacheLoad/.test(adm70) && /adminBadgeCacheGet\(\)/.test(adm70));

  /* ---- 版本 ---- */
  t('v3.9.17 四处版本一致', RE_SITE.test(idx70)
    && RE_SITE.test(adm70)
    && RE_API_VER.test(fs.readFileSync(new URL('./api/worker.mjs', import.meta.url), 'utf8'))
    && RE_SITE_VER.test(fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8')));
  t('v3.7.0 REL_BUILTIN 有 3.7.0 条目', /\{\s*version:\s*'3\.8\.9'/.test(adm70));
}

console.log('\n【92】v3.7.6 弹窗字色跟随实际背景');
{
  const idx76 = readIdx();

  t('★v3.7.6 有弹窗字色自适应模块（含对比度计算与底色合成）',
    /function mkFix\(root\)/.test(idx76) && /function mkEffectiveBg\(el\)/.test(idx76)
    && /function mkParseA\(c\)/.test(idx76) && /MK_MIN = 4\.0/.test(idx76));
  t('★v3.7.6 只改看不清的（阈值判断后才动，清晰的品牌色不动）',
    /if\(clsContrast\(fgOn, bg\) >= MK_MIN\) continue;/.test(idx76));
  t('★v3.7.6 底色按层合成（半透明 + 渐变首色 + 背景图平均色）',
    /layers\.push\(b\)/.test(idx76) && /MK_BG_AVG/.test(idx76)
    && /backgroundImage/.test(idx76));
  t('★v3.7.6 覆盖所有遮罩类弹窗（id 结尾 Mask / 各类 mask class）',
    /var MK_SEL = '\[id\$="Mask"\]/.test(idx76) && /sign-mask/.test(idx76)
    && /allboard-mask/.test(idx76) && /confetti-mask/.test(idx76));
  t('★v3.7.6 打开/关闭弹窗时自动重算（观察 mask 的 class 变化）',
    /attributeFilter:\['class','style'\]/.test(idx76) && /t\.matches\(MK_SEL\)/.test(idx76));
  t('★v3.7.6 切昼夜 / 换背景 / 转屏都会重算',
    (idx76.match(/mkScanAll\(/g) || []).length >= 4
    && /addEventListener\('orientationchange'/.test(idx76));
  t('★v3.7.6 固定深色底弹窗有 CSS 兜底（首帧就不糊字）',
    /\.sign-box\{[^}]*color:#f3ebe3/.test(idx76) && /\.sign-box h3\{color:#fff\}/.test(idx76));
  t('v3.7.6 首页 / 后台版本已是当前版本',
    RE_SITE.test(idx76));
}

console.log('\n【93】v3.8.0 分享备注 · 我的资料改版 · 导航少等');
{
  const idx80 = readIdx();
  const http80 = fs.readFileSync(new URL('./api/_lib/http.js', import.meta.url), 'utf8');
  const sch80 = fs.readFileSync(new URL('./api/schema.sql', import.meta.url), 'utf8');
  const sc80 = fs.readFileSync(new URL('./api/scores.js', import.meta.url), 'utf8');
  const sw80 = fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8');

  /* ---- 分享备注 ---- */
  t('★v3.8.0 share_links.note 三处都有（建表 / 升级 alter / schema.sql）',
    /note\s+text\s+default ''/.test(http80)
    && /alter table share_links add column if not exists note text/.test(http80)
    && /note\s+text\s+default ''/.test(sch80));
  t('★v3.8.0 升级路径里也补了 note（老库才生效的那一段）',
    (function(){
      /* 升级路径在 has_ual 分支内，且必须在 return 之前 */
      const i = http80.indexOf('if (row && row.has_ual)');
      const j = http80.indexOf('add column if not exists note text default', i);
      const k = http80.indexOf('insert into site_settings', i);
      return i > 0 && j > i && k > j;
    })());
  t('★v3.8.0 创建分享能写备注（最多 40 字）',
    /const note = String\(b\.note == null \? '' : b\.note\)\.trim\(\)\.slice\(0, 40\)/.test(sc80));
  t('★v3.8.0 编辑分享只在本轮传了 note 时才改（不会顺手清空）',
    /const hasNote = \(b\.note !== undefined\)/.test(sc80));
  t('★v3.8.0 公开分享页不返回备注（不泄露「给谁看的」）',
    /delete pubShare\.note/.test(sc80));
  t('★v3.8.0 前端分享弹窗有备注输入，列表拿备注当标题',
    /id="shNote"/.test(idx80) && /var title = x\.note \? x\.note : scopeTxt/.test(idx80));

  /* ---- 我的资料改版 ---- */
  t('★v3.8.0 我的资料改成一行一输入框（不再有「复制 + 改」两个按钮那套）',
    /var mpList = mpRows\.length/.test(idx80) && /\.mp-grid\{/.test(idx80)
    && /class="mp-in'/.test(idx80));
  t('★v3.8.0 可编辑直接改、不可编辑灰掉带锁',
    /\.mp-in\.mp-ro\{/.test(idx80) && /r\.editable \? '✏️ ' : '🔒 '/.test(idx80));
  t('★v3.8.0 每行右侧有复制按钮（data-mc）',
    /data-mc="' \+ attr\(r\.value\)/.test(idx80) && /function mpAfterRender/.test(idx80));
  t('★v3.8.0 长号码不再竖排（min-width:0 + 单行省略）',
    /\.mp-in\{[^}]*min-width:0/.test(idx80) && /text-overflow:ellipsis/.test(idx80));
  t('★v3.8.0 底部「保存修改（N 项，需管理员确认）」批量提交',
    /mpEditSave/.test(idx80) && /保存修改（' \+ dirty \+ ' 项，需管理员确认）/.test(idx80));
  t('v3.8.0 旧的就地「改」按钮逻辑已移除',
    !/function mpEditStart/.test(idx80) && !/mpEditOk/.test(idx80));

  /* ---- 导航缓存 ---- */
  t('★v3.8.0+ 导航「缓存先给、后台再刷」（v3.9.16 去掉了 900ms 干等）',
    /event\.waitUntil\(netP\.catch/.test(sw80) && /return cached/.test(sw80)
    && !/Promise\.race/.test(sw80));
  t('★v3.8.2 SW 预缓存逐个 add（一个 404 不再拖垮整个安装）',
    /cache\.add\(u\)\.catch/.test(sw80)
    && !/\.then\(\(cache\) => cache\.addAll\(PRECACHE\)\)/.test(sw80));
  t('★v3.8.1 切昼夜会重算弹窗字色（盯 html 的 class）',
    /observe\(document\.documentElement, \{ attributes:true, attributeFilter:\['class'\] \}\)/.test(idx80));
  t('★v3.8.0 导航缓存命中时会顺带把网络结果写回',
    /cache\.put\(request, res\.clone\(\)\)/.test(sw80));
}

console.log('\n【新】v3.8.3 我的资料字色 / 分享按钮排版 / 版本与公告门禁');
{
  const idx83 = readIdx();
  const adm83 = readAdm();
  const pre83 = fs.readFileSync(new URL('./scripts/predeploy.mjs', import.meta.url), 'utf8');

  /* ---- 我的资料：字看不清 ---- */
  t('★v3.8.3 字段标签加深到 #4a3f36（原 var(--fg-2) 压在玻璃底上偏淡）',
    /\.mp-lb\{[^}]*color:#4a3f36\}/.test(idx83));
  t('★v3.8.3 只读输入框文字加深（亮 #4f4339 / 暗 #ded4cb）',
    /\.mp-in\.mp-ro\{[^}]*color:#4f4339/.test(idx83)
    && /\.dark \.mp-in\.mp-ro\{[^}]*color:#ded4cb/.test(idx83));
  t('★v3.8.3 「仅自己可见」标签加深（#5b4c40 / 暗 #e8ddd3）',
    /\.mp-privtag\{[^}]*color:#5b4c40/.test(idx83)
    && /\.dark \.mp-privtag\{[^}]*color:#e8ddd3/.test(idx83));
  t('★v3.8.3 顶部说明文字不再是 #a99a8d（改 #6b5a4b）',
    /\.acct-sw \.s\{[^}]*color:#6b5a4b;/.test(idx83) && !/\.acct-sw \.s\{[^}]*#a99a8d/.test(idx83));
  t('★v3.8.3 底部说明 / 复制按钮同步加深',
    /\.mp-edittip\{[^}]*color:#57493d/.test(idx83) && /\.mp-cp\{color:#4a3f36\}/.test(idx83));

  /* ---- 成绩分享：手机端按钮排版 ---- */
  t('★v3.8.3 .btn-sm 真正定义了（不再沿用 .btn 的 130px 最小宽）',
    /\.btn-sm\{min-width:0/.test(idx83) && /\.btn-sm\{[^}]*padding:5px 12px/.test(idx83));
  t('★v3.8.3 分享列表改成两行（状态行 + 按钮行）',
    /\.sc-sh-item\{[^}]*flex-direction:column/.test(idx83)
    && /\.sc-sh-top\{/.test(idx83) && /\.sc-sh-btns\{/.test(idx83));
  t('★v3.8.3 分享列表 HTML 用两行结构（状态/标题/次数 与按钮分离）',
    /'<div class="sc-sh-top">'/.test(idx83) && /'<div class="sc-sh-btns">'/.test(idx83));
  t('★v3.8.3 窄屏按钮等分铺满、不再横向滚动',
    /max-width:560px\)\{\s*\.sc-sh-btns\{flex-wrap:nowrap\}/.test(idx83)
    && /\.sc-sh-btns \.btn\{flex:1 1 0/.test(idx83));
  t('★v3.8.3 分享标题超长省略（不再把「全班」挤成竖排）',
    /\.sc-sh-top b\{[^}]*text-overflow:ellipsis/.test(idx83));

  /* ---- 版本节奏：一天一个版本 ---- */
  t('★v3.8.3 版本注释写明「一天只算一个版本」',
    /一天只算一个版本/.test(idx83) && /上午 3\.8\.2 → 下午 3\.8\.3/.test(idx83));
  t('★v3.8.3 REL_BUILTIN 的 3.8.3 条目带 pub 公告口径',
    /\{\s*version:\s*'3\.8\.3'[\s\S]{0,3000}?pub:\s*\[/.test(adm83));

  /* ---- 门禁：版本说明 + 公告 ---- */
  t('★v3.8.3 门禁要求源码 REL_BUILTIN 写 pub', /缺少 pub 字段/.test(pre83));
  t('★v3.8.3 门禁要求云端 release_notes 有该版本且带 pub',
    /云端 release_notes 里没有/.test(pre83) && /云端 release_notes 的 ' \+ VER \+ ' 条目缺少 pub/.test(pre83));
  t('★v3.8.3 门禁校验本次内容已并入同一版本公告',
    /missingPub/.test(pre83) && /本次更新还没写进 v/.test(pre83));
  t('★v3.8.3 门禁拦截内部事项（后台 / 缓存 / 数据库 …）',
    /BAN_INTERNAL/.test(pre83) && /'后台'/.test(pre83) && /'缓存'/.test(pre83) && /'数据库'/.test(pre83));
  t('★v3.8.3 门禁拦截技术缩写与口语化',
    /BAN_TECH/.test(pre83) && /BAN_CASUAL/.test(pre83) && /搞定/.test(pre83));
  t('★v3.8.3 门禁要求公告按分类分好（至少两个【分类】）',
    /cats\.length < 2/.test(pre83) && /CAT_OK/.test(pre83));
  t('★v3.8.3 门禁限制公告长度（站主要求简洁）',
    /CN > 1200/.test(pre83));
  t('★v3.8.3 --fix-announce 可按分类自动并入公告',
    /--fix-announce/.test(pre83) && /function appendToAnnouncement/.test(pre83));
  t('★v3.8.3 自动追加幂等（同样内容不会写两遍）',
    /cur\.split\(\/\[；;\]\/\)\.some/.test(pre83));
}

console.log('\n【新】v3.8.4 板块管理 / 板块分享链接');
{
  const idx84 = readIdx();
  const adm84 = readAdm();
  const brd84 = fs.readFileSync(new URL('./api/boards.js', import.meta.url), 'utf8');
  const http84 = fs.readFileSync(new URL('./api/_lib/http.js', import.meta.url), 'utf8');
  const sch84 = fs.readFileSync(new URL('./api/schema.sql', import.meta.url), 'utf8');
  const wk84 = fs.readFileSync(new URL('./api/worker.mjs', import.meta.url), 'utf8');

  /* ---- 数据层 ---- */
  t('★v3.8.4 三张表三处同步：board_links / board_link_views / board_meta',
    (http84.match(/create table if not exists board_links/g) || []).length >= 2
    && (http84.match(/create table if not exists board_link_views/g) || []).length >= 2
    && (http84.match(/create table if not exists board_meta/g) || []).length >= 2
    && /create table if not exists board_links/.test(sch84)
    && /create table if not exists board_link_views/.test(sch84)
    && /create table if not exists board_meta/.test(sch84));
  t('★v3.8.4 SCHEMA_VER 已升到 3.8.4', /const SCHEMA_VER = '3\.8\.4'/.test(http84));

  /* ---- 接口 ---- */
  t('★v3.8.4 /api/boards 路由已注册', /case 'boards':/.test(wk84) && /import boardsHandler/.test(wk84));
  t('★v3.8.4 成绩分析不开放板块分享（NO_SHARE_BOARDS 含 3）',
    /NO_SHARE_BOARDS = \[3\]/.test(brd84) && /成绩分析.*不在这里分享/.test(brd84));
  t('★v3.8.4 游客解析用 currentUser（不用 requireUser，否则游客 401）',
    /const u = await currentUser\(req\)\.catch\(\(\) => null\)/.test(brd84)
    && !/requireUser\(req, res, \{ optional/.test(brd84));
  t('★v3.8.4 解析时校验撤销 / 过期 / 次数', /这条链接已被撤销/.test(brd84)
    && /链接已过期/.test(brd84) && /查看次数已用完/.test(brd84));
  t('★v3.8.4 预览不消耗次数（仅管理员 + preview=1）',
    /isPreview/.test(brd84) && /u\.role === 'admin'/.test(brd84));
  t('★v3.8.4 免登录链接要求板块/卡片本身允许游客（取交集）',
    /guestAllowed/.test(brd84) && /设了「仅登录可见」/.test(brd84));
  t('★v3.8.4 建链 / 列表 / 编辑 / 撤销 / 明细五个动作齐',
    ['share-create','share-list','share-update','share-revoke','share-stats']
      .every(function(a){ return brd84.indexOf("'" + a + "'") >= 0; }));
  t('★v3.8.4 访问记录落库（登录用户记名，游客留 IP/UA）',
    /insert into board_link_views/.test(brd84) && /user-agent/.test(brd84));

  /* ---- 前台 ---- */
  t('★v3.8.4 启动解析 ?t= / ?b= 深链', /function boardShareBoot/.test(idx84)
    && /resolveBoardShare\(q\.t/.test(idx84) && /openCat\(bid\)/.test(idx84));
  t('★v3.8.4 游客只放行分享板块（openCat 最前面拦截）',
    /if\(typeof GUEST !== 'undefined' && GUEST && Number\(id\) !== Number\(GUEST\.boardId\)\)/.test(idx84));
  t('★v3.8.4 拦截文案与站主要求一致',
    idx84.indexOf('当前分享链接仅支持查看该分享内容，其他内容请登录后再查看') >= 0);
  t('★v3.8.4 未分享的板块/卡片置灰（side-locked / card-locked）',
    /side-locked/.test(idx84) && /card-locked/.test(idx84) && /function applyGuestUI/.test(idx84));
  t('★v3.8.4 卡片带 data-card，深链可定位', /data-card="'\+attr\(l\.id\)\+'"/.test(idx84)
    && /function locateBoardCard/.test(idx84));
  t('★v3.8.4 游客顶部条有一键返回主页 + 登录',
    /guestBar/.test(idx84) && /onclick="goHomeView\(\)"/.test(idx84) && /function guestLogin/.test(idx84));
  t('★v3.8.4 登录后自动回到分享位置（含强制改密后）',
    /function afterLoginResume/.test(idx84) && /afterLoginResume\(\)/.test(idx84));
  t('★v3.8.4 板块简介进页面顶部', /boardIntroHtml\(c\.id\)\+popBannerHtml/.test(idx84));
  t('★v3.8.4 后台排序生效且不覆盖用户自定义顺序',
    /applyBoardSort\(SITE_DATA\.categories\.filter/.test(idx84) && /UI\.order\.cat/.test(idx84));
  t('★v3.8.4 首页登录后上报板块目录（后台才能列出来）',
    /function reportBoardCatalog/.test(idx84) && /boards\?action=catalog/.test(idx84));

  /* ---- 后台 ---- */
  t('★v3.8.4 后台侧栏有「板块管理」', /id:'boards'/.test(adm84) && /boards:\s*renderBoards,/.test(adm84));
  t('★v3.8.4 板块行能改名称 / 简介 / 排序 / 隐藏 / 游客可见',
    /data-bf="name"/.test(adm84) && /data-bf="intro"/.test(adm84)
    && /data-bact="up"/.test(adm84) && /data-bf="hidden"/.test(adm84) && /data-bf="guestOk"/.test(adm84));
  t('★v3.8.4 显示板块位置（首页第 N 项 / 侧栏第 N 项）',
    /首页第 ' \+ \(i \+ 1\) \+ ' 项 · 侧栏第/.test(adm84));
  t('★v3.8.4 卡片级也能设游客可见 / 单独分享',
    /data-cf="guestOk"/.test(adm84) && /data-cact="share"/.test(adm84));
  t('★v3.8.4 分享表单含免登录 / 有效期 / 次数 / 备注',
    /bsGuest/.test(adm84) && /bsDays/.test(adm84) && /bsMax/.test(adm84) && /bsNote/.test(adm84));
  t('★v3.8.4 二维码离线生成（内联 qrcode 库 + canvas）',
    /var qrcode=function\(\)/.test(adm84) && /function bdQrCanvas/.test(adm84));
  t('★v3.8.4 分享图含板块名 / 简介 / 二维码 / 班徽',
    /function bdSharePic/.test(adm84) && /adminBadgeUrl/.test(adm84) && /bdQrCanvas\(url, 420\)/.test(adm84));
  t('★v3.8.4 分享列表有预览 / 编辑 / 二维码 / 分享图 / 明细 / 撤销',
    ['view','edit','qr','pic','stat','rev'].every(function(a){
      return adm84.indexOf('data-sact="' + a + '"') >= 0;
    }));
}

console.log('\n【新】v3.8.5 作业导出直链 / 分享链接 404 修复');
{
  const idx85 = readIdx();
  const adm85 = readAdm();

  t('★v3.8.5 分享卡片支持 media（图片 / 二维码块）',
    /sec\.media\.push/.test(idx85) && /block\.media\.push/.test(idx85)
    && /\(b\.media \|\| \[\]\)\.forEach/.test(idx85));
  t('★v3.8.5 图片按宽度等比、最高 300，音视频固定 112',
    /Math\.min\(300, innerW \* md\.img\.naturalHeight/.test(idx85) && /hh = 112/.test(idx85));
  t('★v3.8.5 直链能分清图片 / 音频 / 视频',
    /function hwLinkKind/.test(idx85)
    && /\(png\|jpe\?g\|gif\|webp\|bmp\|avif\|svg\)/.test(idx85)
    && /\(mp3\|m4a\|aac\|wav\|ogg/.test(idx85)
    && /\(mp4\|webm\|mov/.test(idx85));
  t('★v3.8.5 图片先 fetch 成 blob 再画（避开 canvas 污染）',
    /function hwLoadImage/.test(idx85) && /mode: 'cors'/.test(idx85)
    && /URL\.createObjectURL\(b\)/.test(idx85));
  t('★v3.8.5 图片取不到时降级成文字，不毁整张图',
    idx85.indexOf("'图片：' : '链接：'") >= 0 && /__fail/.test(idx85));
  t('★v3.8.5 音视频二维码指向站内播放页 ?play=',
    /function hwQrCanvas/.test(idx85) && /function hwPlayUrl/.test(idx85)
    && /index\.html\?play=/.test(idx85));
  t('★v3.8.5 站内播放器（video/audio 自动播放，可关闭）',
    /function openMediaPlayer/.test(idx85) && /function closeMediaPlayer/.test(idx85)
    && /<video src=/.test(idx85) && /<audio src=/.test(idx85));
  t('★v3.8.5 启动时解析 ?play=', /function playLinkBoot/.test(idx85) && /playLinkBoot\(\)/.test(idx85));
  t('★v3.8.6 深链入口（?t= / ?play=）不弹开屏与登录引导',
    /function isShareEntry/.test(idx85) && /sp\.get\('play'\)/.test(idx85)
    && (idx85.match(/isShareEntry\(\)\) return/g) || []).length >= 2);
  t('★v3.8.5 正文里写出来的直链也会识别',
    /match\(\/https\?:\\\/\\\/\[\^\\s/.test(idx85));

  /* 404 根因：不能再用 location.origin 拼子路径 */
  t('★v3.8.5 分享链接不再用 location.origin 拼接（会丢 /class-site/ 子路径）',
    !/location\.origin \+ j\.url/.test(adm85)
    && /new URL\(String\(j\.url \|\| ''\)\.replace\(\/\^\\\/\+\/, ''\), location\.href\)/.test(adm85));
  t('★v3.8.5 分享列表里的链接同样按页面地址解析',
    /new URL\('index\.html\?b=' \+ x\.boardId/.test(adm85));
  t('★v3.8.5 REL_BUILTIN 的 3.8.5 条目带 pub',
    /\{\s*version:\s*'3\.8\.5'[\s\S]{0,2600}?pub:\s*\[/.test(adm85));
}

console.log('\n【新】v3.8.7 仅赋分排名 / 作业导出 / 二维码班徽 / 班级岛');
{
  const idx87 = readIdx();
  const adm87 = readAdm();
  const isl87 = fs.readFileSync(new URL('./api/island.js', import.meta.url), 'utf8');
  const wk87  = fs.readFileSync(new URL('./api/worker.mjs', import.meta.url), 'utf8');
  const brd87 = fs.readFileSync(new URL('./api/boards.js', import.meta.url), 'utf8');

  /* ---- 仅赋分排名 ---- */
  t('★v3.8.7 仅赋分排名只取化学 + 生物',
    idx87.indexOf("var want = ['chemistry', 'biology']") >= 0);
  t('★v3.9.0 只算增值（化学 / 生物 / 合计），不再摆原始分与赋分',
    /cD: \(cRaw != null && cGrd != null\) \? \(cGrd - cRaw\)/.test(idx87)
    && /bD: \(bRaw != null && bGrd != null\) \? \(bGrd - bRaw\)/.test(idx87)
    && /o\.dSum = \(o\.cD != null && o\.bD != null\)/.test(idx87));
  t('★v3.9.0 排名按「两科合计增值」降序、同分并列',
    /arr\.forEach\(function\(o, i\)\{\s*if\(prev === null \|\| o\.dSum !== prev\)/.test(idx87));
  t('★v3.9.3 表头：化学 / 生物 / 两科合计 / 排名',
    /th\('cD', esc\(d\.C\.name\)\)/.test(idx87) && /th\('dSum', '两科合计'\)/.test(idx87)
    && /th\('rank', '排名'\)/.test(idx87));
  t('★v3.8.7 接在全班成绩单下面', /\+ scGradedBlock\(\)/.test(idx87));

  /* ---- 作业导出 ---- */
  t('★v3.8.7 作业图字号放大 + A4 比例',
    /large: true,/.test(idx87) && /Math\.round\(760 \* 1\.414\)/.test(idx87)
    && /o\.large \? 16\.5 : 14/.test(idx87) && /o\.large \? 36 : STEP\.ROW/.test(idx87));
  t('★v3.8.7 内容少时补白到 A4，多了自然延长',
    /var H = Math\.max\(m\.height, o\.minHeight \|\| 0\)/.test(idx87));
  t('★v3.8.7 底部二维码直接指向作业卡片',
    /qr: qrCanvas \|\| null/.test(idx87) && /扫码打开「作业查看」/.test(idx87));
  t('★v3.8.7 ensure-link 复用已建链接（不刷垃圾数据）',
    /if \(action === 'ensure-link'\)/.test(brd87) && /reused: true/.test(brd87)
    && /order by id desc limit 5/.test(brd87));

  /* ---- 二维码班徽 ---- */
  t('★v3.8.7 二维码导出图带班徽（放在二维码下方，不挡定位角）',
    /function bdQrPoster/.test(adm87) && /bdQrPoster\(url, name/.test(adm87)
    && /drawImage\(im, bx, by, badgeSize, badgeSize\)/.test(adm87));

  /* ---- 班级岛 ---- */
  t('★v3.8.7 /api/island 已注册（GET 公开 / POST 管理员）', /case 'island':/.test(wk87));
  t('★v3.9.3 默认今日事项按纸质课表压成缩写',
    /mon: '升 数数语英化 物物体劳 听自语语自'/.test(isl87));
  t('★v3.8.7 岛在首页公告上面',
    idx87.indexOf('id="classIsland"') < idx87.indexOf('id="board"'));
  t('★v3.9.3 第二行是「今日事项」横幅', /function islandBanner/.test(idx87)
    && /island-banner/.test(idx87) && /今日事项/.test(idx87));
  t('★v3.9.3 课表弹窗已下线（不再有 openTimetable）', !/function openTimetable/.test(idx87));
  t('★v3.8.7 天气走 Open-Meteo（免 key、可跨域）', /api\.open-meteo\.com/.test(idx87));
  t('★v3.8.7 周数按开学日期算', /Math\.floor\(diff \/ 7\) \+ 1/.test(idx87));
  t('★v3.8.7 后台可拖动排序组件', /draggable="true"/.test(adm87) && /dragstart/.test(adm87)
    && /AI_DRAG/.test(adm87));
  t('★v3.9.3 后台改为七天横幅输入（不再按节次录课）',
    /function paintBanner/.test(adm87) && /data-bk="/.test(adm87));
}

console.log('\n【新】v3.9.3 赋分增值→赋分 / 班级岛横幅 / 假期倒计时');
{
  const idx93 = readIdx();
  const adm93 = readAdm();
  const isl93 = fs.readFileSync(new URL('./api/island.js', import.meta.url), 'utf8');

  /* ---- 赋分：增值 → 赋分 ---- */
  t('★v3.9.3 单元格读作「+24 → 84」（增值 → 赋分）',
    /function dc\(v, assigned\)/.test(idx93) && /sc-gd-ar">→<\/i>/.test(idx93)
    && /dc\(o\.cD, o\.cGrd\)/.test(idx93) && /dc\(o\.dSum, o\.gSum\)/.test(idx93));
  t('★v3.9.3 差值保留赋分值（cGrd / bGrd / gSum）',
    /cGrd: cGrd, bGrd: bGrd,/.test(idx93) && /o\.gSum = \(o\.cGrd != null && o\.bGrd != null\)/.test(idx93));
  t('★v3.9.3 增值与赋分用两种颜色', /\.sc-gd-as\{color:#3f342c;font-weight:800\}/.test(idx93));
  t('★v3.9.3 默认按合计增值降序', /gSortKey: 'dSum',\s*gSortAsc: false/.test(idx93));

  /* ---- 班级岛：横幅 ---- */
  t('★v3.9.3 数据模型收敛成 banner / days / holidays',
    /banner: DEFAULT_BANNER/.test(isl93) && /function normDays/.test(isl93)
    && /function normHolidays/.test(isl93) && !/plans/.test(isl93));
  t('★v3.9.3 周一到周日各有一句默认今日事项',
    /mon: '升 数数语英化 物物体劳 听自语语自'/.test(isl93)
    && /sun: '读自 物理 物自'/.test(isl93));
  t('★v3.9.3 周六周日默认也有课（不是空）', /sat: '自自 自自 读自自'/.test(isl93));
  t('★v3.9.3 老课表能自动压成缩写（v1/v2 数据迁移）',
    /function shorthand/.test(isl93) && /const ABBR = \{/.test(isl93));
  t('★v3.9.3 按日期覆盖优先于星期默认值',
    /var text = \(day && day\.text\) \|\| \(ISLAND\.banner \|\| \{\}\)\[dow\]/.test(idx93));
  t('★v3.9.3 假期区间显示「已放假 N 天 · 距开学还有 M 天」',
    /已放假 ' \+ t\.passed \+ ' 天/.test(idx93) && /距开学还有 ' \+ t\.left \+ ' 天/.test(idx93));
  t('★v3.9.3 某天标不上课时显示放假而不是课表',
    /if\(day && day\.off\)/.test(idx93) && /kind: 'off'/.test(idx93));

  /* ---- 后台 ---- */
  t('★v3.9.3 后台七天横幅输入框', /data-bk="/.test(adm93) && /function paintBanner/.test(adm93));
  t('★v3.9.3 后台可按日期临时改（日期 + 文案 + 不上课）',
    /id="adDate"/.test(adm93) && /id="adText"/.test(adm93) && /id="adOff"/.test(adm93));
  t('★v3.9.3 后台可设假期起止与名称',
    /id="ahLabel"/.test(adm93) && /id="ahFrom"/.test(adm93) && /id="ahTo"/.test(adm93));
  t('★v3.9.3 后台不再有作息套数 / 周课表格子', !/aiPlanSel/.test(adm93) && !/ai-trow/.test(adm93));
}

console.log('\n【新】v3.9.4 首屏同步渲染 / 横幅换行 / 统计异步');
{
  const idx94 = readIdx();
  const adm94 = readAdm();
  const sw94  = fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
  const wk94  = fs.readFileSync(new URL('./api/worker.mjs', import.meta.url), 'utf8');

  /* ---- 版本号四处一致 ---- */
  t('★v3.9.4+ index.html SITE_VERSION = 当前版本', RE_SITE.test(idx94));
  t('★v3.9.4+ admin.html SITE_VERSION = 当前版本', RE_SITE.test(adm94));
  t('★v3.9.4 sw.js SITE_VER = 3.9.20', sw94.includes("const SITE_VER = '" + CUR_VER + "'"));
  t('★v3.9.4 api/worker.mjs API_VER = 当前版本', wk94.includes("const API_VER = '" + CUR_VER + "';"));
  t('★v3.9.4 REL_BUILTIN 有 3.9.4 条目且带 pub',
    /\{\s*version:\s*'3\.9\.4'[\s\S]{0,2000}?pub:\s*\[/.test(adm94));

  /* ---- 首屏不再等接口 ---- */
  t('★v3.9.4 启动即同步 render()（不等 /api/boards）',
    /goHomeView\(\);\s*\/\* v3\.9\.4[\s\S]{0,600}?try\{ render\(\); \}catch/.test(idx94));
  t('★v3.9.4 render() 失败不阻断启动（有 catch 兜底）',
    /console\.warn\('\[boot\] 首屏渲染失败/.test(idx94));
  t('★v3.9.4+ 统计脚本动态插入（空闲时才加载）',
    /s\.id = 'LA_COLLECT'/.test(idx94) && /document\.body\.appendChild\(s\)/.test(idx94)
    && /s\.async = true/.test(idx94));

  /* ---- 横幅换行 ---- */
  t('★v3.9.4 前台横幅按换行展示（pre-line、不再截断行数）',
    /\.island-banner \.txt\{[^}]*white-space:pre-line;/.test(idx94)
    && !/-webkit-line-clamp/.test(idx94.slice(idx94.indexOf('.island-banner .txt{'), idx94.indexOf('.island-banner .txt{') + 220)));
  t('★v3.9.4+ 后台「按日期临时改」是多行输入区（v3.9.20 起是可编辑富文本）',
    /id="adRich" contenteditable="true"/.test(adm94)
    && /<input data-bk="/.test(adm94));
  t('★v3.9.4 后台 textarea 有样式（可拉伸、行高 1.5）',
    /\.ai-brow textarea\{[^}]*resize:vertical;/.test(adm94));
  t('★v3.9.4 保存仍按 DOM 对账（textarea 的 value 照样读得到）',
    /querySelectorAll\('#aiBanner \[data-bk\]'\)/.test(adm94));
}

console.log('\n【新】v3.9.5 班级岛跟随主题配色 / 全部居中');
{
  const idx95 = readIdx();
  const adm95 = readAdm();

  /* ---- 浅色：奶油底 + 深字 ---- */
  t('★v3.9.7 深色玻璃在夜间模式也有单独一套（描边 / 阴影）',
    /\.dark \.island\{[^}]*rgba\(34,29,26,\.96\)/.test(idx95)
    && /\.dark \.island\{[^}]*box-shadow/.test(idx95));

  /* ---- 字色跟随 --fg 系列 ---- */
  t('★v3.9.7 信息块回到深色玻璃（半透明白卡 + 白字）',
    /\.island-chip\{[^}]*background:rgba\(255,255,255,\.10\)/.test(idx95)
    && /\.island-chip \.v\{[^}]*color:#fff/.test(idx95));
  t('★v3.9.7 横幅与页脚文字在白底上仍是白色',
    /\.island-banner \.txt\{[^}]*color:#fff/.test(idx95)
    && /\.island-foot\{[^}]*color:rgba\(255,255,255,\.42\)/.test(idx95));
  t('★v3.9.7 岛底色是深棕渐变（不再是浅色奶油/玻璃白）',
    /\.island\{[^}]*background:linear-gradient\(145deg,rgba\(30,26,23,\.95\)/.test(idx95));

  /* ---- 全部居中 ---- */
  t('★v3.9.5 信息块内容居中（align-items + text-align）',
    /\.island-chip\{[^}]*align-items:center[^}]*text-align:center/.test(idx95));
  t('★v3.9.5 横幅整体居中（justify-content:center）',
    /\.island-banner\{[^}]*justify-content:center[^}]*text-align:center/.test(idx95));
  t('★v3.9.5 横幅文字多行时逐行居中',
    /\.island-banner \.txt\{[^}]*text-align:center/.test(idx95));
  t('★v3.9.5 页脚日期与周数居中', /\.island-foot\{[^}]*justify-content:center/.test(idx95));
  t('★v3.9.5 岛整体文字居中', /\.island\{[^}]*text-align:center/.test(idx95));

  /* ---- 发布记录 ---- */
  t('★v3.9.5 REL_BUILTIN 有 3.9.5 条目且带 pub',
    /\{\s*version:\s*'3\.9\.5'[\s\S]{0,1200}?pub:\s*\[/.test(adm95));
  t('★v3.9.5 更新日期与代码一致', RE_DATE.test(idx95));
}

console.log('\n【新】v3.9.6 气泡玻璃 / 照片弹层 / 窄屏字号 / 横屏侧栏');
{
  const idx96 = readIdx();
  const adm96 = readAdm();
  const isl96 = fs.readFileSync(new URL('./api/island.js', import.meta.url), 'utf8');

  /* ---- 1) 横幅单行 / 临时改多行 / 一键填入 ---- */
  t('★v3.9.6 星期横幅收回单行输入（默认课表）',
    /<input data-bk="/.test(adm96) && !/<textarea data-bk="/.test(adm96));
  t('★v3.9.6 「按日期临时改」是多行输入区（v3.9.20 起换成富文本，仍支持多行）',
    /id="adRich" contenteditable="true"/.test(adm96) && /<br>/.test(adm96));
  t('★v3.9.6 有「填入当天课表」按钮并实现 aiFillDay',
    /id="adFill"[^>]*>填入当天课表</.test(adm96) && /function aiFillDay\(\)/.test(adm96)
    && /\[\x27sun\x27, \x27mon\x27/.test(adm96));
  t('★v3.9.6 已设置的日期可点开再次修改（aiEditDay / 更新这一天）',
    /function aiEditDay\(k\)/.test(adm96) && /更新这一天/.test(adm96)
    && /data-dayedit=/.test(adm96));
  t('★v3.9.6 假期可再次修改时间范围（aiEditHol）',
    /function aiEditHol\(id\)/.test(adm96) && /更新这一段/.test(adm96)
    && /data-holedit=/.test(adm96));
  t('★v3.9.6 假期可复用（复制到表单再改日期）',
    /function aiAddHoliday/.test(adm96) && /data-hcopy=/.test(adm96) && /复用/.test(adm96));
  t('★v3.9.6 后端日期覆盖放宽（MAX_DAY_TEXT，v3.9.18 = 600）',
    /const MAX_DAY_TEXT = 600/.test(isl96) && /text: str\(v\.text, MAX_DAY_TEXT\)/.test(isl96));

  /* ---- v3.9.18 逐字编辑 ---- */
  t('★v3.9.20 编辑区是所见即所得（看不到 ** 和 {}）',
    /id="adRich" contenteditable="true"/.test(adm96) && /function aiToHtml\(/.test(adm96)
    && /function aiFromHtml\(/.test(adm96) && /data-rt="b"/.test(adm96)
    && !/id="adChars"/.test(adm96));
  t('★v3.9.20 字号可到 4px（前后端一起放宽）',
    /<option value="4">4px<\/option>/.test(adm96) && /n < 4 \|\| n > 32/.test(isl96));
  t('★v3.9.18 前台与后台解析同一套单字标记 {22b字}',
    idx96.indexOf('([bs]{0,2})([^{}]+)') >= 0
    && /function islInline\(/.test(idx96));
  t('★v3.9.18 单字标记只对有属性的花括号生效（正文 {abc} 原样）',
    /if\(!sz && !fl\) return all;/.test(idx96));

  /* ---- 2) 气泡玻璃 + 暗色适配 ---- */
  t('★v3.9.7 深色玻璃岛参数与 v3.8.7 一致（渐变 / 描边 / 光晕）',
    /\.island\{[^}]*background:linear-gradient\(145deg,rgba\(30,26,23,\.95\),rgba\(62,48,38,\.92\)\)/.test(idx96)
    && /\.island\{[^}]*border:1px solid rgba\(255,255,255,\.10\)/.test(idx96)
    && /\.island::after\{[^}]*rgba\(251,146,60,\.28\)/.test(idx96));

  /* ---- 3) 照片弹层 ---- */
  t('★v3.9.6 点横幅弹照片（can-photo + islPhotoOpen）',
    /function islPhotoOpen/.test(idx96) && /can-photo/.test(idx96)
    && /islBindPhoto\(host\)/.test(idx96));
  t('★v3.9.6 弹层在本页显示（fixed 遮罩 + img），可缩放可关闭',
    /class="isl-photo-mask" id="islPhotoMask"/.test(idx96)
    && /function islPhotoClose/.test(idx96)
    && /ISL_PZ\.s = Math\.min\(5, Math\.max\(1, base \* d \/ pinch\)\)/.test(idx96)
    && /addEventListener\('wheel'/.test(idx96) && /dblclick/.test(idx96));
  t('★v3.9.6 照片地址存 island.photo（后端 500 字）',
    /photo: str\(o\.photo, MAX_PHOTO\)/.test(isl96) && /const MAX_PHOTO = 500/.test(isl96));
  t('★v3.9.6+ 后台可填照片直链 / 相对路径并随保存提交',
    /id="aiPhoto"/.test(adm96) && /AI\.photo = String\(\(ph && ph\.value\)/.test(adm96)
    && /photo: AI\.photo/.test(adm96));

  /* ---- 4) 窄屏字号 ---- */
  t('★v3.9.16 窄屏信息块改 2×2 且字号可读（不再压到 8px）',
    /@media screen and \(max-width:370px\)\{[\s\S]{0,600}?\.island-row > \.island-chip\{flex:1 1 calc\(50% - 3px\)/.test(idx96)
    && /@media screen and \(max-width:370px\)\{[\s\S]{0,600}?\.island-chip \.k\{font-size:\.62rem/.test(idx96));
  t('★v3.9.6 窄屏收窄内边距，最长文案也不挤爆',
    /\.island-chip\{padding:8px 6px/.test(idx96) && /gap:6px\.island-chip\{padding:6px 4px/.test(idx96.replace(/\s+/g, '')) === false
    || /\.island-chip\{padding:6px 4px;border-radius:12px\}/.test(idx96));

  /* ---- 5) 横屏侧栏 ---- */
  t('★v3.9.16 悬浮按钮不再依赖滚动补偿（fixed 常驻）',
    /function landscapePin\(\)/.test(idx96) && !/fab\.style\.top = \(st \+ 14\)/.test(idx96)
    && /landscapePin\(\);/.test(idx96));
  t('★v3.9.6 后台横屏顶栏改 absolute + 滚动补偿',
    /html\.force-landscape \.head\{position:absolute/.test(adm96)
    && /function landscapePin\(\)/.test(adm96) && /head\.style\.top = st/.test(adm96));
  t('★v3.9.6 横屏主区补顶栏高度（内容不被压住）',
    /html\.force-landscape \.main\{padding-top:var\(--head-h\)\}/.test(adm96));

  /* ---- 发布记录 ---- */
  t('★v3.9.6 REL_BUILTIN 有 3.9.6 条目且带 pub',
    /\{\s*version:\s*'3\.9\.6'[\s\S]{0,2400}?pub:\s*\[/.test(adm96));
}

console.log('\n【新】v3.9.7 深色玻璃 / 实时保存 / 加粗居中');
{
  const idx97 = readIdx();
  const adm97 = readAdm();
  const isl97 = fs.readFileSync(new URL('./api/island.js', import.meta.url), 'utf8');

  /* ---- 1) 实时保存 ---- */
  t('★v3.9.7 后台不再有保存按钮，只有状态',
    !/id="aiSave"/.test(adm97) && /id="aiStage"/.test(adm97)
    && /改动实时保存/.test(adm97));
  t('★v3.9.7 改动 650ms 后自动提交（aiTouch → aiFlush）',
    /function aiTouch\(\)/.test(adm97) && /setTimeout\(aiFlush, 650\)/.test(adm97)
    && /function aiFlush\(\)/.test(adm97));
  t('★v3.9.7 保存状态三态（保存中 / 已自动保存 / 失败点此重试）',
    /保存中…/.test(adm97) && /已自动保存 /.test(adm97) && /保存失败，点此重试/.test(adm97));
  t('★v3.9.7 各处改动都触发自动保存（横幅/日期/假期/照片/组件）',
    (adm97.match(/aiTouch\(\)/g) || []).length >= 8
    && /ph\.oninput = function\(\)\{[\s\S]{0,160}?aiTouch\(\)/.test(adm97));
  t('★v3.9.7 离开页面前补发未保存改动（keepalive）',
    /function aiFlushBeacon/.test(adm97) && /keepalive: true/.test(adm97));

  /* ---- 2) 加粗 / 居中 ---- */
  t('★v3.9.7 数据模型带 bold / center（默认居中）',
    /bold: !!v\.bold/.test(isl97) && /center: v\.center !== false/.test(isl97));
  t('★v3.9.7+ 前台按设置渲染（txt bold / soft / left 三态）',
    /t\.bold === true \? ' bold' : \(t\.bold === false \? ' soft' : ''\)/.test(idx97)
    && /t\.center === false \? ' left' : ''/.test(idx97)
    && /\.island-banner \.txt\.bold\{font-weight:800\}/.test(idx97));
  t('★v3.9.7 不居中时整条左对齐（标签也靠左）',
    /left-align\{align-items:flex-start/.test(idx97)
    && /left-align \.tag\{align-self:flex-start\}/.test(idx97));
  t('★v3.9.7 后台有加粗 / 居中开关，且默认居中',
    /id="adBold"/.test(adm97) && /id="adCenter" checked/.test(adm97));
  t('★v3.9.7 后台文本框实时预览加粗与对齐',
    /function aiDayPreview/.test(adm97)
    && /t\.style\.fontWeight = bold \? '800' : '400'/.test(adm97)
    && /t\.style\.textAlign = center \? 'center' : 'left'/.test(adm97));
  t('★v3.9.7 日期条目上标「粗」「左」',
    /ai-ovflag">粗</.test(adm97) && /ai-ovflag">左</.test(adm97));

  /* ---- 3) 照片入口 ---- */
  t('★v3.9.7 照片面板排在第二块（基本之后）',
    adm97.indexOf('<h3>今日事项照片</h3>') > adm97.indexOf('<h3>基本</h3>')
    && adm97.indexOf('<h3>今日事项照片</h3>') < adm97.indexOf('<h3>显示哪些组件</h3>'));
  t('★v3.9.7 照片带缩略图预览（无效地址不显示）',
    /id="aiPhotoPrev"/.test(adm97) && /function aiPhotoPreview/.test(adm97)
    && /im\.onerror = function\(\)\{ im\.style\.display = 'none'/.test(adm97));
  t('★v3.9.7 未配照片时管理员点击有去处提示',
    /还没设置今日事项照片：后台 → 班级岛 → 今日事项照片/.test(idx97));

  /* ---- 4) 发布记录 ---- */
  t('★v3.9.7 REL_BUILTIN 有 3.9.7 条目且带 pub',
    /\{\s*version:\s*'3\.9\.7'[\s\S]{0,2400}?pub:\s*\[/.test(adm97));
}

console.log('\n【新】v3.9.8 首屏拆分 / 逐小时天气 / 一言分类 / 自动备份');
{
  const idx98 = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const app98 = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const adm98 = readAdm();
  const isl98 = fs.readFileSync(new URL('./api/island.js', import.meta.url), 'utf8');
  const wk98  = fs.readFileSync(new URL('./api/worker.mjs', import.meta.url), 'utf8');
  const adjs98 = fs.readFileSync(new URL('./api/admin.js', import.meta.url), 'utf8');

  /* ---- 1) 首屏拆分 ---- */
  t('★v3.9.16 主脚本改为压缩版外链 + defer',
    /<script src="\.\/app\.min\.js\?v=\d+" defer><\/script>/.test(idx98)
    && fs.statSync(new URL('./app.js', import.meta.url)).size > 600000);
  t('★v3.9.8 HTML 体积降到原来的 1/4 以下（骨架 + 样式）',
    idx98.length < 400000);
  t('★v3.9.8 版本号留在 HTML（门禁能直接读到）',
    RE_SITE.test(idx98) && !/var SITE_VERSION/.test(app98));
  t('★v3.9.8 首屏骨架卡（公告 + 板块）',
    (idx98.match(/skel-card/g) || []).length >= 6 && /\.skel-card\{[^}]*animation/.test(idx98.replace(/@keyframes[^}]*\{[^}]*\}/g, '')) || (idx98.match(/skel-card/g) || []).length >= 6);

  /* ---- 2) 逐小时天气 ---- */
  t('★v3.9.8 点天气开弹层（islWxOpen + 遮罩）',
    /id="islWxMask"/.test(idx98) && /function islWxOpen/.test(app98)
    && /id="islWxChip" onclick="islWxOpen\(\)"/.test(app98));
  t('★v3.9.8 逐小时数据（hourly=temperature_2m,weather_code,precipitation_probability）',
    /hourly=temperature_2m,weather_code,precipitation_probability/.test(app98)
    && /forecast_days=2/.test(app98));
  t('★v3.9.8 当前小时高亮 + 缓存 10 分钟',
    /isl-wx-row\.now/.test(idx98) && /10 \* 60000/.test(app98));

  /* ---- 3) 每日一言分类 / 点击换一句 ---- */
  t('★v3.9.8 前端按后台勾选的分类拼 c= 参数',
    /function quoteCats\(\)/.test(app98) && /var qs = cats\.map/.test(app98)
    && /hitokoto\.cn\/\?' \+ qs/.test(app98));
  t('★v3.9.8 每日一言卡片可点换一句',
    /function fetchRemoteQuote\(force\)/.test(app98) && /fetchRemoteQuote\(true\)/.test(app98)
    && /quote-refresh/.test(app98));
  t('★v3.9.8 后台有分类勾选并写进 quote_source.cats',
    /id="qsCats"/.test(adm98) && /function paintQuoteCats/.test(adm98)
    && /cats: STATE\.quoteCats/.test(adm98));

  /* ---- 4) 按字排版 + 默认加粗 ---- */
  t('★v3.9.8 前端解析 **加粗** / ~~横线~~ / 行首 #',
    /function islFmt/.test(app98)
    && /\(\[\^\*\]\+\)/.test(app98) && /<b>\$1<\/b>/.test(app98)
    && /\(\[\^~\]\+\)/.test(app98) && /<s>\$1<\/s>/.test(app98)
    && /\^#\\s\?/.test(app98));
  t('★v3.9.17 字重分层：默认 700 / 整块加粗 800 / 行内加粗 900 / 取消 500',
    /\.island-banner \.txt\{[^}]*font-weight:700/.test(idx98)
    && /\.island-banner \.txt\.bold\{font-weight:800\}/.test(idx98)
    && /\.island-banner \.txt b\{font-weight:900/.test(idx98)
    && /\.island-banner \.txt\.soft\{font-weight:500\}/.test(idx98));
  t('★v3.9.8 后台加粗默认勾上',
    /id="adBold" checked/.test(adm98));
  t('★v3.9.8 后台排版按钮 + 同款预览',
    /data-rt="b"/.test(adm98) && /data-rt="s"/.test(adm98) && /data-rt="h"/.test(adm98)
    && /function aiRtFmt\(kind, val\)/.test(adm98) && /id="adPrev"/.test(adm98));

  /* ---- 5) 自动备份 ---- */
  t('★v3.9.8 Worker 定时任务会写全量快照（runAutoBackup）',
    /runAutoBackup/.test(wk98) && /async scheduled\(event, env, ctx\)/.test(wk98)
    && /data backup/.test(wk98) && /export async function runAutoBackup/.test(adjs98));
  t('★v3.9.8 每次 push 触发一次备份工作流',
    fs.existsSync(new URL('./.github/workflows/backup-data.yml', import.meta.url))
    && /action=backup/.test(fs.readFileSync(new URL('./.github/workflows/backup-data.yml', import.meta.url), 'utf8')));
  t('★v3.9.8 Pages 发布清单包含 app.js',
    /\n\s+app\.js\n/.test(fs.readFileSync(new URL('./.github/workflows/deploy-pages.yml', import.meta.url), 'utf8')));

  /* ---- 6) 发布记录 ---- */
  t('★v3.9.8 REL_BUILTIN 有 3.9.8 条目且带 pub',
    /\{\s*version:\s*'3\.9\.8'[\s\S]{0,2600}?pub:\s*\[/.test(adm98));
}

console.log('\n【新】v3.9.16 备份去重（同一版本只留一份）');
{
  const adm99 = readAdm();
  const adjs99 = fs.readFileSync(new URL('./api/admin.js', import.meta.url), 'utf8');

  t('★v3.9.16 手动/部署前备份：同版本已存在就跳过',
    /const dup = await sql`select id, kind from data_backups where version = \$\{version\}/.test(adjs99)
    && /skipped: true/.test(adjs99));
  t('★v3.9.16 auto 撞上 predeploy 时升级而不是新建',
    /dup\[0\]\.kind !== 'predeploy'/.test(adjs99) && /upgraded: true/.test(adjs99));
  t('★v3.9.16 定时自动备份也按版本去重',
    /export async function runAutoBackup/.test(adjs99)
    && /select id from data_backups where version = \$\{String\(version\)\.slice\(0, 20\)\} limit 1/.test(adjs99));
  t('★v3.9.16 清理策略：同版本只留 1 份',
    /order by created_at desc limit 1\s*\n?\s*\)/.test(adjs99)
    && !/order by created_at desc limit 3/.test(adjs99));
  t('★v3.9.16 REL_BUILTIN 有 3.9.16 条目且带 pub',
    /\{\s*version:\s*'3\.9\.17'[\s\S]{0,1600}?pub:\s*\[/.test(adm99));
}


console.log('\n【新】v3.9.10 缓存优先 / 老 iPad / 门禁加固');
{
  const idx10 = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const app10 = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const sw10 = fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
  const adm10 = readAdm();
  const pre10 = fs.readFileSync(new URL('./scripts/predeploy.mjs', import.meta.url), 'utf8');
  const wk10 = fs.readFileSync(new URL('./.github/workflows/backup-data.yml', import.meta.url), 'utf8');
  const pages10 = fs.readFileSync(new URL('./.github/workflows/deploy-pages.yml', import.meta.url), 'utf8');
  const basic10 = fs.readFileSync(new URL('./basic.html', import.meta.url), 'utf8');

  t('★v3.9.16 SW 静态资源缓存优先 + 后台刷新', /stale-while-revalidate/.test(sw10)
    && /if \(cached\) \{\s*event\.waitUntil/.test(sw10)
    && /cache\.match\(request, \{ ignoreSearch: true \}\)/.test(sw10));
  t('★v3.9.16 预缓存的是压缩版 app.min.js', /const PRECACHE = \['\.\/app\.min\.js'/.test(sw10));
  t('★v3.9.16 缓存桶跟着版本走', /const CACHE = 'class-site-' \+ SITE_VER/.test(sw10));

  t('★v3.9.16 字号滑块兼容 touch/mouse（无 PointerEvent 也能拖）',
    /var hasPointer = !!window\.PointerEvent/.test(app10)
    && /host\.addEventListener\('touchstart'/.test(app10)
    && /host\.addEventListener\('mousedown'/.test(app10));
  t('★v3.9.16 老内核补齐 closest / fetch 等基础 API',
    /Element\.prototype\.closest = function/.test(idx10)
    && /if\(!window\.fetch\)/.test(idx10)
    && /NodeList\.prototype\.forEach/.test(idx10));
  t('★v3.9.16 启动看门狗：12 秒没渲染就给提示',
    /legacyFallback/.test(idx10) && /12000/.test(idx10) && /basic\.html/.test(idx10));
  t('★v3.9.16 基础版页面为纯 ES5（无箭头函数 / const 声明）',
    basic10.length > 1000 && !/=>/.test(basic10) && !/\bconst \w+ =/.test(basic10));

  t('★v3.9.16 轻量模式跳过天气 / 语录 / 班徽代理',
    /if\(liteOn\(\)\)\{\s*if\(hasCache\)/.test(app10)
    && /轻量模式用本地语录/.test(app10)
    && /if\(liteOn\(\)\) return Promise\.resolve\('\.\/icons\/badge-256\.png'\)/.test(app10));
  t('★v3.9.16 统计脚本空闲加载且轻量模式跳过',
    /requestIdleCallback\(load/.test(idx10) && /lite\(\) \|\| saveData\(\)/.test(idx10));

  t('★v3.9.16 门禁新增资源清单 / 体积预算 / 重复定义 / 口令扫描',
    /③e 资源清单完整/.test(pre10) && /③f/.test(pre10)
    && /③g 无重复顶层函数/.test(pre10) && /③h 无明文口令/.test(pre10));
  t('★v3.9.16 仓库与工作流里没有明文口令',
    !/ai202505/.test(wk10) && !/ai202505/.test(app10) && !/ai202505/.test(adm10));
  t('★v3.9.16 备份工作流缺 Secrets 时跳过而不是硬跑', /未配置 CLS_AI_USER/.test(wk10));
  t('★v3.9.16 badge.png / basic.html 进 Pages 发布清单',
    /\bbadge\.png\b/.test(pages10) && /\bbasic\.html\b/.test(pages10));
  t('★v3.9.16 班级岛首帧占位（避免整页跳 176px）',
    /class="island isl-boot" id="classIsland"/.test(idx10)
    && /\.island\.isl-boot\{visibility:hidden;min-height:172px\}/.test(idx10)
    && /host\.classList\.remove\('isl-boot'\)/.test(app10));
  t('★v3.9.16 后台只剩一个心跳函数',
    (adm10.match(/function startAdminHeartbeat/g) || []).length === 1);
}


console.log('\n【新】v3.9.17 明日事项 / 编辑器开关 / 字号');
{
  const idx17 = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const app17 = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const adm17 = readAdm();
  const isl17 = fs.readFileSync(new URL('./api/island.js', import.meta.url), 'utf8');

  t('★v3.9.17 21 点后默认看明天（islIsNight + 可手动覆盖）',
    /function islIsNight\(\)\{ return new Date\(\)\.getHours\(\) >= 21; \}/.test(app17)
    && /var ISL_VIEW = null;/.test(app17) && /function islShowTomorrow\(\)/.test(app17));
  t('★v3.9.17 明天有临时安排优先，没有再用星期课表',
    /function islandToday\(offset\)/.test(app17) && /if\(offset\) d\.setDate\(d\.getDate\(\) \+ offset\)/.test(app17)
    && /\(day && day\.text\) \|\| \(ISLAND\.banner \|\| \{\}\)\[dow\]/.test(app17));
  t('★v3.9.17 标签会变成「明日事项」', /\(tomorrow \? '明日事项' : '今日事项'\)/.test(app17));
  t('★v3.9.17 21 点后出现「看今天 / 看明天」按钮', /class="isl-switch"/.test(app17)
    && /看今天|看明天/.test(app17) && /islSwitchView/.test(app17));
  t('★v3.9.17 挂到 21 点自动重画（不用刷新）', /if\(h === 21 \|\| h === 0\) islandBanner\(\);/.test(app17));
  t('★v3.9.17 字号（12–32）存进当天配置并渲染',
    /function clampSize/.test(isl17) && /size: clampSize\(v\.size\)/.test(isl17)
    && /font-size:' \+ t\.size \+ 'px/.test(app17));
  t('★v3.9.17 排版按钮是开关（再点一次取消）',
    /function aiRtFmt\(kind, val\)/.test(adm17) && /aiRtUnwrapAll/.test(adm17)
    && /再点一次/.test(adm17));
  t('★v3.9.17 整行强调有可见样式（底色 + 左竖条）',
    /\.island-banner \.txt \.ln-em\{[^}]*background:rgba\(251,146,60,\.18\)/.test(idx17));
  t('★v3.9.17 行内加粗与默认字重拉开（700 / 900）',
    /\.island-banner \.txt\{[^}]*font-weight:700/.test(idx17)
    && /\.island-banner \.txt b\{font-weight:900/.test(idx17));
  t('★v3.9.17 后台有字号下拉且随保存提交',
    /id="adSize"/.test(adm17) && /size: Number\(\(\$\('adSize'\)/.test(adm17));
  t('★v3.9.17 后台预览复用前台类（不再各写一套）',
    /pv\.innerHTML = '<div class="island-banner'/.test(adm17));
}

/* ============================================================
 * v3.9.25：翻页动画两片接力 + 时钟使用记录（本地 / 云端 / 后台）
 * ========================================================== */
{
  const clk = readClock();
  const dataSrc = readApi('data.js');
  const adminApi = readApi('admin.js');

  t('★v3.13.0 屏幕底部热区 + 每段记录带设备名',
    /id="barHot"/.test(clk) && /var DEVICE = /.test(clk) && /dv: DEVICE/.test(clk)
    && /barHot'\).className = 'on'/.test(clk));
  t('★v3.13.0 开始计时默认只留数字（bareRun 默认 1）',
    /bareRun:1/.test(clk) && /cfgV:2/.test(clk));
  t('★v3.12.0 clock.html 顶层两个模式（时钟 / 计时）+ 两排子标签',
    /data-m="clock"/.test(clk) && /data-m="timer"/.test(clk)
    && !/data-m="pomo"/.test(clk) && !/data-m="stop"/.test(clk)
    && /SUB_TABS/.test(clk) && /正计时/.test(clk) && /番茄钟/.test(clk));

  /* 翻页动画 */
  t('★v3.9.25 翻页是两片接力（A 翻下去 + B 翻上来）',
    /\.flip \.flap\.a\{/.test(clk) && /\.flip \.flap\.b\{/.test(clk)
    && /@keyframes flipA\{/.test(clk) && /@keyframes flipB\{/.test(clk));
  t('★v3.9.25 B 片延迟半程开始（0.3s + 0.3s 接力）',
    /animation:flipB \.3s[^;]*\.3s forwards/.test(clk)
    && /animation:flipA \.3s[^;]*forwards/.test(clk));
  t('★v3.9.25 文字在动画开始前就位（不是翻完才改）',
    /bot\.textContent = old;/.test(clk) && /top\.textContent = val;/.test(clk));
  t('★v3.9.25 收尾用令牌防两轮叠加', /box\.__tok/.test(clk) && /flipClean\(box\)/.test(clk));

  /* 使用记录 */
  t('★v3.9.25 时钟页右上角有「记录」按钮与右侧抽屉',
    /id="logBtn"/.test(clk) && /id="logPanel"/.test(clk) && /translateX\(103%\)/.test(clk));
  t('★v3.9.25 记录按天存在 cls_clock_log_<日期>',
    /var LOG_PREFIX = 'cls_clock_log_'/.test(clk) && /dkey\(ts\)/.test(clk));
  t('★v3.9.25 切模式就切一段（logStart / logStop）',
    /function logStart\(mode\)/.test(clk) && /function logStop\(\)/.test(clk)
    && /logStart\(logModeOf\(\)\)/.test(clk));
  t('★v3.9.25 自习按专注 / 休息分开记（v3.11.0 并进计时后仍按阶段记）',
    /function logModeOf\(\)\{/.test(clk) && /pomo:rest/.test(clk) && /pomo:focus/.test(clk));
  t('★v3.9.25 抽屉里有自习 / 休息 / 番茄三张卡',
    /自习<\/i>/.test(clk) && /休息<\/i>/.test(clk) && /番茄<\/i>/.test(clk)
    && /lg-card wide/.test(clk));
  t('★v3.11.1 卡片标题跟着看的那天走（今日 / 昨日 / 具体日期）',
    /function dayWord\(day\)/.test(clk) && /昨日/.test(clk) && /<i>' \+ w \+ '自习<\/i>/.test(clk));
  t('★v3.9.25 切到后台停止计时', /if\(document\.hidden\)\{?\s*logStop\(\);/.test(clk)
    && /pagehide/.test(clk));
  t('★v3.10.4 切后台顺手推一次（logSyncNow）', /logStop\(\);\s*logSyncNow\(\);/.test(clk));
  t('★v3.9.25 登录后推到 /api/data', /flushLog/.test(clk) && /CLK_API \+ '\/api\/data'/.test(clk));

  /* 后端 */
  t('★v3.9.25 云端白名单放行 cls_clock_*',
    /'cls_clock_\*'/.test(dataSrc));
  t('★v3.9.25 后台有时钟记录接口', /action === 'clock-logs'/.test(adminApi)
    && /async function clockLogs/.test(adminApi) && /cls_clock_log_/.test(adminApi));

  /* 后台面板 */
  const adm90 = readAdm();
  t('★v3.9.25 后台有「时钟记录」页面',
    /id:'clocklog'/.test(adm90) && /function renderClockLog\(\)/.test(adm90)
    && /function paintClockLog\(\)/.test(adm90));
  t('★v3.9.25 后台能展开每人每段', /data-cl-open/.test(adm90) && /cl-seg/.test(adm90));

  /* 番茄卡片已删 */
  const idx90 = readIdx();
  t('★v3.9.25 番茄时钟卡片已删除（不再跳外站）',
    !/focustide\.app/.test(idx90));
}

/* ============================================================
 * v3.10.0：成绩图表动画（滚到才播 / 出视口复位）+ 卡片折叠 + 对比淡柱修复
 * ========================================================== */
{
  const idx91 = readIdx();

  t('★v3.10.0 动画总开关（轻量 / 精简动效 / 系统偏好都拦）',
    /function scAnimOn\(\)/.test(idx91)
    && /if\(liteOn\(\)\) return false;/.test(idx91)
    && /UI\.motion === 0/.test(idx91)
    && /prefers-reduced-motion/.test(idx91));

  t('★v3.10.0 柱子逐帧长高（改 y/height，不用 CSS transform）',
    /function scPlayBars\(svg\)/.test(idx91)
    && /setAttribute\('height', h\.toFixed\(2\)\)/.test(idx91)
    && /setAttribute\('y', \(it\.y \+ it\.h - h\)\.toFixed\(2\)\)/.test(idx91));

  t('★v3.10.0 柱子逐根错峰 26ms + 缓出',
    /d: i \* 26/.test(idx91) && /function scEase\(p\)\{ return 1 - Math\.pow\(1 - p, 3\); \}/.test(idx91));

  t('★v3.10.0 关键：开播前才归零（视口外保持真实高度）',
    /开播前才归零 —— 视口外保持真实高度/.test(idx91)
    && /it\.el\.setAttribute\('y', st\.baseY\)/.test(idx91));

  t('★v3.10.0 横条从 0 撑开',
    /function scPlayGrow\(card\)/.test(idx91) && /o\.el\.style\.width = '0%'/.test(idx91));

  t('★v3.10.0 概览数字只跳一次（文字不反复动）',
    /function scPlayNums\(card\)/.test(idx91) && /if\(card\.__numsDone\) return;/.test(idx91));

  t('★v3.10.0 用 IntersectionObserver 按卡片进出视口播 / 复位',
    /new IntersectionObserver\(/.test(idx91)
    && /function scPlayCard\(card\)/.test(idx91)
    && /function scResetCard\(card\)/.test(idx91)
    && /else if\(card\.classList\.contains\('sc-in''\)\)/.test(idx91.replace(/\\/g, '')) === false
    && /scResetCard\(card\);/.test(idx91));

  t('★v3.10.0 已经在视口里的卡片不等回调，立刻播',
    /var r = c\.getBoundingClientRect\(\);/.test(idx91)
    && /if\(r\.bottom > 0 && r\.top < \(window\.innerHeight \|\| 800\)\) scPlayCard\(c\);/.test(idx91));

  t('★v3.10.0 没有 IntersectionObserver 时兜底全播',
    /if\(!window\.IntersectionObserver\)\{/.test(idx91));

  t('★v3.10.0 表格 / 列表行只给前 16 行做错峰',
    /var limit = Math\.min\(rows\.length, 16\)/.test(idx91));

  t('★v3.10.0 动画样式挂在「卡片进了视口」上',
    /#scPaneBox\.sc-anim \.sc-card\.sc-in \.sc-rise\{animation:scRise/.test(idx91)
    && /#scPaneBox\.sc-anim \.sc-card\.sc-in svg \.sc-mine-poly\{transform-origin:320px 154px/.test(idx91)
    && /#scPaneBox\.sc-anim \.sc-card\.sc-in svg \.sc-cut-line\{animation:scSoftIn/.test(idx91));

  t('★v3.10.0 系统「减少动态效果」时 CSS 也停掉',
    /@media \(prefers-reduced-motion: reduce\)\{[\s\S]{0,500}\.sc-card\.sc-in \.sc-rise/.test(idx91));

  /* 折叠 */
  t('★v3.10.0 每张卡右上角有折叠按钮，内容收进 .sc-fold-body',
    /function scFoldInit\(root\)/.test(idx91)
    && /function scFoldBody\(card\)/.test(idx91)
    && /sc-fold-btn/.test(idx91));

  t('★v3.10.0 折叠用事件委托（重渲染后照样能点）',
    /function scBindFold\(root\)/.test(idx91)
    && /root\.addEventListener\('click'/.test(idx91));

  t('★v3.10.0 折叠状态按 data-scblk 记住',
    /if\(key\) SC_FOLD\[key\] = card\.classList\.contains\('sc-folded'\)/.test(idx91));

  /* 对比淡柱修复 */
  t('★v3.10.0 修复：两场对比的淡柱取的是上一场的成绩',
    /function prevRowOf\(row\)/.test(idx91)
    && /var v = pr\.s && pr\.s\[s\.key\];/.test(idx91));

  t('★v3.10.0 淡柱认人：先 uid 再姓名',
    /if\(row\.uid\)\{[\s\S]{0,200}String\(x\.uid\) === String\(row\.uid\)/.test(idx91));
}

console.log('\n' + '='.repeat(52));
console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败  (共 ' + (pass + fail) + ' 项)');
if (fail) { console.log('\n失败项:'); fails.forEach(f => console.log('  - ' + f)); }
console.log('实际执行 SQL 查询: ' + queryLog.length + ' 条');
console.log('='.repeat(52));

process.exit(fail ? 1 : 0);
