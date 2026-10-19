/* ============================================================
   /api/admin  —— 管理员后台接口
   ------------------------------------------------------------
   GET    /api/admin?action=users                     用户列表（含数据条数）
   GET    /api/admin?action=user&id=1                 单个用户详情 + 其云端数据
   GET    /api/admin?action=stats                     简单统计
   GET    /api/admin?action=online&days=30            在线时长（按人聚合；带 id 则查该人时段明细）
   GET    /api/admin?action=audit                     操作日志
   POST   /api/admin?action=reset-password            重置某用户密码
   POST   /api/admin?action=set-status                启用/禁用
   POST   /api/admin?action=set-role                  设为管理员/普通用户
   POST   /api/admin?action=set-data                  改某用户的某条数据
   POST   /api/admin?action=delete-data               删某用户的某条数据
   POST   /api/admin?action=delete-user               删号（连带其数据）
   POST   /api/admin?action=clear-sessions            强制某用户全部设备下线

   班级通讯录 / 个人资料（2026-10-05 新增）
   GET    /api/admin?action=profiles                  资料列表（可按状态/关键词筛）
   GET    /api/admin?action=profile&id=1              单条资料详情
   GET    /api/admin?action=profile-requests          待审核的联系方式列表
   GET    /api/admin?action=view-logs                 资料查看日志（谁看了谁）
   POST   /api/admin?action=review-contact            审核联系方式：通过 / 驳回
   POST   /api/admin?action=save-profile              新增或修改资料（姓名/学号/政治面貌）
   POST   /api/admin?action=delete-profile            删除一条资料
   POST   /api/admin?action=batch-profiles            批量导入资料
   GET    /api/admin?action=field-meta                字段元数据（可见性一览，2026-10-08）
   POST   /api/admin?action=set-visibility            改某字段的可见性上限（2026-10-08）
   POST   /api/admin?action=add-field                 新增自定义资料字段（2026-10-09 v2.4.0）
   POST   /api/admin?action=delete-field              删除自定义资料字段（2026-10-09 v2.4.0）
   POST   /api/admin?action=update-field              改字段的名称/排序/可见性（2026-10-09 v2.4.0）

   头衔任命 / AI 交接（2026-10-05 新增）
   GET    /api/admin?action=titles                    头衔列表（谁担任什么职务）
   GET    /api/admin?action=ai-account                当前 AI 助手账号是谁
   GET    /api/admin?action=games                     游戏数据：最高分 / 游玩时长 / 券获取时间
   POST   /api/admin?action=set-title                 任命/撤销头衔
   POST   /api/admin?action=handover-ai               把 AI 助手身份转交给另一个账号

   v2.10.0 注册审核 + 站点设置（2026-10-16 第六十轮）
   GET    /api/admin?action=settings                  读取站点设置（注册开关等）
   POST   /api/admin?action=set-settings              保存站点设置
   POST   /api/admin?action=user-review               注册审核：通过 / 驳回

   v2.10.0 用户操作日志（2026-10-16 第六十轮）
   GET    /api/admin?action=action-logs               操作明细（按用户/类型/日期筛）
   GET    /api/admin?action=action-stats              统计面板（今日/7日/热门页面）

   v2.10.0 成员与档案合并（2026-10-16 第六十轮）
   GET    /api/admin?action=members                   合并列表（账号+档案一行，带场景标记）
   POST   /api/admin?action=save-member               长表单合并保存（四场景编排）
   ============================================================ */

import { getSql, getSiteSetting, setSiteSetting, cfg } from './_lib/db.js';
import {
  cors, handlePreflight, ok, fail, body, requireAdmin, audit,
  checkFieldName, isSafeFieldFormat, RESERVED_PROFILE_COLS,
} from './_lib/http.js';
import { hashPassword } from './_lib/password.js';
import { listSecrets, saveSecret, deleteSecret } from './_lib/secrets-store.js';
/* v3.5.5：字段校验规则（站主：「所有字段支持管理员自定义配置校验规则」）。
   服务端是唯一裁判 —— 批量导入 / 直接调 API 都能绕过前端控件，
   写库前必须过 validateByRules；规则形状先过 normalizeRules 防脏数据。 */
import { normalizeRules, validateByRules, coerceValueByRules } from './_lib/field-rules.js';
/* v3.5.0：成员档案字段（姓名/学号/联系方式/自定义字段…）加密存储。
   与令牌库共用同一个 ADMIN_SECRETS_KEY；未配置时整体退化为明文，
   行为与改造前完全一致（见 profile-crypt.js 顶部说明）。 */
import { profileKey, encField, decField, blindIndex, isEnc, isUndecryptable } from './_lib/profile-crypt.js';
/* #178：用户详情的云端数据按分类翻中文。分类元数据的单一来源在
   data.js（个人端「我的云端数据」共用），这里直接 import 复用，
   避免两边各存一份翻译表后慢慢对不上。 */
import { classifyKey } from './data.js';

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  cors(req, res);

  const me = await requireAdmin(req, res);
  if (!me) return;

  const action = String(req.query.action || 'users').toLowerCase();

  try {
    /* 读操作 */
    if (req.method === 'GET') {
      if (action === 'users')      return await listUsers(req, res);
      if (action === 'user')       return await userDetail(req, res);
      if (action === 'members')    return await listMembers(req, res);
      if (action === 'stats')      return await stats(req, res);
      if (action === 'audit')      return await listAudit(req, res);
      if (action === 'login-logs') return await loginLogs(req, res);
      if (action === 'online')     return await onlineStats(req, res);
      if (action === 'export')     return await exportUsers(req, res);
      if (action === 'profiles')         return await listProfiles(req, res);
      if (action === 'profile')          return await profileDetail(req, res);
      if (action === 'profile-requests') return await profileRequests(req, res);
      if (action === 'view-logs')        return await viewLogs(req, res);
      if (action === 'field-meta')       return await fieldMeta(req, res);
      if (action === 'titles')           return await listTitles(req, res);
      if (action === 'ai-account')       return await aiAccount(req, res);
      if (action === 'games')            return await gameStats(req, res);
      if (action === 'secrets')          return await listAdminSecrets(req, res);
      if (action === 'settings')         return await getSettings(req, res);
      if (action === 'action-logs')      return await listActionLogs(req, res);
      if (action === 'action-stats')     return await actionStats(req, res);
      /* v3.6.1（站主 #4）：数据备份 / 回档 */
      if (action === 'backups')          return await listBackups(req, res);
      /* v3.7.0（站主 #1）：信息审核（修改申请） */
      if (action === 'change-requests')  return await listChangeRequests(req, res);
      if (action === 'backup')           return await getBackup(req, res);
      return fail(res, 404, '未知的 action：' + action);
    }

    /* 写操作 */
    if (req.method === 'POST') {
      const b = await body(req);
      switch (action) {
        case 'create-user':    return await createUser(req, res, me, b);
        case 'batch-create':   return await batchCreate(req, res, me, b);
        case 'reset-password': return await resetPassword(req, res, me, b);
        case 'set-status':     return await setStatus(req, res, me, b);
        case 'set-role':       return await setRole(req, res, me, b);
        case 'set-data':       return await setData(req, res, me, b);
        case 'delete-data':    return await deleteData(req, res, me, b);
        case 'delete-user':    return await deleteUser(req, res, me, b);
        case 'clear-sessions': return await clearSessions(req, res, me, b);
        case 'review-contact': return await reviewContact(req, res, me, b);
        case 'save-profile':   return await saveProfile(req, res, me, b);
        case 'save-member':    return await saveMember(req, res, me, b);
        case 'delete-profile': return await deleteProfile(req, res, me, b);
        case 'batch-profiles': return await batchProfiles(req, res, me, b);
        /* v3.5.18：导入时字段级冲突（库里值 ≠ 导入值）由站主逐条定夺后应用 */
        case 'resolve-field-conflicts': return await resolveFieldConflicts(req, res, me, b);
        case 'bind-profiles':  return await bindProfiles(req, res, me, b);
        case 'encrypt-profiles': return await encryptProfiles(req, res, me, b);
        case 'set-visibility': return await setVisibility(req, res, me, b);
        /* v3.5.40（站主 #1）：某个字段是否允许本人自己编辑 */
        case 'set-self-edit':  return await setSelfEdit(req, res, me, b);
        case 'add-field':      return await addField(req, res, me, b);
        case 'delete-field':   return await deleteField(req, res, me, b);
        /* v3.6.1：字段体检 / 一键恢复（墓碑误删、meta 被清空时用） */
        case 'repair-fields':  return await repairFields(req, res, me, b);
        /* v3.6.1（站主 #4）：备份 / 回档 */
        case 'backup':         return await createBackup(req, res, me, b);
        case 'delete-backup':  return await deleteBackup(req, res, me, b);
        case 'restore-backup': return await restoreBackup(req, res, me, b);
        /* v3.6.4（站主 #3）：30 分钟内撤回删除 */
        case 'undo-delete':    return await undoDelete(req, res, me, b);
        /* v3.7.0（站主 #1）：信息审核通过 / 驳回 / 7 天内撤销 */
        case 'approve-change': return await approveChange(req, res, me, b);
        case 'reject-change':  return await rejectChange(req, res, me, b);
        case 'revert-change':  return await revertChange(req, res, me, b);
        case 'update-field':   return await updateField(req, res, me, b);
        /* v3.5.14 #7：字段拖拽排序 —— 一次批量写，避免 N 次子请求 */
        case 'reorder-fields': return await reorderFields(req, res, me, b);
        case 'set-title':      return await setTitle(req, res, me, b);
        case 'handover-ai':    return await handoverAi(req, res, me, b);
        case 'save-secret':    return await saveAdminSecret(req, res, me, b);
        case 'delete-secret':  return await deleteAdminSecret(req, res, me, b);
        case 'user-review':    return await reviewUser(req, res, me, b);
        case 'set-settings':   return await saveSettings(req, res, me, b);
        default:               return fail(res, 404, '未知的 action：' + action);
      }
    }

    return fail(res, 405, '不支持的方法');
  } catch (e) {
    console.error('[admin]', action, e);
    /* ⚠️ 2026-10-07：把真实错误摘要带进响应，否则这类故障只能靠猜。
       只回错误消息本身（不含栈），并限制长度，避免泄露内部结构。
       排查「后台重置密码 500」时，正是靠它一眼看到真实原因。 */
    const hint = (e && e.message) ? String(e.message).slice(0, 300) : '未知错误';
    return fail(res, 500, '服务器内部错误：' + hint, { action });
  }
}

/* ---------------- 用户名 / 密码校验（与 auth.js 保持一致） ---------------- */
function normUsername(s) {
  return String(s || '').trim().toLowerCase();
}
function validUsername(u) {
  /* 与 auth.js 保持一致（2026-10-06 放宽到 2 位）；此副本曾漏改导致两字姓名导入被拒 */
  return /^[a-z0-9_\u4e00-\u9fa5]{2,20}$/.test(u);
}

/* ---------------- 读：用户列表 ---------------- */
async function listUsers(req, res) {
  const sql = getSql();
  const q = String(req.query.q || '').trim().toLowerCase();
  const limit = Math.min(Number(req.query.limit || 200), 500);
  const offset = Math.max(Number(req.query.offset || 0), 0);

  const rows = await sql`
    select u.id, u.username, u.display_name, u.role, u.status,
           u.created_at, u.last_login_at, u.last_seen_at,
           coalesce(u.must_change_password, false) as must_change_password,
           coalesce(d.n, 0)::int as data_count,
           coalesce(sess.sess_n, 0)::int as online_sessions,
           sess.max_seen as online_last_seen
      from users u
      left join (
        select user_id, count(*)::int as n from user_data group by user_id
      ) d on d.user_id = u.id
      left join (
        select user_id,
               count(*) filter (
                 where expires_at > now()
                   and last_seen_at > now() - interval '90 seconds'
               )::int as sess_n,
               max(last_seen_at) as max_seen
          from sessions
         group by user_id
      ) sess on sess.user_id = u.id
     where (${q} = '' or lower(u.username) like '%' || ${q} || '%'
                         or lower(coalesce(u.display_name,'')) like '%' || ${q} || '%')
     order by u.id
     limit ${limit} offset ${offset}
  `;
  const total = (await sql`select count(*)::int as n from users`)[0].n;

  return ok(res, {
    total,
    users: rows.map((r) => ({
      id: Number(r.id),
      username: r.username,
      displayName: r.display_name,
      role: r.role,
      status: r.status,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
      lastSeenAt: r.last_seen_at || null,
      /* v2.5.0 真·在线：按会话心跳判定（90 秒窗口），不是「登录过就一直在线」 */
      online: Number(r.online_sessions) > 0,
      onlineSessions: Number(r.online_sessions) || 0,
      /* 该用户所有会话里最近一次心跳时刻（用于显示「最后活跃」） */
      sessionLastSeen: r.online_last_seen || null,
      mustChangePassword: !!r.must_change_password,
      dataCount: r.data_count,
    })),
  });
}

/* ---------------- 读：单个用户 + 其数据 ---------------- */
async function userDetail(req, res) {
  const id = Number(req.query.id);
  if (!id) return fail(res, 400, '缺少 id 参数');
  const sql = getSql();

  const rows = await sql`
    select id, username, display_name, role, status, created_at, last_login_at, last_seen_at
      from users where id = ${id}
  `;
  if (!rows.length) return fail(res, 404, '用户不存在');
  const u = rows[0];

  const data = await sql`
    select data_key, data_value, updated_at
      from user_data where user_id = ${id} order by data_key
  `;
  const sessions = await sql`
    select token, created_at, expires_at from sessions
     where user_id = ${id} and expires_at > now() order by created_at desc
  `;

  return ok(res, {
    user: {
      id: Number(u.id),
      username: u.username,
      displayName: u.display_name,
      role: u.role,
      status: u.status,
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at,
      lastSeenAt: u.last_seen_at || null,
    },
    /* #178：每条云端数据带上中文分类（cat/catLabel/label），
       后台详情表格直接展示，不用前端再翻一遍。 */
    data: data.map((d) => {
      const c = classifyKey(d.data_key);
      return {
        key: d.data_key,
        cat: c.cat,
        catLabel: c.label,
        label: c.name,
        value: d.data_value,
        updatedAt: d.updated_at,
      };
    }),
    /* token 只显示前 8 位，避免完整凭据出现在前端 */
    sessions: sessions.map((s) => ({
      tokenPrefix: String(s.token).slice(0, 8) + '…',
      createdAt: s.created_at,
      expiresAt: s.expires_at,
    })),
  });
}

/* ---------------- 读：统计 ---------------- */
async function stats(req, res) {
  const sql = getSql();
  const [u] = await sql`
    select count(*)::int as total,
           count(*) filter (where status = 'banned')::int as banned,
           count(*) filter (where role = 'admin')::int as admins,
           count(*) filter (where coalesce(must_change_password,false))::int as pending_pwd,
           /* 活跃口径改按「最后上线」算：登录一次 token 能用很多天，
              只看 last_login_at 会把天天在线的同学算成不活跃（2026-10-07） */
           count(*) filter (where coalesce(last_seen_at, last_login_at) > now() - interval '7 days')::int as active7,
           count(*) filter (where coalesce(last_seen_at, last_login_at) >= date_trunc('day', now()))::int as today_active
      from users
  `;
  const [d] = await sql`select count(*)::int as rows, coalesce(sum(pg_column_size(data_value)),0)::bigint as bytes from user_data`;
  const [s] = await sql`select count(*)::int as n from sessions where expires_at > now()`;
  /* v2.5.0「真·在线」：90 秒内有心跳的**会话**数（不是 token 未过期数）。
     以前 activeSessions 是「所有未过期会话」，登录一次就挂在那儿好几天，
     所以数字永远虚高。现在按心跳实测口径统计。 */
  let onlineSessions = 0;
  let onlineUsers = 0;
  try {
    const [os] = await sql`
      select count(*)::int as sess,
             count(distinct user_id)::int as usr
        from sessions
       where expires_at > now()
         and last_seen_at > now() - interval '90 seconds'
    `;
    onlineSessions = os.sess;
    onlineUsers = os.usr;
  } catch (e) {
    /* sessions.last_seen_at 还没建出来时（老库首次部署）降级为 0，
       不能让整个概览页报错。下次请求 ensureSchema 建好列后即恢复。 */
    console.warn('[admin] sessions.last_seen_at 不可用：', e.message);
  }
  /* 哪些键用得最多（了解同学最在意什么功能） */
  const topKeys = await sql`
    select data_key, count(*)::int as n from user_data
     group by data_key order by n desc limit 10
  `;

  /* 登录相关统计 + 最近登录记录。login_log 表不存在时静默降级为 0/空数组，
     避免老库没执行建表脚本时整个概览页报错。 */
  let loginTotal = 0;
  let loginToday = 0;
  let recentLogins = [];
  try {
    const [lt] = await sql`select count(*)::int as n from login_log`;
    loginTotal = lt.n;
    const [ld] = await sql`
      select count(*)::int as n from login_log where created_at >= date_trunc('day', now())
    `;
    loginToday = ld.n;
    const rl = await sql`
      select l.user_id, l.ip, l.created_at, u.username
        from login_log l
        left join users u on u.id = l.user_id
       order by l.created_at desc
       limit 15
    `;
    recentLogins = rl.map((r) => ({
      userId: Number(r.user_id),
      username: r.username,
      ip: r.ip,
      createdAt: r.created_at,
    }));
  } catch (e) {
    console.warn('[admin] login_log 不可用（可能未执行建表脚本）：', e.message);
  }

  /* 通讯录统计：资料总数、待审核数、已认领数、近 7 天查看量。
     与上面同理，表不存在时静默降级，不影响概览页其他部分。 */
  let profileStats = { total: 0, pending: 0, approved: 0, claimed: 0, views7: 0, viewsTotal: 0 };
  try {
    const [p] = await sql`
      select count(*)::int as total,
             count(*) filter (where contact_status = 'pending')::int  as pending,
             count(*) filter (where contact_status = 'approved')::int as approved,
             count(*) filter (where user_id is not null)::int         as claimed
        from profiles
    `;
    profileStats = { ...profileStats, ...p };
    const [v1] = await sql`select count(*)::int as n from profile_view_log`;
    const [v2] = await sql`
      select count(*)::int as n from profile_view_log
       where created_at > now() - interval '7 days'
    `;
    profileStats.viewsTotal = v1.n;
    profileStats.views7 = v2.n;
  } catch (e) {
    console.warn('[admin] profiles / profile_view_log 不可用：', e.message);
  }

  return ok(res, {
    users: u,
    data: { rows: d.rows, bytes: Number(d.bytes) },
    activeSessions: s.n,
    /* 真实在线：90 秒内有心跳的会话数 / 人数 */
    onlineSessions,
    onlineUsers,
    topKeys: topKeys.map((k) => ({ key: k.data_key, count: k.n })),
    login: { total: loginTotal, today: loginToday, recent: recentLogins },
    profiles: profileStats,
  });
}

/* ---------------- 读：操作日志 ---------------- */
async function listAudit(req, res) {
  const sql = getSql();
  const limit = Math.min(Number(req.query.limit || 100), 300);
  const rows = await sql`
    select a.id, a.action, a.target_type, a.target_id, a.detail, a.created_at,
           u.username as actor
      from audit_log a
      left join users u on u.id = a.actor_id
     order by a.created_at desc
     limit ${limit}
  `;
  return ok(res, { logs: rows });
}

/* ============================================================
   ⚠️ 已移除：临时诊断端点 pwd-audit（2026-10-15 第五十六轮）。

   它当时要回答的三个问题都已收官，结论固化在 password.js 顶部注释里：
     ① 格式分布：线上 63 个账号 = pbkdf2 63 / bcrypt 0 / pbkdf2c 0；
        迭代直方图 {10000: 2, 50000: 61}；
     ② bcrypt 探针：线上 0 个账号，无需实测；
     ③ CPU 预算：burn=60 连跑 60 次 PBKDF2(10000) 稳定 200，
        证伪了「免费 Worker 装不下派生」的误判 —— 真凶是
        ensureSchema 漏建 failed_count/locked_until 列（http.js 已修）。

   根治方案（v2.9.9）：PBKDF2 搬到浏览器（见 index.html / admin.html
   的 clsDerive/clsNewHash/clsLogin/clsChangePwd），服务端零派生。
   ============================================================ */

/* ---------------- 写：重置密码 ---------------- */
async function resetPassword(req, res, me, b) {
  const id = Number(b.id);
  const newPwd = String(b.newPassword || '');
  if (!id) return fail(res, 400, '缺少 id');
  if (newPwd.length < 6 || newPwd.length > 64) return fail(res, 400, '新密码需 6–64 位');

  const sql = getSql();
  const hash = await hashPassword(newPwd);
  /* 先写一定存在的列（password_hash）并确认真有这个用户。
     ⚠️ 2026-10-07：原来这条 UPDATE 一并写 must_change_password / failed_count /
        locked_until，线上库若没跑过 schema.sql 后两列不存在 → 整条 500，
        表现就是「后台重置密码点了没用、只提示服务器错误」。
        现在先做核心更新（保证能命中用户、给出正确的 404），
        再把「可能缺失的列」放到受保护的第二次更新里。 */
  const rows = await sql`
    update users set password_hash = ${hash} where id = ${id}
    returning username
  `;
  if (!rows.length) return fail(res, 404, '用户不存在');

  /* 管理员重置的密码等同「新的初始密码」→ 把强制改密标记置回 true，
     要求对方下次登录时再自行设置。否则管理员会一直知道对方密码。
     failed_count / locked_until 顺手清零，让被锁的账号也能立刻用新密码登录。
     这一步单独 try：列若还没补上也不该让整次重置失败。 */
  try {
    await sql`
      update users
         set must_change_password = true,
             failed_count = 0,
             locked_until = null
       where id = ${id}
    `;
  } catch (e) {
    console.warn('[admin] 重置密码后设置强制改密标记失败（不影响重置本身）：', e.message);
  }

  /* 重置密码后踢掉该用户所有登录 */
  await sql`delete from sessions where user_id = ${id}`;
  await audit(me.id, 'user.reset_password', 'user', String(id), rows[0].username);

  return ok(res, {
    message: '已重置 ' + rows[0].username + ' 的密码，该用户需用新密码登录并自行修改',
  });
}

/* ---------------- 写：启用/禁用 ---------------- */
async function setStatus(req, res, me, b) {
  const id = Number(b.id);
  const status = String(b.status || '');
  if (!id) return fail(res, 400, '缺少 id');
  if (!['active', 'banned'].includes(status)) return fail(res, 400, 'status 只能是 active 或 banned');
  if (id === me.id) return fail(res, 400, '不能禁用自己的账号');

  const sql = getSql();
  const rows = await sql`
    update users set status = ${status} where id = ${id}
    returning username
  `;
  if (!rows.length) return fail(res, 404, '用户不存在');

  if (status === 'banned') await sql`delete from sessions where user_id = ${id}`;
  await audit(me.id, 'user.set_status', 'user', String(id), status);

  return ok(res, { message: (status === 'banned' ? '已禁用 ' : '已启用 ') + rows[0].username });
}

/* ---------------- v2.10.0：注册审核（通过 / 驳回） ----------------
   与 set-status 分工：set-status 管 active/banned 双向，
   本动作专管「待审核 → 通过 / 驳回」，语义更清晰、审计也好读。
   通过 = status 改 active（账号立即可登录）；
   驳回 = status 改 banned 并踢掉全部会话（防审核前混进去的残留会话）。 */
async function reviewUser(req, res, me, b) {
  const id = Number(b.id);
  const decision = String(b.decision || '');
  if (!id) return fail(res, 400, '缺少 id');
  if (!['approve', 'reject'].includes(decision)) {
    return fail(res, 400, 'decision 只能是 approve 或 reject');
  }
  if (id === me.id) return fail(res, 400, '不能审核自己的账号');

  const sql = getSql();
  const rows = await sql`
    update users set status = ${decision === 'approve' ? 'active' : 'banned'}
     where id = ${id} and status = 'pending'
    returning username
  `;
  if (!rows.length) return fail(res, 404, '该用户不存在或不是待审核状态');

  if (decision === 'reject') await sql`delete from sessions where user_id = ${id}`;
  await audit(me.id, 'user.review', 'user', String(id), decision);

  return ok(res, {
    message: decision === 'approve'
      ? ('已通过 ' + rows[0].username + ' 的注册，对方现在可以登录了')
      : ('已驳回 ' + rows[0].username + ' 的注册'),
  });
}

/* ---------------- v2.10.0：站点设置（后台可改的站点级开关） ----------------
   目前两个键：
     register_open   注册总开关（关掉后注册入口隐藏、接口 403）
     register_review 注册是否需管理员审核
   白名单收口：不在表里的键一律忽略，防止脏数据把设置表当垃圾桶。 */
