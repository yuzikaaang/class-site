/* ============================================================================
 * tour.js —— 新手导览（v4.13.0）
 * ----------------------------------------------------------------------------
 * 站主要求：
 *   「首页一点开就进入，最后介绍侧边栏；用户点了其他板块后，对每个板块
 *     再分别导览一次，同样用聚光式的效果。」
 *
 * 做法：
 *   · 每个场景独立记录完成状态（cls_tour_v1），互不影响。
 *     login 登录弹层 / home 首页 / services 常用服务 / hwpop 作业弹窗 /
 *     scores 成绩分析 / big 大屏模式 / settings 全站设置 / files 文件中转站。
 *   · 目标元素缺失或高度为 0（板块被隐藏、内容为空）时自动跳过该步，
 *     进度点同步收缩，不会出现「框了个空」或跳号。
 *   · 光洞在上一个元素位置的基础上平滑滑动（340ms），高亮环呼吸，
 *     气泡延迟淡入，底部进度点逐级点亮。
 *   · 无「跳过」按钮；点遮罩只抖动气泡提示。Esc 可退出，下次从断点续播。
 *   · 不做老用户豁免：升级后所有设备第一次进入都会走一遍（站主要求一视同仁）。
 *
 * 登记表：scripts/tour-map.json —— 导览步骤 / 教程条目 / 首页板块三者 key 必须一致，
 *   由 scripts/predeploy.mjs 四向比对，缺一处就拦部署。
 * ========================================================================= */
