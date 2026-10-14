/* ============================================================
 * /api/scores —— 班级站点「成绩分析」接口
 * ------------------------------------------------------------
 * 设计原则（站主 2026-10-14 定稿，见《成绩分析-需求总表》）：
 *
 *   ① 服务器只搬数据、不算账。
 *      排名 / 均分 / 分数段 / 上线人数 / 进退步 **全部交给浏览器实时算**，
 *      服务器只返回原始分。好处是：改一个数之后，所有统计立刻自洽，
 *      永远不会留下「分数改了、排名还是旧的」这种脏数据。
 *
 *   ② 未登录 = 一条成绩都看不到（在这一层拦掉，不靠前端隐藏）。
 *
 *   ③ 未发布的考试（status='draft'）只有管理员能看。
 *
 *   ④ 认人按「姓名」—— 站主明确要求：成绩表不保证按学号顺序排，
 *      班上还有转学生（以前的表里没有他的名字）。
 *      所以不拿学号当主键，学号只作为可选信息存着。
 *
 *   ⑤ 导入是「整体替换本次」：先清空该次考试的成绩再批量写入。
 *      这样不存在重名冲突（真有两个同名的同学也能各占一行），
 *      也不会有「第二次导入把人搞重复」的问题。
 *
 * 数据表：exams / exam_scores / share_links / score_config（见 schema.sql）
 * ============================================================ */

import { getSql, jsonCol } from './_lib/db.js';
import {
  cors, handlePreflight, ok, fail, body,
  requireUser, requireAdmin, audit,
} from './_lib/http.js';

/* ---------------- 限额（防止有人把库撑爆） ---------------- */
const MAX_NAME = 60;            // 考试名称
const MAX_NOTE = 200;           // 备注
const MAX_ROWS = 300;           // 一次考试的名单上限（65 人的班，给足余量）
const MAX_SUBJECTS = 12;        // 科目数上限
const MAX_CUTLINES = 8;         // 分数线最多几条
const MAX_IMPORT_BYTES = 600 * 1024;  // 单次导入的 JSON 体积上限

/* 允许的考试类型（站主只录大型考试，见需求总表第五节） */
const EXAM_TYPES = ['全校联考', '校际联考', '月考', '期中', '期末', '其他'];

/* 默认科目表：物化生 + 语数英。化学、生物按站主要求默认赋分。 */
const DEFAULT_SUBJECTS = [
  { key: 'chinese',  name: '语文', full: 150, graded: false },
  { key: 'math',     name: '数学', full: 150, graded: false },
  { key: 'english',  name: '英语', full: 150, graded: false },
  { key: 'physics',  name: '物理', full: 100, graded: false },
  { key: 'chemistry', name: '化学', full: 100, graded: true },
  { key: 'biology',  name: '生物', full: 100, graded: true },
];

/* 默认分数线：特控 / 本科 / 600。分数留空 = 学校没公布（不画、不统计）。 */
const DEFAULT_CUTLINES = [
  { key: 'special', label: '特控线', score: null, color: '#b45309' },
  { key: 'undergrad', label: '本科线', score: null, color: '#c0392b' },
  { key: 'line600', label: '600 分线', score: 600, color: '#7c3aed' },
];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  cors(req, res);

  const action = String(req.query.action || '').toLowerCase();

  try {
    if (req.method === 'GET') return await handleGet(req, res, action);
    if (req.method === 'POST') return await handlePost(req, res, action);
    return fail(res, 405, '不支持的方法');
  } catch (e) {
    console.error('[scores]', req.method, action, e && e.stack ? e.stack : e);
    return fail(res, 500, '服务器内部错误，请稍后重试');
  }
}

/* ============================================================
 * 读接口
 * ============================================================ */

async function handleGet(req, res, action) {
  switch (action) {
    case 'list':   return await getList(req, res);
    case 'board':  return await getBoard(req, res);
    case 'me':     return await getMe(req, res);
    case 'config': return await getConfig(req, res);
    case 'meta':   return await getMeta(req, res);
    default:       return fail(res, 400, '未知的读取动作：' + (action || '(空)'));
  }
}

