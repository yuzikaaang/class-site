/* ============================================================
   /api/music —— 歌曲时长补全 + 云端时长库（v3.5.20 → v3.5.27）
   ------------------------------------------------------------
   背景：VoiceHub 的 /api/open/songs 里 durationSeconds 全是 null
   （站主这个实例没填时长），于是「按时长抽歌」「总时长统计」都用不了。
   站主原话：「api 获取不了歌曲时长的吗？如果不能看看能不能线上搜索获取」。

   v3.5.27 站主新要求（原话摘要）：
     「一定要获取到歌曲时长并同步云端，省的每次都要加载，
       渠道有网易云和 QQ 音乐，如果两个都没有找到由我人工填写，
       否则无法发布投票或者随机排歌」

   于是拆成两层：
     · **云端时长库** `song_durations` 表 —— 查到的秒数写进数据库，
       以后任何设备、任何浏览器打开都是「一次查询、永久命中」，
       不再每次开页面都去搜一遍（以前只存 localStorage，换设备就没了）。
     · **查不到就要求人工填** —— 返回 seconds=null，前端弹「时长补录」，
       站主手填后再写库（source='manual'），并**锁定不被自动结果覆盖**。

   数据来源优先级（source 字段）：
     manual > netease > qq > itunes
   人工填过的一律不覆盖；三个自动源里网易云 / QQ 音乐优先（站主指定），
   iTunes 只作最后兜底（Apple 对 Cloudflare 出口友好，命中率高）。

   接口：
     GET  /api/music?action=duration&title=幻听&artist=许嵩
     GET  /api/music?action=search&q=晴天&limit=20   // v3.5.28 线上搜歌（列候选，不写库）
     POST /api/music   { action:'batch',   items:[{title,artist}, ...] }  // 最多 12 条
     POST /api/music   { action:'manual',  items:[{title,artist,seconds}, ...] } // 人工补录
     POST /api/music   { action:'save-many', items:[{title,artist,seconds,source}] } // 批量写库
     GET  /api/music?action=lib                     // 拉全量时长库
     POST /api/music   { action:'lib-query', items:[...] } // 只查库、不联网
     POST /api/music   { action:'match-list', items:[{title,artist}, ...] } // v3.5.28 导入清单批量匹配
     POST /api/music   { action:'del', items:[...] }        // 删错录的
   ============================================================ */

import { cors, handlePreflight, ok, fail, body, ensureSchema, getSql } from './_lib/http.js';

const TTL_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 5000;
const cache = new Map();          /* "title|artist" -> { at, seconds } */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 归一化：去括号内容、空格、连字符，小写；顺便把常见繁体转简体（够比对就行） */
function norm(s) {
  return String(s == null ? '' : s)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s·・\-—_]/g, '')
    .toLowerCase()
    .replace(/聽/g, '听').replace(/說/g, '说').replace(/夢/g, '梦')
    .replace(/愛/g, '爱').replace(/時/g, '时');
}

function valid(sec) {
  return sec >= 20 && sec <= 1800;   /* 20 秒～30 分钟，挡掉试听/广告/离谱值 */
}

async function getJson(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: Object.assign({ 'User-Agent': UA }, headers || {}) });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ① 网易云：duration 是毫秒 */
async function fromNetease(title, artist) {
  const q = [title, artist].filter(Boolean).join(' ');
  const j = await getJson(
    'https://music.163.com/api/search/get/web?s=' + encodeURIComponent(q) + '&type=1&limit=5',
    { Referer: 'https://music.163.com/' }
  );
  const songs = (j && j.result && j.result.songs) || [];
  let fallback = null;   /* 歌名对、歌手对不上 —— 只有在完全没有更优结果时才用 */
  for (const s of songs) {
    const ms = Number(s.duration);
    if (!isFinite(ms)) continue;
    const sec = Math.round(ms / 1000);
    if (!valid(sec)) continue;
    const nameOk = norm(s.name) === norm(title);
    if (!nameOk) continue;
    const singers = (s.artists || []).map((a) => a.name || '').join('/');
    const singerOk = !artist || norm(singers).includes(norm(artist))
      || norm(artist).includes(norm(singers.split('/')[0]));
    if (singerOk) return sec;
    if (fallback == null) fallback = sec;
  }
  /* 🔴 v3.5.27：**不再退回「搜索结果第一条」**。
     实测「不存在的歌名xyzabc / 无人」也能返回 236 秒 —— 那是别人的歌，
     会把一首查不到的歌静默填成错的时长，比留空更糟（排歌时间全乱）。
     宁可返回 null 让站主手填。 */
  return fallback;
}

