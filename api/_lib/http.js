/* ============================================================
   HTTP 工具：CORS、统一响应、鉴权
   ------------------------------------------------------------
   鉴权用 Authorization: Bearer <token>，不依赖 Cookie。
   原因：前端在 GitHub Pages、API 在 Vercel，属于跨站请求，
   Cookie 需要 SameSite=None + Secure 才可能带上，而微信内置浏览器
   （X5 内核）对第三方 Cookie 限制很严，登录态会莫名其妙掉。
   用 Bearer token 存 localStorage，跨域一样稳定。
   ============================================================ */

import { getSql, cfg } from './db.js';
import { sha256Hex } from './password.js';

/* ============================================================
   表结构自愈（全站公共）
   ------------------------------------------------------------
   背景：2026-10-05 上线「首次登录强制改密 + 登录记录」时新增了
   users.must_change_password 列与 login_log 表。站主如果没在 Neon
   执行建表脚本，任何引用新列的查询都会直接 500 —— 表现为
   「无法登录，服务器内部问题」，且完全依赖人工记得执行 SQL。

   这里做一次幂等的结构补全：缺列补列、缺表建表。Postgres 的
   IF NOT EXISTS 语义保证重复执行无副作用，配合下面的内存标记，
   每个进程生命周期内只真正跑一次，开销可忽略。

   任何失败都只记录警告、不抛错：自愈逻辑绝不能变成新的故障点。
   （若数据库账号没有 DDL 权限，补全失败，但老库的基本登录仍可正常。）

   🔴 2026-10-16（v2.10.1 热修）·版本闸门：
   线上登录 500「Too many subrequests by single Worker invocation」的根因。
   Cloudflare Workers **免费版单次请求子请求上限 50 次**，而 Neon 走 HTTP
   传输（见 db.js 注释），**每条 SQL = 一次子请求**。本函数有 46 条 DDL，
   叠加登录自身约 7 次查询 = 53 次 → 撞线：校验通过、签会话时直接抛错。
   （「登录要等 10 秒」也是这个原因：53 次串行 HTTPS 往返的累积。）

   而 schemaReady 只是**每实例一次**，低流量下 Cloudflare 几乎每个请求都
   落在新实例上 → 每条请求都重跑这 46 条 DDL，纯属浪费。

   所以这里加一道「版本闸门」：先花 1 次往返读库里的表结构版本，
   一致就直接返回；全量 DDL 只在真正需要时（全新库 / 版本升级）才跑。
   稳态下每请求 1 次子请求，登录子请求数 53 → 7。
   ⚠️ 凡是改动下方 DDL 清单，必须同步把 SCHEMA_VER 往上加一格，
      否则老库不会重跑 —— 自愈能力就断了。
   ------------------------------------------------------------ */