const SETTING_KEYS = ['register_open', 'register_review'];
async function getSettings(req, res) {
  const sql = getSql();
  const out = {};
  for (const k of SETTING_KEYS) {
    const v = await getSiteSetting(sql, k, null);
    out[k] = v;
  }
  /* 一并给出「环境变量默认值」，后台展示「未设置时的兜底」有据可查 */
  return ok(res, { settings: out, envDefault: { register_open: !!cfg().allowRegister } });
}

async function saveSettings(req, res, me, b) {
  const sql = getSql();
  const done = [];
  for (const k of SETTING_KEYS) {
    if (!(k in b)) continue;
    const v = b[k];
    if (typeof v !== 'boolean') return fail(res, 400, k + ' 必须是布尔值');
    await setSiteSetting(sql, k, v);
    done.push(k);
  }
  if (!done.length) return fail(res, 400, '没有要保存的设置');
  await audit(me.id, 'site.save_settings', 'site', 'settings', JSON.stringify(b));
  return ok(res, { message: '已保存', saved: done });
}

/* ---------------- 写：设为管理员/普通用户 ---------------- */
async function setRole(req, res, me, b) {
  const id = Number(b.id);
  const role = String(b.role || '');
  if (!id) return fail(res, 400, '缺少 id');
  if (!['user', 'admin'].includes(role)) return fail(res, 400, 'role 只能是 user 或 admin');
  if (id === me.id && role !== 'admin') return fail(res, 400, '不能取消自己的管理员身份');

  const sql = getSql();
  const rows = await sql`
    update users set role = ${role} where id = ${id}
    returning username
  `;
  if (!rows.length) return fail(res, 404, '用户不存在');

  await audit(me.id, 'user.set_role', 'user', String(id), role);
  return ok(res, { message: '已把 ' + rows[0].username + ' 设为' + (role === 'admin' ? '管理员' : '普通用户') });
}

/* ============================================================================
 * 头衔系统（2026-10-05 新增）
 * ----------------------------------------------------------------------------
 * 班级职务，由管理员任命。头衔存在 profiles.title 里，英文逗号分隔，
 * 一个人可以兼多个职务（如「团支书,课代表」）。
 *
 * 授权方面：目前只有「课代表」参与实际授权——可以编辑云端作业
 * （见 api/content.js 里的 requireTitle 判定）。其余头衔先只做展示，
 * 以后要扩权就在对应接口换上 requireTitle('xxx') 即可。
 *
 * ⚠️ 安全边界：头衔只写进 profiles.title，接口授权时只读这个字段。
 *    前端传什么头衔都不作数，否则谁都能自称课代表去改作业。
 * ========================================================================= */

/* 允许的头衔白名单。不在这个表里的值一律拒绝，避免脏数据。 */
const ALLOWED_TITLES = [
  '班长', '副班长', '团支书', '学习委员', '纪律委员',
  '生活委员', '体育委员', '文艺委员', '电教委',
  '语文课代表', '数学课代表', '英语课代表', '物理课代表',
  '化学课代表', '生物课代表', '政治课代表', '历史课代表',
  '地理课代表', '课代表',
];

/** 规范化头衔字符串：拆开、去空、去重、校验白名单 */
function normTitles(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[,，、\s]+/);
  const out = [];
  const bad = [];
  raw.forEach((x) => {
    const v = String(x || '').trim();
    if (!v) return;
    if (!ALLOWED_TITLES.includes(v)) { bad.push(v); return; }
    if (!out.includes(v)) out.push(v);
  });
  return { list: out, bad };
}

/* ---------------- 读：头衔一览 ---------------- */
async function listTitles(req, res) {
  const sql = getSql();
  /* 🔴 v3.5.14：线上「头衔任命」报 column p.title / p.role does not exist。
     老库的 profiles 是很早建的，缺这两列；而 ensureSchema 的升级路径要么漏了，
     要么被「先盖章再补列」的顺序坑过（补列失败被 try 吞掉，版本章却已经写上，
     下次直接跳过）。这里改成**每次进接口先幂等补列**，不依赖版本章。 */
  try { await sql`alter table profiles add column if not exists role text not null default '学生'`; } catch (e) {}
  try { await sql`alter table profiles add column if not exists title text`; } catch (e) {}
  /* ⚠️ 2026-10-07 修复「鸡生蛋」：这里原本有一句
        where coalesce(p.title, '') <> ''
     意思是「只列出已经任命过头衔的人」。后果是全班刚导入、人人头衔为空时
     列表 0 条，站主在「头衔任命」面板看到「还没有资料，请先导入名单」，
     根本没法任命——而任命不了就永远进不了这个列表。
     现在改为返回全部资料，由前端按 onlySet 过滤（默认只看未任命/全部可切）。 */
  let rawRows;
  try{
    rawRows = await sql`
      select p.id, p.name, p.student_id, p.title, p.role, p.user_id,
             u.username, u.display_name
        from profiles p
        left join users u on u.id = p.user_id
       order by (coalesce(p.title, '') <> '') desc, p.id
    `;
  }catch(e){
    /* 极端兜底：万一 ALTER 被数据库权限挡住，也不能让整个面板 500 */
    console.error('[admin] titles 查询缺列，走兜底：', e.message);
    rawRows = await sql`
      select p.id, p.name, p.student_id, '' as title, '学生' as role, p.user_id,
             u.username, u.display_name
        from profiles p
        left join users u on u.id = p.user_id
       order by p.id
    `;
  }
  /* v3.5.0：姓名/学号是密文，头衔任命面板要显示明文姓名 */
  const tkey = await profileKey(req);
  const rows = await Promise.all(rawRows.map((r) => decProfileRow(tkey, r)));
  const ai = await sql`
    select id, username, display_name from users
     where is_ai = true order by id limit 1
  `;
  return ok(res, {
    profiles: rows.map((r) => ({
      id: Number(r.id),
      name: r.name || '',
      studentId: r.student_id || '',
      title: r.title || '',
      titles: normTitles(r.title).list,
      role: r.role || '学生',
      userId: r.user_id ? Number(r.user_id) : null,
      username: r.username || null,
      displayName: r.display_name || null,
    })),
    allowed: ALLOWED_TITLES,
    aiAccount: ai.length
      ? { id: Number(ai[0].id), username: ai[0].username, displayName: ai[0].display_name || 'ai助手' }
      : null,
  });
}

/* ---------------- 读：游戏数据（2026-10-07 新增）----------------
   站主要求：后台能看到每个同学的
     ① 各游戏最高分      cls_game_<本地键>    如 cls_game_snake_hi
     ② 每个游戏的游玩时长 cls_game_play_<游戏> {count,totalMs,lastMs,lastAt,bestScore}
     ③ 点歌券获取时间     cls_game_coupon_ledger {周: {游戏: {姓名: '券码 · 时间 · 来源'}}}
   数据都躺在 user_data 里（/api/data 的个人同步表），这里按人聚合后返回。 */
const GAME_META = [
  { id: 'snake',  hiKey: 'snake_hi',  label: '贪吃蛇',   icon: '🐍' },
  { id: 'tetris', hiKey: 'tetris_hi', label: '俄罗斯方块', icon: '🧱' },
  { id: 'bird',   hiKey: 'bird_hi',   label: '像素飞鸟',   icon: '🐦' },
  { id: 'doodle', hiKey: 'doodle_hi', label: '涂鸦跳跃',   icon: '🦘' },
  /* v3.5.35：其余 9 款全部接入云同步，这里补齐元数据 */
  { id: 'breakout',   hiKey: 'breakout_hi', label: '打砖块',   icon: '🧱' },
  { id: 'whack',      hiKey: 'whack_hi',    label: '打地鼠',   icon: '🔨' },
  { id: 'match3',     hiKey: 'match3_hi',   label: '消消乐',   icon: '🍬' },
  { id: 'plane',      hiKey: 'plane_hi',    label: '飞机大战', icon: '✈️' },
  { id: 'minesweeper',hiKey: 'mine_best',   label: '扫雷（最快用时）', icon: '💣' },
  { id: 'memory',     hiKey: 'memory_moves',label: '记忆翻牌（最少步数）', icon: '🃏' },
  { id: 'gomoku',     hiKey: '',            label: '五子棋',   icon: '⚫' },
  { id: 'tictactoe',  hiKey: '',            label: '井字棋',   icon: '❌' },
  { id: 'chess',      hiKey: '',            label: '中国象棋', icon: '♟️' },
];

async function gameStats(req, res) {
  const sql = getSql();
  const rows = await sql`
    select d.user_id, d.data_key, d.data_value, d.updated_at,
           u.username,
           coalesce(p.name, u.display_name, u.username) as who
      from user_data d
      join users u on u.id = d.user_id
      left join profiles p on p.user_id = u.id
     where d.data_key like 'cls_game_%'
     order by u.id, d.data_key
  `;

  const byUser = new Map();
  for (const r of rows) {
    const uid = Number(r.user_id);
    if (!byUser.has(uid)) {
      byUser.set(uid, {
        userId: uid,
        username: r.username,
        name: r.who,
        hi: {}, play: {}, coupons: [], updatedAt: null,
      });
    }
    const u = byUser.get(uid);
    const k = String(r.data_key);
    const v = r.data_value;
    const at = r.updated_at ? new Date(r.updated_at).toISOString() : null;
    if (at && (!u.updatedAt || at > u.updatedAt)) u.updatedAt = at;

    if (k === 'cls_game_coupon_ledger') {
      /* { 周: { 游戏: { 姓名: '券码 · 时间 · 来源' } } } */
      const L = (v && typeof v === 'object') ? v : {};
      for (const week of Object.keys(L)) {
        const byGame = L[week] || {};
        for (const game of Object.keys(byGame)) {
          const byName = byGame[game] || {};
          for (const nm of Object.keys(byName)) {
            const raw = String(byName[nm] || '');
            const parts = raw.split(' · ');
            /* 新格式：券码 · 时间 · 来源；旧格式：时间 · 来源 */
            const hasCode = /^SONG/i.test(parts[0] || '');
            u.coupons.push({
              week,
              game,
              gameLabel: (GAME_META.find((g) => g.id === game) || {}).label || game,
              name: nm,
              code: hasCode ? parts[0] : '',
              time: hasCode ? (parts[1] || '') : (parts[0] || ''),
              source: hasCode ? (parts.slice(2).join(' · ')) : (parts.slice(1).join(' · ')),
              raw,
            });
          }
        }
      }
      continue;
    }

    if (k.startsWith('cls_game_play_')) {
      const g = k.slice('cls_game_play_'.length);
      if (v && typeof v === 'object') {
        u.play[g] = {
          count: Number(v.count) || 0,
          totalMs: Number(v.totalMs) || 0,
          lastMs: Number(v.lastMs) || 0,
          lastAt: v.lastAt || null,
          bestScore: (v.bestScore == null ? null : Number(v.bestScore)),
          /* v3.5.35：低分更好型成绩（扫雷最快用时 / 翻牌最少步数） */
          bestLow: (v.bestLow == null ? null : Number(v.bestLow)),
        };
      }
      continue;
    }

    /* v3.5.35：胜负平台账（五子棋 / 井字棋等棋类），cls_game_rec_<game> = {w,l,d} */
    if (k.startsWith('cls_game_rec_')) {
      const g = k.slice('cls_game_rec_'.length);
      if (v && typeof v === 'object') {
        u.rec = u.rec || {};
        u.rec[g] = {
          w: Number(v.w) || 0,
          l: Number(v.l) || 0,
          d: Number(v.d) || 0,
        };
      }
      continue;
    }

    if (k.startsWith('cls_game_')) {
      const localKey = k.slice('cls_game_'.length);
      /* cls_game_week_<game> 是「本周榜」用的周计数，不是最高分记录；
         它和 cls_game_<game>_hi 长的很像，早期版本会被错当成 hi 收进来，
         导致 u.hi 里混进 week_snake 之类的垃圾键。这里直接跳过。 */
      if (localKey.startsWith('week_') || localKey.startsWith('rec_')) continue;
      const num = Number(v);
      if (Number.isFinite(num)) u.hi[localKey] = num;
      else u.hi[localKey] = v;
    }
  }

  const users = Array.from(byUser.values());
  users.forEach((u) => {
    /* 不再跨游戏把时长加成一个大数（上午玩贪吃蛇、下午玩飞鸟，是两码事，
       合成一个「总时长」没有意义）。各游戏的数据在 u.play[game] 里各归各的。 */
    u.lastPlayAt = lastPlayAt(u);
    u.coupons.sort((a, b) => String(b.time).localeCompare(String(a.time)));
  });
  /* 排序口径也改成「最近玩过谁」，而不是谁的时间加起来最长。 */
  users.sort((a, b) => {
    if (a.lastPlayAt === b.lastPlayAt) return 0;
    if (!a.lastPlayAt) return 1;
    if (!b.lastPlayAt) return -1;
    return a.lastPlayAt < b.lastPlayAt ? 1 : -1;
  });

  const summary = {
    players: users.length,
    coupons: users.reduce((s, u) => s + u.coupons.length, 0),
    /* 「累计游玩」= 各游戏局数之和，单位统一（局），不再是混着小时/分钟的时长。 */
    totalPlays: users.reduce(
      (s, u) => s + Object.values(u.play).reduce((n, p) => n + (p.count || 0), 0),
      0,
    ),
  };

  return ok(res, { games: GAME_META, users, summary });
}

/* 取某人在所有游戏里最晚一次游玩时间（ISO 串），没有记录返回 null。 */
function lastPlayAt(u) {
  let best = null;
  for (const p of Object.values(u.play || {})) {
    const at = p && p.lastAt ? String(p.lastAt) : '';
    if (at && (!best || at > best)) best = at;
  }
  return best;
}

/* ---------------- 写：任命 / 撤销头衔 ---------------- */
async function setTitle(req, res, me, b) {
  const id = Number(b.id);
  if (!id) return fail(res, 400, '缺少资料 id');

  const { list, bad } = normTitles(b.titles !== undefined ? b.titles : b.title);
  if (bad.length) {
    return fail(res, 400, '不认识的头衔：' + bad.join('、') + '。可选：' + ALLOWED_TITLES.join('、'));
  }

  const sql = getSql();
  /* 空字符串而不是 null：前端判断更省事，也不会把「已清空」和「从没设过」混起来 */
  const val = list.join(',');
  const rows = await sql`
    update profiles set title = ${val}, updated_at = now()
     where id = ${id}
    returning name
  `;
  if (!rows.length) return fail(res, 404, '资料不存在');

  await audit(me.id, 'profile.set_title', 'profile', String(id),
    (rows[0].name || '') + ' → ' + (val || '（已清空）'));
  return ok(res, {
    message: list.length
      ? '已把 ' + (rows[0].name || '该同学') + ' 任命为：' + list.join('、')
      : '已清空 ' + (rows[0].name || '该同学') + ' 的头衔',
    titles: list,
  });
}

/* ============================================================================
 * AI 助手账号与交接（2026-10-05 新增）
 * ----------------------------------------------------------------------------
 * AI 助手是一个真实的管理员账号（users.role='admin' 且 is_ai=true），
 * 它能通过 /api/content 编辑云端公告与作业。
 *
 * 交接设计（为什么需要）：
 *   现在用的 AI 助手将来可能换人/换模型，如果账号写死在代码里，
 *   每次交接都要改代码重新部署。所以把「谁是 AI」做成数据库的一个标记位
 *   （users.is_ai），换的时候调一次 handover-ai 就行，代码一行不动。
 *
 *   交接后：旧账号降回普通用户并取消 is_ai；新账号提为管理员并打上 is_ai。
 *   会话 token 不迁移——新 AI 用新密码重新登录，避免旧 token 继续有效。
 * ========================================================================= */

/* ---------------- 读：当前 AI 账号是谁 ---------------- */
async function aiAccount(req, res) {
  const sql = getSql();
  const rows = await sql`
    select id, username, display_name, status, created_at, last_login_at
      from users where is_ai = true order by id limit 1
  `;
  return ok(res, {
    account: rows.length ? {
      id: Number(rows[0].id),
      username: rows[0].username,
      displayName: rows[0].display_name || 'ai助手',
      status: rows[0].status,
      lastLoginAt: rows[0].last_login_at || null,
    } : null,
  });
}

/* ---------------- 写：把 AI 身份转交给另一个账号 ---------------- */
async function handoverAi(req, res, me, b) {
  const username = normUsername(b.username);
  if (!username) return fail(res, 400, '请填写要接管的账号名');
  if (!validUsername(username)) return fail(res, 400, '账号名格式不对');

  const sql = getSql();

  /* 找目标账号 */
  const target = await sql`
    select id, username, role from users where lower(username) = ${username} limit 1
  `;
  if (!target.length) {
    return fail(res, 404, '找不到账号「' + username + '」。请先让新账号自行注册，再来这里交接。');
  }
  const newId = Number(target[0].id);

  /* 看当前是谁 */
  const cur = await sql`select id, username from users where is_ai = true order by id limit 1`;
  if (cur.length && Number(cur[0].id) === newId) {
    return fail(res, 400, '「' + username + '」已经是 AI 助手账号了');
  }

  /* 旧账号：取消标记并降回普通用户（不删号，他的其它数据都还在） */
  if (cur.length) {
    await sql`
      update users set is_ai = false, role = 'user' where id = ${Number(cur[0].id)}
    `;
  }

  /* 新账号：提为管理员并打标记 */
  await sql`
    update users set is_ai = true, role = 'admin' where id = ${newId}
  `;

  await audit(me.id, 'ai.handover', 'user', String(newId),
    'AI 助手：' + (cur.length ? cur[0].username : '(无)') + ' → ' + username);

  return ok(res, {
    message: '已把 AI 助手身份交给「' + username + '」。'
      + (cur.length ? '旧账号 ' + cur[0].username + ' 已降回普通用户，' : '')
      + '请用新账号重新登录。',
    previous: cur.length ? cur[0].username : null,
    current: username,
  });
}


/* ---------------- 写：修改某用户的某条数据 ---------------- */
async function setData(req, res, me, b) {
  const userId = Number(b.userId);
  const key = String(b.key || '');
  if (!userId) return fail(res, 400, '缺少 userId');
  if (!key) return fail(res, 400, '缺少 key');

  /* 值与 data.js 保持一致：JSON 序列化后不超过 200KB */
  const serialized = JSON.stringify(b.value === undefined ? null : b.value);
  if (serialized.length > 200 * 1024) return fail(res, 400, '内容过大，超过 200KB');

  const sql = getSql();
  await sql`
    insert into user_data (user_id, data_key, data_value, updated_at)
    values (${userId}, ${key}, ${serialized}::jsonb, now())
    on conflict (user_id, data_key)
    do update set data_value = excluded.data_value, updated_at = now()
  `;
  await audit(me.id, 'data.update', 'data', userId + '/' + key, null);
  return ok(res, { message: '已保存', key });
}

/* ---------------- 写：删除某用户的云端数据 ----------------
   两种用法（v2.10.1 需求⑬）：
     · 传 key    = 选择性删除，只删这一条
     · 传 all=1  = 批量删除，清空该用户全部云端数据
   两条路都写审计，且都要求管理员（requireAdmin 在入口处已过）。 */
async function deleteData(req, res, me, b) {
  const userId = Number(b.userId);
  const key = String(b.key || '');
  const all = !!b.all;
  if (!userId || (!all && !key)) return fail(res, 400, '缺少 userId 或 key');

  const sql = getSql();
  if (all) {
    const rows = await sql`
      delete from user_data where user_id = ${userId} returning data_key
    `;
    await audit(me.id, 'data.delete_all', 'data', String(userId), `清空 ${rows.length} 条`);
    return ok(res, { message: '已清空该用户的全部云端数据', deleted: rows.length });
  }

  await sql`delete from user_data where user_id = ${userId} and data_key = ${key}`;
  await audit(me.id, 'data.delete', 'data', userId + '/' + key, null);
  return ok(res, { message: '已删除', key });
}

/* ---------------- 写：删号 ----------------
   v2.10.0（#172）：alsoProfile = true 时连带删除其班级档案。
   默认不删——档案是通讯录，账号没了人可能还在班里。
   ⚠️ 必须先删档案再删号：users 删掉后外键 on delete set null 会把
      profiles.user_id 清空，事后再按 user_id 就再也找不到那些档案了。 */
async function deleteUser(req, res, me, b) {
  const id = Number(b.id);
  if (!id) return fail(res, 400, '缺少 id');
  if (id === me.id) return fail(res, 400, '不能删除自己的账号');

  const sql = getSql();
  const alsoProfile = !!b.alsoProfile;
  if (alsoProfile) {
    await sql`delete from profiles where user_id = ${id}`;
  } else {
    /* 显式摘绑：不依赖外键 on delete set null（测试桩/兼容层不模拟外键行为，
       否则删号后档案仍指向已删用户，合并列表里会整行消失而不是「未认领」）。 */
    await sql`update profiles set user_id = null, updated_at = now() where user_id = ${id}`;
  }
  const rows = await sql`delete from users where id = ${id} returning username`;
  if (!rows.length) return fail(res, 404, '用户不存在');

  /* user_data / sessions 由外键 on delete cascade 自动清理 */
  await audit(me.id, 'user.delete', 'user', String(id),
    rows[0].username + (alsoProfile ? '（含班级档案）' : ''));
  return ok(res, {
    message: '已删除账号 ' + rows[0].username
      + (alsoProfile ? '（其班级档案一并清除）' : '（其云端数据一并清除）'),
  });
}

/* ---------------- 写：强制下线 ---------------- */
async function clearSessions(req, res, me, b) {
  const id = Number(b.id);
  if (!id) return fail(res, 400, '缺少 id');
  const sql = getSql();
  await sql`delete from sessions where user_id = ${id}`;
  await audit(me.id, 'user.clear_sessions', 'user', String(id), null);
  return ok(res, { message: '已让该用户在所有设备退出登录' });
}

/* ============================================================
 * 以下为 2026-10-05 新增：后台专用开号 / 批量导入 / 登录记录 / 导出
 * ------------------------------------------------------------
 * 设计要点：
 *   ① 关闭自助注册后，账号一律由管理员在后台创建
 *   ② 新建的账号 must_change_password = true —— 同学首次登录必须改密
 *   ③ 管理员始终看不到明文密码（库里只有 PBKDF2 哈希），只能重置
 * ============================================================ */

/* ---------------- 写：创建单个用户 ----------------
   v2.10.0（第六十轮 #172）：主体抽成 createUserCore，
   供「成员与档案」合并保存（save-member）复用 —— 那里要按四种场景
   编排「建号 / 绑档案 / 补档案」，不能再各自拼一套建号逻辑。 */
async function createUser(req, res, me, b) {
  const sql = getSql();
  const r = await createUserCore(sql, me, b, req);
  if (!r.ok) return fail(res, r.code, r.error);
  return ok(res, {
    message: '已创建账号 ' + r.username + '，该同学首次登录需自行修改密码'
      + (r.profileLinked ? '' : '（⚠️ 资料创建失败，请到「成员与档案」手动补一条）'),
    user: { id: r.userId, username: r.username },
    profileLinked: r.profileLinked,
  });
}

/**
 * 建号核心（不写 HTTP 响应，返回 { ok, ... } 供多处编排）。
 * @param skipProfile true 时不自动建班级档案 —— 调用方自己接管档案
 *   （「有档案无账号」场景下自动建会出现一人两条，必须由调用方绑定）。
 */
async function createUserCore(sql, me, b, req) {
  const username = normUsername(b.username);
  const password = String(b.password || '');
  const displayName = String(b.displayName || '').trim().slice(0, 30) || null;
  const role = b.role === 'admin' ? 'admin' : 'user';

  if (!validUsername(username)) {
    return { ok: false, code: 400, error: '用户名需 3–20 位，仅限中英文、数字、下划线' };
  }
  if (password.length < 6 || password.length > 64) {
    return { ok: false, code: 400, error: '初始密码长度需 6–64 位' };
  }

  const dup = await sql`select id from users where lower(username) = ${username} limit 1`;
  if (dup.length) return { ok: false, code: 409, error: '用户名 ' + username + ' 已存在' };

  const hash = await hashPassword(password);
  const rows = await sql`
    insert into users (username, display_name, password_hash, role, must_change_password)
    values (${username}, ${displayName}, ${hash}, ${role}, true)
    returning id, username
  `;

  /* 2026-10-08 修 bug：建号时**同步建一条 profiles**。
     起因：站主在后台建了新用户，却在整个「头衔任命」面板里找不到他。
     根因：头衔列表读的是 profiles（left join users on u.id = p.user_id），
          而这里过去只写 users、不建 profiles → 新账号永远不出现在头衔列表，
          也永远没法被任命、没法被资料查询命中。 */
  const userId = Number(rows[0].id);
  const profileLinked = b.skipProfile ? false
    : await ensureProfileForUser(sql, userId, displayName, await profileKey(req));

  await audit(me.id, 'user.create', 'user', String(userId), username);

  return { ok: true, userId, username: rows[0].username, profileLinked };
}