/* ② iTunes：trackTimeMillis 毫秒 */
async function fromItunes(title, artist) {
  const q = [title, artist].filter(Boolean).join(' ');
  const j = await getJson('https://itunes.apple.com/search?term=' + encodeURIComponent(q) + '&entity=song&limit=5');
  const list = (j && j.results) || [];
  let fallback = null;
  for (const s of list) {
    const ms = Number(s.trackTimeMillis);
    if (!isFinite(ms)) continue;
    const sec = Math.round(ms / 1000);
    if (!valid(sec)) continue;
    const nameOk = norm(s.trackName) === norm(title);
    if (!nameOk) continue;
    const singerOk = !artist || norm(s.artistName).includes(norm(artist));
    if (singerOk) return sec;
    if (fallback == null) fallback = sec;
  }
  /* 同上：不退回第一条 */
  return fallback;
}

/* ③ QQ 音乐：interval 是秒（Cloudflare 出口可能被风控，做最后兜底） */
async function fromQQ(title, artist) {
  const q = [title, artist].filter(Boolean).join(' ');
  const j = await getJson(
    'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=' + encodeURIComponent(q) + '&format=json&n=5&cr=1&new_json=1',
    { Referer: 'https://y.qq.com/' }
  );
  const list = (j && j.data && j.data.song && j.data.song.list) || [];
  let fallback = null;
  for (const s of list) {
    const sec = Number(s.interval);
    if (!valid(sec)) continue;
    const nameOk = norm(s.name) === norm(title);
    if (!nameOk) continue;
    const singers = (s.singer || []).map((x) => x.name || '').join('/');
    const singerOk = !artist || norm(singers).includes(norm(artist))
      || norm(artist).includes(norm(singers.split('/')[0]));
    if (singerOk) return sec;
    if (fallback == null) fallback = sec;
  }
  /* 同上：不退回第一条，宁可 null（理由见 fromNetease） */
  return fallback;
}

/* ---------------- 云端时长库：song_durations ----------------
 * key 用「归一化后的歌名|歌手」，这样「（Live）」这类后缀差异也能命中同一行。
 * 表结构见 _lib/http.js 的 ensureSchema（升级路径 + 全量清单 + schema.sql 三处同步）。
 * ------------------------------------------------------------------ */
const SOURCE_RANK = { manual: 3, netease: 2, qq: 2, itunes: 1 };
const KEY_MAX = 160;

/** 库主键：归一化歌名 + 归一化歌手（都压掉括号/空格/大小写） */
function libKey(title, artist) {
  const k = norm(title).slice(0, 100) + '|' + norm(artist).slice(0, 60);
  return k.slice(0, KEY_MAX);
}

let libReady = false;
async function lib(sql) {
  if (!libReady) {
    /* ensureSchema 幂等且带版本闸门，稳态只花 1 次子请求 */
    try { await ensureSchema(sql); } catch (e) {}
    libReady = true;
  }
  return sql;
}

/** 批量查库：返回 Map(key -> {seconds, source}) —— 一次 SQL 查完，不按首数叠加子请求 */
async function libLookup(sql, keys) {
  const out = new Map();
  const uniq = [...new Set(keys.filter(Boolean))];
  if (!uniq.length) return out;
  const rows = await sql`
    select song_key, seconds, source from song_durations where song_key = any(${uniq})
  `;
  (rows || []).forEach((r) => {
    const sec = Number(r.seconds);
    if (sec > 0) out.set(r.song_key, { seconds: sec, source: r.source || 'auto' });
  });
  return out;
}