/** 考试列表。学生只看到已发布的；管理员看到全部（含草稿）。 */
async function getList(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;

  const sql = getSql();
  const isAdmin = u.role === 'admin';

  const rows = isAdmin
    ? await sql`
        select e.id, e.name, e.exam_date, e.exam_type, e.subjects, e.cutlines,
               e.grade_ref, e.note, e.status, e.published_at, e.updated_at,
               (select count(*) from exam_scores s where s.exam_id = e.id) as row_count
          from exams e
         order by e.exam_date desc, e.id desc`
    : await sql`
        select e.id, e.name, e.exam_date, e.exam_type, e.subjects, e.cutlines,
               e.grade_ref, e.note, e.status, e.published_at, e.updated_at,
               (select count(*) from exam_scores s where s.exam_id = e.id) as row_count
          from exams e
         where e.status = 'published'
         order by e.exam_date desc, e.id desc`;

  ok(res, {
    exams: rows.map(normalizeExam),
    isAdmin,
    serverTime: Date.now(),
  });
}

/** 某次考试的原始成绩（整班）。发布前只有管理员能取。 */
async function getBoard(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;

  const id = Number(req.query.exam || req.query.id || 0);
  if (!id) return fail(res, 400, '缺少考试 id');

  const sql = getSql();
  const ex = await sql`
    select id, name, exam_date, exam_type, subjects, cutlines, grade_ref,
           note, status, published_at, updated_at
      from exams where id = ${id}`;
  if (!ex.length) return fail(res, 404, '该考试不存在或已被删除');

  const exam = normalizeExam(ex[0]);
  if (exam.status !== 'published' && u.role !== 'admin') {
    return fail(res, 403, '该次考试尚未发布');
  }

  const rows = await sql`
    select id, student_name, student_no, user_id, scores, school_rank, league_rank, note
      from exam_scores
     where exam_id = ${id}
     order by id`;

  ok(res, {
    exam,
    rows: rows.map((r) => ({
      id: Number(r.id),
      name: r.student_name,
      no: r.student_no || '',
      uid: r.user_id == null ? null : Number(r.user_id),
      s: jsonCol(r.scores) || {},
      schoolRank: r.school_rank == null ? null : Number(r.school_rank),
      leagueRank: r.league_rank == null ? null : Number(r.league_rank),
      note: r.note || '',
    })),
    serverTime: Date.now(),
  });
}

/** 我的历次成绩（按时间正序），用于个人画像的趋势与进退步。 */
async function getMe(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;

  const sql = getSql();
  const rows = await sql`
    select e.id as exam_id, e.name, e.exam_date, e.exam_type, e.subjects,
           s.scores, s.school_rank, s.league_rank, s.student_name
      from exam_scores s
      join exams e on e.id = s.exam_id
     where s.user_id = ${u.id}
       and e.status = 'published'
     order by e.exam_date asc, e.id asc`;

  ok(res, {
    items: rows.map((r) => ({
      examId: Number(r.exam_id),
      name: r.name,
      date: fmtDate(r.exam_date),
      type: r.exam_type || '',
      subjects: jsonCol(r.subjects) || [],
      s: jsonCol(r.scores) || {},
      schoolRank: r.school_rank == null ? null : Number(r.school_rank),
      leagueRank: r.league_rank == null ? null : Number(r.league_rank),
    })),
    userName: u.displayName || u.username || '',
    serverTime: Date.now(),
  });
}

/** 成绩分析的全局配置（分享开关、默认口径、年级人数默认值等） */
async function getConfig(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;

  const sql = getSql();
  const cfg = await loadConfig(sql);
  /* 配置里有面向学生的开关，也有偏管理项的项；学生只拿到该看的。
     （目前全是展示开关，没有机密内容，整份返回即可。） */
  ok(res, { config: cfg, isAdmin: u.role === 'admin' });
}

/** 建考试用的元数据：默认科目、默认分数线、可选类型 */
async function getMeta(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;
  ok(res, {
    defaultSubjects: DEFAULT_SUBJECTS,
    defaultCutlines: DEFAULT_CUTLINES,
    examTypes: EXAM_TYPES,
  });
}

