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
    /* 姓名对照（v2.9.5）：列出成绩表里没绑上账号的姓名，供站主一键关联 */
    case 'unbound': return await unboundNames(req, res);
    /* 分享链接取数：**免登录**（链接本身就是凭证） */
    case 'share-get': return await shareGet(req, res);
    case 'backup-list':   return await backupList(req, res);
    case 'backup-get':    return await backupGet(req, res);
    case 'backup-export': return await backupExport(req, res);
    default:       return fail(res, 400, '未知的读取动作：' + (action || '(空)'));
  }
}

/** 考试列表。学生只看到已发布的；管理员看到全部（含草稿）。 */
async function getList(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;

  const sql = getSql();
  const isAdmin = u.role === 'admin';

  /* ⚠️ exam_end_date 必须选出来：v2.7.4 加了「考试可跨天」，但列表这条 SQL
     当时漏了这个字段 → normalizeExam 拿不到 → 列表里永远显示成单日。
     （后台新建时填了 5/14—15，列表里还是只显示 5/14，就是这么来的。） */
  const rows = isAdmin
    ? await sql`
        select e.id, e.name, e.exam_date, e.exam_end_date, e.exam_type, e.subjects, e.cutlines,
               e.grade_ref, e.note, e.status, e.published_at, e.updated_at,
               (select count(*) from exam_scores s where s.exam_id = e.id) as row_count
          from exams e
         /* 2026-10-16 v2.10.0：补 nulls last。
            PG 的 DESC 默认 NULLS FIRST —— 没填日期的考试会漂到列表最顶部，
            表现为「录入时序混乱」。站主要求：录入顺序不受限，一律按考试时间排，
            空日期沉底（asc 的端点 PG 默认就是 NULLS LAST，无需改）。 */
         order by e.exam_date desc nulls last, e.id desc`
    : await sql`
        select e.id, e.name, e.exam_date, e.exam_end_date, e.exam_type, e.subjects, e.cutlines,
               e.grade_ref, e.note, e.status, e.published_at, e.updated_at,
               (select count(*) from exam_scores s where s.exam_id = e.id) as row_count
          from exams e
         where e.status = 'published'
         /* 2026-10-16 v2.10.0：补 nulls last。
            PG 的 DESC 默认 NULLS FIRST —— 没填日期的考试会漂到列表最顶部，
            表现为「录入时序混乱」。站主要求：录入顺序不受限，一律按考试时间排，
            空日期沉底（asc 的端点 PG 默认就是 NULLS LAST，无需改）。 */
         order by e.exam_date desc nulls last, e.id desc`;

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

  const cfg = await loadConfig(sql);
  const myNames = namesOfUser(u, cfg.nameMap);

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
      /* 「这条是不是我的」由后端算好：成绩表里写成别名（改过名）也能认出来。
         没绑 uid 的行才需要按姓名比 —— 绑了就以 uid 为准。 */
      mine: r.user_id == null
        ? myNames.indexOf(String(r.student_name || '').trim()) >= 0
        : Number(r.user_id) === Number(u.id),
    })),
    serverTime: Date.now(),
  });
}

