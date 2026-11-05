/* ============================================================================
 * pickfx.js —— 随机点名抽取动画（v4.5.1）
 * ----------------------------------------------------------------------------
 * 站主原话（2026-11-06）：
 *   「盲盒跟卡片差不多，那我们就用其中一个吧……那卡片就不要了。
 *    现在只有两种模式。」
 *   「盲盒……第一次点的时候，先揭开一点点，把光带出来什么颜色，
 *    提示这个颜色是哪一个段的学号段，再点一下之后名字就出来了。
 *    最好是全屏的那种颜色提醒，而不是太小。要制造一种紧张感。」
 *   「宝箱……把颜色对应的学号段直接写在卡片上，隐藏姓名时悬念更大。
 *    由快到慢的过程，最后一秒钟走得特别慢，最好卡在间隙上，
 *    让人以为是上一个结果是下一个。颜色提醒搭配文字。」
 *
 * 两条硬约束（沿用 v4.5.0）：
 *   ① 离线可用 → 不引外链、不加载图片音效文件；盒子、光柱、指针全 CSS 绘制，
 *      音效走 WebAudio 现场合成，沿用站内 cls_sfx 开关。
 *   ② 动画不能挡事 → 顶部始终有「跳过」，播完自动回到结果页；
 *      系统开启「减少动态效果」时把时长压到 0.7 秒以内。
 *
 * 两种模式：
 *   · box  盲盒 —— 两段式：先开缝露学号段光辉（全屏泛色 + 段文字），
 *                  再点击揭示姓名。两次紧张。
 *   · case 宝箱 —— 横向转盘：由快到慢、末段极慢；约三成概率停针卡在间隙；
 *                  隐藏姓名时格子先显学号段，停下泛色提示后再揭示姓名。
 *
 * 对外入口：
 *   PickFX.play({ mode, items, pool, hide, single, onDone })
 *     mode  : 'box' 盲盒 / 'case' 宝箱转盘
 *     items : [{ name, no }]，no = 学号末两位（1–62），决定光辉颜色
 *     pool  : 候选名单，宝箱转盘用它铺背景格
 *     hide  : 宝箱模式是否隐藏姓名（先显学号段）
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
  var RANGES = ['01–10', '11–20', '21–30', '31–40', '41–50', '51–62'];

  function swatch(no) {
    var n = parseInt(no, 10);
    if (!n || n < 1) return GREY;               /* 无学号账号（老师/管理员）用中性灰 */
    return TIERS[Math.min(5, Math.floor((n - 1) / 10))];
  }
  /* 学号段文字（如「31–40」），用于全屏提示与宝箱格子。无学号返回空串。 */
  function tierRange(no) {
    var n = parseInt(no, 10);
    if (!n || n < 1) return '';
    return RANGES[Math.min(5, Math.floor((n - 1) / 10))];
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function two(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
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

  function titleOf(mode) { return mode === 'case' ? '宝箱抽取' : '盲盒抽取'; }
  function subOf(mode, n, single) {
    if (single) return '单个重抽 · 共 1 人';
    if (mode === 'case') return '共 ' + n + ' 人 · 逐个开启';
    return '共 ' + n + ' 个 · 先露学号段，再揭示姓名';
  }

  function legendHtml() {
    return '<div class="pfx-legend">'
      + '<span class="pfx-lg-k">学号色</span>'
      + TIERS.map(function (t, i) {
        return '<span class="pfx-lg"><i style="--pc:' + t.c + ';--ps:' + t.s + '"></i>' + RANGES[i] + '</span>';
      }).join('')
      + '</div>';
  }

  /* ---------- 全屏泛色提示层 ---------- */
  /* 盲盒第一阶段、宝箱停下时点亮：满屏径向泛起该学号段颜色 + 中央段文字。
     只在「单个焦点」时点亮 —— 「全部开盒」同时点亮多个不同段会撞色，故不亮。 */
  function setFlare(root, it, hint) {
    var sw = swatch(it.no), seg = tierRange(it.no);
    root.style.setProperty('--fc', sw.c);
    root.style.setProperty('--fs', sw.s);
    var a = root.querySelector('.pfx-flare-seg');
    var b = root.querySelector('.pfx-flare-hint');
    if (a) a.textContent = seg ? ('学号段 ' + seg) : '';
    if (b) b.textContent = hint || '';
    var fl = root.querySelector('.pfx-flare');
    if (fl) fl.classList.add('on');
  }
  function clearFlare(root) {
    var fl = root.querySelector('.pfx-flare');
    if (fl) fl.classList.remove('on');
  }

  /* ---------- 盲盒：牛皮纸盒 + 绶带 + 火漆印，两段式 ---------- */
  function boxCellHtml(it, i) {
    var sw = swatch(it.no);
    var style = 'style="--pc:' + sw.c + ';--ps:' + sw.s + '"';
    return '<button type="button" class="pfx-cell pfx-b" data-i="' + i + '" ' + style
      + ' aria-label="第 ' + (i + 1) + ' 个盲盒">'
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

  /* 盲盒控制器：closed → glow（开缝露学号段光辉 + 全屏泛色）→ open（揭示姓名）。
     · 单个点击：glow 时点亮全屏 flare（沉浸紧张感），open 时熄灭。
     · 全部开盒：第一步把所有 closed→glow（不亮 flare，避免多段撞色），
       按钮变「全部揭示」；第二步把所有 glow→open。 */
  function boxCtl(root, items, opts) {
    var cells = [].slice.call(root.querySelectorAll('.pfx-cell'));
    var allBtn = root.querySelector('.pfx-all');
    var st = cells.map(function () { return 'closed'; });
    var opened = 0, queue = [], running = false;

    function glowOne(i, fast) {
      if (st[i] !== 'closed') return;
      st[i] = 'glow';
      var cell = cells[i];
      cell.classList.add('charge');
      if (!fast) charge();
      later(function () {
        if (!S) return;
        cell.classList.remove('charge');
        cell.classList.add('glow');
        if (!fast) { setFlare(root, items[i], '点击揭示姓名'); burst(); }
        refresh();
      }, fast ? 90 : 460);
    }

    function openOne(i, fast) {
      if (st[i] === 'open') return;
      st[i] = 'open';
      var cell = cells[i];
      cell.classList.remove('glow');
      cell.classList.add('open');
      if (!fast) { clearFlare(root); burst(); chime(); }
      opened++;
      if (opened === items.length) {
        clearFlare(root);
        later(function () {
          if (!S) return;
          root.querySelector('.pfx-foot').classList.add('on');
          var d = root.querySelector('.pfx-done');
          d.disabled = false; d.classList.add('ready');
          if (opts.single) later(finish, 700);
          else later(finish, 1500);
        }, 420);
      }
      refresh();
    }

    function clickCell(i) {
      if (!S || S.ending) return;
      var s = st[i];
      if (s === 'closed') { glowOne(i, false); }
      else if (s === 'glow') { openOne(i, false); }
    }

    cells.forEach(function (cell, i) {
      cell.addEventListener('click', function () { clickCell(i); });
    });

    function runQueue() {
      if (running || !queue.length) return;
      running = true;
      (function next() {
        if (!S || !queue.length) { running = false; refresh(); return; }
        var i = queue.shift();
        if (st[i] === 'closed') glowOne(i, true);
        later(next, 180);
      })();
    }

    /* 「全部开盒 / 全部揭示」按钮：按当前进度自动切换语义 */
    function refresh() {
      if (!allBtn) return;
      var hasClosed = st.some(function (x) { return x === 'closed'; });
      var hasGlow = st.some(function (x) { return x === 'glow'; });
      if (hasClosed) { allBtn.disabled = false; allBtn.textContent = '全部开盒'; }
      else if (hasGlow) { allBtn.disabled = false; allBtn.textContent = '全部揭示'; }
      else { allBtn.disabled = true; allBtn.textContent = '已全部开启'; }
    }

    if (allBtn) {
      allBtn.addEventListener('click', function () {
        if (!S || S.ending) return;
        clearFlare(root);
        var hasClosed = st.some(function (x) { return x === 'closed'; });
        if (hasClosed) {
          for (var i = 0; i < items.length; i++) if (st[i] === 'closed') queue.push(i);
          runQueue();
        } else {
          for (var j = 0; j < items.length; j++) if (st[j] === 'glow') openOne(j, true);
        }
        later(refresh, 60);
      });
    }

    return {
      start: function () { refresh(); },
      flush: function () {
        clearFlare(root);
        cells.forEach(function (cell, i) {
          if (st[i] === 'open') return;
          st[i] = 'open';
          cell.classList.remove('glow', 'charge');
          cell.classList.add('open', 'flat');
        });
        opened = items.length;
      },
      count: function () { return opened; },
      refresh: refresh
    };
  }

  /* ---------- 宝箱：横向转盘 + 铜指针 ---------- */
  function tileHtml(hide) {
    return function (it) {
      var sw = swatch(it.no), seg = tierRange(it.no);
      return '<div class="pfx-tile" style="--pc:' + sw.c + ';--ps:' + sw.s + '">'
        + (hide
            ? '<span class="pfx-seg">' + (seg || '—') + '</span>'
            : '<span class="pfx-tn">' + esc(it.name) + (it.no ? '<i>' + two(it.no) + '</i>' : '') + '</span>')
        + '</div>';
    };
  }
  function nameOf(it) {
    return '<span class="pfx-tn">' + esc(it.name) + (it.no ? '<i>' + two(it.no) + '</i>' : '') + '</span>';
  }

  /* 转盘减速曲线：前 86% 的时间走 90% 路程（较快），后 14% 走 10%（极慢）。
     越往后越慢 —— 站主要求「最后一秒钟走得特别特别慢」，末段用五次方缓出。 */
  function easeCase(p) {
    if (p < 0.86) return (1 - Math.pow(1 - p / 0.86, 3)) * 0.90;
    var q = (p - 0.86) / 0.14;
    return 0.90 + (1 - Math.pow(1 - q, 5)) * 0.10;
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

      /* 卡间隙：约三成概率，停针偏向中奖格与邻格的间隙（视觉上「差点滑过去」），
         偏移不超过半格的 44%，保证指向的仍是中奖格、不会指错人。
         其余七成停在中奖格中心附近（±7px 微抖，避免每次都正中显得呆板）。 */
      var nearMiss = Math.random() < 0.32;
      var offset = nearMiss
        ? (Math.random() < 0.5 ? -1 : 1) * pitch * 0.42
        : (Math.random() * 14 - 7);
      target = Math.max(0, at * pitch + iw / 2 - wrapW / 2 + offset);

      var dur = (i === 0 ? 3400 : 1900);
      if (reduced()) dur = 620;
      var t0 = performance.now(), lastPx = 0;

      (function step(now) {
        if (!S || S.ending) return;
        var p = Math.min(1, (now - t0) / dur);
        var e = easeCase(p);
        var x = target * e;
        reel.style.transform = 'translate3d(' + (-x) + 'px,0,0)';
        if (x - lastPx >= pitch * 0.9) { lastPx = x; tick(); }
        if (p < 1) raf(step);
        else settle(at);
      })(t0);
    }

    function settle(at) {
      var cell = reel.children[at];
      var win = items[i];
      if (!cell) { next(); return; }
      cell.classList.add('win');
      burst(); chime();
      /* 停下先点亮全屏泛色 + 学号段文字（紧张一：是不是自己这一段） */
      setFlare(root, win, hide ? '即将揭示姓名' : '');

      /* 隐藏姓名：停顿后再把格子里的学号段换成姓名（紧张二：是不是自己） */
      if (hide) {
        later(function () {
          if (!S || S.ending) return;
          var seg = cell.querySelector('.pfx-seg');
          if (seg) seg.outerHTML = nameOf(win);
        }, 1200);
      }

      wins.insertAdjacentHTML('beforeend',
        '<span class="pfx-win" style="--pc:' + swatch(win.no).c + '">' + esc(win.name) + '</span>');
      if (cntEl) cntEl.textContent = String(i + 1);
      i++;
      later(function () { if (!S || S.ending) return; clearFlare(root); next(); }, hide ? 1750 : 1050);
    }

    function next() {
      if (i >= items.length) { finale(); later(finish, 1000); return; }
      later(round, 600);
    }

    return {
      start: function () { round(); },
      flush: function () {
        rafCancel();
        clearFlare(root);
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
        + items.map(function (it, i) { return boxCellHtml(it, i); }).join('')
        + '</div>';
    }

    /* 全屏泛色层：绝对定位铺满 .pfx，z-index 在网格之下、顶栏底栏之上 */
    var flare = '<div class="pfx-flare"><div class="pfx-flare-seg"></div><div class="pfx-flare-hint"></div></div>';
    var footAll = (mode === 'case' || opts.single) ? '' : '<button type="button" class="pfx-btn pfx-all">全部开盒</button>';

    return '<div class="pfx-in">'
      + '<div class="pfx-bar">'
      +   '<div class="pfx-tit"><div class="pfx-title">' + titleOf(mode) + '</div>'
      +     '<div class="pfx-sub">' + subOf(mode, items.length, opts.single) + '</div></div>'
      +   '<button type="button" class="pfx-skip">跳过</button>'
      + '</div>'
      + '<div class="pfx-legend-wrap">' + legendHtml() + '</div>'
      + '<div class="pfx-body">' + body + '</div>'
      + flare
      + '<div class="pfx-foot">'
      +   footAll
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
    if (mode !== 'box' && mode !== 'case') mode = 'box';
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
    S.ctl = (mode === 'case') ? caseCtl(root, items, opts) : boxCtl(root, items, opts);

    root.querySelector('.pfx-skip').addEventListener('click', skip);
    root.querySelector('.pfx-done').addEventListener('click', function () {
      if (!S || S.closed) return;
      S.ending = true;
      finish();
    });

    /* box.start = 初始化按钮文字；case.start = 开转。两者都只调一次。 */
    if (S.ctl.start) S.ctl.start();
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
