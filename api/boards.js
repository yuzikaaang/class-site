/* ============================================================
 * /api/boards —— 板块分享链接
 * ------------------------------------------------------------
 * 站主原话（2026-10-20 晚）：
 *   「新增分享链接的功能（类似成绩分析的分享链接）……首先确保目前现有的板块和
 *     以后新增的板块都可以在后台查询到具体的位置并修改板块名称或简介；其次支持
 *     板块分享功能（成绩分析就不用了，灰色显示，告知分享用前台的那个）。可以生成
 *     包含该板块所有内容的分享链接，且内容也是链接数据库实时刷新的，就相当于一个
 *     快捷方式，用户打开直接跳转到对应位置，而且还可以一键返回主页。登录用户点击
 *     链接直接通过已登录账号访问，后台生成分享链接时可以设置未登录用户点击后是否
 *     需要登录才能继续访问，否则将弹窗拦截……也可以设置无需登录即可访问，但是如果
 *     有些板块需要登录才能查询的，即使设置了无需登录，他可以看到那个板块但查询还是
 *     得登录，比如个人信息查询。」
 *
 * 设计要点：
 *   · 链接不带任何内容快照 —— token 只负责「指向哪个板块/卡片」，
 *     页面每次都从数据库现拉，所以站主改完内容，旧链接打开就是新的。
 *   · 游客态只放行「这一条链接指向的板块」，其它板块点了弹登录
 *     （前后端都按这条执行：前端置灰，后端 resolve 也只下发一个 boardId）。
 *   · 「谁能看」是两级取交集：
 *       链接级 guest_ok（这条链接给不给游客）+ 板块/卡片级 guest_ok（这个板块/卡片
 *       本身允不允许游客看）。板块级默认允许，站主可在后台单独关掉敏感板块。
 *   · 成绩分析（板块 3）不开放分享：它有自己的分享体系，后台里直接置灰。
 * ============================================================ */

import { getSql } from './_lib/db.js';
import {
  cors, handlePreflight, ok, fail, body, requireUser, audit, currentUser, ensureSchema,
} from './_lib/http.js';

/* 不开放分享的板块（成绩分析）—— 它有自己的按次/按范围分享，别做两套 */
export const NO_SHARE_BOARDS = [3];

/* 默认板块目录：后台第一次打开时先有一份可看的清单。
   前端每次启动会把「当前真实结构」上报覆盖（见 index.html 的 reportBoardCatalog），
   所以以后加板块不用改这里，只是留个兜底。 */
const DEFAULT_CATALOG = {
  cats: [
    { id: 1, name: '常用服务', cards: [
      { id: '1', title: '点歌平台', sub: 'VoiceHub' },
      { id: '2', title: '作业查看', sub: 'Classworks' },
    ] },
    { id: 3, name: '成绩分析', cards: [] },
    { id: 7, name: '班级事务', cards: [
      { id: '17', title: '意见反馈', sub: '' },
      { id: '15', title: '排行榜', sub: '' },
      { id: '16', title: '班级活动', sub: '' },
    ] },
    { id: 8, name: '其他工具', cards: [
      { id: '10', title: '个人资料查询', sub: '' },
      { id: '11', title: '番茄时钟', sub: '' },
      { id: '12', title: '私人云盘', sub: '' },
    ] },
    { id: 2, name: '大屏服务', cards: [
      { id: '3', title: '班级课表', sub: 'ClassIsland' },
      { id: '4', title: '屏幕批注', sub: 'ICC-CE' },
      { id: '5', title: '听歌平台', sub: '' },
    ] },
    { id: 5, name: '学习资料', active: false, cards: [
      { id: '6', title: '课堂笔记', sub: '' },
      { id: '7', title: '教学课件', sub: '' },
    ] },
    { id: 9, name: '📲 安装为应用', cards: [] },
  ],
};

function token32() {
  const buf = new Uint8Array(18);
  crypto.getRandomValues(buf);
  return Array.from(buf, (x) => x.toString(36).padStart(2, '0')).join('').slice(0, 24);
}

