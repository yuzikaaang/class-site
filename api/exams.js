/* ============================================================================
 * /api/exams —— 考试看板（Novora）接入
 * ----------------------------------------------------------------------------
 * 站主原话（2026-11-08）：
 *   「我之前部署过一个考试看板，examboard.dpdns.org……我想把这些考试数据
 *     接入到我们的作业看板里面，这样的话我就可以在作业看板直接可以看到今天的
 *     考试数据……还可以在作业看板那里去修改考试数据」
 *   「可以完整读具体每一天的数据，包括日程以及考试时间这些，然后也可以写，
 *     因为我想在后台也做一个数据同步的功能，会把那个数据拉到我们这个服务站的
 *     数据库里面，然后我也可以在这边新加数据，然后写回去」
 *
 * 上游是什么（实测，2026-11-08）：
 *   · GET  {base}/api/exams          公开，整份快照约 5KB，带 ETag；
 *                                    没有鉴权，所以「读」不需要账号
 *   · POST {base}/api/exams          必须管理员 Bearer token，24 小时过期
 *   · POST {base}/api/login          用户名 + 密码换 token（错 5 次锁 15 分钟）
 *   · GET  {base}/api/time           服务端时间（大屏倒计时用得上）
 *   写入是「整份快照 + 域增量」：只提交 majors 这一个域时，其余字段服务端保留，
 *   再用 baseRevisions.major / baseUpdatedAt 做并发校验，冲突回 409。
 *
 * 我们这边怎么存：
 *   · 不建新表、不占 Neon —— 一份 5KB 的 JSON 放 KV 就够了（exam_data_v1）。
 *     站里 KV 额度本来是按「1GB 总量、10 万读/天」算的，这点数据连零头都不算。
 *   · 账号密码单独放 exam_cfg_v1，用 ADMIN_SECRETS_KEY 做 AES-GCM 加密
 *     （和档案字段同一套，见 _lib/profile-crypt.js），KV 泄露也不至于裸奔。
 *   · token 放 exam_tok_v1，过期的自动重登，不把密码写进每次请求。
 *
 * 谁能调：
 *   读  —— 公开（大屏要用；内容就是「今天考什么」，本来也是贴在教室墙上的）
 *   写  —— 仅管理员（同步 / 新增 / 删除 / 写回 / 改账号）
 * ========================================================================= */

import {
  cors, handlePreflight, ok, fail, body, requireUser, audit,
} from './_lib/http.js';
import { profileKey, encField, decField } from './_lib/profile-crypt.js';
import { getSiteSetting } from './_lib/db.js';

const DEF_BASE = 'https://examboard.dpdns.org';
const K_CFG = 'exam_cfg_v1';
const K_DATA = 'exam_data_v1';
/* v4.10.8：站内不再写回上游，只存「手动挑了哪几场」这一份很小的清单 */
const K_PIN = 'exam_pin_v1';

/* 内存缓存：同一个 isolate 里连续打开大屏不必每次都打上游 */
const MEM_MS = 90 * 1000;
/* 中国时区：Workers 跑在 UTC，所有「今天」都必须按 +08:00 算 */
const CST = 8 * 3600 * 1000;
const DAY_MS = 86400000;

let _mem = { at: 0, data: null };

/* ---------------- 小工具 ---------------- */

function getKV(req) {
  const env = (req && req.__env) || {};
  const kv = env.SITE_KV;
  if (!kv || typeof kv.get !== 'function') return null;
  return kv;
}

async function kvGet(kv, key) {
  if (!kv) return null;
  try {
    const s = await kv.get(key);
    if (!s) return null;
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null;
  }
}

async function kvPut(kv, key, val) {
  if (!kv) throw new Error('没有配置 KV 存储（SITE_KV），无法保存');
  await kv.put(key, JSON.stringify(val));
}

async function kvDel(kv, key) {
  if (!kv) return;
  try { await kv.delete(key); } catch (e) {}
}

