/* ============================================================================
 * fs-keep.js —— 站内换页面时，全屏不丢（v4.8.0）
 * ----------------------------------------------------------------------------
 * 站主原话：「全站都要适配全屏模式。我在作业界面打开了全屏，然后点了那个时钟，
 *            它就不会跳到时钟那里，又退出了全屏。这种要自动全屏 —— 只要还在
 *            这个网页里面，你切换了不同的页面，窗口大小也是不能改的。」
 *
 * 为什么必须单独一个文件：index.html / clock.html / admin.html 是三个独立页面，
 * 各自加载各自的脚本。全屏状态是「页面级」的，一跳转浏览器就一定退出全屏，
 * 而且 requestFullscreen 又必须由用户手势触发 —— 两边都得处理，所以抽成一份，
 * 三边共用，避免三份实现慢慢漂移（历史上这种「只改了一边」的坑踩过好几次）。
 *
 * 做法：
 *   ① 进入全屏时记一个「想要全屏」的标记（localStorage，跨页面读得到）；
 *   ② 新页面加载时，如果标记还在、当前又不在全屏，就先自己试一次（部分内核允许）；
 *   ③ 试不成（大多数浏览器都会拒），就等用户第一次点击 / 按键 / 触摸时补上 ——
 *      用户点时钟按钮那一刻本身就是手势，导航后第一个动作也一定是手势；
 *   ④ 按 Esc 或点「退出全屏」时把标记清掉，不然会一直追着用户全屏。
 *
 * 关键细节：跳转时浏览器也会触发一次 fullscreenchange（退出全屏），
 * 如果照常把标记清掉，那这个功能就永远不生效。所以 pagehide 时先立一个
 * 「正在跳转」的旗子，fullscreenchange 看到旗子就不清标记。
 * ========================================================================= */
(function (global) {
  'use strict';

  var KEY = 'cls_fs_want';
  var armed = false;

  function fsEl() {
    return document.fullscreenElement || document.webkitFullscreenElement
      || document.msFullscreenElement || null;
  }
  function read() {
    try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }
  function write(v) {
    try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (e) {}
  }
  function ask() {
    var d = document.documentElement;
    var p = null;
    try {
      if (d.requestFullscreen) p = d.requestFullscreen({ navigationUI: 'hide' });
      else if (d.webkitRequestFullscreen) p = d.webkitRequestFullscreen();
      else if (d.msRequestFullscreen) p = d.msRequestFullscreen();
    } catch (e) { return null; }
    /* v4.10.26：记下「这一次全屏是自动恢复的」。
       刷新后按钮按真实状态写「退出全屏」，但用户点它时，pointerdown 先触发
       这里的自动恢复（页面瞬间变全屏），click 再走 BIG.hwFull 就会误判成
       「已经在全屏 → 退出」——表现正是站主说的「点全屏反而退出」。
       big.js 看到这个时间戳（1.5 秒内）就知道是刚恢复的，不再反手退出。 */
    if (p && p.then) {
      p = p.then(function (v) { try { window.__fsJustOn = Date.now(); } catch (e) {} return v; });
    }
    return p;
  }
  function arm() {
    if (armed) return;
    armed = true;
    var evs = ['pointerdown', 'touchstart', 'keydown', 'click'];
    function once() {
      evs.forEach(function (t) { document.removeEventListener(t, once, true); });
      armed = false;
      if (!read() || fsEl()) return;
      var p = ask();
      if (p && p.catch) p.catch(function () {});
    }
    evs.forEach(function (t) { document.addEventListener(t, once, true); });
  }
  function restore() {
    if (!read() || fsEl()) return;
    var p = ask();
    if (p && p.catch) p.catch(function () { arm(); });
    /* 内核对「无手势全屏」有时直接抛错、有时静默失败 —— 都兜一次 */
    setTimeout(function () { if (read() && !fsEl()) arm(); }, 600);
  }

  try {
    document.addEventListener('fullscreenchange', function () {
      if (fsEl()) { write(1); return; }
      /* 正在跳转：这是浏览器自己退的，别把标记清掉 */
      if (document.__fsKeepNav) return;
      write(0);
    });
    document.addEventListener('webkitfullscreenchange', function () {
      if (fsEl()) write(1);
    });
    global.addEventListener('pagehide', function () {
      if (read()) document.__fsKeepNav = 1;
    });
    global.addEventListener('pageshow', function () {
      document.__fsKeepNav = 0;
    });
  } catch (e) {}

  global.FSKeep = {
    on: function () { write(1); },
    off: function () { write(0); },
    want: read,
    isOn: function () { return !!fsEl(); },
    restore: restore
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { restore(); });
  } else {
    restore();
  }
})(window);