/** 写库（同 key 时按 source 优先级决定要不要覆盖；人工填的永远优先） */
async function libSave(sql, items) {
  const list = (Array.isArray(items) ? items : []).slice(0, 40);
  const saved = [];
  for (const it of list) {
    const title = String(it && it.title || '').trim().slice(0, 100);
    const artist = String(it && it.artist || '').trim().slice(0, 60);
    const sec = Math.round(Number(it && it.seconds));
    if (!title || !valid(sec)) continue;
    const key = libKey(title, artist);
    let src = String((it && it.source) || 'auto').toLowerCase();
    if (!['manual', 'netease', 'qq', 'itunes', 'auto'].includes(src)) src = 'auto';
    try {
      /* on conflict：只在「新来源优先级更高」或「原来没数据」时覆盖。
         人工填的（manual=3）不会被自动结果冲掉 —— 站主手填就该算数。 */
      const r = await sql`
        insert into song_durations (song_key, title, artist, seconds, source, updated_at)
        values (${key}, ${title}, ${artist}, ${sec}, ${src}, now())
        on conflict (song_key) do update
          set seconds = excluded.seconds,
              source  = excluded.source,
              title   = excluded.title,
              artist  = excluded.artist,
              updated_at = now()
          where (
            case song_durations.source
              when 'manual' then 3 when 'netease' then 2 when 'qq' then 2 when 'itunes' then 1 else 0 end
          ) < (
            case excluded.source
              when 'manual' then 3 when 'netease' then 2 when 'qq' then 2 when 'itunes' then 1 else 0 end
          )
          or song_durations.seconds is null
          or song_durations.seconds <= 0
        returning song_key, seconds, source
      `;
      if (r && r[0]) saved.push({ key: r[0].song_key, seconds: Number(r[0].seconds), source: r[0].source });
      else saved.push({ key, seconds: sec, source: src, kept: true });  /* 被更高优先级挡住了 */
    } catch (e) {
      /* 写库失败不影响本次返回：前端仍拿到秒数，下次再补 */
      console.warn('[music] 写时长库失败', key, e && e.message);
    }
  }
  return saved;
}

/** 查一首：先查库 → 没有再联网（三源并行） → 有结果就写库 */
async function queryOne(title, artist, sql) {
  const t = String(title || '').trim().slice(0, 60);
  const a = String(artist || '').trim().slice(0, 40);
  if (!t) return { seconds: null, source: null };

  const key = libKey(t, a);
  /* ① 内存缓存（同一实例内，省掉 SQL） */
  const hit = cache.get(key);
  if (hit && (Date.now() - hit.at < (hit.short ? 3 * 60 * 1000 : TTL_MS))) {
    return { seconds: hit.seconds, source: hit.source || null };
  }

  /* ② 云端库 */
  if (sql) {
    try {
      const m = await libLookup(sql, [key]);
      const row = m.get(key);
      if (row) {
        cache.set(key, { at: Date.now(), seconds: row.seconds, source: row.source });
        return { seconds: row.seconds, source: row.source };
      }
    } catch (e) { /* 库查不到就继续联网，不阻塞 */ }
  }

  /* ③ 联网三源并行（网易云 / QQ 优先，iTunes 兜底） */
  const results = await Promise.all([
    fromNetease(t, a).then((v) => (v == null ? null : { v, src: 'netease' })).catch(() => null),
    fromQQ(t, a).then((v) => (v == null ? null : { v, src: 'qq' })).catch(() => null),
    fromItunes(t, a).then((v) => (v == null ? null : { v, src: 'itunes' })).catch(() => null),
  ]);
  const picked = results.find((x) => x && x.v != null) || null;
  const seconds = picked ? picked.v : null;
  const source = picked ? picked.src : null;

  /* ④ 命中就写云端库（一次查询、永久命中） */
  if (seconds != null && sql) {
    try { await libSave(sql, [{ title: t, artist: a, seconds, source }]); } catch (e) {}
  }
  /* ⚠️ 只长缓存「成功」结果：null 只存 3 分钟，否则一次网络抖动会把这首歌锁死半小时 */
  cache.set(key, { at: Date.now(), seconds, short: seconds == null, source });
  return { seconds, source };
}

/** 取 sql 实例；拿不到就返回 null（测试环境没配库时仍能联网查） */
function trySql() {
  try { return getSql(); } catch (e) { return null; }
}

