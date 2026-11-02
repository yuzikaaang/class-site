/* ============================================================================
 * auth-bus.js —— 全站统一的「登录态总线」
 * ----------------------------------------------------------------------------
 * 为什么单独抽一个文件（v3.18.0）：
 *   站主原话：「以后都是复用登录态的方法……如果你自己已经登录的话，就复用
 *   浏览器里已经有的登录态，省得再次登录。这个登录态只存在本地，换设备就没有。」
 *
 *   在此之前，登录态散在四处各写一份：
 *     · index.html / app.js  → AUTH + localStorage['cls_auth']
 *     · share.html           → 不读，纯 token 游客
 *     · clock.html           → 直接 localStorage.getItem('cls_auth')，只读不判
 *     · games/*.html         → 各自为政，基本没接
 *   结果是同源不同页，明明登录过还要再登一次，深链分享出去也接不上人。
 *
 *   现在：**所有页面只认 ClsAuth**。同源 = 同一份 localStorage = 同一份登录态，
 *   换设备/换浏览器自然就没有（这正是站主要的）。
 *
 * 三条纪律：
 *   ① 只读 token，不打印、不上报、不放 URL。
 *   ② 过期一律「静默失效 + 记住原本要去哪」，登录完自动回跳，不丢现场。
 *   ③ 任何页面都要能在「没有 ClsAuth」的极端情况下正常工作（降级为未登录）。
 * ========================================================================= */
(function (global) {
  'use strict';

  var KEY = 'cls_auth';        /* 与历史版本保持同一个键，老用户不用重登 */
  var NEXT_KEY = 'cls_next';   /* 未登录时想去的地方（sessionStorage，关标签页即弃） */
  var listeners = [];
  var cache = null;            /* { token, user } —— 读一次内存缓存，避免每帧 JSON.parse */

  function safeGet(storage, k) {
    try { return storage.getItem(k); } catch (e) { return null; }
  }
  function safeSet(storage, k, v) {
    try { storage.setItem(k, v); return true; } catch (e) { return false; }
  }
  function safeDel(storage, k) {
    try { storage.removeItem(k); } catch (e) {}
  }

  function normalize(o) {
    if (!o || typeof o !== 'object') return { token: '', user: null };
    return {
      token: String(o.token || ''),
      user: (o.user && typeof o.user === 'object') ? o.user : null
    };
  }

  /* 读：先看内存，再看 localStorage。localStorage 里可能被别的标签页改过，
     所以每次跨页回来的第一次读都重新 parse。 */
  function read() {
    if (cache) return cache;
    var raw = safeGet(global.localStorage, KEY);
    if (!raw) { cache = { token: '', user: null }; return cache; }
    try { cache = normalize(JSON.parse(raw)); }
    catch (e) { cache = { token: '', user: null }; }
    return cache;
  }

  function emit() {
    var a = read();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](a.token, a.user); } catch (e) {}
    }
  }

  function save(auth) {
    var a = normalize(auth);
    cache = a;
    if (a.token) safeSet(global.localStorage, KEY, JSON.stringify(a));
    else safeDel(global.localStorage, KEY);
    emit();
    return a;
  }

  function clear() {
    cache = { token: '', user: null };
    safeDel(global.localStorage, KEY);
    emit();
  }

  /* ---------- 回跳现场 ---------- */
  /* 存的是「完整目标」，形如：
       #/board/3/card/a1          —— 同页内的深链
       ./share.html?t=xxx         —— 站内另一个静态页
     只接受站内相对路径 / 同源地址，绝不接受外部站点（防钓鱼跳转）。 */
  function setNext(target) {
    var t = String(target || '');
    if (!t) { clearNext(); return ''; }
    if (!isInternal(t)) return '';
    safeSet(global.sessionStorage, NEXT_KEY, t);
    return t;
  }
  function peekNext() { return safeGet(global.sessionStorage, NEXT_KEY) || ''; }
  function clearNext() { safeDel(global.sessionStorage, NEXT_KEY); }

  function isInternal(t) {
    if (/^(javascript|data|vbscript):/i.test(t)) return false;
    if (/^https?:\/\//i.test(t)) {
      try { return new URL(t).origin === global.location.origin; } catch (e) { return false; }
    }
    if (/^\/\//.test(t)) return false;
    return true;   /* 相对路径 / 纯 hash 都算站内 */
  }

  /* 取出并清空。返回值交给调用方决定怎么跳（同页换 hash / 整页 replace） */
  function takeNext() {
    var t = peekNext();
    clearNext();
    return t;
  }

  /* 把「当前地址 + hash」拼成一个可回跳的相对地址。
     不传参数 = 就是现在这一屏（含当前 hash）；传 '' = 明确不要 hash。
     ⚠️ 早期版本写成 String(hash || '')，于是 here() 永远丢掉 hash ——
     401 回跳会把人扔回首页而不是原来那一页（自测踩到）。 */
  function here(hash) {
    var h = (hash === undefined || hash === null) ? (global.location.hash || '') : String(hash);
    if (h && h.charAt(0) !== '#') h = '#' + h;
    return global.location.pathname + global.location.search + h;
  }

  /* 跨标签页同步：一个标签登录了，另开的分享页/时钟页立刻知道自己已登录 */
  global.addEventListener('storage', function (e) {
    if (e && e.key === KEY) {
      cache = null;
      read();
      emit();
    }
  });

  /* 回到前台时对一下本地存储（有些浏览器 storage 事件不可靠） */
  global.addEventListener('focus', function () { cache = null; });

  global.ClsAuth = {
    KEY: KEY,
    get token() { return read().token; },
    get user() { return read().user; },
    isLoggedIn: function () { return !!read().token; },
    isAdmin: function () { var u = read().user; return !!(u && u.role === 'admin'); },
    userName: function () {
      var u = read().user || {};
      return u.displayName || u.display_name || u.username || u.name || '';
    },
    save: save,
    clear: clear,
    reload: function () { cache = null; return read(); },
    onChange: function (fn) {
      if (typeof fn === 'function') listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    /* 认证头：所有 fetch 统一从这里取，避免各处各写一份 */
    header: function (extra) {
      var h = extra || {};
      var t = read().token;
      if (t) h['Authorization'] = 'Bearer ' + t;
      return h;
    },
    setNext: setNext,
    peekNext: peekNext,
    takeNext: takeNext,
    clearNext: clearNext,
    here: here,
    isInternal: isInternal
  };
})(typeof window !== 'undefined' ? window : this);
