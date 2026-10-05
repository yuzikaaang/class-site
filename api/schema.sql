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