/** 带超时的 fetch：上游挂了不能让大屏一直转圈 */
async function nvFetch(url, opt, ms) {
  const timeout = ms || 9000;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeout) : 0;
  try {
    const o = opt || {};
    const headers = Object.assign({ Accept: 'application/json' }, o.headers || {});
    const r = await fetch(url, Object.assign({}, o, {
      headers,
      signal: ctrl ? ctrl.signal : undefined,
    }));
    const txt = await r.text();
    let j = null;
    try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = null; }
    /* v4.10.10：把 ETag 带回去，下次回源就能发 If-None-Match 换 304，
       既省流量，也让「手动刷新」足够便宜，可以频繁点。 */
    let etag = '';
    try { etag = r.headers.get('ETag') || ''; } catch (e) { etag = ''; }
    return { status: r.status, json: j, text: txt, etag: etag };
  } catch (e) {
    return { status: 0, json: null, text: String((e && e.message) || e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function str(v, max) {
  const s = String(v == null ? '' : v).trim();
  return max && s.length > max ? s.slice(0, max) : s;
}

/* 时间戳 → 中国时区的 YYYY-MM-DD */
function dayOf(ms) {
  const d = new Date(Number(ms) + CST);
  return d.toISOString().slice(0, 10);
}

/* 考试看板里存的是本地时间字符串（2026-12-01T09:00），不需要转时区 */
function hhmm(t) {
  const m = /T(\d{2}:\d{2})/.exec(String(t || ''));
  return m ? m[1] : '';
}

function msOfLocal(local) {
  /* 'YYYY-MM-DDTHH:MM' 按 +08:00 解释 */
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local || ''));
  if (!m) return 0;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return utc - CST;
}

function isDay(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function isHm(s) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || '')); }

function rnd(n) {
  const A = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < n; i++) out += A[Math.floor(Math.random() * A.length)];
  return out;
}

/* ---------------- 配置（源地址 + 账号 + 绑定的班级） ---------------- */

async function loadCfg(req) {
  const kv = getKV(req);
  const raw = await kvGet(kv, K_CFG);
  const cfg = raw || {};
  const key = await profileKey(req).catch(function () { return null; });
  return {
    base: str(cfg.base, 200) || DEF_BASE,
    user: str(cfg.user, 100),
    passEnc: str(cfg.pass, 400),
    pass: cfg.pass ? String(await decField(key, cfg.pass) || '') : '',
    classId: str(cfg.classId, 80),
    className: str(cfg.className, 40),
    autoPush: cfg.autoPush === true,
    at: Number(cfg.at || 0),
    hasPass: !!cfg.pass,
  };
}

async function saveCfg(req, cfg) {
  const kv = getKV(req);
  const key = await profileKey(req).catch(function () { return null; });
  const doc = {
    base: cfg.base,
    user: cfg.user,
    pass: cfg.passEnc,
    classId: cfg.classId,
    className: cfg.className,
    autoPush: cfg.autoPush === true,
    at: Date.now(),
  };
  if (cfg.passNew) doc.pass = await encField(key, cfg.passNew);
  await kvPut(kv, K_CFG, doc);
  return doc;
}

/* ---------------- 快照归一化 ---------------- */

function normSnap(raw) {
  const arr = function (v) { return Array.isArray(v) ? v : []; };
  const majors = arr(raw && raw.majors).filter(function (m) { return m && m.id; }).map(function (m) {
    return {
      id: String(m.id),
      name: str(m.name, 80),
      source: str(m.source, 20) || 'regular',
      temporary: m.temporary === true,
      order: Number(m.order || 0),
      startAt: Number(m.startAt || 0) || 0,
      endAt: Number(m.endAt || 0) || 0,
      publishedAt: Number(m.publishedAt || 0) || 0,
      endedAt: Number(m.endedAt || 0) || 0,
      targetClassIds: arr(m.targetClassIds).map(String),
      targetGradeIds: arr(m.targetGradeIds).map(String),
      local: m.createdVia === 'class-site',
      items: arr(m.items).filter(function (i) { return i && i.id; }).map(function (i) {
        return {
          id: String(i.id),
          name: str(i.name, 40),
          order: Number(i.order || 0),
          enabled: i.enabled !== false,
          startTime: str(i.startTime, 20),
          endTime: str(i.endTime, 20),
          targetClassIds: arr(i.targetClassIds).map(String),
        };
      }),
    };
  });
  return {
    title: str(raw && raw.title, 80),
    updatedAt: Number((raw && raw.updatedAt) || 0),
    revisions: (raw && raw.revisions && typeof raw.revisions === 'object') ? raw.revisions : {},
    grades: arr(raw && raw.grades).filter(function (g) { return g && g.id; }).map(function (g) {
      return { id: String(g.id), name: str(g.name, 30), order: Number(g.order || 0), enabled: g.enabled !== false };
    }),
    classes: arr(raw && raw.classes).filter(function (c) { return c && c.id; }).map(function (c) {
      return {
        id: String(c.id), gradeId: String(c.gradeId || ''), name: str(c.name, 30),
        order: Number(c.order || 0), enabled: c.enabled !== false,
      };
    }),
    majors: majors,
  };
}