/** 表结构版本：DDL 清单每变一次 +1（见上方闸门说明）。 */
const SCHEMA_VER = '3.5.13';
let schemaReady = false;
export async function ensureSchema(sql) {
  if (schemaReady) return;
  /* 先置位再执行：无论成功失败都只尝试一次，避免每次请求都刷一遍日志 */
  schemaReady = true;
  const s = sql || getSql();
  try {
    /* ---------- 版本闸门（详见本函数顶部说明）----------
       一次往返同时问两件事：
         · v       库里已盖的版本章
         · has_ual user_action_log 表在不在（v2.10.0 批次最后建的表）
       已盖章且版本一致 → 直接返回（1 次子请求）。
       没盖章但 2.10.0 批次已跑过（历史线上库，那时还没盖章机制）→
       只补盖章、跳过 DDL，避免白白浪费 45 次子请求把首个请求顶到 50 上限。
       to_regclass 对不存在的表返回 null 而不报错，正好用来探存在性。 */
    try {
      const r = await s`
        select
          (select data->>'schema_ver' from site_settings where id = 1) as v,
          to_regclass('public.user_action_log') is not null as has_ual
      `;
      const row = r && r[0];
      if (row && row.v === SCHEMA_VER) return;
      if (row && row.has_ual) {
        /* 升级路径：老库表都在，这里只补「本次新增的列」，再盖章。
           不能直接 return 不盖章（版本永远对不上、每次请求都重跑闸门）；
           也不能放开跑全量 DDL（46 条 + 请求自身查询会撞 50 子请求上限）。
           ⚠️ 以后每次加列，这里要同步补上这一句，否则老库永远加不上列。 */
        try { await s`alter table exams add column if not exists visible_to jsonb`; } catch (e) {}
        /* v3.5.1 补：档案加密的盲索引两列 + 去 student_id unique。
           🔴 v3.5.0 只把它们加进了下方「全新库全量清单」，漏了这条升级路径，
              且 SCHEMA_VER 也没升 —— 线上老库被闸门直接放行，两列一直没建，
              一点「一键加密存量」就 500（column "name_bidx" does not exist）。
              教训写在函数顶部注释里：「改 DDL 清单必须同步升 SCHEMA_VER」，
           这次两条都犯了，所以这里连 DDL 带版本号一起补。 */
        try { await s`alter table profiles add column if not exists name_bidx text`; } catch (e) {}
        try { await s`alter table profiles add column if not exists student_id_bidx text`; } catch (e) {}
        try { await s`create index if not exists profiles_name_bidx_idx on profiles (name_bidx)`; } catch (e) {}
        try { await s`create index if not exists profiles_sid_bidx_idx  on profiles (student_id_bidx)`; } catch (e) {}
        try { await s`alter table profiles drop constraint if exists profiles_student_id_key`; } catch (e) {}
        /* 🔴 v3.5.4 热修：字段「仅管理员」可见档 500。
           根因：v3.4.1 加了第四档 admin，应用层 ALLOWED_VIS 放了行，
           但 pfm_vis_chk 检查约束从没加这个值 —— create table if not exists
           对老库不生效，线上约束一直是三值版，点「仅管理员」就
           violates check constraint "pfm_vis_chk" → 500。
           修法：老库 drop + add 重建约束（幂等），全新库路径的
           create table 里直接写上 admin。 */
        try { await s`alter table profile_field_meta drop constraint if exists pfm_vis_chk`; } catch (e) {}
        try { await s`alter table profile_field_meta add constraint pfm_vis_chk check (visibility in ('public','committee','self','admin'))`; } catch (e) {}
        /* v3.5.5 字段校验规则（站主：「所有字段支持管理员自定义配置校验规则」）。
           ① rules 列：jsonb，存 {type,maxLen,...}（形状见 _lib/field-rules.js）；
           ② 预置 6 个新字段（学校/班级/民族/出生日期/家庭住址/入团时间）——
              需求表里它们与姓名学号并列，光有规则没有字段等于没有；
           ③ 预置规则：只在 rules 还是 {}（管理员没自定义过）时才写，
              且用 case 一条 UPDATE 搞定 12 个字段（省子请求）。
           ⚠️ 子请求纪律：Workers 免费版单请求 50 上限，这里每条 DDL 一次
              往返 —— 多列合并成一条 ALTER、CASE 合并成一条 UPDATE。 */
        try { await s`alter table profile_field_meta add column if not exists rules jsonb not null default '{}'::jsonb`; } catch (e) {}
        try { await s`
          alter table profiles
            add column if not exists school       text,
            add column if not exists class_name   text,
            add column if not exists ethnicity    text,
            add column if not exists birth_date   text,
            add column if not exists home_address text,
            add column if not exists league_date  text
        `; } catch (e) {}
        try { await s`
          insert into profile_field_meta (field, label, visibility, sort_order, is_custom) values
            ('school',       '学校',     'public', 120, false),
            ('class_name',   '班级',     'public', 130, false),
            ('ethnicity',    '民族',     'public', 140, false),
            ('birth_date',   '出生日期', 'self',   150, false),
            ('home_address', '家庭住址', 'self',   160, false),
            ('league_date',  '入团时间', 'self',   170, false)
          on conflict (field) do nothing
        `; } catch (e) {}
        /* 🔴 v3.5.14：站主「出生日期/民族/班级/学校/家庭住址 怎么删都删不掉」。
           根因：这段预置 insert 是 on conflict do nothing，每升一版又跑一次，
           删掉的字段被重新插回来。现在删字段时写进 site_settings.data.deleted_fields
           墓碑，这里把墓碑里的字段再清掉，升级也不会复活。 */
        try { await s`
          delete from profile_field_meta
           where field in (
             select jsonb_array_elements_text(
               coalesce((select data->'deleted_fields' from site_settings where id = 1), '[]'::jsonb)
             )
           )
        `; } catch (e) {}
        try { await s`
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
             and rules = '{}'::jsonb
        `; } catch (e) {}
        /* v3.5.6 投票管理：两张新表（全新库路径的建表语句在下方全量清单里，
           这里给老库补上；create table if not exists 幂等，重复跑无害）。 */
        try { await s`
          create table if not exists class_votes (
            id         bigserial   primary key,
            title      text        not null,
            kind       text        not null default 'normal',
            options    jsonb       not null default '[]'::jsonb,
            multi      boolean     not null default false,
            allow_add  boolean     not null default false,
            note       text        not null default '',
            deadline   timestamptz,
            status     text        not null default 'open',
            created_by bigint,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
          )
        `; } catch (e) {}
        try { await s`
          create table if not exists class_vote_ballots (
            vote_id    bigint      not null,
            user_id    bigint      not null,
            choices    jsonb       not null default '[]'::jsonb,
            updated_at timestamptz not null default now(),
            primary key (vote_id, user_id)
          )
        `; } catch (e) {}
        /* 🔴 v3.5.13 热修（站主反馈「投票显示服务器错误无法加载」）：
           v3.5.12 给 class_votes 加 proposer 列时只进了「全新库全量清单」，
           漏了这条升级路径且 SCHEMA_VER 没升 —— 线上老库被版本闸门放行，
           列一直没建，listVotes 一 select v.proposer 就
           column "proposer" does not exist → 500。
           和 v3.5.2 盲索引、v3.5.4 可见档是同一类错误，第三次了。 */
        try { await s`alter table class_votes add column if not exists proposer text not null default ''`; } catch (e) {}
        /* 🔴 v3.5.14 #9：投票票数配额与撤回次数。
           纪律（已踩三次坑）：升级路径 + 全新库清单 + schema.sql 三处必须同时改，
           并升 SCHEMA_VER —— 少一处就是线上 500。
           升级路径合并成 2 条 ALTER，避免撞 Workers 免费版 50 子请求上限。 */
        try { await s`alter table class_votes
          add column if not exists max_choices smallint,
          add column if not exists min_choices smallint,
          add column if not exists retract_limit smallint not null default 1,
          add column if not exists end_mode text not null default 'keep'`; } catch (e) {}
        try { await s`alter table class_vote_ballots add column if not exists retract_used smallint not null default 0`; } catch (e) {}
        /* 🔴 v3.5.14：站主截图「头衔任命 加载失败：column p.title does not exist」。
           title / exam_no / visibility_pref / field_vis / id_card / youth_league_no
           这些列只在「全新库全量清单」里补过，老库走到本分支就 return 了，一直没建。
           现在按纪律补进升级路径（每条都 if not exists，重复跑无害）。 */
        /* 实测线上还缺 role（老库更早的建表就没有这一列）：一起补 */
        try { await s`alter table profiles add column if not exists role text not null default '学生'`; } catch (e) {}
        try { await s`alter table profiles add column if not exists politics text`; } catch (e) {}
        try { await s`alter table profiles add column if not exists contact_status text not null default 'none'`; } catch (e) {}
        try { await s`alter table profiles add column if not exists title text`; } catch (e) {}
        try { await s`alter table profiles add column if not exists exam_no text`; } catch (e) {}
        try { await s`alter table profiles add column if not exists visibility_pref text`; } catch (e) {}
        try { await s`alter table profiles add column if not exists field_vis text`; } catch (e) {}
        try { await s`alter table profiles add column if not exists id_card text`; } catch (e) {}
        try { await s`alter table profiles add column if not exists youth_league_no text`; } catch (e) {}
        await s`
          insert into site_settings (id, data, updated_at)
          values (1, ${JSON.stringify({ schema_ver: SCHEMA_VER })}::jsonb, now())
          on conflict (id) do update
            set data = site_settings.data || excluded.data, updated_at = now()
        `;
        return;
      }
    } catch (e) {
      /* site_settings / user_action_log 都不存在（全新库）→ 继续跑全量 DDL */
    }
    await s`
      alter table users add column if not exists must_change_password
        boolean not null default false
    `;
    /* 🔴 2026-10-07 第二十七轮·真根因：
       登录限流用的这两列只写在 schema.sql 里（需要人工执行才生效），
       但 ensureSchema（自动自愈）**漏了它们**。线上库没跑过 schema.sql 的话，
       这两列根本不存在，于是任何写它们的 SQL 都会 500：
         · auth.js 的 bumpFail / clearFail → 有 try-catch，静默失败
           （所以「登录」表面正常，其实限流一直没生效）
         · admin.js 的 reset-password、auth.js 的 change-password
           → 裸写无保护 → 直接 500「服务器内部错误」
       这就是「后台重置密码 500」「改密码 500」真正的、唯一的原因
       （而不是之前以为的 CPU 派生次数——那个是次要影响因素）。
       补进自愈后，部署即自动建列，不必手动跑 SQL。 */
    await s`alter table users add column if not exists failed_count int not null default 0`;
    await s`alter table users add column if not exists locked_until timestamptz`;
    /* 2026-10-07「最后上线」：与 last_login_at（登录时刻）区分，
       由前端心跳 /api/auth?action=ping 刷新，关掉页面后停更 */
    await s`
      alter table users add column if not exists last_seen_at timestamptz
    `;
    /* v2.5.0「真·在线检测」：会话粒度的在线时间。
       以前只有 users.last_seen_at（用户粒度），只能知道「这个人最近在不在」，
       分不清同一账号的多台设备，也无法精确到「此刻这个会话还在不在」。
       心跳每 60 秒刷新该列，后台按「90 秒内有更新」判定在线。 */
    await s`
      alter table sessions add column if not exists last_seen_at timestamptz
    `;
    await s`
      create table if not exists login_log (
        id         bigserial   primary key,
        user_id    bigint      not null references users(id) on delete cascade,
        ip         text,
        user_agent text,
        created_at timestamptz not null default now()
      )
    `;
    await s`
      create index if not exists login_log_user_idx
        on login_log (user_id, created_at desc)
    `;
    await s`
      create index if not exists login_log_time_idx
        on login_log (created_at desc)
    `;
    /* 班级通讯录 / 个人资料（与 schema.sql 保持一致，见该文件的说明） */
    await s`
      create table if not exists profiles (
        id             bigserial   primary key,
        name           text,
        name_hash      text        unique,
        student_id     text,
        politics       text,
        exam_no        text,
        role           text        not null default '学生',
        wechat         text,
        qq             text,
        phone          text,
        contact_status text        not null default 'none',
        reject_reason  text,
        user_id        bigint      references users(id) on delete set null,
        created_at     timestamptz not null default now(),
        updated_at     timestamptz not null default now()
      )
    `;
    /* 老库补列：exam_no 是后加的（2026-10-05 导入名单时需要）。 */
    await s`alter table profiles add column if not exists exam_no text`;
    /* 头衔（班长/团支书/课代表…），2026-10-05 新增。
       存英文逗号分隔的纯文本，如 '团支书,课代表'——一个人可兼多职。
       授权判定只认本列的服务端值，绝不接受前端传参。 */
    await s`alter table profiles add column if not exists title text`;
    /* 本人可见性意愿（2026-10-08 新增）：JSON 文本，存本人愿意公开的字段。
       最终可见性 = 全班默认（profile_field_meta.visibility）∩ 本人意愿 ∩ 单人例外，取最严一侧。 */
    await s`alter table profiles add column if not exists visibility_pref text`;
    /* 单人字段可见性例外（2026-10-09 新增）：JSON 文本，管理员给某一条资料设的例外。
       与 visibility_pref 的区别见 schema.sql 该列的注释。 */
    await s`alter table profiles add column if not exists field_vis text`;
    /* 资料字段元数据（2026-10-08 新增）：可见性分档 + 自定义字段的地基。
       详见 schema.sql 中该表的注释。 */
    await s`
      create table if not exists profile_field_meta (
        field       text        primary key,
        label       text        not null,
        visibility  text        not null default 'public',
        sort_order  int         not null default 100,
        is_custom   boolean     not null default false,
        vis_locked  boolean     not null default false,
        updated_at  timestamptz not null default now(),
        /* v3.5.5：字段校验规则（{type:'text'|'number'|'time'|'select', ...}），
           形状与默认值见 _lib/field-rules.js 的 normalizeRules。 */
        rules       jsonb       not null default '{}'::jsonb,
        constraint pfm_vis_chk check (visibility in ('public','committee','self','admin'))
      )
    `;
    /* vis_locked 补列（2026-10-09 v2.4.1）：老库升级用。
       true = 站主在后台设过该字段的可见性 → 以站主为准，同学自己的
       「仅自己可见」不再生效（站主要求「后台权力最大」）。
       ⚠️ 不能靠「visibility 是否等于出厂值」来判断「动没动过」——
          站主可能把字段设成它本来就有的档（值没变），比对法分辨不出来。 */
    await s`alter table profile_field_meta add column if not exists vis_locked boolean not null default false`;
    /* 预置字段元数据。on conflict do nothing —— 后台改过之后重跑不会覆盖。 */
    await s`
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
        /* v3.5.5 需求表新增 6 字段：学校/班级/民族/出生日期/家庭住址/入团时间。
           与既有预置字段同规格：is_custom=false（后台不可删），走通用
           fields 通道受 profile_field_meta.visibility 管辖。 */
        ('school',          '学校',         'public', 120, false),
        ('class_name',      '班级',         'public', 130, false),
        ('ethnicity',       '民族',         'public', 140, false),
        ('birth_date',      '出生日期',      'self',   150, false),
        ('home_address',    '家庭住址',      'self',   160, false),
        ('league_date',     '入团时间',      'self',   170, false)
      on conflict (field) do nothing
    `;
    /* v3.5.14：再次应用「已删除」墓碑（升级路径删掉的字段，别被全量清单复活） */
    try { await s`
      delete from profile_field_meta
       where field in (
         select jsonb_array_elements_text(
           coalesce((select data->'deleted_fields' from site_settings where id = 1), '[]'::jsonb)
         )
       )
    `; } catch (e) {}
    /* v3.5.5 预置规则（与升级路径同款 CASE）：12 个字段的出厂校验规则，
       只在 rules 还是 {} 时写 —— 尊重管理员自定义，重跑不覆盖。 */
    await s`
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
         and rules = '{}'::jsonb
    `;
    /* 2026-10-09（v2.4.0）：让上面两个「只登记未建列」的字段真正有列。
       ⚠️ 这里只补**预置**字段的列。
          后台新增的自定义字段**绝不能**放进来：
          schemaReady 是「每实例只跑一次」的标记，而本 try-catch 一旦在
          某条 DDL 上报错就会吞掉异常、跳过后面所有语句 —— 把动态字段
          塞进来，一个坏字段就能让整段自愈失效。自定义字段一律在
          api/admin.js 的 addField 里「当场 alter table」。 */
    await s`alter table profiles add column if not exists id_card text`;
    await s`alter table profiles add column if not exists youth_league_no text`;
    /* v3.5.5：需求表新增 6 字段的列（与升级路径合并 ALTER 对应，
       全新库这里同样只补预置字段的列，自定义字段仍在 addField 当场建）。 */
    await s`
      alter table profiles
        add column if not exists school       text,
        add column if not exists class_name   text,
        add column if not exists ethnicity    text,
        add column if not exists birth_date   text,
        add column if not exists home_address text,
        add column if not exists league_date  text
    `;
    /* 档案字段加密的盲索引列（v3.5.0）。
       name / student_id 存密文后无法 like / = 检索，另存一列
       HMAC-SHA256(密钥, 规范化原值) 供等值匹配（学号去重、后台全名搜索）。
       详见 api/_lib/profile-crypt.js 与 schema.sql 末段的说明。 */
    await s`alter table profiles add column if not exists name_bidx text`;
    await s`alter table profiles add column if not exists student_id_bidx text`;
    await s`create index if not exists profiles_name_bidx_idx on profiles (name_bidx)`;
    await s`create index if not exists profiles_sid_bidx_idx  on profiles (student_id_bidx)`;
    /* 去掉 student_id 的 unique 约束：加密后同一学号每次密文都不同，
       unique 永远拦不住重复，反倒在「更新同一学号」时误报唯一冲突。
       学号唯一性改由应用层查 student_id_bidx 保证（api/admin.js）。 */
    await s`alter table profiles drop constraint if exists profiles_student_id_key`;
    /* 标记 AI 账号，2026-10-05 新增。用于「AI 可编辑云端内容」与后续交接。 */
    await s`
      alter table users add column if not exists is_ai
        boolean not null default false
    `;
    await s`
      create table if not exists profile_view_log (
        id          bigserial   primary key,
        viewer_id   bigint      not null references users(id) on delete cascade,
        target_id   bigint      references profiles(id) on delete set null,
        target_name text,
        keyword     text,
        ip          text,
        created_at  timestamptz not null default now()
      )
    `;
    await s`create index if not exists profiles_name_idx    on profiles (name)`;
    await s`create index if not exists profiles_exam_idx    on profiles (exam_no)`;
    await s`create index if not exists profiles_sid_idx     on profiles (student_id)`;
    await s`create index if not exists profiles_user_idx    on profiles (user_id)`;
    await s`create index if not exists profiles_status_idx  on profiles (contact_status)`;
    await s`create index if not exists pvl_viewer_idx on profile_view_log (viewer_id, created_at desc)`;
    await s`create index if not exists pvl_target_idx on profile_view_log (target_id, created_at desc)`;
    await s`create index if not exists pvl_time_idx   on profile_view_log (created_at desc)`;

    /* ===== 成绩分析（第四十三轮·v2.7.0 起）=====
       四张表：考试 / 成绩 / 分享链接 / 配置。
       设计要点：**只存原始分**，排名与统计全部交给浏览器实时算 ——
       服务器只搬数据、不算账（详见 api/scores.js 顶部注释）。

       ⚠️ 放在 ensureSchema 的最末尾是有意的：本 try-catch 一旦在某条 DDL
          上报错就会吞掉异常并跳过后面所有语句（见上方 2026-10-09 的教训），
          放在最后可以保证「即使成绩表建不出来，登录等既有功能也不受影响」。 */
    await s`
      create table if not exists exams (
        id           bigserial   primary key,
        name         text        not null,
        exam_date    date        not null,
        exam_type    text,
        subjects     jsonb       not null default '[]'::jsonb,
        cutlines     jsonb       not null default '[]'::jsonb,
        grade_ref    jsonb,
        visible_to   jsonb,      -- 发布可见范围：null=全体；[uid,...]=只给这些同学
        note         text,
        status       text        not null default 'draft',
        published_at timestamptz,
        created_by   bigint      references users(id) on delete set null,
        created_at   timestamptz not null default now(),
        updated_at   timestamptz not null default now()
      )
    `;
    /* 考试跨天支持（v2.7.4）：5/14—15 这种联考要能存起止。老库靠这句自愈。 */
    await s`alter table exams add column if not exists exam_end_date date`;
    await s`create index if not exists exams_date_idx   on exams (exam_date desc, id desc)`;
    await s`create index if not exists exams_status_idx on exams (status)`;
    /* 认人按姓名（站主要求）：不建唯一索引 —— 同名同学要能各占一行，
       导入语义是「整体替换本次」，重名由 api/scores.js 在导入时提示。 */
    await s`
      create table if not exists exam_scores (
        id           bigserial   primary key,
        exam_id      bigint      not null references exams(id) on delete cascade,
        user_id      bigint      references users(id) on delete set null,
        student_name text        not null,
        student_no   text,
        scores       jsonb       not null default '{}'::jsonb,
        school_rank  int,
        league_rank  int,
        note         text,
        created_at   timestamptz not null default now(),
        updated_at   timestamptz not null default now()
      )
    `;
    await s`create index if not exists exam_scores_exam_idx on exam_scores (exam_id, id)`;
    await s`create index if not exists exam_scores_user_idx on exam_scores (user_id)`;
    await s`
      create table if not exists share_links (
        id         bigserial   primary key,
        token      text        not null unique,
        scope      text        not null default 'self',
        owner_id   bigint      references users(id) on delete cascade,
        target_ids bigint[],
        exam_ids   bigint[],
        sections   jsonb       not null default '{}'::jsonb,
        expires_at timestamptz,
        max_views  int,
        views      int         not null default 0,
        revoked    boolean     not null default false,
        created_at timestamptz not null default now()
      )
    `;
    await s`create index if not exists share_links_owner_idx on share_links (owner_id, created_at desc)`;
    /* 自选分享的名单（v2.8.3 分享链接） */
    await s`alter table share_links add column if not exists target_names jsonb`;
    /* 分享内容开关（v2.9.7：分析也可以自定义分享内容）——
       老库的 share_links 已经建好了，光改 create table 是加不上列的，
       必须显式 alter，否则线上写 sections 直接报错。 */
    await s`alter table share_links add column if not exists sections jsonb not null default '{}'::jsonb`;
    await s`
      create table if not exists score_config (
        id         int         primary key default 1,
        data       jsonb       not null default '{}'::jsonb,
        updated_at timestamptz not null default now()
      )
    `;
    /* ===== v2.10.0 注册审核 + 站点设置（第六十轮）=====
       ① users.status 增加 'pending'（待审核）：
          改约束只能「先删后加」，drop if exists 保证幂等。
       ② site_settings：单行 jsonb，存后台可改的站点级开关
          （register_open 注册总开关 / register_review 注册审核）。
       依旧放在 ensureSchema 最末尾：前面的语句出错会吞异常跳过后面，
       新功能不能影响既有功能的建表。 */
    await s`alter table users drop constraint if exists users_status_chk`;
    await s`alter table users add constraint users_status_chk check (status in ('active','banned','pending'))`;
    await s`
      create table if not exists site_settings (
        id         int         primary key default 1,
        data       jsonb       not null default '{}'::jsonb,
        updated_at timestamptz not null default now()
      )
    `;
    /* v2.10.0 用户操作日志表：全点击交互上报（攒批写入）。
       索引按「管理后台两种查法」建：按时间倒序翻页 + 按用户查。 */
    await s`
      create table if not exists user_action_log (
        id         bigserial   primary key,
        user_id    bigint      not null references users(id) on delete cascade,
        action     text        not null default 'click',
        page       text        not null default '',
        target     text        not null default '',
        detail     text        not null default '',
        ip         text,
        created_at timestamptz not null default now()
      )
    `;
    await s`create index if not exists ual_time_idx on user_action_log (created_at desc)`;
    await s`create index if not exists ual_user_idx on user_action_log (user_id, created_at desc)`;

    /* ===== v3.5.6 投票管理（class_votes / class_vote_ballots）=====
       ① class_votes：一场投票一行。options 是 jsonb 数组
          [{id:'o1', label:'…', by:'admin'|'student', songId?}]；
          kind='song' 是歌单投票（选项来自点歌平台，songId 回查用）；
          deadline 为空 = 不限截止；status='closed' = 手动截止。
       ② class_vote_ballots：一人一行一票（vote_id+user_id 主键），
          choices 存选中的选项 id 数组；改票 = 覆盖 choices。
       放在 ensureSchema 最末尾：前面的语句出错会吞异常跳过后面，
       新功能不能影响既有功能的建表。 */
    await s`
      create table if not exists class_votes (
        id         bigserial   primary key,
        title      text        not null,
        kind       text        not null default 'normal',
        options    jsonb       not null default '[]'::jsonb,
        multi      boolean     not null default false,
        allow_add  boolean     not null default false,
        note       text        not null default '',
        deadline   timestamptz,
        status     text        not null default 'open',
        created_by bigint,
        proposer   text        not null default '',
        max_choices   smallint,
        min_choices   smallint,
        retract_limit smallint not null default 1,
        end_mode      text     not null default 'keep',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;
    /* v3.5.12 #10：老库补 proposer 列（提出人）。幂等，重复跑无害。 */
    await s`alter table class_votes add column if not exists proposer text not null default ''`;
    /* v3.5.14 #9：票数配额 + 撤回次数（class_votes 已建好，直接补列） */
    await s`alter table class_votes
      add column if not exists max_choices smallint,
      add column if not exists min_choices smallint,
      add column if not exists retract_limit smallint not null default 1,
      add column if not exists end_mode text not null default 'keep'`;
    await s`
      create table if not exists class_vote_ballots (
        vote_id    bigint      not null,
        user_id    bigint      not null,
        choices    jsonb       not null default '[]'::jsonb,
        retract_used smallint  not null default 0,
        updated_at timestamptz not null default now(),
        primary key (vote_id, user_id)
      )
    `;
    /* ⚠️ 顺序要紧：ALTER 必须在建表之后 —— 全新库先 alter 会报
       no such table 并中断整段 DDL（v3.5.14 实测踩到） */
    await s`alter table class_vote_ballots add column if not exists retract_used smallint not null default 0`;
    await s`create index if not exists cvb_vote_idx on class_vote_ballots (vote_id)`;

    /* 全量跑完 → 盖章。下一条请求起走「版本一致直接返回」的捷径。
       用 || 合并而不是整行覆盖：site_settings 里还存着 register_open /
       register_review 等后台开关（见 db.js 的 setSiteSetting），不能冲掉。 */
    await s`
      insert into site_settings (id, data, updated_at)
      values (1, ${JSON.stringify({ schema_ver: SCHEMA_VER })}::jsonb, now())
      on conflict (id) do update
        set data = site_settings.data || excluded.data, updated_at = now()
    `;
  } catch (e) {
    /* 自愈失败不抛错：老库的基本功能仍可用（只是少了强制改密与登录记录）。
       只警告一次，避免每次请求都刷日志把真正的问题淹没。
       （测试桩 SQLite 不支持 ADD COLUMN IF NOT EXISTS，会走到这里，属预期。） */
    console.warn('[schema] 表结构自愈未完成（不影响基本功能）：', e.message);
  }
}

/** 允许的请求头 / 方法 */
const ALLOW_HEADERS = 'Content-Type, Authorization';
const ALLOW_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';

/**
 * 按白名单设置 CORS 响应头。
 * 跨站请求必须回显具体 Origin，不能回 '*'（带 Authorization 时浏览器会拒绝）。
 */
export function cors(req, res) {
  const origin = req.headers.origin || '';
  const { allowOrigins } = cfg();

  /* 站规（2026-09-30 第十八轮立）：不在白名单就【不输出】Access-Control-Allow-Origin，
     不得回退到白名单任一项——旧写法 `includes(origin) ? origin : allowOrigins[0]`
     会让任意来源都收到白名单第一项，构成防御纵深缺失。Workers 版 2026-10-06 补落实。 */
  let allow = '';
  if (allowOrigins.includes('*')) {
    /* 白名单是 * 时，回显具体来源，方便本地调试 */
    allow = origin;
  } else if (allowOrigins.includes(origin)) {
    allow = origin;
  }

  if (allow) res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
  res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
  /* 预检结果缓存 24 小时，减少 OPTIONS 请求 */
  res.setHeader('Access-Control-Max-Age', '86400');
}

/** 预检请求直接放行 */
export function handlePreflight(req, res) {
  if (req.method === 'OPTIONS') {
    /* 注意：Vercel 的 res 是原生 Node ServerResponse，没有 Express 的 res.status()，
       必须用 statusCode + end()。这里曾经用 res.status(204) 导致预检 500。 */
    cors(req, res);
    res.statusCode = 204;
    res.setHeader('Content-Length', '0');
    res.end();
    return true;
  }
  return false;
}

/** 统一 JSON 响应 */
export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  /* 接口一律不缓存，避免拿到过期的登录态/数据 */
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.end(JSON.stringify(body));
}

export function ok(res, data) {
  json(res, 200, { ok: true, ...data });
}

export function fail(res, status, msg, extra) {
  json(res, status, { ok: false, error: msg, ...(extra || {}) });
}

/** 读取请求体。
 *  - Workers：入口已把请求体预读成字符串挂在 req.__rawBody
 *  - Vercel / FC：body 可能已是对象、字符串或 Buffer，做兼容
 *  - 兜底：手动读流（仅 Node 环境有流事件）
 */
export async function body(req) {
  if (req.body && typeof req.body === 'object' && !isBuffer(req.body)) return req.body;

  /* Workers 入口预读的原始串 */
  let raw = req.__rawBody !== undefined ? req.__rawBody : req.body;

  if (isBuffer(raw)) raw = raw.toString('utf-8');
  if (typeof raw === 'string' && raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (raw === '' || raw === undefined || raw === null) {
    /* Workers 下没有流事件，直接返回空对象 */
    if (!req.on) return {};
  }

  /* 兜底：Node 环境手动读流 */
  if (!req.on) return {};
  return await new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/** 兼容判断 Buffer（Workers 里没有 Buffer 全局） */
function isBuffer(v) {
  return typeof Buffer !== 'undefined' && Buffer.isBuffer(v);
}

/* ---------------- 会话与鉴权 ---------------- */

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : '';
}

/**
 * 轻量版当前用户：只查会话 → 用户，不做 ensureSchema、不查 profiles。
 *
 * 用途（2026-10-07 第二十七轮）：改密码这种「还要再跑两次 PBKDF2」的接口，
 * CPU 预算本来就紧。完整的 currentUser 会先跑一遍 ensureSchema（多条 DDL）
 * 再查 profiles，叠加两次派生很容易越过 Workers 的 10ms CPU 上限 →
 * 表现为「原密码正确却 500」。这里只取鉴权与改密必需的字段，把预算留给密码计算。
 *
 * 注意：它**不保证** must_change_password 列存在，所以绝不能拿它当通用鉴权用。
 */
async function currentUserSlim(req) {
  const token = bearer(req);
  if (!token) return null;
  const sql = getSql();
  const tokenHash = await sha256Hex(token);
  const rows = await sql`
    select u.id, u.username, u.role, u.status, u.display_name
      from sessions s
      join users u on u.id = s.user_id
     where (s.token = ${tokenHash} or s.token = ${token})
       and s.expires_at > now()
     limit 1
  `;
  if (!rows.length) return null;
  const u = rows[0];
  if (u.status !== 'active') return null;
  return {
    id: Number(u.id),
    username: u.username,
    role: u.role,
    displayName: u.display_name,
    isAI: false,
  };
}

/** 轻量鉴权：给「CPU 预算紧张」的接口用（目前是改密码）。 */
export async function requireUserSlim(req, res) {
  const u = await currentUserSlim(req);
  if (!u) {
    fail(res, 401, '未登录或登录已过期，请重新登录');
    return null;
  }
  return u;
}

/**
 * 解析当前登录用户。
 * @returns {Promise<{id:number,username:string,role:string}|null>}
 */
export async function currentUser(req) {
  const token = bearer(req);
  if (!token) return null;
  const sql = getSql();
  /* 确保 must_change_password 列存在，否则下面的 select 会整条失败 */
  await ensureSchema(sql);
  /* 会话表存的是 sha256(token)；升级前的老会话仍是明文 token，
     这里两种都匹配，保证平滑迁移、不强制重登。 */
  const tokenHash = await sha256Hex(token);
  const rows = await sql`
    select u.id, u.username, u.role, u.status, u.display_name, u.created_at,
           coalesce(u.must_change_password, false) as must_change_password,
           coalesce(u.is_ai, false) as is_ai,
           s.expires_at, s.token as session_token
      from sessions s
      join users u on u.id = s.user_id
     where (s.token = ${tokenHash} or s.token = ${token})
       and s.expires_at > now()
     limit 1
  `;
  if (!rows.length) return null;
  const u = rows[0];
  if (u.status !== 'active') return null;

  /* 查该账号认领的班级资料（可能没有）。
     profiles 表由 ensureSchema 保证存在；查询失败不阻断登录态。
     这里一并取出 role/title：role 是「学生/老师/管理员」的展示字段（与
     users.role 的 user/admin 是两套东西，别混），title 是头衔，授权时要用。 */
  let profileId = null;
  let profileRole = null;
  let title = '';
  try {
    const pr = await sql`select id, role, title from profiles where user_id = ${u.id} limit 1`;
    if (pr.length) {
      profileId = Number(pr[0].id);
      profileRole = pr[0].role || null;
      title = pr[0].title || '';
    }
  } catch (e) {
    /* 老库或无 DDL 权限时可能查不到，忽略即可 */
  }

  return {
    id: Number(u.id),
    username: u.username,
    role: u.role,
    displayName: u.display_name,
    createdAt: u.created_at,
    mustChangePassword: !!u.must_change_password,
    profileId,
    profileRole,
    title,
    isAI: !!u.is_ai,
    /* 当前会话标识（sha256 后的 token）。心跳拿它精确更新「这个会话」的
       last_seen_at，从而支持按设备/会话判定在线；不下发给前端。 */
    sessionToken: u.session_token || '',
  };
}

/** 要求已登录；未登录时直接写入 401 并返回 null */
export async function requireUser(req, res) {
  const u = await currentUser(req);
  if (!u) {
    fail(res, 401, '未登录或登录已过期，请重新登录');
    return null;
  }
  return u;
}

/** 要求管理员；权限不足时写入 403 并返回 null */
export async function requireAdmin(req, res) {
  const u = await requireUser(req, res);
  if (!u) return null;
  if (u.role !== 'admin') {
    fail(res, 403, '需要管理员权限');
    return null;
  }
  return u;
}

/**
 * 班委头衔清单（2026-10-08 新增）。
 *
 * 用途：资料字段可见性里的 `committee` 档——「班委可见」的字段，
 * 只有持有下列头衔之一的人（或管理员 / AI 账号）才能查到。
 *
 * ⚠️ name 里的值必须与后台「头衔任命」所用的字面量完全一致
 *    （见 api/admin.js 的 ALLOWED_TITLES）。
 * ⚠️ 这是**服务端**常量，不接受任何前端传参。
 */
export const COMMITTEE_TITLES = ['班长', '副班长', '团支书', '副团支书', '课代表', '电教委', '劳动委员', '纪律委员', '宣传委员', '体育委员', '文娱委员', '卫生委员', '生活委员', '学习委员'];

/** 把 profiles.title 的文本切成头衔数组（与 requireTitle 同一套切分规则） */
export function splitTitles(raw) {
  return String(raw || '')
    .split(/[,，、\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * 判断当前用户是否算「班委」（可见性 committee 档的门槛）。
 *
 * 管理员与 AI 账号天然算（它们本就该能看一切）。
 * 注意：**不要**把这个判定塞进 currentUser()——那会让每个请求都多算一次；
 * 只在 profile.js 真正需要分档的接口里调用。
 *
 * @param {{role?:string,isAI?:boolean,title?:string}|null} u
 */
export function isCommittee(u) {
  if (!u) return false;
  if (u.role === 'admin' || u.isAI) return true;
  const list = splitTitles(u.title);
  return list.some((t) => COMMITTEE_TITLES.includes(t));
}

/* ============================================================
   自定义资料字段：字段名校验（2026-10-09 v2.4.0 新增）
   ------------------------------------------------------------
   🔴 这是本功能**唯一的 SQL 注入防线**，改动前请先读完本段。

   为什么必须白名单：
     站主需求是「后台直接新增一个资料字段」，实现上要执行
       alter table profiles add column <字段名> text
     —— 而 `sql` 模板标记只能参数化**值**，**列名/表名无法参数化**。
     字段名只能字符串拼接进 SQL。若不校验，管理员（或任何拿到管理员
     令牌的人）传 field = `x text; drop table profiles; --`
     就是一条完整的 SQL 注入。
     所以：**只允许严格匹配下面正则的字段名**，其余一律拒绝。

   为什么要黑名单：
     即便格式合法，若字段名撞上 profiles 已有列，`add column` 会报错
     或被 if not exists 静默跳过 —— 而 meta 表却新增了一行，
     造成「元数据说有、列也有但含义完全不同」的错位。
     最危险的是 name_hash / user_id / visibility_pref 这类**有业务语义**的列。
     所以格式校验通过后还要再挡一层列名黑名单。
   ============================================================ */

/** 字段名格式：小写字母开头，后跟小写字母/数字/下划线，总长 ≤ 31 */
export const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,30}$/;

/**
 * profiles 表**已有**的列名 —— 自定义字段禁止占用。
 * 与 api/schema.sql 的 profiles 建表保持一致；加列后请同步更新本清单。
 */
export const RESERVED_PROFILE_COLS = [
  'id', 'name', 'name_hash', 'student_id', 'politics', 'exam_no', 'role',
  'wechat', 'qq', 'phone', 'contact_status', 'reject_reason', 'user_id',
  'created_at', 'updated_at',
  'title', 'visibility_pref', 'field_vis',
  'id_card', 'youth_league_no',
];

/**
 * 校验自定义字段名是否可用。
 * @param {string} raw 前端传来的字段名
 * @returns {{ok:true, field:string} | {ok:false, reason:string}}
 */
export function checkFieldName(raw) {
  const field = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!field) return { ok: false, reason: '缺少字段名' };
  if (field.length > 31) return { ok: false, reason: '字段名最长 31 个字符' };
  if (!FIELD_NAME_RE.test(field)) {
    return {
      ok: false,
      reason: '字段名只能用小写字母开头，由小写字母、数字、下划线组成（如 school_id）',
    };
  }
  /* SQL 关键字也挡一下：虽然加了引号后 PG 能容忍，但拼进 SQL 容易出意外 */
  if (SQL_KEYWORDS.has(field)) {
    return { ok: false, reason: '「' + field + '」是数据库保留字，请换一个名字' };
  }
  if (RESERVED_PROFILE_COLS.includes(field)) {
    return { ok: false, reason: '「' + field + '」与系统已有字段重名，请换一个名字' };
  }
  return { ok: true, field };
}

/**
 * 只验「格式是否合法」，不查重名黑名单。
 *
 * 用途：写入路径校验**已在 meta 表里登记过**的字段名。
 *   meta 表里的字段当初都过了 checkFieldName（含重名检查），
 *   所以这里只需防「历史脏数据 / 迁移异常」混进非法字符即可。
 *
 * ⚠️ 不要用它替代 checkFieldName 的「新增字段」入口校验 ——
 *    新增字段必须用 checkFieldName（要挡住撞名与保留字）。
 *    两者混用的典型 bug：id_card 这类**系统字段**在
 *    RESERVED_PROFILE_COLS 里，若写入路径也用 checkFieldName，
 *    它会被自己的黑名单挡掉，表现为「保存成功但值没写进去」
 *    （2026-10-09 实际踩过，测试第 38 节抓出来的）。
 *
 * @param {string} raw
 * @returns {{ok:true, field:string} | {ok:false, reason:string}}
 */
export function isSafeFieldFormat(raw) {
  const field = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!field) return { ok: false, reason: '缺少字段名' };
  if (field.length > 31) return { ok: false, reason: '字段名最长 31 个字符' };
  if (!FIELD_NAME_RE.test(field)) return { ok: false, reason: '字段名格式非法' };
  if (SQL_KEYWORDS.has(field)) return { ok: false, reason: '字段名是数据库保留字' };
  return { ok: true, field };
}

/** 常见 SQL 保留字（做成字段名会跟拼接逻辑打架，一律挡掉） */
const SQL_KEYWORDS = new Set([
  'select', 'insert', 'update', 'delete', 'drop', 'table', 'where', 'from',
  'order', 'group', 'by', 'index', 'view', 'user', 'column', 'constraint',
  'primary', 'foreign', 'references', 'check', 'default', 'null', 'and', 'or',
  'not', 'join', 'left', 'right', 'inner', 'outer', 'union', 'values', 'set',
  'into', 'alter', 'add', 'create', 'grant', 'revoke', 'limit', 'offset',
  'distinct', 'having', 'case', 'when', 'then', 'else', 'end', 'as', 'on',
  'text', 'int', 'bigint', 'boolean', 'json', 'jsonb', 'timestamp', 'timestamptz',
]);

/**
 * 可见性三档的严格程度排序（数字越大越严）。
 * 用于「三方取严」：全班默认 ∩ 本人意愿 ∩ 单人例外。
 */
export const VIS_RANK = { public: 0, committee: 1, self: 2 };

/** 取两档中更严的一档；任一为 undefined 时返回另一方 */
export function stricterVis(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  const ra = VIS_RANK[a];
  const rb = VIS_RANK[b];
  if (ra == null) return b;
  if (rb == null) return a;
  return ra >= rb ? a : b;
}

/**
 * 要求持有某个头衔（班长 / 课代表 / 团支书…）。
 *
 * ⚠️ 安全边界：头衔一律以数据库 profiles.title 为准，**绝不接受前端传参**、
 * 也不从 token 里解。前端传什么都无关紧要，这里只认服务端读出来的值。
 *
 * 管理员与 AI 账号天然通过（管理员本来就该能改一切；AI 账号见 is_ai）。
 *
 * ⚠️ 现状（2026-10-08 核查）：本函数当前**没有任何调用方**——课代表改作业的
 *    授权是内联在 api/content.js 的 caSaveSubject 里的。保留它供后续复用，
 *    但**不要**以为改了这里就能改全站授权。
 *
 * @param {string} need 需要的头衔，如 '课代表'
 */
export async function requireTitle(req, res, need) {
  const u = await requireUser(req, res);
  if (!u) return null;
  if (u.role === 'admin' || u.isAI) return u;
  const list = splitTitles(u.title);
  if (!list.includes(String(need || '').trim())) {
    fail(res, 403, `需要「${need}」头衔才能操作`);
    return null;
  }
  return u;
}

/**
 * 要求 AI 账号（users.is_ai = true 且是管理员）。
 * 用于「AI 助手可编辑云端公告/作业」这类能力，也便于以后排查 AI 的动作。
 */
export async function requireAI(req, res) {
  const u = await requireUser(req, res);
  if (!u) return null;
  if (!u.isAI || u.role !== 'admin') {
    fail(res, 403, '需要 AI 助手账号才能操作');
    return null;
  }
  return u;
}

/**
 * 要求「管理员 或 AI 助手」。云端内容的写入走这个。
 * 单独抽出来是因为 content 接口既要给管理员用，也要给 AI 用。
 */
export async function requireAdminOrAI(req, res) {
  const u = await requireUser(req, res);
  if (!u) return null;
  if (u.role === 'admin' || u.isAI) return u;
  fail(res, 403, '需要管理员权限');
  return null;
}

/**
 * 要求「已完成首次改密」的用户。
 *
 * 首次登录被强制改密时，前端会弹一个不可关闭的弹窗；但光靠前端不够——
 * 有人可以拿 token 直接调接口绕过。所以后端这里再拦一道：
 * must_change_password = true 的用户，除 /auth?action=me|change-password|logout
 * 之外的接口一律 403 拒绝。
 *
 * @param {string} allowAction 当前 action 名，命中白名单则放行
 */
export async function requireUserReady(req, res, allowAction) {
  const ALLOW = ['me', 'change-password', 'logout'];
  const u = await requireUser(req, res);
  if (!u) return null;
  if (u.mustChangePassword && !ALLOW.includes(String(allowAction || '').toLowerCase())) {
    fail(res, 403, '首次登录请先修改初始密码', { mustChangePassword: true });
    return null;
  }
  return u;
}

/** 生成随机会话 token（32 字节十六进制） */
export function newToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 记录管理操作日志（审计用，失败不影响主流程） */
export async function audit(actorId, action, targetType, targetId, detail) {
  try {
    const sql = getSql();
    await sql`
      insert into audit_log (actor_id, action, target_type, target_id, detail)
      values (${actorId}, ${action}, ${targetType}, ${targetId || null}, ${detail || null})
    `;
  } catch {
    /* 审计失败不阻断业务 */
  }
}
