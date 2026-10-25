/* ============================================================
 * /api/island —— 班级岛（首页顶部 时间 / 天气 / 周数 / 今日事项）
 * ------------------------------------------------------------
 * 站主原话（2026-10-21 晚）：
 *   「班级岛不要那么多功能了，第二行的课程表改为课表信息显示，类似一个横幅，
 *     我在后台可以编辑横幅内容……一般情况下这个横幅上的就显示今日事项：
 *     升 数数语英化 物物体劳 听自语语 就这样显示就可以了。」
 *   「我星期五就可以提前修改好星期六和星期天的横幅显示内容。」
 *   「还可以根据我们是上课还是放假去实时改变，比如说现在正在放中秋假……
 *     寒暑假我就在后台设置开始时间和截止时间，在这时间内不显示课表，显示已放假
 *     多少天、距开学还有多少天。」
 *   「有些考试是不上课的，我就在后台编辑今日事项，比如数学，几点到几点。」
 *
 * 所以 v3 把「多套作息 + 结构化课表」整个砍掉，只留三样：
 *   banner{}    周一到周日各一句默认文案（就是「升 数数语英化 …」这种缩写）
 *   days{}      按具体日期覆盖某一天的文案 / 标成不上课（提前改周六周日靠它）
 *   holidays[]  假期区间（名称 + 起止），期间横幅换成「已放假 N 天 · 距开学还有 M 天」
 *
 * 存哪儿：site_settings.data.island（单行 jsonb，不新建表、不动 schema）。
 * 读：公开。写：仅管理员。
 * ============================================================ */

import { getSql, getSiteSetting, setSiteSetting } from './_lib/db.js';
import {
  cors, handlePreflight, ok, fail, body, requireUser, audit,
} from './_lib/http.js';

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MAX_HOLIDAYS = 30;
const MAX_DAYS = 200;
const MAX_TEXT = 60;       /* 星期横幅：默认课表一行，60 字够 */
const MAX_DAY_TEXT = 600;  /* v3.9.6：多行；v3.9.18 起支持 {22b字} 单字标记，所以放到 600 */
const MAX_PHOTO = 500;

/* 站主 2026-10-21 发来的纸质课表，压成横幅缩写（早读 + 上午 5 节 + 下午 4 节 + 晚上） */
const DEFAULT_BANNER = {
  mon: '升 数数语英化 物物体劳 听自语语自',
  tue: '英 英备备备语 化生物数 练自化化自',
  wed: '语 语数物英英 音生化班 听自英英自',
  thu: '生 微语生生英 物健自自 练自数数自',
  fri: '英 数语语化化 体生英物 听自生生自',
  sat: '自自 自自 读自自',
  sun: '读自 物理 物自',
};

/* v2 老数据里存的是完整课表；要降级成横幅时按第一个字取缩写 */
const ABBR = {
  '升国旗': '升', '数学': '数', '语文': '语', '英语': '英', '化学': '化', '物理': '物',
  '生物': '生', '体育': '体', '劳动': '劳', '音美': '音', '音乐': '音', '美术': '美',
  '微机': '微', '健康': '健', '班会': '班', '自习': '自', '自主自习': '自',
  '英语听力': '听', '语文练字': '练', '备课': '备', '读报': '读',
};

function abbr(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  return ABBR[s] || s.slice(0, 1);
}

/* 6 / 4 / 其余 分三段，跟站主写「升 数数语英化 物物体劳 听自语语」的节奏一致 */
function shorthand(list) {
  const s = list.map(abbr).join('');
  if (!s) return '';
  const parts = [s.slice(0, 6), s.slice(6, 10), s.slice(10)].filter(Boolean);
  return parts.join(' ');
}

const DEFAULT_ISLAND = {
  on: true,
  term: '2026 年秋季 · 高二上',
  startDate: '2026-09-01',
  components: ['time', 'weather', 'week', 'term'],
  banner: DEFAULT_BANNER,
  days: {},
  holidays: [],
  photo: '',
};

/** 字号：只接受 4–32 的整数，其它一律当「默认」
    （v3.9.19：站主要求最小能到 4px，之前卡在 12 会被静默丢掉） */
function clampSize(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 4 || n > 32) return 0;
  return Math.round(n);
}

function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

function normBanner(raw, legacyTimetable) {
  const o = (raw && typeof raw === 'object') ? raw : null;
  const out = {};
  DAY_KEYS.forEach((k) => {
    const v = o ? str(o[k], MAX_TEXT) : '';
    if (v) { out[k] = v; return; }
    /* 没有就退回默认；老数据有完整课表的话，从课表生成缩写 */
    const arr = legacyTimetable && Array.isArray(legacyTimetable[k]) ? legacyTimetable[k] : null;
    const gen = arr && arr.filter(Boolean).length ? shorthand(arr.filter(Boolean)) : '';
    out[k] = gen || DEFAULT_BANNER[k] || '';
  });
  return out;
}

function normDays(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  Object.keys(raw).slice(0, MAX_DAYS).forEach((k) => {
    if (!isDate(k)) return;
    const v = raw[k] || {};
    out[k] = {
      text: str(v.text, MAX_DAY_TEXT),
      off: !!v.off,
      label: str(v.label, 16),
      /* v3.9.7：当天那一条可以单独设加粗 / 是否居中（默认居中）
         v3.9.17：再加「字号」（px，0 = 跟随默认） */
      bold: !!v.bold,
      center: v.center !== false,
      size: clampSize(v.size),
    };
  });
  return out;
}

function normHolidays(raw) {
  const list = Array.isArray(raw) ? raw.slice(0, MAX_HOLIDAYS) : [];
  return list.map((h, i) => {
    const from = isDate(h && h.from) ? h.from : '';
    if (!from) return null;
    const to = isDate(h && h.to) && h.to >= from ? h.to : from;
    return { id: str(h && h.id, 16) || ('h' + i), from, to, label: str(h && h.label, 20) || '假期' };
  }).filter(Boolean).sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

function normalize(raw) {
  const o = (raw && typeof raw === 'object') ? raw : {};

  /* 老数据（v1 一套作息 / v2 多套作息）都带 timetable，用它生成横幅 */
  const legacyTt = (o.timetable && typeof o.timetable === 'object') ? o.timetable : null;

  const comps = Array.isArray(o.components)
    ? o.components.filter((c) => ['time', 'weather', 'week', 'term'].includes(c)).slice(0, 4)
    : DEFAULT_ISLAND.components;

  return {
    on: o.on !== false,
    term: str(o.term, 30) || DEFAULT_ISLAND.term,
    startDate: isDate(o.startDate) ? o.startDate : DEFAULT_ISLAND.startDate,
    components: comps.length ? comps : DEFAULT_ISLAND.components,
    banner: normBanner(o.banner, legacyTt),
    days: normDays(o.days),
    holidays: normHolidays(o.holidays),
    /* v3.9.6：点「今日事项」弹出的照片（直链或仓库相对路径，如 ./photo.jpg） */
    photo: str(o.photo, MAX_PHOTO),
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
        '横幅 7 天 / 覆盖 ' + Object.keys(data.days).length + ' 天 / 假期 ' + data.holidays.length + ' 段'
        + (data.photo ? ' / 照片' : ''));
      return ok(res, { data });
    }
    return fail(res, 405, '不支持的方法');
  } catch (e) {
    console.error('[island]', e && e.stack ? e.stack : e);
    return fail(res, 500, '服务器内部错误');
  }
}
