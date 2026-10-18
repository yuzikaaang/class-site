/* ============================================================
 * /api/votes —— 班级投票（v3.5.6 第三块：投票管理）
 * ------------------------------------------------------------
 * 站主需求（v3.5.6.0 清单）：
 *   ① 后台投票管理：标题 / 选项 / 截止时间 / 允许学生新增选项开关；
 *   ② 前端投票专区：进行中的投票、投票、看结果；
 *   ③ 歌单投票：选项为点歌平台的歌，结果取前五，按周一至周五场景使用。
 *
 * 设计：
 *   · 投票本身必须登录（未登录不给名单感的数据，也不给投票）；
 *   · 结果「截止后公布」：open 且未到截止时间时不下发票数，防止带票；
 *   · 一人一票（ballots 表按 (vote_id, user_id) 主键），投过可改票；
 *   · 学生新增选项：投票开了 allow_add 开关才行，追加到 options 末尾；
 *   · 歌单投票（kind='song'）的选项由后台从点歌平台拉取后传入，
 *     本模块只认 options 数组，不碰 VoiceHub；
 *   · 管理动作全部 requireAdmin + audit。
 *
 * 表：class_votes / class_vote_ballots（ensureSchema 两路径已建）
 * ============================================================ */

import { getSql, jsonCol } from './_lib/db.js';
import {
  cors, handlePreflight, ok, fail, body,
  requireUser, requireAdmin, ensureSchema, audit,
} from './_lib/http.js';

/* ---------------- 限额 ---------------- */
const MAX_TITLE = 60;          // 投票标题
/* v3.5.17：歌单投票的选项要写「歌名 - 歌手 - 点歌人 - 点歌时间」四段，
   40 字会从中间截断（时间就没了），放宽到 80。 */
const MAX_OPTION_LEN = 80;     // 单个选项文字
const MAX_OPTIONS = 30;        // 选项数上限（含学生新增）
const MAX_NOTE = 200;          // 备注
const MAX_PROPOSER = 20;       // v3.5.12 提出人（不填 = 记成当前管理员）
/* v3.5.14 #9：票数配额与撤回次数 */
const MAX_RETRACT_LIMIT = 5;   // 撤回次数上限（默认 1）

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  cors(req, res);

  try {
    await ensureSchema(getSql());
    const action = String(req.query.action || '').toLowerCase();
    if (req.method === 'GET') {
      if (action === '' || action === 'list') return await listVotes(req, res);
      return fail(res, 400, '不支持的 action：' + action);
    }
    if (req.method === 'POST') {
      switch (action) {
        case 'vote':       return await castVote(req, res);
        /* v3.5.14 #9：每个选项一个点赞按钮，点一下即投 / 再点取消 */
        case 'toggle':     return await toggleVote(req, res);
        /* v3.5.14 #9：撤回重投（每人限 1 次；多选即全部撤回） */
        case 'retract':    return await retractVote(req, res);
        case 'add-option': return await addOption(req, res);
        case 'create':     return await createVote(req, res);
        case 'update':     return await updateVote(req, res);
        case 'set-status': return await setStatus(req, res);
        case 'delete':     return await deleteVote(req, res);
        default:           return fail(res, 400, '不支持的 action：' + action);
      }
    }
    return fail(res, 405, '不支持的方法');
  } catch (e) {
    console.error('[votes]', req.method, req.query && req.query.action, e && e.stack ? e.stack : e);
    return fail(res, 500, '服务器内部错误，请稍后重试');
  }
}

/* ---------------- 工具 ---------------- */

/** 把入参转成截止时间（ISO 字符串）。空 / 非法 → null（不限截止）。
 *  前端传的是 new Date(datetime-local).toISOString()，已经是 UTC ISO。 */