/* ============================================================
 * 写接口（全部要求管理员）
 * ============================================================ */

async function handlePost(req, res, action) {
  switch (action) {
    case 'exam-save':    return await examSave(req, res);
    case 'exam-delete':  return await examDelete(req, res);
    case 'exam-publish': return await examPublish(req, res);
    case 'scores-import': return await scoresImport(req, res);
    case 'scores-save':  return await scoresSave(req, res);
    case 'row-delete':   return await rowDelete(req, res);
    case 'config-save':  return await configSave(req, res);
    default:             return fail(res, 400, '未知的写入动作：' + (action || '(空)'));
  }
}

/** 新建 / 更新一次考试（带 id 就是更新） */
async function examSave(req, res) {
  const u = await requireAdmin(req, res);
  if (!u) return;

  const b = await body(req);
  const id = Number(b.id || 0);

  const name = String(b.name || '').trim();
  if (!name) return fail(res, 400, '考试名称必填');
  if (name.length > MAX_NAME) return fail(res, 400, `考试名称不能超过 ${MAX_NAME} 字`);

  const date = String(b.exam_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return fail(res, 400, '考试时间格式应为 YYYY-MM-DD（进退步和趋势全靠它排序）');
  }

  /* 考试可以跨天（如 5/14—15 的联考）。结束日期可空；填了就必须不早于开始日期。 */
  let endDate = String(b.exam_end_date || '').trim();
  if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return fail(res, 400, '结束日期格式应为 YYYY-MM-DD（不跨天就留空）');
  }
  if (endDate && endDate < date) {
    return fail(res, 400, '结束日期不能早于开始日期');
  }
  if (endDate === date) endDate = '';   /* 同一天等于没填 */

  const typeRaw = String(b.exam_type || '').trim();
  const examType = typeRaw.length > 20 ? typeRaw.slice(0, 20) : typeRaw;

  const subjects = normalizeSubjects(b.subjects);
  if (!subjects.length) return fail(res, 400, '至少要配置一科');

  const cutlines = normalizeCutlines(b.cutlines);
  const gradeRef = normalizeGradeRef(b.grade_ref);
  const note = String(b.note || '').trim().slice(0, MAX_NOTE);

  const sql = getSql();

  if (id) {
    const chk = await sql`select id from exams where id = ${id}`;
    if (!chk.length) return fail(res, 404, '该考试不存在或已被删除');

    await sql`
      update exams
         set name = ${name},
             exam_date = ${date},
             exam_end_date = ${endDate || null},
             exam_type = ${examType || null},
             subjects = ${JSON.stringify(subjects)}::jsonb,
             cutlines = ${JSON.stringify(cutlines)}::jsonb,
             grade_ref = ${gradeRef ? JSON.stringify(gradeRef) : null}::jsonb,
             note = ${note || null},
             updated_at = now()
       where id = ${id}`;

    await audit(u.id, 'score-exam-update', 'exam', id, name);
    const row = await sql`select * from exams where id = ${id}`;
    return ok(res, { exam: normalizeExam(row[0]), created: false });
  }

  const ins = await sql`
    insert into exams (name, exam_date, exam_end_date, exam_type, subjects, cutlines, grade_ref, note, status, created_by)
    values (${name}, ${date}, ${endDate || null}, ${examType || null},
            ${JSON.stringify(subjects)}::jsonb,
            ${JSON.stringify(cutlines)}::jsonb,
            ${gradeRef ? JSON.stringify(gradeRef) : null}::jsonb,
            ${note || null}, 'draft', ${u.id})
    returning *`;

  await audit(u.id, 'score-exam-create', 'exam', Number(ins[0].id), name);
  return ok(res, { exam: normalizeExam(ins[0]), created: true });
}

/** 删除整次考试（连带成绩一起删，靠外键 cascade） */
async function examDelete(req, res) {
  const u = await requireAdmin(req, res);
  if (!u) return;

  const b = await body(req);
  const id = Number(b.id || 0);
  if (!id) return fail(res, 400, '缺少考试 id');

  const sql = getSql();
  const ex = await sql`select name from exams where id = ${id}`;
  if (!ex.length) return fail(res, 404, '该考试不存在或已被删除');

  await sql`delete from exams where id = ${id}`;
  await audit(u.id, 'score-exam-delete', 'exam', id, ex[0].name);
  ok(res, { deleted: id });
}

