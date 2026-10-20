-- ============================================================
-- 25级05班班级服务站 · 用户系统建表脚本
-- 目标库：Neon Postgres
-- 用法：在 Neon 控制台 → SQL Editor 里整段粘贴执行即可（可重复执行，幂等）
-- ============================================================

/* ---------------- 用户表 ---------------- */
create table if not exists users (
  id            bigserial primary key,
  username      text        not null unique,          -- 登录名（小写存储）
  display_name  text,                                 -- 显示名（真名/昵称）
  password_hash text        not null,                 -- bcrypt 哈希，绝不存明文
  role          text        not null default 'user',  -- user | admin
  status        text        not null default 'active',-- active | banned
  created_at    timestamptz not null default now(),
  last_login_at timestamptz,
  /* 约束：角色和状态只能是约定值，防止脏数据 */
  constraint users_role_chk   check (role   in ('user','admin')),
  constraint users_status_chk check (status in ('active','banned','pending'))
);

/* 用户名统一小写，方便大小写不敏感登录 */
create unique index if not exists users_username_lower_idx on users (lower(username));

/* ---------------- 注册审核：status 增加 'pending'（2026-10-16 v2.10.0，幂等） ----------------
   待审核账号不签发会话、无法登录，管理员在后台通过/驳回。
   改约束只能「先删后加」（PG 不支持 alter constraint），
   drop if exists 保证本文件可重复执行。与 ensureSchema 的语句一致。 */
alter table users drop constraint if exists users_status_chk;
alter table users add  constraint users_status_chk check (status in ('active','banned','pending'));

/* ---------------- 登录限流所需的两列（2026-09-30 加，幂等可重复执行） ----------------
   老库直接执行本文件即可补上，不需要重建表。 */
alter table users add column if not exists failed_count int not null default 0;
alter table users add column if not exists locked_until  timestamptz;

/* ---------------- 首次登录强制改密（2026-10-05 加，幂等） ----------------
   由管理员在后台「添加用户」或「批量导入」时置为 true，
   同学首次用初始密码登录后必须自行改密，改完自动置回 false。
   管理员始终看不到明文密码（库中只有 PBKDF2 哈希）。 */
alter table users add column if not exists must_change_password boolean not null default false;

/* ---------------- AI 助手账号标记（2026-10-05 加，幂等） ----------------
   给 AI 助手账号打标。作用有二：
     ① 授权：is_ai = true 的账号可以编辑云端公告/作业（见 http.js 的 requireAI）；
     ② 交接：换 AI 时把 is_ai 从旧账号转给新账号即可，不必改代码。
   AI 账号同时也是管理员（role = 'admin'），但反过来不成立——
   普通管理员 is_ai = false，不会被误认成 AI。 */
alter table users add column if not exists is_ai boolean not null default false;

/* ---------------- 登录记录表（2026-10-05 加，幂等） ----------------
   每次成功登录写一条；users.last_login_at 只保留最后一次，
   本表保留完整历史，供后台「用户详情 → 登录记录」查看。 */
create table if not exists login_log (
  id         bigserial   primary key,
  user_id    bigint      not null references users(id) on delete cascade,
  ip         text,                                  -- 客户端 IP（取 CF-Connecting-IP / X-Forwarded-For）
  user_agent text,                                  -- 浏览器 UA，截断到 500 字符
  created_at timestamptz not null default now()
);
create index if not exists login_log_user_idx  on login_log (user_id, created_at desc);
create index if not exists login_log_time_idx  on login_log (created_at desc);

/* ---------------- 会话表 ---------------- */
create table if not exists sessions (
  token      text        primary key,
  user_id    bigint      not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- 会话粒度在线时间：前端每次心跳更新。
  -- 与 users.last_seen_at（用户粒度）不同，这里能区分「同一账号的多台设备」，
  -- 也是后台「谁在线」的唯一依据（v2.5.0）。
  last_seen_at timestamptz
);
create index if not exists sessions_user_idx    on sessions (user_id);
create index if not exists sessions_expires_idx on sessions (expires_at);

/* ---------------- 在线时段表（v3.5.35） ----------------
   站主原话：
   「检测单次在线时长以及历史累计的在线时长……第一次请求到最后一次请求之间的
     时间，就是它这次上线时间……如果两次请求时间超过了 3 分钟，那就算两次请求」

   落地算法（判定写在 api/auth.js 的 ping() 里）：
     · 距同会话上一条的 last_ping_at ≤ 180 秒 → 同一次在线，把 stop_at 往后推
     · 超过 180 秒（或第一次）→ 另起一个时段（插入新行）
   每条 sessions 一行 = 一次「连续在线」；时长 = stop_at - start_at。
   last_ping_at 是判定用的锚点，与 sessions.last_seen_at 分开存，
   因为后者有 30 秒节流，粒度不够做 3 分钟判定。 */