/** 认哪个班：后台指定优先；没指定就挑第一个启用的班 */
function classOf(data, cfg) {
  const classes = (data && data.classes) || [];
  const want = (cfg && cfg.classId) || (data && data.clsId) || '';
  let hit = classes.filter(function (c) { return c.id === want; })[0];
  if (!hit) hit = classes.filter(function (c) { return c.enabled !== false; })[0] || classes[0];
  if (!hit) return { id: '', gradeId: '', name: '' };
  return { id: hit.id, gradeId: hit.gradeId, name: hit.name };
}

/* ---------------- 「今天考什么」 ---------------- */

/**
 * 大屏要的只有一个问题：今天有没有考试。
 * 规则（站主定）：
 *   · 今天是某场大型考试的其中一天 → 这场考试的**所有天**都列出来（n 天全显示），
 *     所以连续三天的段考在第一天就能看到完整表；
 *   · 今天不在任何一场的范围内 → 不显示（明天有也不提前占地方）。
 * 每行给：科目（左）+ 起止时间（右），大屏直接照着画。
 */
function buildDays(data, cfg, nowMs, pins) {
  const cls = classOf(data, cfg);
  const today = dayOf(nowMs);
  const rows = [];
  const seen = {};
  (data.majors || []).forEach(function (m) {
    if (m.endedAt && m.endedAt < nowMs) return;
    /* 未发布的草稿不显示；临时考试本来就没有 publishedAt */
    if (!m.publishedAt && !m.temporary && !m.local) return;
    if (m.targetClassIds.length && m.targetClassIds.indexOf(cls.id) < 0) return;
    if (m.targetGradeIds.length && m.targetGradeIds.indexOf(cls.gradeId) < 0) return;

    const its = m.items.filter(function (i) {
      return i.enabled && (!i.targetClassIds.length || i.targetClassIds.indexOf(cls.id) >= 0);
    }).filter(function (i) { return isDay(String(i.startTime).slice(0, 10)); });
    if (!its.length) return;

    const dates = {};
    its.forEach(function (i) { dates[String(i.startTime).slice(0, 10)] = 1; });
    const hitToday = !!dates[today];

    its.forEach(function (i) {
      const d = String(i.startTime).slice(0, 10);
      const pinned = pinOf(pins, m.id, d, i.id).on;
      /* v4.10.8：今天没这场、也没手动挑 → 不显示；手动挑的哪怕不是今天也照显示 */
      if (!hitToday && !pinned) return;
      if (seen[i.id]) return;
      seen[i.id] = 1;
      rows.push({
        date: d,
        id: i.id,
        name: i.name,
        start: hhmm(i.startTime),
        end: hhmm(i.endTime),
        major: m.name,
        majorId: m.id,
        temporary: m.temporary,
        pinned: pinned,
        past: d < today,
      });
    });
  });

  /* 按日期分组，日期升序；同一天按开始时间排 */
  const map = {};
  rows.forEach(function (r) { (map[r.date] || (map[r.date] = [])).push(r); });
  return Object.keys(map).sort().map(function (d) {
    return {
      date: d,
      isToday: d === today,
      items: map[d].sort(function (a, b) { return String(a.start).localeCompare(String(b.start)); }),
    };
  });
}

/* ---------------- 上游读写 ---------------- */

async function pull(req, cfg, kv, prev) {
  const headers = {};
  if (prev && prev.etag) headers['If-None-Match'] = prev.etag;
  const r = await nvFetch(cfg.base + '/api/exams', { method: 'GET', headers: headers }, 9000);
  /* 304：上游没变，直接把旧的续个时间戳，省一次 5KB 的下载 */
  if (r.status === 304 && prev) {
    prev.at = Date.now();
    if (kv) await kvPut(kv, K_DATA, prev);
    _mem = { at: Date.now(), data: prev };
    return prev;
  }
  if (r.status !== 200 || !r.json) {
    throw new Error('考试看板没有返回数据（HTTP ' + r.status + '）');
  }
  const data = normSnap(r.json);
  data.at = Date.now();
  data.dirty = false;
  data.etag = String(r.etag || '');
  const cls = classOf(data, cfg);
  data.clsId = cls.id;
  data.clsName = cls.name;
  if (kv) await kvPut(kv, K_DATA, data);
  _mem = { at: Date.now(), data: data };
  return data;
}