/** 发布 / 撤回。未发布的考试学生看不到。 */
async function examPublish(req, res) {
  const u = await requireAdmin(req, res);
  if (!u) return;

  const b = await body(req);
  const id = Number(b.id || 0);
  const publish = b.publish !== false;
  if (!id) return fail(res, 400, '缺少考试 id');

  const sql = getSql();
  const cnt = await sql`select count(*)::int as n from exam_scores where exam_id = ${id}`;
  if (publish && !Number(cnt[0].n)) {
    return fail(res, 400, '这次考试还没有任何成绩，先导入或录入再发布');
  }

  await sql`
    update exams
       set status = ${publish ? 'published' : 'draft'},
           published_at = ${publish ? new Date().toISOString() : null},
           updated_at = now()
     where id = ${id}`;

  await audit(u.id, publish ? 'score-exam-publish' : 'score-exam-unpublish', 'exam', id, '');
  ok(res, { id, status: publish ? 'published' : 'draft' });
}

/**
 * 导入成绩 —— **整体替换本次**。
 *
 * 为什么整体替换：站主一年只录 6~8 次大型考试，导入的是一张完整的成绩单，
 * 「本次 = 表里这些行」是最符合直觉的语义。好处是不存在重名冲突
 * （真有同名同学也能各占一行），也不会「第二次导入把人搞重复」。
 *
 * 配套约定：exam_scores **不建唯一索引**（靠姓名认人，同名要能共存），
 * 表内重复姓名由下面的 seen 集合拦下并提示，不影响其他行入库。
 */
async function scoresImport(req, res) {
  const u = await requireAdmin(req, res);
  if (!u) return;

  const b = await body(req);
  const examId = Number(b.exam || b.examId || 0);
  if (!examId) return fail(res, 400, '缺少考试 id');

  const raw = Array.isArray(b.rows) ? b.rows : [];
  if (!raw.length) return fail(res, 400, '没有可导入的成绩行');
  if (raw.length > MAX_ROWS) return fail(res, 400, `一次最多导入 ${MAX_ROWS} 行`);

  const size = JSON.stringify(raw).length;
  if (size > MAX_IMPORT_BYTES) return fail(res, 400, '导入数据过大，请分次或检查格式');

  const sql = getSql();
  const ex = await sql`select id, subjects from exams where id = ${examId}`;
  if (!ex.length) return fail(res, 404, '该考试不存在或已被删除');

  const subjects = jsonCol(ex[0].subjects) || [];
  const subKeys = subjects.map((s) => String(s.key));

  /* 逐行清洗：只保留配置里有的科目，分数转数字或 null */
  const clean = [];
  const skipped = [];
  const seen = new Set();

  for (const r of raw) {
    const name = String((r && r.name) || '').trim();
    if (!name) { skipped.push({ reason: '姓名为空', row: r }); continue; }
    if (name.length > 30) { skipped.push({ reason: '姓名过长：' + name.slice(0, 10), row: r }); continue; }
    if (seen.has(name)) { skipped.push({ reason: '同名重复（只保留第一行）：' + name, row: r }); continue; }
    seen.add(name);

    const s = cleanScores(r.s, subKeys);
    clean.push({
      name,
      no: String((r && r.no) || '').trim().slice(0, 30) || null,
      s,
      schoolRank: toIntOrNull(r && r.schoolRank),
      leagueRank: toIntOrNull(r && r.leagueRank),
      note: String((r && r.note) || '').trim().slice(0, MAX_NOTE) || null,
    });
  }

  if (!clean.length) return fail(res, 400, '清洗后没有有效数据，请检查表格');

  /* 姓名 → 站点用户 id：导入时顺手把成绩绑到账号上，学生登录后就能看到自己 */
  const users = await sql`select id, display_name, username from users where status = 'active'`;
  const byName = new Map();
  users.forEach((x) => {
    const n = String(x.display_name || '').trim();
    if (n && !byName.has(n)) byName.set(n, Number(x.id));
    const un = String(x.username || '').trim();
    if (un && !byName.has(un)) byName.set(un, Number(x.id));
  });
  const unmatched = [];
  clean.forEach((r) => {
    const uid = byName.get(r.name);
    if (uid) r.uid = uid;
    else unmatched.push(r.name);
  });

  /* 一次性写入：整体替换 = 先清空本次，再批量插入。
     jsonb_to_recordset 把整个数组当一个参数传，只占一次数据库往返。 */
  const payload = JSON.stringify(clean.map((r) => ({
    name: r.name, no: r.no, uid: r.uid || null,
    s: JSON.stringify(r.s), sr: r.schoolRank, lr: r.leagueRank, note: r.note,
  })));

  await sql`delete from exam_scores where exam_id = ${examId}`;
  await sql`
    insert into exam_scores (exam_id, student_name, student_no, user_id, scores, school_rank, league_rank, note)
    select ${examId},
           x.name, x.no, x.uid, x.s::jsonb, x.sr, x.lr, x.note
      from jsonb_to_recordset(${payload}::jsonb) as x(
             name text, no text, uid bigint, s text, sr int, lr int, note text
           )`;

  await audit(u.id, 'score-import', 'exam', examId, `导入 ${clean.length} 行`);

  ok(res, {
    imported: clean.length,
    skipped: skipped.map((s) => s.reason).slice(0, 20),
    skippedCount: skipped.length,
    unmatched: unmatched.slice(0, 30),
    unmatchedCount: unmatched.length,
  });
}