/**
 * 建号后同步补一条班级资料（2026-10-08 新增）。
 *
 * 为什么必须有：头衔任命、资料查询、个人中心全都读 profiles 表；
 * 账号（users）只是登录凭证。过去建号只写 users，导致新同学在
 * 「头衔任命」里查不到 → 无法任命职务（站主实际遇到的 bug）。
 *
 * 设计取舍：
 *   ① **不自动匹配已有的同名资料**。自动认领会把两个人错配成一人，
 *      而这是不可逆的（资料连带联系方式、学号全归错人）。
 *      宁可出现「一人两条」由管理员到资料管理里手工删除。
 *   ② **不引入事务**。账号是主、资料是附；profiles 建失败就用 try-catch
 *      吞掉并记日志，账号照常可登录（最坏退回改动前的状态，可手工补）。
 *   ③ 学号恒为空。多条 NULL 互不冲突，所以批量建号不会打架。
 *
 *   v3.5.0：姓名同样要加密（站主要求「档案里的所有信息」都加密）。
 *     这里没有 req 可拿，密钥从 envKey 参数传入；不传则写明文（老行为）。
 *
 * @param {object|null} [pkey] profileKey(req) 的结果
 * @returns {Promise<boolean>} 资料是否建成功
 */
async function ensureProfileForUser(sql, userId, displayName, pkey) {
  try {
    /* 已有资料挂在本人名下时不重复建（如先认领过再建号） */
    const exist = await sql`select id from profiles where user_id = ${userId} limit 1`;
    if (exist.length) return true;
    const nm = displayName || null;
    /* v3.5.5：姓名也要守字段规则（预置最多 3 字符）。不合规则时不建档案
       —— 账号照常可用（profileLinked=false，建号回执里会提示去手动补），
        loud 在日志里，不静默写一条违规数据进去。 */
    if (nm) {
      const meta = await loadFieldMeta();
      const nmRule = (meta.find((f) => f.field === 'name') || {}).rules;
      if (nmRule && nmRule.type) {
        const chk = validateByRules(nmRule, nm, '姓名');
        if (!chk.ok) {
          console.warn('[admin] 建号显示名不合姓名规则，跳过建档案（账号仍可用）：' + chk.error);
          return false;
        }
      }
    }
    await sql`
      insert into profiles (name, name_bidx, role, user_id)
      values (${await encField(pkey, nm)}, ${await blindIndex(pkey, nm)}, '学生', ${userId})
    `;
    return true;
  } catch (e) {
    console.warn('[admin] 为用户 ' + userId + ' 补建资料失败（账号仍可用）：', e.message);
    return false;
  }
}

/* ---------------- 写：批量创建（Excel 导入用） ----------------
   接收 { users: [{ username, password, displayName, role }] }，
   逐条 try-catch，返回 created / failed / errors[{index, username, reason}]。
   index 是**批内下标**，前端据此换算回 Excel 真实行号。

   为避免一次请求算太久（Workers 免费版 CPU 时间有限，PBKDF2 每次约 5–10ms），
   这里限制单批最多 60 条 —— 由前端分片调用。

   ⚠️ 本接口**不接收学号**，建出来的资料学号恒为空。
      批次内会因此出现多条 NULL：PG 与 SQLite 的 unique 约束都不把 NULL
      视为相等，所以不会冲突（已由测试 B 护栏）。
      【禁止】后续随手加个 studentId 入参而不做查重——那会直接撞 unique 报错。 */
const BATCH_LIMIT = 60;

async function batchCreate(req, res, me, b) {
  const list = Array.isArray(b.users) ? b.users : null;
  if (!list) return fail(res, 400, 'users 必须是数组');
  if (list.length === 0) return ok(res, { created: 0, failed: 0, errors: [] });
  if (list.length > BATCH_LIMIT) {
    return fail(res, 400, '单批最多 ' + BATCH_LIMIT + ' 条，请分片提交');
  }

  const sql = getSql();
  const errors = [];
  let created = 0;
  /* v3.5.0：批量建号会顺带建 profiles，姓名照样加密，密钥这里取一次复用 */
  const pkey = await profileKey(req);

  /* ① 先做一次批内查重，减少无谓的哈希计算 */
  const seen = new Set();

  for (let i = 0; i < list.length; i++) {
    const raw = list[i] || {};
    const username = normUsername(raw.username);
    const password = String(raw.password || '');
    const displayName = String(raw.displayName || raw.name || '').trim().slice(0, 30) || null;
    const role = raw.role === 'admin' ? 'admin' : 'user';

    /* 各项校验，失败就记原因继续下一条 */
    if (!username) { errors.push({ index: i, reason: '用户名为空' }); continue; }
    if (!validUsername(username)) {
      errors.push({ index: i, username, reason: '用户名格式不对（2–20 位中英文/数字/下划线）' });
      continue;
    }
    if (password.length < 6 || password.length > 64) {
      errors.push({ index: i, username, reason: '密码长度需 6–64 位' });
      continue;
    }
    if (seen.has(username)) {
      errors.push({ index: i, username, reason: '本批次内重复' });
      continue;
    }
    seen.add(username);

    try {
      const dup = await sql`select id from users where lower(username) = ${username} limit 1`;
      if (dup.length) {
        errors.push({ index: i, username, reason: '用户名已存在' });
        continue;
      }
      const hash = await hashPassword(password);
      const ins = await sql`
        insert into users (username, display_name, password_hash, role, must_change_password)
        values (${username}, ${displayName}, ${hash}, ${role}, true)
        returning id
      `;
      /* 同步补资料（理由同 createUser，见 ensureProfileForUser 的注释）。
         失败不阻断本条：账号已建好，资料可由管理员手工补。 */
      if (ins.length && ins[0].id != null) {
        await ensureProfileForUser(sql, Number(ins[0].id), displayName, pkey);
      }
      created++;
    } catch (e) {
      /* 唯一索引冲突等并发情况也走这里，不中断整批 */
      errors.push({ index: i, username, reason: '写入失败：' + (e.message || '未知错误') });
    }
  }

  await audit(
    me.id, 'user.batch_create', 'user', null,
    'created=' + created + ' failed=' + errors.length
  );

  return ok(res, { created, failed: errors.length, errors });
}

/* ---------------- 读：登录记录 ----------------
   GET ?action=login-logs&id=1&limit=50&offset=0   → 某人的登录历史
   GET ?action=login-logs&limit=50&offset=0        → 全站最近登录（不传 id）
   ------------------------------------------------------------ */
async function loginLogs(req, res) {
  const sql = getSql();
  const id = Number(req.query.id || 0);
  const limit = Math.min(Number(req.query.limit || 50), 300);
  const offset = Math.max(Number(req.query.offset || 0), 0);

  let rows;
  let total;

  if (id) {
    rows = await sql`
      select l.id, l.user_id, l.ip, l.user_agent, l.created_at, u.username
        from login_log l
        left join users u on u.id = l.user_id
       where l.user_id = ${id}
       order by l.created_at desc
       limit ${limit} offset ${offset}
    `;
    total = (await sql`select count(*)::int as n from login_log where user_id = ${id}`)[0].n;
  } else {
    rows = await sql`
      select l.id, l.user_id, l.ip, l.user_agent, l.created_at, u.username
        from login_log l
        left join users u on u.id = l.user_id
       order by l.created_at desc
       limit ${limit} offset ${offset}
    `;
    total = (await sql`select count(*)::int as n from login_log`)[0].n;
  }

  return ok(res, {
    total,
    logs: rows.map((r) => ({
      id: Number(r.id),
      userId: Number(r.user_id),
      username: r.username,
      ip: r.ip,
      userAgent: r.user_agent,
      createdAt: r.created_at,
    })),
  });
}

/* ---------------- 读：在线时长（v3.5.35） ----------------
   GET ?action=online&days=30&id=&limit=&offset=

   · 不传 id → 按人聚合：每人累计时长、时段数、最近一次在线、最长单次
   · 传 id   → 该人的时段明细（从新到旧）

   时长口径：每条 online_sessions = 一次「连续在线」（心跳间隔 ≤180 秒不断开），
   时长 = stop_at - start_at。单次只打过一个点的情况（start_at = stop_at = 0 秒）
   不计入「单次最长」，但计入时段数——那代表「来过一次就走了」。

   days 只作用于「按人聚合」的窗口；明细不分窗口，靠 limit/offset 翻。 */
async function onlineStats(req, res) {
  const sql = getSql();
  const id = Number(req.query.id || 0);
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const days = Math.min(Math.max(Number(req.query.days || 30), 1), 3650);

  if (id) {
    const rows = await sql`
      select o.id, o.session_token, o.start_at, o.stop_at, o.last_ping_at, o.ping_count,
             extract(epoch from (o.stop_at - o.start_at))::int as secs
        from online_sessions o
       where o.user_id = ${id}
       order by o.start_at desc
       limit ${limit} offset ${offset}
    `;
    const total = (await sql`select count(*)::int as n from online_sessions where user_id = ${id}`)[0].n;
    const sum = (await sql`
      select coalesce(sum(extract(epoch from (stop_at - start_at))), 0)::int as secs,
             count(*)::int as n
        from online_sessions where user_id = ${id}
    `)[0];
    /* v3.5.40（站主 #3）：这个人的时间都花在哪些页面。
       与 online_sessions 是两条独立时间线，分开查、分开返回。 */
    const pageRows = await sql`
      select page,
             coalesce(sum(extract(epoch from (stop_at - start_at))), 0)::int as secs,
             count(*)::int as n,
             max(stop_at) as last_at
        from online_pages
       where user_id = ${id}
       group by page
       order by secs desc
       limit 30
    `;
    return ok(res, {
      userId: id,
      total,
      totalSecs: sum.secs,
      sessionCount: sum.n,
      pages: pageRows.map((r) => ({
        page: r.page || '未知',
        secs: Math.max(0, Number(r.secs) || 0),
        count: Number(r.n) || 0,
        lastAt: r.last_at || null,
      })),
      sessions: rows.map((r) => ({
        id: Number(r.id),
        startAt: r.start_at,
        stopAt: r.stop_at,
        lastPingAt: r.last_ping_at,
        pingCount: Number(r.ping_count),
        secs: Math.max(0, Number(r.secs) || 0),
        device: String(r.session_token || '').slice(0, 8),
      })),
    });
  }

  /* 按人聚合。用户表可能很小，这里直接 join 全量再过滤，比两次往返省一次子请求。
     注：`max` 用 `filter (where ...)` 取「有长度的单次」，纯单点时段（0 秒）跳过。 */
  const rows = await sql`
    select u.id, u.username, u.display_name, u.role,
           coalesce(sum(extract(epoch from (o.stop_at - o.start_at))), 0)::int as total_secs,
           count(o.id)::int as session_count,
           coalesce(max(extract(epoch from (o.stop_at - o.start_at)))
                    filter (where o.stop_at > o.start_at), 0)::int as longest_secs,
           max(o.stop_at) as last_at
      from users u
      left join online_sessions o
             on o.user_id = u.id
            and o.start_at > now() - (${String(days)} || ' days')::interval
     group by u.id, u.username, u.display_name, u.role
     order by total_secs desc, u.id
     limit ${limit} offset ${offset}
  `;

  /* 全站合计：与上面同一个窗口，方便后台显示「总共在线 X 小时」 */
  const all = (await sql`
    select coalesce(sum(extract(epoch from (stop_at - start_at))), 0)::int as secs,
           count(*)::int as n,
           count(distinct user_id)::int as users
      from online_sessions
     where start_at > now() - (${String(days)} || ' days')::interval
  `)[0];

  /* v3.5.40（站主 #3）：全站「哪个页面最耗时间」—— 同一时间窗口，
     按 page 聚合。后台可据此看成绩分析 / 游戏 / 后台各占多少。 */
  const pageAgg = await sql`
    select page,
           coalesce(sum(extract(epoch from (stop_at - start_at))), 0)::int as secs,
           count(*)::int as n,
           count(distinct user_id)::int as users
      from online_pages
     where start_at > now() - (${String(days)} || ' days')::interval
     group by page
     order by secs desc
     limit 40
  `;

  return ok(res, {
    days,
    byPage: pageAgg.map((r) => ({
      page: r.page || '未知',
      secs: Math.max(0, Number(r.secs) || 0),
      count: Number(r.n) || 0,
      users: Number(r.users) || 0,
    })),
    totalUsers: (await sql`select count(*)::int as n from users`)[0].n,
    grandSecs: all.secs,
    grandSessions: all.n,
    activeUsers: all.users,
    users: rows.map((r) => ({
      id: Number(r.id),
      username: r.username,
      displayName: r.display_name,
      role: r.role,
      totalSecs: Math.max(0, Number(r.total_secs) || 0),
      sessionCount: Number(r.session_count) || 0,
      longestSecs: Math.max(0, Number(r.longest_secs) || 0),
      lastAt: r.last_at || null,
    })),
  });
}

/* ---------------- 读：导出（按筛选返回全量，前端生成 xlsx） ----------------
   带上与列表页相同的筛选条件，做到「所见即所得」的导出。
   不返回密码哈希——只导出非敏感字段。 */
async function exportUsers(req, res) {
  const sql = getSql();
  const q = String(req.query.q || '').trim().toLowerCase();
  const role = String(req.query.role || '').trim().toLowerCase();
  const status = String(req.query.status || '').trim().toLowerCase();

  const rows = await sql`
    select u.id, u.username, u.display_name, u.role, u.status,
           u.created_at, u.last_login_at, u.last_seen_at,
           coalesce(u.must_change_password, false) as must_change_password,
           coalesce(l.n, 0)::int as login_count
      from users u
      left join (
        select user_id, count(*)::int as n from login_log group by user_id
      ) l on l.user_id = u.id
     where (${q} = '' or lower(u.username) like '%' || ${q} || '%'
                         or lower(coalesce(u.display_name,'')) like '%' || ${q} || '%')
       and (${role} = ''   or u.role = ${role})
       and (${status} = '' or u.status = ${status})
     order by u.id
     limit 5000
  `;

  return ok(res, {
    total: rows.length,
    users: rows.map((r) => ({
      id: Number(r.id),
      username: r.username,
      displayName: r.display_name,
      role: r.role,
      status: r.status,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
      lastSeenAt: r.last_seen_at || null,
      mustChangePassword: !!r.must_change_password,
      loginCount: r.login_count,
    })),
  });
}

/* ============================================================
   班级通讯录 / 个人资料 管理
   ------------------------------------------------------------
   分工：
     · 姓名 / 学号 / 政治面貌 —— 身份信息，只有管理员能改（本人无权限）
     · 微信 / QQ / 手机号     —— 同学自填，管理员审核后才对外展示
     · 查看日志               —— 记录谁在什么时候查了谁，管理员可查
   ============================================================ */

