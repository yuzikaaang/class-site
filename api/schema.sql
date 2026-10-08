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
  constraint users_status_chk check (status in ('active','banned'))
);

/* 用户名统一小写，方便大小写不敏感登录 */
create unique index if not exists users_username_lower_idx on users (lower(username));

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
  expires_at timestamptz not null
);
create index if not exists sessions_user_idx    on sessions (user_id);
create index if not exists sessions_expires_idx on sessions (expires_at);

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
     PG 的 unique 约束对多行 NULL 不冲突（SQLite 同），故批量建号可留空。 */
  student_id    text        unique,                    -- 学号（管理员维护，唯一，可空）
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

   ⚠️ 本列是**上限**，不是最终值。最终可见性还要与 profiles.visibility_pref
      （本人意愿）取交集，且以更严的一侧为准。

   is_custom：预置字段为 false；将来后台新增的自定义字段为 true，
     便于 UI 区分「系统字段不可删」与「自定义字段可删」。
   ============================================================ */
create table if not exists profile_field_meta (
  field       text        primary key,                 -- 字段名，与 profiles 的列名 / API 字段名一致
  label       text        not null,                    -- 中文显示名
  visibility  text        not null default 'public',   -- public | committee | self
  sort_order  int         not null default 100,        -- 展示顺序（小的在前）
  is_custom   boolean     not null default false,      -- true = 后台新增的自定义字段
  updated_at  timestamptz not null default now(),
  constraint pfm_vis_chk check (visibility in ('public','committee','self'))
);

/* ---------------- 预置字段元数据（幂等：已存在则不动，避免覆盖后台的改动） ----------------
   ⚠️ on conflict do nothing：后台改过 visibility 后，重跑本脚本不会把它改回去。
   身份证号 / 发展团员编号本轮**只登记不建列**——先占好位置，
   下轮后台加列后前端零改动即可展示。 */
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
  ('youth_league_no', '发展团员编号',   'self',   110, false)
on conflict (field) do nothing;

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
