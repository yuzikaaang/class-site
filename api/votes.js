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
const MAX_OPTION_LEN = 40;     // 单个选项文字
const MAX_OPTIONS = 30;        // 选项数上限（含学生新增）
const MAX_NOTE = 200;          // 备注

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

/** 规范化选项数组：{ id, label, by }；过滤空标签，截断超长 */
function normOptions(raw) {
  const out = [];
  const seen = {};
  (Array.isArray(raw) ? raw : []).forEach((o) => {
    const label = String((o && (o.label != null ? o.label : o)) || '').trim().slice(0, MAX_OPTION_LEN);
    if (!label || seen[label]) return;
    seen[label] = 1;
    out.push({
      id: String(o && o.id || '') || nextOptId(out),
      label,
      by: (o && o.by === 'student') ? 'student' : 'admin',
      /* 歌单投票：带上平台歌曲 id，方便后台取前五时回查 */
      songId: (o && o.songId != null && o.songId !== '') ? Number(o.songId) : null,
    });
  });
  return out.slice(0, MAX_OPTIONS);
}

/** 校验并整理 create/update 的入参，返回 { error } 或 { data } */
function parseVoteInput(b) {
  const title = String(b.title || '').trim().slice(0, MAX_TITLE);
  if (!title) return { error: '投票标题不能为空' };
  const kind = (b.kind === 'song') ? 'song' : 'normal';
  const options = normOptions(b.options);
  if (options.length < 2) return { error: '至少需要两个选项' };
  const multi = kind === 'normal' && b.multi === true;
  const allowAdd = b.allowAdd === true;
  const note = String(b.note || '').trim().slice(0, MAX_NOTE);
  const deadline = normDeadline(b.deadline);
  if (b.deadline != null && b.deadline !== '' && !deadline) {
    return { error: '截止时间格式不对' };
  }
  return { data: { title, kind, options, multi, allowAdd, note, deadline } };
}

/** 行 → 前端结构。results 只有「已截止」才给。 */
function shapeVote(r, uid, isAdmin, myChoices, counts) {
  const v = {
    id: Number(r.id),
    title: r.title,
    kind: r.kind,
    options: (jsonCol(r.options) || []).map((o) => ({ id: o.id, label: o.label, by: o.by, songId: o.songId == null ? null : o.songId })),
    multi: !!r.multi,
    allowAdd: !!r.allow_add,
    note: r.note || '',
    deadline: r.deadline || null,
    status: r.status,
    open: isOpen(r),
    createdAt: r.created_at || null,
  };
  const closed = !v.open;
  /* 截止后：所有人看结果；截止前：只有管理员看（后台要能预览） */
  if (closed || isAdmin) {
    v.results = (v.options || []).map((o) => ({
      id: o.id, label: o.label, by: o.by,
      n: (counts && counts[o.id]) || 0,
    }));
    v.voters = counts ? counts.__voters || 0 : 0;
  } else {
    v.results = null;
  }
  if (uid) v.myChoices = myChoices || [];
  v.mine = uid ? (myChoices && myChoices.length > 0) : false;
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
           v.deadline, v.status, v.created_at,
           (select count(*) from class_vote_ballots b where b.vote_id = v.id) as voters
      from class_votes v
     order by (v.status = 'open') desc, v.deadline asc nulls last, v.id desc
     limit 100
  `;
  if (!rows.length) return ok(res, { votes: [], isAdmin: u.role === 'admin', serverTime: Date.now() });

  /* 我的选择 + 各选项票数（一次查全部投票的票） */
  const voteIds = rows.map((r) => Number(r.id));
  const myRows = await sql`
    select vote_id, choices from class_vote_ballots where user_id = ${u.id}
  `;
  const myMap = {};
  myRows.forEach((r) => { myMap[Number(r.vote_id)] = jsonCol(r.choices) || []; });

  const ballotRows = await sql`
    select vote_id, choices from class_vote_ballots
     where vote_id = any(${voteIds}::bigint[])
  `;
  const countMap = {};
  ballotRows.forEach((r) => {
    const vid = Number(r.vote_id);
    if (!countMap[vid]) countMap[vid] = { __voters: 0 };
    countMap[vid].__voters++;
    (jsonCol(r.choices) || []).forEach((cid) => {
      const k = String(cid);
      countMap[vid][k] = (countMap[vid][k] || 0) + 1;
    });
  });

  const votes = rows.map((r) => shapeVote(r, u.id, u.role === 'admin', myMap[Number(r.id)], countMap[Number(r.id)]));
  return ok(res, { votes, isAdmin: u.role === 'admin', serverTime: Date.now() });
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

  const options = jsonCol(v.options) || [];
  if (options.length >= MAX_OPTIONS) return fail(res, 400, '选项已达上限（' + MAX_OPTIONS + ' 个）');
  if (options.some((o) => String(o.label) === label)) {
    return fail(res, 400, '这个选项已经有人提过了');
  }
  const opt = { id: nextOptId(options), label, by: 'student', songId: null };
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
  const rows = await sql`
    insert into class_votes (title, kind, options, multi, allow_add, note, deadline, status, created_by, created_at, updated_at)
    values (${p.data.title}, ${p.data.kind}, ${JSON.stringify(p.data.options)}::jsonb,
            ${p.data.multi}, ${p.data.allowAdd}, ${p.data.note}, ${p.data.deadline}::timestamptz,
            'open', ${me.id}, now(), now())
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
