/* ============================================================
 * /api/island —— 班级岛（首页顶部 时间/天气/周数/课程表）
 * ------------------------------------------------------------
 * 站主原话（2026-10-21）：
 *   「以后星期三、星期四考试，那我这种大考就不会显示这种课程，我就是显示考试科目
 *     和具体考试时间。然后包括有时候可能是提前放假，比如说星期四放假，那我星期五、
 *     星期六都没有课，而不是说仅周六、周天。而且时间表我可能后面有多套……」
 *
 * 所以数据结构从「一套作息 + 周末开关」升级成三件套：
 *   plans[]     多套作息（周一至周五 / 周六 / 周日 / 考试日……），每套自己一套节次时间
 *   week{}      周一~周日各自绑哪套作息（'' = 这天不上课）
 *   overrides[] 按日期区间覆盖：放假 / 考试 / 换作息
 *               放假写 from-to，一次能把周四到周日一起放掉；
 *               考试写科目 + 起止时间，岛上直接显示考什么，不显示课表。
 *
 * 存哪儿：site_settings.data.island（单行 jsonb，不新建表、不动 schema）。
 * 读：公开（游客也要看得到当天上什么课）。写：仅管理员。
 * ============================================================ */

import { getSql, getSiteSetting, setSiteSetting } from './_lib/db.js';
import {
  cors, handlePreflight, ok, fail, body, requireUser, audit,
} from './_lib/http.js';

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MAX_PLANS = 6;
const MAX_PERIODS = 40;
const MAX_OVERRIDES = 60;
const MAX_EXAM_ITEMS = 12;

/* 常规作息：站主 2026-10-21 发来的课表原样录入（早读 7:30，40 分钟一节） */
const P_WEEK = [
  { name: '早读',      group: '早读',   start: '07:30', end: '07:55', cls: true },
  { name: '第 1 节',   group: '上午',   start: '08:00', end: '08:40', cls: true },
  { name: '第 2 节',   group: '上午',   start: '08:50', end: '09:30', cls: true },
  { name: '第 3 节',   group: '上午',   start: '09:40', end: '10:20', cls: true },
  { name: '第 4 节',   group: '上午',   start: '10:30', end: '11:10', cls: true },
  { name: '第 5 节',   group: '上午',   start: '11:20', end: '12:00', cls: true },
  { name: '午休',      group: '中午',   start: '12:00', end: '14:20', cls: false },
  { name: '第 6 节',   group: '下午',   start: '14:20', end: '15:00', cls: true },
  { name: '第 7 节',   group: '下午',   start: '15:10', end: '15:50', cls: true },
  { name: '大课间',    group: '下午',   start: '15:50', end: '16:15', cls: false },
  { name: '第 8 节',   group: '下午',   start: '16:15', end: '17:05', cls: true },
  { name: '第 9 节',   group: '下午',   start: '17:05', end: '17:45', cls: true },
  { name: '晚饭',      group: '晚上',   start: '17:45', end: '18:40', cls: false },
  { name: '听力/练字', group: '晚上',   start: '18:40', end: '19:10', cls: true },
  { name: '自习',      group: '晚上',   start: '19:10', end: '19:40', cls: true },
  { name: '晚 1',      group: '晚自习', start: '19:50', end: '20:40', cls: true },
  { name: '晚 2',      group: '晚自习', start: '20:50', end: '21:30', cls: true },
  { name: '晚 3',      group: '晚自习', start: '21:30', end: '22:00', cls: true },
];

const P_SAT = [
  { name: '早自习',   group: '上午',   start: '08:00', end: '09:40', cls: true },
  { name: '上午自习', group: '上午',   start: '09:50', end: '11:30', cls: true },
  { name: '下午自习', group: '下午',   start: '14:30', end: '16:00', cls: true },
  { name: '下午自习', group: '下午',   start: '16:05', end: '17:30', cls: true },
  { name: '读报',     group: '晚上',   start: '18:40', end: '19:10', cls: true },
  { name: '晚自习',   group: '晚自习', start: '19:10', end: '20:40', cls: true },
  { name: '晚自习',   group: '晚自习', start: '20:50', end: '22:00', cls: true },
];

