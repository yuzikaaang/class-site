/* ============================================================
   /api/music —— 歌曲时长补全（v3.5.20）
   ------------------------------------------------------------
   背景：VoiceHub 的 /api/open/songs 里 durationSeconds 全是 null
   （站主这个实例没填时长），于是「按时长抽歌」「总时长统计」都用不了。
   站主原话：「api 获取不了歌曲时长的吗？如果不能看看能不能线上搜索获取」。

   做法：服务端按「歌名 + 歌手」去音乐平台搜时长。
   ⚠️ 单源不可靠：实测 QQ 音乐在沙箱能通、但在 Cloudflare 出口被风控
      （返回 null），所以做成**多源回退**：
        ① 网易云（中文曲库最全，duration 毫秒）
        ② iTunes（Apple 对 Cloudflare 友好，trackTimeMillis）
        ③ QQ 音乐（带 Referer，interval 秒）
      任一源命中就返回；全挂返回 null（前端显示「—」，不阻塞）。

   接口：
     GET  /api/music?action=duration&title=幻听&artist=许嵩
     POST /api/music   { items:[{title,artist}, ...] }   // 最多 8 条
   ============================================================ */

import { cors, handlePreflight, ok, fail, body } from './_lib/http.js';

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
  let fallback = null;
  for (const s of songs) {
    const ms = Number(s.duration);
    if (!isFinite(ms)) continue;
    const sec = Math.round(ms / 1000);
    if (!valid(sec)) continue;
    const nameOk = norm(s.name) === norm(title);
    const singers = (s.artists || []).map((a) => a.name || '').join('/');
    const singerOk = !artist || norm(singers).includes(norm(artist))
      || norm(artist).includes(norm(singers.split('/')[0]));
    if (nameOk && singerOk) return sec;
    if (fallback == null && nameOk) fallback = sec;
  }
  if (fallback != null) return fallback;
  const first = songs[0] && Math.round(Number(songs[0].duration) / 1000);
  return (first && valid(first)) ? first : null;
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
    const singerOk = !artist || norm(s.artistName).includes(norm(artist));
    if (nameOk && singerOk) return sec;
    if (fallback == null && nameOk) fallback = sec;
  }
  if (fallback != null) return fallback;
  const first = list[0] && Math.round(Number(list[0].trackTimeMillis) / 1000);
  return (first && valid(first)) ? first : null;
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
    const singers = (s.singer || []).map((x) => x.name || '').join('/');
    const singerOk = !artist || norm(singers).includes(norm(artist));
    if (nameOk && singerOk) return sec;
    if (fallback == null && nameOk) fallback = sec;
  }
  if (fallback != null) return fallback;
  const first = list[0] && Number(list[0].interval);
  return (first && valid(first)) ? first : null;
}

async function queryOne(title, artist) {
  const t = String(title || '').trim().slice(0, 60);
  const a = String(artist || '').trim().slice(0, 40);
  if (!t) return null;
  const key = t + '|' + a;
  const hit = cache.get(key);
  if (hit) {
    const ttl = hit.short ? 3 * 60 * 1000 : TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.seconds;
  }

  /* v3.5.20：改成三源**并行**再取第一个有效值。
     实测单源串行时经常整条链路都慢（网易云超时 → iTunes 再等 → QQ 被风控），
     并行后总耗时 = 最慢的那个源，命中率也明显高（任一源有就能拿到）。 */
  const results = await Promise.all([
    fromNetease(t, a).catch(() => null),
    fromItunes(t, a).catch(() => null),
    fromQQ(t, a).catch(() => null),
  ]);
  const seconds = results.find((x) => x != null) || null;
  /* ⚠️ 只长缓存「成功」结果：null 只存 3 分钟，否则一次网络抖动会把这首歌锁死半小时 */
  cache.set(key, { at: Date.now(), seconds, short: seconds == null });
  return seconds;
}

export default async function musicHandler(req, res) {
  if (handlePreflight(req, res)) return;
  cors(req, res);

  const u = new URL(req.url, 'http://x');
  const action = u.searchParams.get('action') || '';

  if (req.method === 'GET') {
    if (action !== 'duration') return fail(res, 400, '未知动作：' + action);
    const seconds = await queryOne(u.searchParams.get('title'), u.searchParams.get('artist'));
    return ok(res, { seconds: seconds == null ? null : seconds });
  }

  if (req.method === 'POST') {
    /* ⚠️ 这个项目的 req 不是标准 Request，没有 req.json() —— 用公共的 body() */
    let payload = null;
    try { payload = await body(req); } catch (e) { payload = null; }
    const items = (payload && Array.isArray(payload.items)) ? payload.items.slice(0, 8) : [];
    if (!items.length) return fail(res, 400, 'items 不能为空（最多 8 条）');
    /* 8 条并发；每条最多 3 个子请求（三源都失败时），远低于 50 上限 */
    const list = await Promise.all(items.map(async (it) => {
      const title = String((it && it.title) || '').trim();
      const artist = String((it && it.artist) || '').trim();
      const seconds = await queryOne(title, artist);
      return { title, artist, seconds: seconds == null ? null : seconds };
    }));
    return ok(res, { list });
  }

  return fail(res, 405, '仅支持 GET / POST');
}
