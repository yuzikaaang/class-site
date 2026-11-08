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
    pick: { open: false, n: 1, state: 'setup', names: [], timer: null, roster: [], ex: {}, fx: 'off', hideName: true }
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
    moveBrandTop(BIG.on);
  }

  /* ---------------- 标题上移（v4.10.1 站主第 3 条） ----------------
     站主要求：「标题放在上面，操作跟作业看板要求一样，预留位置防止课表遮挡，
     功能栏放在标题下面」。
     做法：开大屏时把 .content>header（站名 + 班徽）**搬**到 .sidebar
     （导航功能栏）前面，成为 .layout 的直接子元素；关大屏时搬回 content
     第一位。是 DOM 搬家不是复制 —— 普通模式一个像素都不动。 */
  function moveBrandTop(on){
    try{
      /* ⚠️ v4.10.2（站主第 9 条）：这里原来查的是 '.content>header'，
         可是开大屏时 header 已经被搬到 .layout 下了 —— 再查 '.content>header'
         一律是 null，于是 moveBrandTop 直接 return，**header 永远搬不回去**。
         症状就是站主说的「关掉大屏之后，标题栏单独列出来一栏，刷新才恢复」。
         现在改成先认 .big-brand-top（自己加的标记），再退回普通 header。 */
      var hd = document.querySelector('header.big-brand-top') || document.querySelector('.content>header');
      var side = document.querySelector('.sidebar');
      var layout = document.querySelector('.layout');
      if(!hd || !side || !layout) return;
      if(on){
        if(hd.parentNode !== layout || hd.nextElementSibling !== side){
          layout.insertBefore(hd, side);
        }
        hd.classList.add('big-brand-top');
      }else{
        var content = document.querySelector('.content');
        if(!content) return;
        if(hd.parentNode !== content || content.firstChild !== hd){
          content.insertBefore(hd, content.firstChild);
        }
        hd.classList.remove('big-brand-top');
      }
    }catch(e){}
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
      /* v4.7.0：切进大屏才开始「班级提醒 + 作业」轮询（以前只在开机时为真） */
      try{ BIG.startAlerts(); }catch(e){}
      toast('大屏模式已开启');
    }else{
      BIG.closeHw();
      try{ BIG.stopAlerts(); }catch(e){}
      try{ goHomeView(); }catch(e){}
      toast('已切回普通模式');
    }
    try{ renderSettings(); }catch(e){}
    try{ if(typeof refreshQuick === 'function') refreshQuick(); }catch(e){}
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
    /* v4.10.8：作业看板只给管理员。这里先拦一道，进去之后 openHw 还会再拦一次
       （防止有人直接敲 #/hw 路由）。 */
    if(l.id === 2) return function (){
      if(!adminOk()){ toast('作业看板仅管理员可查看'); return; }
      BIG.openHw();
    };
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
          sub: l.paused ? '暂停开放'
            : (l.id === 2 && !adminOk() ? '仅管理员' : (l.subtitle || '')),
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

  /* v4.8.0（站主）：「每次可以调节的少一点点，我甚至可以手动输入，每次就调 5%」。
     档位制改成连续百分比：25%–300%，按一下 ±5%，中间那个数字可以直接点进去改。
     老数据两种都认（v4.7.3 存的是档位索引，更早的是 8 档老索引），按实际倍率换算。 */
  /* v4.10.3（站主第 2 条：字号搞反了 —— 这次一次改对）：
   *
   * 【站主的原话】
   *   「你似乎把字号大小搞反了，现在默认打开是 250 才是我们之前 150 的效果，
   *     我要的是 100 是之前 150 的效果」
   *
   * 【前两次到底错在哪】
   *   v4.10.1 之前：刻度 100 = 1.0 倍，站主嫌大屏正文偏小。
   *   v4.10.2（我做的）：把基准挪到 150 —— 显示 150 = 1.0 倍，
   *     于是「之前的 150% 外观」变成了新刻度的 225，站主一看就说搞反了。
   *   v4.10.3（现在）：基准挪回 **100**，但**保留「1.0 倍 = 旧 150% 外观」**。
   *     也就是说站主要的其实是：
   *       · 新刻度上显示 **100**，
   *       · 它的**外观等于旧刻度 150% 的样子**（还是那么大，没变小），
   *       · 同时比旧的 100% 更大 —— 也就是旧 150% 这个尺寸升格成了「标准」。
   *     实现方式：显示值仍然是 0–100% 系的百分比，但真正乘到 CSS 上的是
   *     `显示值 / 100 × 1.5` —— 100% 就等于旧 150% 的放大倍率。
   *
   * 【刻度与迁移】
   *   · 显示范围 25–300（跟 v4.10.1 一样，不用记新数字）
   *   · 倍率 = 显示值 / 100 × 1.5（100 → 1.5 倍 = 旧 150% 的样子）
   *   · 默认 100（= 旧 150% 的外观）—— 正是站主要的那个数
   *   · 旧存储键 cls_bhw_fs3（v4.10.x 的刻度）按 ÷1.5 迁回来
   *   · v4.10.2 的键 cls_bhw_fs4 也认：它是「×1.5 后的数」，÷1.5 即回旧值
   */
  var FS_KEY = 'cls_bhw_fs5';
  var FS_MIN = 25, FS_MAX = 300, FS_STEP = 5;
  var FS_BASE = 100;                       /* 显示 100 = 1.5 倍（= 旧 150% 的外观） */
  var FS_MUL = 1.5;                        /* 1.5 倍就是「标准」 */
  var FS_STEPS = [0.25, 0.35, 0.5, 0.65, 0.8, 1, 1.2, 1.45, 1.75, 2.1, 2.55, 3];
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
  /* v4.7.11（站主第 4 条）：「大屏作业查看里那个每日一言，有时候不太适合放在班上展出」
     单独给大屏一个隐藏开关，不影响首页卡片。 */
  var QH_KEY = 'cls_bhw_quote_hide';
  BIG.quoteHidden = (function (){
    try{ return localStorage.getItem(QH_KEY) === '1'; }catch(e){ return false; }
  })();
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

  /* 旧档位（v4.7.2 及以前）。索引语义变了，直接读老索引会把 100% 读成 50%，
     所以换了个键名，老值按「实际倍率最接近」换算过来。 */
  var FS_KEY_OLD = 'cls_bhw_fs';
  var FS_OLD = [0.85, 0.95, 1, 1.1, 1.2, 1.35, 1.5, 1.7];
  function clampFs(n){
    n = Math.round(Number(n));
    if(!isFinite(n)) return FS_BASE;
    if(n < FS_MIN) return FS_MIN;
    if(n > FS_MAX) return FS_MAX;
    return n;
  }
  /* v4.10.3：倍率 → 显示值（100 = 1.5 倍 = 旧 150% 的外观） */
  function fsFromRatio(r){
    return clampFs(Math.round(r / FS_MUL * FS_BASE));
  }
  function readFs(){
    var n = null;
    try{ n = parseInt(localStorage.getItem(FS_KEY), 10); }catch(e){}
    if(n >= FS_MIN && n <= FS_MAX) return n;
    /* v4.10.2 的键：它是「旧值 ×1.5」记的（基准 150）→ ÷1.5 回旧值再换算 */
    var prev2 = null;
    try{ prev2 = parseInt(localStorage.getItem('cls_bhw_fs4'), 10); }catch(e){}
    if(prev2 >= 25 && prev <= 450) return fsFromRatio(prev2 / 150);
    /* v4.10.x 的刻度：100 = 1.0 倍 → 换算到新刻度 */
    var prev = null;
    try{ prev = parseInt(localStorage.getItem('cls_bhw_fs3'), 10); }catch(e){}
    if(prev >= 25 && prev <= 300) return fsFromRatio(prev / 100);
    /* v4.7.3 的档位索引 → 百分比 */
    var idx = null;
    try{ idx = parseInt(localStorage.getItem('cls_bhw_fs2'), 10); }catch(e){}
    if(idx >= 0 && idx < FS_STEPS.length) return fsFromRatio(FS_STEPS[idx]);
    /* 更早的 8 档老索引 → 百分比 */
    var old = null;
    try{ old = parseInt(localStorage.getItem(FS_KEY_OLD), 10); }catch(e){}
    if(old >= 0 && old < FS_OLD.length) return fsFromRatio(FS_OLD[old]);
    return FS_BASE;
  }
  function applyFs(){
    var h = $('bigHw');
    /* v4.10.3：倍率 = 显示值 / 100 × 1.5
       —— 显示 100 就是 1.5 倍，正是旧刻度 150% 的那个大小（站主要的标准）。 */
    if(h) h.style.setProperty('--bhw-fs', String(BIG.fs / FS_BASE * FS_MUL));
    var v = $('bhwFsVal');
    /* 数字框自己触发的那次不要回写，否则会把用户正在敲的「1」顶成「100」 */
    if(v && v !== document.activeElement) v.value = String(BIG.fs);
    /* 字号一变，卡片高度跟着变 —— 立刻重排一次 */
    if(BIG.hwOn) scheduleLayout();
  }
  BIG.fs = readFs();
  BIG.fsStep = function (d){
    var n = clampFs(BIG.fs + (d > 0 ? FS_STEP : -FS_STEP));
    if(n === BIG.fs){ toast(d > 0 ? '已到最大字号（' + FS_MAX + '%）' : '已到最小字号（' + FS_MIN + '%）'); return; }
    BIG.fsSet(n);
  };
  /* v4.8.0：手动输入。留空 / 乱填都退回当前值，不报错也不跳字。 */
  BIG.fsSet = function (v){
    var raw = String(v == null ? '' : v).replace(/[^0-9]/g, '');
    if(!raw){ applyFs(); return; }
    var n = clampFs(parseInt(raw, 10));
    var hitEdge = false;
    if(n !== Math.round(Number(raw))) hitEdge = true;
    BIG.fs = n;
    try{ localStorage.setItem(FS_KEY, String(n)); }catch(e){}
    applyFs();
    if(hitEdge) toast('字号范围 ' + FS_MIN + '%–' + FS_MAX + '%');
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

  /* ================= 每项截止时间（v4.12.0）=================
     站主原话：「每一个小项都可以设置一个截止日期，精确到分钟，也可以不设，
     显示为淡色小字，过期项默认隐藏」。
     字段：task.due = 'YYYY-MM-DDTHH:mm'（本机时间，不带时区，换设备也读得懂）。
     没设过 / 清空 = 空字符串，跟老数据完全兼容 —— 老数据里根本没有这个字段。 */
  function dueMs(t){
    if(!t || typeof t !== 'object') return 0;
    var s = String(t.due || '').trim();
    if(!s) return 0;
    if(s.length >= 16 && s.charAt(10) === ' ') s = s.slice(0, 10) + 'T' + s.slice(11);
    var d = new Date(s);
    var v = d.getTime();
    return isNaN(v) ? 0 : v;
  }
  function isOverdue(t){ var m = dueMs(t); return !!m && m < Date.now(); }
  /* 文案分两种：卡片上是「截止 11/13 22:00」，导出图上要更短（右侧那一列窄） */
  function dueText(t, short){
    var m = dueMs(t); if(!m) return '';
    var d = new Date(m);
    function p(n){ return (n < 10 ? '0' : '') + n; }
    var md = (d.getMonth() + 1) + '/' + d.getDate();
    if(d.getFullYear() !== new Date().getFullYear()) md = (d.getFullYear() % 100) + '/' + md;
    var hm = md + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    if(isOverdue(t)) return short ? '已截止' : '已截止 ' + hm;
    return short ? hm : '截止 ' + hm;
  }
  BIG.dueMs = dueMs; BIG.isOverdue = isOverdue; BIG.dueText = dueText;

  /* 过期项默认收起：展开状态只存在内存里，重绘不丢，刷新页面就回到收起 */
  BIG._dueOpen = {};
  BIG.dueFold = function (btn, key){
    var box = btn && btn.nextElementSibling;
    if(!box) return;
    var on = box.hasAttribute('hidden');
    if(on){ box.removeAttribute('hidden'); BIG._dueOpen[key] = 1; }
    else { box.setAttribute('hidden', ''); delete BIG._dueOpen[key]; }
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-expanded', on ? 'true' : 'false');
    try{ scheduleLayout(); }catch(e){}
  };

  /* ================= 按学期自动排周次（v4.11.0）=================
     站主原话：「不要让我一期一期新建，系统自动帮我建好。分为周作业和周末作业，
     名称就是第几周，第 11 周对应 11/9–11/13 这样。」

     规则（站主逐条确认过）：
       · 起点：学期开始日所在那一周的周一。2026-09-01 是周二，所以第 1 周从 8/31 起；
       · 周作业 = 周一 ~ 周五；周末作业 = 周六 ~ 周日；
       · 名称带学期前缀：「高二上 · 第11周作业」「高二上 · 第11周周末作业」；
       · 学期开始日之后的日期一直往后数，不因为学期结束就停；
       · 期次先只在内存里造出来（_auto），**改了内容才落库**，空壳不存。
     学期名与开学日都来自 app.js 的 islandProgress()，后台改一次这里就跟着变。 */
  var TERM_BASE = null;
  function termBase(){
    if(TERM_BASE) return TERM_BASE;
    var p = null;
    try{ if(typeof islandProgress === 'function') p = islandProgress(); }catch(e){}
    var st = p && p.start ? String(p.start).slice(0, 10) : '';
    if(!st) return null;
    var d = new Date(st + 'T00:00:00');
    if(isNaN(d.getTime())) return null;
    var wd = (d.getDay() + 6) % 7;      /* 周一 = 0 */
    d.setDate(d.getDate() - wd);        /* 开学日所在周的周一 */
    TERM_BASE = { mon: d, term: p && p.term ? String(p.term) : '' };
    return TERM_BASE;
  }
  function ymd(d){
    function p(n){ return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function weekOf(date){
    var b = termBase();
    if(!b) return null;
    var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    var no = Math.floor(Math.round((d - b.mon) / 86400000) / 7) + 1;
    var mon = new Date(b.mon.getTime()); mon.setDate(mon.getDate() + (no - 1) * 7);
    var sun = new Date(mon.getTime()); sun.setDate(sun.getDate() + 6);
    return { no: no, mon: mon, sun: sun, term: b.term };
  }
  function periodTitle(no, weekend){
    var b = termBase();
    var pre = (b && b.term) ? b.term + ' · ' : '';
    return pre + '第' + no + '周' + (weekend ? '周末作业' : '作业');
  }
  /* 同一个「周」反复调用要拿到同一个对象，否则每次渲染都被当成新数据整块重建 */
  var AUTO_CACHE = {};
  /* v4.12.0（站主）：「日历视图：底部日期条可跳转前后期次，可提前编辑未来作业；
     点 11/14 自动落到第11周周末作业」。hwViewDate 是「当前在看哪一天/哪一周」的锚点，
     为空 = 看今天。设了它，currentHw() 就落到那一天所在的自动期次。 */
  BIG.hwViewDate = null;
  function ensurePeriod(date){
    var w = weekOf(date);
    if(!w) return null;
    var day = new Date(date);
    var weekend = (day.getDay() === 0 || day.getDay() === 6);
    var id = 'w' + ymd(w.mon) + (weekend ? 'we' : '');
    var list = hwList();
    for(var i = 0; i < list.length; i++){ if(String(list[i].id) === id) return list[i]; }
    if(AUTO_CACHE[id]) return AUTO_CACHE[id];

    var sat = new Date(w.mon.getTime()); sat.setDate(sat.getDate() + 5);
    var p = { id: id, _auto: true, title: periodTitle(w.no, weekend), items: [] };
    if(weekend){
      /* 周末作业从「周作业结束日的下一天」开始 —— 站主把这一周改到周六，
         周末就自动只剩周日；改到周日就整段没有周末作业。 */
      var from = new Date(sat.getTime());
      for(var j = 0; j < list.length; j++){
        var wk = list[j];
        if(String(wk.id) !== ('w' + ymd(w.mon))) continue;
        var e = new Date(String(wk.end || '').slice(0, 10) + 'T00:00:00');
        if(!isNaN(e.getTime()) && e >= w.mon){
          from = new Date(e.getTime()); from.setDate(from.getDate() + 1);
        }
      }
      if(from > w.sun) return null;      /* 这一周没有周末了 */
      p.start = ymd(from); p.end = ymd(w.sun);
    }else{
      var fri = new Date(w.mon.getTime()); fri.setDate(fri.getDate() + 4);
      p.start = ymd(w.mon); p.end = ymd(fri);   /* 默认周一 ~ 周五；要连周六写在「设置」里改 */
    }
    AUTO_CACHE[id] = p;
    return p;
  }
  /* 真正写内容了才把这份 _auto 收进列表；站主要「空壳不存」 */
  function materialize(hw){
    if(!hw) return hw;
    var list = hwList();
    for(var i = 0; i < list.length; i++){
      if(String(list[i].id) === String(hw.id)){ delete hw._auto; return list[i]; }
    }
    if(!hw._auto) return hw;
    delete hw._auto;
    list.push(hw);
    return hw;
  }
  BIG.weekOf = weekOf;
  BIG.ensurePeriod = ensurePeriod;
  BIG.periodTitle = periodTitle;


  /* ================= 本机编辑 / 本机改动（v4.7.1 · 站主第 2 条）=================
     站主原话：「班级电脑的作业界面无法新增、修改作业，压根没有对应按钮。」
     根因：编辑能力一直只挂在 adminOk() 上，而班级电脑长期离线、不可能登录管理员，
     于是整块编辑 UI 连渲染都不渲染。

     现在把两件事拆开：
       · 能不能编辑 —— 任何设备点顶栏「编辑」就能改，改动存本机，离线也生效；
       · 能不能上传 —— 仍然只有管理员登录时才会上云（权限口径没变）。
     本机改动单独存一份（HW_LOCAL_KEY），优先级高于云端那份：
       · 存在未上传改动时，12 秒轮询不会拿云端覆盖它（见 pollAlerts）；
       · 顶栏挂「上传 / 放弃」两个按钮，由人决定怎么处理，不会静默丢。 */
  var HW_LOCAL_KEY = 'cls_hw_local_v1';
  var HW_EDIT_KEY  = 'cls_hw_edit';

  function hwEditOn(){
    try{ return localStorage.getItem(HW_EDIT_KEY) === '1'; }catch(e){ return false; }
  }
  BIG.hwEditOn = hwEditOn;

  /* 读一次缓存在内存里：hwList() 被调得很频繁（渲染、排版、比对），
     每次都 JSON.parse 一份作业列表在低配一体机上会白掉帧。 */
  var _hwLocalCache;
  function hwLocalRec(){
    if(_hwLocalCache !== undefined) return _hwLocalCache;
    _hwLocalCache = null;
    try{
      var o = JSON.parse(localStorage.getItem(HW_LOCAL_KEY) || 'null');
      if(o && Array.isArray(o.list)) _hwLocalCache = o;
    }catch(e){}
    return _hwLocalCache;
  }
  function hwLocalPending(){ return !!hwLocalRec(); }
  BIG.hwLocalPending = hwLocalPending;

  function hwLocalSave(list){
    var rec = { at: Date.now(), list: list || [] };
    _hwLocalCache = rec;
    try{ localStorage.setItem(HW_LOCAL_KEY, JSON.stringify(rec)); }catch(e){}
  }
  function hwLocalClear(){
    _hwLocalCache = null;
    try{ localStorage.removeItem(HW_LOCAL_KEY); }catch(e){}
  }

  /* v4.10.2（站主第 5 条）：「之前设计是在上面的标题功能栏里点『编辑』才能编辑，
     点『完成』之后就不能编辑了？现在怎么是可以直接编辑的？」
     —— 之前 v4.7.1 把权限改成了「管理员登录 OR 本机编辑开关」，
     结果管理员一登录就永远处于可编辑态，顶部那个「编辑 / 完成」按钮反而成了摆设。
     现在改回站主要的原设计：**能不能编辑，只看顶部那个开关**。
     管理员身份只决定「改完能不能上云」，不再影响「能不能改」。 */
  function canEdit(){ return hwEditOn(); }

  /* 有本机未上传的改动就优先用它 —— 否则云端一轮同步就把离线改的东西冲掉了 */
  function hwList(){
    var rec = hwLocalRec();
    if(rec) return rec.list;
    return (data().holidayHomeworks || []);
  }

  /* v4.9.1（站主第 2 条）：「作业筛选按时间顺序来，不能按我添加的顺序」。
     期次下拉 / 历史列表原来直接 list.slice().reverse() —— 那是**录入顺序**倒过来，
     后补录的旧假期会排到最前面。这里统一按开始日期（缺则结束日期）排，
     同一天的再按结束日期、标题兜底，保证每次打开顺序都一样。 */
  function hwSortDesc(list){
    return (list || []).slice().sort(function (a, b){
      var x = String((a && (a.start || a.end)) || '');
      var y = String((b && (b.start || b.end)) || '');
      if(x !== y) return x < y ? 1 : -1;
      var xe = String((a && a.end) || ''), ye = String((b && b.end) || '');
      if(xe !== ye) return xe < ye ? 1 : -1;
      return String((a && a.title) || '') < String((b && b.title) || '') ? 1 : -1;
    });
  }
  BIG.hwSortDesc = hwSortDesc;

  /* v4.3.0（站主第 4 条）：没手动选期次时，只认「今天落在起止日期之内」的那一期。
     以前兜底取 list 最后一条 —— 那是「上一次作业」，学生放假回来第一天看到的是旧作业，
     会以为今天还要写。现在没有就返回 null，页面显示「当前没有作业」。 */
  function currentHw(){
    var list = hwList();
    if(BIG.hwId){
      for(var i = 0; i < list.length; i++){ if(String(list[i].id) === String(BIG.hwId)) return list[i]; }
    }
    /* v4.12.0：有日历锚点就按那一天找（可以提前编辑未来某一周 / 周末），
       否则还是按今天。找实体期次优先，找不到就造那一天的自动期次。 */
    var t = BIG.hwViewDate || todayStr(), hit = null;
    for(var j = 0; j < list.length; j++){
      var x = list[j];
      var s = String(x.start || '').slice(0, 10) || String(x.end || '').slice(0, 10);
      var e = String(x.end || '').slice(0, 10) || s;
      if(!s) continue;
      if(s <= t && t <= e){
        /* 万一有两期重叠，取日期更靠近锚点的（结束日期更晚的那期） */
        if(!hit || e > (String(hit.end || '').slice(0, 10))) hit = x;
      }
    }
    if(hit) return hit;
    var d = new Date(t + 'T00:00:00');
    if(!isNaN(d.getTime())){
      var p = ensurePeriod(d);
      if(p) return p;
    }
    /* v4.11.0：今天不在任何实体期次里，就落到「本周自动期次」——
       站主要「系统自动帮我建好」，不需要人先点新建。这一份是内存里的 _auto，
       一个字都没改就离开的话不会写进云端。 */
    return ensurePeriod(new Date());
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

  function taskHtml(it, si, ti, t, edit){
    var o = (t && typeof t === 'object') ? t : { text: String(t == null ? '' : t) };
    var text = o.text || '';
    var over = isOverdue(o);
    var dt = dueText(o, false);
    /* 编辑态用 textarea + 自适应高度：单行 input 装不下长句，字一多就被框子截断。 */
    var main = edit
      ? '<textarea class="bhw-in bhw-area" rows="1" placeholder="输入作业内容"'
        + ' oninput="BIG.autoGrow(this)"'
        + ' onchange="BIG.hwTask(' + si + ',' + ti + ',this.value)">' + esc0(text) + '</textarea>'
      : '<span class="bhw-txt">' + esc0(text) + '</span>';
    /* v4.12.0（站主）：「截止时间那个时钟按钮放在每个作业项的右侧」——
       所以按钮跟删除键并排挂在行尾，不压正文；有截止时间时按钮变实心。 */
    var dueBtn = edit
      ? '<button type="button" class="bhw-duebtn' + (dt ? ' has' : '') + (over ? ' over' : '') + '"'
        + ' title="' + (dt ? esc0(dt) + '，点击修改' : '设置这一项的截止时间') + '"'
        + ' onclick="BIG.dueOpen(' + si + ',' + ti + ',this)">' + ico('timer', 13) + '</button>'
      : '';
    var dueTag = dt
      ? '<span class="bhw-due' + (over ? ' over' : '') + '">' + esc0(dt) + '</span>'
      : '';
    return '<div class="bhw-task' + (over ? ' over' : '') + '">'
      + '<span class="bhw-dot"></span>'
      + '<div style="flex:1;min-width:0">' + main + mediaHtml(o) + dueTag + '</div>'
      + dueBtn
      + (edit ? '<button type="button" class="bhw-x" title="删除这一项"'
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

  /* v4.10.2（站主第 5 条）：第三个参数是「能不能编辑」（edit），
     不是「是不是管理员」—— 只有点了顶部「编辑」开关才传 true，
     这样卡片上的输入框、删除键、「添加一项」按钮才出现。
     （以前这里传的是 adminOk()，导致管理员不看开关也能改。） */
  function subjCard(it, si, edit){
    var name = String(it.subject || '');
    var tasks = it.tasks || [];
    var st = subjStyle(name);
    var accent = st.c || '#9a3412';
    var head = '<div class="bhw-subj-h">'
      + (edit
          ? '<input class="bhw-in" value="' + attr0(name) + '" placeholder="科目"'
            + ' onchange="BIG.hwSubjName(' + si + ',this.value)"'
            + ' style="flex:none;max-width:7em;font-weight:900;color:' + attr0(accent) + '">'
          : '<b style="color:' + attr0(accent) + '">' + esc0(name) + '</b>')
      + '<span class="bhw-cnt">' + tasks.length + ' 项</span>'
      + (edit ? '<button type="button" class="bhw-x" title="删除这一科"'
          + ' onclick="BIG.hwDelSubj(' + si + ')">' + ico('trash', 13) + '</button>' : '')
      + '</div>';

    /* v4.12.0（站主）：「过期项默认隐藏，编辑态可见」。
       只读态把过了截止时间的小项收进「已截止 N 项」，点开才铺开（灰字）；
       编辑态一项不藏，方便改时间或删掉。原始 ti 一直跟着数据走，
       过滤只影响「显示哪些」，不会打乱 hwTask / hwDelTask 的索引。 */
    var visIdx = [], overIdx = [];
    tasks.forEach(function (t, ti){
      if(!edit && isOverdue(t)) overIdx.push(ti); else visIdx.push(ti);
    });
    var rows = visIdx.map(function (ti){ return taskHtml(it, si, ti, tasks[ti], edit); }).join('');
    var fold = '';
    if(overIdx.length){
      var key = 's' + si;
      var open = !!BIG._dueOpen[key];
      fold = '<button type="button" class="bhw-duefold' + (open ? ' on' : '') + '"'
        + ' aria-expanded="' + (open ? 'true' : 'false') + '"'
        + ' onclick="BIG.dueFold(this,\'' + key + '\')">'
        + ico('timer', 12) + ' 已截止 ' + overIdx.length + ' 项'
        + '<span class="bhw-duefold-ar">' + (open ? '收起' : '展开') + '</span></button>'
        + '<div class="bhw-duehidden"' + (open ? '' : ' hidden') + '>'
        + overIdx.map(function (ti){ return taskHtml(it, si, ti, tasks[ti], false); }).join('')
        + '</div>';
    }

    /* v4.10.2（站主第 2 条）：给卡片一个**稳定标识**（期次内科目序号）。
       以前排版算法拿「DOM 里的先后」当排序依据 —— 卡片一旦被搬过，
       下次再排结果就变了，于是每次刷新卡片都换位置，看起来就是「闪一下」。
       有了稳定 key，同一张卡每次都排在同一个位置。 */
    return '<div class="bhw-subj" data-hwkey="s' + si + '" style="border-left:4px solid ' + attr0(accent) + '">'
      + head + rows + fold
      + (edit ? '<button type="button" class="bhw-add" onclick="BIG.hwAddTask(' + si + ')">'
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
    /* v4.10.8（站主）：「大屏模式里面的作业看板只支持管理员访问，普通用户可以用大屏模式，
       但是不能点击作业看板。」大屏作业页里有作业内容、点名、改作业这些管理动作，
       同学在大屏上点进来容易误改，直接挡住。 */
    if(!adminOk()){
      toast('作业看板仅管理员可查看');
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
    try{ BIG.examLoad(); }catch(e){}   /* v4.10.6：每次进作业页都刷新一次考试 */
    startClock();
  };

  BIG.closeHw = function (){
    if(BIG.lockOn) BIG.lockToggle();
    leaveHwUi();
    try{ goHomeView(); }catch(e){}
  };

  /* v4.12.0：底部日期条。一整周七天，点哪天落到那天的期次；
     左右翻周，右边「日历」开整月网格；不在今天时给一个「回今天」。 */
  function renderDateStrip(){
    var host = $('bhwDateStrip'); if(!host) return;
    var anchor = hwAnchor();
    var d0 = new Date(anchor + 'T00:00:00');
    var w = weekOf(d0);
    if(!w || isNaN(d0.getTime())){ host.innerHTML = ''; return; }
    var hw = currentHw();
    var s = String((hw && hw.start) || '').slice(0, 10);
    var e = String((hw && hw.end) || '').slice(0, 10);
    var today = todayStr();
    var wkName = ['一','二','三','四','五','六','日'];
    var html = '<button type="button" class="ds-nav" onclick="BIG.hwWeekShift(-1)" title="上一周">‹</button>'
      + '<div class="ds-week"><span class="ds-weekno">第 ' + w.no + ' 周</span><div class="ds-days">';
    for(var i = 0; i < 7; i++){
      var d = new Date(w.mon.getTime()); d.setDate(d.getDate() + i);
      var ds = ymd(d);
      var inRange = !!(s && e && ds >= s && ds <= e);
      var cls = 'ds-day' + (i >= 5 ? ' we' : '') + (inRange ? ' inrange' : '')
        + (ds === today ? ' today' : '') + (ds === anchor ? ' cur' : '');
      html += '<button type="button" class="' + cls + '" onclick="BIG.hwJumpTo(\'' + ds + '\')"'
        + ' title="' + ds + (inRange ? ' · 当前期次' : '') + '">'
        + '<span class="ds-w">' + wkName[i] + '</span><span class="ds-d">' + d.getDate() + '</span></button>';
    }
    html += '</div></div>'
      + '<button type="button" class="ds-nav" onclick="BIG.hwWeekShift(1)" title="下一周">›</button>'
      + '<button type="button" class="ds-cal" onclick="BIG.calOpen()" title="打开整月日历">日历</button>'
      + (BIG.hwViewDate ? '<button type="button" class="ds-today" onclick="BIG.hwToday()">回今天</button>' : '');
    host.innerHTML = html;
  }

  /* 本机改动条：渲染与「改完就地补一条」共用同一段 HTML */
  function localStripHtml(){
    if(!hwLocalPending()) return '';
    return '<span class="bhw-local" title="这些改动只存在这台电脑上">'
      + '本机改动'
      + (adminOk() ? '<button type="button" onclick="BIG.hwLocalUpload()">上传</button>' : '')
      + '<button type="button" onclick="BIG.hwLocalDiscard()">放弃</button></span>';
  }
  /* 保存后只补这一条，不整页重画 —— 重画会把正在输入的光标弄丢 */
  function refreshLocalStrip(){
    var act = $('bhwActions'); if(!act) return;
    var ex = act.querySelector('.bhw-local');
    var html = localStripHtml();
    if(!html){ if(ex && ex.parentNode) ex.parentNode.removeChild(ex); return; }
    if(ex){ ex.outerHTML = html; return; }
    var sync = act.querySelector('#bhwSync');
    if(sync) sync.insertAdjacentHTML('afterend', html);
    else act.insertAdjacentHTML('afterbegin', html);
  }

  /* v4.7.3（站主）：「刷新的时候我正好在打字，输入框就没了」。
     即使判断不出「在编辑」，重绘也会让光标和滚动位置飞掉。
     所以每次重绘前后都把「焦点在哪个框、光标在第几字、滚到哪儿了」抄下来再放回去。
     路径用从 #bigHw 往下的 childNodes 索引链表示 —— 同一份数据重绘出来的结构一致，
     索引链必然还能对上同一个框。 */
  function domPath(root, el){
    var path = [];
    var cur = el;
    while(cur && cur !== root){
      var p = cur.parentNode;
      if(!p) return null;
      var i = 0, n = p.firstChild;
      while(n && n !== cur){ i++; n = n.nextSibling; }
      path.unshift(i);
      cur = p;
    }
    return path;
  }
  function domAt(root, path){
    var cur = root;
    for(var i = 0; i < path.length; i++){
      if(!cur) return null;
      cur = cur.childNodes[path[i]];
    }
    return cur;
  }
  function snapshotEdit(){
    var host = $('bigHw');
    if(!host) return null;
    var out = { focus: null, scroll: [], dirty: [] };
    var ae = document.activeElement;
    if(ae && ae !== document.body && host.contains(ae) && /^(INPUT|TEXTAREA)$/.test(String(ae.tagName || '').toUpperCase())){
      var path = domPath(host, ae);
      if(path){
        out.focus = { path: path, s: ae.selectionStart, e: ae.selectionEnd };
      }
    }
    /* v4.7.3：还没提交的输入（改了值但没失焦）也要抄下来 ——
       重绘后按原位置把字填回去，人才不会「打到一半全没了」。
       数据本身不动：这是用户还没确认的内容，只在界面上原样搬一次。 */
    var ips = host.querySelectorAll('input,textarea');
    for(var q = 0; q < ips.length; q++){
      var el = ips[q];
      var tp = String(el.type || '').toLowerCase();
      if(tp === 'checkbox' || tp === 'radio' || tp === 'file') continue;
      if(String(el.value) === String(el.defaultValue)) continue;
      var pp = domPath(host, el);
      if(!pp) continue;
      out.dirty.push({ path: pp, value: el.value,
        s: el.selectionStart, e: el.selectionEnd });
    }
    /* 作业页可能有好几个滚动容器（两栏 + 其他科目），一起记 */
    var box = host.querySelectorAll('.bhw-col,.bhw-other,#bhwColA,#bhwColB');
    for(var i = 0; i < box.length; i++){
      if(box[i].scrollTop) out.scroll.push({ path: domPath(host, box[i]), top: box[i].scrollTop });
    }
    var de = document.scrollingElement || document.documentElement;
    out.winTop = de ? de.scrollTop : 0;
    return out;
  }
  function restoreEdit(snap){
    if(!snap) return;
    var host = $('bigHw');
    if(!host) return;
    for(var i = 0; i < snap.scroll.length; i++){
      var el = snap.scroll[i].path ? domAt(host, snap.scroll[i].path) : null;
      if(el) el.scrollTop = snap.scroll[i].top;
    }
    /* 先回填未提交的内容，再放光标 —— 顺序反了会把光标顶到末尾 */
    for(var d = 0; d < snap.dirty.length; d++){
      var de2 = snap.dirty[d];
      var dEl = de2.path ? domAt(host, de2.path) : null;
      if(!dEl) continue;
      dEl.value = de2.value;
      if(dEl.tagName === 'TEXTAREA' && dEl.style && dEl.scrollHeight) BIG.autoGrow(dEl);
    }
    if(snap.focus){
      var t = domAt(host, snap.focus.path);
      if(t && t.focus){
        try{
          t.focus({ preventScroll: true });
          if(snap.focus.s != null && t.setSelectionRange){
            t.setSelectionRange(snap.focus.s, snap.focus.e);
          }
        }catch(e){}
      }
    }
  }

  BIG.renderHw = function (){
    var snap = snapshotEdit();
    renderHwRaw();
    restoreEdit(snap);
  };

  function renderHwRaw(){
    var h = $('bigHw');
    if(!h) return;
    var hw = currentHw();
    renderDateStrip();      /* v4.12.0：日期条常驻，空态也要能翻期次 */
    /* v4.10.2（站主第 5 条）：把两件事彻底拆开。
       · edit  = 顶部「编辑 / 完成」开关开没开 → 决定**卡片能不能改**
                 （输入框、删除按钮、「添加一项」「添加科目」都归它管）；
       · admin = 有没有登录管理员 → 只决定**改动往哪存**
                 （本机还是云端）以及哪些管理按钮可见。
       以前这两件事被 canEdit() 混成一个「admin」变量，
       结果管理员一登录卡片就直接能改，顶部那个「编辑」按钮形同虚设。 */
    var edit = canEdit();
    var admin = adminOk();
    var list = hwList();
    var act = $('bhwActions');
    var brand = $('bhwBrand');
    if(brand){
      var nm = '';
      try{
        /* v4.10.1：大屏下标题卡被搬到 .sidebar 前面（big-brand-top），
           不能再只认 .content>header，否则作业页顶栏拿不到站名 */
        var h1 = document.querySelector('header.big-brand-top h1') || document.querySelector('.content>header h1');
        if(h1) nm = String(h1.textContent || '').trim();
      }catch(e){}
      brand.textContent = nm || '班级服务站';
    }

    /* 期次下拉 + 重命名 + 新建（管理员才有后两个） */
    if(act){
      var sel = '<select class="bhw-sel" onchange="BIG.hwPick(this.value)" title="切换作业期次">'
        + '<option value="">当前作业</option>'
        + hwSortDesc(list).map(function (x){
            return '<option value="' + attr0(x.id) + '"'
              + (hw && String(x.id) === String(hw.id) ? ' selected' : '') + '>'
              + esc0(x.title || '未命名') + '</option>';
          }).join('')
        + '</select>';
      act.innerHTML = '<span class="bhw-sync" id="bhwSync" role="button" tabindex="0"'
        + ' title="点击立即从云端刷新作业" onclick="BIG.hwRefreshNow()"'
        + ' onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();BIG.hwRefreshNow();}"></span>'
        + sel
        /* v4.7.1：本机改动条。只有存过本机修改时才出现，平时不占位置。 */
        + localStripHtml()
        + (admin && hw ? '<button type="button" class="bhw-btn ghost" onclick="BIG.hwRename()">重命名</button>' : '')
        + (admin ? '<button type="button" class="bhw-btn ghost" onclick="BIG.hwExport()" title="导出作业文件">导出</button>' : '')
        + (admin ? '<button type="button" class="bhw-btn ghost" onclick="BIG.hwImport()" title="从文件导入作业">导入</button>' : '')
        /* v4.10.2（站主第 5 条）：编辑开关**人人都能点**（原来只有非管理员才有）。
           点「编辑」→ 卡片变成可编辑；点「完成」→ 变回只读。
           管理员登录与否只影响改动往哪存，不影响能不能改。 */
        + '<button type="button" class="bhw-btn' + (hwEditOn() ? '' : ' ghost') + '"'
          + ' onclick="BIG.hwEditToggle()" title="点「编辑」后作业卡片才能改，点「完成」恢复只读">'
          + (hwEditOn() ? '完成' : '编辑') + '</button>'
        /* v4.11.0（站主第 4 条）：「新建一期」去掉 —— 期次按周自动就有了；
           换成「设置」，用来改这一周的起止（周三四放假那种情况）。 */
        + (edit ? '<button type="button" class="bhw-btn" onclick="BIG.hwWeekSetting()"'
          + ' title="调整这一周的起止日期">设置</button>' : '')
        /* v4.7.1：真全屏（连任务栏一起盖掉），投影 / 一体机上用 */
        + '<button type="button" class="bhw-btn ghost bhw-full" onclick="BIG.hwFull()"'
          + ' id="bhwFullBtn" title="全屏显示（隐藏任务栏），按 Esc 退出">⛶ 全屏</button>';
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
      paintExam();          /* v4.10.6：没有作业时也要能看到今天考什么 */
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

    /* v4.10.2（站主第 2 条）：「刷新的时候卡片会重新排列，会突然闪一下。
       如果没有新增特别多内容、不造成卡片大小更改的话，不要让卡片突然闪一下。」

       根因：以前每次重绘都 `colA.innerHTML = mainHtml` —— **整块推倒重建**。
       ① 所有卡片节点被销毁再新建 → 浏览器要重新排版、重新画一遍 → 视觉上就是「闪一下」；
       ② 新节点没有旧节点的高度记忆 → layoutCards 量出来的顺序可能变 → 卡片换位置。

       现在改成**按卡片增量更新**：
         · 每张卡有稳定 key（data-hwkey）；
         · 新旧 HTML 一模一样 → 直接把旧节点搬过去，DOM 完全不重建（零闪烁）；
         · 只有真的改了内容的那几张卡才重建；
         · 顺序也由 layoutCards 按稳定 key 决定（见 layoutCards 里的排序说明）。 */
    var cards = [];
    SUBJ_A.concat(SUBJ_B).forEach(function (k){
      var hit = mapA[k] || mapB[k];
      if(hit) cards.push({ key: 's' + hit.si, html: subjCard(hit.it, hit.si, edit) });
    });
    var emptyHtml = '<div class="bhw-subj"><div class="bhw-empty">'
      + (edit ? '这一周还没有科目，点下面按钮加一科。' : '这一周暂时没有作业。') + '</div></div>';
    /* 两栏合起来算 —— layoutCards 会把卡片在两栏之间搬，只看一栏会重复/漏掉 */
    var pool = [].slice.call(colA.children).concat([].slice.call(colB.children));
    pool = pool.filter(isCard);
    if(!cards.length){
      colA.innerHTML = emptyHtml;
      colB.innerHTML = '';
    }else{
      /* 所有主科目卡先统一放进 colA，再由 layoutCards 按高度分到两栏。
         applyCards 会把原来在 colB 的节点搬回 colA（复用的节点直接搬，DOM 不重建）。 */
      applyCards(colA, cards, pool);
      /* colB 里的旧位置现在都空了 —— 清掉，layoutCards 稍后会重新往里放 */
      colB.innerHTML = '';
    }

    if(other){
      var exCards = extras.map(function (x){
        return { key: 's' + x.si, html: subjCard(x.it, x.si, edit) };
      });
      var exPool = other ? [].slice.call(other.children).filter(isCard) : [];
      if(exCards.length){
        if(other) applyCards(other, exCards, exPool);
      }else if(other){
        other.innerHTML = '';
      }
    }

    /* v4.11.0（站主第 4 条）：「底部新增 7 个按钮 —— 语数英物化生 + 其他，
       点一下自动建对应科目卡」。原来的「科目名称 + 添加科目」输入框撤掉，
       常驻这排按钮，缺哪科点哪科；已经有了的置灰。 */
    if(addHost){
      addHost.innerHTML = edit
        ? PRESET_SUBJECTS.map(function (s){
            var has = (hw.items || []).some(function (it){ return String(it.subject || '').trim() === s; });
            return '<button type="button" class="bhw-subjbtn' + (has ? ' has' : '') + '"'
              + ' onclick="BIG.hwQuickSubj(\'' + s + '\')" title="' + (has ? s + ' 已存在' : '添加' + s) + '">'
              + s + '</button>';
          }).join('')
          + '<button type="button" class="bhw-subjbtn" onclick="BIG.hwQuickSubj(\'其他\')" title="添加其他科目">其他</button>'
          + '<span class="bhw-save" id="bhwSave"></span>'
        : '';
    }

    renderSide();
    paintExam();            /* v4.10.6：考试块固定钉在左栏最上面 */
    scheduleLayout();
    /* v4.7.0：记下「屏幕上这一份」是什么样，下一次轮询拿它做基准比差异 */
    try{ BIG.hwPrevData = hwList(); BIG.hwPrev = JSON.stringify(BIG.hwPrevData || []); }catch(e){}
  }

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

  /* v4.10.2（站主第 2 条）：按卡片增量更新，避免整块 innerHTML 重建导致闪烁。
     cards: [{ key, html }]（按期望顺序）
     pool : 现有卡片节点（两栏合起来的）
     规则：同 key 且 HTML 完全一样 → **复用旧节点**（DOM 不重建，零闪烁）；
           HTML 变了 → 只重建这一张；新 key → 新建；旧 key 多余 → 删掉。 */
  function applyCards(host, cards, pool){
    if(!host) return;
    var byKey = {};
    (pool || []).forEach(function(el){
      var k = el.getAttribute ? el.getAttribute('data-hwkey') : '';
      if(k && !byKey[k]) byKey[k] = el;
    });
    var used = {};
    var frag = document.createDocumentFragment();
    cards.forEach(function(c){
      var el = byKey[c.key];
      used[c.key] = 1;
      if(el){
        /* 内容没变 → 旧节点原地留着，连 innerHTML 都不碰 */
        if(el.__hwHtml !== c.html){
          /* v4.10.3（站主：「点击编辑后旁边颜色出现两层，底下还有一层，
             点完成也没恢复」）：
             以前这里是 `el.innerHTML = c.html` —— **c.html 本身就是一整张
             `<div class="bhw-subj" data-hwkey="s0">…</div>` 卡片**，
             直接塞进 el.innerHTML 等于「卡片里再套一张卡片」：
               · 外层 el 自己带 4px 彩色左边框 → 看到「两层颜色」；
               · 内层又带一条 → 「底下还有一层」；
               · 而且内层也带 data-hwkey，切回只读再套一层，永远消不掉。
             现在改成：把新卡片的**内部内容**搬进旧节点，再把新卡片的外层
             属性（彩色边框等）同步过来。节点本身还是原来那个（DOM 复用保留，
             滚动位置/焦点路径都不变）。 */
          var d2 = document.createElement('div');
          d2.innerHTML = c.html;
          var nf = d2.firstElementChild;
          if(nf){
            el.innerHTML = nf.innerHTML;
            /* 外层属性同步（style 里是彩色左边框，data-hwkey 保持不变） */
            var attrs = nf.attributes;
            for(var ai = 0; ai < attrs.length; ai++){
              var an = attrs[ai];
              if(an.name === 'data-hwkey') continue;
              if(an.name === 'style'){
                el.setAttribute('style', an.value);
              }else if(el.getAttribute(an.name) !== an.value){
                el.setAttribute(an.name, an.value);
              }
            }
          }
          el.__hwHtml = c.html;
        }
        frag.appendChild(el);
      }else{
        var d = document.createElement('div');
        d.innerHTML = c.html;
        var first = d.firstElementChild;
        if(first){
          first.__hwHtml = c.html;
          frag.appendChild(first);
        }
      }
    });
    /* 用不上的旧卡片删掉 */
    Object.keys(byKey).forEach(function(k){
      if(used[k]) return;
      var el = byKey[k];
      if(el.parentNode) el.parentNode.removeChild(el);
    });
    host.innerHTML = '';
    host.appendChild(frag);
  }
  /* v4.10.11（站主）：「两种尺寸，小尺寸放在左边的 1/3 屏，大尺寸放在右边的 2/3 屏，
     这个尺寸其实就是长度尺寸……如果科目的那些文字都比较短，你就放在左边的 1/3 屏，
     如果它文字比较长的话，你就放在右边的 2/3 屏」。
     判据不猜字数 —— 把同一张卡分别塞进窄栏与宽栏量一次自然高度：
     窄栏里明显变高（多折了好几行）就归大卡，否则小卡。 */
  function cardKeyNo(k){
    var m = /^s(\d+)$/.exec(String(k || ''));
    return m ? Number(m[1]) : 9999;
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

    var planA = [], planB = [];
    cards.forEach(function (el, i){
      var k = String(el.getAttribute('data-hwkey') || ('i' + i));
      /* 放进左栏（1/3 宽）量：只要有一项文字折成了两行以上，就说明这科「文字比较长」，
         该去右栏当大卡；全都一行放得下 → 小卡留左栏。
         不按字数猜 —— 中英文混排、字号缩放都会影响实际宽度，直接看渲染结果最准。 */
      colA.appendChild(el);
      var big = false;
      var ts = el.querySelectorAll('.bhw-txt,.bhw-area');
      for(var ti = 0; ti < ts.length; ti++){
        var tx = ts[ti];
        var cs = window.getComputedStyle(tx);
        var lh = parseFloat(cs.lineHeight);
        if(!lh || isNaN(lh)) lh = (parseFloat(cs.fontSize) || 16) * 1.5;
        /* ⚠️ .bhw-txt 是 inline span，clientHeight 恒为 0 —— 必须量 rect 高度 */
        var hh = tx.getBoundingClientRect().height;
        if(hh > lh * 1.45){ big = true; break; }
      }
      (big ? planB : planA).push({ el: el, k: k });
    });
    /* 栏内按科目顺序排（而不是按高度）—— 语文、数学、英语一眼能顺着找，
       位置也不会因为某一科多写两行就跳来跳去 */
    var byKey = function (a, b){
      var x = cardKeyNo(a.k), y = cardKeyNo(b.k);
      if(x !== y) return x - y;
      return a.k < b.k ? -1 : (a.k > b.k ? 1 : 0);
    };
    planA.sort(byKey);
    planB.sort(byKey);

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
    /* v4.10.6：「新增考试」只给管理员 —— 写回考试看板要管理员身份 */
    var eb = $('bhwExamAdd');
    if(eb) eb.style.display = adminOk() ? '' : 'none';
    var c = $('bhwCourses');
    if(c){
      var txt = '', sub = '';
      try{
        if(typeof islandToday === 'function' && typeof ISLAND !== 'undefined' && ISLAND && ISLAND.on){
          var t = islandToday(0);
          if(t){
            if(t.kind === 'holiday'){
              /* v4.7.9：口径跟首页横幅统一 —— 不再「距开学 N 天」（结束日被多数一次），
                 不足 24 小时直接说小时。
                 v4.10.5：开始日 >= 12:00 时，当天是「今晚开始」而不是「第 1 天」。 */
              txt = t.startTonight
                ? ((t.label || '放假中') + ' · 今晚 ' + (t.fromTime || '') + ' 起 · 共 ' + t.totalDays + ' 天')
                : ((t.label || '放假中') + ' · 放假第 ' + t.dayNo + ' 天 · 还剩 '
                   + (typeof islLeftText === 'function' ? islLeftText(t.leftMs) : ''));
            }
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

  /* v4.10.12（站主）：「大屏里面的今日事项里面这个倒计时……是通过本机的时间去实时的更新的」。
     侧栏这块显示的是「放假第 N 天 · 还剩 4 小时 54 分」，以前只在重绘时才重算 ——
     跟倒计时同一个毛病。这里每秒按本机时间重算这一行字，结构不动。 */
  function sideTick(){
    var c = $('bhwCourses');
    if(!c || c.style.display === 'none') return;
    var b = c.querySelector('.bhw-mini-v');
    if(!b) return;
    var tt = null;
    try{
      if(typeof islandToday === 'function' && typeof ISLAND !== 'undefined' && ISLAND && ISLAND.on){
        tt = islandToday(0);
      }
    }catch(e){}
    /* 只有「正在放假、且已过放假时刻」才带剩余时间；其余状态交给整块重绘 */
    if(!tt || tt.kind !== 'holiday' || tt.startTonight) return;
    var txt = (tt.label || '放假中') + ' · 放假第 ' + tt.dayNo + ' 天 · 还剩 '
      + (typeof islLeftText === 'function' ? islLeftText(tt.leftMs) : '');
    if(b.textContent !== txt) b.textContent = txt;
  }
  BIG.sideTick = sideTick;

  /* ---------------- 考试（v4.10.10） ----------------
     站主原话（2026-11-08 第二轮）：
       「顶部写考试名称，第二行写第一天的日期，第三行这些就写第一天的科目，
         后面是第二天的日期，再后面是第二天的科目」
       「一般考试不会超过两天，单天最多不会超过四科」
       「考试只保留一天 —— 昨天还能看到，颜色更淡；前天就自动隐藏，
         空出来的位置给后面继续显示」
       「多场合并，重复的只显示一次；本周肯定包含今天，所以要合并」
       「考试时间和科目用亮一点的颜色，类似作业的那种文字」

     所以这块：
       · 块头一场考试一个名字；混着好几场就写「考试安排」
       · 块内「12/1 周一」小标题 + 该天每科一行（科目左、时间右）
       · 只画今天和昨天；最多 6 科，前面的过期后后面自动补位
       · 字号走 --bhw-fs，跟作业正文一起缩放

     数据从哪来：/api/exams?action=list —— 后端按考试群分好组，前端只算「哪天显示」。
     整份响应缓存在 cls_big_exam_v2：断网时弹窗和作业看板都还有东西看。 */
  var EXAM_KEY = 'cls_big_exam_v2';
  var EXAM_TTL = 5 * 60 * 1000;      /* 5 分钟主动刷一次，够用又不打上游 */
  var EXAM_LIMIT = 6;                /* 作业看板上最多 6 科，多的等前面的过期补位 */

  BIG.examList = {
    groups: [], pins: { majors: [], days: [], items: [] },
    today: '', term: null, base: '', title: '', cls: '', at: 0, cacheAt: 0,
  };
  BIG.exam = { at: 0, loaded: false, busy: false };
  BIG.examScope = '';        /* 弹窗当前筛选档位，空 = 还没定 */
  BIG.examOpen = {};         /* 弹窗里哪几场是展开的 */
  BIG.examLoading = false;

  function examToday(d){
    var t = d || new Date();
    var p = function (n){ return (n < 10 ? '0' : '') + n; };
    return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
  }
  function examDateOf(day){
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function examWeekCn(day){
    var d = examDateOf(day);
    return d ? '周' + '日一二三四五六'[d.getDay()] : '';
  }
  function examShift(day, n){
    var d = examDateOf(day);
    if(!d) return '';
    d.setDate(d.getDate() + n);
    return examToday(d);
  }
  /** 这一周的周一 */
  function examMon(day){
    var d = examDateOf(day);
    if(!d) return '';
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return examToday(d);
  }
  function examMD(day){
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
    return m ? (+m[2]) + '/' + (+m[3]) : String(day || '');
  }
  /** 「今天 · 12/1 周一」这种小标题：今天/明天/昨天直接写中文，一眼能认 */
  function examDayLabel(day, isToday){
    var base = examDateOf(day);
    if(!base) return '';
    var t0 = new Date();
    var diff = Math.round((base - new Date(t0.getFullYear(), t0.getMonth(), t0.getDate())) / 86400000);
    var head = isToday ? '今天' : (diff === 1 ? '明天' : (diff === -1 ? '昨天' : ''));
    return (head ? head + ' · ' : '') + examMD(day) + ' ' + examWeekCn(day);
  }

  function examCacheGet(){
    try{
      var o = JSON.parse(localStorage.getItem(EXAM_KEY) || 'null');
      if(o && Array.isArray(o.groups)) return o;
    }catch(e){}
    return null;
  }
  function examApply(j, fromCache){
    if(!j || !Array.isArray(j.groups)) return;
    BIG.examList = {
      groups: j.groups,
      pins: j.pins || { majors: [], days: [], items: [] },
      today: String(j.today || examToday()),
      term: j.term || null,
      base: String(j.base || ''),
      title: String(j.title || ''),
      cls: String(j.cls || ''),
      at: Number(j.at || 0),
      cacheAt: fromCache ? Number(j.cacheAt || 0) : Date.now(),
    };
    BIG.exam.at = BIG.examList.at;
    BIG.exam.loaded = true;
    if(!fromCache){
      try{
        localStorage.setItem(EXAM_KEY, JSON.stringify({
          groups: BIG.examList.groups, pins: BIG.examList.pins,
          today: BIG.examList.today, term: BIG.examList.term,
          base: BIG.examList.base, title: BIG.examList.title,
          cls: BIG.examList.cls, at: BIG.examList.at, cacheAt: Date.now(),
        }));
      }catch(e){}
    }
  }

  BIG.examLoad = function (cb, force){
    /* 先上缓存：教室电脑经常一开机就断网 */
    if(!BIG.exam.loaded){
      var c0 = examCacheGet();
      if(c0){ examApply(c0, true); paintExam(); }
    }
    if(typeof api !== 'function'){ if(cb) cb(); return; }
    api('/exams?action=list' + (force ? '&fresh=1' : '')).then(function (j){
      examApply(j, false);
      BIG.exam.loaded = true;
      paintExam();
      if(document.getElementById('bexMask')) examPanelPaint();
      if(cb) cb();
    }).catch(function (){
      BIG.exam.loaded = true;
      if(!BIG.examList.groups.length){
        var c2 = examCacheGet();
        if(c2) examApply(c2, true);
      }
      paintExam();
      if(cb) cb();
    });
  };

  /* -------- 要画哪几天：今天 + 昨天，前天起自动隐藏 -------- */
  function examStops(){
    var L = BIG.examList;
    if(!L || !L.groups || !L.groups.length) return [];
    var today = L.today || examToday();
    var floor = examShift(today, -1);
    var out = [];
    L.groups.forEach(function (g){
      var auto = g.auto === true;      /* 今天落在这一场里 → 这一场所有天都显示 */
      (g.days || []).forEach(function (d){
        if(d.date < floor) return;
        if(!auto && !d.anyOn) return;
        out.push({ g: g, d: d, past: d.date < today });
      });
    });
    out.sort(function (a, b){
      if(a.d.date !== b.d.date) return a.d.date.localeCompare(b.d.date);
      return String(a.g.start).localeCompare(String(b.g.start));
    });
    return out;
  }

  /** 混着好几场时块头写什么：全在本周就「本周考试安排」，否则「考试安排」 */
  function examHeadTitle(stops){
    var today = BIG.examList.today || examToday();
    var a = stops[0].d.date;
    var b = stops[stops.length - 1].d.date;
    var mon = examMon(today);
    if(a >= mon && b <= examShift(mon, 6)) return '本周考试安排';
    if(a >= examShift(mon, 7) && b <= examShift(mon, 13)) return '下周考试安排';
    if(a.slice(0, 7) === today.slice(0, 7) && b.slice(0, 7) === today.slice(0, 7)) return '本月考试安排';
    return '考试安排';
  }

  function examHtml(){
    var stops = examStops();
    if(!stops.length) return '';

    /* 按考试归并；块的先后 = 这场最早那天的先后 */
    var order = [], map = {};
    stops.forEach(function (s){
      if(!map[s.g.id]){ map[s.g.id] = { g: s.g, days: [] }; order.push(s.g.id); }
      map[s.g.id].days.push(s);
    });

    var total = 0;
    stops.forEach(function (s){ total += (s.d.items || []).length; });
    var dayN = {};
    stops.forEach(function (s){ dayN[s.d.date] = 1; });
    var dayCount = Object.keys(dayN).length;

    /* 6 科上限：按天整段装，装不下就停，剩下的只报个数 */
    var used = 0, cut = false, body = '';
    for(var k = 0; k < order.length && !cut; k++){
      var box = map[order[k]];
      var sec = '';
      for(var i = 0; i < box.days.length; i++){
        var s = box.days[i];
        var items = s.d.items || [];
        if(used + items.length > EXAM_LIMIT){ cut = true; break; }
        used += items.length;
        sec += '<div class="bhex-date' + (s.past ? ' bhex-past' : '') + '">'
          + esc0(examDayLabel(s.d.date, s.d.date === BIG.examList.today)) + '</div>';
        items.forEach(function (it){
          sec += '<div class="bhex-row' + (s.past ? ' bhex-off' : '') + '">'
            + '<span class="bhex-sub">' + esc0(it.name || '考试') + '</span>'
            + '<span class="bhex-time">' + esc0(it.start || '') + '–' + esc0(it.end || '') + '</span>'
            + '</div>';
        });
      }
      if(!sec) continue;
      body += order.length > 1
        ? '<div class="bhex-m"><div class="bhex-mname">' + esc0(box.g.name) + '</div>' + sec + '</div>'
        : sec;
    }
    if(!body) return '';

    var head = '<div class="bhex-h">'
      + '<b>' + esc0(order.length > 1 ? examHeadTitle(stops) : map[order[0]].g.name) + '</b>'
      + '<span>' + total + ' 场' + (dayCount > 1 ? ' · ' + dayCount + ' 天' : '') + '</span>'
      + '</div>';

    if(cut && total > used){
      body += '<div class="bhex-more">还有 ' + (total - used) + ' 科 · 前面的考完自动补上</div>';
    }

    return '<div class="bhex" id="bhwExam">' + head + body + '</div>';
  }

  /* 固定钉在左栏最上面：它**不带** .bhw-subj 类，所以不进 layoutCards 的装箱计算，
     也不会被 applyCards 当成科目卡复用。作业重新渲染会把 colA 的卡片搬来搬去，
     所以每次渲染完都要再摆一次。 */
  function paintExam(){
    var colA = $('bhwColA');
    if(!colA) return;
    var html = examHtml();
    var old = document.getElementById('bhwExam');
    if(!html){
      if(old && old.parentNode) old.parentNode.removeChild(old);
      return;
    }
    if(old){
      if(old.__html !== html){
        old.__html = html;
        var box = document.createElement('div');
        box.innerHTML = html;
        var nf = box.firstElementChild;
        if(nf && old.parentNode) old.parentNode.replaceChild(nf, old);
      }else if(colA.firstElementChild !== old){
        colA.insertBefore(old, colA.firstElementChild);
      }
      return;
    }
    var b2 = document.createElement('div');
    b2.innerHTML = html;
    if(b2.firstElementChild) colA.insertBefore(b2.firstElementChild, colA.firstElementChild);
  }
  BIG.examPaint = paintExam;

  /* -------- 考试看板（v4.10.10）--------
     站主原话：
       「我可以一键查看所有的考试数据……最顶上就是前往考试看板」
       「我建议是按照时间去分类，顶上可以筛选时间段：这周、下周、这个月、下个月、
         某个学期」
       「大考分了几天的话，给他列到同一个考试里面，不要单独列」
       「考试的具体信息我是可以折叠的，类似成绩分析那样，只显示考试名称，
         点击箭头之后才展示具体的」
       「前端和后端都能实时刷新……这些都要用缓存，即使没有网络也可以读取之前的缓存」
     所以这一块做四件事：筛档位、折展开、三档挑选、刷新与缓存。 */

  var EXAM_SCOPES = [
    { id: 'week', label: '本周' },
    { id: 'next', label: '下周' },
    { id: 'month', label: '本月' },
    { id: 'nmonth', label: '下月' },
    { id: 'term', label: '本学期' },
    { id: 'all', label: '全部' },
  ];

  function examScopeLabel(id){
    for(var i = 0; i < EXAM_SCOPES.length; i++){
      if(EXAM_SCOPES[i].id === id) return EXAM_SCOPES[i].label;
    }
    return '';
  }

  function examScopeRange(id){
    var t = new Date();
    var y = t.getFullYear(), m = t.getMonth(), d = t.getDate();
    var mon = new Date(y, m, d - ((t.getDay() + 6) % 7));
    var pad = function (n){ return (n < 10 ? '0' : '') + n; };
    var fmt = function (x){ return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()); };
    var add = function (x, n){ return new Date(x.getFullYear(), x.getMonth(), x.getDate() + n); };
    if(id === 'week') return [fmt(mon), fmt(add(mon, 6))];
    if(id === 'next') return [fmt(add(mon, 7)), fmt(add(mon, 13))];
    if(id === 'month') return [fmt(new Date(y, m, 1)), fmt(new Date(y, m + 1, 0))];
    if(id === 'nmonth') return [fmt(new Date(y, m + 1, 1)), fmt(new Date(y, m + 2, 0))];
    if(id === 'term'){
      var tr = BIG.examList.term || {};
      if(tr.start && tr.end) return [tr.start, tr.end];
    }
    return ['0000-01-01', '9999-12-31'];
  }

  /** 默认停在本周；本周没考试就自动跳到最近有考试的那一档 */
  function examPickScope(){
    var L = BIG.examList;
    var today = L.today || examToday();
    var dates = [];
    (L.groups || []).forEach(function (g){
      (g.days || []).forEach(function (d){ dates.push(d.date); });
    });
    if(!dates.length) return 'all';
    dates.sort();
    var next = '';
    for(var i = 0; i < dates.length; i++){
      if(dates[i] >= today){ next = dates[i]; break; }
    }
    if(!next) next = dates[dates.length - 1];
    for(var k = 0; k < EXAM_SCOPES.length; k++){
      var r = examScopeRange(EXAM_SCOPES[k].id);
      if(next >= r[0] && next <= r[1]) return EXAM_SCOPES[k].id;
    }
    return 'all';
  }

  function examFilter(scope){
    var r = examScopeRange(scope);
    var out = [];
    (BIG.examList.groups || []).forEach(function (g){
      var ds = (g.days || []).filter(function (d){ return d.date >= r[0] && d.date <= r[1]; });
      if(!ds.length) return;
      out.push({ g: g, days: ds });
    });
    return out;
  }

  function examPinBtn(scope, id, on, label, auto){
    /* 今天本来就会自动显示的，给了按钮反而误导：点了取消也还在。直接标「自动」 */
    if(auto){
      return '<span class="bex-auto" title="今天默认显示，无需挑选">自动</span>';
    }
    return '<button type="button" class="bex-add' + (on ? ' on' : '') + '"'
      + ' data-pin="' + esc0(scope + ':' + id) + '" data-on="' + (on ? '0' : '1') + '"'
      + ' title="' + (on ? '已在作业看板，点击移出' : '放到作业看板') + '">'
      + (on ? '✓ ' : '＋ ') + esc0(label) + '</button>';
  }
  function examPinDot(id, on){
    return '<button type="button" class="bex-dot' + (on ? ' on' : '') + '"'
      + ' data-pin="' + esc0('item:' + id) + '" data-on="' + (on ? '0' : '1') + '"'
      + ' title="' + (on ? '已在作业看板，点击移出' : '放到作业看板') + '">'
      + (on ? '✓' : '＋') + '</button>';
  }

  BIG.examPanel = function (){
    if(document.getElementById('bexMask')) return;
    BIG.examScope = '';
    BIG.examOpen = {};
    var mask = document.createElement('div');
    mask.className = 'bex-mask';
    mask.id = 'bexMask';
    mask.innerHTML = ''
      + '<div class="bex-box bex-wide" role="dialog" aria-label="考试看板">'
      +   '<div class="bex-hd">'
      +     '<div class="bex-t">考试看板</div>'
      +     '<a class="bex-go" id="bexGo" href="https://examboard.dpdns.org" target="_blank" rel="noopener">前往考试看板 ↗</a>'
      +   '</div>'
      +   '<div class="bex-tabs" id="bexTabs">'
      +     EXAM_SCOPES.map(function (s){
              return '<button type="button" class="bex-tab" data-scope="' + s.id + '">' + s.label + '</button>';
            }).join('')
      +     '<button type="button" class="bex-bulk" id="bexBulk">＋本周</button>'
      +   '</div>'
      +   '<p class="bex-tip" id="bexTip">正在读取考试数据…</p>'
      +   '<div class="bex-list" id="bexList"></div>'
      +   '<div class="bex-btns">'
      +     '<button type="button" class="bex-btn ghost" id="bexReload">刷新</button>'
      +     '<button type="button" class="bex-btn ghost" onclick="BIG.examPanelClose()">关闭</button>'
      +   '</div>'
      + '</div>';
    mask.addEventListener('click', function (e){ if(e.target === mask) BIG.examPanelClose(); });
    document.body.appendChild(mask);

    /* 先在缓存上画一遍，再回源 —— 断网也立刻有东西看。
       没缓存时先显示「正在读取」，不要闪一下「没有考试」。 */
    BIG.examLoading = true;
    examPanelPaint();
    BIG.examLoading = false;
    BIG.examPanelLoad(true);
  };

  BIG.examPanelClose = function (){
    var m = document.getElementById('bexMask');
    if(m && m.parentNode) m.parentNode.removeChild(m);
  };

  function examReloadBtn(busy){
    var b = $('bexReload');
    if(!b) return;
    b.disabled = !!busy;
    b.textContent = busy ? '刷新中…' : '刷新';
  }

  /** fresh=true 时绕开 api 的 3 分钟缓存，让后端真的回上游问一次 */
  BIG.examPanelLoad = function (fresh){
    if(BIG.examLoading) return;
    BIG.examLoading = true;
    examReloadBtn(true);
    var tip = $('bexTip');
    if(tip && !BIG.examList.groups.length) tip.textContent = '正在读取考试数据…';
    api('/exams?action=list' + (fresh ? '&fresh=1' : '')).then(function (j){
      examApply(j, false);
      BIG.examLoading = false;
      examReloadBtn(false);
      examPanelPaint();
      paintExam();
    }).catch(function (e){
      BIG.examLoading = false;
      examReloadBtn(false);
      if(!BIG.examList.groups.length){
        var c = examCacheGet();
        if(c) examApply(c, true);
      }
      examPanelPaint(String((e && e.message) || ''));
    });
  };

  function examAgo(ms){
    var n = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if(n < 1) return '刚刚';
    if(n < 60) return n + ' 分钟前';
    var h = Math.round(n / 60);
    if(h < 24) return h + ' 小时前';
    return Math.round(h / 24) + ' 天前';
  }

  function examPanelPaint(err){
    var box = $('bexList');
    if(!box) return;
    var L = BIG.examList;
    var tip = $('bexTip');
    var go = $('bexGo');
    if(go && L.base) go.href = L.base;

    if(!BIG.examScope) BIG.examScope = examPickScope();
    var scope = BIG.examScope;

    /* 顶栏档位 */
    Array.prototype.forEach.call(document.querySelectorAll('#bexTabs [data-scope]'), function (b){
      b.className = 'bex-tab' + (b.getAttribute('data-scope') === scope ? ' on' : '');
    });
    var bulk = $('bexBulk');
    if(bulk){
      bulk.textContent = '＋' + examScopeLabel(scope);
      /* 「全部」档不给批量：一键把整份考试表塞进作业看板太危险 */
      bulk.style.display = scope === 'all' ? 'none' : '';
    }

    if(!L.groups.length){
      /* 还在读的时候别先报「没有考试」，否则每次打开都闪一下空态 */
      if(BIG.examLoading && !err){
        if(tip) tip.textContent = '正在读取考试数据…';
        box.innerHTML = '';
        return;
      }
      if(tip){
        tip.textContent = err
          ? '连不上本站后端（' + err + '）。有缓存时会先显示上次的数据。'
          : '考试看板上暂时没有排好的考试。';
      }
      box.innerHTML = '<div class="bex-empty">' + (err ? '暂时读不到考试数据。' : '暂时没有考试。') + '</div>';
      return;
    }

    var rows = examFilter(scope);
    var onCnt = 0, allCnt = 0;
    (L.groups || []).forEach(function (g){ onCnt += g.onCnt || 0; allCnt += g.count || 0; });

    if(tip){
      var inScope = 0;
      rows.forEach(function (row){ row.days.forEach(function (d){ inScope += d.items.length; }); });
      var when = L.cacheAt ? ' · 数据 ' + examAgo(L.cacheAt) : '';
      tip.textContent = (L.cls ? L.cls + ' · ' : '') + '共 ' + allCnt + ' 场'
        + (inScope !== allCnt ? '（' + examScopeLabel(scope) + ' ' + inScope + ' 场）' : '')
        + (onCnt ? ' · 已在看板 ' + onCnt + ' 场' : '')
        + when
        + (err ? '（离线，显示的是缓存）' : '');
    }

    if(!rows.length){
      box.innerHTML = '<div class="bex-empty">' + examScopeLabel(scope) + '没有考试。换个时间段看看。</div>';
      return;
    }

    box.innerHTML = rows.map(function (row){
      var g = row.g;
      var open = !!BIG.examOpen[g.id];
      var total = 0, on = 0;
      row.days.forEach(function (d){ total += d.items.length; on += d.onCnt; });
      var head = '<div class="bex-gh">'
        + '<button type="button" class="bex-caret' + (open ? ' open' : '') + '" data-open="' + esc0(g.id) + '" aria-label="展开">'
        +   '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">'
        +     '<path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
        +   '</svg>'
        + '</button>'
        + '<span class="bex-gn">' + esc0(g.name) + '</span>'
        + '<span class="bex-gm">' + esc0(examMD(g.start)) + (g.daysN > 1 ? '–' + esc0(examMD(g.end)) : '') + ' · ' + (g.count || total) + ' 场</span>'
        + examPinBtn('major', g.id, g.allOn === true, '整场', g.auto === true)
        + '</div>';
      if(!open) return '<div class="bex-grp">' + head + '</div>';

      var body = row.days.map(function (d){
        var line = '<div class="bex-day">'
          + '<span class="bex-dd">' + esc0(examDayLabel(d.date, d.date === L.today)) + '</span>'
          + examPinBtn('day', g.id + '|' + d.date, d.allOn, '这天', g.auto === true)
          + '</div>';
        return line + d.items.map(function (it){
          return '<div class="bex-it' + (it.pin ? ' pinned' : '') + '">'
            + '<span class="bex-it-sub">' + esc0(it.name) + '</span>'
            + '<span class="bex-it-tm">' + esc0(it.start) + '–' + esc0(it.end) + '</span>'
            + (g.auto ? '' : examPinDot(it.id, it.pin))
            + '</div>';
        }).join('');
      }).join('');
      return '<div class="bex-grp open">' + head + '<div class="bex-gb">' + body + '</div></div>';
    }).join('');

    Array.prototype.forEach.call(box.querySelectorAll('[data-open]'), function (b){
      b.onclick = function (){
        var id = b.getAttribute('data-open');
        BIG.examOpen[id] = !BIG.examOpen[id];
        examPanelPaint();
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-pin]'), function (b){
      b.onclick = function (){
        var raw = String(b.getAttribute('data-pin') || '');
        var bar = raw.indexOf(':');
        if(bar < 0) return;
        BIG.examPin(raw.slice(0, bar), raw.slice(bar + 1), b.getAttribute('data-on') === '1', b);
      };
    });

    /* 档位按钮 */
    Array.prototype.forEach.call(document.querySelectorAll('#bexTabs [data-scope]'), function (b){
      b.onclick = function (){
        BIG.examScope = b.getAttribute('data-scope');
        examPanelPaint();
      };
    });
    if(bulk){
      bulk.onclick = function (){ BIG.examBulk(); };
    }
    var rl = $('bexReload');
    if(rl) rl.onclick = function (){ BIG.examPanelLoad(true); };
  }

  /** 挑一场 / 一天 / 一整场。只改本站的挑选清单，考试看板那边一个字都不动 */
  BIG.examPin = function (scope, id, on, btn){
    if(!id || BIG.exam.busy) return;
    BIG.exam.busy = true;
    var old = btn ? btn.innerHTML : '';
    if(btn){ btn.disabled = true; }
    api('/exams?action=pin', { method: 'POST', body: { action: 'pin', scope: scope, id: id, on: !!on } })
      .then(function (){
        BIG.exam.busy = false;
        BIG.examPanelLoad(true);    /* 状态以服务器为准，不在本地猜；带 fresh 绕开 3 分钟缓存 */
        if(typeof toast === 'function') toast(on ? '已放到作业看板' : '已从作业看板移出');
      })
      .catch(function (e){
        BIG.exam.busy = false;
        if(btn){ btn.disabled = false; btn.innerHTML = old; }
        if(typeof toast === 'function') toast(String((e && e.message) || '操作失败'));
      });
  };

  /** 一键把当前档位的考试全加上（本周 / 下周 / 本月 / 下月 / 本学期） */
  BIG.examBulk = function (){
    var scope = BIG.examScope;
    if(!scope || scope === 'all' || BIG.exam.busy) return;
    var r = examScopeRange(scope);
    var n = 0;
    examFilter(scope).forEach(function (row){
      row.days.forEach(function (d){ n += d.items.length; });
    });
    if(!n){
      if(typeof toast === 'function') toast(examScopeLabel(scope) + '没有考试');
      return;
    }
    BIG.exam.busy = true;
    var b = $('bexBulk');
    var old = b ? b.textContent : '';
    if(b){ b.disabled = true; b.textContent = '正在加入…'; }
    api('/exams?action=bulk', { method: 'POST', body: { action: 'bulk', from: r[0], to: r[1], on: true } })
      .then(function (){
        BIG.exam.busy = false;
        if(b){ b.disabled = false; b.textContent = old; }
        if(typeof toast === 'function') toast('已把' + examScopeLabel(scope) + ' ' + n + ' 场放到作业看板');
        BIG.examPanelLoad(true);
      })
      .catch(function (e){
        BIG.exam.busy = false;
        if(b){ b.disabled = false; b.textContent = old; }
        if(typeof toast === 'function') toast(String((e && e.message) || '操作失败'));
      });
  };

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
    /* v4.10.11：最后一分钟不写「0 分」 */
    return m > 0 ? m + ' 分' : '不到 1 分';
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
          scope: Array.isArray(d.scope) ? d.scope : [],
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
  /* v4.10.11（站主）：「这个还有多少分钟是通过本机的时间去实时的更新的，
     不能说我 3 分钟刷新，那我就 3 分钟之后再刷新出这个时间」。
     所以文案拆成两步：cdSnap() 只算字（每秒一次，纯计算不碰 DOM），
     renderCd() 才建结构。cdTick() 拿新字跟屏幕上的比，变了才写 textContent ——
     既不会每秒重建 DOM（那会闪），也不会等下一次整块重绘才动。 */
  function cdSnap(now){
    var p = cdPick(), o = { imp: p.imp, hol: p.hol, impTxt: '', holTxt: '' };
    if(p.imp) o.impTxt = p.imp.during ? '进行中' : cdLeftText(p.imp.st, now);
    if(p.hol){
      var left = cdDays(p.hol.d, now);
      o.holTxt = (left <= 0 ? '今天' : '还有 ' + left + ' 天')
        + (p.hol.days ? ' · 假期 ' + p.hol.days + ' 天' : '');
    }
    o.sig = (p.imp ? p.imp.name + '#' + p.imp.st.getTime() + '#' + (p.imp.during ? 1 : 0) : '-')
      + '/' + (p.hol ? p.hol.name + '#' + p.hol.d.getTime() : '-');
    return o;
  }
  function renderCd(){
    var box = $('bhwCd'); if(!box) return;
    var s = cdSnap(new Date()), p = { imp: s.imp, hol: s.hol };
    BIG._cdSig = s.sig;
    if(!p.imp && !p.hol){ box.style.display = 'none'; return; }
    box.style.display = '';
    var rows = '';
    if(p.imp){
      /* v4.7.11（站主第 14 条）：填了考试范围的考试，点这一行就能看范围 */
      var hasSc = !!(p.imp.scope && p.imp.scope.length);
      BIG._cdImp = hasSc ? p.imp : null;
      rows += '<div class="bhw-cd-row' + (hasSc ? ' tap' : '') + '"'
        + (hasSc ? ' onclick="BIG.cdScope()" title="点击查看考试范围"' : '') + '>'
        + '<span class="bhw-cd-n">' + esc0(p.imp.name)
        + (hasSc ? '<i class="bhw-cd-more">范围</i>' : '') + '</span>'
        + '<span class="bhw-cd-v' + (p.imp.during ? ' during' : '') + '" id="bhwCdImpV">'
        + esc0(s.impTxt) + '</span></div>';
    }
    if(p.hol){
      rows += '<div class="bhw-cd-row">'
        + '<span class="bhw-cd-n">' + esc0(p.hol.name) + '</span>'
        + '<span class="bhw-cd-v" id="bhwCdHolV">' + esc0(s.holTxt) + '</span></div>';
    }
    box.innerHTML = '<span class="bhw-mini-k">倒计时</span>' + rows;
  }
  /* 每秒调用：只改数字。换条 / 进入进行中这类结构性变化交给 sig 判断后重建 */
  function cdTick(){
    var box = $('bhwCd'); if(!box) return;
    var s = cdSnap(new Date());
    if(s.sig !== BIG._cdSig){ renderCd(); return; }
    var iv = $('bhwCdImpV');
    if(iv && s.imp && iv.textContent !== s.impTxt) iv.textContent = s.impTxt;
    var hv = $('bhwCdHolV');
    if(hv && s.hol && hv.textContent !== s.holTxt) hv.textContent = s.holTxt;
  }
  BIG.renderCd = renderCd;
  BIG.cdTick = cdTick;

  /* ==========================================================================
   * v4.10.4（站主第 7 条）：右下角「学期 / 高考 / 高中进度」卡片
   * --------------------------------------------------------------------------
   * 站主原话：「大屏模式的作业查看右下角显示一个卡片：第一行某学期已经开学多少天，
   *   第二行学期还剩多少天，第三行离 2028 年高考还剩多少天，第四行显示一个高中进度条，
   *   要有具体的进度条以及百分比，某学期以及开学的日期是根据后台班级岛上的两个数据来推的」。
   *
   * 数据不在本页算 —— 统一走 app.js 的 islandProgress()，这样后台改一次，
   * 首页、班级岛、大屏三处一定是同一个数，不会各算各的。
   * 没填「学期结束」时「还剩多少天」那行自动不出现（不显示 0 / NaN）。
   * ========================================================================== */
  function renderProg(){
    var box = $('bhwProg'); if(!box) return;
    var p = null;
    try{ if(typeof islandProgress === 'function') p = islandProgress(); }catch(e){}
    if(!p || (!p.start && !p.end)){ box.style.display = 'none'; return; }
    box.style.display = '';

    var rows = '';
    /* v4.10.8（站主）：「还要显示我已经步入高中多少天了，放在本学期已开学的上面」。
       口径和「高中总进度」同一条基线（入学日期），入学当天算第 1 天。 */
    if(p.hiDone !== null && p.hiDone !== undefined){
      rows += '<div class="bhw-prog-row"><span>已步入高中</span>'
        + '<b>' + (p.hiDone + 1) + '<i>天</i></b></div>';
    }
    if(p.sinceStart !== null && p.sinceStart !== undefined){
      rows += '<div class="bhw-prog-row"><span>本学期已开学</span>'
        + '<b>' + p.sinceStart + '<i>天</i></b></div>';
    }
    if(p.leftTerm !== null && p.leftTerm !== undefined){
      rows += '<div class="bhw-prog-row"><span>本学期还剩</span>'
        + '<b>' + (p.leftTerm <= 0 ? 0 : p.leftTerm) + '<i>天</i></b></div>';
    }
    if(p.leftGaokao !== null && p.leftGaokao !== undefined){
      rows += '<div class="bhw-prog-row"><span>距 2028 年高考</span>'
        + '<b>' + Math.max(0, p.leftGaokao) + '<i>天</i></b></div>';
    }

    var pct = (p.hiPct === null || p.hiPct === undefined) ? null : Math.round(p.hiPct * 10) / 10;
    var bar = '';
    if(pct !== null){
      bar = '<div class="bhw-prog-bar"><i style="width:' + pct + '%"></i></div>'
        + '<div class="bhw-prog-pct"><span>高中总进度</span><b>' + pct + '%</b></div>';
    }

    /* 学期名去掉「2026 年秋季 · 」这种前缀，只留「高二上」 */
    var term = String(p.term || '').replace(/^\d{4}\s*年\s*/, '');
    if(term.indexOf('·') >= 0) term = term.split('·').pop().trim();
    var hd = '<div class="bhw-prog-hd"><b>' + esc0(term || '本学期') + '</b>'
      + (p.start ? '<span>· ' + esc0(String(p.start).replace(/-/g, '/')) + ' 开学</span>' : '')
      + '</div>';

    box.innerHTML = hd + rows + bar;
  }
  BIG.renderProg = renderProg;
  BIG.cdScope = function (){
    var it = BIG._cdImp;
    if(!it || !it.scope || !it.scope.length) return;
    try{
      if(typeof openExamScope === 'function'){ openExamScope(it.name); return; }
    }catch(e){}
  };

  /* ---------------- 随机一言（v4.3.0） ---------------- */
  function renderQuote(){
    var box = $('bhwQuote'); if(!box) return;
    if(BIG.quoteHidden){ box.style.display = 'none'; return; }
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

    /* v4.3.0：进了作业页才起这两组定时器 —— 一言按用户设的分钟数自动换。
       v4.10.11：倒计时改成每秒 tick 只改字（cdTick），每 30 秒整块重建一次兜住跨天；
       以前是 30 秒整块重建，看上去「半天不动」。 */
    renderCd();
    /* v4.10.4：右下角进度卡跟倒计时一起刷 —— 跨天时天数是会变的 */
    renderProg();
    if(BIG._cdT) clearInterval(BIG._cdT);
    BIG._cdTickN = 0;
    BIG._cdT = setInterval(function (){
      if(!BIG.hwOn) return;
      cdTick();
      sideTick();          /* v4.10.12：侧栏「今日事项」的剩余时间也每秒走 */
      if((++BIG._cdTickN % 30) === 0){ renderCd(); renderProg(); }
    }, 1000);
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
    if(v) BIG.hwViewDate = null;   /* 选了具体期次就别再按日期锚点找 */
    BIG.renderHw();
    try{ setRoute('hw' + (v ? '/' + encodeURIComponent(v) : '')); }catch(e){}
  };

  /* ================= 日历跳转（v4.12.0）=================
     底部日期条是一整周（周一~周日），点哪天就落到那一天所在的期次：
       · 11/9 ~ 11/13 → 「高二上 · 第11周作业」
       · 11/14、11/15 → 「高二上 · 第11周周末作业」
     左右箭头整周翻，可以提前跳到未来某一周写。月历弹窗用来跨月跳。 */
  function hwAnchor(){
    if(BIG.hwViewDate) return BIG.hwViewDate;
    var h = currentHw();
    if(h && h.start) return String(h.start).slice(0, 10);
    return todayStr();
  }
  BIG.hwJumpTo = function (dStr){
    var d = new Date(String(dStr) + 'T00:00:00');
    if(isNaN(d.getTime())) return;
    BIG.hwId = null;
    BIG.hwViewDate = ymd(d);
    BIG.renderHw();
    try{ setRoute('hw/' + BIG.hwViewDate); }catch(e){}
  };
  BIG.hwWeekShift = function (n){
    var d = new Date(hwAnchor() + 'T00:00:00');
    if(isNaN(d.getTime())) return;
    d.setDate(d.getDate() + 7 * (n || 0));
    BIG.hwJumpTo(ymd(d));
  };
  BIG.hwToday = function (){
    BIG.hwId = null; BIG.hwViewDate = null;
    BIG.renderHw();
    try{ setRoute('hw'); }catch(e){}
  };

  /* —— 整月日历弹窗（站主确认「弹整月日历」）—— */
  BIG._calMonth = null;
  function calRender(){
    var m = $('bhwCalMask'); if(!m) return;
    if(!BIG._calMonth){ var d0 = new Date(); BIG._calMonth = { y: d0.getFullYear(), m: d0.getMonth() }; }
    var Y = BIG._calMonth.y, M = BIG._calMonth.m;
    var ttl = $('bhwCalTitle'); if(ttl) ttl.textContent = Y + ' 年 ' + (M + 1) + ' 月';
    var body = $('bhwCalBody'); if(!body) return;
    var first = new Date(Y, M, 1), last = new Date(Y, M + 1, 0).getDate();
    var lead = (first.getDay() + 6) % 7;             /* 周一打头 */
    var today = todayStr(), anchor = hwAnchor();
    var html = '<div class="bhw-cal-wk">'
      + ['一','二','三','四','五','六','日'].map(function (w){ return '<span>' + w + '</span>'; }).join('')
      + '</div><div class="bhw-cal-grid">';
    for(var i = 0; i < lead; i++) html += '<span class="bhw-cal-empty"></span>';
    for(var d = 1; d <= last; d++){
      var dd = new Date(Y, M, d), ds = ymd(dd);
      var wd = (dd.getDay() + 6) % 7;
      var cls = 'bhw-cal-day' + (wd >= 5 ? ' we' : '')
        + (ds === today ? ' today' : '') + (ds === anchor ? ' cur' : '');
      /* 只在第一天和第二段开头标一下周次，格子保持干净 */
      var w = weekOf(dd);
      var tag = w ? '<i>' + w.no + '</i>' : '';
      html += '<button type="button" class="' + cls + '"'
        + ' onclick="BIG.calPick(\'' + ds + '\')" title="' + ds + (w ? ' · 第' + w.no + '周' : '') + '">'
        + '<b>' + d + '</b>' + tag + '</button>';
    }
    html += '</div>';
    body.innerHTML = html;
  }
  BIG.calOpen = function (){
    var base = new Date(hwAnchor() + 'T00:00:00');
    if(!isNaN(base.getTime())) BIG._calMonth = { y: base.getFullYear(), m: base.getMonth() };
    var m = $('bhwCalMask'); if(!m) return;
    calRender();
    m.classList.add('show');
  };
  BIG.calClose = function (){ var m = $('bhwCalMask'); if(m) m.classList.remove('show'); };
  BIG.calNav = function (n){
    if(!BIG._calMonth) return;
    BIG._calMonth.m += (n || 0);
    if(BIG._calMonth.m < 0){ BIG._calMonth.m = 11; BIG._calMonth.y--; }
    if(BIG._calMonth.m > 11){ BIG._calMonth.m = 0; BIG._calMonth.y++; }
    calRender();
  };
  BIG.calPick = function (dStr){
    BIG.calClose();
    BIG.hwJumpTo(dStr);
  };

  BIG.markSaved = function (txt){ markSaved(txt); };
  function markSaved(txt){
    var s = $('bhwSave');
    if(!s) return;
    s.textContent = txt;
    s.style.color = txt.indexOf('失败') >= 0 ? '#b91c1c' : '';
  }

  function persist(){
    if(!canEdit()) return;
    /* v4.11.0：真正落库前，把当前这份「自动期次」收进列表 ——
       站主要「有内容才存」，所以落库这个动作本身就等于「已经有内容了」。 */
    try{ materialize(currentHw()); }catch(e){}
    var list = hwList();
    /* v4.7.0：本机刚存下的这份就是「屏幕上这一份」，把比对基准一起推平 ——
       否则 12 秒后的轮询会把自己刚打的字当成「手机端改的」标黄一遍。 */
    try{ BIG.hwPrevData = list; BIG.hwPrev = JSON.stringify(list || []); }catch(e){}

    /* v4.7.1：没登录管理员（班级电脑常态）→ 只写本机那份，一个网络请求都不发。
       离线时 pushCloudContent 也只是白等一个超时，不如直接省掉。
       ⚠️ 这条分支**不调 saveContentLocal**：它会把本机改动写进云端内容的本地缓存，
       之后点「放弃」就再也回不到云端那份了 —— 显示层靠 hwList() 读本机覆盖就够。 */
    if(!adminOk()){
      hwLocalSave(list);
      markSaved('已存本机（不会上传云端）');
      syncBadge();
      refreshLocalStrip();
      return;
    }

    try{
      if(typeof saveContentLocal === 'function') saveContentLocal('holiday_homeworks', list);
    }catch(e){}

    hwLocalSave(list);   /* 先落本机，再等网络；网断了改动也不会丢 */
    try{
      pushCloudContent({ holiday_homeworks: list }, true).then(function (r){
        if(r && r.ok){
          /* 云端已经是这份了，本机待上传标记可以撤掉 */
          hwLocalClear();
          markSaved('已同步云端');
          BIG.renderHw();
        } else {
          markSaved('未上传：' + ((r && r.error) || '未知原因') + '（已存本机，可稍后点「上传」）');
        }
        syncBadge();
      }).catch(function (e){
        markSaved('未上传：' + (e && e.message || e) + '（已存本机，可稍后点「上传」）');
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

  /* ---------------- 本机编辑开关（v4.7.1）----------------
     站主诉求：「班级电脑的作业界面压根没有新增 / 修改按钮」。
     班级电脑离线、登不了管理员，所以给一个不依赖登录的编辑入口；
     打开后整页进入编辑态，改完点「完成」退回只读，避免大屏上被误点。 */
  /* v4.12.0（站主）：「修改之前作业要有一个弹窗拦截提醒」，细则确认「进编辑就拦」。
     判据是这一期的结束日期早于今天 —— 未来期次（提前写）不算历史，不拦。 */
  function isHistoryHw(hw){
    var e = String((hw && hw.end) || '').slice(0, 10);
    return !!e && e < todayStr();
  }
  BIG.isHistoryHw = isHistoryHw;
  function doEditToggle(on){
    try{ localStorage.setItem(HW_EDIT_KEY, on ? '1' : '0'); }catch(e){}
    BIG.renderHw();
    /* v4.10.2（站主第 5 条）：文案跟着身份走 ——
       登录了管理员就是「改完会上传云端」，没登录就是「只存本机」。 */
    toast(on
      ? (adminOk() ? '已进入编辑，改完点右上角「完成」，改动会同步到云端' : '已进入编辑，改完点右上角「完成」（改动只存本机）')
      : '已退出编辑，卡片恢复只读');
  }
  BIG.hwEditToggle = function (){
    var on = !hwEditOn();
    if(on && isHistoryHw(currentHw())){ BIG.histAsk(); return; }
    doEditToggle(on);
  };
  BIG.histAsk = function (){
    var m = $('bhwHistMask');
    var hw = currentHw();
    var ttl = $('bhwHistText');
    if(ttl){
      ttl.textContent = '「' + (hw ? (hw.title || '这一期') : '这一期') + '」'
        + ((hw && (hw.start || hw.end)) ? '（' + (hw.start || '') + ' ~ ' + (hw.end || '') + '）' : '')
        + ' 已经结束。改动会写回原来的那一周，确定要编辑吗？';
    }
    if(m){ m.classList.add('show'); return; }
    /* 弹窗 DOM 没加载出来时用原生确认兜底，不能静默放行 */
    if(confirm('这一期作业已经结束，确定要编辑吗？')) doEditToggle(true);
  };
  BIG.histCancel = function (){ var m = $('bhwHistMask'); if(m) m.classList.remove('show'); };
  BIG.histConfirm = function (){
    var m = $('bhwHistMask'); if(m) m.classList.remove('show');
    doEditToggle(true);
  };

  /* 把本机改动推到云端（只有管理员能做，和原来的权限口径一致） */
  BIG.hwLocalUpload = function (){
    if(!adminOk()){ toast('请先登录管理员，才能上传到云端', true); return; }
    var rec = hwLocalRec();
    if(!rec){ toast('没有待上传的改动', true); return; }
    if(typeof navigator !== 'undefined' && navigator.onLine === false){
      toast('当前设备离线，联网后再点上传', true); return;
    }
    markSaved('正在上传…');
    pushCloudContent({ holiday_homeworks: rec.list }, true).then(function (r){
      if(r && r.ok){
        hwLocalClear();
        markSaved('已上传云端');
        BIG.renderHw();
        toast('已上传云端');
      }else{
        markSaved('上传失败：' + ((r && r.error) || '未知原因'));
        toast('上传失败：' + ((r && r.error) || '未知原因'), true);
      }
    }).catch(function (e){
      markSaved('上传失败：' + (e && e.message || e));
      toast('上传失败，请检查网络', true);
    });
  };

  /* 丢掉本机改动，回到云端那份 */
  BIG.hwLocalDiscard = function (){
    if(!hwLocalRec()) return;
    if(!confirm('放弃这台电脑上的改动？放弃后显示云端那一份，本机改动不可恢复。')) return;
    hwLocalClear();
    BIG.renderHw();
    /* 立刻拉一次云端，别让屏幕停在「本机那份」上等 12 秒轮询 */
    BIG.hwRefreshNow();
    toast('已放弃本机改动');
  };

  /* ---------------- 真全屏（v4.7.1 · 站主第 3 条）----------------
     站主原话：「作业查看界面新增全屏窗口，是真正的全屏没有任务栏那种」。
     只能走 Fullscreen API：F11 那种浏览器全屏救不了「带任务栏」的旧内核，
     而 requestFullscreen 是页面级的，任务栏会被盖掉。
     注意两点：
       · 必须由点击触发（浏览器的安全限制），所以只能做成按钮；
       · 一体机如果是老 Chromium，要带 webkit 前缀。 */
  function fsEl(){
    return document.fullscreenElement || document.webkitFullscreenElement
      || document.msFullscreenElement || null;
  }
  BIG.hwFull = function (){
    var d = document, el = d.documentElement;
    try{
      if(fsEl()){
        try{ if(window.FSKeep) FSKeep.off(); }catch(e){}
        var ex = d.exitFullscreen || d.webkitExitFullscreen || d.msExitFullscreen;
        if(!ex){ toast('这个浏览器退不出网页全屏，请按 Esc 键', true); return; }
        var p = ex.call(d);
        /* v4.10.2（站主第 11 条）：「点网站里的全屏开关退不出全屏」。
           退出不能只看 exitFullscreen() 有没有被调用 —— 得**退出后再核对一次**：
           有些内核第一次调用会被静默忽略，必须补第二次才真的退掉。
           另外必须区分两种「全屏」：
             ① 网页全屏 —— 本页面 requestFullscreen 出来的，网页能自己退；
             ② 浏览器窗口全屏 —— BAT 用 --start-fullscreen 启动的，网页**退不掉**，
                只能按 F11 / Esc（这是站主「不知道怎么退」的真正原因）。
           所以退完要告诉用户一句：网页退了，但窗口还全屏的话按 F11。 */
        if(p && p.then){
          p.then(function(){ setTimeout(afterExitFull, 260); },
                 function(){ setTimeout(afterExitFull, 260); });
        }else{
          setTimeout(afterExitFull, 260);
        }
        return;
      }
      var req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
      if(!req){ toast('这个浏览器不支持网页全屏，可按 F11', true); return; }
      var p2 = req.call(el);
      /* v4.8.0：记住「要全屏」，换到时钟 / 后台 / 作业页也不退出 */
      try{ if(window.FSKeep) FSKeep.on(); }catch(e){}
      if(p2 && p2.then){
        p2.then(function(){ refreshFullBtn(); }, function(){
          try{ if(window.FSKeep) FSKeep.off(); }catch(e){}
          toast('浏览器拒绝全屏，请按 F11', true);
        });
      }else{
        setTimeout(refreshFullBtn, 300);
      }
    }catch(e){
      toast('这个浏览器不支持网页全屏，可按 F11', true);
    }
  };

  /* 退出网页全屏之后：核对 + 补刀 + 提示 */
  function afterExitFull(){
    if(fsEl()){
      /* 还在全屏 → 第一次没生效，再补一次 */
      try{
        var ex = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
        if(ex) ex.call(document);
      }catch(e){}
      setTimeout(function(){
        refreshFullBtn();
        if(fsEl()) toast('网页全屏退不掉，请直接按键盘 Esc', true);
        else tipWindowFull();
      }, 460);
      return;
    }
    refreshFullBtn();
    tipWindowFull();
  }
  /* 窗口本身还占满屏幕（没有任务栏）→ 说明是浏览器窗口级全屏，网页管不着 */
  function winLookFull(){
    try{
      if(!window.screen || !window.screen.height) return false;
      return window.innerHeight >= (window.screen.height - 4);
    }catch(e){ return false; }
  }
  function tipWindowFull(){
    if(winLookFull()){
      toast('网页已退出全屏；但窗口还是全屏（没有任务栏），按 F11 切换，或把启动方式改成「最大化」', true);
    }
  }
  function refreshFullBtn(){
    var b = $('bhwFullBtn');
    if(!b) return;
    b.textContent = fsEl() ? '⤡ 退出全屏' : '⛶ 全屏';
    b.setAttribute('title', fsEl()
      ? '退出网页全屏（退出后窗口若仍满屏，请按 F11）'
      : '全屏显示（隐藏任务栏），按 Esc 退出');
  }
  try{
    ['fullscreenchange','webkitfullscreenchange','msfullscreenchange'].forEach(function (ev){
      document.addEventListener(ev, refreshFullBtn);
    });
  }catch(e){}

  /* 全屏变化后布局要重算（任务栏没了，可视高度变大，卡片该重新排） */
  try{
    document.addEventListener('fullscreenchange', function (){
      if(BIG.hwOn) setTimeout(function (){ try{ BIG.relayout(); }catch(e){} }, 260);
    });
  }catch(e){}


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

  /* v4.11.0（站主第 4 条）：底部那排科目按钮，点一下就在这一期里建一张卡。
     「其他」要自己起名 —— 站主确认过「弹框输名称」。 */
  BIG.hwQuickSubj = function (name){
    var hw = hwObj(); if(!hw){ toast('当前没有作业期次', true); return; }
    name = String(name || '').trim();
    if(name === '其他'){
      var v = window.prompt('科目名称', '');
      if(v === null) return;
      name = String(v || '').trim();
      if(!name){ toast('请填写科目名称', true); return; }
    }
    var dup = (hw.items || []).some(function (x){ return String(x.subject || '').trim() === name; });
    if(dup){ toast('「' + name + '」已经在里面了', true); return; }
    hw.items.push({ subject: name, tasks: [''] });
    BIG.renderHw();
    touch();
  };

  /* ================= 单项截止时间的设置（v4.12.0）=================
     时钟按钮挂在每一项的右侧（见 taskHtml），点开这个小弹窗：
       · datetime-local 精确到分钟；
       · 留空 / 点「清除」= 这一项不设截止；
       · 三个快捷按钮只是帮着把输入框填好，最终仍以「保存」为准。
     老数据里一项可能只是个字符串，设时间时统一升级成对象 {text,due}，
     读的那一侧（taskHtml / 导出）两种都认。 */
  BIG._dueCtx = null;
  function duePad(n){ return (n < 10 ? '0' : '') + n; }
  function dueLocalVal(d){
    return d.getFullYear() + '-' + duePad(d.getMonth() + 1) + '-' + duePad(d.getDate())
      + 'T' + duePad(d.getHours()) + ':' + duePad(d.getMinutes());
  }
  BIG.dueOpen = function (si, ti, btn){
    var hw = hwObj(); if(!hw || !hw.items[si]) return;
    var arr = hw.items[si].tasks || [];
    if(ti < 0 || ti >= arr.length) return;
    var t = arr[ti];
    var o = (t && typeof t === 'object') ? t : { text: String(t == null ? '' : t) };
    BIG._dueCtx = { si: si, ti: ti };
    var m = $('bhwDueMask'); if(!m) return;
    var inp = $('bhwDueInput'); if(inp) inp.value = String(o.due || '').slice(0, 16);
    var ttl = $('bhwDueTitle');
    if(ttl) ttl.textContent = '截止时间 · ' + (hw.items[si].subject || '这一科') + ' 第 ' + (ti + 1) + ' 项';
    m.classList.add('show');
    if(inp) setTimeout(function (){ try{ inp.focus(); }catch(e){} }, 60);
  };
  BIG.dueClose = function (){
    var m = $('bhwDueMask'); if(m) m.classList.remove('show');
    BIG._dueCtx = null;
  };
  function dueWrite(val){
    var c = BIG._dueCtx; if(!c) return;
    var hw = hwObj(); if(!hw || !hw.items[c.si]) return;
    var arr = hw.items[c.si].tasks || [];
    if(c.ti < 0 || c.ti >= arr.length) return;
    var t = arr[c.ti];
    var o = (t && typeof t === 'object') ? t : { text: String(t == null ? '' : t) };
    if(val) o.due = val; else delete o.due;
    arr[c.ti] = o;
    BIG.dueClose();
    BIG.renderHw();
    touch();
    toast(val ? '已设截止时间' : '已清除截止时间');
  }
  BIG.dueSave = function (){
    var inp = $('bhwDueInput');
    dueWrite(inp ? String(inp.value || '').slice(0, 16) : '');
  };
  BIG.dueClear = function (){ dueWrite(''); };
  BIG.dueQuick = function (n){
    var d = new Date(); d.setHours(22, 0, 0, 0);
    if(n === 0 && new Date().getHours() >= 22) d.setDate(d.getDate() + 1);
    else if(n === 7){ var wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() + (7 - wd)); }
    else if(n > 0) d.setDate(d.getDate() + n);
    var inp = $('bhwDueInput'); if(inp) inp.value = dueLocalVal(d);
  };

  /* v4.11.0（站主第 4 条）：设置这一周的起止。
     站主原话：「比如周三四放假，那这一周就只有周一二有作业」。
     只动这一期自己的 start / end，其它周不受影响；
     把结束日改到周六，周末作业就自动只剩周日（见 ensurePeriod）。 */
  BIG.hwWeekSetting = function (){
    if(!canEdit()){ toast('当前不可编辑', true); return; }
    var hw = currentHw();
    if(!hw){ toast('当前没有作业期次', true); return; }
    FORM.mode = 'week';
    var t = $('bhwFormTitle'); if(t) t.textContent = String(hw.title || '这一周') + ' · 调整范围';
    var n = $('bhwFormName'), st = $('bhwFormStart'), en = $('bhwFormEnd');
    if(n){ n.value = plain(hw.title || ''); n.style.display = 'none'; }
    if(n && n.previousElementSibling) n.previousElementSibling.style.display = 'none';
    if(st) st.value = String(hw.start || '').slice(0, 10);
    if(en) en.value = String(hw.end || '').slice(0, 10);
    var sj = $('bhwFormSubj'); if(sj){ sj.innerHTML = ''; sj.style.display = 'none'; }
    var m = $('bhwFormMask'); if(m) m.classList.add('show');
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
  /* 「设置」只调日期、不改名字，所以把名称那一行临时收起来；
     下次打开新建 / 重命名再放回去。 */
  function showFormName(on){
    var n = $('bhwFormName');
    if(!n) return;
    n.style.display = on ? '' : 'none';
    if(n.previousElementSibling) n.previousElementSibling.style.display = on ? '' : 'none';
  }
  BIG.hwNew = function (){
    if(!canEdit()){ toast('当前不可编辑', true); return; }
    FORM.mode = 'new';
    FORM.subjects = PRESET_SUBJECTS.slice();
    var t = $('bhwFormTitle'); if(t) t.textContent = '新建一期作业';
    var d = todayStr();
    var n = $('bhwFormName'), st = $('bhwFormStart'), en = $('bhwFormEnd');
    showFormName(true);
    if(n) n.value = '';
    if(st) st.value = d;
    if(en) en.value = d;
    formSubjHtml();
    var m = $('bhwFormMask'); if(m) m.classList.add('show');
    setTimeout(function(){ if(n) n.focus(); }, 60);
  };
  BIG.hwRename = function (){
    if(!canEdit()) return;
    var hw = currentHw(); if(!hw){ toast('暂无可重命名的期次', true); return; }
    FORM.mode = 'rename';
    var t = $('bhwFormTitle'); if(t) t.textContent = '重命名这一期';
    var n = $('bhwFormName'), st = $('bhwFormStart'), en = $('bhwFormEnd');
    showFormName(true);
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
  /* v4.7.11（站主第 4 条）：大屏这一页也要能改「显示哪几类」和「整块隐藏」。
     类型与首页共用同一份 quote_source（云端），所以这儿勾了，首页也跟着变。 */
  /* v4.10.2（站主第 9 条）：以前这里自己抄了一份分类表（QC_FE），
     app.js 里还有一份（QUOTE_CATS_FE）。两份常量各改各的，顺序一旦对不上，
     勾选状态就会「串位」—— 明明点了这个，那个却打上了勾。
     现在统一：优先用 app.js 那份，本文件只留一份兜底副本。 */
  var QC_FE = (typeof QUOTE_CATS_FE !== 'undefined' && Array.isArray(QUOTE_CATS_FE) && QUOTE_CATS_FE.length)
    ? QUOTE_CATS_FE
    : [
      ['a', '动画'], ['b', '漫画'], ['c', '游戏'], ['d', '文学'],
      ['e', '原创'], ['f', '网络'], ['g', '其他'], ['h', '影视'],
      ['i', '诗词'], ['j', '网易云'], ['k', '哲学'], ['l', '抖机灵']
    ];
  function qcList(){
    try{ if(typeof quoteCats === 'function') return quoteCats(); }catch(e){}
    return ['a', 'b', 'd', 'i'];
  }
  function quoteCfgHtml(){
    var opts = [
      { n: 1, t: '每 1 分钟' }, { n: 3, t: '每 3 分钟' }, { n: 5, t: '每 5 分钟' },
      { n: 10, t: '每 10 分钟' }, { n: 30, t: '每 30 分钟' }, { n: 0, t: '仅手动' }
    ];
    var cur = qcList();
    var h = '';
    h += '<div class="bhw-q-sec">';
    h += '<div class="bhw-q-sec-k">是否在大屏显示</div>';
    h += '<button type="button" class="bhw-opt' + (BIG.quoteHidden ? '' : ' on') + '"'
       + ' onclick="BIG.quoteHideSet(false)">显示</button>';
    h += '<button type="button" class="bhw-opt' + (BIG.quoteHidden ? ' on' : '') + '"'
       + ' onclick="BIG.quoteHideSet(true)">隐藏</button>';
    h += '</div>';
    h += '<div class="bhw-q-sec">';
    h += '<div class="bhw-q-sec-k">自动更换</div>';
    h += opts.map(function (o){
      return '<button type="button" class="bhw-opt' + (o.n === BIG.quoteMin ? ' on' : '') + '"'
        + ' onclick="BIG.quoteSetMin(' + o.n + ')">' + o.t + '</button>';
    }).join('');
    h += '</div>';
    h += '<div class="bhw-q-sec">';
    h += '<div class="bhw-q-sec-k">内容类型（勾上的才会出现）</div>';
    h += QC_FE.map(function (c){
      var on = cur.indexOf(c[0]) >= 0;
      /* v4.10.2：勾号由 CSS 的 ::before 画（固定宽度槽），
         文字里不要再插「✓ 」—— 那会让这一行重排，看着就像打到别的分类上。 */
      return '<button type="button" class="bhw-opt bhw-opt-cat' + (on ? ' on' : '') + '"'
        + ' onclick="BIG.quoteCatSet(\'' + c[0] + '\')">' + c[1] + '</button>';
    }).join('');
    h += '</div>';
    h += '<p class="bhw-io-tip" style="margin:10px 2px 0">'
       + (typeof isAdmin === 'function' && isAdmin()
          ? '勾完即生效，并同步给所有人（首页那张卡片也一样）'
          : '勾完只在这台设备生效')
       + '</p>';
    return h;
  }
  BIG.quoteCfg = function (){
    var body = $('bhwQuoteBody');
    if(body) body.innerHTML = quoteCfgHtml();
    var m = $('bhwQuoteMask'); if(m) m.classList.add('show');
  };
  BIG.quoteCfgRefresh = function (){
    var body = $('bhwQuoteBody');
    if(body && body.innerHTML) body.innerHTML = quoteCfgHtml();
    renderQuote();
  };
  BIG.quoteHideSet = function (v){
    BIG.quoteHidden = !!v;
    try{ localStorage.setItem(QH_KEY, v ? '1' : '0'); }catch(e){}
    renderQuote();
    BIG.quoteCfg();
    try{ if(typeof SFX !== 'undefined' && SFX.click) SFX.click(); }catch(e){}
    toast(v ? '大屏已隐藏每日一言' : '大屏已显示每日一言');
  };
  BIG.quoteCatSet = function (k){
    try{
      if(typeof quoteCatToggle === 'function') quoteCatToggle(k);
    }catch(e){}
    BIG.quoteCfgRefresh();
  };
  BIG.quoteClose = function (){
    var m = $('bhwQuoteMask'); if(m) m.classList.remove('show');
  };
  BIG.formSave = function (){
    var n = $('bhwFormName'), st = $('bhwFormStart'), en = $('bhwFormEnd');
    var name = n ? String(n.value || '').trim() : '';
    var s0 = st ? String(st.value || '') : '';
    var e0 = en ? String(en.value || '') : '';
    if(s0 && e0 && e0 < s0){ toast('结束日期不能早于开始日期', true); return; }
    /* v4.11.0：只改这一周的范围，不动名字 */
    if(FORM.mode === 'week'){
      var hw0 = currentHw();
      if(!hw0){ toast('找不到这一期', true); return; }
      materialize(hw0);
      if(s0) hw0.start = s0;
      if(e0) hw0.end = e0;
      /* v4.11.0：把这一周推到周六，周末作业就往后缩一天；推到周日就整段没有。
         虚拟的周末期次靠 AUTO_CACHE 重算，实体化的那份这里就地改 start。 */
      AUTO_CACHE = {};
      var w = weekOf(new Date(String(hw0.start || '') + 'T00:00:00'));
      if(w){
        var weId = 'w' + ymd(w.mon) + 'we';
        var from = new Date(String(hw0.end || '') + 'T00:00:00');
        if(!isNaN(from.getTime())){
          from.setDate(from.getDate() + 1);
          var l2 = hwList();
          for(var k = 0; k < l2.length; k++){
            if(String(l2[k].id) === weId && from <= w.sun) l2[k].start = ymd(from);
          }
        }
      }
      BIG.formClose();
      BIG.renderHw();
      persist();
      toast('已更新这一周的范围');
      return;
    }
    if(!name){ toast('期次名称', true); if(n) n.focus(); return; }
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
    /* v4.7.1：本机改动优先显示 —— 它才是屏幕上真正画着的那一份 */
    /* 文案和右边那条「本机改动 上传/放弃」错开，避免两个「本机改动」并排 */
    if(hwLocalPending()){ el.className = 'bhw-sync pend'; el.innerHTML = '<i></i>未上传'; }
    else if(off){ el.className = 'bhw-sync off'; el.innerHTML = '<i></i>离线 · 存本机'; }
    else if(pending){ el.className = 'bhw-sync pend'; el.innerHTML = '<i></i>待上传'; }
    else { el.className = 'bhw-sync'; el.innerHTML = '<i></i>已同步'; }
  }
  BIG.syncBadge = syncBadge;
  try{
    window.addEventListener('online', function (){ syncBadge(); });
    window.addEventListener('offline', function (){ syncBadge(); });
  }catch(e){}

  /* ================= 作业实时同步（v4.7.0 · 站主第 3 条）=================
     站主原话：「我在手机上新增 / 修改了作业，大屏不会自动刷新，除非退出重进。
                 ClassWorks 是手机上发完，大屏直接实时同步，还会把改动的地方高亮。」
     做法（轮询，不做 WebSocket —— 无服务器、断网也能退化成缓存，够用）：
       · 大屏模式本来每 20 秒就要拉一次 /api/content 看班级提醒，顺手把作业也一起比；
       · 比对的是「上一次画到屏幕上的那份」，不是 SITE_DATA —— 否则 app.js 先在后台
         把 SITE_DATA 更新了，这里再比就永远相等，大屏永远不重绘；
       · 差异里的新增/改动作业项加 .bhw-flash 标黄 5 秒，让人一眼看到改在哪；
       · 「已同步」角标可以点，点一下立刻强制拉一次（站主要求的手动刷新）。 */
  BIG.hwPrev = '';
  BIG.hwPrevData = null;
  BIG.hwFlash = null;

  /* 正在编辑 / 有未上传改动 → 暂停用云端覆盖本机作业
     v4.7.3（站主）：「我正好在打字，打到一半又刷新，输入框就没了」。
     原来只看 document.activeElement —— 一旦点到别处（焦点没了但 textarea 里
     还是半截话、onchange 也没触发），它就说「不忙」，接着整页重绘把字冲掉。
     现在改成扫一遍：只要有任何输入框的值和「刚画上去时的值」不一样，就算在编辑。 */
  function hwDirty(){
    var host = $('bigHw');
    if(!host) return false;
    var ae = document.activeElement;
    if(ae && host.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(String(ae.tagName || '').toUpperCase())) return true;
    var arr = host.querySelectorAll('input,textarea');
    for(var i = 0; i < arr.length; i++){
      var el = arr[i];
      var tp = String(el.type || '').toLowerCase();
      if(tp === 'checkbox' || tp === 'radio' || tp === 'file') continue;
      /* defaultValue 就是渲染时写进 HTML 的那份，用户改过就会不一样 */
      if(String(el.value) !== String(el.defaultValue)) return true;
    }
    return false;
  }
  function hwBusy(){
    try{ if(typeof hasPendingContentSync === 'function' && hasPendingContentSync()) return true; }catch(e){}
    return hwDirty();
  }

  function hwNow(){
    var arr = hwList();
    return Array.isArray(arr) ? arr : [];
  }
  function hwDiff(prev, next){
    var out = { tasks: {}, subs: {}, subNames: {}, added: 0, changed: 0 };
    prev = Array.isArray(prev) ? prev : [];
    var pm = {};
    prev.forEach(function (p){ if(p && p.id != null) pm[String(p.id)] = p; });
    next.forEach(function (p){
      if(!p) return;
      var pid = String(p.id);
      var old = pm[pid];
      if(!old){ out.added++; out.subNames[String(p.title || '')] = 1; return; }
      var om = {};
      (old.items || []).forEach(function (it){ om[String(it.subject || '')] = it; });
      (p.items || []).forEach(function (it){
        var sn = String(it.subject || ''), oi = om[sn];
        if(!oi){ out.subs[pid + '|' + sn] = 1; out.subNames[sn] = 1; out.changed++; return; }
        var ot = {};
        (oi.tasks || []).forEach(function (t){ ot[String((t && t.text) || '')] = 1; });
        (it.tasks || []).forEach(function (t, ti){
          var s = String((t && t.text) || '');
          if(s && !ot[s]){ out.tasks[s] = 1; out.subNames[sn] = 1; out.changed++; }
          /* 同一位置换了内容（改字）也算改动：旧文本里有、新文本里没有的就已覆盖，
             这里再兜一次「位置上原本有东西、现在不一样」 */
          var oldT = (oi.tasks || [])[ti];
          var oldS = String((oldT && oldT.text) || '');
          if(oldS && s && oldS !== s){ out.tasks[s] = 1; out.subNames[sn] = 1; }
        });
      });
    });
    return out;
  }
  /* 把一份云端作业套到界面上；返回是否发生了变化
     v4.7.3：正在打字就先存一边，等手停下来再应用 —— 见 hwQueue。 */
  function hwApply(raw, opts){
    opts = opts || {};
    if(!Array.isArray(raw)) return false;
    var nowStr = JSON.stringify(raw);
    if(BIG.hwPrev === nowStr) return false;
    if(BIG.hwOn && hwDirty()){ hwQueue(raw); return false; }
    var prevData = Array.isArray(BIG.hwPrevData) ? BIG.hwPrevData : hwNow();
    var diff = hwDiff(prevData, raw);
    try{ if(typeof applyCloudContent === 'function') applyCloudContent({ holiday_homeworks: raw }); }catch(e){}
    try{ if(typeof contentCacheSet === 'function') contentCacheSet({ holiday_homeworks: raw }); }catch(e){}
    BIG.hwFlash = diff;
    BIG.hwPrev = nowStr;
    BIG.hwPrevData = raw;
    if(BIG.hwOn) BIG.renderHw();
    try{ if(typeof refreshHwViews === 'function') refreshHwViews(); }catch(e){}
    if(BIG.hwOn) hwFlashPaint();
    return true;
  }

  /* 排队：每秒看一次「还在打字吗」，手停下来（输入框失焦 / 值已提交）就应用。
     不弹提示、不打断 —— 站主要的「无感刷新」就是这个意思：
     字照打，改完一松手，别人才看到的那份就悄悄上来了，改动处照旧标黄。 */
  var _hwQ = null, _hwQT = null;
  function hwQueue(raw){
    _hwQ = raw;
    if(_hwQT) return;
    _hwQT = setInterval(function (){
      if(!_hwQ){ clearInterval(_hwQT); _hwQT = null; return; }
      if(BIG.hwOn && hwDirty()) return;
      var r = _hwQ; _hwQ = null;
      clearInterval(_hwQT); _hwQT = null;
      /* 同步过之后 hwPrev 已经变了，这里再比一次；一样就什么都不做 */
      if(JSON.stringify(r) !== BIG.hwPrev) hwApply(r);
    }, 1000);
  }
  function hwFlashPaint(){
    var f = BIG.hwFlash;
    if(!f) return;
    var n = 0;
    var rows = document.querySelectorAll('#bigHw .bhw-task');
    for(var i = 0; i < rows.length; i++){
      var el = rows[i];
      var txt = el.querySelector('.bhw-txt');
      var ta = el.querySelector('textarea');
      var s = txt ? String(txt.textContent || '') : (ta ? String(ta.value || '') : '');
      if(s && f.tasks[s]){ el.classList.add('bhw-flash'); n++; }
    }
    var cards = document.querySelectorAll('#bigHw .bhw-subj');
    for(var j = 0; j < cards.length; j++){
      var h = cards[j].querySelector('.bhw-subj-h b') || cards[j].querySelector('.bhw-subj-h input');
      var nm = h ? String(h.value || h.textContent || '').trim() : '';
      if(nm && f.subNames[nm]){ cards[j].classList.add('bhw-flash-card'); n++; }
    }
    if(n) toast(f.added ? '手机端刚更新了作业' : '作业有改动，已标出来');
    setTimeout(function (){
      var a = document.querySelectorAll('#bigHw .bhw-flash,#bigHw .bhw-flash-card');
      for(var k = 0; k < a.length; k++) a[k].classList.remove('bhw-flash', 'bhw-flash-card');
    }, 5000);
  }
  /* 「已同步」角标点一下 = 立刻拉一次云端并重画 */
  BIG.hwRefreshNow = function (){
    /* v4.7.1：离线时不必真发请求（要等 DNS 超时十几秒），直接说清楚 */
    if(typeof navigator !== 'undefined' && navigator.onLine === false){
      toast('当前设备离线，显示的是本机缓存；联网后可刷新', true);
      syncBadge();
      return;
    }
    var el = $('bhwSync');
    if(el){ el.className = 'bhw-sync busy'; el.innerHTML = '<i></i>刷新中'; }
    if(typeof api !== 'function'){ syncBadge(); return; }
    api('/content').then(function (j){
      var it = (j && j.items) || {};
      var raw = it.holiday_homeworks;
      if(typeof raw === 'string'){ try{ raw = JSON.parse(raw); }catch(e){ raw = null; } }
      /* 本机有未上传改动时不覆盖，避免手动刷新把自己的改动画掉 */
      if(Array.isArray(raw) && hwLocalPending()){
        toast('本机还有未上传的改动，已保留本机版本');
        syncBadge();
        return;
      }
      var changed = Array.isArray(raw) ? hwApply(raw) : false;
      if(!changed) toast('已是最新作业');
      syncBadge();
    }).catch(function (){ toast('刷新失败，请检查网络', true); syncBadge(); });
  };

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
    if(!canEdit()){ toast('当前不可导出', true); return; }
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
        + hwSortDesc(list).map(function (x){
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
    if(!canEdit()){ toast('当前不可导入', true); return; }
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

  /* ---------- v4.10.2（站主第 7 条）：权重 / 配额 ----------
     站主原话：「随便点名再加一点功能，就是有一个权重功能，比如说这次点的时候呢，
     我们可以说每个学号段，每个成绩段，还有男女班干部课代表，都可以设置最多和最少抽几个人，
     包括还可以设置比如说上次抽中的人不参与本次抽取。」

     设计：
       · W_DEF 里列出**可配额的维度**：
           sid   学号段（01–10 / 11–20 / … / 51–62，跟颜色分段一致）
           grade 成绩段（按所选考试的名次分档 1-10 / 11-20 / …）
           sex   性别（男 / 女）
           role  身份（学生 / 课代表 / 班干部）
       · 每个维度下每一档可以设 min（至少抽几个）/ max（最多抽几个），空 = 不限。
       · 另有一个总开关：上次抽中的人不参与本次抽取。
       · 抽取时按维度逐一检查配额：不足 min 的先补，超了 max 的跳过。

     存储：跟条件一起存在本机 F_KEY 里（f.w = { sid:{'0':{min,max}}, ... }，
     f.noLast = 1），老配置没有这字段时按默认值走。 */
  var W_DEF = {
    sid:   ['01–10', '11–20', '21–30', '31–40', '41–50', '51–62'],
    grade: ['名次 1–10', '名次 11–20', '名次 21–30', '名次 31–40', '名次 41–50', '名次 51+'],
    sex:   ['男', '女'],
    role:  ['学生', '课代表', '班干部'],
  }
  /* 维度中文名（放在 W_DEF 旁边，免得用到时才定义） */
  var W_DIM_NAME = { sid: '学号段', grade: '成绩段', sex: '性别', role: '身份' };
  var W_KEY = 'cls_big_pick_w';
  function wClean(o){
    var out = {};
    if(!o || typeof o !== 'object' || Array.isArray(o)) return out;
    Object.keys(W_DEF).forEach(function(dim){
      var src = o[dim];
      if(!src || typeof src !== 'object' || Array.isArray(src)) return;
      var d = {};
      W_DEF[dim].forEach(function(_, i){
        var v = src[String(i)];
        if(!v || typeof v !== 'object') return;
        var mn = parseInt(v.min, 10), mx = parseInt(v.max, 10);
        var e = {};
        if(isFinite(mn) && mn > 0) e.min = mn;
        if(isFinite(mx) && mx > 0) e.max = mx;
        if(e.min || e.max) d[String(i)] = e;
      });
      if(Object.keys(d).length) out[dim] = d;
    });
    return out;
  }
  function loadW(){
    try{
      var o = JSON.parse(localStorage.getItem(W_KEY) || 'null');
      return wClean(o);
    }catch(e){ return {}; }
  }
  function saveW(w){
    try{ localStorage.setItem(W_KEY, JSON.stringify(wClean(w))); }catch(e){}
  }

  /* v4.7.0（站主第 2 条）：名单设置改成云端共享。
     原话：「不参与名单是可以上传的，云端同步哪个不参与哪个参与的，
            省得我每次换设备都要重新填一次」。
     所以真源变成云端内容键 pick_exclude（{ 姓名: 'leave' | 'out' }）：
       · 管理员改一次就推云端，任何设备打开都拿到同一份；
       · 没登录 / 普通同学只能改本机（权限跟「上传云端」保持一致）；
       · 云端还没这份数据时，用本机旧名单兜底，并且管理员登录后自动补传。 */
  function exClean(o){
    var out = {};
    if(!o || typeof o !== 'object' || Array.isArray(o)) return out;
    Object.keys(o).forEach(function (k){
      var v = o[k];
      if((v === 'leave' || v === 'out') && String(k).trim()) out[String(k)] = v;
    });
    return out;
  }
  function loadEx(){
    var d = data(), cloud = d && d.pickExclude;
    if(cloud && typeof cloud === 'object' && !Array.isArray(cloud)){
      var o = exClean(cloud);
      try{ localStorage.setItem(EX_KEY, JSON.stringify(o)); }catch(e){}
      return o;
    }
    var local = {};
    try{ local = exClean(JSON.parse(localStorage.getItem(EX_KEY) || '{}')); }catch(e){ local = {}; }
    if(Object.keys(local).length && adminOk() && typeof pushCloudContent === 'function'){
      pushCloudContent({ pick_exclude: local }, true);
    }
    return local;
  }
  function saveEx(o){
    var clean = exClean(o);
    try{ localStorage.setItem(EX_KEY, JSON.stringify(clean)); }catch(e){}
    try{ var d = data(); if(d) d.pickExclude = clean; }catch(e){}
    try{
      if(typeof pushCloudContent === 'function' && adminOk()) pushCloudContent({ pick_exclude: clean }, true);
    }catch(e){}
  }

  /* ---------------- 抽取历史（v4.4.0 站主第 4 条） ----------------
     站主要求：「可以看到历史记录，具体是时间点、条件、抽取人数以及具体的抽取人员。
              然后我可以在下面写备注，就说这次是用来干嘛的，需要上传云端」
     存储：本机 localStorage 是真源（断网也能写），同时整包推云端 pick_history。
           云端走 /api/content，只有管理员 token 能写 —— 班级电脑上登的是管理员，够用。
     合并：本机 ∪ 云端，按 id 去重、时间倒序。这样换设备也能看到别人抽过的记录。 */
  var PH_KEY = 'cls_pick_hist';
  var PH_MAX = 300;
  /* v4.7.0（站主第 1 条）：「抽取历史里经常删不掉一些记录」。
     根因：删记录只改了本机数组，云端那份还在 SITE_DATA.pickHistory 里，
     下一次 phMerge() 又把云端那份并回来 —— 列表看着原地复活。
     解法：删过的人落一个「墓碑」id，phMerge 见到墓碑直接跳过；
     同时把 SITE_DATA 里那份也改掉，任何一次内容上传都不会把旧的又推上去。 */
  var PH_DEL_KEY = 'cls_pick_hist_del';
  /* v4.7.11（站主第 12 条）：「我在手机上删了一次，打开电脑发现记录还在」。
     根因：墓碑只写在本机 localStorage —— 删的那台知道，别的设备不知道，
     它们合并时把云端那份又并回来，记录原地复活。
     现在墓碑也上云（内容键 pick_hist_del），合并时本机 + 云端一起认。 */
  function phTomb(){
    var a = [];
    try{ a = JSON.parse(localStorage.getItem(PH_DEL_KEY) || '[]'); }catch(e){ a = []; }
    if(!Array.isArray(a)) a = [];
    try{
      var d = data();
      if(d && Array.isArray(d.pickHistDel)){
        d.pickHistDel.forEach(function (id){
          var k = String(id || '');
          if(k && a.indexOf(k) < 0) a.push(k);
        });
      }
    }catch(e){}
    return a;
  }
  function phTombAdd(id){
    var a = phTomb();
    if(a.indexOf(id) < 0){ a.push(id); }
    try{ localStorage.setItem(PH_DEL_KEY, JSON.stringify(a.slice(-600))); }catch(e){}
  }
  function phLocal(){
    var a = [];
    try{ a = JSON.parse(localStorage.getItem(PH_KEY) || '[]'); }catch(e){ a = []; }
    return Array.isArray(a) ? a : [];
  }
  function phMerge(){
    var map = {}, out = [], dead = {};
    phTomb().forEach(function (id){ dead[String(id)] = 1; });
    function add(x){
      if(!x || !x.id || map[x.id]) return;
      if(dead[String(x.id)]) return;
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
    /* v4.7.0：本机就是「当前这份历史」的真源。不同步回 SITE_DATA 的话，
       下一次别处触发的整包内容上传会拿旧的 SITE_DATA 把删掉的记录又推回云端。 */
    try{ var d = data(); if(d && Array.isArray(list)) d.pickHistory = list; }catch(e){}
    if(push === false) return;
    /* 没登录 / 不是管理员就只落本机，等下次有人登管理员再说（列表本身会一起带上） */
    try{
      if(typeof pushCloudContent === 'function' && adminOk()){
        /* 墓碑跟着一起推 —— 否则别的设备仍会把它加回来 */
        pushCloudContent({ pick_history: list, pick_hist_del: phTomb() }, true);
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
    var key = String(id);
    /* ① 落墓碑（防止云端那份在下次合并时复活）
       ② 从本机与 SITE_DATA 里同时摘掉
       ③ 立刻推云端；推不上去也不要紧，墓碑会一直挡着 */
    phTombAdd(key);
    var list = phMerge().filter(function (x){ return String(x.id) !== key; });
    phSave(list);
    if(BIG.pick.rec && String(BIG.pick.rec.id) === key) BIG.pick.rec = null;
    BIG.pickBody();
    toast(adminOk() ? '已删除，云端同步中' : '已在本机删除（登录管理员才会同步到其他设备）');
  };

  /* ---------------- 批量删除（v4.7.11 站主第 12 条） ---------------- */
  BIG.pickSelToggle = function (){
    BIG.pick.selMode = !BIG.pick.selMode;
    BIG.pick.sel = {};
    BIG.pickBody();
  };
  BIG.pickSelOne = function (id, el){
    BIG.pick.sel = BIG.pick.sel || {};
    var k = String(id);
    if(BIG.pick.sel[k]) delete BIG.pick.sel[k];
    else BIG.pick.sel[k] = 1;
    if(el && el.parentNode) el.parentNode.classList.toggle('on', !!BIG.pick.sel[k]);
    /* v4.9.1（站主第 7 条）：「批量删除那个不会打勾，虽然显示，但框里没有勾」。
       真因：勾是**渲染时**写进按钮文字里的（'✓' 或空），点一下只改了父元素的
       .on 类（只换背景色），从来没改过这行文字 —— 于是框变色了但没有勾。
       这里点的时候把文字一起写掉。 */
    if(el) el.textContent = BIG.pick.sel[k] ? '✓' : '';
    var b = document.getElementById('bpickSelDel');
    if(b){
      var n = Object.keys(BIG.pick.sel).length;
      b.textContent = '删除选中' + (n ? '（' + n + '）' : '');
      b.disabled = !n;
    }
  };
  BIG.pickSelAll = function (){
    var list = [];
    try{ list = phMerge(); }catch(e){ list = []; }
    var sel = BIG.pick.sel || {};
    var allOn = list.length > 0 && list.every(function (r){ return sel[String(r.id)]; });
    BIG.pick.sel = {};
    if(!allOn) list.forEach(function (r){ BIG.pick.sel[String(r.id)] = 1; });
    BIG.pickBody();
  };
  function phDelMany(ids){
    var del = {};
    ids.forEach(function (id){ del[String(id)] = 1; phTombAdd(String(id)); });
    var list = phMerge().filter(function (x){ return !del[String(x.id)]; });
    phSave(list);
    if(BIG.pick.rec && del[String(BIG.pick.rec.id)]) BIG.pick.rec = null;
    /* 立即再推一次：确保云端那份也把墓碑带上，不等下一次保存 */
    try{
      if(typeof pushCloudContent === 'function' && adminOk()){
        pushCloudContent({ pick_history: list, pick_hist_del: phTomb() }, true);
      }
    }catch(e){}
    return ids.length;
  }
  BIG.pickSelDel = function (){
    var ids = Object.keys(BIG.pick.sel || {});
    if(!ids.length) return;
    if(!confirm('删除选中的 ' + ids.length + ' 条抽取记录？删除后无法恢复。')) return;
    phDelMany(ids);
    BIG.pick.sel = {};
    BIG.pickBody();
    toast('已删除 ' + ids.length + ' 条' + (adminOk() ? '，云端同步中' : '（仅本机）'));
  };
  /* 「删除 30 天前」——站主说的「按时间批量删」，比一条条点省事 */
  BIG.pickSelOld = function (days){
    var cut = Date.now() - (days || 30) * 86400000;
    var ids = [];
    try{ ids = phMerge().filter(function (r){ return Number(r.at) < cut; }).map(function (r){ return r.id; }); }catch(e){}
    if(!ids.length){ toast('没有 ' + (days || 30) + ' 天前的记录'); return; }
    if(!confirm('删除 ' + (days || 30) + ' 天前的 ' + ids.length + ' 条记录？')) return;
    phDelMany(ids);
    BIG.pickBody();
    toast('已删除 ' + ids.length + ' 条');
  };

  function loadF(){
    var f = null;
    try{ f = JSON.parse(localStorage.getItem(F_KEY) || 'null'); }catch(e){}
    if(!f || typeof f !== 'object') f = {};
    var out = {};
    for(var k in F_DEF) out[k] = (f[k] === undefined ? F_DEF[k] : f[k]);
    if(!Array.isArray(out.role)) out.role = ['学生'];
    /* v4.8.0：老配置里可能存着「老师 / 管理员」，现在不认了，过滤掉；
       过滤完空的就退回「学生」，否则会变成谁都抽不到 */
    out.role = out.role.filter(function(r){ return r === '学生' || r === '课代表' || r === '班干部'; });
    if(!out.role.length) out.role = ['学生'];
    /* v4.10.0（站主第 1 条）：「身份是三选一，不能又是学生又是班干部，
       不然会被学生所包含」。老配置里存过多选，这里只认第一个。 */
    out.role = [out.role[0]];
    /* v4.7.3：老版本存下来的残影 —— 考试已改成「不限成绩」，名次条件还留着 */
    if(!out.examId){ out.metric = ''; out.subj = ''; out.min = ''; out.max = ''; }
    return out;
  }
  function saveF(){
    try{ localStorage.setItem(F_KEY, JSON.stringify(BIG.pick.f)); }catch(e){}
  }

  /* 名单：优先云端（带学号/身份/性别），失败退回本机缓存，再退站内姓名列表。
     v4.7.3：班级电脑长期离线，原来一断网就退到 classList()，那份名单**没有学号**，
     于是抽取动画里所有人都是同一个中性灰 —— 站主说的「颜色都一样」就是这儿来的。
     现在每次成功拉到云端名单都存一份本机副本，离线直接用副本，颜色照常分段。 */
  var ROSTER_KEY = 'cls_pick_roster_v1';
  function rosterCacheGet(){
    try{
      var o = JSON.parse(localStorage.getItem(ROSTER_KEY) || 'null');
      if(o && Array.isArray(o.list) && o.list.length) return o.list;
    }catch(e){}
    return null;
  }
  function rosterCacheSet(list){
    try{ localStorage.setItem(ROSTER_KEY, JSON.stringify({ at: Date.now(), list: list })); }catch(e){}
  }
  function loadRoster(done){
    function fallback(){
      /* ① 先看本机缓存（带真学号，最准） */
      var cached = rosterCacheGet();
      if(cached){
        BIG.pick.roster = cached.map(function (x){
          return { name: x.name, studentId: String(x.studentId || ''), role: String(x.role || '学生'),
                   gender: String(x.gender || ''), title: String(x.title || '') };
        });
        if(done) done();
        return;
      }
      /* ② 连缓存都没有：用站内姓名列表，按名单顺序补一个「显示序号」。
         只给颜色用（_seq），不写进 studentId —— 学号筛选仍然按真学号走，不会被假号骗到。 */
      var names = [];
      try{ if(typeof classList === 'function') names = classList() || []; }catch(e){}
      var seen = {}, out = [];
      names.forEach(function (x){
        var n = String(x || '').trim();
        if(!n || seen[n]) return;
        seen[n] = 1;
        out.push({ name: n, studentId: '', role: '学生', gender: '', title: '', _seq: out.length + 1 });
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
          rosterCacheSet(out);          /* 存一份，断网时用 */
          BIG.pick.roster = out;
          if(done) done();
        }).catch(fallback);
        return;
      }
    }catch(e){}
    fallback();
  }

  /* 成绩：考试列表 + 某次考试的班级排名（总分 / 单科，分数 / 名次） */
  /* v4.10.5（站主第 2 条）：「随机点名里面的这些范围、成绩、学号这些字段都要加到
     缓存里面，防止无网的时候也可以用。我会在有网的时候把这些成绩数据都加载一遍，
     包括成绩分析里面的东西，在无网的情况下也应该可以查看」。
     所以三样东西全部落本机：
       · 名单（含学号 / 身份 / 性别 / 头衔）—— 早就有 ROSTER_KEY；
       · 考试列表 —— 新增 EXAMS_KEY；
       · 每场考试的成绩表 —— 新增 STAT_KEY（最多留 8 场，别把 localStorage 撑爆）。
     读取顺序一律「缓存先上屏 → 有网再刷新」，断网时界面照样能用。 */
  var EXAMS_KEY = 'cls_pick_exams_v1';
  var STAT_KEY  = 'cls_pick_stat_v1';
  var STAT_KEEP = 8;

  function examsCacheGet(){
    try{
      var a = JSON.parse(localStorage.getItem(EXAMS_KEY) || 'null');
      return Array.isArray(a) ? a : null;
    }catch(e){ return null; }
  }
  function statCacheGet(){
    try{
      var o = JSON.parse(localStorage.getItem(STAT_KEY) || 'null');
      return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
    }catch(e){ return {}; }
  }
  function statCachePut(examId, stat){
    var o = statCacheGet();
    try{ o[String(examId)] = { at: Date.now(), d: stat }; }catch(e){ return; }
    var keys = Object.keys(o).sort(function (a, b){
      return (Number(o[b] && o[b].at) || 0) - (Number(o[a] && o[a].at) || 0);
    });
    var out = {};
    keys.slice(0, STAT_KEEP).forEach(function (k){ out[k] = o[k]; });
    /* 先删后写：万一新数据比旧的大，直接覆盖可能超配额，删掉再写更稳 */
    try{
      localStorage.removeItem(STAT_KEY);
      localStorage.setItem(STAT_KEY, JSON.stringify(out));
    }catch(e){
      /* 还是写不下 → 只留最近 3 场再试一次，实在不行就放弃（不影响在线使用） */
      try{
        var small = {};
        keys.slice(0, 3).forEach(function (k){ if(out[k]) small[k] = out[k]; });
        localStorage.setItem(STAT_KEY, JSON.stringify(small));
      }catch(e2){}
    }
  }
  function statCacheWarm(){
    var o = statCacheGet(), cache = {};
    Object.keys(o).forEach(function (k){
      var v = o[k];
      if(v && v.d) cache[k] = v.d;
    });
    return cache;
  }

  function loadExams(done){
    if(BIG.pick.exams) { if(done) done(); return; }
    var cached = examsCacheGet();
    if(cached && cached.length) BIG.pick.exams = cached;      /* 缓存先上屏 */
    try{
      if(typeof api !== 'function'){ if(!BIG.pick.exams) BIG.pick.exams = []; if(done) done(); return; }
      api('/scores?action=list').then(function (j){
        var arr = (j && j.exams) || [];
        if(arr.length || !(cached && cached.length)) BIG.pick.exams = arr;
        if(arr.length){ try{ localStorage.setItem(EXAMS_KEY, JSON.stringify(arr)); }catch(e){} }
        if(done) done();
      }).catch(function (){
        /* 断网 / 没登录 → 用缓存那份，别把列表清空 */
        if(!BIG.pick.exams || !BIG.pick.exams.length) BIG.pick.exams = cached || [];
        if(done) done();
      });
    }catch(e){ if(!BIG.pick.exams) BIG.pick.exams = []; if(done) done(); }
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

  /* v4.10.0（站主第 1 条）：成绩读不到时，要把「为什么」说出来。
     以前失败只是把 stat 置空，于是界面写着「按条件可抽 0 人」，
     看着像功能坏了，其实多半是没登录 / 这场还没发布。 */
  function statErrText(e){
    var code = Number(e && e.status);
    if(code === 401) return '当前设备没登录，成绩接口不给数据';
    if(code === 403) return '这场考试还没发布，或没对当前账号开放';
    if(code === 404) return '这场考试的成绩已经不在了';
    if(e && e.offline) return '当前是离线状态，先连上网再试';
    return '成绩没取到，检查网络后重试';
  }

  function statOf(examId, done){
    if(!examId){ BIG.pick.stat = null; BIG.pick.prog = null; BIG.pick.statErr = ''; if(done) done(); return; }
    if(BIG.pick.stat && String(BIG.pick.stat.id) === String(examId)){ afterStat(done); return; }
    BIG.pick.prog = null;
    /* v4.10.5：内存缓存 → 本机缓存（断网也能用）→ 网络 */
    var cache = BIG.pick.statCache || (BIG.pick.statCache = statCacheWarm());
    var key = String(examId);
    if(cache[key]){ BIG.pick.stat = cache[key]; BIG.pick.statErr = ''; afterStat(done); return; }
    try{
      if(typeof api !== 'function'){ if(done) done(); return; }
      api('/scores?action=board&exam=' + encodeURIComponent(examId)).then(function (j){
        cache[key] = buildStat(j);
        BIG.pick.stat = cache[key];
        BIG.pick.statErr = BIG.pick.stat ? '' : '这场考试还没有成绩记录';
        if(BIG.pick.stat) statCachePut(key, BIG.pick.stat);   /* 存一份，断网时用 */
        afterStat(done);
      }).catch(function (e){
        BIG.pick.stat = null; BIG.pick.prog = null;
        BIG.pick.statErr = statErrText(e);
        if(done) done();
      });
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
    var cache = BIG.pick.statCache || (BIG.pick.statCache = statCacheWarm());
    if(cache[pid]){ BIG.pick.prevStat = cache[pid]; if(done) done(); return; }
    try{
      if(typeof api !== 'function'){ if(done) done(); return; }
      api('/scores?action=board&exam=' + encodeURIComponent(pid)).then(function (j){
        cache[pid] = buildStat(j);
        BIG.pick.prevStat = cache[pid];
        if(BIG.pick.prevStat) statCachePut(pid, BIG.pick.prevStat);
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
    rows.forEach(function (x){ var k = normName(x.name); if(k && !byName[k]) byName[k] = x; });
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
      return { name: String(r.name || '').trim(), no: String(r.no || '').replace(/\D/g, ''),
               s: r.s || {}, total: 0, totalRank: null, sub: {} };
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
    /* v4.10.0（站主第 1 条）：名字按「去掉所有空白」比对，并额外建学号索引。
       成绩表是导入的，名字里常有前后空格、全角空格，甚至用的是别名；
       只按原样字符串查，就会出现「明明有分却一个都抽不到」。 */
    var byName = {}, byNo = {};
    rows.forEach(function (r){
      var k = normName(r.name);
      if(k && !byName[k]) byName[k] = r;
      if(r.no && !byNo[r.no]) byNo[r.no] = r;
    });
    return { id: exam.id, name: exam.name || '', subjects: subs, rows: rows, byName: byName, byNo: byNo };
  }

  /* 名字归一：去首尾与中间所有空白（含全角空格），用于成绩表与名册之间的比对 */
  function normName(s){ return String(s == null ? '' : s).replace(/[\s\u3000]+/g, ''); }

  /* 在一场考试的成绩里找人：先按名字（归一后），再按学号兜底。
     站主的成绩表是导入的，名字带空格 / 用了别名都很常见；
     只按原始字符串比，会出现「设置了条件显示可抽 0 人」。 */
  function statRow(stat, st){
    if(!stat) return null;
    var n = normName(st && st.name);
    if(n && stat.byName && stat.byName[n]) return stat.byName[n];
    var sid = String((st && st.studentId) || '').replace(/\D/g, '');
    if(sid && stat.byNo && stat.byNo[sid]) return stat.byNo[sid];
    return null;
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

  /* ---------- 学号工具（v4.10.2 · 站主第 3 条） ----------
     站主原话：「你在每个学号输入框外面的文本新增 2505，用户只要输入后面两位数字就可以了，
     因为所有人学号前面四位是一样的，用户老是忘记输了」。

     所以：
       · 输入框外面固定显示公共前缀（2505），里面只填两位；
       · 内部仍存**完整学号**（250501）—— 判定逻辑一个字都不用改，
         老存档里存的也是完整学号，直接能用；
       · 再配一个「滚轮」下拉（原生 select，手机上就是滚轮），
         列出名单里**现成存在**的学号，从 1 一直到最大那个，不用自己想。 */
  var SID_PREFIX_FALLBACK = '2505';
  function sidPrefix(){
    var cnt = {};
    (BIG.pick.roster || []).forEach(function(st){
      var d = String((st && st.studentId) || '').replace(/\D/g, '');
      if(d.length >= 6){
        var p = d.slice(0, 4);
        cnt[p] = (cnt[p] || 0) + 1;
      }
    });
    var best = '', n = 0;
    for(var k in cnt){ if(cnt[k] > n){ n = cnt[k]; best = k; } }
    return best || SID_PREFIX_FALLBACK;
  }
  /* 取学号末两位（'250501' → '01'） */
  function sidTail(v){
    var d = String(v == null ? '' : v).replace(/\D/g, '');
    return d.length >= 2 ? d.slice(-2) : d;
  }
  /* 末两位 → 完整学号 */
  function sidFull(tail){
    var d = String(tail == null ? '' : tail).replace(/\D/g, '');
    if(!d) return '';
    if(d.length < 2) d = '0' + d;
    return sidPrefix() + d;
  }
  /* 名单里现成的学号（按学号升序），给滚轮下拉用 */
  function sidList(){
    var seen = {}, out = [];
    (BIG.pick.roster || []).forEach(function(st){
      var d = String((st && st.studentId) || '').replace(/\D/g, '');
      if(d.length < 4) return;
      var tail = d.slice(-2);
      if(seen[tail]) return;
      seen[tail] = 1;
      out.push({ tail: tail, full: d, name: String((st && st.name) || '') });
    });
    out.sort(function(a, b){ return Number(a.full) - Number(b.full); });
    return out;
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
    /* v4.7.3：成绩条件只有在「选了某场考试」时才算数。
       以前只看 f.metric —— 把考试切回「不限成绩」后残影还在，
       于是屏幕上写着「总分名次 1–20」，实际 stat 已经清空，谁都抽不出来。 */
    if(f.examId && f.metric){
      if(!stat) return false;
      var row = statRow(stat, st);
      if(!row) return false;
      var v = null;
      if(f.metric === 'totalRank') v = row.totalRank;
      else if(f.metric === 'totalScore') v = row.total;
      else if(needProg(f.metric)){
        var pr = BIG.pick.prog, prr = pr && pr.byName[normName(st.name)];
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

  /* ---------- v4.10.2：配额（最少 / 最多）辅助 ----------
     每个维度先算出「这个人属于哪一档」，再统计各档已抽人数。 */
  function wTierOf(dim, st, stat){
    if(dim === 'sid'){
      var no = sidNo(st);
      if(!no) return -1;
      return Math.min(5, Math.floor((no - 1) / 10));
    }
    if(dim === 'sex'){
      var g = String((st && st.gender) || '');
      if(g === '男') return 0;
      if(g === '女') return 1;
      return -1;
    }
    if(dim === 'role'){
      var r = String((st && st.role) || '学生') + ' ' + String((st && st.title) || '');
      if(roleHit('课代表', r)) return 1;
      if(roleHit('班干部', r)) return 2;
      return 0;
    }
    if(dim === 'grade'){
      /* 按当前所选成绩条件的名次分档（没选考试 / 没成绩 → 不参与这一维） */
      var f = BIG.pick.f || F_DEF;
      if(!f.examId || !f.metric || !stat) return -1;
      var row = statRow(stat, st);
      if(!row) return -1;
      var v = null;
      if(f.metric === 'totalRank') v = row.totalRank;
      else if(f.metric === 'totalScore') v = row.total;
      else if(needProg(f.metric)){
        var pr = BIG.pick.prog, prr = pr && pr.byName[normName(st.name)];
        if(!prr) return -1;
        v = (f.metric === 'totalProgress') ? prr.totalRank : (prr.subRank || {})[f.subj];
      }
      else {
        var cell = row.sub[f.subj] || {};
        v = (f.metric === 'subScore') ? cell.score : cell.rank;
      }
      if(v == null || !isFinite(Number(v))) return -1;
      var n = Number(v);
      if(n <= 0) return -1;
      return Math.min(5, Math.floor((n - 1) / 10));
    }
    return -1;
  }
  /* 已抽到的各档人数统计 */
  function wCount(dim, picked, stat){
    var c = {};
    picked.forEach(function(nm){
      var st = stuOf(nm);
      if(!st) return;
      var t = wTierOf(dim, st, stat);
      if(t < 0) return;
      c[t] = (c[t] || 0) + 1;
    });
    return c;
  }
  /* 这个人现在还能不能抽（受 max 限制） */
  function wAllow(dim, st, picked, stat){
    var w = BIG.pick.w || {};
    var cfg = w[dim];
    if(!cfg) return true;
    var t = wTierOf(dim, st, stat);
    if(t < 0) return true;                     /* 不属于任何档 → 不受这一维限制 */
    var e = cfg[String(t)];
    if(!e || !e.max) return true;
    var c = wCount(dim, picked, stat);
    return (c[t] || 0) < e.max;
  }
  /* 这个人是不是「某个维度还差最少人数」——差的人优先抽 */
  function wNeed(dim, st, picked, stat){
    var w = BIG.pick.w || {};
    var cfg = w[dim];
    if(!cfg) return false;
    var t = wTierOf(dim, st, stat);
    if(t < 0) return false;
    var e = cfg[String(t)];
    if(!e || !e.min) return false;
    var c = wCount(dim, picked, stat);
    return (c[t] || 0) < e.min;
  }
  /* 有没有哪一维把这个人卡住了 */
  function wBlocked(st, picked, stat){
    for(var d in W_DEF){
      if(!wAllow(d, st, picked, stat)) return true;
    }
    return false;
  }
  /* 有没有哪一维还差人（用来决定「优先抽谁」） */
  function wAnyNeed(st, picked, stat){
    for(var d in W_DEF){
      if(wNeed(d, st, picked, stat)) return true;
    }
    return false;
  }
  function names(arr){ return arr.map(function (x){ return x.name; }); }

  function rnd(arr){ return arr[Math.floor(Math.random() * arr.length)]; }

  /* ---------- v4.5.0 抽取动画：学号分段色 ----------
     学号形如 250501，取末两位即班内序号（01–62）。
     01–10 / 11–20 / 21–30 / 31–40 / 41–50 / 51–62 各一色；
     61、62 归入最后一段 —— 站主要求与 51–60 同色。
     老师与管理员账号没有学号，给中性灰，不参与分段。 */
  var FX_KEY = 'cls_pick_fx', FX_HIDE_KEY = 'cls_pick_hide';
  var FX_LIST = ['off', 'box', 'case'];

  function loadFx(){
    try{ var v = localStorage.getItem(FX_KEY); return FX_LIST.indexOf(v) >= 0 ? v : 'off'; }catch(e){ return 'off'; }
  }
  function saveFx(v){ try{ localStorage.setItem(FX_KEY, v); }catch(e){} }
  function loadHide(){ try{ return localStorage.getItem(FX_HIDE_KEY) !== '0'; }catch(e){ return true; } }
  function saveHide(v){ try{ localStorage.setItem(FX_HIDE_KEY, v ? '1' : '0'); }catch(e){} }

  function sidNo(st){
    var d = String((st && st.studentId) || '').replace(/\D/g, '');
    if(d.length >= 2){
      var n = parseInt(d.slice(-2), 10);
      if(n >= 1 && n <= 99) return n;
    }
    /* v4.7.3：没有学号（离线缓存的姓名列表）就按名单顺序给个序号，
       只为颜色分段，不参与任何筛选逻辑。 */
    var sq = parseInt((st && st._seq) || 0, 10);
    return (sq >= 1 && sq <= 99) ? sq : 0;
  }
  function stuOf(n){
    var arr = BIG.pick.roster || [];
    for(var i = 0; i < arr.length; i++) if(arr[i].name === n) return arr[i];
    return null;
  }
  function fxSwatch(no){
    return (typeof PickFX !== 'undefined') ? PickFX.swatch(no) : { c: '#7b8794', s: '#cbd5e1' };
  }
  function pickItem(n){ return { name: n, no: sidNo(stuOf(n)), sub: condValText(n) }; }
  function pickPoolItem(){
    return pool().map(function (st){ return { name: st.name, no: sidNo(st), sub: condValText(st.name) }; });
  }

  /* 不重复抽 n 个：先把候选洗成副本，抽一个删一个 */
  function drawUnique(cand, n){
    var rest = cand.slice(), out = [];
    while(out.length < n && rest.length){
      out.push(rest.splice(Math.floor(Math.random() * rest.length), 1)[0]);
    }
    return out;
  }

  /* ---------- v4.10.2（站主第 7 条）：带配额的抽取 ----------
     规则：
       ① 「上次抽中的人不参与本次抽取」开关开着 → 先把上次那批人从候选里剔掉；
       ② 每一维（学号段 / 成绩段 / 性别 / 身份）的 max 是硬上限 ——
          已经抽够这一档的人，不再抽同档的；
       ③ 某一维的 min 是「保底」—— 还差人时优先从这一档里抽，
          这样「至少抽 2 个女生」这种要求才能真的满足；
       ④ 条件冲突（比如「至少 3 个男生」但范围里只有 2 个男生）时优先保证 max 不超，
          能满足多少满足多少，并在结果里说明。 */
  function drawQuota(cand, n){
    var stat = BIG.pick.stat;
    var picked = [];
    var rest = cand.slice();
    /* ① 排除上次抽中的人 */
    var excl = BIG.pick.exclLast && lastPickedNames();
    if(excl && excl.length){
      rest = rest.filter(function(x){ return excl.indexOf(x) < 0; });
    }
    var guard = rest.length * 4 + 40;
    while(picked.length < n && rest.length && guard-- > 0){
      /* 先看有没有「差保底」的候选 */
      var idx = -1;
      for(var i = 0; i < rest.length; i++){
        var st = stuOf(rest[i]);
        if(!st) continue;
        if(wBlocked(st, picked, stat)) continue;
        if(wAnyNeed(st, picked, stat)){ idx = i; break; }
      }
      if(idx < 0){
        /* 没有保底需求 → 随机挑一个没超 max 的 */
        var free = [];
        for(var j = 0; j < rest.length; j++){
          var st2 = stuOf(rest[j]);
          if(!st2 || wBlocked(st2, picked, stat)) continue;
          free.push(j);
        }
        if(!free.length) break;      /* 全被 max 卡住 → 只能到此为止 */
        idx = free[Math.floor(Math.random() * free.length)];
      }
      picked.push(rest[idx]);
      rest.splice(idx, 1);
    }
    return picked;
  }
  /* 上一次抽到的人（从抽取历史最新一条取） */
  function lastPickedNames(){
    try{
      var list = phMerge();
      if(!list || !list.length) return [];
      var rec = list[0];
      return (rec && Array.isArray(rec.names)) ? rec.names.slice() : [];
    }catch(e){ return []; }
  }

  global.bigPickOpen = function (){ BIG.pickOpen(); };

  BIG.pickOpen = function (){
    var m = $('bpickMask');
    if(!m) return;
    BIG.pick.ex = loadEx();
    BIG.pick.f = loadF();
    /* v4.10.2：配额配置（本机存） */
    BIG.pick.w = loadW();
    BIG.pick.exclLast = 0;
    try{ BIG.pick.exclLast = (localStorage.getItem('cls_big_pick_exclast') === '1') ? 1 : 0; }catch(e){}
    BIG.pick.wOpen = false;
    BIG.pick.n = Math.min(Math.max(1, BIG.pick.n || 1), 10);
    BIG.pick.fx = loadFx();
    BIG.pick.hideName = loadHide();
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
    /* 动画还在播的时候关面板，舞台要一起撤掉，否则会浮在首页上 */
    if(typeof PickFX !== 'undefined') PickFX.stop();
    BIG.pick.state = 'setup';
  };

  BIG.pickBackdrop = function (e){
    if(e && e.target && e.target.id === 'bpickMask') BIG.pickClose();
  };

  /* v4.10.2（站主第 4 条）：「如果抽取人数小于我所选人数，比如说我范围只有 5 个人，
     那我最多就只能加到 5 个人，不能加到 6；如果我是已经加到 6，再重新选的范围的话，
     那你就自动帮我改到最大值 5」。

     以前只夹到 10，完全不看当前范围里到底有几个人 ——
     范围只有 5 个时也能把人数加到 6，抽的时候直接少抽一个，看着像「抽少了」。
     现在：**人数上限 = 当前条件下可抽的人数**（同时不超过 10）。 */
  function pickMaxN(){
    var can = pool().length;
    if(!can) return 1;
    return Math.max(1, Math.min(10, can));
  }
  BIG.pickCount = function (d){
    var max = pickMaxN();
    var n = (BIG.pick.n || 1) + d;
    if(n > max){ n = max; }
    if(n < 1){ n = 1; }
    BIG.pick.n = n;
    BIG.pickBody();
  };
  /* 条件一变（范围改了），人数立刻跟着可用人数收一下 */
  function clampPickN(){
    var max = pickMaxN();
    if((BIG.pick.n || 1) > max){
      BIG.pick.n = max;
      return true;
    }
    return false;
  }

  /* v4.5.0：结果先定、动画后演。
     这样动画中途点「跳过」、关面板、甚至动画资源出问题，都不会改变抽到的人，
     也不会出现「看到的」和「记进历史」的两份名单。 */
  function commitPick(picked, fx){
    var p = BIG.pick;
    p.names = picked.slice();
    p.state = 'result';
    try{ phAdd(picked); }catch(e){}
    BIG.pickBody();
    try{
      if(typeof SFX === 'undefined') return;
      if(fx){ return; }                       /* 动画自己收过音，这里不叠加 */
      if(SFX.pop) SFX.pop(); else if(SFX.success) SFX.success();
    }catch(e){}
  }

  BIG.pickStart = function (){
    /* 上一次的舞台若因异常没撤干净，先清掉，避免两层叠在一起 */
    if(typeof PickFX !== 'undefined') PickFX.stop();
    var cand = names(pool());
    if(!cand.length){ toast('当前条件下无可用人员，请调整条件', true); return; }
    var p = BIG.pick;
    var n = Math.min(p.n, cand.length);
    /* v4.10.2：走带配额的抽取（配额 + 排除上次都从这里生效） */
    var picked = drawQuota(cand, n);
    /* 配额把人数卡住了 → 如实说明，不要假装抽够了 */
    if(picked.length < n){
      toast('按配额只能抽到 ' + picked.length + ' 人（其余条件冲突了）', true);
    }
    p.names = picked.slice();

    /* 关闭动画：直接出结果，不留滚动等待 */
    if(p.fx === 'off' || typeof PickFX === 'undefined'){
      commitPick(picked, false);
      return;
    }

    p.state = 'fx';
    BIG.pickBody();
    PickFX.play({
      mode: p.fx,
      items: picked.map(pickItem),   /* 只用来知道抽几人 */
      pool: pickPoolItem(),          /* 真正随机从这里取，点一次抽一个 */
      /* v4.10.2（站主第 7 条）：把配额算好的名单锁给动画 ——
         动画只在名单里揭晓（顺序仍随机，看着还是随机开箱），
         这样「最多 / 最少抽几个」在动画模式下也真的生效。 */
      locked: picked.slice(),
      hide: !!p.hideName,
      single: false,
      onDone: function (actual){
        /* v4.6.0：动画里现抽的人才是最终结果；跳过/异常时回落到预抽名单 */
        var res = (actual && actual.length) ? actual : picked;
        commitPick(res, true);
      }
    });
  };

  /* 写回抽取历史里那一条：单个人重抽后，记录必须跟屏幕一致 */
  function syncRec(){
    try{
      var rec = BIG.pick.rec;
      if(!rec || !rec.id) return;
      var list = phMerge();
      for(var k = 0; k < list.length; k++){
        if(list[k].id === rec.id){ list[k].names = BIG.pick.names.slice(); list[k].n = BIG.pick.names.length; break; }
      }
      rec.names = BIG.pick.names.slice();
      phSave(list, false);
    }catch(e){}
  }

  BIG.pickAgain = function (){
    BIG.pick.state = 'setup';
    BIG.pickStart();
  };

  BIG.pickReroll = function (i){
    var cand = names(pool());
    if(!cand.length) return;
    var others = BIG.pick.names.filter(function (_, k){ return k !== i; });
    var rest = cand.filter(function (n){ return others.indexOf(n) < 0; });
    if(!rest.length) rest = cand.slice();
    var next = rnd(rest);

    function apply(){
      BIG.pick.names[i] = next;
      syncRec();
      BIG.pickBody();
    }

    var p = BIG.pick;
    if(p.fx === 'off' || typeof PickFX === 'undefined'){ apply(); return; }
    /* 单个重抽固定按「单抽」演：从「排除已抽他人」的池子里现抽一个 */
    PickFX.play({
      mode: p.fx,
      items: [pickItem(next)],
      pool: rest.map(function (n){ return pickItem(n); }),
      hide: !!p.hideName,
      single: true,
      onDone: function (actual){
        var who = (actual && actual.length) ? actual[0] : next;
        BIG.pick.names[i] = who;
        syncRec();
        BIG.pickBody();
      }
    });
  };

  /* 条件面板开关 */
  BIG.pickFilter = function (){
    BIG.pick.fOpen = !BIG.pick.fOpen;
    BIG.pickBody();
  };

  /* 条件改动：写回内存 + 本机，然后重画（条件区在顶部，重画不影响下面的名单滚动） */
  BIG.pickSet = function (k, v){
    var f = BIG.pick.f || (BIG.pick.f = loadF());
    /* v4.10.0：身份改成单选后，这里统一按数组存，别让 '学生' 这种字符串混进来 */
    if(k === 'role') v = [String(v || '学生')];
    f[k] = v;
    if(k === 'examId'){
      BIG.pick.stat = null; BIG.pick.prog = null; BIG.pick.prevStat = null;
      /* v4.7.3（站主）：切回「不限成绩」就把名次 / 分数条件一起清掉。
         留着不显示只是障眼法 —— 顶部「条件：」那行还挂着，人以为它仍在生效。 */
      if(!v){ f.metric = ''; f.subj = ''; f.min = ''; f.max = ''; }
      statOf(v, BIG.pickBody);
    }
    /* 切到「进步排名」时，上一次考试的成绩得现拉 */
    if(k === 'metric' && needProg(v) && !BIG.pick.prog){
      loadPrevStat(function (){ calcProg(); BIG.pickBody(); });
    }
    if(k !== 'metric' && k !== 'subj' && k !== 'min' && k !== 'max'){ /* 其它条件即时生效 */ }
    /* v4.10.2（站主第 4 条）：范围改了，人数上限跟着变 ——
       已经加到 6，范围缩到 5 个，就自动落回 5。 */
    clampPickN();
    saveF();
    BIG.pickBody();
  };
  /* v4.10.0（站主第 1 条）：身份三选一。
     以前是「多选标签」，选上「学生」再点「班干部」等于还是学生（学生本来就包含班干部），
     屏幕上看着加了条件、实际没变，站主以为坏了。现在改成单选：点哪个就是哪个。 */
  BIG.pickRole = function (role){
    var f = BIG.pick.f || (BIG.pick.f = loadF());
    f.role = [role];
    /* v4.10.2：身份换了（学生 → 班干部），可抽人数可能变少 → 人数跟着收 */
    clampPickN();
    saveF();
    BIG.pickBody();
  };

  /* ---------- v4.10.2（站主第 7 条）：配额面板 ----------
     每个维度一栏，每一档两个小框：最少 / 最多。留空 = 不限。 */
  function wPanelHtml(){
    var w = BIG.pick.w || {};
    var h = '';
    h += '<div class="bpick-w-h">配额（留空 = 不限）</div>';
    Object.keys(W_DEF).forEach(function(dim){
      var cfg = w[dim] || {};
      h += '<div class="bpick-w-dim"><b>' + esc0(W_DIM_NAME[dim] || dim) + '</b>';
      W_DEF[dim].forEach(function(lb, i){
        var e = cfg[String(i)] || {};
        h += '<div class="bpick-w-row"><span class="bpick-w-k">' + esc0(lb) + '</span>'
          + '<input class="bpick-w-in" type="number" min="0" max="99" placeholder="最少" value="'
          +   (e.min ? String(e.min) : '') + '"'
          +   ' onchange="BIG.pickW(\'' + dim + '\',' + i + ',\'min\',this.value)">'
          + '<span class="bpick-w-sep">/</span>'
          + '<input class="bpick-w-in" type="number" min="0" max="99" placeholder="最多" value="'
          +   (e.max ? String(e.max) : '') + '"'
          +   ' onchange="BIG.pickW(\'' + dim + '\',' + i + ',\'max\',this.value)">'
          + '</div>';
      });
      h += '</div>';
    });
    h += '<p class="bpick-f-tip">「最少」是保底：还差人时优先从这一档抽；'
      + '「最多」是上限：这一档抽够了就不再抽同档的人。</p>';
    return h;
  }

  BIG.pickWOpen = function (){
    BIG.pick.wOpen = !BIG.pick.wOpen;
    BIG.pickBody();
  };
  BIG.pickW = function (dim, i, kind, val){
    var w = BIG.pick.w || (BIG.pick.w = {});
    if(!w[dim]) w[dim] = {};
    var e = w[dim][String(i)] || (w[dim][String(i)] = {});
    var n = parseInt(val, 10);
    if(!isFinite(n) || n <= 0){ delete e[kind]; }
    else { e[kind] = Math.min(99, n); }
    /* min > max 是自相矛盾的 → 把 max 顶上去 */
    if(e.min && e.max && e.min > e.max) e.max = e.min;
    BIG.pick.w = wClean(w);
    saveW(BIG.pick.w);
    BIG.pickBody();
  };
  BIG.pickExclLast = function (on){
    BIG.pick.exclLast = on ? 1 : 0;
    try{ localStorage.setItem('cls_big_pick_exclast', on ? '1' : '0'); }catch(e){}
    BIG.pickBody();
  };

  /* v4.10.2（站主第 3 条）：学号输入框（起 / 止）。
     结构：固定前缀文字（2505）+ 只填两位的输入框 + 一个「滚轮」下拉。
     下拉里列的是名单里**现成存在**的学号 —— 站主原话：
     「我使用文本选择就是类似一个滚轮，然后我可以从 1 选到现在目前已有的学号」。 */
  function sidField(which, cur){
    var pre = sidPrefix();
    var tail = sidTail(cur);
    var opts = ['<option value="">不限</option>'];
    sidList().forEach(function(x){
      opts.push('<option value="' + attr0(x.tail) + '"'
        + (String(x.tail) === String(tail) ? ' selected' : '') + '>'
        + esc0(x.tail) + (x.name ? ' ' + esc0(x.name) : '') + '</option>');
    });
    return '<span class="bpick-sid">'
      + '<span class="bpick-sid-pre">' + esc0(pre) + '</span>'
      + '<input class="bpick-in bpick-sid-in" inputmode="numeric" maxlength="2"'
      +   ' placeholder="起" value="' + attr0(tail) + '"'
      +   ' onchange="BIG.pickSid(\'' + which + '\',this.value)"'
      +   ' oninput="this.value=this.value.replace(/\\D/g,\'\')">'
      + '<select class="bpick-sel bpick-sid-wheel" onchange="BIG.pickSid(\'' + which + '\',this.value)">'
      +   opts.join('')
      + '</select>'
      + '</span>';
  }

  /* v4.10.2（站主第 3 条）：设学号范围的统一入口。
     两个输入框（起 / 止）和两个滚轮下拉都走这里，规则只有一条：
     **左边永远不能大于右边**。
     用户把左边填大了怎么办？自动对调并说明一句 —— 比默默不生效好。 */
  BIG.pickSid = function (which, val){
    var f = BIG.pick.f || (BIG.pick.f = loadF());
    var d = String(val == null ? '' : val).replace(/\D/g, '');
    if(d.length > 2) d = d.slice(-2);
    if(!d){
      f[which] = '';
      saveF();
      BIG.pickBody();
      return;
    }
    f[which] = sidFull(d);
    if(f.sidMin && f.sidMax && Number(f.sidMin) > Number(f.sidMax)){
      var t = f.sidMin; f.sidMin = f.sidMax; f.sidMax = t;
      toast('已自动对调：左边学号必须小于右边');
    }
    clampPickN();
    saveF();
    BIG.pickBody();
  };

  /* v4.5.0：动画开关。选一次记一次，下次打开面板还是上次的选择。 */
  BIG.pickSetFx = function (v){
    if(FX_LIST.indexOf(v) < 0) return;
    BIG.pick.fx = v;
    saveFx(v);
    BIG.pickBody();
  };
  BIG.pickHideToggle = function (){
    BIG.pick.hideName = !BIG.pick.hideName;
    saveHide(BIG.pick.hideName);
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

  /* v4.10.0（站主第 1 条）：抽完之后要把「凭什么抽到这几个人」摆在明面上 ——
     比如按「语文 100–110」抽的，每个人名字后面就标出他的语文成绩。
     分数 / 名次 / 进步排名都按当前这条条件取，没设条件就返回 null（不显示）。 */
  function condValOf(name){
    var f = BIG.pick.f || F_DEF;
    if(!f.examId || !f.metric) return null;
    var stat = BIG.pick.stat;
    if(!stat) return null;
    var st = stuOf(name) || { name: name };
    var row = statRow(stat, st);
    var subName = f.subj || '';
    (stat.subjects || []).forEach(function (sb){ if(sb.key === f.subj) subName = sb.name; });
    var cell = (row && row.sub) ? (row.sub[f.subj] || {}) : {};
    var v = null, tag = '';

    if(f.metric === 'totalRank'){ v = row ? row.totalRank : null; tag = '总分'; }
    else if(f.metric === 'totalScore'){ v = row ? row.total : null; tag = '总分'; }
    else if(f.metric === 'subScore'){ v = cell.score; tag = subName; }
    else if(f.metric === 'subRank'){ v = cell.rank; tag = subName; }
    else if(f.metric === 'totalProgress' || f.metric === 'subProgress'){
      var pr = BIG.pick.prog, prr = pr && pr.byName[normName(name)];
      if(f.metric === 'totalProgress'){ v = prr ? prr.totalRank : null; tag = '总分'; }
      else { v = (prr && prr.subRank) ? prr.subRank[f.subj] : null; tag = subName; }
      if(v == null || !isFinite(v)) return null;
      return { tag: tag, val: '进步第 ' + v + ' 名' };
    }
    if(v == null || !isFinite(v)) return null;
    if(f.metric.indexOf('Rank') >= 0) return { tag: tag, val: '第 ' + v + ' 名' };
    return { tag: tag, val: String(Math.round(v * 10) / 10) };
  }
  function condValText(name){
    var c = condValOf(name);
    return c ? (c.tag ? c.tag + ' ' : '') + c.val : '';
  }
  BIG.pickCondVal = condValText;   /* 调试/外部调用 */

  function condText(){
    var f = BIG.pick.f || F_DEF, arr = [];
    arr.push((f.role && f.role[0]) || '学生');
    if(f.gender) arr.push(f.gender);
    if(f.sidMin !== '' || f.sidMax !== ''){
      /* v4.10.2：摘要里也只显示末两位（前缀都一样，不必重复） */
      arr.push('学号 ' + (f.sidMin ? sidTail(f.sidMin) : '不限') + '–' + (f.sidMax ? sidTail(f.sidMax) : '不限'));
    }
    if(f.examId && f.metric){
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

  /* 动画选择区（v4.6.0）：关闭 / 盲盒 / 宝箱。
     颜色图例与动画里的一致，取自 PickFX 的同一份色板，避免两处色值走偏。 */
  function fxPanel(){
    var p = BIG.pick, fx = p.fx || 'off';
    var labels = [['off', '关闭'], ['box', '盲盒'], ['case', '宝箱']];
    var chips = labels.map(function (x){
      return '<button type="button" class="bpick-chip sm' + (fx === x[0] ? ' on' : '') + '"'
        + ' onclick="BIG.pickSetFx(\'' + x[0] + '\')">' + x[1] + '</button>';
    }).join('');

    var ranges = ['01–10', '11–20', '21–30', '31–40', '41–50', '51–62'];
    var dots = ranges.map(function (r, i){
      var sw = fxSwatch(i * 10 + 1);
      return '<i style="--pc:' + sw.c + ';--ps:' + sw.s + '"></i>' + r;
    }).join('');

    var tip;
    if(fx === 'off'){
      tip = '<p class="bpick-fx-tip">关闭动画后，点击「开始抽取」直接显示结果。</p>';
    } else if(fx === 'case'){
      tip = '<p class="bpick-fx-tip">颜色按学号分段：' + dots + '。卡片横向滚动，中间方框内面积最大的即中选；'
        + (p.hideName ? '抽取中只显示色块，停止后自动显示姓名。' : '抽取中姓名随卡片一同显示。') + '</p>';
    } else {
      tip = '<p class="bpick-fx-tip">颜色按学号分段：' + dots + '。格子数按条件人数（最多 10 个），点一次抽一人：先显学号段颜色，随后自动显示姓名。</p>';
    }

    var hide = (fx === 'case')
      ? '<div class="bpick-fx-row" style="margin-top:9px"><span class="bpick-fx-k">姓名</span>'
        + '<div class="bpick-chips"><button type="button" class="bpick-chip sm' + (p.hideName ? ' on' : '') + '"'
        + ' onclick="BIG.pickHideToggle()">抽取时隐藏姓名</button></div></div>'
      : '';

    return '<div class="bpick-fx"><div class="bpick-fx-row"><span class="bpick-fx-k">动画</span>'
      + '<div class="bpick-chips">' + chips + '</div></div>' + hide + tip + '</div>';
  }

  function two(n){ n = String(n); return n.length < 2 ? '0' + n : n; }

  /* ---------------- v4.10.5（站主第 1 条）：查看当前范围内是哪些人 ----------------
     点一下「查看」，把 pool() 里真正会被抽到的人列出来：
     姓名 + 学号末两位 + 在这个条件下这个人的值（分数 / 名次）。
     请假和不参与的人已经在 pool() 里被剔掉了，所以看到的名单就是抽签的取值范围。 */
  function peekHtml(){
    var p = BIG.pick;
    if(!p.peek || p.state !== 'setup') return '';
    var arr = pool();
    if(!arr.length) return '';
    var rows = arr.map(function (st){
      var no = sidNo(st);
      var sub = condValText(st.name);
      return '<span class="bpick-peek-i"><b>' + esc0(st.name) + '</b>'
        + (no ? '<i>' + ('0' + no).slice(-2) + '</i>' : '')
        + (sub ? '<u>' + esc0(sub) + '</u>' : '')
        + '</span>';
    }).join('');
    return '<div class="bpick-peek">'
      + '<div class="bpick-peek-h">这个范围里的 ' + arr.length + ' 个人'
      + '<span>（已排除请假 / 不参与）</span></div>' + rows + '</div>';
  }
  BIG.pickPeek = function (){
    BIG.pick.peek = !BIG.pick.peek;
    BIG.pickBody();
  };

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
      + (all.length ? '（共 ' + all.length + ' 人）' : '')
      /* v4.10.5（站主第 1 条）：「按条件可抽取 n 人的那个地方可以加一个查看功能，
         因为我就点击查看，我就可以看到在这个范围内是哪些人」 */
      + (left.length
          ? ' <button type="button" class="bpick-link" style="margin:0 0 0 6px"'
            + ' onclick="BIG.pickPeek()">' + (p.peek ? '收起名单' : '查看') + '</button>'
          : '')
      + '</div>';

    if(!all.length){
      box.innerHTML = head + '<div class="bpick-empty">名单加载失败。<br>请确认已登录，并检查网络后重试。</div>';
      return;
    }

    /* 动画播放中：舞台盖在面板上方，这里只留一句占位，
       避免背后露出半份结果 —— 也避免面板被误点。 */
    if(p.state === 'fx'){
      box.innerHTML = head + '<div class="bpick-empty">抽取动画播放中。</div>';
      return;
    }

    if(p.state === 'setup'){
      var f = p.f || F_DEF;
      var stat = p.stat;
      var exCount = Object.keys(p.ex || {}).length;

      /* v4.4.0 起有「班干部」，v4.4.2 拆出「课代表」。
         身份值仍是后台「成员档案 → 身份」那个自由文本（maxlength 10），
         填「班长」「团支书」「语文课代表」都能被对应按钮认出来，不用改数据库。 */
      /* v4.8.0（站主）：「随机点名只能抽学生，班主任、管理员这些都不要，
         除了学生课代表和班干部，暂时只留这三个」。
         老师 / 管理员本来就被 roleHit('学生') 排除在外，这里连按钮一起去掉。 */
      var roles = ['学生', '课代表', '班干部'];
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
            + '<div class="bpick-f-tip">性别和身份是在后台「成员档案」里填的；'
            +   '档案里没填性别的人，选「男 / 女」时抽不到，选「不限」不影响。</div>'
            + '<div class="bpick-f-row"><span class="bpick-f-k">学号</span>'
            +   sidField('sidMin', f.sidMin)
            +   '<span class="bpick-dash">–</span>'
            +   sidField('sidMax', f.sidMax)
            + '</div>'
            + '<div class="bpick-f-tip">学号前面几位都一样（' + esc0(sidPrefix()) + '），'
            +   '框里只填最后两位就行；右边那个下拉可以直接滚着选现成的学号。'
            +   '左边的学号必须小于右边的，填反了会自动对调。</div>'
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
            + ((f.examId && !stat)
                ? ('<div class="bpick-f-tip" style="color:#b45309">'
                   + esc0(BIG.pick.statErr || '这场考试的成绩还在读取，稍等一下…')
                   + '（读不到成绩时，成绩条件会把所有人都筛掉）</div>')
                : '')
            + '<p class="bpick-f-tip">名次均为<b>本班排名</b>。多个条件可叠加使用。'
            + '「进步排名」按较上一场考试的班级名次提升幅度排序，1 为进步最大。</p>'
            + '<p class="bpick-f-tip">「班干部」包含班长、副班长、学习委员、劳动委员、生活委员、团支书、体育委员、宣传委员、文艺委员、纪律委员；'
            + '「课代表」包含各科课代表。职务以<b>「头衔任命」</b>为准。</p>'
            + '</div>')
        : '';

      /* v4.10.2（站主第 7 条）：配额面板入口 + 「上次抽中的人不参与」开关 */
      var wPanel = '';
      if(p.wOpen){
        wPanel = '<div class="bpick-w">' + wPanelHtml() + '</div>';
      }
      var noOne = left.length ? '' : '<div class="bpick-empty" style="padding:12px 0 4px">当前条件下无可用人员。<br>'
        + '请调整性别、学号或成绩条件后重试。</div>';

      box.innerHTML = head + noOne
        + '<div class="bpick-cond">条件：' + esc0(condText())
        +   '<button type="button" class="bpick-link" style="margin:0 0 0 8px" onclick="BIG.pickFilter()">'
        +   (p.fOpen ? '收起' : '修改') + '</button></div>'
        + peekHtml()
        + filterHtml
        + '<div class="bpick-count"><button type="button" onclick="BIG.pickCount(-1)">−</button>'
        +   '<span><b>' + p.n + '</b> 人</span>'
        +   '<button type="button" onclick="BIG.pickCount(1)">+</button></div>'
        + fxPanel()
        + '<div class="bpick-f-row" style="margin:2px 0 10px">'
        +   '<button type="button" class="bpick-link" onclick="BIG.pickWOpen()">'
        +     (p.wOpen ? '收起配额设置' : '配额设置（最多 / 最少抽几个）') + '</button>'
        +   '<label class="bpick-chk"><input type="checkbox"'
        +     (p.exclLast ? ' checked' : '')
        +     ' onchange="BIG.pickExclLast(this.checked)">'
        +     '<span>上次抽中的人不参与本次抽取</span></label>'
        + '</div>'
        + wPanel
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

    var nn = p.names.length;
    var ncol = nn >= 17 ? 4 : (nn >= 9 ? 3 : (nn >= 5 ? 2 : 1));
    box.innerHTML = head
      + '<div class="bpick-res' + (ncol > 1 ? ' c' + ncol : '') + '">'
      + p.names.map(function (n, i){
          var no = sidNo(stuOf(n)), sw = fxSwatch(no);
          var cv = condValOf(n);
          return '<div class="bpick-res-row" style="--pc:' + sw.c + ';--ps:' + sw.s + '">'
            + '<b>' + esc0(n)
            +   (cv ? '<small class="bpick-res-tag">' + esc0((cv.tag ? cv.tag + ' ' : '') + cv.val) + '</small>' : '')
            + '</b>'
            + '<span class="bpick-res-no">' + (no ? two(no) + ' 号' : '') + '</span>'
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
    var selMode = !!BIG.pick.selMode;
    var sel = BIG.pick.sel || {};
    var selN = Object.keys(sel).length;
    var bar = selMode
      ? '<div class="bpick-hist-bar">'
        +   '<button type="button" class="bpick-hist-b" onclick="BIG.pickSelAll()">全选 / 取消</button>'
        +   '<button type="button" class="bpick-hist-b danger" id="bpickSelDel"'
        +     ' onclick="BIG.pickSelDel()"' + (selN ? '' : ' disabled') + '>'
        +     '删除选中' + (selN ? '（' + selN + '）' : '') + '</button>'
        +   '<button type="button" class="bpick-hist-b" onclick="BIG.pickSelOld(30)">删除 30 天前</button>'
        + '</div>'
      : '';
    return '<div class="bpick-hist-tip">'
      + '<span>' + (adminOk() ? '记录已同步至云端' : '记录暂存本机，管理员登录后自动上传') + '</span>'
      + '<button type="button" class="bpick-hist-mng" onclick="BIG.pickSelToggle()">'
      +   (selMode ? '完成' : '批量管理') + '</button>'
      + '</div>'
      + bar
      + '<div class="bpick-hist">' + list.map(function (r){
      var rid = attr0(r.id);
      var on = !!sel[String(r.id)];
      return '<div class="bpick-hist-item' + (on ? ' on' : '') + '">'
        + '<div class="bpick-hist-top">'
        +   (selMode
            ? '<button type="button" class="bpick-hist-chk" onclick="BIG.pickSelOne(\'' + rid + '\',this)"'
              + ' aria-label="选中这条">' + (on ? '✓' : '') + '</button>'
            : '')
        +   '<b>' + esc0(phTime(r.at)) + '</b>'
        +   '<span class="bpick-hist-n">' + r.n + ' 人</span>'
        +   (selMode ? '' : '<button type="button" class="bpick-hist-x" onclick="BIG.pickHistDel(\'' + rid + '\')">删</button>')
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
      + '<p class="bpick-ex-tip">点名字切换：不参与 / 请假。'
      + (adminOk() ? '名单已同步云端，换设备不用重填。' : '当前未登录管理员，改动只存本机。') + '</p>'
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
  /* v4.7.0：从 20 秒提到 12 秒 —— 站主要「手机上刚发完，大屏就到」。
     请求还是原来那一个 /api/content，只是同一份响应里多解析一个作业键。 */
  var ALERT_POLL = 12000;
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
    /* v4.7.1：离线就直接跳过这一轮（12 秒一次的空请求在一体机上纯属浪费） */
    try{ if(navigator.onLine === false) return; }catch(e){}
    try{
      if(typeof api !== 'function') return;
      api('/content').then(function (j){
        var it = (j && j.items) || {};
        /* v4.7.0：一次请求两件事 —— 班级提醒 + 作业增量。省一次跨域往返。
           ⚠️ 正在大屏上编辑作业、或本机还有没推上去的改动时，一律不覆盖 ——
           否则 12 秒后一轮轮询会把刚打的字刷回旧版本。 */
        try{
          var hwRaw = it.holiday_homeworks;
          if(typeof hwRaw === 'string'){ try{ hwRaw = JSON.parse(hwRaw); }catch(e){ hwRaw = null; } }
          /* v4.7.1：本机还有没上传的改动时同样不覆盖 —— 班级电脑离线改的作业，
             不能因为它一联网就被云端旧版冲掉。要覆盖得由人点「放弃」或「上传」。 */
          if(Array.isArray(hwRaw) && !hwBusy() && !hwLocalPending()) hwApply(hwRaw);
        }catch(e){}
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
    try{ if(typeof refreshQuick === 'function') refreshQuick(); }catch(e){}
    try{ if(typeof refreshAdminEntry === 'function') refreshAdminEntry(); }catch(e){}
    var pi = $('bhwPickIco');
    if(pi) pi.innerHTML = ico('dices', 20);
    if(!BIG.on) return;
    /* v4.10.6：考试数据先拉一次，之后每 5 分钟刷一次（只在 大屏 模式下跑，
       普通同学打开网页不会因此多打一次接口） */
    try{
      BIG.examLoad();
      setInterval(function (){ if(BIG.hwOn || document.visibilityState === 'visible') BIG.examLoad(); }, EXAM_TTL);
    }catch(e){}
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
