/* admin-3.js · 后台脚本第 3/3 段：AI 助手、设置、账户、导入导出与启动接线
   与前面两段共享全局作用域，必须最后加载。 */
'use strict';
/* ============================================================================
 * v3.9.19（站主）：编辑框里不再出现符号
 * ----------------------------------------------------------------------------
 * 站主原话：「不要把那些符号，比如说中括号啊、星号那些展示出来，不然我看着
 *            很别扭，我都不知道哪些能不能删……我这段编辑好，但又想在这句话
 *            里面新加一些字的话，就会觉得很奇怪。能不能根据我输入框选出来的
 *            范围进行修改，或者其它方法，就是我不想看到这些符号」。
 *
 * 做法：输入框换成所见即所得的富文本区（contenteditable）——
 *   · 屏幕上只有真正的字：粗体就是粗的、大字就是大的、横线就是划掉的
 *   · 选中一段 → 点 B / S / 字号，直接改这段（跟 Word 一样），不用记任何符号
 *   · 想在句子中间插字，光标点进去直接打，前后的格式不会乱
 *   · 存进数据库时再翻译成 **粗** / ~~横线~~ / {22b字}，所以前台、旧数据、
 *     以及别处读 text 的地方完全不受影响
 * ========================================================================= */

/* 标记文本 → 纯文字：列表、摘要这些地方不该露出 ** 和 {} */
function aiStrip(text){
  return String(text == null ? '' : text)
    .split('\n')
    .map(function(l){ return l.replace(/^#\s?/, ''); })
    .join('\n')
    .replace(/\{\d{0,2}[bs]{0,2}([^{}]+)\}/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1');
}

/* 标记文本 → 富文本 HTML（编辑器和预览共用同一套解析，永远一致） */
function aiToHtml(text){
  return String(text == null ? '' : text).split('\n').map(function(line){
    var head = false;
    if(/^#\s?/.test(line)){ head = true; line = line.replace(/^#\s?/, ''); }
    var h = esc(line);
    h = h.replace(/\{(\d{0,2})([bs]{0,2})([^{}]+)\}/g, function(all, sz, fl, txt){
      if(!sz && !fl) return all;
      return aiInline(sz, fl, txt);
    });
    h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    h = h.replace(/~~([^~]+)~~/g, '<s>$1</s>');
    if(!h) return head ? '<span class="ln-em"><br></span>' : '';
    return head ? '<span class="ln-em">' + h + '</span>' : h;
  }).join('<br>');
}

/* 富文本 DOM → 标记文本：只看标签结构，不猜样式 */
function aiFromHtml(root){
  if(!root) return '';
  var out = '';
  var nl = function(){ out += '\n'; };

  function wrap(t, ctx){
    if(!t) return '';
    var f = (ctx.b ? 'b' : '') + (ctx.s ? 's' : '');
    if(!ctx.size && !f) return t;
    if(!ctx.size && f === 'b' && t.indexOf('*') < 0) return '**' + t + '**';
    if(!ctx.size && f === 's' && t.indexOf('~') < 0) return '~~' + t + '~~';
    return '{' + (ctx.size || '') + f + t + '}';
  }

  function styleCtx(node, ctx){
    var c = { size: ctx.size, b: ctx.b, s: ctx.s };
    var nm = node.nodeName;
    if(nm === 'B' || nm === 'STRONG') c.b = true;
    if(nm === 'S' || nm === 'STRIKE' || nm === 'DEL') c.s = true;
    var st = node.style;
    if(st){
      if(st.fontSize){ var n = parseInt(st.fontSize, 10); if(n) c.size = n; }
      if(st.fontWeight && parseInt(st.fontWeight, 10) >= 600) c.b = true;
      if((st.textDecoration || st.textDecorationLine || '').indexOf('line-through') >= 0) c.s = true;
    }
    return c;
  }

  function walk(node, ctx){
    for(var n = node.firstChild; n; n = n.nextSibling){
      if(n.nodeType === 3){
        out += wrap(n.nodeValue.replace(/\u00a0/g, ' '), ctx);
        continue;
      }
      if(n.nodeType !== 1) continue;
      var nm = n.nodeName;
      if(nm === 'BR'){ nl(); continue; }
      if(nm === 'DIV' || nm === 'P'){ nl(); walk(n, ctx); nl(); continue; }
      if(nm === 'SPAN' && String(n.className || '').indexOf('ln-em') >= 0){
        nl();
        out += '# ';
        walk(n, styleCtx(n, ctx));
        continue;
      }
      walk(n, styleCtx(n, ctx));
    }
  }

  walk(root, { size: 0, b: false, s: false });
  return out.replace(/^\n+/, '').replace(/\n+$/, '');
}

/* 编辑器 ↔ 隐藏的标记文本框，两边随时同步 */
function aiRtSync(){
  var box = $('adRich'), t = $('adText');
  if(!box || !t) return;
  t.value = aiFromHtml(box);
  aiDayPreview();
  aiRtTip();
}

function aiRtLoad(text){
  var box = $('adRich'), t = $('adText');
  if(!box || !t) return;
  t.value = String(text == null ? '' : text);
  box.innerHTML = aiToHtml(t.value);
  aiDayPreview();
  aiRtTip();
}

var AI_RT_RANGE = null;   /* 点工具栏会让输入框失焦，先记住最后一段选择 */

function aiRtSel(){
  var box = $('adRich');
  if(!box) return null;
  var sel = window.getSelection();
  if(!sel || !sel.rangeCount) return null;
  var r = sel.getRangeAt(0);
  if(!box.contains(r.commonAncestorContainer)) return null;
  return { sel: sel, range: r };
}

function aiRtRestore(){
  if(!AI_RT_RANGE) return false;
  try{
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(AI_RT_RANGE);
    return true;
  }catch(e){ return false; }
}

function aiRtCount(range){
  var t = range.toString().replace(/[\n\r]/g, '');
  return t.length;
}

function aiRtTip(){
  var el = $('adChTip');
  if(!el) return;
  var s = aiRtSel();
  if(!s || s.range.collapsed){
    el.textContent = '选中文字后点击左侧按钮';
    return;
  }
  var n = aiRtCount(s.range);
  el.textContent = '已选 ' + n + ' 个字';
}

function aiRtOk(){
  var box = $('adRich');
  var s = aiRtSel();
  if((!s || s.range.collapsed) && AI_RT_RANGE){ aiRtRestore(); s = aiRtSel(); }
  if(!s || s.range.collapsed){
    toast('先选中要改的文字，再点按钮', 'warn', 2200);
    if(box) box.focus();
    return null;
  }
  return s;
}

/* 把选中的内容包进一个新的行内元素 */
function aiRtWrap(tag, style){
  var s = aiRtOk();
  if(!s) return;
  var node = document.createElement(tag);
  if(style) node.setAttribute('style', style);
  try{
    node.appendChild(s.range.extractContents());
    s.range.insertNode(node);
    var r2 = document.createRange();
    r2.selectNodeContents(node);
    s.sel.removeAllRanges();
    s.sel.addRange(r2);
  }catch(e){}
  aiRtSync();
}

/* 去掉选区内同类的包裹（再点一次即取消） */
function aiRtUnwrapAll(test){
  var box = $('adRich');
  var s = aiRtSel();
  if(!box || !s) return false;
  var list = [];
  var all = box.querySelectorAll('*');
  for(var i = 0; i < all.length; i++){
    var el = all[i];
    if(!test(el)) continue;
    try{ if(s.range.intersectsNode(el)) list.push(el); }catch(e){}
  }
  if(!list.length) return false;
  /* 从里往外拆，避免拆外层时把内层节点带走 */
  for(var k = list.length - 1; k >= 0; k--){
    var n = list[k], p = n.parentNode;
    if(!p) continue;
    while(n.firstChild) p.insertBefore(n.firstChild, n);
    p.removeChild(n);
  }
  return true;
}

function aiRtHas(test){
  var box = $('adRich');
  var s = aiRtSel();
  if(!box || !s) return false;
  var all = box.querySelectorAll('*');
  for(var i = 0; i < all.length; i++){
    var el = all[i];
    if(!test(el)) continue;
    try{ if(s.range.intersectsNode(el)) return true; }catch(e){}
  }
  return false;
}

/* 工具栏总入口：b 粗体 / s 横线 / size 字号 / clear 清格式 / h 整行强调 */
function aiRtFmt(kind, val){
  var box = $('adRich');
  if(!box) return;
  if(kind === 'h'){ aiRtHead(); return; }
  var s = aiRtOk();
  if(!s) return;

  if(kind === 'b'){
    if(aiRtHas(function(el){ return el.nodeName === 'B' || el.nodeName === 'STRONG'; })){
      aiRtUnwrapAll(function(el){ return el.nodeName === 'B' || el.nodeName === 'STRONG'; });
    }else{
      aiRtWrap('b');
    }
  }else if(kind === 's'){
    if(aiRtHas(function(el){ return /^(S|STRIKE|DEL)$/.test(el.nodeName); })){
      aiRtUnwrapAll(function(el){ return /^(S|STRIKE|DEL)$/.test(el.nodeName); });
    }else{
      aiRtWrap('s');
    }
  }else if(kind === 'size'){
    var px = Number(val) || 0;
    if(!px){
      /* 恢复默认：把选区内所有字号去掉，再清掉空壳 */
      var all = box.querySelectorAll('span');
      for(var i = 0; i < all.length; i++){
        var el = all[i];
        try{ if(s.range.intersectsNode(el)) el.style.fontSize = ''; }catch(e){}
      }
      aiRtUnwrapAll(function(el){
        return el.nodeName === 'SPAN' && !String(el.className || '').length
          && !el.getAttribute('style') && !el.firstChild;
      });
    }else{
      aiRtWrap('span', 'font-size:' + px + 'px');
    }
  }else if(kind === 'clear'){
    aiRtUnwrapAll(function(el){
      if(/^(B|STRONG|S|STRIKE|DEL)$/.test(el.nodeName)) return true;
      /* 整行强调是「这一行」的属性，不跟着单字格式一起清掉 */
      return el.nodeName === 'SPAN' && String(el.className || '').indexOf('ln-em') < 0;
    });
    /* 说明：ln-em（整行强调）故意留着，它属于这一行，不算单字格式 */
  }
  aiRtSync();
}

/* 整行强调：光标所在那一行套底色，再点一次取消 */
function aiRtHead(){
  var box = $('adRich');
  if(!box) return;
  var s = aiRtSel();
  if(!s) return;
  /* 文本节点的父节点就是顶层节点；元素则往上找到 box 的直接子节点 */
  var top = s.range.startContainer;
  while(top && top.parentNode !== box) top = top.parentNode;
  if(!top || top.parentNode !== box){ toast('先把光标放到要强调的那一行', 'warn', 2000); return; }

  if(top.nodeName === 'SPAN' && String(top.className || '').indexOf('ln-em') >= 0){
    var p = top.parentNode;
    while(top.firstChild) p.insertBefore(top.firstChild, top);
    p.removeChild(top);
    aiRtSync();
    return;
  }

  var kids = Array.prototype.slice.call(box.childNodes);
  var i = kids.indexOf(top);
  if(i < 0) return;
  var a = i, b = i;
  while(a > 0 && kids[a - 1].nodeName !== 'BR') a--;
  while(b < kids.length - 1 && kids[b + 1].nodeName !== 'BR') b++;
  var span = document.createElement('span');
  span.className = 'ln-em';
  box.insertBefore(span, kids[a]);
  for(var k = a; k <= b; k++) span.appendChild(kids[k]);
  if(!span.textContent.trim()) span.appendChild(document.createElement('br'));
  aiRtSync();
}

/* 编辑器初始化：回车插 <br>、粘贴只留纯文字、输入法不打断 */
function aiRtInit(){
  var box = $('adRich');
  if(!box) return;
  box.addEventListener('keydown', function(e){
    if(e.key === 'Enter' && !e.isComposing){
      e.preventDefault();
      document.execCommand('insertLineBreak');
      aiRtSync();
    }
  });
  box.addEventListener('paste', function(e){
    e.preventDefault();
    var txt = '';
    try{ txt = (e.clipboardData || window.clipboardData).getData('text') || ''; }catch(err){}
    txt = txt.replace(/\r\n?/g, '\n');
    if(txt) document.execCommand('insertText', false, txt);
    aiRtSync();
  });
  box.addEventListener('input', function(e){
    if(e.isComposing) return;
    aiRtSync();
  });
  box.addEventListener('compositionend', function(){ aiRtSync(); });
  box.addEventListener('keyup', aiRtTip);
  box.addEventListener('mouseup', function(){ setTimeout(aiRtTip, 0); });
  box.addEventListener('touchend', function(){ setTimeout(aiRtTip, 0); });
  document.addEventListener('selectionchange', function(){
    var s = aiRtSel();
    if(s && !s.range.collapsed) AI_RT_RANGE = s.range.cloneRange();
    if(document.activeElement === box) aiRtTip();
  });
  /* 点工具栏按钮时请勿输入框的焦点抢走，否则选区没了 */
  var bar = document.querySelector('.ai-charbar');
  if(bar){
    bar.addEventListener('mousedown', function(e){
      if(e.target && e.target.nodeName === 'BUTTON') e.preventDefault();
    });
  }
}

function aiDayPreview(){
  var t = $('adText');
  if(!t) return;
  var bold = $('adBold') && $('adBold').checked;
  var center = $('adCenter') && $('adCenter').checked;
  var size = Number(($('adSize') || {}).value || 0);
  t.style.fontWeight = bold ? '800' : '400';
  t.style.textAlign = center ? 'center' : 'left';
  t.style.fontSize = size ? (size + 'px') : '';
  var pv = $('adPrev');
  if(!pv) return;
  /* v3.9.17：预览不再自己写一套样式，而是复用前台的 .island-banner / .txt 类，
     这样「粗多少、强调长什么样、字号多大」永远和首页一致，不会各写一套跑偏。 */
  var cls = 'txt' + (bold ? ' bold' : ' soft') + (center ? '' : ' left');
  var body = aiPrevFmt(t.value);
  pv.innerHTML = '<div class="island-banner' + (center ? '' : ' left-align') + '">'
    + '<span class="tag">今日事项</span>'
    + '<span class="' + cls + '"' + (size ? ' style="font-size:' + size + 'px"' : '') + '>'
    +   (body || '<span style="opacity:.45">这里是预览</span>')
    + '</span></div>';
}
function aiEditDay(k){
  var v = (AI.days || {})[k];
  if(!v) return;
  AI_DAY_EDIT = k;
  $('adDate').value = k;
  $('adOff').checked = !!v.off;
  $('adBold').checked = !!v.bold;
  $('adCenter').checked = v.center !== false;
  if($('adSize')) $('adSize').value = String(v.size || 0);
  var b = $('adAdd');
  if(b) b.textContent = '更新这一天';
  aiRtLoad(v.text || '');
  paintDayList();
  if($('adRich')) $('adRich').focus();
}
function aiCancelDay(){
  AI_DAY_EDIT = null;
  $('adDate').value = ''; $('adOff').checked = false;
  $('adBold').checked = true; $('adCenter').checked = true;
  if($('adSize')) $('adSize').value = '0';
  var b = $('adAdd');
  if(b) b.textContent = '添加';
  aiRtLoad('');
}

/* 一键填入「当天课表」：默认取所选日期的星期横幅；
   那天已经有临时安排就先填那份，方便只改其中一两个字。 */
function aiFillDay(){
  var d = $('adDate').value || '';
  if(!d){
    var t = new Date();
    d = t.getFullYear() + '-' + ('0' + (t.getMonth() + 1)).slice(-2) + '-' + ('0' + t.getDate()).slice(-2);
    $('adDate').value = d;
  }
  var ex = (AI.days || {})[d];
  var txt = ex && ex.text ? ex.text : '';
  if(!txt){
    var dt = new Date(d + 'T00:00:00');
    if(isNaN(dt.getTime())){ toast('日期不对', 'warn'); return; }
    var key = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][dt.getDay()];
    txt = (AI.banner || {})[key] || '';
  }
  if(!txt){ toast('这一天还没有默认课表，先在上面写一句', 'warn', 2800); return; }
  aiRtLoad(txt);
  if($('adRich')) $('adRich').focus();
  toast('已填入，改其中一两个字再点' + (AI_DAY_EDIT ? '「更新这一天」' : '「添加」'), 'ok', 2600);
}

function aiAddDay(){
  var d = $('adDate').value || '';
  var text = String($('adText').value || '').trim().slice(0, 200);
  var off = !!$('adOff').checked;
  if(!d){ toast('先选日期', 'warn'); return; }
  if(!text && !off){ toast('写点今日事项，或者勾「不上课」', 'warn', 2800); return; }
  AI.days[d] = {
    text: text,
    off: off,
    size: Number(($('adSize') || {}).value || 0),
    label: off ? (text || '今天不上课') : '',
    bold: !!$('adBold').checked,
    center: !!$('adCenter').checked,
  };
  AI_DAY_EDIT = null;
  aiCancelDay();
  paintDayList();
  aiTouch();
  toast('已写入这一天，自动保存中…', 'ok', 2200);
}

/* ---------- 假期（可再次修改时间范围 / 复用） ---------- */
var AI_HOL_EDIT = null;   /* 正在编辑的假期 id */
function paintHols(){
  var host = $('aiHolList');
  var list = (AI.holidays || []).slice().sort(function(a, b){ return a.from < b.from ? -1 : 1; });
  if(!list.length){
    host.innerHTML = '<p class="muted" style="font-size:.8rem;margin:0 0 8px">暂无假期区间。</p>';
    return;
  }
  host.innerHTML = list.map(function(h){
    return '<div class="ai-ovitem ai-ovclick' + (AI_HOL_EDIT === h.id ? ' on' : '') + '" data-holedit="' + attr(h.id) + '">'
      + '<span class="ai-ovtag off">' + esc(h.label || '假期') + '</span>'
      + '<b>' + esc(h.from.slice(5)) + (h.fromTime ? ' ' + esc(h.fromTime) : '')
      + ' – ' + esc(h.to.slice(5)) + (h.toTime ? ' ' + esc(h.toTime) : '') + '</b>'
      + '<span class="muted"></span>'
      + '<button type="button" class="ai-mini" data-hcopy="' + attr(h.id) + '" title="复用：复制到下面表单，改日期再加一条">复用</button>'
      + '<button type="button" data-hdel="' + attr(h.id) + '" title="删除">✕</button>'
      + '</div>';
  }).join('');
  host.onclick = function(e){
    var del = e.target.getAttribute && e.target.getAttribute('data-hdel');
    if(del){
      AI.holidays = AI.holidays.filter(function(x){ return x.id !== del; });
      if(AI_HOL_EDIT === del) aiCancelHol();
      paintHols();
      aiTouch();
      return;
    }
    var cp = e.target.getAttribute && e.target.getAttribute('data-hcopy');
    if(cp){
      var h0 = (AI.holidays || []).filter(function(x){ return x.id === cp; })[0];
      if(!h0) return;
      AI_HOL_EDIT = null;
      $('ahLabel').value = h0.label || '';
      $('ahFrom').value = h0.from;
      $('ahTo').value = h0.to;
      if($('ahFromTime')) $('ahFromTime').value = h0.fromTime || '';
      if($('ahToTime')) $('ahToTime').value = h0.toTime || '';
      var b0 = $('ahAdd');
      if(b0) b0.textContent = '添加';
      paintHols();
      toast('已复制到表单，改好日期再点「添加」', 'ok', 2600);
      return;
    }
    var ed = e.target.closest && e.target.closest('[data-holedit]');
    if(ed) aiEditHol(ed.getAttribute('data-holedit'));
  };
}

function aiEditHol(id){
  var h = (AI.holidays || []).filter(function(x){ return x.id === id; })[0];
  if(!h) return;
  AI_HOL_EDIT = id;
  $('ahLabel').value = h.label || '';
  $('ahFrom').value = h.from;
  $('ahTo').value = h.to;
  if($('ahFromTime')) $('ahFromTime').value = h.fromTime || '';
  if($('ahToTime')) $('ahToTime').value = h.toTime || '';
  var b = $('ahAdd');
  if(b) b.textContent = '更新这一段';
  paintHols();
}
function aiCancelHol(){
  AI_HOL_EDIT = null;
  $('ahLabel').value = ''; $('ahFrom').value = ''; $('ahTo').value = '';
  if($('ahFromTime')) $('ahFromTime').value = '';
  if($('ahToTime')) $('ahToTime').value = '';
  var b = $('ahAdd');
  if(b) b.textContent = '添加';
}

function aiAddHoliday(){
  var label = String($('ahLabel').value || '').trim().slice(0, 16);
  var from = $('ahFrom').value || '';
  var to = $('ahTo').value || from;
  var fromTime = ($('ahFromTime') && $('ahFromTime').value) || '';
  var toTime = ($('ahToTime') && $('ahToTime').value) || '';
  if(!from){ toast('先选开始日期', 'warn'); return; }
  if(to < from){ toast('结束日期不能早于开始日期', 'warn'); return; }
  if(to === from && toTime && fromTime && toTime < fromTime){
    toast('结束时间不能早于开始时间', 'warn'); return;
  }
  if(AI_HOL_EDIT){
    var cur = (AI.holidays || []).filter(function(x){ return x.id === AI_HOL_EDIT; })[0];
    if(cur){ cur.from = from; cur.to = to; cur.label = label || '假期'; cur.fromTime = fromTime; cur.toTime = toTime; }
    toast('已更新，自动保存中…', 'ok', 2200);
  }else{
    AI.holidays.push({ id: 'h' + Date.now().toString(36), from: from, to: to, label: label || '假期', fromTime: fromTime, toTime: toTime });
    toast('已添加，自动保存中…', 'ok', 2200);
  }
  aiCancelHol();
  paintHols();
  aiTouch();
}

/* 照片缩略图预览：能加载才显示，加载失败就藏起来 */
function aiPhotoPreview(){
  var im = $('aiPhotoPrev');
  var ph = $('aiPhoto');
  if(!im || !ph) return;
  var u = String(ph.value || '').trim();
  if(!u){ im.style.display = 'none'; im.removeAttribute('src'); return; }
  im.onload = function(){ im.style.display = ''; };
  im.onerror = function(){ im.style.display = 'none'; };
  im.src = u;
}

/* ============================================================================
 * v3.8.4（站主）：板块管理 + 板块分享链接
 * ----------------------------------------------------------------------------
 * 站主原话：
 *   「首先确保目前现有的板块和以后新增的板块都可以在后台查询到具体的位置并修改
 *     板块名称或简介；其次支持板块分享功能（成绩分析就不用了，灰色显示）。可以生成
 *     包含该板块所有内容的分享链接，且内容也是链接数据库实时刷新的，就相当于一个
 *     快捷方式……还可以一键返回主页。」
 *   「后台生成分享链接时可以设置未登录用户点击后是否需要登录才能继续访问。」
 *
 * 为什么后台能列出板块：板块写在 index.html 的 SITE_DATA 里，后台是另一个页面。
 * 首页每次启动（登录状态下）会把「当前真实结构」上报到 board_meta.catalog，
 * 所以以后加板块不用改这里，只要有人登录打开过一次首页，列表就自动更新。
 * ========================================================================= */
var BM = {
  meta: { cats: {}, cards: {}, catalog: { cats: [] }, noShare: [] },
  shares: [],
  open: {},
  ready: false
};

function renderBoards(){
  $('view').innerHTML =
    '<div class="toolbar" style="background:var(--panel)">'
    +   '<div style="flex:1;min-width:0">'
    +     '<b style="font-size:.92rem">板块管理</b>'
    +     '<p class="muted" style="margin:4px 0 0;font-size:.8rem">'
    +       '改名 / 写简介 / 调顺序 / 隐藏 / 游客可见 —— <b>改完立刻全站生效，不用发版</b>；'
    +       '下面还能为整个板块或单张卡片生成分享链接</p>'
    +   '</div>'
    +   '<button class="btn btn-sm" id="bdNew">＋ 生成分享链接</button>'
    +   '<button class="btn btn-sm btn-secondary" id="bdRe">刷新</button>'
    + '</div>'
    + '<section class="panel" style="margin-bottom:16px">'
    +   '<div class="bd-sec-h">板块与卡片</div>'
    +   '<div id="bdList"><div class="loading"><div class="spinner"></div>加载中…</div></div>'
    + '</section>'
    + '<section class="panel">'
    +   '<div class="bd-sec-h">我建过的板块分享</div>'
    +   '<div id="bdShareList"></div>'
    + '</section>';

  $('bdNew').onclick = function(){ bdShareForm(null); };
  $('bdRe').onclick = function(){ BM.ready = false; loadBoards(true); };
  loadBoards();
}

function loadBoards(force){
  var host = $('bdList');
  if(host && (!BM.ready || force)){
    host.innerHTML = '<div class="loading"><div class="spinner"></div>加载中…</div>';
  }
  return Promise.all([
    api('/boards?action=meta'),
    api('/boards?action=share-list', { method:'POST', body:{} }).catch(function(){ return { shares: [] }; })
  ]).then(function(a){
    BM.meta = a[0] || BM.meta;
    BM.shares = (a[1] && a[1].shares) || [];
    BM.ready = true;
    paintBoards();
    paintBoardShares();
  }).catch(function(e){
    if(host) host.innerHTML = '<div class="alert danger" style="margin:16px">加载失败：' + esc(e.message) + '</div>';
  });
}

/* 板块行：目录（有哪些板块/卡片）+ 云端设置（改过的名字/简介/排序/开关）合并 */
function bdRows(){
  var cat = (BM.meta.catalog && BM.meta.catalog.cats) || [];
  var rows = cat.map(function(c){
    var m = BM.meta.cats[String(c.id)] || {};
    return {
      id: Number(c.id),
      defName: c.name || ('板块 ' + c.id),
      name: m.name || c.name || ('板块 ' + c.id),
      intro: m.intro || '',
      sort: (m.sort === undefined || m.sort === null) ? null : Number(m.sort),
      hidden: !!m.hidden,
      guestOk: m.guestOk !== false,
      cards: c.cards || [],
      noShare: (BM.meta.noShare || []).indexOf(Number(c.id)) >= 0
    };
  });
  rows.sort(function(a, b){
    var sa = a.sort === null ? 1e9 : a.sort;
    var sb = b.sort === null ? 1e9 : b.sort;
    return sa - sb;
  });
  return rows;
}

function paintBoards(){
  var host = $('bdList');
  if(!host) return;
  var rows = bdRows();
  if(!rows.length){
    host.innerHTML = '<div class="alert warn" style="margin:16px">未获取到板块清单。'
      + '请先在手机或电脑上<b>登录并打开一次站点首页</b>，再回来点「刷新」。'
      + '（首页会自动把当前的板块和卡片上报到这里。）</div>';
    return;
  }
  host.innerHTML = rows.map(function(r, i){
    var pos = '首页第 ' + (i + 1) + ' 项 · 侧栏第 ' + (i + 1) + ' 项'
      + (r.hidden ? ' · <b style="color:var(--warn)">已隐藏</b>' : '');
    var cardsHtml = (r.cards || []).map(function(c){
      var m = BM.meta.cards[String(c.id)] || {};
      var nm = m.title || c.title || ('卡片 ' + c.id);
      return '<div class="bd-card-row" data-card="' + attr(c.id) + '">'
        + '<input class="gate-input bd-c-title" data-cf="title" value="' + attr(nm) + '">'
        + '<span class="bd-c-id">#' + esc(c.id) + '</span>'
        + '<label class="bd-check"><input type="checkbox" data-cf="guestOk"'
        +   (m.guestOk === false ? '' : ' checked') + '> 游客可见</label>'
        + '<button class="btn btn-sm btn-secondary" data-cact="share">单独分享</button>'
        + '</div>';
    }).join('') || '<div class="bd-empty">这个板块下面没有卡片</div>';

    return '<div class="bd-block" data-bd="' + r.id + '">'
      + '<div class="bd-top">'
      +   '<span class="bd-order">#' + (i + 1) + '</span>'
      +   '<input class="gate-input bd-name" data-bf="name" value="' + attr(r.name) + '">'
      +   '<span class="bd-pos">' + pos + '</span>'
      +   '<button class="btn btn-sm btn-secondary" data-bact="up" title="上移">↑</button>'
      +   '<button class="btn btn-sm btn-secondary" data-bact="down" title="下移">↓</button>'
      +   '<label class="bd-check"><input type="checkbox" data-bf="hidden"' + (r.hidden ? ' checked' : '') + '> 隐藏</label>'
      +   '<label class="bd-check"><input type="checkbox" data-bf="guestOk"' + (r.guestOk ? ' checked' : '') + '> 游客可见</label>'
      +   (r.noShare
            ? '<span class="bd-nos">成绩分析请用前台分享</span>'
            : '<button class="btn btn-sm" data-bact="share">分享</button>')
      +   '<button class="btn btn-sm btn-secondary" data-bact="cards">卡片 ' + (r.cards || []).length + ' 张</button>'
      + '</div>'
      + '<input class="gate-input bd-intro" data-bf="intro" maxlength="200"'
      +   ' placeholder="板块简介（显示在板块页顶部，可留空）" value="' + attr(r.intro) + '">'
      + '<div class="bd-cards"' + (BM.open[r.id] ? '' : ' hidden') + '>' + cardsHtml + '</div>'
      + '</div>';
  }).join('');

  /* 事件：全部走委托，避免每行绑一堆闭包 */
  host.onclick = function(e){
    var block = e.target.closest ? e.target.closest('[data-bd]') : null;
    if(!block) return;
    var id = Number(block.getAttribute('data-bd'));
    var act = e.target.getAttribute && e.target.getAttribute('data-bact');
    if(act === 'up' || act === 'down'){ bdMove(id, act === 'up' ? -1 : 1); return; }
    if(act === 'cards'){
      BM.open[id] = !BM.open[id];
      var box = block.querySelector('.bd-cards');
      if(box) box.hidden = !BM.open[id];
      return;
    }
    if(act === 'share'){ bdShareForm(null, id); return; }
    var cact = e.target.getAttribute && e.target.getAttribute('data-cact');
    if(cact === 'share'){
      var cr = e.target.closest('[data-card]');
      if(cr) bdShareForm(null, id, cr.getAttribute('data-card'));
    }
  };
  host.onchange = function(e){
    var t = e.target;
    if(!t || !t.getAttribute) return;
    var block = t.closest ? t.closest('[data-bd]') : null;
    if(!block) return;
    if(t.getAttribute('data-bf')){
      var id = Number(block.getAttribute('data-bd'));
      var f = t.getAttribute('data-bf');
      var patch = {};
      patch[f] = (t.type === 'checkbox') ? t.checked : t.value;
      bdSaveCat(id, patch);
    }
  };
  host.onblur = function(e){
    var t = e.target;
    if(!t || !t.getAttribute) return;
    var block = t.closest ? t.closest('[data-bd]') : null;
    if(!block) return;
    var cardRow = t.closest ? t.closest('[data-card]') : null;
    if(cardRow && t.getAttribute('data-cf')){
      var cardId = cardRow.getAttribute('data-card');
      var cf = t.getAttribute('data-cf');
      var p = {}; p[cf] = (t.type === 'checkbox') ? t.checked : t.value;
      bdSaveCard(cardId, p);
      return;
    }
    if(t.getAttribute('data-bf')){
      var id = Number(block.getAttribute('data-bd'));
      var f = t.getAttribute('data-bf');
      var patch = {}; patch[f] = t.value;
      bdSaveCat(id, patch);
    }
  };
  /* 卡片复选框也要即时保存（onchange 不冒泡到上面的分支时兜底） */
  host.addEventListener('change', function(e){
    var t = e.target;
    if(!t || t.type !== 'checkbox' || !t.getAttribute('data-cf')) return;
    var cardRow = t.closest ? t.closest('[data-card]') : null;
    if(!cardRow) return;
    var p = {}; p[t.getAttribute('data-cf')] = t.checked;
    bdSaveCard(cardRow.getAttribute('data-card'), p);
  }, true);
}

function bdSaveCat(id, patch){
  var body = { cats: {} };
  body.cats[String(id)] = patch;
  return api('/boards?action=save-meta', { method:'POST', body: body }).then(function(j){
    BM.meta.cats = j.cats || BM.meta.cats;
    toast('已保存，全站立即生效', 'ok', 1400);
  }).catch(function(e){ toast('保存失败：' + e.message, 'err', 2600); });
}

function bdSaveCard(cardId, patch){
  var body = { cards: {} };
  body.cards[String(cardId)] = patch;
  return api('/boards?action=save-meta', { method:'POST', body: body }).then(function(j){
    BM.meta.cards = j.cards || BM.meta.cards;
    toast('已保存', 'ok', 1200);
  }).catch(function(e){ toast('保存失败：' + e.message, 'err', 2600); });
}

/* 上下移动：交换后按 0,10,20… 重排一遍，避免历史 sort 值撞车 */
function bdMove(id, dir){
  var rows = bdRows();
  var i = -1;
  for(var k = 0; k < rows.length; k++){ if(rows[k].id === Number(id)){ i = k; break; } }
  if(i < 0) return;
  var j = i + dir;
  if(j < 0 || j >= rows.length) return;
  var arr = rows.slice();
  var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  var body = { cats: {} };
  arr.forEach(function(r, idx){ body.cats[String(r.id)] = { sort: idx * 10 }; });
  api('/boards?action=save-meta', { method:'POST', body: body }).then(function(){
    loadBoards(true);
  }).catch(function(e){ toast('排序失败：' + e.message, 'err'); });
}

/* ---------- 分享表单（新建 / 编辑共用） ---------- */
function bdShareForm(share, boardId, cardRef){
  var isEdit = !!share;
  var rows = bdRows().filter(function(r){ return !r.noShare; });
  if(!rows.length){
    toast('还没有板块清单，先去首页登录打开一次', 'warn', 3000);
    return;
  }
  var selId = isEdit ? Number(share.boardId) : Number(boardId || rows[0].id);
  var selCard = isEdit ? String(share.card || '') : String(cardRef || '');

  var opts = rows.map(function(r){
    return '<option value="' + r.id + '"' + (r.id === selId ? ' selected' : '') + '>'
      + esc(r.name) + '</option>';
  }).join('');

  openModal({
    title: isEdit ? '编辑分享链接' : '生成板块分享链接',
    sub: '链接只指向位置，内容每次打开都从数据库现取，改完内容不用重发链接',
    wide: true,
    body:
      '<div class="bd-form">'
      + '<div class="field"><label>板块</label><select class="gate-input" id="bsBoard">' + opts + '</select></div>'
      + '<div class="field"><label>范围</label><select class="gate-input" id="bsCard"></select></div>'
      + '<label class="bd-check bd-check-lg"><input type="checkbox" id="bsGuest">'
      +   ' 未登录也能打开（游客只能看这一个板块，其它入口点了会提示登录）</label>'
      + '<div class="bd-grid2">'
      +   '<div class="field"><label>有效期</label><select class="gate-input" id="bsDays">'
      +     '<option value="0">永久</option><option value="7">7 天</option>'
      +     '<option value="30">30 天</option><option value="90">90 天</option>'
      +     '<option value="custom">自定义…</option></select></div>'
      +   '<div class="field"><label>最多查看次数（留空 = 不限）</label>'
      +     '<input class="gate-input" id="bsMax" type="number" min="0" placeholder="不限"></div>'
      + '</div>'
      + '<div class="field" id="bsDaysWrap" hidden><label>自定义天数</label>'
      +   '<input class="gate-input" id="bsDaysNum" type="number" min="1" max="3650" value="180"></div>'
      + '<div class="field"><label>备注（自己认得出即可，最多 40 字）</label>'
      +   '<input class="gate-input" id="bsNote" maxlength="40" placeholder="例：班级事务 · 给家长"></div>'
      + '<div id="bsOut"></div>'
      + '</div>',
    foot: '<button class="btn btn-secondary" id="bsCancel">取消</button>'
        + '<button class="btn" id="bsGo">' + (isEdit ? '保存修改' : '生成链接') + '</button>',
    onMount: function(box){
      var boardSel = $('bsBoard'), cardSel = $('bsCard');
      function fillCards(){
        var r = null;
        for(var i = 0; i < rows.length; i++){ if(rows[i].id === Number(boardSel.value)){ r = rows[i]; break; } }
        var cards = (r && r.cards) || [];
        cardSel.innerHTML = '<option value="">整个板块</option>' + cards.map(function(c){
          var m = BM.meta.cards[String(c.id)] || {};
          var nm = m.title || c.title || ('卡片 ' + c.id);
          return '<option value="' + attr(c.id) + '">' + esc(nm) + '</option>';
        }).join('');
        cardSel.value = selCard || '';
      }
      boardSel.onchange = fillCards;
      fillCards();
      /* 编辑已有链接时不允许改板块：token 指向哪儿是固定的，换板块等于换一条链接 */
      if(isEdit) boardSel.disabled = true;

      if(isEdit){
        $('bsGuest').checked = !!share.guestOk;
        $('bsNote').value = share.note || '';
        $('bsMax').value = share.maxViews || '';
        if(share.days === 7 || share.days === 30 || share.days === 90){
          $('bsDays').value = String(share.days);
        }else if(share.days > 0){
          $('bsDays').value = 'custom';
          $('bsDaysWrap').hidden = false;
          $('bsDaysNum').value = share.days;
        }
      }
      $('bsDays').onchange = function(){
        $('bsDaysWrap').hidden = this.value !== 'custom';
      };
      $('bsCancel').onclick = closeModal;
      $('bsGo').onclick = function(){ bdShareSave(isEdit ? share : null); };
    }
  });
}

function bdShareSave(share){
  var boardId = Number($('bsBoard').value);
  var card = $('bsCard').value || '';
  var guestOk = $('bsGuest').checked;
  var dv = $('bsDays').value;
  var days = dv === 'custom' ? Math.max(1, Number($('bsDaysNum').value || 1)) : Number(dv || 0);
  var maxViews = Number($('bsMax').value || 0);
  var note = String($('bsNote').value || '').trim();
  var btn = $('bsGo');
  if(btn){ btn.disabled = true; btn.textContent = '处理中…'; }

  var body = { boardId: boardId, card: card, guestOk: guestOk, days: days, maxViews: maxViews, note: note };
  var p = share
    ? api('/boards?action=share-update', { method:'POST', body: Object.assign({ id: share.id }, body) })
    : api('/boards?action=share-create', { method:'POST', body: body });

  p.then(function(j){
    if(btn){ btn.disabled = false; btn.textContent = share ? '保存修改' : '生成链接'; }
    toast(share ? '已保存' : '链接已生成', 'ok');
    if(!share){
      /* ⚠️ 站点可能部署在子路径（GitHub Pages 的 /class-site/），
         后端返回的是 /index.html?b=…，直接拼 origin 会丢掉子目录 → 404。
         和成绩分享同一套写法：去掉前导斜杠后按当前页面地址解析。 */
      var url = new URL(String(j.url || '').replace(/^\/+/, ''), location.href).href;
      bdShowResult(url, j, boardId, card);
    }
    loadBoards(true);
  }).catch(function(e){
    if(btn){ btn.disabled = false; btn.textContent = share ? '保存修改' : '生成链接'; }
    toast(e.message || '操作失败', 'err', 3600);
  });
}

/* 生成成功后的结果区：链接 + 复制 + 预览 + 二维码 + 分享图 */
function bdShowResult(url, j, boardId, card){
  var out = $('bsOut');
  if(!out) return;
  out.innerHTML =
    '<div class="bd-result">'
    + '<div class="bd-ok">✅ 链接已生成，发给同学即可</div>'
    + '<div class="bd-url"><input class="gate-input" id="bsUrl" readonly value="' + attr(url) + '">'
    +   '<button class="btn btn-sm" id="bsCopy">复制</button></div>'
    + '<div class="bd-result-act">'
    +   '<button class="btn btn-sm btn-secondary" id="bsPreview">预览</button>'
    +   '<button class="btn btn-sm btn-secondary" id="bsQr">二维码</button>'
    +   '<button class="btn btn-sm btn-secondary" id="bsPic">分享图</button>'
    + '</div>'
    + '<p class="muted" style="font-size:.74rem;margin:8px 0 0">'
    +   (j.guestOk ? '未登录也能打开；游客只能看这一个板块。' : '需要登录才能打开；登录后自动跳到这个板块。')
    + '</p></div>';

  $('bsCopy').onclick = function(){
    var inp = $('bsUrl'); inp.select();
    try{
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(url).then(function(){ toast('已复制', 'ok', 1200); });
      }else{ document.execCommand('copy'); toast('已复制', 'ok', 1200); }
    }catch(e){ document.execCommand('copy'); toast('已复制', 'ok', 1200); }
  };
  $('bsPreview').onclick = function(){ window.open(url + '&preview=1', '_blank', 'noopener'); };
  $('bsQr').onclick = function(){ bdShowQr(url, j.name || ''); };
  $('bsPic').onclick = function(){ bdSharePic(url, j.name || '', j.intro || '', j.note || ''); };
}

/* ---------- 二维码 ---------- */
function bdQrCanvas(text, px){
  var q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  var n = q.getModuleCount();
  var cell = Math.max(2, Math.floor(px / n));
  var size = cell * n;
  var cv = document.createElement('canvas');
  cv.width = cv.height = size;
  var ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#141210';
  for(var r = 0; r < n; r++){
    for(var c = 0; c < n; c++){
      if(q.isDark(r, c)) ctx.fillRect(c * cell, r * cell, cell, cell);
    }
  }
  return cv;
}

/* v3.8.7（站主）：「导出二维码图片的时候也全部都要加上班徽」。
   ⚠️ 班徽不能压在二维码上 —— 二维码三个角是定位图案，盖住就扫不出来。
   所以做成「二维码 + 下方一条班徽署名」，白底、纯色，识别率不受影响。 */
function bdQrPoster(url, name, cb){
  var qs = 560, pad = 36, foot = 132;
  var W = qs + pad * 2, H = qs + pad * 2 + foot;
  var out = document.createElement('canvas');
  out.width = W; out.height = H;
  var ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  try { ctx.drawImage(bdQrCanvas(url, qs), pad, pad, qs, qs); } catch (e) {}

  ctx.strokeStyle = '#e6ded6';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, pad + qs + 26);
  ctx.lineTo(W - pad, pad + qs + 26);
  ctx.stroke();

  var badgeSize = 68;
  var bx = pad, by = pad + qs + 44;
  function finish(){
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#2b211a';
    ctx.font = '700 26px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillText('25级05班 班级服务站', bx + badgeSize + 18, by + 8);
    ctx.fillStyle = '#8a6a55';
    ctx.font = '400 20px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    var t = String(name || '扫码打开');
    if (t.length > 22) t = t.slice(0, 21) + '…';
    ctx.fillText(t, bx + badgeSize + 18, by + 42);
    cb(out);
  }

  try {
    var src = (typeof adminBadgeUrl === 'function') ? adminBadgeUrl() : '';
    if (!src) return finish();
    var im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = function(){
      try {
        ctx.save();
        ctx.beginPath();
        ctx.arc(bx + badgeSize / 2, by + badgeSize / 2, badgeSize / 2, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(im, bx, by, badgeSize, badgeSize);
        ctx.restore();
      } catch (e) {}
      finish();
    };
    im.onerror = function(){ finish(); };
    im.src = src;
    setTimeout(function(){ if (!out.__done) { out.__done = 1; finish(); } }, 3000);
  } catch (e) { finish(); }
}

function bdShowQr(url, name){
  /* 先给个纯二维码占位，班徽加载完再替换成「二维码 + 署名」整图 */
  var cv = bdQrCanvas(url, 560);
  var data = cv.toDataURL('image/png');
  openModal({
    title: '扫码打开',
    sub: name || '',
    body: '<div style="text-align:center">'
      + '<img id="bdQrImg" src="' + data + '" alt="二维码" style="width:min(78vw,340px);height:auto;border-radius:12px;border:1px solid var(--border)">'
      + '<p class="muted" style="font-size:.76rem;margin:10px 0 0;word-break:break-all">' + esc(url) + '</p>'
      + '</div>',
    foot: '<button class="btn" id="bdQrDown">保存二维码</button>',
    onMount: function(){
      function bindSave(d){
        $('bdQrDown').onclick = function(){
          var a = document.createElement('a');
          a.href = d; a.download = '板块分享二维码.png';
          document.body.appendChild(a); a.click(); a.remove();
        };
      }
      bindSave(data);
      bdQrPoster(url, name, function(poster){
        var d = poster.toDataURL('image/png');
        var img = document.getElementById('bdQrImg');
        if(img) img.src = d;
        bindSave(d);
      });
    }
  });
}

/* ---------- 分享图（含班徽 + 二维码） ---------- */
function bdSharePic(url, name, intro, note){
  var W = 720, H = 980;
  var cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  var ctx = cv.getContext('2d');

  /* 背景：暖白渐变，和站点同一个调子 */
  var g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#fffaf5');
  g.addColorStop(1, '#f6e9dc');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#c2410c';
  ctx.fillRect(0, 0, W, 10);

  ctx.fillStyle = '#8a6a55';
  ctx.font = '600 22px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText('25级05班班级服务站', 48, 78);

  /* 板块名，自动缩放避免溢出 */
  var title = name || '班级板块';
  var size = 56;
  ctx.fillStyle = '#2b211a';
  do{
    ctx.font = '800 ' + size + 'px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    if(ctx.measureText(title).width <= W - 96) break;
    size -= 4;
  }while(size > 26);
  ctx.fillText(title, 48, 178);

  /* 简介：按宽度折行，最多 5 行 */
  ctx.fillStyle = '#57493d';
  ctx.font = '400 24px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  var lines = bdWrap(ctx, intro || '打开链接可查看该板块全部内容', W - 96);
  lines = lines.slice(0, 5);
  for(var i = 0; i < lines.length; i++){
    ctx.fillText(lines[i], 48, 228 + i * 38);
  }

  /* 二维码卡片 */
  var qrCv = bdQrCanvas(url, 420);
  var qrSize = 360;
  var qx = (W - qrSize) / 2;
  var qy = 430;
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(120,60,20,.16)';
  ctx.shadowBlur = 26; ctx.shadowOffsetY = 10;
  bdRound(ctx, qx - 26, qy - 26, qrSize + 52, qrSize + 52, 22);
  ctx.fill();
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  ctx.drawImage(qrCv, qx, qy, qrSize, qrSize);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#8a6a55';
  ctx.font = '600 22px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText('扫码直接打开', W / 2, qy + qrSize + 76);

  if(note){
    ctx.fillStyle = '#2b211a';
    ctx.font = '700 24px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('「' + note + '」', W / 2, qy + qrSize + 118);
  }

  ctx.fillStyle = '#a08a78';
  ctx.font = '400 19px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText('内容实时更新 · 链接长期有效', W / 2, H - 54);
  ctx.textAlign = 'left';

  /* 右上角班徽（拿不到就跳过，不影响出图） */
  try{
    var src = (typeof adminBadgeUrl === 'function') ? adminBadgeUrl() : '';
    if(src){
      var im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = function(){
        try{
          var s = 96, pad = 42;
          ctx.save();
          ctx.beginPath();
          ctx.arc(W - pad - s / 2, 46 + s / 2, s / 2, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(im, W - pad - s, 46, s, s);
          ctx.restore();
        }catch(e){}
        bdSavePic(cv, title);
      };
      im.onerror = function(){ bdSavePic(cv, title); };
      im.src = src;
      return;
    }
  }catch(e){}
  bdSavePic(cv, title);
}

function bdWrap(ctx, text, maxW){
  var out = [], line = '';
  var chars = String(text || '').split('');
  for(var i = 0; i < chars.length; i++){
    var ch = chars[i];
    if(ch === '\n'){ out.push(line); line = ''; continue; }
    if(ctx.measureText(line + ch).width > maxW){ out.push(line); line = ch; }
    else line += ch;
  }
  out.push(line);
  return out;
}

function bdRound(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function bdSavePic(cv, name){
  cv.toBlob(function(blob){
    if(!blob){ toast('生成图片失败', 'err'); return; }
    var file = null;
    try{ file = new File([blob], '分享-' + (name || '板块') + '.png', { type:'image/png' }); }catch(e){}
    if(file && navigator.canShare && navigator.canShare({ files:[file] }) && navigator.share){
      navigator.share({ files:[file], title:'板块分享' }).catch(function(){});
      return;
    }
    var u = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = u; a.download = '分享-' + (name || '板块') + '.png';
    document.body.appendChild(a); a.click();
    setTimeout(function(){ a.remove(); URL.revokeObjectURL(u); }, 1200);
    toast('分享图已保存', 'ok', 1600);
  }, 'image/png');
}

/* ---------- 分享列表 ---------- */
var BD_STATUS = {
  alive:   { t: '有效',    c: 'ok' },
  revoked: { t: '已撤销',  c: 'off' },
  expired: { t: '已过期',  c: 'off' },
  usedUp:  { t: '次数用完', c: 'off' }
};

function paintBoardShares(){
  var host = $('bdShareList');
  if(!host) return;
  if(!BM.shares.length){
    host.innerHTML = '<div class="bd-empty" style="padding:18px">暂无板块分享链接。点击右上角「生成分享链接」创建。</div>';
    return;
  }
  host.innerHTML = BM.shares.map(function(x){
    var st = BD_STATUS[x.status] || BD_STATUS.alive;
    var title = x.note || x.name || ('板块 ' + x.boardId);
    var target = x.name + (x.card ? ' · ' + (x.cardTitle || ('卡片 ' + x.card)) : ' · 整个板块');
    var last = x.lastViewAt ? String(x.lastViewAt).replace('T', ' ').slice(0, 16) : '还没人打开';
    return '<div class="bd-share" data-id="' + x.id + '">'
      + '<div class="bd-share-main">'
      +   '<b>' + esc(title) + '</b>'
      +   '<span class="bd-tag ' + st.c + '">' + st.t + '</span>'
      +   '<span class="bd-tag ' + (x.guestOk ? 'guest' : 'login') + '">'
      +     (x.guestOk ? '免登录' : '需登录') + '</span>'
      + '</div>'
      + '<div class="bd-share-meta">' + esc(target)
      +   ' · 看过 ' + x.views + (x.maxViews ? ' / ' + x.maxViews : '') + ' 次'
      +   ' · 最近：' + esc(last) + '</div>'
      + '<div class="bd-share-act">'
      +   '<button class="btn btn-sm btn-secondary" data-sact="view">预览</button>'
      +   '<button class="btn btn-sm btn-secondary" data-sact="edit">编辑</button>'
      +   '<button class="btn btn-sm btn-secondary" data-sact="qr">二维码</button>'
      +   '<button class="btn btn-sm btn-secondary" data-sact="pic">分享图</button>'
      +   '<button class="btn btn-sm btn-secondary" data-sact="stat">访问明细</button>'
      +   (x.status === 'alive'
            ? '<button class="btn btn-sm btn-danger" data-sact="rev">撤销</button>'
            : '')
      + '</div></div>';
  }).join('');

  host.onclick = function(e){
    var act = e.target.getAttribute && e.target.getAttribute('data-sact');
    if(!act) return;
    var row = e.target.closest('[data-id]');
    if(!row) return;
    var id = Number(row.getAttribute('data-id'));
    var x = null;
    for(var i = 0; i < BM.shares.length; i++){ if(BM.shares[i].id === id){ x = BM.shares[i]; break; } }
    if(!x) return;
    var url = new URL('index.html?b=' + x.boardId
      + (x.card ? '&c=' + encodeURIComponent(x.card) : '') + '&t=' + x.token,
      location.href).href;

    if(act === 'view'){ window.open(url + '&preview=1', '_blank', 'noopener'); return; }
    if(act === 'qr'){ bdShowQr(url, x.name); return; }
    if(act === 'pic'){ bdSharePic(url, x.name, x.intro || '', x.note || ''); return; }
    if(act === 'edit'){ bdShareForm(x); return; }
    if(act === 'stat'){ bdShowStats(x); return; }
    if(act === 'rev'){
      confirmBox({ text: '撤销后这个链接立刻失效，确定吗？', warn: '同学再打开会看到「链接已被撤销」。' })
        .then(function(ok){
          if(!ok) return;
          api('/boards?action=share-revoke', { method:'POST', body:{ id: id } })
            .then(function(){ toast('已撤销', 'ok'); loadBoards(true); })
            .catch(function(e){ toast(e.message, 'err'); });
        });
    }
  };
}

function bdShowStats(x){
  api('/boards?action=share-stats', { method:'POST', body:{ id: x.id } }).then(function(j){
    var list = (j && j.views) || [];
    var body = list.length
      ? '<div class="bd-stats">' + list.map(function(v){
          return '<div class="bd-stat-row">'
            + '<b>' + esc(v.name || (v.userId ? '同学' : '未登录访客')) + '</b>'
            + '<span class="muted">' + esc(String(v.at || '').replace('T', ' ').slice(0, 16)) + '</span>'
            + '<span class="bd-stat-ip">' + esc(v.ip || '') + '</span>'
            + '</div>';
        }).join('') + '</div>'
      : '<div class="bd-empty" style="padding:16px">还没有访问记录</div>';
    openModal({
      title: '访问明细',
      sub: (x.note || x.name) + ' · 共 ' + x.views + ' 次',
      body: body + '<p class="muted" style="font-size:.74rem;margin-top:10px">'
        + '登录用户记名；未登录访客只记录时间和 IP（用于排查异常访问）。</p>',
      wide: true
    });
  }).catch(function(e){ toast(e.message, 'err'); });
}

function renderBackup(){
  $('view').innerHTML =
    '<div class="toolbar" style="background:var(--panel)">'
    +   '<div style="flex:1;min-width:0"><b style="font-size:.92rem">数据管理</b>'
    +     '<p class="muted" style="margin:4px 0 0;font-size:.8rem">'
    +       '每次部署前会自动备份一次；这里也可以手动备份、随时回档</p></div>'
    +   '<button class="btn btn-sm btn-secondary" id="bkRefresh">' + svg('refresh',14) + ' 刷新</button>'
    +   '<button class="btn btn-sm" id="bkNow">' + svg('database',14) + ' 立即备份</button>'
    + '</div>'
    + '<section class="panel" style="margin-bottom:14px">'
    +   '<div class="panel-head" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">'
    +     '<h3 style="margin:0;font-size:.95rem">备份概览</h3><span style="flex:1"></span>'
    +     '<span class="muted" style="font-size:.76rem" id="bkMeta">加载中…</span>'
    +   '</div>'
    +   '<div class="panel-body" id="bkOverview"><div class="loading"><div class="spinner"></div>加载中…</div></div>'
    + '</section>'
    + '<section class="panel"><div id="bkBody"><div class="loading"><div class="spinner"></div>加载中…</div></div></section>'
    /* v3.6.4：版本记录并入同一页 */
    + releasesBlockHtml();

  $('bkRefresh').onclick = loadBackups;
  $('bkNow').onclick = function(){ doBackupNow(); };
  loadBackups();
  mountReleasesBlock();
}

function fmtBytes(n){
  n = Number(n) || 0;
  if(n < 1024) return n + ' B';
  if(n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function loadBackups(){
  var body = $('bkBody');
  if(body) body.innerHTML = '<div class="loading"><div class="spinner"></div>加载中…</div>';
  api('/admin?action=backups').then(function(j){
    BK_STATE.list = j.backups || [];
    BK_STATE.count = j.count || 0;
    BK_STATE.totalBytes = j.totalBytes || 0;
    BK_STATE.keep = j.keepVersions || 14;
    paintBackups();
  }).catch(function(e){
    if(body) body.innerHTML = '<div class="alert danger" style="margin:16px">读取失败：' + esc(e.message) + '</div>';
  });
}

function paintBackups(){
  var meta = $('bkMeta');
  if(meta){
    meta.textContent = '共 ' + BK_STATE.count + ' 份 · 占用 ' + fmtBytes(BK_STATE.totalBytes)
      + ' · 按版本保留最近 ' + BK_STATE.keep + ' 个';
  }
  var ov = $('bkOverview');
  if(ov){
    var latest = BK_STATE.list[0];
    ov.innerHTML = '<div style="display:flex;gap:14px;flex-wrap:wrap">'
      + '<div class="panel" style="flex:1;min-width:150px;margin:0;padding:12px 14px">'
      +   '<div class="muted" style="font-size:.74rem">最近一次备份</div>'
      +   '<div style="font-size:1rem;font-weight:700;margin:4px 0 2px">'
      +     (latest ? esc(latest.version) : '还没有') + '</div>'
      +   '<div class="muted" style="font-size:.72rem">'
      +     (latest ? esc(fmt(latest.createdAt)) : '部署前会自动生成') + '</div></div>'
      + '<div class="panel" style="flex:1;min-width:150px;margin:0;padding:12px 14px">'
      +   '<div class="muted" style="font-size:.74rem">备份</div>'
      +   '<div style="font-size:1rem;font-weight:700;margin:4px 0 2px">' + BK_STATE.count + ' 份</div>'
      +   '<div class="muted" style="font-size:.72rem">' + fmtBytes(BK_STATE.totalBytes) + '</div></div>'
      + '<div class="panel" style="flex:1;min-width:150px;margin:0;padding:12px 14px">'
      +   '<div class="muted" style="font-size:.74rem">回档范围</div>'
      +   '<div style="font-size:.86rem;font-weight:700;margin:4px 0 2px">内容 / 档案 / 字段 / 设置</div>'
      +   '<div class="muted" style="font-size:.72rem">账号密码不覆盖</div></div>'
      + '</div>';
  }

  var body = $('bkBody');
  if(!body) return;
  if(!BK_STATE.list.length){
    body.innerHTML = '<div class="empty">' + svg('database', 38)
      + '<p>还没有备份</p><p style="font-size:.78rem;margin-top:8px">点右上角「立即备份」，或下次部署时会自动生成</p></div>';
    return;
  }
  body.innerHTML = '<div class="table-wrap"><table><thead><tr>'
    + '<th>版本</th><th>类型</th><th class="nowrap">时间</th><th class="nowrap">大小</th><th></th>'
    + '</tr></thead><tbody>'
    + BK_STATE.list.map(function(b){
        var kindTxt = b.kind === 'predeploy' ? '部署前' : (b.kind === 'auto' ? '自动' : '手动');
        var kindCls = b.kind === 'predeploy' ? 'badge-blue' : (b.kind === 'manual' ? 'badge-green' : 'badge-gray');
        return '<tr>'
          + '<td><b>' + esc(b.version) + '</b>' + (b.note ? '<div class="muted" style="font-size:.72rem">' + esc(b.note) + '</div>' : '') + '</td>'
          + '<td class="nowrap"><span class="badge ' + kindCls + '">' + kindTxt + '</span></td>'
          + '<td class="nowrap muted" style="font-size:.78rem">' + esc(fmt(b.createdAt)) + '</td>'
          + '<td class="nowrap mono" style="font-size:.76rem">' + fmtBytes(b.bytes) + '</td>'
          + '<td class="nowrap" style="text-align:right"><div class="row-actions">'
          +   '<button data-bk-detail="' + b.id + '">明细</button>'
          +   '<button data-bk-restore="' + b.id + '" data-bk-ver="' + attr(b.version) + '">回档</button>'
          +   '<button class="danger" data-bk-del="' + b.id + '" data-bk-ver="' + attr(b.version) + '">删除</button>'
          + '</div></td></tr>';
      }).join('')
    + '</tbody></table></div>';

  Array.prototype.forEach.call(body.querySelectorAll('[data-bk-detail]'), function(btn){
    btn.onclick = function(){ showBackupDetail(Number(btn.dataset.bkDetail)); };
  });
  Array.prototype.forEach.call(body.querySelectorAll('[data-bk-restore]'), function(btn){
    btn.onclick = function(){ restoreBackupDialog(Number(btn.dataset.bkRestore), btn.dataset.bkVer); };
  });
  Array.prototype.forEach.call(body.querySelectorAll('[data-bk-del]'), function(btn){
    btn.onclick = function(){
      var id = Number(btn.dataset.bkDel);
      if(!confirm('删除「' + btn.dataset.bkVer + '」这份备份？删除后不可恢复。')) return;
      api('/admin?action=delete-backup', { method:'POST', body:{ id: id } })
        .then(function(){ toast('已删除', 'ok'); loadBackups(); })
        .catch(function(e){ toast(e.message, 'danger'); });
    };
  });
}

function doBackupNow(){
  var btn = $('bkNow');
  if(btn){ btn.disabled = true; btn.textContent = '备份中…'; }
  api('/admin?action=backup', {
    method:'POST',
    body:{ version: SITE_VERSION, kind:'manual', note:'后台手动备份' },
  }).then(function(j){
    toast(j.message || '已备份', 'ok');
    if(btn){ btn.disabled = false; btn.innerHTML = svg('database',14) + ' 立即备份'; }
    loadBackups();
  }).catch(function(e){
    toast('备份失败：' + (e.message || e), 'danger');
    if(btn){ btn.disabled = false; btn.innerHTML = svg('database',14) + ' 立即备份'; }
  });
}

function showBackupDetail(id){
  api('/admin?action=backup&id=' + id).then(function(j){
    var b = j.backup || {};
    var rows = Object.keys(b.counts || {}).map(function(k){
      return '<tr><td>' + esc(k) + '</td><td class="mono">' + b.counts[k] + '</td></tr>';
    }).join('');
    openModal({
      title: '备份明细', sub: b.version + ' · ' + fmt(b.createdAt),
      body: '<div class="table-wrap"><table><thead><tr><th>表</th><th>行数</th></tr></thead><tbody>'
        + rows + '</tbody></table></div>'
        + '<p class="hint">回档只覆盖「内容 / 档案 / 字段定义 / 站点设置」四类；'
        + '账号密码、登录日志不会被动。</p>',
      foot: '<button class="btn btn-secondary" id="bkdClose">关闭</button>',
      onMount: function(box){ box.querySelector('#bkdClose').onclick = closeModal; },
    });
  }).catch(function(e){ toast(e.message, 'danger'); });
}

function restoreBackupDialog(id, ver){
  openModal({
    title: '从备份回档', sub: '备份版本 ' + ver,
    body: '<div class="alert warn" style="margin-bottom:12px">'
      + '回档会用这份备份**覆盖**当前数据，且不能撤销。建议先点「立即备份」把现在的状态存一份。</div>'
      + '<div class="field"><label>要恢复哪些</label>'
      +   '<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" class="bkPart" value="content" checked> '
      +     '<span>作业 / 公告 / 弹窗 / 排期等内容</span></label>'
      +   '<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" class="bkPart" value="profiles" checked> '
      +     '<span>班级档案（姓名、身份证、入团时间等）</span></label>'
      +   '<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" class="bkPart" value="field_meta" checked> '
      +     '<span>字段管理里的字段定义</span></label>'
      +   '<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" class="bkPart" value="settings"> '
      +     '<span>站点设置（站点名、注册开关等）</span></label>'
      + '</div>'
      + '<p class="hint">账号与密码不在回档范围内，以免密码回退导致无法登录。</p>',
    foot: '<button class="btn btn-secondary" id="bkRCancel">取消</button>'
        + '<button class="btn" id="bkRGo" style="background:#b3261e">确认回档</button>',
    onMount: function(box){
      box.querySelector('#bkRCancel').onclick = closeModal;
      box.querySelector('#bkRGo').onclick = function(){
        var parts = [];
        Array.prototype.forEach.call(box.querySelectorAll('.bkPart'), function(cb){
          if(cb.checked) parts.push(cb.value);
        });
        if(!parts.length){ toast('至少选一项', 'err'); return; }
        var go = box.querySelector('#bkRGo');
        go.disabled = true; go.textContent = '回档中…';
        api('/admin?action=restore-backup', { method:'POST', body:{ id: id, parts: parts } })
          .then(function(j){
            closeModal();
            toast(j.message || '已回档', 'ok');
            loadBackups();
          })
          .catch(function(e){
            go.disabled = false; go.textContent = '确认回档';
            toast('回档失败：' + (e.message || e), 'danger');
          });
      };
    },
  });
}

function renderVotes(){
  $('view').innerHTML =
    '<div class="toolbar" style="background:var(--panel)">'
    +   '<div style="flex:1;min-width:0"><b style="font-size:.92rem">投票管理</b>'
    +     '<p class="muted" style="margin:4px 0 0;font-size:.8rem">同学在「班级事务 → 投票」里参与，一人一票，截止后公布结果</p></div>'
    +   '<button class="btn btn-sm btn-secondary" id="voPubTpl">' + svg('edit',14) + ' 公示模版</button>'
    +   '<button class="btn btn-sm btn-secondary" id="voRefresh">' + svg('refresh',14) + ' 刷新</button>'
    +   '<button class="btn btn-sm" id="voNew">' + svg('plus',14) + ' 新建投票</button>'
    + '</div>'
    + '<div id="voList"><div class="loading"><div class="spinner"></div>加载中…</div></div>';

  $('voRefresh').onclick = function(){ voLoad(); };
  $('voNew').onclick = function(){ voEditorDialog(null); };
  $('voPubTpl').onclick = function(){ voTemplatesDialog(); };
  voPubLoad();
  voLoad();
}

/* v3.5.15 热修：`VO` 的声明在之前某次清理里被误删了，但下面的
   voPubLoad / voPaint / voPubDialog 全都在用 —— 后台一进投票页就
   「读取失败：VO is not defined」。这里补回来。 */
var VO = { list: [], busy: false, pub: null };

/* ===== v3.5.13 投票公示（站主 #2）=====
   内容键 vote_pub = { templates:[{id,name,template}], byVote:{ [voteId]:{tplId,on} } }。
   前台在投票卡下方按模版渲染公示（变量替换见 index.html votePubRender）。 */
/* v3.5.23：变量补到前十名 + 歌曲总时长（模板里想写第几名都能插） */
var VO_PUB_VARS = ['标题','提出人','提出日期','截止时间','参与人数','总票数',
  '第一名','第二名','第三名','第四名','第五名','第六名','第七名','第八名','第九名','第十名',
  '歌曲总时长','结果表'];
var VO_PUB_DEFAULT_TPL = {
  id: 'default', name: '默认公示模版',
  template: '📋 {{标题}} 投票结果公示\n'
    + '提出人：{{提出人}}（{{提出日期}} 提出）\n'
    + '共 {{参与人数}} 人参与投票。\n'
    + '{{结果表}}\n'
    + '第一名：{{第一名}}\n'
    + '感谢大家的参与！',
};
function voPubLoad(){
  return api('/content?keys=vote_pub').then(function(j){
    var v = j && j.items && j.items.vote_pub;
    VO.pub = (v && typeof v === 'object' && !Array.isArray(v)) ? v : { templates: [JSON.parse(JSON.stringify(VO_PUB_DEFAULT_TPL))], byVote: {} };
    if(!Array.isArray(VO.pub.templates)) VO.pub.templates = [JSON.parse(JSON.stringify(VO_PUB_DEFAULT_TPL))];
    if(!VO.pub.byVote || typeof VO.pub.byVote !== 'object') VO.pub.byVote = {};
    voPaintPubBadges();
  }).catch(function(){ VO.pub = { templates: [JSON.parse(JSON.stringify(VO_PUB_DEFAULT_TPL))], byVote: {} }; });
}
function voPubSave(){
  return api('/content', { method:'PUT', body:{ items:{ vote_pub: VO.pub } } });
}
/* 每票公示开关变化后，只刷新卡片上的小徽章（不重拉列表） */
function voPubBadges(){
  if(!VO.pub) return {};
  return VO.pub.byVote || {};
}
function voPaintPubBadges(){
  /* voPaint 已把列表画好；这里只更新每张卡的公示徽章文本 */
  var box = $('voList');
  if(!box) return;
  Array.prototype.forEach.call(box.querySelectorAll('[data-vo-pub-badge]'), function(el){
    var cfg = (VO.pub && VO.pub.byVote || {})[el.getAttribute('data-vo-pub-badge')];
    el.textContent = (cfg && cfg.on) ? '✓ 公示已开启' : '公示未开启';
  });
}

function voLoad(){
  var box = $('voList');
  if(box) box.innerHTML = '<div class="loading"><div class="spinner"></div>加载中…</div>';
  api('/votes?action=list').then(function(j){
    VO.list = (j && j.votes) || [];
    voPaint();
  }).catch(function(e){
    if(box) box.innerHTML = '<div class="alert danger">读取失败：' + esc(e.message || e) + '</div>';
  });
}

/* 截止时间统一按本地时区展示（此前直接切 UTC 字符串，比北京时间少 8 小时） */
/* v3.5.12 今天的日期（本地时区，YYYY-MM-DD）——投票「提出日期」用 */
function voTodayStr(){
  var d = new Date();
  function p(n){ return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function voTimeText(iso){
  if(!iso) return '';
  var d = new Date(iso);
  if(isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
  function p(n){ return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
/* datetime-local 输入框值（本地时区，T 分隔） */
function voLocalInput(iso){  var d = new Date(iso);
  if(isNaN(d.getTime())) return String(iso).slice(0, 16);
  function p(n){ return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function voStatusText(v){
  if(v.status === 'closed') return { text: '已截止', cls: 'muted' };
  if(!v.deadline) return { text: '进行中 · 不限截止', cls: 'ok' };
  var ms = Date.parse(v.deadline) - Date.now();
  if(ms <= 0) return { text: '已过截止时间', cls: 'muted' };
  var d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000);
  return { text: '进行中 · 还剩 ' + (d > 0 ? d + ' 天' : h + ' 小时'), cls: 'ok' };
}

function voPaint(){
  var box = $('voList');
  if(!box) return;
  if(!VO.list.length){
    box.innerHTML = '<div class="panel"><p class="muted" style="margin:0;font-size:.86rem">暂无投票。点击右上角「新建投票」创建。</p></div>';
    return;
  }
  box.innerHTML = VO.list.map(function(v){
    var st = voStatusText(v);
    var total = 0, maxN = 0;
    (v.results || []).forEach(function(r){ total += r.n; if(r.n > maxN) maxN = r.n; });
    var resHtml = '';
    if(v.results){
      resHtml = '<div style="margin-top:10px">' + v.results.slice().sort(function(a, b){ return b.n - a.n; }).map(function(r){
        var pct = maxN > 0 ? Math.round(r.n / maxN * 100) : 0;
        return '<div style="position:relative;padding:7px 10px;border-radius:8px;background:var(--bg-2,#faf6f2);margin-bottom:6px;overflow:hidden">'
          + '<div style="position:absolute;left:0;top:0;bottom:0;width:' + pct + '%;background:#ffe4cf"></div>'
          + '<div style="position:relative;display:flex;justify-content:space-between;gap:10px;font-size:.82rem">'
          +   '<span>' + esc(r.label) + (r.by === 'student' ? ' <span class="muted" style="font-size:.7rem">同学提</span>' : '') + '</span>'
          +   '<span class="muted" style="white-space:nowrap">' + r.n + ' 票</span>'
          + '</div></div>';
      }).join('') + '</div>';
    }else{
      resHtml = '<p class="muted" style="margin:10px 0 0;font-size:.8rem">'
        + '进行中，票数在截止后公布（防止看到结果再投）。选项 ' + (v.options || []).length + ' 个。</p>';
    }
    var top5 = '';
    if(v.kind === 'song' && v.results){
      /* v3.5.19：前 N 可配、用途（日常/音乐课）、统计总时长
         v3.5.23：总时长上限与取前 N 二选一贯彻到底 ——
           cap 模式下标题写「按时长上限」，取歌按累加时长截断（同 voWriteTop5），
           「取前 N 名」输入框禁用，不再出现「前 5 名」这种矛盾文案。 */
      var sp = v.songPick || {};
      var cap = sp.maxMinutes || 0;
      var topN = cap > 0 ? 0 : (sp.topN || 5);
      var purpose = sp.purpose === 'music' ? 'music' : 'daily';
      var metaOf = function(o){
        var op = (v.options || []).filter(function(x){ return String(x.id) === String(o.id); })[0];
        return (op && op.songMeta) || null;
      };
      /* 按票数降序，取到「前 N 名」或「总时长不超上限」为止 */
      var capSec = cap > 0 ? cap * 60 : Infinity;
      var usedSec = 0;
      var top = [];
      var all = v.results.slice().sort(function(a, b){ return b.n - a.n; });
      for(var ti = 0; ti < all.length; ti++){
        if(topN > 0 && top.length >= topN) break;
        var mm0 = metaOf(all[ti]);
        var d0 = (mm0 && mm0.duration) ? Number(mm0.duration) : 0;
        /* cap 模式：缺时长的歌不参与判断；超了就跳过这首、看下一首（尽量装满上限） */
        if(cap > 0 && d0 && usedSec + d0 > capSec) continue;
        top.push(all[ti]);
        usedSec += d0;
      }
      var totalSec = usedSec;
      var durTxt = totalSec ? voFmtDur(totalSec) : '';
      var capTxt = cap
        ? (' · 上限 ' + cap + ' 分钟' + (totalSec && totalSec > capSec ? '（<b style="color:#c2410c">已超 ' + voFmtDur(totalSec - capSec) + '</b>）' : ''))
        : '';
      var titleTxt = cap > 0
        ? ('按时长上限 ' + cap + ' 分钟' + (purpose === 'music' ? '（音乐课）' : ''))
        : (purpose === 'music' ? ('前 ' + topN + ' 名（音乐课）') : ('前 ' + topN + ' 名（对应周一至周五）'));
      top5 = '<div style="margin-top:10px;padding:10px;border-radius:8px;background:var(--bg-2,#faf6f2)">'
        + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
        +   '<b style="font-size:.82rem">' + esc(titleTxt) + '</b>'
        +   '<span class="muted" style="font-size:.74rem">'
        +     (durTxt ? '总时长 ' + durTxt : '总时长未知') + capTxt
        +   '</span>'
        +   '<span style="flex:1"></span>'
        +   (cap > 0 ? '' : '<label class="muted" style="font-size:.74rem">取前'
        +     '<input id="voTopN_' + v.id + '" type="number" min="1" max="50" value="' + topN + '" '
        +       'style="width:56px;padding:2px 6px;margin:0 4px;font-size:.78rem"> 名</label>')
        + '</div>'
        + '<ol style="margin:6px 0 0;padding-left:20px;font-size:.82rem;line-height:1.8">'
        + top.map(function(o, i){
            var mm = metaOf(o);
            var d = (mm && mm.duration) ? voFmtDur(mm.duration) : '';
            var day = cap > 0 ? ('第 ' + (i + 1) + ' 首')
              : (purpose === 'music' ? ('第 ' + (i + 1) + ' 首') : ('周' + '一二三四五'[i]));
            return '<li>' + esc(o.label) + ' <span class="muted">（' + o.n + ' 票 · ' + day + (d ? ' · ' + d : '') + '）</span></li>';
          }).join('')
        + '</ol>'
        + '<button class="btn btn-sm btn-secondary" style="margin-top:8px" data-vo-top5="' + v.id + '">'
        +   svg('music',13) + ' 写入抽歌排期</button></div>';
    }
    return '<div class="panel" style="margin-bottom:12px">'
      + '<div style="display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap">'
      +   '<div style="flex:1;min-width:160px">'
      +     '<b style="font-size:.9rem">' + esc(v.title) + '</b>'
      +     (v.kind === 'song' ? '<span class="badge" style="margin-left:6px">歌单</span>' : '')
      /* v3.5.12 #10：提出人 + 提出日期
         v3.5.23：元信息拆成「状态行 / 规则行」两组，不再糊成一条 */
      +     '<div class="muted" style="font-size:.76rem;margin-top:3px">'
      +       esc(v.proposer || v.createdByName || '未记录')
      +       (v.createdDate ? ' · ' + esc(v.createdDate) + ' 提出' : '')
      +       ' · ' + st.text
      +       (v.deadline ? ' · 截止 ' + esc(voTimeText(v.deadline)) : ' · 不限截止')
      +       (v.results ? ' · ' + (v.voters || total) + ' 人参与' : '')
      +     '</div>'
      +     '<div class="muted" style="font-size:.72rem;margin-top:2px">'
      +       [
              v.multi ? ('多选' + (v.maxChoices ? '（最多 ' + v.maxChoices + ' 项' + (v.minChoices ? ' / 至少 ' + v.minChoices + ' 项' : '') + '）' : ''))
                      : ('单选' + (v.minChoices ? '（至少 ' + v.minChoices + ' 项）' : '')),
              v.retractLimit > 0 ? '可撤回 ' + v.retractLimit + ' 次' : '不可撤回',
              v.endMode === 'pub' ? '结束后显示公示' : '结束后保留投票',
              v.allowAdd ? '同学可加选项' : '',
            ].filter(Boolean).map(esc).join(' · ')
      +     '</div>'
      +   '</div>'
      +   '<div style="display:flex;gap:6px;flex-wrap:wrap">'
      +     '<button class="btn btn-sm btn-ghost" data-vo-edit="' + v.id + '">' + svg('edit',13) + ' 编辑</button>'
      +     '<button class="btn btn-sm btn-ghost" data-vo-pub="' + v.id + '">📋 公示'
      +       '<span class="muted" style="font-size:.68rem;margin-left:4px" data-vo-pub-badge="' + v.id + '"></span></button>'
      +     '<button class="btn btn-sm btn-ghost" data-vo-ballots="' + v.id + '">' + svg('users',13) + ' 投票明细'
      +       '<span class="muted" style="font-size:.68rem;margin-left:4px">' + ((v.ballots || []).length) + '</span></button>'
      +     (v.status === 'open'
              ? '<button class="btn btn-sm btn-ghost" data-vo-close="' + v.id + '">' + svg('lock',13) + ' 截止并公布</button>'
              : '<button class="btn btn-sm btn-ghost" data-vo-reopen="' + v.id + '">' + svg('unlock',13) + ' 重新打开</button>')
      +     '<button class="btn btn-sm btn-ghost" style="color:#b3261e" data-vo-del="' + v.id + '">' + svg('trash',13) + ' 删除</button>'
      +   '</div>'
      + '</div>'
      + (v.note ? '<p class="muted" style="font-size:.8rem;margin:8px 0 0">' + esc(v.note) + '</p>' : '')
      + resHtml
      + top5
      + '<div id="voBal_' + v.id + '" style="display:none"></div>'
      + '</div>';
  }).join('');

  /* 绑定 */
  Array.prototype.forEach.call(box.querySelectorAll('[data-vo-edit]'), function(b){
    b.onclick = function(){
      var one = voFind(Number(b.dataset.voEdit));
      window.__voEditingId = one ? one.id : -1;
      voEditorDialog(one);
    };
  });
  Array.prototype.forEach.call(box.querySelectorAll('[data-vo-close]'), function(b){
    b.onclick = function(){ voSetStatus(Number(b.dataset.voClose), 'closed'); };
  });
  Array.prototype.forEach.call(box.querySelectorAll('[data-vo-reopen]'), function(b){
    b.onclick = function(){ voSetStatus(Number(b.dataset.voReopen), 'open'); };
  });
  Array.prototype.forEach.call(box.querySelectorAll('[data-vo-del]'), function(b){
    b.onclick = function(){ voDelete(Number(b.dataset.voDel)); };
  });
  Array.prototype.forEach.call(box.querySelectorAll('[data-vo-top5]'), function(b){
    b.onclick = function(){ voWriteTop5(Number(b.dataset.voTop5)); };
  });
  Array.prototype.forEach.call(box.querySelectorAll('[data-vo-pub]'), function(b){
    b.onclick = function(){ voPubDialog(Number(b.dataset.voPub)); };
  });
  Array.prototype.forEach.call(box.querySelectorAll('[data-vo-ballots]'), function(b){
    b.onclick = function(){ voToggleBallots(Number(b.dataset.voBallots)); };
  });
  voPaintPubBadges();
}

/* ============================================================================
 * v3.5.40（站主 #2）：投票明细 —— 每张票是谁投的、什么时候投的
 * ----------------------------------------------------------------------------
 * 数据来自后端 listVotes 的管理员分支（v.ballots），普通同学拿不到这个字段。
 * 展示：姓名（@登录名）/ 选了哪几项 / 时间；撤回的票（choices 为空）单独标注。
 * ========================================================================= */
function voToggleBallots(id){
  var v = voFind(Number(id));
  var box = document.getElementById('voBal_' + id);
  if(!v || !box) return;
  if(box.style.display !== 'none'){ box.style.display = 'none'; return; }

  var labelOf = {};
  (v.options || []).forEach(function(o){ labelOf[String(o.id)] = o.label; });
  var list = (v.ballots || []).slice();

  /* 未撤回的算「有效票」；撤回的虽占一行，但不计入票数 */
  var valid = list.filter(function(x){ return (x.choices || []).length > 0; });

  var rows = list.map(function(x, i){
    var picked = (x.choices || []).map(function(cid){
      return labelOf[String(cid)] || ('#' + cid);
    });
    var t = x.at ? new Date(x.at) : null;
    var timeTxt = '';
    if(t && !isNaN(t.getTime())){
      function p(n){ return (n < 10 ? '0' : '') + n; }
      timeTxt = t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate())
        + ' ' + p(t.getHours()) + ':' + p(t.getMinutes());
    }
    return '<tr>'
      + '<td class="muted" style="width:34px">' + (i + 1) + '</td>'
      + '<td style="white-space:nowrap"><b>' + esc(x.name) + '</b>'
      +   (x.username ? '<span class="muted" style="font-size:.72rem;margin-left:4px">@' + esc(x.username) + '</span>' : '')
      + '</td>'
      + '<td>' + (picked.length
          ? picked.map(function(s){ return '<span class="badge" style="margin:1px 3px 1px 0">' + esc(s) + '</span>'; }).join('')
          : '<span class="muted">（已撤回）</span>') + '</td>'
      + '<td class="muted" style="white-space:nowrap;font-size:.76rem">' + esc(timeTxt) + '</td>'
      + '</tr>';
  }).join('');

  box.style.display = 'block';
  box.innerHTML = '<div style="margin-top:10px;border:1px solid var(--border);border-radius:10px;overflow:hidden">'
    + '<div style="padding:8px 12px;background:var(--bg-2,#faf6f2);display:flex;gap:12px;flex-wrap:wrap;font-size:.78rem">'
    +   '<b>投票明细</b>'
    +   '<span class="muted">有效票 ' + valid.length + ' 张'
    +     (list.length !== valid.length ? '（另有 ' + (list.length - valid.length) + ' 人撤回）' : '') + '</span>'
    + '</div>'
    + (list.length
        ? '<div style="max-height:360px;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:.8rem">'
          + '<thead><tr style="text-align:left"><th style="padding:6px 10px">#</th><th style="padding:6px 10px">投票人</th>'
          + '<th style="padding:6px 10px">投给</th><th style="padding:6px 10px">时间</th></tr></thead>'
          + '<tbody>' + rows.replace(/<td/g, '<td style="padding:6px 10px;border-top:1px solid var(--border)"') + '</tbody>'
          + '</table></div>'
        : '<p class="muted" style="padding:12px;margin:0;font-size:.82rem">暂无投票记录。</p>')
    + '</div>';
}

/* ---------- 公示模版管理 ---------- */
function voTemplatesDialog(){
  var tpls = (VO.pub && VO.pub.templates) || [];
  var listHtml = tpls.map(function(t){
    return '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px">'
      + '<div style="flex:1;min-width:0"><b style="font-size:.86rem">' + esc(t.name) + '</b>'
      + '<div class="muted" style="font-size:.72rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'
      + esc((t.template || '').split('\n')[0]) + '</div></div>'
      + '<button class="btn btn-sm btn-secondary" data-tpl-edit="' + t.id + '">编辑</button>'
      + (t.id === 'default' ? '' : '<button class="btn btn-sm btn-ghost" style="color:#b3261e" data-tpl-del="' + t.id + '">删除</button>')
      + '</div>';
  }).join('') || '<p class="muted">还没有模版，点「新增模版」创建。</p>';
  openModal({
    title: '公示模版管理', sub: '公示时按模版渲染；{{变量}} 会被替换成真实数据',
    body: listHtml
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">'
      +   '<button class="btn btn-sm" id="voTplNew">新增模版</button>'
      +   '<button class="btn btn-sm btn-secondary" id="voTplImport">导入模版（粘贴 JSON）</button>'
      + '</div>'
      + '<div class="muted" style="font-size:.74rem;margin-top:10px;line-height:1.8">'
      + '可用变量：' + VO_PUB_VARS.map(function(v){ return '<code>{{' + v + '}}</code>'; }).join(' ')
      + '<br>也可以让别的 AI 生成完整模版，再点「导入模版」粘贴进来（支持一条 JSON 或数组）。</div>',
    onMount: function(box){
      box.querySelector('#voTplNew').onclick = function(){ voTplEditor(null); };
      box.querySelector('#voTplImport').onclick = function(){ voTplImport(); };
      Array.prototype.forEach.call(box.querySelectorAll('[data-tpl-edit]'), function(b){
        b.onclick = function(){
          var t = tpls.filter(function(x){ return x.id === b.dataset.tplEdit; })[0];
          voTplEditor(t);
        };
      });
      Array.prototype.forEach.call(box.querySelectorAll('[data-tpl-del]'), function(b){
        b.onclick = function(){
          VO.pub.templates = VO.pub.templates.filter(function(x){ return x.id !== b.dataset.tplDel; });
          voPubSave().then(function(){ toast('已删除', 'ok'); }).catch(function(e){ toast('保存失败：' + e.message, 'err'); });
          voTemplatesDialog();   /* 重画 */
        };
      });
    },
  });
}

function voTplEditor(tpl){
  var isNew = !tpl;
  tpl = tpl || { id: 't' + Date.now(), name: '', template: '' };
  var varBtns = VO_PUB_VARS.map(function(v){
    return '<button class="btn btn-sm btn-secondary" data-tplvar="' + v + '" style="margin:0 6px 6px 0">{{' + v + '}}</button>';
  }).join('');
  openModal({
    title: isNew ? '新增公示模版' : '编辑公示模版',
    body:
      '<div class="field"><label>模版名称</label><input id="voTplName" maxlength="30" value="' + attr(tpl.name) + '"></div>'
      + '<div class="field"><label>模版内容（{{变量}} 会被替换）</label>'
      +   '<div style="margin-bottom:6px"><span class="muted" style="font-size:.74rem">点变量插入到光标处：</span></div>'
      +   '<div>' + varBtns + '</div>'
      +   '<textarea id="voTplBody" rows="10" style="width:100%;font-family:var(--mono,monospace);font-size:.8rem;line-height:1.7">'
      +     esc(tpl.template) + '</textarea></div>'
      + '<div class="muted" style="font-size:.74rem">「结果表」会渲染成带排名和票数的表格；其余变量替换成纯文本。</div>',
    foot: '<button class="btn btn-ghost" data-close2>取消</button>'
      + '<button class="btn" id="voTplSave">保存</button>',
    onMount: function(box){
      box.querySelector('[data-close2]').onclick = closeModal;
      var ta = box.querySelector('#voTplBody');
      Array.prototype.forEach.call(box.querySelectorAll('[data-tplvar]'), function(b){
        b.onclick = function(){
          var v = '{{' + b.dataset.tplvar + '}}';
          var s = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
          ta.value = ta.value.slice(0, s) + v + ta.value.slice(ta.selectionEnd == null ? s : ta.selectionEnd);
          ta.focus();
          try{ ta.setSelectionRange(s + v.length, s + v.length); }catch(e){}
        };
      });
      box.querySelector('#voTplSave').onclick = function(){
        var name = box.querySelector('#voTplName').value.trim();
        var body = ta.value;
        if(!name){ toast('先填模版名称', 'err'); return; }
        if(!body.trim()){ toast('模版内容不能为空', 'err'); return; }
        var hit = VO.pub.templates.filter(function(x){ return x.id === tpl.id; })[0];
        if(hit){ hit.name = name; hit.template = body; }
        else VO.pub.templates.push({ id: tpl.id, name: name, template: body });
        voPubSave().then(function(){ toast('模版已保存', 'ok'); closeModal(); voTemplatesDialog(); })
          .catch(function(e){ toast('保存失败：' + e.message, 'err'); });
      };
    },
  });
}

/* 让别的 AI 生成模版后粘贴导入。支持：
   ① JSON 数组 [{ "name": "...", "template": "..." }, ...]
   ② 单条对象 { name, template }
   ③ 纯文本（整段当一条模版，名称取第一行） */
function voTplImport(){
  openModal({
    title: '导入公示模版',
    sub: '支持 JSON 或纯文本；让别的 AI 生成后整段粘贴进来',
    body:
      '<div class="field"><label>粘贴到这里</label>'
      + '<textarea id="voTplImportTa" rows="10" style="width:100%;font-family:var(--mono,monospace);font-size:.8rem" '
      + 'placeholder=\'[{ "name": "歌单公示", "template": "..." }]\n或直接粘贴纯文本模版\'></textarea></div>'
      + '<div class="muted" style="font-size:.74rem">JSON 导入可一次多条；纯文本导入会把第一行当模版名。</div>',
    foot: '<button class="btn btn-ghost" data-close2>取消</button><button class="btn" id="voTplImportGo">导入</button>',
    onMount: function(box){
      box.querySelector('[data-close2]').onclick = closeModal;
      box.querySelector('#voTplImportGo').onclick = function(){
        var raw = box.querySelector('#voTplImportTa').value.trim();
        if(!raw){ toast('先粘贴内容', 'err'); return; }
        var added = 0;
        try{
          var j = JSON.parse(raw);
          var arr = Array.isArray(j) ? j : [j];
          arr.forEach(function(o){
            if(o && typeof o === 'object' && o.template && String(o.template).trim()){
              VO.pub.templates.push({ id: 't' + Date.now() + '_' + (++added),
                name: String(o.name || '导入模版 ' + added).slice(0, 30), template: String(o.template) });
            }
          });
        }catch(e){
          /* 不是 JSON → 纯文本 */
          var lines = raw.split('\n');
          VO.pub.templates.push({ id: 't' + Date.now(), name: (lines[0] || '导入模版').slice(0, 30), template: raw });
          added = 1;
        }
        if(!added){ toast('没解析出模版（JSON 里要有 name 和 template 字段）', 'err'); return; }
        voPubSave().then(function(){ toast('已导入 ' + added + ' 条', 'ok'); closeModal(); voTemplatesDialog(); })
          .catch(function(e){ toast('保存失败：' + e.message, 'err'); });
      };
    },
  });
}

/* ---------- 单票公示配置 ---------- */
function voPubDialog(voteId){
  var v = voFind(voteId);
  if(!v) return;
  if(!VO.pub) { toast('公示配置读取中，请稍后重试', 'err'); return; }
  var tpls = VO.pub.templates;
  var cfg = VO.pub.byVote[voteId] || {};
  var opts = tpls.map(function(t){
    return '<option value="' + t.id + '"' + (cfg.tplId === t.id ? ' selected' : '') + '>' + esc(t.name) + '</option>';
  }).join('');
  openModal({
    title: '投票公示 · ' + v.title,
    sub: '开启后，同学在投票卡上直接看到按模版渲染的公示',
    body:
      (v.results ? '' : '<div class="alert warn" style="margin-bottom:10px">投票还没截止，现在开启公示也行——截止出结果后前台才会显示内容。</div>')
      + '<div class="field"><label>使用模版</label><select id="voPubTpl" style="width:100%">' + opts + '</select></div>'
      + '<label style="display:flex;align-items:center;gap:8px;margin:10px 0 6px">'
      +   '<input type="checkbox" id="voPubOn"' + (cfg.on ? ' checked' : '') + '>'
      +   '<span>开启公示（前台投票卡下方显示）</span></label>'
      /* v3.5.14 站主要求：公示可以选展示多久，到点自动取消展示 */
      + '<div class="field"><label>展示到什么时候</label>'
      +   '<select id="voPubDur" style="width:100%">'
      +     '<option value="">永久展示（手动关闭才停）</option>'
      +     '<option value="1">1 天后自动取消</option>'
      +     '<option value="3">3 天后自动取消</option>'
      +     '<option value="7">7 天后自动取消</option>'
      +     '<option value="30">30 天后自动取消</option>'
      +     '<option value="custom">自定义结束时间…</option>'
      +   '</select>'
      +   '<div id="voPubUntilWrap" style="display:none;margin-top:8px">'
      +     '<input type="datetime-local" id="voPubUntil" style="width:100%">'
      +   '</div>'
      +   '<p class="muted" style="font-size:.76rem;margin:6px 0 0" id="voPubUntilHint"></p>'
      + '</div>'
      + '<div class="field"><label>预览</label><div id="voPubPrev" style="border:1px dashed var(--border);border-radius:10px;padding:10px;font-size:.82rem;line-height:1.9;max-height:260px;overflow:auto"></div></div>',
    foot: '<button class="btn btn-ghost" data-close2>取消</button><button class="btn" id="voPubSave">保存</button>',
    onMount: function(box){
      box.querySelector('[data-close2]').onclick = closeModal;
      var sel = box.querySelector('#voPubTpl'), on = box.querySelector('#voPubOn'), prev = box.querySelector('#voPubPrev');
      var dur = box.querySelector('#voPubDur'), uw = box.querySelector('#voPubUntilWrap');
      var ut = box.querySelector('#voPubUntil'), uh = box.querySelector('#voPubUntilHint');
      /* 已有结束时间 → 回填到「自定义」 */
      if(cfg.until){
        dur.value = 'custom';
        uw.style.display = '';
        ut.value = voLocalInput(cfg.until);
      }
      function syncUntil(){
        uw.style.display = (dur.value === 'custom') ? '' : 'none';
        var txt = '';
        if(dur.value === 'custom'){
          var t0 = ut.value ? new Date(ut.value) : null;
          txt = (t0 && !isNaN(t0.getTime())) ? '展示到 ' + voTimeText(t0.toISOString()) + '，到点后前台自动隐藏，无需手动关闭。' : '请选择结束时间。';
        }else if(dur.value){
          txt = '从现在起 ' + dur.value + ' 天后自动取消展示。';
        }else{
          txt = '一直展示，直到你手动关闭。';
        }
        uh.textContent = txt;
      }
      dur.onchange = syncUntil; ut.onchange = syncUntil; syncUntil();
      function paint(){
        var t = tpls.filter(function(x){ return x.id === sel.value; })[0];
        prev.innerHTML = t ? voPubPreview(t, v) : '';
      }
      sel.onchange = paint; on.onchange = paint; paint();
      box.querySelector('#voPubSave').onclick = function(){
        var until = null;
        if(dur.value === 'custom'){
          if(!ut.value){ toast('请先选结束时间', 'err'); return; }
          var d = new Date(ut.value);
          if(isNaN(d.getTime())){ toast('结束时间格式不对', 'err'); return; }
          until = d.toISOString();
        }else if(dur.value){
          until = new Date(Date.now() + Number(dur.value) * 86400000).toISOString();
        }
        VO.pub.byVote[voteId] = { tplId: sel.value, on: on.checked, until: until };
        voPubSave().then(function(){ toast(on.checked ? '公示已开启' : '公示已关闭', 'ok'); closeModal(); })
          .catch(function(e){ toast('保存失败：' + e.message, 'err'); });
      };
    },
  });
}

/* 后台预览渲染（与前台 votePubRender 同一套替换规则） */
function voPubPreview(tpl, v){
  var rs = (v.results || []).slice().sort(function(a, b){ return (b.n || 0) - (a.n || 0); });
  var totalVotes = rs.reduce(function(s, r){ return s + (r.n || 0); }, 0);
  var map = {
    '标题': esc(v.title || ''),
    '提出人': esc(v.proposer || v.createdByName || '未记录'),
    '提出日期': esc(v.createdDate || ''),
    '截止时间': esc(v.deadline ? voTimeText(v.deadline) : '不限'),
    '参与人数': String(v.voters || totalVotes),
    '总票数': String(totalVotes),
    '第一名': esc(rs[0] ? rs[0].label : '—'),
    '第二名': esc(rs[1] ? rs[1].label : '—'),
    '第三名': esc(rs[2] ? rs[2].label : '—'),
    '结果表': rs.length
      ? '<table style="border-collapse:collapse;margin:6px 0;width:100%">'
        + '<thead><tr>' + ['排名','选项','提出人','票数'].map(function(h){ return '<th style="border:1px solid var(--border);padding:4px 8px;background:var(--bg-2,#faf6f2);font-size:.78rem;text-align:left">' + h + '</th>'; }).join('') + '</tr></thead><tbody>'
        + rs.map(function(r, i){
            return '<tr><td style="border:1px solid var(--border);padding:4px 8px;font-size:.78rem">' + (i + 1) + '</td>'
              + '<td style="border:1px solid var(--border);padding:4px 8px;font-size:.78rem">' + esc(r.label) + '</td>'
              + '<td style="border:1px solid var(--border);padding:4px 8px;font-size:.78rem">'
              +   esc(r.byName || (r.by === 'student' ? '同学' : '管理员')) + '</td>'
              + '<td style="border:1px solid var(--border);padding:4px 8px;font-size:.78rem">' + (r.n || 0) + ' 票</td></tr>';
          }).join('') + '</tbody></table>'
      : '<span class="muted">（截止后这里显示结果表）</span>',
  };
  return String(tpl.template || '')
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, function(m, k){ return map[k] !== undefined ? map[k] : m; })
    .split('\n').join('<br>');
}

function voFind(id){
  for(var i = 0; i < VO.list.length; i++) if(VO.list[i].id === id) return VO.list[i];
  return null;
}

function voSetStatus(id, st){
  api('/votes?action=set-status', { method: 'POST', body: { voteId: id, status: st } })
    .then(function(j){ toast(j.message || '已更新', 'ok'); voLoad(); })
    .catch(function(e){ toast(e.message || String(e), 'err', 4000); });
}

function voDelete(id){
  var v = voFind(id);
  confirmBox({
    title: '删除投票',
    text: '确定删除「' + ((v && v.title) || id) + '」？所有投票记录会一并删除，不可恢复。',
    danger: true,
    okText: '删除'
  }).then(function(yes){
    if(!yes) return;
    api('/votes?action=delete', { method: 'POST', body: { voteId: id } })
      .then(function(j){ toast(j.message || '已删除', 'ok'); voLoad(); })
      .catch(function(e){ toast(e.message || String(e), 'err', 4000); });
  });
}

/* 歌单投票：把「前 N」写进抽歌排期（v3.5.19：N 可改、用途可选、带时长） */
function voWriteTop5(id){
  var v = voFind(id);
  if(!v || !v.results){ toast('还没有结果', 'err'); return; }
  var sp = v.songPick || {};
  var nEl = document.getElementById('voTopN_' + id);
  var capMin0 = Number(sp.maxMinutes) || 0;
  /* v3.5.23：cap 模式下不再有「取前 N」输入（sp.topN = 0），数量由时长上限决定 */
  var wantN = capMin0 > 0 ? Infinity
    : Math.max(1, Number((nEl && nEl.value) || sp.topN || 5));
  var purpose = sp.purpose === 'music' ? 'music' : 'daily';
  var capMin = capMin0;

  var sorted = v.results.slice().sort(function(a, b){ return b.n - a.n; });
  var optMeta = function(o){
    var op = (v.options || []).filter(function(x){ return String(x.id) === String(o.id); })[0];
    return (op && op.songMeta) || null;
  };
  /* 🔴 v3.5.27（站主）：「时长为空不能随机排歌」—— 写排期也是排歌。
     先把这条投票里所有缺时长的选项列出来拦下，让站主补齐再写。 */
  var missOp = [];
  (v.options || []).forEach(function(op){
    var d = op.songMeta && Number(op.songMeta.duration);
    if(!(d >= 20)) missOp.push(op);
  });
  if(missOp.length){
    var map = {};
    missOp.forEach(function(op){
      var parts = String(op.label || '').split(' - ');
      var t = (op.songMeta && op.songMeta.title) || parts[0] || '';
      var a = (op.songMeta && op.songMeta.artist) || parts[1] || '';
      map[vhDurationKey(t, a)] = { title: t, artist: a };
    });
    Object.keys(map).forEach(function(k){ if(!DUR_MISS[k]) DUR_MISS[k] = map[k]; });
    toast('这条投票里有 ' + missOp.length + ' 首还没时长，补齐后才能写排期', 'err', 4000);
    voDurManualDialog(Object.keys(map), function(){
      /* 补录完成后自动重跑一次 —— 站主不用再点一遍 */
      voWriteTop5(id);
    });
    return;
  }
  var picked = [], usedSec = 0;
  for(var i = 0; i < sorted.length && picked.length < wantN; i++){
    var o = sorted[i];
    var om = optMeta(o);
    var d = (om && om.duration) ? Number(om.duration) : 0;
    /* 到这步时长一定齐了；总时长上限只做跳过判断 */
    if(capMin > 0 && usedSec + d > capMin * 60) continue;
    picked.push(o);
    usedSec += d;
  }
  var top = picked;
  if(!top.length){ toast('这条投票没有选项', 'err'); return; }
  var DAYS = ['周一', '周二', '周三', '周四', '周五'];
  var totalTxt = usedSec ? voFmtDur(usedSec) : '';
  var labels = top.map(function(o, i){
    var om2 = optMeta(o);
    var d = (om2 && om2.duration) ? voFmtDur(om2.duration) : '';
    var slot = purpose === 'music' ? ('第 ' + (i + 1) + ' 首') : (DAYS[i] || ('第 ' + (i + 1) + ' 首'));
    return slot + ' ' + o.label + (d ? '（' + d + '）' : '');
  }).join('；');
  var rec = {
    id: Date.now(),
    at: new Date().toLocaleString('zh-CN', { hour12: false }),
    /* v3.5.23：cap 模式下备注写「按时长上限」，不再写「前 N」 */
    note: (capMin0 > 0
        ? (purpose === 'music' ? '音乐课投票按时长上限 ' + capMin0 + ' 分钟' : '投票按时长上限 ' + capMin0 + ' 分钟')
        : (purpose === 'music' ? '音乐课投票前 ' + top.length : '投票前 ' + top.length))
      + '：「' + v.title + '」'
      + (totalTxt ? '（共 ' + top.length + ' 首 · 总时长 ' + totalTxt + '）' : '') + '：' + labels,
    purpose: purpose,
    totalSeconds: usedSec,
    addedToPlatform: false,
    played: false,
    songs: top.map(function(o, i){
      return {
        id: o.songId != null ? o.songId : ('vote-' + o.id),
        title: o.label,
        artist: '投票第 ' + (i + 1) + ' 名',
        votes: o.n,
        requester: (optMeta(o) && optMeta(o).requester) || '',
        duration: (optMeta(o) && optMeta(o).duration) || 0,
      };
    }),
    params: { fromVote: id, voteTitle: v.title, days: DAYS.slice(0, top.length), purpose: purpose, maxMinutes: capMin || null },
  };
  api('/content').then(function(j){
    var cur = (j && j.items && j.items.dj_schedule) || [];
    var rounds = Array.isArray(cur) ? cur.slice() : (cur && Array.isArray(cur.schedule) ? cur.schedule.slice() : []);
    rounds.push(rec);
    return api('/content', { method: 'PUT', body: { items: { dj_schedule: rounds } } });
  }).then(function(){
    toast('已写入抽歌排期（' + top.length + ' 首）', 'ok');
  }).catch(function(e){
    toast('写入失败：' + (e.message || e), 'err', 4000);
  });
}

/* 新建 / 编辑投票的弹窗 */
function voEditorDialog(v){
  var isNew = !v;
  var opts = (v && v.options) ? v.options.map(function(o){ return o.label; }).join('\n') : '';
  openModal({
    title: isNew ? '新建投票' : '编辑投票',
    sub: isNew ? '选项一行一个；至少两个' : '已投的票会按选项文字对应保留',
    wide: true,
    body:
      '<div id="voEditor" data-kind="' + ((v && v.kind === 'song') ? 'song' : 'normal') + '">'
      + '<div class="field"><label>投票标题</label>'
      +   '<input id="voTitle" maxlength="60" placeholder="例如：这次班级活动的主题" value="' + attr((v && v.title) || '') + '"></div>'
      + '<div class="field"><label>类型</label>'
      +   '<select id="voKind">'
      +     '<option value="normal"' + (v && v.kind === 'song' ? '' : ' selected') + '>普通投票</option>'
      +     '<option value="song"' + (v && v.kind === 'song' ? ' selected' : '') + '>歌单投票（从点歌平台选歌）</option>'
      +   '</select></div>'
      /* v3.5.25：选项文本框只给「普通投票」用；歌单投票以勾选为唯一数据源。
         v3.5.26：改由 CSS 按 data-kind 控制显隐（纯 CSS，不依赖 onMount 时机）。
         文本框仍留在 DOM 里当隐藏数据载体，保存时照旧从它读，提交逻辑不变。 */
      + '<div class="field vo-opts-wrap" id="voOptsWrap"><label>选项（一行一个）</label>'
      +   '<textarea id="voOpts" rows="6" placeholder="选项一&#10;选项二">' + esc(opts) + '</textarea>'
      +   '<p class="muted" style="font-size:.76rem;margin:6px 0 0">每行一个选项。歌单投票请切上面的类型，改用下面的勾选。</p>'
      +   '</div>'
      /* v3.5.19：歌单投票「选项里包含哪些字段」+ 取前 N / 用途 / 时长上限 */
      + '<div id="voSongOpts" style="display:none;margin-bottom:12px">'
      +   '<div class="field"><label>选项「详情」里包含哪些</label>'
      +     '<div style="display:flex;gap:14px;flex-wrap:wrap;font-size:.84rem">'
      +       '<label style="display:flex;align-items:center;gap:5px;white-space:nowrap;flex:0 0 auto"><input type="checkbox" id="voFldReq" checked> 点歌人</label>'
      +       '<label style="display:flex;align-items:center;gap:5px;white-space:nowrap;flex:0 0 auto"><input type="checkbox" id="voFldTime" checked> 点歌时间</label>'
      +       '<label style="display:flex;align-items:center;gap:5px;white-space:nowrap;flex:0 0 auto"><input type="checkbox" id="voFldVotes"> 实时赞数</label>'
      +       '<label style="display:flex;align-items:center;gap:5px;white-space:nowrap;flex:0 0 auto" title="时长永远显示，无法关闭">'
      +         '<input type="checkbox" id="voFldDur" checked disabled> 歌曲时长（必显示）</label>'
      +     '</div>'
      +     '<p class="hint" style="margin:6px 0 0">'
      +       '歌名、歌手、<b>歌曲时长</b>永远直接显示（时长跟在歌手后面，用另一种字色）；'
      +       '其余勾了的项收进「详情」，同学点击才展开。不勾 = 该项不展示（也不写进选项）。</p>'
      +   '</div>'
      +   '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start">'
      +     '<div class="field" style="width:140px"><label>取前几名</label>'
      +       '<input id="voPickN" type="number" min="1" max="50" inputmode="numeric" placeholder="不限" value="'
      +       attr(v && v.songPick && v.songPick.topN ? String(v.songPick.topN) : '') + '"></div>'
      +     '<div class="field" style="width:190px"><label>用途</label>'
      +       '<select id="voPickPurpose" style="width:100%">'
      +         '<option value="daily"' + (v && v.songPick && v.songPick.purpose === 'music' ? '' : ' selected') + '>日常（周一至周五）</option>'
      +         '<option value="music"' + (v && v.songPick && v.songPick.purpose === 'music' ? ' selected' : '') + '>音乐课</option>'
      +       '</select></div>'
      +     '<div class="field" style="width:190px"><label>总时长上限</label>'
      +       '<input id="voPickCap" type="number" min="1" max="300" inputmode="numeric" placeholder="留空 = 不限（分钟）" value="'
      +       attr(v && v.songPick && v.songPick.maxMinutes ? String(v.songPick.maxMinutes) : '') + '"></div>'
      +   '</div>'
      +   '<p class="hint" id="voPickHint" style="margin:6px 0 0">取前几名 / 总时长上限二选一：填了总时长上限，抽取数量由系统自动按歌曲时长凑，不需要再填「取前几名」。</p>'
      + '</div>'
      + '<div id="voSongPick" style="display:none;margin-bottom:12px"></div>'
      + '<div class="field"><label>截止时间（留空 = 不限截止）</label>'
      +   '<input type="datetime-local" id="voDeadline" value="' + attr((v && v.deadline) ? voLocalInput(v.deadline) : '') + '"></div>'
      /* v3.5.12 #10：提出人 + 提出日期（日期 = 创建时间，自动带出，不用手填） */
      + '<div style="display:flex;gap:12px;flex-wrap:wrap">'
      +   '<div class="field" style="flex:1;min-width:180px"><label>提出人</label>'
      +     '<input id="voProposer" maxlength="20" placeholder="谁提的？留空=记为你自己" value="'
      +     attr((v && v.proposer) || '') + '"></div>'
      +   '<div class="field" style="width:170px"><label>提出日期</label>'
      +     '<input type="date" id="voCreatedDate" value="' + attr((v && v.createdDate) || voTodayStr()) + '"'
      +     ' title="默认取创建当天，可以改"></div>'
      + '</div>'
      + '<div class="field"><label>说明（选填）</label>'
      +   '<input id="voNote" maxlength="200" placeholder="投票说明，会显示在标题下方" value="' + attr((v && v.note) || '') + '"></div>'
      + '<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:.86rem;margin-bottom:8px">'
      +   '<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="voMulti"' + (v && v.multi ? ' checked' : '') + '> 允许多选</label>'
      +   '<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="voAllowAdd"' + (v && v.allowAdd ? ' checked' : '') + '> 允许同学自己加选项</label>'
      /* v3.19.0：公开（未登录也能看选项和结果，想投票仍需登录） */
      +   '<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="voPublic"' + (!v || v.publicRead !== false ? ' checked' : '') + '> 公开（未登录也能看结果）</label>'
      + '</div>'
      + '<p class="muted" style="font-size:.76rem;margin:-2px 0 10px">「公开」= 分享链接打开后可查看选项、各多少票；不勾则必须登录才看得到。'
      + '无论勾不勾，投票本身都必须登录。</p>'
      /* v3.5.14 #9：票数配额 + 撤回次数 */
      + '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px">'
      +   '<div class="field" style="flex:1;min-width:130px"><label>最多选几项</label>'
      +     '<input id="voMaxChoices" type="number" min="1" max="30" inputmode="numeric" placeholder="留空 = 不限" value="'
      +     attr(v && v.maxChoices != null ? String(v.maxChoices) : '') + '"></div>'
      +   '<div class="field" style="flex:1;min-width:130px"><label>至少选几项</label>'
      +     '<input id="voMinChoices" type="number" min="1" max="30" inputmode="numeric" placeholder="留空 = 不限" value="'
      +     attr(v && v.minChoices != null ? String(v.minChoices) : '') + '"></div>'
      +   '<div class="field" style="flex:1;min-width:130px"><label>可撤回次数</label>'
      +     '<input id="voRetractLimit" type="number" min="0" max="5" inputmode="numeric" placeholder="默认 1；0 = 不允许" value="'
      +     attr(v && v.retractLimit != null ? String(v.retractLimit) : '1') + '"></div>'
      + '</div>'
      + '<p class="muted" style="font-size:.76rem;margin:-2px 0 10px">'
      +   '点👍只是选中，「确定投票」才上传。多选时「最多选」限制一次能点几项，「至少选」是必须选够几项；两个留空都代表不限。'
      + '</p>'
      /* v3.5.19：同学新增选项的限制（字数 + 格式） */
      + '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px">'
      +   '<div class="field" style="width:150px"><label>新增选项最多</label>'
      +     '<input id="voOptMax" type="number" min="1" max="80" inputmode="numeric" placeholder="留空 = 不限" value="'
      +     attr(v && v.optionRule && v.optionRule.maxLen ? String(v.optionRule.maxLen) : '') + '"></div>'
      +   '<div class="field" style="width:170px"><label>新增选项格式</label>'
      +     '<select id="voOptFmt" style="width:100%">'
      +       '<option value=""' + (v && v.optionRule && v.optionRule.format ? '' : ' selected') + '>不限</option>'
      +       '<option value="number"' + (v && v.optionRule && v.optionRule.format === 'number' ? ' selected' : '') + '>仅数字</option>'
      +       '<option value="en"' + (v && v.optionRule && v.optionRule.format === 'en' ? ' selected' : '') + '>仅英文</option>'
      +       '<option value="date"' + (v && v.optionRule && v.optionRule.format === 'date' ? ' selected' : '') + '>仅日期</option>'
      +     '</select></div>'
      +   '<div class="field" style="width:170px" id="voOptPrecWrap"><label>日期精确到</label>'
      +     '<select id="voOptPrec" style="width:100%">'
      +       ['minute:分','hour:时','day:日','month:月','year:年'].map(function(p){
                var kv = p.split(':');
                return '<option value="' + kv[0] + '"' + ((v && v.optionRule && v.optionRule.precision || 'minute') === kv[0] ? ' selected' : '') + '>' + kv[1] + '</option>';
              }).join('')
      +     '</select></div>'
      + '</div>'
      + '<p class="muted" style="font-size:.74rem;margin:-2px 0 10px">只对「允许同学自己加选项」时同学填的内容生效；后台自己填不受限制。</p>'
      /* v3.5.14：结束后形态 */
      + '<div class="field"><label>投票结束后</label>'
      +   '<select id="voEndMode" style="width:100%">'
      +     '<option value="keep"' + (v && v.endMode === 'pub' ? '' : ' selected') + '>继续显示投票栏（只读，不能投）</option>'
      +     '<option value="pub"' + (v && v.endMode === 'pub' ? ' selected' : '') + '>展示结果公示并隐藏投票</option>'
      +   '</select>'
      +   '<p class="muted" style="font-size:.76rem;margin:6px 0 0">选「展示公示」要在「公示」里配好模版并开启，否则仍按只读投票栏显示。</p>'
      + '</div>'
      + '</div>',
    foot: '<button class="btn btn-ghost" data-no>取消</button>'
        + '<button class="btn" data-yes>' + (isNew ? '创建' : '保存') + '</button>',
    onMount: function(box){
      box.querySelector('[data-no]').onclick = closeModal;
      box.querySelector('[data-yes]').onclick = submit;

      /* 类型切到「歌单投票」时才显示挑歌区 */
      var kindSel = box.querySelector('#voKind');
      var pick = box.querySelector('#voSongPick');
      var songOpts = box.querySelector('#voSongOpts');
      var precWrap = box.querySelector('#voOptPrecWrap');
      var fmtSel = box.querySelector('#voOptFmt');
      var syncKind = function(){
        var isSong = kindSel.value === 'song';
        pick.style.display = isSong ? '' : 'none';
        /* v3.5.26：选项文本框的显隐交给 CSS（#voEditor[data-kind="song"] .vo-opts-wrap），
           这里只负责同步 data-kind。以前只靠 style.display，一旦 onMount 没跑到就露出来。 */
        var ed = box.querySelector('#voEditor');
        if(ed) ed.setAttribute('data-kind', isSong ? 'song' : 'normal');
        var optsWrap = box.querySelector('#voOptsWrap');
        if(optsWrap) optsWrap.style.display = isSong ? 'none' : '';
        if(songOpts) songOpts.style.display = isSong ? '' : 'none';
        if(precWrap) precWrap.style.display = (fmtSel && fmtSel.value === 'date') ? '' : 'none';
        /* v3.5.23：歌单投票没有「同学自己加选项」—— 从点歌平台挑的歌才是有效选项，
           同学手打出来的字符串没有 songMeta，前台会退化成整条裸奔。直接禁掉。 */
        var addCb = box.querySelector('#voAllowAdd');
        if(addCb){
          if(isSong){
            addCb.checked = false;
            addCb.disabled = true;
            addCb.parentElement.title = '歌单投票只能从点歌平台挑歌，同学不能自己加选项';
            addCb.parentElement.style.opacity = '.5';
          }else{
            addCb.disabled = false;
            addCb.parentElement.title = '';
            addCb.parentElement.style.opacity = '';
          }
        }
        if(isSong && !pick.getAttribute('data-ready')){
          pick.setAttribute('data-ready', '1');
          voMountSongPick(pick);
          /* v3.5.27：进歌单模式先把云端时长库拉下来，挑歌时就能看到时长；
             「已选却没时长」的项会立刻在提示条里列出来。 */
          vhDurLibPull().then(function(){
            if(typeof box.__voRebuild === 'function') box.__voRebuild();
          });
        }
      };
      if(fmtSel) fmtSel.onchange = syncKind;
      kindSel.onchange = syncKind;
      syncKind();

      /* v3.5.21：歌单投票的「取前几名」与「总时长上限」二选一。
         填了总时长上限后，抽取数量由系统按歌曲时长自动凑，不需要再填数量。 */
      var voCapIn = box.querySelector('#voPickCap');
      var voNIn = box.querySelector('#voPickN');
      var voHint = box.querySelector('#voPickHint');
      function syncPickCap(){
        if(!voCapIn || !voNIn) return;
        var cap = Number(voCapIn.value || 0);
        if(cap > 0){
          voNIn.value = ''; voNIn.disabled = true; voNIn.title = '已设总时长上限，数量由系统自动决定';
          if(voHint) voHint.textContent = '已启用总时长上限：系统会按歌曲时长自动决定抽取数量，「取前几名」此时无效。';
        }else{
          voNIn.disabled = false; voNIn.title = '';
          if(voHint) voHint.textContent = '取前几名 / 总时长上限二选一：填了总时长上限，抽取数量由系统自动按歌曲时长凑，不需要再填「取前几名」。';
        }
      }
      if(voCapIn){ voCapIn.oninput = syncPickCap; syncPickCap(); }

      /* v3.5.25：改「详情里包含哪些」时，已勾选歌曲的选项要按新字段重算 ——
         否则先勾歌、后勾「歌曲时长」，时长就永远写不进选项里。 */
      ['voFldReq', 'voFldTime', 'voFldVotes', 'voFldDur'].forEach(function(id){
        var el = box.querySelector('#' + id);
        if(!el) return;
        el.onchange = function(){
          var fn = box.__voRebuild;
          if(typeof fn === 'function') fn();
        };
      });
    }
  });

  /* 校验 → 收集 → 提交。返回 false 时不关弹窗（保留用户输入） */
  function submit(){
    var title = String((document.getElementById('voTitle') || {}).value || '').trim();
    if(!title){ toast('标题不能为空', 'err'); return; }
    var lines = String((document.getElementById('voOpts') || {}).value || '')
      .split(/\n+/).map(function(x){ return x.trim(); }).filter(Boolean);
    /* 去重保序 */
    var seen = {}, options = [];
    lines.forEach(function(l){
      if(seen[l]) return;
      seen[l] = 1;
      /* v3.5.19：从歌单挑进来的选项带上结构化信息（前端折叠展示 + 时长统计用） */
      var meta = (typeof VO_PICK_META !== 'undefined') ? VO_PICK_META[l] : null;
      options.push(meta ? { label: l, songMeta: meta } : { label: l });
    });
    if(options.length < 2){ toast('至少填两个选项', 'err'); return; }
    /* 🔴 v3.5.27（站主）：「一定要获取到歌曲时长……否则无法发布投票」。
       歌单投票每个选项都得有时长 —— 缺口直接拦下，并弹出补录窗口。
       后端 parseVoteInput 也有一道同样的校验，双保险。 */
    var kindNow = (document.getElementById('voKind') || {}).value || 'normal';
    if(kindNow === 'song'){
      var miss = options.filter(function(o){
        var d = o.songMeta && Number(o.songMeta.duration);
        return !(d >= 20 && d <= 1800);
      });
      if(miss.length){
        var map = {};
        miss.forEach(function(o){
          var parts = String(o.label || '').split(' - ');
          var t = (o.songMeta && o.songMeta.title) || parts[0] || '';
          var a = (o.songMeta && o.songMeta.artist) || parts[1] || '';
          map[vhDurationKey(t, a)] = { title: t, artist: a };
        });
        Object.keys(map).forEach(function(k){ if(!DUR_MISS[k]) DUR_MISS[k] = map[k]; });
        toast('有 ' + miss.length + ' 首歌还没时长，补齐后才能发布', 'err', 4000);
        voDurManualDialog(Object.keys(map));
        return;
      }
    }
    var dl = String((document.getElementById('voDeadline') || {}).value || '').trim();
    var payload = {
      title: title,
      kind: (document.getElementById('voKind') || {}).value || 'normal',
      options: options,
      multi: !!(document.getElementById('voMulti') || {}).checked,
      /* v3.5.23：歌单投票强制不允许同学加选项（双保险，后端也会拦） */
      allowAdd: ((document.getElementById('voKind') || {}).value !== 'song')
        && !!(document.getElementById('voAllowAdd') || {}).checked,
      note: String((document.getElementById('voNote') || {}).value || ''),
      /* v3.5.12 #10：提出人（留空后端记成操作人自己） */
      proposer: String((document.getElementById('voProposer') || {}).value || '').trim(),
      deadline: dl ? new Date(dl).toISOString() : null,
      /* v3.5.14 #9：票数配额与撤回次数（留空 = 不限） */
      maxChoices: String((document.getElementById('voMaxChoices') || {}).value || '').trim() || null,
      minChoices: String((document.getElementById('voMinChoices') || {}).value || '').trim() || null,
      retractLimit: String((document.getElementById('voRetractLimit') || {}).value || '').trim(),
      endMode: (document.getElementById('voEndMode') || {}).value || 'keep',
      /* v3.19.0：是否公开（未登录可看） */
      publicRead: !!(document.getElementById('voPublic') || {}).checked,
      /* v3.5.20：提出日期可改 */
      createdDate: (document.getElementById('voCreatedDate') || {}).value || '',
      /* v3.5.19：同学新增选项限制 + 歌单取歌策略 */
      optionRule: (function(){
        var r = {};
        var ml = Number((document.getElementById('voOptMax') || {}).value || 0);
        if(ml > 0) r.maxLen = ml;
        var f = (document.getElementById('voOptFmt') || {}).value || '';
        if(f) r.format = f;
        if(f === 'date') r.precision = (document.getElementById('voOptPrec') || {}).value || 'minute';
        return (r.maxLen || r.format) ? r : null;
      })(),
      songPick: (function(){
        if((document.getElementById('voKind') || {}).value !== 'song') return null;
        var n = Number((document.getElementById('voPickN') || {}).value || 0);
        var cap = Number((document.getElementById('voPickCap') || {}).value || 0);
        /* v3.5.21：「取前几名」与「总时长上限」二选一。
           填了总时长上限时，topN 传 0（后端 normSongPick 不会输出 topN），
           系统只按 maxMinutes 控制抽取范围。 */
        return {
          topN: cap > 0 ? 0 : (n > 0 ? n : 5),
          purpose: (document.getElementById('voPickPurpose') || {}).value || 'daily',
          maxMinutes: cap > 0 ? cap : null,
        };
      })(),
    };
    if(!isNew) payload.voteId = v.id;
    var btn = document.querySelector('#modalBox [data-yes]');
    if(btn){ btn.disabled = true; btn.textContent = isNew ? '创建中…' : '保存中…'; }
    api('/votes?action=' + (isNew ? 'create' : 'update'), { method: 'POST', body: payload })
      .then(function(j){ closeModal(); toast(j.message || '已保存', 'ok'); voLoad(); })
      .catch(function(e){
        if(btn){ btn.disabled = false; btn.textContent = isNew ? '创建' : '保存'; }
        toast(e.message || String(e), 'err', 4000);
      });
  }
}

/** v3.5.19：从歌单挑进选项时记录结构化信息（label → songMeta）。
 *  为什么不用 label 反解：歌名里可能本身就含 " - "，靠字符串拆必错。 */
var VO_PICK_META = {};

function voSongFieldPrefs(){
  function ck(id, dflt){ var el = document.getElementById(id); return el ? el.checked : dflt; }
  return {
    requester: ck('voFldReq', true),
    time: ck('voFldTime', true),
    votes: ck('voFldVotes', false),
    /* v3.5.25：歌曲时长是必展示项 —— 不管勾没勾都要写进选项，否则前台没得显示 */
    duration: true,
  };
}

/** 按当前勾选拼 label + meta —— 站主：「只有我勾选了才会填入表单选项」 */
function voSongParts(s){
  var p = voSongFieldPrefs();
  var title = String(s.title || '').trim() || '(无歌名)';
  var artist = String(s.artist || '').trim();
  var req = vhReqName(s) || '匿名';
  /* ⚠️ 平台给的是 requestedAt（2026/6/6 21:44:48），不是 createdAt ——
     以前取 createdAt 全是空，点歌时间一直显示不出来。 */
  var atRaw = s.requestedAt || s.createdAt || '';
  var at = vhFmtTime(atRaw);
  var votes = (s.voteCount != null) ? Number(s.voteCount) : null;
  var dur = (s.durationSeconds != null) ? Number(s.durationSeconds) : null;

  var parts = [title, artist];
  var show = [];
  if(p.requester){ parts.push(req); show.push('requester'); }
  if(p.time && at){ parts.push(at); show.push('time'); }
  if(p.votes && votes != null){ parts.push(votes + ' 赞'); show.push('votes'); }
  if(p.duration && dur){ parts.push(voFmtDur(dur)); show.push('duration'); }

  return {
    label: parts.filter(Boolean).join(' - ').slice(0, 80),
    meta: {
      title: title, artist: artist,
      requester: req,
      requestedAt: at,
      voteCount: votes,
      duration: dur,
      show: show,
    },
  };
}

/* 兼容旧调用 */
function voSongLabel(s){ return voSongParts(s).label; }

/* 从点歌平台挑歌，勾中的追加到「选项」文本框 */
function voMountSongPick(host){
  host.innerHTML = '<div class="panel" style="padding:12px 14px">'
    + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">'
    +   '<b style="font-size:.86rem">从点歌平台挑歌</b>'
    +   '<input id="voPickQ" placeholder="搜歌名或歌手" style="flex:1;min-width:140px;max-width:260px;padding:6px 10px;font-size:.82rem">'
    +   '<button class="btn btn-sm btn-secondary" id="voPickLoad" type="button">刷新歌单</button>'
    + '</div>'
    + '<p class="muted" style="font-size:.74rem;margin:0 0 8px">'
    +   '加进去的选项格式：<b>歌名 - 歌手 - 点歌人 - 点歌时间</b>（缺哪项就跳过）'
    + '</p>'
    /* v3.5.21：批量选择按钮（站主：「这里可以一键批量选择」） */
    + '<div style="display:flex;gap:6px;flex-wrap:wrap;margin:0 0 8px">'
    +   '<button class="btn btn-sm btn-ghost" id="voPickAll" type="button">全选</button>'
    +   '<button class="btn btn-sm btn-ghost" id="voPickNone" type="button">全不选</button>'
    +   '<button class="btn btn-sm btn-ghost" id="voPickInv" type="button">反选</button>'
    + '</div>'
    + '<div id="voPickBody" class="muted" style="font-size:.8rem">点「刷新歌单」加载平台上的歌</div>'
    + '<p class="muted" style="font-size:.74rem;margin:8px 0 0">'
    +   '勾选即加入选项，取消勾选即移出 —— 不用再点「加进选项」。'
    +   '<b>选项</b>文本框与勾选列表实时同步，也可以手改。</p>'
    /* v3.5.27：时长缺口提示条（时长为空不能发布 / 不能排歌） */
    + '<div id="voDurBar" style="display:none;margin:8px 0 0"></div>'
    + '</div>';
  var body = host.querySelector('#voPickBody');
  var q = host.querySelector('#voPickQ');
  var cache = [];
  host.querySelector('#voPickLoad').onclick = function(){
    body.innerHTML = '<div class="loading"><div class="spinner"></div>加载中…</div>';
    /* 复用抽签那套取歌逻辑（分页拉全量），不新增接口 */
    vhFetchSongs().then(function(list){
      cache = list || [];
      paint();
      /* 打开编辑器时若选项里已有这几首，把勾打上（编辑旧投票不丢状态） */
      syncChecksFromOptions();
    }).catch(function(e){
      body.innerHTML = '<span style="color:var(--danger)">加载失败：' + esc(e.message || e) + '</span>';
    });
  };
  q.oninput = paint;
  /* v3.5.21：全选 / 全不选 / 反选（只影响当前筛选结果） */
  function voSetChecks(mode){
    var inps = body.querySelectorAll('input[data-song]');
    Array.prototype.forEach.call(inps, function(el){
      var want = (mode === 'inv' ? !el.checked : !!mode);
      if(want !== el.checked){ el.checked = want; applyOne(el); }
    });
  }
  host.querySelector('#voPickAll').onclick = function(){ voSetChecks(true); };
  host.querySelector('#voPickNone').onclick = function(){ voSetChecks(false); };
  host.querySelector('#voPickInv').onclick = function(){ voSetChecks('inv'); };

  /* v3.5.24：勾选即加入选项（站主：「勾选的就是选项，那我就不用再复制了」）
     · 勾上 → 把 label 追加到「选项」文本框，并记下 songMeta
     · 取消 → 从文本框里删掉这一行（手改过的行如果对不上就不动，避免误删）
     · 文本框是唯一数据源，提交时仍按行解析，所以手改照样生效 */
  function optionsLines(){
    var ta = document.getElementById('voOpts');
    return String((ta && ta.value) || '').split(/\n/).map(function(x){ return x.trim(); }).filter(Boolean);
  }
  function setOptionsLines(lines){
    var ta = document.getElementById('voOpts');
    if(ta) ta.value = lines.join('\n');
  }
  /* v3.5.25：按「当前勾选 + 当前勾选的字段」重算整份选项 ——
     这样改「详情里包含哪些」勾选后，已选歌曲的 label/songMeta 会跟着重算，
     不会因为先勾歌、后勾「歌曲时长」而漏掉时长。 */
  function rebuildFromChecks(){
    var inps = body.querySelectorAll('input[data-song]');
    var lines = [], metas = {};
    Array.prototype.forEach.call(inps, function(el){
      if(!el.checked) return;
      var song = null;
      try{ song = JSON.parse(el.getAttribute('data-song-json') || 'null'); }catch(e){}
      var label;
      if(song){
        var sp = voSongParts(song);   /* 用最新字段勾选重算 */
        label = sp.label;
        metas[label] = sp.meta;
      }else{
        label = el.getAttribute('data-song');   /* 没有原始数据就沿用旧 label */
        var mj = el.getAttribute('data-meta');
        if(mj){ try{ metas[label] = JSON.parse(mj); }catch(e){} }
      }
      if(lines.indexOf(label) < 0) lines.push(label);
    });
    /* 勾选区之外（比如编辑旧投票、手改过）的行要保留 —— 只重建勾选区的部分 */
    var inCheck = {};
    Array.prototype.forEach.call(inps, function(el){ inCheck[el.getAttribute('data-song')] = 1; });
    optionsLines().forEach(function(l){ if(!inCheck[l] && lines.indexOf(l) < 0) lines.push(l); });
    /* 同步 songMeta 表 */
    Object.keys(metas).forEach(function(k){ VO_PICK_META[k] = metas[k]; });
    setOptionsLines(lines);
    paintDurBar();
  }

  /* v3.5.27（站主）：「一定要获取到歌曲时长……否则无法发布投票或者随机排歌」。
     这里实时盘点「已勾的歌里哪些还没有时长」，缺口不为 0 就挂红条 + 补录按钮。
     时长的获取顺序：平台自带 → 云端时长库 → 网易云/QQ 音乐联网 → 人工填写。 */
  function durMissing(){
    var out = [];
    optionsLines().forEach(function(l){
      var m = VO_PICK_META[l];
      var d = m && Number(m.duration);
      if(d >= 20 && d <= 1800) return;
      /* 歌名歌手从 songMeta 取；没有就退回拆 label 的前两段 */
      var parts = String(l).split(' - ');
      out.push({ label: l, title: (m && m.title) || parts[0] || '', artist: (m && m.artist) || parts[1] || '' });
    });
    return out;
  }
  function paintDurBar(){
    var bar = document.getElementById('voDurBar');
    if(!bar) return;
    var miss = durMissing();
    if(!miss.length){
      var any = optionsLines().length;
      bar.style.display = any ? '' : 'none';
      bar.innerHTML = any
        ? '<div class="alert info" style="margin:0;font-size:.8rem">✅ 已选 ' + any + ' 首歌，时长全部齐了，可以发布。</div>'
        : '';
      return;
    }
    bar.style.display = '';
    miss.forEach(function(x){
      var k = vhDurationKey(x.title, x.artist);
      if(!DUR_MISS[k]) DUR_MISS[k] = { title: x.title, artist: x.artist };
    });
    bar.innerHTML = '<div class="alert warn" style="margin:0;font-size:.8rem;line-height:1.8">'
      + '<b style="color:#b45309">⚠️ ' + miss.length + ' 首歌还没拿到时长</b>，'
      + '<b>补齐后才能发布</b>（网易云 / QQ 音乐都没搜到，需要你手填）。'
      + '<br><span class="muted">' + miss.slice(0, 6).map(function(x){ return esc(x.title || x.label); }).join('、')
      + (miss.length > 6 ? ' 等' : '') + '</span>'
      + '<button class="btn btn-sm" id="voDurFillBtn" type="button" style="margin-left:8px">补录时长</button>'
      + '</div>';
    var b = document.getElementById('voDurFillBtn');
    if(b) b.onclick = function(){
      /* 只补这一批，请勿整个 DUR_MISS 都倒出来 */
      var only = {};
      miss.forEach(function(x){
        var k = vhDurationKey(x.title, x.artist);
        only[k] = { title: x.title, artist: x.artist };
      });
      voDurManualDialogFor(only);
    };
  }
  /* 只针对给定集合的补录（不污染全局 DUR_MISS 的显示） */
  function voDurManualDialogFor(map){
    var keep = DUR_MISS;
    var sub = {};
    Object.keys(map).forEach(function(k){ if(!keep[k]) sub[k] = map[k]; });
    var restore = {};
    Object.keys(sub).forEach(function(k){ restore[k] = keep[k]; keep[k] = sub[k]; });
    voDurManualDialog(Object.keys(map));
    /* 弹窗已经拿到 keys 快照，恢复全局映射（未填的仍留在 DUR_MISS 里） */
    Object.keys(sub).forEach(function(k){ delete keep[k]; });
    Object.keys(restore).forEach(function(k){ if(restore[k]) keep[k] = restore[k]; });
  }
  function applyOne(el){
    rebuildFromChecks();
    if(el.checked){
      var mj = el.getAttribute('data-meta');
      var lab = el.getAttribute('data-song');
      if(mj && lab && !VO_PICK_META[lab]){ try{ VO_PICK_META[lab] = JSON.parse(mj); }catch(e){} }
    }
  }
  body.addEventListener('change', function(ev){
    var el = ev.target;
    if(el && el.matches && el.matches('input[data-song]')) applyOne(el);
  });
  /* 用选项里现有的行反推勾选状态（编辑旧投票 / 手动粘贴过选项时） */
  function syncChecksFromOptions(){
    var lines = optionsLines();
    var hit = {};
    lines.forEach(function(l){ hit[l] = 1; });
    Array.prototype.forEach.call(body.querySelectorAll('input[data-song]'), function(el){
      el.checked = !!hit[el.getAttribute('data-song')];
    });
    /* 编辑旧投票时，把选项里存的 songMeta 也恢复过来（否则重算会丢掉已有字段） */
    var vo = VO.list.filter(function(x){ return x.id === (window.__voEditingId || -1); })[0];
    if(vo && vo.options){
      vo.options.forEach(function(o){
        if(o.songMeta && o.label) VO_PICK_META[o.label] = o.songMeta;
      });
    }
  }
  /* 暴露给 onMount 里的字段勾选处理器 */
  var modalBox = host.closest('.modal') || document;
  modalBox.__voRebuild = rebuildFromChecks;
  window.__voRebuildSongOptions = rebuildFromChecks;
  function paint(){
    var kw = String(q.value || '').trim().toLowerCase();
    var rows = cache.filter(function(s){
      if(!kw) return true;
      return (String(s.title || '') + ' ' + String(s.artist || '')).toLowerCase().indexOf(kw) >= 0;
    }).slice(0, 60);
    if(!rows.length){ body.innerHTML = '<span>没有匹配的歌</span>'; return; }
    /* v3.5.24：勾选状态跟着「选项」文本框走 —— 重新渲染（搜索/刷新）也不丢勾。
       列表右侧那串小字只是给你挑歌时参考，前台不会原样展示：
       前台只显示「歌名 - 歌手」，其余（点歌人 / 点歌时间 / 赞数 / 时长）点「详情」才展开。 */
    var curLines = optionsLines();
    var lineHit = {};
    curLines.forEach(function(l){ lineHit[l] = 1; });
    body.innerHTML = '<div style="max-height:240px;overflow:auto;display:grid;gap:2px">'
      + rows.map(function(s){
          var name = String(s.title || '').trim();
          var sp = voSongParts(s);
          var label = sp.label;
          var req = vhReqName(s) || '匿名';
          var when = vhFmtTime(s.requestedAt || s.createdAt);
          var durTxt = voFmtDur(s.durationSeconds);
          return '<label style="display:flex;align-items:center;gap:8px;padding:3px 2px;cursor:pointer">'
            + '<input type="checkbox" data-song="' + attr(label) + '" data-meta="' + attr(JSON.stringify(sp.meta)) + '"'
            +   ' data-song-json="' + attr(JSON.stringify({
                  title: s.title || '', artist: s.artist || '',
                  requester: s.requester || '', requestedAt: s.requestedAt || s.createdAt || '',
                  voteCount: (s.voteCount != null ? s.voteCount : null),
                  durationSeconds: (s.durationSeconds != null ? s.durationSeconds : null),
                })) + '"'
            +   (lineHit[label] ? ' checked' : '') + '>'
            + '<span style="font-size:.82rem;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
            +   esc(name) + (s.artist ? '<i class="muted" style="font-style:normal"> · ' + esc(s.artist) + '</i>' : '')
            + '</span>'
            + '<span class="muted" style="font-size:.72rem;margin-left:auto;white-space:nowrap">'
            +   esc(req) + (when ? ' · ' + esc(when) : '')
            +   (s.voteCount != null ? ' · ' + Number(s.voteCount) + ' 赞' : '')
            /* v3.5.27：没时长的标红 —— 这首歌勾进去也发不了投票，得先补录 */
            +   (durTxt ? ' · ' + durTxt : ' · <b style="color:#b45309">缺时长</b>')
            + '</span>'
            + '</label>';
        }).join('')
      + '</div>';
  }
}

/* v3.6.4（站主 #6）：版本记录不再单独占一页，作为「数据管理」的下半部分。
   拆成 html + mount 两半，两个入口都能用同一套逻辑。 */

/* v4.7.1：大屏启动器（.bat）。
   站主原话：「创建快捷方式在 d 盘的功能无效，它上面显示没有 program 文件，
                  但实际是有这个文件夹的，我怀疑希沃限制了创建 c 盘文件的快捷方式。」
   排查结论：Windows 快捷方式（.lnk）里存的是一整条**绝对路径**，一旦目标浏览器
   不在那个位置（希沃常见情形：装在 D 盘、或者是 Edge 不是 Chrome、或者被还原卡
   重定向），双击就报「找不到 program 文件」。这不是权限问题，是路径写死了。
   所以改成发一个 .bat：它自己按常见位置挨个找 Chrome / Edge，
   都找不到就用系统默认浏览器打开，永远不会「找不到 program 文件」。
   而且 .bat 可以放在 D 盘任意位置，不受 C 盘写入限制。 */
/* v4.7.10（站主）：「我试了一下这个启大屏的脚本，黑框点一下就没了，我加的 pause 也一样。」
   原因有两条：
   1) 旧脚本跑完就是 endlocal 直接结束，正常也会「闪一下」——不给任何反馈，
      站主没法判断到底起没起来；
   2) 旧脚本用 for 循环 + 含括号的变量（%ProgramFiles(x86)%）拼候选路径，
      cmd 解析括号时容易崩；一旦崩在 for 那一行，整个脚本立刻退出，
      加 pause 也到不了。
   所以改成：不用 for、逐个 if exist 平铺；成功停 8 秒、失败停住并打印日志；
   全过程写进同目录「启动日志.txt」，出问题一眼能看出卡在哪。 */
function launchBatText(){
  var url = 'https://yuzikaaang.github.io/class-site/index.html?big=1';
  var L = [
    '@echo off',
    'chcp 65001 >nul',
    'rem ============================================================',
    'rem  25-05 class station : big screen launcher  v4.7.10',
    'rem  Do NOT save this file as "UTF-8 with BOM" - cmd will choke on',
    'rem  the hidden chars before @echo off, and the window just flashes.',
    'rem  No "for" loop and no parenthesised blocks on purpose:',
    'rem  "Program Files (x86)" + brackets is what breaks parsing.',
    'rem ============================================================',
    'setlocal EnableExtensions DisableDelayedExpansion',
    'title ClassSite Big Screen',
    'color 0F',
    '',
    'rem  quiet = called from the no-console launcher (.vbs):',
    'rem  no printing, no waiting, exit code tells the caller what happened.',
    'rem  0 = ok, 1 = failed, 2 = opened with the default browser.',
    'set "QUIET="',
    'if /i "%~1"=="quiet" set "QUIET=1"',
    '',
    'set "DIR=%~dp0"',
    'set "URL=' + url + '"',
    'set "LOG=%DIR%启动日志.txt"',
    'set "PROFILE="',
    'set "EXE="',
    'set "LEAF="',
    '',
    'echo. > "%LOG%" 2>nul',
    '',
    'echo.',
    'echo   ==================================',
    'echo     25-05 ClassSite - Big Screen',
    'echo   ==================================',
    'echo.',
    '',
    'call :log "===== %date% %time% ====="',
    'call :log "DIR=%DIR%"',
    '',
    'rem ---------- 1. profile ----------',
    'set "PROFILE=%DIR%profile"',
    'if exist "%PROFILE%\\" goto :profile_ok',
    'mkdir "%PROFILE%" 2>nul',
    'if exist "%PROFILE%\\" goto :profile_ok',
    'call :log "!! script folder not writable, fallback to LOCALAPPDATA"',
    'set "PROFILE=%LocalAppData%\\ClassSiteProfile"',
    'if exist "%PROFILE%\\" goto :profile_ok',
    'mkdir "%PROFILE%" 2>nul',
    'if exist "%PROFILE%\\" goto :profile_ok',
    'goto :no_profile',
    '',
    ':profile_ok',
    'echo   [OK] profile: %PROFILE%',
    'call :log "profile=%PROFILE%"',
    '',
    'rem ---------- 2. find browser ----------',
    'if exist "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" goto :b_chrome1',
    'if exist "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe" goto :b_chrome2',
    'if exist "%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe" goto :b_chrome3',
    'if exist "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe" goto :b_edge1',
    'if exist "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe" goto :b_edge2',
    'if exist "%LocalAppData%\\Microsoft\\Edge\\Application\\msedge.exe" goto :b_edge3',
    'if exist "%ProgramFiles(x86)%\\360Chrome\\Chrome\\Application\\360chrome.exe" goto :b_360a',
    'if exist "%ProgramFiles%\\360Chrome\\Chrome\\Application\\360chrome.exe" goto :b_360b',
    'goto :no_browser',
    '',
    ':b_chrome1',
    'set "EXE=%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe"',
    'set "LEAF=chrome.exe"',
    'goto :launch',
    ':b_chrome2',
    'set "EXE=%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe"',
    'set "LEAF=chrome.exe"',
    'goto :launch',
    ':b_chrome3',
    'set "EXE=%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe"',
    'set "LEAF=chrome.exe"',
    'goto :launch',
    ':b_edge1',
    'set "EXE=%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'set "LEAF=msedge.exe"',
    'goto :launch',
    ':b_edge2',
    'set "EXE=%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'set "LEAF=msedge.exe"',
    'goto :launch',
    ':b_edge3',
    'set "EXE=%LocalAppData%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'set "LEAF=msedge.exe"',
    'goto :launch',
    ':b_360a',
    'set "EXE=%ProgramFiles(x86)%\\360Chrome\\Chrome\\Application\\360chrome.exe"',
    'set "LEAF=360chrome.exe"',
    'goto :launch',
    ':b_360b',
    'set "EXE=%ProgramFiles%\\360Chrome\\Chrome\\Application\\360chrome.exe"',
    'set "LEAF=360chrome.exe"',
    'goto :launch',
    '',
    'rem ---------- 3. launch ----------',
    ':launch',
    'echo   [OK] browser: %EXE%',
    'call :log "browser=%EXE%"',
    '',
    'rem  v4.10.2: back to --start-maximized.',
    'rem  v4.10.0 had switched this to --start-fullscreen, but then the in-page',
    'rem  fullscreen toggle could not leave fullscreen, and the station got stuck',
    'rem  in a state nobody could get out of. Maximized keeps the title bar and',
    'rem  task bar, so Esc / F11 / the page toggle all still work.',
    'start "" "%EXE%" --app="%URL%" --user-data-dir="%PROFILE%" --start-maximized --window-size=1920,1080 --no-first-run --no-default-browser-check --disable-features=Translate,msEdgeSidebar',
    'call :log "start sent, waiting 4s to verify the process"',
    '',
    'rem  hidden window has no console input, so use ping instead of timeout',
    'if defined QUIET ping -n 5 127.0.0.1 >nul',
    'if not defined QUIET timeout /t 4 /nobreak >nul',
    'tasklist /fi "imagename eq %LEAF%" 2>nul | find /i "%LEAF%" >nul',
    'if errorlevel 1 goto :died',
    '',
    'if defined QUIET goto :ok_quiet',
    '',
    'echo.',
    'echo   [OK] Big screen launched.',
    'echo   This window closes in 8 seconds. Log: 启动日志.txt',
    'call :log "result=ok"',
    'timeout /t 8 >nul',
    'endlocal',
    'exit /b 0',
    '',
    ':ok_quiet',
    'call :log "result=ok"',
    'endlocal',
    'exit /b 0',
    '',
    ':no_profile',
    'echo   [FAIL] cannot create the profile folder. Copy the whole folder to drive D and retry.',
    'call :log "result=fail: no profile"',
    'goto :hold',
    '',
    ':no_browser',
    'echo   [!!] Chrome / Edge / 360 not found. Opening with the default browser.',
    'call :log "no browser found, use default"',
    'start "" "%URL%"',
    'if defined QUIET ping -n 4 127.0.0.1 >nul',
    'if not defined QUIET timeout /t 3 /nobreak >nul',
    'call :log "result=default browser"',
    'if defined QUIET exit /b 2',
    'goto :hold',
    '',
    ':died',
    'echo   [FAIL] the browser started then exited at once.',
    'echo   Most likely the profile folder holds a broken config.',
    'echo   Rename profile to profile-old and run this script again.',
    'call :log "result=fail: browser exited"',
    'goto :hold',
    '',
    ':hold',
    'if defined QUIET exit /b 1',
    'echo.',
    'echo   ---------- log ----------',
    'if exist "%LOG%" type "%LOG%"',
    'echo   -------------------------',
    'echo   Send this log to the site owner.',
    'pause',
    'endlocal',
    'exit /b 1',
    '',
    ':log',
    '>>"%LOG%" echo   %~1 2>nul',
    'goto :eof',
    ''
  ];
  return L.join('\r\n');
}

function siteLaunchDownload(){
  try{
    var blob = new Blob([launchBatText()], { type: 'application/octet-stream' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'bigscreen-launcher.bat';
    document.body.appendChild(a);
    a.click();
    setTimeout(function(){
      try{ URL.revokeObjectURL(a.href); }catch(e){}
      try{ a.remove(); }catch(e){}
    }, 1200);
    if(typeof toast === 'function'){
      toast('已下载启动器。若浏览器提示「不常见的文件」，选「保留」即可');
    }
  }catch(e){
    if(typeof toast === 'function') toast('下载失败，请更换浏览器后重试', true);
  }
}

/* v4.6.0：站点资源下载 + 轻量模式开关。
   站主原话：「后台新增下载班徽图标和站点图标，方便创建快捷方式时换图标。」
   班徽给 PNG（做快捷方式图标更通用），站点图标给 ICO（Windows 快捷方式首选）。 */
function siteAssetsHtml(){
  var liteOn = false;
  try { liteOn = localStorage.getItem('cls_lite_mode') === '1'; } catch(e){}
  return '<div class="toolbar" style="background:var(--panel);margin-top:18px">'
    +   '<div style="flex:1;min-width:0"><b style="font-size:.92rem">站点资源</b>'
    +     '<p class="muted" style="margin:4px 0 0;font-size:.8rem">'
    +       '创建桌面快捷方式后，可右键「属性 → 更改图标」换成下载的图标</p></div>'
    +   '<a class="btn btn-sm btn-secondary" href="./badge.png" download="班徽.png">' + svg('download',14) + ' 下载班徽</a>'
    +   '<a class="btn btn-sm btn-secondary" href="./favicon.ico" download="favicon.ico">' + svg('download',14) + ' 下载站点图标</a>'
    +   '<button class="btn btn-sm btn-secondary" onclick="siteLaunchDownload()"'
    +     ' title="一个 .bat，双击直接进大屏，不依赖浏览器安装路径">' + svg('download',14) + ' 下载大屏启动器</button>'
    + '</div>'
    + '<section class="panel" style="margin-bottom:18px">'
    +   '<b style="font-size:.9rem">班级电脑：怎么做到「双击就进大屏」</b>'
    +   '<p class="muted" style="margin:6px 0 0;font-size:.82rem;line-height:1.75">'
    +     '1. 下载上面的<b>大屏启动器</b>，放到 D 盘任意文件夹（不用管理员权限，也不写 C 盘）。<br>'
    +     '2. 右键这个 .bat →「发送到 → 桌面快捷方式」，再右键快捷方式「属性 → 更改图标」选上面下载的 .ico。<br>'
    +     '3. 双击快捷方式即可，浏览器窗口直接是「应用窗口」模式（没有地址栏和标签页）。<br>'
    +     '<span style="opacity:.8">为什么不推荐手写 .lnk：快捷方式里存的是浏览器 .exe 的绝对路径，'
    +     '浏览器换位置、或被还原卡重定向，就会报「找不到 program 文件」。启动器是自己去找浏览器，不会有这个问题。</span>'
    +   '</p>'
    + '</section>'
    + '<section class="panel" style="margin-bottom:18px"><div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">'
    +   '<div style="flex:1;min-width:220px"><b style="font-size:.9rem">轻量模式</b>'
    +     '<p class="muted" style="margin:4px 0 0;font-size:.8rem">'
    +       '关闭实时模糊、背景辉光与装饰动画；抽取动画仍完整播放，仅画质略降。'
    +       '低性能设备（如教室触屏一体机）建议开启，可明显改善输入与滚动。</p></div>'
    +   '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;white-space:nowrap;flex:none">'
    +     '<input type="checkbox" id="liteToggle"' + (liteOn ? ' checked' : '') + '>'
    +     '<span style="font-size:.85rem">开启</span></label>'
    + '</div></section>';
}

function releasesBlockHtml(){
  return siteAssetsHtml()
    + '<div class="toolbar" style="background:var(--panel);margin-top:18px">'
    +   '<div style="flex:1;min-width:0"><b style="font-size:.92rem">版本更新记录</b>'
    +     '<p class="muted" style="margin:4px 0 0;font-size:.8rem">'
    +       '部署前必须在这里有一条对应版本的记录，否则不允许部署</p></div>'
    +   '<div class="search" style="flex:0 1 240px;min-width:160px">' + svg('search')
    +     '<input id="relSearch" placeholder="搜索版本号 / 标题 / 条目…" maxlength="40">'
    +   '</div>'
    +   '<button class="btn btn-sm btn-secondary" id="relRefresh">' + svg('refresh',14) + ' 刷新</button>'
    +   '<button class="btn btn-sm btn-secondary" id="relSync">' + svg('download',14) + ' 补齐缺失版本</button>'
    +   '<button class="btn btn-sm" id="relAdd">' + svg('plus',14) + ' 新增版本</button>'
    + '</div>'
    + '<div class="alert warn" style="margin-bottom:16px;display:none" id="relMissBox"></div>'
    + '<section class="panel"><div id="relBody"><div class="loading"><div class="spinner"></div>加载中…</div></div></section>';
}

function mountReleasesBlock(){
  if($('relRefresh')) $('relRefresh').onclick = loadReleases;
  if($('relAdd')) $('relAdd').onclick = function(){ relEdit(null); };
  if($('relSync')) $('relSync').onclick = relSyncMissing;
  if($('relSearch')){
    $('relSearch').value = REL_STATE.q || '';
    $('relSearch').oninput = debounce(function(e){
      REL_STATE.q = e.target.value.trim();
      paintReleases();
    }, 220);
  }
  if($('liteToggle')) $('liteToggle').onchange = function(){
    var on = this.checked;
    try { localStorage.setItem('cls_lite_mode', on ? '1' : '0'); } catch(e){}
    if(on) document.documentElement.setAttribute('data-lite','1');
    else document.documentElement.removeAttribute('data-lite');
  };
  loadReleases();
}

function renderReleases(){
  /* 入口已并入「数据管理」，这里保留给旧链接 / 深链兜底 */
  $('view').innerHTML = releasesBlockHtml();
  mountReleasesBlock();
}

function loadReleases(){
  api('/content').then(function(j){
    var v = (j && j.items && j.items.release_notes) || [];
    REL_STATE.list = Array.isArray(v) ? v : [];
    relSort();
    paintReleases();
  }).catch(function(e){
    var b = $('relBody');
    if(b) b.innerHTML = '<div class="empty">' + svg('alert', 34) + '<p>加载失败：' + esc(e.message) + '</p></div>';
  });
}

/* ============================================================================
 * v3.5.30：内置版本清单 + 「补齐缺失版本」
 * ----------------------------------------------------------------------------
 * 站主原话：「云端版本数据又有几次没更新了。」
 *
 * 根因不是存不住，而是**每次改完代码没人去后台补一条**。云端数据本身没问题
 * （PUT 写完就在），漏的是「写」这个动作。
 *
 * 这份清单是代码里随版本走的，版本号天然与 SITE_VERSION 同步；
 * 点「补齐缺失版本」时：
 *   ① 读云端已有记录，收集已有版本号集合
 *   ② 遍历这份清单，只挑**云端没有的**版本号追加
 *   ③ 已有的绝不覆盖 —— 站主自己补充过的细节不会被机器文案冲掉
 * 这样以后就算忘了手动加，进来点击就能把缺的补齐。
 * ⚠️ 加新版本时：在这里追加一条，同时在 index.html/admin.html 升 SITE_VERSION。
 * ========================================================================= */
var REL_BUILTIN = [
  { version: '4.10.18', date: '2026-11-08', type: 'feat', title: '快捷作业卡移到作业卡上方、日期条回今天回到当天', items: [
      '大屏作业页的「新增作业」科目按钮不再贴在底部，改排到作业卡上方',
      '日期条「回今天」改为回到当天，不再落到那一期作业的第一天',
      '普通模式作业查看的日期条同步修正回今天逻辑'
    ], pub: [
      { cat: '作业', text: '新增作业的科目按钮移到作业卡上方' },
      { cat: '作业', text: '日期条回今天回到当天' }
    ] },
  { version: '4.10.17', date: '2026-11-08', type: 'feat', title: '两栏等宽、考试卡保持原宽、日期栏可收起', items: [
      '大屏作业卡片两栏由 1/3 与 2/3 改为各占 1/2，卡片仍按渲染后是否折行自动分栏',
      '考试卡片宽度维持原值，与右栏之间留出的空白予以保留',
      '底部日期条新增收起按钮，收起后整条不占位，底部工具条的日期开关可随时展开',
      '日期条收起状态仅存本机，刷新后保持上次选择'
    ], pub: [
      { cat: '作业', text: '作业卡片两栏改为等宽显示' },
      { cat: '作业', text: '考试卡片尺寸保持不变' },
      { cat: '界面', text: '底部日期栏支持收起' }
    ] },
  { version: '4.10.16', date: '2026-11-08', type: 'feat', title: '每项截止时间、日历跳转、历史拦截、普通模式新增作业', items: [
      '每个作业小项右侧都有时钟按钮，可设精确到分钟的截止时间；过期的默认收起，编辑态可见',
      '底部日期条与整月日历可跳到任意一周，点 11/14 自动落到第11周周末作业',
      '导出图片的作业项后面带上截止时间（灰字），已截止的也照常导出',
      '改已结束的那一周作业，进编辑前先弹窗拦截确认',
      '普通模式作业查看里管理员可新增作业，日历合进同一个弹窗',
      '全屏时钟的小当前时间移至「返回」旁边'
    ], pub: [
      { cat: '作业', text: '每个作业项可设截止时间' },
      { cat: '作业', text: '过期作业默认收起' },
      { cat: '作业', text: '底部日期条可跳转前后周次' },
      { cat: '作业', text: '导出图片带上截止时间' },
      { cat: '作业', text: '修改历史作业先弹窗拦截' },
      { cat: '作业', text: '普通模式也能新增作业' },
      { cat: '界面', text: '全屏时钟小时间移至返回旁' }
    ] },
  { version: '4.10.15', date: '2026-11-08', type: 'feat', title: '作业期次按学期自动按周生成', items: [
      '周次从学期开始日所在的那一周周一算起，周作业周一 ~ 周五、周末作业周六 ~ 周日',
      '期次名带学期前缀，如「高二上 · 第11周作业」「高二上 · 第11周周末作业」',
      '自动生成的期次改了内容才落库，空壳不保存',
      '顶栏「新建一期」换成「设置」，可以调这一周的起止；改到周六，周末作业自动只剩周日',
      '底部新增七个科目按钮（语数英物化生 + 其他），点击即可在这一期建卡，已加的置灰'
    ], pub: [
      { cat: '作业', text: '作业按周自动生成，省去新建期次' },
      { cat: '作业', text: '底部七个科目按钮，点击建卡' }
    ] },
  { version: '4.10.14', date: '2026-11-08', type: 'style', title: '全屏时钟垂直居中，不再偏上', items: [
      '数字 / 翻页 / 计时三种页面都按整屏垂直居中，上下留白对称',
      '横屏原来把内容硬抬了 13vh，改成与顶部一致的固定留白',
      '手机竖屏同步调整，计时器正好落在屏幕正中'
    ], pub: [
      { cat: '界面', text: '全屏时钟三种页面都垂直居中' }
    ] },
  { version: '4.10.13', date: '2026-11-08', type: 'fix', title: '全屏时钟与计时分开显示，计时页面右上角显示当前时间', items: [
      '点「数字」或「翻页」时才显示大时钟',
      '选正计时 / 倒计时 / 番茄钟时只显示计时器',
      '计时页面右上角新增一枚小的当前时间，每秒跟着走',
      '时钟页面按空格自动切到计时并开始',
      '极简模式的数字回到屏幕正中',
      '窄屏下五个子标签挪到第二行，不被按钮压住'
    ], pub: [
      { cat: '界面', text: '全屏时钟与计时分开显示，一次一块' },
      { cat: '界面', text: '计时页面右上角显示当前时间，每秒走' }
    ] },
  { version: '4.10.12', date: '2026-11-08', type: 'fix', title: '大屏今日事项的剩余时间也按本机时间实时走', items: [
      '大屏侧栏「今日事项」里的「还剩 X 小时 Y 分」改成本机时间每秒重算',
      '与上班的倒计时共用同一个 1 秒定时器，不额外起轮询'
    ], pub: [
      { cat: '修复', text: '大屏今日事项的剩余时间按本机时间实时走' }
    ] },
  { version: '4.10.11', date: '2026-11-08', type: 'fix', title: '倒计时按本机时间实时走，导出图配图归位，作业卡片按 1/3 与 2/3 分栏', items: [
      '大屏「倒计时」与班级岛「放假倒计时」改成每秒按本机时间重算，分钟一变就更新，不再等整块重绘',
      '只改数字不重建结构，页面不会因为倒计时每秒走而闪一下',
      '作业导出图：每条作业项自己的配图紧跟在那一项下面，通栏等比显示，不再被统一堆到科目末尾',
      '导出图的图片按原始比例缩放，不再被压扁',
      '大屏作业页两栏改成左 1/3、右 2/3；短文本的科目进窄栏，长文本的科目进宽栏',
      '栏内卡片改按科目顺序排，内容改动时不会跳位置',
      '倒计时最后一分钟改说「不到 1 分钟」，不再显示「0 分钟」'
    ], pub: [
      { cat: '修复', text: '倒计时按本机时间实时走，分钟一变即更新' },
      { cat: '修复', text: '作业导出图里的配图回到对应那一项下面' },
      { cat: '界面', text: '作业看板两栏改为左窄右宽，短科目占窄栏' }
    ] },
  { version: '4.10.10', date: '2026-11-08', type: 'feat', title: '考试看板按时间段筛选与折叠，作业看板按考试群展示', items: [
      '考试看板顶栏新增时段筛选：本周、下周、本月、下月、本学期、全部；默认停在本周，本周没有考试会自动跳到最近的一场',
      '列表改为按考试折叠，收起时只显示考试名、日期范围与场次数，点箭头展开每天每科；大考跨几天也只占一个条目',
      '挑选分四级：整场考试、某一天、单独一科；顶栏右侧另有跟随档位的批量按钮，选「下周」就是加下周全部',
      '作业看板的考试块按「考试名 → 日期周几 → 科目时间」三层排，跨天大考归在同一个块里',
      '考试块字号跟随作业的字号调节，科目与时间改用与作业正文一致的亮色；昨天及更早压暗，前天起自动隐藏并让后面的场次补位',
      '手动挑选与今天自动出现的场次合并去重，同一场只显示一次；一次最多 6 科，超出部分等前面的考完自动补上',
      '弹窗与后台都可手动刷新，打开时先读本机缓存再回源；断网时仍可查看上一次的考试数据',
      '同步回源改为带 ETag 的条件请求，未变化时省掉整包下载；30 秒内重复刷新只向上游问一次'
    ], pub: [
      { cat: '界面', text: '考试看板可按本周、下周、本月等时段筛选' },
      { cat: '界面', text: '每场考试默认收起，点箭头展开每天每科' },
      { cat: '界面', text: '作业看板的考试块按考试名、日期、科目排列' },
      { cat: '修复', text: '考试安排可手动刷新，断网也能查看已有的数据' }
    ] },
  { version: '4.10.9', date: '2026-11-08', type: 'fix', title: '修复考试看板弹窗与点名名单标签背景透明、文字叠在底层作业上', items: [
      '考试看板弹窗用的是并未定义的底色变量，面板整体透明，底下的作业文字会透上来叠在一起；改为实色底并补一圈描边',
      '随机点名「查看名单」里每项的小标签同属一个问题，一并修正',
      '弹窗内按日期分组的标题原来渐变到透明，向下滚动会透出后面的内容；改为实色并加一道细投影'
    ], pub: [
      { cat: '修复', text: '考试看板与点名名单的弹窗底色正常，文字清晰可读' }
    ] },
  { version: '4.10.8', date: '2026-11-08', type: 'feat', title: '考试看板改为只读接入：一键查看全部考试、按需挑进作业看板；大屏作业页仅管理员可进；新增高中天数；下线四个废弃板块', items: [
      '「新增考试」改为「考试看板」：点击后列出考试看板上排好的全部场次，按日期分组，每行显示科目、起止时间与考试名称',
      '每行右侧一个加号，点击即可把这一场放到大屏作业看板，再点一次移出；挑选结果存在云端，换设备同样生效',
      '今天本来就会自动出现的场次标记为「已显示」，无需重复挑选；跨天的大型考试依然把每一天都列出来',
      '弹窗右上角新增「前往考试看板」，改考试仍到 examboard 操作；站内不再向上游写入任何数据',
      '大屏作业看板仅管理员可进：同学可以使用大屏模式，但点击作业卡会提示权限不足，卡片上也标注「仅管理员」',
      '大屏右下角学期卡新增「已步入高中 N 天」，排在本学期已开学之上',
      '后台「考试同步」改为只读：仅需填写看板地址与显示班级，不再保存账号密码；同步与挑选都在这一页完成',
      '下线长期不用的板块：学习资料（课堂笔记 / 教学课件）、私人云盘、排行榜、屏幕批注，连同学习资料访问提示弹窗一并删除'
    ], pub: [
      { cat: '学习', text: '大屏作业页可直接看到今天的考试安排' },
      { cat: '资料', text: '考试看板一键查看，可按需挑进作业看板' },
      { cat: '界面', text: '首页精简，下线已停用的板块' }
    ] },
  { version: '4.10.7', date: '2026-11-08', type: 'fix', title: '考试写回更稳：新增的临时考试带上创建者，班级管理员账号也能正常保存', items: [
      '新增考试时会顺带记下是哪个账号建的，写回考试看板后不会被对方的权限清洗掉（用班级管理员账号时更容易遇上这个问题）',
      '没有填账号也不影响：先存本机，等填好账号再点「写回考试看板」',
      '同步 / 写回 / 新增三个动作的操作记录都会写进本站操作日志，出了问题能查到是谁在什么时候改的'
    ], pub: [
      { cat: '学习', text: '大屏作业页可直接看到今天的考试安排' },
      { cat: '资料', text: '考试安排可一键同步，也能在站内补录' },
      { cat: '界面', text: '点名下方新增考试入口，跨天考试按天列出' }
    ] },
  { version: '4.10.6', date: '2026-11-08', type: 'feat', title: '接入考试看板：大屏作业页显示今日与跨天考试、点名下方可新增考试、后台一键同步并写回', items: [
      '大屏作业页左栏最上面新增考试块：今天有考试时一行一场，左边科目、右边起止时间；遇到跨天的大型考试，把每一天都列出来，已经过去的那天会压暗',
      '随机点名下方新增「新增考试」小按钮（仅管理员可见）：填科目、日期与起止时间，保存后同时在考试看板里建一场临时考试',
      '后台新增「考试同步」页：填好看板地址与管理员账号后可一键同步整份考试数据到本站，也可以在这里新增考试并写回；密码加密存放，不写进网页代码',
      '同步来的考试数据单独存放，不占数据库额度；教室断网时大屏仍显示上一次同步的安排',
      '写回采用「整份考试列表 + 版本号校验」：两边同时改动时会提示先同步，不会把对方刚改的考试覆盖掉'
    ], pub: [
      { cat: '学习', text: '大屏作业页可直接看到今天的考试安排' },
      { cat: '资料', text: '考试安排可一键同步，也能在站内补录' },
      { cat: '界面', text: '点名下方新增考试入口，跨天考试按天列出' }
    ] },
  { version: '4.10.5', date: '2026-11-07', type: 'feat', title: '放假天数两头都按实际算、随机点名可查看名单、成绩与点名数据离线可看、时钟改版、微信下载/导出兜底、省数据库', items: [
      '放假天数更准：中午 12 点以后才开始放的假，开始当天不算；早上就返校的那天也不算，当天正常显示今日事项（6 号 22:00 放到 8 号 8:00 返校 = 只算 7 号一天）',
      '随机点名「按条件可抽 N 人」旁边新增「查看」，点击后可列出该范围内的人员名单，附学号与当前条件下的分数或名次',
      '随机点名的名单、学号、考试列表、每场成绩都会存到本机，断网时照样能按条件抽人；成绩分析新增「缓存离线」按钮，有网时先执行一次，之后的考试都能离线查看',
      '全民时钟改版：打开默认是时钟界面；时钟和计时并排放在最顶上（左时钟、右计时，中间隔四个字宽）；背景色会记住上次的选择；翻页时钟的字号单独调，不再跟着数字时钟那档走',
      '微信里不能直接下载的问题：文件中转站改成提示「在浏览器打开」并给复制链接；成绩与作业的照片导出改成把图铺出来、长按保存',
      '文件中转站单件上限 15MB 提到 24MB（改成二进制直传，不再走 base64），保存天数可自己设 1~15 天，取用次数可设 1~50 次或不限',
      '省数据库：内容读取加 60 秒缓存、页面同步从 1 分钟放宽到 3 分钟、在线心跳从 1 分钟放宽到 6 分钟，前台挂着不动时对数据库的请求量降到原来的五分之一左右'
    ], pub: [
      { cat: '学习', text: '随机点名可查看当前范围里的名单' },
      { cat: '修复', text: '放假天数开始日与返校日都按实际时间算' },
      { cat: '界面', text: '时钟与计时并排放在顶部，背景与字号会记住' }
    ] },
  { version: '4.10.4', date: '2026-11-07', type: 'fix', title: '班级岛设置不再被重置、放假天数按实际算、大屏新增学期与高考进度卡、更新弹窗不打断看内容', items: [
      '班级岛的「在首页显示班级岛」和「今日事项照片」不会再莫名被清空：以前只要改完立刻切到别的板块，后台就会把空值写回云端，现在只在页面上真的有这个控件时才覆盖',
      '放假天数按实际算：中午 12 点以后才开始放的假，当天不算第一天（例如 6 号晚 10 点放到 8 号 18:40，算 2 天，7 号才是第一天）',
      '班级岛新增「学期结束」和「高一入学日」两个输入，填完之后班级岛右下角会显示学期倒计时',
      '大屏作业页右下角新增一张卡：本学期已开学多少天、本学期还剩多少天、距 2028 年高考还剩多少天，下面是高中总进度条和百分比',
      '从分享链接或二维码直接进到某个卡片时，不再弹更新提示打断阅读（版本还在 3.x 以前的老站除外）；更新完也会留在原来那一页，不再被甩回首页'
    ], pub: [
      { cat: '修复', text: '班级岛开关与照片会正常保留' },
      { cat: '界面', text: '大屏右下角新增学期与高考进度卡' },
      { cat: '修复', text: '放假天数按实际时间计算，中午后放假当天不计' }
    ] },
  { version: '4.10.3', date: '2026-11-07', type: 'fix', title: '返回首页不再回到登录界面、作业编辑显示重复、字号刻度重新标定、公告时间修正', items: [
      '从管理页点「返回前台」现在一定回到班级站首页：不会再先弹回登录界面、也不会自动登录后又回到管理页；断网或服务器临时异常时登录状态会保留，并提供「重试进入」按钮，不用关掉整个页面重开',
      '作业看板点「编辑」后卡片不再出现两层彩色边框（底下还多出一层），点「完成」能真正恢复成原来的只读样子',
      '大屏作业字号刻度重新标定：滑块显示 100 时就是原来 150 档的样子，标题与功能栏字号保持不变',
      '公告时间改为真实发布时间，不再出现「还没到的日期 + 12:00」这种显示',
      '同一批次的更新只发一条公告，小版本更新并入同一条，不再首页出现多条重复公告'
    ], pub: [
      { cat: '界面', text: '作业字号刻度重新标定，滑块显示 100 时即为标准大小' },
      { cat: '修复', text: '作业编辑时卡片显示重复，退出编辑后恢复正常显示' }
    ] },
  { version: '4.10.2', date: '2026-11-08', type: 'feat', title: '作业字号以 150 为基准、随机点名加配额权重、版本更新弹窗与进度条', items: [
      '大屏作业字号重新定标：150 就是标准尺寸（以前 100 是标准），顶栏、右侧功能栏的字号固定在原来 150% 的样子，不再跟着作业滑块一起变大变小；站名「25级05班班级服务站」按 180 号的字排',
      '作业看板刷新不再闪：卡片按内容复用旧节点、排序按学号键固定，没有新增内容、卡片大小没变的时候整块不会重排',
      '随机点名的学号输入框外面固定显示「2505」，你只要输后面两位数字；旁边加了一个滚轮下拉，可以从 01 一路选到名单里现有的学号；左边填的学号比右边大时会自动帮你调换',
      '随机点名的抽取人数不会超过范围人数：范围里只有 5 个人就最多只能加到 5，已经加到 6 再缩小范围会自动落回 5',
      '作业编辑改回原来的设计：必须点顶部功能栏的「编辑」才能改，点「完成」恢复只读，作业卡片上不再常驻「添加一项」按钮',
      '宝箱动画过渡重新调过：随机跳到前面或后面时起步更利、落点更缓，回位不再一顿一顿；同一学号段（同色）不会并排出现，条件实在满足不了时按条件来',
      '随机点名新增配额（权重）功能：学号段、成绩段、男女、班干部课代表每一档都能设「最多抽几个」和「最少抽几个」；还能勾选「上次抽中的人不参与本次抽取」',
      '版本更新改成「检测 + 弹窗提醒」：发现新版本会弹窗告诉你，点更新有安装进度条走到 100% 后自动刷新到最新版（不会在你正用的时候偷偷刷新）',
      '每日一言的「内容类型」打勾不再错位：勾号改成固定宽度的样式，不再把文字挤到隔壁；本机勾选也不会再被云端同步覆盖',
      '中转站取件里的文本「新窗口打开」不再报拼写错误（地址拼接错了）；抽取历史的备注可以在历史列表里直接补改',
      '大屏启动方式改回「最大化」：原来用全屏启动时，站内全屏开关退不出来，退出全屏会被卡住',
      '大屏关掉后标题栏单独掉下来一栏的 bug 修了；大屏标题（班徽、明暗切换、站名）改成居中排列，不再全挤在下面',
      '大屏作业页最顶上的标题栏缩短了约三分之一（96px → 64px），内容垂直居中'
    ], pub: [
      { cat: '界面', text: '大屏作业字号以 150 为基准，标题与功能栏字号固定' },
      { cat: '学习', text: '随机点名新增配额权重：各档最多最少人数、上次抽中不参与' },
      { cat: '体验', text: '作业看板刷新保持稳定，版本更新有弹窗提醒和进度条' }
    ] },
  { version: '4.10.1', date: '2026-11-07', type: 'feat', title: '后台一键返回前台、登录验证码可开关、大屏标题上移', items: [
      '后台顶栏新增带文字的「返回前台」按钮，点击后直接返回班级站首页（以前只能靠左上角班徽，且退出后会回到后台登录界面）',
      '后台「系统设置」新增「登录需要安全验证」开关：关掉后登录 / 注册不再显示图形验证码，输密码即可登录（默认开启，建议保留）',
      '大屏首页结构调整：标题（站名 + 班徽）移到最上面，导航功能栏放到标题下面，标题卡顶部预留安全区，教室一体机的课表浮窗不再压住标题和班徽'
    ], pub: [
      { cat: '体验', text: '后台新增返回前台按钮，登录验证码可在后台开关' },
      { cat: '界面', text: '大屏首页标题上移，功能栏移到标题下方' }
    ] },
  { version: '4.10.0', date: '2026-11-07', type: 'feat', title: '点名身份三选一、成绩随抽随显、更新改手动、大屏再下移', items: [
      '随机点名的身份改成三选一（学生 / 课代表 / 班干部）：三个是包含关系，多选没有意义，现在点哪个就是哪个',
      '按成绩条件抽人时，结果卡片和滚动动画里直接带出对应的分数 / 名次（比如「语文 103」或「第 5 名」），抽到的结果与判定依据同时呈现',
      '成绩条件「可抽 0 人」的问题修了：成绩表名字带空格 / 全角空格 / 用别名都能对上名册，学号也能兜底；真取不到成绩时会明确说原因（没登录 / 考试未发布 / 断网）',
      '打开页面不再自动刷新到新版：发现新版本只在页脚提示，点「立即更新」才走三段进度换新版，更新动画能完整看到',
      '大屏首页的标题和班徽整体下移，顶部留出安全区，教室一体机上的课表浮窗不再压住它',
      '班级电脑启动脚本改用真全屏参数（--start-fullscreen），不再比最大化小一圈'
    ], pub: [
      { cat: '通知', text: '随机点名支持按成绩抽并显示对应分数，更新改为手动触发' }
    ] },
  { version: '4.9.2', date: '2026-11-07', type: 'fix', title: '中转站改为最多存 3 天，并加上容量保护', items: [
      '文件中转站的保存期改为只能选 1 天或 3 天（原来能选 7 / 30 / 180 天）。KV 总容量只有 1GB，长周期很容易忘删而塞满，3 天到点由服务器自己清掉',
      '发文件页多了一条「已用空间」进度：实时显示用了多少 / 上限多少、现在有几件，超过六成转橙、八成五转红',
      '存储用到 700MB 时会直接拒绝新上传，并提示先去「历史」删掉不用的，或者等 3 天自动过期 —— 不会真的把 1GB 撑爆导致整个站写不进去',
      '删除历史里的文件后，已用空间会立刻跟着往下走'
    ], pub: [
      { cat: '资源', text: '中转站保存期改为最多 3 天，并显示已用空间' }
    ] },
  { version: '4.9.1', date: '2026-11-07', type: 'feat', title: '全量缓存、大屏顶栏、文件中转站大改', items: [
      '名册、人员字段、作业、成绩全部走本地缓存：10 分钟内再打开是秒开的，同时在后台悄悄更新，数据库读取量直接砍掉一大半；断网也还能看上次的数据',
      '缓存可以在「清缓存并重载」时一起清掉，不会出现「点了更新还是旧的」',
      '作业期次下拉、导出勾选、作业查看的下拉统一按**时间**排序（以前按录入顺序，后补录的旧假期反而排最前）',
      '大屏班级服务站顶栏高度翻倍，所有按钮（返回大屏 / 已同步 / 期次 / 重命名 / 导入导出 / 新建一期 / 全屏）都挪到下半段，上面那半留空，课表再也不会压住它',
      '大屏首页的信息栏加高，班徽完整显示（以前顶出容器被裁掉一半）',
      '宝箱连抽每一轮都跑满同样的时长，每轮都是「从快到慢」；条带按人数铺满，看起来像把整个库轮了一遍',
      '随机点名批量管理支持勾选，选中状态可见',
      '天气总览搬进天气弹窗顶部，班级岛里那条气泡去掉',
      '成绩分析「查看画像」按学号排序；打印的班级均分不再显示 0；纸上前面那一大段空白去掉；总分分布 / 上线情况 / 分数段的柱子都能印出来',
      '作业导出预览：打开时自动关掉作业窗口；放大现在是真放大（可以放大局部看字清不清楚），以鼠标位置为中心',
      '后台左上角班徽一次点就到前台首页（不会再先弹回后台登录）；右上角首页按钮改成回后台自己的数据概览',
      '文件中转站大改：可以只发文本；保存期可选 1 / 7 / 30 / 180 天；可设最多被取几次、取满自动删除；有历史记录，能改名、删除、复制链接、直接分享；单件上限 4MB → 15MB'
    ], pub: [
      { cat: '资源', text: '文件中转站支持发文本、设次数与有效期、历史可管理' },
      { cat: '界面', text: '大屏作业页顶栏加高，按钮避开课表' },
      { cat: '修复', text: '成绩打印的均分、空白页与三张柱状图' }
    ] },
  { version: '4.7.11', date: '2026-11-07', type: 'feat', title: '版本更新弹窗、文件中转站、音效逐项设置', items: [
      '打开页面自动检查版本：有新版本才弹窗，列出改了什么；点「立即更新」走到 100% 后自动刷新',
      '宝箱抽取落点从「±1 格或不动」扩到前后 3 格，按 50% / 18% / 6% / 1% 递减，不再总是停在同一格',
      '大屏随机一言可以只显示某几类，也能整块隐藏（不适合在班里展出时）',
      '随机点名抽到 5 人以上自动分 2~4 列，一屏放下不用滚动',
      '班级岛天气改成按访客 IP 定位（拿不到才回修水），顶部多一条总览：城市、天气、最高最低、一句建议；emoji 换成手绘 SVG 图标',
      '新增「文件中转站」：手机 / 电脑 / 班级电脑之间传 4MB 以内的小文件，上传拿 6 位取件码，另一台输码下载',
      '音效拆成 6 类（点击 / 弹层 / 成功 / 出错 / 提示 / 新消息），每类可选清脆、柔和、木质、电子，或单独关掉',
      '成绩分析「仅赋分排名」也能折叠了；打印多出标题、班徽、参考人数、均分与生成时间',
      '打印空白图表的根因修掉：图表有入场动画，屏幕外的卡片还是全透明，打印前统一收掉动画',
      '作业导出预览在电脑上支持滚轮缩放、放大后拖动、双击复位',
      '后台左上角班徽可以直接点回前台首页',
      '假期从「开始时刻」生效：11 月 6 日 22:00 放假，白天照常显示当天课表，22:00 后才显示放假',
      '抽取历史删除会同步云端了（以前手机删了、电脑上还在），并支持多选与「删除 30 天前」',
      '批量导入的「性别」列改为写入系统字段，详情里不再出现两个性别',
      '大屏倒计时里填过考试范围的考试可以直接点击查看范围',
      '大屏右栏字号封顶：放大作业正文时，时钟 / 倒计时 / 一言最多跟到 1.35 倍，不会撑到显示不全'
    ], pub: [
      { cat: '资源', text: '新增文件中转站：小文件传 6 位取件码，跨设备取' },
      { cat: '界面', text: '有新版本会弹窗提示，一键更新' },
      { cat: '界面', text: '音效可逐项选择音色或单独关闭' }
    ] },
  { version: '4.7.10', date: '2026-11-07', type: 'fix', title: '大屏启动器不再一闪而过', items: [
      '修复大屏启动器双击后黑窗口一闪就没、也看不到任何提示的问题',
      '启动器不再用 for 循环拼浏览器路径（含括号的系统变量会把批处理解析打断，一断就整段退出，加 pause 也到不了）',
      '启动成功后窗口停留 8 秒并显示浏览器与配置目录；失败时停住，打印日志并等你按键',
      '全过程写入同目录「启动日志.txt」，找不到浏览器、配置目录不可写、浏览器启动即崩都能看出是哪一步',
      '浏览器启动 4 秒后回查进程，判断是真起来了还是立刻崩了；崩了直接提示改 profile 文件夹名重试',
      '新增「诊断.bat」：一次列出系统、浏览器路径、配置目录、进程、网络与安全策略，出问题截图即可定位'
    ], pub: [
      { cat: '界面', text: '大屏模式启动更稳定，出错会显示原因' }
    ] },
  { version: '4.7.9', date: '2026-11-07', type: 'fix', title: '作业图片代理、班徽黑底、假期精确到分钟', items: [
      '作业导出的图片直链改走服务端代理取图：图床不给跨域头也能画成照片，不再退成一串网址',
      '图片确实打不开时，导出图写「图片打不开（链接可能已失效）」并附短链，不再只丢一整条长网址',
      '修复班徽黑底：仓库里那张 256px 班徽是黑底不透明图（黑色占 39%，低于原来的 45% 判定线），已换成透明底并让检测识别「四角全黑」',
      '本机缓存的旧黑底班徽会自动作废重下，不用手动清缓存',
      '假期可以填到分钟：开始时间 + 返校时间（如周二 18:30），不填就按整天算',
      '假期文案重写：今天 + 明天放假时只说「还剩 1 天」，不再把结束那天多数一遍',
      '剩余不足 24 小时直接显示「还剩 X 小时 Y 分」',
      '晚上 21 点后切到「明日事项」时，假期明确写「明天开始放假 · 共 N 天」，不再照搬今天的「放假第几天」'
    ], pub: [
      { cat: '作业', text: '导出图里的图片显示成照片' },
      { cat: '界面', text: '班徽背景显示正常' },
      { cat: '界面', text: '假期可精确到返校时间' }
    ] },
  { version: '4.7.8', date: '2026-11-07', type: 'fix', title: '公告时间与排序修正', items: [
      '公告排序改为统一补全时间后再比较：只填日期的公告按当天 23:59 计算，不再被同一天带时间的旧公告压到下面',
      '修正 v4.8、v4.9 两条公告的时间（原先只填了日期，导致新公告排在 v4.7 之后）',
      '精简 v4.5、v4.6 两条历史公告的正文'
    ], pub: [
      { cat: '界面', text: '公告按时间排序' }
    ] },
  { version: '4.7.7', date: '2026-11-07', type: 'feat', title: '作业导出预览与排版、附件、班级签历史', items: [
      '作业导出图片先开预览弹窗：左边实时预览，右边调字号（80%–150%）、字体（黑体 / 宋体 / 楷体 / 等宽）、单列 / 双列、A4 竖版 / 随内容',
      '导出图每条任务前加打勾框，打印出来可以拿笔勾；科目标题按学科分色，一眼分清哪几行属于哪一科',
      '导出参数存在本机，下次打开还是上次那套；预览只缩显示，保存的仍是 2 倍分辨率原图',
      '修复班徽导出变成黑块：黑底矢量图会被识别并跳过，改用透明底的 PNG 班徽',
      '作业编辑新增「添加附件」面板：选图片 / 音频 / 视频、选挂到哪条任务、填说明和链接，自动生成附件行',
      '导出图里图片附件直接显示照片，音频与视频显示站内播放二维码；图片取不到时退回文字链接',
      '班级签新增历史日历：按吉签 / 凡签 / 平签三色标出近 90 天，点某一天才展开那天的签文'
    ], pub: [
      { cat: '作业', text: '导出作业图片可先预览并调整排版' },
      { cat: '作业', text: '导出图带打勾框，科目按学科分色' },
      { cat: '作业', text: '作业可添加图片、音频、视频附件' },
      { cat: '界面', text: '班徽导出显示正常' },
      { cat: '界面', text: '班级签新增历史日历' }
    ] },
  { version: '4.7.6', date: '2026-11-07', type: 'feat', title: '版本记录分组折叠与搜索', items: [
      '版本记录按「主.小」版本号分组，默认全部折叠，点组标题展开',
      '新增搜索框，可按版本号、标题、条目关键词过滤，命中时自动展开所在分组',
      '不成形的历史版本号统一归入「早期版本」组'
    ], pub: [
      { cat: '界面', text: '更新记录按大版本折叠，可搜索' }
    ] },
  { version: '4.7.5', date: '2026-11-07', type: 'feat', title: '字号步进、全屏保持、名单与身份、跳转与公告口径', items: [
      '作业字号改为连续百分比：25%–300%，A− / A+ 每次 5%，中间数字可直接输入；老档位按实际倍率换算',
      '新增 fs-keep.js 全屏守护：进入全屏后换页面（时钟 / 后台 / 作业）自动恢复全屏，按 Esc 或点退出即取消',
      '修复从首页进入后台、从后台返回首页需要点击两次：Service Worker 的导航兜底不再用首页顶替其它页面，admin.html 进入预缓存',
      '抽取身份条件收敛为学生 / 课代表 / 班干部三类，老师与管理员不再出现在候选',
      '点名条件面板补充说明：性别与身份来自后台「成员档案」',
      '侧栏快捷开关字号与内边距收窄，桌面端不再溢出',
      '后台游戏数据姓名改为解密后显示（此前直接输出档案密文）',
      '发布门禁新增公告规则：禁止解释性表述、禁止第二人称、单条不超过 28 字'
    ], pub: [
      { cat: '作业', text: '作业字号可调 25%–300%，可直接输入' },
      { cat: '作业', text: '作业页支持全屏，页内切换保持全屏' },
      { cat: '界面', text: '点名只抽学生、课代表与班干部' },
      { cat: '界面', text: '侧栏开关文字显示完整' },
      { cat: '速度', text: '页面跳转一次点击即达' }
    ] },
  { version: '4.7.4', date: '2026-11-06', type: 'fix', title: '抽取动画脚本与周次缓存的发布同步', items: [
      '构建时自动同步 pickfx.js 的版本参数（原来一直停在 472，升级后浏览器可能仍用旧脚本）',
      '班级岛数据一到就记录学期开始日，时钟页的「第几周」不再依赖首页是否显示班级岛卡片'
    ], pub: [
      { cat: '界面', text: '时钟页的「第几周」在更多情况下都能正常显示' }
    ] },
  { version: '4.7.3', date: '2026-11-06', type: 'fix', title: '抽取配色、作业字号与无感刷新、时钟周次、一言分类', items: [
      '抽取：名单断网时改用本机缓存的名单（带学号），不再退回没有学号的姓名列表，格子颜色恢复分段',
      '抽取：连缓存都没有时按名单顺序补一个显示序号，只用于上色，不影响学号筛选',
      '作业：字号范围从 85%–170% 扩到 25%–300%，投影和「一屏多放」都够用',
      '作业：刷新不再打断输入 —— 有未提交的输入就先等着，手停下来再更新，光标与滚动位置原样保留',
      '点名：把成绩切回「不限成绩」时，名次 / 分数条件一并清空，条件栏不再显示已经不生效的条件',
      '时钟：日期 / 周次那一行放大，并补上「第 N 周」，离线也能算',
      '每日一言：首页卡片上直接勾选要显示哪几类，管理员保存后全站同步'
    ], pub: [
      { cat: '界面', text: '随机点名的格子颜色在班级电脑上也能分开了' },
      { cat: '作业', text: '作业字号可以从 25% 调到 300%' },
      { cat: '作业', text: '别人更新作业时不会再把你正在打字的框冲掉' },
      { cat: '界面', text: '时钟页的日期和「第几周」变大了' },
      { cat: '界面', text: '每日一言可以自己选要显示哪几类内容' }
    ] },
  { version: '4.7.2', date: '2026-11-06', type: 'fix', title: '断网后首次打开会白屏', items: [
      '后台脚本安装改为每个文件都有时间上限，最慢的文件不再拖住整次安装',
      '首页纳入安装清单，装好即可离线打开；缺失时自动补两次',
      '线上实测：原来装到第 30 秒仍未接管，断网重载直接打不开'
    ], pub: [
      { cat: '界面', text: '断网后重新打开站点也能正常显示，不再白屏' }
    ] },
  { version: '4.7.1', date: '2026-11-06', type: 'feat', title: '离线适配、作业本机编辑、作业页全屏', items: [
      '离线：断网时接口立即返回本机缓存，不再等 DNS 超时十几秒；大屏轮询离线自动跳过',
      '离线：登录框离线时直接说明「无法登录，先用本机缓存」，不再转圈',
      '作业：新增不依赖登录的「本机编辑」，班级电脑离线也能新增科目、改作业、新建期次',
      '作业：本机改动单独存放并优先显示，未上传前不会被云端覆盖；顶栏提供「上传 / 放弃」',
      '作业：新增「全屏」按钮，走 Fullscreen API，连任务栏一起隐藏，Esc 退出',
      'PWA：不再强制竖屏（班级电脑是横屏），补齐大屏 / 作业两个快捷方式',
      '后台：站点资源新增「大屏启动器」下载，自己找浏览器路径，不再出现找不到 program 文件'
    ], pub: [
      { cat: '作业', text: '班级电脑没网也能新增、修改作业，改动先存本机，可选上传或放弃' },
      { cat: '作业', text: '作业页新增全屏按钮，投影时不显示任务栏' },
      { cat: '界面', text: '断网时不再长时间等待，直接显示已保存的内容' }
    ] },
  { version: '4.7.0', date: '2026-11-06', type: 'feat', title: '宝箱收尾、作业实时同步、名单与历史云同步', items: [
      '宝箱：减速改为单段单调曲线，落点精确居中，停下后不再「突然加快 / 跳一下」；中奖卡只加光圈不缩放',
      '宝箱：停下即自动揭示姓名，两种模式都不再需要第二次点击',
      '宝箱：不隐藏姓名时停稳后随机前后跳 0～2 格再落回中奖卡（纯气氛）；隐藏姓名时不做位移',
      '抽取历史：删除记录改为落墓碑并同步本机副本，修复「删了又自己回来」',
      '名单设置：请假 / 不参与名单改存云端，换设备不用重新点一遍（管理员改动才上传）',
      '作业：大屏每 12 秒比对一次云端，手机端新增或修改后自动重绘，并把改动处标黄 5 秒',
      '作业：点顶部「已同步」角标可立即强制拉取刷新',
      '首屏侧边栏新增「大屏 / 横屏 / 轻量」三个快捷开关，并新增「班级服务站后台」入口',
      '前台登录：拿到登录态后立即关闭弹窗并提示成功，云端同步与整页重绘挪到之后执行'
    ], pub: [
      { cat: '作业', text: '手机端新增或修改作业后，大屏自动更新，并将改动处标黄提示' },
      { cat: '界面', text: '宝箱停止后直接显示姓名，无需再次点击；抽取历史中的记录可正常删除' },
      { cat: '界面', text: '大屏、横屏、轻量三个开关移至首页侧边栏，点击即可切换' }
    ] },
  { version: '4.6.1', date: '2026-11-06', type: 'fix', title: '宝箱停下后姓名被全屏泛色遮挡', items: [
      '姓名揭示的同时让全屏泛色退去，方框内姓名清晰可见'
    ], pub: [
      { cat: '界面', text: '宝箱停下后姓名不再被颜色遮住，方框内清晰可见' }
    ] },
  { version: '4.6.0', date: '2026-11-06', type: 'feat', title: '抽取动画重做 + 希沃性能优化 + 图标下载', items: [
      '站主：盲盒格子数按条件人数（最多 10 个），点一次抽一人、点几次抽几人，不存在「未中」',
      '盲盒不再预先定人：每次点击时在条件范围内现抽一个没抽过的人，先显学号段颜色、随后自动显示姓名',
      '宝箱重做：中间固定方框不动，卡片横向滚动，停下按方框内重叠面积最大判定；隐藏姓名时卡片只显纯色块与微光',
      '单次点击：盲盒与宝箱均不再需点两次，露色后约 0.5～0.8 秒自动揭示姓名',
      '性能：轻量模式改为「降质不降功能」，抽取动画完整播放但减少模糊与阴影；后台补上轻量模式，登录输入不再卡顿',
      '后台「数据管理」新增站点资源：下载班徽 PNG 与站点图标 ICO，并提供轻量模式开关'
    ], pub: [
      { cat: '作业', text: '盲盒改为点一次抽一人，宝箱改为方框判定' },
      { cat: '界面', text: '抽取动画改单次点击；新增轻量模式，低性能设备更流畅' }
    ] },
  { version: '4.5.2', date: '2026-11-06', type: 'feat', title: '盲盒固定 10 格 + 中奖/陪跑机制', items: [
      '站主：不论抽几人，盲盒始终 10 个（条件池不足 10 才按池子数），不会因人数少而暴露结果范围',
      '中奖者藏在 10 个盲盒里，陪跑从条件池补齐、打乱顺序；逐个开盒才知道是中奖还是未中',
      '中奖盲盒：开缝露学号段光辉 → 揭示姓名 + 清亮音效；陪跑盲盒：开缝露段 → 显示「未中」+ 低沉音效 + 暗淡',
      '底栏显示「已抽中 X / N」计数；中奖全部开完后启用「查看结果」，可继续开陪跑盲盒或直接看结果',
      '抽取记录权限不变：仅管理员自动上传云端，普通用户本地使用不影响云端数据'
    ], pub: [
      { cat: '作业', text: '盲盒固定 10 个，中奖者藏在其中，逐个开盒揭晓' }
    ] },
  { version: '4.5.1', date: '2026-11-06', type: 'feat', title: '抽取动画精简为盲盒与宝箱两种，盲盒改两段式、宝箱加卡间隙', items: [
      '站主：盲盒与卡片功能相近，删除卡片；盲盒参考蛋仔派对做全屏颜色提醒与两段式悬疑；宝箱由快到慢、停针卡间隙',
      '动画档位：关闭 / 盲盒 / 宝箱（移除抽卡）；选择结果仍记本机，默认关闭',
      '盲盒两段式：第一次点击开缝露学号段光辉并全屏泛色提示对应学号段，第二次点击揭示姓名，制造两次紧张',
      '盲盒「全部开盒」分两步：先把全部盲盒开缝露段，按钮变「全部揭示」，再一次性揭示姓名；单个点击才点亮全屏泛色，避免多段撞色',
      '宝箱减速：分段缓动，前段较快、末段极慢；约三成概率停针偏向中奖格与邻格间隙，视觉上「差点滑过去」',
      '宝箱隐藏姓名时格子先显示学号段，停下全屏泛色提示后再揭示姓名；显示姓名时随学号段一同显示',
      '全屏泛色层：满屏径向泛起该学号段颜色，中央显示学号段文字与提示，跟随页面昼夜',
      '离线与门禁不变：纯 CSS + WebAudio，pickfx.js 仍在 SW 预缓存与发布白名单'
    ], pub: [
      { cat: '作业', text: '抽取动画精简为盲盒与宝箱两种' },
      { cat: '界面', text: '盲盒改两段式：先露学号段光辉再揭示姓名' }
    ] },
  { version: '4.5.0', date: '2026-11-05', type: 'feat', title: '随机点名新增抽取动画：盲盒 / 抽卡 / 宝箱，按学号分段配色', items: [
      '站主：抽人加个动画，可选开关；三种玩法参考蛋仔盲盒、原神抽卡、CS 开箱，但要做成自己专属的；动画要自然、离线可用',
      '动画档位：关闭 / 盲盒 / 抽卡 / 宝箱，选择结果记在本机；默认关闭，关闭时点击「开始抽取」直接出结果',
      '盲盒：牛皮纸礼盒 + 绶带 + 火漆印，逐盒开启，先起彩色光柱再落姓名；可「全部开启」一次翻完',
      '抽卡：深色卡背 + 六边班徽，点击后光柱升起、卡面翻转，正面按学号段配色显示姓名与学号',
      '宝箱：横向转盘 + 铜指针，逐轮减速停在中奖格；可勾选「抽取时隐藏姓名」，转动时只见光辉，停稳后补姓名',
      '学号分段色：01–10 青、11–20 蓝、21–30 紫、31–40 玫、41–50 金、51–62 绿；61、62 与 51–60 同色，无学号账号用中性灰',
      '结果页每条结果左侧保留同色光条并显示学号；单条重抽按「单抽」演一遍（只开一个盒子 / 翻一张牌 / 转一轮）',
      '适配：人数 1–10 自适应列数（桌面 5 列、手机 4 列），顶部常驻「跳过」，系统开启减少动态效果时时长压到 0.7 秒',
      '离线：盒子、卡面、光柱、指针全部 CSS 绘制，音效由 WebAudio 现场合成，不引用任何图片与音频文件；pickfx.js 进 Service Worker 预缓存',
      '修复：转盘停针偏差——入场缩放下必须用 offsetWidth / offsetLeft，不能用 getBoundingClientRect',
      '门禁：pickfx.js 纳入文案检查与发布白名单'
    ], pub: [
      { cat: '作业', text: '随机点名新增盲盒、抽卡、宝箱三种抽取动画' },
      { cat: '界面', text: '抽取结果按学号分段配色并显示学号' }
    ] },
  { version: '4.4.5', date: '2026-11-05', type: 'fix', title: '软件简介改书面表述；成绩单表头吸顶加固；视频悬浮球限大屏服务', items: [
      '站主：卡片里「作业」「意见反馈」这些软件简介没按官方口径改；大屏视频关掉后右下角还留着悬浮球，只应在大屏服务里出现；轻量模式下全班成绩单的表头不跟随滚动',
      '软件简介：点歌、作业查看、班级课表、听歌平台、课堂笔记、教学课件、每日日报、个人资料查询、全屏时钟、意见反馈等 14 张卡片的说明全部改为书面表述，去掉第二人称、语气词与「点击下方按钮」这类指令句',
      '正文提示：账号与资料、成绩分享、AI 分析说明、导出加密提示、音频提示等改为无主语句；跳转与未保存提示改为第三人称陈述',
      '内置公告：app.js 里 90 条早期长公告全部清空，只留 2 条离线兜底；云端公告仍是 4.4 批次的简洁版',
      '成绩单表头：同时写 -webkit-sticky（微信内置浏览器等老内核只认带前缀的写法，之前会被当成 static，表现就是表头不跟随），top 改 -1px 消除透缝，暗色单独配色',
      '视频悬浮球：关闭视频后只在大屏服务（板块 2）内显示；切到其它板块或回首页立即收起，回到大屏服务自动恢复',
      '部署门禁：新增「站内文案书面化」硬性检查（scripts/copycheck.mjs），出现第二人称、口语动词、语气词任一处即阻止部署'
    ], pub: [
      { cat: '界面', text: '各软件卡片的说明文字改为书面表述' },
      { cat: '界面', text: '大屏服务的视频悬浮球仅在板块内显示' },
      { cat: '成绩', text: '全班成绩单表头滚动时始终吸在顶部' }
    ] },
  { version: '4.4.4', date: '2026-11-05', type: 'chore', title: '全站文案统一为书面表述，公告改为只写更新内容', items: [
      '站主：站内语言需官方、简洁，抽取备注不应使用口语提问式表述；公告只写更新内容，不写操作步骤与效果',
      '统一措辞：提示与说明改为陈述句，去除口语动词、劝说句与句末语气词；按钮动作统一用「点击」，状态统一用「已 / 暂无 / 无法」',
      '大屏：抽取备注改为「备注 / 选填，填写本次抽取事由」；筛选说明压缩为两句；作业空态、导入导出、锁定与字体说明同步改写',
      '首页与时钟页：登录引导、隐藏区域、数据管理、备份与校园网说明、时钟功能说明全部改为书面表述，删除装饰性 emoji',
      '后台：成员档案、字段管理、提醒、回档等处的提示统一改写；「同学用它登录，告诉他初始密码」改为「成员使用该账号登录，请告知初始密码」',
      '公告：74 条历史公告全部重写，最长由 790 字压到 123 字，平均 35 字，只保留「更新了什么」；删除操作步骤、使用建议与效果描述',
      '后台补充：将第二人称与口语表述统一改为「当前账号 / 所设 / 正在加载 / 手动填写」'
    ], pub: [
      { cat: '界面', text: '全站提示与说明文字统一为书面表述' }
    ] },
  { version: '4.4.2', date: '2026-11-05', type: 'feat', title: '点名身份拆细：班干部按 8 个职务认、新增「课代表」', items: [
      '站主：班干部就是班长、副班长、学习委员、劳动委员、团支书、体育委员、宣传委员、纪律委员这 8 个；课代表按 6 科分，所以身份筛选再新增两档',
      '以前勾「班干部」只认身份里写了「班干部」三个字的人 —— 实际后台填的都是「班长」「团支书」，所以抽出来是 0 人。现在改成按关键字归组：这 8 个职务任意一个都能被「班干部」认出来',
      '新增「课代表」一档：身份里写「语文课代表」这类，勾「课代表」就只从课代表里抽',
      '「学生」这一档同时放宽：除老师 / 管理员以外的所有人都算学生（班干部、课代表本来就还是学生），勾「学生」抽全班不用再叠加别的身份',
      '后台「成员档案 → 身份」加了候选列表：点击就能选班长 / 团支书 / 语文课代表等 18 个常见值，不用手打、也不会打错字',
      '筛选面板底部补了一行说明：哪 8 个职务算班干部、课代表怎么填'
    ], pub: [
      { cat: '作业', text: '随机点名支持按班干部、课代表抽取' }
    ] },
  { version: '4.4.1', date: '2026-11-04', type: 'fix', title: '修正：个人画像「查看画像」下拉打不开', items: [
      '线上验收时抓到的真 bug：成绩行的 id 是数字，而 `esc()` 内部直接 `.replace`，只吃字符串 —— 于是渲染下拉选项时抛 `replace is not a function`，整个画像面板变成「读取失败」。本地测试用的是字符串 id，所以没露出来',
      '修法：`esc(String(r.id))`、`esc(String(r.studentId))`。渲染后实测画像正常出现，下拉列出全部 60 人，切到第 4 位同学的画像数据跟着换'
    ], pub: [
      { cat: '成绩', text: '个人画像能正常挑同学看了' },
      { cat: '作业', text: '随机点名的抽取历史和备注已上线，可在点名面板里翻看' }
    ] },
  { version: '4.4.0', date: '2026-11-04', type: 'feat', title: '点名能抽班干部、可查抽取历史并写备注；个人画像可选人；五种字体真的能换了', items: [
      '站主 6 条：①随机抽人新增「班干部」身份 ②五种字体设了没反应、看起来一模一样 ③作业看板点时钟进去，返回要回作业看板 ④抽取要有历史（时间/条件/人数/人员）+ 备注 + 上云 ⑤手机端 Classworks 退场、公告同步清理、作业图标先写「作业」两字 ⑥管理员能看其他同学的个人画像',
      '【字体 · 真 bug】根因是全局 `*{font-family:…}` 这条规则 —— `*` 是「直接声明」，优先级高过继承，把每个元素都钉死成同一套字体，大屏页上设的 `--bhw-font` 只在容器自己身上生效。改成挂在 `html` 上之后，五种字体（黑体 / 宋体 / 楷体 / 圆体 / 等线）实测 computed fontFamily 全不同，正文跟着换',
      '【班干部】身份筛选多一档「班干部」。身份用的是后台「成员档案 → 身份」那个文本框，填「班干部」就能被单独抽到，不用改数据库',
      '【抽取历史】每次抽完自动记一条：时间、条件、抽了几人、抽到谁。结果页下方可以写备注（例如「语文课抽查背诵」），历史面板里也能补写。存本机 localStorage，管理员登录时整包推到云端 `pick_history`，换设备也看得到；单个人点「重抽」会同步改掉那条记录，不会出现「屏幕和记录对不上」',
      '【时钟返回】从作业看板点时钟进去，返回回到作业看板（带 `?big=1#/hw`）；从首页点进去还是回首页。原来写死 `./index.html`，一返回就掉到图标墙',
      '【Classworks 退场】首页「作业查看」卡片不再跳原站、不再挂人家的 logo，图标位置直接显示「作业」两个字；相关的那条置顶公告与访问提示里的一行同步改写。站内本来就是作业的正主，外部平台彻底不用了',
      '【画像选人】个人画像顶部新增「查看画像」下拉，管理员可选择任意同学查看。默认仍显示本人；管理员本人不在成绩表内（班级电脑等纯管理账号）时自动落到第一个学生，不再仅提示「无本人成绩」。普通成员不显示该下拉，亦无法切换',
      '【实测】字体 5 套 computed 值互不相同；只勾「班干部」可抽 1 人；抽完历史里立刻出现记录、备注写入成功；`cls_clock_from=hw` 时返回链接是 `./index.html?big=1#/hw`；管理员选人后画像换成对方数据，非管理员切换无效'
    ], pub: [
      { cat: '作业', text: '作业查看不再跳外部平台，图标已换成「作业」；随机点名能抽班干部，还能翻历史、写备注' },
      { cat: '成绩', text: '个人画像顶部能直接挑同学看了；五种字体这回真的能换了' }
    ] },
  { version: '4.3.3', date: '2026-11-04', type: 'fix', title: '教室一体机带冰点还原也能用：大屏入口网络优先取最新版，落后自动静默升级', items: [
      '站主：「我们班电脑装了冰点还原，每次重启都回到装机那天的状态，我更新到 4.2 了，重启之后打开还是 4.0，登录态和缓存也全没了」',
      '【根因】不是网站文件放错了盘，是 **Edge 的用户数据目录（Profile）在 C 盘被一起还原了**。SW 缓存、localStorage、Cookie、PWA 安装记录全在这一个目录里，回滚等于「穿越回 4.0 那一刻」',
      '【解法】不搬网站、不重装浏览器，只让 Edge 把 Profile 存到 D 盘（D 盘不在还原范围内）：用 `--user-data-dir="D:\\ClassSite\\EdgeProfile"` 启动，浏览器外壳和外观完全不变，也不再依赖「安装为应用」',
      '【本版配套 1：大屏入口网络优先】带 `?big=1` 的导航请求改为「最多等 2.5 秒网络，拿到就用最新的」，拿不到才退回缓存；其它入口（手机、微信、普通电脑）保持原来的「缓存先给」不变，首屏照样 40ms 级',
      '【本版配套 2：版本静默自检】大屏打开 4 秒后读一次 `sw.js` 里的 `SITE_VER`，发现线上更新就主动让新 SW 接管并带 `?_r=` 强刷一次，全程无感；同一次打开最多救 2 次、10 分钟内不重复，实测不会循环',
      '【实测】同一台环境模拟「重启后 C 盘被清空」：默认 Profile 的 token / 字号 / 字体全丢；换成 D 盘 Profile 后三项全部还在，SW 缓存也落在 D 盘目录里',
      '【本版配套 3：断网兜底】线上实测又抓到一个真空档 —— 全新 Profile 第一次打开时 SW 还没接管，缓存里一个 HTML 都没有，此时断网重开就是整页白屏。现在任何一次导航成功都会顺手沉一份 `./index.html` 兜底，SW 激活后再延时 3 秒补一次（改进预缓存会拖慢安装，弱网下反而更糟）；修完实测「首开 → 断网 → 重开」8ms 内正常显示'
    ], pub: [
      { cat: '作业', text: '教室一体机加了冰点还原也能正常用：打开就是最新版，不用重新登录，断网照样能看作业' }
    ] },
  { version: '4.3.1', date: '2026-11-04', type: 'fix', title: '大屏模式默认进作业页；锁定不再模糊；作业页可切昼夜', items: [
      '站主：「以后如果是大屏模式的话，我打开网站是默认直接进入这个作业查看界面的」',
      '【默认进作业】大屏模式（`cls_bigscreen=1`）打开站点直接落到作业页，不再先停在图标墙；hash 为空或本来就是 #/hw 才自动进，其它深链（#/board/3 等）不会被抢',
      '站主：「锁定之后不要模糊，锁定是防止他们误触，但是他们有些还是要看作业」',
      '【锁定不糊】锁定遮罩去掉 `backdrop-filter: blur` 与半透明底，改成完全透明：点击 / 滑动 / 滚动照旧被拦住，但字和图片一点都不受影响，后排照样能看清',
      '站主：「作业面板里面我可以切换暗色和明亮模式，这个按钮不需要隐藏」',
      '【昼夜切换】底栏新增主题按钮（月亮 / 太阳图标 + 目标模式），点了直接走全站的 `toggleTheme`（含扩散动画、记忆本机）；按钮文案与图标随实际主题同步，自动切换时也会跟着变',
      '【原因】作业页是专用页，把 `.sidebar` 整个隐藏了，全站的 `#themeToggle` 也一起看不见 —— 所以在底栏单独放一个'
    ], pub: [
      { cat: '作业', text: '开启大屏模式后，打开网站会直接进入作业查看页，不用再点一次图标墙' },
      { cat: '界面', text: '作业页锁定后画面不再模糊变暗，只拦截点击和滑动，文字依旧清晰可看；底部新增明亮 / 暗色切换按钮' }
    ] },
  { version: '4.3.0', date: '2026-11-04', type: 'feat', title: '新建作业默认带六科；随机一言可点击更换并按时轮换；侧栏增加倒计时与换字体', items: [
      '站主：「科目预设是六科，每次新建作业时候就默认都会有的预设科目，不要每次输入再加」',
      '【预设六科】新建一期时自动带语文、数学、英语、物理、化学、生物六科，每科先放一个空项，打开就能写；表单里可以点掉这一期不需要的科目',
      '站主：「今日一句这个换一句点击没有反应，而且我可以设置每隔 5 分钟自动换」',
      '【点击换一句】大屏侧栏这块改成可点的卡片，点击（或点右上角「换一句」）立刻换；本地语录库先出内容，联网时再补一句新的，断网也照样能换',
      '【自动轮换】默认每 5 分钟自动换，齿轮里可改 1 / 3 / 5 / 10 / 30 分钟或关掉；只存本机，不影响别的设备',
      '站主：「每日一句那里太空，而且不太好看，出处颜色应该更淡；可以新增重要日期、倒计时、节假日」',
      '【倒计时】侧栏新增倒计时卡片：重要日期取最近一条（区间内显示「进行中」），节假日只显示最近的一个；两者都没有时整块隐藏，不留空盒',
      '【一言排版】出处字体小一号、颜色调淡并右对齐，正文用正常字重；卡片只包住自己的内容，不再拉成一整片空白',
      '站主：「倒计时放在点名的上面，最底下才是每日一言」',
      '【侧栏顺序】时钟 → 今日事项 → 倒计时 → 随机点名 → 随机一言',
      '站主：「当前作业是根据时间去检索的，当前范围内没有作业就说当前没有作业，不用特意搞上一次作业」',
      '【当前作业】没手动选期次时只按起止日期判定「今天在不在这一期」；不在任何一期就明确显示「当前没有作业」，旧作业从右上角下拉里翻',
      '站主：「我可以新增一个换字体的功能」',
      '【换字体】底部工具条新增「字体」，可选黑体（默认）/ 宋体 / 楷体 / 圆体 / 等线，带实时预览，只影响这一页并存在本机；全部用系统字体，断网不受影响',
      '【细节】「当前没有作业」横跨作业区居中显示；预设科目 chips 选中态改成实色底，一眼能看出选了哪几科',
      '【过滤】随机一言会丢弃日文 / 韩文 / 西里尔文的网络内容（动画类接口常返回外国台词），保证大屏上只有中文'
    ], pub: [
      { cat: '作业', text: '大屏作业页新建一期时自动带上语文、数学、英语、物理、化学、生物六科，不用再一科一科添加；表单里可以取消这期不需要的科目' },
      { cat: '作业', text: '大屏作业页只显示「日期范围内」的作业，今天没有作业时会直接提示当前没有作业，想看过往可以从右上角下拉里选' },
      { cat: '界面', text: '大屏作业页侧栏新增倒计时（重要日期与最近一个节假日），并按「时钟 → 今日事项 → 倒计时 → 随机点名 → 随机一言」的顺序排列' },
      { cat: '界面', text: '随机一言可以点击换一句，默认每 5 分钟自动更换，也可以在齿轮里改成 1 / 3 / 10 / 30 分钟或关闭；出处颜色更淡、更清楚' },
      { cat: '界面', text: '大屏作业页底部新增「字体」，可在黑体、宋体、楷体、圆体、等线之间切换，解决不同班级电脑上字看不清的问题' }
    ] },
  { version: '4.2.0', date: '2026-11-04', type: 'feat', title: '作业可导出导入；断网时照常新增与查看，联网后自动补传', items: [
      '站主：「确保我们班上那个电脑，它那个断网也可以正常使用……打开作业之后我照样可以添加作业，照样可以看历史作业，因为已经缓存了」「新增一个导出和导入的功能」',
      '【断网可用】作业页、历史期次、时钟、字号、锁定全部读本机缓存，断网刷新也能打开；只有云端同步这类必须联网的动作会暂时失败',
      '【离线保存】断网时新增 / 修改的作业先写本机，右上角状态显示「离线 · 存本机」；有改动没传上去时显示「待上传」',
      '【自动补传】重新连上网（网线插回 / 切回教室 WiFi）、页面回到前台、或每 45 秒巡检时，自动把待上传的改动补到云端，不用再手动改一次才触发',
      '【导出】右上角「导出」：可全选或只勾某一期，导出一个 JSON 文件（含期次名、起止日期、各科作业、图片音频引用）',
      '【导入】右上角「导入」：选文件或直接粘贴内容，按 id 合并（同期覆盖、新期追加），导入后立刻尝试上传云端；传不上去也会先存本机等联网补传',
      '【容错】导入支持纯数组 / {homeworks:[…]} / {items:{holiday_homeworks:…}} 三种写法，字段不认识就只取认识的，脏数据不会写进云端'
    ], pub: [
      { cat: '作业', text: '大屏作业页可以导出和导入作业：把作业存成一个文件带到别的电脑，导入后自动同步；班级电脑断网时改的作业会先存在本机，联网后自动上传' },
      { cat: '作业', text: '断网时作业页照常打开，能看历史作业、能新增，右上角会显示当前是离线还是已同步' }
    ] },
  { version: '4.1.2', date: '2026-11-04', type: 'fix', title: '底部工具条居中；大屏正文换更清晰的中文字体、字重加粗、行距收紧', items: [
      '站主：「底部那个导航栏我觉得可以放到中间来，因为有时候在侧面我在班级电脑上太大了不好点」',
      '【工具条居中】字号 / 锁定那排按钮从贴右下角改成整排水平居中，按钮也放大了一点（高 58px、左右内边距 17px），远处更好点；提示文字仍留在左下角',
      '站主：「那个字体……它这个比较细，但后面可能看不太见」',
      '【字体更实】大屏作业页改用更适合远看的中文字体栈（PingFang / HarmonyOS Sans / Microsoft YaHei UI 优先），正文由 400 加粗到 600；Windows 上会落到雅黑 Bold，后排不再发虚',
      '站主：「把字与字之间放挤一点点……放大字号时候字和字之间太宽了」',
      '【行距收紧】正文行高 1.62 → 1.45、字距 -0.01em，同样一屏能多放两三行；调大字号时同样按比例收紧，不会越放越稀'
    ], pub: [
      { cat: '界面', text: '大屏作业页的字号与锁定按钮移到屏幕正中间，更好点；作业文字加粗、更清晰，行距也更紧凑，一屏能看到更多内容' }
    ] },
  { version: '4.1.1', date: '2026-11-04', type: 'fix', title: '作业卡片只包住自己的内容，不再拉伸去填满屏幕', items: [
      '站主：「卡片只要包住自己内容即可了，不一定一定要填满这个屏幕」',
      '【不再拉伸】排完两栏后不再按剩余高度把卡片摊开，卡片高度完全由内容决定，多出来的竖向空间就空在底部',
      '【两栏更齐】分配方式改成「高的先放、往更矮的那栏放」，默认字号下两栏总高 651 / 648（差 3 像素），调字号后也基本齐平'
    ], pub: [
      { cat: '作业', text: '作业卡片只包住自己的内容，不再拉伸填满整屏；左右两栏的高度也更整齐' }
    ] },
  { version: '4.1.0', date: '2026-11-04', type: 'fix', title: '作业页字号不再挤坏时钟与长句；卡片按空间自动重排；点名名次只看本班并支持进步排名', items: [
      '站主：「字号放大但是把时钟也放大了，导致时间显示不完整，同样的问题也存在作业中，放大后（字数过多也会）……超出了输入框所以会被遮挡」',
      '【时钟固定】时钟不再跟着字号缩放，始终是固定的 2.55rem 等宽数字，任何字号下都能完整显示；字号只作用于作业正文',
      '【不再截断】大屏作业页的正文输入从单行 input 换成自适应高度 textarea：字数多会自动加高，长句不再被输入框边界挡住；调字号后自动重算高度',
      '【卡片重排】作业卡片不再「左三右三」写死。每次渲染 / 调字号 / 图片加载完 / 窗口变化，都按卡片真实高度贪心塞进当前更矮的一栏，尽量少留空白；输入过程中不搬动 DOM，免得丢焦点',
      '【音频不带球】音频播放器关闭后不再在右下角留悬浮球（站主指定，只对音频生效，视频的悬浮球不变）',
      '【名次只看本班】随机点名的成绩条件先按班级名册把成绩表收敛成本班，再在班内排名，不再受年级大表影响',
      '【进步排名】成绩条件新增「总分进步排名」「单科进步排名」：以上一次考试为基准，按班级名次提升的幅度排名（1 = 进步最多）；选的如果是列表中最早的考试，会提示没有可比较的上一次'
    ], pub: [
      { cat: '界面', text: '大屏作业页的字号调大后不再挤坏时钟，时间始终完整显示；作业正文会自动加高，长句子不再只显示半句' },
      { cat: '作业', text: '作业卡片按空间自动排布，每次调整字号都会重新分配到更空的一栏，尽量少留空白' },
      { cat: '作业', text: '音频播放关闭后不再在右下角留悬浮图标' },
      { cat: '成绩', text: '随机点名的成绩条件只看本班排名；新增「总分进步排名」「单科进步排名」，可按相比上一次考试前进的幅度抽人' }
    ] },
  { version: '4.0.0', date: '2026-11-03', type: 'feat', title: '大屏作业页改版：两栏排布、字号可调、锁定防误触，点名能按条件抽', items: [
      '站主：「这次主要是对大屏里面的作业查看进行一个更改……最重要的一点是我不需要滑动就可以看到所有的作业，而且字号我可以自己调」',
      '【两栏排布】作业页重排：左边语数英，右边物化生，最右边是时钟与随机点名，底边放其他科目；一行写不下自动换行',
      '【不带导航】作业页不再显示全站导航与页头，只保留「25级05班班级服务站」和左上角「返回大屏服务」',
      '【一屏看完】默认字号下全部作业一屏装得下，不出现滚动条；字号调大放不下时才允许上下滚动',
      '【字号可调】底部工具条 A− / A+ 共八档，只影响作业页，并记在这台电脑上',
      '【锁定防误触】底部「锁定」按下后，整页点击、滑动、滚动都不会有反应，必须先点右下角「解锁」；刷新页面自动解锁',
      '【时钟到秒】作业页时钟精确到秒',
      '【期次命名】新建一期时可填名称与起止日期；历史作业可随时重命名',
      '【作业配图】作业里配的图片直接铺出来，不用打开看；点击可以放大；音频仍然点击才播放',
      '【按条件抽人】随机点名默认只抽学生，可按性别、学号范围、总分名次、单科名次或分数区间筛选，条件可叠加，记在本机',
      '【名单不跳顶】名单设置里点「请假 / 不参与」不再跳回最上面，可以接着往下点',
      '【班级电脑提醒】后台「通用弹窗」发一条、投放对象选班级电脑账号，电脑上 20 秒内整屏弹出；分普通 / 重要 / 紧急三档，边框颜色与提示音不同',
      '【性别字段】成员档案新增「性别」，后台可填写，供点名按性别抽取'
    ], pub: [
      { cat: '界面', text: '大屏作业页改版：左边语数英、右边物化生，底边放其他科目；底部可调字号、可一键锁定防误触，默认一屏看完全部作业' },
      { cat: '作业', text: '作业页时钟精确到秒；新建一期可命名、历史作业可重命名；作业配图直接显示，音频点击播放' },
      { cat: '班级', text: '随机点名可按身份、性别、学号范围、总分或单科名次筛选，默认只在学生里抽' },
      { cat: '班级', text: '班级电脑会收到提醒，分普通、重要、紧急三档，颜色与提示音不同' },
      { cat: '资料', text: '成员档案新增「性别」一栏，可在班级档案里填写' }
    ] },
  { version: '3.19.0', date: '2026-11-03', type: 'feat', title: '大屏模式：一屏放全部功能，作业能直接在班级电脑上写', items: [
      '站主：「这个班级的网站我后续会在我们班上电脑大屏上运用……在设置新增一个大屏模式的选项，打开之后就是一个页面显示全部功能」',
      '【大屏模式】自定义设置 → 界面 → 大屏模式。开了以后：顶部导航变成横排（还是原来那些入口），首页铺成图标墙，按板块分组，图标更大、点起来更容易',
      '【单功能页】点站内功能（成绩分析、投票、个人资料查询…）会进入「只有这一个功能」的页面，左上角「返回大屏」一键回来；外链入口直接新窗口打开',
      '【大屏作业页】作业图标点进去是仿 ClassWorks 的一整页：左边作业列表，右边实时时钟 + 今日事项 + 随机点名',
      '【作业直接编辑】管理员（班级电脑专用账号）在作业页就能改：改文字、加一项、删一项、加一科、新建一期，修改后自动同步云端，成员刷新后可见',
      '【随机点名】复用班级名单，默认只在学生里抽；支持一次抽多人、滚动动画、对某一个人单独重抽；可把请假 / 不参与的同学先排除，名单记在这台电脑上',
      '【时钟】作业页右侧就是实时时钟，点击进全屏时钟页',
      '【只记本机】大屏开关只存在这台设备，换电脑或清缓存要重新开（站主要求）；也支持链接后面加 ?big=1 直接进大屏',
      '【投票未登录可看】分享出去的投票链接，没登录也能看到有哪些选项、各多少票；想投票仍然必须登录。每条投票可在后台单独关闭「公开」',
      '【后台拆包】后台脚本从 1 个 800KB 的大文件拆成三段（各 90~120KB gzip），后台首屏更快；功能和界面完全不变'
    ], pub: [
      { cat: '界面', text: '设置里新增「大屏模式」：打开后首页变成一屏图标墙，顶部导航照旧；点站内功能会进入只含这一项的页面，左上角可一键返回' },
      { cat: '作业', text: '大屏作业页上线：左边作业可以直接编辑并同步，右边是实时时钟、今日事项和随机点名；点名支持多人、单人重抽，可先把请假的同学排除' },
      { cat: '投票', text: '分享出去的投票，没登录也能看到有哪些选项和各多少票；投票本身仍需登录' },
      { cat: '速度', text: '再次打开页面时加载更快，功能与界面不变' }
    ] },
  { version: '3.18.0', date: '2026-11-02', type: 'feat', title: '登录一次，全站通用：链接直达 + 打开就落在那一页', items: [
      '站主：「以后都是复用登录态的方法 —— 我自己建了个新链接，别人打开就能直接跳到那个页面，不用从首页开始点，也不用重新登录；登录态只存在本地，换设备就没有」',
      '【登录态总线】全站只认一份登录态（同一浏览器同源共享）。主页登过，分享页、时钟页、以后的单页都不用再登一次；另一个标签页登录/退出，这边立刻跟着变',
      '【深链直达】每个位置都能变成一条链接：板块、板块里的某张卡片、成绩单的某一场、我的画像、成绩对比、某一条投票、小游戏、时钟、点歌、作业',
      '【地址栏跟着走】打开哪个板块，地址栏就变成对应的链接 —— 随时复制发人，对方打开就落在同一页',
      '【未登录不再被扔回首页】需要登录的内容，先记下你原本在哪儿，登录成功后原地回来；成绩页、投票页的「去登录」都走这条路',
      '【登录过期】不再静默变成游客：提示一句「重新登录后还停在当前页面」，然后弹登录',
      '【分享页认人】已登录时分享页顶部会说明「你已经登录，不用再登一次」，并给一个「看我的成绩」的入口；是分享者本人打开还会直接告诉他这是自己的链接',
      '【复制链接】成绩工具条加了「链接」（当前这一屏），投票区加了「复制链接」（当前这一条）',
      '【安全】链接里不带任何登录凭证；打开者用的是**自己的**身份，能看什么由服务端按他判，不会因为点了别人的链接就看到别人的东西'
    ], pub: [
      { cat: '体验', text: '登录一次全站通用：主页登过，分享页、时钟页都不用再登；换个标签页登录，这边自动跟着变' },
      { cat: '体验', text: '每个板块、每场成绩、每条投票都能变成一条直达链接，打开就落在那一页；地址栏会跟着你走，随时复制发人' },
      { cat: '体验', text: '需要登录的链接，登录完自动回到你原本要看的那一页，不用再点一遍；登录过期也一样' }
    ] },
  { version: '3.17.0', date: '2026-11-02', type: 'feat', title: '成绩 AI 可以导出，也能让本地 AI 按学号查', items: [
      '站主：「诊断能导出，设置（包括密钥）也能导到另一台设备；自己部署了本地 AI 的同学没有云端接口，就让它线上查数据再本地分析」',
      '【导出诊断】AI 卡底部新增「导出」：单份 / 全部（Markdown）。内容 = 元信息（考试、时间、模型、详细程度、目标）+ 正文 + 当时喂进去的那份数据，换台设备或换个模型都能复盘',
      '【设置迁移】设置弹窗底部新增「导出设置 / 导入设置」：一个 JSON 带走服务商、地址、模型、温度、详细程度、目标、提示词。密钥默认不写进文件，勾了才带，并在面板里明说「这文件等于账号密码」',
      '【下载兜底】浏览器不让下载时（微信内置浏览器常见），自动把内容复制到剪贴板并提示，不会点了没反应',
      '【给本地 AI 的说明书】一键生成 Markdown：接口地址、我的学号、访问密钥、要做什么、完整提示词、当前档位的标题骨架。发给 Ollama / LM Studio 这类本地模型，它就能自己查成绩再分析',
      '【后台：给本地 AI 的查询接口】成绩设置里新增区块：开关 + 一键生成/重置密钥 + 可直接打开的示例链接。接口按学号查单人，班级只给聚合值',
      '【匿名】接口返回里没有任何同学姓名，连「同学N」代号都没有，只有调用方自己填的学号；班级部分是均分、中位、分位、各科得分率、上线人数',
      '【安全】非管理员读成绩配置时不下发查询密钥；密钥重置后旧的立即失效；接口关闭时一律 403',
      '【安全】导出设置默认不含密钥；说明书里的密钥只有站主能生成，学生端拿到的是空位，需要站主单独给他'
    ], pub: [
      { cat: '成绩', text: 'AI 分析结果可以导出了：卡片底部点「导出」，能存成文件，单份或这次考试的全部都行；换设备也能把 AI 设置一起搬过去（默认不带走密钥）' },
      { cat: '成绩', text: '自己装了本地 AI 的同学：设置里有「给本地 AI 的说明书」，发给本地模型就能让它按学号查成绩、自己分析' },
      { cat: '安全', text: '导出的设置默认不含密钥；给本地 AI 的查询返回里没有任何同学姓名，班上只给均分、中位数这类汇总' }
    ] },
  { version: '3.16.3', date: '2026-11-01', type: 'feat', title: '成绩 AI 大改：单科、追问、目标、班级诊断', items: [
      '站主：「AI 分析还是不太够，我要能设详细程度、要单科的分析、要能跟它对话、要能把目标告诉它；全班成绩单下面也来一个」',
      '【详细程度】配置弹窗新增三档：简洁（300 字，只看结论）/ 标准（600–900 字）/ 详细（1200–1800 字，逐科拆到丢分结构）。选哪档，模型的输出结构和字数都跟着变',
      '【单科分析】我的画像 AI 卡上方加了「总览 / 单科」两个视角，单科里再点科目。单科的数据也备齐了：这一科的班排、班内最高最低、历次分数序列与波动',
      '【追问】卡片底部加对话输入框，回车即发。追问会带上这一场的数据和前面的对话（最近 4 轮），可以一直问下去；记录只存在内存里，刷新就清',
      '【目标】配置里可以写一句目标（如「下次进班级前 10」），每次分析都会带上，模型围绕目标算账而不是泛泛而谈；只存本机',
      '【整份提示词重写】参照网上几份成绩分析实现，把常见毛病写进硬规则：必须引具体数字、不许编作息心态、归因只能给「可验证的假设」、建议必须写清做什么做多少怎么检验、最多 3 条',
      '【成绩对比只给自己建议】以前 A 方 B 方各给一条建议，一半篇幅跟我没关系；现在读者固定是 A 方，「下一步」整段只写给 A',
      '【全班成绩单的班级诊断】成绩单末尾新增一张卡：班均/中位/极差、分位分布、各科得分率、上线人数、需关注名单（总分落后 + 单科拖后腿两条规则），以及最值得做的三件事',
      '【时钟】正计时默认只到秒（时:分:秒，过一小时自动补小时位），要看百分秒在「更多 → 计时」里打开',
      '【时钟】白噪音三个音源共用一个音量滑杆（默认 70%），拖的时候正在响的那几路实时跟着变 —— 之前写死 0.9/0.7/0.8，一开就跟听歌打架'
    ], pub: [
      { cat: '成绩', text: '成绩 AI 现在能选详细程度、能单独分析某一科、能追问、能记住你写的目标；成绩对比只给你自己出建议了' },
      { cat: '成绩', text: '全班成绩单下面新增「班级诊断」：谁需要关注、哪科是集体短板、这周最值得做什么' },
      { cat: '体验', text: '正计时默认只显示到秒，要看百分秒可以在设置里打开；白噪音可以调音量了，开小一点不影响听歌' }
    ] },
  { version: '3.16.2', date: '2026-11-01', type: 'improve', title: 'AI 结果可以一键复制', items: [
      'AI 分析结果底部加「复制」按钮：去掉 Markdown 标记后复制成纯文本，方便贴到备忘录或微信',
      '不支持剪贴板接口的老浏览器退回 execCommand 方案，再不行就提示「复制失败」，不会静默失败',
      '去掉本地规则版里和底部提示条重复的一句「不联网、不花钱、不把成绩发出去」'
    ], pub: [
      { cat: '体验', text: 'AI 分析结果底部多了个「复制」，点击就能把整段分析复制下来，贴到备忘录或微信里' }
    ] },
  { version: '3.16.1', date: '2026-11-01', type: 'feat', title: '成绩 AI 分析可以接真模型了（自带 Key）', items: [
      '站主：「程序里的 AI 分析能不能接入真实 API，用户可以填 API 信息，用自己的 AI」',
      '浏览器直连厂商接口，不经我们的服务器：实测 DeepSeek 的 CORS 放行，Key 不用经过 Worker，少一跳也少一个泄密点',
      '三档预设：DeepSeek / OpenAI / 自定义（任何 OpenAI 兼容地址），地址、模型、Key 都能自己填',
      'Key 只存本机 localStorage（XOR + base64 混淆，只为不在 devtools 里一眼看到明文），换设备要重填，不跟账号走',
      '姓名代号化：发出前把真名换成「同学N」，每次随机洗牌 —— 不按成绩排，否则模型能从「同学3 排第 3」反推；返回后本地换回真名',
      '系统提示词内置一套「带过十几届毕业班的老师」人设，用户可自行修改；输出固定五个 ## 小标题，前端切段映射回原卡片结构',
      '不替换而是叠加：没配 Key 的人完全不受影响，本地规则照旧跑；配了也要手动点「用 AI 重新分析」才发请求，不会一打开就烧额度',
      '同一场考试 + 同一份数据 + 同一套提示词只算一次（最多留 12 条），换 Key 自动清空缓存',
      '流式输出（SSE 逐字渲染、80ms 节流），切板块重绘后结果从内存接回，不会丢',
      '错误说人话：401 失效 / 402 余额不足 / 404 地址或模型名不对 / 429 太频繁 / 90 秒超时 / 连不上地址',
      '换考试自动清空上一场结果，不会把旧分析串到新数据上'
    ], pub: [
      { cat: '体验', text: '成绩分析的「AI 分析」现在可以接真的 AI 了：在卡片上点「先填密钥」，填自己的 DeepSeek 或 OpenAI 密钥，就能生成更具体的分析' },
      { cat: '安全', text: '发出去的数据里没有真实姓名 —— 模型只看到「同学1」「同学2」这样的代号，而且每次编号都是随机打乱的，本页再把名字换回来' },
      { cat: '安全', text: '密钥只存在你自己的设备上，不会传到别处；换手机或清浏览器数据要重填一次' },
      { cat: '其他', text: '没填密钥的同学完全不受影响，还是原来的本地分析，不联网、不花钱；填了也要自己点击才会请求，不会偷偷扣额度' }
    ] },
  { version: '3.16.0', date: '2026-11-01', type: 'feat', title: '翻页时钟有了翻页声（可关、可调音量）', items: [
      '站主：「大屏时钟翻页的时候，加个类似翻页的声音，音效也能选择是否开启」',
      '两种音色：纸页（Mixkit 免费翻页音效，截取单次翻页、去前后静音、95Hz 高通滤掉低鸣，32kbps 单声道只有 1.5KB）/ 咔哒（现场合成，带通噪声瞬态 + 低频下沉，更干脆）',
      '「更多」面板新增独立区块：关 / 纸页 / 咔哒 三档 + 0~100% 音量条，点音色立即试听，关掉后音量条自动变灰',
      '时机对齐：上半片 0~300ms 翻下、下半片 300~600ms 落回，声音延后 300ms 落在「下半片落下」那一刻；试听不延迟',
      '同一秒里时 / 分 / 秒三片一起翻只响一声，250ms 内的重复触发会被拦掉，不会叠成噪音',
      '每次播放给音高 ±5%、音量 ±10% 的随机，避免一秒一次的机械重复感',
      '刚进翻页模式那一帧只是落数字、没有翻页动作，用「上一帧是否已有值」排除，不会凭空响一声',
      '音频 base64 内嵌进页面，进翻页模式时预解码 —— 断网、弱网也照响，不额外请求任何文件'
    ], pub: [
      { cat: '体验', text: '翻页时钟新增翻页音效，采用翻页牌质感声音，非电子提示音' },
      { cat: '体验', text: '在时钟页右上角「更多」里可以选：关闭 / 纸页 / 咔哒，还能拖音量条，点击就能先试听' },
      { cat: '其他', text: '默认是开着的（纸页、55%）。教室里嫌吵可以选「关闭」，设置会记住，换设备各记各的' },
      { cat: '其他', text: '关掉秒显示之后每分钟才翻一次，响的次数也会跟着变少' }
    ] },
  { version: '3.15.9', date: '2026-11-01', type: 'style', title: '全站动效：展开、旋转都不再是「啪」一下', items: [
      '站主：「卡片的展开应该是一个动画过程，箭头也不是突然变向，要有个慢慢过渡的动画，现在全站都太生硬了」',
      '卡片展开：内容区从 display:none 硬切改成真实高度补间，实测 88 → 303px 用 350ms 连续长高；展开结束交回 auto，门禁验证后内容变多也不会被裁',
      '箭头：从字符 ⌄ 换成矢量图标，做成常驻的小圆扣，靠 transform 旋转 0 → 180°（460ms 回弹缓动）。以前一展开就 display:none，等于把旋转过程掐掉了 —— 这才是「突然变向」的真正原因',
      '折叠态与展开态改用同一个 display（原来 flex ↔ grid 切换，图标和标题会跳一下）；标题也不再从 flex 切 block',
      '堆叠：整栈高度也纳入过渡，展开一张卡时整沓跟着长高，不再是变量一变整个跳',
      '成绩卡片的折叠同样改成高度动画，hidden 语义保留（读屏仍会跳过折叠内容）',
      '其余硬切一并收敛：分类页淡入上浮、遮罩淡入、输入框边框光晕、侧栏与主题按钮颜色、主题切换过渡',
      '「减少动态效果」与「关闭动效」下全部关掉，卡片直接开合'
    ], pub: [
      { cat: '界面', text: '卡片展开现在是一段真的动画：框慢慢长高、内容跟着露出来，不再是「啪」一下弹开' },
      { cat: '界面', text: '卡片右上角那个小箭头会转着圈变方向，展开变向上、收起变向下，中间有过渡' },
      { cat: '界面', text: '切换板块时整页会轻轻淡入上浮，弹窗和侧栏的黑色背景也是淡进来的，不再突然变黑' },
      { cat: '界面', text: '成绩分析里的卡片折叠、输入框聚焦也都加了过渡，整站手感统一了一点' }
    ] },
  { version: '3.15.8', date: '2026-10-31', type: 'style', title: '卡片排版 / 堆叠 / 动效 / 字色整体精修', items: [
      '站主：「把卡片堆叠、动画、字色这些基础功能重新优化美化排版」',
      '排版：卡片原来是「图标 25% / 正文 50% / 按钮 25%」的三栏横排，正文被压在中间一小条、右边大片空白；改成两列网格 —— 图标一列、内容一列，按钮落在内容底部右对齐，标题重新成为视觉重心',
      '字色：重算三级文字色，落卡片底的对比度 15.4 / 9.4 / 4.9:1，全部过 WCAG AA；标题字距收到 −0.012em，正文行高 1.8',
      '堆叠：露出量 46 → 54px，层间再压低 0.4%，下层露出的「纸边」改成米色竖向渐变 + 细描边 + 落影，一沓卡片终于看得出是一叠纸',
      '修 bug ①：顶牌不是定位元素，JS 写的 z-index 对它无效，下层绝对定位的卡片反而画在顶牌上面 —— 卡片一展开，按钮就被那条纸边盖掉半个',
      '修 bug ②：在堆叠里展开/收起卡片后没重算整栈统一高度，卡片会被压成一条白边',
      '动效：去掉那张 6s 无限循环的扫光（廉价、老 iPad 还掉帧），换成一进场的错峰上浮；堆叠切换改成带回弹的缓动；系统「减少动态效果」和「关闭动效」下全部直接归位',
      '可访问性：补齐键盘焦点圈，按钮触控区统一不低于 44px'
    ], pub: [
      { cat: '界面', text: '卡片重新排了版：图标和标题在左，正文整栏排开，按钮收到右下角，页面不再大片留白' },
      { cat: '界面', text: '卡片堆叠重做了：一沓卡片的层次更明显，下层露出的纸边有了厚度感' },
      { cat: '修复', text: '在堆叠里打开卡片时按钮被遮住一半、卡片被压成一条的问题已修好' },
      { cat: '界面', text: '去掉了原来那张卡片上一直循环扫来扫去的光，动效更安静，老设备也更省电' }
    ] },
  { version: '3.15.7', date: '2026-10-30', type: 'fix', title: '卡片显示方式按设备记住', items: [
      '站主第三次反馈：iPad 上选了「全部展开」，一更新又变回小窗口 —— 老 iPad 折叠卡点不开，整页就无法用',
      '根因：normalizeUI 里压根没读 cardMode，每次加载都被重置成默认的「小窗口」；就算读了，这份配置也会被云端同步和「恢复默认」清掉',
      '修法：卡片显示方式和卡片堆叠都改成设备级记忆（cls_card_mode / cls_stack_mode），和轻量模式一个套路 —— 写过就永远以这台设备为准，跨版本升级、云端同步、恢复默认都不动',
      '老配置里存过「全部展开」的，升级后第一次打开会自动认出来并固化到这台设备，不用再点一次',
      '只影响本机，不会把手机上的选择同步到 iPad'
    ], pub: [
      { cat: '修复', text: '在设置里选了「卡片全部展开」，更新后不会再自己变回小窗口了' },
      { cat: '修复', text: '卡片堆叠/平铺同样按设备记住，手机上开了堆叠也不会影响平板' }
    ] },
  { version: '3.15.6', date: '2026-10-29', type: 'fix', title: '自定义字段显示中文名', items: [
      '站主：能勾的字段齐了，但分享页上「考籍号、身份证号」这些显示成了 exam_number / id_card 这样的英文字符名',
      '根因一：分享页只认得「勾选清单」里的中文名，清单外的字段一路兜底到英文键名',
      '根因二：「我的信息」那一栏给的是字段全集而不是勾选项，把没勾的字段也带出来了，自然只能显示英文',
      '修法：本人那一栏也只给勾选过的字段（和「查其他成员」口径一致）；同时后端把「字段 → 中文名」整本字典一起下发，分享页三层兜底，任何字段都不会再露出英文名',
      '以后在字段管理里起什么中文名，分享页就显示什么'
    ], pub: [
      { cat: '修复', text: '信息分享页上「考籍号、身份证号」等字段之前显示成英文名，现在是中文了' },
      { cat: '修复', text: '分享只展示你勾选的字段，没勾的不会再顺带露出来' }
    ] },
  { version: '3.15.5', date: '2026-10-28', type: 'fix', title: '分享字段跟着「字段管理」走', items: [
      '站主：「考籍号、身份证号后台压根没有选项可以勾」—— 分享的字段清单是写死的 12 项，字段管理里新增的字段从来没进过这份清单',
      '现在目录改成动态拼：基础 12 项 + 字段管理里的全部自定义字段，按 sort_order 排在后面，名字用你在字段管理里起的那个',
      '后台勾选框、分享页显示、后端取数三处统一走同一份目录，不会再出现「勾了拿不到」',
      '每个字段后面标出档案可见性（如「档案：仅管理员」），勾了也不会显示的字段当场就能看见，不用试',
      '以后在字段管理里加字段，分享这里自动多一项，不用改代码'
    ], pub: [
      { cat: '资料', text: '信息分享可以勾选的字段补齐了：考籍号、身份证号、发展团员编号等自定义字段现在都能放进去' },
      { cat: '资料', text: '勾选时会标注哪些字段在档案里设了可见性限制，避免勾了却不显示' }
    ] },
  { version: '3.15.4', date: '2026-10-28', type: 'fix', title: '用姓名也能登录', items: [
      '站主在「信息分享」页无法登录：页面提示「用户名：本人姓名」，但其账号为拼音，按提示输入中文姓名无法登录',
      '登录接口加了一层兜底：用户名查不到时，再按「姓名」找一次，全班唯一就放行 —— 同学记不住拼音也能登',
      '有多个同名账号时不再瞎猜，直接提示「请改用管理员给的登录名」',
      '分享页提示与报错文案改准确：用户名多数是姓名、个别是拼音；401 时顺带提醒「连错 5 次会锁 15 分钟」',
      '限流补了个口子：走姓名登录同样按真实账号计入锁定，换写法绕不过去'
    ], pub: [
      { cat: '修复', text: '信息分享页现在用姓名（或原来的拼音账号）都能登录，不用再猜用户名' },
      { cat: '修复', text: '登录失败时会提示用户名可能不是姓名，并提醒连错会被临时锁定' }
    ] },
  { version: '3.15.3', date: '2026-10-28', type: 'fix', title: '后台页面不再无限转圈', items: [
      '「信息分享」进不去、一直转圈，揪出来是两类原因：① 手机还停在旧版页面，旧代码一进这块就报错，圈留着不走了；② 接口偶尔被网络吞掉，请求既不成功也不失败，界面只能干等',
      '现在任何面板渲染出错都会换成一张说明卡，上面有「重试」和「强制刷新」，不会再让你对着圈子等四五分钟',
      '所有后台请求加 25 秒超时，超时明确提示「请求超时，请检查网络后重试」；连不上服务器也直接说连不上',
      '面板画不出来超过 12 秒自动兜底，切到别的面板不受影响',
      '版本号升到 3.15.3，缓存桶一起换新，装上新版后旧页面不会再被翻出来'
    ], pub: [
      { cat: '修复', text: '信息分享等页面之前会一直转圈加载不出来，现在出错会直接说明原因，并给出「重试 / 强制刷新」' },
      { cat: '修复', text: '网络不好时会提示「请求超时」，不再无休止地等待' }
    ] },
  { version: '3.15.2', date: '2026-10-27', type: 'fix', title: '成员资料导出补齐所有字段', items: [
      '导出时身份证号、发展团员编号曾经导不出来：表头是手写的，这两列被当成「表单固定列」排除掉了',
      '现在改成按字段元数据出列，导出会包含全部 13 个档案字段；以后新加的字段自动带上（考籍号已验证）',
      '导出提示改成「N 条记录 · M 个档案字段」，能直接核对列数'
    ], pub: [
      { cat: '资料', text: '成员资料导出现在会把身份证号、发展团员编号、考籍号等字段一起导出，以后新增的字段也会自动带上' },
      { cat: '修复', text: '修正导出表格漏列的问题，导出的列数与档案字段数一致' }
    ] },
  { version: '3.15.1', date: '2026-10-27', type: 'fix', title: '后台「信息分享」页修好', items: [
      '后台「内容 → 信息分享」点进去会报错打不开，已修复',
      '同学端「查其他成员」的名单改成内部滚动，人多的班级不会拉成一条长墙'
    ], pub: [
      { cat: '修复', text: '信息查询页的同学名单改为内部滚动，翻起来更顺手' }
    ] },
  { version: '3.15.0', date: '2026-10-27', type: 'feat', title: '个人信息分享：发链接，登录就能查资料', items: [
      '新页面 info.html：后台建一条分享，把链接或二维码发给同学，打开就能登录查询',
      '后台可单独设置开放「查自己的信息」/「查其他成员信息」；查其他成员还能逐字段勾选（学号、政治面貌、智学网账号、学校、班级、民族、出生日期、家庭住址、入团时间、微信、QQ、手机号）',
      '这套配置与档案编辑的字段可见性互不同步；档案里设成「仅本人 / 仅管理员」的字段，分享里勾了也不会漏',
      '必须先登录才能看；登录页下面直接写清用户名 / 密码怎么填，文案可在后台自定义',
      '支持有效期、最多打开次数、备注；列表里可复制链接、生成二维码、打开预览、编辑、撤销，并统计打开次数'
    ], pub: [
      { cat: '班级', text: '新增「个人信息分享」：由老师发出链接，用班级站账号登录后即可直接查看自己的资料，无需进入首页查找' },
      { cat: '安全', text: '可查询的内容逐项设定，链接必须登录后才能查看' }
    ] },
  { version: '3.14.1', date: '2026-10-27', type: 'fix', title: '个人明细的排版收一收', items: [
      '各科那一行改成两段：上面「科目 · 分数 · 与班均差」，下面一行右对齐的小字放「班内 / 年级名次 · 赋分变化」',
      '行之间加细线分隔，六科长短不一时也对得整齐，不会再看着像「下一科」'
    ], pub: [
      { cat: '界面', text: '点名字展开的明细重新排过：每科上下两行、行间有细线，分数和名次一眼对上' }
    ] },
  { version: '3.14.0', date: '2026-10-27', type: 'feat', title: '总分分布可以打开看人、看分', items: [
      '点总分分布里的任意一根柱子，下面列出这一分段有哪些人，按总分从高到低排（班排 + 姓名 + 总分），自己那行标「我」',
      '再点名单里某个人，展开他的总分（班排、与班均差）、年级 / 联考排名，以及六科分数',
      '每科带满分、与班均差、班内名次、年级名次；化学、生物还标出「赋分 79→85」的原始→赋分变化',
      '点同一根柱子或「收起」即可关闭；只重画名单那一块，手机上不会跳回顶部',
      '换「原始 / 赋分」口径时自动清掉已选的分段，避免看错口径'
    ], pub: [
      { cat: '成绩', text: '成绩分析的总分分布现在能点：点柱子看这个分段有谁（按总分从高到低），点名字看他的六科分数和各科名次' },
      { cat: '界面', text: '名单出在图的下方，点同一根柱子或「收起」即可关闭，不会整页刷新' }
    ] },
  { version: '3.13.1', date: '2026-10-26', type: 'fix', title: '收起界面时连底部工具栏一起收', items: [
      '进入极简态（开始计时后只留数字）时，顺手把底部工具栏也收掉，屏幕上真的只剩数字',
      '点屏幕底部那条仍能随时把工具栏开出来，右下角旋钮也照旧'
    ], pub: [
      { cat: '修复', text: '开始计时收起界面时，底部工具栏也会一起收掉，不会再压着数字' }
    ] },
  { version: '3.13.0', date: '2026-10-26', type: 'feat', title: '计时默认只留数字 · 点屏幕底部开工具栏 · 记录标设备', items: [
      '开始计时（正计时 / 倒计时 / 番茄钟）后界面自动收起，只留居中的数字和角落的「返回」「记录」；点空白处唤出按钮，8 秒不动自己收起，暂停和跑完自动展开',
      '这个收起行为是默认的，也可以在「更多 → 计时」里关掉；老配置升级上来先按新默认走一次',
      '屏幕最底下那条空白点击就能开 / 收底部工具栏，右下角的旋钮照旧能用',
      '使用记录里每段都标了设备（如「iPad · Safari」「安卓手机 · Edge」），汇总多一行「设备：…」，能看出在哪儿用的',
      '修：相邻但名字不同的两段记录不再被并成一行；合并后名字也不会丢'
    ], pub: [
      { cat: '界面', text: '开始计时后屏幕上只留数字，点击屏幕才出现按钮；想一直显示按钮可以在「更多 → 计时」里关掉这个收起' },
      { cat: '界面', text: '底部工具栏现在点屏幕最底下那条也能开，不用非找右下角的小圆钮' },
      { cat: '班级', text: '使用记录会标出这段是在哪台设备上记的（iPad / 手机），汇总里也能看到各设备用了多久' }
    ] },
  { version: '3.12.2', date: '2026-10-26', type: 'docs', title: '「更多」里的说明跟着改', items: [
      '「关于全屏时钟」那段还写着「外加秒表、倒计时和自习番茄钟」，和现在的结构对不上',
      '改成：时钟（数字 / 翻页）+ 计时（正计时 / 倒计时 / 番茄钟），并补上三种计时各自怎么用'
    ], pub: [
      { cat: '修复', text: '「更多」里的说明文字更新了，和现在的时钟 / 计时两种模式对上' }
    ] },
  { version: '3.12.1', date: '2026-10-26', type: 'fix', title: '开关看得见 · 轮盘自己拖', items: [
      '提醒和计时的开关原来是浅灰圆点，在白面板上几乎看不见；现在改成「开 | 关」两个并排按钮，选中那块上色（开=绿、关=灰）',
      '提前提醒的文案「结束前 5 分钟」改成「提前 5 分」，一行放得下不再折行',
      '时长轮盘不再依赖系统滚动，改成自己处理拖拽：iOS / iPad / 微信里都能滑，松手自动吸附，点某一格也能直接跳过去',
      '修掉一个隐患：只设过倒计时时长、没设过番茄时长的配置，会被迁移逻辑覆盖成 0'
    ], pub: [
      { cat: '修复', text: '设置里的开关改成「开 / 关」两个并排按钮，开是绿色、关是灰色，一眼能看出当前状态' },
      { cat: '修复', text: '时长的轮盘在 iPad 上能正常滑了（换成了自己实现的拖动）' }
    ] },
  { version: '3.12.0', date: '2026-10-26', type: 'feat', title: '时钟与计时分开 · 三种计时各归各位', items: [
      '顶层只剩「时钟」「计时」两个模式：时钟页上面切 数字 / 翻页，计时页上面切 正计时 / 倒计时 / 番茄钟',
      '刚进来都是 00:00（番茄钟仍是 25:00）；倒计时时长要自己滚轮盘设',
      '删掉 6 个预设格、快捷档和手动输入框，时长只靠轮盘；轮盘去掉 iOS 上会卡的 scroll-snap，改成滚完自动对齐，iPad 能正常滑',
      '「记一笔」只在正计时出现：点击把上一次记一笔到现在切一段并写备注，列表显示「00:00–05:00 数学 5 分钟」',
      '「开始计时后收起界面」做成可配开关（默认关），设置记在浏览器里，更新版本不会重置',
      '提醒开关改成绿「开」/ 灰「关」，响几遍选中项改成橙底白字，一眼能看出状态'
    ], pub: [
      { cat: '界面', text: '全屏时钟上面多了两排切换：时钟页是「数字 / 翻页」，计时页是「正计时 / 倒计时 / 番茄钟」，想用哪个点哪个' },
      { cat: '界面', text: '时长只用一个轮盘滚，iPad 上也能正常滑了；正计时里点「记一笔」会把这一段时间和备注记下来' },
      { cat: '修复', text: '提醒的开关现在能看出是开还是关（绿色开、灰色关），响几遍选中的那个也会高亮' }
    ] },
  { version: '3.11.1', date: '2026-10-26', type: 'fix', title: '计时跑起来只留数字 · 铃声放完再响下一遍', items: [
      '极简模式：开始计时后按钮 / 预设 / 科目 / 轮次条全部收起，屏幕只剩居中的数字和角落的「返回」「记录」；点击数字唤出操作区，再点收起',
      '暂停、跑完、重置会自动展开操作区；展开后 8 秒不动会自己收起',
      '铃声不再叠在一起：等这一遍真正播完、停 0.3 秒再放下一遍（原来固定 750 毫秒一遍，1 秒多的音频放不完就叠上了）',
      '响几遍能自己设：1~5 遍，默认 2 遍（「更多 → 提醒」最上面一行）',
      '记录抽屉按看的那天说话：昨天写「昨日自习 / 昨日休息 / 昨日番茄」，更早写「10 月 24 日 自习」'
    ], pub: [
      { cat: '界面', text: '开始计时后屏幕上只留数字和时间，点击数字才出现按钮；暂停或跑完会自动展开' },
      { cat: '修复', text: '到点铃声不再叠着响：等一遍放完再放下一遍，响几遍可以自己设' },
      { cat: '修复', text: '看昨天的记录时，卡片会写「昨日自习」而不是「今天自习」' }
    ] },
  { version: '3.11.0', date: '2026-10-26', type: 'feat', title: '计时三合一：倒计时 + 多轮循环 + 正计时', items: [
      '倒计时、自习（番茄钟）、正计时三合一：设了时长就是倒计时，时长为 0 直接打开始就是正计时；秒表的计次并进了「记一笔」',
      '多轮循环：开始前设「专注几轮 + 每轮休息多久」，跑起来自动 专注 → 休息 → 专注；休息时能改下一轮时长，也能直接结束',
      '6 个预设格：点击直接用，长按（桌面右键也行）把当前时长存进这一格，预设跟随账号同步上云',
      '时长选择换成轮盘：时 / 分 / 秒三列滚动吸附，另有 5·10·15·25·30·45·60 快捷档，也能直接打字（25 / 90s / 1:30）',
      '提醒可自定义：专注结束 / 休息结束 / 距结束 N 分钟三类，可同时开多条、各自选不同铃声，提前提醒最多三条',
      '「记一笔」：给这一刻写个名字并切一段，时间线按打点分开',
      '老的 ?m=pomo / ?m=stop 链接继续能用，一律落到「计时」；老配置自动迁移'
    ], pub: [
      { cat: '班级', text: '全屏时钟把倒计时、自习、正计时合成了一个「计时」：可以先设专注几轮、每轮休息多久，跑起来自己循环' },
      { cat: '界面', text: '时长可以用轮盘滚着选、也能直接打字，常用的 6 个时长存成预设点击就开始（跟着账号同步）' },
      { cat: '界面', text: '到点提醒能自己配：结束前几分钟、专注结束、休息结束，各用不同铃声；计时中点「记一笔」写下这一段在做什么' }
    ] },
  { version: '3.10.4', date: '2026-10-25', type: 'fix', title: '时钟记录多设备同步：换设备也能看到、不再被覆盖', items: [
      '修复「手机上记的自习记录，iPad 上没有」：以前新设备本地是空的，第一次落一段就把云端当天记录整条覆盖掉了（数据是从这里丢的）',
      '现在进页面先跟云端总拉一次（登录了才拉），拉完才允许推送；推之前还会先把这一天拉下来合并，两台设备各记各的也不会互相覆盖',
      '每 60 秒心跳推一次（带上正在计时的那一段），换设备近乎能实时看到',
      '时间到、点「返回」、切到别的应用都会立刻推一次，不用等切模式',
      '推送失败不再丢数据：放回队列 8 秒后自动重试（最多连试 5 次）',
      '未登录时照旧只记在本机，不碰网络'
    ], pub: [
      { cat: '班级', text: '全屏时钟的使用记录现在会自动同步：换设备打开也能看到之前的记录，切到别的应用、点返回、时间到都会立刻上传' }
    ] },
  { version: '3.10.3', date: '2026-10-25', type: 'fix', title: '提示音全换真实录音 · 工具栏常驻开关', items: [
      '全屏时钟提示音全部换成 Mixkit 免费音效的真实录音（叮咚 / 清脆 / 铃声 / 木鱼 / 嘀嗒），不再是合成的，声音厚实自然',
      '新增「蓝牙」提示音：两声连接提示音，时间到推荐，也是现在的默认音效',
      '修复 iPad 上工具栏收起后点屏幕展不开的问题：右下角加了常驻开关，箭头随手收起 / 展开翻转，点空白处也能展开',
      '音效与白噪音一样全部内嵌页面，微信里、断网都能正常播放'
    ], pub: [
      { cat: '班级', text: '全屏时钟提示音换成真实录音，新增「蓝牙」提示音；工具栏收起后右下角有常驻开关，随时打开' }
    ] },
  { version: '3.10.2', date: '2026-10-25', type: 'feat', title: '全屏时钟大更新 · 成绩分析动画与折叠', items: [
      '全屏时钟提示音升级：叮咚 / 清脆 / 木鱼 / 铃声 / 嘀嗒五种，点选即试听，可在「更多」里随时换',
      '新增白噪音：真实雨声 / 风声 / 海浪（免费可商用音效），可单个开也可多个混合，帮助专注或助眠',
      '底部工具栏加「▾」小箭头，点击立即收起，不用等自动隐藏',
      '倒计时、秒表、自习都能自定义名称，云端记录按「名称 · 类型」归类，后台可按事项查看',
      '自习还能点「语数英物化生 / 其他」七科选科目，再填这次做什么（如试卷、练习），记录按「科目 · 事项」分开统计',
      '时钟记录的日期可以自由选择（日历点选），不用再一天天翻',
      '时钟记录新增「总结」：周报 / 月报 / 学期报 / 自定义区间，可导出文字或图片',
      '总结报告含总时长、各分区时长、各科目总时长（自定义归到「其他」）、用得最久的一天，可实时预览并编辑标题、备注',
      '倒计时到点、自习阶段切换时，整屏弹出「时间到」提醒约 3 秒，文字可自定义',
      '修复成绩对比里「第二次考试」淡柱没有显示对应成绩、用了主柱成绩的问题',
      '成绩分析各小板块可折叠展开；图表动画改为「滚动到才播放、滚走重置、回来重播」，文字数字只在第一次跳动'
    ], pub: [
      { cat: '班级', text: '全屏时钟更新：新增多种提示音，倒计时、秒表、自习都能自定义名称，自习还能点选六科快捷记录' },
      { cat: '班级', text: '时钟记录支持自由选择日期，并新增「总结」：可导出周报、月报、学期报的文字或图片' },
      { cat: '班级', text: '倒计时到点、自习阶段切换时会整屏弹出「时间到」提醒' },
      { cat: '成绩', text: '成绩分析修复两次考试对比时柱子显示错误，各板块可折叠，图表动画改为滚动到才播放' }
    ] },
  { version: '3.9.26', date: '2026-10-25', type: 'style', title: '成绩分析的图表现在会「长出来」', items: [
      '总分分布的柱子从底下一根根长上来，柱顶的人数跟着浮现，均分 / 中位数 / 分数线在柱子长好后滑出',
      '个人画像的雷达图从圆心张开，班均虚线和得分点随后出现',
      '分数段横条、各科得分率条从 0 撑到实际长度',
      '表格与列表一行行落下来，概览里的均分、人数等数字从 0 滚到真实值',
      '轻量模式、自定义设置里的「精简动效」、系统「减少动态效果」三种情况一律不做动画，直接显示结果'
    ], pub: [
      { cat: '班级', text: '成绩分析的图表加了入场动画：柱子长起来、雷达张开、数字滚动' }
    ] },
  { version: '3.9.25', date: '2026-10-25', type: 'feat', title: '翻页动画重做 · 时钟使用记录（本地 + 云端 + 后台）', items: [
      '翻页时钟的数字现在跟着卡片一起翻：上半片翻下去的同时，新的下半片从后面翻上来，不再「翻完才跳一下」',
      '时钟页右上角多了「记录」，打开是右侧抽屉：当日各时段用途与时长一览',
      '自习会单独统计：今天一共自习多久、休息多久、用掉几个番茄',
      '登录后记录自动同步到云端，换设备也能看到；没登录就只记在这台设备上',
      '后台新增「安全 → 时钟记录」：按日期看谁在什么时候用了多久，点「明细」展开每一段',
      '「其他工具」里的番茄时钟卡片删掉了 —— 功能已经在全屏时钟的自习里'
    ], pub: [
      { cat: '班级', text: '全屏时钟新增「记录」：能看今天几点到几点用了多久，登录后自动上云' },
      { cat: '班级', text: '翻页时钟的数字现在会跟着卡片一起翻，不再翻完才跳' }
    ] },
  { version: '3.9.24', date: '2026-10-25', type: 'feat', title: '翻页时钟可关秒 · 新增自习番茄钟', items: [
      '翻页时钟多了一个「秒」开关：关掉后只剩「时 : 分」两张卡，卡片自动放大，更像桌面翻页钟',
      '新增「自习」模式：专注 25 分钟 → 休息 5 分钟自动循环，每 4 个番茄给一次 15 分钟长休息',
      '自习阶段结束会闪两下并振动提醒，然后自动进下一段继续走，不用一直守着',
      '记下今天完成了几个番茄，跨天自动清零；点数字可以改专注 / 休息时长',
      '「番茄时钟」卡片不用再跳外站了，直接打开站内自习模式',
      '横屏（手机转过来）时数字会自动收小，按钮不会被底部工具栏压住'
    ], pub: [
      { cat: '班级', text: '全屏时钟新增「自习」番茄钟，翻页时钟也能关掉秒了' }
    ] },
  { version: '3.9.23', date: '2026-10-25', type: 'fix', title: '卡片松一点 · 翻页时钟重做 · 全屏自动横屏', items: [
      '板块卡片放大一档（88px 高、图标 48px、圆角 20px），卡片之间留出 14px，不再挤在一起',
      '翻页时钟重做：数字不再压到卡片边缘，上下两半对得齐，中间冒号单独垂直居中',
      '点「全屏」会顺带把屏幕转成横屏（设备支持方向锁时）；不支持的会提示把手机横过来',
      '去掉了没什么用的音效开关（倒计时结束仍然会闪红提示）',
      '计时器默认只显示大大的倒计时数字，点击数字才出现「时 / 分 / 秒」设置',
      '时钟数字大小可调，四档：小 / 中 / 大 / 超大'
    ], pub: [
      { cat: '界面', text: '板块卡片放大了一点、间距松开了，没那么挤' },
      { cat: '班级', text: '全屏时钟改造：翻页数字不再压边、全屏自动横屏、数字大小可调，倒计时默认只看数字' }
    ] },
  { version: '3.9.22', date: '2026-10-25', type: 'feat', title: '卡片改小窗口 · 新增全屏时钟', items: [
      '所有板块的卡片默认收成小窗口：只显示图标和标题，一屏能看到更多入口',
      '点击卡片展开描述和按钮，再点击收起；视频类卡片保持整卡点击播放',
      '「自定义设置 → 动效 → 卡片显示」可以切回「全部展开」，选择会记在这台设备上',
      '其他工具新增「全屏时钟」：数字时钟 / 翻页时钟 / 秒表 / 倒计时四种模式',
      '时钟支持全屏、切换字体、切换背景色、12/24 小时、防息屏，空格开始暂停，数字双击进全屏',
      '时钟页「更多」里写明了是仿照 yingming006.cn/time 制作的'
    ], pub: [
      { cat: '界面', text: '板块卡片默认收成小窗口，点击展开详情；想全展开可在自定义设置里改' },
      { cat: '班级', text: '其他工具新增「全屏时钟」，有翻页时钟、秒表和倒计时，可全屏投屏' }
    ] },
  { version: '3.9.21', date: '2026-10-25', type: 'fix', title: '天气偶尔不显示温度的毛病修好了', items: [
      '逐小时天气：温度数据不完整时不再只给你一列「—」，会说明「温度暂时没取到」并给一个「重新获取」按钮',
      '修掉一个真 bug：时间列表回退时温度没跟着回退，于是出现「有时间、没温度」',
      '拿到的数据不完整就不再存缓存，避免一次坏数据卡住十分钟',
      '首页那个天气格子：接口偶尔抽风时保留上一次的温度，不再立刻变成横线；一分钟后再自动试一次',
      '网络不稳时直接显示上次的数据并注明，点击就能重新获取'
    ], pub: [
      { cat: '班级', text: '天气偶尔不显示温度的问题修好了，取不到时可以直接点「重新获取」' }
    ] },
  { version: '3.9.20', date: '2026-10-24', type: 'style', title: '输入框全部统一：同一个高度、圆角、边框和聚焦光晕', items: [
      '后台原来只有登录页的输入框有样式，绝大部分是浏览器默认外观；现在统一成 42px 高、12px 圆角、同一描边',
      '聚焦时统一变成橙色边框 + 一圈淡光晕，悬停也会轻微加深，一眼能看出哪里可以填',
      '下拉框去掉系统外观，换成同一个箭头；暗色下自动换成浅色箭头',
      '工具栏里的小输入框收到 34px 高，和旁边的按钮平齐',
      '前台把登录、我的资料、搜索、公告筛选、作业选择几套样式合并成一套（44px 高）',
      '公告搜索里的搜索框、板块筛选、时间筛选、日期范围现在一样高',
      '输入框里的提示文字、禁用状态、只读状态也统一了'
    ], pub: [
      { cat: '界面', text: '全站输入框统一样式，点进去时会亮起橙色边框' }
    ] },
  { version: '3.9.19', date: '2026-10-23', type: 'feat', title: '编辑不再看到符号 · 天气看未来 24 小时 · 字号能到 4px', items: [
      '后台「按日期临时改」的输入区换成所见即所得：屏幕上只有字，粗体就是粗的、大字就是大的、横线就是划掉的',
      '选中一段文字点 B / S / 字号就直接改这一段；同一个按钮再点一次就取消',
      '想在句子里加字，光标点进去直接打，前后格式不会乱',
      '日期列表里的摘要也只显示纯文字，不再露出 ** 和 {} 那些符号',
      '单字字号扩展到 4–32px（原来最小 14px）',
      '天气详情改成「从现在起 24 小时」，跨天会标出日期，标题写明是修水的天气'
    ], pub: [
      { cat: '班级', text: '今日事项的编辑不再显示符号；天气详情改成从现在起 24 小时' }
    ] },
  { version: '3.9.18', date: '2026-10-23', type: 'feat', title: '今日事项可以逐个字调字号 / 加粗 / 横线', items: [
      '「按日期临时改」下面多了一块「逐字设置」：文字被拆成一格格，点哪个字就只改那个字',
      '每个字能单独设字号（14–32px）、加粗、横线；同一个按钮再点一次就取消',
      '按住拖动可一次选一串；手机上按住一个字横向拖也行',
      '「清格式」只清选中的字，不影响其它字',
      '前台认同一套写法（{22b字}），后台预览和首页效果完全一致',
      '单日文字上限从 200 字放宽到 600 字，给标记留出余量'
    ], pub: [
      { cat: '班级', text: '今日事项可以逐个字调大小、加粗、加横线了' }
    ] },
  { version: '3.9.17', date: '2026-10-23', type: 'feat', title: '21 点后看明日事项 · 编辑器修好加粗与强调 · 可设字号', items: [
      '21:00 之后班级岛默认显示「明日事项」：明天有临时安排就用它，没有就自动取明天星期几的课表',
      '21:00 之后标签旁多一个「看今天 / 看明天」的小按钮，两个方向都能切，不额外占高度',
      '把页面挂到 21 点会自动切换（不用刷新）',
      '后台「按日期临时改」的加粗/横线按钮改成开关：同一处再点一次就取消（原来会一直叠加）',
      '整行强调（行首 #）加了底色与左侧竖条，预览和首页都能一眼看出区别',
      '新增字号设置（14–28px，默认跟随），只作用于那一天',
      '后台预览改成直接复用首页的样式，粗细/强调/字号所见即所得'
    ], pub: [
      { cat: '班级', text: '晚上 9 点后班级岛自动显示「明日事项」，也能点击切回今天' },
      { cat: '班级', text: '今日事项可以单独调字号；行首加 # 的那一行会高亮显示' }
    ] },
  { version: '3.9.16', date: '2026-10-23', type: 'fix', title: '横屏修好 · 更新不再看到旧版 · 首屏脚本瘦身', items: [
      '横屏重做：原来的「CSS 旋转」只是把 390 宽的页面转 90°，排版宽度没变，所以每一块都变成竖条、右半屏空白；现在改为全屏 + 系统方向锁，真的横过来，排版也按横屏重排',
      '锁不了方向的设备（如 iOS）不再假装横屏，直接提示「把手机横过来」，不会再出现半屏空白',
      '悬浮菜单不再跟着页面滚走：去掉 transform 旋转后按钮回到固定定位，任何滚动位置都能打开侧边栏',
      '「更新后还是旧版」：缓存桶原来写死 v173，新版本仍读旧 HTML；现在缓存桶跟着版本号走，升级后首次打开必然是新版',
      '首屏脚本压缩：app.js 328KB → app.min.js 192KB（gzip），源文件保留可读版',
      '后台拆包：admin.html 从 300KB 降到 31KB（gzip），脚本独立为 admin.js 可单独缓存',
      '新增 scripts/build.mjs：一条命令产出上述发布文件'
    ], pub: [
      { cat: '界面', text: '横屏查看修好了：整屏显示、排版会重新排，不再只显示半屏' },
      { cat: '界面', text: '侧边栏按钮在任何位置都能打开，不用先翻到最顶上' },
      { cat: '速度', text: '更新后打开就是新版本，不会再显示上一次的旧页面；首页加载也快了一半' }
    ] },
  { version: '3.9.15', date: '2026-10-23', type: 'feat', title: '手机端降密度 · 冒烟测试', items: [
      '手机端头部收成一行（班徽 + 标题/副标题 + 主题按钮）：高度约 176px → 62px',
      '手机端班级岛把四个信息块折成一行「时间 · 天气 · 周数 · 学期」，点「详情」才展开；高度约 177px → 107px，位置仍在公告上方',
      '公告栏标题/计数/按钮允许换行，不再把「公告」两个字挤成竖排',
      '给左上角悬浮菜单留出位置，不再压住班徽',
      '接口域名提前握手（preconnect），首屏少一次 TLS 往返',
      '统计脚本同一会话只加载一次，刷新不再重下 70–144KB',
      '新增 test_ui.mjs：真跑浏览器验证首屏密度、展开收起、老内核滑块、轻量模式、断脚本兜底、基础版，共 19 项'
    ], pub: [
      { cat: '界面', text: '手机上标题更紧凑，班级岛默认只显示一行，点「详情」可展开' },
      { cat: '界面', text: '公告栏标题不再被挤成竖排，公告区更清爽' }
    ] },
  { version: '3.9.14', date: '2026-10-23', type: 'perf', title: '首屏不再「跳一下」', items: [
      '班级岛改为先占位再显示：以前它等数据回来才出现，会把整页顶下去约 176px（布局跳动 0.25，属于「差」）'
    ], pub: [
      { cat: '速度', text: '打开首页时内容不再上下跳动，视觉更稳定' }
    ] },
  { version: '3.9.13', date: '2026-10-23', type: 'perf', title: '首屏班徽不再走服务器', items: [
      '首页顶部还有一处内联脚本冷启动就拉服务器代理的班徽（110KB、约 3 秒），改为直接读站内 28KB 版本'
    ], pub: [
      { cat: '速度', text: '首页右上角班徽不再拖慢打开速度' }
    ] },
  { version: '3.9.12', date: '2026-10-23', type: 'perf', title: '班徽压到 28KB', items: [
      '班徽原图是 256×256 但没压缩（110KB），且要经服务器代理（约 3.8 秒）；改为同源 128 色版本 28KB，画质不变',
      '轻量模式也直接用这张小图，不再走网络代理'
    ], pub: [
      { cat: '速度', text: '首页班徽加载更快，打开时少等一会儿' }
    ] },
  { version: '3.9.11', date: '2026-10-23', type: 'perf', title: '图标本地化 · 同步真增量', items: [
      '首页板块图标原先用图床原图（单张最大 238KB，五张合计约 412KB），改为站内 96px 版本，合计约 30KB',
      '图标加懒加载与固定尺寸，既省流量也减少布局跳动',
      '内容增量同步真正生效：内容没变时只回 125 字节（原来是每次都回 16.6KB），并修掉时间戳解析失败导致「增量恒失效」的问题'
    ], pub: [
      { cat: '速度', text: '首页图标改为站内小图，打开更快、更省流量' },
      { cat: '速度', text: '页面自动同步最新内容时更省流量，不再反复下载同一份数据' }
    ] },
  { version: '3.9.10', date: '2026-10-22', type: 'perf', title: '缓存优先秒开 · 老 iPad 修复 · 口令出库', items: [
      '首屏真正走缓存：Service Worker 从「网络优先」改成「缓存先给、后台再刷」，app.js 也进了预缓存 —— 以前每次进站都要重新下 325KB',
      '静态脚本改空闲加载：统计脚本延到页面加载完再拉，轻量模式下直接不加载（省约 144KB）',
      '窄屏班级岛改 2×2 两行，字号回到看得清（原来标签被压到 8px）',
      '老 iPad 修复：字号滑块同时支持触摸/鼠标（iOS 13 以下没有 PointerEvent，所以拖不动）',
      '老内核兜底：补齐 closest / fetch 等基础 API，并加启动看门狗 —— 12 秒内没渲染出来会给提示和「基础版」入口，不再白屏',
      '新增基础版页面：纯静态、不加载任何特效，只显示公告与今日事项，旧设备可直接打开',
      '轻量模式进一步减负：不拉天气、不拉网络语录、不下载 110KB 的班徽代理图、不加载统计脚本',
      '安全：管理员口令从仓库与工作流里彻底移除，改由 GitHub Secrets / 本机文件提供；备份工作流未配置时自动跳过',
      '部署门禁新增四道：资源发布清单完整性、体积预算、重复函数定义、明文口令扫描',
      '后台重复定义的心跳函数已删除（此前每进一次后台会多一个 60 秒定时器）'
    ], pub: [
      { cat: '速度', text: '再次打开页面基本秒出，内容会在空闲时自动更新到最新' },
      { cat: '界面', text: '小屏手机上班级岛改为两行显示，字更大更清楚' },
      { cat: '班级', text: '旧设备打不开时可以用「基础版」查看公告和今日安排' }
    ] },
  { version: '3.9.9', date: '2026-10-22', type: 'fix', title: '备份去重：同一版本只留一份', items: [
      '站主反馈「别备份重了，比如 3.9.8 后台就备份了 3 次」—— 部署前门禁、GitHub Action、定时任务三条路都会触发备份',
      '现在同一版本只留一份：已有就跳过；如果自动备份先到、部署前备份后到，把那一份升级成 predeploy（保留部署前状态）',
      '清理策略同步收紧：同版本最多 1 份（原来 3 份），历史重复会在下次备份时自动收掉',
      '已手动清掉 3.9.8 多出来的 2 份，现在每个版本只有 1 条'
    ], pub: [
      { cat: '安全', text: '云端数据每天自动保存一份，版本更新时不再重复保存，占用更小' }
    ] },
  { version: '3.9.8', date: '2026-10-22', type: 'perf', title: '首屏秒开 · 逐小时天气 · 一言分类 · 自动备份', items: [
      '首页脚本拆成独立的 app.js（defer）：HTML 只剩骨架 + 样式（约 89KB，原来 413KB），先把头部和骨架画出来，脚本随后加载再填充内容',
      '首屏加了骨架卡（公告三条 + 板块四张），加载期间不再是空白一片',
      '班级岛「天气」可以点了：弹层里按小时列出当天温度、天气、降水概率，当前小时高亮，数据缓存 10 分钟',
      '每日一言后台可以选择只显示哪几类（动画/漫画/游戏/文学/原创/网络/其他/影视/诗词/网易云/哲学/抖机灵），不勾的不拉',
      '每日一言卡片可以点：点击换一句新的（本地库模式下会提示不联网）',
      '今日事项支持按字排版：选中文字点「加粗」「加横线」，行首加 # 表示整行加粗并居中；后台下方有和首页一致的预览',
      '课程信息默认就是加粗态；临时改的那天也可以单独取消加粗',
      '备份补齐：Worker 的定时任务现在会真的写全量快照（以前只备成绩），另外每次 push 触发一次 GitHub Action 备份'
    ], pub: [
      { cat: '速度', text: '首页打开更快：先显示页面骨架，内容随后自动填充' },
      { cat: '班级', text: '点班级岛的天气可以看当天每小时天气；每日一言点击换一句' },
      { cat: '班级', text: '今日事项支持部分文字加粗、加删除线，考试安排更醒目' }
    ] },
  { version: '3.9.7', date: '2026-10-22', type: 'feat', title: '班级岛回到深色玻璃 · 编辑实时保存 · 可设加粗居中', items: [
      '班级岛样式回到最初那版深色玻璃（深棕渐变 + 半透明白卡 + 白字 + 右上角橙色光晕），昼夜都保持这块深色玻璃',
      '班级岛编辑改为实时保存：开关、学期、照片、七天横幅、组件、日期、假期，改完 650ms 自动写入，不再有保存按钮；顶部只显示「保存中 / 已自动保存 14:09 / 失败点此重试」',
      '按日期临时改可单独设「加粗」与「是否居中」：当天有几节课要考试时，勾上加粗就能在首页更醒目；不勾居中就左对齐',
      '后台文本框实时套用加粗/居中，看到的就是同学看到的样子；日期条目上会标「粗」「左」',
      '今日事项照片挪到面板第二块并带缩略图预览：地址有效才显示图，填错不会有坏图',
      '还没配照片时，管理员点首页今日事项会给出去处提示',
      '离开页面前会把没来得及发出的改动补发，不会因为马上关掉而丢'
    ], pub: [
      { cat: '班级', text: '班级小岛回到深色玻璃样式；当天有考试时可加粗显示，更醒目' },
      { cat: '班级', text: '小岛编辑改为实时保存，改完不用再点保存' }
    ] },
  { version: '3.9.6', date: '2026-10-22', type: 'feat', title: '班级岛改气泡玻璃 · 点横幅看照片 · 横屏侧栏修复', items: [
      '班级岛换回气泡玻璃质感：半透明白/黑底 + 模糊 + 内高光，昼夜两套自动适配，四个信息块做成半透明小气泡',
      '四个信息块字号按屏幕宽度分三档收小，窄屏（≤360）下「22° 多云」这类最长文案也能完整显示',
      '星期横幅收回单行（它就是默认课表）；「按日期临时改」保留多行输入，并新增「填入当天课表」按钮：一键带出当天课表，改一两个字即可',
      '已设置的临时安排、假期都能打开再次修改；假期多一个「复用」，复制到表单改日期即可再加一段',
      '今日事项照片：后台填直链或仓库相对路径，同学点首页「今日事项」那一行本页弹图，支持双指/滚轮/双击缩放、拖动、✕ 或 Esc 关闭',
      '横屏界面滚到中间点不到侧边栏：主站悬浮按钮与后台顶栏改为跟随滚动补偿，任何时候都钉在屏幕左上角'
    ], pub: [
      { cat: '班级', text: '班级小岛改为气泡玻璃样式，小屏手机也能完整显示；点「今日事项」可查看当天照片' },
      { cat: '界面', text: '横屏查看时侧边栏按钮固定在屏幕左上角，随时可以打开' }
    ] },
  { version: '3.9.5', date: '2026-10-22', type: 'fix', title: '班级岛跟随主题配色 · 内容居中', items: [
      '班级岛原来写死深棕底 + 白字，白天模式下像一块黑板贴在奶油色页面里',
      '现在浅色用奶油渐变底 + 深字、深色用深棕底 + 浅字，标题 / 数值 / 横幅 / 页脚的字色统一跟着昼夜主题走',
      '班级岛内所有内容居中：四个信息块、今日事项横幅（标签 + 文字）、底部日期与周数',
      '横幅文字多行时逐行居中，换行展示不受影响'
    ], pub: [
      { cat: '界面', text: '首页班级小岛改为跟随昼夜主题的配色，内容统一居中' }
    ] },
  { version: '3.9.4', date: '2026-10-21', type: 'fix', title: '首屏不再等接口 · 横幅支持换行', items: [
      '进页面要等 10 秒才出内容：根因是首屏原来只有「等 /api/boards 接口回来才渲染」一条路，接口慢（Cloudflare Worker + 数据库冷启）时公告/日报/板块卡片全是空的',
      '现在启动时先用页面自带数据 + 本地缓存同步画一屏，接口回来再原地刷新，弱网下也是秒开',
      '统计脚本改为异步加载，不再拖住页面加载完成事件',
      '班级岛横幅支持换行：后台文本框改成可拉伸的多行输入，前端按换行原样展示，写长一点也不会被截断'
    ], pub: [
      { cat: '界面', text: '首页打开即显示内容，不再长时间停留加载页' },
      { cat: '班级', text: '「今日事项」横幅支持换行，内容长时自动换行显示' }
    ] },
  { version: '3.9.3', date: '2026-10-21', type: 'feat', title: '班级岛收敛成「今日事项」横幅', items: [
      '班级岛第二行不再是一排课程格子，改成一行横幅：今日事项 升 数数语英化 物物体劳 听自语语自',
      '横幅按星期配：周一到周日各一句，周六周日默认也有课；后台直接改文字，不用按节次录课',
      '支持提前改某一天：星期五就能把周六周日的横幅先写好；考试当天直接写「数学 08:00-09:30」，勾上「不上课」就按放假显示',
      '假期区间：后台填寒假 / 暑假 / 小长假的起止，期间横幅自动变成「已放假 N 天 · 距开学还有 M 天」，不再显示课表',
      '课表弹窗整个下线（不再需要打开看整周），班级岛高度从四行压到两行',
      '仅赋分排名：每格改成「+24 → 84」，左边是增值、右边是赋分，两种颜色区分；排名仍按两科合计增值',
      '老版本存的完整课表会自动压成缩写，不用重新录'
    ], pub: [
      { cat: '成绩', text: '「仅赋分排名」改为只看两科赋分增值，按合计增值排名' },
      { cat: '班级', text: '首页班级小岛改为「今日事项」横幅：直接显示当天上什么课；放假期间显示已放假天数与开学倒计时' },
      { cat: '界面', text: '课程表一页看完，不用左右滑动找日期' }
    ] },
  { version: '3.9.2', date: '2026-10-21', type: 'fix', title: '仅赋分排名：默认涨得多的在前、五列一屏放下', items: [
      '「仅赋分排名」默认排序反了：原来按合计增值升序，涨得最多的排在最后一行',
      '现在默认按两科合计增值从高到低，与「排名」列一致；点表头才切成升序',
      '表格原来跟着全班成绩单撑到 620px 宽，手机上「合计」「排名」要横滑才看得见；现在五列一屏放得下',
      '表头精简为「化学增值 / 生物增值 / 两科合计 / 排名」，前三名带奖牌'
    ], pub: [
      { cat: '成绩', text: '「仅赋分排名」改为只看两科赋分增值，按合计增值排名' }
    ] },
  { version: '3.9.1', date: '2026-10-21', type: 'fix', title: '课表弹窗改实底 · 行高再压一档', items: [
      '课表弹窗原来是全站统一的玻璃底，表格行压在半透明背景上，和背后的公告糊在一起',
      '现在这一处改成实底（亮色近白、暗色深灰），并关掉背景模糊，文字边缘干净',
      '行高从 26px 压到 23px、上下内边距减半，15 节课的完整一天从接近满屏降到约 6 成屏高'
    ], pub: [
      { cat: '界面', text: '课程表一页看完，不用左右滑动找日期' }
    ] },
  { version: '3.9.0', date: '2026-10-21', type: 'feat', title: '作息可多套 · 考试与放假覆盖 · 班级岛改版', items: [
      '仅赋分排名改成「只比增值」：化学增值、生物增值、两科合计增值 + 按合计增值的名次（前三名带奖牌），不再重复显示分数，要看分数去上面的全班成绩单',
      '作息表支持多套：周一至周五、周六、周日各一套，节次时间互不影响；后台可新建 / 复制 / 改名 / 删除，最多 6 套',
      '周课表按天绑作息：周一到周日各选一套，周六周日的作息不一样也不用挤在同一张表里',
      '特殊日程按日期区间覆盖：放假（10-23 到 10-25 一条就放掉三天）、考试（填科目和起止时间，当天岛上只显示考试安排）、临时换作息',
      '前台班级岛：当天是考试就显示科目与时间，放假就显示假期名称与区间，不再硬按「周六周日」判断',
      '课表弹窗重做：改成「今天 / 周一…周日」页签 + 一行一节（时间 · 节次 · 科目），高度从原来的整屏压到 70% 以内、内部滚动；今天那一节橙色高亮',
      '课表弹窗里考试日显示考试科目与时间，放假显示放假区间，不再显示空课表',
      '班级岛默认数据按站主 2026-10-21 提供的《高二五班 2026 秋季课表》录入，后台点格子即可改'
    ], pub: [
      { cat: '成绩', text: '「仅赋分排名」改为只看两科赋分增值，按合计增值排名' },
      { cat: '班级', text: '首页班级小岛直接显示当天课程与时间；考试、放假期间显示相应安排' },
      { cat: '界面', text: '课程表一页看完，不用左右滑动找日期' }
    ] },
  { version: '3.8.9', date: '2026-10-21', type: 'fix', title: '课表弹窗一屏放得下', items: [
      '课表弹窗原来给表格设了 640px 最小宽，手机上只能看到周一周二，得横滑才知道后面还有五天',
      '现在改成自适应列宽：作息列 78px，周一到周日均分，390px 宽的手机一屏能看全；课名过长自动省略',
      '作息列的字也调小了一档，早读、上午第几节、几点到几点都在两行内'
    ], pub: [
      { cat: '班级', text: '首页新增班级小岛：显示时间和当天课程，打开能看整周课表' }
    ] },
  { version: '3.8.8', date: '2026-10-21', type: 'fix', title: '班级岛小修：学期名不再被截断', items: [
      '手机上第一行四个格子挤，学期名「2026 年秋季 · 高二上」被截成「秋季 · …」；现在只取最后一段，显示「高二上」',
      '「今天放假 ing」那一条底色太暗，看着像禁用按钮；改成亮一点的虚线块',
      '课表弹窗和后台课表里，早读那行原来重复显示成「早读 早读」，现在同一名称只显示一次'
    ], pub: [
      { cat: '班级', text: '首页新增班级小岛：显示时间和当天课程，打开能看整周课表' }
    ] },
  { version: '3.8.7', date: '2026-10-21', type: 'feat', title: '仅赋分排名 · 作业导出带二维码 · 班级岛', items: [
      '成绩分析：「全班成绩单」下面新增「仅赋分排名」，固定看化学 + 生物。两行表头分组（化学 / 生物 / 两科合计），每格大字是分数、右下角小字是该科班内排名；「变化」= 原始合计排名 − 赋分合计排名，红色 +n 是赋分后前进（占便宜），绿色 −n 是倒退（吃亏）',
      '作业导出：字号放大一档（正文 14→16.5，行高 30→36），宽高比优先一张 A4（内容少补白、多了自然延长）',
      '作业导出底部印「作业查看」的分享二维码，扫码直达这张卡片；游客态其它入口置灰、可一键登录，登录后自动解锁并回到原位置',
      '作业里的图片直链直接画进长图（先 fetch 成 blob 再画，避开跨域污染；失败退回文字），音频/视频转二维码，扫码站内播放',
      '所有二维码导出图（含后台「保存二维码」那张）都带班徽署名，班徽放在二维码下方，不遮挡定位角',
      '首页新增「班级岛」：位于公告上方，第一行时间 / 天气 / 周数 / 学期，第二行当日课程，当前节高亮；打开看整周课表 + 作息时间；没课显示「放假 ing」',
      '后台新增「班级岛」页签：组件可拖动排序 / 移除 / 加回，课表按格子录入，作息逐节可改（含大课间、晚饭这些不排课的时段），周六周日是否上课单独开关'
    ], pub: [
      { cat: '成绩', text: '成绩分析新增「仅赋分排名」：化学和生物两科，看原始分、赋分和名次变化' },
      { cat: '作业', text: '作业导出的图片字更大了，底部有二维码，扫码直接进作业查看' },
      { cat: '班级', text: '首页新增班级小岛：显示时间和当天课程，打开能看整周课表' }
    ] },
  { version: '3.8.6', date: '2026-10-20', type: 'fix', title: '扫码播放页不再被登录提示挡住', items: [
      '扫码打开 ?play= 播放页时，此前会弹出登录引导与开屏公告，遮挡播放器',
      '现在把「分享链接（?t=）」和「播放页（?play=）」统一当成深链入口：不弹开屏、不推销登录，直接给内容'
    ], pub: [
      { cat: '作业', text: '导出的作业图片里，图片直链会直接显示，音频和视频会变成二维码，扫码就能播放' }
    ] },
  { version: '3.8.5', date: '2026-10-20', type: 'feat', title: '作业导出图带直链 · 修分享链接 404', items: [
      '作业导出图片：作业里的图片直链直接把图draw进长图（先 fetch 成 blob 再画，避开跨域污染 canvas；取不到就退回一行文字，绝不毁整张图）',
      '音频 / 视频直链变成二维码，扫码打开站内播放页，直接播放，不用下载、不用跳第三方',
      '正文里直接写出来的直链也会识别：图片画出来，音视频转二维码，其它链接保持原样',
      '修：后台生成板块分享链接时用了 location.origin 拼地址，站点在 /class-site/ 子路径下会丢掉这一段，打开就是 GitHub 404',
      '现在按当前页面地址解析（和成绩分享同一套写法），预览 / 微信打开都能到正确的页面'
    ], pub: [
      { cat: '作业', text: '导出的作业图片里，图片直链会直接显示，音频和视频会变成二维码，扫码就能播放' },
      { cat: '班级', text: '板块分享链接现在可以正常打开了' }
    ] },
  { version: '3.8.4', date: '2026-10-20', type: 'feat', title: '板块管理 · 板块分享链接', items: [
      '新增「板块管理」：改名、写简介、调顺序、隐藏、单独控制游客可见；改完立刻全站生效，不用发版',
      '后台会列出每个板块的位置（首页第 N 项 / 侧栏第 N 项）和它下面的卡片；以后新增板块，首页登录打开一次就自动出现在列表里',
      '板块分享：可为整个板块或单张卡片生成链接。链接只带 token，不带任何内容快照 —— 每次打开都从数据库现取，改完内容不用重发链接',
      '生成时可设：是否允许未登录访问、有效期（永久/7/30/90/自定义）、最大查看次数、备注',
      '游客态：只放行这一条链接指向的板块；其它板块与卡片置灰，点击弹提示「当前分享链接仅支持查看该分享内容，其他内容请登录后再查看」',
      '登录用户点链接直接进；被拦下来的同学登录后自动回到原位置（首次强制改密也走完再回跳）',
      '二维码离线生成（内联 qrcode-generator，不依赖外部接口）；分享图含班徽、板块名、简介、二维码',
      '访问统计：次数、最近打开时间；登录用户记名，未登录访客记 IP 便于排查异常',
      '「成绩分析」在板块管理里置灰，提示用前台成绩分享那边，不做两套'
    ], pub: [
      { cat: '班级', text: '新增板块分享链接：打开即可直达指定板块，内容始终是最新的' },
      { cat: '界面', text: '板块名称和简介可以随时修改；分享页里其它板块会置灰并提示登录' }
    ] },
  { version: '3.8.3', date: '2026-10-20', type: 'fix', title: '我的资料字色加深 · 分享按钮手机端重排', items: [
      '「我的资料」看不清的根因：弹窗是玻璃底，半透明白叠在页面背景上实际是中灰（实测约 rgb(194,193,193)），原来的说明文字 #a99a8d、只读框 #6e635a 压上去只有 2.9～4.2',
      '按 WCAG 4.5+ 重新取色：说明文字、字段标签、只读输入框、仅自己可见标签、复制按钮全部加深，暗色模式同步调整',
      '顺手把「管理员确认后生效」改成「站主确认后生效」，同学看得懂',
      '「分享成绩」按钮溢出的根因：.btn-sm 这个类从来没定义过，用的还是 .btn 的 10px 24px 内边距 + 130px 最小宽，三个按钮排一行必然超出屏幕',
      '补上真正的小号按钮样式，并把每条分享改成两行：上行状态 + 备注标题（超长省略）+ 看过次数，下行按钮组；560px 以下按钮等分铺满，不再需要左右滑动'
    ], pub: [
      { cat: '资料', text: '说明文字和只读项的显示已加深，亮色、暗色下都看得清' },
      { cat: '成绩', text: '「分享成绩」的按钮在手机上重新排版，不用左右滑动就能看全' }    ] },
  { version: '3.8.2', date: '2026-10-20', type: 'fix', title: '离线缓存终于真的装上了', items: [
      '找到「缓存一直用不上」的根因：Service Worker 安装时要求预缓存清单**全部成功**，而清单里有长期 404 的 badge.png，于是整个安装失败 —— SW 根本没装上，缓存策略自然全都没生效',
      '改成逐个文件缓存、缺哪个跳过，SW 现在能正常安装并接管页面',
      '实测：把 HTML 网络直接掐断，页面仍能在 0.2 秒内从缓存打开',
      '配合 3.8.0 的 900ms 导航策略：慢网下不再每次白等整页下载'
    ] },
  { version: '3.8.1', date: '2026-10-20', type: 'fix', title: '切昼夜后弹窗里的字也跟着变', items: [
      '修一个边界：手动切到暗色时，弹窗里之前按亮底写进去的深色字会留在原地（内联优先级高于样式表），整段看不见',
      '现在同时盯着 <html> 的 class 变化，切昼夜后立刻重算一遍弹窗字色'
    ] },
  { version: '3.8.0', date: '2026-10-20', type: 'feat', title: '分享链接可写备注 · 我的资料改版 · 回前台不再白等', items: [
      '成绩分享：生成链接时可以写一句备注（最多 40 字），「我建过的分享」里直接把它当标题显示，建了很多条也认得出哪条是哪条',
      '备注只有你自己看得到，不会跟着公开链接发给别人（后端读取时已剔除）',
      '「我的资料」改版：一行一个输入框，和微信号/QQ 那块同款。可编辑的带 ✏️ 直接改，不可编辑的变灰带 🔒，右侧一键复制',
      '改完点「保存修改（N 项，需管理员确认）」一次性提交，仍然走信息审核；长号码（身份证/考籍号）不会再被挤成竖排',
      '快：页面导航改成「最多等 900ms 的网络优先」—— 网慢时直接用本地缓存先打开，网络结果在后台更新，下次即最新',
      '也就是说从后台切回前台、再打开站点，不用每次都白等整页 HTML 重新下载'
    ] },
  { version: '3.7.6', date: '2026-10-20', type: 'fix', title: '弹窗里的字色也会跟着背景自动调整', items: [
      '问题：页面上的字看得清，但弹窗里有些字看不见 —— 弹窗有自己的底色，没写颜色的文字会继承页面字色，深底 + 深字就糊成一片',
      '现在每次打开弹窗都会按「实际底色」（含半透明层、渐变、自定义背景图的平均色）算一次对比度',
      '只有真的看不清（低于 4.0）才改成近黑或纯白；原本清晰的品牌色、强调色一个字不动',
      '实时跟随：开关弹窗、切昼夜、换背景、转屏都会重算',
      '顺手修了「今日班级签」标题在亮色主题下深字压深底的问题（那块底色是固定深色渐变）'
    ] },
  { version: '3.7.5', date: '2026-10-20', type: 'fix', title: '公告规则细化：只有前两位版本号变了才发', items: [
      '按站主说明调整：3.7.0 → 3.7.1 这类只改最后一位的修复，不再给同学发公告',
      '前两位变化（如 3.6 → 3.7）仍然必须发公告，格式「v3.7 更新！内容如下：」，没发就不许部署',
      '顺手把 3.7.1 ~ 3.7.4 那几条补丁级公告合并成一条「v3.7 更新！」，按类别写好、简短',
      '部署门禁 scripts/predeploy.mjs 已按这条新规则校验（只匹配前两段，不会拿补丁号的旧公告顶替）'
    ] },
  { version: '3.7.4', date: '2026-10-20', type: 'fix', title: '班徽图片真正能用了（修二进制被当文本）', items: [
      '找到班徽一直「看着下载了却显示不出来」的根因：后端把图片二进制当文本传送，PNG 文件头被改成替换字符，浏览器根本解不开',
      '后端改为二进制透传，现在 /api/badge 返回的是一张真正的 PNG（约 200KB）',
      '首页班徽、导出图片右上角的班徽都恢复正常'
    ] },
  { version: '3.7.3', date: '2026-10-20', type: 'fix', title: '首页班徽改走 fetch（不再掉到 6MB 原图）', items: [
      'v3.7.2 实测发现问题：直接给图片标签指到跨域接口，部分网络下会加载失败，于是掉到图床那张 6.3MB 的原图，反而更慢',
      '改成用 fetch 取图（和导出图片缓存同一条路，稳定），拿到就存成本地缓存',
      '效果：首页班徽现在只有约 200KB，之后连请求都不用发；导出图片也用同一份缓存'
    ] },
  { version: '3.7.2', date: '2026-10-20', type: 'fix', title: '首页班徽不再退到 6MB 原图', items: [
      '上次实测发现：代理偶发失败时会退回图床原图（6.3MB），手机上一张图拖慢首屏',
      '改成失败先重试一次代理，实在不行才用它；正常情况只有约 200KB',
      '本地缓存优先级仍最高：登录时存过班徽的设备，首页直接读缓存，零请求'
    ] },
  { version: '3.7.1', date: '2026-10-20', type: 'fix', title: '班徽不再拖慢首屏', items: [
      '页头班徽不再直接请求站点图片（GitHub Pages 上经常 404，还要白等十几秒）',
      '改成「本地缓存 → 服务器代理 → 图床」三级取图，首屏不再被一张图拖住',
      '服务器代理新增尺寸上限：图床原图 6.3MB，超过 1.5MB 就改用内嵌的压缩版（导出图里班徽只有 66px，看不出来）',
      '登录时下载的班徽缓存因此只有 110KB —— 换设备登录一次也就一下下'
    ] },
  { version: '3.7.0', date: '2026-10-20', type: 'feat', title: '资料修改改为审批制 · 首屏先用缓存 · 班徽本地缓存', items: [
      '「联系方式审核」改名为「信息审核」：现在不只管微信/QQ/手机号，所有「允许本人编辑」的字段都走同一套审批',
      '提交修改后不会立刻生效：后台点「通过」才写进档案；通过之前前台仍显示原来的内容',
      '审核卡片只显示修改人姓名和实际改动的字段（原内容 → 现内容），没改的字段不再堆上来',
      '信息审核新增「历史记录」：通过 / 驳回 / 已撤销都在，通过后 7 天内可以一键撤销',
      '前台「我的资料」里，待审核的字段会标出「待审核：你提交的新值」，一眼能看到进度',
      '首屏改用缓存优先：进站直接用上次同步的内容渲染，云端在后台补拉，同步完自动刷新，全程不打扰',
      '云端内容接口不再给普通同学返回版本记录等后台专用数据（单次少了约 150KB）',
      '班徽改成登录时下载一次存本地，导出图片直接读缓存，不再受图床跨域和 404 影响',
      '班徽接口带内嵌兜底：图床挂了也能返回一张真图，不会画占位块'
    ] },
  { version: '3.6.5', date: '2026-10-19', type: 'fix', title: '作业同步：补上钩子的递归死循环',
    items: [
      '3.6.4 把钩子挂上了，但打勾后仍不上传 —— 实测发现钩子内部写时间戳会再次触发钩子，无限递归后被吞掉',
      '加上递归保护后，本地实测：打勾 → 待推送队列有它 → PUT 请求发出（内容正确）',
      '这一版是同步链路的最后一块，云端时间应该会随每次打勾刷新'
    ] },
  { version: '3.6.4', date: '2026-10-19', type: 'fix', title: '作业同步终于修好（钩子没挂上）· 删除可撤回 · 同步按钮有反馈',
    items: [
      '作业勾选一直传不上云，真正原因找到了：拦截本地写入的那段补丁在 Chrome 里根本没生效，打勾从未被登记为「待同步」',
      '改成拦截 Storage.prototype 后，打勾会立刻排队上传；云端数据不再停在 10-16',
      '「上传本机 / 拉取云端 / 双向同步」三个按钮加上转圈动画，成功打勾、失败打叉，不再点了没反应',
      '删除字段恢复成「真删」（不再留隐藏列），但删之前会把整列数据存进回收站：30 分钟内在「操作日志」点「撤回」即可连数据一起恢复',
      '修复：点字段的「允许本机编辑」会报「服务器内部错误」（老库缺 self_edit 列）',
      '班徽改由服务器代理取图（后台填的直链也能画进导出图，不受跨域限制）',
      '新增部署门禁：云端公告里没有当次版本，就不允许部署',
      '「版本更新」并入「数据管理」同一页，侧栏不再单独占一项；移除临时的「恢复预置字段」按钮'
    ] },
  { version: '3.6.3', date: '2026-10-19', type: 'fix', title: '导出图的班徽不再「空着」',
    items: [
      '班徽图片刚上传时线上可能还没同步过来，导出图上右上角会空一块',
      '现在取不到真图会自动画一个同色系的班级徽标兜底，等真图同步后自动换回'
    ] },
  { version: '3.6.2', date: '2026-10-19', type: 'fix', title: '字段列表读不出来的问题',
    items: [
      '修复：后台「字段管理」明明有字段却显示 0 个 —— 查询写死了列名，老库缺其中一列就整张表读空',
      '同类问题也影响前台查询（档案里开放为公开的字段不显示），一并修好',
      '「恢复预置字段」会顺带把字段表缺的列补上，避免升级中断留下的半成品状态'
    ] },
  { version: '3.6.1', date: '2026-10-19', type: 'feat', title: '数据备份与回档 · 字段误删可恢复 · 导出图带班徽 · 成绩分享可写备注',
    items: [
      '新增「安全 → 数据管理」：可手动备份、查看历史备份、一键回档（内容 / 档案 / 字段定义 / 站点设置四类）',
      '每次部署前自动备份一次，默认保留最近 14 个版本的备份；备份存在云端数据库里，换设备也能回档',
      '修复：字段管理里的入团时间、发展团员编号等被删掉后数据找不回来。现在「删除字段」不再删除数据库里的列，只是从列表里隐藏，重新加回来数据就复原',
      '新增「字段体检 / 恢复预置字段」：一键把 17 个预置字段定义补回来，并清掉导致反复误删的「墓碑」记录',
      '导出图片右上角统一显示班徽（就是首页标题旁那个绿色徽标，已存到站点本地，导出更稳）',
      '成绩分享长图可以写备注了：导出前填一句「为什么分享」，会印在图片底部',
      '版本号规则改为「主版本 . 小更新 . 修复」：主版本只有站主发话才动，后两位由维护方按改动性质递增'
    ] },
  { version: '3.5.42', date: '2026-10-19', type: 'fix', title: '作业勾选真正不丢了 · 导出图片带班徽 · 可选导出哪一次',
    items: [
      '修复「打完勾立刻退出、重进发现勾没了」：待同步清单现在会存在本机，进站先补推再拉云端',
      '再补一道保险：拉云端时比较时间戳，本机改得比云端新就不覆盖（以前旧值会无条件盖掉刚打的勾）',
      '还修了一个空档：推送正忙时新攒的改动以前会一直等着，现在会自动排队补发',
      '导出图片右上角统一显示班徽；后台「站点信息」新增「班徽图片地址」，留空则用站点图标',
      '抽歌排期导出图片前可以先选「导出哪一次」，不再只能导最近一次',
      '作业弹窗新增「查看」下拉，可以翻之前的作业；导出/分享的就是当前正在看的那一份'
    ] },
  { version: '3.5.41', date: '2026-10-19', type: 'fix', title: '导出图片脚本改为内联（修线上偶发取不到）',
    items: [
      '修复：3.5.40 的导出图片依赖一个外部脚本，GitHub Pages 新文件同步慢时会出现 404，按钮点了没反应',
      '现在画图代码直接内联进页面，不再依赖外部文件；功能与版式完全不变',
      '顺带修好测试里「主脚本」的选取逻辑（页面多了一段脚本后要取最长的那段）'
    ] },
  { version: '3.5.40', date: '2026-10-19', type: 'feat', title: '字段本人可编辑 · 投票明细 · 页面级在线时长 · 定向弹窗 · 导出图片',
    items: [
      '字段管理：每个字段后面多了一个「本人可编辑」开关。打开后，同学可以在「我的资料」里点「改」直接修改这一项，修改后立即生效；姓名/学号/身份/头衔仅可由管理员修改',
      '投票管理：每场投票多了「投票明细」，能看到每一张票是谁投的、投给哪个选项、什么时候投的（撤回的票也会标出来）',
      '在线时长：新增「时间花在哪些页面」，能看到成绩分析、打砖块、后台各面板分别待了多久；每个人的明细里也有他自己的页面分布',
      '通用弹窗：新增「投放对象」——可以只弹给某个人、某几个人，或按身份（管理员/学生/老师）、按头衔（团支书/课代表…）投放',
      '横屏修好了：不再出现「切出去再回来就卡住/白屏」；旋转方向改成与手动横屏一致（顺时针），手机真横过来后会自动撤掉页面旋转',
      '抽歌排期：公示区新增「导出图片 / 分享图片」，把当次公示画成一张长图，可直接发班级群',
      '作业：作业弹窗新增「导出图片 / 分享」，图片里含作业名称、时间范围、每科的每一项任务，以及配图的图片直链'
    ] },
  { version: '3.5.39', date: '2026-10-18', type: 'feat', title: '前台也能切横屏了：侧边栏一键横过来看',
    items: [
      '侧边栏「音效」上面多了一个「📱 横屏查看」按钮，点击整页横过来，再点击竖回去',
      '和后台是同一套逻辑：系统真把屏幕转横了会自动撤掉 CSS 旋转，不会转两次又变回竖的',
      '横屏状态会记住：切到别的 App 再回来、刷新页面、PWA 从后台恢复，都保持上次的选择',
      '只在点了按钮时才尝试锁方向，进页面不会自己抢着横过来（避免「页面横了但手机没横」）',
      '表格、课表、作业这类横向内容多的板块，横屏看舒服很多'
    ] },
  { version: '3.5.38', date: '2026-10-18', type: 'fix', title: '「仅后端可见」收紧了：前台上所有人都看不到',
    items: [
      '修正上一版的口径：之前管理员自己能前台的「我的资料」里看到这类字段，现在看不到了',
      '现在的规则：只能在后端（成员与档案 → 详情）查；前台任何人都看不到，包括管理员本人',
      '普通同学查自己、查别人、管理员查别人 —— 全都拿不到，连键都不会下发',
      '以前设成「仅后端可见」的字段不用重设，自动生效'
    ] },
  { version: '3.5.37', date: '2026-10-18', type: 'feat', title: '「仅管理员」更名「仅后端可见」，语义更明确',
    items: [
      '更名为「仅后端可见」，可见范围明确：管理员（后台档案详情与本人前台的「我的资料」）',
      '其他所有人前台都查不到 —— 包括这个字段的主人本人（普通同学），连键都不会下发',
      '你在前台查询别的同学时依然没有特权，和大家的查询规则一视同仁',
      '存储值没变（还是 admin），原来设过的字段不用重新设置'
    ] },
  { version: '3.5.36', date: '2026-10-18', type: 'fix', title: '游戏全量云同步 · 在线统计覆盖游戏页与后台',
    items: [
      '修复：上一版漏发了主页面文件，导致换设备也停在 3.5.34 —— 现在已正常到 3.5.36',
      '其余 9 款游戏（打砖块 / 打地鼠 / 消消乐 / 飞机大战 / 扫雷 / 记忆翻牌 / 五子棋 / 井字棋 / 象棋）全部接入云端：最高分（或最快用时、胜负场）与游玩时长都会统计',
      '在线时长现在覆盖所有页面：玩游戏的每分钟、后台挂着的每分钟都算在线',
      '后台「游戏数据」面板支持 13 款游戏的次数 / 时长 / 成绩展示'
    ] },
  { version: '3.5.35', date: '2026-10-18', type: 'feat', title: '在线时长统计：单次与累计分别显示',
    items: [
      '新增「在线时长」面板（后台 → 安全）：每人累计在线、在线次数、最长单次、最近在线，可切 今天 / 7 / 30 / 90 天',
      '点「明细」可看每一段连续在线的起止时刻与时长',
      '判定规则：心跳每 60 秒一次，两次心跳间隔超过 3 分钟就另算一次在线（你提的方案，原样落地）',
      '同一账号在两台设备登录各算各的，不混在一起',
      '统计随心跳自动累积，不需要任何人手动打卡'
    ] },
  { version: '3.5.34', date: '2026-10-18', type: 'fix', title: '自定义设置只存本机 · 轻量补媒体特效 · 作业勾选同步加固',
    items: [
      '自定义设置（字号 / 背景 / 排序 / 动效 / 轻量 / 背景图）不再上传云端，只保存在本机浏览器 —— 每台设备屏幕和习惯不同，各配各的',
      '换设备想搬设置，用「导出配置 / 导入配置」手动搬',
      '轻量模式进一步关掉听力播放器的唱片旋转与波形跳动（播放、倍速、拖动进度都正常）',
      '轻量模式下作业里的视频不再预加载，点播放才开始加载',
      '作业勾选后立即上传云端，不再等 1.5 秒防抖 —— 打完勾马上锁屏也不会丢',
      '新增孤儿勾选回补：本机有、云端没有的勾选会自动补推上去，跨设备终于能对上',
    ] },
  { version: '3.5.33', date: '2026-10-18', type: 'fix', title: '轻量模式选择按设备永久记住',
    items: [
      '轻量 / 完整的选择改为独立存储（cls_lite_mode），不再混在会随版本升级、云端同步、恢复默认一起被重写的 UI 配置里',
      '从此升级新版本、恢复默认设置、别的设备同步配置，都不会把本机选的轻量模式冲回完整',
    ] },
  { version: '3.5.31', date: '2026-10-18', type: 'fix', title: '轻量模式改纯手动 · 弹窗居中',
    items: [
      '轻量模式不再自动检测设备：站主明确「由我手动更改」，设置里只有「完整 / 轻量」两档，选完立刻生效并记住',
      '修复登录引导等弹窗贴在左上角的问题：遮罩层显式居中，iPad / iPhone / 桌面都居中显示',
      '兼容老版 iPad Safari：inset 简写改成四边定位写法，弹窗遮罩现在能铺满全屏（之前只缩在左上角一块）',
    ] },
  { version: '3.5.30', date: '2026-10-18', title: '兼容性修复 · 轻量模式 · 后台横屏记忆 · 站点名称可编辑', type: 'fix', highlight: true, items: [
    '新增「轻量模式」：iPad / iPhone 上自动关闭玻璃模糊、背景光斑、卡片流光与入场动画（站主反馈 iPad Air 打开卡死、勉强操作后白屏）',
    '性能自动判定：iOS 设备 / 内存 ≤4GB / CPU ≤4 核自动走轻量；另加首屏 3 秒长任务自测，超 120ms 自动降级',
    '自定义设置 → 动效 里新增「性能 / 轻量模式」三档（自动 / 轻量 / 完整），可随时手动切换并记住选择',
    '从主站进入后台默认竖屏，不再自动横过来；切到后台再回来保持原状态（含 PWA 往返）',
    '后台「站点信息」里的站点名称与副标题真正可编辑：保存后浏览器标题栏、页头大标题、页脚一起更新',
    '版本面板新增「补齐缺失版本」：自动对比内置清单，只补云端缺的版本号，不覆盖已有内容',
  ] },
  { version: '3.5.29', date: '2026-10-18', title: '站点名称 / 副标题后台可编辑', type: 'feature', items: [
    '后台「系统设置 → 站点信息」从「仅作展示」改为真读真存，写入 site_config.siteName / siteSubtitle',
    '保存时先取回整份 site_config 再合并，不会冲掉点歌守卫等其它配置',
    '主站新增 applyBranding()：站点名同步替换 <title>、页头大标题、页脚版权行；副标题替换页头标语',
    '清空保存 = 恢复默认（写空字符串而非删键，避免主站残留旧站名清不掉）',
  ] },
  { version: '3.5.28', date: '2026-10-18', title: '时长库支持线上搜歌 + 导入清单批量匹配', type: 'feature', items: [
    '时长库面板改为四个分区：已收录 / 线上搜 / 导入清单 / 预置歌单',
    '线上搜歌：输入歌名同时查网易云与 QQ 音乐（都没有才用 iTunes 兜底），点「加入」直接写进云端库',
    '搜索结果按歌名贴合度排序 —— 修掉「搜《晴天》第一条是翻唱」的问题，原唱排最前',
    '导入清单：一行一首「歌名 - 歌手」，歌名完全一致 + 歌手部分符合即命中（合唱多歌手 vs 只写一个也算）',
    '预置周杰伦 / 林俊杰 / 方大同热门曲，一键逐批抓时长入库；云端库已预先填充 96 首',
    'song_durations 补歌手索引（SCHEMA_VER 升到 3.5.28）',
  ] },
  { version: '3.5.27', date: '2026-10-18', title: '歌曲时长云端同步 · 缺时长禁止发布与排歌', type: 'feature', highlight: true, items: [
    '新增云端时长库 song_durations：查到的秒数写进数据库，一次查询永久命中，换设备也不丢',
    '时长来源优先级 manual > netease/qq > itunes，人工填写永不被自动结果覆盖',
    '网易云 / QQ 音乐改为严格匹配（歌名必须一致），修掉「查不到时拿搜索结果第一条顶替」的错时长问题',
    '查不到时返回空并弹「时长补录」，由站主手填（支持 3:45 或 225 两种写法）',
    '缺时长的歌单投票无法发布、缺时长的歌无法被随机排歌 / 写排期（前后端双保险）',
    '时长库管理面板：查看已收录、来源标注、删除误录、补录入口',
  ] },
  { version: '3.5.26', date: '2026-10-18', title: '歌单投票不再显示「选项（一行一个）」文本框', type: 'fix', items: [
    '编辑器根节点渲染时即带 data-kind，由 CSS 强制隐藏文本框，不再依赖 onMount 执行时机',
    '文本框仍作为隐藏数据载体，提交时照常读取，不影响既有投票',
  ] },
  { version: '3.5.25', date: '2026-10-18', title: '歌单投票彻底免文本框 · 时长必显示', type: 'improve', items: [
    '勾选歌曲即成为选项；改动选项字段勾选会自动重算，不用再手动复制',
    '歌曲时长改为必展示项，直接显示在歌手后面（青绿等宽字色，暗色主题已适配）',
  ] },
  { version: '3.5.24', date: '2026-10-18', title: '前台投票按赞数实时排序 · 后台勾选即选项', type: 'improve', items: [
    '前台投票选项按赞成票从高到低实时排序，同票保持稳定顺序，不打断当前滚动位置',
    '后台挑歌：勾选即加入选项，与选项列表双向同步',
    '编辑器明确「歌名歌手直显，点歌人/日期/赞数/时长进详情」',
  ] },
  { version: '3.5.23', date: '2026-10-18', title: '投票管理整理 · 公示变量扩展 · 按时长取名', type: 'improve', items: [
    '老格式歌单投票选项也能折叠（按日期段自动拆分）',
    '歌单投票禁止同学自行添加选项',
    '总时长上限模式下按实际时长取名次，不再出现「取前 5 名」这类与时间制冲突的表述',
    '公示模版变量扩展到第 4~10 名',
    '投票管理元信息分组（时间 / 取值方式 / 展示项分开）',
  ] },
  { version: '3.5.22', date: '2026-10-18', title: '后台人员档案全字段在线编辑 · 身份头衔与账号角色分离', type: 'feature', items: [
    '身份 / 头衔进入成员表单，与账号角色（管理员 / 同学）互相独立',
    'title、role 移出特殊字段白名单，可按普通字段配置可见性与编辑权限',
    '前台查询显示的身份 / 头衔同样受字段可见性管辖',
    '导出名单补上身份、头衔两列',
  ] },
  { version: '3.5.21', date: '2026-10-18', title: '档案字色与字段可复制 · 前台查询显头衔 · 点歌投票批量选择', type: 'feature', items: [
    '我的档案字色加深、字段内容可一键复制',
    '前台查询结果直接显示头衔与智学网账号',
    '后台可在线编辑身份证、团员编号等敏感字段（不再只能靠导入）',
    '点歌投票支持批量勾选，并可二选一：限定抽取数量或限定总时长',
    '公示与抽歌排期均显示单曲时长与总时长',
  ] },
];

/** 补齐云端缺失的版本记录：只追加云端没有的版本号，已有一律不动 */
function relSyncMissing(){
  var box = $('relMissBox');
  var btn = $('relSync');
  if(btn){ btn.disabled = true; btn.textContent = '对比中…'; }
  api('/content').then(function(j){
    var cur = (j && j.items && j.items.release_notes) || [];
    cur = Array.isArray(cur) ? cur : [];
    var have = {};
    cur.forEach(function(r){ have[String(r && r.version || '').trim()] = 1; });
    var add = REL_BUILTIN.filter(function(r){ return !have[String(r.version)]; });
    if(!add.length){
      if(btn){ btn.disabled = false; btn.innerHTML = svg('download',14) + ' 补齐缺失版本'; }
      if(box){ box.style.display = 'block'; box.textContent = '云端版本记录是最新的，没有缺号。'; }
      toast('没有需要补的版本', 'ok');
      return;
    }
    var names = add.map(function(r){ return 'v' + r.version; }).join('、');
    if(btn){ btn.disabled = false; btn.innerHTML = svg('download',14) + ' 补齐缺失版本'; }
    confirmBox({
      title: '补齐 ' + add.length + ' 个版本的记录',
      text: '云端缺少：' + names,
      detail: '只会追加这几条，已有的 ' + cur.length + ' 条记录保持不变。补完可以逐条再编辑。',
      okText: '补齐',
    }).then(function(yes){
      if(!yes) return;
      var merged = cur.concat(add.map(function(r){ return JSON.parse(JSON.stringify(r)); }));
      api('/content', { method: 'PUT', body: { items: { release_notes: merged } } })
        .then(function(){
          REL_STATE.list = merged;
          relSort();
          paintReleases();
          toast('已补齐 ' + add.length + ' 个版本的记录', 'ok');
          if(box){ box.style.display = 'block'; box.textContent = '已补齐：' + names; }
        })
        .catch(function(e){ toast('补齐失败：' + (e.message || e), 'err', 4000); });
    });
  }).catch(function(e){
    if(btn){ btn.disabled = false; btn.innerHTML = svg('download',14) + ' 补齐缺失版本'; }
    toast('读取云端版本记录失败：' + (e.message || e), 'err', 4000);
  });
}

/* 按日期倒序（同一天按版本号倒序）——最新的在最上面 */
function relSort(){
  REL_STATE.list.sort(function(a, b){
    var d = String(b.date || '').localeCompare(String(a.date || ''));
    if(d) return d;
    return relVerNum(b.version) - relVerNum(a.version);
  });
}
function relVerNum(v){
  var m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if(!m) return 0;
  return (+m[1]) * 1000000 + (+m[2]) * 1000 + (+m[3]);
}
/* 版本号显示：数据里允许带 v 前缀（历史遗留），统一成 vX.Y.Z —— 别出现「vv2.6.4」 */
function relVerLabel(v){
  var s = String(v || '?').trim();
  return /^v/i.test(s) ? s : ('v' + s);
}

function paintReleases(){
  var body = $('relBody');
  if(!body) return;
  var list = REL_STATE.list || [];
  if(!list.length){
    body.innerHTML = '<div class="empty">' + svg('clock', 38)
      + '<p>还没有版本记录</p>'
      + '<p class="muted" style="font-size:.82rem">点右上角「新增版本」开始记录，'
      + '或点「填入最近几轮」一键导入这几天的主要改动</p></div>';
    return;
  }

  /* v4.8.0（站主）：「版本更新记录太长了，可以折叠，按大版本号分类，
     默认折叠起来，不然一页都翻不到底；还要能搜关键词」。
     分组键取 主.小（4.8 / 4.7…），版本号不成形的老记录统一归到「早期版本」。 */
  var q = String(REL_STATE.q || '').toLowerCase();
  function hit(r){
    if(!q) return true;
    var blob = [r.version, r.title, (r.items || []).join(' ')].join(' ').toLowerCase();
    return blob.indexOf(q) >= 0;
  }
  var shown = list.filter(hit);

  if(!shown.length){
    body.innerHTML = '<div class="empty">' + svg('search', 34)
      + '<p>没有匹配「' + esc(REL_STATE.q) + '」的版本</p>'
      + '<p class="muted" style="font-size:.82rem">可输入版本号（如 4.7）或功能词（如 作业、字号）</p></div>';
    return;
  }

  var groups = [], map = {};
  shown.forEach(function(r){
    var m = String(r.version || '').match(/^(\d+)\.(\d+)/);
    var key = m ? (m[1] + '.' + m[2]) : '__early';
    if(!map[key]){ map[key] = { key: key, label: m ? ('v' + key) : '早期版本', rows: [] }; groups.push(map[key]); }
    map[key].rows.push(r);
  });
  /* 有搜索词时全部展开，方便直接看到命中的那条 */
  function isOpen(key){ return q ? true : !!REL_STATE.open[key]; }

  body.innerHTML = '<div class="rel-sum" style="font-size:.8rem;color:var(--fg-3);margin:0 0 12px">'
      + '共 ' + list.length + ' 个版本，' + groups.length + ' 组'
      + (q ? '（筛出 ' + shown.length + ' 条）' : '，点击组标题展开')
    + '</div>'
    + groups.map(function(g){
      var open = isOpen(g.key);
      var dates = g.rows.map(function(r){ return String(r.date || ''); }).sort();
      var span = dates[0] && dates[0] !== dates[dates.length - 1]
        ? (dates[0] + ' ~ ' + dates[dates.length - 1]) : (dates[0] || '');
      var cards = g.rows.map(function(r){
        var i = list.indexOf(r);
        var ty = relTypeOf(r.type);
        var items = (r.items || []).map(function(t){
          return '<li style="margin:5px 0;line-height:1.7">' + esc(t) + '</li>';
        }).join('');
        return '<div class="panel rel-card" style="margin:0 0 12px;padding:14px 16px' + (r.highlight ? ';border-left:3px solid #af410f' : '') + '">'
          + '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">'
          +   '<b style="font-size:1rem">' + esc(relVerLabel(r.version)) + '</b>'
          +   '<span class="badge ' + ty.cls + '">' + esc(ty.label) + '</span>'
          +   (r.highlight ? '<span class="badge badge-green">重点</span>' : '')
          +   '<span class="muted" style="font-size:.82rem">' + esc(r.date || '') + '</span>'
          +   '<span style="flex:1"></span>'
          +   '<button class="btn btn-sm btn-ghost" data-rel-up="' + i + '" title="上移">↑</button>'
          +   '<button class="btn btn-sm btn-ghost" data-rel-down="' + i + '" title="下移">↓</button>'
          +   '<button class="btn btn-sm btn-ghost" data-rel-edit="' + i + '">' + svg('edit',13) + ' 编辑</button>'
          +   '<button class="btn btn-sm btn-ghost" data-rel-del="' + i + '" style="color:#b3261e">' + svg('trash',13) + ' 删除</button>'
          + '</div>'
          + (r.title ? '<div style="font-weight:700;margin-bottom:6px">' + esc(r.title) + '</div>' : '')
          + (items ? '<ul style="margin:0;padding-left:20px;font-size:.86rem">' + items + '</ul>'
                   : '<p class="muted" style="margin:0;font-size:.84rem">（没有条目）</p>')
          + '</div>';
      }).join('');
      return '<div class="rel-group">'
        + '<button type="button" class="rel-gh" data-rel-g="' + attr(g.key) + '" aria-expanded="' + (open ? 'true' : 'false') + '">'
        +   '<span class="rel-caret">' + (open ? '▾' : '▸') + '</span>'
        +   '<b>' + esc(g.label) + '</b>'
        +   '<span class="muted" style="font-size:.8rem">' + g.rows.length + ' 个版本'
        +     (span ? ' · ' + esc(span) : '') + '</span>'
        + '</button>'
        + '<div class="rel-gb"' + (open ? '' : ' style="display:none"') + '>' + cards + '</div>'
        + '</div>';
    }).join('');

  Array.prototype.forEach.call(body.querySelectorAll('[data-rel-g]'), function(b){
    b.onclick = function(){
      var k = b.getAttribute('data-rel-g');
      REL_STATE.open[k] = !REL_STATE.open[k];
      paintReleases();
    };
  });
  Array.prototype.forEach.call(body.querySelectorAll('[data-rel-edit]'), function(b){
    b.onclick = function(){ relEdit(parseInt(b.dataset.relEdit, 10)); };
  });
  Array.prototype.forEach.call(body.querySelectorAll('[data-rel-del]'), function(b){
    b.onclick = function(){ relDelete(parseInt(b.dataset.relDel, 10)); };
  });
  Array.prototype.forEach.call(body.querySelectorAll('[data-rel-up]'), function(b){
    b.onclick = function(){ relMove(parseInt(b.dataset.relUp, 10), -1); };
  });
  Array.prototype.forEach.call(body.querySelectorAll('[data-rel-down]'), function(b){
    b.onclick = function(){ relMove(parseInt(b.dataset.relDown, 10), 1); };
  });
}

/* 上移 / 下移：交换后把顺序整体写回（排序是按日期，所以交换日期意义不大——
   这里直接交换数组位置并「锁序」：给两条同样的日期，靠数组顺序决定先后）。
   为避免与 relSort 打架，交换后同步把 date 也维持原样即可，
   因为 relSort 只在加载时跑一次，之后列表顺序由我们掌控。 */
function relMove(i, dir){
  var j = i + dir;
  var list = REL_STATE.list;
  if(j < 0 || j >= list.length) return;
  var t = list[i]; list[i] = list[j]; list[j] = t;
  paintReleases();
  toast('顺序已调整，请点击「编辑」保存任一条以同步至云端', 'ok', 3500);
}

function relEdit(idx){
  var isNew = (idx === null || idx === undefined);
  var r = isNew
    ? { version: String(typeof SITE_VERSION !== 'undefined' ? SITE_VERSION : ''), date: relToday(), title: '', type: 'feature', items: [], highlight: false }
    : REL_STATE.list[idx];
  if(!r) return;

  openModal({
    title: isNew ? '新增版本记录' : ('编辑 ' + esc(relVerLabel(r.version))),
    sub: isNew ? '版本号与日期已按当前站点预填，可直接改' : '',
    wide: true,
    body:
      '<div style="display:flex;gap:12px;flex-wrap:wrap">'
      + '<div class="field" style="margin:0;width:150px"><label for="relVer">版本号</label>'
      +   '<input id="relVer" value="' + attr(r.version || '') + '" placeholder="如 2.3.6" maxlength="20"></div>'
      + '<div class="field" style="margin:0;width:170px"><label for="relDate">日期</label>'
      +   '<input id="relDate" type="date" value="' + attr(r.date || '') + '"></div>'
      + '<div class="field" style="margin:0;width:150px"><label for="relType">类型</label>'
      +   '<select id="relType">'
      +     Object.keys(REL_TYPES).map(function(k){
              return '<option value="' + k + '"' + (r.type === k ? ' selected' : '') + '>' + esc(REL_TYPES[k].label) + '</option>';
            }).join('')
      +   '</select></div>'
      + '</div>'
      + '<div class="field"><label for="relTitle">标题（一句话概括这个版本）</label>'
      +   '<input id="relTitle" value="' + attr(r.title || '') + '" placeholder="如 游戏排行榜" maxlength="60"></div>'
      + '<div class="field"><label for="relItems">更新条目（一行一条）</label>'
      +   '<textarea id="relItems" rows="8" placeholder="新增四款游戏的跨用户排行榜&#10;支持历史总榜 / 本周榜切换">'
      +   esc((r.items || []).join('\n')) + '</textarea></div>'
      + '<label style="display:flex;align-items:center;gap:6px;font-size:.86rem;cursor:pointer">'
      +   '<input type="checkbox" id="relHi"' + (r.highlight ? ' checked' : '') + '> 标为重点版本（列表左侧加一条橙线）</label>',
    foot: '<button class="btn btn-ghost" data-rel-cancel>取消</button>'
        + '<button class="btn" data-rel-save>保存</button>',
    onMount: function(box){
      box.querySelector('[data-rel-cancel]').onclick = closeModal;
      box.querySelector('[data-rel-save]').onclick = function(){ relSave(idx); };
    },
  });
}

function relSave(idx){
  var ver = String(($('relVer') || {}).value || '').trim();
  if(!ver){ toast('版本号不能为空', 'err'); return; }
  var date = String(($('relDate') || {}).value || '').trim() || relToday();
  var title = String(($('relTitle') || {}).value || '').trim();
  var type = String(($('relType') || {}).value || 'feature');
  var raw = String(($('relItems') || {}).value || '');
  var items = raw.split('\n').map(function(x){ return x.trim(); }).filter(Boolean);
  var hi = !!($('relHi') || {}).checked;

  var rec = { version: ver, date: date, title: title, type: type, items: items, highlight: hi };
  var isNew = (idx === null || idx === undefined);
  var list = (REL_STATE.list || []).slice();

  if(isNew){
    /* 同版本号已存在 → 让站主决定是覆盖还是取消，避免手一抖出现两条同版本 */
    var dup = -1;
    for(var i = 0; i < list.length; i++){ if(String(list[i].version) === ver){ dup = i; break; } }
    if(dup >= 0){
      confirmBox({ text: relVerLabel(ver) + ' 已经存在了', detail: '要继续的话会覆盖那条记录。', okText: '覆盖' })
        .then(function(yes){ if(yes){ list[dup] = rec; relWrite(list, '已覆盖 ' + relVerLabel(ver)); } });
      return;
    }
    list.push(rec);
  }else{
    list[idx] = rec;
  }
  relWrite(list, isNew ? (ver + ' 已新增') : (ver + ' 已保存'));
}

function relWrite(list, okMsg){
  api('/content', { method:'PUT', body:{ items:{ release_notes: list } } })
    .then(function(){
      REL_STATE.list = list;
      relSort();
      paintReleases();
      toast(okMsg, 'ok');
    })
    .catch(function(e){ toast('保存失败：' + e.message, 'err', 4000); });
}

function relDelete(idx){
  var r = REL_STATE.list[idx];
  if(!r) return;
  confirmBox({ text: '确定删除 ' + relVerLabel(r.version) + ' 的记录吗？', detail: '删除后不可恢复。', danger: true, okText: '删除' })
    .then(function(yes){
      if(!yes) return;
      var list = (REL_STATE.list || []).slice();
      list.splice(idx, 1);
      relWrite(list, '已删除 v' + (r.version || '?'));
    });
}

/* 一键填入最近几轮：只在「当前没有任何记录」时提供，避免把已有内容冲掉 */
/* 今天（本地时区的 YYYY-MM-DD） */
function relToday(){
  var d = new Date();
  function p(n){ return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate());
}

/* ============================================================================
 * ⑬ 面板：通用弹窗（第二十八轮补做）
 * ----------------------------------------------------------------------------
 * 【背景】
 *   第二十七轮在前端 index.html 做了「通用弹窗引擎」（popGetList / showPop /
 *   popAutoPop 等），数据来源是 SITE_DATA.popups。但当时只做了前端引擎与
 *   云端字段（/api/content 的 popups 键），**后台没有可视化编辑入口**，
 *   站长想加一个弹窗只能去改 index.html 源码。
 *   本面板补上后台编辑入口，数据写入云端 popups 键，前端自动生效。
 *
 * 【字段（必须与 index.html 的 popGetList 完全对齐，多一个少一个都不行）】
 *   id        —— 唯一标识。改 id 会让「已关闭过」的同学重新收到弹窗
 *   scope     —— 'boot' 进站弹 / 'cat:N' 进板块 N 弹
 *   source    —— 'custom' 自带内容 / 'announcements' 取最新公告 / 'homework_notice' 取作业通知
 *   title     —— source='custom' 时的标题
 *   body      —— 正文，\n 换行
 *   video     —— B站分享链接或 mp4 直链
 *   image     —— 图片直链
 *   linkText / linkUrl —— 底部按钮（留空不显示）
 *   startAt / endAt     —— 时间窗（窗内才弹）
 *   dismiss   —— daily 当天不再弹 / once 只弹一次 / always 每次都弹
 *   bubble    —— 关掉后右下角留悬浮球
 * ========================================================================= */

var POP_STATE = { list: [], editing: null };

/* 板块列表（与 index.html 的 SITE_DATA.categories 保持一致）
   做成内置是为了不依赖前端文件；将来加板块可在此追加，
   或者用「自定义」输入 cat:N 兜底。 */
var POP_CATS = [
  { id: 'boot',  name: '进站时（开屏弹）' },
  { id: 'cat:1', name: '板块 · 常用服务' },
  { id: 'cat:2', name: '板块 · 大屏服务' },
  { id: 'cat:5', name: '板块 · 学习资料' },
  { id: 'cat:3', name: '板块 · 成绩分析' },
  { id: 'cat:7', name: '板块 · 班级事务' },
  { id: 'cat:8', name: '板块 · 其他工具' },
  { id: 'cat:9', name: '板块 · 安装为应用' },
];
/* 弹窗按钮可跳转的「站内页面」（v2.6.6 站主要求）
   为什么用白名单而不是让站主随便写函数名：linkUrl 会被前端直接执行，
   开放任意函数名等于把「能调什么」的决定权交给了配置内容。
   白名单里的都是确认安全、且对同学有意义的页面入口。
   想加新的：在这里追加一行，并在 index.html 的 POP_JUMP_FN 里同步加。 */
var POP_JUMP_FNS = [
  { id: 'fn:showCurrentHomework',  name: '站内页 · 当前作业' },
  { id: 'fn:showHomeworkCalendar', name: '站内页 · 历史作业（按日期）' },
  { id: 'fn:openClassworks',       name: '站内页 · Classworks 作业入口' },
  { id: 'fn:openSettings',         name: '站内页 · 自定义设置' },
  { id: 'fn:openMyProfile',        name: '站内页 · 我的资料' },
  { id: 'fn:openClassSign',        name: '站内页 · 班级签到' },
  { id: 'fn:openAllImp',           name: '站内页 · 重要日期（全部）' },
  { id: 'fn:openAllHol',           name: '站内页 · 法定节假日' },
  { id: 'fn:openGameBoard',        name: '站内页 · 游戏排行榜' },
  { id: 'fn:openData',             name: '站内页 · 数据管理' },
  { id: 'fn:openRepoDialog',       name: '站内页 · 仓库入口' },
];

/** 这个 linkUrl 是不是「需要手填」的自定义值？（不在已知列表里就是） */
function pfLinkIsCustom(cur){
  cur = String(cur || '').trim();
  if(!cur) return false;
  var known = {};
  POP_CATS.forEach(function(c){ if(c.id !== 'boot') known[c.id] = 1; });
  POP_JUMP_FNS.forEach(function(f){ known[f.id] = 1; });
  return !known[cur];
}

/** 生成「按钮跳转到」下拉的选项；current 是当前 linkUrl，用来回显选中 */
function pfLinkOptions(current){
  var cur = String(current || '').trim();
  var html = '<option value=""' + (cur ? '' : ' selected') + '>不跳转（只有一个关闭按钮）</option>';
  html += '<optgroup label="站内板块">';
  POP_CATS.forEach(function(c){
    if(c.id === 'boot') return;      /* boot 是「弹在哪」，不是「跳到哪」 */
    html += '<option value="' + attr(c.id) + '"' + (cur === c.id ? ' selected' : '') + '>'
          + esc(c.name.replace('板块 · ', '')) + '</option>';
  });
  html += '</optgroup><optgroup label="站内页面">';
  POP_JUMP_FNS.forEach(function(f){
    html += '<option value="' + attr(f.id) + '"' + (cur === f.id ? ' selected' : '') + '>'
          + esc(f.name.replace('站内页 · ', '')) + '</option>';
  });
  html += '</optgroup><option value="__custom"' + (pfLinkIsCustom(cur) ? ' selected' : '')
        + '>自定义链接…（外部网址 / 手写 cat: / fn:）</option>';
  return html;
}

/** 下拉联动：选具体目标写进输入框；选「自定义」才露出输入框 */
function pfLinkPickChange(){
  var sel = $('pfLinkPick'), inp = $('pfLinkUrl'), wrap = $('pfLinkUrlWrap'), txt = $('pfLinkText');
  if(!sel || !inp) return;
  var v = sel.value;
  if(v === '__custom'){
    if(wrap) wrap.style.display = '';
    inp.focus();
    return;
  }
  inp.value = v || '';
  if(wrap) wrap.style.display = 'none';
  /* 没写按钮文案时给个像样的默认，免得按钮显示成空白 */
  if(v && txt && !txt.value.trim()) txt.value = v.indexOf('fn:') === 0 ? '前往查看' : '去看看';
}

var POP_SOURCES = [
  { id: 'custom',          name: '自定义内容（自己写标题/正文）' },
  { id: 'announcements',   name: '最新班级公告（自动取置顶或最新一条）' },
  { id: 'homework_notice', name: '作业通知（自动取当前作业通知）' },
];
var POP_DISMISS = [
  { id: 'daily',  name: '每天弹一次（次日恢复，默认）' },
  { id: 'once',   name: '只弹一次（此后永不自动弹）' },
  { id: 'always', name: '每次都弹' },
];
var POP_THEMES = [
  { id: '',        name: '默认白卡' },
  { id: 'welcome', name: '迎新橙卡（橙底白字，用于首次访问欢迎）' },
];

/* v4.0.0（站主第 9 条）：重要性三档。
   大屏（班级电脑）收到时按档位换颜色、换提示音 —— 普通一短声、重要三声、紧急连响。
   这里只存级别；具体怎么响由大屏的 big.js 决定，后台不关心播放设备。 */
var POP_LEVELS = [
  { id: '',          name: '普通（灰棕，一声轻提示）' },
  { id: 'important', name: '重要（橙色，三声提示）' },
  { id: 'urgent',    name: '紧急（红色，连响并整屏弹出）' },
];

/* ---- 读取 / 写入云端 ---- */
function popNorm(v){
  if(!Array.isArray(v)) return [];
  var out = [];
  v.forEach(function(p){
    if(!p || typeof p !== 'object' || !p.id) return;
    out.push({
      id:        String(p.id),
      scope:     String(p.scope || 'boot'),
      source:    String(p.source || 'custom'),
      title:     p.title || '',
      body:      p.body || '',
      video:     p.video || '',
      image:     p.image || '',
      linkText:  p.linkText || '',
      linkUrl:   p.linkUrl || '',
      startAt:   p.startAt || '',
      endAt:     p.endAt || '',
      dismiss:   (p.dismiss === 'once' || p.dismiss === 'always') ? p.dismiss : 'daily',
      bubble:    (p.bubble === false) ? false : true,
      bannerText: p.bannerText || '',
      theme:      p.theme || '',
      /* v4.0.0：重要性 + 创建时间（大屏靠 createdAt 判断「要不要现在弹」，
         避免一次把积压的历史消息全弹出来）。顺带补上 target —— 以前
         popNorm 是白名单，target 存进去再读回来就被吃掉了，编辑一次就丢投放对象。 */
      level:     (p.level === 'important' || p.level === 'urgent') ? p.level : '',
      createdAt: p.createdAt || '',
      target: (p.target && typeof p.target === 'object')
        ? { mode: String(p.target.mode || 'all'),
            users: Array.isArray(p.target.users) ? p.target.users : [],
            roles: Array.isArray(p.target.roles) ? p.target.roles : [],
            titles: Array.isArray(p.target.titles) ? p.target.titles : [] }
        : { mode: 'all', users: [], roles: [], titles: [] },
    });
  });
  return out;
}
function popLoad(){
  return api('/content').then(function(j){
    var it = (j && j.items) || {};
    POP_STATE.list = popNorm(it.popups);
    return j;
  });
}
function popWrite(list, okMsg){
  POP_STATE.list = list || [];
  return api('/content', { method:'PUT', body:{ items:{ popups: POP_STATE.list } } })
    .then(function(){ if(okMsg) toast(okMsg, 'ok'); return true; })
    .catch(function(e){ toast('保存失败：' + e.message, 'err', 4000); throw e; });
}

/* ============================================================================
 * ⑭ 面板：成绩分析（第四十三轮 · v2.7.1 起）
 * ----------------------------------------------------------------------------
 * 站主要求（2026-10-14 原话）：
 *   · 后台要能「改一切」—— 从"导入工具"变成"编辑工具"：
 *     新建空考试、改考试信息、像 Excel 一样改分数（点格改 / 失焦自动保存）、
 *     增删学生行、**发布之后仍然可以改**。
 *   · 分数线由站主手填（学校是按年级划线的，我们班拿不到那个基数），
 *     学校没公布就留空；三条线不继承上次。
 *   · 只录大型考试（全校 / 校际联考、月考），一年不超过 10 次。
 *
 * 【为什么导入是「整体替换本次」】
 *   站主导入的是一张完整成绩单，「本次 = 表里这些行」最符合直觉。
 *   好处：不存在重名冲突（同名同学各占一行），也不会导入两次把人搞重复。
 *
 * 【为什么改分走「增量保存」】
 *   改一格就全量重传既慢又容易覆盖别处的改动；这里只提交改动过的行
 *   （带行 id），失焦后防抖 1.5 秒自动提交，页面顶部显示保存状态。
 * ========================================================================= */

var SC_STATE = {
  exams: [],       /* 考试列表 */
  meta: null,      /* 默认科目 / 分数线 / 类型（只取一次） */
  cur: null,       /* 当前打开的考试 */
  rows: [],        /* 当前考试的成绩行 */
  dirty: {},       /* 待保存的行：{ 行id: true }（新增行用 'new:序号'） */
  timer: null,     /* 自动保存防抖计时器 */
  saving: false,
};

/* ---------------- 入口 ---------------- */
/* 考试日期的显示文案：跨天显示成 2026-05-14 ~ 05-15 */
function scDateTxt(e){
  if(!e) return '';
  var a = e.date || '', b = e.endDate || '';
  if(!b || b === a) return a;
  return a.slice(0, 4) === b.slice(0, 4) ? (a + ' ~ ' + b.slice(5)) : (a + ' ~ ' + b);
}

/* ============================================================
   对外展示（三档开关）
   —— 「标签类」内容（退步榜 / 需关注 / 四象限 / 诊断卡）落到学生手里
      可能是公开处刑，所以默认一律「完全隐藏」，要放开由站主自己决定。
   ============================================================ */
var SC_CFG = null;

var SC_DISPLAY_ITEMS = [
  { key: 'diagnosis', name: '诊断卡', hint: '「本次最值得做的事」——班均、最薄弱一科、过线人数' },
  { key: 'watchList', name: '需关注学生', hint: '低于班均 10 分的学生 + 自动识别的拖后腿科目' },
  { key: 'tailRank',  name: '进退步榜', hint: '和上一次考试比名次，进步/退步最多的几个' },
  { key: 'quadrant',  name: '四象限 + 热力图', hint: '分层教学散点图、学生 × 科目热力图' },
];

function scCfgOpt(cur, val, label){
  return '<option value="' + val + '"' + (cur === val ? ' selected' : '') + '>' + label + '</option>';
}

function scEditDisplay(){
  api('/scores?action=config').then(function(j){
    SC_CFG = j.config || {};
    var c = SC_CFG;
    var body =
        '<div class="field"><label>整个「成绩分析」对学生开放吗</label>'
      +   '<select id="cfAccess">'
      +     scCfgOpt(c.access, 'off', '关闭 —— 学生打开只看到「暂未对外开放」')
      +     scCfgOpt(c.access, 'published', '开放 —— 学生能看到已发布的考试')
      +   '</select>'
      +   '<p class="muted" style="font-size:.78rem;margin:6px 0 0">刚上手时建议先关着，等录完成绩、核对无误再开。</p></div>'

      + '<div class="field"><label>默认排名口径</label>'
      +   '<select id="cfBasis">'
      +     scCfgOpt(c.rankBasis, 'graded', '总分（赋分）—— 化学 / 生物用赋分后的分')
      +     scCfgOpt(c.rankBasis, 'raw', '总分（原始）')
      +   '</select>'
      +   '<p class="muted" style="font-size:.78rem;margin:6px 0 0">学生仍然可以在页面上自己切换。</p></div>'

      + '<div class="field"><label>趋势默认看几次</label>'
      +   '<select id="cfTrend">'
      +     scCfgOpt(c.trendDefault, 'all', '全部（推荐 —— 本班每年仅 6~8 次大型考试）')
      +     scCfgOpt(c.trendDefault, '5', '近 5 次')
      +     scCfgOpt(c.trendDefault, '3', '近 3 次')
      +   '</select></div>'

      /* v3.17.0：给本地 AI 的只读查询接口 */
      + '<div class="field" style="border:1px solid var(--line);border-radius:10px;padding:12px">'
      +   '<label style="margin-top:0">给本地 AI 的查询接口</label>'
      +   '<select id="cfAiApi">'
      +     scCfgOpt(c.aiApi, 'off', '关闭 —— 不对外提供查询')
      +     scCfgOpt(c.aiApi, 'on', '开启 —— 凭密钥可查')
      +   '</select>'
      +   '<p class="muted" style="font-size:.78rem;margin:8px 0 10px;line-height:1.6">'
      +     '给<b>自己部署了本地 AI</b>（Ollama / LM Studio 之类，没有云端 Key）的同学用：'
      +     '让模型按<b>学号</b>来查，而不是把全班成绩压成一大段塞进提示词。'
      +     '接口<b>不返回任何姓名</b>，班级只给均分、中位、分位这些聚合值；'
      +     '拿到密钥的人能查任意一个学号的分数，所以别公开贴到群里，泄露了就点重置。</p>'
      +   '<div id="aiKeyBox" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"></div>'
      +   '<div id="aiApiDemo" style="margin-top:10px;font-size:.76rem;line-height:1.7"></div>'
      + '</div>'

      + '<div class="field"><label>下面这些内容的「可见范围」</label>'
      +   '<p class="muted" style="font-size:.78rem;margin:6px 0 8px">'
      +     '以下内容<b>仅供管理员查看</b>，向学生开放易造成成绩公开比较，默认全部隐藏。'
      +     '你自己任何时候都能看到。</p>'
      +   SC_DISPLAY_ITEMS.map(function(it){
          return '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--line)">'
            + '<div style="flex:1;min-width:170px"><b style="font-size:.86rem">' + esc(it.name) + '</b>'
            +   '<p class="muted" style="font-size:.76rem;margin:3px 0 0">' + esc(it.hint) + '</p></div>'
            + '<select id="cf_' + it.key + '" style="min-width:170px">'
            +   scCfgOpt(c[it.key], 'hide', '完全隐藏（只有我能看）')
            +   scCfgOpt(c[it.key], 'self', '只给本人看自己那条')
            +   scCfgOpt(c[it.key], 'all', '全班可见')
            + '</select></div>';
        }).join('')
      + '</div>';

    var box = openModal({
      title: '对外展示',
      sub: '控制哪些内容学生能看到。改动立刻生效，学生刷新即可。',
      wide: true,
      body: body,
      actions: [
        { label: '取消', cls: 'btn-secondary', onClick: closeModal },
        { label: '保存', cls: 'btn', id: 'cfSave' },
      ],
      onMount: function(bx){
        /* v3.17.0：AI 查询密钥的生成 / 复制 / 重置 */
        function copyText(t){
          if(navigator.clipboard && navigator.clipboard.writeText){
            return navigator.clipboard.writeText(t);
          }
          return new Promise(function(res, rej){
            try{
              var ta = document.createElement('textarea');
              ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
              document.body.appendChild(ta); ta.select();
              var okk = document.execCommand('copy');
              document.body.removeChild(ta);
              okk ? res() : rej(new Error('copy failed'));
            }catch(e){ rej(e); }
          });
        }
        var kb = bx.querySelector('#aiKeyBox');
        var demo = bx.querySelector('#aiApiDemo');
        function paintKey(){
          var k = SC_CFG.aiKey || '';
          kb.innerHTML = k
            ? '<code style="font-size:.8rem;padding:5px 8px;background:var(--bg-2);border-radius:6px;word-break:break-all">'
                + esc(k) + '</code>'
              + '<button class="btn btn-sm" id="aiKeyCopy">复制密钥</button>'
              + '<button class="btn btn-sm" id="aiKeyNew">重置</button>'
            : '<span class="muted" style="font-size:.82rem">还没有密钥</span>'
              + '<button class="btn btn-sm" id="aiKeyNew">生成密钥</button>';
          var box = kb.querySelector('#aiKeyCopy');
          if(box) box.onclick = function(){
            copyText(k).then(function(){ toast('密钥已复制'); })
              .catch(function(){ toast('复制失败，手动选中吧', 'err'); });
          };
          var nw = kb.querySelector('#aiKeyNew');
          if(nw) nw.onclick = function(){
            if(k && !confirm('重置之后旧密钥立刻失效，已经配好的人要重新填。继续？')) return;
            api('/scores?action=ai-key', { method: 'POST', body: {} }).then(function(j){
              SC_CFG.aiKey = j.aiKey; SC_CFG.aiApi = 'on';
              bx.querySelector('#cfAiApi').value = 'on';
              paintKey(); paintDemo();
              toast('新密钥已生成');
            }).catch(function(e){ toast('生成失败：' + (e.message || e), 'err'); });
          };
          paintDemo();
        }
        function paintDemo(){
          var k = SC_CFG.aiKey || '本人密钥';
          var on = bx.querySelector('#cfAiApi').value === 'on';
          var base = (API_BASE || '') + '/api/scores?action=ai';
          demo.innerHTML = on
            ? '<div class="muted">可先行测试（浏览器直接打开即为可读的 Markdown）：</div>'
              + '<div style="word-break:break-all"><a href="' + esc(base + '&k=' + encodeURIComponent(k) + '&what=me&no=学号&fmt=md') + '" target="_blank" rel="noopener">'
              + esc(base + '&k=' + encodeURIComponent(k) + '&what=me&no=学号&fmt=md') + '</a></div>'
              + '<div class="muted" style="margin-top:6px">'
              +   '<code>what=me</code> 单人 · <code>what=class</code> 班级概况 · <code>what=exams</code> 考试列表 · '
              +   '<code>fmt=json</code> 给程序读</div>'
            : '<div class="muted">接口现在是关着的，打开上面的开关并生成密钥后才能用。</div>';
        }
        bx.querySelector('#cfAiApi').onchange = paintDemo;
        paintKey();

        bx.querySelector('#cfSave').onclick = function(){
          var patch = {
            access: bx.querySelector('#cfAccess').value,
            rankBasis: bx.querySelector('#cfBasis').value,
            trendDefault: bx.querySelector('#cfTrend').value,
            aiApi: bx.querySelector('#cfAiApi').value,
          };
          SC_DISPLAY_ITEMS.forEach(function(it){
            patch[it.key] = bx.querySelector('#cf_' + it.key).value;
          });
          api('/scores?action=config-save', { method: 'POST', body: { config: patch } })
            .then(function(){ closeModal(); toast('已保存，成员刷新后生效'); })
            .catch(function(e){ toast('保存失败：' + (e.message || e), 'err'); });
        };
      },
    });
  }).catch(function(e){ toast('读不到配置：' + (e.message || e), 'err'); });
}

/* ============================================================
   备份（KV）· R37
   ------------------------------------------------------------
   为什么要做：现在所有成绩、公告、作业都只有云端一份，
   数据库出一次问题就全没了。备份**必须跨服务商**（数据在 Neon、
   备份在 Cloudflare），也必须**不进公开仓库**（仓库是 public 的）。
   ============================================================ */
function scBackupDialog(){
  var body =
      '<div class="field"><label>现在做一次备份</label>'
    +   '<p class="muted" style="font-size:.8rem;margin:4px 0 10px">'
    +     '备份内容：成绩（考试 + 成绩 + 分享链接 + 配置）+ 内容数据（公告 / 作业 / 弹窗等）。'
    +     '<b>不含任何密码</b>。</p>'
    +   '<div style="display:flex;gap:8px;flex-wrap:wrap">'
    +     '<button class="btn btn-sm" id="bkRun">立即备份到云端</button>'
    +     '<button class="btn btn-sm btn-secondary" id="bkDl">下载一份到本地</button>'
    +   '</div>'
    +   '<div id="bkMsg" style="margin-top:10px"></div></div>'
    + '<div class="field"><label>云端快照</label><div id="bkList" class="muted" style="font-size:.82rem">读取中…</div></div>'
    + '<div class="field"><label>从快照还原（危险）</label>'
    +   '<p class="muted" style="font-size:.8rem;margin:4px 0 8px">'
    +     '还原会<b>覆盖</b>现有的考试与成绩。还原之前系统会自动先存一份「还原前的样子」，出错还能退回来。'
    +     'users 表（账号）<b>不会</b>被改动。</p>'
    +   '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">'
    +     '<input id="bkKey" placeholder="要还原的快照标识（点上面对话框里的「还原」自动填）" style="flex:1;min-width:220px">'
    +     '<input id="bkConfirm" placeholder="输入 RESTORE 确认" style="width:170px">'
    +     '<button class="btn btn-sm btn-danger" id="bkRestore">还原</button>'
    +   '</div></div>';

  openModal({
    title: '备份与还原',
    sub: '建议每周点一次「立即备份」。开了定时任务后它会自己跑，这里主要用来手动兜底和演练还原。',
    wide: true,
    body: body,
    actions: [{ label: '关闭', cls: 'btn-secondary', onClick: closeModal }],
    onMount: function(bx){
      var msg = bx.querySelector('#bkMsg');
      var say = function(t, ok){
        msg.innerHTML = '<div class="muted" style="font-size:.82rem;color:' + (ok ? 'var(--ok)' : 'var(--danger)') + '">' + esc(t) + '</div>';
      };

      bx.querySelector('#bkRun').onclick = function(){
        say('正在打包…');
        api('/scores?action=backup-run', { method:'POST' }).then(function(j){
          if(j.stored){
            say('已备份到云端：' + j.key + '（考试 ' + j.counts.exams + ' 次 / 成绩 ' + j.counts.examScores + ' 条）', true);
            scBackupList(bx);
          } else {
            say((j.hint || '还没配置备份存储') + ' —— 已经帮你把快照准备好，点「下载一份到本地」就能存下来。');
          }
        }).catch(function(e){ say('备份失败：' + (e.message || e)); });
      };

      bx.querySelector('#bkDl').onclick = function(){
        say('正在生成文件…');
        fetch(API_BASE + '/api/scores?action=backup-export', {
          headers: { Authorization: 'Bearer ' + STATE.token },
        }).then(function(r){
          if(!r.ok) throw new Error('HTTP ' + r.status);
          return r.blob();
        }).then(function(blob){
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = 'class-site-backup-' + new Date().toISOString().slice(0,10) + '.json';
          document.body.appendChild(a); a.click();
          setTimeout(function(){ URL.revokeObjectURL(url); if(a.parentNode) a.parentNode.removeChild(a); }, 1500);
          say('已开始下载（请自己保存好，这份文件包含全班成绩，别外传）', true);
        }).catch(function(e){ say('下载失败：' + (e.message || e)); });
      };

      bx.querySelector('#bkRestore').onclick = function(){
        var key = (bx.querySelector('#bkKey').value || '').trim();
        var cf = (bx.querySelector('#bkConfirm').value || '').trim();
        if(!key){ say('先填要还原的快照标识'); return; }
        if(cf !== 'RESTORE'){ say('请在确认框里原样输入 RESTORE'); return; }
        if(!confirm('确定要还原吗？现在的考试与成绩会被覆盖。')) return;
        say('正在还原…');
        api('/scores?action=backup-restore', { method:'POST', body: { key: key, confirm: 'RESTORE' } })
          .then(function(j){
            say('还原完成：考试 ' + j.restored.exams + ' 次 / 成绩 ' + j.restored.examScores + ' 条'
              + (j.beforeRestoreKey ? '（还原前那份存为 ' + j.beforeRestoreKey + '）' : ''), true);
            scLoad();
          }).catch(function(e){ say('还原失败：' + (e.message || e)); });
      };

      scBackupList(bx);
    },
  });
}

function scBackupList(bx){
  var box = bx.querySelector('#bkList');
  api('/scores?action=backup-list').then(function(j){
    var items = j.items || [];
    if(!items.length){ box.innerHTML = '云端还没有快照 —— 点上面的「立即备份到云端」建一份。'; return; }
    box.innerHTML = '<div style="display:flex;flex-direction:column;gap:6px">'
      + items.map(function(x){
          return '<div style="display:flex;align-items:center;gap:9px;padding:6px 10px;border:1px solid var(--line);border-radius:9px">'
            + '<span style="flex:1;font-family:ui-monospace,Menlo,monospace;font-size:.76rem">' + esc(x.key.replace('backup/','')) + '</span>'
            + '<button class="btn btn-sm btn-secondary" data-bkdl="' + esc(x.key) + '">下载</button>'
            + '<button class="btn btn-sm btn-secondary" data-bkrs="' + esc(x.key) + '">还原</button>'
            + '</div>';
        }).join('') + '</div>'
      + '<p class="muted" style="font-size:.76rem;margin:8px 0 0">云端最多保留 ' + j.keep + ' 份，超出的会自动删最旧的。</p>';

    Array.prototype.forEach.call(box.querySelectorAll('[data-bkdl]'), function(b){
      b.onclick = function(){
        var k = b.getAttribute('data-bkdl');
        fetch(API_BASE + '/api/scores?action=backup-get&key=' + encodeURIComponent(k), {
          headers: { Authorization: 'Bearer ' + STATE.token },
        }).then(function(r){ return r.blob(); }).then(function(blob){
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url; a.download = k.replace('backup/', '');
          document.body.appendChild(a); a.click();
          setTimeout(function(){ URL.revokeObjectURL(url); if(a.parentNode) a.parentNode.removeChild(a); }, 1500);
        });
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-bkrs]'), function(b){
      b.onclick = function(){ bx.querySelector('#bkKey').value = b.getAttribute('data-bkrs'); bx.querySelector('#bkConfirm').focus(); };
    });
  }).catch(function(e){
    box.innerHTML = '<span style="color:var(--danger)">' + esc(e.message || '读不到快照列表') + '</span>'
      + '<br><span class="muted" style="font-size:.78rem">（多半是还没在 Cloudflare 建 KV 命名空间 —— 见仓库文档「备份」一节）</span>';
  });
}

function renderScores(){
  $('view').innerHTML =
    '<div class="toolbar" style="background:var(--panel)">'
    +  '<div style="flex:1;min-width:0"><b style="font-size:.92rem">成绩分析</b>'
    +    '<p class="muted" style="margin:4px 0 0;font-size:.8rem">'
    +      '只录大型考试（全校 / 校际联考、月考）。导入或手填 → 核对 → 发布，同学才看得到。'
    +    '</p></div>'
    +  '<button class="btn btn-sm btn-secondary" id="scRefresh">' + svg('refresh',14) + ' 刷新</button>'
    +  '<button class="btn btn-sm btn-secondary" id="scDisplay">对外展示</button>'
    +  '<button class="btn btn-sm btn-secondary" id="scNames">姓名对照</button>'
    +  '<button class="btn btn-sm btn-secondary" id="scBackup">备份</button>'
    +  '<button class="btn btn-sm" id="scNew">' + svg('plus',14) + ' 新建考试</button>'
    + '</div>'
    + '<section class="panel"><div id="scBody"><div class="loading"><div class="spinner"></div>加载中…</div></div></section>';

  $('scRefresh').onclick = scLoad;
  $('scNew').onclick = function(){ scEditExam(null); };
  $('scDisplay').onclick = scEditDisplay;
  $('scNames').onclick = scNameDialog;
  $('scBackup').onclick = scBackupDialog;
  scLoad();
}

/* ============================================================
 * 姓名对照（v2.9.5）
 * ------------------------------------------------------------
 * 站主原话：「雷其桐就是雷博雅」。同一个人，成绩表里写的名字和站点账号
 * 不一样，系统就认不出来 —— 他登录后看不到自己。
 * 这里列出「成绩表里出现过、却没绑上账号」的姓名：选一下他是班里的谁，
 * 对照关系就存到云端（score_config 的 nameMap），以后导入自动生效。
 * 说明：**不动账号本身**。登录名是凭据（改名要连带改登录），
 *       而且成绩表的名字将来还可能再变 —— 记一张表最省事也最安全。
 * ============================================================ */
var SC_NAME = { users: [], map: {}, unbound: [], bound: 0 };

function scNameDialog(){
  openModal({
    title: '姓名对照',
    sub: '成绩表里的名字 → 班里的账号（同一个人两种叫法）',
    wide: true,
    body: '<div id="scNameBody"><div class="loading"><div class="spinner"></div>加载中…</div></div>',
    foot: '<button class="btn btn-ghost" data-nm-close>关闭</button>'
        + '<button class="btn btn-secondary" data-nm-reload>' + svg('refresh',14) + ' 重新检查</button>',
    onMount: function(box){
      box.querySelector('[data-nm-close]').onclick = closeModal;
      box.querySelector('[data-nm-reload]').onclick = scNameLoad;
      scNameLoad();
    },
  });
}

function scNameLoad(){
  var el = $('scNameBody');
  if(el) el.innerHTML = '<div class="loading"><div class="spinner"></div>加载中…</div>';
  api('/scores?action=unbound').then(function(j){
    SC_NAME.users = j.users || [];
    SC_NAME.map = j.nameMap || {};
    SC_NAME.unbound = j.unbound || [];
    SC_NAME.bound = j.boundCount || 0;
    scNamePaint();
  }).catch(function(e){
    if(el) el.innerHTML = '<div class="empty">加载失败：' + esc(e.message || e) + '</div>';
  });
}

function scNamePaint(){
  var el = $('scNameBody');
  if(!el) return;
  var mapKeys = Object.keys(SC_NAME.map || {});
  var rows = SC_NAME.unbound || [];
  /* 候选账号写成「姓名（账号）」—— 同名不同账号时也能分清 */
  var opts = SC_NAME.users.map(function(u){
    var label = u.name + (u.username && u.username !== u.name ? '（' + u.username + '）' : '');
    return '<option value="' + attr(u.name) + '">' + esc(label) + '</option>';
  }).join('');
  var nameOpts = SC_NAME.users.map(function(u){
    return '<option value="' + attr(u.name) + '">';
  }).join('');

  var html = '<datalist id="nmNames">' + nameOpts + '</datalist>'
    + '<div class="alert info" style="margin-bottom:14px">'
    + '成绩表里的姓名和站点账号对不上的会列在下面，按情况选一种：<br>'
    + '<b>① 是同一个人、只是叫法不同</b>（比如改名了）→ 右边<b>选一个账号</b>点「关联」，'
    + '记一条对照关系，以后导入自动认。<br>'
    + '<b>② 名字压根打错了</b> → 在「改成正确姓名」里填对再点「改名」，'
    + '直接把成绩行里的名字改掉（<b>不建对照关系</b>）；名字出现在多次考试的，还能「按考试分别改」。<br>'
    + '两种做法都<b>不会改动账号本身</b>。'
    + '</div>';

  if(rows.length){
    html += '<div style="font-weight:700;margin-bottom:8px">还没对上的姓名（' + rows.length + ' 个）</div>'
      + '<div style="max-width:100%;overflow:auto"><table style="width:100%">'
      + '<thead><tr><th>成绩表里的姓名</th><th>出现</th>'
      +   '<th>① 关联到账号</th><th>② 改成正确姓名</th></tr></thead><tbody>'
      + rows.map(function(x){
          var exs = x.exams || [];
          var exRows = exs.map(function(e){
            return '<tr data-nm-exof="' + attr(x.name) + '" style="display:none">'
              + '<td colspan="4" style="padding:4px 8px 4px 24px;background:#faf7f3">'
              +   '<span class="muted" style="font-size:.78rem">' + esc(e.name) + '　' + esc(e.date || '')
              +     '　' + e.rows + ' 行</span>'
              +   ' <input data-nm-exinput="' + attr(x.name + '|' + e.id) + '" list="nmNames" '
              +     'placeholder="正确姓名" style="width:120px;margin:0 6px;padding:3px 6px">'
              +   ' <button class="btn btn-sm" data-nm-exgo="' + attr(x.name + '|' + e.id) + '">只改这次</button>'
              + '</td></tr>';
          }).join('');
          return '<tr>'
            + '<td><b>' + esc(x.name) + '</b>'
            +   (x.alias ? '<span class="badge badge-gray" style="margin-left:6px">已配 ' + esc(x.alias) + '</span>' : '')
            +   (exs.length > 1 ? '<div><a href="javascript:;" data-nm-toggle="' + attr(x.name) + '" '
                  + 'style="font-size:.74rem;color:#c2410c">按考试分别改 ▾</a></div>' : '')
            + '</td>'
            + '<td class="muted">' + x.count + ' 次考试</td>'
            + '<td><select data-nm-pick="' + attr(x.name) + '" style="max-width:180px">'
            +   '<option value="">— 选择账号 —</option>' + opts + '</select>'
            +   ' <button class="btn btn-sm" data-nm-bind="' + attr(x.name) + '">关联</button></td>'
            + '<td><input data-nm-rename="' + attr(x.name) + '" list="nmNames" '
            +   'placeholder="正确姓名" style="width:120px;padding:3px 6px">'
            +   ' <button class="btn btn-sm btn-secondary" data-nm-rn-go="' + attr(x.name) + '">改名</button></td>'
            + '</tr>' + exRows;
        }).join('')
      + '</tbody></table></div>';
  } else {
    html += '<div class="alert ok" style="margin-bottom:14px">'
      + '成绩表里的姓名全都对得上账号了（已对上 ' + SC_NAME.bound + ' 个），没有需要处理的。</div>';
  }

  if(mapKeys.length){
    html += '<div style="font-weight:700;margin:16px 0 8px">已配好的对照（' + mapKeys.length + ' 条）</div>'
      + '<div style="max-width:100%;overflow:auto"><table style="width:100%">'
      + '<thead><tr><th>成绩表里的姓名</th><th>认作</th><th></th></tr></thead><tbody>'
      + mapKeys.map(function(k){
          return '<tr><td>' + esc(k) + '</td><td><b>' + esc(SC_NAME.map[k]) + '</b></td>'
            + '<td><button class="btn btn-sm btn-ghost" data-nm-unbind="' + attr(k) + '" style="color:#b3261e">取消关联</button></td></tr>';
        }).join('')
      + '</tbody></table></div>'
      + '<p class="muted" style="font-size:.8rem;margin:8px 0 0">取消关联后，这些成绩行会解绑账号（成绩数据不动，只是他个人页看不到自己的那部分）。'
      + '如为姓名录入错误，可使用上方「② 改名」，修改后长期有效。</p>';
  }

  el.innerHTML = html;

  var each = Array.prototype.forEach;
  var pickOf = function(name, attrName){
    var box = null;
    each.call(el.querySelectorAll('[' + attrName + ']'), function(x){
      if(x.getAttribute(attrName) === name) box = x;
    });
    return box;
  };

  each.call(el.querySelectorAll('[data-nm-bind]'), function(b){
    b.onclick = function(){
      var name = b.getAttribute('data-nm-bind');
      var sel = pickOf(name, 'data-nm-pick');
      var target = sel ? sel.value : '';
      if(!target){ toast('先给他选一个账号', 'err'); return; }
      scNameBind(name, target);
    };
  });
  each.call(el.querySelectorAll('[data-nm-unbind]'), function(b){
    b.onclick = function(){ scNameBind(b.getAttribute('data-nm-unbind'), ''); };
  });

  /* ② 直接改名：全部（这个名字出现在所有考试里） */
  each.call(el.querySelectorAll('[data-nm-rn-go]'), function(b){
    b.onclick = function(){
      var name = b.getAttribute('data-nm-rn-go');
      var inp = pickOf(name, 'data-nm-rename');
      var to = inp ? String(inp.value || '').trim() : '';
      if(!to){ toast('先填要改成的正确姓名', 'err'); return; }
      if(to === name){ toast('改前和改后是同一个名字', 'err'); return; }
      scNameRename(name, to, 0);
    };
  });

  /* 「按考试分别改」展开/收起 */
  each.call(el.querySelectorAll('[data-nm-toggle]'), function(a){
    a.onclick = function(){
      var name = a.getAttribute('data-nm-toggle');
      var open = a.getAttribute('data-open') === '1';
      a.setAttribute('data-open', open ? '0' : '1');
      a.textContent = open ? '按考试分别改 ▾' : '收起 ▴';
      each.call(el.querySelectorAll('[data-nm-exof]'), function(tr){
        if(tr.getAttribute('data-nm-exof') === name) tr.style.display = open ? 'none' : 'table-row';
      });
    };
  });
  /* ② 直接改名：只改某一次 */
  each.call(el.querySelectorAll('[data-nm-exgo]'), function(b){
    b.onclick = function(){
      var key = b.getAttribute('data-nm-exgo');
      var k = key.split('|');
      var inp = pickOf(key, 'data-nm-exinput');
      var to = inp ? String(inp.value || '').trim() : '';
      if(!to){ toast('先填要改成的正确姓名', 'err'); return; }
      if(to === k[0]){ toast('改前和改后是同一个名字', 'err'); return; }
      scNameRename(k[0], to, Number(k[1] || 0));
    };
  });
}

/* 直接改成绩行里的姓名（不写别名对照）。examId=0 → 这个名字出现的所有考试都改 */
function scNameRename(from, to, examId){
  api('/scores?action=name-rename', { method:'POST', body:{ from: from, to: to, exam: examId || 0 } })
    .then(function(j){
      if(!j || !j.ok){ toast('改名失败：' + ((j && j.error) || '未知错误'), 'err', 4200); return; }
      var msg = '已把「' + from + '」改成「' + to + '」，共 ' + (j.renamed || 0) + ' 行';
      if(!j.bound) msg += '（新姓名没对上账号，可能又打错了）';
      var bad = (j.conflicts || []).length;
      if(bad) msg += '；有 ' + bad + ' 次考试里本来就有「' + to + '」，为免重复没动，请到改分表核对';
      toast(msg, bad || !j.bound ? 'err' : 'ok', 5600);
      scNameLoad();
    })
    .catch(function(e){ toast('改名失败：' + (e.message || e), 'err', 4200); });
}

function scNameBind(name, target){
  var btn = null;
  Array.prototype.forEach.call(document.querySelectorAll('[data-nm-bind]'), function(b){
    if(b.getAttribute('data-nm-bind') === name) btn = b;
  });
  if(btn){ btn.disabled = true; btn.textContent = '处理中…'; }
  api('/scores?action=name-bind', { method:'POST', body:{ name: name, target: target } })
    .then(function(j){
      toast(target
        ? ('已把「' + name + '」关联到「' + target + '」，影响 ' + (j.changed || 0) + ' 行成绩')
        : ('已取消「' + name + '」的关联（影响 ' + (j.changed || 0) + ' 行）'), 'ok', 4200);
      scNameLoad();
    })
    .catch(function(e){
      if(btn){ btn.disabled = false; btn.textContent = '关联'; }
      toast('保存失败：' + (e.message || e), 'err', 4200);
    });
}

function scLoad(){
  $('scBody').innerHTML = '<div class="loading"><div class="spinner"></div>加载中…</div>';
  var jobs = [ api('/scores?action=list') ];
  if(!SC_STATE.meta) jobs.push(api('/scores?action=meta'));

  Promise.all(jobs).then(function(r){
    SC_STATE.exams = (r[0] && r[0].exams) || [];
    if(r[1]) SC_STATE.meta = r[1];
    scPaintExams();
  }).catch(function(e){
    $('scBody').innerHTML = '<div class="empty">加载失败：' + esc(e.message || e) + '</div>';
  });
}

/* ---------------- 考试列表 ---------------- */
function scPaintExams(){
  var list = SC_STATE.exams;
  if(!list.length){
    $('scBody').innerHTML = '<div class="empty">'
      + '<div style="font-size:2rem;margin-bottom:10px">📊</div>'
      + '暂无考试。<br>点右上角「新建考试」建一次（填名称、时间、分数线），'
      + '再「导入成绩」或直接手填。'
      + '</div>';
    return;
  }

  $('scBody').innerHTML = list.map(scExamCard).join('');
  $('scBody').onclick = function(ev){
    var b = ev.target.closest ? ev.target.closest('[data-sc-act]') : null;
    if(!b) return;
    var id = Number(b.getAttribute('data-sc-id'));
    var act = b.getAttribute('data-sc-act');
    if(act === 'edit')        scEditExam(id);
    else if(act === 'import') scImport(id);
    else if(act === 'rows')   scEditRows(id);
    else if(act === 'export') scExportDialog(id);
    else if(act === 'pub')    scPublish(id, true);
    else if(act === 'unpub')  scPublish(id, false);
    else if(act === 'del')    scDeleteExam(id);
  };
}

function scExamCard(e){
  var pub = e.status === 'published';
  var cuts = (e.cutlines || []).filter(function(c){ return c.score != null; });
  var n = e.rowCount || 0;
  var visN = (e.visibleTo && e.visibleTo.length) ? e.visibleTo.length : 0;

  return '<section class="panel" style="margin-bottom:12px;padding:14px 16px">'
    + '<div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">'
    +   '<div style="flex:1;min-width:200px">'
    +     '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
    +       '<b style="font-size:.95rem">' + esc(e.name) + '</b>'
    +       (pub ? '<span class="badge badge-green">已发布' + (visN ? ' · 指定 ' + visN + ' 人' : ' · 全体') + '</span>'
              : '<span class="badge badge-gray">草稿（同学看不到）</span>')
    +       (n ? '' : '<span class="badge badge-gray">还没有成绩</span>')
    +     '</div>'
    +     '<p class="muted" style="margin:5px 0 0;font-size:.8rem">'
    +       esc(scDateTxt(e)) + (e.type ? ' · ' + esc(e.type) : '') + ' · ' + n + ' 人'
    +       (cuts.length ? '<br>分数线：' + cuts.map(function(c){
              return esc(c.label) + ' ' + c.score;
            }).join(' ／ ') : '<br>分数线：本次未填')
    +     '</p>'
    +     (e.note ? '<p class="muted" style="margin:4px 0 0;font-size:.78rem">备注：' + esc(e.note) + '</p>' : '')
    +   '</div>'
    +   '<div style="display:flex;gap:8px;flex-wrap:wrap">'
    +     '<button class="btn btn-sm btn-secondary" data-sc-act="edit" data-sc-id="' + e.id + '">考试信息</button>'
    +     '<button class="btn btn-sm btn-secondary" data-sc-act="import" data-sc-id="' + e.id + '">导入成绩</button>'
    +     '<button class="btn btn-sm" data-sc-act="rows" data-sc-id="' + e.id + '">改分 / 查看</button>'
    +     '<button class="btn btn-sm btn-secondary" data-sc-act="export" data-sc-id="' + e.id + '">导出</button>'
    +     (pub
        ? '<button class="btn btn-sm btn-secondary" data-sc-act="unpub" data-sc-id="' + e.id + '">撤回</button>'
        : '<button class="btn btn-sm btn-green" data-sc-act="pub" data-sc-id="' + e.id + '">发布</button>')
    +     '<button class="btn btn-sm btn-danger" data-sc-act="del" data-sc-id="' + e.id + '">删除</button>'
    +   '</div>'
    + '</div></section>';
}

/* ---------------- 发布 / 删除 ---------------- */
/* 发布（2026-10-17 站主要求）：先选「全体 / 指定同学」，再发。 */
function scPublish(id, publish){
  if(!publish){
    if(!confirm('撤回后，同学立刻看不到这次考试（数据仍在，随时能再发布）。\n\n确认撤回？')) return;
    return scDoPublish(id, false, null);
  }
  scPublishDialog(id);
}

function scDoPublish(id, publish, visibleTo){
  api('/scores?action=exam-publish', { method:'POST', body: { id: id, publish: !!publish, visibleTo: visibleTo || undefined } })
    .then(function(){ toast(publish ? '已发布' : '已撤回', 'ok'); scLoad(); })
    .catch(function(e){ toast('操作失败：' + e.message, 'err', 4200); });
}

function scPublishDialog(id){
  var e = scFindExam(id);
  api('/scores?action=unbound').then(function(j){
    var users = (j && j.users) || [];
    if(!users.length){ toast('还没有可选的用户，先在「成员与档案」里建好账号', 'err', 4200); return; }
    var list = users.map(function(x){
      return '<label style="display:inline-block;min-width:104px;margin:3px 8px 3px 0;font-size:.82rem">'
        + '<input type="checkbox" class="sc-pub-ck" value="' + Number(x.id) + '"> '
        + esc(x.name || x.username || '') + '</label>';
    }).join('');
    openModal({
      title: '发布成绩 · 选择谁可见',
      sub: '「' + (e ? e.name : id) + '」发布给：全体同学，或只给指定同学。',
      wide: true,
      body: '<div class="sc-pub-mode">'
        +   '<label style="display:block;font-size:.86rem;color:#57534e"><input type="radio" name="scPubMode" value="all" checked> 全体同学（本班登录都能看）</label>'
        +   '<label style="display:block;margin-top:8px;font-size:.86rem;color:#57534e"><input type="radio" name="scPubMode" value="some"> 只给指定同学</label>'
        + '</div>'
        + '<div id="scPubList" style="display:none;margin-top:10px;max-height:320px;overflow:auto;border:1px solid #efe6da;border-radius:8px;padding:8px 10px">' + list + '</div>'
        + '<div class="alert info" style="margin-top:10px">指定发布时，名单外的人登录看不到这次考试（管理员不受限）。</div>',
      foot: '<button class="btn btn-secondary" id="scPubCancel">取消</button>'
          + '<button class="btn" id="scPubGo">发布</button>',
      onMount: function(box){
        var listBox = box.querySelector('#scPubList');
        box.querySelector('#scPubCancel').onclick = closeModal;
        Array.prototype.forEach.call(box.querySelectorAll('input[name="scPubMode"]'), function(r){
          r.onchange = function(){ listBox.style.display = (r.value === 'some' && r.checked) ? 'block' : 'none'; };
        });
        box.querySelector('#scPubGo').onclick = function(){
          var mode = (box.querySelector('input[name="scPubMode"]:checked') || {}).value || 'all';
          var ids = [];
          if(mode === 'some'){
            Array.prototype.forEach.call(box.querySelectorAll('.sc-pub-ck'), function(c){ if(c.checked) ids.push(Number(c.value)); });
            if(!ids.length){ toast('请至少勾一位同学，或改选「全体」', 'err'); return; }
          }
          closeModal();
          scDoPublish(id, true, mode === 'some' ? ids : null);
        };
      },
    });
  }).catch(function(err){ toast('读取用户名单失败：' + err.message, 'err', 4500); });
}

function scDeleteExam(id){
  var e = scFindExam(id);
  var n = e ? (e.rowCount || 0) : 0;
  if(!confirm('删除「' + (e ? e.name : id) + '」？\n\n这会连它下面 ' + n + ' 条成绩一起删掉，无法恢复。')) return;
  api('/scores?action=exam-delete', { method:'POST', body: { id: id } })
    .then(function(){ toast('已删除', 'ok'); scLoad(); })
    .catch(function(e2){ toast('删除失败：' + e2.message, 'err', 4000); });
}

/* ---------------- 成绩导出（Excel / PDF · 2026-10-17 站主要求） ----------------
   内容：考试名称/日期/分数线 + 各科分数 + 总分 + 班排 + 年级排名 + 联考排名。
   班排当场按赋分口径总分排序算（系统不存班排）。 */
function scExportPrep(j){
  var e = j.exam || {}, rows = (j.rows || []).slice(), subs = e.subjects || [];
  var pick = function(r, sub){
    var v = r.s && r.s[sub.key];
    if(!v) return null;
    var x = (sub.graded && v.assigned != null) ? v.assigned : v.raw;
    return x == null ? null : Number(x);
  };
  rows.forEach(function(r){
    var t = 0, any = false;
    subs.forEach(function(sub){ var v = pick(r, sub); if(v != null){ t += v; any = true; } });
    r._total = any ? t : null;
  });
  var sorted = rows.filter(function(r){ return r._total != null; }).sort(function(a, b){ return b._total - a._total; });
  var rk = 0, prev = null;
  sorted.forEach(function(r, i){ if(prev === null || r._total !== prev){ rk = i + 1; prev = r._total; } r._rank = rk; });
  return { e: e, rows: rows, subs: subs, pick: pick, cuts: (e.cutlines || []).filter(function(c){ return c.score != null; }) };
}
function scExportMeta(e, cuts){
  var l = [];
  var d = (e.date || '') + (e.endDate && e.endDate !== e.date ? ' ~ ' + e.endDate : '');
  l.push((e.type || '考试') + '　' + d);
  if(cuts.length) l.push('分数线：' + cuts.map(function(c){ return c.label + ' ' + c.score; }).join('　'));
  return l;
}
function scExportDialog(id){
  var e = scFindExam(id);
  openModal({
    title: '导出成绩 · ' + (e ? e.name : id),
    sub: '含考试名称 / 日期、分数线、各科分数、总分、班排、年级排名、联考排名。',
    body: '<div style="display:flex;gap:10px;flex-wrap:wrap">'
      + '<button class="btn" id="exXlsx">导出 Excel（.xlsx）</button>'
      + '<button class="btn btn-secondary" id="exPdf">导出 PDF（打印后另存为 PDF）</button></div>'
      + '<p class="muted" style="margin-top:10px;font-size:.8rem">PDF：会打开打印窗口，在「目标打印机」里选「另存为 PDF」即可。</p>',
    foot: '<button class="btn btn-secondary" onclick="closeModal()">关闭</button>',
    onMount: function(box){
      box.querySelector('#exXlsx').onclick = function(){ closeModal(); scExportXlsx(id); };
      box.querySelector('#exPdf').onclick = function(){ closeModal(); scExportPdf(id); };
    },
  });
}
function scExportXlsx(id){
  api('/scores?action=board&exam=' + id).then(function(j){
    loadXLSX().then(function(XLSX){
      if(!XLSX){ toast('表格组件加载失败（CDN 不可达），请稍后重试', 'err', 4000); return; }
      var P = scExportPrep(j), e = P.e, subs = P.subs;
      var aoa = [[e.name + '　成绩表']];
      scExportMeta(e, P.cuts).forEach(function(x){ aoa.push([x]); });
      aoa.push([]);
      var head = ['班排', '姓名', '学号'].concat(subs.map(function(s){ return s.name + (s.graded ? '（赋分）' : ''); }))
        .concat(['总分（赋分）', '年级排名', '联考排名']);
      aoa.push(head);
      P.rows.slice().sort(function(a, b){ return (a._rank || 9999) - (b._rank || 9999); }).forEach(function(r){
        var line = [r._rank == null ? '' : r._rank, r.name || '', r.no || ''];
        subs.forEach(function(s){ var v = P.pick(r, s); line.push(v == null ? '' : v); });
        line.push(r._total == null ? '' : Math.round(r._total * 10) / 10,
                  r.schoolRank == null ? '' : r.schoolRank,
                  r.leagueRank == null ? '' : r.leagueRank);
        aoa.push(line);
      });
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: head.length - 1 } }];
      ws['!cols'] = head.map(function(_, i){ return { wch: i < 3 ? 10 : 9 }; });
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '成绩表');
      XLSX.writeFile(wb, String(e.name || '成绩') + '_成绩.xlsx');
      toast('已导出 Excel', 'ok', 3000);
    });
  }).catch(function(err){ toast('导出失败：' + err.message, 'err', 4200); });
}
function scExportPdf(id){
  api('/scores?action=board&exam=' + id).then(function(j){
    var P = scExportPrep(j), e = P.e, subs = P.subs;
    var head = ['班排', '姓名', '学号'].concat(subs.map(function(s){ return esc(s.name) + (s.graded ? '<br><span style="font-size:9px;color:#888">赋分</span>' : ''); }))
      .concat(['总分', '年级排名', '联考排名']);
    var trs = P.rows.slice().sort(function(a, b){ return (a._rank || 9999) - (b._rank || 9999); }).map(function(r){
      return '<tr><td>' + (r._rank == null ? '' : r._rank) + '</td><td>' + esc(r.name || '') + '</td><td>' + esc(r.no || '') + '</td>'
        + subs.map(function(s){ var v = P.pick(r, s); return '<td>' + (v == null ? '—' : v) + '</td>'; }).join('')
        + '<td><b>' + (r._total == null ? '—' : (Math.round(r._total * 10) / 10)) + '</b></td>'
        + '<td>' + (r.schoolRank == null ? '—' : r.schoolRank) + '</td>'
        + '<td>' + (r.leagueRank == null ? '—' : r.leagueRank) + '</td></tr>';
    }).join('');
    var meta = scExportMeta(e, P.cuts).map(function(x){ return '<div>' + esc(x) + '</div>'; }).join('');
    var html = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(e.name || '成绩') + ' 成绩表</title>'
      + '<style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#222;padding:16px}'
      + 'h1{font-size:18px;margin:0 0 6px}.meta{font-size:12px;color:#555;margin-bottom:10px;line-height:1.7}'
      + 'table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #bbb;padding:4px 5px;text-align:center}'
      + 'th{background:#f0f0f0}@media print{@page{size:A4 landscape;margin:10mm}}</style></head><body>'
      + '<h1>' + esc(e.name || '成绩') + '　成绩表</h1><div class="meta">' + meta + '</div>'
      + '<table><thead><tr>' + head.map(function(h){ return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>' + trs + '</tbody></table>'
      + '<div style="font-size:11px;color:#777;margin-top:10px">共 ' + P.rows.length + ' 人　·　总分按赋分口径累加　·　化学/生物为赋分</div>'
      + '</body></html>';
    var w = window.open('', '_blank');
    if(!w){ toast('浏览器拦截了新窗口，请允许弹窗后重试', 'err', 4200); return; }
    w.document.write(html); w.document.close();
    w.focus();
    setTimeout(function(){ try { w.print(); } catch(e){} }, 350);
  }).catch(function(err){ toast('导出失败：' + err.message, 'err', 4200); });
}

function scFindExam(id){
  for(var i = 0; i < SC_STATE.exams.length; i++) if(SC_STATE.exams[i].id === id) return SC_STATE.exams[i];
  return null;
}

/* ============================================================================
 * 新建 / 编辑考试
 * ========================================================================= */
function scEditExam(id){
  var e = id ? scFindExam(id) : null;
  var meta = SC_STATE.meta || {};
  var subs = (e && e.subjects && e.subjects.length ? e.subjects : (meta.defaultSubjects || []))
    .map(function(s){ return { key:s.key, name:s.name, full:s.full, graded:!!s.graded, on:true }; });
  /* 兜底：后端 meta 没回来时也要能用 */
  if(!subs.length) subs = [
    { key:'chinese', name:'语文', full:150, graded:false, on:true },
    { key:'math', name:'数学', full:150, graded:false, on:true },
    { key:'english', name:'英语', full:150, graded:false, on:true },
    { key:'physics', name:'物理', full:100, graded:false, on:true },
    { key:'chemistry', name:'化学', full:100, graded:true, on:true },
    { key:'biology', name:'生物', full:100, graded:true, on:true },
  ];
  var cuts = (e && e.cutlines && e.cutlines.length ? e.cutlines : (meta.defaultCutlines || []))
    .map(function(c){ return { key:c.key, label:c.label, score:c.score, color:c.color }; });
  if(!cuts.length) cuts = [
    { key:'special', label:'特控线', score:null, color:'#b45309' },
    { key:'undergrad', label:'本科线', score:null, color:'#c0392b' },
    { key:'line600', label:'600 分线', score:600, color:'#7c3aed' },
  ];
  var types = meta.examTypes || ['全校联考','校际联考','月考','期中','期末','其他'];
  var d = new Date();
  var today = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');

  openModal({
    title: e ? '编辑考试信息' : '新建考试',
    sub: '名称和时间必填，其余可以先空着，之后随时改',
    wide: true,
    body:
        '<div class="field"><label>考试名称 <span style="color:var(--danger)">*</span></label>'
      +   '<input id="scName" maxlength="60" placeholder="例：高二上·第一次段考" value="' + esc(e ? e.name : '') + '"></div>'
      + '<div style="display:flex;gap:12px;flex-wrap:wrap">'
      +   '<div class="field" style="flex:1;min-width:140px"><label>考试开始 <span style="color:var(--danger)">*</span></label>'
      +     '<input id="scDate" type="date" value="' + esc(e ? e.date : today) + '"></div>'
      +   '<div class="field" style="flex:1;min-width:140px"><label>结束日期（不跨天就留空）</label>'
      +     '<input id="scEndDate" type="date" value="' + esc(e && e.endDate ? e.endDate : '') + '"></div>'
      +   '<div class="field" style="flex:1;min-width:140px"><label>考试类型</label>'
      +     '<select id="scType">' + types.map(function(t){
              return '<option value="' + esc(t) + '"' + (e && e.type === t ? ' selected' : '') + '>' + esc(t) + '</option>';
            }).join('') + '</select></div>'
      + '</div>'
      + '<div class="field"><label>科目与满分（取消勾选本次未考科目；化学 / 生物按本班规则默认赋分）</label>'
      +   '<div id="scSubjBox" style="margin-top:6px">'
      +     subs.map(scSubjRow).join('')
      +   '</div></div>'
      + '<div class="field"><label>分数线（学校没公布就留空，留空=不画也不统计）</label>'
      +   '<div id="scCutBox" style="margin-top:6px">' + cuts.map(scCutRow).join('') + '</div>'
      +   '<button type="button" class="btn btn-sm btn-secondary" id="scCutAdd" style="margin-top:6px">'
      +     svg('plus',13) + ' 再加一条线</button></div>'
      + '<div style="display:flex;gap:12px;flex-wrap:wrap">'
      +   '<div class="field" style="flex:1;min-width:150px"><label>年级人数（可空）</label>'
      +     '<input id="scGradeN" type="number" min="1" placeholder="例：760" value="'
      +       (e && e.gradeRef && e.gradeRef.students != null ? e.gradeRef.students : '') + '"></div>'
      +   '<div class="field" style="flex:1;min-width:150px"><label>年级均分（可空）</label>'
      +     '<input id="scGradeAvg" type="number" step="0.1" placeholder="例：480" value="'
      +       (e && e.gradeRef && e.gradeRef.avgTotal != null ? e.gradeRef.avgTotal : '') + '"></div>'
      + '</div>'
      + '<div class="field"><label>备注（可空）</label>'
      +   '<input id="scNote" maxlength="200" placeholder="例：本次生物未考" value="' + esc(e ? e.note : '') + '"></div>'
      + '<div class="alert info" style="margin-top:4px">填了年级人数就能算「你在年级前百分之几」；'
      +   '填了年级均分还能看「本班 vs 年级」的变化。都没有就留空，不影响别的功能。</div>',
    foot: '<button class="btn btn-secondary" id="scCancel">取消</button>'
        + '<button class="btn" id="scSave">' + (e ? '保存修改' : '创建考试') + '</button>',
    onMount: function(box){
      box.querySelector('#scCancel').onclick = closeModal;
      box.querySelector('#scCutAdd').onclick = function(){
        var arr = cuts.concat([{ key:'line' + Date.now(), label:'', score:null, color:'#6b7280' }]);
        cuts = arr;
        box.querySelector('#scCutBox').innerHTML = cuts.map(scCutRow).join('');
      };
      box.querySelector('#scSave').onclick = function(){
        var payload = scCollectExam(box);
        if(!payload) return;
        var btn = box.querySelector('#scSave');
        btn.disabled = true;
        api('/scores?action=exam-save', { method:'POST', body: Object.assign({ id: e ? e.id : 0 }, payload) })
          .then(function(j){
            toast(e ? '已保存' : '考试已创建', 'ok');
            closeModal();
            if(!e && j && j.exam){
              /* 新建后直接问要不要导入 */
              SC_STATE.meta = null;
              scLoad();
              setTimeout(function(){
                if(confirm('考试已创建。现在导入这次考试的成绩表吗？')) scImport(j.exam.id);
              }, 260);
            } else {
              scLoad();
            }
          })
          .catch(function(err){ btn.disabled = false; toast('保存失败：' + err.message, 'err', 4200); });
      };
      /* 分数线删除用事件委托（行是动态生成的） */
      box.querySelector('#scCutBox').onclick = function(ev){
        var b = ev.target.closest ? ev.target.closest('[data-cut-del]') : null;
        if(!b) return;
        var i = Number(b.getAttribute('data-cut-del'));
        cuts.splice(i, 1);
        box.querySelector('#scCutBox').innerHTML = cuts.map(scCutRow).join('');
      };
    },
  });
}

function scSubjRow(s){
  return '<div class="sc-subj" data-key="' + esc(s.key) + '" data-name="' + esc(s.name) + '" '
    + 'style="display:flex;gap:10px;align-items:center;margin-bottom:8px">'
    + '<label style="display:flex;align-items:center;gap:6px;min-width:86px;font-weight:700">'
    +   '<input type="checkbox" data-f="on"' + (s.on !== false ? ' checked' : '') + '>' + esc(s.name) + '</label>'
    + '<input class="inp" style="width:90px" type="number" min="1" max="1000" data-f="full" value="' + (s.full || 100) + '">'
    + '<span class="muted" style="font-size:.78rem">满分</span>'
    + '<label style="display:flex;align-items:center;gap:6px;font-size:.82rem">'
    +   '<input type="checkbox" data-f="graded"' + (s.graded ? ' checked' : '') + '>赋分</label>'
    + '</div>';
}

function scCutRow(c, i){
  return '<div class="sc-cut" data-i="' + i + '" style="display:flex;gap:8px;align-items:center;margin-bottom:8px">'
    + '<input class="inp" style="width:120px" data-f="label" maxlength="20" placeholder="线名（如 特控线）" value="' + esc(c.label || '') + '">'
    + '<input class="inp" style="width:100px" type="number" data-f="score" placeholder="分数（可空）" value="' + (c.score == null ? '' : c.score) + '">'
    + '<input class="inp" style="width:52px;padding:6px" type="color" data-f="color" value="' + esc(c.color || '#b45309') + '">'
    + '<button type="button" class="btn btn-sm btn-secondary" data-cut-del="' + i + '">删</button>'
    + '</div>';
}

/* 收集表单 → 提交体；校验不过返回 null 并提示 */
function scCollectExam(box){
  var name = (box.querySelector('#scName').value || '').trim();
  if(!name){ toast('请填考试名称', 'err'); return null; }
  var date = (box.querySelector('#scDate').value || '').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){ toast('请选考试开始日期', 'err'); return null; }
  /* 跨天考试：结束日期可空；填了就不能早于开始日 */
  var endDate = (box.querySelector('#scEndDate').value || '').trim();
  if(endDate){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(endDate)){ toast('结束日期格式不对', 'err'); return null; }
    if(endDate < date){ toast('结束日期不能早于开始日期', 'err'); return null; }
    if(endDate === date) endDate = '';
  }

  var subjects = [];
  Array.prototype.forEach.call(box.querySelectorAll('.sc-subj'), function(el){
    if(!el.querySelector('[data-f="on"]').checked) return;
    var full = Number(el.querySelector('[data-f="full"]').value);
    subjects.push({
      key: el.getAttribute('data-key'),
      name: el.getAttribute('data-name'),
      full: Number.isFinite(full) && full > 0 ? full : 100,
      graded: el.querySelector('[data-f="graded"]').checked,
    });
  });
  if(!subjects.length){ toast('至少要保留一科', 'err'); return null; }

  var cutlines = [];
  Array.prototype.forEach.call(box.querySelectorAll('.sc-cut'), function(el){
    var label = (el.querySelector('[data-f="label"]').value || '').trim();
    if(!label) return;
    var sv = el.querySelector('[data-f="score"]').value;
    cutlines.push({
      key: 'c' + cutlines.length,
      label: label,
      score: sv === '' ? null : Number(sv),
      color: el.querySelector('[data-f="color"]').value || '#b45309',
    });
  });

  var gn = box.querySelector('#scGradeN').value;
  var ga = box.querySelector('#scGradeAvg').value;
  var gradeRef = null;
  if(gn !== '' || ga !== ''){
    gradeRef = {
      students: gn === '' ? null : Number(gn),
      avgTotal: ga === '' ? null : Number(ga),
      avgSubject: {},
    };
  }

  return {
    name: name,
    exam_date: date,
    exam_end_date: endDate || '',
    exam_type: box.querySelector('#scType').value || '',
    subjects: subjects,
    cutlines: cutlines,
    grade_ref: gradeRef,
    note: (box.querySelector('#scNote').value || '').trim(),
  };
}

/* ============================================================================
 * 导入成绩（浏览器解析 Excel → 预览校验 → 提交 JSON）
 * ----------------------------------------------------------------------------
 * 为什么不直接上传文件：后端 Worker 的入口为了让 body 可重复读，
 * 用的是 text() 预读，**收不了 multipart**。所以文件在前端解析成 JSON 再发，
 * 后端只认 JSON —— 这条路同时也让"预览校验"成为可能。
 * ========================================================================= */
/**
 * 生成这次考试的导入模版（.xlsx）。
 * ----------------------------------------------------------------------------
 * 列结构 = 站主手头那张模版的形状：第 1 行大类（合并单元格）、第 2 行子字段、
 * 第 3 行起填数据。科目由**本次考试的配置**生成 —— 选了赋分科目的自动多两列
 * （赋分 + 该科排名），所以「对应的模版」永远和考试设置对得上。
 * 生成后解析器认的就是它（见 scParseTwoRow），不用来回试格式。
 */
function scTemplateXlsx(e){
  loadXLSX().then(function(XLSX){
    if(!XLSX){ toast('表格组件加载失败（三个 CDN 都不可达），请检查网络后重试', 'err', 4200); return; }
    var subs = e.subjects || [];
    var r0 = ['基本信息', ''];
    var r1 = ['考号/学号', '姓名'];
    var merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
    var c = 2;

    /* 总分组：赋分前 / 赋分后两组，每组各带年级排名 + 联考排名。
       （2026-10-17 站主要求：总分分赋分前与赋分后，两种都要有年级/联考排名；
         班级排名由系统按分数当场算，模版里不填。）
       总分本身也不用填 —— 系统按各科分数算得出来。 */
    var group = function(name, cols){
      r0.push(name);
      for(var gi = 1; gi < cols.length; gi++) r0.push('');
      cols.forEach(function(x){ r1.push(x); });
      merges.push({ s: { r: 0, c: c }, e: { r: 0, c: c + cols.length - 1 } });
      c += cols.length;
    };
    group('总分（赋分前）', ['年级排名', '联考排名']);
    group('总分（赋分后）', ['年级排名', '联考排名']);

    /* 各科：每个分数都要对应一个年级排名。
       赋分科目（化学 / 生物）四列：原始分 + 原始分年级排名 + 赋分 + 赋分年级排名；
       其余两列：分数 + 年级排名。 */
    subs.forEach(function(s){
      group(s.name, s.graded
        ? ['原始分', '年级排名', '赋分', '年级排名']
        : ['分数', '年级排名']);
    });

    /* 分数线参考列：只作填写时的参照，系统不读（要设分数线请到考试设置里填） */
    ['600线', '特控线', '本科线'].forEach(function(nm){ r0.push(nm); r1.push(''); });

    var ws = XLSX.utils.aoa_to_sheet([r0, r1]);
    ws['!merges'] = merges;
    ws['!cols'] = r0.map(function(_, i){ return { wch: i < 2 ? 12 : 10 }; });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, String(e.name || '成绩表').slice(0, 25) || '成绩表');
    XLSX.writeFile(wb, String(e.name || '成绩导入模版') + '_模版.xlsx');
    toast('模版已下载，填好后用「选择文件」导回来即可', 'ok', 4200);
  });
}

function scImport(examId){
  var e = scFindExam(examId);
  if(!e) return;
  var subs = e.subjects || [];

  openModal({
    title: '导入成绩 —— ' + e.name,
    sub: '按模版填：考号·学号 / 姓名 / 各科分数（化学·生物带赋分）/ 总分的年级排名与联考排名。班排不用填，系统当场算。',
    wide: true,
    body:
        '<div class="alert info" style="display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap">'
      +   '<span><b>建议用模版填。</b>模版的列头会按本次考试的科目自动对齐，'
      +     '没填的格留空即可（系统记成「不知」，不计入统计）。</span>'
      +   '<button type="button" class="btn btn-sm btn-secondary" id="scTpl" style="white-space:nowrap">'
      +     svg('download', 13) + ' 下载模版</button>'
      + '</div>'
      + '<div class="alert warn">导入是<b>整体替换本次</b>：导入后这次考试的成绩就等于表里这些行。'
      +   '同名同学会各占一行并提示你；导入后每格都还能手改。</div>'
      + '<div class="field"><label>① 选择文件（.xlsx / .xls / .csv）</label>'
      +   '<input type="file" id="scFile" accept=".xlsx,.xls,.csv"></div>'
      + '<div class="field"><label>或者：② 从 Excel 直接复制，粘到这里（制表符分隔）</label>'
      +   '<textarea id="scPaste" rows="4" placeholder="从 Excel 选中区域复制，Ctrl+V 粘进这里（含模版的两行表头也行）"></textarea></div>'
      + '<div id="scPrev"></div>',
    foot: '<button class="btn btn-secondary" id="scImpCancel">取消</button>'
        + '<button class="btn" id="scImpGo" disabled>导入</button>',
    onMount: function(box){
      var parsed = null;   /* { header:[], rows:[], map:{} } */
      var btn = box.querySelector('#scImpGo');

      box.querySelector('#scImpCancel').onclick = closeModal;
      box.querySelector('#scTpl').onclick = function(){ scTemplateXlsx(e); };
      box.querySelector('#scFile').onchange = function(ev){
        var f = ev.target.files && ev.target.files[0];
        if(!f) return;
        box.querySelector('#scPrev').innerHTML = '<div class="loading"><div class="spinner"></div>解析中…</div>';
        loadXLSX().then(function(XLSX){
          if(!XLSX){ box.querySelector('#scPrev').innerHTML = '<div class="empty">表格解析库加载失败，请检查网络</div>'; return; }
          var rd = new FileReader();
          rd.onload = function(){
            try{
              var wb = XLSX.read(new Uint8Array(rd.result), { type:'array' });
              var ws = wb.Sheets[wb.SheetNames[0]];
              var aoa = XLSX.utils.sheet_to_json(ws, { header:1, blankrows:false, defval:'' });
              parsed = scParseAOA(aoa, subs);
              scPaintPreview(box, parsed, subs, btn);
            }catch(err){
              box.querySelector('#scPrev').innerHTML = '<div class="empty">解析失败：' + esc(err.message) + '</div>';
            }
          };
          rd.readAsArrayBuffer(f);
        });
      };

      box.querySelector('#scPaste').oninput = function(ev){
        var txt = ev.target.value || '';
        if(!txt.trim()){ parsed = null; btn.disabled = true; box.querySelector('#scPrev').innerHTML = ''; return; }
        var aoa = txt.replace(/\r/g,'').split('\n').filter(function(l){ return l.trim(); })
                     .map(function(l){ return l.split('\t'); });
        parsed = scParseAOA(aoa, subs);
        scPaintPreview(box, parsed, subs, btn);
      };

      btn.onclick = function(){
        if(!parsed) return;
        btn.disabled = true;
        api('/scores?action=scores-import', { method:'POST', body: { exam: examId, rows: parsed.rows } })
          .then(function(j){
            var msg = '导入成功：' + j.imported + ' 行';
            if(j.skippedCount) msg += '，跳过 ' + j.skippedCount + ' 行';
            toast(msg, 'ok', 4200);
            closeModal();
            scLoad();
            /* 未识别姓名 = 多半打错了（站主 2026-10-17：名单里的人都在用户里）：
               直接弹窗让站主改，不用一个个去找。跳过的行（空姓名/同名重复）单独提示一下。 */
            if(j.skippedCount){
              setTimeout(function(){
                alert('有 ' + j.skippedCount + ' 行被跳过：\n  ' + (j.skipped || []).join('\n  '));
              }, 1200);
            }
            if(j.unmatchedCount){
              setTimeout(function(){ scFixNamesDialog(examId, j.unmatched || []); }, 700);
            }
          })
          .catch(function(err){ btn.disabled = false; toast('导入失败：' + err.message, 'err', 4600); });
      };
    },
  });
}

/**
 * 导入后「未识别姓名」修正弹窗（2026-10-17 站主要求）。
 * 前提：考试名单里的人都在站点用户里，所以导入后对不上账号，一定是名字打错了。
 * 这里把每个对不上的姓名列出来，右边填/选正确姓名，确认后一次性改名并自动绑定，
 * 不用站主自己一个个去翻。候选姓名来自后台用户（/scores?action=unbound 的 users）。
 */
function scFixNamesDialog(examId, names){
  names = (names || []).filter(Boolean);
  if(!names.length){ toast('导入完成，全部姓名都已对上账号', 'ok', 3500); return; }
  api('/scores?action=unbound').then(function(j){
    var users = (j && j.users) || [];
    var opts = users.map(function(x){ return String(x.name || '').trim(); }).filter(Boolean);
    var dl = '<datalist id="scFixDl">' + opts.map(function(n){ return '<option value="' + attr(n) + '">'; }).join('') + '</datalist>';
    var rows = names.map(function(nm){
      return '<div style="display:flex;gap:8px;align-items:center;margin:7px 0">'
        + '<span style="min-width:120px;font-size:.85rem;font-weight:700;color:#c0392b">' + esc(nm) + '</span>'
        + '<span style="color:#8a7968">→</span>'
        + '<input class="sc-fix-to" data-from="' + attr(nm) + '" list="scFixDl" autocomplete="off" '
        + 'placeholder="输入或下拉选择正确姓名" '
        + 'style="flex:1;min-width:140px;padding:7px 9px;border:1px solid #e2d5c8;border-radius:7px;font-family:inherit;font-size:.85rem">'
        + '</div>';
    }).join('');
    openModal({
      title: '导入完成 · 有 ' + names.length + ' 个姓名没对上账号',
      sub: '这些姓名在用户里找不到。按站规名单都在用户里，多半是打错字 —— 右边填上正确姓名，确认后一次性改名并自动绑好账号。',
      wide: true,
      body: '<div class="alert warn" style="margin-bottom:10px">只填要改的那几个即可，留空的保持原样。</div>'
        + dl + rows,
      foot: '<button class="btn btn-secondary" id="scFixSkip">以后再说</button>'
          + '<button class="btn" id="scFixGo">确认修正</button>',
      onMount: function(box){
        box.querySelector('#scFixSkip').onclick = closeModal;
        box.querySelector('#scFixGo').onclick = function(){
          var inputs = box.querySelectorAll('.sc-fix-to');
          var fixes = [];
          Array.prototype.forEach.call(inputs, function(inp){
            var from = inp.getAttribute('data-from');
            var to = (inp.value || '').trim();
            if(to && to !== from) fixes.push({ from: from, to: to });
          });
          if(!fixes.length){ toast('还没有填要改成的姓名', 'err'); return; }
          var go = box.querySelector('#scFixGo'); go.disabled = true;
          api('/scores?action=fix-names', { method:'POST', body: { exam: examId, fixes: fixes } })
            .then(function(r){
              closeModal();
              scLoad();
              var rest = (r && r.stillUnmatched) || [];
              if(rest.length){
                toast('已修正 ' + (r.renamed || 0) + ' 行，还有 ' + rest.length + ' 个没对上', 'ok', 4200);
                setTimeout(function(){ scFixNamesDialog(examId, rest); }, 250);
              }else{
                toast('已修正 ' + (r.renamed || 0) + ' 行，全部对上账号了', 'ok', 4200);
              }
            })
            .catch(function(e){ go.disabled = false; toast('修正失败：' + e.message, 'err', 4600); });
        };
      },
    });
  }).catch(function(e){ toast('读取用户名单失败：' + e.message, 'err', 4500); });
}

/* AOA（二维数组）→ { header, rows, map }；第一行当表头 */
function scParseAOA(aoa, subs){
  if(!aoa || !aoa.length) return { header: [], rows: [], map: null };
  /* ① 两行表头（站主的模版）→ 走按列解析 */
  if(scIsTwoRowHeader(aoa[0] || [], aoa[1] || [])) return scParseTwoRow(aoa, subs);
  /* ② 单行表头（直接粘贴 / 自制的简单表）→ 老路径，表头自动识别 */
  var header = (aoa[0] || []).map(function(x){ return String(x == null ? '' : x).trim(); });
  var body = aoa.slice(1).filter(function(r){
    return r && r.some(function(c){ return String(c == null ? '' : c).trim() !== ''; });
  });
  return { header: header, rows: scMapRows(header, body, subs, null), map: scGuessMap(header, subs), body: body };
}

/* ============================================================================
 * 模版导入（2026-10-16 第六十二轮）
 * ----------------------------------------------------------------------------
 * 站主的成绩模版是**两行表头**：
 *   第 1 行 = 大类（基本信息 / 总分 / 语文 / 数学 / 英语 / 物理 / 化学 / 生物 / 600线 / 特控线 / 本科线）
 *   第 2 行 = 子字段（考号·学号 / 姓名 / 总分 / 年级排名 / 联考排名 / 分数 / 原始分 / 赋分 …），
 *   第 3 行起才是学生数据。
 *
 * ⚠️ 为什么老解析认不出这张表：它把第 1 行当表头，而第 1 行的「基本信息」「总分」
 *   「语文」是**合并单元格** —— 合并区只有左上角有值，其余格读出来是**空**，
 *   于是姓名列和各科列全成了空表头，自动识别全线失败。
 *
 * 所以这条路**按列位置解析**（模版是固定的，不猜）：
 *   · 大类行先做「合并填充」（空 = 沿用左边最近的非空标签）
 *   · 科目列靠大类名与考试配置里的科目名对上，子字段决定它是分数 / 赋分 / 排名
 *   · 空单元格、-、—、/、缺考、免考 一律当「不知」（后端存 null，不参与统计）
 *   · 各科的「年级排名」列系统不存（库里只有各科分数 + 总分的年级/联考排名），
 *     解析时识别出来并在预览里如实告诉你，不悄悄丢
 * ========================================================================= */

/** 合并单元格的大类行向右填充：合并区只有左上角有值，其余读出来是空。 */
function scFillMerged(row){
  var out = [], last = '';
  for(var i = 0; i < (row || []).length; i++){
    var v = String(row[i] == null ? '' : row[i]).trim();
    if(v) last = v;
    out.push(v || last);
  }
  return out;
}

/** 两行表头判定：第 2 行有「姓名」而第 1 行没有 —— 站主模版就是这个形状。 */
function scIsTwoRowHeader(r0, r1){
  var has = function(row, re){
    return (row || []).some(function(c){ return re.test(String(c == null ? '' : c).trim()); });
  };
  return has(r1, /^(姓名|名字|学生姓名|学生)$/) && !has(r0, /姓名|名字/);
}

/** 科目组里某个子字段属于哪一类。 */
function scSubKind(label, subjName){
  var s = String(label || '').replace(/[\s()（）\[\]【】]/g, '');
  if(!s) return 'score';
  if(/赋分|等级分|分级/.test(s)) return 'assigned';
  if(/联考排名|联考名次|市排名/.test(s)) return 'subLeague';
  if(/年级排名|年级名次|校排名|校名次|排名|名次/.test(s)) return 'subRank';
  if(/分数|成绩|原始分/.test(s) || s === subjName) return 'score';
  return 'other';
}

function scParseTwoRow(aoa, subs){
  var catRow = scFillMerged(aoa[0] || []);
  var subRow = (aoa[1] || []).map(function(x){ return String(x == null ? '' : x).trim(); });
  var body = aoa.slice(2).filter(function(r){
    return r && r.some(function(c){ return String(c == null ? '' : c).trim() !== ''; });
  });

  var nameCol = -1, noCol = -1, srCol = -1, lrCol = -1;
  /* 总分两种口径（2026-10-17 站主要求）：赋分后 = school_rank / league_rank 两列（老口径，保持兼容）；
     赋分前 = 存进 scores 的 _t（跟着行数据走）。 */
  var totalRaw = { rank: -1, league: -1 };
  var subjCols = {};
  var cutlines = [];   /* 分数线参考列：只识别回报，不写库 */
  var ignored  = [];   /* 识别到但不导入的列：预览里如实说明 */

  var maxLen = Math.max(catRow.length, subRow.length);
  for(var i = 0; i < maxLen; i++){
    var cat = String(catRow[i] || '').trim();
    var sub = String(subRow[i] || '').trim();
    var label = (cat && cat !== sub ? cat + '·' : '') + (sub || '（空）');

    /* ① 姓名 / 学号 */
    if(/^(姓名|名字|学生姓名|学生)$/.test(sub)){ if(nameCol < 0) nameCol = i; continue; }
    if(/学号|考号|准考证/.test(sub) || /学号|考号/.test(cat)){ if(noCol < 0) noCol = i; continue; }

    /* ② 分数线（600线 / 特控线 / 本科线）—— 表头参考信息，不属于学生数据 */
    if(/线$|分数线/.test(cat) && !/排名/.test(sub)){ cutlines.push({ i: i, label: cat }); continue; }

    /* ③ 科目列：大类名与考试配置里的科目名对得上 */
    var su = null;
    (subs || []).forEach(function(s){
      if(su) return;
      var n = String(s.name || '').trim();
      if(!n) return;
      if(cat === n || (cat && (cat.indexOf(n) >= 0 || n.indexOf(cat) >= 0))) su = s;
    });
    if(su){
      var g = subjCols[su.key] || (subjCols[su.key] = { raw: -1, assigned: -1, rank: -1, asgRank: -1 });
      var k = scSubKind(sub, su.name);
      /* 排名列归属靠**子字段顺序**判定：紧跟在「原始分/分数」后面的那个年级排名 = 该分数的排名；
         紧跟在「赋分」后面的 = 赋分的排名。所以每组里两个「年级排名」不会串。 */
      if(k === 'assigned'){ if(g.assigned < 0){ g.assigned = i; g.__last = 'assigned'; } else ignored.push({ label: label, why: '赋分列重复，只取第一列' }); }
      else if(k === 'score'){ if(g.raw < 0){ g.raw = i; g.__last = 'raw'; } else ignored.push({ label: label, why: '分数列重复，只取第一列' }); }
      else if(k === 'subRank' || k === 'subLeague'){
        var slot = (g.__last === 'assigned') ? 'asgRank' : 'rank';
        if(k === 'subLeague') slot = slot + 'League';   /* 各科联考排名（暂不存，如实登记） */
        if(slot === 'rank' || slot === 'asgRank'){
          if(g[slot] < 0) g[slot] = i;
          else ignored.push({ label: label, why: '该科排名重复，只取第一列' });
        }else{
          ignored.push({ label: label, why: '各科联考排名暂不存储（只存总分的联考排名）' });
        }
      }
      else ignored.push({ label: label, why: '未识别，已跳过' });
      continue;
    }

    /* ④ 总分组：总分本身不存（系统按各科实时算），只取总分的年级 / 联考排名。
       看不出赋分前/后时，按「赋分后」处理 —— 与老模版（只有一组总分排名）保持一致。 */
    if(/总分|总成绩/.test(cat) && /排名|名次/.test(sub)){
      var isRaw = /赋分前|原始|不加赋分|裸分/.test(cat);
      var slot2 = isRaw ? totalRaw : null;
      var isLeague = /联考排名|联考名次|市排名/.test(sub);
      if(isLeague){
        if(isRaw){ if(totalRaw.league < 0) totalRaw.league = i; else ignored.push({ label: label, why: '赋分前联考排名重复，只取第一列' }); }
        else { if(lrCol < 0) lrCol = i; else ignored.push({ label: label, why: '联考排名重复，只取第一列' }); }
      }else{
        if(isRaw){ if(totalRaw.rank < 0) totalRaw.rank = i; else ignored.push({ label: label, why: '赋分前年级排名重复，只取第一列' }); }
        else { if(srCol < 0) srCol = i; else ignored.push({ label: label, why: '年级排名重复，只取第一列' }); }
      }
      continue;
    }
    if(/总分|总成绩/.test(sub)) continue;

    ignored.push({ label: label, why: '未识别，已跳过' });
  }

  var map = { name: nameCol, no: noCol, schoolRank: srCol, leagueRank: lrCol, subj: subjCols, totalRaw: totalRaw };
  var header = subRow.map(function(x, i){ return x ? x : (catRow[i] || ''); });
  return {
    header: header,
    rows: scMapRows(header, body, subs, map),
    map: map,
    body: body,
    twoRow: true,
    cutlines: cutlines,
    ignored: ignored
  };
}

/** 单行的总分（各科累加：赋分科目取赋分，其余取原始分）。预览里算班排用。 */
function scRowTotal(r, subs){
  var t = 0, any = false;
  (subs || []).forEach(function(s){
    var v = r.s ? r.s[s.key] : null;
    if(!v) return;
    var n = (v.assigned != null) ? v.assigned : v.raw;
    if(n == null) return;
    t += n; any = true;
  });
  return any ? t : null;
}

/** 单行的「赋分前总分」：各科一律取原始分（估分/裸分口径）。 */
function scRowTotalRaw(r, subs){
  var t = 0, any = false;
  (subs || []).forEach(function(s){
    var v = r.s ? r.s[s.key] : null;
    if(!v || v.raw == null) return;
    t += v.raw; any = true;
  });
  return any ? t : null;
}

/** 按总分当场算班排（1 = 最高）。模版里没有班排列，就是这么来的。 */
function scClassRanks(rows, subs){
  var scored = rows.map(function(r, i){ return { i: i, t: scRowTotal(r, subs) }; })
                   .filter(function(x){ return x.t != null; });
  scored.sort(function(a, b){ return b.t - a.t; });
  var out = {};
  scored.forEach(function(x, idx){ out[x.i] = idx + 1; });
  return out;
}

/* 表头自动识别 */
function scGuessMap(header, subs){
  var H = header.map(function(s){ return String(s || '').replace(/[\s()（）\[\]【】]/g, ''); });
  var pick = function(list){
    for(var i = 0; i < H.length; i++) for(var j = 0; j < list.length; j++) if(H[i] === list[j]) return i;
    for(var i2 = 0; i2 < H.length; i2++) for(var j2 = 0; j2 < list.length; j2++) if(H[i2].indexOf(list[j2]) >= 0) return i2;
    return -1;
  };
  var map = {
    name: pick(['姓名','名字','学生姓名','学生']),
    no: pick(['学号','考号','准考证']),   /* 用「准考证」前缀匹配，能命中各种带「考号」的写法 */
    schoolRank: pick(['校排名','校名次','学校排名','年级排名','年级名次']),
    leagueRank: pick(['联考排名','联考名次','市排名']),
    subj: {},
  };
  (subs || []).forEach(function(s){
    var raw = -1, asg = -1;
    for(var i = 0; i < H.length; i++){
      if(H[i].indexOf(s.name) < 0) continue;
      if(/赋分|分级|等级/.test(H[i])){ if(asg < 0) asg = i; }
      else if(raw < 0) raw = i;
    }
    map.subj[s.key] = { raw: raw, assigned: asg };
  });
  return map;
}

/* 按映射把 AOA 转成后端要的行 */
function scMapRows(header, body, subs, map){
  if(!map) map = scGuessMap(header, subs);
  var num = function(v){
    var s = String(v == null ? '' : v).trim();
    if(s === '' || s === '-' || s === '—' || s === '/' || /缺考|免考/.test(s)) return null;
    var n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  var out = [];
  body.forEach(function(r){
    var name = map.name >= 0 ? String(r[map.name] == null ? '' : r[map.name]).trim() : '';
    if(!name) return;
    var s = {};
    (subs || []).forEach(function(su){
      var m = map.subj[su.key] || { raw:-1, assigned:-1, rank:-1, asgRank:-1 };
      var raw = m.raw >= 0 ? num(r[m.raw]) : null;
      var asg = m.assigned >= 0 ? num(r[m.assigned]) : null;
      if(raw == null && asg == null) return;
      var o = (su.graded && asg != null) ? { raw: raw, assigned: asg } : { raw: raw == null ? asg : raw };
      /* 每个分数配一个年级排名（站主要求）。空 = 不知，不写。 */
      var rk = (m.rank != null && m.rank >= 0) ? num(r[m.rank]) : null;
      var ak = (m.asgRank != null && m.asgRank >= 0) ? num(r[m.asgRank]) : null;
      if(rk != null) o.rank = rk;
      if(ak != null && o.assigned != null) o.asgRank = ak;
      s[su.key] = o;
    });
    /* 总分（赋分前）的两个排名：存进 _t，跟着这行数据走 */
    var tr = map.totalRaw || {};
    var tRank = (tr.rank >= 0) ? num(r[tr.rank]) : null;
    var tLeague = (tr.league >= 0) ? num(r[tr.league]) : null;
    if(tRank != null || tLeague != null) s._t = { rank: tRank, league: tLeague };
    out.push({
      name: name,
      no: map.no >= 0 ? String(r[map.no] == null ? '' : r[map.no]).trim() : '',
      s: s,
      schoolRank: map.schoolRank >= 0 ? num(r[map.schoolRank]) : null,
      leagueRank: map.leagueRank >= 0 ? num(r[map.leagueRank]) : null,
    });
  });
  return out;
}

function scPaintPreview(box, parsed, subs, btn){
  var host = box.querySelector('#scPrev');
  if(!parsed || !parsed.rows.length){
    host.innerHTML = '<div class="empty">没解析出有效数据 —— 检查一下第一行是不是表头、有没有「姓名」列</div>';
    if(btn) btn.disabled = true;
    return;
  }
  var m = parsed.map || {};
  var hit = function(i){ return i >= 0 ? esc(parsed.header[i] || ('第' + (i+1) + '列')) : '<span style="color:var(--danger)">未找到</span>'; };

  /* 班排当场算：模版里没有班排列，名次由各科分数累加后现排 */
  var ranks = scClassRanks(parsed.rows, subs);
  var totalOf = function(r){ return scRowTotal(r, subs); };

  /* 识别到但不导入的列 / 分数线列：如实列出来，别让人以为导进去了。
     按原因归组——同一原因（如「各科年级排名」）只写一遍，否则 8 列刷 8 行。 */
  var notes = '';
  if((parsed.ignored && parsed.ignored.length) || (parsed.cutlines && parsed.cutlines.length)){
    var li = [];
    if(parsed.cutlines && parsed.cutlines.length){
      li.push('分数线列（' + parsed.cutlines.map(function(c){ return esc(c.label); }).join('、')
        + '）只是表头参考信息，不会写进系统 —— 要设分数线请在考试设置里填');
    }
    if(parsed.ignored && parsed.ignored.length){
      var byWhy = {};
      parsed.ignored.forEach(function(g){ (byWhy[g.why] = byWhy[g.why] || []).push(g.label); });
      li.push('这些列不导入：' + Object.keys(byWhy).map(function(w){
        var names = byWhy[w];
        return names.slice(0, 5).map(esc).join('、')
          + (names.length > 5 ? ' 等 ' + names.length + ' 列' : '')
          + '<span class="muted">（' + esc(w) + '）</span>';
      }).join('；'));
    }
    notes = '<div class="alert warn" style="margin-top:8px">' + li.join('<br>') + '</div>';
  }

  host.innerHTML =
      '<div class="alert ok" style="margin-top:8px"><b>解析到 ' + parsed.rows.length + ' 行。</b>'
    +   (parsed.twoRow ? '（<b>两行表头模版</b>，按列位置解析）' : '')
    +   '列对应关系：姓名→' + hit(m.name) + '　学号→' + hit(m.no) + '<br>'
    +   '总分（赋分后）年级排名→' + hit(m.schoolRank) + '　联考→' + hit(m.leagueRank)
    +   '　总分（赋分前）年级排名→' + hit((m.totalRaw || {}).rank) + '　联考→' + hit((m.totalRaw || {}).league) + '<br>'
    +   (subs || []).map(function(s){
          var mm = (m.subj || {})[s.key] || {};
          return esc(s.name) + '→' + hit(mm.raw) + '（排名 ' + hit(mm.rank) + '）'
            + (mm.assigned >= 0 ? '（赋分 ' + hit(mm.assigned) + '，排名 ' + hit(mm.asgRank) + '）' : '');
        }).join('　')
    +   '<br><span class="muted" style="font-size:.78rem">空单元格 / - / / / 缺考 都会记成「不知」，不计入统计；排名列空着就是「不知」，不会补 0。</span>'
    + '</div>'
    + '<div class="table-wrap" style="max-height:300px;overflow:auto"><table style="font-size:.8rem">'
    +   '<thead><tr><th>班排</th><th>姓名</th>'
    +   (subs || []).map(function(s){ return '<th>' + esc(s.name) + '</th>'; }).join('')
    +   '<th>总分</th><th>年级排名</th><th>联考</th><th>赋分前总分</th><th>其年级</th><th>其联考</th></tr></thead><tbody>'
    +   parsed.rows.slice(0, 30).map(function(r, i){
          var tt = totalOf(r);
          var tRaw = scRowTotalRaw(r, subs);
          var t = r.s._t || {};
          var cell = function(v){
            if(!v) return '<td class="muted">—</td>';
            var line1 = (v.raw == null ? '—' : v.raw)
              + (v.assigned != null ? ' <span class="muted">/' + v.assigned + '</span>' : '');
            var rk = [];
            if(v.rank != null) rk.push('排名 ' + v.rank);
            if(v.asgRank != null) rk.push('赋分排名 ' + v.asgRank);
            return '<td>' + line1
              + (rk.length ? '<div class="muted" style="font-size:.7rem;white-space:nowrap">' + rk.join(' · ') + '</div>' : '')
              + '</td>';
          };
          return '<tr><td class="muted">' + (ranks[i] || '—') + '</td>'
            + '<td style="font-weight:700">' + esc(r.name) + '</td>'
            + (subs || []).map(function(s){ return cell(r.s[s.key]); }).join('')
            + '<td>' + (tt == null ? '—' : tt) + '</td>'
            + '<td>' + (r.schoolRank == null ? '—' : r.schoolRank) + '</td>'
            + '<td>' + (r.leagueRank == null ? '—' : r.leagueRank) + '</td>'
            + '<td>' + (tRaw == null ? '—' : tRaw) + '</td>'
            + '<td>' + (t.rank == null ? '—' : t.rank) + '</td>'
            + '<td>' + (t.league == null ? '—' : t.league) + '</td></tr>';
        }).join('')
    + '</tbody></table></div>'
    + '<p class="muted" style="font-size:.78rem;margin-top:6px">'
    +   '班排与总分是<b>当场按各科分数算的</b>（模版里没有这几列，也不需要填）：'
    +   '总分 = 各科按赋分口径累加；赋分前总分 = 各科一律取原始分。'
    +   (parsed.rows.length > 30 ? '只预览前 30 行，导入时会处理全部。' : '')
    + '</p>'
    + notes;

  if(btn) btn.disabled = false;
}

/* ============================================================================
 * 成绩编辑表（像 Excel 一样改分）
 * ----------------------------------------------------------------------------
 * 站主要求「导入之后我也可以改」「失焦自动保存」。
 * 做法：每个可编辑格是 <input>，改动后标脏 + 防抖 1.5 秒自动提交；
 *      只提交脏行（带行 id），新增行没有 id 也能提交（后端会插入）。
 * ========================================================================= */
function scEditRows(examId){
  SC_STATE.cur = examId;
  SC_STATE.dirty = {};
  renderScoreRows(examId);
}

function renderScoreRows(examId){
  var e = scFindExam(examId);
  if(!e) return;
  $('view').innerHTML =
    '<div class="toolbar" style="background:var(--panel)">'
    +  '<button class="btn btn-sm btn-secondary" id="scBack">' + svg('arrow-left',14) + ' 返回列表</button>'
    +  '<div style="flex:1;min-width:0;margin-left:8px"><b style="font-size:.92rem">' + esc(e.name) + '</b>'
    +    '<p class="muted" style="margin:4px 0 0;font-size:.8rem">'
    +      '点格子直接改，离开格子会自动保存。加分/减分都可以，改完不用再点别的。'
    +    '</p></div>'
    +  '<span id="scSaveState" class="badge badge-gray">未改动</span>'
    +  '<button class="btn btn-sm btn-secondary" id="scAddRow">' + svg('plus',14) + ' 加一行</button>'
    +  '<button class="btn btn-sm btn-secondary" id="scReload">刷新</button>'
    + '</div>'
    + '<section class="panel"><div id="scRows"><div class="loading"><div class="spinner"></div>加载中…</div></div></section>';

  $('scBack').onclick = function(){ renderScores(); };
  $('scReload').onclick = function(){ loadScoreRows(examId); };
  $('scAddRow').onclick = function(){ scAddRow(examId); };
  loadScoreRows(examId);
}

function loadScoreRows(examId){
  SC_STATE.dirty = {};
  $('scRows').innerHTML = '<div class="loading"><div class="spinner"></div>加载中…</div>';
  api('/scores?action=board&exam=' + examId).then(function(j){
    SC_STATE.curExam = j.exam;
    SC_STATE.rows = j.rows || [];
    scPaintRows();
  }).catch(function(err){
    $('scRows').innerHTML = '<div class="empty">加载失败：' + esc(err.message) + '</div>';
  });
}

/* ---------------- 改分表的表格标记（表头 / 各科格 / 总分格） ----------------
   抽出来的原因：表头与单元格原来在「渲染」「加一行」「空表骨架」三处各写一遍，
   2026-10-17 加各科排名与总分赋分前/后两组排名时，三处必须同步改，否则
   加出来的行会缺列、一改分就把新字段冲掉。现在只有这一份。 */
function scInpTd(rid, sub, f, val, w, small){
  return '<input class="inp" style="width:' + w + 'px;padding:' + (small ? '3px 5px;font-size:.74rem' : '5px 6px') + '" type="number"'
    + ' data-row="' + rid + '"' + (sub ? ' data-sub="' + sub + '"' : '') + ' data-f="' + f + '"'
    + ' value="' + (val == null ? '' : val) + '">';
}
function scGridHeadHtml(subs){
  return '<tr><th style="min-width:88px">姓名</th><th style="min-width:76px">学号</th>'
    + subs.map(function(s){
        return '<th style="min-width:104px">' + esc(s.name)
          + '<br><span class="muted" style="font-weight:400;font-size:.7rem">'
          + (s.graded ? '原始·排名 / 赋分·排名' : '分数 · 年级排名') + '</span></th>';
      }).join('')
    + '<th style="min-width:112px">总分（赋分前）<br><span class="muted" style="font-weight:400;font-size:.7rem">年级 · 联考</span></th>'
    + '<th style="min-width:112px">总分（赋分后）<br><span class="muted" style="font-weight:400;font-size:.7rem">年级 · 联考</span></th>'
    + '<th style="min-width:52px">操作</th></tr>';
}
/** 一个科目格：分数（赋分科目再加赋分）+ 各自对应的年级排名。空 = 不知。 */
function scSubCellHtml(rid, su, v){
  v = v || {};
  if(su.graded){
    return '<td style="white-space:nowrap">'
      + scInpTd(rid, su.key, 'raw', v.raw, 52) + '<span class="muted" style="margin:0 2px">/</span>' + scInpTd(rid, su.key, 'assigned', v.assigned, 52)
      + '<div style="margin-top:3px">' + scInpTd(rid, su.key, 'rank', v.rank, 50, 1)
      + '<span class="muted" style="margin:0 2px">/</span>' + scInpTd(rid, su.key, 'asgRank', v.asgRank, 50, 1) + '</div>'
      + '</td>';
  }
  return '<td style="white-space:nowrap">' + scInpTd(rid, su.key, 'raw', v.raw, 64)
    + '<div style="margin-top:3px">' + scInpTd(rid, su.key, 'rank', v.rank, 58, 1) + '</div>'
    + '</td>';
}
/** 总分布：左=赋分前（存 s._t），右=赋分后（仍是 school_rank / league_rank 两列）。 */
function scTotalCellsHtml(rid, r){
  var t = (r.s && r.s._t) || {};
  return '<td style="white-space:nowrap">' + scInpTd(rid, null, 'tRankRaw', t.rank, 50)
      + '<span class="muted" style="margin:0 2px">·</span>' + scInpTd(rid, null, 'tLeagueRaw', t.league, 50) + '</td>'
    + '<td style="white-space:nowrap">' + scInpTd(rid, null, 'schoolRank', r.schoolRank, 50)
      + '<span class="muted" style="margin:0 2px">·</span>' + scInpTd(rid, null, 'leagueRank', r.leagueRank, 50) + '</td>';
}

function scPaintRows(){
  var ex = SC_STATE.curExam || {};
  var subs = ex.subjects || [];
  var rows = SC_STATE.rows || [];

  if(!rows.length){
    $('scRows').innerHTML = '<div class="empty">本次考试暂无成绩。<br>'
      + '点上面「加一行」手填，或者回列表用「导入成绩」传一张表。</div>';
    return;
  }

  var head = scGridHeadHtml(subs);

  var body = rows.map(function(r, idx){
    return '<tr data-idx="' + idx + '">'
      + '<td><input class="inp" style="width:82px;padding:5px 6px" data-row="' + r.id + '" data-f="name" value="' + esc(r.name) + '"></td>'
      + '<td><input class="inp" style="width:70px;padding:5px 6px" data-row="' + r.id + '" data-f="no" value="' + esc(r.no || '') + '"></td>'
      + subs.map(function(s){ return scSubCellHtml(r.id, s, r.s[s.key]); }).join('')
      + scTotalCellsHtml(r.id, r)
      + '<td><button class="btn btn-sm btn-danger" data-del-row="' + r.id + '">删</button></td>'
      + '</tr>';
  }).join('');

  $('scRows').innerHTML = '<div class="table-wrap"><table style="font-size:.82rem">'
    + '<thead>' + head + '</thead><tbody id="scTbody">' + body + '</tbody></table></div>';

  /* 改动即排队 + 防抖保存；删除按钮单独绑 */
  var host = $('scRows');
  host.oninput = function(ev){
    var t = ev.target;
    if(!t || !t.getAttribute || !t.getAttribute('data-row')) return;
    scMarkDirty(t.getAttribute('data-row'));
  };
  host.onchange = function(ev){
    var t = ev.target;
    if(t && t.getAttribute && t.getAttribute('data-row')) scMarkDirty(t.getAttribute('data-row'));
  };
  host.onclick = function(ev){
    var b = ev.target.closest ? ev.target.closest('[data-del-row]') : null;
    if(!b) return;
    var rid = Number(b.getAttribute('data-del-row'));
    if(!confirm('删掉这一行？（保存后生效，无法恢复）')) return;
    scDeleteRow(rid);
  };
}

function scMarkDirty(rowId){
  SC_STATE.dirty[rowId] = true;
  scSetSaveState('待保存');
  if(SC_STATE.timer) clearTimeout(SC_STATE.timer);
  SC_STATE.timer = setTimeout(scFlush, 1500);
}

function scSetSaveState(txt, kind){
  var el = $('scSaveState');
  if(!el) return;
  el.textContent = txt;
  el.className = 'badge ' + (kind === 'ok' ? 'badge-green' : kind === 'err' ? 'badge-red' : 'badge-gray');
}

/* 把当前表格里"脏行"的内容收集起来提交 */
function scFlush(){
  if(SC_STATE.saving) return;
  var ids = Object.keys(SC_STATE.dirty);
  if(!ids.length) return;

  var subs = (SC_STATE.curExam && SC_STATE.curExam.subjects) || [];
  var rows = [];
  ids.forEach(function(rowId){
    var row = scReadRow(rowId, subs);
    if(row) rows.push(row);
  });
  if(!rows.length){ SC_STATE.dirty = {}; return; }

  SC_STATE.saving = true;
  scSetSaveState('保存中…');
  api('/scores?action=scores-save', { method:'POST', body: { exam: SC_STATE.cur, rows: rows } })
    .then(function(){
      SC_STATE.saving = false;
      SC_STATE.dirty = {};
      scSetSaveState('已保存', 'ok');
    })
    .catch(function(err){
      SC_STATE.saving = false;
      scSetSaveState('保存失败', 'err');
      toast('保存失败：' + err.message, 'err', 4200);
    });
}

/* 从 DOM 里读一行的当前值 */
function scReadRow(rowId, subs){
  var sel = '[data-row="' + rowId + '"]';
  var nameEl = document.querySelector(sel + '[data-f="name"]');
  if(!nameEl) return null;             /* 行已被删掉 */
  var noEl   = document.querySelector(sel + '[data-f="no"]');
  /* 按 data-f 取值。⚠️ 这里必须把「各科排名 + 总分两组排名」一起读回来：
     整行是从 DOM 重建的，漏读哪个字段，保存时就会被整行覆盖掉（= 数据丢失）。
     2026-10-17 加各科排名与总分赋分前/后时，就是靠这条注释提醒别漏的。 */
  var pickInp = function(sub, f){
    var el = document.querySelector(sel + (sub ? '[data-sub="' + sub + '"]' : '') + '[data-f="' + f + '"]');
    return el ? scNumOrNull(el.value) : null;
  };
  var s = {};
  subs.forEach(function(su){
    var raw = pickInp(su.key, 'raw');
    var asg = pickInp(su.key, 'assigned');
    if(raw == null && asg == null) return;
    var o = su.graded ? { raw: raw, assigned: asg } : { raw: raw };
    var rk = pickInp(su.key, 'rank');
    var ak = pickInp(su.key, 'asgRank');
    if(rk != null) o.rank = rk;
    if(ak != null && asg != null) o.asgRank = ak;
    s[su.key] = o;
  });
  /* 总分（赋分前）的两个排名存进 _t；两个都空就不带（= 不知） */
  var tRank = pickInp(null, 'tRankRaw');
  var tLeague = pickInp(null, 'tLeagueRaw');
  if(tRank != null || tLeague != null) s._t = { rank: tRank, league: tLeague };
  return {
    id: Number(rowId),
    name: (nameEl.value || '').trim(),
    no: noEl ? (noEl.value || '').trim() : '',
    s: s,
    schoolRank: pickInp(null, 'schoolRank'),
    leagueRank: pickInp(null, 'leagueRank'),
  };
}

function scNumOrNull(v){
  var s = String(v == null ? '' : v).trim();
  if(s === '') return null;
  var n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/* 新增空行（转学生、或者补录一个漏掉的人） */
function scAddRow(examId){
  var ex = SC_STATE.curExam || scFindExam(examId) || {};
  var subs = ex.subjects || [];
  if(!subs.length){ toast('这次考试还没配置科目', 'err'); return; }
  var tmpId = 'new' + Date.now();
  var tbody = $('scTbody');
  if(!tbody){ /* 空表时先铺个骨架 */
    $('scRows').innerHTML = '<div class="table-wrap"><table style="font-size:.82rem"><thead>'
      + scGridHeadHtml(subs) + '</thead><tbody id="scTbody"></tbody></table></div>';
    var host0 = $('scRows');
    host0.oninput = function(ev){ var t = ev.target; if(t && t.getAttribute && t.getAttribute('data-row')) scMarkDirty(t.getAttribute('data-row')); };
    host0.onclick = function(ev){
      var b = ev.target.closest ? ev.target.closest('[data-del-row]') : null;
      if(!b) return;
      scDeleteRow(Number(b.getAttribute('data-del-row')));
    };
    tbody = $('scTbody');
  }
  var tr = document.createElement('tr');
  tr.innerHTML = '<td><input class="inp" style="width:82px;padding:5px 6px" data-row="' + tmpId + '" data-f="name" placeholder="姓名"></td>'
    + '<td><input class="inp" style="width:70px;padding:5px 6px" data-row="' + tmpId + '" data-f="no"></td>'
    + subs.map(function(s){ return scSubCellHtml(tmpId, s, null); }).join('')
    + scTotalCellsHtml(tmpId, {})
    + '<td><button class="btn btn-sm btn-danger" data-del-row="' + tmpId + '">删</button></td>';
  tbody.appendChild(tr);
  var first = tr.querySelector('input');
  if(first) first.focus();
}

function scDeleteRow(rowId){
  /* 立刻从界面上移除，避免误看；保存时会一并提交 */
  var el = document.querySelector('[data-row="' + rowId + '"][data-f="name"]');
  if(el){
    var tr = el.closest ? el.closest('tr') : null;
    if(tr) tr.remove();
  }
  var idNum = Number(rowId);
  if(Number.isFinite(idNum) && idNum > 0){
    api('/scores?action=row-delete', { method:'POST', body: { id: idNum, exam: SC_STATE.cur } })
      .then(function(){ toast('已删除', 'ok'); })
      .catch(function(err){ toast('删除失败：' + err.message, 'err', 4000); });
  } else {
    delete SC_STATE.dirty[rowId];   /* 还没入库的新行，直接丢弃 */
  }
}

function renderPopups(){
  $('view').innerHTML =
    '<div class="toolbar" style="background:var(--panel)">'
    +   '<div style="flex:1;min-width:0"><b style="font-size:.92rem">通用弹窗</b>'
    +     '<p class="muted" style="margin:4px 0 0;font-size:.8rem">'
    +       '开屏弹 / 板块弹，支持公告与作业通知自动取数</p></div>'
    +   '<button class="btn btn-sm btn-secondary" id="popRefresh">' + svg('refresh',14) + ' 刷新</button>'
    +   '<button class="btn btn-sm" id="popAdd">' + svg('plus',14) + ' 新增弹窗</button>'
    + '</div>'
    + '<div class="alert info" style="margin-bottom:16px">'
    +   '这里的每一条都会成为站内弹窗。数据存在云端，配了就生效，不配则前台永不弹（与以前行为一致）。'
    +   '关闭策略建议用默认的「每天弹一次」。'
    + '</div>'
    + '<section class="panel"><div id="popBody"><div class="loading"><div class="spinner"></div>加载中…</div></div></section>';

  $('popRefresh').onclick = loadPopups;
  $('popAdd').onclick = function(){ popEdit(null); };
  loadPopups();
}

function loadPopups(){
  $('popBody').innerHTML = '<div class="loading"><div class="spinner"></div>加载中…</div>';
  popLoad().then(function(){ paintPopups(); })
    .catch(function(e){ $('popBody').innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'; });
}

function popScopeName(scope){
  for(var i = 0; i < POP_CATS.length; i++) if(POP_CATS[i].id === scope) return POP_CATS[i].name;
  var m = /^cat:(\d+)$/.exec(scope);
  if(m) return '板块 · #' + m[1];
  return scope || '—';
}
function popSourceName(src){
  for(var i = 0; i < POP_SOURCES.length; i++) if(POP_SOURCES[i].id === src) return POP_SOURCES[i].name;
  return src || '—';
}
function popDismissName(d){
  for(var i = 0; i < POP_DISMISS.length; i++) if(POP_DISMISS[i].id === d) return POP_DISMISS[i].name;
  return d || '—';
}
function popWindowText(p){
  if(!p.startAt && !p.endAt) return '常驻';
  var a = p.startAt ? p.startAt.replace('T', ' ') : '不限';
  var b = p.endAt ? p.endAt.replace('T', ' ') : '不限';
  return a + ' ~ ' + b;
}

/* v3.5.40（站主 #4）：投放对象 → 一句话 */
function popTargetText(t){
  if(!t || !t.mode || t.mode === 'all') return '所有人';
  if(t.mode === 'users')   return '指定 ' + ((t.users || []).length) + ' 人（' + ((t.users || []).slice(0,3).join('、') || '未填') + ((t.users || []).length > 3 ? '…' : '') + '）';
  if(t.mode === 'roles')   return '身份：' + ((t.roles || []).map(function(r){
    return r === 'admin' ? '管理员' : r === 'teacher' ? '老师' : '学生';
  }).join('、') || '未选');
  if(t.mode === 'titles')  return '头衔：' + ((t.titles || []).join('、') || '未填');
  return '所有人';
}

function paintPopups(){
  var list = POP_STATE.list || [];
  if(!list.length){
    $('popBody').innerHTML = '<div class="empty">'
      + '<div style="font-size:2rem;margin-bottom:10px">💬</div>'
      + '暂无弹窗。<br>点右上角「新增弹窗」加一条，比如开屏弹一条班级公告。'
      + '</div>';
    return;
  }
  $('popBody').innerHTML = list.map(function(p, i){
    var badge = p.scope === 'boot' ? 'badge-green' : 'badge';
    var media = [];
    if(p.video) media.push('视频');
    if(p.image) media.push('图片');
    if(p.linkUrl) media.push('按钮');
    return '<div class="panel pop-card" style="margin-bottom:12px">'
      + '<div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap">'
      +   '<div style="flex:1;min-width:200px">'
      +     '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">'
      +       '<span class="badge ' + badge + '">' + esc(popScopeName(p.scope)) + '</span>'
      +       '<b style="font-size:.9rem">' + esc(p.title || '(无标题)') + '</b>'
      +       '<code class="mono muted" style="font-size:.72rem">' + esc(p.id) + '</code>'
      +     '</div>'
      +     '<div class="muted" style="font-size:.78rem;line-height:1.7">'
      +       '来源：' + esc(popSourceName(p.source))
      +       ' · 关闭：' + esc(popDismissName(p.dismiss))
      +       ' · 时间窗：' + esc(popWindowText(p))
      +       (media.length ? ' · 含 ' + media.join('/') : '')
      +       (p.bubble === false ? ' · 不留悬浮球' : ' · 留悬浮球')
      +       (p.bannerText ? ' · 横幅' : '')
      +       (p.theme ? ' · 样式:' + esc(p.theme) : '')
       + (p.level === 'urgent' ? ' · <b style="color:#b91c1c">紧急</b>'
          : p.level === 'important' ? ' · <b style="color:#c2410c">重要</b>' : '')
      +       (p.target && p.target.mode && p.target.mode !== 'all'
              ? ' · 投放:' + esc(popTargetText(p.target)) : ' · 投放:所有人')
      +     '</div>'
      +     (p.body ? '<div style="margin-top:8px;font-size:.8rem;white-space:pre-wrap;opacity:.85">'
      +       esc(p.body.length > 120 ? p.body.slice(0,120) + '…' : p.body) + '</div>' : '')
      +   '</div>'
      +   '<div style="display:flex;gap:6px;flex-shrink:0">'
      +     '<button class="btn btn-sm btn-ghost" data-pop-up="' + i + '" title="上移">↑</button>'
      +     '<button class="btn btn-sm btn-ghost" data-pop-down="' + i + '" title="下移">↓</button>'
      +     '<button class="btn btn-sm btn-secondary" data-pop-edit="' + i + '">编辑</button>'
      +     '<button class="btn btn-sm btn-secondary" data-pop-preview="' + i + '">预览</button>'
      +     '<button class="btn btn-sm btn-ghost" data-pop-del="' + i + '" style="color:var(--danger)">删除</button>'
      +   '</div>'
      + '</div></div>';
  }).join('');

  /* 事件用循环绑定（不用 inline onclick，避免 IIFE 内函数外露） */
  Array.prototype.forEach.call($('popBody').querySelectorAll('[data-pop-edit]'), function(b){
    b.onclick = function(){ popEdit(+b.dataset.popEdit); };
  });
  Array.prototype.forEach.call($('popBody').querySelectorAll('[data-pop-preview]'), function(b){
    b.onclick = function(){ popPreview(+b.dataset.popPreview); };
  });
  Array.prototype.forEach.call($('popBody').querySelectorAll('[data-pop-del]'), function(b){
    b.onclick = function(){ popDelete(+b.dataset.popDel); };
  });
  Array.prototype.forEach.call($('popBody').querySelectorAll('[data-pop-up]'), function(b){
    b.onclick = function(){ popMove(+b.dataset.popUp, -1); };
  });
  Array.prototype.forEach.call($('popBody').querySelectorAll('[data-pop-down]'), function(b){
    b.onclick = function(){ popMove(+b.dataset.popDown, 1); };
  });
}

function popMove(i, dir){
  var list = POP_STATE.list.slice();
  var j = i + dir;
  if(j < 0 || j >= list.length) return;
  var t = list[i]; list[i] = list[j]; list[j] = t;
  popWrite(list, '顺序已更新').then(paintPopups).catch(function(){});
}

function popDelete(i){
  var p = POP_STATE.list[i];
  if(!p) return;
  confirmBox({
    text: '删除这条弹窗？',
    detail: '「' + (p.title || p.id) + '」删除后前台不再弹。已关闭过它的同学不受影响。',
    danger: true,
    okText: '删除',
  }).then(function(ok){
    if(!ok) return;
    var list = POP_STATE.list.slice();
    list.splice(i, 1);
    popWrite(list, '已删除').then(paintPopups).catch(function(){});
  });
}

/* 新增 / 编辑：字段较多，用一个较宽的弹窗表单 */
function popEdit(idx){
  var editing = (typeof idx === 'number' && idx >= 0);
  var p = editing
    ? JSON.parse(JSON.stringify(POP_STATE.list[idx]))
    : { id: 'pop-' + Date.now().toString(36), scope:'boot', source:'custom', title:'', body:'',
        video:'', image:'', linkText:'', linkUrl:'', startAt:'', endAt:'', dismiss:'daily', bubble:true, bannerText:'', theme:'',
        target: { mode:'all', users:[], roles:[], titles:[] } };

  function opts(arr, cur){
    return arr.map(function(o){
      return '<option value="' + attr(o.id) + '"' + (o.id === cur ? ' selected' : '') + '>' + esc(o.name) + '</option>';
    }).join('');
  }
  var scopeOpts = POP_CATS.map(function(c){
    return '<option value="' + attr(c.id) + '"' + (c.id === p.scope ? ' selected' : '') + '>' + esc(c.name) + '</option>';
  }).join('');
  /* 若 scope 是自定义的 cat:N 且不在内置列表里，补一个选项，避免被吞掉 */
  var known = POP_CATS.some(function(c){ return c.id === p.scope; });
  if(!known) scopeOpts += '<option value="' + attr(p.scope) + '" selected>自定义 · ' + esc(p.scope) + '</option>';

  var html =
    '<div class="field"><label>弹窗 ID</label>'
    + '<input id="pfId" class="gate-input" value="' + attr(p.id) + '" placeholder="唯一标识，如 boot-hw">'
    + '<p class="hint">修改 ID 后，此前关闭该弹窗的成员将再次收到；新建时建议保持不变。</p></div>'

    + '<div class="field"><label>出现时机</label>'
    + '<select id="pfScope" class="gate-input">' + scopeOpts
    + '<option value="__custom__">自定义 cat:N（手填）</option></select>'
    + '<input id="pfScopeCustom" class="gate-input" style="margin-top:6px;display:none" value="' + attr(p.scope) + '" placeholder="如 cat:12"></div>'

    /* v3.5.40（站主 #4）：这条弹窗给谁看 */
    + '<div class="field"><label>投放对象</label>'
    + '<select id="pfTargetMode" class="gate-input">'
    +   '<option value="all"' + ((!p.target || p.target.mode === 'all') ? ' selected' : '') + '>所有人</option>'
    +   '<option value="users"' + (p.target && p.target.mode === 'users' ? ' selected' : '') + '>指定账号（按用户名 / 姓名）</option>'
    +   '<option value="roles"' + (p.target && p.target.mode === 'roles' ? ' selected' : '') + '>按身份（管理员 / 学生 / 老师）</option>'
    +   '<option value="titles"' + (p.target && p.target.mode === 'titles' ? ' selected' : '') + '>按头衔（团支书 / 课代表…）</option>'
    + '</select>'
    + '<div id="pfTargetUsersWrap" style="display:' + (p.target && p.target.mode === 'users' ? '' : 'none') + ';margin-top:8px">'
    +   '<input id="pfTargetUsers" class="gate-input" value="' + attr(((p.target && p.target.users) || []).join(', ')) + '"'
    +     ' placeholder="多个用逗号分隔，如 yuzikang, 余子康">'
    +   '<p class="hint">支持登录名或真实姓名；仅投放给下列成员。</p></div>'
    + '<div id="pfTargetRolesWrap" style="display:' + (p.target && p.target.mode === 'roles' ? '' : 'none') + ';margin-top:8px;display:' + (p.target && p.target.mode === 'roles' ? 'flex' : 'none') + ';gap:14px;flex-wrap:wrap">'
    +   [['admin','管理员'],['user','学生'],['teacher','老师']].map(function(x){
          var on = !p.target || p.target.mode !== 'roles' || (p.target.roles || []).indexOf(x[0]) >= 0;
          return '<label style="display:flex;align-items:center;gap:6px;font-weight:400">'
            + '<input type="checkbox" class="pfRole" value="' + x[0] + '"' + (on ? ' checked' : '') + '> ' + x[1] + '</label>';
        }).join('')
    + '</div>'
    + '<div id="pfTargetTitlesWrap" style="display:' + (p.target && p.target.mode === 'titles' ? '' : 'none') + ';margin-top:8px">'
    +   '<input id="pfTargetTitles" class="gate-input" value="' + attr(((p.target && p.target.titles) || []).join(', ')) + '"'
    +     ' placeholder="多个用逗号分隔，如 团支书, 课代表">'
    +   '<p class="hint">按「头衔任命」里设的头衔匹配；同学身上有其中任意一个就会收到。</p></div>'
    + '<p class="hint">投放对象仅决定展示范围；内容存储于云端，请勿写入敏感信息。</p></div>'

    + '<div class="field"><label>内容来源</label>'
    + '<select id="pfSource" class="gate-input">' + opts(POP_SOURCES, p.source) + '</select>'
    + '<p class="hint">选「最新公告 / 作业通知」时，下面标题正文可留空，会自动取站内数据。</p></div>'

    + '<div class="field"><label>标题</label>'
    + '<input id="pfTitle" class="gate-input" value="' + attr(p.title) + '" placeholder="留空则用默认标题"></div>'

    + '<div class="field"><label>正文</label>'
    + '<textarea id="pfBody" class="gate-input" rows="4" placeholder="支持换行（直接回车即可）">' + esc(p.body) + '</textarea></div>'

    + '<div class="field"><label>视频链接（可选）</label>'
    + '<input id="pfVideo" class="gate-input" value="' + attr(p.video) + '" placeholder="B站分享链接 或 mp4 直链"></div>'

    + '<div class="field"><label>图片链接（可选）</label>'
    + '<input id="pfImage" class="gate-input" value="' + attr(p.image) + '" placeholder="图片直链"></div>'

    + '<div class="field" style="display:flex;gap:10px;flex-wrap:wrap">'
    +   '<div style="flex:1;min-width:160px"><label>按钮文字（可选）</label>'
    +     '<input id="pfLinkText" class="gate-input" value="' + attr(p.linkText) + '" placeholder="如 查看详情"></div>'
    +   '<div style="flex:2;min-width:200px"><label>按钮跳转到</label>'
    +     '<select id="pfLinkPick" class="gate-input">'
    +       pfLinkOptions(p.linkUrl)
    +     '</select></div>'
    + '</div>'

    + '<div class="field" id="pfLinkUrlWrap" style="display:' + (pfLinkIsCustom(p.linkUrl) ? '' : 'none') + '">'
    +   '<label>跳转地址</label>'
    +   '<input id="pfLinkUrl" class="gate-input" value="' + attr(p.linkUrl) + '" placeholder="https://... 或 cat:5 / fn:showCurrentHomework">'
    +   '<p class="hint">三种写法：<b>https://…</b> 外部链接；<b>cat:编号</b> 打开站内板块；'
    +   '<b>fn:函数名</b> 打开站内页面（如 fn:showCurrentHomework 当前作业）。'
    +   '留空则弹窗只有一个「我知道了」关闭按钮。</p>'
    + '</div>'

    + '<div class="field" style="display:flex;gap:10px;flex-wrap:wrap">'
    +   '<div style="flex:1;min-width:160px"><label>开始时间（可选）</label>'
    +     '<input id="pfStart" class="gate-input" value="' + attr(p.startAt) + '" placeholder="2026-10-13T08:00:00"></div>'
    +   '<div style="flex:1;min-width:160px"><label>结束时间（可选）</label>'
    +     '<input id="pfEnd" class="gate-input" value="' + attr(p.endAt) + '" placeholder="2026-10-20T18:00:00"></div>'
    + '</div>'

    + '<div class="field"><label>关闭后行为</label>'
    + '<select id="pfDismiss" class="gate-input">' + opts(POP_DISMISS, p.dismiss) + '</select></div>'

    + '<div class="field"><label>关闭后留悬浮球</label>'
    + '<label style="display:flex;align-items:center;gap:8px;font-weight:400">'
    +   '<input type="checkbox" id="pfBubble"' + (p.bubble !== false ? ' checked' : '') + '>'
    +   '勾选后，同学关掉弹窗仍能在右下角打开重看</label></div>'

    + '<div class="field"><label>横幅文字（仅「进板块」弹窗生效）</label>'
    + '<input id="pfBanner" class="gate-input" value="' + attr(p.bannerText) + '" placeholder="进板块时板块顶部显示的横幅，留空则不显示"></div>'

    + '<div class="field"><label>重要性（班级电脑弹窗的颜色与提示音）</label>'
    + '<select id="pfLevel" class="gate-input">'
    + POP_LEVELS.map(function(t){ return '<option value="' + attr(t.id) + '"' + (t.id === (p.level || '') ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('')
    + '</select>'
    + '<p class="hint">仅开启大屏模式的设备按此级别更换配色与提示音；移动端弹窗不受影响。</p></div>'

    + '<div class="field"><label>卡片样式</label>'
    + '<select id="pfTheme" class="gate-input">' + POP_THEMES.map(function(t){ return '<option value="' + attr(t.id) + '"' + (t.id === p.theme ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('') + '</select></div>';

  openModal({
    title: editing ? '编辑弹窗' : '新增弹窗',
    sub: editing ? ('正在编辑 ' + p.id) : '填好后保存即写入云端',
    body: html,
    wide: true,
    foot: '<button class="btn btn-secondary" id="pfCancel">取消</button>'
        + '<button class="btn" id="pfSave">保存</button>',
    onMount: function(){
      var sc = $('pfScope'), scc = $('pfScopeCustom');
      /* 已选「自定义」时把输入框亮出来 */
      if(sc.value === '__custom__') scc.style.display = '';
      sc.onchange = function(){
        scc.style.display = (sc.value === '__custom__') ? '' : 'none';
      };
      /* 「按钮跳转到」下拉的联动。
         ⚠️ 这里必须用 JS 赋值绑定，**不能写成内联的 onchange 属性**：
         本文件的主脚本是 IIFE 包裹的，内联属性在全局作用域执行，根本找不到
         IIFE 里的函数（真机上表现为「选了没反应」，且不报错，很难查）。 */
      var pick = $('pfLinkPick');
      if(pick) pick.onchange = pfLinkPickChange;
      /* v3.5.40：投放对象切换时显示对应输入区 */
      var tm = $('pfTargetMode');
      if(tm) tm.onchange = function(){
        var m = tm.value;
        var uw = $('pfTargetUsersWrap'), rw = $('pfTargetRolesWrap'), tw = $('pfTargetTitlesWrap');
        if(uw) uw.style.display = (m === 'users') ? '' : 'none';
        if(rw) rw.style.display = (m === 'roles') ? 'flex' : 'none';
        if(tw) tw.style.display = (m === 'titles') ? '' : 'none';
      };
      $('pfCancel').onclick = closeModal;
      $('pfSave').onclick = function(){ popSave(idx, editing); };
    },
  });
}

function popSave(idx, editing){
  var scopeSel = $('pfScope').value;
  var scope = (scopeSel === '__custom__') ? ($('pfScopeCustom').value || '').trim() : scopeSel;
  var id = ($('pfId').value || '').trim();
  if(!id){ toast('弹窗 ID 不能为空', 'err'); return; }
  if(!scope){ toast('请选择或填写出现时机', 'err'); return; }

  var item = {
    id:        id,
    scope:     scope,
    source:    $('pfSource').value,
    title:     ($('pfTitle').value || '').trim(),
    body:      $('pfBody').value || '',
    video:     ($('pfVideo').value || '').trim(),
    image:     ($('pfImage').value || '').trim(),
    linkText:  ($('pfLinkText').value || '').trim(),
    linkUrl:   ($('pfLinkUrl').value || '').trim(),
    startAt:   ($('pfStart').value || '').trim(),
    endAt:     ($('pfEnd').value || '').trim(),
    dismiss:   $('pfDismiss').value,
    bubble:    $('pfBubble').checked,
    bannerText: ($('pfBanner').value || '').trim(),
    theme:      $('pfTheme').value,
    level:      $('pfLevel').value,
    /* 新建时打上创建时间；编辑保留原来的，不能让「改个字」变成一次新推送 */
    createdAt:  (function(){
      var old = null;
      if(typeof idx === 'number' && POP_STATE.list[idx]) old = POP_STATE.list[idx].createdAt;
      return old || new Date().toISOString();
    })(),
    /* v3.5.40（站主 #4）：投放对象 */
    target: (function(){
      var m = $('pfTargetMode') ? $('pfTargetMode').value : 'all';
      var split = function(v){
        return String(v || '').split(/[,，、]/).map(function(x){ return x.trim(); }).filter(Boolean);
      };
      var roles = [];
      Array.prototype.forEach.call(document.querySelectorAll('.pfRole'), function(cb){
        if(cb.checked) roles.push(cb.value);
      });
      return {
        mode: m,
        users:  m === 'users'  ? split($('pfTargetUsers') ? $('pfTargetUsers').value : '') : [],
        roles:  m === 'roles'  ? (roles.length ? roles : ['user']) : [],
        titles: m === 'titles' ? split($('pfTargetTitles') ? $('pfTargetTitles').value : '') : [],
      };
    })(),
  };

  var list = POP_STATE.list.slice();

  /* 同 ID 冲突检查（新建撞已有，或编辑时改成别人的 ID） */
  var clash = -1;
  list.forEach(function(r, i){ if(r.id === id && (!editing || i !== idx)) clash = i; });
  var doWrite = function(target){
    if(target >= 0){ list[target] = item; }        /* 覆盖指定那条（冲突确认后） */
    else if(editing){ list[idx] = item; }          /* 原地编辑 */
    else { list.push(item); }                      /* 新增 */
    popWrite(list, editing ? '已保存' : '已新增').then(function(){
      closeModal();
      paintPopups();
    }).catch(function(){});
  };
  if(clash >= 0){
    confirmBox({
      text: 'ID 「' + id + '」已被另一条弹窗占用',
      detail: '继续保存会把它覆盖掉（不会新增一条）。要覆盖吗？',
      warn: true,
      okText: '覆盖',
    }).then(function(ok){ if(ok) doWrite(clash); });
    return;
  }
  doWrite(editing ? idx : -1);
}

/* 预览：用后台自己的弹窗容器还原前台样子（简化版，只展示能看见的部分） */
function popPreview(i){
  var p = POP_STATE.list[i];
  if(!p) return;
  var srcNote = '';
  if(p.source !== 'custom'){
    srcNote = '<div class="alert warn" style="margin:0 0 12px">'
      + '这条的内容取自「' + esc(popSourceName(p.source)) + '」，实际显示内容以站内当时的数据为准，'
      + '下面只是占位示意。</div>';
    if(p.source === 'announcements') srcNote += '<p style="opacity:.8">（此处会显示最新公告正文）</p>';
    if(p.source === 'homework_notice') srcNote += '<p style="opacity:.8">（此处会显示当前作业通知正文）</p>';
  } else {
    srcNote = '<p style="white-space:pre-wrap;margin:0 0 12px">' + (p.body ? esc(p.body) : '<span class="muted">（无正文）</span>') + '</p>';
  }
  var media = '';
  if(p.video) media += '<p class="muted" style="font-size:.8rem">🎬 视频：<code class="mono">' + esc(p.video) + '</code></p>';
  if(p.image) media += '<img src="' + attr(p.image) + '" style="max-width:100%;border-radius:8px;margin:8px 0" alt="预览图">';
  if(p.bannerText) media += '<p class="muted" style="font-size:.8rem">📌 横幅：' + esc(p.bannerText) + '</p>';
  var btn = p.linkUrl
    ? '<div style="margin-top:12px"><span class="btn btn-sm">' + esc(p.linkText || '查看详情') + '</span></div>'
    : '';

  openModal({
    title: p.title || '(无标题)',
    sub: popScopeName(p.scope) + ' · ' + popDismissName(p.dismiss) + ' · ' + popWindowText(p)
        + (p.theme ? ' · 样式:' + esc(p.theme) : '')
        + (p.bannerText ? ' · 横幅' : ''),
    body: srcNote + media + btn,
    foot: '<button class="btn btn-secondary" id="pvClose">关闭预览</button>'
        + '<button class="btn" id="pvEdit">去编辑</button>',
    onMount: function(){
      $('pvClose').onclick = closeModal;
      $('pvEdit').onclick = function(){ closeModal(); popEdit(i); };
    },
  });
}

/* ============================================================================
 * v3.15.0（站主）个人信息分享
 * ----------------------------------------------------------------------------
 * 站主要求：「发给同学链接，登录之后直接看自己的信息，也能查其他成员」。
 *    · 与成绩分享（share.html，免登录）分开：这条**必须先登录**；
 *    · 开放哪些功能、哪些字段，单独一套配置，与档案编辑不同步；
 *    · 生成后给链接 + 二维码（二维码复用 bdQrCanvas）。
 * 数据存后端 user_data（key=cls_info_shares），这里只负责界面。
 * ========================================================================= */
var ISHARE = { list: [], fields: [], loaded: false };

function ishareUrl(sh){
  var base = location.href.replace(/admin\.html.*$/, '');
  return base + 'info.html?t=' + encodeURIComponent(sh.token || '');
}

function renderIshare(){
  $('view').innerHTML =
    '<div class="toolbar" style="background:var(--panel)">'
    +   '<button class="btn btn-sm" id="isAdd">' + svg('plus', 14) + '新建分享</button>'
    +   '<span style="flex:1"></span>'
    +   '<button class="btn btn-sm btn-secondary" id="isRefresh">' + svg('refresh', 14) + '刷新</button>'
    + '</div>'
    + '<div class="alert info" style="margin-bottom:16px">'
    +   '给同学发一条链接，<b>用班级站账号登录</b>后就能直接查资料 —— 不用先进首页找板块。'
    +   '<br>链接里能看到什么，全由下面对每条分享的「开放范围」决定；'
    +   '<b>没勾的字段不会发到同学手机上</b>（连字段名都不给）。'
    +   '<br>档案里设成「仅本人 / 仅管理员」的字段，这里勾了也不会漏出去（两套取交集）。'
    + '</div>'
    + '<section class="panel"><div class="panel-head"><h3>' + svg('users', 17) + '我建过的分享'
    +   '<span class="sub" id="isCount"></span></h3></div>'
    +   '<div class="panel-body" id="isBody"><div class="loading"><div class="spinner"></div>加载中…</div></div>'
    + '</section>';

  $('isAdd').onclick = function(){ ishareForm(null); };
  $('isRefresh').onclick = function(){ ISHARE.loaded = false; loadIshare(); };
  if(ISHARE.loaded) paintIshare(); else loadIshare();
}

function loadIshare(){
  api('/profile?action=ishare-list').then(function(j){
    ISHARE.list = (j && j.shares) || [];
    ISHARE.fields = (j && j.fields) || [];
    ISHARE.loaded = true;
    paintIshare();
  }).catch(function(e){
    var b = $('isBody');
    if(b) b.innerHTML = '<div class="empty">' + svg('alert', 30) + '<p>加载失败：' + esc(e.message) + '</p></div>';
  });
}

function paintIshare(){
  var body = $('isBody');
  if(!body) return;
  if($('isCount')) $('isCount').textContent = '共 ' + ISHARE.list.length + ' 条';
  if(!ISHARE.list.length){
    body.innerHTML = '<div class="empty">' + svg('users', 34)
      + '<p>暂无分享链接。<br>点左上角「新建分享」，选好开放范围后会生成链接和二维码。</p></div>';
    return;
  }
  body.innerHTML = '<div style="display:flex;flex-direction:column;gap:10px">'
    + ISHARE.list.map(function(sh){
        var feats = sh.feats || {};
        var fc = [];
        if(feats.self) fc.push('查自己');
        if(feats.others) fc.push('查其他成员');
        if(!fc.length) fc.push('（没有开功能）');
        var nField = Object.keys(sh.fieldMap || {}).filter(function(k){ return sh.fieldMap[k]; }).length;
        var state = sh.alive ? '有效' : (sh.revoked ? '已撤销' : (sh.why || '已失效'));
        return '<div class="is-item" style="border:1px solid var(--border);border-radius:12px;padding:12px 14px">'
          + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
          +   '<span style="font-size:.72rem;font-weight:800;padding:2px 9px;border-radius:999px;'
          +     (sh.alive ? 'background:#e9f7ef;color:#0f8a4d' : 'background:#fdeceb;color:#c0392b') + '">' + esc(state) + '</span>'
          +   '<b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
          +     esc(sh.note || sh.title || '班级信息查询') + '</b>'
          +   '<span style="font-size:.74rem;color:var(--fg-3)">看过 ' + Number(sh.views || 0) + ' 次'
          +     (sh.maxViews ? ' / ' + sh.maxViews : '') + '</span>'
          + '</div>'
          + '<div style="font-size:.76rem;color:var(--fg-3);margin-top:6px">'
          +   esc(fc.join(' · ')) + (feats.others ? ' · ' + nField + ' 个字段' : '')
          +   (sh.expiresAt ? ' · ' + esc(String(sh.expiresAt).slice(0, 10)) + ' 到期' : ' · 长期有效')
          + '</div>'
          + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">'
          +   '<button class="btn btn-sm btn-secondary" data-act="copy" data-id="' + esc(sh.id) + '">复制链接</button>'
          +   '<button class="btn btn-sm btn-secondary" data-act="qr" data-id="' + esc(sh.id) + '">二维码</button>'
          +   '<button class="btn btn-sm btn-secondary" data-act="open" data-id="' + esc(sh.id) + '">打开看看</button>'
          +   (sh.alive ? '<button class="btn btn-sm btn-secondary" data-act="edit" data-id="' + esc(sh.id) + '">编辑</button>' : '')
          +   (sh.alive ? '<button class="btn btn-sm btn-secondary" data-act="rev" data-id="' + esc(sh.id) + '">撤销</button>' : '')
          +   '<button class="btn btn-sm btn-secondary" data-act="del" data-id="' + esc(sh.id) + '">删除</button>'
          + '</div>'
          + '</div>';
      }).join('')
    + '</div>';

  Array.prototype.forEach.call(body.querySelectorAll('[data-act]'), function(b){
    var act = b.getAttribute('data-act');
    var sh = null;
    ISHARE.list.forEach(function(x){ if(x.id === b.getAttribute('data-id')) sh = x; });
    if(!sh) return;
    b.onclick = function(){
      if(act === 'copy'){
        var url = ishareUrl(sh);
        if(navigator.clipboard && navigator.clipboard.writeText){
          navigator.clipboard.writeText(url).then(function(){ toast('链接已复制', 'ok'); },
            function(){ prompt('复制这个链接：', url); });
        }else{
          prompt('复制这个链接：', url);
        }
      }else if(act === 'qr'){
        var box = openModal({
          title: '二维码',
          sub: sh.note || sh.title || '班级信息查询',
          body: '<div style="text-align:center"><div id="isQrWrap" style="display:inline-block;padding:10px;background:#fff;border-radius:12px"></div>'
              + '<p style="font-size:.76rem;color:var(--fg-3);margin:10px 0 0">扫码 → 登录 → 直接看资料</p></div>',
          foot: '<button class="btn btn-secondary" id="isQrDown">保存图片</button>',
        });
        var cv = bdQrCanvas(ishareUrl(sh), 420);
        cv.style.width = 'min(70vw,300px)';
        cv.style.height = 'auto';
        box.querySelector('#isQrWrap').appendChild(cv);
        box.querySelector('#isQrDown').onclick = function(){
          var a = document.createElement('a');
          a.href = cv.toDataURL('image/png');
          a.download = '信息查询二维码.png';
          document.body.appendChild(a); a.click(); a.remove();
        };
      }else if(act === 'open'){
        window.open(ishareUrl(sh), '_blank');
      }else if(act === 'edit'){
        ishareForm(sh);
      }else if(act === 'rev'){
        confirmBox({ text: '撤销后这条链接立刻失效，确定吗？' }).then(function(ok){
          if(!ok) return;
          api('/profile?action=ishare-revoke', { method: 'POST', body: { id: sh.id } })
            .then(function(){ toast('已撤销', 'ok'); ISHARE.loaded = false; loadIshare(); })
            .catch(function(e){ toast(e.message, 'err'); });
        });
      }else if(act === 'del'){
        /* v3.15.4：撤销只是停用、记录还在；建错的和自测用的可以直接清掉 */
        confirmBox({ text: '删除后这条记录彻底消失（同学手里的链接也一起失效），确定吗？' }).then(function(ok){
          if(!ok) return;
          api('/profile?action=ishare-delete', { method: 'POST', body: { id: sh.id } })
            .then(function(){ toast('已删除', 'ok'); ISHARE.loaded = false; loadIshare(); })
            .catch(function(e){ toast(e.message, 'err'); });
        });
      }
    };
  });
}

/* 新建 / 编辑表单 */
function ishareForm(edit){
  var isEdit = !!edit;
  var feats = (edit && edit.feats) || { self: true, others: false };
  var fm = (edit && edit.fieldMap) || {};
  /* 新建时默认勾上前四个常用字段，省得每次都点 */
  var defOn = { student_id: 1, politics: 1, exam_no: 1, phone: 1 };
  var fields = ISHARE.fields.length ? ISHARE.fields : [];
  var days = 0;
  if(edit && edit.expiresAt){
    var left = Math.round((Date.parse(edit.expiresAt) - Date.now()) / 86400000);
    days = left > 0 ? left : 0;
  }

  /* v3.15.5（站主）：「考籍号、身份证号这些后台压根没有选项可以勾」——
     字段目录现在由后端按「字段管理」动态生成（ishareCatalog），
     这里只负责画出来；顺带把档案可见性标上，免得勾了却不显示又来问一次。 */
  var visWord = { admin: '档案：仅管理员', self: '档案：仅本人', committee: '档案：班委及以上' };
  var fieldBoxes = fields.map(function(f){
    var on = isEdit ? !!fm[f.key] : !!defOn[f.key];
    var lock = visWord[f.vis] || '';
    return '<label style="display:flex;align-items:center;gap:7px;padding:7px 9px;border:1px solid var(--border);'
      + 'border-radius:9px;font-size:.82rem;cursor:pointer' + (lock ? ';opacity:.9' : '') + '">'
      + '<input type="checkbox" data-f="' + esc(f.key) + '"' + (on ? ' checked' : '') + '> '
      + esc(f.label)
      + (lock ? '<span style="font-size:.68rem;color:#b45309;background:#fbeee0;border-radius:5px;padding:1px 5px;white-space:nowrap">' + esc(lock) + '</span>' : '')
      + '</label>';
  }).join('');

  var body = ''
    + '<div class="field"><label>标题（同学在页面上看到的）</label>'
    +   '<input id="isTitle" maxlength="30" value="' + esc(edit ? (edit.title || '') : '班级信息查询') + '"></div>'
    + '<div class="field"><label>备注（只给自己看，方便认出这条是发给谁的）</label>'
    +   '<input id="isNote" maxlength="40" value="' + esc(edit ? (edit.note || '') : '') + '" placeholder="如：发给全班、临时查询"></div>'
    + '<div class="field"><label>开放哪些功能</label>'
    +   '<label style="display:flex;align-items:center;gap:8px;padding:6px 0"><input type="checkbox" id="isSelf"' + (feats.self ? ' checked' : '') + '> 查个人信息（看自己的资料）</label>'
    +   '<label style="display:flex;align-items:center;gap:8px;padding:6px 0"><input type="checkbox" id="isOthers"' + (feats.others ? ' checked' : '') + '> 查其他成员信息（可以搜同学、看下面的字段）</label>'
    + '</div>'
    + '<div class="field"><label>「查其他成员」时能看到的字段</label>'
    +   '<div id="isFieldBox" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px">'
    +   fieldBoxes + '</div>'
    +   '<p style="font-size:.74rem;color:var(--fg-3);margin:8px 0 0">这一份清单跟着「成员与档案 → 字段管理」走，'
    +   '你在字段管理里新增的字段会自动出现在这里。<br>姓名始终可见（不然搜不到人）；'
    +   '档案里设成「仅本人 / 仅管理员」的字段勾了也不会显示。</p>'
    + '</div>'
    + '<div class="field" style="display:flex;gap:10px;flex-wrap:wrap">'
    +   '<div style="flex:1;min-width:150px"><label>有效期</label>'
    +     '<select id="isDays">'
    +       '<option value="0"' + (days === 0 ? ' selected' : '') + '>长期有效</option>'
    +       '<option value="7"' + (days === 7 ? ' selected' : '') + '>7 天</option>'
    +       '<option value="30"' + (days === 30 ? ' selected' : '') + '>30 天</option>'
    +       '<option value="90"' + (days === 90 ? ' selected' : '') + '>90 天</option>'
    +       '<option value="custom"' + (days && [7,30,90].indexOf(days) < 0 ? ' selected' : '') + '>自定义</option>'
    +     '</select></div>'
    +   '<div style="flex:0 0 120px" id="isDaysWrap"><label>天数</label>'
    +     '<input id="isDaysNum" type="number" min="1" max="3650" value="' + (days || 7) + '"></div>'
    +   '<div style="flex:0 0 140px"><label>最多打开（可空）</label>'
    +     '<input id="isMax" type="number" min="1" placeholder="不限" value="' + (edit && edit.maxViews ? edit.maxViews : '') + '"></div>'
    + '</div>'
    + '<div class="field"><label>登录页提示 · 用户名</label>'
    +   '<input id="isHintU" maxlength="120" placeholder="用户名：本人姓名（例：张三）" value="' + esc(edit ? (edit.hintUser || '') : '') + '"></div>'
    + '<div class="field"><label>登录页提示 · 密码</label>'
    +   '<input id="isHintP" maxlength="120" placeholder="密码：班级站登录密码；忘了找管理员重置" value="' + esc(edit ? (edit.hintPass || '') : '') + '"></div>';

  var box = openModal({
    title: isEdit ? '编辑分享' : '新建个人信息分享',
    sub: '同学打开链接 → 登录 → 直接看资料',
    body: body,
    foot: '<button class="btn btn-secondary" data-close>取消</button>'
        + '<button class="btn" id="isSave">' + (isEdit ? '保存修改' : '生成链接') + '</button>',
  });

  function syncDays(){
    var v = box.querySelector('#isDays').value;
    box.querySelector('#isDaysWrap').style.display = (v === 'custom') ? '' : 'none';
  }
  box.querySelector('#isDays').onchange = syncDays;
  syncDays();

  box.querySelector('#isSave').onclick = function(){
    var btn = box.querySelector('#isSave');
    var selfOn = box.querySelector('#isSelf').checked;
    var othersOn = box.querySelector('#isOthers').checked;
    if(!selfOn && !othersOn){ toast('至少勾一个功能', 'err'); return; }
    var fmOut = {};
    Array.prototype.forEach.call(box.querySelectorAll('[data-f]'), function(cb){
      fmOut[cb.getAttribute('data-f')] = !!cb.checked;
    });
    if(othersOn && !Object.keys(fmOut).some(function(k){ return fmOut[k]; })){
      toast('「查其他成员」至少要勾一个字段', 'err'); return;
    }
    var dv = box.querySelector('#isDays').value;
    var daysOut = dv === 'custom' ? Math.max(1, parseInt(box.querySelector('#isDaysNum').value, 10) || 7) : Number(dv);
    var payload = {
      title: box.querySelector('#isTitle').value,
      note: box.querySelector('#isNote').value,
      feats: { self: selfOn, others: othersOn },
      fields: fmOut,
      days: daysOut,
      maxViews: box.querySelector('#isMax').value,
      hintUser: box.querySelector('#isHintU').value,
      hintPass: box.querySelector('#isHintP').value,
    };
    btn.disabled = true;
    btn.textContent = '保存中…';
    var req = isEdit
      ? api('/profile?action=ishare-update', { method: 'POST', body: Object.assign({ id: edit.id }, payload) })
      : api('/profile?action=ishare-create', { method: 'POST', body: payload });
    req.then(function(j){
      closeModal();
      ISHARE.loaded = false;
      loadIshare();
      if(!isEdit && j && j.url){
        var url = location.href.replace(/admin\.html.*$/, '') + j.url.replace(/^\//, '');
        var mb = openModal({
          title: '链接已生成',
          sub: '发给同学，登录后就能用',
          body: '<p style="font-size:.82rem;color:var(--fg-2);margin:0 0 8px">把这条链接发到群里，或生成二维码扫：</p>'
              + '<input id="isUrl" readonly value="' + esc(url) + '" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:10px;font-size:.78rem">',
          foot: '<button class="btn btn-secondary" id="isCopy2">复制链接</button>'
              + '<button class="btn btn-secondary" id="isQr2">二维码</button>'
              + '<button class="btn" data-close>好</button>',
        });
        mb.querySelector('#isCopy2').onclick = function(){
          var inp = mb.querySelector('#isUrl');
          inp.select();
          if(navigator.clipboard && navigator.clipboard.writeText){
            navigator.clipboard.writeText(url).then(function(){ toast('已复制', 'ok'); }, function(){ document.execCommand && document.execCommand('copy'); });
          }else if(document.execCommand){ document.execCommand('copy'); toast('已复制', 'ok'); }
        };
        mb.querySelector('#isQr2').onclick = function(){
          var cv = bdQrCanvas(url, 420);
          cv.style.width = 'min(70vw,300px)';
          mb.querySelector('#isUrl').parentNode.appendChild(cv);
          cv.style.display = 'block';
        };
      }else{
        toast(isEdit ? '已保存' : '已生成', 'ok');
      }
    }).catch(function(e){
      btn.disabled = false;
      btn.textContent = isEdit ? '保存修改' : '生成链接';
      toast(e.message, 'err');
    });
  };
}

/* ============================================================================
 * v4.10.8（站主）考试看板 —— 只读同步
 * ----------------------------------------------------------------------------
 * 站主原话（2026-11-08）：
 *   「暂时先不做写入，只做读取……后台的话，也暂时先不支持写入吧，然后后台有些
 *     东西我填的，比如说考试看板的地址啊，这些你可以让我在后台填。」
 *
 * 所以这一页只做三件事：
 *   ① 填考试看板的地址、选只显示哪个班（**不用账号密码**，读的是公开快照）
 *   ② 「立即同步」把整份快照拉到本站副本（存 KV，不建表、不占 Neon 额度）
 *   ③ 列出全部考试，右侧加号决定哪几场进大屏作业看板
 * 考试数据本身永远只读 —— 站内不往 examboard 写任何一个字。
 * ========================================================================= */
var EX = { state: null, list: null, busy: false, loaded: false, at: 0, fromCache: false };
var EX_CACHE = 'cls_admin_exams_v1';

function exWhen(ms){
  if(!ms) return '—';
  try{
    var d = new Date(Number(ms));
    var p = function(n){ return (n<10?'0':'')+n; };
    return d.getFullYear() + '/' + p(d.getMonth()+1) + '/' + p(d.getDate())
      + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }catch(e){ return '—'; }
}
function exAgo(ms){
  if(!ms) return '';
  var n = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if(n < 1) return '刚刚';
  if(n < 60) return n + ' 分钟前';
  var h = Math.round(n / 60);
  if(h < 24) return h + ' 小时前';
  return Math.round(h / 24) + ' 天前';
}
function exDayTxt(day){
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if(!m) return String(day || '');
  try{
    var d = new Date(+m[1], +m[2]-1, +m[3]);
    return (+m[2]) + '/' + (+m[3]) + ' 周' + '日一二三四五六'[d.getDay()];
  }catch(e){ return String(day || ''); }
}
function exMD(day){
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  return m ? (+m[2]) + '/' + (+m[3]) : String(day || '');
}

function renderExams(){
  $('view').innerHTML =
    '<div class="alert info" style="margin-bottom:16px">'
    +   '把<b>考试看板</b>里的考试安排接进本站：填好看板地址后点「立即同步」，'
    +   '大屏作业页会自动显示今天（含跨天考试的所有天）的场次；'
    +   '也可以在下面的清单里按整场 / 某一天 / 单场挑，或者一键加一整段时间。'
    +   '<br>数据只读，本站不会改动考试看板上的任何内容；副本存本机云端 KV，不占数据库额度。'
    + '</div>'
    + '<section class="panel" style="margin-bottom:16px">'
    +   '<div class="panel-head"><h3 style="margin:0;font-size:.95rem">① 考试看板地址</h3></div>'
    +   '<div class="field"><label>看板地址</label>'
    +     '<input id="exBase" placeholder="https://examboard.dpdns.org"></div>'
    +   '<div class="field"><label>只显示哪个班</label>'
    +     '<select id="exCls"><option value="">（同步后可选）</option></select>'
    +     '<p class="hint" style="margin:6px 0 0">大型考试里有的科目只排给某几个班（比如物化生只排本班），选对班级才不会把别班的场次算进来。</p></div>'
    +   '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">'
    +     '<button class="btn btn-sm" id="exSaveCfg">保存设置</button>'
    +     '<button class="btn btn-sm btn-ghost" id="exTest">测试连接</button>'
    +   '</div>'
    +   '<p class="hint" id="exCfgMsg" style="margin:8px 0 0"></p>'
    + '</section>'
    + '<section class="panel" style="margin-bottom:16px">'
    +   '<div class="panel-head"><h3 style="margin:0;font-size:.95rem">② 同步与刷新</h3></div>'
    +   '<div id="exStat" class="muted" style="font-size:.82rem;line-height:1.9">读取中…</div>'
    +   '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">'
    +     '<button class="btn btn-sm" id="exRefresh">刷新</button>'
    +     '<button class="btn btn-sm btn-ghost" id="exSync">立即同步</button>'
    +     '<a class="btn btn-sm btn-ghost" id="exOpen" href="https://examboard.dpdns.org" target="_blank" rel="noopener">打开考试看板 ↗</a>'
    +   '</div>'
    +   '<p class="hint" style="margin:8px 0 0">'
    +     '「刷新」会回考试看板问一次有没有更新（30 秒内重复点只算一次）；'
    +     '「立即同步」是把整份快照重新拉一遍并留档。平时打开这一页会自动刷新一次。</p>'
    + '</section>'
    + '<section class="panel">'
    +   '<div class="panel-head"><h3 style="margin:0;font-size:.95rem">③ 全部考试（只读）</h3></div>'
    +   '<p class="hint" style="margin:0 0 10px">每场考试默认收起，点标题展开看到每天每科。'
    +     '右侧「整场」= 这场跨几天全加；展开后「这天」= 只加那一天；每科右边的小圆钮 = 只加这一科。'
    +     '今天本来就会自动显示的那一场标「自动」。</p>'
    +   '<div id="exList" class="muted" style="font-size:.82rem">读取中…</div>'
    + '</section>';

  $('exSaveCfg').onclick = exSaveCfg;
  $('exTest').onclick = exTest;
  $('exSync').onclick = exSync;
  $('exRefresh').onclick = function(){ exLoad(true); };
  exLoad(false);
}

function exBusy(on){
  EX.busy = !!on;
  ['exSaveCfg','exTest','exSync','exRefresh'].forEach(function(id){
    var b = $(id); if(b) b.disabled = !!on;
  });
}

/**
 * v4.10.10：这一页也要能离线看。
 * 先拿 localStorage 里的上次结果画一遍，再回源；「刷新」走 fresh=1。
 */
function exLoad(fresh, quiet){
  if(!EX.loaded){
    try{
      var c = JSON.parse(localStorage.getItem(EX_CACHE) || 'null');
      if(c && c.list){
        EX.state = c.state || null;
        EX.list = c.list;
        EX.at = Number(c.at || 0);
        EX.fromCache = true;
        EX.loaded = true;
        exFill();
        exStatPaint();
        exPaint();
      }
    }catch(e){}
  }

  var get = function(p){
    return api(p).catch(function(){ return null; });
  };
  var q = fresh ? '&fresh=1' : '';
  if(fresh) exBusy(true);

  Promise.all([get('/exams?action=state'), get('/exams?action=list' + q)]).then(function(r){
    if(fresh) exBusy(false);
    var st = r[0] || null, ls = r[1] || null;
    if(st) EX.state = st;
    if(ls && Array.isArray(ls.groups)){
      EX.list = ls;
      EX.at = Date.now();
      EX.fromCache = false;
      try{
        localStorage.setItem(EX_CACHE, JSON.stringify({
          list: ls, state: EX.state, at: EX.at,
        }));
      }catch(e){}
    }
    EX.loaded = true;
    exFill();
    exStatPaint();
    exPaint();
    if(fresh && !quiet) toast('已刷新', 'ok');
  }).catch(function(e){
    if(fresh) exBusy(false);
    if($('exStat')) $('exStat').textContent = '读取失败：' + e.message;
  });
}

/** 配置区：地址 + 班级下拉 */
function exFill(){
  var st = EX.state || {};
  var c = st.cfg || {};
  if($('exBase') && !$('exBase').value) $('exBase').value = c.base || '';
  var go = $('exOpen');
  if(go && (c.base || (EX.list && EX.list.base))) go.href = c.base || EX.list.base;

  var sel = $('exCls');
  if(sel){
    var list = st.classes || [];
    var cur = c.classId || '';
    sel.innerHTML = '<option value="">（自动：第一个班）</option>' + list.map(function(x){
      return '<option value="' + esc(x.id) + '"' + (x.id === cur ? ' selected' : '') + '>'
        + esc(x.name || x.id) + '</option>';
    }).join('');
  }
}

function exStatPaint(){
  var stat = $('exStat');
  if(!stat) return;
  var L = EX.list;
  if(!L || !L.groups){
    stat.innerHTML = '本站暂无副本。填写地址后点击「立即同步」。';
    return;
  }
  var total = 0, on = 0, majors = L.groups.length;
  L.groups.forEach(function(g){ total += g.count || 0; on += g.onCnt || 0; });
  stat.innerHTML =
    '云端标题：<b>' + esc(L.title || '（未命名）') + '</b><br>'
    + '本站副本更新于：' + esc(exWhen(L.at))
    + (EX.at ? '（' + esc(exAgo(EX.at)) + '读取）' : '') + '<br>'
    + '考试：<b>' + majors + '</b> 场（' + total + ' 科）'
    + '　已挑 <b>' + on + '</b> 科'
    + (EX.fromCache ? '　<span class="muted">· 当前显示的是本机缓存</span>' : '');
}

function exPaint(){
  var box = $('exList'); if(!box) return;
  var L = EX.list;
  if(!L || !L.groups || !L.groups.length){
    box.innerHTML = '暂无考试数据。先在上面点「立即同步」。';
    return;
  }

  box.innerHTML = L.groups.map(function(g){
    var onAll = g.allOn;
    var head = '<summary style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:8px 2px;list-style:none">'
      + '<span style="flex:1;min-width:0;font-weight:800;font-size:.86rem;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
      +   esc(g.name) + (g.auto ? ' <span class="muted" style="font-weight:600;font-size:.72rem">自动</span>' : '')
      + '</span>'
      + '<span class="muted" style="flex:none;font-size:.72rem;font-variant-numeric:tabular-nums">'
      +   esc(exMD(g.start)) + (g.daysN > 1 ? '–' + esc(exMD(g.end)) : '') + ' · ' + g.count + ' 科'
      +   (g.onCnt ? ' · 已挑 ' + g.onCnt : '')
      + '</span>'
      + '<button type="button" class="btn btn-sm' + (onAll ? ' btn-ghost' : '') + '" data-pin="major:' + esc(g.id) + '" data-on="' + (onAll ? '0' : '1') + '">'
      +   (onAll ? '✓ 整场' : '＋ 整场')
      + '</button>'
      + '</summary>';

    var body = g.days.map(function(d){
      var dayLine = '<div style="display:flex;align-items:center;gap:8px;padding:5px 0 2px">'
        + '<span class="muted" style="flex:1;font-size:.74rem;font-weight:700;font-variant-numeric:tabular-nums">'
        +   esc(exDayTxt(d.date)) + '</span>'
        + '<button type="button" class="btn btn-sm btn-ghost" data-pin="day:' + esc(g.id + '|' + d.date) + '" data-on="' + (d.allOn ? '0' : '1') + '">'
        +   (d.allOn ? '✓ 这天' : '＋ 这天')
        + '</button>'
        + '</div>';
      return dayLine + d.items.map(function(it){
        return '<div style="display:flex;align-items:center;gap:8px;padding:3px 0 3px 12px">'
          + '<span style="flex:1;font-size:.82rem;color:var(--fg)">' + esc(it.name) + '</span>'
          + '<span class="muted" style="flex:none;font-size:.74rem;font-variant-numeric:tabular-nums">'
          +   esc(it.start) + '–' + esc(it.end) + '</span>'
          + '<button type="button" class="btn btn-sm' + (it.pin ? ' btn-ghost' : '') + '"'
          +   ' data-pin="item:' + esc(it.id) + '" data-on="' + (it.pin ? '0' : '1') + '"'
          +   ' style="min-width:58px">' + (it.pin ? '✓ 已加' : '＋ 加入') + '</button>'
          + '</div>';
      }).join('');
    }).join('');

    return '<details style="border-bottom:1px solid rgba(120,53,15,.10)">'
      + head
      + '<div style="padding:0 0 8px 10px">' + body + '</div>'
      + '</details>';
  }).join('');

  Array.prototype.forEach.call(box.querySelectorAll('[data-pin]'), function(b){
    b.onclick = function(e){
      e.preventDefault();
      e.stopPropagation();
      var raw = String(b.getAttribute('data-pin') || '');
      var bar = raw.indexOf(':');
      if(bar < 0) return;
      exPin(raw.slice(0, bar), raw.slice(bar + 1), b.getAttribute('data-on') === '1');
    };
  });
}

function exSaveCfg(){
  if(EX.busy) return;
  exBusy(true);
  var sel = $('exCls');
  api('/exams?action=cfg', { method: 'POST', body: {
    action: 'cfg',
    base: ($('exBase') || {}).value || '',
    classId: sel ? sel.value : '',
    className: sel && sel.selectedIndex >= 0 ? (sel.options[sel.selectedIndex].textContent || '') : '',
  } }).then(function(){
    toast('已保存', 'ok');
    exBusy(false);
    exLoad(true, true);
  }).catch(function(e){
    exBusy(false);
    toast(e.message, 'err');
  });
}

function exTest(){
  if(EX.busy) return;
  exBusy(true);
  var msg = $('exCfgMsg');
  api('/exams?action=test', { method: 'POST', body: { action: 'test' } }).then(function(j){
    exBusy(false);
    if(msg) msg.textContent = '连接正常：' + (j.title || '未命名') + ' · ' + j.majors + ' 场 · 班级 ' + (j.cls || '未识别');
    toast('连接正常', 'ok');
  }).catch(function(e){
    exBusy(false);
    if(msg) msg.textContent = e.message;
    toast(e.message, 'err');
  });
}

function exSync(){
  if(EX.busy) return;
  exBusy(true);
  api('/exams?action=sync', { method: 'POST', body: { action: 'sync' } }).then(function(j){
    exBusy(false);
    toast('已同步 ' + j.majors + ' 场', 'ok');
    exLoad(true, true);
  }).catch(function(e){
    exBusy(false);
    toast(e.message, 'err');
  });
}

function exPin(scope, id, on){
  if(EX.busy || !id) return;
  api('/exams?action=pin', { method: 'POST', body: { action: 'pin', scope: scope, id: id, on: !!on } })
    .then(function(){
      toast(on ? '已放到大屏作业看板' : '已移出大屏作业看板', 'ok');
      exLoad(true, true);
    }).catch(function(e){
      toast(e.message, 'err');
    });
}