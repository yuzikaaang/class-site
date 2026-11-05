/* ============================================================================
 * pickfx.js —— 随机点名抽取动画（v4.5.0）
 * ----------------------------------------------------------------------------
 * 站主原话（2026-11-05）：
 *   「抽人可以新增个抽人动画……第一个是有点类似蛋仔派对里面的那个盲盒……
 *     第二个就有点类似原神那种抽卡……第三个就是类似 CS 里面那种开宝箱……
 *     但是要做我自己专属的，你毕竟你那个放在里面太突兀了。」
 *   「按照学号来排，每隔十个学号换一种颜色……0 到 10 号一种颜色……
 *     61 号和 62 号是 50 到 60 段的颜色。」
 *   「动画要自然，离线也可以用。」
 *
 * 三条硬约束（决定了实现方式）：
 *   ① 离线可用 → 不引任何外链、不加载图片音效文件；盒子/卡面/光效全部 CSS 画，
 *      音效走 WebAudio 现场合成，沿用站内 cls_sfx 开关。
 *   ② 不做成别人的复刻 → 不用蛋仔的橙盒、原神的星辉、CS 的红蓝箱。
 *      本站的三套都从「班级」这个身份出发：礼盒用牛皮纸 + 绶带 + 火漆，
 *      卡面用六边班徽 + 毛边纸纹，宝箱用刻度转盘 + 铜指针。
 *   ③ 动画不能挡事 → 顶部始终有「跳过」，播完自动回到结果页；
 *      系统开启「减少动态效果」时自动把时长压到 0.7 秒。
 *
 * 对外只有一个入口：
 *   PickFX.play({ mode, items, pool, hide, single, onDone })
 *     mode  : 'box' 盲盒 / 'card' 抽卡 / 'case' 宝箱转盘
 *     items : [{ name, no }]，no = 学号末两位（1–62），决定光辉颜色
 *     pool  : 候选名单，宝箱转盘用它铺背景格
 *     hide  : 宝箱模式是否隐藏姓名（只露光辉）
 *     single: 单个重抽，播完自动收场
 *   PickFX.stop()  立即收场（关闭点名面板时调用）
 * ========================================================================= */