/**
 * 增量保存（后台编辑表用：点格改、块粘贴后失焦保存）。
 * 只提交改动过的行，每行带自己的 id。
 */
async function scoresSave(req, res) {
  const u = await requireAdmin(req, res);
  if (!u) return;

  const b = await body(req);
  const examId = Number(b.exam || b.examId || 0);
  if (!examId) return fail(res, 400, '缺少考试 id');

  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (!rows.length) return fail(res, 400, '没有要保存的行');
  if (rows.length > MAX_ROWS) return fail(res, 400, '一次改动太多，请分批保存');

  const sql = getSql();
  const ex = await sql`select id, subjects from exams where id = ${examId}`;
  if (!ex.length) return fail(res, 404, '该考试不存在或已被删除');
  const subKeys = (jsonCol(ex[0].subjects) || []).map((s) => String(s.key));

  let updated = 0, inserted = 0;

  for (const r of rows) {
    const id = Number(r.id || 0);
    const name = String(r.name || '').trim();
    if (!name) continue;

    const s = cleanScores(r.s, subKeys);
    const no = String(r.no || '').trim().slice(0, 30) || null;
    const sr = toIntOrNull(r.schoolRank);
    const lr = toIntOrNull(r.leagueRank);
    const nt = String(r.note || '').trim().slice(0, MAX_NOTE) || null;

    if (id) {
      await sql`
        update exam_scores
           set student_name = ${name}, student_no = ${no}, scores = ${JSON.stringify(s)}::jsonb,
               school_rank = ${sr}, league_rank = ${lr}, note = ${nt}, updated_at = now()
         where id = ${id} and exam_id = ${examId}`;
      updated++;
    } else {
      /* 新增行（比如中途转来的同学）——顺手按姓名绑账号 */
      const uid = await matchUserId(sql, name);
      await sql`
        insert into exam_scores (exam_id, student_name, student_no, user_id, scores, school_rank, league_rank, note)
        values (${examId}, ${name}, ${no}, ${uid}, ${JSON.stringify(s)}::jsonb, ${sr}, ${lr}, ${nt})`;
      inserted++;
    }
  }

  await audit(u.id, 'score-save', 'exam', examId, `更新 ${updated} 行 / 新增 ${inserted} 行`);
  ok(res, { updated, inserted });
}

