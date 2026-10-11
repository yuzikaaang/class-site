/* ============================================================
   /api/study  —— 学习卡片联网内容代理（v2.6.0 新增）
   ------------------------------------------------------------
   GET /api/study?want=wp

   为什么需要这一层（而不是前端直连）：
     实测两个内容源的 CORS 情况——
       · v2.jinrishici.com（今日诗词）   → **无** Access-Control-Allow-Origin
       · dict.youdao.com/jsonapi（词典） → **无** Access-Control-Allow-Origin
     浏览器直连会被同源策略拦掉（Fetch 直接 reject），必须有服务端中转。
     （对比：v1.hitokoto.cn 和 api.dictionaryapi.dev 都返回 `*`，
      所以「每日一言」「每日一词」的英文释义其实可以前端直连；
      「每日一言」就是这么做的，见 index.html 的 fetchRemoteQuote。）

   设计要点：
     ① 只读接口，不需要登录 —— 内容是公开的古诗词和英文单词释义，
        不涉及任何班级隐私。登录反而会让「没登录的同学看不到学习卡片」。
     ② 上游超时 + 失败降级返回空字段，绝不抛 500：
        前端拿到空字段就继续用内置数据，卡片不会变空白。
     ③ 请求带浏览器 UA —— 上游对无 UA 的请求会拒绝（实测 403/418）。
     ④ 每天缓存：诗词和单词按「日期」缓存，避免同学频繁刷新时反复打上游。
        Workers 实例级内存缓存（不是持久化），实例重启就失效，够用了。
   ============================================================ */

import { cors, handlePreflight, ok, fail } from './_lib/http.js';

const UPSTREAM_TIMEOUT_MS = 6000;

/* 伪装成浏览器：上游对默认的 fetch UA 会拒（实测 youdao 返回 403、jinrishici 返回 418） */
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
};

/* ---------- 内置词库：每日一词从这里随机取一个去查释义 ----------
   为什么不用「随机英文字母」去查：那样会查到一堆无意义的组合
   （xyz、qqq），释义为空或者是一堆缩写。这里放的是高中英语高频词，
   查出来一定有像样的释义，也贴合学习场景。 */