/** 清洗文本输入 */
function cText(s, max) {
  return String(s == null ? '' : s).trim().slice(0, max || 60);
}
/** 联系方式去危险字符 */
function cContact(s) {
  return String(s == null ? '' : s).trim().slice(0, 64).replace(/[<>"']/g, '');
}

/**
 * 资料列表。支持按关键词（姓名/学号）与审核状态筛选。
 * 这个接口返回的是**管理端视图**：含联系方式原文与关联账号，仅管理员可调。
 */
async function listProfiles(req, res) {
  const sql = getSql();
  const q = cText(req.query.q, 40).replace(/[%_\\]/g, '');
  const st = cText(req.query.status, 16);   /* '' | none | pending | approved | rejected */

  /* v3.5.0：姓名/学号加密后 SQL 无法再 like 检索 ——
     配了密钥时改为「全表取回 → 解密 → 内存过滤」；
     没配密钥（明文库）则保持原来的 SQL 检索，行为不变。
     条数上限 1000 行，内存过滤的代价可以接受。 */
  const pkey = await profileKey(req);
  const rows = await sql`
    select p.*, u.username as bound_username
      from profiles p
      left join users u on u.id = p.user_id
     where (${q === '' || pkey ? true : false} = true
            or coalesce(p.name,'') like '%' || ${q} || '%'
            or coalesce(p.student_id,'') like '%' || ${q} || '%')
       and (${st} = '' or p.contact_status = ${st})
     order by p.student_id nulls last, p.name
     limit 1000
  `;
  /* 加密模式下在内存里按姓名/学号过滤（明文字段先解出来再比） */
  let filtered = rows;
  if (q && pkey) {
    const needle = q.toLowerCase();
    const keep = [];
    for (const r of rows) {
      const nm = String((await decField(pkey, r.name)) || '').toLowerCase();
      const sid = String((await decField(pkey, r.student_id)) || '').toLowerCase();
      if (nm.indexOf(needle) >= 0 || sid.indexOf(needle) >= 0) keep.push(r);
    }
    filtered = keep;
  }

  /* 统计各状态数量，供后台顶部标签显示 */
  const cnt = await sql`
    select
      count(*)::int as total,
      count(*) filter (where contact_status = 'pending')::int  as pending,
      count(*) filter (where contact_status = 'approved')::int as approved,
      count(*) filter (where user_id is not null)::int         as claimed
      from profiles
  `;

  /* 自定义字段清单：列表要带出它们的值（Excel 导出、后台动态列都靠它） */
  const editable = await loadEditableFields();

  return ok(res, {
    total: filtered.length,
    counts: cnt[0] || { total: 0, pending: 0, approved: 0, claimed: 0 },
    /* 字段元数据一并返回，后台可直接据此渲染动态列，省一次请求 */
    fieldMeta: await loadFieldMeta(),
    /* v3.5.0：这里同样要先解密（Promise.all 而不是 for-await，
       几十条并发解密比串行快得多，免费版子请求数不受影响——纯 CPU） */
    profiles: await Promise.all(filtered.map(async (r) => {
      const d = (v) => decField(pkey, v);
      const extra = {};
      for (const f of editable) {
        const v = r[f.field];
        if (v != null && v !== '') extra[f.field] = String(await d(v));
      }
      return {
        id: Number(r.id),
        name: (await d(r.name)) || '',
        studentId: (await d(r.student_id)) || '',
        politics: (await d(r.politics)) || '',
        examNo: (await d(r.exam_no)) || '',
        role: r.role || '学生',
        /* v3.5.22：档案里的「身份」（profiles.role）单独给一个键，
           避免与账号角色 role 混淆（前端编辑表单两个都要用） */
        identity: r.role || '学生',
        title: r.title || '',
        titles: normTitles(r.title).list,
        wechat: (await d(r.wechat)) || '',
        qq: (await d(r.qq)) || '',
        phone: (await d(r.phone)) || '',
        contactStatus: r.contact_status || 'none',
        rejectReason: r.reject_reason || '',
        userId: r.user_id ? Number(r.user_id) : null,
        boundUsername: r.bound_username || '',
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        /* 本人可见性意愿（2026-10-08）：后台资料列表用来标「🔒 私密」 */
        visibilityPref: safeJson(r.visibility_pref),
        /* 单人可见性例外（2026-10-09 v2.4.0）：管理员给该条资料设的例外 */
        fieldVis: safeJson(r.field_vis),
        /* 自定义 / 可编辑字段的值（2026-10-09 v2.4.0）：键即字段名 */
        extra,
      };
    })),
  });
}

/**
 * 安全解析 JSON 文本列（2026-10-08 新增）。
 * profiles.visibility_pref 是 text 列存 JSON，脏数据不应把整个接口搞崩。
 */
function safeJson(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const o = JSON.parse(String(raw));
    return o && typeof o === 'object' ? o : {};
  } catch (e) {
    return {};
  }
}

/**
 * v2.10.0（第六十轮 #172）：把 profiles 行整形成管理端扁平结构。
 * listMembers 与 save-member 的回显都用它，保证两处口径一致。
 *
 * v3.5.0：档案字段加密后，这里必须**先解密再整形**。
 *   数据流：DB(密文) → [本函数解密] → 前端(明文)
 *   明文/密文在库里混存（存量明文还没被管理员保存过），decField 对明文原样返回，
 *   所以这里不需要区分，逐个字段过一遍即可。
 * @param editable loadEditableFields() 的结果（自定义字段白名单）
 * @param key      profileKey(req) 的结果；null = 未配密钥，全站退化为明文
 */
async function shapeProfileAdmin(r, editable, key) {
  const dec = (v) => decField(key, v);
  const extra = {};
  for (const f of editable) {
    const v = r[f.field];
    if (v != null && v !== '') extra[f.field] = String(await dec(v));
  }
  return {
    profileId: Number(r.id),
    name: (await dec(r.name)) || '',
    studentId: (await dec(r.student_id)) || '',
    politics: (await dec(r.politics)) || '',
    examNo: (await dec(r.exam_no)) || '',
    role: r.role || '学生',
    identity: r.role || '学生',
    title: r.title || '',
    titles: normTitles(r.title).list,
    wechat: (await dec(r.wechat)) || '',
    qq: (await dec(r.qq)) || '',
    phone: (await dec(r.phone)) || '',
    contactStatus: r.contact_status || 'none',
    rejectReason: r.reject_reason || '',
    visibilityPref: safeJson(r.visibility_pref),
    fieldVis: safeJson(r.field_vis),
    extra,
    boundUsername: r.bound_username || '',
  };
}

/* ============================================================
   v2.10.0「成员与档案」合并列表（第六十轮 #172）
   ------------------------------------------------------------
   背景：站主指出后台「用户管理」「资料管理」把同一批人分两处存储，
   改一处另一处对不上。本接口把 users 与 profiles 合并成一个列表，
   每行带 scene 标记，覆盖四种场景：
     both          有账号 + 有档案（正常态）
     user-only     有账号暂无档案（建号时补档案失败 / 历史数据）
     profile-only  有档案无账号（通讯录先建、人还没领账号）
   姓名口径：profiles.name 为权威源；无档案时退回 users.display_name
   （保存侧由 upsertProfileCore 同步两处，见那里的注释）。
   ============================================================ */
async function listMembers(req, res) {
  const sql = getSql();
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 40).replace(/[%_\\]/g, '');
  const role = cText(req.query.role, 16).toLowerCase();
  const status = cText(req.query.status, 16).toLowerCase();
  const scene = cText(req.query.scene, 16).toLowerCase();
  const limit = Math.min(Number(req.query.limit || 200), 500);
  const offset = Math.max(Number(req.query.offset || 0), 0);

  /* ① 账号侧（在线/数据条数口径与 users 接口完全一致，避免两页数字打架） */
  const urows = await sql`
    select u.id, u.username, u.display_name, u.role, u.status,
           u.created_at, u.last_login_at, u.last_seen_at,
           coalesce(u.must_change_password, false) as must_change_password,
           coalesce(d.n, 0)::int as data_count,
           coalesce(sess.sess_n, 0)::int as online_sessions,
           sess.max_seen as online_last_seen
      from users u
      left join (
        select user_id, count(*)::int as n from user_data group by user_id
      ) d on d.user_id = u.id
      left join (
        select user_id,
               count(*) filter (
                 where expires_at > now()
                   and last_seen_at > now() - interval '90 seconds'
               )::int as sess_n,
               max(last_seen_at) as max_seen
          from sessions
         group by user_id
      ) sess on sess.user_id = u.id
     order by u.id
     limit 1000
  `;

  /* ② 档案侧（含绑定账号名与自定义字段值） */
  const prows = await sql`
    select p.*, u.username as bound_username
      from profiles p
      left join users u on u.id = p.user_id
     order by p.student_id nulls last, p.name
     limit 1000
  `;
  const editable = await loadEditableFields();
  const pkey = await profileKey(req);

  /* ③ JS 合并：一个账号只认第一条档案（脏数据不放大成重复行）；
       user_id 为空的档案是「未认领」，单独成行。 */
  const byUser = new Map();
  const orphans = [];
  for (const r of prows) {
    const uid = r.user_id == null ? null : Number(r.user_id);
    const shaped = await shapeProfileAdmin(r, editable, pkey);
    if (uid == null) orphans.push(shaped);
    else if (!byUser.has(uid)) byUser.set(uid, shaped);
  }

  const all = [];
  for (const u of urows) {
    const uid = Number(u.id);
    const p = byUser.get(uid) || null;
    /* 账号字段放在档案字段之后应用：档案默认值里也有 role:'学生'，
       若先应用账号字段会被冲掉（both 行全变学生，管理员徽章/筛选全错）。 */
    all.push(Object.assign(p || {
      profileId: null, name: '', studentId: '', politics: '', examNo: '',
      identity: '学生', title: '', titles: [], wechat: '', qq: '', phone: '',
      contactStatus: 'none', rejectReason: '',
      visibilityPref: {}, fieldVis: {}, extra: {}, boundUsername: '',
    }, {
      scene: p ? 'both' : 'user-only',
      userId: uid,
      username: u.username,
      displayName: u.display_name,
      role: u.role,
      status: u.status,
      mustChangePassword: !!u.must_change_password,
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at,
      lastSeenAt: u.last_seen_at || null,
      online: Number(u.online_sessions) > 0,
      onlineSessions: Number(u.online_sessions) || 0,
      sessionLastSeen: u.online_last_seen || null,
      dataCount: Number(u.data_count) || 0,
    }));
  }
  for (const p of orphans) {
    all.push(Object.assign({
      scene: 'profile-only',
      userId: null, username: '', displayName: '', role: '', status: '',
      mustChangePassword: false, createdAt: null, lastLoginAt: null, lastSeenAt: null,
      online: false, onlineSessions: 0, sessionLastSeen: null, dataCount: 0,
    }, p));
  }

  /* ④ 筛选（角色/状态对 profile-only 行天然不命中——它们没有账号属性） */
  const match = (m) => {
    if (scene && m.scene !== scene) return false;
    if (role && (m.role || '') !== role) return false;
    if (status && (m.status || '') !== status) return false;
    if (q) {
      const hay = [m.username, m.displayName, m.name, m.studentId].join('\n').toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  };
  const filtered = all.filter(match);

  const counts = {
    total: all.length,
    both: all.filter((m) => m.scene === 'both').length,
    userOnly: all.filter((m) => m.scene === 'user-only').length,
    profileOnly: all.filter((m) => m.scene === 'profile-only').length,
    pendingReview: all.filter((m) => m.contactStatus === 'pending').length,
    claimed: all.filter((m) => m.userId != null).length,
  };

  return ok(res, {
    total: filtered.length,
    counts,
    fieldMeta: await loadFieldMeta(),
    members: filtered.slice(offset, offset + limit),
  });
}

/**
 * 读字段元数据（2026-10-08 新增）。
 * 失败时返回空数组 —— 老库可能还没自愈出 profile_field_meta 表，
 * 后台界面不该因此白屏。
 */
async function loadFieldMeta() {
  try {
    const sql = getSql();
    /* ⚠️ v3.6.1：原来写死列名（含 self_edit），只要老库还没补上那一列，
       整条 select 就会报错 → catch 返回空数组 → 后台「字段管理」显示 0 个字段。
       站主 2026-10-19 遇到的就是这个（字段其实都在，只是列表读不出来）。
       改成 select * 再逐列取，缺哪列都不至于整张表读不出来。 */
    const rows = await sql`select * from profile_field_meta order by sort_order, field`;
    return rows.map((r) => ({
      field: r.field,
      label: r.label || r.field,
      visibility: r.visibility || 'public',
      sortOrder: Number(r.sort_order || 100),
      isCustom: !!r.is_custom,
      /* v3.5.5 校验规则：先过 normalizeRules —— 老库可能是 {},
         历史脏数据也可能奇形怪状，收敛后再给前端渲染控件。 */
      rules: normalizeRules(r.rules),
      /* 站主是否设过该字段的可见性（2026-10-09 v2.4.1）。
         设过 → 同学自己的「仅自己可见」不再生效（后台权力最大）。
         自定义字段天然算设过。 */
      adminSet: !!r.vis_locked || !!r.is_custom,
      /* v3.5.40（站主 #1）：本人可编辑。后台勾上后，同学能在「我的资料」里
         自己改这一项；关掉就只能由后台改。 */
      selfEdit: !!(r.self_edit === true || r.self_edit === 1 || r.self_edit === 't'),
    }));
  } catch (e) {
    console.warn('[admin] 读字段元数据失败（返回空）：', e.message);
    return [];
  }
}

/** 读：字段元数据一览（后台「字段管理」用） */
async function fieldMeta(req, res) {
  const fields = await loadFieldMeta();
  /* 顺手带上每个字段「有多少条资料填了值」，后台一眼看出哪些字段是空摆设。
     ⚠️ 用 sum(case when ...) 而不用 count(*) filter (where ...)：
        filter 子句在部分驱动 / 测试桩（SQLite 老版本）上不支持，
        会导致整个统计查询报错、counts 全空（表现为前端看不到填报数）。 */
  const sql = getSql();
  let counts = {};
  let total = 0;
  try {
    /* 统计哪些列：固定列 + 全部登记过的字段（含自定义）。
       ⚠️ 列名来自 meta 表（当初过了白名单），拼前再用 isSafeFieldFormat 复核。
          这里**不能**用 checkFieldName —— 它含「禁止撞系统列名」黑名单，
          会把 id_card / youth_league_no 这类系统列自己挡掉，统计永远为 0。 */
    const cols = ['name', 'student_id', 'politics', 'exam_no', 'wechat', 'qq', 'phone']
      .concat(fields.map((f) => f.field).filter((f) => {
        const c = isSafeFieldFormat(f);
        return c.ok && !['name', 'student_id', 'politics', 'exam_no', 'wechat', 'qq', 'phone', 'role', 'title'].includes(f);
      }));
    const uniq = [...new Set(cols)];
    const cntExpr = (col) => `sum(case when coalesce(${col},'') <> '' then 1 else 0 end) as ${col}`;
    const rows = await sql(
      'select count(*) as total, ' + uniq.map(cntExpr).join(', ') + ' from profiles'
    );
    const r0 = rows[0] || {};
    total = Number(r0.total || 0);
    for (const k of Object.keys(r0)) {
      if (k === 'total') continue;
      counts[k] = Number(r0[k] || 0);
    }
  } catch (e) {
    /* 老库可能还没补出 id_card/youth_league_no 列；计数失败不影响字段列表 */
    console.warn('[admin] 统计字段填报数失败（忽略）：', e.message);
    counts = {};
  }
  return ok(res, {
    fields: fields.map((f) => ({ ...f, filledCount: counts[f.field] })),
    totalProfiles: total,
  });
}

/* ============================================================
   动态字段的读写工具（2026-10-09 v2.4.0 新增）
   ------------------------------------------------------------
   自定义字段是 profiles 的真实列，读的时候 `select *` 就能拿到；
   写的时候列名要拼进 SQL，所以必须：
     ① 列名来自 meta 表（当初经过 checkFieldName 白名单）
     ② 拼之前再过一次 checkFieldName，防历史脏数据
     ③ 值一律用参数化
   ============================================================ */

/** 这些字段名有专门的处理逻辑（长度限制/审核状态等），不走「通用文本」通道 */
/* v3.5.22：role / title 从特殊字段里放出来 —— 站主要求「后台人员的档案字段全部都可以
   在线编辑」，身份和头衔也要能直接在成员表单里改（以前只能去「头衔任命」单独操作）。
   ⚠️ 它们仍是 profiles 表的**固定列**，所以：
     · upsertProfileCore 里必须显式处理（role 已走 $7；title 见下方的 title 分支）
     · 前端 extraColsOf() 的 FIXED 名单要继续排除它们，避免同一列传两遍 */
const SPECIAL_FIELDS = ['name', 'student_id', 'politics', 'exam_no',
  'wechat', 'qq', 'phone', 'contact_status', 'reject_reason'];

/**
 * 取出「可自定义字段」清单（系统字段里除特殊处理外 + 全部自定义字段）。
 * 例如 id_card / youth_league_no 虽是系统字段（is_custom=false），
 * 但也该能在编辑弹窗里填值 —— 它们不在 SPECIAL_FIELDS 里。
 */
async function loadEditableFields() {
  const all = await loadFieldMeta();
  return all.filter((f) => !SPECIAL_FIELDS.includes(f.field));
}

/**
 * 从请求体里挑出某个自定义字段的值。
 * 非字符串一律忽略（避免前端传对象把列写坏）；超长截断。
 */
function pickCustomValue(raw, maxLen = 200) {
  if (raw == null) return null;
  if (typeof raw === 'object') return null;
  const s = String(raw).trim();
  return s ? s.slice(0, maxLen) : '';
}

/**
 * 校验并整理前端传来的「单人可见性例外」。
 * 只保留 meta 表里登记过、且值合法的键。
 * @returns {string|null} JSON 文本；无有效内容时返回 null
 */
function buildFieldVis(raw, allowedFields) {
  if (!raw || typeof raw !== 'object') return null;
  const clean = {};
  for (const k of Object.keys(raw)) {
    if (!allowedFields.includes(k)) continue;
    const v = String(raw[k] || '').trim();
    if (ALLOWED_VIS.includes(v)) clean[k] = v;
  }
  return Object.keys(clean).length ? JSON.stringify(clean) : null;
}

/**
 * v3.5.5：按字段规则校验一条资料的录入值（服务端唯一裁判）。
 *
 * 站主要求「所有字段支持管理员自定义配置校验规则」—— 前端选择器只是
 * 「让正确输入更容易」，批量导入 / 直接调 API 都能绕过 UI，所以写库前
 * 必须在这里复核。没配规则的字段直接放过（空值也一律放过，见
 * field-rules.js 纪律②：规则约束「填了的时候」长什么样，不强制必填）。
 *
 * @param {object} vals  字段名 → 值（已过 cText / cContact 清洗）
 * @param {Array}  meta  loadFieldMeta() 的结果（含 normalize 过的 rules）
 * @returns {{ok:true} | {ok:false, error:string}}
 */
function validateProfileFields(vals, meta) {
  if (!vals || typeof vals !== 'object') return { ok: true };
  const labelOf = {};
  const ruleOf = {};
  for (const f of meta || []) {
    labelOf[f.field] = f.label || f.field;
    ruleOf[f.field] = f.rules;
  }
  for (const field of Object.keys(vals)) {
    const rule = ruleOf[field];
    if (!rule || !rule.type) continue;   /* 没配规则 = 不约束 */
    const r = validateByRules(rule, vals[field], labelOf[field]);
    if (!r.ok) return r;
  }
  return { ok: true };
}

/* ---------------- 写：调整某条资料的可见性上限（管理员权限） ----------------
   站主原话：「用户可自定义选择是否公开，我后台也可以管理是否公开，以及公开的范围」。
   前一句由 profile.js 的 submit + visibility_pref 实现（本人收窄）；
   后一句就是这里 —— 管理员直接改 profile_field_meta.visibility（全局上限）。

   动作：POST /api/admin?action=set-visibility
   体：{ field, visibility }  visibility ∈ public | committee | self

   ⚠️ 改的是**全局字段**，不是某一个人的资料 —— 因为它本身就是「上限」。
      想单独收窄某个人，走本人意愿（visibility_pref）。 */
const ALLOWED_VIS = ['public', 'committee', 'self', 'admin'];

async function setVisibility(req, res, me, b) {
  const field = String(b.field || '').trim().slice(0, 40);
  const vis = String(b.visibility || '').trim();
  if (!field) return fail(res, 400, '缺少 field');
  if (ALLOWED_VIS.indexOf(vis) < 0) {
    return fail(res, 400, 'visibility 只能是 public / committee / self / admin');
  }

  const sql = getSql();
  const exists = await sql`select field from profile_field_meta where field = ${field} limit 1`;
  if (!exists.length) return fail(res, 404, '没有这个字段：' + field);

  /* 🔴 vis_locked = true（2026-10-09 v2.4.1）：
     这一列 = 「站主动过这个字段的可见性」。置 true 后，同学在个人中心设的
     「仅自己可见」对**这个字段**不再生效 —— 后台权力最大，以站主为准。
     站主原话：「即使他修改了可见范围但是后台还是可以修改」。
     ⚠️ 不能靠「visibility 是否等于出厂值」来判断站主动没动过（站主可以把
        字段设成它本来就是的档，值不变但确实动过），必须显式打标记。 */
  await sql`
    update profile_field_meta
       set visibility = ${vis}, vis_locked = true, updated_at = now()
     where field = ${field}
  `;
  await audit(me.id, 'field.visibility', 'profile_field', field, vis);
  return ok(res, {
    message: '已把「' + field + '」的可见范围改为 ' + vis
      + '（此字段已锁定：同学自己的「仅自己可见」不再生效）',
    field, visibility: vis, adminSet: true,
  });
}

/* ============================================================================
 * v3.5.40（站主 #1）：字段「本人可编辑」开关
 * ----------------------------------------------------------------------------
 * 站主原话：「字段管理的所有字段均可设置本人是否可编辑，后台开启后则该用户
 *           可以在个人资料页面或个人资料查询卡片修改字段内容」
 *
 * 这里只负责「许可」这一位。真正的写入在 profile.js 的 self-update：
 *   ① 字段必须在 profile_field_meta 里且 self_edit = true（逐字段校验，不整包放行）
 *   ② 值要过该字段的 rules（长度 / 数字 / 时间精度 / 下拉选项）
 *   ③ 加密字段照旧走 profile-crypt，明文绝不下库
 * 匿名/未认领的账号没有 profiles 行，自然改不了自己 —— 与既有认领流程一致。
 * ========================================================================= */
async function setSelfEdit(req, res, me, b) {
  const field = String(b.field || '').trim().slice(0, 40);
  if (!field) return fail(res, 400, '缺少 field');
  const on = !!b.selfEdit;

  const sql = getSql();
  const exists = await sql`select field, label from profile_field_meta where field = ${field} limit 1`;
  if (!exists.length) return fail(res, 404, '没有这个字段：' + field);

  /* ⚠️ v3.6.4：老库可能还没有 self_edit 列（升级中断 / 建表跑过但补列失败），
     直接 update 会 500「服务器内部错误」—— 站主点「允许本机编辑」踩的就是这个。
     先补列再写，幂等且便宜。 */
  try {
    await sql`alter table profile_field_meta add column if not exists self_edit boolean not null default false`;
  } catch (e) {
    console.warn('[admin] 补 self_edit 列失败：', e.message);
  }

  await sql`
    update profile_field_meta
       set self_edit = ${on}, updated_at = now()
     where field = ${field}
  `;
  await audit(me.id, 'field.self_edit', 'profile_field', field, on ? 'on' : 'off');
  return ok(res, {
    field,
    selfEdit: on,
    message: on
      ? '已允许本人编辑「' + (exists[0].label || field) + '」'
      : '已关闭「' + (exists[0].label || field) + '」的本人编辑',
  });
}

/* ============================================================
   自定义资料字段的增 / 删 / 改（2026-10-09 v2.4.0 新增）
   ------------------------------------------------------------
   站主原话：「以后如果可以的话，我能不能在后台直接加……比如新增用户
             资料的某个区域」。

   实现路线：profiles 表加**真实列**（而非 JSON 塞一列）。理由：
     · 加真实列后，Excel 导出/导入、检索、排序全都能直接复用现有 SQL，
       不用为每个字段写一套 JSON 取值逻辑
     · 代价是字段名要拼进 DDL —— 由 http.js 的 checkFieldName 严格白名单兜住

   🔴 三条铁律（改本段代码前务必确认）：
     1. 任何拼进 SQL 的字段名**必须先过 checkFieldName**
     2. 新增字段的 alter table **绝不放进 ensureSchema**（见那里的注释：
        schemaReady 单次标记 + catch 吞错，一个坏字段能让整段自愈失效）
     3. 只有 is_custom = true 的字段允许删除，系统字段一律拒绝
   ============================================================ */

/** 读单个字段的元数据 */
async function readFieldRow(sql, field) {
  const rows = await sql`
    select field, label, visibility, sort_order, is_custom, vis_locked
      from profile_field_meta where field = ${field} limit 1
  `;
  return rows.length ? rows[0] : null;
}

/**
 * 新增自定义资料字段。
 * body: { field: 'school_id', label: '学籍号', visibility?: 'public|committee|self', sortOrder?: 120 }
 *
 * 步骤：校验字段名 → 查重 → alter table 建列 → insert meta 行。
 * ⚠️ 建列成功但 insert meta 失败时，要回滚把列删掉，避免留下「有列无元数据」
 *    的幽灵字段（前台永远看不到它，但 Excel 导出会多一列，极难排查）。
 */
async function addField(req, res, me, b) {
  /* 若这个字段名以前被删过（墓碑里还在），管理员现在主动加回来 → 解除墓碑，
     否则下一次 schema 升级会把它再清掉。 */
  const chk = checkFieldName(b.field);
  if (!chk.ok) return fail(res, 400, chk.reason);
  const field = chk.field;

  const label = cText(b.label, 20);
  if (!label) return fail(res, 400, '请填写字段的中文名称（如「学籍号」）');

  const visRaw = String(b.visibility || 'self').trim();
  const visibility = ALLOWED_VIS.includes(visRaw) ? visRaw : 'self';
  /* v3.5.5 校验规则：先 normalize 收敛形状（脏数据 → 最接近合法形态），
     空对象 = 不校验。前端规则编辑器传什么这里都接得住。 */
  const rules = normalizeRules(b.rules);
  /* 新字段默认排到最后：取当前最大 sort_order + 10 */
  let sortOrder = Number(b.sortOrder);
  if (!Number.isFinite(sortOrder) || sortOrder < 0) sortOrder = 0;

  const sql = getSql();

  const exists = await readFieldRow(sql, field);
  if (exists) return fail(res, 409, '字段「' + field + '」已存在（' + (exists.label || '') + '）');

  if (RESERVED_PROFILE_COLS.includes(field)) {
    return fail(res, 400, '「' + field + '」是系统保留列名，不能用作自定义字段');
  }

  if (!sortOrder) {
    const mx = await sql`select coalesce(max(sort_order), 0) as m from profile_field_meta`;
    sortOrder = Number((mx[0] && mx[0].m) || 0) + 10;
  }

  /* 🔴 字段名已过白名单校验，这里可以安全拼接（列名无法参数化）。
     ⚠️ 调用形式是 sql(字符串, 参数) —— @neondatabase/serverless 0.10.4
        的标签函数本身把整条 SQL 作为 query 发出、params 单独传，
        所以 DDL 走普通调用形式即可；本版本**没有** sql.unsafe()。 */
  try {
    await sql(`alter table profiles add column if not exists ${field} text`);
  } catch (e) {
    return fail(res, 500, '建列失败：' + String(e.message || e).slice(0, 200));
  }

  try {
    /* vis_locked = true：自定义字段是站主亲自建的、可见性也是他定的，
       天然属于「站主说了算」，同学自己设的私密不覆盖它。 */
    await sql`
      insert into profile_field_meta (field, label, visibility, sort_order, is_custom, vis_locked, rules)
      values (${field}, ${label}, ${visibility}, ${sortOrder}, true, true, ${JSON.stringify(rules)}::jsonb)
    `;
  } catch (e) {
    /* 回滚：把刚建的列删掉，避免幽灵字段 */
    try {
      await sql(`alter table profiles drop column if exists ${field}`);
    } catch (e2) {
      console.warn('[admin] 回滚自定义字段列失败：', field, e2.message);
    }
    return fail(res, 500, '登记字段失败：' + String(e.message || e).slice(0, 200));
  }

  /* 重新加回来的字段要解除墓碑，否则下次 schema 升级会被当成「已删除」再清掉 */
  try {
    await sql`
      update site_settings
         set data = jsonb_set(
               data, '{deleted_fields}',
               coalesce((
                 select jsonb_agg(v)
                   from jsonb_array_elements_text(coalesce(data->'deleted_fields', '[]'::jsonb)) v
                  where v <> ${field}
               ), '[]'::jsonb),
               true),
             updated_at = now()
       where id = 1
    `;
  } catch (e) { console.warn('[admin] 解除字段墓碑失败：', e.message); }

  await audit(me.id, 'field.add', 'profile_field', field, label + '/' + visibility);
  return ok(res, {
    message: '已新增字段「' + label + '」（' + field + '）',
    field, label, visibility, sortOrder, rules,
  });
}

/* ============================================================================
 * v3.6.1（站主 #4）：云端数据备份 / 回档
 * ----------------------------------------------------------------------------
 * 站主原话：「后台新增数据管理，以后每次更新都先自动备份所有数据
 *            （通过检测在部署前先备份后部署），包括作业、公告、用户数据等等
 *            全部云端内容，默认存储最近 14 个版本更新，方便有问题随时回档」
 *
 * 设计取舍：
 *   · 备份**整包快照**存 data_backups.payload（jsonb），一版一行 ——
 *     比按表拆开更好查、更好回滚，也不会因为表结构变化而还原不了。
 *   · 只备份「业务数据」：账号 / 档案 / 字段定义 / 成绩 / 投票 / 歌曲时长 /
 *     站点设置 / 个人云端数据。登录日志、在线心跳这类高频流水不进快照
 *     （几百 MB 且没有回档价值）。
 *   · 每版跑 10 条 select，加插入与清理大约 13 个子请求，Workers 50 的额度够用。
 *   · 保留策略：按版本号留最近 14 个（同版本最多留 3 份）。
 *
 * 回档范围（第一版）：
 *   content      —— 个人云端数据里的站点内容（作业 / 公告 / 弹窗 / 排期…）
 *   profiles     —— 班级档案（按 id upsert）
 *   field_meta   —— 字段管理定义
 *   settings     —— 站点设置
 * 账号密码**默认不覆盖**（回档把大家密码改回旧值会造成集体登不上）。
 * ========================================================================= */
const BACKUP_TABLES = [
  'users', 'profiles', 'profile_field_meta', 'site_settings', 'user_data',
  'exams', 'exam_scores', 'class_votes', 'class_vote_ballots', 'song_durations',
];
const BACKUP_MAX_BYTES = 8 * 1024 * 1024;
const BACKUP_KEEP_VERSIONS = 14;

async function buildBackupPayload(sql) {
  const dump = {};
  for (const t of BACKUP_TABLES) {
    try {
      const rows = await sql('select * from ' + t + ' limit 20000');
      dump[t] = rows;
    } catch (e) {
      dump[t] = [];
      dump.__errors = (dump.__errors || []).concat(t + ': ' + String(e.message || e).slice(0, 80));
    }
  }
  return dump;
}

/** 按版本保留最近 N 个；同版本最多留 3 份 */
async function pruneBackups(sql) {
  try {
    const vers = await sql`
      select version, max(created_at) as t
        from data_backups
       group by version
       order by t desc
       limit ${BACKUP_KEEP_VERSIONS}
    `;
    const keep = vers.map((v) => v.version);
    if (!keep.length) return 0;
    const list = keep.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(',');
    const del = await sql('delete from data_backups where version not in (' + list + ') returning id');
    for (const v of keep) {
      await sql`
        delete from data_backups
         where version = ${v}
           and id not in (
             select id from data_backups where version = ${v} order by created_at desc limit 3
           )
      `;
    }
    return del.length;
  } catch (e) {
    console.warn('[admin] 清理旧备份失败：', e.message);
    return 0;
  }
}

async function createBackup(req, res, me, b) {
  const version = String((b && b.version) || '').trim().slice(0, 20) || 'unknown';
  const kind = ['auto', 'predeploy', 'manual'].indexOf(String((b && b.kind) || '')) >= 0
    ? String(b.kind) : 'manual';
  const note = String((b && b.note) || '').slice(0, 200);

  const sql = getSql();
  const payload = await buildBackupPayload(sql);
  let bytes = 0;
  try { bytes = JSON.stringify(payload).length; } catch (e) { bytes = 0; }
  if (bytes > BACKUP_MAX_BYTES) {
    return fail(res, 413, '数据太大（' + Math.round(bytes / 1024) + 'KB），超过 8MB 上限；请先在后台清理无用成绩/日志再试');
  }

  const row = await sql`
    insert into data_backups (version, kind, note, payload, bytes)
    values (${version}, ${kind}, ${note}, ${JSON.stringify(payload)}::jsonb, ${bytes})
    returning id, created_at
  `;
  const pruned = await pruneBackups(sql);
  await audit(me.id, 'data.backup', 'data_backup', String(row[0].id), version + '/' + kind + '/' + bytes);

  return ok(res, {
    id: Number(row[0].id),
    version, kind, bytes,
    createdAt: row[0].created_at,
    pruned,
    summary: BACKUP_TABLES.map((t) => t + ':' + ((payload[t] || []).length)).join(' '),
    message: '已备份（' + Math.round(bytes / 1024) + 'KB）' + (pruned ? '，清理了 ' + pruned + ' 个过期备份' : ''),
  });
}

async function listBackups(req, res) {
  const sql = getSql();
  const rows = await sql`
    select id, version, kind, note, bytes, created_at
      from data_backups
     order by created_at desc
     limit 60
  `;
  const total = (await sql`select count(*)::int as n, coalesce(sum(bytes),0)::int as b from data_backups`)[0];
  return ok(res, {
    backups: rows.map((r) => ({
      id: Number(r.id), version: r.version, kind: r.kind, note: r.note || '',
      bytes: Number(r.bytes || 0), createdAt: r.created_at,
    })),
    count: Number(total.n || 0),
    totalBytes: Number(total.b || 0),
    keepVersions: BACKUP_KEEP_VERSIONS,
  });
}

async function getBackup(req, res) {
  const id = Number(req.query.id || 0);
  const sql = getSql();
  const rows = await sql`
    select id, version, kind, note, bytes, created_at, payload
      from data_backups where id = ${id} limit 1
  `;
  if (!rows.length) return fail(res, 404, '没有这个备份');
  const r = rows[0];
  let p = r.payload;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = {}; } }
  const counts = {};
  Object.keys(p || {}).forEach((k) => {
    if (k.indexOf('__') === 0) return;
    counts[k] = Array.isArray(p[k]) ? p[k].length : 0;
  });
  return ok(res, {
    backup: {
      id: Number(r.id), version: r.version, kind: r.kind, note: r.note || '',
      bytes: Number(r.bytes || 0), createdAt: r.created_at, counts,
    },
  });
}