/* ---------------- 手动挑选（v4.10.10） ----------------
   站主原话（2026-11-08，第二轮）：
     「我可以添加单场也可以添加考试群，比如说这次段考他要考两天，那我可以直接把这个
       段考给加上去……我也可以按天来加，可以一键添加本周所有的考试。」
   所以挑选清单从「一串场次 id」升级成三级，粒度各管各的：

     majors[]  'major_xxx'                整场考试（跨几天都算一场）
     days[]    'major_xxx|2026-12-01'     某一场考试的某一天
     items[]   'exam_xxx'                 单独一场科目

   为什么整场要存 majorId 而不是把里面的场次 id 摊开存：
   站主会回考试看板改数据（改名、加一场、删一场）。存 majorId 的话，那边加了一科，
   我们这边自动跟着多出来；存一排 itemId 的话，新增的那科永远不会被包含。

   旧数据兼容：v4.10.8 只存过 { ids: [...] }，读到就当成 items，不清空、不报错。 */

const PIN_MAX = 160;

function pinArr(v) {
  return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string' && x; }) : [];
}

async function loadPins(kv) {
  const o = (await kvGet(kv, K_PIN)) || null;
  /* v4.10.8 的旧结构：只有 ids */
  if (o && Array.isArray(o.ids) && !o.majors && !o.days && !o.items) {
    return {
      majors: [], days: [], off: [],
      items: pinArr(o.ids).slice(0, PIN_MAX), at: Number(o.at || 0),
    };
  }
  return {
    majors: pinArr(o && o.majors).slice(0, 40),
    days: pinArr(o && o.days).slice(0, PIN_MAX),
    items: pinArr(o && o.items).slice(0, PIN_MAX),
    /* off：被整场/某天带出来、但站主单独点了叉的科目。优先级最高 */
    off: pinArr(o && o.off).slice(0, PIN_MAX),
    at: Number((o && o.at) || 0),
  };
}

async function savePins(kv, p) {
  const next = {
    majors: pinArr(p && p.majors).slice(0, 40),
    days: pinArr(p && p.days).slice(0, PIN_MAX),
    items: pinArr(p && p.items).slice(0, PIN_MAX),
    off: pinArr(p && p.off).slice(0, PIN_MAX),
    at: Date.now(),
  };
  if (kv) await kvPut(kv, K_PIN, next);
  return next;
}

/** 这一场科目算不算「被挑中」；by 说明是靠哪一级挑中的 */
function pinOf(pins, majorId, date, itemId) {
  const p = pins || {};
  /* 单独划掉的优先：整场挑了、但某一科点了叉，就不显示 */
  if (pinArr(p.off).indexOf(itemId) >= 0) return { on: false, by: 'off' };
  if (pinArr(p.majors).indexOf(majorId) >= 0) return { on: true, by: 'major' };
  if (pinArr(p.days).indexOf(majorId + '|' + date) >= 0) return { on: true, by: 'day' };
  if (pinArr(p.items).indexOf(itemId) >= 0) return { on: true, by: 'item' };
  return { on: false, by: '' };
}

/** 反查一场科目属于哪场考试、哪一天 */
function findItem(data, itemId) {
  const ms = (data && data.majors) || [];
  for (let a = 0; a < ms.length; a++) {
    const its = ms[a].items || [];
    for (let b = 0; b < its.length; b++) {
      if (its[b].id === itemId) {
        return { majorId: ms[a].id, date: String(its[b].startTime || '').slice(0, 10) };
      }
    }
  }
  return null;
}

/** 某场考试（可限定某一天）里所有科目的 id */
function idsOf(data, majorId, date) {
  const ms = (data && data.majors) || [];
  const m = ms.filter(function (x) { return x.id === majorId; })[0];
  if (!m) return [];
  const out = [];
  (m.items || []).forEach(function (i) {
    const d = String(i.startTime || '').slice(0, 10);
    if (date && d !== date) return;
    out.push(i.id);
  });
  return out;
}

function pinCount(pins) {
  const p = pins || {};
  return pinArr(p.majors).length + pinArr(p.days).length + pinArr(p.items).length;
}

/** 这一场考试算不算「我们班的」：班级 / 年级两级过滤，任一条不匹配就跳过 */
function majorOfClass(m, cls) {
  if (m.endedAt && m.endedAt > 0 && Number(m.endedAt) < Date.now() - 400 * 86400000) return false;
  if (m.targetClassIds && m.targetClassIds.length && m.targetClassIds.indexOf(cls.id) < 0) return false;
  if (m.targetGradeIds && m.targetGradeIds.length && m.targetGradeIds.indexOf(cls.gradeId) < 0) return false;
  return true;
}