create table if not exists online_sessions (
  id            bigserial   primary key,
  user_id       bigint      not null,
  session_token text        not null default '',     -- sha256(token)，不存明文
  start_at      timestamptz not null default now(),  -- 本段第一次心跳
  stop_at       timestamptz not null default now(),  -- 本段最后一次心跳（随时间前推）
  last_ping_at  timestamptz not null default now(),  -- 分段判定锚点
  ping_count    int         not null default 1,      -- 本段累计心跳次数
  created_at    timestamptz not null default now()
);
create index if not exists online_user_start_idx on online_sessions (user_id, start_at desc);
create index if not exists online_start_idx      on online_sessions (start_at desc);
create index if not exists online_token_idx      on online_sessions (session_token);

-- ============================================================
-- v3.5.40 页面维度在线时长（站主 #3）
--   站主原话：「在线时间的统计需精确到某段时间在哪个页面，
--            比如成绩分析页面、打砖块页面、后台页面」
--   与 online_sessions 分开存：
--     · online_sessions 仍负责「这一次在线多久 / 一共在线多久」（总口径不变）
--     · online_pages   负责「这段时间挂在哪个页面」
--   分段规则完全一致：同一人 + 同一会话 + 同一页面，心跳间隔 ≤ 180 秒算同一段。
--   页面标识由前端心跳带上（?page=成绩分析 / game:breakout / admin:votes …）。
-- ensureSchema（http.js）两路径均已同步；SCHEMA_VER = 3.5.40
-- ============================================================
create table if not exists online_pages (
  id            bigserial   primary key,
  user_id       bigint      not null,
  session_token text        not null default '',
  page          text        not null default '',
  start_at      timestamptz not null default now(),
  stop_at       timestamptz not null default now(),
  last_ping_at  timestamptz not null default now(),
  ping_count    int         not null default 1,
  created_at    timestamptz not null default now()
);
create index if not exists online_pages_user_idx on online_pages (user_id, start_at desc);
create index if not exists online_pages_page_idx on online_pages (page, start_at desc);
create index if not exists online_pages_tok_idx  on online_pages (session_token, page, last_ping_at desc);