/* ---------------- v3.5.28：线上搜歌（模糊搜索候选） ----------------
 * 站主要求：「时长库那个里面也可以搜歌，直接线上搜歌，我搜歌名，
 *   然后匹配出对应的歌手和时长，点击它就加到时长库」。
 *
 * 与 queryOne 的区别：
 *   queryOne 是「精确拿一首的秒数」（歌名必须完全一致）；
 *   这里要「列出一批候选」，所以把三个源的原始结果都摊平出来，
 *   带上歌名 / 歌手 / 时长 / 来源，让站主自己挑。
 * ------------------------------------------------------------------ */

/** 从网易云拿候选（最多 limit 条） */
async function searchNetease(kw, limit) {
  const j = await getJson(
    'https://music.163.com/api/search/get/web?s=' + encodeURIComponent(kw) + '&type=1&limit=' + limit,
    { Referer: 'https://music.163.com/' }
  );
  const songs = (j && j.result && j.result.songs) || [];
  const out = [];
  for (const s of songs) {
    const ms = Number(s.duration);
    if (!isFinite(ms)) continue;
    const sec = Math.round(ms / 1000);
    if (!valid(sec)) continue;
    const name = String(s.name || '').trim();
    if (!name) continue;
    const singers = (s.artists || []).map((a) => a.name || '').filter(Boolean).join('/');
    out.push({ title: name, artist: singers, seconds: sec, source: 'netease', album: (s.album && s.album.name) || '' });
  }
  return out;
}

/** 从 QQ 音乐拿候选 */
async function searchQQ(kw, limit) {
  const j = await getJson(
    'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=' + encodeURIComponent(kw) + '&format=json&n=' + limit + '&cr=1&new_json=1',
    { Referer: 'https://y.qq.com/' }
  );
  const list = (j && j.data && j.data.song && j.data.song.list) || [];
  const out = [];
  for (const s of list) {
    const sec = Number(s.interval);
    if (!valid(sec)) continue;
    const name = String(s.name || '').trim();
    if (!name) continue;
    const singers = (s.singer || []).map((x) => x.name || '').filter(Boolean).join('/');
    out.push({ title: name, artist: singers, seconds: sec, source: 'qq', album: (s.album && s.album.name) || '' });
  }
  return out;
}

/** 从 iTunes 拿候选（前两源都没结果时兜底） */
async function searchItunes(kw, limit) {
  const j = await getJson('https://itunes.apple.com/search?term=' + encodeURIComponent(kw) + '&entity=song&limit=' + limit);
  const list = (j && j.results) || [];
  const out = [];
  for (const s of list) {
    const ms = Number(s.trackTimeMillis);
    if (!isFinite(ms)) continue;
    const sec = Math.round(ms / 1000);
    if (!valid(sec)) continue;
    const name = String(s.trackName || '').trim();
    if (!name) continue;
    out.push({ title: name, artist: String(s.artistName || '').trim(), seconds: sec, source: 'itunes', album: String(s.collectionName || '') });
  }
  return out;
}

/** v3.5.28：歌手匹配打分。
 *  站主要求：「歌名完全符合，歌手只要部分符合就行 —— 歌单里五六个歌手合唱，
 *  我后台只写了一个歌手，这样也算」。
 *  3 = 完全一致；2 = 一方包含另一方；1 = 有共同歌手；0 = 都没写歌手；-1 = 完全不沾边 */
function artistScore(a, b) {
  const A = norm(a), B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 3;
  /* 按 / 、& 等分隔符拆成歌手集合 */
  const split = (x) => String(x || '').split(/[\/、,，&＆+＋·]/).map((y) => norm(y)).filter(Boolean);
  const sa = split(a), sb = split(b);
  /* 各取一个歌手互相包含也算（「周杰伦」vs「周杰伦jay」这种） */
  for (const x of sa) {
    for (const y of sb) {
      if (x === y) return 2;
      if (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))) return 2;
    }
  }
  if (A.includes(B) || B.includes(A)) return 2;
  return -1;
}

/** 合并去重 + 排序：同一 (歌名, 歌手) 只留一条；标出是否已在库里。
 *  ⚠️ 实测教训：搜「晴天」时网易云前 8 条全是翻唱（深情版 / 女声版 / Cover），
 *  原唱周杰伦反而排在 QQ 音乐里。所以不能只按来源顺序堆，
 *  要按「歌名匹配紧密度」排：完全一致 > 去掉括号后一致 > 只是包含关键字。
 *  否则站主点第一个点到的就是翻唱版，时长也跟着错。 */