const WORD_POOL = [
  'abandon', 'absorb', 'academic', 'accomplish', 'accurate', 'achieve', 'acknowledge', 'adapt',
  'adequate', 'adjust', 'admire', 'adopt', 'advocate', 'affect', 'aggressive', 'alternative',
  'ambiguous', 'ambitious', 'analyze', 'ancient', 'annual', 'anticipate', 'anxious', 'apparent',
  'appreciate', 'approach', 'appropriate', 'approve', 'arbitrary', 'assess', 'assume', 'attitude',
  'attribute', 'authentic', 'available', 'aware', 'beneficial', 'brilliant', 'capable', 'capacity',
  'challenge', 'characteristic', 'circumstance', 'commit', 'compensate', 'competent', 'complex',
  'comprehensive', 'concentrate', 'conclude', 'conduct', 'confine', 'confirm', 'conflict',
  'consequence', 'considerable', 'consistent', 'constitute', 'construct', 'consult', 'consume',
  'contemporary', 'contribute', 'controversial', 'convenient', 'conventional', 'convince',
  'cooperate', 'crucial', 'cultivate', 'curious', 'decline', 'dedicate', 'definite', 'delicate',
  'demonstrate', 'deny', 'depend', 'derive', 'desperate', 'detect', 'determine', 'device',
  'distinguish', 'distribute', 'diverse', 'domestic', 'dominant', 'dramatic', 'efficient',
  'elaborate', 'eliminate', 'emerge', 'emphasis', 'encounter', 'endure', 'enhance', 'enormous',
  'ensure', 'enthusiasm', 'equivalent', 'essential', 'establish', 'estimate', 'evaluate',
  'eventually', 'evident', 'evolve', 'exaggerate', 'exceed', 'exclude', 'exhibit', 'expand',
  'expense', 'explicit', 'exploit', 'expose', 'external', 'extract', 'facilitate', 'fascinate',
  'flexible', 'fluctuate', 'formulate', 'frequent', 'fundamental', 'generate', 'genuine',
  'gradual', 'guarantee', 'hostile', 'identify', 'ignore', 'illustrate', 'imply', 'impose',
  'impress', 'incident', 'indicate', 'inevitable', 'influence', 'initial', 'innovation',
  'insight', 'inspire', 'install', 'instance', 'institute', 'integrate', 'intense', 'interpret',
  'intervene', 'intrinsic', 'investigate', 'justify', 'legitimate', 'magnificent', 'maintain',
  'manipulate', 'margin', 'maximum', 'mechanism', 'minimum', 'modify', 'monitor', 'motivate',
  'negotiate', 'nevertheless', 'notion', 'numerous', 'objective', 'obtain', 'obvious', 'occupy',
  'occur', 'optimistic', 'outstanding', 'overcome', 'participate', 'particular', 'perceive',
  'persist', 'perspective', 'phenomenon', 'physical', 'potential', 'precise', 'predict',
  'prejudice', 'preserve', 'primary', 'principle', 'priority', 'profound', 'prohibit', 'prominent',
  'promote', 'proportion', 'propose', 'prospect', 'pursue', 'radical', 'random', 'rational',
  'recognize', 'recommend', 'reflect', 'reform', 'regard', 'regulate', 'reinforce', 'reject',
  'relevant', 'reluctant', 'remarkable', 'represent', 'resemble', 'reserve', 'resolve',
  'resource', 'respond', 'restrict', 'retain', 'reveal', 'reverse', 'rigorous', 'satisfy',
  'scarce', 'scheme', 'significant', 'similar', 'simultaneous', 'sophisticated', 'specific',
  'stable', 'stimulate', 'strategy', 'subsequent', 'substantial', 'sufficient', 'summarize',
  'superior', 'sustain', 'symbol', 'temporary', 'tendency', 'thorough', 'threaten', 'tolerate',
  'transfer', 'transform', 'transmit', 'tremendous', 'ultimate', 'undergo', 'undertake',
  'unique', 'utilize', 'valid', 'vanish', 'variable', 'version', 'vigorous', 'violate',
  'virtual', 'visible', 'vital', 'vulnerable', 'welfare', 'withdraw', 'yield',
];

/* ---------- 实例级缓存 ----------
   按「日期 + 键」缓存：同一天内所有请求复用同一个结果。
   这样即使全班同学一起刷新，上游也只被打一次。 */
const cache = new Map();