/** 删掉某一行（比如误导入的外班同学） */
async function rowDelete(req, res) {
  const u = await requireAdmin(req, res);
  if (!u) return;

  const b = await body(req);
  const id = Number(b.id || 0);
  const examId = Number(b.exam || 0);
  if (!id || !examId) return fail(res, 400, '缺少行 id 或考试 id');

  const sql = getSql();
  await sql`delete from exam_scores where id = ${id} and exam_id = ${examId}`;
  await audit(u.id, 'score-row-delete', 'exam_score', id, '');
  ok(res, { deleted: id });
}

/** 保存成绩分析的全局配置 */
async function configSave(req, res) {
  const u = await requireAdmin(req, res);
  if (!u) return;

  const b = await body(req);
  const patch = (b && typeof b.config === 'object' && b.config) || {};
  const sql = getSql();
  const cur = await loadConfig(sql);
  const next = { ...cur, ...sanitizeConfig(patch) };

  await sql`
    insert into score_config (id, data, updated_at)
    values (1, ${JSON.stringify(next)}::jsonb, now())
    on conflict (id) do update set data = ${JSON.stringify(next)}::jsonb, updated_at = now()`;

  await audit(u.id, 'score-config-save', 'score_config', 1, '');
  ok(res, { config: next });
}

/* ============================================================
 * 工具
 * ============================================================ */

/** 把数据库行转成前端用的考试对象（jsonb 列统一过一遍 jsonCol） */
function normalizeExam(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    name: r.name,
    date: fmtDate(r.exam_date),
    /* 考试可以跨天（例：5 月 14—15 日联考）。只考一天时为空。 */
    endDate: r.exam_end_date ? fmtDate(r.exam_end_date) : null,
    type: r.exam_type || '',
    note: r.note || '',
    status: r.status === 'published' ? 'published' : 'draft',
    publishedAt: r.published_at ? String(r.published_at) : null,
    updatedAt: r.updated_at ? String(r.updated_at) : null,
    subjects: jsonCol(r.subjects) || [],
    cutlines: jsonCol(r.cutlines) || [],
    gradeRef: jsonCol(r.grade_ref) || null,
    rowCount: r.row_count == null ? undefined : Number(r.row_count),
  };
}

/** date 列在不同驱动下可能是 Date 也可能是字符串，统一成 YYYY-MM-DD */
function fmtDate(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  try {
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v).slice(0, 10);
    const p = (n) => String(n).padStart(2, '0');
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  } catch {
    return String(v).slice(0, 10);
  }
}

/** 科目配置清洗 */
function normalizeSubjects(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const s of arr) {
    if (!s) continue;
    const key = String(s.key || '').trim().slice(0, 20);
    const name = String(s.name || '').trim().slice(0, 20);
    if (!key || !name) continue;
    const full = Number(s.full);
    out.push({
      key,
      name,
      full: Number.isFinite(full) && full > 0 && full <= 1000 ? Math.round(full) : 100,
      graded: !!s.graded,
    });
    if (out.length >= MAX_SUBJECTS) break;
  }
  /* 去重（同 key 只留第一个） */
  const seen = new Set();
  return out.filter((s) => (seen.has(s.key) ? false : (seen.add(s.key), true)));
}

/** 分数线清洗。score 允许为空 —— 空 = 这次学校没公布，不画也不统计。 */
function normalizeCutlines(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const c of arr) {
    if (!c) continue;
    const label = String(c.label || '').trim().slice(0, 20);
    if (!label) continue;
    const score = c.score === '' || c.score == null ? null : Number(c.score);
    out.push({
      key: String(c.key || label).trim().slice(0, 20),
      label,
      /* ⚠️ 分数线必须支持小数 —— 真实划线经常是半分（例：本科线 361.5）。
         所以这里只保留一位小数、**不取整**，否则 361.5 会被悄悄变成 362，
         上线人数就跟着算错一个人。 */
      score: (Number.isFinite(score) && score >= 0 && score <= 1500) ? Math.round(score * 10) / 10 : null,
      color: /^#[0-9a-fA-F]{3,8}$/.test(String(c.color || '')) ? String(c.color) : '#b45309',
    });
    if (out.length >= MAX_CUTLINES) break;
  }
  return out;
}