-- ============================================================
-- v3.6.1 云端数据备份（站主 #4）
--   站主原话：「后台新增数据管理，以后每次更新都先自动备份所有数据
--            （通过检测在部署前先备份后部署）到云端数据库，包括作业、公告、
--            用户数据等等全部云端内容，默认存储最近 14 个版本更新，
--            方便有问题随时回档」
--   · payload：整包快照（content / users / profiles / votes / settings …）
--   · kind：auto 自动 / predeploy 部署前 / manual 手动
--   · 保留策略见 api/admin.js 的 pruneBackups()：按 version 保留最近 14 个
-- ensureSchema（http.js）两路径均已同步；SCHEMA_VER = 3.6.1
-- ============================================================
create table if not exists data_backups (
  id          bigserial   primary key,
  version     text        not null,
  kind        text        not null default 'auto',
  note        text        default '',
  payload     jsonb       not null,
  bytes       int         not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists data_backups_ver_idx     on data_backups (created_at desc);
create index if not exists data_backups_version_idx on data_backups (version);

-- ============================================================
-- v3.6.4 删除回收站（站主 #3）
--   站主原话：「数据可以直接删除而不是隐藏，这样会出现更多的问题，
--            在后端的操作记录里新增撤回的功能，现在删除数据倒计时 30 分钟，
--            30 分钟以内在后台操作日志里点击撤回即可重新显示，否则真正删除数据」
--   · kind = field：删字段时把「字段定义 + 该列所有值」整包存进来
--   · expires_at 到期后由下一次删除操作顺手清掉（惰性清理，不跑定时任务）
-- ensureSchema（http.js）两路径均已同步；SCHEMA_VER = 3.6.4
-- ============================================================
create table if not exists deleted_items (
  id          bigserial   primary key,
  kind        text        not null default 'field',
  label       text        default '',
  payload     jsonb       not null,
  bytes       int         not null default 0,
  deleted_by  bigint,
  deleted_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now()
);
create index if not exists deleted_items_exp_idx on deleted_items (expires_at desc);

-- ============================================================
-- v3.7.0 资料修改审批（站主 #1）
--   站主原话：「所有允许学生自主修改的字段同之前微信QQ手机号的联系方式审核相同，
--            需要后台确认方可成功更改，在后台确认之前均按照原来显示」
--   · changes = [{field, label, before, after}]，before/after 都是密文（与 profiles 同密钥）
--   · 提交时**不动 profiles** → 前台自然还是旧值；后台通过后才写库
--   · status: pending | approved | rejected | reverted
--   · 通过后 7 天内可 revert（后台「信息审核 → 历史记录」里点撤销）
-- ensureSchema（http.js）两路径均已同步；SCHEMA_VER = 3.7.0
-- ============================================================
create table if not exists profile_change_requests (
  id         bigserial   primary key,
  profile_id bigint      not null,
  user_id    bigint,
  kind       text        not null default 'field',
  changes    jsonb       not null,
  status     text        not null default 'pending',
  note       text        default '',
  decided_by bigint,
  decided_at timestamptz,
  applied_at timestamptz,
  revoked_at timestamptz,
  meta       jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists pcr_status_idx  on profile_change_requests (status, created_at desc);
create index if not exists pcr_profile_idx on profile_change_requests (profile_id, created_at desc);

/* ---------------- 用户数据表（云同步核心） ---------------- */
-- 按 (用户, 键) 存 JSONB，天然适配前端 localStorage 的任意结构
create table if not exists user_data (
  user_id    bigint      not null references users(id) on delete cascade,
  data_key   text        not null,                    -- 对应前端的 localStorage key
  data_value jsonb,                                   -- 任意 JSON
  updated_at timestamptz not null default now(),
  primary key (user_id, data_key)
);
create index if not exists user_data_key_idx on user_data (data_key);

/* ---------------- 管理操作审计表 ---------------- */
create table if not exists audit_log (
  id          bigserial primary key,
  actor_id    bigint      references users(id) on delete set null,
  action      text        not null,                   -- 如 user.ban / data.update
  target_type text,                                   -- user | data | session
  target_id   text,
  detail      text,
  created_at  timestamptz not null default now()
);
create index if not exists audit_log_actor_idx  on audit_log (actor_id);
create index if not exists audit_log_time_idx   on audit_log (created_at desc);

/* ---------------- 站点设置表（2026-10-16 v2.10.0，幂等） ----------------
   单行 jsonb（id 恒为 1），存管理员在后台随时改、立即生效的站点级开关：
   register_open（注册总开关）/ register_review（注册是否需审核）。
   与 ensureSchema 的建表语句一致——新库先执行本文件，老库靠自愈补。 */
create table if not exists site_settings (
  id         int         primary key default 1,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

/* ---------------- 用户操作日志表（2026-10-16 v2.10.0，幂等） ----------------
   站主要求「记录全部点击交互行为」：页面跳转、按钮点击、切换标签、
   表单提交等，前端攒批（20 条或 30 秒）POST 到 /api/data?action=log。
   保留 90 天明细（写入时顺手节流清理），统计聚合约了长期价值。
   索引按管理后台两种查法建：按时间倒序翻页 + 按用户查。 */
create table if not exists user_action_log (
  id         bigserial   primary key,
  user_id    bigint      not null references users(id) on delete cascade,
  action     text        not null default 'click',      -- click | nav | submit | switch
  page       text        not null default '',           -- 所在页面/板块
  target     text        not null default '',           -- 点击目标（按钮/标签名）
  detail     text        not null default '',           -- 补充信息（表单摘要等）
  ip         text,
  created_at timestamptz not null default now()
);
create index if not exists ual_time_idx on user_action_log (created_at desc);
create index if not exists ual_user_idx on user_action_log (user_id, created_at desc);

/* ---------------- 自动清理过期会话（可选，建议配 Neon 定时任务） ---------------- */
-- 手动清理： delete from sessions where expires_at < now();

/* ============================================================
   班级通讯录 / 个人资料（2026-10-05 新增，幂等可重复执行）
   ------------------------------------------------------------
   设计要点（隐私优先）：
   ① 所有真实数据只存这里，前端 index.html 里不再保留任何通讯录数据。
      旧方案是把姓名哈希 + XOR 密文放在前端 JS，而密钥同在 JS 里，
      等于公开——这是必须搬走的原因。
   ② 姓名拆成 name（明文，供检索与展示）与 name_hash（SHA-256，供精确匹配）。
      仅靠哈希无法展示姓名，仅靠明文又容易被爬，故两者并存：
      列表只返回脱敏信息，命中查询才返回详情。
   ③ 微信 / QQ / 手机号是「同学自填」字段，带独立审核状态：
        pending  已提交待审核（不对外展示）
        approved 审核通过（对已登录用户展示）
        rejected 已驳回（不展示，本人可见驳回原因）
   ④ 姓名 / 学号 / 政治面貌属于「身份信息」，同学无权修改，
      只能由管理员在后台维护（对应代码里的 protect 字段校验）。
   ============================================================ */
create table if not exists profiles (
  id            bigserial   primary key,
  name          text,                                  -- 姓名（明文，管理员维护）
  /* ⚠️ name_hash 已废弃（2026-10-08）：姓名改为明文检索后本列再无写入方，
     保留仅为兼容老数据，代码中不要再用。等确认无任何引用后再删列。 */
  name_hash     text        unique,                    -- [废弃] 姓名 SHA-256（精确匹配用，可空）
  /* 学号可空：班主任等「无账号但有资料」的人也建 profiles，不强制填学号。
     PG 的 unique 约束对多行 NULL 不冲突（SQLite 同），故批量建号可留空。

     🔴 v3.5.0 起本列**不再有 unique 约束**（见文件末尾的 drop constraint）：
        加密后同一学号每次加密的 IV 不同，密文永远互不相等，unique 形同虚设；
        唯一性改由 student_id_bidx（盲索引）在应用层保证。 */
  student_id    text,                                  -- 学号（管理员维护，密文存储）
  politics      text,                                  -- 政治面貌：共青团员 / 群众 / 中共党员 等
  exam_no       text,                                  -- 智学网准考证号（管理员维护，同学查询时直接可见）
  role          text        not null default '学生',    -- 学生 | 老师 | 管理员  /* ---- 以下三项由同学自填，需管理员审核后展示 ---- */
  wechat        text,
  qq            text,
  phone         text,
  contact_status text       not null default 'none',   -- none | pending | approved | rejected
  reject_reason text,                                  -- 驳回原因，仅本人与管理员可见
  /* 关联登录账号：同学首次用自己的账号认领本人资料后写入 */
  user_id       bigint      references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint profiles_contact_chk
    check (contact_status in ('none','pending','approved','rejected'))
);
create index if not exists profiles_name_idx    on profiles (name);
create index if not exists profiles_exam_idx    on profiles (exam_no);
create index if not exists profiles_namehash_idx on profiles (name_hash);
create index if not exists profiles_sid_idx     on profiles (student_id);
create index if not exists profiles_user_idx    on profiles (user_id);
create index if not exists profiles_status_idx  on profiles (contact_status);

/* ---------------- 头衔（2026-10-05 加，幂等） ----------------
   班级职务，由管理员在后台「头衔任命」里指定。
   存英文逗号分隔的纯文本（如 '团支书,课代表'），一个人可兼多职。

   ⚠️ 授权只认本列的服务端值，绝不接受前端传参——
      否则任何人都能自称课代表去改作业。 */
alter table profiles add column if not exists title text;

/* ---------------- 本人可见性意愿（2026-10-08 加，幂等） ----------------
   JSON 文本，存「本人愿意把哪些字段公开给自己以外的人」，例如：
     {"wechat":false,"qq":false,"phone":true}
   语义是**只收窄不放宽**：最终可见性 = 后台设定的上限 ∩ 本人意愿（取更严的一侧）。
   想放宽（如本来 self 想改 public）必须走管理员，见 profile.js 的 submit。

   存 text 而不是 jsonb：本列由 api/profile.js 自行 JSON.parse/stringify，
   测试桩（sql.js）也无需额外适配，避开通配层差异。 */
alter table profiles add column if not exists visibility_pref text;

/* ---------------- 单人字段可见性例外（2026-10-09 加，幂等） ----------------
   JSON 文本，存「这一条资料相对于全班默认值的**个人例外**」，例如：
     {"student_id":"self","wechat":"public"}
   站主原话：「还可以单独编辑某一个人，哪个对外，哪个不对外」。

   ⚠️ 与 visibility_pref 的区别（两者不可混用）：
     visibility_pref  —— 本人自己设的意愿，只能「收窄」，键只有 wechat/qq/phone
     field_vis        —— 管理员设的例外，可收窄**也可放宽**（管理员有最终裁量权），
                         键可以是任意已登记字段
   只有管理员能写本列（后台编辑弹窗 / 人员级快捷切换）。 */
alter table profiles add column if not exists field_vis text;

/* ============================================================
   资料字段元数据（2026-10-08 新增，幂等可重复执行）
   ------------------------------------------------------------
   这张表是「字段可见性分档」的地基，也是下一轮「后台自定义字段」的地基。

   为什么用一张表而不是给 profiles 加一堆 xxx_vis 列：
     站主已明确要做「在后台直接新增一个资料字段」（如学籍号、身份证号、
     发展团员编号）。若每个字段加一列可见性，下轮必被推翻重建；
     一张 meta 表登记所有字段，自定义字段直接 insert 一行即可复用。

   visibility 三档：
     public    公开（已登录同学都能查到）
     committee 班委可见（团支书/班长/课代表等，见 http.js 的 isCommittee）
     self      仅本人可见（只有登录者查自己资料时返回）

   ⚠️ 本列是**全班默认上限**，不是某人的最终值。最终可见性要三方取严：
        本列(全班默认) ∩ profiles.visibility_pref(本人意愿) ∩ profiles.field_vis(单人例外)

   is_custom：预置字段为 false；后台新增的自定义字段为 true。
     🔒 只有 is_custom = true 的字段允许删除（系统字段删了会带崩代码）。
   ============================================================ */
create table if not exists profile_field_meta (
  field       text        primary key,                 -- 字段名，与 profiles 的列名 / API 字段名一致
  label       text        not null,                    -- 中文显示名
  visibility  text        not null default 'public',   -- public | committee | self
  sort_order  int         not null default 100,        -- 展示顺序（小的在前）
  is_custom   boolean     not null default false,      -- true = 后台新增的自定义字段
  vis_locked  boolean     not null default false,      -- true = 站主在后台设过可见性，以站主为准
  self_edit   boolean     not null default false,      -- v3.5.40：true = 允许本人自己改这一项
  updated_at  timestamptz not null default now(),
  -- v3.5.5 字段校验规则：{type:'text'|'number'|'time'|'select', ...}
  -- 形状与默认值见 api/_lib/field-rules.js 的 normalizeRules；
  -- '{}' = 无校验（空值恒放过）。服务端 validateByRules 是唯一裁判。
  rules       jsonb       not null default '{}'::jsonb,
  constraint pfm_vis_chk check (visibility in ('public','committee','self','admin'))
);

/* ---------------- vis_locked 补列（2026-10-09 v2.4.1，幂等） ----------------
   站主原话：「后台的权力是最大的，即使他修改了可见范围，但是后台还是可以修改」。
   规则：**站主动过这个字段的可见性 → 同学自己设的「仅自己可见」不再生效**。

   ⚠️ 为什么需要这一列，而不能靠「visibility 与出厂值比对」判断：
      站主完全可能把一个字段设成它本来就是这个档（比如 wechat 出厂就是 public，
      他点了「公开」按钮）—— 值没变化，比对法就分辨不出「动过」和「没动过」，
      表现为「站主明明改了，同学的私密设置却依然生效」。必须显式记录。
   is_custom = true 的字段由站主新增时指定可见性，视为天然已锁定。 */
alter table profile_field_meta add column if not exists vis_locked boolean not null default false;

/* ---------------- 预置字段元数据（幂等：已存在则不动，避免覆盖后台的改动） ----------------
   ⚠️ on conflict do nothing：后台改过 visibility 后，重跑本脚本不会把它改回去。
   ⚠️ 身份证号 / 发展团员编号于 2026-10-09（v2.4.0）起**真正建列**——
      此前只登记元数据、profiles 表没有真实列，等于点了没用。 */
insert into profile_field_meta (field, label, visibility, sort_order, is_custom) values
  ('name',            '姓名',         'public', 10,  false),
  ('student_id',      '学号',         'public', 20,  false),
  ('politics',        '政治面貌',      'public', 30,  false),
  ('exam_no',         '智学网账号',    'public', 40,  false),
  ('role',            '身份',         'public', 50,  false),
  ('title',           '头衔',         'public', 60,  false),
  ('wechat',          '微信',         'public', 70,  false),
  ('qq',              'QQ',          'public', 80,  false),
  ('phone',           '手机号',       'public', 90,  false),
  ('id_card',         '身份证号',      'self',   100, false),
  ('youth_league_no', '发展团员编号',   'self',   110, false),
  -- v3.5.5 需求表新增 6 字段（与既有预置字段同规格，is_custom=false 不可删）
  ('school',          '学校',         'public', 120, false),
  ('class_name',      '班级',         'public', 130, false),
  ('ethnicity',       '民族',         'public', 140, false),
  ('birth_date',      '出生日期',      'self',   150, false),
  ('home_address',    '家庭住址',      'self',   160, false),
  ('league_date',     '入团时间',      'self',   170, false)
on conflict (field) do nothing;

-- ---------------- v3.5.5 预置校验规则（幂等：rules 还是 {} 才写） ----------------
-- 站主要求「原有字段预设好规则」，12 个字段一条 CASE UPDATE 搞定。
-- 管理员在后台自定义后 rules 不再是 {}，本句自动跳过、不覆盖。
update profile_field_meta set rules = case field
    when 'name'            then '{"type":"text","maxLen":3}'::jsonb
    when 'school'          then '{"type":"text","maxLen":6}'::jsonb
    when 'politics'        then '{"type":"select","options":["群众","共青团员"]}'::jsonb
    when 'phone'           then '{"type":"number","digits":11}'::jsonb
    when 'id_card'         then '{"type":"text","maxLen":18}'::jsonb
    when 'youth_league_no' then '{"type":"text","maxLen":40}'::jsonb
    when 'league_date'     then '{"type":"time"}'::jsonb
    when 'class_name'      then '{"type":"text","maxLen":8}'::jsonb
    when 'student_id'      then '{"type":"number","digits":6}'::jsonb
    when 'ethnicity'       then '{"type":"select","options":["汉族","蒙古族","回族","藏族","维吾尔族","苗族","彝族","壮族","布依族","朝鲜族","满族","侗族","瑶族","白族","土家族","哈尼族","哈萨克族","傣族","黎族","畲族"]}'::jsonb
    when 'birth_date'      then '{"type":"time"}'::jsonb
    when 'home_address'    then '{"type":"text","maxLen":30}'::jsonb
  end
 where field in ('name','school','politics','phone','id_card','youth_league_no',
                 'league_date','class_name','student_id','ethnicity','birth_date','home_address')
   and rules = '{}'::jsonb;

/* ---------------- 存量两个「只登记未建列」的字段补真列（2026-10-09，幂等） ----------------
   默认 self（仅本人可见）：身份证号、团员编号属敏感信息，不该默认对外。
   想放开由管理员在「资料管理 → 字段管理」里改，不必改代码。 */
alter table profiles add column if not exists id_card text;
alter table profiles add column if not exists youth_league_no text;
-- v3.5.5 需求表新增 6 字段的列（预置字段才在这里补，自定义字段由 addField 当场建）
alter table profiles
  add column if not exists school       text,
  add column if not exists class_name   text,
  add column if not exists ethnicity    text,
  add column if not exists birth_date   text,
  add column if not exists home_address text,
  add column if not exists league_date  text;

/* ============================================================
   档案字段加密（v3.5.0）
   ------------------------------------------------------------
   站主原话：「成员档案里的所有信息，比如姓名，学号，身份证，微信等等
   全部也加密储存」。

   ① 加密方式是 **应用层加密**（AES-256-GCM，见 api/_lib/profile-crypt.js），
      密钥取环境变量 ADMIN_SECRETS_KEY（与令牌库同一个）。数据库里存的是
      `enc:v1:<base64(iv|ct)>` 这样的文本，直接 select 出来是看不懂的乱码。
      本文件无需改列类型（本来就是 text）。

   ② 为什么要两个 bidx 列：
      密文带随机 IV，同一原值的密文互不相等，`where name = ?` /
      `where student_id = ?` 永远查不到东西。所以另存一列
      **盲索引** = HMAC-SHA256(同一密钥, 规范化原值)：
        · 等值匹配（学号去重、后台按全名搜索）可命中；
        · 不含原值信息，拿到库也反推不出姓名（密钥不在库里）。
      其余字段（身份证 / 微信 / QQ / 手机 / 准考证号…）不做索引，
      读出整行后在内存中解密过滤即可。

   ③ name_hash 那列是早期「SHA-256 精确匹配」的遗留物，已被本次的
      name_bidx 完全取代（同样的思路，但多了密钥，彩虹表打不动）。
      保留列不删，避免动到线上已有数据。

   ④ 学号唯一性：unique 约束必须去掉 —— 密文永不相等，留着也拦不住重复，
      反而会因为「同一学号更新时又插一条」而误报。改由应用层查
      student_id_bidx 保证（见 api/admin.js 的 upsertProfileCore）。
   ============================================================ */
alter table profiles add column if not exists name_bidx       text;
alter table profiles add column if not exists student_id_bidx text;
create index if not exists profiles_name_bidx_idx on profiles (name_bidx);
create index if not exists profiles_sid_bidx_idx  on profiles (student_id_bidx);
/* 去掉老库上的 unique 约束（约束名由 create table 自动生成，先按已知名删，
   再用 DO 块兜一遍「列上有唯一索引但名字不同」的情况）。 */
alter table profiles drop constraint if exists profiles_student_id_key;
do $$
declare
  idx_name text;
begin
  for idx_name in
    select i.relname
      from pg_index x
      join pg_class i on i.oid = x.indexrelid
      join pg_class t on t.oid = x.indrelid
     where t.relname = 'profiles'
       and x.indisunique
       and not x.indisprimary
       and (
         select array_agg(a.attname order by a.attname)
           from pg_attribute a
          where a.attrelid = t.oid and a.attnum = any (x.indkey)
       ) = array['student_id']::name[]
  loop
    execute format('drop index if exists %I', idx_name);
  end loop;
exception when others then
  /* 权限不足或老版本 PG 不支持时静默跳过 —— 唯一性反正已由应用层保证 */
  null;
end $$;

/* ============================================================
   AI 助手账号（2026-10-05）
   ------------------------------------------------------------
   aibot 由用户自行注册（初始为普通 user）。这里把它提为管理员并打上
   is_ai 标记，使它具备「编辑云端公告/作业」的权限。

   ⚠️ 这段是幂等的（update 到同样的值不会有副作用），可以放心重复执行。
   ⚠️ 密码不在这里设置——用户注册时设的是 ai202505，该密码已在对话中
      明文出现过，请在首次登录后立即到「我的账户」自行修改。
   ============================================================ */
update users
   set role = 'admin',
       is_ai = true,
       display_name = coalesce(nullif(display_name, ''), 'ai助手')
 where lower(username) = 'aibot';

/* ---------------- 资料查看日志：谁在什么时候查看了谁 ---------------- */
create table if not exists profile_view_log (
  id         bigserial   primary key,
  viewer_id  bigint      not null references users(id) on delete cascade,  -- 查看者
  target_id  bigint      references profiles(id) on delete set null,       -- 被查看的资料
  target_name text,                                                        -- 冗余存姓名，资料删除后日志仍可读
  keyword    text,                                                         -- 本次查询用的关键词
  ip         text,
  created_at timestamptz not null default now()
);
create index if not exists pvl_viewer_idx on profile_view_log (viewer_id, created_at desc);
create index if not exists pvl_target_idx on profile_view_log (target_id, created_at desc);
create index if not exists pvl_time_idx   on profile_view_log (created_at desc);

/* ============================================================
   成绩分析（第四十三轮 · v2.7.0 起）
   ------------------------------------------------------------
   四张表：exams（考试） / exam_scores（成绩） / share_links（分享） /
           score_config（配置）

   设计要点：
     · **只存原始分**。排名 / 均分 / 分数段 / 上线人数 / 进退步
       全部由浏览器实时算 —— 服务器只搬数据、不算账。
       这样改一个分数之后所有统计立刻自洽，不会留下过期的排名。
     · 分数线允许为空：空 = 这次学校没公布（不画、不统计）。
     · 认人按姓名（站主要求：成绩表不保证按学号排，班上有转学生）。
       所以**不建唯一索引** —— 同名同学要能各占一行；
       导入语义是「整体替换本次」，重名由 api/scores.js 在导入时提示。
     · 未发布的考试（status='draft'）学生看不到，接口层就拦掉。
   ============================================================ */

create table if not exists exams (
  id           bigserial   primary key,
  name         text        not null,                     -- 考试名称（趋势图上的标签）
  exam_date    date        not null,                     -- 考试开始日（趋势与进退步全靠它排序）
  exam_end_date date,                                    -- 考试结束日（跨天联考才填；空＝只考一天）
  exam_type    text,                                     -- 全校联考 / 校际联考 / 月考 / 期中 / 期末
  subjects     jsonb       not null default '[]'::jsonb,  -- [{key,name,full,graded}]
  cutlines     jsonb       not null default '[]'::jsonb,  -- [{key,label,score,color}]，score 空 = 本次没公布
  grade_ref    jsonb,                                     -- {students, avgTotal, avgSubject} 年级参照，可空
  visible_to   jsonb,                                     -- 发布可见范围：null=全体；[uid,...]=只给这些同学
  note         text,                                      -- 备注（如「本次生物未考」）
  status       text        not null default 'draft',       -- draft | published
  published_at timestamptz,
  created_by   bigint      references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists exams_date_idx   on exams (exam_date desc, id desc);
create index if not exists exams_status_idx on exams (status);

create table if not exists exam_scores (
  id           bigserial   primary key,
  exam_id      bigint      not null references exams(id) on delete cascade,
  user_id      bigint      references users(id) on delete set null,  -- 绑定账号后学生才能看到自己那条
  student_name text        not null,
  student_no   text,                                     -- 学号（可选信息，不做匹配依据）
  scores       jsonb       not null default '{}'::jsonb,  -- {科目key:{raw,assigned}}
  school_rank  int,                                      -- 校排名（系统算不出全校，只能导入）
  league_rank  int,                                      -- 联考排名（可选）
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists exam_scores_exam_idx on exam_scores (exam_id, id);
create index if not exists exam_scores_user_idx on exam_scores (user_id);

create table if not exists share_links (
  id         bigserial   primary key,
  token      text        not null unique,                 -- 随机串，就是链接尾巴
  scope      text        not null default 'self',          -- self 自己 / picked 自选 / class 全班
  owner_id   bigint      references users(id) on delete cascade,
  target_ids bigint[],                                    -- （旧字段，未用）
  target_names jsonb,                                     -- 分享给谁（scope=picked 时用，存姓名）
  exam_ids   bigint[],                                    -- 包含哪几次考试
  sections   jsonb       not null default '{}'::jsonb,     -- 显示哪些板块
  expires_at timestamptz,                                 -- 到期时间
  max_views  int,                                         -- 最多被打开几次
  views      int         not null default 0,
  revoked    boolean     not null default false,           -- 撤销开关
  note       text        default '',                       -- v3.8.0 备注（自己认链接用）
  created_at timestamptz not null default now()
);
create index if not exists share_links_owner_idx on share_links (owner_id, created_at desc);

create table if not exists score_config (
  id         int         primary key default 1,
  data       jsonb       not null default '{}'::jsonb,     -- 见 api/scores.js 的 DEFAULT_CONFIG
  updated_at timestamptz not null default now()
);

-- ============================================================
-- v3.5.6 投票管理
--   ① class_votes：一场投票一行。options = [{id,label,by,songId?}]
--      kind='song' 为歌单投票（选项来自点歌平台）
--   ② class_vote_ballots：一人一票（vote_id+user_id 主键），改票即覆盖
-- ensureSchema（http.js）两路径均已同步；SCHEMA_VER = 3.5.9
-- ============================================================
create table if not exists class_votes (
  id         bigserial   primary key,
  title      text        not null,
  kind       text        not null default 'normal',        -- normal 普通 | song 歌单
  options    jsonb       not null default '[]'::jsonb,
  multi      boolean     not null default false,           -- 普通投票是否多选
  allow_add  boolean     not null default false,           -- 允许学生新增选项
  note       text        not null default '',
  deadline   timestamptz,                                  -- 空 = 不限截止
  status     text        not null default 'open',          -- open | closed
  created_by bigint,
  max_choices   smallint,                                   -- v3.5.14 最多选几项（NULL = 不限）
  min_choices   smallint,                                   -- v3.5.14 至少选几项（NULL = 不限）
  retract_limit smallint  not null default 1,               -- v3.5.14 可撤回次数（0 = 不允许）
  end_mode      text      not null default 'keep',          -- v3.5.14 结束后：keep 显示投票 / pub 显示公示并隐藏投票
  option_rule   jsonb,                                      -- v3.5.19 同学新增选项的字数/格式限制
  song_pick     jsonb,                                      -- v3.5.19 歌单投票：取前 N + 用途（daily/music）+ 时长上限
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists class_votes_status_idx on class_votes (status, deadline);

create table if not exists class_vote_ballots (
  vote_id    bigint      not null,
  user_id    bigint      not null,
  choices    jsonb       not null default '[]'::jsonb,     -- 选中的选项 id 数组
  retract_used smallint  not null default 0,                -- v3.5.14 已用撤回次数
  updated_at timestamptz not null default now(),
  primary key (vote_id, user_id)
);
create index if not exists class_vote_ballots_vote_idx on class_vote_ballots (vote_id);

-- ============================================================
-- v3.5.27 歌曲时长云端库
--   站主：「一定要获取到歌曲时长并同步云端，省的每次都要加载，
--          渠道有网易云和 QQ 音乐，如果两个都没有找到由我人工填写，
--          否则无法发布投票或者随机排歌」
--   以前时长只缓存在浏览器 localStorage，换设备/清缓存就全丢，
--   每次开页面都得重新联网搜。现在查到的写库，全站共享。
--   · song_key = 归一化(歌名)|归一化(歌手)，同一首歌只存一行
--   · source：manual 人工填写（优先级最高，不被自动结果覆盖）
--             / netease / qq / itunes / auto
-- ensureSchema（http.js）两路径均已同步；SCHEMA_VER = 3.5.28（v3.5.28 增歌手索引）
-- ============================================================
create table if not exists song_durations (
  song_key   text        primary key,
  title      text        not null default '',
  artist     text        not null default '',
  seconds    int         not null,
  source     text        not null default 'auto',
  updated_at timestamptz not null default now()
);
create index if not exists song_dur_title_idx on song_durations (title);
-- v3.5.28：导入清单按「歌名全等 + 歌手部分匹配」比对，补歌手索引
create index if not exists song_dur_artist_idx on song_durations (artist);
