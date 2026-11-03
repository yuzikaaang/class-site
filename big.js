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
       ⑦ 图片直接铺出来，音频点一下才播
     实现上刻意保持「数据形状不变」：仍然是 holiday_homeworks 里的
     items[].tasks[]，task 依旧可以是字符串或 {text,img,audio}。
     只改渲染与交互，云端结构不动，老数据不会丢。 */

  var FS_KEY = 'cls_bhw_fs';
  var FS_STEPS = [0.85, 0.95, 1, 1.1, 1.2, 1.35, 1.5, 1.7];
  var SUBJ_A = ['语文', '数学', '英语'];
  var SUBJ_B = ['物理', '化学', '生物'];

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
    if(n < 0 || n >= FS_STEPS.length){ toast(n < 0 ? '已经是最小字号' : '已经是最大字号'); return; }
    BIG.fs = n;
    try{ localStorage.setItem(FS_KEY, String(n)); }catch(e){}
    applyFs();
  };

  /* —— 锁定：锁上以后整页点击 / 滑动 / 滚动全部失效 ——
     站主原话：「点击或滑动都没有任何反应，你必须先点解锁才行」。
     做法：一层透明遮罩盖住整页（拦截点击），再在捕获阶段拦住滚轮 / 触摸 / 方向键。
     锁定状态**不写 localStorage**：刷新页面即解锁，避免大屏自己锁死没人能开。 */
  BIG.lockOn = false;
  BIG.lockToggle = function (){
    BIG.lockOn = !BIG.lockOn;
    document.documentElement.classList.toggle('bhw-locked', BIG.lockOn);
    var b = $('bhwLockBtn');
    if(b){
      b.textContent = BIG.lockOn ? '已锁定' : '锁定';
      b.classList.toggle('bhw-lockon', BIG.lockOn);
    }
    toast(BIG.lockOn ? '已锁定：先点右下角「解锁」' : '已解锁');
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

  function currentHw(){
    var list = hwList();
    if(BIG.hwId){
      for(var i = 0; i < list.length; i++){ if(String(list[i].id) === String(BIG.hwId)) return list[i]; }
    }
    try{
      if(typeof getCurrentHomework === 'function') return getCurrentHomework();
    }catch(e){}
    return list[list.length - 1] || null;
  }

  function subjStyle(s){
    try{
      if(typeof HW_SUBJECT_STYLE !== 'undefined' && HW_SUBJECT_STYLE[s]) return HW_SUBJECT_STYLE[s];
    }catch(e){}
    return { c: '#9a3412' };
  }

  /* 媒体渲染（站主第 7 条）：
       图片 —— 直接铺在作业下面，一眼能看见；点一下只是放大，不是唯一入口。
       视频 —— 原生播放器，同样直接显示。
       音频 —— 仍然点一下才播（自动播放会被浏览器拦，也吵）。 */
  function mediaHtml(o){
    var img = o && o.img, video = o && o.video, audio = o && o.audio, label = o && o.audioLabel;
    if(!img && !video && !audio) return '';
    var out = '';
    if(img){
      var isVid = /\.(mp4|webm|mov|m4v|ogv|avi)(\?|#|$)/i.test(String(img));
      out += isVid
        ? '<video class="bhw-img" src="' + attr0(img) + '" controls preload="metadata" playsinline></video>'
        : '<img class="bhw-img" src="' + attr0(img) + '" alt="作业配图" loading="lazy"'
          + ' onload="BIG.relayout()" onclick="BIG.zoomImg(this.src)" title="点一下看大图">';
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
      ? '<textarea class="bhw-in bhw-area" rows="1" placeholder="写一项作业…"'
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
        toast('大屏模式未开启，已打开「作业查看」');
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
      act.innerHTML = sel
        + (admin && hw ? '<button type="button" class="bhw-btn ghost" onclick="BIG.hwRename()">重命名</button>' : '')
        + (admin ? '<button type="button" class="bhw-btn" onclick="BIG.hwNew()">' + ico('plus', 13) + ' 新建一期</button>' : '');
    }

    var colA = $('bhwColA'), colB = $('bhwColB'), other = $('bhwOther'), addHost = $('bhwAddSubj');
    if(!colA || !colB) return;

    if(!hw){
      colA.innerHTML = colB.innerHTML = '';
      if(other) other.innerHTML = '<div class="bhw-subj"><div class="bhw-empty">'
        + (admin ? '还没有作业。点右上角「新建一期」开始。' : '管理员还没发布作业。') + '</div></div>';
      if(addHost) addHost.innerHTML = '';
      renderSide();
      return;
    }

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
      + (admin ? '还没有科目，可在下方「添加科目」里加。' : '暂时没有作业。') + '</div></div>');
    colB.innerHTML = '';

    if(other){
      other.innerHTML = extras.length
        ? extras.map(function (x){ return subjCard(x.it, x.si, admin); }).join('')
        : '';
    }

    if(addHost){
      addHost.innerHTML = admin
        ? '<input class="bhw-in" id="bhwNewSubj" placeholder="新科目名（如 政治 / 其他）"'
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
    cards.forEach(function (el){
      var h = el.getBoundingClientRect().height;
      if(ha <= hb){ planA.push({ el: el, h: h }); ha += h + gap; }
      else { planB.push({ el: el, h: h }); hb += h + gap; }
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
    /* 排完这一栏还有富余，就让卡片平分剩余高度把栏填满；
       内容已经超过栏高时保持自然高度（页面允许纵向滚动）。 */
    stretch(colA, planA, gap);
    stretch(colB, planB, gap);
  };

  function stretch(col, plan, gap){
    if(!plan.length) return;
    var used = -gap;
    plan.forEach(function (x){ used += x.h + gap; });
    var free = col.clientHeight - used;
    plan.forEach(function (x){
      /* 按内容多少分配富余：内容多的卡片长得多，只有一两项的卡片几乎不摊开 */
      x.el.style.flexShrink = '0';
      x.el.style.flexBasis = 'auto';
      x.el.style.flexGrow = free > 12 ? String(Math.max(1, Math.round(x.h))) : '0';
    });
  }

  function scheduleLayout(){
    if(_layTimer) clearTimeout(_layTimer);
    _layTimer = setTimeout(function (){
      _layTimer = null;
      growAll();
      BIG.layoutCards();
    }, 50);
  }
  BIG.relayout = scheduleLayout;

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
    var q = $('bhwQuote');
    if(q){
      var qt = '';
      try{
        var el = document.getElementById('dailyQuoteBar');
        if(el && el.textContent.trim()) qt = el.textContent.trim();
      }catch(e){}
      if(!qt) qt = String(data().dailyQuote || '');
      q.style.display = qt ? '' : 'none';
      if(qt) q.innerHTML = '<span class="bhw-mini-k">今日一句</span>'
        + '<b class="bhw-mini-v">' + esc0(qt) + '</b>';
    }
  }

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
  }

  BIG.openClock = function (){
    try{ rememberView(); }catch(e){}
    location.href = './clock.html';
  };

  BIG.hwPick = function (v){
    BIG.hwId = v || null;
    BIG.renderHw();
    try{ setRoute('hw' + (v ? '/' + encodeURIComponent(v) : '')); }catch(e){}
  };

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
      }).catch(function (e){
        markSaved('同步失败：' + (e && e.message || e) + '（已存本机）');
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
    if(!name){ toast('先写个科目名', true); if(el) el.focus(); return; }
    var dup = (hw.items || []).some(function (x){ return String(x.subject || '').trim() === name; });
    if(dup){ toast('已经有「' + name + '」这一科了', true); return; }
    hw.items.push({ subject: name, tasks: [''] });
    BIG.renderHw();
    touch();
  };

  /* —— 新建 / 重命名（站主第 1 条）—— */
  var FORM = { mode: 'new' };
  BIG.hwNew = function (){
    if(!adminOk()){ toast('只有管理员能新建作业', true); return; }
    FORM.mode = 'new';
    var t = $('bhwFormTitle'); if(t) t.textContent = '新建一期作业';
    var d = todayStr();
    var n = $('bhwFormName'), st = $('bhwFormStart'), en = $('bhwFormEnd');
    if(n) n.value = '';
    if(st) st.value = d;
    if(en) en.value = d;
    var m = $('bhwFormMask'); if(m) m.classList.add('show');
    setTimeout(function(){ if(n) n.focus(); }, 60);
  };
  BIG.hwRename = function (){
    if(!adminOk()) return;
    var hw = currentHw(); if(!hw){ toast('还没有作业可以改名', true); return; }
    FORM.mode = 'rename';
    var t = $('bhwFormTitle'); if(t) t.textContent = '重命名这一期';
    var n = $('bhwFormName'), st = $('bhwFormStart'), en = $('bhwFormEnd');
    if(n) n.value = plain(hw.title || '');
    if(st) st.value = hw.start || '';
    if(en) en.value = hw.end || '';
    var m = $('bhwFormMask'); if(m) m.classList.add('show');
    setTimeout(function(){ if(n){ n.focus(); n.select(); } }, 60);
  };
  BIG.formClose = function (){
    var m = $('bhwFormMask'); if(m) m.classList.remove('show');
  };
  BIG.formSave = function (){
    var n = $('bhwFormName'), st = $('bhwFormStart'), en = $('bhwFormEnd');
    var name = n ? String(n.value || '').trim() : '';
    if(!name){ toast('给这一期起个名字', true); if(n) n.focus(); return; }
    var s0 = st ? String(st.value || '') : '';
    var e0 = en ? String(en.value || '') : '';
    if(s0 && e0 && e0 < s0){ toast('结束日期不能早于开始日期', true); return; }
    if(FORM.mode === 'new'){
      var list = hwList();
      var id = 'hw' + Date.now();
      list.push({
        id: id, title: name,
        start: s0 || todayStr(), end: e0 || s0 || todayStr(),
        items: [],
      });
      BIG.hwId = id;
      toast('已新建，先加科目再写作业');
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

  /* ---------------- 随机点名（v4.0.0 重做） ----------------
     站主 2026-11-03（第 6 条）原话大意：
       · 默认只抽学生（后台里那种「学生 / 老师 / 管理员」标签）
       · 学号可以设一个范围
       · 能按「本次总分第几名」「单科第几名 / 多少分」这些条件抽
       · 能按性别抽
       · 名单设置里点一下「请假」不要跳回最上面
     实现：
       · 名单改用 /profile?action=roster 的 students（带学号、身份、性别），
         拿不到就退回老的姓名列表 —— 老设备/未登录也不至于空着。
       · 成绩条件读 /scores?action=list + action=board，前端算班级排名
         （总分 = 各科赋分优先，排名并列同名次）。
       · 条件存在本机 localStorage，班级电脑下次打开还是上次那一套。
     ⚠️ 滚动位置：以前点一下就把整块 innerHTML 重绘，滚动条自然回到顶部。
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
        out.push({ name: n, studentId: '', role: '学生', gender: '' });
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

  /* 条件命中判定：身份 / 性别 / 学号范围 / 成绩条件，取交集 */
  function hit(st, f, stat){
    var roles = (f.role && f.role.length) ? f.role : ['学生'];
    if(roles.indexOf(String(st.role || '学生')) < 0) return false;
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
    if(!p.length){ toast('按现在的条件没人可抽，放宽一点试试', true); return; }
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

  /* 名单里点一下：正常 → 请假 → 不参与 → 正常。
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
    var head = '<div class="bpick-state">按条件可抽 <b id="bpickHeadCount">' + left.length + '</b> 人'
      + (all.length ? '（共 ' + all.length + ' 人）' : '') + '</div>';

    if(!all.length){
      box.innerHTML = head + '<div class="bpick-empty">名单还没加载出来。<br>请先登录（名单从云端读取），或在设置里稍后再试。</div>';
      return;
    }

    if(p.state === 'setup'){
      var f = p.f || F_DEF;
      var stat = p.stat;
      var exCount = Object.keys(p.ex || {}).length;

      var roles = ['学生', '老师', '管理员'];
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
      /* 进步排名：上一次没考 / 这是最早一场，就没法算 */
      var progTip = (needProg(f.metric) && p.progNoPrev)
        ? '<div class="bpick-f-tip" style="color:#b45309">这是最早的一次考试，没有「上一次」可比，进步排名算不出来。</div>'
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
                        + (subjOpts || '<option value="">先等成绩加载…</option>') + '</select>'
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
            + '<p class="bpick-f-tip">名次都是<b>本班排名</b>（不看年级）。条件可以叠加：比如「学生 + 男 + 总分名次 1–10」。'
            + '「进步排名」按班级名次相比上一次考试提升的幅度排，1 = 进步最多。名单只记在这台电脑上。</p>'
            + '</div>')
        : '';

      var noOne = left.length ? '' : '<div class="bpick-empty" style="padding:12px 0 4px">按现在的条件没有人可抽。<br>'
        + '检查一下性别 / 学号 / 成绩条件，或点上面的「修改」放宽。</div>';

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
      + '<div class="bpick-foot">'
      +   '<button type="button" class="bpick-go" onclick="BIG.pickAgain()">重新抽取</button>'
      +   '<button type="button" class="bpick-link" onclick="BIG.pickClose()">关闭</button>'
      + '</div>';
  };

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

  function boot(){
    applyClass();
    applyFs();
    buildHome();
    if(BIG.on) BIG.startAlerts();
    var pi = $('bhwPickIco');
    if(pi) pi.innerHTML = ico('dices', 20);
    if(!BIG.on) return;
    /* 深链 #/hw（applyHash 里是异步转过来的，这里只需保证首页已画好） */
    if(/^#\/hw/.test(location.hash || '')){
      var m = /^#\/hw\/(.+)$/.exec(location.hash || '');
      BIG.openHw(m ? decodeURIComponent(m[1]) : null);
    }
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function (){ setTimeout(boot, 0); });
  else boot();

  /* 供 app.js 判断当前是不是大屏作业页（路由用） */
  BIG.isHw = function (){ return !!BIG.hwOn; };

})(window);