/** 这场考试里属于我们班、且已启用的场次 */
function itemsOfClass(m, cls) {
  return (m.items || []).filter(function (i) {
    return i.enabled !== false
      && (!i.targetClassIds || !i.targetClassIds.length || i.targetClassIds.indexOf(cls.id) >= 0)
      && isDay(String(i.startTime || '').slice(0, 10));
  });
}

const WD_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function weekdayOf(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return '';
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return WD_CN[t.getUTCDay()] || '';
}

/**
 * 把整份快照按「考试群」分组 —— 弹窗与作业看板都用这一份。
 *
 * 站主原话（2026-11-08 第二轮）：
 *   「如果是大考，比如说他分了几天的话，那你就是给他列到同一个考试里面，你不要单独列」
 *   「我建议是按照时间去分类，顶上可以筛选时间段」
 *
 * 所以这里**不再摊平成一天一场**，而是一场考试一个节点，里面按天分层：
 *   { id, name, start, end, daysN, count, auto, allOn, anyOn,
 *     days: [{ date, wd, allOn, anyOn, items: [{ id, name, start, end, pin, by }] }] }
 * 跨天的大考天然是一个节点，前端不用自己拼。
 *
 * 不按「今天」过滤 —— 今天是前端的事（前端还要算筛选档位、滚动窗口）。
 */
function groupAll(data, cfg, pins) {
  const cls = classOf(data, cfg);
  const today = dayOf(Date.now());
  const out = [];

  (data.majors || []).forEach(function (m) {
    if (!m.publishedAt && !m.temporary && !m.local) return;   /* 草稿不给看 */
    if (!majorOfClass(m, cls)) return;
    const its = itemsOfClass(m, cls);
    if (!its.length) return;

    const byDay = {};
    its.forEach(function (i) {
      const d = String(i.startTime).slice(0, 10);
      (byDay[d] || (byDay[d] = [])).push(i);
    });

    const days = Object.keys(byDay).sort().map(function (d) {
      const items = byDay[d].slice().sort(function (a, b) {
        return hhmm(a.startTime).localeCompare(hhmm(b.startTime));
      }).map(function (i) {
        const p = pinOf(pins, m.id, d, i.id);
        return {
          id: i.id,
          name: i.name || '考试',
          start: hhmm(i.startTime),
          end: hhmm(i.endTime),
          pin: p.on,
          by: p.by,
        };
      });
      let on = 0;
      items.forEach(function (x) { if (x.pin) on++; });
      return {
        date: d,
        wd: weekdayOf(d),
        items: items,
        onCnt: on,
        allOn: on === items.length && items.length > 0,
        anyOn: on > 0,
      };
    });

    let count = 0;
    let onCnt = 0;
    days.forEach(function (d) {
      count += d.items.length;
      onCnt += d.onCnt;
    });

    out.push({
      id: m.id,
      name: m.name || '考试',
      temporary: m.temporary === true,
      start: days[0].date,
      end: days[days.length - 1].date,
      daysN: days.length,
      count: count,
      onCnt: onCnt,
      allOn: onCnt > 0 && onCnt === count,
      anyOn: onCnt > 0,
      /* 今天正好落在这一场的某一天 → 作业看板自动显示这一整场 */
      auto: days.some(function (d) { return d.date === today; }),
      days: days,
    });
  });

  out.sort(function (a, b) {
    if (a.start !== b.start) return a.start.localeCompare(b.start);
    return String(a.name).localeCompare(String(b.name));
  });
  return out;
}

/** 摊平一份：后台表格、测试脚本用；前端折叠视图不用它 */
function flatOf(groups) {
  const out = [];
  (groups || []).forEach(function (g) {
    g.days.forEach(function (d) {
      d.items.forEach(function (i) {
        out.push({
          id: i.id, date: d.date, wd: d.wd,
          start: i.start, end: i.end, name: i.name,
          major: g.name, majorId: g.id,
          temporary: g.temporary, auto: g.auto,
          pinned: i.pin, by: i.by,
        });
      });
    });
  });
  return out;
}

/* ---------------- 读：拿到一份可用的快照 ---------------- */

/**
 * fresh=1 时真的回上游问一次（带 If-None-Match，304 就沿用本地那份）。
 * 为什么必须回源：v4.10.8 的 list 只读 KV，站主在考试看板改了名字，站内永远是旧的
 * —— 「12 月 1 号那个考试我把物化生三个字删掉了，但是他还没有及时的刷新」。
 * 15 秒节流：手动刷新连点几下也不会把上游打爆。
 */