function mergeCandidates(groups, libMap, keyword) {
  const seen = new Map();
  const kw = norm(keyword || '');
  const titleScore = (t) => {
    const n = norm(t);
    if (!n) return 0;
    if (n === kw) return 3;                         /* 完全一致 */
    if (kw && n.startsWith(kw)) return 2;           /* 以关键字开头（如「晴天 (Live)」归一后仍是「晴天」→ 其实上面就命中了） */
    if (kw && n.includes(kw)) return 1;             /* 只是包含 */
    return 0.5;
  };
  for (const g of groups) {
    for (const c of (g || [])) {
      const k = libKey(c.title, c.artist);
      const hit = libMap.get(k);
      const row = {
        title: c.title,
        artist: c.artist,
        seconds: c.seconds,
        source: c.source,
        album: c.album || '',
        key: k,
        inLib: !!hit,
        libSeconds: hit ? hit.seconds : null,
        libSource: hit ? hit.source : null,
        /* 排序用，不展示 */
        _t: titleScore(c.title),
        _src: SOURCE_RANK[c.source] || 0,
      };
      const prev = seen.get(k);
      if (!prev) { seen.set(k, row); continue; }
      if (row.inLib && !prev.inLib) seen.set(k, row);
    }
  }
  const list = [...seen.values()];
  list.sort((a, b) => {
    /* 已收录的排最前（方便一眼看到「这条已经有了」） */
    if (a.inLib !== b.inLib) return a.inLib ? -1 : 1;
    if (b._t !== a._t) return b._t - a._t;          /* 歌名越贴近越前 */
    if (b._src !== a._src) return b._src - a._src;  /* 同分时网易云/QQ 优先于 iTunes */
    return a.seconds - b.seconds;
  });
  return list.map((x) => {
    const o = Object.assign({}, x);
    delete o._t; delete o._src;
    return o;
  });
}