function todayKey() {
  /* 用 UTC 日期即可 —— 缓存只是省流量，不需要精确到北京时间 */
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

function cacheGet(k) {
  const v = cache.get(k);
  if (!v) return null;
  if (v.day !== todayKey()) { cache.delete(k); return null; }
  return v.data;
}

function cacheSet(k, data) {
  /* 上限保护：Map 无上限会在长期运行的实例里累积（虽然 Workers 实例不长寿） */
  if (cache.size > 64) cache.clear();
  cache.set(k, { day: todayKey(), data });
}

/** 带超时的 fetch，失败返回 null（不抛） */
async function fetchJson(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/* ---------- 每日一词：有道词典 ---------- */
/**
 * 取名一个单词，返回 { word, phonetic, meaning, example }
 * 失败返回 null。
 */
async function fetchWord() {
  const cached = cacheGet('word');
  if (cached) return cached;

  /* 用「日期」做种子选词，同一天全班看到同一个词（和「每日一词」的语义一致） */
  const d = new Date();
  const seed = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  const word = WORD_POOL[seed % WORD_POOL.length];

  const j = await fetchJson(
    'https://dict.youdao.com/jsonapi?q=' + encodeURIComponent(word),
    { ...BROWSER_HEADERS, 'Referer': 'https://dict.youdao.com/' }
  );
  if (!j) return null;

  /* 结构：{ ec: { word: [ { usphone, ukphone, trs: [ { tr: [ { l: { i: ["v. 抛弃…"] } } ] } ] } ] } }
     ⚠️ 上游字段可能缺失，逐层判空，任何一层没有就返回 null 让前端用兜底。 */
  const w = (j.ec && Array.isArray(j.ec.word) && j.ec.word[0]) || null;
  if (!w) return null;

  const phonetic = w.usphone ? ('/' + w.usphone + '/') : (w.ukphone ? ('/' + w.ukphone + '/') : '');
  const meanings = [];
  (w.trs || []).forEach((t) => {
    (t.tr || []).forEach((x) => {
      const arr = x && x.l && Array.isArray(x.l.i) ? x.l.i : [];
      arr.forEach((s) => { if (s) meanings.push(String(s)); });
    });
  });
  if (!meanings.length) return null;

  /* 例句：有道的 blng_sents / auth_sents 结构不稳定，这里不强求；
     从 oxford 或 simple 里找一个短例句，找不到就留空。 */
  let example = '';
  try {
    const sents = (j.blng_sents_part && j.blng_sents_part['sentence-pair']) || [];
    for (const s of sents) {
      const en = s['sentence'] || (s['sentence-eng']);
      const zh = s['sentence-translation'];
      if (en && String(en).length < 110) {
        example = String(en).trim() + (zh ? ('　' + String(zh).trim()) : '');
        break;
      }
    }
  } catch { /* 例句有没有都行 */ }

  const data = {
    word: String(w['return-phrase'] && w['return-phrase'].l && w['return-phrase'].l.i || word),
    phonetic,
    meaning: meanings.slice(0, 3).join('；'),
    example,
  };
  cacheSet('word', data);
  return data;
}

/* ---------- 古诗文：今日诗词 ---------- */
async function fetchPoem() {
  const cached = cacheGet('poem');
  if (cached) return cached;

  const j = await fetchJson('https://v2.jinrishici.com/one.json', {
    ...BROWSER_HEADERS,
    'Referer': 'https://www.jinrishici.com/',
  });
  if (!j || j.status !== 'success' || !j.data) return null;
  const d = j.data;
  if (!d.content) return null;

  const origin = d.origin || {};
  const parts = [];
  if (origin.dynasty) parts.push(origin.dynasty);
  if (origin.author) parts.push(origin.author);
  const from = parts.join(' · ') + (origin.title ? ('《' + origin.title + '》') : '');

  const data = {
    content: String(d.content),
    from: from || '古诗文',
    /* 全诗按行返回，前端目前不展示，但保留字段方便以后扩展 */
    full: origin.content ? String(origin.content) : '',
  };
  cacheSet('poem', data);
  return data;
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  cors(req, res);

  try {
    if (req.method !== 'GET') return fail(res, 405, '不支持的方法');

    /* want=w 要词、want=p 要诗，都不传就都返回。
       用两个并发请求 —— 串行的话最慢那次（约 1s）会拖住整体。 */
    const want = String(req.query.want || 'wp').toLowerCase();
    const needWord = want.includes('w');
    const needPoem = want.includes('p');

    const jobs = [];
    jobs.push(needWord ? fetchWord() : Promise.resolve(null));
    jobs.push(needPoem ? fetchPoem() : Promise.resolve(null));
    const [word, poem] = await Promise.all(jobs);

    /* 上游失败时字段留 null，前端照旧显示内置内容 —— 接口本身仍返回 ok:true，
       因为「这次没拿到联网内容」不是错误，前端不该走 catch 分支。 */
    return ok(res, {
      word: word || null,
      poem: poem || null,
      date: todayKey(),
    });
  } catch (e) {
    console.error('[study]', req.method, e);
    return fail(res, 500, '服务器内部错误，请稍后重试');
  }
}
