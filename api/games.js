/* ============================================================
   /api/games  —— 游戏排行榜（第二十七轮 ⑪）
   ------------------------------------------------------------
   GET /api/games?action=leaderboard[&game=snake][&range=all|week]

   设计要点：
     ① 只读接口，但**必须登录**——排行榜上有全班同学姓名，
        不登录就能拉走等于把名单公开了（与「通讯录走账号」的口径一致）。
     ② 数据来自各游戏上云的 cls_game_play_<game>（累计游玩 + bestScore）
        与 cls_game_<...>_hi（最高分）。跨用户聚合，按分数降序。
     ③ 周榜：用「本周一 00:00」为界。周内分数取自各用户
        cls_game_week_<game>（前端每局结束顺手更新，见 games/cloud.js 的
        addPlay → 同时写 weekBest / weekAt），没有该键则周榜不计入。
        —— 这样不必在后端做时间窗口的日志聚合（免费版 CPU 有限），
        前端每局直接维护「本周最高分」这一个数字即可。
     ④ 只回必要字段（姓名、分数、时间），不回 userId / 不泄露其它数据。
   ============================================================ */

import { getSql } from './_lib/db.js';
import {
  cors, handlePreflight, ok, fail, requireUser, ensureSchema,
} from './_lib/http.js';

/* 支持上榜的游戏（与前端 GAMES 列表保持一致） */
const GAMES = {
  snake:  { name: '贪吃蛇',      icon: '🐍', unit: '豆',   key: 'snake_hi'  },
  bird:   { name: '像素飞鸟',    icon: '🐦', unit: '管',   key: 'bird_hi'   },
  tetris: { name: '俄罗斯方块',  icon: '🧱', unit: '分',   key: 'tetris_hi' },
  doodle: { name: '涂鸦跳跃',    icon: '🦘', unit: '高度', key: 'doodle_hi' },
};

/* 传入的 game 参数必须在这个表里，避免被拿来当任意键名拼接 */
function gameOf(g) {
  return Object.prototype.hasOwnProperty.call(GAMES, g) ? GAMES[g] : null;
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  cors(req, res);

  try {
    if (req.method === 'GET') {
      const action = String(req.query.action || 'leaderboard').toLowerCase();
      if (action === 'leaderboard') return await leaderboard(req, res);
      /* 游戏清单也要求登录：它虽然不含个人信息，但保持「/api/games
         整条路由都要登录」的口径更简单，也避免被当成公开接口扫描。 */
      if (action === 'games') {
        const u = await requireUser(req, res);
        if (!u) return;
        return ok(res, { games: gameList() });
      }
      return fail(res, 400, '不支持的 action：' + action);
    }
    return fail(res, 405, '不支持的方法');
  } catch (e) {
    console.error('[games]', req.method, e);
    return fail(res, 500, '服务器内部错误，请稍后重试');
  }
}

function gameList() {
  return Object.keys(GAMES).map((k) => ({ id: k, ...GAMES[k] }));
}

/* ---------------- 排行榜 ----------------
   参数：
     game   可选；给了只回该游戏，不给回全部
     range  'all'（默认，历史总榜）| 'week'（本周）
     limit  每榜取前 N 名（默认 20，上限 100）
*/
async function leaderboard(req, res) {
  /* 必须登录：榜上有姓名，不能匿名拉走 */
  const u = await requireUser(req, res);
  if (!u) return;

  await ensureSchema();

  const game = String(req.query.game || '').trim();
  if (game && !gameOf(game)) return fail(res, 400, '未知游戏：' + game);
  const range = String(req.query.range || 'all').toLowerCase() === 'week' ? 'week' : 'all';
  let limit = Number(req.query.limit) || 20;
  if (!(limit > 0)) limit = 20;
  if (limit > 100) limit = 100;

  const sql = getSql();
  const want = game ? [game] : Object.keys(GAMES);

  /* 一次性把所有人的这些键捞出来，再在 JS 里分组排序。
     为什么要全捞：Neon 的 jsonb 里存的是对象，SQL 里没法直接按
     「对象里的某个字段」排序而不写一堆 ->> 表达式；班级规模很小
     （几十人 × 4 款游戏 × 2 个键 = 几百行），全捞再排序最省事也最快，
     比逐游戏发 SQL 更省 Workers 的 CPU 配额。

     ⚠️ 用 `= any($1::text[])` 的整数组写法（与 api/content.js:99 同一套路）：
        写成散装占位会不报错但永远返回 0 行。 */
  const hiKeys = want.map((g) => 'cls_game_' + GAMES[g].key);
  const weekKeys = want.map((g) => 'cls_game_week_' + g);
  const wantKeys = hiKeys.concat(weekKeys);

  const rows = await sql`
    select u.id           as user_id,
           u.username     as username,
           u.display_name as display_name,
           d.data_key     as data_key,
           d.data_value   as data_value,
           d.updated_at   as updated_at
      from user_data d
      join users u on u.id = d.user_id
     where d.data_key = any(${wantKeys}::text[])
  `;

  /* 组织成 { 用户名: { game: {hi, week, at} } } */
  const byUser = new Map();
  function slot(uid, uname, dname) {
    let s = byUser.get(uid);
    if (!s) { s = { name: dname || uname || '同学', games: {} }; byUser.set(uid, s); }
    return s;
  }

  want.forEach((g) => {
    const hiK = 'cls_game_' + GAMES[g].key;
    const wkK = 'cls_game_week_' + g;
    rows.forEach((r) => {
      const key = String(r.data_key);
      if (key !== hiK && key !== wkK) return;
      const s = slot(r.user_id, r.username, r.display_name);
      const gs = s.games[g] || (s.games[g] = { hi: 0, week: 0, at: null });
      const v = jsonCol(r.data_value);
      if (key === hiK) {
        const n = Number(v);
        if (n > 0) gs.hi = n;
      } else {
        /* 周键存 { score, at } 或者直接一个数字，两种都兼容 */
        let sc = 0, at = null;
        if (v && typeof v === 'object') { sc = Number(v.score) || 0; at = v.at || null; }
        else sc = Number(v) || 0;
        if (sc > 0) { gs.week = sc; gs.at = at || gs.at; }
        if (r.updated_at) gs.at = gs.at || r.updated_at;
      }
    });
  });

  /* 生成榜单 */
  const out = {};
  want.forEach((g) => {
    const field = range === 'week' ? 'week' : 'hi';
    const list = [];
    byUser.forEach((s) => {
      const gs = s.games[g];
      if (!gs) return;
      const score = Number(gs[field]) || 0;
      if (score <= 0) return;
      list.push({ name: s.name, score, at: gs.at || null });
    });
    list.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));
    out[g] = {
      meta: GAMES[g],
      ranks: list.slice(0, limit).map((x, i) => ({ rank: i + 1, name: x.name, score: x.score, at: x.at })),
      total: list.length,
    };
  });

  return ok(res, {
    range,
    limit,
    games: out,
    serverTime: Date.now(),
  });
}

/* jsonb 列可能被驱动解析成对象、也可能还是字符串（与其它接口同款兼容） */
function jsonCol(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    try { return JSON.parse(s); } catch { return v; }
  }
  return v;
}