export default async function musicHandler(req, res) {
  if (handlePreflight(req, res)) return;
  cors(req, res);

  const u = new URL(req.url, 'http://x');
  const action = u.searchParams.get('action') || '';
  const sql = trySql();

  /* ---------------- GET ---------------- */
  if (req.method === 'GET') {
    if (action === 'duration') {
      const r = await queryOne(u.searchParams.get('title'), u.searchParams.get('artist'), sql);
      return ok(res, { seconds: r.seconds == null ? null : r.seconds, source: r.source });
    }

    /* v3.5.28：线上搜歌 —— 输入歌名（可带歌手），返回一批候选：
       歌名 / 歌手 / 时长 / 来源，前端点一下就能写进时长库。
       先用网易云 + QQ 音乐（站主指定），都没有再让 iTunes 兜底。 */
    if (action === 'search') {
      const kw = String(u.searchParams.get('q') || '').trim().slice(0, 60);
      const limit = Math.min(30, Math.max(5, Number(u.searchParams.get('limit')) || 15));
      if (!kw) return fail(res, 400, '请输入歌名');
      const [ne, qq] = await Promise.all([
        searchNetease(kw, limit).catch(() => []),
        searchQQ(kw, limit).catch(() => []),
      ]);
      let groups = [ne, qq];
      if (!ne.length && !qq.length) {
        const it = await searchItunes(kw, limit).catch(() => []);
        groups = [it];
      }
      /* 查库用于标注「已收录」 —— 一次 SQL 拿全部候选的 key */
      let libMap = new Map();
      if (sql) {
        try {
          const all = [];
          groups.forEach((g) => g.forEach((c) => all.push(libKey(c.title, c.artist))));
          libMap = await libLookup(sql, all);
        } catch (e) {}
      }
      const list = mergeCandidates(groups, libMap, kw);
      return ok(res, { list, total: list.length, q: kw });
    }

    /* 拉全量时长库：前端一次下载后本地命中，不用每首歌都问一次 */
    if (action === 'lib') {
      if (!sql) return fail(res, 500, '数据库未配置');
      try {
        await ensureSchema(sql);
        const rows = await sql`
          select song_key, title, artist, seconds, source, updated_at
            from song_durations
           order by updated_at desc
           limit 3000
        `;
        const list = (rows || []).map((r) => ({
          key: r.song_key,
          title: r.title || '',
          artist: r.artist || '',
          seconds: Number(r.seconds) || 0,
          source: r.source || 'auto',
        }));
        return ok(res, { list, total: list.length });
      } catch (e) {
        return fail(res, 500, '读取时长库失败：' + (e && e.message ? e.message : e));
      }
    }

    return fail(res, 400, '未知动作：' + action);
  }

  /* ---------------- POST ---------------- */
  if (req.method === 'POST') {
    /* ⚠️ 这个项目的 req 不是标准 Request，没有 req.json() —— 用公共的 body() */
    let payload = null;
    try { payload = await body(req); } catch (e) { payload = null; }
    const act = String((payload && payload.action) || 'batch');
    const rawItems = (payload && Array.isArray(payload.items)) ? payload.items : [];

    /* ① 批量查时长：先一次性查库，库里没有的再联网查（最多 12 条，避免撞 50 子请求上限） */
    if (act === 'batch') {
      const items = rawItems.slice(0, 12);
      if (!items.length) return fail(res, 400, 'items 不能为空（最多 12 条）');

      const norm1 = items.map((it) => ({
        title: String((it && it.title) || '').trim(),
        artist: String((it && it.artist) || '').trim(),
      }));

      /* 一次 SQL 把库里有的全捞出来 */
      let hitMap = new Map();
      if (sql) {
        try { hitMap = await libLookup(sql, norm1.map((x) => libKey(x.title, x.artist))); } catch (e) {}
      }

      const list = await Promise.all(norm1.map(async (x) => {
        const key = libKey(x.title, x.artist);
        const hit = hitMap.get(key);
        if (hit) {
          cache.set(key, { at: Date.now(), seconds: hit.seconds, source: hit.source });
          return { title: x.title, artist: x.artist, seconds: hit.seconds, source: hit.source, cached: true };
        }
        const r = await queryOne(x.title, x.artist, sql);
        return { title: x.title, artist: x.artist, seconds: r.seconds, source: r.source, cached: false };
      }));
      return ok(res, { list });
    }

    /* ② 只查库、不联网（前端批量校验"哪些还缺时长"，快且不耗子请求） */
    if (act === 'lib-query') {
      const items = rawItems.slice(0, 60);
      if (!items.length) return fail(res, 400, 'items 不能为空（最多 60 条）');
      let hitMap = new Map();
      if (sql) {
        try {
          hitMap = await libLookup(sql, items.map((x) => libKey(String(x && x.title || ''), String(x && x.artist || ''))));
        } catch (e) {}
      }
      const list = items.map((x) => {
        const title = String(x && x.title || '').trim();
        const artist = String(x && x.artist || '').trim();
        const hit = hitMap.get(libKey(title, artist));
        return { title, artist, seconds: hit ? hit.seconds : null, source: hit ? hit.source : null };
      });
      return ok(res, { list });
    }

    /* ③ 人工补录：站主手填的秒数，source='manual'，优先级最高、永不被自动结果覆盖 */
    if (act === 'manual') {
      if (!sql) return fail(res, 500, '数据库未配置，无法保存时长');
      const items = rawItems.slice(0, 40);
      if (!items.length) return fail(res, 400, 'items 不能为空');
      const bad = [];
      const clean = [];
      items.forEach((it) => {
        const title = String((it && it.title) || '').trim();
        const seconds = Math.round(Number(it && it.seconds));
        if (!title || !valid(seconds)) { bad.push(title || '(空歌名)'); return; }
        clean.push({ title, artist: String((it && it.artist) || '').trim(), seconds, source: 'manual' });
      });
      if (!clean.length) return fail(res, 400, '时长不合法（需 20 秒 ~ 30 分钟）：' + bad.join('、'));
      try { await ensureSchema(sql); } catch (e) {}
      const saved = await libSave(sql, clean);
      saved.forEach((x) => cache.set(x.key, { at: Date.now(), seconds: x.seconds, source: x.source }));
      return ok(res, {
        saved: saved.length,
        list: saved,
        skipped: bad,
        message: '已保存 ' + saved.length + ' 首的时长到云端' + (bad.length ? '（' + bad.length + ' 首时长不合法已跳过）' : ''),
      });
    }

    /* ④ v3.5.28：按「导入的歌曲清单」批量匹配时长库。
       站主要求：「我导入歌名和歌手，如果拉取的歌单里面也有同样的歌名和歌手，
       只要相似就行 —— 歌名完全符合，歌手部分符合（合唱多歌手 vs 我只写一个）也行」。
       所以这里做「歌名归一后完全相等 + 歌手有交集」的匹配：
         · 歌单里是「周杰伦/费玉清」，库里写「周杰伦」→ 命中
         · 歌单里是「周杰伦」，库里写「周杰伦/费玉清」→ 也命中
       返回每个导入项命中的秒数（没命中给 null，由站主决定去搜/手填）。 */
    if (act === 'match-list') {
      const items = rawItems.slice(0, 200);
      if (!items.length) return fail(res, 400, 'items 不能为空');
      if (!sql) return fail(res, 500, '数据库未配置');
      /* 一次性把库里所有条目取回来（时长库通常几百条，一次 select 足够） */
      let rows = [];
      try {
        await ensureSchema(sql);
        rows = await sql`select song_key, title, artist, seconds, source from song_durations limit 5000`;
      } catch (e) {
        return fail(res, 500, '读取时长库失败：' + (e && e.message ? e.message : e));
      }
      const byTitle = new Map();     /* 归一歌名 -> [库条目] */
      for (const r of (rows || [])) {
        const t = norm(r.title);
        if (!t) continue;
        if (!byTitle.has(t)) byTitle.set(t, []);
        byTitle.get(t).push(r);
      }
      const list = items.map((it) => {
        const title = String((it && it.title) || '').trim();
        const artist = String((it && it.artist) || '').trim();
        const bucket = byTitle.get(norm(title)) || [];
        let best = null;
        if (bucket.length) {
          /* 歌手匹配打分：完全一致 3 > 一方包含另一方 2 > 有交集 1 > 无交集 0 */
          let bestScore = -1;
          for (const b of bucket) {
            const score = artistScore(artist, b.artist);
            if (score > bestScore) { bestScore = score; best = b; }
          }
          /* 没写歌手、或库条目也没歌手 —— 只要歌名对上就算命中 */
          if (bestScore < 0) best = bucket[0];
        }
        return {
          title, artist,
          seconds: best ? Number(best.seconds) : null,
          source: best ? best.source : null,
          matchedTitle: best ? best.title : null,
          matchedArtist: best ? best.artist : null,
        };
      });
      return ok(res, { list, total: list.length, hit: list.filter((x) => x.seconds > 0).length });
    }

    /* ⑤ 删除一条（误录 / 查错了想重来）。需管理员：走 /api/admin 太重，
       这里用「必须带 lib 全量拉取过的 key」做弱校验，前端只给后台用。
       ⚠️ 站主单人使用场景，删除只影响时长库，不动任何业务数据。 */
    if (act === 'del') {
      if (!sql) return fail(res, 500, '数据库未配置');
      const items = rawItems.slice(0, 20);
      if (!items.length) return fail(res, 400, 'items 不能为空');
      let n = 0;
      for (const it of items) {
        const key = libKey(String(it && it.title || ''), String(it && it.artist || ''));
        if (!key) continue;
        try {
          const r = await sql`delete from song_durations where song_key = ${key} returning song_key`;
          if (r && r.length) n++;
          cache.delete(key);
        } catch (e) {}
      }
      return ok(res, { deleted: n, message: '已从时长库删除 ' + n + ' 条' });
    }

    /* ⑥ 批量写库（前端自己已有秒数，只想同步上云） */
    if (act === 'save-many') {
      if (!sql) return fail(res, 500, '数据库未配置');
      const items = rawItems.slice(0, 40);
      if (!items.length) return fail(res, 400, 'items 不能为空');
      try { await ensureSchema(sql); } catch (e) {}
      const saved = await libSave(sql, items);
      return ok(res, { saved: saved.length, list: saved });
    }

    return fail(res, 400, '未知动作：' + act);
  }

  return fail(res, 405, '仅支持 GET / POST');
}
