/* ============================================================================
 * tour.js —— 新手导览（v4.12.0）
 * ----------------------------------------------------------------------------
 * 站主要求：
 *   「首次打开要有新手导览，详细一点，公告下面还有班级签这些都要走到；
 *     第一次要强制点一次；要有动画，不能光聚个光；设置里能重置，重置后再过一遍。」
 *
 * 做法：
 *   · 分两段独立记录 —— login（登录弹层内）、home（首页板块）。
 *     某一段目标元素缺失（例如安全验证被后台关掉）时自动跳过该步，不卡死。
 *   · 光洞从上一个元素平滑滑到下一个（340ms），高亮环呼吸，气泡延迟淡入。
 *   · 无「跳过」按钮；点击遮罩只抖动气泡提示。Esc 可退出，退出后下次从断点续播。
 *   · 不做老用户豁免：升级后所有设备第一次进入都会走一遍（站主要求「一视同仁」）。
 *
 * 登记表：scripts/tour-map.json —— 导览步骤 / 教程章节 / 首页板块三者的 key 必须一致，
 *   由 scripts/predeploy.mjs 三向比对，缺一处就拦部署。
 * ========================================================================= */
(function (window, document) {
  'use strict';

  var LS_KEY = 'cls_tour_v1';

  /* ---------- 步骤表 ----------
     字段：t = topic key（与 tour-map.json、guide.html 对齐）；sel = 目标元素；
           title / text = 气泡文案（书面表述，不带第二人称）。 */
  var STEPS = {
    login: [
      { t: 'login-user', sel: '#acctU', title: '用户名',
        text: '填写本人姓名，须与班级名单一致。' },
      { t: 'login-pass', sel: '#acctP', title: '密码',
        text: '初始密码为出生日期 8 位数字，例如 2010 年 7 月 10 日对应 20100710。' },
      { t: 'login-cap', sel: '#capWrap', title: '安全验证',
        text: '按图填写数字，图像无法辨认时点击右上角刷新按钮更换。' },
      { t: 'login-go', sel: '#acctGo', title: '登录',
        text: '登录后作业勾选与点歌记录同步至云端；未登录时数据仅保存于本机。' }
    ],
    home: [
      { t: 'island', sel: '#classIsland', title: '班级岛',
        text: '今日课程、天气与当前周次；点击横幅展开完整课表。' },
      { t: 'board', sel: '#board', title: '班级公告',
        text: '班级通知与活动集中发布于此；标题后的数字为未读条数。' },
      { t: 'sign', sel: '#signBar', title: '签到',
        text: '每日签到一次，连续签到天数显示于右侧。' },
      { t: 'daily', sel: '#dailyNews', title: '今日班级签',
        text: '每日一句班级签，与公告相互独立。' },
      { t: 'quote', sel: '#dailyQuoteBar', title: '每日一言',
        text: '随机展示一句短语，点击可切换下一条。' },
      { t: 'study', sel: '#studyCard', title: '学习卡片',
        text: '自习计时与学习时长统计入口。' },
      { t: 'count', sel: '#countdown', title: '倒计时',
        text: '重要考试倒计时；目标日期可在设置中修改。' },
      { t: 'guide', sel: '#guideBtn', title: '大屏与使用教程',
        text: '侧边栏可切换大屏模式，用于教室投影；本按钮打开使用教程。' }
    ]
  };

  /* ---------- 状态：{ login:{done:1} | {at:2}, home:… } ---------- */
  function readState() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function writeState(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function sceneDone(scene) {
    var s = readState()[scene];
    return !!(s && s.done);
  }
  function sceneAt(scene) {
    var s = readState()[scene] || {};
    return s.done ? 0 : (s.at || 0);
  }

  var cssAdded = false;
  function addCss() {
    if (cssAdded || document.getElementById('tourCss')) return;
    cssAdded = true;
    var css = ''
      + '.tour-hit{position:fixed;inset:0;z-index:9997;background:transparent;cursor:default}'
      + '.tour-hole{position:fixed;z-index:9998;pointer-events:none;border-radius:16px;'
      + 'box-shadow:0 0 0 9999px rgba(24,16,10,.66);'
      + 'transition:left .34s cubic-bezier(.32,.72,0,1),top .34s cubic-bezier(.32,.72,0,1),'
      + 'width .34s cubic-bezier(.32,.72,0,1),height .34s cubic-bezier(.32,.72,0,1)}'
      + '.tour-hole::after{content:"";position:absolute;inset:-3px;border-radius:19px;'
      + 'border:2px solid #f97316;animation:tourPulse 2.2s ease-in-out infinite}'
      + '@keyframes tourPulse{0%,100%{opacity:.5;transform:scale(1)}50%{opacity:1;transform:scale(1.014)}}'
      + '.tour-tip{position:fixed;z-index:9999;max-width:324px;background:#fffdfb;color:#292524;'
      + 'border-radius:16px;padding:15px 16px 13px;box-shadow:0 18px 48px rgba(60,30,10,.28);'
      + 'opacity:0;transform:translateY(10px);transition:opacity .3s ease,transform .3s ease}'
      + '.tour-tip.in{opacity:1;transform:translateY(0)}'
      + '.tour-kicker{font-size:.68rem;font-weight:700;letter-spacing:.06em;color:#c2410c;'
      + 'text-transform:uppercase;margin-bottom:5px}'
      + '.tour-title{font-size:.95rem;font-weight:800;margin:0 0 6px}'
      + '.tour-text{font-size:.82rem;line-height:1.72;color:#57534e;margin:0}'
      + '.tour-acts{display:flex;gap:8px;margin-top:13px;align-items:center}'
      + '.tour-prev{background:#f6f1ec;color:#8a3b12;border:none;border-radius:10px;'
      + 'padding:8px 13px;font-size:.78rem;font-weight:700;font-family:inherit;cursor:pointer}'
      + '.tour-next{flex:1;background:linear-gradient(135deg,#f97316,#c2410c);color:#fff;border:none;'
      + 'border-radius:10px;padding:9px 13px;font-size:.82rem;font-weight:800;'
      + 'font-family:inherit;cursor:pointer;transition:transform .12s ease}'
      + '.tour-next:active{transform:scale(.96)}'
      + '.tour-dots{position:fixed;left:50%;transform:translateX(-50%);z-index:9999;'
      + 'display:flex;gap:6px;padding:7px 11px;border-radius:999px;background:rgba(28,20,14,.55);'
      + 'backdrop-filter:blur(6px)}'
      + '.tour-dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.4);'
      + 'transition:all .25s ease}'
      + '.tour-dot.on{background:#fb923c;width:16px;border-radius:99px}'
      + '.tour-arrow{position:absolute;width:13px;height:13px;background:#fffdfb;'
      + 'transform:rotate(45deg);border-radius:2px}'
      + '.tour-shake{animation:tourNudge .42s ease}'
      + '@keyframes tourNudge{0%,100%{transform:translateX(0)}20%{transform:translateX(-7px)}'
      + '45%{transform:translateX(6px)}70%{transform:translateX(-3px)}}'
      + '.dark .tour-tip{background:#2b2522;color:#f2e9e1}'
      + '.dark .tour-text{color:#c9bdb2}'
      + '.dark .tour-prev{background:#3a332e;color:#e7c9a8}'
      + '.dark .tour-arrow{background:#2b2522}'
      + '@media (prefers-reduced-motion:reduce){'
      + '.tour-hole{transition:none}.tour-hole::after{animation:none}'
      + '.tour-tip{transition:opacity .15s ease;transform:none}}';
    var st = document.createElement('style');
    st.id = 'tourCss';
    st.textContent = css;
    document.head.appendChild(st);
  }

  var run = null;   /* { scene, steps, i, hole, tip, arrow, dots, hit, dotsEl } */
  var rafId = 0, followUntil = 0;

  function reduced() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }

  /* 目标元素是否真的可见（有尺寸且不在视口外太多） */
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    var vh = window.innerHeight, vw = window.innerWidth;
    if (r.bottom < -40 || r.top > vh + 40) return false;
    if (r.right < -40 || r.left > vw + 40) return false;
    return true;
  }

  /* 只过滤「DOM 里根本没有」的步骤。
     高度为 0 的（公告为空、一言还没渲染完）留到执行时再判断 —— 见 show()。 */
  function liveSteps(scene) {
    return (STEPS[scene] || []).filter(function (s) {
      return !!document.querySelector(s.sel);
    });
  }

  function build() {
    addCss();
    var hit = document.createElement('div');
    hit.className = 'tour-hit';
    var hole = document.createElement('div');
    hole.className = 'tour-hole';
    var tip = document.createElement('div');
    tip.className = 'tour-tip';
    var dotsEl = document.createElement('div');
    dotsEl.className = 'tour-dots';
    document.body.appendChild(hit);
    document.body.appendChild(hole);
    document.body.appendChild(tip);
    document.body.appendChild(dotsEl);
    document.documentElement.classList.add('tour-on');

    hit.addEventListener('click', function () {
      if (!run) return;
      var t = run.tip;
      t.classList.remove('tour-shake');
      void t.offsetWidth;
      t.classList.add('tour-shake');
    });

    return { hit: hit, hole: hole, tip: tip, dotsEl: dotsEl };
  }

  function destroy() {
    if (!run) return;
    ['hit', 'hole', 'tip', 'dotsEl'].forEach(function (k) {
      var el = run[k];
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    document.documentElement.classList.remove('tour-on');
    run = null;
    cancelAnimationFrame(rafId);
  }

  function place() {
    if (!run) return;
    var el = document.querySelector(run.steps[run.i].sel);
    if (!el) return;
    var r = el.getBoundingClientRect();
    var pad = 6;
    var left = Math.max(2, r.left - pad);
    var top = Math.max(2, r.top - pad);
    var w = Math.min(window.innerWidth - 4, r.width + pad * 2);
    var h = Math.min(window.innerHeight - 4, r.height + pad * 2);
    run.hole.style.left = left + 'px';
    run.hole.style.top = top + 'px';
    run.hole.style.width = w + 'px';
    run.hole.style.height = h + 'px';

    /* 气泡：优先放元素下方，放不下改上方，再不行贴视口底部 */
    var tip = run.tip;
    tip.style.visibility = 'hidden';
    tip.style.left = '0px';
    tip.style.top = '0px';
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var gap = 18;
    var tx = Math.min(Math.max(12, r.left + r.width / 2 - tw / 2), vw - tw - 12);
    var ty, arrowSide;
    if (r.bottom + gap + th + 44 <= vh) { ty = r.bottom + gap; arrowSide = 'top'; }
    else if (r.top - gap - th >= 8) { ty = r.top - gap - th; arrowSide = 'bottom'; }
    else { ty = Math.max(8, vh - th - 52); arrowSide = 'top'; }

    tip.style.left = tx + 'px';
    tip.style.top = ty + 'px';
    tip.style.visibility = 'visible';

    /* 箭头 */
    var arrow = run.arrow;
    if (!arrow) {
      arrow = document.createElement('div');
      arrow.className = 'tour-arrow';
      tip.appendChild(arrow);
      run.arrow = arrow;
    }
    var ax = Math.min(Math.max(14, r.left + r.width / 2 - tx - 6), tw - 26);
    arrow.style.left = ax + 'px';
    arrow.style[arrowSide] = '-6px';
    arrow.style[arrowSide === 'top' ? 'bottom' : 'top'] = 'auto';

    /* 进度点 */
    if (run.dotsEl) {
      run.dotsEl.style.bottom = 'max(18px, env(safe-area-inset-bottom))';
    }
  }

  function followFor(ms) {
    followUntil = Date.now() + ms;
    if (rafId) return;
    var tick = function () {
      place();
      if (Date.now() < followUntil) { rafId = requestAnimationFrame(tick); }
      else { rafId = 0; }
    };
    rafId = requestAnimationFrame(tick);
  }

  function show(i, retry) {
    if (!run) return;
    /* 目标不存在、或这一刻高度为 0（公告为空、学习卡还没渲染完）→ 先等 650ms 再看一次，
       仍然为 0 才跳到下一步，绝不停在一个 12×12 的空洞上。全部跳完就当作完成。 */
    if (i >= run.steps.length) { finish('done'); return; }
    var s = run.steps[i];
    var el = document.querySelector(s.sel);
    if (!el) {
      /* 元素被板块管理隐藏 / 未渲染 → 同上，从步数里去掉 */
      run.steps.splice(i, 1);
      if (i >= run.steps.length) { finish('done'); return; }
      return show(i);
    }
    var rr0 = el.getBoundingClientRect();
    if (rr0.width < 8 || rr0.height < 8) {
      if (!retry) {
        var my = ++run.tick;
        setTimeout(function () { if (run && run.tick === my) show(i, 1); }, 650);
        return;
      }
      /* 仍然是空壳（例如学习卡片没配置内容）→ 直接从这一步列表里去掉，
         进度点跟着变少；否则用户会看到「5 / 8」下一跳「7 / 8」，以为漏了一步。 */
      run.steps.splice(i, 1);
      if (i >= run.steps.length) { finish('done'); return; }
      return show(i);
    }

    run.i = i;

    try {
      if (rr0.top < 40 || rr0.bottom > window.innerHeight - 40) {
        el.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
      }
    } catch (e) {}

    var tip = run.tip;
    tip.innerHTML = ''
      + '<p class="tour-kicker">' + (i + 1) + ' / ' + run.steps.length + '</p>'
      + '<p class="tour-title"></p>'
      + '<p class="tour-text"></p>'
      + '<div class="tour-acts"></div>';
    tip.querySelector('.tour-title').textContent = s.title;
    tip.querySelector('.tour-text').textContent = s.text;

    var acts = tip.querySelector('.tour-acts');
    if (i > 0) {
      var pb = document.createElement('button');
      pb.className = 'tour-prev';
      pb.textContent = '上一步';
      pb.onclick = function () { show(i - 1); };
      acts.appendChild(pb);
    }
    var nb = document.createElement('button');
    nb.className = 'tour-next';
    nb.textContent = (i === run.steps.length - 1) ? '完成' : '下一步';
    nb.onclick = function () {
      if (i === run.steps.length - 1) finish('done');
      else show(i + 1);
    };
    acts.appendChild(nb);

    /* 内容重建后箭头节点没了，重置引用 */
    run.arrow = null;

    /* 进度点 */
    var dots = run.dotsEl;
    dots.innerHTML = '';
    run.steps.forEach(function (_, k) {
      var d = document.createElement('i');
      d.className = 'tour-dot' + (k <= i ? ' on' : '');
      dots.appendChild(d);
    });

    tip.classList.remove('in');
    void tip.offsetWidth;
    place();
    setTimeout(function () { if (run) run.tip.classList.add('in'); }, reduced() ? 0 : 130);

    /* 记录断点（未完成前） */
    var st = readState();
    st[run.scene] = { at: i };
    writeState(st);

    followFor(reduced() ? 0 : 620);
  }

  function finish(reason) {
    if (!run) return;
    var scene = run.scene;
    var st = readState();
    if (reason === 'done') {
      st[scene] = { done: 1 };
      writeState(st);
    } else {
      /* 中途退出：保留断点，下次从当前步继续 */
      st[scene] = { at: run.i };
      writeState(st);
    }
    destroy();
  }

  /* 有别的弹窗压着时不启动，等它关掉 */
  function blocked() {
    var sels = ['.welcome-mask.show', '.allboard-mask.show', '#hwPop.show',
      '.hwpop.show', '#loginGuideMask.show', '.site-gate.show'];
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (el) {
        var r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
    }
    return false;
  }

  function start(scene, force) {
    if (run) return false;
    if (!STEPS[scene]) return false;
    if (!force && sceneDone(scene)) return false;

    var steps = liveSteps(scene);
    if (!steps.length) return false;

    /* 断点续播：拿到过滤后的真实起点 */
    var at = sceneAt(scene);
    if (at >= steps.length) at = 0;
    if (force) at = 0;

    var dom = build();
    dom.hit.style.display = 'block';
    run = {
      scene: scene, steps: steps, i: at, tick: 0,
      hit: dom.hit, hole: dom.hole, tip: dom.tip, dotsEl: dom.dotsEl, arrow: null
    };
    show(at);
    return true;
  }

  /* 延后启动：等到没有遮挡为止。
     ⚠️ v4.12.0 线上实测：首次访问会先弹「欢迎来到5班服务站」，很多人会读一会
     再关。原来上限 8 次（12 秒）太短，读完再关就再也不弹了 —— 放宽到 24 次（36 秒）。 */
  function startWhenFree(scene, tries) {
    tries = tries || 0;
    if (run) return;
    if (blocked()) {
      if (tries < 24) setTimeout(function () { startWhenFree(scene, tries + 1); }, 1500);
      return;
    }
    start(scene);
  }

  function reset() {
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
  }

  function status() {
    var s = readState();
    var out = { home: 0, login: 0, all: true };
    ['login', 'home'].forEach(function (k) {
      if (s[k] && s[k].done) out[k] = -1;
      else if (s[k] && typeof s[k].at === 'number') out[k] = s[k].at + 1;
      else out[k] = 0;
      if (out[k] !== -1) out.all = false;
    });
    return out;
  }

  /* Esc 退出（保留断点） */
  document.addEventListener('keydown', function (e) {
    if (!run) return;
    if (e.key === 'Escape') { e.preventDefault(); finish('escape'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (run.i < run.steps.length - 1) show(run.i + 1); else finish('done'); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); if (run.i > 0) show(run.i - 1); }
  }, true);

  window.addEventListener('resize', function () { if (run) place(); });
  window.addEventListener('orientationchange', function () { if (run) setTimeout(place, 260); });
  window.addEventListener('scroll', function () { if (run) place(); }, { passive: true });

  window.TOUR = {
    start: start,
    startWhenFree: startWhenFree,
    reset: reset,
    status: status,
    finish: function (r) { finish(r || 'escape'); },
    isOn: function () { return !!run; }
  };
})(window, document);
