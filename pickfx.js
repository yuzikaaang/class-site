/* ============================================================================
 * pickfx.js —— 随机点名抽取动画（v4.7.0）
 * ----------------------------------------------------------------------------
 * v4.7.0 站主第 5 条（宝箱收尾）：
 *   「到最后怎么又突然加快又跳了一下？我的意思不是慢慢减直接减到零，
 *    如果它是两个卡片中间你就算面积，那你为什么还要再跳一下？」
 *   「揭示的时候为什么还是要再点一下才显示名字？盲盒改了这里为什么不改？」
 *   「不隐藏名字的话就更刺激一点：随机往后跳或往前跳或者不动，都有可能。」
 * 落地：
 *   · 减速曲线换成单段单调曲线，不再「先归零再猛冲」—— 之前 86% 处速度归零、
 *     后 14% 又从 0 加速到顶峰，观感就是「突然加快再一顿」。
 *   · 落点精确居中，落点后不再位移；中奖卡只用光圈高亮，不缩放（缩放 = 跳一下）。
 *   · 停下即自动揭示姓名，两种模式都不需要第二次点击。
 *   · 不隐藏姓名时，停稳后额外随机前后跳 0 / ±1 / ±2 格再落回中奖卡（纯气氛）；
 *     隐藏姓名时不做这个位移 —— 反正看不见是谁，跳了只是莫名其妙。
 *
 * 站主原话（2026-11-06）：
 *   「盲盒数量是根据范围人数定的，最多 10 个。我选择抽几个，就点几次盲盒。
 *    不可能没中，点到的都是中的。抽到谁是我点那个盲盒之后，在范围里随机选一个人，
 *    不是盲盒直接对应一个人的名字。」
 *   「不管是宝箱还是盲盒，不要我点两次。点完之后先显示颜色对应的学号段，
 *    等 0.5~0.8 秒自动显示姓名。教室电脑性能不好，点两次会特别卡。」
 *   「宝箱中间有个正方形方框，开始抽取时方框不动、后面的卡片在动。
 *    停下来看方框里哪张卡面积最大就中。隐藏姓名时别在卡片上写学号段，太丑。」
 *
 * 两条硬约束（沿用 v4.5.0）：
 *   ① 离线可用 → 不引外链、不加载图片音效文件；盒子、光柱、卡片全 CSS 绘制，
 *      音效走 WebAudio 现场合成，沿用站内 cls_sfx 开关。
 *   ② 动画不能挡事 → 顶部始终有「跳过」，播完自动回到结果页；
 *      系统开启「减少动态效果」时把时长压到 0.7 秒以内。
 *
 * 轻量模式（v4.6.0）：
 *   html[data-lite="1"] 时降质不降功能 —— 宝箱卡片数 24→16、动画时长略缩、
 *   多余模糊与多阴影由 CSS 关掉；抽取动画本身完整播放（index.html 已做豁免）。
 *
 * 两种模式：
 *   · box  盲盒 —— 格子数 = min(10, 范围人数)。每格只是「抽取位」，
 *                  点一次 = 在范围里现抽一个没抽过的人 → 露学号段颜色 0.45s
 *                  → 自动揭示姓名 0.35s。抽满 need 次后剩余格子置灰。
 *   · case 宝箱 —— 中间固定方框不动，卡片带横向滚动，停下按与方框的重叠面积
 *                  最大判定中奖；隐藏姓名时卡片只显示纯色块 + 微光。
 *
 * 对外入口：
 *   PickFX.play({ mode, items, pool, hide, single, onDone })
 *     mode  : 'box' 盲盒 / 'case' 宝箱
 *     items : [{ name, no }]，只需长度 = 要抽几人；no = 学号末两位（1–62）
 *     pool  : 范围候选名单（真正随机从这里取）
 *     hide  : 宝箱模式是否隐藏姓名（先显学号段色块）
 *     single: 单个重抽，播完自动收场
 *     onDone: function(pickedNames) 回传实际抽到的人（跳过也完整）
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
  /* 学号段文字（如「31–40」），用于全屏提示。无学号返回空串。 */
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
  /* 轻量模式：让动画降质不降功能 */
  function isLite() {
    try { return document.documentElement.getAttribute('data-lite') === '1'; }
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
  function subOf(mode, gridN, need, opts) {
    if (opts && opts.single) return '单个重抽';
    if (mode === 'case') return '共 ' + need + ' 人 · 逐个开启';
    return '共 ' + gridN + ' 个盲盒 · 抽 ' + need + ' 人';
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
  /* 盲盒露段时、宝箱停下时点亮：满屏径向泛起该学号段颜色 + 中央段文字。 */
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

  /* ---------- 盲盒：牛皮纸盒 + 绶带 + 火漆印 ---------- */
  /* 初始格没有姓名、没有颜色 —— 点开的一瞬间才决定里面是谁。 */
  function boxCellHtml(i) {
    return '<button type="button" class="pfx-cell pfx-b" data-i="' + i + '"'
      + ' style="--pc:#7b8794;--ps:#cbd5e1" aria-label="第 ' + (i + 1) + ' 个盲盒">'
      + '<span class="bx-beam"></span>'
      + '<span class="bx-glow"></span>'
      + '<span class="bx">'
      +   '<span class="bx-body"><span class="bx-rib"></span><span class="bx-mark">?</span></span>'
      +   '<span class="bx-lid"><span class="bx-rib bx-rib-lid"></span></span>'
      + '</span>'
      + '<span class="bx-name"></span>'
      + '</button>';
  }

  /* 盲盒控制器（v4.6.0）：格子数 = min(10, 范围人数)，每格只是「抽取位」。
     点一次 = 在范围里现抽一个没抽过的人 → 露学号段颜色 0.45s → 自动揭示姓名 0.35s。
     抽满 need 次后剩余格子置灰；不存在「未中」。 */
  function boxCtl(root, gridN, need, pool, opts) {
    var cells = [].slice.call(root.querySelectorAll('.pfx-cell'));
    var allBtn = root.querySelector('.pfx-all');
    var cntEl = root.querySelector('.pfx-cnt');
    var used = {}, picked = [], done = 0;
    var st = cells.map(function () { return 'closed'; });
    var cellData = cells.map(function () { return null; });
    var queue = [], running = false;

    /* v4.10.2（站主第 7 条）：配额算好的名单（opts.locked）优先。
       没有 locked 时行为跟以前一模一样 —— 纯随机抽。
       有 locked 时：只在 locked 里挑，但**挑的顺序仍随机**，
       所以动画看着还是「随机开箱」，但结果一定符合配额
       （学号段 / 成绩段 / 男女 / 班干部 的 最多 / 最少 人数）。 */
    function drawOne() {
      var cand = pool.filter(function (it) { return !used[it.name]; });
      if(opts.locked && opts.locked.length){
        var lock = {};
        for(var li = 0; li < opts.locked.length; li++) lock[opts.locked[li]] = 1;
        var sub = cand.filter(function (it) { return lock[it.name]; });
        if(sub.length) cand = sub;
      }
      if (!cand.length) return null;
      var it = cand[(Math.random() * cand.length) | 0];
      used[it.name] = 1;
      return it;
    }

    function refresh() {
      if (!allBtn) return;
      if (done >= need) { allBtn.disabled = true; allBtn.textContent = '已抽满'; }
      else { allBtn.disabled = false; allBtn.textContent = '全部抽取'; }
    }

    function fillCell(cell, it) {
      var nameEl = cell.querySelector('.bx-name');
      if (!nameEl) return;
      nameEl.innerHTML = '<b>' + esc(it.name) + '</b>'
        + '<em>' + (it.no ? two(it.no) + ' 号' : '') + '</em>';
    }

    function reveal(i, fast) {
      if (!S || S.ending) return;
      if (st[i] !== 'closed' || done >= need) return;
      var it = drawOne();
      if (!it) return;
      done++;
      picked.push(it);
      cellData[i] = it;
      st[i] = 'glow';
      var cell = cells[i];
      var sw = swatch(it.no);
      cell.style.setProperty('--pc', sw.c);
      cell.style.setProperty('--ps', sw.s);
      cell.classList.add('charge');
      if (!fast) charge();
      /* 阶段一：开缝露学号段光辉 + 全屏泛色 */
      later(function () {
        if (!S) return;
        cell.classList.remove('charge');
        cell.classList.add('glow');
        if (!fast) { setFlare(root, it, ''); burst(); }
        if (cntEl) cntEl.textContent = String(done);
        refresh();
        /* 阶段二：自动揭示姓名，无需第二次点击 */
        later(function () {
          if (!S || S.ending) return;
          cell.classList.remove('glow');
          cell.classList.add('open');
          fillCell(cell, it);
          clearFlare(root);
          if (!fast) chime();
          st[i] = 'open';
          if (done >= need) finishUp();
        }, fast ? 130 : 620);
      }, fast ? 90 : 420);
    }

    function finishUp() {
      cells.forEach(function (c, k) {
        if (st[k] === 'closed') { c.disabled = true; c.classList.add('dim'); }
      });
      var foot = root.querySelector('.pfx-foot');
      if (foot) foot.classList.add('on');
      var d = root.querySelector('.pfx-done');
      if (d) { d.disabled = false; d.classList.add('ready'); }
      refresh();
      if (opts.single) later(finish, 700);
    }

    cells.forEach(function (cell, i) {
      cell.addEventListener('click', function () {
        if (!S || S.ending) return;
        reveal(i, false);
      });
    });

    function runQueue() {
      if (running || !queue.length) return;
      running = true;
      (function next() {
        if (!S || done >= need || !queue.length) { running = false; refresh(); return; }
        var i = queue.shift();
        if (st[i] === 'closed') reveal(i, true);
        later(next, 1000);
      })();
    }

    if (allBtn) {
      allBtn.addEventListener('click', function () {
        if (!S || S.ending || done >= need) return;
        for (var i = 0; i < cells.length; i++) if (st[i] === 'closed') queue.push(i);
        runQueue();
      });
    }

    return {
      start: function () { refresh(); },
      result: function () { return picked.map(function (it) { return it.name; }); },
      flush: function () {
        clearFlare(root);
        rafCancel();
        /* 跳过 / 关面板：先把抽取次数补足，结果必须完整 */
        while (picked.length < need) {
          var it = drawOne();
          if (!it) break;
          picked.push(it);
        }
        var shown = {};
        cellData.forEach(function (x) { if (x) shown[x.name] = 1; });
        var rest = picked.filter(function (x) { return !shown[x.name]; });
        var ri = 0;
        cells.forEach(function (cell, k) {
          if (st[k] === 'open') return;
          st[k] = 'open';
          cell.classList.remove('glow', 'charge');
          cell.classList.add('open', 'flat');
          var cur = cellData[k] || rest[ri++];
          if (cur) {
            cellData[k] = cur;
            var sw = swatch(cur.no);
            cell.style.setProperty('--pc', sw.c);
            cell.style.setProperty('--ps', sw.s);
            fillCell(cell, cur);
          } else {
            cell.classList.add('dim');
          }
        });
        done = need;
        if (cntEl) cntEl.textContent = String(done);
        refresh();
      },
      count: function () { return done; },
      refresh: refresh
    };
  }

  /* ---------- 宝箱：中间固定方框 + 横向滚动卡片 ---------- */
  /* 隐藏姓名时卡片不写文字，只用学号段颜色 + 微光；对照靠顶部图例。 */
  function tileHtml(hide) {
    return function (it) {
      var sw = swatch(it.no);
      return '<div class="pfx-tile' + (hide ? ' is-color' : '') + '"'
        + ' style="--pc:' + sw.c + ';--ps:' + sw.s + '">'
        + (hide ? '' : '<span class="pfx-tn">' + esc(it.name) + (it.no ? '<i>' + two(it.no) + '</i>' : '') + '</span>')
        + '</div>';
    };
  }
  function nameOf(it) {
    return '<span class="pfx-tn">' + esc(it.name) + (it.no ? '<i>' + two(it.no) + '</i>' : '') + '</span>';
  }

  /* 转盘减速曲线（v4.7.0）：单段、单调、终点速度归零。
     旧版是两段拼接 —— 前段 easeOut 到 86% 时速度已经掉到 0，后段又从 0 起速，
     于是「快→停→猛地一冲→再停」，站主看到的就是「突然加快又跳一下」。
     这里用 1-(1-p)^3.4：起步快、一路减速、到 p=1 时速度为 0，全程没有二次加速。 */
  function easeCase(p) {
    if (p >= 1) return 1;
    if (p <= 0) return 0;
    /* v4.10.2（站主第 6 条）：「如果你随机跳转到前面和后面的话，你这个动画可以再过渡的再完美一点」。
       原来的 1-(1-p)^3.4 到 90% 时速度已经掉到 0.06 左右，末尾几乎停住，
       接着又硬切到「回位」动画 —— 中间那一下像「顿了一拍」。
       现在换成指数略低的 3.0（尾巴更平顺），并且**回位动画改成同一条曲线**，
       两段衔接处速度连续，看起来就是一次连贯的滑行，不像「跳一下再弹回来」。 */
    return 1 - Math.pow(1 - p, 3.0);
  }
  /* 回位用的小幅缓动：起步慢、中间快、末尾轻收 —— 和主曲线观感一致 */
  function easeSettle(p) {
    if (p >= 1) return 1;
    if (p <= 0) return 0;
    return p < 0.5
      ? 2 * p * p
      : 1 - Math.pow(-2 * p + 2, 2.4) / 2;
  }

  function caseCtl(root, need, pool, opts) {
    var reel = root.querySelector('.pfx-reel');
    var strip = root.querySelector('.pfx-strip-in');
    var frame = root.querySelector('.pfx-frame');
    var wins = root.querySelector('.pfx-wins');
    var cntEl = root.querySelector('.pfx-cnt');
    var hide = !!opts.hide;
    var used = {}, picked = [], round = 0;
    var iw = 104, pitch = 112, curX = 0;

    /* v4.10.2（站主第 7 条）：配额算好的名单（opts.locked）优先。
       没有 locked 时行为跟以前一模一样 —— 纯随机抽。
       有 locked 时：只在 locked 里挑，但**挑的顺序仍随机**，
       所以动画看着还是「随机开箱」，但结果一定符合配额
       （学号段 / 成绩段 / 男女 / 班干部 的 最多 / 最少 人数）。 */
    function drawOne() {
      var cand = pool.filter(function (it) { return !used[it.name]; });
      if(opts.locked && opts.locked.length){
        var lock = {};
        for(var li = 0; li < opts.locked.length; li++) lock[opts.locked[li]] = 1;
        var sub = cand.filter(function (it) { return lock[it.name]; });
        if(sub.length) cand = sub;
      }
      if (!cand.length) return null;
      var it = cand[(Math.random() * cand.length) | 0];
      used[it.name] = 1;
      return it;
    }

    /* 绝对位移（px），全程自己管，不依赖 CSS transition */
    function moveTo(x, ms, ease, done) {
      var from = curX;
      if (ms <= 0) { curX = x; reel.style.transform = 'translate3d(' + (-x) + 'px,0,0)'; if (done) done(); return; }
      var t0 = performance.now();
      (function step(now) {
        if (!S || S.ending) return;
        var p = Math.min(1, (now - t0) / ms);
        var k = ease ? ease(p) : p;
        curX = from + (x - from) * k;
        reel.style.transform = 'translate3d(' + (-curX) + 'px,0,0)';
        if (p < 1) raf(step);
        else if (done) done();
      })(t0);
    }

    /* 把第 k 张卡摆到方框正中需要的位移 */
    function centerOf(k) {
      var el = reel.children[k];
      if (!el) return 0;
      return Math.max(0, el.offsetLeft + el.offsetWidth / 2 - strip.clientWidth / 2);
    }

    /* v4.7.11（站主第 1 条）：落点偏移从「±1 或不动」扩到 ±3，且概率向外递减。
       站主原话：「范围是前三到后三里面随机选一个，但每个比例不一样，中间 50%，
       两边依次递减，越往外越小，但不代表没有。」
       权重（单侧合计 100）：0 → 50，±1 → 各 18，±2 → 各 6，±3 → 各 1。
       中间一半的次数「真就停住」，剩下的一半往两边散，最外圈 1% 保留惊喜。 */
    var TEASE_W = [[0, 50], [1, 18], [-1, 18], [2, 6], [-2, 6], [3, 1], [-3, 1]];
    var TEASE_POOL = (function () {
      var a = [];
      for (var i = 0; i < TEASE_W.length; i++) {
        for (var k = 0; k < TEASE_W[i][1]; k++) a.push(TEASE_W[i][0]);
      }
      return a;
    })();
    function teaseStep() {
      return TEASE_POOL[(Math.random() * TEASE_POOL.length) | 0];
    }

    /* v4.10.2（站主第 6 条）：铺一条「相邻不同色」的卡片带。
       做法：把候选按学号段分档 → 各档轮流取牌（round-robin），
       这样相邻两张几乎必然不同段；某一档用完了就跳过它，接下一档。
       中奖卡最后放到指定位置（它的颜色由 win 决定）。 */
    function buildStrip(poolArr, M, win, at) {
      var buckets = {}, order = [];
      poolArr.forEach(function (it) {
        var t = tierOf(it.no);
        if (!(t in buckets)) { buckets[t] = []; order.push(t); }
        buckets[t].push(it);
      });
      /* 每档内部洗牌 */
      order.forEach(function (t) {
        var b = buckets[t];
        for (var i = b.length - 1; i > 0; i--) {
          var j = (Math.random() * (i + 1)) | 0;
          var tmp = b[i]; b[i] = b[j]; b[j] = tmp;
        }
      });
      var tiles = [], idx = {}, ti = 0;
      while (tiles.length < M) {
        var progressed = false;
        for (var oi = 0; oi < order.length && tiles.length < M; oi++) {
          var t = order[(ti + oi) % order.length];
          var bk = buckets[t];
          if (!bk || (idx[t] || 0) >= bk.length) continue;
          var it = bk[idx[t]++];
          /* 相邻同色就跳过这一张（换下一档）—— 保证视觉上颜色不连片 */
          if (tiles.length) {
            var prev = tiles[tiles.length - 1];
            if (tierOf(prev.no) === t && bk.length - idx[t] > 0) continue;
          }
          tiles.push(it);
          progressed = true;
        }
        if (!progressed) {
          /* 候选用完了 → 用整池随机补齐（条件不满足时的兜底） */
          while (tiles.length < M) {
            tiles.push(poolArr[(Math.random() * poolArr.length) | 0]);
          }
          break;
        }
        ti++;
      }
      /* 中奖卡放到指定位置 */
      if (at >= 0 && at < tiles.length) tiles[at] = win;
      return tiles;
    }

    function spin() {
      if (!S || S.ending) return;
      if (round >= need) { finale(); later(finish, 900); return; }
      var win = drawOne();
      if (!win) { finale(); later(finish, 900); return; }
      picked.push(win);

      /* v4.9.1（站主第 6 条）：「连抽 10 次，第一次是从快到慢，后面几次就动一下下」。
         ① 条带长度跟着池子上限走 —— 池里有多少人就铺多少张（最多 60），
            看起来才像「把整个库都轮了一遍」；
         ② 每一轮的长度和时长完全一致（下面 dur 不再按 round 打折），
            于是每一次都是「从头快到尾慢」，不会第二轮显得敷衍。 */
      var M = Math.min(60, Math.max(24, pool.length));
      if (isLite()) M = Math.min(M, 24);
      /* 中奖卡放在偏后位置：左右都要留出「小跳」的余量，否则位移会撞到两端 */
      var at = Math.max(4, M - 9);
      var tiles = [];
      for (var k = 0; k < M; k++) tiles.push(pool[(Math.random() * pool.length) | 0]);
      tiles[at] = win;

      reel.style.transition = 'none';
      reel.style.transform = 'translate3d(0,0,0)';
      reel.innerHTML = tiles.map(tileHtml(hide)).join('');
      curX = 0;

      /* ⚠️ 必须用 offsetWidth / offsetLeft，不能用 getBoundingClientRect ——
         舞台入场有 0.3s 的 scale 动画，rect 拿到的是「缩放后」的尺寸，
         而 transform 的位移是在未缩放坐标系里生效的，两者一混，目标卡会系统性偏位。 */
      var a = reel.children[0], b = reel.children[1];
      if (a) iw = a.offsetWidth || 104;
      pitch = (a && b) ? (b.offsetLeft - a.offsetLeft) : iw + 8;

      /* 落点精确居中 —— 不再留 ±0.22 格的抖动偏差。
         以前那个偏差让卡片停得歪一点、再靠 .win 缩放「吸」回来，
         看起来就是「明明停了又跳一下」。现在停哪就是哪。 */
      var winX = centerOf(at);
      var maxX = Math.max(0, reel.scrollWidth - strip.clientWidth);
      var tease = hide ? 0 : teaseStep();
      var landX = Math.min(maxX, Math.max(0, winX + tease * pitch));
      /* 撞到端点时放弃这次小跳，保证落点仍然在中奖卡上 */
      if (Math.abs(landX - winX) < 1) landX = winX;

      /* 每一轮都跑满同样的时长（原来第 2 轮起砍到 1600ms，观感上就是「敷衍动一下」） */
      var dur = 2900;
      if (isLite()) dur = Math.round(dur * 0.82);
      if (reduced()) dur = 600;
      var t0 = performance.now(), lastPx = 0;

      (function step(now) {
        if (!S || S.ending) return;
        var p = Math.min(1, (now - t0) / dur);
        var x = landX * easeCase(p);
        curX = x;
        reel.style.transform = 'translate3d(' + (-x) + 'px,0,0)';
        if (x - lastPx >= pitch * 0.9) { lastPx = x; tick(); }
        if (p < 1) raf(step);
        else settle(winX);
      })(t0);
      round++;
    }

    /* 停下之后：隐藏姓名 → 立刻按面积判定中奖卡；不隐藏姓名 → 先「诈」一下再落回 */
    function settle(winX) {
      var win = picked[picked.length - 1];
      var best = -1, bestArea = 0;
      if (frame) {
        var fr = frame.getBoundingClientRect();
        for (var k = 0; k < reel.children.length; k++) {
          var r = reel.children[k].getBoundingClientRect();
          var ov = Math.min(r.right, fr.right) - Math.max(r.left, fr.left);
          if (ov > bestArea) { bestArea = ov; best = k; }
        }
      }
      if (best < 0) best = 0;
      var cell = reel.children[best];
      if (!cell) { later(spin, 500); return; }

      /* 不隐藏姓名：如果这次落点故意偏了，停 0.35 秒「以为要停」→ 再滑回中奖卡。
         隐藏姓名不玩这手 —— 反正看不见是谁，多跳一次只会让人莫名其妙。 */
      var back = Math.abs(curX - winX) > 1;
      if (back) {
        burst();
        /* v4.10.2（站主第 6 条）：回位这段以前只有 260ms、还是一条很「急」的曲线，
           视觉上是「弹回去」而不是「滑回去」。现在加长到 420ms，
           曲线换成 easeSettle（缓入缓出），跟主减速曲线是同一挂味道，衔接就顺了。 */
        later(function () {
          if (!S || S.ending) return;
          moveTo(winX, 420, easeSettle, function () { revealWin(); });
        }, 420);
      } else {
        revealWin();
      }

      function revealWin() {
        if (!S || S.ending) return;
        /* 落回后重新按面积确认一次（理论上仍是同一张，兜住亚像素误差） */
        var c2 = cell;
        if (frame) {
          var f2 = frame.getBoundingClientRect(), bb = -1, ba = 0;
          for (var j = 0; j < reel.children.length; j++) {
            var rr = reel.children[j].getBoundingClientRect();
            var ov2 = Math.min(rr.right, f2.right) - Math.max(rr.left, f2.left);
            if (ov2 > ba) { ba = ov2; bb = j; }
          }
          if (bb >= 0 && reel.children[bb]) c2 = reel.children[bb];
        }
        /* 中奖卡上写「姓名 + 学号」：卡本身已经带学号段颜色，
           再写一段「31–40」纯属重复，站主也嫌丑。 */
        burst(); chime();
        if (!hide) {
          /* 不隐藏姓名：卡片上本来就写着名字，停下即是结果，不再等 */
          c2.innerHTML = nameOf(win);
          c2.classList.remove('is-color');
          c2.classList.add('win', 'revealed');
          wins.insertAdjacentHTML('beforeend',
            '<span class="pfx-win" style="--pc:' + swatch(win.no).c + '">' + esc(win.name) + winSub(win) + '</span>');
        } else {
          /* 隐藏姓名：先只点亮中奖卡 + 满屏打出学号段（0.9 秒），再把姓名顶上来。
             站主要的就是「先看到段，再看到人」，且全程不用点第二次。 */
          c2.classList.add('win');
          setFlare(root, win, '即将揭示姓名');
          later(function () {
            if (!S || S.ending) return;
            c2.innerHTML = nameOf(win);
            c2.classList.remove('is-color');
            c2.classList.add('revealed');
            clearFlare(root);
            chime();
            wins.insertAdjacentHTML('beforeend',
              '<span class="pfx-win" style="--pc:' + swatch(win.no).c + '">' + esc(win.name) + winSub(win) + '</span>');
          }, 900);
        }
        if (cntEl) cntEl.textContent = String(picked.length);
        later(function () {
          if (!S || S.ending) return;
          clearFlare(root);
          later(spin, 300);
        }, hide ? 2100 : 1400);
      }
    }

    return {
      start: function () { spin(); },
      result: function () { return picked.map(function (it) { return it.name; }); },
      flush: function () {
        rafCancel();
        clearFlare(root);
        while (picked.length < need) {
          var it = drawOne();
          if (!it) break;
          picked.push(it);
        }
        for (var k = 0; k < picked.length; k++) {
          wins.insertAdjacentHTML('beforeend',
            '<span class="pfx-win" style="--pc:' + swatch(picked[k].no).c + '">' + esc(picked[k].name) + winSub(picked[k]) + '</span>');
        }
        if (cntEl) cntEl.textContent = String(picked.length);
      },
      count: function () { return picked.length; }
    };
  }

  /* v4.10.0（站主第 1 条）：按成绩条件抽时，中奖卡上顺带写出对应的分数 / 名次，
     「语文 103」这样一行小字；没设成绩条件时 sub 为空，不占位。 */
  function winSub(it){
    var v = (it && it.sub) ? String(it.sub) : '';
    return v ? '<i class="pfx-win-v">' + esc(v) + '</i>' : '';
  }

  /* ---------- 外壳 ---------- */
  function shell(mode, gridN, need, opts) {
    var body = '';
    if (mode === 'case') {
      body = '<div class="pfx-case">'
        + '<div class="pfx-case-hd">'
        +   '<span>已开启 <b class="pfx-cnt">0</b> / ' + need + '</span>'
        +   '<span class="pfx-case-hint">' + (opts.hide ? '抽取中隐藏姓名，停下自动显示' : '抽取中显示姓名，停下自动揭示') + '</span>'
        + '</div>'
        + '<div class="pfx-strip"><div class="pfx-strip-in"><div class="pfx-reel"></div></div>'
        +   '<span class="pfx-frame"></span><span class="pfx-mask l"></span><span class="pfx-mask r"></span>'
        + '</div>'
        + '<div class="pfx-wins"></div>'
        + '</div>';
    } else {
      var vw = global.innerWidth || 1440;
      var cols = Math.min(gridN, vw < 620 ? 4 : 5);
      var cellw = vw < 620 ? 104 : (vw < 900 ? 158 : 200);
      var cellsHtml = '';
      for (var ci = 0; ci < gridN; ci++) cellsHtml += boxCellHtml(ci);
      body = '<div class="pfx-grid" style="--cols:' + cols + ';--cellw:' + cellw + 'px">'
        + cellsHtml
        + '</div>';
    }

    /* 全屏泛色层：绝对定位铺满 .pfx，z-index 在网格之上、顶栏底栏之下 */
    var flare = '<div class="pfx-flare"><div class="pfx-flare-seg"></div><div class="pfx-flare-hint"></div></div>';
    var footAll = '';
    if (mode !== 'case' && !opts.single) {
      footAll = '<button type="button" class="pfx-btn pfx-all">全部抽取</button>'
        + '<span class="pfx-cnt-box">已抽中 <b class="pfx-cnt">0</b> / ' + need + '</span>';
    }

    return '<div class="pfx-in">'
      + '<div class="pfx-bar">'
      +   '<div class="pfx-tit"><div class="pfx-title">' + titleOf(mode) + '</div>'
      +     '<div class="pfx-sub">' + subOf(mode, gridN, need, opts) + '</div></div>'
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
    /* 回传实际抽到的人 —— 中途跳过也必须完整 */
    var res = [];
    try { if (s.ctl && s.ctl.result) res = s.ctl.result() || []; } catch (e) {}
    var cb = s.opts.onDone;
    /* 先渲染结果页再淡出 —— 否则会看到背后旧画面闪一下 */
    try { if (cb) cb(res); } catch (e) {}
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
    var hits = (opts.items || []).slice(0, 10);
    if (!hits.length) { if (opts.onDone) opts.onDone([]); return; }

    var pool = (opts.pool && opts.pool.length) ? opts.pool.slice() : hits.slice();
    var need = Math.min(hits.length, pool.length);
    if (need < 1) { if (opts.onDone) opts.onDone([]); return; }
    /* 盲盒格子数 = min(10, 范围人数)；宝箱不铺格子，need 即转几轮 */
    var gridN = (mode === 'box') ? Math.min(10, pool.length) : need;

    var root = document.createElement('div');
    root.className = 'pfx' + (mode === 'case' ? ' case-mode' : '');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', titleOf(mode));
    root.innerHTML = shell(mode, gridN, need, opts);
    document.body.appendChild(root);

    S = {
      root: root, timers: [], rafs: [], mode: mode, opts: opts,
      ending: false, closed: false, skipped: false, ctl: null
    };
    S.ctl = (mode === 'case')
      ? caseCtl(root, need, pool, opts)
      : boxCtl(root, gridN, need, pool, opts);

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