async function takeData(req, cfg, kv, fresh) {
  let data = _mem.at && (Date.now() - _mem.at < MEM_MS) ? _mem.data : null;
  if (!data) data = await kvGet(kv, K_DATA);
  if (!fresh) return { data: data, hit: true };
  const at = Number((data && data.at) || 0);
  if (data && at && Date.now() - at < 15000) return { data: data, hit: true };
  try {
    const next = await pull(req, cfg, kv, data);
    return { data: next || data, hit: false };
  } catch (e) {
    /* 回源失败不报错：手上还有缓存就先给缓存，前端能看就行 */
    return { data: data, hit: true, err: String((e && e.message) || e) };
  }
}

/** 学期区间：「本学期」这一档筛选用。班级岛里只存当前学期，没有历史学期表 */
async function termOf() {
  try {
    const o = await getSiteSetting(null, 'island', null);
    if (!o || typeof o !== 'object') return { name: '', start: '', end: '' };
    const s = str(o.startDate, 10);
    const e = str(o.endDate, 10);
    const start = isDay(s) ? s : '';
    let end = isDay(e) ? e : '';
    if (!end && start) end = dayOf(msOfLocal(start + 'T00:00') + 200 * DAY_MS);
    return { name: str(o.term, 30), start: start, end: end };
  } catch (e) {
    return { name: '', start: '', end: '' };
  }
}