async function deleteBackup(req, res, me, b) {
  const id = Number((b && b.id) || 0);
  if (!id) return fail(res, 400, '缺少 id');
  const sql = getSql();
  await sql`delete from data_backups where id = ${id}`;
  await audit(me.id, 'data.backup_delete', 'data_backup', String(id), '');
  return ok(res, { message: '备份已删除（不可恢复）' });
}

/* 只允许恢复这几张表：账号密码与日志不在范围内，避免误伤 */
async function restoreBackup(req, res, me, b) {
  const id = Number((b && b.id) || 0);
  const parts = Array.isArray(b && b.parts) ? b.parts.map(String) : ['content', 'profiles', 'field_meta', 'settings'];
  if (!id) return fail(res, 400, '缺少备份 id');

  const sql = getSql();
  const rows = await sql`select id, version, created_at, payload from data_backups where id = ${id} limit 1`;
  if (!rows.length) return fail(res, 404, '没有这个备份');
  let p = rows[0].payload;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = {}; } }

  const done = [];
  const skipped = [];

  /* ---- 1) 站点内容（作业/公告/弹窗/排期…） ---- */
  if (parts.indexOf('content') >= 0) {
    const ud = (p.user_data || []).filter((r) => r.data_key === 'cls_site_contents');
    if (!ud.length) skipped.push('content（备份里没有内容文档）');
    else {
      const r0 = ud[0];
      const v = typeof r0.data_value === 'string' ? r0.data_value : JSON.stringify(r0.data_value);
      await sql`
        insert into user_data (user_id, data_key, data_value, updated_at)
        values (${r0.user_id}, 'cls_site_contents', ${v}, now())
        on conflict (user_id, data_key)
        do update set data_value = excluded.data_value, updated_at = now()
      `;
      done.push('content');
    }
  }

  /* ---- 2) 档案（按 id upsert；加密字段原样回写，不需要解密） ---- */
  if (parts.indexOf('profiles') >= 0) {
    const list = p.profiles || [];
    let n = 0;
    for (const row of list) {
      const keys = Object.keys(row).filter((k) => k !== 'id' && isSafeFieldFormat(k).ok);
      if (!keys.length) continue;
      const cols = keys.join(', ');
      const ph = keys.map((_, i) => '$' + (i + 2)).join(', ');
      const params = [row.id].concat(keys.map((k) => row[k]));
      const upd = keys.map((k) => k + ' = excluded.' + k).join(', ');
      try {
        await sql(
          'insert into profiles (id, ' + cols + ') values ($1, ' + ph + ') '
          + 'on conflict (id) do update set ' + upd,
          params
        );
        n++;
      } catch (e) { /* 单行失败不影响其它行 */ }
    }
    if (n) done.push('profiles(' + n + ')');
    else skipped.push('profiles（无可写行）');
  }

  /* ---- 3) 字段定义 ---- */
  if (parts.indexOf('field_meta') >= 0) {
    const list = p.profile_field_meta || [];
    let n = 0;
    for (const r of list) {
      const chk = isSafeFieldFormat(r.field);
      if (!chk.ok) continue;
      try {
        await sql`
          insert into profile_field_meta (field, label, visibility, sort_order, is_custom, vis_locked, rules)
          values (${r.field}, ${r.label || r.field}, ${r.visibility || 'public'},
                  ${Number(r.sort_order) || 100}, ${!!r.is_custom}, ${!!r.vis_locked},
                  ${JSON.stringify(r.rules || {})}::jsonb)
          on conflict (field) do update
            set label = excluded.label, visibility = excluded.visibility,
                sort_order = excluded.sort_order, rules = excluded.rules, updated_at = now()
        `;
        n++;
      } catch (e) {}
    }
    if (n) done.push('field_meta(' + n + ')');
    else skipped.push('field_meta（无可写行）');
  }

  /* ---- 4) 站点设置 ---- */
  if (parts.indexOf('settings') >= 0) {
    const r = (p.site_settings || [])[0];
    if (r) {
      const v = typeof r.data === 'string' ? r.data : JSON.stringify(r.data || {});
      await sql`
        insert into site_settings (id, data, updated_at)
        values (1, ${v}::jsonb, now())
        on conflict (id) do update set data = excluded.data, updated_at = now()
      `;
      done.push('settings');
    } else skipped.push('settings（备份里没有）');
  }

  await audit(me.id, 'data.restore', 'data_backup', String(id),
    'restored: ' + done.join(',') + '; skipped: ' + skipped.join(','));

  return ok(res, {
    restored: done,
    skipped,
    version: rows[0].version,
    message: '已从「' + rows[0].version + '」备份恢复：' + (done.join('、') || '无')
      + (skipped.length ? '；未恢复：' + skipped.join('、') : ''),
  });
}

/* ============================================================================
 * v3.6.4（站主 #3）：撤回删除（30 分钟窗口）
 * ----------------------------------------------------------------------------
 * 站主原话：「数据可以直接删除而不是隐藏，这样会出现更多的问题，在后端的操作
 *            记录里新增撤回的功能，现在删除数据倒计时 30 分钟，30 分钟以内在
 *            后台操作日志里点击撤回即可重新显示，否则真正删除数据」
 *
 * 撤回做的事（按 deleteField 的反向操作来）：
 *   ① 把列加回来（add column if not exists）
 *   ② 用一条 UPDATE ... FROM (VALUES ...) 把当时导出的值批量写回
 *      （不用逐行 update —— 61 行就是 61 次子请求，Workers 额度扛不住）
 *   ③ 字段定义按快照恢复（保留原来的可见性 / 排序 / 校验规则）
 *   ④ 把这个字段从「墓碑」里摘掉，否则下次升级又会按墓碑删一遍
 * 过期或记录不存在 → 明确告诉用户「已超过 30 分钟」，不装作成功。
 * ========================================================================= */
async function undoDelete(req, res, me, b) {
  const id = Number((b && b.id) || 0);
  if (!id) return fail(res, 400, '缺少 id');

  const sql = getSql();
  const rows = await sql`select * from deleted_items where id = ${id} limit 1`;
  if (!rows.length) return fail(res, 404, '这条删除记录已经不存在了');
  const it = rows[0];
  const expires = new Date(it.expires_at).getTime();
  if (Date.now() > expires) {
    return fail(res, 410, '已经超过 30 分钟，这条数据已被真正删除，无法撤回');
  }

  let p = it.payload;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = {}; } }

  if (it.kind === 'field') {
    const chk = isSafeFieldFormat(p.field);
    if (!chk.ok) return fail(res, 400, '字段名不合法，无法撤回');

    try {
      await sql(`alter table profiles add column if not exists ${chk.field} text`);
    } catch (e) {
      return fail(res, 500, '重建字段列失败：' + String(e.message || e).slice(0, 120));
    }

    const list = Array.isArray(p.rows) ? p.rows : [];
    if (list.length) {
      try {
        const pairs = list.map((r, i) => `($${i * 2 + 1}::bigint, $${i * 2 + 2}::text)`).join(',');
        const params = list.flatMap((r) => [r.id, r.v]);
        await sql(
          'update profiles as pr set ' + chk.field + ' = v.val '
          + 'from (values ' + pairs + ') as v(id, val) where pr.id = v.id',
          params
        );
      } catch (e) {
        console.warn('[admin] 撤回字段值时部分失败：', e.message);
      }
    }

    try {
      await sql`
        insert into profile_field_meta (field, label, visibility, sort_order, is_custom, vis_locked, rules)
        values (${p.field}, ${p.label || p.field}, ${p.visibility || 'public'},
                ${Number(p.sortOrder) || 100}, ${!!p.isCustom}, ${!!p.visLocked},
                ${JSON.stringify(p.rules || {})}::jsonb)
        on conflict (field) do update
          set label = excluded.label, visibility = excluded.visibility,
              sort_order = excluded.sort_order, rules = excluded.rules, updated_at = now()
      `;
    } catch (e) {}

    /* 解除墓碑：否则下次升级又按墓碑删 */
    try {
      await sql`
        update site_settings
           set data = jsonb_set(
                 data, '{deleted_fields}',
                 coalesce((
                   select jsonb_agg(v)
                     from jsonb_array_elements_text(coalesce(data->'deleted_fields', '[]'::jsonb)) v
                    where v <> ${p.field}
                 ), '[]'::jsonb),
                 true),
               updated_at = now()
         where id = 1
      `;
    } catch (e) {}
  }

  await sql`delete from deleted_items where id = ${id}`;
  await audit(me.id, 'data.undo_delete', 'deleted_item', String(id), it.kind + ':' + (it.label || ''));

  return ok(res, {
    restored: it.kind,
    label: it.label || '',
    message: '已撤回，字段「' + (it.label || '') + '」和它的数据都回来了',
  });
}

/* ============================================================================
 * v3.6.1：字段体检 + 一键恢复
 * ----------------------------------------------------------------------------
 * 站主原话：「字段管理之前的那些比如入团时间、发展团员编号那些你前几次更新的
 *           时候直接给我删了，我现在后台没有数据，看看能不能恢复。」
 *
 * 根因（这次查清楚了）：
 *   ① v3.5.14 给「删除字段」加了墓碑：删过的字段名记进 site_settings.data.deleted_fields；
 *   ② ensureSchema 每次版本升级都会跑一段「按墓碑删除 profile_field_meta」，
 *      防止预置种子把删掉的字段又插回来；
 *   ③ 于是只要墓碑里躺着一个字段，以后**每次升级**都会再删一次；
 *      如果墓碑里躺了一批系统字段，某次升级就会把整张字段表清空。
 *   而 deleteField 同时执行了 `alter table profiles drop column` ——
 *   列一没，值就跟着没了（PostgreSQL 的 drop column 不可撤销）。
 *
 * 本接口做两件事：
 *   · dryRun（默认）：报告「字段表有几行 / 墓碑里有谁 / 12 个预置列哪些还在、
 *     各有多少条有值」——先看清损失范围，再决定动不动手；
 *   · apply=true：清空墓碑 → 补建缺列 → 重插预置字段 → 恢复默认校验规则。
 *     列还在的，值会立刻回来；列已经没了的，只能靠数据库时间点恢复或重新导入
 *     （接口会在返回里明确列出「哪些列已经不存在」）。
 * ========================================================================= */
const PRESET_FIELDS = [
  ['name',            '姓名',        'public', 10],
  ['student_id',      '学号',        'public', 20],
  ['politics',        '政治面貌',    'public', 30],
  ['exam_no',         '智学网账号',  'public', 40],
  ['role',            '身份',        'public', 50],
  ['title',           '头衔',        'public', 60],
  ['wechat',          '微信',        'public', 70],
  ['qq',              'QQ',          'public', 80],
  ['phone',           '手机号',      'public', 90],
  ['id_card',         '身份证号',    'self',   100],
  ['youth_league_no', '发展团员编号', 'self',  110],
  ['school',          '学校',        'public', 120],
  ['class_name',      '班级',        'public', 130],
  ['ethnicity',       '民族',        'public', 140],
  ['birth_date',      '出生日期',    'self',   150],
  ['home_address',    '家庭住址',    'self',   160],
  ['league_date',     '入团时间',    'self',   170],
];
const PRESET_RULES = {
  name: '{"type":"text","maxLen":3}', school: '{"type":"text","maxLen":6}',
  politics: '{"type":"select","options":["群众","共青团员"]}', phone: '{"type":"number","digits":11}',
  id_card: '{"type":"text","maxLen":18}', youth_league_no: '{"type":"text","maxLen":40}',
  league_date: '{"type":"time"}', class_name: '{"type":"text","maxLen":8}',
  student_id: '{"type":"number","digits":6}',
  birth_date: '{"type":"time"}', home_address: '{"type":"text","maxLen":30}',
};

async function repairFields(req, res, me, b) {
  const sql = getSql();
  const apply = b && (b.apply === true || b.apply === 'true');

  /* ---- 体检 ---- */
  const metaRows = await sql`select field, label from profile_field_meta order by sort_order, field`;
  let tomb = [];
  try {
    const r = await sql`
      select coalesce(data->'deleted_fields', '[]'::jsonb) as d
        from site_settings where id = 1 limit 1
    `;
    const raw = r.length ? r[0].d : [];
    tomb = Array.isArray(raw) ? raw.map(String) : (typeof raw === 'string' ? JSON.parse(raw) : []);
  } catch (e) { tomb = []; }

  /* 现有列：select * 取第一行的键名（不依赖 information_schema，测试桩也能跑） */
  let colNames = [];
  try {
    const one = await sql`select * from profiles limit 1`;
    colNames = one.length ? Object.keys(one[0]) : [];
  } catch (e) { colNames = []; }

  const status = PRESET_FIELDS.map(([f, label]) => ({
    field: f, label,
    hasColumn: colNames.indexOf(f) >= 0,
    hasMeta: metaRows.some((m) => m.field === f),
  }));

  if (!apply) {
    return ok(res, {
      dryRun: true,
      metaCount: metaRows.length,
      tombstoned: tomb,
      columns: status,
      missingColumns: status.filter((x) => !x.hasColumn).map((x) => x.field),
      message: '这是体检结果，未做任何修改。确认要恢复请再调一次并带 apply=true',
    });
  }

  /* ---- 恢复 ---- */
  /* ① 清空墓碑：否则下次升级又会按墓碑删一遍 */
  try {
    await sql`update site_settings set data = data - 'deleted_fields', updated_at = now() where id = 1`;
  } catch (e) { console.warn('[admin] 清墓碑失败：', e.message); }

  /* ② 补建缺列（列还在时 add column if not exists 是空操作，值原样保留） */
  for (const [f] of PRESET_FIELDS) {
    const chk = isSafeFieldFormat(f);
    if (!chk.ok) continue;
    try { await sql(`alter table profiles add column if not exists ${chk.field} text`); } catch (e) {}
  }

  /* ②b 字段表自身的 self_edit 列（v3.5.40 加的）。老库可能因升级中断而缺列 ——
     缺了会让「字段管理」整张表读不出来（select 写死列名会报错）。 */
  try { await sql`alter table profile_field_meta add column if not exists self_edit boolean not null default false`; } catch (e) {}

  /* ③ 重插字段定义（已有的不动，保留你改过的可见性/标签）。
     一条多值 INSERT 搞定，别逐条来 —— Cloudflare Workers 单次 50 个子请求，
     17 条字段逐条插会把预算吃掉一大半。字段名/标签都是本文件里的常量，无注入风险。 */
  try {
    const vals = PRESET_FIELDS.map(([f, label, vis, ord]) =>
      `('${f}', '${label}', '${vis}', ${ord}, false)`).join(', ');
    await sql(
      'insert into profile_field_meta (field, label, visibility, sort_order, is_custom) values '
      + vals + ' on conflict (field) do nothing'
    );
  } catch (e) {
    console.warn('[admin] 批量重插字段失败，改为逐条：', e.message);
    for (const [f, label, vis, ord] of PRESET_FIELDS) {
      try {
        await sql`
          insert into profile_field_meta (field, label, visibility, sort_order, is_custom)
          values (${f}, ${label}, ${vis}, ${ord}, false)
          on conflict (field) do nothing
        `;
      } catch (e2) {}
    }
  }

  /* ④ 恢复默认校验规则（只补空的，不覆盖你改过的） */
  for (const f of Object.keys(PRESET_RULES)) {
    try {
      await sql`
        update profile_field_meta set rules = ${PRESET_RULES[f]}::jsonb
         where field = ${f} and rules = '{}'::jsonb
      `;
    } catch (e) {}
  }

  /* ⑤ 体检结果：每列还有多少条有值 —— 这就是「数据到底还在不在」的答案 */
  let counts = {};
  try {
    const cols = PRESET_FIELDS.map(([f]) => f).filter((f) => isSafeFieldFormat(f).ok);
    const expr = cols.map((c) => `sum(case when coalesce(${c},'') <> '' then 1 else 0 end) as ${c}`).join(', ');
    const r = await sql('select ' + expr + ' from profiles');
    counts = r[0] || {};
  } catch (e) { counts = {}; }

  const recovered = [];
  const stillEmpty = [];
  PRESET_FIELDS.forEach(([f, label]) => {
    const n = Number(counts[f] || 0);
    if (n > 0) recovered.push({ field: f, label, filled: n });
    else stillEmpty.push({ field: f, label, hasColumn: colNames.indexOf(f) >= 0 });
  });

  await audit(me.id, 'field.repair', 'profile_field', null,
    '恢复 ' + (metaRows.length === 0 ? '全部' : '缺失') + '预置字段；墓碑 ' + tomb.length + ' 项');

  return ok(res, {
    applied: true,
    metaCountBefore: metaRows.length,
    tombstonedBefore: tomb,
    recovered,                 /* 有值的字段 —— 数据回来了 */
    stillEmpty,                /* 仍然为空 —— 列还在但值没了 / 列被删了 */
    message: '已重建字段定义并清空墓碑。有值的字段：' + recovered.length + ' 个；'
      + (stillEmpty.length ? ('仍为空：' + stillEmpty.map((x) => x.label).join('、')) : '其余为空'),
  });
}

/**
 * 删除自定义资料字段。
 * body: { field }
 * 只允许删 is_custom = true 的字段；系统字段一律拒绝（删了会带崩代码）。
 * 先删 meta 行再删列：万一删列失败，至少前台不会再展示这个字段。
 */
async function deleteField(req, res, me, b) {
  const field = String(b.field || '').trim().toLowerCase();
  if (!field) return fail(res, 400, '缺少 field');

  const sql = getSql();
  const row = await readFieldRow(sql, field);
  if (!row) return fail(res, 404, '没有这个字段：' + field);
  /* v3.5.14 #7（站主要求「字段管理无法删除」）：系统预置字段也允许删，
     但「姓名 / 学号」是站点身份主键 —— 删了登录、成绩、导出全崩，
     属于结构性列，永远拒绝。其它预置字段（学校、班级、民族、入团日期等）
     传 force:true 才能删，前端配「手输字段名」的二次确认。 */
  /* title 是「头衔任命」功能直接读写的列；role 是身份列。
     删了页面会 500（站主刚踩到 column p.title does not exist），一并保护。 */
  const HARD_PROTECTED = ['name', 'student_id', 'title', 'role'];
  if (HARD_PROTECTED.includes(field)) {
    return fail(res, 400, '「' + (row.label || field) + '」是站点的结构性字段（姓名 / 学号 / 头衔 / 身份），代码直接依赖，删了会报错，不能删除');
  }
  if (!row.is_custom && b.force !== true) {
    return fail(res, 400, '「' + (row.label || field) + '」是系统预置字段，确认删除请传 force=true');
  }

  /* 先记墓碑：告诉 ensureSchema 的预置种子「这个字段是管理员主动删的，别再插回来」 */
  try {
    await sql`
      insert into site_settings (id, data, updated_at)
      values (1, ${JSON.stringify({ deleted_fields: [field] })}::jsonb, now())
      on conflict (id) do update
        set data = jsonb_set(
              site_settings.data,
              '{deleted_fields}',
              case
                when coalesce(site_settings.data->'deleted_fields', '[]'::jsonb) @> to_jsonb(${field}::text)
                  then coalesce(site_settings.data->'deleted_fields', '[]'::jsonb)
                else coalesce(site_settings.data->'deleted_fields', '[]'::jsonb) || to_jsonb(${field}::text)
              end,
              true),
            updated_at = now()
    `;
  } catch (e) { console.warn('[admin] 写字段墓碑失败：', e.message); }

  /* ============================================================================
   * v3.6.4（站主 #3）：改回「真删」，但删之前先把整列数据存进回收站
   * ----------------------------------------------------------------------------
   * 站主原话：「数据可以直接删除而不是隐藏，这样会出现更多的问题，
   *            在后端的操作记录里新增撤回的功能，现在删除数据倒计时 30 分钟，
   *            30 分钟以内在后台操作日志里点击撤回即可重新显示，否则真正删除数据」
   *
   * 顺序很重要：**先导快照，再删**。快照里存字段定义 + 该列所有非空值，
   * 30 分钟内点「撤回」能原样恢复（连列带值）；过期后由下一次删除顺手清掉。
   * ========================================================================= */
  let deletedId = 0;
  const chkCol = isSafeFieldFormat(field);
  if (chkCol.ok) {
    try {
      /* 兜底建表：老库升级中断时可能没这张表，缺了会让删除直接失败 */
      await sql`create table if not exists deleted_items (
        id          bigserial   primary key,
        kind        text        not null default 'field',
        label       text        default '',
        payload     jsonb       not null,
        bytes       int         not null default 0,
        deleted_by  bigint,
        deleted_at  timestamptz not null default now(),
        expires_at  timestamptz not null default now()
      )`;
      const rows = await sql(
        'select id, ' + chkCol.field + ' as v from profiles where coalesce(' + chkCol.field + ", '') <> ''"
      );
      const payload = {
        field, label: row.label || field, visibility: row.visibility,
        sortOrder: Number(row.sort_order) || 100, isCustom: !!row.is_custom,
        visLocked: !!row.vis_locked, rules: row.rules || {},
        rows: rows.map((r) => ({ id: Number(r.id), v: r.v })),
      };
      const bytes = JSON.stringify(payload).length;
      const expAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const ins = await sql`
        insert into deleted_items (kind, label, payload, bytes, deleted_by, expires_at)
        values ('field', ${row.label || field}, ${JSON.stringify(payload)}::jsonb, ${bytes}, ${me.id}, ${expAt})
        returning id
      `;
      deletedId = Number(ins[0].id);
    } catch (e) {
      /* 快照失败就不删 —— 宁可这次删不掉，也不能删了之后没得撤 */
      console.error('[admin] 字段快照失败，已中止删除：', field, e.message);
      return fail(res, 500, '备份该字段数据失败，已中止删除（数据未动）：' + String(e.message || e).slice(0, 120));
    }
  }

  await sql`delete from profile_field_meta where field = ${field}`;

  if (chkCol.ok) {
    try {
      await sql(`alter table profiles drop column if exists ${chkCol.field}`);
    } catch (e) {
      console.warn('[admin] 删列失败（meta 已删，前台不再展示）：', field, e.message);
    }
  }

  /* 顺手清理过期回收站记录（惰性清理，不跑定时任务） */
  try { await sql`delete from deleted_items where expires_at < now()`; } catch (e) {}

  await audit(me.id, 'field.delete', 'profile_field', field,
    'deletedId:' + deletedId + ' ' + (row.label || ''));
  return ok(res, {
    message: '已删除字段「' + (row.label || field) + '」'
      + (deletedId ? '；30 分钟内在「操作日志」里可撤回' : ''),
    field,
    deletedId,
    undoMinutes: 30,
  });
}

/**
 * v3.5.14 #7：字段拖拽排序。
 * body: { fields: ['name','student_id',...] } —— 按新顺序排列的字段名数组。
 * 一次 update ... from unnest 写完全部 sort_order，只算 1 次子请求。
 */
async function reorderFields(req, res, me, b) {
  const list = Array.isArray(b.fields) ? b.fields.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean) : [];
  if (!list.length) return fail(res, 400, '缺少 fields');
  if (list.length > 200) return fail(res, 400, '字段太多了');

  const sql = getSql();
  const rows = await sql`select field from profile_field_meta`;
  const exist = new Set(rows.map((r) => String(r.field)));
  const bad = list.filter((f) => !exist.has(f));
  if (bad.length) return fail(res, 400, '这些字段不存在：' + bad.join('、'));

  /* 只重排传进来的字段；没传的保持原 sort_order（排在后面） */
  const orders = list.map((_, i) => (i + 1) * 10);
  await sql`
    update profile_field_meta m
       set sort_order = v.ord
      from (select * from unnest(${list}::text[], ${orders}::int[]) as t(field, ord)) v
     where m.field = v.field
  `;
  await audit(me.id, 'field.reorder', 'profile_field_meta', '', list.join(','));
  return ok(res, { message: '排序已保存，共 ' + list.length + ' 个字段' });
}

