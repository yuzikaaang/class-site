/* ============================================================================
 * big.js —— 大屏模式（v3.19.0）
 * ----------------------------------------------------------------------------
 * 站主原话（2026-11-03）：
 *   「这个班级的网站我后续会在我们班上电脑大屏上运用……在设置新增一个大屏模式
 *     的选项，打开之后他就是一个页面显示全部功能……所有的功能类似一个应用图标
 *     一样，在一个页面全部显示。」
 *   「关于作业查看……仿照那个 classworks 的界面 UI 去做……点击作业卡片之后
 *     就可以直接添加作业。它还有时间的功能……随机点名就是复用后台人员数据。」
 *
 * 分三块：
 *   ① 图标墙（#bigHome）：按现有板块分组，卡片变成大图标；
 *      站内功能点进去是「单功能页」（隐藏同板块其它卡片），外链直接新窗口。
 *   ② 大屏作业页（#bigHw）：左边作业可原地编辑（管理员），右边实时时钟 /
 *      今日事项 / 随机点名。作业改动写回云端内容（holiday_homeworks）。
 *   ③ 随机点名：名单复用站内 classList()（/profile?action=roster），
 *      默认只抽学生，带滚动动画，结果可单个重抽，可排除请假 / 不参与的同学。
 *
 * 几个约束（踩过才知道）：
 *   · 开关只存本机（localStorage: cls_bigscreen），站主要求「只存本机」；
 *     另外支持 ?big=1 / ?big=0 一次性强制，方便班级电脑把快捷方式钉死。
 *   · 作业写云端走 saveContentLocal() + pushCloudContent()，跟后台同一套
 *     内容键（holiday_homeworks），不另建接口，避免两套数据打架。
 *   · 只有管理员能改作业：按钮对普通同学直接不渲染，服务端也会拦。
 * ========================================================================= */