/* ---------------- 对外 ---------------- */

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  cors(req, res);

  const kv = getKV(req);
  const action = String((req.method === 'GET' ? req.query.action : '') || '').trim();

  try {
    /* ---------- 读：大屏 / 前台（公开） ---------- */
    if (req.method === 'GET' && (action === 'today' || action === '')) {
      const cfg = await loadCfg(req);
      const fresh = String((req.query && req.query.fresh) || '') === '1';
      let data = (await takeData(req, cfg, kv, fresh)).data;
      if (!data) {
        /* 从没同步过：现拉一次，让大屏第一次打开就有东西看 */
        try {
          data = await pull(req, cfg, kv, null);
        } catch (e) {
          return ok(res, {
            at: 0, today: dayOf(Date.now()), days: [], empty: true,
            error: '还没有同步过考试数据',
          });
        }
      }
      const now = Date.now();
      const pins = await loadPins(kv);
      return ok(res, {
        at: Number(data.at || 0),
        today: dayOf(now),
        days: buildDays(data, cfg, now, pins),
        pins: { majors: pins.majors, days: pins.days, items: pins.items },
        title: data.title || '',
        cls: classOf(data, cfg).name || '',
        dirty: data.dirty === true,
        srcAt: Number(data.updatedAt || 0),
      });
    }

    /* ---------- 读：全部考试（公开，作业看板 + 弹窗都用这一份） ----------
       v4.10.10：不再摊平，直接按考试群分组；fresh=1 会回上游问一次。 */
    if (req.method === 'GET' && action === 'list') {
      const cfg = await loadCfg(req);
      const fresh = String((req.query && req.query.fresh) || '') === '1';
      let got = await takeData(req, cfg, kv, fresh);
      let data = got.data;
      if (!data) {
        try {
          data = await pull(req, cfg, kv, null);
          got = { data: data, hit: false };
        } catch (e) {
          return ok(res, {
            at: 0, today: dayOf(Date.now()), groups: [], items: [], empty: true,
            pins: { majors: [], days: [], items: [] }, term: await termOf(),
            error: '还没有同步过考试数据',
          });
        }
      }
      const pins = await loadPins(kv);
      const groups = groupAll(data, cfg, pins);
      return ok(res, {
        at: Number(data.at || 0),
        today: dayOf(Date.now()),
        title: data.title || '',
        cls: classOf(data, cfg).name || '',
        srcAt: Number(data.updatedAt || 0),
        base: cfg.base,
        groups: groups,
        items: flatOf(groups),
        pins: { majors: pins.majors, days: pins.days, items: pins.items },
        pinAt: pins.at,
        term: await termOf(),
        cached: got.hit === true,
        stale: !!got.err,
      });
    }

    /* ---------- 读：后台（管理员） ---------- */
    if (req.method === 'GET' && action === 'state') {
      const u = await requireUser(req, res);
      if (!u) return;
      if (u.role !== 'admin') return fail(res, 403, '只有管理员能查看考试同步状态');
      const cfg = await loadCfg(req);
      const data = (await kvGet(kv, K_DATA)) || null;
      const pins = await loadPins(kv);
      return ok(res, {
        cfg: {
          base: cfg.base,
          classId: cfg.classId,
          className: cfg.className,
        },
        pins: { majors: pins.majors, days: pins.days, items: pins.items },
        pinAt: pins.at,
        term: await termOf(),
        kv: !!kv,
        /* 班级下拉用：同步过一次之后就知道云端有哪些班 */
        classes: data ? data.classes.map(function (c) {
          return { id: c.id, name: c.name, gradeId: c.gradeId };
        }) : [],
        data: data ? {
          at: Number(data.at || 0),
          title: data.title || '',
          cls: classOf(data, cfg).name || '',
          srcAt: Number(data.updatedAt || 0),
          dirty: data.dirty === true,
          pushedAt: Number(data.pushedAt || 0),
          majors: data.majors.map(function (m) {
            return {
              id: m.id, name: m.name, temporary: m.temporary, local: m.local,
              startAt: m.startAt, endAt: m.endAt,
              count: m.items.length,
              items: m.items.map(function (i) {
                return { id: i.id, name: i.name, startTime: i.startTime, endTime: i.endTime };
              }),
            };
          }),
        } : null,
      });
    }

    /* ---------- 写：以下全部仅管理员 ----------
       v4.10.8 起站内**不再写回考试看板**，这里的「写」只写我们自己的两样小东西：
       ① 看板地址与绑定班级；② 手动挑了哪几场。考试数据本身永远只读。 */
    if (req.method !== 'POST') return fail(res, 405, '不支持的方法');

    const u = await requireUser(req, res);
    if (!u) return;
    if (u.role !== 'admin') return fail(res, 403, '只有管理员能改考试同步设置');

    const b = (await body(req)) || {};
    const act = str(b.action, 20);

    /* 保存看板地址 / 绑定班级 */
    if (act === 'cfg') {
      const cfg = await loadCfg(req);
      cfg.base = (str(b.base, 200) || DEF_BASE).replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(cfg.base)) return fail(res, 400, '看板地址要以 http:// 或 https:// 开头');
      cfg.classId = str(b.classId, 80);
      cfg.className = str(b.className, 40);
      await saveCfg(req, cfg);
      await audit(u.id, 'exams.cfg', 'site_setting', 0, '考试看板：' + cfg.base);
      return ok(res, { saved: true });
    }

    /* 测试连接（只拉公开快照） */
    if (act === 'test') {
      const cfg = await loadCfg(req);
      const r = await nvFetch(cfg.base + '/api/exams', { method: 'GET' }, 8000);
      if (r.status !== 200 || !r.json) return fail(res, 502, '连不上考试看板（HTTP ' + r.status + '）');
      const d = normSnap(r.json);
      const cls = classOf(d, cfg);
      return ok(res, {
        title: d.title, majors: d.majors.length, cls: cls.name,
        classes: d.classes.map(function (c) { return c.name; }),
      });
    }

    /* 同步：把云端整份快照拉到本站副本 */
    if (act === 'sync') {
      const cfg = await loadCfg(req);
      const data = await pull(req, cfg, kv);
      await audit(u.id, 'exams.sync', 'exam_data', 1, '同步 ' + data.majors.length + ' 场 · ' + data.title);
      return ok(res, {
        at: data.at, title: data.title, cls: classOf(data, cfg).name,
        majors: data.majors.length,
      });
    }

    /* 手动挑选：把某一场 / 某一天 / 整场考试上/下作业看板。只动我们自己的清单。 */
    if (act === 'pin') {
      const scope = str(b.scope, 10) || 'item';
      const id = str(b.id, 120);
      if (!id) return fail(res, 400, '缺少考试 id');
      if (['major', 'day', 'item'].indexOf(scope) < 0) return fail(res, 400, '未知的挑选层级');
      const on = b.on === true;
      const cur = await loadPins(kv);
      const p = {
        majors: cur.majors.slice(), days: cur.days.slice(),
        items: cur.items.slice(), off: cur.off.slice(),
      };
      const rm = function (arr, v) {
        const i = arr.indexOf(v);
        if (i >= 0) arr.splice(i, 1);
      };
      const add = function (arr, v) { if (arr.indexOf(v) < 0) arr.push(v); };

      if (scope === 'major') {
        if (on) {
          add(p.majors, id);
          /* 整场重新挑回来 = 我这场全都要，把之前单独划掉的那些撤掉 */
          const ids = idsOf(await kvGet(kv, K_DATA), id, '');
          p.off = p.off.filter(function (x) { return ids.indexOf(x) < 0; });
        } else {
          rm(p.majors, id);
        }
      } else if (scope === 'day') {
        if (on) {
          add(p.days, id);
          const bar = id.indexOf('|');
          if (bar > 0) {
            const ids = idsOf(await kvGet(kv, K_DATA), id.slice(0, bar), id.slice(bar + 1));
            p.off = p.off.filter(function (x) { return ids.indexOf(x) < 0; });
          }
        } else {
          rm(p.days, id);
        }
      } else {
        if (on) {
          add(p.items, id);
          /* 重新点回来时把之前的排除撤掉 */
          p.off = p.off.filter(function (x) { return x !== id; });
        } else {
          rm(p.items, id);
          /* 这一科若是被「整场」或「某天」带出来的，取消就要单独记一条排除，
             否则整场还挑着，它马上又冒出来 */
          const own = findItem(await kvGet(kv, K_DATA), id);
          if (own) {
            const base = pinOf(
              { majors: p.majors, days: p.days, items: [] },
              own.majorId, own.date, id,
            );
            if (base.on) add(p.off, id);
          }
        }
      }

      if (pinCount(p) > PIN_MAX) return fail(res, 400, '最多只能挑 ' + PIN_MAX + ' 项');
      const next = await savePins(kv, p);
      await audit(u.id, 'exams.pin', 'exam_data', 1,
        (on ? '加入' : '移出') + '（' + scope + '）：' + id);
      return ok(res, {
        pins: { majors: next.majors, days: next.days, items: next.items },
        at: next.at,
      });
    }

    /* 批量：把一段时间内的考试整段加上 / 整段移出 */
    if (act === 'bulk') {
      const from = str(b.from, 10);
      const to = str(b.to, 10);
      if (!isDay(from) || !isDay(to)) return fail(res, 400, '时间段不正确');
      if (from > to) return fail(res, 400, '开始日期晚于结束日期');
      const on = b.on === true;
      const cfg = await loadCfg(req);
      let data = (await takeData(req, cfg, kv, false)).data;
      if (!data) return fail(res, 400, '还没有考试数据，先同步一次');
      const cur = await loadPins(kv);
      const p = {
        majors: cur.majors.slice(), days: cur.days.slice(),
        items: cur.items.slice(), off: cur.off.slice(),
      };
      const rm = function (arr, v) {
        const i = arr.indexOf(v);
        if (i >= 0) arr.splice(i, 1);
      };
      const add = function (arr, v) { if (arr.indexOf(v) < 0) arr.push(v); };

      let hit = 0;
      groupAll(data, cfg, { majors: [], days: [], items: [], off: [] }).forEach(function (g) {
        const ds = g.days.filter(function (d) { return d.date >= from && d.date <= to; });
        if (!ds.length) return;
        hit += 1;
        if (ds.length === g.days.length) {
          /* 整场都在区间里 → 存整场，以后上游加科目也能自动带上 */
          if (on) add(p.majors, g.id); else rm(p.majors, g.id);
        } else {
          ds.forEach(function (d) {
            const k = g.id + '|' + d.date;
            if (on) add(p.days, k); else rm(p.days, k);
          });
        }
        /* 加了就别再排除里面的科目；移出了也把排除清掉，免得下次加回来缺科 */
        ds.forEach(function (d) {
          d.items.forEach(function (i) {
            p.off = p.off.filter(function (x) { return x !== i.id; });
          });
        });
      });

      if (pinCount(p) > PIN_MAX) return fail(res, 400, '最多只能挑 ' + PIN_MAX + ' 项');
      const next = await savePins(kv, p);
      await audit(u.id, 'exams.pin', 'exam_data', hit,
        (on ? '批量加入 ' : '批量移出 ') + from + ' ~ ' + to);
      return ok(res, {
        pins: { majors: next.majors, days: next.days, items: next.items },
        at: next.at, hit: hit,
      });
    }

    /* 清空挑选 */
    if (act === 'pinClear') {
      const next = await savePins(kv, { majors: [], days: [], items: [], off: [] });
      await audit(u.id, 'exams.pin', 'exam_data', 1, '清空手动挑选');
      return ok(res, {
        pins: { majors: next.majors, days: next.days, items: next.items },
        at: next.at,
      });
    }

    return fail(res, 400, '不支持的 action');
  } catch (e) {
    console.error('[exams]', e && e.stack ? e.stack : e);
    return fail(res, 500, String((e && e.message) || '服务器内部错误'));
  }
}
