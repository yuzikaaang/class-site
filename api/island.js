/* ============================================================
 * /api/island —— 班级岛（首页顶部时间/天气/周数/课程表）
 * ------------------------------------------------------------
 * 站主原话：
 *   「我想要在页面加一个类似 ClassIsland 的一个岛的功能……放在首页公告上面，
 *     适配电脑版和手机屏幕，我可以在后台的首页卡片通过拖动的功能实现显示哪些
 *     组件……课程表放在第二行，这个是必须要的，显示当日课程（如果没有则显示
 *     放假 ing）。」
 *
 * 存哪儿：site_settings.data.island（单行 jsonb，已有表，不新建表、不动 schema）。
 * 读：公开（游客也要看得到当天上什么课）。
 * 写：仅管理员。
 * ============================================================ */

import { getSql, getSiteSetting, setSiteSetting } from './_lib/db.js';
import {
  cors, handlePreflight, ok, fail, body, requireUser, audit,
} from './_lib/http.js';

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/* 默认作息：站主 2026-10-21 口述的那一套（早读 7:30，40 分钟一节，课间 10 分钟） */
const DEFAULT_PERIODS = [
  { key: 'zd',  name: '早读',    group: '早读', start: '07:30', end: '07:55', cls: true },
  { key: 'm1',  name: '第 1 节', group: '上午', start: '08:00', end: '08:40', cls: true },
  { key: 'm2',  name: '第 2 节', group: '上午', start: '08:50', end: '09:30', cls: true },
  { key: 'm3',  name: '第 3 节', group: '上午', start: '09:40', end: '10:20', cls: true },
  { key: 'm4',  name: '第 4 节', group: '上午', start: '10:30', end: '11:10', cls: true },
  { key: 'm5',  name: '第 5 节', group: '上午', start: '11:20', end: '12:00', cls: true },
  { key: 'noon', name: '午休',   group: '中午', start: '12:00', end: '14:20', cls: false },
  { key: 'a1',  name: '第 1 节', group: '下午', start: '14:20', end: '15:00', cls: true },
  { key: 'a2',  name: '第 2 节', group: '下午', start: '15:10', end: '15:50', cls: true },
  { key: 'brk', name: '大课间',  group: '下午', start: '15:50', end: '16:15', cls: false },
  { key: 'a3',  name: '第 3 节', group: '下午', start: '16:15', end: '17:05', cls: true },
  { key: 'a4',  name: '第 4 节', group: '下午', start: '17:05', end: '17:45', cls: true },
  { key: 'din', name: '晚饭',    group: '晚上', start: '17:45', end: '18:40', cls: false },
  { key: 'rb',  name: '读报',    group: '晚上', start: '18:40', end: '19:10', cls: true },
  { key: 'n1',  name: '第 1 节', group: '晚自习', start: '19:10', end: '19:40', cls: true },
  { key: 'n2',  name: '第 2 节', group: '晚自习', start: '19:50', end: '20:40', cls: true },
  { key: 'n3',  name: '第 3 节', group: '晚自习', start: '20:50', end: '21:30', cls: true },
  { key: 'free', name: '自主自习', group: '晚自习', start: '21:30', end: '22:00', cls: false },
];

const DEFAULT_ISLAND = {
  on: true,
  term: '2026 年秋季 · 高二上',
  startDate: '2026-09-01',
  weekend: { sat: true, sun: false },
  components: ['time', 'weather', 'week', 'term'],
  periods: DEFAULT_PERIODS,
  timetable: {
    mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [],
  },
};

function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }

function normalize(raw) {
  const o = (raw && typeof raw === 'object') ? raw : {};
  const periods = Array.isArray(o.periods) ? o.periods.slice(0, 30).map((p, i) => ({
    key: str(p && p.key, 12) || ('p' + i),
    name: str(p && p.name, 16) || ('第 ' + (i + 1) + ' 节'),
    group: str(p && p.group, 8),
    start: /^\d{1,2}:\d{2}$/.test(String(p && p.start)) ? p.start : '',
    end: /^\d{1,2}:\d{2}$/.test(String(p && p.end)) ? p.end : '',
    cls: !!(p && p.cls),
  })) : DEFAULT_PERIODS;

  const tt = {};
  const src = (o.timetable && typeof o.timetable === 'object') ? o.timetable : {};
  DAY_KEYS.forEach((k) => {
    const arr = Array.isArray(src[k]) ? src[k] : [];
    tt[k] = arr.slice(0, 20).map((x) => str(x, 8));
  });

  const comps = Array.isArray(o.components)
    ? o.components.filter((c) => ['time', 'weather', 'week', 'term'].includes(c)).slice(0, 4)
    : DEFAULT_ISLAND.components;

  return {
    on: o.on !== false,
    term: str(o.term, 30) || DEFAULT_ISLAND.term,
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(String(o.startDate)) ? o.startDate : DEFAULT_ISLAND.startDate,
    weekend: {
      sat: !!(o.weekend && o.weekend.sat),
      sun: !!(o.weekend && o.weekend.sun),
    },
    components: comps.length ? comps : DEFAULT_ISLAND.components,
    periods,
    timetable: tt,
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
        '组件 ' + data.components.length + ' 个 / 课表 ' + data.periods.filter((p) => p.cls).length + ' 节');
      return ok(res, { data });
    }
    return fail(res, 405, '不支持的方法');
  } catch (e) {
    console.error('[island]', e && e.stack ? e.stack : e);
    return fail(res, 500, '服务器内部错误');
  }
}