/**
 * 修改字段的显示名 / 排序 / 可见性默认值。
 * body: { field, label?, sortOrder?, visibility? }
 * ⚠️ 字段名（列名）本身不可改 —— 改列名要动数据，风险远大于收益。
 *    想换名字就删了重建（自定义字段）或只改 label（系统字段）。
 */
async function updateField(req, res, me, b) {
  const field = String(b.field || '').trim().toLowerCase();
  if (!field) return fail(res, 400, '缺少 field');

  const sql = getSql();
  const row = await readFieldRow(sql, field);
  if (!row) return fail(res, 404, '没有这个字段：' + field);

  const label = b.label != null ? cText(b.label, 20) : null;
  if (b.label != null && !label) return fail(res, 400, '字段名称不能为空');

  let visibility = null;
  if (b.visibility != null) {
    const v = String(b.visibility).trim();
    if (!ALLOWED_VIS.includes(v)) return fail(res, 400, '可见性只能是 public / committee / self / admin');
    visibility = v;
  }

  let sortOrder = null;
  if (b.sortOrder != null) {
    const n = Number(b.sortOrder);
    if (!Number.isFinite(n)) return fail(res, 400, '排序值必须是数字');
    sortOrder = Math.max(0, Math.min(9999, Math.round(n)));
  }

  /* v3.5.5 校验规则：b.rules 存在（含 {} = 清除规则）才改，
     没传这个键就保持原样 —— 与 label/visibility 的「null 不改」语义一致。 */
  let rules = null;
  if (b.rules != null) {
    rules = normalizeRules(b.rules);
    if (rules.type === 'select' && !rules.options.length) {
      return fail(res, 400, '下拉字段至少要有一个选项');
    }
    if (rules.type === 'number' && rules.digits === 0
        && rules.min == null && rules.max == null) {
      return fail(res, 400, '数字字段请填固定位数或数值范围');
    }
  }

  if (label == null && visibility == null && sortOrder == null && rules == null) {
    return fail(res, 400, '没有要修改的内容');
  }

  /* visibility 一旦被站主改过就置 vis_locked = true（见 setVisibility 处的长注释）。
     只改 label / sort_order 时**不动**锁定标记 —— 那是排版类修改，
     不应该顺手把同学的隐私设置作废。 */
  const lockIt = visibility != null;

  await sql`
    update profile_field_meta
       set label      = ${label != null ? label : row.label},
           visibility = ${visibility != null ? visibility : row.visibility},
           sort_order = ${sortOrder != null ? sortOrder : row.sort_order},
           vis_locked = ${lockIt ? true : (row.vis_locked === true || row.vis_locked === 1)},
           rules      = case when ${rules != null}::boolean
                             then ${JSON.stringify(rules || {})}::jsonb
                             else rules end,
           updated_at = now()
     where field = ${field}
  `;

  await audit(me.id, 'field.update', 'profile_field', field,
    [label, visibility, sortOrder, rules != null ? 'rules:' + (rules.type || 'none') : null]
      .filter((x) => x != null).join('/'));
  return ok(res, {
    message: '已更新字段「' + (label || row.label || field) + '」'
      + (lockIt ? '（可见性已锁定：同学自己的设置不再生效）' : ''),
    field, adminSet: lockIt || !!row.is_custom, rules,
  });
}

/**
 * 整行解密（v3.5.0）。
 * 库里 profiles 的文本列都是密文，凡是要往外吐明文的读点都得先过一遍。
 * 明文/密文混存期 decField 对明文原样返回，所以无需判断。
 * key 为 null（未配 ADMIN_SECRETS_KEY）时直接原样返回，零开销。
 */
async function decProfileRow(key, row) {
  if (!key || !row || typeof row !== 'object') return row;
  const keys = Object.keys(row);
  const vals = await Promise.all(keys.map((k) => (
    typeof row[k] === 'string' ? decField(key, row[k]) : row[k]
  )));
  const out = {};
  for (let i = 0; i < keys.length; i++) out[keys[i]] = vals[i];
  return out;
}

/** 单条资料详情 */
async function profileDetail(req, res) {
  const id = Number(req.query.id || 0);
  if (!id) return fail(res, 400, '缺少 id');
  const sql = getSql();
  const rows = await sql`
    select p.*, u.username as bound_username
      from profiles p left join users u on u.id = p.user_id
     where p.id = ${id} limit 1
  `;
  if (!rows.length) return fail(res, 404, '资料不存在');
  /* v3.5.0：整行解密后再整形（管理员视图本就该看到明文） */
  const r = await decProfileRow(await profileKey(req), rows[0]);

  /* 顺带给出该资料的查看记录（最近 20 条），管理员点开就能看到谁查过 */
  let views = [];
  try {
    views = await sql`
      select v.created_at, v.keyword, v.ip, u.username as viewer
        from profile_view_log v
        left join users u on u.id = v.viewer_id
       where v.target_id = ${id}
       order by v.created_at desc
       limit 20
    `;
  } catch (e) { /* 表可能还没建，忽略 */ }

  return ok(res, {
    profile: {
      id: Number(r.id),
      name: r.name || '',
      studentId: r.student_id || '',
      politics: r.politics || '',
      examNo: r.exam_no || '',
      role: r.role || '学生',
      wechat: r.wechat || '',
      qq: r.qq || '',
      phone: r.phone || '',
      contactStatus: r.contact_status || 'none',
      rejectReason: r.reject_reason || '',
      userId: r.user_id ? Number(r.user_id) : null,
      boundUsername: r.bound_username || '',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      /* 本人可见性意愿（2026-10-08）：编辑弹窗里回显「仅自己可见」开关 */
      visibilityPref: safeJson(r.visibility_pref),
      /* 单人可见性例外（2026-10-09 v2.4.0）：管理员给这一条资料设的字段例外 */
      fieldVis: safeJson(r.field_vis),
      /* 可编辑字段（自定义 + id_card/youth_league_no）的当前值 */
      extra: await (async () => {
        const o = {};
        for (const f of await loadEditableFields()) {
          const v = r[f.field];
          if (v != null && v !== '') o[f.field] = String(v);
        }
        return o;
      })(),
      /* 字段元数据快照：让后台编辑弹窗知道每个字段的当前可见性上限 */
      fieldMeta: await loadFieldMeta(),
    },
    views: views.map((v) => ({
      viewer: v.viewer || '(已删除账号)',
      keyword: v.keyword || '',
      ip: v.ip || '',
      createdAt: v.created_at,
    })),
  });
}

/** 待审核列表（只返回 pending，后台「待审核」页用） */
/* ============================================================================
 * v3.7.0（站主 #1）：资料修改审批
 * ----------------------------------------------------------------------------
 * 站主原话：「所有允许学生自主修改的字段同之前微信QQ手机号的联系方式审核相同，
 *            需要后台确认方可成功更改，在后台确认之前均按照原来显示，而且后台的
 *            信息审核只包含修改人姓名和修改内容（原内容和现内容）其他没有改的地方
 *            无需显示，名称从联系方式审核改为信息审核，而且可以看到历史审核记录
 *            并后台可以撤销之前的确认（7 天之内）」
 *
 * 数据流：
 *   同学提交 → profile_change_requests(status=pending)，**profiles 不动**
 *            → 前台继续显示旧值（这就是「确认之前按原来显示」）
 *   后台通过 → 把 after 写进 profiles，status=approved，记下改动前的 contact_status
 *   后台驳回 → status=rejected + 原因（本人可见）
 *   7 天内撤销 → 把 before 写回 profiles，status=reverted
 *
 * 只显示「改了哪几项」：changes 里在提交时就已经把 old === new 的字段剔掉了，
 * 所以后台不会看到一堆没动的字段。
 * ========================================================================= */

const CHANGE_REVERT_DAYS = 7;

/** 把请求行 → 前端结构（解密 before/after，补上姓名学号） */
async function shapeChangeRows(sql, rows, pkey) {
  if (!rows.length) return [];
  /* 只取本次涉及的档案行。id 已 Number 过，拼进 SQL 无注入风险；
     不用 any(...) 是因为测试用的 SQLite 桥接不认这个语法。 */
  const ids = [...new Set(rows.map((r) => Number(r.profile_id)))].filter((n) => n > 0);
  let profs = [];
  if (ids.length) {
    try {
      profs = await sql(
        'select p.id, p.name, p.student_id, u.username '
        + 'from profiles p left join users u on u.id = p.user_id '
        + 'where p.id in (' + ids.join(',') + ')'
      );
    } catch (e) { profs = []; }
  }
  const pmap = {};
  for (const p of profs) pmap[Number(p.id)] = p;

  const out = [];
  for (const r of rows) {
    let arr = r.changes;
    if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { arr = []; } }
    const items = await Promise.all((Array.isArray(arr) ? arr : []).map(async (c) => ({
      field: c.field,
      label: c.label || c.field,
      before: await decField(pkey, c.before),
      after: await decField(pkey, c.after),
    })));
    const p = pmap[Number(r.profile_id)] || {};
    out.push({
      id: Number(r.id),
      profileId: Number(r.profile_id),
      /* 站主要求：信息审核只看「修改人姓名」+「修改内容」 */
      name: (await decField(pkey, p.name)) || '',
      studentId: (await decField(pkey, p.student_id)) || '',
      username: p.username || '',
      kind: r.kind || 'field',
      status: r.status || 'pending',
      note: r.note || '',
      items,
      createdAt: r.created_at,
      decidedAt: r.decided_at || null,
      revokedAt: r.revoked_at || null,
      canRevert: r.status === 'approved'
        && r.decided_at
        && (Date.now() - new Date(r.decided_at).getTime()) < CHANGE_REVERT_DAYS * 86400000,
      revertDaysLeft: r.status === 'approved' && r.decided_at
        ? Math.max(0, Math.ceil(CHANGE_REVERT_DAYS - (Date.now() - new Date(r.decided_at).getTime()) / 86400000))
        : 0,
    });
  }
  return out;
}

/** GET ?action=change-requests&scope=pending|history */
async function listChangeRequests(req, res) {
  const sql = getSql();
  const scope = String(req.query.scope || 'pending');
  const pkey = await profileKey(req);

  let rows = [];
  if (scope === 'history') {
    rows = await sql`
      select * from profile_change_requests
       where status <> 'pending'
       order by coalesce(decided_at, created_at) desc
       limit 100
    `;
  } else {
    rows = await sql`
      select * from profile_change_requests
       where status = 'pending'
       order by created_at asc
       limit 200
    `;
  }

  let counts = { pending: 0, approved: 0, rejected: 0, reverted: 0 };
  try {
    const c = await sql`
      select status, count(*)::int as n from profile_change_requests group by status
    `;
    c.forEach((r) => { if (r.status in counts) counts[r.status] = Number(r.n) || 0; });
  } catch (e) {}

  return ok(res, { scope, requests: await shapeChangeRows(sql, rows, pkey), counts });
}

/** POST ?action=approve-change { id } */
async function approveChange(req, res, me, b) {
  const id = Number((b && b.id) || 0);
  if (!id) return fail(res, 400, '缺少 id');
  const sql = getSql();
  const rows = await sql`select * from profile_change_requests where id = ${id} limit 1`;
  if (!rows.length) return fail(res, 404, '这条申请已经不存在了');
  const r = rows[0];
  if (r.status !== 'pending') return fail(res, 409, '这条申请已经处理过了（' + r.status + '）');

  let arr = r.changes;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { arr = []; } }

  const sets = [];
  const params = [];
  for (const c of (Array.isArray(arr) ? arr : [])) {
    const chk = isSafeFieldFormat(c.field);
    if (!chk.ok) continue;
    params.push(c.after);            /* 已是密文，原样写回 */
    sets.push(chk.field + ' = $' + params.length);
  }
  if (!sets.length) return fail(res, 400, '这条申请里没有可写入的字段');

  /* 联系方式审核通过 → 置 approved，之后前台才展示 */
  const isContact = r.kind === 'contact';
  let prevStatus = '';
  if (isContact) {
    const cur = await sql`select contact_status from profiles where id = ${r.profile_id} limit 1`;
    prevStatus = (cur[0] && cur[0].contact_status) || 'none';
    sets.push("contact_status = 'approved'");
    sets.push('reject_reason = null');
  }

  /* ⚠️ 这里 deliberately 不改 updated_at 之外的任何系统列：
     姓名/学号的盲索引不在 self-edit 允许范围内，所以不需要重算。 */
  params.push(r.profile_id);
  await sql(
    'update profiles set ' + sets.join(', ') + ', updated_at = now() where id = $' + params.length,
    params
  );

  await sql`
    update profile_change_requests
       set status = 'approved', decided_by = ${me.id}, decided_at = now(),
           applied_at = now(), note = '', meta = ${JSON.stringify({ prevStatus })}::jsonb
     where id = ${id}
  `;
  await audit(me.id, 'profile.change_approve', 'profile', String(r.profile_id), 'request:' + id);

  return ok(res, { message: '已通过，修改立即生效', requestId: id });
}

/** POST ?action=reject-change { id, reason } */
async function rejectChange(req, res, me, b) {
  const id = Number((b && b.id) || 0);
  if (!id) return fail(res, 400, '缺少 id');
  const reason = cText(b.reason, 200) || '管理员驳回';
  const sql = getSql();
  const rows = await sql`select profile_id, status from profile_change_requests where id = ${id} limit 1`;
  if (!rows.length) return fail(res, 404, '这条申请已经不存在了');
  if (rows[0].status !== 'pending') return fail(res, 409, '这条申请已经处理过了');

  /* 驳回只影响申请本身，库里的值一个字节都不动 */
  if (rows[0].profile_id) {
    try {
      await sql`update profiles set reject_reason = ${reason} where id = ${rows[0].profile_id}`;
    } catch (e) {}
  }
  await sql`
    update profile_change_requests
       set status = 'rejected', decided_by = ${me.id}, decided_at = now(), note = ${reason}
     where id = ${id}
  `;
  await audit(me.id, 'profile.change_reject', 'profile', String(rows[0].profile_id), 'request:' + id);
  return ok(res, { message: '已驳回，原内容保持不变', requestId: id });
}

/** POST ?action=revert-change { id } —— 7 天内撤销已通过的审批 */
async function revertChange(req, res, me, b) {
  const id = Number((b && b.id) || 0);
  if (!id) return fail(res, 400, '缺少 id');
  const sql = getSql();
  const rows = await sql`select * from profile_change_requests where id = ${id} limit 1`;
  if (!rows.length) return fail(res, 404, '这条记录已经不存在了');
  const r = rows[0];
  if (r.status !== 'approved') return fail(res, 409, '只有「已通过」的记录可以撤销');
  const decided = r.decided_at ? new Date(r.decided_at).getTime() : 0;
  if (!decided || Date.now() - decided > CHANGE_REVERT_DAYS * 86400000) {
    return fail(res, 410, '已超过 ' + CHANGE_REVERT_DAYS + ' 天，不能再撤销');
  }

  let arr = r.changes;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { arr = []; } }

  const sets = [];
  const params = [];
  for (const c of (Array.isArray(arr) ? arr : [])) {
    const chk = isSafeFieldFormat(c.field);
    if (!chk.ok) continue;
    params.push(c.before);           /* 写回原值（密文） */
    sets.push(chk.field + ' = $' + params.length);
  }
  if (!sets.length) return fail(res, 400, '这条记录里没有可还原的字段');

  if (r.kind === 'contact') {
    let meta = r.meta;
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch (e) { meta = {}; } }
    const prev = (meta && meta.prevStatus) || 'approved';
    /* 原来是什么状态就还原成什么状态；参数化避免拼接 */
    params.push(prev);
    sets.push('contact_status = $' + params.length);
  }

  params.push(r.profile_id);
  await sql(
    'update profiles set ' + sets.join(', ') + ', updated_at = now() where id = $' + params.length,
    params
  );

  await sql`
    update profile_change_requests
       set status = 'reverted', revoked_at = now()
     where id = ${id}
  `;
  await audit(me.id, 'profile.change_revert', 'profile', String(r.profile_id), 'request:' + id);

  return ok(res, { message: '已撤销，内容恢复到修改前', requestId: id });
}

async function profileRequests(req, res) {
  const sql = getSql();
  const raw = await sql`
    select p.id, p.name, p.student_id, p.politics, p.exam_no, p.wechat, p.qq, p.phone,
           p.contact_status, p.updated_at, u.username as bound_username
      from profiles p
      left join users u on u.id = p.user_id
     where p.contact_status = 'pending'
     order by p.updated_at desc
     limit 500
  `;
  /* v3.5.0：待审核的是联系方式（全被加密），必须先解密才能给管理员看 */
  const pkey = await profileKey(req);
  const rows = await Promise.all(raw.map((r) => decProfileRow(pkey, r)));
  return ok(res, {
    total: rows.length,
    requests: rows.map((r) => ({
      id: Number(r.id),
      name: r.name || '',
      studentId: r.student_id || '',
      politics: r.politics || '',
      examNo: r.exam_no || '',
      wechat: r.wechat || '',
      qq: r.qq || '',
      phone: r.phone || '',
      status: r.contact_status,
      boundUsername: r.bound_username || '',
      updatedAt: r.updated_at,
    })),
  });
}

/**
 * 审核联系方式。
 * body: { id, approve: true|false, reason?: '驳回原因' }
 * 通过 → approved（对外可见）；驳回 → rejected + 记下原因（本人可见）
 */
async function reviewContact(req, res, me, b) {
  const id = Number(b.id || 0);
  if (!id) return fail(res, 400, '缺少 id');
  const approve = b.approve !== false;
  const reason = cText(b.reason, 200);

  const sql = getSql();
  const rows = await sql`select id, name, student_id from profiles where id = ${id} limit 1`;
  if (!rows.length) return fail(res, 404, '资料不存在');

  await sql`
    update profiles
       set contact_status = ${approve ? 'approved' : 'rejected'},
           reject_reason  = ${approve ? null : (reason || '管理员驳回')},
           updated_at     = now()
     where id = ${id}
  `;

  const label = rows[0].name || rows[0].student_id || ('#' + id);
  /* 2026-10-08 修：原为 audit(sql, me, ...)，参数与签名
     audit(actorId, action, targetType, targetId, detail) 完全错位 →
     actor_id 被写成 sql 对象、action 被写成 me 对象，整条审计静默失败。 */
  await audit(me.id, approve ? 'profile.contact_approve' : 'profile.contact_reject', 'profile', String(id), label);

  return ok(res, {
    message: approve ? ('已通过 ' + label + ' 的联系方式') : ('已驳回 ' + label + ' 的联系方式'),
    status: approve ? 'approved' : 'rejected',
  });
}

/**
 * 新增或修改资料（管理员专用）。
 * body: { id?, name, studentId, politics, examNo?, role, wechat?, qq?, phone?,
 *         contactStatus?, visibilityPref? }
 * 带 id = 修改，不带 = 新增。
 */
/* v2.10.0（第六十轮 #172）：主体抽成 upsertProfileCore，
   供 save-profile 与「成员与档案」合并保存（save-member）共用。
   顺带落地「姓名单数据源」：profiles.name 是权威源，
   保存时同步 users.display_name，消除合并前两处各存一份、对不上的问题。 */
async function saveProfile(req, res, me, b) {
  const r = await upsertProfileCore(getSql(), me, b, req);
  if (!r.ok) return fail(res, r.code, r.error);
  return ok(res, { message: r.message, id: r.id });
}

/* ============================================================
   v2.10.0「成员与档案」合并保存（第六十轮 #172）
   ------------------------------------------------------------
   一个长表单同时提交账号段 + 档案段，按四种场景编排：
     ① userId + profileId   → 账号改角色/状态，档案走 upsertProfileCore
     ② 仅 profileId + createAccount
                            → 建号（不自动建空档案，避免一人两条），
                              再把这条档案绑到新账号
     ③ 仅 userId（暂无档案）→ 档案段有内容就补建一条并绑定该账号
     ④ 都没有 + createAccount
                            → 建号（自动建档案），再用档案段回填
   用户名对已有账号一律不可改（登录凭证，改了别人登录不上）；
   要换登录名只能删号重建。密码也不走本接口——单独走 reset-password。
   ============================================================ */
async function saveMember(req, res, me, b) {
  const sql = getSql();
  const userId = Number(b.userId || 0) || null;
  const profileId = Number(b.profileId || 0) || null;
  const wantAccount = !!b.createAccount;
  const notes = [];

  let finalUserId = userId;
  let finalProfileId = profileId;

  /* ---------- 账号段 ---------- */
  if (userId) {
    /* 角色 / 状态：传了才改，白名单与 set-role / set-status 一致 */
    if (b.role != null && b.role !== '') {
      if (!['user', 'admin'].includes(b.role)) {
        return fail(res, 400, 'role 只能是 user 或 admin');
      }
      if (userId === me.id && b.role !== 'admin') {
        return fail(res, 400, '不能取消自己的管理员身份');
      }
      const r = await sql`update users set role = ${b.role} where id = ${userId} returning username`;
      if (!r.length) return fail(res, 404, '用户不存在');
      notes.push('角色已更新');
    }
    if (b.status != null && b.status !== '') {
      if (!['active', 'banned', 'pending'].includes(b.status)) {
        return fail(res, 400, 'status 只能是 active / banned / pending');
      }
      if (userId === me.id) return fail(res, 400, '不能修改自己的账号状态');
      const r = await sql`update users set status = ${b.status} where id = ${userId} returning username`;
      if (!r.length) return fail(res, 404, '用户不存在');
      if (b.status !== 'active') await sql`delete from sessions where user_id = ${userId}`;
      notes.push('状态已更新');
    }
  } else if (wantAccount) {
    /* 建号。有档案要绑时 skipProfile：createUserCore 会自动补一条空档案，
       不跳过就会出现「一人两条」，必须由下面显式绑定。 */
    const r = await createUserCore(sql, me, {
      username: b.username,
      password: b.password,
      displayName: b.name || b.displayName || '',
      role: b.role,
      skipProfile: !!profileId,
    }, req);
    if (!r.ok) return fail(res, r.code, r.error);
    finalUserId = r.userId;
    notes.push('已开通账号 ' + r.username);

    if (profileId) {
      const cur = await sql`select user_id from profiles where id = ${profileId} limit 1`;
      if (!cur.length) return fail(res, 404, '档案不存在');
      if (cur[0].user_id != null && Number(cur[0].user_id) !== finalUserId) {
        return fail(res, 409, '这条档案已绑定其他账号，请先解绑再开通');
      }
      await sql`update profiles set user_id = ${finalUserId}, updated_at = now() where id = ${profileId}`;
      notes.push('档案已绑定到新账号');
    } else {
      /* 没传档案：建号时自动补的那条就是要回填的档案 */
      const np = await sql`select id from profiles where user_id = ${finalUserId} limit 1`;
      if (np.length) finalProfileId = Number(np[0].id);
    }
  } else if (profileId) {
    /* 只存档案、不开号——合法（通讯录里本来就有无账号的人，如外班朋友） */
  } else {
    return fail(res, 400, '没有可保存的对象：请填写档案信息，或勾选「开通账号」');
  }

  /* ---------- 档案段 ---------- */
  /* 档案段是否有实质内容（任一非空才算要存；全空 = 本次只改账号） */
  /* v3.5.22：头衔也算档案内容 —— 否则「只改头衔」会被判成空档案直接跳过保存 */
  const hasProfileData = ['name', 'studentId', 'politics', 'examNo', 'wechat', 'qq', 'phone', 'title']
    .some((k) => String(b[k] == null ? '' : b[k]).trim());

  if (finalProfileId) {
    if (hasProfileData) {
      const r = await upsertProfileCore(sql, me, Object.assign({}, b, { id: finalProfileId }), req);
      if (!r.ok) return fail(res, r.code, r.error);
      notes.push(r.message);
    }
  } else if (finalUserId && hasProfileData) {
    /* 有账号暂无档案：补建一条并绑定（userId 由 upsertProfileCore 写入） */
    const r = await upsertProfileCore(sql, me, Object.assign({}, b, { id: 0, userId: finalUserId }), req);
    if (!r.ok) return fail(res, r.code, r.error);
    finalProfileId = r.id;
    notes.push(r.message);
  }

  await audit(me.id, 'member.save', 'member',
    String(finalUserId || finalProfileId || ''), notes.join('；') || '无变更');

  return ok(res, {
    message: notes.length ? notes.join('；') : '已保存',
    userId: finalUserId,
    profileId: finalProfileId,
    notes,
  });
}

