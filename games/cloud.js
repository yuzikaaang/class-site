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
     但这是单人单端的个人数据，可接受。 */
  addPlay: function(game, ms, extra){
    if(!(ms > 0)) ms = 0;
    pull('cls_game_play_' + game, function(old){
      var o = (old && typeof old === 'object') ? old : {};
      o.count   = (o.count || 0) + 1;
      o.totalMs = (o.totalMs || 0) + Math.round(ms);
      o.lastMs  = Math.round(ms);
      o.lastAt  = new Date().toISOString();
      if(extra && extra.score != null && (o.bestScore == null || extra.score > o.bestScore)){
        o.bestScore = extra.score;
      }
      var w = {}; w['cls_game_play_' + game] = o;
      push(w);
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