async function readMeta(sql) {
  const rows = await sql`select data from board_meta where id = 1`;
  const d = rows && rows[0] && rows[0].data;
  if (!d) return { cats: {}, cards: {}, catalog: null, updatedAt: null };
  const obj = typeof d === 'string' ? JSON.parse(d) : d;
  return {
    cats: (obj && obj.cats) || {},
    cards: (obj && obj.cards) || {},
    catalog: (obj && obj.catalog) || null,
    updatedAt: (obj && obj.updatedAt) || null,
  };
}

async function writeMeta(sql, next) {
  const payload = JSON.stringify({
    cats: next.cats || {},
    cards: next.cards || {},
    catalog: next.catalog || null,
    updatedAt: new Date().toISOString(),
  });
  await sql`
    insert into board_meta (id, data, updated_at)
    values (1, ${payload}::jsonb, now())
    on conflict (id) do update set data = ${payload}::jsonb, updated_at = now()
  `;
}

/** 板块/卡片是否允许游客（缺省 true —— 站主没特意关就按可看处理） */
function guestAllowed(meta, boardId, cardRef) {
  const c = meta.cats && meta.cats[String(boardId)];
  if (c && c.guestOk === false) return false;
  if (cardRef) {
    const k = meta.cards && meta.cards[String(cardRef)];
    if (k && k.guestOk === false) return false;
  }
  return true;
}

function boardName(meta, boardId) {
  const c = meta.cats && meta.cats[String(boardId)];
  if (c && c.name) return String(c.name);
  const cat = (meta.catalog && meta.catalog.cats || DEFAULT_CATALOG.cats)
    .find((x) => Number(x.id) === Number(boardId));
  return (cat && cat.name) || ('板块 ' + boardId);
}

function boardIntro(meta, boardId) {
  const c = meta.cats && meta.cats[String(boardId)];
  return (c && c.intro) ? String(c.intro).slice(0, 200) : '';
}

function statusOf(L) {
  if (L.revoked) return 'revoked';
  if (L.expires_at && new Date(L.expires_at).getTime() <= Date.now()) return 'expired';
  if (L.max_views && Number(L.views) >= Number(L.max_views)) return 'usedUp';
  return 'alive';
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  cors(req, res);

  const action = String(req.query.action || '').toLowerCase();
  try {
    /* ⚠️ 必须先自愈表结构：本接口的 meta / resolve 是**游客也会调**的，
       不经过 requireUser（那条路才会 ensureSchema）。
       少了这一句，新库/刚升级的库第一次访问会因为没有 board_meta 直接 500。 */
    await ensureSchema();
    if (req.method === 'GET') {
      if (action === 'resolve') return await resolveLink(req, res);
      if (action === 'meta') return await getMeta(req, res);
      if (action === 'catalog') return await getCatalog(req, res);
      return fail(res, 400, '未知的 action');
    }
    if (req.method === 'POST') {
      if (action === 'catalog') return await reportCatalog(req, res);
      if (action === 'save-meta') return await saveMeta(req, res);
      if (action === 'share-create') return await shareCreate(req, res);
      if (action === 'share-list') return await shareList(req, res);
      if (action === 'share-update') return await shareUpdate(req, res);
      if (action === 'share-revoke') return await shareRevoke(req, res);
      if (action === 'share-stats') return await shareStats(req, res);
      return fail(res, 400, '未知的 action');
    }
    return fail(res, 405, '不支持的方法');
  } catch (e) {
    console.error('[boards]', action, e && e.stack ? e.stack : e);
    /* 临时诊断：把原因带出来（定位完立刻改回统一文案） */
    return fail(res, 500, '服务器内部错误', { detail: ('B/' + action + ': ' + String((e && e.message) || e)).slice(0, 260) });
  }
}

/* ---------- 公开：读板块元数据（改名/简介/排序/隐藏） ----------
   首屏和 render 都要用，不能要求登录（游客看到的也得是改过之后的名称）。 */
async function getMeta(req, res) {
  const sql = getSql();
  const meta = await readMeta(sql);
  return ok(res, {
    cats: meta.cats,
    cards: meta.cards,
    catalog: meta.catalog || DEFAULT_CATALOG,
    noShare: NO_SHARE_BOARDS,
    updatedAt: meta.updatedAt,
  });
}

