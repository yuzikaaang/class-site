/* ============================================================
   /api/music —— 歌曲时长补全（v3.5.20）
   ------------------------------------------------------------
   背景：VoiceHub 的 /api/open/songs 里 durationSeconds 全是 null
   （站主这个实例没填时长），于是「按时长抽歌」「总时长统计」都用不了。
   站主原话：「api 获取不了歌曲时长的吗？如果不能看看能不能线上搜索获取」。

   做法：服务端代查 QQ 音乐搜索接口，按「歌名 + 歌手」匹配取 interval（秒）。
   为什么走服务端：
     ① 浏览器直连 y.qq.com 会被 CORS 拦；
     ② 顺手做缓存，避免全班刷新时反复打上游。

   接口：
     GET  /api/music?action=duration&title=幻听&artist=许嵩
     POST /api/music   { items:[{title,artist}, ...] }   // 最多 8 条
   ============================================================ */

import { cors, handlePreflight, ok, fail } from './_lib/http.js';

const TTL_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 4500;
const cache = new Map();          /* "title|artist" -> { at, seconds } */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 归一化：去括号内容、空格、大小写，便于比对「幻听 (Live)」vs「幻听」 */
function norm(s) {
  return String(s == null ? '' : s)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s·・\-—_]/g, '')
    .toLowerCase();
}

async function queryOne(title, artist) {
  const t = String(title || '').trim().slice(0, 60);
  const a = String(artist || '').trim().slice(0, 40);
  if (!t) return null;
  const key = t + '|' + a;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.seconds;

  const q = [t, a].filter(Boolean).join(' ');
  const url = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp'
    + '?w=' + encodeURIComponent(q) + '&format=json&n=5&cr=1&new_json=1';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/' },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const list = (j && j.data && j.data.song && j.data.song.list) || [];
    let best = null;
    for (const s of list) {
      const sec = Number(s && s.interval);
      if (!(sec >= 20 && sec <= 1800)) continue;         /* 广告/纯音乐试听也挡掉离谱值 */
      const name = String(s.name || '');
      const singers = ((s.singer || []).map((x) => x.name || '')).join('/');
      const nameOk = norm(name) === norm(t);
      const singerOk = !a || norm(singers).includes(norm(a)) || norm(a).includes(norm(singers.split('/')[0]));
      if (nameOk && singerOk) { best = sec; break; }      /* 歌名+歌手都对上，最优 */
      if (best == null && nameOk) best = sec;             /* 歌名对上先记着 */
    }
    if (best == null && list.length) {
      const sec = Number(list[0].interval);
      if (sec >= 20 && sec <= 1800) best = sec;           /* 最后兜底：第一条 */
    }
    cache.set(key, { at: Date.now(), seconds: best });
    return best;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
    let body = null;
    try { body = await req.json(); } catch (e) { body = null; }
    const items = (body && Array.isArray(body.items)) ? body.items.slice(0, 8) : [];
    if (!items.length) return fail(res, 400, 'items 不能为空（最多 8 条）');
    /* 8 条并发 → 8 个子请求，远低于 Workers 的 50 上限 */
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
