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
const K_TOK = 'exam_tok_v1';

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
function buildDays(data, cfg, nowMs) {
  const cls = classOf(data, cfg);
  const today = dayOf(nowMs);
  const rows = [];
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
    if (!dates[today]) return;   /* 今天没有这场 → 整场不进来 */

    its.forEach(function (i) {
      const d = String(i.startTime).slice(0, 10);
      rows.push({
        date: d,
        name: i.name,
        start: hhmm(i.startTime),
        end: hhmm(i.endTime),
        major: m.name,
        majorId: m.id,
        temporary: m.temporary,
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

async function getToken(req, cfg, kv, force) {
  const cache = force ? null : (await kvGet(kv, K_TOK) || null);
  if (cache && cache.token && Number(cache.exp || 0) > Date.now() + 60 * 1000) return cache.token;
  if (!cfg.user || !cfg.pass) throw new Error('还没有填考试看板的账号密码');

  const r = await nvFetch(cfg.base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cfg.user, password: cfg.pass }),
  }, 10000);
  if (r.status === 429) throw new Error('登录太频繁，请过几分钟再试');
  if (r.status === 401) throw new Error('账号或密码不正确（连续错 5 次会锁 15 分钟）');
  if (r.status !== 200 || !r.json || !r.json.token) {
    throw new Error('登录失败（HTTP ' + r.status + '）');
  }
  const token = String(r.json.token);
  const exp = Number(r.json.expiresAt || 0) || (Date.now() + 20 * 3600 * 1000);
  if (kv) await kvPut(kv, K_TOK, { token: token, exp: exp, at: Date.now() });
  return token;
}

/** 只提交 majors 这一个域：其余字段服务端按域保留，不会因为没带就被清空 */
function toWire(majors) {
  return majors.map(function (m) {
    const o = {
      id: m.id,
      name: m.name,
      source: m.source,
      temporary: m.temporary,
      order: m.order,
      targetClassIds: m.targetClassIds,
      targetGradeIds: m.targetGradeIds,
      items: m.items,
    };
    if (m.startAt) o.startAt = m.startAt;
    if (m.endAt) o.endAt = m.endAt;
    if (m.publishedAt) o.publishedAt = m.publishedAt;
    if (m.createdVia) o.createdVia = m.createdVia;
    return o;
  });
}

async function push(req, cfg, kv, data) {
  const send = async function (tok) {
    return nvFetch(cfg.base + '/api/exams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
      body: JSON.stringify({
        majors: toWire(data.majors),
        baseUpdatedAt: Number(data.updatedAt || 0),
        baseRevisions: { major: Number((data.revisions || {}).major || 0) },
      }),
    }, 12000);
  };

  let tok = await getToken(req, cfg, kv, false);
  let r = await send(tok);
  if (r.status === 401) {
    tok = await getToken(req, cfg, kv, true);
    r = await send(tok);
  }
  if (r.status === 409) {
    return { conflict: true, message: '考试看板上的数据刚被改过，请先同步一次再写回' };
  }
  if (r.status !== 200 || !r.json || r.json.ok !== true) {
    const msg = (r.json && (r.json.error || r.json.code)) || ('HTTP ' + r.status);
    throw new Error('写回失败：' + msg);
  }
  data.updatedAt = Number(r.json.updatedAt || Date.now());
  if (r.json.revisions && typeof r.json.revisions === 'object') data.revisions = r.json.revisions;
  data.dirty = false;
  data.pushedAt = Date.now();
  if (kv) await kvPut(kv, K_DATA, data);
  _mem = { at: Date.now(), data: data };
  return { ok: true, updatedAt: data.updatedAt };
}

/* ---------------- 本地编辑 ---------------- */

function addLocal(data, cfg, p) {
  const cls = classOf(data, cfg);
  const date = str(p.date, 10);
  const start = str(p.start, 5);
  const end = str(p.end, 5);
  if (!isDay(date)) throw new Error('日期格式不对（应为 YYYY-MM-DD）');
  if (!isHm(start) || !isHm(end)) throw new Error('时间格式不对（应为 HH:MM）');
  const st = msOfLocal(date + 'T' + start);
  const en = msOfLocal(date + 'T' + end);
  if (!st || !en) throw new Error('日期或时间无法识别');
  if (en <= st) throw new Error('结束时间要晚于开始时间');

  const subject = str(p.subject, 20) || '考试';
  const name = str(p.name, 40) || (subject + '（临时）');
  const stamp = Date.now();
  const majorId = 'major_cs_' + stamp + '_' + rnd(4);
  const itemId = 'exam_cs_' + stamp + '_' + rnd(4);

  const maxOrder = data.majors.reduce(function (n, m) { return Math.max(n, Number(m.order || 0)); }, 0);
  data.majors.push({
    id: majorId,
    name: name,
    source: 'quick',
    temporary: true,
    order: maxOrder + 1,
    startAt: st,
    endAt: en,
    publishedAt: stamp,
    endedAt: 0,
    targetClassIds: cls.id ? [cls.id] : [],
    targetGradeIds: cls.gradeId ? [cls.gradeId] : [],
    local: true,
    items: [{
      id: itemId,
      name: subject,
      order: 0,
      enabled: true,
      startTime: date + 'T' + start,
      endTime: date + 'T' + end,
      targetClassIds: cls.id ? [cls.id] : [],
    }],
  });
  data.dirty = true;
  return { id: majorId, name: name };
}

/** 只允许删「本站加的」：考试看板里原本排好的段考不在站内提供删除入口 */
function delLocal(data, id) {
  const i = data.majors.findIndex(function (m) { return m.id === id; });
  if (i < 0) throw new Error('没有找到这场考试');
  if (!data.majors[i].local) throw new Error('这场考试是在考试看板里建的，请到那边删除');
  data.majors.splice(i, 1);
  data.dirty = true;
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
      return ok(res, {
        at: Number(data.at || 0),
        today: dayOf(now),
        days: buildDays(data, cfg, now),
        title: data.title || '',
        cls: classOf(data, cfg).name || '',
        dirty: data.dirty === true,
        srcAt: Number(data.updatedAt || 0),
      });
    }

    /* ---------- 读：后台（管理员） ---------- */
    if (req.method === 'GET' && action === 'state') {
      const u = await requireUser(req, res);
      if (!u) return;
      if (u.role !== 'admin') return fail(res, 403, '只有管理员能查看考试同步状态');
      const cfg = await loadCfg(req);
      const data = (await kvGet(kv, K_DATA)) || null;
      return ok(res, {
        cfg: {
          base: cfg.base,
          user: cfg.user,
          hasPass: cfg.hasPass,
          classId: cfg.classId,
          className: cfg.className,
          autoPush: cfg.autoPush,
        },
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

    /* ---------- 写：以下全部仅管理员 ---------- */
    if (req.method !== 'POST') return fail(res, 405, '不支持的方法');

    const u = await requireUser(req, res);
    if (!u) return;
    if (u.role !== 'admin') return fail(res, 403, '只有管理员能改考试数据');

    const b = (await body(req)) || {};
    const act = str(b.action, 20);

    /* 保存源地址 / 账号 / 绑定班级 */
    if (act === 'cfg') {
      const cfg = await loadCfg(req);
      cfg.base = (str(b.base, 200) || DEF_BASE).replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(cfg.base)) return fail(res, 400, '源地址要以 http:// 或 https:// 开头');
      cfg.user = str(b.user, 100);
      cfg.passNew = str(b.pass, 200) || '';   /* 留空 = 不改密码 */
      cfg.classId = str(b.classId, 80);
      cfg.className = str(b.className, 40);
      cfg.autoPush = b.autoPush === true;
      await saveCfg(req, cfg);
      /* 账号换了就把旧 token 丢掉，免得一直用别人的 */
      await kvDel(kv, K_TOK);
      await audit(u.id, 'exams.cfg', 'site_setting', 0, '考试同步：' + cfg.base + (cfg.user ? ' · ' + cfg.user : ''));
      return ok(res, { saved: true });
    }

    /* 测试连接（只拉公开快照，不需要密码） */
    if (act === 'test') {
      const cfg = await loadCfg(req);
      const r = await nvFetch(cfg.base + '/api/exams', { method: 'GET' }, 8000);
      if (r.status !== 200 || !r.json) return fail(res, 502, '连不上考试看板（HTTP ' + r.status + '）');
      const d = normSnap(r.json);
      const cls = classOf(d, cfg);
      return ok(res, { title: d.title, majors: d.majors.length, cls: cls.name, classes: d.classes.map(function (c) { return c.name; }) });
    }

    /* 同步：把云端整份快照拉到本机 */
    if (act === 'sync') {
      const cfg = await loadCfg(req);
      const old = (await kvGet(kv, K_DATA)) || null;
      if (old && old.dirty === true && b.force !== true) {
        return fail(res, 409, '本机还有没写回的改动，先写回或勾选「覆盖本机」再同步');
      }
      const data = await pull(req, cfg, kv);
      await audit(u.id, 'exams.sync', 'exam_data', 1, '同步 ' + data.majors.length + ' 场 · ' + data.title);
      return ok(res, {
        at: data.at, title: data.title, cls: classOf(data, cfg).name,
        majors: data.majors.length, dirty: false,
      });
    }

    /* 新增一场考试（先落本地，再按需要写回） */
    if (act === 'add') {
      const cfg = await loadCfg(req);
      let data = (await kvGet(kv, K_DATA)) || null;
      if (!data) data = await pull(req, cfg, kv);
      const made = addLocal(data, cfg, b);
      await kvPut(kv, K_DATA, data);
      _mem = { at: Date.now(), data: data };

      let pushed = false;
      let note = '';
      if (b.push === true) {
        try {
          const r = await push(req, cfg, kv, data);
          if (r && r.conflict) note = r.message;
          else pushed = true;
        } catch (e) {
          note = String((e && e.message) || e);
        }
      }
      await audit(u.id, 'exams.add', 'exam_data', 1, made.name + ' · 写回=' + (pushed ? '是' : '否'));
      return ok(res, { id: made.id, name: made.name, pushed: pushed, note: note, dirty: data.dirty === true });
    }

    /* 删除本站新增的考试 */
    if (act === 'del') {
      const cfg = await loadCfg(req);
      const data = (await kvGet(kv, K_DATA)) || null;
      if (!data) return fail(res, 400, '还没有同步过考试数据');
      delLocal(data, str(b.id, 80));
      await kvPut(kv, K_DATA, data);
      _mem = { at: Date.now(), data: data };
      let pushed = false;
      let note = '';
      if (b.push === true) {
        try {
          const r = await push(req, cfg, kv, data);
          if (r && r.conflict) note = r.message;
          else pushed = true;
        } catch (e) {
          note = String((e && e.message) || e);
        }
      }
      await audit(u.id, 'exams.del', 'exam_data', 1, str(b.id, 80) + ' · 写回=' + (pushed ? '是' : '否'));
      return ok(res, { pushed: pushed, note: note, dirty: data.dirty === true });
    }

    /* 写回：把本机 majors 整域提交给考试看板 */
    if (act === 'push') {
      const cfg = await loadCfg(req);
      const data = (await kvGet(kv, K_DATA)) || null;
      if (!data) return fail(res, 400, '还没有同步过考试数据');
      const r = await push(req, cfg, kv, data);
      if (r && r.conflict) return fail(res, 409, r.message);
      await audit(u.id, 'exams.push', 'exam_data', 1, data.majors.length + ' 场已写回');
      return ok(res, { updatedAt: r.updatedAt, majors: data.majors.length });
    }

    return fail(res, 400, '不支持的 action');
  } catch (e) {
    console.error('[exams]', e && e.stack ? e.stack : e);
    return fail(res, 500, String((e && e.message) || '服务器内部错误'));
  }
}