async function getCatalog(req, res) {
  const sql = getSql();
  const meta = await readMeta(sql);
  return ok(res, { catalog: meta.catalog || DEFAULT_CATALOG, noShare: NO_SHARE_BOARDS });
}

/* ---------- 前端上报真实板块结构 ----------
   为什么要上报：板块写在 index.html 的 SITE_DATA 里，后台是另一个页面，
   拿不到那份数据。让首页启动时把「当前真实的板块和卡片」写一份到云端，
   后台「板块管理」就能列出来；以后新增板块，只要有人打开过首页就自动出现。 */
async function reportCatalog(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;
  const b = await body(req);
  const cats = Array.isArray(b && b.cats) ? b.cats : [];
  if (!cats.length) return fail(res, 400, 'catalog 为空');
  if (cats.length > 50) return fail(res, 400, '板块数量异常');

  const clean = cats.slice(0, 50).map((c) => ({
    id: Number(c.id) || 0,
    name: String(c.name || '').slice(0, 40),
    cards: Array.isArray(c.cards)
      ? c.cards.slice(0, 60).map((k) => ({
        id: String(k.id || '').slice(0, 20),
        title: String(k.title || '').slice(0, 60),
        sub: String(k.sub || '').slice(0, 40),
      }))
      : [],
    active: c.active !== false,
  })).filter((c) => c.id);

  const sql = getSql();
  const meta = await readMeta(sql);
  await writeMeta(sql, { ...meta, catalog: { cats: clean } });
  return ok(res, { count: clean.length });
}

/* ---------- 管理员：保存板块/卡片设置 ---------- */
async function saveMeta(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;
  if (u.role !== 'admin') return fail(res, 403, '只有管理员能改板块设置');

  const b = await body(req);
  const sql = getSql();
  const meta = await readMeta(sql);
  const cats = { ...meta.cats };
  const cards = { ...meta.cards };

  const inCats = b && b.cats && typeof b.cats === 'object' ? b.cats : {};
  for (const id of Object.keys(inCats).slice(0, 50)) {
    const v = inCats[id] || {};
    const cur = cats[id] || {};
    const next = { ...cur };
    if (v.name !== undefined) next.name = String(v.name).trim().slice(0, 40);
    if (v.intro !== undefined) next.intro = String(v.intro).trim().slice(0, 200);
    if (v.sort !== undefined) next.sort = Number(v.sort) || 0;
    if (v.hidden !== undefined) next.hidden = !!v.hidden;
    if (v.guestOk !== undefined) next.guestOk = !!v.guestOk;
    cats[id] = next;
  }
  const inCards = b && b.cards && typeof b.cards === 'object' ? b.cards : {};
  for (const id of Object.keys(inCards).slice(0, 300)) {
    const v = inCards[id] || {};
    const cur = cards[id] || {};
    const next = { ...cur };
    if (v.title !== undefined) next.title = String(v.title).trim().slice(0, 60);
    if (v.guestOk !== undefined) next.guestOk = !!v.guestOk;
    if (v.hidden !== undefined) next.hidden = !!v.hidden;
    cards[id] = next;
  }

  await writeMeta(sql, { ...meta, cats, cards });
  await audit(u.id, 'board.meta_save', 'board_meta', 1,
    Object.keys(inCats).length + ' 个板块 / ' + Object.keys(inCards).length + ' 张卡片');
  return ok(res, { cats, cards });
}