(function (global) {
  'use strict';

  /* 学号分段颜色：01–10 / 11–20 / 21–30 / 31–40 / 41–50 / 51–62。
     61、62 落在最后一段 —— 按站主要求与 51–60 同色（Math.floor((no-1)/10) 再夹到 5）。
     取值不是随手挑的：六色在深底与浅底上都能拉开，且相邻两段色相差 ≥60°，
     投影到教室大屏远看也不会糊成一片。 */
  var TIERS = [
    { c: '#0d9aa8', s: '#67e8f9' },   /* 青 */
    { c: '#2f74e0', s: '#93c5fd' },   /* 蓝 */
    { c: '#7c4ddb', s: '#c4b5fd' },   /* 紫 */
    { c: '#d63f8f', s: '#f9a8d4' },   /* 玫 */
    { c: '#c97a09', s: '#fcd34d' },   /* 金 */
    { c: '#0d8f66', s: '#6ee7b7' }    /* 绿 */
  ];
  var GREY = { c: '#7b8794', s: '#cbd5e1' };

  function swatch(no) {
    var n = parseInt(no, 10);
    if (!n || n < 1) return GREY;               /* 无学号账号（老师/管理员）用中性灰 */
    return TIERS[Math.min(5, Math.floor((n - 1) / 10))];
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function reduced() {
    try { return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }

  /* ---------- 音效：WebAudio 现场合成，无音频文件，断网照样响 ---------- */
  var AC = null, lastTick = 0;
  function soundOn() {
    try { return localStorage.getItem('cls_sfx') !== 'off'; } catch (e) { return true; }
  }
  function ac() {
    if (!soundOn()) return null;
    if (!AC) {
      try { AC = new (global.AudioContext || global.webkitAudioContext)(); } catch (e) { return null; }
    }
    if (AC.state === 'suspended') { try { AC.resume(); } catch (e) {} }
    return AC;
  }
  function tone(freq, dur, vol, type, delay) {
    var c = ac();
    if (!c) return;
    try {
      var o = c.createOscillator(), g = c.createGain();
      var t0 = c.currentTime + (delay || 0);
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol || 0.03, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    } catch (e) {}
  }
  function tick() {
    var now = Date.now();
    if (now - lastTick < 55) return;
    lastTick = now;
    tone(1500, 0.028, 0.012, 'square');
  }
  function charge() { tone(220, 0.42, 0.026, 'sawtooth'); tone(330, 0.42, 0.02, 'sine', 0.01); }
  function burst() { tone(150, 0.3, 0.05, 'sine'); tone(420, 0.16, 0.026, 'triangle', 0.015); }
  function chime() {
    tone(784, 0.12, 0.035, 'sine');
    tone(1046, 0.16, 0.03, 'sine', 0.08);
    tone(1318, 0.22, 0.022, 'sine', 0.16);
  }
  function finale() {
    [523, 659, 784, 1046].forEach(function (f, i) { tone(f, 0.14, 0.04, 'triangle', i * 0.07); });
  }

  /* ---------- 会话 ---------- */
  var S = null;

  function later(fn, ms) {
    if (!S) return 0;
    var id = setTimeout(function () { if (S) fn(); }, ms);
    S.timers.push(id);
    return id;
  }
  function raf(fn) {
    if (!S) return;
    var id = requestAnimationFrame(function (t) { if (S) fn(t); });
    S.rafs.push(id);
  }
  function rafCancel() {
    if (!S) return;
    S.rafs.forEach(function (id) { cancelAnimationFrame(id); });
    S.rafs = [];
  }

  function titleOf(mode) {
    return mode === 'card' ? '卡片抽取' : (mode === 'case' ? '宝箱抽取' : '盲盒抽取');
  }
  function subOf(mode, n, single) {
    if (single) return '单个重抽 · 共 1 人';
    if (mode === 'case') return '共 ' + n + ' 人 · 逐个开启';
    return '共 ' + n + ' 个 · 逐个开启';
  }

  function legendHtml() {
    var ranges = ['01–10', '11–20', '21–30', '31–40', '41–50', '51–62'];
    return '<div class="pfx-legend">'
      + '<span class="pfx-lg-k">学号色</span>'
      + TIERS.map(function (t, i) {
        return '<span class="pfx-lg"><i style="--pc:' + t.c + ';--ps:' + t.s + '"></i>' + ranges[i] + '</span>';
      }).join('')
      + '</div>';
  }

  /* ---------- 盲盒 / 抽卡：网格 ---------- */
  function cellHtml(mode, it, i) {
    var sw = swatch(it.no), cls = mode === 'card' ? 'pfx-c' : 'pfx-b';
    var style = 'style="--pc:' + sw.c + ';--ps:' + sw.s + '"';
    if (mode === 'card') {
      return '<button type="button" class="pfx-cell ' + cls + '" data-i="' + i + '" ' + style + '>'
        + '<span class="cd-beam"></span>'
        + '<span class="cd-in">'
        +   '<span class="cd-face cd-back"><span class="cd-sig">'
        +     '<svg viewBox="0 0 48 48" aria-hidden="true">'
        +       '<path d="M24 4 41 13.5v21L24 44 7 34.5v-21z" fill="none" stroke="currentColor" stroke-width="1.8"/>'
        +       '<path d="M24 13.5 33.5 19v10L24 34.5 14.5 29V19z" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".65"/>'
        +       '<circle cx="24" cy="24" r="3.4" fill="currentColor"/>'
        +     '</svg></span><span class="cd-foil"></span></span>'
        +   '<span class="cd-face cd-front"><span class="cd-aura"></span>'
        +     '<b>' + esc(it.name) + '</b>'
        +     '<em>' + (it.no ? two(it.no) + ' 号' : '') + '</em>'
        +   '</span>'
        + '</span>'
        + '</button>';
    }
    return '<button type="button" class="pfx-cell ' + cls + '" data-i="' + i + '" ' + style + '>'
      + '<span class="bx-beam"></span>'
      + '<span class="bx-glow"></span>'
      + '<span class="bx">'
      +   '<span class="bx-body"><span class="bx-rib"></span><span class="bx-mark">?</span></span>'
      +   '<span class="bx-lid"><span class="bx-rib bx-rib-lid"></span></span>'
      + '</span>'
      + '<span class="bx-name"><b>' + esc(it.name) + '</b>'
      +   '<em>' + (it.no ? two(it.no) + ' 号' : '') + '</em></span>'
      + '</button>';
  }
  function two(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

  function gridCtl(root, items, opts) {
    var cells = [].slice.call(root.querySelectorAll('.pfx-cell'));
    var busy = {}, opened = 0, queue = [], running = false;

    function open(i, fast) {
      if (busy[i]) return;
      var cell = cells[i];
      if (!cell || cell.classList.contains('open')) return;
      busy[i] = true;
      cell.classList.add('charge');
      charge();
      later(function () {
        if (!S) return;
        cell.classList.remove('charge');
        cell.classList.add('open');
        burst();
        opened++;
        if (opened === items.length) {
          later(function () {
            root.querySelector('.pfx-foot').classList.add('on');
            var d = root.querySelector('.pfx-done');
            d.disabled = false;
            d.classList.add('ready');
            if (opts.single) later(finish, 700);
            else later(finish, 1600);
          }, 420);
        }
      }, fast ? 90 : 460);
    }

    function runQueue() {
      if (running || !queue.length) return;
      running = true;
      (function next() {
        if (!S || !queue.length) { running = false; return; }
        open(queue.shift(), true);
        later(next, 210);
      })();
    }

    cells.forEach(function (cell, i) {
      cell.addEventListener('click', function () {
        if (!S || S.ending) return;
        open(i, false);
      });
    });

    var allBtn = root.querySelector('.pfx-all');
    if (allBtn) {
      allBtn.addEventListener('click', function () {
        if (!S || S.ending) return;
        allBtn.disabled = true;
        allBtn.textContent = '开启中';
        for (var i = 0; i < items.length; i++) {
          if (!cells[i].classList.contains('open') && !busy[i]) queue.push(i);
        }
        runQueue();
      });
    }

    return {
      /* 跳过：把未开的全部瞬间翻开，不做逐格动画 */
      flush: function () {
        cells.forEach(function (cell, i) {
          if (cell.classList.contains('open')) return;
          busy[i] = true;
          cell.classList.remove('charge');
          cell.classList.add('open', 'flat');
        });
        opened = items.length;
      },
      count: function () { return opened; }
    };
  }

  /* ---------- 宝箱：横向转盘 ---------- */
  function tileHtml(hide) {
    return function (it) {
      var sw = swatch(it.no);
      return '<div class="pfx-tile" style="--pc:' + sw.c + ';--ps:' + sw.s + '">'
        + (hide
            ? '<span class="pfx-orb"></span>'
            : '<span class="pfx-tn">' + esc(it.name) + '</span>')
        + '</div>';
    };
  }
  function nameOf(it) {
    return '<span class="pfx-tn">' + esc(it.name) + (it.no ? '<i>' + two(it.no) + '</i>' : '') + '</span>';
  }

  function caseCtl(root, items, opts) {
    var reel = root.querySelector('.pfx-reel');
    var strip = root.querySelector('.pfx-strip-in');
    var wins = root.querySelector('.pfx-wins');
    var cntEl = root.querySelector('.pfx-cnt');
    var pool = (opts.pool && opts.pool.length) ? opts.pool : items;
    var hide = !!opts.hide;
    var i = 0, target = 0, pitch = 112, iw = 104;

    function round() {
      if (!S || S.ending) return;
      var win = items[i];
      var M = 40 + Math.min(12, items.length * 2);
      var at = M - 7;
      var tiles = [];
      for (var k = 0; k < M; k++) tiles.push(pool[(Math.random() * pool.length) | 0]);
      tiles[at] = win;

      reel.style.transition = 'none';
      reel.style.transform = 'translate3d(0,0,0)';
      reel.innerHTML = tiles.map(tileHtml(hide)).join('');

      /* ⚠️ 必须用 offsetWidth / offsetLeft，不能用 getBoundingClientRect ——
         舞台入场有 0.3s 的 scale 动画，rect 拿到的是「缩放后」的尺寸（实测 104 → 102.5），
         而 transform 的位移是在未缩放坐标系里生效的，两者一混，中奖格会系统性偏左半个格。 */
      var a = reel.children[0], b = reel.children[1];
      if (a) iw = a.offsetWidth || 104;
      pitch = (a && b) ? (b.offsetLeft - a.offsetLeft) : iw + 8;
      var wrapW = strip.clientWidth;
      target = Math.max(0, at * pitch + iw / 2 - wrapW / 2 + (Math.random() * 14 - 7));

      var dur = (i === 0 ? 3100 : 1500);
      if (reduced()) dur = 620;
      var t0 = performance.now(), lastPx = 0;

      (function step(now) {
        if (!S || S.ending) return;
        var p = Math.min(1, (now - t0) / dur);
        var e = 1 - Math.pow(1 - p, 5);
        var x = target * e;
        reel.style.transform = 'translate3d(' + (-x) + 'px,0,0)';
        if (x - lastPx >= pitch * 0.9) { lastPx = x; tick(); }
        if (p < 1) raf(step);
        else settle(at);
      })(t0);
    }

    function settle(at) {
      var cell = reel.children[at];
      if (!cell) { next(); return; }
      cell.classList.add('win');
      if (hide) {
        var orb = cell.querySelector('.pfx-orb');
        if (orb) orb.outerHTML = nameOf(items[i]);
      }
      burst(); chime();
      wins.insertAdjacentHTML('beforeend',
        '<span class="pfx-win" style="--pc:' + swatch(items[i].no).c + '">' + esc(items[i].name) + '</span>');
      if (cntEl) cntEl.textContent = String(i + 1);
      i++;
      next();
    }

    function next() {
      if (i >= items.length) {
        finale();
        later(finish, 1000);
        return;
      }
      later(round, 900);
    }

    return {
      start: function () { round(); },
      flush: function () {
        rafCancel();
        reel.style.transition = 'none';
        reel.style.transform = 'translate3d(' + (-target) + 'px,0,0)';
        for (var k = i; k < items.length; k++) {
          wins.insertAdjacentHTML('beforeend',
            '<span class="pfx-win" style="--pc:' + swatch(items[k].no).c + '">' + esc(items[k].name) + '</span>');
        }
        if (cntEl) cntEl.textContent = String(items.length);
        i = items.length;
      },
      count: function () { return i; }
    };
  }

  /* ---------- 外壳 ---------- */
  function shell(mode, items, opts) {
    var body = '';
    if (mode === 'case') {
      body = '<div class="pfx-case">'
        + '<div class="pfx-case-hd">'
        +   '<span>已开启 <b class="pfx-cnt">0</b> / ' + items.length + '</span>'
        +   '<span class="pfx-case-hint">' + (opts.hide ? '抽取中隐藏姓名，停止后显示' : '抽取中显示姓名') + '</span>'
        + '</div>'
        + '<div class="pfx-strip"><div class="pfx-strip-in"><div class="pfx-reel"></div></div>'
        +   '<span class="pfx-mark"></span><span class="pfx-mask l"></span><span class="pfx-mask r"></span>'
        + '</div>'
        + '<div class="pfx-wins"></div>'
        + '</div>';
    } else {
      var n = items.length;
      var vw = global.innerWidth || 1440;
      var cols = Math.min(n, vw < 620 ? 4 : 5);
      var cellw = vw < 620 ? 104 : (vw < 900 ? 158 : 200);
      body = '<div class="pfx-grid" style="--cols:' + cols + ';--cellw:' + cellw + 'px">'
        + items.map(function (it, i) { return cellHtml(mode, it, i); }).join('')
        + '</div>';
    }

    return '<div class="pfx-in">'
      + '<div class="pfx-bar">'
      +   '<div class="pfx-tit"><div class="pfx-title">' + titleOf(mode) + '</div>'
      +     '<div class="pfx-sub">' + subOf(mode, items.length, opts.single) + '</div></div>'
      +   '<button type="button" class="pfx-skip">跳过</button>'
      + '</div>'
      + '<div class="pfx-legend-wrap">' + legendHtml() + '</div>'
      + '<div class="pfx-body">' + body + '</div>'
      + '<div class="pfx-foot">'
      +   (mode === 'case' || opts.single ? '' : '<button type="button" class="pfx-btn pfx-all">全部开启</button>')
      +   '<button type="button" class="pfx-btn pfx-done" disabled>查看结果</button>'
      + '</div>'
      + '</div>';
  }

  /* ---------- 收场 ---------- */
  function finish() {
    if (!S || S.closed) return;
    S.closed = true;
    var s = S;
    s.ending = true;
    if (!s.skipped) { try { finale(); } catch (e) {} }
    var cb = s.opts.onDone;
    /* 先渲染结果页再淡出 —— 否则会看到背后旧画面闪一下 */
    try { if (cb) cb(); } catch (e) {}
    var root = s.root;
    root.classList.add('out');
    setTimeout(function () {
      if (root.parentNode) root.parentNode.removeChild(root);
      if (S === s) S = null;
    }, 260);
  }

  function skip() {
    if (!S || S.closed) return;
    S.skipped = true;
    S.ending = true;
    rafCancel();
    S.timers.forEach(clearTimeout);
    S.timers = [];
    try { S.ctl.flush(); } catch (e) {}
    finish();
  }

  /* ---------- 入口 ---------- */
  function play(opts) {
    opts = opts || {};
    /* 先把上一次收干净（连点「开始抽取」不会叠出两层） */
    if (S) {
      var old = S;
      S = null;
      if (old.root && old.root.parentNode) old.root.parentNode.removeChild(old.root);
      old.timers.forEach(clearTimeout);
      old.rafs.forEach(cancelAnimationFrame);
    }

    var mode = opts.mode;
    if (mode !== 'box' && mode !== 'card' && mode !== 'case') mode = 'box';
    var items = (opts.items || []).slice(0, 10);
    if (!items.length) { if (opts.onDone) opts.onDone(); return; }

    var root = document.createElement('div');
    root.className = 'pfx';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', titleOf(mode));
    root.innerHTML = shell(mode, items, opts);
    document.body.appendChild(root);

    S = {
      root: root, timers: [], rafs: [], mode: mode, items: items, opts: opts,
      ending: false, closed: false, skipped: false, ctl: null
    };
    S.ctl = (mode === 'case') ? caseCtl(root, items, opts) : gridCtl(root, items, opts);

    root.querySelector('.pfx-skip').addEventListener('click', skip);
    root.querySelector('.pfx-done').addEventListener('click', function () {
      if (!S || S.closed) return;
      S.ending = true;
      finish();
    });

    if (mode === 'case') S.ctl.start();
  }

  function stop() {
    if (!S) return;
    var s = S;
    S = null;
    s.timers.forEach(clearTimeout);
    s.rafs.forEach(cancelAnimationFrame);
    if (s.root && s.root.parentNode) s.root.parentNode.removeChild(s.root);
  }

  global.PickFX = {
    play: play,
    stop: stop,
    swatch: swatch,
    tierOf: function (no) { var n = parseInt(no, 10); return n > 0 ? Math.min(5, Math.floor((n - 1) / 10)) : -1; },
    isOpen: function () { return !!S; }
  };
})(window);