/** 年级参照（可选）：年级人数、年级均分 */
function normalizeGradeRef(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const students = toIntOrNull(raw.students);
  const avgTotal = numOrNull(raw.avgTotal);
  const avgSubject = {};
  if (raw.avgSubject && typeof raw.avgSubject === 'object') {
    for (const k of Object.keys(raw.avgSubject)) {
      const v = numOrNull(raw.avgSubject[k]);
      if (v != null) avgSubject[String(k).slice(0, 20)] = v;
    }
  }
  if (students == null && avgTotal == null && !Object.keys(avgSubject).length) return null;
  return { students, avgTotal, avgSubject };
}

/** 每科成绩清洗：{ 科目key: {raw, assigned} }，只保留配置里有的科目 */
function cleanScores(raw, subKeys) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const allow = new Set(subKeys);
  const out = {};
  for (const k of Object.keys(src)) {
    if (allow.size && !allow.has(k)) continue;
    const v = src[k];
    if (v == null) continue;
    if (typeof v === 'object') {
      const r = numOrNull(v.raw);
      const a = numOrNull(v.assigned);
      if (r == null && a == null) continue;
      out[k] = a == null ? { raw: r } : { raw: r, assigned: a };
    } else {
      const n = numOrNull(v);
      if (n == null) continue;
      out[k] = { raw: n };
    }
  }
  return out;
}

function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toIntOrNull(v) {
  const n = numOrNull(v);
  return n == null ? null : Math.round(n);
}

/** 按姓名找站点账号（导入/新增时顺手绑定）
 *  ⚠️ users 表的显示名列叫 display_name（不是 name），别写错。 */
async function matchUserId(sql, name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const r = await sql`
    select id from users
     where status = 'active' and (display_name = ${n} or username = ${n})
     order by id limit 1`;
  return r.length ? Number(r[0].id) : null;
}

/** 读取全局配置（没有就用默认） */
const DEFAULT_CONFIG = {
  /* 进退步默认看几次：'3' | '5' | 'all'（站主只录大考，一年才 6~8 次，默认 all 更合适） */
  trendDefault: 'all',
  /* 标签类内容对外展开档：'hide' 完全隐藏 | 'self' 只给本人看自己那条 | 'all' 全班可见 */
  tailRank: 'hide',      // 退步榜
  watchList: 'hide',     // 需关注学生
  quadrant: 'hide',      // 分层教学四象限
  diagnosis: 'hide',     // 诊断卡
  /* 学生能不能生成分享链接：'none' 不允许 | 'self' 只能分自己 | 'all' 可分享全班 */
  shareByStudent: 'self',
  /* 分享链接默认有效期（天） */
  shareDays: 7,
  /* 排名口径默认：'graded' 总分赋分 | 'raw' 总分原始 */
  rankBasis: 'graded',
  /* 成绩分析总开关：'published' 学生可见已发布 | 'off' 整个功能对学生关闭 */
  access: 'published',
};

async function loadConfig(sql) {
  try {
    const r = await sql`select data from score_config where id = 1`;
    const val = r.length ? jsonCol(r[0].data) : null;
    return { ...DEFAULT_CONFIG, ...(val && typeof val === 'object' ? val : {}) };
  } catch {
    /* 表还没建出来（首次部署）不能让整个接口挂掉 */
    return { ...DEFAULT_CONFIG };
  }
}

function sanitizeConfig(patch) {
  const out = {};
  const pick = (k, allow) => {
    if (patch[k] !== undefined && allow.indexOf(String(patch[k])) >= 0) out[k] = String(patch[k]);
  };
  pick('trendDefault', ['3', '5', 'all']);
  pick('tailRank', ['hide', 'self', 'all']);
  pick('watchList', ['hide', 'self', 'all']);
  pick('quadrant', ['hide', 'self', 'all']);
  pick('diagnosis', ['hide', 'self', 'all']);
  pick('shareByStudent', ['none', 'self', 'all']);
  pick('rankBasis', ['graded', 'raw']);
  pick('access', ['published', 'off']);
  if (patch.shareDays !== undefined) {
    const n = Number(patch.shareDays);
    if (Number.isFinite(n) && n >= 1 && n <= 3650) out.shareDays = Math.round(n);
  }
  return out;
}