function normDeadline(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** 投票当前是否可投：status=open 且（无截止 或 未过截止） */
function isOpen(v) {
  if (v.status !== 'open') return false;
  if (!v.deadline) return true;
  return Date.parse(v.deadline) > Date.now();
}

/** 生成选项 id：o1 / o2 …（只追加不重排，取当前最大号 +1） */
function nextOptId(options) {
  let max = 0;
  (options || []).forEach((o) => {
    const m = /^o(\d+)$/.exec(String(o && o.id || ''));
    if (m) max = Math.max(max, Number(m[1]));
  });
  return 'o' + (max + 1);
}

/** v3.5.19：歌单选项的结构化信息（点歌人 / 点歌时间 / 赞数 / 时长）。
 *  只白名单键，全部截断 —— 前端折叠展示靠它，label 仍保留可读文本。 */
function normSongMeta(m) {
  if (!m || typeof m !== 'object') return null;
  const out = {};
  const title = String(m.title || '').trim().slice(0, 80);
  const artist = String(m.artist || '').trim().slice(0, 60);
  const requester = String(m.requester || '').trim().slice(0, 20);
  const at = String(m.requestedAt || m.requested_at || '').trim().slice(0, 30);
  if (title) out.title = title;
  if (artist) out.artist = artist;
  if (requester) out.requester = requester;
  if (at) out.requestedAt = at;
  if (m.voteCount != null && isFinite(Number(m.voteCount))) out.voteCount = Math.max(0, Math.round(Number(m.voteCount)));
  if (m.duration != null && isFinite(Number(m.duration)) && Number(m.duration) >= 0) {
    out.duration = Math.round(Number(m.duration));
  }
  const show = Array.isArray(m.show)
    ? m.show.filter((x) => ['requester', 'time', 'votes', 'duration'].includes(x))
    : [];
  if (show.length) out.show = show;
  return Object.keys(out).length ? out : null;
}

/** v3.5.19：同学新增选项的限制。maxLen 字数；format: number / en / date */
function normOptionRule(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const out = {};
  const ml = Math.floor(Number(r.maxLen != null ? r.maxLen : r.max_len) || 0);
  if (ml >= 1) out.maxLen = Math.min(MAX_OPTION_LEN, ml);
  let f = String(r.format || '').trim();
  if (!['number', 'en', 'date'].includes(f)) f = '';
  if (f) out.format = f;
  if (f === 'date') {
    const p = String(r.precision || '').trim();
    out.precision = ['year', 'month', 'day', 'hour', 'minute'].includes(p) ? p : 'minute';
  } else if (f === 'number') {
    out.precision = null;
  }
  return Object.keys(out).length ? out : null;
}

/** v3.5.19：歌单投票的取歌策略（前 N / 用途 / 时长上限） */
function normSongPick(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const out = {};
  const n = Math.floor(Number(r.topN != null ? r.topN : r.top_n) || 0);
  if (n >= 1) out.topN = Math.min(50, n);
  out.purpose = (r.purpose === 'music') ? 'music' : 'daily';
  const cap = Math.floor(Number(r.maxMinutes != null ? r.maxMinutes : r.max_minutes) || 0);
  if (cap >= 1) out.maxMinutes = Math.min(300, cap);
  return out;
}

/** 日期格式校验（同学新增选项时用）：按精度严格匹配 */
function matchDateFormat(s, precision) {
  const p = precision || 'minute';
  const re = {
    year: /^\d{4}$/,
    month: /^\d{4}-\d{2}$/,
    day: /^\d{4}-\d{2}-\d{2}$/,
    hour: /^\d{4}-\d{2}-\d{2} \d{2}$/,
    minute: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
  }[p];
  return re.test(s);
}

/** 规范化选项数组：{ id, label, by }；过滤空标签，截断超长 */
function normOptions(raw) {
  const out = [];
  const seen = {};
  (Array.isArray(raw) ? raw : []).forEach((o) => {
    const label = String((o && (o.label != null ? o.label : o)) || '').trim().slice(0, MAX_OPTION_LEN);
    if (!label || seen[label]) return;
    seen[label] = 1;
    const isStudent = !!(o && o.by === 'student');
    out.push({
      id: String(o && o.id || '') || nextOptId(out),
      label,
      by: isStudent ? 'student' : 'admin',
      /* v3.5.14 站主要求：选项要写「谁提的」—— 后台加的就是「管理员」，
         同学在前台加的就是该同学的名字（不是笼统的「同学提」）。 */
      byName: String((o && (o.byName || o.by_name)) || '').trim().slice(0, 20)
        || (isStudent ? '同学' : '管理员'),
      /* 歌单投票：带上平台歌曲 id，方便后台取前 N 时回查 */
      songId: (o && o.songId != null && o.songId !== '') ? Number(o.songId) : null,
      /* v3.5.19：结构化信息（勾了哪些字段就存哪些），前端折叠展示用 */
      songMeta: normSongMeta(o && (o.songMeta || o.song_meta)),
    });
  });
  return out.slice(0, MAX_OPTIONS);
}

/** 数字型配额：空 / 非法 → null（= 不限）；否则取整并夹到 1..选项数 */
function normQuota(v, max) {
  if (v == null || v === '') return null;
  const n = Math.floor(Number(v));
  if (!isFinite(n) || n < 1) return null;
  return Math.max(1, Math.min(max, n));
}
/** 撤回次数：缺省 1，0 = 不允许撤回 */
function normRetract(v) {
  if (v == null || v === '') return 1;
  const n = Math.floor(Number(v));
  if (!isFinite(n) || n < 0) return 1;
  return Math.min(MAX_RETRACT_LIMIT, n);
}

/** 校验并整理 create/update 的入参，返回 { error } 或 { data } */
function parseVoteInput(b) {
  const title = String(b.title || '').trim().slice(0, MAX_TITLE);
  if (!title) return { error: '投票标题不能为空' };
  const kind = (b.kind === 'song') ? 'song' : 'normal';
  const options = normOptions(b.options);
  if (options.length < 2) return { error: '至少需要两个选项' };
  /* v3.5.20：歌单投票也允许多选（站主：「点歌的投票也可以设置多选，我现在更改完就被改回了单选」）
     —— 以前这里硬编码 kind === 'normal'，后台勾了多选也会被吞掉。 */
  const multi = b.multi === true;
  /* v3.5.23：歌单投票不允许同学自己加选项 —— 从点歌平台挑的歌才有 songMeta，
     同学手打的字符串前台没法折叠展示。后台勾了也一律按 false 处理。 */
  const allowAdd = (kind !== 'song') && b.allowAdd === true;
  const note = String(b.note || '').trim().slice(0, MAX_NOTE);
  /* v3.5.12 #10：谁提出来的。留空则由后端记为当前操作人（created_by 的显示名） */
  const proposer = String(b.proposer || b.proposedBy || '').trim().slice(0, MAX_PROPOSER);
  const deadline = normDeadline(b.deadline);
  if (b.deadline != null && b.deadline !== '' && !deadline) {
    return { error: '截止时间格式不对' };
  }
  /* v3.5.14 #9：后台可设「最多选几项」「至少选几项」，留空 = 不限 */
  const maxChoices = normQuota(b.maxChoices != null ? b.maxChoices : b.max_choices, options.length);
  const minChoices = normQuota(b.minChoices != null ? b.minChoices : b.min_choices, options.length);
  if (maxChoices != null && minChoices != null && minChoices > maxChoices) {
    return { error: '「至少选」不能大于「最多选」' };
  }
  if (!multi && maxChoices != null && maxChoices > 1) {
    return { error: '单选投票的「最多选」只能是 1' };
  }
  const retractLimit = normRetract(b.retractLimit != null ? b.retractLimit : b.retract_limit);
  const endMode = (b.endMode === 'pub' || b.end_mode === 'pub') ? 'pub' : 'keep';
  /* v3.5.19：新增选项限制 + 歌单取歌策略（前 N / 用途 / 时长上限） */
  const optionRule = normOptionRule(b.optionRule != null ? b.optionRule : b.option_rule);
  /* v3.5.20：提出日期可改（站主：「后台可以修改才对」）—— 只认 YYYY-MM-DD */
  const createdDate = (function(){
    const s = String(b.createdDate || b.created_date || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  })();
  const songPick = (kind === 'song')
    ? normSongPick(b.songPick != null ? b.songPick : b.song_pick)
    : null;
  return { data: { title, kind, options, multi, allowAdd, note, deadline, proposer,
    maxChoices, minChoices, retractLimit, endMode, optionRule, songPick, createdDate } };
}

/** timestamptz → 北京时间 YYYY-MM-DD（Date / ISO / 已格式化字符串都能吃） */
function dateOnly(x) {
  if (!x) return null;
  if (typeof x === 'string') {
    const m = x.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
  }
  const d = (x instanceof Date) ? x : new Date(x);
  if (isNaN(d.getTime())) {
    const m2 = String(x).match(/(\d{4})-(\d{2})-(\d{2})/);
    return m2 ? m2[0] : null;
  }
  /* 统一按北京时间取日期：Worker 跑在 UTC，早上 8 点前创建会差一天 */
  const p = (n) => String(n).padStart(2, '0');
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
    return parts;   /* en-CA 就是 YYYY-MM-DD */
  } catch (e) {
    const d2 = new Date(d.getTime() + 8 * 3600 * 1000);
    return d2.getUTCFullYear() + '-' + p(d2.getUTCMonth() + 1) + '-' + p(d2.getUTCDate());
  }
}

/** 行 → 前端结构。results 只有「已截止」才给。 */
function shapeVote(r, uid, isAdmin, myChoices, counts, myUsed) {
  const v = {
    id: Number(r.id),
    title: r.title,
    kind: r.kind,
    options: (jsonCol(r.options) || []).map((o) => ({
      id: o.id, label: o.label, by: o.by,
      byName: o.byName || (o.by === 'student' ? '同学' : '管理员'),
      songId: o.songId == null ? null : o.songId,
      /* v3.5.19：选项的结构化信息（点歌人 / 时间 / 赞数 / 时长），前端折叠展示靠它 */
      songMeta: o.songMeta || null,
    })),
    multi: !!r.multi,
    allowAdd: !!r.allow_add,
    note: r.note || '',
    deadline: r.deadline || null,
    status: r.status,
    open: isOpen(r),
    createdAt: r.created_at || null,
    /* v3.5.12 #10（站主要求）：谁提出来的 + 提出的日期，前端直接展示 */
    createdBy: r.created_by == null ? null : Number(r.created_by),
    proposer: r.proposer || '',
    createdByName: r.creator_display || r.creator_username || '',
    createdByUsername: r.creator_username || '',
    createdByDisplay: r.creator_display || '',
    /* 提出的日期：只给「YYYY-MM-DD」，前端要显示「2026-10-17 提出」这种短格式 */
    /* v3.5.20：以前 String(Date).slice(0,10) 得到 "Sun Oct 18"，
       前端再 new Date() 出来就是 2001 年 —— 站主看到的「2001 年」就是这个。 */
    createdDate: dateOnly(r.created_at),
    /* v3.5.14 #9：票数配额与撤回 */
    /* v3.5.14：结束后形态 —— keep 继续显示投票栏（不可投）；pub 自动展示公示并隐藏投票 */
    endMode: r.end_mode === 'pub' ? 'pub' : 'keep',
    /* v3.5.19：新增选项限制 + 歌单取歌策略 */
    optionRule: jsonCol(r.option_rule) || null,
    songPick: jsonCol(r.song_pick) || null,
    maxChoices: r.max_choices == null ? null : Number(r.max_choices),
    minChoices: r.min_choices == null ? null : Number(r.min_choices),
    retractLimit: r.retract_limit == null ? 1 : Number(r.retract_limit),
    retractUsed: Number(myUsed || 0),
    canRetract: !!uid && (myChoices || []).length > 0 && Number(myUsed || 0) < (r.retract_limit == null ? 1 : Number(r.retract_limit)),
  };
  const closed = !v.open;
  /* 截止后：所有人看结果；截止前：只有管理员看（后台要能预览） */
  if (closed || isAdmin) {
    /* 结果按票数降序（同票保持原顺序） */
    v.results = (v.options || []).map((o) => ({
      id: o.id, label: o.label, by: o.by,
      n: (counts && counts[o.id]) || 0,
    })).sort((a, b) => b.n - a.n);
    v.voters = counts ? counts.__voters || 0 : 0;
  } else {
    v.results = null;
  }
  if (uid) v.myChoices = myChoices || [];
  v.mine = uid ? (myChoices && myChoices.length > 0) : false;
  v.myComplete = v.minChoices == null ? v.mine : ((myChoices || []).length >= v.minChoices);
  return v;
}

/* ---------------- 读：投票列表 ----------------
   登录用户可看。排序：进行中的在前（截止时间近的更前），其余按创建时间倒序。 */
async function listVotes(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;

  const sql = getSql();
  const rows = await sql`
    select v.id, v.title, v.kind, v.options, v.multi, v.allow_add, v.note,
           v.deadline, v.status, v.created_at, v.created_by, v.proposer,
           v.max_choices, v.min_choices, v.retract_limit, v.end_mode,
           v.option_rule, v.song_pick,
           u.username as creator_username,
           u.display_name as creator_display
      from class_votes v
      left join users u on u.id = v.created_by
     order by (v.status = 'open') desc, v.deadline asc nulls last, v.id desc
     limit 100
  `;
  if (!rows.length) return ok(res, { votes: [], isAdmin: u.role === 'admin', serverTime: Date.now() });

  /* 我的选择 + 各选项票数（一次查全部投票的票） */
  const voteIds = rows.map((r) => Number(r.id));
  const myRows = await sql`
    select vote_id, choices, retract_used from class_vote_ballots where user_id = ${u.id}
  `;
  const myMap = {}, myUsed = {};
  myRows.forEach((r) => {
    myMap[Number(r.vote_id)] = jsonCol(r.choices) || [];
    myUsed[Number(r.vote_id)] = Number(r.retract_used || 0);
  });

  const ballotRows = await sql`
    select vote_id, choices from class_vote_ballots
     where vote_id = any(${voteIds}::bigint[])
  `;
  const countMap = {};
  ballotRows.forEach((r) => {
    const vid = Number(r.vote_id);
    const ch = jsonCol(r.choices) || [];
    /* v3.5.14：撤回后 choices 为空，但 ballot 行还在 —— 不能算成「参与人数」 */
    if (!ch.length) return;
    if (!countMap[vid]) countMap[vid] = { __voters: 0 };
    countMap[vid].__voters++;
    ch.forEach((cid) => {
      const k = String(cid);
      countMap[vid][k] = (countMap[vid][k] || 0) + 1;
    });
  });

  const votes = rows.map((r) => shapeVote(r, u.id, u.role === 'admin', myMap[Number(r.id)], countMap[Number(r.id)], myUsed[Number(r.id)]));
  return ok(res, { votes, isAdmin: u.role === 'admin', serverTime: Date.now() });
}

/* ---------------- 学生：点赞即投（v3.5.14 #9） ----------------
   前端每个选项一个点赞按钮，点一下调这个接口：
   · 单选：点谁就是谁；再点同一个 = 取消（不消耗撤回次数）
   · 多选：有则移除、无则追加；追加上限看后台设的「最多选几项」
   服务端是唯一真相，前端只做乐观更新。 */
async function toggleVote(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;

  const b = await body(req);
  const voteId = Number(b.voteId || b.vote_id || 0);
  const optionId = String(b.optionId || b.option_id || '');
  if (!voteId) return fail(res, 400, '缺少 voteId');
  if (!optionId) return fail(res, 400, '缺少 optionId');

  const sql = getSql();
  const rows = await sql`select * from class_votes where id = ${voteId}`;
  if (!rows.length) return fail(res, 404, '投票不存在或已删除');
  const v = rows[0];
  if (!isOpen(v)) return fail(res, 400, '投票已截止或已关闭，不能再投票');

  const options = jsonCol(v.options) || [];
  if (!options.some((o) => String(o.id) === optionId)) return fail(res, 400, '这个选项不存在');

  const bl = await sql`
    select choices from class_vote_ballots where vote_id = ${voteId} and user_id = ${u.id}
  `;
  const cur = (bl.length ? (jsonCol(bl[0].choices) || []) : []).map(String);

  if (v.multi) {
    const i = cur.indexOf(optionId);
    if (i >= 0) cur.splice(i, 1);
    else {
      const max = (v.max_choices == null) ? null : Number(v.max_choices);
      if (max != null && cur.length >= max) {
        return fail(res, 400, '这场投票最多选 ' + max + ' 项，先点掉一个再选');
      }
      cur.push(optionId);
    }
  } else {
    /* 单选：再点同一个 = 取消；点别的 = 直接改投 */
    if (cur[0] === optionId) cur.length = 0;
    else { cur.length = 0; cur.push(optionId); }
  }

  await sql`
    insert into class_vote_ballots (vote_id, user_id, choices, updated_at)
    values (${voteId}, ${u.id}, ${JSON.stringify(cur)}::jsonb, now())
    on conflict (vote_id, user_id)
    do update set choices = excluded.choices, updated_at = now()
  `;
  return ok(res, {
    message: cur.length ? (v.multi ? '已选上，可继续点其他项' : '已投票') : '已取消这一项',
    voteId, choices: cur, mine: cur.length > 0,
  });
}

/* ---------------- 学生：撤回重投（v3.5.14 #9） ----------------
   每场投票每人限 1 次（后台可改，0 = 不允许）；多选即全部撤回。 */
async function retractVote(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;

  const b = await body(req);
  const voteId = Number(b.voteId || b.vote_id || 0);
  if (!voteId) return fail(res, 400, '缺少 voteId');

  const sql = getSql();
  const rows = await sql`select * from class_votes where id = ${voteId}`;
  if (!rows.length) return fail(res, 404, '投票不存在或已删除');
  const v = rows[0];
  if (!isOpen(v)) return fail(res, 400, '投票已截止，不能再撤回');

  const limit = (v.retract_limit == null) ? 1 : Number(v.retract_limit);
  if (limit <= 0) return fail(res, 400, '这场投票不开放撤回');

  const bl = await sql`
    select choices, retract_used from class_vote_ballots
     where vote_id = ${voteId} and user_id = ${u.id}
  `;
  if (!bl.length || !(jsonCol(bl[0].choices) || []).length) return fail(res, 400, '你还没有投票，不用撤回');
  const used = Number(bl[0].retract_used || 0);
  if (used >= limit) return fail(res, 400, '这场投票的撤回机会已经用完了（每人 ' + limit + ' 次）');

  await sql`
    update class_vote_ballots
       set choices = '[]'::jsonb, retract_used = ${used + 1}, updated_at = now()
     where vote_id = ${voteId} and user_id = ${u.id}
  `;
  return ok(res, {
    message: '已撤回，可以重新投票' + (v.multi ? '（多选已全部撤回）' : ''),
    voteId, retractUsed: used + 1, retractLeft: Math.max(0, limit - used - 1),
  });
}

/* ---------------- 学生：投票 / 改票 ---------------- */
async function castVote(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;

  const b = await body(req);
  const voteId = Number(b.voteId || b.vote_id || 0);
  if (!voteId) return fail(res, 400, '缺少 voteId');

  const sql = getSql();
  const rows = await sql`select * from class_votes where id = ${voteId}`;
  if (!rows.length) return fail(res, 404, '投票不存在或已删除');
  const v = rows[0];
  if (!isOpen(v)) return fail(res, 400, '投票已截止或已关闭，不能再投票');

  const options = jsonCol(v.options) || [];
  const ids = {};
  options.forEach((o) => { ids[String(o.id)] = 1; });

  const rawChoices = Array.isArray(b.choices) ? b.choices : (b.choice != null ? [b.choice] : []);
  const choices = [];
  rawChoices.forEach((c) => {
    const k = String(c || '');
    if (ids[k] && choices.indexOf(k) < 0) choices.push(k);
  });
  if (!choices.length) return fail(res, 400, '请至少选择一个选项');
  if (!v.multi && choices.length > 1) return fail(res, 400, '这是单选投票，只能选一项');
  /* v3.5.14：后台配了「最多选 / 至少选」就在这里兜底 —— 前端只是提示，服务端才是裁判 */
  const maxN = v.max_choices == null ? null : Number(v.max_choices);
  const minN = v.min_choices == null ? null : Number(v.min_choices);
  if (maxN != null && choices.length > maxN) return fail(res, 400, '这场投票最多选 ' + maxN + ' 项，你选了 ' + choices.length + ' 项');
  if (minN != null && choices.length < minN) return fail(res, 400, '这场投票至少选 ' + minN + ' 项，你只选了 ' + choices.length + ' 项');

  await sql`
    insert into class_vote_ballots (vote_id, user_id, choices, updated_at)
    values (${voteId}, ${u.id}, ${JSON.stringify(choices)}::jsonb, now())
    on conflict (vote_id, user_id)
    do update set choices = excluded.choices, updated_at = now()
  `;
  return ok(res, { message: '已记录你的选择', voteId, choices });
}

/* ---------------- 学生：新增选项（投票允许时） ---------------- */
async function addOption(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;

  const b = await body(req);
  const voteId = Number(b.voteId || b.vote_id || 0);
  if (!voteId) return fail(res, 400, '缺少 voteId');
  const label = String(b.label || '').trim().slice(0, MAX_OPTION_LEN);
  if (!label) return fail(res, 400, '选项内容不能为空');

  const sql = getSql();
  const rows = await sql`select * from class_votes where id = ${voteId}`;
  if (!rows.length) return fail(res, 404, '投票不存在或已删除');
  const v = rows[0];
  if (!isOpen(v)) return fail(res, 400, '投票已截止或已关闭，不能新增选项');
  if (!v.allow_add) return fail(res, 403, '本投票未开放「新增选项」');

  const options = (jsonCol(v.options) || []).map((o) => ({
    ...o,
    byName: o.byName || (o.by === 'student' ? '同学' : '管理员'),
  }));
  if (options.length >= MAX_OPTIONS) return fail(res, 400, '选项已达上限（' + MAX_OPTIONS + ' 个）');
  if (options.some((o) => String(o.label) === label)) {
    return fail(res, 400, '这个选项已经有人提过了');
  }
  /* v3.5.19：按投票里配的「新增选项」规则校验（站主要求：字数 + 格式） */
  const orule = jsonCol(v.option_rule) || {};
  if (orule.maxLen && [...label].length > orule.maxLen) {
    return fail(res, 400, '这个投票的选项最多 ' + orule.maxLen + ' 个字');
  }
  if (orule.format === 'number' && !/^\d+$/.test(label)) {
    return fail(res, 400, '这个投票的选项只能是数字');
  }
  if (orule.format === 'en' && !/^[A-Za-z0-9\s'.,!?&()\-]+$/.test(label)) {
    return fail(res, 400, '这个投票的选项只能是英文');
  }
  if (orule.format === 'date' && !matchDateFormat(label, orule.precision)) {
    const fmt = { year: '2024', month: '2024-05', day: '2024-05-13', hour: '2024-05-13 20', minute: '2024-05-13 20:30' };
    return fail(res, 400, '这个投票的选项要填日期，格式：' + (fmt[orule.precision || 'minute']));
  }
  const who = u.display_name || u.displayName || u.username || '同学';
  const opt = { id: nextOptId(options), label, by: 'student', byName: who, songId: null };
  options.push(opt);

  await sql`
    update class_votes set options = ${JSON.stringify(options)}::jsonb, updated_at = now()
     where id = ${voteId}
  `;
  /* 谁提的就自动给谁投上这个新选项，省得再点一次 */
  await sql`
    insert into class_vote_ballots (vote_id, user_id, choices, updated_at)
    values (${voteId}, ${u.id}, ${JSON.stringify([opt.id])}::jsonb, now())
    on conflict (vote_id, user_id) do nothing
  `;
  return ok(res, { message: '已添加选项「' + label + '」', option: opt });
}

/* ---------------- 管理员：新建 ---------------- */
async function createVote(req, res) {
  const me = await requireAdmin(req, res);
  if (!me) return;

  const b = await body(req);
  const p = parseVoteInput(b);
  if (p.error) return fail(res, 400, p.error);

  const sql = getSql();
  /* v3.5.12 #10：提出人。前台没填就用操作人的显示名兜底（总不能空着） */
  const proposer = p.data.proposer || me.displayName || me.display_name || me.username || '';
  const rows = await sql`
    insert into class_votes (title, kind, options, multi, allow_add, note, deadline, status,
                             created_by, proposer, max_choices, min_choices, retract_limit, end_mode,
                             option_rule, song_pick, created_at, updated_at)
    values (${p.data.title}, ${p.data.kind}, ${JSON.stringify(p.data.options)}::jsonb,
            ${p.data.multi}, ${p.data.allowAdd}, ${p.data.note}, ${p.data.deadline}::timestamptz,
            'open', ${me.id}, ${proposer},
            ${p.data.maxChoices}, ${p.data.minChoices}, ${p.data.retractLimit}, ${p.data.endMode},
            ${p.data.optionRule ? JSON.stringify(p.data.optionRule) : null}::jsonb,
            ${p.data.songPick ? JSON.stringify(p.data.songPick) : null}::jsonb,
            coalesce(${p.data.createdDate ? p.data.createdDate + ' 00:00:00+08' : null}::timestamptz, now()), now())
    returning id
  `;
  await audit(me.id, 'vote.create', 'class_votes', String(rows[0].id), p.data.title);
  return ok(res, { message: '投票已创建', id: Number(rows[0].id) });
}

/* ---------------- 管理员：修改 ----------------
   只允许改未截止的投票（截止后改选项 = 作弊，必须先截止）。
   已有人投过的选项不允许删（会把票挂空）—— 只能整个截止后不管。 */
async function updateVote(req, res) {
  const me = await requireAdmin(req, res);
  if (!me) return;

  const b = await body(req);
  const voteId = Number(b.voteId || b.vote_id || 0);
  if (!voteId) return fail(res, 400, '缺少 voteId');

  const sql = getSql();
  const rows = await sql`select * from class_votes where id = ${voteId}`;
  if (!rows.length) return fail(res, 404, '投票不存在或已删除');
  const v = rows[0];

  const p = parseVoteInput(b);
  if (p.error) return fail(res, 400, p.error);

  /* 已截止的投票不许改内容（标题/选项/开关），防止「看到结果再改规则」 */
  if (!isOpen(v) && (p.data.title !== v.title || p.data.kind !== v.kind)) {
    return fail(res, 400, '投票已截止，不能修改标题或类型');
  }

  /* 保留老选项 id：按 label 匹配，老选项的票才继续算数 */
  const oldOpts = jsonCol(v.options) || [];
  const oldByLabel = {};
  oldOpts.forEach((o) => { oldByLabel[String(o.label)] = o; });
  const merged = p.data.options.map((o) => {
    const old = oldByLabel[o.label];
    return old ? { ...o, id: old.id, by: old.by, songId: old.songId != null ? old.songId : o.songId } : o;
  });
  /* 被删掉的老选项：删了它们身上的票（choices 里清掉） */
  const keepIds = {};
  merged.forEach((o) => { keepIds[String(o.id)] = 1; });
  const ballots = await sql`select vote_id, user_id, choices from class_vote_ballots where vote_id = ${voteId}`;
  for (const bl of ballots) {
    const cur = jsonCol(bl.choices) || [];
    const kept = cur.filter((c) => keepIds[String(c)]);
    if (kept.length !== cur.length) {
      await sql`
        update class_vote_ballots set choices = ${JSON.stringify(kept)}::jsonb, updated_at = now()
         where vote_id = ${voteId} and user_id = ${bl.user_id}
      `;
    }
  }

  await sql`
    update class_votes
       set title = ${p.data.title}, kind = ${p.data.kind}, options = ${JSON.stringify(merged)}::jsonb,
           multi = ${p.data.multi}, allow_add = ${p.data.allowAdd}, note = ${p.data.note},
           max_choices = ${p.data.maxChoices}, min_choices = ${p.data.minChoices},
           retract_limit = ${p.data.retractLimit}, end_mode = ${p.data.endMode},
           option_rule = ${p.data.optionRule ? JSON.stringify(p.data.optionRule) : null}::jsonb,
           song_pick = ${p.data.songPick ? JSON.stringify(p.data.songPick) : null}::jsonb,
           created_at = coalesce(${p.data.createdDate ? p.data.createdDate + ' 00:00:00+08' : null}::timestamptz, created_at),
           deadline = ${p.data.deadline}::timestamptz, updated_at = now()
     where id = ${voteId}
  `;
  await audit(me.id, 'vote.update', 'class_votes', String(voteId), p.data.title);
  return ok(res, { message: '已保存修改' });
}

/* ---------------- 管理员：截止 / 重新打开 ---------------- */
async function setStatus(req, res) {
  const me = await requireAdmin(req, res);
  if (!me) return;

  const b = await body(req);
  const voteId = Number(b.voteId || b.vote_id || 0);
  if (!voteId) return fail(res, 400, '缺少 voteId');
  const st = String(b.status || '').trim();
  if (st !== 'open' && st !== 'closed') return fail(res, 400, 'status 只能是 open / closed');

  const sql = getSql();
  const rows = await sql`select id, title from class_votes where id = ${voteId}`;
  if (!rows.length) return fail(res, 404, '投票不存在或已删除');

  await sql`update class_votes set status = ${st}, updated_at = now() where id = ${voteId}`;
  await audit(me.id, st === 'closed' ? 'vote.close' : 'vote.reopen', 'class_votes', String(voteId), rows[0].title);
  return ok(res, { message: st === 'closed' ? '已截止，结果已公布' : '已重新打开投票' });
}

/* ---------------- 管理员：删除 ---------------- */
async function deleteVote(req, res) {
  const me = await requireAdmin(req, res);
  if (!me) return;

  const b = await body(req);
  const voteId = Number(b.voteId || b.vote_id || 0);
  if (!voteId) return fail(res, 400, '缺少 voteId');

  const sql = getSql();
  const rows = await sql`select id, title from class_votes where id = ${voteId}`;
  if (!rows.length) return fail(res, 404, '投票不存在或已删除');

  await sql`delete from class_vote_ballots where vote_id = ${voteId}`;
  await sql`delete from class_votes where id = ${voteId}`;
  await audit(me.id, 'vote.delete', 'class_votes', String(voteId), rows[0].title);
  return ok(res, { message: '投票已删除' });
}
