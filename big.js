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

  /* ---------------- 大屏作业页 ---------------- */

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
    BIG.renderHw();
    startClock();
  };

  BIG.closeHw = function (){
    leaveHwUi();
    try{ goHomeView(); }catch(e){}
  };

  BIG.renderHw = function (){
    var h = $('bigHw');
    if(!h) return;
    var hw = currentHw();
    var admin = adminOk();
    var list = hwList();
    var title = $('bhwTitle'), range = $('bhwRange'), act = $('bhwActions'), body = $('bhwList');
    if(!body) return;

    /* 期次下拉 + 新建（仅管理员） */
    var sel = '<select class="bhw-sel" onchange="BIG.hwPick(this.value)" title="切换作业期次">'
      + '<option value="">当前作业</option>'
      + list.slice().reverse().map(function (x){
          return '<option value="' + attr0(x.id) + '"' + (hw && String(x.id) === String(hw.id) ? ' selected' : '') + '>'
            + esc0(x.title || '未命名') + '（' + esc0(x.start || '') + ' ~ ' + esc0(x.end || '') + '）</option>';
        }).join('')
      + '</select>';
    if(act){
      act.innerHTML = sel
        + (admin ? '<button type="button" class="bhw-btn" onclick="BIG.hwNew()">' + ico('plus', 16) + ' 新建一期</button>' : '')
        + '<button type="button" class="bhw-btn ghost" onclick="BIG.closeHw()">返回大屏</button>';
    }

    if(title) title.textContent = hw ? (plain(hw.title) || '作业') : '作业';
    if(range){
      var r = hw ? ((hw.start || '') + ' ~ ' + (hw.end || '')) : '';
      range.textContent = r + (hw && hw.isDemo ? ' · 示例数据' : '') + (admin ? '' : ' · 只读');
    }

    if(!hw){
      body.innerHTML = '<div class="bhw-empty">还没有作业数据。' + (admin ? '点右上角「新建一期」开始添加。' : '等管理员发布后再来看。') + '</div>';
      renderSide();
      return;
    }

    var items = hw.items || [];
    var subjectsHtml = '';
    if(!items.length && admin){
      subjectsHtml = '<div class="bhw-empty">这一期还没有科目，点下面按钮加一科。</div>';
    }else{
      subjectsHtml = items.map(function (it, si){
        var tasks = (it.tasks || []).map(function (t, ti){
          var text = (t && typeof t === 'object') ? (t.text || '') : String(t || '');
          var extra = (t && typeof t === 'object' && (t.audio || t.img)) ? '<span class="bhw-tag">媒体</span>' : '';
          if(!admin){
            return '<div class="bhw-task"><span class="bhw-dot"></span><span class="bhw-txt">' + esc0(text) + extra + '</span></div>';
          }
          return '<div class="bhw-task">'
            + '<span class="bhw-dot"></span>'
            + '<input class="bhw-in" value="' + attr0(text) + '" placeholder="写一项作业…"'
            +   ' onchange="BIG.hwTask(' + si + ',' + ti + ',this.value)">' + extra
            + '<button type="button" class="bhw-x" title="删除这一项" onclick="BIG.hwDelTask(' + si + ',' + ti + ')">' + ico('x', 14) + '</button>'
            + '</div>';
        }).join('');
        var head = admin
          ? '<div class="bhw-subj-h">'
            + '<input class="bhw-subj-in" value="' + attr0(it.subject || '') + '" placeholder="科目" onchange="BIG.hwSubjName(' + si + ',this.value)">'
            + '<button type="button" class="bhw-x" title="删除这一科" onclick="BIG.hwDelSubj(' + si + ')">' + ico('trash', 15) + '</button>'
            + '</div>'
          : '<div class="bhw-subj-h"><b>' + esc0(it.subject || '') + '</b></div>';
        return '<div class="bhw-subj">' + head + tasks
          + (admin ? '<button type="button" class="bhw-add" onclick="BIG.hwAddTask(' + si + ')">' + ico('plus', 14) + ' 添加一项</button>' : '')
          + '</div>';
      }).join('');
    }

    body.innerHTML = '<div class="bhw-subjects">' + subjectsHtml + '</div>';
    if(admin){
      body.innerHTML += '<div class="bhw-addsubj">'
        + '<input class="bhw-in" id="bhwNewSubj" placeholder="新科目名（如 语文）" onkeydown="if(event.key===\'Enter\')BIG.hwAddSubj()">'
        + '<button type="button" class="bhw-btn" onclick="BIG.hwAddSubj()">' + ico('plus', 15) + ' 添加科目</button>'
        + '<span class="bhw-save" id="bhwSave"></span>'
        + '</div>';
    }

    renderSide();
  };

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
        c.innerHTML = '<span class="bhw-mini-k">' + esc0(sub) + '</span><b class="bhw-mini-v">' + esc0(txt) + '</b>';
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
      if(qt) q.innerHTML = '<span class="bhw-mini-k">今日一句</span><b class="bhw-mini-v">' + esc0(qt) + '</b>';
    }
  }

  function startClock(){
    function tick(){
      var t = $('bhwClockT'), s = $('bhwClockS'), b = $('bhwClock');
      if(!t) return;
      var d = new Date();
      function p(n){ return (n < 10 ? '0' : '') + n; }
      t.textContent = p(d.getHours()) + ':' + p(d.getMinutes());
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
    hw.items.push({ subject: name, tasks: [''] });
    BIG.renderHw();
    touch();
  };

  BIG.hwNew = function (){
    if(!adminOk()){ toast('只有管理员能新建作业', true); return; }
    var d = todayStr();
    var id = 'hw' + Date.now();
    var list = hwList();
    list.push({ id: id, title: d.slice(5) + ' 作业', start: d, end: d, items: [{ subject: '语文', tasks: [''] }] });
    BIG.hwId = id;
    try{
      if(typeof saveContentLocal === 'function') saveContentLocal('holiday_homeworks', list);
    }catch(e){}
    BIG.renderHw();
    persist();
    toast('已新建一期，直接在这里写就行');
  };

  /* ---------------- 随机点名 ---------------- */

  function loadEx(){
    try{ return JSON.parse(localStorage.getItem(EX_KEY) || '{}') || {}; }catch(e){ return {}; }
  }
  function saveEx(o){
    try{ localStorage.setItem(EX_KEY, JSON.stringify(o)); }catch(e){}
  }

  function rosterNames(){
    var names = [];
    try{
      if(typeof classList === 'function') names = classList() || [];
    }catch(e){}
    names = names.map(function (x){ return String(x || '').trim(); }).filter(Boolean);
    /* 去重 + 去老师（名单本身只有同学，这里再挡一次） */
    var seen = {}, out = [];
    names.forEach(function (n){ if(!seen[n]){ seen[n] = 1; out.push(n); } });
    return out;
  }

  function pool(){
    var ex = BIG.pick.ex || {};
    return (BIG.pick.roster || []).filter(function (n){ return !ex[n]; });
  }

  function rnd(arr){
    return arr[Math.floor(Math.random() * arr.length)];
  }

  global.bigPickOpen = function (){ BIG.pickOpen(); };

  BIG.pickOpen = function (){
    var m = $('bpickMask');
    if(!m) return;
    BIG.pick.roster = rosterNames();
    BIG.pick.ex = loadEx();
    BIG.pick.n = Math.min(Math.max(1, BIG.pick.n || 1), 10);
    BIG.pick.state = 'setup';
    BIG.pick.names = [];
    m.classList.add('show');
    BIG.pickBody();
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
    var p = pool();
    if(!p.length){ toast('名单里没人可抽（或都被排除了）', true); return; }
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
        /* 最终结果：不重复 */
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

  /* 单个重抽：只换这一个，其余不动，且不与其它结果重名 */
  BIG.pickReroll = function (i){
    var p = pool();
    if(!p.length) return;
    var others = BIG.pick.names.filter(function (_, k){ return k !== i; });
    var cand = p.filter(function (n){ return others.indexOf(n) < 0; });
    if(!cand.length) cand = p;
    BIG.pick.names[i] = rnd(cand);
    BIG.pickBody();
  };

  BIG.pickToggleEx = function (name, kind){
    BIG.pick.ex = BIG.pick.ex || {};
    if(BIG.pick.ex[name] === kind) delete BIG.pick.ex[name];
    else BIG.pick.ex[name] = kind;
    saveEx(BIG.pick.ex);
    BIG.pickBody();
  };

  BIG.pickBody = function (){
    var box = $('bpickBody');
    if(!box) return;
    var p = BIG.pick, all = p.roster || [], left = pool();
    var head = '<div class="bpick-state">当前可抽取 <b>' + left.length + '</b> 人'
      + (all.length ? '（共 ' + all.length + ' 人）' : '') + '</div>';

    if(!all.length){
      box.innerHTML = head + '<div class="bpick-empty">名单还没加载出来。<br>请先登录（名单从云端读取），或在设置里稍后再试。</div>';
      return;
    }

    if(p.state === 'setup'){
      var exCount = Object.keys(p.ex || {}).length;
      box.innerHTML = head
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

  function exPanel(){
    var p = BIG.pick;
    var names = (p.roster || []).slice().sort(function (a, b){ return a.localeCompare(b, 'zh-Hans-CN'); });
    return '<div class="bpick-ex">'
      + '<p class="bpick-ex-tip">点名字切换：不参与 / 请假。名单只记在这台电脑上。</p>'
      + '<div class="bpick-ex-list">'
      + names.map(function (n){
          var k = p.ex[n] || '';
          return '<button type="button" class="bpick-ex-item' + (k ? ' ' + k : '') + '"'
            + ' onclick="BIG.pickExOne(\'' + attr0(n) + '\')">' + esc0(n)
            + (k === 'leave' ? '<i>请假</i>' : (k === 'out' ? '<i>不参与</i>' : '')) + '</button>';
        }).join('')
      + '</div></div>';
  }

  BIG.pickExOpen = function (){
    BIG.pick.exList = !BIG.pick.exList;
    BIG.pickBody();
  };

  /* 点一下：正常 → 请假 → 不参与 → 正常 */
  BIG.pickExOne = function (name){
    var ex = BIG.pick.ex || {};
    if(!ex[name]) ex[name] = 'leave';
    else if(ex[name] === 'leave') ex[name] = 'out';
    else delete ex[name];
    BIG.pick.ex = ex;
    saveEx(ex);
    BIG.pickBody();
  };

  /* ---------------- 启动 ---------------- */

  function boot(){
    applyClass();
    buildHome();
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