const P_SUN = [
  { name: '读报',   group: '晚上',   start: '18:40', end: '19:10', cls: true },
  { name: '晚自习', group: '晚自习', start: '19:10', end: '19:40', cls: true },
  { name: '晚 1',   group: '晚自习', start: '19:50', end: '20:40', cls: true },
  { name: '晚 2',   group: '晚自习', start: '20:50', end: '21:30', cls: true },
  { name: '晚 3',   group: '晚自习', start: '21:30', end: '22:00', cls: true },
];

const DEFAULT_PLANS = [
  { id: 'p1', name: '周一至周五', periods: P_WEEK },
  { id: 'p2', name: '周六', periods: P_SAT },
  { id: 'p3', name: '周日（仅晚自习）', periods: P_SUN },
];

const DEFAULT_WEEK = {
  mon: 'p1', tue: 'p1', wed: 'p1', thu: 'p1', fri: 'p1', sat: 'p2', sun: 'p3',
};

/* 站主那张纸质课表原样录入；改课在后台点格子改就行 */
const DEFAULT_TT = {
  mon: ['升国旗', '数学', '数学', '语文', '英语', '化学', '物理', '物理', '体育', '劳动', '英语听力', '自习', '语文', '语文', '自主自习'],
  tue: ['英语', '英语', '备课', '备课', '备课', '语文', '化学', '生物', '数学', '数学', '语文练字', '自习', '化学', '化学', '自主自习'],
  wed: ['语文', '语文', '数学', '物理', '英语', '英语', '音美', '生物', '化学', '班会', '英语听力', '自习', '英语', '英语', '自主自习'],
  thu: ['生物', '微机', '语文', '生物', '生物', '英语', '物理', '健康', '自习', '自习', '语文练字', '自习', '数学', '数学', '自主自习'],
  fri: ['英语', '数学', '语文', '语文', '化学', '化学', '体育', '生物', '英语', '物理', '英语听力', '自习', '生物', '生物', '自主自习'],
  sat: ['自习', '自习', '自习', '自习', '读报', '自习', '自习'],
  sun: ['读报', '自习', '物理', '物理', '自主自习'],
};

const DEFAULT_ISLAND = {
  on: true,
  term: '2026 年秋季 · 高二上',
  startDate: '2026-09-01',
  components: ['time', 'weather', 'week', 'term'],
  plans: DEFAULT_PLANS,
  week: DEFAULT_WEEK,
  timetable: DEFAULT_TT,
  overrides: [],
};

function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function isHHMM(s) { return /^\d{1,2}:\d{2}$/.test(String(s || '')); }

function normPeriods(list) {
  const src = Array.isArray(list) ? list.slice(0, MAX_PERIODS) : [];
  return src.map((p, i) => ({
    key: str(p && p.key, 12) || ('p' + i),
    name: str(p && p.name, 16) || ('第 ' + (i + 1) + ' 节'),
    group: str(p && p.group, 8),
    start: isHHMM(p && p.start) ? str(p.start, 5) : '',
    end: isHHMM(p && p.end) ? str(p.end, 5) : '',
    cls: !!(p && p.cls),
  }));
}

function normPlans(o) {
  const list = Array.isArray(o.plans) ? o.plans : null;
  if (!list || !list.length) return DEFAULT_PLANS;

  const out = [];
  list.slice(0, MAX_PLANS).forEach((p, i) => {
    const id = str(p && p.id, 12) || ('p' + (i + 1));
    if (out.some((x) => x.id === id)) return;
    out.push({
      id,
      name: str(p && p.name, 20) || ('作息 ' + (i + 1)),
      periods: normPeriods(p && p.periods),
    });
  });
  return out.length ? out : DEFAULT_PLANS;
}

