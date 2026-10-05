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
  name_hash     text        unique,                    -- 姓名 SHA-256（精确匹配用，可空）
  student_id    text        unique,                    -- 学号（管理员维护，唯一）
  politics      text,                                  -- 政治面貌：共青团员 / 普通学生 / 中共党员 等
  role          text        not null default '学生',    -- 学生 | 老师 | 管理员
  /* ---- 以下三项由同学自填，需管理员审核后展示 ---- */
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
create index if not exists profiles_namehash_idx on profiles (name_hash);
create index if not exists profiles_sid_idx     on profiles (student_id);
create index if not exists profiles_user_idx    on profiles (user_id);
create index if not exists profiles_status_idx  on profiles (contact_status);

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