/**
 * 资料保存核心（不写 HTTP 响应）。
 * @returns {{ ok:true, id:number, message:string } | { ok:false, code:number, error:string }}
 * @param b.userId 新增时可选：直接把这条资料绑到某个账号（「有账号暂无档案」场景）
 * @param req      仅用于取环境变量里的 ADMIN_SECRETS_KEY（v3.5.0 字段加密）；
 *                 传 null 时退化为明文写入（测试桩 / 内部调用兼容）
 *
 * v3.5.0 字段加密改造要点（站主原话：「成员档案里的所有信息…全部也加密储存」）：
 *   ① 所有身份与联系方式字段「落库前」统一过 encField，库里只有密文。
 *   ② 学号唯一性不再用 `student_id = ?`（那列已经是密文，等值比不出来），
 *      改查盲索引列 student_id_bidx。
 *   ③ UPDATE 分支的「没传就保留原值」必须**先解密再加密回写**——
 *      否则会把库里的密文再封一层（enc 套 enc），越存越不可读。
 *   ④ users.display_name 仍写明文：前端按姓名比对、登录后顶部显示都靠它，
 *      它不在「档案敏感字段」范围内（站主要加密的是档案表）。
 *   ⑤ 没配密钥（pkey = null）时所有 encField 原样返回 —— 行为与改造前一致。
 */
async function upsertProfileCore(sql, me, b, req) {
  const pkey = await profileKey(req);
  const id = Number(b.id || 0);
  const name = cText(b.name, 30);
  const sid = cText(b.studentId, 20);
  const politics = cText(b.politics, 30);
  const examNo = cText(b.examNo, 24);
  /* v3.5.22：身份改为独立字段 identity（档案标签，如「学生 / 走读」），
     不再借用 b.role —— b.role 在 save-member 里是**账号角色**（user / admin）。
     老调用方（导入、补档案）没传 identity 时退回 b.role，保持兼容。 */
  const identity = cText(b.identity != null ? b.identity : b.role, 10) || '学生';
  const wechat = cContact(b.wechat);
  const qq = cContact(b.qq);
  const phone = cContact(b.phone);
  const stRaw = cText(b.contactStatus, 16);
  const st = ['none', 'pending', 'approved', 'rejected'].includes(stRaw) ? stRaw : null;

  /* v3.5.22：头衔（可多人，逗号分隔）。与 set-title 共用白名单 normTitles，
     并保持「管理员」永远在列表里（前端有专门的「管理员」徽章，不靠头衔）。
     只有显式传了 title 才动 —— 老调用方（批量导入 / 单人补档案）不传，不受影响。 */
  let titleList = null;
  if (b.title != null) {
    const nt = normTitles(b.title);
    if (nt.bad.length) {
      return { ok: false, code: 400, error: '头衔里有不认识的：' + nt.bad.join('、') };
    }
    /* 允许清空（站主在某人的表单里把头衔全取消）；不再强行塞「管理员」——
       历史数据里那几个自动加上的「管理员」由批量导入的老逻辑残留，
       在「头衔任命」里取消即可。 */
    titleList = nt.list.join(',');   /* 空列表 → 空字符串，等于清空 */
  }

  /* 可见性意愿（2026-10-08）：管理员可以替任何人设置 / 覆盖。
     ⚠️ 与前端约定一致：`true` = 同意公开，`false` = 仅本人可见。
        只有显式传了 visibilityPref 才写库，没传就不动（避免误清空）。 */
  let prefJson = null;
  if (b.visibilityPref && typeof b.visibilityPref === 'object') {
    const clean = {};
    for (const k of ['wechat', 'qq', 'phone']) {
      if (k in b.visibilityPref) clean[k] = !!b.visibilityPref[k];
    }
    prefJson = JSON.stringify(clean);
  }

  /* 单人可见性例外（2026-10-09 v2.4.0）：管理员给这一条资料设的字段例外。
     ⚠️ 与 visibilityPref 的区别：这个是**管理员**设的，可以放宽也可以收窄；
        visibilityPref 是本人设的，只能收窄。

     🔴 v2.4.1 修复：白名单**不能**用 loadEditableFields()（它滤掉了
        SPECIAL_FIELDS，而 wechat/qq/phone 正在其中）—— 那会导致站主在
        编辑弹窗里给某人的微信设例外时，值被静默丢弃、完全没生效。
        例外本来就该覆盖**任何**在字段管理里出现过的字段，所以用 loadFieldMeta()。 */
  const allMeta = await loadFieldMeta();
  const fieldVisJson = buildFieldVis(b.fieldVis, allMeta.map((f) => f.field));

  /* 可自定义取值的字段（用于 extra 的键白名单）。 */
  const editable = await loadEditableFields();

  /* 自定义字段的值：只接受 meta 表登记过的键，避免前端乱传键名。
     值统一按「短文本」处理（<200 字），空字符串表示「清空该字段」。 */
  const customVals = {};
  if (b.extra && typeof b.extra === 'object') {
    for (const f of editable) {
      if (f.field in b.extra) {
        /* v3.5.15：按字段规则把值规整成入库形态 —— 时间类且「精确到月」的字段，
           填 2024/5/13 或 2024年5月 都统一存成 2024-05，前端校验只管放行。 */
        customVals[f.field] = coerceValueByRules(f.rules, pickCustomValue(b.extra[f.field]));
      }
    }
  }

  /* v3.5.5 字段校验（服务端唯一裁判）：特殊字段（姓名/学号/政治面貌/
     手机号…有预设规则的）+ 自定义字段一起校。空值一律放过。
     ⚠️ grandfather 条款（UPDATE）：与库中现值一致的字段跳过校验 ——
        老资料可能是旧规则下录的（4 字姓名、7 位学号、带 +86 的手机号），
        不能因为规则升级把「只改别的字段」的管理员挡死。主动改值才守新规则；
        新增（INSERT）全部校验。 */
  const ruleVals = {
    name, student_id: sid, politics, exam_no: examNo,
    wechat, qq, phone,
    ...customVals,
  };
  if (id) {
    const curRow = (await sql`select * from profiles where id = ${id} limit 1`)[0];
    if (!curRow) return { ok: false, code: 404, error: '资料不存在' };
    for (const k of ['name', 'student_id', 'politics', 'exam_no', 'wechat', 'qq', 'phone']) {
      const stored = await decField(pkey, curRow[k]);
      if (ruleVals[k] && ruleVals[k] === String(stored == null ? '' : stored)) delete ruleVals[k];
    }
  }
  const ruleChk = validateProfileFields(ruleVals, allMeta);
  if (!ruleChk.ok) return { ok: false, code: 400, error: ruleChk.error };

  if (!name && !sid) return { ok: false, code: 400, error: '姓名与学号至少填一项' };

  /* 学号唯一性检查：同一个学号不能挂两条资料。
     v3.5.0：列里存的是密文，等值比较没意义（同一学号每次加密的 IV 不同，
     密文永远不相等），必须用盲索引列 student_id_bidx。
     · 配了密钥 → 查 bidx（老数据还没生成 bidx 的，靠下面的明文兜底查不到，
       但那种数据本来也没被保存过，属可接受的迁移期空窗）；
     · 没配密钥 → 保持原来的明文等值查。 */
  if (sid) {
    const dup = pkey
      ? await sql`select id from profiles where student_id_bidx = ${await blindIndex(pkey, sid)} limit 1`
      : await sql`select id from profiles where student_id = ${sid} limit 1`;
    if (dup.length && Number(dup[0].id) !== id) {
      return { ok: false, code: 409, error: '学号 ' + sid + ' 已被另一条资料占用' };
    }
  }

  /* ---- 动态拼 UPDATE 的列（2026-10-09 v2.4.0） ----
     固定列用参数化；自定义列的**列名**来自 meta 表（当初过了白名单），
     拼之前再用 checkFieldName 复核一次，值仍然走参数化。

     v3.5.0：固定列多了两个盲索引列（name_bidx / student_id_bidx），
     所以列顺序变成 name, student_id, name_bidx, student_id_bidx, politics, …
     —— 下面 params 的顺序必须严格跟着走，错一位就会把密文写进错误的列。 */
  const sets = [
    'name = $1', 'student_id = $2', 'name_bidx = $3', 'student_id_bidx = $4',
    'politics = $5', 'exam_no = $6', 'role = $7',
    'wechat = $8', 'qq = $9', 'phone = $10', 'contact_status = $11',
  ];
  const BASE_N = 11;   /* sets 里固定占用的参数个数，后面 push 从这个数继续编号 */

  if (id) {
    /* 修改：只更新传了的字段，避免把没传的字段清空 */
    const cur = await sql`select * from profiles where id = ${id} limit 1`;
    if (!cur.length) return { ok: false, code: 404, error: '资料不存在' };
    const c = cur[0];

    /* 🔴 v3.5.0 关键点：`name || c.name` 这种「没传就保留原值」的写法，
       在加密后必须先把 c.xxx **解出明文**再重新加密。直接回写 c.xxx
       （密文）会被 encField 再封一层，变成 enc:v1:<上面还套着 enc:v1:…>，
       存两次就再也解不回来了（解密只剥一层）。 */
    /* 占位符（【解密失败】/【已加密但未配密钥】）绝不能当成用户输入写回库 ——
       那会把原来的密文覆盖掉，数据就永久丢了。见到它一律视为「没改」。 */
    const keep = async (incoming, stored) =>
      (incoming !== '' && incoming != null && !isUndecryptable(incoming))
        ? incoming
        : await decField(pkey, stored);

    const plainName = await keep(name, c.name);
    const plainSid = await keep(sid, c.student_id);
    const plainPolitics = await keep(politics, c.politics);
    const plainExamNo = await keep(examNo, c.exam_no);

    const params = [
      await encField(pkey, plainName),
      await encField(pkey, plainSid),
      await blindIndex(pkey, plainName),
      await blindIndex(pkey, plainSid),
      await encField(pkey, plainPolitics),
      await encField(pkey, plainExamNo),
      identity || c.role,
      await encField(pkey, await keep(wechat, c.wechat)),
      await encField(pkey, await keep(qq, c.qq)),
      await encField(pkey, await keep(phone, c.phone)),
      st || c.contact_status,
    ];

    /* 可见性意愿：只在传了新值时覆盖；否则保留本人自己设的 */
    if (prefJson != null) {
      params.push(prefJson);
      sets.push('visibility_pref = $' + params.length);
    }
    /* 单人例外：传了 fieldVis（哪怕是 {}）就覆盖，方便管理员清空 */
    if (b.fieldVis && typeof b.fieldVis === 'object') {
      params.push(fieldVisJson);
      sets.push('field_vis = $' + params.length);
    }

    /* v3.5.22：头衔（固定列，单独处理） */
    if (titleList != null) {
      params.push(titleList);
      sets.push('title = $' + params.length);
    }

    /* 自定义字段：传了的才写 */
    for (const f of editable) {
      if (!(f.field in customVals)) continue;
      /* ⚠️ 这里用 isSafeFieldFormat 而不是 checkFieldName：
         后者含「禁止撞系统列名」的黑名单，而 id_card / youth_league_no
         本身就是系统列 —— 用 checkFieldName 会把它们自己挡掉，
         表现为「保存返回成功但值没写进去」。 */
      const chk = isSafeFieldFormat(f.field);
      if (!chk.ok) continue;   /* 历史脏字段直接跳过，不让它把整个保存搞挂 */
      /* 同理：解不出来的占位符不写回，直接跳过这一列（库里保留原值） */
      if (isUndecryptable(customVals[f.field])) continue;
      params.push(await encField(pkey, customVals[f.field]));
      sets.push(chk.field + ' = $' + params.length);
    }

    params.push(id);
    await sql(
      'update profiles set ' + sets.join(', ') + ', updated_at = now() where id = $' + params.length,
      params
    );

    /* 姓名单数据源（v2.10.0）：profiles.name 是权威源。
       档案挂了账号就把 users.display_name 同步成最新姓名，
       消除「成员与档案」合并前两处各存一份、改一处另一处对不上的问题。
       只同步非空姓名；display_name 为空（纯账号无姓名）时不动它。 */
    if (name && c.user_id) {
      await sql`update users set display_name = ${name} where id = ${c.user_id}`;
    }

    await audit(me.id, 'profile.update', 'profile', String(id), name || sid);
    return { ok: true, id, message: '已保存' };
  }

  /* ---- 新增 ----
     v3.5.0：列里一律写密文，另外补写两个盲索引列（搜索 / 学号去重靠它）。 */
  const encName = await encField(pkey, name || null);
  const encSid = await encField(pkey, sid || null);
  const insCols = ['name', 'student_id', 'name_bidx', 'student_id_bidx',
    'politics', 'exam_no', 'role', 'wechat', 'qq', 'phone', 'contact_status'];
  const insVals = [
    encName, encSid,
    await blindIndex(pkey, name || null), await blindIndex(pkey, sid || null),
    await encField(pkey, politics || null), await encField(pkey, examNo || null), identity,
    await encField(pkey, wechat || null), await encField(pkey, qq || null),
    await encField(pkey, phone || null),
    st || (wechat || qq || phone ? 'approved' : 'none'),
  ];
  /* v3.5.22：新建时也能带头衔 */
  if (titleList != null) {
    insCols.push('title');
    insVals.push(titleList);
  }
  const insParams = insCols.map((_, i) => '$' + (i + 1));

  /* 🔴 v2.4.1 修复：新增时也要写 visibility_pref。
     原来 prefJson 只在 UPDATE 分支被用到，INSERT 分支完全没带这一列 ——
     于是站主在前台/后台给同学设「微信仅自己可见」后**新建资料**，
     这份意愿会被静默丢弃，读回来永远是 {}。表现就是「我明明勾了，他不生效」。
     与 fieldVis 一样，只在显式传了对象时才带（null 表示不写，用列默认值）。 */
  if (prefJson != null) {
    insCols.push('visibility_pref');
    insVals.push(prefJson);
    insParams.push('$' + insVals.length);
  }

  if (b.fieldVis && typeof b.fieldVis === 'object') {
    insCols.push('field_vis');
    insVals.push(fieldVisJson);
    insParams.push('$' + insVals.length);
  }
  /* 新增时绑定账号（v2.10.0「有账号暂无档案」场景：合并页补建档案）。
     只在显式传了 userId 时写；顺带把账号显示名同步成档案姓名。 */
  const bindUserId = Number(b.userId || 0) || null;
  if (bindUserId) {
    insCols.push('user_id');
    insVals.push(bindUserId);
    insParams.push('$' + insVals.length);
  }
  for (const f of editable) {
    if (!(f.field in customVals)) continue;
    const chk = isSafeFieldFormat(f.field);   /* 同上：不能挡系统列 */
    if (!chk.ok) continue;
    insCols.push(chk.field);
    insVals.push(await encField(pkey, customVals[f.field]));
    insParams.push('$' + insVals.length);
  }

  const ins = await sql(
    'insert into profiles (' + insCols.join(', ') + ') values (' + insParams.join(', ') + ') returning id',
    insVals
  );
  const newId = Number(ins[0].id);
  if (bindUserId && name) {
    await sql`update users set display_name = ${name} where id = ${bindUserId}`;
  }
  await audit(me.id, 'profile.create', 'profile', String(newId), name || sid);
  return { ok: true, id: newId, message: '已新增' };
}

/** 删除一条资料 */
async function deleteProfile(req, res, me, b) {
  const id = Number(b.id || 0);
  if (!id) return fail(res, 400, '缺少 id');
  const sql = getSql();
  const rows = await sql`select name, student_id from profiles where id = ${id} limit 1`;
  if (!rows.length) return fail(res, 404, '资料不存在');
  await sql`delete from profiles where id = ${id}`;
  await audit(me.id, 'profile.delete', 'profile', String(id), rows[0].name || rows[0].student_id || '');
  return ok(res, { message: '已删除' });
}

/**
 * 批量导入资料。
 * body: { rows: [{ name, studentId, politics, examNo?, role, wechat?, qq?, phone?,
 *                  extra?: { [字段名]: 值 } }, ...] }
 * 按学号或姓名判断是新增还是更新（有就更新，没有就插入）。
 * 单批上限与用户批量导入保持一致（60 条），由前端分片调用。
 * 逐条返回错误与行号，方便对照 Excel 修数据。
 *
 * v2.4.0（2026-10-09）：支持 extra —— Excel 表头里的自定义 / 额外字段。
 * 后端按 profile_field_meta 登记过的字段名收，其余键一律忽略（防脏数据）。
 */
/**
 * v3.5.18：应用「字段冲突」的选择。
 * ------------------------------------------------------------
 * 站主原话：「如果 C 的数据库有而且与这次导入的数据不一样，那么由我手动决定
 * 使用哪一份，另外一份直接删除」—— 导入时冲突字段一律不写，把新旧值一起返回。
 * 这个接口接收站主勾了「用导入值」的那些字段，逐个覆盖写库；没勾的保持原值
 * （等价于「另一份直接删除」）。
 *
 * body: { items: [{ id, field, value }] }
 * ⚠️ 每批最多 20 条：一条一次 UPDATE，Workers 免费版单次 50 子请求。
 */
async function resolveFieldConflicts(req, res, me, b) {
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return fail(res, 400, '没有要应用的修改');
  if (items.length > 20) return fail(res, 400, '单批最多 20 条');

  const sql = getSql();
  const pkey = await profileKey(req);
  const meta = await loadFieldMeta();
  const allow = new Set(meta.map((f) => f.field));
  /* 系统列里允许覆盖的（role / title 不在 meta 的情况兜底） */
  ['role', 'title', 'id_card', 'youth_league_no'].forEach((f) => allow.add(f));

  let applied = 0;
  const errors = [];

  for (const it of items) {
    const id = Number(it && it.id || 0);
    const field = String(it && it.field || '').trim().toLowerCase();
    const val = String(it && it.value == null ? '' : it.value).trim().slice(0, 200);
    if (!id || !field) { errors.push({ field, reason: '缺少 id 或 field' }); continue; }
    if (!allow.has(field) || !isSafeFieldFormat(field).ok) {
      errors.push({ field, reason: '字段不允许这样改' });
      continue;
    }
    try {
      const ev = await encField(pkey, val);
      if (field === 'name') {
        await sql`update profiles set name = ${ev}, name_bidx = ${await blindIndex(pkey, val)}, updated_at = now() where id = ${id}`;
      } else if (field === 'student_id') {
        await sql`update profiles set student_id = ${ev}, student_id_bidx = ${await blindIndex(pkey, val)}, updated_at = now() where id = ${id}`;
      } else {
        /* 列名来自白名单 + 格式校验，值参数化 */
        await sql('update profiles set ' + field + ' = $1, updated_at = now() where id = $2', [ev, id]);
      }
      applied++;
    } catch (e) {
      errors.push({ field, reason: String(e.message || e).slice(0, 120) });
    }
  }

  if (applied) await audit(me.id, 'profile.conflict', 'profile', '', '按导入值覆盖 ' + applied + ' 个字段');
  return ok(res, { applied, failed: errors.length, errors });
}

async function batchProfiles(req, res, me, b) {
  const list = Array.isArray(b.rows) ? b.rows : [];
  if (!list.length) return ok(res, { created: 0, updated: 0, unchanged: 0, failed: 0, errors: [], conflicts: [] });
  /* 🔴 v3.5.18：Cloudflare Workers 免费版单次调用最多 50 个子请求。
     以前一批 60 条 × 每行 3 次查询 = 180+，跑到第 24 行就
     「Too many subrequests by single Worker invocation」，后面全废。
     现在一批最多 12 条（前端也改成 8 条一批），每行压到 2 次查询 + 1 次写。 */
  if (list.length > 12) {
    return fail(res, 400,
      '单批最多 12 条（当前 ' + list.length + ' 条）。'
      + '如果你是在「批量导入资料」里看到这条，说明后台页面还是旧版本 —— '
      + '按 Ctrl+F5（手机：下拉刷新）强制刷新后再导一次即可，新版本会自动 8 条一批。');
  }

  const sql = getSql();
  let created = 0, updated = 0, unchanged = 0;
  const errors = [];
  /* v3.5.18：字段级冲突（库里已有值 ≠ 导入值）—— 不静默覆盖，
     收集起来交回前端让站主决定用哪一份。 */
  const conflicts = [];

  /* 自定义 / 额外字段（2026-10-09 v2.4.0）：Excel 导入的表头里可能有站主自己加的字段，
     前端会按中文表头识别出来塞进 raw.extra。这里先把可写字段名单拉一份，
     循环里逐条拼进 SQL —— 否则导入进来这些值会被静默丢掉（只写固定的 8 列）。
     v3.5.5：改成拉全量 meta（editable 从它过滤）—— 逐行规则校验要用到
     特殊字段（姓名/学号/手机号…）的规则，loadEditableFields 把它们滤掉了。 */
  const allMeta = await loadFieldMeta();
  const editable = allMeta.filter((f) => !SPECIAL_FIELDS.includes(f.field));
  /* v3.5.0：导入同样是「落库」，全部字段照样加密；查找已存在记录改走盲索引。 */
  const pkey = await profileKey(req);

  for (let i = 0; i < list.length; i++) {
    const raw = list[i] || {};
    try {
      const name = cText(raw.name, 30);
      const sid = cText(raw.studentId, 20);
      const politics = cText(raw.politics, 30);
      const examNo = cText(raw.examNo, 24);
      const roleIn = cText(raw.role, 10);          /* Excel 里显式给了才动 */
      const role = roleIn || '学生';
      const wechat = cContact(raw.wechat);
      const qq = cContact(raw.qq);
      const phone = cContact(raw.phone);
      /* v3.5.3：身份证号/发展团员编号本就是 profiles 内置列（单条编辑一直支持），
         批量导入却始终不认——站长的模板里一直有这两列，数据被静默丢弃。这次补上。 */
      const idCard = cText(raw.idCard, 30);
      const youthLeagueNo = cText(raw.youthLeagueNo, 40);

      /* 该行实际带了的自定义字段值（键必须是 meta 表登记过的） */
      const ex = {};
      if (raw.extra && typeof raw.extra === 'object') {
        for (const f of editable) {
          if (f.field in raw.extra) {
            /* v3.5.15：时间字段按后台配的精度规整（月精度存 2024-05） */
            ex[f.field] = coerceValueByRules(f.rules, pickCustomValue(raw.extra[f.field]));
          }
        }
      }
      /* 复核列名安全性：列名无法参数化，必须白名单兜住。
         用 isSafeFieldFormat（不查重名），因为 id_card 等本身就是系统列。
         🔴 v3.5.16 修复：id_card / youth_league_no 既是系统列、又在
         loadEditableFields() 返回的「可编辑字段」里，前端会**同时**按固定列
         （raw.idCard）和自定义字段（raw.extra.id_card）传两遍 —— 于是拼接的
         UPDATE 里出现 `id_card = $n, id_card = $m`，PG 直接报
         `multiple assignments to same column "id_card"`，整批 61 行全废。
         这里把「本函数已按固定列处理过的」列排除，保证每列只写一次。 */
      const FIXED_COLS_WRITTEN = ['name', 'student_id', 'name_bidx', 'student_id_bidx',
        'politics', 'exam_no', 'role', 'wechat', 'qq', 'phone', 'contact_status',
        'id_card', 'youth_league_no'];
      const exCols = Object.keys(ex).filter((k) => isSafeFieldFormat(k).ok && !FIXED_COLS_WRITTEN.includes(k));

      if (!name && !sid) {
        errors.push({ index: i, name, studentId: sid, reason: '姓名与学号都为空' });
        continue;
      }

      /* v3.5.5 字段校验：逐行按规则校，非法行记错误跳过（不中断整批）——
         与既有逐行错误模式一致，站主对着行号改 Excel 再重导。 */
      const ruleChk = validateProfileFields({
        name, student_id: sid, politics, exam_no: examNo,
        wechat, qq, phone, id_card: idCard, youth_league_no: youthLeagueNo,
        ...ex,
      }, allMeta);
      if (!ruleChk.ok) {
        errors.push({ index: i, name, studentId: sid, reason: ruleChk.error });
        continue;
      }

      /* ---- 查找已有记录 ----
         v3.5.18：改成 select * 一次拿全（以前只取 id，比较现值还得再查一次），
         每行子请求从 3 次压到 2 次 —— 配合更小的批，绕开 Workers 的 50 次上限。 */
      const sidBidx = await blindIndex(pkey, sid || null);
      const nameBidx = await blindIndex(pkey, name || null);
      let hit = [];
      if (sid) {
        hit = pkey
          ? await sql`select * from profiles where student_id_bidx = ${sidBidx} limit 1`
          : await sql`select * from profiles where student_id = ${sid} limit 1`;
      }
      if (!hit.length && name) {
        hit = pkey
          ? await sql`select * from profiles where name_bidx = ${nameBidx} limit 1`
          : await sql`select * from profiles where name = ${name} limit 1`;
      }

      /* 加密后的值（每行算一次，UPDATE / INSERT 两处复用） */
      const eName = await encField(pkey, name || null);
      const eSid = await encField(pkey, sid || null);
      const ePolitics = await encField(pkey, politics || null);
      const eExamNo = await encField(pkey, examNo || null);
      const eWechat = await encField(pkey, wechat || null);
      const eQq = await encField(pkey, qq || null);
      const ePhone = await encField(pkey, phone || null);
      const eIdCard = await encField(pkey, idCard || null);
      const eYln = await encField(pkey, youthLeagueNo || null);
      const cst = (wechat || qq || phone) ? 'approved' : 'none';

      const labelMap = {};
      allMeta.forEach((f) => { labelMap[f.field] = f.label || f.field; });

      if (hit.length) {
        const pid = Number(hit[0].id);
        const cur = hit[0];
        const params = [];
        const sets = [];

        /* 逐字段三态（站主 v3.5.18 要求）：
             库里没有值        → 直接写入
             库里值 == 导入值  → 跳过（不重复写，省子请求）
             库里值 != 导入值  → 冲突，这一列先不写，交回前端让站主选 */
        const cand = [
          ['name', '姓名', name, eName],
          ['student_id', '学号', sid, eSid],
          ['politics', '政治面貌', politics, ePolitics],
          ['exam_no', '智学网账号', examNo, eExamNo],
          ['wechat', '微信', wechat, eWechat],
          ['qq', 'QQ', qq, eQq],
          ['phone', '手机号', phone, ePhone],
          ['id_card', '身份证号', idCard, eIdCard],
          ['youth_league_no', '团员编号', youthLeagueNo, eYln],
        ];
        exCols.forEach((c) => { cand.push([c, labelMap[c] || c, ex[c], null]); });

        for (const item of cand) {
          const col = item[0], lb = item[1], nv = item[2];
          if (nv == null || String(nv).trim() === '') continue;   /* 导入没填 → 不动 */
          let ovRaw = null;
          try { ovRaw = await decField(pkey, cur[col]); } catch (e) { ovRaw = null; }
          const ov = String(ovRaw == null ? '' : ovRaw).trim();
          const nvs = String(nv).trim();
          if (ov === nvs) continue;                                /* 完全一致 → 跳过 */
          if (!ov) {                                               /* 库里空 → 直接写 */
            params.push(item[3] != null ? item[3] : await encField(pkey, nvs));
            sets.push(col + ' = $' + params.length);
            continue;
          }
          conflicts.push({
            index: i, id: pid, name, field: col, label: lb,
            /* 完整值回传（供站主判断），前端展示时自己截断 */
            oldValue: ov.slice(0, 200), newValue: nvs.slice(0, 200),
          });
        }

        /* role 只在 Excel 显式给了才改，避免把班干/老师刷回「学生」 */
        if (roleIn && roleIn !== String(cur.role || '')) {
          params.push(roleIn);
          sets.push('role = $' + params.length);
        }
        /* 联系方式状态跟着联系方式走；没写联系方式就不动 */
        const touchedContact = sets.some((x) => /^(wechat|qq|phone)\s*=/.test(x));
        if (touchedContact) {
          params.push(cst);
          sets.push('contact_status = $' + params.length);
        }

        if (!sets.length) { unchanged++; continue; }   /* 全部一致 = 无需更新 */

        params.push(pid);
        /* 双保险：同一列只保留最后一次赋值，避免 multiple assignments */
        const seenCol = new Set(), finalSets = [];
        for (let si = sets.length - 1; si >= 0; si--) {
          const col = sets[si].split('=')[0].trim();
          if (seenCol.has(col)) continue;
          seenCol.add(col);
          finalSets.unshift(sets[si]);
        }
        await sql(
          'update profiles set ' + finalSets.join(', ') + ', updated_at = now() where id = $' + params.length,
          params
        );
        updated++;
      } else {
        /* 双保险：即便 exCols 里混进重复列名，INSERT 也不能出现同名列 */
        const cols = Array.from(new Set(['name', 'student_id', 'name_bidx', 'student_id_bidx',
          'politics', 'exam_no', 'role', 'wechat', 'qq', 'phone', 'contact_status',
          'id_card', 'youth_league_no', ...exCols]));
        const params = [
          eName, eSid, nameBidx, sidBidx, ePolitics, eExamNo, (roleIn || '学生'),
          eWechat, eQq, ePhone, cst, eIdCard, eYln,
        ];
        for (const col of exCols) params.push(await encField(pkey, ex[col]));
        const ph = params.map((_, k) => '$' + (k + 1)).join(', ');
        await sql(
          'insert into profiles (' + cols.join(', ') + ') values (' + ph + ')',
          params
        );
        created++;
      }
    } catch (e) {
      errors.push({
        index: i,
        name: cText(raw.name, 30),
        studentId: cText(raw.studentId, 20),
        reason: String(e.message || e).slice(0, 120),
      });
    }
  }

  if (created || updated) {
    await audit(me.id, 'profile.batch', 'profile', '', '新增 ' + created + ' / 更新 ' + updated);
  }

  return ok(res, {
    created, updated, unchanged,
    failed: errors.length, errors,
    conflicts: conflicts.slice(0, 300),   /* 再多前端也看不过来 */
    conflictTotal: conflicts.length,
  });
}