/** 我的历次成绩（按时间正序），用于个人画像的趋势与进退步。 */
async function getMe(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;

  const sql = getSql();
  const isAdmin = u.role === 'admin';
  /* 认人认两路：绑好的 user_id，以及「姓名（含别名）对得上」。
     后者是为了兜住 uid 没绑上的情况（改过名、历史导入），学生照样能看到自己。 */
  const cfg = await loadConfig(sql);
  const myNames = namesOfUser(u, cfg.nameMap);
  /* 管理员能看到草稿（方便发布前自查趋势），学生只看已发布 —— 与 list 一致。
     另外把每次考试的分数线与年级参照一并返回：前端的「跨考试上线率趋势」
     和「年级百分位」都要用，省得前端为每次考试再跑一趟 board。 */
  const rows = await sql`
    select e.id as exam_id, e.name, e.exam_date, e.exam_end_date, e.exam_type,
           e.subjects, e.cutlines, e.grade_ref,
           s.scores, s.school_rank, s.league_rank, s.student_name
      from exam_scores s
      join exams e on e.id = s.exam_id
     where (s.user_id = ${u.id} or s.student_name = any(${myNames}::text[]))
       and (e.status = 'published' or ${isAdmin})
     order by e.exam_date asc, e.id asc`;

  ok(res, {
    items: rows.map((r) => ({
      examId: Number(r.exam_id),
      name: r.name,
      date: fmtDate(r.exam_date),
      endDate: r.exam_end_date ? fmtDate(r.exam_end_date) : null,
      type: r.exam_type || '',
      subjects: jsonCol(r.subjects) || [],
      cutlines: jsonCol(r.cutlines) || [],
      gradeRef: jsonCol(r.grade_ref) || null,
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
  const isAdmin = u.role === 'admin';
  /* 姓名对照是「谁的两种叫法」，属于隐私，只给站主。
     （其余都是展示开关，没有机密内容，整份返回即可。） */
  const safe = Object.assign({}, cfg);
  if (!isAdmin) delete safe.nameMap;
  ok(res, { config: safe, isAdmin });
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
    case 'config-save':    return await configSave(req, res);
    case 'name-bind':      return await nameBind(req, res);
    case 'share-create':   return await shareCreate(req, res);
    case 'share-revoke':   return await shareRevoke(req, res);
    case 'share-list':     return await shareList(req, res);
    case 'backup-run':     return await backupRun(req, res);
    case 'backup-restore': return await backupRestore(req, res);
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

  /* 姓名 → 站点用户 id：导入时顺手把成绩绑到账号上，学生登录后就能看到自己。
     匹配前先过一遍「姓名对照」——成绩表写「雷博雅」、账号叫「雷其桐」也认得出是同一个人。 */
  const cfg = await loadConfig(sql);
  const nameMap = cfg.nameMap || {};
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
    const uid = byName.get(canonName(r.name, nameMap));
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

  /* ⚠️ 一样要批量：Workers 免费版每请求上限 50 个子请求，
     逐条 update 的话「块粘贴」几十行就会 500。分两批：有 id 的整批更新、没 id 的整批新增。
     顺手按姓名（过一遍「姓名对照」）重算一次该绑哪个账号 —— 改过名字或新配了对照，这里就自动跟上。 */
  const cfg = await loadConfig(sql);
  const nameMap = cfg.nameMap || {};
  const users = await sql`select id, display_name, username from users where status = 'active'`;
  const byName = new Map();
  users.forEach((x) => {
    const n = String(x.display_name || '').trim();
    if (n && !byName.has(n)) byName.set(n, Number(x.id));
    const un = String(x.username || '').trim();
    if (un && !byName.has(un)) byName.set(un, Number(x.id));
  });

  const upd = [], ins = [];
  for (const r of rows) {
    const id = Number(r.id || 0);
    const name = String(r.name || '').trim();
    if (!name) continue;
    const item = {
      id,
      student_name: name,
      student_no: String(r.no || '').trim().slice(0, 30) || null,
      uid: byName.get(canonName(name, nameMap)) || null,
      scores: cleanScores(r.s, subKeys),
      school_rank: toIntOrNull(r.schoolRank),
      league_rank: toIntOrNull(r.leagueRank),
      note: String(r.note || '').trim().slice(0, MAX_NOTE) || null,
    };
    if (id) upd.push(item); else ins.push(item);
  }

  let updated = 0, inserted = 0;

  if (upd.length) {
    const back = await sql`
      update exam_scores t
         set student_name = x.student_name, student_no = x.student_no,
             user_id = coalesce(x.uid, t.user_id),
             scores = coalesce(x.scores, '{}'::jsonb),
             school_rank = x.school_rank, league_rank = x.league_rank,
             note = x.note, updated_at = now()
        from jsonb_to_recordset(${JSON.stringify(upd)}::jsonb) as x(
          id bigint, student_name text, student_no text, scores jsonb,
          school_rank int, league_rank int, note text, uid bigint)
       where t.id = x.id and t.exam_id = ${examId}
      returning t.id`;
    updated = back.length;
  }

  if (ins.length) {
    /* 新增行（比如中途转来的同学）——账号在这一批里就已经算好了，不用再 join 一次 */
    const back = await sql`
      insert into exam_scores (exam_id, user_id, student_name, student_no, scores, school_rank, league_rank, note)
      select ${examId}, x.uid, x.student_name, x.student_no,
             coalesce(x.scores, '{}'::jsonb), x.school_rank, x.league_rank, x.note
        from jsonb_to_recordset(${JSON.stringify(ins)}::jsonb) as x(
          student_name text, student_no text, scores jsonb, school_rank int, league_rank int, note text, uid bigint)
      returning id`;
    inserted = back.length;
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
/* ============================================================
   分享链接（R38）
   ------------------------------------------------------------
   免登录只读。**谁能拿到链接谁就能看，转发出去控制不了**，
   所以默认给得保守：学生只能分自己、默认 7 天、可撤销、可限次数。
   ============================================================ */

/** 随机 token（24 字节 → 32 位 base64url，够用且短） */
function shareToken() {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function shareCreate(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;

  const b = await body(req);
  const sql = getSql();
  const cfg = await loadConfig(sql);
  const isAdmin = u.role === 'admin';

  let scope = String(b.scope || 'self');
  if (['self', 'picked', 'class'].indexOf(scope) < 0) return fail(res, 400, '分享范围不对');

  /* 学生受后台开关限制 */
  if (!isAdmin) {
    const allow = cfg.shareByStudent || 'none';
    if (allow === 'none') return fail(res, 403, '老师还没有开放分享功能');
    if (allow === 'self' && scope !== 'self') return fail(res, 403, '只能分享自己的成绩');
  }

  /* 有效期：0 表示永久 */
  let days = Number(b.days);
  if (!Number.isFinite(days) || days < 0) days = Number(cfg.shareDays) || 7;
  if (days > 3650) days = 3650;

  const examIds = (Array.isArray(b.examIds) ? b.examIds : [])
    .map(Number).filter(Number.isFinite).slice(0, 50);

  let names = [];
  if (scope === 'picked') {
    names = (Array.isArray(b.names) ? b.names : [])
      .map((x) => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, 120);
    if (!names.length) return fail(res, 400, '自选分享至少要选一位同学');
  }

  const maxViews = Number.isFinite(Number(b.maxViews)) && Number(b.maxViews) > 0
    ? Math.min(100000, Math.round(Number(b.maxViews))) : null;

  /* 分享内容（v2.9.7 站主：「分析也可以自定义分享内容」）。
     支持 board（全班成绩单）/ card（个人成绩卡）。
     老链接没有这个字段，读取时一律按「都有」处理 —— 向后兼容。 */
  const rawSec = (b.sections && typeof b.sections === 'object' && !Array.isArray(b.sections)) ? b.sections : {};
  const sections = {
    board: rawSec.board !== false,
    card: rawSec.card !== false,
  };
  if (!sections.board && !sections.card) return fail(res, 400, '至少选一项分享内容，不然点开是空白');

  const token = shareToken();

  const ins = await sql`
    insert into share_links (token, scope, owner_id, target_names, exam_ids, sections, expires_at, max_views)
    values (${token}, ${scope}, ${u.id},
            ${names.length ? JSON.stringify(names) : null}::jsonb,
            ${examIds.length ? examIds : null},
            ${JSON.stringify(sections)}::jsonb,
            ${days > 0 ? new Date(Date.now() + days * 86400000) : null},
            ${maxViews})
    returning id`;

  await audit(u.id, 'score-share-create', 'share_link', Number(ins[0].id), scope + '/' + days + 'd');

  ok(res, {
    id: Number(ins[0].id),
    token,
    url: '/share.html?t=' + token,
    scope,
    sections,
    days,
    expiresAt: days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null,
  });
}

async function shareRevoke(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;
  const b = await body(req);
  const id = Number(b.id || 0);
  if (!id) return fail(res, 400, '缺少分享 id');

  const sql = getSql();
  const rows = await sql`select id, owner_id from share_links where id = ${id}`;
  if (!rows.length) return fail(res, 404, '找不到这条分享');
  if (u.role !== 'admin' && Number(rows[0].owner_id) !== Number(u.id)) {
    return fail(res, 403, '只能撤销自己建的分享');
  }
  await sql`update share_links set revoked = true where id = ${id}`;
  await audit(u.id, 'score-share-revoke', 'share_link', id, '');
  ok(res, { revoked: id });
}

async function shareList(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;
  const sql = getSql();
  const isAdmin = u.role === 'admin';
  const rows = isAdmin
    ? await sql`
        select s.*, u.display_name as owner_name
          from share_links s left join users u on u.id = s.owner_id
         order by s.created_at desc limit 100`
    : await sql`
        select s.*, u.display_name as owner_name
          from share_links s left join users u on u.id = s.owner_id
         where s.owner_id = ${u.id}
         order by s.created_at desc limit 100`;

  ok(res, { isAdmin, shares: rows.map(shareShape) });
}

function shareShape(r) {
  const expired = r.expires_at ? new Date(r.expires_at).getTime() < Date.now() : false;
  const used = r.max_views != null && Number(r.views) >= Number(r.max_views);
  /* 老链接没写过 sections → 按「都有」处理（向后兼容，别让老链接变空白） */
  const sec = jsonCol(r.sections) || {};
  const sections = {
    board: sec.board !== false,
    card: sec.card !== false,
  };
  return {
    id: Number(r.id),
    token: r.token,
    url: '/share.html?t=' + r.token,
    scope: r.scope,
    sections,
    ownerName: r.owner_name || '',
    names: jsonCol(r.target_names) || [],
    examIds: Array.isArray(r.exam_ids) ? r.exam_ids.map(Number) : [],
    createdAt: r.created_at ? String(r.created_at) : null,
    expiresAt: r.expires_at ? String(r.expires_at) : null,
    maxViews: r.max_views == null ? null : Number(r.max_views),
    views: Number(r.views) || 0,
    revoked: !!r.revoked,
    expired,
    usedUp: used,
    alive: !r.revoked && !expired && !used,
  };
}

/** 免登录取数：链接本身就是凭证 */
async function shareGet(req, res) {
  const token = String(req.query.t || '').trim();
  if (!token || token.length > 80) return fail(res, 400, '缺少链接标识');

  const sql = getSql();
  const rows = await sql`select * from share_links where token = ${token}`;
  if (!rows.length) return fail(res, 404, '这个分享链接不存在（可能已被删除）');
  const s0 = rows[0];

  if (s0.revoked) return fail(res, 410, '这个分享已被撤销');
  if (s0.expires_at && new Date(s0.expires_at).getTime() < Date.now()) return fail(res, 410, '这个分享已过期');
  if (s0.max_views != null && Number(s0.views) >= Number(s0.max_views)) {
    return fail(res, 410, '这个分享的查看次数已用完');
  }
  await sql`update share_links set views = views + 1 where id = ${s0.id}`;

  const ids = Array.isArray(s0.exam_ids) ? s0.exam_ids.map(Number).filter(Number.isFinite) : [];
  const exams = ids.length
    ? await sql`
        select * from exams
         where id = any(${ids}::bigint[])
         order by exam_date asc, id asc`
    : await sql`
        select * from exams
         where status = 'published'
         order by exam_date asc, id asc`;

  if (!exams.length) return ok(res, { share: shareShape(s0), exams: [], rows: [] });

  const examList = exams.map(normalizeExam);
  const examMap = new Map(examList.map((e) => [e.id, e]));

  const sc = await sql`
    select exam_id, user_id, student_name, scores, school_rank, league_rank
      from exam_scores
     where exam_id = any(${examList.map((e) => e.id)}::bigint[])
     order by exam_id, id`;

  const names = jsonCol(s0.target_names) || [];
  const out = [];
  sc.forEach((r) => {
    const eid = Number(r.exam_id);
    /* 范围过滤：self 只给分享者自己；picked 只给点名的那些 */
    if (s0.scope === 'self' && Number(r.user_id) !== Number(s0.owner_id)) return;
    if (s0.scope === 'picked' && names.indexOf(String(r.student_name)) < 0) return;
    out.push({
      examId: eid,
      name: r.student_name,
      s: jsonCol(r.scores) || {},
      schoolRank: r.school_rank == null ? null : Number(r.school_rank),
      leagueRank: r.league_rank == null ? null : Number(r.league_rank),
      isOwner: Number(r.user_id) === Number(s0.owner_id),
    });
  });

  /* 明细被裁剪过（self / picked）时，额外补一份「按全班算好的统计量」，
     否则分享页只有一两个人，班均/名次全变成 0（见 statOfExam 的说明）。 */
  const needStats = s0.scope !== 'class';
  const stats = {};
  if (needStats) {
    examList.forEach((e) => {
      const rowsOfExam = sc.filter((r) => Number(r.exam_id) === Number(e.id));
      stats[e.id] = {
        graded: statOfExam(e, rowsOfExam, 'graded', s0.owner_id),
        raw: statOfExam(e, rowsOfExam, 'raw', s0.owner_id),
      };
    });
  }

  ok(res, {
    share: shareShape(s0),
    exams: examList,
    rows: out,
    stats: needStats ? stats : null,
  });
}

/* ============================================================
   班情聚合（v2.9.8）
   ------------------------------------------------------------
   为什么需要它：分享范围不是「全班」时，明细只发一部分人。
   分享自己的成绩 → 分享页只拿到 1 个人 → 只能算出
   「班均＝你自己、班排名 1/1、与班均 +0」。
   站主实测反馈「与班均、班排名都显示 0」就是这个原因 ——
   不是显示坏了，是**数据不够**。

   这里按**全班**把统计量算好一并发出：只给聚合数字
   （人数 / 均分 / 中位 / 最高 / 我的名次 / 各科班均与单科名次 / 各线上线人数），
   **不带任何别人的姓名与明细**，所以不构成隐私问题。

   赋分与原始**两种口径都算好**：分享页有「总分赋分 / 总分原始」切换，
   切过去时不该又变成 0，所以两份都备着，前端直接取。

   ⚠️ rounds 到一位小数再发：浮点尾巴（12.499999）在页面上很难看。
   ============================================================ */
function round1(v) {
  return v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;
}

function statOfExam(exam, rows, basis, ownerId) {
  const subs = exam.subjects || [];
  const cuts = (exam.cutlines || []).filter((c) => c.score != null);

  /* 取某一行某一科的分；basis='graded' 时才认赋分 */
  const pick = (v, sub) => {
    if (!v) return null;
    const x = (basis === 'graded' && sub.graded && v.assigned != null) ? v.assigned : v.raw;
    return x == null ? null : Number(x);
  };

  /* 总分（本人与全班用同一套算法，否则名次会错位） */
  const totals = [];
  rows.forEach((r) => {
    const s = jsonCol(r.scores) || {};
    let t = 0, any = false;
    subs.forEach((sub) => {
      const x = pick(s[sub.key], sub);
      if (x == null) return;
      t += x; any = true;
    });
    if (any) totals.push({ r, t });
  });

  const list = totals.map((x) => x.t).slice().sort((a, b) => a - b);
  const n = list.length;
  const avg = n ? list.reduce((a, b) => a + b, 0) / n : null;

  /* 总分名次：同分并列（跟前端 scRankMap 同一套规则） */
  const sorted = totals.slice().sort((a, b) => b.t - a.t);
  let rank = 0, prev = null;
  const rankOf = new Map();
  sorted.forEach((x, i) => {
    if (prev === null || x.t !== prev) { rank = i + 1; prev = x.t; }
    rankOf.set(x.r, rank);
  });

  /* 各科：班均 + 参考人数 + 我的名次 */
  const subj = {};
  subs.forEach((sub) => {
    const arr = [];
    rows.forEach((r) => {
      const x = pick((jsonCol(r.scores) || {})[sub.key], sub);
      if (x != null) arr.push({ r, x });
    });
    arr.sort((a, b) => b.x - a.x);
    let k = 0, pv = null;
    const m = new Map();
    arr.forEach((y, i) => {
      if (pv === null || y.x !== pv) { k = i + 1; pv = y.x; }
      m.set(y.r, k);
    });
    let mine = null;
    if (ownerId != null) {
      const hit = arr.filter((y) => Number(y.r.user_id) === Number(ownerId))[0];
      if (hit) mine = m.get(hit.r) || null;
    }
    subj[sub.key] = {
      name: sub.name,
      full: sub.full == null ? null : Number(sub.full),
      avg: round1(arr.length ? arr.reduce((a, b) => a + b.x, 0) / arr.length : null),
      count: arr.length,
      rank: mine,
    };
  });

  let myRank = null, myTotal = null;
  if (ownerId != null) {
    const hit = totals.filter((x) => Number(x.r.user_id) === Number(ownerId))[0];
    if (hit) { myRank = rankOf.get(hit.r) || null; myTotal = hit.t; }
  }

  return {
    n,
    avg: round1(avg),
    med: !n ? null : round1(n % 2 ? list[(n - 1) / 2] : (list[n / 2 - 1] + list[n / 2]) / 2),
    max: n ? round1(list[n - 1]) : null,
    myRank,
    myTotal: round1(myTotal),
    subj,
    /* 每条分数线分别有多少人上线（顺序与 exam.cutlines 过滤后一致） */
    cuts: cuts.map((c) => list.filter((v) => v >= c.score).length),
  };
}

/* ============================================================
   每日备份（KV）· R37
   ------------------------------------------------------------
   ⚠️ **备份必须跨服务商**：数据在 Neon，备份放 Cloudflare KV，
      这算「异地」；如果两边都在一家，那不算真备份。
   ⚠️ **备份绝不能进公开仓库**：站点仓库是 public，
      一提交等于全班成绩公开。所以走 KV，不走 Git。
   没配 KV 时所有备份接口都会明确说「还没配存储」，不影响其它功能。
   ============================================================ */
const BACKUP_PREFIX = 'backup/';
const BACKUP_KEEP = 14;          /* KV 里最多留 14 份（两周） */

/** 取 KV 绑定（没配就返回 null） */
function getKV() {
  try {
    const env = globalThis.__ENV__;
    if (env && env.SITE_KV && typeof env.SITE_KV.get === 'function') return env.SITE_KV;
  } catch (e) {}
  return null;
}

/** 把数据库返回的 date 变成 YYYY-MM-DD。
    ⚠️ 必须做：Postgres 的 date 经驱动出来是 Date 对象，序列化后变成
   `2026-07-02T00:00:00.000Z` —— 这种格式喂回 exam-save 会被「格式应为 YYYY-MM-DD」
   挡下；直接塞给 jsonb_to_recordset 也不稳。快照里就存干净的日期。
   （2026-10-14 演练踩到的第二个坑。） */
function isoDay(v) {
  if (v == null) return null;
  /* ⚠️ 必须单独处理 Date 对象：Neon 驱动把 date 列还原成 Date 实例，
     而 String(dateObj) 得到的是 "Wed Jul 02 2026 00:00:00 GMT+0000..."，
     **不是** ISO 串 —— 光写正则会静默返回 null，快照里的日期就全丢了。
     （2026-10-14 演练抓到的第四个坑：这一条被后面的「日期不能识别就拒绝还原」
       拦住了，没让危险操作落地 —— 那道校验是有用的。） */
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return v.getUTCFullYear() + '-'
      + String(v.getUTCMonth() + 1).padStart(2, '0') + '-'
      + String(v.getUTCDate()).padStart(2, '0');
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
  return m ? m[1] : null;
}

/** 打包一份快照：成绩 + 内容数据（用户表只留脱敏信息，不还原） */
async function buildSnapshot(sql) {
  const exams = await sql`select * from exams order by id`;
  const scores = await sql`select * from exam_scores order by id`;
  const shares = await sql`
    select id, token, scope, owner_id, target_names, exam_ids,
           expires_at, max_views, views, revoked, created_at
      from share_links order by id`;
  const cfg = await sql`select data from score_config where id = 1`;
  /* 公告 / 作业 / 弹窗 / 每日一言 等全部存在 user_data 里，一并备份 */
  let userData = [];
  try {
    userData = await sql`select user_id, data_key, data_value, updated_at from user_data order by user_id, data_key`;
  } catch (e) { userData = []; }

  let users = [];
  try {
    users = await sql`select id, username, display_name, role, status from users order by id`;
  } catch (e) { users = []; }

  return {
    version: 1,
    at: new Date().toISOString(),
    kind: 'class-site-backup',
    counts: {
      exams: exams.length,
      examScores: scores.length,
      shareLinks: shares.length,
      userData: userData.length,
      users: users.length,
    },
    tables: {
      exams: exams.map((e) => Object.assign({}, e, {
        exam_date: isoDay(e.exam_date),
        exam_end_date: isoDay(e.exam_end_date),
      })),
      exam_scores: scores,
      share_links: shares,
      score_config: cfg,
      user_data: userData,
      /* ⚠️ 只记 id / 姓名，**不含密码哈希**，还原时也不会动 users 表 */
      users,
    },
  };
}

/** 供 Cron 调用：无人值守的每日备份（不经过 HTTP） */
export async function runDailyBackup() {
  const kv = getKV();
  if (!kv) return { skipped: 'no-kv' };
  const sql = getSql();
  const snap = await buildSnapshot(sql);
  const key = BACKUP_PREFIX + snap.at.replace(/[:.]/g, '-') + '.json';
  await kv.put(key, JSON.stringify(snap));
  try {
    const list = await kv.list({ prefix: BACKUP_PREFIX, limit: 100 });
    const keys = (list.keys || []).map((k) => k.name).sort();
    while (keys.length > BACKUP_KEEP) {
      const oldKey = keys.shift();
      if (oldKey !== key) await kv.delete(oldKey);
    }
  } catch (e) {}
  return { key, counts: snap.counts };
}

async function backupRun(req, res) {
  const u = await requireAdmin(req, res);
  if (!u) return;
  const sql = getSql();
  const snap = await buildSnapshot(sql);

  const kv = getKV();
  if (!kv) {
    /* 没配 KV 也把快照返回去，站主可以自己存一份，不至于白跑 */
    await audit(u.id, 'score-backup-run', 'backup', 0, 'no-kv');
    return ok(res, {
      stored: false,
      kv: false,
      snapshot: snap,
      hint: '还没配置备份存储（KV），所以这份快照只是回给你，请自己保存好。',
    });
  }

  const key = BACKUP_PREFIX + snap.at.replace(/[:.]/g, '-') + '.json';
  await kv.put(key, JSON.stringify(snap));

  /* 清掉多余的旧快照 */
  try {
    const list = await kv.list({ prefix: BACKUP_PREFIX, limit: 100 });
    const keys = (list.keys || []).map((k) => k.name).sort();
    while (keys.length > BACKUP_KEEP) {
      const old = keys.shift();
      if (old !== key) await kv.delete(old);
    }
  } catch (e) { /* 清理失败不影响本次备份 */ }

  await audit(u.id, 'score-backup-run', 'backup', 0, key);
  ok(res, { stored: true, kv: true, key, counts: snap.counts });
}

async function backupList(req, res) {
  const u = await requireAdmin(req, res);
  if (!u) return;
  const kv = getKV();
  if (!kv) return fail(res, 503, '还没配置备份存储（KV）—— 见站点文档「备份」一节');
  const list = await kv.list({ prefix: BACKUP_PREFIX, limit: 100 });
  const keys = (list.keys || []).map((k) => k.name).sort().reverse();
  ok(res, {
    kv: true,
    keep: BACKUP_KEEP,
    items: keys.map((k) => ({
      key: k,
      at: k.replace(BACKUP_PREFIX, '').replace(/\.json$/, '').replace(/-/g, (m, i) => m),
    })),
  });
}

async function backupGet(req, res) {
  const u = await requireAdmin(req, res);
  if (!u) return;
  const key = String(req.query.key || '').trim();
  if (!key || key.indexOf(BACKUP_PREFIX) !== 0) return fail(res, 400, '快照标识不对');
  const kv = getKV();
  if (!kv) return fail(res, 503, '还没配置备份存储（KV）');
  const raw = await kv.get(key);
  if (!raw) return fail(res, 404, '这份快照已经不在存储里了');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = 200;
  res.end(raw);   /* 原样吐出 JSON，浏览器会直接下载 */
}

/** 直接导出一份（不依赖 KV）—— 站主想自己留底时用 */
async function backupExport(req, res) {
  const u = await requireAdmin(req, res);
  if (!u) return;
  const sql = getSql();
  const snap = await buildSnapshot(sql);
  await audit(u.id, 'score-backup-export', 'backup', 0, 'download');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = 200;
  res.end(JSON.stringify(snap));
}

/** 从快照还原（只动成绩相关的表；users 表绝不碰） */
async function backupRestore(req, res) {
  const u = await requireAdmin(req, res);
  if (!u) return;
  const b = await body(req);
  if (String(b.confirm || '') !== 'RESTORE') {
    return fail(res, 400, '危险操作：请在 confirm 里原样填写 RESTORE');
  }
  const sql = getSql();

  let snap = null;
  if (b.snapshot && typeof b.snapshot === 'object') {
    snap = b.snapshot;
  } else if (b.key) {
    const kv = getKV();
    if (!kv) return fail(res, 503, '还没配置备份存储（KV），没法按标识取快照');
    const raw = await kv.get(String(b.key));
    if (!raw) return fail(res, 404, '这份快照已经不在存储里了');
    try { snap = JSON.parse(raw); } catch (e) { return fail(res, 400, '快照内容不是合法 JSON'); }
  } else {
    return fail(res, 400, '要么给 key，要么直接给 snapshot');
  }

  const t = (snap && snap.tables) || {};
  if (!Array.isArray(t.exams)) return fail(res, 400, '快照里没有考试数据，不能还原');

  /* 只预览不写库 */
  if (b.dry) {
    const cur = await sql`select count(*)::int as n from exams`;
    const curS = await sql`select count(*)::int as n from exam_scores`;
    return ok(res, {
      dry: true,
      will: {
        exams: (t.exams || []).length,
        examScores: (t.exam_scores || []).length,
        shareLinks: (t.share_links || []).length,
      },
      now: { exams: Number(cur[0].n), examScores: Number(curS[0].n) },
      at: snap.at || null,
    });
  }

  /* 还原前先自动留一份「现在的样子」，万一还原错了还能退回来 */
  const safety = await buildSnapshot(sql);
  const kv = getKV();
  let safetyKey = null;
  if (kv) {
    safetyKey = BACKUP_PREFIX + 'before-restore-' + Date.now() + '.json';
    try { await kv.put(safetyKey, JSON.stringify(safety)); } catch (e) { safetyKey = null; }
  }

  /* 兼容旧快照：日期统一截成 YYYY-MM-DD 再灌 */
  const fixExams = (t.exams || []).map((e) => Object.assign({}, e, {
    exam_date: isoDay(e.exam_date),
    exam_end_date: isoDay(e.exam_end_date),
  }));
  if (fixExams.some((e) => !e.exam_date)) {
    return fail(res, 400, '快照里有考试的日期无法识别，不能还原（请换一份快照）');
  }

  /* ============================================================
     ⚠️ 必须**放在一个事务里**执行。
     2026-10-14 的还原演练炸过一次：delete 全部成功、insert 中途失败，
     结果数据被清空、插不回去 —— 这是最坏的情况，比不做还原还糟。
     放进事务后就只会是「全成功」或「全回滚」两种结果。
     顺带也解决了「逐条 insert 撞 Workers 50 子请求上限」的问题：
     整套动作只占 1 次数据库往返。
     ============================================================ */
  const tx = [];
  tx.push(sql`delete from exam_scores`);
  tx.push(sql`delete from share_links`);
  tx.push(sql`delete from exams`);

  if (fixExams.length) {
    tx.push(sql`
      insert into exams (id, name, exam_date, exam_end_date, exam_type, subjects, cutlines,
                         grade_ref, note, status, published_at, created_by, created_at, updated_at)
      select x.id, x.name, x.exam_date, x.exam_end_date, x.exam_type,
             coalesce(x.subjects, '[]'::jsonb), coalesce(x.cutlines, '[]'::jsonb),
             x.grade_ref, x.note, coalesce(x.status, 'draft'),
             x.published_at, x.created_by, coalesce(x.created_at, now()), coalesce(x.updated_at, now())
        from jsonb_to_recordset(${JSON.stringify(fixExams)}::jsonb) as x(
          id bigint, name text, exam_date date, exam_end_date date, exam_type text,
          subjects jsonb, cutlines jsonb, grade_ref jsonb, note text, status text,
          published_at timestamptz, created_by bigint, created_at timestamptz, updated_at timestamptz)`);
  }
  if (Array.isArray(t.exam_scores) && t.exam_scores.length) {
    tx.push(sql`
      insert into exam_scores (id, exam_id, user_id, student_name, student_no, scores,
                               school_rank, league_rank, note, created_at, updated_at)
      select x.id, x.exam_id, x.user_id, x.student_name, x.student_no,
             coalesce(x.scores, '{}'::jsonb), x.school_rank, x.league_rank,
             x.note, coalesce(x.created_at, now()), coalesce(x.updated_at, now())
        from jsonb_to_recordset(${JSON.stringify(t.exam_scores)}::jsonb) as x(
          id bigint, exam_id bigint, user_id bigint, student_name text, student_no text,
          scores jsonb, school_rank int, league_rank int, note text,
          created_at timestamptz, updated_at timestamptz)`);
  }
  if (Array.isArray(t.share_links) && t.share_links.length) {
    tx.push(sql`
      insert into share_links (id, token, scope, owner_id, target_names, exam_ids,
                               expires_at, max_views, views, revoked, created_at)
      select x.id, x.token, coalesce(x.scope, 'self'), x.owner_id, x.target_names, x.exam_ids,
             x.expires_at, x.max_views, coalesce(x.views, 0), coalesce(x.revoked, false),
             coalesce(x.created_at, now())
        from jsonb_to_recordset(${JSON.stringify(t.share_links)}::jsonb) as x(
          id bigint, token text, scope text, owner_id bigint, target_names jsonb, exam_ids bigint[],
          expires_at timestamptz, max_views int, views int, revoked boolean, created_at timestamptz)`);
  }
  if (Array.isArray(t.score_config) && t.score_config.length && t.score_config[0] && t.score_config[0].data) {
    tx.push(sql`
      insert into score_config (id, data, updated_at)
      values (1, ${JSON.stringify(jsonCol(t.score_config[0].data))}::jsonb, now())
      on conflict (id) do update set data = ${JSON.stringify(jsonCol(t.score_config[0].data))}::jsonb, updated_at = now()`);
  }
  /* bigserial 的自增值要跟着最大 id 修，否则下次插入会撞主键 */
  tx.push(sql`select setval(pg_get_serial_sequence('exams','id'), greatest(coalesce((select max(id) from exams), 1), 1))`);
  tx.push(sql`select setval(pg_get_serial_sequence('exam_scores','id'), greatest(coalesce((select max(id) from exam_scores), 1), 1))`);
  tx.push(sql`select setval(pg_get_serial_sequence('share_links','id'), greatest(coalesce((select max(id) from share_links), 1), 1))`);

  try {
    await sql.transaction(tx);
  } catch (e) {
    /* 事务已回滚，原数据完好 —— 把真实原因回给站主，别只说「服务器内部错误」 */
    console.error('[restore]', e && e.stack ? e.stack : e);
    return fail(res, 500, '还原失败（已回滚，数据没动）：' + (e && e.message ? e.message : '未知错误'));
  }

  await audit(u.id, 'score-backup-restore', 'backup', 0, 'restored');
  ok(res, {
    restored: {
      exams: (t.exams || []).length,
      examScores: (t.exam_scores || []).length,
    },
    beforeRestoreKey: safetyKey,
  });
}

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
   姓名对照（v2.9.5）
   ------------------------------------------------------------
   站主原话：「雷其桐就是雷博雅」。同一个人，成绩表里写的名字和站点
   账号里的名字不一样，系统就认不出来 —— 他登录后看不到自己。
   与其去改账号（登录名是凭据，动它风险大），不如记一张对照表：
   导入、绑账号、找「我」时都先过一遍，问题自然就没了。
   ============================================================ */

/** 列出「成绩表里出现过、但没绑上账号」的姓名，外加一份账号名单供选择 */
async function unboundNames(req, res) {
  const u = await requireAdmin(req, res);
  if (!u) return;

  const sql = getSql();
  const cfg = await loadConfig(sql);
  const groups = await sql`
    select student_name, max(user_id) as uid, count(*) as n
      from exam_scores
     group by student_name
     order by student_name`;

  const unbound = [];
  groups.forEach((r) => {
    if (r.uid != null) return;
    const nm = String(r.student_name || '');
    unbound.push({ name: nm, count: Number(r.n) || 0, alias: (cfg.nameMap || {})[nm] || '' });
  });

  const users = await sql`
    select id, display_name, username from users
     where status = 'active' order by id`;

  ok(res, {
    nameMap: cfg.nameMap || {},
    unbound,
    boundCount: groups.length - unbound.length,
    users: users.map((x) => ({
      id: Number(x.id),
      name: String(x.display_name || x.username || ''),
      username: String(x.username || ''),
    })),
  });
}

/** 把「成绩表里的某个姓名」关联到某个账号（传空 target 即取消关联），并写回对照表 */
async function nameBind(req, res) {
  const u = await requireAdmin(req, res);
  if (!u) return;

  const b = await body(req);
  const name = String((b && b.name) || '').trim().slice(0, 30);
  if (!name) return fail(res, 400, '缺少姓名');
  const target = String((b && b.target) || '').trim().slice(0, 30);

  const sql = getSql();
  const cfg = await loadConfig(sql);
  const map = Object.assign({}, cfg.nameMap || {});
  if (target && target !== name) map[name] = target;
  else delete map[name];

  /* target 必须真的对得上某个账号才绑；取消关联就把这些行解绑 */
  const users = await sql`select id, display_name, username from users where status = 'active'`;
  const byName = new Map();
  users.forEach((x) => {
    const n = String(x.display_name || '').trim();
    if (n && !byName.has(n)) byName.set(n, Number(x.id));
    const un = String(x.username || '').trim();
    if (un && !byName.has(un)) byName.set(un, Number(x.id));
  });
  const uid = target ? (byName.get(target) || null) : null;
  if (target && !uid) return fail(res, 400, '找不到账号「' + target + '」，请从名单里选一个');

  const back = await sql`
    update exam_scores set user_id = ${uid}, updated_at = now()
     where student_name = ${name}
    returning id`;

  const next = Object.assign({}, cfg, { nameMap: map });
  await sql`
    insert into score_config (id, data, updated_at)
    values (1, ${JSON.stringify(next)}::jsonb, now())
    on conflict (id) do update set data = ${JSON.stringify(next)}::jsonb, updated_at = now()`;

  await audit(u.id, 'score-name-bind', 'exam_score', 0, name + ' → ' + (target || '（取消关联）'));
  ok(res, { nameMap: map, changed: back.length, uid, name: name });
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
      const o = a == null ? { raw: r } : { raw: r, assigned: a };
      /* v2.10.1（#182 站主要求）：每个分数都要对应一个年级排名 ——
         rank = 原始分/分数的年级排名；asgRank = 赋分那份的年级排名。
         空值不写（= 不知），绝不补 0。 */
      const rk = toIntOrNull(v.rank);
      const ak = toIntOrNull(v.asgRank);
      if (rk != null) o.rank = rk;
      if (ak != null && a != null) o.asgRank = ak;
      out[k] = o;
    } else {
      const n = numOrNull(v);
      if (n == null) continue;
      out[k] = { raw: n };
    }
  }
  /* 预留键 _t：总分（赋分前）的年级 / 联考排名。
     为什么不新开两列：它天然属于「这一行成绩」，放进 scores 里就跟着
     导入 / 改分 / 备份 / 还原一起走，不用在四个读写点各改一遍。
     赋分后总分的两个排名仍是 school_rank / league_rank 两列（保持向后兼容）。 */
  const t = src._t;
  if (t && typeof t === 'object') {
    const tr = toIntOrNull(t.rank);
    const tl = toIntOrNull(t.league);
    if (tr != null || tl != null) out._t = { rank: tr, league: tl };
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
  /* 姓名对照：成绩表里的姓名 → 站点账号里的姓名（同一个人的两种叫法）
     例：{ '雷博雅': '雷其桐' }（同一个人，成绩表写的是新名字、账号还是旧的）。
     导入、绑账号、找「我」都会先过一遍这张表，所以改一次名字不用动成绩数据。 */
  nameMap: {},
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
  /* 姓名对照：{ 成绩表姓名: 站点姓名 }。整体替换（不是增量），两边都限长限条数，
     并且不允许自己映射自己 —— 没意义，还容易把自己绕成环。 */
  if (patch.nameMap !== undefined) {
    const src = (patch.nameMap && typeof patch.nameMap === 'object' && !Array.isArray(patch.nameMap))
      ? patch.nameMap : {};
    const map = {};
    let n = 0;
    for (const alias of Object.keys(src)) {
      if (n >= 200) break;
      const a = String(alias || '').trim().slice(0, 30);
      const t = String(src[alias] || '').trim().slice(0, 30);
      if (!a || !t || a === t) continue;
      map[a] = t;
      n++;
    }
    out.nameMap = map;
  }
  return out;
}

/** 姓名归一：把「成绩表里写的名字」映射成「站点账号里的名字」。
 *  没配对照时原样返回 —— 绝大多数人都是这种情况。 */
function canonName(name, nameMap) {
  const n = String(name || '').trim();
  if (!n) return '';
  const t = nameMap && nameMap[n];
  return t ? String(t).trim() : n;
}

/** 某个账号「可能被写成哪些姓名」：账号名 + 用户名 + 所有指向它的别名。
 *  用来判断「这一行成绩是不是我的」—— 比只比 uid 稳，uid 没绑上也不会漏。 */
function namesOfUser(u, nameMap) {
  const out = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (s && out.indexOf(s) < 0) out.push(s);
  };
  push(u && u.displayName);
  push(u && u.username);
  const base = out.slice();
  const map = nameMap || {};
  Object.keys(map).forEach((alias) => {
    const target = String(map[alias] || '').trim();
    if (target && base.indexOf(target) >= 0) push(alias);
  });
  return out;
}
