
/* =====================================================
   全站音效（Web Audio 合成，无音频文件；侧边栏可关）
   ===================================================== */
var SFX=(function(){
  var AC=null,on=true;
  try{ on=localStorage.getItem('cls_sfx')!=='off'; }catch(e){}
  function ac(){ if(!AC){ try{AC=new (window.AudioContext||window.webkitAudioContext)();}catch(e){} } if(AC&&AC.state==='suspended')AC.resume(); return AC; }
  function tone(f,d,t,v,delay){
    var c=ac(); if(!c)return;
    var o=c.createOscillator(),g=c.createGain();
    o.type=t||'sine';o.frequency.value=f;
    var t0=c.currentTime+(delay||0);
    g.gain.setValueAtTime(v||0.04,t0);
    g.gain.exponentialRampToValueAtTime(0.001,t0+d);
    o.connect(g);g.connect(c.destination);o.start(t0);o.stop(t0+d+0.03);
  }
  function play(fn){ if(!on)return; try{fn();}catch(e){} }
  function refreshBtn(){
    var b=document.getElementById('sfxBtn');
    if(b) b.textContent='🔔 音效：'+(on?'开':'关');
  }
  refreshBtn();
  return {
    click:function(){ play(function(){tone(700,0.05,'triangle',0.025);}); },
    pop:function(){ play(function(){tone(880,0.07,'sine',0.035);}); },
    success:function(){ play(function(){tone(660,0.08,'sine',0.045);setTimeout(function(){tone(990,0.1,'sine',0.04);},70);}); },
    error:function(){ play(function(){tone(200,0.14,'sawtooth',0.035);}); },
    fanfare:function(){ play(function(){tone(523,0.09,'triangle',0.05);setTimeout(function(){tone(659,0.09,'triangle',0.05);},80);setTimeout(function(){tone(784,0.09,'triangle',0.05);},160);setTimeout(function(){tone(1047,0.16,'triangle',0.05);},240);}); },
    setOn:function(v){ on=v; try{localStorage.setItem('cls_sfx',v?'on':'off');}catch(e){} refreshBtn(); },
    isOn:function(){ return on; }
  };
})();
function toggleSfx(){ SFX.setOn(!SFX.isOn()); if(SFX.isOn()) SFX.success(); }

/* ============================================================================
 * 横屏切换（v3.5.39：与后台 admin.html 完全同款）
 * ----------------------------------------------------------------------------
   站主要求：「前端做到跟后端一样可以切换成横屏，要求和后台完全一样，
            按钮放在侧边栏下面音效的上面」。
   于是把 admin.html 那一套原样搬过来，只换持久化 key（cls_land，与后台的
   cls_admin_land 分开存 —— 前台想横屏不代表后台也想横屏）。

   核心规则（踩过的坑都在这）：
     · LAND_ON  = 用户「要不要横屏」的意图，只有按钮能改，是唯一真源。
     · syncLandscapeClass() 看**当前视口**：竖着（h>w）才加 .force-landscape
       做 CSS 兜底旋转；系统真的把屏幕转成横屏后（w>h）立刻撤掉旋转，
       否则会「转了两次 = 又变回竖的」。
     · 只有点了按钮才去尝试 fullscreen + orientation.lock，进页面不抢锁方向
       （否则一进来画面就是歪的）。
     · 从后台切回来 / 刷新后，用 resyncLandscape() 重新对齐一次。 */
var LAND_ON = false;
var LAND_LS = 'cls_land';
var LAND_FROM_ADMIN_LS = 'cls_land_from_admin';

/** 设备是不是已经物理横过来了。
 *  v3.5.40：iOS PWA 里 window.innerWidth 有时**不跟着设备转**（尤其中途切后台再回来），
 *  只看视口就会一直以为还在竖屏，于是 CSS 旋转一直挂着 ——
 *  站主看到的就是「手机已经横了，页面却还歪着 / 方向正好相反」。
 *  所以再加一路物理方向判断：设备真横了，就绝不加 CSS 旋转。 */
function deviceIsLandscape(){
  try{
    var a = null;
    if(screen.orientation && typeof screen.orientation.angle === 'number') a = screen.orientation.angle;
    if(a === null && typeof window.orientation === 'number') a = window.orientation;
    if(a === null) return false;
    a = Math.abs(Number(a)) % 360;
    return a === 90 || a === 270;
  }catch(e){ return false; }
}

function syncLandscapeClass(){
  var vpPortrait = window.innerHeight > window.innerWidth;
  var devLand = deviceIsLandscape();
  /* 只有「用户要横屏 + 视口还是竖的 + 设备也没横」才用 CSS 兜底旋转。
     设备一旦物理横过来（哪怕视口没更新），立刻撤掉，避免转两次导致方向相反。 */
  var need = LAND_ON && vpPortrait && !devLand;
  var html = document.documentElement;
  if(html.classList.contains('force-landscape') !== need){
    html.classList.toggle('force-landscape', need);
  }
  var btn = document.getElementById('landBtn');
  if(btn){
    btn.setAttribute('data-on', LAND_ON ? '1' : '0');
    btn.textContent = LAND_ON ? '📱 横屏查看：开' : '📱 横屏查看：关';
  }
  landscapePin();
}

/* ============================================================================
 * v3.9.6（站主）：横屏下侧边栏按钮滚下去就点不到
 * ----------------------------------------------------------------------------
 * 站主原话：「在点击横屏后的界面，只有翻到每个页面的最顶端的时候点击侧边栏
 *            才能显示，否则点击侧边栏按键之后无反应」。
 *
 * 根因：横屏是给 body 套 transform 旋转，按钮只能 absolute 定位（fixed 在
 *       transform 祖先里坐标会错，iOS 上根本点不到）。但 body 自己是滚动容器，
 *       absolute 的按钮会跟着内容一起滚走 —— 滚到中间时按钮其实已经在屏幕外，
 *       点到的只是空气。
 *
 * 修法：监听 body 滚动，把按钮的 top 跟着 scrollTop 补偿回去（相当于「钉」在
 *       视口左上角）。这里不能用 fixed，所以只能这样补偿。
 *       ⚠️ 旋转后 y 轴指向屏幕右侧，滚动会让按钮沿 x 方向跑，补偿的是 top（本地 y）。
 * ========================================================================= */
function landscapePin(){
  var fab = document.getElementById('fabBtn');
  if(!fab) return;
  var html = document.documentElement;
  if(!html.classList.contains('force-landscape')){
    if(fab.style.top) fab.style.top = '';
    return;
  }
  var st = (document.body && document.body.scrollTop) || 0;
  fab.style.top = (st + 14) + 'px';
}
try{
  document.addEventListener('scroll', landscapePin, { passive: true, capture: true });
  window.addEventListener('resize', landscapePin, { passive: true });
}catch(e){}

function lockLandscape(){
  /* v3.5.40：**不再请求全屏**。全屏 + fixed 旋转在 iOS PWA 上切后台回来时
     会留下「全屏已退出、布局还按全屏算」的残影（站主说的卡住）。
     CSS 旋转已经能兜住竖屏场景，全屏只是锦上添花，不值得这个风险。
     支持 orientation.lock 的浏览器（Android Chrome）仍然试一下，失败也无副作用。 */
  try{ if(screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function(){}); }catch(e){}
}
function unlockLandscape(){
  try{ if(screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); }catch(e){}
}

/** 把横屏意图写盘（'1' / '0'）。点按钮、恢复流程都走这里，只有一处写盘。 */
function saveLandIntent(){
  try{ localStorage.setItem(LAND_LS, LAND_ON ? '1' : '0'); }catch(e){}
}

function toggleLandscape(){
  LAND_ON = !LAND_ON;
  saveLandIntent();
  if(LAND_ON){
    lockLandscape();
    /* 先按竖屏兜底转一次；380ms 后系统若已转屏会自动撤掉 CSS 旋转 */
    syncLandscapeClass();
    setTimeout(syncLandscapeClass, 380);
  }else{
    unlockLandscape();
    document.documentElement.classList.remove('force-landscape');
    setTimeout(syncLandscapeClass, 380);
  }
  if(typeof SFX !== 'undefined' && SFX && SFX.pop) SFX.pop();
  closeSidebar();
}

/** 进页面时决定用竖屏还是横屏。
 *  规则（跟后台一致）：
 *    ① 刚从后台点「返回前台」过来 → 一律竖屏，顺手把记忆清成 '0'
 *       （否则下次一打开又横过来，等于没改）
 *    ② 正常打开 / 刷新 / 独立 PWA 入口 → 沿用上次选择
 *  这里**不主动锁方向**，只同步 CSS 兜底。 */
function initLandscape(){
  var fromAdmin = false;
  try{
    fromAdmin = sessionStorage.getItem(LAND_FROM_ADMIN_LS) === '1';
    if(fromAdmin) sessionStorage.removeItem(LAND_FROM_ADMIN_LS);
  }catch(e){}
  if(fromAdmin){
    LAND_ON = false;
    saveLandIntent();
    document.documentElement.classList.remove('force-landscape');
  }else{
    try{ LAND_ON = (localStorage.getItem(LAND_LS) === '1'); }catch(e){ LAND_ON = false; }
  }
  syncLandscapeClass();
  setTimeout(syncLandscapeClass, 400);
}

/** 从后台切回来 / 页面被恢复时重新对齐（v3.5.40 重写）。
 *  老版本这里会再调一次 orientation.lock，iOS 上恢复时视觉视口还没更新，
 *  锁方向 + 定尺寸的 body 一起上，直接把页面顶出屏幕（站主说的「卡住」）。
 *  现在：先摘旋转 → 两帧后重新布局 → 再按需加回来。全程不碰 lock。 */
function resyncLandscape(){
  try{
    var html = document.documentElement;
    /* ① 先摘掉旋转，让浏览器按**当前真实视口**重排一次 */
    html.classList.remove('force-landscape');
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){
        /* ② 视口已更新，再决定要不要转 */
        syncLandscapeClass();
        /* ③ 再等一拍，iOS 地址栏收缩/展开会二次改视口 */
        setTimeout(syncLandscapeClass, 260);
      });
    });
  }catch(e){}
}
/* 全局轻点击音效（交互元素自动响应） */
document.addEventListener('click',function(e){
  var t=e.target;
  /* 【自定义设置】拖拽排序松手后的合成 click 不应触发音效 */
  if(typeof __dragBlockClick !== 'undefined' && __dragBlockClick) return;
  if(t.closest && t.closest('button, a, .card, .board-more, .fab, .hidden-fun-card, .tab-btn, .daily-btn, .signbar-btn, .side-btn')){
    SFX.click();
  }
},true);
/* =====================================================
   前端安全工具：SHA-256 哈希
   用途：门禁答案比对、隐藏空间暗号比对
   ⚠️ 注意：这类前端哈希/Salt 只是「混淆」不是「加密」——密钥就在本文件里，
      认真翻源码可以还原。因此**绝不能**用它保护真实隐私数据
      （联系方式已在 2026-10-05 迁到后端数据库）。
   历史：原先此处还有 XOR/Base64 工具（xorEncrypt/xorDecrypt），
      只服务于点歌平台的密钥解混淆；第二十八轮点歌功能整体迁到后台后已移除。
   ===================================================== */
var GATE_SALT = 'cls2505-gate-salt';
/* CONTACT_SALT 已随通讯录数据一起移除（2026-10-05），不要再加回来 */
function sha256Raw(latin1){
  var rightRotate=function(v,amt){ return (v>>>amt)|(v<<(32-amt)); };
  var mathPow=Math.pow, maxWord=mathPow(2,32), result='', words=[], asciiBitLength=latin1.length*8;
  var hash=sha256Raw.h||[], k=sha256Raw.k||[], primeCounter=k.length, isComposite={};
  for(var candidate=2;primeCounter<64;candidate++){
    if(!isComposite[candidate]){
      for(var i2=0;i2<313;i2+=candidate) isComposite[i2]=candidate;
      hash[primeCounter]=(mathPow(candidate,0.5)*maxWord)|0;
      k[primeCounter++]=(mathPow(candidate,1/3)*maxWord)|0;
    }
  }
  sha256Raw.h=hash; sha256Raw.k=k;
  latin1+='\x80';
  while(latin1.length%64-56) latin1+='\x00';
  for(var i3=0;i3<latin1.length;i3++){
    var j=latin1.charCodeAt(i3);
    if(j>>8) return '';
    words[i3>>2]|=j<<(((3-i3)%4)*8);
  }
  words[words.length]=(asciiBitLength/maxWord)|0;
  words[words.length]=asciiBitLength;
  for(var j2=0;j2<words.length;){
    var w=words.slice(j2,(j2+=16)), oldHash=hash.slice(0);
    hash=hash.slice(0,8);
    for(var i4=0;i4<64;i4++){
      var w15=w[i4-15], w2=w[i4-2], a=hash[0], e=hash[4];
      var temp1=hash[7]+(rightRotate(e,6)^rightRotate(e,11)^rightRotate(e,25))+((e&hash[5])^(~e&hash[6]))+k[i4]+
        (w[i4]=i4<16?w[i4]:(w[i4-16]+(rightRotate(w15,7)^rightRotate(w15,18)^(w15>>>3))+w[i4-7]+(rightRotate(w2,17)^rightRotate(w2,19)^(w2>>>10)))|0);
      var temp2=(rightRotate(a,2)^rightRotate(a,13)^rightRotate(a,22))+((a&hash[1])^(a&hash[2])^(hash[1]&hash[2]));
      hash=[(temp1+temp2)|0].concat(hash);
      hash[4]=(hash[4]+temp1)|0;
    }
    for(var i5=0;i5<8;i5++) hash[i5]=(hash[i5]+oldHash[i5])|0;
  }
  for(var i6=0;i6<8;i6++){
    for(var j3=3;j3+1;j3--){
      var b=(hash[i6]>>(j3*8))&255;
      result+=(b<16?'0':'')+b.toString(16);
    }
  }
  return result;
}
function sha256Hex(input){ return sha256Raw(unescape(encodeURIComponent(input))); }
function hashSecret(value, salt){ return sha256Hex(salt+'::'+value.trim().toLowerCase()); }
/* 答案归一化（仅用于站点门禁，不改变既有哈希算法）：
   全角→半角、去所有空白、去常见标点、转小写，让带空格 / 全角 / 大小写混排的写法都能通过（不记录任何答案明文） */
function normAnswer(s){
  var out = '', i, code;
  s = String(s == null ? '' : s);
  for(i=0;i<s.length;i++){
    code = s.charCodeAt(i);
    if(code === 0x3000) out += ' ';                              /* 全角空格 */
    else if(code > 0xFEE0 && code < 0xFF01 + 0x5F) out += String.fromCharCode(code - 0xFEE0); /* 全角字符 */
    else out += s.charAt(i);
  }
  out = out.replace(/\s+/g, '');                                 /* 去空白 */
  out = out.replace(/[，。、！？；：·,.!?;:'"()（）\-_~\[\]【】]/g, ''); /* 去标点 */
  return out.toLowerCase();
}
/* =====================================================
   Lucide 图标系统（内联 + CDN 兜底）
   规则：站内统一使用 Lucide 一套图标，不再使用 Emoji 作功能图标。
   内联数据来自 lucide-static v1.48.0（官方 1854 图标，此处仅内联本站用到的 84 个）。
   若某个图标名不在内联表内，iconSvg() 会自动回退到 CDN 加载（见 lucideFallback）。
   ===================================================== */
var LUCIDE_ICONS={"cloud":"<path d=\"M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z\"/>","app-window":"<rect x=\"2\" y=\"4\" width=\"20\" height=\"16\" rx=\"2\"/><path d=\"M10 4v4\"/><path d=\"M2 8h20\"/><path d=\"M6 4v4\"/>","arrow-right":"<path d=\"M5 12h14\"/><path d=\"m12 5 7 7-7 7\"/>","atom":"<circle cx=\"12\" cy=\"12\" r=\"1\"/><path d=\"M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z\"/><path d=\"M15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5Z\"/>","ban":"<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M4.929 4.929 19.07 19.071\"/>","bell":"<path d=\"M10.268 21a2 2 0 0 0 3.464 0\"/><path d=\"M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326\"/>","bird":"<path d=\"M16 7h.01\"/><path d=\"M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20\"/><path d=\"m20 7 2 .5-2 .5\"/><path d=\"M10 18v3\"/><path d=\"M14 17.75V21\"/><path d=\"M7 18a6 6 0 0 0 3.84-10.61\"/>","blocks":"<path d=\"M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2\"/><rect x=\"14\" y=\"2\" width=\"8\" height=\"8\" rx=\"1\"/>","bomb":"<circle cx=\"11\" cy=\"13\" r=\"9\"/><path d=\"M14.35 4.65 16.3 2.7a2.41 2.41 0 0 1 3.4 0l1.6 1.6a2.4 2.4 0 0 1 0 3.4l-1.95 1.95\"/><path d=\"m22 2-1.5 1.5\"/>","book-open":"<path d=\"M12 5v16\"/><path d=\"M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z\"/>","calendar":"<path d=\"M8 2v3\"/><path d=\"M16 2v3\"/><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\"/><path d=\"M3 9h18\"/>","candy":"<path d=\"M10 7v10.9\"/><path d=\"M14 6.1V17\"/><path d=\"M16 7V3a1 1 0 0 1 1.707-.707 2.5 2.5 0 0 0 2.152.717 1 1 0 0 1 1.131 1.131 2.5 2.5 0 0 0 .717 2.152A1 1 0 0 1 21 8h-4\"/><path d=\"M16.536 7.465a5 5 0 0 0-7.072 0l-2 2a5 5 0 0 0 0 7.07 5 5 0 0 0 7.072 0l2-2a5 5 0 0 0 0-7.07\"/><path d=\"M8 17v4a1 1 0 0 1-1.707.707 2.5 2.5 0 0 0-2.152-.717 1 1 0 0 1-1.131-1.131 2.5 2.5 0 0 0-.717-2.152A1 1 0 0 1 3 16h4\"/>","chart-column":"<path d=\"M3 3v16a2 2 0 0 0 2 2h16\"/><path d=\"M18 17V9\"/><path d=\"M13 17V5\"/><path d=\"M8 17v-3\"/>","circle":"<circle cx=\"12\" cy=\"12\" r=\"10\"/>","circle-check":"<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"m16 9-5.5 5.5L8 12\"/>","circle-check-big":"<path d=\"M21.801 10A10 10 0 1 1 17 3.335\"/><path d=\"m9 11 3 3L22 4\"/>","circle-x":"<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"m15 9-6 6\"/><path d=\"m9 9 6 6\"/>","clapperboard":"<path d=\"m12.296 3.464 3.02 3.956\"/><path d=\"M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z\"/><path d=\"M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\"/><path d=\"m6.18 5.276 3.1 3.899\"/>","clipboard-copy":"<rect width=\"8\" height=\"4\" x=\"8\" y=\"2\" rx=\"1\" ry=\"1\"/><path d=\"M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2\"/><path d=\"M16 4h2a2 2 0 0 1 2 2v4\"/><path d=\"M21 14H11\"/><path d=\"m15 10-4 4 4 4\"/>","contact":"<path d=\"M16 2v2\"/><path d=\"M7 21v-2a2 2 0 012-2h6a2 2 0 012 2v2\"/><path d=\"M8 2v2\"/><circle cx=\"12\" cy=\"10\" r=\"3\"/><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\"/>","crown":"<path d=\"M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z\"/><path d=\"M5 21h14\"/>","dices":"<rect width=\"12\" height=\"12\" x=\"2\" y=\"10\" rx=\"2\" ry=\"2\"/><path d=\"m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6\"/><path d=\"M6 18h.01\"/><path d=\"M10 14h.01\"/><path d=\"M15 6h.01\"/><path d=\"M18 9h.01\"/>","dna":"<path d=\"m10 16 1.5 1.5\"/><path d=\"m14 8-1.5-1.5\"/><path d=\"M15 2c-1.798 1.998-2.518 3.995-2.807 5.993\"/><path d=\"m16.5 10.5 1 1\"/><path d=\"m17 6-2.891-2.891\"/><path d=\"M2 15c6.667-6 13.333 0 20-6\"/><path d=\"m20 9 .891.891\"/><path d=\"M3.109 14.109 4 15\"/><path d=\"m6.5 12.5 1 1\"/><path d=\"m7 18 2.891 2.891\"/><path d=\"M9 22c1.798-1.998 2.518-3.995 2.807-5.993\"/>","download":"<path d=\"M12 15V3\"/><path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/><path d=\"m7 10 5 5 5-5\"/>","eraser":"<path d=\"M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21\"/><path d=\"m5.082 11.09 8.828 8.828\"/>","flame":"<path d=\"M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4\"/>","flask-conical":"<path d=\"M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2\"/><path d=\"M6.453 15h11.094\"/><path d=\"M8.5 2h7\"/>","folder":"<path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\"/>","gamepad":"<line x1=\"6\" x2=\"10\" y1=\"12\" y2=\"12\"/><line x1=\"8\" x2=\"8\" y1=\"10\" y2=\"14\"/><line x1=\"15\" x2=\"15.01\" y1=\"13\" y2=\"13\"/><line x1=\"18\" x2=\"18.01\" y1=\"11\" y2=\"11\"/><rect width=\"20\" height=\"12\" x=\"2\" y=\"6\" rx=\"2\"/>","gamepad-2":"<line x1=\"6\" x2=\"10\" y1=\"11\" y2=\"11\"/><line x1=\"8\" x2=\"8\" y1=\"9\" y2=\"13\"/><line x1=\"15\" x2=\"15.01\" y1=\"12\" y2=\"12\"/><line x1=\"18\" x2=\"18.01\" y1=\"10\" y2=\"10\"/><path d=\"M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z\"/>","gift":"<path d=\"M12 7v14\"/><path d=\"M20 11v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8\"/><path d=\"M7.5 7a1 1 0 0 1 0-5A4.8 8 0 0 1 12 7a4.8 8 0 0 1 4.5-5 1 1 0 0 1 0 5\"/><rect x=\"3\" y=\"7\" width=\"18\" height=\"4\" rx=\"1\"/>","globe":"<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20\"/><path d=\"M2 12h20\"/>","grid-3x3":"<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/><path d=\"M3 9h18\"/><path d=\"M3 15h18\"/><path d=\"M9 3v18\"/><path d=\"M15 3v18\"/>","hammer":"<path d=\"m15 12-9.373 9.373a1 1 0 0 1-3.001-3L12 9\"/><path d=\"m18 15 4-4\"/><path d=\"m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172v-.344a2 2 0 0 0-.586-1.414l-1.657-1.657A6 6 0 0 0 12.516 3H9l1.243 1.243A6 6 0 0 1 12 8.485V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5\"/>","house":"<path d=\"M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8\"/><path d=\"M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\"/>","keyboard":"<path d=\"M10 8h.01\"/><path d=\"M12 12h.01\"/><path d=\"M14 8h.01\"/><path d=\"M16 12h.01\"/><path d=\"M18 8h.01\"/><path d=\"M6 8h.01\"/><path d=\"M7 16h10\"/><path d=\"M8 12h.01\"/><rect width=\"20\" height=\"16\" x=\"2\" y=\"4\" rx=\"2\"/>","layers":"<path d=\"M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z\"/><path d=\"M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12\"/><path d=\"M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17\"/>","lightbulb":"<path d=\"M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5\"/><path d=\"M9 18h6\"/><path d=\"M10 22h4\"/>","link":"<path d=\"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71\"/><path d=\"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71\"/>","list-music":"<path d=\"M16 5H3\"/><path d=\"M11 12H3\"/><path d=\"M11 19H3\"/><path d=\"M21 16V5\"/><circle cx=\"18\" cy=\"16\" r=\"3\"/>","lock":"<rect width=\"18\" height=\"11\" x=\"3\" y=\"11\" rx=\"2\" ry=\"2\"/><path d=\"M7 11V7a5 5 0 0 1 10 0v4\"/>","lock-keyhole":"<circle cx=\"12\" cy=\"16\" r=\"1\"/><rect x=\"3\" y=\"10\" width=\"18\" height=\"12\" rx=\"2\"/><path d=\"M7 10V7a5 5 0 0 1 10 0v3\"/>","lock-open":"<rect width=\"18\" height=\"11\" x=\"3\" y=\"11\" rx=\"2\" ry=\"2\"/><path d=\"M7 11V7a5 5 0 0 1 9.9-1\"/>","mail":"<path d=\"m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7\"/><rect x=\"2\" y=\"4\" width=\"20\" height=\"16\" rx=\"2\"/>","maximize":"<path d=\"M8 3H5a2 2 0 0 0-2 2v3\"/><path d=\"M21 8V5a2 2 0 0 0-2-2h-3\"/><path d=\"M3 16v3a2 2 0 0 0 2 2h3\"/><path d=\"M16 21h3a2 2 0 0 0 2-2v-3\"/>","medal":"<path d=\"M7.21 15 2.66 7.14a2 2 0 0 1 .13-2.2L4.4 2.8A2 2 0 0 1 6 2h12a2 2 0 0 1 1.6.8l1.6 2.14a2 2 0 0 1 .14 2.2L16.79 15\"/><path d=\"M11 12 5.12 2.2\"/><path d=\"m13 12 5.88-9.8\"/><path d=\"M8 7h8\"/><circle cx=\"12\" cy=\"17\" r=\"5\"/><path d=\"M12 18v-2h-.5\"/>","megaphone":"<path d=\"M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z\"/><path d=\"M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14\"/><path d=\"M8 6v8\"/>","menu":"<path d=\"M4 5h16\"/><path d=\"M4 12h16\"/><path d=\"M4 19h16\"/>","message-circle":"<path d=\"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719\"/>","message-square":"<path d=\"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z\"/>","mic":"<path d=\"M12 19v3\"/><path d=\"M19 10v2a7 7 0 0 1-14 0v-2\"/><rect x=\"9\" y=\"2\" width=\"6\" height=\"13\" rx=\"3\"/>","monitor":"<rect width=\"20\" height=\"14\" x=\"2\" y=\"3\" rx=\"2\"/><line x1=\"8\" x2=\"16\" y1=\"21\" y2=\"21\"/><line x1=\"12\" x2=\"12\" y1=\"17\" y2=\"21\"/>","moon":"<path d=\"M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401\"/>","moon-star":"<path d=\"M18 5h4\"/><path d=\"M20 3v4\"/><path d=\"M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401\"/>","music":"<path d=\"M9 18V5l12-2v13\"/><circle cx=\"6\" cy=\"18\" r=\"3\"/><circle cx=\"18\" cy=\"16\" r=\"3\"/>","package":"<path d=\"M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z\"/><path d=\"M12 22V12\"/><polyline points=\"3.29 7 12 12 20.71 7\"/><path d=\"m7.5 4.27 9 5.15\"/>","party-popper":"<path d=\"M5.8 11.3 2 22l10.7-3.79\"/><path d=\"M4 3h.01\"/><path d=\"M22 8h.01\"/><path d=\"M15 2h.01\"/><path d=\"M22 20h.01\"/><path d=\"m22 2-2.24.75a2.9 2.9 0 0 0-1.96 3.12c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10\"/><path d=\"m22 13-.82-.33c-.86-.34-1.82.2-1.98 1.11c-.11.7-.72 1.22-1.43 1.22H17\"/><path d=\"m11 2 .33.82c.34.86-.2 1.82-1.11 1.98C9.52 4.9 9 5.52 9 6.23V7\"/><path d=\"M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2Z\"/>","pin":"<path d=\"M12 17v5\"/><path d=\"M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z\"/>","plane":"<path d=\"M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z\"/>","play":"<path d=\"M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z\"/>","pause":"<rect x=\"14\" y=\"3\" width=\"5\" height=\"18\" rx=\"1\"/><rect x=\"5\" y=\"3\" width=\"5\" height=\"18\" rx=\"1\"/>","volume-2":"<path d=\"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z\"/><path d=\"M16 9a5 5 0 0 1 0 6\"/><path d=\"M19.364 18.364a9 9 0 0 0 0-12.728\"/>","volume-x":"<path d=\"M11 4.702a.7.7 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.7.7 0 0 0 11 19.298z\"/><path d=\"m16.5 14.5 5-5\"/><path d=\"m16.5 9.5 5 5\"/>","volume-1":"<path d=\"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z\"/><path d=\"M16 9a5 5 0 0 1 0 6\"/>","music":"<path d=\"M9 18V5l12-2v13\"/><circle cx=\"6\" cy=\"18\" r=\"3\"/><circle cx=\"18\" cy=\"16\" r=\"3\"/>","disc-3":"<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M6 12c0-1.7.7-3.2 1.8-4.2\"/><circle cx=\"12\" cy=\"12\" r=\"2\"/><path d=\"M18 12c0 1.7-.7 3.2-1.8 4.2\"/>","audio-lines":"<path d=\"M2 10v3\"/><path d=\"M6 6v11\"/><path d=\"M10 3v18\"/><path d=\"M14 8v7\"/><path d=\"M18 5v13\"/><path d=\"M22 10v3\"/>","rewind":"<path d=\"M12 6a2 2 0 0 0-3.414-1.414l-6 6a2 2 0 0 0 0 2.828l6 6A2 2 0 0 0 12 18z\"/><path d=\"M22 6a2 2 0 0 0-3.414-1.414l-6 6a2 2 0 0 0 0 2.828l6 6A2 2 0 0 0 22 18z\"/>","fast-forward":"<path d=\"M12 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 12 18z\"/><path d=\"M2 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 2 18z\"/>","plus":"<path d=\"M5 12h14\"/><path d=\"M12 5v14\"/>","puzzle":"<path d=\"M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z\"/>","rabbit":"<path d=\"M13 16a3 3 0 0 1 2.24 5\"/><path d=\"M18 12h.01\"/><path d=\"M18 21h-8a4 4 0 0 1-4-4 7 7 0 0 1 7-7h.2L9.6 6.4a1 1 0 1 1 2.8-2.8L15.8 7h.2c3.3 0 6 2.7 6 6v1a2 2 0 0 1-2 2h-1a3 3 0 0 0-3 3\"/><path d=\"M20 8.54V4a2 2 0 1 0-4 0v3\"/><path d=\"M7.612 12.524a3 3 0 1 0-1.6 4.3\"/>","radio-tower":"<path d=\"M4.9 16.1C1 12.2 1 5.8 4.9 1.9\"/><path d=\"M7.8 4.7a6.14 6.14 0 0 0-.8 7.5\"/><circle cx=\"12\" cy=\"9\" r=\"2\"/><path d=\"M16.2 4.8c2 2 2.26 5.11.8 7.47\"/><path d=\"M19.1 1.9a9.96 9.96 0 0 1 0 14.1\"/><path d=\"M9.5 18h5\"/><path d=\"m8 22 4-11 4 11\"/>","rotate-cw":"<path d=\"M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8\"/><path d=\"M21 3v5h-5\"/>","ruler":"<path d=\"M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z\"/><path d=\"m14.5 12.5 2-2\"/><path d=\"m11.5 9.5 2-2\"/><path d=\"m8.5 6.5 2-2\"/><path d=\"m17.5 15.5 2-2\"/>","save":"<path d=\"M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z\"/><path d=\"M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7\"/><path d=\"M7 3v4a1 1 0 0 0 1 1h7\"/>","school":"<path d=\"M14 21v-3a2 2 0 0 0-4 0v3\"/><path d=\"M18 4.933V21\"/><path d=\"m4 6 7.106-3.79a2 2 0 0 1 1.788 0L20 6\"/><path d=\"m6 11-3.52 2.147a1 1 0 0 0-.48.854V19a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5a1 1 0 0 0-.48-.853L18 11\"/><path d=\"M6 4.933V21\"/><circle cx=\"12\" cy=\"9\" r=\"2\"/>","scroll-text":"<path d=\"M15 12h-5\"/><path d=\"M15 8h-5\"/><path d=\"M19 17V5a2 2 0 0 0-2-2H4\"/><path d=\"M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3\"/>","search":"<path d=\"m21 21-4.34-4.34\"/><circle cx=\"11\" cy=\"11\" r=\"8\"/>","smartphone":"<rect width=\"14\" height=\"20\" x=\"5\" y=\"2\" rx=\"2\" ry=\"2\"/><path d=\"M12 18h.01\"/>","sparkles":"<path d=\"M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z\"/><path d=\"M20 2v4\"/><path d=\"M22 4h-4\"/><circle cx=\"4\" cy=\"20\" r=\"2\"/>","square-pen":"<path d=\"M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7\"/><path d=\"M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z\"/>","sun":"<circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2v2\"/><path d=\"M12 20v2\"/><path d=\"m4.93 4.93 1.41 1.41\"/><path d=\"m17.66 17.66 1.41 1.41\"/><path d=\"M2 12h2\"/><path d=\"M20 12h2\"/><path d=\"m6.34 17.66-1.41 1.41\"/><path d=\"m19.07 4.93-1.41 1.41\"/>","target":"<circle cx=\"12\" cy=\"12\" r=\"10\"/><circle cx=\"12\" cy=\"12\" r=\"6\"/><circle cx=\"12\" cy=\"12\" r=\"2\"/>","thumbs-up":"<path d=\"M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z\"/><path d=\"M7 10v12\"/>","ticket":"<path d=\"M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z\"/><path d=\"M13 5v2\"/><path d=\"M13 17v2\"/><path d=\"M13 11v2\"/>","timer":"<line x1=\"10\" x2=\"14\" y1=\"2\" y2=\"2\"/><line x1=\"12\" x2=\"15\" y1=\"14\" y2=\"11\"/><circle cx=\"12\" cy=\"14\" r=\"8\"/>","trash":"<path d=\"M10 11v6\"/><path d=\"M14 11v6\"/><path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6\"/><path d=\"M3 6h18\"/><path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\"/>","triangle-alert":"<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\"/><path d=\"M12 9v4\"/><path d=\"M12 17h.01\"/>","tv":"<path d=\"m17 2-5 5-5-5\"/><rect width=\"20\" height=\"15\" x=\"2\" y=\"7\" rx=\"2\"/>","upload":"<path d=\"M12 3v12\"/><path d=\"m17 8-5-5-5 5\"/><path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/>","user":"<path d=\"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2\"/><circle cx=\"12\" cy=\"7\" r=\"4\"/>","worm":"<path d=\"m19 12-1.5 3\"/><path d=\"M19.63 18.81 22 20\"/><path d=\"M6.47 8.23a1.68 1.68 0 0 1 2.44 1.93l-.64 2.08a6.76 6.76 0 0 0 10.16 7.67l.42-.27a1 1 0 1 0-2.73-4.21l-.42.27a1.76 1.76 0 0 1-2.63-1.99l.64-2.08A6.66 6.66 0 0 0 3.94 3.9l-.7.4a1 1 0 1 0 2.55 4.34z\"/>","wrench":"<path d=\"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z\"/>","x":"<path d=\"M18 6 6 18\"/><path d=\"m6 6 12 12\"/>","zap":"<path d=\"M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z\"/>","headphones":"<path d=\"M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3\"/>","paperclip":"<path d=\"m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551\"/>","circle-play":"<path d=\"M9 9.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997A1 1 0 0 1 9 14.996z\"/><circle cx=\"12\" cy=\"12\" r=\"10\"/>"};
var EMOJI_ICON_MAP={"⚠":"triangle-alert","✅":"circle-check-big","💡":"lightbulb","🔒":"lock","📌":"pin","🎉":"party-popper","❌":"circle-x","📝":"square-pen","🔔":"bell","🌙":"moon","🔐":"lock-keyhole","📋":"clipboard-copy","📅":"calendar","⛶":"maximize","📱":"smartphone","🔗":"link","🌐":"globe","🌕":"moon","💾":"save","🗑":"trash","🏫":"school","☀":"sun","🚫":"ban","🎲":"dices","✨":"sparkles","🎮":"gamepad-2","📥":"download","🔍":"search","📡":"radio-tower","💭":"message-square","🎼":"list-music","🎟":"ticket","✕":"x","📲":"app-window","📤":"upload","📦":"package","💬":"message-circle","📜":"scroll-text","👤":"user","➕":"plus","🔤":"keyboard","🔄":"rotate-cw","📇":"contact","🧱":"blocks","🎬":"clapperboard","👉":"arrow-right","🧹":"eraser","📚":"book-open","🎤":"mic","🎵":"music","🎧":"headphones","🛠":"wrench","🏠":"house","☰":"menu","📊":"chart-column","🎁":"gift","🍅":"timer","📮":"mail","📺":"tv","🎈":"sparkles","📢":"megaphone","⛔":"ban","🖥":"monitor","⚡":"zap","🍎":"smartphone","🗂":"folder","🕹":"gamepad","🧩":"puzzle","🎯":"target","🐍":"worm","🔨":"hammer","🃏":"layers","🐦":"bird","🍬":"candy","💣":"bomb","🦘":"rabbit","⚫":"circle","⭕":"grid-3x3","♟":"crown","✈":"plane","🔎":"search","🔓":"lock-open","📖":"book-open","📐":"ruler","⚛":"atom","🧪":"flask-conical","🧬":"dna","🌗":"moon-star","🌓":"moon-star","🌒":"moon-star","👍":"thumbs-up","🟢":"circle-check","🔴":"circle-x","⚪":"circle","🔥":"flame","🥇":"medal","🥈":"medal","🥉":"medal","☁":"cloud","🏆":"medal","✏":"square-pen","🎨":"layers","🎋":"sparkles","📣":"megaphone","🔣":"keyboard","👁":"search","✓":"circle-check-big","📎":"paperclip","🔧":"wrench"};
/* 生成一个 Lucide 图标的 SVG 字符串（stroke 风格，24x24 网格） */
function iconSvg(name, size, extra){
  var s=size||16, e=extra||'';
  var inner=LUCIDE_ICONS[name];
  if(!inner){ return '<span class="licon lic-fb" data-lucide="'+name+'" style="width:'+s+'px;height:'+s+'px;'+e+'"></span>'; }
  return '<svg class="licon" xmlns="http://www.w3.org/2000/svg" width="'+s+'" height="'+s+'" viewBox="0 0 24 24" '
    + 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" '
    + 'style="width:'+s+'px;height:'+s+'px;vertical-align:-2px;flex:none;'+e+'" aria-hidden="true">' + inner + '</svg>';
}
/* emoji → 图标（用于数据里的 emoji 字段，如公告正文、科目徽章） */
function iconFor(ch, size, extra){ return iconSvg(EMOJI_ICON_MAP[ch]||'circle', size, extra); }
/* CDN 兜底：内联表缺失的图标，用 lucide UMD 渲染（离线失败则退化为空占位，不影响布局） */
function lucideFallback(){
  var fb=document.querySelectorAll('.lic-fb');
  if(!fb.length) return;
  var s=document.createElement('script');
  s.src='https://unpkg.com/lucide@latest/dist/umd/lucide.min.js';
  s.onload=function(){ try{ window.lucide.createIcons(); }catch(e){} };
  document.head.appendChild(s);
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',lucideFallback); else setTimeout(lucideFallback,0);

/* =====================================================
   【自定义设置】图标补丁：站内只内联了 95 个图标，设置面板要用的几个不在其中。
   ⚠️ 必须放在这里（EMOJI_ICON_MAP 之后、下方 EMOJI_CHARS/EMOJI_RE 构建之前）：
      正则是从 EMOJI_ICON_MAP 现算的，补丁放晚了新 emoji 就进不了正则，
      会被 emojiify 替换成空心圆圈。
   ===================================================== */
(function(){
  var EXTRA={
    'settings':'<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    'sliders-horizontal':'<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
    'palette':'<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
    'image':'<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
    'grip-vertical':'<circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>',
    'type':'<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>',
    'droplet':'<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>',
    'list':'<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>',
    'check':'<path d="M20 6 9 17l-5-5"/>',
    'chevron-down':'<path d="m6 9 6 6 6-6"/>',
    'chevron-up':'<path d="m18 15-6-6-6 6"/>',
    'rotate-ccw':'<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    'download':'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    'upload':'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>'
  };
  for(var k in EXTRA){ if(!LUCIDE_ICONS[k]) LUCIDE_ICONS[k]=EXTRA[k]; }
  var EE={'⚙':'settings','⚙️':'settings','🎨':'palette','🔠':'type','🖼':'image','📏':'sliders-horizontal','🎛':'sliders-horizontal'};
  for(var e in EE){ if(!EMOJI_ICON_MAP[e]) EMOJI_ICON_MAP[e]=EE[e]; }
})();

/* =====================================================
   emoji → Lucide 图标（v2.5.0：改为「渲染时一次性转换」）
   -----------------------------------------------------
   站主要求：「所有本地 emoji 都取消掉，统一用图标库」，并点名倒计时
   「每 1 秒 emoji 都会闪一下」。

   闪烁根因：旧实现是运行时引擎 —— MutationObserver 盯着整个 body，
   倒计时每秒重写 innerHTML → 触发 observer → 60ms 后重扫全页把 emoji
   换成 SVG → 下一秒又重写 → 又换回去。于是每秒 SVG/emoji 交替闪。

   新做法：**不再有运行时引擎**。
     · 界面里写死的 emoji：直接换成 iconSvg(name) 调用（编译期就定好）。
     · 动态文本（公告正文、作业内容、弹窗等云端内容里同学/站主写的 emoji）：
       渲染时调 emojiToSvgText() 一次性转成 SVG 字符串再插进 DOM。
   没有任何监听器，也就没有任何东西会跟倒计时打架 —— 闪烁从根上消失。
   ===================================================== */

/* emoji 识别表 / 正则 / 名称解析：转换与去 emoji 都要用，保留。 */
var EMOJI_CHARS = Object.keys(EMOJI_ICON_MAP).sort(function(a,b){ return b.length-a.length; });
var EMOJI_RE = new RegExp('(' + EMOJI_CHARS.map(function(c){
  return c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
}).join('|') + ')\\uFE0F?', 'g');
function emojiIconName(ch){
  var k = ch.replace(/\uFE0F/g,'');
  return EMOJI_ICON_MAP[k] || EMOJI_ICON_MAP[ch] || 'circle';
}

/* 把一段纯文本里的 emoji 换成内联 SVG 字符串（返回 HTML，调用方负责已转义的其余部分）。
   ⚠️ 只用于「已经过 esc() 转义」的文本，或本身可信的站内常量；
      因为返回的是 HTML 字符串。emoji 字符本身不含 HTML 元字符，替换是安全的。 */
function emojiToSvgText(text, size){
  var t = String(text == null ? '' : text);
  if(!t) return t;
  EMOJI_RE.lastIndex = 0;
  if(!EMOJI_RE.test(t)) return t;
  EMOJI_RE.lastIndex = 0;
  var out = '', last = 0, m;
  while((m = EMOJI_RE.exec(t))){
    if(m.index > last) out += t.slice(last, m.index);
    out += iconSvg(emojiIconName(m[0]), size || 15, 'vertical-align:-2px');
    last = m.index + m[0].length;
    if(m[0].length === 0) EMOJI_RE.lastIndex++;
  }
  if(last < t.length) out += t.slice(last);
  return out;
}

/* 与上面等价，但输入是**未转义**的原文：先 esc 再转图标。
   公告 / 作业正文走这条，既保证安全又能把 emoji 变成图标。 */
function emojiEscHtml(text, size){
  return emojiToSvgText(typeof esc === 'function' ? esc(text) : String(text == null ? '' : text), size);
}

/* 去掉文本里的 emoji（用于 <option>、placeholder 这类只能放纯文本的位置）。 */
function stripEmoji(text){
  var t = String(text == null ? '' : text);
  EMOJI_RE.lastIndex = 0;
  return t.replace(EMOJI_RE, '').replace(/^\s+/, '');
}

/* -----------------------------------------------------
   静态界面图标化：页面加载后跑**一次**，把写死在 HTML 里的 emoji 换成 SVG。
   ⚠️ 只跑一次、**不监听任何 DOM 变化** —— 这是和旧引擎的本质区别。
      旧引擎用 MutationObserver 盯 body，倒计时每秒重写就被反复触发 → 闪烁。
      这里跑完即止，之后页面怎么更新都与它无关，不可能再闪。
   跳过区域：script / style / textarea / option / input(placeholder) —— 这些不能放 SVG。
   ----------------------------------------------------- */
var ICONIFY_SKIP = {SCRIPT:1, STYLE:1, TEXTAREA:1, OPTION:1, TITLE:1};
function iconifyStatic(root){
  var base = root || document.body;
  if(!base) return;
  var walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT, {
    acceptNode: function(node){
      var p = node.parentNode;
      if(!p || ICONIFY_SKIP[p.nodeName]) return NodeFilter.FILTER_REJECT;
      if(p.closest && p.closest('[data-no-icon]')) return NodeFilter.FILTER_REJECT;
      EMOJI_RE.lastIndex = 0;
      return EMOJI_RE.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  var targets = [], n;
  while((n = walker.nextNode())) targets.push(n);
  for(var i = 0; i < targets.length; i++){
    var node = targets[i];
    var span = document.createElement('span');
    span.className = 'ico-inline';
    span.innerHTML = emojiToSvgText(node.nodeValue, 15);
    if(node.parentNode) node.parentNode.replaceChild(span, node);
  }
}
/* 选择框（<select> 里的 <option>）不能放 SVG，统一去 emoji 保留文字。 */
function stripEmojiInOptions(root){
  var base = root || document;
  var opts = base.querySelectorAll ? base.querySelectorAll('option') : [];
  for(var i = 0; i < opts.length; i++){
    var t = stripEmoji(opts[i].textContent);
    if(t !== opts[i].textContent) opts[i].textContent = t;
  }
}

/* =====================================================
   站点版本号（2026-10-07 新增）
   -----------------------------------------------------
   用途：站主要一眼判断「我改的东西到底推上线了没有」。
   显示在首页最底部与后台页脚；点一下还能回查线上后端构建号。

   三段式  主版本 . 小更新 . 修复            （v3.6.1 起）
     第 1 段 大版本：1 = 纯前端；2 = 含后端 + 数据库；3 = 数据架构与权限体系
       ⚠️ **这个数字只有站主说了才动**，AI 一律不许自己改。
     第 2 段 小更新：**一天只加一次**（当天第一批需求 +1；同一天后面的都进第 3 段）
     第 3 段 修复：同一天内的第 2、3… 次更新依次 +1（AI 负责）
     例：3.8.2 = 3 大版本下第 8 批功能里的第 2 次更新；
         3.8.3 = 同一天的下午又改了一批，版本仍是 3.8，只把末位加一。

   📢 版本节奏与公告规则（站主 2026-10-20 第二次明确，取代 3.7.5 的旧规则）：
     ① 一天只算一个版本（第二段）。同一天上午、下午各提一批需求，
        第二段**只加一次**，后面的改动都放到第三段：
        上午 3.8.2 → 下午 3.8.3 → 晚上 3.8.4。
     ② 公告标题只写前两段：「v3.8 更新！内容如下：」，一个版本批次**共用一条公告**。
        2026-10-20 晚的板块分享仍属 3.8 这一批，所以版本号是 3.8.4，公告还是那一条。
     ③ 公告内容可以一直改、一直往里加。3.8.1 改了什么、3.8.2 又改了什么，
        全都追加进同一条 v3.8 公告里，不单开新公告（否则一天好几条，太多）。
     ④ 只有第二段变了（3.8 → 3.9，也就是新的一天/新的一批）才新起一条公告。
     ⑤ 公告是给同学看的：不写后台、管理端、数据库、缓存、部署这类内部事项；
        语言要官方、简洁，按【分类】分好。
     部署门禁 scripts/predeploy.mjs 把这些全部做成了硬检查：
     云端版本记录没这一条、公告没追加本次内容、公告里出现内部词，任一不过都不许部署。

   ⚠️ 纪律：每次改代码都要把 VERSION 往上加一格，并把 VER_DATE 改成当天。
      忘了加就会出现「线上内容和版本号对不上」，版本号也就失去意义了。
   ===================================================== */
/* ⚠️ v3.9.8：SITE_VERSION / VER_DATE 现在声明在 index.html 里（脚本拆成 app.js 之后，
   部署门禁要能从 HTML 直接读到版本号，也避免脚本里再维护一份）。
   本文件里直接当全局变量用即可。 */
/* 源码仓库（「仓库」按钮二选一，2026-10-07） */
var REPO_LINKS = {
  gitee:  'https://gitee.com/zikang0529/class-site',
  github: 'https://github.com/yuzikaaang/class-site'
};

/* ---------- 版本号显示 / 更新检测 / 强制刷新（v2.6.4 大改） ----------
   背景：站主在 iOS 上发现「线上已经 2.6.3，我这边还是 2.6.2」。

   根因不是代码没推上去，而是 **iOS 极少主动检查 Service Worker 更新** ——
   尤其「添加到主屏」后，浏览器只在导航时、且最长 24 小时才查一次；
   即使新 SW 装好了，已打开的页面也不会自己重新加载，于是永远停在旧版。

   所以这里补齐三件事：
     ① **主动催检查** —— 注册后、回到前台、定时各催一次（见 swRegister）
     ② **明确说清落后了** —— 对比线上 index.html 里的 SITE_VERSION
     ③ **一键强制刷新** —— 清空 CacheStorage + 注销 SW + 带时间戳跳转

   为什么「强制刷新」要这么麻烦：iOS Safari **忽略 location.reload(true) 的
   强制参数**，只 reload 一定还会命中旧缓存，必须自己动手清。

   此外还要顾及「别打断正在用的人」：页面刚打开（15 秒内）发现更新就直接刷新，
   用户无感拿到新版；已经用了一会儿则只做提示，等他自己点。 */
var SW_REG = null;          /* ServiceWorkerRegistration */
var SW_HAS_UPDATE = false;  /* 已检测到有新版本 */
var SW_NEW_VER = '';        /* 线上具体版本号（拿得到才有） */
var SW_RELOADING = false;   /* 防止 controllerchange 反复触发刷新 */
var SW_BUSY = false;        /* 正在检查更新，避免连点 */
var SW_BOOT_AT = Date.now();/* 页面打开时刻，用于判断「能不能直接自动刷新」 */
var SW_AUTO_WINDOW = 15000; /* 打开后多少毫秒内发现更新 = 直接自动刷新 */

/* 版本号比较：a > b 返回 1，a < b 返回 -1，相等 0。缺位补 0（2.6 等价 2.6.0） */
function cmpVer(a, b){
  var x = String(a || '').split('.'), y = String(b || '').split('.');
  var n = Math.max(x.length, y.length);
  for(var i = 0; i < n; i++){
    var p = parseInt(x[i], 10) || 0, q = parseInt(y[i], 10) || 0;
    if(p > q) return 1;
    if(p < q) return -1;
  }
  return 0;
}

/* 给任何 Promise 加「最多等多久」的上限，超时就按兜底值继续。
   为什么必须有：检查更新走的是网络，网络差时 fetch 可能长时间不返回，
   界面就会一直卡在「正在检查更新…」，用户以为坏了。
   （线上实测踩过：后端构建号那次请求慢，把整个检查拖住。） */
function withTimeout(p, ms, fallback){
  return Promise.race([
    p,
    new Promise(function(res){ setTimeout(function(){ res(fallback); }, ms); })
  ]);
}

/* 取线上站点版本：读 sw.js 里的 SITE_VER（和 index.html 的 SITE_VERSION 同步）。

   ⚠️ 为什么不去读 index.html：首页有 600KB，线上实测**弱网下 30 秒都下不完**
   （检查更新会一直卡着，最后报「查询失败」）；而 sw.js 只有 12KB，1~5 秒就好。
   而且 sw.js 本来就随版本更新，把版本号放这里最自然。
   带时间戳 + no-store 双保险，否则可能拿到被缓存的那份，等于白查。 */
function fetchOnlineSiteVersion(){
  return fetch('./sw.js?_=' + Date.now(), { cache: 'no-store' })
    .then(function(r){ return r.ok ? r.text() : ''; })
    .then(function(t){
      var m = /SITE_VER\s*=\s*'([0-9]+(?:\.[0-9]+)*)'/.exec(t || '');
      return m ? m[1] : '';
    })
    .catch(function(){ return ''; });
}

/* ---------- 版本号渲染（三态） ---------- */
function paintVersion(){
  var el = document.getElementById('verLine');
  if(!el) return;
  if(SW_HAS_UPDATE){
    var v = SW_NEW_VER ? ('v' + SW_NEW_VER + ' ') : '';
    el.textContent = '发现新版本 ' + v + '· 点击立即更新（当前 v' + SITE_VERSION + '）';
    el.classList.add('ver-new');
    return;
  }
  el.classList.remove('ver-new');
  el.textContent = '站点版本 v' + SITE_VERSION + ' · ' + VER_DATE + ' 更新（点击检查更新）';
}

/* ---------- 点版本号：检查更新 ----------
   同时查「前端线上版本」和「后端构建号」——两者一起看才知道到底哪一层没同步。
   已经知道有新版时，再点一次就是直接更新。 */
function checkOnlineVersion(){
  var el = document.getElementById('verLine');
  if(!el) return;
  if(SW_HAS_UPDATE){ hardRefresh(); return; }   /* 已知有新版本，直接刷新 */
  if(SW_BUSY) return;
  SW_BUSY = true;
  el.textContent = '正在检查更新…';

  var base = (typeof API_BASE !== 'undefined' && API_BASE) ? API_BASE : '';
  var t = new Date();
  var hhmm = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2);

  var verP = withTimeout(fetchOnlineSiteVersion(), 6000, '');
  var shaP = base
    ? withTimeout(
        fetch(base + '/content', { method: 'GET', cache: 'no-store' })
          .then(function(r){ return r.headers.get('x-build-sha') || ''; })
          .catch(function(){ return ''; }),
        6000, '')
    : Promise.resolve('');

  Promise.all([verP, shaP]).then(function(res){
    var online = res[0], sha = res[1] || '';
    SW_BUSY = false;
    swCheckUpdate(false);            /* 顺手也催一次 SW */
    if(!online){
      el.textContent = '站点版本 v' + SITE_VERSION + ' · 线上版本查询失败（可能没网）';
      return;
    }
    if(cmpVer(online, SITE_VERSION) > 0){
      SW_HAS_UPDATE = true;
      SW_NEW_VER = online;
      paintVersion();                /* 切成「点击立即更新」态 */
      return;
    }
    el.textContent = '已是最新版本 v' + SITE_VERSION
      + (sha ? ' · 后端 ' + sha : '') + '（' + hhmm + ' 检查）';
  }).catch(function(){
    SW_BUSY = false;
    el.textContent = '站点版本 v' + SITE_VERSION + ' · 检查失败（可能没网）';
  });
}

/* ---------- 一键强制刷新 ----------
   步骤：注销 Service Worker → 清空 CacheStorage → 带时间戳重新进入。
   最后那个时间戳是为了绕开浏览器对 HTML 的 HTTP 缓存
   （GitHub Pages 给 HTML 的 max-age 是 600 秒，光 reload 会命中它）。

   ⚠️ 顺序不能反：**先注销 SW、再清缓存**。
   SW 活着的时候它的 fetch handler 是「网络优先 + 写缓存」——
   我们这边刚 caches.delete，它那边收到一个请求又 caches.open 建回来
   （真机测试抓到过：清完还剩一个 class-site-v56）。
   即便如此，注销与真正停服之间仍有个小窗口，所以缓存**清两轮**兜底。 */
function hardRefresh(){
  try{ if(typeof SFX !== 'undefined' && SFX && SFX.click) SFX.click(); }catch(e){}
  var el = document.getElementById('verLine');
  if(el) el.textContent = '正在清理缓存并重新加载…';

  var go = function(){
    var u;
    try{
      var x = new URL(location.href);
      x.searchParams.delete('_r');            /* 先清掉可能已有的旧标记，避免越堆越长 */
      x.searchParams.set('_r', Date.now());
      u = x.toString();
    }catch(e){
      u = location.origin + location.pathname + '?_r=' + Date.now();
    }
    try{ location.replace(u); }catch(e){ location.href = u; }
  };

  var unregisterAll = function(){
    if(navigator.serviceWorker && navigator.serviceWorker.getRegistrations){
      return navigator.serviceWorker.getRegistrations().then(function(rs){
        return Promise.all(rs.map(function(r){ return r.unregister().catch(function(){}); }));
      }).catch(function(){});
    }
  };
  var wipeCaches = function(){
    if(window.caches && caches.keys){
      return caches.keys()
        .then(function(ks){ return Promise.all(ks.map(function(k){ return caches.delete(k); })); })
        .catch(function(){});
    }
  };

  var step = Promise.resolve()
    .then(unregisterAll)     /* ① 先让 SW 退场，免得它把缓存又写回来 */
    .then(wipeCaches)        /* ② 清空所有缓存 */
    .then(wipeCaches);       /* ③ 再清一轮：覆盖「注销到真正停服」之间的窗口 */

  /* 无论清理成败都要走 —— 万一某个步骤抛错，也不能把用户卡在「正在清理…」 */
  step.then(function(){ setTimeout(go, 300); })
      .catch(function(){ setTimeout(go, 300); });
}

/* ---------- 主动催一次 SW 更新检查 ---------- */
function swCheckUpdate(manual){
  if(!('serviceWorker' in navigator)){
    if(manual && typeof uiMsg === 'function') uiMsg('当前环境不支持自动更新，请手动刷新页面', '#b45309');
    return;
  }
  if(SW_REG){ SW_REG.update().catch(function(){}); return; }
  navigator.serviceWorker.getRegistration().then(function(reg){
    if(reg){ SW_REG = reg; reg.update().catch(function(){}); }
  }).catch(function(){});
}

/* ---------- 发现新版本 ----------
   页面刚打开（还没开始做事）→ 直接让新 SW 立刻接管，接管后会自动刷新，
   用户无感拿到新版；已经用了一会儿 → 只做提示，不打断。 */
function swOnUpdateFound(worker){
  if(Date.now() - SW_BOOT_AT < SW_AUTO_WINDOW && worker){
    try{ worker.postMessage({ type: 'SKIP_WAITING' }); }catch(e){}
    return;
  }
  SW_HAS_UPDATE = true;
  paintVersion();
}

function swWatchInstall(reg){
  if(!reg) return;
  /* 已经有装好等着接管的（页面开着期间更新的典型状态） */
  if(reg.waiting && navigator.serviceWorker.controller){ swOnUpdateFound(reg.waiting); }
  reg.addEventListener('updatefound', function(){
    var nw = reg.installing;
    if(!nw) return;
    nw.addEventListener('statechange', function(){
      if(nw.state !== 'installed') return;
      /* 没有 controller = 首次安装，不算「更新」，别提示也别刷 */
      if(!navigator.serviceWorker.controller) return;
      swOnUpdateFound(nw);
    });
  });
}

/* ---------- 注册 SW 并建立「主动催更新」的三个时机 ---------- */
function swRegister(){
  if(!('serviceWorker' in navigator)) return;
  var hadController = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.register('./sw.js').then(function(reg){
    SW_REG = reg;
    swWatchInstall(reg);
    reg.update().catch(function(){});   /* 进站先催一次：iOS 自己基本不查 */
  }).catch(function(){});

  navigator.serviceWorker.addEventListener('controllerchange', function(){
    /* 首次安装时 controller 从「无」到「有」也会触发，那不算更新 */
    if(!hadController){ hadController = true; return; }
    if(SW_RELOADING) return;
    if(Date.now() - SW_BOOT_AT < SW_AUTO_WINDOW){
      /* 刚打开不久 → 直接刷，用户几乎无感 */
      SW_RELOADING = true;
      location.reload();
      return;
    }
    /* 已经用了一会儿 → 不打断，只在页脚标出来等用户点 */
    SW_HAS_UPDATE = true;
    paintVersion();
  });

  /* 回到前台立刻查一次 —— iOS 上「切出去又切回来」是最常见的使用路径 */
  document.addEventListener('visibilitychange', function(){
    if(document.visibilityState === 'visible') swCheckUpdate(false);
  });

  /* 定时兜底：长时间挂着也不会一直停在旧版本 */
  setInterval(function(){ swCheckUpdate(false); }, 5 * 60 * 1000);
}

/* ---------- 清理强制刷新留下的 ?_r= 标记 ----------
   刷新后立刻把地址栏还原干净，免得被收藏 / 分享时带着一串时间戳。 */
try{
  var _u = new URL(location.href);
  if(_u.searchParams.has('_r')){
    _u.searchParams.delete('_r');
    history.replaceState(null, '', _u.pathname + (_u.search || '') + _u.hash);
  }
}catch(e){}

/* ---------- 仓库入口二选（Gitee / GitHub） ---------- */
function openRepoDialog(){
  var m = document.getElementById('repoMask');
  if(m) m.classList.add('show');
  if(typeof SFX !== 'undefined' && SFX && SFX.pop) SFX.pop();
}
function closeRepoDialog(){
  var m = document.getElementById('repoMask');
  if(m) m.classList.remove('show');
}
function openRepo(which){
  var url = REPO_LINKS[which] || REPO_LINKS.gitee;
  closeRepoDialog();
  openLink(url, true);
}

/* ---------- 在线心跳（v2.5.0 升级为双向） ----------
   站主要求：「每隔一分钟双向发一个数据包，收到就说明在线」。
   所以这里不是「发完就算」，而是**必须收到服务端回的 pong** 才算在线：
     · 发出去（去程）→ 收到 { pong, online:true }（回程）→ ONLINE=true
     · 超时 / 网络错误 / 非 2xx                         → ONLINE=false
   比 navigator.onLine 可靠（后者只看网卡，网卡通但连不上服务器时它照样 true）。

   后端按**会话粒度**记录（sessions.last_seen_at），间隔 60 秒、判定窗口 90 秒。

   🚀 v2.6.1 简化（站主反馈「还是有可能会误弹」）：
     旧实现用「时间窗」防抖 —— 第一次失败开始计时，持续 60 秒才弹横幅。
     它和另一处判定耦合出了 bug：
       · api() 里任何一条请求失败都会 markNetFail() 把计时器点着，
         但 api() **成功时却不清零**（只有心跳成功才清）→ 服务器慢时，
         失败已经记上、心跳还没来得及成功，时间一到就弹了；
       · 复查定时器的触发时刻（宽限期 +60ms）和心跳间隔（60s）几乎重合，
         复查往往比心跳先跑 → 先弹一次、心跳成功又立刻收起，
         用户看到的就是「红条闪一下」，也就是「明明有网却提示连不上」。

     现在改为**只看心跳的连续失败次数**，规则只有两条：
       · 任意一次成功（心跳成功 / 任意 api 成功）→ 计数清零并收起横幅；
       · 心跳失败 → 计数 +1，**连续 2 次**才弹。
     api() 的失败不再计入（启动时并发好几条，互相叠加很容易「秒弹」），
     但它成功时会帮着清零 ——「有一条能通就说明网络没问题」比
     「偶尔一条不通就报警」靠谱得多。

     真断网时 fetch 会立刻 reject（不是干等超时），所以失败后
     FAIL_CONFIRM_DELAY_MS 会自动补打一次心跳做快速确认：15 秒内就能凑够
     2 次、及时提示；而服务器只是偶发慢的话，这次补打大概率成功 → 直接清零。 */
var ONLINE = true;            /* 最近一次心跳的结果 */
var NET_FAILS = 0;            /* 连续心跳失败次数（api 的失败不算） */
var NET_FAILS_MAX = 2;        /* 连续失败几次才弹横幅 */

/* 🚀 2026-10-11 v2.5.2：心跳超时 12s → 30s（站主反馈「正常联网却显示连不到服务器」）。
   根因是**服务端慢**，不是站主网络差：
     · 实测握手只要 0.2 秒（网络完全正常）
     · 但带 token 心跳的首字节要 1.4–10.1 秒（Neon HTTP 逐条 SQL 往返叠加）
     · 原来超时 12 秒 —— 最慢一次 10.1 秒，只差 1.9 秒就误判离线
   手机在移动数据 / 信号弱时延会更差，于是必然突破 12 秒 → 弹「连不到服务器」。
   30 秒给了充足余量：正常请求（≤10 秒）绝不会再被误杀，
   而真断网时 fetch 会立刻 reject（不是等到超时），提示照样很快出现。 */
var HB_TIMEOUT_MS = 30 * 1000;

/* 心跳失败后多久自动补打一次做「快速确认」。
   真断网时 fetch 会立刻 reject，这一次补打就能凑够 2 次、及时弹提示；
   服务器只是偶发慢的话，这次补打多半成功 → 计数清零，不误报。 */
var FAIL_CONFIRM_DELAY_MS = 15 * 1000;

/* 「重试」按钮的倒计时秒数（站主要求：点了要有反应，不能让人干等着猜） */
var RETRY_SECONDS = 60;

/* v3.5.40（站主 #3）：心跳带上「现在在哪个页面」，后台才能统计页面级在线时长。
   首页 → 「首页」，板块 → 板块中文名（成绩分析 / 班级事务 …）。 */
function hbPageName(){
  try{
    if(typeof __activeCat !== 'undefined' && __activeCat != null){
      var cats = (window.SITE_DATA && SITE_DATA.categories) || [];
      for(var i = 0; i < cats.length; i++){
        if(cats[i].id === __activeCat) return cats[i].name || ('板块' + __activeCat);
      }
      return '板块' + __activeCat;
    }
  }catch(e){}
  return '首页';
}

function startHeartbeat(){
  if(!(typeof AUTH !== 'undefined' && AUTH && AUTH.token)) return;
  if(window.__hbTimer) { clearInterval(window.__hbTimer); window.__hbTimer = 0; }
  var beat = function(){
    if(document.hidden) return;
    if(!AUTH || !AUTH.token) return;
    /* 后端没配置就直接跳过（老逻辑保留） */
    if(!(typeof API_BASE !== 'undefined' && API_BASE)) return;

    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timedOut = false;   /* 区分「服务器慢到超时」与「真的连不上」 */
    var to = ctrl ? setTimeout(function(){ timedOut = true; ctrl.abort(); }, HB_TIMEOUT_MS) : null;

    /* v3.5.12：这里必须和 api() 一样带 /api 前缀。
       老代码写的是 base + '/auth?action=ping'，而 API_BASE 只到域名根
       （https://api.classsite.dpdns.org），真实路径是 /api/auth —— 少一段，
       心跳自上线起就没打通过，只是失败被静默吞掉没人发现。 */
    fetch(apiUrl('/auth?action=ping&page=' + encodeURIComponent(hbPageName())), {
      method:'GET', cache:'no-store',
      headers:{ Authorization:'Bearer ' + AUTH.token },
      signal: ctrl ? ctrl.signal : undefined
    }).then(function(r){
      if(to) clearTimeout(to);
      if(!r || !r.ok){
        var e = new Error('ping ' + (r ? r.status : 'no response'));
        /* 5xx = 服务端自己出问题（能连上，是它忙/挂了）→ 归到「服务器慢」，
           v2.6.1 起由心跳自己判断，不再依赖 api() 那侧转发 */
        e.serverBusy = !!(r && r.status >= 500);
        throw e;
      }
      return r.json();
    }).then(function(j){
      /* 收到回程数据包 = 在线 */
      if(!j || !j.online) throw new Error('bad pong');
      markNetOk(true);   /* true = 心跳报的成功（重试态下只有它能算「真恢复」） */
      if(typeof window.__onPong === 'function') window.__onPong(j);
    }).catch(function(e){
      if(to) clearTimeout(to);
      /* 超时（服务器响应慢）与网络层失败（DNS/断网/CORS）要分开记：
         前者换流量没用，文案要说「服务器响应较慢」；
         后者才是该提示「检查网络 / 切换流量」的场景。
         v2.6.1：5xx 也归入 'slow'（服务端忙，不是用户的网络问题）。 */
      var kind = (timedOut || (e && e.serverBusy)) ? 'slow' : 'offline';
      markNetFail(kind);
      if(typeof window.__onPongFail === 'function') window.__onPongFail(NET_FAILS, kind);
    });
  };
  beat();
  window.__hbTimer = setInterval(beat, 60000);
  /* 页面重新回到前台时立刻补一次心跳（后台标签页里是不打的） */
  if(!window.__hbVisBound){
    window.__hbVisBound = true;
    document.addEventListener('visibilitychange', function(){
      if(!document.hidden && typeof AUTH !== 'undefined' && AUTH && AUTH.token){
        if(typeof window.__hbNow === 'function') window.__hbNow();
      }
    });
  }
  window.__hbNow = beat;
}

/* ---------- 网络健康计数（v2.6.1 起只看心跳）----------
   规则极简，只有两条：
     · 成功（心跳成功 / 任意 api 成功）→ NET_FAILS 清零 + 收起横幅
     · 心跳失败                        → NET_FAILS +1，连续 2 次才弹

   为什么不再用 v2.5.2 的「时间窗」：
     时间窗要维护「起始时刻 + 复查定时器」两个状态，且必须和心跳节奏对齐；
     一旦对不齐（复查 60.06 秒、心跳 60 秒，几乎同时）就会「先弹后收」闪一下。
     改成数次数之后没有这些时序问题，行为也好预测：连错两次才说话。 */
var NET_FAIL_KIND = 'offline';  /* 失败原因：'slow' 服务器慢 / 'offline' 真连不上 */

/* 「网络状态提示」开关：默认**关**（站主 2026-10-15：「网络检测暂时关闭」）。
   开关值存在 UI 配置里（随账号走），可在「自定义设置 → 动效」里随时打开。
   注意：关的只是提示 UI，心跳还在跑 —— 后台「在线」状态不受影响。 */
function netWatchOn(){
  return !!(typeof UI !== 'undefined' && UI && UI.netWatch);
}

/**
 * 网络恢复（任意一条请求成功都能调它）。
 * @param {boolean} [fromHeartbeat] 是否是**心跳**报的成功。
 *
 * ⚠️ 重试态下只有心跳成功才算「真的恢复了」：
 *   点「重试」时用户要的是「确认服务端能连上」，而心跳就是专门测这个的。
 *   如果拿 api 的成功也算数，遇到「某个接口快、心跳仍超时」的服务端半死状态，
 *   就会出现「已恢复 → 横幅又弹出来」闪一下 —— 实测（真机）就抓到了这种情形：
 *   自动云同步的 /api/content 先成功，把重试结束了，可心跳其实还在失败。
 *   所以 api 成功只负责「清零计数、别误报」，不负责结束重试。
 */
function markNetOk(fromHeartbeat){
  ONLINE = true;
  NET_FAILS = 0;
  NET_FAIL_KIND = 'offline';
  if(window.__netConfirmTimer){ clearTimeout(window.__netConfirmTimer); window.__netConfirmTimer = 0; }
  var wasRetrying = !!_retryTimer;
  if(wasRetrying && !fromHeartbeat){
    paintOfflineBar();     /* 维持重试态，继续走倒计时等心跳确认 */
    return;
  }
  stopRetry();
  if(wasRetrying) showRecoveredBanner();
  else setOfflineBanner(false);
}

/**
 * @param {'slow'|'offline'} kind 失败原因。默认 offline（保守：
 *   未知原因时按「连不上」提示，因为那是更常见的场景）。
 *   'slow' = 请求发出去了但服务器迟迟不回（超时 / 5xx），换流量没用；
 *   'offline' = 网络层直接失败（DNS / 断网 / CORS），该换网络。
 */
function markNetFail(kind){
  /* 🚀 2026-10-15 站主：「网络检测暂时关闭」。
     关掉的是「检测到连不上就弹横幅 + 重试倒计时」这整套提示 ——
     **心跳本身照旧在跑**（后台的「谁在线」靠它记 last_seen_at），只是不再打扰用户。
     想打开：设置 → 动效 → 「网络状态提示」。下面这套逻辑一行没删，随时能回来。 */
  if(!netWatchOn()){ NET_FAILS = 0; return; }

  ONLINE = false;
  /* 'offline' 更严重，一旦出现就以它为准（不被后面的 'slow' 降级） */
  if(kind === 'offline') NET_FAIL_KIND = 'offline';
  else if(NET_FAIL_KIND !== 'offline') NET_FAIL_KIND = 'slow';

  NET_FAILS++;
  if(NET_FAILS >= NET_FAILS_MAX){
    window.__netConfirmTimer = 0;
    setOfflineBanner(true);
  } else {
    /* 还差一次：15 秒后自动补打一次心跳做快速确认。
       真断网时这次很快也会失败 → 凑够 2 次、及时提示；
       只是抖了一下的话它多半成功 → 清零，不误报。 */
    scheduleConfirm();
  }
}

/* 失败后补打一次心跳（只留一个定时器，避免叠加） */
function scheduleConfirm(){
  if(window.__netConfirmTimer) return;
  window.__netConfirmTimer = setTimeout(function(){
    window.__netConfirmTimer = 0;
    if(typeof window.__hbNow === 'function') window.__hbNow();
  }, FAIL_CONFIRM_DELAY_MS);
}

/* ---------- 离线横幅（v2.5.0；v2.5.2 分两种原因；v2.6.1 加重试倒计时）----------
   用心跳实测结果（不看 navigator.onLine），恢复后自动收起。

   🚀 v2.5.2：文案按失败原因分两种（站主要求）。
     · 连不上（网络层失败）→ 检查网络 / 切换流量，这是用户能自己解决的；
     · 服务器响应慢（超时/5xx）→ 如实说明是服务器忙，**不要**再让用户去换流量
       （换了也没用，只会让人白折腾、更困惑）。

   🚀 v2.6.1：点「重试」不再只是默默打一发心跳（站主反馈「点了像没反应」），
     而是进入 **60 秒倒计时重试态**：文案变「正在刷新… 剩余 N 秒」每秒走动，
     期间每 10 秒真的再打一次心跳；成功立刻变「连接已恢复」并收起，
     倒计时走完还没成功就回到原来的提示 + 重试按钮（可以再点）。
   文案与 README「断网 / 连不上服务器时」一节保持一致。 */
var OFFLINE_TEXT = {
  offline: '连接不到服务端，当前显示的是本地缓存 · 请检查网络，或切换到流量（移动数据）再试',
  slow:    '服务器响应较慢，已切到本地缓存 · 正在自动重试，你也可以点右侧按钮重试'
};

/* 重试倒计时状态 */
var _retryTimer = 0;
var _retryLeft = 0;

/* 只负责画横幅内容，不负责挂载/卸载 */
function paintOfflineBar(){
  var el = document.getElementById('offlineBar');
  if(!el) return;
  if(_retryTimer){
    /* 重试态：转圈 + 倒计时，让用户明确看到「它在动」 */
    el.innerHTML = '<span class="off-ico off-spin">' + iconSvg('rotate-cw',16) + '</span>'
      + '<span class="off-txt">正在刷新… 剩余 <b>' + _retryLeft + '</b> 秒</span>';
    return;
  }
  /* 每次都按最新原因刷新文案（可能从 slow 变成 offline，反之亦然） */
  var txt = OFFLINE_TEXT[NET_FAIL_KIND] || OFFLINE_TEXT.offline;
  el.innerHTML = '<span class="off-ico">' + iconSvg('radio-tower',16) + '</span>'
    + '<span class="off-txt">' + txt + '</span>'
    + '<button class="off-btn" onclick="heartbeatNow()">重试</button>';
}

function setOfflineBanner(show){
  var el = document.getElementById('offlineBar');
  if(!el){
    if(!show) return;
    el = document.createElement('div');
    el.id = 'offlineBar';
    el.className = 'offline-bar';
    document.body.appendChild(el);
    /* 下一帧再加 show，让过渡动画生效 */
    setTimeout(function(){ el.classList.add('show'); }, 30);
  }
  if(show){
    el.classList.remove('off-ok');     /* 清掉上一轮「已恢复」的绿色残影 */
    paintOfflineBar();
    if(!el.classList.contains('show')){
      el.classList.add('show');
      if(typeof SFX !== 'undefined' && SFX && SFX.error) SFX.error();
    }
  } else {
    el.classList.remove('off-ok');
    el.classList.remove('show');
    setTimeout(function(){
      var e2 = document.getElementById('offlineBar');
      if(e2 && !e2.classList.contains('show')) e2.remove();
    }, 400);
  }
}

/* 重试成功后短暂显示「连接已恢复」，再自动收起 —— 让用户知道刚才那下管用了 */
function showRecoveredBanner(){
  var el = document.getElementById('offlineBar');
  if(!el) return;
  el.innerHTML = '<span class="off-ico">' + iconSvg('circle-check',16) + '</span>'
    + '<span class="off-txt">连接已恢复</span>';
  el.classList.add('show');
  el.classList.add('off-ok');
  if(window.__offOkTimer) clearTimeout(window.__offOkTimer);
  window.__offOkTimer = setTimeout(function(){
    window.__offOkTimer = 0;
    setOfflineBanner(false);
  }, 1400);
}

/* 停止重试倒计时（不负责收横幅） */
function stopRetry(){
  if(_retryTimer){ clearInterval(_retryTimer); _retryTimer = 0; }
  _retryLeft = 0;
}

/* 「重试」按钮：进入 60 秒倒计时 */
function startRetry(){
  if(_retryTimer) return;              /* 已经在重试了，别重复启动 */
  _retryLeft = RETRY_SECONDS;
  /* ⚠️ 必须先赋值 _retryTimer 再重绘：paintOfflineBar 靠它判断「是否处于重试态」，
     反过来的话第一帧会被画成失败文案，用户点了重试却看不到「正在刷新」。
     （v2.6.1 真机测试抓到的 bug） */
  _retryTimer = setInterval(function(){
    _retryLeft--;
    if(_retryLeft <= 0){
      /* 倒计时走完还是没成功：回到失败提示，重试按钮还在，用户可以再点 */
      stopRetry();
      setOfflineBanner(true);
      return;
    }
    paintOfflineBar();
    /* 每 10 秒真的再试一次，而不是干等倒计时走完 */
    if(_retryLeft % 10 === 0 && typeof window.__hbNow === 'function') window.__hbNow();
  }, 1000);
  paintOfflineBar();
  if(typeof window.__hbNow === 'function') window.__hbNow();
}

/* 手动重试 */
function heartbeatNow(){
  startRetry();
}


/* =====================================================
   站点数据（管理员修改此区域后重新发布即可）
   wechatOk: true = 微信内可直接打开
             false = 需引导用户用浏览器打开
   ===================================================== */
/* ============================================================
   学习卡片内置数据（v2.6.0 新增）
   ------------------------------------------------------------
   站主要求：「选择好想随机出现的学科知识点之后可以联网更新，
             比如我选择了物理，它这次刷新出了关于必修一的力学物理公式」

   设计取舍（重要）：
     学科知识点**网上没有可用的公开 API**（实测 api.pearktrue.cn、
     raw.githubusercontent.com 均不可达），所以不能像「每日一言」那样
     纯联网。这里的做法是：把知识点整理成**内置数据随前端发布**。

     为什么这样更好：
       ① 不依赖第三方稳定性 —— 那些「每日一题」类 API 随时可能挂；
       ② 内容可控 —— 严格贴合人教版必修一的教学进度，不会跳出超纲内容；
       ③ 离线可用 —— 断网/被墙时照样能刷；
       ④ 零延迟 —— 不用等网络往返。

     能联网的部分（古诗文 / 每日一词）另走 /api/study 代理，见 index.html。

   内容范围：人教版 2019 教材
     · 物理 必修第一册（力与运动）
     · 化学 必修第一册（物质及其变化 / 钠氯 / 铁金属材料 / 元素周期律）
     · 生物 必修1 分子与细胞
   ============================================================ */

/* ---------------- 物理 · 必修第一册 ---------------- */
var STUDY_PHYSICS = [
  { ch: '第一章 运动的描述', t: '平均速度与瞬时速度', b: '平均速度 v̄ = Δx/Δt，是矢量，方向与位移方向相同；瞬时速度是 Δt→0 时平均速度的极限，方向沿轨迹切线方向。', n: '⚠️ 平均速度 ≠ 平均速率（后者是路程/时间，标量）' },
  { ch: '第一章 运动的描述', t: '加速度', b: 'a = Δv/Δt，单位 m/s²。加速度是描述速度变化快慢的物理量，方向与 Δv 方向相同。', n: '⚠️ a 与 v 同向 → 加速；a 与 v 反向 → 减速。a 大不代表 v 大' },
  { ch: '第一章 运动的描述', t: '速度变化量', b: 'Δv = v₂ − v₁，是矢量。注意是「末减初」，顺序写反符号全反。', n: '一维情况用正负号表示方向即可' },

  { ch: '第二章 匀变速直线运动', t: '速度—时间公式', b: 'v = v₀ + at', n: '核心公式①' },
  { ch: '第二章 匀变速直线运动', t: '位移—时间公式', b: 'x = v₀t + ½at²', n: '核心公式②' },
  { ch: '第二章 匀变速直线运动', t: '速度—位移公式', b: 'v² − v₀² = 2ax', n: '核心公式③，不含 t，遇到未知时间时首选' },
  { ch: '第二章 匀变速直线运动', t: '中间时刻速度推论', b: 'v(t/2) = (v₀ + v)/2 = v̄', n: '⭐ 匀变速直线运动中，中间时刻的瞬时速度 = 全程平均速度' },
  { ch: '第二章 匀变速直线运动', t: '中间位置速度推论', b: 'v(x/2) = √[(v₀² + v²)/2]', n: '恒有 v(x/2) > v(t/2)（可用于比较大小）' },
  { ch: '第二章 匀变速直线运动', t: '逐差法推论', b: 'Δx = xₙ₊₁ − xₙ = aT²', n: '⭐ 打点计时器实验求加速度的原理' },
  { ch: '第二章 匀变速直线运动', t: '初速度为零的比例式', b: '等时间间隔内位移之比 x₁:x₂:x₃ = 1:3:5:…', n: '前提：初速度为零' },
  { ch: '第二章 匀变速直线运动', t: '自由落体运动', b: 'v = gt，h = ½gt²，v² = 2gh，g ≈ 9.8 m/s²', n: 'g 随纬度升高而增大、随高度升高而减小' },
  { ch: '第二章 匀变速直线运动', t: '竖直上抛运动', b: '上升时间 t↑ = v₀/g，最大高度 H = v₀²/(2g)，全程可看作 a = −g 的匀变速运动', n: '⭐ 上升与下落经过同一点时速度大小相等、方向相反' },

  { ch: '第三章 相互作用——力', t: '重力', b: 'G = mg，方向竖直向下，作用点为重心', n: '重心可以在物体外部（如圆环）' },
  { ch: '第三章 相互作用——力', t: '胡克定律', b: 'F = kx（x 为形变量，不是弹簧总长）', n: '⭐ 易错：题目给的长度要减去原长' },
  { ch: '第三章 相互作用——力', t: '滑动摩擦力', b: 'f = μF_N', n: 'F_N 是接触面间的正压力，不一定等于重力' },
  { ch: '第三章 相互作用——力', t: '静摩擦力', b: '大小由受力平衡决定，0 < f静 ≤ f_max，f_max 略大于滑动摩擦力', n: '⚠️ 静摩擦力不能用 f = μF_N 算' },
  { ch: '第三章 相互作用——力', t: '力的合成（平行四边形定则）', b: '|F₁ − F₂| ≤ F合 ≤ F₁ + F₂', n: '⭐ 合力范围，两力同向最大、反向最小' },
  { ch: '第三章 相互作用——力', t: '力的正交分解', b: 'Fₓ = Fcosθ，F_y = Fsinθ', n: '建立坐标系时让尽量多的力落在坐标轴上' },
  { ch: '第三章 相互作用——力', t: '共点力平衡条件', b: 'F合 = 0，即 Fₓ合 = 0 且 F_y合 = 0', n: '三力平衡时，任意两力的合力与第三力等大反向' },

  { ch: '第四章 运动和力的关系', t: '牛顿第一定律', b: '一切物体总保持匀速直线运动或静止状态，直到有外力迫使它改变', n: '⭐ 惯性是物体的固有属性，只与质量有关，与速度无关' },
  { ch: '第四章 运动和力的关系', t: '牛顿第二定律', b: 'F合 = ma', n: '核心公式④。a 与 F合 同向、同时产生、同时消失' },
  { ch: '第四章 运动和力的关系', t: '牛顿第三定律', b: '作用力与反作用力等大、反向、共线、作用在两个物体上', n: '⚠️ 与平衡力区别：平衡力作用在同一物体上' },
  { ch: '第四章 运动和力的关系', t: '超重与失重', b: '超重：a 向上（加速上升或减速下降），F_N > mg；失重：a 向下，F_N < mg；完全失重：a = g，F_N = 0', n: '⭐ 判断依据是**加速度方向**，不是速度方向' },
  { ch: '第四章 运动和力的关系', t: '连接体问题', b: '整体法求加速度 a = F外/m总，隔离法求内力', n: '先整体后隔离，是解题标准流程' },
];

/* ---------------- 化学 · 必修第一册 ---------------- */
var STUDY_CHEMISTRY = [
  { ch: '第一章 物质及其变化', t: '物质的分类', b: '树状分类法按从属关系分层；交叉分类法从不同角度对同一物质分类。分散系按分散质粒径分：溶液(<1nm)、胶体(1~100nm)、浊液(>100nm)。', n: '⭐ Fe(OH)₃ 胶体的制法：向沸水滴加饱和 FeCl₃ 溶液，加热至红褐色' },
  { ch: '第一章 物质及其变化', t: '胶体的性质', b: '丁达尔效应：光通过胶体形成明亮光路，可用来区分胶体与溶液', n: '⭐ 这是区分胶体和溶液最简单的方法' },
  { ch: '第一章 物质及其变化', t: '电解质与非电解质', b: '电解质：在水溶液中或熔融状态下能导电的化合物（酸、碱、盐、活泼金属氧化物）。非电解质：两种状态下都不导电的化合物（蔗糖、酒精、CO₂）。', n: '⚠️ 单质和混合物既不是电解质也不是非电解质' },
  { ch: '第一章 物质及其变化', t: '离子方程式书写四步', b: '①写（写出化学方程式）②拆（强酸强碱可溶盐拆成离子）③删（删去两边相同的离子）④查（查原子守恒与电荷守恒）', n: '⭐ 只有强电解质且易溶的才拆' },
  { ch: '第一章 物质及其变化', t: '离子共存判断', b: '不能大量共存的情形：生成沉淀、生成气体、生成水、发生氧化还原、生成络合物', n: '常见沉淀：BaSO₄、AgCl、CaCO₃、Fe(OH)₃ 等' },
  { ch: '第一章 物质及其变化', t: '氧化还原反应本质', b: '本质是电子转移（得失或偏移）。特征是元素化合价升降。', n: '⭐ 口诀：升失氧还（化合价升高、失电子、被氧化、作还原剂）' },
  { ch: '第一章 物质及其变化', t: '氧化剂与还原剂', b: '氧化剂：得电子、化合价降低、被还原、生成还原产物；还原剂：失电子、化合价升高、被氧化、生成氧化产物', n: '口诀：剂性一致（氧化剂具有氧化性）' },
  { ch: '第一章 物质及其变化', t: '氧化性还原性比较', b: '氧化性：氧化剂 > 氧化产物；还原性：还原剂 > 还原产物', n: '⭐ 这是判断反应能否发生的依据' },
  { ch: '第一章 物质及其变化', t: '常见氧化剂还原剂', b: '常见氧化剂：O₂、Cl₂、浓硫酸、HNO₃、KMnO₄；常见还原剂：金属单质、H₂、C、CO、SO₂', n: '需记忆典型实例' },

  { ch: '第二章 钠和氯', t: '钠的物理性质', b: '银白色、质软（可用小刀切）、密度比水小比煤油大、熔点低', n: '钠保存在煤油中，隔绝空气和水' },
  { ch: '第二章 钠和氯', t: '钠与氧气反应', b: '常温：4Na + O₂ = 2Na₂O（白色）；点燃：2Na + O₂ →(点燃) Na₂O₂（淡黄色）', n: '⭐ 条件不同产物不同，是常考点' },
  { ch: '第二章 钠和氯', t: '钠与水反应', b: '2Na + 2H₂O = 2NaOH + H₂↑', n: '现象口诀：浮、熔、游、响、红（加酚酞变红）' },
  { ch: '第二章 钠和氯', t: '过氧化钠', b: '2Na₂O₂ + 2H₂O = 4NaOH + O₂↑；2Na₂O₂ + 2CO₂ = 2Na₂CO₃ + O₂', n: '⭐ 可用作供氧剂（潜水艇、呼吸面具）' },
  { ch: '第二章 钠和氯', t: '碳酸钠与碳酸氢钠', b: 'Na₂CO₃（纯碱、苏打）溶解度大、碱性强；NaHCO₃（小苏打）溶解度小、碱性弱，受热易分解：2NaHCO₃ →(Δ) Na₂CO₃ + H₂O + CO₂↑', n: '⭐ 鉴别的两种方法：加热法、滴加稀盐酸比较气泡快慢' },
  { ch: '第二章 钠和氯', t: '焰色试验', b: '钠：黄色；钾：紫色（需透过蓝色钴玻璃观察）', n: '⚠️ 焰色试验是**物理变化**，不是化学变化' },
  { ch: '第二章 钠和氯', t: '氯气的物理性质', b: '黄绿色、有刺激性气味的有毒气体，密度比空气大，可溶于水（1:2）', n: '闻气味要用扇闻法' },
  { ch: '第二章 钠和氯', t: '氯气与金属反应', b: '2Na + Cl₂ →(点燃) 2NaCl（白烟）；2Fe + 3Cl₂ →(点燃) 2FeCl₃（棕褐色烟）；Cu + Cl₂ →(点燃) CuCl₂', n: '⭐ 铁与氯气反应生成 +3 价，不是 +2 价' },
  { ch: '第二章 钠和氯', t: '氯气与水反应', b: 'Cl₂ + H₂O ⇌ HCl + HClO', n: '⭐ HClO 有强氧化性、漂白性、见光分解：2HClO →(光照) 2HCl + O₂↑' },
  { ch: '第二章 钠和氯', t: '氯气与碱反应', b: 'Cl₂ + 2NaOH = NaCl + NaClO + H₂O（漂白液）；2Cl₂ + 2Ca(OH)₂ = Ca(ClO)₂ + CaCl₂ + 2H₂O（漂白粉）', n: '漂白粉有效成分是 Ca(ClO)₂' },
  { ch: '第二章 钠和氯', t: 'Cl⁻ 的检验', b: '取少量待测液，滴加稀硝酸酸化，再滴加 AgNO₃ 溶液，产生白色沉淀则含 Cl⁻', n: '⭐ 加硝酸是为了排除 CO₃²⁻ 等干扰' },
  { ch: '第二章 钠和氯', t: '气体摩尔体积', b: 'V = n × Vm，标准状况(0℃、101kPa)下 Vm = 22.4 L/mol', n: '⚠️ 22.4 L/mol 只适用于**标准状况下的气体**' },
  { ch: '第二章 钠和氯', t: '物质的量浓度', b: 'c = n/V，单位 mol/L', n: '⭐ 配制溶液用容量瓶，定容时视线与刻度线平齐' },

  { ch: '第三章 铁 金属材料', t: '铁与水蒸气反应', b: '3Fe + 4H₂O(g) →(高温) Fe₃O₄ + 4H₂', n: '产物是 Fe₃O₄ 不是 Fe₂O₃' },
  { ch: '第三章 铁 金属材料', t: '铁的氧化物', b: 'FeO（黑色）、Fe₂O₃（红棕色，俗称铁红）、Fe₃O₄（黑色，磁性氧化铁）', n: 'Fe₃O₄ 中铁有 +2 和 +3 两种价态' },
  { ch: '第三章 铁 金属材料', t: '铁的氢氧化物', b: 'Fe(OH)₂ 白色絮状沉淀，极易被氧化：4Fe(OH)₂ + O₂ + 2H₂O = 4Fe(OH)₃（白色→灰绿→红褐色）；Fe(OH)₃ 红褐色沉淀', n: '⭐ 制备 Fe(OH)₂ 要隔绝空气（用长滴管插入液面下）' },
  { ch: '第三章 铁 金属材料', t: 'Fe²⁺ 与 Fe³⁺ 的检验', b: 'Fe³⁺：加 KSCN 溶液变红色；Fe²⁺：加 KSCN 不变色，再滴氯水变红色', n: '⭐ 这是两个离子的标准检验方法' },
  { ch: '第三章 铁 金属材料', t: 'Fe²⁺ 与 Fe³⁺ 的转化', b: '2Fe²⁺ + Cl₂ = 2Fe³⁺ + 2Cl⁻（氧化）；2Fe³⁺ + Fe = 3Fe²⁺（还原）', n: '⚠️ 除杂：FeCl₂ 中有 FeCl₃ 加铁粉；FeCl₃ 中有 FeCl₂ 通氯气' },
  { ch: '第三章 铁 金属材料', t: '铝与氢氧化钠反应', b: '2Al + 2NaOH + 2H₂O = 2NaAlO₂ + 3H₂↑', n: '铝既能与酸又能与强碱反应' },
  { ch: '第三章 铁 金属材料', t: '两性氧化物与氢氧化物', b: 'Al₂O₃ + 6HCl = 2AlCl₃ + 3H₂O；Al₂O₃ + 2NaOH = 2NaAlO₂ + H₂O；Al(OH)₃ 兼具酸碱两性', n: '⭐ Al(OH)₃ 是常见的两性氢氧化物' },

  { ch: '第四章 物质结构 元素周期律', t: '原子结构', b: '质量数 A = 质子数 Z + 中子数 N；核素：具有一定质子数和中子数的一种原子；同位素：质子数相同、中子数不同的核素互称', n: '⭐ 同位素化学性质几乎相同' },
  { ch: '第四章 物质结构 元素周期律', t: '元素周期表结构', b: '7 个周期、16 个族（7 个主族、7 个副族、1 个第Ⅷ族、1 个 0 族）', n: '周期数 = 电子层数；主族序数 = 最外层电子数' },
  { ch: '第四章 物质结构 元素周期律', t: '元素周期律', b: '同周期从左到右：原子半径减小，金属性减弱、非金属性增强；同主族从上到下：原子半径增大，金属性增强、非金属性减弱', n: '⭐ 这是本章最核心的规律，必背' },
  { ch: '第四章 物质结构 元素周期律', t: '化学键', b: '离子键：阴阳离子间的静电作用（如 NaCl）；共价键：原子间通过共用电子对形成（如 HCl）。含离子键的一定是离子化合物。', n: '⚠️ 有共价键的化合物不一定是共价化合物（如 NaOH）' },
];

/* ---------------- 生物 · 必修1 分子与细胞 ---------------- */
var STUDY_BIOLOGY = [
  { ch: '第一章 走近细胞', t: '生命系统的结构层次', b: '细胞 → 组织 → 器官 → 系统 → 个体 → 种群 → 群落 → 生态系统 → 生物圈', n: '⭐ 细胞是最基本的生命系统层次' },
  { ch: '第一章 走近细胞', t: '原核细胞与真核细胞', b: '根本区别：有无以核膜为界限的细胞核。原核生物：细菌、蓝细菌、放线菌、支原体、衣原体。', n: '⚠️ 蓝细菌（蓝藻）无叶绿体但能光合作用' },

  { ch: '第二章 组成细胞的分子', t: '组成细胞的元素', b: '最基本元素：C；含量最多的四种元素：C、H、O、N；含量最多的化合物：水；含量最多的有机物：蛋白质', n: '⭐ 易混点：元素 vs 化合物' },
  { ch: '第二章 组成细胞的分子', t: '水的存在形式与作用', b: '自由水：良好溶剂、运输物质、参与反应；结合水：细胞结构的重要组成成分。自由水/结合水比值越高代谢越旺盛。', n: '⭐ 种子晒干失去的是自由水，烘干失去的是结合水' },
  { ch: '第二章 组成细胞的分子', t: '糖类的分类', b: '单糖（葡萄糖、果糖、核糖、脱氧核糖）、二糖（蔗糖、麦芽糖、乳糖）、多糖（淀粉、纤维素、糖原）', n: '⭐ 蔗糖不是还原糖，不能用于斐林试剂检测' },
  { ch: '第二章 组成细胞的分子', t: '脂质的分类', b: '脂肪（储能、保温、缓冲）、磷脂（构成膜结构）、固醇（胆固醇、性激素、维生素D）', n: '磷脂是构成细胞膜的重要成分' },
  { ch: '第二章 组成细胞的分子', t: '氨基酸与蛋白质', b: '组成蛋白质的氨基酸约 20 种，结构通式：至少含一个氨基(−NH₂)和一个羧基(−COOH)连在同一个碳原子上', n: '⭐ 脱水缩合：n 个氨基酸形成 m 条肽链，脱下 n−m 个水，形成 n−m 个肽键' },
  { ch: '第二章 组成细胞的分子', t: '蛋白质计算', b: '肽键数 = 脱去水分子数 = 氨基酸数 − 肽链数；蛋白质相对分子质量 = 氨基酸总质量 − 水总质量', n: '⭐ 常考计算，注意二硫键会再减 2H' },
  { ch: '第二章 组成细胞的分子', t: '蛋白质的功能', b: '结构蛋白、催化（酶）、运输（血红蛋白）、调节（胰岛素）、免疫（抗体）', n: '口诀：构、催、运、调、免' },
  { ch: '第二章 组成细胞的分子', t: '核酸的结构', b: 'DNA 基本单位脱氧核苷酸（含脱氧核糖、特有碱基 T）；RNA 基本单位核糖核苷酸（含核糖、特有碱基 U）', n: '⭐ DNA 双链、RNA 单链' },
  { ch: '第二章 组成细胞的分子', t: '核酸的功能', b: '核酸是细胞内携带遗传信息的物质，在生物体的遗传、变异和蛋白质的生物合成中具有极其重要的作用', n: 'DNA 主要分布在细胞核，RNA 主要在细胞质' },

  { ch: '第三章 细胞的基本结构', t: '细胞膜的成分', b: '脂质（约 50%，主要是磷脂）、蛋白质（约 40%）、糖类（约 2%~10%）', n: '⭐ 功能越复杂的膜，蛋白质种类和数量越多' },
  { ch: '第三章 细胞的基本结构', t: '细胞膜的功能', b: '①将细胞与外界环境分隔开 ②控制物质进出细胞 ③进行细胞间的信息交流', n: '⭐ 三个功能是简答题高频考点' },
  { ch: '第三章 细胞的基本结构', t: '流动镶嵌模型', b: '磷脂双分子层构成基本支架，蛋白质镶嵌、贯穿或覆盖其中，具有一定的流动性', n: '⭐ 结构特点：流动性；功能特点：选择透过性' },
  { ch: '第三章 细胞的基本结构', t: '线粒体', b: '有双层膜，内膜向内折叠形成嵴，内有基质。是**有氧呼吸的主要场所**，被称为「动力车间」。', n: '⭐ 含有少量 DNA 和 RNA，能半自主复制' },
  { ch: '第三章 细胞的基本结构', t: '叶绿体', b: '有双层膜，内有基粒（类囊体堆叠而成）和基质。是**光合作用的场所**，被称为「养料制造车间」。', n: '⭐ 色素分布在类囊体薄膜上' },
  { ch: '第三章 细胞的基本结构', t: '核糖体', b: '无膜结构，是**蛋白质合成的场所**，被称为「生产蛋白质的机器」', n: '⭐ 唯一无膜的重要细胞器' },
  { ch: '第三章 细胞的基本结构', t: '内质网与高尔基体', b: '内质网：蛋白质加工和脂质合成的「车间」；高尔基体：动物细胞中对蛋白质加工、分类和包装（植物细胞中还与细胞壁形成有关）', n: '⭐ 分泌蛋白路径：核糖体→内质网→高尔基体→细胞膜' },
  { ch: '第三章 细胞的基本结构', t: '溶酶体与液泡', b: '溶酶体：含多种水解酶，能分解衰老、损伤的细胞器，被称为「消化车间」；液泡：内有细胞液，含糖类、无机盐、色素等', n: '成熟植物细胞的大液泡与渗透吸水有关' },
  { ch: '第三章 细胞的基本结构', t: '细胞核的结构', b: '核膜（双层）、核孔（实现核质之间物质交换和信息交流）、核仁（与核糖体形成有关）、染色质（DNA 和蛋白质组成）', n: '⭐ 核孔是大分子进出通道，但 DNA 不出核' },
  { ch: '第三章 细胞的基本结构', t: '细胞核的功能', b: '细胞核是遗传信息库，是细胞代谢和遗传的控制中心', n: '⭐ 四个经典实验：黑白美西螈、伞藻嫁接、蝾螈受精卵横缢、变形虫切割' },

  { ch: '第四章 细胞的物质输入和输出', t: '渗透作用', b: '水分子（或其他溶剂分子）通过半透膜的扩散。条件是：①具有半透膜 ②膜两侧溶液有浓度差', n: '⭐ 水往浓度高的一侧走（指溶质浓度）' },
  { ch: '第四章 细胞的物质输入和输出', t: '成熟植物细胞的吸水', b: '原生质层（细胞膜、液泡膜及两层膜之间的细胞质）相当于半透膜', n: '⚠️ 细胞壁是全透性的，不算半透膜' },
  { ch: '第四章 细胞的物质输入和输出', t: '质壁分离与复原', b: '外界溶液浓度 > 细胞液浓度 → 失水 → 质壁分离；滴加清水 → 吸水 → 质壁分离复原', n: '⭐ 该实验证明：①细胞是活的 ②原生质层具有选择透过性' },
  { ch: '第四章 细胞的物质输入和输出', t: '自由扩散', b: '物质从高浓度到低浓度，不需要载体、不消耗能量。如 O₂、CO₂、H₂O、甘油、乙醇。', n: '速率取决于浓度差' },
  { ch: '第四章 细胞的物质输入和输出', t: '协助扩散', b: '从高浓度到低浓度，需要载体蛋白，但**不消耗能量**。如红细胞吸收葡萄糖。', n: '⚠️ 易错：需要载体≠消耗能量' },
  { ch: '第四章 细胞的物质输入和输出', t: '主动运输', b: '从低浓度到高浓度，需要载体蛋白，**消耗能量**。如小肠吸收葡萄糖、氨基酸。', n: '⭐ 主动运输保证细胞按需要主动选择吸收营养、排出废物' },
  { ch: '第四章 细胞的物质输入和输出', t: '胞吞与胞吐', b: '大分子物质（如蛋白质）通过胞吞/胞吐进出细胞，需要消耗能量，体现细胞膜的流动性', n: '⭐ 自由扩散、协助扩散、主动运输 = 跨膜运输；胞吞胞吐 = 膜泡运输' },

  { ch: '第五章 细胞的能量供应和利用', t: '酶的本质', b: '酶是活细胞产生的具有催化作用的有机物，绝大多数是蛋白质，少数是 RNA', n: '⚠️ 易错：酶不一定都是蛋白质' },
  { ch: '第五章 细胞的能量供应和利用', t: '酶的特性', b: '①高效性 ②专一性 ③作用条件温和（需要适宜的温度和 pH）', n: '⭐ 过酸过碱、高温会使酶永久失活；低温只是抑制，不失活' },
  { ch: '第五章 细胞的能量供应和利用', t: '影响酶促反应速率的因素', b: '温度：有最适温度，过高失活；pH：有最适 pH；底物浓度和酶浓度也会影响', n: '⭐ 作图题高频：注意失活后曲线不可逆' },
  { ch: '第五章 细胞的能量供应和利用', t: 'ATP 的结构与功能', b: 'ATP 中文名三磷酸腺苷，结构简式 A—P~P~P（~ 表示高能磷酸键）。ATP 是细胞的直接能源物质。', n: '⭐ ATP ⇌ ADP + Pi + 能量（转化极快）' },
  { ch: '第五章 细胞的能量供应和利用', t: 'ATP 的合成途径', b: '动物、人、真菌和大多数细菌：细胞呼吸；绿色植物：细胞呼吸和光合作用', n: '⚠️ 绿色植物光合作用产生的 ATP 只用于暗反应（C₃ 还原）' },
  { ch: '第五章 细胞的能量供应和利用', t: '有氧呼吸总反应', b: 'C₆H₁₂O₆ + 6O₂ + 6H₂O →(酶) 6CO₂ + 12H₂O + 能量', n: '⭐ 三个阶段：①细胞质基质 ②线粒体基质 ③线粒体内膜' },
  { ch: '第五章 细胞的能量供应和利用', t: '有氧呼吸三阶段', b: '第一阶段：葡萄糖分解为丙酮酸，产生少量[H]和少量能量；第二阶段：丙酮酸和水反应生成 CO₂ 和大量[H]，少量能量；第三阶段：[H] 与 O₂ 结合生成水，释放大量能量', n: '⭐ O₂ 只在第三阶段参与，CO₂ 只在第二阶段产生' },
  { ch: '第五章 细胞的能量供应和利用', t: '无氧呼吸', b: 'C₆H₁₂O₆ →(酶) 2C₂H₅OH(酒精) + 2CO₂ + 少量能量（酵母菌、植物）；C₆H₁₂O₆ →(酶) 2C₃H₆O₃(乳酸) + 少量能量（人和动物、马铃薯块茎）', n: '⭐ 无氧呼吸只有第一阶段产生少量 ATP' },
  { ch: '第五章 细胞的能量供应和利用', t: '光合作用的色素', b: '叶绿素 a（蓝绿色）、叶绿素 b（黄绿色）、胡萝卜素（橙黄色）、叶黄素（黄色）', n: '⭐ 提取用无水乙醇，分离用纸层析法' },
  { ch: '第五章 细胞的能量供应和利用', t: '光合作用的过程', b: '光反应（类囊体薄膜）：水的光解产生 [H] 和 O₂，同时生成 ATP；暗反应（叶绿体基质）：CO₂ 固定生成 C₃，C₃ 在 [H] 和 ATP 作用下还原成糖类', n: '⭐ 光反应为暗反应提供 [H] 和 ATP' },
  { ch: '第五章 细胞的能量供应和利用', t: '光合作用总反应', b: '6CO₂ + 12H₂O →(光能、叶绿体) C₆H₁₂O₆ + 6O₂ + 6H₂O', n: '⭐ 产物 O₂ 中的氧全部来自水' },
  { ch: '第五章 细胞的能量供应和利用', t: '影响光合作用的因素', b: '光照强度、CO₂ 浓度、温度、水分、矿质元素', n: '⭐ 注意「光照强度—光合速率」曲线的三个关键点：原点、补偿点、饱和点' },

  { ch: '第六章 细胞的生命历程', t: '细胞周期的概念', b: '连续分裂的细胞，从一次分裂完成时开始，到下一次分裂完成时为止。分分裂间期和分裂期，间期约占 90%~95%。', n: '⭐ 只有连续分裂的细胞才有细胞周期' },
  { ch: '第六章 细胞的生命历程', t: '有丝分裂各期特点', b: '间期：DNA 复制和有关蛋白质合成；前期：膜仁消失显两体；中期：形定数晰赤道齐；后期：点裂数加均两极；末期：两消两现重开始', n: '⭐ 口诀助记（两体=染色体、纺锤体）' },
  { ch: '第六章 细胞的生命历程', t: '染色体数与 DNA 数变化', b: '后期着丝点分裂，染色体数暂时加倍，DNA 数不变', n: '⚠️ 易错：复制后 DNA 加倍但染色体数不变' },
  { ch: '第六章 细胞的生命历程', t: '细胞分化的实质', b: '基因的选择性表达，遗传物质没有改变', n: '⭐ 分化不可逆（一般情况）' },
  { ch: '第六章 细胞的生命历程', t: '细胞的全能性', b: '已分化的细胞仍具有发育成完整个体的潜能。受精卵 > 生殖细胞 > 体细胞', n: '经典例证：胡萝卜韧皮部细胞组织培养' },
  { ch: '第六章 细胞的生命历程', t: '细胞衰老的特征', b: '①细胞内水分减少，体积变小 ②酶活性降低 ③色素逐渐积累 ④呼吸速率减慢 ⑤细胞膜通透性改变', n: '口诀助记：一大一小、一多一少、两慢两改' },
  { ch: '第六章 细胞的生命历程', t: '细胞凋亡与坏死', b: '凋亡：由基因决定的细胞自动结束生命的过程，对生物体有利；坏死：由外界因素导致的非正常死亡，对生物体有害', n: '⭐ 凋亡不等于坏死，前者是主动的、程序性的' },
  { ch: '第六章 细胞的生命历程', t: '细胞癌变的原因', b: '原癌基因和抑癌基因发生突变。癌细胞特征：能无限增殖、形态结构发生显著改变、表面糖蛋白减少易扩散转移。', n: '⭐ 致癌因子：物理、化学、病毒三类' },
];

/* ---------------- 英语 · 每日一题（单题选词填空，含解析答案）----------------
   站主指定：「每日一题最好是高校的题目，包括还有解析和答案，这个比较难做，
             你可以先只做英语的选词填空，每次只有一问」
   所以这里每条只有**一问**（一个空），四选一，附答案与解析。
   取材方向：高中英语常见考点（时态、非谓语、定语从句、虚拟语气、
             动词短语、词义辨析等），贴近高考难度。 */
var STUDY_ENGLISH = [  { q: 'By the time you arrive at the station, the train ______.', opts: ['has left', 'left', 'will have left', 'had left'], a: 2, ex: 'by the time 引导的从句用一般现在时表将来时，主句用将来完成时 will have left，表示「到那时已经离开」。' },
  { q: 'The scientist devoted all his life ______ a cure for the disease.', opts: ['to find', 'to finding', 'finding', 'find'], a: 1, ex: 'devote oneself/sth to 中的 to 是介词，后接动名词，故用 to finding。类似结构：look forward to、be used to。' },
  { q: 'It was in the library ______ he first met his future wife.', opts: ['where', 'that', 'which', 'when'], a: 1, ex: '这是强调句型 It was ... that ...，被强调部分是地点状语 in the library，仍用 that。判断技巧：去掉 It was 和 that 后句子仍完整。' },
  { q: 'Not until he failed the exam ______ the importance of hard work.', opts: ['he realized', 'did he realize', 'he had realized', 'has he realized'], a: 1, ex: 'Not until 置于句首时，主句要部分倒装，助动词 did 提前，动词用原形 realize。' },
  { q: 'The project ______ by the time the manager came back.', opts: ['finished', 'has finished', 'had been finished', 'was finishing'], a: 2, ex: 'by the time 引导的从句用过去时，主句表示「过去的过去」用过去完成时；project 是被完成，所以用被动 had been finished。' },
  { q: 'I would rather you ______ tomorrow instead of today.', opts: ['come', 'came', 'will come', 'have come'], a: 1, ex: 'would rather 后接从句时用虚拟语气，谓语用过去式表示对现在或将来的愿望，故用 came。' },
  { q: 'Hardly ______ the office when the phone rang.', opts: ['I had entered', 'had I entered', 'I entered', 'did I enter'], a: 1, ex: 'hardly 置于句首时主句部分倒装；hardly ... when ... 结构中主句用过去完成时，故 had I entered。' },
  { q: 'He is the only one of the students who ______ been to Britain.', opts: ['have', 'has', 'having', 'had'], a: 1, ex: 'the only one of + 复数名词 + who 引导定语从句时，who 指代 the only one，谓语用单数 has。若是 one of 则用复数。' },
  { q: '______ from space, the earth looks like a blue ball.', opts: ['Seeing', 'To see', 'Seen', 'See'], a: 2, ex: 'earth 与 see 是被动关系（地球被看），故用过去分词 Seen 作状语。' },
  { q: 'It is high time that we ______ measures to protect the environment.', opts: ['take', 'took', 'will take', 'have taken'], a: 1, ex: 'It is high time that 从句用虚拟语气，谓语用过去式（或 should + 动词原形），故用 took。' },
  { q: 'The reason ______ he was late was that he missed the bus.', opts: ['why', 'that', 'which', 'because'], a: 0, ex: '先行词 reason 在定语从句中作原因状语，用关系副词 why。注意后面表语从句用 that，不能用 because。' },
  { q: 'No sooner ______ at the airport than the plane took off.', opts: ['he arrived', 'had he arrived', 'he had arrived', 'did he arrive'], a: 1, ex: 'no sooner 置于句首时主句部分倒装，且 no sooner ... than ... 结构用过去完成时，故 had he arrived。' },
  { q: 'She insisted that the meeting ______ put off until next week.', opts: ['is', 'was', 'be', 'will be'], a: 2, ex: 'insist 表示「坚持要求」时，从句用虚拟语气 should + 动词原形，should 可省略，故用 be。若表示「坚持说」则用陈述语气。' },
  { q: 'Only when you work hard ______ your goal.', opts: ['you can achieve', 'can you achieve', 'you achieved', 'did you achieve'], a: 1, ex: 'Only 引导的状语从句置于句首时，主句部分倒装，情态动词 can 提前。注意倒装的是主句不是从句。' },
  { q: 'The little girl ______ the violin is my cousin.', opts: ['played', 'playing', 'to play', 'plays'], a: 1, ex: 'girl 与 play 是主动关系且动作正在进行，用现在分词 playing 作后置定语，相当于 who is playing。' },
  { q: 'I have nothing to do but ______ for the result.', opts: ['waiting', 'wait', 'to wait', 'waited'], a: 1, ex: 'have nothing to do but 后接动词原形（但当 but 前有 do 时，后面不加 to），故用 wait。' },
  { q: '______ I explained the problem twice, he still didn\'t understand.', opts: ['Although', 'Because', 'Unless', 'Since'], a: 0, ex: '前后句是让步关系（虽然……但是），用 Although。注意英语中 although 不能与 but 连用。' },
  { q: 'The house ______ windows face south is very warm in winter.', opts: ['which', 'that', 'whose', 'where'], a: 2, ex: '先行词 house 与 windows 是所属关系，用关系代词 whose 作定语，相当于 of which the windows。' },
  { q: 'He suggested ______ the meeting to next Monday.', opts: ['to put off', 'putting off', 'put off', 'puts off'], a: 1, ex: 'suggest 表示「建议」时后接动名词；表示「暗示」时才接从句。类似：admit、avoid、consider、enjoy。' },
  { q: 'It was not until midnight ______ he finished his homework.', opts: ['that', 'when', 'which', 'since'], a: 0, ex: 'not until 的强调句型固定为 It was not until ... that ...，被强调部分即使含 not until 也用 that。' },
  { q: 'If I ______ you, I would take the job without hesitation.', opts: ['am', 'was', 'were', 'be'], a: 2, ex: '与现在事实相反的虚拟条件句，从句谓语用过去式，be 动词一律用 were，主句用 would + 动词原形。' },
  { q: 'He ______ in the rain for two hours when we found him.', opts: ['stood', 'has stood', 'had been standing', 'is standing'], a: 2, ex: '表示「过去某个时间点之前一直持续的动作」，用过去完成进行时 had been standing。' },
  { q: 'The book ______ cover is red belongs to my brother.', opts: ['which', 'that', 'whose', 'of which'], a: 2, ex: '先行词 book 与 cover 是所属关系，用 whose 引导定语从句作定语。of which 需写成 the cover of which。' },
  { q: 'It is important that every student ______ the school rules.', opts: ['obeys', 'obey', 'obeyed', 'will obey'], a: 1, ex: 'It is important/necessary/essential that 从句用虚拟语气 should + 动词原形，should 可省略，故用 obey。' },
  { q: '______ hard, and you will succeed sooner or later.', opts: ['Working', 'To work', 'Work', 'Worked'], a: 2, ex: '「祈使句 + and + 陈述句」结构中，前半部分用动词原形开头的祈使句，故用 Work。' },
  { q: 'The number of students in our school ______ increasing year by year.', opts: ['are', 'is', 'have been', 'were'], a: 1, ex: 'the number of 意为「……的数量」，作主语时谓语用单数；a number of 意为「许多」，谓语用复数。' },
  { q: 'He would have come to the party, but he ______ busy.', opts: ['was', 'were', 'had been', 'has been'], a: 0, ex: 'but 后接陈述语气表示真实情况（他当时确实忙），所以用过去式 was。前面 would have come 是虚拟语气。' },
  { q: 'The teacher asked us to write a ______ report on the experiment.', opts: ['five-thousand-word', 'five-thousands-word', 'five thousand words', 'five-thousands-words'], a: 0, ex: '数词 + 名词作定语构成复合形容词时，名词用单数且加连字符，故为 five-thousand-word。' },
  { q: 'Much ______ my surprise, he passed the exam easily.', opts: ['to', 'in', 'at', 'for'], a: 0, ex: 'to one\'s surprise 意为「令某人惊讶的是」，much 用来加强语气，故用 to。类似：to one\'s joy/delight。' },
  { q: 'Neither of the two answers ______ correct.', opts: ['are', 'is', 'were', 'have been'], a: 1, ex: 'neither of + 复数名词作主语时，谓语用单数 is。类似：either of、each of。' },
];

/* 汇总成 STUDY_DATA 供学习卡片取用（四类内容都在这里找） */
var STUDY_DATA = {
  physics:   STUDY_PHYSICS,
  chemistry: STUDY_CHEMISTRY,
  biology:   STUDY_BIOLOGY,
  english:   STUDY_ENGLISH
};

var SITE_DATA = {
  /* 班级公众号二维码（公告栏旁「公众号」按钮弹出） */
  qrUrl: "qrcode.jpg",
  /* 仓库地址（公告栏旁「仓库」按钮跳转）
     注意：Gitee Pages 已于 2024 年永久下线，站点主链接走 GitHub Pages，
     源码也以 GitHub 仓库为准，所以这里指向 GitHub。 */
  repoUrl: "https://github.com/yuzikaaang/class-site",
  /* 复制链接：只保留主链接（唯一入口）。
     历史：Gitee Pages 已于 2024 年永久下线，旧的 Gitee 备用链接早失效；
     WorkBuddy 静态托管那条备用入口也已取消 —— 微信内打不开，反而容易误导同学。
     现在全站只有 GitHub Pages 一个入口。 */
  siteLinks: [
    { label: "主链接", url: "https://yuzikaaang.github.io/class-site/", note: "微信内可直接打开。建议「添加到主屏幕」当 App 用。" }
  ],
  /* ── 通用弹窗引擎（第二十七轮新增）──
     一个数组统领全站弹窗：开屏弹 + 板块弹。默认是空数组，
     什么都不配时**行为与以前完全一致**（不弹任何新窗口）。

     每条字段：
       id      —— 唯一标识。换内容就改 id，之前关过的同学会重新收到。
       scope   —— 播放时机：
                    'boot'   = 进站开屏弹（与其它弹窗排队，不叠）
                    'cat:2'  = 进入板块 2 时弹（数字 = 板块 id）
       source  —— 内容来源，复用站内已有数据，不用重复维护：
                    'announcements'    取最新一条（important 置顶优先）
                    'homework_notice'  取作业通知（同 hwPopGet）
                    'custom'           用本条里的 title/body/video/image
       title   —— source='custom' 时的标题
       body    —— source='custom' 时的正文，\n 换行
       video   —— 可选，B站分享链接或 mp4 直链 → 弹窗内嵌视频
       image   —— 可选，图片直链 → 弹窗内展示图片
       linkText / linkUrl —— 可选，底部按钮（留空不显示）
       startAt / endAt     —— 可选，时间窗（"2026-10-13T08:00:00"），窗内才弹
       dismiss —— 关闭后行为：
                    'daily'  当天不再弹，次日恢复（默认）
                    'once'   只弹一次，以后永不自动弹
                    'always' 每次进站/进板块都弹
       bubble  —— true = 关掉后右下角留悬浮球，可随时点开重看（默认 true）

     站主用法：想弹什么就往下面数组加一条即可；不用了删掉那条。 */
  popups: [
    /* 示例（默认注释，需要时把注释去掉并改内容即可生效）：
    { id:'boot-hw',  scope:'boot',  source:'homework_notice', dismiss:'daily',  bubble:true },
    { id:'boot-notice', scope:'boot', source:'announcements',  dismiss:'once',   bubble:true },
    { id:'anniv', scope:'cat:2', source:'custom',
      title:'🎉 ClassIsland 三周年', body:'点击下方按钮查看官方纪念短片。',
      video:'https://www.bilibili.com/video/BV1sJe36ZEb9/',
      dismiss:'daily', bubble:true },
    */
  ],
  /* ── 班级活动通知（启用后进站自动弹窗；弹窗关掉后留一个悬浮球，
        点悬浮球可随时重新打开，**到 endAt 活动结束后弹窗与悬浮球都不再出现**）──
     站主用法：有活动时把 enabled 改成 true，填 title / body / endAt 即可：
       id      —— 换一场新活动就改个新 id，让之前关过弹窗的同学也会重新收到通知
       title   —— 弹窗标题
       body    —— 活动说明，\n 换行
       startAt —— 可选，到点才开始弹（留空=立即开始）
       endAt   —— 活动结束时间（如 "2026-09-05T18:00:00"），到点后自动撤掉悬浮球
       linkText / linkUrl —— 可选，底部按钮（留空则不显示按钮） */
  activity: {
    enabled: false,
    id: "act-2026-autumn",
    title: "🎉 班级活动",
    body: "这里写活动说明，支持换行。\n第二行内容。",
    startAt: "",
    endAt: "",
    linkText: "",
    linkUrl: ""
  },
  /* ── 板块庆祝视频（**不占卡片位**；进入指定板块时自动弹出视频弹窗）──
     站主用法：想在某板块做庆祝/预告，把 enabled 改成 true 并填好字段即可；不用了改回 false。
       enabled —— 总开关（false 时既无横幅也无弹窗，等于不存在）
       categoryId —— 进入哪个板块时弹出（2 = 大屏服务）
       title / desc —— 弹窗标题 / 横幅与弹窗里的说明文字，\n 换行
       video —— B站分享链接（含 BV 号）或云端/直链（mp4 等）
       bannerText —— 板块顶部横幅文字
       everyTime —— true = 每次进该板块都弹；false = 关掉后本次不再弹（悬浮球仍可重看） */
  celebrate: {
    enabled: true,
    categoryId: 2,
    title: "🎉 ClassIsland 三周年纪念",
    desc: "🎉 庆祝班级课表 ClassIsland 三周年（2023 → 2026）！\n点击「📱 横屏查看」把手机横过来，画面更大更清楚。",
    video: "https://www.bilibili.com/video/BV1sJe36ZEb9/",
    bannerText: "🎉 ClassIsland 三周年纪念 · 点击看官方纪念短片",
    everyTime: true
  },
  /* 通讯录数据已于 2026-10-05 全部迁到后端数据库（api/profile.js + profiles 表）。
     此处原先存放姓名哈希与 XOR 密文，但密钥就在同一份 JS 里，等于公开，
     已彻底移除。详见 internal/notes.md 的「隐私改造」记录。 */
/* ── 班级公告（新的放最上面，important:true 为置顶高亮）── */
  announcements: [
    { date: "2026-10-17 20:30", text: "🔒 存量资料一键加密（v3.5.1）：加密上线前导入的资料不用再手动重导了 —— 后台「成员与档案」新增「🔒 一键加密存量」按钮，点一下自动分批把老资料转成密文，带进度条、断了能接着跑、重复点也不会重复加密。另外修了两个问题：① 学科热力图点开的明细里，「班内排名」之前误用了年级排名（比如校排 350 显示成班排 350），现在班内名次按本班实际成绩重新算，年级排名单独一行摆着；② 「需关注学生」表格适配手机端，一人一张卡片，列名齐全，不再挤成一团。", category: "site" },
    { date: "2026-10-17 18:20", text: "🔒 成员档案全量加密（v3.5.0）：姓名、学号、政治面貌、智学网账号、微信、QQ、手机号、身份证号、团员编号以及后台自定义的所有字段，现在全部以 AES-256-GCM 密文存进数据库 —— 直接打开数据库看到的是 <code>enc:v1:...</code> 这样的乱码，看不到任何真实信息。密钥就是你后台「秘钥管理」里那把 ADMIN_SECRETS_KEY（和令牌库同一把，不用另外配）。后台和前台照常显示明文，查询、认领、导入导出都不受影响。⚠️ 存量资料是「谁保存过、谁就转成密文」，没动过的仍是明文，慢慢会全部转完；⚠️ 密钥千万别删，删了就解不开了。", category: "site" },
    { date: "2026-10-17 16:50", text: "🔐 字段管理新增「仅管理员」可见级别（v3.4.1）：某些敏感字段（如身份证号、家庭信息）现在可以设为只有你在后台能看到 —— 前台查询里连本人都看不到，连键都不会下发。新增字段、快捷切换、单人例外三处都能选这一档。", category: "site" },
    { date: "2026-10-17 15:30", text: "⚔️ 成绩分析更新（v3.4.0）：①「成绩对比」可以再选一场考试放在一起比（最多 2 场），新增「跨考试进退步」表——两位同学的总分 / 班排 / 年级排名 / 各科分数逐项对比，进步退步一目了然，总分柱下也补了年级排名；② 个人画像「各科进退步」只固定科目列了，第一次考试那一列不再被误固定（进退步榜、需关注等表同样修好）；③ 年级排名各处都标注了是「物理方向」的年级排名，不是全校；④「历次上线率」开放给管理员查看；⑤ 页面顶部加了小横幅：成绩由人工手动录入，若有错误请联系管理员修改；⑥ 后台「新增字段」弹窗修复了不居中的问题。", category: "site" },
    { date: "2026-10-17 13:41", text: "📊 成绩分析三处改动（v3.3.0）：①「需关注学生」不再只看总分，某一科拖后腿也会被单独点名（表格里直接写「化学 60 −30.2」，并标出是「仅单科」还是总分也不达标）；②「进退步榜」把进步和退步合成一张表，全部同学都在里面，点表头就能排序（名次、变化、分数都能排），班级 / 年级 / 单科三种筛选照旧；③「学生 × 科目热力图」手机端点任意一格就能看这个人的明细，再点一次收起。", category: "site" },
    { date: "2026-10-17 12:05", text: "📉 「我的画像 → 各科趋势」现在能看<b>名次</b>了：右上角切「分数 / 名次」，名次视角下折线越靠上就是名次越前，每张卡直接写「第几 名 / 全年级人数」和「较上次 名次升/降多少」，本次分数也保留在下面。哪次没导入年级排名会写「暂无名次」。", category: "site" },
    { date: "2026-10-17 11:29", text: "🔧 修好了分享的一个毛病：以前点「编辑」改分享范围，保存后其实没生效（页面读到的还是旧弹窗里的选项）。现在编辑保存会真正生效，链接不变；而且改范围时不会再把已经勾好的「成绩单 / 个人成绩卡」清掉。", category: "site" },
    { date: "2026-10-17 10:48", text: "📈 「我的画像」新增「各科进退步」：最近几次考试，每科的分数和年级排名逐次列出，还标出分数增减、名次升降和稳定性（波动大小）。分享出去的成绩页也能看到这张表。", category: "site" },
    { date: "2026-10-17 10:47", text: "🔗 成绩分享升级：分享页除了每次成绩的具体分值、各科小分和上线情况，现在还多了「历史总分趋势」和「年级排名变化」两张图；「成绩单」和「个人成绩卡」可以同时展示。已建过的分享也能直接改范围，链接不变，不用重新发。", category: "site" },
    { date: "2026-10-17 10:45", text: "🔐 成绩发布更灵活：老师现在可以把某次成绩只发给指定同学，或发给全班。被指定的同学登录就能看到，其他同学不会看到那次考试。", category: "site" },
    { date: "2026-10-17 10:30", text: "📊 「我的画像」升级：六科画像除了雷达图，还多了一张数值表 —— 每科都能看到「我的分数 / 占总分比例 / 班均 / 与班均差」，一眼看清自己强在哪、差多少。另外，切到「总分原始」口径时，化学、生物不再显示「赋分」标签，也不会再和特控 / 本科 / 600 线硬比（那三条线是按赋分总分划的）。", category: "site" },
    { date: "2026-10-11 17:18", text: "📚 首页新增「学习卡片」：和「每日一言」一样每次刷新随机出一条 —— 物理 / 化学 / 生物 知识点公式，或英语选词填空（带答案解析），也能联网抓「每日一词」和「古诗文」。想只留某几类，去「自定义设置」里勾。", category: "site" },
    { date: "2026-10-11 17:12", text: "🎲 「每日一言」改为完全随机切换，不再按日顺序轮播；同时接入网络名言库，联网时会自动换一句。", category: "site" },
    { date: "2026-10-11 17:06", text: "🛠 后台公告支持手动改发布时间，旁边加了「填入当前时间」按钮，时间填错也能自己修正。", category: "site" },
    { date: "2026-10-11 17:05", text: "🎨 自定义设置新增「主题自动切换」，可选：关闭自动 / 跟随系统 / 跟随日出日落。选「跟随日出日落」会按当地真实日出日落时间自动切换亮暗，离线时用本地计算兜底。", category: "site" },
    { date: "2026-10-11 13:20", text: "🔧 修复：登录滑块验证码「拖到底也提示不匹配」的问题 —— 拼图块现在能正确嵌入缺口了。", category: "site" },
    { date: "2026-10-11 12:00", text: "🎨 全站图标统一升级：所有 emoji 全部换成 Lucide 图标，倒计时不再闪动。", category: "site" },
    { date: "2026-10-11 11:50", text: "🔒 登录新增滑块安全验证，进一步保护你的账号。", category: "site" },
    { date: "2026-10-11 11:40", text: "📡 在线状态改为实时检测（每分钟双向心跳），管理后台能准确看到谁在线。", category: "site" },
    { date: "2026-10-11 11:30", text: "💡 连不上服务器时，页面顶部会提示你切换网络或改用流量，此期间显示的是本地缓存。", category: "site" },
    { date: "2026-09-30 15:56", text: "🎉 国庆假期作业已发布", category: "activity" },
    { date: "2026-09-29 23:02", text: "📅 第一次段考时间已公布：10月13日—14日。\n各科考试范围可在「重要日期倒计时」→「查看全部」→「查看考试范围」中查看。", category: "activity" },
    { date: "2026-09-27 09:32", text: "🎨 新增自定义设置：排序、字号、背景", category: "site" },
    { date: "2026-09-26 17:50", text: "界面换回暖橙新装，更清爽啦。", category: "site" },
    { date: "2026-09-26 16:43", text: "🔓 站内入口已免密码，直接进入即可。", category: "site" },
    { date: "2026-09-26 15:38", text: "🎧 新增英语听力音频，可在「作业查看」里直接点击播放。", category: "site" },
    { date: "2026-09-24 23:25", text: "🔣 全站图标统一为 Lucide 一套，含小游戏", category: "site" },
    { date: "2026-09-24 22:52", text: "📇 升级为「个人资料查询」，新增政治面貌", category: "site" },
    { date: "2026-09-24 13:40", text: "🌕 中秋假期作业已发布，六科全齐", category: "site" },
    { date: "2026-09-07 12:57", text: "【班级通知】因网络问题，「学习资料」板块中的课堂笔记与教学课件暂时关闭，恢复开放时间另行通知，给大家带来的不便敬请谅解。", category: "site" },
    { date: "2026-08-31 18:26", text: "📌 「报到」日期（8/31 18:00）已过，首页「重要日期倒计时」中的「报到」项已隐藏；当前面板仅显示「寒假」倒计时。", category: "site" },
    { date: "2026-08-30 23:36", text: "📊 已接入匿名访问统计，不收集个人信息", category: "site" },
    { date: "2026-08-30 18:50", text: "🎲 点歌抽签优化：自动排除已播/已排期", category: "site" },
    { date: "2026-08-30 16:05", text: "🎲 点歌抽签新增「每人限一首」，更公平", category: "site" },
    { date: "2026-08-29 18:10", text: "🔤 修复密码框打不出中文的问题", category: "site" },
    { date: "2026-08-29 16:20", text: "📌 公告分类调整，数据导出改为加密", category: "site" },
    { date: "2026-08-29 15:20", text: "🔗 备用链接已上线，主链打不开时用", important: true, importantUntil: "2026-08-29T18:00:00", category: "activity" },
    { date: "2026-08-29 00:40", text: "🎟️ 点歌券防重复，每周每人一张", category: "site" },
    { date: "2026-08-29 00:30", text: "⚠️ 原 Gitee Pages 备用入口已失效", category: "site" },
    { date: "2026-08-28 23:15", text: "🖥️ 电脑端小游戏改为当前页打开", category: "site" },
    { date: "2026-08-28 22:30", text: "🔐 站里藏着隐藏空间，自己找找看", category: "misc" },
    { date: "2026-08-28 22:18", text: "🎟️ 点歌券规则升级，门槛下调", category: "site" },
    { date: "2026-08-28 14:50", text: "👁️ 修复倒计时文字看不清的问题", category: "site" },
    { date: "2026-08-28 10:00", text: "👁️ 优化全站文字对比度，更清晰", category: "site" },
    { date: "2026-08-27 00:46", text: "💬 学习资料「访问提示」悬浮球调整：仅在学习资料板块内显示，离开板块后自动消失。", category: "site" },
    { date: "2026-08-27 00:28", text: "✨ 全站视觉升级，动画更顺滑", category: "site" },
    { date: "2026-08-27 00:21", text: "🌙 新增夜间自动暗色模式", category: "site" },
    { date: "2026-08-27 00:13", text: "📌 公告支持按日期筛选与隐藏", category: "site" },
    { date: "2026-08-26 23:27", text: "💾 新增「全部清理」，一键清空本机数据", category: "site" },
    { date: "2026-08-26 10:52", text: "💾 新增「数据管理」，可导出导入", category: "site" },
    { date: "2026-08-26 10:25", text: "🔄 返回时自动回到刚才的页面", category: "site" },
    { date: "2026-08-26 10:12", text: "🎁 悄悄说一句：站内藏着彩蛋和隐藏空间，说不定哪天就被你碰上了～（线索就藏在日常交互里，自己去探索才有意思）", category: "misc" },
    { date: "2026-08-26 09:55", text: "🔔 新增音效反馈，侧边栏可关闭", category: "site" },
    { date: "2026-08-26 00:45", text: "🔒 密码增加防爆破，输错会短暂锁定", category: "activity" },
    { date: "2026-08-25 22:58", text: "🎋 新增「今日班级签」，每天可抽一次", category: "activity" },
    { date: "2026-08-25 21:55", text: "📝 新增「意见反馈」，可匿名填写", category: "class" },
    { date: "2026-08-25 20:41", text: "📦 新增「仓库」按钮，可查看源码", category: "site" },
    { date: "2026-08-25 20:03", text: "🔧 修复分类页验证后整页空白的问题", category: "site" },
    { date: "2026-08-25 19:50", text: "🔧 修复资料类入口点击无反应的问题", category: "site" },
    { date: "2026-08-25 19:39", text: "🔧 修复密码输入无反应的问题", category: "site" },
    { date: "2026-08-25 19:22", text: "📝 作业查看恢复 Classworks 直达入口", category: "site" },
    { date: "2026-08-25 19:11", text: "📲 新增「安装为应用」教程", category: "activity" },
    { date: "2026-08-25 17:30", text: "📣 公告支持按分类筛选", category: "site" },
    { date: "2026-08-25 17:14", text: "🔗 主链接已切换为 GitHub Pages", important: true, importantUntil: "2026-08-25T19:14:00", category: "site" },
    /* 2026-09-30 站主要求：这条不再永久置顶。置顶靠 important:true 且无 importantUntil 实现，
       直接删掉会连历史记录一起丢，所以只取消置顶、保留条目，仍可在活动分组里翻到。 */
    { date: "2026-08-25 16:46", text: "【班级通知】Classworks 暂无法连接服务器，作业以老师线下布置为准。", category: "activity" },
    { date: "2026-08-25 16:46", text: "📌 公告分组调整，新增多项小功能", category: 'site' },
    { date: "2026-08-25 16:19", text: "🔧 修复日报排版与首次密码报错", category: 'site' },
    { date: "2026-08-25 16:13", text: "修复每日日报卡片空白问题；班级公告时间统一为「精确到分」。", category: 'site' },
    { date: "2026-08-25 15:30", text: "每日日报已切换为外部热点聚合站；修复重要日期弹窗倒计时不走秒；新增「导出备份」功能（站内密码验证后下载完整版 zip）。", category: 'site' },
    { date: "2026-08-23 12:37", text: "修复倒计时时/分/秒不实时刷新的问题。", category: 'site' },
    { date: "2026-08-23 12:33", text: "修复倒计时实时刷新；其他工具新增番茄时钟。", category: 'site' },
    { date: "2026-08-23 12:24", text: "首页改版：应用入口移至侧边栏；法定节假日已备至 2028 年 6 月。", category: 'site' },
    { date: "2026-08-23 12:09", text: "倒计时重做：精确到月天，点击面板可查看全部重要日期 / 全部法定节假日。", category: 'site' },
    { date: "2026-08-23 12:00", text: "新增暗黑模式：点击页头左上角的月亮/太阳图标即可切换。", category: 'site' },
    { date: "2026-08-23 11:39", text: "站点新增入口问答；私人云盘已接入访问密码验证。", category: 'site' },
    { date: "2026-08-23 11:34", text: "点歌平台与听歌平台用途说明已修正；其他工具入口文案优化。", category: 'site' },
    { date: "2026-08-23 11:31", text: "点歌平台说明已更新；其他工具新增「私人云盘」占位入口。", category: 'site' },
    { date: "2026-08-23 11:25", text: "板块整理：新增「班级事务」「其他工具」，每日日报移至首页公告下方。", category: 'site' },
    { date: "2026-08-23 11:16", text: "联系方式已更新为班级通讯录（含学号与职位），欢迎查询。", category: 'site' },
    { date: "2026-08-23 11:04", text: "联系方式调整：出于隐私保护，站内不再提供电话、微信、QQ 等个人联系方式，需要请联系班主任。", category: 'site' },
    { date: "2026-08-23 10:58", text: "学习资料问答与联系方式已升级为加密存储，数据更安全。", category: 'site' },
    { date: "2026-08-23 10:53", text: "已新增联系人，可在「其他」-「联系方式」中查询。", category: 'site' },
    { date: "2026-08-23 10:48", text: "新增「其他」板块：联系方式、情况反映、建言献策、排行榜、班级活动。", category: 'site' },
    { date: "2026-08-23 10:42", text: "学习资料问答题目已更新，如有通过记录失效请重新答题。", category: 'site' },
    { date: "2026-08-23 10:36", text: "修复课堂笔记、教学课件网盘链接，欢迎重新查看。", category: 'site' },
    { date: "2026-08-23 10:29", text: "新增「学习资料」板块：课堂笔记、教学课件，答对班级小问题即可获取网盘链接与访问码。", category: 'site' },
    { date: "2026-08-23 10:09", text: "每日日报入口已更新，班级应用新增 EchoMusic 听歌平台。", category: 'site' },
    { date: "2026-08-23 00:22", text: "经过我这么久的调试这个网站终于有点雏形在了！(╥╯﹏╰╥)ง", category: 'misc' },
    { date: "2026-08-22 00:00", text: "点歌平台入口已开放！微信内无法直接访问，点击「前往入口」后请按引导用浏览器打开。", category: 'site' },
    { date: "2026-08-22 00:00", text: "班级服务站 2.0 上线：新增公告栏；站点可在微信内直接打开，部分国外站点会自动引导用浏览器访问。", category: 'site' },
  ],
  /* ── 开屏通知弹窗：大假作业发布提醒（在 start~end 期间打开网站自动弹出；可「不再显示」）── */
  homeworkNotice: {
    enabled: true,
    id: "hw-2026-guocing",
    start: "2026-10-01",
    end: "2026-10-07",
    hwTitle: "🎉 国庆假期作业（10.1–10.7）",
    title: "作业已发布",
    text: "",
    goTo: 1
  },
  /* ── 大假作业记录（由站主手动同步；平常小作业不展示）── */
  holidayHomeworks: [
    {
      id: "hw-2026-summer",
      start: "2026-08-25",
      end: "2026-08-27",
      title: "2026 暑假作业",
      isDemo: true,
      items: [
        { subject: "语文", tasks: ["1. 理解性默写", "2. 试卷1份（附答题卡）", "3. 小说训练1份"] },
        { subject: "数学", tasks: ["1. 试卷2份", "2. 同步练习写至p174"] },
        { subject: "英语", tasks: ["1. 周报×2（33、36两期）", "2. 英语单词打卡", "3. 自己买的练习册"] },
        { subject: "物理", tasks: ["1. 试卷×4", "2. 同步练习p95-100", "3. 校本p8-9"] },
        { subject: "化学", tasks: ["1. 试卷2份"] },
        { subject: "生物", tasks: ["1. 试卷×2", "2. 笔尖上的生命密码写至p104", "3. 生物同步练习p59-68 1-6"] },
        { subject: "其他", tasks: ["1. 错题整理"] }
      ]
    },
    {
      id: "hw-2026-zhongqiu",
      start: "2026-09-24",
      end: "2026-09-27",
      title: "🌕 中秋假期作业（9.24–9.27）",
      items: [
        { subject: "语文", tasks: ["同步练习第二单元写完以及 p1-p8", "文言梳理没写完的写完", "背诵《将进酒》", "答题卡练字一张"] },
        { subject: "数学", tasks: ["同步练习写到 p43", { text: "课上要求做的两道练习题", img: "./homework/zhongqiu-yuwen.jpg" }, "滚动练习（一）", "单元卷"] },
        { subject: "英语", tasks: [{ text: "试卷一张（要写大作文）", audio: "https://videotourl.com/audio/1790407224072-9b1a37fc-417d-4c39-ad08-091787a1be6f.mp3", audioLabel: "播放听力音频" }, "单词练习一整本写完", "考试完形填空的错题整理"] },
        { subject: "物理", tasks: ["试卷 2 张", "预习课本第 11 章第 3 节「实验：测量导体的电阻率」（可借助导学案预习，课后习题要做）"] },
        { subject: "化学", tasks: ["试卷 1 张"] },
        { subject: "生物", tasks: ["同步练习写至 p66（先写选修一，再写必修二剩下的）"] }
      ]
    },
    {
      id: "hw-2026-guocing",
      start: "2026-10-01",
      end: "2026-10-07",
      title: "🎉 国庆假期作业（10.1–10.7）",
      items: [
        { subject: "语文", tasks: [
          "语文小练（A4 纸）：共 5 张",
          "作文训练 ×2（一张 A4）",
          "答题卡练字：写一面（不是一页）",
          "同步练习 p9–19"
        ] },
        { subject: "数学", tasks: [
          "同步练习 p45–54",
          "试卷 2 张"
        ] },
        { subject: "英语", tasks: [
          { text: "试卷 1 张（要写小作文）", audio: "https://videotourl.com/audio/1790831516084-d409a7b4-57c4-4e84-a092-9c994b703b27.mp3", audioLabel: "播放听力音频" },
          "自购英语阅读：写到老师折的那一处",
          "每天英语打卡"
        ] },
        { subject: "物理", tasks: [
          "同步练习 p36–42",
          "第三周练习试卷",
          "第五周练习试卷",
          "第十章专题提升试卷（背面为电场）",
          "国庆试卷"
        ] },
        { subject: "化学", tasks: [
          "同步练习 p56–68",
          "试卷 2 张（无答题卡）"
        ] },
        { subject: "生物", tasks: [
          "同步练习（待发，返校自习时补做）"
        ] }
      ]
    }
  ],
  categories: [
    { id: 1, name: "常用服务" },
    { id: 3, name: "成绩分析" },
    { id: 7, name: "班级事务" },
    { id: 8, name: "其他工具" },
    /* 2026-10-16 v2.10.0：站主要求「大屏服务」下移到【其他工具】分类下方 */
    { id: 2, name: "大屏服务" },
    /* 2026-10-16 v2.10.0：站主要求隐藏侧边栏【学习资料】按钮。
       active:false = uiCats() 直接过滤掉，入口不再渲染；
       数据保留（链接/暂停文案还在），以后想恢复只需删这个标记。 */
    { id: 5, name: "学习资料", active: false },
    { id: 9, name: "📲 安装为应用" }
  ],
  links: [
    {
      id: 1,
      categoryId: 1, title: "点歌平台", subtitle: "VoiceHub", icon: "./icons/pmxXJkq.png",
      desc: "线上点歌平台：点击下方按钮进入，点播你想听的歌曲。\n本平台由 VoiceHub 提供技术支持\n初始账号：学号（如 250501），默认密码：生日（如 20250901）\n💡 服务器配置有限，没有立即跳转请耐心等待几秒",
      mainLabel: "前往入口", mainUrl: "https://xsyzc2505.dpdns.org/", mainWechatOk: false,
      extraLabel: "", extraUrl: "", extraWechatOk: true
    },
    {
      id: 2,
      categoryId: 1, title: "作业查看", subtitle: "Classworks", icon: "./icons/pmxX87n.png",
      desc: "周作业及假期作业均可在线查看。\n使用教程：点击页面中的「已注册」，即可自动登录。\n若未显示当周作业，请跳转到布置作业的当天重新查看。",
      cardTip: "⚠️ 因校园网限制，班级电脑端的 Classworks 连不上服务器、无法同步到云端供大家查看，故站内作业为站主手动同步。如需尝试直接访问原站，可点「🌐 前往 Classworks」。",
      customActions: [
        { label: "🌐 前往 Classworks", onclick: "openClassworks()", style: "gray" },
        { label: "📝 查看当前作业", onclick: "showCurrentHomework()" },
        { label: "📅 历史作业（日期）", onclick: "showHomeworkCalendar()" }
      ]
    },
    {
      id: 3,
      categoryId: 2, title: "班级课表", subtitle: "ClassIsland", icon: "./icons/pmxjpEn.png",
      desc: "开源智能大屏课表系统，\n实时展示当日课程、上下课倒计时与提醒，\n支持多周轮换课表与临时调课功能。",
      mainLabel: "前往官方页面", mainUrl: "https://www.classisland.tech/", mainWechatOk: true,
      extraLabel: "", extraUrl: "", extraWechatOk: true
    },
    {
      id: 4,
      categoryId: 2, title: "屏幕批注", subtitle: "ICC-CE", icon: "./icons/pmz6J6U.png", active: false,
      desc: "智能课堂绘图增强工具，\n专为教师打造高效交互式绘图解决方案，\n支持智能笔迹处理、PPT 实时标注、多点触控手势与高度自定义设置。",
      mainLabel: "前往官方页面", mainUrl: "https://cjk-is-so-cute.netlify.app/", mainWechatOk: false,
      extraLabel: "", extraUrl: "", extraWechatOk: true
    },
    {
      id: 5,
      categoryId: 2, title: "听歌平台", subtitle: "EchoMusic", icon: "./icons/pnpe3ff.png",
      desc: "音乐课等课上播放歌曲的桌面播放器，\n支持歌单分享、歌词同步、主题换肤与多平台音乐导入，\n可在教室电脑安装使用，课上一起听歌更自在。",
      mainLabel: "查看项目", mainUrl: "https://github.com/hoowhoami/EchoMusic", mainWechatOk: false,
      extraLabel: "", extraUrl: "", extraWechatOk: true
    },
    {
      id: 6,
      categoryId: 5, title: "课堂笔记", icon: "", iconText: "笔记", paused: true,
      pausedMsg: "📌 以后查看课堂笔记 / 课件，请线下在班上大屏查看。",
      desc: "经多方对比，课件资源存储于天翼云盘。\n需登录天翼云盘网页端，无需安装客户端，下载基本不限速。\n笔记为截图，可在线预览，加载卡顿建议下载查看。\n打不开可复制链接至浏览器打开（微信页面可能存在兼容问题）。",
      mainLabel: "", mainUrl: "", mainWechatOk: true,
      extraLabel: "", extraUrl: "", extraWechatOk: true,
      gate: {
        question: "请回答本班科任男女人数之比（共10人）",
        answers: ["ac18bd73597efe3e39320f1c78d6fa7d8baacb81e29b4db28638146a16894e2c", "7321b13f59cde5cf414fe889f0cc93d3912387dad2ee1097dd25365e1e0867fc"],
        hint: "四字，格式为「男_女_」",
        url: "", code: "",
        sUrl: "CxgHQkYXHxpOHxsAAFccCgkcVQ1DBx1wT3VPZB0+GzU7V0M=", sCode: "VBQfWQ==",
        version: "2026-08-23-v3"
      }
    },
    {
      id: 7,
      categoryId: 5, title: "教学课件", icon: "", iconText: "课件", paused: true,
      pausedMsg: "📌 以后查看课堂笔记 / 课件，请线下在班上大屏查看。",
      desc: "经多方对比，课件资源存储于天翼云盘。\n需登录天翼云盘网页端，无需安装客户端，下载基本不限速。\n打不开可复制链接至浏览器打开（微信页面可能存在兼容问题）。",
      mainLabel: "", mainUrl: "", mainWechatOk: true,
      extraLabel: "", extraUrl: "", extraWechatOk: true,
      gate: {
        question: "请回答在高一下学期中零排的常驻嘉宾是？",
        answers: ["9d782e21981e703e909d86136724dea48c956e805bf3be2fc69652c697ee626e"],
        hint: "三个字，全名",
        url: "", code: "",
        sUrl: "CxgHQkYXHxpOHxsAAFccCgkcVQ1DBx1PdHpbaBU2Gy0THwA=", sCode: "Ew0DCw==",
        version: "2026-08-23-v3"
      }
    },
    {
      id: 8, categoryId: 0, title: "每日日报", icon: "",
      desc: "实时热点资讯聚合，\n点击下方按钮即可查看最新热点内容。",
      mainLabel: "前往查看", mainUrl: "https://newsnow.czl.net/c/china", mainWechatOk: true,
      extraLabel: "", extraUrl: "", extraWechatOk: true,
      iconText: "日报"
    },
    {
      id: 10,
      categoryId: 8, title: "个人资料查询", icon: "", iconText: "资料", contactQuery: true,
      desc: "输入姓名，查询班上同学与班主任的资料。\n可查看学号、政治面貌（中共党员 / 共青团员 / 普通学生）等资料。\n资料采用加密存储，不用担心泄露。",
      mainLabel: "", mainUrl: "", mainWechatOk: true,
      extraLabel: "", extraUrl: "", extraWechatOk: true
    },
    {
      id: 11,
      categoryId: 8, title: "番茄时钟", icon: "", iconText: "🍅",
      desc: "番茄工作法计时器：专注 25 分钟 + 短暂休息，\n帮你提升学习效率，保持专注。",
      mainLabel: "前往使用", mainUrl: "https://focustide.app/", mainWechatOk: true,
      extraLabel: "", extraUrl: "", extraWechatOk: true
    },
    {
      id: 12,
      categoryId: 8, title: "私人云盘", icon: "", iconText: "云盘", active: false,
      desc: "用于同步班级重要文件、应用与软件，方便随时取用。",
      mainLabel: "", mainUrl: "", mainWechatOk: true,
      extraLabel: "", extraUrl: "", extraWechatOk: true,
      gate: {
        question: "请输入私人云盘的访问密码",
        answers: ["5e67cd33facc7b1ac3169e55cd8b161c655cc939c6f9322c0f56919ffaa432c3"],
        hint: "仅管理员持有访问密码",
        url: "",
        code: "",
        version: "2026-08-23-v1"
      }
    },
    {
      id: 17,
      categoryId: 7, title: "意见反馈", icon: "", iconText: "📮",
      desc: "对班级事务有任何想法、建议，或想反映的问题，都可以在这里匿名提交。\n好的点子、槽点、建议都可以畅所欲言，我们会认真查看。",
      mainLabel: "前往填写", mainUrl: "https://www.wjx.top/vm/tFMclw4.aspx#", mainWechatOk: true,
      extraLabel: "", extraUrl: "", extraWechatOk: true,
      needLogin: true
    },
    {
      id: 15,
      categoryId: 7, title: "排行榜", icon: "", iconText: "排行", comingSoon: true, active: false,
      desc: "班级排行榜功能开发中，敬请期待。",
      mainLabel: "开发中", mainUrl: "", mainWechatOk: true,
      extraLabel: "", extraUrl: "", extraWechatOk: true
    },
    {
      id: 16,
      categoryId: 7, title: "班级活动", icon: "", iconText: "活动", comingSoon: true,
      desc: "暂时还没有班级活动，敬请期待。",
      mainLabel: "敬请期待", mainUrl: "", mainWechatOk: true,
      extraLabel: "", extraUrl: "", extraWechatOk: true
    }
  ]
};
/* ===================================================== */

/* ── 站点入口问答（首次打开需回答，answers 为哈希）── */
var SITE_GATE = {
  question: "请回答举办“给未来自己的一封信”当天所对应的节日。",
  /* 答案以 SHA-256 存储，不出现明文。为照顾「输入法切不出中文 / 只会英文键盘」的同学，
     额外接受：中文别名、错别字、全拼、缩写、英文。新增答案用 hashSecret(明文, GATE_SALT) 生成。 */
  answers: [
    "725f83c579b242c8f55fd871f950c2b87f06e0d05f66065d658d1a74e7d06c80", /* 标准答案（三个字） */
    "68bc7fd010888eaaaddaf9b9d31f25dfbac8918e20043c30bd85f113a5ca743c", /* 前两个字 */
    "906dba96dc9f70f65b3f270a155f6d021d8f30733cd61014e69f39282de1c66f", /* 别名一 */
    "ab89374858196c85b0545916fa32686edfddb8790219bcac63932876d871eb25", /* 别名二 */
    "37c681d68e334c8d17c20050171df05c9a514a43d04f60458bb50dbfe0e60fea", /* 农历日期叫法 */
    "7f46a07d533679aee472a9239607a02f551420513f5e30eb43a27a43d6350c6d", /* 常见错字 */
    "2275311545501cc80a9540d3c00a50f1c5c3211223d82f3833330a3f9f541296", /* 全拼 */
    "9294f0a54fe8392b985448a08999d130a1aacb0cc3f3e2d88f8fca0f6b33dafe", /* 全拼+jie */
    "e9fae19194a8bd4bd5c5de3b43c80c4fbb460dbd044dff6b5fa9ff00d15c47f2", /* 拼音首字母 */
    "3eb9458649cd696b90acae91c2f419113bcbc672ce71d3158199732503c02b41", /* 英文 */
    "5d13ec93993f41453a708ae6d8664c9e3f5da47ecd8812316ff35dbcf9e0d9f2"  /* 英文全称 */
  ],
  hint: "三个字；输入法打不出中文时，可直接输拼音或英文",
  version: "2026-08-23-v1"
};

/* ── 学期与节假日倒计时配置（可在此修改）── */
var SEMESTER = {
  breakDate: "2027-01-30T00:00:00"  /* 寒假开始：1月30日 00:00（以学校通知为准） */
};
var IMPORTANT_DATES = [
  { name: "寒假", date: "2027-01-30T00:00:00" },
  /* 第一次段考（10月13日—14日，共两天）
     · endDate：结束日期，用于显示「13日—14日」这种区间（单日事项不用填）
     · scope：各科考试范围，填了才会在弹窗里出现「查看考试范围」入口 */
  { name: "第一次段考", date: "2026-10-13T00:00:00", endDate: "2026-10-14", scope: [
      { sub: "语文", txt: "选择性必修上册第一单元和第二单元（默写范围：《〈论语〉十二章》《大学之道》《〈老子〉四章》）" },
      { sub: "数学", txt: "选择性必修一第一章，第二章第一节" },
      { sub: "英语", txt: "选择性必修一 Unit1 — Unit3" },
      { sub: "物理", txt: "必修三 第九章静电场、第十章静电场中的能量、第十一章电路及其应用　全部内容" },
      { sub: "化学", txt: "选必一第一章到第三章第一节电离平衡" },
      { sub: "生物", txt: "必修二前5章（占30%），必修二第六章至选择性必修一第二章第三节（占70%）。" }
    ] }
];

/* ── 考试范围弹窗 ──
   为什么单独一个弹窗：段考范围有六科、每科一大段，塞进倒计时那一小条会挤成一团，
   手机上根本没法看。做成二级弹窗后，倒计时仍然清爽，想看的人点进去才是全文。 */
var EXAM_SCOPE = {};   /* 打开时按 name 存一份当前条目，避免把整段文本塞进 onclick */
function openExamScope(name){
  for(var i=0;i<IMPORTANT_DATES.length;i++){
    var d = IMPORTANT_DATES[i];
    if(d.name === name && d.scope && d.scope.length){
      EXAM_SCOPE = d;
      break;
    }
  }
  if(!EXAM_SCOPE || !EXAM_SCOPE.scope) return;
  var mask  = document.getElementById('examScopeMask');
  var title = document.getElementById('examScopeTitle');
  var body  = document.getElementById('examScopeBody');
  if(!mask || !body) return;

  if(title) title.textContent = EXAM_SCOPE.name + ' · 考试范围';

  /* 日期行：单日显示一天，跨日显示区间 */
  var dateLine = '';
  if(EXAM_SCOPE.endDate){
    var a = new Date(EXAM_SCOPE.date), b = new Date(EXAM_SCOPE.endDate + 'T00:00:00');
    dateLine = fmtDayCn(a) + ' — ' + fmtDayCn(b);
  }else{
    dateLine = fmtDayCn(new Date(EXAM_SCOPE.date));
  }

  body.innerHTML =
    '<div class="ex-scope-date">🗓 ' + esc(dateLine) + '</div>' +
    '<ul class="ex-scope-list">' +
      EXAM_SCOPE.scope.map(function(s){
        return '<li class="ex-scope-item">' +
          '<div class="ex-scope-sub">' + esc(s.sub) + '</div>' +
          '<div class="ex-scope-txt">' + esc(s.txt) + '</div>' +
        '</li>';
      }).join('') +
    '</ul>' +
    '<div class="ex-scope-note">范围以各科老师最终通知为准。</div>';

  mask.classList.add('show');
}
function closeExamScope(){ var m=document.getElementById('examScopeMask'); if(m) m.classList.remove('show'); }
/* 例：2026-10-13 → "10月13日 周一" */
function fmtDayCn(d){
  var w = ['日','一','二','三','四','五','六'][d.getDay()];
  return (d.getMonth()+1) + '月' + d.getDate() + '日 周' + w;
}

/* ============ 法定节假日：自动推算（不再手填日期） ============
   以前这里是一张写死的日期表，过一年就得手动补，忘了就会空掉。
   现在改成按当前年份自动推算「今年起未来 HOL_YEARS 年」的节日，永远不用维护。

   推算来源分三类：
     ① 固定公历 —— 元旦 1/1、劳动节 5/1、国庆节 10/1，直接写死
     ② 农历节日 —— 春节（正月初一）、端午（五月初五）、中秋（八月十五），
        用下方的农历数据表精确换算，1900–2100 通用，无需联网
     ③ 清明 —— 节气，公历 4/4 或 4/5 浮动，用查表 + 公式兜底

   放假天数沿用现行常规安排（元旦3 / 春节7 / 清明3 / 劳动5 / 端午3 / 中秋3 / 国庆7）。
   ⚠️ 国务院每年会调休，实际天数可能变化，所以弹窗里标注「放假天数为参考」。
   ================================================================ */

/* 农历数据表（1900–2100）：低 4 位 = 闰月月份（0 无闰月）；
   从 bit4 起 12 位依次表示正月至十二月大小（1=30天，0=29天）；bit16 表示闰月是否 30 天 */
var LUNAR_INFO = [
  0x04bd8,0x04ae0,0x0a570,0x054d5,0x0d260,0x0d950,0x16554,0x056a0,0x09ad0,0x055d2,
  0x04ae0,0x0a5b6,0x0a4d0,0x0d250,0x1d255,0x0b540,0x0d6a0,0x0ada2,0x095b0,0x14977,
  0x04970,0x0a4b0,0x0b4b5,0x06a50,0x06d40,0x1ab54,0x02b60,0x09570,0x052f2,0x04970,
  0x06566,0x0d4a0,0x0ea50,0x06e95,0x05ad0,0x02b60,0x186e3,0x092e0,0x1c8d7,0x0c950,
  0x0d4a0,0x1d8a6,0x0b550,0x056a0,0x1a5b4,0x025d0,0x092d0,0x0d2b2,0x0a950,0x0b557,
  0x06ca0,0x0b550,0x15355,0x04da0,0x0a5b0,0x14573,0x052b0,0x0a9a8,0x0e950,0x06aa0,
  0x0aea6,0x0ab50,0x04b60,0x0aae4,0x0a570,0x05260,0x0f263,0x0d950,0x05b57,0x056a0,
  0x096d0,0x04dd5,0x04ad0,0x0a4d0,0x0d4d4,0x0d250,0x0d558,0x0b540,0x0b6a0,0x195a6,
  0x095b0,0x049b0,0x0a974,0x0a4b0,0x0b27a,0x06a50,0x06d40,0x0af46,0x0ab60,0x09570,
  0x04af5,0x04970,0x064b0,0x074a3,0x0ea50,0x06b58,0x055c0,0x0ab60,0x096d5,0x092e0,
  0x0c960,0x0d954,0x0d4a0,0x0da50,0x07552,0x056a0,0x0abb7,0x025d0,0x092d0,0x0cab5,
  0x0a950,0x0b4a0,0x0baa4,0x0ad50,0x055d9,0x04ba0,0x0a5b0,0x15176,0x052b0,0x0a930,
  0x07954,0x06aa0,0x0ad50,0x05b52,0x04b60,0x0a6e6,0x0a4e0,0x0d260,0x0ea65,0x0d530,
  0x05aa0,0x076a3,0x096d0,0x04afb,0x04ad0,0x0a4d0,0x1d0b6,0x0d250,0x0d520,0x0dd45,
  0x0b5a0,0x056d0,0x055b2,0x049b0,0x0a577,0x0a4b0,0x0aa50,0x1b255,0x06d20,0x0ada0,
  0x14b63,0x09370,0x049f8,0x04970,0x064b0,0x168a6,0x0ea50,0x06b20,0x1a6c4,0x0aae0,
  0x0a2e0,0x0d2e3,0x0c960,0x0d557,0x0d4a0,0x0da50,0x05d55,0x056a0,0x0a6d0,0x055d4,
  0x052d0,0x0a9b8,0x0a950,0x0b4a0,0x0b6a6,0x0ad50,0x055a0,0x0aba4,0x0a5b0,0x052b0,
  0x0b273,0x06930,0x07337,0x06aa0,0x0ad50,0x14b55,0x04b60,0x0a570,0x054e4,0x0d160,
  0x0e968,0x0d520,0x0daa0,0x16aa6,0x056d0,0x04ae0,0x0a9d4,0x0a2d0,0x0d150,0x0f252,
  0x0d520
];
var LUNAR_BASE_YEAR = 1900;

function lunarLeapMonth(y){ return LUNAR_INFO[y - LUNAR_BASE_YEAR] & 0xf; }
function lunarLeapDays(y){
  if(lunarLeapMonth(y)) return (LUNAR_INFO[y - LUNAR_BASE_YEAR] & 0x10000) ? 30 : 29;
  return 0;
}
function lunarMonthDays(y, m){
  return (LUNAR_INFO[y - LUNAR_BASE_YEAR] & (0x10000 >> m)) ? 30 : 29;
}
function lunarYearDays(y){
  var sum = 348;  /* 12 × 29 */
  for(var i = 0x8000; i > 0x8; i >>= 1){ sum += (LUNAR_INFO[y - LUNAR_BASE_YEAR] & i) ? 1 : 0; }
  return sum + lunarLeapDays(y);
}
/* 农历 → 公历。闰月传 leap=true（本项目用不到，保留完整性） */
function lunarToSolar(y, m, d, leap){
  var offset = 0;
  for(var i = LUNAR_BASE_YEAR; i < y; i++){ offset += lunarYearDays(i); }
  var leapM = lunarLeapMonth(y);
  for(var j = 1; j < m; j++){
    offset += lunarMonthDays(y, j);
    if(j === leapM) offset += lunarLeapDays(y);
  }
  if(leap && leapM === m) offset += lunarMonthDays(y, m);
  offset += (d - 1);
  var base = new Date(1900, 0, 31);   /* 1900-01-31 = 农历 1900 年正月初一 */
  base.setDate(base.getDate() + offset);
  return base;
}

/* 清明（4/4 或 4/5 浮动）：官方日期查表，表外用公式兜底 */
var QINGMING_TABLE = {
  2020:4,2021:4,2022:5,2023:5,2024:4,2025:4,2026:5,2027:5,2028:4,2029:4,2030:5,
  2031:5,2032:4,2033:4,2034:4,2035:5,2036:4,2037:5,2038:5,2039:4,2040:4,2041:4,
  2042:5,2043:5,2044:4,2045:4
};
function qingmingDay(y){
  if(QINGMING_TABLE[y]) return QINGMING_TABLE[y];
  var Y = y % 100, L = Math.floor((Y - 1) / 4);
  return Math.floor(Y * 0.2422 + 4.81) - L;
}

var HOL_YEARS = 5;   /* 自动推算「今年起未来 N 年」，5 年足够，也不会让弹窗列表过长 */

/* 生成某年的全部法定节假日。返回 [{name, date:'YYYY-MM-DD', days}] */
function holidaysOfYear(y){
  var out = [
    { name: '元旦',   date: y + '-01-01', days: 3 },
    { name: '春节',   date: fmtYMD(lunarToSolar(y, 1, 1)),  days: 7 },
    { name: '清明节', date: y + '-04-' + pad2(qingmingDay(y)), days: 3 },
    { name: '劳动节', date: y + '-05-01', days: 5 },
    { name: '端午节', date: fmtYMD(lunarToSolar(y, 5, 5)),  days: 3 },
    { name: '中秋节', date: fmtYMD(lunarToSolar(y, 8, 15)), days: 3 },
    { name: '国庆节', date: y + '-10-01', days: 7 }
  ];
  return out;
}
function fmtYMD(d){
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/* 节假日列表：从今年起共 HOL_YEARS 年，按日期升序 */
var HOLIDAYS = (function(){
  var y0 = new Date().getFullYear();
  var all = [];
  for(var y = y0; y < y0 + HOL_YEARS; y++){ all = all.concat(holidaysOfYear(y)); }
  /* 表只到 2100，越界时不再往后推 */
  all = all.filter(function(h){ return new Date(h.date + 'T00:00:00').getFullYear() <= 2100; });
  all.sort(function(a, b){ return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
  return all;
})();

function isWeChat(){ return /micromessenger/i.test(navigator.userAgent); }
function httpUrl(u){ return /^https?:\/\//i.test((u||'').trim()); }

var targetUrl = '';

/* ---- 哈希路由：#/guide?url=xxx ---- */
function applyHash(){
  var h = location.hash || '';
  var m = h.match(/^#\/guide\?url=(.*)$/);
  if(m){
    var u = '';
    try{ u = decodeURIComponent(m[1]); }catch(e){ u = m[1]; }
    if(!httpUrl(u)){ resetHome(); return; }
    targetUrl = u;
    if(isWeChat()){
      show('guideOverlay');
      var host = '';
      try{ host = new URL(u).hostname; }catch(e){}
      document.getElementById('guideHost').textContent = host ? '目标：' + host : '';
    }else{
      show('jumpOverlay');
      var jh = '';
      try{ jh = new URL(u).hostname; }catch(e){}
      document.getElementById('jumpHost').textContent = jh;
      document.getElementById('jumpManual').href = u;
      setTimeout(function(){ window.location.replace(u); }, 900);
    }
  }else{
    hideOverlays();
  }
}
function show(id){ hideOverlays(); document.getElementById(id).classList.add('show'); }
function hideOverlays(){
  document.getElementById('guideOverlay').classList.remove('show');
  document.getElementById('jumpOverlay').classList.remove('show');
}
function resetHome(){ location.hash = ''; hideOverlays(); window.scrollTo(0,0); }
window.addEventListener('hashchange', applyHash);

/* ---- 链接打开（微信智能分流） ---- */
/* 跳转前记住当前视图，返回班级站时自动恢复（sessionStorage） */
function rememberView(){
  var v = 'home';
  var hm = document.getElementById('hiddenViewMask');
  if(hm && hm.classList.contains('show')){ v = 'hidden'; }
  else if(window.__activeCat != null){ v = 'cat_' + window.__activeCat; }
  try{ sessionStorage.setItem('cls_return_view', v); }catch(e){}
}
function openLink(url, wechatOk, label){
  rememberView();
  url = (url||'').trim();
  if(!url || url === '#'){ alert('该入口链接暂未配置，请联系管理员补充'); return; }

  /* ===== v3.5.13（站主 #3）：点歌平台投稿上限守卫 =====
     后台在 site_config 配了 vhGuard:{ on, limit } 时，跳点歌平台前先查
     这位同学（按姓名匹配 requester）的未播投稿数 —— 达到上限就拦下来，
     提示去换一首或联系管理员。检查失败/超时不拦（别把入口搞坏）。 */
  if(SITE_DATA.vhGuard && SITE_DATA.vhGuard.on && SITE_DATA.vhGuard.limit > 0 && /^https?:\/\//i.test(url)){
    try{
      var gBase = url.split('/').slice(0, 3).join('/');
      var myName = (AUTH && AUTH.user && (AUTH.user.displayName || AUTH.user.display_name || AUTH.user.name)) || '';
      if(myName){
        var gName = myName;
        api('/vh?action=songs&base=' + encodeURIComponent(gBase)).then(function(j){
          try{
            var songs = (j && j.songs) || [];
            var mine = songs.filter(function(it){
              var s = it.song || it;
              return !it.played && !s.played && String(s.requester || '').trim() === gName;
            });
            if(mine.length >= SITE_DATA.vhGuard.limit){
              if(!window.confirm('你在点歌平台还有 ' + mine.length + ' 首歌没播（上限 ' + SITE_DATA.vhGuard.limit + ' 首）。\n\n先等播完再投稿哦 —— 仍要继续打开点歌平台吗？')) return;
            }
          }catch(e){}
          __openLinkGo(url, wechatOk, label);
        }).catch(function(){ __openLinkGo(url, wechatOk, label); });
        return;
      }
    }catch(e){}
  }

  __openLinkGo(url, wechatOk, label);
}
function __openLinkGo(url, wechatOk, label){
  /* 🚀 v2.10.1：跳转单独记一条，带上「入口名 + 目标地址」并立刻发走。
     站主 2026-10-17 反馈：「跳了点歌平台，后台看不到去了哪里」——两个原因：
       ① 原来只记通用点击（内容里只有按钮文字「前往入口」，看不出目的地）；
       ② 紧接着页面就跳走了，攒批队列被浏览器取消，这条记录压根没发出去。
     label 由调用方传入（卡片标题，如「点歌平台 VoiceHub」）。 */
  try{
    actLog('jump', label ? String(label) : url, '前往 ' + url);
    actLogFlushKeepalive();
  }catch(e){ /* 记日志失败绝不影响跳转 */ }
  if(isWeChat() && !wechatOk){
    location.hash = '/guide?url=' + encodeURIComponent(url);
  }else if(isWeChat()){
    window.location.href = url;
  }else{
    /* 电脑端：站内游戏（相对路径，如 games/xxx.html）同标签打开，避免任务栏堆积大量标签页；
       外部链接（http(s)://）仍新标签打开，保留班级服务站。 */
    if(!/^https?:\/\//i.test(url)){
      window.location.href = url;
    }else{
      window.open(url, '_blank');
    }
  }
}
/* Classworks 直达入口（微信内自动引导浏览器打开） */
function openClassworks(){ openLink('https://cs.houlang.cloud/?namespace=%E9%AB%98%E4%BA%8C%EF%BC%885%EF%BC%89%E7%8F%AD&authCode=202505', false); }

function copyTarget(){
  var ta = document.createElement('textarea');
  ta.value = targetUrl;
  ta.style.position='fixed'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.focus(); ta.select();
  var ok = false;
  try{ ok = document.execCommand('copy'); }catch(e){}
  if(navigator.clipboard && window.isSecureContext){
    navigator.clipboard.writeText(targetUrl).catch(function(){});
    ok = true;
  }
  document.body.removeChild(ta);
  var b = document.getElementById('copyBtn');
  b.textContent = ok ? '已复制，可粘贴到浏览器' : '复制失败，请长按上方链接';
  setTimeout(function(){ b.textContent = '复制目标链接'; }, 2200);
}

/* 公众号二维码弹窗 */
function openQr(src){
  document.getElementById('qrImg').src = src;
  document.getElementById('qrMask').classList.add('show');
}
function closeQr(){
  document.getElementById('qrMask').classList.remove('show');
}
document.getElementById('qrMask').addEventListener('click', function(e){
  if(e.target.id === 'qrMask') closeQr();
});

/* =====================================================
   音频播放器（听力音频 / 任意直链音频）
   功能：播放暂停、进度条拖动、±15 秒、倍速、音量、静音、全屏
   说明：控件全部自绘（不用浏览器默认 controls），样式与站点一致；
        全屏由外层弹窗实现，微信内也能用。
   ===================================================== */
var _audioUrl = '', _audioTitle = '音频播放', _audioEl = null;
var AUDIO_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
var _audioRate = 1, _audioVol = 1, _audioMuted = false, _audioDragging = false;
/* 统一的「是否可跳转」判定：seekable 已知且末段终点 > 0.5s。
   服务端不支持 HTTP Range（只回 200 不回 206）时恒为 false，此时写 currentTime 会被静默丢弃。 */
var _audioNoSeekWarned = false;
function _aSeekable(){
  var el = _audioEl;
  try{ return !!(el && el.seekable && el.seekable.length && el.seekable.end(el.seekable.length-1) > 0.5); }
  catch(e){ return false; }
}
/* 秒 -> mm:ss / h:mm:ss */
function _aFmtTime(s){
  if(!isFinite(s) || s < 0) s = 0;
  var h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
  if(h > 0) return h+':'+pad2(m)+':'+pad2(sec);
  return m+':'+pad2(sec);
}

function _audioEnsure(){
  if(_audioEl) return _audioEl;
  var el = document.getElementById('audioEl');
  if(!el){
    el = document.createElement('audio');
    el.id = 'audioEl';
    el.preload = 'auto';              /* 允许浏览器多缓冲一些，跳转后更快出声 */
    el.setAttribute('playsinline',''); /* iOS 不强制进系统全屏播放器 */
    el.setAttribute('playsinline',''); /* iOS 不强制进系统全屏播放器 */
    el.style.display = 'none';
    document.body.appendChild(el);
  }
  _audioEl = el;
  /* ⚠️ 事件只在首次创建时绑定一次。之前每次调用都绑，导致 timeupdate 被叠加多个监听，
     且 openAudio 每次都重设 src 把已缓冲的进度丢掉——这是「拖了没反应」的真根因之一。 */
  if(!el.dataset.bound){
    el.dataset.bound = '1';
    el.addEventListener('loadedmetadata', _audioSyncMeta);
    el.addEventListener('durationchange', _audioSyncMeta);
    el.addEventListener('timeupdate', function(){ if(!_audioDragging){ _audioSyncProgress(); _audioSubTick(); } });
    el.addEventListener('seeked', function(){ _audioSyncProgress(); _audioSubTick(); });
    el.addEventListener('play',  function(){ _audioVisual(true);  _audioToggleBtn(true);  });
    el.addEventListener('pause', function(){ _audioVisual(false); _audioToggleBtn(false); });
    el.addEventListener('ended', function(){ _audioVisual(false); _audioToggleBtn(false); _audioSetSub('播放完毕，可点「播放」重听'); });
    el.addEventListener('waiting', function(){
      /* 跳转/网络慢时会进这个状态。必须给反馈，否则界面一片安静，
         用户分不清「在加载」还是「坏了」——这是体感「等好久」的主要来源。 */
      _audioSetSub('正在缓冲…');
      var m = document.getElementById('audioMask'); if(m) m.classList.add('is-buffering');
    });
    el.addEventListener('playing', function(){
      var m = document.getElementById('audioMask'); if(m) m.classList.remove('is-buffering');
    });
    el.addEventListener('canplay', function(){
      var m = document.getElementById('audioMask'); if(m) m.classList.remove('is-buffering');
    });
    el.addEventListener('error',  function(){
      var fb = document.getElementById('audioFallback');
      if(fb){ fb.classList.add('show'); fb.innerHTML = '音频加载失败。可能是网络问题，或该链接不是可直接播放的音频直链。可 <a href="'+esc(_audioUrl)+'" target="_blank" rel="noopener">在新标签页打开试试</a>。'; }
    });
    el.addEventListener('progress', function(){ /* 缓冲进度预留，当前用填充条表示播放进度 */ });
  }
  return el;
}
/* 把 URL 统一成绝对地址再比较：el.src 读出来永远是绝对值，
   直接用相对路径比会恒不相等，于是每次打开都重设 src、白丢缓冲。 */
function _aAbs(url){
  try{ return new URL(url, location.href).href; }catch(e){ return url; }
}
function _audioSyncMeta(){
  var el = _audioEnsure();
  var d = document.getElementById('audioDur');
  if(d) d.textContent = isFinite(el.duration) ? _aFmtTime(el.duration) : '--:--';
  _audioSyncProgress();
}
function _audioSyncProgress(){
  var el = _audioEnsure();
  if(_audioDragging) return;   /* 拖拽中由手势接管视觉，避免 timeupdate 抢回去 */
  var pct = (el.duration && isFinite(el.duration)) ? (el.currentTime/el.duration*100) : 0;
  pct = Math.max(0, Math.min(100, pct));
  var fill = document.getElementById('audioFill'), knob = document.getElementById('audioKnob');
  var cur = document.getElementById('audioCur');
  if(fill) fill.style.width = pct+'%';
  if(knob) knob.style.left = pct+'%';
  if(cur) cur.textContent = _aFmtTime(el.currentTime);
}
function _audioToggleBtn(playing){
  var b = document.getElementById('audioPlayBtn');
  if(!b) return;
  b.classList.toggle('is-play', !!playing);
  b.setAttribute('aria-label', playing ? '暂停' : '播放');
}
function _audioVisual(playing){
  var v = document.getElementById('audioVisual');
  if(v) v.classList.toggle('playing', !!playing);
  if(playing){
    _audioSubTick();
  } else {
    var el = _audioEnsure();
    /* 自然播完由 ended 事件单独提示，这里只处理暂停 */
    if(!el.ended) _audioSetSub('已暂停，点「播放」继续');
  }
}
/* 播放中持续刷新「已播 x%」（由 timeupdate 驱动，见 _audioEnsure）
   ⚠️ 但「不支持拖动」这类重要提示必须压过进度刷屏，否则提示刚写出
   就被下一次 timeupdate 覆盖掉（实测只活了几毫秒，用户根本看不到）。 */
var _audioSubHold = false;
function _audioSubTick(){
  var el = _audioEnsure();
  if(el.paused || el.ended) return;
  if(_audioSubHold) return;
  var p = (el.duration && isFinite(el.duration)) ? Math.round(el.currentTime/el.duration*100) : 0;
  p = Math.max(0, Math.min(100, p));
  _audioSetSub('正在播放 · 已播 '+p+'%');
}
/* 写一条「需要用户看见」的提示：暂停进度刷屏，直到用户再次操作 */
function _audioSubHoldSet(t){
  _audioSubHold = true;
  _audioSetSub(t);
}
function _audioSetSub(t){ var s = document.getElementById('audioSub'); if(s) s.textContent = t; }

function openAudio(url, title){
  url = (url||'').trim();
  if(!url){ alert('该音频暂未配置，请联系管理员补充'); return; }
  _audioUrl = url; _audioTitle = title || '音频播放';
  _audioNoSeekWarned = false;
  _audioSubHold = false;
  var t = document.getElementById('audioTitle'); if(t) t.textContent = _audioTitle;
  var fb = document.getElementById('audioFallback'); if(fb){ fb.classList.remove('show'); fb.innerHTML=''; }
  var el = _audioEnsure();
  /* 同一个音频不要重设 src：重设会丢弃已缓冲数据、并让 seekable 重新变空。
     只有地址真的换了（比较绝对 URL）才重新加载。 */
  var same = el.src && el.src === _aAbs(url);
  if(!same){
    el.src = url;
    try{ el.currentTime = 0; }catch(e){}
    el.load();   /* 显式 load，确保新源一定进入加载流程 */
  }
  el.playbackRate = _audioRate;
  el.volume = _audioVol; el.muted = _audioMuted;
  _audioSyncRateUI(); _audioSyncVolUI();
  var m = document.getElementById('audioMask'); if(m) m.classList.add('show');
  audioBubbleHide();
  _audioSetSub(same ? '已续上上次进度，点「播放」继续' : '点下方按钮开始播放');
  _audioSyncProgress();
}
/* 关闭：暂停并收起弹窗，保留进度供悬浮球续播 */
function closeAudio(){
  var el = _audioEnsure();
  try{ el.pause(); }catch(e){}
  var m = document.getElementById('audioMask');
  if(m){ m.classList.remove('show'); m.classList.remove('fs'); }
  var b = document.getElementById('audioFsBtn'); if(b) b.textContent = '全屏';
  if(_audioUrl) audioBubbleShow();
}
function reopenAudio(){
  if(!_audioUrl) return;
  var el = _audioEnsure();
  var m = document.getElementById('audioMask'); if(m) m.classList.add('show');
  var t = document.getElementById('audioTitle'); if(t) t.textContent = _audioTitle;
  audioBubbleHide();
  _audioSyncMeta(); _audioSyncRateUI(); _audioSyncVolUI();
  _audioSetSub('已续上上次进度，点「播放」继续');
}
function audioBubbleShow(){
  var el = document.getElementById('audioBubble'); if(!el) return;
  el.style.display = 'flex';
  if(typeof actSyncBubble === 'function') actSyncBubble();
}
function audioBubbleHide(){
  var el = document.getElementById('audioBubble'); if(el) el.style.display = 'none';
  if(typeof actSyncBubble === 'function') actSyncBubble();
}

/* ⚡ fastSeek 开关：默认 true，由调用方在需要「落点必须精确」时临时置 false。
   规则：拖进度条松手 → 精确 seek（用户看着刻度，差一点都不行）；
        ±15 秒快进/后退 → fastSeek（快更重要，差不到一秒听不出来）。 */
var _audioFastOk = true;
/* 真正的跳转动作：所有跳转（进度条、±15 秒、键盘）都走这里，保证行为一致。
   返回 true 表示已生效。 */
function audioSeekTo(t, silent){
  var el = _audioEnsure();
  if(!isFinite(el.duration) || el.duration <= 0) return false;
  t = Math.max(0, Math.min(el.duration, t));
  if(!_aSeekable()){
    if(!silent) audioNoSeekTip();
    return false;
  }
  /* ⚡ 拖动/±15 秒这类「用户还在操作」的跳转优先用 fastSeek：
     它跳到目标附近的最近关键帧而不是精确字节位置，省掉一次完整回源，
     体感明显更快。代价是落点可能差不到一秒——对听力音频无感，但拖进度条时
     必须精确，故仅在 _aFastSeekOK(t) 允许时使用（见下）。
     前提：跳转不改变播放/暂停状态；暂停时用 fastSeek 会看不出效果，仍走精确 seek。 */
  var useFast = !el.paused && typeof el.fastSeek === 'function' && _audioFastOk;
  try{
    if(useFast) el.fastSeek(t); else el.currentTime = t;
  }catch(e){
    try{ el.currentTime = t; }catch(e2){ return false; }
  }
  /* 立即刷新 UI，不等 seeked（慢一点时手感更好），seeked 到了会再刷一次 */
  var pct = el.duration ? (t/el.duration*100) : 0;
  var fill = document.getElementById('audioFill'), knob = document.getElementById('audioKnob');
  if(fill) fill.style.width = pct+'%';
  if(knob) knob.style.left = pct+'%';
  var cur = document.getElementById('audioCur'); if(cur) cur.textContent = _aFmtTime(t);
  _audioHideFallback();
  return true;
}
/* 播放 / 暂停：必须由点击触发（微信等环境禁止自动播放有声媒体） */
function audioToggle(){
  var el = _audioEnsure();
  _audioSubHold = false;          /* 用户主动操作，恢复进度刷屏 */
  if(el.paused){
    var pr = el.play();
    if(pr && pr.catch) pr.catch(function(){ _audioSetSub('浏览器拦截了自动播放，请再点一次「播放」'); });
  } else {
    el.pause();
  }
}
function audioSkip(sec){
  var el = _audioEnsure();
  if(!isFinite(el.duration)){
    _audioSubHoldSet('音频还在加载，稍等一下再试');
    return;
  }
  /* 播完之后按「后退」应当从结尾往回退，而不是停在结尾 */
  if(el.ended && sec < 0) el.pause();
  var target = el.currentTime + sec;
  /* ⚠️ 先 seek 再解除提示屏蔽：audioSeekTo 失败时会写「不支持」提示，
     若提前把 _audioSubHold 置 false，timeupdate 会立刻把它刷成「已播 x%」。 */
  var ok = audioSeekTo(target);
  if(ok){
    _audioSubHold = false;
    _audioSyncProgress();
  }
}
/* ---- 进度条拖动（鼠标 + 触摸统一用 Pointer 事件） ---- */
/* 关于「拖了没反应」，分两种情况：
   ① 正常情况：服务端支持 HTTP Range（返回 206），浏览器知道 seekable 区间，
      直接把 currentTime 写进去即可生效。
   ② 服务端不支持 HTTP Range（返回 200 而非 206，例如某些托管网关）：
      浏览器**根本无法跳转**——seekable 恒为 [0,0]，改 currentTime 会被静默丢弃，
      这是浏览器 + HTTP 协议层面的限制，前端无法绕过。
      这种情况如实告知用户，而不是假装拖成功了。 */
function _audioHideFallback(){
  var fb = document.getElementById('audioFallback');
  if(fb && fb.classList.contains('show') && fb.dataset.kind === 'noseek'){
    fb.classList.remove('show'); fb.innerHTML='';
    _audioSubHold = false;
  }
}
function audioNoSeekTip(){
  if(_audioNoSeekWarned) return;
  _audioNoSeekWarned = true;
  _audioSubHoldSet('这个音频源不支持拖动进度条，可点下方链接用系统播放器收听');
  var fb = document.getElementById('audioFallback');
  if(fb){
    fb.dataset.kind = 'noseek';
    fb.classList.add('show');
    fb.innerHTML = '当前音频地址不支持拖动进度条（服务器不支持分段读取），播放不受影响。'
      + '<br>需要跳着听的话，可 <a href="'+esc(_audioUrl)+'" target="_blank" rel="noopener">在新标签页打开</a>，用系统播放器收听。';
  }
}
/* 拖动时的「预览」：只动视觉 + 时间气泡，松手才真正 seek（避免拖动中疯狂请求） */
function audioBarPreview(pct){
  var el = _audioEnsure();
  var fill = document.getElementById('audioFill'), knob = document.getElementById('audioKnob');
  if(fill) fill.style.width = (pct*100)+'%';
  if(knob) knob.style.left = (pct*100)+'%';
  var tip = document.getElementById('audioTip');
  var t = isFinite(el.duration) ? pct*el.duration : 0;
  if(tip){ tip.style.left = (pct*100)+'%'; tip.textContent = _aFmtTime(t); }
  var cur = document.getElementById('audioCur'); if(cur) cur.textContent = _aFmtTime(t);
  return t;
}
function audioBarPctFromEvent(e){
  var bar = document.getElementById('audioBar'); if(!bar) return 0;
  var r = bar.getBoundingClientRect();
  var x = (e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0));
  var pct = r.width ? (x - r.left) / r.width : 0;
  return Math.max(0, Math.min(1, pct));
}
function audioBarInit(){
  var bar = document.getElementById('audioBar'); if(!bar || bar.dataset.bound) return;
  bar.dataset.bound = '1';
  var lastPct = 0;
  function down(e){
    var el = _audioEnsure();
    if(!isFinite(el.duration)) return;   /* 还没拿到时长，等加载完再说 */
    _audioSubHold = false;
    audioBarSetDragging(true);
    lastPct = audioBarPctFromEvent(e);
    audioBarPreview(lastPct);
    try{ bar.setPointerCapture(e.pointerId); }catch(err){}
    e.preventDefault();
  }
  function move(e){
    if(!_audioDragging) return;
    lastPct = audioBarPctFromEvent(e);
    audioBarPreview(lastPct);
    e.preventDefault();
  }
  function up(e){
    if(!_audioDragging) return;
    /* ⚠️ 顺序很重要：必须先 seek 再复位 dragging。
       之前先复位会让 timeupdate 抢先把填充条刷回旧位置，看起来就是「拖了没反应」。 */
    var el = _audioEnsure();
    lastPct = audioBarPctFromEvent(e);
    var t = audioBarPreview(lastPct);
    /* silent=false：失败要出声。拖到不能拖的源上必须当场告知，
       否则用户看到条子动了、声音没动，只会觉得「坏了」。
       成功时 audioSeekTo 会顺带收起旧提示。 */
    /* 拖进度条必须精确落点（用户对着刻度看），临时关掉 fastSeek */
    _audioFastOk = false;
    var ok = audioSeekTo(t, false);
    _audioFastOk = true;
    audioBarSetDragging(false);
    if(ok){
      audioSyncProgressForce();
    } else {
      /* 不能跳：把条子拨回真实播放位置，不让视觉骗人 */
      _audioSyncProgress();
      var tip = document.getElementById('audioTip');
      if(tip) tip.style.opacity = '0';
    }
  }
  bar.addEventListener('pointerdown', down);
  bar.addEventListener('pointermove', move);
  bar.addEventListener('pointerup', up);
  bar.addEventListener('pointercancel', up);
  /* 兜底：极老浏览器无 Pointer 事件时退回鼠标 / 触摸 */
  if(!window.PointerEvent){
    bar.addEventListener('mousedown', down); bar.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    bar.addEventListener('touchstart', down, {passive:false});
    bar.addEventListener('touchmove', move, {passive:false});
    bar.addEventListener('touchend', up);
  }
  /* 键盘无障碍：左右方向键 ±5 秒 */
  bar.addEventListener('keydown', function(e){
    if(e.key === 'ArrowLeft'){ audioSkip(-5); e.preventDefault(); }
    if(e.key === 'ArrowRight'){ audioSkip(5); e.preventDefault(); }
  });
  /* 加载完时长后，如果之前因为不支持拖拽提示过、现在又能拖了，把提示收掉 */
  bar.addEventListener('pointerdown', function(){
    if(_aSeekable()) _audioHideFallback();
  });
}
function audioBarSetDragging(on){
  _audioDragging = on;
  var bar = document.getElementById('audioBar'); if(bar) bar.classList.toggle('dragging', on);
}
/* ---- 倍速：点一次换下一档，循环 ---- */
function audioRateCycle(){
  var i = AUDIO_RATES.indexOf(_audioRate);
  var next = AUDIO_RATES[(i < 0 ? 0 : i + 1) % AUDIO_RATES.length];
  audioSetRate(next);
  var b = document.getElementById('audioRateBtn');
  if(b){
    b.classList.remove('bump');
    void b.offsetWidth;          /* 强制重排，让动画可以连点重放 */
    b.classList.add('bump');
    setTimeout(function(){ b.classList.remove('bump'); }, 200);
  }
  var el = _audioEnsure();
  _audioSetSub('播放速度已切换为 ' + _aRateText(_audioRate));
}
function _aRateText(r){ return (_aRateDisplay(r)) + '×'; }
function _aRateDisplay(r){ return (r % 1 === 0 ? r.toFixed(1) : String(r)); }
function audioSetRate(r){
  _audioRate = r;
  var el = _audioEnsure(); el.playbackRate = r;
  _audioSyncRateUI();
}
function _audioSyncRateUI(){
  var now = document.getElementById('audioRateNow');
  if(now) now.textContent = _aRateDisplay(_audioRate) + '×';
  var b = document.getElementById('audioRateBtn');
  if(b) b.title = '当前 ' + _aRateText(_audioRate) + '，点一下切换到下一档（最高 2×）';
}
/* ---- 音量 ---- */
function audioVolFromEvent(e){
  var bar = document.getElementById('audioVolBar'); if(!bar) return;
  var r = bar.getBoundingClientRect();
  var x = (e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0));
  var pct = r.width ? (x - r.left) / r.width : 1;
  pct = Math.max(0, Math.min(1, pct));
  _audioVol = pct;
  if(pct > 0) _audioMuted = false;
  var el = _audioEnsure(); el.volume = pct; el.muted = _audioMuted;
  _audioSyncVolUI();
}
function _audioSyncVolUI(){
  var v = _audioMuted ? 0 : _audioVol;
  var fill = document.getElementById('audioVolFill'), knob = document.getElementById('audioVolKnob');
  if(fill) fill.style.width = (v*100)+'%';
  if(knob) knob.style.left = (v*100)+'%';
  var b = document.getElementById('audioMuteBtn');
  if(b){
    /* 静音态切 data-state，由 CSS 选择器换图标；
       之前是用 JS 拼 --ico-volume-x 这种**并不存在**的变量名，图标永远显示不出来。 */
    var muted = _audioMuted || _audioVol <= 0.02;
    b.dataset.state = muted ? 'mute' : 'on';
    b.title = _audioMuted ? '取消静音' : '静音';
    b.setAttribute('aria-label', _audioMuted ? '当前已静音，点击恢复声音' : '静音');
  }
}
function audioMute(){
  _audioMuted = !_audioMuted;
  var el = _audioEnsure(); el.muted = _audioMuted;
  if(!_audioMuted && _audioVol <= 0.02){ _audioVol = 1; el.volume = 1; }
  _audioSyncVolUI();
}
function audioVolInit(){
  var bar = document.getElementById('audioVolBar'); if(!bar || bar.dataset.bound) return;
  bar.dataset.bound = '1';
  function down(e){ audioVolFromEvent(e); try{ bar.setPointerCapture(e.pointerId); }catch(err){} e.preventDefault(); }
  function move(e){ if(!bar.dataset.drag) return; audioVolFromEvent(e); e.preventDefault(); }
  function up(){ bar.dataset.drag = ''; }
  function start(e){ bar.dataset.drag = '1'; down(e); }
  bar.addEventListener('pointerdown', start);
  bar.addEventListener('pointermove', move);
  bar.addEventListener('pointerup', up);
  bar.addEventListener('pointercancel', up);
  if(!window.PointerEvent){
    bar.addEventListener('mousedown', start); bar.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    bar.addEventListener('touchstart', start, {passive:false});
    bar.addEventListener('touchmove', move, {passive:false});
    bar.addEventListener('touchend', up);
  }
}
/* 松手 / 跳转后强制刷新一次进度 UI，避免 timeupdate 尚未触发时显示回退 */
function audioSyncProgressForce(){ _audioSyncProgress(); }
/* ---- 全屏（外层弹窗实现，微信内同样可用） ---- */
function toggleAudioFs(){
  var m = document.getElementById('audioMask'); if(!m) return;
  var on = m.classList.toggle('fs');
  var b = document.getElementById('audioFsBtn'); if(b) b.textContent = on ? '还原' : '全屏';
  try{
    if(!document.fullscreenElement && document.documentElement.requestFullscreen){
      var pr = document.documentElement.requestFullscreen();
      if(pr && pr.catch) pr.catch(function(){});
    } else if(on === false && document.fullscreenElement && document.exitFullscreen){
      document.exitFullscreen().catch(function(){});
    }
  }catch(e){ /* 不支持真全屏时，CSS 铺满视口依然可用 */ }
}
/* 初始化绑定 + 点击遮罩关闭 + 点空白收起倍速菜单 */
(function(){
  function init(){
    audioBarInit(); audioVolInit();
    _audioSyncVolUI(); _audioSyncRateUI();
    var m = document.getElementById('audioMask');
    if(m) m.addEventListener('click', function(e){
      if(e.target.id === 'audioMask'){ closeAudio(); }
    });
    document.addEventListener('fullscreenchange', function(){
      if(!document.fullscreenElement){
        var mm = document.getElementById('audioMask');
        if(mm && mm.classList.contains('fs')){ mm.classList.remove('fs'); var b=document.getElementById('audioFsBtn'); if(b) b.textContent='全屏'; }
      }
    });
    /* 空格键播放/暂停（焦点在播放器内时，避免影响页面其它输入） */
    document.addEventListener('keydown', function(e){
      if(e.key !== ' ' && e.code !== 'Space') return;
      var mm = document.getElementById('audioMask');
      if(!mm || !mm.classList.contains('show')) return;
      var tn = (e.target && e.target.tagName || '').toUpperCase();
      if(tn === 'INPUT' || tn === 'TEXTAREA' || tn === 'SELECT') return;
      e.preventDefault(); audioToggle();
    });
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

/* ============================================================================
 * 横屏切换的启动接线（v3.5.39）
 * ----------------------------------------------------------------------------
 * 单独一个 IIFE 挂在这，不去动别的启动流程：
 *   · initLandscape()  —— 决定这次进来是竖还是横
 *   · resize / orientationchange —— 视口一变重新算要不要 CSS 兜底旋转
 *   · visibilitychange / pageshow —— 从后台切回来、PWA 被系统恢复时对齐一次
 * 都只是「对齐」，不抢锁方向，不会打断用户操作。 */
(function(){
  function boot(){
    try{ initLandscape(); }catch(e){}
    var relayout = function(){ try{ syncLandscapeClass(); }catch(e){} };
    window.addEventListener('resize', relayout, {passive:true});
    window.addEventListener('orientationchange', function(){ setTimeout(relayout, 260); }, {passive:true});
    document.addEventListener('visibilitychange', function(){
      if(document.visibilityState === 'visible') setTimeout(function(){ try{ resyncLandscape(); }catch(e){} }, 120);
    });
    window.addEventListener('pageshow', function(){ setTimeout(function(){ try{ resyncLandscape(); }catch(e){} }, 120); });
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

/* ---- 网页内视频播放（支持 B站分享链接 / 云端直链，均在站内播放，不跳转） ---- */
var _videoUrl = '', _videoTitle = '视频播放'; /* 记住上次播放，供右下角悬浮球重新打开 */
function parseVideo(url){
  url = (url||'').trim();
  /* 1) B站：提取 BV 号 → 站内嵌入 player.bilibili.com（无需跳转） */
  var bili = url.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/i)
          || url.match(/player\.bilibili\.com\/\?bvid=(BV[0-9A-Za-z]+)/i)
          || url.match(/\b(BV[0-9A-Za-z]+)\b/i);
  if(bili){
    var bvid = bili[1] || ''; /* ⚠️ BV 号大小写敏感，严禁 toUpperCase()，否则 B站会报「无法正常播放」 */
    var src = 'https://player.bilibili.com/player.html?bvid='+encodeURIComponent(bvid)+'&page=1&high_quality=1&danmaku=0&autoplay=0';
    return '<div class="video-wrap"><iframe src="'+src+'" scrolling="no" frameborder="0" allowfullscreen="true" allow="autoplay; fullscreen; encrypted-media; picture-in-picture"></iframe></div>'+
      '<div class="video-fallback">📺 由 哔哩哔哩 提供 · <a href="https://www.bilibili.com/video/'+encodeURIComponent(bvid)+'" target="_blank" rel="noopener">在 B站打开</a></div>';
  }
  /* 2) 非 B站：按云端 / 直链视频文件处理（mp4/webm/ogg 等均可） */
  if(/^https?:\/\//i.test(url)){
    return '<div class="video-wrap"><video controls playsinline preload="metadata" src="'+esc(url)+'"></video></div>'+
      '<div class="video-fallback">⚠️ 若无法播放，可能是网盘分享页（非直链）。可 <a href="'+esc(url)+'" target="_blank" rel="noopener">在新标签页打开</a>。</div>';
  }
  return '<div class="video-fallback">视频链接无效，请检查后重试。</div>';
}
function openVideo(url, title){
  url = (url||'').trim();
  if(!url){ alert('该视频链接暂未配置，请联系管理员补充'); return; }
  _videoUrl = url; _videoTitle = title || '视频播放';
  var t = document.getElementById('videoTitle');
  if(t) t.textContent = _videoTitle;
  var body = document.getElementById('videoBody');
  if(body) body.innerHTML = parseVideo(url);
  var m = document.getElementById('videoMask');
  if(m) m.classList.add('show');
  videoBubbleHide();
}
/* 关闭：收起弹窗（保留链接，供右下角悬浮球重新打开），并停播释放资源 */
function closeVideo(){
  var m = document.getElementById('videoMask');
  if(m){ m.classList.remove('show'); m.classList.remove('fs'); }
  var b = document.getElementById('videoFsBtn');
  if(b) b.textContent = '⛶ 放大';
  var body = document.getElementById('videoBody');
  if(body) body.innerHTML = ''; /* 关闭时清空，停止播放并释放资源 */
  if(_videoUrl) videoBubbleShow(); /* 关闭后右下角出现悬浮球，点一下可继续看 */
}
/* 悬浮球：重新打开上次的视频 */
function reopenVideo(){
  if(!_videoUrl) return;
  openVideo(_videoUrl, _videoTitle);
}
function videoBubbleShow(){
  var el = document.getElementById('videoBubble'); if(!el) return;
  el.style.display = 'flex';
  if(typeof actSyncBubble === 'function') actSyncBubble();
}
function videoBubbleHide(){
  var el = document.getElementById('videoBubble'); if(el) el.style.display = 'none';
  if(typeof actSyncBubble === 'function') actSyncBubble();
}
/* 全屏切换：B站播放器内部的全屏按钮在跨域 iframe 内常被浏览器拦截（手机/微信内尤甚），
   故由外层弹窗实现放大，保证全屏一定可用。 */
function toggleVideoFs(){
  var m = document.getElementById('videoMask'); if(!m) return;
  var on = m.classList.toggle('fs');
  var b = document.getElementById('videoFsBtn');
  if(b) b.textContent = on ? '⛶ 还原' : '⛶ 放大';
  try{
    if(on && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function(){});
    else if(!on && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function(){});
  }catch(e){ /* 浏览器不支持真全屏时，仍保留 CSS 铺满视口的效果 */ }
}
document.getElementById('videoMask').addEventListener('click', function(e){ if(e.target.id === 'videoMask') closeVideo(); });
/* 退出浏览器真全屏时，同步还原弹窗放大态，避免状态不一致 */
document.addEventListener('fullscreenchange', function(){
  if(!document.fullscreenElement){
    var m = document.getElementById('videoMask');
    if(m && m.classList.contains('fs')){ m.classList.remove('fs'); var b=document.getElementById('videoFsBtn'); if(b) b.textContent='⛶ 放大'; }
  }
});

/* ---- 横屏查看：优先尝试系统横屏锁定，失败则提示用户手动旋转 ----
   ⚠️ 注意：现代浏览器对 screen.orientation.lock 限制严格——多数要求「已处于全屏」且移动端才可用，
   桌面浏览器 / 部分安卓浏览器会直接 reject。因此必须保留「提示用户手动旋转」的兜底。 */
function rotateVideoLandscape(){
  var tipped = false;
  try{
    /* 先进入真全屏（部分浏览器要求全屏后才允许锁定方向） */
    if(document.documentElement.requestFullscreen && !document.fullscreenElement){
      var r = document.documentElement.requestFullscreen();
      if(r && r.catch) r.catch(function(){});
    }
    if(screen.orientation && screen.orientation.lock){
      var p = screen.orientation.lock('landscape');
      if(p && p.catch) p.catch(function(){});
    }
  }catch(e){ /* 忽略：交给下面的兜底提示 */ }
  /* 无论锁定是否成功，都提示用户手动横屏（自动旋转开着时转一下就好）
     ⚠️ 判断是否已横屏必须用「视口宽 > 视口高」，不能信 screen.orientation.type——
     实测桌面 Chromium 会回报 "landscape-primary" 而视口其实是 420×860（竖屏），会导致误判为已横屏而不提示。 */
  setTimeout(function(){
    var alreadyLandscape = window.innerWidth > window.innerHeight;
    if(!alreadyLandscape){
      showVideoTip('📱 请把手机横过来（或打开「自动旋转」后转动手机），画面就会自动变大');
    } else {
      showVideoTip('✅ 已横屏，享受大画面吧～');
    }
  }, 700);
}
function showVideoTip(msg){
  var tip = document.getElementById('videoRotateTip');
  if(!tip) return;
  var span = tip.querySelector('span');
  if(span){ span.textContent = msg; }
  tip.style.animation='none'; void tip.offsetWidth; tip.style.animation='';
}


/* ---- 渲染主页面 ---- */
function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* ---- 倒计时 ---- */
function pad2(n){ return (n<10?'0':'') + n; }
function calendarDiff(target, from){
  var months = (target.getFullYear()-from.getFullYear())*12 + (target.getMonth()-from.getMonth());
  function atSame(m){ return new Date(from.getFullYear(), from.getMonth()+m, from.getDate(), from.getHours(), from.getMinutes(), from.getSeconds()); }
  var d = atSame(months);
  if(d > target){ months--; d = atSame(months); }
  var rem = target.getTime() - d.getTime();
  var days = Math.floor(rem/86400000); rem -= days*86400000;
  var hours = Math.floor(rem/3600000); rem -= hours*3600000;
  var mins = Math.floor(rem/60000); rem -= mins*60000;
  var secs = Math.floor(rem/1000);
  return { months:months, days:days, hours:hours, minutes:mins, seconds:secs };
}
function calendarMD2(target, from){
  var months = (target.getFullYear()-from.getFullYear())*12 + (target.getMonth()-from.getMonth());
  var atSame = function(m){ return new Date(from.getFullYear(), from.getMonth()+m, from.getDate()); };
  var d = atSame(months);
  if(d > target){ months -= 1; d = atSame(months); }
  var days = Math.floor((target.getTime() - d.getTime())/86400000);
  return { months: months, days: days };
}
function impTotalDays(target, from){
  return Math.max(0, Math.floor((target.getTime()-from.getTime())/86400000));
}
function impRemainFold(target, from){
  var sec = Math.max(0, Math.floor((target.getTime()-from.getTime())/1000));
  var d = Math.floor(sec/86400);
  var h = Math.floor((sec%86400)/3600);
  var m = Math.floor((sec%3600)/60);
  return d+'天 '+h+'时 '+m+'分';
}
/* 重要日期的结束时刻：
   单日事项 = 它自己的时刻；范围事项（填了 endDate）= 结束日的 23:59:59 */
function impEndOf(it){
  return it.endDate ? new Date(it.endDate + 'T23:59:59') : new Date(it.date);
}
/* 一条重要日期此刻的状态（站主 2026-10-14 定的规则）：
     'before' 未开始 —— 正常显示倒计时
     'during' 进行中 —— 范围事项已进入区间，显示「进行中」三个字
     'over'   已结束 —— 倒计时面板直接隐藏，不再占位
   单日事项没有「进行中」：到点即结束（「到那个地方然后就过了」）。
   范围事项必须有 endDate 才有「进行中」，否则按单日处理。 */
function impState(it, now){
  var start = new Date(it.date);
  var end = impEndOf(it);
  if(now.getTime() > end.getTime()) return 'over';
  if(it.endDate && now.getTime() >= start.getTime()) return 'during';
  return 'before';
}
/* 右侧文案：进行中 → 三个字；否则 → 精确到秒的倒计时 */
function impRightText(it, now){
  if(impState(it, now) === 'during') return '<span class="imp-during">进行中</span>';
  var f = calendarDiff(new Date(it.date), now);
  return f.months+'月 '+f.days+'天 '+pad2(f.hours)+'时 '+pad2(f.minutes)+'分 '+pad2(f.seconds)+'秒';
}
function updateCountdown(){
  var box = document.getElementById('countdown');
  if(!box) return;
  var now = new Date();
  /* 只保留「未开始 / 进行中」，已结束的整条从首页面板消失 */
  var semList = IMPORTANT_DATES.map(function(d){ return { name:d.name, date:d.date, endDate:d.endDate, d:new Date(d.date) }; })
    .sort(function(a,b){ return a.d - b.d; })
    .filter(function(d){ return impState(d, now) !== 'over'; });
  var semHtml = '<div class="cd-sem">' +
    '<div class="cd-head">'+iconSvg('calendar',15)+' 重要日期倒计时<span class="cd-viewall" onclick="openAllImp()" style="cursor:pointer">查看全部</span></div>' +
    (semList.length === 0 ? '<div class="cd-empty">暂无重要日期</div>' :
      '<div class="imp-mobile">' +
        '<div class="imp-area">' +
          '<div class="imp-fold" onclick="openAllImp()" tabindex="0" role="button" aria-label="查看全部重要日期">' +
            '<div class="imp-fold-name">'+esc(semList[0].name)+'</div>'+
            '<div class="imp-fold-main">'+(impState(semList[0], now)==='during' ? '<span class="imp-during">进行中</span>' : impRemainFold(semList[0].d, now))+'</div>'+
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="imp-desktop">' +
        '<ul>' +
        semList.slice(0,4).map(function(d){
          return '<li class="imp-desk-row"><span class="cd-name">'+esc(d.name)+'</span><span class="imp-full">'+impRightText(d, now)+'</span></li>';
        }).join('') +
        '</ul>' +
      '</div>'
    ) + '</div>';
  var upcoming = HOLIDAYS.map(function(h){ return { name:h.name, date:h.date, days:h.days, d:new Date(h.date+'T00:00:00') }; })
    .filter(function(h){ var t=new Date(now.getFullYear(),now.getMonth(),now.getDate()); return h.d >= t; })
    .sort(function(a,b){ return a.d - b.d; })
    .slice(0,3);
  var holHtml = '<div class="cd-hol cd-clickable" onclick="openAllHol()" role="button" tabindex="0">' +
    '<div class="cd-head">'+iconSvg('timer',15)+' 节假日倒计时<span class="cd-viewall">查看全部</span></div>' +
    (upcoming.length===0 ? '<div class="cd-empty">本学期暂无更多法定节假日 '+iconSvg('party-popper',15)+'</div>' :
      '<ul class="flex flex-col justify-center gap-2 md:gap-2.5">' +
      upcoming.map(function(h){
        var left = Math.ceil((h.d.getTime()-now.getTime())/86400000);
        return '<li class="cd-row"><div><div class="cd-name">'+esc(h.name)+'</div><div class="cd-sub">'+esc(h.date.slice(5))+' 放假 '+h.days+' 天</div></div>' +
          '<div class="cd-days"><b>'+left+'</b><span>天</span></div></li>';
      }).join('')
    ) + '</div>';
  box.innerHTML = semHtml + holHtml;
}
function cdUnits(d){
  return '<div class="cd-box"><span class="cd-num">'+pad2(d.months)+'</span><span class="cd-unit">月</span></div>' +
    '<div class="cd-box"><span class="cd-num">'+pad2(d.days)+'</span><span class="cd-unit">天</span></div>' +
    '<div class="cd-box"><span class="cd-num">'+pad2(d.hours)+'</span><span class="cd-unit">时</span></div>' +
    '<div class="cd-box"><span class="cd-num">'+pad2(d.minutes)+'</span><span class="cd-unit">分</span></div>' +
    '<div class="cd-box"><span class="cd-num">'+pad2(d.seconds)+'</span><span class="cd-unit">秒</span></div>';
}

/* 公告分类筛选状态：'all' 或 site/class/activity/misc */
var annFilter = 'all';

/* 置顶是否仍生效：支持限时置顶（importantUntil 之后自动失效） */
function isImportant(a){
  if(!a || !a.important) return false;
  if(a.importantUntil && new Date(a.importantUntil).getTime() <= Date.now()) return false;
  return true;
}

/* 公告栏（支持分类筛选；置顶永远在最上方；弹窗内按分类小节展示） */
function renderBoard(){
  var annAll = (SITE_DATA.announcements || []);
  var ann = annAll.slice().sort(function(a,b){
    if((isImportant(b)?1:0) !== (isImportant(a)?1:0)) return (isImportant(b)?1:0) - (isImportant(a)?1:0);
    return (b.date || '').localeCompare(a.date || '');
  });
  var board = document.getElementById('board');
  if(ann.length === 0){ board.style.display = 'none'; return; }
  var filtered = (annFilter && annFilter !== 'all') ? ann.filter(function(a){ return (a.category || 'misc') === annFilter; }) : ann;
  /* 【自定义设置】uiAnnCats 把 '总览' 钉在最后，其余按用户顺序 */
  var CATS = uiAnnCats([
    { key: 'site',    name: '📡 网站内部' },
    { key: 'activity',name: '🔔 重要更新' },
    { key: 'class',   name: '🏫 班级事务' },
    { key: 'misc',    name: '💭 站主杂谈' },
    { key: 'all',     name: '总览' }
  ]);
  var filterBar = '<div class="board-filters">' + CATS.map(function(c){
    return '<button class="filter-btn' + (annFilter === c.key ? ' active' : '') + '" onclick="setAnnFilter(\'' + c.key + '\')">' + esc(c.name) + '</button>';
  }).join('') + '</div>';
  function renderList(items){
    return '<ul class="board-list">' + items.map(function(a){
      return '<li>' +
        '<div class="board-meta">' +
          '<span class="board-date' + (isImportant(a) ? ' hot' : '') + '">' + esc(a.date.slice(5)) + '</span>' +
          /* 永久置顶显示「置顶」，限时置顶显示「限时置顶」——让同学知道它什么时候会掉下来 */
          (isImportant(a) ? '<span class="board-pin">' + (a.importantUntil ? '限时置顶' : '置顶') + '</span>' : '') +
        '</div>' +
        '<p class="board-text' + (isImportant(a) ? ' important' : '') + '">' + emojiEscHtml(a.text) + '</p>' +
      '</li>';
    }).join('') + '</ul>';
  }
  var body = '';
  if(annFilter === 'all'){
    var pinned = filtered.filter(isImportant);
    var others = filtered.filter(function(a){ return !isImportant(a); });
    var visibleAnn = pinned.concat(others.slice(0, pinned.length ? 1 : 2));
    var hiddenCount = ann.length - visibleAnn.length;
    body = renderList(visibleAnn) + (hiddenCount > 0 ? '<button class="board-more" onclick="showAllBoard()">查看全部 ' + hiddenCount + ' 条公告</button>' : '');
  }else if(filtered.length === 0){
    body = '<div class="board-empty">该分类暂无公告</div>';
  }else{
    body = renderList(filtered);
  }
  board.style.display = '';
  board.innerHTML =
    '<div class="board-head"><h2>📢 公告</h2><span class="board-count">' + filtered.length + ' 条</span>' +
    '<button class="btn-qr" id="acctBtn" onclick="openAccount()">登录</button>' +
    '<button class="btn-qr" onclick="openQr(\'' + SITE_DATA.qrUrl + '\')">公众号</button>' +
    '<button class="btn-qr" style="background:#3e3733" onclick="openRepoDialog()">仓库</button></div>' +
    filterBar + body;
  /* 公告栏是整块重绘的，所以每次都得把登录按钮的状态同步一次 */
  refreshAcctBtn();
}
function setAnnFilter(cat){
  annFilter = cat;
  renderBoard();
}

function render(){
  renderBoard();
  renderSignBar();

  /* 每日日报（独立区域，公告下方 / 倒计时上方） */
  var dailyEl = document.getElementById('dailyNews');
  if(dailyEl){
    var dailyLink = null;
    for(var d=0;d<SITE_DATA.links.length;d++){ if(SITE_DATA.links[d].categoryId===0){ dailyLink=SITE_DATA.links[d]; break; } }
    if(dailyLink){
      dailyEl.innerHTML =
        '<div class="daily-card">'+
          '<div class="daily-icon ink-auto">日报</div>'+
          '<div class="daily-info"><div class="daily-title">每日日报</div><div class="daily-sub">实时热点资讯聚合</div></div>'+
          '<button class="btn daily-btn" onclick="openLink(\''+jsq(dailyLink.mainUrl)+'\','+(dailyLink.mainWechatOk?'true':'false')+',\'每日日报\')">'+esc(dailyLink.mainLabel||'前往查看')+'</button>'+
        '</div>';
    }
  }

  renderDailyQuote();
  fetchRemoteQuote();   /* v2.6.0：联网换一句（失败静默，本地那句留着） */
  renderStudyCard();    /* v2.6.0：学习卡片（本地随机，联网内容稍后补） */
  fetchStudyRemote();

  var cats = uiCats();   /* 【自定义设置】经顺序覆盖层取，顺序即用户顺序 */
  buildSidebar();

  var grid = document.getElementById('grid');
  grid.innerHTML = cats.map(function(c,i){
    var links = uiLinks(c.id);   /* 【自定义设置】经顺序覆盖层取 */
    var inner;
    /* 成绩分析（板块 3）：站主 2026-10-15 原话「点开成绩分析直接展示而不是卡片+弹窗」
       —— 这个板块不再放卡片，直接把成绩分析本体铺进来（骨架见 scEmbedHtml）。 */
    if(c.id === 3){
      inner = scEmbedHtml();
    }else if(c.id === 9){
      inner = installGuideHtml();
    }else if(links.length === 0){
      inner = '<div class="placeholder"><span>➕</span>该板块内容正在筹备中，敬请期待</div>';
    }else{
      inner = links.map(function(l){
        var fallback = esc(l.iconText || (l.title||'').charAt(0) || '链');
        var iconHtml = l.icon
          ? '<img src="'+esc(l.icon)+'" alt="'+esc(l.title)+'" loading="lazy" decoding="async" width="44" height="44" onerror="this.outerHTML=\'<div class=&quot;fallback ink-auto&quot;>'+fallback+'</div>\'">'
          : '<div class="fallback ink-auto">'+fallback+'</div>';
        var needBrowser = isWeChat() && !l.mainWechatOk && httpUrl(l.mainUrl);
        /* 门禁总开关关闭时直接视为「已通过」，不再渲染问答框（GATE_ENABLED=false） */
        var passed = gatePassed(l) || !gateOn();
        var contentHtml = '<div class="card-content"><h3>'+esc(l.title)+'</h3>'+(l.subtitle?'<p class="card-sub">'+esc(l.subtitle)+'</p>':'')+(l.desc?'<p>'+esc(l.desc)+'</p>':'');
        if(l.paused){
          contentHtml += '<div class="paused-box">'+(l.pausedMsg ? emojiEscHtml(l.pausedMsg) : (iconSvg('ban',15)+' 因网络问题，暂时关闭，恢复开放时间另行通知'))+'</div>';
        }else if(l.gate && !passed){
          var _lr = lockRemain('gate_'+l.id);
          var _lockMsg = _lr > 0 ? '🔒 连续输错次数过多，请 ' + Math.ceil(_lr/1000) + ' 秒后再试' : '';
          var _errMsg = _lockMsg || (window.__gateErr && window.__gateErr[l.id] ? '💡 ' + esc(window.__gateErr[l.id]) : '');
          contentHtml += '<div class="gate-box"><p class="gate-q">🔒 '+esc(l.gate.question)+'</p>'+
            '<div class="gate-row"><span class="gate-input-wrap"><input id="gate-input-'+l.id+'" type="text" placeholder="'+(_lr>0?'锁定中，请稍候…':'请输入答案')+'" class="gate-input pwd-mask" autocomplete="off"'+(_lr>0?' disabled':'')+' onkeydown="if(event.key===\'Enter\')checkGate('+l.id+')">'+
            '<button type="button" class="eye-btn" style="display:inline-flex;align-items:center;justify-content:center" onclick="togglePwd(\'gate-input-'+l.id+'\', this)"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></span>'+
            '<button class="btn gate-btn"'+( _lr>0 ? ' disabled style="opacity:.5"' : '' )+' onclick="checkGate('+l.id+')">验证答案</button></div>'+
            (_errMsg ? '<p class="gate-hint">'+_errMsg+'</p>' : '')+
            '</div>';
        }
        if(l.contactQuery){
          /* 个人资料查询（2026-10-05 改版）
             ------------------------------------------------------------
             ⚠️ 这次改版的根本原因：旧方案把姓名哈希 + XOR 密文放在前端 JS 里，
             而密钥就在同一份 JS 中，等于公开（公开仓库 + 公开站点）。
             现在数据全部搬到后端数据库，本页只做「展示 + 转发查询」，
             源码里不再有任何通讯录数据。

             必须登录：未登录只显示登录引导，不给任何资料。
             查询行为会记录到后端（谁在什么时候查了谁），管理员可查。 */
          if(!isLoggedIn()){
            contentHtml += '<div class="gate-box"><p class="gate-q">🔐 请先登录后查询资料</p>'+
              '<p class="gate-hint" style="color:#6e635a;font-weight:400;margin:6px 0 10px">为保护同学隐私，资料查询需要登录。登录后可查询姓名或学号，并查看是否需要补充自己的联系方式。</p>'+
              '<div class="gate-row"><button class="btn gate-btn" onclick="openAccount(\'login\')">去登录</button></div>'+
              '</div>';
          }else{
            contentHtml += '<div class="gate-box"><p class="gate-q">📇 输入姓名或学号查询资料</p>'+
              '<div class="gate-row"><input id="contact-input-'+l.id+'" type="text" placeholder="请输入姓名或学号" class="gate-input" onkeydown="if(event.key===\'Enter\')findContact('+l.id+')">'+
              '<button class="btn gate-btn" onclick="findContact('+l.id+')">查询</button></div>'+
              '<p id="contact-out-'+l.id+'" class="gate-hint" style="color:#6e635a;font-weight:400"></p>'+
              '</div>';
          }
        }else if(l.needLogin && !isLoggedIn()){
          /* 第二十七轮（2026-10-07）：成绩查询 / 意见反馈 需登录后查看。
             未登录只给引导，不渲染入口，避免隐私内容被未登录同学点开。 */
          contentHtml += '<div class="gate-box"><p class="gate-q">🔐 请先登录后查看</p>'+
            '<p class="gate-hint" style="color:#6e635a;font-weight:400;margin:6px 0 10px">'+esc(l.title)+'需要登录后才能打开。登录后回到这里点开即可进入。</p>'+
            '</div>';
        }
        contentHtml += (l.cardTip ? '<p class="card-hw-tip" style="font-size:.78rem;color:#af410f;margin-top:6px;line-height:1.6">'+esc(l.cardTip)+'</p>' : '');
        contentHtml += '</div>';
        var actionsHtml;
        if(l.paused){
          actionsHtml = ''; /* 暂停开放：不渲染任何入口按钮与门禁 */
        }else if(l.gate){
          if(passed){
            actionsHtml = '';
            /* 链接与访问码走 gateUrl()/gateCode() 运行时解混淆，源码里只有密文 */
            var _gu = gateUrl(l), _gc = gateCode(l);
            if(_gu){
              actionsHtml += '<button class="btn" onclick="openLink(\''+jsq(_gu)+'\',true)">打开链接</button>';
            }else{
              actionsHtml += '<span class="gate-tip">链接待开放</span>';
            }
            if(_gc){
              actionsHtml += '<button class="btn btn-secondary" onclick="copyCode('+l.id+')">访问码：'+esc(_gc)+'</button>';
            }
            if(isWeChat() && _gu){
              actionsHtml += '<span class="wechat-hint">建议复制链接到浏览器打开</span>';
            }
          }else{
            actionsHtml = '<span class="gate-tip">答对后获取访问码</span>';
          }
        }else if(l.comingSoon){
          var _csMsg = l.comingSoonMsg || '功能开发中，敬请期待';
          actionsHtml = '<button class="btn btn-disabled" onclick="alert(\''+jsq(_csMsg)+'\')">'+esc(l.mainLabel||'待开发')+'</button>';
        }else if(l.contactQuery){
          actionsHtml = '<span class="gate-tip">输入姓名查询</span>';
        }else if(l.needLogin && !isLoggedIn()){
          actionsHtml = '<button class="btn" onclick="openAccount(\'login\')">去登录后查看</button>';
        }else if(l.video){
          /* 视频类卡片：整卡即入口，不再需要「▶ 播放视频」二级按钮（用户要求） */
          actionsHtml = '<span class="gate-tip">点卡片任意位置即可在站内观看，无需跳转 B站</span>';
        }else if(l.customActions && l.customActions.length){
          actionsHtml = l.customActions.map(function(a){
            var style = a.style || '';
            var cls = style==='secondary' ? 'btn-secondary' : style==='gray' ? 'btn-gray' : '';
            return '<button class="btn '+cls+'" onclick="'+esc(a.onclick||'')+'">'+esc(a.label||'按钮')+'</button>';
          }).join('');
        }else{
          actionsHtml = (l.qrImage
            ? '<button class="btn btn-green" onclick="openQr(\''+jsq(l.qrImage)+'\')">'+esc(l.mainLabel||'查看公众号')+'</button>'
            : '<button class="btn" onclick="openLink(\''+jsq(l.mainUrl)+'\','+(l.mainWechatOk?'true':'false')+',\''+jsq(l.title||'')+'\')">'+esc(l.mainLabel||'前往入口')+'</button>')+
            (l.extraLabel ? '<button class="btn btn-secondary" onclick="openLink(\''+jsq(l.extraUrl)+'\','+(l.extraWechatOk?'true':'false')+',\''+jsq((l.title||'')+' · '+l.extraLabel)+'\')">'+esc(l.extraLabel)+'</button>' : '')+
            (needBrowser ? '<span class="wechat-hint">微信内请按引导用浏览器打开</span>' : '');
        }
        /* 视频类卡片整卡可点：点卡片任意位置直接弹视频，无需二级按钮 */
        var cardCls = 'card' + (l.paused?' card-paused':'') + (l.video?' card-clickable':'');
        var cardClick = l.video ? ' onclick="openVideo(\''+jsq(l.video)+'\',\''+jsq(l.title)+'\')"' : '';
        return '<div class="'+cardCls+'" data-card="'+attr(l.id)+'"'+cardClick+'>'+
          '<div class="card-icon">'+iconHtml+'</div>'+
          contentHtml+
          '<div class="card-actions">'+actionsHtml+'</div>'+
        '</div>';
      });
      /* 【卡片堆叠 v35】同一分类下 ≥2 张卡片时包一层堆叠容器；仅 1 张时不包（堆叠无意义）。
         用户可在「自定义设置 → 动效」里关掉堆叠，回到传统平铺。 */
      inner = (UI.stack !== 0 && inner.length >= 2) ? stackDeckHtml(inner, c.id) : inner.join('');
    }
    return '<div class="tab-page" id="tab-cat-'+c.id+'">'+boardIntroHtml(c.id)+popBannerHtml(c.id)
      /* v3.5.6 投票专区：挂在「班级事务」板块顶部，原有卡片照旧排在下面
         （投票是给人看结果/动手的地方，不该被卡片挤到页面底部） */
      + (c.id === 7 ? voteEmbedHtml() : '')
      + inner+'</div>';
  }).join('');

  Array.prototype.forEach.call(grid.querySelectorAll('.tab-page'), function(p){ p.classList.remove('active'); });
  /* 恢复当前视图：分类页保持激活、首页则显示 homeView。避免 checkGate 等触发重渲染后整页空白 */
  if(__activeCat != null){
    var page2 = document.getElementById('tab-cat-'+__activeCat);
    if(page2) page2.classList.add('active');
    var home2 = document.getElementById('homeView');
    if(home2) home2.style.display = 'none';
    grid.style.display = 'block';
  }else{
    var home3 = document.getElementById('homeView');
    if(home3) home3.style.display = 'block';
    grid.style.display = 'none';
  }
  applyHomeOrder();   /* 【自定义设置】首页区块顺序：任何重渲染都顺带纠正 */
  stackApply();       /* 【卡片堆叠 v35】重建后重算层叠位移（门禁答题等触发重渲染时保持堆叠） */
  /* 成绩分析是内嵌的：这次重建会把 tab-cat-3 里的成绩分析画布一起冲掉，
     所以只要当前就在那个板块，就重挂一次（数据还在内存里，不会重复请求）。 */
  if(__activeCat === 3 && typeof scEnsureMounted === 'function'){ scEnsureMounted(); }
  /* v3.5.6 投票专区同理：板块 7 重建后重挂一次 */
  if(__activeCat === 7 && typeof voteEnsureMounted === 'function'){ voteEnsureMounted(); }
  /* v3.8.4：render 会整体重建 #grid / #sideCats，游客态的置灰必须重新打一遍 */
  if(typeof applyGuestUI === 'function') applyGuestUI();
}
function jsq(u){ return (u||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }

/* =====================================================
   卡片堆叠（v35）
   -----------------------------------------------------
   同一分类下有多张卡片时，层叠成一沓、只露顶牌，可点击「展开」铺平。
   交互：
     · 顶部的 ↑ / ↓ 按钮 —— 上下轮换（顶牌循环移到底部/从底部取一张到顶部）
     · 在堆叠区用滚轮 / 手指上下滑动 —— 同样的轮换
     · 「展开 / 收起」按钮 —— 在堆叠态与平铺态之间切换
   实现：纯 CSS transform + transition，JS 只负责算序号与写样式；不用任何库。
   状态：展开与否记在 STACK_OPEN 里（按分类 id 存），render() 重建后能恢复。
   ===================================================== */
var STACK_OPEN = {};       /* { 分类id: true } —— 哪些堆叠当前是展开的 */

/* 生成一个堆叠容器。cards 是已渲染好的卡片 HTML 数组，catId 用于记忆展开状态 */
function stackDeckHtml(cards, catId){
  if(!cards || cards.length < 2) return (cards || []).join('');
  var open = STACK_OPEN[catId] === true;
  var body = cards.map(function(h){
    return '<div class="stack-item">' + h + '</div>';
  }).join('');
  return '<div class="stack-deck' + (open ? ' is-open' : '') + '" data-cat="' + catId + '">' +
    stackBarHtml(cards.length, open) +
    '<div class="stack-body">' + body + '</div>' +
  '</div>';
}

/* 顶部操作条：张数徽标 + ↑↓ 轮换 + 展开/收起 */
function stackBarHtml(n, open){
  return '<div class="stack-bar">' +
    '<span class="stack-count">共 ' + n + ' 个入口</span>' +
    (open ? '' :
      '<button type="button" class="stack-nav" title="上一张" aria-label="上一张" onclick="stackShift(this,-1)">↑</button>' +
      '<button type="button" class="stack-nav" title="下一张" aria-label="下一张" onclick="stackShift(this,1)">↓</button>') +
    '<button type="button" class="stack-toggle" onclick="stackToggle(this)">' +
      (open ? '收起' : '展开全部') + '</button>' +
  '</div>';
}

/* 按当前 DOM 顺序，重算栈内每张卡的高度与层叠位移。
   【统一高度】先把 --deck-h 清掉量出每张卡的自然高度，取最大值写回 --deck-h，
   让所有 item 一样高——否则矮卡片挡不住高卡片，下面的内容会从底边漏出来。
   【看穿过滤】层与层必须有足够间距，否则下面的卡片会被上面完全盖住、看不出是一沓。 */
function stackApply(){
  var decks = document.querySelectorAll('.stack-deck');
  Array.prototype.forEach.call(decks, function(deck){
    var open = deck.classList.contains('is-open');
    var items = Array.prototype.slice.call(deck.querySelectorAll(':scope > .stack-body > .stack-item'));
    if(!items.length) return;
    deck.setAttribute('data-n', items.length);
    if(open){
      deck.style.removeProperty('--deck-h');       /* 展开态回到各自自然高度 */
      deck.style.paddingBottom = '';               /* 清掉堆叠态为露出边缘留的余量 */
      items.forEach(function(it){
        it.classList.remove('stack-top');
        it.style.transform = '';
        it.style.zIndex = '';
        it.removeAttribute('aria-hidden');
        it.style.removeProperty('--cover');       /* 展开态不做裁剪，清掉露出量 */
      });
      return;
    }
    /* ⚠️ 所属分类还没显示（display:none）时量不到高度，全部为 0。
       render() 里会先调本函数，而那时 .tab-page 往往还不是 active——
       所以这里直接返回，等 openCat() 切到该分类后再调一次（见 openCat）。 */
    if(!deck.offsetHeight && !deck.offsetWidth) return;

    /* ① 量自然高度：先把所有 item 的 transform 与统一高度都摘掉，
          否则量到的是「上一次缩放后的视觉高度」，算出来的统一高度会一代代缩水。
          摘掉后强制读一次 offsetHeight 逼浏览器重排，确保量的是干净的自然高度。 */
    deck.style.removeProperty('--deck-h');
    items.forEach(function(it){ it.style.transform = ''; });
    void deck.offsetHeight;                              /* 强制回流，让上面的清空生效 */
    var maxH = 0;
    items.forEach(function(it){
      /* 用 offsetHeight 而非 getBoundingClientRect：后者受 CSS 变换影响 */
      var h = it.offsetHeight || 0;
      if(h > maxH) maxH = h;
    });
    if(maxH > 0) deck.style.setProperty('--deck-h', Math.ceil(maxH) + 'px');

    /* ② 每层露出的边缘：堆得松一些，层次更清楚（跟随用户字号缩放） */
    var EDGE = Math.round(46 * (UI.fs || 1));
    /* 统一高度（px）。所有 item 都一样高，所以位移基准用同一个值。 */
    var H = Math.ceil(maxH) || 0;
    items.forEach(function(it, i){
      it.classList.toggle('stack-top', i === 0);
      it.style.zIndex = String(items.length - i);   /* 越靠上层级越高 */
      if(i === 0){
        it.style.transform = '';                    /* 顶牌不位移，靠它定整体位置 */
        it.removeAttribute('aria-hidden');
      }else{
        /* 下层整体下移到「顶牌底边 - 露出量」处，露出它自己最上面的 EDGE 一条。
           若用 i*EDGE 累加，位移太小会被顶牌整个盖住，看不出是一沓（实测问题）。 */
        var y = Math.max(0, H - EDGE * i);
        var sc = 1 - i * 0.018;                      /* 逐层极轻微缩小，做出纵深 */
        var rot = (i % 2 ? 1 : -1) * (i * 0.4);      /* 左右交替微旋转，像一沓牌 */
        it.style.transform = 'translateY(' + y + 'px) scale(' + sc + ') rotate(' + rot + 'deg)';
        it.setAttribute('aria-hidden', 'true');
        /* 把卡片裁成只剩顶边一条，并另叠一层同色底板挡住内容
           （卡片顶部有 24px 内边距，只裁剪仍会露出图标上半截——实测问题） */
        it.style.setProperty('--cover', EDGE + 'px');
        var card = it.querySelector(':scope > .card');
        it.classList.toggle('is-paused', !!(card && card.classList.contains('card-paused')));
      }
    });
    /* ③ 栈体总高要容下最下面那张露出的边：比单张卡高再多出 (n-1)*EDGE */
    deck.style.paddingBottom = (items.length - 1) * EDGE + 'px';
  });
}

/* 上下轮换：dir=1 顶牌移到底部（像往下翻），dir=-1 底牌移到顶部 */
function stackShift(btn, dir){
  var deck = btn && btn.closest ? btn.closest('.stack-deck') : null;
  if(!deck || deck.classList.contains('is-open')) return;
  var body = deck.querySelector(':scope > .stack-body');
  if(!body) return;
  var items = body.children;
  if(items.length < 2) return;
  if(dir === 1){                       /* 顶牌移到末尾 */
    body.appendChild(items[0]);
  }else{                               /* 末牌移到最前 */
    body.insertBefore(items[items.length - 1], items[0]);
  }
  if(typeof SFX !== 'undefined' && SFX && SFX.click) SFX.click();
  stackApply();
}

/* 展开 / 收起切换（状态按分类记忆，render() 重建后沿用） */
function stackToggle(btn){
  var deck = btn && btn.closest ? btn.closest('.stack-deck') : null;
  if(!deck) return;
  var catId = deck.getAttribute('data-cat');
  var open = !deck.classList.contains('is-open');
  deck.classList.toggle('is-open', open);
  if(catId != null){ if(open) STACK_OPEN[catId] = true; else delete STACK_OPEN[catId]; }
  /* 重建顶部操作条（展开态不显示 ↑↓） */
  var bar = deck.querySelector(':scope > .stack-bar');
  var n = deck.querySelectorAll(':scope > .stack-body > .stack-item').length;
  if(bar) bar.outerHTML = stackBarHtml(n, open);
  if(typeof SFX !== 'undefined' && SFX && SFX.click) SFX.click();
  stackApply();
}

/* 滚轮 / 触摸：在堆叠区上下滑动即轮换（在 #grid 上做事件委托，
   #grid 本身不被 render() 重建，所以只需绑一次） */
(function(){
  var lock = 0;
  function deckOf(t){
    if(!t || !t.closest) return null;
    var d = t.closest('.stack-deck');
    return (d && !d.classList.contains('is-open')) ? d : null;
  }
  function shift(deck, dir){
    if(!deck) return;
    var body = deck.querySelector(':scope > .stack-body');
    if(!body || body.children.length < 2) return;
    var now = Date.now();
    if(now - lock < 420) return;            /* 防抖：一次滑动只轮换一张 */
    lock = now;
    if(dir === 1) body.appendChild(body.children[0]);
    else body.insertBefore(body.children[body.children.length - 1], body.children[0]);
    stackApply();
  }
  document.addEventListener('wheel', function(e){
    var deck = deckOf(e.target);
    if(!deck) return;
    /* 堆叠态下卡片是叠着的，没有独立滚动区，因此直接接管滚轮做轮换；
       但若指针落在卡片内部的滚动容器上，则让位给正常滚动 */
    var sc = e.target.closest ? e.target.closest('.stack-item') : null;
    if(sc && sc.scrollHeight > sc.clientHeight + 4) return;
    e.preventDefault();
    shift(deck, e.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  var ty = 0, tDeck = null;
  document.addEventListener('touchstart', function(e){
    tDeck = deckOf(e.target);
    ty = e.touches && e.touches[0] ? e.touches[0].clientY : 0;
  }, { passive: true });
  document.addEventListener('touchend', function(e){
    if(!tDeck) return;
    var y = e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientY : ty;
    var dy = ty - y;
    if(Math.abs(dy) > 42) shift(tDeck, dy > 0 ? 1 : -1);
    tDeck = null;
  }, { passive: true });
})();


/* =====================================================
 * 【自定义设置 + 交互动效】
 * 交互模式参照 Advanced Interaction Design 规范，落地 7 种：
 *   ① Radial Theme Transition  圆形主题切换
 *   ② Drag-to-Reorder          拖拽排序（Pointer Events 通用）
 *   ③ Velocity Slider Snap     速度吸附滑块
 *   ④ Animated Text Disclosure 文本展开（真实高度测量）
 *   ⑤ Stepper Progress         步骤流程
 *   ⑥ Ripple for Switches      开关涟漪
 *   ⑦ Expanding Tag Selection  标签选择展开
 *
 * ⚠️ 架构要点（重要，改前必读）：
 *   render() 会整体重建 #grid / #sideCats 的 innerHTML，
 *   所以**排序信息只存数据、不存 DOM**，每次渲染时经 applyOrder 重新读取。
 *   任何"拖拽后直接改 DOM"的写法都会被下一次 render() 冲掉。
 * ===================================================== */

var UI_KEY = 'cls_ui_cfg', UI_BG_KEY = 'cls_ui_bgimg', UI_V = 3;
/* v2：卡片堆叠默认关闭（试验功能，站主拍板）。v1 时期默认是开，
   升级时把老配置里带上的 stack=1 一并复位，避免老用户一直停在试验状态。 */

/* 默认配置。order 为空数组/空对象 = 使用数据源原始顺序 */
function uiDefault(){
  return {
    v: UI_V,
    fs: 1,              /* 字号缩放 0.85 ~ 1.35 */
    motion: 1,          /* 1 = 完整动效，0 = 精简 */
    stack: 0,           /* 【卡片堆叠 v35】1 = 多卡片分类层叠展示，0 = 传统平铺
                           默认关闭：堆叠效果仍在试验中，观感不理想，暂不作为默认（站主拍板） */
    netWatch: 0,        /* 【网络状态提示】1 = 连不上时弹横幅并倒计时重试，0 = 不打扰
                           2026-10-15 站主要求「网络检测暂时关闭」，故默认 0。
                           心跳照旧在跑（后台在线状态靠它），这里只控制弹不弹提示。 */
    quoteNet: 1,        /* 【每日一言来源 v3.5.6】1 = 联网 hitokoto（动画/文学/诗词类），
                           0 = 只用本地库（管理员在后台配的句子）。联网失败时两种模式都回退本地。 */
    /* 【轻量模式 v3.5.30 · v3.5.31 改手动】1 = 关掉玻璃模糊 / 背景光斑 / 流光扫过等重特效，
       0 = 全开。默认 0（完整）。
       站主原话：「iPad Air 打开完全卡顿，动不了，勉强操作后页面完全变白。
       能不能自定义取消玻璃光效，还有其他动画特效，尽量在确保不卡顿的情况下完善。」
       随后纠正：「这个模式由我手动更改，没有说自动检测。」
       —— 所以不做任何设备探测，只认用户自己在设置里点的这一下。
       卡顿根源是 backdrop-filter（大面积实时模糊，iOS/Safari 上极贵）
       加上两张 340/420px、blur(120px) 且带 26s/34s 无限动画的光斑，
       这三样叠在 iPad 上会直接把 GPU 拖死，白屏就是渲染进程被回收了。 */
    lite: 0,
    bg: { type:'theme', color:'#fffbf7', grad:'', veil:55 },  /* theme|solid|grad|image */
    order: {
      home: ['ann','quote','sign','daily','study','countdown'],
      cat: [],
      card: {},
      game: [],
      annCat: ['site','activity','class','misc']
    }
  };
}
var UI = uiDefault();

/* 预设渐变背景（8 个） */
var UI_GRADS = [
  { n:'暖阳橙', v:'linear-gradient(135deg,#fff7ed,#fed7aa)' },
  { n:'清晨雾', v:'linear-gradient(135deg,#f8fafc,#c7d2fe)' },
  { n:'薄荷海', v:'linear-gradient(135deg,#ecfeff,#99f6e4)' },
  { n:'樱花粉', v:'linear-gradient(135deg,#fff1f2,#fecdd3)' },
  { n:'素雅灰', v:'linear-gradient(135deg,#f5f5f4,#d6d3d1)' },
  { n:'暗夜蓝', v:'linear-gradient(135deg,#0f172a,#1e293b)' },
  { n:'暮色紫', v:'linear-gradient(135deg,#2e1065,#581c87)' },
  { n:'森林绿', v:'linear-gradient(135deg,#052e16,#14532d)' }
];
/* 纯色背景候选（12 个，兼顾亮暗观感） */
var UI_COLORS = ['#fffbf7','#f8fafc','#fef3c7','#ecfdf5','#eff6ff','#fdf2f8',
                 '#f5f5f4','#1c1a18','#0f172a','#1e1b4b','#14321f','#3b1d1d'];

/* 字号档位 */
var UI_FS_STEPS = [0.85, 0.95, 1.00, 1.10, 1.20, 1.35];

/* ---------- 配置读写与规整 ---------- */

function normalizeUI(o){
  var d = uiDefault();
  if(!o || typeof o !== 'object') return d;
  var out = uiDefault();
  out.fs = (typeof o.fs === 'number' && o.fs >= 0.7 && o.fs <= 1.6) ? o.fs : 1;
  out.motion = (o.motion === 0) ? 0 : 1;
  out.stack  = (o.stack  === 1) ? 1 : 0;   /* 【卡片堆叠 v35】缺省关，仅显式 1 才开 */
  /* 【v3.5.6 每日一言来源】缺省联网（1），仅显式 0 才关 */
  out.quoteNet = (o.quoteNet === 0) ? 0 : 1;
  /* 【v3.5.30 轻量模式】null/缺省 = 自动判断；1 = 强制轻量；0 = 强制完整。
     非法值一律当自动，避免老配置里混进奇怪的值把特效开关搞死。 */
  /* v3.5.31：只有明确的 1 才算轻量；历史上存过 null 的旧配置一律回落「完整」。 */
  out.lite = (o.lite === 1) ? 1 : 0;
  /* 【v1→v2 迁移】v1 时期卡片堆叠默认是开，老配置里存的 1 属于「没得选的开」，
     不是用户主动开的，升级到 v2 一律复位为关。用户在 v2 下主动开的才保留。 */
  if((o.v || 1) < 2) out.stack = 0;
  /* 【v2→v3 迁移 · v3.5.14 #1】老配置的 order.home 里没有 quote / study：
     quote 插到「今日班级签」前面（站主要求每日一言在班级签上面），
     study 插到「每日日报」后面。只对显式存过顺序的老配置生效，幂等。 */
  if((o.v || 1) < 3){
    var h3 = Array.isArray(out.order.home) ? out.order.home.slice() : [];
    if(h3.indexOf('quote') < 0){
      var si3 = h3.indexOf('sign');
      if(si3 < 0) h3.push('quote'); else h3.splice(si3, 0, 'quote');
    }
    if(h3.indexOf('study') < 0){
      var di3 = h3.indexOf('daily');
      if(di3 < 0) h3.push('study'); else h3.splice(di3 + 1, 0, 'study');
    }
    out.order.home = h3;
  }
  if(o.bg && typeof o.bg === 'object'){
    out.bg.type = (['theme','solid','grad','image'].indexOf(o.bg.type) >= 0) ? o.bg.type : 'theme';
    out.bg.color = (typeof o.bg.color === 'string') ? o.bg.color : d.bg.color;
    out.bg.grad  = (typeof o.bg.grad  === 'string') ? o.bg.grad  : '';
    out.bg.veil  = (typeof o.bg.veil === 'number' && o.bg.veil >= 0 && o.bg.veil <= 100) ? o.bg.veil : 55;
  }
  var od = (o.order && typeof o.order === 'object') ? o.order : {};
  ['home','cat','game','annCat'].forEach(function(k){
    out.order[k] = Array.isArray(od[k]) ? od[k].map(String) : out.order[k];
  });
  if(od.card && typeof od.card === 'object'){
    for(var c in od.card){ if(Array.isArray(od.card[c])) out.order.card[c] = od.card[c].map(String); }
  }
  return out;
}

function loadUI(){
  var migrated = false;
  try{
    var raw = localStorage.getItem(UI_KEY);
    if(raw){
      var o = null;
      try{ o = JSON.parse(raw); }catch(e){}
      UI = normalizeUI(o);
      /* v3.5.14 #1：老配置完成迁移后落盘一次，之后跟着 cls_ui_cfg 上云，
         免得每次打开都重新迁移、云端还是旧顺序 */
      if(o && (o.v || 1) < UI_V) migrated = true;
    }else UI = uiDefault();
  }catch(e){ UI = uiDefault(); }
  if(migrated){ try{ saveUI(); }catch(e){} }
  return UI;
}
function saveUI(){
  try{ localStorage.setItem(UI_KEY, JSON.stringify(UI)); }catch(e){}
}

/* ---------- 顺序覆盖层（核心） ----------
 * 【不变量】返回数组的元素集合与 items 完全相同，只是顺序不同：
 *   · 站主新增项：saved 里没有 → 追加到末尾，用户一定能看到（卡片不会「消失」）
 *   · 站主删除项：saved 里有但 map 里没有 → 忽略
 *   · saved 为空 → 原样返回（首次进入零成本） */
function applyOrder(items, saved, keyOf){
  var src = (items || []).slice();
  if(!Array.isArray(saved) || !saved.length) return src;
  var map = {}, used = {}, out = [], i, k;
  for(i = 0; i < src.length; i++) map[String(keyOf(src[i]))] = src[i];
  for(i = 0; i < saved.length; i++){                 /* ① 按用户顺序输出 */
    k = String(saved[i]);
    if(map[k] !== undefined && !used[k]){ out.push(map[k]); used[k] = 1; }
  }
  for(i = 0; i < src.length; i++){                   /* ② 补上未被排到的（含新增项） */
    k = String(keyOf(src[i]));
    if(!used[k]){ out.push(src[i]); used[k] = 1; }
  }
  return out;
}

/* 四个读取器：渲染函数一律经它们取数据，顺序即用户顺序 */
function uiCats(){
  /* v3.8.4：先按后台设的 sort 排，再套用户自己的顺序 ——
     没自定义过的同学看到的就是站主排的顺序，自定义过的仍以本人为准。 */
  return applyOrder(
    applyBoardSort(SITE_DATA.categories.filter(function(c){ return c.active !== false; })),
    UI.order.cat, function(c){ return c.id; });
}
function uiLinks(catId){
  return applyOrder(
    SITE_DATA.links.filter(function(l){ return l.categoryId === catId && l.active !== false; }),
    UI.order.card[catId], function(l){ return l.id; });
}
function uiGames(){
  return applyOrder(HIDDEN_FUN_LINKS, UI.order.game, function(g){ return g.url; });
}
/* 公告分类：'all'（总览）永远钉在最后 */
function uiAnnCats(list){
  var arr = (list || []).slice(), tail = [], i;
  for(i = 0; i < arr.length; i++){ if(arr[i].key === 'all'){ tail = arr.splice(i,1); break; } }
  return applyOrder(arr, UI.order.annCat, function(c){ return c.key; }).concat(tail);
}

/* 首页 4 区块顺序（用 DOM 移动；#homeView 的子元素是静态 HTML，render 不重建其容器） */
var HOME_BLOCKS = { ann:'board', quote:'dailyQuoteBar', sign:'signBar', daily:'dailyNews', study:'studyCard', countdown:'countdown' };
function applyHomeOrder(){
  var hv = document.getElementById('homeView'); if(!hv) return;
  /* v3.5.14 #2：只读用户顺序，不在渲染里改内存（以前 ord.push 改了 UI 却不 saveUI，
     内存值与 localStorage / 云端长期不一致，排序看起来「存不上」） */
  var ord = (UI.order.home || []).slice();
  /* 未配置过的区块按默认顺序补齐（只在本次渲染生效） */
  uiDefault().order.home.forEach(function(k){
    if(ord.indexOf(k) < 0) ord.push(k);
  });
  for(var i = 0; i < ord.length; i++){
    var el = document.getElementById(HOME_BLOCKS[ord[i]]);
    if(el && el.parentNode === hv) hv.appendChild(el);   /* appendChild = 移到末尾，依次执行得目标序 */
  }
}

/* ---------- 应用：字体 / 背景 / 总入口 ---------- */

function motionOn(){
  try{ if(window.matchMedia && matchMedia('(prefers-reduced-motion:reduce)').matches) return false; }catch(e){}
  return UI.motion !== 0;
}

/* ---------- v3.5.30 轻量模式（性能兜底）· v3.5.31 改为纯手动 ----------
 * 站主原话：「比如说我这个 iPad 的 Air，打开的时候完全卡顿，动都动不了。
 *   勉强操作一下之后页面完全变白了。比如说自定义是否需要取消掉玻璃光效，
 *   还有其他的一些动画特效。尽量在确保不卡顿的情况下去完善。
 *   当然对高端的手机的话，肯定是更好的体验会更好。」
 * 随后明确纠正（v3.5.31）：「这个模式由我手动更改，没有说自动检测。」
 *
 * 所以这里不再做任何 UA / 内存 / 核数 / 长任务探测 —— 只认一个值：UI.lite。
 *   UI.lite === 1   →  轻量（手动开启，落盘到 localStorage，长期生效）
 *   UI.lite === 0   →  完整（手动关闭，落盘，长期生效）
 *   其它（null）    →  跟随默认 = 完整
 * 默认给「完整」而不是「轻量」：高端机不该被无端降级，卡的人自己点一下就行。
 */
/* ===== 轻量模式：设备级记忆（v3.5.33）=====
 * 站主原话：「你要记住设备的选择，比如说设备在这个版本已经选择了轻量模式，
 *   那你不能下个版本你又给它跳回到完整模式。」
 *
 * 为什么不能只存在 cls_ui_cfg 里：
 *   ① cls_ui_cfg 带版本号，normalizeUI 每次升级都会重新计算各字段 —— 轻量开关
 *      哪天在迁移里漏一行，升级后就悄悄变回完整；
 *   ② cls_ui_cfg 会跟着「云端个人数据」同步（换设备的场景），
 *      但这台设备的性能属于「设备属性」，不该被别的设备覆盖；
 *   ③ 「恢复默认设置」会把 UI 整个换成 uiDefault()，lite 也会跟着回到 0。
 *
 * 所以单独用一个 key：cls_lite_mode，值只有 '1'（轻量）/ '0'（完整）。
 * 一旦写过就永远以它为准，任何版本升级、恢复默认、导入配置都不动它。
 * 只有用户自己在设置里点，才会改写。 */
var LITE_KEY = 'cls_lite_mode';

function readLitePref(){
  try{
    var v = localStorage.getItem(LITE_KEY);
    if(v === '1') return 1;
    if(v === '0') return 0;
  }catch(e){}
  return null;      /* 没选过 */
}

function writeLitePref(v){
  try{ localStorage.setItem(LITE_KEY, v === 1 ? '1' : '0'); }catch(e){}
}

function liteOn(){
  /* 设备级记忆优先：只要这台设备选过，就永远按它来（跨版本、跨恢复默认）。
     没选过才回落到 UI.lite（用于「配置文件导入」这种显式带过来的场景）。 */
  var pref = readLitePref();
  if(pref === 1) return true;
  if(pref === 0) return false;
  return UI.lite === 1;
}

/** 把轻量模式落到 <html data-lite>，CSS 里所有重特效都挂在这个属性下 */
function applyLite(){
  var on = liteOn();
  var d = document.documentElement;
  if(on) d.setAttribute('data-lite', '1'); else d.removeAttribute('data-lite');
  /* 轻量模式下顺带把动效也关掉：既然是为了不卡，
     还留着扫光/漂移动画就没意义了。 */
  if(on){
    d.setAttribute('data-motion', 'off');
  }else{
    d.setAttribute('data-motion', UI.motion ? 'on' : 'off');
  }
  return on;
}

function applyFont(){
  var d = document.documentElement, fs = UI.fs || 1;
  d.style.setProperty('--fs', String(fs));
  /* 图标是固定 px 尺寸，阻尼跟随（0.5 倍率，封顶 1.2）以免大字号下过大 */
  d.style.setProperty('--ico', String(Math.max(.9, Math.min(1.2, 1 + (fs - 1) * 0.5))));
}

function getBgImg(){
  try{ return localStorage.getItem(UI_BG_KEY) || ''; }catch(e){ return ''; }
}

function applyBg(){
  var d = document.documentElement, b = UI.bg || {}, el = document.getElementById('bgLayer');
  d.setAttribute('data-bg', b.type || 'theme');
  if(!el) return;
  el.style.backgroundImage = ''; el.style.backgroundColor = '';
  if(b.type === 'solid'){ el.style.backgroundColor = b.color || '#fffbf7'; }
  else if(b.type === 'grad'){ el.style.backgroundImage = b.grad || ''; }
  else if(b.type === 'image'){
    var s = getBgImg();
    if(s) el.style.backgroundImage = 'url("' + s + '")';
    else { d.setAttribute('data-bg','theme'); }
  }
  /* 蒙层：亮色用暖白、暗色用近黑，随主题切换；veil 0~100 → 透明度 0.30~0.85 / 0.32~0.87 */
  var a = (b.veil == null ? 55 : b.veil) / 100;
  var veil = d.classList.contains('dark')
    ? 'rgba(20,18,16,' + (0.32 + a * 0.55).toFixed(3) + ')'
    : 'rgba(255,251,247,' + (0.30 + a * 0.55).toFixed(3) + ')';
  d.style.setProperty('--bg-veil', veil);
  /* v3.7.6：换背景/换蒙层后，弹窗里的字要按新底色重算一遍 */
  try{ if(typeof mkScanAll === 'function') mkScanAll(120); }catch(e){}
}

/* ---------- 背景可读性守护 ----------
 * 实测：亮色模式下选深蓝纯背景 + 蒙层 0 → 卡片标题对比度仅 2.24:1（读不清）。
 * 与其让用户自己悟「还要去开夜间模式」，不如在 TA 选下深色背景的那一刻自动配好。
 * 原则：只在「用户主动选色」和「导入配置」时介入，被动加载不干预，
 *       这样用户之后手动再切回昼色，选择依然作数。 */
function hexLum(h){
  if(typeof h !== 'string') return null;
  var m = h.replace('#', '');
  if(m.length === 3) m = m[0] + m[0] + m[1] + m[1] + m[2] + m[2];
  if(!/^[0-9a-fA-F]{6}$/.test(m)) return null;
  function f(c){ c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  return 0.2126 * f(parseInt(m.slice(0,2),16)) + 0.7152 * f(parseInt(m.slice(2,4),16)) + 0.0722 * f(parseInt(m.slice(4,6),16));
}
/* 返回 true=该用夜间 / false=该用昼间 / null=中间地带，不干预 */
function bgWantsDark(){
  var b = UI.bg || {}, L, i, s, n, ls;
  if(b.type === 'solid'){
    L = hexLum(b.color);
  }else if(b.type === 'grad'){
    ls = String(b.grad || '').match(/#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}/g) || [];
    s = 0; n = 0;
    for(i = 0; i < ls.length; i++){ L = hexLum(ls[i]); if(L !== null){ s += L; n++; } }
    L = n ? s / n : null;
  }else return null;                       /* 图片/跟随主题：不猜 */
  if(L === null) return null;
  return L < 0.20 ? true : (L > 0.50 ? false : null);
}
function syncThemeToBg(){
  var want = bgWantsDark();
  if(want === null) return false;
  var d = document.documentElement;
  if(d.classList.contains('dark') === want) return false;
  d.classList.toggle('dark', want);
  try{
    localStorage.setItem('cls_theme', want ? 'dark' : 'light');
    localStorage.setItem('cls_theme_auto', 'off');   /* 否则白天会被自动切回去 */
  }catch(e){}
  var t = document.getElementById('themeToggle');
  if(t) t.innerHTML = want ? iconSvg('sun',17) : iconSvg('moon',17);
  if(typeof uiMsg === 'function')
    uiMsg(want ? '背景偏深，已自动切到夜间模式（并关闭昼夜自动切换）'
               : '背景偏亮，已自动切回日间模式（并关闭昼夜自动切换）');
  return true;
}

/* 总入口：一次性把配置全部应用（初始化时、导入后、恢复默认后调用） */
function applyUICfg(){
  applyFont();
  /* v3.5.30：轻量模式要**先于**背景/顺序应用 —— 它决定 --glass-bg 等变量
     是否退回不透明色，晚设置会让首屏先糊一次再跳变。 */
  applyLite();
  applyBg();
  applyHomeOrder();
  STACK_OPEN = {};    /* 【卡片堆叠 v35】配置变更（导入/恢复默认）后清展开记忆，回到默认堆叠态 */
  /* data-motion 由 applyLite() 统一设置（轻量模式强制 off） */
  var sb = document.getElementById('uiSetBtn');
  if(sb) sb.innerHTML = iconSvg('settings', 15, 'margin-right:7px;vertical-align:-2px') + '自定义设置';
}

/* ============================================================
 * v3.5.14 #6 无感刷新：保存 / 恢复滚动位置
 * ------------------------------------------------------------
 * 站主原话：手机上看 20-30 名的成绩表，一自动刷新就跳回 5-15 名。
 * 根因：rerenderAll() → render() 整体重建 #grid.innerHTML，文档高度瞬间归零，
 *   浏览器把 scrollY 夹到 0；成绩表 .sc-tblwrap 是内滚容器，innerHTML 重写后
 *   scrollTop 也归零。全程没有任何保存/恢复。
 * 做法：给需要保位的容器打 data-scroll-keep，重绘前后按「序号」快照恢复；
 *   用双 requestAnimationFrame 等布局稳定，再按最大可滚距离钳位。
 * ⚠️ 只在「外来刷新」时恢复；用户主动切 Tab / 换考试要回顶部，传 preserve:false。
 * ============================================================ */
function snapScroll(){
  var out = { x: 0, y: 0, els: [] };
  try{ out.x = window.scrollX || 0; out.y = window.scrollY || 0; }catch(e){}
  var ns = document.querySelectorAll('[data-scroll-keep]');
  for(var i = 0; i < ns.length; i++){
    var el = ns[i];
    if(el && (el.scrollTop || el.scrollLeft)) out.els.push({ i: i, t: el.scrollTop, l: el.scrollLeft });
  }
  return out;
}
function restoreScroll(snap){
  if(!snap) return;
  try{ window.scrollTo(snap.x || 0, snap.y || 0); }catch(e){}
  var ns = document.querySelectorAll('[data-scroll-keep]');
  (snap.els || []).forEach(function(s){
    var el = ns[s.i]; if(!el) return;
    var maxT = Math.max(0, el.scrollHeight - el.clientHeight);
    var maxL = Math.max(0, el.scrollWidth - el.clientWidth);
    try{ el.scrollTop = Math.min(s.t, maxT); el.scrollLeft = Math.min(s.l, maxL); }catch(e){}
  });
}
function withScrollPreserve(fn, opts){
  if(opts && opts.preserve === false) return fn();
  var snap = snapScroll(), r = fn();
  try{
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){ restoreScroll(snap); });
    });
  }catch(e){ restoreScroll(snap); }
  return r;
}

/* 重渲染所有受顺序影响的地方 */
function rerenderAll(opts){
  return withScrollPreserve(function(){
  render();                 /* 内部已含 renderBoard() + buildSidebar() + applyHomeOrder() */
  /* 重要日期落在独立变量 IMPORTANT_DATES 上，render() 不碰它 ——
     不在这里补一刀，云端内容替换后首页倒计时最久要等 1 秒（下一个 interval tick）
     才更新，看着像「云端改了没反应」。 */
  try{ if(typeof updateCountdown === 'function') updateCountdown(); }catch(e){}
  try{ if(typeof refreshHwViews === 'function') refreshHwViews(); }catch(e){}
  renderHiddenView();
  var ab = document.getElementById('allBoardMask');
  if(ab && ab.classList.contains('show')) renderAllBoard();
  }, opts);
}

/* ============================================================
 * 【账号系统 + 云同步 + 管理员后台】2026-09-27
 * ------------------------------------------------------------
 * 设计要点：
 *  ① 前端在 GitHub Pages、后端在 Cloudflare Workers，属于跨站请求。
 *     登录态用 Authorization: Bearer <token>，不用 Cookie，
 *     因为微信内置浏览器对第三方 Cookie 限制很严，登录态会莫名掉。
 *  ② 站点原有行为完全不变：未登录时所有数据照旧存本机；
 *     登录后可选开启云同步，把本机数据推上去 / 拉下来。
 *  ③ token 存 localStorage（键 cls_auth），跟站点其他个人数据一致。
 * ============================================================ */

/* 后端地址
   ------------------------------------------------------------
   两种部署形态：
   ① 前端与后端同域 → 留空即可，走同域相对路径 /api
   ② 前端在 GitHub Pages、后端在 Cloudflare Workers（本站当前形态）
      → 必须填完整地址，否则跨域请求打不到后端

   ⚠️ 当前后端：Cloudflare Workers + Neon
      前端（GitHub Pages）→ 后端（api.classsite.dpdns.org）
      自定义域名走的是自建域名，绕开 workers.dev 在大陆被 DNS 污染的问题。
      改地址时注意结尾不要带斜杠。
   也可以不改代码，在页面 head 里提前注入一行设置 window.CLS_API_BASE（见 api/.env.example 的说明）
   ------------------------------------------------------------ */
var API_BASE_DEFAULT = 'https://api.classsite.dpdns.org';

var API_BASE = (function(){
  /* ① 运行时显式注入优先（head 里注入，或本文件稍后赋值） */
  if(typeof window.CLS_API_BASE === 'string' && window.CLS_API_BASE){
    return window.CLS_API_BASE.replace(/\/+$/, '');
  }
  /* ② 代码里写死的默认值 */
  if(API_BASE_DEFAULT) return API_BASE_DEFAULT.replace(/\/+$/, '');
  /* ③ 页面本身就在部署后端的那台机器上 → 同域，用相对路径 */
  if(/vercel\.app$/.test(location.hostname) || /workers\.dev$/.test(location.hostname) || location.hostname === 'localhost' || location.hostname === '127.0.0.1'){
    return '';
  }
  /* ④ 其余情况（如 GitHub Pages / 本地 file://）——没配后端地址，接口不可用 */
  return '';
})();

/** 后端地址是否已配置（未配置时给出友好提示，而不是让请求默默失败） */
function apiReady(){
  if(API_BASE) return true;
  return /vercel\.app$/.test(location.hostname) || /workers\.dev$/.test(location.hostname)
      || location.hostname === 'localhost'
      || location.hostname === '127.0.0.1';
}


var AUTH_KEY = 'cls_auth';
var AUTH = { token:'', user:null };   /* 当前登录态 */

/* 允许云同步的本机键（与后端 api/data.js 的 ALLOW_KEYS 保持一致）
   2026-10-05：按「尽量都同步」的原则扩充。

   ⚠️ 两条纪律：
     ① 改这里**必须同步改后端** api/data.js 的 ALLOW_KEYS，否则推上去被 403 挡掉；
     ② 键名必须是 index.html 里真实用到的（改之前先 grep 确认），
        凭空造键名不会报错，只会静默无效。

   不同步的键（有意排除）：
     cls_auth         登录 token，各设备各登各的
     cls_site_gate    站点门禁是否已通过，安全相关
     cls_lock_*       输错密码的锁定计时，安全相关
     cls_gate_*       各入口的验证状态，安全相关
     cls_device_id    设备标识，本来就该各不相同
     cls_content_cache_v1 / cls_content_since_v1  云端内容的本地缓存，不是用户数据 */
var CLOUD_KEYS = [
  /* 外观与界面 —— v3.5.34：⚠️ 自定义设置**一律不同步**（站主明确要求）。
     原话：「以后自定义的设置都不上云端，因为每台设备不同，即使是同一个账户，
     它不同设备可能配置也不同，所以这个就不上云端，只保存在浏览器本地。」
     于是 cls_ui_cfg（字号/背景/排序/动效/轻量）、cls_ui_bgimg（自定义背景图）
     全部移出白名单 —— 换设备就该按那台设备的屏幕和使用习惯重新配。
     留在白名单里的只有「主题」和「音效」这类跟屏幕尺寸无关的开关。 */
  'cls_theme','cls_theme_auto','cls_theme_auto2','cls_sfx',
  /* v2.6.0 学习卡片：开关 / 内容类型 / 学科选择，属于个人偏好，跟着账号走 */
  'cls_study_cfg',
  /* ⚠️ cls_theme_hold（「仅这次切换」的当天软标记）**刻意不同步**：
     它是「今天这台设备先这样」的临时意愿，换设备就该按那边的自动规则走。 */
  /* 各种「已看过 / 已关闭」的标记：换设备不该重复打扰 */
  'cls_welcome_v1','cls_login_guide_v1','cls_study_notice_dismissed','cls_welcome_hide',
  'cls_exam_tip_seen','cls_holiday_tip_seen','cls_exam_scope_seen',
  /* 点歌相关 */
  'cls_dj_excluded','cls_dj_excluded_req','cls_dj_note','cls_dj_schedule',
  'cls_dj_my_songs','cls_dj_pending','cls_dj_history','cls_dj_copy_note',
  /* 学习与班级事务 */
  'cls_study_plan','cls_notice_read','cls_class_list',
  /* 站内偏好 */
  'cls_ann_filter','cls_board_collapsed','cls_side_open','cls_return_view',
];
/* 前缀匹配的键（作业完成标记、签到、领券台账等） */
var CLOUD_KEY_PREFIX = ['cls_hw_done_','cls_sign_','cls_claim_','cls_act_'];

function isCloudKey(k){
  if(CLOUD_KEYS.indexOf(k) >= 0) return true;
  return CLOUD_KEY_PREFIX.some(function(p){ return k.indexOf(p) === 0; });
}

function apiUrl(path){ return (API_BASE || '') + '/api' + path; }

/** v3.5.42：导出图片用的班徽地址。
 *  优先后台「站点信息 → 班徽」里填的直链，没填就用站点自己的图标（favicon.svg）。
 *  相对路径会被解析成绝对地址 —— canvas 画相对路径的图片在部分内核上会失败。 */
/* ============================================================================
 * v3.7.0（站主 #3）：班徽「登录时下载一次，之后永远用缓存」
 * ----------------------------------------------------------------------------
 * 站主原话：「要不在用户登录的时候就自动下载班徽到本地缓存，生成图片的时候
 *            直接调用缓存，虽然说这样跨设备要重新下载缓存，但总归提升了速度」
 *
 * 做法：
 *   · 登录成功 / 恢复登录态时，后台悄悄请求 /api/badge，转成 dataURL 存本地；
 *   · 导出图片时 siteBadgeList() 第一项就是这份缓存 → canvas 直接可用，
 *     不发任何网络请求，也不会因为跨域被「污染」；
 *   · 7 天自动刷新一次（后台换了班徽也能跟着换），换设备重新登录会重新下载。
 * 整个过程不打扰用户：失败就静默，导出时还有 local/proxy 两级兜底。
 * ========================================================================= */
var BADGE_LS = '__cls_badge_src';
var BADGE_TS_LS = '__cls_badge_ts';
var BADGE_TTL = 7 * 86400000;
var __badgeLoading = null;

function badgeCachedSrc(){
  try{
    var v = localStorage.getItem(BADGE_LS) || '';
    /* 只认 dataURL：万一存了坏值，导出时 canvas 会报错 */
    return v.indexOf('data:image/') === 0 ? v : '';
  }catch(e){ return ''; }
}

/** 把 /api/badge 的图存成本地 dataURL。force=false 时 7 天内不重复下载。 */
function badgeCacheLoad(force){
  /* v3.9.10：轻量模式直接用仓库里的 badge.png（同源 CDN），
     不走 /api/badge 代理（110KB、约 3.8s）。 */
  if(liteOn()) return Promise.resolve('./icons/badge-256.png');
  if(__badgeLoading) return __badgeLoading;
  var cached = badgeCachedSrc();
  var ts = 0;
  try{ ts = Number(localStorage.getItem(BADGE_TS_LS)) || 0; }catch(e){}
  if(!force && cached && ts && (Date.now() - ts) < BADGE_TTL) return Promise.resolve(cached);

  __badgeLoading = new Promise(function(resolve){
    var done = false;
    function fin(v){ if(!done){ done = true; __badgeLoading = null; resolve(v || ''); } }
    try{
      /* v3.9.12：班徽原图就是 256×256 但没有压缩（110KB），且要经 /api/badge 代理
         （约 3.8s）。改用同源 icons/badge-256.png（128 色，28KB），首屏少 80KB。 */
      var url = './icons/badge-256.png';
      fetch(url, { cache:'force-cache' }).then(function(r){
        if(!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      }).then(function(blob){
        if(!blob || blob.size < 200) throw new Error('图片太小');
        var fr = new FileReader();
        fr.onload = function(){
          var data = String(fr.result || '');
          if(data.indexOf('data:image/') !== 0) return fin('');
          try{
            localStorage.setItem(BADGE_LS, data);
            localStorage.setItem(BADGE_TS_LS, String(Date.now()));
          }catch(e){ /* 配额满了就只在内存里用这一份 */ }
          fin(data);
        };
        fr.onerror = function(){ fin(''); };
        fr.readAsDataURL(blob);
      }).catch(function(){ fin(''); });
      /* 兜底：12 秒还没结果就放弃（不影响任何功能） */
      setTimeout(function(){ fin(''); }, 12000);
    }catch(e){ fin(''); }
  });
  return __badgeLoading;
}

/** v3.6.5：班徽候选列表 —— 先本地小图（快），再服务器代理（兜底）。
 *  本地 badge.png 受 Pages 同步影响可能 404，代理则一定能取到后台配的直链。 */
function siteBadgeList(){
  var list = [];
  /* ① 登录时下载好的本地缓存（dataURL，零请求、不会被跨域污染） */
  var cached = badgeCachedSrc();
  if(cached) list.push(cached);
  /* ② 站点本地文件：优先 28KB 的 256px 版（原图 110KB，画质一样） */
  try{ list.push(new URL('./icons/badge-256.png', location.href).href); }catch(e){}
  try{ list.push(new URL('./badge.png', location.href).href); }catch(e){}
  var u = '';
  try{ u = (window.SITE_DATA && SITE_DATA.badgeUrl) || ''; }catch(e){}
  if(/^https?:\/\//i.test(String(u || '').trim())) list.push(apiUrl('/badge'));
  return list;
}

function siteBadgeUrl(){
  var u = '';
  try{ u = (window.SITE_DATA && SITE_DATA.badgeUrl) || ''; }catch(e){}
  u = String(u || '').trim();
  /* v3.6.4：后台配了图片直链就走服务器的 /api/badge 代理。
     图床基本都不给 CORS 头，直接画进 canvas 会把画布标记为「污染」，
     toBlob 立刻抛 SecurityError（导出直接失败）。代理是服务端取的，
     加上 CORS 头再吐回来，等同于同源图片。 */
  if(/^https?:\/\//i.test(u)) return apiUrl('/badge');
  if(!u) u = './badge.png';
  try{ return new URL(u, location.href).href; }catch(e){ return u; }
}

/* 统一的 API 调用：自动带 token、自动处理登录过期 */
function api(path, opts){
  opts = opts || {};
  if(!apiReady()){
    return Promise.reject(new Error(
      '后端还没配置好。请把 index.html 里的 API_BASE_DEFAULT 填成后端地址（或在页面 head 里注入 window.CLS_API_BASE）。'
    ));
  }
  var headers = { 'Content-Type':'application/json' };
  if(AUTH.token) headers['Authorization'] = 'Bearer ' + AUTH.token;
  var init = { method: opts.method || 'GET', headers: headers };
  if(opts.body !== undefined) init.body = JSON.stringify(opts.body);

  return fetch(apiUrl(path), init).then(function(r){
    return r.json().catch(function(){ return { ok:false, error:'接口返回了非 JSON 内容（HTTP ' + r.status + '）' }; })
      .then(function(j){
        /* 登录态失效：清掉本地并提示 */
        if(r.status === 401 && AUTH.token){
          AUTH = { token:'', user:null };
          try{ localStorage.removeItem(AUTH_KEY); }catch(e){}
          refreshAcctBtn();
        }
        if(!r.ok || j.ok === false){
          var err = new Error(j.error || ('请求失败（HTTP ' + r.status + '）'));
          err.status = r.status;
          throw err;
        }
        return j;
      });
  }).then(function(j){
    /* 🚀 v2.6.1：请求成功就说明网络是通的 → 顺手把在线状态清零。
       这是消除「明明有网却弹连不上」的关键：以前只有**心跳成功**才清零，
       于是 api 失败点着的计时器只能等下一次心跳来灭（最多 60 秒），
       中间时间一到就先弹了横幅 —— 用户看到的就是「有网却提示连不上」。 */
    try{ if(typeof markNetOk === 'function') markNetOk(); }catch(_){}
    return j;
  }).catch(function(e){
    /* 网络层失败（DNS / 断网 / CORS / 超时）时 fetch 直接 reject，
       原始错误是裸的 TypeError: Failed to fetch，既没有 status 也看不出
       到底该怪谁。这里统一包装成可读文案，并打上 offline 标记。

       🚀 v2.6.1：**不再**用 api 的失败去点亮离线横幅 —— 在线判定只看心跳：
         · 启动时 content / roster / ping 会并发好几条，任意一条抖一下就记一次，
           叠加起来很容易「秒弹」，用户刚要打开就看见报错；
         · 服务端偶尔慢（实测单次可到 10 秒）会让它频繁误报。
       真连不上时心跳自然会连续失败、判定更准；请求自身的错误照旧由
       调用方的 try/catch 提示，不会因为这里放开而变得「报错没人管」。 */
    if(e && e.status) throw e;
    var netErr = new Error('连接不到服务端，请检查网络，或切换到流量（移动数据）再试');
    netErr.offline = true;
    netErr.cause = e;
    throw netErr;
  });
}

/* ============================================================
 * 【v2.9.9】客户端密码派生（第五十六轮·根因修复）
 * ------------------------------------------------------------
 * 由来（一次性解决「首次登录改密卡死」）：
 *   账号库里 61/63 个账号是 50000 次 PBKDF2 档位。v2.9.8 曾给改密
 *   加过 needsDowngrade 护栏：高迭代档位禁止自助改密、只能管理员
 *   「重置密码」——理由是「Worker 单请求 CPU 上限装不下派生」。
 *   线上实测推翻了这个误判：临时诊断端点单请求连跑 60 次派生
 *   （合计 60 万次迭代）稳定 200，CPU 预算其实很宽；真凶是
 *   ensureSchema 漏建 failed_count/locked_until 列（http.js 已修）。
 *   护栏防的是一个不存在的 500，却把全班首次登录改密全拦死了。
 *
 * 根因解法：把 PBKDF2 从 Worker 搬到浏览器。
 *   · 浏览器没有「单请求 CPU 预算」这回事，老手机跑 50000 次也就一两秒；
 *   · 服务端零派生、只做一次 sha256 比对，改密请求轻到不可能再超时；
 *   · 顺带更安全：库里只存 sha256(派生密钥)（pbkdf2c 格式），
 *     拖库也拿不到可以直接登录的密钥。
 *
 * 协议三件套：
 *   ① POST /auth?action=salt {username} → {algo:'pbkdf2', iterations, salt}
 *      （未知用户名返回诱饵参数，防用户名枚举；bcrypt 账号返回 algo='bcrypt'）
 *   ② 浏览器 crypto.subtle 本地 PBKDF2 派生 → credential（base64url）
 *   ③ login 带 credential；change-password 带 {oldCredential, newHash}
 * 任一步走不通（老浏览器没 WebCrypto、salt 接口 429/挂掉）都自动
 * 回退旧明文路径（服务端派生），行为与 v2.9.9 之前完全一致。
 * ============================================================ */
var CLS_KDF_ITER = 50000;   /* 新密码派生档位：与名单导入一致，老手机可承受 */

function clsHasSubtle(){
  return !!(window.crypto && window.crypto.subtle && window.crypto.subtle.deriveKey
           && window.crypto.subtle.digest && window.TextEncoder);
}
function clsB64urlEncode(bytes){
  var s = '', i;
  for(i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function clsB64urlDecode(str){
  var s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  while(s.length % 4) s += '=';
  var bin = atob(s), out = new Uint8Array(bin.length);
  for(var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
/* 浏览器本地 PBKDF2(password, salt, iterations) → base64url 派生密钥。
   与后端 password.js 的派生参数逐位对齐（SHA-256 / 256 位）。 */
function clsDerive(password, saltB64, iterations){
  if(!clsHasSubtle()) return Promise.reject(new Error('NO_SUBTLE'));
  return crypto.subtle.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits'])
    .then(function(base){
      return crypto.subtle.deriveBits(
        { name:'PBKDF2', salt: clsB64urlDecode(saltB64), iterations: iterations, hash:'SHA-256' },
        base, 256
      );
    })
    .then(function(bits){ return clsB64urlEncode(new Uint8Array(bits)); });
}
/* 生成新密码的 pbkdf2c 哈希串：随机盐 + 本地派生 + sha256(派生密钥)。
   库里只存这个摘要，不存可直接登录的密钥。 */
function clsNewHash(password, iterations){
  var salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  var saltB64 = clsB64urlEncode(salt);
  return clsDerive(password, saltB64, iterations).then(function(dk){
    return crypto.subtle.digest('SHA-256', clsB64urlDecode(dk)).then(function(d){
      return 'pbkdf2c$' + iterations + '$' + saltB64 + '$' + clsB64urlEncode(new Uint8Array(d));
    });
  });
}
/* 取某用户的盐参数（内存缓存；改密成功后调用 clsSaltForget 失效） */
var CLS_SALT_CACHE = {};
function clsSalt(username){
  var key = String(username || '').toLowerCase();
  if(CLS_SALT_CACHE[key]) return Promise.resolve(CLS_SALT_CACHE[key]);
  return api('/auth?action=salt', { method:'POST', body:{ username: username } }).then(function(j){
    var p = { algo: j.algo === 'pbkdf2' ? 'pbkdf2' : 'bcrypt', iterations: j.iterations || 0, salt: j.salt || '' };
    CLS_SALT_CACHE[key] = p;
    return p;
  });
}
function clsSaltForget(username){ delete CLS_SALT_CACHE[String(username || '').toLowerCase()]; }
/* 客户端派生走不通时的统一回退标记 */
var CLS_FALLBACK = { fallback: true };
function clsKdfFallback(e){
  /* 只有「这条路不该走 / 暂时走不了」才回退明文路径；
     密码错误（401）、锁定（429 之外的原因）等真实结果照旧抛出。 */
  if(e && (e.message === 'NO_SUBTLE' || e.status === 429 || e.status >= 500)) return true;
  return false;
}
/* 登录：优先浏览器派生 credential，失败回退明文 */
function clsLogin(u, p){
  if(!u) return api('/auth?action=login', { method:'POST', body:{ username:u, password:p } });
  return clsSalt(u).then(function(sp){
    if(sp.algo !== 'pbkdf2' || !sp.salt || !sp.iterations) return CLS_FALLBACK;
    return clsDerive(p, sp.salt, sp.iterations).then(function(cred){
      return api('/auth?action=login', { method:'POST', body:{ username:u, credential:cred } });
    });
  }).catch(function(e){
    if(clsKdfFallback(e)) return CLS_FALLBACK;
    throw e;
  }).then(function(r){
    if(r === CLS_FALLBACK) return api('/auth?action=login', { method:'POST', body:{ username:u, password:p } });
    return r;
  });
}
/* 改密：派生旧密码 credential + 生成新 pbkdf2c 哈希，服务端零派生办完 */
function clsChangePwd(oldPwd, newPwd, username){
  if(!username) return api('/auth?action=change-password',
    { method:'POST', body:{ oldPassword: oldPwd, newPassword: newPwd } });
  return clsSalt(username).then(function(sp){
    if(sp.algo !== 'pbkdf2' || !sp.salt || !sp.iterations) return CLS_FALLBACK;
    return clsDerive(oldPwd, sp.salt, sp.iterations).then(function(oldCred){
      return clsNewHash(newPwd, CLS_KDF_ITER).then(function(newHash){
        return api('/auth?action=change-password',
          { method:'POST', body:{ oldCredential: oldCred, newHash: newHash } });
      });
    });
  }).catch(function(e){
    if(clsKdfFallback(e)) return CLS_FALLBACK;
    throw e;
  }).then(function(r){
    if(username) clsSaltForget(username);   /* 哈希已换，旧盐参数的缓存作废 */
    if(r === CLS_FALLBACK) return api('/auth?action=change-password',
      { method:'POST', body:{ oldPassword: oldPwd, newPassword: newPwd } });
    return r;
  });
}

/* ============================================================
 * 【v2.9.10】全站共用自适应字色（第五十七轮·站主新规）
 * ------------------------------------------------------------
 * 站主原话：「全站字色共用一套逻辑……字体颜色需根据背景颜色实时改变，
 * 都用对应的相反色，尤其是一些公告什么经常切换白天黑夜的时候
 * 只有一部分看得清，主页面和后台页面都有这种情况」。
 *
 * 规则（以后新写的带背景文字块都按这个来）：
 *   ① 凡是「文字压在背景上」的渲染，一律经过 clsReadableOn(背景色)
 *      取相反色 —— 亮底用深字、暗底用白字，不写死；
 *   ② 主题（白天/黑夜）切换后，clsAutoInk(document.body) 全局重算；
 *   ③ 新增渲染点只要给容器加 class="ink-auto"（动态背景色用
 *      data-ink-bg 声明代表色，如渐变的起始色），无需再操心字色。
 * 阈值 0.6 与成绩分析热力图原有公式（0.299R+0.587G+0.114B）一致，
 * 热力图的私有实现已改为调用本函数（一套逻辑，两处生效）。
 *
 * 【v2.9.11】判定升级：WCAG 相对亮度 + 对比度择优（不再用感知亮度猜）
 * ------------------------------------------------------------
 * 站主原话：「还有登录时的弹窗等等，都是字色不达标的后台也有这种情况」。
 * v2.9.10 用 YIQ 感知亮度阈值 0.6 猜相反色，中间色会误判 ——
 * 如 #f97316（亮橙）被判「暗底取白字」，实测白字对比度仅 2.80:1，
 * 够不上 WCAG 正文 4.5:1，而深字 #241f1c 有 5.82:1。
 * 现在白字、深字各算一遍 WCAG 对比度，谁大用谁，中间色不再靠猜。
 * ============================================================ */
var CLS_INK_DARK = '#241f1c';   /* 亮底上的字（暖调近黑，不用纯黑） */
var CLS_INK_LIGHT = '#ffffff';  /* 暗底上的字 */
var CLS_INK_RGB_DARK = clsParseColor(CLS_INK_DARK);   /* [36,31,28]，择优用 */
var CLS_INK_RGB_LIGHT = clsParseColor(CLS_INK_LIGHT); /* [255,255,255]，择优用 */

/* 解析颜色串 → [r,g,b]；支持 #rgb / #rrggbb / rgb() / rgba()。
   透明或解析失败返回 null（调用方按「不处理」跳过）。 */
function clsParseColor(c){
  var s = String(c || '').trim().toLowerCase();
  var m;
  if((m = /^#([0-9a-f]{3})$/.exec(s))){
    return [parseInt(m[1][0]+m[1][0],16), parseInt(m[1][1]+m[1][1],16), parseInt(m[1][2]+m[1][2],16)];
  }
  if((m = /^#([0-9a-f]{6})$/.exec(s))){
    return [parseInt(m[1].slice(0,2),16), parseInt(m[1].slice(2,4),16), parseInt(m[1].slice(4,6),16)];
  }
  if((m = /^rgba?\(([^)]+)\)$/.exec(s))){
    var p = m[1].split(',').map(function(x){ return parseFloat(x); });
    if(p.length >= 3 && p.every(function(x){ return isFinite(x); })){
      if(p.length > 3 && p[3] === 0) return null;   /* 全透明 */
      return [p[0], p[1], p[2]];
    }
  }
  return null;
}
/* WCAG 2.x 相对亮度 0–1（sRGB gamma 展开后加权）。
   注意与「感知亮度」(0.299R+0.587G+0.114B)/255 的区别：那玩意儿
   在中间色上会和真实对比度打架（#f97316 就是受害者），择优只认这个。 */
function clsRelLum(rgb){
  function ch(v){
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return 0.2126 * ch(rgb[0]) + 0.7152 * ch(rgb[1]) + 0.0722 * ch(rgb[2]);
}
/* WCAG 对比度 1–21 */
function clsContrast(a, b){
  var la = clsRelLum(a), lb = clsRelLum(b);
  var hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}
/* 核心：给定背景色，返回可读的相反色。
   v2.9.11 起不猜了直接算 —— 白字与深字各算一遍 WCAG 对比度，取大者。
   实测：#f97316 白 2.80 / 深 5.82 → 深字；#0f766e 白 5.47 / 深 2.98 → 白字；
   #e07a3c 白 2.99 / 深 5.45 → 深字；#c2410c 白 5.18 / 深 3.15 → 白字。 */
function clsReadableOn(bg){
  var c = clsParseColor(bg);
  if(!c) return '';
  return clsContrast(CLS_INK_RGB_LIGHT, c) >= clsContrast(CLS_INK_RGB_DARK, c)
    ? CLS_INK_LIGHT : CLS_INK_DARK;
}
/* 扫描root 内所有 .ink-auto，按实际背景重设字色。
   data-ink-bg 优先（渐变/图片背景没有单一 computed 色时用）；
   否则读 computed backgroundColor（transparent 则跳过——
   让继承色说话，不硬套）；
   backgroundColor 读不到有效色时，从 background-image 渐变里抓
   第一个色当代表色（渐变色取自 CSS 变量，换主题会实时变）。 */
function clsAutoInk(root){
  root = root || document.body;
  if(!root || !root.querySelectorAll) return;
  var els = root.querySelectorAll('.ink-auto');
  for(var i = 0; i < els.length; i++){
    var el = els[i];
    var bg = el.getAttribute('data-ink-bg');
    if(!bg){
      try{
        var cs = getComputedStyle(el);
        bg = cs.backgroundColor;
        if(!clsParseColor(bg)){
          var m = /rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/.exec(cs.backgroundImage || '');
          if(m) bg = m[0];
        }
      }catch(e){ bg = ''; }
    }
    var ink = clsReadableOn(bg);
    if(ink) el.style.color = ink;
  }
}

/* v2.9.10：DOM 变化后自动补扫 .ink-auto —— 面板/表格动态渲染出来的
   字色也实时正确，不用每个渲染函数后面手动跟一次（debounce 100ms，
   只查 .ink-auto，且只观察 childList：写 style 不会反触发，无死循环风险）。 */
if(typeof MutationObserver === 'function'){
  var __inkTimer = null;
  try{
    new MutationObserver(function(){
      if(__inkTimer) return;
      __inkTimer = setTimeout(function(){
        __inkTimer = null;
        try{ clsAutoInk(document.body); }catch(e){}
      }, 100);
    }).observe(document.body, { childList:true, subtree:true });
  }catch(e){}
}

/* ============================================================================
 * v3.7.6（站主）：弹窗里的字色也要跟着背景走
 * ----------------------------------------------------------------------------
 * 站主原话：「所有的弹窗，比如个人信息、班级签等等凡是用到弹窗的地方，字色要求跟
 *            页面是一样的，要实时地动态根据背景颜色去调整。因为我现在页面基本上
 *            都看得清，但有一些字体颜色在弹窗里还是会看不到。」
 *
 * 为什么会看不见：页面里的字色靠主题变量 + .ink-auto 算过一遍，而弹窗是自己一块
 * 独立的底色（有的写死深色渐变，如 .sign-box；有的是玻璃半透明压在自定义背景上）。
 * 弹窗里没显式写 color 的元素会**继承页面字色** —— 深色底 + 深色字，就糊成一片。
 *
 * 做法（只改「确实看不清」的，不动设计）：
 *   ① 对弹窗里每个「直接含文字」的元素，按 WCAG 算「字色 vs 实际底色」的对比度；
 *      实际底色 = 从该元素往上逐层合成（含半透明层、渐变首色、自定义背景图的平均色）。
 *   ② 对比度 ≥ 4.0 就原样保留（品牌色、强调色都不动）；< 4.0 才换成近黑/纯白里更亮的那支。
 *   ③ 实时重算：弹窗打开/关闭、切换昼夜、换背景、转屏，都会重跑一次。
 *      因为是「按当前实际颜色算」，改完自己也会再被校准（不会越改越乱）。
 * ========================================================================= */
var MK_SEL = '[id$="Mask"], [id$="mask"], .allboard-mask, .sign-mask, .confetti-mask, .qr-mask, .welcome-mask, .video-mask';
var MK_MIN = 4.0;          /* 正文最低对比度；4.5 是 AA，这里留点余地，避免把次要文字全刷白/刷黑 */
var MK_BG_AVG = null;      /* 自定义背景图的平均色，用于图片底色的估算 */

/** 解析颜色并保留 alpha（clsParseColor 会丢掉透明度） */
function mkParseA(c){
  var s = String(c || '').trim().toLowerCase();
  var m = /^rgba?\(([^)]+)\)$/.exec(s);
  if(m){
    var p = m[1].split(',').map(function(x){ return parseFloat(x); });
    if(p.length >= 3 && p.every(function(x){ return isFinite(x); })){
      return { rgb: [p[0], p[1], p[2]], a: (p.length > 3 ? Math.max(0, Math.min(1, p[3])) : 1) };
    }
    return null;
  }
  var rgb = clsParseColor(s);
  return rgb ? { rgb: rgb, a: 1 } : null;
}
/** 半透明前景叠到底色上 */
function mkMix(fg, bg, a){
  a = (a == null ? 1 : Math.max(0, Math.min(1, a)));
  return [
    Math.round(fg[0] * a + bg[0] * (1 - a)),
    Math.round(fg[1] * a + bg[1] * (1 - a)),
    Math.round(fg[2] * a + bg[2] * (1 - a)),
  ];
}
/** 元素实际底色：自下而上把每一层背景合成出来 */
function mkEffectiveBg(el){
  var layers = [];
  var node = el;
  while(node && node.nodeType === 1 && node !== document.documentElement){
    var cs;
    try{ cs = getComputedStyle(node); }catch(e){ break; }
    var bi = cs.backgroundImage || '';
    if(bi && bi !== 'none'){
      if(/url\(/i.test(bi)){
        /* 自定义背景图：用启动时算好的平均色（没算出来就跳过，靠下面的层兜底） */
        if(MK_BG_AVG) layers.push({ rgb: MK_BG_AVG, a: 1 });
      }else{
        var mm = /rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/.exec(bi);
        if(mm){ var g = mkParseA(mm[0]); if(g) layers.push({ rgb: g.rgb, a: 0.92 }); }
      }
    }
    var b = mkParseA(cs.backgroundColor);
    if(b && b.a > 0.02) layers.push(b);
    node = node.parentElement;
  }
  var base = mkParseA(getComputedStyle(document.documentElement).backgroundColor);
  var bg = base ? base.rgb : [255, 251, 247];
  for(var i = layers.length - 1; i >= 0; i--){
    bg = mkMix(layers[i].rgb, bg, layers[i].a);
  }
  return bg;
}
/** 这个元素自己是不是「装文字的那一层」（避免给容器统一染色、把子元素的品牌色盖掉） */
function mkHasText(el){
  for(var i = 0; i < el.childNodes.length; i++){
    var n = el.childNodes[i];
    if(n.nodeType === 3 && String(n.textContent || '').trim()) return true;
  }
  return false;
}
/** 核心：扫一个弹窗，把看不清的字改到能看清 */
function mkFix(root){
  if(!root || !root.querySelectorAll) return 0;
  var els = root.querySelectorAll('*');
  var fixed = 0;
  for(var i = 0; i < els.length; i++){
    var el = els[i];
    if(el.nodeType !== 1) continue;
    var isField = /^(INPUT|TEXTAREA|SELECT|BUTTON|OPTION)$/.test(el.tagName);
    if(!mkHasText(el) && !isField) continue;
    var cs;
    try{ cs = getComputedStyle(el); }catch(e){ continue; }
    if(cs.visibility === 'hidden' || cs.display === 'none') continue;
    if(cs.opacity === '0') continue;

    var fg = mkParseA(cs.color);
    if(!fg) continue;
    var bg = mkEffectiveBg(el);
    var fgOn = mkMix(fg.rgb, bg, fg.a);
    if(clsContrast(fgOn, bg) >= MK_MIN) continue;      /* 已经看得清 → 一个字都不动 */

    var cDark  = clsContrast(CLS_INK_RGB_DARK, bg);
    var cLight = clsContrast(CLS_INK_RGB_LIGHT, bg);
    el.style.color = (cDark >= cLight) ? CLS_INK_DARK : CLS_INK_LIGHT;
    fixed++;
  }
  return fixed;
}
/** 当前可见的弹窗根节点 */
function mkVisibleRoots(){
  var out = [];
  var list = document.querySelectorAll(MK_SEL);
  for(var i = 0; i < list.length; i++){
    var el = list[i];
    var cs;
    try{ cs = getComputedStyle(el); }catch(e){ continue; }
    if(cs.display === 'none' || cs.visibility === 'hidden') continue;
    if(parseFloat(cs.opacity || '1') < 0.05) continue;
    /* 侧边栏遮罩没有文字，跳过省点力气 */
    if(el.classList.contains('sidebar-mask')) continue;
    out.push(el);
  }
  return out;
}
var __mkTimer = null;
function mkScanAll(delay){
  if(__mkTimer) clearTimeout(__mkTimer);
  __mkTimer = setTimeout(function(){
    __mkTimer = null;
    var n = 0;
    try{
      var roots = mkVisibleRoots();
      for(var i = 0; i < roots.length; i++) n += mkFix(roots[i]);
    }catch(e){}
    return n;
  }, delay == null ? 60 : delay);
}

/* 自定义背景图 → 平均色（只在本地是 dataURL 时取样，跨域图会污染 canvas 就不碰） */
function mkSampleBg(){
  try{
    var src = (typeof getBgImg === 'function') ? getBgImg() : '';
    if(!src || src.indexOf('data:') !== 0) return;
    var img = new Image();
    img.onload = function(){
      try{
        var cv = document.createElement('canvas');
        cv.width = cv.height = 24;
        var g = cv.getContext('2d');
        g.drawImage(img, 0, 0, 24, 24);
        var d = g.getImageData(0, 0, 24, 24).data;
        var r = 0, gr = 0, b = 0, n = 0;
        for(var i = 0; i < d.length; i += 4){ r += d[i]; gr += d[i+1]; b += d[i+2]; n++; }
        if(n) MK_BG_AVG = [Math.round(r/n), Math.round(gr/n), Math.round(b/n)];
        mkScanAll(0);
      }catch(e){}
    };
    img.src = src;
  }catch(e){}
}

/* 触发时机：开/关弹窗（class 变化）、切主题、换背景、转屏 */
if(typeof MutationObserver === 'function'){
  try{
    new MutationObserver(function(list){
      for(var i = 0; i < list.length; i++){
        var t = list[i].target;
        if(t && t.nodeType === 1 && t.matches && t.matches(MK_SEL)){ mkScanAll(80); return; }
      }
    }).observe(document.body, { attributes:true, attributeFilter:['class','style'], subtree:true });

    /* ⚠️ html 上的 .dark 不在 body 的子树里 —— 只盯 body 会漏掉「切昼夜」。
       漏了会怎样：切到暗色后，之前按亮底写进内联的深色字（内联优先级高于 CSS）
       就留在原地，变成深字压深底，整段看不见。 */
    new MutationObserver(function(){ mkScanAll(120); })
      .observe(document.documentElement, { attributes:true, attributeFilter:['class'] });
  }catch(e){}
}
window.addEventListener('resize', function(){ mkScanAll(200); }, {passive:true});
window.addEventListener('orientationchange', function(){ mkScanAll(320); }, {passive:true});

/* ---------- 登录态持久化 ---------- */
function loadAuth(){
  try{
    var raw = localStorage.getItem(AUTH_KEY);
    if(raw){ var o = JSON.parse(raw); AUTH = { token:o.token||'', user:o.user||null }; }
  }catch(e){ AUTH = { token:'', user:null }; }
}
function saveAuth(){
  try{
    if(AUTH.token) localStorage.setItem(AUTH_KEY, JSON.stringify(AUTH));
    else localStorage.removeItem(AUTH_KEY);
  }catch(e){}
}
function isLoggedIn(){ return !!AUTH.token; }
function isAdmin(){ return !!(AUTH.user && AUTH.user.role === 'admin'); }

/* ============================================================
 * 【站点内容云端化】2026-09-30
 * ------------------------------------------------------------
 * 目标：公告、作业这些「共享内容」改存云端，站主在后台改完即时生效，
 *       不必再改代码 + 等 Pages 重新构建 + 同学清缓存。

 * 设计原则（站主选定「渐进式」）：
 *   ① index.html 里的 SITE_DATA **永久保留**，作为「静态兜底」。
 *      —— 断网、后端挂了、还没部署后端，页面都必须和以前一模一样。
 *   ② 启动时异步去拉云端内容，**拉到才覆盖**，拉不到就静默用本地的。
 *      —— 绝不因为后端问题导致页面空白或报错。
 *   ③ 拉到什么就存进 localStorage 做缓存，并记下服务器时间；
 *      下次先用缓存渲染（秒开），再在后台悄悄比对增量。

 * 云端内容与本地字段的对应关系（改一边要同时看另一边）：
 *     content 键             →  本地落点
 *     announcements          →  SITE_DATA.announcements
 *     holiday_homeworks      →  SITE_DATA.holidayHomeworks
 *     homework_notice        →  SITE_DATA.homeworkNotice
 *     important_dates        →  IMPORTANT_DATES（⚠️ 独立变量，不在 SITE_DATA 里）
 *     daily_quote            →  SITE_DATA.dailyQuote（首页「每日一言」卡片）
 *     site_config            →  站点通用配置（部分字段）
 *
 * ⚠️ 这里的键必须与后端 api/content.js 的 ALLOW_CONTENT_KEYS 对齐。
 *
 * 【2026-10-06 修正】原先这个表里有 4 个「死映射」——
 *   importantDates / dailyQuote / songConfig / activityList
 * 它们只在本表出现，页面上没有任何代码消费，等于写了也白写
 * （云端有数据，但页面不认）。本次处理：
 *   · important_dates → 改接到真实的 IMPORTANT_DATES（见 applyCloudContent 的特判）
 *   · daily_quote     → 补上真实消费点（首页「每日一言」卡片）
 *   · song_config     → 从本表移除（点歌配置改由后台直连 VoiceHub，不走内容通道）
 *   · activities      → 从本表移除（主站活动区用的是 SITE_DATA.activity 单数对象，不是数组）
 * ============================================================ */

/* 云端内容键 ↔ 本地字段名。值为 null 的表示「特殊处理，不走通用赋值」。 */
var CONTENT_MAP = {
  announcements:     'announcements',
  holiday_homeworks: 'holidayHomeworks',
  homework_notice:   'homeworkNotice',
  daily_quote:       'dailyQuote',
  quote_source:      null,             /* v3.5.9 每日一言来源（后台配）→ 落到 SITE_DATA.quoteSource，见 applyCloudContent */
  quote_schedule:    null,             /* v3.5.11 本地库排期 → 落到 SITE_DATA.quoteSchedule */
  study_card:        'studyCard',      /* v2.6.0 学习卡片默认配置（后台配、前台读） */
  popups:            'popups',         /* 通用弹窗引擎（第二十七轮） */
  /* 以下三键（第二十八轮）主站**不消费**，值一律 null —— 加它们只为满足
     「本表必须与后端 ALLOW_CONTENT_KEYS 对齐」这条铁律。
     真正的读写方是后台 admin.html 的「抽歌排期」「版本更新」面板。 */
  dj_schedule:       null,           /* 抽歌排期（后台专用） */
  dj_excluded:       null,           /* 抽歌排除清单（后台专用） */
  release_notes:     null,           /* 版本更新记录（后台专用，前台不展示） */
  vote_pub:          'votePub',      /* v3.5.13 投票公示（模版 + 每票配置），前台渲染公示 */
  important_dates:   null,           /* 特殊：落到 IMPORTANT_DATES，见 applyCloudContent() */
  site_config:       null            /* 特殊：见 applySiteConfig() */
};

var CONTENT_CACHE_KEY = 'cls_content_cache_v1';
var CONTENT_SINCE_KEY = 'cls_content_since_v1';
/* 内容同步状态，供界面显示「已是最新 / 使用本地数据」 */
/* 内容同步状态（供 UI 反映「现在看到的是云端还是缓存」）
   usedCache：本次渲染的数据是从本地缓存来的（说明没连上服务端）。
   v2.5.0 起由离线横幅统一呈现，这个标记保留给后续细化提示用。 */
var CONTENT_STATE = { status:'idle', lastAt:null, count:0, error:null, usedCache:false };

/** 读本地缓存（上次拉到的云端内容） */
function contentCacheGet(){
  try{
    var raw = localStorage.getItem(CONTENT_CACHE_KEY);
    if(!raw) return null;
    var o = JSON.parse(raw);
    return (o && typeof o === 'object') ? o : null;
  }catch(e){ return null; }
}
function contentCacheSet(items){
  try{
    var cur = contentCacheGet() || {};
    Object.keys(items || {}).forEach(function(k){ cur[k] = items[k]; });
    localStorage.setItem(CONTENT_CACHE_KEY, JSON.stringify(cur));
  }catch(e){ /* 隐私模式等写不了就算了，不影响主流程 */ }
}

/** 把一份云端内容合并进 SITE_DATA（只覆盖认识的键，其它忽略） */
function applyCloudContent(items, opts){
  opts = opts || {};
  if(!items || typeof items !== 'object') return 0;
  var n = 0;
  Object.keys(items).forEach(function(k){
    var v = items[k];
    /* 云端没这个键（null）时跳过——不能把本地数据抹成 null */
    if(v === null || v === undefined) return;
    if(k === 'site_config'){ applySiteConfig(v); n++; return; }
    /* v3.5.9 每日一言来源：后台「首页卡片」统一配置，落到 SITE_DATA.quoteSource */
    if(k === 'quote_source'){
      if(typeof v !== 'object' || Array.isArray(v)) return;   /* 类型护栏 */
      if(v.net !== 0 && v.net !== 1) return;
      SITE_DATA.quoteSource = { net: v.net };
      n++;
      return;
    }
    /* v3.5.11 本地库排期：类型护栏做在 quoteSchedule() 里，这里只负责落值 */
    if(k === 'quote_schedule'){
      if(typeof v !== 'object' || Array.isArray(v)) return;
      SITE_DATA.quoteSchedule = v;
      n++;
      return;
    }
    /* v3.5.13 投票公示：{ templates:[...], byVote:{...} }，落到 SITE_DATA.votePub */
    if(k === 'vote_pub'){
      if(typeof v !== 'object' || Array.isArray(v)) return;
      SITE_DATA.votePub = v;
      n++;
      return;
    }
    /* 重要日期落在独立变量 IMPORTANT_DATES 上，不在 SITE_DATA 里。
       必须整体替换数组（渲染函数都现取 IMPORTANT_DATES，替换后立刻生效），
       不做逐项 patch——避免两份数据混在一起对不上。 */
    if(k === 'important_dates'){
      if(!Array.isArray(v) || !v.length) return;   /* 类型/空值护栏 */
      IMPORTANT_DATES = v;
      n++;
      return;
    }
    var field = CONTENT_MAP[k];
    if(!field) return;              /* 不认识的键不动 */
    /* 类型护栏：数组字段必须给数组，对象字段必须给对象。
       类型不对时保留本地值——宁可显示旧的，也不能把页面搞崩。 */
    var local = window.SITE_DATA ? SITE_DATA[field] : undefined;
    if(Array.isArray(local) && !Array.isArray(v)) return;
    if(local && typeof local === 'object' && !Array.isArray(local) && (typeof v !== 'object' || Array.isArray(v))) return;
    SITE_DATA[field] = v;
    n++;
  });
  return n;
}

/** 站点通用配置（站点名、门禁、公告栏问候语等） */
function applySiteConfig(cfg){
  if(!cfg || typeof cfg !== 'object') return;
  /* v3.5.42：班徽图片地址（导出图片右上角用）。空值 = 用站点图标兜底。 */
  if(typeof cfg.badgeUrl === 'string') SITE_DATA.badgeUrl = cfg.badgeUrl.trim();
  ['gateQuestion','gateAnswer','welcomeTitle'].forEach(function(k){
    if(cfg[k] !== undefined && cfg[k] !== null) SITE_DATA[k] = cfg[k];
  });
  /* v3.5.29：siteName / siteSubtitle —— 后台保存空值时写的是 ''（不是删键），
     所以这里也要让 '' 覆盖旧值，清空后才能回落到静态默认。 */
  ['siteName','siteSubtitle'].forEach(function(k){
    if(typeof cfg[k] === 'string') SITE_DATA[k] = cfg[k];
  });
  /* v3.5.13（站主 #3）：点歌投稿上限守卫 { on, limit } —— 后台「点歌管理」配置。
     走 site_config 管道最省一个内容键；base 地址固定用点歌入口链接本身。 */
  if(cfg.vhGuard && typeof cfg.vhGuard === 'object'){
    SITE_DATA.vhGuard = {
      on: !!cfg.vhGuard.on,
      limit: Math.max(0, Number(cfg.vhGuard.limit) || 0),
    };
  }
  /* v3.5.29：站点名称 / 副标题可从后台编辑（站主：「站点的名称及它的一个副名称
     也可以在后台编辑」）—— 落到 site_config.siteName / siteSubtitle 后，
     这里把三处静态文案（<title>、页头大标题、页头副标题）一起换掉。 */
  applyBranding();
}

/** v3.5.29：把 SITE_DATA.siteName / siteSubtitle 渲染到页面。
 *  只在云端真配了值才覆盖 —— 没配时保持 index.html 里的静态默认，
 *  这样老站点不配置行为完全不变。 */
function applyBranding(){
  var name = String(SITE_DATA.siteName || '').trim();
  var sub = String(SITE_DATA.siteSubtitle || '').trim();
  try{
    if(name){
      document.title = name;
      var h1 = document.getElementById('brandTitle');
      if(h1) h1.textContent = '🏫 ' + name;
      var foot = document.getElementById('brandFoot');
      if(foot) foot.textContent = '© ' + name;
    }
    if(sub){
      var p = document.getElementById('brandSub');
      if(p) p.textContent = sub;
    }
  }catch(e){}
}

/* ---------------- 每日一言（2026-10-06 新增；v2.6.0 改随机 + 联网；v3.5.6 可切来源）----------------
   数据源两级：
     ① 联网 hitokoto（https://v1.hitokoto.cn/?c=a&c=b&c=d&c=i，动画/漫画/文学/诗词）
        —— CORS 为 *，浏览器可直连；在「自定义设置 → 每日一言」里可切回只用本地库；
     ② 本地 SITE_DATA.dailyQuote（云端内容键 daily_quote，管理员在后台配）兜底。

   🚀 v2.6.0 站主要求：改成**完全随机**，不再按日期取模顺序轮播。
      旧实现 seed = 年月日，items[seed % items.length] —— 本质是「顺序轮播」，
      同学会觉得「怎么老是那几句」。现在每次刷新都随机，并做**会话内不重复**：
      连续两次刷新不会撞同一句（列表 >1 时）。

   为什么仍保留本地兜底：hitokoto 挂了/断网/被墙时，整块不能变空白。
   联网结果只在本次会话内有效（不写 localStorage），避免缓存住过期内容。
*/
var QUOTE_FALLBACK = [];              /* 本地兜底列表（渲染时从 SITE_DATA 填充） */
var _quoteLastIdx = -1;               /* 上一次抽到的下标，用于避开重复 */
var _quoteRemote = null;              /* 本次会话联网拿到的一言 {text, from} */

/* 归一化 SITE_DATA.dailyQuote：支持「纯字符串」和「{text, from}」两种写法 */
function quoteItems(){
  var list = (window.SITE_DATA && Array.isArray(SITE_DATA.dailyQuote)) ? SITE_DATA.dailyQuote : [];
  var out = [];
  list.forEach(function(it){
    if(typeof it === 'string'){
      var s = it.trim();
      if(s) out.push({ text: s, from: '' });
    }else if(it && typeof it === 'object' && it.text){
      out.push({ text: String(it.text), from: it.from ? String(it.from) : '' });
    }
  });
  return out;
}

/* 从数组里随机取一项，尽量避开上一次的下标（避免「刷新两次看到同一句」） */
function pickRandom(items){
  if(!items || !items.length) return null;
  if(items.length === 1) return items[0];
  var i;
  var guard = 0;
  do {
    i = Math.floor(Math.random() * items.length);
    guard++;
  } while(i === _quoteLastIdx && guard < 12);   /* guard 兜底，防止死循环 */
  _quoteLastIdx = i;
  return items[i];
}

/* 当前该显示哪句：联网优先（若已拿到），否则走本地库排期 */
function dailyQuoteOfToday(){
  if(_quoteRemote && _quoteRemote.text) return _quoteRemote;
  var q = localQuoteOfToday();
  if(q) return q;
  return pickRandom(quoteItems());
}

/* ============================================================
   v3.5.11 本地库排期（站主：「可以指定这两天是哪些句子，指定怎么轮换」）
   ------------------------------------------------------------
   内容键 quote_schedule = {
     mode: 'random' | 'date' | 'order' | 'rotate',
     start: 'YYYY-MM-DD',             // order / rotate 的轮换起点
     fixed: { 'YYYY-MM-DD': [i,j] }   // date 模式下每天指定哪几句（下标，可多句→随机取一句）
   }

   四种模式：
     random —— 每次刷新随机（v2.6.0 起的旧行为，默认）
     order  —— 从起点日期开始每天按列表顺序往下走，走完回头
     rotate —— 从起点日期起每 N 天换一批（N = 每句停留天数，默认 1）
     date   —— 指定日期的句子优先；没指定的日子退回「轮换默认」

   ⚠️ 关键约束：**同一天所有同学看到的必须一样**，所以这里一律按日期算，
      不能随机。只有 random 模式才允许随机。
   ============================================================ */
function quoteSchedule(){
  var raw = (window.SITE_DATA && SITE_DATA.quoteSchedule && typeof SITE_DATA.quoteSchedule === 'object')
    ? SITE_DATA.quoteSchedule : null;
  var out = { mode: 'random', start: '', every: 1, fixed: {} };
  if(!raw) return out;
  var m = String(raw.mode || '');
  if(m === 'order' || m === 'rotate' || m === 'date') out.mode = m;
  if(typeof raw.start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.start)) out.start = raw.start;
  out.every = (Number(raw.every) > 0) ? Math.min(60, Math.floor(Number(raw.every))) : 1;
  if(raw.fixed && typeof raw.fixed === 'object' && !Array.isArray(raw.fixed)){
    Object.keys(raw.fixed).forEach(function(k){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(k)) return;
      if(!Array.isArray(raw.fixed[k])) return;
      out.fixed[k] = raw.fixed[k].map(Number).filter(function(x){ return isFinite(x); });
    });
  }
  return out;
}

/* 本地日期字符串 YYYY-MM-DD（必须用本地时区，不能用 toISOString 切 UTC） */
function quoteDayStr(d){
  d = d || new Date();
  function p(n){ return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* 从某个日期到今天差几天（按本地 0 点算，避开夏令时/时分秒误差） */
function quoteDayDiff(fromStr, toStr){
  var a = new Date(fromStr + 'T00:00:00');
  var b = new Date(toStr + 'T00:00:00');
  if(isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/* 算出「今天该显示第几句」。返回列表下标，取不到返回 -1。 */
function localQuoteIdx(list, todayStr){
  var cfg = quoteSchedule();
  var today = todayStr || quoteDayStr();
  var n = list.length;
  if(!n) return -1;

  /* ① 指定日期优先（date 模式，或任何模式下填了指定日期都先认它 —— 站主写死的那天必须照办） */
  var fixed = cfg.fixed[today];
  if(fixed && fixed.length){
    var valid = fixed.filter(function(i){ return i >= 0 && i < n; });
    if(valid.length){
      /* 指定了多句时，当天固定取第一句（不再随机，保证全班一致） */
      return valid[0];
    }
  }

  if(cfg.mode === 'date') return -1;   /* 只认指定日期，其它天不显示 */

  if(cfg.mode === 'order' || cfg.mode === 'rotate'){
    var start = cfg.start || today;
    var diff = quoteDayDiff(start, today);
    if(diff < 0) diff = ((diff % n) + n) % n;   /* 起点还没到：往回数，别出负数下标 */
    if(cfg.mode === 'order') return diff % n;
    /* rotate：每 N 天换一句 */
    var step = Math.floor(diff / cfg.every);
    return ((step % n) + n) % n;
  }
  return -1;   /* random 模式：交给 pickRandom */
}

/* 本地库今天这一句（random 模式返回 null，表示该随机） */
function localQuoteOfToday(){
  var list = quoteItems();
  if(!list.length) return null;
  var cfg = quoteSchedule();
  var idx = localQuoteIdx(list, quoteDayStr());
  if(idx >= 0) return list[idx];
  if(cfg.mode === 'date') return null;   /* date 模式且今天没指定 → 不显示 */
  return pickRandom(list);
}

/* v3.5.9 站主：「后台的首页卡片里面没有改」——每日一言来源原来只是每个同学
   自己在本机的偏好（UI.quoteNet），后台管不到。现在改成**后台统一配置**：
   内容键 quote_source = { net: 1|0 }，站主在后台「首页卡片」里切，全站生效。
   优先级：后台云端配置 > 同学本机偏好 > 代码默认（联网）。
     · 后台配了「联网」→ 所有人都走 API（本机选过本地也以站主为准）
     · 后台配了「本地库」→ 所有人都不联网，零外部请求
     · 后台没配（老数据）→ 退回同学本机偏好，行为与升级前一致 */
/* v3.9.8（站主）：每日一言可以只显示某些分类
   后台「首页卡片 → 每日一言 → 内容分类」里勾选；没配过就用原来的四类。 */
var QUOTE_CAT_ALL = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
function quoteCats(){
  var cloud = (window.SITE_DATA && SITE_DATA.quoteSource && typeof SITE_DATA.quoteSource === 'object')
    ? SITE_DATA.quoteSource : null;
  var arr = (cloud && Array.isArray(cloud.cats)) ? cloud.cats : null;
  if(!arr || !arr.length) return ['a', 'b', 'd', 'i'];
  var out = arr.filter(function(c){ return QUOTE_CAT_ALL.indexOf(c) >= 0; });
  return out.length ? out : ['a', 'b', 'd', 'i'];
}
function quoteNetAllowed(){
  var cloud = (window.SITE_DATA && SITE_DATA.quoteSource && typeof SITE_DATA.quoteSource === 'object')
    ? SITE_DATA.quoteSource : null;
  if(cloud && (cloud.net === 0 || cloud.net === 1)) return cloud.net === 1;
  return !(typeof UI !== 'undefined' && UI.quoteNet === 0);
}

function renderDailyQuote(){
  var el = document.getElementById('dailyQuoteBar');
  if(!el) return;
  var q = dailyQuoteOfToday();
  /* v3.5.12 站主反馈「隐藏后还会有这种东西」：空内容必须连容器一起藏掉，
     只清 innerHTML 的话 .quote 的白底圆角 padding 还在 → 页面上留一条空白条 */
  if(!q){ el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML =
    '<div class="quote-mark ink-auto">❝</div>'+
    '<div class="quote-body">'+
      '<div class="quote-text">'+emojiEscHtml(q.text)+'</div>'+
      (q.from ? '<div class="quote-from">—— '+esc(q.from)+'</div>' : '')+
      '<div class="quote-refresh">换一句 ↻</div>'+
    '</div>';
  /* v3.9.8（站主）：点这条卡片就换一句新的 */
  el.onclick = function(e){
    if(e && e.target && e.target.closest && e.target.closest('a,button')) return;
    var tip = el.querySelector('.quote-refresh');
    if(tip) tip.textContent = '换一句中…';
    fetchRemoteQuote(true);
    setTimeout(function(){ var t2 = el.querySelector('.quote-refresh'); if(t2) t2.textContent = '换一句 ↻'; }, 1200);
  };
}

/* 联网拉一句（hitokoto）。失败静默——本地兜底照样能用。
   每次会话只拉一次，避免反复请求；拿到后若与当前显示的不同就重绘。

   v3.5.6 两处改动：
     ① 类别 c=k（哲学）→ c=a&c=b&c=d&c=i（动画/漫画/文学/诗词）。
        哲学类会返回政治人物语录，不适合班级站点；这四类内容对学生更合适。
     ② 新增「每日一言来源」开关（自定义设置里切）：选本地库时本函数直接返回，
        不再发起联网请求。 */
var _quoteFetching = false;
function fetchRemoteQuote(force){
  if(_quoteFetching) return;
  /* v3.9.10：轻量模式不拉网络语录（本地库够用），省一次跨域请求 */
  if(liteOn()){
    if(force && typeof uiMsg === 'function') uiMsg('轻量模式用本地语录，不联网', '#b45309');
    return;
  }
  if(!force && _quoteRemote) return;   /* 已经有一句了就不用再拉（除非同学主动点刷新） */
  if(!quoteNetAllowed()){
    if(force && typeof uiMsg === 'function') uiMsg('当前使用的是本地语录库，点「换一句」不联网', '#b45309');
    return;
  }
  if(force) _quoteRemote = null;
  _quoteFetching = true;
  var cats = quoteCats();
  var qs = cats.map(function(c){ return 'c=' + encodeURIComponent(c); }).join('&');
  var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var timer = setTimeout(function(){ if(ctrl) ctrl.abort(); }, 6000);
  fetch('https://v1.hitokoto.cn/?' + qs + '&encode=json', ctrl ? { signal: ctrl.signal } : undefined)
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(j){
      clearTimeout(timer);
      _quoteFetching = false;
      if(!j || !j.hitokoto) return;
      var from = j.from || '';
      if(j.from_who && j.from) from = j.from_who + '《' + j.from + '》';
      else if(j.from_who) from = j.from_who;
      _quoteRemote = { text: String(j.hitokoto), from: String(from || '') };
      renderDailyQuote();                  /* 拿到就替换掉本地那句 */
    })
    .catch(function(){ clearTimeout(timer); _quoteFetching = false; });
}

/* ============================================================
   学习卡片（v2.6.0 新增）
   ------------------------------------------------------------
   站主要求：「不要做一个专门的板块，就跟每日一言一样，在选择好想随机
             出现的学科知识点之后就可以联网更新」

   四类内容（后台可分别开关）：
     · 知识点   —— 内置数据（STUDY_PHYSICS / CHEMISTRY / BIOLOGY），本地随机
     · 每日一词 —— 联网（/api/study 代理有道词典，含音标释义）
     · 古诗文   —— 联网（/api/study 代理今日诗词），失败用内置兜底
     · 每日一题 —— 内置英语选词填空（含答案解析），本地随机

   为什么知识点不联网：网上没有可用的公开 API（实测多家均不可达），
   所以整理成内置数据随前端发布 —— 不依赖第三方、离线可用、内容贴合必修一。

   每次刷新（render）抽一条新的：站主明确要「随机」，不是每日固定。
   ============================================================ */

/* 🚀 v2.6.1 站主要求：暂时隐藏整个学习卡片（bug 较多，等后续再修）。
   ⚠️ 这是**总开关**：false 时首页不渲染卡片、也不发起 /api/study 联网请求，
      容器直接不占高度。改回 true 即可整体恢复，其余代码与后台配置面板都保留。 */
var STUDY_CARD_ENABLED = true;   /* v3.5.9 站主：「保留手动隐藏按钮」→ 恢复显示，同学可在自定义设置里关 */

var STUDY_CFG_KEY = 'cls_study_cfg';
/* 默认配置：四类全开，三科全选 —— 同学第一次打开就有内容看 */
var STUDY_DEFAULT_CFG = { on: true, types: { know: true, word: true, poem: true, quiz: true }, subjects: { physics: true, chemistry: true, biology: true } };

/* 读配置（本地个人设置优先 → 云端下发的默认 → 代码常量）
   优先级设计：个人在「自定义设置」里改过就以个人的为准；
   没改过就用站主在后台配的默认值；后台也没配就用代码里的兜底常量。 */
function studyCfg(){
  var local = null, remote = null;
  try{
    var raw = localStorage.getItem(STUDY_CFG_KEY);
    if(raw) local = JSON.parse(raw);
  }catch(e){}
  /* 云端默认配置（内容键 study_card，站主在后台「学习卡片」面板里配） */
  if(window.SITE_DATA && SITE_DATA.studyCard && typeof SITE_DATA.studyCard === 'object'){
    remote = SITE_DATA.studyCard;
  }
  var base = (local && typeof local === 'object') ? local : (remote || {});
  if(typeof base !== 'object' || !base) base = {};
  var out = {
    on: base.on !== false,
    types: Object.assign({}, STUDY_DEFAULT_CFG.types, base.types || {}),
    subjects: Object.assign({}, STUDY_DEFAULT_CFG.subjects, base.subjects || {})
  };
  return out;
}

/* 会话内随机（复用每日一言的 pickRandom，记住上次下标避开重复）。
   注意：学习卡片可能连续抽两次（知识点 + 题目），所以这里用独立的记录器。 */
var _studyLast = { know: -1, quiz: -1, word: -1, poem: -1 };
function studyPick(kind, arr){
  if(!arr || !arr.length) return null;
  if(arr.length === 1) return arr[0];
  var i, guard = 0;
  do { i = Math.floor(Math.random() * arr.length); guard++; }
  while(i === _studyLast[kind] && guard < 12);
  _studyLast[kind] = i;
  return arr[i];
}

/* 主题色按学科区分，一眼能分辨是哪科 */
var STUDY_SUBJ_META = {
  physics:   { name: '物理', icon: '⚛' },
  chemistry: { name: '化学', icon: '🧪' },
  biology:   { name: '生物', icon: '🧬' }
};

/* 转义（复用全局 esc / emojiEscHtml；这里对公式里的特殊字符做 code 包裹） */
function studyEsc(s){ return (typeof esc === 'function') ? esc(s) : String(s || ''); }

/* ------- 知识点 ------- */
function studyKnowHtml(){
  var cfg = studyCfg();
  var subs = ['physics', 'chemistry', 'biology'].filter(function(k){ return cfg.subjects[k]; });
  if(!subs.length) return null;
  var data = (typeof STUDY_DATA !== 'undefined') ? STUDY_DATA
           : { physics: (typeof STUDY_PHYSICS !== 'undefined' ? STUDY_PHYSICS : []),
               chemistry: (typeof STUDY_CHEMISTRY !== 'undefined' ? STUDY_CHEMISTRY : []),
               biology: (typeof STUDY_BIOLOGY !== 'undefined' ? STUDY_BIOLOGY : []) };
  /* 抽一科，再从该科里抽一条 —— 保证每科被选中的机会均等，
     而不是把三科合成一个大 pool（那样生物条目多，会被抽中太多次） */
  var subj = subs[Math.floor(Math.random() * subs.length)];
  var list = data[subj] || [];
  var it = studyPick('know', list);
  if(!it) return null;
  var meta = STUDY_SUBJ_META[subj] || { name: subj, icon: '📘' };
  return {
    subj: subj,
    html:
      '<div class="study-body"><code>' + studyEsc(it.t) + '</code> —— ' + studyEsc(it.b) + '</div>' +
      (it.n ? '<div class="study-note">' + studyEsc(it.n) + '</div>' : '')
  };
}

/* ------- 每日一题（英语选词填空）------- */
function studyQuizHtml(){
  var list = (typeof STUDY_ENGLISH !== 'undefined') ? STUDY_ENGLISH : [];
  var it = studyPick('quiz', list);
  if(!it) return null;
  var letters = ['A', 'B', 'C', 'D'];
  var opts = it.opts.map(function(o, i){
    return '<div class="study-opt"><b>' + letters[i] + '</b><span>' + studyEsc(o) + '</span></div>';
  }).join('');
  /* 答案默认折叠，点「看答案」才展开 —— 否则一进来就看到答案，失去练习意义 */
  var ansHtml = '<div class="study-ans" id="studyAns">'
    + '<b>答案：' + letters[it.a] + '</b>　' + studyEsc(it.ex)
    + '</div>';
  return {
    subj: 'english',
    html:
      '<div class="study-q">' + studyEsc(it.q) + '</div>' +
      '<div class="study-opts">' + opts + '</div>' + ansHtml
  };
}

/* ------- 每日一词（联网，走后端代理）------- */
function studyWordHtml(){
  var w = _studyWordData();
  if(!w) return null;
  return {
    subj: 'english',
    html:
      '<div class="study-name">' + studyEsc(w.word) + (w.phonetic ? ' <span style="font-weight:400;color:#8a7d72;font-size:.82em">' + studyEsc(w.phonetic) + '</span>' : '') + '</div>' +
      '<div class="study-body">' + studyEsc(w.meaning) + '</div>' +
      (w.example ? '<div class="study-note">例句：' + studyEsc(w.example) + '</div>' : '')
  };
}

/* ------- 古诗文（联网，走后端代理）------- */
function studyPoemHtml(){
  var p = _studyPoemData();
  if(!p) return null;
  return {
    subj: 'chinese',
    html:
      '<div class="study-name">' + studyEsc(p.content) + '</div>' +
      '<div class="study-body" style="font-size:.84rem;color:#6b7f8f">' + studyEsc(p.from) + '</div>'
  };
}

/* 联网数据缓存（本次会话内有效，不写盘 —— 避免缓存住过期内容） */
var _studyRemote = { word: null, poem: null, loading: false, failed: false };

function _studyWordData(){ return _studyRemote.word; }
function _studyPoemData(){ return _studyRemote.poem; }

/* 拉联网内容。三种可能：拿到 → 重绘；拿不到 → 保持本地内容不变。 */
var _studyFetching = false;
function fetchStudyRemote(){
  if(!STUDY_CARD_ENABLED) return;      /* v2.6.1：总开关关了就不联网 */
  if(_studyFetching || _studyRemote.loading) return;
  var cfg = studyCfg();
  if(!cfg.on) return;
  var needWord = cfg.types.word, needPoem = cfg.types.poem;
  if(!needWord && !needPoem) return;
  if((!needWord || _studyRemote.word) && (!needPoem || _studyRemote.poem)) return;

  _studyFetching = true;
  _studyRemote.loading = true;
  var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var timer = setTimeout(function(){ if(ctrl) ctrl.abort(); }, 8000);
  var path = '/study?want=' + (needWord ? 'w' : '') + (needPoem ? 'p' : '');
  /* 走自家后端：jinrishici / youdao 都没有 CORS 头，浏览器直连会被拦 */
  api(path).then(function(j){
    clearTimeout(timer);
    _studyFetching = false; _studyRemote.loading = false;
    if(!j || !j.ok) { _studyRemote.failed = true; return; }
    var changed = false;
    if(j.word && j.word.word){ _studyRemote.word = j.word; changed = true; }
    if(j.poem && j.poem.content){ _studyRemote.poem = j.poem; changed = true; }
    if(changed) renderStudyCard();
  }).catch(function(){
    clearTimeout(timer);
    _studyFetching = false; _studyRemote.loading = false; _studyRemote.failed = true;
  });
}

/* ------- 汇总渲染 ------- */
/* 「换一条」按钮：只换本地能换的（知识点/题目），
   联网类（每日一词、古诗文）点了就重新拉一次。 */
function refreshStudyCard(){
  var cfg = studyCfg();
  if(cfg.types.word) _studyRemote.word = null;
  if(cfg.types.poem) _studyRemote.poem = null;
  renderStudyCard();
  fetchStudyRemote();
}

function renderStudyCard(){
  var el = document.getElementById('studyCard');
  if(!el) return;
  /* v2.6.1 总开关：整块暂时隐藏（站主要求，bug 修好后再开）。
     容器直接 display:none，不留空白、也不触发任何联网请求。 */
  if(!STUDY_CARD_ENABLED || studyHidden()){ el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = '';
  var cfg = studyCfg();
  if(!cfg.on){ el.innerHTML = ''; el.style.display = 'none'; return; }

  /* 候选顺序：知识点 → 每日一题 → 每日一词 → 古诗文
     每次刷新只显示**一条**，从中随机取一个「有内容且已开启」的类型。
     这样做的好处：卡片高度稳定（不会有时一句话、有时一整道题），
     也符合站主「像每日一言一样随机出现」的描述。 */
  var cands = [];
  if(cfg.types.know) cands.push('know');
  if(cfg.types.quiz) cands.push('quiz');
  if(cfg.types.word && _studyRemote.word) cands.push('word');
  if(cfg.types.poem && _studyRemote.poem) cands.push('poem');

  /* 联网类还没回来时，先用本地类顶上；本地类都没开就整块不显示 */
  var picked = cands.length ? cands[Math.floor(Math.random() * cands.length)] : null;
  if(!picked){ el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = '';

  var r = null;
  if(picked === 'know') r = studyKnowHtml();
  else if(picked === 'quiz') r = studyQuizHtml();
  else if(picked === 'word') r = studyWordHtml();
  else if(picked === 'poem') r = studyPoemHtml();
  if(!r){ el.innerHTML = ''; return; }

  /* 标签：学科类显示「物理/化学/生物」，其余显示类型名 */
  var meta = STUDY_SUBJ_META[r.subj];
  var label = meta ? (meta.icon + ' ' + meta.name) : (r.subj === 'english' ? '🔤 英语' : '📜 古诗文');
  var typeName = { know: '知识点', quiz: '每日一题', word: '每日一词', poem: '古诗文' }[picked] || '';

  el.innerHTML =
    '<div class="study-head">' +
      '<div class="study-mark ink-auto">' + (meta ? meta.icon : (r.subj === 'english' ? '🔤' : '📜')) + '</div>' +
      '<div class="study-title"><span class="study-subj">' + label + '</span>' +
        '<span class="study-ch">' + studyEsc(typeName) + '</span></div>' +
      '<div class="study-act">' +
        (picked === 'quiz' ? '<button onclick="studyShowAns()">看答案</button>' : '') +
        '<button onclick="refreshStudyCard()">换一条</button>' +
        '<button onclick="hideStudyCard()" title="不再显示学习卡片">隐藏</button>' +
      '</div>' +
    '</div>' + r.html;
}

/* v3.5.9 站主要求「学习卡片不强制隐藏，保留手动隐藏按钮」：
   点了就记在本机，之后首页不再出现卡片；想恢复在「自定义设置」里重新打开。 */
var STUDY_HIDE_KEY = 'cls_study_hidden';
function hideStudyCard(){
  try{ localStorage.setItem(STUDY_HIDE_KEY, '1'); }catch(e){}
  var el = document.getElementById('studyCard');
  if(el){ el.innerHTML = ''; el.style.display = 'none'; }
  if(typeof uiMsg === 'function') uiMsg('已隐藏学习卡片，可在「自定义设置」里重新打开');
}
function studyHidden(){
  try{ return localStorage.getItem(STUDY_HIDE_KEY) === '1'; }catch(e){ return false; }
}
function showStudyCard(){
  try{ localStorage.removeItem(STUDY_HIDE_KEY); }catch(e){}
  renderSettings();
  renderStudyCard();
  if(typeof uiMsg === 'function') uiMsg('学习卡片已恢复');
}

/* 每日一题：展开答案 */
function studyShowAns(){
  var a = document.getElementById('studyAns');
  if(!a) return;
  a.classList.add('show');
  var btn = document.querySelector('#studyCard .study-act button');
  if(btn && btn.textContent === '看答案') btn.style.display = 'none';
}


/**
 * 拉云端内容。
 * @param {boolean} force  true = 忽略本地记录的 since，全量拉
 * @returns {Promise<{ok:boolean, count:number, error?:string, usedCache?:boolean}>}
 * 任何情况下都不 reject——调用方不需要处理异常，失败就是「用本地数据」。
 */
function syncCloudContent(force){
  if(!apiReady()){
    CONTENT_STATE = { status:'unavailable', lastAt:null, count:0, error:'后端未配置', usedCache:true };
    return Promise.resolve({ ok:false, count:0, error:'后端未配置', usedCache:true });
  }
  var since = null;
  if(!force){
    try{ since = Number(localStorage.getItem(CONTENT_SINCE_KEY)) || null; }catch(e){}
  }
  var path = '/content' + (since ? ('?since=' + since) : '');
  CONTENT_STATE.status = 'loading';
  return api(path).then(function(j){
    if(!j || !j.ok) throw new Error((j && j.error) || '接口返回异常');
    var items = j.items || {};
    var n = applyCloudContent(items);
    contentCacheSet(items);
    /* 记服务器时间而不是本地时间：避免手机时间不准导致增量漏内容 */
    if(j.serverTime){
      try{ localStorage.setItem(CONTENT_SINCE_KEY, new Date(j.serverTime).getTime()); }catch(e){}
    }
    CONTENT_STATE = { status:'ok', lastAt:new Date(), count:n, error:null, usedCache:false };
    return { ok:true, count:n, changed:n > 0, usedCache:false };
  }).catch(function(e){
    CONTENT_STATE = { status:'error', lastAt:null, count:0,
      error:String(e && e.message || e), usedCache:true };
    return { ok:false, count:0, error:CONTENT_STATE.error, usedCache:true };
  });
}

/* ============================================================================
 * v3.7.0（站主 #2）：首屏先用本地缓存，云端在后台慢慢同步
 * ----------------------------------------------------------------------------
 * 站主原话：「前台进入时优先使用缓存内容确保页面全部正常显示，云端内容持续加载
 *            直到云端全部同步后自动刷新用户页面再确保该页面为最新，在这之前
 *            页面全部由缓存构成，此过程无需告知用户」
 *
 * 之前的问题：首次渲染（goHomeView）跑在 contentBoot 之前，
 * 用的是 HTML 里写死的那份旧数据 → 先闪一下旧内容，再被缓存/云端覆盖。
 *
 * 现在：这个函数在**第一次渲染之前**就把缓存套进 SITE_DATA，
 * 首屏直接用缓存画；等云端回来再由 syncCloudContent 触发重绘。
 * 全程不弹提示、不显示 loading。
 * ========================================================================= */
var __contentCachedApplied = false;
function contentCacheBootstrap(renderAfter){
  if(__contentCachedApplied) return 0;
  __contentCachedApplied = true;
  var cached = contentCacheGet();
  if(!cached) return 0;
  var n = 0;
  try{ n = applyCloudContent(cached); }catch(e){ n = 0; }
  if(n > 0 && renderAfter){
    /* 首屏已经画完才发现有缓存（比如从别处调用）→ 补一次重绘 */
    try{ if(typeof rerenderAll === 'function') rerenderAll(); }catch(e){}
  }
  return n;
}

/** 启动时：先用缓存立刻渲染（秒开、离线也行），再去后台同步 */
function contentBoot(){
  contentCacheBootstrap(true);
  /* 后台同步：成功了且内容有变，再重渲染一次 */
  syncCloudContent(false).then(function(r){
    if(r.ok && r.count > 0){
      try{ if(typeof rerenderAll === 'function') rerenderAll(); }catch(e){}
      if(typeof refreshHwViews === 'function') refreshHwViews();
    }
    /*首次访问没有本地缓存，开屏弹（SITE_DATA.popups）要等云端回来才存在。
       而 popInit 在启动 1200ms 就跑过一遍「有没有 boot 弹」的检查，
      首次会跑在数据前面 → 开屏弹被漏掉。这里云端到位后补跑一次；
      popShouldAuto 靠 POP_SESSION 去重，不会重复弹。（2026-10-08） */
    if(r.ok){ try{ if(typeof popInit === 'function') popInit(); }catch(e){} }
  });
}

/** 内容变动后，把跟作业/公告相关的界面刷一遍 */
function refreshHwViews(){
  try{
    var cm = document.getElementById('hwCurrentMask');
    if(cm && cm.classList.contains('show') && typeof showCurrentHomework === 'function') showCurrentHomework();
    var cal = document.getElementById('hwCalendarMask');
    if(cal && cal.classList.contains('show') && typeof _renderHwCalendar === 'function') _renderHwCalendar();
    if(typeof hwPopBubbleShow === 'function') hwPopBubbleShow();
  }catch(e){}
}

/* ---------- 登录按钮随登录态变化 ----------
   位置：公告栏「公众号」左边（2026-10-05 从侧边栏挪过来的）。

   2026-10-06 起账号体系正式启用：账号由管理员批量导入（用户名=姓名，
   初始密码=8位出生日期，首次登录建议改密）。所以未登录时按钮**可点**，
   打开登录弹窗；自助注册由后台总开关控制（REGISTER_OPEN）。

   v2.10.0：REGISTER_OPEN 不再写死 —— 启动时拉 /auth?action=register-config
   （后台「系统设置 → 开放自助注册」），读不到/无后端时保持 false，
   与历史行为一致（不显示注册入口）。 */
var REGISTER_OPEN = false;

/** v2.10.0：拉取注册配置（总开关 + 审核），决定注册 tab 显隐 */
function loadRegisterConfig(){
  if(!apiReady()) return;
  api('/auth?action=register-config').then(function(j){
    REGISTER_OPEN = !!(j && j.open);
    /* 账号弹窗正开着、停在登录 tab → 重渲染一次，让 tab 随开关出现/消失 */
    var m = document.getElementById('acctMask');
    if(m && m.classList.contains('show') && ACCT_TAB === 'login' && !isLoggedIn()){
      renderAccount();
    }
  }).catch(function(){ /* 拉不到就维持 false：不显示注册入口 */ });
}

function refreshAcctBtn(){
  var b = document.getElementById('acctBtn');
  if(!b) return;

  if(isLoggedIn()){
    var name = AUTH.user.displayName || AUTH.user.username;
    var badge = isAdmin() ? ' ' + iconSvg('wrench',13) : '';
    var t = (AUTH.user.title || '').trim();
    /* 头衔取第一个展示，多了放不下 */
    var titleTag = t ? '「' + esc(t.split(/[,，、]/)[0]) + '」' : '';
    b.innerHTML = iconSvg('user',14) + ' ' + titleTag + esc(name) + badge;
    b.classList.add('acct-on');
    b.disabled = false;
    b.removeAttribute('aria-disabled');
    b.onclick = openAccount;
    b.title = '查看 / 修改我的个人信息';
  }else{
    /* 未登录：按钮可点，打开登录弹窗（账号由管理员导入，注册入口关闭） */
    b.innerHTML = iconSvg('user',14) + ' 登录';
    b.classList.remove('acct-on');
    b.disabled = false;
    b.removeAttribute('aria-disabled');
    b.onclick = openAccount;
    b.title = '登录';
  }
}

/* ---------- 打开账号弹窗 ---------- */
var ACCT_TAB = 'login';   /* login | register | profile */

function openAccount(){
  var m = document.getElementById('acctMask');
  if(!m) return;
  /* 需求：暂不开放注册。未登录时只给登录 tab，
     万一之前停在 register 也得掰回来，否则会渲染出一个进不去的表单。 */
  if(!isLoggedIn() && !REGISTER_OPEN) ACCT_TAB = 'login';
  renderAccount();
  m.classList.add('show');
  if(typeof SFX !== 'undefined' && SFX && SFX.pop) SFX.pop();
}
function closeAccount(){
  /* 首次登录强制改密期间不允许关闭（防止跳过）；改完密码自动离开该态 */
  if(ACCT_TAB === 'forcepwd' && isLoggedIn()) return;
  var m = document.getElementById('acctMask'); if(m) m.classList.remove('show');
}

function acctTab(k){
  if(k === 'register' && !REGISTER_OPEN && !isLoggedIn()) return;
  ACCT_TAB = k;
  /* v2.10.0：操作日志 —— 账号弹窗内切换标签 */
  if(typeof actLog === 'function'){
    var _tabNames = { login:'登录', register:'注册', profile:'我的账号', myprofile:'我的资料', forcepwd:'设置新密码' };
    actLog('switch', _tabNames[k] || String(k), '', '账号弹窗');
  }
  renderAccount();
  if(typeof SFX !== 'undefined' && SFX && SFX.click) SFX.click();
}

function renderAccount(){
  var box = document.getElementById('acctBody');
  var title = document.getElementById('acctTitle');
  if(!box) return;

  /* 已登录 → 个人中心（首次登录强制改密态优先，不允许跳过） */
  if(isLoggedIn()){
    if(ACCT_TAB === 'forcepwd'){
      if(title) title.innerHTML = iconSvg('lock',15) + ' 设置新密码';
      box.innerHTML = acctForcePwdHtml();
      acctCloseHidden(true);
      var fpWrap = document.getElementById('acctBody');
      if(fpWrap){
        fpWrap.querySelectorAll('input').forEach(function(inp){
          inp.addEventListener('keydown', function(e){
            if(e.key === 'Enter') doForceChangePwd();
          });
        });
      }
      return;
    }
    acctCloseHidden(false);
    /* 个人资料页（账号弹窗内嵌，不跳转；2026-10-06 站主要求「点开姓名就能改」） */
    if(ACCT_TAB === 'myprofile'){
      if(title) title.innerHTML = iconSvg('contact',15) + ' 我的资料';
      box.innerHTML = myProfileHtml();
      try{ mpAfterRender(); }catch(e){}
      if(MY_PROF_STATE === 'idle') myProfLoad();
      return;
    }
    if(title) title.innerHTML = iconSvg('user',15) + ' 我的账号';
    box.innerHTML = acctProfileHtml();
    return;
  }
  acctCloseHidden(false);

  if(title) title.innerHTML = ACCT_TAB === 'register' ? (iconSvg('square-pen',15) + ' 注册账号') : (iconSvg('user',15) + ' 登录账号');

  /* 注册未开放时干脆不渲染 tab 栏，免得用户点了没反应更困惑 */
  var tabs = REGISTER_OPEN
    ? '<div class="acct-tabs">' +
        '<button class="acct-tab' + (ACCT_TAB === 'login' ? ' active' : '') + '" onclick="acctTab(\'login\')">登录</button>' +
        '<button class="acct-tab' + (ACCT_TAB === 'register' ? ' active' : '') + '" onclick="acctTab(\'register\')">注册</button>' +
      '</div>'
    : '';

  var form = ACCT_TAB === 'register'
    ? '<div class="acct-field"><label>用户名</label><input id="acctU" placeholder="3–20 位，中英文/数字/下划线" autocomplete="username"></div>' +
      '<div class="acct-field"><label>显示名（可选）</label><input id="acctD" placeholder="同学们看到的名字" autocomplete="nickname"></div>' +
      '<div class="acct-field"><label>密码</label><input id="acctP" type="password" placeholder="至少 6 位" autocomplete="new-password"></div>' +
      '<div class="acct-field"><label>确认密码</label><input id="acctP2" type="password" placeholder="再输一次" autocomplete="new-password"></div>' +
      '<div class="acct-field"><label>安全验证</label>' + capHtml() + '</div>' +
      '<button class="acct-btn" id="acctGo" onclick="doRegister()">注册并登录</button>'
    : '<div class="acct-field"><label>用户名</label><input id="acctU" placeholder="输入用户名" autocomplete="username"></div>' +
      '<div class="acct-field"><label>密码</label><input id="acctP" type="password" placeholder="输入密码" autocomplete="current-password"></div>' +
      '<div class="acct-field"><label>安全验证</label>' + capHtml() + '</div>' +
      '<p class="acct-hint" style="margin:2px 0 10px">💡 用户名就是你的<b>姓名</b>，初始密码是<b>出生日期 8 位数字</b>（如 2010 年 7 月 10 日生 → <code>20100710</code>）。</p>' +
      '<button class="acct-btn" id="acctGo" onclick="doLogin()">登录</button>';

  box.innerHTML = tabs + form +
    '<div class="acct-msg" id="acctMsg"></div>' +
    '<p class="acct-hint">登录后可以把自己的设置、作业打勾等同步到云端，换设备不用重新弄。<br>' +
    '<b>不登录也完全不影响使用</b>，数据照样存在你自己手机上。</p>';

  /* 渲染并绑定图形验证码（每次进登录页都是一张全新的图）。
     「换一张」的点击由 capBind() 内部绑定，这里不再重复绑一遍。 */
  capInit();
  capBind();

  /* 回车提交 */
  var wrap = document.getElementById('acctBody');
  if(wrap){
    wrap.querySelectorAll('input').forEach(function(inp){
      inp.addEventListener('keydown', function(e){
        if(e.key === 'Enter'){ ACCT_TAB === 'register' ? doRegister() : doLogin(); }
      });
    });
  }
  /* v2.5.0：账号面板每次重绘，就地再图标化一次（不挂监听）。 */
  try{ iconifyStatic(box); }catch(e){}
}

function acctMsg(t, cls){
  var el = document.getElementById('acctMsg');
  if(el){ el.textContent = t || ''; el.className = 'acct-msg ' + (cls || ''); }
}

/* 强制改密期间隐藏/恢复弹窗右上角「关闭」按钮 */
function acctCloseHidden(hide){
  var head = document.querySelector('#acctMask .allboard-head');
  if(!head) return;
  var btn = head.querySelector('button');
  if(btn) btn.style.display = hide ? 'none' : '';
}

/* 首次登录改密表单（v2.10.0 起改为「建议制」：可跳过，不再强制） */
function acctForcePwdHtml(){
  /* v2.9.9：刷新页面后内存里的初始密码（FORCE_OLD_PWD）就丢了，
     而强制改密态以前不会恢复 —— 用户只能退出重登。
     现在 initAuth 的 me 回包会恢复该态，此时补一个「当前密码」输入框
     （初始密码一般是出生日期，提示写清楚），老路径不受影响。 */
  var oldField = FORCE_OLD_PWD ? '' :
      '<div class="acct-field"><label>当前密码（初始密码一般是出生日期）</label>'
    + '<input id="fpOld" type="password" autocomplete="current-password"></div>';
  /* v2.10.0：站主要求「不再强制修改初始密码，改为建议修改」。
     文案从「请先设置才能使用」改成安全建议口吻；新增【暂不修改】，
     跳过不清服务端标志（后台「待改密」徽章仍有意义），只记本地，
     之后个人中心常驻提示条，随时能改。 */
  return '<div class="acct-hint" style="margin-bottom:10px">你的账号目前用的是初始密码（出生日期），'
    + '太容易被猜到。<b>建议</b>换一个只有自己知道的密码。'
    + '不想现在改也没关系，点「暂不修改」即可跳过，之后随时可以在「我的账号」里改。</div>'
    + oldField
    + '<div class="acct-field"><label>新密码（至少 6 位）</label>'
    + '<input id="fpP1" type="password" autocomplete="new-password"></div>'
    + '<div class="acct-field"><label>再输一遍确认</label>'
    + '<input id="fpP2" type="password" autocomplete="new-password"></div>'
    + '<button class="acct-btn" id="fpGo" onclick="doForceChangePwd()">保存并继续</button>'
    + '<button class="acct-btn ghost" style="margin-top:8px" onclick="skipForceChangePwd()">暂不修改</button>'
    + '<div class="acct-msg" id="fpMsg"></div>';
}

/* ---------- v2.10.0：建议制改密 · 跳过 ----------
   ① 回个人中心（弹窗不关，琥珀色提示条就在眼前，想改随时能改）
   ② 本地按用户名记一笔：刷新页面、下次登录都不再弹强制态
   ③ 服务端 mustChangePassword 不动：后台用户列表的「待改密」徽章仍然显示 */
function skipForceChangePwd(){
  try{
    if(AUTH.user && AUTH.user.username){
      localStorage.setItem('cls_pwd_skip_' + AUTH.user.username, '1');
    }
  }catch(e){}
  ACCT_TAB = 'profile';
  renderAccount();
}
/** 这个账号以前有没有跳过过改密（跳过 → 不再强制弹） */
function pwdSkipped(){
  try{
    return !!(AUTH.user && AUTH.user.username &&
      localStorage.getItem('cls_pwd_skip_' + AUTH.user.username) === '1');
  }catch(e){ return false; }
}

function acctBusy(on, text){
  var b = document.getElementById('acctGo');
  if(!b) return;
  b.disabled = !!on;
  if(on){ b.dataset.old = b.textContent; b.textContent = text || '处理中…'; }
  else if(b.dataset.old){ b.textContent = b.dataset.old; }
}

function val(id){ var e = document.getElementById(id); return e ? e.value.trim() : ''; }

/* ---------- 图形验证码（v2.6.3，替换原滑块拼图）----------
   站主反馈「滑块验证在有些老的手机屏幕上用不了」，改成**输入式**：
   屏幕上显示 4 位数字，照着输进去即可。

   为什么老手机用不了滑块（改动的真正原因）：
     ① 原实现走 Pointer Events —— 老浏览器（iOS Safari < 13 /
        Android Chrome < 55）**根本不支持**，事件一个都不触发，滑块完全拖不动；
     ② 拖动还要求手指精准，屏幕旧了 / 触摸不灵时也很难完成。
   现在只看「键盘能不能打字」，门槛低得多，也不再依赖任何手势。

   安全定位（如实说）：纯前端校验，能拦住**手工试密码**，
   但拦不住直接调接口的脚本 —— 真正的防线是服务端的失败锁定。
   这与原滑块方案是同一档，本轮**不降低**安全性。
   不联网、不上传、不采集任何指纹信息，通过状态只存在内存里。 */
var CAP_STATE = { ok: false, code: '' };
var CAP_LEN = 4;          /* 验证码位数 */
var CAP_H   = 58;         /* 图片高度（CSS 像素） */

function capHtml(){
  return '<div class="cap-wrap" id="capWrap">'
    + '<div class="cap-stage" id="capStage">'
      + '<canvas id="capImg"></canvas>'
      + '<button type="button" class="cap-refresh" id="capRefresh" title="换一张">↻</button>'
    + '</div>'
    + '<input class="cap-input" id="capInput" type="text" inputmode="numeric"'
      + ' pattern="[0-9]*" maxlength="' + CAP_LEN + '" autocomplete="off"'
      + ' spellcheck="false" placeholder="输入图中 ' + CAP_LEN + ' 位数字">'
    + '<span class="cap-tip" id="capTip"></span>'
    + '</div>';
}

function capRand(a, b){ return a + Math.random() * (b - a); }
/* 随机颜色统一用 rgb/rgba 拼字符串（不用 hsl/hsla —— 个别老浏览器
   对 hsl 支持不全，画出来会是透明或黑色，等于验证码看不见） */
function capRGBA(a){
  var f = function(){ return Math.floor(capRand(0, 255)); };
  return 'rgba(' + f() + ',' + f() + ',' + f() + ',' + (a === undefined ? 1 : a) + ')';
}

/* 画一张验证码图：浅底 + 噪点 + 干扰线 + 随机旋转/偏移的数字。
   只用最基础的 Canvas 2D API（fillRect / arc / lineTo / fillText / rotate），
   老设备也支持；字体走系统 sans-serif，不依赖任何自定义字体。 */
function capPaint(cv, code){
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var stage = cv.parentNode;
  var w = Math.round((stage && stage.clientWidth) || 0);
  var h = CAP_H;
  if(w < 80) w = 240;                  /* 布局还没完成时的兜底宽度 */
  cv.width  = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.width  = w + 'px';
  cv.style.height = h + 'px';

  var ctx = cv.getContext('2d');
  if(!ctx) return false;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  /* 跟随主题：暗色模式下用深底浅字，和 .cap-stage 的 CSS 底色保持一致，
     否则夜里打开登录框会突然弹出一块刺眼的亮色区域。
     ⚠️ 本项目主题是挂在 <html> 上的 **`.dark` class**（不是 data-theme 属性），
        写成 getAttribute('data-theme') 会永远拿到 null、暗色判断永不成立。 */
  var dark = document.documentElement.classList.contains('dark');
  ctx.fillStyle = dark ? '#2b2622' : '#fdfbf9';
  ctx.fillRect(0, 0, w, h);

  /* 彩色噪点 */
  for(var i = 0; i < 140; i++){
    ctx.fillStyle = capRGBA(capRand(dark ? .16 : .10, dark ? .40 : .30).toFixed(2));
    ctx.beginPath();
    ctx.arc(capRand(0, w), capRand(0, h), capRand(1, 2.6), 0, Math.PI * 2);
    ctx.fill();
  }

  /* 干扰线：几条随机折线，淡但看得见 */
  for(var j = 0; j < 4; j++){
    ctx.strokeStyle = capRGBA(dark ? .5 : .42);
    ctx.lineWidth = capRand(1, 1.8);
    ctx.beginPath();
    var y0 = capRand(6, h - 6);
    ctx.moveTo(0, y0);
    for(var x = 0; x <= w; x += Math.max(18, w / 6)){
      ctx.lineTo(x, y0 + capRand(-9, 9));
    }
    ctx.stroke();
  }

  /* 数字：每个单独随机旋转、上下偏移、换色。
     浅底用深字、深底用浅字，保证任何主题下都读得清。 */
  var slot = (w - 24) / CAP_LEN;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for(var k = 0; k < code.length; k++){
    var cx = 12 + slot * k + slot / 2;
    var cy = h / 2 + capRand(-5, 5);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(capRand(-0.30, 0.30));        /* 约 ±17° */
    ctx.font = 'bold ' + Math.round(capRand(28, 33)) + 'px sans-serif';
    ctx.fillStyle = dark
      ? 'rgb(' + Math.floor(capRand(190, 235)) + ',' + Math.floor(capRand(185, 225)) + ',' + Math.floor(capRand(180, 215)) + ')'
      : 'rgb(' + Math.floor(capRand(35, 80)) + ',' + Math.floor(capRand(35, 80)) + ',' + Math.floor(capRand(35, 80)) + ')';
    ctx.fillText(code[k], 0, 0);
    ctx.restore();
  }
  return true;
}

/* 生成一张全新的验证码（进登录页时、以及每次校验失败后都会调） */
function capInit(){
  var wrap = document.getElementById('capWrap');
  var cv   = document.getElementById('capImg');
  if(!wrap || !cv) return;

  var code = '';
  for(var i = 0; i < CAP_LEN; i++){ code += String(Math.floor(Math.random() * 10)); }
  CAP_STATE.code = code;
  CAP_STATE.ok = false;

  var ok = capPaint(cv, code);
  var w = cv.parentNode ? cv.parentNode.clientWidth : 0;
  /* 弹窗刚插入时可能还没完成布局（宽度拿到 0），先 rAF 重试几帧 */
  if(!ok || !w){
    var tries = parseInt(wrap.dataset.capTry || '0', 10);
    if(tries < 5){
      wrap.dataset.capTry = String(tries + 1);
      requestAnimationFrame(capInit);
      return;
    }
  }
  wrap.dataset.capTry = '0';

  var inp = document.getElementById('capInput');
  if(inp) inp.value = '';
  var tip = document.getElementById('capTip');
  if(tip){ tip.textContent = '看不清？点右上角换一张'; tip.className = 'cap-tip'; }
  wrap.classList.remove('ok', 'bad');
}

/* 绑定交互：换一张按钮 + 输入框（只收数字、自动截断） */
function capBind(){
  var inp = document.getElementById('capInput');
  var rf  = document.getElementById('capRefresh');
  if(rf && !rf.dataset.bound){
    rf.dataset.bound = '1';
    rf.addEventListener('click', function(){ capInit(); });
  }
  if(!inp || inp.dataset.bound) return;
  inp.dataset.bound = '1';
  /* 手机数字键盘也能打出别的字符（粘贴 / 输入法候选），统一过滤掉非数字，
     免得用户看着图输对了、却因为多了个空格被判错。 */
  inp.addEventListener('input', function(){
    var v = String(inp.value || '').replace(/\D/g, '').slice(0, CAP_LEN);
    if(v !== inp.value) inp.value = v;
  });
}

/* 校验入口：通过返回 true；未通过则提示 + 换一张新码，返回 false。
   ⚠️ 每次失败都换新码 —— 让手工试错的人每次都得重新读图。 */
function capPassed(){
  var wrap = document.getElementById('capWrap');
  var tip  = document.getElementById('capTip');
  var inp  = document.getElementById('capInput');
  var typed = inp ? String(inp.value || '').replace(/\D/g, '') : '';

  if(typed && typed === CAP_STATE.code){
    CAP_STATE.ok = true;
    if(wrap){ wrap.classList.remove('bad'); wrap.classList.add('ok'); }
    if(tip) tip.textContent = '✓ 验证通过';
    if(typeof SFX !== 'undefined' && SFX && SFX.success) SFX.success();
    return true;
  }

  CAP_STATE.ok = false;
  if(wrap){ wrap.classList.remove('ok'); wrap.classList.add('bad'); }
  if(tip) tip.textContent = typed ? '验证码不对，已换一张新的' : '请先输入图中的数字';
  if(typeof SFX !== 'undefined' && SFX && SFX.error) SFX.error();
  setTimeout(function(){
    if(wrap) wrap.classList.remove('bad');
    capInit();
  }, 620);
  return false;
}

/* ---------- 注册 ---------- */
function doRegister(){
  var u = val('acctU'), p = val('acctP'), p2 = val('acctP2'), d = val('acctD');
  if(!u || !p){ acctMsg('请填写用户名和密码', 'err'); return; }
  if(p !== p2){ acctMsg('两次输入的密码不一样', 'err'); return; }
  if(p.length < 6){ acctMsg('密码至少 6 位', 'err'); return; }
  if(!capPassed()){ acctMsg('请先输入图中的验证码', 'err'); return; }

  acctBusy(true, '注册中…');
  api('/auth?action=register', { method:'POST', body:{ username:u, password:p, displayName:d } })
    .then(function(j){
      acctBusy(false);
      /* v2.10.0：开启注册审核后，后端不签发 token —— 注册成功但无法登录，
         明确提示「等待审核」，不走后面的自动登录流程。 */
      if(j.pending || !j.token){
        acctMsg(j.message || '注册成功，等待管理员审核通过后即可登录', 'ok');
        return;
      }
      AUTH = { token:j.token, user:j.user };
      saveAuth();
      refreshAcctBtn();
      acctMsg(j.message || '注册成功', 'ok');
      startHeartbeat();
      syncRoster();   /* 登录后名单改从云端拉（2026-10-07） */
      setTimeout(function(){
        renderAccount();
        if(typeof uiMsg === 'function') uiMsg('✅ ' + (j.message || '注册成功'));
      }, 500);
    })
    .catch(function(e){ acctBusy(false); acctMsg(e.message, 'err'); });
}

/* ---------- 登录 ---------- */
function doLogin(){
  var u = val('acctU'), p = val('acctP');
  if(!u || !p){ acctMsg('请填写用户名和密码', 'err'); return; }
  if(!capPassed()){ acctMsg('请先输入图中的验证码', 'err'); return; }

  acctBusy(true, '登录中…');
  /* v2.9.9：优先浏览器本地派生 credential（服务端零派生，根治改密超时）；
     老浏览器 / salt 接口异常时自动回退明文路径 */
  clsLogin(u, p)
    .then(function(j){
      AUTH = { token:j.token, user:j.user };
      saveAuth();
      refreshAcctBtn();
      acctBusy(false);
      startHeartbeat();
      syncRoster();   /* 登录后名单改从云端拉（2026-10-07） */
      /* v3.7.0（站主 #3）：登录时把班徽下到本地，导出图片直接用缓存 */
      try{ badgeCacheLoad(false); }catch(e){}

      /* 首次登录（管理员批量导入的初始密码）→ 建议改密。
         v2.10.0 起改为建议制：以前跳过过的账号不再弹强制态，
         只走正常登录流程（个人中心有常驻提示条）。
         初始密码要在内存里暂存一下，作为改密接口的「原密码」参数。 */
      if(j.mustChangePassword && !pwdSkipped()){
        FORCE_OLD_PWD = p;
        ACCT_TAB = 'forcepwd';
        renderAccount();
        return;
      }
      if(AUTH.user) AUTH.user.mustChangePassword = !!j.mustChangePassword;

      acctMsg('登录成功，正在读取云端数据…', 'ok');
      /* 拉一次「我认领的资料」，供资料查询页判断哪条是本人（可就地编辑联系方式） */
      if(typeof pcLoadMyProfile === 'function') pcLoadMyProfile();
      /* 登录后自动拉一次云端数据（有则询问是否覆盖本机） */
      syncPull(true).then(function(){
        try{ closeAccount(); }catch(e){}
        renderAccount();
        /* v3.8.4：从分享链接被拦下来的，登录完直接回到那条分享的位置 */
        try{ if(typeof afterLoginResume === 'function') afterLoginResume(); }catch(e){}
        try{ if(typeof reportBoardCatalog === 'function') reportBoardCatalog(); }catch(e){}
        if(typeof uiMsg === 'function') uiMsg('✅ 登录成功');
      });
    })
    .catch(function(e){ acctBusy(false); acctMsg(e.message, 'err'); });
}

/* 强制改密：登录时输入的初始密码暂存（仅内存，改完即清） */
var FORCE_OLD_PWD = '';

/* ---------- 首次登录强制改密 ---------- */
function doForceChangePwd(){
  var p1 = val('fpP1'), p2 = val('fpP2');
  /* 刷新页面后 FORCE_OLD_PWD 为空，从补出的输入框里取当前密码 */
  var oldPwd = FORCE_OLD_PWD || val('fpOld');
  var msg = document.getElementById('fpMsg');
  function say(t, cls){ if(msg){ msg.className = 'msg ' + (cls || 'err') + ' show'; msg.textContent = t; } }

  if(!oldPwd){ say('请输入当前密码（初始密码一般是出生日期）'); return; }
  if(!p1 || p1.length < 6){ say('新密码至少 6 位'); return; }
  if(p1.length > 64){ say('新密码最长 64 位'); return; }
  if(p1 === oldPwd){ say('新密码不能和当前密码一样'); return; }
  if(p1 !== p2){ say('两次输入的新密码不一致'); return; }

  var btn = document.getElementById('fpGo');
  if(btn) btn.disabled = true;
  /* v2.9.9：客户端派生路径（服务端零派生，50000 档位一视同仁） */
  clsChangePwd(oldPwd, p1, AUTH.user && AUTH.user.username)
    .then(function(j){
      /* 接口会踢掉全部旧会话并签发新 token —— 必须更新本地存储，否则后续请求全 401 */
      if(j.token) AUTH = { token:j.token, user: (AUTH.user || {}) };
      FORCE_OLD_PWD = '';
      /* v3.8.4：改完初始密码 → 如果是被分享链接拦下来的，直接跳到目标板块 */
      try{ if(typeof afterLoginResume === 'function') setTimeout(afterLoginResume, 260); }catch(e){}
      /* v2.10.0：改密成功 → 清掉「跳过」记录与本地标志，个人中心提示条消失 */
      if(AUTH.user){
        AUTH.user.mustChangePassword = false;
        try{
          if(AUTH.user.username){
            localStorage.removeItem('cls_pwd_skip_' + AUTH.user.username);
          }
        }catch(e){}
      }
      saveAuth();
      startHeartbeat();
      syncRoster();   /* 改密成功后才算真正登录，这时才拉名单（2026-10-07） */
      ACCT_TAB = 'profile';
      if(typeof pcLoadMyProfile === 'function') pcLoadMyProfile();
      syncPull(true).then(function(){ renderAccount(); });
      if(typeof uiMsg === 'function') uiMsg('✅ 密码已设置，欢迎使用');
    })
    .catch(function(e){
      if(btn) btn.disabled = false;
      say(e.message || '修改失败，请重试');
    });
}

/* ---------- 登出 ---------- */
function doLogout(){
  if(!confirm('确定退出登录吗？\n\n退出后云端数据仍在，本机数据也不受影响。')) return;
  api('/auth?action=logout', { method:'POST' })
    .then(function(){})
    .catch(function(){})   /* 登出失败也照样清本地 */
    .then(function(){
      AUTH = { token:'', user:null };
      saveAuth();
      refreshAcctBtn();
      ACCT_TAB = 'login';
      /* 清掉资料页缓存：退出后不该再知道「哪条是我自己」 */
      if(typeof PC_MY_PROFILE_ID !== 'undefined') PC_MY_PROFILE_ID = null;
      renderAccount();
      if(typeof uiMsg === 'function') uiMsg('已退出登录');
    });
}

/* ---------- 个人中心 ---------- */
function acctProfileHtml(){
  var u = AUTH.user;
  var initial = (u.displayName || u.username || '?').charAt(0).toUpperCase();
  var cloudCount = window.__cloudKeyCount || 0;
  var myTitle = String(u.title || '').split(/[,，、]/).map(function(s){ return s.trim(); }).filter(Boolean);

  return '<div class="acct-user">' +
      '<div class="acct-avatar">' + esc(initial) + '</div>' +
      '<div style="flex:1;min-width:0">' +
        /* 需求：点击姓名可以查看与修改个人信息 */
        '<div class="acct-uname" onclick="acctTab(\'myprofile\')" style="cursor:pointer" title="查看 / 修改我的个人信息">' +
          esc(u.displayName || u.username) +
          (myTitle.length ? '<span class="acct-urole title-tag">' + esc(myTitle[0]) + '</span>' : '') +
          '<span class="acct-urole' + (u.role === 'admin' ? '' : ' user') + '">' +
            (u.role === 'admin' ? '管理员' : '成员') + '</span>' +
          '<span style="font-size:.7rem;opacity:.6;margin-left:4px">›</span>' +
        '</div>' +
        '<div class="acct-usub">@' + esc(u.username) + ' · 云端已存 ' + cloudCount + ' 项</div>' +
      '</div>' +
    '</div>' +

    /* v2.10.0：初始密码常驻提示（建议制改密的「建议」落点）。
       登录时跳过了改密 ≠ 再也不提 —— 个人中心顶部一直显示，
       点「去修改」打开同一个改密表单（可再次暂不修改）。 */
    (u.mustChangePassword
      ? '<div class="acct-pwd-tip"><span>⚠️ 账号还在使用初始密码，建议换成只有自己知道的密码</span>'
        + '<button class="acct-btn" onclick="acctTab(\'forcepwd\')">去修改</button></div>'
      : '') +

    /* ---- 我的资料：查看 / 修改 / 认领 ---- */
    '<div class="acct-sw" style="margin-top:14px">' +
      '<div><span class="t">📇 我的资料</span>' +
        '<span class="s">姓名、学号、智学网账号由管理员维护；微信/QQ/手机号可自己填</span></div>' +
      '<button class="acct-btn" style="width:auto;padding:8px 14px;font-size:.78rem" onclick="acctTab(\'myprofile\')">查看 / 修改</button>' +
    '</div>' +

    '<div class="acct-sw">' +
      '<div><span class="t">云同步</span>' +
        '<span class="s">把本机的主题、设置、作业打勾等同步到云端，换设备也能看到</span>' +
        '<span class="s" id="syncStatusLine" style="opacity:.72;margin-top:2px">自动同步已开启</span></div>' +
      '<button class="acct-btn" style="width:auto;padding:8px 14px;font-size:.78rem" onclick="syncUploadNow(this)">上传本机</button>' +
    '</div>' +
    '<div class="acct-row">' +
      '<button class="acct-btn ghost" onclick="syncDownloadNow(this)">拉取云端</button>' +
      '<button class="acct-btn ghost" onclick="syncNow(this)">双向同步</button>' +
      '<button class="acct-btn ghost" onclick="showChangePwd()">改密码</button>' +
    '</div>' +

    /* v2.10.1 需求⑧：云端数据的查看 / 删除入口。
       ⚠️ 原先这个方法只能从侧边栏「💾 数据管理」弹窗里进，而那个按钮
          2026-10-07 起被设成 display:none 隐藏了 —— 等于功能做完了却没人点得到
          （2026-10-17 站主问「我的云端数据在哪里查看」，就是这个问题）。
          现在把入口放在个人中心「云同步」下面，和它是一套东西，最好找。 */
    '<div class="acct-sw">' +
      '<div><span class="t">☁️ 我的云端数据</span>' +
        '<span class="s">看云端存了哪些数据（主题、作业勾选、班级签、点歌记录…），可单条删除或清空</span></div>' +
      '<button class="acct-btn" style="width:auto;padding:8px 14px;font-size:.78rem" onclick="openCloudDataFromAccount()">查看 / 删除</button>' +
    '</div>' +

    (isAdmin()
      ? '<div class="acct-row" style="margin-top:14px">' +
          '<button class="acct-btn" onclick="gotoAdminPage()">🛠 进入管理后台</button>' +
        '</div>'
      : '') +

    '<div class="acct-row" style="margin-top:14px">' +
      '<button class="acct-btn ghost" onclick="doLogout()">退出登录</button>' +
    '</div>' +
    '<div id="acctPwdBox"></div>' +
    '<p class="acct-hint">云同步只上传<b>你自己的个人数据</b>（设置、打勾记录等），' +
    '公告、资料这些站内容不会同步。<br>换手机时登录同一账号点「从云端恢复」即可。</p>';
}

/* ---------- 我的资料：查看 / 修改 / 认领 ----------
   需求「点击姓名可以查看与修改个人信息」「学生在哪里新增个人数据」。

   说明：班级资料（姓名/学号/智学网账号）由管理员维护，同学**只能认领**已有的那条，
   不能自己新建——否则谁都能往通讯录里塞假名字。
   能自己填的是联系方式（微信/QQ/手机号），提交后等管理员审核。
   认领/修改的入口本来就在首页的「个人资料查询」板块里（那一套逻辑很完整），
   这里不重复实现，直接把用户带过去。 */
/* ---------- 我的资料：账号弹窗内嵌页（2026-10-06） ----------
   站主要求：点开自己的姓名之后，就能查看并修改个人数据。
   以前这里是「跳到首页资料查询板块去找输入框」，体验绕；
   现在直接在账号弹窗里开一页：只读信息 + 微信/QQ/手机号自助填写。
   姓名、学号、智学网账号、政治面貌由管理员维护，同学改不了（后端也拦）。 */
var MY_PROF = null;
var MY_PROF_STATE = 'idle';    /* idle | loading | ok | none | error */
var MY_PROF_ERR = '';
/* 2026-10-08 新增：后端 /profile?action=me 的完整响应里的三个附加字段。
   ⚠️ 本轮 privateFields 大概率为空（id_card / youth_league_no 只登记了元数据、
      还没建列）；接口形状先立好，下轮后台加列后前端零改动即可显示。 */
var MY_PROF_PRIVATE = [];      /* [{field,label,value,sortOrder}] 仅本人可见字段 */
var MY_PROF_PREF = {};         /* {wechat:false,...} 本人的可见性意愿 */
/* v3.5.40（站主 #1）：字段元数据（含 selfEdit），决定「这一项能不能自己改」 */
var MY_PROF_META = {};
/* v3.7.0（站主 #1）：待审核的修改 { 字段: {before, after, reqId} }。
   通过前档案里还是旧值，这里只用于在行尾提示「你提交的新值是什么、正在等审核」。 */
var MY_PROF_PENDING = {};

/* 属性值转义：esc() 只处理 &<>，放进 value="…" 里遇到引号会把属性截断 */
function attr(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function openMyProfile(){
  if(!isLoggedIn()){ openAccount(); return; }
  ACCT_TAB = 'myprofile';
  if(MY_PROF_STATE === 'ok' || MY_PROF_STATE === 'none' || MY_PROF_STATE === 'error'){
    MY_PROF_STATE = 'idle'; MY_PROF = null;   /* 重新拉一次，保证是最新的 */
  }
  renderAccount();
  var m = document.getElementById('acctMask');
  if(m) m.classList.add('show');
}

function myProfLoad(){
  if(!isLoggedIn()) return;
  MY_PROF_STATE = 'loading';
  var box = document.getElementById('acctBody');
  if(box){ box.innerHTML = myProfileHtml(); try{ mpAfterRender(); }catch(e){} }
  api('/profile?action=me')
    .then(function(j){
      if(j && j.ok && j.profile){ MY_PROF = j.profile; MY_PROF_STATE = 'ok'; }
      else { MY_PROF = null; MY_PROF_STATE = 'none'; }
      MY_PROF_PRIVATE = (j && j.privateFields) || [];
      MY_PROF_PREF = (j && j.visibilityPref) || {};
      MY_PROF_META = {};
      ((j && j.fieldMeta) || []).forEach(function(m){ if(m && m.field) MY_PROF_META[m.field] = m; });
      PC_MY_PROFILE_ID = MY_PROF ? MY_PROF.id : null;
      /* v3.7.0：再拉一次「我提交的待审修改」（单独接口，避免 me 里塞太多东西） */
      api('/profile?action=mine-requests').then(function(k){
        MY_PROF_PENDING = {};
        ((k && k.pending) || []).forEach(function(req){
          (req.items || []).forEach(function(it){
            /* 同一字段有多条待审时，只提示最新的那条 */
            if(!MY_PROF_PENDING[it.field]) MY_PROF_PENDING[it.field] = { after: it.after, reqId: req.id };
          });
        });
        if(ACCT_TAB === 'myprofile') renderAccount();
      }).catch(function(){ MY_PROF_PENDING = {}; });
      if(ACCT_TAB === 'myprofile') renderAccount();
    })
    .catch(function(e){
      MY_PROF_ERR = (e && e.message) || '未知错误';
      MY_PROF_STATE = 'error';
      if(ACCT_TAB === 'myprofile') renderAccount();
    });
}

function myProfileHtml(){
  if(MY_PROF_STATE === 'idle' || MY_PROF_STATE === 'loading'){
    return '<p class="acct-hint">⏳ 正在读取你的资料…</p>';
  }
  if(MY_PROF_STATE === 'error'){
    return '<p class="acct-hint">读取失败：' + esc(MY_PROF_ERR) + '</p>' +
      '<button class="acct-btn" onclick="myProfLoad()">重试</button>' +
      '<button class="acct-btn ghost" onclick="acctTab(\'profile\')">返回</button>';
  }
  var p = MY_PROF;

  /* 还没认领资料：先认领（学号 + 姓名双验，与后端 claim 一致） */
  if(!p){
    return '<p class="acct-hint">你还没认领班级资料。认领之后就能自己维护<b>微信 / QQ / 手机号</b>，' +
        '同学查到的也是你填的内容。</p>' +
      '<div class="acct-field"><label>姓名</label><input id="mpName" placeholder="你的姓名" autocomplete="off"></div>' +
      '<div class="acct-field"><label>学号</label><input id="mpSid" placeholder="例如 250518" autocomplete="off"></div>' +
      '<button class="acct-btn" id="mpClaim" onclick="myProfClaim()">认领我的资料</button>' +
      '<div class="acct-msg" id="mpMsg"></div>' +
      '<p style="margin:12px 0 0"><button class="acct-btn ghost" onclick="acctTab(\'profile\')">返回</button></p>';
  }

  var stMap = {
    approved: '✅ 已通过审核，同学可以查到',
    pending:  '⏳ 已提交，等站主审核（审核中同学查不到）',
    rejected: '⚠️ 未通过审核' + (p.rejectReason ? '：' + esc(p.rejectReason) : ''),
    none:     '— 还没填，填一项保存即可'
  };
  var st = stMap[p.contactStatus] || '';

  /* 「仅自己可见」开关（2026-10-08）：把联系方式收窄为只有自己能看到。
     ⚠️ 只是**收窄**，不会放宽——后台上限始终是天花板。
        想放宽（本来是私密想改公开）要找站主，个人中心不提供这个能力。 */
  var phHidden = (MY_PROF_PREF.phone === false);
  var wHidden  = (MY_PROF_PREF.wechat === false);
  var qHidden  = (MY_PROF_PREF.qq === false);
  var anyHidden = phHidden || wHidden || qHidden;

  /* v3.5.21：站主反馈「仅本人可见的字看不清、而且看不全（如智学网账号）」。
     根因有两条：
       ① privateFields 被塞进 .acct-sw .s（灰色的说明文字样式）里渲染，
          浅色主题 #a99a8d、暗色主题更糊 —— 值本身被当成注释在画；
       ② 档案页只画 privateFields，从没画过 p.fields（公开档的额外字段）
          和 p.examNo 这类固定字段，所以字段一多就「显示不全」。
     现在统一成一张明细表：班级信息 + 额外字段 + 仅本人可见，一行一项，
     值用正文色，右侧带复制按钮（与前台查询的卡片一致）。 */
  /* v3.7.0：联系方式区块的「待审核」小标 */
  function mpPendTag(field){
    var p = MY_PROF_PENDING[field];
    if(!p) return '';
    return ' <span style="font-size:.66rem;font-weight:700;color:#a05a1f;background:#fff5e6;'
      + 'border:1px solid #f0d6b3;border-radius:99px;padding:1px 7px;margin-left:6px">待审核</span>';
  }

  var mpRows = [];
  function mpPush(label, val, locked, field){
    if(val == null) return;
    var s = String(val);
    if(!s.trim()) return;
    /* v3.5.40：后台开了「本人可编辑」的字段，行尾多一个「改」 */
    var meta = field ? MY_PROF_META[field] : null;
    var editable = !!(meta && meta.selfEdit && !MP_SELF_BLOCK[field]);
    mpRows.push({ label: label, value: s, locked: !!locked, field: field || '', editable: editable,
                  rules: (meta && meta.rules) || {}, pending: field ? (MY_PROF_PENDING[field] || null) : null });
  }
  mpPush('学号', p.studentId, false, 'student_id');
  mpPush('智学网账号', p.examNo, false, 'exam_no');
  mpPush('政治面貌', p.politics, false, 'politics');
  var myTitles = String(p.title || '').split(/[,，、]/)
    .map(function(s){ return s.trim(); }).filter(Boolean);
  if(myTitles.length) mpPush('头衔', myTitles.join('、'), false, 'title');
  mpPush('身份', p.role, false, 'role');
  if(Array.isArray(p.fields)){
    p.fields.forEach(function(f){ if(f && f.value) mpPush(f.label || f.field, f.value, false, f.field); });
  }
  if(MY_PROF_PRIVATE.length){
    MY_PROF_PRIVATE.forEach(function(f){ if(f && f.value) mpPush(f.label || f.field, f.value, true, f.field); });
  }

  /* ============================================================================
   * v3.8.0（站主）：我的资料改成「微信 / QQ 那种一行一个输入框」
   * ----------------------------------------------------------------------------
   * 站主原话：「你前面不是有复制和改两个按钮嘛，但我点击改之后由于手机屏幕小，
   *            信息显示不全；改完之后考籍号突然就竖着显示了，显示兼容性有很大问题。
   *            建议做得跟下面微信号 QQ 号那样，只不过旁边再新加一个复制的按钮。
   *            可以编辑的格子直接显示、也能编辑，不可以编辑的就变灰，前面加个锁。」
   *
   * 所以：
   *   · 每个字段一行：标签（可编辑 ✏️ / 只读 🔒）+ 输入框 + 复制
   *   · 只读字段 readonly + 灰底 + 锁，不参与提交
   *   · 可编辑字段直接改，改完底部「保存修改」一次性提交（进信息审核）
   *   · 输入框宽度按行自适应（flex + min-width:0），长号码不会再被挤成竖排
   * ========================================================================= */
  var hasEditable = false;
  var mpList = mpRows.length
    ? '<div class="mp-grid">' + mpRows.map(function(r){
        if(r.editable) hasEditable = true;
        var pend = r.pending;
        return '<div class="mp-field">'
          + '<label class="mp-lb">'
          +   (r.editable ? '✏️ ' : '🔒 ')
          +   esc(r.label)
          +   (r.locked ? '<span class="mp-privtag">仅自己可见</span>' : '')
          +   (pend ? '<span class="mp-pendtag">待审核</span>' : '')
          + '</label>'
          + '<div class="mp-iw">'
          +   '<input class="mp-in' + (r.editable ? '' : ' mp-ro') + '"'
          +     ' data-mpf="' + attr(r.field) + '" data-mpl="' + attr(r.label) + '"'
          +     ' data-mpo="' + attr(r.value) + '"'
          +     ' value="' + attr(r.value) + '" autocomplete="off" spellcheck="false"'
          +     (r.editable ? '' : ' readonly tabindex="-1"') + '>'
          +   '<button class="mp-cp" type="button" data-mc="' + attr(r.value) + '"'
          +     ' data-ml="' + attr(r.label) + '">复制</button>'
          + '</div>'
          + (pend
              ? '<div class="mp-pend">提交的新值：' + esc(String(pend.after || '（清空）'))
                + '　<span class="muted">站主确认后生效</span></div>'
              : '')
          + '</div>';
      }).join('') + '</div>'
      + (hasEditable
          ? '<button class="acct-btn" id="mpEditSave" disabled'
            + ' style="margin-top:10px;opacity:.55">保存修改（需管理员确认）</button>'
            + '<div class="mp-edittip">带 ✏️ 的项改完点上面的按钮提交，确认前仍显示原内容；带 🔒 的只能由管理员修改。</div>'
          : '')
    : '<p class="mp-empty">还没有可展示的资料字段。有误请联系站主。</p>';

  return '<div class="acct-user" style="margin-bottom:12px">' +
      '<div class="acct-avatar">' + esc((p.name || '?').charAt(0)) + '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div class="acct-uname">' + esc(p.name) + '</div>' +
        '<div class="acct-usub">' + esc(p.role || '学生') + (p.studentId ? ' · 学号 ' + esc(p.studentId) : '') +
          (myTitles.length ? ' · ' + esc(myTitles.join(' / ')) : '') + '</div>' +
      '</div>' +
    '</div>' +

    /* 只读区：管理员维护的字段 + 本人可见字段，全部可复制 */
    '<div class="acct-sw" style="margin-top:0">' +
      '<div style="width:100%"><span class="t">我的班级资料</span>' +
        '<span class="s">带 <b>✏️</b> 的可以自己改，改完点下面「保存修改」，<b>管理员确认前仍显示原内容</b>；' +
          '带 <b>🔒</b> 的只能由管理员维护，发现错误请找站主。<br>' +
          '标了「仅自己可见」的项只有你能看到，其他同学（包括管理员）在前台都查不到。</span>' +
        mpList +
        '</div>' +
    '</div>' +

    '<div class="acct-field"><label>💬 微信号' + mpPendTag('wechat') + '</label><input id="mpWechat" value="' + attr(p.wechat || '') + '" placeholder="选填，微信号" autocomplete="off"></div>' +
    '<label class="acct-priv"><input type="checkbox" id="mpWechatHide"' + (wHidden ? ' checked' : '') + '> 仅自己可见（同学查不到你的微信号）</label>' +

    '<div class="acct-field"><label>🐧 QQ 号' + mpPendTag('qq') + '</label><input id="mpQq" value="' + attr(p.qq || '') + '" placeholder="选填，5–12 位数字" autocomplete="off"></div>' +
    '<label class="acct-priv"><input type="checkbox" id="mpQqHide"' + (qHidden ? ' checked' : '') + '> 仅自己可见（同学查不到你的 QQ 号）</label>' +

    '<div class="acct-field"><label>📱 手机号' + mpPendTag('phone') + '</label><input id="mpPhone" value="' + attr(p.phone || '') + '" placeholder="选填，11 位手机号" autocomplete="off"></div>' +
    '<label class="acct-priv"><input type="checkbox" id="mpPhoneHide"' + (phHidden ? ' checked' : '') + '> 仅自己可见（同学查不到你的手机号）</label>' +

    '<button class="acct-btn" id="mpSave" onclick="myProfSave()">保存我的联系方式</button>' +
    '<div class="acct-msg" id="mpMsg"></div>' +
    '<p class="acct-hint">' + st + '<br>' +
      '改完会重新提交审核（站主核一遍才对同学可见），这是为了防止有人乱填别人的联系方式。<br>' +
      (anyHidden
        ? '⚠️ 你已把部分联系方式设为<b>仅自己可见</b>，同学查不到。<br>'
          + '<span style="font-size:.94em;opacity:.85">说明：站主为核对资料，在后台仍能看到；'
          + '若站主在「字段管理」里调整过该字段的可见范围，则以站主设置为准。</span><br>'
        : '') +
      '不想被查到就清空三项再保存。</p>' +
    '<p style="margin:12px 0 0"><button class="acct-btn ghost" onclick="acctTab(\'profile\')">返回</button></p>';
}

/* ============================================================================
 * v3.5.40（站主 #1）：我的资料 · 本人编辑
 * ----------------------------------------------------------------------------
 * 站主原话：「字段管理的所有字段均可设置本人是否可编辑，后台开启后则该用户
 *           可以在个人资料页面或个人资料查询卡片修改字段内容」
 *
 * 前端只做两件事：
 *   ① 后端返回的 fieldMeta 里 selfEdit = true 且不是系统列的字段，行尾画「改」
 *   ② 点「改」→ 就地变输入框 → 保存走 /api/profile?action=self-update
 * 真正的权限裁判在服务端（它会逐字段再判一次），前端隐藏按钮只是体验层。
 * ========================================================================= */
/* 这些字段即使后端误开也不给改（与服务端 SELF_EDIT_BLOCK 对齐） */
var MP_SELF_BLOCK = {
  name:1, student_id:1, role:1, title:1, contact_status:1,
  user_id:1, id:1, visibility_pref:1, field_vis:1, reject_reason:1
};

/** v3.8.0：我的资料渲染完后绑定交互（复制 / 改动检测 / 提交） */
function mpAfterRender(){
  var box = document.getElementById('acctBody');
  if(!box) return;

  /* 复制按钮：一行一个，复制的是输入框当前值（只读字段也一样能复制） */
  Array.prototype.forEach.call(box.querySelectorAll('[data-mc]'), function(b){
    b.onclick = function(){
      var v = b.getAttribute('data-mc') || '';
      var label = b.getAttribute('data-ml') || '';
      if(!v){ toastMini('这一项还是空的，没有可复制的内容', true); return; }
      var done = function(){ b.textContent = '已复制'; setTimeout(function(){ b.textContent = '复制'; }, 1200); };
      try{
        if(navigator.clipboard && navigator.clipboard.writeText){
          navigator.clipboard.writeText(v).then(done).catch(function(){ mpLegacyCopy(v, done); });
        } else { mpLegacyCopy(v, done); }
      }catch(e){ mpLegacyCopy(v, done); }
    };
  });

  /* 可编辑字段：改了才点亮「保存修改」；按 Esc 还原 */
  var save = document.getElementById('mpEditSave');
  var inputs = box.querySelectorAll('.mp-in[data-mpf]:not(.mp-ro)');
  function refresh(){
    var dirty = 0;
    Array.prototype.forEach.call(inputs, function(i){
      var changed = String(i.value) !== String(i.getAttribute('data-mpo') || '');
      i.classList.toggle('mp-changed', changed);
      if(changed) dirty++;
    });
    if(save){
      save.disabled = dirty === 0;
      save.style.opacity = dirty ? '1' : '.55';
      save.textContent = dirty
        ? ('保存修改（' + dirty + ' 项，需管理员确认）')
        : '保存修改（需管理员确认）';
    }
  }
  Array.prototype.forEach.call(inputs, function(i){
    i.addEventListener('input', refresh);
    i.addEventListener('keydown', function(e){
      if(e.key === 'Escape'){ i.value = i.getAttribute('data-mpo') || ''; refresh(); i.blur(); }
    });
  });
  if(save){
    save.onclick = function(){
      var fields = {};
      Array.prototype.forEach.call(inputs, function(i){
        var f = i.getAttribute('data-mpf');
        var v = String(i.value);
        if(v !== String(i.getAttribute('data-mpo') || '')) fields[f] = v;
      });
      var keys = Object.keys(fields);
      if(!keys.length){ toastMini('还没有改动', true); return; }
      save.disabled = true; save.textContent = '提交中…';
      api('/profile?action=self-update', { method:'POST', body:{ fields: fields } })
        .then(function(j){
          toastMini('✅ ' + ((j && j.message) || '已提交'));
          myProfLoad();
        })
        .catch(function(e){
          save.disabled = false;
          toastMini('⚠️ ' + ((e && e.message) || '提交失败'), true);
          refresh();
        });
    };
  }
  refresh();
}

/** 复制兜底（老浏览器 / 非安全上下文） */
function mpLegacyCopy(text, done){
  try{
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try{ ok = document.execCommand('copy'); }catch(e){}
    ta.remove();
    if(ok && typeof done === 'function') done();
    else toastMini('复制失败，请长按输入框手动复制', true);
  }catch(e){ toastMini('复制失败，请长按输入框手动复制', true); }
}

/** 我的资料里的小提示（站内没有全局 toast，这里做一个轻量浮条） */
function toastMini(text, isErr){
  try{
    var old = document.getElementById('mpToast');
    if(old) old.remove();
    var d = document.createElement('div');
    d.id = 'mpToast';
    d.textContent = text;
    d.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);'
      + 'z-index:9999;max-width:86vw;padding:10px 16px;border-radius:999px;font-size:.82rem;'
      + 'color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.18);'
      + 'background:' + (isErr ? '#b3261e' : '#2f7d4f') + ';';
    document.body.appendChild(d);
    setTimeout(function(){ try{ d.remove(); }catch(e){} }, isErr ? 3600 : 2000);
  }catch(e){}
}

/** 复制「我的资料」里某一项（v3.5.21）。
 *  值放在 data-v 里而不是拼进 onclick —— 身份证号、地址这类内容含引号/括号，
 *  拼字符串很容易把属性截断，attr() 已经统一转义过。 */
function mpCopy(btn){
  if(!btn) return;
  copyText(btn.getAttribute('data-v') || '', btn.getAttribute('data-l') || '资料');
}

function myProfSay(t, cls){
  var el = document.getElementById('mpMsg');
  if(el){ el.textContent = t || ''; el.className = 'acct-msg ' + (cls || '') + ' show'; }
}

function myProfSave(){
  var w = (document.getElementById('mpWechat') || {}).value || '';
  var q = (document.getElementById('mpQq') || {}).value || '';
  var ph = (document.getElementById('mpPhone') || {}).value || '';
  w = w.trim(); q = q.trim(); ph = ph.trim();

  /* v3.5.5：手机号规则 = 11 位数字（站主在「字段管理」里配的，服务端复核）。
     ⚠️ grandfather：与库中现值一致时原样提交 —— 老资料可能是旧规则下录的
        （带 +86、空格等），不能因为规则升级把「只改可见性开关」的同学挡死；
        主动改值才按新规则规范化（顺手去掉空格 / 横杠 / 括号）。 */
  var storedPh = (MY_PROF && MY_PROF.phone) || '';
  if(ph && ph !== storedPh) ph = ph.replace(/[\s\-()]/g, '');

  /* 可见性开关：勾上「仅自己可见」→ 该字段意愿记为 false（收窄到 self）。
     未勾 = true（我不反对公开），最终仍受后台上限约束。 */
  var wHide = !!(document.getElementById('mpWechatHide') || {}).checked;
  var qHide = !!(document.getElementById('mpQqHide') || {}).checked;
  var pHide = !!(document.getElementById('mpPhoneHide') || {}).checked;
  var pref = { wechat: !wHide, qq: !qHide, phone: !pHide };

  if(!w && !q && !ph){
    /* 清空：允许，但要提示会撤回公开 */
    if(!confirm('三项都空着，保存会把你的联系方式撤回（同学查不到）。确定吗？')) return;
  }
  if(ph && ph !== storedPh && !/^[0-9]{11}$/.test(ph)){ myProfSay('手机号应为 11 位数字'); return; }
  if(q && !/^[0-9]{5,12}$/.test(q)){ myProfSay('QQ 号应为 5–12 位数字'); return; }

  var btn = document.getElementById('mpSave');
  if(btn) btn.disabled = true;
  myProfSay('提交中…', 'ok');
  /* ⚠️ visibilityPref 必须一起带上：后端把它和联系方式写在同一条 update 里。
     否则「只改了开关没改内容」的保存会被后端当成「三项全空」拦掉。 */
  api('/profile?action=submit', { method:'POST', body:{ wechat:w, qq:q, phone:ph, visibilityPref:pref } })
    .then(function(j){
      if(btn) btn.disabled = false;
      myProfSay((j && j.message) || '已提交，等站主审核', 'ok');
      if(typeof uiMsg === 'function') uiMsg('✅ 已提交，等站主审核');
      /* 重新拉一次，拿到新的审核状态 */
      setTimeout(myProfLoad, 600);
    })
    .catch(function(e){
      if(btn) btn.disabled = false;
      myProfSay((e && e.message) || '保存失败，请重试');
    });
}

function myProfClaim(){
  var name = ((document.getElementById('mpName') || {}).value || '').trim();
  var sid  = ((document.getElementById('mpSid') || {}).value || '').trim();
  if(!name || !sid){ myProfSay('姓名和学号都要填'); return; }
  var btn = document.getElementById('mpClaim');
  if(btn) btn.disabled = true;
  myProfSay('认领中…', 'ok');
  api('/profile?action=claim', { method:'POST', body:{ name:name, studentId:sid } })
    .then(function(j){
      if(btn) btn.disabled = false;
      if(typeof pcLoadMyProfile === 'function') pcLoadMyProfile();
      myProfSay((j && j.message) || '认领成功', 'ok');
      setTimeout(myProfLoad, 600);
    })
    .catch(function(e){
      if(btn) btn.disabled = false;
      myProfSay((e && e.message) || '认领失败，请核对姓名与学号');
    });
}

/* ---------- 改密码 ---------- */
function showChangePwd(){
  var box = document.getElementById('acctPwdBox');
  if(!box) return;
  box.innerHTML = '<div class="acct-prompt">' +
    '<input id="pwdOld" type="password" placeholder="原密码" autocomplete="current-password">' +
    '<input id="pwdNew" type="password" placeholder="新密码（至少 6 位）" autocomplete="new-password">' +
    '<div class="acct-row" style="margin-top:0">' +
      '<button class="acct-btn" onclick="doChangePwd()">确认修改</button>' +
      '<button class="acct-btn ghost" onclick="document.getElementById(\'acctPwdBox\').innerHTML=\'\'">取消</button>' +
    '</div><div class="acct-msg" id="pwdMsg"></div></div>';
}
function doChangePwd(){
  var o = (document.getElementById('pwdOld')||{}).value || '';
  var n = (document.getElementById('pwdNew')||{}).value || '';
  var msg = document.getElementById('pwdMsg');
  if(n.length < 6){ if(msg){ msg.textContent = '新密码至少 6 位'; msg.className = 'acct-msg err'; } return; }
  /* v2.9.9：客户端派生路径，服务端零派生 */
  clsChangePwd(o, n, AUTH.user && AUTH.user.username)
    .then(function(j){
      if(j.token){ AUTH.token = j.token; saveAuth(); }
      /* v2.10.0：这里改密成功同样要清「初始密码」标志与跳过记录，
         否则个人中心顶部提示条不消失（本路径改的也是当前账号密码） */
      if(AUTH.user){
        AUTH.user.mustChangePassword = false;
        try{ localStorage.removeItem('cls_pwd_skip_' + AUTH.user.username); }catch(e){}
        saveAuth();
      }
      if(msg){ msg.textContent = j.message || '已修改'; msg.className = 'acct-msg ok'; }
      setTimeout(function(){ var b = document.getElementById('acctPwdBox'); if(b) b.innerHTML = ''; }, 1500);
      if(typeof uiMsg === 'function') uiMsg('✅ 密码已修改');
    })
    .catch(function(e){ if(msg){ msg.textContent = e.message; msg.className = 'acct-msg err'; } });
}

/* ---------- 云同步 ---------- */

/** 收集本机需要同步的键值 */
function collectLocalCloudData(){
  var out = {};
  try{
    for(var i = 0; i < localStorage.length; i++){
      var k = localStorage.key(i);
      if(!isCloudKey(k)) continue;
      var raw = localStorage.getItem(k);
      if(raw === null) continue;
      /* 尝试按 JSON 解析，失败就当字符串存（保持原样） */
      try{ out[k] = JSON.parse(raw); }catch(e){ out[k] = raw; }
    }
  }catch(e){}
  return out;
}

/** 读单个键的云端值。键不存在返回 undefined（区别于 null） */
function readLocalCloudValue(k){
  try{
    var raw = localStorage.getItem(k);
    if(raw === null) return undefined;
    try{ return JSON.parse(raw); }catch(e){ return raw; }
  }catch(e){ return undefined; }
}

/** 把本机数据推到云端 */
function syncPush(){
  if(!isLoggedIn()) return Promise.resolve({ pushed:0 });
  var items = collectLocalCloudData();
  var n = Object.keys(items).length;
  if(n === 0) return Promise.resolve({ pushed:0 });
  return api('/data', { method:'PUT', body:{ items: items } }).then(function(j){
    window.__cloudKeyCount = n;
    return { pushed: j.written || n };
  });
}

/** 从云端拉数据到本机。ask=true 时先问用户是否覆盖本机 */
function syncPull(ask){
  if(!isLoggedIn()) return Promise.resolve({ pulled:0 });
  return api('/data').then(function(j){
    var items = j.items || {};
    var n = Object.keys(items).length;
    window.__cloudKeyCount = n;
    if(n === 0){
      if(!ask && typeof uiMsg === 'function') uiMsg('云端还没有数据，先同步一次吧', '#af410f');
      return { pulled:0 };
    }
    if(ask){
      var doIt = confirm('云端有 ' + n + ' 项你的数据。\n\n' +
        '点「确定」= 用云端数据覆盖本机（适合换了新设备）\n' +
        '点「取消」= 保持本机不变，之后可以手动「立即同步」把本机存上去');
      if(!doIt) return { pulled:0 };
    }
    var cnt = 0;
    window.__cloudPulling = true;   /* v2.10.0：回写不登记脏键（见 hookLocalStorage） */
    try{
      Object.keys(items).forEach(function(k){
        if(!isCloudKey(k)) return;   /* 双保险：非白名单键不写本机 */
        try{
          localStorage.setItem(k, JSON.stringify(items[k]));
          cnt++;
        }catch(e){}
      });
    }finally{ window.__cloudPulling = false; }
    /* 被保护的本机新值要补推上去，否则云端永远停在旧值 */
    if(protectedKeys.length){
      protectedKeys.forEach(function(k){ DIRTY_KEYS[k] = 1; DIRTY_COUNT++; });
      addPendingKeys(protectedKeys);
      try{ flushCloudSync(); }catch(e){}
    }
    /* 让界面按新数据重绘 */
    if(typeof loadUI === 'function' && k0In(items, 'cls_ui_cfg')){
      loadUI(); applyUICfg();
    }
    if(typeof rerenderAll === 'function') rerenderAll();
    if(typeof updateCountdown === 'function') updateCountdown();
    if(typeof uiMsg === 'function') uiMsg('✅ 已从云端恢复 ' + cnt + ' 项数据');
    return { pulled: cnt };
  });
}

/**
 * v2.10.0：静默拉取个人云端数据（云端优先，覆盖本机过期缓存）。
 *
 * 修复的 BUG（站主原话）：「A 设备云端勾选同步后，B 设备拉取数据还是旧勾选状态」。
 * 根因：个人数据（/api/data，含 cls_hw_done_ 作业勾选）从来只有「上行」——
 *   周期同步 syncRound 只推共享内容、拉共享内容，不碰个人数据；
 *   个人数据唯一的下行是登录时那次 syncPull(true)，而它带确认框，
 *   同学一路点取消 → 旧本地数据永久留存，换设备永远看到旧状态。
 *
 * 本函数的语义：
 *   · 不弹框（静默），云端值直接覆盖本机 —— 「优先读取云端最新数据」
 *   · DIRTY_KEYS 里的键跳过：本机有未推送改动，不能被旧云端值冲掉
 *     （正常流程里 syncRound 会先 flush 再拉，双保险）
 *   · 写了才重绘，没变不动界面
 */
function syncPullSilent(){
  if(!isLoggedIn()) return Promise.resolve({ pulled:0 });
  /* v3.5.34：拉之前先把本机待推送的改动抖出去。
     以前只在 syncRound 里顺序调用，但登录后首次拉取、切回前台等路径
     可能直接走这里 —— 此时若先拉后推，本机刚打的勾会被云端旧值覆盖。 */
  if(hasPendingCloudSync()){
    return flushCloudSync().then(function(){ return syncPullSilent2(); })
                          .catch(function(){ return syncPullSilent2(); });
  }
  return syncPullSilent2();
}

/** 真正的拉取。v3.5.34 新增「本机独有键回补」：
 *  某些勾选可能只在这台机器上存在（早期版本没推成功、或用户在那台设备上手滑取消了）。
 *  云端没有这个键时，不能当成「云端说没有」，要把本机已有值推上去，
 *  否则这台设备的勾选永远只活在本机。 */
function syncPullSilent2(){
  return api('/data').then(function(j){
    var items = j.items || {};
    var n = Object.keys(items).length;
    window.__cloudKeyCount = n;
    if(n === 0) return { pulled:0 };
    var cnt = 0;
    var times = j.times || {};
    var lts = loadLTS();
    var nowMs = Date.now();
    var protectedKeys = [];
    window.__cloudPulling = true;
    try{
      Object.keys(items).forEach(function(k){
        if(!isCloudKey(k)) return;
        if(DIRTY_KEYS[k]) return;          /* 本机有未推送改动 → 保护，不覆盖 */
        /* v3.5.42：本机改得比云端新，就不拿旧值盖它。
           —— 站主「勾完立刻退出、重进发现勾没了」的直接原因就是这一步缺失：
              云端还是打开页面前的旧值，却无条件覆盖了本机刚写的新值。
           本地时钟可能被用户改过，所以只信「不超过现在 1 分钟」的时间戳，
           且要求领先云端 500ms 以上（避免同一秒内的抖动误判）。 */
        var lt = Number(lts[k] || 0);
        var ct = times[k] ? Date.parse(times[k]) : 0;
        if(lt && lt <= nowMs + 60000 && ct && lt > ct + 500){
          protectedKeys.push(k);
          return;
        }
        var raw;
        try{ raw = JSON.stringify(items[k]); }catch(e){ return; }
        var cur = null;
        try{ cur = localStorage.getItem(k); }catch(e){}
        /* v3.5.14 #2：以前是 cur === raw 字符串全等比较 —— jsonb 回来 key 顺序不同，
           于是每轮都判「有更新」，把本地覆盖一遍还 rerenderAll（顺带把用户翻到一半的
           列表打回顶部）。改为语义比较：内容一样就不写、不重绘。 */
        if(cur != null && sameCloudValue(items[k], (function(){ try{ return JSON.parse(cur); }catch(e){ return cur; } })())) return;
        try{ localStorage.setItem(k, raw); cnt++; }catch(e){}
      });
    }finally{ window.__cloudPulling = false; }
    if(cnt > 0){
      /* 作业勾选 / 签到 / UI 配置都吃这些键 —— 按新数据重绘 */
      try{ if(typeof loadUI === 'function' && k0In(items, 'cls_ui_cfg')){ loadUI(); applyUICfg(); } }catch(e){}
      try{ if(typeof rerenderAll === 'function') rerenderAll(); }catch(e){}
      try{ if(typeof refreshHwViews === 'function') refreshHwViews(); }catch(e){}
      try{ if(typeof updateCountdown === 'function') updateCountdown(); }catch(e){}
    }
    return { pulled: cnt };
  }).catch(function(){ return { pulled:0 }; });   /* 静默失败，不打扰用户 */
}

/** v3.5.14 #2：稳定序列化 —— object 的 key 排序，数组保持原序。
    云端 data_value 是 jsonb，读回来 key 顺序会被重排、空白会被压缩；
    直接拿 JSON.stringify 的字符串比，几乎永远不相等 → 每 60 秒误判「有更新」。 */
function stableStringify(v){
  if(v === null || typeof v !== 'object') return JSON.stringify(v);
  if(Array.isArray(v)){
    return '[' + v.map(function(x){ return stableStringify(x); }).join(',') + ']';
  }
  var ks = Object.keys(v).sort();
  return '{' + ks.map(function(k){ return JSON.stringify(k) + ':' + stableStringify(v[k]); }).join(',') + '}';
}
/** 语义比较：内容一致即视为同一个值，与 key 顺序/空白无关 */
function sameCloudValue(a, b){
  if(a === b) return true;
  try{ return stableStringify(a) === stableStringify(b); }catch(e){ return false; }
}

function k0In(o, k){ return Object.prototype.hasOwnProperty.call(o, k); }

/* ============================================================
   自动上云（2026-10-05 新增 · 需求「每触发一次本地修改时自动上云」）
   ------------------------------------------------------------
   思路：不拦截每一次 localStorage 写入就去发请求——那会把后端打爆
   （同学点一下作业、切一下主题就一个请求）。
   改为「攒一攒再发」：

     markCloudDirty(key)  本地改了什么就登记一下（很便宜，只进内存 Set）
            ↓
     scheduleCloudSync()  1.5 秒防抖：这段时间内再改就重新计时
            ↓
     flushCloudSync()     真正发请求，只推 dirty 的那几个键

   另外加 10 秒节流兜底：如果同学一直在高频操作（比如连续打勾几十个作业），
   防抖会被无限推迟，所以最多等 10 秒就必须发一次。

   时机：页面切到后台/关闭时立即 flush，防止最后几下改动来不及上传。
   ============================================================ */
var DIRTY_KEYS = {};          /* 待推送的键（用对象当 Set，兼容老浏览器） */
var DIRTY_COUNT = 0;

/* ============================================================================
 * v3.5.42：待推送清单落盘 + 本地写入时间
 * ----------------------------------------------------------------------------
 * 站主原话：「我刚刚已经打好勾了，然后我打完勾之后，我就立马退出去了嘛，
 *           然后又重进来刷新了页面，结果是刚刚打勾的，现在都没打勾了」
 *
 * 根因（三条叠加，缺一条都不会丢）：
 *   ① DIRTY_KEYS 只在内存里 —— 页面一关，待推送清单跟着没了；
 *   ② 勾完立刻退出时 fetch 被浏览器取消，云端还是旧值；
 *   ③ 重进页面从云端拉，旧值把本机新勾覆盖掉。
 *
 * 修法：
 *   · __cls_pending：把待推送的键名落 localStorage，成功推上去才删；
 *     下次进站先补推，再拉云端。
 *   · __cls_lts：每个键「最后一次本机写入」的时间戳。拉取时和云端
 *     user_data.updated_at 比，本机更新就不覆盖（并补推）。
 *     这两个键不带 cls_ 前缀，不在同步白名单里，永远不会被推到云端。
 * ========================================================================= */
var PENDING_LS = '__cls_pending';
var LTS_LS = '__cls_lts';

function loadPendingKeys(){
  try{
    var a = JSON.parse(localStorage.getItem(PENDING_LS) || '[]');
    return Array.isArray(a) ? a.filter(function(k){ return typeof k === 'string'; }) : [];
  }catch(e){ return []; }
}
function savePendingKeys(arr){
  try{ localStorage.setItem(PENDING_LS, JSON.stringify(arr.slice(0, 800))); }catch(e){}
}
function addPendingKeys(keys){
  if(!keys || !keys.length) return;
  var a = loadPendingKeys();
  keys.forEach(function(k){ if(a.indexOf(k) < 0) a.push(k); });
  savePendingKeys(a);
}
function removePendingKeys(keys){
  if(!keys || !keys.length) return;
  var a = loadPendingKeys().filter(function(k){ return keys.indexOf(k) < 0; });
  savePendingKeys(a);
}

function loadLTS(){
  try{ return JSON.parse(localStorage.getItem(LTS_LS) || '{}') || {}; }catch(e){ return {}; }
}
/** 记一笔「这个键刚在本机被改过」。只在本地写入时调用（云端回写不调） */
function markLocalWrite(k){
  try{
    if(!isCloudKey(k)) return;
    var m = loadLTS();
    m[k] = Date.now();
    var ks = Object.keys(m);
    if(ks.length > 600){
      ks.sort(function(a, b){ return (m[a] || 0) - (m[b] || 0); });
      ks.slice(0, ks.length - 600).forEach(function(x){ delete m[x]; });
    }
    localStorage.setItem(LTS_LS, JSON.stringify(m));
  }catch(e){}
}
var SYNC_DEBOUNCE_MS = 1500;  /* 停手 1.5 秒后发 */
var SYNC_MAX_WAIT_MS = 10000; /* 但最多攒 10 秒 */
var __syncDebounceTimer = null;
var __syncFirstDirtyAt = 0;
var __syncInFlight = false;

/** 登记一个待同步的键。非云键、未登录都直接忽略 */
function markCloudDirty(key){
  if(!key || typeof key !== 'string') return;
  if(!isLoggedIn()) return;
  if(!isCloudKey(key)) return;
  if(DIRTY_KEYS[key]) return;
  DIRTY_KEYS[key] = 1;
  DIRTY_COUNT++;
  scheduleCloudSync();
}

/** 防抖调度：停手 1.5 秒发一次；但距首次 dirty 超过 10 秒就必须发 */
function scheduleCloudSync(){
  if(!isLoggedIn()) return;
  var now = Date.now();
  if(!__syncFirstDirtyAt) __syncFirstDirtyAt = now;

  /* 已经攒够 10 秒了，别等了，直接发 */
  if(now - __syncFirstDirtyAt >= SYNC_MAX_WAIT_MS){
    flushCloudSync();
    return;
  }
  if(__syncDebounceTimer !== null && __syncDebounceTimer !== undefined){
    clearTimeout(__syncDebounceTimer);
  }
  __syncDebounceTimer = setTimeout(function(){
    __syncDebounceTimer = null;
    flushCloudSync();
  }, SYNC_DEBOUNCE_MS);
}

/** 真正推送：只推 dirty 的键，一次请求搞定 */
function flushCloudSync(){
  if(__syncDebounceTimer !== null && __syncDebounceTimer !== undefined){
    clearTimeout(__syncDebounceTimer);
    __syncDebounceTimer = null;
  }
  __syncFirstDirtyAt = 0;
  if(!isLoggedIn()){ DIRTY_KEYS = {}; DIRTY_COUNT = 0; return Promise.resolve({ pushed:0 }); }
  var keys = Object.keys(DIRTY_KEYS);
  if(!keys.length) return Promise.resolve({ pushed:0 });
  /* 同一次请求里不要重复发：慢网络下前一个还没回来就再发会乱序。
     ⚠️ v3.5.42：这里以前直接返回，**而且上面的 clearTimeout 已经把定时器清了** ——
        于是这批改动既不在这轮发，也没有下一轮定时器，要等用户再操作一次才动。
        「勾完立刻退出」正是撞上这个空档。现在补一个短定时器重试。 */
  if(__syncInFlight){
    if(__syncDebounceTimer === null || __syncDebounceTimer === undefined){
      __syncDebounceTimer = setTimeout(function(){
        __syncDebounceTimer = null;
        flushCloudSync();
      }, 800);
    }
    return Promise.resolve({ pushed:0, skipped:true });
  }

  /* 先把待发清单清空——如果请求后面失败了，这些键会被下一次修改重新登记，
     不会因为「一直失败」而卡住后续改动。 */
  DIRTY_KEYS = {};
  DIRTY_COUNT = 0;

  /* v3.5.42：先把这批键名落到 localStorage。页面在这一刻被关掉，
     下次进站也能靠它把这次改动补推上去（否则只活在内存里，一关就没）。 */
  addPendingKeys(keys);

  var items = {};
  keys.forEach(function(k){
    var v = readLocalCloudValue(k);
    if(v !== undefined) items[k] = v;
  });
  if(!Object.keys(items).length) return Promise.resolve({ pushed:0 });

  __syncInFlight = true;
  return api('/data', { method:'PUT', body:{ items: items } })
    .then(function(j){
      window.__cloudKeyCount = Object.keys(items).length;
      /* 真上云了才把 pending 标记撤掉 */
      removePendingKeys(keys);
      return { pushed: j.written || Object.keys(items).length };
    })
    .catch(function(e){
      /* 失败不打扰用户——自动同步是「锦上添花」，弹错误提示反而烦人。
         但要把键重新登记，等下次改动时再试；pending 标记也留着，
         下次进站会再补推一次。 */
      keys.forEach(function(k){ DIRTY_KEYS[k] = 1; DIRTY_COUNT++; });
      return { pushed:0, error:String(e && e.message || e) };
    })
    .then(function(r){
      __syncInFlight = false;
      /* 请求期间又攒了新的改动 → 补一个定时器，别让它们干等 */
      if(hasPendingCloudSync() && (__syncDebounceTimer === null || __syncDebounceTimer === undefined)){
        __syncDebounceTimer = setTimeout(function(){
          __syncDebounceTimer = null;
          flushCloudSync();
        }, 600);
      }
      return r;
    });
}

/**
 * v3.5.34：把「本机有、云端没有」的作业勾选补推上去。
 *
 * 站主原话：「前两天我记得我已经打勾的作业，结果在这台设备上它这个还是没有打勾。」
 * 这类丢失的典型成因：那台设备打勾时没登录 / 网络断了 / 页面在防抖期间被冻结，
 * 云端从来没有这条记录，之后无论哪台设备拉多少次都看不到。
 *
 * 做法：登录后静默读一次云端键名清单，凡是以 cls_hw_done_ 开头、
 * 本机有值但云端没有的，标记为脏键推一次。只补作业勾选，
 * 不碰别的键（其他键缺失可能是用户真的删了，不能瞎补）。
 */
var __hwBackfillDone = false;
function backfillOrphanHwDone(){
  if(__hwBackfillDone) return Promise.resolve(0);
  if(!isLoggedIn()) return Promise.resolve(0);
  __hwBackfillDone = true;
  return api('/data').then(function(j){
    var cloud = (j && j.items) || {};
    var orphan = [];
    try{
      for(var i = 0; i < localStorage.length; i++){
        var k = localStorage.key(i);
        if(!k || k.indexOf('cls_hw_done_') !== 0) continue;
        if(Object.prototype.hasOwnProperty.call(cloud, k)) continue;
        /* 空对象（所有勾都被取消）不用补，补上去反而会让别的设备以为是新数据 */
        var v = readLocalCloudValue(k);
        if(v && typeof v === 'object' && Object.keys(v).length) orphan.push(k);
      }
    }catch(e){ return 0; }
    if(!orphan.length) return 0;
    var items = {};
    orphan.forEach(function(k){
      var v = readLocalCloudValue(k);
      if(v !== undefined) items[k] = v;
    });
    if(!Object.keys(items).length) return 0;
    return api('/data', { method:'PUT', body:{ items: items } })
      .then(function(){ return orphan.length; })
      .catch(function(){ return 0; });
  }).catch(function(){ return 0; });
}

/** v3.5.42：进站时把上次没推成功的键捡回来，立刻补推一次。
 *  必须在「从云端拉取」之前跑，否则旧云端值会先把本机新勾覆盖掉。 */
var __pendingRestored = false;
function restorePendingSync(){
  if(__pendingRestored) return;
  __pendingRestored = true;
  if(!isLoggedIn()) return;
  var a = loadPendingKeys().filter(function(k){ return isCloudKey(k); });
  if(!a.length) return;
  a.forEach(function(k){ DIRTY_KEYS[k] = 1; DIRTY_COUNT++; });
  flushCloudSync();
}

/* 有改动待上传吗？页面隐藏时用它判断要不要立即发 */
function hasPendingCloudSync(){
  for(var k in DIRTY_KEYS){ if(DIRTY_KEYS[k]) return true; }
  return false;
}

/* ============================================================
   共享内容推送（2026-10-06 新增）
   ------------------------------------------------------------
   背景：/api/content 是「全班共享内容」通道（公告/作业/重要日期…），
   与上面 /api/data 的「个人本机数据」通道是两条独立线路：
     · /api/data     → 每人一份，白名单 CLOUD_KEYS，自动脏推
     · /api/content  → 全班共享，键见 CONTENT_MAP，本次补上推送

   上一轮只做了 /api/content 的「读」，没做「写」——于是云端永远是空的，
   后台三个面板都显示「暂无数据」。这里补上写的能力。

   为什么单独一套而不是并进 CLOUD_KEYS：
     内容键是共享的、要经过服务端权限校验（管理员/AI/课代表），
     塞进个人数据通道会绕过那层校验，也会让「我改的」和「大家看的」混淆。

   冲突处理（用户确认「两边都能改」）：
     推之前先比 updated_at。若云端比本地记录的时间更新，
     说明别人（或后台）先改过了 —— 这时不覆盖，改为提示，避免把别人的改动冲掉。
   ============================================================ */

/* 本地记录「我最后一次看到云端内容的时间」，用于冲突判断 */
var CONTENT_TS_KEY = 'cls_content_myts_v1';
/* 待推送的内容键（与 DIRTY_KEYS 分开，因为要发往不同接口） */
var DIRTY_CONTENT = {};
var __contentInFlight = false;

/** 本地内容改动了 → 登记待推 */
function markContentDirty(key){
  if(!key || typeof key !== 'string') return;
  if(!isLoggedIn()) return;
  if(!CONTENT_MAP.hasOwnProperty(key)) return;   /* 只认内容通道的键 */
  DIRTY_CONTENT[key] = 1;
  scheduleContentSync();
}

var __contentDebounce = null;
var __contentFirstAt = 0;

function scheduleContentSync(){
  if(!isLoggedIn()) return;
  if(!Object.keys(DIRTY_CONTENT).length) return;
  var now = Date.now();
  if(!__contentFirstAt) __contentFirstAt = now;
  if(now - __contentFirstAt >= SYNC_MAX_WAIT_MS){ flushContentSync(); return; }
  if(__contentDebounce !== null && __contentDebounce !== undefined) clearTimeout(__contentDebounce);
  __contentDebounce = setTimeout(function(){
    __contentDebounce = null;
    flushContentSync();
  }, SYNC_DEBOUNCE_MS);
}

/** 从本地取出某个内容键当前的值（用于推送给云端） */
function readLocalContentValue(key){
  try{
    if(key === 'announcements') return SITE_DATA.announcements;
    if(key === 'holiday_homeworks') return SITE_DATA.holidayHomeworks;
    if(key === 'homework_notice') return SITE_DATA.homeworkNotice;
    if(key === 'daily_quote') return SITE_DATA.dailyQuote;
    if(key === 'important_dates') return IMPORTANT_DATES;
  }catch(e){}
  return undefined;
}

/**
 * 把本地内容推到云端。
 * @param {object} items  { 内容键: 值 }
 * @param {boolean} force true = 跳过冲突检查（后台改完主动同步时用）
 * @returns {Promise<{ok:boolean, pushed:number, conflict?:boolean, error?:string}>}
 * 失败不 reject —— 与个人数据同步一致，自动同步不该打断用户操作。
 */
function pushCloudContent(items, force){
  if(!apiReady()) return Promise.resolve({ ok:false, pushed:0, error:'后端未配置' });
  if(!isLoggedIn()) return Promise.resolve({ ok:false, pushed:0, error:'未登录' });
  var keys = Object.keys(items || {});
  if(!keys.length) return Promise.resolve({ ok:true, pushed:0 });
  if(__contentInFlight) return Promise.resolve({ ok:false, pushed:0, error:'上一次还在发' });

  /* --- 冲突检查：云端比我知道的更新，就别覆盖 --- */
  if(!force){
    return api('/content').then(function(j){
      var cloudTs = Number(j && j.serverTime) || 0;
      var myTs = 0;
      try{ myTs = Number(localStorage.getItem(CONTENT_TS_KEY)) || 0; }catch(e){}
      /* 云端时间明显更晚（容忍 2 秒时钟误差）→ 认定有别人的新改动 */
      if(cloudTs > 0 && myTs > 0 && cloudTs - myTs > 2000){
        return { ok:false, pushed:0, conflict:true };
      }
      return doPushContent(items);
    }).catch(function(){
      /* 读失败（网络抖动）不能阻止写入——直接推，宁可覆盖也不要丢改动 */
      return doPushContent(items);
    });
  }
  return doPushContent(items);
}

function doPushContent(items){
  __contentInFlight = true;
  return api('/content', { method:'PUT', body:{ items: items } })
    .then(function(j){
      if(j && j.ok === false) throw new Error(j.error || '保存失败');
      /* 记下服务端时间，作为下次冲突判断的基准 */
      if(j && j.serverTime){
        try{ localStorage.setItem(CONTENT_TS_KEY, String(j.serverTime)); }catch(e){}
      }
      /* 推成功 = 本地与云端一致，清掉待推标记 */
      Object.keys(items).forEach(function(k){ delete DIRTY_CONTENT[k]; });
      return { ok:true, pushed:(j && j.updated && j.updated.length) || Object.keys(items).length };
    })
    .catch(function(e){
      /* 失败保留 DIRTY_CONTENT，等下次改动或页面隐藏时再试 */
      return { ok:false, pushed:0, error:String(e && e.message || e) };
    })
    .then(function(r){ __contentInFlight = false; return r; });
}

/** 真正推送所有待推的内容键 */
function flushContentSync(){
  if(__contentDebounce !== null && __contentDebounce !== undefined){
    clearTimeout(__contentDebounce);
    __contentDebounce = null;
  }
  __contentFirstAt = 0;
  if(!isLoggedIn()){ DIRTY_CONTENT = {}; return Promise.resolve({ ok:true, pushed:0 }); }

  var keys = Object.keys(DIRTY_CONTENT);
  if(!keys.length) return Promise.resolve({ ok:true, pushed:0 });

  var items = {};
  keys.forEach(function(k){
    var v = readLocalContentValue(k);
    if(v !== undefined && v !== null) items[k] = v;
  });
  if(!Object.keys(items).length){ DIRTY_CONTENT = {}; return Promise.resolve({ ok:true, pushed:0 }); }

  return pushCloudContent(items, false).then(function(r){
    if(r && r.conflict){
      /* 有冲突：不清 DIRTY，但要提示一次，避免用户以为改动丢了 */
      if(typeof uiMsg === 'function'){
        uiMsg('云端有我未见过的修改，本次未覆盖。可刷新页面后再改。', '#af410f', 5200);
      }
      DIRTY_CONTENT = {};
      /* 立刻拉一次，把云端的最新内容显示出来，减少「两边不一致」的困惑 */
      try{ syncCloudContent(true).then(function(){ try{ rerenderAll(); }catch(e){} }); }catch(e){}
    }
    return r;
  });
}

/* 有内容改动待上传吗？ */
function hasPendingContentSync(){
  for(var k in DIRTY_CONTENT){ if(DIRTY_CONTENT[k]) return true; }
  return false;
}

/* ---------------- 挂钩内容写入 ----------------
   页面里改公告/作业的地方会直接改 SITE_DATA 上的字段。
   这里提供一个统一的「改完调一下」入口，避免每处都手写推送。 */
function saveContentLocal(key, value){
  var ok = applyCloudContent((function(){ var o = {}; o[key] = value; return o; })());
  if(!ok) return false;
  /* 写入本地缓存，刷新后不必等网络就能显示最新 */
  try{
    var o2 = {}; o2[key] = value;
    contentCacheSet(o2);
  }catch(e){}
  markContentDirty(key);
  /* 立刻刷新界面，不等网络 */
  try{
    if(key === 'announcements' || key === 'daily_quote') rerenderAll();
    if(key === 'study_card') renderStudyCard();   /* v2.6.0 学习卡片配置变了就重画 */
    if(key === 'quote_source'){ _quoteRemote = null; fetchRemoteQuote(); renderDailyQuote(); }   /* v3.5.9 来源切了立刻重来 */
    if(key === 'quote_schedule') renderDailyQuote();   /* v3.5.11 排期改了立刻重画 */
    if(key === 'holiday_homeworks' || key === 'homework_notice') refreshHwViews();
    if(key === 'important_dates'){ renderAllImp(); updateCountdown(); }
  }catch(e){}
  return true;
}

/* ---------------- 挂钩 localStorage.setItem ----------------
   页面里有 35 处直接调 setItem，一个个去加标记既不现实也容易漏。
   这里包一层原生方法：凡是写「云键」就自动登记待同步。
   其它键（token、门禁状态等）原样放行，不产生任何副作用。

   为什么包在 try 里：某些浏览器（隐私模式 / 禁用存储）访问 localStorage
   会直接抛异常，包装失败也不能让整个页面挂掉。 */
/* ============================================================================
 * 本地写入钩子（v3.6.4 重写：这是作业同步「怎么修都不生效」的真正原因）
 * ----------------------------------------------------------------------------
 * 站主原话：「这几次一直在强调的作业同步问题一直没实现，云端数据还在 16 号」
 *
 * 实测（2026-10-19 23:0x，在线上页面里直接查）：
 *   localStorage.setItem 仍然是 `[native code]` —— 说明旧写法
 *      var proto = window.localStorage; proto.setItem = fn;
 *   **根本没挂上去**（Chrome 里给 Storage 实例赋同名属性会被忽略，不报错）。
 *   于是每次打勾都不会被 markCloudDirty 登记，flushCloudSync 里 keys 永远为空，
 *   一个字节都不会上传。之前所有「加强重试 / 落盘 pending」的修复都白做了 ——
 *   因为源头压根没触发。
 *
 * 正确做法：改 Storage.prototype（对所有实例生效），再按 this 判断是不是 localStorage。
 * 同时保留原来的语义：
 *   · __cloudPulling 期间不登记（从云端回写的值不是本机改动）
 *   · 只登记云键（isCloudKey 内部判断）
 *   · 失败一律吞掉，绝不影响业务写入
 * ========================================================================= */
(function hookLocalStorage(){
  try{
    if(!window.Storage || !Storage.prototype) return;
    var proto = Storage.prototype;
    if(proto.__clsHooked) return;
    var rawSet = proto.setItem;
    var rawRemove = proto.removeItem;

    /* ⚠️ 递归保护（v3.6.4 第二次修正）：
       markLocalWrite 自己会写 localStorage（__cls_lts），那次写入又会进这个钩子……
       于是形成 setItem → markLocalWrite → setItem → … 无限递归，栈溢出后被 catch
       静默吞掉 —— 表现就是「钩子挂上了、但一个键都没登记」。
       实测：打勾后 DIRTY_KEYS 仍然是空的，云端一直没有新数据。
       现在用一个标志把「钩子内部产生的写入」挡掉。 */
    proto.setItem = function(k, v){
      rawSet.call(this, k, v);
      if(this !== window.localStorage) return;     /* sessionStorage 不管 */
      if(window.__cloudPulling) return;            /* 云端回写不算本机改动 */
      if(window.__clsInWrite) return;              /* 钩子内部写入，别递归 */
      window.__clsInWrite = true;
      try{
        markLocalWrite(String(k));
        markCloudDirty(String(k));
      }catch(e){
      }finally{
        window.__clsInWrite = false;
      }
    };
    /* 删除也算改动：云端要跟着删掉，否则换设备又冒出来 */
    proto.removeItem = function(k){
      rawRemove.call(this, k);
      if(this !== window.localStorage) return;
      if(window.__cloudPulling) return;
      if(window.__clsInWrite) return;
      window.__clsInWrite = true;
      try{
        markLocalWrite(String(k));
        markCloudDirty(String(k));
      }catch(e){
      }finally{
        window.__clsInWrite = false;
      }
    };
    proto.__clsHooked = true;
  }catch(e){ /* 挂不上就算了，手动同步仍然可用 */ }
})();

/* 页面切到后台 / 关闭时立即把待发的改动送出去。
   sendBeacon 那条路已经在下面处理了，这里补的是「切到后台但没关页面」
   这种最常见的情况（比如同学切去回微信消息）。 */
try{
  document.addEventListener('visibilitychange', function(){
    if(document.visibilityState === 'hidden'){
      if(hasPendingCloudSync()) flushCloudSync();
      if(hasPendingContentSync()) flushContentSync();   /* 共享内容走另一条线路 */
      actLogFlushKeepalive();   /* v2.10.1：改用 keepalive —— 普通 fetch 会被卸载取消 */
    }
  });
}catch(e){}

/* ============================================================
   用户操作日志上报（v2.10.0 · 2026-10-16 第六十轮）
   ------------------------------------------------------------
   站主要求：「记录全部点击交互行为：页面跳转、按钮点击、切换标签、
   表单提交等，每一次点击都作为操作上报日志」。

   实现：
     · 全局 click 捕获（捕获阶段，阻止冒泡的点击也拿得到）→ 'click'
     · openCat / acctTab 包装 → 'jump'（页面跳转）/ 'switch'（标签切换）
     · 表单提交由「点提交按钮的那条 click」承载（target 即按钮文本），
       不另开通道 —— 全站没有 <form> 直提，提交都走按钮点击
   节流：攒 20 条或 30 秒发一批；页面隐藏立即发；队列落 localStorage，
        刷新/闪退不丢（最多保留 200 条）。
   隐私：只记「做了什么」，不记任何输入内容；detail 只放字段名级摘要。
   未登录 / 无后端：不上报（没有归属用户，发了也白发）。
   ============================================================ */
var ACT_LOG_Q = [];               /* 待上报队列（内存 + localStorage 双份） */
var ACT_LOG_MAX = 20;             /* 攒够这么多就发 */
var ACT_LOG_WAIT = 30000;         /* 或者等了这么久就发 */
var ACT_LOG_KEY = 'cls_act_log_q';
var __actLogTimer = null;
var __actLogFirstAt = 0;

function actLogLoad(){
  try{
    var raw = localStorage.getItem(ACT_LOG_KEY);
    if(raw){
      var a = JSON.parse(raw);
      if(Array.isArray(a)) ACT_LOG_Q = a.slice(-200);
    }
  }catch(e){}
}
function actLogSave(){
  try{
    if(ACT_LOG_Q.length) localStorage.setItem(ACT_LOG_KEY, JSON.stringify(ACT_LOG_Q.slice(-200)));
    else localStorage.removeItem(ACT_LOG_KEY);
  }catch(e){}
}
/** 当前页面中文名（日志的 page 字段；弹窗优先于板块） */
function actCurPage(){
  try{
    var m = document.getElementById('acctMask');
    if(m && m.classList.contains('show')) return '账号弹窗';
    var p = document.getElementById('popMask');
    if(p && p.classList.contains('show')) return '通知弹窗';
    if(typeof __activeCat !== 'undefined' && __activeCat){
      var cats = (window.SITE_DATA && SITE_DATA.categories) || [];
      for(var i = 0; i < cats.length; i++){
        if(cats[i].id === __activeCat) return cats[i].name || ('板块' + __activeCat);
      }
    }
    return '首页';
  }catch(e){ return ''; }
}
/** 记一条。type: click | jump | switch | submit；pg 可覆盖当前页名（跳转类用）
 *  v3.5.13（站主反馈「一秒内三条一模一样的记录，肯定重复获取了」）：
 *  同一动作 2 秒内重复触发（连点按钮、多层元素各触发一次）只记第一条。 */
var __actLogLast = null;
function actLog(type, target, detail, pg){
  if(!isLoggedIn()) return;
  if(!apiReady()) return;
  var now = Date.now();
  var page = pg != null ? String(pg).slice(0, 60) : actCurPage();
  if(__actLogLast && __actLogLast.a === String(type || 'click').slice(0, 20)
    && __actLogLast.t === String(target == null ? '' : target).slice(0, 120)
    && __actLogLast.p === page
    && (now - __actLogLast.ts) < 2000){
    return;   /* 2 秒内的同款动作 = 连点/重复触发，不记 */
  }
  __actLogLast = { a: String(type || 'click').slice(0, 20), t: String(target == null ? '' : target).slice(0, 120), p: page, ts: now };
  ACT_LOG_Q.push({
    a: String(type || 'click').slice(0, 20),
    t: String(target == null ? '' : target).slice(0, 120),
    d: String(detail == null ? '' : detail).slice(0, 120),
    p: page,
    ts: now
  });
  if(ACT_LOG_Q.length > 200) ACT_LOG_Q = ACT_LOG_Q.slice(-200);
  actLogSave();   /* 🚀 v2.10.1：入队即落盘 —— 点完外链直接跳走/直接关页面也不丢 */
  if(ACT_LOG_Q.length >= ACT_LOG_MAX) actLogFlush();
  else actLogSchedule();
}
function actLogSchedule(){
  if(__actLogTimer) return;
  var now = Date.now();
  if(!__actLogFirstAt) __actLogFirstAt = now;
  var left = ACT_LOG_WAIT - (now - __actLogFirstAt);
  if(left <= 0){ actLogFlush(); return; }
  __actLogTimer = setTimeout(function(){ __actLogTimer = null; actLogFlush(); }, left);
}
function actLogFlush(){
  if(__actLogTimer){ clearTimeout(__actLogTimer); __actLogTimer = null; }
  __actLogFirstAt = 0;
  if(!ACT_LOG_Q.length) return;
  if(!isLoggedIn() || !apiReady()) return;
  var batch = ACT_LOG_Q.slice(0, 50);
  api('/data?action=log', { method:'POST', body:{ events: batch } })
    .then(function(j){
      if(j && j.ok){
        ACT_LOG_Q = ACT_LOG_Q.slice(batch.length);
        actLogSave();
        if(ACT_LOG_Q.length) setTimeout(actLogFlush, 600);   /* 还有剩的（罕见）继续发 */
      }
    })
    .catch(function(){ /* 失败保留队列，下批带上重试 */ });
}

/**
 * 走人前的最后一次发送（页面卸载 / 跳外链 / 切后台）。
 *
 * ⚠️ 2026-10-17 站主反馈「点了常用服务里的点歌平台，后台查不到这条记录」——根因就在这里：
 *    原来卸载时调的是 actLogFlush()，它走普通 fetch；浏览器在页面卸载/跳转时
 *    会**直接取消**普通请求，于是刚点的那一条（连同队列里攒着的）全部无声丢失。
 *    攒批策略本身没错（省请求），错在「离开前的最后一批」也必须送达。
 *
 * 解法：改用 fetch 的 **keepalive: true** —— 浏览器保证请求在页面卸载后继续发完。
 *   · 不能改用 navigator.sendBeacon：它不支持自定义请求头，token 只能塞 URL，
 *     而 token 进 URL 会被浏览器历史 / 服务器日志 / Referer 记下（站规里已明确否掉）。
 *   · keepalive 的请求体上限 64KB，这里一批 50 条 ≈ 十几 KB，安全。
 *   · 队列另外在入队时就写了 localStorage，万一这次也没送出去，下次打开站点会自动补发。
 */
function actLogFlushKeepalive(){
  if(__actLogTimer){ clearTimeout(__actLogTimer); __actLogTimer = null; }
  __actLogFirstAt = 0;
  if(!ACT_LOG_Q.length) return;
  if(!isLoggedIn() || !apiReady()) return;
  var batch = ACT_LOG_Q.slice(0, 50);
  try{
    fetch(apiUrl('/data?action=log'), {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + ((AUTH && AUTH.token) ? AUTH.token : '')
      },
      body: JSON.stringify({ events: batch })
    }).then(function(){
      ACT_LOG_Q = ACT_LOG_Q.slice(batch.length);
      actLogSave();
    }).catch(function(){ /* 留在队列里，下次打开站点补发 */ });
  }catch(e){ /* 不支持 keepalive 时忽略：队列已落盘，不会真丢 */ }
}

/* 全局 click 捕获：每一次点击都记（target 描述 = 标签 + id/标题/文本） */
try{
  document.addEventListener('click', function(ev){
    var el = ev.target;
    if(!el || el.nodeType !== 1) return;
    /* v2.10.1：openLink 触发的跳转由 openLink 自己记一条「入口名 + 目标地址」，
       这里就不再记通用点击了 —— 一动作两条记录，后台看着反而乱。 */
    try{
      var ocHost = (el.closest ? (el.closest('[onclick]') || el) : el);
      var oc = ocHost && ocHost.getAttribute ? (ocHost.getAttribute('onclick') || '') : '';
      if(/openLink\s*\(/.test(oc)) return;
    }catch(e){}
    var tag = String(el.tagName || '').toLowerCase();
    var desc = '';
    try{
      if(el.id) desc = '#' + el.id;
      if(!desc && el.getAttribute){
        desc = el.getAttribute('data-act') ? '[' + el.getAttribute('data-act') + ']'
             : (el.getAttribute('title') || el.getAttribute('alt') || '');
      }
      if(!desc) desc = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    }catch(e){}
    actLog('click', (tag ? tag + ' ' : '') + (desc || 'unknown'));
  }, true);
}catch(e){}

/* 启动：恢复上次未来得及发的队列；登录态变化时会跟着发 */
actLogLoad();
/* v2.10.1：上次没送出去的（点了外链直接走掉、或直接关了页面）在这里补发一次。
   等几秒是为了避开开屏那波请求，也确保登录态已经就绪。 */
setTimeout(function(){ try{ if(ACT_LOG_Q.length) actLogFlush(); }catch(e){} }, 4000);

/** 立即同步：先推本机 → 云端，再把云端最新拉回来，保证一致 */
function syncNow(btn){
  if(!isLoggedIn()){ if(typeof uiMsg === 'function') uiMsg('请先登录', '#af410f'); return; }
  return syncBtnRun(btn, '同步中…', function(){
  if(typeof uiMsg === 'function') uiMsg('正在同步…');
  /* v2.10.0：原名「上传本机」实为推送-only，与「双向同步」的按钮名不符。
     现在推完立刻静默拉一次个人数据（云端优先），真·双向。 */
  flushCloudSync().then(function(){
    return syncPullSilent();
  }).then(function(r){
    if(typeof uiMsg === 'function'){
      uiMsg(r && r.pulled
        ? ('✅ 已同步，并从云端更新 ' + r.pulled + ' 项')
        : '✅ 已同步，云端与本机一致');
    }
  }).catch(function(e){
    if(typeof uiMsg === 'function') uiMsg('同步失败：' + e.message, '#c0392b');
    throw e;
  });
  });
}

/* ============================================================
   自动云同步（第二十七轮 ⑦）
   ------------------------------------------------------------
   目标：不用手动点，改动自己会上去，别人的改动能自己下来。
   策略：
     · 每 60 秒跑一轮「双向」——先推本机待发改动，再拉云端最新。
     · 只在**已登录**时跑；未登录只做只读拉取（公开内容本就无需登录）。
     · 页面不可见（切后台 / 锁定）时暂停，回到前台立刻补跑一轮，
       避免后台标签页白白耗电耗流量。
     · 正在输入（有焦点在 input/textarea）时推迟，别打断打字。
     · 网络失败自动退避（30s → 60s → 120s，最长 5 分钟），
       成功一次立刻回到 60 秒。
     · 状态对外暴露在 SYNC_STATE，界面可显示「上次同步 / 结果」。
   ============================================================ */
var SYNC_STATE = {
  lastAt: null,        /* 上次成功同步时间 */
  lastResult: 'idle',  /* idle | ok | error | skipped */
  lastError: null,
  pushed: 0,
  pulled: 0,
  running: false,
  failStreak: 0
};
var SYNC_INTERVAL = 60000;      /* 基准间隔 1 分钟 */
var SYNC_MAX_BACKOFF = 300000;  /* 退避上限 5 分钟 */
var __syncTimer = null;

/** 现在适合自动同步吗（页面可见 + 没在输入） */
function syncShouldRun(){
  try{ if(document.visibilityState === 'hidden') return false; }catch(e){}
  try{
    var a = document.activeElement;
    if(a){
      var tag = String(a.tagName || '').toUpperCase();
      /* 正在打字就别抢，等下一轮 */
      if((tag === 'INPUT' || tag === 'TEXTAREA' || a.isContentEditable) && a.value !== undefined) return false;
    }
  }catch(e){}
  return true;
}

/** 跑一轮双向同步 */
function syncRound(opts){
  opts = opts || {};
  if(SYNC_STATE.running) return Promise.resolve({ skipped:'running' });
  if(!opts.force && !syncShouldRun()){
    SYNC_STATE.lastResult = 'skipped';
    return Promise.resolve({ skipped:'busy' });
  }
  SYNC_STATE.running = true;

  /* v3.5.42：先把「上次没推成功」的键补上（勾完立刻退出就是这种情况） */
  try{ restorePendingSync(); }catch(e){}

  /* ① 先推：把本机待发的内容改动发出去（未登录会直接跳过） */
  var pushStep = hasPendingContentSync()
    ? flushContentSync().catch(function(){ return { ok:false }; })
    : Promise.resolve({ ok:true, pushed:0 });

  return pushStep.then(function(){
    /* ② 再拉：把云端最新取回来（无需登录也能读公开内容） */
    return syncCloudContent(true).then(function(rc){
      /* v2.10.0 ③ 个人数据双向同步（修复跨设备作业勾选不同步）：
           · 已登录才跑；先推本机脏键（flush），再云端优先拉取（silent pull）
           · 先推后拉的顺序保证本机改动先上云，拉回时不会被旧值冲掉；
             syncPullSilent 内部还会跳过脏键，双保险
           · 拉取失败不影响内容同步的结果上报（个人数据是增强，不是主干） */
      if(!isLoggedIn()) return rc;
      /* v3.5.34：每轮顺手补一次「本机有、云端没有」的作业勾选（只跑一次，见函数注释） */
      try{ backfillOrphanHwDone(); }catch(e){}
      var personal = hasPendingCloudSync()
        ? flushCloudSync().catch(function(){ return { pushed:0 }; }).then(function(){ return syncPullSilent(); })
        : syncPullSilent();
      return personal.then(function(rp){
        if(rc && rc.ok){
          return { ok:true, count:(rc.count || 0) + (rp.pulled || 0), personalPulled: rp.pulled || 0 };
        }
        return rc;
      }).catch(function(){ return rc; });
    });
  }).then(function(r){
    SYNC_STATE.running = false;
    if(r && r.ok){
      SYNC_STATE.lastAt = new Date();
      SYNC_STATE.lastResult = 'ok';
      SYNC_STATE.lastError = null;
      SYNC_STATE.pulled = r.count || 0;
      SYNC_STATE.failStreak = 0;
      /* 拉到新内容 → 刷新界面 */
      if(r.count > 0){
        try{ if(typeof rerenderAll === 'function') rerenderAll(); }catch(e){}
        try{ if(typeof refreshHwViews === 'function') refreshHwViews(); }catch(e){}
      }
      return { ok:true, pulled:r.count };
    }
    SYNC_STATE.lastResult = 'error';
    SYNC_STATE.lastError = (r && r.error) || '未知错误';
    SYNC_STATE.failStreak++;
    return { ok:false, error:SYNC_STATE.lastError };
  }).catch(function(e){
    SYNC_STATE.running = false;
    SYNC_STATE.lastResult = 'error';
    SYNC_STATE.lastError = String(e && e.message || e);
    SYNC_STATE.failStreak++;
    return { ok:false, error:SYNC_STATE.lastError };
  }).then(function(res){
    syncScheduleNext();
    syncStatusPaint();
    return res;
  });
}

/** 安排下一次（含失败退避） */
function syncScheduleNext(){
  if(__syncTimer) { clearTimeout(__syncTimer); __syncTimer = null; }
  var wait = SYNC_INTERVAL;
  if(SYNC_STATE.failStreak > 0){
    /* 30s → 60s → 120s → 240s，封顶 5 分钟 */
    wait = Math.min(30000 * Math.pow(2, SYNC_STATE.failStreak - 1), SYNC_MAX_BACKOFF);
  }
  __syncTimer = setTimeout(function(){ syncRound(); }, wait);
}

/* ============================================================================
 * v3.6.4（站主 #2）：同步按钮的「看得见的反馈」
 * ----------------------------------------------------------------------------
 * 站主原话：「在我的账号页面的拉取云端，双向同步，上传本机这些按钮加一点动画，
 *            用户压根不清楚点击按钮后是否有反应，有没有进行同步」
 *
 * 做法：点下去立刻进「转圈 + 文案」态并禁用；成功打勾、失败打叉，1.2 秒后复原。
 * 用 Promise 包住原来的逻辑，不改变同步本身的行为。
 * ========================================================================= */
function syncBtnRun(btn, busyText, task){
  if(!btn || btn.disabled) return Promise.resolve();
  var orig = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add('sync-busy');
  btn.innerHTML = '<span class="sync-spin"></span> ' + busyText;
  return Promise.resolve()
    .then(task)
    .then(function(r){
      btn.classList.remove('sync-busy');
      btn.innerHTML = '✓ 完成';
      setTimeout(function(){ btn.disabled = false; btn.innerHTML = orig; }, 1200);
      return r;
    })
    .catch(function(e){
      btn.classList.remove('sync-busy');
      btn.innerHTML = '✗ 失败';
      setTimeout(function(){ btn.disabled = false; btn.innerHTML = orig; }, 1800);
      throw e;
    });
}

/** 手动：只上传本机 → 云端 */
function syncUploadNow(btn){
  if(!isLoggedIn()){ if(typeof uiMsg === 'function') uiMsg('请先登录后再上传', '#af410f'); return; }
  return syncBtnRun(btn, '上传中…', function(){
  markAllContentDirty();
  return flushContentSync().then(function(r){
    SYNC_STATE.lastAt = new Date();
    syncStatusPaint();
    if(typeof uiMsg === 'function'){
      uiMsg(r && (r.pushed > 0) ? ('✅ 已上传 ' + r.pushed + ' 项') : '本机没有待上传的改动');
    }
  }).catch(function(e){
    if(typeof uiMsg === 'function') uiMsg('上传失败：' + e.message, '#c0392b');
    throw e;
  });
  });
}
/** 手动：只从云端拉取 */
function syncDownloadNow(btn){
  return syncBtnRun(btn, '拉取中…', function(){
  if(typeof uiMsg === 'function') uiMsg('正在拉取云端最新…');
  /* v2.10.0：原来只拉共享内容，个人数据（作业勾选等）不拉 —
     「拉取云端」按钮名不副实，跨设备旧数据问题也在这。
     现在内容 + 个人数据都拉，个人数据走云端优先的静默拉取。 */
  /* v3.5.34：先补推「本机有、云端没有」的作业勾选，再拉 ——
     否则用户点「拉取云端」时，本机尚未上传的勾选会被云端旧值盖掉。 */
  try{ backfillOrphanHwDone(); }catch(e){}
  syncCloudContent(true).then(function(r){
    var contentOk = r && r.ok;
    return syncPullSilent().then(function(rp){
      SYNC_STATE.lastAt = new Date();
      syncStatusPaint();
      try{ if(typeof rerenderAll === 'function') rerenderAll(); }catch(e){}
      try{ if(typeof refreshHwViews === 'function') refreshHwViews(); }catch(e){}
      if(typeof uiMsg === 'function'){
        uiMsg(contentOk
          ? ('✅ 已拉取云端最新（内容 ' + (r.count || 0) + ' 项、个人数据 ' + (rp.pulled || 0) + ' 项有更新）')
          : '✅ 个人数据已更新 ' + (rp.pulled || 0) + ' 项（共享内容拉取失败）');
      }
    });
  }).catch(function(e){
    if(typeof uiMsg === 'function') uiMsg('拉取失败：' + (e.message || e), '#c0392b');
    throw e;
  });
  });
}

/** 把当前所有云键标为待推（手动「上传本机」用） */
function markAllContentDirty(){
  try{
    Object.keys(CONTENT_MAP).forEach(function(k){
      if(CONTENT_MAP[k] !== null) markContentDirty(k);
    });
    /* important_dates / site_config 是特殊键，也一并带上 */
    markContentDirty('important_dates');
    markContentDirty('site_config');
    /* links 不在 CONTENT_MAP 里（前端本地改动，云端不覆盖），不上传 */
  }catch(e){}
}

/** 同步状态文案（供界面小字显示） */
function syncStatusText(){
  if(!SYNC_STATE.lastAt && SYNC_STATE.lastResult === 'idle') return '自动同步已开启';
  if(SYNC_STATE.lastResult === 'error') return '同步失败：' + (SYNC_STATE.lastError || '未知');
  if(SYNC_STATE.lastResult === 'skipped') return '稍后自动同步';
  var d = SYNC_STATE.lastAt;
  if(!d) return '自动同步已开启';
  var hh = ('0' + d.getHours()).slice(-2), mm = ('0' + d.getMinutes()).slice(-2);
  return '上次同步 ' + hh + ':' + mm;
}
function syncStatusPaint(){
  var el = document.getElementById('syncStatusLine');
  if(el) el.textContent = syncStatusText();
}

/** 启动自动同步 */
function syncAutoInit(){
  /* v3.5.42：进站先把上次没推成功的改动补推掉（不等 5 秒）。
     站主「勾完立刻退出」的那一笔就靠这里捡回来，越早发越安全。 */
  try{ restorePendingSync(); }catch(e){}
  /* 首次延迟 5 秒（让 contentBoot 的首拉先完成），之后按 60 秒节拍 */
  if(__syncTimer){ clearTimeout(__syncTimer); __syncTimer = null; }
  __syncTimer = setTimeout(function(){ syncRound(); }, 5000);
  /* 回到前台：立刻补跑一轮，不必等下一个节拍 */
  try{
    document.addEventListener('visibilitychange', function(){
      if(document.visibilityState === 'visible') syncRound();
    });
  }catch(e){}
  /* 网络恢复：立刻补跑 */
  try{
    window.addEventListener('online', function(){ syncRound({ force:true }); });
  }catch(e){}
}

/* ============================================================
 * 管理员后台
 * ============================================================ */
var ADMIN_TAB = 'users';
var ADMIN_CACHE = { users: [], stats: null, detail: null };

/* 需求变更（2026-10-05）：主站不再内置管理员弹窗。
   管理功能统一放在独立的 admin.html，权限更清晰，主站也不用背着那套代码。
   （长按班徽、账号弹窗里的按钮、以及任何遗留的 openAdmin() 调用都走这里。）

   留 openAdmin 这个函数名是为了兼容既有调用点，实际行为＝跳转。 */
function gotoAdminPage(){
  if(!isLoggedIn()){ if(typeof uiMsg === 'function') uiMsg('请先登录', '#af410f'); return; }
  /* v3.5.30：标记「从主站点进来」—— 后台据此判断不自动横屏。
     站主原话：「如果是从主页面进入的后台页面，默认采用竖屏，不用横过来。」
     用 sessionStorage 而不是 URL 参数：参数会留在地址栏和分享链接里，
     而且刷新后也不该变成「外部直接打开」。 */
  try{ sessionStorage.setItem('cls_admin_from_home', '1'); }catch(e){}
  location.href = 'admin.html';
}
function openAdmin(){ gotoAdminPage(); }

/* 以下 closeAdmin / adminTab 等辅助函数保留：
   它们被隐藏入口和遗留代码引用，删掉会连带报错。
   但主站已经不再渲染管理员界面，所以这些函数实际上不会被触发。 */
function closeAdmin(){
  var m = document.getElementById('adminMask'); if(m) m.classList.remove('show');
}
function adminTab(k){
  ADMIN_TAB = k;
  renderAdminTabs();
  renderAdminBody();
  if(typeof SFX !== 'undefined' && SFX && SFX.click) SFX.click();
}
function renderAdminTabs(){
  var t = document.getElementById('adminTabs');
  if(!t) return;
  var tabs = [
    { k:'users', n:'👥 用户管理' },
    { k:'stats', n:'📊 数据统计' },
    { k:'audit', n:'📝 操作日志' }
  ];
  t.innerHTML = tabs.map(function(x){
    return '<button class="admin-tab' + (ADMIN_TAB === x.k ? ' active' : '') +
      '" onclick="adminTab(\'' + x.k + '\')">' + x.n + '</button>';
  }).join('');
}
function renderAdminBody(){
  var b = document.getElementById('adminBody');
  if(!b) return;
  b.innerHTML = '<div class="admin-empty">加载中…</div>';

  if(ADMIN_TAB === 'users') return loadAdminUsers();
  if(ADMIN_TAB === 'stats') return loadAdminStats();
  if(ADMIN_TAB === 'audit') return loadAdminAudit();
}

/* ---- 用户管理 ---- */
function loadAdminUsers(q){
  var url = '/admin?action=users' + (q ? '&q=' + encodeURIComponent(q) : '');
  return api(url).then(function(j){
    ADMIN_CACHE.users = j.users || [];
    var b = document.getElementById('adminBody');
    if(!b) return;
    var total = j.total || 0;
    b.innerHTML =
      '<div class="admin-search">' +
        '<input id="adminQ" placeholder="搜索用户名或显示名…" value="' + esc(q || '') + '">' +
        '<button onclick="loadAdminUsers(document.getElementById(\'adminQ\').value)">搜索</button>' +
      '</div>' +
      '<div class="admin-stats">' +
        '<div class="admin-stat"><b>' + total + '</b><span>注册用户</span></div>' +
      '</div>' +
      '<div class="admin-list">' +
      (ADMIN_CACHE.users.length === 0
        ? '<div class="admin-empty">没有找到用户</div>'
        : ADMIN_CACHE.users.map(adminUserRow).join('')) +
      '</div>';
  }).catch(function(e){
    var b = document.getElementById('adminBody');
    if(b) b.innerHTML = '<div class="admin-empty">加载失败：' + esc(e.message) + '</div>';
  });
}

function adminUserRow(u) {
  var name = u.displayName || u.username;
  var last = u.lastLoginAt ? String(u.lastLoginAt).slice(0, 16).replace('T', ' ') : '从未登录';
  return '<div class="admin-item">' +
    '<div class="who">' +
      '<b>' + esc(name) + '</b>' +
      '<span class="admin-tag' + (u.role === 'admin' ? ' admin' : '') + '">' +
        (u.role === 'admin' ? '管理员' : '成员') + '</span>' +
      (u.status === 'banned' ? '<span class="admin-tag banned">已禁用</span>' : '') +
      '<small>@' + esc(u.username) + ' · 云端 ' + u.dataCount + ' 项 · 上次登录 ' + last + '</small>' +
    '</div>' +
    '<div class="admin-act">' +
      '<button onclick="adminViewUser(' + u.id + ')">详情</button>' +
      '<button onclick="adminResetPwd(' + u.id + ',\'' + esc(name).replace(/'/g, "\\'") + '\')">重置密码</button>' +
      (u.status === 'banned'
        ? '<button onclick="adminSetStatus(' + u.id + ',\'active\')">启用</button>'
        : '<button class="danger" onclick="adminSetStatus(' + u.id + ',\'banned\')">禁用</button>') +
      (u.role === 'admin'
        ? '<button onclick="adminSetRole(' + u.id + ',\'user\')">降为成员</button>'
        : '<button onclick="adminSetRole(' + u.id + ',\'admin\')">设为管理员</button>') +
      '<button onclick="adminClearSessions(' + u.id + ')">强制下线</button>' +
      '<button class="danger" onclick="adminDeleteUser(' + u.id + ',\'' + esc(name).replace(/'/g, "\\'") + '\')">删除</button>' +
    '</div>' +
  '</div>';
}

function adminViewUser(id){
  api('/admin?action=user&id=' + id).then(function(j){
    ADMIN_CACHE.detail = j;
    var b = document.getElementById('adminBody');
    var u = j.user;
    var data = j.data || [];
    var sessions = j.sessions || [];
    var body =
      '<div style="margin-bottom:12px">' +
        '<button class="acct-btn ghost" style="width:auto;padding:7px 13px;font-size:.76rem" onclick="loadAdminUsers()">← 返回用户列表</button>' +
      '</div>' +
        '<div class="admin-kv">' +
          '<b>' + esc(u.displayName || u.username) + '</b>（@' + esc(u.username) + '）<br>' +
          '角色：' + (u.role === 'admin' ? '管理员' : '成员') +
          '　状态：' + (u.status === 'active' ? '正常' : '已禁用') + '<br>' +
          '注册：' + String(u.createdAt || '').slice(0, 16).replace('T', ' ') +
          '　最近登录：' + (u.lastLoginAt ? String(u.lastLoginAt).slice(0, 16).replace('T', ' ') : '从未') + '<br>' +
          '在线设备：' + sessions.length + ' 台' +
        '</div>' +
      '</div>' +
      '<div style="font-size:.78rem;font-weight:800;color:#3f342c;margin-bottom:7px">☁️ 云端数据（' + data.length + ' 项）</div>' +
      '<div class="admin-datalist" id="adminDataList">' +
        (data.length === 0 ? '<div class="admin-empty">该用户还没有云端数据</div>' :
          data.map(function(d){
            var v = typeof d.value === 'object' ? JSON.stringify(d.value) : String(d.value);
            return '<div class="admin-datarow">' +
              '<span class="k">' + esc(d.key) + '</span>' +
              '<span class="v" title="' + esc(v) + '">' + esc(v.slice(0, 60)) + '</span>' +
              '<button onclick="adminEditData(' + id + ',\'' + esc(d.key) + '\')">改</button>' +
              '<button onclick="adminDeleteData(' + id + ',\'' + esc(d.key) + '\')">删</button>' +
            '</div>';
          }).join('')) +
      '</div>' +
      '<div class="acct-row" style="margin-top:14px">' +
        '<button class="acct-btn ghost" onclick="loadAdminUsers()">← 返回用户列表</button>' +
      '</div>';
    if(b) b.innerHTML = body;
  }).catch(function(e){ if(typeof uiMsg === 'function') uiMsg(e.message, '#c0392b'); });
}

function adminResetPwd(id, name){
  var p = prompt('给「' + name + '」设置新密码（至少 6 位）：\n\n设置后该用户在所有设备都需要重新登录。');
  if(p === null) return;
  if(p.length < 6){ uiMsg('密码至少 6 位', '#af410f'); return; }
  api('/admin?action=reset-password', { method:'POST', body:{ id:id, newPassword:p } })
    .then(function(j){ uiMsg('✅ ' + j.message); loadAdminUsers(); })
    .catch(function(e){ uiMsg(e.message, '#c0392b'); });
}

function adminSetStatus(id, status){
  if(status === 'banned' && !confirm('确定禁用该用户？\n\n禁用后他将无法登录，已登录的设备会立即退出。')) return;
  api('/admin?action=set-status', { method:'POST', body:{ id:id, status:status } })
    .then(function(j){ uiMsg('✅ ' + j.message); loadAdminUsers(); })
    .catch(function(e){ uiMsg(e.message, '#c0392b'); });
}

function adminSetRole(id, role){
  if(!confirm(role === 'admin' ? '确定把该用户设为管理员？\n\n管理员可以查看和修改所有用户的数据。' : '确定取消该用户的管理员身份？')) return;
  api('/admin?action=set-role', { method:'POST', body:{ id:id, role:role } })
    .then(function(j){ uiMsg('✅ ' + j.message); loadAdminUsers(); })
    .catch(function(e){ uiMsg(e.message, '#c0392b'); });
}

function adminClearSessions(id){
  if(!confirm('确定让该用户在所有设备退出登录？')) return;
  api('/admin?action=clear-sessions', { method:'POST', body:{ id:id } })
    .then(function(j){ uiMsg('✅ ' + j.message); })
    .catch(function(e){ uiMsg(e.message, '#c0392b'); });
}

function adminDeleteUser(id, name){
  if(!confirm('⚠️ 确定删除账号「' + name + '」？\n\n该用户的云端数据会一并清除，此操作不可恢复。')) return;
  if(!confirm('再确认一次：真的要删除吗？')) return;
  api('/admin?action=delete-user', { method:'POST', body:{ id:id } })
    .then(function(j){ uiMsg('✅ ' + j.message); loadAdminUsers(); })
    .catch(function(e){ uiMsg(e.message, '#c0392b'); });
}

function adminEditData(userId, key){
  var cur = '';
  try{
    var d = (ADMIN_CACHE.detail && ADMIN_CACHE.detail.data || []).filter(function(x){ return x.key === key; })[0];
    cur = d ? (typeof d.value === 'object' ? JSON.stringify(d.value) : String(d.value)) : '';
  }catch(e){}
  var v = prompt('修改「' + key + '」的值（JSON 或纯文本）：', cur);
  if(v === null) return;
  var parsed;
  try{ parsed = JSON.parse(v); }catch(e){ parsed = v; }
  api('/admin?action=set-data', { method:'POST', body:{ userId:userId, key:key, value:parsed } })
    .then(function(j){ uiMsg('✅ ' + j.message); adminViewUser(userId); })
    .catch(function(e){ uiMsg(e.message, '#c0392b'); });
}

function adminDeleteData(userId, key){
  if(!confirm('确定删除该用户的「' + key + '」这条数据？')) return;
  api('/admin?action=delete-data', { method:'POST', body:{ userId:userId, key:key } })
    .then(function(j){ uiMsg('✅ ' + j.message); adminViewUser(userId); })
    .catch(function(e){ uiMsg(e.message, '#c0392b'); });
}

/* ---- 数据统计 ---- */
function loadAdminStats(){
  return api('/admin?action=stats').then(function(j){
    var b = document.getElementById('adminBody');
    if(!b) return;
    var u = j.users || {}, d = j.data || {};
    var kb = (d.bytes / 1024).toFixed(1);
    b.innerHTML =
      '<div class="admin-stats">' +
        '<div class="admin-stat"><b>' + (u.total||0) + '</b><span>注册用户</span></div>' +
        '<div class="admin-stat"><b>' + (u.active7||0) + '</b><span>7 天内登录</span></div>' +
        '<div class="admin-stat"><b>' + (u.admins||0) + '</b><span>管理员</span></div>' +
        '<div class="admin-stat"><b>' + (u.banned||0) + '</b><span>已禁用</span></div>' +
        '<div class="admin-stat"><b>' + (j.activeSessions||0) + '</b><span>在线设备</span></div>' +
        '<div class="admin-stat"><b>' + (d.rows||0) + '</b><span>云端数据条数</span></div>' +
        '<div class="admin-stat"><b>' + kb + '</b><span>占用 KB</span></div>' +
      '</div>' +
      '<div style="font-size:.78rem;font-weight:800;color:#3f342c;margin:16px 0 7px">同学们同步最多的数据</div>' +
      '<div class="admin-keys">' +
        ((j.topKeys||[]).length === 0 ? '<span>暂无数据</span>' :
          j.topKeys.map(function(k){ return '<span>' + esc(k.key) + ' × ' + k.count + '</span>'; }).join('')) +
      '</div>';
  }).catch(function(e){
    var b = document.getElementById('adminBody');
    if(b) b.innerHTML = '<div class="admin-empty">加载失败：' + esc(e.message) + '</div>';
  });
}

/* ---- 操作日志 ---- */
function loadAdminAudit(){
  return api('/admin?action=audit&limit=100').then(function(j){
    var b = document.getElementById('adminBody');
    if(!b) return;
    var logs = j.logs || [];
    var NAMES = {
      'user.reset_password':'重置密码', 'user.set_status':'启用/禁用', 'user.set_role':'调整角色',
      'user.delete':'删除账号', 'user.clear_sessions':'强制下线',
      'data.update':'修改数据', 'data.delete':'删除数据',
      'user.change_password':'用户改密码'
    };
    b.innerHTML = logs.length === 0
      ? '<div class="admin-empty">还没有操作记录</div>'
      : '<div class="admin-log">' + logs.map(function(l){
          var t = String(l.created_at || '').slice(0, 16).replace('T', ' ');
          return '<div>' + t + '　<b>' + esc(l.actor || '?') + '</b> ' +
            esc(NAMES[l.action] || l.action) +
            (l.target_id ? ' → ' + esc(String(l.target_id)) : '') +
            (l.detail ? '（' + esc(String(l.detail)) + '）' : '') + '</div>';
        }).join('') + '</div>';
  }).catch(function(e){
    var b = document.getElementById('adminBody');
    if(b) b.innerHTML = '<div class="admin-empty">加载失败：' + esc(e.message) + '</div>';
  });
}

/* ---------- 启动：恢复登录态 ---------- */
(function initAuth(){
  loadAuth();
  refreshAcctBtn();
  loadRegisterConfig();   /* v2.10.0：后台注册总开关 → 注册 tab 显隐 */
  /* 有 token 就静默校验一次（顺带拿云端数据条数），失效会自动清掉 */
  if(AUTH.token){
    api('/auth?action=me').then(function(j){
      AUTH.user = j.user;
      saveAuth();
      refreshAcctBtn();
      window.__cloudKeyCount = (j.cloudKeys || []).length;
      /* v2.9.9：刷新后若账号仍带强制改密标志（比如改密前刷新了页面），
         直接恢复强制改密态 —— 表单会补一个「当前密码」输入框，
         不用再退出重登。
         v2.10.0：建议制后，跳过过的账号不再恢复强制态；
         未跳过的才恢复（表单里可点「暂不修改」跳过）。 */
      AUTH.user.mustChangePassword = !!j.mustChangePassword;
      if(j.mustChangePassword && ACCT_TAB !== 'forcepwd' && !pwdSkipped()){
        ACCT_TAB = 'forcepwd';
        renderAccount();
      }
      /* 顺便拉「我认领的资料」，让资料查询页立刻知道哪条是本人 */
      if(typeof pcLoadMyProfile === 'function') pcLoadMyProfile();
      /* 登录着就开始心跳，后台「最后上线」才准（2026-10-07） */
      startHeartbeat();
      /* v3.7.0：恢复登录态时也确保班徽缓存就绪（7 天内不重复下） */
      try{ badgeCacheLoad(false); }catch(e){}
      /* 班级名单改从云端拉（2026-10-07）：不再依赖写死在页面里的名单 */
      syncRoster();
    }).catch(function(){ /* 401 已在 api() 里处理 */ });
  }
  /* 版本号渲染到页脚 */
  paintVersion();
  /* v2.9.10：启动时按当前主题扫一遍 .ink-auto，保证首次渲染字色就正确 */
  try{ clsAutoInk(document.body); }catch(e){}
})();

/* ---------- 页面关闭前，如果登录了就补推一次 ---------- */
/* 注意：sendBeacon 只能发 POST，所以后端另外留了 /api/data?action=beacon 这条
   POST 通道专门接收（见 api/data.js）。这里失败也不影响页面关闭。

   2026-10-05 调整：优先只推「还没发出去的改动」（dirty），
   payload 小、成功率高；没有 dirty 时才退回全量兜底
   （守住「换设备能拿到完整数据」这个底线）。 */
window.addEventListener('pagehide', function(){
  if(!isLoggedIn()) return;

  /* v2.10.1：操作日志也要在卸载前发走（用户点外链、关标签页都会走到这里）。
     这一条是站主反馈「跳点歌平台没记录」的直接修复点。 */
  try{ actLogFlushKeepalive(); }catch(e){}

  /* 共享内容通道也补一次——它走的是 /api/content，与个人数据不是同一条线路。
     sendBeacon 只能带 URL 上的 token，而 /api/content 走 Authorization 头，
     所以这里用同步 XHR 兜底（页面卸载时会等待完成）。 */
  try{
    if(hasPendingContentSync()){
      var citems = {};
      Object.keys(DIRTY_CONTENT).forEach(function(k){
        var cv = readLocalContentValue(k);
        if(cv !== undefined && cv !== null) citems[k] = cv;
      });
      if(Object.keys(citems).length){
        var xhr = new XMLHttpRequest();
        xhr.open('PUT', apiUrl('/content'), false);   /* false = 同步，卸载时才会等 */
        xhr.setRequestHeader('Content-Type', 'application/json');
        if(AUTH && AUTH.token) xhr.setRequestHeader('Authorization', 'Bearer ' + AUTH.token);
        xhr.send(JSON.stringify({ items: citems }));
      }
    }
  }catch(e){ /* 失败不影响关闭 */ }

  var items;
  if(hasPendingCloudSync()){
    items = {};
    Object.keys(DIRTY_KEYS).forEach(function(k){
      var v = readLocalCloudValue(k);
      if(v !== undefined) items[k] = v;
    });
  }else{
    items = collectLocalCloudData();
  }
  if(Object.keys(items).length === 0) return;
  try{
    var blob = new Blob([JSON.stringify({ items: items })], { type:'application/json' });
    if(navigator.sendBeacon){
      /* token 不能放 header（sendBeacon 不支持自定义头），放 query 里 */
      navigator.sendBeacon(apiUrl('/data?action=beacon&t=' + encodeURIComponent(AUTH.token)), blob);
    }
  }catch(e){ /* 失败不影响关闭 */ }
});

/* ---------- Radial Theme Transition ----------
 * 【v34 重做】旧版是「先瞬间切完主题，再放一块纯色圆盘从按钮扩散」——圆盘里没有页面
 * 内容，站主指出这不是扩散，是「在新图层放了个动画」。正确做法有两条：
 *  A. 支持 View Transitions API（Chrome 111+ / Safari 18+）：用 startViewTransition 让
 *     浏览器截取切换前后的【真实页面快照】，新帧从按钮坐标做 clip-path 圆形扩散——
 *     圆里是带全部卡片文字图片的新主题画面，这才是真的「从按钮处扩散」。
 *  B. 不支持的内核（微信 X5 等）：切换【前】先盖一层「旧主题的真实背景」（固化主题
 *     渐变 / 用户自定义背景 + 蒙层），切换后让它向按钮收缩消失——拿不到旧画面截图的
 *     内核上能做到的最接近效果。方向是收缩而非扩散，但屏幕上始终是真实页面在变化。
 *  C. 动效关闭 / 系统「减少动态效果」：直接切换，无任何动画。 */
function themeRippleCenter(ev){
  var w = window.innerWidth, h = window.innerHeight;
  var x = w / 2, y = 60;
  if(ev && ev.clientX){ x = ev.clientX; y = ev.clientY; }
  else { var tb = document.getElementById('themeToggle');
         if(tb){ var r = tb.getBoundingClientRect(); x = r.left + r.width/2; y = r.top + r.height/2; } }
  x = Math.round(x); y = Math.round(y);
  var rr = Math.round(Math.hypot(Math.max(x, w - x), Math.max(y, h - y)) + 8);
  return { x: x, y: y, r: rr };
}

/* 视觉状态的统一出口：类切换 + 背景层 + 按钮图标（VT 路径下它运行在快照回调内） */
function applyThemeSwitch(next){
  var d = document.documentElement;
  d.classList.toggle('dark', next);
  applyBg();
  var b = document.getElementById('themeToggle');
  if(b) b.innerHTML = next ? iconSvg('sun',17) : iconSvg('moon',17);
  /* 验证码是 canvas 画的、颜色写死在像素里，换主题得重画一次，
     否则暗色下会留一块亮底。只**重画当前这张**、不换新码
     （用户可能正在看着图输入，换码会把人打乱）。 */
  try{
    var cv = document.getElementById('capImg');
    if(cv && typeof capPaint === 'function' && typeof CAP_STATE !== 'undefined' && CAP_STATE.code){
      capPaint(cv, CAP_STATE.code);
    }
  }catch(e){}
  /* 字色全站共用逻辑：主题变了，背景色全变，所有 .ink-auto 按新背景重算相反色 */
  try{ clsAutoInk(document.body); }catch(e){}
}

function radialTheme(x, y, next){
  if(!motionOn()){ applyThemeSwitch(next); return; }          /* C：无动画 */
  /* A：View Transitions —— 真实快照扩散 */
  if(typeof document.startViewTransition === 'function'){
    try{
      var st = document.documentElement.style, c = themeRippleCenter();
      st.setProperty('--vt-x', x + 'px');
      st.setProperty('--vt-y', y + 'px');
      st.setProperty('--vt-r', c.r + 'px');
      document.startViewTransition(function(){ applyThemeSwitch(next); });
      return;
    }catch(e){ /* 支持 API 但执行失败 → 落到 B */ }
  }
  /* B：旧画面收缩（固化切换前的真实背景） */
  var okClip = true;
  try{ okClip = !!(window.CSS && CSS.supports && CSS.supports('clip-path','circle(0px at 0 0)')); }catch(e){ okClip = false; }
  if(!okClip){ applyThemeSwitch(next); return; }
  var old = document.querySelector('.theme-legacy');
  if(old && old.parentNode) old.parentNode.removeChild(old);   /* 快速连点时的上一层 */
  var cs = getComputedStyle(document.documentElement);
  var ov = document.createElement('div');
  ov.className = 'theme-legacy';
  if((document.documentElement.getAttribute('data-bg') || 'theme') === 'theme'){
    ov.style.backgroundImage = 'linear-gradient(160deg,' + cs.getPropertyValue('--bg-1').trim() + ',' +
      cs.getPropertyValue('--bg-2').trim() + ' 55%,' + cs.getPropertyValue('--bg-3').trim() + ')';
  }else{
    var bgEl = document.getElementById('bgLayer'), bs = bgEl ? getComputedStyle(bgEl) : null;
    var layers = [], veil = cs.getPropertyValue('--bg-veil').trim();
    if(veil) layers.push('linear-gradient(' + veil + ',' + veil + ')');
    if(bs && bs.backgroundImage && bs.backgroundImage !== 'none') layers.push(bs.backgroundImage);
    if(layers.length) ov.style.backgroundImage = layers.join(',');
    if(bs && bs.backgroundColor && bs.backgroundColor !== 'rgba(0, 0, 0, 0)')
      ov.style.backgroundColor = bs.backgroundColor;
    if(!layers.length && !ov.style.backgroundColor)            /* 兜底：主题渐变 */
      ov.style.backgroundImage = 'linear-gradient(160deg,' + cs.getPropertyValue('--bg-1').trim() + ',' +
        cs.getPropertyValue('--bg-2').trim() + ' 55%,' + cs.getPropertyValue('--bg-3').trim() + ')';
  }
  var full = 'circle(' + themeRippleCenter().r + 'px at ' + x + 'px ' + y + 'px)';
  var zero = 'circle(0px at ' + x + 'px ' + y + 'px)';
  ov.style.clipPath = full; ov.style.webkitClipPath = full;
  document.body.appendChild(ov);
  applyThemeSwitch(next);                                      /* 真实页面切换（被覆盖层盖住） */
  requestAnimationFrame(function(){ requestAnimationFrame(function(){
    ov.style.clipPath = zero; ov.style.webkitClipPath = zero;
    setTimeout(function(){ if(ov.parentNode) ov.parentNode.removeChild(ov); }, 540);
  });});
}

/* ---------- Animated Text Disclosure（手风琴，真实高度） ---------- */

function toggleDisclose(headEl){
  var sec = headEl.closest('.ui-sec'); if(!sec) return;
  var body = sec.querySelector('.ui-sec-b'); if(!body) return;
  var open = sec.classList.contains('open');
  if(open){
    /* 关：先把 auto 固定成实际高度，再 rAF 置 0，否则 auto→0 无过渡 */
    body.style.height = body.scrollHeight + 'px';
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){ body.style.height = '0px'; });
    });
    sec.classList.remove('open');
  }else{
    body.style.height = body.scrollHeight + 'px';
    sec.classList.add('open');
    var done = function(){ if(sec.classList.contains('open')) body.style.height = 'auto'; };
    if(motionOn()) setTimeout(done, 360); else done();
  }
  SFX.click();
}

/* ---------- Velocity-Based Slider Snap ---------- */

/* opts: { el, steps:[数值...], label(i)->文本, onInput(v), onCommit(v) } */
function makeSnapSlider(host, opts){
  if(!host) return;
  var steps = opts.steps, n = steps.length;
  var track = host.querySelector('.snap-line');
  var fill  = host.querySelector('.snap-fill');
  var thumb = host.querySelector('.snap-thumb');
  var cur   = opts.value != null ? opts.value : steps[0];
  var dragging = false, lastX = 0, lastT = 0, vel = 0, pw = 1;

  function nearestIdx(v){
    var best = 0, bd = Infinity;
    for(var i = 0; i < n; i++){ var d = Math.abs(steps[i] - v); if(d < bd){ bd = d; best = i; } }
    return best;
  }
  function posOf(v){
    var i = nearestIdx(v);
    /* 用档位序号定位，保证滑块与刻度一致 */
    return n > 1 ? (i / (n - 1)) : 0.5;
  }
  function render(v, snap){
    var p = posOf(v);
    host.classList.toggle('snapping', !!snap);
    var W = track ? track.clientWidth : 0;
    if(!pw) pw = W;
    if(fill) fill.style.width = (p * 100) + '%';
    if(thumb) thumb.style.left = (p * 100) + '%';
    var i = nearestIdx(v);
    Array.prototype.forEach.call(host.querySelectorAll('.snap-ticks i'), function(t, k){
      t.classList.toggle('on', k === i);
    });
    var vl = host.querySelector('.snap-val');
    if(vl && opts.label) vl.textContent = opts.label(i);
  }
  function setVal(v, snap, silent){
    cur = v; render(v, snap);
    if(!silent && opts.onInput) opts.onInput(v);
  }

  function xToVal(clientX){
    var r = track.getBoundingClientRect();
    var t = r.width ? (clientX - r.left) / r.width : 0;
    t = Math.max(0, Math.min(1, t));
    /* 连续插值（拖动时跟手），松手再吸附 */
    return steps[0] + t * (steps[n - 1] - steps[0]);
  }

  /* v3.9.10（站主）：iOS 13 以下没有 PointerEvent —— 字号滑块必须同时支持
     touch / mouse，否则「进度条拖不动」。这里把三种输入统一成 down/move/end。 */
  var hasPointer = !!window.PointerEvent;
  var activeId = null;
  function down(clientX, id){
    dragging = true; vel = 0; activeId = id;
    lastX = clientX; lastT = Date.now();
    host.classList.remove('snapping');   /* 拖动中禁用过渡，保证跟手 */
    setVal(xToVal(clientX), false, true);
  }
  function move(clientX, id){
    if(!dragging || id !== activeId) return;
    var now = Date.now(), dt = now - lastT;
    if(dt > 0){
      var v = (clientX - lastX) / dt;                /* px/ms */
      vel = vel * 0.7 + v * 0.3;                     /* 指数平滑 */
      lastX = clientX; lastT = now;
    }
    setVal(xToVal(clientX), false, true);
  }
  function end(clientX, id){
    if(!dragging || id !== activeId) return;
    dragging = false; activeId = null;
    var raw = xToVal(clientX);
    var i = nearestIdx(raw);
    if(Math.abs(vel) >= 0.15){                       /* 快速滑动 → 沿方向走一档 */
      i += (vel > 0 ? 1 : -1);
      i = Math.max(0, Math.min(n - 1, i));
    }
    setVal(steps[i], true, true);
    if(opts.onInput) opts.onInput(steps[i]);         /* 落定后正式提交 */
    if(opts.onCommit) opts.onCommit(steps[i]);
    if(motionOn()){ try{ navigator.vibrate && navigator.vibrate(8); }catch(_){} }
  }

  if(hasPointer){
    host.addEventListener('pointerdown', function(e){
      if(e.button != null && e.button !== 0) return;
      try{ host.setPointerCapture(e.pointerId); }catch(_){}
      down(e.clientX, e.pointerId);
      e.preventDefault();
    });
    host.addEventListener('pointermove', function(e){
      if(e.pointerId !== activeId) return;
      move(e.clientX, e.pointerId);
      if(dragging) e.preventDefault();
    });
    host.addEventListener('pointerup', function(e){ end(e.clientX, e.pointerId); });
    host.addEventListener('pointercancel', function(e){ end(e.clientX, e.pointerId); });
  }else{
    /* 老内核：touch + mouse 双通道 */
    host.addEventListener('touchstart', function(e){
      var t = e.changedTouches && e.changedTouches[0]; if(!t) return;
      down(t.clientX, 't');
      e.preventDefault();
    }, false);
    host.addEventListener('touchmove', function(e){
      var t = e.changedTouches && e.changedTouches[0]; if(!t) return;
      move(t.clientX, 't');
      if(dragging) e.preventDefault();
    }, false);
    host.addEventListener('touchend', function(e){
      var t = e.changedTouches && e.changedTouches[0]; if(t) end(t.clientX, 't'); else end(lastX, 't');
    }, false);
    host.addEventListener('touchcancel', function(e){
      var t = e.changedTouches && e.changedTouches[0];
      end(t ? t.clientX : lastX, 't');
    }, false);
    host.addEventListener('mousedown', function(e){
      if(e.button !== 0) return;
      down(e.clientX, 'm');
      e.preventDefault();
    }, false);
    document.addEventListener('mousemove', function(e){ if(dragging) move(e.clientX, 'm'); }, false);
    document.addEventListener('mouseup', function(e){ if(dragging) end(e.clientX, 'm'); }, false);
  }

  host.__snapRender = function(){ pw = 0; render(cur, false); };
  render(cur, false);
}

/* ---------- Drag-to-Reorder（通用拖拽排序） ---------- */

/* ⚠️ 三条硬约束：
   ① 让位动画只能用 transform，绝不在拖动中 insertBefore
      —— 拖动中改 DOM 会让浏览器反复重排，手感发涩
   ② 不能误触发卡片自身的 onclick（如 .card 的 openVideo）→ capture 阶段拦截
   ③ 不能误触发全局音效 → 由 __dragBlockClick 守卫（在音效监听里已加判断） */
var __dragBlockClick = false;

function attachSortable(container, opts){
  if(!container || container.__sortable) return;
  container.__sortable = 1;
  var LP = opts.longPress || 320, TH = 8, st = null;

  /* ② capture 阶段拦点击：先于目标元素的内联 onclick 执行 */
  container.addEventListener('click', function(e){
    if(__dragBlockClick){ e.stopPropagation(); e.preventDefault(); }
  }, true);
  /* 拾起后阻止页面滚动（touch-action 在手势已开始后不再生效，只能 preventDefault） */
  document.addEventListener('touchmove', function(e){
    if(st && st.picked) e.preventDefault();
  }, { passive:false });

  function rows(){ return Array.prototype.slice.call(container.querySelectorAll(opts.item)); }
  function gapOf(boxes){
    if(boxes.length < 2) return 8;
    return Math.max(0, boxes[1].top - (boxes[0].top + boxes[0].h));
  }
  function clearT(all){
    all.forEach(function(el){ el.style.transition = ''; el.style.transform = ''; });
  }
  function pick(){
    var s = st; if(!s) return;
    s.picked = true;
    s.boxes = s.sibs.map(function(el){
      var r = el.getBoundingClientRect();
      return { top:r.top, h:r.height, mid:r.top + r.height / 2 };
    });
    s.item.classList.add('dragging');
    container.classList.add('sorting');
    if(motionOn()){ try{ navigator.vibrate && navigator.vibrate(12); }catch(_){} }
    SFX.pop();
  }
  function move(dy){
    var s = st; if(!s) return;
    s.item.style.transform = 'translateY(' + dy + 'px) scale(1.03)';
    var c = s.boxes[s.from].mid + dy, to = s.from, i;
    for(i = 0; i < s.boxes.length; i++){
      if(i === s.from) continue;
      if(i < s.from && c < s.boxes[i].mid) to = Math.min(to, i);
      if(i > s.from && c > s.boxes[i].mid) to = Math.max(to, i);
    }
    var h = s.boxes[s.from].h + gapOf(s.boxes);
    for(i = 0; i < s.sibs.length; i++){
      var el = s.sibs[i]; if(el === s.item) continue;
      var sh = 0;
      if(s.from < to && i > s.from && i <= to) sh = -h;
      else if(s.from > to && i >= to && i < s.from) sh = h;
      el.style.transform = sh ? 'translateY(' + sh + 'px)' : '';
    }
    s.to = to;
  }
  function drop(s){
    __dragBlockClick = true;
    setTimeout(function(){ __dragBlockClick = false; }, 360);
    var keys = s.sibs.map(opts.key);
    var d = motionOn() ? 290 : 0;
    s.sibs.forEach(function(el){
      el.style.transition = 'transform .28s var(--ease-out)';
      el.style.transform = '';
    });
    s.item.classList.remove('dragging');
    container.classList.remove('sorting');
    setTimeout(function(){
      clearT(s.sibs);
      if(s.to !== s.from){
        var moved = keys[s.from];
        keys.splice(s.from, 1); keys.splice(s.to, 0, moved);
        SFX.success();
      }
      opts.commit(keys);
    }, d);
  }
  function end(e){
    if(!st || (e.pointerId != null && e.pointerId !== st.pid)) return;
    clearTimeout(st.timer);
    var s = st; st = null;
    if(s.picked) drop(s);
  }

  container.addEventListener('pointerdown', function(e){
    if(e.button != null && e.button !== 0) return;
    var item = e.target.closest && e.target.closest(opts.item); if(!item) return;
    if(opts.handle && !(e.target.closest && e.target.closest(opts.handle))) return;
    if(e.target.closest && e.target.closest('button')) return;   /* ▲▼ 按钮不参与拖拽 */
    var sibs = rows();
    st = { item:item, sibs:sibs, from:sibs.indexOf(item), to:sibs.indexOf(item),
           y0:e.clientY, x0:e.clientX, pid:e.pointerId, picked:false };
    try{ item.setPointerCapture(e.pointerId); }catch(_){}
    st.timer = setTimeout(pick, LP);
  });
  container.addEventListener('pointermove', function(e){
    if(!st || e.pointerId !== st.pid) return;
    var dy = e.clientY - st.y0, dx = e.clientX - st.x0;
    if(!st.picked){
      if(Math.abs(dy) > TH || Math.abs(dx) > TH){ clearTimeout(st.timer); st = null; }  /* 判为滚动，放弃 */
      return;
    }
    if(e.cancelable) e.preventDefault();
    move(dy);
  });
  container.addEventListener('pointerup', end);
  container.addEventListener('pointercancel', end);
  container.addEventListener('lostpointercapture', end);
}

/* ---------- 排序数据提交 ---------- */

function commitOrder(group, catId){
  return function(keys){
    if(group === 'card') UI.order.card[catId] = keys;
    else UI.order[group] = keys;
    saveUI();
    rerenderAll();
    renderSortList(group, catId);
  };
}
function curKeys(group, catId){
  var arr;
  if(group === 'card') arr = uiLinks(catId);
  else if(group === 'cat') arr = uiCats();
  else if(group === 'game') arr = uiGames();
  else if(group === 'annCat') arr = uiAnnCats(ANN_CATS);
  else if(group === 'home') return (UI.order.home || []).slice();
  else arr = [];
  return arr.map(function(x){
    if(group === 'game') return x.url;
    if(group === 'cat') return x.id;
    if(group === 'card') return x.id;
    return x.key;
  });
}
function sortStep(group, catId, idx, dir){
  var keys = curKeys(group, catId);
  /* 首次操作时把当前实际顺序落进配置（避免 UI.order 为空导致失效） */
  if(group === 'card') UI.order.card[catId] = keys; else UI.order[group] = keys;
  var j = idx + dir;
  if(j < 0 || j >= keys.length) return;
  var t = keys[idx]; keys[idx] = keys[j]; keys[j] = t;
  saveUI();
  rerenderAll();
  renderSortList(group, catId);
  SFX.click();
}

/* ---------- 开关（含涟漪） ---------- */

function swHtml(on, onclick) {
  return '<button type="button" class="sw' + (on ? ' on' : '') + '" role="switch" aria-checked="' + (on ? 'true' : 'false') +
         '" onclick="' + onclick + '"><span class="rip"></span></button>';
}
/* 在指针处播涟漪。ev 可空（则用圆心） */
function rippleOn(btn, ev){
  if(!btn || !motionOn()) return;
  var rip = btn.querySelector('.rip'); if(!rip) return;
  try{
    var r = btn.getBoundingClientRect();
    var x = (ev && ev.clientX) ? (ev.clientX - r.left) : r.width / 2;
    var y = (ev && ev.clientY) ? (ev.clientY - r.top)  : r.height / 2;
    rip.style.left = x + 'px'; rip.style.top = y + 'px';
  }catch(e){}
  btn.classList.remove('ripping');
  void btn.offsetWidth;                  /* 强制回流以重启动画 */
  btn.classList.add('ripping');
  setTimeout(function(){ btn.classList.remove('ripping'); }, 520);
}

/* ---------- 设置面板 ---------- */

var UI_SEC = 'look';

function openSettings(){
  var busy = document.querySelector('.allboard-mask.show');
  if(busy && busy.id !== 'uiSetMask'){ busy.classList.remove('show'); }
  var m = document.getElementById('uiSetMask');
  if(!m) return;
  renderSettings();
  m.classList.add('show');
  SFX.pop();
}
function closeSettings(){
  var m = document.getElementById('uiSetMask'); if(m) m.classList.remove('show');
}
function uiSec(k){
  UI_SEC = k;
  Array.prototype.forEach.call(document.querySelectorAll('.ui-tab'), function(t){
    t.classList.toggle('active', t.getAttribute('data-sec') === k);
  });
  renderSettings();
  SFX.click();
}
function uiMsg(t, color){
  var el = document.getElementById('uiMsg'); if(!el) return;
  /* v2.5.0：纯文本提示条放不下 SVG，统一去 emoji，只留文字（读起来更干净）。 */
  el.textContent = typeof stripEmoji === 'function' ? stripEmoji(t || '') : (t || '');
  el.style.color = color || '#0a7d42';
  if(t) setTimeout(function(){ if(el.textContent === t) el.textContent = ''; }, 4000);
}

function secHtml(key, title, ico, inner, open){
  return '<div class="ui-sec' + (open ? ' open' : '') + '">' +
    '<button class="ui-sec-h" onclick="toggleDisclose(this)">' + iconSvg(ico, 14) + '<span>' + title + '</span>' +
    '<span class="chev">' + iconSvg('chevron-down', 14) + '</span></button>' +
    '<div class="ui-sec-b"' + (open ? ' style="height:auto"' : '') + '><div class="ui-sec-in">' + inner + '</div></div>' +
  '</div>';
}

function renderSettings(){
  var box = document.getElementById('uiSetBody'); if(!box) return;
  var html = '';
  if(UI_SEC === 'look'){
    /* —— 主题自动切换（v2.5.3 站主要求：三选一 + 跟随系统/日出日落）—— */
    var tmode = themeAutoMode();
    var modeBtns = [
      ['off',    '关闭自动',     '手动切换亮色 / 暗色'],
      ['system', '跟随系统',     '系统开深色就自动变暗'],
      ['sun',    '跟随日出日落', '按当地真实日出日落自动切换'],
    ].map(function(m){
      return '<button class="btn ' + (tmode === m[0] ? '' : 'btn-secondary') + '" ' +
        'style="flex:1;font-size:.74rem;padding:9px 4px" ' +
        'onclick="setThemeAutoMode(\'' + m[0] + '\')">' + m[1] + '</button>';
    }).join('');
    var sunHint = '';
    if(tmode === 'sun'){
      var s = sunTimes();
      var f2 = function(h){ var hh = Math.floor(h), mm = Math.round((h - hh) * 60);
        if(mm === 60){ hh++; mm = 0; } return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm; };
      var srcTxt = (s.src === 'api') ? '联网查询' : '本地天文计算（联网后会校正）';
      sunHint = '<p class="ui-hint" style="margin-top:8px">今天：日出 ' + f2(s.rise) + ' · 日落 ' + f2(s.set)
              + '<br>数据来源：' + srcTxt + '</p>';
    } else if(tmode === 'system'){
      sunHint = '<p class="ui-hint" style="margin-top:8px">系统当前偏好：'
              + (isSystemDark() ? '深色' : '浅色') + '</p>';
    }
    html += secHtml('tauto', '主题自动切换', 'moon',
      '<div class="ui-modes">' + modeBtns + '</div>' +
      '<p class="ui-hint">决定打开站点时用亮色还是暗色。<br>'
      + '「跟随日出日落」会联网查询当地日出日落时间（失败时用本地计算，离线也能用）。</p>'
      + sunHint, true);

    /* —— 字号（速度吸附滑块） —— */
    var fsIdx = 0, bd = Infinity;
    for(var i = 0; i < UI_FS_STEPS.length; i++){
      var d2 = Math.abs(UI_FS_STEPS[i] - UI.fs);
      if(d2 < bd){ bd = d2; fsIdx = i; }
    }
    var ticks = UI_FS_STEPS.map(function(v, k){
      var p = UI_FS_STEPS.length > 1 ? (k / (UI_FS_STEPS.length - 1) * 100) : 50;
      return '<i class="' + (k === fsIdx ? 'on' : '') + '" style="left:' + p + '%">' + Math.round(v * 100) + '%</i>';
    }).join('');
    var pct = UI_FS_STEPS.length > 1 ? (fsIdx / (UI_FS_STEPS.length - 1) * 100) : 50;
    html += secHtml('font','字体大小','type',
      '<div class="snap" id="snapFs">' +
        '<div class="snap-track"><div class="snap-line">' +
          '<div class="snap-fill" style="width:' + pct + '%"></div>' +
          '<div class="snap-thumb" style="left:' + pct + '%"></div>' +
        '</div></div>' +
        '<div class="snap-ticks">' + ticks + '</div>' +
        '<div class="snap-val">当前 ' + Math.round(UI.fs * 100) + '%</div>' +
      '</div>' +
      '<p class="ui-hint">只缩放文字，不影响卡片与间距。</p>', true);

    /* —— 每日一言来源（v3.5.6 新增；v3.5.9 改为后台统一控制）——
       站主反馈「后台的首页卡片里面没有改」：来源应该由站主在后台定，
       不该让每个同学各选各的。这里只展示当前状态，不给切换按钮。 */
    var qNetOn = (typeof quoteNetAllowed === 'function') ? quoteNetAllowed() : true;
    html += secHtml('quote','每日一言','message-circle',
      '<div class="ui-modes">'
      + '<button class="btn" style="flex:1;font-size:.74rem;padding:9px 4px;opacity:1;cursor:default">'
      + (qNetOn ? '联网 API（当前）' : '本地库（当前）') + '</button>'
      + '</div>' +
      '<p class="ui-hint">内容来源由管理员在后台「首页卡片 → 每日一言」统一设置，'
      + '全班一致。（' + (qNetOn ? '现在从 hitokoto 公共文库随机取句，连不上自动回退本地库' : '现在只用管理员配的句子，不联网') + '）</p>', false);

    /* —— 学习卡片（v3.5.9 恢复显示 + 手动隐藏入口）—— */
    if(typeof STUDY_CARD_ENABLED !== 'undefined' && STUDY_CARD_ENABLED){
      html += secHtml('study','学习卡片','inbox',
        '<div class="ui-modes">'
        + '<button class="btn ' + (studyHidden() ? 'btn-secondary' : '') + '" style="flex:1;font-size:.74rem;padding:9px 4px" '
        + 'onclick="' + (studyHidden() ? 'showStudyCard()' : 'hideStudyCard()') + '">'
        + (studyHidden() ? '已隐藏 · 点此恢复' : '显示中 · 点此隐藏') + '</button>'
        + '</div>' +
        '<p class="ui-hint">首页每刷新一次随机出一条（知识点 / 每日一词 / 古诗文 / 每日一题）。'
        + '不想看可以隐藏，内容类型由管理员在后台「首页卡片」配置。</p>', false);
    }

    /* —— 背景 —— */
    var btypes = [['theme','跟随主题'],['solid','纯色'],['grad','渐变'],['image','图片']];
    var typeHtml = btypes.map(function(t){
      return '<button class="ui-tab' + (UI.bg.type === t[0] ? ' active' : '') + '" style="flex:1;font-size:.72rem" ' +
        'onclick="setBgType(\'' + t[0] + '\')">' + t[1] + '</button>';
    }).join('');
    var swatches = '';
    swatches += '<p class="ui-hint" style="margin-top:6px">纯色</p><div class="ui-swatches">';
    swatches += UI_COLORS.map(function(c){
      return '<button class="ui-sw' + (UI.bg.type === 'solid' && UI.bg.color === c ? ' on' : '') +
        '" style="background:' + c + '" title="' + c + '" onclick="setBgColor(\'' + c + '\')">' +
        '<span class="tick">' + iconSvg('check', 14) + '</span></button>';
    }).join('') + '</div>';
    swatches += '<p class="ui-hint" style="margin-top:8px">渐变</p><div class="ui-swatches">';
    swatches += UI_GRADS.map(function(g, k){
      return '<button class="ui-sw' + (UI.bg.type === 'grad' && UI.bg.grad === g.v ? ' on' : '') +
        '" style="background:' + g.v + '" title="' + g.n + '" onclick="setBgGrad(' + k + ')">' +
        '<span class="tick">' + iconSvg('check', 14) + '</span></button>';
    }).join('') + '</div>';
    var veilPct = UI.bg.veil;
    html += secHtml('bg','背景','palette',
      '<div style="display:flex;gap:6px;margin:2px 0 6px">' + typeHtml + '</div>' +
      swatches +
      '<p class="ui-hint" style="margin-top:10px">上传本地图片（自动压缩，仅存本机）</p>' +
      '<input type="file" id="bgFile" accept="image/*" onchange="pickBgImage(this)" ' +
        'style="font-size:.74rem;width:100%;color:var(--fg-3)">' +
      '<div class="ui-row"><span class="lb">蒙层</span>' +
        '<input type="range" min="0" max="100" step="5" value="' + veilPct + '" style="flex:1" ' +
        'oninput="setBgVeil(this.value)"></div>' +
      '<p class="ui-hint">图片看不清文字时，调高蒙层即可。已设：' + veilPct +
        '<br>选到深色 / 深色渐变会自动切到夜间模式，选回浅色自动切回日间。</p>', false);
  }
  else if(UI_SEC === 'order'){
    html += '<p class="ui-hint">长按左侧把手拖动，或用 ▲▼ 微调。改动只影响你自己的设备。</p>';
    html += '<div id="uiSortBox"></div>';
  }
  else if(UI_SEC === 'motion'){
    html += secHtml('mo','动效','sliders-horizontal',
      '<div class="sw-row"><span class="t">完整动效<span class="s">拖拽、涟漪、圆形主题切换等</span></span>' +
        swHtml(UI.motion !== 0, 'toggleMotion(event)') + '</div>' +
      '<div class="sw-row"><span class="t">卡片堆叠（测试中）<span class="s">同一板块的多个入口层叠展示，可点 ↑↓ 上下轮换。效果还在试验，可能随时调整</span></span>' +
        swHtml(UI.stack !== 0, 'toggleStack(event)') + '</div>' +
      '<div class="sw-row"><span class="t">网络状态提示<span class="s">连不上服务器时，页面顶部弹一条提示并可点「重试」。<b>当前默认关闭</b> —— 关了不影响任何功能，也不影响后台的在线状态</span></span>' +
        swHtml(netWatchOn(), 'toggleNetWatch(event)') + '</div>' +
      '<p class="ui-hint">关闭后所有动效立即静止（跟随系统的「减少动态效果」设置也同理）。<br>「卡片堆叠」是试验功能，默认关闭，觉得不好用可随时关掉。</p>', true);
    html += secHtml('sfx','音效','droplet',
      '<div class="sw-row"><span class="t">界面音效<span class="s">点击、成功、错误提示音</span></span>' +
        swHtml(SFX.isOn(), 'toggleSfxFromUI(event)') + '</div>', false);

    /* —— 性能 / 轻量模式（v3.5.30，v3.5.31 改为纯手动）——
       站主明确要求「由我手动更改，没有自动检测」，所以这里只有两档：
       轻量 / 完整，选完立刻生效并落盘，换设备也记住。 */
    var liteOnNow = liteOn();
    var liteBtns = [
      ['off',  '完整', '全部特效：玻璃模糊、背景光斑、扫光'],
      ['on',   '轻量', '关掉玻璃模糊 / 光斑 / 扫光 / 入场动画'],
    ].map(function(m){
      var active = (m[0] === 'on') === liteOnNow;
      return '<button class="btn ' + (active ? '' : 'btn-secondary') + '" ' +
        'style="flex:1;font-size:.76rem;padding:10px 4px" ' +
        'onclick="setLiteMode(\'' + m[0] + '\')">' + m[1] + '</button>';
    }).join('');
    html += secHtml('perf','性能 / 轻量模式','activity',
      '<div class="ui-modes">' + liteBtns + '</div>' +
      '<p class="ui-hint" style="margin-top:10px">当前：<b>' + (liteOnNow ? '轻量模式' : '完整特效') + '</b>'
      + '　<span style="opacity:.75">· 已记在这台设备上，升级新版本不会自己变回去</span></p>' +
      '<p class="ui-hint">轻量模式会关掉：<br>'
      + '· 玻璃模糊、背景光斑漂移、卡片流光、入场动画<br>'
      + '· 听力播放器的唱片旋转与波形跳动（播放/倍速/拖动都正常）<br>'
      + '· 作业里视频的预加载（点播放才开始加载）<br>'
      + '画面不那么「透」，但滚动、切板块、听听力会明显跟手。'
      + '<b>iPad / iPhone 或打开就卡，选「轻量」</b>；高端手机看着很顺就选「完整」。</p>', false);
  }
  else {
    /* 云端数据入口（v2.10.1 需求⑧）：数据类操作统一收在「自定义设置」里，
       和下面的导出/导入放一起。未登录时先引导登录（云端接口要登录才给读）。 */
    html += secHtml('cloud','云端数据','database',
      '<p class="ui-hint">查看云端同步了哪些数据（主题、作业勾选、班级签、点歌记录等），<br>可以按条删除或清空全部。删除前需要验证登录密码。</p>' +
      '<button class="btn" style="font-size:.76rem;padding:9px 12px" onclick="openCloudDataFromSettings()">查看我的云端数据</button>', true);
    html += secHtml('io','导出与导入','download',
      '<p class="ui-hint"><b>自定义设置只存在这台设备的浏览器里，不同步云端</b>（每台设备屏幕和习惯不同，各配各的）。<br>'
      + '换设备 / 换浏览器 / 清了数据后想搬过去，用下面的导出导入手动搬。<br>'
      + '配置文件包含：字号、背景、动效开关、轻量模式、每日一言来源、全部排序；不含游戏记录与个人数据。</p>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn" style="flex:1;min-width:100px;font-size:.76rem;padding:9px 6px" onclick="exportUICfg(false)">导出配置</button>' +
        '<button class="btn btn-secondary" style="flex:1;min-width:100px;font-size:.76rem;padding:9px 6px" onclick="exportUICfg(true)">含背景图</button>' +
        '<button class="btn btn-secondary" style="flex:1;min-width:100px;font-size:.76rem;padding:9px 6px" onclick="openUiImport()">导入配置</button>' +
      '</div>', true);
    html += secHtml('rs','恢复默认','rotate-ccw',
      '<p class="ui-hint">把所有自定义项还原成初始状态，<b>只影响这台设备</b>，不影响公告、作业、游戏记录，也不影响其他设备。</p>' +
      '<button class="btn btn-gray" style="font-size:.76rem;padding:9px 12px" onclick="resetUICfg()">恢复默认设置</button>', false);
    /* v2.6.4 新增：站主反馈 iPhone 上刷新不管用、一直停在旧版本。
       这里给出「当前 / 线上」两个版本号，并提供一键强制刷新。
       默认**展开**（open=true）—— 找进来的多半就是「刷不出版本」的人，
       让他少点一步。 */
    html += secHtml('up','版本与更新（v' + SITE_VERSION + '）','rotate-cw',
      '<div class="up-row"><span class="k">当前版本</span>' +
        '<span class="v" id="upCur">v' + SITE_VERSION + '</span></div>' +
      '<div class="up-row"><span class="k">线上版本</span>' +
        '<span class="v" id="upOnline">点「检查更新」获取</span></div>' +
      '<p class="ui-hint">页面会自动检查更新。手机上如果一直显示旧版本，' +
        '先点「强制刷新」；还是不行就把页面<b>完全关掉</b>再重新打开一次' +
        '（下拉刷新不一定管用）。</p>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn" style="flex:1;min-width:110px;font-size:.76rem;padding:9px 6px" ' +
          'onclick="checkUpdateFromSettings()">检查更新</button>' +
        '<button class="btn btn-secondary" style="flex:1;min-width:110px;font-size:.76rem;padding:9px 6px" ' +
          'onclick="hardRefresh()">强制刷新</button>' +
      '</div>', true);
  }
  box.innerHTML = html;

  if(UI_SEC === 'look'){
    var host = document.getElementById('snapFs');
    if(host) makeSnapSlider(host, {
      steps: UI_FS_STEPS, value: UI.fs,
      label: function(i){ return '当前 ' + Math.round(UI_FS_STEPS[i] * 100) + '%'; },
      onInput: function(v){ UI.fs = v; saveUI(); applyFont(); }
    });
  }
  if(UI_SEC === 'order') renderSortList();
  /* v2.5.0 起已无运行时 emoji 引擎（图标都在渲染时就地生成），无需任何触发 */
}

/* ---------- 设置面板里的「检查更新」（v2.6.4） ----------
   把结果写回面板那两行，不用去页脚看。 */
function checkUpdateFromSettings(){
  var el = document.getElementById('upOnline');
  if(el){ el.textContent = '检查中…'; el.className = 'v'; }
  withTimeout(fetchOnlineSiteVersion(), 6000, '').then(function(v){
    var e2 = document.getElementById('upOnline');
    if(!e2) return;
    if(!v){ e2.textContent = '查询失败（可能没网）'; e2.className = 'v'; return; }
    if(cmpVer(v, SITE_VERSION) > 0){
      e2.textContent = 'v' + v + ' ← 有新版，请点「强制刷新」';
      e2.className = 'v new';
      SW_HAS_UPDATE = true;
      SW_NEW_VER = v;
      paintVersion();               /* 页脚同步切成「点击立即更新」 */
      if(typeof uiMsg === 'function') uiMsg('发现新版本 v' + v + '，请点「强制刷新」', '#b45309');
    } else {
      e2.textContent = 'v' + v + '（已是最新）';
      e2.className = 'v';
    }
  });
  swCheckUpdate(false);             /* 顺手也催一次 SW */
}

/* ---------- 排序列表渲染 ---------- */

function renderSortList(group, catId){
  var box = document.getElementById('uiSortBox'); if(!box) return;
  var html = '';

  /* 分组切换（板块内卡片需要先选板块） */
  html += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 2px">' +
    '<button class="ui-tab' + (SORT_G === 'home'   ? ' active' : '') + '" style="flex:0 0 auto;padding:7px 10px" onclick="sortTab(\'home\')">首页</button>' +
    '<button class="ui-tab' + (SORT_G === 'cat'    ? ' active' : '') + '" style="flex:0 0 auto;padding:7px 10px" onclick="sortTab(\'cat\')">侧栏</button>' +
    '<button class="ui-tab' + (SORT_G === 'card'   ? ' active' : '') + '" style="flex:0 0 auto;padding:7px 10px" onclick="sortTab(\'card\')">卡片</button>' +
    '<button class="ui-tab' + (SORT_G === 'game'   ? ' active' : '') + '" style="flex:0 0 auto;padding:7px 10px" onclick="sortTab(\'game\')">小游戏</button>' +
    '<button class="ui-tab' + (SORT_G === 'annCat' ? ' active' : '') + '" style="flex:0 0 auto;padding:7px 10px" onclick="sortTab(\'annCat\')">公告分类</button>' +
  '</div>';

  if(SORT_G === 'card'){
    var cats = uiCats();
    html += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 2px">' + cats.map(function(c){
      return '<button class="ui-tab' + (SORT_CAT === c.id ? ' active' : '') + '" style="flex:0 0 auto;padding:6px 9px;font-size:.72rem" ' +
        'onclick="sortTab(\'card\',' + c.id + ')">' + esc(c.name) + '</button>';
    }).join('') + '</div>';
  }

  var items = [], keys = [];
  if(SORT_G === 'home'){
    var label = { ann:'公告栏', quote:'每日一言', sign:'今日班级签', daily:'每日日报', study:'学习卡片', countdown:'倒计时' };
    var ord = (UI.order.home || []).slice();
    uiDefault().order.home.forEach(function(k){ if(ord.indexOf(k) < 0) ord.push(k); });
    items = ord.map(function(k){ return { key:k, title:label[k] || k, ico:'list' }; });
  }else if(SORT_G === 'cat'){
    items = uiCats().map(function(c){ return { key:c.id, title:c.name, ico:'list' }; });
  }else if(SORT_G === 'card'){
    items = uiLinks(SORT_CAT).map(function(l){ return { key:l.id, title:l.title, ico:'list' }; });
  }else if(SORT_G === 'game'){
    items = uiGames().map(function(g){ return { key:g.url, title:g.title, ico:'list' }; });
  }else{
    var nm = { site:'网站内部', activity:'重要更新', class:'班级事务', misc:'站主杂谈' };
    items = uiAnnCats(ANN_CATS).filter(function(c){ return c.key !== 'all'; })
      .map(function(c){ return { key:c.key, title:nm[c.key] || c.name, ico:'list' }; });
  }

  if(!items.length){
    html += '<p class="ui-hint" style="padding:14px 0">这里暂无可排序的内容。</p>';
    box.innerHTML = html;
    return;
  }

  var cid = (SORT_G === 'card') ? SORT_CAT : null;
  var listId = 'sortList';
  html += '<div class="sort-list" id="' + listId + '">' + items.map(function(it, i){
    return '<div class="sort-row" data-key="' + esc(String(it.key)) + '">' +
      '<span class="sort-grip">' + iconSvg('grip-vertical', 15) + '</span>' +
      '<span class="sort-title">' + esc(it.title) + '</span>' +
      '<button class="sort-mv" ' + (i === 0 ? 'disabled' : '') + ' onclick="sortStep(\'' + SORT_G + '\',' + cid + ',' + i + ',-1)" aria-label="上移">' + iconSvg('chevron-up', 13) + '</button>' +
      '<button class="sort-mv" ' + (i === items.length - 1 ? 'disabled' : '') + ' onclick="sortStep(\'' + SORT_G + '\',' + cid + ',' + i + ',1)" aria-label="下移">' + iconSvg('chevron-down', 13) + '</button>' +
    '</div>';
  }).join('') + '</div>';
  box.innerHTML = html;

  attachSortable(document.getElementById(listId), {
    item: '.sort-row',
    handle: '.sort-grip',
    key: function(el){ return el.getAttribute('data-key'); },
    commit: commitOrder(SORT_G, cid)
  });
}

var SORT_G = 'home', SORT_CAT = null;

function sortTab(g, catId){
  SORT_G = g;
  if(g === 'card'){
    if(catId != null) SORT_CAT = catId;
    else if(SORT_CAT == null){ var cs = uiCats(); SORT_CAT = cs.length ? cs[0].id : null; }
  }
  renderSortList();
  SFX.click();
}

/* ---------- 外观设置的操作 ---------- */

function setBgType(t){
  UI.bg.type = t;
  if(t === 'image' && !getBgImg()){ uiMsg('请先在下方选择一张本地图片', '#af410f'); UI.bg.type = 'theme'; }
  if(t === 'grad' && !UI.bg.grad) UI.bg.grad = UI_GRADS[0].v;
  saveUI(); applyBg(); renderSettings();
  SFX.click();
}

/* v3.5.6 每日一言来源：1 = 联网 hitokoto，0 = 只用本地库。
   切到本地时把已拿到的联网句子丢掉，立刻重绘成本地那句。 */
function setQuoteNet(m){
  UI.quoteNet = (m === 0) ? 0 : 1;
  if(UI.quoteNet === 0) _quoteRemote = null;
  saveUI(); renderSettings();
  if(typeof renderDailyQuote === 'function') renderDailyQuote();
  SFX.click();
}
function setBgColor(c){ UI.bg.type = 'solid'; UI.bg.color = c; saveUI(); syncThemeToBg(); applyBg(); renderSettings(); SFX.click(); }
function setBgGrad(k){ UI.bg.type = 'grad'; UI.bg.grad = UI_GRADS[k].v; saveUI(); syncThemeToBg(); applyBg(); renderSettings(); SFX.click(); }
function setBgVeil(v){ UI.bg.veil = Number(v) || 0; saveUI(); applyBg(); }

function pickBgImage(input){
  var f = input.files && input.files[0]; if(!f) return;
  if(f.size > 8 * 1024 * 1024){ uiMsg('图片大于 8MB，请换一张小一点的', '#af410f'); input.value = ''; return; }
  var rd = new FileReader();
  rd.onload = function(){
    var img = new Image();
    img.onload = function(){
      try{
        var MAX = 1280, w = img.width, h = img.height;
        if(w > MAX){ h = Math.round(h * MAX / w); w = MAX; }
        var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        var out = cv.toDataURL('image/jpeg', 0.72);      /* 1280 + 0.72 ≈ 150~400KB */
        localStorage.setItem(UI_BG_KEY, out);
      }catch(e){
        uiMsg('本机存储空间不足，图片背景未能保存', '#af410f'); input.value = ''; return;
      }
      UI.bg.type = 'image'; saveUI(); applyBg(); renderSettings();
      uiMsg('✅ 背景图已应用');
      SFX.success();
    };
    img.onerror = function(){ uiMsg('图片读取失败', '#af410f'); };
    img.src = String(rd.result);
  };
  rd.readAsDataURL(f);
  input.value = '';
}

/** v3.5.30：切换轻量模式（'auto' / 'on' / 'off'）
 *  · auto → UI.lite = null（每次按设备能力判断，不落用户偏好）
 *  · on   → UI.lite = 1
 *  · off  → UI.lite = 0
 *  切换后立刻 applyLite()，不用刷新页面。 */
function setLiteMode(m){
  UI.lite = (m === 'on') ? 1 : 0;
  writeLitePref(UI.lite);      /* 设备级记忆：跨版本永不回退 */
  saveUI();
  applyLite();
  renderSettings();
  uiMsg(UI.lite === 1 ? '已切到轻量模式：玻璃模糊与重动画已关闭'
                      : '已切到完整特效');
  if(typeof SFX !== 'undefined' && SFX.click) SFX.click();
}

function toggleMotion(ev){
  UI.motion = (UI.motion === 0) ? 1 : 0;
  saveUI();
  document.documentElement.setAttribute('data-motion', UI.motion ? 'on' : 'off');
  var btn = ev && ev.target && ev.target.closest ? ev.target.closest('.sw') : null;
  if(UI.motion) rippleOn(btn, ev);
  else if(btn) btn.classList.remove('ripping');
  renderSettings();
  SFX.click();
}

/* 【卡片堆叠 v35】开关：切换「层叠展示」与「传统平铺」，立即重渲染生效 */
function toggleStack(ev){
  UI.stack = (UI.stack === 0) ? 1 : 0;
  saveUI();
  STACK_OPEN = {};                        /* 切换模式时清掉展开记忆，回到默认堆叠态 */
  var btn = ev && ev.target && ev.target.closest ? ev.target.closest('.sw') : null;
  rippleOn(btn, ev);
  rerenderAll();                          /* 重渲染分类卡片，让堆叠/平铺立即生效 */
  renderSettings();
  SFX.click();
  /* 这个功能还在试验中、观感不稳定，默认关闭。用户主动打开时如实提醒一句。 */
  if(UI.stack === 1){
    uiMsg('⚠️ 卡片堆叠还在测试中，效果不太理想，随时可能调整或去掉', '#af410f');
  }else{
    uiMsg('已恢复平铺');
  }
}

/* 【网络状态提示】开关：默认关（站主 2026-10-15「网络检测暂时关闭」）。
   打开 = 恢复「连不上服务器就弹横幅 + 倒计时重试」；关闭 = 只是不打扰用户，功能一切照旧。 */
function toggleNetWatch(ev){
  UI.netWatch = netWatchOn() ? 0 : 1;
  saveUI();
  var btn = ev && ev.target && ev.target.closest ? ev.target.closest('.sw') : null;
  rippleOn(btn, ev);
  /* 关掉的时候顺手把可能正显示着的横幅收起来，别留一条挂着 */
  if(!UI.netWatch && typeof setOfflineBanner === 'function'){ stopRetry(); setOfflineBanner(false); }
  renderSettings();
  SFX.click();
  uiMsg(UI.netWatch ? '已开启网络状态提示' : '已关闭网络状态提示');
}

function toggleSfxFromUI(ev){
  toggleSfx();                                  /* 复用现有实现（含持久化与文案） */
  var btn = ev && ev.target && ev.target.closest ? ev.target.closest('.sw') : null;
  rippleOn(btn, ev);
  setTimeout(function(){ renderSettings(); }, 30);
}

/* ---------- 导出 / 导入 ---------- */

function buildCfgPayload(withImg){
  var o = {
    app: 'class-site-ui-config',
    v: UI_V,
    exportedAt: new Date().toISOString(),
    settings: JSON.parse(JSON.stringify(UI))
  };
  if(withImg){ var s = getBgImg(); if(s) o.bgImage = s; }
  return o;
}
function exportUICfg(withImg){
  try{
    _dlJSON(JSON.stringify(buildCfgPayload(withImg), null, 1),
      'class-site-settings-' + new Date().toISOString().slice(0, 10) + '.json');
    uiMsg('✅ 配置已导出' + (withImg ? '（含背景图）' : '（不含背景图）'));
    SFX.success();
  }catch(e){ uiMsg('❌ 导出失败', '#af410f'); }
}

function mergeOrder(mine, inc){
  var out = [], seen = {}, i, k;
  for(i = 0; i < (inc  || []).length; i++){ k = String(inc[i]);  if(!seen[k]){ out.push(k); seen[k] = 1; } }
  for(i = 0; i < (mine || []).length; i++){ k = String(mine[i]); if(!seen[k]){ out.push(k); seen[k] = 1; } }
  return out;
}

function applyUICfgObj(o, mode){
  if(!o || (o.app && o.app !== 'class-site-ui-config')){ uiMsg('❌ 这不是本站的配置文件', '#af410f'); return false; }
  var s = normalizeUI(o.settings || o);
  if(mode === 'replace'){
    UI = s;
  }else{
    UI.fs = s.fs; UI.motion = s.motion;
    /* 背景：仅当导入文件里确实指定了非默认背景才覆盖，避免把本机背景冲掉 */
    var def = uiDefault();
    if(s.bg && (s.bg.type !== def.bg.type || s.bg.color !== def.bg.color ||
                s.bg.grad !== '' || s.bg.veil !== def.bg.veil)){
      UI.bg = s.bg;
    }
    ['home','cat','game','annCat'].forEach(function(k){
      UI.order[k] = mergeOrder(UI.order[k], s.order[k]);
    });
    for(var c in s.order.card){
      UI.order.card[c] = mergeOrder(UI.order.card[c] || [], s.order.card[c]);
    }
  }
  if(o.bgImage){
    try{ localStorage.setItem(UI_BG_KEY, o.bgImage); }catch(e){}
  }
  saveUI();
  syncThemeToBg();      /* 导进来的背景若偏深/偏亮，顺手把昼夜模式对上 */
  applyUICfg();
  rerenderAll();
  return true;
}

function doImportUICfg(text, mode){
  var o = null;
  try{ o = JSON.parse(text); }catch(e){ uiMsg('❌ 配置格式不正确', '#af410f'); return; }
  if(o && o.v === 2 && typeof o.alg === 'string' && o.alg.indexOf('AES-GCM') >= 0){
    if(!cryptoOK()){ uiMsg('❌ 加密配置，当前环境不支持解密', '#af410f'); return; }
    askDataEnc('import', function(pw){
      decPayload(o, pw).then(function(p){ 
        if(applyUICfgObj(p, mode)){ uiMsg(mode === 'replace' ? '✅ 已覆盖导入' : '✅ 已合并导入'); SFX.success(); }
      }).catch(function(){ uiMsg('❌ 密码错误或文件损坏', '#af410f'); SFX.error(); });
    });
    return;
  }
  if(applyUICfgObj(o, mode)){
    uiMsg(mode === 'replace' ? '✅ 已覆盖导入配置' : '✅ 已合并导入配置');
    SFX.success();
  }
}

/* ---------- 导入弹窗（3 步 Stepper） ---------- */

var UI_IMP_STEP = 0, UI_IMP_TEXT = '';

function openUiImport(){
  UI_IMP_STEP = 0; UI_IMP_TEXT = '';
  var m = document.getElementById('uiImportMask'); if(!m) return;
  renderUiImport();
  m.classList.add('show');
  SFX.pop();
}
function closeUiImport(){
  var m = document.getElementById('uiImportMask'); if(m) m.classList.remove('show');
}
function setStep(n){
  UI_IMP_STEP = n;
  var box = document.getElementById('uiStepper'); if(!box) return;
  Array.prototype.forEach.call(box.children, function(el, i){
    el.className = (i < n) ? 'done' : (i === n ? 'on' : '');
  });
}
function renderUiImport(){
  var box = document.getElementById('uiImportBody'); if(!box) return;
  setStep(UI_IMP_STEP);
  if(UI_IMP_STEP === 0){
    box.innerHTML =
      '<p class="ui-hint">选择之前导出的 <b>class-site-settings-*.json</b> 文件。</p>' +
      '<input type="file" id="uiImpFile" accept=".json,application/json" onchange="uiImpRead(this)" ' +
        'style="width:100%;font-size:.78rem;color:var(--fg-3);margin-bottom:10px">' +
      '<p class="ui-hint">也可以直接把文件内容粘贴到下面：</p>' +
      '<textarea id="uiImpText" rows="4" style="width:100%;font-size:.74rem;border:1px solid var(--tint-2);' +
        'border-radius:10px;padding:8px;font-family:inherit;background:#fff;color:var(--fg)" placeholder="粘贴配置 JSON…"></textarea>' +
      '<button class="btn" style="width:100%;margin-top:10px" onclick="uiImpFromText()">下一步</button>';
  }else if(UI_IMP_STEP === 1){
    box.innerHTML =
      '<p class="ui-hint">怎么处理这份配置？</p>' +
      '<button class="btn" style="width:100%;margin-bottom:8px" onclick="uiImpGo(\'merge\')">合并导入（推荐）<br>' +
        '<span style="font-size:.68rem;font-weight:400;opacity:.85">保留本机已有的排序与背景，同项以文件为准</span></button>' +
      '<button class="btn btn-secondary" style="width:100%" onclick="uiImpGo(\'replace\')">覆盖导入<br>' +
        '<span style="font-size:.68rem;font-weight:400;opacity:.8">完全替换成文件里的设置</span></button>' +
      '<button class="btn btn-gray" style="width:100%;margin-top:8px" onclick="setStep(0);renderUiImport()">返回上一步</button>';
  }else{
    box.innerHTML =
      '<div style="text-align:center;padding:8px 0 4px">' +
        '<div style="color:var(--accent-ink);margin-bottom:8px">' + iconSvg('check', 34) + '</div>' +
        '<p style="font-size:.86rem;font-weight:700;color:var(--fg);margin-bottom:6px" id="uiImpResult">导入完成</p>' +
        '<p class="ui-hint" id="uiImpDetail">设置已生效。</p>' +
      '</div>' +
      '<button class="btn" style="width:100%;margin-top:8px" onclick="closeUiImport()">完成</button>';
  }
}
function uiImpRead(input){
  var f = input.files && input.files[0]; if(!f) return;
  var rd = new FileReader();
  rd.onload = function(){
    UI_IMP_TEXT = String(rd.result || '');
    try{ JSON.parse(UI_IMP_TEXT); }catch(e){ uiMsg('❌ 文件内容不是合法 JSON', '#af410f'); return; }
    setStep(1); renderUiImport();
    SFX.click();
  };
  rd.readAsText(f);
  input.value = '';
}
function uiImpFromText(){
  var ta = document.getElementById('uiImpText');
  var t = ta ? ta.value : '';
  if(!t.trim()){ uiMsg('❌ 请先选择文件或粘贴内容', '#af410f'); return; }
  try{ JSON.parse(t); }catch(e){ uiMsg('❌ 内容不是合法 JSON', '#af410f'); return; }
  UI_IMP_TEXT = t;
  setStep(1); renderUiImport();
}
function uiImpGo(mode){
  var before = JSON.stringify(UI);
  doImportUICfg(UI_IMP_TEXT, mode);
  var after = JSON.stringify(UI);
  var changed = (before !== after);
  setStep(2); renderUiImport();
  var r = document.getElementById('uiImpResult');
  var d = document.getElementById('uiImpDetail');
  if(r) r.textContent = changed ? '导入完成' : '导入完成（设置无变化）';
  if(d) d.textContent = (mode === 'replace') ? '已覆盖本机设置。' : '已合并到本机设置。';
}

/* ---------- 恢复默认 ---------- */

function resetUICfg(){
  if(!confirm('恢复默认设置？\n\n字号、背景、动效开关与全部排序都会还原。\n不影响公告、作业与游戏记录。')) return;
  UI = uiDefault();
  saveUI();
  try{ localStorage.removeItem(UI_BG_KEY); }catch(e){}
  applyUICfg();
  rerenderAll();
  renderSettings();
  uiMsg('✅ 已恢复默认设置');
  SFX.success();
}

/* ---------- 遮罩点击关闭（照现有逐弹窗 IIFE 模式） ---------- */
(function(){
  var m = document.getElementById('uiSetMask');
  if(m) m.addEventListener('click', function(e){ if(e.target.id === 'uiSetMask') closeSettings(); });
})();
(function(){
  var m = document.getElementById('uiImportMask');
  if(m) m.addEventListener('click', function(e){ if(e.target.id === 'uiImportMask') closeUiImport(); });
})();


/* ---- 安装为应用（PWA）教程 ---- */
function installGuideHtml(){
  function sec(icon, title, items){
    return '<div class="install-sec">' +
      '<h3>' + icon + ' ' + esc(title) + '</h3>' +
      '<ul>' + items.map(function(it){ return '<li>' + it + '</li>'; }).join('') + '</ul>' +
    '</div>';
  }
  return '<div class="install-guide">' +
    '<div class="install-hero">' +
      '<div class="install-hero-ico">📲</div>' +
      '<div><div class="install-hero-title">将本站安装为本地应用</div>' +
      '<div class="install-hero-sub">安装后可像 App 一样打开，离线也能看。微信内请用浏览器打开。</div></div>' +
    '</div>' +
    sec('🖥', '电脑端（Windows · Edge）', [
      '用 <b>Edge</b> 打开本站，地址栏右侧点「安装」图标（⚡ 或应用图标）即可。',
      '若地址栏没有该图标：右上角「···」菜单 → <b>应用</b> → <b>将此站点安装为应用</b>。'
    ]) +
    sec('🍎', '苹果手机 / 平板（iPhone · iPad · Safari）', [
      '必须使用 <b>Safari</b> 浏览器打开本站（微信、Chrome 等均不行）。',
      '点底部「<b>分享</b>」按钮 → 下滑找到【<b>添加到主屏幕</b>】→ 确认添加。'
    ]) +
    sec('📱', '安卓手机（各品牌浏览器）', [
      '<span class="dot o"></span><b>小米 / 红米</b>：小米浏览器 → 底部「菜单」→ <b>工具箱</b> → 安装应用；若无该选项，先「收藏」再「添加至桌面」。',
      '<span class="dot g"></span><b>OPPO / realme</b>：OPPO 浏览器 → 底部「三」→ <b>收藏网页</b> → 长按书签「添加至桌面」（仅为快捷方式）。',
      '<span class="dot p"></span><b>vivo / iQOO</b>：vivo 浏览器 → 右上角「···」，优先选「安装应用」，找不到则「添加到桌面」。',
      '<span class="dot b"></span><b>华为</b>：华为浏览器 → 右下角「四点」菜单 → <b>添加至桌面</b>。'
    ]) +
    sec('✅', '安卓兜底方案（推荐 · 纯净独立应用）', [
      '下载 <b>Microsoft Edge</b> 打开本站 → 左下角「三」菜单，右滑找到【<b>添加至手机</b>】。',
      '安装后为独立应用窗口，<b>无浏览器地址栏</b>，体验最佳，各品牌通用。'
    ]) +
    '<div class="install-tip">⚠️ <b>通用提示</b>：微信内置浏览器不支持安装，请「复制链接」到系统浏览器（Edge / Safari / 手机自带浏览器）打开后再安装。</div>' +
  '</div>';
}

/* ---- 侧边栏：构建与页面切换 ---- */
function buildSidebar(){
  var box = document.getElementById('sideCats');
  if(!box) return;
  var cats = uiCats();   /* 【自定义设置】侧栏顺序跟随用户设置 */
  box.innerHTML = cats.map(function(c){
    return '<button class="side-btn" data-cat="'+c.id+'" onclick="openCat('+c.id+')">'+esc(c.name)+'</button>';
  }).join('');
}
var __activeCat = null;
function openCat(id){
  /* v3.8.4：游客态只放行「这条分享指向的板块」，其它板块一律拦住并说明原因。
     放在最前面 —— 后面那些挂载逻辑（成绩分析/投票）都不能跑。 */
  if(typeof GUEST !== 'undefined' && GUEST && Number(id) !== Number(GUEST.boardId)){
    if(typeof guestDeny === 'function') guestDeny();
    return;
  }
  /* v2.10.0：操作日志 —— 页面跳转（page 记目标板块，不是来源板块） */
  if(typeof actLog === 'function'){
    var _cn = '';
    try{
      var _cats = (window.SITE_DATA && SITE_DATA.categories) || [];
      for(var _i = 0; _i < _cats.length; _i++){ if(_cats[_i].id === id){ _cn = _cats[_i].name; break; } }
    }catch(e){}
    actLog('jump', '板块#' + id, '', _cn || ('板块' + id));
  }
  /* 安装为应用：微信内无法直接安装，先引导用浏览器打开（与 voicehub 等入口一致） */
  if(id === 9 && isWeChat()){
    closeSidebar();
    targetUrl = location.href;
    show('guideOverlay');
    var gh = document.getElementById('guideHost');
    if(gh){ var h=''; try{ h = new URL(location.href).hostname; }catch(e){} gh.textContent = h ? '目标：' + h : ''; }
    return;
  }
  __activeCat = id;
  var home = document.getElementById('homeView');
  var grid = document.getElementById('grid');
  if(home) home.style.display = 'none';
  if(grid) grid.style.display = 'block';
  var pages = grid ? grid.querySelectorAll('.tab-page') : [];
  for(var i=0;i<pages.length;i++){ pages[i].classList.remove('active'); }
  var page = document.getElementById('tab-cat-'+id);
  if(page) page.classList.add('active');
  if(id === 5){ showStudyNotice(); }
  else { studyBubbleHide(); }
  /* 通用弹窗引擎：该板块配了 scope:'cat:N' 就弹一条（含横幅） */
  if(typeof popOnCategory === 'function'){ setTimeout(function(){ popOnCategory(id); }, 600); }
  var btns = document.querySelectorAll('#sideCats .side-btn');
  for(var j=0;j<btns.length;j++){ btns[j].classList.remove('active'); }
  var cur = document.querySelector('#sideCats .side-btn[data-cat="'+id+'"]');
  if(cur) cur.classList.add('active');
  /* 成绩分析（板块 3）是内嵌的：一切过去就把它挂起来（没登录就给登录引导） */
  if(id === 3 && typeof scEnsureMounted === 'function'){ scEnsureMounted(); }
  /* v3.5.6 投票专区（板块 7）：同一套「内嵌即挂载」的路子 */
  if(id === 7 && typeof voteEnsureMounted === 'function'){ voteEnsureMounted(); }
  var homeBtn = document.getElementById('homeBtn');
  if(homeBtn) homeBtn.classList.remove('active');
  /* 【卡片堆叠 v35】切到该分类后卡片才真正可见，此时才能量到高度算统一高度。
     render() 里的 stackApply() 跑在分类显示之前，量不到高度会被跳过，
     所以这里补一次；用 rAF 等布局稳定后再量，避免刚切过去量到过渡中的中间值。 */
  if(typeof stackApply === 'function'){
    stackApply();
    requestAnimationFrame(function(){ stackApply(); });
  }
  closeSidebar();
}
function goHomeView(){
  __activeCat = null;
  studyBubbleHide();
  var home = document.getElementById('homeView');
  var grid = document.getElementById('grid');
  if(home) home.style.display = 'block';
  if(grid) grid.style.display = 'none';
  var btns = document.querySelectorAll('#sideCats .side-btn');
  for(var i=0;i<btns.length;i++){ btns[i].classList.remove('active'); }
  var homeBtn = document.getElementById('homeBtn');
  if(homeBtn) homeBtn.classList.add('active');
  closeSidebar();
}
function openSidebar(){ var s=document.getElementById('sidebar'); var m=document.getElementById('sideMask'); if(s) s.classList.add('open'); if(m) m.classList.add('show'); }
function closeSidebar(){ var s=document.getElementById('sidebar'); var m=document.getElementById('sideMask'); if(s) s.classList.remove('open'); if(m) m.classList.remove('show'); }

/* ============================================================================
 * v3.9.3（站主）：班级岛 —— 首页公告上面那一条
 * ----------------------------------------------------------------------------
 * 站主原话：
 *   「班级岛不要那么多功能了，第二行的课程表改为课表信息显示，类似一个横幅，
 *     我在后台可以编辑横幅内容……一般情况下这个横幅上的就显示今日事项：
 *     升 数数语英化 物物体劳 听自语语 就这样显示就可以了。」
 *   「我星期五就可以提前修改好星期六和星期天的横幅显示内容。」
 *   「放假时间段呢，我们不这样写……显示已放假多少天、距开学还有多少天。」
 *
 * 所以第二行不再是一排课程格子，就是一行横幅：
 *   今日事项：升 数数语英化 物物体劳 听自语语自
 * 放假时换成：寒假 · 已放假 12 天 · 距开学还有 5 天
 * 点它不弹窗 —— 要看整周的课，去公告里的课表图或者问课代表。
 * ========================================================================= */
var ISLAND = null;
var ISLAND_TICK = null;
var ISLAND_WX = null;

var ISLAND_WX_TXT = {
  0: '晴', 1: '多云', 2: '多云', 3: '阴', 45: '有雾', 48: '有雾',
  51: '小雨', 53: '小雨', 55: '中雨', 61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '冻雨', 71: '小雪', 73: '中雪', 75: '大雪', 77: '雪',
  80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '阵雪',
  95: '雷阵雨', 96: '雷阵雨', 99: '雷阵雨'
};

var ISLAND_DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
var ISLAND_DOW_CN = { mon: '周一', tue: '周二', wed: '周三', thu: '周四', fri: '周五', sat: '周六', sun: '周日' };

function islandBoot(){
  if(!apiReady()) return;
  api('/island').then(function(j){
    ISLAND = (j && j.data) || null;
    islandRender();
    if(ISLAND && ISLAND.on && !ISLAND_TICK){
      ISLAND_TICK = setInterval(islandTick, 30000);
    }
  }).catch(function(){ /* 接口没上就当作没有岛 */ });
}

function islandDateKey(d){
  var m = d.getMonth() + 1, dd = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (dd < 10 ? '0' : '') + dd;
}
function islandDayKey(d){ return ISLAND_DOW[d.getDay()]; }
function islandMin(hhmm){
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function islandWeekNo(date){
  if(!ISLAND || !ISLAND.startDate) return '';
  var st = new Date(ISLAND.startDate + 'T00:00:00');
  if(isNaN(st.getTime())) return '';
  var d = new Date(date || Date.now());
  d.setHours(0, 0, 0, 0);
  var diff = Math.floor((d - st) / 86400000);
  if(diff < 0) return '未开学';
  return '第 ' + (Math.floor(diff / 7) + 1) + ' 周';
}

function islandDaysBetween(a, b){
  var A = new Date(a + 'T00:00:00'), B = new Date(b + 'T00:00:00');
  if(isNaN(A.getTime()) || isNaN(B.getTime())) return null;
  return Math.round((B - A) / 86400000);
}

/* ============================================================================
 * v3.9.8（站主）：点「天气」那一格 → 当天逐小时天气
 * ----------------------------------------------------------------------------
 * 站主原话：「点击天气可以查看当天具体到每小时的天气」。
 * 仍然用 Open-Meteo（免 key、可跨域），一次拿 24 小时的温度 / 天气码 / 降水概率，
 * 底部弹层里按小时列出来，当前小时高亮；数据缓存 10 分钟，避免反复请求。
 * ========================================================================= */
var ISL_WX_H = null;
var ISL_WX_ICON = {
  0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️', 45: '🌫️', 48: '🌫️',
  51: '🌦️', 53: '🌦️', 55: '🌧️', 61: '🌧️', 63: '🌧️', 65: '🌧️',
  66: '🌧️', 67: '🌧️', 71: '🌨️', 73: '🌨️', 75: '❄️', 77: '❄️',
  80: '🌦️', 81: '🌧️', 82: '⛈️', 85: '🌨️', 86: '🌨️', 95: '⛈️', 96: '⛈️', 99: '⛈️'
};
function islWxIcon(code){ return ISL_WX_ICON[code] || '🌡️'; }
function islWxOpen(){
  var m = document.getElementById('islWxMask');
  if(!m) return;
  m.classList.add('show');
  document.body.style.overflow = 'hidden';
  islWxLoad();
}
function islWxClose(){
  var m = document.getElementById('islWxMask');
  if(!m) return;
  m.classList.remove('show');
  document.body.style.overflow = '';
}
function islWxBackdrop(e){ if(e.target === e.currentTarget) islWxClose(); }
function islWxLoad(){
  var body = document.getElementById('islWxBody');
  if(!body) return;
  var cache = null;
  try{ cache = JSON.parse(localStorage.getItem('__cls_wx_h') || 'null'); }catch(e){}
  if(cache && cache.t && (Date.now() - cache.t) < 10 * 60000){
    islWxPaint(cache.v);
    return;
  }
  body.innerHTML = '<div class="isl-wx-load">正在获取逐小时天气…</div>';
  fetch('https://api.open-meteo.com/v1/forecast?latitude=29.03&longitude=114.57'
      + '&hourly=temperature_2m,weather_code,precipitation_probability'
      + '&daily=temperature_2m_max,temperature_2m_min'
      + '&forecast_days=1&timezone=Asia%2FShanghai')
    .then(function(r){ return r.json(); })
    .then(function(j){
      var h = (j && j.hourly) || {};
      if(!h.time || !h.time.length) throw new Error('no data');
      var v = {
        time: h.time, temp: h.temperature_2m || [],
        code: h.weather_code || [], rain: h.precipitation_probability || [],
        max: (j.daily && j.daily.temperature_2m_max && j.daily.temperature_2m_max[0]) || null,
        min: (j.daily && j.daily.temperature_2m_min && j.daily.temperature_2m_min[0]) || null,
      };
      try{ localStorage.setItem('__cls_wx_h', JSON.stringify({ t: Date.now(), v: v })); }catch(e){}
      islWxPaint(v);
    })
    .catch(function(){
      body.innerHTML = '<div class="isl-wx-load">天气没取到，可能是网络或接口暂时不可用<br>稍后再点一次试试</div>';
    });
}
function islWxPaint(v){
  var body = document.getElementById('islWxBody');
  if(!body || !v) return;
  var now = new Date();
  var curH = now.getHours();
  var temps = v.temp.filter(function(x){ return x != null; });
  var lo = Math.min.apply(null, temps), hi = Math.max.apply(null, temps);
  var span = Math.max(1, hi - lo);
  var sub = document.getElementById('islWxSub');
  if(sub) sub.textContent = (v.max != null && v.min != null)
    ? ('最高 ' + Math.round(v.max) + '° · 最低 ' + Math.round(v.min) + '°') : '';
  var rows = v.time.map(function(t, i){
    var hh = parseInt(String(t).slice(11, 13), 10);
    var tp = v.temp[i];
    var rn = v.rain[i];
    var w = (tp == null) ? 0 : Math.round(((tp - lo) / span) * 88 + 12);
    return '<div class="isl-wx-row' + (hh === curH ? ' now' : '') + '">'
      + '<span class="t">' + ('0' + hh).slice(-2) + ':00</span>'
      + '<span class="ic">' + islWxIcon(v.code[i]) + '</span>'
      + '<span class="bar" style="width:' + w + '%"></span>'
      + '<span class="tp">' + (tp == null ? '—' : Math.round(tp) + '°') + '</span>'
      + '<span class="rn">' + (rn == null || rn <= 0 ? '' : rn + '%') + '</span>'
      + '</div>';
  }).join('');
  body.innerHTML = rows || '<div class="isl-wx-load">今天没有逐小时数据</div>';
  /* 自动滚到当前小时 */
  try{
    var nowRow = body.querySelector('.isl-wx-row.now');
    if(nowRow) body.scrollTop = Math.max(0, nowRow.offsetTop - 90);
  }catch(e){}
}

/* ============================================================================
 * v3.9.6（站主）：点「今日事项」那一行 → 本页弹出照片
 * ----------------------------------------------------------------------------
 * 站主原话：「用户点击今日事项那一行时显示一张照片，照片我会在后台的班级岛
 *            位置放上直链或者仓库位置，用户点击后弹出照片，要求在本页面显示
 *            而且可以放大缩小和关闭」。
 *
 * 实现要点：
 *   · 图片地址存 island.photo，直链和相对路径都行（相对路径按 index.html 解析）
 *   · 弹层 z-index 1800，压过所有普通弹窗；不跳新页面、不离开本站
 *   · 缩放：双指（pointer 事件）/ 滚轮 / 双击切换 1× ↔ 2.4×
 *   · 拖动：单指或鼠标拖；缩放回 1× 时自动归位
 *   · 关闭：右上角 ✕ / 点空白处 / Esc
 * ========================================================================= */
var ISL_PZ = { s: 1, x: 0, y: 0 };
function islPhotoApply(){
  var img = document.getElementById('islPhotoImg');
  if(!img) return;
  img.style.transform = 'translate(' + ISL_PZ.x + 'px,' + ISL_PZ.y + 'px) scale(' + ISL_PZ.s + ')';
}
function islPhotoReset(){ ISL_PZ.s = 1; ISL_PZ.x = 0; ISL_PZ.y = 0; islPhotoApply(); }
function islPhotoOpen(){
  if(!ISLAND || !ISLAND.photo) return;
  var m = document.getElementById('islPhotoMask');
  var img = document.getElementById('islPhotoImg');
  if(!m || !img) return;
  var err = document.getElementById('islPhotoErr');
  if(err) err.style.display = 'none';
  img.style.visibility = 'visible';
  img.onerror = function(){
    if(err) err.style.display = '';
    img.style.visibility = 'hidden';
  };
  img.onload = function(){
    if(err) err.style.display = 'none';
    img.style.visibility = 'visible';
  };
  img.src = ISLAND.photo;
  islPhotoReset();
  try{ islPhotoBind(); }catch(e){}   /* 首次打开时才挂手势，不占启动时间 */
  m.classList.add('show');
  document.body.style.overflow = 'hidden';
  try{ if(typeof SFX !== 'undefined' && SFX && SFX.pop) SFX.pop(); }catch(e){}
}
function islPhotoClose(){
  var m = document.getElementById('islPhotoMask');
  if(!m) return;
  m.classList.remove('show');
  document.body.style.overflow = '';
}
function islPhotoBackdrop(e){ if(e.target === e.currentTarget) islPhotoClose(); }
function islBindPhoto(host){
  var b = host && host.querySelector('.island-banner');
  if(!b) return;
  if(ISLAND && ISLAND.photo){ b.onclick = islPhotoOpen; return; }
  /* v3.9.7：还没配照片时，管理员点一下给个去处提示；同学点了不弹任何东西 */
  b.onclick = function(){
    try{
      if(typeof isAdmin === 'function' && isAdmin()){
        if(typeof uiMsg === 'function') uiMsg('还没设置今日事项照片：后台 → 班级岛 → 今日事项照片', '#b45309');
      }
    }catch(e){}
  };
}
/* 手势绑定：只在第一次打开时挂一次 */
function islPhotoBind(){
  var stage = document.getElementById('islPhotoStage');
  if(!stage || stage.__bound) return;
  stage.__bound = true;
  var pts = {}, pinch = 0, base = 1, drag = false, sx = 0, sy = 0, ox = 0, oy = 0;
  function dist(){
    var k = Object.keys(pts);
    if(k.length < 2) return 0;
    var a = pts[k[0]], b = pts[k[1]];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  stage.addEventListener('pointerdown', function(e){
    pts[e.pointerId] = { x: e.clientX, y: e.clientY };
    try{ stage.setPointerCapture(e.pointerId); }catch(err){}
    var n = Object.keys(pts).length;
    if(n === 1){ drag = true; sx = e.clientX; sy = e.clientY; ox = ISL_PZ.x; oy = ISL_PZ.y; }
    if(n === 2){ drag = false; pinch = dist(); base = ISL_PZ.s; }
  });
  stage.addEventListener('pointermove', function(e){
    if(!pts[e.pointerId]) return;
    pts[e.pointerId] = { x: e.clientX, y: e.clientY };
    var n = Object.keys(pts).length;
    if(n >= 2 && pinch > 0){
      var d = dist();
      if(d > 0){
        ISL_PZ.s = Math.min(5, Math.max(1, base * d / pinch));
        islPhotoApply();
      }
      return;
    }
    if(drag){
      ISL_PZ.x = ox + (e.clientX - sx);
      ISL_PZ.y = oy + (e.clientY - sy);
      islPhotoApply();
    }
  });
  function end(e){
    delete pts[e.pointerId];
    var n = Object.keys(pts).length;
    if(n === 0){
      drag = false; pinch = 0;
      if(ISL_PZ.s <= 1.02){ ISL_PZ.s = 1; ISL_PZ.x = 0; ISL_PZ.y = 0; islPhotoApply(); }
    }else if(n === 1){
      var k = Object.keys(pts)[0];
      drag = true; sx = pts[k].x; sy = pts[k].y; ox = ISL_PZ.x; oy = ISL_PZ.y; pinch = 0;
    }
  }
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', function(e){
    e.preventDefault();
    ISL_PZ.s = Math.min(5, Math.max(1, ISL_PZ.s * (e.deltaY < 0 ? 1.12 : 0.89)));
    if(ISL_PZ.s <= 1.02){ ISL_PZ.s = 1; ISL_PZ.x = 0; ISL_PZ.y = 0; }
    islPhotoApply();
  }, { passive: false });
  stage.addEventListener('dblclick', function(){
    if(ISL_PZ.s > 1.05){ ISL_PZ.s = 1; ISL_PZ.x = 0; ISL_PZ.y = 0; }
    else { ISL_PZ.s = 2.4; }
    islPhotoApply();
  });
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape') islPhotoClose();
  });
}
/* 今天该显示什么：假期倒计时 / 这天不上课 / 具体文案 */
function islandToday(){
  var d = new Date();
  var key = islandDateKey(d);
  var dow = islandDayKey(d);
  if(!ISLAND) return { kind: 'none' };

  var hs = ISLAND.holidays || [];
  for(var i = 0; i < hs.length; i++){
    if(hs[i].from <= key && key <= hs[i].to){
      var passed = islandDaysBetween(hs[i].from, key);
      var left = islandDaysBetween(key, hs[i].to);
      return {
        kind: 'holiday',
        label: hs[i].label || '假期',
        passed: (passed == null ? 0 : passed) + 1,
        left: (left == null ? 0 : left) + 1,
      };
    }
  }

  var day = (ISLAND.days || {})[key];
  if(day && day.off){
    return { kind: 'off', label: day.label || '今天不上课', text: day.text || '' };
  }
  var text = (day && day.text) || (ISLAND.banner || {})[dow] || '';
  return {
    kind: 'text',
    text: text,
    /* v3.9.7：只有「按日期临时改」的那一条才带格式；星期默认课表一律常规 + 居中 */
    /* 没设过的那天（用星期默认课表）走「默认加粗」，day.bold 未设时也按加粗 */
    bold: (day && day.text) ? !!day.bold : undefined,
    center: !(day && day.text && day.center === false),
  };
}

function islandRender(){
  var host = document.getElementById('classIsland');
  if(!host) return;
  /* v3.9.14：去掉首帧占位类（占位是为了不让页面跳，见 index.html .isl-boot） */
  host.classList.remove('isl-boot');
  host.removeAttribute('aria-hidden');
  if(!ISLAND || !ISLAND.on){
    host.style.display = 'none';
    host.innerHTML = '';
    return;
  }
  host.style.display = '';

  var comps = ISLAND.components || [];
  var row = '';
  if(comps.indexOf('time') >= 0){
    row += '<div class="island-chip t"><span class="k">现在</span>'
         + '<span class="v" id="islTime">--:--</span></div>';
  }
  if(comps.indexOf('weather') >= 0){
    row += '<div class="island-chip tap" id="islWxChip" onclick="islWxOpen()" title="查看每小时天气">'
         + '<span class="k">天气</span><span class="v" id="islWx">—</span></div>';
  }
  if(comps.indexOf('week') >= 0){
    row += '<div class="island-chip"><span class="k">周数</span>'
         + '<span class="v">' + esc(islandWeekNo() || '—') + '</span></div>';
  }
  if(comps.indexOf('term') >= 0){
    var term = String(ISLAND.term || '').replace(/^\d{4}\s*年\s*/, '');
    if(term.indexOf('·') >= 0) term = term.split('·').pop().trim();
    row += '<div class="island-chip"><span class="k">学期</span>'
         + '<span class="v" title="' + attr(ISLAND.term || '') + '">' + esc(term || '—') + '</span></div>';
  }
  if(!row) row = '<div class="island-chip"><span class="k">今日</span><span class="v" id="islTime">—</span></div>';

  host.innerHTML = '<div class="island-row">' + row + '</div>'
    + '<div class="island-row" id="islBannerRow"></div>'
    + '<div class="island-foot"><span id="islFootL">今日事项</span>'
    +   '<b id="islFoot"></b></div>';

  islandBanner();
  islandTick();
  islandWeather();
}

/* 第二行：一行横幅 */
/* ============================================================================
 * v3.9.8（站主）：今日事项支持「按字」排版
 * ----------------------------------------------------------------------------
 * 站主原话：「居中跟加粗的意思是每个字都可以单独设置。然后或者说如果我是在
 *            行首的话，那就代表是该一行全部加粗和居中，然后也可以给某个字加横线」。
 *
 * 约定（后台有按钮，不用手打）：
 *   **文字**   → 这几个字加粗
 *   ~~文字~~   → 这几个字加删除线（比如临时取消的课）
 *   行首 #     → 这一行整体加粗并居中
 * 先转义再套标记，不会因为内容里带尖括号出问题。
 * ========================================================================= */
function islFmtLine(line, forceHead){
  var head = !!forceHead;
  var t = String(line == null ? '' : line);
  if(/^#\s?/.test(t)){ head = true; t = t.replace(/^#\s?/, ''); }
  var html = esc(t);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  html = html.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  return head ? '<span class="ln-em">' + html + '</span>' : html;
}
function islFmt(text){
  var lines = String(text == null ? '' : text).split('\n');
  return lines.map(function(l){ return islFmtLine(l, false); }).join('\n');
}

function islandBanner(){
  var host = document.getElementById('islBannerRow');
  if(!host || !ISLAND) return;
  var t = islandToday();
  var footL = document.getElementById('islFootL');
  var foot = document.getElementById('islFoot');

  if(t.kind === 'holiday'){
    host.innerHTML = '<div class="island-banner hol">'
      + '<span class="tag">放假中</span>'
      + '<span class="txt"><b>' + esc(t.label) + '</b>　已放假 ' + t.passed + ' 天'
      +   ' · 距开学还有 ' + t.left + ' 天</span>'
      + '</div>';
    islBindPhoto(host);
    if(footL) footL.textContent = '假期';
    if(foot) foot.textContent = islandWeekNo();
    return;
  }

  if(t.kind === 'off'){
    host.innerHTML = '<div class="island-banner hol">'
      + '<span class="tag">今天</span>'
      + '<span class="txt"><b>' + esc(t.label) + '</b>' + (t.text ? '　' + esc(t.text) : '') + '</span>'
      + '</div>';
    islBindPhoto(host);
    if(footL) footL.textContent = '放假';
    if(foot) foot.textContent = islandWeekNo();
    return;
  }

  var txt = t.text || '今天没有安排';
  var cam = ISLAND.photo
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>'
    : '';
  var cls = 'txt' + (t.bold === true ? ' bold' : (t.bold === false ? ' soft' : ''))
    + (t.center === false ? ' left' : '');
  host.innerHTML = '<div class="island-banner' + (ISLAND.photo ? ' can-photo' : '')
    + (t.center === false ? ' left-align' : '') + '"'
    + (ISLAND.photo ? ' title="点击查看照片"' : '') + '>'
    + '<span class="tag">今日事项' + cam + '</span>'
    + '<span class="' + cls + '">' + islFmt(txt) + '</span>'
    + '</div>';
  islBindPhoto(host);
  if(footL) footL.textContent = ISLAND_DOW_CN[islandDayKey(new Date())] + ' ' + (new Date().getMonth() + 1) + '/' + new Date().getDate();
  if(foot) foot.textContent = islandWeekNo();
}

function islandTick(){
  if(!ISLAND || !ISLAND.on) return;
  var el = document.getElementById('islTime');
  if(el){
    var d = new Date();
    el.textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
}

function islandWeather(){
  var el = document.getElementById('islWx');
  if(!el) return;
  if(ISLAND_WX){
    el.textContent = ISLAND_WX.t + '° ' + ISLAND_WX.s;
    return;
  }
  var cache = null;
  try{ cache = JSON.parse(localStorage.getItem('__cls_wx') || 'null'); }catch(e){}
  if(cache && cache.v && (Date.now() - cache.t) < 30 * 60000){
    ISLAND_WX = cache.v;
    el.textContent = ISLAND_WX.t + '° ' + ISLAND_WX.s;
    return;
  }
  /* v3.9.10：轻量模式不主动联网（省流量、少一次 200ms+ 的请求），
     有旧缓存就显示旧值，没有就留「—」。 */
  if(liteOn()){ el.textContent = '—'; return; }
  /* Open-Meteo：免费、免 key、允许跨域；坐标按修水县取的 */
  fetch('https://api.open-meteo.com/v1/forecast?latitude=29.03&longitude=114.57'
      + '&current=temperature_2m,weather_code&timezone=Asia%2FShanghai')
    .then(function(r){ return r.json(); })
    .then(function(j){
      var c = (j && j.current) || {};
      if(c.temperature_2m == null) throw new Error('no data');
      var v = { t: Math.round(c.temperature_2m), s: ISLAND_WX_TXT[c.weather_code] || '天气' };
      ISLAND_WX = v;
      try{ localStorage.setItem('__cls_wx', JSON.stringify({ t: Date.now(), v: v })); }catch(e){}
      var e2 = document.getElementById('islWx');
      if(e2) e2.textContent = v.t + '° ' + v.s;
    })
    .catch(function(){
      var e3 = document.getElementById('islWx');
      if(e3) e3.textContent = '—';
    });
}

/* ============================================================
 * v3.8.4（站主）：板块分享链接（前台）
 * ------------------------------------------------------------
 * 站主原话：
 *   「可以生成包含该板块所有内容的分享链接，且内容也是链接数据库实时刷新的，
 *     就相当于一个快捷方式，用户打开直接跳转到对应位置，而且还可以一键返回主页。
 *     登录用户点击链接直接通过已登录账号访问……未登录用户点击后是否需要登录才
 *     能继续访问，否则将弹窗拦截……也可以设置无需登录即可访问。」
 *   「不是说他能看全站，未分享的页面置灰，点击则提示：当前分享链接仅支持查看
 *     该分享内容，其他内容请登录后再查看。」
 *
 * 三条硬规则：
 *   ① token 只当「门牌号」，不带任何内容快照 —— 页面每次现拉数据库
 *   ② 游客只放行这一条链接指向的板块；其它板块/卡片置灰 + 点击给明确提示
 *   ③ 登录之后自动回到原位置，不用再点一次
 * ========================================================= */
var BOARD_META = { cats: {}, cards: {}, catalog: null, noShare: [] };
var SHARE_CTX = null;   /* 当前分享链接指向哪儿（登录后据此回跳） */
var GUEST = null;       /* 游客态：{boardId, card, name}；登录后清空 */
var GUEST_MSG = '当前分享链接仅支持查看该分享内容，其他内容请登录后再查看';

/* 云端改过的板块名 / 简介 / 排序 / 隐藏 / 游客可见，覆盖掉 HTML 里的默认值 */
function applyBoardMeta(m){
  if(!m) return;
  BOARD_META = {
    cats: m.cats || {},
    cards: m.cards || {},
    catalog: m.catalog || null,
    noShare: m.noShare || []
  };
  var i, k;
  for(i = 0; i < SITE_DATA.categories.length; i++){
    var c = SITE_DATA.categories[i];
    k = BOARD_META.cats[String(c.id)];
    if(!k) continue;
    if(k.name) c.name = k.name;
    if(k.intro) c.intro = k.intro;
    if(k.hidden) c.active = false;
    if(k.sort !== undefined && k.sort !== null) c.__sort = Number(k.sort);
  }
  for(i = 0; i < SITE_DATA.links.length; i++){
    var l = SITE_DATA.links[i];
    k = BOARD_META.cards[String(l.id)];
    if(!k) continue;
    if(k.title) l.title = k.title;
    if(k.hidden) l.active = false;
  }
}

/* 后台设的排序：没设过 sort 的排最后（保持原有相对顺序） */
function applyBoardSort(list){
  return list.slice().sort(function(a, b){
    var sa = (a.__sort === undefined || a.__sort === null) ? 1e9 : a.__sort;
    var sb = (b.__sort === undefined || b.__sort === null) ? 1e9 : b.__sort;
    return sa - sb;
  });
}

function boardIntroHtml(id){
  var k = BOARD_META.cats[String(id)];
  var t = (k && k.intro) ? String(k.intro) : '';
  if(!t) return '';
  return '<div class="cat-intro">' + esc(t) + '</div>';
}

function boardMetaLoad(cb){
  if(!apiReady()){ if(cb) cb(); return; }
  api('/boards?action=meta').then(function(j){
    applyBoardMeta(j);
    try{ render(); }catch(e){}
    if(cb) cb();
  }).catch(function(){ if(cb) cb(); });
}

/* ---------- 启动：先拿板块设置，再解析深链 ---------- */
function boardShareBoot(){
  boardMetaLoad(function(){
    var q = {};
    try{
      var sp = new URLSearchParams(location.search);
      q.t = sp.get('t') || '';
      q.b = sp.get('b') || '';
      q.c = sp.get('c') || '';
    }catch(e){}
    if(q.t){
      resolveBoardShare(q.t, q.c);
    }else if(q.b){
      var bid = parseInt(q.b, 10);
      if(bid){
        if(isLoggedIn()){
          openCat(bid);
          if(q.c) setTimeout(function(){ locateBoardCard(q.c); }, 420);
        }else{
          /* 没有 token 的深链：站内自己人用，未登录先登录，登录后回跳 */
          SHARE_CTX = { token:'', boardId:bid, card:q.c || '', guestOk:false, name:'' };
          openAccount();
          setTimeout(function(){ try{ acctTab('login'); }catch(e){} }, 60);
        }
      }
    }
    reportBoardCatalog();
  });

  /* 游客态的点击拦截：用捕获阶段，避免卡片自己的 onclick 先跑掉 */
  document.addEventListener('click', function(e){
    if(!GUEST) return;
    var sb = closestEl(e.target, '.side-btn');
    if(sb && sb.parentNode && sb.parentNode.id === 'sideCats'){
      var id = parseInt(sb.getAttribute('data-cat'), 10);
      if(id !== GUEST.boardId){
        e.preventDefault(); e.stopPropagation(); guestDeny();
      }
      return;
    }
    var cd = closestEl(e.target, '.card');
    if(cd && cd.classList.contains('card-locked')){
      e.preventDefault(); e.stopPropagation(); guestDeny();
    }
  }, true);
}

function closestEl(el, sel){
  while(el && el.nodeType === 1){
    if(el.matches ? el.matches(sel) : false) return el;
    el = el.parentNode;
  }
  return null;
}

/* ---------- 打开分享链接 ---------- */
function resolveBoardShare(t, card){
  var pv = '';
  try{ pv = new URLSearchParams(location.search).get('preview') || ''; }catch(e){}
  api('/boards?action=resolve&t=' + encodeURIComponent(t) + (pv === '1' ? '&preview=1' : ''))
    .then(function(j){
      SHARE_CTX = {
        token: t,
        boardId: parseInt(j.boardId, 10),
        card: j.card || card || '',
        guestOk: !!j.guestOk,
        name: j.name || '',
        intro: j.intro || ''
      };
      if(j.name) document.title = j.name + ' · 25级05班班级服务站';

      if(j.guestOk && !isLoggedIn()){
        enterGuest(SHARE_CTX);
        openCat(SHARE_CTX.boardId);
        if(SHARE_CTX.card) setTimeout(function(){ locateBoardCard(SHARE_CTX.card); }, 520);
      }else if(!isLoggedIn()){
        /* 这条链接要求登录：先弹登录，登录成功后 afterLoginResume 自动回到这里 */
        openAccount();
        setTimeout(function(){ try{ acctTab('login'); }catch(e){} }, 60);
      }else{
        openCat(SHARE_CTX.boardId);
        if(SHARE_CTX.card) setTimeout(function(){ locateBoardCard(SHARE_CTX.card); }, 420);
      }
    })
    .catch(function(e){ showShareDead(e && e.message); });
}

function showShareDead(msg){
  var old = document.getElementById('shareDeadMask');
  if(old && old.parentNode) old.parentNode.removeChild(old);
  var d = document.createElement('div');
  d.id = 'shareDeadMask';
  d.className = 'allboard-mask show';
  d.innerHTML = '<div class="allboard-box" style="max-width:360px">'
    + '<div class="allboard-head"><span>打不开这个分享</span></div>'
    + '<div style="padding:16px">'
    +   '<p class="guest-msg">' + esc(msg || '链接不可用') + '</p>'
    +   '<p class="guest-tip">如果链接是站主刚建的，可能是已撤销、已过期或查看次数用完了。</p>'
    +   '<button class="btn" style="width:100%;margin-top:14px" onclick="location.href=location.pathname">回站点首页</button>'
    + '</div></div>';
  document.body.appendChild(d);
}

/* ---------- 游客态 ---------- */
function enterGuest(info){
  GUEST = { boardId: parseInt(info.boardId, 10), card: info.card || '', name: info.name || '' };
  document.documentElement.classList.add('guest-mode');
  guestShowBar();
  applyGuestUI();
}

function clearGuest(){
  GUEST = null;
  document.documentElement.classList.remove('guest-mode');
  var bar = document.getElementById('guestBar');
  if(bar && bar.parentNode) bar.parentNode.removeChild(bar);
  var cards = document.querySelectorAll('#grid .card-locked');
  for(var i = 0; i < cards.length; i++) cards[i].classList.remove('card-locked');
  var sides = document.querySelectorAll('#sideCats .side-locked');
  for(var j = 0; j < sides.length; j++) sides[j].classList.remove('side-locked');
}

function guestShowBar(){
  var bar = document.getElementById('guestBar');
  if(!bar){
    bar = document.createElement('div');
    bar.id = 'guestBar';
    document.body.appendChild(bar);
  }
  bar.innerHTML = '<span class="g-name">📎 分享：' + esc(GUEST.name || '班级板块') + '</span>'
    + '<button class="ghost" type="button" onclick="goHomeView()">返回主页</button>'
    + '<button type="button" onclick="guestLogin()">登录</button>';
}

function guestLogin(){
  openAccount();
  setTimeout(function(){ try{ acctTab('login'); }catch(e){} }, 60);
}

/* 每次 render 之后都要重新上锁（render 会整体重建 #grid / #sideCats） */
function applyGuestUI(){
  if(!GUEST) return;
  var i;
  var btns = document.querySelectorAll('#sideCats .side-btn');
  for(i = 0; i < btns.length; i++){
    var id = parseInt(btns[i].getAttribute('data-cat'), 10);
    if(id !== GUEST.boardId) btns[i].classList.add('side-locked');
    else btns[i].classList.remove('side-locked');
  }
  var cards = document.querySelectorAll('#grid .card');
  for(i = 0; i < cards.length; i++){
    var ref = cards[i].getAttribute('data-card');
    if(cardGuestAllowed(ref)) cards[i].classList.remove('card-locked');
    else cards[i].classList.add('card-locked');
  }
}

/* 单卡片分享：只有那一张可用；整板分享：按卡片的「游客可见」开关 */
function cardGuestAllowed(ref){
  if(!GUEST) return true;
  if(GUEST.card) return String(ref) === String(GUEST.card);
  var k = BOARD_META.cards[String(ref)];
  return !(k && k.guestOk === false);
}

/* 拦截提示：明确告诉对方「为什么点不动、怎么才能看」 */
/* 从分享链接（?t=）或播放页（?play=）进来的访客：不弹开屏公告、不推销登录。
   之前只判断了 t=，结果扫码播放时会被「登录一下」整块盖住，视频根本没法看。 */
function isShareEntry(){
  try{
    var sp = new URLSearchParams(location.search);
    return !!(sp.get('t') || sp.get('play'));
  }catch(e){ return false; }
}

function guestDeny(){
  if(document.getElementById('guestMask')) return;
  var d = document.createElement('div');
  d.id = 'guestMask';
  d.className = 'allboard-mask show';
  d.innerHTML = '<div class="allboard-box" style="max-width:370px">'
    + '<div class="allboard-head"><span>需要登录</span>'
    +   '<button type="button" id="guestX">关闭</button></div>'
    + '<div style="padding:15px 16px 4px">'
    +   '<p class="guest-msg">' + GUEST_MSG + '</p>'
    + '</div>'
    + '<div style="display:flex;gap:8px;padding:12px 16px 16px">'
    +   '<button class="btn btn-sm" type="button" id="guestGoLogin" style="flex:1">去登录</button>'
    +   '<button class="btn btn-sm btn-secondary" type="button" id="guestGoHome" style="flex:1">返回主页</button>'
    + '</div></div>';
  document.body.appendChild(d);
  function close(){ if(d.parentNode) d.parentNode.removeChild(d); }
  var x = document.getElementById('guestX');
  if(x) x.onclick = close;
  var gl = document.getElementById('guestGoLogin');
  if(gl) gl.onclick = function(){ close(); guestLogin(); };
  var gh = document.getElementById('guestGoHome');
  if(gh) gh.onclick = function(){ close(); goHomeView(); };
  d.addEventListener('click', function(e){ if(e.target === d) close(); });
}

/* ---------- 登录后回到分享位置 ---------- */
function afterLoginResume(){
  if(!SHARE_CTX) return;
  var ctx = SHARE_CTX;
  clearGuest();
  openCat(ctx.boardId);
  if(ctx.card) setTimeout(function(){ locateBoardCard(ctx.card); }, 420);
}

/* ---------- 定位到具体卡片 ---------- */
function locateBoardCard(ref){
  var id = String(ref).replace(/"/g, '');
  var el = document.querySelector('#grid .card[data-card="' + id + '"]');
  if(!el) return;
  try{ el.scrollIntoView({ behavior:'smooth', block:'center' }); }
  catch(e){ try{ el.scrollIntoView(); }catch(e2){} }
  var old = el.style.outline;
  el.style.outline = '2px solid #c2410c';
  el.style.outlineOffset = '3px';
  setTimeout(function(){ el.style.outline = old || ''; el.style.outlineOffset = ''; }, 2600);
}

/* ---------- 上报板块目录 ----------
   后台是另一个页面，读不到这里的 SITE_DATA。首页启动时（登录状态下）把
   「现在到底有哪些板块、每个板块有哪些卡片」写一份到云端，后台就能列出来。
   以后新增板块，只要有人登录打开过一次首页，后台自动出现，不用改后台代码。 */
function reportBoardCatalog(){
  if(!isLoggedIn()) return;
  try{
    if(localStorage.getItem('__cls_cat_report') === SITE_VERSION) return;
  }catch(e){}
  var cats = SITE_DATA.categories.map(function(c){
    return {
      id: c.id,
      name: c.name,
      active: c.active !== false,
      cards: SITE_DATA.links
        .filter(function(l){ return l.categoryId === c.id; })
        .map(function(l){ return { id: l.id, title: l.title, sub: l.subtitle || '' }; })
    };
  });
  api('/boards?action=catalog', { method:'POST', body: { cats: cats } })
    .then(function(){ try{ localStorage.setItem('__cls_cat_report', SITE_VERSION); }catch(e){} })
    .catch(function(){});
}

/* ---- 隐藏娱乐天地（彩蛋：点击班徽5次 → 暗号 → 进入） ---- */
var HIDDEN_SALT = 'cls2505-hide-salt';
var HIDDEN_PASS_HASH = '0db4949b1a8623cc73323bb6755a91cc9e481dc55c485718c3701c0e7b4ace65';
var GAME_LEADERBOARD = {
  icon: "🏆",
  title: "游戏排行榜",
  desc: "四款领券游戏的历史总榜与本周榜",
  action: "openGameBoard"
};
var HIDDEN_FUN_LINKS = [
  { icon: "🗂️", title: "云智安（网页应用集合站）", desc: "集合多种网页应用，登录后即可使用，账号密码见下方", url: "https://yqzan.cn/", login: { user: "xsyzclass5", pass: "xsyz985211" } },
  { icon: "🕹️", title: "小霸王游戏厅", desc: "在线复古红白机游戏合集，找回童年", url: "https://yikm.net/" },
  { icon: "🧩", title: "2048", desc: "经典数字合成小游戏", url: "https://play2048.co/" },
  { icon: "🎮", title: "4399 小游戏", desc: "海量在线小游戏，点开即玩", url: "https://www.4399.com/" },
  { icon: "🎯", title: "7k7k 小游戏", desc: "另一大经典小游戏库", url: "https://www.7k7k.com/" },
  { icon: "🐍", title: "贪吃蛇", desc: "吃豆挑战：吃满50豆可赢点歌券（每周一张，周一刷新）", url: "games/snake.html" },
  { icon: "🧱", title: "俄罗斯方块", desc: "经典落块消除，手速大考", url: "games/tetris.html" },
  { icon: "🔨", title: "打地鼠", desc: "地鼠冒头就点，30秒挑战", url: "games/whack.html" },
  { icon: "🃏", title: "记忆翻牌", desc: "翻牌配对，练记忆力", url: "games/memory.html" },
  { icon: "🐦", title: "像素飞鸟", desc: "一飞冲天，穿过水管拿高分", url: "games/bird.html" },
  { icon: "🧱", title: "打砖块", desc: "弹球消砖，手感复古", url: "games/breakout.html" },
  { icon: "🍬", title: "消消乐", desc: "三连消除，连击爆分", url: "games/match3.html" },
  { icon: "💣", title: "扫雷", desc: "推理翻格，雷数自定", url: "games/minesweeper.html" },
  { icon: "🦘", title: "涂鸦跳跃", desc: "一路向上，踩弹簧起飞", url: "games/doodle.html" },
  { icon: "⚫", title: "五子棋", desc: "人机三档难度 / 本地双人", url: "games/gomoku.html" },
  { icon: "⭕", title: "井字棋", desc: "人机三档难度 / 本地双人", url: "games/tictactoe.html" },
  { icon: "♟", title: "中国象棋", desc: "完整规则，本地双人对战", url: "games/chess.html" },
  { icon: "✈️", title: "飞机大战", desc: "纵版射击，击落敌机冲高分", url: "games/plane.html" }
];
/**
 * 班徽手势：短按累计 5 次 → 隐藏娱乐天地；长按约 700ms → 管理后台。
 *
 * 为什么不用 onclick 做长按：
 *   onclick 在手指抬起时才触发，那时已经分不清「长按后松手」和「短按」了。
 *   所以长按必须靠 touchstart/mousedown 起计时，到点就执行；
 *   并且用 _badgeLongFired 标记，让随后必然到来的 click 自己作废，
 *   否则长按一次会顺带把计数器 +1，攒到 5 次就误开娱乐天地。
 *
 * 为什么要有移动阈值：
 *   手机上手指按下去很容易带一点位移（尤其从班徽往上下滑动页面时）。
 *   位移超过 10px 就判定为「滚动」，取消长按，避免误跳后台。
 */
var _badgeClicks = 0, _badgeTimer = null;
var _badgeHoldTimer = null, _badgeLongFired = false;
var _badgeStartX = 0, _badgeStartY = 0;
var BADGE_LONG_MS = 700;      /* 长按判定时长 */
var BADGE_MOVE_TOL = 10;      /* 移动超过这个像素数就取消长按 */

function badgeLongStart(x, y){
  _badgeLongFired = false;
  _badgeStartX = x;
  _badgeStartY = y;
  badgeLongCancel();                 /* 先清掉可能残留的上一次计时 */
  _badgeHoldTimer = setTimeout(function(){
    _badgeHoldTimer = null;
    _badgeLongFired = true;
    /* 长按成功：清掉短按计数，免得残留的次数过一会儿凑够 5 次 */
    _badgeClicks = 0;
    if(_badgeTimer){ clearTimeout(_badgeTimer); _badgeTimer = null; }
    badgeVibrate();
    try{ sessionStorage.setItem('cls_admin_from_home', '1'); }catch(e){}
    location.href = 'admin.html';
  }, BADGE_LONG_MS);
}

function badgeLongMove(x, y){
  /* 用 !== null 判断而不是真值判断：setTimeout 在部分环境下会返回 0，
     而 0 是 falsy，用 if(_badgeHoldTimer) 会漏判、导致长按取消不掉。 */
  if(_badgeHoldTimer === null || _badgeHoldTimer === undefined) return;
  var dx = Math.abs(x - _badgeStartX);
  var dy = Math.abs(y - _badgeStartY);
  if(dx > BADGE_MOVE_TOL || dy > BADGE_MOVE_TOL) badgeLongCancel();
}

function badgeLongCancel(){
  if(_badgeHoldTimer === null || _badgeHoldTimer === undefined) return;
  clearTimeout(_badgeHoldTimer);
  _badgeHoldTimer = null;
}

/** 轻微震动反馈，让用户知道“松手就跳走了”（不支持的浏览器静默跳过） */
function badgeVibrate(){
  try{
    if(navigator.vibrate) navigator.vibrate(18);
  }catch(e){}
}

function badgeClick(){
  /* 长按已经跳走了，这一次 click 是长按的尾巴，直接忽略 */
  if(_badgeLongFired){ _badgeLongFired = false; return; }

  _badgeClicks++;
  if(_badgeTimer !== null && _badgeTimer !== undefined) clearTimeout(_badgeTimer);
  _badgeTimer = setTimeout(function(){ _badgeClicks = 0; _badgeTimer = null; }, 3000);
  if(_badgeClicks >= 5){
    _badgeClicks = 0;
    openHiddenGate();
  }
}

/* 班徽的长按绑定。
   用事件委托挂在 document 上，而不是直接绑到 .logo 元素——
   因为 .logo 是页面中段渲染出来的，而这段脚本可能在它之前执行；
   委托到 document 后，无论班徽何时出现、出现几次，都能收到事件。

   注意 touchstart 必须是 passive:true：这里是纯监听，不 preventDefault，
   否则会拖慢移动端滚动。长按的取消只靠“松手不做事”实现，不需要阻止默认行为。 */
(function bindBadgeLongPress(){
  var lastTarget = null;

  function isBadge(node){
    /* 班徽是 <div class="logo"><img></div>，点在图片上要往上找一层 */
    while(node && node !== document){
      if(node.classList && node.classList.contains('logo')) return node;
      node = node.parentNode;
    }
    return null;
  }

  document.addEventListener('touchstart', function(e){
    var el = isBadge(e.target);
    if(!el) return;
    lastTarget = el;
    var t = e.touches && e.touches[0];
    if(t) badgeLongStart(t.clientX, t.clientY);
  }, { passive:true });

  document.addEventListener('touchmove', function(e){
    if(!lastTarget) return;
    var t = e.touches && e.touches[0];
    if(t) badgeLongMove(t.clientX, t.clientY);
  }, { passive:true });

  document.addEventListener('touchend', function(){
    lastTarget = null;
    badgeLongCancel();
  }, { passive:true });

  document.addEventListener('touchcancel', function(){
    lastTarget = null;
    badgeLongCancel();
  }, { passive:true });

  /* 鼠标设备（电脑上调试也能用） */
  document.addEventListener('mousedown', function(e){
    var el = isBadge(e.target);
    if(!el) return;
    lastTarget = el;
    badgeLongStart(e.clientX, e.clientY);
  });
  document.addEventListener('mousemove', function(e){
    if(!lastTarget) return;
    badgeLongMove(e.clientX, e.clientY);
  });
  document.addEventListener('mouseup', function(){
    lastTarget = null;
    badgeLongCancel();
  });

  /* 长按期间禁止系统弹出“选择图片/文字”菜单，否则手感很怪 */
  document.addEventListener('contextmenu', function(e){
    if(_badgeHoldTimer !== null && _badgeHoldTimer !== undefined && isBadge(e.target)){
      e.preventDefault();
    }
  });
})();
function openHiddenGate(){
  /* 门禁总开关关闭（GATE_ENABLED=false）时跳过暗号问答，直接进隐藏空间 */
  if(!gateOn()){ openHiddenView(); return; }
  var m = document.getElementById('hiddenGateMask');
  var inp = document.getElementById('hiddenGateInput');
  var err = document.getElementById('hiddenGateErr');
  if(inp) inp.value = '';
  if(err) err.textContent = '';
  if(m) m.classList.add('show');
}
function closeHiddenGate(){ var m = document.getElementById('hiddenGateMask'); if(m) m.classList.remove('show'); }
function submitHiddenGate(){
  var inp = document.getElementById('hiddenGateInput');
  var err = document.getElementById('hiddenGateErr');
  if(!inp || !err) return;
  var remain = lockRemain('hidden');
  if(remain > 0){
    startLockTimer('hidden', err, inp);
    return;
  }
  var v = hashSecret(normAnswer(inp.value || ''), HIDDEN_SALT);
  if(v === HIDDEN_PASS_HASH){
    onPassOk('hidden');
    if(__lockTimers['hidden']) clearInterval(__lockTimers['hidden']);
    SFX.success();
    closeHiddenGate();
    openHiddenView();
  }else{
    var r = onPassFail('hidden');
    SFX.error();
    err.textContent = r.remain > 0
      ? '💡 暗号不对，再想想（同学群目前人数？）　🔒 已连续错误 ' + r.count + ' 次，请 ' + Math.ceil(r.remain/1000) + ' 秒后再试'
      : '💡 暗号不对，再想想（同学群目前人数？）';
    inp.value = '';
    if(r.remain > 0) startLockTimer('hidden', err, inp);
  }
}
function renderHiddenView(){
  var grid = document.getElementById('hiddenViewGrid');
  if(!grid) return;
  /* 排行榜固定排在最前：它是「看结果」的入口，比「去玩」更需要被一眼看到。
     不写进 HIDDEN_FUN_LINKS 是因为那份列表支持拖拽自定义顺序，
     排行榜不该被同学拖到列表末尾找不到。 */
  var boardCard = (function(){
    var l = GAME_LEADERBOARD;
    return '<div class="hidden-fun-card" onclick="' + l.action + '()">' +
      '<span class="hidden-fun-icon">' + esc(l.icon) + '</span>' +
      '<span style="flex:1;min-width:0"><span class="hidden-fun-title">' + esc(l.title) + '</span><br><span class="hidden-fun-desc">' + esc(l.desc) + '</span></span>' +
    '</div>';
  })();
  grid.innerHTML = boardCard + uiGames().map(function(l){   /* 【自定义设置】小游戏顺序 */
    var loginHtml = l.login
      ? '<div class="hidden-fun-login">' +
        '<span>账号 <b style="color:#af410f">' + esc(l.login.user) + '</b></span>' +
        '<span>密码 <b style="color:#af410f">' + esc(l.login.pass) + '</b></span>' +
        '<button type="button" class="btn-qr" style="margin-left:auto;background:#9a3412" onclick="event.stopPropagation();copyText(\'' + jsq(l.login.user + ' / ' + l.login.pass) + '\',\'账号密码\')">复制</button>' +
        '</div>'
      : '';
    return '<div class="hidden-fun-card" onclick="' + (l.action ? l.action + '()' : "openLink('" + jsq(l.url) + "',true,'" + jsq(l.title || '隐藏彩蛋') + "')") + '">' +
      '<span class="hidden-fun-icon">' + esc(l.icon) + '</span>' +
      '<span style="flex:1;min-width:0"><span class="hidden-fun-title">' + esc(l.title) + '</span><br><span class="hidden-fun-desc">' + esc(l.desc) + '</span>' + loginHtml + '</span>' +
    '</div>';
  }).join('');
  /* v2.5.0：游戏列表里的图标 emoji 统一换成 SVG（列表每次重绘，这里就地转一次，不挂监听）。 */
  try{ iconifyStatic(grid); }catch(e){}
}

/* ============================================================
   游戏排行榜（第二十七轮 ⑪）
   ------------------------------------------------------------
   数据来自 /api/games?action=leaderboard，后端跨用户聚合
   cls_game_<key>_hi（历史最高）与 cls_game_week_<game>（本周最高）。
   必须登录才能看（榜上有姓名，不能匿名拉走）。
   ============================================================ */
var BOARD_STATE = { game: 'snake', range: 'all', data: null, loading: false, error: null };

function openGameBoard(){
  if(!isLoggedIn()){
    if(typeof uiMsg === 'function') uiMsg('看排行榜需要先登录班级账号', '#af410f');
    return;
  }
  var m = document.getElementById('gameBoardMask');
  if(!m) return;
  m.classList.add('show');
  boardPaint();
  boardLoad();
}
function closeGameBoard(){ var m=document.getElementById('gameBoardMask'); if(m) m.classList.remove('show'); }
function boardTab(game){ BOARD_STATE.game = game; boardPaint(); SFX.click && SFX.click(); }
function boardRange(range){ BOARD_STATE.range = range; boardPaint(); boardLoad(); SFX.click && SFX.click(); }

/* 只在首次打开 / 切榜单时真正拉数据，切游戏标签复用已拉到的数据 */
function boardLoad(){
  BOARD_STATE.loading = true; BOARD_STATE.error = null;
  boardPaint();
  api('/games?action=leaderboard&limit=50')
    .then(function(j){
      if(!j || !j.ok) throw new Error((j && j.error) || '接口返回异常');
      BOARD_STATE.data = j.games || {};
      BOARD_STATE.loading = false;
      boardPaint();
    })
    .catch(function(e){
      BOARD_STATE.loading = false;
      BOARD_STATE.error = String(e && e.message || e);
      boardPaint();
    });
}

function boardPaint(){
  var tabs = document.getElementById('boardTabs');
  var list = document.getElementById('boardList');
  var meta = document.getElementById('boardMeta');
  if(!tabs || !list) return;

  var GAMES = [
    { id:'snake',  name:'贪吃蛇',     icon:'worm',   unit:'豆' },
    { id:'bird',   name:'像素飞鸟',   icon:'bird',   unit:'管' },
    { id:'tetris', name:'俄罗斯方块', icon:'blocks', unit:'分' },
    { id:'doodle', name:'涂鸦跳跃',   icon:'rabbit', unit:'高度' },
  ];
  tabs.innerHTML = GAMES.map(function(g){
    return '<button class="board-tab' + (BOARD_STATE.game === g.id ? ' active' : '') +
      '" onclick="boardTab(\'' + g.id + '\')">' + iconSvg(g.icon,15) + ' ' + esc(g.name) + '</button>';
  }).join('');

  if(meta){
    meta.innerHTML =
      '<button class="board-range' + (BOARD_STATE.range === 'all' ? ' active' : '') + '" onclick="boardRange(\'all\')">历史总榜</button>' +
      '<button class="board-range' + (BOARD_STATE.range === 'week' ? ' active' : '') + '" onclick="boardRange(\'week\')">本周榜</button>';
  }

  if(BOARD_STATE.loading){ list.innerHTML = '<div class="board-empty">正在读取排行榜…</div>'; return; }
  if(BOARD_STATE.error){
    list.innerHTML = '<div class="board-empty">读取失败：' + esc(BOARD_STATE.error) +
      '<br><button class="btn btn-secondary" style="margin-top:10px" onclick="boardLoad()">重试</button></div>';
    return;
  }
  var g = BOARD_STATE.data && BOARD_STATE.data[BOARD_STATE.game];
  if(!g || !g.ranks || !g.ranks.length){
    list.innerHTML = '<div class="board-empty">' +
      (BOARD_STATE.range === 'week' ? '本周还没有人上榜，快去做第一个！' : '还没有人上榜，快去玩一局！') +
      '</div>';
    return;
  }
  list.innerHTML = g.ranks.map(function(r){
    var m = r.rank <= 3 ? iconSvg('medal',16) : ('<span class="board-rank">' + r.rank + '</span>');
    return '<div class="board-row' + (r.rank <= 3 ? ' top' : '') + '">' +
      '<span class="board-medal">' + m + '</span>' +
      '<span class="board-name">' + esc(r.name) + '</span>' +
      '<span class="board-score">' + esc(String(r.score)) + ' <i>' + esc(g.meta ? g.meta.unit : '') + '</i></span>' +
    '</div>';
  }).join('');
}
function openHiddenView(){
  renderHiddenView();
  var m = document.getElementById('hiddenViewMask');
  if(m) m.classList.add('show');
}
function closeHiddenView(){ var m = document.getElementById('hiddenViewMask'); if(m) m.classList.remove('show'); }

/* ---- 密码错误自锁（2026-08-26 用户规则）----
 * 规则：同一入口连续输错超过 3 次锁定 30s，此后每次再错递增（1/2/5/10/30/60 分钟封顶）。
 * 状态存 localStorage：刷新 / 退出重进依然锁定。输对一次即清零。
 * 每个密码入口一个 scope，互不影响。 */
var LOCK_LEVELS = [0,0,0,0,30,60,120,300,600,1200,3600]; // index=累计失败次数：1-3次不锁，4→30s，5→60s，6→120s，7→300s，8→600s，9→1200s，10+→3600s（封顶）
function lockKey(scope){ return 'cls_lock_'+scope; }
function getLock(scope){
  try{
    var s = localStorage.getItem(lockKey(scope));
    if(!s) return {count:0, until:0};
    var d = JSON.parse(s);
    return {count:(d.count|0)||0, until:(typeof d.until==='number' ? d.until : 0)};
  }catch(e){ return {count:0, until:0}; }
}
function setLock(scope, data){ try{ localStorage.setItem(lockKey(scope), JSON.stringify(data)); }catch(e){} }
function lockRemain(scope){ return Math.max(0, (getLock(scope).until) - Date.now()); }
function lockSec(level){ return level >= LOCK_LEVELS.length ? LOCK_LEVELS[LOCK_LEVELS.length-1] : LOCK_LEVELS[level]; }
function onPassFail(scope){
  var d = getLock(scope); d.count++;
  var sec = lockSec(d.count);
  d.until = sec > 0 ? Date.now() + sec*1000 : 0;
  setLock(scope, d);
  return {count:d.count, remain:sec > 0 ? sec*1000 : 0};
}
function onPassOk(scope){ setLock(scope, {count:0, until:0}); }
function lockRemainSec(scope){ return Math.ceil(lockRemain(scope)/1000); }
/* 锁定倒计时：每秒刷新提示并禁用输入框，到点自动恢复 */
function showLockCountdown(scope, errEl, inputEl){
  var t = null;
  var tick = function(){
    var r = lockRemain(scope);
    if(r <= 0){
      if(t) clearInterval(t);
      if(inputEl) inputEl.disabled = false;
      if(errEl) errEl.textContent = '';
      return;
    }
    if(errEl) errEl.textContent = '🔒 连续输错次数过多，请 ' + Math.ceil(r/1000) + ' 秒后再试';
  };
  if(inputEl) inputEl.disabled = true;
  tick();
  t = setInterval(tick, 1000);
  return t;
}
var __lockTimers = {};
function startLockTimer(scope, errEl, inputEl){
  if(__lockTimers[scope]) clearInterval(__lockTimers[scope]);
  __lockTimers[scope] = showLockCountdown(scope, errEl, inputEl);
}

/* ---- 学习资料问答（gate）---- */
function findLink(id){
  for(var i=0;i<SITE_DATA.links.length;i++){ if(SITE_DATA.links[i].id===id) return SITE_DATA.links[i]; }
  return null;
}
/* ---- 门禁链接的运行时解混淆（2026-08-30 站主要求） ----
 * 问题：云盘链接与访问码此前以**明文**写在数据里，任何人「查看源文件(Ctrl+U)」就能抄走，
 *       门禁问题形同虚设——答案做了哈希加盐，链接却裸奔。
 * 方案：源码里只存 XOR + Base64 的密文（sUrl / sCode），页面渲染时才用 GATE_SEAL_KEY 还原。
 * ⚠️ 这是**混淆不是加密**：密钥就在同一份 JS 里，懂技术的人照样能还原。
 *    它解决的是「同学随手 Ctrl+U 就抄走链接」这个真实场景，**不是**抗专业逆向。
 *    若要更强，可升级为「答案派生密钥」（不知道答案就解不开），但那要求问题足够难——
 *    现有「男女人数之比」的答案空间仅约 10 种，会被秒破，所以先不上这层，详见 internal/notes.md。 */
var GATE_SEAL_KEY = 'cls25-05-study-2026';
/* ============================================================
 * 【门禁总开关】站主 2026-09-27 要求：暂时取消站内所有「门禁密码」
 * ------------------------------------------------------------
 *  true  = 开启门禁（进站问答 / 学习资料 / 隐藏空间都要答对才进）
 *  false = 全部停用——直接放行，不再弹任何问答框
 *
 * ⚠️ 实现原则：只停用，**不删任何门禁代码**。
 *    所有校验逻辑、答案、提示、锁定时长原样保留，
 *    将来把这里改回 true（或删掉这个常量）即可一键全部恢复。
 * ⚠️ 本开关只管「门禁」（浏览类入口），**不管数据加密**：
 *    「导出备份」「数据管理导出」的密码是保护姓名等个人信息的，
 *    不是门禁，不受本开关影响，照常要求输入。
 * ============================================================ */
var GATE_ENABLED = false;
/* 门禁是否启用：GATE_ENABLED 为 false 时一律放行 */
function gateOn(){ return GATE_ENABLED === true; }
function gateUnseal(b64){
  if(!b64) return '';
  try{
    var raw = atob(b64), out = '', k = GATE_SEAL_KEY;
    for(var i=0;i<raw.length;i++){
      out += String.fromCharCode((raw.charCodeAt(i) ^ k.charCodeAt(i % k.length)) & 0xff);
    }
    return out;
  }catch(e){ return ''; }
}
/* 取门禁链接 / 访问码：优先解密封字段，解密失败或没有则回退明文（兼容未加密的旧数据） */
function gateUrl(l){
  if(!l || !l.gate) return '';
  var v = l.gate.sUrl ? gateUnseal(l.gate.sUrl) : '';
  return v || l.gate.url || '';
}
function gateCode(l){
  if(!l || !l.gate) return '';
  var v = l.gate.sCode ? gateUnseal(l.gate.sCode) : '';
  return v || l.gate.code || '';
}
function gatePassed(l){
  if(!l || !l.gate) return false;
  try{
    return localStorage.getItem('cls_gate_'+l.id)==='ok' && localStorage.getItem('cls_gate_'+l.id+'_v')===l.gate.version;
  }catch(e){ return false; }
}
function checkGate(id){
  var l = findLink(id);
  if(!l || !l.gate) return;
  /* 门禁总开关关闭（GATE_ENABLED=false）：直接放行，不做任何校验 */
  if(!gateOn()){ render(); return; }
  var input = document.getElementById('gate-input-'+id);
  var remain = lockRemain('gate_'+id);
  if(remain > 0){
    if(!window.__gateErr) window.__gateErr = {};
    window.__gateErr[id] = '🔒 连续输错次数过多，请 ' + Math.ceil(remain/1000) + ' 秒后再试';
    render();
    return;
  }
  var v = hashSecret(normAnswer(input ? input.value : ''), GATE_SALT);
  var ok = false;
  for(var j=0;j<l.gate.answers.length;j++){
    if(l.gate.answers[j]===v){ ok=true; break; }
  }
  if(ok){
    onPassOk('gate_'+id);
    try{
      localStorage.setItem('cls_gate_'+id,'ok');
      localStorage.setItem('cls_gate_'+id+'_v', l.gate.version);
    }catch(e){}
    if(window.__gateErr) delete window.__gateErr[id];
    SFX.success();
  }else{
    var r = onPassFail('gate_'+id);
    SFX.error();
    if(!window.__gateErr) window.__gateErr = {};
    window.__gateErr[id] = r.remain > 0
      ? '💡 ' + l.gate.hint + '　🔒 已连续错误 ' + r.count + ' 次，请 ' + Math.ceil(r.remain/1000) + ' 秒后再试'
      : '💡 ' + l.gate.hint;
  }
  render();
}
function copyCode(id){
  var l = findLink(id);
  if(!l || !l.gate) return;
  var cd = gateCode(l);            /* 运行时解密，源码里是密文 */
  if(!cd){ alert('访问码待开放'); return; }
  var txt = '访问码：'+cd;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(cd).then(function(){ alert('访问码已复制：'+cd); }, function(){ alert(txt); });
  }else{ alert(txt); }
}
var EYE_OPEN_HTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
var EYE_OFF_HTML  = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
/* 眼睛开关：只切换「遮蔽样式」，不改 input type。
   原因：type="password" 会被浏览器强制禁用中文输入法（IME），导致中文类答案打不出来；
   改用 type=text + -webkit-text-security 遮蔽，既显示成圆点，又能正常调用系统中文输入法。 */
function togglePwd(inputId, btn){
  var el = document.getElementById(inputId);
  if(!el) return;
  el.classList.toggle('pwd-plain');
  var plain = el.classList.contains('pwd-plain');
  btn.innerHTML = plain ? EYE_OFF_HTML : EYE_OPEN_HTML;
  btn.setAttribute('aria-label', plain ? '隐藏密码' : '显示密码');
}
/* 兜底：不支持 text-security 的浏览器（如 Firefox）无法用 CSS 遮蔽，
   退回 type=password 保证不泄露，并提示「点眼睛显示后即可用输入法打中文」。 */
(function initPwdMaskFallback(){
  var supported = false;
  try{ supported = !!(window.CSS && CSS.supports && (CSS.supports('-webkit-text-security','disc') || CSS.supports('text-security','disc'))); }catch(e){}
  if(supported) return;
  function downgrade(){
    var els = document.querySelectorAll('input.pwd-mask');
    for(var i=0;i<els.length;i++){
      var el = els[i];
      el.classList.remove('pwd-mask','pwd-plain');
      if(el.type === 'text') el.type = 'password';
      var wrap = el.parentNode;
      if(wrap && !wrap.querySelector('.pwd-ime-tip')){
        var tip = document.createElement('p');
        tip.className = 'pwd-ime-tip';
        tip.textContent = '💡 本浏览器不支持密码遮蔽；若无法输入中文，点右侧眼睛「显示」后再输入即可。';
        wrap.appendChild(tip);
      }
    }
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', downgrade);
  else downgrade();
})();
function copyText(val, label){
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(val).then(function(){ alert(label+'已复制：'+val); }, function(){ alert(val); });
  }else{ alert(val); }
}
/* ============================================================
   个人资料查询（2026-10-05 后端化改造）
   ------------------------------------------------------------
   与旧实现的关键区别：
     · 数据源从「前端 SITE_DATA.contacts 密文数组」改为后端 /api/profile
       旧方案把 XOR 密文与密钥放在同一份 JS 里，等于公开，必须废弃。
     · 查询必须登录；未登录在渲染层就已经拦住了，这里再兜一次底。
     · 每次查询由后端记录「谁在什么时候查了谁」，管理员可查。
     · 查到本人时，结果里直接带出「补充联系方式」的编辑区（就地编辑）。
   ============================================================ */

/** 当前查询结果缓存，供评论区 / 编辑区复用，避免重复请求 */
var PC_RESULTS = {};

function findContact(id){
  var l = findLink(id);
  if(!l) return;
  var input = document.getElementById('contact-input-'+id);
  var out = document.getElementById('contact-out-'+id);
  if(!out) return;

  var q = (input ? input.value : '').trim();

  /* 未登录兜底：正常情况下卡片已经是登录引导，这里防直接调函数绕过 */
  if(!isLoggedIn()){
    out.innerHTML = '<span style="color:#af410f">请先登录后再查询</span>';
    return;
  }
  if(!q){ out.innerHTML = '<span style="color:#af410f">请输入姓名或学号</span>'; return; }

  out.innerHTML = '<span style="color:#6e635a">查询中…</span>';

  api('/profile?action=search&q=' + encodeURIComponent(q)).then(function(j){
    if(!j || !j.ok){
      out.innerHTML = '<span style="color:#af410f">' + esc((j && j.error) || '查询失败') + '</span>';
      return;
    }
    PC_RESULTS[String(id)] = j.results || [];
    renderContactResults(id, out, j);
  }).catch(function(e){
    out.innerHTML = '<span style="color:#af410f">' + esc(e && e.message ? e.message : '网络异常，请稍后再试') + '</span>';
  });
}

/** 把后端返回的结果渲染成卡片列表 */
function renderContactResults(id, out, j){
  var list = j.results || [];
  out.innerHTML = '';
  out.style.color = '';

  if(!list.length){
    out.innerHTML = '<span style="color:#af410f">'+(j.message ? esc(j.message) : '未找到匹配的资料')+
      '<br><span style="font-size:.82em;color:#6e635a">提示：可以试试学号后几位，或确认姓名是否写全。</span></span>';
    return;
  }

  var wrap = document.createElement('div');
  wrap.className = 'pc-list';

  list.forEach(function(p){
    var card = document.createElement('div');
    card.className = 'pc-card';

    /* ---- 姓名 + 身份徽章 ---- */
    var head = document.createElement('div');
    head.className = 'pc-head';
    var nm = document.createElement('span');
    nm.className = 'pc-name';
    nm.textContent = p.name || '(未录入姓名)';
    head.appendChild(nm);
    if(p.studentId){
      var s1 = document.createElement('span');
      s1.className = 'badge badge-blue';
      s1.textContent = '学号 ' + p.studentId;
      head.appendChild(s1);
    }
    if(p.role){
      var r1 = document.createElement('span');
      r1.className = p.role === '老师' ? 'badge badge-orange'
                    : (p.role === '管理员' ? 'badge badge-green' : 'badge badge-blue');
      r1.textContent = p.role;
      head.appendChild(r1);
    }
    if(p.politics){
      var pl = document.createElement('span');
      /* 政治面貌配色沿用原设计：中共党员=红、共青团员=青绿、其他=灰。
         用 indexOf 而非全等，确保「共青团员 · 团支书」也归入青绿。 */
      pl.className = p.politics.indexOf('中共党员') >= 0 ? 'badge badge-red'
                   : (p.politics.indexOf('共青团员') >= 0 ? 'badge badge-teal' : 'badge badge-gray');
      pl.textContent = p.politics;
      head.appendChild(pl);
    }
    /* v3.5.21：头衔（可兼多职，profiles.title 存英文逗号分隔） */
    var pcTitles = String(p.title || '').split(/[,，、]/).map(function(s){ return s.trim(); }).filter(Boolean);
    pcTitles.forEach(function(t){
      var tb = document.createElement('span');
      tb.className = 'badge badge-purple';
      tb.textContent = t;
      head.appendChild(tb);
    });
    card.appendChild(head);

    /* ---- 基础资料 + 额外资料字段（2026-10-09 v2.4.0，v3.5.21 重构）----
       站主反馈「后台把智学网账号开放成公开，前端还是查不到」——
       根因是这里只渲染 p.fields（额外字段），而 exam_no / 学号属于固定字段，
       后端早就返回了 p.examNo，前端却从来没画出来。
       现在固定字段先行、额外字段随后，统一成「标签 + 值 + 复制」的行，
       和后台的字段明细保持同一套视觉。 */
    var fx = document.createElement('div');
    fx.className = 'pc-extra';

    function pcAddRow(label, val){
      if(val == null || val === '') return;
      var row = document.createElement('div');
      row.className = 'pc-row';
      var k = document.createElement('span');
      k.className = 'pc-key';
      k.textContent = label;
      var v = document.createElement('span');
      v.className = 'pc-val';
      v.textContent = val;
      var b = document.createElement('button');
      b.className = 'pc-copy';
      b.type = 'button';
      b.textContent = '复制';
      b.onclick = function(){ copyText(String(val), label); };
      row.appendChild(k); row.appendChild(v); row.appendChild(b);
      fx.appendChild(row);
    }

    pcAddRow('学号', p.studentId);
    pcAddRow('智学网账号', p.examNo);
    if(pcTitles.length) pcAddRow('头衔', pcTitles.join('、'));

    if(Array.isArray(p.fields) && p.fields.length){
      p.fields.forEach(function(f){
        if(!f || !f.value) return;
        pcAddRow(f.label || f.field, f.value);
      });
    }
    if(fx.childNodes.length) card.appendChild(fx);

    /* ---- 联系方式区 ---- */
    var ct = document.createElement('div');
    ct.className = 'pc-contact';

    if(p.contactVisible && (p.wechat || p.qq || p.phone)){
      /* 已审核通过（或本人自己看）→ 展示可复制 */
      [['微信', p.wechat], ['QQ', p.qq], ['手机', p.phone]].forEach(function(pair){
        if(!pair[1]) return;
        var row = document.createElement('div');
        row.className = 'pc-row';
        var k = document.createElement('span');
        k.className = 'pc-key';
        k.textContent = pair[0];
        var v = document.createElement('span');
        v.className = 'pc-val';
        v.textContent = pair[1];
        var b = document.createElement('button');
        b.className = 'pc-copy';
        b.type = 'button';
        b.textContent = '复制';
        b.onclick = function(){ copyText(pair[1], pair[0]); };
        row.appendChild(k); row.appendChild(v); row.appendChild(b);
        ct.appendChild(row);
      });
    }else if(p.contactStatus === 'pending'){
      ct.innerHTML = '<span class="pc-pending">⏳ 联系方式已提交，等待管理员核实后展示</span>';
    }else if(p.contactStatus === 'rejected'){
      ct.innerHTML = '<span class="pc-pending">' + iconSvg('triangle-alert',14) + ' 联系方式未通过核实，暂不展示</span>';
    }else{
      ct.innerHTML = '<span class="pc-pending">该同学还没有填写联系方式</span>';
    }
    card.appendChild(ct);

    /* ---- 本人的话，就地给出补充 / 修改入口 ---- */
    if(p.id && PC_MY_PROFILE_ID && Number(PC_MY_PROFILE_ID) === Number(p.id)){
      var edit = document.createElement('div');
      edit.className = 'pc-edit';
      edit.innerHTML =
        '<div class="pc-edit-title">✏️ 这是你自己的资料，可填写或修改联系方式</div>' +
        /* v3.5.40（站主 #1）：后台开了「本人可编辑」的其它字段，去「我的资料」里改 */
        '<div style="margin:-2px 0 10px;font-size:.78rem;color:var(--fg-3,#6e635a)">'
          + '带「改」的其它字段（如身份证号、入团时间）在「我的资料」里改，'
          + '<button type="button" onclick="openMyProfile()" '
          +   'style="background:none;border:none;padding:0;font:inherit;font-weight:700;color:var(--accent,#c2410c);cursor:pointer;text-decoration:underline">'
          + '去我的资料</button></div>' +
        '<div class="pc-edit-grid">' +
          '<input class="pc-inp" id="pc-wx-'+id+'" type="text" placeholder="微信号" value="'+esc(p.wechat || '')+'">' +
          '<input class="pc-inp" id="pc-qq-'+id+'" type="text" placeholder="QQ 号" value="'+esc(p.qq || '')+'">' +
          '<input class="pc-inp" id="pc-ph-'+id+'" type="text" placeholder="手机号" value="'+esc(p.phone || '')+'">' +
        '</div>' +
        '<div class="pc-edit-actions">' +
          '<button class="btn gate-btn" type="button" onclick="pcSubmitContact('+id+')">提交核实</button>' +
          '<span class="pc-edit-tip" id="pc-tip-'+id+'">提交后需管理员核实通过，才会对同学展示</span>' +
        '</div>';
      card.appendChild(edit);
    }

    wrap.appendChild(card);
  });

  out.appendChild(wrap);
}

/** 提交自己的联系方式（进待审） */
function pcSubmitContact(id){
  var tip = document.getElementById('pc-tip-'+id);
  var wx = (document.getElementById('pc-wx-'+id) || {}).value || '';
  var qq = (document.getElementById('pc-qq-'+id) || {}).value || '';
  var ph = (document.getElementById('pc-ph-'+id) || {}).value || '';
  wx = wx.trim(); qq = qq.trim(); ph = ph.trim();

  if(!wx && !qq && !ph){
    if(tip){ tip.textContent = '请至少填写一项联系方式'; tip.style.color = '#af410f'; }
    return;
  }
  if(tip){ tip.textContent = '提交中…'; tip.style.color = '#6e635a'; }

  api('/profile?action=submit', {
    method:'POST',
    body: { wechat: wx, qq: qq, phone: ph }
  }).then(function(j){
    if(j && j.ok){
      if(tip){ tip.textContent = '✅ ' + (j.message || '已提交，等待核实'); tip.style.color = '#0f7b4f'; }
      /* 重新查一次，让状态立刻变为「待核实」 */
      setTimeout(function(){ findContact(id); }, 800);
    }else{
      if(tip){ tip.textContent = '❌ ' + ((j && j.error) || '提交失败'); tip.style.color = '#af410f'; }
    }
  }).catch(function(e){
    if(tip){ tip.textContent = '❌ ' + (e && e.message ? e.message : '网络异常'); tip.style.color = '#af410f'; }
  });
}

/** 拉取「我认领的资料」信息，缓存到 PC_MY_PROFILE_ID，供结果页判断是否本人 */
var PC_MY_PROFILE_ID = null;
function pcLoadMyProfile(){
  if(!isLoggedIn()) { PC_MY_PROFILE_ID = null; return; }
  api('/profile?action=me').then(function(j){
    if(j && j.ok && j.profile) PC_MY_PROFILE_ID = j.profile.id;
  }).catch(function(){ /* 静默失败，不影响查询 */ });
}

/* ---- 登录引导弹窗（需求：开屏引导用户登录来上传云端） ----
   弹的条件（三个都满足才弹）：
     ① 没登录；② 之前没弹过（cls_login_guide_v1）；③ 站点后端配好了（没后端登录也没意义）
   关掉就记一笔，之后不再打扰。 */
function maybeShowLoginGuide(){
  try{
    if(isLoggedIn()) return;
    /* v3.8.4：从分享链接（?t=）进来的访客是来看某个板块的，别一进门就推销登录
       v3.8.6：?play= 播放页同理，否则扫码后被登录弹窗整个盖住 */
    if(isShareEntry()) return;
    if(localStorage.getItem('cls_login_guide_v1') === '1') return;
    if(!apiReady()) return;
  }catch(e){ return; }
  var m = document.getElementById('loginGuideMask');
  if(!m) return;
  /* 如果此刻正压着别的弹窗（比如站点门禁），就别挤在一起弹 */
  if(document.getElementById('siteGate') && document.getElementById('siteGate').classList.contains('show')) return;
  m.classList.add('show');
}
/** @param {boolean} gotoLogin true = 顺手把登录框打开 */
function closeLoginGuide(gotoLogin){
  var m = document.getElementById('loginGuideMask');
  if(m) m.classList.remove('show');
  try{ localStorage.setItem('cls_login_guide_v1','1'); }catch(e){}
  if(gotoLogin) setTimeout(openAccount, 200);
}

/* ---- 全部公告弹窗（按板块折叠 / 搜索 / 范围筛选 / 模糊匹配） ---- */
var ANN_CATS = [
  { key: 'site',     name: '📡 网站内部' },
  { key: 'activity', name: '🔔 重要更新' },
  { key: 'class',    name: '🏫 班级事务' },
  { key: 'misc',     name: '💭 站主杂谈' }
];
/* 相近词词典：模糊搜索用，猜用户实际想搜什么（彩蛋 ↔ 隐藏 ↔ 暗号 …） */
var ANN_SYN = {
  '彩蛋':['彩蛋','隐藏','暗号','秘密','探索','入口'],
  '隐藏':['隐藏','彩蛋','暗号','秘密','探索','入口'],
  '暗号':['暗号','密码','彩蛋','隐藏','口令'],
  '密码':['密码','暗号','口令','验证'],
  '点歌':['点歌','音乐','歌曲','歌','点歌券'],
  '点歌券':['点歌券','点歌','券','奖励'],
  '歌':['歌','音乐','点歌'],
  '音乐':['音乐','点歌','歌曲','歌'],
  '游戏':['游戏','小游戏','娱乐','天地'],
  '娱乐':['娱乐','游戏','小游戏'],
  '作业':['作业','假期','暑假','寒假'],
  '考试':['考试','测验','成绩','分数'],
  '签到':['签到','班级签','签'],
  '数据':['数据','备份','导出','导入','清理','重置'],
  '备份':['备份','数据','导出','zip'],
  '更新':['更新','修复','新增','上线','优化','bug'],
  '修复':['修复','更新','bug','问题','优化'],
  '安全':['安全','加密','锁','锁定'],
  '锁':['锁','锁定','密码','安全'],
  '加密':['加密','安全','密文'],
  '主题':['主题','深色','浅色','皮肤'],
  '音效':['音效','声音','音'],
  '清理':['清理','重置','清空','初始化'],
  '重置':['重置','清理','清空','初始化']
};
function annExpand(q){
  var toks=[], seen={};
  String(q||'').toLowerCase().split(/\s+/).forEach(function(w){
    if(!w || seen[w]) return;
    seen[w]=1; toks.push(w);
    var syn=ANN_SYN[w];
    if(syn) syn.forEach(function(s){ s=s.toLowerCase(); if(!seen[s]){ seen[s]=1; toks.push(s); } });
  });
  return toks;
}
function annMatch(a,q){
  var toks=annExpand(q);
  if(!toks.length) return true;
  var t=a.text.toLowerCase();
  for(var i=0;i<toks.length;i++){ if(t.indexOf(toks[i])>=0) return true; }
  return false;
}
function annHighlight(a,q){
  var html=emojiEscHtml(a.text);
  var toks=annExpand(q).sort(function(x,y){ return y.length-x.length; });
  for(var i=0;i<toks.length;i++){
    var k=toks[i]; if(!k) continue;
    var re=new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi');
    html=html.replace(re,function(m){ return '<mark>'+m+'</mark>'; });
  }
  return html;
}
function annDateOk(a,time,from,to){
  if(!time || time==='all') return true;
  var d=(a.date||'').slice(0,10);
  if(!d) return false;
  if(time==='custom'){
    if(from && d<from) return false;
    if(to && d>to) return false;
    return true;
  }
  var days = time==='3d'?3:time==='7d'?7:time==='15d'?15:time==='30d'?30:time==='180d'?180:0;
  if(days<=0) return true;
  var cut=new Date(); cut.setDate(cut.getDate()-days);
  var c=cut.getFullYear()+'-'+((cut.getMonth()+1)<10?'0':'')+(cut.getMonth()+1)+'-'+(cut.getDate()<10?'0':'')+cut.getDate();
  return d>=c;
}
function toggleAnnCat(h){
  var li=h.parentNode; if(li) li.classList.toggle('collapsed');
}
function onAllSearchInput(){ renderAllBoard(); }
var ANN_FILTER_KEY='cls_ann_filter';
function saveAnnFilter(){
  try{
    var t=document.getElementById('allSearchTime'), c=document.getElementById('allSearchCat'),
        f=document.getElementById('allDateFrom'), t2=document.getElementById('allDateTo');
    if(t) localStorage.setItem(ANN_FILTER_KEY, JSON.stringify({t:t.value, c:c?c.value:'all', f:f?f.value:'', t2:t2?t2.value:''}));
  }catch(e){}
}
function loadAnnFilter(){ try{ return JSON.parse(localStorage.getItem(ANN_FILTER_KEY))||{}; }catch(e){ return {}; } }
function onAllSearchScope(){
  var t=document.getElementById('allSearchTime'), r=document.getElementById('allDateRange');
  if(r && t) r.style.display=(t.value==='custom')?'flex':'none';
  renderAllBoard();
}
function renderAllBoard(){
  var list=document.getElementById('allBoardList');
  if(!list) return;
  var title=document.getElementById('allBoardTitle');
  var inp=document.getElementById('allSearchInput');
  var catSel=document.getElementById('allSearchCat');
  var timeSel=document.getElementById('allSearchTime');
  var fromInp=document.getElementById('allDateFrom');
  var toInp=document.getElementById('allDateTo');
  var q=inp?inp.value.trim():'';
  var ck=catSel?catSel.value:'all';
  var tk=timeSel?timeSel.value:'all';
  var from=fromInp?fromInp.value:'';
  var to=toInp?toInp.value:'';
  var ann=(SITE_DATA.announcements||[]).slice().sort(function(a,b){
    if((isImportant(b)?1:0)!==(isImportant(a)?1:0)) return (isImportant(b)?1:0)-(isImportant(a)?1:0);
    return (b.date||'').localeCompare(a.date||'');
  });
  var scoped=ann.filter(function(a){
    if(ck!=='all' && (a.category||'misc')!==ck) return false;
    return annDateOk(a,tk,from,to);
  });
  saveAnnFilter();
  if(q){
    var hits=scoped.filter(function(a){ return annMatch(a,q); });
    if(title) title.textContent='搜索「'+q+'」· 命中 '+hits.length+' / 范围内 '+scoped.length+' 条';
    list.innerHTML=hits.length
      ? '<li class="ann-cat"><h4 style="margin:12px 0 8px;color:#af410f;font-size:.95rem">🔎 匹配结果（'+hits.length+'）</h4>'+
        '<ul style="list-style:none;padding:0;margin:0">'+hits.map(function(a){
          return '<li class="ann-item hl"><div class="board-meta">'+
            '<span class="board-date'+(isImportant(a)?' hot':'')+'">'+esc(a.date.slice(5))+'</span>'+
            (isImportant(a)?'<span class="board-pin">'+(a.importantUntil?'限时置顶':'置顶')+'</span>':'')+'</div>'+
            '<p class="board-text">'+annHighlight(a,q)+'</p></li>';
        }).join('')+'</ul></li>'
      : '<li style="padding:18px;color:#6e635a;text-align:center">未找到匹配公告，可试试相近词（如「彩蛋 / 隐藏」）</li>';
  }else{
    if(title) title.textContent='全部公告（'+scoped.length+' 条）';
    var grouped={};
    scoped.forEach(function(a){ var c=a.category||'misc'; (grouped[c]=grouped[c]||[]).push(a); });
    var html=uiAnnCats(ANN_CATS).map(function(c){   /* 【自定义设置】分类顺序 */
      var items=grouped[c.key];
      if(!items||!items.length) return '';
      return '<li class="ann-cat"><h4 onclick="toggleAnnCat(this)" style="margin:12px 0 8px;color:#af410f;font-size:.95rem;cursor:pointer;user-select:none">'+esc(c.name)+'（'+items.length+'）▾</h4>'+
        '<ul style="list-style:none;padding:0;margin:0">'+items.map(function(a){
          return '<li class="ann-item"><div class="board-meta">'+
            '<span class="board-date'+(isImportant(a)?' hot':'')+'">'+esc(a.date.slice(5))+'</span>'+
            (isImportant(a)?'<span class="board-pin">'+(a.importantUntil?'限时置顶':'置顶')+'</span>':'')+'</div>'+
            '<p class="board-text">'+emojiEscHtml(a.text)+'</p></li>';
        }).join('')+'</ul></li>';
    }).filter(Boolean).join('') || '<li style="padding:18px;color:#6e635a;text-align:center">暂无公告</li>';
    list.innerHTML=html;
  }
}
function showAllBoard(){
  var mask=document.getElementById('allBoardMask');
  if(mask){
    var f=loadAnnFilter();
    var t=document.getElementById('allSearchTime'), c=document.getElementById('allSearchCat'),
        fi=document.getElementById('allDateFrom'), ti=document.getElementById('allDateTo');
    if(t && f.t) t.value=f.t;
    if(c && f.c) c.value=f.c;
    if(fi && f.f) fi.value=f.f;
    if(ti && f.t2) ti.value=f.t2;
    onAllSearchScope();
    mask.classList.add('show');
  }
}
function closeAllBoard(){
  var m=document.getElementById('allBoardMask');
  if(m) m.classList.remove('show');
}

/* ---- 全部重要日期 / 法定节假日 弹窗 ---- */
function fmtFullDate(d){
  var w = ['日','一','二','三','四','五','六'][d.getDay()];
  var pad = function(n){ return n<10?'0'+n:n; };
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' 周'+w+' '+pad(d.getHours())+':'+pad(d.getMinutes());
}
var impTimer = null;
function renderAllImp(){
  var list = document.getElementById('allImpList');
  if(!list) return;
  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  /* ⚠️ map 出来的对象是新的，必须显式带上 endDate / scope ——
     若不写进来，后面渲染时 d.endDate 永远是 undefined，
     就会退回到「单日」的老格式，且不会出现「查看考试范围」入口。
     这个坑已经踩过一次（2026-09-29），改这里务必连同整行一起看。 */
  var arr = IMPORTANT_DATES.map(function(d){
    return { name:d.name, date:d.date, d:new Date(d.date), endDate:d.endDate, scope:d.scope };
  })
    .sort(function(a,b){ return a.d - b.d; });
  list.innerHTML = arr.map(function(d){
    /* 三种状态（v2.6.7）：未开始→倒计时；进行中→「进行中」；已结束→「已结束」。
       列表里保留历史条目（带「已过」标记），只有首页那个小面板才会把已结束的整条隐去。 */
    var st = impState(d, now);
    /* 日期行：跨天的事项（如段考 13—14 日）显示区间，单日的照旧显示完整时间 */
    var dateText = d.endDate
      ? fmtDayCn(new Date(d.date)) + ' — ' + fmtDayCn(new Date(d.endDate + 'T00:00:00'))
      : fmtFullDate(d.d);
    var badge = st === 'during'
      ? '<span class="board-pin imp-during-pin">进行中</span>'
      : (st === 'over' ? '<span class="board-pin" style="background:#6e635a">已过</span>' : '');
    var right = st === 'during' ? '<span class="imp-during">进行中</span>'
      : (st === 'over' ? '<span class="imp-over">已结束</span>' : impRightText(d, now));
    return '<li>'+
      '<div class="board-meta">'+
        '<span class="board-date">'+esc(d.name)+'</span>'+ badge +
      '</div>'+
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:4px">'+
        '<span class="imp-date" style="font-size:.78rem">'+esc(dateText)+'</span>'+
        '<span class="imp-remain" style="font-size:.85rem;font-weight:800;white-space:nowrap">'+right+'</span>'+
      '</div>'+
      /* 只有配了 scope 的事项才有这个入口，普通日期不会出现多余的按钮 */
      (d.scope && d.scope.length
        ? '<div style="margin-top:8px"><button class="ex-scope-btn" onclick="openExamScope('+JSON.stringify(d.name).replace(/"/g,'&quot;')+')">📖 查看考试范围</button></div>'
        : '')+
      '</li>';
  }).join('');
}
function openAllImp(){
  var mask = document.getElementById('allImpMask');
  var title = document.getElementById('allImpTitle');
  if(!mask) return;
  var arr = IMPORTANT_DATES.map(function(d){ return { name:d.name, date:d.date, d:new Date(d.date) }; })
    .sort(function(a,b){ return a.d - b.d; });
  if(title) title.textContent = '全部重要日期（'+arr.length+' 个）';
  renderAllImp();
  mask.classList.add('show');
  if(impTimer) clearInterval(impTimer);
  impTimer = setInterval(renderAllImp, 1000);
}
function closeAllImp(){
  if(impTimer){ clearInterval(impTimer); impTimer = null; }
  var m=document.getElementById('allImpMask'); if(m) m.classList.remove('show');
}
function openAllHol(){
  var mask = document.getElementById('allHolMask');
  var list = document.getElementById('allHolList');
  var title = document.getElementById('allHolTitle');
  if(!mask||!list) return;
  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  /* 列表长度控制（站主拍板）：
     · 刚过去的节日只保留 1 个月内（置灰显示，方便回看），更早的不列
     · 未来只显示 6 个月内即将到来的，再远的不列
     这样弹窗始终只有几条，不会因年份增长而无限变长 */
  var pastFrom  = new Date(today.getFullYear(), today.getMonth() - 1, today.getDate());
  var futureTo  = new Date(today.getFullYear(), today.getMonth() + 6, today.getDate());
  var arr = HOLIDAYS.map(function(h){ return { name:h.name, date:h.date, days:h.days, d:new Date(h.date+'T00:00:00') }; })
    .filter(function(h){ return h.d >= pastFrom && h.d <= futureTo; })
    .sort(function(a,b){ return a.d - b.d; });
  var upcomingCount = HOLIDAYS.filter(function(h){ return new Date(h.date+'T00:00:00') >= today; }).length;
  if(title) title.textContent = '法定节假日（待过 ' + upcomingCount + ' 个）';
  list.innerHTML = arr.map(function(h){
    var left = Math.ceil((h.d.getTime()-now.getTime())/86400000);
    var isPast = h.d < today;
    var pastCls = isPast?'imp-past':'';
    return '<li style="display:flex;align-items:center;gap:12px">'+
      '<div style="flex:1;display:flex;flex-direction:column">'+
        '<span class="imp-name" style="font-weight:700;font-size:.92rem">'+esc(h.name)+'</span>'+
        '<span class="imp-date" style="font-size:.7rem;margin-top:2px">'+h.date+' · 放假 '+h.days+' 天（参考）</span>'+
      '</div>'+
      '<div style="text-align:right">'+
        '<b class="'+pastCls+'" style="font-size:1.05rem;font-weight:800;font-variant-numeric:tabular-nums;color:'+(isPast?'':'#3d8f6a')+'">'+(isPast?0:left)+'</b>'+
        '<span class="'+pastCls+'" style="font-size:.7rem;font-weight:600;margin-left:2px;color:'+(isPast?'':'#3d8f6a')+'">天</span>'+
      '</div></li>';
  }).join('') +
  '<li style="margin-top:10px;padding-top:10px;border-top:1px dashed rgba(120,53,15,.18);font-size:.68rem;line-height:1.6;color:var(--txt-3,#9b8a7d);list-style:none">'+
    '🗓 节日日期由站内自动推算（农历用万年历数据换算，清明按节气表），放假天数为常规值<b>仅供参考</b>，请以国务院每年公布的调休安排为准。'+
  '</li>';
  mask.classList.add('show');
}
function closeAllHol(){ var m=document.getElementById('allHolMask'); if(m) m.classList.remove('show'); }

/* ---- 导出备份（密码验证后下载 zip，密码仅以 SHA-256 哈希存储） ---- */
var EXPORT_PASS_HASH = '37cdb759bd61c3457476418527540de396dac438de468a7ed3c35f826bbc3181';
function openExport(){
  var m=document.getElementById('exportMask'); if(m) m.classList.add('show');
  var err=document.getElementById('exportErr'); if(err) err.style.display='none';
  var inp=document.getElementById('exportPassInput'); if(inp) inp.value='';
}
function closeExport(){ var m=document.getElementById('exportMask'); if(m) m.classList.remove('show'); }

/* ---- 用户数据管理（导出 / 导入 / 重置） ---- */
var GAME_KEYS=['snake_hi','bird_hi','breakout_hi','breakout_lv','match3_hi','mine_best','doodle_hi','plane_hi','gomoku_w','gomoku_l'];

/* ---- 全班名单（领券人选择 / 补发系统共用；写入 localStorage 供小游戏读取） ----

   【2026-10-07 改造：不再硬编码，改走云端 + 本地缓存】
   站主要求「主页面不直接写入用户信息，全部由云端同步，同步完本地缓存」。
   原来是 61 个名字写死在这份 JS 里（XOR + Base64，但密钥就在同一份文件里，
   等于公开；而且有人转班 / 改名必须改代码重发版）。

   现在的三级取值：
     ① 内存（本次会话已从云端拉到）
     ② localStorage 缓存（上次同步到的，离线也能用）
     ③ 旧的 CLASS_LIST_ENC（最后的静态兜底，保证任何情况下功能不倒退）

   启动时 syncRoster() 静默拉一次云端（必须登录），拉到就覆盖并写缓存。
   小游戏通过 localStorage['cls_class_list'] 读名单，所以那一份仍写成密文，
   兼容小游戏端的 _clDec 解密逻辑。 */
var CLASS_KEY="cls2505-xor-key-2026";
function _clDec(v){ try{ var bin=atob(v), kb=CLASS_KEY.split("").map(function(c){return c.charCodeAt(0);}), b=[];
  for(var i=0;i<bin.length;i++) b.push(bin.charCodeAt(i)^kb[i%kb.length]);
  return new TextDecoder().decode(new Uint8Array(b)); }catch(e){ return v; } }
/* 与 _clDec 配对：小游戏端用同一密钥解密，写进 cls_class_list 的必须是密文 */
function _clEnc(v){ try{
  var kb=CLASS_KEY.split("").map(function(c){return c.charCodeAt(0);});
  var bin=new TextEncoder().encode(String(v)), b=[];
  for(var i=0;i<bin.length;i++) b.push(String.fromCharCode(bin[i]^kb[i%kb.length]));
  return btoa(b.join(''));
}catch(e){ return v; } }
var CLASS_LIST_ENC=["hcT514mQ0KrX","h9Hq15ig3ZDR","h9Hq17WZ","ivPa1KO33LLU","ivfE17CG04zo","i+/S1o2w0KDi","iu7K1o+W05zo","hvzH1oq63ITI","huTr15ig3ZzS","huTr1oiD04Hb","htDT1bes","huTr1Z6J0r3L","hfH915u33ZLe","hc7y15u30pLs","i9HV15u33ZPI","ivX71KKd3ZPx","hsHq17iS3aHB","h9Hq15ig0JfP","hvzH15yH0ITP","i+Dw16W906TU","hv3b26603ZPx","hfHb1Jej0ZLy","huHR16uq07X2","huD226aQ06zC","i9HV1JiT04jY","hOL425OY0Iv1","hc7y15ig0L3j","huTr1ICq3ZDR","hcHV16mT3L/e","huHR1L6j0r3L","huHR1omv0r3S","hunD26ip063Z","hvzH1omv","heTH1o+h3azS","hPPA17qf0Iv1","hfDC1oyW0Iv1","huTr15u30qnt","hc7y14+H0qjk","hcT51ZiB3Lb9","hfH917iq05vj","hc3x1ZCK","hfHv2pqd0qvh","huTr16W90JHC","hvzH1JmT0rzO","iu/i1aWa0r3S","hurE15u33aXS","huHR1bCs","hcT515u305vN","htLj1ICH0Kvj","hfDC1oq63Lb9","hMT41KyG07TO","ivPa25i/07v0","hurE1YGb05vN","hMnu1KyK0Kb/","hsHq15O90Iv1","i+/S15y5063Z","hPPA2r+I0qvh","huTr266Y3IvQ","hc7y16e/0ZDL","hurE1omv07X2","hurE1LWt07j3"];

var ROSTER_CACHE_KEY='cls_roster_cache_v1';   /* 明文姓名数组，本站自己读 */
var _ROSTER_MEM = null;                        /* ① 本次会话的云端名单 */

/** 写两处缓存：本站明文 + 小游戏密文（cls_class_list） */
function rosterCacheSet(names){
  if(!Array.isArray(names) || !names.length) return;
  try{ localStorage.setItem(ROSTER_CACHE_KEY, JSON.stringify(names)); }catch(e){}
  try{ localStorage.setItem('cls_class_list', JSON.stringify(names.map(_clEnc))); }catch(e){}
}
function rosterCacheGet(){
  try{
    var l=JSON.parse(localStorage.getItem(ROSTER_CACHE_KEY)||'null');
    if(Array.isArray(l) && l.length) return l;
  }catch(e){}
  return null;
}

function classList(){
  if(_ROSTER_MEM && _ROSTER_MEM.length) return _ROSTER_MEM;              /* ① 云端 */
  var c = rosterCacheGet();
  if(c) return c;                                                        /* ② 缓存 */
  try{                                                                   /* ③ 兜底 */
    var l=JSON.parse(localStorage.getItem('cls_class_list')||'null');
    if(Array.isArray(l)&&l.length) return l.map(_clDec);
  }catch(e){}
  return CLASS_LIST_ENC.map(_clDec);
}

/** 登录后拉一次云端名单；失败静默，继续用缓存 / 兜底。
    只取姓名，不含任何联系方式（后端 roster 也不下发联系方式）。 */
function syncRoster(){
  try{
    if(typeof apiReady === 'function' && !apiReady()) return Promise.resolve(false);
    if(typeof isLoggedIn === 'function' && !isLoggedIn()) return Promise.resolve(false);
    return api('/profile?action=roster').then(function(j){
      var names = (j && j.names) || [];
      if(!names.length) return false;
      _ROSTER_MEM = names;
      rosterCacheSet(names);
      return true;
    }).catch(function(){ return false; });
  }catch(e){ return Promise.resolve(false); }
}

/* ---- 领券台账（按 名字+本周+游戏 核对，防跨设备/清缓存重复领） ---- */
var CLAIM_LEDGER_KEY='cls_coupon_ledger';
function ledgerLoad(){ try{ return JSON.parse(localStorage.getItem(CLAIM_LEDGER_KEY)||'{}'); }catch(e){ return {}; } }
function ledgerSave(L){ try{ localStorage.setItem(CLAIM_LEDGER_KEY, JSON.stringify(L)); }catch(e){} }
function ledgerWeek(){ var d=new Date(), day=(d.getDay()+6)%7; d.setDate(d.getDate()-day); return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate(); }
function ledgerStamp(){ var d=new Date(),p=function(n){return (n<10?'0':'')+n;}; return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes()); }
function ledgerGet(name,game){ var L=ledgerLoad(),w=ledgerWeek(); return (L[w]&&L[w][game]&&L[w][game][name])||''; }
function ledgerAdd(name,game,src){
  var L=ledgerLoad(),w=ledgerWeek();
  L[w]=L[w]||{}; L[w][game]=L[w][game]||{};
  L[w][game][name]=(ledgerStamp())+' · '+(src||'自动');
  ledgerSave(L);
  return L;
}
function ledgerAll(){ return ledgerLoad(); }

function dataMsg(t,c){ var m=document.getElementById('dataMsg'); if(m){ m.textContent = typeof stripEmoji === 'function' ? stripEmoji(t||'') : (t||''); m.style.color=c||'#0a7d42'; } }
function collectAllData(){
  var out={};
  try{ for(var i=0;i<localStorage.length;i++){ var k=localStorage.key(i); out[k]=localStorage.getItem(k); } }catch(e){}
  return out;
}
function openData(){
  var m=document.getElementById('dataMask'); if(!m) return;
  m.classList.add('show');
  var ta=document.getElementById('dataPaste');
  if(ta){ ta.style.display='none'; ta.value=''; }
  dataMsg('', '#0a7d42');
  SFX.pop();
}
function closeData(){ var m=document.getElementById('dataMask'); if(m) m.classList.remove('show'); }
(function(){ var m=document.getElementById('dataMask'); if(m) m.addEventListener('click',function(e){ if(e.target.id==='dataMask') closeData(); }); })();
/* ---- 个人数据加密（PBKDF2-SHA256 派生密钥 + AES-GCM 加密）
       密码只在导出/导入时由用户输入，不写进 localStorage、不随数据走 ---- */
var DE_ITER=150000;
function _b64enc(u8){ var s=''; for(var i=0;i<u8.length;i++) s+=String.fromCharCode(u8[i]); return btoa(s); }
function _b64dec(str){ var s=atob(str), u=new Uint8Array(s.length); for(var i=0;i<s.length;i++) u[i]=s.charCodeAt(i); return u; }
function cryptoOK(){ return !!(window.crypto && crypto.subtle && crypto.subtle.deriveKey && crypto.subtle.encrypt && window.TextEncoder); }
function _deriveKey(pw,salt){
  return crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey'])
    .then(function(base){
      return crypto.subtle.deriveKey({name:'PBKDF2',salt:salt,iterations:DE_ITER,hash:'SHA-256'}, base, {name:'AES-GCM',length:256}, false, ['encrypt','decrypt']);
    });
}
function encPayload(obj,pw){
  var salt=crypto.getRandomValues(new Uint8Array(16));
  var iv=crypto.getRandomValues(new Uint8Array(12));
  var data=new TextEncoder().encode(JSON.stringify(obj));
  return _deriveKey(pw,salt)
    .then(function(k){ return crypto.subtle.encrypt({name:'AES-GCM',iv:iv},k,data); })
    .then(function(ct){ return {v:2,alg:'PBKDF2-SHA256/AES-GCM',iter:DE_ITER,salt:_b64enc(salt),iv:_b64enc(iv),ct:_b64enc(new Uint8Array(ct))}; });
}
function decPayload(w,pw){
  return _deriveKey(pw,_b64dec(w.salt))
    .then(function(k){ return crypto.subtle.decrypt({name:'AES-GCM',iv:_b64dec(w.iv)},k,_b64dec(w.ct)); })
    .then(function(pt){ return JSON.parse(new TextDecoder().decode(new Uint8Array(pt))); });
}
/* 口令弹窗（导出=设置+确认，导入=仅输入） */
var __deCb=null, __deMode='export';
function askDataEnc(mode,cb){
  __deMode=mode; __deCb=cb;
  var t=document.getElementById('dataEncTitle'), d=document.getElementById('dataEncDesc');
  var p=document.getElementById('dataEncPass'), p2=document.getElementById('dataEncPass2'), err=document.getElementById('dataEncErr');
  if(t) t.textContent=(mode==='export')?'🔐 设置导出密码':'🔓 输入数据密码';
  if(d) d.innerHTML=(mode==='export')
    ? '导出内容含<b>姓名、班级签、点歌记录</b>等，将用你设置的密码加密。<br><b style="color:#af410f">请务必记住</b>——导入时要输入同一个密码，忘记将无法恢复。'
    : '这份数据是加密过的，请输入导出时设置的密码。';
  if(p2) p2.style.display=(mode==='export')?'':'none';
  if(err) err.style.display='none';
  if(p) p.value=''; if(p2) p2.value='';
  var m=document.getElementById('dataEncMask'); if(m) m.classList.add('show');
  setTimeout(function(){ if(p) p.focus(); },120);
}
function closeDataEnc(){ var m=document.getElementById('dataEncMask'); if(m) m.classList.remove('show'); __deCb=null; }
function submitDataEnc(){
  var p=document.getElementById('dataEncPass'), p2=document.getElementById('dataEncPass2'), err=document.getElementById('dataEncErr');
  var v=p?p.value:'', cb=__deCb, mode=__deMode;
  if(v.length<4){ if(err){ err.style.display='block'; err.textContent='密码至少 4 位'; } return; }
  if(mode==='export' && p2 && p2.value!==v){ if(err){ err.style.display='block'; err.textContent='两次输入的密码不一致'; } return; }
  closeDataEnc();
  if(cb) cb(v);
}
(function(){ var m=document.getElementById('dataEncMask'); if(m) m.addEventListener('click',function(e){ if(e.target.id==='dataEncMask') closeDataEnc(); }); })();

/* ============================================================
   【v2.10.0 #178】我的云端数据（分类视图 + 删除前密码验证）
   ------------------------------------------------------------
   站主要求：分类细化到条目、英文键名翻中文、删除前验密码。
   分类与翻译由后端 KEY_GROUPS 单一来源下发（?view=cats），
   前端只负责渲染——两边永远不会对不上。
   删除流程：先 POST /data?action=verify 验密码换一枚 5 分钟
   有效的 wipeToken，DELETE 带 wt 才放行；未验证直接 403。
   ============================================================ */
var CLOUD_WT = '';          /* wipeToken（验证通过后持有，5 分钟有效） */
var CLOUD_WT_EXP = 0;
var __cloudPwdCb = null;    /* 验证通过后要继续做的事 */

function cloudMsg(t,c){ var m=document.getElementById('cloudMsg'); if(m){ m.textContent=t||''; m.style.color=c||'#0a7d42'; } }
function fmtBytes(n){
  n = Number(n)||0;
  if(n < 1024) return n + ' B';
  if(n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
  return (n/1024/1024).toFixed(2) + ' MB';
}
function cloudFmtTime(iso){
  if(!iso) return '—';
  var d = new Date(iso);
  if(isNaN(d.getTime())) return '—';
  var pad = function(x){ return x<10?'0'+x:x; };
  return pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
/* v2.10.1 需求⑧：两个可见入口。
   ⚠️ 原来只能从侧边栏「💾 数据管理」进，而那个按钮 2026-10-07 起被隐藏了。 */
function openCloudDataFromAccount(){
  closeAccount();          /* 先关账号弹窗，避免两层遮罩叠着 */
  openCloudData();
}
function openCloudDataFromSettings(){
  closeSettings();
  if(!isLoggedIn()){ openAccount(); return; }   /* 未登录先引导登录：云端接口要登录才给读 */
  openCloudData();
}
function openCloudData(){
  var m=document.getElementById('cloudDataMask'); if(m) m.classList.add('show');
  loadCloudData();
}
function closeCloudData(){ var m=document.getElementById('cloudDataMask'); if(m) m.classList.remove('show'); }
(function(){ var m=document.getElementById('cloudDataMask'); if(m) m.addEventListener('click',function(e){ if(e.target.id==='cloudDataMask') closeCloudData(); }); })();

function loadCloudData(){
  var box=document.getElementById('cloudGroups'), sum=document.getElementById('cloudSummary');
  cloudMsg('');
  if(box) box.innerHTML='<div class="loading" style="padding:26px"><div class="spinner"></div></div>';
  api('/data?view=cats').then(function(j){
    if(sum) sum.textContent='共 '+(j.total||0)+' 条，约 '+fmtBytes(j.bytes||0)+'。删除前需要验证登录密码。';
    if(!j.groups || !j.groups.length){
      if(box) box.innerHTML='<p style="font-size:.82rem;color:#57534e;margin:0">云端还没有数据。主题、作业勾选、班级签、点歌记录等会自动同步上来。</p>';
      return;
    }
    if(box) box.innerHTML=j.groups.map(function(g){
      return '<div style="margin-bottom:14px">'
        + '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px">'
        + '<span style="font-size:.85rem;font-weight:700;color:#292524">'+esc(g.label)+'</span>'
        + '<span style="font-size:.72rem;color:#a8a29e">'+g.count+' 条 · '+fmtBytes(g.bytes)+'</span>'
        + '</div>'
        + g.items.map(function(it){
            return '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:#f6f1ec;border-radius:10px;margin-bottom:6px">'
              + '<div style="flex:1;min-width:0">'
              + '<div style="font-size:.8rem;color:#292524;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(it.name)+'</div>'
              + '<div style="font-size:.68rem;color:#a8a29e;font-family:ui-monospace,SFMono-Regular,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(it.key)+' · '+fmtBytes(it.bytes)+' · '+cloudFmtTime(it.updatedAt)+'</div>'
              + '</div>'
              + '<button class="btn" style="min-width:52px;padding:6px 10px;font-size:.75rem;background:#ffeded;color:#af410f" onclick="cloudDel(\''+attr(it.key)+'\')">删除</button>'
              + '</div>';
          }).join('')
        + '</div>';
    }).join('');
  }).catch(function(e){
    if(box) box.innerHTML='<p style="font-size:.82rem;color:#af410f;margin:0">加载失败：'+esc(e.message)+'</p>';
  });
}

/* ---- 密码验证：与登录同构（优先浏览器派生，失败回退明文） ---- */
function cloudVerify(pwd){
  var username = AUTH.user && AUTH.user.username;
  if(!username) return Promise.reject(new Error('未登录'));
  if(!clsHasSubtle()){
    return api('/data?action=verify', { method:'POST', body:{ password: pwd } });
  }
  return clsSalt(username).then(function(sp){
    if(sp.algo !== 'pbkdf2' || !sp.salt || !sp.iterations) return CLS_FALLBACK;
    return clsDerive(pwd, sp.salt, sp.iterations).then(function(cred){
      return api('/data?action=verify', { method:'POST', body:{ credential: cred } });
    });
  }).catch(function(e){
    if(clsKdfFallback(e)) return CLS_FALLBACK;
    throw e;
  }).then(function(r){
    if(r === CLS_FALLBACK) return api('/data?action=verify', { method:'POST', body:{ password: pwd } });
    CLOUD_WT = r.wipeToken || '';
    CLOUD_WT_EXP = Date.now() + (Number(r.expiresIn)||300)*1000;
    return r;
  });
}
function cloudWtOk(){ return !!CLOUD_WT && Date.now() < CLOUD_WT_EXP; }

function cloudAskPwd(cb){
  __cloudPwdCb = cb;
  var err=document.getElementById('cloudPwdErr');
  if(err) err.style.display='none';
  var p=document.getElementById('cloudPwdInput'); if(p){ p.value=''; }
  var m=document.getElementById('cloudPwdMask'); if(m) m.classList.add('show');
  setTimeout(function(){ if(p) p.focus(); },120);
}
function closeCloudPwd(){
  var m=document.getElementById('cloudPwdMask'); if(m) m.classList.remove('show');
  __cloudPwdCb=null;
}
(function(){ var m=document.getElementById('cloudPwdMask'); if(m) m.addEventListener('click',function(e){ if(e.target.id==='cloudPwdMask') closeCloudPwd(); }); })();
function submitCloudPwd(){
  var p=document.getElementById('cloudPwdInput'), err=document.getElementById('cloudPwdErr');
  var v=p?p.value:'';
  if(!v){ if(err){ err.style.display='block'; err.textContent='请输入登录密码'; } return; }
  if(err) err.style.display='none';
  cloudVerify(v).then(function(){
    closeCloudPwd();
    cloudMsg('✅ 身份已验证（5 分钟内删除不再追问）');
    SFX.success();
    var cb=__cloudPwdCb; __cloudPwdCb=null;
    if(cb) cb();
  }).catch(function(e){
    if(err){ err.style.display='block'; err.textContent = e.status===429 ? '验证太频繁，请稍后再试' : (e.message||'验证失败'); }
  });
}

/* ---- 删除：无有效 wipeToken 先弹密码框，通过后再删 ---- */
function cloudDel(key){
  var go=function(){
    api('/data?key='+encodeURIComponent(key)+'&wt='+encodeURIComponent(CLOUD_WT), { method:'DELETE' })
      .then(function(j){
        cloudMsg('🗑 '+(j.message||'已删除'));
        loadCloudData();
      })
      .catch(function(e){
        if(e.status===403){ CLOUD_WT=''; cloudAskPwd(function(){ cloudDel(key); }); return; }
        cloudMsg('❌ '+e.message, '#af410f');
      });
  };
  if(!confirm('确定删除这条云端数据吗？删除后换设备也找不回了。')) return;
  if(!cloudWtOk()){ cloudAskPwd(go); return; }
  go();
}
function cloudWipeAll(){
  var go=function(){
    api('/data?all=1&wt='+encodeURIComponent(CLOUD_WT), { method:'DELETE' })
      .then(function(j){
        CLOUD_WT='';
        cloudMsg('🧹 '+(j.message||'已清空'));
        loadCloudData();
      })
      .catch(function(e){
        if(e.status===403){ cloudAskPwd(function(){ cloudWipeAll(); }); return; }
        cloudMsg('❌ '+e.message, '#af410f');
      });
  };
  if(!confirm('确定清空云端全部数据吗？此操作不可恢复（本机数据不受影响）。')) return;
  if(!cloudWtOk()){ cloudAskPwd(go); return; }
  go();
}

function _dlJSON(json,name){
  var blob=new Blob([json],{type:'application/json'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');
  a.href=url; a.download=name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); },3000);
}
function _plainWarn(then){
  if(!confirm('当前环境不支持加密（Web Crypto 需要 https 或 localhost 环境）。\n\n仍要以【明文】方式导出吗？这样文件里的姓名、班级签、点歌记录等都能被直接看到。')) return;
  then();
}
function exportData(){
  var fname='class-site-data-'+new Date().toISOString().slice(0,10)+'.json';
  if(!cryptoOK()){ _plainWarn(function(){ _dlJSON(JSON.stringify(collectAllData(),null,1), fname); dataMsg('⚠️ 已明文导出（未加密）','#af410f'); SFX.success(); }); return; }
  askDataEnc('export',function(pw){
    encPayload(collectAllData(),pw).then(function(w){
      _dlJSON(JSON.stringify(w),fname);
      dataMsg('🔐 已加密导出，请记住密码');
      SFX.success();
    }).catch(function(){ dataMsg('❌ 加密失败，请重试','#af410f'); });
  });
}
function copyDataText(){
  if(!cryptoOK()){ _plainWarn(function(){ _copyOut(JSON.stringify(collectAllData()),'⚠️ 已复制明文数据（未加密）','#af410f'); }); return; }
  askDataEnc('export',function(pw){
    encPayload(collectAllData(),pw).then(function(w){
      _copyOut(JSON.stringify(w),'🔐 已复制加密数据，请记住密码','#0a7d42');
    }).catch(function(){ dataMsg('❌ 加密失败，请重试','#af410f'); });
  });
}
function _copyOut(json,msg,color){
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(json).then(function(){ dataMsg(msg,color); SFX.success(); },function(){ fallbackCopyData(json,msg,color); });
  }else{ fallbackCopyData(json,msg,color); }
}
function fallbackCopyData(json,msg,color){
  var ta=document.createElement('textarea');
  ta.value=json; ta.style.position='fixed'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand('copy'); dataMsg(msg||'✅ 数据文本已复制，请妥善保存', color||'#0a7d42'); SFX.success(); }
  catch(e){ dataMsg('❌ 复制失败', '#af410f'); }
  document.body.removeChild(ta);
}
/* ---- 复制网页链接（侧边栏按钮 → 弹窗列出主链接/备用链接） ---- */
function openCopyLink(){
  var list=document.getElementById('siteLinkList');
  if(list){
    var links=(SITE_DATA.siteLinks||[]);
    var html=links.map(function(l,i){
      return '<div style="background:#f6f1ec;border-radius:12px;padding:10px 12px;margin-bottom:8px">'+
        '<div style="display:flex;align-items:center;gap:10px">'+
        '<span style="flex:1;font-size:.85rem;color:#af410f;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(l.label)+'</span>'+
        '<button class="btn" style="min-width:64px;padding:7px 12px;font-size:.8rem" onclick="copyOneLink('+i+',this)">复制</button></div>'+
        (l.note ? '<div class="link-note">'+esc(l.note)+'</div>' : '')+
        '</div>';
    }).join('');
    list.innerHTML=html;
  }
  var m=document.getElementById('copyLinkMask'); if(m) m.classList.add('show');
  SFX.pop();
}
function closeCopyLink(){ var m=document.getElementById('copyLinkMask'); if(m) m.classList.remove('show'); }
(function(){ var m=document.getElementById('copyLinkMask'); if(m) m.addEventListener('click',function(e){ if(e.target.id==='copyLinkMask') closeCopyLink(); }); })();
function copyOneLink(i,btn){
  var links=(SITE_DATA.siteLinks||[]); if(!links[i]) return;
  var url=links[i].url;
  var done=function(){ if(btn){ btn.textContent='✅ 已复制'; setTimeout(function(){ btn.textContent='复制'; },1600); } SFX.success(); };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(url).then(done, function(){ fallbackCopyLink(url, done); });
  }else{
    fallbackCopyLink(url, done);
  }
}
function fallbackCopyLink(url, done){
  var ta=document.createElement('textarea');
  ta.value=url; ta.style.position='fixed'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand('copy'); done(); }
  catch(e){}
  document.body.removeChild(ta);
}
function pasteDataMode(){
  var ta=document.getElementById('dataPaste');
  if(!ta) return;
  if(ta.style.display==='none'){ ta.style.display='block'; ta.focus(); return; }
  doImport(ta.value.trim());
}
function importDataFile(input){
  var f=input.files && input.files[0];
  if(!f) return;
  var rd=new FileReader();
  rd.onload=function(){ doImport(String(rd.result||'').trim()); input.value=''; };
  rd.readAsText(f);
}
function applyImport(obj){
  var n=0;
  try{
    for(var k in obj){ localStorage.setItem(k, String(obj[k])); n++; }
  }catch(e){ dataMsg('❌ 写入失败（存储空间不足）', '#af410f'); return; }
  dataMsg('✅ 已导入 ' + n + ' 项数据，即将刷新…');
  SFX.success();
  setTimeout(function(){ location.reload(); }, 800);
}
function doImport(text){
  if(!text){ dataMsg('请先选择文件或粘贴数据', '#af410f'); return; }
  var obj=null;
  try{ obj=JSON.parse(text); }catch(e){ dataMsg('❌ 数据格式不正确，无法导入', '#af410f'); return; }
  if(!obj || typeof obj!=='object'){ dataMsg('❌ 数据格式不正确，无法导入', '#af410f'); return; }
  /* 【自定义设置】若选中的是「自定义设置」导出的配置文件，走配置导入通道（合并模式） */
  if(obj.app === 'class-site-ui-config'){
    var _r = applyUICfgObj(obj, 'merge');
    dataMsg(_r ? '✅ 已识别为「自定义设置」配置文件，已合并导入' : '❌ 配置导入失败', _r ? '#0a7d42' : '#af410f');
    if(_r) SFX.success();
    return;
  }
  /* 加密格式（v:2 + alg）→ 要求输入密码；旧版明文数据仍可直接导入 */
  if(obj.v===2 && typeof obj.alg==='string' && obj.alg.indexOf('AES-GCM')>=0){
    if(!cryptoOK()){ dataMsg('❌ 这是加密数据，当前环境不支持解密（需 https 或 localhost）', '#af410f'); return; }
    askDataEnc('import', function(pw){
      dataMsg('⏳ 正在解密…', '#af410f');
      decPayload(obj, pw).then(function(plain){
        applyImport(plain);
      }).catch(function(){
        dataMsg('❌ 密码错误或数据已损坏', '#af410f'); SFX.error();
      });
    });
    return;
  }
  applyImport(obj);
}
function resetData(){
  if(!confirm('确定要重置本设备的游戏数据吗？（各游戏最高分、记录将被清空，不可恢复）')) return;
  var seen={},n=0;
  try{
    for(var i=0;i<localStorage.length;i++){
      var k=localStorage.key(i);
      if(GAME_KEYS.indexOf(k)>=0 || k.indexOf('song_coupon_')===0 || k.indexOf('cls_sign_')===0 || k==='cls_device_id') seen[k]=1;
    }
  }catch(e){}
  for(var k in seen){ try{ localStorage.removeItem(k); n++; }catch(e){} }
  dataMsg('✅ 已重置 ' + n + ' 项游戏数据，即将刷新…');
  SFX.success();
  setTimeout(function(){ location.reload(); }, 800);
}
function wipeAllData(){
  if(!confirm('确定要清空本设备的站点数据吗？\n\n将清除：游戏记录、主题与音效设置、所有密码/暗号的通关记录与锁状态等。\n保留：设备标识、班级签、点歌券记录（防止借初始化刷签/刷券）。\n此操作不可恢复。')) return;
  try{
    for(var i=localStorage.length-1;i>=0;i--){
      var k=localStorage.key(i);
      if(k && (k.indexOf('song_coupon_')===0 || k.indexOf('cls_sign_')===0 || k==='cls_device_id')) continue;
      try{ localStorage.removeItem(k); }catch(e){}
    }
    sessionStorage.clear();
  }catch(e){}
  dataMsg('✅ 已清空站点数据，即将刷新…');
  SFX.success();
  setTimeout(function(){ location.reload(); }, 800);
}

/* ---- 学习资料网络限制提示弹窗（关闭后显示带红点悬浮球） ---- */
function studyBubbleShow(){
  var b=document.getElementById('studyBubble'); if(!b) return;
  if(window.__activeCat !== 5){ b.style.display='none'; actSyncBubble(); return; } /* 仅在学习资料板块内显示 */
  var off=false; try{ off=localStorage.getItem('cls_study_notice_dismissed')==='1'; }catch(e){}
  b.style.display = off ? 'none' : 'flex';
  actSyncBubble(); /* 活动球可见时上移，避免两个球叠一起 */
}
function studyBubbleHide(){
  var b=document.getElementById('studyBubble'); if(b) b.style.display='none';
  actSyncBubble();
}
function showStudyNotice(){
  try{ if(localStorage.getItem('cls_study_notice_dismissed')==='1') return; }catch(e){}
  studyBubbleHide();
  var m=document.getElementById('studyNoticeMask'); if(m) m.classList.add('show');
}
function closeStudyNotice(){
  var m=document.getElementById('studyNoticeMask'); if(m) m.classList.remove('show');
  studyBubbleShow();
}
function dismissStudyNotice(){
  var cb=document.getElementById('studyNoticeNoShow');
  var off=false;
  if(cb && cb.checked){ try{ localStorage.setItem('cls_study_notice_dismissed','1'); }catch(e){} off=true; }
  var m=document.getElementById('studyNoticeMask'); if(m) m.classList.remove('show');
  if(off) studyBubbleHide(); else studyBubbleShow();
}

/* 右下角悬浮球统一排布：依次从下往上叠，避免互相遮挡。
   通用弹窗引擎的 popBubble 也由本函数协调；新增悬浮球务必加进下方 ids 数组。 */
function actSyncBubble(){
  var ids = ['hwPopBubble','videoBubble','audioBubble','studyBubble','actBubble','popBubble'];
  var base = 16, GAP = 58;
  for(var i = 0; i < ids.length; i++){
    var el = document.getElementById(ids[i]);
    if(!el) continue;
    el.style.bottom = base + 'px';
    if(el.style.display === 'flex') base += GAP;
  }
}

/* ============================================================
   通用弹窗引擎（第二十七轮新增）
   ------------------------------------------------------------
   数据来源：SITE_DATA.popups（数组；可由云端 /api/content 覆盖）。
   一个引擎管两类时机：
     · scope:'boot'   —— 进站开屏弹
     · scope:'cat:N'  —— 进入板块 N 时弹
   三种来源（source）复用站内已有数据，站主不用重复维护：
     · 'announcements'  取最新公告
     · 'homework_notice' 取作业通知
     · 'custom'         本条自带 title/body/video/image
   四种关闭策略（dismiss）：daily（当天不再弹）/ once（永不自动弹）/
   always（每次都弹）。默认 daily + 留悬浮球。
   ------------------------------------------------------------ */

/* 当前正在展示的那条（供悬浮球 / 关闭按钮回读） */
var POP_CUR = null;
/* 已在本会话弹过的 id，避免同一次浏览重复弹 */
var POP_SESSION = {};
/* 板块触发用的已弹记录（本次会话内） */
var POP_CAT_DONE = {};

/** 读取并归一化弹窗列表；任何字段缺失都补默认值，避免渲染时炸 */
function popGetList(){
  var list = (window.SITE_DATA && SITE_DATA.popups) || [];
  if(!Array.isArray(list)) return [];
  var out = [];
  for(var i = 0; i < list.length; i++){
    var p = list[i];
    if(!p || typeof p !== 'object') continue;
    if(!p.id) continue;                       /* 没有 id 无法记录「已关」，跳过 */
    /* v3.5.40：不是给我的，直接跳过 */
    if(!popTargetOk(p)) continue;
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
      theme:     p.theme || '',
      /* v3.5.40（站主 #4）：投放对象。
         { mode:'all'|'users'|'roles'|'titles', users:[], roles:[], titles:[] }
         老数据没有这个字段 → 一律当「所有人」，行为不变。 */
      target: (function(t){
        if(!t || typeof t !== 'object') return { mode:'all', users:[], roles:[], titles:[] };
        var mode = ['all','users','roles','titles'].indexOf(String(t.mode)) >= 0 ? String(t.mode) : 'all';
        var arr = function(v){ return Array.isArray(v) ? v.map(function(x){ return String(x).trim(); }).filter(Boolean) : []; };
        return { mode: mode, users: arr(t.users), roles: arr(t.roles), titles: arr(t.titles) };
      })(p.target)
    });
  }
  return out;
}

/* ============================================================================
 * v3.5.40（站主 #4）：弹窗「指定给谁看」
 * ----------------------------------------------------------------------------
 * 站主原话：「可以设置指定弹窗，就是弹窗给某个人或某一群人」
 * 四种投放：所有人 / 指定账号（用户名或姓名）/ 按身份（管理员、学生、老师）/
 *          按头衔（团支书、课代表…，可多选）
 * 判定放在 popGetList 返回前 —— 所有消费方（开屏弹、板块弹、横幅）自动生效。
 * ⚠️ 这只是「给谁看」的过滤，不是权限：内容本身仍是公开的云端数据，
 *    懂技术的人翻接口能看到。真正的秘密别放进弹窗正文。
 * ========================================================================= */
function popTargetOk(p){
  var t = p && p.target;
  if(!t || !t.mode || t.mode === 'all') return true;
  var me = (typeof AUTH !== 'undefined' && AUTH && AUTH.user) ? AUTH.user : null;
  if(!me) return false;                      /* 没登录 → 只给「所有人」的弹窗 */
  if(t.mode === 'users'){
    var un = String(me.username || '').toLowerCase();
    var dn = String(me.displayName || me.display_name || me.name || '').trim().toLowerCase();
    return (t.users || []).some(function(x){
      var k = String(x || '').trim().toLowerCase();
      return !!k && (k === un || k === dn);
    });
  }
  if(t.mode === 'roles'){
    var role = String(me.role || 'user');
    return (t.roles || []).indexOf(role) >= 0;
  }
  if(t.mode === 'titles'){
    var my = String(me.title || '').split(/[,，、]/).map(function(x){ return x.trim(); }).filter(Boolean);
    return (t.titles || []).some(function(x){ return my.indexOf(x) >= 0; });
  }
  return true;
}

/** 板块顶部横幅 HTML：遍历该板块配的、带 bannerText 的弹窗条目（复用 .celebrate-banner 样式） */
function popBannerHtml(catId){
  var list = popGetList().filter(function(p){ return p.scope === 'cat:' + catId && p.bannerText; });
  if(!list.length) return '';
  return list.map(function(p){
    var id = String(p.id).replace(/'/g,'');
    /* v2.9.10：横幅压在渐变上 → ink-auto + data-ink-bg 声明渐变代表色（起始深色），
       字色按背景亮度实时取相反色，主题怎么切都可读 */
    return '<button class="celebrate-banner ink-auto" data-ink-bg="#f97316" onclick="popBannerPlay(\'' + id + '\')" title="点击观看">'+
      '<span class="cb-icon">🎉</span>'+
      '<span class="cb-text">'+
        '<span class="cb-title">'+esc(p.title||'通知')+'</span>'+
        '<span class="cb-sub">'+esc(p.bannerText)+'</span>'+
      '</span>'+
      '<span class="cb-go">▶ 观看</span>'+
    '</button>';
  }).join('');
}
/** 点横幅：播放该条目的视频（B站 / 直链都走站内视频弹窗） */
function popBannerPlay(id){
  var p = null, arr = popGetList();
  for(var i = 0; i < arr.length; i++){ if(arr[i].id === id){ p = arr[i]; break; } }
  if(!p) return;
  POP_CUR = p;
  if(p.video){
    if(typeof openVideo === 'function') openVideo(p.video, p.title || '视频播放');
    else if(typeof openLink === 'function') openLink(p.video, true, '弹窗视频');
  }
}

/** 时间字符串 → 毫秒；空/非法返回 NaN */
function popMs(v){
  if(!v) return NaN;
  var t = Date.parse(String(v).replace(' ', 'T'));
  return isNaN(t) ? NaN : t;
}

/** 是否落在时间窗内（startAt/endAt 都可选） */
function popInWindow(p){
  var now = Date.now();
  var s = popMs(p.startAt), e = popMs(p.endAt);
  if(!isNaN(s) && now < s) return false;
  if(!isNaN(e) && now > e) return false;
  return true;
}

/** localStorage 键：daily 按天、once 永久 */
function popSeenKey(p, withDay){
  if(withDay) return 'cls_pop_' + p.id + '_' + new Date().toDateString();
  return 'cls_pop_' + p.id;
}
function popSeen(p){
  try{
    if(localStorage.getItem(popSeenKey(p, false)) === '1') return true;   /* once 已弹 */
    if(p.dismiss === 'daily' && localStorage.getItem(popSeenKey(p, true)) === '1') return true;
  }catch(e){}
  return false;
}
function popMarkSeen(p){
  try{
    if(p.dismiss === 'once') localStorage.setItem(popSeenKey(p, false), '1');
    else if(p.dismiss === 'daily') localStorage.setItem(popSeenKey(p, true), '1');
    /* always 不落库 */
  }catch(e){}
}

/** 该条是否应「自动弹」 */
function popShouldAuto(p){
  if(POP_SESSION[p.id]) return false;          /* 本次会话已弹过 */
  if(p.dismiss !== 'always' && popSeen(p)) return false;
  return popInWindow(p);
}

/** 把不同 source 归一成 {title, body, media, linkText, linkUrl, endText} */
function popRender(p){
  var r = { title:'提示', body:'', media:'', linkText:p.linkText, linkUrl:p.linkUrl, endText:'' };

  if(p.source === 'announcements'){
    var list = (window.SITE_DATA && SITE_DATA.announcements) || [];
    var picked = null;
    /* 先找置顶（important），没有再取最新一条 */
    for(var i = 0; i < list.length; i++){ if(list[i] && list[i].important){ picked = list[i]; break; } }
    if(!picked) picked = list[0];
    if(!picked) return null;                    /* 没有公告就不弹 */
    r.title = p.title || '📢 班级公告';
    r.body  = picked.text || '';
    if(picked.date) r.endText = String(picked.date);
  }else if(p.source === 'homework_notice'){
    var n = (typeof hwPopGet === 'function') ? hwPopGet() : ((window.SITE_DATA && SITE_DATA.homeworkNotice) || null);
    if(!n) return null;
    r.title = p.title || n.title || '作业已发布';
    r.body  = p.body || n.text || '';
    if(n.end) r.endText = '通知有效至 ' + String(n.end);
  }else{
    /* custom：直接用本条自带内容 */
    r.title = p.title || '提示';
    r.body  = p.body || '';
  }

  /* 图片 / 视频（视频走站内已有的 openVideo，不重写播放器） */
  if(p.image){
    r.media = '<img src="' + esc(p.image) + '" alt="" style="width:100%;border-radius:10px;display:block">';
  }else if(p.video){
    r.media = '<button class="btn" style="width:100%" onclick="popPlayVideo()">▶️ 播放视频</button>';
  }
  return r;
}

/* 底部按钮跳转（v2.6.6：支持跳站内页面）
   ------------------------------------------------------------
   站主原话：「那个通用弹窗可以设置点击然后就自动跳转到某个页面，
   比如说跳转到成绩分析那个页面，或者说跳转到作业页面等等。当然也可以直接关闭」。

   linkUrl 现在支持三种写法（不配则不显示按钮，只能用「我知道了」关闭）：
     https://...      → 外部链接（原行为，不变）
     cat:5            → 打开站内第 5 个板块（常用服务 / 学习资料 / 成绩分析…）
     fn:函数名        → 打开某个站内页面（如 fn:showCurrentHomework 当前作业），
                        函数名有**白名单**校验，避免被塞任意代码

   实现细节：先校验目标存在再关弹窗 —— 否则目标写错时弹窗已经关了，
   用户只看到一片空白，不知道发生了什么。 */
var POP_JUMP_FN = {
  showCurrentHomework: 1, showHomeworkCalendar: 1, openClassworks: 1,
  openSettings: 1, openMyProfile: 1, openClassSign: 1,
  openAllImp: 1, openAllHol: 1, openGameBoard: 1, openData: 1, openRepoDialog: 1
};
function popGoLink(){
  var p = POP_CUR;
  if(!p) return;
  var u = String(p.linkUrl || '').trim();
  if(!u) return;
  var warn = function(msg){
    if(typeof uiMsg === 'function') uiMsg(msg, '#b45309');
    else alert(msg);
  };

  /* ① 站内板块 */
  var mc = /^cat:(\d+)$/.exec(u);
  if(mc){
    var cid = parseInt(mc[1], 10);
    if(!document.getElementById('tab-cat-' + cid)){
      warn('跳转失败：没有找到编号 ' + cid + ' 的板块');
      return;                       /* 不关弹窗，好让站主看到问题在哪 */
    }
    closePop();
    setTimeout(function(){ if(typeof openCat === 'function') openCat(cid); }, 120);
    return;
  }

  /* ② 站内页面（白名单函数） */
  var mf = /^fn:([A-Za-z_$][\w$]*)$/.exec(u);
  if(mf){
    var fn = mf[1];
    if(!POP_JUMP_FN[fn] || typeof window[fn] !== 'function'){
      warn('跳转失败：不支持的目标「' + fn + '」');
      return;
    }
    closePop();
    setTimeout(function(){ try{ window[fn](); }catch(e){} }, 120);
    return;
  }

  /* ③ 外部链接（原行为） */
  if(typeof openLink === 'function') openLink(u, true, '弹窗跳转');
}
/** 视频按钮：交给站内通用视频弹窗 */
function popPlayVideo(){
  var p = POP_CUR;
  if(!p || !p.video) return;
  if(typeof openVideo === 'function') openVideo(p.video, p.title || '视频播放');
  else if(typeof openLink === 'function') openLink(p.video, true, '弹窗视频');
}

/** 显示某条弹窗 */
function showPop(p){
  var r = popRender(p);
  if(!r) return;                                /* 内容取不到（如没有公告）→ 不弹 */
  POP_CUR = p;
  var ttl = document.getElementById('popTitle');
  var body = document.getElementById('popBody');
  var end = document.getElementById('popEnd');
  var link = document.getElementById('popLink');
  var media = document.getElementById('popMedia');
  if(ttl) ttl.textContent = r.title;
  if(body) body.textContent = r.body;
  if(end) end.textContent = r.endText || '';
  if(media){
    if(r.media){ media.innerHTML = r.media; media.style.display = ''; }
    else { media.innerHTML = ''; media.style.display = 'none'; }
  }
  if(link){
    if(r.linkUrl && r.linkText){ link.style.display = ''; link.textContent = r.linkText; }
    else { link.style.display = 'none'; }
  }
  /* 关闭按钮文案随策略微调，让站主/同学知道下次还会不会看到 */
  var ok = document.getElementById('popOkBtn');
  if(ok) ok.textContent = p.dismiss === 'always' ? '我知道了'
                        : (p.dismiss === 'once' ? '我知道了（不再提示）' : '我知道了（今天不再弹）');
  /* 打开时把悬浮球收起（同 actBubbleShow 的做法） */
  var b = document.getElementById('popBubble'); if(b) b.style.display = 'none';
  if(typeof actSyncBubble === 'function') actSyncBubble();
  /* 按条目的 theme 应用卡片样式（迎新橙卡等）；无 theme 时清掉，避免串味 */
  var m = document.getElementById('popMask');
  if(m){
    if(p.theme === 'welcome') m.classList.add('pop-theme-welcome');
    else m.classList.remove('pop-theme-welcome');
    m.classList.add('show');
  }
  /* v2.9.10：弹窗主题背景可能随条目/数据变化 → 字色按背景实时取相反色 */
  try{
    var box = document.querySelector('#popMask .allboard-box');
    if(box){
      if(p.theme === 'welcome') box.setAttribute('data-ink-bg', '#9a3412');
      else box.removeAttribute('data-ink-bg');
      box.classList.add('ink-auto');
    }
    clsAutoInk(document.getElementById('popMask'));
  }catch(e){}
  if(typeof SFX !== 'undefined' && SFX && SFX.pop) SFX.pop();
}

/** 关闭（并落库、按需显示悬浮球） */
function closePop(fromBubble){
  var p = POP_CUR;
  var m = document.getElementById('popMask'); if(m) m.classList.remove('show');
  if(p && !fromBubble) popMarkSeen(p);
  popBubbleSync();
}
/** 悬浮球点开：不重新计「已弹」，只重看 */
function popFromBubble(){
  var p = POP_CUR; if(!p) return;
  /* 从球打开时，展示逻辑与自动弹一致，但不再变更已读标记 */
  var r = popRender(p); if(!r) return;
  var m = document.getElementById('popMask'); if(m) m.classList.add('show');
  var b = document.getElementById('popBubble'); if(b) b.style.display = 'none';
  if(typeof actSyncBubble === 'function') actSyncBubble();
  if(typeof SFX !== 'undefined' && SFX && SFX.pop) SFX.pop();
}

/** 悬浮球显示规则：有「关了但仍可重看」的弹窗时显示 */
function popBubbleSync(){
  var b = document.getElementById('popBubble');
  if(!b) return;
  var show = false;
  if(POP_CUR && POP_CUR.bubble && popInWindow(POP_CUR)){
    /* 只有「本次会话已经弹过（含自动或手动）」才显示球，
       否则刚进站还没弹就先亮个球，显得莫名其妙 */
    show = !!POP_SESSION[POP_CUR.id];
  }
  b.style.display = show ? 'flex' : 'none';
  if(typeof actSyncBubble === 'function') actSyncBubble();
}

/** 开屏队列：把所有 boot 弹窗按顺序弹完（等前一个关掉再弹下一个，避免叠） */
function popAutoPop(){
  /* v3.8.4（站主）：「用户打开直接跳转到对应位置」—— 分享链接进来先看到内容，
     不要先糊两个开屏弹窗把板块盖住。公告在首页仍然能看到。 */
  if(typeof isShareEntry === 'function' && isShareEntry()) return;
  var list = popGetList().filter(function(p){ return p.scope === 'boot'; });
  var idx = 0;
  (function next(){
    /* 跳过不需要弹的 */
    while(idx < list.length && !popShouldAuto(list[idx])) idx++;
    if(idx >= list.length) return;
    var p = list[idx++];
    /* 等其它弹窗（欢迎语 / 门禁 / 活动 / 作业）先关掉 */
    var tries = 0;
    (function attempt(){
      tries++;
      var busy = document.querySelector('.allboard-mask.show') || document.querySelector('.gate.show');
      if(busy && tries < 24){ setTimeout(attempt, 500); return; }
      POP_SESSION[p.id] = 1;
      showPop(p);
      /* 关掉这条之后再弹下一条 */
      var guard = setInterval(function(){
        var m = document.getElementById('popMask');
        if(!m || !m.classList.contains('show')){ clearInterval(guard); setTimeout(next, 400); }
      }, 400);
    })();
  })();
}

/** 板块触发：进入某板块时调用，弹该板块配的弹窗 */
function popOnCategory(catId){
  var key = 'cat:' + catId;
  var list = popGetList().filter(function(p){ return p.scope === key; });
  if(!list.length) return;
  /* 板块弹窗直接弹（不再走 busy 等待，因为用户已经在浏览页面了） */
  for(var i = 0; i < list.length; i++){
    var p = list[i];
    if(!popShouldAuto(p)) continue;
    POP_SESSION[p.id] = 1;
    showPop(p);
    break;                                      /* 一个板块一次只弹一条，避免连环 */
  }
}

function popInit(){
  popBubbleSync();
  var hasBoot = popGetList().some(function(p){ return p.scope === 'boot'; });
  if(hasBoot) setTimeout(popAutoPop, 1200);     /* 稍晚于活动/作业弹窗，排队靠 busy 检查兜底 */
}

/* ---- 开屏通知弹窗：大假作业已发布（start~end 期间进站自动弹；可「不再显示」+ 悬浮球）---- */
function hwPopGet(){ return (window.SITE_DATA && SITE_DATA.homeworkNotice) || null; }
function hwPopOffKey(){ var n=hwPopGet(); return 'cls_hwpop_off_' + ((n && n.id) || 'default'); }
/* 是否处于通知有效期内（按本地日期判断，含首尾两天） */
function hwPopActive(){
  var n=hwPopGet();
  if(!n || !n.enabled) return false;
  var today=_hwDateStr(new Date());
  if(n.start && today < n.start) return false;
  if(n.end && today > n.end) return false;
  return true;
}
/* 用户是否勾过「不再显示」（跨会话永久生效，不按天重置） */
function hwPopDismissed(){ try{ return localStorage.getItem(hwPopOffKey())==='1'; }catch(e){ return false; } }
function showHwPop(){
  if(!hwPopActive()) return;
  var n=hwPopGet();
  var ttl=document.getElementById('hwPopTitle'), txt=document.getElementById('hwPopText'), meta=document.getElementById('hwPopMeta');
  if(ttl) ttl.textContent = n.title || '作业已发布';
  /* text 可为空（站主要求只显示「作业已发布」标题）——空时把整个 <p> 收起，
     否则它带着 margin 会留一道空白 */
  if(txt){
    if(n.text){ txt.textContent = n.text; txt.style.display = ''; }
    else { txt.textContent = ''; txt.style.display = 'none'; }
  }
  if(meta){
    var hw = null;
    var list = (window.SITE_DATA && SITE_DATA.holidayHomeworks) || [];
    for(var i=0;i<list.length;i++){ if(list[i].id === n.id){ hw = list[i]; break; } }
    if(hw){ meta.textContent = '📅 ' + hw.start + ' ~ ' + hw.end + ' · 共 ' + (hw.items||[]).length + ' 科作业'; }
    else { meta.textContent = ''; }
  }
  var b=document.getElementById('hwPopBubble'); if(b) b.style.display='none';
  if(typeof actSyncBubble==='function') actSyncBubble();
  var m=document.getElementById('hwPopMask'); if(m) m.classList.add('show');
  if(typeof SFX!=='undefined' && SFX.pop) SFX.pop();
}
/* 关闭弹窗：勾了「不再显示」则永久不再弹、也不留悬浮球；否则留球可重看 */
function dismissHwPop(){
  var cb=document.getElementById('hwPopNoShow');
  var off = !!(cb && cb.checked);
  var m=document.getElementById('hwPopMask'); if(m) m.classList.remove('show');
  if(off){ try{ localStorage.setItem(hwPopOffKey(),'1'); }catch(e){} }
  hwPopBubbleShow();
}
/* 点「查看作业」：关弹窗 → 进作业查看所在板块 → 打开当前作业弹窗 */
function hwPopGoView(){
  var n=hwPopGet();
  var m=document.getElementById('hwPopMask'); if(m) m.classList.remove('show');
  hwPopBubbleShow();
  if(typeof closeSidebar==='function') closeSidebar();
  if(n && n.goTo != null && typeof openCat==='function') openCat(n.goTo);
  setTimeout(function(){ if(typeof showCurrentHomework==='function') showCurrentHomework(); }, 320);
}
function hwPopBubbleShow(){
  var b=document.getElementById('hwPopBubble'); if(!b) return;
  /* 通知期内 且 没勾「不再显示」 且 弹窗当前没开着 → 显示悬浮球 */
  var mask=document.getElementById('hwPopMask');
  var open = !!(mask && mask.classList.contains('show'));
  b.style.display = (hwPopActive() && !hwPopDismissed() && !open) ? 'flex' : 'none';
  if(typeof actSyncBubble==='function') actSyncBubble();
}
function hwPopInit(){
  hwPopBubbleShow();
  if(hwPopActive() && !hwPopDismissed()) setTimeout(function(){
    /* 让位给欢迎语 / 门禁 / 活动通知，避免叠弹窗 */
    var tries=0;
    (function attempt(){
      tries++;
      var busy=document.querySelector('.allboard-mask.show') || document.querySelector('.gate.show');
      if(busy && tries<24){ setTimeout(attempt,500); return; }
      if(!hwPopActive() || hwPopDismissed()) return;
      showHwPop();
    })();
  }, 1000);
  setInterval(hwPopBubbleShow, 60000);
}

/* ---- 大假作业（当前作业 / 日历）---- */
var HW_SUBJECT_STYLE = {
  '语文': { c:'#e8543f', e:'book-open' },
  '数学': { c:'#0ea5e9', e:'ruler' },
  '英语': { c:'#16a085', e:'keyboard' },
  '物理': { c:'#8b5cf6', e:'atom' },
  '化学': { c:'#e67e22', e:'flask-conical' },
  '生物': { c:'#27ae60', e:'dna' },
  '其他': { c:'#8a827b', e:'pin' }
};
/* 作业「已完成」状态：按 hwId + 科目 + 任务序号存 localStorage */
/* v3.5.34：轻量模式下作业里的视频不预加载（preload="none"）。
   作业卡片经常一次挂好几个视频，默认 metadata 会同时发多路请求、
   一解码就抢占 GPU，iPad 上直接卡住。轻量下改成点了播放才拉流。 */
function _hwVidPreload(){
  try{ if(document.documentElement.getAttribute('data-lite') === '1') return 'none'; }catch(e){}
  return 'metadata';
}

function _hwDoneKey(hwId){ return 'cls_hw_done_' + hwId; }
function _getHwDone(hwId){
  try { return JSON.parse(localStorage.getItem(_hwDoneKey(hwId)) || '{}'); } catch(e){ return {}; }
}
function _isHwDone(hwId, subject, ti){
  var d = _getHwDone(hwId);
  return !!(d[subject] && d[subject][ti]);
}
function toggleHwDone(hwId, subject, ti, el){
  var d = _getHwDone(hwId);
  if(!d[subject]) d[subject] = {};
  d[subject][ti] = !d[subject][ti];
  try { localStorage.setItem(_hwDoneKey(hwId), JSON.stringify(d)); } catch(e){}
  /* v3.5.34：勾选后立刻推一次云端。
     站主反馈「前两天已经打勾的作业，这台设备上还是没打勾」——
     原逻辑靠 hookLocalStorage 登记脏键 + 1.5 秒防抖，用户打完勾马上
     锁屏 / 切走 / 关掉 PWA 时，防抖定时器可能还没到点就被冻结，
     这一笔就永远留在了本机。这里改成勾完立刻发，不等防抖。
     flushCloudSync 内部有 __syncInFlight 保护，连点也不会乱序。 */
  try{ if(isLoggedIn()) flushCloudSync(); }catch(e){}
  if(!el) return;
  el.classList.toggle('done', d[subject][ti]);
  var item = el.closest('.hw-item');
  if(item){
    var all = item.querySelectorAll('.hw-task');
    var done = item.querySelectorAll('.hw-task.done').length;
    var prog = item.querySelector('.hw-progress');
    if(prog) prog.textContent = done + '/' + all.length + ' 已完成';
  }
}
/* 把作业 items 渲染成美化后的科目卡片（任务可点选「已完成」；支持单条配图，点击放大） */
function _renderHwItems(items, hwId){
  if(!items || !items.length) return '<div style="padding:18px;text-align:center;color:#6e635a">该作业暂无具体科目内容。</div>';
  return items.map(function(it){
    var s = HW_SUBJECT_STYLE[it.subject] || { c:'#6e635a', e:'square-pen' };
    var total = (it.tasks||[]).length;
    var tasks = (it.tasks||[]).map(function(t, ti){
      var text, img, audio, video, audioLabel;
      if(t && typeof t === 'object'){
        text = t.text; img = t.img; audio = t.audio; video = t.video; audioLabel = t.audioLabel;
      } else { text = t; img = null; audio = null; video = null; audioLabel = null; }
      var done = _isHwDone(hwId, it.subject, ti);
      /* 图片：点开看大图。视频也走 img 通道（历史命名），
         所以这里要看扩展名决定是「当图片放大」还是「当视频播放」。 */
      var isVid = /\.(mp4|webm|mov|m4v|ogv|avi)(\?|#|$)/i.test(String(img || ''));
      var imgHtml = img
        ? (isVid
            ? '<div class="hw-imgs hw-video"><video src="'+esc(img)+'" controls preload="'+_hwVidPreload()+'" playsinline></video></div>'
            : '<div class="hw-imgs"><img src="'+esc(img)+'" alt="'+esc(it.subject||'作业')+'配图" loading="lazy" onclick="hwZoom(\''+esc(img)+'\')"></div>')
        : '';
      /* 听力音频：站内直接播放，不跳转（点击不触发「已完成」勾选） */
      var audioHtml = audio ? ('<button class="hw-audio" onclick="event.stopPropagation();openAudio(\''+esc(audio)+'\',\''+esc(audioLabel||(it.subject+'听力音频'))+'\')">'
        + iconSvg('headphones',16) + '<span>'+esc(audioLabel||'播放听力音频')+'</span>'
        + '<span class="hw-audio-sub">站内播放</span></button>') : '';
      /* 独立 video 字段（新格式，比塞进 img 更清楚）：用原生播放器 */
      var videoHtml = video
        ? '<div class="hw-imgs hw-video"><video src="'+esc(video)+'" controls preload="'+_hwVidPreload()+'" playsinline></video></div>'
        : '';
      return '<div class="hw-task'+(done?' done':'')+'" onclick="toggleHwDone(\''+esc(hwId)+'\',\''+esc(it.subject)+'\','+ti+',this)">'
        + '<span class="hw-check" aria-hidden="true"></span>'
        + '<span class="hw-task-text">'+esc(text)+'</span>'
        + '</div>' + imgHtml + audioHtml + videoHtml;
    }).join('');
    var doneCnt = (it.tasks||[]).filter(function(t, ti){ return _isHwDone(hwId, it.subject, ti); }).length;
    var progHtml = total ? '<span class="hw-progress">'+doneCnt+'/'+total+' 已完成</span>' : '';
    /* 课代表编辑入口（2026-10-06）：登录 + 本科目课代表（或管理员）才显示 */
    var editBtnHtml = _canEditSubject(it.subject)
      ? '<button class="hw-edit-btn" onclick="event.stopPropagation();openCaEditor(\''+esc(hwId)+'\',\''+esc(it.subject)+'\')" title="修改本科目作业">'+iconSvg('square-pen',13)+' 编辑</button>'
      : '';
    return '<div class="hw-item">'
      + '<div class="hw-item-head"><span class="hw-badge ink-auto" data-ink-bg="'+esc(s.c)+'" style="background:'+s.c+'">'+iconSvg(s.e,13)+' '+esc(it.subject)+'</span>'+progHtml+editBtnHtml+'</div>'
      + '<div class="hw-item-body">'+tasks+'</div>'
      + '</div>';
  }).join('');
}

/* ============================================================
 * 【课代表作业编辑】2026-10-06
 * ------------------------------------------------------------
 * 站主拍板的分工：后台只有站主能进 → 作业改版走前端——
 *   · 课代表登录后，在自己科目的作业卡片上点「✏️ 编辑」，
 *     只能改本科目任务（服务端按 profiles.title 强校验，前端按钮只是入口）；
 *   · 管理员（站主）登录后全部科目可编辑（补上后台作业编辑移除后的空缺）；
 *   · 附件（图片/音频）以「📎 [图片] 描述」占位行预留——原有附件原样保留，
 *     新增附件行在描述后用「 | 链接」带上 URL；没带 URL 的行保存为文字提示，
 *     之后拿到链接再补。
 * 任务一行一条，与后台旧编辑器同一套习惯。
 * ============================================================ */
var CA_CTX = null;   /* { hwId, hwLabel, subject, orig } */

function _myTitles(){
  var u = AUTH.user || {};
  return String(u.title || '').split(/[,，、\s]+/).map(function(x){ return x.trim(); }).filter(Boolean);
}
function _canEditSubject(subject){
  if(!isLoggedIn()) return false;
  if(isAdmin()) return true;
  return _myTitles().indexOf(subject + '课代表') >= 0;
}

function openCaEditor(hwId, subject){
  if(!_canEditSubject(subject)){
    if(typeof uiMsg === 'function') uiMsg('只有「' + subject + '课代表」能编辑本科目', '#af410f');
    return;
  }
  var hw = null, list = (window.SITE_DATA && SITE_DATA.holidayHomeworks) || [];
  for(var i = 0; i < list.length; i++){ if(String(list[i].id) === String(hwId)){ hw = list[i]; break; } }
  if(!hw){ if(typeof uiMsg === 'function') uiMsg('找不到作业数据，刷新页面后再试', '#af410f'); return; }
  var it = null, items = hw.items || [];
  for(var j = 0; j < items.length; j++){ if(items[j] && items[j].subject === subject){ it = items[j]; break; } }
  var orig = (it && it.tasks || []).slice();
  CA_CTX = { hwId: String(hw.id), hwLabel: (hw.start || '') + ' ~ ' + (hw.end || ''), subject: subject, orig: orig };

  var taVal = orig.map(function(t){
    if(t && typeof t === 'object'){
      /* ⚠️ 顺序别调：audio 优先于 video 优先于 img。
         一个任务理论上只挂一个附件，这里按「哪个字段有值」判类别。 */
      var kind = t.audio ? '音频' : (t.video ? '视频' : '图片');
      var u = t.audio || t.video || t.img || '';
      return '📎 [' + kind + '] ' + (t.text || '') + (u ? ' | ' + u : '');
    }
    return String(t == null ? '' : t);
  }).join('\n');

  /* 第二十七轮（2026-10-07）：附件直链（📎 行）只有管理员能增改。
     课代表只填文字内容，附件行改为只读展示，并隐藏「📎 新增附件行」按钮，
     从源头关掉入口，避免不会操作的同学误改直链。 */
  var isAdm = isAdmin();
  CA_CTX.lockedAtt = null;
  var editorText = taVal;
  var chipsHtml = '';
  if(!isAdm){
    var _lines = (taVal || '').split('\n');
    var _att = [], _txt = [];
    for(var _i = 0; _i < _lines.length; _i++){
      if(/^\s*📎/.test(_lines[_i])) _att.push(_lines[_i]); else _txt.push(_lines[_i]);
    }
    editorText = _txt.join('\n');
    if(_att.length){
      chipsHtml = '<div class="ca-att-ro"><div class="ca-att-ro-h">📎 附件（只读，直链需管理员修改）：</div>'
        + _att.map(function(ln){
            var mm = ln.match(/^\s*📎\s*\[([^\]]*)\]\s*([\s\S]*)$/);
            var k = mm ? mm[1] : '附件';
            var rest = mm ? mm[2] : ln.replace(/^\s*📎\s*/, '');
            var pi = rest.indexOf('|');
            var d = pi >= 0 ? rest.slice(0, pi).trim() : rest.trim();
            var u = pi >= 0 ? rest.slice(pi + 1).trim() : '';
            return '<span class="ca-chip" title="' + (u || '待补链接') + '">📎 [' + k + '] ' + (d || '附件') + (u ? ' · 已挂链接' : ' · 待补') + '</span>';
          }).join('')
        + '</div>';
      /* 锁存附件对象，保存时原样回写，确保课代表改不到也能保留原直链 */
      CA_CTX.lockedAtt = _att.map(function(ln){
        var mm = ln.match(/^\s*📎\s*\[([^\]]*)\]\s*([\s\S]*)$/);
        var k = mm ? mm[1] : '图片';
        var rest = mm ? mm[2] : '';
        var pi = rest.indexOf('|');
        var d = pi >= 0 ? rest.slice(0, pi).trim() : rest.trim();
        var u = pi >= 0 ? rest.slice(pi + 1).trim() : '';
        var pool = (CA_CTX.orig || []).filter(function(t){ return t && typeof t === 'object'; });
        var obj = null;
        for(var p = 0; p < pool.length; p++){ if((pool[p].text || '') === d){ obj = pool[p]; break; } }
        var o = { text: d };
        if(obj){
          if(obj.audio || (k === '音频' && u)) o.audio = u || obj.audio;
          else if(obj.video || (k === '视频' && u)) o.video = u || obj.video;
          else o.img = u || obj.img;
          if(o.audio && obj.audioLabel) o.audioLabel = obj.audioLabel;
        } else {
          if(k === '音频') o.audio = u; else if(k === '视频') o.video = u; else o.img = u;
        }
        return o;
      });
    }
  }

  document.getElementById('caTitle').textContent = '✏️ 编辑「' + subject + '」作业 · ' + CA_CTX.hwLabel;
  document.getElementById('caBody').innerHTML =
      '<p style="margin:0 0 8px;font-size:.78rem;color:#6e635a;line-height:1.7">' +
      (isAdm
        ? '一行一条任务。音频 / 视频 / 图片附件请直接手写 <b>📎 [音频] 描述</b> 占位行，在描述后用 <b>| 链接</b> 带上网址（附件文件由站主统一上传，链接找站主要）。<br>你是管理员：全部科目都能改、本次保存直接生效。'
        : '一行一条任务。<b>你是本科目课代表：只能编辑文字内容</b>，附件直链需由管理员修改（见下方只读区）。') +
      '</p>' +
      (isAdm
        ? '<div class="ca-tools">' +
            '<button type="button" onclick="caInsertTask()">＋ 新增一条任务</button>' +
            '<button type="button" onclick="caInsertAttRow()">📎 新增附件行</button>' +
          '</div>'
        : '<div class="ca-tools">' +
            '<button type="button" onclick="caInsertTask()">＋ 新增一条任务</button>' +
          '</div>') +
      chipsHtml +
      '<textarea id="caTa" class="ca-ta"></textarea>' +
      '<button class="acct-btn" id="caGo" style="margin-top:10px" onclick="caSave()">保存修改</button>' +
      '<div class="acct-msg" id="caMsg"></div>';
  document.getElementById('caTa').value = editorText;
  document.getElementById('caMask').classList.add('show');
  if(typeof SFX !== 'undefined' && SFX && SFX.pop) SFX.pop();
}

/* ---- 附件行（2026-10-07 第二十六轮：改回「只填直链」） ----
   站主决定不再做「点上传到服务器」：附件文件由站主手动放进仓库，
   拿到直链后填进作业。
   原因：R2 开户要绑银行卡，中科院数据胶囊要实名，都不适合当班级站点的基础设施。
   原来的上传实现（/api/upload、base64、CA_UP、进度条）已整体移除。 */

/* 新增一条空任务，光标落上去，省得手动拉到最后敲回车。 */
function caInsertTask(){
  caInsertLine('');
}

/* 新增一条附件占位行，形如「📎 [音频]  | 」，光标停在描述位置。
   把 kind 做成参数是为了以后想按类别预填时不用再改结构。 */
function caInsertAttRow(kind){
  kind = kind || '音频';
  caInsertLine('📎 [' + kind + ']  | ');
}

/* 在光标处**新起一行**插入 text，并把光标放到合适的位置。
   规则：
     · 光标所在行若已有内容 → 插到该行**之后**（不打断正在写的任务）
     · 光标所在行是空的   → 直接占用那一行（不留空行）
   光标落点：附件行跳到「|」之后（直接写描述），普通行落在行尾。

   ⚠️ 这里现读 selectionStart 是对的：调用方是按钮点击，焦点还在文本域上。
      （老上传流程不能现读，因为中间插了文件选择框，见已删除的 CA_UP.at 注释）
   ⚠️ 曾经写成 `head + '\n' + line + '\n' + tail`，在文末插入空行时会多出一个
      换行（3 行变 5 行），连点几下就攒出一堆空行。改成按「行」操作。 */
function caInsertLine(text){
  var ta = document.getElementById('caTa');
  if(!ta) return;
  var v = ta.value;
  var line = String(text || '');
  var pos = ta.selectionStart;
  if(pos === undefined || pos === null || pos > v.length) pos = v.length;

  var lineStart = v.lastIndexOf('\n', pos - 1) + 1;   /* pos 所在行的行首 */
  var eol = v.indexOf('\n', pos);                     /* pos 所在行的行尾（不含 \n） */
  if(eol < 0) eol = v.length;
  var curLine = v.slice(lineStart, eol);

  var next;
  if(curLine.trim() === ''){
    /* 光标在空行上 → 就用这一行，不新增空行 */
    next = v.slice(0, lineStart) + line + v.slice(eol);
  }else{
    /* 光标在有内容的行上 → 在这行之后另起一行 */
    next = v.slice(0, eol) + '\n' + line + v.slice(eol);
  }

  /* 光标：附件行停在「|」之后，普通行停在插入内容末尾 */
  var base = (curLine.trim() === '') ? lineStart : (eol + 1);
  var caret = base + line.length;
  var bar = line.indexOf('|');
  if(bar >= 0) caret = base + bar + 1;

  ta.value = next;
  ta.selectionStart = ta.selectionEnd = Math.max(0, Math.min(caret, next.length));
  ta.focus();
}

function closeCaEditor(){
  var m = document.getElementById('caMask');
  if(m) m.classList.remove('show');
  CA_CTX = null;
}

function caSay(t, cls){
  var el = document.getElementById('caMsg');
  if(el){ el.textContent = t || ''; el.className = 'acct-msg ' + (cls || '') + ' show'; }
}

function caSave(){
  if(!CA_CTX) return;
  var lines = document.getElementById('caTa').value.split('\n');
  var tasks = [];
  var pool = CA_CTX.orig.filter(function(t){ return t && typeof t === 'object'; });
  var pendingAtt = 0;

  for(var li = 0; li < lines.length; li++){
    var line = lines[li].replace(/\s+$/, '');
    if(!line.trim()) continue;

    if(/^\s*📎/.test(line)){
      var m = line.match(/^\s*📎\s*\[([^\]]*)\]\s*/);
      var kind = (m && m[1]) ? m[1] : '图片';
      var rest = m ? line.slice(m[0].length) : line.replace(/^\s*📎\s*/, '');
      var url = null, desc = rest.trim();
      var pipe = rest.indexOf('|');
      if(pipe >= 0){ url = rest.slice(pipe + 1).trim(); desc = rest.slice(0, pipe).trim(); }

      /* 复用原附件对象：**只按描述精确匹配**，匹配不上就当新附件。
         ⚠️ 这里以前有一句「匹配不上就取队首」的兜底，2026-10-07 已删除 ——
            它会造成「附件串位」：
            新上传的附件行描述叫 listening-unit2，跟原有那条「听力练习」对不上，
            于是被硬塞进队首那个旧对象里，结果是
              · 旧任务的链接被新上传的覆盖（原有附件被顶掉）
              · 新任务拿不到自己的链接
            表现是「传完保存，附件跑到了别条任务上」。
            正确做法：描述对不上就是新增一条，谁也别冒充谁。 */
      var idx = -1;
      for(var i = 0; i < pool.length; i++){ if(pool[i] && (pool[i].text || '') === desc){ idx = i; break; } }
      if(idx >= 0){
        var o = pool.splice(idx, 1)[0];
        var obj = { text: desc };
        /* ⚠️ 这里必须认「三个字段」而不是原来的「音频 / 其它」两分。
           主站渲染只读 .audio 与 .img，视频也走 .img（img 是「媒体占位」的
           历史命名，见 _renderHwItems）。原来只判 `o.audio || kind==='音频'`，
           于是**已挂好的视频在再次保存时会被错判成图片**，
           字段没变但语义丢了 —— 这是最容易踩的静默错位。
           现在三个字段一起判，保留原有的那个，避免类别被改写。 */
        if(o.audio || (kind === '音频' && url)) obj.audio = url || o.audio;
        else if(o.video || (kind === '视频' && url)) obj.video = url || o.video;
        else obj.img = url || o.img;
        if(obj.audio && o.audioLabel) obj.audioLabel = o.audioLabel;
        tasks.push(obj);
      } else if(url){
        var obj2 = { text: desc };
        if(kind === '音频') obj2.audio = url;
        else if(kind === '视频') obj2.video = url;
        else obj2.img = url;
        tasks.push(obj2);
      } else {
        /* 新加的附件行还没链接：先存成文字占位，之后拿到链接再来补 */
        pendingAtt++;
        tasks.push('📎 [' + kind + '] ' + desc + '（附件链接待补）');
      }
      continue;
    }
    tasks.push(line.trim());
  }

  /* 课代表编辑时附件行被拆成只读 chips，这里把锁存的附件对象原样拼回，
     保证「课代表只改文字、不丢附件直链」。管理员 lockedAtt 为 null，无影响。 */
  if(CA_CTX.lockedAtt && CA_CTX.lockedAtt.length){
    tasks = CA_CTX.lockedAtt.concat(tasks);
  }

  var btn = document.getElementById('caGo');
  if(btn) btn.disabled = true;
  caSay('保存中…', 'ok');
  api('/content?action=ca-save-subject', {
      method: 'POST',
      body: { subject: CA_CTX.subject, tasks: tasks, homeworkId: CA_CTX.hwId },
    })
    .then(function(j){
      if(btn) btn.disabled = false;
      var hw = null, list = SITE_DATA.holidayHomeworks || [];
      for(var i = 0; i < list.length; i++){ if(String(list[i].id) === String(CA_CTX.hwId)){ hw = list[i]; break; } }
      if(hw && Array.isArray(hw.items)){
        var entry = { subject: CA_CTX.subject, tasks: tasks };
        var hit = false;
        for(var k = 0; k < hw.items.length; k++){
          if(hw.items[k] && hw.items[k].subject === CA_CTX.subject){ hw.items[k] = entry; hit = true; break; }
        }
        if(!hit) hw.items.push(entry);
      }
      closeCaEditor();
      if(typeof uiMsg === 'function'){
        uiMsg('✅ ' + ((j && j.message) || '已保存') + (pendingAtt ? '（' + pendingAtt + ' 个附件待补链接）' : ''));
      }
      /* 作业弹窗 / 悬浮球若开着，统一走现成的刷新逻辑 */
      if(typeof refreshHwViews === 'function') refreshHwViews();
    })
    .catch(function(e){
      if(btn) btn.disabled = false;
      caSay((e && e.message) || '保存失败，请重试');
    });
}
/* 作业配图放大查看 */
function hwZoom(src){ var m=document.getElementById('hwZoomMask'), i=document.getElementById('hwZoomImg'); if(!m||!i) return; i.src=src; m.classList.add('show'); }
function closeHwZoom(){ var m=document.getElementById('hwZoomMask'); if(m) m.classList.remove('show'); }
function _hwDateStr(d){ return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }
function getCurrentHomework(){
  var today = _hwDateStr(new Date());
  var list = SITE_DATA.holidayHomeworks || [];
  /* ① 今天正落在某个假期区间内 → 就是它（区间不重叠，只会命中一个） */
  for(var i=0;i<list.length;i++){
    if(today >= list[i].start && today <= list[i].end) return list[i];
  }
  /* ② 否则取「离今天最近的那份」。
     判据分两种，未来优先——因为同学最需要看的是「接下来那次假期」的作业：
       · 若存在还没开始的假期 → 取 start 最小的（即最近的将来）
       · 若所有假期都开始了   → 取 start 最大的（即最近刚过的）
     ⚠️ 旧写法是「return 第一个 today≥start 的」，而数组按时间正序存，
     于是第一个满足的永远是**最早**那条（暑假），导致中秋/国庆期间
     点「查看当前作业」永远只看到暑假作业（2026-09-30 修）。 */
  var future = null, past = null;
  for(var i=0;i<list.length;i++){
    if(list[i].start > today){
      if(future === null || list[i].start < future.start) future = list[i];
    }else{
      if(past === null || list[i].start > past.start) past = list[i];
    }
  }
  if(future) return future;
  return past;
}
function _findHwByDate(dStr){
  var list = SITE_DATA.holidayHomeworks || [];
  for(var i=0;i<list.length;i++){ if(dStr >= list[i].start && dStr <= list[i].end) return list[i]; }
  return null;
}
/* ============================================================================
 * 班级投票（v3.5.6 第三块）
 * ----------------------------------------------------------------------------
 * 站主需求：后台投票管理 + 前端投票专区 + 歌单投票取前五对应周一至周五。
 *
 * 【为什么单独一个板块而不是卡片】
 *   投票是「看一眼就能动手」的东西，塞进卡片要点两次才看到选项，
 *   而且投票有截止时间，放在板块里一眼看见哪些还在进行中。
 *   板块 id = 7（班级事务），与后台「投票管理」面板对应。
 *
 * 【结果何时可见】
 *   进行中且未到截止 → 只显示「已投 / 未投」与总人数，不显示票数（防带票）；
 *   已截止或手动关闭 → 显示每个选项的票数与条形图。
 *   管理员在后台始终能看到（要预览）。
 *
 * 【一人一票 + 可改票】
 *   后端 class_vote_ballots 以 (vote_id, user_id) 为主键，改票就是覆盖。
 *   前端点选项只是选中，点「提交」才写库 —— 与「点了就投」相比，
 *   多选时不会因为点错一次就交上去。
 * ========================================================================= */
var VOTE = {
  votes: [],
  loaded: false,
  loading: false,
  picked: {},      /* { 投票id: [选项id] } 本地选中的草稿，未提交前只在这里 */
  busy: false,
};

/* 板块 7 的挂载点：render() 里 c.id===7 分支会输出这个容器 */
function voteEmbedHtml(){
  return '<div class="vote-embed" id="voteEmbed">'
    + '<div class="vote-bar" id="voteBar"></div>'
    + '<div class="vote-body" id="voteBody"></div>'
    + '</div>';
}
function voteBody(html){
  var el = document.getElementById('voteBody');
  if(el) el.innerHTML = html;
}
function voteBarHtml(html){
  var el = document.getElementById('voteBar');
  if(el) el.innerHTML = html;
}

/* 切到板块 7 时调用（openCat 里），render() 重建后也要重挂 */
function voteEnsureMounted(){
  if(!document.getElementById('voteEmbed')) return;
  if(!isLoggedIn()){
    voteBarHtml('');
    voteBody('<div class="vote-empty">'
      + '<div class="vote-empty-ico">🗳️</div>'
      + '<p>投票需要登录后才能参与。</p>'
      + '<button class="btn" onclick="openAccount(\'login\')">去登录</button>'
      + '</div>');
    return;
  }
  if(!VOTE.loaded && !VOTE.loading){ voteLoad(); return; }
  voteRenderAll();
}

function voteLoad(){
  VOTE.loading = true;
  voteBarHtml('');
  voteBody('<div class="vote-empty"><div class="spinner"></div><p>正在读取投票…</p></div>');
  api('/votes?action=list').then(function(j){
    VOTE.votes = (j && j.votes) || [];
    VOTE.loaded = true;
    VOTE.loading = false;
    voteRenderAll();
  }).catch(function(e){
    VOTE.loading = false;
    voteBody('<div class="vote-empty"><p>读取失败：' + esc(e.message || e) + '</p>'
      + '<button class="btn" onclick="VOTE.loaded=false;voteLoad()">重试</button></div>');
  });
}

/* 剩余时间人话：已截止 / 还剩 X 天 X 小时 / 还剩 X 分钟 */
function voteRemainText(v){
  if(v.status === 'closed') return '已截止';
  if(!v.deadline) return '不限截止';
  var ms = Date.parse(v.deadline) - Date.now();
  if(isNaN(ms)) return '';
  if(ms <= 0) return '已截止';
  var d = Math.floor(ms / 86400000);
  var h = Math.floor((ms % 86400000) / 3600000);
  var m = Math.floor((ms % 3600000) / 60000);
  if(d > 0) return '还剩 ' + d + ' 天' + (h > 0 ? ' ' + h + ' 小时' : '');
  if(h > 0) return '还剩 ' + h + ' 小时' + (m > 0 ? ' ' + m + ' 分钟' : '');
  return '还剩 ' + m + ' 分钟';
}
/* v3.5.18：只取日期（YYYY-MM-DD）。
   ⚠️ 后端 createdDate 可能是 Date 对象被 String() 化的结果
   （"Sun Oct 18 2026 00:00:00 GMT+0800"），slice(0,10) 会得到 "Sun Oct 18" —— 很难看。 */
function voteDateText(x){
  if(!x) return '';
  var d = (x instanceof Date) ? x : new Date(x);
  if(isNaN(d.getTime())){
    var m = String(x).match(/\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : '';
  }
  /* v3.5.20：像 "Sun Oct 18" 这种缺年份的串，new Date() 会补成 2001 年 ——
     年份离谱就直接认作无效，回退去字符串里找 YYYY-MM-DD，别把 2001 显示给用户。 */
  if(d.getFullYear() < 2000 || d.getFullYear() > 2100){
    var m2 = String(x).match(/\d{4}-\d{2}-\d{2}/);
    return m2 ? m2[0] : '';
  }
  function p(n){ return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function voteTimeText(iso){
  if(!iso) return '';
  var d = new Date(iso);
  if(isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
  function p(n){ return (n < 10 ? '0' : '') + n; }
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function voteRenderAll(){
  var list = VOTE.votes || [];
  var openList = list.filter(function(v){ return v.open; });
  var doneList = list.filter(function(v){ return !v.open; });

  voteBarHtml(
    '<div class="vote-head">'
    + '<h3>🗳️ 投票</h3>'
    + '<p class="vote-sub">' + (openList.length
        ? '进行中 <b>' + openList.length + '</b> 个' + (doneList.length ? ' · 已结束 ' + doneList.length + ' 个' : '')
        : '当前没有进行中的投票' + (doneList.length ? ' · 已结束 ' + doneList.length + ' 个' : ''))
    + '</p>'
    + '</div>');

  if(!list.length){
    voteBody('<div class="vote-empty">'
      + '<div class="vote-empty-ico">🗳️</div>'
      + '<p>还没有投票。</p>'
      + '<p class="vote-dim">管理员在后台发起投票后，这里就会出现。</p>'
      + '</div>');
    return;
  }

  /* v3.5.14 站主要求：多个投票同时进行时左右滑动切换，不再一长条列出来。
     进行中的排前面，已结束的接在后面；卡片宽度 = 容器宽，scroll-snap 对齐。 */
  var all = openList.concat(doneList);
  VOTE.order = all.map(function(v){ return v.id; });
  var curIdx = 0;
  for(var ci = 0; ci < all.length; ci++){ if(all[ci].id === VOTE.curId){ curIdx = ci; break; } }
  var h = '<div class="vote-swipe" id="voteSwipe">'
    + all.map(function(v){
        return '<div class="vote-slide" data-slide-vid="' + v.id + '">'
          + (v.open ? '' : '<div class="vote-slide-tag">已结束</div>')
          + voteCardHtml(v)
          + '</div>';
      }).join('')
    + '</div>'
    + '<div class="vote-pager">'
    +   '<button type="button" data-vote-prev aria-label="上一个">‹</button>'
    +   '<div class="vote-dots">' + all.map(function(v, i){
          return '<i data-vote-dot="' + i + '" class="' + (i === curIdx ? 'on' : '') + '"></i>';
        }).join('') + '</div>'
    +   '<button type="button" data-vote-next aria-label="下一个">›</button>'
    + '</div>'
    + '<div class="vote-pos"><span id="votePosTxt">第 ' + (curIdx + 1) + ' / ' + all.length + ' 个</span> · 左右滑动切换</div>';
  voteBody(h);
  voteBind();
  voteSwipeBind(all, curIdx);
}

/* ===== v3.5.13 投票公示（站主 #2）=====
   后台在投票管理里选一个模版并开启后，投票卡下方就会按模版渲染公示内容。
   模版里可用的变量（由后台模版编辑器提供快捷按钮）：
     {{标题}} {{提出人}} {{提出日期}} {{截止时间}} {{参与人数}}
     {{第一名}} {{第二名}} {{第三名}} {{结果表}} */
function votePubRender(v){
  try{
    var pub = (SITE_DATA.votePub || {});
    var cfg = (pub.byVote || {})[v.id];
    if(!cfg || !cfg.on || !v.results) return '';
    /* v3.5.14：后台可设展示截止时间，到点自动取消展示 */
    if(cfg.until && Date.now() > new Date(cfg.until).getTime()) return '';
    var tpl = (pub.templates || []).filter(function(t){ return t.id === cfg.tplId; })[0];
    if(!tpl) return '';
    var rs = v.results.slice().sort(function(a, b){ return (b.n || 0) - (a.n || 0); });
    var totalVotes = rs.reduce(function(s, r){ return s + (r.n || 0); }, 0);
    var voters = v.voters || totalVotes;
    /* v3.5.21：歌单投票公示里可选（有数据就自动）显示时长与总时长 */
    var anyDur = rs.some(function(r){ return r.songMeta && r.songMeta.duration; });
    var totalDurSec = anyDur ? rs.reduce(function(s, r){
      return s + ((r.songMeta && r.songMeta.duration) ? Number(r.songMeta.duration) : 0);
    }, 0) : 0;
    var durHead = anyDur ? '<th>时长</th>' : '';
    var durCell = function(r){
      return anyDur ? '<td>' + ((r.songMeta && r.songMeta.duration) ? voteFmtDur(r.songMeta.duration) : '—') + '</td>' : '';
    };
    var map = {
      '标题': esc(v.title || ''),
      '提出人': esc(v.proposer || v.createdByDisplay || v.createdByName || '未记录'),
      '提出日期': esc(v.createdDate || (v.createdAt ? String(v.createdAt).slice(0, 10) : '')),
      '截止时间': esc(v.deadline ? voteTimeText(v.deadline) : '不限'),
      '参与人数': String(voters),
      '总票数': String(totalVotes),
      '歌曲总时长': anyDur ? voteFmtDur(totalDurSec) : '—',
      '结果表': '<table class="vote-pub-tbl"><thead><tr><th>排名</th><th>选项</th><th>提出人</th>' + durHead + '<th>票数</th></tr></thead><tbody>'
        + rs.map(function(r, i){
            return '<tr><td>' + (i + 1) + '</td><td>' + esc(r.label)
              + '</td><td>' + esc(r.byName || (r.by === 'student' ? '同学' : '管理员'))
              + '</td>' + durCell(r) + '<td>' + (r.n || 0) + ' 票</td></tr>';
          }).join('') + '</tbody></table>',
    };
    /* v3.5.23：名次变量从「前三名」扩到「前十名」（站主要求：模板里想写第4、5名也得有） */
    var CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    for(var rn = 1; rn <= 10; rn++){
      map['第' + CN[rn] + '名'] = esc(rs[rn - 1] ? rs[rn - 1].label : '—');
    }
    var html = String(tpl.template || '')
      .replace(/\{\{\s*([^}]+?)\s*\}\}/g, function(m, k){ return map[k] !== undefined ? map[k] : m; })
      .replace(/&(?![a-zA-Z#0-9]+;)/g, '&amp;')   /* 裸 & 转义，已写好的实体不动 */
      .split('\n').join('<br>');
    return '<div class="vote-pub">'
      + '<div class="vote-pub-h">📋 公示</div>'
      + '<div class="vote-pub-body">' + html + '</div>'
      + '</div>';
  }catch(e){ return ''; }
}

/* 一张投票卡 */
/* v3.5.18：歌单投票的选项是「歌名 - 歌手 - 点歌人 - 时间」，整段太长。
   默认只显示「歌名 - 歌手」，点「详情」再展开点歌人和点歌时间。
   v3.5.23：改成「找日期段」的宽容拆法 —— 老格式/新格式都能折叠：
     · 歌名 - 歌手 - 点歌人 - 2026-10-05 21:48
     · 歌名 - 歌手 - 点歌人 - 2026-10-05 21:48 - 1 赞 - 4:29   ← 以前正则不认，整条裸奔
     · 歌名 - 歌手 - 点歌人 - 时间 - 时长
   规则：按「 - 」分段，从第 3 段起找到第一个像日期的段，它之前的两段是
   歌名和歌手，其余全部进「详情」。普通选项（没有日期段）不受影响。 */
function voteOptSplit(label){
  var s = String(label == null ? '' : label).trim();
  var parts = s.split(' - ').map(function(x){ return x.trim(); }).filter(Boolean);
  if(parts.length < 4) return null;
  var dateIdx = -1;
  for(var i = 2; i < parts.length; i++){
    if(/^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?$/.test(parts[i])){ dateIdx = i; break; }
  }
  if(dateIdx < 0) return null;
  return { main: parts.slice(0, 2).join(' - '), extra: parts.slice(2).join(' · ') };
}
/** 秒 → m:ss */
function voteFmtDur(sec){
  var n = Math.round(Number(sec) || 0);
  if(!n) return '';
  var m = Math.floor(n / 60), s = n % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

/** 选项标签：默认只显示「歌名 - 歌手」，其余折叠（点「详情」展开）。
 *  v3.5.19：优先用后端带来的 songMeta（勾了哪些字段就显示哪些），
 *  meta 缺失时退回按「 - 」拆 label（老投票兼容）。
 *  v3.5.25（站主要求）：歌曲时长改成**必展示项**，跟在歌手后面、换一种字色，
 *  不再收进「详情」。其余（点歌人 / 点歌时间 / 赞数）仍按后台勾选折叠。 */
function voteOptLabelHtml(label, meta, moreText){
  var main = '', extra = '', durTxt = '';
  if(meta && (meta.title || meta.artist)){
    main = [meta.title, meta.artist].filter(Boolean).join(' - ');
    if(meta.duration) durTxt = voteFmtDur(meta.duration);
    var show = meta.show || [];
    var bits = [];
    if(show.indexOf('requester') >= 0 && meta.requester) bits.push(meta.requester);
    if(show.indexOf('time') >= 0 && meta.requestedAt) bits.push(meta.requestedAt);
    if(show.indexOf('votes') >= 0 && meta.voteCount != null) bits.push(meta.voteCount + ' 赞');
    /* 时长不再进 extra —— 它已经在 main 后面单独展示了（老数据 show 里可能还有 duration） */
    extra = bits.join(' · ');
    if(!main) main = label;
  }else{
    var sp = voteOptSplit(label);
    if(!sp) return '<span class="vote-opt-main">' + esc(label) + '</span>';
    main = sp.main;
    extra = sp.extra;
    /* 老投票（没有 songMeta）也从 extra 里把时长捞出来单独展示 */
    var dm = extra.match(/(^|·\s*)(\d{1,2}:\d{2})(\s*·|$)/);
    if(dm){
      durTxt = dm[2];
      extra = extra.replace(dm[0], dm[1] + dm[3]).replace(/·\s*$/, '').replace(/^\s*·\s*/, '').trim();
    }
  }
  /* 时长段：跟在歌手后面，换一种字色（--vote-dur，暗色自动适配） */
  var durHtml = durTxt ? '<span class="vote-opt-dur">' + esc(durTxt) + '</span>' : '';
  if(!extra){
    return '<span class="vote-opt-main">' + esc(main) + durHtml + '</span>';
  }
  return '<span class="vote-opt-main">' + esc(main) + durHtml
    + '<span class="vote-opt-more" data-vote-more="1">' + esc(moreText || '详情') + '</span></span>'
    + '<span class="vote-opt-extra">' + esc(extra) + '</span>';
}

function voteCardHtml(v){
  var multi = !!v.multi;
  var closed = !v.open;
  /* v3.5.14 站主要求：结束后可选「展示结果公示并隐藏投票」。
     配了公示才这么干；没配公示就退回只读投票栏，免得整张卡空白。 */
  if(closed && v.endMode === 'pub'){
    var onlyPub = votePubRender(v);
    if(onlyPub) return '<div class="vote-card vote-card-pubonly">' + onlyPub + '</div>';
  }
  /* v3.5.14 站主新要求：
     · 未提交时，点赞只是**选择**（可随意取消，不消耗撤回次数），选完点「确定」才上传；
     · 已经投过票再点点赞 → 弹窗问「是否撤回重新投票（还剩 N 次）」，确认才撤回并进入重投。 */
  var draft = VOTE.picked[v.id];
  var my = (draft != null) ? draft : (v.myChoices || []);
  var submitted = !!((v.myChoices && v.myChoices.length) || v.mine);
  var editing = (draft != null);
  var totalVotes = 0, maxN = 0;
  if(v.results){
    v.results.forEach(function(r){ totalVotes += r.n; if(r.n > maxN) maxN = r.n; });
  }

  var optsHtml;
  /* ⚠️ v3.5.14 重要修正：以前条件是 closed || v.results —— 管理员（后台预览时后端也发票数）
     永远走结果视图，所以站主自己在线上「点了几次都投不上」。现在只有**已截止**才只看结果；
     未截止一律展示点赞按钮，管理员额外在选项右侧看到票数。 */
  if(closed){
    /* 结果视图：条形 + 票数（按票数降序，同票保持原顺序；后端已排，这里兜底） */
    optsHtml = (v.results || v.options).slice().sort(function(a, b){ return (b.n || 0) - (a.n || 0); }).map(function(o){
      var n = o.n || 0;
      var pct = maxN > 0 ? Math.round(n / maxN * 100) : 0;
      var mine = (v.myChoices || []).indexOf(o.id) >= 0;
      return '<div class="vote-res' + (mine ? ' mine' : '') + '">'
        + '<div class="vote-res-bar" style="width:' + pct + '%"></div>'
        + '<div class="vote-res-in">'
        +   '<span class="vote-res-label">' + voteOptLabelHtml(o.label, o.songMeta)
        +     (o.by === 'student' ? '<span class="vote-tag">' + esc(o.byName || '同学') + ' 提</span>' : '')
        +     (mine ? '<span class="vote-tag mine">我投的</span>' : '') + '</span>'
        +   '<span class="vote-res-n">' + n + ' 票</span>'
        + '</div></div>';
    }).join('');
  }else{
    /* v3.5.14 #9：每个选项右侧一个点赞按钮，点一下直接投票（不再有提交表单）。
       站主原话「改了几次点击还是无法投票」—— 以前点选项只是改本地草稿，
       必须再点「提交投票」才入库，很多人点了选项就走了。 */
    /* v3.5.24：排序一律按赞数从高到低（站主：「高赞的放在上面，排行榜实时更新」）。
       票数来自 v.results —— 每次拉票/投票后会重新渲染，所以是实时的。
       同票保持原有先后（稳定排序），不该因为刷新而乱跳。 */
    var cntMap = {};
    if(v.results){ v.results.forEach(function(r){ cntMap[r.id] = r.n || 0; }); }
    var rankList = v.options.map(function(o, i){ return { o: o, i: i }; });
    rankList.sort(function(a, b){
      var d = (cntMap[b.o.id] || 0) - (cntMap[a.o.id] || 0);
      return d !== 0 ? d : (a.i - b.i);
    });
    optsHtml = rankList.map(function(it){
      var o = it.o;
      var on = my.indexOf(o.id) >= 0;
      var cnt = (v.results && cntMap[o.id] != null) ? cntMap[o.id] : null;
      return '<button class="vote-opt' + (on ? ' on' : '') + '" data-vote-pick="' + v.id + '" data-vid="' + v.id + '" data-oid="' + esc(o.id) + '">'
        + '<span class="vote-opt-label">' + voteOptLabelHtml(o.label, o.songMeta)
        +   (o.by === 'student' ? '<span class="vote-tag">' + esc(o.byName || '同学') + ' 提</span>' : '') + '</span>'
        + (cnt != null ? '<span class="vote-n">' + cnt + ' 票</span>' : '')
        + '<span class="vote-like' + (on ? ' on' : '') + '" aria-label="' + (on ? '取消' : '投票') + '">👍</span>'
        + '</button>';
    }).join('');
  }

  var addHtml = '';
  if(v.allowAdd && !closed){
    addHtml = '<div class="vote-add">'
      + '<input id="voteAddInput' + v.id + '" type="text" maxlength="80" placeholder="想加的选项（最多 80 字）">'
      + '<button class="btn btn-sm btn-secondary" data-vote-add="' + v.id + '">添加</button>'
      + '</div>';
  }

  /* v3.5.14 修正：选完要点「确定」才上传；已投状态下只显示撤回入口。 */
  var submitHtml = '';
  if(!closed){
    var hint = multi ? '可多选' : '单选';
    if(v.maxChoices) hint += ' · 最多 ' + v.maxChoices + ' 项';
    if(v.minChoices) hint += ' · 至少 ' + v.minChoices + ' 项';
    if(v.maxChoices) hint += '（已选 ' + my.length + '/' + v.maxChoices + '）';
    var left = Math.max(0, (v.retractLimit || 1) - (v.retractUsed || 0));
    if(submitted && !editing){
      submitHtml = '<div class="vote-actions">'
        + '<span class="vote-hint">✅ 你已投票' + (left > 0 ? ' · 还可撤回 ' + left + ' 次' : ' · 撤回机会已用完') + '</span>'
        + (left > 0
            ? '<button class="btn btn-sm btn-secondary" data-vote-retract="' + v.id + '">撤回重投</button>'
            : '')
        + '</div>';
    }else{
      submitHtml = '<div class="vote-actions">'
        + '<span class="vote-hint">' + esc(hint) + '</span>'
        + '<button class="btn btn-sm" data-vote-submit="' + v.id + '"'
        +   (my.length ? '' : ' disabled style="opacity:.45"') + '>'
        +   '确定投票' + (my.length ? '（' + my.length + ' 项）' : '') + '</button>'
        + (editing ? '<span class="vote-hint">点选项可继续增删，确定后才上传</span>' : '')
        + '</div>';
    }
  }

  var meta = [];
  meta.push(closed ? '🔒 ' + (v.status === 'closed' ? '已截止' : '已结束') : '⏳ ' + voteRemainText(v));
  if(v.deadline) meta.push('截止 ' + voteTimeText(v.deadline));
  if(v.results) meta.push('共 ' + (v.voters || totalVotes) + ' 人参与');
  else if(voted) meta.push('你已投票');
  /* v3.5.12 #10（站主要求）：谁提出来的 + 提出的日期，直接写在卡片上 */
  var proposer = v.proposer || v.createdByDisplay || v.createdByName || '';
  var pdate = voteDateText(v.createdDate || v.createdAt);
  var proposeLine = (proposer || pdate)
    ? '<div class="vote-proposer">'
      + '提出人：<b>' + esc(proposer || '未记录') + '</b>'
      + (pdate ? '<span class="vote-proposer-date">' + esc(pdate) + ' 提出</span>' : '')
      + '</div>'
    : '';

  return '<div class="vote-card" data-vote-card="' + v.id + '">'
    + '<div class="vote-card-h">'
    +   '<div class="vote-title">' + esc(v.title)
    +     (v.kind === 'song' ? '<span class="vote-kind">歌单</span>' : '') + '</div>'
    +   proposeLine
    +   '<div class="vote-meta">' + meta.map(esc).join(' · ') + '</div>'
    + '</div>'
    + (v.note ? '<p class="vote-note">' + esc(v.note) + '</p>' : '')
    + '<div class="vote-opts' + (v.results ? ' is-res' : '') + '">' + optsHtml + '</div>'
    + addHtml
    + submitHtml
    + '<div class="vote-msg" id="voteMsg' + v.id + '"></div>'
    + votePubRender(v)
    + '</div>';
}

/* 事件绑定（innerHTML 重建后要重新绑） */
function voteBind(){
  var body = document.getElementById('voteBody');
  if(!body) return;

  /* v3.5.14：点赞 = 选择；确定后才上传；已投再点 → 撤回确认 */
  Array.prototype.forEach.call(body.querySelectorAll('[data-vote-pick]'), function(btn){
    btn.onclick = function(){
      votePick(Number(btn.dataset.votePick), btn.dataset.oid);
    };
  });

  Array.prototype.forEach.call(body.querySelectorAll('[data-vote-submit]'), function(btn){
    btn.onclick = function(){ voteSubmitDraft(Number(btn.dataset.voteSubmit)); };
  });

  /* v3.5.18：选项里的「详情」—— 展开点歌人 / 点歌时间。
     ⚠️ 必须 stopPropagation：选项本身是投票按钮，冒泡上去会误投一票。 */
  Array.prototype.forEach.call(body.querySelectorAll('[data-vote-more]'), function(sp){
    sp.onclick = function(ev){
      ev.preventDefault();
      ev.stopPropagation();
      var host = sp.closest('.vote-opt, .vote-res');
      if(!host) return;
      host.classList.toggle('open');
      sp.textContent = host.classList.contains('open') ? '收起' : '详情';
    };
  });

  Array.prototype.forEach.call(body.querySelectorAll('[data-vote-retract]'), function(btn){
    btn.onclick = function(){ voteAskRetract(Number(btn.dataset.voteRetract), null); };
  });

  Array.prototype.forEach.call(body.querySelectorAll('[data-vote-add]'), function(btn){
    btn.onclick = function(){ voteAddOption(Number(btn.dataset.voteAdd)); };
  });
}

/* v3.5.14：投票轮播 —— scroll-snap 容器 + 圆点 + 左右箭头。
   刷新后按 VOTE.curId 回到用户原来在看的那一场，不会被打回第一个。 */
function voteSwipeBind(all, curIdx){
  var box = document.getElementById('voteSwipe');
  if(!box) return;
  var dots = Array.prototype.slice.call(document.querySelectorAll('[data-vote-dot]'));
  var pos = document.getElementById('votePosTxt');
  var prev = document.querySelector('[data-vote-prev]');
  var next = document.querySelector('[data-vote-next]');
  var idx = curIdx || 0;

  function paint(i){
    dots.forEach(function(d, k){ d.classList.toggle('on', k === i); });
    if(pos) pos.textContent = '第 ' + (i + 1) + ' / ' + all.length + ' 个';
    if(prev) prev.disabled = (i <= 0);
    if(next) next.disabled = (i >= all.length - 1);
  }
  /* 卡片之间有 12px 间距，按「相邻两 slide 的 offsetLeft 差」算步长，
     不然每翻一页会累积偏 12px（实测 scrollLeft 328 vs 宽 316） */
  function stepW(){
    var a = box.children[0], b = box.children[1];
    if(a && b) return b.offsetLeft - a.offsetLeft;
    return box.clientWidth || 1;
  }
  function go(i, smooth){
    i = Math.max(0, Math.min(all.length - 1, i));
    idx = i;
    VOTE.curId = all[i] ? all[i].id : null;
    var x = i * stepW();
    try{ box.scrollTo({ left: x, behavior: smooth ? 'smooth' : 'auto' }); }
    catch(e){ box.scrollLeft = x; }
    paint(i);
  }
  requestAnimationFrame(function(){ go(idx, false); });

  var t = null;
  box.onscroll = function(){
    clearTimeout(t);
    t = setTimeout(function(){
      if(!box.clientWidth) return;
      var i = Math.max(0, Math.min(all.length - 1, Math.round(box.scrollLeft / stepW())));
      if(i !== idx){ idx = i; VOTE.curId = all[i] ? all[i].id : null; paint(i); }
    }, 90);
  };
  if(prev) prev.onclick = function(){ go(idx - 1, true); };
  if(next) next.onclick = function(){ go(idx + 1, true); };
  dots.forEach(function(d, i){
    d.onclick = function(){ go(i, true); };
  });
  /* 转屏 / 改窗口大小后重新对齐当前页 */
  if(!window.__voteSwipeResize){
    window.__voteSwipeResize = true;
    window.addEventListener('resize', function(){
      var b2 = document.getElementById('voteSwipe');
      if(b2 && VOTE.curId != null){
        var i2 = (VOTE.order || []).indexOf(VOTE.curId);
        if(i2 >= 0){
          var a2 = b2.children[0], b3 = b2.children[1];
          var sw = (a2 && b3) ? (b3.offsetLeft - a2.offsetLeft) : b2.clientWidth;
          try{ b2.scrollLeft = i2 * sw; }catch(e){}
        }
      }
    });
  }
}

function voteMsg(vid, txt, kind){
  var el = document.getElementById('voteMsg' + vid);
  if(!el) return;
  el.innerHTML = txt ? '<span class="vote-msg-' + (kind || 'ok') + '">' + esc(txt) + '</span>' : '';
}

/* v3.5.14（站主新要求）
   · 点赞只改本地选择，可以随便取消 —— 没上传就不算撤回，不消耗次数；
   · 点「确定投票」才上传；
   · 已经投过票再点点赞 → 弹窗确认「撤回重新投票（还剩 N 次）」，确认才真的撤回。 */
function voteFind(vid){
  for(var i = 0; i < VOTE.votes.length; i++) if(VOTE.votes[i].id === vid) return VOTE.votes[i];
  return null;
}
function votePick(vid, oid){
  if(VOTE.busy) return;
  var v = voteFind(vid); if(!v) return;
  var submitted = !!((v.myChoices && v.myChoices.length) || v.mine);
  /* 已投状态下的第一次点击 = 想改票 → 先问要不要撤回 */
  if(submitted && VOTE.picked[vid] == null){ voteAskRetract(vid, oid); return; }
  var cur = (VOTE.picked[vid] || []).slice();
  var at = cur.indexOf(oid);
  if(v.multi){
    if(at >= 0) cur.splice(at, 1);
    else{
      if(v.maxChoices && cur.length >= v.maxChoices){
        voteMsg(vid, '这场投票最多选 ' + v.maxChoices + ' 项，先取消一个再选', 'err');
        return;
      }
      cur.push(oid);
    }
  }else{
    cur = (at >= 0) ? [] : [oid];
  }
  VOTE.picked[vid] = cur;
  voteRenderAll();
  voteMsg(vid, cur.length
    ? '已选择 ' + cur.length + ' 项，点「确定投票」才会上传'
    : '已取消选择（还没上传，不消耗撤回次数）', 'ok');
}
function voteSubmitDraft(vid){
  if(VOTE.busy) return;
  var choices = (VOTE.picked[vid] || []).slice();
  if(!choices.length){ voteMsg(vid, '先点 👍 选一个选项', 'err'); return; }
  VOTE.busy = true;
  voteMsg(vid, '提交中…');
  api('/votes?action=vote', { method: 'POST', body: { voteId: vid, choices: choices } })
    .then(function(j){
      VOTE.busy = false;
      delete VOTE.picked[vid];
      return voteReload().then(function(){ voteMsg(vid, '✅ ' + (j.message || '投票成功')); });
    })
    .catch(function(e){
      VOTE.busy = false;
      voteMsg(vid, '❌ ' + (e.message || String(e)), 'err');
    });
}
/* 撤回确认：oid 有值 = 点了某个选项想改票（撤回后直接把这项选上）；null = 点了「撤回重投」按钮 */
function voteAskRetract(vid, oid){
  if(VOTE.busy) return;
  var v = voteFind(vid); if(!v) return;
  var left = Math.max(0, (v.retractLimit == null ? 1 : v.retractLimit) - (v.retractUsed || 0));
  if(left <= 0){
    voteMsg(vid, '这场投票的撤回机会已经用完了（每人 ' + (v.retractLimit || 1) + ' 次）', 'err');
    return;
  }
  var msg = '你已经投过这场票了。\n\n撤回后可以重新投票，但会消耗 1 次撤回机会'
    + '（还剩 ' + left + ' 次）。' + (v.multi ? '\n（多选撤回会清空本场全部选择）' : '')
    + '\n\n确定撤回吗？';
  if(!window.confirm(msg)) return;
  VOTE.busy = true;
  voteMsg(vid, '撤回中…');
  api('/votes?action=retract', { method: 'POST', body: { voteId: vid } })
    .then(function(j){
      VOTE.busy = false;
      delete VOTE.picked[vid];
      return voteReload().then(function(){
        if(oid){ VOTE.picked[vid] = [oid]; voteRenderAll(); }
        voteMsg(vid, '✅ ' + (j.message || '已撤回') + (oid ? '，已帮你选上刚才点的那项，确认后上传' : ''));
      });
    })
    .catch(function(e){
      VOTE.busy = false;
      voteMsg(vid, '❌ ' + (e.message || String(e)), 'err');
    });
}

function voteAddOption(vid){
  if(VOTE.busy) return;
  var inp = document.getElementById('voteAddInput' + vid);
  var label = inp ? String(inp.value || '').trim() : '';
  if(!label){ voteMsg(vid, '请先填写选项内容', 'err'); return; }
  VOTE.busy = true;
  api('/votes?action=add-option', { method: 'POST', body: { voteId: vid, label: label } })
    .then(function(){
      VOTE.busy = false;
      if(inp) inp.value = '';
      return voteReload();
    })
    .catch(function(e){
      VOTE.busy = false;
      voteMsg(vid, e.message || String(e), 'err');
    });
}

/* v3.5.14 #9：不再有本地草稿，服务端就是唯一真相 */
function voteReload(){
  return api('/votes?action=list').then(function(j){
    VOTE.votes = (j && j.votes) || [];
    VOTE.loaded = true;
    VOTE.picked = {};
    /* v3.5.24：重排后（按赞数从高到低）页面会跳 —— 保留投票区的滚动位置与当前那张卡 */
    if(typeof withScrollPreserve === 'function'){
      withScrollPreserve(voteRenderAll);
    }else{
      voteRenderAll();
    }
  });
}

/* ============================================================================
 * 成绩分析（前台 · 第四十五轮 · v2.7.2 起）
 * ----------------------------------------------------------------------------
 * 站主定案（见《成绩分析-需求总表》）：
 *   · 未登录 = 一条成绩都看不到（接口层已拦，这里只做引导）
 *   · 全班成绩单可见（姓名 + 各科 + 总分 + 排名），**他人的详细分析不可见**
 *   · 个人画像：概览卡 / 上线情况 / 各科趋势卡 / 单科排名 / 雷达图 / 位置条 / 进退步
 *   · 排名口径可切（默认总分赋分，可切原始）
 *   · 分数线没填就不画不统计
 *   · 只录大考 → 「近 N 次」在时间上跨度很大，所以默认看全部、并标出实际覆盖时间
 *
 * 【关键设计：所有统计都在浏览器算】
 *   服务器只给原始分。排名 / 均分 / 分数段 / 上线人数 / 进退步全部在这里实时算，
 *   好处是站主改一个分数之后，这里刷新一下立刻自洽，不会出现"分数改了排名没变"。
 * ========================================================================= */

var SC = {
  exams: [],      /* 已发布的考试列表（按时间倒序） */
  exam: null,     /* 当前选中的考试 */
  rows: [],       /* 当前考试的全部成绩行 */
  me: null,       /* 我的历次成绩（趋势用） */
  tab: 'board',   /* board 全班成绩单 | me 我的画像 */
  trendN: 'all',  /* 趋势看几次：3 | 5 | 'all'（只录大考，默认全部） */
  basis: 'graded',/* graded 总分赋分 | raw 总分原始 */
  sortKey: 'rank',
  sortAsc: true,
  /* v3.9.0：仅赋分排名按「两科合计增值」排，涨得多的在上面（降序） */
  gSortKey: 'dSum',
  gSortAsc: false,
  allRows: null,  /* 懒加载的历次全班成绩 { examId: {exam, rows} }，用于上线率趋势 */
  config: null,   /* 后台配置（对外展示档位等），进页面时取一次 */
  quadKey: null,  /* 四象限当前看哪一科 */
  quadSel: null,  /* 四象限当前点开了哪个象限（0..3，null=没点开）——手机点开看名单 */
  quadDot: null,  /* 四象限当前点中的那一个人（下标，null=没点） */
  subTrend: 'score',  /* 各科趋势看分数还是看名次（'score' | 'rank'） */
  tailSortKey: 'd',   /* 进退步榜排序键（v3.3.0：合并成一张表，点表头排） */
  tailSortAsc: false, /* 默认按名次变化降序＝进步最多的在最上面 */
  hmSel: null,        /* 热力图上点中的格子（单元格下标，null=没点） */
  _hm: null,          /* 热力图每格的数据（供点选时出明细，不重新渲染） */
  _quad: null,    /* 最近一次四象限渲染的点数据（供点选时算名单，不重新渲染） */
  /* v3.5.6 需关注筛选：all 全部 / total 总分不达标 / subj 仅单科 / drop 连续两次退步 */
  careFilter: 'all',
  careSortKey: 'total',
  careSortAsc: true,
  pkA: null,      /* 成绩对比 PK：A 方成绩行 id（v2.10.0） */
  pkB: null,      /* 成绩对比 PK：B 方成绩行 id（v2.10.0） */
  pkExam2: null,  /* v3.4.0：跨考试对比的第二场考试 id（null = 只看本场） */
  basisSet: false,/* 用户是否自己切过口径（切过就不再被后台默认值覆盖） */
  trendSet: false,
  loaded: false,
  loading: false,
};

/* ---------------- 入口 ---------------- */
/* 打开成绩分析。
   v2.9.6 改版（站主原话：「点开成绩分析直接展示而不是卡片+弹窗」）：
   成绩分析现在**长在板块 3 里**，点侧边栏就看见内容，不再有卡片中转、也不再弹全屏框。
   这个函数名保留（通知跳转 / 弹窗白名单 / 老引用都指向它），语义改成「切到那个板块并确保已就绪」。 */
function openScoreAnal(){
  if(typeof openCat === 'function') openCat(3);
  scEnsureMounted();
}
/* 内嵌挂载：切到板块后、以及 render() 重建 DOM 之后，都要调一次。
   两种情况不一样 —— 第一次要真的去请求，后面只是「容器被重建了，重绘一下」。 */
function scEnsureMounted(){
  if(!document.getElementById('scPaneBox')) return;   /* 不在这个板块里，什么都不做 */
  if(!isLoggedIn()){
    document.getElementById('scBar').innerHTML = '';
    document.getElementById('scTabs').innerHTML = '';
    document.getElementById('scPaneBox').innerHTML =
      '<div class="sc-empty">'
      + '<div class="sc-empty-ico">🔐</div>'
      + '<p>成绩分析需要登录后才能查看。</p>'
      + '<button class="btn" onclick="openAccount(\'login\')">去登录</button>'
      + '</div>';
    return;
  }
  if(!SC.loaded){ scLoad(); return; }
  /* 数据还在内存里（render() 重建会把容器清空），重绘即可，不必再请求一次 */
  scRenderAll();
}
/* 老函数名兼容：原先用来关弹窗。现在没有弹窗了，就当「返回首页」。 */
function closeScoreAnal(){
  if(typeof goHomeView === 'function') goHomeView();
}

/* 成绩分析板块的内嵌骨架。
   容器 id 沿用原来的 scBar / scTabs / scPaneBox —— 渲染函数一行都不用改。 */
function scEmbedHtml(){
  return '<div class="sc-embed" id="scEmbed">'
    + '<div class="sc-notebar">✍️ 成绩由人工手动录入，若有错误请联系管理员修改</div>'
    + '<div class="sc-bar" id="scBar"></div>'
    + '<div class="sc-tabs" id="scTabs"></div>'
    + '<div class="sc-pane" id="scPaneBox"></div>'
    + '</div>';
}
function scPane(html){ document.getElementById('scPaneBox').innerHTML = html; }
function scLoading(txt){
  scPane('<div class="sc-empty"><div class="spinner"></div><p>' + (txt || '加载中…') + '</p></div>');
}

/* ---------------- 取数 ---------------- */
function scLoad(){
  SC.loading = true;
  scLoading('正在读取成绩…');
  Promise.all([
    api('/scores?action=list'),
    api('/scores?action=config').catch(function(){ return null; }),
  ]).then(function(res){
    var j = res[0];
    var cfg = (res[1] && res[1].config) || null;
    if(cfg){
      SC.config = cfg;
      /* 后台设定的默认口径 / 默认看几次：只在用户没自己切过的时候生效 */
      if(!SC.basisSet && cfg.rankBasis){ SC.basis = cfg.rankBasis; SC.basisSet = true; }
      if(!SC.trendSet && cfg.trendDefault){
        SC.trendN = cfg.trendDefault === 'all' ? 'all' : Number(cfg.trendDefault);
        SC.trendSet = true;
      }
    }
    /* 考试一律按日期排序（最近的在前）—— 后端已经排过，这里再排一次兜底：
       早期几次考试的日期填得不规范，出现过"顺序看着不对"的情况。 */
    SC.exams = (j.exams || []).slice().sort(function(a, b){
      if(a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (b.id || 0) - (a.id || 0);
    });
    SC.loaded = true;
    /* 站主把整个功能关了 → 学生这里只看到一句话（他自己不受影响） */
    if(cfg && cfg.access === 'off' && !scIsAdmin()){
      document.getElementById('scBar').innerHTML = '';
      document.getElementById('scTabs').innerHTML = '';
      scPane('<div class="sc-empty">'
        + '<div class="sc-empty-ico">📊</div>'
        + '<p><b>暂未对外开放</b></p>'
        + '<p class="sc-dim">成绩分析正在准备中。等老师开放后，这里就能看到全班成绩单和你的个人分析。</p>'
        + '</div>');
      return;
    }
    if(!SC.exams.length){
      SC.loading = false;
      scPane('<div class="sc-empty">'
        + '<div class="sc-empty-ico">📊</div>'
        + '<p><b>暂未对外开放</b></p>'
        + '<p class="sc-dim">成绩分析正在准备中。等老师发布成绩后，这里就能看到全班成绩单和你的个人分析。</p>'
        + '</div>');
      return;
    }
    scPickExam(SC.exams[0].id);
  }).catch(function(e){
    SC.loading = false;
    scPane('<div class="sc-empty"><p>读取失败：' + esc(e.message || e) + '</p>'
      + '<button class="btn" onclick="SC.loaded=false;scLoad()">重试</button></div>');
  });
}

function scPickExam(id){
  var ex = null;
  for(var i = 0; i < SC.exams.length; i++) if(SC.exams[i].id === id) ex = SC.exams[i];
  if(!ex) ex = SC.exams[0];
  SC.exam = ex;
  scLoading('正在读取「' + ex.name + '」…');
  Promise.all([
    api('/scores?action=board&exam=' + ex.id),
    SC.me ? Promise.resolve(null) : api('/scores?action=me').catch(function(){ return null; }),
  ]).then(function(r){
    var d = r[0];
    SC.exam = d.exam;
    SC.rows = d.rows || [];
    /* v2.10.0：换考试后旧的行 id 全部失效，PK 选择重置为默认（我 + 总分第一） */
    SC.pkA = null; SC.pkB = null;
    /* v3.4.0：第二场考试若与新的当前考试相同，也一并清掉 */
    if(SC.pkExam2 != null && SC.pkExam2 === ex.id) SC.pkExam2 = null;
    if(r[1] && r[1].items) SC.me = r[1].items;
    SC.loading = false;
    scRenderAll();
    /* v3.5.6：需关注里的「连续两次退步」要看上一场，异步补一次，回来再重画这一块 */
    scLoadPrevPack(ex.id);
  }).catch(function(e){
    scPane('<div class="sc-empty"><p>读取失败：' + esc(e.message || e) + '</p>'
      + '<button class="btn" onclick="scPickExam(' + id + ')">重试</button></div>');
  });
}

/* v3.5.6 需关注「连续两次退步」的数据源：当前考试之前的那一场（只看紧邻的上一场）。
   懒加载 + 缓存到 SC._prevPacks[examId]；没有更早的考试就记 null，避免反复请求。
   回来之后只在「还在看同一场」时才重画，免得切走了又被旧数据冲回来。 */
function scLoadPrevPack(examId){
  SC._prevPacks = SC._prevPacks || {};
  if(Object.prototype.hasOwnProperty.call(SC._prevPacks, examId)) return;
  /* SC.exams 是时间倒序：当前考试的下一项就是上一场 */
  var idx = -1;
  for(var i = 0; i < SC.exams.length; i++) if(SC.exams[i].id === examId){ idx = i; break; }
  var prev = (idx >= 0 && SC.exams[idx + 1]) ? SC.exams[idx + 1] : null;
  if(!prev){ SC._prevPacks[examId] = null; return; }
  SC._prevPacks[examId] = null;   /* 先占位，防止并发重复请求 */
  api('/scores?action=board&exam=' + prev.id).then(function(d){
    SC._prevPacks[examId] = { exam: d.exam, rows: d.rows || [] };
    if(SC.exam && SC.exam.id === examId && SC.tab === 'board') scRenderBoard();
  }).catch(function(){ /* 拉不到就当没有上一场，筛选显示 0 人，不打扰用户 */ });
}

/* ---------------- 计算（全部实时算） ---------------- */
function scSubScore(row, s, basis){
  var v = row.s && row.s[s.key];
  if(!v) return null;
  var useGraded = (basis === 'graded' && s.graded && v.assigned != null);
  var val = useGraded ? v.assigned : v.raw;
  return (val == null) ? null : val;
}

function scTotal(row, basis){
  var subs = (SC.exam && SC.exam.subjects) || [];
  var t = 0, any = false;
  for(var i = 0; i < subs.length; i++){
    var v = scSubScore(row, subs[i], basis);
    if(v == null) continue;
    t += v; any = true;
  }
  return any ? t : null;
}

/* 排名：同分并列（1,2,2,4 这种） */
function scRankMap(basis){
  var out = {};
  var subs = (SC.exam && SC.exam.subjects) || [];

  /* 总分排名 */
  var arr = [];
  SC.rows.forEach(function(r){
    var t = scTotal(r, basis);
    if(t != null) arr.push({ id: r.id, v: t });
  });
  arr.sort(function(a, b){ return b.v - a.v; });
  var rank = 0, prev = null;
  var totalRank = {};
  arr.forEach(function(x, i){
    if(prev === null || x.v !== prev){ rank = i + 1; prev = x.v; }
    totalRank[x.id] = rank;
  });
  out.total = totalRank;
  out.totalCount = arr.length;

  /* 单科排名 */
  out.subj = {};
  subs.forEach(function(s){
    var a = [];
    SC.rows.forEach(function(r){
      var v = scSubScore(r, s, basis);
      if(v != null) a.push({ id: r.id, v: v });
    });
    a.sort(function(x, y){ return y.v - x.v; });
    var rk = 0, pv = null, map = {};
    a.forEach(function(x, i){
      if(pv === null || x.v !== pv){ rk = i + 1; pv = x.v; }
      map[x.id] = rk;
    });
    out.subj[s.key] = { rank: map, count: a.length };
  });
  return out;
}

function scStats(basis){
  var list = [];
  SC.rows.forEach(function(r){
    var t = scTotal(r, basis);
    if(t != null) list.push(t);
  });
  list.sort(function(a, b){ return a - b; });
  var n = list.length;
  var sum = 0;
  for(var i = 0; i < n; i++) sum += list[i];
  return {
    n: n,
    avg: n ? sum / n : 0,
    median: !n ? 0 : (n % 2 ? list[(n - 1) / 2] : (list[n / 2 - 1] + list[n / 2]) / 2),
    max: n ? list[n - 1] : 0,
    min: n ? list[0] : 0,
    list: list,
  };
}

function scFullMark(){
  var subs = (SC.exam && SC.exam.subjects) || [];
  var f = 0;
  subs.forEach(function(s){ f += (s.full || 0); });
  return f || 750;
}

/* 我的那一行。三条路依次试，认出来就行：
   ① 后端标好的 uid；② 后端给的 mine 标记（含「姓名对照」别名，改过名也认）；
   ③ 本地按姓名比一次（纯兜底）。 */
function scMyRow(){
  var u = AUTH.user || {};
  var myName = u.displayName || u.name || '';
  var myId = u.id;
  var hit = null;
  if(myId){
    SC.rows.forEach(function(r){
      if(hit) return;
      if(r.uid && String(r.uid) === String(myId)) hit = r;
    });
  }
  if(!hit){
    SC.rows.forEach(function(r){
      if(hit) return;
      if(r.mine) hit = r;
    });
  }
  if(!hit && myName){
    SC.rows.forEach(function(r){
      if(hit) return;
      if(r.name === myName) hit = r;
    });
  }
  return hit;
}

/* ---------------- 渲染 ---------------- */
/* v3.3.0 热力图点选：走事件委托，只在文档上挂一次 —— 整张表重渲染也不用重新绑定 */
function scHeatBind(){
  if(window.__scHeatBound) return;
  window.__scHeatBound = 1;
  document.addEventListener('click', function(e){
    var t = e.target;
    if(!t || !t.closest) return;
    var cell = t.closest('.sc-hm-hit');
    if(cell && cell.closest('.sc-hm-body')){ scHeatTap(cell); }
  }, false);
}

function scRenderAll(){
  scHeatBind();
  scRenderBar();
  scRenderTabs();
  scRenderPane();
}

/* 考试日期的显示文案：跨天显示成 2026-05-14 ~ 05-15，单日就一个日期 */
function scDateRange(ex){
  if(!ex) return '';
  var a = ex.date || '', b = ex.endDate || '';
  if(!b || b === a) return a;
  if(a.slice(0, 4) === b.slice(0, 4)) return a + ' ~ ' + b.slice(5);
  return a + ' ~ ' + b;
}

function scRenderBar(){
  var opts = SC.exams.map(function(e){
    return '<option value="' + e.id + '"' + (SC.exam && e.id === SC.exam.id ? ' selected' : '') + '>'
      + esc(e.name) + '　' + esc(scDateRange(e)) + '</option>';
  }).join('');

  document.getElementById('scBar').innerHTML =
    '<div class="sc-bar-row">'
    + '<select class="sc-sel" onchange="scPickExam(Number(this.value))">' + opts + '</select>'
    + '<div class="sc-seg">'
    +   '<button class="' + (SC.basis === 'graded' ? 'on' : '') + '" onclick="scSetBasis(\'graded\')">总分赋分</button>'
    +   '<button class="' + (SC.basis === 'raw' ? 'on' : '') + '" onclick="scSetBasis(\'raw\')">总分原始</button>'
    + '</div>'
    + '<div class="sc-seg sc-seg-icon">'
    +   '<button onclick="scExportDialog()" title="勾选要导出的内容，生成一张图片（可直接发微信）">导出图片</button>'
    +   '<button onclick="scPrint()" title="按 A4 版式打印当前页面">打印</button>'
    +   '<button onclick="scShareDialog()" title="生成一个免登录的只读链接">分享</button>'
    + '</div>'
    + '</div>'
    + '<div class="sc-meta">'
    +   esc(SC.exam.type || '考试') + '　' + esc(scDateRange(SC.exam)) + '　共 ' + SC.rows.length + ' 人'
    +   (SC.exam.note ? '　·　' + esc(SC.exam.note) : '')
    /* 原来这句写在「成绩分析」卡片的说明里；v2.9.6 去掉卡片后挪到这里，别丢 */
    +   '<br>数据仅本班同学登录后可见，请勿截图外传。'
    + '</div>';
}

function scSetBasis(b){
  SC.basis = b;
  SC.basisSet = true;
  scRenderAll();
}

function scRenderTabs(){
  var hasMe = !!scMyRow();
  document.getElementById('scTabs').innerHTML =
    '<button class="' + (SC.tab === 'board' ? 'on' : '') + '" onclick="scSetTab(\'board\')">全班成绩单</button>'
    + '<button class="' + (SC.tab === 'me' ? 'on' : '') + '" onclick="scSetTab(\'me\')">我的画像</button>'
    /* v2.10.0 成绩对比 PK：任选两人 + 同一场考试（数据用当前考试的 SC.rows） */
    + '<button class="' + (SC.tab === 'pk' ? 'on' : '') + '" onclick="scSetTab(\'pk\')">成绩对比</button>';
}
function scSetTab(t){ SC.tab = t; scRenderTabs(); scRenderPane(); }

function scRenderPane(){
  if(SC.tab === 'me') scRenderMe();
  else if(SC.tab === 'pk') scRenderPk();
  else scRenderBoard();
}

/* ---------- 全班成绩单 ---------- */
function scRenderBoard(){
  if(!SC.rows.length){
    scPane('<div class="sc-empty"><p>这次考试还没有成绩。</p></div>');
    return;
  }
  var subs = SC.exam.subjects || [];
  var rk = scRankMap(SC.basis);
  var me = scMyRow();

  /* 组装可排序数据 */
  var arr = SC.rows.map(function(r){
    var o = { row: r, name: r.name, total: r._t = scTotal(r, SC.basis), rank: rk.total[r.id] || null, schoolRank: r.schoolRank, leagueRank: r.leagueRank };
    subs.forEach(function(s){ o[s.key] = scSubScore(r, s, SC.basis); });
    return o;
  });

  var key = SC.sortKey, asc = SC.sortAsc;
  arr.sort(function(a, b){
    var x = a[key], y = b[key];
    if(x == null && y == null) return 0;
    if(x == null) return 1;      /* 缺考/空值永远垫底 */
    if(y == null) return -1;
    if(typeof x === 'string') return asc ? (x > y ? 1 : x < y ? -1 : 0) : (x < y ? 1 : x > y ? -1 : 0);
    return asc ? x - y : y - x;
  });

  var head = '<tr>'
    + '<th class="sc-th-sort" onclick="scSort(\'rank\')">班排' + scArrow('rank') + '</th>'
    + '<th class="sc-th-sort" onclick="scSort(\'name\')">姓名' + scArrow('name') + '</th>'
    + subs.map(function(s){
        return '<th class="sc-th-sort" onclick="scSort(\'' + s.key + '\')">' + esc(s.name) + scArrow(s.key) + '</th>';
      }).join('')
    + '<th class="sc-th-sort" onclick="scSort(\'total\')">总分' + scArrow('total') + '</th>'
    + '<th class="sc-th-sort" onclick="scSort(\'schoolRank\')">年级排名<span class="sc-subrank" style="font-weight:400">物理方向</span>' + scArrow('schoolRank') + '</th>'
    + '</tr>';

  var body = arr.map(function(o){
    var isMe = me && o.row.id === me.id;
    var medal = o.rank === 1 ? ' sc-r1' : o.rank === 2 ? ' sc-r2' : o.rank === 3 ? ' sc-r3' : '';
    return '<tr class="' + (isMe ? 'sc-me-row' : '') + '">'
      + '<td class="sc-rank' + medal + '">' + (o.rank == null ? '—' : o.rank) + '</td>'
      + '<td class="sc-name">' + esc(o.name) + (isMe ? '<span class="sc-you">我</span>' : '') + '</td>'
      + subs.map(function(s){
          var v = o[s.key];
          var sr = rk.subj[s.key].rank[o.row.id];
          return '<td>' + (v == null ? '<span class="sc-dim">—</span>' : v)
            + (v != null && sr ? '<span class="sc-subrank">' + sr + '</span>' : '') + '</td>';
        }).join('')
      + '<td class="sc-total">' + (o.total == null ? '—' : o.total) + '</td>'
      + '<td>' + (o.schoolRank == null ? '<span class="sc-dim">—</span>' : o.schoolRank) + '</td>'
      + '</tr>';
  }).join('');

  var st = scStats(SC.basis);
  scPane(
      '<div class="sc-hint">点表头可排序。科目格右下角的小字是<b>该科班内排名</b>。'
    + (SC.basis === 'graded' ? '化学、生物按赋分计入总分。' : '当前按原始分计算（化学、生物不用赋分）。')
    + '</div>'
    + '<div class="sc-stats" data-scblk="board_avg">'
    +   scStatCard('班均分', st.avg.toFixed(1))
    +   scStatCard('中位数', st.median)
    +   scStatCard('最高', st.max)
    +   scStatCard('参考', st.n + ' 人')
    + '</div>'
    + '<div class="sc-tblwrap" data-scroll-keep data-scblk="board_table"><table class="sc-tbl sc-fix2">'
    +   '<thead>' + head + '</thead><tbody>' + body + '</tbody>'
    + '</table></div>'
    + scChartHist(st)
    + scChartCutlines(st)
    + scChartSegments(st)
    + scGradedBlock()
    + scTeacherBlocks()
  );
}

/* ============================================================================
 * v3.9.0（站主）：仅赋分排名 —— 只看化学 + 生物，只比「赋分涨了多少分」
 * ----------------------------------------------------------------------------
 * 站主原话：
 *   「那个赋分的排名现在只需展示分数差值，就是看一下这两科分别赋了多少分，然后
 *     加起来一共赋了多少分，然后再根据赋分的差值再进行一个排名，不用具体的分数了。」
 *
 * 所以这张表只剩四列 + 名次：
 *   化学 +36 · 生物 +28 · 合计 +64 · 第 3 名
 * 差值 = 赋分 − 原始分。分数本身不再出现（要看分数去上面那张全班的表）。
 * 排名按「两科合计差值」从高到低，同分并列（1,2,2,4）。
 * ========================================================================= */
function scGradedSubs(){
  var subs = (SC.exam && SC.exam.subjects) || [];
  var want = ['chemistry', 'biology'];
  return want.map(function(k){
    for(var i = 0; i < subs.length; i++){ if(subs[i].key === k) return subs[i]; }
    return null;
  }).filter(Boolean);
}

function scGradedData(){
  var pair = scGradedSubs();
  if(pair.length < 2) return null;
  var C = pair[0], B = pair[1];
  var meRow = scMyRow();

  var rows = SC.rows.map(function(r){
    var cv = (r.s && r.s[C.key]) || {};
    var bv = (r.s && r.s[B.key]) || {};
    var cRaw = cv.raw == null ? null : Number(cv.raw);
    var cGrd = cv.assigned == null ? null : Number(cv.assigned);
    var bRaw = bv.raw == null ? null : Number(bv.raw);
    var bGrd = bv.assigned == null ? null : Number(bv.assigned);
    return {
      id: r.id, name: r.name, isMe: !!(meRow && r.id === meRow.id),
      cD: (cRaw != null && cGrd != null) ? (cGrd - cRaw) : null,
      bD: (bRaw != null && bGrd != null) ? (bGrd - bRaw) : null,
      cGrd: cGrd, bGrd: bGrd,
    };
  });

  rows.forEach(function(o){
    o.dSum = (o.cD != null && o.bD != null) ? (o.cD + o.bD) : null;
    o.gSum = (o.cGrd != null && o.bGrd != null) ? (o.cGrd + o.bGrd) : null;
  });

  /* 排名只看「两科合计差值」；同分并列（1,2,2,4） */
  var arr = rows.filter(function(o){ return o.dSum != null; })
    .slice().sort(function(a, b){ return b.dSum - a.dSum; });
  var rank = 0, prev = null;
  arr.forEach(function(o, i){
    if(prev === null || o.dSum !== prev){ rank = i + 1; prev = o.dSum; }
    o.rank = rank;
  });

  return { C: C, B: B, rows: rows };
}

function scGradedBlock(){
  var d = scGradedData();
  if(!d){
    return '<div class="sc-figcap" style="margin-top:18px">'
      + '这场考试没有同时录化学和生物，暂时算不了仅赋分排名。</div>';
  }

  var key = SC.gSortKey, asc = SC.gSortAsc;
  var arr = d.rows.slice();
  arr.sort(function(a, b){
    var x = a[key], y = b[key];
    if(x == null && y == null) return 0;
    if(x == null) return 1;
    if(y == null) return -1;
    if(typeof x === 'string') return asc ? (x > y ? 1 : x < y ? -1 : 0) : (x < y ? 1 : x > y ? -1 : 0);
    return asc ? x - y : y - x;
  });

  function th(k, label){
    return '<th class="sc-th-sort" onclick="scGSort(\'' + k + '\')">' + label + scGArrow(k) + '</th>';
  }
  /* 站主：「+24（增值）→84（赋分）」，页面上用不同颜色区分 */
  function dc(v, assigned){
    if(v == null) return '<td><span class="sc-dim">—</span></td>';
    var d = (v === 0) ? '<span class="sc-dim">0</span>'
      : '<span class="' + (v > 0 ? 'sc-gd-up' : 'sc-gd-down') + '">' + (v > 0 ? '+' : '') + v + '</span>';
    if(assigned == null) return '<td>' + d + '</td>';
    return '<td>' + d + '<i class="sc-gd-ar">→</i><b class="sc-gd-as">' + assigned + '</b></td>';
  }
  function rankCell(o){
    if(o.rank == null) return '<td><span class="sc-dim">—</span></td>';
    var medal = o.rank === 1 ? '🥇' : o.rank === 2 ? '🥈' : o.rank === 3 ? '🥉' : '';
    return '<td class="sc-gd-rk">' + (medal ? medal + ' ' : '') + o.rank + '</td>';
  }

  var head = '<tr>'
    + th('name', '姓名')
    + th('cD', esc(d.C.name))
    + th('bD', esc(d.B.name))
    + th('dSum', '两科合计')
    + th('rank', '排名')
    + '</tr>';

  var body = arr.map(function(o){
    return '<tr class="' + (o.isMe ? 'sc-me-row' : '') + '">'
      + '<td class="sc-gd-name">' + esc(o.name) + (o.isMe ? '<span class="sc-you">我</span>' : '') + '</td>'
      + dc(o.cD, o.cGrd) + dc(o.bD, o.bGrd) + dc(o.dSum, o.gSum)
      + rankCell(o)
      + '</tr>';
  }).join('');

  return '<div class="sc-card-h" style="margin-top:22px">仅赋分排名'
      + '<span class="sc-h-note">' + esc(d.C.name) + ' + ' + esc(d.B.name) + '：增值 → 赋分</span>'
      + '</div>'
    + '<div class="sc-hint">'
      +   '每格读作 <span class="sc-gd-up">+24</span> → <b class="sc-gd-as">84</b>：'
      +   '左边是赋分比原始分多拿的分（增值），右边是赋分后的分数。'
      +   '<b>排名</b>按「两科合计增值」从高到低，同分并列。'
      + '</div>'
    + '<div class="sc-tblwrap" data-scroll-keep><table class="sc-tbl sc-gd-tbl">'
    +   '<thead>' + head + '</thead><tbody>' + body + '</tbody>'
    + '</table></div>';
}

function scGArrow(k){
  if(SC.gSortKey !== k) return '';
  return '<i class="sc-arw">' + (SC.gSortAsc ? '↑' : '↓') + '</i>';
}

function scGSort(k){
  if(SC.gSortKey === k) SC.gSortAsc = !SC.gSortAsc;
  /* 只有姓名按升序（拼音序），数值列一律先给「从高到低」 */
  else { SC.gSortKey = k; SC.gSortAsc = (k === 'name'); }
  scRenderBoard();
}



function scStatCard(k, v){
  return '<div class="sc-stat"><b>' + esc(String(v)) + '</b><span>' + esc(k) + '</span></div>';
}
function scArrow(k){
  if(SC.sortKey !== k) return '';
  return '<i class="sc-arw">' + (SC.sortAsc ? '↑' : '↓') + '</i>';
}
function scSort(k){
  if(SC.sortKey === k) SC.sortAsc = !SC.sortAsc;
  else { SC.sortKey = k; SC.sortAsc = (k === 'rank' || k === 'name'); }
  /* 重排整表会把下方所有块重建，热力图上正点开的格子也就跟着没了 —— 顺手清掉选中态 */
  SC.hmSel = null;
  scRenderBoard();
}

/* ---------- 图表：总分分布直方图（含分数线） ---------- */
function scChartHist(st){
  if(!st.n) return '';
  var full = scFullMark();
  var step = 20;
  var bins = [];
  for(var i = 0; i < full; i += step) bins.push(0);
  st.list.forEach(function(v){
    var idx = Math.min(bins.length - 1, Math.max(0, Math.floor(v / step)));
    bins[idx]++;
  });
  /* 只画有数据的区段，去掉两头大量空柱 */
  var first = -1, last = -1;
  bins.forEach(function(c, i){ if(c > 0){ if(first < 0) first = i; last = i; } });
  if(first < 0) return '';
  var pad = 1;
  first = Math.max(0, first - pad); last = Math.min(bins.length - 1, last + pad);
  var slice = bins.slice(first, last + 1);

  var W = 640, H = 180, L = 34, B = 26, T = 14, R = 14;
  var maxC = Math.max.apply(null, slice.concat([1]));
  var bw = (W - L - R) / slice.length;
  var xOf = function(i){ return L + i * bw; };
  var yOf = function(c){ return T + (H - T - B) * (1 - c / maxC); };

  /* 柱顶直接写「这一格多少人」——手机上看图不用去对纵轴 */
  var bars = slice.map(function(c, i){
    var h = H - B - yOf(c);
    var rect = '<rect x="' + (xOf(i) + 1).toFixed(1) + '" y="' + yOf(c).toFixed(1) + '" width="' + Math.max(1, bw - 2).toFixed(1)
      + '" height="' + Math.max(0, h).toFixed(1) + '" class="sc-bar" fill="#f0c9a3" rx="2"/>';
    if(c <= 0) return rect;
    /* 柱子窄的时候字号跟着缩，宁可小也别糊成一团 */
    var fs = bw < 13 ? 7 : (bw < 18 ? 8.5 : 9.5);
    return rect + '<text x="' + (xOf(i) + bw / 2).toFixed(1) + '" y="' + Math.max(8.5, yOf(c) - 3).toFixed(1)
      + '" font-size="' + fs + '" font-weight="700" class="sc-bar-num" fill="#8a6a4a" text-anchor="middle">' + c + '</text>';
  }).join('');

  var axis = '';
  for(var i = 0; i <= slice.length; i += Math.ceil(slice.length / 8)){
    var val = (first + i) * step;
    axis += '<text x="' + xOf(i).toFixed(1) + '" y="' + (H - 8) + '" font-size="9" class="sc-axdim" fill="#7a6a5c" text-anchor="middle">' + val + '</text>';
    axis += '<line x1="' + xOf(i).toFixed(1) + '" y1="' + T + '" x2="' + xOf(i).toFixed(1) + '" y2="' + (H - B) + '" class="sc-hgrid" stroke="#f5efe8" stroke-width="1"/>';
  }

  /* 辅助线：均分 / 中位数（虚线）+ 分数线（实线） */
  var marks = '';
  var xForValue = function(v){
    var f = v / step - first;
    return xOf(f);
  };
  var dashed = [
    { v: st.avg, label: '均分', color: '#7d7268', cls: 'sc-mk-avg' },
    { v: st.median, label: '中位数', color: '#6e635a', cls: 'sc-mk-mid' },
  ];
  dashed.forEach(function(d){
    if(d.v < first * step || d.v > (last + 1) * step) return;
    var x = xForValue(d.v);
    marks += '<line x1="' + x.toFixed(1) + '" y1="' + T + '" x2="' + x.toFixed(1) + '" y2="' + (H - B) + '" class="' + d.cls + '" stroke="' + d.color + '" stroke-width="1.2" stroke-dasharray="4 3"/>';
    marks += '<text x="' + (x + 3).toFixed(1) + '" y="' + (T + 10) + '" font-size="9" class="' + d.cls + '" fill="' + d.color + '">' + d.label + '</text>';
  });
  /* 分数线按赋分总分划：原始口径下不画三线（否则原始分被拿去和赋分线比，没意义） */
  var cuts = SC.basis === 'graded' ? (SC.exam.cutlines || []).filter(function(c){ return c.score != null; }) : [];
  cuts.forEach(function(c){
    if(c.score < first * step || c.score > (last + 1) * step) return;
    var x = xForValue(c.score);
    marks += '<line x1="' + x.toFixed(1) + '" y1="' + (T - 4) + '" x2="' + x.toFixed(1) + '" y2="' + (H - B) + '" class="sc-cut-line" stroke="' + esc(c.color || '#b45309') + '" stroke-width="1.8"/>';
    /* 贴到右边的线（如 600 分线）标签往左写，不然会被切掉 */
    var near = x > W - R - 10;
    marks += '<text x="' + (near ? x - 3 : x + 3).toFixed(1) + '" y="' + (T + 22) + '" font-size="9.5" font-weight="700" class="sc-cut-txt"'
      + ' text-anchor="' + (near ? 'end' : 'start') + '" fill="' + esc(c.color || '#b45309') + '">'
      + esc(c.label) + ' ' + c.score + '</text>';
  });

  /* 我所在的位置 */
  var meRow = scMyRow();
  var myMark = '';
  if(meRow){
    var myT = scTotal(meRow, SC.basis);
    if(myT != null && myT >= first * step && myT <= (last + 1) * step){
      var mx = xForValue(myT);
      myMark = '<circle cx="' + mx.toFixed(1) + '" cy="' + (H - B) + '" r="4" class="sc-mine-dot" fill="#c0392b"/>'
        + '<text x="' + mx.toFixed(1) + '" y="' + (H - B + 16) + '" font-size="9.5" font-weight="700" class="sc-tip" fill="#c0392b" text-anchor="middle">我 ' + myT + '</text>';
    }
  }

  return '<div class="sc-card" data-scblk="board_dist">'
    + '<div class="sc-card-h">总分分布</div>'
    + '<div class="sc-svgwrap"><svg viewBox="0 0 ' + W + ' ' + H + '" class="sc-svg">'
    +   axis + bars + marks + myMark
    +   '<line x1="' + L + '" y1="' + (H - B) + '" x2="' + (W - R) + '" y2="' + (H - B) + '" class="sc-axis" stroke="#e2d5c8" stroke-width="1.2"/>'
    + '</svg></div>'
    + '<div class="sc-figcap">每格 ' + step + ' 分；柱顶为该段人数，虚线为均分与中位数，实线为分数线，红点为你</div>'
    + '</div>';
}

/* ---------- 图表：分数线上线统计 ---------- */
function scChartCutlines(st){
  if(SC.basis !== 'graded') return '';   /* 分数线按赋分总分划，原始口径不可比 */
  var cuts = (SC.exam.cutlines || []).filter(function(c){ return c.score != null; });
  if(!cuts.length) return '';
  var rows = cuts.map(function(c){
    var up = st.list.filter(function(v){ return v >= c.score; }).length;
    var pct = st.n ? (up / st.n * 100) : 0;
    return '<div class="sc-cut-row">'
      + '<span class="sc-cut-dot" style="background:' + esc(c.color || '#b45309') + '"></span>'
      + '<span class="sc-cut-name">' + esc(c.label) + '　<b>' + c.score + '</b></span>'
      + '<span class="sc-cut-num">上线 <b>' + up + '</b> 人</span>'
      + '<span class="sc-cut-pct">' + pct.toFixed(1) + '%</span>'
      + '</div>';
  }).join('');
  return '<div class="sc-card" data-scblk="board_cut"><div class="sc-card-h">上线情况</div>' + rows + '</div>';
}

/* ---------- 图表：分数段四色横条 ---------- */
function scChartSegments(st){
  if(!st.n) return '';
  var segs = [];
  /* 原始口径下不用三线切段（线是赋分线），退回按满分比例分段 */
  var byCut = SC.basis === 'graded'
    ? (SC.exam.cutlines || []).filter(function(c){ return c.score != null; }).sort(function(a, b){ return b.score - a.score; })
    : [];
  var max = st.max;
  if(byCut.length){
    var prev = max;
    byCut.forEach(function(c, i){
      var n = st.list.filter(function(v){ return v >= c.score && v <= prev; }).length;
      segs.push({ label: c.label + ' 及以上', n: n, color: c.color || '#b45309' });
      prev = c.score - 1;
    });
    segs.push({ label: '其他', n: st.list.filter(function(v){ return v < byCut[byCut.length - 1].score; }).length, color: '#99887a' });
  } else {
    var full = scFullMark();
    /* ⚠️ v2.9.12：色板按「柱体图形 ≥3:1 + 柱内计数深字 ≥4.5」双达标重选——
       旧 #e6a97a/#e0776b/#a8968a 在白卡上只有 2.0～2.8，且亮度落在 WCAG 死区
       （0.18～0.24）时 ink-auto 两种字色都到不了 4.5。新值亮度 ≥0.2376 走深字，
       且对白卡/暗卡（无暗色覆盖的内联背景）两头都 ≥3。 */
    var bands = [
      { label: '85% 以上（优秀）', lo: full * 0.85, color: '#2f9e44' },
      { label: '70%～85%（良好）', lo: full * 0.7, color: '#4c8fd6' },
      { label: '60%～70%（及格）', lo: full * 0.6, color: '#c07a3e' },
      { label: '60% 以下', lo: 0, color: '#d4756a' },
    ];
    var hi = max + 1;
    bands.forEach(function(b){
      segs.push({ label: b.label, n: st.list.filter(function(v){ return v >= b.lo && v < hi; }).length, color: b.color });
      hi = b.lo;
    });
  }
  if(!segs.some(function(s){ return s.n > 0; })) return '';

  var bar = segs.map(function(s){
    var w = st.n ? (s.n / st.n * 100) : 0;
    if(w <= 0) return '';
    /* 字色走全站共用 ink-auto：底色亮取深字、底色暗取白字，一套逻辑 */
    return '<div class="sc-seg-bar ink-auto" data-ink-bg="' + esc(s.color) + '" style="width:' + w.toFixed(2) + '%;background:' + s.color + '" title="' + esc(s.label) + '：' + s.n + ' 人"><span>' + s.n + '</span></div>';
  }).join('');
  var legend = segs.map(function(s){
    return '<span class="sc-seg-lg"><i style="background:' + s.color + '"></i>' + esc(s.label) + ' ' + s.n + ' 人</span>';
  }).join('');

  return '<div class="sc-card" data-scblk="board_band"><div class="sc-card-h">分数段分布</div>'
    + '<div class="sc-segrow">' + bar + '</div>'
    + '<div class="sc-seglegend">' + legend + '</div></div>';
}

/* ---------- 我的画像 ---------- */
function scRenderMe(){
  var meRow = scMyRow();
  if(!meRow){
    /* v3.4.0 站主：历次上线率开放给管理员。管理员本人可能不在成绩表里
       （没有 meRow），此时个人画像的其余卡片都画不出来，
       就只给「历次上线率」这一张管理员卡。 */
    if(scIsAdmin()){
      /* v3.5.14：站主已下线画像里的「历次上线率」，这里不再兜底展示 */
      scPane('<div class="sc-hint">你是管理员，但这次考试的成绩里没有你的名字 —— 个人画像需要本人成绩才有数据。'
        + '可以切到「全班成绩单」看全班情况。</div>');
      return;
    }
    scPane('<div class="sc-empty">'
      + '<div class="sc-empty-ico">🙋</div>'
      + '<p>这次考试的成绩里没有找到你的名字。</p>'
      + '<p class="sc-dim">未找到本人成绩。如成绩已发布，请联系老师核对成绩表姓名。</p>'
      + '</div>');
    return;
  }
  var subs = SC.exam.subjects || [];
  var rk = scRankMap(SC.basis);
  var st = scStats(SC.basis);
  var myTotal = scTotal(meRow, SC.basis);
  var myRank = rk.total[meRow.id];
  var full = scFullMark();

  var html = '';

  /* ① 概览卡 */
  html += '<div class="sc-card sc-overview">'
    + '<div class="sc-ov-main">'
    +   '<div class="sc-ov-total"><b>' + (myTotal == null ? '—' : myTotal) + '</b><span>总分（' + (SC.basis === 'graded' ? '赋分' : '原始') + '）</span></div>'
    +   '<div class="sc-ov-items">'
    +     scOvItem('班排名', myRank ? myRank + ' / ' + st.n : '—')
    +     scOvItem('年级排名', meRow.schoolRank != null ? meRow.schoolRank + (SC.exam.gradeRef && SC.exam.gradeRef.students ? ' / ' + SC.exam.gradeRef.students : '') : '—', '物理方向')
    +     scOvItem('与班均', myTotal != null ? fmtDiff(myTotal - st.avg) : '—')
    +     scOvItem('联考排名', meRow.leagueRank != null ? meRow.leagueRank : '—', '年级联考')
    +   '</div>'
    + '</div>'
    + '</div>';

  /* ② 上线情况 —— 特控/本科/600 三条线都是按「赋分总分」划的，
     原始口径下总分与它们不可比（站主要求：原始分不跟三线比较），故只在赋分口径显示。 */
  var cuts = (SC.exam.cutlines || []).filter(function(c){ return c.score != null; });
  if(cuts.length && myTotal != null){
    if(SC.basis === 'graded'){
      html += '<div class="sc-card" data-scblk="me_cut"><div class="sc-card-h">上线情况</div><div class="sc-cuts">'
        + cuts.map(function(c){
            var ok = myTotal >= c.score;
            var d = Math.abs(myTotal - c.score);
            return '<div class="sc-cutmine ' + (ok ? 'ok' : 'no') + '">'
              + '<span class="sc-cut-dot" style="background:' + esc(c.color || '#b45309') + '"></span>'
              + '<b>' + esc(c.label) + '</b>'
              + '<span>' + (ok ? '已超 ' + fmtNum(d) + ' 分' : '还差 ' + fmtNum(d) + ' 分') + '</span>'
              + '</div>';
          }).join('')
        + '</div></div>';
    }else{
      html += '<div class="sc-card" data-scblk="me_cut"><div class="sc-card-h">上线情况</div>'
        + '<div class="sc-dim" style="padding:4px 2px 2px">当前是「原始分」口径。特控线 / 本科线 / 600 线都是按<b>赋分总分</b>划的，'
        + '原始分与它们不好直接比 —— 切到「总分赋分」即可看上线情况。</div></div>';
    }
  }

  /* ③ 位置条 */
  if(myRank && st.n > 1){
    var pos = (myRank - 1) / (st.n - 1);   /* 0 = 第 1 名 */
    var leftPct = pos * 100;
    html += '<div class="sc-card" data-scblk="me_pos"><div class="sc-card-h">你在班里的位置</div>'
      + '<div class="sc-pos">'
      +   '<div class="sc-pos-bar"><div class="sc-pos-me" style="left:' + leftPct.toFixed(1) + '%"><span>你</span></div></div>'
      +   '<div class="sc-pos-scale"><span>第 1 名</span><span>第 ' + st.n + ' 名</span></div>'
      + '</div>'
      + '<div class="sc-figcap">你排第 <b>' + myRank + '</b> 名，前面还有 <b>' + (myRank - 1) + '</b> 人，后面 <b>' + (st.n - myRank) + '</b> 人</div>'
      + '</div>';
  }

  /* ④ 各科卡片（分数 / 班均 / 班内排名 / 与班均差） */
  html += '<div class="sc-card" data-scblk="me_subj"><div class="sc-card-h">各科情况</div><div class="sc-subs">'
    + subs.map(function(s){
        var v = scSubScore(meRow, s, SC.basis);
        var sr = rk.subj[s.key].rank[meRow.id];
        var cnt = rk.subj[s.key].count;
        var all = [];
        SC.rows.forEach(function(r){
          var x = scSubScore(r, s, SC.basis);
          if(x != null) all.push(x);
        });
        var avg = all.length ? all.reduce(function(a, b){ return a + b; }, 0) / all.length : 0;
        var rate = (v != null && s.full) ? v / s.full : null;
        return '<div class="sc-sub">'
          + '<div class="sc-sub-top"><b>' + esc(s.name) + '</b>'
          +   (s.graded && SC.basis === 'graded' ? '<span class="sc-tag">赋分</span>' : '')
          +   '<span class="sc-sub-rk">' + (sr ? '班内第 ' + sr + ' / ' + cnt : '—') + '</span></div>'
          + '<div class="sc-sub-score">' + (v == null ? '<span class="sc-dim">未考</span>' : v + '<small>/' + s.full + '</small>') + '</div>'
          + (v == null ? '' : '<div class="sc-sub-diff ' + (v - avg >= 0 ? 'up' : 'down') + '">'
              + (v - avg >= 0 ? '高于班均 ' : '低于班均 ') + fmtNum(Math.abs(v - avg)) + ' 分</div>')
          + (rate == null ? '' : '<div class="sc-sub-bar"><i style="width:' + (rate * 100).toFixed(1) + '%"></i></div>')
          + '</div>';
      }).join('')
    + '</div></div>';

  /* ⑤ 雷达图（按得分率，否则语数英 150 分会把物化生压扁） */
  var rates = [], avgRates = [], radarTips = [], sixNums = [];
  subs.forEach(function(s){
    var v = scSubScore(meRow, s, SC.basis);
    var all = [];
    SC.rows.forEach(function(r){
      var x = scSubScore(r, s, SC.basis);
      if(x != null) all.push(x);
    });
    var avg = all.length ? all.reduce(function(a, b){ return a + b; }, 0) / all.length : 0;
    rates.push(v != null && s.full ? v / s.full : 0);
    avgRates.push(s.full ? avg / s.full : 0);
    /* 图上直接写分数（站主要求：不用去别处对） */
    radarTips.push(v == null ? '未考' : fmtNum(v) + '/' + s.full);
    sixNums.push({ name: s.name, v: v, avg: all.length ? avg : null });
  });
  if(subs.length >= 3){
    /* 六科画像：雷达（形状）+ 数值表。站主要求——既能看「个人与总分」
       的数值关系（每科占总分多少），又能看「个人与班均」的数值对比（差多少分）。 */
    var sixRowsHtml = sixNums.map(function(x){
      var share = (x.v != null && myTotal) ? (x.v / myTotal * 100) : null;
      var diff = (x.v != null && x.avg != null) ? x.v - x.avg : null;
      return '<tr><td class="k">' + esc(x.name) + '</td>'
        + '<td>' + (x.v == null ? '<span class="sc-dim">未考</span>' : fmtNum(x.v)) + '</td>'
        + '<td>' + (share == null ? '—' : share.toFixed(1) + '%') + '</td>'
        + '<td>' + (x.avg == null ? '—' : fmtNum(x.avg)) + '</td>'
        + '<td>' + (diff == null ? '—' : '<span class="sc-sub-diff ' + (diff >= 0 ? 'up' : 'down') + '">' + fmtDiff(diff) + '</span>') + '</td></tr>';
    }).join('');
    var totalDiff = (myTotal != null && st.n) ? myTotal - st.avg : null;
    var sixTable = '<table class="sc-sixtbl"><thead><tr><th>科目</th><th>我的</th><th>占总分</th><th>班均</th><th>与班均</th></tr></thead>'
      + '<tbody>' + sixRowsHtml + '</tbody>'
      + '<tfoot><tr><td class="k">总分</td>'
      +   '<td>' + (myTotal == null ? '—' : fmtNum(myTotal)) + '</td><td>100%</td>'
      +   '<td>' + (st.n ? fmtNum(st.avg) : '—') + '</td>'
      +   '<td>' + (totalDiff == null ? '—' : '<span class="sc-sub-diff ' + (totalDiff >= 0 ? 'up' : 'down') + '">' + fmtDiff(totalDiff) + '</span>') + '</td>'
      + '</tr></tfoot></table>';
    html += '<div class="sc-card" data-scblk="me_subj"><div class="sc-card-h">六科画像（按得分率）</div>'
      + scRadar(subs.map(function(s){ return s.name; }), rates, avgRates, radarTips)
      + '<div class="sc-figcap">实线为本人，虚线为班均；各顶点标注学科分数。按得分率绘制，图形越向外越强。</div>'
      + sixTable
      + '<div class="sc-figcap">「占总分」＝ 该科得分 ÷ 我的总分；「与班均」＝ 我的分数 − 全班该科平均分。</div>'
      + '</div>';
  }

  /* ⑤b AI 分析（v3.5.6）—— 本地规则引擎，不联网、不调模型，隐私不出班 */
  html += scMeAnalysis(meRow, rk, st, myTotal, myRank, subs);

  /* ⑥ 趋势与进退步（用历次数据） */
  html += scTrendBlock(meRow);

  /* ⑦ 各科趋势网格（每科一张小卡 + 迷你折线） */
  html += scSubjTrend();
  /* ⑦b 各科进退步（近几次分数 + 年级排名逐次对比） */
  html += scSubjectProgress();

  /* ⑧ 年级进退步（靠校排名，和班排名分开看） */
  html += scGradeTrend();

  /* ⑨ 跨考试上线率 —— v3.5.14 站主要求「我的画像的历史上线率不要了」，已下线。
     （函数 scCutTrend 保留：管理员没有本人成绩时的兜底卡片还在用） */

  scPane(html);
}

/* ----------------------------------------------------------------------------
 * 我的画像 · AI 分析（v3.5.6）
 * 站主要求：「我的画像 AI 分析」。
 *
 * 设计取舍（为什么是本地规则而不是调大模型）：
 *   · 成绩是全班真实姓名 + 分数，站点跑在人家自己的 Cloudflare 免费额度上，
 *     没有 API Key，也不该把学生成绩往外发 —— 所以全部在浏览器里算。
 *   · 「AI」体现在**把多个维度的数字翻译成人能读的话**：定位（班排/位置）、
 *     均衡度（偏科）、单科强弱（超/低于班均）、稳定性（历次波动）、
 *     趋势（最近一次是升是降）、上线距离。每一条都带具体数字，不说空话。
 *   · 输出固定 5 段：一句话结论 / 亮点 / 短板 / 趋势 / 下一步建议（2～3 条）。
 *   规则引擎的好处是可解释、可复现 —— 换一次考试重算，结论跟着变，
 *   不会像模型那样偶发出幻觉。
 * -------------------------------------------------------------------------- */
function scMeAnalysis(meRow, rk, st, myTotal, myRank, subs){
  if(myTotal == null || !st.n) return '';

  var full = scFullMark();
  var rates = [];          /* 每科得分率 */
  subs.forEach(function(s){
    var v = scSubScore(meRow, s, SC.basis);
    var avg = scSubjAvg()[s.key];
    rates.push({
      key: s.key, name: s.name, v: v, avg: avg, full: s.full || 0,
      rate: (v != null && s.full) ? v / s.full : null,
      avgRate: (avg != null && s.full) ? avg / s.full : null,
      d: (v != null && avg != null) ? v - avg : null,
    });
  });
  var valid = rates.filter(function(x){ return x.rate != null; });
  if(!valid.length) return '';

  /* ---- ① 定位 ---- */
  var posPct = st.n > 1 ? (myRank - 1) / (st.n - 1) : 0;
  var tier = posPct <= 0.1 ? '头部队列' : posPct <= 0.3 ? '中上梯队' : posPct <= 0.6 ? '中游偏上' : posPct <= 0.85 ? '中下游' : '后段';
  var concl = '这次你在班里第 <b>' + myRank + ' / ' + st.n + '</b>，属于<b>' + tier + '</b>；'
    + '总分 <b>' + fmtNum(myTotal) + '</b>，比班均 <b>' + fmtDiff(myTotal - st.avg) + '</b>。';

  /* ---- ② 亮点：得分率最高的两科 ---- */
  var byRate = valid.slice().sort(function(a, b){ return b.rate - a.rate; });
  var strong = byRate.slice(0, Math.min(2, byRate.length)).filter(function(x){ return x.d != null && x.d > 0; });
  var goodText = strong.length
    ? '相对班均领先的是 ' + strong.map(function(x){
        return '<b>' + esc(x.name) + '</b>（' + fmtNum(x.v) + '，超班均 ' + fmtNum(x.d) + ' 分）';
      }).join(' 和 ') + ' —— 这几科是你的基本盘，稳住就行，不用再压时间。'
    : '这次没有明显超过班均的科目 —— 说明整体还在追赶阶段，别急着挑科大补，先把最拖后腿那科拉到班均附近最划算。';

  /* ---- ③ 短板：得分率最低的两科 ---- */
  var weak = byRate.slice(-Math.min(2, byRate.length)).reverse().filter(function(x){ return x.d != null && x.d < 0; });
  var weakText = weak.length
    ? '需要盯的是 ' + weak.map(function(x){
        return '<b>' + esc(x.name) + '</b>（' + fmtNum(x.v) + '，落后班均 ' + fmtNum(Math.abs(x.d)) + ' 分）';
      }).join(' 和 ') + '。'
    : '没有低于班均的科目 —— 这次各科都在平均线上，属于少见的齐整状态。';

  /* ---- ④ 均衡度：最强与最弱的得分率差 ---- */
  var spread = (byRate.length >= 2) ? (byRate[0].rate - byRate[byRate.length - 1].rate) : 0;
  var balanceText;
  if(byRate.length < 2) balanceText = '';
  else if(spread >= 0.25) balanceText = '偏科明显：最强 <b>' + esc(byRate[0].name) + '</b> 与最弱 <b>'
    + esc(byRate[byRate.length - 1].name) + '</b> 的得分率差 <b>' + (spread * 100).toFixed(0)
    + '</b> 个百分点。短板科目的提分空间远大于继续给强科加码。';
  else if(spread >= 0.12) balanceText = '有一定偏科：最强与最弱相差 <b>' + (spread * 100).toFixed(0)
    + '</b> 个百分点，属于常见范围，把弱科往上提 5～10 分就能明显拉动总分。';
  else balanceText = '各科比较均衡（最强与最弱只差 <b>' + (spread * 100).toFixed(0)
    + '</b> 个百分点）—— 总分要再上一个台阶，靠的是整体效率，而不是补某一科。';

  /* ---- ⑤ 趋势：用历次总分 ---- */
  var series = scMeSeries();
  var trendText = '';
  if(series.length >= 2){
    var last = series[series.length - 1], prev = series[series.length - 2];
    var dv = last.v - prev.v;
    var ups = 0, downs = 0;
    for(var i = 1; i < series.length; i++){
      if(series[i].v > series[i - 1].v) ups++;
      else if(series[i].v < series[i - 1].v) downs++;
    }
    var volatile = (ups > 0 && downs > 0 && series.length >= 3);
    trendText = '历次 ' + series.length + ' 次考试：最近一次相比上一次 <b>' + fmtDiff(dv) + '</b> 分，'
      + '整体' + (ups > downs ? '<b>向上</b>' : ups < downs ? '<b>向下</b>' : '<b>持平震荡</b>')
      + '（升 ' + ups + ' 次 / 降 ' + downs + ' 次）。'
      + (volatile ? '成绩上下波动比较明显 —— 稳定性本身就是分数，先把会做的题稳住。'
        : ups > downs ? '节奏是往上走的，保持现在的做法别乱改。'
        : downs > ups ? '连续在往下掉，先找原因（时间分配？某科方法不对？状态？），别靠加时间硬扛。'
        : '基本站住了，想突破需要换方法而不是加时长。');
  }

  /* ---- ⑥ 上线距离 ---- */
  var cuts = (SC.exam.cutlines || []).filter(function(c){ return c.score != null; });
  var cutText = '';
  if(cuts.length && SC.basis === 'graded'){
    var nearest = null;
    cuts.forEach(function(c){
      var d = c.score - myTotal;
      if(!nearest || Math.abs(d) < Math.abs(nearest.d)) nearest = { label: c.label, d: d, score: c.score };
    });
    if(nearest){
      cutText = nearest.d > 0
        ? '离最近的 <b>' + esc(nearest.label) + '</b>（' + fmtNum(nearest.score) + '）还差 <b>' + fmtNum(nearest.d) + '</b> 分。'
        : '已经过了 <b>' + esc(nearest.label) + '</b>（' + fmtNum(nearest.score) + '），超出 <b>' + fmtNum(-nearest.d) + '</b> 分。';
    }
  }

  /* ---- ⑦ 下一步建议：按短板/偏科/趋势组合出 2～3 条，都带具体动作 ---- */
  var todos = [];
  if(weak.length){
    var w0 = weak[0];
    /* 单科差多少分才到班均 → 折算成「多少道选择/多少分的小题」更好执行 */
    todos.push('先把 <b>' + esc(w0.name) + '</b> 拉到班均：现在还差 <b>' + fmtNum(Math.abs(w0.d))
      + '</b> 分。做法别贪多 —— 只补这一科最近两次考试的错题，按错因分类（不会／算错／看错），'
      + '不会的才需要重新学，其余靠限时重做。');
  }
  if(spread >= 0.25 && byRate.length >= 2){
    todos.push('强科 <b>' + esc(byRate[0].name) + '</b> 已经超过班均，短期内不要再给它追加时间 —— '
      + '把那部分时间整体挪给弱科，总分的边际收益高得多。');
  }
  if(series.length >= 2){
    var lastD = series[series.length - 1].v - series[series.length - 2].v;
    if(lastD < 0) todos.push('上一次是退的（<b>' + fmtDiff(lastD) + '</b> 分）。这周先做一件事：把上次的卷子按「会但做错」和「确实不会」分两堆，前者才是最快能捞回来的分。');
  }
  if(!todos.length){
    todos.push('目前没有明显短板。下一步不是补差，而是把 <b>' + esc(byRate[0] ? byRate[0].name : '强科')
      + '</b> 的稳定性做起来 —— 用限时套卷训练，目标是把「应该拿到的分」全拿到。');
  }
  /* 只留 3 条，多了没人看 */
  todos = todos.slice(0, 3);

  var rowHtml = function(k, v){
    return v ? '<div class="sc-ai-row"><span class="sc-ai-k">' + k + '</span><span class="sc-ai-v">' + v + '</span></div>' : '';
  };

  return '<div class="sc-card sc-ai-card" data-scblk="me_ai">'
    + '<div class="sc-card-h">AI 分析<span class="sc-h-note">本地规则生成 · 不联网 · 不上传成绩</span></div>'
    + '<div class="sc-ai-concl">' + concl + '</div>'
    + rowHtml('亮点', goodText)
    + rowHtml('短板', weakText)
    + rowHtml('均衡', balanceText)
    + rowHtml('趋势', trendText)
    + rowHtml('上线', cutText)
    + '<div class="sc-ai-todo"><b>下一步可以这样做</b><ol>'
    +   todos.map(function(t){ return '<li>' + t + '</li>'; }).join('')
    + '</ol></div>'
    + '<div class="sc-figcap">这份分析由浏览器按当前考试数据实时算出（定位 / 单科强弱 / 均衡度 / 历次趋势 / 上线距离五类规则），'
    + '每次换考试、切换赋分口径都会重算，不会把成绩发到任何服务器。</div>'
    + '</div>';
}

/* ----------------------------------------------------------------------------
 * 成绩对比 PK（第六十轮 · v2.10.0）
 * 站主要求（成绩分析下方）：从本班考生记录里任选两人 + 同一场考试，
 * 看总分/各科柱状图、强弱项对比、各科分差标注。
 * 实现要点：
 *   · 数据全部来自当前考试的 SC.rows（board 接口已返回全场各科分），
 *     前端实时算，不新增后端接口 —— 站主改分后刷新即自洽。
 *   · 与「我的画像」共用口径：SC.basis（总分赋分/原始）跟着全局切换。
 *   · 「同一场考试」= scBar 里当前选中的考试；换考试自动重置双方选择。
 * -------------------------------------------------------------------------- */

/* 双方默认选择：A 优先「我」，B 选总分第一；都不满足就取前两行。 */
function scPkDefaults(){
  var me = scMyRow();
  var best = null, bestT = null;
  SC.rows.forEach(function(r){
    var t = scTotal(r, SC.basis);
    if(t == null) return;
    if(bestT == null || t > bestT){ bestT = t; best = r; }
  });
  var first = SC.rows[0] || null;
  SC.pkA = me ? me.id : (first ? first.id : null);
  if(best && best.id !== SC.pkA) SC.pkB = best.id;
  else if(first && first.id !== SC.pkA) SC.pkB = first.id;
  else SC.pkB = SC.rows[1] ? SC.rows[1].id : null;
}
function scPkRow(id){
  for(var i = 0; i < SC.rows.length; i++) if(SC.rows[i].id === id) return SC.rows[i];
  return null;
}
/* 各科班均（按当前口径；缺考不计入）—— 强弱项用「超班均」衡量，
   这样满分不同的科目之间也可比（150 的语文超 10 分和 100 的数学超 10 分
   在这里是一回事：都是甩开班里平均水平 10 分）。 */
function scPkSubjAvg(){
  var subs = SC.exam.subjects || [];
  var out = {};
  subs.forEach(function(s){
    var sum = 0, n = 0;
    SC.rows.forEach(function(r){
      var v = scSubScore(r, s, SC.basis);
      if(v == null) return;
      sum += v; n++;
    });
    out[s.key] = n ? sum / n : null;
  });
  return out;
}
function scPkPick(side, id){
  if(side === 'a') SC.pkA = id; else SC.pkB = id;
  scRenderPane();
}
function scPkSwap(){
  var t = SC.pkA; SC.pkA = SC.pkB; SC.pkB = t;
  scRenderPane();
}

/* v3.4.0 站主：「成绩对比可以多场考试放在一起对比（单次最多2场）」。
   选第二场考试后，懒加载那场考试的全班 board（缓存在 SC.allRows，
   与历次上线率共用），再由 scPkTrendCard 出两位同学的跨考试进退步。 */
function scPkExam2(v){
  var id = v ? Number(v) : null;
  /* 幂等守卫：只在选了考试时生效 —— 若对 null 也短路，
     从「有对比」切回「不对比」就不会重渲染（卡片残留在页面上） */
  if(id != null && SC.pkExam2 === id) return;
  SC.pkExam2 = id;
  if(id != null && !(SC.allRows && SC.allRows[id])){
    SC.allRows = SC.allRows || {};
    api('/scores?action=board&exam=' + id).then(function(d){
      SC.allRows[id] = { exam: d.exam, rows: d.rows || [] };
      if(SC.tab === 'pk' && SC.pkExam2 === id) scRenderPane();
    }).catch(function(){ /* 拉不到就保持无数据，卡里会显示「读取失败」 */ });
  }
  scRenderPane();
}

function scRenderPk(){
  /* 换过考试 / 首次进入：选择失效就按默认规则重选 */
  if(SC.pkA == null || SC.pkB == null || !scPkRow(SC.pkA) || !scPkRow(SC.pkB)) scPkDefaults();
  if(SC.rows.length < 2 || !scPkRow(SC.pkA) || !scPkRow(SC.pkB)){
    scPane('<div class="sc-empty">'
      + '<div class="sc-empty-ico">⚔️</div>'
      + '<p><b>人还不够</b></p>'
      + '<p class="sc-dim">成绩对比需要至少两名同学的成绩，等老师录入更多人之后再来。</p>'
      + '</div>');
    return;
  }
  var A = scPkRow(SC.pkA), B = scPkRow(SC.pkB);
  var opts = SC.rows.map(function(r){
    return '<option value="' + r.id + '">' + esc(r.name || ('#' + r.id)) + '</option>';
  }).join('');
  var html = '<div class="sc-pk">'
    /* ① 选人区 */
    + '<div class="sc-pk-pick">'
    +   '<div class="sc-pk-side"><label>A 方（橙）</label>'
    +     '<select class="sc-sel" onchange="scPkPick(\'a\', Number(this.value))">'
    +       opts.replace('value="' + A.id + '"', 'value="' + A.id + '" selected') + '</select></div>'
    +   '<div class="sc-pk-side"><label>B 方（蓝）</label>'
    +     '<select class="sc-sel" onchange="scPkPick(\'b\', Number(this.value))">'
    +       opts.replace('value="' + B.id + '"', 'value="' + B.id + '" selected') + '</select></div>'
    + '</div>'
    + '<div class="sc-pk-legend">'
    +   '<span><i class="sc-pk-dot-a"></i>' + esc(A.name || 'A 方') + '</span>'
    +   '<span><i class="sc-pk-dot-b"></i>' + esc(B.name || 'B 方') + '</span>'
    +   '<span class="sc-dim">同一场考试：' + esc(SC.exam.name || '') + '</span>'
    + '</div>'
    /* v3.4.0：跨考试对比（最多再选 1 场，即最多 2 场同屏） */
    + '<div class="sc-pk-legend" style="margin-top:-2px">'
    +   '<label class="sc-dim" style="font-size:.76rem">对比另一场：</label>'
    +   '<select class="sc-sel" style="max-width:220px" onchange="scPkExam2(this.value)">'
    +     '<option value="">不对比（只看本场）</option>'
    +     SC.exams.map(function(e){
            return '<option value="' + e.id + '"' + (SC.pkExam2 === e.id ? ' selected' : '') + '>'
              + esc(e.name) + '　' + esc(scDateRange(e)) + '</option>';
          }).join('')
    +   '</select>'
    + '</div>'
    /* ② 总分柱状图 */
    + scPkTotalCard(A, B)
    /* ②b v3.5.12（#8）：选中第二场时，两场总分同屏 + 赋分前后对比 */
    + scPkBothTotalCard(A, B)
    /* ③ 各科分组柱状图 —— v3.5.13（#8）：选了两场时各科对比意义不大，隐藏 */
    + (SC.pkExam2 == null ? scPkSubjCard(A, B) : '')
    /* ③b 跨考试进退步与趋势（v3.4.0，选了第二场才出现） */
    + scPkTrendCard(A, B)
    /* ④ 强弱项对比卡 */
    + scPkCards(A, B)
    /* ⑤ v3.5.13（#8）：AI 对比分析，单场/两场都有 */
    + scPkAiCard(A, B)
    + '</div>';
  scPane(html);
}

/* ② 总分对比：两根大柱 + 班均参考线 + 分差结论 */
function scPkTotalCard(A, B){
  var ta = scTotal(A, SC.basis), tb = scTotal(B, SC.basis);
  var st = scStats(SC.basis);
  var rk = scRankMap(SC.basis);
  var W = 640, H = 210, L = 40, R = 20, T = 26, Bp = 60;
  var full = scFullMark();
  var maxV = Math.max(ta == null ? 0 : ta, tb == null ? 0 : 1);

  /* v3.5.13（#8 站主「两次考试都要画上去」）：选了第二场且数据在手时，
     每人画两根柱 —— 淡柱=上一场，实柱=这一场。 */
  var pack = (SC.pkExam2 != null) ? ((SC.allRows || {})[SC.pkExam2] || null) : null;
  function prevTot(row){
    if(!pack || !row) return null;
    var t = 0, any = false;
    ((pack.exam && pack.exam.subjects) || []).forEach(function(s){
      var v = row.s && row.s[s.key];
      if(!v) return;
      var val = (SC.basis === 'graded' && s.graded && v.assigned != null) ? v.assigned : v.raw;
      if(val == null) return;
      t += val; any = true;
    });
    return any ? t : null;
  }
  var pa = prevTot(A), pb = prevTot(B);
  var hasPrevBars = pack && (pa != null || pb != null);

  maxV = Math.max(maxV, pa == null ? 0 : pa, pb == null ? 0 : pb);
  /* 纵轴封顶取「满分」与「两人较高者」的较大值，柱子不会被压扁 */
  var top = Math.max(full, maxV) * 1.04;
  var yOf = function(v){ return T + (H - T - Bp) * (1 - v / top); };
  var bw = hasPrevBars ? 68 : 96, gap = hasPrevBars ? 168 : 150;
  var pbw = 40, pgap = 6;
  var xa = W / 2 - gap / 2 - bw, xb = W / 2 + gap / 2;
  var xpa = xa - pgap - pbw, xpb = xb - pgap - pbw;
  var svg = '<svg class="sc-svg" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">';
  /* 网格 + 纵轴刻度（按满分比例取 4 档） */
  for(var g = 0; g <= 4; g++){
    var gv = top * g / 4;
    var gy = yOf(gv);
    svg += '<line x1="' + L + '" y1="' + gy.toFixed(1) + '" x2="' + (W - R) + '" y2="' + gy.toFixed(1)
      + '" class="sc-pk-grid" stroke-width="1"/>'
      + '<text x="' + (L - 6) + '" y="' + (gy + 3).toFixed(1) + '" font-size="9" class="sc-pk-sub" text-anchor="end">'
      + Math.round(gv) + '</text>';
  }
  /* 班均参考线（虚线）—— 两人站在班里是什么水平，一眼的事 */
  if(st.avg > 0 && st.avg <= top){
    var ay = yOf(st.avg);
    svg += '<line x1="' + L + '" y1="' + ay.toFixed(1) + '" x2="' + (W - R) + '" y2="' + ay.toFixed(1)
      + '" class="sc-pk-avg" stroke-width="1.2" stroke-dasharray="5 4"/>'
      + '<text x="' + (W - R) + '" y="' + (ay - 4).toFixed(1) + '" font-size="9" class="sc-pk-avg" text-anchor="end">班均 '
      + fmtNum(st.avg) + '</text>';
  }
  function bar(x, v, barCls, numCls, row){
    if(v == null) return '<text x="' + (x + bw / 2) + '" y="' + (H - Bp - 6) + '" font-size="10" class="sc-pk-sub" text-anchor="middle">缺考</text>';
    var y = yOf(v), h = H - Bp - y;
    return '<rect x="' + x + '" y="' + y.toFixed(1) + '" width="' + bw + '" height="' + Math.max(1, h).toFixed(1)
      + '" class="sc-pk-bar-' + barCls + '" rx="4"/>'
      + '<text x="' + (x + bw / 2) + '" y="' + (y - 7).toFixed(1) + '" font-size="15" font-weight="800" class="sc-pk-num-' + numCls
      + '" text-anchor="middle">' + v + '</text>'
      + '<text x="' + (x + bw / 2) + '" y="' + (H - Bp + 16) + '" font-size="11" font-weight="700" class="sc-pk-name" text-anchor="middle">'
      + esc(row.name || '') + '</text>'
      + '<text x="' + (x + bw / 2) + '" y="' + (H - Bp + 32) + '" font-size="9.5" class="sc-pk-sub" text-anchor="middle">班排 '
      + (rk.total[row.id] || '—') + ' / ' + st.n + '</text>'
      + (row.schoolRank != null
          ? '<text x="' + (x + bw / 2) + '" y="' + (H - Bp + 46) + '" font-size="9.5" class="sc-pk-sub" text-anchor="middle">年级第 '
            + row.schoolRank + '（物理方向）</text>'
          : '');
  }
  /* v3.5.13：先画上一场淡柱（在主柱左侧），再画主柱 —— 两场考试同屏 */
  function prevBar(x, v, cls){
    if(!hasPrevBars || v == null) return '';
    var y = yOf(v), h = H - Bp - y;
    return '<rect x="' + x + '" y="' + y.toFixed(1) + '" width="' + pbw + '" height="' + Math.max(1, h).toFixed(1)
      + '" class="sc-pk-bar-' + cls + '-prev" rx="4"/>'
      + '<text x="' + (x + pbw / 2) + '" y="' + (y - 6).toFixed(1) + '" font-size="10" font-weight="700" class="sc-pk-sub" text-anchor="middle">' + v + '</text>';
  }
  svg += prevBar(xpa, pa, 'a') + prevBar(xpb, pb, 'b');
  svg += bar(xa, ta, 'a', 'a', A) + bar(xb, tb, 'b', 'b', B);
  /* 中间结论徽章：谁领先多少 */
  var verdict = '';
  if(ta != null && tb != null){
    var d = ta - tb;
    var cls = d > 0 ? 'sc-pk-diff-up' : (d < 0 ? 'sc-pk-diff-down' : 'sc-pk-diff-eq');
    var txt = d === 0 ? '总分持平' : (d > 0 ? 'A 领先 ' + fmtNum(Math.abs(d)) + ' 分' : 'B 领先 ' + fmtNum(Math.abs(d)) + ' 分');
    verdict = '<text x="' + (W / 2) + '" y="' + (T + 4) + '" font-size="12" font-weight="800" class="' + cls
      + '" text-anchor="middle">' + txt + '</text>';
  }
  svg += verdict + '</svg>';
  return '<div class="sc-card" data-scblk="pk_total">'
    + '<div class="sc-card-h">总分对比（' + (SC.basis === 'graded' ? '赋分' : '原始') + '，满分 ' + full + '）'
    + (hasPrevBars
        ? '<span class="sc-h-note">淡柱 = 上一场「' + esc(shortName((pack.exam || {}).name || '')) + '」 · 实柱 = 这一场</span>'
        : '')
    + '</div>'
    + '<div class="sc-svgwrap">' + svg + '</div>'
    + '</div>';
}

/* ②b v3.5.12（#8 站主反复要求的那一条）
   「如果选择了两场考试，那两场考试的总分都要显示出来，还有赋分前与赋分后的对比」
   → 选了两场时，这里用一张表把「上一场 / 这一场」的原始分、赋分、班排、年级排名
     并排摆出来，两个人各一行。不选第二场就不出这张卡，省得占地方。 */
function scPkBothTotalCard(A, B){
  if(SC.pkExam2 == null) return '';
  var pack = (SC.allRows || {})[SC.pkExam2];
  if(!pack) return '';
  var prevExam = pack.exam, prows = pack.rows || [];
  var curExam = SC.exam;

  function findRow(r){
    var hit = null;
    if(r && r.uid) prows.forEach(function(x){ if(!hit && x.uid && String(x.uid) === String(r.uid)) hit = x; });
    if(!hit && r) prows.forEach(function(x){ if(!hit && x.name === r.name) hit = x; });
    return hit;
  }
  /* 总分：raw = 原始分口径（赋分科取 raw），graded = 赋分口径（赋分科取 assigned） */
  function tot(row, exam, mode){
    var t = 0, any = false;
    ((exam && exam.subjects) || []).forEach(function(s){
      var v = row && row.s && row.s[s.key];
      if(!v) return;
      var val;
      if(mode === 'graded') val = (s.graded && v.assigned != null) ? v.assigned : v.raw;
      else val = v.raw;
      if(val == null) return;
      t += val; any = true;
    });
    return any ? t : null;
  }
  function rankOf(rows, exam, mode, target){
    if(!target) return null;
    var list = [];
    rows.forEach(function(r){
      var t = tot(r, exam, mode);
      if(t != null) list.push({ id: r.id, t: t });
    });
    list.sort(function(a, b){ return b.t - a.t; });
    var rk = {}, lastT = null, lastRank = 0;
    list.forEach(function(o, i){
      if(o.t !== lastT){ lastRank = i + 1; lastT = o.t; }
      rk[o.id] = lastRank;
    });
    return rk[target.id] || null;
  }

  var pA = findRow(A), pB = findRow(B);
  var curRows = SC.rows || [];

  var rows = [{ who: A, label: A.name || 'A 方', dot: 'a', prev: pA },
              { who: B, label: B.name || 'B 方', dot: 'b', prev: pB }];

  function cellHtml(v, sub){
    if(v == null) return '<td class="sc-dim">—</td>';
    return '<td><b>' + fmtNum(v) + '</b>'
      + (sub ? '<span style="display:block;font-size:.66rem">' + sub + '</span>' : '') + '</td>';
  }
  function deltaHtml(prev, cur, isRank){
    if(prev == null || cur == null) return '';
    var d = cur - prev;
    if(d === 0) return '<span class="sc-dim">持平</span>';
    var good = isRank ? d < 0 : d > 0;
    return '<span class="sc-sub-diff ' + (good ? 'up' : 'down') + '">'
      + (good ? '↑ ' : '↓ ') + fmtNum(Math.abs(d)) + '</span>';
  }

  var body = rows.map(function(r){
    var pp = r.prev;
    var prevRaw = pp ? tot(pp, prevExam, 'raw') : null;
    var prevGrd = pp ? tot(pp, prevExam, 'graded') : null;
    var curRaw  = tot(r.who, curExam, 'raw');
    var curGrd  = tot(r.who, curExam, 'graded');
    var prevRkRaw = rankOf(prows, prevExam, 'raw', pp);
    var prevRkGrd = rankOf(prows, prevExam, 'graded', pp);
    var curRkRaw  = rankOf(curRows, curExam, 'raw', r.who);
    var curRkGrd  = rankOf(curRows, curExam, 'graded', r.who);
    /* 本次考试有没有赋分科 —— 没有的话两列数值一样，下面会提示 */
    var hasGraded = (curExam.subjects || []).some(function(s){ return s.graded; })
                 || (prevExam.subjects || []).some(function(s){ return s.graded; });

    return '<tr>'
      + '<td class="sc-name"><i class="sc-pk-dot-' + r.dot + '" style="display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px"></i>'
      + esc(r.label) + '</td>'
      /* 上一场 */
      + cellHtml(prevRaw, prevGrd != null && hasGraded ? '赋分 ' + fmtNum(prevGrd) : '')
      + cellHtml(prevRkRaw, hasGraded ? '赋分班排 ' + (prevRkGrd == null ? '—' : prevRkGrd) : '')
      /* 这一场 */
      + cellHtml(curRaw, curGrd != null && hasGraded ? '赋分 ' + fmtNum(curGrd) : '')
      + cellHtml(curRkRaw, hasGraded ? '赋分班排 ' + (curRkGrd == null ? '—' : curRkGrd) : '')
      /* 变化 */
      + '<td>' + (deltaHtml(prevRaw, curRaw, false) || '<span class="sc-dim">—</span>')
      +   '<span style="display:block;font-size:.66rem">'
      +     (hasGraded ? '赋分 ' + (deltaHtml(prevGrd, curGrd, false) || '<span class="sc-dim">—</span>') : '')
      +   '</span></td>'
      + '<td>' + (deltaHtml(prevRkRaw, curRkRaw, true) || '<span class="sc-dim">—</span>') + '</td>'
      + '</tr>';
  }).join('');

  /* 差距行：两场各自的总分差，说明「拉开了还是缩小了」 */
  var gapRow = '';
  if(pA && pB){
    var pr = tot(pA, prevExam, 'raw'), pb = tot(pB, prevExam, 'raw');
    var cr = tot(A, curExam, 'raw'), cb = tot(B, curExam, 'raw');
    if(pr != null && pb != null && cr != null && cb != null){
      var pg = pr - pb, cg = cr - cb;
      var wider = Math.abs(cg) > Math.abs(pg);
      gapRow = '<div class="sc-figcap" style="margin-top:2px">'
        + '两人总分差：上一场 <b>' + fmtNum(Math.abs(pg)) + '</b> 分 → 这一场 <b>' + fmtNum(Math.abs(cg)) + '</b> 分，'
        + (Math.abs(cg) === Math.abs(pg) ? '没变'
            : (wider ? '拉开了 ' : '缩小了 ') + fmtNum(Math.abs(Math.abs(cg) - Math.abs(pg))) + ' 分')
        + '，现在 ' + esc(cg > 0 ? (A.name || 'A 方') : (cg < 0 ? (B.name || 'B 方') : '两人')) 
        + (cg === 0 ? ' 并列' : ' 领先') + '。</div>';
    }
  }

  var hasGradedCur = (curExam.subjects || []).some(function(s){ return s.graded; });

  return '<div class="sc-card" data-scblk="pk_both">'
    + '<div class="sc-card-h">两场总分并列（' + esc(shortName(prevExam.name || '')) + ' → ' + esc(shortName(curExam.name || '')) + '）'
    +   '<span class="sc-h-note">上一场 · 这一场 · 赋分前后都在这一张表里</span></div>'
    + '<div class="sc-tblwrap" style="max-height:none"><table class="sc-tbl" style="min-width:auto">'
    + '<thead><tr>'
    +   '<th rowspan="2">同学</th>'
    +   '<th colspan="2" style="text-align:center">上一场（' + esc(shortName(prevExam.name || '')) + '）</th>'
    +   '<th colspan="2" style="text-align:center">这一场（' + esc(shortName(curExam.name || '')) + '）</th>'
    +   '<th colspan="2" style="text-align:center">变化</th>'
    + '</tr><tr>'
    +   '<th>总分</th><th>班排</th><th>总分</th><th>班排</th>'
    +   '<th>总分</th><th>班排</th>'
    + '</tr></thead><tbody>' + body + '</tbody></table></div>'
    + gapRow
    + '<div class="sc-figcap">'
    +   '「总分」列显示<b>原始分</b>，括号小字是<b>赋分后的总分</b>（只有含赋分科的考试才有意义）；'
    +   '班排同理：大字按原始分排，小字按赋分排。'
    +   (hasGradedCur ? '' : '这场考试没有赋分科目，所以原始分与赋分相同。')
    + '</div></div>';
}

/* ③ 各科分组柱状图：每科两根柱（A 橙 / B 蓝），柱顶标分，组顶标分差 */
function scPkSubjCard(A, B){
  var subs = SC.exam.subjects || [];
  if(!subs.length) return '';
  var W = 640, groupH = 118, T = 22, Bp = 30;
  var H = T + groupH * subs.length + Bp;
  var L = 44, R = 12;
  var gw = (W - L - R) / subs.length;
  var svg = '<svg class="sc-svg" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">';
  subs.forEach(function(s, i){
    var va = scSubScore(A, s, SC.basis), vb = scSubScore(B, s, SC.basis);
    var gx = L + i * gw;
    var cx = gx + gw / 2;
    /* 组内两柱：按本科满分归一（150 与 100 的科目柱高才可比） */
    var full = s.full || 100;
    var top = full * 1.06;
    var yOf = function(v){ return T + (groupH - 8) * (1 - v / top); };
    /* 组底基线 */
    var base = T + groupH - 8;
    svg += '<line x1="' + gx.toFixed(1) + '" y1="' + base + '" x2="' + (gx + gw).toFixed(1) + '" y2="' + base
      + '" class="sc-pk-grid" stroke-width="1"/>';
    /* 25% / 50% / 75% 淡网格 */
    for(var q = 1; q <= 3; q++){
      var qy = yOf(full * q / 4);
      svg += '<line x1="' + gx.toFixed(1) + '" y1="' + qy.toFixed(1) + '" x2="' + (gx + gw).toFixed(1) + '" y2="' + qy.toFixed(1)
        + '" class="sc-pk-grid" stroke-width="1" opacity=".6"/>';
    }
    var bw = Math.min(26, gw * 0.3);
    var xa = cx - bw - 3, xb = cx + 3;
    function one(x, v, barCls, numCls){
      if(v == null) return '<text x="' + (x + bw / 2) + '" y="' + (base - 5) + '" font-size="9" class="sc-pk-sub" text-anchor="middle">缺</text>';
      var y = yOf(v), h = base - y;
      return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw + '" height="' + Math.max(1, h).toFixed(1)
        + '" class="sc-pk-bar-' + barCls + '" rx="3"/>'
        + '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (y - 4).toFixed(1) + '" font-size="10.5" font-weight="800" class="sc-pk-num-' + numCls
        + '" text-anchor="middle">' + fmtNum(v) + '</text>';
    }
    svg += one(xa, va, 'a', 'a') + one(xb, vb, 'b', 'b');
    /* 组顶分差标注：A − B（跟随成绩分析口径：领先绿、落后红） */
    if(va != null && vb != null){
      var d = va - vb;
      var cls = d > 0 ? 'sc-pk-diff-up' : (d < 0 ? 'sc-pk-diff-down' : 'sc-pk-diff-eq');
      var dtxt = d === 0 ? '±0' : (d > 0 ? '+' + fmtNum(d) : '−' + fmtNum(Math.abs(d)));
      svg += '<text x="' + cx.toFixed(1) + '" y="' + (T - 7) + '" font-size="11" font-weight="800" class="' + cls
        + '" text-anchor="middle">' + dtxt + '</text>';
    }
    /* 组底：科名 + 满分 */
    svg += '<text x="' + cx.toFixed(1) + '" y="' + (base + 15) + '" font-size="10.5" font-weight="700" class="sc-pk-name" text-anchor="middle">'
      + esc(s.name || s.key) + '</text>'
      + '<text x="' + cx.toFixed(1) + '" y="' + (base + 27) + '" font-size="8.5" class="sc-pk-sub" text-anchor="middle">满分 '
      + full + '</text>';
  });
  svg += '</svg>';
  return '<div class="sc-card" data-scblk="pk_subj">'
    + '<div class="sc-card-h">各科对比（柱顶为得分，组顶为 A−B 分差；柱高按本科满分归一）</div>'
    + '<div class="sc-svgwrap">' + svg + '</div>'
    + '</div>';
}

/* ④ 强弱项对比：以「超班均」衡量（各科满分不同，直接比分不公平） */
function scPkCards(A, B){
  var avg = scPkSubjAvg();
  function card(row, dotCls, title){
    var subs = SC.exam.subjects || [];
    var list = [];
    subs.forEach(function(s){
      var v = scSubScore(row, s, SC.basis);
      var a = avg[s.key];
      if(v == null || a == null) return;
      list.push({ name: s.name || s.key, d: v - a });
    });
    if(!list.length) return '';
    var best = list[0], worst = list[0];
    list.forEach(function(x){
      if(x.d > best.d) best = x;
      if(x.d < worst.d) worst = x;
    });
    var sum = 0;
    list.forEach(function(x){ sum += x.d; });
    return '<div class="sc-card sc-pk-card">'
      + '<h4><i class="' + dotCls + '"></i>' + esc(title) + '</h4>'
      + '<div class="sc-pk-row"><span>最强项</span><b>' + esc(best.name)
      +   ' <span class="sc-sub-diff ' + (best.d >= 0 ? 'up' : 'down') + '">' + fmtDiff(best.d) + '</span></b></div>'
      + '<div class="sc-pk-row"><span>最弱项</span><b>' + esc(worst.name)
      +   ' <span class="sc-sub-diff ' + (worst.d >= 0 ? 'up' : 'down') + '">' + fmtDiff(worst.d) + '</span></b></div>'
      + '<div class="sc-pk-row"><span>综合超班均（各科累加）</span><b><span class="sc-sub-diff '
      +   (sum >= 0 ? 'up' : 'down') + '">' + fmtDiff(sum) + '</span></b></div>'
      + '</div>';
  }
  var html = '<div class="sc-pk-cards">'
    + card(A, 'sc-pk-dot-a', A.name || 'A 方')
    + card(B, 'sc-pk-dot-b', B.name || 'B 方')
    + '</div>';
  return html;
}

/* ③b 跨考试进退步与趋势（v3.4.0）：选了第二场考试后出现。
   站主原话「pk 的内容全一点，比如具体的进退步情况和趋势等等」——
   这里给两位同学在这两场之间的：总分 / 班排 / 年级排名 / 各科分数 的逐项变化。 */
function scPkTrendCard(A, B){
  if(SC.pkExam2 == null) return '';
  var pack = (SC.allRows || {})[SC.pkExam2];
  if(!pack){
    return '<div class="sc-card"><div class="sc-card-h">跨考试进退步</div>'
      + '<div class="sc-dim" style="padding:6px 0">正在读取对比考试的全班成绩（几秒钟）…读不到的话稍后再试。</div></div>';
  }
  var prevExam = pack.exam, prows = pack.rows || [];
  /* 在旧成绩里认人：先按绑定的 uid，认不上再按姓名兜底 */
  function findRow(r){
    var hit = null;
    if(r && r.uid) prows.forEach(function(x){ if(!hit && x.uid && String(x.uid) === String(r.uid)) hit = x; });
    if(!hit && r) prows.forEach(function(x){ if(!hit && x.name === r.name) hit = x; });
    return hit;
  }
  var pA = findRow(A), pB = findRow(B);

  /* 总分：按各场考试自己的科目配置算（两场科目或满分不同也能对） */
  function tot(row, exam){
    var t = 0, any = false;
    ((exam && exam.subjects) || []).forEach(function(s){
      var v = row && row.s && row.s[s.key];
      if(!v) return;
      var val = (SC.basis === 'graded' && s.graded && v.assigned != null) ? v.assigned : v.raw;
      if(val == null) return;
      t += val; any = true;
    });
    return any ? t : null;
  }
  /* 旧考试的班排（同分并列，与 scRankMap 同规则） */
  var pRk = (function(){
    var list = [];
    prows.forEach(function(r){
      var t = tot(r, prevExam);
      if(t != null) list.push({ id: r.id, t: t });
    });
    list.sort(function(a, b){ return b.t - a.t; });
    var rk = {}, lastT = null, lastRank = 0;
    list.forEach(function(o, i){
      if(o.t !== lastT){ lastRank = i + 1; lastT = o.t; }
      rk[o.id] = lastRank;
    });
    return rk;
  })();
  var curRk = scRankMap(SC.basis).total;

  /* 单元格：上次 → 本次（变化箭头）。名次是越小越好，分数越大越好。 */
  function cell(p, c, isRank, unit, missTxt){
    if(p == null && c == null) return '<td class="sc-dim">—</td>';
    var fmt = function(v){ return v == null ? '—' : fmtNum(v); };
    var main = (isRank ? '第 ' : '') + fmt(p) + ' → ' + (isRank ? '第 ' : '') + fmt(c);
    var sub = '';
    if(p != null && c != null){
      var d = c - p;
      if(d === 0) sub = '<span class="sc-dim">持平</span>';
      else{
        var good = isRank ? d < 0 : d > 0;
        sub = '<span class="sc-sub-diff ' + (good ? 'up' : 'down') + '">'
          + (good ? '↑ ' : '↓ ') + fmtNum(Math.abs(d)) + (unit || '') + '</span>';
      }
    }else sub = '<span class="sc-dim">' + (p == null ? (missTxt || '上次缺考') : '本次缺考') + '</span>';
    return '<td>' + main + '<span style="display:block;font-size:.66rem">' + sub + '</span></td>';
  }
  function rowHtml(label, pa, ca, pb, cb, isRank, unit, missTxt){
    return '<tr><td class="sc-name">' + esc(label) + '</td>'
      + cell(pa, ca, isRank, unit, missTxt) + cell(pb, cb, isRank, unit, missTxt) + '</tr>';
  }

  var body = '';
  /* 总分 + 名次三行 */
  body += rowHtml('总分',
    pA ? tot(pA, prevExam) : null, scTotal(A, SC.basis),
    pB ? tot(pB, prevExam) : null, scTotal(B, SC.basis), false, ' 分');
  body += rowHtml('班排',
    pA ? pRk[pA.id] : null, curRk[A.id],
    pB ? pRk[pB.id] : null, curRk[B.id], true, ' 名');
  /* v3.5.14 #5：上一次没导入年级排名时，不能再写「上次缺考」——
     缺考 ≠ 没导入，写错会误导。 */
  var rankMissing = (pA && pA.schoolRank == null) || (pB && pB.schoolRank == null);
  body += rowHtml('年级排名（物理方向）',
    pA ? pA.schoolRank : null, A.schoolRank,
    pB ? pB.schoolRank : null, B.schoolRank, true, ' 名', '上次未导入');
  /* 各科分数变化（按当前考试的科目逐科对） */
  (SC.exam.subjects || []).forEach(function(s){
    function val(row, exam){
      var v = row && row.s && row.s[s.key];
      if(!v) return null;
      return (SC.basis === 'graded' && s.graded && v.assigned != null) ? v.assigned : v.raw;
    }
    body += rowHtml(s.name || s.key,
      pA ? val(pA, prevExam) : null, scSubScore(A, s, SC.basis),
      pB ? val(pB, prevExam) : null, scSubScore(B, s, SC.basis), false, ' 分');
  });

  var missed = [];
  if(!pA) missed.push(A.name || 'A 方');
  if(!pB) missed.push(B.name || 'B 方');

  /* v3.5.7 需求 4：对比文字分析 —— 点明差距、强弱项与改进建议（本地规则生成） */
  function analyze(p, c, prevExam, isA){
    if(!p || !c) return null;
    var name = c.name || (isA ? 'A 方' : 'B 方');
    var pt = tot(p, prevExam), ct = tot(c, SC.exam);
    var out = { name: name };
    out.td = (pt != null && ct != null) ? ct - pt : null;
    out.dRank = (pRk[p.id] != null && curRk[c.id] != null) ? curRk[c.id] - pRk[p.id] : null;
    /* 各科变化（按当前考试科目） */
    var ds = [];
    (SC.exam.subjects || []).forEach(function(s){
      function val(row, exam){
        var v = row && row.s && row.s[s.key];
        if(!v) return null;
        return (SC.basis === 'graded' && s.graded && v.assigned != null) ? v.assigned : v.raw;
      }
      var pv = val(p, prevExam), cv = val(c, SC.exam);
      if(pv != null && cv != null && pv !== cv) ds.push({ sub: s.name || s.key, d: cv - pv, full: s.full || 0 });
    });
    ds.sort(function(a, b){ return b.d - a.d; });
    out.up = ds[0] || null;
    out.dn = ds.length ? ds[ds.length - 1] : null;
    out.flat = !ds.length;
    return out;
  }
  var anA = analyze(pA, A, prevExam, true), anB = analyze(pB, B, prevExam, false);
  function oneSide(x){
    if(!x) return '';
    var bits = [];
    if(x.td != null) bits.push('总分' + (x.td > 0 ? '上升 ' : x.td < 0 ? '下降 ' : '持平（') + fmtNum(Math.abs(x.td)) + ' 分' + (x.td === 0 ? '）' : ''));
    if(x.dRank != null && x.dRank !== 0) bits.push('班排' + (x.dRank < 0 ? '进步 ' : '退步 ') + Math.abs(x.dRank) + ' 名');
    if(x.up) bits.push(x.up.sub + ' 进步最多（+' + fmtNum(x.up.d) + ' 分）');
    if(x.dn && x.dn.d < 0) bits.push(x.dn.sub + ' 掉得最多（' + fmtNum(x.dn.d) + ' 分）');
    if(x.flat) bits.push('各科分数都没变');
    return '· <b>' + esc(x.name) + '</b>：' + (bits.join('，') || '两次成绩基本持平') + '。';
  }
  function suggest(x){
    if(!x) return '';
    var tips = [];
    if(x.dn && x.dn.d < 0){
      var ratio = x.dn.full ? Math.abs(x.dn.d) / x.dn.full : 0;
      tips.push('优先补一补 ' + esc(x.dn.sub) + (ratio > 0.1 ? '（这次掉了满分的 ' + (ratio * 100).toFixed(0) + '%，落差偏大）' : ''));
    }
    if(x.up && x.up.d > 0) tips.push(esc(x.up.sub) + '的势头保持住');
    if(x.td != null && x.td < 0 && x.dRank != null && x.dRank > 0) tips.push('总分和名次都在退，建议把这几次的错题归一下类，找共性漏洞');
    if(x.td != null && x.td > 0 && x.dRank != null && x.dRank < 0) tips.push('总分在涨、名次也在升，按现在的节奏继续');
    return tips.length ? '<div class="sc-dim" style="margin-top:4px">　↳ 建议：' + tips.join('；') + '。</div>' : '';
  }
  var gapTxt = '';
  if(anA && anB && anA.td != null && anB.td != null){
    var prevGap = tot(pA, prevExam) - tot(pB, prevExam);
    var curGap = scTotal(A, SC.basis) - scTotal(B, SC.basis);
    if(prevGap != null && curGap != null && prevGap !== curGap){
      var wider = Math.abs(curGap) > Math.abs(prevGap);
      gapTxt = '<div style="margin-top:6px">· <b>两人差距</b>：总分差从 ' + fmtNum(Math.abs(prevGap)) + ' 分变成 '
        + fmtNum(Math.abs(curGap)) + ' 分（' + (wider ? '拉开了' : '缩小了') + fmtNum(Math.abs(Math.abs(curGap) - Math.abs(prevGap))) + ' 分'
        + '，现在 ' + (curGap > 0 ? esc(anA.name) : esc(anB.name)) + ' 领先）。</div>';
    }
  }

  return '<div class="sc-card" data-scblk="pk_trend"><div class="sc-card-h">跨考试进退步（'
    + esc(shortName(prevExam.name || '')) + ' → ' + esc(shortName(SC.exam.name || '')) + '）'
    + '<span class="sc-h-note">' + esc(scDateRange(prevExam) || '') + ' → ' + esc(scDateRange(SC.exam) || '') + '</span></div>'
    + '<div class="sc-tblwrap" style="max-height:none"><table class="sc-tbl" style="min-width:auto">'
    + '<thead><tr><th>指标</th>'
    + '<th><i class="sc-pk-dot-a" style="display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px"></i> ' + esc(A.name || 'A 方') + '</th>'
    + '<th><i class="sc-pk-dot-b" style="display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px"></i> ' + esc(B.name || 'B 方') + '</th>'
    + '</tr></thead><tbody>' + body + '</tbody></table></div>'
    + '<div class="sc-figcap">「↑」为进步、「↓」为退步；名次越小越好。两场考试的科目或满分不同时，'
    + '各科按各自的科目配置取分，口径为' + (SC.basis === 'graded' ? '赋分' : '原始') + '。'
    + (missed.length ? '注意：' + esc(missed.join('、')) + ' 在「' + esc(shortName(prevExam.name || '')) + '」里没找到对应成绩（未考或未录入），相关格显示 —。' : '')
    + (rankMissing ? '<br><span class="sc-dim">年级排名进退步要求两场都导入年级排名；上一次未导入，故该行不展示进退步。</span>' : '')
    + '</div>'
    + (rankMissing ? scNoRankNotice({ reason:'cur-no-rank', total:(SC.me||[]).length, withRank:(SC.me||[]).filter(function(it){ return it.schoolRank != null; }).length }) : '')
    + '</div>';
}
  /* ===== v3.5.12（#8）对比分析升级 =====
     站主原话：「跟个人画像一样的 AI 分析，只不过着重对比二人数据进行分析与建议」
     所以这里不再只写「谁涨谁跌」，而是按个人画像那套五段结构来写，
     每一段都**把两个人放在一起比**：结论 / 领先在哪 / 短板在哪 / 差距怎么变 / 各自该干什么。 */

/* ===== v3.5.13（#8）：AI 对比分析抽成顶层函数 —— 站主要求「无论是几场考试都要有」。
   以前 pkAI 藏在 scPkTrendCard 闭包里，没选第二场就没有 AI 分析；现在单场也能出
   （少了「两场变化」一段），两场时多一段变化与趋势建议。 ===== */
function scPkAiData(A, B, ctx){
    if(!A || !B) return null;
    var tA = scTotal(A, SC.basis), tB = scTotal(B, SC.basis);
    if(tA == null || tB == null) return null;

    var rkA = ctx.curRk[A.id], rkB = ctx.curRk[B.id];
    var lead = tA >= tB ? { w: A, l: B, t: tA, lt: tB, rkw: rkA, rkl: rkB, nmW: A.name || 'A 方', nmL: B.name || 'B 方' }
                        : { w: B, l: A, t: tB, lt: tA, rkw: rkB, rkl: rkA, nmW: B.name || 'B 方', nmL: A.name || 'A 方' };
    var gap = Math.abs(tA - tB);

    /* ① 一句话结论 */
    var concl = gap === 0
      ? '这次两人总分<b>完全相同</b>（' + fmtNum(tA) + '），班排并列第 <b>' + fmtNum(rkA) + '</b>。'
      : '这次 <b>' + esc(lead.nmW) + '</b> 领先 <b>' + esc(lead.nmL) + '</b> <b>' + fmtNum(gap) + '</b> 分'
        + '（' + fmtNum(lead.t) + ' vs ' + fmtNum(lead.lt) + '，班排第 ' + fmtNum(lead.rkw) + ' vs 第 ' + fmtNum(lead.rkl) + '）。';

    /* ② 逐科拆差距：领先方在哪几科赢、落后方在哪几科扳回 */
    var subs = SC.exam.subjects || [];
    var per = [];
    subs.forEach(function(s){
      var va = scSubScore(A, s, SC.basis), vb = scSubScore(B, s, SC.basis);
      if(va == null || vb == null) return;
      per.push({ name: s.name || s.key, a: va, b: vb, d: va - vb, full: s.full || 0 });
    });
    if(!per.length) return null;
    var byAbs = per.slice().sort(function(x, y){ return Math.abs(y.d) - Math.abs(x.d); });
    var big = byAbs[0];
    var winnerIsA = big.d > 0;
    var bigWin = { name: big.name, d: Math.abs(big.d), by: winnerIsA ? (A.name || 'A 方') : (B.name || 'B 方'),
                   loser: winnerIsA ? (B.name || 'B 方') : (A.name || 'A 方'), full: big.full };

    var contrib = '差距的主要来源是 <b>' + esc(bigWin.name) + '</b>：'
      + esc(bigWin.by) + ' ' + fmtNum(winnerIsA ? big.a : big.b) + ' 分，'
      + esc(bigWin.loser) + ' ' + fmtNum(winnerIsA ? big.b : big.a) + ' 分，'
      + '单这一科就差了 <b>' + fmtNum(bigWin.d) + '</b> 分'
      + (gap > 0 ? '（占总差距的 ' + Math.min(999, Math.round(bigWin.d / gap * 100)) + '%）' : '') + '。';

    /* 两人各自「超班均最多」和「落后班均最多」的科目 */
    var avgMap = scPkSubjAvg();
    function strongWeak(row, nm){
      var list = [];
      per.forEach(function(x){
        var a = avgMap[(subs.filter(function(s){ return (s.name || s.key) === x.name; })[0] || {}).key];
        var v = x.a === undefined ? null : (row === A ? x.a : x.b);
        if(v == null || a == null) return;
        list.push({ name: x.name, d: v - a });
      });
      if(!list.length) return null;
      list.sort(function(p, q){ return q.d - p.d; });
      return { nm: nm, best: list[0], worst: list[list.length - 1] };
    }
    var swA = strongWeak(A, A.name || 'A 方');
    var swB = strongWeak(B, B.name || 'B 方');

    function sideText(sw){
      if(!sw) return '';
      var t = '<b>' + esc(sw.nm) + '</b>：';
      if(sw.best.d > 0) t += '最强 <b>' + esc(sw.best.name) + '</b>（超班均 ' + fmtNum(sw.best.d) + ' 分）';
      else t += '没有超过班均的科目';
      t += '；';
      if(sw.worst.d < 0) t += '最弱 <b>' + esc(sw.worst.name) + '</b>（落后班均 ' + fmtNum(Math.abs(sw.worst.d)) + ' 分）';
      else t += '各科都在班均之上';
      return t + '。';
    }

    /* ③ 各自这两场的变化（复用 analyze 的结论） */
    function trendOf(x){
      if(!x) return '';
      var bits = [];
      if(x.td != null) bits.push('总分' + (x.td > 0 ? '↑' + fmtNum(x.td) : x.td < 0 ? '↓' + fmtNum(Math.abs(x.td)) : '持平'));
      if(x.dRank != null && x.dRank !== 0) bits.push('班排' + (x.dRank < 0 ? '进步 ' + Math.abs(x.dRank) + ' 名' : '退步 ' + x.dRank + ' 名'));
      if(x.up && x.up.d > 0) bits.push(x.up.sub + ' +' + fmtNum(x.up.d));
      if(x.dn && x.dn.d < 0) bits.push(x.dn.sub + ' ' + fmtNum(x.dn.d));
      return bits.length ? bits.join('，') : '两场基本持平';
    }

    /* ④ 建议：分「领先方怎么守」「落后方怎么追」，都落到具体科目 */
    var todo = [];
    if(gap === 0){
      todo.push('两人这次打成平手，下一步比的是<b>谁先把短板补上去</b>。'
        + '对照上面的强弱项，各自把落后班均最多的那科当成本月唯一重点。');
    }else{
      todo.push('<b>' + esc(lead.nmL) + '</b> 的追赶点很明确：<b>' + esc(bigWin.name) + '</b> 一科就差了 '
        + fmtNum(bigWin.d) + ' 分，只要把这一科拉到对方水平，总分差距立刻抹平'
        + (bigWin.d >= gap ? '（甚至反超）' : '') + '。别同时补三科。');
      todo.push('<b>' + esc(lead.nmW) + '</b> 的优势主要靠 <b>' + esc(bigWin.name) + '</b>，'
        + '这一科要继续稳住；同时注意别在其他科目被对方反超 —— 把最弱那一科守到班均以上就够。');
    }
    if(ctx.anA && ctx.anA.td != null && ctx.anB && ctx.anB.td != null && ctx.anA.td !== ctx.anB.td){
      var faster = ctx.anA.td > ctx.anB.td ? ctx.anA.name : ctx.anB.name;
      todo.push('从这两场的<b>变化速度</b>看，<b>' + esc(faster) + '</b> 涨得更快 —— '
        + '如果这个势头保持下去，' + (gap > 0 ? '下一次考试两人的差距会进一步' + (faster === lead.nmW ? '拉大' : '缩小') : '差距会重新出现')
        + '。');
    }
    todo = todo.slice(0, 3);

    var rowHtml = function(k, v){
      return v ? '<div class="sc-ai-row"><span class="sc-ai-k">' + k + '</span><span class="sc-ai-v">' + v + '</span></div>' : '';
    };
    return {
      concl: concl,
      contrib: contrib,
      sideA: sideText(swA),
      sideB: sideText(swB),
      trend: ctx.hasPrev ? ('两场变化 —— ' + esc(A.name || 'A 方') + '：' + trendOf(ctx.anA) + '；'
        + esc(B.name || 'B 方') + '：' + trendOf(ctx.anB) + '。') : '',
      gapTxt: ctx.gapTxt,
      todo: todo,
      rowHtml: rowHtml,
      tableHtml: '<div class="sc-tblwrap" style="max-height:none;margin-top:8px">'
        + '<table class="sc-tbl" style="min-width:auto"><thead><tr>'
        + '<th>科目</th><th>' + esc(A.name || 'A 方') + '</th><th>' + esc(B.name || 'B 方') + '</th><th>差值</th>'
        + '</tr></thead><tbody>'
        + per.map(function(x){
            var cls = x.d > 0 ? 'up' : (x.d < 0 ? 'down' : '');
            return '<tr><td class="sc-name">' + esc(x.name) + '</td>'
              + '<td>' + fmtNum(x.a) + '</td><td>' + fmtNum(x.b) + '</td>'
              + '<td>' + (x.d === 0 ? '<span class="sc-dim">±0</span>'
                  : '<span class="sc-sub-diff ' + cls + '">' + fmtDiff(x.d) + '</span>') + '</td></tr>';
          }).join('')
        + '</tbody></table></div>',
    };
}

/** v3.5.13：统一入口 —— 单场/两场都出 AI 对比分析卡 */
function scPkAiCard(A, B){
  var hasPrev = SC.pkExam2 != null && !!(SC.allRows || {})[SC.pkExam2];
  var ctx = { curRk: (scRankMap(SC.basis).total || {}), anA: null, anB: null, gapTxt: '', hasPrev: hasPrev };
  if(!A || !B) return '';
  var tA = scTotal(A, SC.basis), tB = scTotal(B, SC.basis);
  if(tA == null || tB == null) return '';
  var d = scPkAiData(A, B, ctx);
  if(!d) return '';
  var note = hasPrev
    ? '这份对比由浏览器按两场考试数据实时算出（总分差 / 逐科拆解 / 强弱项 / 变化速度四类规则），仅供参考。'
    : '这份对比由浏览器按本场数据实时算出（总分差 / 逐科拆解 / 强弱项三类规则）。想看两场进退与趋势，选一场「对比另一场」。';
  return '<div class="sc-card sc-ai-card" data-scblk="pk_ai" style="margin-top:12px">'
    + '<div class="sc-card-h">AI 对比分析<span class="sc-h-note">本地规则生成 · 不联网 · 不上传成绩</span></div>'
    + '<div class="sc-ai-concl">' + d.concl + '</div>'
    + d.rowHtml('差距在哪', d.contrib)
    + d.rowHtml('A 方强弱', d.sideA)
    + d.rowHtml('B 方强弱', d.sideB)
    + (hasPrev ? d.rowHtml('两场变化', d.trend) : '')
    + d.tableHtml
    + '<div class="sc-ai-todo"><b>下一步可以这样做</b><ol>'
    +   d.todo.map(function(t){ return '<li>' + t + '</li>'; }).join('')
    + '</ol></div>'
    + '<div class="sc-figcap">' + note + '</div>'
    + '</div>';
}



function scOvItem(k, v, sub){
  /* v3.5.14 #3：第三参是标签下的小字副说明（如「物理方向」），
     把长标签拆成两行，窄屏不再把数值挤出去 */
  return '<div class="sc-ov-item"><span>' + esc(k)
    + (sub ? '<small>' + esc(sub) + '</small>' : '')
    + '</span><b>' + esc(String(v)) + '</b></div>';
}
function fmtDiff(d){
  var s = d >= 0 ? '+' : '−';
  return s + fmtNum(Math.abs(d), 1);
}
/* 数字显示：整数不带小数点，非整数最多留一位（避免 12.499999 这种浮点尾巴） */
function fmtNum(v, maxDec){
  if(v == null || !isFinite(v)) return '—';
  var d = maxDec == null ? 1 : maxDec;
  var r = Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
  return (Math.abs(r - Math.round(r)) < 1e-9) ? String(Math.round(r)) : String(r);
}

/* 雷达图（纯 SVG）
   tips：每个轴要直接写在图上的具体数值（如「114.5/150」）——
   站主要求图上能直接看到分数，不用去别处对。 */
function scRadar(labels, mine, avg, tips){
  var n = labels.length;
  var W = 640, H = 322, cx = 320, cy = 154, R = 100;
  var pt = function(i, r){
    var a = (-90 + i * 360 / n) * Math.PI / 180;
    return [cx + Math.cos(a) * R * r, cy + Math.sin(a) * R * r];
  };
  var poly = function(vals, k){
    var p = [];
    for(var i = 0; i < n; i++){
      var q = pt(i, Math.max(0, Math.min(1, vals[i] * k)));
      p.push(q[0].toFixed(1) + ',' + q[1].toFixed(1));
    }
    return p.join(' ');
  };
  var g = '';
  [0.25, 0.5, 0.75, 1].forEach(function(k){
    g += '<polygon points="' + poly(labels.map(function(){ return 1; }), k) + '" class="sc-g" fill="none" stroke="#ece2d8" stroke-width="1"/>';
  });
  for(var i = 0; i < n; i++){
    var p = pt(i, 1);
    g += '<line x1="' + cx + '" y1="' + cy + '" x2="' + p[0].toFixed(1) + '" y2="' + p[1].toFixed(1) + '" class="sc-g" stroke="#ece2d8" stroke-width="1"/>';
    var lp = pt(i, 1.16);
    g += '<text x="' + lp[0].toFixed(1) + '" y="' + (lp[1] + 2).toFixed(1) + '" font-size="11" class="sc-axlbl" fill="#6e635a" text-anchor="middle">' + esc(labels[i]) + '</text>';
    if(tips && tips[i]){
      g += '<text x="' + lp[0].toFixed(1) + '" y="' + (lp[1] + 15).toFixed(1)
        + '" font-size="10" font-weight="700" class="sc-tip" fill="#c0392b" text-anchor="middle">' + esc(tips[i]) + '</text>';
    }
  }
  g += '<polygon points="' + poly(avg, 1) + '" class="sc-avg" fill="none" stroke="#857468" stroke-width="1.4" stroke-dasharray="4 3"/>';
  g += '<polygon points="' + poly(mine, 1) + '" class="sc-mine-poly" fill="rgba(192,57,43,.16)" stroke="#c0392b" stroke-width="2"/>';
  for(var j = 0; j < n; j++){
    var q = pt(j, Math.max(0, Math.min(1, mine[j])));
    g += '<circle cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) + '" r="3.2" class="sc-mine-dot" fill="#c0392b"/>';
  }
  /* 圈是得分率刻度 —— 不写出来容易被误读成绝对分数 */
  g += '<text x="6" y="14" font-size="9.5" class="sc-axdim" fill="#7a6a5c">外圈＝满分</text>';
  g += '<text x="6" y="27" font-size="9.5" class="sc-axdim" fill="#7a6a5c">实线＝我　虚线＝班均</text>';
  return '<div class="sc-svgwrap"><svg viewBox="0 0 ' + W + ' ' + H + '" class="sc-svg">' + g + '</svg></div>';
}

/* 趋势 / 进退步：需要历次考试（/scores?action=me） */
function scTrendBlock(meRow){
  var items = SC.me;
  if(!items || items.length < 2){
    return '<div class="sc-card"><div class="sc-card-h">历次趋势</div>'
      + '<div class="sc-dim" style="padding:6px 0">目前只有一次考试的成绩，等下一次考完就能看到趋势和进退步了。</div></div>';
  }
  /* 只保留有各科配置、能算出总分的 */
  var pts = items.map(function(it){
    var subs = it.subjects || [];
    var t = 0, any = false;
    subs.forEach(function(s){
      var v = it.s && it.s[s.key];
      if(!v) return;
      var val = (SC.basis === 'graded' && s.graded && v.assigned != null) ? v.assigned : v.raw;
      if(val == null) return;
      t += val; any = true;
    });
    return { name: it.name, date: it.date, total: any ? t : null };
  }).filter(function(p){ return p.total != null; });

  var totalPts = pts.length;
  if(pts.length < 2){
    return '<div class="sc-card"><div class="sc-card-h">历次趋势</div>'
      + '<div class="sc-dim" style="padding:6px 0">可用的考试还不够（至少两次），暂时画不出趋势。</div></div>';
  }
  /* 近 N 次 / 全部（站主要求可切换；因为只录大考，"近 5 次"在时间上能跨一个学期） */
  if(SC.trendN !== 'all' && pts.length > SC.trendN) pts = pts.slice(pts.length - SC.trendN);

  /* 折线：总分随时间 */
  var W = 640, H = 170, L = 40, B = 28, T = 16, R = 16;
  var vals = pts.map(function(p){ return p.total; });
  var mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals);
  var span = Math.max(1, mx - mn);
  var xOf = function(i){ return L + (W - L - R) * (pts.length === 1 ? 0.5 : i / (pts.length - 1)); };
  var yOf = function(v){ return T + (H - T - B) * (1 - (v - mn) / span); };

  var path = pts.map(function(p, i){ return (i ? 'L' : 'M') + xOf(i).toFixed(1) + ' ' + yOf(p.total).toFixed(1); }).join(' ');
  var dots = pts.map(function(p, i){
    /* 首尾两个日期标签贴边写：居中的话最后一格会被 viewBox 切掉（手机上尤其明显） */
    var anc = i === 0 ? 'start' : (i === pts.length - 1 ? 'end' : 'middle');
    return '<circle cx="' + xOf(i).toFixed(1) + '" cy="' + yOf(p.total).toFixed(1) + '" r="3.4" class="sc-mine-dot" fill="#c0392b"/>'
      + '<text x="' + xOf(i).toFixed(1) + '" y="' + (yOf(p.total) - 8).toFixed(1) + '" font-size="9.5" class="sc-tip" fill="#c0392b" text-anchor="middle">' + p.total + '</text>'
      + (i % Math.ceil(pts.length / 8) === 0 || i === pts.length - 1
          ? '<text x="' + xOf(i).toFixed(1) + '" y="' + (H - 14) + '" font-size="9" class="sc-axdim" fill="#7a6a5c" text-anchor="' + anc + '">' + esc(shortName(p.name)) + '</text>'
            /* v3.5.14 #4：补考试日期，光有考试名对不上时间；
               再加一根短刻度线，把日期和上面的点连起来 */
            + '<line x1="' + xOf(i).toFixed(1) + '" y1="' + (H - B) + '" x2="' + xOf(i).toFixed(1) + '" y2="' + (H - B + 4) + '" class="sc-axis" stroke="#e2d5c8" stroke-width="1"/>'
            + '<text x="' + xOf(i).toFixed(1) + '" y="' + (H - 3) + '" font-size="8" class="sc-axdim" fill="#a8968a" text-anchor="' + anc + '">' + esc(scPointDateLabel(p.date)) + '</text>'
          : '');
  }).join('');

  /* 最近一次 vs 上一次 */
  var last = pts[pts.length - 1], prev = pts[pts.length - 2];
  var d = last.total - prev.total;
  var arrow = d > 0 ? '↑ 进步' : d < 0 ? '↓ 退步' : '— 持平';
  var cls = d > 0 ? 'up' : d < 0 ? 'down' : '';
  var spanTxt = pts[0].date + ' ~ ' + last.date;

  var seg = '<div class="sc-seg sc-seg-sm" style="margin-left:auto">'
    + [[3, '近 3 次'], [5, '近 5 次'], ['all', '全部']].map(function(o){
        return '<button class="' + (String(SC.trendN) === String(o[0]) ? 'on' : '') + '" onclick="scSetTrendN(' + (o[0] === 'all' ? "'all'" : o[0]) + ')">' + o[1] + '</button>';
      }).join('') + '</div>';

  return '<div class="sc-card"><div class="sc-card-h" style="display:flex;align-items:center;gap:8px">历次总分趋势' + seg + '</div>'
    + '<div class="sc-trendhead ' + cls + '">最近一次较上次：<b>' + arrow + ' ' + Math.abs(d) + ' 分</b>'
    +   '<span class="sc-dim">（' + esc(prev.name) + ' → ' + esc(last.name) + '）</span></div>'
    + '<div class="sc-svgwrap"><svg viewBox="0 0 ' + W + ' ' + H + '" class="sc-svg">'
    +   '<line x1="' + L + '" y1="' + (H - B) + '" x2="' + (W - R) + '" y2="' + (H - B) + '" class="sc-axis" stroke="#e2d5c8" stroke-width="1.2"/>'
    +   '<path d="' + path + '" class="sc-mine-line" fill="none" stroke="#c0392b" stroke-width="2"/>'
    +   dots
    + '</svg></div>'
    + '<div class="sc-figcap">统计 ' + pts.length + ' 次考试（共录入 ' + totalPts + ' 次），覆盖 ' + esc(spanTxt) + '。</div>'
    + '</div>';
}


/* ============================================================
   增强块（v2.8.0）：各科趋势网格 / 年级进退步 / 跨考试上线率
   —— 全部浏览器实时算，服务器只给原始分
   ============================================================ */

/* v3.5.14 #4：考试日期 → MM-DD（图上标签用，太长放不下） */
function scPointDateLabel(d){
  var s = String(d || '');
  return s.length >= 10 ? s.slice(5, 10) : s;
}
/* v3.5.14 #5：本次考试在 SC.me 里的下标（找不到就取末位） */
function scExamAnchorIdx(items, examId){
  if(!items || !items.length) return -1;
  if(examId != null){
    for(var i = items.length - 1; i >= 0; i--){
      if(String(items[i].examId) === String(examId)) return i;
    }
  }
  return items.length - 1;
}
/* v3.5.14 #5：年级排名进退步的**唯一**口径
   · 锚点 = 本次考试；本次没有年级排名 → ok:false, reason:'cur-no-rank'（不许拿更早的冒充本次）
   · 否则从本次往前找**最近一次有年级排名**的考试当 prev
   · 返回 skipped（被跳过的考试）与 total/withRank，供「5 次里只有 3 次有排名」的说明 */
function scRankPair(items, getRank, anchorIdx){
  items = items || [];
  var out = { ok:false, cur:null, prev:null, skipped:[], total:items.length, withRank:0, reason:'' };
  if(!items.length){ out.reason = 'empty'; return out; }
  out.withRank = items.filter(function(it){ return getRank(it) != null; }).length;
  var ai = (anchorIdx == null || anchorIdx < 0 || anchorIdx >= items.length) ? items.length - 1 : anchorIdx;
  var cur = items[ai];
  out.cur = cur;
  if(getRank(cur) == null){ out.reason = 'cur-no-rank'; return out; }
  for(var i = ai - 1; i >= 0; i--){
    if(getRank(items[i]) != null){
      out.ok = true; out.prev = items[i];
      for(var j = i + 1; j < ai; j++) out.skipped.push(items[j]);
      return out;
    }
  }
  out.reason = 'no-prev-rank';
  return out;
}
/* v3.5.14 #5：缺年级排名时统一文案（三处共用，避免口径说辞不一致） */
function scNoRankNotice(pair){
  if(!pair) return '';
  var tot = pair.total || 0, wr = pair.withRank || 0;
  var cnt = '已录入 <b>' + tot + '</b> 次考试，其中 <b>' + wr + '</b> 次含年级排名';
  var msg;
  if(pair.reason === 'cur-no-rank'){
    msg = '本次考试没有导入年级排名，<b>无法判断年级进退步</b>。';
  }else if(pair.reason === 'no-prev-rank'){
    msg = '本次之前没有可对比的年级排名，<b>暂时无法判断进退步</b>。';
  }else if(pair.reason === 'empty'){
    msg = '还没有成绩记录。';
  }else return '';
  return '<div class="sc-norank"><b>说明</b>　' + msg + '（' + cnt + '；趋势图只画含年级排名的那几次，不会用更早的考试冒充本次。）'
    + '<br><span class="sc-dim">原因：年级排名由人工导入，未导入的考试不参与进退步分析。</span></div>';
}

/* 迷你折线（各科趋势卡内）：分数「高好」、名次「小好」，两种口径共用一套画法。 */
function scMiniLine(pts, betterIsHigh, fmt){
  if(!pts || pts.length < 2) return '';
  var mw = 132, mh = 38;
  var mv = pts.map(function(x){ return x.v; });
  var vmax = Math.max.apply(null, mv), vmin = Math.min.apply(null, mv);
  var sp = Math.max(1, vmax - vmin);
  var px = function(i){ return 5 + (mw - 10) * i / (pts.length - 1); };
  /* ⚠️ 名次越小越好，所以纵轴要翻过来 —— 好成绩才在上方（跟分数口径同一视觉） */
  var py = function(v){
    var t = (v - vmin) / sp;
    if(!betterIsHigh) t = 1 - t;
    return 13 + (mh - 26) * (1 - t);
  };
  var segs = '';
  for(var i = 1; i < pts.length; i++){
    var good = betterIsHigh ? pts[i].v >= pts[i - 1].v : pts[i].v <= pts[i - 1].v;
    segs += '<line x1="' + px(i - 1).toFixed(1) + '" y1="' + py(pts[i - 1].v).toFixed(1)
         +  '" x2="' + px(i).toFixed(1) + '" y2="' + py(pts[i].v).toFixed(1)
         +  '" class="' + (good ? 'sc-up' : 'sc-down') + '" stroke="' + (good ? '#0b7a43' : '#c0392b')
         +  '" stroke-width="1.8" stroke-linecap="round"/>';
  }
  /* 每个点都写数值 —— 手机端没有鼠标悬浮，不写出来就看不到 */
  var nums = pts.map(function(x, i){
    if(pts.length > 6 && i !== 0 && i !== pts.length - 1 && i !== Math.floor(pts.length / 2)) return '';
    var tx = Math.min(Math.max(px(i), 14), mw - 14);
    return '<text x="' + tx.toFixed(1) + '" y="' + (py(x.v) - 4.5).toFixed(1)
         + '" font-size="8" font-weight="700" class="sc-mini-num" fill="#7a6a5d" text-anchor="middle"'
         + ' stroke="#fffdfb" stroke-width="2.6" paint-order="stroke">' + fmt(x.v) + '</text>';
  }).join('');
  var dots = pts.map(function(x, i){
    return '<circle cx="' + px(i).toFixed(1) + '" cy="' + py(x.v).toFixed(1)
         + '" r="2.2" class="sc-mini-dot" fill="#fff" stroke="#857468" stroke-width="1.1"/>';
  }).join('');
  /* v3.5.14 #4：图下补一行考试日期（手机端不能悬浮，只能直接写出来）。
     点多的时候只标首 / 中 / 尾，避免挤成一团。 */
  var dates = pts.map(function(x){ return x.date ? scPointDateLabel(x.date) : ''; });
  var hasDate = dates.some(function(d){ return !!d; });
  var xaxis = '', guides = '';
  if(hasDate){
    /* 站主第三次反馈「时间没有对应具体的点」：以前 5 个点只标首/中/尾 3 个，
       中间两个点没有日期，看着就是没对齐。现在 ≤6 个点**每个都标**（挤不下才隔一个标）。 */
    var pick = [];
    var step = pts.length > 6 ? Math.ceil(pts.length / 6) : 1;
    dates.forEach(function(d, i){
      if(d && (i % step === 0 || i === pts.length - 1)) pick.push({ i:i, d:d });
    });
    /* v3.5.14 修正（站主「时间没有对应具体的点」）：
       —— 标签按该点真实 x 百分比绝对定位（以前 space-between 均分，点和日期对不上）；
       —— 同时在图上画一条淡虚线导引到该点，眼睛能直接连起来。 */
    guides = pick.map(function(p){
      var x = px(p.i).toFixed(1);
      return '<line x1="' + x + '" y1="11" x2="' + x + '" y2="' + (mh - 3) + '" class="sc-mini-guide" stroke="#e6dace" stroke-width=".8" stroke-dasharray="2 3"/>';
    }).join('');
    xaxis = '<div class="sc-mini-x">' + pick.map(function(p){
      var pct = pts.length <= 1 ? 0 : (p.i / (pts.length - 1)) * 100;
      var tr = p.i === 0 ? 'translateX(0)' : (p.i === pts.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)');
      /* 相邻日期错开一行，5 个标签才不会挤在一起 */
      return '<span style="left:' + pct.toFixed(2) + '%;top:' + (p.i % 2 ? 7 : 0) + 'px;transform:' + tr + '">' + esc(p.d) + '</span>';
    }).join('') + '</div>';
  }
  return '<svg viewBox="0 0 ' + mw + ' ' + mh + '" class="sc-mini-svg" style="width:100%;height:38px;display:block;margin-top:4px">'
       + guides + segs + nums + dots + '</svg>' + xaxis;
}

/* ---------- 各科趋势网格：每科一张小卡（本次 / 班均 / 较上次 / 小折线） ----------
   v3.2.0（站主要求「各科趋势还可以看排名变化」）：顶部加「分数 / 名次」切换。
   名次口径下折线纵轴翻转（越小越靠上），「较上次」换成名次升降。 */
function scSubjTrend(){
  var items = SC.me || [];
  if(items.length < 1) return '';
  var subs = SC.exam.subjects || [];
  var mode = (SC.subTrend === 'rank') ? 'rank' : 'score';
  /* v3.5.14 站主要求：名次能看「班级 / 年级」两套，且不一定每次都有数据 */
  var scope = (SC.subRankScope === 'class') ? 'class' : 'grade';
  var gradeN = (SC.exam.gradeRef && SC.exam.gradeRef.students) ? SC.exam.gradeRef.students : null;
  var meName = '';
  try{ meName = (scMyRow() || {}).name || ((SC.me && SC.me[SC.me.length - 1]) || {}).name || ''; }catch(e){}

  function scoreAt(it, sub){
    var v = it.s && it.s[sub.key];
    if(!v) return null;
    var val = (SC.basis === 'graded' && sub.graded && v.assigned != null) ? v.assigned : v.raw;
    return val == null ? null : val;
  }
  /* 单科年级排名：赋分口径优先用赋分名次，没有就退回原始名次 */
  function gradeRankAt(it, sub){
    var v = it.s && it.s[sub.key];
    if(!v) return null;
    var r = (SC.basis === 'graded' && sub.graded && v.asgRank != null) ? v.asgRank : v.rank;
    return r == null ? null : Number(r);
  }
  /* 单科班级排名：从历次全班成绩（SC.allRows）现算 —— 历史考试的班名库里没存，
     只能拿当次全班分数排一遍；同分并列，规则与成绩单一致。 */
  function classRankAt(it, sub){
    var pack = SC.allRows && SC.allRows[it.examId];
    if(!pack || !pack.rows || !pack.rows.length || !meName) return null;
    var mine = scoreAt(it, sub);
    if(mine == null) return null;
    var arr = [];
    pack.rows.forEach(function(r){
      var v = r.s && r.s[sub.key];
      if(!v) return;
      var x = (SC.basis === 'graded' && sub.graded && v.assigned != null) ? v.assigned : v.raw;
      if(x != null) arr.push({ n: r.name, v: Number(x) });
    });
    if(!arr.length) return null;
    arr.sort(function(a, b){ return b.v - a.v; });
    var rank = 0, last = null, hit = null;
    arr.forEach(function(x, i){
      if(last === null || x.v !== last){ rank = i + 1; last = x.v; }
      if(x.n === meName) hit = rank;
    });
    return hit;
  }
  function rankAt(it, sub){
    return scope === 'class' ? classRankAt(it, sub) : gradeRankAt(it, sub);
  }

  var cards = [];
  var anchorIdx = scExamAnchorIdx(items, SC.exam && SC.exam.id);
  subs.forEach(function(sub){
    var spts = [], rpts = [];
    /* v3.5.14 #4：点上带考试日期，图下才能标时间 */
    items.forEach(function(it){
      var sc0 = scoreAt(it, sub), rk0 = rankAt(it, sub);
      if(sc0 != null) spts.push({ v: sc0, date: it.date, name: it.name });
      if(rk0 != null) rpts.push({ v: rk0, date: it.date, name: it.name });
    });
    if(!spts.length && !rpts.length) return;

    var all = [];
    SC.rows.forEach(function(r){
      var x = scSubScore(r, sub, SC.basis);
      if(x != null) all.push(x);
    });
    var avg = all.length ? all.reduce(function(a, b){ return a + b; }, 0) / all.length : null;

    /* v3.5.14 #5：本次 = 当前选中的考试，不是「最后一个有数据的考试」。
       以前如果本次这科缺考，会把更早一次当成「本次」，显示成虚假的当前分。 */
    var curIt = (anchorIdx >= 0 && items[anchorIdx]) ? items[anchorIdx] : null;
    var cur = curIt ? scoreAt(curIt, sub) : null;
    var prevS = null;
    for(var pi = anchorIdx - 1; pi >= 0; pi--){
      var pv = scoreAt(items[pi], sub);
      if(pv != null){ prevS = pv; break; }
    }
    var dS = (cur == null || prevS == null) ? null : Math.round((cur - prevS) * 10) / 10;
    /* 名次同样按「本次 → 往前找最近一次有该科名次」配对 */
    var rpair = scRankPair(items, function(it){ return rankAt(it, sub); }, anchorIdx);
    var rcur = rpair.ok ? rankAt(rpair.cur, sub) : null;
    var rprev = rpair.ok ? rankAt(rpair.prev, sub) : null;
    var dR = (rcur == null || rprev == null) ? null : (rprev - rcur);   /* 正数 = 名次前进 = 进步 */

    var body;
    if(mode === 'rank'){
      body = (rcur == null
          ? '<div class="sc-sub-score sc-dim" style="font-size:1.15rem">暂无名次</div>'
            + '<div class="sc-sub-diff sc-dim">该科还没导入年级排名</div>'
          : '<div class="sc-sub-score">第 ' + rcur + '<small>'
            /* 分母不写「（年级）」「（班级）」—— 窄卡会换行；口径已经在卡片标题上写明 */
            + (scope === 'class'
                ? '/' + ((SC.rows && SC.rows.length) || '—') + ' 人'
                : (gradeN ? '/' + gradeN + ' 名' : '名'))
            + '</small></div>'
            + '<div class="sc-sub-diff ' + (dR == null ? 'sc-dim' : dR > 0 ? 'up' : dR < 0 ? 'down' : '') + '">'
            +   (dR == null ? (rpair.reason === 'cur-no-rank' ? '本次未导入该科年级排名' : '首次考试，暂无对比')
                           : '较上次 名次' + (dR > 0 ? ' ↑' + dR : dR < 0 ? ' ↓' + Math.abs(dR) : ' 持平'))
            + '</div>'
            + (cur == null ? '' : '<div class="sc-sub-diff sc-dim">分数 ' + fmtNum(cur) + ' / ' + sub.full + '</div>'))
        + scMiniLine(rpts, false, function(v){ return String(Math.round(v)); });
    } else {
      body = (cur == null
          ? '<div class="sc-sub-score sc-dim" style="font-size:1.15rem">未考</div>'
          : '<div class="sc-sub-score">' + fmtNum(cur) + '<small>/' + sub.full + '</small></div>')
        + (cur != null && avg != null
            ? '<div class="sc-sub-diff ' + (cur - avg >= 0 ? 'up' : 'down') + '">'
              + (cur - avg >= 0 ? '高于班均 ' : '低于班均 ') + fmtNum(Math.abs(cur - avg)) + ' 分</div>'
            : '')
        + (dS == null
            ? '<div class="sc-sub-diff sc-dim">首次考试，暂无对比</div>'
            : '<div class="sc-sub-diff ' + (dS > 0 ? 'up' : dS < 0 ? 'down' : '') + '">较上次 '
              + (dS > 0 ? '↑ ' : dS < 0 ? '↓ ' : '— ') + fmtNum(Math.abs(dS)) + ' 分</div>')
        + scMiniLine(spts, true, fmtNum);
    }

    cards.push('<div class="sc-sub">'
      + '<div class="sc-sub-top"><b>' + esc(sub.name) + '</b>'
      +   (sub.graded && SC.basis === 'graded' ? '<span class="sc-tag">赋分</span>' : '')
      +   '<span class="sc-sub-rk">' + (mode === 'rank'
            ? (rpts.length === items.length ? rpts.length + ' 次' : rpts.length + ' / ' + items.length + ' 次')
            : (spts.length === items.length ? spts.length + ' 次' : spts.length + ' / ' + items.length + ' 次')) + '</span></div>'
      + body
      + '</div>');
  });

  if(!cards.length) return '';
  var basisTxt = SC.basis === 'graded' ? '赋分口径' : '原始口径';
  return '<div class="sc-card"><div class="sc-card-h sc-h-flex">各科趋势（' + basisTxt + ' · '
    + (mode === 'rank' ? '看' + (scope === 'class' ? '班级' : '年级') + '名次' : '看分数') + '）'
    + (mode === 'rank'
        ? '<span class="sc-seg sc-seg-sm" style="margin-left:6px">'
          + '<button class="' + (scope === 'grade' ? 'on' : '') + '" onclick="scSetSubRankScope(\'grade\')">年级</button>'
          + '<button class="' + (scope === 'class' ? 'on' : '') + '" onclick="scSetSubRankScope(\'class\')">班级</button>'
          + '</span>' : '')
    + '<span class="sc-seg sc-seg-sm" style="margin-left:6px">'
    +   '<button class="' + (mode === 'score' ? 'on' : '') + '" onclick="scSetSubTrend(\'score\')">分数</button>'
    +   '<button class="' + (mode === 'rank' ? 'on' : '') + '" onclick="scSetSubTrend(\'rank\')">名次</button>'
    + '</span></div>'
    + '<div class="sc-subs">' + cards.join('') + '</div>'
    + '<div class="sc-figcap">'
    +   (mode === 'rank'
        ? (scope === 'class'
            ? '折线是该科历次<b>班级排名</b>（按当次全班分数现算，同分并列）：越靠上名次越前，绿色＝前进、红色＝后退。历史班级名次需要读取历次全班成绩。'
            : '折线是该科历次<b>年级排名（物理方向）</b>：越靠上名次越前，绿色＝名次前进、红色＝后退。年级排名由人工导入，<b>不是每次都有</b>，缺的那次不画点。')
        : '折线为该科历次走势：绿色为上涨，红色为下跌。')
    + '</div>'
    + '</div>';
}
function scSetSubTrend(m){ SC.subTrend = (m === 'rank') ? 'rank' : 'score'; scRenderPane(); }
/* v3.5.14：名次口径切班级 / 年级。班级名次要读历次全班成绩（懒加载，一次就够）。 */
function scSetSubRankScope(m){
  SC.subRankScope = (m === 'class') ? 'class' : 'grade';
  if(SC.subRankScope === 'class' && !SC.allRows){ scLoadAllRows(); return; }
  scRenderPane();
}

/* ---------- 年级进退步（用校排名；系统算不出全校，只能靠导入） ---------- */
/* 各科进退步（最近几次对比）：分数 + 年级排名，较上次升降，稳定性 ——
   站主 2026-10-17「着重对比近几次各科分数与排名的进退」。 */
function scSubjectProgress(){
  var items = (SC.me || []).slice().sort(function(a, b){
    return String(a.date || '').localeCompare(String(b.date || '')) || (a.examId - b.examId);
  });
  if(items.length < 2) return '';
  var recent = items.slice(-5);
  var subs = (SC.exam.subjects || []).slice();
  if(!subs.length) return '';
  var head = '<tr><th>科目</th>' + recent.map(function(it){
    return '<th>' + esc(shortName(it.name)) + '<br><span class="sc-dim" style="font-weight:400">' + esc((it.date || '').slice(5)) + '</span></th>';
  }).join('') + '<th>较上次</th><th>稳定性</th></tr>';
  var rows = subs.map(function(sub){
    var cells = '', scores = [], ranks = [];
    recent.forEach(function(it){
      var v = it.s && it.s[sub.key];
      if(!v){ cells += '<td class="sc-dim">—</td>'; return; }
      var val = (SC.basis === 'graded' && sub.graded && v.assigned != null) ? v.assigned : v.raw;
      var rk = v.rank;
      if(val != null) scores.push(Number(val));
      if(rk != null) ranks.push(Number(rk));
      cells += '<td>' + (val == null ? '—' : fmtNum(val))
        + (rk != null ? '<span style="display:block;font-size:.62rem;color:#a8968a">第' + rk + '</span>' : '') + '</td>';
    });
    var ds = scores.length >= 2 ? scores[scores.length - 1] - scores[scores.length - 2] : null;
    var dr = ranks.length >= 2 ? ranks[ranks.length - 2] - ranks[ranks.length - 1] : null;
    var dsTxt = ds == null ? '—' : (ds > 0 ? '↑ ' : ds < 0 ? '↓ ' : '— ') + fmtNum(Math.abs(ds));
    var drTxt = dr == null ? '' : (dr > 0 ? '名次↑' + dr : dr < 0 ? '名次↓' + Math.abs(dr) : '名次持平');
    var sd = null;
    if(scores.length >= 2){
      var m = scores.reduce(function(a, b){ return a + b; }, 0) / scores.length;
      sd = Math.sqrt(scores.reduce(function(a, b){ return a + (b - m) * (b - m); }, 0) / scores.length);
    }
    var cls = ds > 0 ? 'up' : ds < 0 ? 'down' : '';
    return '<tr><td class="sc-name">' + esc(sub.name) + '</td>' + cells
      + '<td><span class="sc-sub-diff ' + cls + '" style="margin-top:0">' + dsTxt + '</span>'
      + (drTxt ? '<span style="display:block;font-size:.66rem;color:#a8968a">' + drTxt + '</span>' : '') + '</td>'
      + '<td>' + (sd == null ? '—' : '±' + fmtNum(sd)) + '</td></tr>';
  }).join('');
  return '<div class="sc-card"><div class="sc-card-h">各科进退步（最近 ' + recent.length + ' 次）</div>'
    + '<div class="sc-tblwrap" style="max-height:none"><table class="sc-tbl" style="min-width:auto">'
    + '<thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>'
    + '<div class="sc-figcap">每格上排分数、下排小字为年级排名（物理方向）；「较上次」为分数增减与名次升降（名次↑为进步）；「稳定性」为标准差，越小越稳。</div></div>';
}

function scGradeTrend(){
  var items = SC.me || [];
  var pts = items.filter(function(it){ return it.schoolRank != null; });
  if(!pts.length) return '';

  /* 年级人数取「最近一次填过的」—— 当前这次可能没填，但上一次填了也算数 */
  var gradeN = null;
  for(var gi = items.length - 1; gi >= 0; gi--){
    if(items[gi].gradeRef && items[gi].gradeRef.students){ gradeN = items[gi].gradeRef.students; break; }
  }

  var svg = '';
  if(pts.length >= 2){
    var W = 640, H = 170, L = 46, B = 28, T = 18, R = 16;
    var vs = pts.map(function(p){ return p.schoolRank; });
    var mx = Math.max.apply(null, vs), mn = Math.min.apply(null, vs);
    if(mx === mn) mx = mn + 1;
    var xOf = function(i){ return L + (W - L - R) * i / (pts.length - 1); };
    /* 名次越小越好 → y 轴反向，靠前的人在上面 */
    var yOf = function(v){ return T + (H - T - B) * ((v - mn) / (mx - mn)); };
    var path = pts.map(function(p, i){
      return (i ? 'L' : 'M') + xOf(i).toFixed(1) + ' ' + yOf(p.schoolRank).toFixed(1);
    }).join(' ');
    var dots = pts.map(function(p, i){
      /* 首尾标签贴边写，避免最后一格被 viewBox 切掉 */
      var anc = i === 0 ? 'start' : (i === pts.length - 1 ? 'end' : 'middle');
      return '<circle cx="' + xOf(i).toFixed(1) + '" cy="' + yOf(p.schoolRank).toFixed(1) + '" r="3.4" class="sc-grade-dot" fill="#7c3aed"/>'
        + '<text x="' + xOf(i).toFixed(1) + '" y="' + (yOf(p.schoolRank) - 8).toFixed(1)
        +   '" font-size="9.5" class="sc-grade-num" fill="#7c3aed" text-anchor="middle">' + p.schoolRank + '</text>'
        + (i % Math.ceil(pts.length / 8) === 0 || i === pts.length - 1
            ? '<text x="' + xOf(i).toFixed(1) + '" y="' + (H - 14) + '" font-size="9" class="sc-axdim" fill="#7a6a5c" text-anchor="' + anc + '">'
              + esc(shortName(p.name)) + '</text>'
              /* v3.5.14 #4：每个标注点下面再写考试日期，手机端也能对上时间 */
              + '<line x1="' + xOf(i).toFixed(1) + '" y1="' + (H - B) + '" x2="' + xOf(i).toFixed(1) + '" y2="' + (H - B + 4) + '" class="sc-axis" stroke="#e2d5c8" stroke-width="1"/>'
              + '<text x="' + xOf(i).toFixed(1) + '" y="' + (H - 3) + '" font-size="8" class="sc-axdim" fill="#a8968a" text-anchor="' + anc + '">'
              + esc(scPointDateLabel(p.date)) + '</text>'
            : '');
    }).join('');
    svg = '<div class="sc-svgwrap"><svg viewBox="0 0 ' + W + ' ' + H + '" class="sc-svg">'
      + '<line x1="' + L + '" y1="' + (H - B) + '" x2="' + (W - R) + '" y2="' + (H - B) + '" class="sc-axis" stroke="#e2d5c8" stroke-width="1.2"/>'
      + '<path d="' + path + '" class="sc-grade-line" fill="none" stroke="#7c3aed" stroke-width="2"/>'
      + dots + '</svg></div>';
  }

  /* v3.5.14 #5：进退步只认「本次考试 vs 最近一次有年级排名的考试」。
     以前直接拿 pts 末位当「最近一次」，本次没导入年级排名时会静默用更早一次冒充，
     属于误导性展示 —— 现在本次缺排名就只说明原因，不给任何进退步数字。 */
  var anchorIdx = scExamAnchorIdx(items, SC.exam && SC.exam.id);
  var pair = scRankPair(items, function(it){ return it.schoolRank; }, anchorIdx);
  var last = pair.cur || (items.length ? items[items.length - 1] : null);
  var prev = pair.ok ? pair.prev : null;
  var dv = pair.ok ? (prev.schoolRank - last.schoolRank) : null;   /* 正数 = 名次前进 = 进步 */
  var head = '';
  if(dv != null){
    head = '<div class="sc-trendhead ' + (dv > 0 ? 'up' : dv < 0 ? 'down' : '') + '">本次对比上次：<b>'
      + (dv > 0 ? '↑ 年级进步 ' + dv + ' 名' : dv < 0 ? '↓ 年级退步 ' + (-dv) + ' 名' : '— 年级排名持平')
      + '</b><span class="sc-dim">（' + esc(prev.name) + ' 第 ' + prev.schoolRank + ' → '
      + esc(last.name) + ' 第 ' + last.schoolRank + '）</span></div>';
  }else{
    head = scNoRankNotice(pair);
  }
  var curRank = pair.ok ? last.schoolRank : null;
  var pct = (gradeN && curRank) ? (curRank / gradeN * 100) : null;

  return '<div class="sc-card"><div class="sc-card-h">年级排名变化（物理方向）</div>'
    + head
    + svg
    + '<div class="sc-ov-items" style="margin-top:10px">'
    +   scOvItem('年级排名', curRank == null ? '本次未导入' : (curRank + (gradeN ? ' / ' + gradeN : '')), '物理方向')
    +   scOvItem('年级位置', pct == null ? '—' : '前 ' + pct.toFixed(1) + '%')
    + '</div>'
    + '<div class="sc-figcap">年级排名与班排名分别统计，可对照查看。这里的年级排名是<b>物理方向</b>的年级排名，不是全校排名；本站成绩单里的年级排名均为物理方向口径。'
    +   (pts.length < items.length
          ? '<br><span class="sc-dim">趋势图只画含年级排名的 ' + pts.length + ' 次（共录入 ' + items.length + ' 次），没有年级排名的考试未展示。</span>'
          : '')
    +   (gradeN ? '' : '<br><span class="sc-dim">未填年级人数，不显示百分位。</span>')
    +   '</div></div>';
}

/* ---------- 跨考试上线率趋势（懒加载：点一下才去读历次全班成绩） ---------- */
function scLoadAllRows(){
  var need = SC.exams.filter(function(e){ return !SC.allRows || !SC.allRows[e.id]; });
  if(!need.length){ scRenderPane(); return; }
  scPane('<div class="sc-empty"><div class="spinner"></div><p>正在读取历次成绩…</p></div>');
  SC.allRows = SC.allRows || {};
  Promise.all(need.map(function(e){
    return api('/scores?action=board&exam=' + e.id).then(function(d){
      SC.allRows[e.id] = { exam: d.exam, rows: d.rows || [] };
    }).catch(function(){ SC.allRows[e.id] = null; });
  })).then(function(){ scRenderPane(); });
}

function scCutTrend(){
  if(SC.basis !== 'graded'){
    return '<div class="sc-card"><div class="sc-card-h">历次上线率</div>'
      + '<div class="sc-dim" style="padding:4px 2px 2px">分数线是按赋分总分划定的，原始口径下不与三线比较 —— 切到「总分赋分」即可看历次上线率。</div></div>';
  }
  /* v3.4.0 站主：历次上线率开放给管理员。管理员本人可能不在成绩表里
     （SC.me 为空），改用考试列表（含每次考试的 cutlines）当骨架；
     全班总分从 SC.allRows（懒加载的历次 board）里现算，与 SC.me 路径一致。 */
  var items = scIsAdmin()
    ? (SC.exams || []).map(function(e){
        return { examId: e.id, name: e.name, date: e.date || '', cutlines: e.cutlines || [], subjects: e.subjects || [] };
      })
    : (SC.me || []);
  var withCut = items.filter(function(it){
    return (it.cutlines || []).some(function(c){ return c.score != null; });
  });
  if(withCut.length < 2) return '';

  if(!SC.allRows){
    return '<div class="sc-card"><div class="sc-card-h">历次上线率</div>'
      + '<div class="sc-dim" style="padding:4px 0 10px">要看上线率怎么变，需要把每次考试的全班成绩都读一遍（几秒钟，一次就够）。</div>'
      + '<button class="btn btn-sm" onclick="scLoadAllRows()">开始计算</button></div>';
  }

  /* 收集所有出现过的分数线（按 label 归并） */
  var lines = [];
  withCut.forEach(function(it){
    (it.cutlines || []).forEach(function(c){
      if(c.score == null) return;
      if(!lines.some(function(x){ return x.label === c.label; })) {
        lines.push({ label: c.label, color: c.color || '#b45309' });
      }
    });
  });
  if(!lines.length) return '';

  var rowsTxt = withCut.map(function(it){
    var pack = SC.allRows[it.examId];
    if(!pack){ return ''; }
    var subs = (pack.exam && pack.exam.subjects) || it.subjects || [];
    var totals = [];
    (pack.rows || []).forEach(function(r){
      var t = 0, any = false;
      subs.forEach(function(sub){
        var v = r.s && r.s[sub.key];
        if(!v) return;
        var val = (SC.basis === 'graded' && sub.graded && v.assigned != null) ? v.assigned : v.raw;
        if(val == null) return;
        t += val; any = true;
      });
      if(any) totals.push(t);
    });
    if(!totals.length) return '';
    var cells = lines.map(function(ln){
      var cut = (it.cutlines || []).find(function(c){ return c.label === ln.label && c.score != null; });
      if(!cut) return '<td><span class="sc-dim">未填</span></td>';
      var n = totals.filter(function(v){ return v >= cut.score; }).length;
      var pctv = n / totals.length * 100;
      return '<td><b>' + n + '</b> <span class="sc-dim">(' + pctv.toFixed(0) + '%)</span></td>';
    }).join('');
    return '<tr><td class="sc-name">' + esc(shortName(it.name)) + '<span class="sc-subrank">' + esc(it.date) + '</span></td>'
      + cells + '<td>' + totals.length + '</td></tr>';
  }).join('');

  return '<div class="sc-card"><div class="sc-card-h">历次上线率</div>'
    + '<div class="sc-tblwrap" style="max-height:none"><table class="sc-tbl" style="min-width:auto">'
    + '<thead><tr><th>考试</th>'
    +   lines.map(function(ln){
        return '<th><span class="sc-cut-dot" style="display:inline-block;background:' + esc(ln.color) + '"></span> ' + esc(ln.label) + '</th>';
      }).join('')
    +   '<th>参考</th></tr></thead>'
    + '<tbody>' + rowsTxt + '</tbody></table></div>'
    + '<div class="sc-figcap">每格是<b>上线人数（占比）</b>。分数线每次都要手填，学校没公布的那次会显示「未填」。</div>'
    + '</div>';
}

/* ---------- 导出成绩卡（PNG，纯 canvas，不引第三方库） ---------- */
/* ============================================================
   导出成绩卡（v2.9.7：勾选要导出的内容）
   ------------------------------------------------------------
   站主 2026-10-15：「图片导出可以自定义导出的分析内容」。
   勾选项见 scExportDialog()；**没勾的段不画、也不占高度**，
   所以导出来的图高度是按选择算的，不会留一片空白。
   ============================================================ */

/* 勾选状态（本次会话内记住上次的选择；head 永远为真 —— 图里总得有主角）
   v2.9.8 站主：「图片分享的时候，我其实想要分享一些长图，就是有更多的功能，
   比如说在那个下面去接，比如说我具体的成绩分析啊，哪一科弱哪一科怎么样。」
   —— 于是在各科成绩后面接上四段分析，每段都能单独勾选。 */
var SC_EXPORT = {
  head: true,        /* 总分与排名（必选） */
  metrics: true,     /* 其它指标 */
  subjects: true,    /* 各科成绩 */
  subrank: true,     /* 单科班内排名（新） */
  diag: true,        /* 偏科分析（新） */
  rankbar: false,    /* 年级位置条（新） */
  trend: false,      /* 历次趋势（新） */
  cutlines: true,    /* 上线情况 */
};

/* 版式步长：算高度和画内容共用同一套，避免两边各写一遍对不上 */
var SC_EX_STEP = {
  W: 760, pad: 36,
  titleY: 62, gap1: 26, gap2: 34,      /* 标题 → 副标题 → 姓名区 */
  nameAfter: 28,
  metGap: 26, metBox: 56,
  subGap: 26, subTitle: 16, subRow: 40,
  rankGap: 26, rankTitle: 16, rankRow: 34,
  diagGap: 26, diagTitle: 16, diagRow: 26, diagFoot: 34,
  barGap: 26, barTitle: 16, barBox: 62,
  trendGap: 26, trendTitle: 16, trendBox: 158,
  cutGap: 40, cutRow: 30,
  foot: 62,
};

/** 按勾选算出成品高度（canvas 必须先定尺寸才能画）
 *  ⚠️ 这里和 scExportCard 的绘制必须严格同进同退 —— 少加一段，图上就会多一片空白；
 *     多加一段，内容会被裁掉。所以两边都只读 SC_EX_STEP，不写死数字。 */
function scExportHeight(cfg, nSub, nCut, nTrend, hasBar){
  var S = SC_EX_STEP;
  var y = S.titleY + S.gap1 + S.gap2 + S.nameAfter;   /* 标题 + 副标题 + 姓名行 */
  if(cfg.metrics) y += S.metGap + S.metBox;
  if(cfg.subjects && nSub) y += S.subGap + S.subTitle + nSub * S.subRow;
  if(cfg.subrank && nSub) y += S.rankGap + S.rankTitle + nSub * S.rankRow;
  if(cfg.diag && nSub) y += S.diagGap + S.diagTitle + nSub * S.diagRow + S.diagFoot;
  if(cfg.rankbar && hasBar) y += S.barGap + S.barTitle + S.barBox;
  if(cfg.trend && nTrend >= 2) y += S.trendGap + S.trendTitle + S.trendBox;
  if(cfg.cutlines && nCut) y += S.cutGap + nCut * S.cutRow;
  return Math.round(y + S.foot);
}

/** 我的历次总分（长图里的「历次趋势」段用）。
 *  SC.me 是「我的历次成绩」那条链；每项都自带那一次考试的 subjects，所以不能复用 scTotal。 */
function scMeSeries(){
  var arr = [];
  (SC.me || []).forEach(function(it){
    var subs = it.subjects || [];
    var t = 0, any = false;
    subs.forEach(function(s){
      var v = it.s && it.s[s.key];
      if(!v) return;
      var val = (SC.basis === 'graded' && s.graded && v.assigned != null) ? v.assigned : v.raw;
      if(val == null) return;
      t += val; any = true;
    });
    if(any) arr.push({ name: it.name, date: it.date || '', v: t });
  });
  arr.sort(function(a, b){ return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  return arr;
}

/** 导出前的勾选面板 */
function scExportDialog(){
  var meRow = scMyRow();
  if(!meRow){ alert('这次考试的成绩里没有你，导不出来。'); return; }
  var cuts = (SC.exam.cutlines || []).filter(function(c){ return c.score != null; });
  var gradeN = (SC.exam.gradeRef && SC.exam.gradeRef.students) ? SC.exam.gradeRef.students : null;
  var hasBar = !!(gradeN && meRow.schoolRank != null);
  var series = scMeSeries();

  /* dis = 这次没有可画的数据：勾也画不出来，所以直接禁用并写明原因，
     比「勾了但图上没有」友好（那种情况用户只会以为坏了）。 */
  var row = function(key, title, sub, dis){
    var forced = (key === 'head');
    var on = dis ? false : (forced ? true : (SC_EXPORT[key] !== false));
    var off = forced || !!dis;
    return '<label class="sc-ex-row' + (off ? ' off' : '') + '">'
      + '<input type="checkbox" data-ex="' + key + '"' + (on ? ' checked' : '') + (off ? ' disabled' : '') + '>'
      + '<span class="t">' + esc(title) + '<span class="s">' + esc(sub) + '</span></span></label>';
  };

  var html = '<div class="allboard-mask show" id="scExMask"><div class="allboard-box sc-box" style="max-width:560px">'
    + '<div class="allboard-head"><span>导出成绩长图</span><button onclick="scExportClose()">关闭</button></div>'
    + '<div class="sc-pane" style="max-height:70vh">'
    +   '<div class="sc-hint">勾选要放进图里的内容 —— <b>没勾的不会出现在图上，也不会留空</b>。<br>'
    +     '导出后是一张长图（越往下越细），手机上能直接分享到微信。</div>'
    +   '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 14px">'
    +     '<button class="btn btn-sm btn-secondary" data-exall="1">全选</button>'
    +     '<button class="btn btn-sm btn-secondary" data-exall="0">全不选</button>'
    +   '</div>'
    +   '<div class="sc-pk-group-h">我的画像<span class="sc-dim">这张图只关于你自己</span></div>'
    +   row('head', '总分与排名', '姓名、总分、班排名、年级排名（物理方向，必选）')
    +   row('metrics', '其它指标', '与班均差、联考排名')
    +   row('subjects', '各科成绩', '每科分数 / 满分、与班均差、得分率条')
    +   row('subrank', '单科排名', '每科的班内名次，名次越前条越长')
    +   row('diag', '偏科分析', '每科相对班均差多少，末尾点名最弱与最强科')
    +   row('rankbar', '年级位置条', hasBar ? '年级排名换算成百分位（第 ' + meRow.schoolRank + ' / ' + gradeN + '）'
        : '这次没导年级排名，画不出来', !hasBar)
    +   row('trend', '历次趋势', series.length >= 2 ? '最近 ' + series.length + ' 次考试的总分折线'
        : '至少要两次有成绩的考试才画得出来', series.length < 2)
    +   (cuts.length ? row('cutlines', '上线情况', '每条线过了没有、还差多少分') : '')
    +   '<div class="sc-pk-group-h">全班成绩单<span class="sc-dim">长图只画你一个人；要看整班请用「打印」</span></div>'
    +   '<p class="sc-figcap" style="margin:0 0 6px">导出长图的定位是「发给家人看我自己」，所以不画整班名次表。'
    +     '需要全班成绩单请点工具栏的<b>打印</b>，那里可以逐项勾选全班成绩单的内容。</p>'
    /* v3.6.1（站主 #2）：备注 —— 分享时说明「为什么发这张图」 */
    +   '<div style="margin-top:14px"><label class="sc-sh-lb">备注（选填，会印在图片底部）</label>'
    +     '<textarea id="scExNote" rows="2" maxlength="120" placeholder="例如：这次比上次进步了 20 名，继续加油" '
    +       'style="width:100%;padding:9px 11px;border-radius:10px;border:1px solid var(--line-2,#e7d9cc);font-size:.85rem;resize:vertical"></textarea>'
    +     '<div class="muted" style="font-size:.72rem;margin-top:4px">最多 120 字，写清原因对方一看就明白</div></div>'
    +   '<div style="display:flex;gap:10px;margin-top:18px">'
    +     '<button class="btn btn-secondary" style="flex:1" onclick="scExportClose()">取消</button>'
    +     '<button class="btn" style="flex:1" id="scExGo">导出图片</button>'
    +   '</div>'
    +   '<p class="sc-figcap">这次考试：' + esc(SC.exam.name) + '　' + esc(scDateRange(SC.exam))
    +     (SC.basis === 'graded' ? '　赋分口径' : '　原始口径') + '</p>'
    + '</div></div></div>';

  var host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);

  /* v3.5.12 #7：全选 / 全不选 */
  Array.prototype.forEach.call(host.querySelectorAll('[data-exall]'), function(b){
    b.onclick = function(){
      var v = b.getAttribute('data-exall') === '1';
      Array.prototype.forEach.call(host.querySelectorAll('[data-ex]'), function(cb){
        if(!cb.disabled) cb.checked = v;
      });
      /* 必选项 head 始终勾着 */
      var h = host.querySelector('[data-ex="head"]');
      if(h) h.checked = true;
    };
  });

  document.getElementById('scExGo').onclick = function(){
    var box = document.getElementById('scExMask');
    var next = {};
    Object.keys(SC_EXPORT).forEach(function(k){ next[k] = false; });
    Array.prototype.forEach.call(box.querySelectorAll('[data-ex]'), function(cb){
      next[cb.getAttribute('data-ex')] = !!cb.checked;
    });
    next.head = true;
    SC_EXPORT = next;             /* 记住这次的选择，下次打开还是这样 */
    var noteEl = document.getElementById('scExNote');
    var note = noteEl ? String(noteEl.value || '').trim().slice(0, 120) : '';
    scExportClose();
    /* v3.6.1：先把班徽加载好再画（画不出来就跳过，不能让导出失败） */
    var bp = (window.ShareCard && ShareCard.loadBadge)
      ? ShareCard.loadBadge(typeof siteBadgeList === 'function' ? siteBadgeList() : siteBadgeUrl())
      : Promise.resolve(null);
    bp.then(function(bd){ scExportCard(next, note, bd); })
      .catch(function(){ scExportCard(next, note, null); });
  };
}
function scExportClose(){
  var m = document.getElementById('scExMask');
  if(m && m.parentNode) m.parentNode.removeChild(m);
}

/** 真正画图。cfg 见 SC_EXPORT（不传的键默认「要」，兼容老调用） */
function scExportCard(cfg, note, badge){
  cfg = cfg || {};
  note = String(note || '').trim().slice(0, 120);
  var pick = function(k){ return cfg[k] === undefined ? true : !!cfg[k]; };
  var opt = {
    head: true,                     /* 永远有：图里得有主角 */
    metrics: pick('metrics'),
    subjects: pick('subjects'),
    subrank: pick('subrank'),
    diag: pick('diag'),
    rankbar: pick('rankbar'),
    trend: pick('trend'),
    cutlines: pick('cutlines'),
  };

  var meRow = scMyRow();
  if(!meRow){ alert('这次考试的成绩里没有你，导不出来。'); return; }
  var subs = SC.exam.subjects || [];
  var rk = scRankMap(SC.basis);
  var st = scStats(SC.basis);
  var myTotal = scTotal(meRow, SC.basis);
  var myRank = rk.total[meRow.id];
  var gradeN = (SC.exam.gradeRef && SC.exam.gradeRef.students) ? SC.exam.gradeRef.students : null;
  /* 分数线是赋分线：原始口径下导出图里也不与三线比较 */
  var cuts = (opt.cutlines && SC.basis === 'graded') ? (SC.exam.cutlines || []).filter(function(c){ return c.score != null; }) : [];
  var series = opt.trend ? scMeSeries() : [];
  var hasBar = !!(gradeN && meRow.schoolRank != null);

  var S = SC_EX_STEP, W = S.W, pad = S.pad;
  /* v3.6.1：备注按每行 34 字估行数（宽 688px、14px 字号，中文 34 字很保守），
     多留一点空白也比把字裁掉强。 */
  var noteLines = note ? Math.ceil(note.length / 34) : 0;
  var noteH = noteLines ? (noteLines * 22 + 20) : 0;
  var H = scExportHeight(opt, subs.length, cuts.length, series.length, hasBar) + noteH;
  var SCALE = 2;

  var cv = document.createElement('canvas');
  cv.width = W * SCALE; cv.height = H * SCALE;
  var g = cv.getContext('2d');
  g.scale(SCALE, SCALE);

  var FONT = '-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
  var f = function(size, bold){
    g.font = (bold ? 'bold ' : '') + size + 'px ' + FONT;
  };

  /* 背景 + 顶部色条 */
  /* ⚠️ v2.9.12：导出长图是 canvas，DOM 扫描器扫不到内部文字 —— 已按 WCAG 逐色
     人工核算（底色 #fffdfb / #fdf8f3 / #fdfbf9）：旧 #a8968a（2.80）、#c9b8a8（1.90）、
     #0f8a4d 小字（4.27～4.35）不达标 → #7a6a5c / #0b7a43；进度条填充旧 #e6a97a
     压 #f0e7de 轨道仅 1.67 → #b06a32。本图永远浅色（同打印基线），无暗色变体。 */
  g.fillStyle = '#fffdfb'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#c2410c'; g.fillRect(0, 0, W, 8);
  g.textBaseline = 'alphabetic';

  /* ① 标题 + 副标题 */
  var y = S.titleY;
  g.fillStyle = '#292524'; f(25, true); g.fillText(SC.exam.name, pad, y);
  y += S.gap1; f(13); g.fillStyle = '#6e635a';
  g.fillText((SC.exam.type || '考试') + '　' + scDateRange(SC.exam) + '　'
    + (SC.basis === 'graded' ? '赋分口径' : '原始口径'), pad, y);
  y += S.gap2 + S.nameAfter;

  /* ② 姓名 + 总分 */
  g.fillStyle = '#c2410c'; f(38, true);
  g.fillText(meRow.name, pad, y);
  var nameW = g.measureText(meRow.name).width;
  g.fillStyle = '#292524'; g.font = 'bold 40px ' + FONT;
  var totalTxt = myTotal == null ? '—' : String(fmtNum(myTotal));
  g.fillText(totalTxt, pad + nameW + 22, y);
  var totalW = g.measureText(totalTxt).width;
  f(14); g.fillStyle = '#7a6a5c';
  g.fillText('/ ' + scFullMark() + ' 总分', pad + nameW + 22 + totalW + 8, y);

  /* ③ 四个指标 */
  if(opt.metrics){
    y += S.metGap;
    var items = [
      ['班排名', myRank ? myRank + ' / ' + st.n : '—'],
      ['年级排名（物理）', meRow.schoolRank != null ? meRow.schoolRank + (gradeN ? ' / ' + gradeN : '') : '—'],
      ['与班均', myTotal != null ? fmtDiff(myTotal - st.avg) : '—'],
      ['联考排名', meRow.leagueRank != null ? String(meRow.leagueRank) : '—'],
    ];
    var boxW = (W - pad * 2 - 12 * 3) / 4;
    items.forEach(function(it, i){
      var x = pad + i * (boxW + 12);
      g.fillStyle = '#fdf8f3'; g.fillRect(x, y, boxW, S.metBox);
      g.fillStyle = '#7a6a5c'; f(11); g.fillText(it[0], x + 12, y + 22);
      g.fillStyle = '#292524'; f(17, true); g.fillText(it[1], x + 12, y + 46);
    });
    y += S.metBox;
  }

  /* ④ 各科 */
  if(opt.subjects && subs.length){
    y += S.subGap;
    g.fillStyle = '#57534e'; f(15, true); g.fillText('各科成绩', pad, y);
    y += S.subTitle;
    subs.forEach(function(sub){
      var v = scSubScore(meRow, sub, SC.basis);
      var all = [];
      SC.rows.forEach(function(r){
        var x2 = scSubScore(r, sub, SC.basis);
        if(x2 != null) all.push(x2);
      });
      var avg = all.length ? all.reduce(function(a, b){ return a + b; }, 0) / all.length : 0;

      g.fillStyle = '#fdf8f3'; g.fillRect(pad, y, W - pad * 2, 34);
      g.fillStyle = '#57534e'; f(14, true);
      g.fillText(sub.name + (sub.graded && SC.basis === 'graded' ? '（赋分）' : ''), pad + 12, y + 23);

      var barX = pad + 190, barW = W - pad * 2 - 190 - 170;
      g.fillStyle = '#f0e7de'; g.fillRect(barX, y + 8, barW, 8);
      if(v != null && sub.full){
        g.fillStyle = '#b06a32';
        g.fillRect(barX, y + 8, barW * Math.min(1, v / sub.full), 8);
      }

      g.fillStyle = '#292524'; f(15, true); g.textAlign = 'right';
      g.fillText(v == null ? '未考' : (fmtNum(v) + ' / ' + sub.full), W - pad - 118, y + 23);
      g.fillStyle = (v != null && v - avg >= 0) ? '#0b7a43' : '#c0392b'; f(12);
      g.fillText(v == null ? '' : ((v - avg >= 0 ? '+' : '−') + fmtNum(Math.abs(v - avg))), W - pad - 14, y + 23);
      g.textAlign = 'left';

      y += S.subRow;
    });
  }

  /* ⑤ 单科排名（v2.9.8）—— 光看分数看不出「这科在班里什么位置」 */
  if(opt.subrank && subs.length){
    y += S.rankGap;
    g.fillStyle = '#57534e'; f(15, true); g.fillText('单科排名', pad, y);
    y += S.rankTitle;
    subs.forEach(function(sub){
      var info = rk.subj[sub.key] || {};
      var mySr = (info.rank || {})[meRow.id];
      var cnt = info.count || 0;
      g.fillStyle = '#fdf8f3'; g.fillRect(pad, y, W - pad * 2, 28);
      g.fillStyle = '#57534e'; f(13, true); g.fillText(sub.name, pad + 12, y + 19);

      var bx = pad + 110, bw = W - pad * 2 - 110 - 160;
      g.fillStyle = '#f0e7de'; g.fillRect(bx, y + 10, bw, 8);
      if(mySr && cnt){
        /* 名次越前条越长：第 1 名满格，最后一名也有个可见的短头 */
        var frac = Math.max(0.06, 1 - (mySr - 1) / cnt);
        g.fillStyle = '#b06a32'; g.fillRect(bx, y + 10, bw * frac, 8);
      }
      g.fillStyle = '#292524'; f(13, true); g.textAlign = 'right';
      g.fillText(mySr ? ('第 ' + mySr + ' 名 / ' + cnt + ' 人') : '未考', W - pad - 12, y + 19);
      g.textAlign = 'left';
      y += S.rankRow;
    });
  }

  /* ⑥ 偏科分析（v2.9.8）—— 站主原话「哪一科弱哪一科怎么样」 */
  if(opt.diag && subs.length){
    y += S.diagGap;
    g.fillStyle = '#57534e'; f(15, true); g.fillText('偏科分析', pad, y);
    y += S.diagTitle;

    var dAvg = scSubjAvg();
    var diffs = subs.map(function(sub){
      var v = scSubScore(meRow, sub, SC.basis);
      var a = dAvg[sub.key];
      return { name: sub.name, diff: (v != null && a != null) ? v - a : null };
    });
    var maxAbs = 1;
    diffs.forEach(function(d){ if(d.diff != null) maxAbs = Math.max(maxAbs, Math.abs(d.diff)); });

    var bx2 = pad + 100, bw2 = 300, mid = bx2 + bw2 / 2;
    diffs.forEach(function(d){
      g.fillStyle = '#57534e'; f(13, true); g.fillText(d.name, pad + 12, y + 19);
      /* 中间那条竖线＝班均，往右是高于、往左是低于 */
      g.fillStyle = '#e2d5c8'; g.fillRect(mid - 0.5, y + 6, 1, 15);
      if(d.diff != null){
        var len = Math.max(2, Math.abs(d.diff) / maxAbs * (bw2 / 2 - 6));
        g.fillStyle = d.diff >= 0 ? '#0b7a43' : '#c0392b';
        if(d.diff >= 0) g.fillRect(mid, y + 10, len, 11);
        else g.fillRect(mid - len, y + 10, len, 11);
      }
      g.fillStyle = (d.diff != null && d.diff >= 0) ? '#0b7a43' : '#c0392b'; f(13, true);
      g.textAlign = 'right';
      g.fillText(d.diff == null ? '未考'
        : ((d.diff >= 0 ? '高于班均 ' : '低于班均 ') + fmtNum(Math.abs(d.diff)) + ' 分'), W - pad - 12, y + 19);
      g.textAlign = 'left';
      y += S.diagRow;
    });

    /* 结论：点名最弱与最强。未考的科不参与，避免「未考」被当成最弱 */
    var scored = diffs.filter(function(d){ return d.diff != null; });
    var say = function(d){
      return d.diff >= 0 ? '高于班均 ' + fmtNum(d.diff) + ' 分'
                         : '低于班均 ' + fmtNum(Math.abs(d.diff)) + ' 分';
    };
    var tips;
    if(scored.length){
      var worst = scored.slice().sort(function(a, b){ return a.diff - b.diff; })[0];
      var best = scored.slice().sort(function(a, b){ return b.diff - a.diff; })[0];
      tips = '最弱：' + worst.name + '（' + say(worst) + '）';
      if(best.name !== worst.name) tips += '　·　最强：' + best.name + '（' + say(best) + '）';
    } else {
      tips = '这次没有可比对的单科成绩。';
    }
    g.fillStyle = '#292524'; f(13, true); g.fillText(tips, pad + 12, y + 22);
    y += S.diagFoot;
  }

  /* ⑦ 年级位置条（v2.9.8）—— 名次换算成百分位，比裸数字好懂 */
  if(opt.rankbar && hasBar){
    y += S.barGap;
    g.fillStyle = '#57534e'; f(15, true); g.fillText('年级位置', pad, y);
    y += S.barTitle;
    var trackW = W - pad * 2;
    g.fillStyle = '#f0e7de'; g.fillRect(pad, y + 4, trackW, 16);
    g.fillStyle = '#b06a32';
    g.fillRect(pad, y + 4, Math.max(10, trackW * (1 - (meRow.schoolRank - 1) / gradeN)), 16);
    g.fillStyle = '#c2410c'; f(14, true);
    g.fillText('年级第 ' + meRow.schoolRank + ' 名 / ' + gradeN + ' 人（物理方向）　·　前 '
      + (meRow.schoolRank / gradeN * 100).toFixed(1) + '%', pad, y + 46);
    y += S.barBox;
  }

  /* ⑧ 历次趋势（v2.9.8）—— 总分折线，每点标分数 */
  if(opt.trend && series.length >= 2){
    y += S.trendGap;
    g.fillStyle = '#57534e'; f(15, true); g.fillText('历次趋势（总分）', pad, y);
    y += S.trendTitle;

    var boxW = W - pad * 2;
    var boxH = S.trendBox - 34;                 /* 底部留一行日期 */
    var vs = series.map(function(p){ return p.v; });
    var lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs);
    var span = (hi - lo) || 1;
    var xOf = function(i){ return pad + i * boxW / (series.length - 1); };
    var yOf = function(v){ return y + boxH - (v - lo) / span * boxH; };

    g.fillStyle = '#fdfbf9'; g.fillRect(pad, y, boxW, boxH + 8);
    g.strokeStyle = '#f0e7de'; g.lineWidth = 1;
    [0, 0.5, 1].forEach(function(t){
      var yy = y + boxH * t;
      g.beginPath(); g.moveTo(pad, yy); g.lineTo(pad + boxW, yy); g.stroke();
    });

    g.strokeStyle = '#c2410c'; g.lineWidth = 2;
    g.beginPath();
    series.forEach(function(p, i){
      if(i === 0) g.moveTo(xOf(i), yOf(p.v)); else g.lineTo(xOf(i), yOf(p.v));
    });
    g.stroke();

    series.forEach(function(p, i){
      var px = xOf(i), py = yOf(p.v);
      g.fillStyle = '#fff'; g.beginPath(); g.arc(px, py, 4.5, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#c2410c'; g.lineWidth = 2; g.stroke();
      g.fillStyle = '#292524'; f(12, true); g.textAlign = 'center';
      g.fillText(String(fmtNum(p.v)), px, py - 10);
      /* 只标首尾日期：点多的时候全标会糊成一团 */
      if(i === 0 || i === series.length - 1){
        g.fillStyle = '#7a6a5c'; f(11);
        g.textAlign = i === 0 ? 'left' : 'right';
        g.fillText(p.date ? p.date.slice(5) : p.name, i === 0 ? pad : pad + boxW, y + boxH + 24);
      }
      g.textAlign = 'left';
    });
    y += S.trendBox;
  }

  /* ⑨ 上线情况（原来这里把同一句文字画了两遍，位置还不一样 —— 一并修掉） */
  if(cuts.length){
    y += S.cutGap;
    g.fillStyle = '#57534e'; f(15, true); g.fillText('上线情况', pad, y);
    cuts.forEach(function(c){
      y += S.cutRow;
      var ok = myTotal != null && myTotal >= c.score;
      g.fillStyle = c.color || '#b45309';
      g.beginPath(); g.arc(pad + 6, y - 5, 5, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#57534e'; f(14);
      g.fillText(c.label + '　' + fmtNum(c.score) + ' 分', pad + 20, y);
      g.fillStyle = ok ? '#0b7a43' : '#c0392b'; f(14, true); g.textAlign = 'right';
      g.fillText(myTotal == null ? '' : (ok ? '已超 ' + fmtNum(myTotal - c.score) + ' 分'
                                            : '还差 ' + fmtNum(c.score - myTotal) + ' 分'), W - pad, y);
      g.textAlign = 'left';
    });
  }

  /* v3.6.1：备注块（在页脚上方） */
  if(noteLines){
    var nTop = H - 26 - 12 - noteLines * 22;
    g.fillStyle = '#fdf6ee';
    g.fillRect(pad, nTop - 10, W - pad * 2, noteLines * 22 + 16);
    g.fillStyle = '#8a5a3b'; f(12, true);
    g.fillText('备注', pad + 12, nTop + 2);
    g.fillStyle = '#57534e'; f(14);
    for(var ni = 0; ni < noteLines; ni++){
      g.fillText(note.slice(ni * 34, (ni + 1) * 34), pad + 52, nTop + 2 + ni * 22);
    }
  }

  /* v3.6.1：班徽（右上角，取不到就跳过） */
  if(badge && badge.img){
    try{
      var bs = 66, bx = W - pad - bs, by = 18, br = 16;
      g.save();
      g.beginPath();
      g.moveTo(bx + br, by);
      g.arcTo(bx + bs, by, bx + bs, by + bs, br);
      g.arcTo(bx + bs, by + bs, bx, by + bs, br);
      g.arcTo(bx, by + bs, bx, by, br);
      g.arcTo(bx, by, bx + bs, by, br);
      g.closePath();
      g.clip();
      g.drawImage(badge.img, bx, by, bs, bs);
      g.restore();
    }catch(e){}
  }

  /* 页脚水印 */
  y = H - 26;
  g.fillStyle = '#7a6a5c'; f(11);
  g.fillText('本班内部数据 · 请勿外传　|　导出于 ' + new Date().toLocaleDateString('zh-CN'), pad, y);
  g.textAlign = 'right';
  g.fillText('班级站点 · 成绩分析', W - pad, y);
  g.textAlign = 'left';

  var fileName = SC.exam.name + '-' + meRow.name + '-成绩卡.png';

  /* 存成本地文件（桌面浏览器走这条路） */
  function scSaveBlob(blob){
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(url); if(a.parentNode) a.parentNode.removeChild(a); }, 1500);
  }

  /* 手机上优先走系统分享面板（可以直接发微信）；
     系统不支持、或被拒时，自动退回下载。 */
  function scEmit(blob){
    try{
      if(window.File && navigator.canShare){
        var file = new File([blob], fileName, { type: 'image/png' });
        if(navigator.canShare({ files: [file] })){
          navigator.share({ files: [file], title: '我的成绩卡' }).catch(function(){ scSaveBlob(blob); });
          return;
        }
      }
    }catch(e){}
    scSaveBlob(blob);
  }

  if(cv.toBlob){
    cv.toBlob(scEmit, 'image/png');
  } else {
    /* 老浏览器没有 toBlob，退回 dataURL 下载 */
    var a2 = document.createElement('a');
    a2.href = cv.toDataURL('image/png'); a2.download = fileName;
    document.body.appendChild(a2); a2.click();
    setTimeout(function(){ if(a2.parentNode) a2.parentNode.removeChild(a2); }, 1500);
  }
}

/* ---------- 分享链接（R38）：免登录只读 ---------- */
/* v3.1.1：分享弹窗里的 DOM 查询必须「只在自己这层弹窗里找」。
   原来用 document.getElementById —— 点「编辑」时会再叠一层新弹窗，
   getElementById 命中的却是**下面那层旧弹窗**的 select（id 重复），
   于是保存时发出去的是旧范围，看着就是「编辑分享保存无效」。 */
function scShRoot(){
  var all = document.querySelectorAll('#scShMask');
  return all.length ? all[all.length - 1] : null;
}
function scShEl(id){
  var r = scShRoot();
  return (r && r.querySelector('#' + id)) || document.getElementById(id);
}
function scShAll(sel){
  var r = scShRoot();
  return (r || document).querySelectorAll(sel);
}

function scShareDialog(edit){
  scShareClose();   /* 先清掉旧弹窗，保证 id 唯一、表单不会读到上一层 */
  var editId = edit ? Number(edit.id) : 0;
  var cfg = SC.config || {};
  var isAdmin = scIsAdmin();
  var allow = isAdmin ? 'all' : (cfg.shareByStudent || 'none');
  if(allow === 'none'){ alert('老师还没有开放分享功能。'); return; }

  var chosenEx = (edit && (edit.examIds || []).length) ? edit.examIds.map(Number) : null;
  var exOpts = SC.exams.map(function(e, i){
    var ck = (!chosenEx || chosenEx.indexOf(Number(e.id)) >= 0) ? ' checked' : '';
    return '<label class="sc-sh-ex"><input type="checkbox" value="' + e.id + '"' + ck + '> '
      + esc(e.name) + ' <span class="sc-dim">' + esc(scDateRange(e)) + '</span></label>';
  }).join('');

  var scSel = function(v){ return (edit && edit.scope === v) ? ' selected' : ''; };
  var scopeSel = '<select id="shScope" class="sc-sel">'
    + '<option value="self"' + scSel('self') + '>只分享我的成绩</option>'
    + (allow === 'all' ? '<option value="class"' + scSel('class') + '>全班成绩</option>' : '')
    + (allow === 'all' && isAdmin ? '<option value="picked"' + scSel('picked') + '>我挑几位同学</option>' : '')
    + '</select>';

  var html = '<div class="allboard-mask show" id="scShMask"><div class="allboard-box sc-box" style="max-width:600px">'
    + '<div class="allboard-head"><span>' + (edit ? '编辑分享' : '分享成绩') + '</span><button onclick="scShareClose()">关闭</button></div>'
    + '<div class="sc-pane" style="max-height:70vh">'
    +   '<div class="sc-hint">生成一个<b>免登录、只读</b>的链接。<br>'
    +     '<b>谁拿到链接谁就能看，转发出去我控制不了</b> —— 所以默认只给 7 天，随时可以撤销。</div>'
    +   '<div class="field" style="margin-bottom:12px"><label class="sc-sh-lb">分享范围</label>'
    +     scopeSel + '</div>'
    /* v3.8.0（站主）：备注 —— 建了很多条之后，靠它认出「这条是给谁的」 */
    +   '<div class="field" style="margin-bottom:12px"><label class="sc-sh-lb">备注（方便自己认）</label>'
    +     '<input id="shNote" class="sc-sel" maxlength="40" autocomplete="off"'
    +       ' placeholder="例如：10 月月考 · 给爸妈看的"'
    +       ' value="' + attr((edit && edit.note) || '') + '">'
    +     '<div class="sc-dim" style="margin-top:4px;font-size:.74rem">只有你自己看得到，会显示在「我建过的分享」列表里</div>'
    +   '</div>'
    +   '<div id="shNamesWrap" style="display:none;margin-bottom:12px">'
    +     '<label class="sc-sh-lb">挑同学（点一下选中）</label>'
    +     '<div id="shNames" class="sc-sh-names">'
    +       SC.rows.map(function(r){
              var on = (edit && (edit.names || []).indexOf(r.name) >= 0) ? ' on' : '';
              return '<button type="button" class="sc-sh-n' + on + '" data-n="' + esc(r.name) + '">' + esc(r.name) + '</button>';
            }).join('')
    +     '</div></div>'
    +   '<div style="margin-bottom:12px"><label class="sc-sh-lb">分享哪些内容</label>'
    +     '<div class="sc-sh-secs">'
    +       '<label class="sc-sh-sec"><input type="checkbox" data-sec="board" checked>'
    +         '<span class="t">成绩单（全班／选中同学）<span class="s">班级统计、名次表、上线情况 —— <b>看好几个人时用这个</b></span></span></label>'
    +       '<label class="sc-sh-sec"><input type="checkbox" data-sec="card" checked>'
    +         '<span class="t">个人成绩卡<span class="s">总分、班排名、年级排名、与班均、各科明细 —— <b>分享自己时用这个</b></span></span></label>'
    +       '<div class="sc-sh-tip" id="shSecTip"></div>'
    +     '</div>'
    /* v3.5.12 #7：细项。跟着上面两个总开关走 —— 总开关没勾，细项就置灰 */
    +     '<div id="shFine" style="margin-top:10px">'
    +       '<div class="sc-pk-group-h" data-fineg="board">成绩单里包含<span class="sc-dim">取消勾选的不会出现</span></div>'
    +       '<div class="sc-fine-row" data-fineg="board">'
    +         '<label class="sc-fine"><input type="checkbox" data-sec2="avg" checked> 班均 / 中位数 / 最高</label>'
    +         '<label class="sc-fine"><input type="checkbox" data-sec2="table" checked> 全班名次表</label>'
    +         '<label class="sc-fine"><input type="checkbox" data-sec2="cut" checked> 上线情况</label>'
    +       '</div>'
    +       '<div class="sc-pk-group-h" data-fineg="card">个人成绩卡里包含<span class="sc-dim">取消勾选的不会出现</span></div>'
    +       '<div class="sc-fine-row" data-fineg="card">'
    +         '<label class="sc-fine"><input type="checkbox" data-sec2="trend" checked> 历史总分趋势</label>'
    +         '<label class="sc-fine"><input type="checkbox" data-sec2="prog" checked> 各科进退步</label>'
    +         '<label class="sc-fine"><input type="checkbox" data-sec2="rankchg" checked> 年级排名变化</label>'
    +       '</div>'
    +     '</div>'
    +   '</div>'
    +   '<div style="margin-bottom:12px"><label class="sc-sh-lb">包含哪几次考试</label>'
    +     '<div class="sc-sh-exs">' + exOpts + '</div></div>'
    +   '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">'
    +     '<div style="flex:1;min-width:150px"><label class="sc-sh-lb">有效期</label>'
    +       '<select id="shDays" class="sc-sel">'
    +         (edit ? '<option value="keep" selected>保持当前有效期</option>' : '')
    +         '<option value="1">1 天</option><option value="7"' + (edit ? '' : ' selected') + '>7 天</option>'
    +         '<option value="30">30 天</option><option value="0">永久</option>'
    +       '</select></div>'
    +     '<div style="flex:1;min-width:150px"><label class="sc-sh-lb">最多被打开（可空）</label>'
    +       '<input id="shMax" type="number" min="1" class="sc-sel" placeholder="不填＝不限" value="' + ((edit && edit.maxViews) ? edit.maxViews : '') + '"></div>'
    +   '</div>'
    +   '<button class="btn" id="shGo" style="width:100%">' + (edit ? '保存修改' : '生成链接') + '</button>'
    +   '<div id="shOut" style="margin-top:14px"></div>'
    +   '<div id="shList" style="margin-top:18px"></div>'
    + '</div></div></div>';

  var wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstChild);

  var mask = document.getElementById('scShMask');

  /* 智能默认（v2.9.8）：勾哪个应该跟着「分享范围」走。
     分享自己 → 只勾「个人成绩卡」（成绩单只有你一行，还跟卡片内容重复）；
     分享全班 / 自选 → 只勾「成绩单」。
     站主反馈「勾了那两个勾看不出区别」—— 除了页面里去掉重复，
     默认值也得跟着范围变，不然一打开两个勾都亮着，谁也看不出所以然。 */
  /* 只选分享弹窗里的两个勾。原来写 [data-sec] 会把「外观/排序/动效/数据」四个
     设置页签按钮也一起选进来（同属性名），既没意义又会串味。 */
  var secBoxes = scShAll('.sc-sh-sec input[data-sec]');
  var setSec = function(board, card){
    Array.prototype.forEach.call(secBoxes, function(cb){
      cb.checked = (cb.getAttribute('data-sec') === 'board') ? !!board : !!card;
    });
  };
  var applyDefaults = function(scope){
    if(scope === 'self') setSec(false, true);
    else setSec(true, false);
    var el = scShEl('shSecTip');
    if(el){
      el.innerHTML = scope === 'self'
        ? '范围是「只分享我的成绩」，已默认只勾<b>个人成绩卡</b> —— 对方看到的是完整一张卡（总分、排名、各科明细）。'
        : '对方看到的是<b>名次表</b>。若最终只有 1 个人，页面会自动改用成绩卡（表格只有一行，不如卡片）。';
    }
  };
  var pickScope = function(){
    var v = scShEl('shScope').value;
    scShEl('shNamesWrap').style.display = (v === 'picked') ? 'block' : 'none';
    /* 编辑已有分享时**不要**重置勾选：你已经勾好的「成绩单 / 个人成绩卡」
       不能因为切一下范围就被默认值冲掉（那也是「改完没生效」的一半原因）。 */
    if(edit){
      var tip1 = scShEl('shSecTip');
      if(tip1) tip1.innerHTML = '改完点<b>保存修改</b>：链接不变，之前发出去的照旧能打开。';
      return;
    }
    applyDefaults(v);
  };
  scShEl('shScope').onchange = pickScope;
  if(edit){
    setSec(edit.sections ? edit.sections.board !== false : true, edit.sections ? edit.sections.card !== false : true);
    /* v3.5.12 #7：回填细项（老分享没有子键 → 全勾） */
    var esec = edit.sections || {};
    Array.prototype.forEach.call(scShAll('[data-sec2]'), function(cb){
      var k = cb.getAttribute('data-sec2');
      cb.checked = (esec[k] !== false);
    });
    /* 「自选同学」的分享在编辑时把名单展开，之前是 display:none 等于藏起来 */
    scShEl('shNamesWrap').style.display = (edit.scope === 'picked') ? 'block' : 'none';
    var tip0 = scShEl('shSecTip');
    if(tip0) tip0.innerHTML = '这是<b>修改已有分享</b>：保存后<b>链接不变</b>，之前发出去的照旧能打开。';
  } else {
    applyDefaults(scShEl('shScope').value);
  }
  Array.prototype.forEach.call(scShAll('.sc-sh-n'), function(b){
    b.onclick = function(){ b.classList.toggle('on'); };
  });
  /* v3.5.12 #7：总开关关掉时，对应细项整组置灰（不然勾了也没用，容易误会） */
  var syncFine = function(){
    Array.prototype.forEach.call(scShAll('.sc-sh-sec input[data-sec]'), function(cb){
      var g = cb.getAttribute('data-sec');
      var on = !!cb.checked;
      Array.prototype.forEach.call(scShAll('[data-fineg="' + g + '"]'), function(el){
        el.style.opacity = on ? '' : '.45';
        el.style.pointerEvents = on ? '' : 'none';
      });
    });
  };
  Array.prototype.forEach.call(scShAll('.sc-sh-sec input[data-sec]'), function(cb){
    cb.onchange = syncFine;
  });
  syncFine();
  scShEl('shGo').onclick = function(){ scShareCreate(editId); };
  mask.addEventListener('click', function(e){ if(e.target === mask) scShareClose(); });
  scShareList();
}

function scShareClose(){
  /* 可能同时开着两层（从「我建过的分享」点编辑时会再开一层），全部关掉 */
  var all = document.querySelectorAll('#scShMask');
  for(var i = 0; i < all.length; i++){
    if(all[i].parentNode) all[i].parentNode.removeChild(all[i]);
  }
}

function scShareCreate(editId){
  var btn = scShEl('shGo');
  var ids = [];
  Array.prototype.forEach.call(scShAll('.sc-sh-ex'), function(l){
    var cb = l.querySelector('input');
    if(cb && cb.checked) ids.push(Number(cb.value));
  });
  var names = [];
  Array.prototype.forEach.call(scShAll('.sc-sh-n.on'), function(b){
    names.push(b.getAttribute('data-n'));
  });
  var scope = scShEl('shScope').value;
  if(scope === 'picked' && !names.length){ alert('至少挑一位同学'); return; }

  /* 分享哪些内容：至少留一项，否则对方点开是空白页 */
  var sections = { board: false, card: false };
  Array.prototype.forEach.call(scShAll('.sc-sh-sec input[data-sec]'), function(cb){
    var k = cb.getAttribute('data-sec');
    if(k === 'board' || k === 'card') sections[k] = !!cb.checked;
  });
  /* v3.5.12 #7 细项：只在总开关打开时生效，关着的项一律记 false */
  Array.prototype.forEach.call(scShAll('[data-sec2]'), function(cb){
    var k = cb.getAttribute('data-sec2');
    var grp = (k === 'avg' || k === 'table' || k === 'cut') ? 'board' : 'card';
    sections[k] = sections[grp] ? !!cb.checked : false;
  });
  if(!sections.board && !sections.card){ alert('至少要勾一项分享内容，不然对方点开是空的。'); return; }
  /* 总开关开了但细项全关 → 那一块等于空的，提醒一下（不拦，让人自己决定） */
  var fine = function(g, keys){
    return sections[g] && keys.every(function(k){ return sections[k] === false; });
  };
  if(fine('board', ['avg', 'table', 'cut']) || fine('card', ['trend', 'prog', 'rankchg'])){
    if(!confirm('有一类内容的所有细项都被你取消了，对方打开时那一块会是空的。\n确定就这样生成吗？')) return;
  }

  var maxV = scShEl('shMax').value;
  var daysVal = scShEl('shDays').value;
  var isEdit = !!editId;
  var noteEl = scShEl('shNote');
  var req = {
    scope: scope,
    examIds: ids,
    names: names,
    sections: sections,
    note: noteEl ? String(noteEl.value || '').trim().slice(0, 40) : '',
    days: (daysVal === 'keep' ? 'keep' : Number(daysVal)),
    maxViews: maxV ? Number(maxV) : null,
  };
  if(isEdit) req.id = editId;

  btn.disabled = true; btn.textContent = isEdit ? '正在保存…' : '正在生成…';
  api('/scores?action=' + (isEdit ? 'share-update' : 'share-create'), { method: 'POST', body: req })
    .then(function(j){
      btn.disabled = false; btn.textContent = isEdit ? '保存修改' : '生成链接';
      if(!j || !j.ok){ alert((isEdit ? '保存失败：' : '生成失败：') + ((j && j.error) || '未知错误')); return; }
      if(isEdit){
        /* 改的是同一条分享，token 不变 —— 不用重新发链接 */
        scShEl('shOut').innerHTML =
          '<div class="sc-hint sc-hint-ok"><b>已保存修改。</b>链接不变，之前发出去的照旧能打开。</div>';
        scShareList();
        return;
      }
      /* ⚠️ 别用 location.origin + j.url —— 站点挂在子目录下会丢前缀 → 404。
         把后端给的「站点根路径」转成相对当前页面再解析，任何部署位置都对。 */
      var url = new URL(String(j.url || '').replace(/^\/+/, ''), location.href).href;
      var newToken = String(j.token || (url.split('t=')[1] || ''));
      scShEl('shOut').innerHTML =
          '<div class="sc-hint sc-hint-ok">'
        + '<b>链接已生成。</b>把它发给要看的人就行 —— 对方不用登录。</div>'
        + '<div class="sc-sh-url"><input id="shUrl" readonly value="' + esc(url) + '">'
        + '<button class="btn btn-sm" id="shCopy">复制</button>'
        + '<button class="btn btn-sm btn-secondary" id="shPv">预览</button>'
        + '</div>';
      /* v3.5.12 #9：生成完直接能看到对方打开的样子 */
      var pv = scShEl('shPv');
      if(pv) pv.onclick = function(){
        if(newToken) scSharePreview(newToken);
        else window.open(url, '_blank', 'noopener');
      };
      scShEl('shCopy').onclick = function(){
        var inp = scShEl('shUrl');
        inp.select();
        try{
          if(navigator.clipboard && navigator.clipboard.writeText){
            navigator.clipboard.writeText(inp.value).then(function(){ btn.textContent = '已复制'; setTimeout(function(){ btn.textContent = '生成链接'; }, 1200); });
          } else { document.execCommand('copy'); }
        }catch(e){ document.execCommand('copy'); }
        alert('链接已复制：\n' + inp.value);
      };
      scShareList();
    }).catch(function(e){
      btn.disabled = false; btn.textContent = isEdit ? '保存修改' : '生成链接';
      alert((isEdit ? '保存失败：' : '生成失败：') + (e.message || e));
    });
}

function scShareList(){
  api('/scores?action=share-list', { method: 'POST' }).then(function(j){
    var box = scShEl('shList');
    if(!box || !j || !j.ok) return;
    var list = j.shares || [];
    if(!list.length){ box.innerHTML = ''; return; }
    box.innerHTML = '<div class="sc-card-h">我建过的分享<span class="sc-dim" style="font-weight:400;margin-left:6px">共 ' + list.length + ' 条</span></div>'
      + '<div class="sc-sh-list">' + list.slice(0, 8).map(function(x){
          var state = x.revoked ? '已撤销' : x.expired ? '已过期' : x.usedUp ? '次数用完' : '有效';
          var scopeTxt = x.scope === 'self' ? '我' : x.scope === 'picked' ? '自选 ' + (x.names || []).length + ' 人' : '全班';
          /* v3.8.0：有备注就把它当标题（自己认得出是哪条），范围退成次要信息 */
          var title = x.note ? x.note : scopeTxt;
          return '<div class="sc-sh-item">'
            + '<div class="sc-sh-top">'
            +   '<span class="sc-sh-state' + (x.alive ? ' on' : '') + '">' + state + '</span>'
            +   '<b title="' + esc(title) + '">' + esc(title) + '</b>'
            +   (x.note ? '<span class="sc-dim">' + esc(scopeTxt) + '</span>' : '')
            +   '<span class="sc-dim">看过 ' + x.views + ' 次' + (x.maxViews ? ' / ' + x.maxViews : '') + '</span>'
            + '</div>'
            + (x.alive
                ? '<div class="sc-sh-btns">'
                  + '<button class="btn btn-sm btn-secondary" data-view="' + x.id + '" data-token="' + esc(x.token || '') + '">预览</button>'
                  + '<button class="btn btn-sm btn-secondary" data-edit="' + x.id + '">编辑</button>'
                  + '<button class="btn btn-sm btn-secondary" data-rev="' + x.id + '">撤销</button>'
                  + '</div>'
                : '')
            + '</div>';
        }).join('') + '</div>';
    /* v3.5.12 #9：预览 —— 就是真的打开那条分享链接，站内全屏弹窗打开，
       看到的样子和同学点开完全一致（不能展示的本来就被后端裁掉了）。 */
    Array.prototype.forEach.call(box.querySelectorAll('[data-view]'), function(b){
      b.onclick = function(){
        var tk = b.getAttribute('data-token');
        if(!tk){ alert('这条分享没有拿到预览标识，请刷新列表后重试。'); return; }
        scSharePreview(tk);
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-edit]'), function(b){
      b.onclick = function(){
        var id = Number(b.getAttribute('data-edit'));
        var sh = null;
        for(var i = 0; i < list.length; i++){ if(Number(list[i].id) === id){ sh = list[i]; break; } }
        if(sh) scShareDialog(sh);
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-rev]'), function(b){
      b.onclick = function(){
        if(!confirm('撤销后这个链接立刻失效，确定吗？')) return;
        api('/scores?action=share-revoke', { method: 'POST', body: { id: Number(b.getAttribute('data-rev')) } })
          .then(function(){ scShareList(); });
      };
    });
  }).catch(function(){});
}

/* ---------- 分享页预览（v3.5.12 #9） ----------
 * 站主要求：「分享页可以预览，页面设计和网站内部的一样，相当于把不能展示的东西隐藏了」
 *
 * 做法：**不另写一套预览渲染** —— 直接用 iframe 打开真实的 share.html?t=xxx。
 * 好处是所见即所得：预览就是同学点开看到的那一页，后端裁到什么样，
 * 预览就什么样（分享自己时只有一行、班均仍是全班口径、名次按全班算）。
 * 另写一套「模拟」迟早会和真页面走样，那才是预览最大的坑。
 */
function scSharePreview(tk){
  var url = new URL('share.html?t=' + encodeURIComponent(tk), location.href).href;
  var mask = document.createElement('div');
  mask.className = 'allboard-mask show';
  mask.id = 'scShPvMask';
  mask.innerHTML = '<div class="allboard-box sc-box" style="max-width:520px;width:96vw">'
    + '<div class="allboard-head"><span>分享页预览</span>'
    +   '<span style="display:flex;gap:8px">'
    +     '<a class="btn btn-sm btn-secondary" href="' + attr(url) + '" target="_blank" rel="noopener">新窗口打开</a>'
    +     '<button onclick="scSharePreviewClose()">关闭</button>'
    +   '</span></div>'
    + '<div style="background:#f4efe9;padding:10px">'
    +   '<div style="background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e6ddd4">'
    +     '<iframe src="' + attr(url) + '" style="width:100%;height:66vh;border:0;display:block" '
    +       'sandbox="allow-scripts allow-same-origin allow-popups"></iframe>'
    +   '</div>'
    + '</div>'
    + '<div class="sc-pane" style="padding:10px 14px 14px">'
    +   '<p class="sc-figcap" style="margin:0">'
    +     '这就是同学点开链接后看到的样子 —— <b>不能展示的内容后端原本就不会下发</b>，'
    +     '所以预览里没有的，别人也看不到。手机上看效果更像，可以点「新窗口打开」再缩窄窗口或用手机打开。</p>'
    + '</div></div>';
  document.body.appendChild(mask);
  mask.addEventListener('click', function(e){ if(e.target === mask) scSharePreviewClose(); });
}
function scSharePreviewClose(){
  var m = document.getElementById('scShPvMask');
  if(m && m.parentNode) m.parentNode.removeChild(m);
}

/* ---------- A4 打印（@media print 见样式表） ----------
 * v3.5.12（站主 2026-10-17 #7）：
 *   打印前先弹「要印哪些内容」，三类内容逐项勾选，支持全选 / 反选 / 按类型一键全勾。
 *   没勾的块加 .print-hide 类，@media print 里 display:none —— 不占纸面、不留白条。
 *   常用组合也记住了，下次打开还是上次那套。
 */
var SC_PRINT_KEYS = 'cls_sc_print_keys';

/** 三类内容的分组定义。sel = 该块在 DOM 里的选择器（用于加 print-hide） */
function scContentGroups(){
  var cuts = (SC.exam && SC.exam.cutlines || []).filter(function(c){ return c.score != null; });
  var subs = (SC.exam && SC.exam.subjects) || [];
  return [
    {
      id: 'board', name: '全班成绩单', desc: '整班的名次表与统计',
      items: [
        { key: 'board_avg',     name: '班均分 / 中位数', desc: '班级总体水平' },
        { key: 'board_dist',    name: '总分分布',        desc: '各分数段人数分布图' },
        { key: 'board_cut',     name: '上线情况',        desc: '特控线 / 本科线过了多少人', dis: !cuts.length, disMsg: '这场没有录入分数线' },
        { key: 'board_band',    name: '分数段分布',      desc: '按分档列出名单' },
        { key: 'board_extreme', name: '本次最值',        desc: '最高分 / 最低分 / 进步最大' },
        { key: 'board_table',   name: '全班名次表',      desc: '一行一人，含各科分数' },
      ],
    },
    {
      id: 'me', name: '我的画像', desc: '只关于你自己',
      items: [
        { key: 'me_card',    name: '成绩单',        desc: '总分、排名、与班均差' },
        { key: 'me_cut',     name: '上线情况',      desc: '你离各条线还差多少', dis: !cuts.length, disMsg: '这场没有录入分数线' },
        { key: 'me_pos',     name: '我在班里的位置', desc: '位置条 / 四象限' },
        { key: 'me_subj',    name: '各科情况',      desc: '每科分数、得分率、与班均差' },
        { key: 'me_heat',    name: '学生 × 科目热力图', desc: '全班逐科颜色图（含你自己）' },
        { key: 'me_ai',      name: 'AI 分析',       desc: '本地规则生成的文字结论' },
      ],
    },
    {
      id: 'pk', name: '成绩对比', desc: '两位同学并排比',
      items: [
        { key: 'pk_total',  name: '总分对比',       desc: '两根柱 + 班均参考线' },
        { key: 'pk_both',   name: '两场总分并列',   desc: '选了第二场才有（含赋分前后）', dis: SC.pkExam2 == null, disMsg: '还没选「对比另一场」' },
        { key: 'pk_subj',   name: '各科对比',       desc: '每科两根柱与分差' },
        { key: 'pk_trend',  name: '跨考试进退步',   desc: '两场逐项对照表', dis: SC.pkExam2 == null, disMsg: '还没选「对比另一场」' },
        { key: 'pk_ai',     name: 'AI 对比分析',    desc: '差距在哪 + 各自该怎么补' },
      ],
    },
  ];
}

/** 读取记住的勾选状态（默认全勾） */
function scPrintState(){
  var st = {};
  scContentGroups().forEach(function(g){
    g.items.forEach(function(it){ st[it.key] = !it.dis; });
  });
  try{
    var raw = JSON.parse(localStorage.getItem(SC_PRINT_KEYS) || 'null');
    if(raw && typeof raw === 'object'){
      Object.keys(st).forEach(function(k){
        if(typeof raw[k] === 'boolean') st[k] = raw[k];
      });
    }
  }catch(e){}
  return st;
}
function scPrintSave(st){
  try{ localStorage.setItem(SC_PRINT_KEYS, JSON.stringify(st)); }catch(e){}
}

/**
 * 把状态应用到 DOM：没勾的块加 .print-hide。
 * v3.5.12：改用统一的 `data-scblk="键名"` 标记（比靠一堆语义类名稳，
 * 以后加卡片只要加属性，不用改这里）。
 */
function scApplyPrintState(st){
  Array.prototype.forEach.call(document.querySelectorAll('[data-scblk]'), function(el){
    var k = el.getAttribute('data-scblk');
    if(!k) return;
    var on = (st[k] === undefined) ? true : !!st[k];
    el.classList.toggle('print-hide', !on);
  });
}

/** 打印前弹选择框 */
function scPrint(){
  var st = scPrintState();
  var groups = scContentGroups();

  function itemHtml(it){
    var on = it.dis ? false : !!st[it.key];
    return '<label class="sc-ex-row' + (it.dis ? ' off' : '') + '" data-pk="' + it.key + '" data-g="' + it.key.split('_')[0] + '">'
      + '<input type="checkbox" data-print="' + it.key + '"' + (on ? ' checked' : '') + (it.dis ? ' disabled' : '') + '>'
      + '<span class="t">' + esc(it.name)
      +   '<span class="s">' + esc(it.dis ? it.disMsg : it.desc) + '</span></span></label>';
  }

  var html = '<div class="allboard-mask show" id="scPkMask"><div class="allboard-box sc-box" style="max-width:620px">'
    + '<div class="allboard-head"><span>打印 · 选择要印的内容</span><button onclick="scPrintClose()">关闭</button></div>'
    + '<div class="sc-pane" style="max-height:72vh">'
    +   '<div class="sc-hint">勾哪块印哪块，<b>没勾的不会出现在纸上，也不会留空白</b>。<br>'
    +     '打印用的是 A4 版式：柱状图、热力图都会完整印出来，不会被截断。</div>'
    +   '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 14px">'
    +     '<button class="btn btn-sm btn-secondary" data-pkall="1">全选</button>'
    +     '<button class="btn btn-sm btn-secondary" data-pkall="0">全不选</button>'
    +     '<button class="btn btn-sm btn-secondary" data-pktoggle="1">反选</button>'
    +     groups.map(function(g){
            return '<button class="btn btn-sm btn-ghost" data-pkgroup="' + g.id + '">只印「' + esc(g.name) + '」</button>';
          }).join('')
    +   '</div>'
    +   groups.map(function(g){
          return '<div class="sc-pk-group">'
            + '<div class="sc-pk-group-h">' + esc(g.name) + '<span class="sc-dim">' + esc(g.desc) + '</span></div>'
            + g.items.map(itemHtml).join('')
            + '</div>';
        }).join('')
    +   '<div style="display:flex;gap:10px;margin-top:18px">'
    +     '<button class="btn btn-secondary" style="flex:1" onclick="scPrintClose()">取消</button>'
    +     '<button class="btn" style="flex:1" id="scPkGo">打印</button>'
    +   '</div>'
    +   '<p class="sc-figcap">这次考试：' + esc(SC.exam.name || '') + '　' + esc(scDateRange(SC.exam) || '')
    +     '　（浏览器打印对话框里请选「另存为 PDF」或直接打印机）</p>'
    + '</div></div></div>';

  var host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host.firstChild);

  var mask = document.getElementById('scPkMask');
  var boxes = function(){ return mask.querySelectorAll('[data-print]'); };
  var collect = function(){
    var out = {};
    Array.prototype.forEach.call(boxes(), function(cb){
      out[cb.getAttribute('data-print')] = !!cb.checked && !cb.disabled;
    });
    return out;
  };
  var setAll = function(v){
    Array.prototype.forEach.call(boxes(), function(cb){ if(!cb.disabled) cb.checked = v; });
  };

  Array.prototype.forEach.call(mask.querySelectorAll('[data-pkall]'), function(b){
    b.onclick = function(){ setAll(b.getAttribute('data-pkall') === '1'); };
  });
  var tg = mask.querySelector('[data-pktoggle]');
  if(tg) tg.onclick = function(){
    Array.prototype.forEach.call(boxes(), function(cb){ if(!cb.disabled) cb.checked = !cb.checked; });
  };
  Array.prototype.forEach.call(mask.querySelectorAll('[data-pkgroup]'), function(b){
    b.onclick = function(){
      var gid = b.getAttribute('data-pkgroup');
      setAll(false);
      Array.prototype.forEach.call(boxes(), function(cb){
        if(cb.disabled) return;
        if(cb.getAttribute('data-print').split('_')[0] === gid) cb.checked = true;
      });
    };
  });
  mask.addEventListener('click', function(e){ if(e.target === mask) scPrintClose(); });

  document.getElementById('scPkGo').onclick = function(){
    var next = collect();
    scPrintSave(next);
    scPrintClose();
    scApplyPrintState(next);
    /* 给浏览器一帧时间应用 class，再唤起打印 */
    setTimeout(function(){
      window.print();
      /* 打印对话框关掉后恢复（不然页面上那些块就一直藏着了） */
      setTimeout(function(){ scResetPrintHide(); }, 300);
    }, 60);
  };
}
function scPrintClose(){
  var m = document.getElementById('scPkMask');
  if(m && m.parentNode) m.parentNode.removeChild(m);
}
/** 打印完把临时隐藏全部撤掉 */
function scResetPrintHide(){
  Array.prototype.forEach.call(document.querySelectorAll('.print-hide'), function(el){
    el.classList.remove('print-hide');
  });
}


/* ============================================================
   站主侧（v2.8.2）：诊断卡 / 需关注学生 / 进退步榜 / 四象限 / 热力图
   —— 默认「不对外」，站主始终可见；对外档位由后台三档开关控制
   ============================================================ */
function scIsAdmin(){ return !!(window.AUTH && AUTH.user && AUTH.user.role === 'admin'); }

/* 当前用户能不能看这个块：站主一律能看；学生按后台档位 */
function scAllowed(key){
  if(scIsAdmin()) return 'all';
  var v = (SC.config && SC.config[key]) || 'hide';
  return v === 'self' || v === 'all' ? v : 'hide';
}
function scIsMe(r){
  var me = scMyRow();
  return !!(me && r && r.id === me.id);
}

/* 每科的班均（多处要用） */
function scSubjAvg(){
  var subs = (SC.exam && SC.exam.subjects) || [];
  var out = {};
  subs.forEach(function(sub){
    var all = [];
    SC.rows.forEach(function(r){
      var v = scSubScore(r, sub, SC.basis);
      if(v != null) all.push(v);
    });
    out[sub.key] = all.length ? all.reduce(function(a, b){ return a + b; }, 0) / all.length : null;
  });
  return out;
}

/* 把某次考试的全班成绩压成 { 姓名: 总分 } */
function scTotalsOf(pack){
  var m = {};
  if(!pack) return m;
  var subs = (pack.exam && pack.exam.subjects) || [];
  (pack.rows || []).forEach(function(r){
    var t = 0, any = false;
    subs.forEach(function(sub){
      var v = r.s && r.s[sub.key];
      if(!v) return;
      var val = (SC.basis === 'graded' && sub.graded && v.assigned != null) ? v.assigned : v.raw;
      if(val == null) return;
      t += val; any = true;
    });
    if(any) m[r.name] = t;
  });
  return m;
}

/* 站主侧的五个块，按开关决定显示哪些 */
function scTeacherBlocks(){
  var h = '';
  h += scDiagCard();
  h += scWatchList();
  h += scTailRank();
  h += scQuadrant();
  h += scHeatmap();
  return h;
}

/* ---------- ① 诊断卡：本次最值得做的事 ---------- */
function scDiagCard(){
  var mode = scAllowed('diagnosis');
  if(mode === 'hide') return '';
  var st = scStats(SC.basis);
  if(!st.n) return '';
  var subs = SC.exam.subjects || [];
  var avgs = scSubjAvg();

  /* 最薄弱科目＝班均得分率最低的那一科 */
  var weak = null;
  subs.forEach(function(sub){
    var a = avgs[sub.key];
    if(a == null || !sub.full) return;
    var rate = a / sub.full;
    if(!weak || rate < weak.rate) weak = { name: sub.name, avg: a, rate: rate, full: sub.full, key: sub.key };
  });

  var lines = [];
  lines.push('班均 <b>' + fmtNum(st.avg) + '</b> 分（' + st.n + ' 人参考）· 最高 ' + fmtNum(st.max) + ' · 中位数 ' + fmtNum(st.median));
  if(weak){
    lines.push('最薄弱一科：<b>' + esc(weak.name) + '</b>（班均 ' + fmtNum(weak.avg) + ' / ' + weak.full
      + '，得分率 ' + (weak.rate * 100).toFixed(0) + '%）');
  }
  (SC.exam.cutlines || []).filter(function(c){ return c.score != null; }).forEach(function(c){
    var n = st.list.filter(function(v){ return v >= c.score; }).length;
    lines.push(esc(c.label) + ' ' + fmtNum(c.score) + '：<b>' + n + '</b> 人过线（' + (n / st.n * 100).toFixed(0) + '%）');
  });
  /* 偏科提示：单科最强 / 最弱之间的班均差 */
  var sortedAvg = subs.map(function(sub){ return { name: sub.name, rate: avgs[sub.key] != null && sub.full ? avgs[sub.key] / sub.full : null }; })
    .filter(function(x){ return x.rate != null; }).sort(function(a, b){ return b.rate - a.rate; });
  if(sortedAvg.length >= 2){
    var best = sortedAvg[0], worst = sortedAvg[sortedAvg.length - 1];
    lines.push('班内最强 <b>' + esc(best.name) + '</b>（' + (best.rate * 100).toFixed(0) + '%）／最弱 <b>'
      + esc(worst.name) + '</b>（' + (worst.rate * 100).toFixed(0) + '%），相差 '
      + ((best.rate - worst.rate) * 100).toFixed(0) + ' 个百分点');
  }

  return '<div class="sc-card sc-card-admin" data-scblk="board_extreme"><div class="sc-card-h">本次最值得做的事<span class="sc-only-admin">仅站主可见</span></div>'
    + '<ul class="sc-diag">' + lines.map(function(x){ return '<li>' + x + '</li>'; }).join('') + '</ul>'
    + (weak ? '<div class="sc-figcap">建议优先补 <b>' + esc(weak.name) + '</b> —— 它是全班得分率最低的一科，提升空间最大。</div>' : '')
    + '</div>';
}

/* ---------- ② 需关注学生 ----------
   v3.3.0 站主要求：不能只盯总分，单科也得单独判。

   ⚠️ 阈值的刻度问题（这轮最重要的一处判断）：
   站主原话是「单科低于总分的均分 − 20」。按字面直接减会失效 ——
   总分班均 550 时这条线是 530，可任一单科满分才 100~150，永远达不到，
   等于这条规则一次都不会触发。所以统一换算成**相对比例**：

     总分线     = 班均总分 − 总分满分 × 1.5%      （750 分制 ≈ 班均 − 11 分）
     单科线(n)  = 该科班均 − 该科满分 × 1.5%      （150 分制 ≈ 班均 − 2.3 分，100 分制 ≈ 班均 − 1.5 分）

   1.5% 这个系数从站主的「20 分」倒推而来：20 ÷ 750 ≈ 2.7%，但那条线对所有科目都过严，
   取 1.5% 后 750 分制落在「班均 − 11 分」，跟原来写死的「低于班均 10 分」几乎一致，
   等于把旧口径平滑升格成比例口径 —— 站主原来看到的人数不会突变。
   好处：六科刻度不一也能公平比较（150 分的语文掉 2 分和 100 分的化学掉 1.5 分等价），
   而且换卷子、换满分都不用手动调阈值。                                    */
var SC_ALERT_RATIO = 0.015;   /* 统一阈值系数：满分的 1.5% */

/* ---------- 三类统计（v3.5.6）----------
   站主要求：「优秀率 / 及格率 / 低分率 三类统计」。
   口径问题（这轮最需要交代的一处判断）：
     · 有分数线（特控/本科/600）时，线是按**赋分总分**划的，所以三类率
       优先按分数线折算；但三条线未必齐全（有时只有本科线一条），
       缺的那档就退回「满分百分比」。
     · 没有分数线时全部退回百分比：优秀 ≥ 85%、及格 ≥ 60%、低分 < 40%。
   为什么要区分「及格」—— 60% 是通行标准（150 分制 = 90 分），
   但 750 分制的 60% 是 450 分，跟「本科线」不是一回事，
   所以有官方线时以线为准，没线时才用百分比兜底。            */
function scAlertLines(){
  var subs = SC.exam.subjects || [];
  var st = scStats(SC.basis);
  var avgs = scSubjAvg();
  var full = scFullMark();
  var gap = full * SC_ALERT_RATIO;                 /* 总分要掉多少 */
  var totalLine = st.avg - gap;
  var subLines = {};
  subs.forEach(function(sub){
    var f = sub.full || 0;
    subLines[sub.key] = (avgs[sub.key] == null || !f) ? null : (avgs[sub.key] - f * SC_ALERT_RATIO);
  });
  return { totalLine: totalLine, gap: gap, subLines: subLines, subs: subs, avgs: avgs, st: st, full: full };
}

function scWatchList(){
  var mode = scAllowed('watchList');
  if(mode === 'hide') return '';
  var L = scAlertLines();
  var st = L.st, subs = L.subs, avgs = L.avgs;
  if(!st.n) return '';
  var thr = L.totalLine;

  /* v3.5.6：「连续两次退步」要跟上一场比名次，懒加载上一场（与历次上线率共用 SC.allRows） */
  var prevDrop = scPrevDropMap();

  var list = [];
  SC.rows.forEach(function(r){
    var t = scTotal(r, SC.basis);
    if(mode === 'self' && !scIsMe(r)) return;

    /* 单科：低于「该科班均 − 该科满分的 1.5%」的科目；
       worst 仍取相对该科班均差得最多的那一科（绝对值，不折比例，方便直观看分） */
    var lowSubs = [], worst = null;
    subs.forEach(function(sub){
      var v = scSubScore(r, sub, SC.basis);
      if(v == null) return;
      var line = L.subLines[sub.key];
      if(line != null && v < line) lowSubs.push({ name: sub.name, v: v, d: v - line, line: line });
      if(avgs[sub.key] == null) return;
      var d = v - avgs[sub.key];
      if(!worst || d < worst.d) worst = { name: sub.name, d: d };
    });

    var lowTotal = (t != null && t < thr);
    var drop2 = !!prevDrop[r.name];
    if(!lowTotal && !lowSubs.length && !drop2) return;
    list.push({
      name: r.name, total: t, worst: worst, me: scIsMe(r),
      lowTotal: lowTotal, lowSubs: lowSubs, drop2: drop2,
      drop2By: drop2 ? prevDrop[r.name] : 0,
    });
  });

  /* v3.5.6 四档筛选 */
  var ALL = list.slice();
  var nLowTotal = ALL.filter(function(x){ return x.lowTotal; }).length;
  var nLowSubOnly = ALL.filter(function(x){ return !x.lowTotal && x.lowSubs.length; }).length;
  var nAnySub = ALL.filter(function(x){ return x.lowSubs.length; }).length;
  var nDrop2 = ALL.filter(function(x){ return x.drop2; }).length;

  var FILTERS = [
    { key: 'all',   label: '全部', n: ALL.length },
    { key: 'total', label: '总分不达标', n: nLowTotal },
    { key: 'subj',  label: '仅单科', n: nLowSubOnly },
    { key: 'drop',  label: '连续两次退步', n: nDrop2 },
  ];
  if(SC.careFilter && !FILTERS.some(function(f){ return f.key === SC.careFilter; })) SC.careFilter = 'all';
  var cur = SC.careFilter || 'all';
  list = ALL.filter(function(x){
    if(cur === 'total') return x.lowTotal;
    if(cur === 'subj')  return !x.lowTotal && x.lowSubs.length > 0;
    if(cur === 'drop')  return x.drop2;
    return true;
  });

  /* 排序：默认总分不达标的先按总分从低到高；只栽在单科上的排在后面，按最惨那一科从低到高。
     v3.5.6 起点表头可换成按姓名/总分/总分差/单科数/最弱一科排。 */
  var k = SC.careSortKey || 'total', asc = SC.careSortAsc !== false;
  function cmp(a, b){
    var va, vb;
    if(k === 'name'){ return asc ? String(a.name).localeCompare(String(b.name), 'zh') : String(b.name).localeCompare(String(a.name), 'zh'); }
    if(k === 'total'){ va = a.total == null ? 1e9 : a.total; vb = b.total == null ? 1e9 : b.total; }
    else if(k === 'diff'){ va = a.total == null ? 1e9 : a.total - st.avg; vb = b.total == null ? 1e9 : b.total - st.avg; }
    else if(k === 'nsub'){ va = a.lowSubs.length; vb = b.lowSubs.length; }
    else if(k === 'worst'){ va = a.worst ? a.worst.d : 0; vb = b.worst ? b.worst.d : 0; }
    else { va = 0; vb = 0; }
    if(va !== vb) return asc ? va - vb : vb - va;
    /* 同值时把总分不达标的排前面，视觉上更连贯 */
    if(a.lowTotal !== b.lowTotal) return a.lowTotal ? -1 : 1;
    return String(a.name).localeCompare(String(b.name), 'zh');
  }
  list.sort(cmp);

  if(!ALL.length) return '';

  var arrow = function(key){
    return SC.careSortKey === key ? '<i class="sc-arw">' + (SC.careSortAsc ? '↑' : '↓') + '</i>' : '';
  };
  var sortTh = function(key, text){
    return '<th class="sc-th-sort" onclick="scCareSort(\'' + key + '\')">' + text + arrow(key) + '</th>';
  };

  var head = '<thead><tr>'
    + sortTh('name', '姓名')
    + sortTh('total', '总分')
    + sortTh('diff', '总分差')
    + sortTh('nsub', '拖后腿的单科')
    + sortTh('worst', '最弱一科')
    + '</tr></thead>';

  var body = list.map(function(x){
        var lowHtml = '—';
        if(x.lowSubs.length){
          lowHtml = '<span class="sc-lowsub">' + x.lowSubs.map(function(s){
            return '<b>' + esc(s.name) + '</b>' + fmtNum(s.v) + '<em>' + fmtNum(s.d) + '</em>';
          }).join('') + '</span>';
        }
        return '<tr' + (x.me ? ' class="sc-me-row"' : '') + '>'
          + '<td class="sc-name">' + esc(x.name)
          +   (x.me ? '<span class="sc-you">我</span>' : '')
          +   (x.lowTotal ? '' : (x.lowSubs.length ? '<span class="sc-tagonly">仅单科</span>' : ''))
          +   (x.drop2 ? '<span class="sc-tagdrop" title="比上一次考试掉了 ' + x.drop2By + ' 名">连退 ' + x.drop2By + '</span>' : '')
          + '</td>'
          + '<td data-label="总分">' + (x.total == null ? '—' : fmtNum(x.total)) + '</td>'
          + '<td data-label="总分差">' + (x.total == null ? '—'
                : '<span class="' + (x.total < thr ? 'sc-warn' : 'sc-good') + '">' + fmtDiff(x.total - st.avg) + '</span>') + '</td>'
          + '<td data-label="拖后腿的单科">' + lowHtml + '</td>'
          + '<td data-label="最弱一科">' + (x.worst ? esc(x.worst.name) + ' <span class="sc-warn">' + fmtNum(x.worst.d) + '</span>' : '—') + '</td>'
          + '</tr>';
      }).join('');

  /* ---- 表格下方的自动文字总结（v3.5.6）---- */
  var summary = scCareSummary({
    all: ALL, shown: list, cur: cur, st: st, thr: thr,
    nLowTotal: nLowTotal, nLowSubOnly: nLowSubOnly, nAnySub: nAnySub, nDrop2: nDrop2,
    L: L, subs: subs,
  });

  var chips = '<div class="sc-chips">' + FILTERS.map(function(f){
    return '<button class="sc-chip' + (f.key === cur ? ' on' : '') + '"'
      + (f.n === 0 ? ' disabled' : '')
      + ' onclick="scCareFilter(\'' + f.key + '\')">' + esc(f.label)
      + '<em>' + f.n + '</em></button>';
  }).join('') + '</div>';

  return '<div class="sc-card sc-card-admin"><div class="sc-card-h">需关注学生'
    + '<span class="sc-h-note">总分低于 ' + fmtNum(thr) + ' 分，或某科低于该科班均 ' + (SC_ALERT_RATIO * 100).toFixed(1) + '% 满分</span>'
    + '<span class="sc-only-admin">仅站主可见</span></div>'
    + chips
    + (list.length
        ? '<div class="sc-tblwrap" style="max-height:420px"><table class="sc-tbl sc-tbl-watch" style="min-width:auto">'
          + head + '<tbody>' + body + '</tbody></table></div>'
        : '<div class="sc-empty" style="padding:18px 8px"><p>这个筛选下没有人。</p></div>')
    + (summary ? '<div class="sc-care-sum">' + summary + '</div>' : '')
    + '<div class="sc-figcap">'
    + '「总分差」＝ 本人总分 − 班均总分。'
    + '「拖后腿的单科」格子里，粗体是科目、紧跟分数，斜体小字是<b>比该科的线还低多少</b>（越低越该补）。'
    + '「最弱一科」＝相对该科班均差得最多的那一科（按原始分差算，不折比例）。'
    + '「连退 N」＝ 相比上一次考试名次往下掉了 N 名（连续两次都在退）。'
    + '<br>阈值说明：总分线 = 班均总分 − 总分满分 × ' + (SC_ALERT_RATIO * 100).toFixed(1) + '%（本次 '
    + fmtNum(L.full) + ' 分制 → 掉 ' + fmtNum(L.gap) + ' 分即上榜）；'
    + '单科线按各科满分同比例折算（' + subs.map(function(sub){
        var l = L.subLines[sub.key];
        return esc(sub.name) + (l == null ? '—' : fmtNum(l));
      }).join(' / ') + '），这样 150 分的语文和 100 分的化学才能放在一起比。'
    + '</div>'
    + '</div>';
}

/* 需关注：切换筛选 / 排序（都不重新取数，只重画这一块） */
function scCareFilter(k){ SC.careFilter = k; scRenderBoard(); }
function scCareSort(k){
  if(SC.careSortKey === k) SC.careSortAsc = !SC.careSortAsc;
  else { SC.careSortKey = k; SC.careSortAsc = (k === 'name' || k === 'total' || k === 'diff' || k === 'worst'); }
  scRenderBoard();
}

/* 「连续两次退步」所需的上一次考试班排名：姓名 → 掉了多少名
   拿不到上一场就返回空对象（该筛选自然为 0 人，不会误报）。 */
function scPrevDropMap(){
  var out = {};
  if(!SC._prevPacks) return out;
  var prev = SC._prevPacks[SC.exam && SC.exam.id];
  if(!prev || !prev.rows || !prev.rows.length) return out;
  /* 上一场的班排名（同分并列口径，与 scRankMap 一致） */
  var psubs = (prev.exam && prev.exam.subjects) || [];
  var arr = [];
  (prev.rows || []).forEach(function(r){
    var t = 0, any = false;
    psubs.forEach(function(sub){
      var v = r.s && r.s[sub.key];
      if(!v) return;
      var val = (SC.basis === 'graded' && sub.graded && v.assigned != null) ? v.assigned : v.raw;
      if(val == null) return;
      t += val; any = true;
    });
    if(any) arr.push({ name: r.name, v: t });
  });
  arr.sort(function(a, b){ return b.v - a.v; });
  var rk = 0, pv = null, prevRank = {};
  arr.forEach(function(x, i){
    if(pv === null || x.v !== pv){ rk = i + 1; pv = x.v; }
    prevRank[x.name] = rk;
  });
  var now = scRankMap(SC.basis).total;
  var nowByName = {};
  SC.rows.forEach(function(r){ if(now[r.id] != null) nowByName[r.name] = now[r.id]; });

  Object.keys(nowByName).forEach(function(name){
    var p = prevRank[name], n = nowByName[name];
    if(p == null || n == null) return;
    var d = n - p;              /* 正数 = 名次数字变大 = 退步 */
    if(d > 0) out[name] = d;
  });
  return out;
}

/* 需关注表下方的自动文字总结（纯本地规则，不调模型） */
function scCareSummary(o){
  var bits = [];
  var all = o.all || [], st = o.st;
  if(!all.length){
    return '本次没有人踩到关注线 —— 全班总分都在班均 ' + fmtNum(o.thr) + ' 分以上，各科也没有明显掉队的。';
  }
  bits.push('本次共 <b>' + all.length + '</b> 人需要看一眼（占参考人数的 '
    + (all.length / st.n * 100).toFixed(0) + '%）：总分不达标 <b>' + o.nLowTotal + '</b> 人，'
    + '只在单科掉队 <b>' + o.nLowSubOnly + '</b> 人'
    + (o.nDrop2 ? '，连续两次退步 <b>' + o.nDrop2 + '</b> 人' : '') + '。');

  /* 最集中的短板科目：统计出现在「拖后腿」里的次数 */
  var cnt = {};
  all.forEach(function(x){ x.lowSubs.forEach(function(s){ cnt[s.name] = (cnt[s.name] || 0) + 1; }); });
  var top = Object.keys(cnt).map(function(k){ return { name: k, n: cnt[k] }; })
    .sort(function(a, b){ return b.n - a.n; });
  if(top.length){
    var t = top[0];
    bits.push('拖后腿最集中的是 <b>' + esc(t.name) + '</b>（' + t.n + ' 人在这科掉队）—— 讲评时值得整班过一遍。');
    if(top.length >= 2 && top[1].n >= 2){
      bits.push('其次是 <b>' + esc(top[1].name) + '</b>（' + top[1].n + ' 人）。');
    }
  }

  /* 最严重的那一个（总分最低或最惨单科） */
  var worstOne = null;
  all.forEach(function(x){
    var sev = 0;
    if(x.total != null) sev = Math.max(sev, (o.thr - x.total));
    x.lowSubs.forEach(function(s){ sev = Math.max(sev, -s.d); });
    if(!worstOne || sev > worstOne.sev) worstOne = { x: x, sev: sev };
  });
  if(worstOne && worstOne.sev > 0){
    var w = worstOne.x;
    var why = [];
    if(w.lowTotal) why.push('总分 ' + fmtNum(w.total) + '，比线低 ' + fmtNum(o.thr - w.total) + ' 分');
    if(w.lowSubs.length) why.push(w.lowSubs.map(function(s){ return s.name + ' ' + fmtNum(s.v); }).join('、'));
    bits.push('最需要先谈的是 <b>' + esc(w.name) + '</b>：' + why.join('；') + '。');
  }

  /* 连续退步：点名变化最大的那位 */
  var dropTop = null;
  all.forEach(function(x){ if(x.drop2 && (!dropTop || x.drop2By > dropTop.drop2By)) dropTop = x; });
  if(dropTop){
    bits.push('名次上 <b>' + esc(dropTop.name) + '</b> 相比上次掉了 <b>' + dropTop.drop2By
      + '</b> 名 —— 先确认是不是状态问题（睡眠、手机、情绪），再谈方法。');
  }

  if(o.cur !== 'all'){
    bits.push('当前只看「' + scCareFilterLabel(o.cur) + '」这 <b>' + o.shown.length + '</b> 人，点「全部」可以看完整名单。');
  }
  return bits.map(function(x){ return '<p>' + x + '</p>'; }).join('');
}
function scCareFilterLabel(k){
  return k === 'total' ? '总分不达标' : k === 'subj' ? '仅单科' : k === 'drop' ? '连续两次退步' : '全部';
}

/* ---------- ③ 进退步榜（和上一次考试比名次变化） ----------
   v2.9.7 站主：「进退步榜可以切换年级和班级和班级单科进退步」
   三种口径：
     · class   —— 班级总分名次（默认，最常用）
     · grade   —— 年级名次（靠导入的校排名，系统算不出全校）
     · subject —— 班级某一科的名次（看某科单独退没退）
   都统一成「名次」，因为名次能跨卷子比，分数不能。            */
var SC_TAIL = { basis: 'class', sub: null };

function scTailSet(basis){
  SC_TAIL.basis = basis;
  if(basis === 'subject' && !SC_TAIL.sub){
    var subs = (SC.exam && SC.exam.subjects) || [];
    if(subs.length) SC_TAIL.sub = subs[0].key;
  }
  scRenderPane();
}
function scTailSubj(key){
  SC_TAIL.sub = key;
  scRenderPane();
}

function scTailRank(){
  var mode = scAllowed('tailRank');
  if(mode === 'hide') return '';
  /* 优先用「我的历次成绩」这条链（学生只拿得到自己的，也最省请求）；
     站主账号本身没有学生成绩时，退回用考试列表 —— 站主照样能看全班进退步。 */
  var items = (SC.me && SC.me.length >= 2)
    ? SC.me
    : (SC.exams || []).slice().sort(function(a, b){ return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  var eidOf = function(x){ return x.examId != null ? x.examId : x.id; };

  if(items.length < 2 || !SC.allRows){
    return '<div class="sc-card sc-card-admin"><div class="sc-card-h">进退步榜<span class="sc-only-admin">仅站主可见</span></div>'
      + '<div class="sc-dim" style="padding:4px 0 10px">要和上一次考试比，得先把历次成绩读一遍（一次就够）。</div>'
      + '<button class="btn btn-sm" onclick="scLoadAllRows()">开始计算</button></div>';
  }
  var idx = -1;
  for(var i = 0; i < items.length; i++) if(eidOf(items[i]) === SC.exam.id) idx = i;
  if(idx < 1) return '';

  var curPack = SC.allRows[eidOf(items[idx])];
  var prevPack = SC.allRows[eidOf(items[idx - 1])];

  /* v3.5.7 修复：懒加载可能只载了部分历次成绩（比如上次某一场读取失败被记成 null），
     缺当前场或上一场时自动补载并提示读取中 —— 不能误报成「对不上人」。 */
  if(!curPack || !prevPack){
    scLoadAllRows();
    return '<div class="sc-card sc-card-admin"><div class="sc-card-h">进退步榜<span class="sc-only-admin">仅站主可见</span></div>'
      + '<div class="sc-dim" style="padding:4px 0 10px">正在读取这两次考试的全班成绩（几秒钟）…</div></div>';
  }

  /* 单科口径先定下是哪一科 */
  var subs = (SC.exam && SC.exam.subjects) || [];
  var sub = null;
  if(SC_TAIL.basis === 'subject'){
    subs.forEach(function(x){ if(x.key === SC_TAIL.sub) sub = x; });
    if(!sub) sub = subs[0] || null;
  }
  var basis = (SC_TAIL.basis === 'subject' && sub) ? 'subject'
            : (SC_TAIL.basis === 'grade' ? 'grade' : 'class');

  /* 总分表（三种口径都要用：年级口径的「分数变化」也看总分） */
  function totalsOf(pack){ return scTotalsOf(pack); }
  /* 某一科的分（赋分口径跟着全局来） */
  function subjOf(pack, s){
    var m = {};
    if(!pack) return m;
    (pack.rows || []).forEach(function(r){
      var v = r.s && r.s[s.key];
      if(!v) return;
      var val = (SC.basis === 'graded' && s.graded && v.assigned != null) ? v.assigned : v.raw;
      if(val != null) m[r.name] = val;
    });
    return m;
  }
  /* 导入的年级名次（越小越好） */
  function gradeOf(pack){
    var m = {};
    if(!pack) return m;
    (pack.rows || []).forEach(function(r){
      if(r.schoolRank != null) m[r.name] = r.schoolRank;
    });
    return m;
  }
  /* 把「越大越好」的分数压成 1..N 名次 */
  function rankMapOf(m){
    var arr = Object.keys(m).map(function(n){ return { n: n, v: m[n] }; }).sort(function(a, b){ return b.v - a.v; });
    var r = {}, k = 0, last = null;
    arr.forEach(function(x, i){
      if(last === null || x.v !== last){ k = i + 1; last = x.v; }
      r[x.n] = k;
    });
    return r;
  }

  /* v3.5.14 #5：年级口径下，「上一次」必须是**最近一次导入过年级排名**的考试。
     以前固定取紧邻的 items[idx-1]，那一场没导入排名就整块放弃或误报「对不上人」。 */
  var prevIdx = idx - 1;
  var prevRankExamName = items[prevIdx] ? items[prevIdx].name : '';
  if(basis === 'grade'){
    var foundPrev = false;
    for(var gi2 = idx - 1; gi2 >= 0; gi2--){
      var pk2 = SC.allRows[eidOf(items[gi2])];
      if(pk2 && pk2.rows && pk2.rows.some(function(r){ return r.schoolRank != null; })){ prevIdx = gi2; foundPrev = true; break; }
    }
    if(!foundPrev){
      return '<div class="sc-card sc-card-admin"><div class="sc-card-h">进退步榜<span class="sc-only-admin">仅站主可见</span></div>'
        + scTailSwitch(basis, subs)
        + scNoRankNotice({ reason:'no-prev-rank', total: items.length, withRank: items.filter(function(x){
            var p = SC.allRows[eidOf(x)]; return p && p.rows && p.rows.some(function(r){ return r.schoolRank != null; });
          }).length })
        + '<div class="sc-dim" style="padding:4px 0 10px">这一场之前没有导入过年级排名，无法按年级口径算进退步。换成班级口径或单科口径可以看到全班进退步。</div></div>';
    }
    prevPack = SC.allRows[eidOf(items[prevIdx])] || prevPack;
    prevRankExamName = items[prevIdx].name;
  }

  var curTot = totalsOf(curPack), prevTot = totalsOf(prevPack);

  var curPos, prevPos, curVal, prevVal;
  if(basis === 'grade'){
    /* 年级口径：名次直接用导入的校排名，分数变化用总分 */
    curPos = gradeOf(curPack); prevPos = gradeOf(prevPack);
    curVal = curTot; prevVal = prevTot;
  } else if(basis === 'subject'){
    var cm = subjOf(curPack, sub), pm = subjOf(prevPack, sub);
    curPos = rankMapOf(cm); prevPos = rankMapOf(pm);
    curVal = cm; prevVal = pm;
  } else {
    curPos = rankMapOf(curTot); prevPos = rankMapOf(prevTot);
    curVal = curTot; prevVal = prevTot;
  }

  var names = Object.keys(curPos).filter(function(n){ return prevPos[n] != null; });
  if(!names.length){
    return '<div class="sc-card sc-card-admin"><div class="sc-card-h">进退步榜'
      + '<span class="sc-h-note">' + esc(prevRankExamName || '上一场') + ' → ' + esc(SC.exam.name) + '</span>'
      + '<span class="sc-only-admin">仅站主可见</span></div>'
      + scTailSwitch(basis, subs)
      + '<div class="sc-dim" style="padding:4px 0 10px">这两次考试按这个口径<b>对不上人</b>'
      + (basis === 'grade' ? '（本次成绩里没有导入年级排名）' : basis === 'subject' ? '（这一科有人没考）' : '')
      + '，换个口径看看。</div></div>';
  }

  var moved = names.map(function(n){
    return {
      name: n,
      from: prevPos[n], to: curPos[n],
      d: prevPos[n] - curPos[n],
      dc: (curVal[n] != null && prevVal[n] != null) ? (curVal[n] - prevVal[n]) : null,
      me: false,
    };
  });
  var meRow = scMyRow();
  if(meRow) moved.forEach(function(x){ if(x.name === meRow.name) x.me = true; });
  if(mode === 'self'){
    moved = moved.filter(function(x){ return x.me; });
    if(!moved.length) return '';
  }

  /* v3.3.0 站主要求：进步/退步合成一张表、列全部人、点表头排序。
     排序口径跟「全班成绩单」一致（缺值永远垫底、同值稳定）。
     注意 changed 用「名次变化」而不是「名次」—— 想看谁升得最多就按变化排，
     想看名次靠前的人就按名次排，两种需求都给到。 */
  var key = SC.tailSortKey, asc = SC.tailSortAsc;
  var arr = moved.slice();
  arr.sort(function(a, b){
    var x, y;
    if(key === 'name'){ x = a.name; y = b.name; return asc ? (x > y ? 1 : x < y ? -1 : 0) : (x < y ? 1 : x > y ? -1 : 0); }
    x = a[key]; y = b[key];
    if(x == null && y == null) return 0;
    if(x == null) return 1;
    if(y == null) return -1;
    return asc ? x - y : y - x;
  });
  var nUp = moved.filter(function(x){ return x.d > 0; }).length;
  var nDn = moved.filter(function(x){ return x.d < 0; }).length;
  var nEq = moved.length - nUp - nDn;

  var arrowOf = function(k){
    if(SC.tailSortKey !== k) return '';
    return '<i class="sc-arw">' + (SC.tailSortAsc ? '↑' : '↓') + '</i>';
  };
  var cell = function(x, k){
    var v = x[k];
    if(v == null) return '<td class="sc-dim">—</td>';
    if(k === 'd'){
      var ar = v > 0 ? '↑' : v < 0 ? '↓' : '—';
      return '<td class="' + (v > 0 ? 'sc-good' : v < 0 ? 'sc-warn' : 'sc-dim') + '">' + ar + ' ' + Math.abs(v) + '</td>';
    }
    if(k === 'dc') return '<td class="' + (v > 0 ? 'sc-good' : v < 0 ? 'sc-warn' : '') + '">' + (v > 0 ? '+' : '') + fmtNum(v) + '</td>';
    return '<td>' + fmtNum(v, 0) + '</td>';
  };

  var head = '<tr>'
    + '<th class="sc-th-sort" onclick="scTailSort(\'name\')">姓名' + arrowOf('name') + '</th>'
    + '<th class="sc-th-sort" onclick="scTailSort(\'from\')">上次名次' + arrowOf('from') + '</th>'
    + '<th class="sc-th-sort" onclick="scTailSort(\'to\')">本次名次' + arrowOf('to') + '</th>'
    + '<th class="sc-th-sort" onclick="scTailSort(\'d\')">名次变化' + arrowOf('d') + '</th>'
    + '<th class="sc-th-sort" onclick="scTailSort(\'dc\')">分数变化' + arrowOf('dc') + '</th>'
    + '</tr>';

  var body = arr.map(function(x){
    return '<tr' + (x.me ? ' class="sc-me-row"' : '') + '>'
      + '<td class="sc-name">' + esc(x.name) + (x.me ? '<span class="sc-you">我</span>' : '') + '</td>'
      + cell(x, 'from') + cell(x, 'to') + cell(x, 'd') + cell(x, 'dc')
      + '</tr>';
  }).join('');

  var basisTxt = basis === 'grade' ? '年级名次'
               : basis === 'subject' ? '班级' + sub.name + '名次'
               : '班级总分名次';
  var cap = basis === 'grade'
    ? '统计口径：年级名次（由后台导入）。'
    : basis === 'subject'
      ? '统计口径：' + esc(sub.name) + '班内名次。' + (sub.graded && SC.basis === 'graded' ? '按赋分口径计算。' : '')
      : '统计口径：班级总分名次。';

  return '<div class="sc-card sc-card-admin"><div class="sc-card-h">进退步榜'
    + '<span class="sc-h-note">' + esc(items[idx - 1].name) + ' → ' + esc(SC.exam.name) + '</span>'
    + '<span class="sc-only-admin">仅站主可见</span></div>'
    + scTailSwitch(basis, subs)
    + '<div class="sc-figcap" style="margin-bottom:8px">' + cap + '</div>'
    + '<div class="sc-tblwrap" style="max-height:460px"><table class="sc-tbl" style="min-width:auto">'
    +   '<thead>' + head + '</thead><tbody>' + body + '</tbody>'
    + '</table></div>'
    + '<div class="sc-figcap" style="margin-top:8px">点表头可排序（名次、变化、分数都能排）。'
    + '共比了 <b>' + moved.length + '</b> 人：进步 <b>' + nUp + '</b> 人、退步 <b>' + nDn + '</b> 人、持平 <b>' + nEq + '</b> 人。'
    + '口径为 <b>' + esc(basisTxt) + '</b>。名次变化里的 ↑ 是往前挪、↓ 是往后退，数字是挪了几个名次。</div>'
    + '</div>';
}

/* 进退步榜排序：点表头切换升降序，逻辑跟成绩表 scSort 一致 */
function scTailSort(k){
  if(SC.tailSortKey === k) SC.tailSortAsc = !SC.tailSortAsc;
  else { SC.tailSortKey = k; SC.tailSortAsc = (k === 'name' || k === 'to' || k === 'from'); }
  scRenderPane();
}

/** 口径切换条：班级 / 年级 / 班级单科（单科时再多一个科目下拉） */
function scTailSwitch(basis, subs){
  var b = function(key, txt){
    return '<button class="' + (basis === key ? 'on' : '') + '" onclick="scTailSet(\'' + key + '\')">' + txt + '</button>';
  };
  var h = '<div class="sc-seg">'
    + b('class', '班级总分') + b('grade', '年级') + b('subject', '班级单科')
    + '</div>';
  if(basis === 'subject' && subs.length){
    h += '<select class="sc-sel" style="margin-left:8px;min-width:110px;font-size:.8rem;padding:6px 8px" '
      +   'onchange="scTailSubj(this.value)">'
      + subs.map(function(s){
          return '<option value="' + esc(s.key) + '"' + (s.key === SC_TAIL.sub ? ' selected' : '') + '>'
            + esc(s.name) + '</option>';
        }).join('')
      + '</select>';
  }
  return '<div class="sc-segbar">' + h + '</div>';
}

/* ---------- ④ 分层教学四象限（总分 × 指定单科） ---------- */
function scQuadrant(){
  var mode = scAllowed('quadrant');
  if(mode === 'hide') return '';
  var subs = SC.exam.subjects || [];
  var avgs = scSubjAvg();
  var st = scStats(SC.basis);
  if(!st.n || subs.length < 1) return '';

  /* 默认看「最薄弱那一科」——它就是最该分层的地方 */
  var pick = SC.quadKey || null;
  if(!pick){
    var worst = null;
    subs.forEach(function(sub){
      var a = avgs[sub.key];
      if(a == null || !sub.full) return;
      var rate = a / sub.full;
      if(!worst || rate < worst.rate){ worst = { key: sub.key, rate: rate }; }
    });
    pick = worst ? worst.key : subs[0].key;
  }
  var sub = null;
  subs.forEach(function(x){ if(x.key === pick) sub = x; });
  if(!sub) sub = subs[0];
  var subAvg = avgs[sub.key];

  var pts = SC.rows.map(function(r){
    var t = scTotal(r, SC.basis), v = scSubScore(r, sub, SC.basis);
    if(t == null || v == null) return null;
    var pack = (r.s && r.s[sub.key]) || {};
    /* 单科排名跟着口径走：赋分口径看赋分排名，原始口径看原始排名（没有就退回原始排名） */
    var subRank = (SC.basis === 'graded' && sub.graded && pack.asgRank != null) ? pack.asgRank
                : (pack.rank == null ? null : pack.rank);
    return {
      name: r.name, x: t, y: v, me: scIsMe(r),
      schoolRank: r.schoolRank == null ? null : r.schoolRank,
      leagueRank: r.leagueRank == null ? null : r.leagueRank,
      subRank: subRank,
      subRaw: pack.raw == null ? null : pack.raw,
      subAsg: pack.assigned == null ? null : pack.assigned,
    };
  }).filter(Boolean);
  if(pts.length < 3) return '';

  var W = 640, H = 380, L = 54, R = 24, T = 22, B = 46;
  var xs = pts.map(function(p){ return p.x; }), ys = pts.map(function(p){ return p.y; });
  var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs);
  var ymin = Math.min.apply(null, ys), ymax = Math.max.apply(null, ys);
  if(xmax === xmin) xmax = xmin + 1;
  if(ymax === ymin) ymax = ymin + 1;
  var xOf = function(v){ return L + (W - L - R) * (v - xmin) / (xmax - xmin); };
  var yOf = function(v){ return T + (H - T - B) * (1 - (v - ymin) / (ymax - ymin)); };
  var mx = xOf(st.avg), my = yOf(subAvg);

  /* ⚠️ v3.1.1 修正：块的顺序必须和下面 qOf() 的下标严格一一对应
     （0=总分低·单科弱 左下；1=总分强·单科弱 右下；2=总分低·单科强 左上；3=总分强·单科强 右上）。
     SVG 的 y 轴是反的（y 越小＝分数越高），原来按「从上往下」写，
     结果块上的标题和图上的位置上下颠倒 —— 站主反馈「点开名单和图对不上」就是这个。
     顺带用 Math.max(0, …) 兜住班均正好压在边界上时的负宽高。 */
  var quads = [
    { x: L,  y: my, w: mx - L,     h: H - B - my, c: '#f6f2ff', t: '总分低 / 单科弱', cls: 'sc-q1' },
    { x: mx, y: my, w: W - R - mx, h: H - B - my, c: '#fff6f0', t: '总分强 / 单科弱（偏科预警）', cls: 'sc-q2' },
    { x: L,  y: T,  w: mx - L,     h: my - T,     c: '#f4faf6', t: '总分低 / 单科强（单科尖子）', cls: 'sc-q3' },
    { x: mx, y: T,  w: W - R - mx, h: my - T,     c: '#fdf8f3', t: '总分强 / 单科强', cls: 'sc-q4' },
  ];
  /* 每个点属于哪个象限：0=总分低·单科弱 1=总分强·单科弱 2=总分低·单科强 3=总分强·单科强。
     手机没有悬停 —— 点象限（或圆点）就在下方列出该象限的具体同学。 */
  var qOf = function(p){ return (p.x >= st.avg ? 1 : 0) + (p.y >= subAvg ? 2 : 0); };
  SC.quadSel = null;
  SC.quadDot = null;
  SC._quad = {
    titles: quads.map(function(q){ return q.t; }),
    subName: sub.name,
    totalAvg: st.avg,
    subAvg: subAvg,
    pts: pts.map(function(p){
      return {
        name: p.name, x: p.x, y: p.y, me: p.me, q: qOf(p),
        schoolRank: p.schoolRank, leagueRank: p.leagueRank,
        subRank: p.subRank, subRaw: p.subRaw, subAsg: p.subAsg,
      };
    }),
  };
  /* 手机上点不动、也悬停不了，所以名字必须直接写在图上。
     但 60 个点全写会糊成一团 —— 只写「最该被点名」的：
     偏科预警象限（总分够、这一科却拖后腿）＋ 我自己。 */
  var warns = pts.filter(function(p){ return p.x >= st.avg && p.y < subAvg; });
  if(warns.length > 14){
    warns = warns.slice().sort(function(a, b){ return (a.y - subAvg) - (b.y - subAvg); }).slice(0, 14);
  }
  var labeled = {};
  warns.forEach(function(p){ labeled[p.name] = 1; });

  var dots = pts.map(function(p, pi){
    var cx = xOf(p.x), cy = yOf(p.y);
    /* v3.1.1：每个点单独可点 —— 点谁就只说这一个人（原来点哪个点都是「整个象限」）。
       手指点 3.6px 的圆点很难命中，所以外面套一个透明 r=11 的命中圈。 */
    var g = '<g class="sc-qg" style="cursor:pointer" onclick="scQuadDot(' + pi + ')">'
      + '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="11" fill="transparent"/>'
      + '<circle id="scQdot' + pi + '" cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + (p.me ? 5.5 : 3.6)
      + '" class="' + (p.me ? 'sc-mine-dot' : 'sc-q-dot') + '" fill="' + (p.me ? '#c2410c' : '#7c3aed') + '" fill-opacity="' + (p.me ? 1 : 0.55) + '">'
      + '<title>' + esc(p.name) + '　总分 ' + fmtNum(p.x) + '　' + esc(sub.name) + ' ' + fmtNum(p.y) + '</title></circle>';
    if(p.me || labeled[p.name]){
      var txt = p.me ? ('我 ' + fmtNum(p.x) + '·' + fmtNum(p.y)) : (p.name + ' ' + fmtNum(p.y));
      var tx = cx + 7, anc = 'start';
      if(cx + 7 + txt.length * 9 > W - R){ tx = cx - 7; anc = 'end'; }
      g += '<text x="' + tx.toFixed(1) + '" y="' + (cy + 3.2).toFixed(1) + '" font-size="9" font-weight="700"'
        + ' class="' + (p.me ? 'sc-qme' : 'sc-qnm') + '" fill="' + (p.me ? '#c2410c' : '#6d4bb8') + '" text-anchor="' + anc + '"'
        + ' stroke="#fffdfb" stroke-width="2.6" paint-order="stroke">' + esc(txt) + '</text>';
    }
    g += '</g>';
    return g;
  }).join('');

  return '<div class="sc-card sc-card-admin"><div class="sc-card-h">分层教学四象限'
    + '<span class="sc-h-note">总分 × ' + esc(sub.name) + '</span>'
    + '<span class="sc-only-admin">仅站主可见</span></div>'
    + '<div class="sc-svgwrap"><svg viewBox="0 0 ' + W + ' ' + H + '" class="sc-svg">'
    + quads.map(function(q, qi){
        return '<rect id="scQrect' + qi + '" x="' + q.x.toFixed(1) + '" y="' + q.y.toFixed(1) + '" width="' + Math.max(0, q.w).toFixed(1)
          + '" height="' + Math.max(0, q.h).toFixed(1) + '" class="' + q.cls + ' sc-qhit" style="cursor:pointer" fill="' + q.c
          + '" onclick="scQuadTap(' + qi + ')"/>';
      }).join('')
    + '<line x1="' + mx.toFixed(1) + '" y1="' + T + '" x2="' + mx.toFixed(1) + '" y2="' + (H - B) + '" class="sc-axis" stroke="#e2d5c8" stroke-dasharray="4 3"/>'
    + '<line x1="' + L + '" y1="' + my.toFixed(1) + '" x2="' + (W - R) + '" y2="' + my.toFixed(1) + '" class="sc-axis" stroke="#e2d5c8" stroke-dasharray="4 3"/>'
    + dots
    + '<text x="' + (W - R) + '" y="' + (H - B + 22) + '" font-size="10" class="sc-axdim" fill="#7a6a5c" text-anchor="end">总分 →</text>'
    + '<text x="' + (L - 8) + '" y="' + (T + 12) + '" font-size="10" class="sc-axdim" fill="#7a6a5c" text-anchor="end">' + esc(sub.name) + '</text>'
    + '<text x="' + (mx + 6).toFixed(1) + '" y="' + (my - 6).toFixed(1) + '" font-size="9.5" class="sc-axdim" fill="#7a6a5c">十字＝班均</text>'
    + '</svg></div>'
    + '<div class="sc-quadpick">看哪一科：' + subs.map(function(x){
        return '<button class="' + (x.key === sub.key ? 'on' : '') + '" onclick="scSetQuad(\'' + x.key + '\')">' + esc(x.name) + '</button>';
      }).join('') + '</div>'
    + '<div class="sc-figcap">横轴总分、纵轴单科，十字为班均线；右上＝双强，左上＝单科尖子，右下＝偏科预警。'
    + '图中标注姓名与该科分数，橙色「我」为本人。<b>点某个圆点＝只看这个人</b>，点彩色底块＝看整个象限的同学。</div>'
    + '<div id="scQList" class="sc-qlist"></div>'
    + '</div>';
}
/* 点底块 → 列出该象限的同学；点圆点 → 只看这一个人。
   只改 DOM、不整页重渲染，避免手机上看名单时页面跳回顶部。 */
function scQuadTap(i){
  var qd = SC._quad;
  if(!qd) return;
  SC.quadSel = (SC.quadSel === i) ? null : i;   /* 再点一次收起 */
  SC.quadDot = null;
  scQuadPaint();
  scQuadRender();
}

/* 点圆点：选中/取消某一个人（不连带展开整个象限） */
function scQuadDot(i){
  var qd = SC._quad;
  if(!qd || !qd.pts[i]) return;
  SC.quadDot = (SC.quadDot === i) ? null : i;
  SC.quadSel = null;
  scQuadPaint();
  scQuadRender();
}

/* 只改描边/半径，不动整页 */
function scQuadPaint(){
  for(var k = 0; k < 4; k++){
    var el = document.getElementById('scQrect' + k);
    if(!el) continue;
    var on = (SC.quadSel === k);
    el.setAttribute('stroke', on ? '#c2410c' : 'none');
    el.setAttribute('stroke-width', on ? '1.8' : '0');
  }
  var qd = SC._quad;
  if(!qd || !qd.pts) return;
  for(var j = 0; j < qd.pts.length; j++){
    var d = document.getElementById('scQdot' + j);
    if(!d) continue;
    var sel = (SC.quadDot === j);
    d.setAttribute('stroke', sel ? '#c2410c' : 'none');
    d.setAttribute('stroke-width', sel ? 2.4 : '0');
    d.setAttribute('r', sel ? 7.2 : (qd.pts[j].me ? 5.5 : 3.6));
  }
}

/* 与班均的差，写成「班均 520，高 12.4」这种能直接读的句子 */
function scQGap(v, avg){
  if(v == null || avg == null) return '';
  var d = v - avg;
  if(Math.abs(d) < 0.05) return '班均 ' + fmtNum(avg) + '，正好持平';
  return '班均 ' + fmtNum(avg) + '，' + (d > 0 ? '高 ' : '低 ') + fmtNum(Math.abs(d));
}

function scQWhoItem(label, val, avg, rank, gradeN){
  return '<div class="sc-qwho-row"><i>' + esc(label) + '</i>'
    + '<b>' + (val == null ? '—' : fmtNum(val)) + '</b>'
    + '<span>' + esc(scQGap(val, avg)) + '</span>'
    + (rank != null ? '<em>年级第 ' + rank + (gradeN ? ' / ' + gradeN : '') + '（物理方向）</em>' : '<em>年级排名缺</em>')
    + '</div>';
}

function scQuadRender(){
  var qd = SC._quad;
  var box = document.getElementById('scQList');
  if(!qd || !box) return;

  /* ① 只看某一个人 */
  if(SC.quadDot != null){
    var p = qd.pts[SC.quadDot];
    if(!p){ box.innerHTML = ''; return; }
    var gradeN = (SC.exam.gradeRef && SC.exam.gradeRef.students) ? SC.exam.gradeRef.students : null;
    box.innerHTML = '<div class="sc-qwho">'
      + '<div class="sc-qwho-h"><b>' + esc(p.name) + '</b>'
      +   (p.me ? '<em class="sc-qwho-me">我</em>' : '')
      +   '<span class="sc-dim">' + esc(qd.titles[p.q]) + '</span>'
      +   '<button class="sc-qlist-x" onclick="scQuadDot(' + SC.quadDot + ')">收起</button></div>'
      + '<div class="sc-qwho-body">'
      +   scQWhoItem('总分', p.x, qd.totalAvg, p.schoolRank, gradeN)
      +   scQWhoItem(qd.subName, p.y, qd.subAvg, p.subRank, gradeN)
      +   (p.leagueRank != null ? '<div class="sc-qwho-row"><i>联考排名</i><b>' + p.leagueRank + '</b><span></span></div>' : '')
      +   (p.subRaw != null && p.subAsg != null && Math.abs(p.subRaw - p.subAsg) > 0.001
            ? '<div class="sc-qwho-row"><i>' + esc(qd.subName) + '原始/赋分</i><b>' + fmtNum(p.subRaw) + ' → ' + fmtNum(p.subAsg) + '</b><span></span></div>'
            : '')
      + '</div></div>';
    return;
  }

  /* ② 看整个象限 */
  if(SC.quadSel == null){ box.innerHTML = ''; return; }
  var list = qd.pts.filter(function(p){ return p.q === SC.quadSel; });
  /* 偏科预警象限（总分强·单科弱，下标 1）按单科从低到高，先看最该补的；其余按单科从高到低 */
  if(SC.quadSel === 1){ list.sort(function(a, b){ return a.y - b.y; }); }
  else { list.sort(function(a, b){ return b.y - a.y; }); }
  var chips = list.map(function(p){
    return '<button class="sc-qchip' + (p.me ? ' me' : '') + '" onclick="scQuadDot(' + qd.pts.indexOf(p) + ')">'
      + esc(p.name) + '<em>总分 ' + fmtNum(p.x) + ' · ' + fmtNum(p.y) + '</em></button>';
  }).join('');
  box.innerHTML = '<div class="sc-qlist-h"><b>' + esc(qd.titles[SC.quadSel]) + '</b>　共 ' + list.length + ' 人'
    + '<button class="sc-qlist-x" onclick="scQuadTap(' + SC.quadSel + ')">收起</button></div>'
    + (list.length ? '<div class="sc-qlist-body">' + chips + '</div>'
                   : '<div class="sc-dim" style="padding:4px 2px">该象限暂无同学。</div>')
    + (list.length ? '<div class="sc-dim" style="margin-top:6px;font-size:.72rem">点名字看这个人</div>' : '');
}

function scSetQuad(k){ SC.quadKey = k; SC.quadSel = null; SC.quadDot = null; scRenderPane(); }

/* ---------- ⑤ 学生 × 科目热力图 ---------- */
function scHeatmap(){
  var mode = scAllowed('quadrant');
  if(mode === 'hide') return '';
  var subs = SC.exam.subjects || [];
  if(!subs.length || SC.rows.length < 2) return '';

  /* 每科按班内名次映射颜色：越靠前越暖（橙），越靠后越冷（灰） */
  var rk = scRankMap(SC.basis);   /* 提出来算一次：原先每格都重算，60 行 × 6 科白跑 360 遍 */
  var st = scStats(SC.basis);
  var avgs = scSubjAvg();
  /* v3.3.0：手机端没有悬停，所以每格都能点 —— 点开看这个人的总分 / 这一科 / 与班均差。
     数据在这里一次性存好（SC._hm），点击只改 DOM，不重渲染整页（否则手机看明细会跳回顶部）。 */
  var cellIdx = 0;
  var cellsMeta = [];
  var rowsHtml = SC.rows.map(function(r){
    var t = scTotal(r, SC.basis);
    var cells = subs.map(function(sub){
      var v = scSubScore(r, sub, SC.basis);
      var myIdx = cellIdx++;
      var pack0 = (r.s && r.s[sub.key]) || {};
      var sr0 = (SC.basis === 'graded' && sub.graded && pack0.asgRank != null) ? pack0.asgRank : pack0.rank;
      /* 🔴 v3.5.1 修（站主报：「他明明是校排 350，你后面写个班排 350-60」）：
         原来 rank 直接取导入的 pack0.rank —— 那是**年级排名**（导入模版里
         「分数/年级排名」列，见 api/scores.js 的 normalizeScores 注释），
         而 cnt 取的是班内统计人数，于是出现「班内第 350 / 55」这种荒唐输出。
         现在拆成两个口径，各自归位：
           rank      班内名次 —— 用 rk.subj 现场算（格子颜色本来就用它，同源）
           subjRank  该科年级排名 —— 导入才有，没导就不显示这一行
         没导入班排（现在就是这样）也永远有班内名次，不再拿年级排名冒充。 */
      var subjRank0 = (v == null || sr0 == null) ? null : sr0;
      var clsRank0 = (v == null) ? null : ((rk.subj[sub.key] || {}).rank || {})[r.id];
      cellsMeta.push({
        name: r.name, me: scIsMe(r), sub: sub.name, subKey: sub.key,
        v: v, rank: (clsRank0 == null ? null : clsRank0),
        subjRank: subjRank0,
        cnt: (rk.subj[sub.key] || {}).count || null,
        avg: avgs[sub.key], total: t, totalAvg: st.n ? st.avg : null,
        schoolRank: r.schoolRank == null ? null : r.schoolRank,
        leagueRank: r.leagueRank == null ? null : r.leagueRank,
        raw: pack0.raw == null ? null : pack0.raw,
        asg: pack0.assigned == null ? null : pack0.assigned,
      });
      if(v == null) return '<i class="sc-hm sc-hm-na" data-hm="' + myIdx + '"></i>';
      var pack = rk.subj[sub.key] || {};
      var rank = pack.rank[r.id], cnt = pack.count || 1;
      var p = cnt > 1 ? (rank - 1) / (cnt - 1) : 0;   /* 0 = 最好 */
      /* 用「好→深橙、差→浅奶油」两段插值，避免红绿混淆。
         ⚠️ v2.9.12：原来是一条从深橙到近白的连续渐变，中间必然穿过 WCAG 死区
         （底色亮度落在 0.18～0.24 时，白字和深字都到不了 4.5 —— 扫描器实测
         白字仅 4.22）。连续渐变绕不开死区，所以改成两段各自待在安全区：
         前 50% 深橙区（白字 ≥4.5），后 50% 浅奶油区（深字 ≥4.5）。 */
      var cr, cg, cb, q;
      if(p < 0.5){
        cr = Math.round(150 + (175 - 150) * (p / 0.5));
        cg = Math.round(40 + (70 - 40) * (p / 0.5));
        cb = Math.round(8 + (25 - 8) * (p / 0.5));
      } else {
        q = (p - 0.5) / 0.5;
        cr = Math.round(243 + (229 - 243) * q);
        cg = Math.round(228 + (231 - 228) * q);
        cb = Math.round(214 + (235 - 214) * q);
      }
      /* 字色走全站共用 clsReadableOn：底色亮取深字、底色暗取白字，一套逻辑 */
      var ink = clsReadableOn('rgb(' + cr + ',' + cg + ',' + cb + ')') || '#6b5443';
      return '<i class="sc-hm sc-hm-hit" data-hm="' + myIdx + '" style="background:rgb(' + cr + ',' + cg + ',' + cb + ');color:' + ink + '"'
        + ' title="' + esc(r.name) + '　' + esc(sub.name) + ' ' + fmtNum(v) + '（班内第 ' + rank + '）">' + fmtNum(v) + '</i>';
    }).join('');
    return '<div class="sc-hm-row' + (scIsMe(r) ? ' me' : '') + '">'
      + '<span class="sc-hm-name">' + esc(r.name) + '</span>'
      + '<span class="sc-hm-cells">' + cells + '</span>'
      + '<span class="sc-hm-total">' + (t == null ? '—' : fmtNum(t)) + '</span>'
      + '</div>';
  }).join('');
  SC._hm = cellsMeta;

  return '<div class="sc-card sc-card-admin" data-scblk="me_heat"><div class="sc-card-h">学生 × 科目热力图'
    + '<span class="sc-h-note">颜色＝该科班内位置</span>'
    + '<span class="sc-only-admin">仅站主可见</span></div>'
    + '<div class="sc-hm-head"><span class="sc-hm-name"></span><span class="sc-hm-cells">'
    +   subs.map(function(sub){ return '<b>' + esc(sub.name) + '</b>'; }).join('')
    + '</span><span class="sc-hm-total">总分</span></div>'
    + '<div class="sc-hm-body" data-scroll-keep>' + rowsHtml + '</div>'
    + '<div id="scHmList" class="sc-qlist"></div>'
    + '<div class="sc-figcap">每格为该生该科分数；颜色越橙越靠前，越浅越靠后。'
    + '<b>点任意一格看这一格的明细</b>（总分、该科比班均高/低多少、班内与年级名次），再点一次收起。</div>'
    + '</div>';
}

/* 点热力图某格：只更新下方明细区，不动整张表 */
function scHeatTap(el){
  var list = SC._hm;
  var box = document.getElementById('scHmList');
  if(!list || !box) return;
  if(!el){                                  /* 收起按钮：只清选中态 */
    SC.hmSel = null;
    box.innerHTML = '';
    scHmPaint();
    return;
  }
  var i = parseInt(el.getAttribute('data-hm'), 10);
  var c = list[i];
  if(!c){ box.innerHTML = ''; return; }

  /* 再点同一格 → 收起 */
  if(SC.hmSel === i){
    SC.hmSel = null;
    box.innerHTML = '';
    scHmPaint();
    return;
  }
  SC.hmSel = i;
  scHmPaint();

  var gradeN = (SC.exam.gradeRef && SC.exam.gradeRef.students) ? SC.exam.gradeRef.students : null;
  box.innerHTML = '<div class="sc-qwho">'
    + '<div class="sc-qwho-h"><b>' + esc(c.name) + '</b>'
    +   (c.me ? '<em class="sc-qwho-me">我</em>' : '')
    +   '<span class="sc-dim">' + esc(c.sub) + '</span>'
    +   '<button class="sc-qlist-x" onclick="scHeatTap(null)">收起</button></div>'
    + '<div class="sc-qwho-body">'
    +   '<div class="sc-qwho-row"><i>' + esc(c.sub) + '</i><b>' + (c.v == null ? '未考' : fmtNum(c.v)) + '</b>'
    +     '<span>' + (c.v == null ? '' : esc(scQGap(c.v, c.avg))) + '</span>'
    +     (c.rank != null ? '<em>班内第 ' + c.rank + (c.cnt ? ' / ' + c.cnt : '') + '</em>' : '') + '</div>'
    +   '<div class="sc-qwho-row"><i>总分</i><b>' + (c.total == null ? '—' : fmtNum(c.total)) + '</b>'
    +     '<span>' + (c.total == null ? '' : esc(scQGap(c.total, c.totalAvg))) + '</span></div>'
    +   (c.subjRank != null
          ? '<div class="sc-qwho-row"><i>' + esc(c.sub) + '年级排名</i><b>' + c.subjRank + (gradeN ? ' / ' + gradeN : '') + '</b><span></span></div>'
          : '')
    +   (c.schoolRank != null
          ? '<div class="sc-qwho-row"><i>总分年级排名（物理方向）</i><b>' + c.schoolRank + (gradeN ? ' / ' + gradeN : '') + '</b><span></span></div>'
          : '')
    +   (c.leagueRank != null
          ? '<div class="sc-qwho-row"><i>联考排名</i><b>' + c.leagueRank + '</b><span></span></div>'
          : '')
    +   (c.raw != null && c.asg != null && Math.abs(c.raw - c.asg) > 0.001
          ? '<div class="sc-qwho-row"><i>原始 / 赋分</i><b>' + fmtNum(c.raw) + ' → ' + fmtNum(c.asg) + '</b><span></span></div>'
          : '')
    + '</div></div>';
}

/* 给被点中的格子加个描边（只改 class，不重建 DOM） */
function scHmPaint(){
  var body = document.querySelector('.sc-hm-body');
  if(!body) return;
  Array.prototype.forEach.call(body.querySelectorAll('.sc-hm'), function(e){
    var on = (SC.hmSel != null && parseInt(e.getAttribute('data-hm'), 10) === SC.hmSel);
    e.classList.toggle('on', on);
  });
}

function scSetTrendN(n){
  SC.trendN = n;
  SC.trendSet = true;
  scRenderPane();
}

function shortName(n){
  var s = String(n || '');
  return s.length > 8 ? s.slice(0, 7) + '…' : s;
}

function showCurrentHomework(forceId){
  var mask = document.getElementById('hwCurrentMask');
  var title = document.getElementById('hwCurrentTitle');
  var list = document.getElementById('hwCurrentList');
  if(!mask || !list) return;
  /* v3.5.42（站主 #2）：可以看/导出之前某一期作业，不再只能看「当前」那一份。
     forceId 由下拉框给出；不传则仍按「今天落在哪一期 / 最近一期」自动选。 */
  var all = (window.SITE_DATA && SITE_DATA.holidayHomeworks) || [];
  var hw = null;
  if(forceId){
    for(var fi = 0; fi < all.length; fi++){
      if(String(all[fi].id) === String(forceId)){ hw = all[fi]; break; }
    }
  }
  if(!hw) hw = getCurrentHomework();
  window.__HW_VIEWING = hw || null;

  /* 下拉：最近的排在前面 */
  var sel = document.getElementById('hwPickSel');
  if(sel){
    sel.innerHTML = all.slice().reverse().map(function(x){
      return '<option value="' + attr(x.id) + '"' + (hw && String(x.id) === String(hw.id) ? ' selected' : '') + '>'
        + esc(x.title) + '（' + esc(x.start || '') + ' ~ ' + esc(x.end || '') + '）</option>';
    }).join('');
    sel.onchange = function(){ showCurrentHomework(sel.value); };
  }
  if(!hw){
    if(title) title.textContent = '当前作业';
    list.innerHTML = '<div style="padding:24px;text-align:center;color:#6e635a">暂未找到当前作业记录。<br>请通过「历史作业（日期）」日历查看所有已同步的作业。</div>';
    mask.classList.add('show');
    return;
  }
  if(title) title.textContent = hw.title + '（' + hw.start + ' ~ ' + hw.end + '）';
  var demoHtml = hw.isDemo
    ? '<div style="background:#fff7ed;border:1px solid #ffd8a8;color:#d46b08;padding:10px 12px;border-radius:10px;font-size:.82rem;font-weight:700;margin-bottom:12px">⚠️ 示例测试数据，并非真实作业</div>'
    : '';
  list.innerHTML = demoHtml + _renderHwItems(hw.items, hw.id);
  mask.classList.add('show');
}
function closeHwCurrent(){ var m=document.getElementById('hwCurrentMask'); if(m) m.classList.remove('show'); }

/* ============================================================================
 * v3.5.40（站主 #7）：作业导出图片 / 分享
 * ----------------------------------------------------------------------------
 * 站主原话：「作业支持导出图片（包含名称，对应作业，时间范围，
 *           作业对应的图片直链等等）也支持分享的功能」
 *
 * 内容怎么摆：
 *   标题   = 作业名称（如「国庆假期作业（10.1–10.7）」）
 *   副标题 = 时间范围 start ~ end
 *   徽章   = 共几科 / 几项任务
 *   分段   = 每个科目一段，一行一项作业；配了图的，下面单独一行写「图片：<直链>」
 *          （不把图片嵌进 canvas —— 跨域图片会污染画布，导不出来；
 *            直链本身就是站主要求的内容，拿到链接自己也能打开）
 *   页脚   = 站点名 + 生成时间
 * 分享走 navigator.share；不支持就自动退回下载，绝不出现「点了没反应」。
 * ========================================================================= */
/* ============================================================================
 * v3.8.5（站主）：作业直链进导出图
 * ----------------------------------------------------------------------------
 * 站主原话：
 *   「以后导出作业图片，若作业内含直链的也要显示：如果是图片直链则直接把图片
 *     显示在照片上；如果是音频或视频直链就转成二维码，用户扫描后可以跳转至班级
 *     网站并直接打开对应的音频或视频。」
 *
 * 三类处理：
 *   图片  → 直接画进图里（先 fetch 成 blob 再画，避免跨域污染 canvas）
 *   音视频 → 画二维码，扫码打开 index.html?play=<地址>，站内播放器直接放
 *   其它链接 → 保持原来的文字行，不做处理
 * ========================================================================= */
function hwLinkKind(u){
  var url = String(u || '').trim();
  if(!/^https?:\/\//i.test(url)) return '';
  var path = url.split('#')[0].split('?')[0].toLowerCase();
  if(/\.(png|jpe?g|gif|webp|bmp|avif|svg)$/.test(path)) return 'image';
  if(/\.(mp3|m4a|aac|wav|ogg|oga|flac|opus)$/.test(path)) return 'audio';
  if(/\.(mp4|webm|mov|m4v|ogv|mkv)$/.test(path)) return 'video';
  return '';
}

/* 用 fetch 取图再画：直接给 <img> 加 crossOrigin 时，图床不带 CORS 头就会
   污染 canvas，toBlob 直接抛 SecurityError，整张图都导不出来。
   fetch 失败就降级成一行文字，绝不让整张图挂掉。 */
function hwLoadImage(url){
  return fetch(url, { mode: 'cors', credentials: 'omit' }).then(function(r){
    if(!r.ok) throw new Error('HTTP ' + r.status);
    return r.blob();
  }).then(function(b){
    return new Promise(function(resolve, reject){
      var obj = URL.createObjectURL(b);
      var im = new Image();
      im.onload = function(){
        /* 不 revoke：画的时候还要用 */
        resolve(im);
      };
      im.onerror = function(){ URL.revokeObjectURL(obj); reject(new Error('图片解码失败')); };
      im.src = obj;
    });
  });
}

/* 扫码后打开站内播放页（不带 token，谁扫都能直接看） */
function hwPlayUrl(u){
  try{
    return new URL('index.html?play=' + encodeURIComponent(u), location.href).href;
  }catch(e){ return u; }
}

function hwQrCanvas(text, px){
  try{
    var q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    var n = q.getModuleCount();
    var cell = Math.max(2, Math.floor(px / n));
    var size = cell * n;
    var cv = document.createElement('canvas');
    cv.width = cv.height = size;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#141210';
    for(var r = 0; r < n; r++){
      for(var c = 0; c < n; c++){
        if(q.isDark(r, c)) ctx.fillRect(c * cell, r * cell, cell, cell);
      }
    }
    return cv;
  }catch(e){ return null; }
}

/* 站内播放器：扫码/点链接后直接放，不用下载 */
function openMediaPlayer(url, label){
  if(!/^https?:\/\//i.test(String(url || ''))) return;
  var kind = hwLinkKind(url);
  var isV = kind === 'video' || (!kind && /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url));
  var old = document.getElementById('mediaPlayMask');
  if(old && old.parentNode) old.parentNode.removeChild(old);
  var d = document.createElement('div');
  d.id = 'mediaPlayMask';
  d.className = 'allboard-mask show';
  d.innerHTML = '<div class="allboard-box" style="max-width:560px;width:94vw">'
    + '<div class="allboard-head"><span>' + esc(label || (isV ? '视频播放' : '音频播放')) + '</span>'
    +   '<button type="button" onclick="closeMediaPlayer()">关闭</button></div>'
    + '<div style="padding:12px">'
    +   (isV
          ? '<video src="' + attr(url) + '" controls autoplay playsinline style="width:100%;border-radius:12px;background:#000"></video>'
          : '<audio src="' + attr(url) + '" controls autoplay style="width:100%"></audio>')
    +   '<p class="guest-tip" style="margin-top:10px">'
    +     '如果浏览器拦了自动播放，点一下播放键就行。'
    +     '<a href="' + attr(url) + '" target="_blank" rel="noopener" style="margin-left:8px">新窗口打开</a>'
    +   '</p>'
    + '</div></div>';
  document.body.appendChild(d);
  d.addEventListener('click', function(e){ if(e.target === d) closeMediaPlayer(); });
}
function closeMediaPlayer(){
  var m = document.getElementById('mediaPlayMask');
  if(!m) return;
  var v = m.querySelector('video, audio');
  if(v){ try{ v.pause(); }catch(e){} }
  if(m.parentNode) m.parentNode.removeChild(m);
}

/* 启动时看有没有 ?play= */
function playLinkBoot(){
  var p = null;
  try{ p = new URLSearchParams(location.search).get('play'); }catch(e){}
  if(!p) return false;
  if(!/^https?:\/\//i.test(p)) return false;
  openMediaPlayer(p, '');
  return true;
}

/* 作业查看是哪张卡片：按标题找，找不到退回「常用服务 → 2」 */
function hwBoardRef(){
  var links = (window.SITE_DATA && SITE_DATA.links) || [];
  for(var i = 0; i < links.length; i++){
    if(/作业/.test(links[i].title || '')) return { boardId: links[i].categoryId, card: String(links[i].id) };
  }
  return { boardId: 1, card: '2' };
}

function hwExportImage(mode){
  if(typeof ShareCard === 'undefined'){
    if(typeof uiMsg === 'function') uiMsg('图片组件没加载出来，请刷新页面重试', '#af410f');
    return;
  }
  /* 导出「正在看的那一份」（下拉可选以前的），不是永远导出当天 */
  var hw = window.__HW_VIEWING || getCurrentHomework();
  if(!hw){
    if(typeof uiMsg === 'function') uiMsg('没有可导出的作业', '#af410f');
    return;
  }

  var items = hw.items || [];
  var totalTasks = 0;
  var seen = {};
  var imgJobs = [];

  /* 一条直链只画一次：图片进 media 等加载，音视频当场生成二维码 */
  function addMedia(list, kind, url, label){
    var u = String(url || '').trim();
    if(!u || seen[u]) return;
    seen[u] = 1;
    var md = { kind: kind, url: u, label: label || '', img: null, qr: null };
    if(kind === 'image'){
      imgJobs.push(hwLoadImage(u).then(function(im){ md.img = im; })
        .catch(function(){ md.__fail = true; }));
    }else{
      md.qr = hwQrCanvas(hwPlayUrl(u), 224);
    }
    list.push(md);
  }

  var sections = items.map(function(it){
    var rows = [], media = [];
    (it.tasks || []).forEach(function(t){
      var obj = (t && typeof t === 'object') ? t : { text: String(t == null ? '' : t) };
      var text = obj.text || '';
      var img = obj.img || '';
      var audio = obj.audio || '';
      var video = obj.video || '';
      if(text) { rows.push({ l: text, r: '' }); totalTasks++; }
      else if(img || audio || video) { totalTasks++; }

      if(img) addMedia(media, 'image', img, text);
      if(audio) addMedia(media, hwLinkKind(audio) === 'video' ? 'video' : 'audio', audio, text);
      if(video) addMedia(media, 'video', video, text);

      /* 正文里直接写出来的直链也认：是图片就直接画，是音视频就转二维码 */
      var urls = text.match(/https?:\/\/[^\s，。、）)】"'<>]+/g) || [];
      urls.forEach(function(u){
        var k = hwLinkKind(u);
        if(k) addMedia(media, k, u, '');
      });
    });
    return { heading: it.subject || '其他', rows: rows, lines: [], media: media };
  }).filter(function(s){ return s.rows.length || s.media.length; });

  function finish(){
    /* 图片取不到（图床没开 CORS / 404）→ 退回一行文字链接，不能让整张图失败 */
    sections.forEach(function(sec){
      sec.media = sec.media.filter(function(m){
        if(m.__fail){
          sec.lines.push((m.kind === 'image' ? '图片：' : '链接：') + m.url);
          return false;
        }
        if((m.kind === 'audio' || m.kind === 'video') && !m.qr){
          sec.lines.push(m.url);
          return false;
        }
        return true;
      });
    });

    var card = {
      title: hw.title || '作业',
      subtitle: (hw.start || '') + ' ~ ' + (hw.end || ''),
      badges: ['共 ' + items.length + ' 科', totalTasks + ' 项任务'],
      sections: sections,
      footer: '由 25级05班 班级服务站生成 · ' + new Date().toLocaleDateString('zh-CN'),
      badge: (typeof siteBadgeList === 'function') ? siteBadgeList() : siteBadgeUrl(),
      /* v3.8.7（站主）：「字号大一点」「尽量一张 A4」「底部附板块分享二维码」 */
      large: true,
      qr: qrCanvas || null,
      qrLabel: '扫码打开「作业查看」· 其他页面需登录',
      minHeight: Math.round(760 * 1.414),
    };
    var fname = '作业-' + String(hw.start || '').replace(/[^0-9]/g, '') + '.png';

    if(mode === 'share'){
      ShareCard.share(card, fname).then(function(r){
        if(r && r.shared) return;
        if(r && r.canceled) return;
        if(typeof uiMsg === 'function') uiMsg('这个浏览器不支持直接分享，图片已保存到下载', '#2f7d4f');
      }).catch(function(e){
        if(typeof uiMsg === 'function') uiMsg('分享失败：' + (e.message || e), '#b3261e');
      });
    } else {
      ShareCard.download(card, fname).then(function(){
        if(typeof uiMsg === 'function') uiMsg('图片已生成，去相册/下载里找一下', '#2f7d4f');
      }).catch(function(e){
        if(typeof uiMsg === 'function') uiMsg('生成失败：' + (e.message || e), '#b3261e');
      });
    }
  }

  /* 先拿「作业查看」这张卡片的分享链接（后台已建过就直接复用），再画二维码 */
  var qrCanvas = null;
  var ref = hwBoardRef();
  var linkJob = Promise.resolve();
  if(typeof api === 'function'){
    linkJob = api('/boards?action=ensure-link', { method: 'POST', body: ref })
      .then(function(j){
        var u = String((j && j.url) || '').replace(/^\/+/, '');
        if(!u) return;
        qrCanvas = hwQrCanvas(new URL(u, location.href).href, 300);
      })
      .catch(function(){ /* 没登录 / 接口挂了就不印二维码，不影响出图 */ });
  }

  if(imgJobs.length && typeof uiMsg === 'function') uiMsg('正在把作业里的图片一起画进去…', '#8a6a55');
  Promise.all([linkJob, Promise.all(imgJobs)]).then(finish);
}

var _hwCalMonth = null;
function showHomeworkCalendar(){
  var cm = document.getElementById('hwCurrentMask'); if(cm) cm.classList.remove('show');
  var mask = document.getElementById('hwCalendarMask');
  if(!mask) return;
  if(!_hwCalMonth){
    var d = new Date();
    _hwCalMonth = { y: d.getFullYear(), m: d.getMonth() };
  }
  _renderHwCalendar();
  mask.classList.add('show');
}
function closeHwCalendar(){ var m=document.getElementById('hwCalendarMask'); if(m) m.classList.remove('show'); }
function hwCalNav(delta){
  _hwCalMonth.m += delta;
  if(_hwCalMonth.m < 0){ _hwCalMonth.m += 12; _hwCalMonth.y--; }
  if(_hwCalMonth.m > 11){ _hwCalMonth.m -= 12; _hwCalMonth.y++; }
  _renderHwCalendar();
}
function _renderHwCalendar(){
  var title = document.getElementById('hwCalTitle');
  var body = document.getElementById('hwCalBody');
  var detail = document.getElementById('hwCalDetail');
  if(!title || !body) return;
  title.textContent = _hwCalMonth.y + '年' + (_hwCalMonth.m+1) + '月';
  var first = new Date(_hwCalMonth.y, _hwCalMonth.m, 1);
  var lastDay = new Date(_hwCalMonth.y, _hwCalMonth.m+1, 0).getDate();
  var startWeek = first.getDay();
  var todayStr = _hwDateStr(new Date());
  var html = '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;text-align:center;font-size:.78rem;color:#6e635a;margin-bottom:6px">';
  ['日','一','二','三','四','五','六'].forEach(function(d){ html += '<div>'+d+'</div>'; });
  html += '</div><div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px">';
  for(var i=0;i<startWeek;i++) html += '<div></div>';
  for(var d=1; d<=lastDay; d++){
    var dStr = _hwCalMonth.y+'-'+pad2(_hwCalMonth.m+1)+'-'+pad2(d);
    var hw = _findHwByDate(dStr);
    var isToday = dStr === todayStr;
    var style = 'padding:8px 0;border-radius:8px;cursor:pointer;font-size:.85rem;text-align:center;';
    if(hw){ style += 'background:#9a3412;color:#fff;font-weight:700;'; }
    else if(isToday){ style += 'border:2px solid #9a3412;color:#af410f;font-weight:700;'; }
    else { style += 'color:#57534e;'; }
    html += '<div data-d="'+dStr+'" style="'+style+'">'+d+'</div>';
  }
  html += '</div>';
  body.innerHTML = html;
  if(detail) detail.style.display = 'none';
  Array.prototype.forEach.call(body.querySelectorAll('[data-d]'), function(el){
    el.addEventListener('click', function(){
      var d = el.getAttribute('data-d');
      var hw = _findHwByDate(d);
      if(!detail) return;
      detail.style.display = 'block';
      if(hw){
        detail.innerHTML = '<div style="font-weight:700;color:#af410f;margin:0 0 8px">'+emojiEscHtml(hw.title)+'（'+hw.start+' ~ '+hw.end+'）</div>' +
          (hw.isDemo ? '<div style="background:#fff7ed;border:1px solid #ffd8a8;color:#d46b08;padding:8px 10px;border-radius:8px;font-size:.78rem;font-weight:700;margin-bottom:8px">⚠️ 示例测试数据，并非真实作业</div>' : '') +
          _renderHwItems(hw.items, hw.id);
      }else{
        detail.innerHTML = '<div style="padding:6px 0;color:#6e635a;font-size:.85rem">该日期暂无作业记录。</div>';
      }
    });
  });
}
/* 备份包下载：优先 .zip；被 WAF 拦截（某些托管域名按后缀封禁 .zip）时回退无扩展名副本。
   用 fetch + blob 触发下载，统一把文件名写成 class-site-backup.zip，用户拿到的始终是 zip。 */
function downloadBackup(){
  var cands=['./class-site-backup.zip','./class-site-backup'];
  var i=0;
  function fail(){
    var err=document.getElementById('exportErr');
    if(err){ err.style.display='block'; err.textContent='备份包下载失败，请稍后重试或联系站主'; }
  }
  function next(){
    if(i>=cands.length){
      // 兜底：file:// 等 fetch 不可用场景，回到直接跳转
      if(location.protocol==='file:'){ window.location.href='./class-site-backup.zip'; return; }
      fail();
      return;
    }
    var url=cands[i++];
    fetch(url,{cache:'no-store'}).then(function(r){
      if(!r.ok) throw new Error('http '+r.status);
      var ct=(r.headers && r.headers.get ? (r.headers.get('content-type')||'') : '');
      if(ct.indexOf('text/html')>=0) throw new Error('html page');
      return r.blob();
    }).then(function(b){
      if(!b || b.size<2048) throw new Error('bad size');
      var u=URL.createObjectURL(b);
      var a=document.createElement('a');
      a.href=u; a.download='class-site-backup.zip';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function(){ URL.revokeObjectURL(u); },5000);
    }).catch(function(){ next(); });
  }
  try{ next(); }catch(e){ fail(); }
}
function submitExport(){
  var inp=document.getElementById('exportPassInput');
  var err=document.getElementById('exportErr');
  if(!inp) return;
  if(err) err.style.display='block';
  var remain=lockRemain('export');
  if(remain>0){
    startLockTimer('export', err, inp);
    return;
  }
  var h = sha256Hex(inp.value);
  if(h && h===EXPORT_PASS_HASH){
    onPassOk('export');
    if(__lockTimers['export']) clearInterval(__lockTimers['export']);
    if(err) err.style.display='none';
    SFX.success();
    downloadBackup();
    closeExport();
  } else {
    var r = onPassFail('export');
    SFX.error();
    if(err){
      err.style.display='block';
      err.textContent = r.remain > 0
        ? '密码错误，已连续错误 ' + r.count + ' 次，请 ' + Math.ceil(r.remain/1000) + ' 秒后再试'
        : '密码错误，请重试';
    }
    if(inp) inp.value='';
    if(r.remain > 0) startLockTimer('export', err, inp);
  }
}

loadUI();
applyUICfg();   /* 【自定义设置】初始化：应用字号/背景/动效/首页顺序 */
/* v2.5.0 去 emoji：把写死在 HTML 里的 emoji 一次性换成 SVG 图标。
   ⚠️ 只在这里跑一次，且**不注册任何 DOM 监听** —— 倒计时每秒重写也影响不到它，
      这是「不再闪烁」的关键。option 里放不了 SVG，单独去 emoji 保留文字。 */
try{ iconifyStatic(document.body); }catch(e){}
try{ stripEmojiInOptions(document); }catch(e){}
applyHash();
updateCountdown();
setInterval(updateCountdown, 1000);
/* v3.7.0（站主 #2）：先套缓存，再画首屏 —— 保证第一眼看到的是上次的云端内容，
   而不是 HTML 里写死的旧快照。云端内容由 contentBoot 在后台补拉，回来后再重绘。 */
contentCacheBootstrap(false);
goHomeView();
/* v3.9.4（站主）：「每次进页面都要等 10 秒钟才能完全加载出来」
   ------------------------------------------------------------
   根因：首屏内容原来**只有一条渲染路径** —— boardShareBoot() → boardMetaLoad()
   等 /api/boards?action=meta 回来才 render()。那是个 Cloudflare Worker + Neon
   查询，实测 1.3~3.9 秒，同学手机慢网 + 数据库冷启时轻松 10 秒；
   这期间公告 / 日报 / 一言 / 板块卡片全是空的，就是站主看到的「骨架屏」。

   修法：先用 HTML 里自带的 SITE_DATA（叠加刚套上的云端缓存）**同步画一屏**，
   用户瞬间看到内容；接口回来后该刷新刷新（boardMetaLoad 与 syncCloudContent
   里本来就有 render / rerenderAll），数据一个不少。 */
try{ render(); }catch(e){ console.warn('[boot] 首屏渲染失败，等接口回来再画', e); }
/* v3.7.6：启动后算一次自定义背景的平均色，并给当前可见的弹窗校准字色 */
try{ if(typeof mkSampleBg === 'function') setTimeout(mkSampleBg, 500); }catch(e){}
try{ if(typeof mkScanAll === 'function') mkScanAll(900); }catch(e){}
/* 返回记忆：从外链/小游戏返回时，恢复到跳转前的视图（隐藏空间/分类/首页）。
 * 必须在 goHomeView() 之后执行，否则会被其覆盖回首页 */
(function(){
  var v = null;
  try{ v = sessionStorage.getItem('cls_return_view'); sessionStorage.removeItem('cls_return_view'); }catch(e){}
  if(v === 'hidden'){
    var hm = document.getElementById('hiddenViewMask');
    if(hm && !hm.classList.contains('show')) openHiddenView();
  }else if(v && v.indexOf('cat_') === 0){
    openCat(parseInt(v.slice(4), 10));
  }else if(v === 'home'){
    goHomeView();
  }
})();
/* 暗黑模式切换（含夜间自动模式询问） */
function toggleTheme(ev){
  var d = document.documentElement;
  var isDark = d.classList.contains('dark');
  var next = !isDark;
  /* 自动模式下、且当前在夜间想切回亮色 → 弹窗让用户选「仅这次 / 改模式 / 关闭」 */
  if(themeAutoEnabled() && isNightTime() && !next){
    openThemeAutoAsk();
    return;
  }
  /* 【自定义设置】Radial Theme Transition：把点击点作为扩散圆心 */
  var _c = themeRippleCenter(ev);
  try{ localStorage.setItem('cls_theme', next ? 'dark' : 'light'); }catch(e){}
  /* v2.5.3：自动模式下手动切换 = 用户明确表态，标记「今天别再自动切我」，
     否则 30 秒后就被自动逻辑弹回去，体验很糟。
     切回暗色同理 —— 用户想要的当前状态应该被保住，直到明天或改模式。 */
  if(themeAutoEnabled()){
    try{ localStorage.setItem('cls_theme_hold', sunTodayKey()); }catch(e){}
  }
  radialTheme(_c.x, _c.y, next);
  /* v3.7.6：手动切昼夜后，等过渡动画过半再校准弹窗字色 */
  try{ if(typeof mkScanAll === 'function') mkScanAll(380); }catch(e){}
  /* 连续切换白天/黑夜 → 彩带彩蛋 */
  _themeRhythm++;
  if(_themeRhythmTimer) clearTimeout(_themeRhythmTimer);
  _themeRhythmTimer = setTimeout(function(){ _themeRhythm = 0; }, 1600);
  if(_themeRhythm >= 3){ _themeRhythm = 0; confettiEgg(); }
}
/* ============================================================
   主题自动切换（v2.5.3 站主要求：改「三选一」）
   ------------------------------------------------------------
   以前只有一种规则：每天 18:30 变暗、次日 7:30 变亮（写死）。
   站主希望改成**可选**，于是拆成三种模式，存在 localStorage：
     · 'off'    —— 关闭自动，完全手动
     · 'system' —— 跟随系统深色偏好（prefers-color-scheme）
     · 'sun'    —— 跟随**真实日出日落**（联网查 API，失败用本地天文计算兜底）
   站主原话：「可以设置打开时的默认背景颜色以及是否需要跟随系统及日出日落的时间自动更改」
   —— 这里的「默认背景」即自动切换的结果：亮色一套、暗色一套，随模式自动生效。

   ⚠️ 兼容：老的 cls_theme_auto 只有 'off' / 其他 两态。
     迁移规则：'off' → 'off'；其他（含未设置）→ 'system'。
     为什么不默认给 'sun'？因为 sun 要联网，首次加载不该为它卡一下；
     而且「跟随系统」是多数手机用户的直觉预期。
   ============================================================ */
var THEME_AUTO_KEY = 'cls_theme_auto2';      /* 新键，避免与老键语义混淆 */
var THEME_MODES = ['off', 'system', 'sun'];

function themeAutoMode(){
  var m = null;
  try{ m = localStorage.getItem(THEME_AUTO_KEY); }catch(e){}
  if(THEME_MODES.indexOf(m) >= 0) return m;
  /* 一次性迁移老键 */
  var old = null;
  try{ old = localStorage.getItem('cls_theme_auto'); }catch(e){}
  var migrated = (old === 'off') ? 'off' : 'system';
  try{ localStorage.setItem(THEME_AUTO_KEY, migrated); }catch(e){}
  return migrated;
}
function setThemeAutoMode(m){
  if(THEME_MODES.indexOf(m) < 0) m = 'system';
  try{ localStorage.setItem(THEME_AUTO_KEY, m); }catch(e){}
  /* 同步写一份老键，供可能残留的旧读取方（以及跨版本回退）保持一致 */
  try{ localStorage.setItem('cls_theme_auto', m === 'off' ? 'off' : 'on'); }catch(e){}
  /* 用户主动改了模式，「仅这次切换」的临时保持失效 */
  try{ localStorage.removeItem('cls_theme_hold'); }catch(e){}
  if(m === 'sun') sunFetch();          /* 切到日出日落：立刻拉一次 */
  applyAutoTheme(true);
  /* 若设置面板正开着，重绘以更新当前模式高亮与提示 */
  if(typeof UI_SEC !== 'undefined' && UI_SEC === 'look'
     && document.getElementById('uiSetBody')
     && document.getElementById('uiSetMask') && document.getElementById('uiSetMask').classList.contains('show')){
    if(typeof renderSettings === 'function') renderSettings();
  }
}
/* 旧函数名保留（别处还在用），语义 = 「是否不是 off」 */
function themeAutoEnabled(){ return themeAutoMode() !== 'off'; }
function isSystemDark(){
  try{
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }catch(e){ return false; }
}

/* ---------- 日出日落（v2.5.3 新增）----------
   修水县城约 114.55°E, 29.03°N。站主选「联网查免费 API」，
   但网络不可靠（校园网 / 弱信号 / API 挂了），所以一定带**本地兜底**：
     ① 先看今天有没有缓存（存 localStorage，同一天不重复请求）
     ② 没有就异步查 sunrise-sunset.org（国内可达，实测首字节 ~0.9s）
     ③ 失败 → 立刻用 NOAA 本地天文算法算（实测与 API 只差 1–2 分钟）
   这样「离线也不会退化成写死的 18:30」。 */
var SUN_POS = { lat: 29.03, lng: 114.55 };   /* 江西九江修水县 */
var _sunCache = { date: '', rise: 6 + 20/60, set: 18 + 0/60 };  /* 默认值仅作最后兜底 */

/** NOAA 简化算法算日出/日落（本地小时，浮点）。
 *  与 API 实测只差 1–2 分钟，足够判断「现在是不是白天」。 */
function sunCalcLocal(dateObj){
  var lat = SUN_POS.lat, lng = SUN_POS.lng, tz = -dateObj.getTimezoneOffset() / 60;
  var N = Math.floor((Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate())
        - Date.UTC(dateObj.getFullYear(), 0, 0)) / 86400000);
  function calc(isRise){
    var lngHour = lng / 15;
    var t = N + (((isRise ? 6 : 18) - lngHour) / 24);
    var M = (0.9856 * t) - 3.289;
    var L = M + 1.916 * Math.sin(M * Math.PI / 180) + 0.020 * Math.sin(2 * M * Math.PI / 180) + 282.634;
    L = ((L % 360) + 360) % 360;
    var RA = Math.atan(0.91764 * Math.tan(L * Math.PI / 180)) * 180 / Math.PI;
    RA = ((RA % 360) + 360) % 360;
    var Lq = Math.floor(L / 90) * 90, RAq = Math.floor(RA / 90) * 90;
    RA = (RA + (Lq - RAq)) / 15;
    var sinDec = 0.39782 * Math.sin(L * Math.PI / 180);
    var cosDec = Math.cos(Math.asin(sinDec));
    var cosH = (Math.cos(90.833 * Math.PI / 180) - sinDec * Math.sin(lat * Math.PI / 180))
             / (cosDec * Math.cos(lat * Math.PI / 180));
    cosH = Math.max(-1, Math.min(1, cosH));
    var H = isRise
      ? (360 - Math.acos(cosH) * 180 / Math.PI) / 15
      : (Math.acos(cosH) * 180 / Math.PI) / 15;
    var T = H + RA - (0.06571 * t) - 6.622;
    var UT = ((T - lngHour) % 24 + 24) % 24;
    return ((UT + tz) % 24 + 24) % 24;
  }
  return { rise: calc(true), set: calc(false) };
}
function sunTodayKey(){
  var d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}
/** 同步取「今天」的日出日落：有缓存用缓存，否则先算本地值（保证立即有数），
 *  API 回来后再更新（见 sunFetch）。 */
function sunTimes(){
  var k = sunTodayKey();
  if(_sunCache.date === k) return _sunCache;
  var loc = sunCalcLocal(new Date());
  _sunCache = { date: k, rise: loc.rise, set: loc.set, src: 'local' };
  return _sunCache;
}
/** 异步查 API 覆盖本地估算（每天只请求一次；失败静默保留本地值） */
function sunFetch(){
  var k = sunTodayKey();
  var flag = '__sunFetched_' + k;
  if(window[flag]) return;          /* 今天已查过 */
  window[flag] = true;
  try{
    var url = 'https://api.sunrise-sunset.org/json?lat=' + SUN_POS.lat
            + '&lng=' + SUN_POS.lng + '&formatted=0&date=today';
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var to = ctrl ? setTimeout(function(){ ctrl.abort(); }, 8000) : null;
    fetch(url, { signal: ctrl ? ctrl.signal : undefined })
      .then(function(r){ if(to) clearTimeout(to); return r.json(); })
      .then(function(j){
        if(!j || j.status !== 'OK' || !j.results) throw new Error('bad payload');
        /* 返回的是 UTC 时间，转成本地小时（含分钟） */
        var rise = new Date(j.results.sunrise);
        var set  = new Date(j.results.sunset);
        var rh = rise.getHours() + rise.getMinutes() / 60;
        var sh = set.getHours()  + set.getMinutes()  / 60;
        if(!(rh >= 0 && rh <= 24) || !(sh >= 0 && sh <= 24)) throw new Error('bad time');
        _sunCache = { date: k, rise: rh, set: sh, src: 'api' };
        applyAutoTheme(true);        /* 拿到精确值后重算一次 */
      })
      .catch(function(){
        if(to) clearTimeout(to);
        /* 静默：本地天文计算的值已经在用了，不需要打扰用户 */
      });
  }catch(e){ /* fetch 不可用等极端情况，保持本地值 */ }
}
/** 现在是不是「夜间」= 在日落之后、次日日出之前 */
function isNightTime(){
  var mode = themeAutoMode();
  if(mode === 'system') return isSystemDark();
  if(mode === 'sun'){
    var t = sunTimes();
    var d = new Date(), now = d.getHours() + d.getMinutes() / 60;
    /* 日落早于日出（跨零点）：now >= set 或 now < rise 都算夜 */
    if(t.set > t.rise) return now >= t.set || now < t.rise;
    return now >= t.set && now < t.rise;
  }
  return false;   /* 'off' */
}
var _lastAutoNight=null;
/** @param {boolean} [force] 强制重算并应用（设置变更 / API 回来时用） */
function applyAutoTheme(force){
  var mode = themeAutoMode();
  if(mode === 'off'){
    _lastAutoNight = null;
    return;
  }
  /* 🔴 v2.5.3 真 bug 修复：必须在这里检查 hold，不能只放在 initTheme / 轮询里。
     否则以下三条路径都会无视「仅这次切换」，把用户手动选的亮色弹回去：
       ① 页面启动时无条件调用的 applyAutoTheme(true)
       ② 系统主题变化监听（matchMedia change）
       ③ sunFetch() 拿到 API 数据后的重算
     判定统一收口于此：当天手动改过 → 自动逻辑整体让位。 */
  var hold = null;
  try{ hold = localStorage.getItem('cls_theme_hold'); }catch(e){}
  if(hold && hold === sunTodayKey()){
    _lastAutoNight = null;   /* 状态复位，明天 hold 失效后能正常接管 */
    return;
  }
  sunTimes();                     /* 确保有今天的日出日落（可能触发本地估算） */
  var night = isNightTime();
  if(!force && night === _lastAutoNight) return;
  _lastAutoNight = night;
  var wantDark = night;
  var dark = document.documentElement.classList.contains('dark');
  if(dark !== wantDark){
    document.documentElement.classList.toggle('dark', wantDark);
    try{ localStorage.setItem('cls_theme', wantDark?'dark':'light'); }catch(e){}
    var b = document.getElementById('themeToggle');
    if(b) b.innerHTML = wantDark ? iconSvg('sun',17) : iconSvg('moon',17);
    if(typeof applyBg === 'function') applyBg();   /* 【自定义设置】蒙层随主题切换 */
    /* v3.7.6：昼夜切换后重算弹窗字色 */
    try{ if(typeof mkScanAll === 'function') mkScanAll(160); }catch(e){}
  }
}
/* 系统主题变化监听：mode='system' 时立刻跟随 */
if(window.matchMedia){
  try{
    var _mql = window.matchMedia('(prefers-color-scheme: dark)');
    var _mqlHandler = function(){ if(themeAutoMode() === 'system') applyAutoTheme(true); };
    if(_mql.addEventListener) _mql.addEventListener('change', _mqlHandler);
    else if(_mql.addListener) _mql.addListener(_mqlHandler);   /* 老浏览器 */
  }catch(e){}
}
/* 主题自动切换三选弹窗（v2.5.3：文案由「夜间自动」改为「自动切换」，并给出当前模式） */
function themeAskHint(){
  var el = document.getElementById('themeAskHint');
  if(!el) return;
  var m = themeAutoMode();
  var t;
  if(m === 'system') t = '当前模式：跟随系统（系统开了深色就自动变暗）';
  else if(m === 'sun'){
    var s = sunTimes();
    var f = function(h){ var hh = Math.floor(h), mm = Math.round((h - hh) * 60);
      if(mm === 60){ hh++; mm = 0; } return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm; };
    t = '当前模式：跟随日出日落（今天 ' + f(s.rise) + ' 日出 / ' + f(s.set) + ' 日落）';
  } else t = '当前模式：关闭自动切换';
  el.textContent = t;
}
function openThemeAutoAsk(){
  themeAskHint();
  var m = document.getElementById('themeAutoAskMask');
  if(m){ m.classList.add('show'); SFX.pop(); }
}
function closeThemeAutoAsk(){ var m=document.getElementById('themeAutoAskMask'); if(m) m.classList.remove('show'); }
function applyLightTheme(){
  var d=document.documentElement;
  if(d.classList.contains('dark')) d.classList.remove('dark');
  try{ localStorage.setItem('cls_theme','light'); }catch(e){}
  var b=document.getElementById('themeToggle'); if(b) b.innerHTML=iconSvg('moon',17);
}
/* 仅这次切换为亮色：不改自动模式，但要避免立刻被切回去 —— 记一个「今天先别管」的软标记 */
function themeAskOnce(){
  closeThemeAutoAsk();
  applyLightTheme();
  _lastAutoNight = null;   /* 下次自动检查会重新判断；此处静默期由 ignoreUntil 控制 */
  try{ localStorage.setItem('cls_theme_hold', sunTodayKey()); }catch(e){}
  SFX.success();
}
/* 关闭自动切换（保持亮色） */
function themeAskOff(){
  closeThemeAutoAsk();
  setThemeAutoMode('off');
  applyLightTheme();
  SFX.success();
}
/* v2.5.3 新增：弹窗里直接改成「跟随系统」 */
function themeAskSystem(){
  closeThemeAutoAsk();
  setThemeAutoMode('system');
  SFX.success();
  uiMsg && uiMsg('主题模式已设为「跟随系统」');
}
/* v2.5.3 新增：弹窗里直接改成「跟随日出日落」 */
function themeAskSun(){
  closeThemeAutoAsk();
  setThemeAutoMode('sun');
  SFX.success();
  uiMsg && uiMsg('主题模式已设为「跟随日出日落」');
}
var _themeRhythm = 0, _themeRhythmTimer = null;

/* ---- 班级签：一天一签，本地限制 ---- */
var CLASS_SIGN_POOL = [
  {t:'good', text:'今天你回答问题会格外顺，勇敢举一次手吧。'},
  {t:'good', text:'有同学偷偷觉得你今天状态很在线，自信点。'},
  {t:'good', text:'今日宜：把拖延的一件小事做掉，运气会顺起来。'},
  {t:'good', text:'午休去晒会儿太阳，下午效率直接翻倍。'},
  {t:'good', text:'今天适合主动跟一个人说句话，会有小惊喜。'},
  {t:'bad',  text:'今天容易走神，重要的事记在纸上，别全靠脑子。'},
  {t:'bad',  text:'作业可能比你以为的多，早点开动，别熬到深夜。'},
  {t:'bad',  text:'今天别在老师背后比划，月亮不圆的时候容易被看到。'},
  {t:'bad',  text:'奶茶少喝一杯，今天的运气经不起太多糖分的考验。'},
  {t:'bad',  text:'粗心日提醒：交东西前多看一眼名字和日期。'},
  {t:'mid',  text:'平平淡淡也是好日子，今天稳住就行。'},
  {t:'mid',  text:'运气一般，但你的努力比运气靠谱。'},
  {t:'mid',  text:'今天适合整理一下桌面和心情。'}
];
/* 本地日期 key（不用 UTC，避免早上 8 点前跨天错乱） */
function signDayKey(){
  var d = new Date();
  var m = d.getMonth() + 1, day = d.getDate();
  return 'cls_sign_' + d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}
/* 班级签窄卡片（每日日报上方） */
function renderSignBar(){
  var el = document.getElementById('signBar');
  if(!el) return;
  var saved = null;
  try{ saved = localStorage.getItem(signDayKey()); }catch(e){}
  el.innerHTML =
    '<div class="signbar-icon ink-auto">签</div>' +
    '<div class="signbar-info">' +
      '<div class="signbar-title">今日班级签</div>' +
      '<div class="signbar-sub">' + (saved ? '今天已抽过 · 明天 0 点刷新' : '一天一签 · 有好也有坏，看运气') + '</div>' +
    '</div>' +
    '<button class="signbar-btn" onclick="openClassSign()">' + (saved ? '看今日签' : '抽一签') + '</button>';
}
function openClassSign(){
  var key = signDayKey();
  var saved = null;
  try{ saved = localStorage.getItem(key); }catch(e){}
  var sign;
  if(saved){
    try{ sign = JSON.parse(saved); }catch(e){ sign = null; }
  }
  if(!sign){
    sign = CLASS_SIGN_POOL[(Math.random()*CLASS_SIGN_POOL.length)|0];
    try{ localStorage.setItem(key, JSON.stringify(sign)); }catch(e){}
  }
  var tag = document.getElementById('signTag');
  tag.className = 'sign-tag ' + (sign.t==='good'?'good':sign.t==='bad'?'bad':'mid');
  tag.textContent = sign.t==='good' ? '吉签 ✨' : sign.t==='bad' ? '平签 ⚠️' : '凡签';
  document.getElementById('signText').textContent = sign.text;
  document.getElementById('signSub').textContent = saved ? '今天已经抽过啦，明天 0 点刷新 🌙' : '一天一签，明天 0 点刷新';
  document.getElementById('signMask').classList.add('show');
  if(!saved) SFX.success();
  renderSignBar();
}
function closeSign(){ document.getElementById('signMask').classList.remove('show'); }
document.getElementById('signMask').addEventListener('click', function(e){ if(e.target.id==='signMask') closeSign(); });

/* ---- 彩带彩蛋：连续切主题触发 ---- */
var CONFETTI_COLORS = ['#f97316','#fb923c','#fbbf24','#34d399','#fb7185','#a78bfa'];
var _cfRAF = null;
function confettiEgg(){
  var box = document.getElementById('confettiMask');
  var txt = document.getElementById('confettiText');
  var phrases = [
    '🌗 你在白天与黑夜之间反复横跳，把太阳和月亮都吵醒了。它们决定撒一把彩带赔罪——今天也要好好切换心情呀！',
    '🌓 明与暗被你来回拨弄，惊动了掌管昼夜的小精灵。它丢下一把彩带：既然切换了这么多次，不如也把心情切换到开心档～',
    '🌒 你在大白天和深夜里反复横跳，宇宙的调光师看乐了，顺手给你放了一场彩带雨。'
  ];
  txt.textContent = phrases[(Math.random()*phrases.length)|0];
  box.classList.add('show');
  SFX.fanfare();
  fireConfetti();
}
function closeConfetti(){
  document.getElementById('confettiMask').classList.remove('show');
  stopConfetti();
}
document.getElementById('confettiMask').addEventListener('click', function(e){ if(e.target.id==='confettiMask') closeConfetti(); });
function fireConfetti(){
  var cv = document.getElementById('confettiCanvas');
  var ctx = cv.getContext('2d');
  cv.width = window.innerWidth; cv.height = window.innerHeight;
  var ps = [];
  for(var i=0;i<160;i++){
    ps.push({ x: Math.random()*cv.width, y: -20 - Math.random()*cv.height*0.3,
      vx: (Math.random()-0.5)*4, vy: 2 + Math.random()*4,
      w: 6 + Math.random()*6, h: 10 + Math.random()*10,
      rot: Math.random()*Math.PI, vr: (Math.random()-0.5)*0.3,
      c: CONFETTI_COLORS[(Math.random()*CONFETTI_COLORS.length)|0] });
  }
  var end = Date.now() + 3500;
  function frame(){
    ctx.clearRect(0,0,cv.width,cv.height);
    var alive = false;
    ps.forEach(function(p){
      p.x += p.vx; p.y += p.vy; p.vy += 0.06; p.rot += p.vr;
      if(p.y < cv.height + 30) alive = true;
      ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot); ctx.fillStyle = p.c;
      ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h); ctx.restore();
    });
    if(Date.now() < end && alive){ _cfRAF = requestAnimationFrame(frame); }
    else { ctx.clearRect(0,0,cv.width,cv.height); }
  }
  cancelAnimationFrame(_cfRAF); frame();
}
function stopConfetti(){
  cancelAnimationFrame(_cfRAF);
  var cv = document.getElementById('confettiCanvas');
  if(cv) cv.getContext('2d').clearRect(0,0,cv.width,cv.height);
}
function initTheme(){
  var dark = false;
  try{ dark = localStorage.getItem('cls_theme') === 'dark'; }catch(e){}
  /* v2.5.3：先按「自动模式」定夺初始亮暗。
     顺序很重要：先算出自动模式该用什么，再决定是否尊重手动记忆值。
     · off    → 完全用手动记忆的 cls_theme
     · 其他   → 自动模式说了算（system 看系统偏好 / sun 看日出日落）
     · 但当天手动改过（hold）→ 尊重用户，不被自动覆盖
     hold 的判定同时收口在 applyAutoTheme 里（见那里的注释），
     此处只是为了让**首屏**不闪一下错误的颜色（避免先暗后亮的抖动）。 */
  var mode = themeAutoMode();
  if(mode !== 'off'){
    var hold = null;
    try{ hold = localStorage.getItem('cls_theme_hold'); }catch(e){}
    if(hold === sunTodayKey()){
      /* 今天用户手动改过，尊重它 */
    }else{
      dark = isNightTime();
    }
  }
  if(dark) document.documentElement.classList.add('dark');
  else document.documentElement.classList.remove('dark');
  var b = document.getElementById('themeToggle');
  if(b) b.innerHTML = dark ? iconSvg('sun',17) : iconSvg('moon',17);
  /* 首屏态已就位后再让 applyAutoTheme 接管（它内部同样会检查 hold） */
  applyAutoTheme(true);
  /* 若用日出日落，拉一次精确值（异步，不阻塞首屏） */
  if(mode === 'sun') sunFetch();
  /* 每 30 秒复查一次（跨过日出/日落边界时切换）。
     hold 的过滤在 applyAutoTheme 内部统一处理，这里不必重复判断。 */
  setInterval(function(){
    if(themeAutoMode() === 'off') return;
    applyAutoTheme(false);
  }, 30000);
}
initTheme();
/* 站点入口问答：首次进入需回答（本地记住，版本变更需重新回答） */
async function submitSiteGate(){
  var g = document.getElementById('siteGate');
  var input = document.getElementById('siteGateInput');
  var err = document.getElementById('siteGateErr');
  if(!g || !err) return;
  var remain = lockRemain('site');
  if(remain > 0){
    startLockTimer('site', err, input);
    return;
  }
  var v = await hashSecret(normAnswer(input ? input.value : ''), GATE_SALT);
  if(v == null){ err.textContent = '当前环境不支持验证，请用浏览器打开'; return; }
  var ok = false;
  for(var i=0;i<SITE_GATE.answers.length;i++){ if(SITE_GATE.answers[i]===v){ ok=true; break; } }
  if(ok){
    onPassOk('site');
    if(__lockTimers['site']) clearInterval(__lockTimers['site']);
    try{ localStorage.setItem('cls_site_gate', SITE_GATE.version); }catch(e){}
    SFX.success();
    g.classList.remove('show');
  }else{
    var r = onPassFail('site');
    SFX.error();
    err.textContent = r.remain > 0
      ? '💡 提示：' + SITE_GATE.hint + '　🔒 已连续错误 ' + r.count + ' 次，请 ' + Math.ceil(r.remain/1000) + ' 秒后再试'
      : '💡 提示：' + SITE_GATE.hint;
    if(r.remain > 0) startLockTimer('site', err, input);
  }
}
(function(){
  var g = document.getElementById('siteGate');
  if(!g) return;
  /* 门禁总开关关闭（GATE_ENABLED=false）时不再拦人，直接进站 */
  if(!gateOn()) return;
  var needGate = true;
  try{ needGate = (localStorage.getItem('cls_site_gate') !== SITE_GATE.version); }catch(e){}
  if(needGate){
    document.getElementById('siteGateQ').textContent = SITE_GATE.question;
    g.classList.add('show');
  }
})();
try{
  /* 登录引导：首次打开且未登录才弹（maybeShowLoginGuide 内部已判断，弹过即跳过） */
  setTimeout(maybeShowLoginGuide, 1200);
}catch(e){}
/* ⚠️ 顺序要紧：contentBoot() 必须先于 hwPopInit()。
   它会先用本地缓存把 SITE_DATA 覆盖成云端内容，再去后台同步；
   若放到 hwPopInit() 之后，开屏弹窗判断「今天是否在通知期内」时
   读到的还是 index.html 里写死的旧日期，会出现「内容已是国庆、
   弹窗却按中秋那几天判断」的错位。（2026-09-30 加，改动勿调序） */
contentBoot();
/* v3.8.4（站主）：板块分享深链 —— ?b=板块 或 ?t=分享token，进来直接定位。
   放在 contentBoot 之后：先把云端内容和板块设置拿到，再决定跳到哪儿。 */
try{ boardShareBoot(); }catch(e){ console.warn('[boardShare]', e); }
/* v3.8.5：作业导出图里的音视频二维码 → 扫码打开 ?play=，站内直接播放 */
try{ playLinkBoot(); }catch(e){ console.warn('[play]', e); }
/* v3.8.7：首页班级岛（时间/天气/周数/学期 + 当日课程） */
try{ islandBoot(); }catch(e){ console.warn('[island]', e); }
hwPopInit(); /* 开屏通知弹窗：大假作业发布提醒（进站自动弹；可「不再显示」） */
popInit();   /* 通用弹窗引擎：按 SITE_DATA.popups 排队弹「开屏弹」（默认空，配了才弹） */
syncAutoInit(); /* 自动云同步：每 1 分钟双向同步（推本机 + 拉云端），回前台立刻补跑 */
