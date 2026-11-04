/* admin-1.js · 后台脚本第 1/3 段：配置、工具、图标、UI 外壳与概览 / 用户 / 资料面板
   由 admin.js 按「顶层横幅」切开（v3.19.0）。
   ⚠️ 三段都是普通 <script>，共享同一个全局作用域；每段各自 'use strict'。
      顺序不能乱：admin-1 → admin-2 → admin-3（后面会调用前面定义的东西）。 */
'use strict';
/* ============================================================================
 * ① CONFIG 与工具
 * ========================================================================= */

/* 后端地址：与主站 index.html 保持一致。
   留空则走同域（本地开发时起个服务即可）。 */
var API_BASE = 'https://api.classsite.dpdns.org';

var LS_TOKEN = 'cls_admin_token';
var LS_USER  = 'cls_admin_user';
var LS_THEME = 'cls_admin_theme';
var LS_UI    = 'cls_admin_ui';

/* 站点版本号（2026-10-07）
   ⚠️ 必须与 index.html 里的 SITE_VERSION / VER_DATE 完全一致——
      两边对不上就说明有一边忘了更新，站主会据此误判「有没有推上线」。
      render_test.mjs 里有一条断言专门盯这件事。 */
/* ---- 运行时状态 ---- */
var STATE = {
  token: '',
  me: null,
  page: 'overview',
  /* 各面板的临时状态 */
  /* v2.10.0 #172：成员与档案合并页（原 users / profiles 两页合一） */
  members: { list: [], total: 0, counts: {}, page: 1, size: 50, q: '', role: '', status: '', scene: '', selected: {} },
  quoteSource: 1,   /* v3.5.9 每日一言来源：1=联网 API，0=本地库 */
  quoteSched: { mode:'random', start:'', every:3, fixed:{} },   /* v3.5.11 本地库排期 */
  logs:  { list: [], total: 0, page: 1, size: 30 },
  actionlogs: { list: [], total: 0, page: 1, size: 50, q: '', action: '', day: '', stats: null },
  logins:{ list: [], total: 0, page: 1, size: 30, userId: 0 },
  /* v3.5.35 在线时长：users 是按人聚合，sessions 是单人明细 */
  online:{ users: [], days: 30, grandSecs: 0, grandSessions: 0, activeUsers: 0, totalUsers: 0,
           detail: null, detailUser: null, page: 1, size: 50 },
  profiles: { list: [], total: 0, counts: {}, page: 1, size: 30, q: '', status: '' },
  reviews:  { list: [], history: [], total: 0, counts: {}, page: 1, size: 30 },
  viewlogs: { list: [], total: 0, page: 1, size: 30, top: [], q: '' },
  /* 班级内容：公告 + 内容合并成一个列表（2026-10-06） */
  classcontent: { list: [], cat: '全部', sort: 'new', q: '' },
  /* 2026-10-05 新增面板的状态 */
  titles: { list: [], allowed: [], aiAccount: null, q: '', onlySet: false, page: 1, size: 30 },
  homeworks: { list: [], notice: '', draft: null },
  song: { list: [], cards: [] },
  /* 2026-10-06 新增 */
  quotes: { list: [] },
  study: null,
  dates:  { list: [] },
  secrets: { list: [], encrypted: false, hasKey: false },
  /* 2026-10-07 新增：游戏数据（最高分 / 游玩时长 / 券获取时间） */
  games: { list: [], meta: [], summary: null, q: '', tab: 'play', week: '' },
  /* v3.9.25：全屏时钟使用记录（谁在什么时候用了多久） */
  clocklog: { day: '', q: '', users: [], summary: null, open: {} },
};
window.__ADMIN_STATE = STATE;   /* 调试用 */

/* ---- 小工具 ---- */
function $(id){ return document.getElementById(id); }
function esc(s){
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function attr(s){ return esc(s); }

/**
 * 把数据库返回的时间格式化成可读文本。
 *
 * ⚠️ 复制自主站的经验（2026-10-05 踩过的坑）：
 * Neon HTTP 驱动返回 timestamptz 是**字符串**（形如 "2026-10-05 05:52:28"），
 * 带空格的格式在 Safari / 微信 WebView 里 `new Date()` 会得到 Invalid Date。
 * 所以要手动换 T 补 Z 按 UTC 解析，再转本地时区显示。
 */
function parseTime(v){
  if(!v) return null;
  if(v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var s = String(v).trim();
  if(!s) return null;
  if(/^\d+$/.test(s)){ var n = Number(s); return new Date(n > 1e12 ? n : n*1000); }

  /* 🔴 v3.5.12 真根因（站主反馈「行为日志没有时间戳」）：
     线上 /admin?action=action-logs 返回的 createdAt 不是 "2026-10-17T15:01:09Z"，
     而是 **JS Date 的 toString 形态** —— "Sat Oct 17 2026 15:01:09 GMT+0000
     (Coordinated Universal Time)"（Neon 驱动把 timestamptz 直接当 Date 序列化）。
     老代码只做 `replace(' ','T')`（替换第一个空格）→ 得到
     "SatTOct 17 2026 ..."，Date.parse 必然 NaN → fmt() 返回 '—'，
     整列时间就永远是个破折号。
     修法：先认 ISO / 带时区偏移的数字格式；再退回 Date.parse 原生格式
     （它本来就吃得下 toString 形态）；最后才是补 Z 兜底。 */
  var iso = s.replace(' ', 'T');
  if(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)){
    if(!/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) iso += 'Z';
    var t1 = Date.parse(iso);
    if(!isNaN(t1)) return new Date(t1);
  }
  var t0 = Date.parse(s);
  if(!isNaN(t0)) return new Date(t0);
  var t2 = Date.parse(iso);
  return isNaN(t2) ? null : new Date(t2);
}
function fmt(v, mode){
  var d = parseTime(v);
  if(!d) return '—';
  var p = function(n){ return String(n).padStart(2,'0'); };
  var Y = d.getFullYear(), M = p(d.getMonth()+1), D = p(d.getDate());
  var h = p(d.getHours()), m = p(d.getMinutes()), sec = p(d.getSeconds());
  if(mode === 'date') return Y + '-' + M + '-' + D;
  if(mode === 'time') return h + ':' + m;
  return Y + '-' + M + '-' + D + ' ' + h + ':' + m + ':' + sec;
}

/**
 * 本地墙钟字符串原样格式化（**不碰时区**）。
 *
 * ⚠️ 2026-10-16 站主反馈修的坑：公告的发布时间、作业的起止日期是**站主手填 /
 *    设备本地写下的墙钟字符串**（如 "2026-10-16 21:30"），前端是直接
 *    `a.date.slice(5)` 原样显示的（见 index.html 公告栏）。
 *    而 fmt() 会给没有时区标记的串补 Z 按 UTC 解析 —— 于是站主填 21:30，
 *    后台小字显示成次日 05:30，正好多加 8 小时（前端不加，两边就对不上）。
 *    含 "~" 的区间（作业起止）以前还会因为整串解析失败直接显示「—」。
 *    所以内容类时间一律走这里：认得出就规范化，认不出就原样输出，绝不换算。
 */
function fmtWall(v, mode){
  var s = String(v == null ? '' : v).trim();
  if(!s) return '—';
  if(s.indexOf('~') >= 0){
    return s.split('~').map(function(x){ return fmtWall(x.trim(), mode); }).join(' ~ ');
  }
  var m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}))?/);
  if(!m) return s;
  var p = function(n){ return String(n).padStart(2,'0'); };
  var d0 = m[1] + '-' + p(m[2]) + '-' + p(m[3]);
  if(mode === 'date' || m[4] === undefined) return d0;
  return d0 + ' ' + p(m[4]) + ':' + p(m[5]);
}

/** 内容记录（公告 / 作业 / 其它内容）的时间展示。
 *  只有 timeKind === 'db' 才是数据库时间戳（UTC，要转本地）；
 *  其余都是站主手填的本地墙钟串，原样显示。 */
function fmtRecTime(c){
  if(!c || !c.time) return '—';
  return c.timeKind === 'db' ? fmt(c.time) : fmtWall(c.time);
}
/** 相对时间："3 分钟前" */
function ago(v){
  var d = parseTime(v);
  if(!d) return '—';
  var ms = Date.now() - d.getTime();
  if(ms < 0) return fmt(v);
  var s = Math.floor(ms/1000);
  if(s < 60) return '刚刚';
  var m = Math.floor(s/60);
  if(m < 60) return m + ' 分钟前';
  var h = Math.floor(m/60);
  if(h < 24) return h + ' 小时前';
  var dd = Math.floor(h/24);
  if(dd < 30) return dd + ' 天前';
  return fmt(v, 'date');
}
function bytes(n){
  n = Number(n) || 0;
  if(n < 1024) return n + ' B';
  if(n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
  return (n/1024/1024).toFixed(2) + ' MB';
}
/** 一次下载（导出用） */
function download(blob, filename){
  var a = document.createElement('a');
  var url = URL.createObjectURL(blob);
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(function(){ URL.revokeObjectURL(url); a.remove(); }, 200);
}
/** 防抖 */
function debounce(fn, ms){
  var t; return function(){ var a = arguments, c = this; clearTimeout(t); t = setTimeout(function(){ fn.apply(c, a); }, ms); };
}

/* ============================================================================
 * ② API 层
 * ========================================================================= */

function apiUrl(path){
  return (API_BASE || '') + '/api' + path;
}

/**
 * 统一请求封装。
 * - 自动带 Bearer token
 * - 401 自动清登录态并回到登录门
 * - 403 + mustChangePassword 自动弹强制改密
 */
function api(path, opts){
  opts = opts || {};
  var headers = { 'Content-Type':'application/json' };
  if(STATE.token) headers['Authorization'] = 'Bearer ' + STATE.token;

  var init = { method: opts.method || 'GET', headers: headers };
  if(opts.body !== undefined) init.body = JSON.stringify(opts.body);

  /* 【v3.15.3】请求超时闸门。
   * 站主原话：「信息分享这个后台一直转圈，转了四五分钟还是没有显示」。
   * 根因是那条老页面里的渲染函数直接抛错，视图永远停在加载态 —— 但另一类
   * 同样是「转圈不动」的坑是：fetch 一直挂着不返回（弱网 / 运营商劫持 /
   * 中间代理吞掉响应），Promise 既 then 也不 catch，界面就永远等下去。
   * 现在默认 25 秒还没回来就直接 reject 并给出人话提示，让每个页面的
   * .catch 都能正常收尾。opts.timeout 可单独指定。 */
  var ms = Number(opts.timeout || 25000);
  var ctrl = null, tid = null;
  try{
    if(typeof AbortController !== 'undefined'){
      ctrl = new AbortController();
      init.signal = ctrl.signal;
    }
  }catch(e){ ctrl = null; }

  var clear = function(){ if(tid){ clearTimeout(tid); tid = null; } };
  if(ctrl){
    tid = setTimeout(function(){
      try{ ctrl.abort(); }catch(e){}
    }, ms);
  }

  return fetch(apiUrl(path), init).then(function(r){
    return r.json().catch(function(){
      return { ok:false, error:'接口返回了非 JSON 内容（HTTP ' + r.status + '）' };
    }).then(function(j){
      if(r.status === 401){
        doLogout(true);
        throw new Error(j.error || '登录已过期，请重新登录');
      }
      /* 未改初始密码 → 后端拦截，这里把强制改密弹窗拉起来 */
      if(r.status === 403 && j.mustChangePassword){
        openForceChangePwd();
        throw new Error(j.error || '请先修改初始密码');
      }
      if(!r.ok || j.ok === false){
        var e = new Error(j.error || ('请求失败（HTTP ' + r.status + '）'));
        e.status = r.status; e.data = j;
        throw e;
      }
      return j;
    });
  }).then(function(v){ clear(); return v; }, function(e){
    clear();
    /* 被上面那个定时器 abort 掉的 → 换成看得懂的提示 */
    if(e && (e.name === 'AbortError' || e.code === 20)){
      var te = new Error('请求超时：' + Math.round(ms / 1000) + ' 秒没有响应，请检查网络后重试');
      te.timeout = true;
      throw te;
    }
    if(e && e.name === 'TypeError' && /fetch|network|load failed/i.test(String(e.message || ''))){
      /* fetch 层直接失败（断网 / DNS / TLS），一并说人话 */
      var ne = new Error('连不上服务器，请检查网络后重试');
      ne.network = true;
      throw ne;
    }
    throw e;
  });
}

/* ============================================================
 * 【v2.9.10】全站共用自适应字色（与 index.html 逐行同构）
 * ------------------------------------------------------------
 * 站主原话：「全站字色共用一套逻辑……字体颜色需根据背景颜色实时改变，
 * 都用对应的相反色，尤其是一些公告什么经常切换白天黑夜的时候
 * 只有一部分看得清，主页面和后台页面都有这种情况」。
 *
 * 规则（以后新写的带背景文字块都按这个来）：
 *   ① 凡是「文字压在背景上」的渲染，一律经过 clsReadableOn(背景色)
 *      取相反色 —— 亮底用深字、暗底用白字，不写死；
 *   ② 主题（白天/黑夜）切换后，clsAutoInk(document.body) 全局重算；
 *   ③ 新增渲染点只要给容器加 class="ink-auto"（动态背景色用
 *      data-ink-bg 声明代表色，如渐变的起始色），无需再操心字色。
 * 与 index.html 保持同一套实现：同函数名、同择优逻辑、同色值，
 * 改一处必须同步改另一处（render_test.mjs 有断言盯同构）。
 *
 * 【v2.9.11】判定升级：WCAG 相对亮度 + 对比度择优（不再用感知亮度猜）
 * ------------------------------------------------------------
 * 站主原话：「还有登录时的弹窗等等，都是字色不达标的后台也有这种情况」。
 * v2.9.10 用 YIQ 感知亮度阈值 0.6 猜相反色，中间色会误判 ——
 * 如 #f97316（亮橙）被判「暗底取白字」，实测白字对比度仅 2.80:1，
 * 够不上 WCAG 正文 4.5:1，而深字 #241f1c 有 5.82:1。
 * 现在白字、深字各算一遍 WCAG 对比度，谁大用谁，中间色不再靠猜。
 * ============================================================ */
var CLS_INK_DARK = '#241f1c';   /* 亮底上的字（暖调近黑，不用纯黑） */
var CLS_INK_LIGHT = '#ffffff';  /* 暗底上的字 */
var CLS_INK_RGB_DARK = clsParseColor(CLS_INK_DARK);   /* [36,31,28]，择优用 */
var CLS_INK_RGB_LIGHT = clsParseColor(CLS_INK_LIGHT); /* [255,255,255]，择优用 */

/* 解析颜色串 → [r,g,b]；支持 #rgb / #rrggbb / rgb() / rgba()。
   透明或解析失败返回 null（调用方按「不处理」跳过）。 */
function clsParseColor(c){
  var s = String(c || '').trim().toLowerCase();
  var m;
  if((m = /^#([0-9a-f]{3})$/.exec(s))){
    return [parseInt(m[1][0]+m[1][0],16), parseInt(m[1][1]+m[1][1],16), parseInt(m[1][2]+m[1][2],16)];
  }
  if((m = /^#([0-9a-f]{6})$/.exec(s))){
    return [parseInt(m[1].slice(0,2),16), parseInt(m[1].slice(2,4),16), parseInt(m[1].slice(4,6),16)];
  }
  if((m = /^rgba?\(([^)]+)\)$/.exec(s))){
    var p = m[1].split(',').map(function(x){ return parseFloat(x); });
    if(p.length >= 3 && p.every(function(x){ return isFinite(x); })){
      if(p.length > 3 && p[3] === 0) return null;   /* 全透明 */
      return [p[0], p[1], p[2]];
    }
  }
  return null;
}
/* WCAG 2.x 相对亮度 0–1（sRGB gamma 展开后加权）。
   注意与「感知亮度」(0.299R+0.587G+0.114B)/255 的区别：那玩意儿
   在中间色上会和真实对比度打架（#f97316 就是受害者），择优只认这个。 */
function clsRelLum(rgb){
  function ch(v){
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return 0.2126 * ch(rgb[0]) + 0.7152 * ch(rgb[1]) + 0.0722 * ch(rgb[2]);
}
/* WCAG 对比度 1–21 */
function clsContrast(a, b){
  var la = clsRelLum(a), lb = clsRelLum(b);
  var hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}
/* 核心：给定背景色，返回可读的相反色。
   v2.9.11 起不猜了直接算 —— 白字与深字各算一遍 WCAG 对比度，取大者。
   实测：#f97316 白 2.80 / 深 5.82 → 深字；#0f766e 白 5.47 / 深 2.98 → 白字；
   #e07a3c 白 2.99 / 深 5.45 → 深字；#c2410c 白 5.18 / 深 3.15 → 白字。
   与 index.html 逐行同构。 */
function clsReadableOn(bg){
  var c = clsParseColor(bg);
  if(!c) return '';
  return clsContrast(CLS_INK_RGB_LIGHT, c) >= clsContrast(CLS_INK_RGB_DARK, c)
    ? CLS_INK_LIGHT : CLS_INK_DARK;
}
/* 扫描 root 内所有 .ink-auto，按实际背景重设字色。
   data-ink-bg 优先（渐变/图片背景没有单一 computed 色时用）；
   否则读 computed backgroundColor（transparent 则跳过——
   让继承色说话，不硬套）；
   backgroundColor 读不到有效色时，从 background-image 渐变里抓
   第一个色当代表色（渐变色取自 CSS 变量，换主题会实时变）。 */
function clsAutoInk(root){
  root = root || document.body;
  if(!root || !root.querySelectorAll) return;
  var els = root.querySelectorAll('.ink-auto');
  for(var i = 0; i < els.length; i++){
    var el = els[i];
    var bg = el.getAttribute('data-ink-bg');
    if(!bg){
      try{
        var cs = getComputedStyle(el);
        bg = cs.backgroundColor;
        if(!clsParseColor(bg)){
          var m = /rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/.exec(cs.backgroundImage || '');
          if(m) bg = m[0];
        }
      }catch(e){ bg = ''; }
    }
    var ink = clsReadableOn(bg);
    if(ink) el.style.color = ink;
  }
}

/* v2.9.10：DOM 变化后自动补扫 .ink-auto —— 面板/表格动态渲染出来的
   字色也实时正确，不用每个渲染函数后面手动跟一次（debounce 100ms，
   只查 .ink-auto，且只观察 childList：写 style 不会反触发，无死循环风险）。
   与 index.html 同款同构。 */
if(typeof MutationObserver === 'function'){
  var __inkTimer = null;
  try{
    new MutationObserver(function(){
      if(__inkTimer) return;
      __inkTimer = setTimeout(function(){
        __inkTimer = null;
        try{ clsAutoInk(document.body); }catch(e){}
      }, 100);
    }).observe(document.body, { childList:true, subtree:true });
  }catch(e){}
}

/* ============================================================
 * 【v2.9.9】客户端密码派生（与 index.html 同款同构）
 * ------------------------------------------------------------
 * 后台同样改走「浏览器本地 PBKDF2 → 服务端零派生」：
 *   ① POST /auth?action=salt {username} → {algo, iterations, salt}
 *   ② crypto.subtle 本地派生 → credential
 *   ③ login 带 credential；change-password 带 {oldCredential, newHash}
 * 任一步走不通自动回退明文路径，行为与 v2.9.9 之前一致。
 * 由来详见 index.html 同名注释块（第五十六轮·根因修复）。
 * ============================================================ */
var CLS_KDF_ITER = 50000;

function clsHasSubtle(){
  return !!(window.crypto && window.crypto.subtle && window.crypto.subtle.deriveKey
           && window.crypto.subtle.digest && window.TextEncoder);
}
function clsB64urlEncode(bytes){
  var s = '', i;
  for(i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function clsB64urlDecode(str){
  var s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  while(s.length % 4) s += '=';
  var bin = atob(s), out = new Uint8Array(bin.length);
  for(var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function clsDerive(password, saltB64, iterations){
  if(!clsHasSubtle()) return Promise.reject(new Error('NO_SUBTLE'));
  return crypto.subtle.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits'])
    .then(function(base){
      return crypto.subtle.deriveBits(
        { name:'PBKDF2', salt: clsB64urlDecode(saltB64), iterations: iterations, hash:'SHA-256' },
        base, 256
      );
    })
    .then(function(bits){ return clsB64urlEncode(new Uint8Array(bits)); });
}
function clsNewHash(password, iterations){
  var salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  var saltB64 = clsB64urlEncode(salt);
  return clsDerive(password, saltB64, iterations).then(function(dk){
    return crypto.subtle.digest('SHA-256', clsB64urlDecode(dk)).then(function(d){
      return 'pbkdf2c$' + iterations + '$' + saltB64 + '$' + clsB64urlEncode(new Uint8Array(d));
    });
  });
}
var CLS_SALT_CACHE = {};
function clsSalt(username){
  var key = String(username || '').toLowerCase();
  if(CLS_SALT_CACHE[key]) return Promise.resolve(CLS_SALT_CACHE[key]);
  return api('/auth?action=salt', { method:'POST', body:{ username: username } }).then(function(j){
    var p = { algo: j.algo === 'pbkdf2' ? 'pbkdf2' : 'bcrypt', iterations: j.iterations || 0, salt: j.salt || '' };
    CLS_SALT_CACHE[key] = p;
    return p;
  });
}
function clsSaltForget(username){ delete CLS_SALT_CACHE[String(username || '').toLowerCase()]; }
var CLS_FALLBACK = { fallback: true };
function clsKdfFallback(e){
  if(e && (e.message === 'NO_SUBTLE' || e.status === 429 || e.status >= 500)) return true;
  return false;
}
function clsLogin(u, p){
  if(!u) return api('/auth?action=login', { method:'POST', body:{ username:u, password:p } });
  return clsSalt(u).then(function(sp){
    if(sp.algo !== 'pbkdf2' || !sp.salt || !sp.iterations) return CLS_FALLBACK;
    return clsDerive(p, sp.salt, sp.iterations).then(function(cred){
      return api('/auth?action=login', { method:'POST', body:{ username:u, credential:cred } });
    });
  }).catch(function(e){
    if(clsKdfFallback(e)) return CLS_FALLBACK;
    throw e;
  }).then(function(r){
    if(r === CLS_FALLBACK) return api('/auth?action=login', { method:'POST', body:{ username:u, password:p } });
    return r;
  });
}
function clsChangePwd(oldPwd, newPwd, username){
  if(!username) return api('/auth?action=change-password',
    { method:'POST', body:{ oldPassword: oldPwd, newPassword: newPwd } });
  return clsSalt(username).then(function(sp){
    if(sp.algo !== 'pbkdf2' || !sp.salt || !sp.iterations) return CLS_FALLBACK;
    return clsDerive(oldPwd, sp.salt, sp.iterations).then(function(oldCred){
      return clsNewHash(newPwd, CLS_KDF_ITER).then(function(newHash){
        return api('/auth?action=change-password',
          { method:'POST', body:{ oldCredential: oldCred, newHash: newHash } });
      });
    });
  }).catch(function(e){
    if(clsKdfFallback(e)) return CLS_FALLBACK;
    throw e;
  }).then(function(r){
    if(username) clsSaltForget(username);
    if(r === CLS_FALLBACK) return api('/auth?action=change-password',
      { method:'POST', body:{ oldPassword: oldPwd, newPassword: newPwd } });
    return r;
  });
}

/* ============================================================================
 * ③ 图标库（内联 SVG，不依赖外部 CDN）
 * ========================================================================= */
var ICON = {
  dashboard:'<path d="M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z"/>',
  users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  megaphone:'<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  layers:'<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 17 9 5 9-5"/><path d="m3 12 9 5 9-5"/>',
  activity:'<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  lock:'<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  search:'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  upload:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  download:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  trash:'<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
  key:'<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 8.3-8.3"/><path d="m17 4 3 3"/><path d="m14 7 3 3"/>',
  x:'<path d="M18 6 6 18M6 6l12 12"/>',
  check:'<path d="M20 6 9 17l-5-5"/>',
  edit:'<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  eye:'<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  inbox:'<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  shield:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  clock:'<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  refresh:'<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>',
  ban:'<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  music:'<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  ticket:'<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/>',
  calendar:'<path d="M8 2v3"/><path d="M16 2v3"/><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/>',
  quote:'<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h1a1 1 0 0 1 1 1v1a2 2 0 0 1-2 2h-1a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h1a6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h1a1 1 0 0 1 1 1v1a2 2 0 0 1-2 2H4a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h1a6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>',
  grip:'<circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>',
  user:'<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  globe:'<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z"/>',
  file:'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v6h6"/>',
  alert:'<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>',
  chart:'<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>',
  database:'<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>',
  bell:'<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  /* v3.5.12 行为日志分组折叠箭头 */
  chevronRight:'<path d="m9 6 6 6-6 6"/>',
  chevronDown:'<path d="m6 9 6 6 6-6"/>'
};
function svg(name, size){
  var p = ICON[name] || ICON.file;
  var s = size || 18;
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
       + 'stroke-linecap="round" stroke-linejoin="round" width="' + s + '" height="' + s + '">' + p + '</svg>';
}

/* -----------------------------------------------------
   v2.5.0 去 emoji：后台与主站同一套做法 —— 页面加载后跑**一次**把写死的 emoji 换成 SVG。
   只跑一次、**不监听 DOM 变化**，跑完即止，不会和任何定时刷新打架。
   后台没有主站那套 85 个 emoji 的映射表，这里用一张精简表（覆盖后台实际用到的）。
   ----------------------------------------------------- */
var ADM_EMOJI_MAP = {
  '⚠':'alert','✅':'check','❌':'x','💡':'sun','🔒':'lock','🔐':'lock','📌':'file','🎉':'activity',
  '📝':'edit','🔔':'bell','🌙':'sun','☀':'sun','📋':'layers','📅':'calendar','📱':'file','🔗':'globe',
  '🌐':'globe','💾':'download','🗑':'trash','🏫':'globe','🚫':'ban','✨':'activity','🎮':'activity',
  '📥':'download','📤':'upload','🔍':'search','📡':'activity','💭':'quote','👤':'user','➕':'plus',
  '🗂':'layers','🕹':'activity','🧩':'layers','🎯':'activity','🐍':'activity','🔨':'settings',
  '🐦':'activity','🍬':'activity','💣':'alert','🦘':'activity','⚫':'ban','⭕':'ban','♟':'file',
  '✈':'upload','🖥':'dashboard','🍎':'file','⚙':'settings','☰':'grip','🏠':'dashboard','📊':'chart',
  '📦':'layers','🎁':'activity','🎵':'music','🎟':'ticket','🎼':'music','📜':'file','💬':'quote',
  '👥':'users','🥇':'activity','🥈':'activity','🥉':'activity','✏':'edit','🗓':'calendar',
  '👍':'activity','🔥':'activity','🖼':'file','🎧':'music','🎬':'file','📎':'file','⏳':'clock',
  '⚡':'activity','🔤':'file','📖':'file','📐':'file','⚛':'file','🧪':'file','🧬':'file','☁':'globe',
  '📢':'megaphone','📲':'file','👁':'eye','🔓':'lock','🧹':'trash','🔄':'refresh','📇':'user','🏆':'activity'
};
var ADM_EMOJI_CHARS = Object.keys(ADM_EMOJI_MAP).sort(function(a,b){ return b.length-a.length; });
var ADM_EMOJI_RE = new RegExp('(' + ADM_EMOJI_CHARS.map(function(c){
  return c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
}).join('|') + ')\\uFE0F?', 'g');
function admEmojiSvg(text, size){
  var t = String(text == null ? '' : text);
  if(!t) return t;
  ADM_EMOJI_RE.lastIndex = 0;
  if(!ADM_EMOJI_RE.test(t)) return t;
  ADM_EMOJI_RE.lastIndex = 0;
  var out = '', last = 0, m;
  while((m = ADM_EMOJI_RE.exec(t))){
    if(m.index > last) out += t.slice(last, m.index);
    var key = m[0].replace(/\uFE0F/g,'');
    out += svg(ADM_EMOJI_MAP[key] || ADM_EMOJI_MAP[m[0]] || 'file', size || 15);
    last = m.index + m[0].length;
    if(m[0].length === 0) ADM_EMOJI_RE.lastIndex++;
  }
  if(last < t.length) out += t.slice(last);
  return out;
}
/* 去掉纯文本里的 emoji（toast / option 这类放不了 SVG 的位置）。 */
function admStripEmoji(text){
  var t = String(text == null ? '' : text);
  ADM_EMOJI_RE.lastIndex = 0;
  return t.replace(ADM_EMOJI_RE, '').replace(/^\s+/, '');
}
var ADM_ICONIFY_SKIP = {SCRIPT:1, STYLE:1, TEXTAREA:1, OPTION:1, TITLE:1};
function admIconify(root){
  var base = root || document.body;
  if(!base) return;
  var walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT, {
    acceptNode: function(node){
      var p = node.parentNode;
      if(!p || ADM_ICONIFY_SKIP[p.nodeName]) return NodeFilter.FILTER_REJECT;
      if(p.closest && p.closest('[data-no-icon]')) return NodeFilter.FILTER_REJECT;
      ADM_EMOJI_RE.lastIndex = 0;
      return ADM_EMOJI_RE.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  var targets = [], n;
  while((n = walker.nextNode())) targets.push(n);
  for(var i = 0; i < targets.length; i++){
    var node = targets[i];
    var span = document.createElement('span');
    span.className = 'ico-inline';
    span.innerHTML = admEmojiSvg(node.nodeValue, 15);
    if(node.parentNode) node.parentNode.replaceChild(span, node);
  }
}
/* option 放不了 SVG，统一去 emoji 保留文字 */
function admStripOptions(root){
  var base = root || document;
  var opts = base.querySelectorAll ? base.querySelectorAll('option') : [];
  for(var i = 0; i < opts.length; i++) opts[i].textContent = admStripEmoji(opts[i].textContent);
}

/* ============================================================================
 * ④ 通用 UI
 * ========================================================================= */
function toast(msg, kind, ms){
  var box = $('toasts');
  if(!box) return;
  var el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  /* v2.5.0：toast 是纯文本，放不了 SVG，统一去 emoji 只留文字 */
  el.textContent = typeof admStripEmoji === 'function' ? admStripEmoji(msg || '') : msg;
  box.appendChild(el);
  setTimeout(function(){
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(function(){ el.remove(); }, 260);
  }, ms || 2600);
}

/**
 * 打开弹窗。
 * @param {object} o { title, sub, body(html), foot(html), wide, onMount(box), locked(不可关闭) }
 */
function openModal(o){
  o = o || {};
  var m = $('modal'), box = $('modalBox');
  var cls = 'modal-box' + (o.wide ? ' wide' : '');
  box.className = cls;
  box.innerHTML =
    '<div class="modal-head">'
    +   '<div><h3>' + esc(o.title || '') + '</h3>'
    +   (o.sub ? '<p class="sub">' + esc(o.sub) + '</p>' : '')
    +   '</div>'
    +   (o.locked ? '' : '<button class="close-x" data-close>' + svg('x') + '</button>')
    + '</div>'
    + '<div class="modal-body" id="modalBody">' + (o.body || '') + '</div>'
    + (o.foot ? '<div class="modal-foot">' + o.foot + '</div>' : '');

  m.className = 'modal show' + (o.locked ? ' locked' : '');
  /* 点遮罩关闭（locked 除外） */
  m.onclick = function(e){ if(e.target === m && !o.locked) closeModal(); };
  var x = box.querySelector('[data-close]');
  if(x) x.onclick = closeModal;
  if(typeof o.onMount === 'function') o.onMount(box);
  return box;
}
function closeModal(){
  var m = $('modal');
  m.className = 'modal';
  $('modalBox').innerHTML = '';
}

/**
 * 确认框（Promise 化）
 * @param {object} o
 *   html  主文案（允许 HTML，调用方自己保证安全）
 *   text  主文案（纯文本，会被转义）—— 与 html 二选一
 *   detail 补充说明（纯文本，小字显示在主文案下面）
 *   warn  危险提示（红框）
 * @returns {Promise<boolean>}
 */
function confirmBox(o){
  o = o || {};
  return new Promise(function(resolve){
    var done = function(v){ closeModal(); resolve(v); };
    openModal({
      title: o.title || '确认操作',
      body: '<p style="margin:0;font-size:.9rem;line-height:1.7">' + (o.html || esc(o.text || '确定要继续吗？')) + '</p>'
            + (o.detail ? '<p style="margin:10px 0 0;font-size:.82rem;line-height:1.7;color:var(--fg-3)">' + esc(o.detail) + '</p>' : '')
            + (o.warn ? '<div class="alert danger" style="margin:16px 0 0">' + esc(o.warn) + '</div>' : ''),
      foot: '<button class="btn btn-ghost" data-no>取消</button>'
            + '<button class="btn ' + (o.danger ? 'btn-danger' : '') + '" data-yes>' + esc(o.okText || '确定') + '</button>',
      onMount: function(box){
        box.querySelector('[data-yes]').onclick = function(){ done(true); };
        box.querySelector('[data-no]').onclick  = function(){ done(false); };
      }
    });
  });
}

/** 输入框对话框（Promise 化，返回输入值或 null） */
function promptBox(o){
  o = o || {};
  return new Promise(function(resolve){
    var done = function(v){ closeModal(); resolve(v); };
    openModal({
      title: o.title || '输入',
      sub: o.sub || '',
      body:
        '<div class="field"><label for="pmVal">' + esc(o.label || '内容') + '</label>'
        + '<input id="pmVal" type="' + (o.type || 'text') + '" value="' + attr(o.value || '') + '" '
        + 'placeholder="' + attr(o.placeholder || '') + '" '
        + (o.maxlength ? 'maxlength="' + o.maxlength + '"' : '') + '>'
        + (o.hint ? '<p class="hint">' + esc(o.hint) + '</p>' : '')
        + '</div>'
        + '<div class="msg" id="pmMsg"></div>',
      foot: '<button class="btn btn-ghost" data-no>取消</button><button class="btn" data-yes>' + esc(o.okText || '确定') + '</button>',
      onMount: function(box){
        var input = box.querySelector('#pmVal');
        var msg = box.querySelector('#pmMsg');
        setTimeout(function(){ input.focus(); input.select(); }, 80);
        var submit = function(){
          var v = input.value.trim();
          if(o.required && !v){
            msg.className = 'msg err show'; msg.textContent = '不能为空';
            return;
          }
          if(o.validate){
            var err = o.validate(v);
            if(err){ msg.className = 'msg err show'; msg.textContent = err; return; }
          }
          done(v);
        };
        box.querySelector('[data-yes]').onclick = submit;
        box.querySelector('[data-no]').onclick  = function(){ done(null); };
        input.onkeydown = function(e){ if(e.key === 'Enter'){ e.preventDefault(); submit(); } };
      }
    });
  });
}

/* ============================================================================
 * ⑤ 导航配置
 * ========================================================================= */
var PAGES = [
  { id:'overview',      label:'数据概览', icon:'dashboard', group:'概览',  title:'数据概览' },
  { id:'members',       label:'成员与档案', icon:'users',   group:'用户',  title:'成员与档案（账号 + 班级档案）' },
  { id:'titles',        label:'头衔任命', icon:'shield',    group:'用户',  title:'头衔任命' },
  { id:'reviews',       label:'信息审核', icon:'check', group:'用户',  title:'信息审核（资料修改审批）' },
  { id:'viewlogs',      label:'查看记录', icon:'eye',       group:'用户',  title:'资料查看记录' },
  { id:'classcontent',  label:'班级内容', icon:'layers',    group:'内容',  title:'班级内容（公告 / 作业 / 活动）' },
  /* v3.8.4（站主）：板块改名 / 简介 / 排序 / 隐藏 + 板块分享链接 */
  { id:'boards',        label:'板块管理', icon:'layers',    group:'内容',  title:'板块管理（名称 / 简介 / 排序 / 分享链接）' },
  /* v3.8.7（站主）：首页班级岛 + 课程表 */
  { id:'island',        label:'班级岛',   icon:'clock',     group:'内容',  title:'班级岛（今日事项横幅）' },
  { id:'homeworks',     label:'作业管理', icon:'file',      group:'内容',  title:'作业管理' },
  { id:'song',          label:'点歌管理', icon:'activity',  group:'内容',  title:'点歌管理' },
  { id:'dj',            label:'抽歌排期', icon:'music',     group:'内容',  title:'抽歌排期（抽签 / 歌单排除 / 历史公示）' },
  { id:'scores',        label:'成绩分析', icon:'activity',  group:'内容',  title:'成绩分析（考试 / 导入 / 改分 / 发布）' },
  { id:'votes',         label:'投票管理', icon:'check',     group:'内容',  title:'投票管理（发起投票 / 截止时间 / 结果）' },
  /* v3.15.0（站主）：个人信息分享 —— 发链接给同学，登录后直接查资料 */
  { id:'ishare',        label:'信息分享', icon:'users',     group:'内容',  title:'个人信息分享（登录后查询 · 链接 / 二维码 / 开放范围）' },

  { id:'popups',        label:'通用弹窗', icon:'bell',      group:'内容',  title:'通用弹窗（开屏弹 / 板块弹）' },
  { id:'cards',         label:'首页卡片', icon:'layers',    group:'内容',  title:'首页卡片（每日一言 / 学习卡片）' },
  { id:'dates',         label:'重要日期', icon:'calendar',  group:'内容',  title:'重要日期 / 考试范围' },
  { id:'games',         label:'游戏数据', icon:'activity',  group:'内容',  title:'游戏数据（最高分 / 游玩时长 / 点歌券）' },
  { id:'logins',        label:'登录记录', icon:'activity',  group:'安全',  title:'登录记录' },
  { id:'online',        label:'在线时长', icon:'clock',     group:'安全',  title:'在线时长（单次 / 累计）' },
  /* v3.9.25（站主）：全屏时钟的自习 / 计时记录 */
  { id:'clocklog',      label:'时钟记录', icon:'clock',     group:'安全',  title:'时钟记录（谁在什么时候用了多久）' },
  /* v3.6.1（站主 #4）：云端数据备份 / 回档 */
  { id:'backup',        label:'数据管理', icon:'database',  group:'安全',  title:'数据管理（备份 / 回档）' },
  { id:'logs',          label:'操作日志', icon:'file',      group:'安全',  title:'操作日志' },
  { id:'actionlogs',    label:'行为日志', icon:'activity',  group:'安全',  title:'用户操作日志（点击行为）' },
  { id:'secrets',       label:'令牌管理', icon:'key',       group:'系统',  title:'系统令牌' },
  { id:'settings',      label:'系统设置', icon:'settings',  group:'系统',  title:'系统设置' },
  { id:'account',       label:'我的账户', icon:'lock',      group:'系统',  title:'我的账户' }
];

function renderNav(){
  var groups = [];
  PAGES.forEach(function(p){
    var g = groups.find(function(x){ return x.name === p.group; });
    if(!g){ g = { name:p.group, items:[] }; groups.push(g); }
    g.items.push(p);
  });
  var html = groups.map(function(g){
    return '<div class="nav-group"><h3>' + esc(g.name) + '</h3>'
      + g.items.map(function(p){
          return '<button class="nav-item' + (STATE.page === p.id ? ' on' : '') + '" data-page="' + p.id + '">'
            + '<span class="ico">' + svg(p.icon, 17) + '</span>'
            + '<span>' + esc(p.label) + '</span>'
            + (STATE.page === p.id ? '<i class="dot"></i>' : '')
            + '</button>';
        }).join('')
      + '</div>';
  }).join('');
  $('nav').innerHTML = html;
  Array.prototype.forEach.call($('nav').querySelectorAll('[data-page]'), function(b){
    b.onclick = function(){ go(b.dataset.page); closeSide(); };
  });
}

/* ===== v3.5.13（站主 #4）：未保存内容拦截 =====
   站主给的参照是 VoiceHub 的「您有未保存的排期修改，确定要离开吗？」。
   后台最怕丢的是成绩录入面板的未保存行（SC_STATE.dirty），
   其他面板多为即时保存，暂无脏状态。 */
function unsavedCount(){
  try{
    var n = 0;
    if(typeof SC_STATE !== 'undefined' && SC_STATE && SC_STATE.dirty){
      for(var k in SC_STATE.dirty) if(SC_STATE.dirty[k]) n++;
    }
    return n;
  }catch(e){ return 0; }
}
/* 离开当前页有未保存内容吗？有则弹确认，返回 true = 允许离开 */
function confirmLeaveUnsaved(){
  var n = unsavedCount();
  if(!n) return true;
  /* confirmBox 是 Promise 风格，但 go() 是同步流 —— 这里用同步 confirm 保住流程简单；
     站主要求的就是「问一下」，不用做撤销。 */
  return window.confirm('您有 ' + n + ' 行成绩修改还没保存，确定要离开吗？\n（离开后这些修改会丢失）');
}
/* 关页面/刷新也拦一道（浏览器原生对话框） */
window.addEventListener('beforeunload', function(e){
  if(unsavedCount() > 0){ e.preventDefault(); e.returnValue = ''; return ''; }
});

function go(page){
  /* v3.5.13：切面板前先问 —— 同一成绩面板内重进也拦（避免自己冲掉自己） */
  if(STATE.page && page !== STATE.page && !confirmLeaveUnsaved()) return;
  STATE.page = page;
  var p = PAGES.find(function(x){ return x.id === page; });
  $('pageTitle').textContent = p ? p.title : '';
  /* v3.15.3：标题单行省略，完整文案挂在 title 上，长按 / 悬停能看全 */
  try{ $('pageTitle').title = p ? p.title : ''; }catch(e){}
  renderNav();
  var view = $('view');
  view.innerHTML = '<div class="loading"><div class="spinner"></div>加载中…</div>';
  /* v3.15.3：留一份「这个圈」的句柄 —— 页面要是真的画出来了，这个节点会被换掉；
     还挂在文档里就说明它一直没走，交给下面的看门狗收尸。 */
  var loadingNode = view.firstChild;
  view.style.animation = 'none';
  void view.offsetWidth;
  view.style.animation = 'rise-in .45s cubic-bezier(.16,1,.3,1) both';

  var fn = ({
    overview:      renderOverview,
    members:       renderMembers,
    titles:        renderTitles,
    reviews:       renderReviews,
    viewlogs:      renderViewLogs,
    classcontent:  renderClassContent,
    boards:        renderBoards,
    island:        renderIsland,
    homeworks:     renderHomeworks,
    song:          renderSong,
    dj:            renderDj,
    scores:        renderScores,
    votes:         renderVotes,
    ishare:        renderIshare,
    backup:        renderBackup,
    releases:      renderReleases,
    popups:        renderPopups,
    cards:         renderCards,
    dates:         renderDates,
    games:         renderGames,
    logins:        renderLogins,
    online:        renderOnline,
    clocklog:      renderClockLog,
    logs:          renderLogs,
    actionlogs:    renderActionLogs,
    secrets:       renderSecrets,
    settings:      renderSettings,
    account:       renderAccount
  })[page];

  /* v3.15.3（站主）：「信息分享这个后台一直转圈，转了四五分钟还是这样」
   * ------------------------------------------------------------
   * 旧写法是 `if(fn) fn();` —— 渲染函数不存在、或者里面第一行就抛错
   * （v3.15.0 那次就是函数被写在 IIFE 外，取不到 $），异常一路冒到
   * 控制台，而视图早就被设成了「加载中…」，于是那个圈就一直转下去。
   * 现在：缺函数 / 抛错都当场换成一张「这块没加载出来」的卡片，
   * 上面带「重试」和「强制刷新」，不用再去翻浏览器控制台。 */
  if(!fn){
    panelBroken(page, new Error('这个面板块没有对应的渲染程序（多半是页面缓存了旧版本）'));
    return;
  }
  try{
    fn();
  }catch(err){
    panelBroken(page, err);
    return;
  }

  /* 看门狗：12 秒后原来那个圈还在原地，就认定卡死，主动兜底。
     注意判据是「那一颗圈还在不在」，不是「视图里有没有 loading」——
     有些面板会自己再画一层加载态去等接口，那种情况算正常工作，
     不能误杀（接口本身另有 25 秒超时）。 */
  setTimeout(function(){
    if(STATE.page !== page) return;              /* 已经切到别的面板 */
    if(!loadingNode || !loadingNode.parentNode) return;  /* 内容已经画出来了 */
    panelBroken(page, new Error('等了 12 秒还停在加载状态'));
  }, 12000);
}

/* 面板没加载出来时的兜底界面：说清楚 + 给两条出路 */
function panelBroken(page, err){
  var view = $('view');
  if(!view) return;
  var msg = (err && (err.message || err)) || '未知错误';
  view.innerHTML =
    '<section class="panel" style="max-width:640px;margin:28px auto">'
    +  '<div class="panel-head"><h3>' + svg('alert', 17) + '这块没能加载出来</h3></div>'
    +  '<div class="panel-body">'
    +    '<p style="margin:0 0 10px">' + esc(msg) + '</p>'
    +    '<p class="muted" style="font-size:.82rem;margin:0 0 16px">'
    +      '如果这台设备之前打开过旧版本，多半是缓存了老页面 —— 点「强制刷新」清掉本地缓存重新取一次就好。'
    +    '</p>'
    +    '<div style="display:flex;gap:10px;flex-wrap:wrap">'
    +      '<button class="btn btn-sm" id="pbRetry">' + svg('refresh', 14) + '重试</button>'
    +      '<button class="btn btn-sm btn-secondary" id="pbHard">' + svg('download', 14) + '强制刷新</button>'
    +      '<span style="flex:1"></span>'
    +      '<span class="muted" style="font-size:.78rem;align-self:center">v' + (typeof SITE_VERSION !== 'undefined' ? SITE_VERSION : '?') + '</span>'
    +    '</div>'
    +  '</div>'
    + '</section>';
  var r = $('pbRetry'), h = $('pbHard');
  if(r) r.onclick = function(){ go(page); };
  if(h) h.onclick = adminHardRefresh;
}

/* 后台版「强制刷新」：注销 SW + 清空所有缓存 + 带时间戳重进
   （与首页 hardRefresh 同一套路，后台没有那个函数，这里自备一份） */
function adminHardRefresh(){
  var btn = $('pbHard');
  if(btn){ btn.disabled = true; btn.textContent = '正在清理缓存…'; }
  var goNow = function(){
    var u;
    try{
      var x = new URL(location.href);
      x.searchParams.delete('_r');
      x.searchParams.set('_r', Date.now());
      u = x.toString();
    }catch(e){ u = location.origin + location.pathname + '?_r=' + Date.now(); }
    try{ location.replace(u); }catch(e){ location.href = u; }
  };
  var killSw = function(){
    if(navigator.serviceWorker && navigator.serviceWorker.getRegistrations){
      return navigator.serviceWorker.getRegistrations().then(function(rs){
        return Promise.all(rs.map(function(r){ return r.unregister().catch(function(){}); }));
      }).catch(function(){});
    }
  };
  var wipe = function(){
    if(window.caches && caches.keys){
      return caches.keys().then(function(ks){
        return Promise.all(ks.map(function(k){ return caches.delete(k); }));
      }).catch(function(){});
    }
  };
  Promise.resolve().then(killSw).then(wipe).then(wipe)
    .then(function(){ setTimeout(goNow, 300); })
    .catch(function(){ setTimeout(goNow, 300); });
}

/* 移动端侧栏 */
function openSide(){ $('side').classList.add('open'); $('scrim').classList.add('show'); }
function closeSide(){ $('side').classList.remove('open'); $('scrim').classList.remove('show'); }

/* ============================================================================
 * ⑥ 面板：数据概览
 * ========================================================================= */
function renderOverview(){
  api('/admin?action=stats').then(function(j){
    var u = j.users || {}, d = j.data || {}, lg = j.login || {};
    var pf = j.profiles || {};
    var cards = [
      { icon:'users',    tone:'',      label:'总用户数',   value: u.total || 0,
        foot: '其中管理员 ' + (u.admins || 0) + ' 人' },
      { icon:'activity', tone:'green',  label:'今日已登录', value: u.today_active || 0,
        foot: '近 7 天活跃 ' + (u.active7 || 0) + ' 人' },
      { icon:'key',      tone:'amber',  label:'待改初始密码', value: u.pending_pwd || 0,
        foot: u.pending_pwd ? '这些同学还没首次改密' : '全部已改密' },
      { icon:'clock',    tone:'blue',   label:'累计登录次数', value: lg.total || 0,
        foot: '今日 ' + (lg.today || 0) + ' 次' },
      { icon:'database', tone:'',       label:'云端数据条数', value: d.rows || 0,
        foot: '占用 ' + bytes(d.bytes) },
      { icon:'shield',   tone:'green',  label:'当前在线',   value: j.onlineUsers || 0,
        foot: '在线会话 ' + (j.onlineSessions || 0) + ' 个 · 共 ' + (j.activeSessions || 0) + ' 个有效会话' },
      { icon:'inbox',    tone:'blue',   label:'班级资料',   value: pf.total || 0,
        foot: '已认领 ' + (pf.claimed || 0) + ' 条' },
      { icon:'check',    tone: (pf.pending ? 'amber' : 'green'), label:'待审资料修改', value: pf.pending || 0,
        foot: pf.pending ? '去「信息审核」处理' : '没有积压' },
      { icon:'eye',      tone:'',       label:'资料查看次数', value: pf.viewsTotal || 0,
        foot: '近 7 天 ' + (pf.views7 || 0) + ' 次' }
    ];

    var html =
      '<div class="stat-grid">' + cards.map(function(c){
        return '<div class="stat">'
          + '<div class="top"><div class="si ink-auto ' + c.tone + '">' + svg(c.icon, 21) + '</div></div>'
          + '<p class="label">' + esc(c.label) + '</p>'
          + '<h3 class="value">' + esc(c.value) + '</h3>'
          + '<p class="foot">' + esc(c.foot) + '</p>'
          + '</div>';
      }).join('') + '</div>'

      + '<div class="grid-2">'
      +   '<section class="panel">'
      +     '<div class="panel-head"><div><h3>' + svg('activity') + '最近登录</h3>'
      +       '<p class="sub">同学最近登录这台站点的记录</p></div>'
      +       '<button class="btn btn-sm btn-secondary" data-goto="logins">查看全部</button></div>'
      +     '<div class="feed" id="ovFeed"></div>'
      +   '</section>'
      +   '<section class="panel">'
      +     '<div class="panel-head"><div><h3>' + svg('chart') + '功能使用热度</h3>'
      +       '<p class="sub">同学云端同步最多的数据键</p></div></div>'
      +     '<div class="panel-body" id="ovKeys"></div>'
      +   '</section>'
      + '</div>';

    /* ⚠️ 迟到的响应不能抢页面：stats 是个慢接口，用户在等待期间很可能已经点去了别的面板。
       这里必须先确认「概览页还开着」，否则会把人家正在看的资料管理页整页冲掉。
       （2026-10-05 渲染测试实测踩到：切到资料管理后 stats 才回来，页面被换成了数据概览。） */
    if(STATE.page !== 'overview') return;
    $('view').innerHTML = html;

    /* 最近登录流 */
    var feed = $('ovFeed');
    var rec = lg.recent || [];
    if(!rec.length){
      feed.innerHTML = '<div class="empty">' + svg('inbox', 38) + '<p>还没有登录记录</p></div>';
    } else {
      feed.innerHTML = rec.map(function(r){
        var initial = String(r.username || '?').charAt(0).toUpperCase();
        return '<div class="feed-item">'
          + '<div class="fi">' + esc(initial) + '</div>'
          + '<div class="fb"><b>' + esc(r.username || '(已删除)') + '</b>'
          + '<p>' + (r.ip ? 'IP ' + esc(r.ip) : 'IP 未知') + '</p></div>'
          + '<time>' + esc(ago(r.createdAt)) + '</time>'
          + '</div>';
      }).join('');
    }

    /* 键热度条 */
    var keys = j.topKeys || [];
    if(!keys.length){
      $('ovKeys').innerHTML = '<div class="empty" style="padding:30px 12px">' + svg('inbox', 32) + '<p>暂无同步数据</p></div>';
    } else {
      var max = keys[0].count || 1;
      $('ovKeys').innerHTML = keys.map(function(k){
        var w = Math.max(Math.round(k.count / max * 100), 4);
        return '<div style="margin-bottom:13px">'
          + '<div style="display:flex;justify-content:space-between;font-size:.78rem;margin-bottom:5px">'
          + '<span class="mono" style="color:var(--fg-2)">' + esc(k.key) + '</span>'
          + '<b style="color:var(--accent-ink)">' + esc(k.count) + '</b></div>'
          + '<div class="progress-bar" style="margin:0"><i style="width:' + w + '%"></i></div>'
          + '</div>';
      }).join('');
    }

    var goto = $('view').querySelector('[data-goto]');
    if(goto) goto.onclick = function(){ go(goto.dataset.goto); };
  }).catch(function(e){
    /* 只在概览页还开着的时候才报错。
       否则用户已经切到别的面板，这个迟到的失败会把人家正在看的内容冲掉
       （2026-10-05 实测踩到：stats 慢了一步，把资料管理页整页替换成错误提示）。 */
    if(STATE.page !== 'overview') return;
    $('view').innerHTML = '<div class="alert danger">加载失败：' + esc(e.message) + '</div>';
  });
}

/* ============================================================================
 * ⑦ 面板：成员与档案（v2.10.0 第六十轮 #172，「用户管理」+「资料管理」合并）
 * ---------------------------------------------------------------------------
 * 背景：站主指出同一批人被「用户管理」「资料管理」分两处存储，改一处另一处
 * 对不上（根因：users.display_name 与 profiles.name 双写）。
 * 现在合并成一个页面、一个长表单：
 *   · 列表一次拉齐（GET /admin?action=members），每行带 scene 场景标记
 *   · 长表单不用折叠面板：上半「系统账号」下半「班级档案」，一次提交
 *     （POST /admin?action=save-member 内部按场景编排）
 *   · 姓名改为单数据源：profiles.name 是权威源，保存时后端同步
 *     users.display_name（见 api/admin.js upsertProfileCore）
 *
 * 四种场景（scene）：
 *   both         有账号 + 有档案（正常态）
 *   user-only    有账号暂无档案（建号时补档案失败 / 历史数据）
 *   profile-only 有档案无账号（通讯录先建、人还没领账号）
 *
 * 「头衔任命 / 联系方式审核 / 查看记录」保持独立页面，不并入本页。
 * ========================================================================= */
/* 「现在就在站上吗」（v2.5.0 起服务端会话级判定，口径与旧用户管理页一致） */
function isOnlineNow(u){
  if(!u) return false;
  if(typeof u.online === 'boolean') return u.online;
  var t = u.sessionLastSeen || u.lastSeenAt || u.lastLoginAt;
  if(!t) return false;
  var ms = Date.now() - new Date(t).getTime();
  return ms >= 0 && ms < 2 * 60 * 1000;
}

var MEMBER_SCENE = {
  both:         { text:'账号 · 档案', cls:'badge-blue'   },
  'user-only':  { text:'缺档案',      cls:'badge-amber'  },
  'profile-only': { text:'未认领',    cls:'badge-gray'   }
};

function renderMembers(){
  var S = STATE.members;
  var c = S.counts || {};

  $('view').innerHTML =
    '<div class="toolbar">'
    +   '<div class="search">' + svg('search', 15)
    +     '<input id="mbSearch" placeholder="搜索用户名 / 姓名 / 学号…" value="' + attr(S.q) + '" maxlength="40"></div>'
    +   '<select id="mbRole">'
    +     '<option value="">全部角色</option>'
    +     '<option value="user"' + (S.role === 'user' ? ' selected' : '') + '>普通用户</option>'
    +     '<option value="admin"' + (S.role === 'admin' ? ' selected' : '') + '>管理员</option>'
    +   '</select>'
    +   '<select id="mbStatus">'
    +     '<option value="">全部状态</option>'
    +     '<option value="active"' + (S.status === 'active' ? ' selected' : '') + '>正常</option>'
    +     '<option value="pending"' + (S.status === 'pending' ? ' selected' : '') + '>待审核</option>'
    +     '<option value="banned"' + (S.status === 'banned' ? ' selected' : '') + '>已禁用</option>'
    +   '</select>'
    +   '<button class="btn btn-sm btn-secondary" id="mbRefresh">' + svg('refresh', 14) + '刷新</button>'
    + '</div>'

    + '<div class="toolbar" style="background:var(--panel)">'
    +   '<button class="btn btn-sm" id="mbAdd">' + svg('plus', 14) + '新增成员</button>'
    +   '<button class="btn btn-sm btn-secondary" id="mbImportUser">' + svg('upload', 14) + '账号导入</button>'
    +   '<button class="btn btn-sm btn-secondary" id="mbImportProfile">' + svg('upload', 14) + '资料导入</button>'
    +   '<button class="btn btn-sm btn-secondary" id="mbExport">' + svg('download', 14) + '导出</button>'
    +   '<button class="btn btn-sm btn-secondary" id="mbFields">' + svg('layers', 14) + '字段管理</button>'
    +   '<button class="btn btn-sm btn-secondary" id="mbEncrypt" title="把还没加密的资料就地加密，不用重新导入">' + svg('lock', 14) + '一键加密存量</button>'
    +   '<span style="flex:1"></span>'
    +   '<span data-bulk class="muted" style="font-size:.8rem"></span>'
    + '</div>'

    + '<div class="chips" id="mbChips" style="margin-bottom:14px">'
    +   '<button class="chip' + (S.scene === '' ? ' on' : '') + '" data-sc="">全部 <b>' + (c.total || 0) + '</b></button>'
    +   '<button class="chip' + (S.scene === 'user-only' ? ' on' : '') + '" data-sc="user-only">缺档案 <b>' + (c.userOnly || 0) + '</b></button>'
    +   '<button class="chip' + (S.scene === 'profile-only' ? ' on' : '') + '" data-sc="profile-only">未认领 <b>' + (c.profileOnly || 0) + '</b></button>'
    +   '<button class="chip' + (S.scene === 'pending-review' ? ' on' : '') + '" data-sc="pending-review">待审联系方式 <b>' + (c.pendingReview || 0) + '</b></button>'
    + '</div>'

    + '<div class="alert info" style="margin-bottom:16px">'
    +   '全班成员与他们的班级档案现在<b>合并在同一页</b>：一条记录同时管账号与档案，保存时两处自动同步。'
    +   '「<b>未认领</b>」是只有通讯录、还没登录账号的同学；「<b>缺档案</b>」是建号时没配上档案的账号，点「编辑」即可补上。'
    + '</div>'

    /* 字段管理区（2026-10-09 v2.4.0）：默认折叠，点「字段管理」展开 */
    + '<section class="panel" id="mbFieldPanel" style="display:none;margin-bottom:16px">'
    +   '<div id="mbFieldBody"><div class="loading"><div class="spinner"></div>加载字段…</div></div>'
    + '</section>'

    + '<section class="panel"><div id="mbBody"><div class="loading"><div class="spinner"></div>加载中…</div></div></section>';

  $('mbSearch').oninput = debounce(function(e){ S.q = e.target.value.trim(); S.page = 1; loadMembers(); }, 320);
  $('mbRole').onchange   = function(e){ S.role = e.target.value; S.page = 1; loadMembers(); };
  $('mbStatus').onchange = function(e){ S.status = e.target.value; S.page = 1; loadMembers(); };
  $('mbRefresh').onclick = function(){ loadMembers(); };
  $('mbAdd').onclick     = function(){ memberDialog(null); };
  $('mbImportUser').onclick   = importDialog;
  $('mbImportProfile').onclick = profileImportDialog;
  $('mbExport').onclick  = memberExport;
  $('mbFields').onclick  = function(){
    var panel = $('mbFieldPanel');
    var open = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : 'block';
    if(!open){ renderFieldPanel(); panel.scrollIntoView({ behavior:'smooth', block:'nearest' }); }
  };
  $('mbEncrypt').onclick = function(){ encryptAllProfiles(); };

  Array.prototype.forEach.call($('mbChips').querySelectorAll('[data-sc]'), function(b){
    b.onclick = function(){
      S.scene = b.dataset.sc === 'pending-review' ? 'pending-review' : b.dataset.sc;
      S.page = 1;
      Array.prototype.forEach.call($('mbChips').querySelectorAll('.chip'), function(x){ x.classList.remove('on'); });
      b.classList.add('on');
      loadMembers();
    };
  });

  loadMembers();
}

function loadMembers(){
  var S = STATE.members;
  /* pending-review 是档案维度的筛选，后端不认这个 scene 值 —— 前端本地过滤 */
  var sceneQ = S.scene === 'pending-review' ? '' : S.scene;
  api('/admin?action=members&limit=' + S.size + '&offset=' + ((S.page - 1) * S.size)
      + '&q=' + encodeURIComponent(S.q || '')
      + '&role=' + encodeURIComponent(S.role || '')
      + '&status=' + encodeURIComponent(S.status || '')
      + '&scene=' + encodeURIComponent(sceneQ || ''))
    .then(function(j){
      S.list = j.members || [];
      S.total = j.total || 0;
      S.counts = j.counts || {};
      if(Array.isArray(j.fieldMeta)) S.fieldMeta = j.fieldMeta;
      /* 待审联系方式：后端按 profiles 口径给总数，这里本地筛出这一批 */
      if(S.scene === 'pending-review'){
        S.list = S.list.filter(function(m){ return m.contactStatus === 'pending'; });
        S.total = S.list.length;
      }
      paintMembers();
    })
    .catch(function(e){
      var b = $('mbBody');
      if(b) b.innerHTML = '<div class="alert danger" style="margin:18px">加载失败：' + esc(e.message) + '</div>';
    });
}

/** 行唯一键：有账号用 u+userId，无账号用 p+profileId（跨场景不撞车） */
function mkey(m){
  return (m.userId != null ? 'u' : 'p') + (m.userId != null ? m.userId : m.profileId);
}

/** 列表显示名：档案姓名是权威源，无档案退回账号显示名 */
function memberName(m){
  return m.name || m.displayName || m.username || '(未命名)';
}

function paintMembers(){
  var S = STATE.members;
  var body = $('mbBody');
  if(!body) return;

  /* 胶囊数字跟着最新统计刷新 */
  var chipAll = $('mbChips') && $('mbChips').querySelector('[data-sc=""] b');
  var chipUO  = $('mbChips') && $('mbChips').querySelector('[data-sc="user-only"] b');
  var chipPO  = $('mbChips') && $('mbChips').querySelector('[data-sc="profile-only"] b');
  var chipPR  = $('mbChips') && $('mbChips').querySelector('[data-sc="pending-review"] b');
  if(chipAll) chipAll.textContent = S.counts.total || 0;
  if(chipUO)  chipUO.textContent  = S.counts.userOnly || 0;
  if(chipPO)  chipPO.textContent  = S.counts.profileOnly || 0;
  if(chipPR)  chipPR.textContent  = S.counts.pendingReview || 0;

  if(!S.list.length){
    body.innerHTML = '<div class="empty">' + svg('users', 38)
      + '<p>' + (S.q || S.role || S.status || S.scene ? '没有匹配的成员' : '还没有任何成员') + '</p>'
      + (S.q || S.role || S.status || S.scene ? '' : '<p style="font-size:.78rem;margin-top:8px">点「新增成员」把第一位同学加进来</p>')
      + '</div>';
    return;
  }

  var extras = extraColsOf();
  var allChecked = S.list.length > 0 && S.list.every(function(m){ return S.selected[mkey(m)]; });

  var rows = S.list.map(function(m){
    var key = mkey(m);
    var sc = MEMBER_SCENE[m.scene] || MEMBER_SCENE.both;
    var ini = String(memberName(m)).charAt(0);

    /* 🔻 v3.5.12（站主 2026-10-17 #2「成员档案只展示联系方式，其他的通过详情查看」）
       列表只留三样东西：头像+姓名、联系方式（微信/QQ/手机）、操作按钮。
       学号、身份、头衔、政治面貌、自定字段、可见性、审核状态
       全部收进「详情」弹窗，列表不再堆成一堵墙。
       v3.5.13 站主补充：「不是把其他的都删了，账号状态、最后上线时间还是要的」
       → 加回一列精简「状态」：账号在不在 + 最后上线，一眼能扫；其余仍走详情。 */
    var sub = '<div class="muted"><i class="mono">@' + esc(m.username || (m.studentId ? '学号 ' + m.studentId : '未认领'))
      + '</i></div>';

    /* 账号状态异常时才在名字后面挂个小徽章，正常状态不占地方 */
    var flag = '';
    if(m.role === 'admin') flag += '<span class="badge badge-orange">管理员</span>';
    if(m.status === 'pending') flag += '<span class="badge badge-amber">待审核</span>';
    if(m.status === 'banned') flag += '<span class="badge badge-red">已禁用</span>';
    if(m.mustChangePassword) flag += '<span class="badge badge-amber">待改密</span>';
    if(!m.name && m.profileId == null) flag += '<span class="badge badge-gray">无档案</span>';

    var ct = function(label, v){
      return '<div class="ct"><i>' + label + '</i>'
        + (v ? '<span title="' + attr(v) + '">' + esc(v) + '</span>'
             : '<span class="none">—</span>')
        + '</div>';
    };
    var contacts = '<div class="ct-grid">'
      + ct('微信', m.wechat) + ct('QQ', m.qq) + ct('手机', m.phone)
      + '</div>';

    /* v3.5.13 状态列：账号状态一行字 + 最后上线相对时间 */
    var acctTxt = m.userId == null ? '无账号'
      : (m.status === 'banned' ? '已禁用' : m.status === 'pending' ? '待审核' : m.status === 'active' ? '正常' : (m.status || '正常'));
    var acctCls = m.userId == null ? 'badge-gray'
      : (m.status === 'banned' ? 'badge-red' : m.status === 'pending' ? 'badge-amber' : 'badge-green');
    var seenV = m.sessionLastSeen || m.lastSeenAt || m.lastLoginAt;
    var statusCell = '<div class="mb-status">'
      + '<span class="badge ' + acctCls + '">' + esc(acctTxt) + '</span>'
      + (isOnlineNow(m) ? '<span class="badge badge-green">在线</span>' : '')
      + '<div class="muted" style="font-size:.72rem;margin-top:2px">'
      +   (seenV ? ago(seenV) : '从未上线') + '</div></div>';

    /* 行内操作：详情对所有行开放（v3.5.12 起）；账号类操作仅对有账号的行开放 */
    var acts = '<button class="ok" data-mb="detail" data-key="' + attr(key) + '">详情</button>'
      + '<button data-mb="edit" data-key="' + attr(key) + '">编辑</button>'
      + (m.userId != null
          ? '<button data-mb="pwd" data-key="' + attr(key) + '">重置密码</button>'
            + (m.status === 'pending'
                ? '<button class="ok" data-mb="approve" data-key="' + attr(key) + '">通过</button>'
                  + '<button class="danger" data-mb="reject" data-key="' + attr(key) + '">驳回</button>'
                : (m.status === 'banned'
                    ? '<button class="ok" data-mb="unban" data-key="' + attr(key) + '">解禁</button>'
                    : '<button class="danger" data-mb="ban" data-key="' + attr(key) + '">禁用</button>'))
          : '')
      + (m.profileId != null
          ? '<button data-mb="views" data-key="' + attr(key) + '">查看记录</button>'
          : '');

    return '<tr' + (S.selected[key] ? ' class="sel"' : '') + '>'
      + '<td><input type="checkbox" class="chk" data-pick="' + attr(key) + '"' + (S.selected[key] ? ' checked' : '') + '></td>'
      + '<td><div class="cell-user"><div class="av ink-auto">' + esc(ini) + '</div>'
      +   '<div><b>' + esc(memberName(m)) + '</b> ' + flag + sub + '</div></div></td>'
      + '<td>' + contacts + '</td>'
      + '<td>' + statusCell + '</td>'
      + '<td class="nowrap" style="text-align:right"><div class="row-actions">' + acts
      +   (m.userId != null
            ? '<button class="danger" data-mb="del" data-key="' + attr(key) + '"'
              + (STATE.me && m.userId === STATE.me.id ? ' disabled title="不能删除自己"' : '') + '>删除</button>'
            : (m.profileId != null
                ? '<button class="danger" data-mb="delprofile" data-key="' + attr(key) + '">删档案</button>'
                : ''))
      + '</div></td>'
      + '</tr>';
  }).join('');

  var size = S.size;
  var shownTo = Math.min(S.page * size, S.total);

  body.innerHTML =
    '<div class="table-wrap"><table><thead><tr>'
    + '<th style="width:38px"><input type="checkbox" class="chk" data-pick-all' + (allChecked ? ' checked' : '') + '></th>'
    + '<th>成员</th><th>联系方式</th><th>状态</th>'
    + '<th style="text-align:right">操作</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
    + '<div class="pager">'
    +   '<span class="info">共 ' + S.total + ' 条，当前显示第 ' + ((S.page - 1) * size + 1) + '–' + shownTo + ' 条</span>'
    +   '<span class="pages">'
    +     '<button data-pg="prev"' + (S.page <= 1 ? ' disabled' : '') + '>上一页</button>'
    +     '<button class="on">' + S.page + '</button>'
    +     '<button data-pg="next"' + (shownTo >= S.total ? ' disabled' : '') + '>下一页</button>'
    +   '</span>'
    + '</div>';

  /* --- 事件绑定 --- */
  Array.prototype.forEach.call(body.querySelectorAll('[data-pick]'), function(cb){
    cb.onchange = function(){ S.selected[cb.dataset.pick] = cb.checked; paintPick(); paintMembers(); };
  });
  var allCb = body.querySelector('[data-pick-all]');
  if(allCb){
    allCb.onchange = function(){
      S.list.forEach(function(m){ S.selected[mkey(m)] = allCb.checked; });
      paintMembers();
    };
  }
  Array.prototype.forEach.call(body.querySelectorAll('[data-mb]'), function(b){
    b.onclick = function(){ memberAction(b.dataset.mb, b.dataset.key); };
  });
  Array.prototype.forEach.call(body.querySelectorAll('[data-pg]'), function(b){
    b.onclick = function(){
      if(b.disabled) return;
      S.page += (b.dataset.pg === 'next' ? 1 : -1);
      loadMembers();
    };
  });

  paintPick();
}

/** 按 key 找回行对象（key = 'u'+userId 或 'p'+profileId） */
function memberByKey(key){
  var S = STATE.members;
  for(var i = 0; i < S.list.length; i++){
    var m = S.list[i];
    if(mkey(m) === key) return m;
  }
  return null;
}

/** 绘制批量操作提示条（只对有账号的行开放账号类批量操作） */
function paintPick(){
  var S = STATE.members;
  var ids = Object.keys(S.selected).filter(function(k){ return S.selected[k]; });
  var el = document.querySelector('[data-bulk]');
  if(!el) return;
  if(!ids.length){
    el.className = 'muted';
    el.innerHTML = '';
    return;
  }
  /* 只有带账号的行能批量重置密码 / 禁用 / 删除 */
  var withAccount = ids.filter(function(k){ var m = memberByKey(k); return m && m.userId != null; });
  el.className = '';
  el.innerHTML = '已选 <b style="color:var(--accent-ink)">' + ids.length + '</b> 人'
    + (withAccount.length
        ? ' <button class="btn btn-sm btn-ghost" data-bulk-pwd style="margin-left:6px">批量重置密码</button> '
          + '<button class="btn btn-sm btn-ghost" data-bulk-ban style="margin-left:4px">批量禁用</button> '
          + '<button class="btn btn-sm btn-ghost" data-bulk-del style="margin-left:4px;color:var(--danger)">批量删除</button> '
        : ' <span class="muted" style="font-size:.76rem">（选中的都没有账号，仅能逐个编辑档案）</span> ')
    + '<button class="btn btn-sm btn-ghost" data-bulk-clear style="margin-left:4px">取消选择</button>';

  var q = function(sel){ return el.querySelector(sel); };
  if(q('[data-bulk-pwd]')) q('[data-bulk-pwd]').onclick = function(){ bulkResetPwd(withAccount); };
  if(q('[data-bulk-ban]')) q('[data-bulk-ban]').onclick = function(){ bulkBan(withAccount); };
  if(q('[data-bulk-del]')) q('[data-bulk-del]').onclick = function(){ bulkDelMembers(withAccount); };
  q('[data-bulk-clear]').onclick = function(){
    STATE.members.selected = {}; paintMembers();
  };
}

/** 批量删除成员：先剔自己，再逐个串行删；有档案的追加一问「是否连带删档案」 */
function bulkDelMembers(ids){
  var mineId = STATE.me ? STATE.me.id : 0;
  var target = ids.filter(function(k){
    var m = memberByKey(k);
    return m && m.userId != null && Number(m.userId) !== Number(mineId);
  });
  if(!target.length){ toast('选中的只有你自己的账号或没有账号，不能删除', 'err', 3800); return; }
  var skipped = ids.length - target.length;
  var hasProfile = target.some(function(k){ var m = memberByKey(k); return m && m.profileId != null; });

  confirmBox({
    title: '批量删除成员',
    html: '确定要删除选中的 <b>' + target.length + '</b> 个成员吗？',
    detail: '他们的账号与云端数据会一并清除；班级档案默认保留（变为「未认领」）。'
          + (skipped ? '\n已自动跳过你自己的账号。' : ''),
    warn: '不可撤销。如果只是想暂时阻止登录，请改用「批量禁用」。',
    danger: true,
    okText: '确认删除',
  }).then(function(ok){
    if(!ok) return;
    var step2 = function(alsoProfile){
      var doneN = 0, failN = 0, firstErr = '';
      var idx = 0;
      var step = function(){
        if(idx >= target.length) return finish();
        var m = memberByKey(target[idx]);
        return api('/admin?action=delete-user', { method:'POST', body:{ id:m.userId, alsoProfile:!!alsoProfile } })
          .then(function(){ doneN++; })
          .catch(function(e){ failN++; if(!firstErr) firstErr = e.message; })
          .then(function(){ idx++; return step(); });
      };
      var finish = function(){
        STATE.members.selected = {};
        loadMembers();
        var msg = '已删除 ' + doneN + ' 个成员';
        if(failN) msg += '，失败 ' + failN + ' 个（' + firstErr + '）';
        toast(msg, failN ? 'err' : 'ok', 4200);
      };
      step();
    };
    /* 有档案的追问一句：档案是通讯录，删不删要让站长明确选 */
    if(hasProfile){
      confirmBox({
        title: '是否连带删除班级档案',
        text: '这 ' + target.length + ' 人里有人挂着班级档案（含联系方式）。删除账号后档案默认保留为「未认领」，要一并删掉吗？',
        detail: '选「保留档案」：人还能在通讯录里，只是没了登录账号。\n选「一并删除」：档案与联系方式彻底消失。',
        danger: true,
        okText: '一并删除', noText: '保留档案',
      }).then(function(yes){ step2(!!yes); });
    } else {
      step2(false);
    }
  });
}

/* ---------------- 行内操作分发 ---------------- */
function memberAction(act, key){
  var m = memberByKey(key);
  if(!m) return;
  if(act === 'edit')       return memberDialog(m);
  /* v3.5.12：详情对**所有**行开放（含未认领的档案行）；有账号时顺手带出账号信息 */
  if(act === 'detail')     return memberDetailDialog(m);
  if(act === 'pwd')        return resetPwdDialog(m.userId, m);
  if(act === 'views')      return profileViewsDialog(m.profileId);
  if(act === 'ban')        return memberSetStatus(m, 'banned');
  if(act === 'unban')      return memberSetStatus(m, 'active');
  if(act === 'del')        return deleteMemberDialog(m);
  if(act === 'delprofile') return deleteProfileOfMember(m);
  /* v2.10.0：注册审核 */
  if(act === 'approve')    return reviewMember(m, 'approve');
  if(act === 'reject')     return reviewMember(m, 'reject');
}

/** 禁用 / 解禁（账号类操作，仅对有账号的行开放） */
function memberSetStatus(m, status){
  if(!m || m.userId == null) return;
  if(STATE.me && m.userId === STATE.me.id){ toast('不能禁用自己的账号', 'err'); return; }
  var isBan = status === 'banned';
  confirmBox({
    title: isBan ? '禁用成员' : '解除禁用',
    text: isBan
      ? '确定禁用「' + memberName(m) + '」吗？对方会被立刻踢下线且无法再登录。'
      : '确定恢复「' + memberName(m) + '」的登录吗？',
    danger: isBan,
    okText: isBan ? '禁用' : '解禁',
  }).then(function(yes){
    if(!yes) return;
    api('/admin?action=set-status', { method:'POST', body:{ id:m.userId, status:status } })
      .then(function(j){ toast(j.message || '已更新', 'ok', 3600); loadMembers(); })
      .catch(function(e){ toast(e.message, 'err', 4200); });
  });
}

/** v2.10.0：审核注册成员（通过 = 立即可登录；驳回 = 禁用并踢会话） */
function reviewMember(m, decision){
  if(!m || m.userId == null) return;
  var approve = decision === 'approve';
  confirmBox({
    title: approve ? '通过注册审核' : '驳回注册申请',
    text: approve
      ? '确定通过「' + memberName(m) + '」的注册吗？通过后对方即可登录。'
      : '确定驳回「' + memberName(m) + '」的注册吗？驳回后该账号将被禁用。',
    danger: !approve,
    okText: approve ? '通过审核' : '驳回',
  }).then(function(ok){
    if(!ok) return;
    api('/admin?action=user-review', { method:'POST', body:{ id:m.userId, decision:decision } })
      .then(function(j){
        toast(j.message || '已审核', 'ok', 3600);
        loadMembers();
      })
      .catch(function(e){ toast('审核失败：' + e.message, 'err', 4200); });
  });
}

/** 删除成员（账号）。档案默认保留为「未认领」，可选择连带删除。 */
function deleteMemberDialog(m){
  if(!m || m.userId == null) return;
  if(STATE.me && m.userId === STATE.me.id){ toast('不能删除自己的账号', 'err'); return; }
  var label = memberName(m) + (m.username ? '（@' + m.username + '）' : '');

  confirmBox({
    title: '删除成员',
    html: '确定要删除 <b>' + esc(label) + '</b> 吗？',
    detail: '账号与云端数据（点歌记录、作业提交、会话）会一并清除。'
          + (m.profileId != null ? '\n他的班级档案默认保留为「未认领」，可在下一步选择一并删除。' : ''),
    warn: '不可撤销。如果只是想暂时阻止登录，请改用「禁用」。',
    danger: true,
    okText: '确认删除',
  }).then(function(ok){
    if(!ok) return;
    var go = function(alsoProfile){
      api('/admin?action=delete-user', { method:'POST', body:{ id:m.userId, alsoProfile:!!alsoProfile } })
        .then(function(j){
          toast(j.message || '已删除', 'ok', 3600);
          delete STATE.members.selected[mkey(m)];
          loadMembers();
        })
        .catch(function(e){ toast('删除失败：' + e.message, 'err', 4200); });
    };
    if(m.profileId != null){
      confirmBox({
        title: '是否连带删除班级档案',
        text: '「' + memberName(m) + '」挂着班级档案（含联系方式）。要一并删掉吗？',
        detail: '选「保留档案」：人还在通讯录里，只是没了登录账号。\n选「一并删除」：档案与联系方式彻底消失。',
        danger: true,
        okText: '一并删除', noText: '保留档案',
      }).then(function(yes){ go(!!yes); });
    } else {
      go(false);
    }
  });
}

/** 删除档案（无账号的通讯录条目，或只清档案不动账号） */
function deleteProfileOfMember(m){
  if(!m || m.profileId == null) return;
  confirmBox({
    title: '删除班级档案',
    html: '确定要删除 <b>' + esc(memberName(m)) + '</b> 的档案吗？',
    warn: '删除后该条通讯录及其联系方式会一并消失。此操作不可撤销。',
    danger: true,
    okText: '删除',
  }).then(function(yes){
    if(!yes) return;
    api('/admin?action=delete-profile', { method:'POST', body:{ id:m.profileId } })
      .then(function(j){ toast(j.message || '已删除', 'ok'); loadMembers(); })
      .catch(function(e){ toast(e.message, 'err', 4000); });
  });
}

/** 重置密码（账号类操作；m 用于显示名，缺省时按 id 显示） */
function resetPwdDialog(id, m){
  var name = m ? memberName(m) : ('#' + id);
  promptBox({
    title: '重置密码',
    sub: '为「' + name + '」设置一个新的初始密码',
    label: '新密码（6–64 位）',
    type: 'text',
    placeholder: '例如 Class2025',
    hint: '重置后该用户必须用新密码重新登录，且下次登录需自行修改密码。管理后台不保存、也无法查看明文密码。',
    okText: '确认重置',
    validate: function(v){ return (v.length < 6 || v.length > 64) ? '密码长度需 6–64 位' : ''; }
  }).then(function(v){
    if(v === null) return;
    api('/admin?action=reset-password', { method:'POST', body:{ id:id, newPassword:v } })
      .then(function(j){ toast(j.message || '已重置', 'ok', 4000); loadMembers(); })
      .catch(function(e){ toast(e.message, 'err', 4000); });
  });
}

/* ---------------- 批量操作（仅对带账号的行） ---------------- */
function bulkResetPwd(keys){
  var targets = keys.map(function(k){ return memberByKey(k); })
    .filter(function(m){ return m && m.userId != null; });
  if(!targets.length){ toast('选中的成员都没有账号', 'err'); return; }
  promptBox({
    title: '批量重置密码',
    sub: '已选择 ' + targets.length + ' 个账号',
    label: '统一的新初始密码（6–64 位）',
    placeholder: '例如 Class2025',
    hint: '这 ' + targets.length + ' 个账号都会被设为该密码，并强制下次登录时改密。',
    okText: '批量重置',
    validate: function(v){ return (v.length < 6 || v.length > 64) ? '密码长度需 6–64 位' : ''; }
  }).then(function(v){
    if(v === null) return;
    var ok = 0, bad = 0;
    var seq = Promise.resolve();
    targets.forEach(function(m){
      seq = seq.then(function(){
        return api('/admin?action=reset-password', { method:'POST', body:{ id:m.userId, newPassword:v } })
          .then(function(){ ok++; }).catch(function(){ bad++; });
      });
    });
    seq.then(function(){
      toast('批量重置完成：成功 ' + ok + ' 个' + (bad ? '，失败 ' + bad + ' 个' : ''), bad ? 'warn' : 'ok', 4200);
      STATE.members.selected = {};
      loadMembers();
    });
  });
}

function bulkBan(keys){
  var targets = keys.map(function(k){ return memberByKey(k); })
    .filter(function(m){ return m && m.userId != null; });
  if(!targets.length){ toast('选中的成员都没有账号', 'err'); return; }
  var mineId = STATE.me ? STATE.me.id : 0;
  targets = targets.filter(function(m){ return Number(m.userId) !== Number(mineId); });
  if(!targets.length){ toast('选中的只有你自己的账号，不能禁用', 'err'); return; }
  confirmBox({
    title: '批量禁用',
    text: '确定为所选的 ' + targets.length + ' 个账号全部禁用吗？他们会被立刻踢下线且无法再登录。',
    danger: true, okText: '全部禁用'
  }).then(function(yes){
    if(!yes) return;
    var ok = 0, bad = 0;
    var seq = Promise.resolve();
    targets.forEach(function(m){
      seq = seq.then(function(){
        return api('/admin?action=set-status', { method:'POST', body:{ id:m.userId, status:'banned' } })
          .then(function(){ ok++; }).catch(function(){ bad++; });
      });
    });
    seq.then(function(){
      toast('批量禁用完成：成功 ' + ok + ' 个' + (bad ? '，失败 ' + bad + ' 个' : ''), bad ? 'warn' : 'ok', 4200);
      STATE.members.selected = {};
      loadMembers();
    });
  });
}

/**
 * 合并导出：账号 + 档案一张表（v2.10.0 #172）。
 * 走 members 接口当前筛选（搜索/角色/状态/场景），自定义字段动态追加列。
 * 导的是「管理员视图」：含联系方式原文与身份证号等私密字段，文件请妥善保管。
 *
 * 🔴 v3.15.2（站主）：「导出不完整，身份证号没有；以后新增的字段是不是也没有？」
 *   根因：列是手写的 —— extraColsOf() 把 id_card / youth_league_no 当成「表单里的固定列」
 *   排除掉，可表头里又没补上这两列，于是这两列永远导不出来；
 *   以后每加一个字段，都得回来改一次这份名单，迟早再漏。
 *   现在改成**完全按字段元数据出列**（profile_field_meta，按 sortOrder 排），
 *   值从固定键或 extra 里取 —— 后台「字段管理」里加了新字段，导出自动多一列。
 */
function memberExportCols(meta){
  var skip = ['contact_status', 'reject_reason'];   /* 状态另有中文列，不重复 */
  var cols = (meta || []).filter(function(f){ return f && f.field && skip.indexOf(f.field) < 0; });
  /* 兜底：元数据异常时，至少保住姓名与学号两列 */
  ['name', 'student_id'].forEach(function(k){
    var has = cols.some(function(f){ return f.field === k; });
    if(!has) cols.unshift({ field: k, label: k === 'name' ? '姓名' : '学号' });
  });
  return cols;
}

/* 一行的单元格：固定键走顶层字段，其余（含身份证号与以后新增的）走 extra */
function memberCell(m, f){
  var k = f.field;
  if(k === 'name') return memberName(m);
  if(k === 'student_id') return m.studentId || '';
  if(k === 'politics') return m.politics || '';
  if(k === 'exam_no') return m.examNo || '';
  if(k === 'role') return m.identity || m.role || '';
  if(k === 'title'){
    return (m.titles && m.titles.length) ? m.titles.join('、') : (m.title || '');
  }
  if(k === 'wechat') return m.wechat || '';
  if(k === 'qq') return m.qq || '';
  if(k === 'phone') return m.phone || '';
  var v = (m.extra || {})[k];
  return (v == null) ? '' : v;
}

function memberExport(){
  var S = STATE.members;
  var sceneQ = S.scene === 'pending-review' ? '' : S.scene;
  loadXLSX().then(function(XLSX){
    if(!XLSX){ toast('表格组件加载失败（三个 CDN 都不可达），请检查网络后重试', 'err', 4200); return; }
    var qs = '/admin?action=members&limit=500'
           + '&q=' + encodeURIComponent(S.q || '')
           + '&role=' + encodeURIComponent(S.role || '')
           + '&status=' + encodeURIComponent(S.status || '')
           + '&scene=' + encodeURIComponent(sceneQ || '');
    api(qs).then(function(j){
      var list = j.members || [];
      if(!list.length){ toast('当前筛选条件下没有成员可导出', 'err'); return; }

      var cols = memberExportCols(j.fieldMeta || S.fieldMeta || []);
      var head = cols.map(function(f){ return f.label || f.field; })
        .concat(['用户名', '账号角色', '账号状态', '审核状态', '场景', '最后上线']);
      var data = [head].concat(list.map(function(m){
        var line = cols.map(function(f){ return memberCell(m, f); });
        return line.concat([
          m.username || '（未开通）',
          m.role === 'admin' ? '管理员' : (m.userId != null ? '普通用户' : ''),
          m.status === 'banned' ? '已禁用' : (m.status === 'pending' ? '待审核' : (m.userId != null ? '正常' : '')),
          (CONTACT_LABEL[m.contactStatus] || CONTACT_LABEL.none).text,
          (MEMBER_SCENE[m.scene] || MEMBER_SCENE.both).text,
          m.lastLoginAt ? fmt(m.lastLoginAt) : (m.lastSeenAt ? fmt(m.lastSeenAt) : ''),
        ]);
      }));

      /* 留一份给自动化测试核对「列是否齐全」（也方便现场排查导出了什么） */
      try{ window.__lastExport = { head: head, rows: data.slice(1), at: Date.now() }; }catch(e){}

      var ws = XLSX.utils.aoa_to_sheet(data);
      ws['!cols'] = head.map(function(h){ return { wch: Math.max(10, String(h).length * 2 + 4) }; });
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '成员与档案');
      XLSX.writeFile(wb, '成员与档案_' + fmt(new Date(), 'date').replace(/-/g, '') + '.xlsx');
      toast('已导出 ' + list.length + ' 条记录 · ' + cols.length + ' 个档案字段', 'ok', 3200);
    }).catch(function(e){ toast(e.message || '导出失败', 'err', 4000); });
  });
}

/**
 * v2.10.0 #172：成员长表单（新增 / 编辑通用）。
 * 不用折叠面板——按站主要求「上半系统账号信息、下半班级档案」直接铺开，
 * 一次提交（POST /admin?action=save-member），后端按场景编排。
 *
 * 四种场景在表单里的表现：
 *   新增（都无）        账号段：用户名 + 初始密码必填；档案段全空待填
 *   both                账号段：用户名只读 + 角色/状态可改；档案段带现值
 *   user-only           账号段同 both；档案段空 + 提示「填任一字段即自动补建」
 *   profile-only        账号段：未开通 + 「开通账号」勾选（展开用户名/密码）；
 *                       档案段带现值
 */
function memberDialog(m){
  var isNew = !m;
  var hasUser = !isNew && m.userId != null;
  var hasProfile = !isNew && m.profileId != null;
  var POL = ['普通学生', '共青团员', '共青团员 · 团支书', '中共党员', '中共预备党员', '群众'];
  var name0 = isNew ? '' : (m.name || m.displayName || '');
  /* v3.5.22：身份（profiles.role）与账号角色（users.role）是两个东西。
     账号角色管权限（普通用户 / 管理员），身份是档案里给人看的标签（学生 / 走读…）。 */
  var identity0 = isNew ? '学生' : (m.identity || '学生');
  var curTitles = (!isNew && m.titles && m.titles.length) ? m.titles : [];

  /* v3.5.5：政治面貌选项跟随「字段管理」里的规则（预置：群众/共青团员）。
     规则没配时退回老列表；当前值不在选项里时置顶展示（历史值不改库）。 */
  function polOpts(cur){
    var rule = ruleOf('politics');
    var list = (rule.type === 'select' && rule.options && rule.options.length)
      ? rule.options.slice() : POL.slice();
    if(cur && list.indexOf(cur) < 0) list.unshift(cur);
    return list.map(function(x){
      return '<option value="' + attr(x) + '"' + (x === cur ? ' selected' : '') + '>' + esc(x) + '</option>';
    }).join('');
  }

  /* ---- ① 系统账号段 ---- */
  var accountSec =
    '<div class="mb-form-sec">'
    + '<h4>' + svg('lock', 15) + ' 系统账号</h4>'
    + '<p class="hint" style="margin:-4px 0 12px">账号是登录凭证。用户名创建后不可修改，密码不在这里改（用行内「重置密码」）。</p>'

    /* 用户名：已有账号只读；否则（新增 / 给未认领成员开号）可填 */
    + (hasUser
        ? '<div class="field"><label>用户名</label>'
          + '<input value="' + attr(m.username) + '" disabled>'
          + '<p class="hint">登录名不可修改。要换登录名只能删除账号重建（档案不受影响）。</p></div>'
        : '<div class="field"><label for="mbUser">用户名 <span style="color:var(--danger)">*</span></label>'
          + '<input id="mbUser" placeholder="3–20 位，中英文/数字/下划线" autocomplete="off">'
          + '<p class="hint">' + (isNew ? '同学用它登录，告诉他初始密码。' : '给这位只有通讯录的同学开一个登录账号。') + '</p></div>'
          + '<div class="field"><label for="mbPwd">初始密码 <span style="color:var(--danger)">*</span></label>'
          + '<input id="mbPwd" placeholder="6–64 位" autocomplete="new-password">'
          + '<p class="hint">首次登录后会建议他自己改密码。</p></div>')

    /* 未认领场景：开不开号由站长选（不开就只存通讯录） */
    + (!isNew && !hasUser
        ? '<label class="chk" style="margin-bottom:12px"><input type="checkbox" id="mbOpen" checked>'
          + ' 顺便开通登录账号（勾选后上面两项必填；不勾则只保存通讯录）</label>'
        : '')

    /* 姓名：单数据源，档案与账号显示名同一个框。
       v3.5.5：maxlength 跟随规则（预置：最多 3 个中文字符）。 */
    + '<div class="field"><label for="mbName">姓名</label>'
    + '<input id="mbName" maxlength="' + (ruleOf('name').maxLen || 30) + '" value="' + attr(name0) + '" placeholder="如 余子康">'
    + '<p class="hint">这一个框同时写进<b>班级档案</b>与<b>账号显示名</b>（单数据源，不会再出现两处对不上）。</p></div>'

    /* 角色 / 状态：仅对（将有）账号有意义 */
    + '<div class="mb-form-grid">'
    +   '<div class="field"><label for="mbRole">角色</label>'
    +     '<select id="mbRole">'
    +       '<option value="user"' + (!isNew && m.role === 'admin' ? '' : ' selected') + '>普通用户</option>'
    +       '<option value="admin"' + (!isNew && m.role === 'admin' ? ' selected' : '') + '>管理员</option>'
    +     '</select></div>'
    +   '<div class="field"><label for="mbStatus">状态</label>'
    +     '<select id="mbStatus"'
    +       (hasUser ? '' : ' disabled title="还没有账号，开通后生效"') + '>'
    +       '<option value="active"' + (!isNew && m.status === 'active' ? ' selected' : '') + '>正常</option>'
    +       '<option value="pending"' + (!isNew && m.status === 'pending' ? ' selected' : '') + '>待审核</option>'
    +       '<option value="banned"' + (!isNew && m.status === 'banned' ? ' selected' : '') + '>已禁用</option>'
    +     '</select></div>'
    + '</div>'

    /* 账号只读信息（编辑已有账号时） */
    + (hasUser
        ? '<dl class="kv" style="margin-top:4px">'
          + '<dt>账号 ID</dt><dd class="mono">' + m.userId + '</dd>'
          + '<dt>创建时间</dt><dd>' + esc(fmt(m.createdAt)) + '</dd>'
          + '<dt>最后登录</dt><dd>' + (m.lastLoginAt ? esc(fmt(m.lastLoginAt) + '（' + ago(m.lastLoginAt) + '）') : '从未登录') + '</dd>'
          + '<dt>最后上线</dt><dd>' + (isOnlineNow(m)
              ? '<span class="badge badge-green">在线中</span>'
              : esc(m.lastSeenAt ? fmt(m.lastSeenAt) + '（' + ago(m.lastSeenAt) + '）' : '未记录')) + '</dd>'
          + '<dt>云端数据</dt><dd>' + (m.dataCount || 0) + ' 条</dd>'
          + '<dt>首次改密</dt><dd>' + (m.mustChangePassword
              ? '<span class="badge badge-amber">待改密</span>'
              : '<span class="badge badge-green">已改密</span>') + '</dd>'
          + '</dl>'
        : '')
    + '</div>';

  /* ---- ② 班级档案段 ---- */
  var vp0 = (!isNew && m.visibilityPref) || {};
  var profileSec =
    '<div class="mb-form-sec" style="margin-top:20px">'
    + '<h4>' + svg('inbox', 15) + ' 班级档案</h4>'
    + '<p class="hint" style="margin:-4px 0 12px">'
    +   (hasProfile
        ? '姓名 / 学号 / 政治面貌只有管理员能改；联系方式管理员填写视为已核实。'
        : (hasUser
            ? '这个账号还没有班级档案——下面填任一字段，保存时自动补建并绑定。'
            : '通讯录信息。暂时不开账号也可以先只存档案。'))
    + '</p>'

    /* 档案 §1：学号 / 身份 / 政治面貌 */
    + '<div class="mb-form-grid">'
    +   '<div class="field"><label for="mbSid">学号</label>'
    +     '<input id="mbSid" maxlength="' + (ruleOf('student_id').digits || 20) + '"'
    +       ' inputmode="numeric" value="' + attr(isNew ? '' : m.studentId) + '" placeholder="如 250501">'
    +     '<p class="hint">全部成员里唯一，重复会报错。</p></div>'
    +   '<div class="field"><label for="mbIdentity">身份</label>'
    +     '<div class="fld-cp">'
    +       '<input id="mbIdentity" class="inp" maxlength="10" value="' + attr(identity0) + '" placeholder="学生">'
    +       cpBtnHtml('role')
    +     '</div>'
    +     '<p class="hint">前台显示在姓名旁，如「学生 / 走读 / 住校」。'
    +       '<b>班级职务不要写这里</b>，在下面「头衔（可多选）」里勾 —— 大屏点名勾「班干部」「课代表」认的是头衔。</p></div>'
    + '</div>'

    /* v4.0.0（站主 9 条之六）：性别。大屏随机点名「可以按性别抽」的数据来源，
       平时也是班级资料的一部分（可见性跟随字段管理，默认公开）。 */
    + '<div class="mb-form-grid">'
    +   '<div class="field"><label for="mbGender">性别</label>'
    +     '<select id="mbGender">'
    +       '<option value=""' + (!isNew && m.gender ? '' : ' selected') + '>未填</option>'
    +       '<option value="男"' + (!isNew && m.gender === '男' ? ' selected' : '') + '>男</option>'
    +       '<option value="女"' + (!isNew && m.gender === '女' ? ' selected' : '') + '>女</option>'
    +     '</select>'
    +     '<p class="hint">只在随机点名「按性别抽」时用到，可以不填。</p></div>'
    + '</div>'

    + '<div class="mb-form-grid">'
    +   '<div class="field"><label for="mbPol">政治面貌</label>'
    +     '<select id="mbPol">' + polOpts(isNew ? '群众' : m.politics) + '</select></div>'
    +   '<div class="field"><label>头衔（可多选）</label>'
    +     '<div id="mbTitleBox" class="rule-multi" style="max-height:118px;overflow:auto">'
    +       ((STATE.titles && STATE.titles.allowed && STATE.titles.allowed.length
              ? STATE.titles.allowed : TITLE_FALLBACK).map(function(t){
              return '<label class="chk"><input type="checkbox" class="mb-title" value="' + attr(t) + '"'
                + ((curTitles.indexOf(t) >= 0) ? ' checked' : '') + '> ' + esc(t) + '</label>';
            }).join(''))
    +     '</div>'
    +     '<p class="hint">和「头衔任命」是同一份数据，这里改完那边立刻同步。</p></div>'
    + '</div>'

    + '<div class="field"><label for="mbEx">智学网账号</label>'
    + '<input id="mbEx" class="inp" maxlength="24" value="' + attr(isNew ? '' : m.examNo) + '" placeholder="如 11399395">'
    + '<p class="hint">不属于隐私字段，同学查询时直接可见，不需要审核。</p></div>'

    /* 🔴 v3.5.21：身份证号 / 发展团员编号以前**只能靠导入**。
       extraColsOf() 为了防止「同一列传两遍」把它们排除了（v3.5.16），
       但编辑弹窗里又没补固定输入框 —— 结果这两项在后台无处可填，
       站主只能改 Excel 重新导入。这里补上，值走 data-xf → payload.extra，
       服务端 loadEditableFields() 本来就含这两列，会正常写回。 */
    + '<div class="mb-form-grid">'
    +   '<div class="field"><label for="mbIdCard">身份证号</label>'
    +     '<div class="fld-cp">'
    +       ruleInputHtml('id_card', ruleOf('id_card'), (!isNew && (m.extra || {}).id_card) || '', 'mbIdCard', '18 位身份证号')
    +       cpBtnHtml('id_card')
    +     '</div>'
    +     '<p class="hint">加密存储；前台是否可见由「字段管理」里的可见范围决定。</p></div>'
    +   '<div class="field"><label for="mbYln">发展团员编号</label>'
    +     '<div class="fld-cp">'
    +       ruleInputHtml('youth_league_no', ruleOf('youth_league_no'), (!isNew && (m.extra || {}).youth_league_no) || '', 'mbYln', '团员编号')
    +       cpBtnHtml('youth_league_no')
    +     '</div>'
    +     '<p class="hint">入团时间等自定义字段在下方「其他资料字段」里。</p></div>'
    + '</div>'

    + '<div class="field"><label>联系方式</label>'
    +   '<div class="ct-grid" style="gap:10px">'
    +     '<input id="mbWx" class="inp" maxlength="64" placeholder="微信号" value="' + attr(isNew ? '' : m.wechat) + '">'
    +     '<input id="mbQq" class="inp" maxlength="64" placeholder="QQ 号" value="' + attr(isNew ? '' : m.qq) + '">'
    +     '<input id="mbPh" class="inp" inputmode="numeric" maxlength="' + (ruleOf('phone').digits || 20) + '"'
    +       ' placeholder="手机号（' + (ruleOf('phone').digits || '') + ' 位数字）" value="' + attr(isNew ? '' : m.phone) + '">'
    +   '</div>'
    +   '<p class="hint">管理员在这里填的视为已核实，直接按下面的状态对外展示。</p></div>'

    + '<div class="field"><label for="mbCst">联系方式审核状态</label>'
    + '<select id="mbCst">'
    +   '<option value="none"' + (!isNew && m.contactStatus === 'none' ? ' selected' : '') + '>未填写 — 不对外展示</option>'
    +   '<option value="approved"' + ((isNew && !(m && m.contactStatus)) || (!isNew && m.contactStatus === 'approved') ? ' selected' : '') + '>已通过 — 同学查询时可见</option>'
    +   '<option value="pending"' + (!isNew && m.contactStatus === 'pending' ? ' selected' : '') + '>待审核 — 暂不展示</option>'
    +   '<option value="rejected"' + (!isNew && m.contactStatus === 'rejected' ? ' selected' : '') + '>已驳回 — 不展示</option>'
    + '</select></div>'

    /* 联系方式可见性（仅编辑已有档案时出现） */
    + (hasProfile
        ? (function(){
            var meta0 = STATE.members.fieldMeta || [];
            var adminTouched = function(field){
              var mm = meta0.find(function(x){ return x.field === field; });
              return mm ? !!mm.adminSet : false;
            };
            function note(field){
              if(vp0[field] !== false) return '';
              return adminTouched(field)
                ? '<span class="badge badge-purple" style="margin-left:6px" title="同学设过私密，但你在字段管理里改过该字段，以你为准">本人设过私密 · 已被你覆盖</span>'
                : '<span class="badge badge-orange" style="margin-left:6px" title="同学把这项设成了仅自己可见">本人已设为私密</span>';
            }
            return '<div class="field"><label>联系方式可见性（这个人）</label>'
            +   '<p class="hint" style="margin-bottom:8px">勾上 = 仅本人可见，同学查不到。'
            +     '<b>后台权力最大</b>：你在「字段管理」里改过的字段，以你的设置为准。</p>'
            +   '<label class="chk"><input type="checkbox" id="mbWxHide"' + (vp0.wechat === false ? ' checked' : '') + '> 微信号仅本人可见' + note('wechat') + '</label>'
            +   '<label class="chk"><input type="checkbox" id="mbQqHide"' + (vp0.qq === false ? ' checked' : '') + '> QQ 号仅本人可见' + note('qq') + '</label>'
            +   '<label class="chk"><input type="checkbox" id="mbPhHide"' + (vp0.phone === false ? ' checked' : '') + '> 手机号仅本人可见' + note('phone') + '</label>'
            + '</div>';
          })()
        : '')

    /* 其他资料字段（动态，2026-10-09 v2.4.0） */
    + (function(){
        var extras = extraColsOf();
        if(!extras.length) return '';
        var cur = (!isNew && m.extra) || {};
        var fv  = (!isNew && m.fieldVis) || {};
        return '<div class="field"><label>其他资料字段</label>'
          + '<p class="hint" style="margin-bottom:8px">「字段管理」里登记的字段。可见范围默认跟随全班，也可只给这一个人单独调整。</p>'
          +           extras.map(function(f){
              var val = cur[f.field] || '';
              var curFv = fv[f.field] || '';
              var gv = (function(){
                var mm = (STATE.members.fieldMeta || []).find(function(x){ return x.field === f.field; });
                return mm ? mm.visibility : 'public';
              })();
              /* v3.5.5：按字段规则渲染控件 —— select 出下拉、time 出日期
                 选择器、number 出数字键盘 + 限长、text 按 maxLen 限长。
                 禁自由输入的下拉连输入框都不给。 */
              return '<div class="extra-row">'
                + '<label class="extra-lab" for="mbX_' + attr(f.field) + '">' + esc(f.label) + '</label>'
                + ruleInputHtml(f.field, f.rules, val, 'mbX_' + attr(f.field), f.label)
                + cpBtnHtml(f.field)
                + '<select class="inp extra-vis" data-vf="' + attr(f.field) + '" title="只对这个人生效的可见范围">'
                +   '<option value=""' + (curFv ? '' : ' selected') + '>跟随全班（' + esc(VIS_LABEL[gv] || gv) + '）</option>'
                +   '<option value="public"' + (curFv === 'public' ? ' selected' : '') + '>公开</option>'
                +   '<option value="committee"' + (curFv === 'committee' ? ' selected' : '') + '>班委可见</option>'
                +   '<option value="self"' + (curFv === 'self' ? ' selected' : '') + '>仅本人</option>'
                +   '<option value="admin"' + (curFv === 'admin' ? ' selected' : '') + '>仅后端可见</option>'
                + '</select>'
                + '</div>';
            }).join('')
          + '</div>';
      })()
    + '<div class="msg" id="mbMsg"></div>'
    + '</div>';

  openModal({
    title: isNew ? '新增成员' : ('编辑成员：' + memberName(m)),
    sub: isNew ? '一张表单同时建账号与档案' : '同一张表单管理账号与班级档案，保存时两处自动同步',
    wide: true,
    body: accountSec + profileSec,
    foot: '<button class="btn btn-ghost" data-no>取消</button><button class="btn" data-yes>'
      + (isNew ? '创建' : '保存') + '</button>',
    onMount: function(box){
      var msg = box.querySelector('#mbMsg');
      /* v3.5.5：多选字段的复选框组 → 隐藏输入同步（值仍是逗号分隔文本） */
      Array.prototype.forEach.call(extraColsOf(), function(f){
        if(f.rules && f.rules.type === 'select' && f.rules.multi){
          bindRuleMulti(box, 'mbX_' + f.field);
        }
      });
      box.querySelector('[data-no]').onclick = closeModal;
      box.querySelector('[data-yes]').onclick = function(){
        var btn = this;
        var openAcc = box.querySelector('#mbOpen');
        var willCreateAccount = isNew || (openAcc && openAcc.checked);

        /* 档案段是否有实质内容 */
        var g = function(id){ var el = box.querySelector(id); return el ? el.value.trim() : ''; };
        var nameV = g('#mbName');
        /* v3.5.22：档案段现在「全字段可编辑」—— 身份、头衔也算实质内容 */
        var titleVals = [];
        Array.prototype.forEach.call(box.querySelectorAll('input.mb-title'), function(c){
          if(c.checked) titleVals.push(c.value);
        });
        var hasProfileData = nameV || g('#mbSid') || g('#mbEx') || g('#mbWx') || g('#mbQq') || g('#mbPh')
          || titleVals.length;

        var payload = {
          userId:    hasUser ? m.userId : 0,
          profileId: hasProfile ? m.profileId : 0,
          createAccount: willCreateAccount && !hasUser,
          role:      box.querySelector('#mbRole').value,
          status:    hasUser ? box.querySelector('#mbStatus').value : 'active',
          /* 档案段 */
          name: nameV,
          studentId: g('#mbSid'),
          gender:    g('#mbGender'),
          politics:  box.querySelector('#mbPol').value,
          examNo:    g('#mbEx'),
          /* v3.5.22：身份与头衔都进档案段（以前只能去「头衔任命」单独改） */
          identity:  g('#mbIdentity') || '学生',
          title:     titleVals,
          wechat:    g('#mbWx'),
          qq:        g('#mbQq'),
          phone:     g('#mbPh'),
          contactStatus: box.querySelector('#mbCst').value,
        };

        /* 账号段校验（新建 / 开号时用户名+密码必填） */
        if(payload.createAccount){
          payload.username = g('#mbUser');
          payload.password = box.querySelector('#mbPwd').value;
          if(!payload.username){ msg.className = 'msg err show'; msg.textContent = '请填写用户名'; return; }
          if(!payload.password){ msg.className = 'msg err show'; msg.textContent = '请填写初始密码'; return; }
        }

        /* 没有任何可保存内容时挡住（比如空表单直接点保存） */
        if(!payload.userId && !payload.profileId && !payload.createAccount && !hasProfileData){
          msg.className = 'msg err show';
          msg.textContent = '请至少填写一项：账号信息或档案信息';
          return;
        }

        /* 可见性：仅编辑已有档案时带（adminSet 语义见 upsertProfileCore） */
        if(hasProfile){
          var wxH = box.querySelector('#mbWxHide');
          if(wxH){
            payload.visibilityPref = {
              wechat: !wxH.checked,
              qq:     !box.querySelector('#mbQqHide').checked,
              phone:  !box.querySelector('#mbPhHide').checked,
            };
          }
          var fvVals = {};
          Array.prototype.forEach.call(box.querySelectorAll('[data-vf]'), function(sel){
            if(sel.value) fvVals[sel.dataset.vf] = sel.value;
          });
          payload.fieldVis = fvVals;
        }
        /* 额外字段值（新增时也允许带，默认都是「跟随全班」） */
        var extraVals = {};
        Array.prototype.forEach.call(box.querySelectorAll('[data-xf]'), function(inp){
          extraVals[inp.dataset.xf] = inp.value.trim();
        });
        payload.extra = extraVals;

        btn.disabled = true;
        api('/admin?action=save-member', { method:'POST', body: payload }).then(function(j){
          closeModal();
          toast(j.message || '已保存', 'ok', 3800);
          loadMembers();
        }).catch(function(e){
          msg.className = 'msg err show';
          msg.textContent = e.message;
          btn.disabled = false;
        });
      };
      setTimeout(function(){
        var first = box.querySelector(isNew ? '#mbUser' : '#mbName');
        if(first) first.focus();
      }, 80);
    }
  });
}

/* ---------------- 用户详情（含登录记录） ---------------- */
/**
 * v3.5.12 成员详情（站主 2026-10-17 #2）
 * 「成员档案只展示联系方式，其他的通过详情查看」
 *
 * 列表瘦身成「姓名 + 联系方式」之后，其余信息全在这里：
 *   顶部四格速览（场景 / 审核 / 上线 / 云端数据）
 *   ① 班级档案：学号、身份、头衔、政治面貌、智学网账号 + 所有自定义字段
 *   ② 联系方式：微信 / QQ / 手机 + 本人私密意愿 + 管理员单人可见性设置
 *   ③ 账号信息：角色、状态、创建、最后上线/登录、在线会话
 *   ④ 登录记录（有账号才拉）
 * 未认领的档案行（profileId 有、userId 无）也能打开，只是账号区显示「无账号」。
 */
function memberDetailDialog(m){
  if(!m) return;
  var hasUser = m.userId != null;

  function kvRow(dt, dd){
    return '<dt>' + esc(dt) + '</dt><dd>' + dd + '</dd>';
  }
  function v(x){
    return (x === 0 || x) && String(x).trim() !== ''
      ? esc(x) : '<span class="muted">—</span>';
  }

  var sc = MEMBER_SCENE[m.scene] || MEMBER_SCENE.both;
  var cst = CONTACT_LABEL[m.contactStatus] || CONTACT_LABEL.none;

  var head = '<div class="stat-grid" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr));margin-bottom:18px">'
    + statMini('场景', sc.text)
    + statMini('审核', cst.text)
    + statMini('最后上线', hasUser
        ? (isOnlineNow(m) ? '在线中' : (m.sessionLastSeen || m.lastSeenAt
            ? ago(m.sessionLastSeen || m.lastSeenAt) : (m.lastLoginAt ? ago(m.lastLoginAt) : '从未')))
        : '—')
    + statMini('云端数据', hasUser ? ((m.dataCount || 0) + ' 条') : '—')
    + '</div>';

  /* ① 班级档案 */
  var meta = STATE.members.fieldMeta || [];
  var FIXED = ['name', 'student_id', 'politics', 'exam_no', 'role', 'title', 'wechat', 'qq', 'phone'];
  var extraFields = meta.filter(function(f){ return FIXED.indexOf(f.field) < 0; });

  var extraRows = extraFields.map(function(f){
    var x = (m.extra || {})[f.field];
    return kvRow(f.label || f.field, v(x) + cpv(x, f.label || f.field));
  }).join('');

  var archive = m.profileId == null
    ? '<div class="panel" style="margin-bottom:18px"><div class="panel-head"><h3>' + svg('file') + '班级档案</h3></div>'
      + '<div class="panel-body"><p class="muted" style="margin:0;font-size:.85rem">'
      + '这位同学<b>还没有班级档案</b>。点「编辑」可以在同一个表单里补上学号、身份、联系方式。</p></div></div>'
    : '<div class="panel" style="margin-bottom:18px">'
      + '<div class="panel-head"><div><h3>' + svg('file') + '班级档案</h3>'
      +   '<p class="sub">' + esc(m.name || '(未命名)') + ' 的档案字段 · 每项可单独复制</p></div></div>'
      + '<div class="panel-body"><dl class="kv">'
      +   kvRow('姓名', v(m.name) + cpv(m.name, '姓名'))
      +   kvRow('学号', v(m.studentId) + cpv(m.studentId, '学号'))
      +   kvRow('身份', v(m.identity || m.role) + cpv(m.identity || m.role, '身份'))
      +   kvRow('头衔', v((m.titles && m.titles.length) ? m.titles.join('、') : m.title)
              + cpv((m.titles && m.titles.length) ? m.titles.join('、') : m.title, '头衔'))
      +   kvRow('政治面貌', v(m.politics) + cpv(m.politics, '政治面貌'))
      +   kvRow('智学网账号', v(m.examNo) + cpv(m.examNo, '智学网账号'))
      +   extraRows
      + '</dl></div></div>';

  /* ② 联系方式 + 可见性 */
  var vp = m.visibilityPref || {};
  var hidden = [];
  if(vp.wechat === false) hidden.push('微信');
  if(vp.qq === false) hidden.push('QQ');
  if(vp.phone === false) hidden.push('手机');

  var fv = m.fieldVis || {};
  var fvKeys = Object.keys(fv);
  var fvLabelOf = function(k){
    var mm = meta.find(function(x){ return x.field === k; });
    return mm ? mm.label : k;
  };

  var visTxt;
  if(fvKeys.length){
    visTxt = '<span class="badge badge-purple">⚙ 管理员单独设置：'
      + esc(fvKeys.map(fvLabelOf).join('/')) + '</span>';
  } else if(hidden.length){
    visTxt = '<span class="badge badge-orange">🔒 本人设私密：' + esc(hidden.join('/')) + '</span>';
  } else {
    visTxt = '<span class="badge badge-gray">全部公开</span>';
  }

  var contact = '<div class="panel" style="margin-bottom:18px">'
    + '<div class="panel-head"><div><h3>' + svg('user') + '联系方式</h3>'
    +   '<p class="sub">同学之间互相查到的是这三项</p></div></div>'
    + '<div class="panel-body"><dl class="kv">'
    +   kvRow('微信', v(m.wechat) + cpv(m.wechat, '微信'))
    +   kvRow('QQ', v(m.qq) + cpv(m.qq, 'QQ'))
    +   kvRow('手机', v(m.phone) + cpv(m.phone, '手机'))
    +   kvRow('可见性', visTxt)
    +   kvRow('审核状态', '<span class="badge ' + cst.cls + '">' + cst.text + '</span>'
        + (m.rejectReason ? '<div class="muted" style="font-size:.74rem;margin-top:3px">驳回理由：' + esc(m.rejectReason) + '</div>' : ''))
    + '</dl></div></div>';

  /* ③ 账号信息 */
  var account = !hasUser
    ? '<div class="panel" style="margin-bottom:18px"><div class="panel-head"><h3>' + svg('shield') + '系统账号</h3></div>'
      + '<div class="panel-body"><p class="muted" style="margin:0;font-size:.85rem">'
      + '这条记录只有档案，<b>还没有绑定登录账号</b>（同学自己注册后会自动认领，或点「新增成员」直接建号）。</p></div></div>'
    : '<div class="panel" style="margin-bottom:18px">'
      + '<div class="panel-head"><h3>' + svg('shield') + '系统账号</h3></div>'
      + '<div class="panel-body"><dl class="kv">'
      +   kvRow('用户名', '<span class="mono">' + esc(m.username || '—') + '</span>')
      +   kvRow('显示名', v(m.displayName))
      +   kvRow('角色', m.role === 'admin'
            ? '<span class="badge badge-orange">管理员</span>' : '普通用户')
      +   kvRow('状态', m.status === 'banned'
            ? '<span class="badge badge-red">已禁用</span>'
            : (m.status === 'pending'
                ? '<span class="badge badge-amber">待审核</span>'
                : '<span class="badge badge-green">正常</span>')
            + (m.mustChangePassword ? ' <span class="badge badge-amber">待改密</span>' : ''))
      +   kvRow('注册时间', v(m.createdAt ? fmt(m.createdAt) : ''))
      +   kvRow('最后上线', m.sessionLastSeen || m.lastSeenAt
            ? esc(fmt(m.sessionLastSeen || m.lastSeenAt)) + ' <span class="muted">（' + esc(ago(m.sessionLastSeen || m.lastSeenAt)) + '）</span>'
            : '<span class="muted">未记录</span>')
      +   kvRow('最后登录', m.lastLoginAt
            ? esc(fmt(m.lastLoginAt)) + ' <span class="muted">（' + esc(ago(m.lastLoginAt)) + '）</span>'
            : '<span class="muted">从未登录</span>')
      +   kvRow('在线会话', (m.onlineSessions || 0) + ' 个'
            + (isOnlineNow(m) ? ' <span class="badge badge-green">在线</span>' : ''))
      + '</dl></div></div>';

  /* ④ 登录记录（有账号才拉） */
  var loginBox = hasUser
    ? '<div class="panel"><div class="panel-head"><div><h3>' + svg('clock') + '最近登录</h3>'
      + '<p class="sub">最近 15 次</p></div>'
      + '<button class="btn btn-sm btn-ghost" id="mdMore" style="margin-left:auto">完整用户详情</button></div>'
      + '<div id="mdLogins"><div class="loading" style="padding:22px"><div class="spinner"></div></div></div></div>'
    : '';

  openModal({
    title: '成员详情 · ' + (memberName(m) || ''),
    sub: (hasUser ? '@' + m.username : '未认领') + (m.studentId ? ' · 学号 ' + m.studentId : ''),
    wide: true,
    body: head + archive + contact + account + loginBox,
    foot: '<button class="btn btn-ghost" data-no>关闭</button>'
      + '<button class="btn" data-edit>编辑这位成员</button>',
    onMount: function(box){
      var eb = box.querySelector('[data-edit]');
      if(eb) eb.onclick = function(){ closeModal(); memberDialog(m); };

      if(hasUser){
        var more = box.querySelector('#mdMore');
        if(more) more.onclick = function(){ closeModal(); userDetailDialog(m.userId); };

        api('/admin?action=login-logs&id=' + m.userId + '&limit=15').then(function(lj){
          var logs = lj.logs || [];
          var el = box.querySelector('#mdLogins');
          if(!el) return;
          el.innerHTML = logs.length
            ? '<div class="table-wrap"><table><thead><tr><th>时间</th><th>IP</th><th>设备</th></tr></thead><tbody>'
              + logs.map(function(l){
                  return '<tr><td class="nowrap">' + esc(fmt(l.createdAt)) + '</td>'
                    + '<td class="nowrap mono">' + esc(l.ip || '—') + '</td>'
                    + '<td class="muted" style="font-size:.75rem;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + attr(l.userAgent || '') + '">'
                    + esc(shortUA(l.userAgent)) + '</td></tr>';
                }).join('')
              + '</tbody></table></div>'
            : '<div class="empty" style="padding:24px"><p class="muted">暂无登录记录</p></div>';
        }).catch(function(e){
          var el = box.querySelector('#mdLogins');
          if(el) el.innerHTML = '<p class="muted" style="padding:18px;margin:0">读取失败：' + esc(e.message) + '</p>';
        });
      }
    },
  });
}

function userDetailDialog(id){
  openModal({
    title: '用户详情',
    wide: true,
    body: '<div class="loading"><div class="spinner"></div>加载中…</div>',
    onMount: function(box){
      api('/admin?action=user&id=' + id).then(function(j){
        var u = j.user || {};
        var data = j.data || [];
        var sess = j.sessions || [];

        var head =
          '<div class="stat-grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr));margin-bottom:20px">'
          + statMini('账号', u.username)
          + statMini('角色', u.role === 'admin' ? '管理员' : '普通用户')
          + statMini('状态', u.status === 'banned' ? '已禁用' : '正常')
          + statMini('云端数据', data.length + ' 条')
          + '</div>';

        var meta =
          '<div class="panel" style="margin-bottom:18px"><div class="panel-head"><h3>' + svg('user') + '基本信息</h3></div>'
          + '<div class="panel-body"><dl class="kv">'
          + '<dt>显示名</dt><dd>' + esc(u.displayName || '—') + '</dd>'
          + '<dt>创建时间</dt><dd>' + esc(fmt(u.createdAt)) + '</dd>'
          + '<dt>最后上线</dt><dd>' + (u.lastSeenAt
              ? esc(fmt(u.lastSeenAt) + '（' + ago(u.lastSeenAt) + '）') + (isOnlineNow(u) ? ' <span class="badge badge-green">在线</span>' : '')
              : '<span class="muted">未记录</span>') + '</dd>'
          + '<dt>最后登录</dt><dd>' + esc(u.lastLoginAt ? fmt(u.lastLoginAt) + '（' + ago(u.lastLoginAt) + '）' : '从未登录') + '</dd>'
          + '<dt>在线会话</dt><dd>' + sess.length + ' 个' + (sess.length ? '（最近：' + esc(fmt(sess[0].createdAt)) + '）' : '') + '</dd>'
          + '</dl></div></div>';

        var loginBox = '<div class="panel" style="margin-bottom:18px">'
          + '<div class="panel-head"><div><h3>' + svg('clock') + '登录记录</h3>'
          + '<p class="sub">该用户的最近登录历史</p></div></div>'
          + '<div id="udLogins"><div class="loading" style="padding:26px"><div class="spinner"></div></div></div></div>';

        /* v2.10.1 需求⑬：管理员可「选择性删除」（每行一个删除按钮）
           也可「批量删除」（面板右上角清空全部）。 */
        var dataBox = '<div class="panel"><div class="panel-head"><h3>' + svg('database') + '云端数据</h3>'
          + (data.length
              ? '<button class="btn btn-sm btn-ghost" id="udDelAll" style="margin-left:auto;color:var(--danger)">清空全部</button>'
              : '')
          + '</div>'
          + '<div class="panel-body">' + (data.length
              ? '<div class="table-wrap"><table><thead><tr><th class="nowrap">分类</th><th>数据</th><th class="nowrap">更新时间</th><th style="text-align:right">操作</th></tr></thead><tbody>'
                + data.map(function(d){
                    /* #178：中文名 + 键名小字。label 与键名相同时（未归类键）
                       只显示键名，不重复一遍。 */
                    var showKey = (d.label && d.label !== d.key)
                      ? esc(d.label) + ' <span class="mono muted" style="font-size:.72rem">' + esc(d.key) + '</span>'
                      : '<span class="mono">' + esc(d.key) + '</span>';
                    return '<tr><td class="nowrap">' + esc(d.catLabel || '—') + '</td>'
                      + '<td>' + showKey + '</td>'
                      + '<td class="nowrap muted">' + esc(fmt(d.updatedAt)) + '</td>'
                      + '<td style="text-align:right"><div class="row-actions">'
                      + '<button data-view-key="' + attr(d.key) + '">查看</button>'
                      + '<button class="danger" data-del-key="' + attr(d.key) + '">删除</button>'
                      + '</div></td></tr>';
                  }).join('')
                + '</tbody></table></div>'
              : '<p class="muted" style="margin:0;font-size:.85rem">该用户还没有云端数据</p>')
          + '</div></div>';

        box.querySelector('.modal-body').innerHTML = head + meta + loginBox + dataBox;

        /* 加载登录记录 */
        api('/admin?action=login-logs&id=' + id + '&limit=20').then(function(lj){
          var logs = lj.logs || [];
          var el = box.querySelector('#udLogins');
          if(!el) return;
          el.innerHTML = logs.length
            ? '<div class="table-wrap"><table><thead><tr><th>时间</th><th>IP</th><th>设备</th></tr></thead><tbody>'
              + logs.map(function(l){
                  return '<tr><td class="nowrap">' + esc(fmt(l.createdAt)) + '</td>'
                    + '<td class="nowrap mono">' + esc(l.ip || '—') + '</td>'
                    + '<td class="muted" style="font-size:.75rem;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + attr(l.userAgent || '') + '">'
                    + esc(shortUA(l.userAgent)) + '</td></tr>';
                }).join('')
              + '</tbody></table></div>'
              + (lj.total > 20 ? '<p class="muted" style="padding:11px 14px 0;font-size:.76rem">共 ' + lj.total + ' 条，仅显示最近 20 条</p>' : '')
            : '<div class="empty" style="padding:30px"><p class="muted">暂无登录记录</p></div>';
        }).catch(function(){
          var el2 = box.querySelector('#udLogins');
          if(el2) el2.innerHTML = '<div class="alert danger" style="margin:16px">登录记录加载失败（可能未建 login_log 表）</div>';
        });

        /* 数据键操作 */
        Array.prototype.forEach.call(box.querySelectorAll('[data-view-key]'), function(b){
          b.onclick = function(){
            var k = b.dataset.viewKey;
            var item = data.find(function(d){ return d.key === k; });
            openModal({
              title: '数据详情',
              sub: k,
              wide: true,
              body: '<pre style="margin:0;padding:14px;background:var(--bg-2);border-radius:var(--radius-md);'
                  + 'font-size:.76rem;max-height:420px;overflow:auto;white-space:pre-wrap;word-break:break-all">'
                  + esc(JSON.stringify(item ? item.value : null, null, 2)) + '</pre>',
              foot: '<button class="btn btn-ghost" data-close3>关闭</button>',
              onMount: function(b2){ b2.querySelector('[data-close3]').onclick = closeModal; }
            });
          };
        });
        Array.prototype.forEach.call(box.querySelectorAll('[data-del-key]'), function(b){
          b.onclick = function(){
            var k = b.dataset.delKey;
            confirmBox({ title:'删除数据', text:'确定删除键「' + k + '」吗？此操作不可恢复。', danger:true, okText:'删除' })
              .then(function(yes){
                if(!yes) return;
                api('/admin?action=delete-data', { method:'POST', body:{ userId:id, key:k } })
                  .then(function(){ toast('已删除', 'ok'); userDetailDialog(id); })
                  .catch(function(e){ toast(e.message, 'err'); });
              });
          };
        });
        /* 批量删除：清空该用户全部云端数据（需求⑬） */
        var delAllBtn = box.querySelector('#udDelAll');
        if(delAllBtn){
          delAllBtn.onclick = function(){
            confirmBox({
              title: '清空全部云端数据',
              text: '会删除这位同学在云端的全部 ' + data.length + ' 条数据（点歌记录、作业标记、界面设置等），不可恢复。\n\n只想删某几条的话，请用每行右侧的「删除」。',
              danger: true, okText: '清空全部'
            }).then(function(yes){
              if(!yes) return;
              api('/admin?action=delete-data', { method: 'POST', body: { userId: id, all: true } })
                .then(function(j){
                  toast('已清空 ' + (j.deleted || 0) + ' 条云端数据', 'ok');
                  userDetailDialog(id);   /* 重新拉一次，列表与条数一起刷新 */
                })
                .catch(function(e){ toast(e.message, 'err'); });
            });
          };
        }
      }).catch(function(e){
        box.querySelector('.modal-body').innerHTML = '<div class="alert danger">加载失败：' + esc(e.message) + '</div>';
      });
    }
  });
}

function statMini(label, value){
  return '<div class="stat" style="padding:14px;box-shadow:none">'
    + '<p class="label" style="font-size:.72rem">' + esc(label) + '</p>'
    + '<h3 class="value" style="font-size:1.15rem;margin-top:3px">' + esc(value) + '</h3></div>';
}

/** UA 精简显示："Chrome · Windows" 这种 */
function shortUA(ua){
  if(!ua) return '—';
  var s = String(ua), out = [];
  if(/MicroMessenger/i.test(s)) out.push('微信');
  else if(/Edg\//.test(s)) out.push('Edge');
  else if(/Chrome\//.test(s) && !/Chromium/.test(s)) out.push('Chrome');
  else if(/Firefox\//.test(s)) out.push('Firefox');
  else if(/Safari\//.test(s)) out.push('Safari');
  if(/Windows NT/.test(s)) out.push('Windows');
  else if(/Macintosh/.test(s)) out.push('macOS');
  else if(/Android/.test(s)) out.push('Android');
  else if(/iPhone|iPad/.test(s)) out.push('iOS');
  else if(/Linux/.test(s)) out.push('Linux');
  return out.length ? out.join(' · ') : s.slice(0, 40);
}

/* ============================================================================
 * ⑧ Excel 导入（对标 VoiceHub：三源 CDN + 标题行检测 + 预览 + 分批进度）
 * ========================================================================= */
var _xlsxLoading = null;
function loadXLSX(){
  if(window.XLSX) return Promise.resolve(window.XLSX);
  if(_xlsxLoading) return _xlsxLoading;

  /* v3.5.3：本地内置优先。解析库（SheetJS 0.18.5）跟着仓库一起发布到
     Pages（vendor/xlsx.full.min.js，881KB），同源永远可达；三个 CDN
     只作兜底——国内访问 jsdelivr/unpkg/cdnjs 时常抽风，以前「直接选文件
     就报 XLSX is not defined」一半原因就是库还在路上、根本没加载。
     ⚠️ 以后升级 SheetJS：换 vendor/ 里的文件 + 下面 URL 的版本号一起改。 */
  var urls = [
    'vendor/xlsx.full.min.js',
    'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
    'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
  ];

  _xlsxLoading = new Promise(function(resolve){
    var i = 0;
    (function next(){
      if(i >= urls.length){ resolve(null); return; }
      var url = urls[i++];
      var s = document.createElement('script');
      s.src = url;
      s.async = true;
      /* onload 后没拿到 window.XLSX（本地文件缺失/被墙的 CDN 返回空壳）
         不能就此 resolve(null——继续试下一个源，这条链才真的是兜底链。 */
      s.onload = function(){ if(window.XLSX) resolve(window.XLSX); else next(); };
      s.onerror = function(){ s.remove(); next(); };
      document.head.appendChild(s);
    })();
  });
  return _xlsxLoading;
}

/** 导入模板表头（与大表保持一致，方便老师/同学照抄） */
var IMPORT_HEADERS = ['用户名', '密码', '姓名', '角色'];

function importDialog(){
  var parsed = [];        /* 解析出的待导入数据 */
  var headerSkipped = false;

  openModal({
    title: 'Excel 批量导入用户',
    wide: true,
    sub: '支持 .xlsx / .xls，自动识别标题行',
    body:
      '<div class="alert info">'
      + '<b>格式说明：</b>第 1 列 <b>用户名</b>，第 2 列 <b>密码</b>，第 3 列 <b>姓名</b>（选填），第 4 列 <b>角色</b>（选填，填 admin 才是管理员）。<br>'
      + '第一行如果是「用户名 / 密码 / 姓名 / 角色」这类标题，会自动跳过；没有标题行也能识别。'
      + '</div>'

      + '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">'
      +   '<button class="btn btn-sm btn-secondary" id="imTpl">' + svg('download', 14) + '下载模板</button>'
      +   '<label class="btn btn-sm" style="cursor:pointer">' + svg('upload', 14) + '选择 Excel 文件'
      +     '<input type="file" id="imFile" accept=".xlsx,.xls" style="display:none"></label>'
      + '</div>'

      + '<div id="imBody"><p class="muted" style="font-size:.85rem;margin:0">还没有选择文件。</p></div>'
      + '<div id="imProgWrap" style="display:none"><div class="progress-bar"><i id="imProg"></i></div>'
      + '<p id="imProgTxt" style="font-size:.78rem;color:var(--fg-3);margin:0"></p></div>'
      + '<div id="imErr" style="margin-top:14px"></div>'
      + '<div class="msg" id="imMsg"></div>',
    foot:
      '<button class="btn btn-ghost" data-close4>取消</button>'
      + '<button class="btn" id="imGo" disabled>开始导入</button>',
    onMount: function(box){
      box.querySelector('[data-close4]').onclick = closeModal;
      var fileInput = box.querySelector('#imFile');
      var body = box.querySelector('#imBody');
      var goBtn = box.querySelector('#imGo');
      var msg = box.querySelector('#imMsg');

      /* 下载模板 */
      box.querySelector('#imTpl').onclick = function(){
        loadXLSX().then(function(XLSX){
          if(!XLSX){ toast('模板库加载失败，请检查网络', 'err', 4200); return; }
          var ws = XLSX.utils.json_to_sheet([
            { 用户名:'zhangsan', 密码:'Class2025', 姓名:'张三', 角色:'user' }
          ]);
          ws['!cols'] = [{ wch:14 }, { wch:14 }, { wch:12 }, { wch:10 }];
          var wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, '用户导入');
          XLSX.writeFile(wb, '用户导入模板.xlsx');
          toast('模板已下载', 'ok');
        });
      };

      /* 选择文件 → 解析 */
      fileInput.onchange = function(ev){
        var f = ev.target.files && ev.target.files[0];
        if(!f) return;
        msg.className = 'msg';
        body.innerHTML = '<div class="loading"><div class="spinner"></div>加载表格组件…</div>';

        loadXLSX().then(function(XLSX){
          if(!XLSX){
            body.innerHTML = '<div class="alert danger">表格组件加载失败（三个 CDN 都不可达）。请检查网络后重试。</div>';
            return;
          }
          var reader = new FileReader();
          reader.onload = function(e){
            try{
              var wb = XLSX.read(new Uint8Array(e.target.result), { type:'array' });
              var sheet = wb.Sheets[wb.SheetNames[0]];
              var aoa = XLSX.utils.sheet_to_json(sheet, { header:1, defval:'' });

              /* 智能检测标题行 */
              var start = 0;
              if(aoa.length && aoa[0] && aoa[0].length){
                var kw = ['用户名','密码','姓名','角色','username','password','name','role','账号','用户'];
                var hit = aoa[0].some(function(cell){
                  if(cell === null || cell === undefined || cell === '') return false;
                  var t = String(cell).toLowerCase();
                  return kw.some(function(k){ return t.indexOf(k.toLowerCase()) >= 0; });
                });
                if(hit) start = 1;
              }
              headerSkipped = start === 1;

              var out = [];
              var skippedEmpty = 0;
              for(var i = start; i < aoa.length; i++){
                var row = aoa[i] || [];
                var username = String(row[0] === null || row[0] === undefined ? '' : row[0]).trim();
                /* 整行为空则跳过 */
                if(!username && !String(row[1] || '').trim()){ skippedEmpty++; continue; }
                out.push({
                  username: username,
                  password: String(row[1] === null || row[1] === undefined ? '' : row[1]),
                  displayName: String(row[2] === null || row[2] === undefined ? '' : row[2]).trim(),
                  role: String(row[3] || '').trim().toLowerCase() === 'admin' ? 'admin' : 'user'
                });
              }

              parsed = out;
              if(!out.length){
                body.innerHTML = '<div class="alert warn">没有解析到有效数据。请确认第 1 列是用户名、第 2 列是密码。</div>';
                goBtn.disabled = true;
                return;
              }

              /* 预览前 8 行 */
              var prev = out.slice(0, 8);
              body.innerHTML =
                '<div class="alert info" style="margin-bottom:12px">'
                + '共解析出 <b>' + out.length + '</b> 条记录'
                + (headerSkipped ? '，已自动跳过标题行' : '（未检测到标题行，从第一行开始）')
                + (skippedEmpty ? '，忽略 ' + skippedEmpty + ' 个空行' : '')
                + '</div>'
                + '<div class="preview-table"><table><thead><tr>'
                + '<th style="width:44px">#</th><th>用户名</th><th>密码</th><th>姓名</th><th>角色</th>'
                + '</tr></thead><tbody>'
                + prev.map(function(r, i){
                    return '<tr><td class="muted">' + (i + 1) + '</td>'
                      + '<td class="mono"><b>' + esc(r.username) + '</b></td>'
                      + '<td class="mono muted">' + esc(r.password ? '•'.repeat(Math.min(r.password.length, 10)) : '（空）') + '</td>'
                      + '<td>' + esc(r.displayName || '—') + '</td>'
                      + '<td>' + (r.role === 'admin' ? '<span class="badge badge-orange">管理员</span>' : '<span class="badge badge-gray">普通</span>') + '</td>'
                      + '</tr>';
                  }).join('')
                + '</tbody></table></div>'
                + (out.length > 8
                    ? '<p class="muted" style="font-size:.78rem;margin:9px 0 0">…… 还有 ' + (out.length - 8) + ' 条记录，导入时会一并处理</p>'
                    : '');
              goBtn.disabled = false;
            }catch(err){
              console.error(err);
              body.innerHTML = '<div class="alert danger">解析失败：' + esc(err.message || '文件格式不正确') + '</div>';
              goBtn.disabled = true;
            }
          };
          reader.onerror = function(){ body.innerHTML = '<div class="alert danger">读取文件失败</div>'; };
          reader.readAsArrayBuffer(f);
        });
      };

      /* 开始导入：分批 50 条，逐批显示进度 */
      goBtn.onclick = function(){
        if(!parsed.length) return;
        goBtn.disabled = true;
        msg.className = 'msg';

        var BATCH = 50;
        var total = parsed.length;
        var batches = [];
        for(var i = 0; i < total; i += BATCH) batches.push(parsed.slice(i, i + BATCH));

        var progWrap = box.querySelector('#imProgWrap');
        var prog = box.querySelector('#imProg');
        var progTxt = box.querySelector('#imProgTxt');
        var errBox = box.querySelector('#imErr');
        progWrap.style.display = 'block';
        errBox.innerHTML = '';

        var created = 0, failed = 0, allErrors = [], bi = 0;
        body.innerHTML = '<div class="alert info">正在导入，请不要关闭本窗口…</div>';

        (function nextBatch(){
          if(bi >= batches.length){
            /* 完成 */
            prog.style.width = '100%';
            progTxt.textContent = '导入完成：成功 ' + created + ' 个' + (failed ? '，失败 ' + failed + ' 个' : '');
            goBtn.disabled = true;
            goBtn.textContent = '已完成';
            toast('导入完成：成功 ' + created + ' 个' + (failed ? '，失败 ' + failed + ' 个' : ''), failed ? 'warn' : 'ok', 4500);
            if(allErrors.length){
              errBox.innerHTML = '<p style="font-size:.8rem;font-weight:700;color:var(--danger);margin:0 0 7px">失败明细</p>'
                + '<div class="err-list">' + allErrors.map(esc).join('\n') + '</div>';
            }
            loadMembers();
            return;
          }
          var batch = batches[bi];
          var offset = bi * BATCH;
          progTxt.textContent = '正在处理第 ' + (bi + 1) + ' / ' + batches.length + ' 批（' + Math.min(offset + BATCH, total) + ' / ' + total + '）…';

          api('/admin?action=batch-create', { method:'POST', body:{ users: batch } })
            .then(function(j){
              created += j.created || 0;
              failed  += j.failed  || 0;
              (j.errors || []).forEach(function(e){
                /* 换算回 Excel 真实行号：批内下标 + 批偏移 + 标题行偏移 + 1（表格从 1 开始） */
                var excelRow = offset + (e.index || 0) + (headerSkipped ? 1 : 0) + 1;
                allErrors.push('第 ' + excelRow + ' 行' + (e.username ? '（' + e.username + '）' : '') + '：' + e.reason);
              });
            })
            .catch(function(e){
              failed += batch.length;
              allErrors.push('第 ' + (bi + 1) + ' 批整体失败：' + e.message);
            })
            .then(function(){
              bi++;
              prog.style.width = Math.round(bi / batches.length * 100) + '%';
              setTimeout(nextBatch, 60);
            });
        })();
      };
    }
  });
}

/* ============================================================================
 * ⑩ 云端内容的读写底座（公告 + 内容共用）
 * ========================================================================= */
/* 公告/内容在云端的存储方式：存在「系统账号」（优先 AI 助手，其次最早的管理员）
   的 user_data 里，后端接口是 /api/content。

   ⚠️ 2026-10-05 重要修正：
   旧版这里走的是 /api/admin?action=set-data，把内容写进**当前登录管理员自己**的
   user_data；而主站 index.html 读的是 /api/content —— 那个接口当时根本不存在（404），
   前端 .catch 静默吞掉，于是公告一直显示硬编码内容。
   也就是说「管理员改公告 → 同学能看到」从来没生效过。
   现在改为统一走 /api/content，两端终于接上了。

   ⚠️ 2026-10-06：原先的 loadSiteData / saveSiteData 双入口已删除——
   公告与内容合并成「班级内容」面板后，读写统一走
   loadClassContent() / saveClassContent()（见下方 ⑩-A）。 */

/* 已下架的内容类型：旧的「通知」条目不再显示（公告才是正式通知渠道）。
   注意只是不显示，云端数据没删——万一哪天要恢复还能捞回来。 */
var CONTENT_RETIRED_KINDS = ['通知'];

/* 内容面板的条目 ↔ 云端 items 字段名 的双向映射。
   面板里每条是 {kind, title, body}，云端按 kind 归到不同字段。

   ⚠️ 2026-10-06 修正：'活动' 原先是映到 activities 字段，但后端
   api/content.js 的 ALLOW_CONTENT_KEYS 白名单里**没有** activities
   （注释写明：主站 index.html 根本不消费它，加了会造成「后台存进去、
   首页没反应」）。结果是管理员只要选了「活动」，保存就会被 400 拒掉。
   现在统一落到 site_config —— 主站确实读这个键，测试能兜住。 */
var CONTENT_FIELD = {
  '作业':     'holiday_homeworks',
  '课程表':   'site_config',
  '值日安排': 'site_config',
  '活动':     'site_config',
  '其他':     'site_config'
};

/* items 里「属于内容区」的字段 —— 公告不在其中。
   ⚠️ 2026-10-06 修 bug：以前 contentItemsToArray 遍历 items 的**全部**数组字段，
   而 announcements 也是数组，于是公告会被摊平两次：
   一次作为「公告」、一次被 fieldToKind() 兜底成「其他」。
   表现为列表里每条公告都出现两遍，而且那个「其他」副本一编辑保存
   就会被写进 site_config，等于凭空多出一条永远删不掉的幽灵记录。
   现在只认下面这些真正属于「内容区」的字段。

   ⚠️⚠️ 极其重要：daily_quote（每日一言）和 important_dates（重要日期）
   都有**自己的专属面板**，千万不要放在这里。
   本面板保存时是全量提交，一旦把 daily_quote 也铺成空数组写上去，
   管理员在「班级内容」里改一条值日安排，就会顺手把 20 句每日一言
   和所有考试日期全部清空 —— 隔壁面板背锅，还极难定位。 */
var CONTENT_ARRAY_FIELDS = [
  'holiday_homeworks',
  'site_config',
  'activities',      /* 后端已拒收，但历史数据里可能有，读出来让管理员能迁走 */
];

/* 本面板有「写权限」的字段子集 —— 上面那些里，activities 只读不写。 */
var CONTENT_WRITABLE_FIELDS = ['holiday_homeworks', 'site_config'];

/* 其它面板拥有的字段：本面板读都不读、写更不写。
   列在这里是为了让「为什么不算进来」这件事有据可查。 */
var CONTENT_OWNED_BY_OTHER_PANELS = ['daily_quote', 'important_dates', 'homework_notice'];
void CONTENT_OWNED_BY_OTHER_PANELS;

function contentItemsToArray(items){
  var out = [];
  CONTENT_ARRAY_FIELDS.forEach(function(f){
    var v = (items || {})[f];
    if(!Array.isArray(v)) return;
    v.forEach(function(x){
      if(!x || typeof x !== 'object') return;
      /* 这条是从哪个云端字段来的 —— 保存时靠它归位，不再靠 kind 猜。
         以前靠 kind→CONTENT_FIELD 反查，遇到 kind 认不出来（比如旧的
         '通知'）就会掉进 site_config，把数据搬错地方。 */
      out.push({
        kind: x.kind || fieldToKind(f),
        cat: x.category || '',
        title: x.title || '',
        body: x.body || '',
        updatedAt: x.updatedAt || null,
        _field: f,
        _src: x                    /* 原始对象，保存时原样写回（形态保真） */
      });
    });
  });
  return out;
}

function fieldToKind(f){
  var m = {
    holiday_homeworks: '作业',
    activities: '活动'
  };
  return m[f] || '其他';
}

/* ============================================================================
 * ⑪ 面板：班级内容（公告 + 内容，2026-10-06 合并）
 * ---------------------------------------------------------------------------
 * ⚠️ 为什么合并：旧版这里是两个面板——
 *      「公告管理」：存在 announcements 数组，有标题/正文/定向发布对象
 *      「内容管理」：存在 items 的平铺字段里，有 kind 分类
 *    但对使用者来说这俩长的几乎一样，都要填标题+正文，区别只在
 *    「要不要指定发给谁」。结果就是管理员根本不知道该用哪个——
 *    用户的反馈原话：「公告跟内容这两个有什么区别？我没有搞懂。」
 *
 *    现在合成一个列表，kind 里多一个「公告」类型，
 *    announcements 数组在读取时被摊平成同样的记录条目，
 *    保存时按 kind 分派回原来的存储位置。对外只有一个面板、一个按钮。
 *
 * ⚠️ 呈现方式（2026-10-06 改）：列表只放「类型 / 标题 / 时间 / 操作」，
 *    正文一律收进「查看」按钮的只读弹窗。以前把正文塞进表格列，
 *    移动端横向滚动、电脑端省略号截断，聊胜于无。
 * ========================================================================= */
function renderClassContent(){
  var S = STATE.classcontent;
  $('view').innerHTML =
    '<div class="toolbar" style="background:var(--panel);flex-wrap:wrap;gap:8px">'
    +   '<button class="btn btn-sm" id="ccAdd">' + svg('plus', 14) + '新增内容</button>'
    +   '<select id="ccCatFilter" class="gate-input inp-sm" style="width:auto;min-width:140px">'
    +     [{ v:'全部', n:'全部' }, { v:'site', n:'📡 网站内部' }, { v:'activity', n:'🔔 重要更新' },
          { v:'class', n:'🏫 班级事务' }, { v:'misc', n:'💭 站主杂谈' }, { v:'__hw__', n:'📝 作业' }].map(function(c){
          return '<option value="' + attr(c.v) + '"' + (S.cat === c.v ? ' selected' : '') + '>' + esc(c.n) + '</option>';
        }).join('')
    +   '</select>'
    +   '<input id="ccQ" class="gate-input inp-sm" placeholder="搜标题 / 正文…" style="width:180px" value="' + attr(S.q) + '">'
    +   '<button class="btn btn-sm btn-ghost" id="ccSort" title="切换时间排序">⇅ ' + (S.sort === 'new' ? '新→旧' : '旧→新') + '</button>'
    +   '<span style="flex:1"></span>'
    +   '<span class="muted" style="font-size:.8rem" id="ccCount">加载中…</span>'
    + '</div>'
    + '<div class="alert info" style="margin-bottom:14px">'
    +   '<b>公告</b>按站内四板块分类（网站内部 / 重要更新 / 班级事务 / 站主杂谈），可以指定只发给某几位同学；'
    +   '<b>作业不再在这里编辑</b>——课代表在前端作业界面改自己的科目，你在前端用管理员账号可改全部科目。<br>'
    +   '列表里只显示标题和时间，<b>点「查看」看正文详情</b>。'
    + '</div>'
    + '<section class="panel" id="ccPanel"><div class="loading"><div class="spinner"></div>加载中…</div></section>';

  $('ccAdd').onclick = function(){ classContentDialog(null); };
  $('ccCatFilter').onchange = function(){ S.cat = this.value; paintClassContent(); };
  $('ccSort').onclick = function(){ S.sort = (S.sort === 'new' ? 'old' : 'new'); this.textContent = '⇅ ' + (S.sort === 'new' ? '新→旧' : '旧→新'); paintClassContent(); };
  var qTimer = null;
  $('ccQ').oninput = function(){
    clearTimeout(qTimer);
    var v = this.value;
    qTimer = setTimeout(function(){ S.q = v; paintClassContent(); }, 200);
  };
  loadClassContent();
}

/**
 * 拉云端数据并摊平成统一记录数组。
 * 每条记录带 _store 字段标明来源，保存时靠它决定往哪儿写回去。
 */
/** 公告首行（同上，列表/弹窗标题用） */
function annFirstLine(text){
  var line = String(text || '').split('\n')[0].trim();
  if(!line) return '';
  return line.length > 42 ? line.slice(0, 42) + '…' : line;
}

/* ============================================================================
 * 公告置顶（2026-10-07 新增）
 * ------------------------------------------------------------------------
 * 站主要求：公告可以设置「显示置顶」或「永久置顶」。
 * 数据层就两个字段（主站 index.html 的 isImportant() 早就认这两个）：
 *     important: true                  → 永久置顶
 *     important: true + importantUntil → 限时置顶，到点自动失效
 *     important 缺失 / false           → 普通公告
 * 这次要补的是**后台没有地方设置它们**——之前只能靠我手改数据。
 *
 * ⚠️ importantUntil 用 ISO 字符串存；表单用 datetime-local（本地时区，无时区后缀），
 *    两边靠下面两个函数换算。别把 datetime-local 的值直接塞进 importantUntil，
 *    那会被当成 UTC 解析，北京时间会差 8 小时。
 * ========================================================================= */
function annPinState(a){
  a = a || {};
  if(!a.important) return 'none';
  if(a.importantUntil){
    if(new Date(a.importantUntil).getTime() <= Date.now()) return 'expired';
    return 'until';
  }
  return 'forever';
}
function annPinLabel(st){
  return st === 'forever' ? '📌 永久置顶'
       : st === 'until'   ? '⏳ 限时置顶'
       : st === 'expired' ? '⌛ 置顶已过期'
       : '';
}
/** ISO → datetime-local 输入框的值（本地时区） */
function isoToLocalInput(iso){
  var d = new Date(iso);
  if(isNaN(d.getTime())) return '';
  var p = function(n){ return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
       + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 新公告的发布时间，格式与线上数据一致（YYYY-MM-DD HH:MM，本地时间）。 */
function annNowStr(){
  var d = new Date();
  var p = function(n){ return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
       + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/**
 * 校验后台手填的公告时间。
 * 接受 YYYY-MM-DD HH:MM（也容许用 M/D/YYYY H:MM、YYYY/MM/DD HH:MM 这类宽松写法），
 * 返回规范化后的 "YYYY-MM-DD HH:MM"；看不懂就返回 ''，由调用方回退到当前时间。
 *
 * ⚠️ 为什么不直接 new Date(str)：Safari 对 "2026-10-11 17:05" 这种带空格的
 *    写法解析结果不稳定（部分版本返回 Invalid Date）。所以自己拆字段。
 */
function annParseDate(str){
  var s = String(str || '').trim();
  if(!s) return '';
  var m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{1,2})$/);
  if(!m) m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})[ T](\d{1,2}):(\d{1,2})$/), m && (m = [m[0], m[3], m[1], m[2], m[4], m[5]]);
  if(!m) return '';
  var Y = +m[1], Mo = +m[2], D = +m[3], H = +m[4], Mi = +m[5];
  if(Mo < 1 || Mo > 12 || D < 1 || D > 31 || H > 23 || Mi > 59) return '';
  var p = function(n){ return (n < 10 ? '0' : '') + n; };
  return Y + '-' + p(Mo) + '-' + p(D) + ' ' + p(H) + ':' + p(Mi);
}

function loadClassContent(){
  var S = STATE.classcontent;
  api('/content').then(function(j){
    var items = (j && j.items) || {};
    var out = [];

    /* ① 公告：兼容两种形态——
          线上真实形态 { date, text, category }（2026-10-06 实测 70 条全是这个形态），
          旧后台设计形态 { id, title, body, targets, createdAt, updatedAt }。
       正文统一读 text（旧形态兜底 body），标题给列表展示用：没有 title 就取正文首行，
       时间读 date（旧形态兜底 createdAt/updatedAt）。 */
    var ann = Array.isArray(items.announcements) ? items.announcements : [];
    ann.forEach(function(a){
      var text = a.text || a.body || '';
      out.push({
        _store: 'announcement',
        _ref: a,                     /* 原始对象，保存时原样写回（形态保真） */
        kind: '公告',
        cat: a.category || '',       /* 站内板块分类（site/activity/class/misc），面板筛选用 */
        title: a.title || annFirstLine(text),
        body: text,
        targets: a.targets || [],
        /* timeKind：只有 createdAt / updatedAt 是数据库 UTC 时间戳（要转本地）；
           a.date 是站主手填的本地墙钟串，原样显示 —— 2026-10-16 站主反馈的
           「编辑完的小字比填的晚 8 小时」就出在这里。 */
        time: a.createdAt || a.updatedAt || a.date || null,
        timeKind: (a.createdAt || a.updatedAt) ? 'db' : 'wall'
      });
    });

    /* ② 其它内容：平铺字段里带 kind 的对象数组。
       作业的条目时间兜底用 start~end（线上作业没有 updatedAt）。 */
    contentItemsToArray(items).forEach(function(c){
      if(CONTENT_RETIRED_KINDS.indexOf(c.kind) !== -1) return;   /* 已下架的旧类型 */
      var t = c.updatedAt || null;
      if(!t && c.kind === '作业'){
        var r0 = c._src || {};
        if(r0.start || r0.end) t = (r0.start || '?') + ' ~ ' + (r0.end || '?');
      }
      out.push({
        _store: 'content',
        _ref: c._src,
        _field: c._field,          /* 来自哪个云端字段，保存时归位用 */
        kind: c.kind || '其他',
        title: c.title || (c.kind === '作业' && c._src
          ? ((c._src.start || '?') + ' ~ ' + (c._src.end || '?')) : ''),
        body: c.body || '',
        targets: [],
        time: t,
        /* updatedAt 是数据库 UTC 时间戳；作业的「起 ~ 止」是手填墙钟串（原样显示） */
        timeKind: (!c.updatedAt && t) ? 'wall' : 'db'
      });
    });

    /* ③ 主站形态的假期作业：holiday_homeworks 里是
          { id, start, end, title, items:[{subject, tasks:[]}] }，
          没有 body 字段。只看 body 会显示成「无正文」，
          所以这里把科目写进 body，让「查看」弹窗（走 hwItemsOf）能正常渲染。 */
    out.forEach(function(r){
      if(r.kind !== '作业' || r.body) return;
      var items0 = hwItemsOf(r._ref);
      if(!items0.length) return;
      r.body = items0.map(function(it){
        var tasks = (it.tasks || []).map(function(t){
          if(t && typeof t === 'object') return (t.text || '(附件)');
          return String(t);
        }).join('；');
        return it.subject + '：' + tasks;
      }).join('\n');
    });

    /* 按时间倒序，新的在前；没有时间的沉底 */
    out.sort(function(a, b){
      var ta = a.time ? Date.parse(a.time) : 0;
      var tb = b.time ? Date.parse(b.time) : 0;
      if(isNaN(ta)) ta = 0;
      if(isNaN(tb)) tb = 0;
      return tb - ta;
    });

    S.list = out;
    paintClassContent();
  }).catch(function(e){
    var p = $('ccPanel');
    if(p) p.innerHTML = '<div class="empty">' + svg('alert', 34) + '<p>加载失败：' + esc(e.message) + '</p></div>';
    var c = $('ccCount');
    if(c) c.textContent = '加载失败';
  });
}

/* 类型 → 徽章配色。公告用红（最抓眼），作业蓝，活动绿，其余灰。 */
function kindBadgeClass(kind){
  var m = { '公告':'badge-red', '作业':'badge-blue', '活动':'badge-green', '课程表':'badge-orange', '值日安排':'badge-orange' };
  return m[kind] || 'badge-gray';
}

function paintClassContent(){
  var S = STATE.classcontent;
  var panel = $('ccPanel');
  if(!panel) return;
  var cnt = $('ccCount');
  if(cnt) cnt.textContent = '共 ' + S.list.length + ' 条';

  if(!S.list.length){
    panel.innerHTML = '<div class="empty">' + svg('layers', 38) + '<p>还没有任何内容</p>'
      + '<p class="muted" style="font-size:.78rem">点左上角「新增内容」发布第一条</p></div>';
    return;
  }

  /* ③ 过滤 + 排序 + 搜索（2026-10-06：站主要求按前端四板块 + 作业分开找，能搜能排）
        分类下拉的值同时匹配公告的板块分类（cat）与「📝 作业」这类 kind。 */
  var rows = S.list;
  if(S.cat && S.cat !== '全部'){
    var catKey = S.cat;
    if(catKey === '__hw__'){
      rows = rows.filter(function(c){ return c.kind === '作业'; });
    } else {
      rows = rows.filter(function(c){ return c.kind === '公告' && (c.cat || '') === catKey; });
    }
  }
  if(S.q){
    var q = S.q.trim().toLowerCase();
    if(q){
      rows = rows.filter(function(c){
        return String(c.title || '').toLowerCase().indexOf(q) >= 0
            || String(c.body || '').toLowerCase().indexOf(q) >= 0;
      });
    }
  }
  rows = rows.slice().sort(function(a, b){
    var ta = Date.parse(String(a.time || '').replace(' ', 'T')) || 0;
    var tb = Date.parse(String(b.time || '').replace(' ', 'T')) || 0;
    return S.sort === 'new' ? (tb - ta) : (ta - tb);
  });

  if(!rows.length){
    panel.innerHTML = '<div class="empty">' + svg('layers', 38) + '<p>当前筛选下没有内容</p>'
      + '<p class="muted" style="font-size:.78rem">换个分类或清空搜索关键词试试</p></div>';
    return;
  }

  panel.innerHTML = '<div class="rec-list">' + rows.map(function(c){
    var i = S.list.indexOf(c);
    var timeTxt = fmtRecTime(c);
    var scope = (c.kind === '公告')
      ? (c.targets && c.targets.length ? '定向 ' + c.targets.length + ' 人' : '全体同学')
      : '';
    /* 作业不再在后台编辑（2026-10-06）：课代表在前端改，管理员前端改全部 */
    var editBtn = (c.kind === '作业')
      ? ''
      : '<button data-cc-edit="' + i + '">' + svg('edit', 14) + '编辑</button>';
    var pinSt = (c.kind === '公告') ? annPinState(c._ref) : 'none';
    return '<div class="rec">'
      + '<div class="rec-main">'
      +   '<div class="rec-top">'
      +     '<span class="badge ' + kindBadgeClass(c.kind) + '">' + esc(c.kind) + '</span>'
      +     (pinSt !== 'none' ? '<span class="badge badge-orange">' + esc(annPinLabel(pinSt)) + '</span>' : '')
      +     '<b>' + esc(c.title || '(无标题)') + '</b>'
      +   '</div>'
      +   '<div class="rec-meta">'
      +     '<span>' + svg('clock', 12) + esc(timeTxt) + '</span>'
      +     (scope ? '<span>' + svg('users', 12) + esc(scope) + '</span>' : '')
      +     (c.body ? '<span>' + svg('file', 12) + '正文 ' + c.body.length + ' 字</span>' : '<span class="muted">无正文</span>')
      +   '</div>'
      + '</div>'
      + '<div class="rec-act">'
      +   '<button class="view" data-cc-view="' + i + '">' + svg('eye', 14) + '查看</button>'
      +   editBtn
      +   '<button class="danger" data-cc-del="' + i + '">' + svg('trash', 14) + '删除</button>'
      + '</div></div>';
  }).join('') + '</div>';

  bindAll(panel, '[data-cc-view]', 'ccView', function(i){ classContentViewDialog(S.list[i]); });
  bindAll(panel, '[data-cc-edit]', 'ccEdit', function(i){ classContentDialog(i); });
  bindAll(panel, '[data-cc-del]', 'ccDel', function(i){ classContentDelete(i); });
}

/* 小工具：批量绑定 data-xxx 属性上的点击事件（属性名去掉连字符） */
function bindAll(root, sel, dataKey, fn){
  Array.prototype.forEach.call(root.querySelectorAll(sel), function(b){
    b.onclick = function(){ fn(Number(b.dataset[dataKey])); };
  });
}

/** 只读详情弹窗 —— 列表里看不到的正文全在这儿。 */
function classContentViewDialog(c){
  if(!c) return;
  var meta =
    '<dl class="view-kv">'
    + '<dt>类型</dt><dd><span class="badge ' + kindBadgeClass(c.kind) + '">' + esc(c.kind) + '</span></dd>'
    + '<dt>标题</dt><dd>' + esc(c.title || '(无标题)') + '</dd>'
    + '<dt>时间</dt><dd>' + esc(fmtRecTime(c)) + '</dd>'
    + (c.kind === '公告'
        ? '<dt>发布对象</dt><dd>' + ((c.targets && c.targets.length)
            ? '定向 ' + c.targets.length + ' 人：' + esc(c.targets.join('、'))
            : '全体同学') + '</dd>'
        : '')
    + (function(){
        if(c.kind !== '公告') return '';
        var st = annPinState(c._ref);
        var tail = (st === 'until' || st === 'expired')
          ? '　<span class="muted" style="font-size:.78rem">（到 ' + esc(fmt(c._ref.importantUntil)) + ' 结束）</span>' : '';
        return '<dt>置顶</dt><dd>' + (st === 'none' ? '不置顶' : esc(annPinLabel(st)) + tail) + '</dd>';
      })()
    + '</dl>';

  var body = c.body
    ? '<div class="view-body">' + esc(c.body) + '</div>'
    : '<div class="empty" style="padding:26px">' + svg('file', 30) + '<p>这条内容没有正文</p></div>';

  openModal({
    title: '查看内容',
    sub: c.kind + ' · ' + (c.title || '(无标题)'),
    wide: true,
    body: meta + body,
    foot: '<button class="btn btn-ghost" data-cv-close>关闭</button>'
        + '<button class="btn" id="cvEdit">' + svg('edit', 14) + ' 去编辑</button>',
    onMount: function(box){
      box.querySelector('[data-cv-close]').onclick = closeModal;
      box.querySelector('#cvEdit').onclick = function(){
        var idx = STATE.classcontent.list.indexOf(c);
        closeModal();
        if(idx >= 0) classContentDialog(idx);
      };
    }
  });
}

function classContentDelete(i){
  var S = STATE.classcontent;
  var c = S.list[i];
  if(!c) return;
  confirmBox({
    title: '删除' + (c.kind === '公告' ? '公告' : '内容'),
    text: '确定删除「' + (c.title || '(无标题)') + '」吗？',
    detail: c.body ? (c.body.length > 90 ? c.body.slice(0, 90) + '…' : c.body) : '',
    danger: true,
    okText: '删除'
  }).then(function(yes){
    if(!yes) return;
    var next = S.list.slice();
    next.splice(i, 1);
    saveClassContent(next).then(function(){
      toast('已删除', 'ok');
      loadClassContent();
    }).catch(function(e){ toast(e.message, 'err'); });
  });
}

/**
 * 把统一记录数组写回云端。
 * 按 _store 分派：公告 → announcements 数组；其它 → 按 _field 归位到内容字段。
 * 两者在同一次 PUT 里提交，避免「删了公告但内容没更新」的半截状态。
 *
 * ⚠️ 形态保真（2026-10-06 重写）：写回的是每条记录的 **_ref 原始对象**——
 *    编辑弹窗负责把用户改动直接写进 _ref（公告写 text/date/category，
 *    作业写 items/start/end），这里绝不再重建对象。
 *    旧版在这里按「title/body」重建，把线上公告的 text/date/category
 *    和作业的 items 结构整个丢掉——保存一次等于清空主站数据。
 *
 * ⚠️ 必须**全量**提交。后端 /api/content 的 PUT 是「读旧文档 → 合并 → 写回」，
 *    传什么就覆盖什么。少传一个字段它原样保留，但传了空数组就是「真的要清空」——
 *    这两种语义必须能区分开，所以这里每个内容字段都显式写出来（哪怕是空数组）。
 *    只写「有数据的字段」是不行的：那样删掉最后一条记录时，空数组传不出去，
 *    云端那条记录就永远删不掉了。
 *    ⚠️ 只铺 CONTENT_WRITABLE_FIELDS —— 绝不能碰 daily_quote /
 *    important_dates，那是隔壁专属面板的地盘。
 */
function saveClassContent(list){
  var ann = [];
  var items = {};
  CONTENT_WRITABLE_FIELDS.forEach(function(f){ items[f] = []; });

  (list || []).forEach(function(c){
    var ref = c._ref || {};
    if(c._store === 'announcement'){
      ann.push(ref);
      return;
    }
    /* 归位：优先用记录自带的 _field（历史数据靠它不搬错地方），
       没有就按 kind 现算。再兜一层 —— 算出来的字段必须在可写白名单内，
       否则（比如历史上从 activities 读出来的）一律归到 site_config。 */
    var f = c._field || CONTENT_FIELD[c.kind] || 'site_config';
    if(CONTENT_WRITABLE_FIELDS.indexOf(f) === -1) f = 'site_config';
    items[f].push(ref);
  });

  items.announcements = ann;

  return api('/content', { method:'PUT', body:{ items: items } })
    .then(function(j){
      if(j && j.ok === false) throw new Error(j.error || '保存失败');
      return j;
    });
}

function classContentDialog(idx){
  var editing = (idx !== null && idx !== undefined);
  var c = editing ? STATE.classcontent.list[idx] : null;
  /* 编辑时类型锁定（公告/作业/其它内容三种形态互不兼容，改类型=删了重建，
     强行切换会让形态保真写回变成数据搬家事故）；新建默认发公告。 */
  var kind = c ? c.kind : '公告';
  var isAnnounce = kind === '公告';
  var isHomework = kind === '作业';
  /* 「作业」已从后台编辑移除（2026-10-06）：入口被拦在这里，给出去向说明 */
  if (isHomework) {
    openModal({
      title: '作业已移到前端编辑',
      body: '<div class="alert info">后台不再编辑作业。现在改作业有两条路：<br>'
          + '<b>① 课代表</b>：登录班级站 → 打开作业查看 → 自己科目卡片上点「✏️ 编辑」（只能改本科目）；<br>'
          + '<b>② 站主</b>：用管理员账号登录班级站 → 同样位置，全部科目都能改。<br>'
          + '删错条目仍可在这里点该条作业的「删除」。</div>',
      foot: '<button class="btn" data-cc-cancel>知道了</button>',
      onMount: function(box){ box.querySelector('[data-cc-cancel]').onclick = closeModal; }
    });
    return;
  }
  /* 「作业」已从后台编辑移除（2026-10-06）：课代表在前端作业界面改本科目，
     站主用管理员账号登录前端也能改全部科目。这里不再新建/编辑作业。 */
  var KIND_OPTS = ['公告', '活动', '课程表', '值日安排', '其他'];
  /* 主站公告分类（index.html ANN_CATS 的键） */
  var ANN_CATS = [
    { key: 'site',     name: '网站内部' },
    { key: 'activity', name: '重要更新' },
    { key: 'class',    name: '班级事务' },
    { key: 'misc',     name: '站主杂谈' }
  ];

  /* ---------- 按类型生成表单 ---------- */
  var bodyHtml = '';

  if(isAnnounce){
    /* 置顶三态：不置顶 / 永久置顶 / 限时置顶（到点自动取消） */
    var _pr = c ? (c._ref || {}) : {};
    var pinMode = annPinState(_pr);
    if(pinMode === 'expired') pinMode = 'until';      /* 过期了也按「限时」显示，让人能改时间 */
    var pinUntilVal = _pr.importantUntil ? isoToLocalInput(_pr.importantUntil) : '';

    bodyHtml =
      '<div class="field"><label for="ccBody">公告正文 <span style="color:var(--danger)">*</span>'
      + '<span id="ccBodyCount" style="float:right;font-weight:400;color:#8a827b"></span></label>'
      + '<textarea id="ccBody" rows="6" placeholder="官方、简洁。一句话说清改了什么，建议 20 字以内。">'
      + esc(c ? (c.body || '') : '') + '</textarea>'
      /* 站主 2026-10-14：公告要官方、简洁，字越少越好。
         同学看公告只关心「有什么变化」，过程和不必要的语气都该省掉。 */
      + '<p class="muted" style="font-size:.76rem;margin:4px 0 0">面向全班，<b>字越少越好</b>：说清「改了什么」即可，不必解释过程，不用语气词、感叹号。</p>'
      + '</div>'
      + '<div class="field"><label for="ccCat">分类</label>'
      + '<select id="ccCat">'
      + ANN_CATS.map(function(k){
          var cur = c ? ((c._ref && c._ref.category) || 'site') : 'site';
          return '<option value="' + attr(k.key) + '"' + (cur === k.key ? ' selected' : '') + '>' + esc(k.name) + '</option>';
        }).join('')
      + '</select></div>'
      + '<div class="field"><label for="ccPin">置顶</label>'
      + '<select id="ccPin">'
      +   [['none', '不置顶'],
           ['forever', '📌 永久置顶（一直排在最上）'],
           ['until', '⏳ 限时置顶（到指定时间自动取消）']].map(function(p){
          return '<option value="' + attr(p[0]) + '"' + (pinMode === p[0] ? ' selected' : '') + '>' + esc(p[1]) + '</option>';
        }).join('')
      + '</select>'
      + '<div id="ccPinUntilWrap" style="margin-top:8px' + (pinMode === 'until' ? '' : ';display:none') + '">'
      +   '<label for="ccPinUntil">置顶到</label>'
      +   '<input type="datetime-local" id="ccPinUntil" value="' + attr(pinUntilVal) + '">'
      +   '<p class="muted" style="font-size:.76rem;margin:4px 0 0">按你手机 / 电脑上的本地时间算，到点自动降为普通公告</p>'
      + '</div>'
      + '<p class="muted" style="font-size:.76rem;margin:4px 0 0">置顶公告在班级站公告栏排最上方，并带「置顶」标签</p>'
      + '</div>'
      + '<div class="field"><label for="ccDate">发布时间</label>'
      + '<div style="display:flex;gap:8px;align-items:center">'
      +   '<input id="ccDate" value="' + attr(c ? ((c._ref && c._ref.date) || '') : annNowStr()) + '" placeholder="YYYY-MM-DD HH:MM" style="flex:1;min-width:0">'
      +   '<button type="button" class="btn btn-sm btn-secondary" id="ccDateNow" style="white-space:nowrap">填入当前时间</button>'
      + '</div>'
      + '<p class="muted" style="font-size:.76rem;margin:4px 0 0">格式 <b>YYYY-MM-DD HH:MM</b>，按你设备上的本地时间。留空或格式不对会自动按当前时间填。</p></div>'
      + '<div class="msg" id="ccMsg"></div>';
  }else if(isHomework){
    /* 作业：结构化编辑。每科 = 科目名 + 任务多行文本（一行一条）。
       附件任务（图片/音频/视频）在文本里用「📎 [图片] 描述」占位行表示，
       保存时按**描述匹配**还原成附件对象；删掉占位行 = 移除该附件。
       （2026-10-07：原来按出现顺序配对，中间删行会全体错位，已改。） */
    var src = c ? (c._ref || {}) : {};
    var subs = (c ? hwItemsOf(src) : []);
    bodyHtml =
      '<div style="display:flex;gap:10px;flex-wrap:wrap">'
      + '<div class="field" style="flex:1;min-width:140px"><label for="ccHwStart">开始日期</label>'
      +   '<input type="date" id="ccHwStart" value="' + attr(src.start || '') + '"></div>'
      + '<div class="field" style="flex:1;min-width:140px"><label for="ccHwEnd">截止日期</label>'
      +   '<input type="date" id="ccHwEnd" value="' + attr(src.end || '') + '"></div>'
      + '</div>'
      + '<div class="field"><label>科目与任务（任务一行一条）</label><div id="ccHwSubjects"></div>'
      + '<button type="button" class="btn btn-sm btn-secondary" id="ccHwAddSubj" style="margin-top:8px">' + svg('plus', 14) + ' 添加科目</button></div>'
      + '<div class="msg" id="ccMsg"></div>';
  }else{
    bodyHtml =
      '<div class="field"><label for="ccTitle">标题 <span style="color:var(--danger)">*</span></label>'
      + '<input id="ccTitle" value="' + attr(c ? c.title : '') + '" placeholder="例如：明天交物理作业"></div>'
      + '<div class="field"><label for="ccBody">正文</label>'
      + '<textarea id="ccBody" rows="7" placeholder="支持多行文本">' + esc(c ? (c.body || '') : '') + '</textarea></div>'
      + '<div class="msg" id="ccMsg"></div>';
  }

  openModal({
    title: editing ? ('编辑' + kind) : '新增内容',
    wide: true,
    sub: isAnnounce ? '公告保存后直接显示在班级站首页通知栏'
       : isHomework ? '按「科目 → 任务」编辑，图片 / 音频附件会原样保留'
       : '站内内容区块',
    body:
      '<div class="field"><label for="ccKind">类型</label>'
      + '<select id="ccKind"' + (editing ? ' disabled' : '') + '>'
      + KIND_OPTS.map(function(k){
          return '<option value="' + attr(k) + '"' + (kind === k ? ' selected' : '') + '>' + esc(k) + '</option>';
        }).join('')
      + '</select>'
      + (editing ? '<p class="muted" style="font-size:.76rem;margin:4px 0 0">类型不可改；想换类型就删掉这条重新发布</p>' : '')
      + '</div>'
      + bodyHtml,
    foot: '<button class="btn btn-ghost" data-cc-cancel>取消</button>'
        + '<button class="btn" id="ccGo">' + (editing ? '保存修改' : '发布') + '</button>',
    onMount: function(box){
      box.querySelector('[data-cc-cancel]').onclick = closeModal;
      var msg = box.querySelector('#ccMsg');

      /* 公告正文实时字数（站主 2026-10-14：公告要官方简洁，字越少越好）
         超过 40 字变橙，提示「该收了」—— 但只是提示，不拦保存。 */
      var bodyTa = box.querySelector('#ccBody');
      var bodyCnt = box.querySelector('#ccBodyCount');
      if(bodyTa && bodyCnt){
        var syncBodyCnt = function(){
          var n = bodyTa.value.trim().length;
          bodyCnt.textContent = n ? (n + ' 字') : '';
          bodyCnt.style.color = (n > 40) ? '#b45309' : '#8a827b';
        };
        bodyTa.addEventListener('input', syncBodyCnt);
        syncBodyCnt();
      }

      /* ================= 公告：置顶方式切换 ================= */
      var pinSel = box.querySelector('#ccPin');
      if(pinSel){
        var wrap = box.querySelector('#ccPinUntilWrap');
        pinSel.onchange = function(){
          if(wrap) wrap.style.display = (pinSel.value === 'until') ? '' : 'none';
        };
      }

      /* ================= 公告：发布时间「填入当前时间」（2026-10-11 站主要求）=================
         站主反馈「AI 发出来的时间总是错的」——根因是时间戳凭感觉手写。
         这个按钮让站主一键取设备真实时间，不会再写出未来/过去的错时间。 */
      var dateNowBtn = box.querySelector('#ccDateNow');
      if(dateNowBtn){
        dateNowBtn.onclick = function(){
          var inp = box.querySelector('#ccDate');
          if(inp){ inp.value = annNowStr(); inp.focus(); }
        };
      }

      /* ================= 作业：科目编辑器 ================= */
      var subjBox = box.querySelector('#ccHwSubjects');
      if(subjBox){
        var ATT_RE = /^\s*📎\s*\[([^\]]*)\]\s*/;   /* 📎 [图片] 描述 */
        var attMark = function(t){
          /* 三个字段都要认（2026-10-07 补 video）：只判 img/audio 的话，
             视频附件会被标成「[附件]」，占位行还原时也就跟着丢了类别。 */
          var what = t.img ? '图片' : (t.audio ? '音频' : (t.video ? '视频' : '附件'));
          return '📎 [' + what + '] ' + (t.text || '');
        };

        function addSubjectBlk(subject, tasks){
          var blk = document.createElement('div');
          blk.className = 'hw-subj';
          blk.style.cssText = 'border:1px solid var(--line,#ddd);border-radius:10px;padding:10px;margin-bottom:10px';
          var lines = [], atts = [];
          (tasks || []).forEach(function(t){
            if(t && typeof t === 'object'){ lines.push(attMark(t)); atts.push(t); }
            else lines.push(String(t));
          });
          blk.innerHTML =
            '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">'
            + '<input class="hw-subj-name" value="' + attr(subject || '') + '" placeholder="科目名，如：语文" style="flex:1">'
            + '<button type="button" class="btn btn-sm danger hw-subj-del">' + svg('trash', 13) + '</button>'
            + '</div>'
            + '<textarea class="hw-subj-tasks" rows="' + Math.max(3, lines.length + 1) + '" '
            +   'placeholder="一行一条任务；📎 开头的是附件占位行，别改文字部分">'
            + esc(lines.join('\n')) + '</textarea>'
            + (atts.length ? '<p class="muted" style="font-size:.74rem;margin:6px 0 0">本科有 ' + atts.length + ' 个图片/音频/视频附件，以 📎 行表示；删掉该行 = 移除附件</p>' : '');
          blk.__atts = atts;
          blk.querySelector('.hw-subj-del').onclick = function(){ blk.remove(); };
          subjBox.appendChild(blk);
        }

        subs.forEach(function(it){ addSubjectBlk(it.subject, it.tasks); });
        if(!subs.length) addSubjectBlk('', []);
        box.querySelector('#ccHwAddSubj').onclick = function(){ addSubjectBlk('', []); };
      }

      /* ================= 保存 ================= */
      box.querySelector('#ccGo').onclick = function(){
        var ref, rec;

        if(isAnnounce){
          var textV = box.querySelector('#ccBody').value.trim();
          var cat = box.querySelector('#ccCat').value;
          var pinV = box.querySelector('#ccPin') ? box.querySelector('#ccPin').value : 'none';
          if(!textV){ msg.className = 'msg err show'; msg.textContent = '请填写公告正文'; return; }

          /* 置顶三态 → important / importantUntil 两个字段。
             限时置顶必须给到点时间，且必须是未来——否则等于「点了置顶却立刻失效」，
             后台看着像成功、前台根本不置顶，这种静默不一致最坑。 */
          var pinUntilIso = '';
          if(pinV === 'until'){
            var uv = box.querySelector('#ccPinUntil') ? box.querySelector('#ccPinUntil').value.trim() : '';
            if(!uv){ msg.className = 'msg err show'; msg.textContent = '选了限时置顶，请填写置顶到什么时候'; return; }
            var ud = new Date(uv);
            if(isNaN(ud.getTime())){ msg.className = 'msg err show'; msg.textContent = '置顶时间看不懂，请重新选一个'; return; }
            if(ud.getTime() <= Date.now()){ msg.className = 'msg err show'; msg.textContent = '置顶结束时间要晚于现在（否则一发布就失效）'; return; }
            pinUntilIso = ud.toISOString();
          }

          /* 发布时间：优先用站主填的值（v2.6.0 解禁，之前是 disabled 只读）。
             填了但格式看不懂 → 明确报错而不是悄悄丢掉，否则站主会以为改成功了。 */
          var dateInp = box.querySelector('#ccDate');
          var dateRaw = dateInp ? dateInp.value.trim() : '';
          var dateV = annParseDate(dateRaw);
          if(dateRaw && !dateV){
            msg.className = 'msg err show';
            msg.textContent = '发布时间格式看不懂，请用「YYYY-MM-DD HH:MM」，或点「填入当前时间」';
            return;
          }
          if(!dateV) dateV = annNowStr();   /* 留空 = 用当前时间 */

          if(editing){
            ref = c._ref || {};
            ref.text = textV; ref.category = cat;
            /* 旧形态字段同步：老公告的正文在 body、标题在 title——只改 text 会留下
               两份不一致的正文（读的时候 text 优先，body 成了脏数据）。
               有就一起更新，写回后对象内自洽。 */
            if('body' in ref) ref.body = textV;
            if('title' in ref) ref.title = annFirstLine(textV);
            ref.date = dateV;                          /* v2.6.0：以时间框为准 */
          }else{
            ref = { date: dateV, text: textV, category: cat };
          }
          /* 置顶字段写回：不置顶要把两个字段都清掉，否则「取消置顶」取消不掉 */
          if(pinV === 'forever'){ ref.important = true; delete ref.importantUntil; }
          else if(pinV === 'until'){ ref.important = true; ref.importantUntil = pinUntilIso; }
          else { delete ref.important; delete ref.importantUntil; }
          rec = {
            _store: 'announcement', _ref: ref, kind: '公告',
            title: ref.title || annFirstLine(ref.text),
            body: ref.text, targets: ref.targets || [], time: ref.date,
            pin: annPinState(ref)
          };

        }else if(isHomework){
          var startV = box.querySelector('#ccHwStart').value.trim();
          var endV   = box.querySelector('#ccHwEnd').value.trim();
          var itemsArr = [];
          Array.prototype.forEach.call(subjBox.querySelectorAll('.hw-subj'), function(blk){
            var subject = blk.querySelector('.hw-subj-name').value.trim();
            var atts = (blk.__atts || []).slice();
            var tasks = blk.querySelector('.hw-subj-tasks').value.split('\n')
              .map(function(l){ return l.trim(); }).filter(Boolean)
              .map(function(ln){
                if(ATT_RE.test(ln)){
                  /* 附件占位行 → 还原为原附件对象。
                     ⚠️ 这里原来用 atts.shift() 按**位置**配对，有个隐坑：
                        用户在中间删掉/加了别的行，后面的附件就会全体错位，
                        而且错得无声无息（链接换到了另一条任务上）。
                        改成**按描述匹配**，对不上号才退化成纯文本。
                        主站 caSave 用的是同一套匹配思路，两边保持一致。 */
                  var desc = ln.replace(ATT_RE, '').split('|')[0].trim();
                  var hit = -1;
                  for(var k = 0; k < atts.length; k++){
                    if(atts[k] && String(atts[k].text || '').trim() === desc){ hit = k; break; }
                  }
                  if(hit >= 0) return atts.splice(hit, 1)[0];
                  return ln.replace(ATT_RE, '');
                }
                return ln;
              });
            if(subject || tasks.length) itemsArr.push({ subject: subject || '未分科', tasks: tasks });
          });
          if(!itemsArr.length){ msg.className = 'msg err show'; msg.textContent = '至少保留一个科目'; return; }
          if(!startV && !endV){ msg.className = 'msg err show'; msg.textContent = '请至少填写开始或截止日期'; return; }

          if(editing){
            ref = c._ref || {};
          }else{
            ref = { id: 'hw-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + Date.now().toString(36).slice(-4) };
          }
          ref.start = startV; ref.end = endV; ref.items = itemsArr;
          rec = {
            _store: 'content', _ref: ref, _field: 'holiday_homeworks', kind: '作业',
            title: ref.title || ((startV || '?') + ' ~ ' + (endV || '?')),
            body: hwSummary(ref),
            targets: [],
            time: (startV || '?') + ' ~ ' + (endV || '?')
          };

        }else{
          var titleV = box.querySelector('#ccTitle').value.trim();
          var bodyV  = box.querySelector('#ccBody').value;
          if(!titleV){ msg.className = 'msg err show'; msg.textContent = '请填写标题'; return; }

          if(editing){
            ref = c._ref || {};
          }else{
            ref = {};
          }
          ref.kind = kind; ref.title = titleV; ref.body = bodyV;
          ref.updatedAt = new Date().toISOString();
          rec = {
            _store: 'content', _ref: ref,
            _field: (editing && c && c._field) ? c._field : CONTENT_FIELD[kind],
            kind: kind, title: titleV, body: bodyV, targets: [], time: ref.updatedAt
          };
        }

        var next = STATE.classcontent.list.slice();
        if(editing) next[idx] = rec; else next.unshift(rec);

        box.querySelector('#ccGo').disabled = true;
        saveClassContent(next).then(function(){
          toast(editing ? '已保存修改' : '已发布', 'ok');
          closeModal();
          loadClassContent();
        }).catch(function(e){
          msg.className = 'msg err show';
          msg.textContent = e.message;
          box.querySelector('#ccGo').disabled = false;
        });
      };
    }
  });
}

/* ============================================================================
 * ⑪-B 面板：头衔任命（2026-10-05 新增）
 * ---------------------------------------------------------------------------
 * 班级职务由管理员在这里任命。头衔存 profiles.title（英文逗号分隔，可兼多职）。
 *
 * 授权作用：目前只有「课代表」（含各科课代表）参与实际授权——
 *   可以编辑云端作业（见 api/content.js）。其余头衔先只做展示。
 *
 * ⚠️ 头衔是**授权凭据**，所以服务端只认 profiles.title 的值，
 *    前端界面只是把它写进去，改不改得动由后端说了算。
 * ========================================================================= */
function renderTitles(){
  var S = STATE.titles;
  $('view').innerHTML =
    '<div class="toolbar" style="background:var(--panel)">'
    +   '<div class="search">' + svg('search')
    +     '<input id="ttSearch" placeholder="搜索姓名或学号…" value="' + attr(S.q) + '" maxlength="40">'
    +   '</div>'
    +   '<span><label class="ck" style="font-size:.82rem;white-space:nowrap"><input type="checkbox" id="ttOnly"'
    +     (S.onlySet ? ' checked' : '') + '>只看已任命</label></span>'
    +   '<button class="btn btn-sm btn-secondary" id="ttRefresh">' + svg('refresh', 14) + '刷新</button>'
    + '</div>'
    + '<div class="alert info" style="margin-bottom:16px">'
    +   '给同学任命班级职务。头衔可以兼多职（比如既是团支书又是课代表）。<br>'
    +   '<b>课代表有实际权限</b>：可以在主站作业界面修改<b>本科目</b>作业；其余头衔目前只用于展示。'
    + '</div>'
    + '<section class="panel"><div id="ttBody"><div class="loading"><div class="spinner"></div>加载中…</div></div></section>';

  $('ttSearch').oninput = debounce(function(e){
    /* 换了搜索词就回第 1 页 —— 否则停在旧页码上，结果变少时会看到空白页 */
    S.q = e.target.value.trim(); S.page = 1; loadTitles();
  }, 320);
  $('ttRefresh').onclick = function(){ S.page = 1; loadTitles(); };
  var onlyBox = $('ttOnly');
  if(onlyBox) onlyBox.onchange = function(){ S.onlySet = !!onlyBox.checked; S.page = 1; paintTitles(); };

  /* ⚠️ 2026-10-10：进页面必须**强制回到第 1 页**（S.page = 1）。
     原来这里只写 loadTitles()，而 STATE.titles 是**跨页面存活**的模块状态：
     站主翻到 3/3 页 → 切到别的页 → 再回来，页码仍停在 3，
     于是只看到最后 2 个人，还以为是「名单没显示全」。
     （站主反馈「头衔那里还是没显示啊，比如冷思敏的名字」就是这个 ——
       冷思敏在第 1 页，而他一直停在末页。） */
  S.page = 1;
  loadTitles();
}

function loadTitles(){
  var S = STATE.titles;
  api('/admin?action=titles').then(function(j){
    S.list = j.profiles || [];
    S.allowed = j.allowed || [];
    S.aiAccount = j.aiAccount || null;
    paintTitles();
  }).catch(function(e){
    var b = $('ttBody');
    if(b) b.innerHTML = '<div class="empty">' + svg('alert', 34) + '<p>加载失败：' + esc(e.message) + '</p></div>';
  });
}

function paintTitles(){
  var S = STATE.titles;
  var body = $('ttBody');
  if(!body) return;   /* 防迟到响应抢页面 */

  var kw = (S.q || '').toLowerCase();
  var list = S.list.filter(function(p){
    if(S.onlySet && !(p.titles || []).length) return false;
    if(!kw) return true;
    return String(p.name || '').toLowerCase().indexOf(kw) >= 0
        || String(p.studentId || '').toLowerCase().indexOf(kw) >= 0;
  });

  if(!list.length){
    body.innerHTML = '<div class="empty">' + svg('shield', 38) + '<p>'
      + (!S.list.length ? '还没有成员，请先到「成员与档案」导入全班名单'
         : (S.onlySet ? '当前全班还没有人被任命头衔（取消勾选「只看已任命」看全部同学）' : '没找到匹配的同学'))
      + '</p></div>';
    return;
  }

  /* ---- 分页（2026-10-09 修复） ----
     原实现一次性渲染全部 list，全班 60+ 人时既看不到底、也没有翻页入口。
     这里按 S.page / S.size 切片，并把筛选变化时的页码夹回合法范围。 */
  var size  = S.size;
  var total = list.length;
  var pages = Math.max(1, Math.ceil(total / size));
  if(S.page > pages) S.page = pages;
  if(S.page < 1) S.page = 1;
  var from  = (S.page - 1) * size;
  var slice = list.slice(from, from + size);
  var shownTo = Math.min(from + size, total);

  body.innerHTML = '<div class="table-wrap"><table><thead><tr>'
    + '<th>姓名</th><th>学号</th><th>当前头衔</th><th>绑定账号</th>'
    + '<th style="text-align:right">操作</th>'
    + '</tr></thead><tbody>'
    + slice.map(function(p){
        var tags = (p.titles || []);
        var tagHtml = tags.length
          ? tags.map(function(t){
              var isHw = (t === '课代表' || /课代表$/.test(t));
              return '<span class="badge' + (isHw ? ' badge-orange' : '') + '">' + esc(t) + '</span>';
            }).join(' ')
          : '<span class="muted">—</span>';
        return '<tr>'
          + '<td class="nowrap"><b>' + esc(p.name || '(未填)') + '</b></td>'
          + '<td class="nowrap muted">' + esc(p.studentId || '—') + '</td>'
          + '<td>' + tagHtml + '</td>'
          + '<td class="nowrap muted" style="font-size:.78rem">'
            + (p.username ? esc(p.username) : '<span style="opacity:.6">未认领</span>') + '</td>'
          + '<td class="nowrap" style="text-align:right"><div class="row-actions">'
          +   '<button data-tt-edit="' + p.id + '">任命</button>'
          + '</div></td></tr>';
      }).join('')
    + '</tbody></table></div>'
    + '<div class="pager">'
    +   '<span class="info">共 ' + total + ' 人'
    +     (S.onlySet || kw ? '（已按条件筛选，全班共 ' + S.list.length + ' 人）' : '')
    +     '，当前显示第 ' + (from + 1) + '–' + shownTo + ' 条'
    /* ⚠️ 2026-10-10：末页时明确提示「还有前面几页」。
        站主曾在末页找一个人找不到（那人在第 1 页），误以为名单没显示全。
        光有页码按钮不够 —— 在末页时要主动说一句。 */
    +     (pages > 1 && S.page >= pages
              ? '<b style="color:var(--accent-ink)"> · 前面还有 ' + (pages - 1) + ' 页，点「首页」看全部</b>'
              : '')
    +   '</span>'
    +   '<span class="pages">'
    +     '<button data-ttp="first"' + (S.page <= 1 ? ' disabled' : '') + '>首页</button>'
    +     '<button data-ttp="prev"'  + (S.page <= 1 ? ' disabled' : '') + '>上一页</button>'
    +     '<button class="on">' + S.page + ' / ' + pages + '</button>'
    +     '<button data-ttp="next"'  + (shownTo >= total ? ' disabled' : '') + '>下一页</button>'
    +     '<button data-ttp="last"'  + (shownTo >= total ? ' disabled' : '') + '>末页</button>'
    +   '</span>'
    + '</div>';

  Array.prototype.forEach.call(body.querySelectorAll('[data-ttp]'), function(b){
    b.onclick = function(){
      var a = b.dataset.ttp;
      if(a === 'first') S.page = 1;
      else if(a === 'last') S.page = pages;
      else if(a === 'prev') S.page = Math.max(1, S.page - 1);
      else if(a === 'next') S.page = Math.min(pages, S.page + 1);
      paintTitles();
      /* 翻页后滚回列表顶部，免得停在半空 */
      var p = $('ttBody');
      if(p && p.scrollIntoView) p.scrollIntoView({ block:'start', behavior:'smooth' });
    };
  });

  Array.prototype.forEach.call(body.querySelectorAll('[data-tt-edit]'), function(b){
    b.onclick = function(){
      var id = Number(b.dataset.ttEdit);
      var p = S.list.find(function(x){ return Number(x.id) === id; });
      titleDialog(p);
    };
  });
}

/** 任命弹窗：多选头衔 */
function titleDialog(p){
  if(!p) return;
  var S = STATE.titles;
  var cur = (p.titles || []).slice();

  var boxes = (S.allowed || []).map(function(t){
    var on = cur.indexOf(t) >= 0;
    return '<label class="tt-item' + (on ? ' on' : '') + '">'
      + '<input type="checkbox" value="' + attr(t) + '"' + (on ? ' checked' : '') + '>'
      + '<span>' + esc(t) + '</span></label>';
  }).join('');

  openModal({
    title: '任命头衔 · ' + (p.name || '该同学'),
    body: '<div class="alert info" style="margin-bottom:14px;font-size:.8rem">'
        +   '勾选要授予的职务，可多选。取消全部勾选＝撤销所有头衔。<br>'
        +   '<b>课代表</b>（含各科课代表）可以修改云端作业。</div>'
        + '<div class="tt-grid" id="ttGrid">' + boxes + '</div>',
    foot: '<button class="btn btn-secondary" data-close>取消</button>'
        + '<button class="btn" id="ttSave">保存</button>',
  });

  /* 点卡片即切换勾选状态，手机上更好点 */
  Array.prototype.forEach.call(document.querySelectorAll('#ttGrid .tt-item'), function(el){
    el.onclick = function(ev){
      var cb = el.querySelector('input');
      if(ev.target !== cb) cb.checked = !cb.checked;
      setTimeout(function(){ el.classList.toggle('on', cb.checked); }, 0);
    };
  });

  var saveBtn = $('ttSave');
  if(saveBtn) saveBtn.onclick = function(){
    var picked = [];
    Array.prototype.forEach.call($('ttGrid').querySelectorAll('input:checked'), function(i){
      picked.push(i.value);
    });
    api('/admin?action=set-title', { method:'POST', body:{ id: p.id, titles: picked } })
      .then(function(j){
        closeModal();
        toast(j.message || '已保存', 'ok', 3200);
        loadTitles();
      })
      .catch(function(e){ toast('保存失败：' + e.message, 'err', 4200); });
  };
  var cancelBtn = document.querySelector('#modalBox [data-close]');
  if(cancelBtn) cancelBtn.onclick = closeModal;
}

/* ============================================================================
 * ⑪-C 面板：作业管理（2026-10-05 新增）
 * ---------------------------------------------------------------------------
 * 需求「作业全部上云，后台可以查可以修改」。
 *
 * 云端字段：holiday_homeworks（假期作业）+ homework_notice（作业通知）
 * 这两项也在内容管理里，本面板是更好用的专用编辑界面。
 *
 * ⚠️ 兜底原则：云端为空时主站会退回 index.html 里写死的作业，
 *    不会出现「云端一空全班看不到作业」。所以这里删空是安全的。
 * ========================================================================= */
function renderHomeworks(){
  $('view').innerHTML =
    '<div class="toolbar" style="background:var(--panel)">'
    +   '<button class="btn btn-sm" id="hwAdd">' + svg('plus', 14) + '新增作业</button>'
    +   '<span style="flex:1"></span>'
    +   '<button class="btn btn-sm btn-secondary" id="hwRefresh">' + svg('refresh', 14) + '刷新</button>'
    + '</div>'
    + '<div class="alert info" style="margin-bottom:16px">'
    +   '<b>要新增某个日期的作业</b>：点左上角「＋ 新增作业」→ 填标题（如「国庆假期作业」）、'
    +   '开始 / 结束日期 → 逐科添加任务 → 保存。到日子同学打开「作业」就能看到，日期过了自动归档。<br>'
    +   '每条任务下面可以单独挂<b>图片 / 音频 / 视频链接</b>（填直链），挂在哪条就显示在哪个任务下面。<br>'
    +   '附件文件由站主统一上传到仓库后给出链接，后台不提供直接上传。<br>'
    +   '日常改本科目作业不用进后台——课代表在自己科目的作业卡上点 ✏️ 即可（只能改自己那科）。'
    + '</div>'
    + '<section class="panel">'
    +   '<h3 style="margin:0 0 10px;font-size:.9rem">📌 作业通知</h3>'
    +   '<textarea id="hwNotice" class="inp" rows="3" placeholder="例如：本周作业已更新，请及时完成"></textarea>'
    +   '<div style="text-align:right;margin-top:10px"><button class="btn btn-sm" id="hwNoticeSave">保存通知</button></div>'
    + '</section>'
    + '<section class="panel" style="margin-top:16px"><div id="hwBody"><div class="loading"><div class="spinner"></div>加载中…</div></div></section>';

  $('hwAdd').onclick    = function(){ hwDialog(null); };
  $('hwRefresh').onclick = function(){ loadHomeworks(); };
  $('hwNoticeSave').onclick = function(){
    var t = $('hwNotice').value;
    api('/content', { method:'PUT', body:{ items:{ homework_notice:{ text: t } } } })
      .then(function(){ toast('作业通知已保存', 'ok', 3000); })
      .catch(function(e){ toast('保存失败：' + e.message, 'err', 4200); });
  };

  loadHomeworks();
}

function loadHomeworks(){
  var S = STATE.homeworks;
  api('/content').then(function(j){
    var items = (j && j.items) || {};
    S.list = Array.isArray(items.holiday_homeworks) ? items.holiday_homeworks : [];
    var n = items.homework_notice;
    S.notice = (n && typeof n === 'object') ? (n.text || '') : String(n || '');
    paintHomeworks();
  }).catch(function(e){
    var b = $('hwBody');
    if(b) b.innerHTML = '<div class="empty">' + svg('alert', 34) + '<p>加载失败：' + esc(e.message) + '</p></div>';
  });
}

function paintHomeworks(){
  var S = STATE.homeworks;
  var body = $('hwBody');
  if(!body) return;
  var noticeEl = $('hwNotice');
  if(noticeEl && !noticeEl.value) noticeEl.value = S.notice || '';

  if(!S.list.length){
    body.innerHTML = '<div class="empty">' + svg('file', 38) + '<p>云端还没有作业</p>'
      + '<p class="muted" style="font-size:.78rem">同学那边会继续看到站点内置的作业内容</p></div>';
    return;
  }

  /* ⚠️ 呈现方式（2026-10-06 改）：
     旧版表格只有「标题 / 科目 / 截止 / 更新时间」，**完全没有正文**。
     用户看到的「作业显示不出来 / 显示不全」，根子就在这儿——
     数据一直都在（主站三条渲染路径实测全通），是后台压根没把它画出来。
     现在每行列出内容摘要，正文和科目明细进「查看」弹窗。 */
  body.innerHTML = '<div class="rec-list">' + S.list.map(function(h, i){
    var t = h.updatedAt ? ago(h.updatedAt) : '—';
    var sum = hwSummary(h);
    /* 主站结构的作业没有 due，用 start~end 区间；都靠不到才显示「未设置」。
       以前这里无脑显示「截止 —」，管理员会以为数据丢了。 */
    var when = h.due
      ? '截止 ' + h.due
      : (h.start || h.end ? (h.start || '?') + ' ~ ' + (h.end || '?') : '未设置时间');
    return '<div class="rec">'
      + '<div class="rec-main">'
      +   '<div class="rec-top">'
      +     (h.subject ? '<span class="badge badge-blue">' + esc(h.subject) + '</span>' : '')
      +     '<b>' + esc(h.title || '(未命名)') + '</b>'
      +   '</div>'
      +   '<div class="rec-meta">'
      +     '<span>' + svg('clock', 12) + esc(when) + '</span>'
      +     '<span>' + svg('refresh', 12) + esc(t) + '</span>'
      +     (sum ? '<span>' + svg('file', 12) + esc(sum) + '</span>' : '')
      +   '</div>'
      + '</div>'
      + '<div class="rec-act">'
      +   '<button class="view" data-hw-view="' + i + '">' + svg('eye', 14) + '查看</button>'
      +   '<button data-hw-edit="' + i + '">' + svg('edit', 14) + '编辑</button>'
      +   '<button class="danger" data-hw-del="' + i + '">' + svg('trash', 14) + '删除</button>'
      + '</div></div>';
  }).join('') + '</div>';

  bindAll(body, '[data-hw-view]', 'hwView', function(i){ hwViewDialog(S.list[i]); });
  bindAll(body, '[data-hw-edit]', 'hwEdit', function(i){ hwDialog(i); });
  bindAll(body, '[data-hw-del]',  'hwDel',  function(i){ hwDelete(i); });
}

/**
 * 一句话概括一条作业里到底写了什么。
 * 支持两种形态：
 *   ① 后台编辑用的扁平结构 { subject, title, content }
 *   ② 主站 holidayHomeworks 的结构 { items:[{subject, tasks:[]}] }
 * 第 ② 种是主站在用的，后台以前完全不认，所以显示得像空的。
 */
function hwItemsOf(h){
  if(!h) return [];
  if(Array.isArray(h.items) && h.items.length) return h.items;
  /* 扁平结构打包成统一形状，下面的渲染器只认这一种 */
  if(h.subject || h.content){
    return [{ subject: h.subject || '未分科', tasks: h.content ? [h.content] : [] }];
  }
  return [];
}

function hwSummary(h){
  var items = hwItemsOf(h);
  if(!items.length) return '';
  var subj = items.map(function(x){ return x.subject; }).filter(Boolean);
  var n = items.reduce(function(a, x){ return a + ((x.tasks || []).length); }, 0);
  return subj.length + ' 个科目 · ' + n + ' 条任务';
}

/** 作业只读详情弹窗：科目分组 + 每条任务全文，图片/音频也标出来。 */
function hwViewDialog(h){
  if(!h) return;
  var items = hwItemsOf(h);

  var meta =
    '<dl class="view-kv">'
    + '<dt>标题</dt><dd>' + esc(h.title || '(未命名)') + '</dd>'
    + (h.subject ? '<dt>科目</dt><dd>' + esc(h.subject) + '</dd>' : '')
    + '<dt>截止</dt><dd>' + esc(h.due || '未设置') + '</dd>'
    + (h.start || h.end ? '<dt>区间</dt><dd>' + esc((h.start || '?') + ' ~ ' + (h.end || '?')) + '</dd>' : '')
    + (h.updatedAt ? '<dt>更新</dt><dd>' + esc(fmt(h.updatedAt)) + '</dd>' : '')
    + '</dl>';

  var content = '';
  if(items.length){
    content = items.map(function(it){
      var tasks = (it.tasks || []).map(function(t){
        /* 任务可以是字符串，也可以是 {text, img, audio, audioLabel} */
        if(t && typeof t === 'object'){
          var line = esc(t.text || '(未填写文字)');
          var extra = '';
          if(t.img) extra += ' <span class="badge badge-gray">图片</span>';
          if(t.audio) extra += ' <span class="badge badge-gray">' + esc(t.audioLabel || '音频') + '</span>';
          return '<li>' + line + extra + '</li>';
        }
        return '<li>' + esc(String(t)) + '</li>';
      }).join('');
      if(!tasks) tasks = '<li class="muted">（这个科目还没写任务）</li>';
      return '<div class="hwv-subj"><h4>' + esc(it.subject || '未分科') + '</h4><ul>' + tasks + '</ul></div>';
    }).join('');
  } else if(h.content){
    content = '<div class="view-body">' + esc(h.content) + '</div>';
  } else {
    content = '<div class="empty" style="padding:26px">' + svg('file', 30)
            + '<p>这条作业没有正文</p>'
            + '<p class="muted" style="font-size:.78rem">点「去编辑」补上内容</p></div>';
  }

  openModal({
    title: '查看作业',
    sub: h.title || '(未命名)',
    wide: true,
    body: meta + (items.length ? '<div class="view-body">' + content + '</div>' : content),
    foot: '<button class="btn btn-ghost" data-hv-close>关闭</button>'
        + '<button class="btn" id="hvEdit">' + svg('edit', 14) + ' 去编辑</button>',
    onMount: function(box){
      box.querySelector('[data-hv-close]').onclick = closeModal;
      box.querySelector('#hvEdit').onclick = function(){
        var idx = STATE.homeworks.list.indexOf(h);
        closeModal();
        if(idx >= 0) hwDialog(idx);
      };
    }
  });
}

/* ============================================================
 * 作业编辑器（2026-10-07 重写）
 * ------------------------------------------------------------
 * 旧编辑器写的是扁平形态 { title, subject, due, content }，
 * 而主站真正消费的是 { id, start, end, title, items:[{subject, tasks:[]}] }。
 * 两套形态对不上 → 站主在后台「新增作业」填完，同学那边根本看不到，
 * 看起来就像「新增了但没生效」。现在统一按主站形态编辑。
 *
 * 附件（图片 / 音频）挂在哪条任务上，同学就看到它跟哪条任务在一起
 * ——也就是「这张图对应数学的第 2 个作业」这种要求。
 * ============================================================ */
function hwToDraft(h){
  if(!h) return { id:'', title:'', start:'', end:'', subjects:[] };
  if(Array.isArray(h.items) && h.items.length){
    return {
      id: h.id || '', title: h.title || '', start: h.start || '', end: h.end || '',
      subjects: h.items.map(function(it){
        return {
          name: it.subject || '',
          tasks: (it.tasks || []).map(function(t){
            if(t && typeof t === 'object'){
              return { text: t.text || '', img: t.img || '', audio: t.audio || '', video: t.video || '', audioLabel: t.audioLabel || '' };
            }
            return { text: String(t == null ? '' : t), img:'', audio:'', video:'', audioLabel:'' };
          }),
        };
      }),
    };
  }
  /* 老扁平数据：转成一个科目一条任务，保存后自动升级成主站形态 */
  return {
    id: h.id || '', title: h.title || '', start: h.start || '', end: h.end || '',
    subjects: (h.subject || h.content)
      ? [{ name: h.subject || '', tasks: [{ text: h.content || '', img:'', audio:'', video:'', audioLabel:'' }] }]
      : [],
  };
}

function hwDraftToItem(d, raw){
  var item = Object.assign({}, raw || {});
  item.id    = d.id || (raw && raw.id) || ('hw-' + Date.now().toString(36));
  item.title = d.title.trim();
  item.start = d.start;
  item.end   = d.end;
  item.items = d.subjects.map(function(s){
    return {
      subject: s.name.trim() || '未分科',
      tasks: s.tasks.map(function(t){
        var txt = (t.text || '').trim();
        /* 没图没音频没视频就存字符串（和主站既有数据保持一致，纯文本任务占大多数） */
        if(!t.img && !t.audio && !t.video) return txt;
        var o = { text: txt };
        if(t.img)   o.img = t.img.trim();
        if(t.audio){ o.audio = t.audio.trim(); o.audioLabel = (t.audioLabel || '').trim() || '播放听力音频'; }
        if(t.video) o.video = t.video.trim();
        return o;
      }).filter(function(t){
        return (typeof t === 'string') ? t.length > 0 : !!(t.text || t.img || t.audio || t.video);
      }),
    };
  }).filter(function(it){ return it.tasks.length; });
  item.updatedAt = new Date().toISOString();
  /* 老扁平字段清掉，免得主站读的时候两套字段打架 */
  delete item.subject; delete item.content; delete item.due;
  return item;
}

function hwTaskHtml(t, si, ti){
  return '<div class="hwed-task">'
    + '<input class="hwed-text" data-si="' + si + '" data-ti="' + ti + '" data-f="text"'
    +   ' value="' + attr(t.text || '') + '" placeholder="任务内容，一行一条" maxlength="300">'
    + '<button class="hwed-x" data-del-task="' + si + '.' + ti + '" title="删除这条任务">×</button>'
    + '<input class="hwed-media" data-si="' + si + '" data-ti="' + ti + '" data-f="img"'
    +   ' value="' + attr(t.img || '') + '" placeholder="🖼 图片链接（可选）：填直链，如 https://… / ./homework/xxx.jpg" maxlength="400">'
    + '<input class="hwed-media" data-si="' + si + '" data-ti="' + ti + '" data-f="audio"'
    +   ' value="' + attr(t.audio || '') + '" placeholder="🎧 音频链接（可选）：填直链，如 https://….mp3" maxlength="400">'
    + '<input class="hwed-media" data-si="' + si + '" data-ti="' + ti + '" data-f="video"'
    +   ' value="' + attr(t.video || '') + '" placeholder="🎬 视频链接（可选）：填直链，如 https://….mp4" maxlength="400">'
    + '</div>';
}

function hwSubjHtml(s, si){
  return '<div class="hwed-subj">'
    + '<div class="hwed-subj-head">'
    +   '<input class="hwed-name" data-si="' + si + '" value="' + attr(s.name || '') + '"'
    +     ' placeholder="科目名，如 数学" maxlength="12">'
    +   '<button class="btn btn-sm btn-secondary" data-del-subj="' + si + '">删除科目</button>'
    + '</div>'
    + '<div class="hwed-tasks">'
    +   (s.tasks.length
          ? s.tasks.map(function(t, ti){ return hwTaskHtml(t, si, ti); }).join('')
          : '<div class="muted" style="font-size:.78rem;padding:2px 0 6px">这个科目还没有任务</div>')
    + '</div>'
    + '<button class="btn btn-sm btn-ghost" data-add-task="' + si + '">+ 添加一条任务</button>'
    + '</div>';
}

function hwPaintEd(){
  var S = STATE.homeworks;
  var d = S.draft;
  var box = $('hwEd');
  if(!box || !d) return;

  box.innerHTML =
      '<div class="field"><label>作业标题</label>'
    +   '<input id="hwedTitle" maxlength="60" placeholder="例如：国庆假期作业（10.1–10.7）" value="' + attr(d.title) + '"></div>'
    + '<div class="field-row">'
    +   '<div class="field"><label>开始日期</label><input id="hwedStart" type="date" value="' + attr(d.start) + '"></div>'
    +   '<div class="field"><label>结束日期</label><input id="hwedEnd" type="date" value="' + attr(d.end) + '"></div>'
    + '</div>'
    + '<div class="alert info" style="font-size:.78rem;margin:0 0 12px">'
    +   '任务一行一条。<b>图片 / 音频填直链</b>（外链，或仓库里的相对路径如 '
    +   '<code>./homework/xxx.jpg</code>）——填在哪条任务上，同学就看到它跟哪条任务在一起，'
    +   '比如「数学第 2 条任务」下面挂一张图。</div>'
    + '<div id="hwedSubs">' + (d.subjects.length ? d.subjects.map(hwSubjHtml).join('') : '') + '</div>'
    + '<button class="btn btn-sm btn-secondary" id="hwedAddSubj">+ 添加科目</button>';

  var t = $('hwedTitle'); if(t) t.oninput = function(){ d.title = this.value; };
  var s1 = $('hwedStart'); if(s1) s1.onchange = function(){ d.start = this.value; };
  var e1 = $('hwedEnd');   if(e1) e1.onchange = function(){ d.end = this.value; };

  Array.prototype.forEach.call(box.querySelectorAll('.hwed-name'), function(el){
    el.oninput = function(){ var s = d.subjects[+el.dataset.si]; if(s) s.name = el.value; };
  });
  Array.prototype.forEach.call(box.querySelectorAll('input[data-f]'), function(el){
    el.oninput = function(){
      var s = d.subjects[+el.dataset.si]; if(!s) return;
      var t2 = s.tasks[+el.dataset.ti];   if(!t2) return;
      t2[el.dataset.f] = el.value;
    };
  });
  Array.prototype.forEach.call(box.querySelectorAll('[data-del-subj]'), function(b){
    b.onclick = function(){ d.subjects.splice(+b.dataset.delSubj, 1); hwPaintEd(); };
  });
  Array.prototype.forEach.call(box.querySelectorAll('[data-add-task]'), function(b){
    b.onclick = function(){
      var s = d.subjects[+b.dataset.addTask]; if(!s) return;
      s.tasks.push({ text:'', img:'', audio:'', video:'', audioLabel:'' });
      hwPaintEd();
    };
  });
  Array.prototype.forEach.call(box.querySelectorAll('[data-del-task]'), function(b){
    b.onclick = function(){
      var p = String(b.dataset.delTask).split('.');
      var s = d.subjects[+p[0]]; if(!s) return;
      s.tasks.splice(+p[1], 1);
      hwPaintEd();
    };
  });
  var addS = $('hwedAddSubj');
  if(addS) addS.onclick = function(){
    d.subjects.push({ name:'', tasks:[{ text:'', img:'', audio:'', video:'', audioLabel:'' }] });
    hwPaintEd();
  };
}

function hwDialog(idx){
  var S = STATE.homeworks;
  var isNew = (idx === null || idx === undefined);
  var raw = isNew ? null : (S.list[idx] || {});
  S.draft = hwToDraft(raw);

  openModal({
    title: isNew ? '新增作业' : '编辑作业',
    sub: isNew ? '按日期区间新增，同学到日子就能看到' : (raw.title || ''),
    wide: true,
    body: '<div id="hwEd"></div>',
    foot: '<button class="btn btn-secondary" data-close>取消</button>'
        + '<button class="btn" id="hwSave">保存</button>',
  });
  hwPaintEd();

  var sv = $('hwSave');
  if(sv) sv.onclick = function(){
    var d = S.draft;
    if(!d.title.trim()){ toast('请先填作业标题', 'err'); return; }
    if(!d.start || !d.end){ toast('请填开始日期和结束日期', 'err'); return; }
    if(d.start > d.end){ toast('开始日期不能晚于结束日期', 'err'); return; }
    var ok2 = d.subjects.some(function(s){
      return s.name.trim() && s.tasks.some(function(t){
        /* ⚠️ 这里必须把 video 也算上：只判 text/img/audio 的话，
           一条「只挂了视频」的任务会被判成空任务，
           整份作业保存时报「至少要有一个科目名和一条任务」——
           明明填了东西却说没有，用户根本猜不到是漏了这个字段。 */
        return (t.text || '').trim() || t.img || t.audio || t.video;
      });
    });
    if(!ok2){ toast('至少要有一个科目名和一条任务', 'err'); return; }

    var item = hwDraftToItem(d, raw);
    var next = S.list.slice();
    if(isNew) next.push(item); else next[idx] = item;
    api('/content', { method:'PUT', body:{ items:{ holiday_homeworks: next } } })
      .then(function(){
        closeModal();
        toast(isNew ? '已新增作业，同学刷新即可看到' : '已保存', 'ok', 3200);
        loadHomeworks();
      })
      .catch(function(e){ toast('保存失败：' + e.message, 'err', 4200); });
  };
  var cb = document.querySelector('#modalBox [data-close]');
  if(cb) cb.onclick = closeModal;
}

function hwDelete(idx){
  var S = STATE.homeworks;
  var h = S.list[idx];
  if(!h) return;
  confirmBox({
    title: '删除作业',
    html: '确定要删除 <b>' + esc(h.title || '(未命名)') + '</b> 吗？',
    detail: '同学那边将不再看到这条作业。',
    danger: true,
    okText: '确认删除',
  }).then(function(ok){
    if(!ok) return;
    var next = S.list.slice();
    next.splice(idx, 1);
    api('/content', { method:'PUT', body:{ items:{ holiday_homeworks: next } } })
      .then(function(){ toast('已删除', 'ok'); loadHomeworks(); })
      .catch(function(e){ toast('删除失败：' + e.message, 'err', 4200); });
  });
}

/* ============================================================================
 * ⑪-D 面板：点歌管理（2026-10-06 改为直连 VoiceHub 实时数据）
 * ---------------------------------------------------------------------------
 * 需求变更：「后台的点歌面板应该改成直连 VoiceHub 实时数据」。
 *
 * 之前这里读的是云端 song_config 字段 —— 那是个**空头字段**：主站从来没写过它，
 * 同学点歌时用的是主站内置逻辑 + VoiceHub 平台数据。所以后台永远显示
 * 「云端还没有歌单配置」，看着像坏了，其实是数据源压根就选错了。
 *
 * 现在的数据源：VoiceHub 开放 API（与主站 index.html 同一个平台、同一把 key）
 *   base            https://xsyzc2505.dpdns.org/api/open
 *   鉴权            请求头 x-api-key
 *   歌单            GET  /songs?page=1&limit=100    → { data:{ songs, pagination } }
 *   发券            POST /card-codes                → { data:{ cardCodes } }
 *   删券            DELETE /card-codes?id=XX
 *
 * ⚠️ 密钥不明文写：admin.html 也是公开页面（GitHub Pages 上人人可看源码）。
 *    这里复用主站的 xor 混淆方案 —— 密文写死，运行时用 XOR_KEY 解出来。
 *    注意这只防「随手翻源码看见」，**不是加密**，别拿它当真正的保密手段。
 *
 * ⚠️ CORS：VoiceHub 那边的白名单是硬编码在 fork 仓库
 *    yuzikaaang/VoiceHub 的 server/middleware/api-0-open-cors.ts 里的，
 *    已含 https://yuzikaaang.github.io。换域名部署前要先改那边，否则全部请求被拦。
 * ========================================================================= */

var VH_API      = 'https://xsyzc2505.dpdns.org/api/open';
var VH_XOR_KEY  = 'cls2505-xor-key-2026';
/* 以下两串是 xor 之后的密文（key = VH_XOR_KEY），解开才是真正的 vhub_xxx */
var VH_DJ_KEY_ENC = 'FQQGUGoJAxsbC0oVCVBNTwRWAQYHChAEAAEGSRoNFxwJUhgaBA==';
var VH_CP_KEY_ENC = 'FQQGUGoAUUtMWxccWgNAGwYHAwQBVBUBUwQHSExWRB8OBk4VBA==';

/* ---- 是否在后台直连平台。想临时关掉（比如平台挂了）把这里置 false ---- */
var VH_ENABLED = true;

function vhXorDecrypt(cipher){
  var bin = atob(cipher);
  var enc = new TextEncoder();
  var kb  = Array.prototype.slice.call(enc.encode(VH_XOR_KEY));
  var bytes = [];
  for(var i = 0; i < bin.length; i++) bytes.push(bin.charCodeAt(i) ^ kb[i % kb.length]);
  return new TextDecoder().decode(new Uint8Array(bytes));
}
function vhDjKey(){ try{ return vhXorDecrypt(VH_DJ_KEY_ENC); }catch(e){ return ''; } }
function vhCpKey(){ try{ return vhXorDecrypt(VH_CP_KEY_ENC); }catch(e){ return ''; } }

/** 点歌人字段兼容：平台可能返回字符串，也可能是 {name} 对象 */
function vhReqName(s){
  var r = (typeof s.requester === 'string') ? s.requester : ((s.requester && s.requester.name) || '');
  return String(r == null ? '' : r).trim();
}

/** v3.5.19：解析平台时间。
 *  ⚠️ 这个实例给的是 `2026/6/6 21:44:48`（斜杠 + 本地时间），不是 ISO；
 *     直接 new Date() 在部分浏览器会 Invalid，点歌时间就显示不出来。 */
function vhParseTime(x){
  if(!x) return null;
  if(x instanceof Date) return isNaN(x.getTime()) ? null : x;
  var s = String(x).trim();
  var m = s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if(m){
    var d0 = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    return isNaN(d0.getTime()) ? null : d0;
  }
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** 平台时间 → 本地 YYYY-MM-DD HH:mm */
function vhFmtTime(iso){
  if(!iso) return '';
  var d = vhParseTime(iso);
  if(!d) return String(iso).slice(0, 16).replace('T', ' ');
  function p(n){ return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
       + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 拉全量歌单（平台分页，第一页拿到总页数后再并发拉其余页）。
 *  v3.5.19：加一层本地缓存 —— 站主要求「网络问题导致获取不了则展示缓存，
 *  直至下次重新获取」。成功就刷新缓存，失败就回退缓存（没有缓存才报错）。 */
function vhFetchSongs(){
  var KEY = 'cls_vh_songs_cache_v1';
  function readCache(){
    try{
      var raw = sessionStorage.getItem(KEY);
      if(!raw) return null;
      var o = JSON.parse(raw);
      return (o && Array.isArray(o.list) && o.list.length) ? o.list : null;
    }catch(e){ return null; }
  }
  function writeCache(list){
    try{ sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), list: list })); }catch(e){}
  }
  return vhFetchSongsRaw().then(function(list){
    if(Array.isArray(list) && list.length) writeCache(list);
    return vhFillDurations(list);
  }).catch(function(err){
    var cached = readCache();
    if(cached){
      console.warn('[vh] 实时歌单获取失败，使用缓存：', err && err.message);
      return vhFillDurations(cached);
    }
    throw err;
  });
}

/* v3.5.20 → v3.5.27：VoiceHub 的 durationSeconds 全是 null（实例没填时长）。
   ------------------------------------------------------------
   站主 v3.5.27 原话：「一定要获取到歌曲时长并同步云端，省的每次都要加载，
   渠道有网易云和 QQ 音乐，如果两个都没有找到由我人工填写，
   否则无法发布投票或者随机排歌」。

   因此分成三层：
     ① 云端时长库（song_durations 表）：/api/music?action=lib 一次拉全量，
        本地按 key 命中 —— **换设备、清缓存都还在**，不用每次开页面重新搜。
     ② 库里没有的，批量问 /api/music（服务端查网易云 → QQ 音乐 → iTunes 兜底），
        查到就自动写进云端库，下次直接命中。
     ③ 还是查不到的（DUR_MISS），开后台时弹「时长补录」，站主手填秒数后写库
        （source='manual'，优先级最高，不会被后面的自动结果覆盖）。

   ⚠️ 歌单投票发布 / 抽歌排期前会校验时长，缺口存在就不放行（后端也拦一道）。
   ------------------------------------------------------------ */
var DUR_LIB_KEY = 'cls_song_dur_v1';          /* 老版本本地缓存，仍作第一层快查 */
var DUR_LIB_AT = 'cls_song_dur_at_v1';
var DUR_LIB_TTL = 10 * 60 * 1000;             /* 本地副本 10 分钟回源一次 */
var DUR_MISS = {};                            /* key -> { title, artist } 待人工补录 */

function vhDurationCache(){
  try{ return JSON.parse(localStorage.getItem(DUR_LIB_KEY) || '{}') || {}; }catch(e){ return {}; }
}
function vhDurationKey(title, artist){
  /* 与后端 libKey 一致：去括号、空格、连字符、大小写 —— 同一首歌换个写法也命中 */
  function n(x){
    return String(x == null ? '' : x)
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/[\s·・\-—_]/g, '')
      .toLowerCase();
  }
  return n(title) + '|' + n(artist);
}
function vhSaveDurCache(cache){
  try{ localStorage.setItem(DUR_LIB_KEY, JSON.stringify(cache)); }catch(e){}
}
/** 秒 → m:ss（0 / 空返回空串）。v3.5.27：全站唯一一份（原来重复定义过两处） */
function voFmtDur(sec){
  var n = Math.round(Number(sec) || 0);
  if(!n) return '';
  var m = Math.floor(n / 60), s = n % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

/** ① 从云端拉全量时长库，合并进本地副本（一次请求，返回 Promise<Object>） */
function vhDurLibPull(force){
  var cache = vhDurationCache();
  var at = 0;
  try{ at = Number(localStorage.getItem(DUR_LIB_AT) || 0); }catch(e){}
  if(!force && at && (Date.now() - at < DUR_LIB_TTL)) return Promise.resolve(cache);
  return api('/music?action=lib').then(function(j){
    var list = (j && j.list) || [];
    list.forEach(function(r){
      if(r && r.seconds > 0){
        var k = r.key || vhDurationKey(r.title, r.artist);
        cache[k] = Number(r.seconds);
      }
    });
    vhSaveDurCache(cache);
    try{ localStorage.setItem(DUR_LIB_AT, String(Date.now())); }catch(e){}
    return cache;
  }).catch(function(){ return cache; });      /* 拉不到就用本地副本，不阻塞 */
}

/** ② 缺的批量问服务端（8 首一批），命中的自动写云 */
function vhDurAskCloud(need){
  if(!need.length) return Promise.resolve();
  var chunks = [];
  for(var i = 0; i < need.length; i += 8) chunks.push(need.slice(i, i + 8));
  var idx = 0;
  var step = function(){
    if(idx >= chunks.length) return Promise.resolve();
    var part = chunks[idx++];
    return api('/music', {
      method: 'POST',
      body: { action: 'batch', items: part.map(function(x){ return { title: x.title, artist: x.artist }; }) },
    }).then(function(j){
      (j && j.list || []).forEach(function(r){
        var sec = Number(r && r.seconds);
        if(sec > 0){
          var k = vhDurationKey(r.title, r.artist);
          var cache = vhDurationCache();
          cache[k] = sec;
          vhSaveDurCache(cache);
          var x = part.filter(function(y){ return vhDurationKey(y.title, y.artist) === k; })[0];
          if(x && x.song) x.song.durationSeconds = sec;
          delete DUR_MISS[k];
        }
      });
      return step();
    }).catch(function(){ return step(); });
  };
  return step();
}

/** 主入口：给歌单补齐时长。返回 Promise<list>，查不到的记进 DUR_MISS */
function vhFillDurations(list){
  if(!Array.isArray(list) || !list.length) return Promise.resolve(list);
  return vhDurLibPull().then(function(cache){
    var need = [];
    list.forEach(function(s){
      if(!s) return;
      var d = Number(s.durationSeconds) || 0;
      if(d > 0) return;                       /* 平台自己有，别覆盖 */
      var title = String(s.title || '').trim();
      if(!title) return;
      var artist = String(s.artist || '').trim();
      var key = vhDurationKey(title, artist);
      if(cache[key] > 0){
        s.durationSeconds = cache[key];
        return;
      }
      if(DUR_MISS[key]) return;
      need.push({ key: key, title: title, artist: artist, song: s });
    });
    if(!need.length) return list;
    /* 只对「本次真要用的歌」联网查：一次最多 40 首，避免开页面卡太久 */
    var ask = need.slice(0, 40);
    return vhDurAskCloud(ask).then(function(){
      var cache2 = vhDurationCache();
      need.forEach(function(x){
        if(Number(x.song.durationSeconds) > 0) return;
        if(cache2[x.key] > 0){ x.song.durationSeconds = cache2[x.key]; return; }
        /* 查不到 → 挂起，等站主人工补录 */
        DUR_MISS[x.key] = { title: x.title, artist: x.artist };
      });
      if(Object.keys(DUR_MISS).length) vhDurNotice();
      return list;
    });
  }).catch(function(){ return list; });
}

/** ③ 缺时长的歌：站主手填后写云端 */
function vhDurNotice(){
  var keys = Object.keys(DUR_MISS);
  if(!keys.length) return;
  var box = document.getElementById('djDurNotice');
  if(!box) return;
  box.style.display = '';
  box.innerHTML = '<div class="alert warn" style="margin:0 0 12px;line-height:1.8">'
    + '<b>有 ' + keys.length + ' 首歌还没拿到时长</b>（网易云、QQ 音乐都没搜到）。'
    + '<br>按站规：<b>时长为空不能发布投票、也不能随机排歌</b>，请点右边按钮人工填写。'
    + '<button class="btn btn-sm" id="djDurFill" style="margin-left:8px">补录时长</button>'
    + '</div>';
  var btn = document.getElementById('djDurFill');
  if(btn) btn.onclick = function(){ voDurManualDialog(keys); };
}

/** v3.5.28：时长库管理面板
 *  站主原话：「时长库那个里面呢也可以搜歌，就是直接线上搜歌，我搜歌名，
 *  然后匹配出对应的歌手和时间，然后我点击它就可以直接加到时长库。
 *  也可以直接导入，就是我导入歌名和歌手，如果拉取的歌单里面也有同样的
 *  歌名和歌手，只要相似就行 —— 歌名完全符合，歌手只要部分符合。
 *  我打算预先准备一些，你也可以自己先准备好，比如周杰伦的、林俊杰的、方大同的。」
 *
 *  于是分成四块（用 tab 切）：
 *    ① 已收录 —— 看库里有什么、删掉录错的
 *    ② 线上搜 —— 输歌名 → 网易云 / QQ 音乐候选列表 → 点「加入」直接写库
 *    ③ 导入清单 —— 一行「歌名 - 歌手」，批量查库；命中显示秒数，没命中可就地线上搜
 *    ④ 预置歌单 —— 周杰伦/林俊杰/方大同热门曲，一键联网抓时长批量入库
 */
function openDurLib(){
  var state = { tab: 'lib', lib: [], q: '', results: null, searching: false, imp: null };
  openModal({
    title: '🎵 歌曲时长库',
    sub: '存云端，全班设备共用；线上搜到点一下就能入库，也能整批导入歌名+歌手',
    wide: true,
    body: '<div id="durLibBody"><div class="loading"><div class="spinner"></div>同步中…</div></div>',
    foot: '<button class="btn btn-ghost" data-no>关闭</button>'
        + '<button class="btn btn-secondary" data-fill>补录缺时长的歌</button>',
    onMount: function(box){
      box.querySelector('[data-no]').onclick = closeModal;
      box.querySelector('[data-fill]').onclick = function(){
        var miss = Object.keys(DUR_MISS);
        if(!miss.length){ toast('当前没有缺时长的歌', 'ok'); return; }
        closeModal();
        voDurManualDialog(miss);
      };
      var host = box.querySelector('#durLibBody');
      host.__state = state;
      host.__reload = function(){ return vhDurLibPull(true).then(function(){ return api('/music?action=lib'); })
        .then(function(j){ state.lib = (j && j.list) || []; })
        .catch(function(e){ state.lib = state.lib || []; toast('读取时长库失败：' + (e.message || e), 'err', 4000); }); };
      host.__reload().then(function(){ paintDurLib(host); });
    },
  });
}

/* ---------- v3.5.28 时长库面板：四个 tab 共用的渲染 ---------- */
var DUR_SRC_TXT = { manual: '人工', netease: '网易云', qq: 'QQ 音乐', itunes: 'iTunes', auto: '自动' };

/** 面板外壳 + 按当前 tab 渲染内容（每次操作后整块重绘，简单可靠） */
function paintDurLib(host){
  if(!host) return;
  var st = host.__state || { tab: 'lib', lib: [] };
  var lib = st.lib || [];
  var miss = Object.keys(DUR_MISS);

  var tabs = [
    ['lib', '已收录 ' + lib.length],
    ['search', '线上搜'],
    ['import', '导入清单'],
    ['preset', '预置歌单'],
  ];
  var tabBar = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px">'
    + tabs.map(function(t){
        var on = st.tab === t[0];
        return '<button class="btn btn-sm ' + (on ? '' : 'btn-ghost') + '" data-tab="' + t[0] + '"'
          + (on ? ' style="pointer-events:none"' : '') + '>' + esc(t[1]) + '</button>';
      }).join('')
    + '</div>';

  var body;
  if(st.tab === 'lib') body = durLibViewLib(lib, miss);
  else if(st.tab === 'search') body = durLibViewSearch(st);
  else if(st.tab === 'import') body = durLibViewImport(st);
  else body = durLibViewPreset(st);

  host.innerHTML = tabBar + body;

  /* tab 切换 */
  Array.prototype.forEach.call(host.querySelectorAll('[data-tab]'), function(b){
    b.onclick = function(){ st.tab = b.getAttribute('data-tab'); paintDurLib(host); };
  });
  if(st.tab === 'lib') wireDurLibRows(host, st);
  else if(st.tab === 'search') wireDurLibSearch(host, st);
  else if(st.tab === 'import') wireDurLibImport(host, st);
  else wireDurLibPreset(host, st);
}

/* ---------- ① 已收录 ---------- */
function durLibViewLib(list, miss){
  var missHtml = miss.length
    ? '<div class="alert warn" style="margin:0 0 10px;font-size:.82rem">还有 <b>' + miss.length + '</b> 首没拿到时长，'
      + '点右下角「补录缺时长的歌」手填。</div>'
    : '<div class="alert info" style="margin:0 0 10px;font-size:.82rem">当前没有缺时长的歌。</div>';
  var rows = list.length
    ? list.map(function(r){
        return '<tr data-k="' + attr(r.key || '') + '">'
          + '<td style="padding:6px 8px">' + esc(r.title || '') + (r.artist ? ' <i class="muted" style="font-style:normal">· ' + esc(r.artist) + '</i>' : '') + '</td>'
          + '<td style="padding:6px 8px;white-space:nowrap;font-variant-numeric:tabular-nums">' + esc(voFmtDur(r.seconds)) + '</td>'
          + '<td style="padding:6px 8px;white-space:nowrap;font-size:.78rem;color:var(--fg-3)">' + esc(DUR_SRC_TXT[r.source] || r.source || '') + '</td>'
          + '<td style="padding:6px 8px;text-align:right">'
          +   '<button class="btn btn-sm btn-ghost" data-del style="color:#b3261e">删除</button>'
          + '</td></tr>';
      }).join('')
    : '<tr><td colspan="4" style="padding:14px;text-align:center" class="muted">库里还没有数据，去「线上搜」或「预置歌单」加一批</td></tr>';
  return missHtml
    + '<p class="muted" style="font-size:.78rem;margin:0 0 6px">共 ' + list.length + ' 首</p>'
    + '<div style="max-height:44vh;overflow:auto;border:1px solid var(--border);border-radius:var(--radius-md)">'
    +   '<table style="width:100%;font-size:.84rem"><tbody>' + rows + '</tbody></table>'
    + '</div>';
}

function wireDurLibRows(host, st){
  var list = st.lib || [];
  Array.prototype.forEach.call(host.querySelectorAll('tr[data-k] button[data-del]'), function(btn){
    btn.onclick = function(){
      var tr = btn.closest('tr');
      var k = tr.getAttribute('data-k');
      var t = (list.filter(function(x){ return x.key === k; })[0] || {});
      confirmBox({
        title: '从时长库删除',
        text: '删掉「' + (t.title || k) + '」的时长记录？下次用到时会重新联网查一遍。',
        danger: true, okText: '删除',
      }).then(function(yes){
        if(!yes) return;
        api('/music', { method: 'POST', body: { action: 'del', items: [{ title: t.title || '', artist: t.artist || '' }] } })
          .then(function(j){
            toast((j && j.message) || '已删除', 'ok');
            var cache = vhDurationCache();
            delete cache[k];
            vhSaveDurCache(cache);
            try{ localStorage.removeItem(DUR_LIB_AT); }catch(e){}
            st.lib = list.filter(function(x){ return x.key !== k; });
            paintDurLib(host);
          })
          .catch(function(e){ toast('删除失败：' + (e.message || e), 'err', 4000); });
      });
    };
  });
}

/* ---------- ② 线上搜 ---------- */
function durLibViewSearch(st){
  var head = '<div class="field" style="margin-bottom:12px">'
    + '<div style="display:flex;gap:8px">'
    +   '<input id="durLibQ" placeholder="输入歌名（可带歌手，如「晴天」或「晴天 周杰伦」）"'
    +     ' value="' + attr(st.q || '') + '" style="flex:1;padding:8px 12px;font-size:.86rem">'
    +   '<button class="btn btn-sm" id="durLibGo" style="white-space:nowrap;height:auto">' + (st.searching ? '搜索中…' : '线上搜') + '</button>'
    + '</div>'
    + '<p class="hint" style="margin:6px 0 0">网易云 + QQ 音乐一起搜，都没有才用 iTunes 兜底。'
    + '点「加入」直接把那一行的秒数写进云端库。</p></div>';

  if(st.searching && !st.results) return head + '<div class="loading"><div class="spinner"></div>联网搜索中…</div>';
  if(!st.results) return head + '<div class="alert info" style="font-size:.82rem">输个歌名点「线上搜」，下面会列出能查到的版本和时长。</div>';

  var list = st.results;
  if(!list.length) return head + '<div class="alert warn" style="font-size:.82rem">三个渠道都没搜到「' + esc(st.q) + '」，换个写法（去掉括号里的版本名）再试，或者直接手填。</div>';

  var rows = list.map(function(c, i){
    var badge = c.inLib
      ? '<b style="color:#15803d;font-size:.78rem">已在库 ' + esc(voFmtDur(c.libSeconds)) + '</b>'
      : '<button class="btn btn-sm" data-add="' + i + '">加入</button>';
    return '<tr data-i="' + i + '">'
      + '<td style="padding:6px 8px">' + esc(c.title)
      +   (c.album ? '<i class="muted" style="font-style:normal;font-size:.74rem"> · ' + esc(c.album) + '</i>' : '') + '</td>'
      + '<td style="padding:6px 8px;font-size:.8rem">' + esc(c.artist || '—') + '</td>'
      + '<td style="padding:6px 8px;white-space:nowrap;font-variant-numeric:tabular-nums">' + esc(voFmtDur(c.seconds)) + '</td>'
      + '<td style="padding:6px 8px;white-space:nowrap;font-size:.76rem;color:var(--fg-3)">' + esc(DUR_SRC_TXT[c.source] || c.source) + '</td>'
      + '<td style="padding:6px 8px;text-align:right;white-space:nowrap">' + badge + '</td>'
      + '</tr>';
  }).join('');

  return head
    + '<p class="muted" style="font-size:.78rem;margin:0 0 6px">搜到 ' + list.length + ' 条（已收录的排最前，歌名完全一致的优先）</p>'
    + '<div style="max-height:40vh;overflow:auto;border:1px solid var(--border);border-radius:var(--radius-md)">'
    +   '<table style="width:100%;font-size:.84rem"><tbody>' + rows + '</tbody></table>'
    + '</div>';
}

function wireDurLibSearch(host, st){
  var qEl = host.querySelector('#durLibQ');
  var goEl = host.querySelector('#durLibGo');
  var doSearch = function(){
    var q = String((qEl && qEl.value) || '').trim();
    if(!q){ toast('先输入歌名', 'err'); return; }
    st.q = q; st.searching = true; st.results = null;
    paintDurLib(host);
    api('/music?action=search&limit=20&q=' + encodeURIComponent(q))
      .then(function(j){
        st.results = (j && j.list) || [];
        st.searching = false;
        paintDurLib(host);
      })
      .catch(function(e){
        st.searching = false; st.results = [];
        paintDurLib(host);
        toast('搜索失败：' + (e.message || e), 'err', 4000);
      });
  };
  if(goEl) goEl.onclick = doSearch;
  if(qEl) qEl.onkeydown = function(e){ if(e.key === 'Enter'){ e.preventDefault(); doSearch(); } };

  Array.prototype.forEach.call(host.querySelectorAll('[data-add]'), function(btn){
    btn.onclick = function(){
      var c = (st.results || [])[Number(btn.getAttribute('data-add'))];
      if(!c) return;
      btn.disabled = true; btn.textContent = '写入中…';
      api('/music', { method: 'POST', body: { action: 'manual', items: [{ title: c.title, artist: c.artist, seconds: c.seconds }] } })
        .then(function(j){
          var k = vhDurationKey(c.title, c.artist);
          var cache = vhDurationCache();
          cache[k] = Number(c.seconds);
          vhSaveDurCache(cache);
          try{ localStorage.removeItem(DUR_LIB_AT); }catch(e){}
          c.inLib = true; c.libSeconds = Number(c.seconds);
          st.lib = [{ key: k, title: c.title, artist: c.artist, seconds: Number(c.seconds), source: 'manual' }].concat(st.lib || []);
          toast('已加入：《' + c.title + '》' + voFmtDur(c.seconds), 'ok');
          paintDurLib(host);
        })
        .catch(function(e){
          btn.disabled = false; btn.textContent = '加入';
          toast('加入失败：' + (e.message || e), 'err', 4000);
        });
    };
  });
}

/* ---------- ③ 导入清单 ---------- */
function durLibViewImport(st){
  var box = '<div class="field" style="margin-bottom:10px">'
    + '<label style="display:block;font-size:.8rem;font-weight:700;margin:0 0 6px">粘贴歌曲清单（一行一首）</label>'
    + '<textarea id="durImpText" rows="7" placeholder="晴天 - 周杰伦&#10;三人游 - 方大同&#10;江南,林俊杰&#10;（歌名和歌手之间用 - 、, 或 ｜ 隔开都行；只写歌名也行）"'
    +   ' style="width:100%;padding:8px 12px;font-size:.84rem;resize:vertical;font-family:inherit"></textarea>'
    + '<p class="hint" style="margin:6px 0 0">匹配规则：<b>歌名完全一致</b>（忽略空格、括号里的版本名），'
    + '<b>歌手部分符合即可</b> —— 比如歌单里是「周杰伦/费玉清」，你只写「周杰伦」也算命中。</p>'
    + '</div>'
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">'
    +   '<button class="btn btn-sm" id="durImpGo">导入并匹配时长库</button>'
    +   '<button class="btn btn-sm btn-ghost" id="durImpFill">把没命中的都线上搜一遍</button>'
    + '</div>';

  if(!st.imp) return box + '<div class="alert info" style="font-size:.82rem">导入只会<b>查</b>时长库，不会改库；'
    + '想把结果存下来点「加入」。</div>';

  var list = st.imp;
  var hit = list.filter(function(x){ return x.seconds > 0; }).length;
  var rows = list.map(function(x, i){
    var dur = x.seconds > 0
      ? '<b style="color:#15803d">' + esc(voFmtDur(x.seconds)) + '</b>'
        + (x.matchedArtist && x.matchedArtist !== x.artist ? '<i class="muted" style="font-style:normal;font-size:.72rem"> · ' + esc(x.matchedArtist) + '</i>' : '')
      : '<b style="color:#b45309">未收录</b>';
    var act = x.seconds > 0 ? '' : '<button class="btn btn-sm btn-ghost" data-imp-search="' + i + '" style="font-size:.74rem">线上搜</button>';
    return '<tr data-i="' + i + '">'
      + '<td style="padding:6px 8px">' + esc(x.title) + '</td>'
      + '<td style="padding:6px 8px;font-size:.8rem;color:var(--fg-2)">' + esc(x.artist || '—') + '</td>'
      + '<td style="padding:6px 8px;white-space:nowrap;font-variant-numeric:tabular-nums">' + dur + '</td>'
      + '<td style="padding:6px 8px;text-align:right;white-space:nowrap">' + act + '</td></tr>';
  }).join('');

  return box
    + '<div class="alert ' + (hit === list.length ? 'info' : 'warn') + '" style="font-size:.82rem;margin:0 0 10px">'
    +   '共 ' + list.length + ' 首，命中 <b>' + hit + '</b> 首，缺 <b>' + (list.length - hit) + '</b> 首'
    + '</div>'
    + '<div style="max-height:36vh;overflow:auto;border:1px solid var(--border);border-radius:var(--radius-md)">'
    +   '<table style="width:100%;font-size:.84rem"><tbody>' + rows + '</tbody></table>'
    + '</div>';
}

/** 解析一行「歌名 - 歌手」；返回 {title, artist} 或 null */
function durParseLine(line){
  var s = String(line || '').trim();
  if(!s) return null;
  /* 分隔符优先级：Tab > ｜ > | > - – — > , ， 、（后面必须跟空格或直接结束，避免切坏歌名里的连字符） */
  var m = s.match(/^(.*?)\t+(.*)$/);
  if(!m) m = s.match(/^(.*?)\s*[｜|]\s*(.*)$/);
  if(!m) m = s.match(/^(.*?)\s+[-–—]\s+(.*)$/);
  if(!m) m = s.match(/^(.*?)[,，、]\s*(.*)$/);
  if(m && m[1].trim()) return { title: m[1].trim(), artist: (m[2] || '').trim() };
  return { title: s, artist: '' };
}

function wireDurLibImport(host, st){
  var doMatch = function(){
    var ta = host.querySelector('#durImpText');
    var raw = String((ta && ta.value) || '');
    var items = raw.split(/\r?\n/).map(durParseLine).filter(Boolean);
    if(!items.length){ toast('先粘贴清单（一行一首）', 'err'); return; }
    if(items.length > 200){ toast('一次最多 200 首，多的分批导', 'err', 4000); items = items.slice(0, 200); }
    var go = host.querySelector('#durImpGo');
    if(go){ go.disabled = true; go.textContent = '匹配中…'; }
    api('/music', { method: 'POST', body: { action: 'match-list', items: items } })
      .then(function(j){
        st.imp = (j && j.list) || [];
        st.impRaw = raw;
        paintDurLib(host);
        toast('匹配完成：命中 ' + ((j && j.hit) || 0) + ' / ' + st.imp.length, 'ok');
      })
      .catch(function(e){
        if(go){ go.disabled = false; go.textContent = '导入并匹配时长库'; }
        toast('匹配失败：' + (e.message || e), 'err', 4000);
      });
  };
  var go = host.querySelector('#durImpGo');
  if(go) go.onclick = doMatch;
  var ta = host.querySelector('#durImpText');
  if(ta && st.impRaw) ta.value = st.impRaw;

  var fill = host.querySelector('#durImpFill');
  if(fill) fill.onclick = function(){
    var miss = (st.imp || []).filter(function(x){ return !(x.seconds > 0); });
    if(!miss.length){ toast('都命中了，没有要搜的', 'ok'); return; }
    closeModal();
    durImpLiveSearch(miss);
  };

  Array.prototype.forEach.call(host.querySelectorAll('[data-imp-search]'), function(btn){
    btn.onclick = function(){
      var x = (st.imp || [])[Number(btn.getAttribute('data-imp-search'))];
      if(!x) return;
      closeModal();
      durImpLiveSearch([x]);
    };
  });
}

/** 导入清单里没命中的 → 逐首联网搜（自动取「歌名归一后完全一致」的第一条，拿不到就记进待补录） */
function durImpLiveSearch(items){
  /* 简版进度：一个小弹窗列出每首的状态，逐条串行查（避免撞 Workers 子请求上限） */
  var hostList = items.map(function(x){ return { title: x.title, artist: x.artist, seconds: null, state: '待查' }; });
  openModal({
    title: '线上补时长',
    sub: '逐首查网易云 / QQ 音乐；查到自动写库，查不到的可以手填',
    wide: true,
    body: '<div id="durLiveBody"><div class="loading"><div class="spinner"></div>开始查询…</div></div>',
    foot: '<button class="btn btn-ghost" data-close2>关闭</button>',
    onMount: function(box){
      box.querySelector('[data-close2]').onclick = closeModal;
      var bodyEl = box.querySelector('#durLiveBody');
      var idx = 0;
      var paint = function(){
        var rows = hostList.map(function(x){
          var d = x.seconds > 0
            ? '<b style="color:#15803d">' + esc(voFmtDur(x.seconds)) + '</b>'
            : (x.state === '查不到' ? '<b style="color:#b45309">查不到</b>' : '<span class="muted">' + esc(x.state) + '</span>');
          return '<tr><td style="padding:6px 8px">' + esc(x.title) + '</td>'
            + '<td style="padding:6px 8px;font-size:.8rem;color:var(--fg-2)">' + esc(x.artist || '—') + '</td>'
            + '<td style="padding:6px 8px;white-space:nowrap">' + d + '</td></tr>';
        }).join('');
        bodyEl.innerHTML = '<div style="max-height:46vh;overflow:auto;border:1px solid var(--border);border-radius:var(--radius-md)">'
          + '<table style="width:100%;font-size:.84rem"><tbody>' + rows + '</tbody></table></div>';
      };
      var tick = function(){
        if(idx >= hostList.length){
          var miss = hostList.filter(function(x){ return !(x.seconds > 0); });
          try{ localStorage.removeItem(DUR_LIB_AT); }catch(e){}
          if(miss.length){
            DUR_MISS_RESET();
            miss.forEach(function(x){ DUR_MISS[vhDurationKey(x.title, x.artist)] = { title: x.title, artist: x.artist }; });
            toast('查不到 ' + miss.length + ' 首，可在「补录缺时长的歌」里手填', 'warn', 5000);
          } else {
            toast('全部补齐了', 'ok');
          }
          return;
        }
        var x = hostList[idx];
        x.state = '查询中…'; paint();
        var kw = (x.title + ' ' + (x.artist || '')).trim();
        api('/music?action=search&limit=10&q=' + encodeURIComponent(kw)).then(function(j){
          var cands = ((j && j.list) || []).filter(function(c){ return vhDurationKey(c.title, '') === vhDurationKey(x.title, ''); });
          if(!cands.length) cands = ((j && j.list) || []).filter(function(c){ return vhDurationKey(c.title, c.artist) === vhDurationKey(x.title, x.artist); });
          var best = cands[0];
          if(!best){ x.state = '查不到'; idx++; paint(); return tick(); }
          return api('/music', { method: 'POST', body: { action: 'save-many', items: [{ title: x.title, artist: x.artist || best.artist, seconds: best.seconds, source: best.source }] } })
            .then(function(){
              x.seconds = best.seconds;
              var cache = vhDurationCache();
              cache[vhDurationKey(x.title, x.artist)] = best.seconds;
              cache[vhDurationKey(x.title, best.artist)] = best.seconds;
              vhSaveDurCache(cache);
            })
            .catch(function(){ x.state = '写入失败'; });
        }).catch(function(){ x.state = '查询失败'; }).then(function(){
          idx++; paint(); return tick();
        });
      };
      paint();
      tick();
    },
  });
}
/** 清空 DUR_MISS（避免把上一轮的待补项带进来） */
function DUR_MISS_RESET(){ Object.keys(DUR_MISS).forEach(function(k){ delete DUR_MISS[k]; }); }

/* ---------- ④ 预置歌单 ---------- */
/** 预置歌单来源说明：站主说「你也可以自己先准备好周杰伦、林俊杰、方大同这些」。
 *  ⚠️ 2026-10-18 实测校准：清单里不能有错 —— 「莫吉托」官方名是「Mojito」，
 *  「孤独患者」是陈奕迅的、「心跳」「一首简单的歌」是王力宏的、「回到过去」是周杰伦的，
 *  挂错歌手会被严格匹配拒绝（这是 v3.5.27 特意修的，防止拿翻唱顶原唱）。
 *  已逐首用 /api/music?action=search 验证过存在才留在下面。 */
var DUR_PRESETS = {
  '周杰伦': ['晴天','七里香','稻香','青花瓷','告白气球','简单爱','夜曲','搁浅','蒲公英的约定','发如雪','龙卷风','菊花台','东风破','以父之名','双截棍','千里之外','听妈妈的话','Mojito','彩虹','回到过去'],
  '林俊杰': ['江南','一千年以后','曹操','小酒窝','她说','修炼爱情','可惜没如果','不为谁而作的歌','醉赤壁','背对背拥抱','Always Online','学不会','我还想她','第几个100天','那些你很冒险的梦','爱笑的眼睛','冻结','简简单单','豆浆油条','木乃伊'],
  '方大同': ['三人游','爱爱爱','特别的人','春风吹','南音','红豆','每天每天','小小虫','黑白','Singalongsong','妹妹','Love Song','麦恩莉','危险世界'],
};

function durLibViewPreset(st){
  var names = Object.keys(DUR_PRESETS);
  var rows = names.map(function(n){
    var songs = DUR_PRESETS[n];
    return '<tr data-n="' + attr(n) + '">'
      + '<td style="padding:8px">' + esc(n) + '</td>'
      + '<td style="padding:8px;font-size:.78rem;color:var(--fg-3)">' + songs.length + ' 首</td>'
      + '<td style="padding:8px;text-align:right">'
      +   '<button class="btn btn-sm" data-preset="' + attr(n) + '">联网抓时长并入库</button>'
      + '</td></tr>';
  }).join('');
  var tot = names.reduce(function(a, n){ return a + DUR_PRESETS[n].length; }, 0);
  return '<div class="alert info" style="font-size:.82rem;margin:0 0 10px">'
      + '这些是常见热门曲，点一下会<b>逐首联网查时长</b>（网易云 → QQ 音乐 → iTunes），'
      + '查到的写进云端库，查不到的会记进「待补录」。共 ' + tot + ' 首，每首约 1 秒。</div>'
    + '<div style="border:1px solid var(--border);border-radius:var(--radius-md);overflow:hidden">'
    +   '<table style="width:100%;font-size:.86rem"><tbody>' + rows + '</tbody></table>'
    + '</div>'
    + '<p class="hint" style="margin:10px 0 0">补完记得回来「已收录」看一眼条数变了没有。</p>';
}

function wireDurLibPreset(host, st){
  Array.prototype.forEach.call(host.querySelectorAll('[data-preset]'), function(btn){
    btn.onclick = function(){
      var n = btn.getAttribute('data-preset');
      var songs = DUR_PRESETS[n] || [];
      if(!songs.length) return;
      btn.disabled = true; btn.textContent = '开始…';
      var items = songs.map(function(t){ return { title: t, artist: n }; });
      closeModal();
      durBatchSeed(items, n);
    };
  });
}

/** 批量抓时长入库：8 首一批（= 8 首 × 最多 3 个源的子请求，稳在 Workers 50 上限内） */
function durBatchSeed(items, label){
  var total = items.length, ok = 0, fail = [];
  var idx = 0;
  var list = items.map(function(x){ return { title: x.title, artist: x.artist, seconds: null, state: '待查' }; });
  openModal({
    title: '抓取《' + (label || '预置') + '》的时长',
    sub: '共 ' + total + ' 首，查到的自动写进云端时长库',
    wide: true,
    body: '<div id="durSeedBody"></div>',
    foot: '<button class="btn btn-ghost" data-c>关闭</button>',
    onMount: function(box){
      box.querySelector('[data-c]').onclick = closeModal;
      var bodyEl = box.querySelector('#durSeedBody');
      var paint = function(){
        var hit = list.filter(function(x){ return x.seconds > 0; }).length;
        var rows = list.map(function(x){
          var d = x.seconds > 0 ? '<b style="color:#15803d">' + esc(voFmtDur(x.seconds)) + '</b>'
                                : (x.state === '查不到' ? '<b style="color:#b45309">查不到</b>' : '<span class="muted">' + esc(x.state) + '</span>');
          return '<tr><td style="padding:5px 8px">' + esc(x.title) + '</td>'
            + '<td style="padding:5px 8px;font-size:.78rem;color:var(--fg-2)">' + esc(x.artist) + '</td>'
            + '<td style="padding:5px 8px;white-space:nowrap">' + d + '</td></tr>';
        }).join('');
        bodyEl.innerHTML = '<div class="alert ' + (hit === total ? 'info' : 'warn') + '" style="font-size:.82rem;margin:0 0 10px">'
          + '已拿到 <b>' + hit + '</b> / ' + total + ' 首' + (idx >= total ? '（完成）' : '（进行中…）') + '</div>'
          + '<div style="max-height:50vh;overflow:auto;border:1px solid var(--border);border-radius:var(--radius-md)">'
          + '<table style="width:100%;font-size:.84rem"><tbody>' + rows + '</tbody></table></div>';
      };
      var chunks = [];
      for(var i = 0; i < list.length; i += 8) chunks.push(list.slice(i, i + 8));
      var ci = 0;
      var next = function(){
        if(ci >= chunks.length){
          try{ localStorage.removeItem(DUR_LIB_AT); }catch(e){}
          var miss = list.filter(function(x){ return !(x.seconds > 0); });
          if(miss.length) toast('有 ' + miss.length + ' 首没查到，可在「补录缺时长的歌」手填', 'warn', 5000);
          else toast('全部入库了', 'ok');
          paint();
          return;
        }
        var part = chunks[ci++];
        part.forEach(function(x){ x.state = '查询中…'; });
        paint();
        api('/music', { method: 'POST', body: { action: 'batch', items: part.map(function(x){ return { title: x.title, artist: x.artist }; }) } })
          .then(function(j){
            var rows = (j && j.list) || [];
            part.forEach(function(x){
              var r = rows.filter(function(y){ return vhDurationKey(y.title, y.artist) === vhDurationKey(x.title, x.artist); })[0];
              var sec = r ? Number(r.seconds) : 0;
              if(sec > 0){
                x.seconds = sec;
                var cache = vhDurationCache();
                cache[vhDurationKey(x.title, x.artist)] = sec;
                vhSaveDurCache(cache);
              } else x.state = '查不到';
            });
          })
          .catch(function(){ part.forEach(function(x){ x.state = '请求失败'; }); })
          .then(function(){ paint(); next(); });
      };
      paint();
      next();
    },
  });
}

/** 人工补录弹窗：一行一首，填「分:秒」或纯秒数
 *  @param keys   要补的 key 列表（缺省 = 全部 DUR_MISS）
 *  @param onDone 补录成功后的回调（用于「补齐后自动继续刚才那步」） */
function voDurManualDialog(keys, onDone){
  keys = keys || Object.keys(DUR_MISS);
  if(!keys.length){ toast('没有待补录的歌', 'ok'); return; }
  var rows = keys.map(function(k){
    var m = DUR_MISS[k] || {};
    return '<tr data-k="' + attr(k) + '">'
      + '<td style="padding:6px 8px">' + esc(m.title || '') + (m.artist ? '<i class="muted" style="font-style:normal"> · ' + esc(m.artist) + '</i>' : '') + '</td>'
      + '<td style="padding:6px 8px;width:120px">'
      +   '<input class="dur-in" placeholder="3:45 或 225" style="width:100%;padding:5px 8px;font-size:.82rem">'
      + '</td></tr>';
  }).join('');
  openModal({
    title: '补录歌曲时长',
    sub: '填「3:45」这种分秒，或直接填秒数 225；范围 20 秒 ~ 30 分钟',
    wide: true,
    body: '<div class="field" style="margin-bottom:0">'
      +   '<p class="hint" style="margin:0 0 8px">人工填写的时长会写进<b>云端时长库</b>'
      +   '（来源标为「人工」），优先级最高，以后自动搜索也不会覆盖它。</p>'
      +   '<div style="max-height:320px;overflow:auto;border:1px solid var(--border);border-radius:var(--radius-md)">'
      +     '<table style="width:100%;font-size:.84rem"><tbody>' + rows + '</tbody></table>'
      +   '</div></div>',
    foot: '<button class="btn btn-ghost" data-no>稍后再说</button>'
        + '<button class="btn" data-yes>保存到云端</button>',
    onMount: function(box){
      box.querySelector('[data-no]').onclick = closeModal;
      box.querySelector('[data-yes]').onclick = function(){
        var items = [], bad = 0;
        Array.prototype.forEach.call(box.querySelectorAll('tr[data-k]'), function(tr){
          var inp = tr.querySelector('.dur-in');
          var raw = String((inp && inp.value) || '').trim();
          if(!raw) return;
          var sec = 0;
          var mm = raw.match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})$/);
          if(mm) sec = Number(mm[1]) * 60 + Number(mm[2]);
          else if(/^\d+$/.test(raw)) sec = Number(raw);
          if(!(sec >= 20 && sec <= 1800)){ bad++; tr.style.background = 'rgba(220,38,38,.08)'; return; }
          var m = DUR_MISS[tr.getAttribute('data-k')] || {};
          items.push({ title: m.title || '', artist: m.artist || '', seconds: sec });
        });
        if(!items.length){
          toast(bad ? '填的时长不合法（需 20 秒 ~ 30 分钟）' : '至少填一首', 'err');
          return;
        }
        var btn = box.querySelector('[data-yes]');
        if(btn){ btn.disabled = true; btn.textContent = '保存中…'; }
        api('/music', { method: 'POST', body: { action: 'manual', items: items } })
          .then(function(j){
            var cache = vhDurationCache();
            items.forEach(function(x){ cache[vhDurationKey(x.title, x.artist)] = x.seconds; });
            vhSaveDurCache(cache);
            Object.keys(DUR_MISS).forEach(function(k){
              var m = DUR_MISS[k];
              if(items.some(function(x){ return vhDurationKey(x.title, x.artist) === k; })) delete DUR_MISS[k];
            });
            closeModal();
            toast((j && j.message) || '已保存到云端', 'ok');
            /* 已经打开的投票编辑器 / 歌单面板要跟着更新 */
            if(typeof window.__voRebuildSongOptions === 'function') window.__voRebuildSongOptions();
            if(typeof djRefreshDur === 'function') djRefreshDur();
            vhDurNotice();
            if(typeof onDone === 'function'){
              try{ onDone(); }catch(e){}
            }
          })
          .catch(function(e){
            if(btn){ btn.disabled = false; btn.textContent = '保存到云端'; }
            toast('保存失败：' + (e.message || e), 'err', 4000);
          });
      };
    },
  });
}

function vhFetchSongsRaw(){
  var h = { 'x-api-key': vhDjKey() };
  return fetch(VH_API + '/songs?page=1&limit=100', { headers: h })
    .then(function(r){ return r.json(); })
    .then(function(d){
      var songs = (d && d.data && d.data.songs) || [];
      var pages = (d && d.data && d.data.pagination && d.data.pagination.totalPages) || 1;
      var tasks = [];
      for(var i = 2; i <= pages; i++){
        (function(pg){
          tasks.push(fetch(VH_API + '/songs?page=' + pg + '&limit=100', { headers: h })
            .then(function(r){ return r.json(); })
            .then(function(x){ return (x && x.data && x.data.songs) || []; }));
        })(i);
      }
      return Promise.all(tasks).then(function(rs){
        var all = songs.slice();
        rs.forEach(function(a){ all = all.concat(a); });
        return all;
      });
    });
}

/** 拉券列表（只取第一页 100 张，够用；要更多可以再翻页） */
function vhFetchCards(){
  return fetch(VH_API + '/card-codes?page=1&limit=100', { headers: { 'x-api-key': vhCpKey() } })
    .then(function(r){ return r.json(); })
    .then(function(d){ return (d && d.data && d.data.cardCodes) || []; });
}

/* ---- 面板骨架 ---- */
function renderSong(){
  $('view').innerHTML =
    '<div class="alert info" style="margin-bottom:16px">'
    +   '本页数据**实时来自点歌平台**（VoiceHub），不是云端缓存 —— 同学在首页点的歌、'
    +   '领的券都会立刻出现在这里。此处的增删会真实作用到平台上，全班同步生效。'
    + '</div>'
    /* ===== v3.5.13（站主 #3）：VoiceHub 投稿上限 + 投稿统计 ===== */
    + '<section class="panel" style="margin-bottom:16px">'
    +   '<h3 style="margin:0 0 10px;font-size:.9rem">🛡 投稿上限守卫</h3>'
    +   '<p class="muted" style="margin:0 0 10px;font-size:.78rem">'
    +     '开启后，同学在班级网站点「点歌平台」入口时，先查 ta 的<b>未播投稿数</b>，'
    +     '达到上限会弹提示（同名同学会误伤，默认关）。保存后约 1 分钟内全班生效。</p>'
    +   '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">'
    +     '<label style="display:flex;align-items:center;gap:6px;font-size:.84rem">'
    +       '<input type="checkbox" id="vhGuardOn"> 开启守卫</label>'
    +     '<div class="field" style="margin:0;width:150px"><label>每人未播投稿上限</label>'
    +       '<input id="vhGuardLimit" type="number" min="1" max="20" value="3"></div>'
    +     '<button class="btn btn-sm" id="vhGuardSave">保存</button>'
    +     '<span class="muted" id="vhGuardState" style="font-size:.76rem"></span>'
    +   '</div>'
    + '</section>'
    + '<section class="panel" style="margin-bottom:16px">'
    +   '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px">'
    +     '<h3 style="margin:0;font-size:.9rem">📊 投稿统计（未播为准）</h3>'
    +     '<button class="btn btn-sm btn-ghost" id="vhStatReload">' + svg('refresh', 14) + ' 刷新</button>'
    +   '</div>'
    +   '<div id="vhStats"><div class="muted" style="font-size:.8rem">点「刷新」读取。</div></div>'
    + '</section>'
    + '<section class="panel" style="margin-bottom:16px">'
    +   '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px">'
    +     '<h3 style="margin:0;font-size:.9rem">🎵 实时歌单</h3>'
    +     '<div style="display:flex;gap:8px">'
    +       '<button class="btn btn-sm btn-ghost" id="sgRefund">' + svg('ticket', 14) + ' 游戏券补发</button>'
    +       '<button class="btn btn-sm btn-ghost" id="sgReload">' + svg('refresh', 14) + ' 刷新</button>'
    +     '</div>'
    +   '</div>'
    +   '<div id="sgSongs"><div class="loading"><div class="spinner"></div>加载中…</div></div>'
    + '</section>'
    + '<section class="panel">'
    +   '<h3 style="margin:0 0 10px;font-size:.9rem">🎟 点歌券管理</h3>'
    +   '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px">'
    +     '<div class="field" style="margin:0;min-width:90px"><label for="sgCount">生成数量</label>'
    +       '<input id="sgCount" type="number" min="1" max="50" value="1"></div>'
    +     '<div class="field" style="margin:0;flex:1;min-width:180px"><label for="sgNote">备注</label>'
    +       '<input id="sgNote" maxlength="80" placeholder="如 手动添加"></div>'
    +     '<button class="btn btn-sm" id="sgCreate">' + svg('plus', 14) + ' 生成券码</button>'
    +   '</div>'
    +   '<div id="sgCards"><div class="loading"><div class="spinner"></div>加载中…</div></div>'
    + '</section>';

  var rb = $('sgReload');
  if(rb) rb.onclick = function(){ loadSong(); };
  /* v3.5.13 投稿上限守卫：读/存 site_config.vhGuard */
  (function(){
    api('/content?keys=site_config').then(function(j){
      var g = (j && j.items && j.items.site_config && j.items.site_config.vhGuard) || {};
      var onEl = $('vhGuardOn'), limEl = $('vhGuardLimit'), st = $('vhGuardState');
      if(onEl) onEl.checked = !!g.on;
      if(limEl) limEl.value = Math.max(1, Number(g.limit) || 3);
      if(st) st.textContent = g.on ? ('当前：已开启（上限 ' + (Number(g.limit) || 3) + ' 首）') : '当前：未开启';
    }).catch(function(){});
    var sb = $('vhGuardSave');
    if(sb) sb.onclick = function(){
      var onEl = $('vhGuardOn'), limEl = $('vhGuardLimit');
      api('/content?keys=site_config').then(function(j){
        var cfg = (j && j.items && j.items.site_config) || {};
        cfg.vhGuard = { on: !!(onEl && onEl.checked), limit: Math.max(1, Number(limEl && limEl.value) || 3) };
        return api('/content', { method:'PUT', body:{ items:{ site_config: cfg } } });
      }).then(function(){
        toast('守卫设置已保存', 'ok');
        var st = $('vhGuardState');
        if(st) st.textContent = (onEl && onEl.checked)
          ? ('当前：已开启（上限 ' + (Number(limEl && limEl.value) || 3) + ' 首）') : '当前：未开启';
      }).catch(function(e){ toast('保存失败：' + e.message, 'err'); });
    };
  })();
  /* v3.5.13 投稿统计：走后端代理读 VoiceHub 公开歌单（上游无 CORS） */
  (function(){
    var btn = $('vhStatReload'), box = $('vhStats');
    function loadStats(){
      if(!box) return;
      box.innerHTML = '<div class="loading"><div class="spinner"></div>读取中…</div>';
      /* v3.5.15 热修：VH_API 是 `.../api/open`，以前用 replace(/\/api$/) 去掉尾巴，
         结果 base 还带着 `/api/open`，被 /vh 代理的「只收 https 站点」校验挡下，
         报「base 必须是 https:// 开头的完整站点地址」。改用 URL.origin 取站点根。 */
      var base = '';
      try{ base = new URL(VH_API).origin; }catch(e){ base = ''; }
      if(!base){
        box.innerHTML = '<div class="alert danger">点歌平台地址配置不对（VH_API = ' + esc(VH_API) + '），无法读取。</div>';
        return;
      }
      api('/vh?action=songs&base=' + encodeURIComponent(base)).then(function(j){
        var songs = (j && j.songs) || [];
        var pending = songs.filter(function(it){ return !(it.played || (it.song && it.song.played)); });
        var byUser = {};
        songs.forEach(function(it){
          var s = it.song || it;
          var nm = String(s.requester || '').trim() || '匿名';
          if(!byUser[nm]) byUser[nm] = { total: 0, pending: 0 };
          byUser[nm].total++;
          if(!(it.played || s.played)) byUser[nm].pending++;
        });
        var rows = Object.keys(byUser).map(function(nm){ return { nm: nm, t: byUser[nm].total, p: byUser[nm].pending }; });
        rows.sort(function(a, b){ return b.p - a.p || b.t - a.t; });
        box.innerHTML =
          '<div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:10px">'
          + '<div><b style="font-size:1.2rem">' + songs.length + '</b> <span class="muted" style="font-size:.78rem">总投稿</span></div>'
          + '<div><b style="font-size:1.2rem">' + pending.length + '</b> <span class="muted" style="font-size:.78rem">未播</span></div>'
          + '<div><b style="font-size:1.2rem">' + rows.length + '</b> <span class="muted" style="font-size:.78rem">投稿人数</span></div>'
          + '</div>'
          + '<div style="max-height:220px;overflow:auto">'
          + '<table><thead><tr><th>投稿人</th><th>未播</th><th>累计</th></tr></thead><tbody>'
          + rows.map(function(r){
              return '<tr><td>' + esc(r.nm) + '</td>'
                + '<td>' + (r.p ? '<b style="color:#c2410c">' + r.p + '</b>' : '0') + '</td>'
                + '<td>' + r.t + '</td></tr>';
            }).join('')
          + '</tbody></table></div>'
          + '<p class="muted" style="font-size:.74rem;margin:8px 0 0">数据来自 VoiceHub 公开歌单（5 分钟缓存）；「排期到某天 / 自动标已播」需要 VoiceHub 登录态，开放 API 暂不支持，见更新记录说明。</p>';
      }).catch(function(e){
        box.innerHTML = '<div class="alert danger">读取失败：' + esc(e.message || e) + '</div>';
      });
    }
    if(btn) btn.onclick = loadStats;
    loadStats();
  })();
  var rfb = $('sgRefund');
  if(rfb) rfb.onclick = songRefundDialog;
  var cb = $('sgCreate');
  if(cb) cb.onclick = songCreateCards;

  loadSong();
}

/* ---- 取数 ---- */
function loadSong(){
  var sb = $('sgSongs'), cb2 = $('sgCards');
  if(!VH_ENABLED){
    if(sb) sb.innerHTML = '<div class="empty">' + svg('ban', 34) + '<p>后台直连已关闭</p>'
      + '<p class="muted" style="font-size:.78rem">把 admin.html 里的 VH_ENABLED 改回 true 即可恢复</p></div>';
    if(cb2) cb2.innerHTML = '';
    return;
  }

  vhFetchSongs().then(function(list){
    STATE.song.list = list;
    paintSongSongs();
  }).catch(function(e){
    STATE.song.list = [];
    paintSongSongs(e);
  });

  vhFetchCards().then(function(list){
    STATE.song.cards = list;
    paintSongCards();
  }).catch(function(e){
    STATE.song.cards = [];
    paintSongCards(e);
  });
}

/* ---- 渲染：歌单 ---- */
function paintSongSongs(err){
  var body = $('sgSongs');
  if(!body) return;

  if(err){
    body.innerHTML = '<div class="empty">' + svg('alert', 34)
      + '<p>拉取歌单失败</p>'
      + '<p class="muted" style="font-size:.78rem;word-break:break-all">' + esc(String((err && err.message) || err)) + '</p>'
      + '<p class="muted" style="font-size:.78rem">常见原因：平台暂时不可用，或本站域名不在平台 CORS 白名单里。</p></div>';
    return;
  }

  var list = STATE.song.list || [];
  if(!list.length){
    body.innerHTML = '<div class="empty">' + svg('music', 38) + '<p>平台上还没有人点歌</p>'
      + '<p class="muted" style="font-size:.78rem">同学在首页「点歌台」提交后会实时出现在这里</p></div>';
    return;
  }

  /* 按点赞降序，同票按创建时间倒序 —— 让最热门的排前面 */
  var sorted = list.slice().sort(function(a, b){
    var va = Number(a.voteCount) || 0, vb = Number(b.voteCount) || 0;
    if(vb !== va) return vb - va;
    return String(b.createdAt || '') < String(a.createdAt || '') ? -1 : 1;
  });

  var totalVotes = sorted.reduce(function(n, s){ return n + (Number(s.voteCount) || 0); }, 0);
  var played = sorted.filter(function(s){ return !!s.played; }).length;

  body.innerHTML =
    '<div class="muted" style="font-size:.78rem;margin-bottom:8px">'
    +   '共 <b>' + sorted.length + '</b> 首 · 总点赞 <b>' + totalVotes + '</b> · 已播放 <b>' + played + '</b>'
    + '</div>'
    + '<div class="table-wrap"><table><thead><tr>'
    +   '<th class="nowrap" style="width:36px">#</th>'
    +   '<th>歌曲</th><th class="nowrap" style="width:62px">时长</th><th class="nowrap" style="width:70px">👍 点赞</th>'
    +   '<th>点歌人</th><th class="nowrap" style="width:130px">点歌时间</th>'
    +   '<th class="nowrap" style="width:70px">状态</th>'
    + '</tr></thead><tbody>'
    + sorted.map(function(s, i){
        var req = vhReqName(s) || '—';
        return '<tr>'
          + '<td class="muted nowrap">' + (i + 1) + '</td>'
          + '<td><b>' + esc(s.title || '(无歌名)') + '</b>'
          +   '<i class="muted" style="display:block;font-size:.75rem;font-style:normal">' + esc(s.artist || '未知歌手') + '</i></td>'
          + '<td class="nowrap muted" style="font-size:.78rem">' + (voFmtDur(s.durationSeconds) || '—') + '</td>'
          + '<td class="nowrap"><b style="color:#af410f">' + (Number(s.voteCount) || 0) + '</b></td>'
          + '<td class="nowrap">' + esc(req) + '</td>'
          + '<td class="nowrap muted" style="font-size:.76rem">' + esc(vhFmtTime(s.createdAt)) + '</td>'
          + '<td class="nowrap">' + (s.played
              ? '<span class="badge badge-gray">已播放</span>'
              : '<span class="badge badge-blue">待播放</span>') + '</td>'
          + '</tr>';
      }).join('')
    + '</tbody></table></div>';
}

/* ---- 渲染：券列表 ---- */
function paintSongCards(err){
  var body = $('sgCards');
  if(!body) return;

  if(err){
    body.innerHTML = '<div class="empty">' + svg('alert', 30) + '<p>拉取券列表失败</p>'
      + '<p class="muted" style="font-size:.78rem;word-break:break-all">' + esc(String((err && err.message) || err)) + '</p></div>';
    return;
  }

  var list = STATE.song.cards || [];
  if(!list.length){
    body.innerHTML = '<div class="empty">' + svg('key', 34) + '<p>平台上还没有点歌券</p></div>';
    return;
  }

  var avail = list.filter(function(c){ return c.status === 'AVAILABLE'; }).length;
  var used  = list.filter(function(c){ return c.status === 'REDEEMED'; }).length;

  body.innerHTML =
    '<div class="muted" style="font-size:.78rem;margin-bottom:8px">'
    +   '共 <b>' + list.length + '</b> 张 · 可用 <b>' + avail + '</b> · 已核销 <b>' + used + '</b>'
    + '</div>'
    + '<div class="table-wrap"><table><thead><tr>'
    +   '<th class="nowrap" style="width:36px">#</th>'
    +   '<th class="nowrap" style="width:120px">券码</th>'
    +   '<th>备注</th><th class="nowrap" style="width:80px">状态</th>'
    +   '<th style="text-align:right;width:80px">操作</th>'
    + '</tr></thead><tbody>'
    + list.map(function(c, i){
        var st = c.status === 'AVAILABLE' ? '<span class="badge badge-green">可用</span>'
               : (c.status === 'REDEEMED' ? '<span class="badge badge-gray">已核销</span>'
               : '<span class="badge badge-gray">' + esc(c.status || '?') + '</span>');
        return '<tr>'
          + '<td class="muted nowrap">' + (i + 1) + '</td>'
          + '<td class="nowrap"><b class="mono" style="font-size:.78rem">' + esc(c.code || '') + '</b></td>'
          + '<td class="muted" style="font-size:.76rem;word-break:break-all">' + esc(c.note || '（无备注）') + '</td>'
          + '<td class="nowrap">' + st + '</td>'
          + '<td class="nowrap" style="text-align:right">'
          +   '<button class="btn btn-sm btn-ghost" data-delcard="' + esc(c.id) + '" data-code="' + attr(c.code || '') + '">'
          +   svg('trash', 13) + ' 删除</button></td>'
          + '</tr>';
      }).join('')
    + '</tbody></table></div>';

  Array.prototype.forEach.call(body.querySelectorAll('[data-delcard]'), function(b){
    b.onclick = function(){ songDeleteCard(b.dataset.delcard, b.dataset.code); };
  });
}

/* ---- 生成券码（真实调平台） ---- */
function songCreateCards(){
  var n = parseInt(($('sgCount') || {}).value || '1', 10);
  if(!(n >= 1)) n = 1;
  if(n > 50) n = 50;
  var note = (($('sgNote') || {}).value || '').trim() || '手动添加';

  var btn = $('sgCreate');
  if(btn){ btn.disabled = true; btn.textContent = '生成中…'; }

  fetch(VH_API + '/card-codes', {
    method: 'POST',
    headers: { 'x-api-key': vhCpKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: n, prefix: 'SONG', length: 8, note: note })
  })
    .then(function(r){ return r.json(); })
    .then(function(d){
      var codes = (d && d.data && d.data.cardCodes) || [];
      if(codes.length) toast('已生成 ' + codes.length + ' 张券：' + codes.map(function(c){ return c.code; }).join('、'), 'ok', 6000);
      else toast('平台未返回券码：' + JSON.stringify(d).slice(0, 120), 'err', 6000);
      if($('sgNote')) $('sgNote').value = '';
      loadSong();
    })
    .catch(function(e){ toast('生成失败：' + ((e && e.message) || e), 'err', 5000); })
    .then(function(){
      if(btn){ btn.disabled = false; btn.innerHTML = svg('plus', 14) + ' 生成券码'; }
    });
}

/* ---- 删除券（真实删平台，不可恢复） ---- */
function songDeleteCard(id, code){
  confirmBox({
    title: '删除点歌券',
    html: '确定删除券码 <b>' + esc(code) + '</b> 吗？',
    detail: '这会真实删除点歌平台上的这张券，同学拿着它就无法再点歌，且不可恢复。',
    warn: '如果只是想让本站暂时不认这张券，主站点歌台里有「禁用」选项，那个是可撤销的。',
    danger: true,
    okText: '删除'
  }).then(function(yes){
    if(!yes) return;
    fetch(VH_API + '/card-codes?id=' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: { 'x-api-key': vhCpKey() }
    })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(d && d.success) toast('已删除 ' + code, 'ok', 3000);
        else toast('删除失败：' + JSON.stringify(d).slice(0, 120), 'err', 5000);
        loadSong();
      })
      .catch(function(e){ toast('删除失败：' + ((e && e.message) || e), 'err', 5000); });
  });
}

/* ---- 游戏点歌券补发（原主站功能搬进后台） ----
 * 需求：「原先的点歌歌单、点歌券查询页面也放到后台」中的补发部分。
 * 与主站一致：note 格式必须与游戏端 REWARD.note 完全相同，
 * 否则游戏端的平台查重（platformFind）认不出这张补发券，同学可能重复领。 */
var SONG_GAMES = { bird:'像素飞鸟', snake:'贪吃蛇', doodle:'涂鸦跳跃', tetris:'俄罗斯方块' };
var SONG_NOTES = {
  bird:  '像素飞鸟过20管奖励',
  snake: '贪吃蛇吃豆50奖励',
  doodle:'涂鸦跳跃10000高奖励',
  tetris:'俄罗斯方块200分奖励'
};

function songRefundDialog(){
  var gameOpts = Object.keys(SONG_GAMES).map(function(k){
    return '<option value="' + attr(k) + '">' + esc(SONG_GAMES[k]) + '</option>';
  }).join('');

  openModal({
    title: '游戏点歌券补发',
    sub: '给达到游戏奖励条件但因故没领到券的同学补一张',
    body:
      '<div class="field"><label for="srName">同学姓名</label>'
      + '<input id="srName" maxlength="30" placeholder="如 张三">'
      + '<p class="hint">必须与班级名单里的名字完全一致，否则本站台账对不上。</p></div>'
      + '<div class="field"><label for="srGame">游戏</label>'
      + '<select id="srGame">' + gameOpts + '</select></div>'
      + '<div class="field"><label for="srTime">达成时间</label>'
      + '<input id="srTime" type="datetime-local"></div>'
      + '<div class="alert info" style="margin:0">'
      +   '提交后会真实在平台上生成一张券，券码直接显示给你。请手动把券码发给该同学。'
      + '</div>'
      + '<div class="msg" id="srMsg"></div>',
    foot: '<button class="btn btn-ghost" data-no>取消</button>'
        + '<button class="btn" data-yes>登记并生成券</button>',
    onMount: function(box){
      var t = box.querySelector('#srTime');
      if(t){
        var d = new Date();
        function p(n){ return (n < 10 ? '0' : '') + n; }
        t.value = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
                + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
      }
      box.querySelector('[data-no]').onclick = closeModal;
      box.querySelector('[data-yes]').onclick = function(){
        var msg  = box.querySelector('#srMsg');
        var name = (box.querySelector('#srName').value || '').trim();
        var game = box.querySelector('#srGame').value;
        var tv   = (t && t.value) ? t.value.replace('T', ' ') : '';
        if(!name){ msg.textContent = '请填写同学姓名'; msg.style.color = 'var(--danger,#af410f)'; return; }

        if(!tv){
          var d = new Date();
          function p(n){ return (n < 10 ? '0' : '') + n; }
          tv = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
             + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
        }
        var note = name + ' · ' + tv + ' · ' + (SONG_NOTES[game] || game);

        msg.style.color = 'var(--fg-3)';
        msg.textContent = '正在平台上生成券码…';
        fetch(VH_API + '/card-codes', {
          method: 'POST',
          headers: { 'x-api-key': vhCpKey(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: 1, prefix: 'SONG', length: 8, note: note })
        })
          .then(function(r){ return r.json().catch(function(){ return {}; }); })
          .then(function(d){
            var codes = (d && d.data && d.data.cardCodes) || [];
            if(codes.length){
              toast('已为 ' + name + ' 生成券码：' + codes[0].code + '（请手动发给该同学）', 'ok', 9000);
              closeModal();
            }else{
              msg.style.color = 'var(--danger,#af410f)';
              msg.textContent = '平台生成未成功，请在「点歌管理」里手动生成一张券发给同学。';
            }
            loadSong();
          })
          .catch(function(e){
            msg.style.color = 'var(--danger,#af410f)';
            msg.textContent = '平台生成未成功（' + ((e && e.message) || e) + '），请手动生成。';
          });
      };
    }
  });
}

/* ============================================================================
 * ⑪-E 面板：每日一言（2026-10-06 新增）
 * ---------------------------------------------------------------------------
 * 需求「每日一言要真做成功能」。
 *
 * 云端字段：daily_quote  数组，支持两种写法混用：
 *   "今天也要加油"                        ← 纯字符串
 *   { text:"...", from:"—— 某人的话" }     ← 带出处
 *
 * 主站按「当天日期取模」选一句（同一天早上和晚上看到的是同一句，
 * 跨天才换），所以这里改完不需要通知同学刷新具体某句，第二天自然生效。
 *
 * ⚠️ 把数组清空 → 主站那边整块「每日一言」卡片直接不渲染（不留空壳）。
 *    这是刻意设计：后台删干净，首页就干净。
 * ========================================================================= */
/* 🚀 v2.6.1 站主要求：原先「每日一言」和「学习卡片」在导航里是两个独立入口
   （内容组本来就有 10 项，太碎），合并成一个板块「首页卡片」，
   面板内分上下两块 —— 两者本质都是「首页那张小卡片」的配置，放一起更好找。

   两块各自复用原来的加载/渲染逻辑，互不干扰：
     · 每日一言 → loadQuotes() / paintQuotes() / dqDialog()，数据键 daily_quote
     · 学习卡片 → loadStudy()  / paintStudy()  / saveStudy()，数据键 study_card */
function renderCards(){
  $('view').innerHTML =
    /* ---------- 区块一：每日一言（含来源开关 v3.5.9） ---------- */
    '<section class="panel" style="margin-bottom:18px">'
    + '<div class="panel-head">'
    +   '<div><h3>' + svg('quote') + '每日一言</h3>'
    +     '<p class="sub">首页自动换一句，同学不用手动刷</p></div>'
    +   '<div style="display:flex;gap:8px;flex-wrap:wrap">'
    +     '<button class="btn btn-sm" id="dqAdd">' + svg('plus', 14) + '新增一句</button>'
    +     '<button class="btn btn-sm btn-secondary" id="dqBatchAdd">' + svg('plus', 14) + '批量添加</button>'
    +     '<button class="btn btn-sm btn-secondary" id="dqBatchDel">批量删除</button>'
    +     '<button class="btn btn-sm btn-secondary" id="dqRefresh">' + svg('refresh', 14) + '刷新</button>'
    +   '</div>'
    + '</div>'
    + '<div class="panel-body">'
    /* —— 来源开关（v3.5.9）：站主要求「改为展示 API 拉取内容」，这里一刀切全站 —— */
    +   '<div style="margin-bottom:16px;padding:14px;border:1px solid var(--border);border-radius:12px;background:var(--bg-2)">'
    +     '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px">'
    +       '<b style="font-size:.9rem">内容来源</b>'
    +       '<span class="muted" style="font-size:.76rem">改完点「保存来源」，全站立即生效</span>'
    +     '</div>'
    +     '<div style="display:flex;gap:8px;flex-wrap:wrap">'
    +       '<button class="btn" id="qsNet" style="flex:1;min-width:130px"></button>'
    +       '<button class="btn" id="qsLocal" style="flex:1;min-width:130px"></button>'
    +     '</div>'
    +     '<p class="muted" style="font-size:.76rem;margin:10px 0 0;line-height:1.7">'
    +       '<b>联网 API</b>：从 hitokoto 公共文库拉取（动画 / 漫画 / 文学 / 诗词），每次刷新随机换一句，连不上自动回退本地库。<br>'
    +       '<b>本地库</b>：只用下面这个列表里的句子，不发任何外部请求 —— 哪天显示哪句在下面的「轮换设置」里定。'
    +     '</p>'
    +     '<div id="qsMsg" style="font-size:.78rem;margin-top:8px"></div>'
    +     '<div style="margin-top:14px;padding-top:12px;border-top:1px dashed var(--border)">'
    +       '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px">'
    +         '<b style="font-size:.86rem">内容分类</b>'
    +         '<span class="muted" style="font-size:.74rem">取消勾选 = 不显示这类；改完立即生效</span>'
    +       '</div>'
    +       '<div id="qsCats" style="display:flex;gap:6px;flex-wrap:wrap"></div>'
    +       '<div id="qsCatMsg" style="font-size:.74rem;margin-top:8px"></div>'
    +     '</div>'
    +   '</div>'
    +   '<div class="alert info" style="margin-bottom:14px">'
    +     '列表改动保存后，让同学刷新一下页面就能看到最新内容。'
    +   '</div>'
    +   '<div id="dqBody"><div class="loading"><div class="spinner"></div>加载中…</div></div>'
    +   '<div id="dqSched" style="margin-top:18px"></div>'
    + '</div>'
    + '</section>'
    /* ---------- 区块二：学习卡片 ---------- */
    + '<section class="panel">'
    + '<div class="panel-head">'
    +   '<div><h3>' + svg('inbox') + '学习卡片</h3>'
    +     '<p class="sub">知识点 / 每日一词 / 古诗文 / 每日一题</p></div>'
    +   '<div style="display:flex;gap:8px">'
    +     '<button class="btn btn-sm" id="stSave">' + svg('check', 14) + ' 保存</button>'
    +     '<button class="btn btn-sm btn-secondary" id="stRefresh">' + svg('refresh', 14) + ' 刷新</button>'
    +   '</div>'
    + '</div>'
    + '<div class="panel-body">'
    +   '<div class="alert info" style="margin-bottom:14px">'
    +     '首页「学习卡片」每次刷新随机出一条内容。这里配的是<b>全班默认</b>；'
    +     '同学在首页「自定义设置 → 学习卡片」里改过、或手动关掉的，以他自己的为准。'
    +   '</div>'
    +   '<div id="stBody"><div class="loading"><div class="spinner"></div>加载中…</div></div>'
    + '</div>'
    + '</section>';

  $('dqAdd').onclick     = function(){ dqDialog(null); };
  $('dqBatchAdd').onclick = dqBatchAdd;
  $('dqBatchDel').onclick = dqBatchDelete;
  $('dqRefresh').onclick = function(){ loadQuotes(); };
  $('stSave').onclick    = saveStudy;
  $('stRefresh').onclick = loadStudy;
  $('qsNet').onclick     = function(){ qsPick(1); };
  $('qsLocal').onclick   = function(){ qsPick(0); };
  loadQuoteSource();
  loadSchedule();
  loadQuotes();
  loadStudy();
}

/* v3.5.9 每日一言来源（内容键 quote_source）：站主要在「首页卡片」里直接改，
   不再让每个同学自己在「自定义设置」里点。 */
var QUOTE_CATS = [
  ['a', '动画'], ['b', '漫画'], ['c', '游戏'], ['d', '文学'],
  ['e', '原创'], ['f', '网络'], ['g', '其他'], ['h', '影视'],
  ['i', '诗词'], ['j', '网易云'], ['k', '哲学'], ['l', '抖机灵'],
];
function loadQuoteSource(){
  api('/content').then(function(j){
    var raw = (j && j.items) ? j.items.quote_source : null;
    /* 没配过就默认联网（与 v3.5.6 起的行为一致） */
    STATE.quoteSource = (raw && raw.net === 0) ? 0 : 1;
    STATE.quoteCats = (raw && Array.isArray(raw.cats) && raw.cats.length)
      ? raw.cats.slice() : ['a', 'b', 'd', 'i'];
    paintQuoteSource();
    paintQuoteCats();
  }).catch(function(){
    STATE.quoteSource = 1;
    STATE.quoteCats = ['a', 'b', 'd', 'i'];
    paintQuoteSource(); paintQuoteCats();
  });
}
/* v3.9.8（站主）：只显示勾选的分类，取消勾选就不拉那类 */
function paintQuoteCats(){
  var box = $('qsCats');
  if(!box) return;
  var cur = STATE.quoteCats || ['a', 'b', 'd', 'i'];
  box.innerHTML = QUOTE_CATS.map(function(c){
    var on = cur.indexOf(c[0]) >= 0;
    return '<button type="button" class="ai-cat' + (on ? ' on' : '') + '" data-cat="' + c[0] + '">'
      + (on ? '✓ ' : '') + c[1] + '</button>';
  }).join('');
  box.onclick = function(e){
    var b = e.target.closest && e.target.closest('[data-cat]');
    if(!b) return;
    var k = b.getAttribute('data-cat');
    var arr = (STATE.quoteCats || []).slice();
    var i = arr.indexOf(k);
    if(i >= 0){
      if(arr.length <= 1){ toast('至少留一类，不然就没内容可显示了', 'warn'); return; }
      arr.splice(i, 1);
    }else{
      arr.push(k);
    }
    STATE.quoteCats = arr;
    paintQuoteCats();
    saveQuoteCats();
  };
}
function saveQuoteCats(){
  var msg = $('qsCatMsg');
  if(msg) msg.innerHTML = '<span class="muted">保存中…</span>';
  api('/content', { method: 'PUT', body: { items: { quote_source: {
    net: (STATE.quoteSource === 0) ? 0 : 1,
    cats: STATE.quoteCats || ['a', 'b', 'd', 'i'],
  } } } }).then(function(j){
    if(j && j.ok === false) throw new Error(j.error || '保存失败');
    if(msg) msg.innerHTML = '<span style="color:#2f9e44">✅ 已保存，同学刷新页面后只显示勾选的分类</span>';
  }).catch(function(e){
    if(msg) msg.innerHTML = '<span style="color:#b3261e">保存失败：' + esc(e.message || e) + '</span>';
  });
}

function paintQuoteSource(){
  var net = $('qsNet'), loc = $('qsLocal');
  if(!net || !loc) return;
  var cur = (STATE.quoteSource === 0) ? 0 : 1;
  net.textContent = (cur === 1 ? '✓ ' : '') + '联网 API（推荐）';
  loc.textContent = (cur === 0 ? '✓ ' : '') + '本地库';
  net.className = 'btn' + (cur === 1 ? '' : ' btn-secondary');
  loc.className = 'btn' + (cur === 0 ? '' : ' btn-secondary');
  net.style.flex = loc.style.flex = '1';
  net.style.minWidth = loc.style.minWidth = '130px';
  /* v3.5.10 站主反馈「本地库可以新增，你把新增按钮删掉了」：
     新增按钮一直在面板右上角（+ 新增一句），但太不显眼 —— 本地库时在这里明确指路。 */
  var msg = $('qsMsg');
  if(msg && !msg.innerHTML){
    msg.innerHTML = (cur === 0)
      ? '<span class="muted">当前用本地库：点右上角 <b>＋ 新增一句</b> 往库里加句子，列表里每条都能编辑和删除。</span>'
      : '<span class="muted">当前联网取句。右上角 <b>＋ 新增一句</b> 维护的是本地库 —— 联网失败时自动用它兜底。</span>';
  }
  /* 本地库模式下把「新增一句」按钮换成主色高亮，一眼能看到 */
  var add = $('dqAdd');
  if(add){
    add.className = 'btn btn-sm' + (cur === 0 ? '' : ' btn-secondary');
    add.innerHTML = svg('plus', 14) + (cur === 0 ? '新增一句（本地库）' : '新增一句');
  }
}

function qsPick(m){
  var next = (m === 0) ? 0 : 1;
  if(STATE.quoteSource === next){ paintQuoteSource(); return; }
  var msg = $('qsMsg');
  if(msg){ msg.innerHTML = '<span class="muted">保存中…</span>'; }
  api('/content', { method: 'PUT', body: { items: { quote_source: {
    net: next, cats: STATE.quoteCats || ['a', 'b', 'd', 'i'],
  } } } })
    .then(function(j){
      if(j && j.ok === false) throw new Error(j.error || '保存失败');
      STATE.quoteSource = next;
      paintQuoteSource();
      if(msg){ msg.innerHTML = '<span style="color:#2f9e44">✅ 已切换为「'
        + (next === 1 ? '联网 API' : '本地库') + '」，同学刷新页面即生效。'
        + (next === 0 ? '本地库的句子用右上角 <b>＋ 新增一句</b> 添加。' : '')
        + '</span>'; }
    })
    .catch(function(e){
      if(msg){ msg.innerHTML = '<span style="color:#b3261e">保存失败：' + esc(e.message || e) + '</span>'; }
    });
}

function dqNormalize(list){
  if(!Array.isArray(list)) return [];
  return list.map(function(x){
    if(typeof x === 'string') return { text: x, from: '' };
    if(x && typeof x === 'object') return { text: String(x.text || ''), from: String(x.from || '') };
    /* 数字 / 布尔 / null 一律丢掉。
       不要写成 String(x) —— 数组里混进一个 0 或 true，首页就会出现
       一句莫名其妙的「0」。宁可少显示，也不要显示垃圾。 */
    return null;
  }).filter(function(x){ return x && x.text.trim(); });
}

function loadQuotes(){
  api('/content').then(function(j){
    var items = (j && j.items) || {};
    STATE.quotes.list = dqNormalize(items.daily_quote);
    paintQuotes();
  }).catch(function(e){
    var b = $('dqBody');
    if(b) b.innerHTML = '<div class="empty">' + svg('alert', 34) + '<p>加载失败：' + esc(e.message) + '</p></div>';
  });
}

function paintQuotes(){
  var body = $('dqBody');
  if(!body) return;
  var list = STATE.quotes.list || [];

  if(!list.length){
    body.innerHTML = '<div class="empty">' + svg('quote', 38) + '<p>云端还没有每日一言</p>'
      + '<p class="muted" style="font-size:.78rem">首页的那张卡片现在不会显示；加一条就会自动出现</p></div>';
    return;
  }

  /* v3.5.11：今天会轮到哪一句 —— 与主站**完全同一套**算法（含排期），
     之前这里是自己另算的取模，排期一改就跟前台对不上，站主没法对照。 */
  var todayStr = dqDayStr(new Date());
  var todayIdx = dqTodayIdx(list, todayStr);
  var sched = STATE.quoteSched || { mode:'random' };

  body.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px">'
    +   '<div class="muted" style="font-size:.78rem">共 <b>' + list.length + '</b> 句'
    +     (todayIdx >= 0 ? '　今天显示第 <b>' + (todayIdx + 1) + '</b> 句' : (sched.mode === 'date' ? '　今天没指定句子' : ''))
    +   '</div>'
    +   '<div style="display:flex;align-items:center;gap:8px;font-size:.78rem">'
    +     '<span class="muted">已选 <b id="dqSelN">0</b> 句</span>'
    +     '<button class="btn btn-sm btn-ghost" id="dqSelAll">全选</button>'
    +     '<button class="btn btn-sm btn-ghost" id="dqSelNone">清空</button>'
    +   '</div>'
    + '</div>'
    + '<div class="table-wrap"><table><thead><tr>'
    +   '<th class="nowrap" style="width:34px"><input type="checkbox" id="dqCkAll" title="全选"></th>'
    +   '<th class="nowrap" style="width:44px">#</th>'
    +   '<th>内容</th><th style="width:180px">出处</th>'
    +   '<th style="text-align:right;width:130px">操作</th>'
    + '</tr></thead><tbody>'
    + list.map(function(q, i){
        return '<tr' + (i === todayIdx ? ' style="background:rgba(175,65,15,.05)"' : '') + '>'
          + '<td><input type="checkbox" data-dq-ck="' + i + '"></td>'
          + '<td class="muted nowrap">' + (i + 1)
          +   (i === todayIdx ? '<span class="badge badge-blue" style="margin-left:4px">今天</span>' : '')
          + '</td>'
          + '<td>' + esc(q.text) + '</td>'
          + '<td class="muted" style="font-size:.78rem">' + (q.from ? esc(q.from) : '—') + '</td>'
          + '<td style="text-align:right"><div class="row-actions">'
          +   '<button data-dq-edit="' + i + '">编辑</button>'
          +   '<button class="danger" data-dq-del="' + i + '">删除</button>'
          + '</div></td></tr>';
      }).join('')
    + '</tbody></table></div>';

  Array.prototype.forEach.call(body.querySelectorAll('[data-dq-edit]'), function(b){
    b.onclick = function(){ dqDialog(Number(b.dataset.dqEdit)); };
  });
  Array.prototype.forEach.call(body.querySelectorAll('[data-dq-del]'), function(b){
    b.onclick = function(){ dqDelete(Number(b.dataset.dqDel)); };
  });

  /* 勾选计数 */
  function syncSel(){
    var cks = body.querySelectorAll('[data-dq-ck]');
    var n = 0;
    Array.prototype.forEach.call(cks, function(c){ if(c.checked) n++; });
    var el = $('dqSelN');
    if(el) el.textContent = String(n);
    var all = $('dqCkAll');
    if(all) all.checked = (n > 0 && n === cks.length);
  }
  Array.prototype.forEach.call(body.querySelectorAll('[data-dq-ck]'), function(c){
    c.onchange = syncSel;
  });
  var ckAll = $('dqCkAll');
  if(ckAll){
    ckAll.onchange = function(){
      Array.prototype.forEach.call(body.querySelectorAll('[data-dq-ck]'), function(c){ c.checked = ckAll.checked; });
      syncSel();
    };
  }
  var bAll = $('dqSelAll'), bNone = $('dqSelNone');
  if(bAll) bAll.onclick = function(){
    Array.prototype.forEach.call(body.querySelectorAll('[data-dq-ck]'), function(c){ c.checked = true; });
    if(ckAll) ckAll.checked = true;
    syncSel();
  };
  if(bNone) bNone.onclick = function(){
    Array.prototype.forEach.call(body.querySelectorAll('[data-dq-ck]'), function(c){ c.checked = false; });
    if(ckAll) ckAll.checked = false;
    syncSel();
  };
  syncSel();
  paintSchedule();
}

/* ============================================================================
 * v3.5.11 本地库增强：批量添加 / 批量删除 / 轮换设置
 * ----------------------------------------------------------------------------
 * 站主要求（原话）：「可以批量删除或添加，也可以指定这两天是哪些句子，指定怎么轮换」
 *
 * 三个能力：
 *   ① 批量添加 —— 一行一句整段粘贴，自动拆行、去重（与库里已有的比对）、跳过空行
 *   ② 批量删除 —— 列表勾选后一次删掉，带确认
 *   ③ 轮换设置 —— 四种模式 + 逐日指定（最多提前 90 天预览排期）
 *
 * 数据落在内容键 quote_schedule：
 *   { mode:'random'|'order'|'rotate'|'date', start:'YYYY-MM-DD', every:N, fixed:{date:[idx]} }
 * ⚠️ 与前端 index.html 的 quoteSchedule() / localQuoteIdx() 必须保持同一套算法，
 *    改一边必须改另一边（e2e 有静态断言盯着「两处模式列表一致」）。
 * ========================================================================= */

/* 本地日期字符串（不能 toISOString，那是 UTC，晚上 8 点后日期会差一天） */
function dqDayStr(d){
  d = d || new Date();
  function p(n){ return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* 今天显示第几句（与前台 localQuoteIdx 同算法） */
function dqTodayIdx(list, todayStr){
  if(!list || !list.length) return -1;
  var cfg = STATE.quoteSched || { mode:'random' };
  var today = todayStr || dqDayStr(new Date());
  var n = list.length;
  var fixed = (cfg.fixed || {})[today];
  if(fixed && fixed.length){
    var valid = fixed.filter(function(i){ return i >= 0 && i < n; });
    if(valid.length) return valid[0];
  }
  if(cfg.mode === 'date') return -1;
  if(cfg.mode === 'order' || cfg.mode === 'rotate'){
    var start = cfg.start || today;
    var diff = dqDayDiff(start, today);
    if(diff < 0) diff = ((diff % n) + n) % n;
    if(cfg.mode === 'order') return diff % n;
    var step = Math.floor(diff / (cfg.every || 1));
    return ((step % n) + n) % n;
  }
  return -1;   /* random */
}

function dqDayDiff(fromStr, toStr){
  var a = new Date(fromStr + 'T00:00:00'), b = new Date(toStr + 'T00:00:00');
  if(isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/* 读云端排期 */
function loadSchedule(){
  api('/content').then(function(j){
    var raw = (j && j.items) ? j.items.quote_schedule : null;
    STATE.quoteSched = dqNormSched(raw);
    paintSchedule();
  }).catch(function(){
    STATE.quoteSched = dqNormSched(null);
    paintSchedule();
  });
}

/* 归一化：任何脏数据都退回安全默认，保证界面永远可编辑 */
function dqNormSched(raw){
  var out = { mode:'random', start:'', every:3, fixed:{} };
  if(!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  var m = String(raw.mode || '');
  if(m === 'order' || m === 'rotate' || m === 'date' || m === 'random') out.mode = m;
  if(typeof raw.start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.start)) out.start = raw.start;
  var e = Number(raw.every);
  out.every = (e > 0) ? Math.min(60, Math.floor(e)) : 3;
  if(raw.fixed && typeof raw.fixed === 'object' && !Array.isArray(raw.fixed)){
    Object.keys(raw.fixed).forEach(function(k){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(k)) return;
      if(!Array.isArray(raw.fixed[k])) return;
      var arr = raw.fixed[k].map(Number).filter(function(x){ return isFinite(x) && x >= 0; });
      if(arr.length) out.fixed[k] = arr;
    });
  }
  return out;
}

/* 保存排期 */
function dqSaveSched(next, okMsg){
  var body = { mode: next.mode, start: next.start || '', every: next.every || 3, fixed: next.fixed || {} };
  return api('/content', { method:'PUT', body:{ items:{ quote_schedule: body } } })
    .then(function(j){
      if(j && j.ok === false) throw new Error(j.error || '保存失败');
      STATE.quoteSched = dqNormSched(body);
      paintSchedule();
      paintQuotes();          /* 重画列表（今天那句的标记会变） */
      if(okMsg) toast(okMsg, 'ok', 3000);
      return true;
    })
    .catch(function(e){ toast('保存失败：' + e.message, 'err', 4200); return false; });
}

/* ---------- 轮换设置面板 ---------- */
function paintSchedule(){
  var host = $('dqSched');
  if(!host) return;
  var cfg = STATE.quoteSched || dqNormSched(null);
  var list = STATE.quotes.list || [];
  var modes = [
    ['random', '每次随机', '每次刷新随机抽一句（旧行为）'],
    ['order',  '按列表顺序轮换', '从起始日期起每天下一句，走到末尾从头再来'],
    ['rotate', '每 N 天换一句', '从起始日期起，每句停留 N 天再换'],
    ['date',   '只按指定日期', '只显示你指定过的那几天，其它天不显示卡片'],
  ];

  var modeHtml = modes.map(function(m){
    var on = cfg.mode === m[0];
    /* v3.5.13（站主反馈「文字溢出」）：全局 .btn 是 height:42px + nowrap，
       两行内容的模式按钮会被硬裁 —— 这里显式放开高度与换行。 */
    return '<button class="btn ' + (on ? '' : 'btn-secondary') + '" data-dq-mode="' + m[0] + '" '
      + 'style="text-align:left;display:block;width:100%;height:auto;white-space:normal;padding:10px 12px;margin-bottom:8px;line-height:1.45">'
      + '<b style="font-size:.84rem">' + (on ? '✓ ' : '') + m[1] + '</b>'
      + '<span style="display:block;font-size:.74rem;opacity:.8;margin-top:2px">' + m[2] + '</span></button>';
  }).join('');

  host.innerHTML =
    '<div style="padding:14px;border:1px solid var(--border);border-radius:12px;background:var(--bg-2)">'
    + '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px">'
    +   '<b style="font-size:.9rem">轮换设置</b>'
    +   '<span class="muted" style="font-size:.76rem">只影响本地库；联网模式下不生效</span>'
    + '</div>'
    /* 模式选择 */
    + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px">' + modeHtml + '</div>'
    /* 起点 + 间隔（order / rotate 才显示） */
    + ((cfg.mode === 'order' || cfg.mode === 'rotate')
        ? '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-top:6px">'
          + '<div class="field" style="margin:0;flex:1;min-width:160px"><label>起始日期</label>'
          +   '<input type="date" id="dqStart" value="' + attr(cfg.start || dqDayStr()) + '"></div>'
          + (cfg.mode === 'rotate'
              ? '<div class="field" style="margin:0;width:140px"><label>每句停留（天）</label>'
                + '<input type="number" id="dqEvery" min="1" max="60" value="' + cfg.every + '"></div>'
              : '')
          + '<button class="btn" id="dqSaveMode" style="height:40px">保存轮换</button>'
          + '</div>'
        : '<div style="margin-top:6px"><button class="btn" id="dqSaveMode">保存设置</button></div>')
    /* 逐日指定 */
    + '<div style="margin-top:18px;padding-top:14px;border-top:1px dashed #e7dbcd">'
    +   '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px">'
    +     '<b style="font-size:.86rem">指定某天显示哪句</b>'
    +     '<span class="muted" style="font-size:.74rem">指定日期优先级最高，任何模式下都照办</span>'
    +   '</div>'
    +   '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px">'
    +     '<div class="field" style="margin:0;width:170px"><label>日期</label>'
    +       '<input type="date" id="dqFxDate" value="' + attr(dqDayStr(new Date(Date.now() + 86400000))) + '"></div>'
    +     '<div class="field" style="margin:0;flex:1;min-width:200px"><label>显示第几句（在「句子列表」里的序号）</label>'
    +       '<input id="dqFxIdx" type="number" min="1" max="' + Math.max(1, list.length) + '" placeholder="例如 3"></div>'
    +     '<button class="btn" id="dqFxAdd" style="height:40px">指定</button>'
    +   '</div>'
    +   dqFixedTable(cfg, list)
    + '</div>'
    /* 未来排期预览 */
    + '<div style="margin-top:18px;padding-top:14px;border-top:1px dashed #e7dbcd">'
    +   '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px">'
    +     '<b style="font-size:.86rem">接下来 14 天预览</b>'
    +     '<span class="muted" style="font-size:.74rem">按当前设置算出来的效果</span>'
    +   '</div>'
    +   dqPreviewTable(cfg, list)
    + '</div>'
    + '</div>';

  /* 模式按钮：点了立即换（不保存，等点「保存设置」） */
  Array.prototype.forEach.call(host.querySelectorAll('[data-dq-mode]'), function(b){
    b.onclick = function(){
      var next = dqNormSched(STATE.quoteSched);
      next.mode = b.dataset.dqMode;
      if(!next.start) next.start = dqDayStr();
      STATE.quoteSched = next;
      paintSchedule();
    };
  });
  var sv = $('dqSaveMode');
  if(sv) sv.onclick = function(){
    var next = dqNormSched(STATE.quoteSched);
    next.mode = (STATE.quoteSched && STATE.quoteSched.mode) || 'random';
    var st = $('dqStart'), ev = $('dqEvery');
    if(st) next.start = st.value || dqDayStr();
    if(ev) next.every = Math.max(1, Math.min(60, Number(ev.value) || 3));
    dqSaveSched(next, '轮换设置已保存');
  };
  var fxAdd = $('dqFxAdd');
  if(fxAdd) fxAdd.onclick = function(){
    var dv = ($('dqFxDate') || {}).value || '';
    var iv = Number(($('dqFxIdx') || {}).value);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(dv)){ toast('请选择日期', 'err'); return; }
    if(!iv || iv < 1 || iv > list.length){ toast('序号要在 1 ~ ' + list.length + ' 之间', 'err'); return; }
    var next = dqNormSched(STATE.quoteSched);
    next.fixed[dv] = [iv - 1];
    dqSaveSched(next, dv + ' 已指定为第 ' + iv + ' 句');
  };
  Array.prototype.forEach.call(host.querySelectorAll('[data-dq-fxdel]'), function(b){
    b.onclick = function(){
      var next = dqNormSched(STATE.quoteSched);
      delete next.fixed[b.dataset.dqFxdel];
      dqSaveSched(next, '已取消指定');
    };
  });
}

/* 已达指定日期的表格 */
function dqFixedTable(cfg, list){
  var keys = Object.keys(cfg.fixed || {}).sort();
  if(!keys.length){
    return '<div class="muted" style="font-size:.78rem;padding:6px 0">还没有指定任何日期。'
      + '比如想让 10 月 20 号显示第 3 句，就在上面填日期和序号后点「指定」。</div>';
  }
  var today = dqDayStr(new Date());
  return '<div class="table-wrap"><table><thead><tr>'
    + '<th style="width:120px">日期</th><th style="width:70px">句号</th><th>内容</th>'
    + '<th style="text-align:right;width:80px">操作</th></tr></thead><tbody>'
    + keys.map(function(k){
        var ids = cfg.fixed[k] || [];
        var txt = ids.map(function(i){
          var q = list[i];
          return q ? ('#' + (i + 1) + ' ' + esc(q.text)) : ('#' + (i + 1) + ' （已不存在）');
        }).join('<br>') || '—';
        var tag = (k === today) ? ' <span class="badge badge-blue">今天</span>' : '';
        var past = (k < today) ? ' style="opacity:.5"' : '';
        return '<tr' + past + '><td class="nowrap">' + esc(k) + tag + '</td>'
          + '<td class="muted">' + ids.map(function(i){ return '#' + (i + 1); }).join(',') + '</td>'
          + '<td style="font-size:.8rem">' + txt + '</td>'
          + '<td style="text-align:right"><div class="row-actions">'
          + '<button class="danger" data-dq-fxdel="' + esc(k) + '">取消</button>'
          + '</div></td></tr>';
      }).join('')
    + '</tbody></table></div>';
}

/* 未来 14 天预览 */
function dqPreviewTable(cfg, list){
  if(!list.length) return '<div class="muted" style="font-size:.78rem">列表还是空的，先加几句再看预览。</div>';
  var rows = '';
  for(var i = 0; i < 14; i++){
    var d = new Date();
    d.setDate(d.getDate() + i);
    var ds = dqDayStr(d);
    var idx = dqTodayIdx(list, ds);
    var isFixed = !!(cfg.fixed && cfg.fixed[ds]);
    var txt;
    if(idx < 0){
      txt = (cfg.mode === 'date') ? '<span class="muted">（不显示）</span>' : '<span class="muted">随机一句</span>';
    }else{
      txt = '<b>#' + (idx + 1) + '</b>　' + esc((list[idx] || {}).text || '');
    }
    rows += '<tr' + (i === 0 ? ' style="background:rgba(175,65,15,.05)"' : '') + '>'
      + '<td class="nowrap muted">' + ds + (i === 0 ? ' <span class="badge badge-blue">今天</span>' : '') + '</td>'
      + '<td style="font-size:.8rem">' + txt + (isFixed ? ' <span class="badge">指定</span>' : '') + '</td></tr>';
  }
  return '<div class="table-wrap"><table><tbody>' + rows + '</tbody></table></div>';
}

/* ---------- 批量添加 ---------- */
function dqBatchAdd(){
  openModal({
    title: '批量添加每日一言',
    sub: '一行一句，整段粘贴即可；空行自动跳过，和现有重复的也会跳过',
    wide: true,
    body:
      '<div class="field"><label for="dqbT">句子（一行一句）</label>'
      + '<textarea id="dqbT" rows="12" style="font-family:inherit;line-height:1.7" '
      + 'placeholder="慢慢来，比较快&#10;把每天的小事做好&#10;不着急，也不放弃"></textarea></div>'
      + '<div class="field"><label for="dqbF">统一出处（可选，留空则不带出处）</label>'
      + '<input id="dqbF" maxlength="60" placeholder="例如：—— 班主任"></div>'
      + '<div id="dqbHint" class="muted" style="font-size:.78rem"></div>',
    foot: '<button class="btn btn-ghost" data-no>取消</button>'
        + '<button class="btn" data-yes>添加</button>',
    onMount: function(box){
      var ta = box.querySelector('#dqbT');
      var hint = box.querySelector('#dqbHint');
      function parse(){
        var raw = ta.value || '';
        var lines = raw.split(/\r?\n/).map(function(x){ return x.trim(); }).filter(function(x){ return x; });
        var seen = {}, exist = {};
        (STATE.quotes.list || []).forEach(function(q){ exist[String(q.text).trim()] = 1; });
        var add = [], dup = 0;
        lines.forEach(function(x){
          if(exist[x] || seen[x]){ dup++; return; }
          seen[x] = 1; add.push(x);
        });
        return { lines: lines, add: add, dup: dup };
      }
      function sync(){
        var r = parse();
        hint.innerHTML = r.lines.length
          ? '识别到 <b>' + r.lines.length + '</b> 行，其中 <b>' + r.add.length + '</b> 句会新增'
            + (r.dup ? '，<b>' + r.dup + '</b> 句重复已跳过' : '')
          : '<span class="muted">还没输入内容</span>';
      }
      ta.oninput = sync;
      sync();
      box.querySelector('[data-no]').onclick = closeModal;
      box.querySelector('[data-yes]').onclick = function(){
        var r = parse();
        if(!r.add.length){ toast(r.lines.length ? '没有可新增的句子（都重复了）' : '请先输入句子', 'err'); return; }
        var from = (box.querySelector('#dqbF').value || '').trim();
        var next = (STATE.quotes.list || []).slice();
        r.add.forEach(function(t){
          var item = { text: t };
          if(from) item.from = from;
          next.push(item);
        });
        api('/content', { method:'PUT', body:{ items:{ daily_quote: next } } })
          .then(function(j){
            if(j && j.ok === false) throw new Error(j.error || '保存失败');
            closeModal();
            toast('已新增 ' + r.add.length + ' 句' + (r.dup ? '（跳过 ' + r.dup + ' 句重复）' : ''), 'ok', 3500);
            loadQuotes();
          })
          .catch(function(e){ toast('保存失败：' + e.message, 'err', 4200); });
      };
    }
  });
}

/* ---------- 批量删除 ---------- */
function dqBatchDelete(){
  var body = $('dqBody');
  var list = STATE.quotes.list || [];
  if(!body || !list.length) return;
  var picked = [];
  Array.prototype.forEach.call(body.querySelectorAll('[data-dq-ck]'), function(c){
    if(c.checked) picked.push(Number(c.dataset.dqCk));
  });
  if(!picked.length){
    toast('请先在列表里勾选要删除的句子（表头复选框可全选）', 'err', 3600);
    return;
  }
  picked.sort(function(a, b){ return a - b; });
  var preview = picked.slice(0, 5).map(function(i){
    return '· ' + esc((list[i] || {}).text || '');
  }).join('<br>');
  confirmBox({
    title: '批量删除 ' + picked.length + ' 句',
    html: '确定删除以下 ' + picked.length + ' 句吗？<br><br>' + preview
      + (picked.length > 5 ? '<br>…等共 ' + picked.length + ' 句' : ''),
    detail: '删完不可恢复。如果这些句子被「指定日期」引用过，那些指定会自动失效。',
    danger: true,
    okText: '删除 ' + picked.length + ' 句'
  }).then(function(ok){
    if(!ok) return;
    var kill = {};
    picked.forEach(function(i){ kill[i] = 1; });
    var next = [];
    var remap = {};        /* 旧下标 → 新下标，用于修指定日期 */
    list.forEach(function(q, i){
      if(kill[i]) return;
      remap[i] = next.length;
      next.push(q);
    });
    /* 修 fixed：被删的下标去掉，其余重映射；整条空了就删掉这一天 */
    var sched = dqNormSched(STATE.quoteSched);
    var fixed = {};
    Object.keys(sched.fixed).forEach(function(k){
      var arr = sched.fixed[k].map(function(i){ return remap[i]; })
        .filter(function(x){ return x !== undefined; });
      if(arr.length) fixed[k] = arr;
    });
    sched.fixed = fixed;

    Promise.all([
      api('/content', { method:'PUT', body:{ items:{ daily_quote: next } } }),
      api('/content', { method:'PUT', body:{ items:{ quote_schedule: {
        mode: sched.mode, start: sched.start, every: sched.every, fixed: sched.fixed
      } } } }),
    ]).then(function(){
      toast('已删除 ' + picked.length + ' 句', 'ok', 3000);
      STATE.quoteSched = sched;
      loadQuotes();
    }).catch(function(e){ toast('删除失败：' + e.message, 'err', 4200); });
  });
}

function dqDialog(idx){
  var list = STATE.quotes.list || [];
  var isNew = (idx === null || idx === undefined);
  var q = isNew ? { text:'', from:'' } : (list[idx] || { text:'', from:'' });

  openModal({
    title: isNew ? '新增每日一言' : '编辑每日一言',
    sub: '留空出处的就只显示句子本身',
    body:
      '<div class="field"><label for="dqT">内容</label>'
      + '<textarea id="dqT" rows="3" maxlength="200" placeholder="例如：慢慢来，比较快">' + esc(q.text) + '</textarea></div>'
      + '<div class="field"><label for="dqF">出处（可选）</label>'
      + '<input id="dqF" maxlength="60" value="' + attr(q.from) + '" placeholder="例如：—— 班主任"></div>',
    foot: '<button class="btn btn-ghost" data-no>取消</button>'
        + '<button class="btn" data-yes>' + (isNew ? '新增' : '保存') + '</button>',
    onMount: function(box){
      box.querySelector('[data-no]').onclick = closeModal;
      box.querySelector('[data-yes]').onclick = function(){
        var text = (box.querySelector('#dqT').value || '').trim();
        var from = (box.querySelector('#dqF').value || '').trim();
        if(!text){ toast('内容不能为空', 'err'); return; }

        var next = list.slice();
        var item = { text: text };
        if(from) item.from = from;
        if(isNew) next.push(item); else next[idx] = item;

        api('/content', { method:'PUT', body:{ items:{ daily_quote: next } } })
          .then(function(){
            closeModal();
            toast(isNew ? '已新增' : '已保存', 'ok', 3000);
            loadQuotes();
          })
          .catch(function(e){ toast('保存失败：' + e.message, 'err', 4200); });
      };
    }
  });
}

function dqDelete(idx){
  var list = STATE.quotes.list || [];
  var q = list[idx];
  if(!q) return;
  confirmBox({
    title: '删除每日一言',
    html: '确定删除这句吗？<br><br><b>' + esc(q.text) + '</b>',
    detail: list.length === 1 ? '这是最后一句，删完首页那张卡片就不会再显示。' : '',
    danger: true,
    okText: '删除'
  }).then(function(ok){
    if(!ok) return;
    var next = list.slice();
    next.splice(idx, 1);
    api('/content', { method:'PUT', body:{ items:{ daily_quote: next } } })
      .then(function(){ toast('已删除', 'ok'); loadQuotes(); })
      .catch(function(e){ toast('删除失败：' + e.message, 'err', 4200); });
  });
}
