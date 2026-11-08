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
    return { status: r.status, json: j, text: txt };
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
  const pinSet = {};
  ((pins && pins.ids) || []).forEach(function (x) { pinSet[x] = 1; });
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
      const pinned = !!pinSet[i.id];
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

async function pull(req, cfg, kv) {
  const r = await nvFetch(cfg.base + '/api/exams', { method: 'GET' }, 9000);
  if (r.status !== 200 || !r.json) {
    throw new Error('考试看板没有返回数据（HTTP ' + r.status + '）');
  }
  const data = normSnap(r.json);
  data.at = Date.now();
  data.dirty = false;
  const cls = classOf(data, cfg);
  data.clsId = cls.id;
  data.clsName = cls.name;
  if (kv) await kvPut(kv, K_DATA, data);
  _mem = { at: Date.now(), data: data };
  return data;
}


/* ---------------- 手动挑选（v4.10.8） ----------------
   站主原话（2026-11-08）：
     「暂时先不做写入，只做读取……新增考试那里改成考试看板，我可以一键查看所有的
       考试数据，考试数据最右边有个加号，点一下把我点的那一次考试放到作业看板上。」
   所以站内只保存「挑了哪几场」这一份清单，绝不碰上游的考试数据 —— 挑错了、删错了，
   考试看板那边一点影响都没有。清单极小（几十字节），存 KV 的 exam_pin_v1。 */

async function loadPins(kv) {
  const o = (await kvGet(kv, K_PIN)) || null;
  const ids = (o && Array.isArray(o.ids))
    ? o.ids.filter(function (x) { return typeof x === 'string' && x; })
    : [];
  return { ids: ids.slice(0, 80), at: Number((o && o.at) || 0) };
}

async function savePins(kv, ids) {
  const next = { ids: ids.slice(0, 80), at: Date.now() };
  if (kv) await kvPut(kv, K_PIN, next);
  return next;
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

/**
 * 把整份快照摊成「一天一场」的清单 —— 「查看所有考试」那个弹窗就用这份。
 * 和 buildDays 的区别：这里**不按今天过滤**，所有排过的考试都在，按时间升序。
 */
function listAll(data, cfg, pins) {
  const cls = classOf(data, cfg);
  const today = dayOf(Date.now());
  const pinSet = {};
  ((pins && pins.ids) || []).forEach(function (x) { pinSet[x] = 1; });
  const out = [];
  (data.majors || []).forEach(function (m) {
    if (!m.publishedAt && !m.temporary && !m.local) return;   /* 草稿不给看 */
    if (!majorOfClass(m, cls)) return;
    const its = itemsOfClass(m, cls);
    const dates = {};
    its.forEach(function (i) { dates[String(i.startTime).slice(0, 10)] = 1; });
    const auto = !!dates[today];   /* 今天自动就该显示的，弹窗里标「已显示」，不给加号 */
    its.forEach(function (i) {
      const d = String(i.startTime).slice(0, 10);
      out.push({
        auto: auto,
        id: i.id,
        date: d,
        start: hhmm(i.startTime),
        end: hhmm(i.endTime),
        name: i.name || '考试',
        major: m.name || '',
        majorId: m.id,
        temporary: m.temporary === true,
        pinned: !!pinSet[i.id],
      });
    });
  });
  out.sort(function (a, b) {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return String(a.start).localeCompare(String(b.start));
  });
  return out;
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
      let data = (!fresh && _mem.at && (Date.now() - _mem.at < MEM_MS)) ? _mem.data : null;
      if (!data) data = await kvGet(kv, K_DATA);
      if (!data) {
        /* 从没同步过：现拉一次，让大屏第一次打开就有东西看 */
        try {
          data = await pull(req, cfg, kv);
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
        pins: pins.ids,
        title: data.title || '',
        cls: classOf(data, cfg).name || '',
        dirty: data.dirty === true,
        srcAt: Number(data.updatedAt || 0),
      });
    }

    /* ---------- 读：全部考试（公开，「查看所有考试」弹窗用） ---------- */
    if (req.method === 'GET' && action === 'list') {
      const cfg = await loadCfg(req);
      let data = _mem.at && (Date.now() - _mem.at < MEM_MS) ? _mem.data : null;
      if (!data) data = await kvGet(kv, K_DATA);
      if (!data) {
        try {
          data = await pull(req, cfg, kv);
        } catch (e) {
          return ok(res, {
            at: 0, today: dayOf(Date.now()), items: [], pins: [], empty: true,
            error: '还没有同步过考试数据',
          });
        }
      }
      const pins = await loadPins(kv);
      return ok(res, {
        at: Number(data.at || 0),
        today: dayOf(Date.now()),
        title: data.title || '',
        cls: classOf(data, cfg).name || '',
        srcAt: Number(data.updatedAt || 0),
        base: cfg.base,
        items: listAll(data, cfg, pins),
        pins: pins.ids,
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
        pins: pins.ids,
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

    /* 手动挑选：把某一场上/下作业看板。只动我们自己的清单，不碰上游。 */
    if (act === 'pin') {
      const id = str(b.id, 80);
      if (!id) return fail(res, 400, '缺少考试 id');
      const on = b.on === true;
      const pins = await loadPins(kv);
      const has = pins.ids.indexOf(id) >= 0;
      let ids = pins.ids.slice();
      if (on && !has) ids.push(id);
      if (!on && has) ids = ids.filter(function (x) { return x !== id; });
      /* 上限 80 场，防止误操作把整份考试表都塞进来 */
      if (ids.length > 80) return fail(res, 400, '最多只能挑 80 场');
      const next = await savePins(kv, ids);
      await audit(u.id, 'exams.pin', 'exam_data', 1, (on ? '加入' : '移出') + '：' + id);
      return ok(res, { ids: next.ids, at: next.at });
    }

    /* 清空挑选 */
    if (act === 'pinClear') {
      const next = await savePins(kv, []);
      await audit(u.id, 'exams.pin', 'exam_data', 1, '清空手动挑选');
      return ok(res, { ids: next.ids, at: next.at });
    }

    return fail(res, 400, '不支持的 action');
  } catch (e) {
    console.error('[exams]', e && e.stack ? e.stack : e);
    return fail(res, 500, String((e && e.message) || '服务器内部错误'));
  }
}