function normOverride(o, i) {
  const type = ['off', 'exam', 'plan'].includes(o && o.type) ? o.type : 'off';
  const from = isDate(o && o.from) ? o.from : '';
  if (!from) return null;
  const to = isDate(o && o.to) && o.to >= from ? o.to : from;
  const items = (Array.isArray(o && o.items) ? o.items : []).slice(0, MAX_EXAM_ITEMS).map((x) => ({
    start: isHHMM(x && x.start) ? str(x.start, 5) : '',
    end: isHHMM(x && x.end) ? str(x.end, 5) : '',
    subject: str(x && x.subject, 16),
    note: str(x && x.note, 24),
  })).filter((x) => x.subject);
  return {
    id: str(o && o.id, 16) || ('o' + i),
    from,
    to,
    type,
    label: str(o && o.label, 20),
    planId: str(o && o.planId, 12),
    items,
  };
}

function normalize(raw) {
  const o = (raw && typeof raw === 'object') ? raw : {};
  const plans = normPlans(o);
  const planIds = plans.map((p) => p.id);

  const week = {};
  DAY_KEYS.forEach((k) => {
    if (o.week && typeof o.week === 'object' && k in o.week) {
      const v = str(o.week[k], 12);
      week[k] = (v && planIds.includes(v)) ? v : '';
    } else if (o.weekend && typeof o.weekend === 'object') {
      /* 老数据只给了「周六/周日上不上课」 */
      const off = (k === 'sat' && o.weekend.sat === false) || (k === 'sun' && o.weekend.sun === false);
      week[k] = off ? '' : DEFAULT_WEEK[k];
    } else {
      week[k] = DEFAULT_WEEK[k];
    }
  });

  const tt = {};
  const src = (o.timetable && typeof o.timetable === 'object') ? o.timetable : {};
  DAY_KEYS.forEach((k) => {
    const arr = Array.isArray(src[k]) ? src[k] : [];
    tt[k] = arr.slice(0, MAX_PERIODS).map((x) => str(x, 8));
  });

  const overrides = (Array.isArray(o.overrides) ? o.overrides : [])
    .slice(0, MAX_OVERRIDES).map(normOverride).filter(Boolean)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

  const comps = Array.isArray(o.components)
    ? o.components.filter((c) => ['time', 'weather', 'week', 'term'].includes(c)).slice(0, 4)
    : DEFAULT_ISLAND.components;

  return {
    on: o.on !== false,
    term: str(o.term, 30) || DEFAULT_ISLAND.term,
    startDate: isDate(o.startDate) ? o.startDate : DEFAULT_ISLAND.startDate,
    components: comps.length ? comps : DEFAULT_ISLAND.components,
    plans,
    week,
    timetable: Object.keys(src).length ? tt : DEFAULT_TT,
    overrides,
  };
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  cors(req, res);

  const sql = getSql();
  try {
    if (req.method === 'GET') {
      let saved = await getSiteSetting(sql, 'island', null);
      if (typeof saved === 'string') { try { saved = JSON.parse(saved); } catch (e) { saved = null; } }
      return ok(res, { data: normalize(saved) });
    }
    if (req.method === 'POST') {
      const u = await requireUser(req, res);
      if (!u) return;
      if (u.role !== 'admin') return fail(res, 403, '只有管理员能改班级岛');
      const b = await body(req);
      const data = normalize(b && b.data);
      await setSiteSetting(sql, 'island', data);
      await audit(u.id, 'island.save', 'site_setting', 0,
        '作息 ' + data.plans.length + ' 套 / 覆盖 ' + data.overrides.length + ' 条');
      return ok(res, { data });
    }
    return fail(res, 405, '不支持的方法');
  } catch (e) {
    console.error('[island]', e && e.stack ? e.stack : e);
    return fail(res, 500, '服务器内部错误');
  }
}
