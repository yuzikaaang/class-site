/* ============================================================
   games/cloud.js —— 游戏数据云端同步（2026-10-07）
   ------------------------------------------------------------
   登录态与主站共享：同一域名的 localStorage 里 cls_auth（主站登录后写入）。
   上云内容（站主要求）：
     ① 各游戏最高分     cls_game_<本地键>   如 cls_game_snake_hi
     ② 每局游玩时长     cls_game_play_<游戏> { count,totalMs,lastMs,lastAt,bestScore }
     ③ 点歌券领取台账   cls_game_coupon_ledger（发放前以云端这份判重）
   未登录时全部静默跳过：游戏照玩、本地照存，只是不上云。
   所有请求失败都吞掉——云同步永远不能把游戏玩挂了。
   ============================================================ */
(function(){
'use strict';
var API = 'https://api.classsite.dpdns.org/api/data';

function auth(){
  try{
    var o = JSON.parse(localStorage.getItem('cls_auth') || 'null');
    return (o && o.token) ? o : null;
  }catch(e){ return null; }
}
/* 当前登录者的姓名（用于点歌券台账、排行榜署名）。
   优先级：displayName（后台导名单时填的姓名）> username（用户名本身就是姓名）。
   两者都没有 → 空串，调用方据此判断「还没登录 / 没有可用身份」。 */
function userName(){
  var a = auth();
  if(!a || !a.user) return '';
  var u = a.user;
  return String(u.displayName || u.username || '').trim();
}
/* 统一取身份信息，便于游戏端一次拿全 */
function whoami(){
  var a = auth();
  if(!a) return null;
  return { name: userName(), role: (a.user && a.user.role) || 'user', username: (a.user && a.user.username) || '' };
}
/* 本周的起点时间戳（周一 00:00，本地时区）。
   与各游戏里 weekKey() 的口径保持一致——周榜的「周」必须同一个定义，
   否则会出现「游戏说本周已换、榜单还按上周算」的错位。 */
function weekStamp(){
  var d = new Date();
  var day = (d.getDay() + 6) % 7;      /* 周一=0 … 周日=6 */
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d.getTime();
}
function hdrs(a){
  return { 'Content-Type':'application/json', Authorization:'Bearer ' + a.token };
}
/* 批量写（fire-and-forget） */
function push(items){
  var a = auth(); if(!a) return;
  try{
    fetch(API, { method:'PUT', headers:hdrs(a), body:JSON.stringify({ items: items }) })
      .then(function(){}).catch(function(){});
  }catch(e){}
}
/* 读单键 */
function pull(key, cb){
  var a = auth();
  if(!a){ cb(null); return; }
  try{
    fetch(API + '?key=' + encodeURIComponent(key), { headers: hdrs(a) })
      .then(function(r){ return r.json(); })
      .then(function(j){ cb(j && j.ok ? j.value : null); })
      .catch(function(){ cb(null); });
  }catch(e){ cb(null); }
}

window.CLS_CLOUD = {
  auth: auth,
  /* 当前登录者姓名 / 身份（未登录返回 '' 或 null） */
  userName: userName,
  whoami: whoami,

  /* ---- 最高分 ---- */
  /* 破纪录时调用：localKey 用游戏里原来的键名（如 'snake_hi'） */
  pushHi: function(localKey, val){
    var o = {}; o['cls_game_' + localKey] = val;
    push(o);
  },
  /* 开局拉云端最高分：比本地高就回调（换设备 / 清缓存不丢纪录） */
  pullHi: function(localKey, apply){
    pull('cls_game_' + localKey, function(v){
      v = Number(v || 0);
      if(v > 0 && apply) apply(v);
    });
  },

  /* ---- 游玩时长（每局结束调用一次）----
     云端读旧值 → 累加本次 → 写回。读改写有并发覆盖风险，
     但这是单人单端的个人数据，可接受。
     第二十七轮 ⑪：顺手维护「本周最高分」cls_game_week_<游戏>
     （{score, at}），排行榜的周榜直接读它，后端不必做日志聚合。 */
  addPlay: function(game, ms, extra){
    if(!(ms > 0)) ms = 0;
    pull('cls_game_play_' + game, function(old){
      var o = (old && typeof old === 'object') ? old : {};
      o.count   = (o.count || 0) + 1;
      o.totalMs = (o.totalMs || 0) + Math.round(ms);
      o.lastMs  = Math.round(ms);
      o.lastAt  = new Date().toISOString();
      var sc = (extra && extra.score != null) ? Number(extra.score) : null;
      if(sc != null && (o.bestScore == null || sc > o.bestScore)){
        o.bestScore = sc;
      }
      var w = {}; w['cls_game_play_' + game] = o;
      push(w);

      /* 周榜：本周最高分。周一为一周起点（与各游戏 weekKey() 口径一致）。 */
      if(sc != null && sc > 0){
        pull('cls_game_week_' + game, function(wold){
          var wk = (wold && typeof wold === 'object') ? wold : {};
          /* 跨周自动重置：存的周起点与当前周不同 → 视为新的一周 */
          if(wk.week !== weekStamp()){ wk = { week: weekStamp(), score: 0, at: null }; }
          if(sc > (Number(wk.score) || 0)){
            wk.score = sc; wk.at = new Date().toISOString();
          }
          var w2 = {}; w2['cls_game_week_' + game] = wk;
          push(w2);
        });
      }
    });
  },

  /* ---- 点歌券台账（云端为准）----
     本地 cls_coupon_ledger 的云端副本。领取流程：
     先查云端 → 有记录（含券码）直接找回；没有才发新券 → 发完写云端。 */
  pullLedger: function(cb){
    pull('cls_game_coupon_ledger', function(v){ cb(v && typeof v === 'object' ? v : null); });
  },
  pushLedger: function(L){
    var o = {}; o['cls_game_coupon_ledger'] = L;
    push(o);
  },
};
})();