(function (window, document) {
  'use strict';

  var LS_KEY = 'cls_tour_v1';

  /* ---------- 步骤表 ----------
     字段：t = topic key（与 tour-map.json、guide.html 对齐）
           sel / sels = 目标元素（sels 取第一个有尺寸的，兼容「手机悬浮球 / 桌面侧边栏」）
           title / text = 气泡文案，书面表述，只描述同学能做的事。 */
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
        text: '今日课程与当前教学周，右上角「详情」可展开完整课表。' },
      { t: 'board', sel: '#board', title: '班级公告',
        text: '通知与活动集中发布在此。标题后的数字为未读条数。' },
      { t: 'sign', sel: '#signBar', title: '今日班级签',
        text: '每天可抽一次签，点右侧按钮查看今日签文，次日 0 点刷新。' },
      { t: 'daily', sel: '#dailyNews', title: '每日日报',
        text: '汇总当天的班级动态与提醒，没有内容时不显示。' },
      { t: 'quote', sel: '#dailyQuoteBar', title: '每日一言',
        text: '随机展示一句短语，点击可更换一条。' },
      { t: 'study', sel: '#studyCard', title: '学习卡片',
        text: '自习计时与学习时长统计，未启用时不显示。' },
      { t: 'count', sel: '#countdown', title: '倒计时',
        text: '距重要考试的剩余天数，日期由管理员统一维护。' },
      { t: 'more', sels: ['.fab', '#sidebar'], title: '侧边栏',
        text: '点此展开侧边栏：常用服务、成绩分析、大屏模式、设置与使用教程都在里面。' }
    ],
    services: [
      { t: 'svc-song', sel: '#tab-cat-1 [data-card="1"]', title: '点歌平台',
        text: '在站外 VoiceHub 运行，账号为学号，初始密码为出生日期。' },
      { t: 'svc-hw', sel: '#tab-cat-1 [data-card="2"]', title: '作业查看',
        text: '作业在站内查看，不跳转其他网站。点卡片标题展开说明与按钮。' }
    ],
    hwpop: [
      { t: 'hwpop-period', sels: ['#hwNormStrip', '#hwPickBar'], title: '期次与日期',
        text: '上方下拉切换作业期次，下方日期条按月排列，带点的日期有作业。' },
      { t: 'hwpop-list', sel: '#hwCurrentList', title: '作业清单',
        text: '按科目分组，右侧显示该科目已完成的条数。' },
      { t: 'hwpop-tools', sel: '#hwExpBtn', title: '勾选与导出',
        text: '勾选条目即记录完成；「导出图片」可把整份作业存成一张长图。' }
    ],
    scores: [
      { t: 'sc-note', sel: '.sc-notebar', title: '成绩来源',
        text: '成绩由管理员手动录入，发现错误请联系管理员核对。' },
      { t: 'sc-exam', sel: '#scBar', title: '选择考试',
        text: '下拉切换考试场次，成绩单与排名随之更新。' },
      { t: 'sc-pane', sel: '#scPaneBox', title: '成绩内容',
        text: '登录后此处出现三个页签：全班成绩单按总分或单科排序，我的画像看本人强弱项，成绩对比可任选两人逐科比较。' }
    ],
    big: [
      { t: 'big-nav', sel: '#sidebar', title: '顶部导航',
        text: '大屏模式下侧边栏变为顶部导航条，每个按钮对应一个板块。' },
      { t: 'big-tiles', sel: '#bigGroups', title: '功能分组',
        text: '功能按板块分组排列，磁贴即为入口。' },
      { t: 'big-tile', sel: '#bigGroups .big-tile', title: '进入功能',
        text: '点击磁贴进入对应功能；作业看板仅管理员可打开。' }
    ],
    settings: [
      { t: 'set-tabs', sel: '#uiSetMask .ui-tabs', title: '六个页签',
        text: '外观、排序、动效、大屏、数据、帮助，点击切换。' },
      { t: 'set-look', sel: '#uiSetMask .ui-tab[data-sec="look"]', title: '外观',
        text: '深浅色、背景与字号等显示设置。' },
      { t: 'set-order', sel: '#uiSetMask .ui-tab[data-sec="order"]', title: '排序',
        text: '调整首页板块的先后顺序，也可以隐藏暂时不用的板块。' },
      { t: 'set-big', sel: '#uiSetMask .ui-tab[data-sec="big"]', title: '大屏',
        text: '大屏右栏宽度、顶栏留白与卡片开关，仅保存在本机。' },
      { t: 'set-data', sel: '#uiSetMask .ui-tab[data-sec="data"]', title: '数据',
        text: '导出、导入本机设置；「恢复默认」会清空自定义内容。' },
      { t: 'set-help', sel: '#uiSetMask .ui-tab[data-sec="help"]', title: '帮助',
        text: '重看新手导览、重置导览记录、打开使用教程。' }
    ],
    files: [
      { t: 'files-tabs', sel: '#flMask [data-fltab="up"]', title: '四种用途',
        text: '发文件、发文本、取件、历史，按需切换。' },
      { t: 'files-drop', sel: '#flDrop', title: '上传',
        text: '点击或拖入文件上传，单个不超过 24MB，最多保存 15 天。' },
      { t: 'files-act', sel: '#flMask [data-fltab="get"]', title: '取件',
        text: '同学发来的文件在这里取：输入 6 位取件码即可下载。上传成功后同样会生成取件码，复制后发给对方。' }
    ]
  };

  var SCENES = ['login', 'home', 'services', 'hwpop', 'scores', 'big', 'settings', 'files'];

  /* ---------- 状态：{ home:{done:1} | {at:2} } ---------- */
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

  var run = null;
  var rafId = 0, followUntil = 0;

  function reduced() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }

  function selList(s) { return s.sels || [s.sel]; }

  function hasAny(s) {
    var l = selList(s);
    for (var i = 0; i < l.length; i++) { if (document.querySelector(l[i])) return true; }
    return false;
  }

  /* 取第一个「存在且有尺寸」的目标 —— 手机取悬浮球、桌面取侧边栏 */
  function pickEl(s) {
    var l = selList(s);
    for (var i = 0; i < l.length; i++) {
      var el = document.querySelector(l[i]);
      if (!el) continue;
      var r = el.getBoundingClientRect();
      if (r.width >= 8 && r.height >= 8) return el;
    }
    return null;
  }

  /* 元素在、但既没有文字也没有图 → 空壳（例如未登录时的成绩页签栏），
     不计入步数，否则进度点会从「2 / 4」跳到「3 / 3」。 */
  function hollow(s) {
    var el = pickEl(s);
    if (!el) return false;                 /* 没有尺寸：留给 show() 重试或跳过 */
    if (el.querySelector('img,svg,canvas,input,select,textarea')) return false;
    return !String(el.textContent || '').replace(/\s+/g, '');
  }

  /* 元素被「排序 → 隐藏」关掉时是 display:none，导览不该算这一步。
     ⚠️ v4.13.0 线上实测：学习卡片隐藏后仍被算进 8 步，走到第 6 步才被
     show() 里的兜底剔掉 —— 进度点从「5 / 8」跳到「6 / 7」，看着像漏了一步。
     所以在开跑前就把不可见的步骤剔掉。 */
  function hiddenAll(s) {
    var l = selList(s), any = false;
    for (var i = 0; i < l.length; i++) {
      var el = document.querySelector(l[i]);
      if (!el) continue;
      any = true;
      var cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      var r = el.getBoundingClientRect();
      if (r.width >= 8 && r.height >= 8) return false;   /* 有一个能用的就不算隐藏 */
    }
    return any;
  }

  /* 只保留「存在且看得见」的步骤。剔除原因记在 TOUR._skipped，便于线上排查 */
  var skipped = [];
  function liveSteps(scene) {
    skipped = [];
    return (STEPS[scene] || []).filter(function (s) {
      if (!hasAny(s)) return true;         /* 还没渲染出来：留给 show() 重试 */
      if (hiddenAll(s)) { skipped.push(s.t + ':hidden'); return false; }
      if (hollow(s)) { skipped.push(s.t + ':hollow'); return false; }
      return true;
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
    var el = pickEl(run.steps[run.i]);
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
    if (i >= run.steps.length) { finish('done'); return; }
    var s = run.steps[i];

    var el = pickEl(s);
    if (!el) {
      if (hasAny(s) && !retry) {
        /* 元素在，但此刻高度为 0（面板还在动画、内容未渲染）→ 等 650ms 再看一次 */
        var my = ++run.tick;
        setTimeout(function () { if (run && run.tick === my) show(i, 1); }, 650);
        return;
      }
      /* 确实没有这个东西（板块被隐藏、内容为空）→ 从步数里去掉，进度点同步收缩 */
      run.steps.splice(i, 1);
      if (i >= run.steps.length) { finish('done'); return; }
      return show(i);
    }

    run.i = i;

    try {
      var rr0 = el.getBoundingClientRect();
      if (rr0.top < 40 || rr0.bottom > window.innerHeight - 40) {
        el.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
      }
    } catch (e) {}

    var tip = run.tip;
    tip.innerHTML = ''
      + '<p class="tour-kicker">' + (i + 1) + ' / ' + (run.total || run.steps.length) + '</p>'
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

    run.arrow = null;

    /* 进度点总数固定为开跑时的步数：中途把「空掉的那一步」剔掉时，
       分母不跟着变，避免出现「5 / 8」下一屏变「6 / 7」 */
    var dots = run.dotsEl;
    var dn = run.total || run.steps.length;
    dots.innerHTML = '';
    for (var k = 0; k < dn; k++) {
      var d = document.createElement('i');
      /* 走到最后一步时把剩余点一起点亮（中途剔除过步骤时分母仍按原始步数） */
      d.className = 'tour-dot' + ((k <= i || i >= run.steps.length - 1) ? ' on' : '');
      dots.appendChild(d);
    }

    tip.classList.remove('in');
    void tip.offsetWidth;
    place();
    setTimeout(function () { if (run) run.tip.classList.add('in'); }, reduced() ? 0 : 130);

    var st = readState();
    st[run.scene] = { at: i };
    writeState(st);

    followFor(reduced() ? 0 : 620);
  }

  function finish(reason) {
    if (!run) return;
    var scene = run.scene;
    var st = readState();
    if (reason === 'done') st[scene] = { done: 1 };
    else st[scene] = { at: run.i };
    writeState(st);
    destroy();
  }

  /* 有别的弹窗压着时不启动。
     ⚠️ 导览本身就要在弹层**里面**工作：登录 (#acctMask)、设置 (#uiSetMask)、
     作业 (#hwCurrentMask)、文件 (#flMask) 都必须排除，否则永远等不到「无遮挡」。 */
  function blocked() {
    var sels = ['.welcome-mask.show', '#hwPop.show', '.hwpop.show', '#loginGuideMask.show',
      '.allboard-mask.show:not(#acctMask):not(#uiSetMask):not(#hwCurrentMask):not(#flMask):not(#dataMask)'];
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
    /* 大屏模式不自动弹首页导览（教室电脑每次重启都弹会打断使用）。
       放在 start 里而不是只放调用方：big.js 排在 app.min.js 之后，
       app.js 顶层启动时 BIG 还不存在，只能延后再判。 */
    if (!force && scene === 'home' && window.BIG && window.BIG.on) return false;

    var steps = liveSteps(scene);
    if (!steps.length) return false;

    var at = sceneAt(scene);
    if (at >= steps.length) at = 0;
    if (force) at = 0;

    var dom = build();
    run = {
      scene: scene, steps: steps, i: at, tick: 0, total: steps.length,
      hit: dom.hit, hole: dom.hole, tip: dom.tip, dotsEl: dom.dotsEl, arrow: null
    };
    show(at);
    return true;
  }

  /* 等没遮挡了再启动；最多等 36 秒（有人会把欢迎弹窗读完才关）。
     settle：首页板块多、渲染有先后，若这一刻发现有步骤「暂时不可见」，
     再等两轮（2.1 秒）才认账 —— 否则会把「还没画出来」当成「被隐藏」，
     导览少一步。持久隐藏的板块（例如学习卡片被关掉）等满两轮后照常按实有块数走。 */
  function startWhenFree(scene, tries, settle) {
    tries = tries || 0;
    settle = settle || 0;
    if (run) return;
    if (blocked()) {
      if (tries < 24) setTimeout(function () { startWhenFree(scene, tries + 1, settle); }, 1500);
      return;
    }
    if (scene === 'home' && settle < 3 && liveSteps(scene).length < (STEPS[scene] || []).length) {
      setTimeout(function () { startWhenFree(scene, tries, settle + 1); }, 700);
      return;
    }
    start(scene);
  }

  /* 进入某个界面后调用：延时一小会儿（等布局稳定）再试 */
  function maybe(scene, delay) {
    if (sceneDone(scene)) return;
    setTimeout(function () {
      try { startWhenFree(scene); } catch (e) {}
    }, delay == null ? 700 : delay);
  }

  function reset() {
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
  }

  function status() {
    var s = readState();
    var out = { list: [], all: true, done: 0, total: SCENES.length };
    SCENES.forEach(function (k) {
      var row = s[k] || {};
      var st = row.done ? 2 : (typeof row.at === 'number' ? 1 : 0);
      out.list.push({ scene: k, state: st, at: row.at || 0 });
      if (st === 2) out.done++;
      else out.all = false;
    });
    /* 兼容旧字段 */
    out.home = (s.home && s.home.done) ? -1 : (s.home && typeof s.home.at === 'number' ? s.home.at + 1 : 0);
    out.login = (s.login && s.login.done) ? -1 : (s.login && typeof s.login.at === 'number' ? s.login.at + 1 : 0);
    return out;
  }

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
    scenes: SCENES,
    start: start,
    startWhenFree: startWhenFree,
    maybe: maybe,
    reset: reset,
    status: status,
    finish: function (r) { finish(r || 'escape'); },
    isOn: function () { return !!run; },
    _skipped: function () { return skipped.slice(); }
  };
})(window, document);