(function (global) {
  'use strict';

  var KEY = 'cls_bigscreen';
  var EX_KEY = 'cls_big_pick_ex';      /* { 姓名: 'leave' | 'out' } */

  var BIG = global.BIG = {
    on: false,
    hwOn: false,
    hwId: null,
    tiles: {},
    _saveT: null,
    _clockT: null,
    pick: { open: false, n: 1, state: 'setup', names: [], timer: null, roster: [], ex: {} }
  };

  function $(id){ return document.getElementById(id); }
  /* 文本统一去 emoji（站规：功能图标走图标库，正文不留 emoji）。
     直接用网站自己的 stripEmoji，规则保持一致。 */
  function esc0(s){
    var t = (typeof stripEmoji === 'function') ? stripEmoji(s) : String(s == null ? '' : s);
    return (typeof esc === 'function') ? esc(t) : t;
  }
  function iconKeyOf(t){
    var s = String(t == null ? '' : t);
    if(typeof EMOJI_ICON_MAP === 'undefined') return '';
    var keys = Object.keys(EMOJI_ICON_MAP);
    for(var i = 0; i < keys.length; i++){ if(s.indexOf(keys[i]) >= 0) return EMOJI_ICON_MAP[keys[i]]; }
    return '';
  }
  /* 纯文本位置（title / placeholder）用这个：只去 emoji，不带 HTML 转义 */
  function plain(s){ return (typeof stripEmoji === 'function') ? stripEmoji(s) : String(s == null ? '' : s); }
  function attr0(s){ return (typeof attr === 'function') ? attr(s) : esc0(s); }
  function ico(name, size){ return (typeof iconSvg === 'function') ? iconSvg(name, size || 16) : ''; }
  function toast(t, err){ try{ toastMini(t, err); }catch(e){} }
  function adminOk(){ return typeof isAdmin === 'function' && isAdmin(); }
  function loggedIn(){ return typeof isLoggedIn === 'function' && isLoggedIn(); }
  function data(){ return (global.SITE_DATA || {}); }

  /* ---------------- 开关 ---------------- */

  function readOn(){
    try{ return localStorage.getItem(KEY) === '1'; }catch(e){ return false; }
  }
  function writeOn(v){
    try{ localStorage.setItem(KEY, v ? '1' : '0'); }catch(e){}
  }

  /* URL 参数优先：?big=1 / ?big=0，进站即改并记住，方便班级电脑做快捷方式 */
  (function parseQuery(){
    try{
      var q = String(location.search || '');
      if(/[?&]big=1(?:&|$)/.test(q)) writeOn(true);
      else if(/[?&]big=0(?:&|$)/.test(q)) writeOn(false);
    }catch(e){}
  })();

  BIG.on = readOn();

  function applyClass(){
    var el = document.documentElement;
    if(BIG.on) el.classList.add('big-mode');
    else el.classList.remove('big-mode', 'big-cat', 'big-hw');
  }

  /* 设置面板里的开关：只影响这台设备 */
  global.bigToggle = function (ev){
    if(ev && ev.preventDefault) ev.preventDefault();
    BIG.setMode(!BIG.on);
  };
  BIG.setMode = function (on){
    BIG.on = !!on;
    writeOn(BIG.on);
    applyClass();
    if(BIG.on){
      buildHome();
      /* 从普通模式切过来时，当前可能停在某个板块 —— 回大屏首页最直观 */
      try{ goHomeView(); }catch(e){}
      toast('大屏模式已开启');
    }else{
      BIG.closeHw();
      try{ goHomeView(); }catch(e){}
      toast('已切回普通模式');
    }
    try{ renderSettings(); }catch(e){}
  };

  /* ---------------- 图标墙 ---------------- */

  function catName(id){
    var cats = data().categories || [];
    for(var i = 0; i < cats.length; i++){ if(Number(cats[i].id) === Number(id)) return cats[i].name || ''; }
    return '';
  }

  /* 每张卡片点下去做什么：
       作业查看 → 大屏作业页（站主点名要的那一页）
       站内工具 → 打开它所在的板块，并只留这一张卡
       外链     → 新窗口（微信里走既有引导） */
  function actionOf(catId, l){
    if(l.id === 2) return function (){ BIG.openHw(); };
    if(l.paused) return null;
    if(l.contactQuery) return function (){ openCardAlone(catId, l); };
    if(typeof httpUrl === 'function' && httpUrl(l.mainUrl)){
      return function (){ openLink(l.mainUrl, l.mainWechatOk, l.title); };
    }
    return function (){ openCardAlone(catId, l); };
  }

  function openCardAlone(catId, l){
    try{ openCat(catId); }catch(e){ return; }
    setTimeout(function (){
      var grid = $('grid');
      if(!grid) return;
      grid.classList.add('big-single');
      var cards = grid.querySelectorAll('.card');
      for(var i = 0; i < cards.length; i++) cards[i].classList.remove('big-only');
      var el = grid.querySelector('.card[data-card="' + String(l.id).replace(/"/g, '') + '"]');
      if(el){
        el.classList.add('big-only');
        try{ el.scrollIntoView({ block: 'start' }); }catch(e){}
      }
      var t = $('bigSubTitle');
      if(t) t.textContent = l.title || '';
    }, 80);
  }

  function buildHome(){
    var host = $('bigGroups');
    if(!host) return;
    var cats = (typeof uiCats === 'function') ? uiCats() : (data().categories || []);
    var html = '';
    BIG.tiles = {};

    cats.forEach(function (c){
      var links = (typeof uiLinks === 'function') ? uiLinks(c.id) : [];
      var tiles = [];

      /* 板块本身就是一个功能（成绩分析 / 班级事务）时，补一个「进板块」的图标。
         这两块没有卡片，光靠 links 会整组空掉。 */
      if(c.id === 3){
        tiles.push({ title: '成绩分析', sub: '成绩 · 排名 · 分析', icon: '', iconText: '成绩', act: function (){ openCat(3); } });
      }
      if(c.id === 7){
        tiles.push({ title: '投票专区', sub: '进行中 / 已结束', icon: '', iconText: '投票', act: function (){ openCat(7); } });
      }

      links.forEach(function (l){
        var act = actionOf(c.id, l);
        tiles.push({
          title: l.title,
          sub: l.paused ? '暂停开放' : (l.subtitle || ''),
          icon: l.icon || '',
          iconText: l.iconText || String(l.title || '').slice(0, 1),
          off: !act,
          tip: l.paused ? (l.pausedMsg || '暂停开放') : l.title,
          act: act || function (){ toast('这个入口暂时关闭了', true); }
        });
      });

      if(!tiles.length) return;

      html += '<section class="big-group"><h2>' + esc0(c.name) + '</h2><div class="big-tiles">';
      tiles.forEach(function (t, i){
        var k = 't' + c.id + '_' + i;
        BIG.tiles[k] = t.act;
        var icoHtml = t.icon
          ? '<img src="' + esc0(t.icon) + '" alt="" loading="lazy" decoding="async" width="56" height="56">'
          : (iconKeyOf(t.iconText) ? ico(iconKeyOf(t.iconText), 30) : '<span class="bt-txt">' + esc0(t.iconText || '') + '</span>');
        html += '<button type="button" class="big-tile' + (t.off ? ' off' : '') + '" data-big="' + attr0(k) + '"'
             +  ' title="' + attr0(t.tip || t.title) + '">'
             +    '<span class="bt-ico">' + icoHtml + '</span>'
             +    '<span class="bt-t">' + esc0(t.title) + '</span>'
             +    (t.sub ? '<span class="bt-s">' + esc0(t.sub) + '</span>' : '')
             +  '</button>';
      });
      html += '</div></section>';
    });

    host.innerHTML = html || '<p class="big-empty">还没有可显示的功能，请先在后台添加板块。</p>';
  }

  document.addEventListener('click', function (e){
    var t = e.target;
    if(!t || !t.closest) return;
    var el = t.closest('[data-big]');
    if(!el) return;
    var fn = BIG.tiles[el.getAttribute('data-big')];
    if(typeof fn === 'function'){ e.preventDefault(); fn(); }
  }, false);

  /* ---------------- 视图切换（包一层，不改 app.js 的既有逻辑） ---------------- */

  function wrap(name, after){
    var f = global[name];
    if(typeof f !== 'function' || f.__bigWrapped) return;
    var w = function (){
      var r = f.apply(this, arguments);
      try{ after.apply(this, arguments); }catch(e){ console.warn('[big]' + name, e); }
      return r;
    };
    w.__bigWrapped = true;
    global[name] = w;
  }

  function leaveHwUi(){
    var h = $('bigHw');
    if(h) h.style.display = 'none';
    document.documentElement.classList.remove('big-hw');
    BIG.hwOn = false;
    if(BIG._clockT){ clearInterval(BIG._clockT); BIG._clockT = null; }
    stopHwTimers();
  }

  wrap('goHomeView', function (){
    if(!BIG.on) return;
    leaveHwUi();
    document.documentElement.classList.remove('big-cat');
    var grid = $('grid');
    if(grid) grid.classList.remove('big-single');
    var h = $('bigHome');
    if(h) h.style.display = '';
    buildHome();
  });

  wrap('openCat', function (id){
    if(!BIG.on) return;
    leaveHwUi();
    document.documentElement.classList.add('big-cat');
    var grid = $('grid');
    if(grid) grid.classList.remove('big-single');
    var t = $('bigSubTitle');
    if(t) t.textContent = catName(id) || '功能';
  });

  /* 云端内容 / 班级岛都是异步回来的：
     · rerenderAll() 之后首页与作业页要跟着重画（否则改了作业、别的设备看不到）
     · 班级岛回来后，作业页右栏的「今日事项」才有内容 */
  wrap('rerenderAll', function (){
    if(!BIG.on) return;
    if(BIG.hwOn) BIG.renderHw();
    else if(!document.documentElement.classList.contains('big-cat')) buildHome();
  });
  wrap('islandRender', function (){
    if(BIG.on && BIG.hwOn) renderSide();
  });

  /* 大屏首页的「返回」 */
  global.bigBack = function (){
    try{ goHomeView(); }catch(e){}
  };

  /* ---------------- 大屏作业页（v4.0.0 重做） ----------------
     站主 2026-11-03 的 9 条，这一页占了大半：
       ① 新建一期能命名，历史作业能重命名
       ② 时钟精确到秒
       ③ 字号可调（只对这一页生效）
       ④ 底部工具条：A− / A+ / 锁定
       ⑤ 左右两栏（语数英 / 物化生）+ 右栏小功能 + 底部其他，一屏看完
       ⑦ 图片直接铺出来，音频点击才播
     实现上刻意保持「数据形状不变」：仍然是 holiday_homeworks 里的
     items[].tasks[]，task 依旧可以是字符串或 {text,img,audio}。
     只改渲染与交互，云端结构不动，老数据不会丢。 */

  var FS_KEY = 'cls_bhw_fs';
  var FS_STEPS = [0.85, 0.95, 1, 1.1, 1.2, 1.35, 1.5, 1.7];
  var SUBJ_A = ['语文', '数学', '英语'];
  var SUBJ_B = ['物理', '化学', '生物'];
  /* v4.3.0 站主要求：新建一期默认带上六科，不用每次手动加 */
  var PRESET_SUBJECTS = SUBJ_A.concat(SUBJ_B);

  /* —— 换字体（v4.3.0）——
     全程走系统已装字体，不引外部字体文件：班级电脑很可能断网，
     远程字体加载不到反而更难看。每项给一个在 Win / Mac 上都尽量有的备选栈。 */
  var FONT_KEY = 'cls_bhw_font';
  var FONTS = [
    { id: 'hei', name: '黑体（默认）', desc: '笔画均匀，远距离清晰',
      stack: "'Inter','PingFang SC','HarmonyOS Sans SC','Microsoft YaHei UI','Microsoft YaHei','Source Han Sans SC','Noto Sans CJK SC',system-ui,sans-serif" },
    { id: 'song', name: '宋体', desc: '横细竖粗，端正',
      stack: "'Songti SC','SimSun','Source Han Serif SC','Noto Serif CJK SC','STSong',serif" },
    { id: 'kai', name: '楷体', desc: '接近手写，柔和',
      stack: "'Kaiti SC','KaiTi','STKaiti','楷体',serif" },
    { id: 'round', name: '圆体', desc: '边角圆润',
      stack: "'YouYuan','Yuanti SC','Hiragino Sans GB','Microsoft YaHei UI','Microsoft YaHei',sans-serif" },
    { id: 'deng', name: '等线', desc: '笔画较细，字面较大',
      stack: "'DengXian','等线','Microsoft YaHei UI','Microsoft YaHei',sans-serif" }
  ];
  function readFont(){
    var v = '';
    try{ v = String(localStorage.getItem(FONT_KEY) || ''); }catch(e){}
    for(var i = 0; i < FONTS.length; i++) if(FONTS[i].id === v) return v;
    return 'hei';
  }
  function fontOf(id){
    for(var i = 0; i < FONTS.length; i++) if(FONTS[i].id === id) return FONTS[i];
    return FONTS[0];
  }
  function applyFont(){
    var h = $('bigHw');
    if(h) h.style.setProperty('--bhw-font', fontOf(BIG.font).stack);
  }
  BIG.font = readFont();
  BIG.fontSet = function (id){
    BIG.font = fontOf(id).id;
    try{ localStorage.setItem(FONT_KEY, BIG.font); }catch(e){}
    applyFont();
    if(BIG.hwOn) scheduleLayout();
    BIG.fontClose();
    toast('字体已换成「' + fontOf(BIG.font).name + '」');
  };

  /* —— 随机一言（v4.3.0）——
     站主原话：「今日一句那个换一句点击没有反应，而且我可以设置每隔 5 分钟自动换」。
     原来侧栏这块只是把首页 #dailyQuoteBar 的 textContent 抄过来，没有点击、也没有来源，
     出处跟正文一个颜色，看着糊成一片。现在这里独立维护一份：
       · 点卡片任意位置 = 换一句（先本地随机，再联网补一句更好的）
       · 自动轮换间隔可设：1 / 3 / 5 / 10 / 30 分钟，或关掉
       · 出处用小一号、淡色，和正文分开 */
  var QI_KEY = 'cls_bhw_quote_min';
  BIG.quoteMin = (function (){
    var n = 5;
    try{
      var v = localStorage.getItem(QI_KEY);
      if(v !== null) n = parseInt(v, 10);
    }catch(e){}
    return (n >= 0 && n <= 60) ? n : 5;
  })();
  BIG.quoteData = null;
  BIG.quoteSetMin = function (n){
    n = Math.max(0, Math.min(60, parseInt(n, 10) || 0));
    BIG.quoteMin = n;
    try{ localStorage.setItem(QI_KEY, String(n)); }catch(e){}
    BIG.quoteAuto();
    renderQuote();
    BIG.quoteClose();
    toast(n ? ('随机一言每 ' + n + ' 分钟自动换') : '已关闭自动更换');
  };
  BIG.quoteAuto = function (){
    if(BIG._quoteT){ clearInterval(BIG._quoteT); BIG._quoteT = null; }
    if(!BIG.quoteMin) return;
    BIG._quoteT = setInterval(function (){
      if(!BIG.hwOn) return;
      BIG.quoteNext(true);
    }, BIG.quoteMin * 60000);
  };

  function readFs(){
    var n = 2;
    try{ n = parseInt(localStorage.getItem(FS_KEY), 10); }catch(e){}
    if(!(n >= 0 && n < FS_STEPS.length)) n = 2;
    return n;
  }
  function applyFs(){
    var h = $('bigHw');
    if(h) h.style.setProperty('--bhw-fs', String(FS_STEPS[BIG.fs]));
    var v = $('bhwFsVal');
    if(v) v.textContent = Math.round(FS_STEPS[BIG.fs] * 100) + '%';
    /* 字号一变，卡片高度跟着变 —— 立刻重排一次（站主第 2 条：每次调字号都要实时重排） */
    if(BIG.hwOn) scheduleLayout();
  }
  BIG.fs = readFs();
  BIG.fsStep = function (d){
    var n = BIG.fs + (d > 0 ? 1 : -1);
    if(n < 0 || n >= FS_STEPS.length){ toast(n < 0 ? '已是最小字号' : '已是最大字号'); return; }
    BIG.fs = n;
    try{ localStorage.setItem(FS_KEY, String(n)); }catch(e){}
    applyFs();
  };

  /* —— 锁定：锁上以后整页点击 / 滑动 / 滚动全部失效 ——
     站主原话：「点击或滑动都没有任何反应，你必须先点解锁才行」。
     做法：一层透明遮罩盖住整页（拦截点击），再在捕获阶段拦住滚轮 / 触摸 / 方向键。
     锁定状态**不写 localStorage**：刷新页面即解锁，避免大屏自己锁死没人能开。 */
  /* —— 主题切换（v4.3.1）——
     站主：「作业面板里面我可以切换暗色和明亮模式，这个按钮不需要隐藏」。
     作业页把侧边栏整个藏掉了（大屏专用页），全站的 #themeToggle 也跟着不见，
     所以底栏单独放一个。真正的切换仍走 app.js 的 toggleTheme（带扩散动画 + 记忆本机），
     这里只管调用，并把按钮文案同步成当前状态。 */
  function syncThemeBtn(){
    var b = $('bhwThemeBtn'); if(!b) return;
    var dark = document.documentElement.classList.contains('dark');
    /* 按钮显示「点下去会变成什么」：现在明亮就写「暗色」，并配月亮图标 —— 比显示当前状态更好懂 */
    var ic = ico(dark ? 'sun' : 'moon', 15);
    b.innerHTML = (ic ? ic + ' ' : '') + (dark ? '明亮' : '暗色');
    b.title = dark ? '切换为明亮模式' : '切换为暗色模式';
  }
  BIG.syncThemeBtn = syncThemeBtn;
  BIG.themeToggle = function (e){
    try{ if(typeof toggleTheme === 'function') toggleTheme(e || window.event); }catch(err){}
    setTimeout(syncThemeBtn, 60);
    setTimeout(syncThemeBtn, 420);   /* 扩散动画结束后再对一次，防止动画中途被覆盖 */
  };
  /* 自动切换（日出日落 / 跟随系统）也会改 html.dark，按钮要跟着变 */
  try{
    new MutationObserver(syncThemeBtn).observe(document.documentElement,
      { attributes: true, attributeFilter: ['class'] });
  }catch(e){}

  BIG.lockOn = false;
  BIG.lockToggle = function (){
    BIG.lockOn = !BIG.lockOn;
    document.documentElement.classList.toggle('bhw-locked', BIG.lockOn);
    var b = $('bhwLockBtn');
    if(b){
      b.textContent = BIG.lockOn ? '已锁定' : '锁定';
      b.classList.toggle('bhw-lockon', BIG.lockOn);
    }
    toast(BIG.lockOn ? '已锁定，点击右下角「解锁」' : '已解锁');
  };
  BIG.lockBlock = function (e){
    if(e && e.preventDefault) e.preventDefault();
    if(e && e.stopPropagation) e.stopPropagation();
    return false;
  };
  document.addEventListener('wheel', function (e){
    if(BIG.lockOn && BIG.hwOn && e.cancelable) e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchmove', function (e){
    if(BIG.lockOn && BIG.hwOn && e.cancelable) e.preventDefault();
  }, { passive: false });
  document.addEventListener('keydown', function (e){
    if(!BIG.lockOn || !BIG.hwOn) return;
    var k = e.key;
    if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End',' '].indexOf(k) >= 0){
      e.preventDefault();
    }
  }, true);

  /* 窗口尺寸变了（大屏切分辨率 / 浏览器缩放）卡片要重新分配 */
  var _rzTimer = null;
  window.addEventListener('resize', function (){
    if(!BIG.hwOn) return;
    if(_rzTimer) clearTimeout(_rzTimer);
    _rzTimer = setTimeout(function (){ _rzTimer = null; BIG.relayout(); }, 160);
  });

  function todayStr(){
    var d = new Date();
    function p(n){ return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function hwList(){ return (data().holidayHomeworks || []); }

  /* v4.3.0（站主第 4 条）：没手动选期次时，只认「今天落在起止日期之内」的那一期。
     以前兜底取 list 最后一条 —— 那是「上一次作业」，学生放假回来第一天看到的是旧作业，
     会以为今天还要写。现在没有就返回 null，页面显示「当前没有作业」。 */
  function currentHw(){
    var list = hwList();
    if(BIG.hwId){
      for(var i = 0; i < list.length; i++){ if(String(list[i].id) === String(BIG.hwId)) return list[i]; }
    }
    var t = todayStr(), hit = null;
    for(var j = 0; j < list.length; j++){
      var x = list[j];
      var s = String(x.start || '').slice(0, 10) || String(x.end || '').slice(0, 10);
      var e = String(x.end || '').slice(0, 10) || s;
      if(!s) continue;
      if(s <= t && t <= e){
        /* 万一有两期重叠，取日期更靠近今天的（结束日期更晚的那期） */
        if(!hit || e > (String(hit.end || '').slice(0, 10))) hit = x;
      }
    }
    return hit;
  }

  function subjStyle(s){
    try{
      if(typeof HW_SUBJECT_STYLE !== 'undefined' && HW_SUBJECT_STYLE[s]) return HW_SUBJECT_STYLE[s];
    }catch(e){}
    return { c: '#9a3412' };
  }

  /* 媒体渲染（站主第 7 条）：
       图片 —— 直接铺在作业下面，一眼能看见；点击只是放大，不是唯一入口。
       视频 —— 原生播放器，同样直接显示。
       音频 —— 仍然点击才播（自动播放会被浏览器拦，也吵）。 */
  function mediaHtml(o){
    var img = o && o.img, video = o && o.video, audio = o && o.audio, label = o && o.audioLabel;
    if(!img && !video && !audio) return '';
    var out = '';
    if(img){
      var isVid = /\.(mp4|webm|mov|m4v|ogv|avi)(\?|#|$)/i.test(String(img));
      out += isVid
        ? '<video class="bhw-img" src="' + attr0(img) + '" controls preload="metadata" playsinline></video>'
        : '<img class="bhw-img" src="' + attr0(img) + '" alt="作业配图" loading="lazy"'
          + ' onload="BIG.relayout()" onclick="BIG.zoomImg(this.src)" title="查看大图">';
    }
    if(video){
      out += '<video class="bhw-img" src="' + attr0(video) + '" controls preload="metadata" playsinline></video>';
    }
    if(audio){
      out += '<button type="button" class="bhw-audio" onclick="event.stopPropagation();BIG.playAudio('
        + "'" + attr0(encodeURIComponent(String(audio))) + "','"
        + attr0(String(label || '播放音频').replace(/'/g, '')) + "')\">"
        + ico('headphones', 14) + ' ' + esc0(label || '播放音频') + '</button>';
    }
    return '<div class="bhw-media">' + out + '</div>';
  }

  BIG.playAudio = function (enc, label){
    var u = enc;
    try{ u = decodeURIComponent(enc); }catch(e){}
    try{
      if(typeof openAudio === 'function'){ openAudio(u, label || '播放音频'); return; }
    }catch(e){}
    try{ window.open(u, '_blank'); }catch(e2){}
  };

  BIG.zoomImg = function (src){
    var z = $('bhwZoom');
    if(!z){
      z = document.createElement('div');
      z.id = 'bhwZoom';
      z.className = 'bhw-zoom';
      z.innerHTML = '<img alt="作业配图">';
      z.onclick = function (){ z.classList.remove('show'); };
      document.body.appendChild(z);
    }
    z.querySelector('img').src = src;
    z.classList.add('show');
  };

  function taskHtml(it, si, ti, t, admin){
    var o = (t && typeof t === 'object') ? t : { text: String(t == null ? '' : t) };
    var text = o.text || '';
    /* 编辑态用 textarea + 自适应高度：单行 input 装不下长句，字一多就被框子截断。 */
    var main = admin
      ? '<textarea class="bhw-in bhw-area" rows="1" placeholder="输入作业内容"'
        + ' oninput="BIG.autoGrow(this)"'
        + ' onchange="BIG.hwTask(' + si + ',' + ti + ',this.value)">' + esc0(text) + '</textarea>'
      : '<span class="bhw-txt">' + esc0(text) + '</span>';
    return '<div class="bhw-task">'
      + '<span class="bhw-dot"></span>'
      + '<div style="flex:1;min-width:0">' + main + mediaHtml(o) + '</div>'
      + (admin ? '<button type="button" class="bhw-x" title="删除这一项"'
        + ' onclick="BIG.hwDelTask(' + si + ',' + ti + ')">' + ico('x', 13) + '</button>' : '')
      + '</div>';
  }

  /* 自适应高度：先归零再读 scrollHeight，字号一变重算一遍（见 applyFs / layoutCards） */
  BIG.autoGrow = function (el){
    if(!el) return;
    el.style.height = 'auto';
    el.style.height = (el.scrollHeight + 2) + 'px';
  };
  function growAll(){
    var arr = document.querySelectorAll('#bhwColA .bhw-area,#bhwColB .bhw-area,#bhwOther .bhw-area');
    for(var i = 0; i < arr.length; i++) BIG.autoGrow(arr[i]);
  }

  function subjCard(it, si, admin){
    var name = String(it.subject || '');
    var tasks = it.tasks || [];
    var st = subjStyle(name);
    var accent = st.c || '#9a3412';
    var head = '<div class="bhw-subj-h">'
      + (admin
          ? '<input class="bhw-in" value="' + attr0(name) + '" placeholder="科目"'
            + ' onchange="BIG.hwSubjName(' + si + ',this.value)"'
            + ' style="flex:none;max-width:7em;font-weight:900;color:' + attr0(accent) + '">'
          : '<b style="color:' + attr0(accent) + '">' + esc0(name) + '</b>')
      + '<span class="bhw-cnt">' + tasks.length + ' 项</span>'
      + (admin ? '<button type="button" class="bhw-x" title="删除这一科"'
          + ' onclick="BIG.hwDelSubj(' + si + ')">' + ico('trash', 13) + '</button>' : '')
      + '</div>';
    var rows = tasks.map(function (t, ti){ return taskHtml(it, si, ti, t, admin); }).join('');
    return '<div class="bhw-subj" style="border-left:4px solid ' + attr0(accent) + '">'
      + head + rows
      + (admin ? '<button type="button" class="bhw-add" onclick="BIG.hwAddTask(' + si + ')">'
          + ico('plus', 12) + ' 添加一项</button>' : '')
      + '</div>';
  }

  BIG.openHw = function (id){
    if(id) BIG.hwId = id;
    /* 大屏作业页是给班级电脑用的。普通模式下（手机常态）打开这条链接，
       不该把人家整台设备静默切成大屏模式 —— 退回「常用服务 → 作业查看」，
       想看大屏就在设置里自己开。 */
    if(!BIG.on){
      try{
        openCat(1);
        setTimeout(function(){ if(typeof locateBoardCard === 'function') locateBoardCard('2'); }, 420);
        toast('未开启大屏模式，已打开作业查看');
      }catch(e){}
      return;
    }
    BIG.hwOn = true;
    document.documentElement.classList.add('big-hw');
    document.documentElement.classList.remove('big-cat');
    var hv = $('homeView'); if(hv) hv.style.display = 'none';
    var grid = $('grid'); if(grid) grid.style.display = 'none';
    var bh = $('bigHome'); if(bh) bh.style.display = 'none';
    var h = $('bigHw'); if(h) h.style.display = 'block';
    try{ setRoute('hw'); }catch(e){}
    applyFs();
    BIG.renderHw();
    startClock();
  };

  BIG.closeHw = function (){
    if(BIG.lockOn) BIG.lockToggle();
    leaveHwUi();
    try{ goHomeView(); }catch(e){}
  };

  BIG.renderHw = function (){
    var h = $('bigHw');
    if(!h) return;
    var hw = currentHw();
    var admin = adminOk();
    var list = hwList();
    var act = $('bhwActions');
    var brand = $('bhwBrand');
    if(brand){
      var nm = '';
      try{
        var h1 = document.querySelector('.content>header h1');
        if(h1) nm = String(h1.textContent || '').trim();
      }catch(e){}
      brand.textContent = nm || '班级服务站';
    }

    /* 期次下拉 + 重命名 + 新建（管理员才有后两个） */
    if(act){
      var sel = '<select class="bhw-sel" onchange="BIG.hwPick(this.value)" title="切换作业期次">'
        + '<option value="">当前作业</option>'
        + list.slice().reverse().map(function (x){
            return '<option value="' + attr0(x.id) + '"'
              + (hw && String(x.id) === String(hw.id) ? ' selected' : '') + '>'
              + esc0(x.title || '未命名') + '</option>';
          }).join('')
        + '</select>';
      act.innerHTML = '<span class="bhw-sync" id="bhwSync"></span>'
        + sel
        + (admin && hw ? '<button type="button" class="bhw-btn ghost" onclick="BIG.hwRename()">重命名</button>' : '')
        + (admin ? '<button type="button" class="bhw-btn ghost" onclick="BIG.hwExport()" title="导出作业文件">导出</button>' : '')
        + (admin ? '<button type="button" class="bhw-btn ghost" onclick="BIG.hwImport()" title="从文件导入作业">导入</button>' : '')
        + (admin ? '<button type="button" class="bhw-btn" onclick="BIG.hwNew()">' + ico('plus', 13) + ' 新建一期</button>' : '');
      syncBadge();
    }

    var colA = $('bhwColA'), colB = $('bhwColB'), other = $('bhwOther'), addHost = $('bhwAddSubj');
    if(!colA || !colB) return;

    if(!hw){
      /* v4.3.0（站主第 4 条）：只按起止日期找「当前」。今天不在任何一期内就明说没有，
         不再拿上一次的作业冒充今天 —— 想看旧的可从右上角下拉里翻。
         空态放主区域正中（原来挂在底部「其他科目」里，一屏看下去只有一条在屏幕最下沿）。 */
      colA.innerHTML = '<div class="bhw-empty bhw-empty-page">'
        + '<b class="bhw-empty-t">当前没有作业</b>'
        + '<span>' + (admin
            ? '当前日期不在任何作业期次范围内。可新建期次，或从下拉列表选择历史期次。'
            : '当前日期无作业安排。')
        + '</span></div>';
      colB.innerHTML = '';
      /* 空态横跨作业那两栏，居中在整块作业区，而不是缩在左三分之一 */
      colA.style.gridColumn = '1 / span 2';
      colB.style.display = 'none';
      if(other) other.innerHTML = '';
      if(addHost) addHost.innerHTML = '';
      renderSide();
      return;
    }
    colA.style.gridColumn = '';
    colB.style.display = '';

    if(hw.title) hw._t = hw.title;
    var items = hw.items || [];

    /* v4.1.0：不再「左三右三」写死。6 科全排进 colA，再交给 layoutCards()
       按真实高度往两栏里塞（怎么省空间怎么排）。其余科目（政治、历史…）进底部。 */
    var mapA = {}, mapB = {}, extras = [];
    items.forEach(function (it, si){
      var nm = String(it.subject || '').trim();
      if(SUBJ_A.indexOf(nm) >= 0) mapA[nm] = { it: it, si: si };
      else if(SUBJ_B.indexOf(nm) >= 0) mapB[nm] = { it: it, si: si };
      else extras.push({ it: it, si: si });
    });

    var mainHtml = '';
    SUBJ_A.concat(SUBJ_B).forEach(function (k){
      var hit = mapA[k] || mapB[k];
      if(hit) mainHtml += subjCard(hit.it, hit.si, admin);
    });
    colA.innerHTML = mainHtml || ('<div class="bhw-subj"><div class="bhw-empty">'
      + (admin ? '暂无科目，可在下方添加。' : '暂时没有作业。') + '</div></div>');
    colB.innerHTML = '';

    if(other){
      other.innerHTML = extras.length
        ? extras.map(function (x){ return subjCard(x.it, x.si, admin); }).join('')
        : '';
    }

    if(addHost){
      addHost.innerHTML = admin
        ? '<input class="bhw-in" id="bhwNewSubj" placeholder="科目名称"'
          + ' onkeydown="if(event.key===\'Enter\')BIG.hwAddSubj()">'
          + '<button type="button" class="bhw-audio" onclick="BIG.hwAddSubj()">' + ico('plus', 14) + ' 添加科目</button>'
          + '<span class="bhw-save" id="bhwSave"></span>'
        : '';
    }

    renderSide();
    scheduleLayout();
  };

  /* —— 卡片排布（v4.1.0）——
     站主要求：像 ClassWorks 那样「怎么省空间怎么排，不需要按顺序排」。
     做法：把两栏的科目卡片收起来 → 量出各自真实高度 → 逐个塞进当前更矮的一栏。
     触发点：渲染完、每次调字号、图片加载完、窗口尺寸变化。 */
  var _layTimer = null;
  function isCard(el){ return !!(el && el.classList && el.classList.contains('bhw-subj')); }
  function sameSeq(a, b){
    if(a.length !== b.length) return false;
    for(var i = 0; i < a.length; i++) if(a[i] !== b[i]) return false;
    return true;
  }
  BIG.layoutCards = function (){
    var colA = $('bhwColA'), colB = $('bhwColB');
    if(!colA || !colB) return;
    /* 正在输入时别搬 DOM：会丢焦点、丢光标位置（站主踩过一次） */
    var ae = document.activeElement;
    if(ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)
      && (colA.contains(ae) || colB.contains(ae))) return;

    var cards = [].slice.call(colA.children).filter(isCard)
      .concat([].slice.call(colB.children).filter(isCard));
    if(cards.length < 2) return;

    /* 窄屏（手机 / 平板竖屏）本来就是单列，拆两栏只会让科目顺序看起来乱 —— 全部塞回一栏 */
    if(window.innerWidth <= 1180){
      if(colB.children.length){
        cards.forEach(function (el){ colA.appendChild(el); });
      }
      cards.forEach(function (el){
        el.style.flexGrow = '0'; el.style.flexShrink = '0'; el.style.flexBasis = 'auto';
      });
      return;
    }

    /* 先取消弹性伸展，量到「内容自然高度」——上一步为了填满屏幕可能把卡片拉高了，
       直接量会把拉伸后的高度当成内容高度，越排越偏。 */
    cards.forEach(function (el){ el.style.flex = '0 0 auto'; });
    void colA.offsetHeight;
    var gap = 10, ha = 0, hb = 0, planA = [], planB = [];
    /* 高的先放、谁矮放谁（LPT 装箱）：比按科目顺序轮流塞更均衡，
       同样 6 张卡两栏高度差能压到几像素，底部留白也就更少。 */
    cards.map(function (el, i){
      return { el: el, h: el.getBoundingClientRect().height, i: i };
    }).sort(function (a, b){ return b.h - a.h || a.i - b.i; })
      .forEach(function (x){
        if(ha <= hb){ planA.push(x); ha += x.h + gap; }
        else { planB.push(x); hb += x.h + gap; }
      });

    var curA = [].slice.call(colA.children).filter(isCard);
    var curB = [].slice.call(colB.children).filter(isCard);
    var wantA = planA.map(function (x){ return x.el; });
    var wantB = planB.map(function (x){ return x.el; });
    if(!(sameSeq(curA, wantA) && sameSeq(curB, wantB))){
      /* appendChild 会把节点从原位置搬过来，按数组顺序追加即得目标次序 */
      wantA.forEach(function (el){ colA.appendChild(el); });
      wantB.forEach(function (el){ colB.appendChild(el); });
    }
    /* 卡片只包住自己的内容（站主 2026-11-04 定）：不再拉伸去填满屏幕，
       富余的竖向空间就空在底部，宁可留白也不让只有一两项的科目撑出一大片。 */
  };

  function scheduleLayout(){
    if(_layTimer) clearTimeout(_layTimer);
    _layTimer = setTimeout(function (){
      _layTimer = null;
      growAll();
      BIG.layoutCards();
    }, 50);
  }
  BIG.relayout = scheduleLayout;

  /* ---------------- 侧栏（v4.3.0 重排） ----------------
     顺序按站主要求：时钟 → 今日事项 → 倒计时（重要日期 / 最近节假日） → 随机点名 → 随机一言（最底）。
     倒计时必须压在点名上面，一言单独放最下面，不再和别的挤在一块。 */
  function renderSide(){
    var c = $('bhwCourses');
    if(c){
      var txt = '', sub = '';
      try{
        if(typeof islandToday === 'function' && typeof ISLAND !== 'undefined' && ISLAND && ISLAND.on){
          var t = islandToday(0);
          if(t){
            if(t.kind === 'holiday') txt = (t.label || '放假中') + ' · 距开学 ' + t.left + ' 天';
            else if(t.kind === 'off') txt = (t.label || '今天休息') + (t.text ? ' · ' + t.text : '');
            else txt = t.text || '今天没有安排';
            sub = '今日事项';
          }
        }
      }catch(e){}
      if(txt){
        c.style.display = '';
        c.innerHTML = '<span class="bhw-mini-k">' + esc0(sub) + '</span>'
          + '<b class="bhw-mini-v">' + esc0(txt) + '</b>';
      }else{
        c.style.display = 'none';
      }
    }
    renderCd();
    renderQuote();
  }

  /* ---------------- 倒计时（v4.3.0） ----------------
     数据直接复用全站的 IMPORTANT_DATES / HOLIDAYS，不再单独配一份：
     站主在后台改了重要日期，大屏这一块跟着变。
     规则（站主原话）：「倒计时没有的话那就空着；节假日倒计时只显示最近的一个」。
       重要日期：取「还没结束」里最早的一条，区间内显示「进行中」；
       节假日：取今天之后最近的一个。
     两个都没有 → 整块隐藏，不留空白盒子。 */
  function cdDays(a, b){
    return Math.max(0, Math.ceil((a.getTime() - b.getTime()) / 86400000));
  }
  function cdLeftText(target, now){
    var sec = Math.floor((target.getTime() - now.getTime()) / 1000);
    if(sec <= 0) return '已开始';
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    if(d > 0) return d + ' 天 ' + h + ' 时';
    if(h > 0) return h + ' 小时 ' + m + ' 分';
    return m + ' 分';
  }
  function cdPick(){
    var now = new Date(), out = { imp: null, hol: null };
    try{
      var arr = (typeof IMPORTANT_DATES !== 'undefined' && Array.isArray(IMPORTANT_DATES)) ? IMPORTANT_DATES : [];
      var best = null;
      arr.forEach(function (d){
        var st = new Date(d.date);
        if(isNaN(st.getTime())) return;
        var en = d.endDate ? new Date(String(d.endDate).slice(0, 10) + 'T23:59:59') : st;
        if(now.getTime() > en.getTime()) return;      /* 已经过去的整条不显示 */
        if(!best || st < best.st) best = { name: d.name || '', st: st, en: en,
          during: !!(d.endDate && now.getTime() >= st.getTime()) };
      });
      out.imp = best;
    }catch(e){}
    try{
      var hs = (typeof HOLIDAYS !== 'undefined' && Array.isArray(HOLIDAYS)) ? HOLIDAYS : [];
      var t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      var bh = null;
      hs.forEach(function (h){
        var d = new Date(String(h.date).slice(0, 10) + 'T00:00:00');
        if(isNaN(d.getTime()) || d < t0) return;
        if(!bh || d < bh.d) bh = { name: h.name || '节假日', d: d, days: h.days };
      });
      out.hol = bh;
    }catch(e){}
    return out;
  }
  function renderCd(){
    var box = $('bhwCd'); if(!box) return;
    var now = new Date(), p = cdPick();
    if(!p.imp && !p.hol){ box.style.display = 'none'; return; }
    box.style.display = '';
    var rows = '';
    if(p.imp){
      rows += '<div class="bhw-cd-row">'
        + '<span class="bhw-cd-n">' + esc0(p.imp.name) + '</span>'
        + '<span class="bhw-cd-v' + (p.imp.during ? ' during' : '') + '">'
        + (p.imp.during ? '进行中' : cdLeftText(p.imp.st, now)) + '</span></div>';
    }
    if(p.hol){
      var left = cdDays(p.hol.d, now);
      rows += '<div class="bhw-cd-row">'
        + '<span class="bhw-cd-n">' + esc0(p.hol.name) + '</span>'
        + '<span class="bhw-cd-v">' + (left <= 0 ? '今天' : '还有 ' + left + ' 天')
        + (p.hol.days ? ' · 假期 ' + p.hol.days + ' 天' : '') + '</span></div>';
    }
    box.innerHTML = '<span class="bhw-mini-k">倒计时</span>' + rows;
  }
  BIG.renderCd = renderCd;

  /* ---------------- 随机一言（v4.3.0） ---------------- */
  function renderQuote(){
    var box = $('bhwQuote'); if(!box) return;
    var q = BIG.quoteData;
    if(!q || !q.text){ box.style.display = 'none'; return; }
    box.style.display = '';
    box.innerHTML =
      '<div class="bhw-q-head">'
        + '<span class="bhw-mini-k">随机一言</span>'
        + '<span class="bhw-q-act">'
          + '<button type="button" class="bhw-q-btn" onclick="event.stopPropagation();BIG.quoteNext(true)">'
            + '换一句 ↻</button>'
          + '<button type="button" class="bhw-q-btn bhw-q-gear" title="自动更换时间"'
            + ' onclick="event.stopPropagation();BIG.quoteCfg()">' + ico('settings', 13) + '</button>'
        + '</span>'
      + '</div>'
      + '<div class="bhw-q-text">' + esc0(q.text) + '</div>'
      + (q.from ? '<div class="bhw-q-from">—— ' + esc0(q.from) + '</div>' : '')
      + '<div class="bhw-q-tip">换一句'
        + (BIG.quoteMin ? ' · 每 ' + BIG.quoteMin + ' 分钟自动换' : ' · 自动更换已关') + '</div>';
  }
  BIG.renderQuote = renderQuote;

  function quoteLocalPick(){
    var list = [];
    try{ if(typeof quoteItems === 'function') list = quoteItems(); }catch(e){}
    if(!list.length){
      try{
        var raw = data().dailyQuote;
        if(typeof raw === 'string' && raw.trim()) list = [{ text: raw.trim(), from: '' }];
        else if(Array.isArray(raw)) list = raw.map(function (x){
          return (typeof x === 'string') ? { text: x, from: '' } : (x && x.text ? { text: x.text, from: x.from || '' } : null);
        }).filter(Boolean);
      }catch(e){}
    }
    if(!list.length) return null;
    var i = Math.floor(Math.random() * list.length);
    if(list.length > 1 && BIG.quoteData && list[i].text === BIG.quoteData.text){
      i = (i + 1) % list.length;
    }
    return list[i];
  }

  /* 联网补一句（hitokoto）。失败就保留本地那句，绝不把卡片清空 ——
     站主要求「断网也能正常用」，这里不能因为一次请求失败就白屏。 */
  var _qFetching = false;
  function quoteNet(){
    try{
      if(_qFetching) return;
      if(typeof navigator !== 'undefined' && navigator.onLine === false) return;
      if(typeof quoteNetAllowed === 'function' && !quoteNetAllowed()) return;
    }catch(e){}
    var cats = ['a', 'b', 'd', 'i'];
    try{ if(typeof quoteCats === 'function') cats = quoteCats(); }catch(e){}
    var qs = cats.map(function (c){ return 'c=' + encodeURIComponent(c); }).join('&');
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var tm = setTimeout(function (){ if(ctrl) ctrl.abort(); }, 6000);
    _qFetching = true;
    fetch('https://v1.hitokoto.cn/?' + qs + '&encode=json', ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (r){ return r.ok ? r.json() : null; })
      .then(function (j){
        clearTimeout(tm); _qFetching = false;
        if(!j || !j.hitokoto) return;
        if(!BIG.hwOn) return;
        /* 站主场景是班级大屏：动画类（c=a）会混进日文台词、韩文歌词，
           后排看着莫名其妙。非中文（假名 / 谚文 / 西里尔）直接丢掉，保留本地那句。 */
        var txt = String(j.hitokoto);
        if(/[\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff]/.test(txt)) return;
        var from = j.from || '';
        if(j.from_who && j.from) from = j.from_who + '《' + j.from + '》';
        else if(j.from_who) from = j.from_who;
        BIG.quoteData = { text: txt, from: String(from || ''), net: 1 };
        renderQuote();
      })
      .catch(function (){ clearTimeout(tm); _qFetching = false; });
  }

  BIG.quoteNext = function (force){
    var p = quoteLocalPick();
    if(p) BIG.quoteData = { text: p.text, from: p.from || '' };
    else if(!BIG.quoteData) BIG.quoteData = { text: '', from: '班级服务站' };
    renderQuote();
    if(force) quoteNet();
  };

  /* 卡片本体点击 = 换一句（原来这块是纯 div，点了完全没反应） */
  BIG.quoteTap = function (e){
    if(e && e.target && e.target.closest && e.target.closest('button')) return;
    BIG.quoteNext(true);
  };

  /* 时钟：精确到秒（站主第 2 条） */
  function startClock(){
    function tick(){
      var t = $('bhwClockT'), s = $('bhwClockS'), b = $('bhwClock');
      if(!t) return;
      var d = new Date();
      function p(n){ return (n < 10 ? '0' : '') + n; }
      t.textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
      var wk = '日一二三四五六'.charAt(d.getDay());
      var week = '';
      try{ if(typeof islandWeekNo === 'function') week = islandWeekNo(); }catch(e){}
      if(s) s.textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + wk + (week ? ' · ' + week : '');
      if(b) b.title = '点击打开全屏时钟';
    }
    tick();
    if(BIG._clockT) clearInterval(BIG._clockT);
    BIG._clockT = setInterval(tick, 1000);

    /* v4.3.0：进了作业页才起这两组定时器 —— 倒计时 30 秒刷一次（天/时粒度，不用每秒重排），
       一言按用户设的分钟数自动换。离开作业页由 leaveHwUi 收掉。 */
    renderCd();
    if(BIG._cdT) clearInterval(BIG._cdT);
    BIG._cdT = setInterval(function (){ if(BIG.hwOn) renderCd(); }, 30000);
    if(!BIG.quoteData) BIG.quoteNext(false);
    BIG.quoteAuto();
  }

  function stopHwTimers(){
    if(BIG._cdT){ clearInterval(BIG._cdT); BIG._cdT = null; }
    if(BIG._quoteT){ clearInterval(BIG._quoteT); BIG._quoteT = null; }
  }

  BIG.openClock = function (){
    try{ rememberView(); }catch(e){}
    /* v4.4.0（站主第 3 条）：记下「从哪儿点的时钟」，返回时原路回去。
       作业看板点进来 → 返回作业看板；首页点进来 → 回首页。
       原来的返回写死 ./index.html，从作业页进去再回来就掉到首页了。 */
    try{ sessionStorage.setItem('cls_clock_from', BIG.hwOn ? 'hw' : 'home'); }catch(e){}
    location.href = './clock.html';
  };

  BIG.hwPick = function (v){
    BIG.hwId = v || null;
    BIG.renderHw();
    try{ setRoute('hw' + (v ? '/' + encodeURIComponent(v) : '')); }catch(e){}
  };

  BIG.markSaved = function (txt){ markSaved(txt); };
  function markSaved(txt){
    var s = $('bhwSave');
    if(!s) return;
    s.textContent = txt;
    s.style.color = txt.indexOf('失败') >= 0 ? '#b91c1c' : '';
  }

  function persist(){
    if(!adminOk()) return;
    var list = hwList();
    try{
      if(typeof saveContentLocal === 'function') saveContentLocal('holiday_homeworks', list);
    }catch(e){}
    try{
      pushCloudContent({ holiday_homeworks: list }, true).then(function (r){
        if(r && r.ok) markSaved('已同步云端');
        else markSaved('同步失败：' + ((r && r.error) || '未知原因') + '（已存本机）');
        syncBadge();
      }).catch(function (e){
        markSaved('同步失败：' + (e && e.message || e) + '（已存本机）');
        syncBadge();
      });
    }catch(e){}
  }
  function touch(){
    markSaved('正在保存…');
    if(BIG._saveT) clearTimeout(BIG._saveT);
    BIG._saveT = setTimeout(function (){ BIG._saveT = null; persist(); }, 700);
  }
  BIG.touch = touch;

  function hwObj(){
    var hw = currentHw();
    if(!hw) return null;
    if(!hw.items) hw.items = [];
    return hw;
  }

  BIG.hwSubjName = function (si, v){
    var hw = hwObj(); if(!hw || !hw.items[si]) return;
    hw.items[si].subject = String(v || '').trim();
    touch();
    BIG.renderHw();
  };
  BIG.hwTask = function (si, ti, v){
    var hw = hwObj(); if(!hw || !hw.items[si]) return;
    var arr = hw.items[si].tasks || [];
    if(ti < 0 || ti >= arr.length) return;
    var old = arr[ti];
    if(old && typeof old === 'object') old.text = String(v || '');
    else arr[ti] = String(v || '');
    touch();
  };
  BIG.hwAddTask = function (si){
    var hw = hwObj(); if(!hw || !hw.items[si]) return;
    hw.items[si].tasks = hw.items[si].tasks || [];
    hw.items[si].tasks.push('');
    BIG.renderHw();
    touch();
  };
  BIG.hwDelTask = function (si, ti){
    var hw = hwObj(); if(!hw || !hw.items[si]) return;
    var arr = hw.items[si].tasks || [];
    if(ti < 0 || ti >= arr.length) return;
    arr.splice(ti, 1);
    BIG.renderHw();
    touch();
  };
  BIG.hwDelSubj = function (si){
    var hw = hwObj(); if(!hw || !hw.items[si]) return;
    if(!confirm('删除「' + (hw.items[si].subject || '这一科') + '」以及它下面的所有作业？')) return;
    hw.items.splice(si, 1);
    BIG.renderHw();
    touch();
  };
  BIG.hwAddSubj = function (){
    var hw = hwObj(); if(!hw) return;
    var el = $('bhwNewSubj');
    var name = el ? String(el.value || '').trim() : '';
    if(!name){ toast('请填写科目名称', true); if(el) el.focus(); return; }
    var dup = (hw.items || []).some(function (x){ return String(x.subject || '').trim() === name; });
    if(dup){ toast('已存在「' + name + '」这一科了', true); return; }
    hw.items.push({ subject: name, tasks: [''] });
    BIG.renderHw();
    touch();
  };

  /* —— 新建 / 重命名（站主第 1 条）—— */
  var FORM = { mode: 'new', subjects: PRESET_SUBJECTS.slice() };
  function formSubjHtml(){
    var host = $('bhwFormSubj');
    if(!host) return;
    if(FORM.mode !== 'new'){ host.innerHTML = ''; host.style.display = 'none'; return; }
    host.style.display = '';
    host.innerHTML = '<span class="bhw-form-subj-k">预设科目</span>'
      + PRESET_SUBJECTS.map(function (s){
          var on = FORM.subjects.indexOf(s) >= 0;
          return '<button type="button" class="bhw-chip' + (on ? ' on' : '') + '"'
            + ' onclick="BIG.formSubjToggle(\'' + s + '\')">' + esc0(s) + '</button>';
        }).join('');
  }
  BIG.formSubjToggle = function (s){
    var i = FORM.subjects.indexOf(s);
    if(i >= 0) FORM.subjects.splice(i, 1); else FORM.subjects.push(s);
    formSubjHtml();
  };
  BIG.hwNew = function (){
    if(!adminOk()){ toast('仅管理员可新建作业', true); return; }
    FORM.mode = 'new';
    FORM.subjects = PRESET_SUBJECTS.slice();
    var t = $('bhwFormTitle'); if(t) t.textContent = '新建一期作业';
    var d = todayStr();
    var n = $('bhwFormName'), st = $('bhwFormStart'), en = $('bhwFormEnd');
    if(n) n.value = '';
    if(st) st.value = d;
    if(en) en.value = d;
    formSubjHtml();
    var m = $('bhwFormMask'); if(m) m.classList.add('show');
    setTimeout(function(){ if(n) n.focus(); }, 60);
  };
  BIG.hwRename = function (){
    if(!adminOk()) return;
    var hw = currentHw(); if(!hw){ toast('暂无可重命名的期次', true); return; }
    FORM.mode = 'rename';
    var t = $('bhwFormTitle'); if(t) t.textContent = '重命名这一期';
    var n = $('bhwFormName'), st = $('bhwFormStart'), en = $('bhwFormEnd');
    if(n) n.value = plain(hw.title || '');
    if(st) st.value = hw.start || '';
    if(en) en.value = hw.end || '';
    formSubjHtml();
    var m = $('bhwFormMask'); if(m) m.classList.add('show');
    setTimeout(function(){ if(n){ n.focus(); n.select(); } }, 60);
  };
  BIG.formClose = function (){
    var m = $('bhwFormMask'); if(m) m.classList.remove('show');
  };

  /* ---------------- 换字体弹窗（v4.3.0） ---------------- */
  BIG.fontOpen = function (){
    var body = $('bhwFontBody');
    if(body){
      body.innerHTML = FONTS.map(function (f){
        return '<button type="button" class="bhw-font-item' + (f.id === BIG.font ? ' on' : '') + '"'
          + ' style="font-family:' + f.stack + '" onclick="BIG.fontSet(\'' + f.id + '\')">'
          + '<span class="bhw-font-name">' + esc0(f.name) + '</span>'
          + '<span class="bhw-font-demo">作业预览 Aa 123</span>'
          + '<span class="bhw-font-desc">' + esc0(f.desc) + '</span>'
          + '</button>';
      }).join('');
    }
    var m = $('bhwFontMask'); if(m) m.classList.add('show');
  };
  BIG.fontClose = function (){
    var m = $('bhwFontMask'); if(m) m.classList.remove('show');
  };

  /* ---------------- 一言轮换间隔弹窗（v4.3.0） ---------------- */
  BIG.quoteCfg = function (){
    var body = $('bhwQuoteBody');
    var opts = [
      { n: 1, t: '每 1 分钟' }, { n: 3, t: '每 3 分钟' }, { n: 5, t: '每 5 分钟（默认）' },
      { n: 10, t: '每 10 分钟' }, { n: 30, t: '每 30 分钟' }, { n: 0, t: '仅手动' }
    ];
    if(body){
      body.innerHTML = opts.map(function (o){
        return '<button type="button" class="bhw-opt' + (o.n === BIG.quoteMin ? ' on' : '') + '"'
          + ' onclick="BIG.quoteSetMin(' + o.n + ')">' + o.t + '</button>';
      }).join('');
    }
    var m = $('bhwQuoteMask'); if(m) m.classList.add('show');
  };
  BIG.quoteClose = function (){
    var m = $('bhwQuoteMask'); if(m) m.classList.remove('show');
  };
  BIG.formSave = function (){
    var n = $('bhwFormName'), st = $('bhwFormStart'), en = $('bhwFormEnd');
    var name = n ? String(n.value || '').trim() : '';
    if(!name){ toast('期次名称', true); if(n) n.focus(); return; }
    var s0 = st ? String(st.value || '') : '';
    var e0 = en ? String(en.value || '') : '';
    if(s0 && e0 && e0 < s0){ toast('结束日期不能早于开始日期', true); return; }
    if(FORM.mode === 'new'){
      var list = hwList();
      var id = 'hw' + Date.now();
      var picked = FORM.subjects && FORM.subjects.length ? FORM.subjects : PRESET_SUBJECTS.slice();
      list.push({
        id: id, title: name,
        start: s0 || todayStr(), end: e0 || s0 || todayStr(),
        /* v4.3.0（站主第 1 条）：新建时直接把六科预设带上，每科先放一个空项，
           打开就能写，不用再一科一科「添加科目」。不需要的科目点卡片右上角垃圾桶删掉。 */
        items: picked.map(function (s){ return { subject: s, tasks: [''] }; }),
      });
      BIG.hwId = id;
      toast('已创建，六科科目已预设');
    }else{
      var hw = currentHw();
      if(!hw){ toast('找不到这一期', true); return; }
      hw.title = name;
      if(s0) hw.start = s0;
      if(e0) hw.end = e0;
      toast('名称已更新');
    }
    BIG.formClose();
    BIG.renderHw();
    persist();
  };

  /* ---------------- 导出 / 导入（v4.2.0） ----------------
     站主原话：「我们班电脑可能没网……我在班级电脑上新增了一天的作业，
     就可以导出所有数据，或者只导出今天这一期；拿到家里那台有网的电脑上
     导入，它就可以自动上传到云端，作业就同步了。」

     设计取舍：
       · 只做 JSON。结构自描述（带 kind / ver / exportedAt），另一台设备能认出来，
         用记事本也能看；纯 text 无法区分「这是哪一期的第几项」。
       · 导入兼容三种写法：纯数组 / {homeworks:[…]} / {items:{holiday_homeworks:…}}，
         手写或从后台复制过来的都能吃。
       · 合并规则按 id：同 id 覆盖（说明是同一期在两台机器上都改过，以导入的为准），
         新 id 追加。绝不因为 id 重复就整份丢掉。
       · 导入完立刻推云端；推不上去就靠「待上传」队列，联网后自动补（见 app.js）。 */
  var IO = { mode: 'export' };

  function syncBadge(){
    var el = $('bhwSync'); if(!el) return;
    var pending = false, off = false;
    try{ pending = (typeof hasPendingContentSync === 'function') && hasPendingContentSync(); }catch(e){}
    try{ off = (navigator.onLine === false); }catch(e){}
    if(off){ el.className = 'bhw-sync off'; el.innerHTML = '<i></i>离线 · 存本机'; }
    else if(pending){ el.className = 'bhw-sync pend'; el.innerHTML = '<i></i>待上传'; }
    else { el.className = 'bhw-sync'; el.innerHTML = '<i></i>已同步'; }
  }
  BIG.syncBadge = syncBadge;
  try{
    window.addEventListener('online', function (){ syncBadge(); });
    window.addEventListener('offline', function (){ syncBadge(); });
  }catch(e){}

  function stampText(){
    var d = new Date();
    function p(n){ return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function stampFile(){
    var d = new Date();
    function p(n){ return (n < 10 ? '0' : '') + n; }
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function ioOpen(mode){
    IO.mode = mode;
    var m = $('bhwIoMask'); if(!m) return;
    m.classList.add('show');
  }
  BIG.ioClose = function (){
    var m = $('bhwIoMask'); if(m) m.classList.remove('show');
  };

  BIG.hwExport = function (){
    if(!adminOk()){ toast('仅管理员可导出', true); return; }
    var list = hwList();
    if(!list.length){ toast('暂无可导出的作业', true); return; }
    var t = $('bhwIoTitle'); if(t) t.textContent = '导出作业';
    var tip = $('bhwIoTip');
    if(tip) tip.textContent = '选择需导出的内容，生成 JSON 文件；在联网设备导入后自动同步至云端。';
    var ok = $('bhwIoOk'); if(ok){ ok.textContent = '导出所选'; ok.style.display = ''; }
    var body = $('bhwIoBody');
    if(body){
      body.innerHTML = '<label class="bhw-io-all"><input type="checkbox" id="bhwIoAll" checked'
        + ' onchange="BIG.ioAll(this.checked)"> 全选（' + list.length + ' 期）</label>'
        + list.slice().reverse().map(function (x){
            var n = (x.items || []).length;
            var cnt = 0;
            (x.items || []).forEach(function (it){ cnt += (it.tasks || []).length; });
            var meta = n + ' 科 · ' + cnt + ' 项' + (x.end ? ' · 至 ' + x.end : '');
            return '<label class="bhw-io-item">'
              + '<input type="checkbox" class="bhw-io-ck" data-id="' + attr0(x.id) + '" checked'
              + ' onchange="BIG.ioOne()">'
              + '<span class="bhw-io-name">' + esc0(x.title || '未命名') + '</span>'
              + '<span class="bhw-io-meta">' + esc0(meta) + '</span>'
              + '</label>';
          }).join('');
    }
    ioOpen('export');
  };

  BIG.ioAll = function (on){
    var arr = document.querySelectorAll('#bhwIoBody .bhw-io-ck');
    for(var i = 0; i < arr.length; i++) arr[i].checked = !!on;
  };
  BIG.ioOne = function (){
    var arr = [].slice.call(document.querySelectorAll('#bhwIoBody .bhw-io-ck'));
    var all = $('bhwIoAll');
    if(!all) return;
    var n = 0;
    arr.forEach(function (c){ if(c.checked) n++; });
    all.checked = (n === arr.length && n > 0);
    all.indeterminate = (n > 0 && n < arr.length);
  };

  function saveBlob(name, text){
    try{
      var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function (){
        try{ document.body.removeChild(a); }catch(e){}
        try{ URL.revokeObjectURL(url); }catch(e){}
      }, 1200);
      return true;
    }catch(e){
      /* 老浏览器不支持 download：退回复制到剪贴板之外的方案 —— 直接弹一段可复制的文本 */
      try{ toast('当前设备不支持文件下载，请使用导入功能', true); }catch(e2){}
      return false;
    }
  }

  function doExport(){
    var list = hwList();
    var ids = {};
    var arr = [].slice.call(document.querySelectorAll('#bhwIoBody .bhw-io-ck'));
    arr.forEach(function (c){ if(c.checked) ids[String(c.getAttribute('data-id'))] = 1; });
    var picked = list.filter(function (x){ return ids[String(x.id)]; });
    if(!picked.length){ toast('请至少选择一期', true); return; }
    var payload = {
      app: '25级05班班级服务站',
      kind: 'holiday_homeworks',
      ver: 1,
      siteVersion: (typeof SITE_VERSION !== 'undefined' ? SITE_VERSION : ''),
      exportedAt: stampText(),
      homeworks: picked,
    };
    var all = (picked.length === list.length);
    var tag = all ? '全部'
      : (picked.length === 1 ? String(picked[0].title || '单期').replace(/[\\/:*?"<>|]/g, '') : ('部分' + picked.length + '期'));
    var nm = '班级作业-' + tag + '-' + stampFile() + '.json';
    if(saveBlob(nm, JSON.stringify(payload, null, 2))){
      BIG.ioClose();
      toast('已导出 ' + picked.length + ' 期（' + nm + '）');
    }
  }

  BIG.hwImport = function (){
    if(!adminOk()){ toast('仅管理员可导入', true); return; }
    var t = $('bhwIoTitle'); if(t) t.textContent = '导入作业';
    var tip = $('bhwIoTip');
    if(tip) tip.textContent = '选择此前导出的 JSON 文件，或粘贴文件内容。导入后自动同步至云端；失败时暂存本机，联网后自动补传。';
    var ok = $('bhwIoOk'); if(ok){ ok.textContent = '导入'; ok.style.display = ''; }
    var body = $('bhwIoBody');
    if(body){
      body.innerHTML = ''
        + '<div class="bhw-io-file">'
        + '<button type="button" onclick="document.getElementById(\'bhwIoFile\').click()">选择 JSON 文件</button>'
        + '<span id="bhwIoFileName">未选择文件</span>'
        + '</div>'
        + '<input type="file" id="bhwIoFile" accept=".json,application/json,text/plain"'
        + ' style="display:none" onchange="BIG.ioFile(this)">'
        + '<p class="bhw-io-tip" style="margin:0 0 6px">或粘贴文件内容：</p>'
        + '<textarea id="bhwIoText" placeholder="粘贴 JSON 内容"></textarea>';
    }
    ioOpen('import');
  };

  BIG.ioFile = function (inp){
    var f = inp && inp.files && inp.files[0];
    if(!f) return;
    var lab = $('bhwIoFileName');
    if(lab) lab.textContent = f.name + '（' + Math.max(1, Math.round(f.size / 1024)) + ' KB）';
    var r = new FileReader();
    r.onload = function (){
      var ta = $('bhwIoText');
      if(ta) ta.value = String(r.result || '');
    };
    r.onerror = function (){ toast('文件无法读取，请更换文件', true); };
    r.readAsText(f, 'utf-8');
  };

  /* 把各种可能的导入写法统一成「作业数组」 */
  function parseImport(txt){
    var obj = JSON.parse(txt);
    var arr = null;
    if(Array.isArray(obj)) arr = obj;
    else if(obj && Array.isArray(obj.homeworks)) arr = obj.homeworks;
    else if(obj && obj.items && obj.items.holiday_homeworks !== undefined){
      var v = obj.items.holiday_homeworks;
      arr = (typeof v === 'string') ? JSON.parse(v) : v;
    }else if(obj && Array.isArray(obj.holidayHomeworks)) arr = obj.holidayHomeworks;
    if(!Array.isArray(arr)) throw new Error('文件格式错误：未找到作业数据');
    return arr;
  }

  /* 只保留认识的字段，请勿乱七八糟的东西塞进云端 */
  function cleanHw(h){
    if(!h || typeof h !== 'object') return null;
    var items = [];
    (Array.isArray(h.items) ? h.items : []).forEach(function (it){
      if(!it || typeof it !== 'object') return;
      var tasks = [];
      (Array.isArray(it.tasks) ? it.tasks : []).forEach(function (t){
        if(t === null || t === undefined) return;
        if(typeof t === 'object'){
          var o = { text: String(t.text == null ? '' : t.text) };
          if(t.img) o.img = String(t.img);
          if(t.audio) o.audio = String(t.audio);
          if(t.video) o.video = String(t.video);
          if(t.audioLabel) o.audioLabel = String(t.audioLabel);
          tasks.push(o);
        }else{
          tasks.push(String(t));
        }
      });
      items.push({ subject: String(it.subject || '').trim(), tasks: tasks });
    });
    return {
      id: String(h.id || ('hw' + Date.now() + Math.floor(Math.random() * 1000))),
      title: String(h.title || '未命名'),
      start: String(h.start || ''),
      end: String(h.end || ''),
      items: items,
    };
  }

  function doImport(){
    var ta = $('bhwIoText');
    var txt = ta ? String(ta.value || '').trim() : '';
    if(!txt){ toast('请选择文件或粘贴内容', true); return; }
    var arr;
    try{
      arr = parseImport(txt);
    }catch(e){
      toast('内容解析失败：' + (e && e.message || e), true);
      return;
    }
    var list = hwList();
    var add = 0, upd = 0, bad = 0;
    arr.forEach(function (raw){
      var rec = cleanHw(raw);
      if(!rec){ bad++; return; }
      var hit = -1;
      for(var i = 0; i < list.length; i++){
        if(String(list[i].id) === String(rec.id)){ hit = i; break; }
      }
      if(hit >= 0){ list[hit] = rec; upd++; }
      else { list.push(rec); add++; }
    });
    if(!add && !upd){ toast('文件中无有效作业', true); return; }

    /* 导入完把视图切到「最近导入的那一期」，让人马上看到结果 */
    if(arr.length){
      var last = cleanHw(arr[arr.length - 1]);
      if(last) BIG.hwId = last.id;
    }
    BIG.ioClose();
    BIG.renderHw();
    persist();
    var msg = '导入完成，新增 ' + add + ' 期' + (upd ? '，更新 ' + upd + ' 期' : '') + (bad ? '，跳过 ' + bad + ' 条' : '');
    toast(msg);
    setTimeout(function (){ syncBadge(); }, 1600);
  }

  BIG.ioOk = function (){
    if(IO.mode === 'import') doImport();
    else doExport();
  };

  /* ---------------- 随机点名（v4.0.0 重做） ----------------
     站主 2026-11-03（第 6 条）原话大意：
       · 默认只抽学生（后台里那种「学生 / 老师 / 管理员」标签）
       · 学号可以设一个范围
       · 能按「本次总分第几名」「单科第几名 / 多少分」这些条件抽
       · 能按性别抽
       · 名单设置里点击「请假」不要跳回最上面
     实现：
       · 名单改用 /profile?action=roster 的 students（带学号、身份、性别），
         拿不到就退回老的姓名列表 —— 老设备/未登录也不至于空着。
       · 成绩条件读 /scores?action=list + action=board，前端算班级排名
         （总分 = 各科赋分优先，排名并列同名次）。
       · 条件存在本机 localStorage，班级电脑下次打开还是上次那一套。
     ⚠️ 滚动位置：以前点击就把整块 innerHTML 重绘，滚动条自然回到顶部。
        现在只改被点的那一个按钮 + 顶部计数，DOM 不动，位置就不会跳。 */

  var EX_KEY = 'cls_big_pick_ex';      /* { 姓名: 'leave' | 'out' } */
  var F_KEY  = 'cls_big_pick_f';       /* 抽取条件，只存本机 */

  var F_DEF = { role: ['学生'], gender: '', sidMin: '', sidMax: '', examId: '', metric: '', subj: '', min: '', max: '' };

  function loadEx(){
    try{ return JSON.parse(localStorage.getItem(EX_KEY) || '{}') || {}; }catch(e){ return {}; }
  }
  function saveEx(o){
    try{ localStorage.setItem(EX_KEY, JSON.stringify(o)); }catch(e){}
  }

  /* ---------------- 抽取历史（v4.4.0 站主第 4 条） ----------------
     站主要求：「可以看到历史记录，具体是时间点、条件、抽取人数以及具体的抽取人员。
              然后我可以在下面写备注，就说这次是用来干嘛的，需要上传云端」
     存储：本机 localStorage 是真源（断网也能写），同时整包推云端 pick_history。
           云端走 /api/content，只有管理员 token 能写 —— 班级电脑上登的是管理员，够用。
     合并：本机 ∪ 云端，按 id 去重、时间倒序。这样换设备也能看到别人抽过的记录。 */
  var PH_KEY = 'cls_pick_hist';
  var PH_MAX = 300;
  function phLocal(){
    var a = [];
    try{ a = JSON.parse(localStorage.getItem(PH_KEY) || '[]'); }catch(e){ a = []; }
    return Array.isArray(a) ? a : [];
  }
  function phMerge(){
    var map = {}, out = [];
    function add(x){
      if(!x || !x.id || map[x.id]) return;
      map[x.id] = 1;
      out.push({
        id: String(x.id),
        at: Number(x.at) || 0,
        cond: String(x.cond || ''),
        n: Number(x.n) || (Array.isArray(x.names) ? x.names.length : 0),
        names: Array.isArray(x.names) ? x.names.map(String) : [],
        note: String(x.note || ''),
      });
    }
    phLocal().forEach(add);
    try{
      var d = data();
      if(d && Array.isArray(d.pickHistory)) d.pickHistory.forEach(add);
    }catch(e){}
    out.sort(function (a, b){ return b.at - a.at; });
    return out.slice(0, PH_MAX);
  }
  function phSave(list, push){
    try{ localStorage.setItem(PH_KEY, JSON.stringify(list)); }catch(e){}
    if(push === false) return;
    /* 没登录 / 不是管理员就只落本机，等下次有人登管理员再说（列表本身会一起带上） */
    try{
      if(typeof pushCloudContent === 'function' && adminOk()){
        pushCloudContent({ pick_history: list }, true);
      }
    }catch(e){}
  }
  function phAdd(names){
    var list = phMerge();
    var rec = {
      id: 'pk' + Date.now() + Math.floor(Math.random() * 1000),
      at: Date.now(),
      cond: condText(),
      n: names.length,
      names: names.slice(),
      note: '',
    };
    list.unshift(rec);
    list = list.slice(0, PH_MAX);
    phSave(list);
    BIG.pick.rec = rec;
    return rec;
  }
  function phTime(ts){
    var d = new Date(ts || 0);
    function p(n){ return (n < 10 ? '0' : '') + n; }
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  /* 备注：边打边存本机，松手 800ms 后再推云端，避免每敲一个字打一次接口 */
  BIG.pickNote = function (val){
    var p = BIG.pick, id = p.noteFor;
    if(!id) return;
    var list = phMerge(), hit = null;
    for(var i = 0; i < list.length; i++) if(list[i].id === id){ hit = list[i]; break; }
    if(!hit) return;
    hit.note = String(val || '').slice(0, 120);
    if(p.rec && p.rec.id === id) p.rec.note = hit.note;
    phSave(list, false);
    if(BIG._noteT) clearTimeout(BIG._noteT);
    BIG._noteT = setTimeout(function (){ phSave(phMerge()); }, 800);
  };
  BIG.pickHist = function (){
    BIG.pick.state = (BIG.pick.state === 'hist') ? 'setup' : 'hist';
    BIG.pickBody();
  };
  BIG.pickHistDel = function (id){
    if(!confirm('删除该条抽取记录？删除后无法恢复。')) return;
    var list = phMerge().filter(function (x){ return x.id !== id; });
    phSave(list);
    BIG.pickBody();
  };

  function loadF(){
    var f = null;
    try{ f = JSON.parse(localStorage.getItem(F_KEY) || 'null'); }catch(e){}
    if(!f || typeof f !== 'object') f = {};
    var out = {};
    for(var k in F_DEF) out[k] = (f[k] === undefined ? F_DEF[k] : f[k]);
    if(!Array.isArray(out.role)) out.role = ['学生'];
    return out;
  }
  function saveF(){
    try{ localStorage.setItem(F_KEY, JSON.stringify(BIG.pick.f)); }catch(e){}
  }

  /* 名单：优先云端（带学号/身份/性别），失败退回站内姓名列表 */
  function loadRoster(done){
    function fallback(){
      var names = [];
      try{ if(typeof classList === 'function') names = classList() || []; }catch(e){}
      var seen = {}, out = [];
      names.forEach(function (x){
        var n = String(x || '').trim();
        if(!n || seen[n]) return;
        seen[n] = 1;
        out.push({ name: n, studentId: '', role: '学生', gender: '', title: '' });
      });
      BIG.pick.roster = out;
      if(done) done();
    }
    try{
      if(typeof api === 'function'){
        api('/profile?action=roster').then(function (j){
          var arr = (j && j.students) || [];
          if(!arr.length){ fallback(); return; }
          var seen = {}, out = [];
          arr.forEach(function (x){
            var n = String((x && x.name) || '').trim();
            if(!n || seen[n]) return;
            seen[n] = 1;
            out.push({
              name: n,
              studentId: String(x.studentId || ''),
              role: String(x.role || '学生'),
              gender: String(x.gender || ''),
              /* v4.4.2：头衔（班长 / 团支书 / 语文课代表…），抽班干部、课代表靠它 */
              title: String(x.title || ''),
            });
          });
          BIG.pick.roster = out;
          if(done) done();
        }).catch(fallback);
        return;
      }
    }catch(e){}
    fallback();
  }

  /* 成绩：考试列表 + 某次考试的班级排名（总分 / 单科，分数 / 名次） */
  function loadExams(done){
    if(BIG.pick.exams) { if(done) done(); return; }
    try{
      if(typeof api !== 'function'){ BIG.pick.exams = []; if(done) done(); return; }
      api('/scores?action=list').then(function (j){
        BIG.pick.exams = (j && j.exams) || [];
        if(done) done();
      }).catch(function (){ BIG.pick.exams = []; if(done) done(); });
    }catch(e){ BIG.pick.exams = []; if(done) done(); }
  }

  /* v4.1.0：名次一律按**本班**算。
     成绩表里可能是全年级的行（站主：「排名只看本班不看年级」），
     所以先按班级名册收敛，再在班内排名。名册为空时（没登录 / 读不到）退回全班表。 */
  function rosterSet(){
    var arr = BIG.pick.roster || [];
    if(!arr.length) return null;
    var s = {};
    arr.forEach(function (x){
      var n = String((x && x.name) || '').trim();
      if(n) s[n] = 1;
    });
    return s;
  }

  function statOf(examId, done){
    if(!examId){ BIG.pick.stat = null; BIG.pick.prog = null; if(done) done(); return; }
    if(BIG.pick.stat && String(BIG.pick.stat.id) === String(examId)){ afterStat(done); return; }
    BIG.pick.prog = null;
    var cache = BIG.pick.statCache || (BIG.pick.statCache = {});
    var key = String(examId);
    if(cache[key]){ BIG.pick.stat = cache[key]; afterStat(done); return; }
    try{
      if(typeof api !== 'function'){ if(done) done(); return; }
      api('/scores?action=board&exam=' + encodeURIComponent(examId)).then(function (j){
        cache[key] = buildStat(j);
        BIG.pick.stat = cache[key];
        afterStat(done);
      }).catch(function (){ BIG.pick.stat = null; BIG.pick.prog = null; if(done) done(); });
    }catch(e){ if(done) done(); }
  }

  /* 「进步排名」要用上一次考试做基准：列表按日期倒序，当前这一场的下一项就是上一场。 */
  function needProg(m){ return m === 'totalProgress' || m === 'subProgress'; }

  function prevExamId(){
    var arr = BIG.pick.exams || [], id = String((BIG.pick.f || {}).examId || '');
    if(!id) return null;
    for(var i = 0; i < arr.length; i++){
      if(String(arr[i].id) === id) return arr[i + 1] ? String(arr[i + 1].id) : null;
    }
    return null;
  }

  function loadPrevStat(done){
    /* 考试列表还没到就先去拿，否则「上一次是哪一场」无从判断 */
    if(!BIG.pick.exams){ loadExams(function (){ loadPrevStat(done); }); return; }
    var pid = prevExamId();
    BIG.pick.progNoPrev = false;
    if(!pid){ BIG.pick.prevStat = null; BIG.pick.progNoPrev = true; if(done) done(); return; }
    var cache = BIG.pick.statCache || (BIG.pick.statCache = {});
    if(cache[pid]){ BIG.pick.prevStat = cache[pid]; if(done) done(); return; }
    try{
      if(typeof api !== 'function'){ if(done) done(); return; }
      api('/scores?action=board&exam=' + encodeURIComponent(pid)).then(function (j){
        cache[pid] = buildStat(j);
        BIG.pick.prevStat = cache[pid];
        if(done) done();
      }).catch(function (){ BIG.pick.prevStat = null; if(done) done(); });
    }catch(e){ if(done) done(); }
  }

  function afterStat(done){
    var f = BIG.pick.f || F_DEF;
    if(!needProg(f.metric)){ BIG.pick.prog = null; if(done) done(); return; }
    if(BIG.pick.prog){ if(done) done(); return; }
    loadPrevStat(function (){ calcProg(); if(done) done(); });
  }

  /* 进步 = 上一次班级名次 − 这一次班级名次（正数 = 往前走了几名）。
     再按进步幅度在班里排个名次（1 = 进步最多），供「进步排名」条件用。 */
  function calcProg(){
    var cur = BIG.pick.stat, prev = BIG.pick.prevStat;
    if(!cur || !prev){ BIG.pick.prog = null; return; }
    var keys = (cur.subjects || []).map(function (s){ return s.key; });
    var rows = [];
    (cur.rows || []).forEach(function (r){
      var p = prev.byName[r.name];
      if(!p) return;
      var o = { name: r.name, total: null, sub: {}, subRank: {} };
      if(p.totalRank != null && r.totalRank != null) o.total = p.totalRank - r.totalRank;
      keys.forEach(function (k){
        var a = (p.sub[k] || {}).rank, b = (r.sub[k] || {}).rank;
        o.sub[k] = (a != null && b != null) ? (a - b) : null;
      });
      rows.push(o);
    });
    function rankBy(val, set){
      var arr = rows.map(function (x){ return { x: x, v: val(x) }; })
        .filter(function (o){ return o.v != null && isFinite(o.v); })
        .sort(function (a, b){ return b.v - a.v; });
      var last = null, rk = 0;
      arr.forEach(function (o, i){
        if(last === null || o.v !== last){ rk = i + 1; last = o.v; }
        set(o.x, rk);
      });
    }
    rankBy(function (x){ return x.total; }, function (x, k){ x.totalRank = k; });
    keys.forEach(function (k){
      rankBy(function (x){ return x.sub[k]; }, function (x, k2){ x.subRank[k] = k2; });
    });
    var byName = {};
    rows.forEach(function (x){ if(!byName[x.name]) byName[x.name] = x; });
    BIG.pick.prog = { rows: rows, byName: byName };
  }

  /* 把一次考试的成绩表算成「谁总分多少名、某科多少分多少名」 */
  function buildStat(board){
    if(!board || !board.rows) return null;
    var exam = board.exam || {};
    var subs = (exam.subjects || []).map(function (s){
      return { key: String(s.key || ''), name: String(s.name || s.key || '') };
    }).filter(function (s){ return s.key; });
    /* 只留本班的学生：年级大表里的外班行一律丢掉，后面的排名自然就是班级名次 */
    var inClass = rosterSet();
    var rows = (board.rows || []).map(function (r){
      return { name: String(r.name || '').trim(), s: r.s || {}, total: 0, totalRank: null, sub: {} };
    }).filter(function (r){
      if(!r.name) return false;
      return inClass ? !!inClass[r.name] : true;
    });
    function scoreOf(v){
      if(v == null) return null;
      if(typeof v === 'object'){ var x = (v.assigned != null ? v.assigned : v.raw); return (x == null || x === '' || isNaN(Number(x))) ? null : Number(x); }
      return isNaN(Number(v)) ? null : Number(v);
    }
    rows.forEach(function (r){
      var t = 0, any = false;
      subs.forEach(function (sb){
        var v = scoreOf(r.s[sb.key]);
        r.sub[sb.key] = { score: v, rank: null };
        if(v != null){ t += v; any = true; }
      });
      r.total = any ? t : null;
    });
    function rank(list, val, set){
      var arr = list.map(function (x){ return { x: x, v: val(x) }; })
        .filter(function (o){ return o.v != null && isFinite(o.v); })
        .sort(function (a, b){ return b.v - a.v; });
      var last = null, rank = 0;
      arr.forEach(function (o, i){
        if(last === null || o.v !== last){ rank = i + 1; last = o.v; }
        set(o.x, rank);
      });
    }
    rank(rows, function (r){ return r.total; }, function (r, k){ r.totalRank = k; });
    subs.forEach(function (sb){
      rank(rows, function (r){ return (r.sub[sb.key] || {}).score; }, function (r, k){
        if(r.sub[sb.key]) r.sub[sb.key].rank = k;
      });
    });
    var byName = {};
    rows.forEach(function (r){ if(r.name && !byName[r.name]) byName[r.name] = r; });
    return { id: exam.id, name: exam.name || '', subjects: subs, rows: rows, byName: byName };
  }

  function inRange(v, min, max){
    if(v == null || !isFinite(v)) return false;
    if(min !== '' && min != null && Number(v) < Number(min)) return false;
    if(max !== '' && max != null && Number(v) > Number(max)) return false;
    return true;
  }

  /* v4.4.2（站主）：身份不再只有笼统的一个「班干部」。
     站主：班干部就是班长、副班长、学习委员、劳动委员、团支书、体育委员、
     宣传委员、纪律委员这 8 个；课代表按 6 科分，所以身份再拆两档。
     ⚠️ 职务真正的落点是后台「头衔任命」（profiles.title，白名单校验过的），
     身份那一栏平时写的还是「学生 / 走读 / 住校」。所以判定时把
     **身份 + 头衔** 拼在一起看：头衔里有职务就命中，身份里手写了也认。
     「学生」= 除老师 / 管理员以外的所有人（班干部、课代表本来还是学生）。 */
  var ROLE_STAFF = ['班长', '副班长', '学习委员', '劳动委员', '生活委员',
                    '团支书', '体育委员', '宣传委员', '文艺委员', '纪律委员', '电教委'];
  function roleHit(group, raw){
    var s = String(raw == null ? '' : raw).trim();
    if(!s) s = '学生';
    if(group === '学生') return s.indexOf('老师') < 0 && s.indexOf('管理员') < 0;
    if(group === '班干部'){
      if(s.indexOf('班干部') >= 0) return true;
      for(var i = 0; i < ROLE_STAFF.length; i++) if(s.indexOf(ROLE_STAFF[i]) >= 0) return true;
      /* 兜底：任何「××委员」都算班干部（以后加新职务不用改代码） */
      return s.indexOf('委员') >= 0 || s.indexOf('班长') >= 0;
    }
    if(group === '课代表') return s.indexOf('课代表') >= 0;
    return s.indexOf(group) >= 0;
  }

  /* 条件命中判定：身份 / 性别 / 学号范围 / 成绩条件，取交集 */
  function hit(st, f, stat){
    var roles = (f.role && f.role.length) ? f.role : ['学生'];
    var stRole = String(st.role || '学生') + ' ' + String(st.title || ''), roleOk = false;
    for(var ri = 0; ri < roles.length; ri++){
      if(roleHit(roles[ri], stRole)){ roleOk = true; break; }
    }
    if(!roleOk) return false;
    if(f.gender && String(st.gender || '') !== f.gender) return false;
    if(f.sidMin !== '' || f.sidMax !== ''){
      var sid = Number(st.studentId);
      if(!isFinite(sid) || !st.studentId) return false;
      if(f.sidMin !== '' && sid < Number(f.sidMin)) return false;
      if(f.sidMax !== '' && sid > Number(f.sidMax)) return false;
    }
    if(f.metric){
      if(!stat) return false;
      var row = stat.byName[st.name];
      if(!row) return false;
      var v = null;
      if(f.metric === 'totalRank') v = row.totalRank;
      else if(f.metric === 'totalScore') v = row.total;
      else if(needProg(f.metric)){
        var pr = BIG.pick.prog, prr = pr && pr.byName[st.name];
        if(!prr) return false;
        v = (f.metric === 'totalProgress') ? prr.totalRank : (prr.subRank || {})[f.subj];
      }
      else {
        var cell = row.sub[f.subj] || {};
        v = (f.metric === 'subScore') ? cell.score : cell.rank;
      }
      if(!inRange(v, f.min, f.max)) return false;
    }
    return true;
  }

  function pool(){
    var ex = BIG.pick.ex || {}, f = BIG.pick.f || F_DEF, stat = BIG.pick.stat;
    return (BIG.pick.roster || []).filter(function (st){
      if(ex[st.name]) return false;
      return hit(st, f, stat);
    });
  }
  function names(arr){ return arr.map(function (x){ return x.name; }); }

  function rnd(arr){ return arr[Math.floor(Math.random() * arr.length)]; }

  global.bigPickOpen = function (){ BIG.pickOpen(); };

  BIG.pickOpen = function (){
    var m = $('bpickMask');
    if(!m) return;
    BIG.pick.ex = loadEx();
    BIG.pick.f = loadF();
    BIG.pick.n = Math.min(Math.max(1, BIG.pick.n || 1), 10);
    BIG.pick.state = 'setup';
    BIG.pick.names = [];
    BIG.pick.rec = null;
    BIG.pick.noteFor = '';
    BIG.pick.exList = false;
    BIG.pick.stat = null;
    BIG.pick.prog = null;
    BIG.pick.prevStat = null;
    BIG.pick.progNoPrev = false;
    m.classList.add('show');
    BIG.pickBody();
    loadRoster(function (){
      BIG.pickBody();
      if(BIG.pick.f.examId) statOf(BIG.pick.f.examId, BIG.pickBody);
    });
    loadExams(function (){ if(BIG.pick.fOpen || BIG.pick.state === 'setup') BIG.pickBody(); });
  };

  BIG.pickClose = function (){
    var m = $('bpickMask');
    if(m) m.classList.remove('show');
    if(BIG.pick.timer){ clearInterval(BIG.pick.timer); BIG.pick.timer = null; }
    BIG.pick.state = 'setup';
  };

  BIG.pickBackdrop = function (e){
    if(e && e.target && e.target.id === 'bpickMask') BIG.pickClose();
  };

  BIG.pickCount = function (d){
    BIG.pick.n = Math.min(Math.max(1, (BIG.pick.n || 1) + d), 10);
    BIG.pickBody();
  };

  BIG.pickStart = function (){
    var p = names(pool());
    if(!p.length){ toast('当前条件下无可用人员，请调整条件', true); return; }
    BIG.pick.state = 'rolling';
    var n = Math.min(BIG.pick.n, p.length);
    BIG.pick.names = [];
    for(var i = 0; i < n; i++) BIG.pick.names.push(rnd(p));
    BIG.pickBody();

    var t0 = Date.now();
    if(BIG.pick.timer) clearInterval(BIG.pick.timer);
    BIG.pick.timer = setInterval(function (){
      var el = $('bpickRoll');
      if(el){
        el.innerHTML = BIG.pick.names.map(function (){
          return '<div class="bpick-roll-item">' + esc0(rnd(p)) + '</div>';
        }).join('');
      }
      if(Date.now() - t0 > 1400){
        clearInterval(BIG.pick.timer);
        BIG.pick.timer = null;
        var picked = [], guard = 0;
        while(picked.length < n && guard < 500){
          guard++;
          var x = rnd(p);
          if(picked.indexOf(x) < 0) picked.push(x);
        }
        BIG.pick.names = picked;
        BIG.pick.state = 'result';
        try{ phAdd(picked); }catch(e){}
        BIG.pickBody();
        try{ if(typeof SFX !== 'undefined' && SFX.success) SFX.success(); }catch(e){}
      }
    }, 70);
  };

  BIG.pickAgain = function (){
    BIG.pick.state = 'setup';
    BIG.pickStart();
  };

  BIG.pickReroll = function (i){
    var p = names(pool());
    if(!p.length) return;
    var others = BIG.pick.names.filter(function (_, k){ return k !== i; });
    var cand = p.filter(function (n){ return others.indexOf(n) < 0; });
    if(!cand.length) cand = p;
    BIG.pick.names[i] = rnd(cand);
    /* 单个人重抽 = 这次抽取的结果变了，历史里那条要跟着改，不然记录和屏幕对不上 */
    try{
      var rec = BIG.pick.rec;
      if(rec && rec.id){
        var list = phMerge();
        for(var k = 0; k < list.length; k++){
          if(list[k].id === rec.id){ list[k].names = BIG.pick.names.slice(); list[k].n = BIG.pick.names.length; break; }
        }
        rec.names = BIG.pick.names.slice();
        phSave(list, false);
      }
    }catch(e){}
    BIG.pickBody();
  };

  /* 条件面板开关 */
  BIG.pickFilter = function (){
    BIG.pick.fOpen = !BIG.pick.fOpen;
    BIG.pickBody();
  };

  /* 条件改动：写回内存 + 本机，然后重画（条件区在顶部，重画不影响下面的名单滚动） */
  BIG.pickSet = function (k, v){
    var f = BIG.pick.f || (BIG.pick.f = loadF());
    f[k] = v;
    if(k === 'examId'){
      BIG.pick.stat = null; BIG.pick.prog = null; BIG.pick.prevStat = null;
      statOf(v, BIG.pickBody);
    }
    /* 切到「进步排名」时，上一次考试的成绩得现拉 */
    if(k === 'metric' && needProg(v) && !BIG.pick.prog){
      loadPrevStat(function (){ calcProg(); BIG.pickBody(); });
    }
    if(k !== 'metric' && k !== 'subj' && k !== 'min' && k !== 'max'){ /* 其它条件即时生效 */ }
    saveF();
    BIG.pickBody();
  };
  BIG.pickRole = function (role){
    var f = BIG.pick.f || (BIG.pick.f = loadF());
    var arr = (f.role || []).slice();
    var i = arr.indexOf(role);
    if(i >= 0){ if(arr.length > 1) arr.splice(i, 1); }
    else arr.push(role);
    f.role = arr;
    saveF();
    BIG.pickBody();
  };

  /* 名单里点击：正常 → 请假 → 不参与 → 正常。
     ⚠️ 只改这一个按钮的 class 与内部文字，**不重绘整块** —— 否则滚动位置会跳回顶部
     （站主原话：「点请假之后它会自动跳转到最前面，我还要往下翻」）。 */
  BIG.pickExOne = function (name, btn){
    var ex = BIG.pick.ex || {};
    if(!ex[name]) ex[name] = 'leave';
    else if(ex[name] === 'leave') ex[name] = 'out';
    else delete ex[name];
    BIG.pick.ex = ex;
    saveEx(ex);

    var el = btn;
    if(!el){
      var all = document.querySelectorAll('.bpick-ex-item');
      for(var i = 0; i < all.length; i++){
        if(all[i].getAttribute('data-name') === name){ el = all[i]; break; }
      }
    }
    if(el){
      var k = ex[name] || '';
      el.className = 'bpick-ex-item' + (k ? ' ' + k : '');
      el.innerHTML = esc0(name) + (k === 'leave' ? '<i>请假</i>' : (k === 'out' ? '<i>不参与</i>' : ''));
    }
    var c = $('bpickHeadCount');
    if(c) c.textContent = String(pool().length);
  };

  function condText(){
    var f = BIG.pick.f || F_DEF, arr = [];
    arr.push((f.role || ['学生']).join('/'));
    if(f.gender) arr.push(f.gender);
    if(f.sidMin !== '' || f.sidMax !== '') arr.push('学号 ' + (f.sidMin || '不限') + '–' + (f.sidMax || '不限'));
    if(f.metric){
      var stat = BIG.pick.stat;
      var mName = f.metric === 'totalRank' ? '总分名次（班级）'
        : f.metric === 'totalScore' ? '总分'
        : f.metric === 'totalProgress' ? '总分进步排名'
        : f.metric === 'subProgress' ? '单科进步排名'
        : (f.metric === 'subScore' ? '分数' : '单科名次（班级）');
      var subName = f.subj && stat ? (function (){
        for(var i = 0; i < stat.subjects.length; i++) if(stat.subjects[i].key === f.subj) return stat.subjects[i].name;
        return f.subj;
      })() : '';
      arr.push((subName ? subName : '') + mName + ' ' + (f.min || '不限') + '–' + (f.max || '不限'));
    }
    return arr.join(' · ');
  }

  BIG.pickBody = function (){
    var box = $('bpickBody');
    if(!box) return;
    var p = BIG.pick, all = p.roster || [], left = pool();

    /* 历史面板不需要名单，先处理 —— 否则未登录、名单空的时候连历史都看不了 */
    if(p.state === 'hist'){
      box.innerHTML = '<div class="bpick-state">抽取历史（按时间倒序）</div>' + histPanel()
        + '<div class="bpick-foot"><button type="button" class="bpick-link" onclick="BIG.pickHist()">← 返回抽取</button></div>';
      return;
    }

    var head = '<div class="bpick-state">按条件可抽 <b id="bpickHeadCount">' + left.length + '</b> 人'
      + (all.length ? '（共 ' + all.length + ' 人）' : '') + '</div>';

    if(!all.length){
      box.innerHTML = head + '<div class="bpick-empty">名单加载失败。<br>请确认已登录，并检查网络后重试。</div>';
      return;
    }

    if(p.state === 'setup'){
      var f = p.f || F_DEF;
      var stat = p.stat;
      var exCount = Object.keys(p.ex || {}).length;

      /* v4.4.0 起有「班干部」，v4.4.2 拆出「课代表」。
         身份值仍是后台「成员档案 → 身份」那个自由文本（maxlength 10），
         填「班长」「团支书」「语文课代表」都能被对应按钮认出来，不用改数据库。 */
      var roles = ['学生', '班干部', '课代表', '老师', '管理员'];
      var roleHtml = roles.map(function (r){
        var on = (f.role || []).indexOf(r) >= 0;
        return '<button type="button" class="bpick-chip' + (on ? ' on' : '') + '"'
          + ' onclick="BIG.pickRole(\'' + attr0(r) + '\')">' + esc0(r) + '</button>';
      }).join('');

      var examOpts = '<option value="">不限成绩</option>';
      (p.exams || []).forEach(function (e){
        examOpts += '<option value="' + attr0(e.id) + '"' + (String(f.examId) === String(e.id) ? ' selected' : '')
          + '>' + esc0(e.name || ('考试 ' + e.id)) + '</option>';
      });
      var metricOpts = [
        ['', '不限'], ['totalRank', '总分名次（班级）'], ['totalScore', '总分'],
        ['subScore', '单科分数'], ['subRank', '单科名次（班级）'],
        ['totalProgress', '总分进步排名'], ['subProgress', '单科进步排名'],
      ].map(function (x){
        return '<option value="' + x[0] + '"' + (f.metric === x[0] ? ' selected' : '') + '>' + x[1] + '</option>';
      }).join('');
      var subjOpts = '';
      if(stat && stat.subjects.length){
        subjOpts = stat.subjects.map(function (sb){
          return '<option value="' + attr0(sb.key) + '"' + (f.subj === sb.key ? ' selected' : '') + '>'
            + esc0(sb.name) + '</option>';
        }).join('');
      }
      var needSubj = (f.metric === 'subScore' || f.metric === 'subRank' || f.metric === 'subProgress');
      /* 进步排名：上一次没考 / 这是最早一场，就无法算 */
      var progTip = (needProg(f.metric) && p.progNoPrev)
        ? '<div class="bpick-f-tip" style="color:#b45309">该场为最早考试，无上一场数据，无法计算进步排名。</div>'
        : '';

      var filterHtml = p.fOpen
        ? ('<div class="bpick-f">'
            + '<div class="bpick-f-row"><span class="bpick-f-k">身份</span><div class="bpick-chips">' + roleHtml + '</div></div>'
            + '<div class="bpick-f-row"><span class="bpick-f-k">性别</span><div class="bpick-chips">'
            +   ['', '男', '女'].map(function (g){
                  var lb = g || '不限';
                  return '<button type="button" class="bpick-chip' + (f.gender === g ? ' on' : '') + '"'
                    + ' onclick="BIG.pickSet(\'gender\',\'' + g + '\')">' + lb + '</button>';
                }).join('')
            + '</div></div>'
            + '<div class="bpick-f-row"><span class="bpick-f-k">学号</span>'
            +   '<input class="bpick-in" inputmode="numeric" placeholder="起" value="' + attr0(f.sidMin) + '"'
            +     ' onchange="BIG.pickSet(\'sidMin\',this.value.trim())">'
            +   '<span class="bpick-dash">–</span>'
            +   '<input class="bpick-in" inputmode="numeric" placeholder="止" value="' + attr0(f.sidMax) + '"'
            +     ' onchange="BIG.pickSet(\'sidMax\',this.value.trim())">'
            + '</div>'
            + '<div class="bpick-f-row"><span class="bpick-f-k">成绩</span>'
            +   '<select class="bpick-sel" onchange="BIG.pickSet(\'examId\',this.value)">' + examOpts + '</select>'
            + '</div>'
            + (f.examId
                ? '<div class="bpick-f-row"><span class="bpick-f-k"></span>'
                  +   '<select class="bpick-sel" onchange="BIG.pickSet(\'metric\',this.value)">' + metricOpts + '</select>'
                  +   (needSubj
                      ? '<select class="bpick-sel" onchange="BIG.pickSet(\'subj\',this.value)">'
                        + (subjOpts || '<option value="">成绩加载中</option>') + '</select>'
                      : '')
                  + '</div>'
                + (f.metric
                    ? '<div class="bpick-f-row"><span class="bpick-f-k"></span>'
                      + '<input class="bpick-in" inputmode="decimal" placeholder="最小" value="' + attr0(f.min) + '"'
                      +   ' onchange="BIG.pickSet(\'min\',this.value.trim())">'
                      + '<span class="bpick-dash">–</span>'
                      + '<input class="bpick-in" inputmode="decimal" placeholder="最大" value="' + attr0(f.max) + '"'
                      +   ' onchange="BIG.pickSet(\'max\',this.value.trim())">'
                      + '</div>'
                    : '')
                : '')
            + progTip
            + '<p class="bpick-f-tip">名次均为<b>本班排名</b>。多个条件可叠加使用。'
            + '「进步排名」按较上一场考试的班级名次提升幅度排序，1 为进步最大。</p>'
            + '<p class="bpick-f-tip">「班干部」包含班长、副班长、学习委员、劳动委员、生活委员、团支书、体育委员、宣传委员、文艺委员、纪律委员；'
            + '「课代表」包含各科课代表。职务以<b>「头衔任命」</b>为准。</p>'
            + '</div>')
        : '';

      var noOne = left.length ? '' : '<div class="bpick-empty" style="padding:12px 0 4px">当前条件下无可用人员。<br>'
        + '请调整性别、学号或成绩条件后重试。</div>';

      box.innerHTML = head + noOne
        + '<div class="bpick-cond">条件：' + esc0(condText())
        +   '<button type="button" class="bpick-link" style="margin:0 0 0 8px" onclick="BIG.pickFilter()">'
        +   (p.fOpen ? '收起' : '修改') + '</button></div>'
        + filterHtml
        + '<div class="bpick-count"><button type="button" onclick="BIG.pickCount(-1)">−</button>'
        +   '<span><b>' + p.n + '</b> 人</span>'
        +   '<button type="button" onclick="BIG.pickCount(1)">+</button></div>'
        + '<button type="button" class="bpick-go" onclick="BIG.pickStart()">开始抽取</button>'
        + '<button type="button" class="bpick-link" onclick="BIG.pickExOpen()">名单设置'
        +   (exCount ? '（已排除 ' + exCount + ' 人）' : '') + '</button>'
        + '<button type="button" class="bpick-link" onclick="BIG.pickHist()">抽取历史'
        +   (histCount() ? '（' + histCount() + '）' : '') + '</button>'
        + (p.exList ? exPanel() : '');
      return;
    }

    if(p.state === 'rolling'){
      box.innerHTML = head + '<div class="bpick-roll" id="bpickRoll">'
        + p.names.map(function (n){ return '<div class="bpick-roll-item">' + esc0(n) + '</div>'; }).join('')
        + '</div>';
      return;
    }

    box.innerHTML = head
      + '<div class="bpick-res">'
      + p.names.map(function (n, i){
          return '<div class="bpick-res-row"><b>' + esc0(n) + '</b>'
            + '<button type="button" title="只重抽这一个" onclick="BIG.pickReroll(' + i + ')">' + ico('rotate-cw', 16) + '</button></div>';
        }).join('')
      + '</div>'
      + noteHtml()
      + '<div class="bpick-foot">'
      +   '<button type="button" class="bpick-go" onclick="BIG.pickAgain()">重新抽取</button>'
      +   '<button type="button" class="bpick-link" onclick="BIG.pickClose()">关闭</button>'
      + '</div>';
  };

  /* 结果页底部的备注框（v4.4.0 第 4 条） */
  function noteHtml(){
    var rec = BIG.pick.rec;
    if(!rec || !rec.id) return '';
    BIG.pick.noteFor = rec.id;
    return '<div class="bpick-note">'
      + '<div class="bpick-note-k">备注</div>'
      + '<input class="bpick-note-in" maxlength="120" placeholder="选填，填写本次抽取事由"'
      +   ' value="' + attr0(rec.note || '') + '" oninput="BIG.pickNote(this.value)">'
      + '<div class="bpick-note-tip">' + (adminOk() ? '已同步至云端' : '未登录，记录暂存本机') + '</div>'
      + '</div>';
  }
  function histCount(){
    try{ return phMerge().length; }catch(e){ return 0; }
  }
  function histPanel(){
    var list = [];
    try{ list = phMerge(); }catch(e){ list = []; }
    if(!list.length){
      return '<div class="bpick-empty">暂无抽取记录。<br>完成抽取后将自动记录时间、条件、人数与结果。</div>';
    }
    return '<div class="bpick-hist-tip">'
      + (adminOk() ? '记录已同步至云端' : '记录暂存本机，管理员登录后自动上传')
      + '</div>'
      + '<div class="bpick-hist">' + list.map(function (r){
      var rid = attr0(r.id);
      return '<div class="bpick-hist-item">'
        + '<div class="bpick-hist-top">'
        +   '<b>' + esc0(phTime(r.at)) + '</b>'
        +   '<span class="bpick-hist-n">' + r.n + ' 人</span>'
        +   '<button type="button" class="bpick-hist-x" onclick="BIG.pickHistDel(\'' + rid + '\')">删</button>'
        + '</div>'
        + '<div class="bpick-hist-cond">条件：' + esc0(r.cond || '不限（全部可抽的人）') + '</div>'
        + '<div class="bpick-hist-names">'
        +   r.names.map(function (n){ return '<span>' + esc0(n) + '</span>'; }).join('')
        + '</div>'
        + '<input class="bpick-note-in bpick-hist-note" maxlength="120" placeholder="备注"'
        +   ' value="' + attr0(r.note || '') + '"'
        +   ' onfocus="BIG.pick.noteFor=\'' + rid + '\'"'
        +   ' oninput="BIG.pick.noteFor=\'' + rid + '\';BIG.pickNote(this.value)">'
        + '</div>';
    }).join('') + '</div>';
  }

  /* 名单设置：整块只渲染一次；之后点击只改单个按钮（见 pickExOne） */
  function exPanel(){
    var p = BIG.pick;
    var arr = (p.roster || []).slice().sort(function (a, b){
      var x = String(a.studentId || ''), y = String(b.studentId || '');
      if(x && y && x !== y) return x < y ? -1 : 1;
      if(x && !y) return -1;
      if(!x && y) return 1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
    return '<div class="bpick-ex">'
      + '<p class="bpick-ex-tip">点名字切换：不参与 / 请假。名单只记在这台电脑上。</p>'
      + '<div class="bpick-ex-list">'
      + arr.map(function (st){
          var k = p.ex[st.name] || '';
          return '<button type="button" class="bpick-ex-item' + (k ? ' ' + k : '') + '"'
            + ' data-name="' + attr0(st.name) + '"'
            + ' onclick="BIG.pickExOne(\'' + attr0(st.name).replace(/'/g, "\\'") + '\',this)">'
            + esc0(st.name)
            + (k === 'leave' ? '<i>请假</i>' : (k === 'out' ? '<i>不参与</i>' : '')) + '</button>';
        }).join('')
      + '</div></div>';
  }

  BIG.pickExOpen = function (){
    BIG.pick.exList = !BIG.pick.exList;
    BIG.pickBody();
  };

  BIG.pickToggleEx = function (name, kind){
    BIG.pick.ex = BIG.pick.ex || {};
    if(BIG.pick.ex[name] === kind) delete BIG.pick.ex[name];
    else BIG.pick.ex[name] = kind;
    saveEx(BIG.pick.ex);
    BIG.pickBody();
  };

  /* ---------------- 班级电脑提醒（v4.0.0 第 9 条） ----------------
     站主原话：「我在手机端用我的账户给班级电脑发一条消息，班级电脑收到之后
     实时出现一个弹窗，内容就是我发的消息，我可以自定义标题、内容，以及重要性，
     重要性三档，不同等级弹窗颜色不一样。」
     落地方式（复用站里已有的「通用弹窗」，不另建一套消息系统）：
       · 后台「通用弹窗」新增一条，投放对象选班级电脑那个账号，重要性选普通/重要/紧急；
       · 大屏这边每 20 秒拉一次 /api/content，看到**新出现**的弹窗就整屏弹出来；
       · 只弹 24 小时内创建、在时间窗内、且投放对象命中本机的；
       · 老数据没有 createdAt → 直接标记为「已看过」，不会开机把历史消息全弹一遍。 */
  var ALERT_POLL = 20000;
  BIG.alertSeen = {};
  BIG.alertT = null;
  BIG.alertQueue = [];

  function meUser(){
    try{ return (typeof AUTH !== 'undefined' && AUTH && AUTH.user) ? AUTH.user : null; }catch(e){ return null; }
  }

  function alertHit(p){
    var t = p && p.target;
    if(!t || !t.mode || t.mode === 'all') return true;
    var me = meUser();
    if(!me) return false;
    var un = String(me.username || '').toLowerCase();
    var dn = String(me.displayName || me.display_name || me.name || '').trim().toLowerCase();
    if(t.mode === 'users'){
      return (t.users || []).some(function (x){
        var k = String(x || '').trim().toLowerCase();
        return !!k && (k === un || k === dn);
      });
    }
    if(t.mode === 'roles'){ return (t.roles || []).indexOf(String(me.role || 'user')) >= 0; }
    if(t.mode === 'titles'){
      var my = String(me.title || '').split(/[,，、]/).map(function (x){ return x.trim(); }).filter(Boolean);
      return (t.titles || []).some(function (x){ return my.indexOf(x) >= 0; });
    }
    return true;
  }

  function inWindow(p){
    var now = Date.now();
    if(p.startAt){ var a = Date.parse(p.startAt); if(isFinite(a) && now < a) return false; }
    if(p.endAt){ var b = Date.parse(p.endAt); if(isFinite(b) && now > b) return false; }
    return true;
  }

  function beep(level){
    try{
      var AC = window.AudioContext || window.webkitAudioContext;
      if(!AC) return;
      if(!BIG._ac) BIG._ac = new AC();
      var ac = BIG._ac;
      if(ac.state === 'suspended'){ ac.resume(); }
      var seq = level === 'urgent'
        ? [[880,0],[660,.16],[880,.32],[660,.48],[880,.64],[660,.80]]
        : level === 'important'
          ? [[740,0],[880,.18],[740,.36]]
          : [[880,0]];
      seq.forEach(function (x){
        var o = ac.createOscillator(), g = ac.createGain();
        o.type = 'sine';
        o.frequency.value = x[0];
        o.connect(g); g.connect(ac.destination);
        var t = ac.currentTime + x[1];
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.2, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.19);
        o.start(t); o.stop(t + 0.22);
      });
    }catch(e){}
  }

  function alertDom(){
    var el = $('bigAlert');
    if(el) return el;
    el = document.createElement('div');
    el.id = 'bigAlert';
    el.className = 'big-alert';
    el.innerHTML = '<div class="big-alert-box" id="bigAlertBox">'
      + '<div class="big-alert-k" id="bigAlertK">提醒</div>'
      + '<h2 id="bigAlertTitle"></h2>'
      + '<p id="bigAlertBody"></p>'
      + '<div class="big-alert-foot"><span id="bigAlertFrom"></span>'
      +   '<button type="button" class="big-alert-btn" onclick="BIG.alertClose()">知道了</button></div>'
      + '</div>';
    document.body.appendChild(el);
    return el;
  }

  BIG.alertShow = function (p){
    if(!p) return;
    /* 已经在弹一条了，就排队，避免两条叠在一起 */
    if($('bigAlert') && $('bigAlert').classList.contains('show')){ BIG.alertQueue.push(p); return; }
    var el = alertDom();
    var lv = (p.level === 'urgent' || p.level === 'important') ? p.level : '';
    var box = $('bigAlertBox');
    box.className = 'big-alert-box' + (lv ? ' level-' + lv : '');
    $('bigAlertK').textContent = lv === 'urgent' ? '紧急通知' : lv === 'important' ? '重要提醒' : '班级提醒';
    $('bigAlertTitle').textContent = plain(p.title || '班级消息');
    $('bigAlertBody').textContent = String(p.body || '');
    $('bigAlertFrom').textContent = p.createdAt
      ? ('发送于 ' + new Date(p.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
      : '';
    el.classList.add('show');
    beep(lv);
  };

  BIG.alertClose = function (){
    var el = $('bigAlert');
    if(el) el.classList.remove('show');
    var next = BIG.alertQueue.shift();
    if(next) setTimeout(function (){ BIG.alertShow(next); }, 260);
  };

  function pollAlerts(){
    if(!BIG.on) return;
    try{
      if(typeof api !== 'function') return;
      api('/content').then(function (j){
        var it = (j && j.items) || {};
        var raw = it.popups;
        if(typeof raw === 'string'){ try{ raw = JSON.parse(raw); }catch(e){ raw = []; } }
        if(!Array.isArray(raw)) return;
        raw.forEach(function (p){
          if(!p || !p.id) return;
          var id = String(p.id);
          if(BIG.alertSeen[id]) return;
          /* 只管「进站弹」这一类：板块弹（cat:N）不往大屏上怼 */
          if(p.scope && p.scope !== 'boot' && p.scope !== 'big') return;
          if(!inWindow(p)) return;
          if(!alertHit(p)) return;
          /* 没有创建时间的老弹窗：标记已读，不弹（否则第一次打开会把历史消息全放出来） */
          if(!p.createdAt){ BIG.alertSeen[id] = 1; return; }
          var age = Date.now() - Date.parse(p.createdAt);
          if(!(age >= 0 && age < 86400000)){ BIG.alertSeen[id] = 1; return; }
          BIG.alertSeen[id] = 1;
          BIG.alertShow(p);
        });
      }).catch(function (){});
    }catch(e){}
  }

  BIG.startAlerts = function (){
    if(BIG.alertT) clearInterval(BIG.alertT);
    pollAlerts();
    BIG.alertT = setInterval(pollAlerts, ALERT_POLL);
  };
  BIG.stopAlerts = function (){
    if(BIG.alertT){ clearInterval(BIG.alertT); BIG.alertT = null; }
  };

  /* ---------------- 启动 ---------------- */

  /* v4.3.2（站主）：版本静默自检
     ------------------------------------------------------------
     背景：教室一体机带冰点还原，Edge 的 Profile 已整体搬到 D 盘，
     正常情况版本不会再回退。但「正常」不够 —— 站主要的是「打开必定最新」，
     而不是「打开大概是新的」。

     所以打开 4 秒后偷偷读一次 sw.js（12KB，很轻），比对里面的 SITE_VER
     和本页的 SITE_VERSION：
       · 线上更新了 → 主动让新 SW 接管，然后带 ?_r= 时间戳强刷一次
         （?_r= 在 SW 里是明确放行网络的，绕开所有缓存）
       · 一样 → 什么都不做，用户全程无感

     两道闸防死循环：
       · sessionStorage 计数：同一次打开最多救 2 次
       · localStorage 时间戳：10 分钟内不重复救（跨重启也算） */
  function verGt(a, b){
    var x = String(a || '').split('.'), y = String(b || '').split('.');
    var n = Math.max(x.length, y.length);
    for(var i = 0; i < n; i++){
      var p = parseInt(x[i], 10) || 0, q = parseInt(y[i], 10) || 0;
      if(p > q) return true;
      if(p < q) return false;
    }
    return false;
  }

  function selfHeal(){
    if(!BIG.on) return;
    var T_KEY = 'cls_bhw_heal_t';
    var N_KEY = 'cls_bhw_heal_n';
    var lastT = 0, n = 0;
    try{ lastT = parseInt(localStorage.getItem(T_KEY) || '0', 10) || 0; }catch(e){}
    try{ n = parseInt(sessionStorage.getItem(N_KEY) || '0', 10) || 0; }catch(e){}
    if(n >= 2) return;
    if(Date.now() - lastT < 10 * 60 * 1000) return;

    setTimeout(function(){
      if(!BIG.on) return;
      fetch('./sw.js?_sh=' + Date.now(), { cache: 'no-store' })
        .then(function(r){ return (r && r.ok) ? r.text() : ''; })
        .then(function(t){
          var m = /SITE_VER\s*=\s*['"]([0-9][0-9.]*)['"]/.exec(t || '');
          if(!m) return;
          var cur = (typeof SITE_VERSION !== 'undefined') ? String(SITE_VERSION) : '';
          if(!cur || !verGt(m[1], cur)) return;
          try{ localStorage.setItem(T_KEY, String(Date.now())); }catch(e){}
          try{ sessionStorage.setItem(N_KEY, String(n + 1)); }catch(e){}
          /* 让等待中的新 SW 立刻接管（install 里已有 skipWaiting，这条是推处于 waiting 的） */
          try{
            if(navigator.serviceWorker && navigator.serviceWorker.controller){
              navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
            }
          }catch(e){}
          /* 带 ?_r= 强刷：SW 对 _r 请求直接放行网络，不会被缓存拦住。
             app.js 里刷完会把 _r 从地址栏抹掉，不会留在收藏/分享里。 */
          try{
            var u = new URL(location.href);
            u.searchParams.set('_r', String(Date.now()));
            location.replace(u.toString());
          }catch(e){ location.reload(); }
        })
        .catch(function(){});
    }, 4000);
  }

  function boot(){
    applyClass();
    applyFs();
    applyFont();
    buildHome();
    if(BIG.on) BIG.startAlerts();
    var pi = $('bhwPickIco');
    if(pi) pi.innerHTML = ico('dices', 20);
    if(!BIG.on) return;
    syncThemeBtn();
    /* v4.3.1（站主第 1 条）：大屏模式打开网站直接进作业页，不用再点一次图标墙。
       但别的深链（比如 #/board/3）不能抢 —— 只有 hash 为空或本来就是 #/hw 才自动进。 */
    var hash = String(location.hash || '');
    if(/^#\/hw/.test(hash)){
      var m = /^#\/hw\/(.+)$/.exec(hash);
      BIG.openHw(m ? decodeURIComponent(m[1]) : null);
    }else if(!hash || hash === '#' || hash === '#/'){
      BIG.openHw();
    }
    /* v4.3.2：大屏模式做一次静默版本自检（只在这个模式下才跑，不影响别人） */
    selfHeal();
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function (){ setTimeout(boot, 0); });
  else boot();

  /* 供 app.js 判断当前是不是大屏作业页（路由用） */
  BIG.isHw = function (){ return !!BIG.hwOn; };

})(window);