/* ---------- 公开：解析分享链接（游客也调得动，token 就是凭证） ---------- */
async function resolveLink(req, res) {
  const t = String(req.query.t || '').trim();
  if (!t) return fail(res, 400, '缺少分享标识');

  const sql = getSql();
  const rows = await sql`select * from board_links where token = ${t}`;
  if (!rows.length) return fail(res, 404, '链接不存在，可能已被撤销');
  const L = rows[0];

  if (L.revoked) return fail(res, 410, '这条链接已被撤销');
  if (L.expires_at && new Date(L.expires_at).getTime() <= Date.now()) {
    return fail(res, 410, '链接已过期，请向站主索取新的链接');
  }
  if (L.max_views && Number(L.views) >= Number(L.max_views)) {
    return fail(res, 410, '这条链接的查看次数已用完');
  }

  /* 管理员预览不消耗次数：站主在后台点「预览」只是自己看一眼。
     ⚠️ 这里必须用 currentUser（没登录就返回 null），不能用 requireUser ——
        后者会直接写 401，游客就打不开任何分享链接了。 */
  const u = await currentUser(req).catch(() => null);
  const isPreview = req.query.preview === '1' && u && u.role === 'admin';

  if (!isPreview) {
    await sql`update board_links
                 set views = views + 1, last_view_at = now()
               where id = ${L.id}`;
    let ip = '';
    try {
      ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '')
        .split(',')[0].trim().slice(0, 60);
    } catch (e) {}
    const ua = String(req.headers['user-agent'] || '').slice(0, 200);
    try {
      await sql`insert into board_link_views (link_id, user_id, name, ip, ua)
                values (${L.id}, ${u ? u.id : null},
                        ${u ? (u.name || u.display_name || u.username || '') : ''}, ${ip}, ${ua})`;
    } catch (e) { /* 统计失败不影响访问 */ }
  }

  const meta = await readMeta(sql);
  const guestOk = !!L.guest_ok && guestAllowed(meta, L.board_id, L.card_ref);

  return ok(res, {
    boardId: Number(L.board_id),
    card: L.card_ref || '',
    guestOk,
    note: L.note || '',
    name: boardName(meta, L.board_id),
    intro: boardIntro(meta, L.board_id),
    views: Number(L.views) + (isPreview ? 0 : 1),
    maxViews: L.max_views ? Number(L.max_views) : 0,
    expiresAt: L.expires_at || null,
  });
}

/* ---------- 管理员：新建分享 ---------- */
async function shareCreate(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;
  if (u.role !== 'admin') return fail(res, 403, '只有站主能生成板块分享链接');

  const b = await body(req);
  const boardId = Number(b.boardId || 0);
  if (!boardId) return fail(res, 400, '缺少板块 id');
  if (NO_SHARE_BOARDS.includes(boardId)) {
    return fail(res, 400, '「成绩分析」不在这里分享，请用成绩分析里的分享按钮');
  }

  const cardRef = String(b.card || '').trim().slice(0, 40);
  const guestOk = !!b.guestOk;
  const days = Math.max(0, Math.min(3650, Number(b.days || 0)));
  const maxViews = Math.max(0, Math.min(100000, Number(b.maxViews || 0)));
  const note = String(b.note || '').trim().slice(0, 40);

  const sql = getSql();
  const meta = await readMeta(sql);
  if (guestOk && !guestAllowed(meta, boardId, cardRef)) {
    return fail(res, 400, '这个板块（或这张卡片）在「板块管理」里设了「仅登录可见」，'
      + '不能生成免登录链接。先去后台把它的游客可见打开，或者这条链接改成「需要登录」。');
  }

  const token = token32();
  const expiresAt = days > 0 ? new Date(Date.now() + days * 86400000) : null;

  const ins = await sql`
    insert into board_links (token, board_id, card_ref, guest_ok, expires_at, max_views, note, created_by)
    values (${token}, ${boardId}, ${cardRef}, ${guestOk}, ${expiresAt}, ${maxViews || null}, ${note}, ${u.id})
    returning id`;

  await audit(u.id, 'board.share_create', 'board_link', Number(ins[0].id),
    'board ' + boardId + (cardRef ? '/card ' + cardRef : '') + (guestOk ? ' guest' : ''));

  return ok(res, {
    id: Number(ins[0].id),
    token,
    url: '/index.html?b=' + boardId + (cardRef ? '&c=' + encodeURIComponent(cardRef) : '') + '&t=' + token,
    boardId,
    card: cardRef,
    guestOk,
    note,
    days,
    maxViews,
    name: boardName(meta, boardId),
    intro: boardIntro(meta, boardId),
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  });
}