/* ============================================================
   v3.5.1 存量资料一键加密（站主要求）
   ------------------------------------------------------------
   背景：v3.5.0 上了档案加密，但存量资料是「谁保存过谁转密文」——
   全班 50 多人一条条点开保存不现实，站主原话「我不可能重新再导一次，量太多了」。

   做法：扫一遍 profiles，凡**还是明文**的字段就地加密，同时补 bidx；
   已经是密文的跳过（幂等，随便重跑，不会叠层）。

   ⚠️ 为什么必须分批（limit 15）：Workers 免费版单个请求最多 50 个子请求，
      一行资料的 UPDATE 算一次。60 人一次跑完会直接 500，所以由前端循环调，
      每次传 offset，直到 remaining = 0。

   ⚠️ 只加密「有值的字段」：空值不碰（密文化一个 NULL 毫无意义，
      还会把 name_bidx 写成垃圾）。bidx 只在姓名/学号有明文时才需要重算。
   ============================================================ */
async function encryptProfiles(req, res, me, b) {
  const pkey = await profileKey(req);
  if (!pkey) {
    return fail(res, 400,
      '尚未配置 ADMIN_SECRETS_KEY，无法加密。请先在 Cloudflare Workers 里配上这个环境变量'
      + '（值用 openssl rand -base64 32 生成），再回来点这个按钮。');
  }
  const sql = getSql();
  /* ⚠️ 没有 offset 参数：每批都是重新查「还有明文字段」的行 ——
     加密后它们就不再匹配 where，天然就是下一批。传 offset 反而会跳过数据。 */
  const limit = Math.min(Math.max(Number(b.limit || 15), 1), 20);

  /* 待处理总数：还没加密的资料条数（姓名仍是明文）。
     name 为 NULL 的老资料（纯账号补出来的空档案）不算待处理 —— 没内容可加密。 */
  const totalRows = await sql`
    select
      count(*)::int as all_n,
      count(*) filter (where name is not null and name <> '' and name not like 'enc:v1:%')::int as plain_n
      from profiles
  `;
  const allN = totalRows[0] ? Number(totalRows[0].all_n) : 0;
  const plainN = totalRows[0] ? Number(totalRows[0].plain_n) : 0;

  /* 一次拿 limit 条「还有明文字段」的资料。拿宽一点（limit + 5），
     因为可能有些行扫完发现没有明文字段（全密文），凑不满 limit。 */
  const rows = await sql`
    select * from profiles
     where (name is null or name = '' or name not like 'enc:v1:%')
        or (student_id is not null and student_id <> '' and student_id not like 'enc:v1:%')
        or (politics is not null and politics <> '' and politics not like 'enc:v1:%')
        or (exam_no is not null and exam_no <> '' and exam_no not like 'enc:v1:%')
        or (wechat is not null and wechat <> '' and wechat not like 'enc:v1:%')
        or (qq is not null and qq <> '' and qq not like 'enc:v1:%')
        or (phone is not null and phone <> '' and phone not like 'enc:v1:%')
        or (id_card is not null and id_card <> '' and id_card not like 'enc:v1:%')
        or (youth_league_no is not null and youth_league_no <> '' and youth_league_no not like 'enc:v1:%')
     order by id
     limit ${limit + 5}
  `;

  /* 自定义字段也要加密：列名来自 meta 表（当初过了白名单） */
  const editable = await loadEditableFields();

  let done = 0, skipped = 0;
  const changedIds = [];
  for (const r of rows) {
    if (done >= limit) break;
    const sets = [];
    const params = [];
    const put = async (col, val) => {
      if (val == null || val === '') return;          /* 空值不加密 */
      if (isEnc(val)) return;                          /* 已是密文，跳过 */
      params.push(await encField(pkey, val));
      sets.push(col + ' = $' + params.length);
    };
    await put('name', r.name);
    await put('student_id', r.student_id);
    await put('politics', r.politics);
    await put('exam_no', r.exam_no);
    await put('wechat', r.wechat);
    await put('qq', r.qq);
    await put('phone', r.phone);
    await put('id_card', r.id_card);
    await put('youth_league_no', r.youth_league_no);
    for (const f of editable) {
      if (f.field in r) {
        const chk = isSafeFieldFormat(f.field);
        if (chk.ok) await put(chk.field, r[f.field]);
      }
    }
    if (!sets.length) { skipped++; continue; }

    /* bidx 与密文必须同源：明文算一次索引，加密后写进去。
       姓名/学号若本来就是密文（半迁移状态），bidx 补算一份 ——
       解密后重新算，保证「密文有主、索引也有主」。 */
    if (r.name_bidx == null) {
      const nm = await decField(pkey, r.name);
      if (nm && !isUndecryptable(nm)) {
        params.push(await blindIndex(pkey, nm));
        sets.push('name_bidx = $' + params.length);
      }
    }
    if (r.student_id_bidx == null) {
      const sid = await decField(pkey, r.student_id);
      if (sid && !isUndecryptable(sid)) {
        params.push(await blindIndex(pkey, sid));
        sets.push('student_id_bidx = $' + params.length);
      }
    }

    params.push(Number(r.id));
    await sql(
      'update profiles set ' + sets.join(', ') + ', updated_at = now() where id = $' + params.length,
      params
    );
    changedIds.push(Number(r.id));
    done++;
  }

  const remaining = Math.max(0, plainN - done);
  await audit(me.id, 'profile.encrypt', 'profile', '',
    '存量加密：本批 ' + done + ' 条（跳过 ' + skipped + '），剩余约 ' + remaining + ' 条');

  return ok(res, {
    encrypted: done,
    skipped,
    remaining,
    totalProfiles: allN,
    plainLeft: Math.max(0, plainN - done),
    done: remaining === 0,
    ids: changedIds,
  });
}

/**
 * 资料查看日志：谁在什么时候查看了谁。
 * 支持 ?viewer=id 只看某人的查看行为，?target=id 只看某条资料被谁看过。
 */
async function viewLogs(req, res) {
  const sql = getSql();
  const viewer = Number(req.query.viewer || 0);
  const target = Number(req.query.target || 0);
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const offset = Math.max(Number(req.query.offset || 0), 0);

  let rows = [];
  try {
    rows = await sql`
      select v.id, v.created_at, v.keyword, v.ip, v.target_name,
             v.viewer_id, v.target_id,
             u.username as viewer_name, u.display_name as viewer_display,
             t.student_id as target_sid, t.name as target_real_name
        from profile_view_log v
        left join users u    on u.id = v.viewer_id
        left join profiles t on t.id = v.target_id
       where (${viewer} = 0 or v.viewer_id = ${viewer})
         and (${target} = 0 or v.target_id = ${target})
       order by v.created_at desc
       limit ${limit} offset ${offset}
    `;
  } catch (e) {
    /* 表还没建出来时返回空，避免后台整页报错 */
    console.warn('[admin] 读取查看日志失败：', e.message);
    return ok(res, { total: 0, logs: [] });
  }

  /* 近 7 天查看次数排行，供后台展示「谁最常查资料」 */
  let top = [];
  try {
    top = await sql`
      select u.username, count(*)::int as n
        from profile_view_log v
        left join users u on u.id = v.viewer_id
       where v.created_at > now() - interval '7 days'
       group by u.username
       order by n desc
       limit 10
    `;
  } catch (e) { /* 忽略 */ }

  /* v3.5.0：t.name / t.student_id 现在是密文，必须先解密。
     日志表自带的 target_name 是**查询当时写的明文快照**，优先级更高
     （即使那条资料后来被删/改名，日志仍然看得懂）；解出的真名作兜底。 */
  const vkey = await profileKey(req);
  const logs = [];
  for (const r of rows) {
    const realName = r.target_real_name ? await decField(vkey, r.target_real_name) : '';
    const realSid = r.target_sid ? await decField(vkey, r.target_sid) : '';
    logs.push({
      id: Number(r.id),
      viewerId: r.viewer_id ? Number(r.viewer_id) : null,
      viewer: r.viewer_display || r.viewer_name || '(已删除账号)',
      targetId: r.target_id ? Number(r.target_id) : null,
      targetName: r.target_name || realName || '(已删除)',
      targetStudentId: realSid || '',
      keyword: r.keyword || '',
      ip: r.ip || '',
      createdAt: r.created_at,
    });
  }

  return ok(res, {
    total: logs.length,
    logs,
    top: top.map((t) => ({ username: t.username || '(已删除)', count: t.n })),
  });
}

/* ============================================================
   系统令牌管理（管理员专用）
   ------------------------------------------------------------
   存放 Cloudflare / Gitee / VoiceHub 等第三方令牌。
   仅 role=admin 可读写，非管理员连列表都看不到。
   ============================================================ */

async function listAdminSecrets(req, res) {
  try {
    const data = await listSecrets(req);
    return ok(res, data);
  } catch (e) {
    console.error('[admin] list secrets', e);
    return fail(res, 500, '读取令牌失败：' + e.message);
  }
}

async function saveAdminSecret(req, res, me, b) {
  const name = String(b.name || '').trim();
  const value = String(b.value || '');
  if (!value) return fail(res, 400, '令牌值不能为空');

  try {
    const result = await saveSecret(req, name, value);
    await audit(me.id, 'secret.save', 'secret', name, '保存/更新令牌 ' + name);
    return ok(res, { ...result, message: '已保存 ' + name });
  } catch (e) {
    console.error('[admin] save secret', e);
    return fail(res, 400, e.message);
  }
}

async function deleteAdminSecret(req, res, me, b) {
  const name = String(b.name || '').trim();
  if (!name) return fail(res, 400, '缺少 name');

  try {
    const result = await deleteSecret(req, name);
    await audit(me.id, 'secret.delete', 'secret', name, '删除令牌 ' + name);
    return ok(res, { ...result, message: '已删除 ' + name });
  } catch (e) {
    console.error('[admin] delete secret', e);
    return fail(res, 400, e.message);
  }
}

/* ---------------- 批量绑定「账号 ↔ 班级资料」（2026-10-06） ----------------
   POST admin?action=bind-profiles   body: { names: ['余子康', ...], dryRun?: true }

   背景：管理员按名单批量建账号（username=姓名）+ 批量导资料（name=姓名），
   两边同名但没关联。资料要靠同学自己在前端「认领」（学号+姓名双验）才能挂上，
   全班 60 人都去认领一遍体验不好。

   本接口按姓名把两边对上：profiles.user_id = users.id，
   之后同学登录 → /api/profile?action=me 直接返回自己的资料，
   「我的资料」里就能直接填 / 改微信、QQ、手机号。

   ⚠️ 只绑「资料还没被人认领」的条目；已认领且是本人 → 跳过；
      已认领且是别人 → 报冲突不覆盖（防互相顶掉）。
   dryRun=true 时只报告会做什么，不写库（先跑一遍心里有数）。 */
async function bindProfiles(req, res, me, b) {
  if (req.method !== 'POST') return fail(res, 405, '请用 POST');

  const names = Array.isArray(b.names) ? b.names : [];
  if (!names.length) return fail(res, 400, 'names 必须是非空数组');
  /* 与批量导入同一道子请求上限：Workers 单调用 50 个子请求，每条约 3 条 SQL */
  if (names.length > 15) {
    return fail(res, 400, '单次最多 15 条（Cloudflare Workers 子请求上限），请分片提交');
  }

  const dry = !!b.dryRun;
  const sql = getSql();
  /* v3.5.0：姓名是密文，按姓名找资料改走盲索引（全名精确匹配，
     与本接口原本的 `where name = ?` 语义完全一致）。 */
  const pkey = await profileKey(req);
  const out = { bound: 0, skipped: 0, noAccount: [], noProfile: [], conflict: [], boundNames: [] };

  for (const raw of names) {
    /* 两种写法：
         字符串 '余子康'                 → 找同名账号
         对象   {name:'余子康', username:'yuzikang'}
                                        → 指定账号（账号名与姓名不一致时用，
                                          例如站主自己注册的 yuzikang） */
    const name = String((raw && raw.name) || (typeof raw === 'string' ? raw : '') || '')
      .trim().slice(0, 30);
    const wantUser = (raw && typeof raw === 'object' && raw.username)
      ? String(raw.username).trim().slice(0, 40) : '';
    if (!name) continue;
    const lookup = wantUser || name;

    const acc = await sql`
      select id, username from users
       where username = ${lookup} or display_name = ${lookup}
       order by (username = ${lookup}) desc limit 1
    `;
    if (!acc.length) { out.noAccount.push(name); continue; }
    const uid = Number(acc[0].id);

    const prof = pkey
      ? await sql`select id, user_id, name from profiles where name_bidx = ${await blindIndex(pkey, name)} limit 1`
      : await sql`select id, user_id, name from profiles where name = ${name} limit 1`;
    if (!prof.length) { out.noProfile.push(name); continue; }
    const pid = Number(prof[0].id);
    const owner = prof[0].user_id == null ? null : Number(prof[0].user_id);

    if (owner === uid) { out.skipped++; continue; }
    if (owner !== null && owner !== uid) { out.conflict.push(name); continue; }

    if (!dry) {
      await sql`update profiles set user_id = ${uid}, updated_at = now() where id = ${pid}`;
    }
    out.bound++;
    out.boundNames.push(name + (wantUser ? '→' + wantUser : ''));
  }

  if (!dry && out.bound) {
    await audit(me.id, 'profile.bind', 'profile', null,
      '批量绑定账号与资料：' + out.bound + ' 人（' + out.boundNames.slice(0, 3).join('、') +
      (out.boundNames.length > 3 ? ' 等' : '') + '）');
  }

  return ok(res, Object.assign({ message: dry ? '预检完成（未写入）' : ('已绑定 ' + out.bound + ' 人') }, out));
}

/* ============================================================
   v2.10.0 用户操作日志（2026-10-16 第六十轮）
   ------------------------------------------------------------
   数据由前端全点击上报（/api/data?action=log，攒批写入）。
   后台两个读接口：明细列表 + 统计面板。
   时区口径：站主在江西（UTC+8），统计与日期筛选一律按
   Asia/Shanghai 归日，避免「昨天的点击算进了今天」。
   ============================================================ */

/** 明细列表：按用户名 / 动作类型 / 日期（上海时区）筛选 */
async function listActionLogs(req, res) {
  const sql = getSql();
  const page = Math.max(Number(req.query.page || 1), 1);
  const size = Math.min(Number(req.query.size || 50), 200);
  const offset = (page - 1) * size;
  const q = String(req.query.q || '').trim().toLowerCase();
  /* ⚠️ v2.10.0 参数名必须叫 type，不能叫 action —— 路由自己就占着
     ?action=action-logs，同名的筛选参数会被 query 解析器的「取第一个」
     吃掉（永远等于 'action-logs'，筛任何类型都返回空）。 */
  const act = String(req.query.type || '').trim();
  const day = String(req.query.day || '').trim();   /* YYYY-MM-DD（上海时区） */
  /* 🔴 v3.5.4 真根因：`(${day} = '' or ... = ${day}::date)` 里的空串强转
     会把整个查询炸掉 —— Postgres **不保证 OR 短路**，右侧的 ${day}::date
     即使左边为真也可能被求值，'' 转 date 直接
     invalid input syntax for type date: ""（线上实测报错原文）。
     而错误又被下面 catch 吞成「无数据」，于是「统计有 2361 条、明细永远 0」。
     修法：空日期传 null。null::date 永远合法；且 NULL or TRUE 恒为 TRUE，
     右侧先求值也只会得到 NULL，不会抛错，不求短路也不会炸。 */
  const dayOrNull = day || null;

  let rows = [], total = 0;
  try {
    rows = await sql`
      select l.id, l.action, l.page, l.target, l.detail, l.created_at,
             u.id as user_id, u.username, u.display_name
        from user_action_log l
        join users u on u.id = l.user_id
       where (${q} = '' or lower(u.username) like '%' || ${q} || '%'
                           or lower(coalesce(u.display_name, '')) like '%' || ${q} || '%'
                           or lower(l.page) like '%' || ${q} || '%'
                           or lower(l.target) like '%' || ${q} || '%'
                           or lower(l.action) like '%' || ${q} || '%')
         and (${act} = '' or l.action = ${act})
         and (${dayOrNull}::date is null or (l.created_at at time zone 'Asia/Shanghai')::date = ${dayOrNull}::date)
       order by l.created_at desc
       limit ${size} offset ${offset}
    `;
    total = (await sql`
      select count(*)::int as n
        from user_action_log l
        join users u on u.id = l.user_id
       where (${q} = '' or lower(u.username) like '%' || ${q} || '%'
                           or lower(coalesce(u.display_name, '')) like '%' || ${q} || '%'
                           or lower(l.page) like '%' || ${q} || '%'
                           or lower(l.target) like '%' || ${q} || '%'
                           or lower(l.action) like '%' || ${q} || '%')
         and (${act} = '' or l.action = ${act})
         and (${dayOrNull}::date is null or (l.created_at at time zone 'Asia/Shanghai')::date = ${dayOrNull}::date)
    `)[0].n;
  } catch (e) {
    /* 🔴 v3.5.4 止血：原来这里把**一切**错误都吞成「无数据」返回，
       线上「统计面板有 2361 条、明细列表永远 0 条」被这个 catch 藏了
       整整一天（2026-10-17 站主截图反馈才发现）。
       纪律：只有「表还没建出来」（Postgres 42P01 undefined_table）
       才配返回空列表；其它错误必须大声失败，让后台看到真实原因，
       而不是对着一句「没有匹配的记录」干瞪眼。 */
    if (e && e.code === '42P01') {
      return ok(res, { total: 0, logs: [], page, size });
    }
    console.error('[admin/action-logs] 查询失败：', e);
    return fail(res, 500, '日志查询失败：' + String((e && e.message) || e).slice(0, 300));
  }

  return ok(res, {
    total,
    page,
    size,
    logs: rows.map((r) => ({
      id: Number(r.id),
      userId: Number(r.user_id),
      username: r.username,
      displayName: r.display_name,
      action: r.action,
      page: r.page,
      target: r.target,
      detail: r.detail,
      createdAt: r.created_at ? String(r.created_at) : null,
    })),
  });
}

/** 统计面板：今日点击 / 7 日活跃用户 / 热门页面 / 动作分布 */
async function actionStats(req, res) {
  const sql = getSql();
  const zero = { today: 0, week: 0, activeUsers7d: 0, topPages: [], byAction: [] };
  try {
    const today = (await sql`
      select count(*)::int as n
        from user_action_log
       where created_at >= date_trunc('day', now() at time zone 'Asia/Shanghai')
                             at time zone 'Asia/Shanghai'
    `)[0].n;
    const week = (await sql`
      select count(*)::int as n from user_action_log
       where created_at >= now() - interval '7 days'
    `)[0].n;
    const activeUsers7d = (await sql`
      select count(distinct user_id)::int as n from user_action_log
       where created_at >= now() - interval '7 days'
    `)[0].n;
    const topPages = await sql`
      select page, count(*)::int as n
        from user_action_log
       where page <> '' and created_at >= now() - interval '7 days'
       group by page order by n desc limit 8
    `;
    const byAction = await sql`
      select action, count(*)::int as n
        from user_action_log
       where created_at >= now() - interval '7 days'
       group by action order by n desc
    `;
    return ok(res, {
      today, week, activeUsers7d,
      topPages: topPages.map((r) => ({ page: r.page, n: Number(r.n) })),
      byAction: byAction.map((r) => ({ action: r.action, n: Number(r.n) })),
    });
  } catch (e) {
    /* v3.5.4：同 listActionLogs 的纪律 —— 只有表不存在（42P01）才返回
       全零；其它错误大声失败，不再把「查询挂了」演成「今天没人点」。 */
    if (e && e.code === '42P01') return ok(res, zero);
    console.error('[admin/action-stats] 查询失败：', e);
    return fail(res, 500, '日志统计查询失败：' + String((e && e.message) || e).slice(0, 300));
  }
}