/* ---------- 管理员：列表 / 编辑 / 撤销 / 访问明细 ---------- */
async function shareList(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;
  if (u.role !== 'admin') return fail(res, 403, '需要管理员权限');

  const sql = getSql();
  const rows = await sql`
    select l.*, u.name as owner_name
      from board_links l left join users u on u.id = l.created_by
     order by l.created_at desc
     limit 200`;
  const meta = await readMeta(sql);

  const list = rows.map((L) => ({
    id: Number(L.id),
    token: L.token,
    boardId: Number(L.board_id),
    card: L.card_ref || '',
    name: boardName(meta, L.board_id),
    cardTitle: (() => {
      if (!L.card_ref) return '';
      const k = meta.cards && meta.cards[String(L.card_ref)];
      return (k && k.title) || '';
    })(),
    guestOk: !!L.guest_ok,
    note: L.note || '',
    intro: boardIntro(meta, L.board_id),
    /* 编辑弹窗要回填「有效期」，这里把剩余的整天数算出来（0 = 永久） */
    days: (() => {
      if (!L.expires_at) return 0;
      const left = new Date(L.expires_at).getTime() - Date.now();
      return left > 0 ? Math.max(1, Math.ceil(left / 86400000)) : 0;
    })(),
    views: Number(L.views) || 0,
    maxViews: L.max_views ? Number(L.max_views) : 0,
    expiresAt: L.expires_at || null,
    lastViewAt: L.last_view_at || null,
    createdAt: L.created_at || null,
    owner: L.owner_name || '',
    status: statusOf(L),
  }));
  return ok(res, { shares: list });
}

async function shareUpdate(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;
  if (u.role !== 'admin') return fail(res, 403, '需要管理员权限');

  const b = await body(req);
  const id = Number(b.id || 0);
  if (!id) return fail(res, 400, '缺少 id');

  const sql = getSql();
  const rows = await sql`select * from board_links where id = ${id}`;
  if (!rows.length) return fail(res, 404, '找不到这条分享');
  const L = rows[0];

  const note = b.note === undefined ? (L.note || '') : String(b.note).trim().slice(0, 40);
  const guestOk = b.guestOk === undefined ? !!L.guest_ok : !!b.guestOk;
  const days = b.days === undefined ? null : Math.max(0, Math.min(3650, Number(b.days || 0)));
  const maxViews = b.maxViews === undefined
    ? (L.max_views ? Number(L.max_views) : 0)
    : Math.max(0, Math.min(100000, Number(b.maxViews || 0)));
  const cardRef = b.card === undefined ? (L.card_ref || '') : String(b.card).trim().slice(0, 40);

  const meta = await readMeta(sql);
  if (guestOk && !guestAllowed(meta, L.board_id, cardRef)) {
    return fail(res, 400, '这个板块（或卡片）设了「仅登录可见」，不能改成免登录链接');
  }
  const expiresAt = days === null
    ? L.expires_at
    : (days > 0 ? new Date(Date.now() + days * 86400000) : null);

  await sql`update board_links
               set note = ${note}, guest_ok = ${guestOk}, expires_at = ${expiresAt},
                   max_views = ${maxViews || null}, card_ref = ${cardRef}
             where id = ${id}`;
  await audit(u.id, 'board.share_update', 'board_link', id, guestOk ? 'guest' : 'login');
  return ok(res, { id, note, guestOk, card: cardRef, maxViews, expiresAt });
}

async function shareRevoke(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;
  if (u.role !== 'admin') return fail(res, 403, '需要管理员权限');
  const b = await body(req);
  const id = Number(b.id || 0);
  if (!id) return fail(res, 400, '缺少 id');

  const sql = getSql();
  await sql`update board_links set revoked = true where id = ${id}`;
  await audit(u.id, 'board.share_revoke', 'board_link', id, '');
  return ok(res, { id, revoked: true });
}

async function shareStats(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;
  if (u.role !== 'admin') return fail(res, 403, '需要管理员权限');
  const b = await body(req);
  const id = Number(b.id || 0);
  if (!id) return fail(res, 400, '缺少 id');

  const sql = getSql();
  const rows = await sql`
    select * from board_link_views
     where link_id = ${id}
     order by created_at desc
     limit 60`;
  return ok(res, {
    views: rows.map((r) => ({
      name: r.name || '',
      userId: r.user_id ? Number(r.user_id) : 0,
      ip: r.ip || '',
      ua: r.ua || '',
      at: r.created_at || null,
    })),
  });
}
