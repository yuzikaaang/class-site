/* admin-2.js · 后台脚本第 2/3 段：公告、内容、成绩、作业、点歌排期、投票
   与 admin-1.js 共享全局作用域，必须在其后加载。 */
'use strict';
/* ============================================================================
 * ⑪-F2 面板：学习卡片（v2.6.0 新增）
 * ---------------------------------------------------------------------------
 * 站主要求：「不要做一个专门的板块，就跟每日一言一样，在选择好想随机
 *           出现的学科知识点之后就可以联网更新」
 *
 * 云端字段：study_card
 *   { on:true, types:{know,word,poem,quiz}, subjects:{physics,chemistry,biology} }
 *
 * 这里的配置是**全班默认值**：同学在首页「自定义设置」里改过就以个人的为准，
 * 没改过就用这里配的。字段名必须与 index.html 的 STUDY_DEFAULT_CFG 一致，
 * 少一个键前端会退回代码常量（不会崩，但站主会以为「设置了没生效」）。
 *
 * 内容本身（135 条知识点 + 30 道英语题）内置于 index.html，
 * 不在这里维护 —— 后台只管「显示哪些类型」。
 * ========================================================================= */
var STUDY_TYPES = [
  { k: 'know', name: '学科知识点', desc: '物理 / 化学 / 生物 必修一知识点与公式（内置，离线可用）' },
  { k: 'quiz', name: '每日一题',   desc: '英语选词填空，每题一问，含答案与解析（内置）' },
  { k: 'word', name: '每日一词',   desc: '联网获取英文单词的音标、中文释义与例句' },
  { k: 'poem', name: '古诗文',     desc: '联网获取今日诗词，含朝代、作者与出处' },
];
var STUDY_SUBJECTS = [
  { k: 'physics',   name: '物理', desc: '必修第一册 · 力与运动' },
  { k: 'chemistry', name: '化学', desc: '必修第一册 · 物质变化 / 钠氯 / 铁 / 周期律' },
  { k: 'biology',   name: '生物', desc: '必修1 · 分子与细胞' },
];

/* 注：本区块原先有独立的 renderStudy() 页面，v2.6.1 起并入上方 renderCards()
   （「首页卡片」板块），这里只保留数据加载与勾选渲染逻辑。 */

function loadStudy(){
  api('/content').then(function(j){
    var items = (j && j.items) || {};
    var raw = items.study_card;
    /* 归一化：历史/异常数据一律退回默认，保证界面永远有可勾的值 */
    var cfg = { on: true,
      types: { know: true, word: true, poem: true, quiz: true },
      subjects: { physics: true, chemistry: true, biology: true } };
    if(raw && typeof raw === 'object'){
      if(raw.on === false) cfg.on = false;
      ['know', 'word', 'poem', 'quiz'].forEach(function(k){
        if(raw.types && raw.types[k] === false) cfg.types[k] = false;
      });
      ['physics', 'chemistry', 'biology'].forEach(function(k){
        if(raw.subjects && raw.subjects[k] === false) cfg.subjects[k] = false;
      });
    }
    STATE.study = cfg;
    paintStudy();
  }).catch(function(e){
    var b = $('stBody');
    if(b) b.innerHTML = '<div class="empty">' + svg('alert', 34) + '<p>加载失败：' + esc(e.message) + '</p></div>';
  });
}

function paintStudy(){
  var body = $('stBody');
  if(!body) return;
  var c = STATE.study || {};
  var typeRows = STUDY_TYPES.map(function(t){
    var on = !c.types || c.types[t.k] !== false;
    return '<label class="st-row">'
      + '<input type="checkbox" data-st-type="' + t.k + '"' + (on ? ' checked' : '') + '>'
      + '<span class="st-info"><b>' + esc(t.name) + '</b><i>' + esc(t.desc) + '</i></span>'
      + '</label>';
  }).join('');
  var subjRows = STUDY_SUBJECTS.map(function(s){
    var on = !c.subjects || c.subjects[s.k] !== false;
    return '<label class="st-row">'
      + '<input type="checkbox" data-st-subj="' + s.k + '"' + (on ? ' checked' : '') + '>'
      + '<span class="st-info"><b>' + esc(s.name) + '</b><i>' + esc(s.desc) + '</i></span>'
      + '</label>';
  }).join('');

  body.innerHTML =
    '<div class="field" style="margin-bottom:18px">'
    +   '<label class="st-row" style="border:1px solid var(--btn-b);border-radius:12px;padding:11px 14px">'
    +     '<input type="checkbox" id="stOn"' + (c.on !== false ? ' checked' : '') + '>'
    +     '<span class="st-info"><b>启用学习卡片</b><i>关掉后首页不再显示这张卡片（同学自己的开关优先）</i></span>'
    +   '</label>'
    + '</div>'
    + '<h4 style="margin:0 0 8px;font-size:.9rem">内容类型</h4>'
    + '<div class="st-list">' + typeRows + '</div>'
    + '<h4 style="margin:20px 0 8px;font-size:.9rem">学科知识点范围</h4>'
    + '<p class="muted" style="font-size:.78rem;margin:0 0 8px">'
    +   '只在勾选「学科知识点」时生效。每科条目数：物理 24 · 化学 33 · 生物 48。'
    + '</p>'
    + '<div class="st-list">' + subjRows + '</div>';

  Array.prototype.forEach.call(body.querySelectorAll('[data-st-type]'), function(cb){
    cb.onchange = function(){ c.types[cb.dataset.stType] = cb.checked; };
  });
  Array.prototype.forEach.call(body.querySelectorAll('[data-st-subj]'), function(cb){
    cb.onchange = function(){ c.subjects[cb.dataset.stSubj] = cb.checked; };
  });
  var onBox = body.querySelector('#stOn');
  if(onBox) onBox.onchange = function(){ c.on = onBox.checked; };
}

function saveStudy(){
  var c = STATE.study;
  if(!c){ toast('正在加载', 'err'); return; }
  var typeBox = $('stBody').querySelector('#stOn');
  if(typeBox) c.on = typeBox.checked;

  /* 校验：至少留一个内容类型，否则首页整块空白，站主以为是 bug */
  var anyType = Object.keys(c.types).some(function(k){ return c.types[k]; });
  if(c.on && !anyType){ toast('至少要勾一个内容类型', 'err', 3600); return; }
  var anySubj = Object.keys(c.subjects).some(function(k){ return c.subjects[k]; });
  if(c.on && c.types.know && !anySubj){ toast('勾了「学科知识点」，至少要选一个学科', 'err', 3600); return; }

  var btn = $('stSave');
  btn.disabled = true;
  /* 走 /content PUT：要带上完整 items（后端是整份替换），
     所以先 GET 一次拿全量，只改 study_card 这一个键。 */
  api('/content').then(function(j){
    var items = (j && j.items) || {};
    items.study_card = c;
    return api('/content', { method: 'PUT', body: { items: items } });
  }).then(function(j){
    if(j && j.ok === false) throw new Error(j.error || '保存失败');
    btn.disabled = false;
    toast('已保存，同学刷新首页即可看到', 'ok');
  }).catch(function(e){
    btn.disabled = false;
    toast('保存失败：' + e.message, 'err', 4200);
  });
}

/* ============================================================================
 * ⑪-F 面板：重要日期 / 考试范围（2026-10-06 新增）
 * ---------------------------------------------------------------------------
 * 需求「重要日期 / 考试范围也要能上云」。
 *
 * 云端字段：important_dates
 *   [
 *     { name:"寒假", date:"2027-01-30T00:00:00" },                       ← 单日
 *     { name:"第一次段考", date:"2026-10-13T00:00:00",
 *       endDate:"2026-10-14",                                            ← 跨天事项才填
 *       scope:[ { sub:"语文", txt:"..." }, ... ] }                       ← 填了才显示「查看考试范围」
 *   ]
 *
 * ⚠️ 字段名必须与主站 index.html 里的 IMPORTANT_DATES 完全一致 ——
 *    主站是**整体替换**这个数组（applyCloudContent 里对 important_dates 的特判），
 *    这里多写/少写一个字段都会被静默吞掉：比如漏了 endDate，段考就退化成单日；
 *    漏了 scope，「查看考试范围」按钮直接消失。所以下面硬编码这几个键名。
 * ========================================================================= */
function renderDates(){
  $('view').innerHTML =
    '<div class="toolbar" style="background:var(--panel)">'
    +   '<button class="btn btn-sm" id="dtAdd">' + svg('plus', 14) + '新增日期</button>'
    +   '<span style="flex:1"></span>'
    +   '<button class="btn btn-sm btn-secondary" id="dtRefresh">' + svg('refresh', 14) + '刷新</button>'
    + '</div>'
    + '<div class="alert info" style="margin-bottom:16px">'
    +   '这里的每一条都会出现在首页「重要日期」倒计时里。'
    +   '填了「考试范围」的事项，同学打开才有「查看考试范围」按钮。<br>'
    +   '<b>注意：清空云端不影响首页</b> —— 主站会自动回退到页面内置的那份日期，不会出现空白。'
    + '</div>'
    + '<section class="panel"><div id="dtBody"><div class="loading"><div class="spinner"></div>加载中…</div></div></section>';

  $('dtAdd').onclick     = function(){ dtDialog(null); };
  $('dtRefresh').onclick = function(){ loadDates(); };
  loadDates();
}

function loadDates(){
  api('/content').then(function(j){
    var items = (j && j.items) || {};
    STATE.dates.list = Array.isArray(items.important_dates) ? items.important_dates : [];
    paintDates();
  }).catch(function(e){
    var b = $('dtBody');
    if(b) b.innerHTML = '<div class="empty">' + svg('alert', 34) + '<p>加载失败：' + esc(e.message) + '</p></div>';
  });
}

function dtFmtDate(v){
  if(!v) return '—';
  var d = new Date(v);
  if(isNaN(d.getTime())) return String(v).slice(0, 10);
  function p(n){ return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function paintDates(){
  var body = $('dtBody');
  if(!body) return;
  var list = STATE.dates.list || [];

  if(!list.length){
    body.innerHTML = '<div class="empty">' + svg('calendar', 38) + '<p>云端还没有重要日期</p>'
      + '<p class="muted" style="font-size:.78rem">首页此刻显示的是页面内置的那份（寒假 + 第一次段考）</p></div>';
    return;
  }

  var sorted = list.slice().sort(function(a, b){
    return String(a.date || '') < String(b.date || '') ? -1 : 1;
  });

  body.innerHTML =
    '<div class="muted" style="font-size:.78rem;margin-bottom:8px">共 <b>' + sorted.length + '</b> 项</div>'
    + '<div class="table-wrap"><table><thead><tr>'
    +   '<th>名称</th><th class="nowrap" style="width:200px">日期</th>'
    +   '<th class="nowrap" style="width:90px">考试范围</th>'
    +   '<th style="text-align:right;width:130px">操作</th>'
    + '</tr></thead><tbody>'
    + sorted.map(function(d){
        var dateText = dtFmtDate(d.date);
        if(d.endDate) dateText += ' — ' + dtFmtDate(d.endDate);
        var sc = Array.isArray(d.scope) ? d.scope.filter(function(x){ return x && x.txt; }) : [];
        return '<tr>'
          + '<td><b>' + esc(d.name || '(未命名)') + '</b></td>'
          + '<td class="muted nowrap" style="font-size:.78rem">' + esc(dateText) + '</td>'
          + '<td class="nowrap">' + (sc.length
              ? '<span class="badge badge-blue">' + sc.length + ' 科</span>'
              : '<span class="muted">无</span>') + '</td>'
          + '<td style="text-align:right"><div class="row-actions">'
          +   '<button data-dt-edit="' + esc(d.name) + '">编辑</button>'
          +   '<button class="danger" data-dt-del="' + esc(d.name) + '">删除</button>'
          + '</div></td></tr>';
      }).join('')
    + '</tbody></table></div>';

  Array.prototype.forEach.call(body.querySelectorAll('[data-dt-edit]'), function(b){
    b.onclick = function(){ dtDialog(b.dataset.dtEdit); };
  });
  Array.prototype.forEach.call(body.querySelectorAll('[data-dt-del]'), function(b){
    b.onclick = function(){ dtDelete(b.dataset.dtDel); };
  });
}

/**
 * 新增/编辑重要日期。
 * @param {string|null} key 传 null = 新增；传名称 = 编辑那一条
 */
function dtDialog(key){
  var list = STATE.dates.list || [];
  var isNew = (key === null || key === undefined);
  var d = isNew ? { name:'', date:'', endDate:'', scope:[] }
                : (list.find(function(x){ return x.name === key; }) || { name:'', date:'', endDate:'', scope:[] });
  var scope = Array.isArray(d.scope) ? d.scope.slice() : [];

  /* 把 ISO 时间裁成 datetime-local 需要的 "YYYY-MM-DDTHH:mm" */
  function toLocalInput(v){
    if(!v) return '';
    var t = String(v);
    return t.length > 16 ? t.slice(0, 16) : t;
  }
  function toDayInput(v){ return v ? String(v).slice(0, 10) : ''; }

  function scopeRows(){
    if(!scope.length) return '<div class="muted" style="font-size:.78rem;padding:6px 0">还没有科目，点下面的「添加科目」</div>';
    return scope.map(function(s, i){
      return '<div style="display:flex;gap:6px;margin-bottom:6px;align-items:flex-start">'
        + '<input data-sc-sub="' + i + '" value="' + attr(s.sub || '') + '" maxlength="12" placeholder="科目" style="width:80px;flex-shrink:0">'
        + '<textarea data-sc-txt="' + i + '" rows="2" maxlength="600" placeholder="考试范围" style="flex:1">' + esc(s.txt || '') + '</textarea>'
        + '<button type="button" class="btn btn-sm btn-ghost" data-sc-del="' + i + '" style="flex-shrink:0">' + svg('x', 13) + '</button>'
        + '</div>';
    }).join('');
  }

  openModal({
    title: isNew ? '新增重要日期' : ('编辑 ' + (d.name || '')),
    sub: '跨天事项才填「结束日期」；不考试的事项不用填科目',
    wide: true,
    body:
      '<div class="field"><label for="dtN">名称</label>'
      + '<input id="dtN" maxlength="30" value="' + attr(d.name || '') + '" placeholder="例如：第一次段考"></div>'

      + '<div style="display:flex;gap:10px;flex-wrap:wrap">'
      +   '<div class="field" style="flex:1;min-width:200px"><label for="dtD">开始时间</label>'
      +   '<input id="dtD" type="datetime-local" value="' + attr(toLocalInput(d.date)) + '"></div>'
      +   '<div class="field" style="flex:1;min-width:180px"><label for="dtE">结束日期（可选）</label>'
      +   '<input id="dtE" type="date" value="' + attr(toDayInput(d.endDate)) + '">'
      +   '<p class="hint">仅跨天事项需填写，如段考 13—14 日。</p></div>'
      + '</div>'

      + '<div class="field"><label>考试范围（可选）</label>'
      +   '<div id="dtScope">' + scopeRows() + '</div>'
      +   '<div style="margin-top:8px"><button type="button" class="btn btn-sm btn-ghost" id="dtScopeAdd">'
      +   svg('plus', 13) + ' 添加科目</button></div>'
      +   '<p class="hint">填写后，首页该条公告将显示「查看考试范围」入口。</p></div>'

      + '<div class="msg" id="dtMsg"></div>',

    foot: '<button class="btn btn-ghost" data-no>取消</button>'
        + '<button class="btn" data-yes>' + (isNew ? '新增' : '保存') + '</button>',

    onMount: function(box){
      var scopeBox = box.querySelector('#dtScope');

      /* 每一次重画都从 scope 数组重新生成，所以先把文本区里的改动收回去 */
      function harvest(){
        Array.prototype.forEach.call(box.querySelectorAll('[data-sc-sub]'), function(inp){
          var i = Number(inp.dataset.scSub);
          if(scope[i]) scope[i].sub = inp.value;
        });
        Array.prototype.forEach.call(box.querySelectorAll('[data-sc-txt]'), function(inp){
          var i = Number(inp.dataset.scTxt);
          if(scope[i]) scope[i].txt = inp.value;
        });
      }
      function redraw(){
        harvest();
        scopeBox.innerHTML = scopeRows();
        bind();
      }
      function bind(){
        Array.prototype.forEach.call(scopeBox.querySelectorAll('[data-sc-del]'), function(b){
          b.onclick = function(){ harvest(); scope.splice(Number(b.dataset.scDel), 1); redraw(); };
        });
      }
      bind();

      box.querySelector('#dtScopeAdd').onclick = function(){
        harvest();
        scope.push({ sub: '', txt: '' });
        redraw();
      };
      box.querySelector('[data-no]').onclick = closeModal;

      box.querySelector('[data-yes]').onclick = function(){
        harvest();
        var msg = box.querySelector('#dtMsg');
        var name = (box.querySelector('#dtN').value || '').trim();
        var date = (box.querySelector('#dtD').value || '').trim();
        var end  = (box.querySelector('#dtE').value || '').trim();

        if(!name){ msg.textContent = '名称不能为空'; msg.style.color = 'var(--danger,#af410f)'; return; }
        if(!date){ msg.textContent = '请选择开始时间'; msg.style.color = 'var(--danger,#af410f)'; return; }
        if(end && end < date.slice(0, 10)){
          msg.textContent = '结束日期不能早于开始日期'; msg.style.color = 'var(--danger,#af410f)'; return;
        }
        /* 同名会被主站 openExamScope() 按 name 查找，重名就取到错的那条，必须拦住 */
        var dup = (STATE.dates.list || []).some(function(x){
          return x.name === name && x.name !== key;
        });
        if(dup){ msg.textContent = '已经有一条叫「' + name + '」的了，换个名字'; msg.style.color = 'var(--danger,#af410f)'; return; }

        var item = { name: name, date: date };
        if(end) item.endDate = end;
        var real = scope.filter(function(s){ return (s.txt || '').trim(); })
                        .map(function(s){ return { sub: (s.sub || '').trim(), txt: s.txt.trim() }; });
        if(real.length) item.scope = real;

        var next = (STATE.dates.list || []).slice();
        if(isNew) next.push(item);
        else{
          var at = next.findIndex(function(x){ return x.name === key; });
          if(at >= 0) next[at] = item; else next.push(item);
        }

        api('/content', { method:'PUT', body:{ items:{ important_dates: next } } })
          .then(function(){
            closeModal();
            toast(isNew ? '已新增' : '已保存', 'ok', 3000);
            loadDates();
          })
          .catch(function(e){ toast('保存失败：' + e.message, 'err', 4200); });
      };
    }
  });
}

function dtDelete(key){
  var list = STATE.dates.list || [];
  var d = list.find(function(x){ return x.name === key; });
  if(!d) return;
  confirmBox({
    title: '删除重要日期',
    html: '确定删除 <b>' + esc(d.name || '') + '</b> 吗？',
    detail: '删除后首页倒计时里不再显示这一条。',
    danger: true,
    okText: '删除'
  }).then(function(ok){
    if(!ok) return;
    var next = list.filter(function(x){ return x.name !== key; });
    api('/content', { method:'PUT', body:{ items:{ important_dates: next } } })
      .then(function(){ toast('已删除', 'ok'); loadDates(); })
      .catch(function(e){ toast('删除失败：' + e.message, 'err', 4200); });
  });
}

/* ============================================================================
 * ⑫ 面板：班级资料管理（通讯录）
 * ---------------------------------------------------------------------------
 * 后端 /admin?action=profiles 返回：
 *   { total, counts:{total,pending,approved,claimed}, profiles:[{ id, name,
 *     studentId, politics, examNo, role, wechat, qq, phone, contactStatus,
 *     rejectReason, userId, boundUsername, createdAt, updatedAt }] }
 *
 * 注意：这里的联系方式是**管理端明文视图**，只有管理员能看到。
 * 同学那边未审核通过时只会拿到打码号码（见 api/profile.js 的 shapeProfile）。
 * ========================================================================= */
var CONTACT_LABEL = {
  none:     { text:'未填写',  cls:'badge-gray'  },
  pending:  { text:'待审核',  cls:'badge-amber' },
  approved: { text:'已通过',  cls:'badge-green' },
  rejected: { text:'已驳回',  cls:'badge-red'   }
};

/* ============================================================================
 * 字段管理（2026-10-09 v2.4.0）
 * ----------------------------------------------------------------------------
 * 站主原话：「以后如果可以的话，我能不能在后台直接加……比如新增用户资料的某个区域」。
 *
 * 三个能力：
 *   ① 看：列出所有字段（中文名 / 英文键 / 可见性 / 排序 / 填报数 / 是否自定义）
 *   ② 加：新增自定义字段（自动 ALTER TABLE 加真列）
 *   ③ 改：改中文名、改排序、快捷切换可见性（公开 / 班委 / 仅本人）
 *   ④ 删：只能删自定义字段（系统字段删了会带崩代码）
 *
 * ⚠️ 英文键名只能是小写字母开头 + 小写字母/数字/下划线，服务端有严格白名单
 *    （因为列名要拼进 ALTER TABLE，无法参数化）。前端这里先挡一道，体验更好。
 * ========================================================================= */
/* v3.4.1 新增 admin 档；v3.5.37 更名「仅后端可见」；v3.5.38 语义收紧到站主要求：
   · 只能在**后台**（成员与档案 → 详情）查到；
   · 前台一律看不到 —— 包括管理员自己的「我的资料」，也一样看不到；
   · 前台任何身份查询任何人（含管理员查别人）都拿不到，连键都不下发。
   实现：前台两条链路（search / me）传给 canSee 的 ctx.admin 恒为 false；
   后台详情是 select p.* 直读整行，不经过可见性判定。 */
var VIS_LABEL = { public:'公开', committee:'班委可见', self:'仅本人', admin:'仅后端可见' };
var VIS_DESC  = {
  public:    '已登录的同学都能查到',
  committee: '只有班委（班长/团支书/课代表等）能查到',
  self:      '只有本人查自己时能看到',
  admin:     '只能在后端（成员与档案 → 详情）查到；前台任何人都看不到，包括管理员自己的「我的资料」'
};

function loadFieldMeta(){
  return api('/admin?action=field-meta').then(function(j){
    STATE.members.fieldMeta = j.fields || [];
    STATE.members.totalProfiles = j.totalProfiles || 0;
    return STATE.members.fieldMeta;
  });
}

/* ============================================================================
 * 字段校验规则（v3.5.5）
 * ----------------------------------------------------------------------------
 * 站主要求：「所有字段支持管理员自定义配置校验规则」——
 *   文本（最大/最小字符数）、数字（固定位数/数值范围/仅允许数字）、
 *   时间（选择器录入/可限区间）、下拉单选多选（后台自定义选项）。
 *
 * ⚠️ 服务端（api/_lib/field-rules.js）是唯一裁判，这里只是让正确输入
 *    更容易：批量导入 / 直接调 API 都能绕过 UI，规则在服务端复核。
 * ⚠️ 与服务端 normalizeRules 同语义：空值恒放过、选项去重保序。
 * ========================================================================= */

/** 取某字段的校验规则（STATE 里已由服务端 normalize 过） */
function ruleOf(field){
  var meta = STATE.members.fieldMeta || STATE.profiles.fieldMeta || [];
  for(var i=0;i<meta.length;i++) if(meta[i].field === field) return meta[i].rules || {};
  return {};
}

/** 规则的一句话人话（字段列表 / 报错文案用，与服务端 describeRules 对齐） */
function ruleDesc(rules){
  var r = rules || {};
  if(r.type === 'text'){
    if(r.minLen && r.maxLen) return '文本 ' + r.minLen + '–' + r.maxLen + ' 字符';
    if(r.maxLen) return '文本最多 ' + r.maxLen + ' 字符';
    if(r.minLen) return '文本至少 ' + r.minLen + ' 字符';
    return '文本';
  }
  if(r.type === 'number'){
    if(r.digits) return '数字固定 ' + r.digits + ' 位';
    if(r.min != null && r.max != null) return '数字 ' + r.min + '–' + r.max;
    if(r.min != null) return '数字 ≥ ' + r.min;
    if(r.max != null) return '数字 ≤ ' + r.max;
    return '数字';
  }
  if(r.type === 'time'){
    /* v3.5.15：精确到日 / 月 / 年（入团时间只到月份） */
    var p = r.precision || 'day';
    var base = p === 'year' ? '年份' : p === 'month' ? '年月' : '日期';
    var fmt  = p === 'year' ? 'YYYY' : p === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';
    if(r.min && r.max) return base + ' ' + fmt + '，' + r.min + ' ~ ' + r.max;
    if(r.min) return base + ' ' + fmt + '，不早于 ' + r.min;
    if(r.max) return base + ' ' + fmt + '，不晚于 ' + r.max;
    return base + '（' + fmt + '）';
  }
  if(r.type === 'select') return (r.multi ? '多选' : '单选') + '：' + (r.options || []).join(' / ');
  return '';
}

/**
 * 按规则渲染输入控件（资料编辑弹窗用）。
 * @param field  字段键名（写进 data-xf，保存时按它收集值）
 * @param rules  该字段的规则
 * @param val    当前值
 * @param id     元素 id
 * @param ph     占位提示
 * @param multiHost 多选的隐藏输入宿主 id 前缀（默认与 id 相同）
 */
function ruleInputHtml(field, rules, val, id, ph){
  var r = rules || {};
  var v = val == null ? '' : String(val);
  if(r.type === 'select'){
    var opts = r.options || [];
    if(r.multi){
      /* 多选：复选框组 + 隐藏输入（逗号分隔值），保存路径不改 */
      var cur = v ? v.split(/[,，]/).map(function(s){ return s.trim(); }).filter(Boolean) : [];
      var hid = id + '_hid';
      var h = '<input type="hidden" id="' + attr(hid) + '" data-xf="' + attr(field) + '" value="' + attr(cur.join(',')) + '">';
      h += '<div id="' + attr(id) + '" class="rule-multi">';
      opts.forEach(function(o, i){
        h += '<label class="chk"><input type="checkbox" value="' + attr(o) + '"'
          + (cur.indexOf(o) >= 0 ? ' checked' : '') + '> ' + esc(o) + '</label>';
      });
      h += '</div>';
      /* 勾选变化 → 同步隐藏输入（onMount 后由调用方绑定，这里用 onchange 内联最省事） */
      return h;
    }
    var s = '<select id="' + attr(id) + '" class="inp" data-xf="' + attr(field) + '">'
      + '<option value=""' + (v ? '' : ' selected') + '>（未填）</option>';
    if(v && opts.indexOf(v) < 0){
      s += '<option value="' + attr(v) + '" selected>' + esc(v) + '（历史值，规则外）</option>';
    }
    opts.forEach(function(o){
      s += '<option value="' + attr(o) + '"' + (v === o ? ' selected' : '') + '>' + esc(o) + '</option>';
    });
    return s + '</select>';
  }
  if(r.type === 'time'){
    /* v3.5.15：按精度给不同控件 —— 精确到月用 month（选年月），精确到年用四位数字。
       历史值比精度更细时先截断，否则 type=month 会显示成空。 */
    var p = r.precision || 'day';
    if(p === 'year'){
      return '<input id="' + attr(id) + '" class="inp" inputmode="numeric" maxlength="4" data-xf="' + attr(field) + '"'
        + ' value="' + attr(v.slice(0, 4)) + '" placeholder="如 2024">';
    }
    if(p === 'month'){
      return '<input id="' + attr(id) + '" class="inp" type="month" data-xf="' + attr(field) + '"'
        + ' value="' + attr(v.slice(0, 7)) + '"' + (r.min ? ' min="' + attr(r.min) + '"' : '')
        + (r.max ? ' max="' + attr(r.max) + '"' : '') + '>';
    }
    return '<input id="' + attr(id) + '" class="inp" type="date" data-xf="' + attr(field) + '"'
      + ' value="' + attr(v) + '"' + (r.min ? ' min="' + attr(r.min) + '"' : '')
      + (r.max ? ' max="' + attr(r.max) + '"' : '') + '>';
  }
  if(r.type === 'number'){
    return '<input id="' + attr(id) + '" class="inp" inputmode="numeric" data-xf="' + attr(field) + '"'
      + ' value="' + attr(v) + '" maxlength="' + (r.digits || 20) + '"'
      + ' placeholder="' + attr(ph || (r.digits ? r.digits + ' 位数字' : '数字')) + '">';
  }
  /* text / 无规则：短文本，按 maxLen 限长（无规则时 200） */
  return '<input id="' + attr(id) + '" class="inp" data-xf="' + attr(field) + '"'
    + ' value="' + attr(v) + '" maxlength="' + (r.maxLen || 200) + '"'
    + ' placeholder="' + attr(ph || '') + '">';
}

/** 多选复选框组 → 隐藏输入同步（ruleInputHtml 的多选分支渲染后调用） */
function bindRuleMulti(box, id){
  var host = box.querySelector('#' + id) || box.querySelector('[id="' + id + '"]');
  var hid  = document.getElementById(id + '_hid');
  if(!host || !hid) return;
  Array.prototype.forEach.call(host.querySelectorAll('input[type=checkbox]'), function(cb){
    cb.onchange = function(){
      var picked = [];
      Array.prototype.forEach.call(host.querySelectorAll('input[type=checkbox]'), function(c){
        if(c.checked) picked.push(c.value);
      });
      hid.value = picked.join(',');
    };
  });
}

/* ---- 规则编辑器（新增 / 编辑字段弹窗里共用） ---- */
var RULE_TYPE_LABEL = {
  '':   '不校验（可任意填写）',
  text: '文本 —— 限字符数',
  number: '数字 —— 限位数 / 数值范围',
  time: '日期 —— 选择器录入，可限区间',
  select: '下拉选择 —— 自定义选项，禁止自由输入'
};

function ruleEditorHtml(rules){
  var r = rules || {};
  var t = r.type || '';
  var h = '<div class="field"><label>校验规则</label>'
    + '<select id="ffRuleType" class="inp">'
    + Object.keys(RULE_TYPE_LABEL).map(function(k){
        return '<option value="' + attr(k) + '"' + (k === t ? ' selected' : '') + '>'
          + esc(RULE_TYPE_LABEL[k]) + '</option>';
      }).join('')
    + '</select>'
    + '<div class="muted" style="font-size:.74rem;margin-top:6px">'
    +   '留空 = 不限制。规则在服务端复核，批量导入同样生效；空值一律放过（没有必填概念）。'
    + '</div></div>'
    + '<div id="ffRuleBody"></div>';
  return h;
}

/** 按当前选中的类型渲染规则参数区（类型下拉变化时调用） */
function paintRuleBody(rules){
  var box = $('ffRuleBody');
  if(!box) return;
  var t = ($('ffRuleType') || {}).value || '';
  var r = rules || {};
  var h = '';
  if(t === 'text'){
    h = '<div class="mb-form-grid">'
      + '<div class="field"><label>最少字符</label><input id="ffRMinLen" class="inp" inputmode="numeric" maxlength="3" value="' + attr(r.minLen || '') + '" placeholder="不填 = 不限"></div>'
      + '<div class="field"><label>最多字符</label><input id="ffRMaxLen" class="inp" inputmode="numeric" maxlength="3" value="' + attr(r.maxLen || '') + '" placeholder="不填 = 不限"></div>'
      + '</div><p class="hint" style="margin-top:-4px">按字符数算，中文一个字算一个。</p>';
  } else if(t === 'number'){
    h = '<div class="field"><label>固定位数</label><input id="ffRDigits" class="inp" inputmode="numeric" maxlength="2" value="' + attr(r.digits || '') + '" placeholder="如手机号填 11；与范围二选一或都填"></div>'
      + '<div class="mb-form-grid"><div class="field"><label>最小值</label><input id="ffRMin" class="inp" inputmode="numeric" value="' + attr(r.min == null ? '' : r.min) + '" placeholder="不限"></div>'
      + '<div class="field"><label>最大值</label><input id="ffRMax" class="inp" inputmode="numeric" value="' + attr(r.max == null ? '' : r.max) + '" placeholder="不限"></div></div>'
      + '<p class="hint" style="margin-top:-4px">只能填数字，字母符号一律拒绝。</p>';
  } else if(t === 'time'){
    /* v3.5.15：站主要求「入团时间精确到月份」—— 加「精确到」三档，
       区间输入框跟着变（date / month / 四位年份）。 */
    var prec = r.precision || 'day';
    var boundInput = function(bid, val){
      if(prec === 'year') return '<input id="' + bid + '" class="inp" inputmode="numeric" maxlength="4" value="' + attr(val || '') + '" placeholder="如 2020">';
      if(prec === 'month') return '<input id="' + bid + '" class="inp" type="month" value="' + attr(val || '') + '">';
      return '<input id="' + bid + '" class="inp" type="date" value="' + attr(val || '') + '">';
    };
    h = '<div class="field"><label>精确到</label>'
      + '<select id="ffRPrec" class="inp">'
      +   '<option value="day"' + (prec === 'day' ? ' selected' : '') + '>日 —— 2024-05-13</option>'
      +   '<option value="month"' + (prec === 'month' ? ' selected' : '') + '>月 —— 2024-05（入团时间这类只到月份）</option>'
      +   '<option value="year"' + (prec === 'year' ? ' selected' : '') + '>年 —— 2024</option>'
      + '</select></div>'
      + '<div class="mb-form-grid">'
      + '<div class="field"><label>不早于</label>' + boundInput('ffRMin', r.min) + '</div>'
      + '<div class="field"><label>不晚于</label>' + boundInput('ffRMax', r.max) + '</div>'
      + '</div><p class="hint" style="margin-top:-4px">填「月」时，表格里写 2024-05、2024/5、2024年5月 都能导入。</p>';
    /* 换精度后重建这一块（把已填的区间 / 精度带上，不丢） */
    setTimeout(function(){
      var sel = $('ffRPrec');
      if(!sel) return;
      sel.onchange = function(){
        paintRuleBody({ type:'time', precision: sel.value,
          min: ($('ffRMin') || {}).value || '', max: ($('ffRMax') || {}).value || '' });
      };
    }, 0);
  } else if(t === 'select'){
    var opts = (r.options || []).slice();
    h = '<div class="field"><label><label class="chk" style="display:inline-flex"><input type="checkbox" id="ffRMulti"' + (r.multi ? ' checked' : '') + '> 多选</label></label>'
      + '<div id="ffOpts">'
      + opts.map(function(o, i){
          return '<div class="opt-row" style="display:flex;gap:6px;margin-bottom:6px">'
            + '<input class="inp ff-opt" value="' + attr(o) + '" maxlength="40" placeholder="选项文字">'
            + '<button class="btn btn-sm btn-secondary ff-opt-del" type="button">删</button></div>';
        }).join('')
      + '</div>'
      + '<button class="btn btn-sm btn-secondary" id="ffOptAdd" type="button">+ 添加选项</button>'
      + '<p class="hint" style="margin-top:6px">同学只能从这些选项里选，禁止自由输入。</p></div>';
  }
  box.innerHTML = h;
  var add = $('ffOptAdd');
  if(add) add.onclick = function(){
    var row = document.createElement('div');
    row.className = 'opt-row';
    row.style.cssText = 'display:flex;gap:6px;margin-bottom:6px';
    row.innerHTML = '<input class="inp ff-opt" maxlength="40" placeholder="选项文字">'
      + '<button class="btn btn-sm btn-secondary ff-opt-del" type="button">删</button>';
    $('ffOpts').appendChild(row);
    row.querySelector('.ff-opt-del').onclick = function(){ row.parentNode.removeChild(row); };
    row.querySelector('.ff-opt').focus();
  };
  Array.prototype.forEach.call(box.querySelectorAll('.ff-opt-del'), function(b){
    b.onclick = function(){ b.parentNode.parentNode.removeChild(b.parentNode); };
  });
}

/** 从规则编辑器收集规则对象（形状交给服务端 normalize 兜底） */
function collectRules(){
  var t = ($('ffRuleType') || {}).value || '';
  if(!t) return {};
  if(t === 'text'){
    var o = { type:'text' };
    var mn = Number(($('ffRMinLen') || {}).value || 0), mx = Number(($('ffRMaxLen') || {}).value || 0);
    if(mn > 0) o.minLen = mn;
    if(mx > 0) o.maxLen = mx;
    return o;
  }
  if(t === 'number'){
    var n = { type:'number' };
    var d = Number(($('ffRDigits') || {}).value || 0);
    var lo = ($('ffRMin') || {}).value, hi = ($('ffRMax') || {}).value;
    if(d > 0) n.digits = d;
    if(lo !== '' && lo != null && isFinite(Number(lo))) n.min = Number(lo);
    if(hi !== '' && hi != null && isFinite(Number(hi))) n.max = Number(hi);
    return n;
  }
  if(t === 'time'){
    var tm = { type:'time' };
    /* v3.5.15：precision 决定这是「日 / 月 / 年」哪一档 */
    var pr = ($('ffRPrec') || {}).value || 'day';
    if(pr !== 'day') tm.precision = pr;
    var a = ($('ffRMin') || {}).value, b2 = ($('ffRMax') || {}).value;
    if(a) tm.min = a;
    if(b2) tm.max = b2;
    return tm;
  }
  /* select：选项去空白、去重、保序（与服务端同规则） */
  var seen = {}, list = [];
  Array.prototype.forEach.call(document.querySelectorAll('.ff-opt'), function(inp){
    var s = (inp.value || '').trim();
    if(!s || seen[s]) return;
    seen[s] = 1; list.push(s);
  });
  return { type:'select', options:list, multi:!!(($('ffRMulti') || {}).checked) };
}

/* ============================================================================
 * 一键加密存量资料（v3.5.1）
 * ---------------------------------------------------------------------------
 * 站主要求：「之前的那些资料，在更改加密方式之前的，现在可以加密吗？
 * 我不可能重新再导一次，因为量太多了。」
 *
 * 于是有了这个按钮：扫一遍数据库，把**还是明文**的字段就地加密，
 * 已经是密文的自动跳过（幂等，中途断了再点一次即可，不会叠层）。
 *
 * ⚠️ 为什么前端要循环调用而不是一次完成：
 *    Cloudflare Workers 免费版单个请求最多 50 个子请求，一行资料的 UPDATE
 *    算一次。全班 50 多人一次跑完会 500，所以每批 15 条、循环到 remaining=0。
 * ⚠️ 按钮运行期间禁用，防止重复点导致两批并发写同一行。
 * ========================================================================= */
function encryptAllProfiles(){
  openModal({
    title: '一键加密存量资料',
    sub: '把数据库中还是明文的资料就地加密（姓名、学号、身份证、微信等）',
    body:
      '<div class="alert info" style="margin:0 0 12px">'
    + '  v3.5.0 起新保存的资料会自动加密，<b>以前导入的资料仍是明文</b>。'
    + '  这个按钮会把它们<b>就地</b>转成密文 —— 不用重新导入、不会改动任何内容，'
    + '  前台与后台的显示也完全不变。<br>'
    + '  全班约 50 人会分几批处理，每批 15 条，<b>请保持页面打开</b>直到提示完成。'
    + '</div>'
    + '<div id="encStat" class="muted" style="font-size:.82rem;line-height:1.8">准备开始…</div>'
    + '<div id="encBar" style="height:6px;border-radius:999px;background:#f0e7de;overflow:hidden;margin-top:10px">'
    + '  <div id="encBarIn" style="height:100%;width:0;background:#b45309;transition:width .25s"></div>'
    + '</div>',
    foot:
      '<button class="btn btn-secondary" id="encClose">关闭</button>'
    + '<button class="btn" id="encGo">开始加密</button>',
    onMount: function(){
      var stat = $('encStat'), bar = $('encBarIn');
      var go = $('encGo'), close = $('encClose');
      close.onclick = closeModal;
      go.onclick = function(){ go.disabled = true; go.textContent = '处理中…'; run(); };

      function setText(t, pct){
        if(stat) stat.innerHTML = t;
        if(bar && pct != null) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
      }

      /* 每批 15 条，最多跑 12 批（= 180 条，够一个年级；防死循环） */
      function run(){
        var batch = 0, total = 0;
        function step(){
          if(batch >= 12){
            setText('⚠️ 已处理 12 批仍未完成，请再点一次「开始加密」继续。', 100);
            go.disabled = false; go.textContent = '再跑一批';
            return;
          }
          api('/admin?action=encrypt-profiles', {
            method: 'POST',
            body: { limit: 15 },
          }).then(function(j){
            total += (j.encrypted || 0);
            batch++;
            var all = j.totalProfiles || 0;
            var left = j.plainLeft || 0;
            var pct = all ? ((all - left) / all * 100) : 100;
            if(j.done || left === 0){
              setText('✅ 全部完成：共加密 <b>' + total + '</b> 条资料'
                + (j.skipped ? '（' + j.skipped + ' 条本就无需处理）' : '')
                + '。<br>现在数据库里这些字段都是密文了，前台后台照常显示。', 100);
              go.textContent = '已完成';
              go.disabled = true;
              loadMembers();
              return;
            }
            setText('正在处理… 已加密 <b>' + total + '</b> 条，还剩约 <b>' + left + '</b> 条', pct);
            setTimeout(step, 60);
          }).catch(function(e){
            setText('❌ 出错了：' + esc(e.message)
              + '<br>已成功的批次不会丢，点「开始加密」会从没处理过的地方继续。', null);
            go.disabled = false; go.textContent = '继续';
          });
        }
        step();
      }
    },
  });
}

function renderFieldPanel(){
  var body = $('mbFieldBody');
  if(!body) return;
  body.innerHTML = '<div class="loading"><div class="spinner"></div>加载字段…</div>';

  loadFieldMeta().then(function(list){
    paintFieldPanel(list);
  }).catch(function(e){
    body.innerHTML = '<div class="alert danger" style="margin:14px">加载字段失败：' + esc(e.message) + '</div>';
  });
}

/* ============================================================================
 * v3.6.1：字段体检 / 恢复预置字段
 * ----------------------------------------------------------------------------
 * 站主原话：「字段管理之前的那些比如入团时间、发展团员编号那些你前几次更新
 *           的时候直接给我删了，我现在后台没有数据，看看能不能恢复。」
 *
 * 先体检、再恢复，两步走：
 *   · 体检告诉你：字段表还剩几行、墓碑里躺了谁、17 个预置字段哪些定义没了、
 *     哪些列已经不存在（列没了 = 数据也没了，只能重新录入）；
 *   · 恢复会清空墓碑 + 补回定义（列还在的，值立刻回来）。
 * ========================================================================= */
function repairFieldsDialog(){
  api('/admin?action=repair-fields', { method:'POST', body:{} }).then(function(j){
    var cols = j.columns || [];
    var noMeta = cols.filter(function(x){ return !x.hasMeta; }).map(function(x){ return x.label; });
    var noCol = cols.filter(function(x){ return !x.hasColumn; }).map(function(x){ return x.label; });
    var tomb = j.tombstoned || [];
    var html = '<div class="alert info" style="margin-bottom:12px">'
      + '当前字段表 <b>' + (j.metaCount || 0) + '</b> 行；'
      + '「已删除记录」里有 <b>' + tomb.length + '</b> 个字段'
      + (tomb.length ? '（' + esc(tomb.slice(0, 12).join('、')) + (tomb.length > 12 ? '…' : '') + '）' : '')
      + '。<br>这些记录会让每次升级都再删一遍对应字段 —— 恢复时会一并清空。</div>'
      + (noMeta.length
          ? '<div class="alert warn" style="margin-bottom:10px">缺少字段定义：' + esc(noMeta.join('、')) + '</div>'
          : '<div class="alert ok" style="margin-bottom:10px">17 个预置字段的定义都在。</div>')
      + (noCol.length
          ? '<div class="alert danger" style="margin-bottom:10px">以下字段的**数据库列已不存在**：'
            + esc(noCol.join('、'))
            + '<br><span style="font-size:.78rem">这几项的历史数据无法通过本操作找回（列被删除时值就没了）。'
            + '恢复会重建空列，之后可以重新录入或从旧表格导入。</span></div>'
          : '<div class="alert ok">所有预置字段的数据库列都还在 —— 恢复后数据会立刻回来。</div>')
      + '<p class="hint">恢复仅补充定义与默认校验规则，不覆盖已调整的可见性、标签与本人可编辑设置。</p>';
    openModal({
      title: '字段体检 / 恢复', sub: '先把损失范围看清楚，再决定要不要恢复',
      body: html,
      foot: '<button class="btn btn-secondary" id="ffRpCancel">取消</button>'
          + '<button class="btn" id="ffRpGo">恢复预置字段</button>',
      onMount: function(box){
        box.querySelector('#ffRpCancel').onclick = closeModal;
        box.querySelector('#ffRpGo').onclick = function(){
          var go = box.querySelector('#ffRpGo');
          go.disabled = true; go.textContent = '恢复中…';
          api('/admin?action=repair-fields', { method:'POST', body:{ apply:true } })
            .then(function(r){
              closeModal();
              var msg = '已恢复。有数据的字段 ' + ((r.recovered||[]).length) + ' 个';
              if((r.stillEmpty||[]).length) msg += '；仍为空：' + (r.stillEmpty||[]).map(function(x){ return x.label; }).join('、');
              toast(msg, 'ok');
              renderFieldPanel();
            })
            .catch(function(e){
              go.disabled = false; go.textContent = '恢复预置字段';
              toast('恢复失败：' + (e.message || e), 'danger');
            });
        };
      },
    });
  }).catch(function(e){ toast('体检失败：' + (e.message || e), 'danger'); });
}

function paintFieldPanel(list){
  var body = $('mbFieldBody');
  if(!body) return;
  var total = STATE.members.totalProfiles || 0;

  var rows = list.map(function(f){
    var visBadge = '<span class="badge ' + (f.visibility === 'public' ? 'badge-gray'
                   : f.visibility === 'committee' ? 'badge-blue' : 'badge-orange') + '">'
                   + esc(VIS_LABEL[f.visibility] || f.visibility) + '</span>';
    var filled = f.filledCount == null ? '<span class="muted">—</span>'
                   : '<span class="mono">' + f.filledCount + ' / ' + total + '</span>';

    /* 快捷切换可见性：三个小按钮，当前档高亮 */
    var quick = ['public', 'committee', 'self', 'admin'].map(function(v){
      return '<button class="btn btn-xs' + (f.visibility === v ? '' : ' btn-secondary')
        + '" data-fv="' + v + '" data-ff="' + attr(f.field) + '" title="' + attr(VIS_DESC[v]) + '">'
        + esc(VIS_LABEL[v]) + '</button>';
    }).join(' ');

    var tag = f.isCustom
      ? '<span class="badge badge-green">自定义</span>'
      : '<span class="badge badge-gray">系统</span>';

    /* v3.5.5 校验规则徽标：一句话人话 + 类型徽章 */
    var rd = ruleDesc(f.rules);
    var ruleCell = rd
      ? '<span class="badge badge-blue" title="' + attr(rd) + '">' + esc(rd) + '</span>'
      : '<span class="muted">未设置</span>';

    return '<tr data-ff-row="' + attr(f.field) + '">'
      /* v3.5.14 #7：拖这个把手调整顺序（原来要点「排序」手输数字） */
      + '<td class="ff-drag"><span class="ff-grip" title="按住拖动调整顺序">⠿</span></td>'
      + '<td><b>' + esc(f.label) + '</b>'
      +   '<div class="mono muted" style="font-size:.72rem">' + esc(f.field) + '</div></td>'
      + '<td class="nowrap">' + visBadge + '</td>'
      + '<td class="nowrap">' + quick + '</td>'
      /* v3.5.40（站主 #1）：本人可编辑 —— 开着同学能自己改，关着只能后台改 */
      + '<td class="nowrap">'
      +   '<button class="btn btn-xs' + (f.selfEdit ? '' : ' btn-secondary') + '"'
      +     ' data-fse="' + attr(f.field) + '" data-fsel="' + attr(f.label) + '"'
      +     ' data-fson="' + (f.selfEdit ? '1' : '0') + '"'
      +     ' title="' + attr(f.selfEdit ? '同学可以自己改这一项（点击关闭）' : '只有后台能改（点击开放给本人）') + '">'
      +     (f.selfEdit ? '✓ 允许' : '不允许') + '</button>'
      + '</td>'
      + '<td class="nowrap mono">' + (f.sortOrder != null ? f.sortOrder : '—') + '</td>'
      + '<td class="nowrap">' + filled + '</td>'
      + '<td class="nowrap">' + ruleCell + '</td>'
      + '<td class="nowrap">' + tag + '</td>'
      + '<td class="nowrap" style="text-align:right"><div class="row-actions">'
      +   '<button data-fe="rule" data-ff="' + attr(f.field) + '" data-fl="' + attr(f.label) + '" data-fr="' + attr(JSON.stringify(f.rules || {})) + '">规则</button>'
      +   '<button data-fe="rename" data-ff="' + attr(f.field) + '" data-fl="' + attr(f.label) + '">改名</button>'
      /* v3.5.14 #7：系统字段也允许删（姓名/学号由后端硬保护）。
         非自定义字段删除时前端会要求手输字段名确认。 */
      +   '<button class="danger" data-fe="del" data-ff="' + attr(f.field) + '" data-fl="' + attr(f.label) + '"'
      +     (f.isCustom ? '' : ' data-force="1"') + '>删除</button>'
      + '</div></td>'
      + '</tr>';
  }).join('');

  body.innerHTML =
    '<div class="panel-head" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 16px 0">'
    + '<h3 style="margin:0;font-size:.95rem">字段管理</h3>'
    + '<span class="muted" style="font-size:.76rem">共 ' + list.length + ' 个字段'
    +   '（其中自定义 ' + list.filter(function(f){ return f.isCustom; }).length + ' 个）</span>'
    + '<span style="flex:1"></span>'
    + '<button class="btn btn-sm" id="ffAdd">' + svg('plus', 14) + '新增字段</button>'
    + '<button class="btn btn-sm btn-secondary" id="ffRefresh">' + svg('refresh', 14) + '刷新</button>'
    + '</div>'
    + '<div class="alert info" style="margin:14px 16px 0">'
    +   '可见性是<b>全班默认</b>：改这里会影响所有同学。想只调某一个人，'
    +   '去他的「编辑」弹窗里改（那里的设置只对该同学生效）。'
    +   '本人也可以在个人中心把联系方式收窄为「仅自己可见」。'
    + '</div>'
    + '<div class="table-wrap" style="margin-top:12px"><table><thead><tr>'
    + '<th class="nowrap" title="按住把手上下拖动即可调整顺序">拖动</th>'
    + '<th>字段</th><th class="nowrap">可见性</th><th class="nowrap">快捷切换</th>'
    + '<th class="nowrap" title="打开后，同学可以在「我的资料」里自己改这一项">本人可编辑</th>'
    + '<th class="nowrap">已填</th><th class="nowrap">校验规则</th><th class="nowrap">类型</th>'
    + '<th style="text-align:right">操作</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table></div>';

  var addBtn = $('ffAdd');
  if(addBtn) addBtn.onclick = addFieldDialog;
  var rfBtn = $('ffRefresh');
  if(rfBtn) rfBtn.onclick = renderFieldPanel;

  Array.prototype.forEach.call(body.querySelectorAll('[data-fv]'), function(b){
    b.onclick = function(){
      var f = b.dataset.ff, v = b.dataset.fv;
      api('/admin?action=set-visibility', { method:'POST', body:{ field:f, visibility:v } })
        .then(function(){ toast('已把「' + f + '」改为' + VIS_LABEL[v]); renderFieldPanel(); })
        .catch(function(e){ toast(e.message, 'danger'); });
    };
  });
  /* v3.5.40（站主 #1）：本人可编辑开关 */
  Array.prototype.forEach.call(body.querySelectorAll('[data-fse]'), function(b){
    b.onclick = function(){
      var f = b.dataset.fse, label = b.dataset.fsel;
      var next = b.dataset.fson !== '1';
      b.disabled = true;
      api('/admin?action=set-self-edit', { method:'POST', body:{ field:f, selfEdit:next } })
        .then(function(){
          toast(next ? ('已允许本人编辑「' + label + '」') : ('已关闭「' + label + '」的本人编辑'), 'ok');
          renderFieldPanel();
        })
        .catch(function(e){ b.disabled = false; toast(e.message, 'danger'); });
    };
  });
  Array.prototype.forEach.call(body.querySelectorAll('[data-fe]'), function(b){
    var f = b.dataset.ff;
    if(b.dataset.fe === 'rule')   b.onclick = function(){ rulesFieldDialog(f, b.dataset.fl, JSON.parse(b.dataset.fr || '{}')); };
    if(b.dataset.fe === 'rename') b.onclick = function(){ renameFieldDialog(f, b.dataset.fl); };
    if(b.dataset.fe === 'del')    b.onclick = function(){ deleteFieldConfirm(f, b.dataset.fl, b.dataset.force === '1'); };
  });

  /* v3.5.14 #7：字段拖拽排序（后台这版不依赖主站的动效开关，精简实现） */
  var tbody = body.querySelector('tbody');
  if(tbody) attachFieldDrag(tbody);
}

/** 后台字段表拖拽：按住把手上下拖，松手批量保存一次 */
function attachFieldDrag(tbody){
  var st = null;
  function rowsNow(){ return Array.prototype.slice.call(tbody.querySelectorAll('tr[data-ff-row]')); }
  tbody.addEventListener('pointerdown', function(e){
    var g = e.target.closest && e.target.closest('.ff-grip');
    if(!g) return;
    var row = g.closest('tr[data-ff-row]');
    if(!row) return;
    e.preventDefault();
    st = { row: row, pid: e.pointerId };
    row.classList.add('dragging');
    try{ g.setPointerCapture(e.pointerId); }catch(_){}
  });
  tbody.addEventListener('pointermove', function(e){
    if(!st || e.pointerId !== st.pid) return;
    if(e.cancelable) e.preventDefault();
    var rows = rowsNow();
    if(rows.length < 2) return;
    var cur = rows.indexOf(st.row);
    var target = cur;
    for(var i = 0; i < rows.length; i++){
      var r = rows[i].getBoundingClientRect();
      if(e.clientY < r.top + r.height / 2){ target = i; break; }
      target = i;
    }
    if(target === cur) return;
    if(target > cur) tbody.insertBefore(st.row, rows[target].nextSibling);
    else tbody.insertBefore(st.row, rows[target]);
  });
  function finish(e){
    if(!st) return;
    st.row.classList.remove('dragging');
    st = null;
    var order = rowsNow().map(function(r){ return r.getAttribute('data-ff-row'); });
    api('/admin?action=reorder-fields', { method:'POST', body:{ fields: order } })
      .then(function(j){ toast(j.message || '排序已保存', 'ok'); renderFieldPanel(); })
      .catch(function(err){ toast(err.message || String(err), 'danger'); renderFieldPanel(); });
  }
  tbody.addEventListener('pointerup', finish);
  tbody.addEventListener('pointercancel', finish);
}

/** ============================================================================
 * v3.5.15：新增字段时「英文键名」按中文名自动生成（站主要求）
 * ----------------------------------------------------------------------------
 * 规则（我定的，够用且稳定）：
 *   ① 先查整词表 —— 班级资料高频字段直接给地道英文（学籍号 → student_no）
 *   ② 否则逐字转拼音（间 → jian），英文数字原样保留，空格/连字符转下划线
 *   ③ 认不出的汉字退化成 u+码点（如 㛃 → u36c3），保证键名永远合法
 *   ④ 结果强制小写字母开头、≤31 字符；真的空就 field_<时间戳后 4 位>
 *   用户随时能在弹窗里改，改过之后就不再自动覆盖。
 * ========================================================================= */
var FIELD_PINYIN = (function(){
  var raw = '时:shi 间:jian 日:ri 期:qi 年:nian 月:yue 学:xue 号:hao 籍:ji 入:ru 团:tuan '
    + '家:jia 庭:ting 住:zhu 址:zhi 姓:xing 名:ming 长:zhang 电:dian 话:hua 手:shou 机:ji '
    + '微:wei 信:xin 邮:you 箱:xiang 身:shen 份:fen 证:zheng 考:kao 试:shi 编:bian 班:ban '
    + '级:ji 校:xiao 民:min 族:zu 政:zheng 治:zhi 面:mian 貌:mao 性:xing 别:bie 男:nan 女:nv '
    + '出:chu 生:sheng 宿:su 舍:she 床:chuang 位:wei 寝:qin 室:shi 爱:ai 好:hao 特:te 社:she '
    + '职:zhi 务:wu 备:bei 注:zhu 分:fen 组:zu 户:hu 贯:guan 监:jian 护:hu 人:ren 联:lian '
    + '系:xi 方:fang 式:shi 地:di 码:ma 尺:chi 寸:cun 服:fu 体:ti 重:zhong 高:gao 健:jian '
    + '康:kang 疾:ji 病:bing 过:guo 敏:min 药:yao 物:wu 父:fu 母:mu 亲:qin 哥:ge 姐:jie '
    + '弟:di 妹:mei 爷:ye 奶:nai 姥:lao 姨:yi 叔:shu 舅:jiu 兴:xing 趣:qu 简:jian 历:li '
    + '奖:jiang 惩:cheng 义:yi 工:gong 志:zhi 愿:yuan 者:zhe 卡:ka 银:yin 行:hang 支:zhi '
    + '付:fu 宝:bao 口:kou 座:zuo 楼:lou 层:ceng 门:men 牌:pai 区:qu 县:xian 市:shi 省:sheng '
    + '镇:zhen 村:cun 路:lu 街:jie 小:xiao 栋:dong 单:dan 元:yuan 称:cheng 全:quan 部:bu '
    + '类:lei 型:xing 科:ke 目:mu 成:cheng 绩:ji 排:pai 序:xu 总:zong 平:ping 均:jun 最:zui '
    + '低:di 等:deng 第:di 一:yi 二:er 三:san 四:si 五:wu 六:liu 七:qi 八:ba 九:jiu 十:shi '
    + '百:bai 千:qian 万:wan 角:jiao 阶:jie 段:duan 次:ci 件:jian 照:zhao 片:pian 头:tou '
    + '像:xiang 现:xian 居:ju 通:tong 讯:xun 属:shu 朋:peng 友:you 同:tong 老:lao 师:shi '
    + '主:zhu 任:ren 干:gan 委:wei 员:yuan 课:ke 代:dai 表:biao 支:zhi 书:shu 记:ji 教:jiao '
    + '活:huo 育:yu 文:wen 艺:yi 宣:xuan 传:chuan 心:xin 理:li 纪:ji 律:lv 定:ding 向:xiang '
    + '选:xuan 修:xiu 必:bi 班:ban 主:zhu 题:ti 课:ke 亮:liang 点:dian 问:wen 题:ti 需:xu '
    + '求:qiu 建:jian 议:yi 评:ping 语:yu 寄:ji 语:yu 梦:meng 想:xiang 目:mu 标:biao 座:zuo '
    + '右:you 铭:ming 格:ge 言:yan 兴:xing 趣:qu 才:cai 艺:yi 运:yun 动:dong 球:qiu 篮:lan '
    + '足:zu 乒:ping 乓:pang 羽:yu 毛:mao 跑:pao 步:bu 跳:tiao 远:yuan 泳:yong 唱:chang 歌:ge '
    + '舞:wu 画:hua 琴:qin 棋:qi 书:shu 法:fa 摄:she 影:ying 演:yan 讲:jiang 辩:bian 论:lun '
    + '科:ke 创:chuang 编:bian 程:cheng 机:ji 器:qi 人:ren 模:mo 型:xing 实:shi 验:yan 室:shi '
    + '中:zhong 报:bao 说:shuo 明:ming 情:qing 况:kuang 条:tiao 内:nei 容:rong 息:xi 数:shu 据:ju '
    + '字:zi 言:yan 度:du 水:shui 自:zi 己:ji 其:qi 他:ta 她:ta 与:yu 及:ji 和:he 为:wei 用:yong '
    + '于:yu 个:ge 把:ba 关:guan 要:yao 可:ke 以:yi 不:bu 有:you 无:wu 多:duo 少:shao 大:da '
    + '前:qian 后:hou 上:shang 下:xia 里:li 外:wai 东:dong 西:xi 南:nan 北:bei 单:dan 位:wei '
    + '课:ke 外:wai 补:bu 习:xi 班:ban 排:pai 名:ming 次:ci 段:duan 班:ban 号:hao 座:zuo '
    + '舍:she 长:zhang 室:shi 友:you 联:lian 系:xi 人:ren 电:dian 子:zi 信:xin 箱:xiang 密:mi 码:ma';
  var o = {};
  raw.split(/\s+/).forEach(function(p){
    var i = p.indexOf(':');
    if(i > 0) o[p.slice(0, i)] = p.slice(i + 1);
  });
  return o;
})();

/* 整词优先：这些词逐字拼音会变成 sushehao 之类，直接给地道英文 */
var FIELD_WORDS = {
  '学籍号': 'student_no', '学号': 'student_id', '考籍号': 'exam_reg_no',
  '入团时间': 'league_date', '入团日期': 'league_date', '团员编号': 'league_no',
  '发展团员编号': 'league_no', '家庭住址': 'home_address', '家庭地址': 'home_address',
  '现居住址': 'current_address', '户籍地址': 'registered_address',
  '家长姓名': 'parent_name', '家长电话': 'parent_phone', '家长手机': 'parent_phone',
  '紧急联系人': 'emergency_contact', '紧急联系电话': 'emergency_phone',
  '宿舍号': 'dorm_no', '宿舍楼': 'dorm_building', '床位号': 'bed_no',
  '出生日期': 'birth_date', '生日': 'birthday', '身份证号': 'id_card',
  '电子邮箱': 'email', '邮箱': 'email', '邮政编码': 'zip_code',
  '校服尺寸': 'uniform_size', '身高': 'height', '体重': 'weight',
  '兴趣爱好': 'hobbies', '特长': 'specialty', '社团': 'club', '职务': 'duty',
  '备注': 'remark', '分组': 'group_name', '家长微信': 'parent_wechat',
  '家长QQ': 'parent_qq', '监护人': 'guardian', '监护人电话': 'guardian_phone',
  '班级职务': 'class_duty', '学生特长': 'student_specialty', '中考报名号': 'zhongkao_no',
  '报名号': 'signup_no', '座位号': 'seat_no', '家长单位': 'parent_workplace',
  '家庭情况': 'family_info', '特殊情况': 'special_note', '是否需要住宿': 'need_dorm',
  '宿舍长': 'dorm_leader', '寝室长': 'dorm_leader', '班主任': 'head_teacher',
  '任课老师': 'subject_teacher', '家长联系方式': 'parent_contact'
};

/** 中文名 → 英文键名（规则见上方注释） */
function autoFieldKey(label){
  var s = String(label == null ? '' : label).trim();
  if(!s) return '';
  /* 去掉括号里的补充说明：「身高（cm）」→「身高」 */
  var bare = s.replace(/[（(][^）)]*[）)]/g, '').trim() || s;
  if(FIELD_WORDS[bare]) return FIELD_WORDS[bare];
  var out = '';
  for(var i = 0; i < bare.length; i++){
    var ch = bare.charAt(i);
    if(/[A-Za-z0-9]/.test(ch)){ out += ch.toLowerCase(); continue; }
    if(/[\s_\-·—、,，.。:：/]/.test(ch)){ out += '_'; continue; }
    if(FIELD_PINYIN[ch]){ out += FIELD_PINYIN[ch]; continue; }
    var code = ch.charCodeAt(0);
    if(code > 127) out += 'u' + code.toString(16);   /* 生僻字保底，仍合法 */
  }
  out = out.replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28);
  if(!out) out = 'field_' + String(Date.now()).slice(-4);
  if(!/^[a-z]/.test(out)) out = 'f_' + out;
  return out.slice(0, 31);
}

/** 新增自定义字段弹窗。
 *  v3.4.0 站主报「弹窗不在中央、被遮挡」：原来手写的 .dialog-mask/.dialog
 *  在全站样式里根本没有定义（只有这一处在用），结果是按普通文档流渲染，
 *  掉在成员长表格的下面（页面底部）。改用通用 openModal() 体系，
 *  fixed + flex 居中，与其它弹窗行为一致。
 *  v3.5.5：加「校验规则」编辑器（站主：「新增字段都可以自由勾选配置以上规则」）。 */
function addFieldDialog(){
  var vis = 'self';
  var body =
    '<div class="alert info" style="margin:0 0 14px">'
    +   '加完之后，每位同学都能在「编辑资料」里填这个字段，'
    +   '前台将按所设可见性展示。'
    + '</div>'
    + '<div class="field"><label>中文名称 <span class="muted">（同学看到的名字）</span></label>'
    +   '<input id="ffLabel" placeholder="例如：学籍号" maxlength="20" autocomplete="off"></div>'
    + '<div class="field"><label>英文键名 <span class="muted">（内部用，只能小写字母 / 数字 / 下划线）</span></label>'
    +   '<input id="ffKey" placeholder="填了中文名会自动生成，也可自己改" maxlength="31" autocomplete="off">'
    +   '<div class="muted" style="font-size:.72rem;margin-top:4px" id="ffKeyHint">'
    +     '英文键名创建后不能再改（它同时是数据库列名）。'
    +   '</div></div>'
    + '<div class="field"><label>可见范围</label>'
    +   '<div style="display:flex;gap:8px;flex-wrap:wrap" id="ffVis">'
    +     ['public','committee','self','admin'].map(function(v, i){
            return '<button class="btn btn-sm ' + (i === 2 ? '' : 'btn-secondary')
              + '" data-ffv="' + v + '">' + esc(VIS_LABEL[v]) + '</button>';
          }).join('')
    +   '</div>'
    +   '<div class="muted" style="font-size:.74rem;margin-top:6px" id="ffVisHint">' + esc(VIS_DESC[vis]) + '</div>'
    + '</div>'
    + ruleEditorHtml({});
  var foot =
    '<button class="btn btn-secondary" id="ffCancel">取消</button>'
    + '<button class="btn" id="ffOk">' + svg('plus', 14) + '创建字段</button>';

  openModal({
    title: '新增资料字段',
    sub: '前台将按可见范围展示这个字段',
    body: body,
    foot: foot,
    onMount: function(){
      Array.prototype.forEach.call($('ffVis').querySelectorAll('[data-ffv]'), function(b){
        b.onclick = function(){
          vis = b.dataset.ffv;
          Array.prototype.forEach.call($('ffVis').querySelectorAll('[data-ffv]'), function(x){
            x.className = 'btn btn-sm ' + (x.dataset.ffv === vis ? '' : 'btn-secondary');
          });
          $('ffVisHint').textContent = VIS_DESC[vis];
        };
      });
      paintRuleBody({});
      $('ffRuleType').onchange = function(){ paintRuleBody({}); };

      /* v3.5.15：中文名 → 英文键名自动生成。用户一旦自己改过键名，
         就不再自动覆盖（清空则恢复自动）。 */
      var labEl = $('ffLabel'), keyEl = $('ffKey'), keyHint = $('ffKeyHint');
      var keyManual = false;
      function paintKeyHint(k){
        if(!keyHint) return;
        keyHint.textContent = keyManual
          ? '已手动指定键名；清空后恢复自动生成。'
          : (k ? '已按中文名自动生成：' + k + '（可以改）' : '填了中文名会自动生成；英文键名创建后不能再改。');
      }
      function syncKey(){
        if(keyManual) return;
        var k = autoFieldKey(labEl ? labEl.value : '');
        if(keyEl) keyEl.value = k;
        paintKeyHint(k);
      }
      if(labEl) labEl.addEventListener('input', syncKey);
      if(keyEl) keyEl.addEventListener('input', function(){
        keyManual = keyEl.value.trim() !== '';
        paintKeyHint('');
      });

      $('ffCancel').onclick = closeModal;
      $('ffOk').onclick = function(){
        var label = ($('ffLabel').value || '').trim();
        var key   = ($('ffKey').value || '').trim().toLowerCase();
        /* 没填（或事件没触发）时按中文名兜底生成，避免卡在「请填写英文键名」 */
        if(!key && label) key = autoFieldKey(label);
        if(!label) return toast('请填写中文名称', 'danger');
        if(!key)   return toast('请填写英文键名（如 school_id）', 'danger');
        if(!/^[a-z][a-z0-9_]{0,30}$/.test(key)){
          return toast('英文键名只能小写字母开头，由小写字母、数字、下划线组成', 'danger');
        }
        var rules = collectRules();
        if(rules.type === 'select' && !rules.options.length){
          return toast('下拉字段至少要有一个选项', 'danger');
        }
        api('/admin?action=add-field', { method:'POST', body:{ field:key, label:label, visibility:vis, rules:rules } })
          .then(function(j){ closeModal(); toast(j.message || '已新增'); renderFieldPanel(); loadMembers(); })
          .catch(function(e){ toast(e.message, 'danger'); });
      };
      setTimeout(function(){ var el = $('ffLabel'); if(el) el.focus(); }, 60);
    },
  });
}

/** v3.5.5：改某个字段的校验规则（系统字段也能改 —— 预置规则只是出厂值）。 */
function rulesFieldDialog(field, label, curRules){
  var body =
    '<div class="alert info" style="margin:0 0 14px">'
    +   '规则管的是「<b>填了的时候</b>」长什么样，空值一律放过（本系统没有必填字段）。'
    +   '批量导入同样按规则复核，不合法的行会报出行号。'
    + '</div>'
    + '<div class="field"><label>字段</label><input class="inp" value="' + attr(label || field) + '（' + attr(field) + '）" disabled></div>'
    + ruleEditorHtml(curRules || {});
  openModal({
    title: '校验规则：' + (label || field),
    sub: '文本限字符数 / 数字限位数范围 / 日期选择器 / 下拉禁自由输入',
    body: body,
    foot: '<button class="btn btn-secondary" id="frCancel">取消</button>'
      + '<button class="btn" id="frOk">保存规则</button>',
    onMount: function(){
      paintRuleBody(curRules || {});
      $('ffRuleType').onchange = function(){ paintRuleBody(curRules || {}); };
      $('frCancel').onclick = closeModal;
      $('frOk').onclick = function(){
        var rules = collectRules();
        if(rules.type === 'select' && !rules.options.length){
          return toast('下拉字段至少要有一个选项', 'danger');
        }
        api('/admin?action=update-field', { method:'POST', body:{ field:field, rules:rules } })
          .then(function(j){
            closeModal(); toast('已保存「' + (label || field) + '」的校验规则');
            renderFieldPanel(); loadMembers();
          })
          .catch(function(e){ toast(e.message, 'danger'); });
      };
    },
  });
}

/** 改字段中文名 */
function renameFieldDialog(field, curLabel){
  var v = prompt('把字段「' + field + '」的中文名称改为：', curLabel || '');
  if(v == null) return;
  v = String(v).trim();
  if(!v) return toast('名称不能为空', 'danger');
  api('/admin?action=update-field', { method:'POST', body:{ field:field, label:v } })
    .then(function(){ toast('已改名'); renderFieldPanel(); loadMembers(); })
    .catch(function(e){ toast(e.message, 'danger'); });
}

/** 改字段排序 */
/** 删字段：危险操作，二次确认 + 说明后果 */
function deleteFieldConfirm(field, label, isSystem){
  /* v3.5.14 #7：自定义字段一次确认；系统预置字段要手输字段名才解锁 ——
     删预置字段会把全班该列的数据一起删掉，误点代价太大。 */
  var nm = label || field;
  if(!isSystem){
    confirmBox({
      title: '删除字段「' + nm + '」',
      html: '全班每位同学这个字段的值都会一起删掉，<b>无法恢复</b>。',
      detail: '如果只是不想让大家看到，建议改成「仅本人」或「仅后端可见」，而不是删除。',
      okText: '确认删除',
      danger: true,
    }).then(function(yes){
      if(!yes) return;
      api('/admin?action=delete-field', { method:'POST', body:{ field:field } })
        .then(function(j){ toast(j.message || '已删除', 'ok'); renderFieldPanel(); loadMembers(); })
        .catch(function(e){ toast(e.message, 'danger'); });
    });
    return;
  }
  openModal({
    title: '删除系统预置字段',
    sub: '「' + nm + '」（' + field + '）',
    body: '<div class="alert danger" style="margin:0 0 12px">'
      +   '这是站点预置字段，删除后：全班该字段的值全部消失且不可恢复；'
      +   '如果有页面 / 导入模版还在引用它，可能出现报错。'
      +   '<br>「姓名」「学号」是身份主键，系统不允许删除。'
      + '</div>'
      + '<div class="field"><label>确认请输入字段名 <b class="mono">' + esc(field) + '</b> 或中文名 <b class="mono">' + esc(label || '') + '</b></label>'
      +   '<input id="ffDelConfirm" autocomplete="off" placeholder="' + attr(field + ' 或 ' + (label || '')) + '"></div>',
    foot: '<button class="btn btn-ghost" data-no>取消</button>'
        + '<button class="btn btn-danger" data-yes disabled>确认删除</button>',
    onMount: function(box){
      var inp = box.querySelector('#ffDelConfirm');
      var yes = box.querySelector('[data-yes]');
      box.querySelector('[data-no]').onclick = closeModal;
      /* 站主可能直接打中文名（出生日期）而不是列名（birth_date）——
         两种都认，否则按钮永远灰着，看着就是「删不掉」。 */
      inp.oninput = function(){
        var v = inp.value.trim();
        yes.disabled = !(v === field || v === (label || '') || v === nm);
      };
      yes.onclick = function(){
        yes.disabled = true; yes.textContent = '删除中…';
        api('/admin?action=delete-field', { method:'POST', body:{ field:field, force:true } })
          .then(function(j){ closeModal(); toast(j.message || '已删除', 'ok'); renderFieldPanel(); loadMembers(); })
          .catch(function(e){ yes.disabled = false; yes.textContent = '确认删除'; toast(e.message, 'danger'); });
      };
      inp.focus();
    }
  });
}

/**
 * 算出某条资料上「可编辑额外字段」的展示单元（v2.4.0）。
 * 额外字段 = 字段元数据里不在固定列中的那些（含自定义字段与 id_card 等）。
 */
/* ============================================================
   v3.5.21 字段级复制（站主：「后台要可以快捷复制，和前台的查询一样」）
   ------------------------------------------------------------
   两种按钮：
     · cpBtnHtml(field) —— 编辑弹窗里跟在输入框后面的「复制」，
       点击时按 data-cp 找同弹窗内 [data-xf=field] 的当前值；
     · cpv(val,label)   —— 详情弹窗里跟在某个值后面的「复制」，
       值直接写进 data-cpv（不需要再回头查 DOM）。
   复制走 navigator.clipboard，失败退回 textarea + execCommand。
   ============================================================ */
function cpBtnHtml(field){
  return '<button type="button" class="btn btn-ghost cp-mini" data-cp="' + attr(field) + '"'
    + ' title="复制这一项的值">复制</button>';
}

function cpv(val, label){
  var s = (val == null ? '' : String(val)).trim();
  if(!s) return '';
  return ' <button type="button" class="btn btn-ghost cp-mini" data-cpv="' + attr(s) + '"'
    + ' data-cpl="' + attr(label || '') + '">复制</button>';
}

function adminCopy(text, label){
  var t = (text == null ? '' : String(text));
  if(!t.trim()){ toast('这一项还是空的，没有可复制的内容', 'warn'); return; }
  var done = function(){ toast((label ? label + ' ' : '') + '已复制', 'ok', 2400); };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(t).then(done, function(){ djFallbackCopy(t); done(); });
  }else{ djFallbackCopy(t); done(); }
}

/* 事件委托：两处按钮都在动态生成的弹窗里，逐个绑定容易漏；
   挂一次 document 上的监听，后续任何弹窗都能用。 */
document.addEventListener('click', function(e){
  var t = e.target;
  if(!t || !t.closest) return;
  var b1 = t.closest('[data-cpv]');
  if(b1){
    adminCopy(b1.getAttribute('data-cpv'), b1.getAttribute('data-cpl') || '内容');
    return;
  }
  var b2 = t.closest('[data-cp]');
  if(b2){
    var f = b2.getAttribute('data-cp');
    var box = b2.closest('#modalBox') || document;
    var inp = box.querySelector('[data-xf="' + f + '"]');
    var wrap = b2.closest('.field, .extra-row');
    var lab = wrap ? wrap.querySelector('label') : null;
    adminCopy(inp ? inp.value : '', lab ? lab.textContent.trim() : '内容');
  }
});

/* 头衔白名单兜底（与 api/admin.js 的 ALLOWED_TITLES 保持一致）。
   正常情况下用接口返回的 STATE.titles.allowed，这里只在没加载到时顶上。 */
var TITLE_FALLBACK = ['班长', '副班长', '团支书', '学习委员', '纪律委员',
  '生活委员', '体育委员', '文艺委员', '电教委',
  '语文课代表', '数学课代表', '英语课代表', '物理课代表',
  '化学课代表', '生物课代表', '政治课代表', '历史课代表',
  '地理课代表', '课代表'];

function extraColsOf(){
  var meta = STATE.members.fieldMeta || STATE.profiles.fieldMeta || [];
  /* v3.5.16：id_card / youth_league_no 也有**固定列**的采集逻辑（顶层 o.idCard），
     以前这里又当自定义字段收一遍，导致同一列被传两次，服务端拼出
     `id_card = $n, id_card = $m` 直接报错。这里一律排除。 */
  var FIXED = ['name','student_id','politics','exam_no','role','title','wechat','qq','phone',
               'id_card','youth_league_no','contact_status','reject_reason'];
  return meta.filter(function(f){ return FIXED.indexOf(f.field) < 0; });
}

/** 单条资料的查看记录（谁在什么时候看过这个人） */
function profileViewsDialog(id){
  openModal({
    title: '资料查看记录',
    sub: '谁在什么时候查到了这条资料',
    wide: true,
    body: '<div id="pvBody"><div class="loading"><div class="spinner"></div>加载中…</div></div>',
    foot: '<button class="btn btn-ghost" data-no>关闭</button>',
    onMount: function(box){
      box.querySelector('[data-no]').onclick = closeModal;
      api('/admin?action=profile&id=' + id).then(function(j){
        var p = j.profile || {}, vs = j.views || [];
        var el = box.querySelector('#pvBody');
        var head = '<div class="alert info" style="margin-bottom:16px">'
          + '<b>' + esc(p.name || '(未填姓名)') + '</b>'
          + ' <span class="mono muted">' + esc(p.studentId || '无学号') + '</span>'
          + '　联系方式：'
          + (p.wechat ? '微信 ' + esc(p.wechat) + '　' : '')
          + (p.qq ? 'QQ ' + esc(p.qq) + '　' : '')
          + (p.phone ? '手机 ' + esc(p.phone) : '')
          + (p.wechat || p.qq || p.phone ? '' : '<span class="muted">暂未填写</span>')
          + '</div>';

        if(!vs.length){
          el.innerHTML = head + '<div class="empty">' + svg('eye', 34) + '<p>还没有人查看过这条资料</p></div>';
          return;
        }
        el.innerHTML = head
          + '<div class="table-wrap"><table><thead><tr>'
          + '<th>查看者</th><th class="nowrap">搜索关键词</th><th class="nowrap">IP</th><th class="nowrap">时间</th>'
          + '</tr></thead><tbody>'
          + vs.map(function(v){
              return '<tr>'
                + '<td><b>' + esc(v.viewer) + '</b></td>'
                + '<td class="mono">' + esc(v.keyword || '—') + '</td>'
                + '<td class="mono muted">' + esc(v.ip || '—') + '</td>'
                + '<td class="nowrap">' + esc(fmt(v.createdAt)) + '<div class="muted" style="font-size:.72rem">' + esc(ago(v.createdAt)) + '</div></td>'
                + '</tr>';
            }).join('')
          + '</tbody></table></div>'
          + '<p class="hint" style="margin-top:10px">仅显示最近 20 条。</p>';
      }).catch(function(e){
        box.querySelector('#pvBody').innerHTML = '<div class="alert danger">加载失败：' + esc(e.message) + '</div>';
      });
    }
  });
}

/**
 * Excel 批量导入资料。
 * 表头：姓名 / 学号 / 政治面貌 / 智学网账号 / 微信 / QQ / 手机号
 * 按学号优先匹配（没有学号则按姓名），命中就更新、没命中就新增。
 * 后端单批上限 60 条，所以这里分片串行提交。
 */
function profileImportDialog(){
  var parsed = [];          /* 解析出的待导入数据 */
  var headerNote = '';

  openModal({
    title: 'Excel 批量导入资料',
    sub: '表头需包含：姓名 / 学号 / 政治面貌 / 智学网账号 / 微信 / QQ / 手机号（自定义字段按中文名自动识别）',
    wide: true,
    body:
      '<div class="alert info" style="margin-bottom:16px">'
      +   '按 <b>学号</b> 匹配已有资料（没有学号则按姓名），命中就更新、没命中就新增。'
      +   '导入的数据会连带把联系方式记为「已通过」。单次请控制在 900 条以内。<br>'
      +   '「字段管理」里加过的自定义字段，只要表头写上<b>它的中文名</b>（如「学籍号」）就会被一起导入。'
      + '</div>'

      /* 第一步：先给模板，再选文件 */
      + '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">'
      +   '<button class="btn btn-sm btn-secondary" id="pfTpl">' + svg('download', 14) + '下载模板</button>'
      +   '<label class="btn btn-sm" style="cursor:pointer">' + svg('upload', 14) + '选择 Excel 文件'
      +     '<input type="file" id="pfFile" accept=".xlsx,.xls" style="display:none"></label>'
      + '</div>'

      /* 第二步：解析结果预览 */
      + '<div id="pfPreview"><p class="muted" style="font-size:.85rem;margin:0">'
      +   '建议先点「下载模板」，按模板表头填好再导回来。选好文件后这里会先预览，确认无误再导入。'
      + '</p></div>'
      + '<div class="msg" id="pfImpMsg"></div>',
    foot: '<button class="btn btn-ghost" data-no>取消</button>'
        + '<button class="btn" data-yes disabled>开始导入</button>',
    onMount: function(box){
      var file = box.querySelector('#pfFile');
      var msg  = box.querySelector('#pfImpMsg');
      var prev = box.querySelector('#pfPreview');
      var yes  = box.querySelector('[data-yes]');
      box.querySelector('[data-no]').onclick = closeModal;

      var setMsg = function(kind, text){
        msg.className = 'msg ' + kind + ' show';
        msg.textContent = text;
      };

      /* --- 下载模板：表头 + 一行示例 + 一行说明 --- */
      box.querySelector('#pfTpl').onclick = function(){
        loadXLSX().then(function(XLSX){
          if(!XLSX){ toast('模板库加载失败，请检查网络', 'err', 4200); return; }
          var ws = XLSX.utils.json_to_sheet([
            {
              姓名: '张三', 学号: '250501', 政治面貌: '群众', 智学网账号: '11389409',
              微信: '', QQ: '', 手机号: '',
            },
            {
              姓名: '李四（示例·老师无学号）', 学号: '', 政治面貌: '共青团员', 智学网账号: '',
              微信: 'lisi_wechat', QQ: '10001', 手机号: '13900000000',
            },
          ]);
          ws['!cols'] = [
            { wch: 22 }, { wch: 10 }, { wch: 12 }, { wch: 12 },
            { wch: 16 }, { wch: 10 }, { wch: 14 },
          ];
          var wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, '资料导入');
          XLSX.writeFile(wb, '班级资料导入模板.xlsx');
          toast('模板已下载，填好后导回来即可', 'ok', 3600);
        });
      };

      /* --- 选中文件 → 先解析并预览，不直接提交 --- */
      file.onchange = function(){
        var f = file.files[0];
        yes.disabled = true;
        parsed = [];
        if(!f){
          prev.innerHTML = '<p class="muted" style="font-size:.85rem;margin:0">未选择文件。</p>';
          msg.className = 'msg';
          return;
        }

        prev.innerHTML = '<div class="loading"><div class="spinner"></div>正在解析…</div>';
        msg.className = 'msg';

        var reader = new FileReader();
        reader.onload = function(ev){
          /* v3.5.3：先等解析库就位，再读文件内容。
             以前这里直接用裸全局 XLSX.read(...) —— 用户没点过「下载模板」时
             库从未开始加载，当场 ReferenceError，报「解析失败: XLSX is not defined」。
             现在统一走 loadXLSX()（本地 vendor/ 优先，CDN 兜底）。
             下面整段都包在 .then 里，逻辑一行没动，只是挪进了回调。 */
          loadXLSX().then(function(XLSX){
            if(!XLSX){
              prev.innerHTML = '<div class="alert danger">表格解析库加载失败，请检查网络后重试</div>';
              setMsg('err', '表格解析库加载失败，请检查网络后重试');
              return;
            }
            var rows;
            try{
              var wb = XLSX.read(new Uint8Array(ev.target.result), { type:'array' });
              var ws = wb.Sheets[wb.SheetNames[0]];
              rows = XLSX.utils.sheet_to_json(ws, { defval:'' });
            }catch(err){
              prev.innerHTML = '<div class="alert danger">解析失败：' + esc(err.message) + '</div>';
              setMsg('err', '解析失败：' + err.message);
              return;
            }
          if(!rows.length){
            prev.innerHTML = '<div class="alert danger">文件里没有读到数据行。</div>';
            setMsg('err', '文件里没有读到数据行');
            return;
          }

          /* 表头别名兼容：有人写「学号」，有人写「学籍号」 */
          var pick = function(o, keys){
            for(var i = 0; i < keys.length; i++){
              var k = Object.keys(o).find(function(x){ return String(x).trim() === keys[i]; });
              if(k && String(o[k]).trim() !== '') return String(o[k]).trim();
            }
            return '';
          };

          /* 动态字段（2026-10-09 v2.4.0）：按「字段管理」里的中文名匹配表头。
             例如站主加了「学籍号」字段，Excel 里就有「学籍号」这一列。
             同时兼容用英文键名当表头（导出文件用的是中文名，但手写表头也可能直接写键名）。 */
          var extras = extraColsOf();

          var bad = 0;
          var list = rows.map(function(r){
            var o = {
              name:      pick(r, ['姓名','名字','学生姓名']),
              studentId: pick(r, ['学号','学籍号']),
              politics:  pick(r, ['政治面貌','面貌']),
              examNo:    pick(r, ['智学网账号','智学网号','智学网准考证号','准考证号']),
              wechat:    pick(r, ['微信','微信号']),
              qq:        pick(r, ['QQ','QQ号']),
              phone:     pick(r, ['手机号','手机','电话','手机号码']),
              /* v3.5.3：站长的模板里一直有「身份证号 / 发展团员编号」两列，
                 而这两列本来就是 profiles 的内置列（单条编辑一直支持），
                 批量导入却始终不认 —— 数据被静默丢弃。这次补上。 */
              idCard:        pick(r, ['身份证号','身份证','证件号']),
              youthLeagueNo: pick(r, ['发展团员编号','团员编号','入团编号'])
            };
            /* 自定义字段：中文名优先，其次英文字段名 */
            var ex = {};
            extras.forEach(function(f){
              var v = pick(r, [f.label, f.field]);
              if(v) ex[f.field] = v;
            });
            if(Object.keys(ex).length) o.extra = ex;
            return o;
          }).filter(function(x){
            /* 姓名和学号都空的算无效行，单独计数提示 */
            if(!x.name && !x.studentId){ bad++; return false; }
            return true;
          });

          if(!list.length){
            prev.innerHTML = '<div class="alert danger">没有一行同时含「姓名」或「学号」，请检查表头是否为：'
              + '姓名 / 学号 / 政治面貌 / 智学网账号 / 微信 / QQ / 手机号</div>';
            setMsg('err', '没有一行含「姓名」或「学号」，请检查表头');
            return;
          }

          parsed = list;
          yes.disabled = false;
          var hasExam  = list.filter(function(x){ return x.examNo; }).length;
          var hasPhone = list.filter(function(x){ return x.wechat || x.qq || x.phone; }).length;
          var hasId    = list.filter(function(x){ return x.idCard; }).length;
          var hasYln   = list.filter(function(x){ return x.youthLeagueNo; }).length;
          /* 本次真正读到的自定义字段（只列非空的，避免一堆空列） */
          var hitExtras = extras.filter(function(f){
            return list.some(function(x){ return (x.extra || {})[f.field]; });
          });

          /* 预览前 8 行，让管理员能一眼看出列有没有对错 */
          var head = ['姓名','学号','政治面貌','智学网账号']
            .concat(hitExtras.map(function(f){ return f.label; }))
            .concat(['微信','QQ','手机号','身份证号','发展团员编号']);
          var bodyRows = list.slice(0, 8).map(function(x){
            var cells = [x.name, x.studentId, x.politics, x.examNo]
              .concat(hitExtras.map(function(f){ return (x.extra || {})[f.field] || ''; }))
              .concat([x.wechat, x.qq, x.phone, x.idCard, x.youthLeagueNo]);
            return '<tr>' + cells.map(function(c, i){
              var dash = c ? esc(c) : '<span class="muted">—</span>';
              /* 学号/智学网账号/自定义字段用等宽字体，便于肉眼核对数字有没有错位 */
              var mono = (i === 1 || i === 3 || (hitExtras.length && i > 3 && i < 4 + hitExtras.length));
              return '<td' + (mono ? ' class="mono nowrap"' : '') + '>' + dash + '</td>';
            }).join('') + '</tr>';
          }).join('');

          prev.innerHTML =
            '<div class="alert ok" style="margin-bottom:12px">'
            +   '读到 <b>' + list.length + '</b> 条有效数据'
            +   (bad ? '，跳过 ' + bad + ' 条空行' : '')
            +   '；其中含智学网账号 <b>' + hasExam + '</b> 条、含联系方式 <b>' + hasPhone + '</b> 条。'
            +   (hasId  ? '含身份证号 <b>' + hasId + '</b> 条。' : '')
            +   (hasYln ? '含发展团员编号 <b>' + hasYln + '</b> 条。' : '')
            +   (hitExtras.length ? '识别到自定义字段：<b>' + hitExtras.map(function(f){ return esc(f.label); }).join('、') + '</b>。' : '')
            + '</div>'
            + '<p class="muted" style="font-size:.8rem;margin:0 0 8px">'
            +   '预览前 ' + Math.min(8, list.length) + ' 行（确认列没串位再导入）：</p>'
            + '<div class="table-wrap" style="max-height:280px;overflow:auto"><table><thead><tr>'
            +   head.map(function(h){ return '<th class="nowrap">' + h + '</th>'; }).join('')
            + '</tr></thead><tbody>' + bodyRows + '</tbody></table></div>'
            + (list.length > 8
                ? '<p class="hint" style="margin-top:8px">仅预览前 8 行，导入时会处理全部 ' + list.length + ' 条。</p>'
                : '');

          setMsg('info', '已选择：' + f.name + '（' + bytes(f.size) + '），确认预览无误后点「开始导入」。');
          });
        };
        reader.onerror = function(){
          prev.innerHTML = '<div class="alert danger">读取文件失败。</div>';
          setMsg('err', '读取文件失败');
        };
        reader.readAsArrayBuffer(f);
      };

      /* --- 确认导入：分片串行提交，避免一次性压垮 Worker --- */
      yes.onclick = function(){
        if(!parsed.length) return;
        var list = parsed;
        var btn = yes;
        btn.disabled = true;

        /* v3.5.18：一批 60 条会撞 Cloudflare 的 50 子请求上限
           （Too many subrequests by single Worker invocation），
           改成 8 条一批串行提交 —— 慢一点但稳，62 人也就 8 轮。 */
        var CHUNK = 8;
        var chunks = [];
        for(var i = 0; i < list.length; i += CHUNK) chunks.push(list.slice(i, i + CHUNK));

        var created = 0, updated = 0, unchanged = 0, failed = 0, firstErr = '';
        /* v3.5.15：逐行错误收集起来 —— 站主对着行号改 Excel 才高效，
           以前只提示「首个错误」，后面的错误完全看不到。 */
        var allErrs = [];
        /* v3.5.18：字段级冲突（库里已有值 ≠ 导入值），等站主定夺 */
        var allConf = [];
        var idx = 0;

        var step = function(){
          if(idx >= chunks.length) return finish();
          var n = idx + 1;
          setMsg('info', '正在导入… 第 ' + n + '/' + chunks.length + ' 批（已处理 ' + (idx * CHUNK) + ' / ' + list.length + ' 条）');
          return api('/admin?action=batch-profiles', { method:'POST', body: { rows: chunks[idx] } })
            .then(function(j){
              created += j.created || 0;
              updated += j.updated || 0;
              unchanged += j.unchanged || 0;
              failed  += j.failed  || 0;
              if(j.errors && j.errors.length){
                j.errors.forEach(function(e){
                  var n = idx * CHUNK + (Number(e.index) || 0) + 1;
                  allErrs.push({ n: n, name: e.name || '', reason: e.reason || '' });
                  if(!firstErr) firstErr = '数据第 ' + n + ' 行：' + (e.reason || '');
                });
              }
              if(j.conflicts && j.conflicts.length){
                j.conflicts.forEach(function(c){
                  allConf.push({
                    row: idx * CHUNK + (Number(c.index) || 0) + 1,
                    id: c.id, name: c.name, field: c.field, label: c.label,
                    oldValue: c.oldValue, newValue: c.newValue,
                  });
                });
              }
              idx++;
              return step();
            });
        };

        var finish = function(){
          var parts = ['新增 ' + created + ' 条', '更新 ' + updated + ' 条'];
          if(unchanged) parts.push('跳过 ' + unchanged + ' 条（与现有完全一致）');
          if(failed) parts.push('失败 ' + failed + ' 条');
          if(allConf.length) parts.push('待定夺 ' + allConf.length + ' 个字段');
          setMsg((failed || allConf.length) ? 'warn' : 'ok',
            '导入完成：' + parts.join('，') + (firstErr ? ('\n首个错误 ' + firstErr) : ''));

          var html = '';

          /* ① 失败行：数据行 / 姓名 / 原因 */
          if(failed && allErrs.length){
            html += '<div class="alert warn" style="margin-bottom:10px">'
              +   '下面 <b>' + allErrs.length + '</b> 行没有导入（其余已入库，不会因为这几行失败而白导）。'
              +   '按原因改完 Excel 再导一次即可，已导入的会走「更新」，不会重复。'
              + '</div>'
              + '<div class="table-wrap" style="max-height:300px;overflow:auto"><table><thead><tr>'
              +   '<th class="nowrap">数据行</th><th class="nowrap">姓名</th><th>原因</th>'
              + '</tr></thead><tbody>'
              + allErrs.slice(0, 50).map(function(e){
                  return '<tr><td class="mono nowrap">' + e.n + '</td><td class="nowrap">'
                    + (e.name ? esc(e.name) : '<span class="muted">—</span>')
                    + '</td><td>' + esc(e.reason) + '</td></tr>';
                }).join('')
              + '</tbody></table></div>'
              + (allErrs.length > 50 ? '<p class="hint" style="margin-top:8px">只列前 50 条，共 ' + allErrs.length + ' 条。</p>' : '');
          }

          /* ② 字段冲突：库里已有值 ≠ 导入值，先不写，交站主逐条定夺 */
          if(allConf.length){
            html += '<div class="alert warn" style="margin:14px 0 10px">'
              +   '有 <b>' + allConf.length + '</b> 个字段与库里的值不一样，<b>这些字段暂时没有写入</b>。'
              +   '勾「用导入值」的会被覆盖；没勾的保留现有（等于把导入的那一份丢掉）。'
              + '</div>'
              + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">'
              +   '<button type="button" class="btn btn-xs btn-secondary" data-cf-all>全选用导入</button>'
              +   '<button type="button" class="btn btn-xs btn-secondary" data-cf-none>全不选</button>'
              +   '<button type="button" class="btn btn-xs" data-cf-apply>应用选择</button>'
              + '</div>'
              + '<div class="table-wrap" style="max-height:300px;overflow:auto"><table><thead><tr>'
              +   '<th class="nowrap">数据行</th><th class="nowrap">姓名</th><th class="nowrap">字段</th>'
              +   '<th>现有值</th><th>导入值</th><th class="nowrap">用导入</th>'
              + '</tr></thead><tbody>'
              + allConf.map(function(c, ci){
                  var o = String(c.oldValue == null ? '' : c.oldValue);
                  var nv = String(c.newValue == null ? '' : c.newValue);
                  function cut(s){ return esc(s.length > 36 ? s.slice(0, 36) + '…' : s); }
                  return '<tr><td class="mono nowrap">' + c.row + '</td>'
                    + '<td class="nowrap">' + (c.name ? esc(c.name) : '<span class="muted">—</span>') + '</td>'
                    + '<td class="nowrap">' + esc(c.label) + '</td>'
                    + '<td title="' + attr(o) + '"><span class="mono" style="font-size:.76rem">' + cut(o) + '</span></td>'
                    + '<td title="' + attr(nv) + '"><span class="mono" style="font-size:.76rem">' + cut(nv) + '</span></td>'
                    + '<td class="nowrap"><input type="checkbox" data-cf="' + ci + '"></td></tr>';
                }).join('')
              + '</tbody></table></div>';
          }

          prev.innerHTML = html;

          /* 冲突表交互 */
          if(allConf.length){
            var bAll = prev.querySelector('[data-cf-all]');
            var bNone = prev.querySelector('[data-cf-none]');
            var bApply = prev.querySelector('[data-cf-apply]');
            if(bAll) bAll.onclick = function(){
              Array.prototype.forEach.call(prev.querySelectorAll('[data-cf]'), function(el){ el.checked = true; });
            };
            if(bNone) bNone.onclick = function(){
              Array.prototype.forEach.call(prev.querySelectorAll('[data-cf]'), function(el){ el.checked = false; });
            };
            if(bApply) bApply.onclick = function(){
              var picks = [];
              Array.prototype.forEach.call(prev.querySelectorAll('[data-cf]:checked'), function(el){
                var c = allConf[Number(el.getAttribute('data-cf'))];
                if(c && c.id && c.field) picks.push({ id: c.id, field: c.field, value: c.newValue == null ? '' : c.newValue });
              });
              if(!picks.length){ toast('没有勾选「用导入值」的字段', 'err'); return; }
              bApply.disabled = true;
              bApply.textContent = '应用中…';
              var CH2 = 20, ci2 = 0, done = 0;
              var nextPart = function(){
                if(ci2 >= picks.length){
                  bApply.textContent = '已应用 ' + done + ' 个字段';
                  bAll.disabled = bNone.disabled = true;
                  toast('已按所选覆盖 ' + done + ' 个字段', 'ok');
                  loadMembers();
                  return;
                }
                var part = picks.slice(ci2, ci2 + CH2);
                return api('/admin?action=resolve-field-conflicts', { method:'POST', body:{ items: part } })
                  .then(function(r){ done += (r.applied || 0); ci2 += CH2; return nextPart(); })
                  .catch(function(e){
                    bApply.disabled = false;
                    bApply.textContent = '应用选择';
                    toast('应用失败：' + e.message, 'err');
                  });
              };
              nextPart();
            };
          }

          /* 结果出来后「取消」变「确定」—— 让站主明确「这次导入到此为止」，
             点它只是关窗，已入库的不会撤销。 */
          var noBtn = box.querySelector('[data-no]');
          if(noBtn) noBtn.textContent = '确定';

          toast('导入完成：新增 ' + created + '，更新 ' + updated
            + (unchanged ? '，跳过 ' + unchanged : ''), 'ok', 4200);
          loadMembers();
          btn.textContent = '再导一次';
          btn.disabled = false;
        };

        step().catch(function(e){
          setMsg('err',
            '导入中断：' + e.message
            + '\n（已成功的批次已入库，可以修完数据再导一次，重复的会走更新）');
          btn.disabled = false;
          loadMembers();
        });
      };
    }
  });
}

/* ============================================================================
 * ⑬ 面板：信息审核（v3.7.0 由「联系方式审核」升级而来）
 * ----------------------------------------------------------------------------
 * 站主原话：「所有允许学生自主修改的字段同之前微信QQ手机号的联系方式审核相同，
 *            需要后台确认方可成功更改，在后台确认之前均按照原来显示，而且后台的
 *            信息审核只包含修改人姓名和修改内容（原内容和现内容）其他没有改的地方
 *            无需显示，名称从联系方式审核改为信息审核，而且可以看到历史审核记录
 *            并后台可以撤销之前的确认（7 天之内）」
 *
 * 三件事：
 *   ① 待审核：每张卡片只有「谁」+「改了哪几项（原内容 → 现内容）」
 *   ② 历史记录：通过 / 驳回 / 已撤销，7 天内可以点「撤销」
 *   ③ 兼容旧数据：3.7.0 之前提交的联系方式还在老机制里（profiles.contact_status='pending'），
 *      一并列出来，走老的 review-contact 接口；新提交不会再产生这类记录
 * ========================================================================= */
var REV_TAB = 'pending';

function renderReviews(){
  $('view').innerHTML =
    '<div class="toolbar" style="background:var(--panel)">'
    +   '<div style="flex:1;min-width:0">'
    +     '<b style="font-size:.92rem">信息审核</b>'
    +     '<p class="muted" style="margin:4px 0 0;font-size:.8rem">'
    +       '同学自己改的资料先到这里；<b>通过之前前台仍显示原内容</b>，通过后立即生效</p>'
    +   '</div>'
    +   '<button class="btn btn-sm btn-secondary" id="rvRefresh">' + svg('refresh', 14) + ' 刷新</button>'
    + '</div>'
    + '<div id="rvTabs" style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap"></div>'
    + '<section class="panel"><div id="rvBody"><div class="loading"><div class="spinner"></div>加载中…</div></div></section>';

  $('rvRefresh').onclick = function(){ loadReviews(); };
  paintRevTabs();
  loadReviews();
}

function paintRevTabs(){
  var box = $('rvTabs');
  if(!box) return;
  var S = STATE.reviews;
  var c = S.counts || {};
  var tab = function(id, label, n){
    var on = REV_TAB === id;
    return '<button class="btn btn-sm' + (on ? '' : ' btn-secondary') + '" data-rvt="' + id + '">'
      + label + (n != null ? ' <b style="margin-left:2px">' + n + '</b>' : '') + '</button>';
  };
  box.innerHTML = tab('pending', '待审核', (c.pending || 0) + (c._legacy || 0))
    + tab('history', '历史记录', null);
  Array.prototype.forEach.call(box.querySelectorAll('[data-rvt]'), function(b){
    b.onclick = function(){
      REV_TAB = b.dataset.rvt;
      paintRevTabs();
      loadReviews();
    };
  });
}

function loadReviews(){
  var body = $('rvBody');
  if(body) body.innerHTML = '<div class="loading"><div class="spinner"></div>加载中…</div>';
  var S = STATE.reviews;

  if(REV_TAB === 'history'){
    api('/admin?action=change-requests&scope=history').then(function(j){
      S.history = j.requests || [];
      S.counts = j.counts || {};
      paintRevTabs();
      paintReviewHistory();
    }).catch(function(e){
      if(body) body.innerHTML = '<div class="alert danger" style="margin:18px">加载失败：' + esc(e.message) + '</div>';
    });
    return;
  }

  /* 待审核：新机制 + 旧机制并行拉（旧的一般是空的） */
  Promise.all([
    api('/admin?action=change-requests&scope=pending').catch(function(){ return { requests: [], counts: {} }; }),
    api('/admin?action=profile-requests').catch(function(){ return { requests: [] }; }),
  ]).then(function(arr){
    var nw = arr[0] || {};
    var legacy = (arr[1] && arr[1].requests) || [];
    S.list = (nw.requests || []).map(function(r){ r.legacy = false; return r; }).concat(
      legacy.map(function(r){
        return {
          id: r.id, legacy: true, profileId: r.id, name: r.name, studentId: r.studentId,
          username: r.boundUsername, createdAt: r.updatedAt, status: 'pending',
          items: [
            r.wechat ? { label: '微信', before: '', after: r.wechat } : null,
            r.qq ? { label: 'QQ', before: '', after: r.qq } : null,
            r.phone ? { label: '手机号', before: '', after: r.phone } : null,
          ].filter(Boolean),
        };
      })
    );
    S.counts = nw.counts || {};
    S.counts._legacy = legacy.length;
    S.total = S.list.length;
    paintRevTabs();
    paintReviews();
  }).catch(function(e){
    if(body) body.innerHTML = '<div class="alert danger" style="margin:18px">加载失败：' + esc(e.message) + '</div>';
  });
}

/** 一行「原内容 → 现内容」；没改的字段根本不会出现在 items 里 */
function revFieldRow(it){
  var before = it.before === '' || it.before == null ? '<span class="muted">（空）</span>' : esc(it.before);
  var after  = it.after  === '' || it.after  == null ? '<span class="muted">（清空）</span>' : '<b>' + esc(it.after) + '</b>';
  return '<div><div class="k">' + esc(it.label) + '</div>'
    + '<div class="v" style="font-family:inherit">' + before
    + ' <span class="muted" style="margin:0 4px">→</span> ' + after + '</div></div>';
}

function revWho(r){
  return '<b>' + esc(r.name || '(未填姓名)')
    + (r.studentId ? ' <span class="sid">' + esc(r.studentId) + '</span>' : '')
    + '</b><p class="meta">'
    + (r.username ? ('账号：' + esc(r.username) + '　·　') : '')
    + '提交于 ' + esc(fmt(r.createdAt) || '—')
    + '</p>';
}

function paintReviews(){
  var S = STATE.reviews;
  var body = $('rvBody');
  if(!body) return;

  if(!S.list.length){
    body.innerHTML = '<div class="empty">' + svg('check', 38)
      + '<p>没有待审核的修改</p>'
      + '<p style="font-size:.78rem;margin-top:8px">同学在「我的资料」里改资料、或在查询卡片里提交联系方式后，会出现在这里</p></div>';
    return;
  }

  body.innerHTML =
    '<div class="alert info" style="margin:16px 16px 0">'
    +   '共 <b>' + S.list.length + '</b> 条待审核。只列出<b>实际改动过</b>的字段：左边是原内容，右边是同学提交的新内容。'
    +   '点「通过」才写进档案；驳回时写的理由，本人能在「我的资料」里看到。'
    + '</div>'
    + '<div class="rev-list">'
    + S.list.map(function(r){
        return '<div class="rev">'
          + '<div class="who">' + revWho(r)
          +   (r.legacy ? ' <span class="badge badge-gray">旧版提交</span>' : '')
          + '</div>'
          + '<div class="act">'
          +   '<button class="btn btn-sm btn-secondary" data-rv-no="' + r.id + '" data-legacy="' + (r.legacy ? '1' : '0') + '">驳回…</button>'
          +   '<button class="btn btn-sm" data-rv-ok="' + r.id + '" data-legacy="' + (r.legacy ? '1' : '0') + '">'
          +     svg('check', 14) + ' 通过</button>'
          + '</div>'
          + '<div class="fields">'
          +   (r.items.length ? r.items.map(revFieldRow).join('')
                : '<div class="muted" style="font-size:.8rem">没有可显示的字段</div>')
          + '</div>'
          + '</div>';
      }).join('')
    + '</div>';

  Array.prototype.forEach.call(body.querySelectorAll('[data-rv-ok]'), function(b){
    b.onclick = function(){
      b.disabled = true;
      revDecide(Number(b.dataset.rvOk), true, '', b.dataset.legacy === '1');
    };
  });
  Array.prototype.forEach.call(body.querySelectorAll('[data-rv-no]'), function(b){
    b.onclick = function(){
      var r = S.list.find(function(x){ return x.id === Number(b.dataset.rvNo) && (!!x.legacy === (b.dataset.legacy === '1')); });
      var who = r ? (r.name || r.studentId || ('#' + r.id)) : ('#' + b.dataset.rvNo);
      promptBox({
        title: '驳回修改',
        sub: '驳回了 ' + who,
        label: '驳回原因（本人可见）',
        value: '内容有误，请核对后重新提交',
        maxlength: 200,
        placeholder: '如：号码有误 / 与本人不符',
        hint: '留空也可以，默认记为「管理员驳回」。档案内容不会改变。',
        okText: '确认驳回'
      }).then(function(reason){
        if(reason === null) return;
        revDecide(Number(b.dataset.rvNo), false, reason, b.dataset.legacy === '1');
      });
    };
  });
}

/** 通过 / 驳回：legacy 走老接口，新机制走 change-requests */
function revDecide(id, approve, reason, legacy){
  if(legacy){
    api('/admin?action=review-contact', { method:'POST', body:{ id: id, approve: approve, reason: reason || '' } })
      .then(function(j){ toast(j.message || '已处理', approve ? 'ok' : ''); loadReviews(); })
      .catch(function(e){ toast(e.message, 'danger'); loadReviews(); });
    return;
  }
  var url = approve ? '/admin?action=approve-change' : '/admin?action=reject-change';
  api(url, { method:'POST', body:{ id: id, reason: reason || '' } })
    .then(function(j){ toast(j.message || '已处理', approve ? 'ok' : ''); loadReviews(); })
    .catch(function(e){ toast(e.message, 'danger'); loadReviews(); });
}

function paintReviewHistory(){
  var S = STATE.reviews;
  var body = $('rvBody');
  if(!body) return;
  var list = S.history || [];
  if(!list.length){
    body.innerHTML = '<div class="empty">' + svg('clock', 38)
      + '<p>还没有审核历史</p>'
      + '<p style="font-size:.78rem;margin-top:8px">通过或驳回之后，记录会留在这里，7 天内可以撤销</p></div>';
    return;
  }
  var statBadge = function(r){
    if(r.status === 'approved') return '<span class="badge badge-green">已通过</span>';
    if(r.status === 'rejected') return '<span class="badge badge-red">已驳回</span>';
    if(r.status === 'reverted') return '<span class="badge badge-gray">已撤销</span>';
    return '<span class="badge">' + esc(r.status) + '</span>';
  };
  body.innerHTML = '<div class="table-wrap"><table><thead><tr>'
    + '<th class="nowrap">处理时间</th><th>修改人</th><th>修改内容</th>'
    + '<th class="nowrap">状态</th><th class="nowrap"></th>'
    + '</tr></thead><tbody>'
    + list.map(function(r){
        var changes = (r.items || []).map(function(it){
          return '<div style="font-size:.78rem;margin-bottom:2px">'
            + '<span class="muted">' + esc(it.label) + '：</span>'
            + (it.before ? esc(it.before) : '<span class="muted">（空）</span>')
            + ' <span class="muted">→</span> ' + (it.after ? esc(it.after) : '<span class="muted">（清空）</span>')
            + '</div>';
        }).join('') || '<span class="muted">—</span>';
        var act = '';
        if(r.status === 'approved'){
          act = r.canRevert
            ? '<button class="btn btn-xs btn-secondary" data-rv-undo="' + r.id + '">撤销<span class="muted" style="font-size:.68rem;margin-left:3px">剩 ' + r.revertDaysLeft + ' 天</span></button>'
            : '<span class="muted" style="font-size:.72rem">已超 7 天</span>';
        }
        return '<tr>'
          + '<td class="nowrap muted mono" style="font-size:.76rem">'
          +   esc(fmt(r.decidedAt || r.createdAt)) + '</td>'
          + '<td class="nowrap"><b>' + esc(r.name || '—') + '</b>'
          +   (r.studentId ? '<div class="muted mono" style="font-size:.72rem">' + esc(r.studentId) + '</div>' : '') + '</td>'
          + '<td>' + changes + (r.note ? '<div class="muted" style="font-size:.72rem">理由：' + esc(r.note) + '</div>' : '') + '</td>'
          + '<td class="nowrap">' + statBadge(r) + '</td>'
          + '<td class="nowrap" style="text-align:right">' + act + '</td>'
          + '</tr>';
      }).join('')
    + '</tbody></table></div>'
    + '<p class="muted" style="padding:12px 14px 0;font-size:.76rem">'
    +   '撤销会把内容改回修改之前的样子（7 天以内）；超过 7 天只能手动去档案里改。</p>';

  Array.prototype.forEach.call(body.querySelectorAll('[data-rv-undo]'), function(b){
    b.onclick = function(){
      var id = Number(b.dataset.rvUndo);
      var r = (S.history || []).find(function(x){ return x.id === id; });
      var who = r ? (r.name || ('#' + id)) : ('#' + id);
      confirmBox({
        title: '撤销这次审核',
        html: '把 <b>' + esc(who) + '</b> 的资料改回修改之前的内容？',
        detail: '会立即生效。撤销后这条记录会标记为「已撤销」，不会删除历史。',
        okText: '撤销',
      }).then(function(yes){
        if(!yes) return;
        b.disabled = true;
        api('/admin?action=revert-change', { method:'POST', body:{ id: id } })
          .then(function(j){ toast(j.message || '已撤销', 'ok'); loadReviews(); })
          .catch(function(e){ b.disabled = false; toast(e.message, 'danger'); });
      });
    };
  });
}

/* ============================================================================
 * ⑭ 面板：资料查看记录
 * ---------------------------------------------------------------------------
 * 隐私透明化：谁在什么时候搜到了谁，都留痕。
 * 后端 /admin?action=view-logs 支持 ?viewer= / ?target= 过滤，这里只做全量分页。
 * ========================================================================= */
function renderViewLogs(){
  var S = STATE.viewlogs;
  $('view').innerHTML =
    '<div class="toolbar" style="background:var(--panel)">'
    +   '<div class="search">' + svg('search')
    +     '<input id="vlSearch" placeholder="按查看者或资料姓名筛选…" value="' + attr(S.q) + '" maxlength="30">'
    +   '</div>'
    +   '<span style="flex:1"></span>'
    +   '<button class="btn btn-sm btn-secondary" id="vlRefresh">' + svg('refresh', 14) + '刷新</button>'
    + '</div>'
    + '<div class="grid-2" style="margin-bottom:18px">'
    +   '<section class="panel">'
    +     '<div class="panel-head"><div><h3>' + svg('chart') + '近 7 天查询排行</h3>'
    +       '<p class="sub">谁最常查同学的联系方式</p></div></div>'
    +     '<div id="vlTop"><div class="loading"><div class="spinner"></div>加载中…</div></div>'
    +   '</section>'
    +   '<section class="panel">'
    +     '<div class="panel-head"><div><h3>' + svg('eye') + '为什么记这个</h3>'
    +       '<p class="sub">给同学一个交代</p></div></div>'
    +     '<div class="panel-body">'
    +       '<p style="margin:0;font-size:.83rem;line-height:1.85;color:var(--fg-2)">'
    +         '通讯录里是同学们的私人联系方式，所以每次查询都会记录：'
    +         '<b>谁</b>、在<b>什么时候</b>、用什么<b>关键词</b>、查到了<b>谁</b>。'
    +         '这份记录只有管理员能看，用来在出现纠纷或信息被滥用时追溯。'
    +       '</p>'
    +       '<p style="margin:14px 0 0;font-size:.83rem;line-height:1.85;color:var(--fg-2)">'
    +         '如果某位同学的资料被反复查看，可以打开「成员与档案」里那一行的'
    +         '<b>查看记录</b>按钮，单独看这条资料被谁查过。'
    +       '</p>'
    +     '</div>'
    +   '</section>'
    + '</div>'
    + '<section class="panel"><div id="vlBody"><div class="loading"><div class="spinner"></div>加载中…</div></div></section>';

  $('vlSearch').oninput = debounce(function(e){
    S.q = e.target.value.trim();
    paintViewLogs();
  }, 320);
  $('vlRefresh').onclick = function(){ loadViewLogs(1); };
  loadViewLogs(1);
}

function loadViewLogs(page){
  var S = STATE.viewlogs;
  S.page = page || 1;
  api('/admin?action=view-logs&limit=' + S.size + '&offset=' + ((S.page - 1) * S.size)).then(function(j){
    S.list  = j.logs || [];
    S.total = j.total || 0;
    S.top   = j.top  || [];
    paintViewLogs();
  }).catch(function(e){
    var b = $('vlBody');
    if(b) b.innerHTML = '<div class="alert danger" style="margin:18px">加载失败：' + esc(e.message) + '</div>';
  });
}

function paintViewLogs(){
  var S = STATE.viewlogs;

  /* --- 排行 --- */
  var topEl = $('vlTop');
  if(topEl){
    if(!S.top.length){
      topEl.innerHTML = '<div class="empty">' + svg('chart', 32) + '<p>近 7 天还没有查询记录</p></div>';
    }else{
      var max = S.top[0].count || 1;
      topEl.innerHTML = '<div class="rank">' + S.top.map(function(t, i){
        var w = Math.max(4, Math.round((t.count / max) * 100));
        return '<div class="rank-row">'
          /* 第一名是渐变底（.rank-row:nth-child(1) .n），字色走全站共用 ink-auto */
          + '<div class="n' + (i === 0 ? ' ink-auto' : '') + '">' + (i + 1) + '</div>'
          + '<div class="nm">' + esc(t.username) + '</div>'
          + '<div class="bar"><i style="width:' + w + '%"></i></div>'
          + '<div class="c">' + t.count + ' 次</div>'
          + '</div>';
      }).join('') + '</div>';
    }
  }

  /* --- 日志表 --- */
  var body = $('vlBody');
  if(!body) return;

  if(!S.list.length){
    body.innerHTML = '<div class="empty">' + svg('eye', 38)
      + '<p>' + (S.q ? '没有匹配的记录' : '还没有任何查询记录') + '</p>'
      + (S.q ? '' : '<p style="font-size:.78rem;margin-top:8px">同学在「资料查询」页搜过一次就会记一条</p>')
      + '</div>';
    return;
  }

  /* 关键词在前端过滤（后端 view-logs 只按 id 过滤，没有关键词参数） */
  var q = (S.q || '').toLowerCase();
  var list = q ? S.list.filter(function(l){
    return String(l.viewer || '').toLowerCase().indexOf(q) >= 0
        || String(l.targetName || '').toLowerCase().indexOf(q) >= 0;
  }) : S.list;

  if(!list.length){
    body.innerHTML = '<div class="empty">' + svg('search', 38) + '<p>当前页没有匹配「' + esc(S.q) + '」的记录</p></div>';
    return;
  }

  var shownTo = Math.min(S.page * S.size, S.total);

  body.innerHTML =
    '<div class="table-wrap"><table><thead><tr>'
    + '<th>查看者</th><th>查到了谁</th><th class="nowrap">搜索关键词</th>'
    + '<th class="nowrap">IP</th><th class="nowrap">时间</th>'
    + '</tr></thead><tbody>'
    + list.map(function(l){
        var ini = String(l.viewer || '?').charAt(0).toUpperCase();
        return '<tr>'
          + '<td><div class="cell-user"><div class="av ink-auto">' + esc(ini) + '</div>'
          +   '<div><b>' + esc(l.viewer) + '</b>'
          +   '<i class="mono">#' + (l.viewerId || '—') + '</i></div></div></td>'
          + '<td><b>' + esc(l.targetName) + '</b>'
          +   (l.targetStudentId ? '<div class="mono muted" style="font-size:.73rem">' + esc(l.targetStudentId) + '</div>' : '')
          + '</td>'
          + '<td class="mono">' + (l.keyword ? esc(l.keyword) : '<span class="muted">—</span>') + '</td>'
          + '<td class="mono muted nowrap">' + esc(l.ip || '—') + '</td>'
          + '<td class="nowrap">' + esc(fmt(l.createdAt))
          +   '<div class="muted" style="font-size:.72rem">' + esc(ago(l.createdAt)) + '</div></td>'
          + '</tr>';
      }).join('')
    + '</tbody></table></div>'
    + '<div class="pager">'
    +   '<span class="info">共 ' + S.total + ' 条记录，当前第 ' + ((S.page - 1) * S.size + 1) + '–' + shownTo + ' 条'
    +     (q ? '（本页筛选出 ' + list.length + ' 条）' : '') + '</span>'
    +   '<span class="pages">'
    +     '<button data-vlp="prev"' + (S.page <= 1 ? ' disabled' : '') + '>上一页</button>'
    +     '<button class="on">' + S.page + '</button>'
    +     '<button data-vlp="next"' + (shownTo >= S.total ? ' disabled' : '') + '>下一页</button>'
    +   '</span>'
    + '</div>';

  Array.prototype.forEach.call(body.querySelectorAll('[data-vlp]'), function(b){
    b.onclick = function(){
      if(b.disabled) return;
      loadViewLogs(S.page + (b.dataset.vlp === 'next' ? 1 : -1));
    };
  });
}

/* ============================================================================
 * ⑭⁺ 面板：游戏数据（2026-10-07 新增）
 * ------------------------------------------------------------------------
 * 站主要求：后台能看到每个同学的
 *   ① 各游戏最高分（cls_game_<键>）
 *   ② 每个游戏的游玩时长（cls_game_play_<游戏>：局数 / 总时长 / 最近一局 / 最近时间）
 *   ③ 点歌券获取时间（cls_game_coupon_ledger）
 * 数据来自 /api/data 的个人同步表 user_data，由 /api/admin?action=games 聚合。
 * ========================================================================= */
function fmtDur(ms){
  ms = Number(ms) || 0;
  var s = Math.round(ms / 1000);
  if(s < 60) return s + ' 秒';
  var m = Math.floor(s / 60), ss = s % 60;
  if(m < 60) return m + ' 分' + (ss ? ' ' + ss + ' 秒' : '');
  var h = Math.floor(m / 60), mm = m % 60;
  return h + ' 小时' + (mm ? ' ' + mm + ' 分' : '');
}

/* ============================================================================
 * v3.9.25（站主）：时钟记录
 * ----------------------------------------------------------------------------
 * 站主：「我在后台也可以看到具体是谁干嘛」。
 * 数据是 clock.html 自己写进 user_data 的（cls_clock_log_<日期>），
 * 接口 GET /api/admin?action=clock-logs 只读汇总，不写库。
 * ========================================================================== */
function clockToday(){
  var d = new Date(), p = function(n){ return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function clockDur(sec){
  sec = Math.round(Number(sec) || 0);
  if(sec <= 0) return '—';
  if(sec < 60) return sec + ' 秒';
  var m = Math.round(sec / 60);
  if(m < 60) return m + ' 分钟';
  return Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分';
}
function clockHM(ms){
  var d = new Date(Number(ms));
  if(isNaN(d.getTime())) return '—';
  var p = function(n){ return (n < 10 ? '0' : '') + n; };
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

function renderClockLog(){
  var S = STATE.clocklog;
  if(!S.day) S.day = clockToday();
  $('view').innerHTML =
    '<div class="toolbar" style="background:var(--panel)">'
    +   '<div class="search">' + svg('search')
    +     '<input id="clSearch" placeholder="搜索姓名或账号…" value="' + attr(S.q) + '" maxlength="40">'
    +   '</div>'
    +   '<input type="date" id="clDay" class="inp inp-sm" style="width:152px;flex:0 0 auto" value="' + attr(S.day) + '">'
    +   '<button class="btn btn-sm btn-secondary" id="clToday">今天</button>'
    +   '<button class="btn btn-sm btn-secondary" id="clRefresh">' + svg('refresh', 14) + '刷新</button>'
    + '</div>'
    + '<div class="alert info" style="margin-bottom:16px">'
    +   '同学在「全屏时钟」页里每切换一次模式就记一段：数字时钟 / 翻页时钟 / 秒表 / 倒计时，'
    +   '自习则分成<b>专注</b>与<b>休息</b>两段。'
    +   '<br><b>只有登录的人才会出现在这里</b> —— 未登录的记录只存在他自己的设备上。'
    + '</div>'
    + '<section class="panel"><div id="clBody">'
    +   '<div class="loading"><div class="spinner"></div>加载中…</div>'
    + '</div></section>';

  $('clSearch').oninput = debounce(function(e){
    STATE.clocklog.q = e.target.value.trim();
    loadClockLog();
  }, 400);
  $('clDay').onchange = function(){
    STATE.clocklog.day = this.value || clockToday();
    STATE.clocklog.open = {};
    loadClockLog();
  };
  $('clToday').onclick = function(){
    STATE.clocklog.day = clockToday();
    $('clDay').value = STATE.clocklog.day;
    STATE.clocklog.open = {};
    loadClockLog();
  };
  $('clRefresh').onclick = function(){ loadClockLog(); };

  loadClockLog();
}

function loadClockLog(){
  var S = STATE.clocklog;
  if(!S.day) S.day = clockToday();
  api('/admin?action=clock-logs&day=' + encodeURIComponent(S.day)
    + '&q=' + encodeURIComponent(S.q || '')).then(function(j){
    S.users = j.users || [];
    S.summary = j.summary || null;
    S.day = j.day || S.day;
    paintClockLog();
  }).catch(function(e){
    var b = $('clBody');
    if(b) b.innerHTML = '<div class="empty">' + svg('alert', 34)
      + '<p>加载失败：' + esc(e.message) + '</p></div>';
  });
}

function paintClockLog(){
  var S = STATE.clocklog;
  var body = $('clBody');
  if(!body) return;

  var sm = S.summary || {};
  var head = '<div class="stat-row" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">'
    + '<div class="mini-card"><span class="mc-label">使用人数</span><b>' + (sm.users || 0) + '</b></div>'
    + '<div class="mini-card"><span class="mc-label">合计自习</span><b>' + clockDur(sm.focus) + '</b></div>'
    + '<div class="mini-card"><span class="mc-label">合计休息</span><b>' + clockDur(sm.rest) + '</b></div>'
    + '<div class="mini-card"><span class="mc-label">番茄总数</span><b>' + (sm.tomato || 0) + '</b></div>'
    + '<div class="mini-card"><span class="mc-label">其它工具</span><b>' + clockDur(sm.other) + '</b></div>'
    + '</div>';

  if(!S.users.length){
    body.innerHTML = head + '<div class="empty">' + svg('clock', 38)
      + '<p>' + esc(S.day) + ' 还没有人用过全屏时钟</p>'
      + '<p class="muted" style="font-size:.82rem">换一天看看，或者等同学登录后去用一会儿</p></div>';
    return;
  }

  var rows = S.users.map(function(u, i){
    var open = !!S.open[u.userId];
    var modes = (u.byMode || []).map(function(m){ return m.name + ' ' + clockDur(m.secs); }).join(' · ');
    var segs = (u.segs || []).map(function(g){
      return '<span class="cl-seg"><b>' + clockHM(g.start) + '–' + clockHM(g.end) + '</b>'
        + ' ' + esc(g.name) + ' <i>' + clockDur(g.secs) + '</i></span>';
    }).join('');
    return '<tr>'
      + '<td><b>' + esc(u.displayName || u.username || '(未填)') + '</b>'
        + '<div class="muted" style="font-size:.74rem">' + esc(u.username || '') + '</div></td>'
      + '<td style="text-align:right">' + (u.focus ? '<b>' + clockDur(u.focus) + '</b>' : '<span class="muted">—</span>') + '</td>'
      + '<td style="text-align:right">' + (u.rest ? clockDur(u.rest) : '<span class="muted">—</span>') + '</td>'
      + '<td style="text-align:right">' + (u.tomato ? '<b>' + u.tomato + '</b> 个' : '<span class="muted">—</span>') + '</td>'
      + '<td style="text-align:right">' + (u.other ? clockDur(u.other) : '<span class="muted">—</span>') + '</td>'
      + '<td class="muted" style="font-size:.78rem;white-space:nowrap">'
        + (u.firstAt ? clockHM(u.firstAt) + ' – ' + clockHM(u.lastAt) : '—') + '</td>'
      + '<td><button class="btn btn-sm btn-secondary" data-cl-open="' + u.userId + '">'
        + (open ? '收起' : '明细') + '</button></td>'
      + '</tr>'
      + '<tr class="cl-detail" data-cl-row="' + u.userId + '"'
        + (open ? '' : ' style="display:none"') + '><td colspan="7">'
        + (modes ? '<div class="muted" style="font-size:.78rem;margin-bottom:8px">' + esc(modes) + '</div>' : '')
        + '<div class="cl-segs">' + (segs || '<span class="muted">没有明细</span>') + '</div>'
      + '</td></tr>';
  }).join('');

  body.innerHTML = head
    + '<div class="table-wrap"><table><thead><tr>'
    + '<th>成员</th><th style="text-align:right">自习</th><th style="text-align:right">休息</th>'
    + '<th style="text-align:right">番茄</th><th style="text-align:right">其它工具</th>'
    + '<th>时段</th><th></th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table></div>';

  Array.prototype.forEach.call(body.querySelectorAll('[data-cl-open]'), function(b){
    b.onclick = function(){
      var id = b.getAttribute('data-cl-open');
      S.open[id] = !S.open[id];
      paintClockLog();
    };
  });
}

function renderGames(){
  var S = STATE.games;
  $('view').innerHTML =
    '<div class="toolbar" style="background:var(--panel)">'
    +   '<div class="search">' + svg('search')
    +     '<input id="gmSearch" placeholder="搜索姓名或账号…" value="' + attr(S.q) + '" maxlength="40">'
    +   '</div>'
    +   '<span class="seg" id="gmTab">'
    +     '<button data-gm-tab="play"' + (S.tab === 'play' ? ' class="on"' : '') + '>游玩数据</button>'
    +     '<button data-gm-tab="coupon"' + (S.tab === 'coupon' ? ' class="on"' : '') + '>点歌券</button>'
    +   '</span>'
    +   '<button class="btn btn-sm btn-secondary" id="gmRefresh">' + svg('refresh', 14) + '刷新</button>'
    + '</div>'
    + '<div class="alert info" style="margin-bottom:16px">'
    +   '数据由游戏页自动上报（需登录后才会上传）：<b>最高分</b>破纪录时上报、'
    +   '<b>游玩时长</b>每局结束时累加、<b>点歌券</b>领取时写入台账（本周已有记录就不会再发券）。<br>'
    +   '<b>注意</b>：只有登录状态下玩的游戏才会上云；未登录的只存在本机。'
    + '</div>'
    + '<section class="panel"><div id="gmBody"><div class="loading"><div class="spinner"></div>加载中…</div></div></section>';

  $('gmSearch').oninput = debounce(function(e){
    S.q = e.target.value.trim(); paintGames();
  }, 300);
  $('gmRefresh').onclick = function(){ loadGames(); };
  Array.prototype.forEach.call($('gmTab').querySelectorAll('[data-gm-tab]'), function(b){
    b.onclick = function(){ S.tab = b.dataset.gmTab; renderGames(); };
  });

  loadGames();
}

function loadGames(){
  var S = STATE.games;
  api('/admin?action=games').then(function(j){
    S.list = j.users || [];
    S.meta = j.games || [];
    S.summary = j.summary || null;
    paintGames();
  }).catch(function(e){
    var b = $('gmBody');
    if(b) b.innerHTML = '<div class="empty">' + svg('alert', 34) + '<p>加载失败：' + esc(e.message) + '</p></div>';
  });
}

function paintGames(){
  var S = STATE.games;
  var body = $('gmBody');
  if(!body) return;   /* 防迟到响应抢页面 */

  var kw = (S.q || '').toLowerCase();
  var list = S.list.filter(function(u){
    if(!kw) return true;
    return String(u.name || '').toLowerCase().indexOf(kw) >= 0
        || String(u.username || '').toLowerCase().indexOf(kw) >= 0;
  });

  if(!S.list.length){
    body.innerHTML = '<div class="empty">' + svg('activity', 38)
      + '<p>还没有任何游戏数据上云</p>'
      + '<p class="muted" style="font-size:.82rem">成员登录并进行游戏后，此处将显示记录</p></div>';
    return;
  }

  var sm = S.summary || {};
  var head = '<div class="stat-row" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">'
    + '<div class="mini-card"><span class="mc-label">上报人数</span><b>' + (sm.players || 0) + '</b></div>'
    + '<div class="mini-card"><span class="mc-label">累计游玩</span><b>' + (sm.totalPlays || 0) + ' 局</b></div>'
    + '<div class="mini-card"><span class="mc-label">点歌券发放</span><b>' + (sm.coupons || 0) + ' 张</b></div>'
    + '</div>';

  if(S.tab === 'coupon'){ body.innerHTML = head + paintCoupons(list); return; }
  body.innerHTML = head + paintPlay(list);
}

/* ---- 游玩数据 ---- */
function paintPlay(list){
  var S = STATE.games;
  var cols = S.meta.map(function(g){
    return '<th style="text-align:right">' + g.icon + ' ' + esc(g.label) + '</th>';
  }).join('');

  var rows = list.map(function(u){
    var his = S.meta.map(function(g){
      var v = u.hi[g.hiKey];
      return '<td style="text-align:right">'
        + (v == null || v === '' ? '<span class="muted">—</span>' : '<b>' + esc(v) + '</b>')
        + '</td>';
    }).join('');
    var plays = S.meta.map(function(g){
      var p = u.play[g.id];
      if(!p) return '<span class="muted">—</span>';
      return g.label + ' ' + (p.count || 0) + ' 局 / ' + fmtDur(p.totalMs);
    }).filter(function(x){ return x.indexOf('muted') < 0; }).join('　·　');
    var last = '';
    S.meta.forEach(function(g){
      var p = u.play[g.id];
      if(p && p.lastAt && (!last || String(p.lastAt) > last)) last = String(p.lastAt);
    });
    return '<tr>'
      + '<td><b>' + esc(u.name || '(未填)') + '</b></td>'
      + '<td class="muted" style="font-size:.78rem">' + esc(u.username || '—') + '</td>'
      + his
      + '<td style="max-width:280px;font-size:.76rem" class="muted">' + (plays || '—') + '</td>'
      + '<td class="muted" style="font-size:.76rem">' + (last ? esc(fmt(last)) : '—') + '</td>'
      + '</tr>';
  }).join('');

  return '<div class="table-wrap"><table><thead><tr>'
    + '<th>姓名</th><th>账号</th>' + cols
    + '<th>各游戏局数 / 时长</th><th>最近游玩</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

/* ---- 点歌券 ---- */
function paintCoupons(list){
  var S = STATE.games;
  var all = [];
  list.forEach(function(u){
    (u.coupons || []).forEach(function(c){
      all.push({ name: u.name, username: u.username, c: c });
    });
  });
  all.sort(function(a, b){
    return String(b.c.time || '').localeCompare(String(a.c.time || ''));
  });

  if(!all.length){
    return '<div class="empty">' + svg('activity', 34)
      + '<p>还没有人领过点歌券</p>'
      + '<p class="muted" style="font-size:.82rem">券只有在游戏通关达标后发放，且必须先登录</p></div>';
  }

  var weeks = [];
  all.forEach(function(x){ if(weeks.indexOf(x.c.week) < 0) weeks.push(x.c.week); });
  weeks.sort().reverse();
  if(!S.week || weeks.indexOf(S.week) < 0) S.week = weeks[0];
  var shown = all.filter(function(x){ return x.c.week === S.week; });

  var sel = '<label class="ck" style="font-size:.82rem">周次：'
    + '<select id="gmWeek" style="margin-left:6px">'
    + weeks.map(function(w){
        return '<option value="' + attr(w) + '"' + (w === S.week ? ' selected' : '') + '>'
          + esc(w) + '（' + all.filter(function(x){ return x.c.week === w; }).length + ' 张）</option>';
      }).join('')
    + '</select></label>';

  var rows = shown.map(function(x){
    var c = x.c;
    return '<tr>'
      + '<td><b>' + esc(x.name || '(未填)') + '</b></td>'
      + '<td class="muted" style="font-size:.78rem">' + esc(x.username || '—') + '</td>'
      + '<td>' + esc(c.gameLabel || c.game) + '</td>'
      + '<td><code style="font-size:.8rem">' + (c.code ? esc(c.code) : '<span class="muted">（旧记录无券码）</span>') + '</code></td>'
      + '<td class="muted">' + esc(c.time || '—') + '</td>'
      + '<td class="muted" style="font-size:.76rem">' + esc(c.source || '—') + '</td>'
      + '</tr>';
  }).join('');

  var body = '<div style="margin-bottom:12px">' + sel + '</div>'
    + '<div class="table-wrap"><table><thead><tr>'
    + '<th>姓名</th><th>账号</th><th>游戏</th><th>券码</th><th>获取时间</th><th>来源</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table></div>';

  var sel2 = $('gmWeek');
  if(sel2) sel2.onchange = function(){ S.week = sel2.value; paintGames(); };
  return body;
}

/* ============================================================================
 * ⑮ 面板：登录记录
 * ========================================================================= */
function renderLogins(){
  var S = STATE.logins;
  $('view').innerHTML =
    '<div class="toolbar" style="background:var(--panel)">'
    +   '<span class="muted" style="font-size:.82rem">全部同学在这台站点的登录历史（时间 · IP · 设备）</span>'
    +   '<span style="flex:1"></span>'
    +   '<button class="btn btn-sm btn-secondary" id="lgRefresh">' + svg('refresh', 14) + '刷新</button>'
    + '</div>'
    + '<section class="panel"><div id="lgBody"><div class="loading"><div class="spinner"></div>加载中…</div></div></section>';

  $('lgRefresh').onclick = function(){ loadLogins(1); };
  loadLogins(1);
}

function loadLogins(page){
  var S = STATE.logins;
  S.page = page;
  api('/admin?action=login-logs&limit=' + S.size + '&offset=' + ((page - 1) * S.size)).then(function(j){
    S.list = j.logs || [];
    S.total = j.total || 0;

    var body = $('lgBody');
    if(!body) return;
    if(!S.list.length){
      body.innerHTML = '<div class="empty">' + svg('inbox', 38) + '<p>还没有任何登录记录</p>'
        + '<p style="font-size:.78rem;margin-top:8px">该功能需要先在 Neon 执行 api/schema.sql 建 login_log 表</p></div>';
      return;
    }

    var shownTo = Math.min(page * S.size, S.total);
    body.innerHTML =
      '<div class="table-wrap"><table><thead><tr>'
      + '<th>用户</th><th class="nowrap">时间</th><th class="nowrap">IP</th><th>设备</th>'
      + '</tr></thead><tbody>'
      + S.list.map(function(l){
          var initial = String(l.username || '?').charAt(0).toUpperCase();
          return '<tr>'
            + '<td><div class="cell-user"><div class="av ink-auto">' + esc(initial) + '</div>'
            + '<div><b>' + esc(l.username || '(已删除)') + '</b><i class="mono">#' + l.userId + '</i></div></div></td>'
            + '<td class="nowrap">' + esc(fmt(l.createdAt)) + '<div class="muted" style="font-size:.72rem">' + esc(ago(l.createdAt)) + '</div></td>'
            + '<td class="nowrap mono">' + esc(l.ip || '—') + '</td>'
            + '<td class="muted" style="font-size:.78rem;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + attr(l.userAgent || '') + '">'
            + esc(shortUA(l.userAgent)) + '</td>'
            + '</tr>';
        }).join('')
      + '</tbody></table></div>'
      + '<div class="pager">'
      +   '<span class="info">共 ' + S.total + ' 条记录，当前第 ' + ((page - 1) * S.size + 1) + '–' + shownTo + ' 条</span>'
      +   '<span class="pages">'
      +     '<button data-lgp="prev"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>'
      +     '<button class="on">' + page + '</button>'
      +     '<button data-lgp="next"' + (shownTo >= S.total ? ' disabled' : '') + '>下一页</button>'
      +   '</span>'
      + '</div>';

    Array.prototype.forEach.call(body.querySelectorAll('[data-lgp]'), function(b){
      b.onclick = function(){
        if(b.disabled) return;
        loadLogins(page + (b.dataset.lgp === 'next' ? 1 : -1));
      };
    });
  }).catch(function(e){
    var body = $('lgBody');
    if(body) body.innerHTML = '<div class="alert danger" style="margin:18px">加载失败：' + esc(e.message) + '</div>';
  });
}

/* ============================================================================
 * ⑯-2 面板：在线时长（v3.5.35）
 *
 * 站主原话：
 *   「检测单次在线时长以及历史累计的在线时长……第一次请求到最后一次请求之间
 *     的时间，就是它这次上线时间……如果两次请求时间它超过了 3 分钟，那就
 *     算两次请求……历史总的话就把它们加起来。这个在后台我需要能看到历史的数据。」
 *
 * 数据来源：online_sessions 表，由心跳接口（/api/auth?action=ping）每 60 秒
 * 一次的心跳逐段累加。判定规则写在 api/auth.js 的 ping() 里：
 *   · 距上一条 last_ping_at ≤ 180 秒 → 续上同一段（stop_at 前推）
 *   · 超过 180 秒 → 另起一段
 *
 * 本页两块：
 *   ① 按人聚合排行（累计时长 / 时段数 / 最长单次 / 最近在线），可切时间窗口
 *   ② 点某人展开他的时段明细（每段起止时刻 + 时长 + 心跳次数）
 * ========================================================================= */
function renderOnline(){
  var S = STATE.online;
  $('view').innerHTML =
    '<div class="toolbar" style="background:var(--panel)">'
    +   '<span class="muted" style="font-size:.82rem">心跳每 60 秒一次；两次心跳超过 3 分钟就另算一次在线</span>'
    +   '<span style="flex:1"></span>'
    +   '<span class="seg" id="onDays">'
    +     [1, 7, 30, 90].map(function(d){
          return '<button data-ond="' + d + '" class="' + (S.days === d ? 'on' : '') + '">'
            + (d === 1 ? '今天' : d + ' 天') + '</button>';
        }).join('')
    +   '</span>'
    +   '<button class="btn btn-sm btn-secondary" id="onRefresh">' + svg('refresh', 14) + '刷新</button>'
    + '</div>'
    + '<div id="onSummary" class="grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:14px"></div>'
    + '<section class="panel" id="onPages" style="display:none"></section>'
    + '<section class="panel"><div id="onBody"><div class="loading"><div class="spinner"></div>加载中…</div></div></section>';

  Array.prototype.forEach.call($('onDays').querySelectorAll('[data-ond]'), function(b){
    b.onclick = function(){
      S.days = Number(b.dataset.ond);
      S.detail = null; S.detailUser = null;
      renderOnline();
    };
  });
  $('onRefresh').onclick = function(){ S.detail = null; S.detailUser = null; renderOnline(); };
  loadOnline();
}

/* v3.5.40（站主 #3）：页面标识 → 人话。
   admin:votes → 后台 · 投票；game:breakout → 游戏 · 打砖块；其余原样。 */
function pageLabel(p){
  var raw = String(p || '');
  if(raw.indexOf('admin:') === 0){
    var pid = raw.slice(6);
    var hit = null;
    try{ hit = (PAGES || []).filter(function(x){ return x.id === pid; })[0]; }catch(e){}
    return '后台 · ' + (hit ? (hit.label || hit.title || pid) : pid);
  }
  if(raw.indexOf('game:') === 0){
    var gid = raw.slice(5);
    var gm = null;
    try{ gm = (GAME_META || []).filter(function(x){ return x.id === gid; })[0]; }catch(e){}
    return '游戏 · ' + (gm ? gm.label : gid);
  }
  if(!raw) return '未知';
  return raw;
}

/* 全站「哪个页面最耗时间」——横向条形，按秒数降序 */
function paintOnlinePages(){
  var S = STATE.online;
  var box = document.getElementById('onPages');
  if(!box) return;
  var list = (S.byPage || []).filter(function(x){ return x.secs > 0; });
  if(!list.length){ box.style.display = 'none'; return; }
  var max = list[0].secs || 1;
  var top = list.slice(0, 12);
  box.style.display = 'block';
  box.innerHTML =
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">'
    +   '<b style="font-size:.9rem">时间花在哪些页面</b>'
    +   '<span class="muted" style="font-size:.76rem">同一时间窗口，按页面累计停留时长排序</span>'
    + '</div>'
    + top.map(function(x){
        var pct = Math.max(2, Math.round(x.secs / max * 100));
        return '<div style="margin-bottom:7px">'
          + '<div style="display:flex;justify-content:space-between;gap:10px;font-size:.8rem;margin-bottom:3px">'
          +   '<span>' + esc(pageLabel(x.page)) + '</span>'
          +   '<span class="muted" style="white-space:nowrap">' + esc(secText(x.secs))
          +     ' · ' + x.users + ' 人</span>'
          + '</div>'
          + '<div style="height:6px;border-radius:99px;background:var(--bg-2,#f3ece6);overflow:hidden">'
          +   '<div style="height:100%;width:' + pct + '%;border-radius:99px;background:linear-gradient(90deg,var(--btn-a,#c2410c),var(--btn-b,#f59e0b))"></div>'
          + '</div></div>';
      }).join('');
}

/* 秒 → 中文时长（0 秒显示成「—」，避免一整列 0 秒看着像故障） */
function secText(sec){
  sec = Number(sec) || 0;
  if(sec <= 0) return '—';
  return fmtDur(sec * 1000);
}

function loadOnline(){
  var S = STATE.online;
  var body = $('onBody');
  api('/admin?action=online&days=' + S.days + '&limit=500').then(function(j){
    S.users = j.users || [];
    S.grandSecs = j.grandSecs || 0;
    S.grandSessions = j.grandSessions || 0;
    S.activeUsers = j.activeUsers || 0;
    S.totalUsers = j.totalUsers || 0;
    S.byPage = j.byPage || [];
    paintOnlinePages();

    var sum = $('onSummary');
    if(sum){
      var cards = [
        { k:'累计在线', v: secText(S.grandSecs), s: S.grandSessions + ' 个时段' },
        { k:'有记录的人', v: S.activeUsers + ' / ' + S.totalUsers, s:'窗口内有心跳的同学' },
        { k:'人均在线', v: secText(S.activeUsers ? Math.round(S.grandSecs / S.activeUsers) : 0), s:'按有记录的人算' }
      ];
      sum.innerHTML = cards.map(function(c){
        return '<div class="panel" style="padding:14px 16px;margin:0">'
          + '<div class="muted" style="font-size:.76rem">' + esc(c.k) + '</div>'
          + '<div style="font-size:1.35rem;font-weight:700;margin:4px 0 2px">' + esc(c.v) + '</div>'
          + '<div class="muted" style="font-size:.72rem">' + esc(c.s) + '</div></div>';
      }).join('');
    }

    if(!body) return;
    if(!S.users.length){
      body.innerHTML = '<div class="empty">' + svg('inbox', 38) + '<p>还没有任何在线记录</p>'
        + '<p style="font-size:.78rem;margin-top:8px">前端每 60 秒发一次心跳，首次心跳上报后此处将显示数据</p></div>';
      return;
    }

    body.innerHTML =
      '<div class="table-wrap"><table><thead><tr>'
      + '<th>用户</th><th class="nowrap">累计时长</th><th class="nowrap">在线次数</th>'
      + '<th class="nowrap">最长单次</th><th class="nowrap">最近在线</th><th></th>'
      + '</tr></thead><tbody>'
      + S.users.map(function(u){
          var initial = String(u.displayName || u.username || '?').charAt(0).toUpperCase();
          var open = S.detailUser === u.id;
          return '<tr' + (open ? ' style="background:rgba(255,255,255,.03)"' : '') + '>'
            + '<td><div class="cell-user"><div class="av ink-auto">' + esc(initial) + '</div>'
            + '<div><b>' + esc(u.displayName || u.username || '(未命名)') + '</b>'
            + '<i class="mono">' + esc(u.username || '') + ' #' + u.id + '</i></div></div></td>'
            + '<td class="nowrap"><b>' + esc(secText(u.totalSecs)) + '</b></td>'
            + '<td class="nowrap">' + u.sessionCount + ' 次</td>'
            + '<td class="nowrap">' + esc(secText(u.longestSecs)) + '</td>'
            + '<td class="nowrap muted" style="font-size:.78rem">'
            +   (u.lastAt ? esc(ago(u.lastAt)) + '<div style="font-size:.7rem">' + esc(fmt(u.lastAt)) + '</div>' : '—')
            + '</td>'
            + '<td class="nowrap"><button class="btn btn-sm btn-secondary" data-onu="' + u.id + '">'
            +   (open ? '收起' : '明细') + '</button></td>'
            + '</tr>'
            + (open ? '<tr><td colspan="6" style="padding:0;background:rgba(0,0,0,.16)">'
                    + '<div id="onDetail" style="padding:12px 14px">'
                    +   (S.detail === null
                        ? '<div class="loading"><div class="spinner"></div>加载明细…</div>'
                        : onDetailHtml(S))
                    + '</div></td></tr>' : '');
        }).join('')
      + '</tbody></table></div>';

    Array.prototype.forEach.call(body.querySelectorAll('[data-onu]'), function(b){
      b.onclick = function(){
        var id = Number(b.dataset.onu);
        if(S.detailUser === id){ S.detailUser = null; S.detail = null; loadOnline(); return; }
        S.detailUser = id;
        S.detail = null;
        loadOnline();
        loadOnlineDetail(id);
      };
    });
  }).catch(function(e){
    if(body) body.innerHTML = '<div class="alert danger" style="margin:18px">加载失败：' + esc(e.message) + '</div>';
  });
}

function loadOnlineDetail(id){
  var S = STATE.online;
  api('/admin?action=online&id=' + id + '&limit=200').then(function(j){
    if(S.detailUser !== id) return;   /* 用户已经切走了，别覆盖 */
    S.detail = j;
    var box = $('onDetail');
    if(!box) return;
    box.innerHTML = onDetailHtml(S);
  }).catch(function(e){
    var box = $('onDetail');
    if(box) box.innerHTML = '<div class="alert danger">明细加载失败：' + esc(e.message) + '</div>';
  });
}

function onDetailHtml(S){
  var d = S.detail;
  if(!d) return '<div class="loading"><div class="spinner"></div>加载中…</div>';
  var list = d.sessions || [];
  if(!list.length) return '<div class="muted" style="font-size:.82rem">这个人还没有在线时段记录</div>';
  /* v3.5.40（站主 #3）：这个人各页面分别待了多久 */
  var pageHtml = '';
  if((d.pages || []).length){
    var pmax = d.pages[0].secs || 1;
    pageHtml = '<div style="margin-bottom:12px;padding:10px 12px;border:1px solid var(--border);border-radius:10px">'
      + '<b style="font-size:.82rem">页面分布</b>'
      + '<div style="margin-top:7px">'
      + d.pages.map(function(x){
          var pct = Math.max(2, Math.round(x.secs / pmax * 100));
          return '<div style="margin-bottom:6px">'
            + '<div style="display:flex;justify-content:space-between;font-size:.78rem;gap:10px">'
            +   '<span>' + esc(pageLabel(x.page)) + '</span>'
            +   '<span class="muted">' + esc(secText(x.secs)) + ' · ' + x.count + ' 段</span>'
            + '</div>'
            + '<div style="height:5px;border-radius:99px;background:var(--bg-2,#f3ece6);overflow:hidden">'
            +   '<div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,var(--btn-a,#c2410c),var(--btn-b,#f59e0b))"></div>'
            + '</div></div>';
        }).join('')
      + '</div></div>';
  }
  return pageHtml
    + '<div class="muted" style="font-size:.78rem;margin-bottom:8px">'
      + '总计 <b>' + esc(secText(d.totalSecs)) + '</b>，共 ' + d.sessionCount + ' 个时段'
      + '（每段 = 一段连续在线，心跳中断超过 3 分钟就断开）'
      + (d.total > list.length ? '，下面仅显示最近 ' + list.length + ' 段' : '')
      + '</div>'
    + '<div class="table-wrap"><table style="font-size:.82rem"><thead><tr>'
      + '<th class="nowrap">开始</th><th class="nowrap">结束</th><th class="nowrap">时长</th>'
      + '<th class="nowrap">心跳次数</th><th>会话</th>'
      + '</tr></thead><tbody>'
      + list.map(function(s){
          return '<tr>'
            + '<td class="nowrap">' + esc(fmt(s.startAt)) + '</td>'
            + '<td class="nowrap">' + esc(fmt(s.stopAt)) + '</td>'
            + '<td class="nowrap"><b>' + esc(secText(s.secs)) + '</b></td>'
            + '<td class="nowrap">' + s.pingCount + '</td>'
            + '<td class="mono muted" style="font-size:.72rem">' + esc(s.device || '—') + '</td>'
            + '</tr>';
        }).join('')
      + '</tbody></table></div>';
}

/* ============================================================================
 * ⑰ 面板：操作日志
 * ========================================================================= */
function renderLogs(){
  $('view').innerHTML =
    '<div class="toolbar" style="background:var(--panel)">'
    +   '<span class="muted" style="font-size:.82rem">管理员对系统做过的所有改动</span>'
    +   '<span style="flex:1"></span>'
    +   '<button class="btn btn-sm btn-secondary" id="lg2Refresh">' + svg('refresh', 14) + '刷新</button>'
    + '</div>'
    + '<section class="panel"><div id="acBody"><div class="loading"><div class="spinner"></div>加载中…</div></div></section>';

  $('lg2Refresh').onclick = function(){ loadAudit(); };
  loadAudit();
}

/* 动作名 → 中文说明 */
var ACTION_LABEL = {
  'user.create':        '创建账号',
  'user.batch_create':  '批量导入账号',
  'user.reset_password':'重置密码',
  'user.set_status':    '修改账号状态',
  'user.set_role':      '修改角色',
  'user.delete':        '删除账号',
  'user.clear_sessions':'强制下线',
  'user.change_password':'用户自己改密码',
  'data.update':        '修改云端数据',
  'data.delete':        '删除云端数据',
  'data.undo_delete':   '撤回删除',
  'data.backup':        '数据备份',
  'data.backup_delete': '删除备份',
  'data.restore':       '从备份回档',
  'field.repair':       '字段体检恢复',
  'field.self_edit':    '字段本人可编辑'
};

function loadAudit(){
  api('/admin?action=audit&limit=120').then(function(j){
    var logs = j.logs || [];
    var body = $('acBody');
    if(!body) return;
    if(!logs.length){
      body.innerHTML = '<div class="empty">' + svg('file', 38) + '<p>还没有操作记录</p></div>';
      return;
    }
    body.innerHTML =
      '<div class="table-wrap"><table><thead><tr>'
      + '<th class="nowrap">时间</th><th>操作人</th><th>动作</th><th>对象</th><th>备注</th><th></th>'
      + '</tr></thead><tbody>'
      + logs.map(function(l){
          /* v3.6.4（站主 #3）：删除后 30 分钟内，这行右侧出现「撤回」。
             deletedId 写在 detail 里（格式 deletedId:123），没有就是普通日志。 */
          var mm = /deletedId:(\d+)/.exec(String(l.detail || ''));
          var undoBtn = '';
          if(mm && l.action === 'field.delete'){
            var mins = Math.floor((Date.now() - new Date(l.created_at).getTime()) / 60000);
            var left = 30 - mins;
            undoBtn = left > 0
              ? '<button class="btn btn-xs" data-undo="' + mm[1] + '" data-label="' + attr(l.target_id || '') + '">撤回<span class="muted" style="font-size:.68rem;margin-left:3px">剩 ' + left + ' 分</span></button>'
              : '<span class="muted" style="font-size:.72rem">已过期</span>';
          }
          return '<tr>'
            + '<td class="nowrap"><span class="mono" style="font-size:.76rem">' + esc(fmt(l.created_at)) + '</span></td>'
            + '<td class="nowrap">' + (l.actor ? '<b>' + esc(l.actor) + '</b>' : '<span class="muted">系统</span>') + '</td>'
            + '<td class="nowrap"><span class="badge badge-orange">' + esc(ACTION_LABEL[l.action] || l.action) + '</span></td>'
            + '<td class="nowrap muted mono" style="font-size:.76rem">' + esc(l.target_id || '—') + '</td>'
            + '<td class="muted" style="font-size:.78rem;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(l.detail || '—') + '</td>'
            + '<td class="nowrap">' + undoBtn + '</td>'
            + '</tr>';
        }).join('')
      + '</tbody></table></div>'
      + '<p class="muted" style="padding:12px 14px 0;font-size:.76rem">显示最近 ' + logs.length + ' 条记录</p>';

    /* v3.6.4：撤回按钮 */
    Array.prototype.forEach.call(body.querySelectorAll('[data-undo]'), function(btn){
      btn.onclick = function(){
        var id = btn.dataset.undo;
        btn.disabled = true;
        btn.textContent = '撤回中…';
        api('/admin?action=undo-delete', { method:'POST', body:{ id: Number(id) } })
          .then(function(r){
            toast(r.message || '已撤回', 'ok');
            loadAudit();
          })
          .catch(function(e){
            btn.disabled = false;
            btn.textContent = '撤回';
            toast(e.message || '撤回失败', 'danger');
          });
      };
    });
  }).catch(function(e){
    var body = $('acBody');
    if(body) body.innerHTML = '<div class="alert danger" style="margin:18px">加载失败：' + esc(e.message) + '</div>';
  });
}

/* ============================================================================
 * ⑱ 面板：行为日志（v2.10.0 用户操作日志）
 * ----------------------------------------------------------------------------
 * 与上面「操作日志」（管理员审计）分工：
 *   · 操作日志 = 管理员改了系统什么（audit_log）
 *   · 行为日志 = 每个用户点了什么（user_action_log，全点击上报）
 * 本面板 = 统计卡片 + 热门页面条形图 + 明细表（可按用户/类型/日期筛）。
 * 英文路由/键名在这里统一翻译成中文展示（站主要求 ⑨）。
 * ============================================================================ */

/* 动作类型 → 中文（后端存的是英文短码） */
var ACT_ACTION_CN = { click:'点击', jump:'页面跳转', switch:'切换标签', submit:'表单提交' };
/* 页面名翻译表：前端一般直接发中文名，这里是英文兜底（历史数据/直调） */
var ACT_PAGE_CN = {
  home:'首页', index:'首页', score:'成绩分析', scores:'成绩分析',
  compare:'成绩对比', homework:'作业查看', classworks:'作业查看',
  tools:'其他工具', affairs:'班级事务', study:'学习资料', screen:'大屏服务',
  account:'账号弹窗', profile:'我的资料', popup:'通知弹窗'
};
function actActionCn(a){ return ACT_ACTION_CN[a] || a || '—'; }
function actPageCn(p){
  if(!p) return '—';
  var k = String(p).toLowerCase();
  return ACT_PAGE_CN[k] || p;
}

function renderActionLogs(){
  var S = STATE.actionlogs;
  $('view').innerHTML =
    /* ---- 统计面板 ---- */
    '<div class="grid-2" id="alStats" style="margin-bottom:16px;grid-template-columns:minmax(0,5fr) minmax(0,7fr)">'
    +   '<section class="panel"><div class="panel-body" style="display:flex;flex-direction:column;justify-content:center;gap:14px">'
    +     '<div style="display:flex;align-items:baseline;gap:10px"><b style="font-size:1.9rem;min-width:110px" id="alToday">—</b><span class="muted" style="font-size:.8rem">今日点击</span></div>'
    +     '<div style="display:flex;align-items:baseline;gap:10px"><b style="font-size:1.9rem;min-width:110px" id="alWeek">—</b><span class="muted" style="font-size:.8rem">近 7 天点击</span></div>'
    +     '<div style="display:flex;align-items:baseline;gap:10px"><b style="font-size:1.9rem;min-width:110px" id="alUsers">—</b><span class="muted" style="font-size:.8rem">7 日活跃用户</span></div>'
    +   '</div></section>'
    +   '<section class="panel"><div class="panel-head"><div><h3>热门页面（近 7 天）</h3></div></div>'
    +     '<div class="panel-body" id="alTopPages"><div class="muted">加载中…</div></div></section>'
    + '</div>'

    /* ---- 筛选工具条 ---- */
    + '<div class="toolbar" style="background:var(--panel)">'
    +   '<div class="search">' + svg('search', 15) + '<input id="alSearch" placeholder="搜索用户名或姓名…" value="' + attr(S.q) + '"></div>'
    +   '<select id="alAction">'
    +     '<option value="">全部类型</option>'
    +     '<option value="click"' + (S.action === 'click' ? ' selected' : '') + '>点击</option>'
    +     '<option value="jump"' + (S.action === 'jump' ? ' selected' : '') + '>页面跳转</option>'
    +     '<option value="switch"' + (S.action === 'switch' ? ' selected' : '') + '>切换标签</option>'
    +     '<option value="submit"' + (S.action === 'submit' ? ' selected' : '') + '>表单提交</option>'
    +   '</select>'
    +   '<input id="alDay" type="date" value="' + attr(S.day) + '" title="按某一天筛选（北京时间）">'
    +   '<button class="btn btn-sm btn-secondary" id="alRefresh">' + svg('refresh', 14) + '刷新</button>'
    + '</div>'

    + '<section class="panel"><div id="alBody"><div class="loading"><div class="spinner"></div>加载中…</div></div></section>';

  $('alSearch').oninput = debounce(function(e){ S.q = e.target.value.trim(); S.page = 1; loadActionLogs(); }, 320);
  $('alAction').onchange = function(e){ S.action = e.target.value; S.page = 1; loadActionLogs(); };
  $('alDay').onchange = function(e){ S.day = e.target.value; S.page = 1; loadActionLogs(); };
  $('alRefresh').onclick = function(){ loadActionStats(); loadActionLogs(); };

  loadActionStats();
  loadActionLogs();
}

/** 统计卡片 + 热门页面条形图 */
function loadActionStats(){
  api('/admin?action=action-stats').then(function(j){
    var t = $('alToday'), w = $('alWeek'), u = $('alUsers');
    if(t) t.textContent = j.today || 0;
    if(w) w.textContent = j.week || 0;
    if(u) u.textContent = j.activeUsers7d || 0;
    var box = $('alTopPages');
    if(!box) return;
    var list = j.topPages || [];
    if(!list.length){ box.innerHTML = '<div class="muted">近 7 天还没有数据</div>'; return; }
    var max = list[0].n || 1;
    box.innerHTML = list.map(function(r){
      var pct = Math.max(4, Math.round(r.n / max * 100));
      return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">'
        + '<span style="flex:none;width:88px;font-size:.8rem;text-align:right">' + esc(actPageCn(r.page)) + '</span>'
        + '<span style="flex:1;background:var(--tint,rgba(120,53,15,.08));border-radius:6px;height:16px;overflow:hidden">'
        +   '<i style="display:block;height:100%;width:' + pct + '%;background:linear-gradient(90deg,var(--grad-a,#c2410c),var(--grad-b,#ea580c));border-radius:6px"></i>'
        + '</span>'
        + '<b style="flex:none;font-size:.8rem;min-width:36px">' + r.n + '</b>'
        + '</div>';
    }).join('');
  }).catch(function(){
    var box = $('alTopPages');
    if(box) box.innerHTML = '<div class="muted">统计读取失败（表可能刚建出，无数据）</div>';
  });
}

function loadActionLogs(){
  var S = STATE.actionlogs;
  api('/admin?action=action-logs&page=' + S.page + '&size=' + S.size
      + '&q=' + encodeURIComponent(S.q || '')
      + '&type=' + encodeURIComponent(S.action || '')
      + '&day=' + encodeURIComponent(S.day || '')).then(function(j){
    S.list = j.logs || [];
    S.total = j.total || 0;
    paintActionLogs();
  }).catch(function(e){
    var b = $('alBody');
    if(b) b.innerHTML = '<div class="alert danger" style="margin:18px">加载失败：' + esc(e.message) + '</div>';
  });
}

/**
 * v3.5.12 行为日志分组（站主 2026-10-17 要求）：
 *   「如果前后都是同一个人那么就合并显示，点击可展开。同一个人但是中途
 *    有其他人则分多次合并」
 *
 * 做法：后端已按 created_at desc 返回，这里顺序扫一遍，**相邻同 userId**
 * 归为一组；一旦中间夹了别人就断开、后面同一个人再开新组。
 * 组内顺序保持后端的倒序（最新在上）。
 */
function alGroup(list){
  var groups = [];
  var cur = null;
  (list || []).forEach(function(l){
    var uid = (l.userId != null ? l.userId : ('u:' + l.username));
    /* v3.5.13（站主反馈「不能一面只显示一条」）：同一人连续操作超过
       10 分钟就切断另起一组 —— 否则长时间挂机的人会把整页合并成一条。 */
    var gapOk = false;
    if(cur && cur.uid === uid && cur.items.length){
      var prevT = parseTime(cur.items[0].createdAt);
      var curT = parseTime(l.createdAt);
      if(prevT && curT){
        var gapMs = Math.abs(prevT.getTime() - curT.getTime());
        gapOk = gapMs <= 10 * 60 * 1000;
      }
    }
    if(cur && cur.uid === uid && gapOk){
      cur.items.push(l);
    } else {
      cur = { uid: uid, items: [l] };
      groups.push(cur);
    }
  });
  return groups;
}

/** 组内时间区间文本：同一分钟只写一个时间，跨分钟写「起 ~ 止」 */
function alRange(g){
  var a = g.items[g.items.length - 1];   /* 最早 */
  var b = g.items[0];                    /* 最新 */
  var ta = fmt(a.createdAt), tb = fmt(b.createdAt);
  if(g.items.length === 1) return ta;
  if(ta === tb) return ta;
  return ta + ' ~ ' + tb;
}

function paintActionLogs(){
  var S = STATE.actionlogs;
  var body = $('alBody');
  if(!body) return;
  if(!S.list.length){
    body.innerHTML = '<div class="empty">' + svg('activity', 38) + '<p>没有匹配的记录</p>'
      + '<p class="muted" style="font-size:.78rem">用户登录后的每一次点击都会记在这里（明细保留 90 天）</p></div>';
    return;
  }
  var page = S.page, size = S.size;
  var shownTo = Math.min(page * size, S.total);
  var groups = alGroup(S.list);

  /* 默认展开状态记在 STATE 里，翻页不丢 */
  S.open = S.open || {};

  var html = '';
  groups.forEach(function(g, gi){
    var head = g.items[0];
    var key = 'g' + page + '_' + gi;
    var n = g.items.length;
    var opened = !!S.open[key];

    /* ---- 组标题行（可点） ---- */
    html += '<div class="al-g' + (opened ? ' open' : '') + '" data-alg="' + key + '">'
      + '<div class="al-g-h">'
      +   '<span class="al-g-caret">' + svg('chevronRight', 14) + '</span>'
      +   '<span class="al-g-time">' + esc(alRange(g)) + '</span>'
      +   '<span class="al-g-user"><b>' + esc(head.displayName || head.username) + '</b>'
      +     '<span class="muted" style="font-size:.72rem"> @' + esc(head.username) + '</span></span>'
      +   '<span class="al-g-cnt">' + (n > 1
            ? ('<span class="badge badge-blue">' + n + ' 次操作</span>')
            : ('<span class="badge badge-gray">1 次操作</span>'))
      +   '</span>'
      +   '<span class="al-g-brief muted">' + esc(alBrief(g)) + '</span>'
      + '</div>';

    /* ---- 组明细（展开后可见） ---- */
    html += '<div class="al-g-body">';
    g.items.forEach(function(l){
      html += '<div class="al-row">'
        + '<span class="al-row-t muted nowrap">' + esc(fmt(l.createdAt)) + '</span>'
        + '<span class="nowrap"><span class="badge badge-blue">' + esc(actActionCn(l.action)) + '</span></span>'
        + '<span class="nowrap muted">' + esc(actPageCn(l.page)) + '</span>'
        + '<span class="al-row-tg" title="' + attr((l.target || '') + (l.detail ? ' — ' + l.detail : '')) + '">'
        +   esc(l.target || '—')
        +   (l.detail ? '<span class="muted" style="font-size:.72rem"> · ' + esc(l.detail) + '</span>' : '')
        + '</span>'
        + '</div>';
    });
    html += '</div></div>';
  });

  body.innerHTML =
    '<div class="al-wrap">' + html + '</div>'
    + '<div class="pager">'
    +   '<span class="info">共 ' + S.total + ' 条（' + groups.length + ' 组），当前显示第 '
    +     ((page - 1) * size + 1) + '–' + shownTo + ' 条</span>'
    +   '<span class="muted" style="font-size:.76rem">点整行可展开/收起 · 同一人连续操作已合并</span>'
    +   '<span class="pages">'
    +     '<button data-alp="prev"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>'
    +     '<button class="on">' + page + '</button>'
    +     '<button data-alp="next"' + (shownTo >= S.total ? ' disabled' : '') + '>下一页</button>'
    +   '</span>'
    + '</div>';

  Array.prototype.forEach.call(body.querySelectorAll('[data-alg]'), function(el){
    el.querySelector('.al-g-h').onclick = function(){
      var k = el.dataset.alg;
      S.open[k] = !S.open[k];
      el.classList.toggle('open', S.open[k]);
    };
  });
  Array.prototype.forEach.call(body.querySelectorAll('[data-alp]'), function(b){
    b.onclick = function(){
      if(b.disabled) return;
      S.page = page + (b.dataset.alp === 'next' ? 1 : -1);
      loadActionLogs();
    };
  });
}

/** 组摘要：动作 + 页面 去重后的前两项，例如「点击 · 首页、成绩分析」 */
function alBrief(g){
  var acts = [], pages = [];
  g.items.forEach(function(l){
    var a = actActionCn(l.action), p = actPageCn(l.page);
    if(acts.indexOf(a) < 0) acts.push(a);
    if(p && pages.indexOf(p) < 0) pages.push(p);
  });
  var t = acts.slice(0, 2).join(' / ');
  if(pages.length) t += ' · ' + pages.slice(0, 2).join('、') + (pages.length > 2 ? ' 等' : '');
  return t;
}

/* ============================================================================
 * ⑰ 面板：系统令牌（仅管理员可见）
 * ---------------------------------------------------------------------------
 * Cloudflare / Gitee / VoiceHub 等第三方令牌统一存这里。
 * 后端挂在系统账号下，读写接口只让 role=admin 通过。
 * ========================================================================= */
function renderSecrets(){
  $('view').innerHTML =
    '<div class="toolbar" style="background:var(--panel)">'
    +   '<span class="muted" style="font-size:.82rem">仅管理员可查看。这把密钥同时用于加密<b>令牌库</b>和<b>成员档案</b>（v3.5.0 起：姓名、学号、身份证、微信等全部密文存储），不开则两边都是明文。</span>'
    +   '<span style="flex:1"></span>'
    +   '<button class="btn btn-sm" id="scAdd">' + svg('plus', 14) + '新增令牌</button>'
    +   '<button class="btn btn-sm btn-secondary" id="scRefresh">' + svg('refresh', 14) + '刷新</button>'
    + '</div>'
    + '<div class="alert warn" id="scWarn" style="display:none;margin-bottom:14px"></div>'
    + '<section class="panel"><div id="scBody"><div class="loading"><div class="spinner"></div>加载中…</div></div></section>';

  $('scAdd').onclick = function(){ secretDialog(null); };
  $('scRefresh').onclick = loadSecrets;
  loadSecrets();
}

function loadSecrets(){
  api('/admin?action=secrets').then(function(j){
    STATE.secrets = j.secrets || [];
    STATE.secretsEncrypted = !!j.encrypted;
    STATE.secretsHasKey = !!j.hasKey;
    paintSecrets();
    var warn = $('scWarn');
    if(warn){
      if(j.warning){
        warn.style.display = 'block';
        warn.textContent = j.warning;
      }else if(!j.hasKey){
        warn.style.display = 'block';
        warn.textContent = '当前未配置 ADMIN_SECRETS_KEY：令牌与成员档案（姓名/学号/身份证/微信等）都在数据库里明文存储。如需加密，到 Cloudflare Workers 设置环境变量 ADMIN_SECRETS_KEY（值用 openssl rand -base64 32 生成）。配置后新保存的资料立刻变密文，存量资料在管理员下次保存时自动转换。';
      }else{
        warn.style.display = 'none';
      }
    }
  }).catch(function(e){
    var b = $('scBody');
    if(b) b.innerHTML = '<div class="alert danger" style="margin:18px">加载失败：' + esc(e.message) + '</div>';
  });
}

function paintSecrets(){
  var body = $('scBody');
  if(!body) return;
  var list = STATE.secrets || [];
  if(!list.length){
    body.innerHTML = '<div class="empty">' + svg('key', 38)
      + '<p>还没有保存任何令牌</p>'
      + '<p style="font-size:.78rem;margin-top:8px">点右上角「新增令牌」把 Cloudflare / Gitee 等凭据存进来</p></div>';
    return;
  }

  var rows = list.map(function(s){
    var v = s.value || '';
    var masked = v.length > 12 ? (v.slice(0, 6) + '…' + v.slice(-6)) : v;
    return '<tr data-name="' + attr(s.name) + '">'
      + '<td class="mono nowrap" style="font-weight:600">' + esc(s.name) + '</td>'
      + '<td style="font-family:monospace;font-size:.78rem;max-width:320px;overflow:hidden;text-overflow:ellipsis" title="' + attr(v) + '">'
      +   '<span class="sc-val">' + esc(masked) + '</span>'
      + '</td>'
      + '<td class="nowrap" style="text-align:right"><div class="row-actions">'
      +   '<button data-sc="show">显示</button>'
      +   '<button data-sc="edit">编辑</button>'
      +   '<button class="danger" data-sc="del">删除</button>'
      + '</div></td>'
      + '</tr>';
  }).join('');

  body.innerHTML =
    '<div class="table-wrap"><table><thead><tr>'
    + '<th class="nowrap">名称</th><th>令牌值</th><th style="text-align:right">操作</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
    + '<p class="hint" style="padding:12px 14px 0;font-size:.75rem">' + (STATE.secretsEncrypted ? '已启用加密存储' : '当前明文存储') + '</p>';

  Array.prototype.forEach.call(body.querySelectorAll('[data-sc]'), function(b){
    var name = b.closest('[data-name]').dataset.name;
    var item = list.find(function(x){ return x.name === name; }) || {};
    if(b.dataset.sc === 'show'){
      b.onclick = function(){
        var cell = b.closest('tr').querySelector('.sc-val');
        if(cell.textContent === item.value){
          var v = item.value || '';
          cell.textContent = v.length > 12 ? (v.slice(0, 6) + '…' + v.slice(-6)) : v;
          b.textContent = '显示';
        }else{
          cell.textContent = item.value;
          b.textContent = '隐藏';
        }
      };
    }else if(b.dataset.sc === 'edit'){
      b.onclick = function(){ secretDialog(item); };
    }else if(b.dataset.sc === 'del'){
      b.onclick = function(){ deleteSecretDialog(item); };
    }
  });
}

function secretDialog(item){
  var isNew = !item;
  openModal({
    title: isNew ? '新增令牌' : ('编辑 ' + esc(item.name)),
    sub: isNew ? '名称用大写下划线格式，如 CLOUDFLARE_API_TOKEN' : '留空表示不修改名称',
    body:
      '<div class="field"><label for="scName">令牌名称</label>'
      + '<input id="scName" maxlength="64" value="' + attr(isNew ? '' : item.name) + '" placeholder="如 CLOUDFLARE_API_TOKEN">'
      + '<p class="hint">仅支持大写字母、数字与下划线，且以大写字母开头。</p></div>'
      + '<div class="field"><label for="scValue">令牌值</label>'
      + '<textarea id="scValue" rows="3" placeholder="粘贴令牌内容" style="font-family:monospace">' + attr(isNew ? '' : item.value) + '</textarea></div>'
      + '<div class="msg" id="scMsg"></div>',
    foot: '<button class="btn btn-ghost" data-no>取消</button>'
        + '<button class="btn" data-yes>' + (isNew ? '保存' : '更新') + '</button>',
    onMount: function(box){
      var msg = box.querySelector('#scMsg');
      box.querySelector('[data-no]').onclick = closeModal;
      box.querySelector('[data-yes]').onclick = function(){
        var name = (box.querySelector('#scName').value || '').trim();
        var value = box.querySelector('#scValue').value;
        if(!name){ msg.className = 'msg err show'; msg.textContent = '令牌名称不能为空'; return; }
        if(!value){ msg.className = 'msg err show'; msg.textContent = '令牌值不能为空'; return; }
        api('/admin?action=save-secret', { method:'POST', body:{ name: name, value: value } })
          .then(function(j){
            closeModal();
            toast(j.message || '已保存', 'ok');
            loadSecrets();
          })
          .catch(function(e){
            msg.className = 'msg err show';
            msg.textContent = e.message;
          });
      };
    }
  });
}

function deleteSecretDialog(item){
  confirmBox({
    title: '删除令牌',
    html: '确定删除 <b class="mono">' + esc(item.name) + '</b> 吗？',
    detail: '删除后后台就不再保存这条令牌，但已经写到 Cloudflare / GitHub Secrets 里的不受影响。',
    danger: true,
    okText: '删除'
  }).then(function(ok){
    if(!ok) return;
    api('/admin?action=delete-secret', { method:'POST', body:{ name: item.name } })
      .then(function(){ toast('已删除', 'ok'); loadSecrets(); })
      .catch(function(e){ toast('删除失败：' + e.message, 'err', 4000); });
  });
}

/* ============================================================================
 * ⑱ 面板：系统设置
 * ========================================================================= */
/** v3.5.42：班徽预览（填了地址就显示小图，填错给个提示） */
function paintBadgePrev(){
  var el = document.getElementById('stBadgePrev');
  var inp = document.getElementById('stBadge');
  if(!el || !inp) return;
  var u = String(inp.value || '').trim();
  if(!u){ el.innerHTML = '<span class="muted" style="font-size:.76rem">当前使用站点班徽 badge.png</span>'; return; }
  var abs = u;
  try{ abs = new URL(u, location.href).href; }catch(e){}
  el.innerHTML = '<img src="' + attr(abs) + '" alt="班徽预览" '
    + 'style="width:64px;height:64px;border-radius:14px;object-fit:cover;border:1px solid var(--border)" '
    + 'onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'block\'">'
    + '<span class="muted" style="display:none;font-size:.76rem;color:#b3261e">图片加载失败，检查地址是否正确</span>';
}

function renderSettings(){
  $('view').innerHTML =
    '<div class="grid-2">'

    + '<section class="panel">'
    +   '<div class="panel-head"><div><h3>' + svg('globe') + '站点信息</h3>'
    +     '<p class="sub">显示在班级站上的基本信息（v3.5.29 起改这里立即生效，无需改代码）</p></div></div>'
    +   '<div class="panel-body">'
    +     '<div class="field"><label for="stName">站点名称</label>'
    +     '<input id="stName" placeholder="如 25级05班班级服务站" maxlength="40"></div>'
    +     '<div class="field"><label for="stSlogan">副标题 / 标语</label>'
    +     '<input id="stSlogan" placeholder="选填，如 一站式获取班级服务 · 资源 · 工具" maxlength="60"></div>'
    /* v3.5.42（站主 #2）：班徽 —— 导出图片右上角用 */
    +     '<div class="field"><label for="stBadge">班徽图片地址</label>'
    +     '<input id="stBadge" placeholder="留空则用站点图标 favicon.svg；可填图片直链或 ./badge.png">'
    +     '<p class="hint">用于所有「导出图片」（作业 / 抽歌排期）的右上角。'
    +     '建议用正方形 PNG（不小于 128×128），放在站点目录里最稳（外链可能因跨域画不上，会自动跳过）。</p>'
    +     '<div id="stBadgePrev" style="margin-top:8px"></div></div>'
    +     '<button class="btn" id="stSave">' + svg('check', 14) + '保存设置</button>'
    +     '<div class="msg" id="stMsg"></div>'
    +   '</div>'
    + '</section>'

    + '<section class="panel">'
    +   '<div class="panel-head"><div><h3>' + svg('shield') + '账号策略</h3>'
    +     '<p class="sub">站点级开关，保存后立即生效（无需重新部署）</p></div></div>'
    +   '<div class="panel-body">'

    /* v2.10.0：注册总开关 + 注册审核，真开关真保存。
       数据走 /admin?action=settings 与 set-settings（site_settings 表）。 */
    +   '<div class="field">'
    +     '<label style="display:flex;align-items:center;gap:10px;cursor:pointer">'
    +       '<input type="checkbox" id="stRegOpen" style="width:auto;margin:0">'
    +       '<span><b>开放自助注册</b><br>'
    +       '<span class="muted" style="font-size:.76rem">关闭后登录页不显示注册入口，注册接口拒绝请求，账号仅可由管理员在「成员与档案」创建</span></span>'
    +     '</label>'
    +   '</div>'
    +   '<div class="field">'
    +     '<label style="display:flex;align-items:center;gap:10px;cursor:pointer">'
    +       '<input type="checkbox" id="stRegReview" style="width:auto;margin:0">'
    +       '<span><b>注册需管理员审核</b><br>'
    +       '<span class="muted" style="font-size:.76rem">开启后：新注册的账号状态为「待审核」，在「成员与档案」里通过后才能登录；未审核账号无法登录</span></span>'
    +     '</label>'
    +   '</div>'
    +   '<button class="btn" id="stPolicySave">' + svg('check', 14) + '保存策略</button>'
    +   '<div class="msg" id="stPolicyMsg"></div>'

    +   '<dl class="kv" style="grid-template-columns:130px 1fr;margin-top:18px">'
    +     '<dt>首次登录</dt><dd><span class="badge badge-green">建议改密</span>'
    +       '<div class="muted" style="font-size:.76rem;margin-top:5px">v2.10.0 起：用初始密码登录后只是<b>建议</b>修改，可点「暂不修改」跳过，个人中心会常驻提醒</div></dd>'
    +     '<dt>密码存储</dt><dd><span class="badge badge-gray">PBKDF2-SHA256</span>'
    +       '<div class="muted" style="font-size:.76rem;margin-top:5px">只存哈希，管理员也无法查看明文密码</div></dd>'
    +     '<dt>登录限流</dt><dd><span class="badge badge-blue">5 次错误锁 15 分钟</span></dd>'
    +   '</dl>'
    + '</div>'
    + '</section>'

    + '</div>'

    + '<section class="panel" style="margin-top:18px">'
    +   '<div class="panel-head"><div><h3>' + svg('database') + '后端连接</h3>'
    +     '<p class="sub">前端与后端的对接状态</p></div></div>'
    +   '<div class="panel-body">'
    +     '<dl class="kv" style="grid-template-columns:130px 1fr">'
    +     '<dt>后端地址</dt><dd class="mono" style="font-size:.78rem">' + esc(API_BASE || '(同域)') + '</dd>'
    +     '<dt>数据库</dt><dd>Neon Postgres</dd>'
    +     '<dt>运行环境</dt><dd>Cloudflare Workers</dd>'
    +     '</dl>'
    +     '<div style="margin-top:16px"><button class="btn btn-sm btn-secondary" id="stPing">' + svg('activity', 14) + '测试连接</button></div>'
    +     '<div class="msg" id="stPingMsg"></div>'
    +   '</div>'
    + '</section>';

  $('stPing').onclick = function(){
    var msg = $('stPingMsg');
    msg.className = 'msg show warn'; msg.textContent = '正在测试…';
    api('/admin?action=stats').then(function(){
      msg.className = 'msg ok show';
      msg.textContent = '连接正常，后端与数据库均可用。';
    }).catch(function(e){
      msg.className = 'msg err show';
      msg.textContent = '连接失败：' + e.message;
    });
  };

  /* v3.5.29：站点名称 / 副标题真正可编辑（站主：「站点的名称及它的一个副名称
     也可以在这后台编辑」）。读写都走 site_config（与点歌守卫 vhGuard 同一条管道）：
     · 读  —— GET /content?keys=site_config，回填输入框
     · 存  —— 整个 cfg 取回 → 改 siteName / siteSubtitle → PUT /content
       （必须先取整个 cfg 再合并，不然会把 vhGuard 等其它配置冲掉）
     留空 = 恢复前端 index.html 里的静态默认。主站收到 site_config 后由
     applySiteConfig → applyBranding 即时换 <title>、页头大标题、副标题、页脚。 */
  (function(){
    var nameEl = $('stName'), subEl = $('stSlogan');
    api('/content?keys=site_config').then(function(j){
      var cfg = (j && j.items && j.items.site_config) || {};
      if(nameEl && !nameEl.value) nameEl.value = String(cfg.siteName || '');
      if(subEl && !subEl.value) subEl.value = String(cfg.siteSubtitle || '');
      var bdEl = $('stBadge');
      if(bdEl && !bdEl.value) bdEl.value = String(cfg.badgeUrl || '');
      paintBadgePrev();
      if(bdEl) bdEl.oninput = paintBadgePrev;
    }).catch(function(){});
    $('stSave').onclick = function(){
      var msg = $('stMsg');
      if(!msg) return;
      msg.className = 'msg show warn';
      msg.textContent = '保存中…';
      api('/content?keys=site_config').then(function(j){
        var cfg = (j && j.items && j.items.site_config) || {};
        if(typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
        var name = String((nameEl && nameEl.value) || '').trim();
        var sub = String((subEl && subEl.value) || '').trim();
        /* ⚠️ 清空时写空字符串而不是 delete：前端 applySiteConfig 只覆盖「键存在」的字段，
           若 delete 掉，主站 SITE_DATA 会残留旧值，清空就永远不生效了。 */
        cfg.siteName = name;
        cfg.siteSubtitle = sub;
        /* v3.5.42：班徽地址（保存空串 = 回落到站点图标，不是删键） */
        cfg.badgeUrl = String(($('stBadge') && $('stBadge').value) || '').trim();
        /* 顺手缓存一份，导出图片时不用再多查一次 */
        try{
          localStorage.setItem('__cls_badge', JSON.stringify({
            url: cfg.badgeUrl, ts: Date.now()
          }));
        }catch(e){}
        return api('/content', { method: 'PUT', body: { items: { site_config: cfg } } });
      }).then(function(){
        msg.className = 'msg show ok';
        msg.textContent = '已保存。成员下次打开或刷新班级站后将显示新的站点名称与副标题（浏览器标题栏、页头、页脚同步更换）。';
        toast('站点信息已保存', 'ok');
      }).catch(function(e){
        msg.className = 'msg show err';
        msg.textContent = '保存失败：' + (e.message || e);
      });
    };
  })();

  /* v2.10.0：注册策略（总开关 + 审核）—— 读当前值，保存写 site_settings。
     register_open 为 null = 从未设置过，此时展示环境变量兜底值（envDefault），
     管理员一旦保存即以 DB 值为准。 */
  api('/admin?action=settings').then(function(j){
    var s = (j && j.settings) || {};
    var ro = $('stRegOpen'), rr = $('stRegReview');
    if(ro) ro.checked = s.register_open === null || s.register_open === undefined
      ? !!(j && j.envDefault && j.envDefault.register_open) : !!s.register_open;
    if(rr) rr.checked = (s.register_review === null || s.register_review === undefined) ? true : !!s.register_review;
  }).catch(function(){ /* 读不到就保持默认勾选态，保存时以界面为准 */ });

  $('stPolicySave').onclick = function(){
    var msg = $('stPolicyMsg');
    msg.className = 'msg show warn'; msg.textContent = '保存中…';
    api('/admin?action=set-settings', { method:'POST', body: {
      register_open: $('stRegOpen').checked,
      register_review: $('stRegReview').checked,
    }}).then(function(j){
      msg.className = 'msg ok show'; msg.textContent = j.message || '已保存，立即生效';
    }).catch(function(e){
      msg.className = 'msg err show'; msg.textContent = '保存失败：' + e.message;
    });
  };
}

/* ============================================================================
 * ⑲ 面板：我的账户
 * ========================================================================= */
function renderAccount(){
  var me = STATE.me || {};
  $('view').innerHTML =
    '<div class="grid-2">'

    + '<section class="panel">'
    +   '<div class="panel-head"><div><h3>' + svg('user') + '账号信息</h3></div></div>'
    +   '<div class="panel-body">'
    +     '<dl class="kv">'
    +     '<dt>用户名</dt><dd class="mono">' + esc(me.username || '—') + '</dd>'
    +     '<dt>显示名</dt><dd>' + esc(me.displayName || '—') + '</dd>'
    +     '<dt>角色</dt><dd><span class="badge badge-orange">管理员</span></dd>'
    +     '</dl>'
    +   '</div>'
    + '</section>'

    /* ---- AI 助手交接（需求 8）----
       AI 助手是一个真实管理员账号，能编辑云端公告/作业。
       换 AI 时在这里把身份转给新账号即可，不用改代码重新部署。 */
    + '<section class="panel">'
    +   '<div class="panel-head"><div><h3>' + svg('refresh') + 'AI 助手交接</h3>'
    +     '<p class="sub">把 AI 助手身份转交给另一个账号</p></div></div>'
    +   '<div class="panel-body">'
    +     '<div class="alert info" style="margin-bottom:14px;font-size:.8rem">'
    +       'AI 助手账号可以编辑云端公告和作业。<br>'
    +       '换 AI 时：先让新账号自行注册，再在这里填它的用户名点交接。<br>'
    +       '旧账号会降回普通用户（<b>不会删号，数据都保留</b>），新账号需重新登录。'
    +     '</div>'
    +     '<div id="aiCur" class="muted" style="font-size:.82rem;margin-bottom:12px">正在读取当前 AI 账号…</div>'
    +     '<div class="field"><label for="aiNew">接管账号的用户名</label>'
    +     '<input id="aiNew" placeholder="例如 aibot" maxlength="20"></div>'
    +     '<button class="btn btn-secondary" id="aiGo">' + svg('refresh', 14) + '交接 AI 助手身份</button>'
    +     '<div class="msg" id="aiMsg"></div>'
    +   '</div>'
    + '</section>'

    + '<section class="panel">'
    +   '<div class="panel-head"><div><h3>' + svg('lock') + '修改密码</h3>'
    +     '<p class="sub">修改后其他设备会自动退出登录</p></div></div>'
    +   '<div class="panel-body">'
    +     '<div class="field"><label for="pwOld">当前密码</label>'
    +     '<input id="pwOld" type="password" autocomplete="current-password"></div>'
    +     '<div class="field"><label for="pwNew">新密码</label>'
    +     '<input id="pwNew" type="password" autocomplete="new-password" placeholder="6–64 位">'
    +     '<p class="hint">建议使用字母与数字组合，且不同于登录名。</p></div>'
    +     '<div class="field"><label for="pwNew2">再输一次新密码</label>'
    +     '<input id="pwNew2" type="password" autocomplete="new-password"></div>'
    +     '<button class="btn" id="pwGo">' + svg('check', 14) + '修改密码</button>'
    +     '<div class="msg" id="pwMsg"></div>'
    +   '</div>'
    + '</section>'

    + '</div>'

    + '<section class="panel" style="margin-top:18px">'
    +   '<div class="panel-head"><div><h3>' + svg('activity') + '我的登录记录</h3>'
    +     '<p class="sub">检测账号是否被他人使用</p></div></div>'
    +   '<div id="meLogins"><div class="loading" style="padding:26px"><div class="spinner"></div></div></div>'
    + '</section>';

  /* ---- AI 助手交接 ---- */
  loadAiAccount();
  $('aiGo').onclick = handoverAi;

  $('pwGo').onclick = function(){
    var msg = $('pwMsg');
    var o = $('pwOld').value, n = $('pwNew').value, n2 = $('pwNew2').value;
    if(!o || !n){ msg.className = 'msg err show'; msg.textContent = '请填写完整'; return; }
    if(n !== n2){ msg.className = 'msg err show'; msg.textContent = '两次输入的新密码不一样'; return; }
    if(n.length < 6 || n.length > 64){ msg.className = 'msg err show'; msg.textContent = '新密码长度需 6–64 位'; return; }

    $('pwGo').disabled = true;
    msg.className = 'msg show warn'; msg.textContent = '正在修改…';
    /* v2.9.9：客户端派生路径，服务端零派生 */
    clsChangePwd(o, n, STATE.me && STATE.me.username)
      .then(function(j){
        if(j.token) setToken(j.token);
        msg.className = 'msg ok show';
        msg.textContent = j.message || '密码已修改';
        $('pwOld').value = ''; $('pwNew').value = ''; $('pwNew2').value = '';
        $('pwGo').disabled = false;
        toast('密码已修改', 'ok');
      })
      .catch(function(e){
        msg.className = 'msg err show';
        msg.textContent = e.message;
        $('pwGo').disabled = false;
      });
  };

  api('/admin?action=login-logs&id=' + me.id + '&limit=15').then(function(j){
    var logs = j.logs || [];
    var el = $('meLogins');
    if(!el) return;
    el.innerHTML = logs.length
      ? '<div class="table-wrap"><table><thead><tr><th class="nowrap">时间</th><th class="nowrap">IP</th><th>设备</th></tr></thead><tbody>'
        + logs.map(function(l){
            return '<tr><td class="nowrap">' + esc(fmt(l.createdAt)) + '</td>'
              + '<td class="nowrap mono">' + esc(l.ip || '—') + '</td>'
              + '<td class="muted" style="font-size:.78rem">' + esc(shortUA(l.userAgent)) + '</td></tr>';
          }).join('')
        + '</tbody></table></div>'
      : '<div class="empty" style="padding:30px"><p class="muted">暂无登录记录</p></div>';
  }).catch(function(){
    var el = $('meLogins');
    if(el) el.innerHTML = '<div class="alert info" style="margin:16px">登录记录暂不可用（需先在数据库执行 api/schema.sql）</div>';
  });
}

/* ---------------- AI 助手交接 ----------------
   读当前 AI 账号是谁，显示在账户面板上 */
function loadAiAccount(){
  api('/admin?action=ai-account').then(function(j){
    var el = $('aiCur');
    if(!el) return;
    var a = j.account;
    el.innerHTML = a
      ? '当前 AI 助手账号：<b class="mono">' + esc(a.username) + '</b>'
        + '（显示名：' + esc(a.displayName) + '）'
      : '<span style="color:var(--warn)">当前还没有 AI 助手账号</span>'
        + '<br><span style="font-size:.78rem">提交交接后会自动把目标账号设为 AI 助手</span>';
  }).catch(function(e){
    var el = $('aiCur');
    if(el) el.textContent = '读取失败：' + e.message;
  });
}

/** 把 AI 助手身份交给另一个账号 */
function handoverAi(){
  var name = ($('aiNew').value || '').trim().toLowerCase();
  var msg = $('aiMsg');
  if(!name){
    msg.className = 'msg err show';
    msg.textContent = '请填写要接管的用户名';
    return;
  }
  confirmBox({
    title: '确认交接 AI 助手身份',
    html: '要把 AI 助手身份交给 <b class="mono">' + esc(name) + '</b> 吗？',
    detail: '该账号会被提升为管理员，并获得编辑云端公告/作业的权限。'
          + '原来的 AI 账号会降回普通用户（账号和数据都保留）。',
    warn: '交接后需要让新账号重新登录才会生效。',
    okText: '确认交接',
  }).then(function(ok){
    if(!ok) return;
    $('aiGo').disabled = true;
    api('/admin?action=handover-ai', { method:'POST', body:{ username: name } })
      .then(function(j){
        $('aiGo').disabled = false;
        msg.className = 'msg ok show';
        msg.textContent = j.message || '已完成交接';
        $('aiNew').value = '';
        toast('AI 助手身份已交接', 'ok', 4200);
        loadAiAccount();
      })
      .catch(function(e){
        $('aiGo').disabled = false;
        msg.className = 'msg err show';
        msg.textContent = e.message;
      });
  });
}

/* ============================================================================
 * ⑲ 登录门 / 会话
 * ========================================================================= */
/* 与主站 index.html 共用的登录态键。
   第二十七轮（2026-10-07）修复「后台显示旧身份 / 在线不显示」：
   以前后台用 cls_admin_token / cls_admin_user，主站用 cls_auth，
   两套完全独立 —— 在主站登了 AI 账号，后台还显示上次的余子康；
   两边心跳各发各的 token，后端只记到一边，在线状态也对不上。
   现在后台登录/登出都同步写一份 cls_auth（主站同款形状 {token,user}），
   启动时也优先读 cls_auth，实现「一套登录态、两站共享」。 */
var LS_SHARED = 'cls_auth';

function syncShared(){
  try{
    if(STATE.token && STATE.me){
      localStorage.setItem(LS_SHARED, JSON.stringify({ token: STATE.token, user: STATE.me }));
    }else{
      localStorage.removeItem(LS_SHARED);
    }
  }catch(e){}
}

function setToken(t){
  STATE.token = t || '';
  try{
    if(t) localStorage.setItem(LS_TOKEN, t);
    else localStorage.removeItem(LS_TOKEN);
    syncShared();
  }catch(e){}
  /* 登录后开始心跳：站主自己在后台挂着也要算「在线」（2026-10-07） */
  if(t && typeof startAdminHeartbeat === 'function') startAdminHeartbeat();
}
function setUser(u){
  STATE.me = u || null;
  try{
    if(u) localStorage.setItem(LS_USER, JSON.stringify(u));
    else localStorage.removeItem(LS_USER);
    syncShared();
  }catch(e){}
}

function gateMsg(text, kind){
  var el = $('gMsg');
  el.className = 'msg show ' + (kind || 'err');
  el.textContent = text;
}

function doLogin(){
  var u = $('gU').value.trim();
  var p = $('gP').value;
  if(!u || !p){ gateMsg('请填写用户名和密码'); return; }

  $('gGo').disabled = true;
  $('gGo').textContent = '登录中…';
  gateMsg('', '');

  /* v2.9.9：浏览器本地派生 credential，服务端零派生 */
  clsLogin(u, p)
    .then(function(j){
      if(!j.user || j.user.role !== 'admin'){
        gateMsg('这个账号不是管理员，无法进入后台。');
        $('gGo').disabled = false; $('gGo').textContent = '登录后台';
        return;
      }
      setToken(j.token);
      setUser(j.user);
      $('gGo').disabled = false; $('gGo').textContent = '登录后台';
      /* 首次登录（管理员自己也可能被重置过密码）→ 强制改密 */
      if(j.mustChangePassword){ openForceChangePwd(); return; }
      enterApp();
    })
    .catch(function(e){
      gateMsg(e.message || '登录失败');
      $('gGo').disabled = false; $('gGo').textContent = '登录后台';
    });
}

/** 强制改密弹窗：不可关闭，改完才能用后台 */
function openForceChangePwd(){
  openModal({
    locked: true,
    title: '请先修改初始密码',
    sub: '为了账号安全，首次登录必须设置自己的新密码',
    body:
      '<div class="alert warn">当前账号仍为初始密码，请设置新密码，之后使用新密码登录。</div>'
      + '<div class="field"><label for="fcOld">当前密码（初始密码）</label>'
      + '<input id="fcOld" type="password" autocomplete="current-password"></div>'
      + '<div class="field"><label for="fcNew">新密码</label>'
      + '<input id="fcNew" type="password" autocomplete="new-password" placeholder="6–64 位">'
      + '<p class="hint">建议使用字母与数字组合。</p></div>'
      + '<div class="field"><label for="fcNew2">再输一次新密码</label>'
      + '<input id="fcNew2" type="password" autocomplete="new-password"></div>'
      + '<div class="msg" id="fcMsg"></div>',
    foot: '<button class="btn btn-block" id="fcGo">设置新密码并进入后台</button>',
    onMount: function(box){
      box.querySelector('#fcGo').onclick = function(){
        var msg = box.querySelector('#fcMsg');
        var o = box.querySelector('#fcOld').value;
        var n = box.querySelector('#fcNew').value;
        var n2 = box.querySelector('#fcNew2').value;
        if(!o || !n){ msg.className = 'msg err show'; msg.textContent = '请填写完整'; return; }
        if(n !== n2){ msg.className = 'msg err show'; msg.textContent = '两次输入的新密码不一样'; return; }
        if(n.length < 6 || n.length > 64){ msg.className = 'msg err show'; msg.textContent = '新密码长度需 6–64 位'; return; }
        if(n === o){ msg.className = 'msg err show'; msg.textContent = '新密码不能和初始密码一样'; return; }

        box.querySelector('#fcGo').disabled = true;
        msg.className = 'msg show warn'; msg.textContent = '正在设置…';
        /* v2.9.9：客户端派生路径，服务端零派生 */
        clsChangePwd(o, n, STATE.me && STATE.me.username)
          .then(function(j){
            if(j.token) setToken(j.token);
            toast('密码已设置成功', 'ok');
            closeModal();
            enterApp();
          })
          .catch(function(e){
            msg.className = 'msg err show';
            msg.textContent = e.message;
            box.querySelector('#fcGo').disabled = false;
          });
      };
    }
  });
}

function doLogout(silent){
  var finish = function(){
    setToken(''); setUser(null);
    $('app').classList.remove('show');
    $('gate').classList.remove('hide');
    $('gP').value = '';
    if(!silent) toast('已退出登录', 'ok');
  };
  if(!STATE.token){ finish(); return; }
  api('/auth?action=logout', { method:'POST' }).catch(function(){}).then(finish);
}

function enterApp(){
  $('gate').classList.add('hide');
  $('app').classList.add('show');
  var me = STATE.me || {};
  $('meName').textContent = me.displayName || me.username || '管理员';
  $('meAv').textContent = String(me.displayName || me.username || '管').charAt(0).toUpperCase();
  $('meRole').textContent = 'ADMIN';
  go('overview');
  startAdminHeartbeat();
  /* v3.5.42：把班徽地址缓存下来，导出图片时直接用 */
  try{ cacheSiteBadge(); }catch(e){}
  /* v3.7.0：顺便把班徽图本身也下到本地（7 天一次） */
  try{ adminBadgeCacheLoad(false); }catch(e){}
}

/* v3.5.40（站主 #3）：后台心跳带上当前面板，在线统计里就能看出
   「在后台看投票 / 在后台看成绩」各花了多久。格式 admin:<panelId>。 */
function adminPageName(){
  var id = (typeof STATE !== 'undefined' && STATE && STATE.page) || 'overview';
  return 'admin:' + id;
}

/* v3.5.35：后台也要打心跳 —— 站主开着后台改作业的时间同样算「在线」，
   否则「在线时长」面板会把站长漏掉。规则与主站一致：60 秒一拍，
   标签页隐藏时跳过；失败静默，绝不影响后台使用。 */
/** v3.5.42：导出图片用的班徽地址。优先用「站点信息」里配的，其次站点图标。 */
/** v3.7.0（站主 #3）：登录时把班徽存本地，导出直接读缓存（后台同前台一套逻辑） */
function adminBadgeCacheGet(){
  try{
    var v = localStorage.getItem('__cls_badge_src') || '';
    return v.indexOf('data:image/') === 0 ? v : '';
  }catch(e){ return ''; }
}
function adminBadgeCacheLoad(force){
  var cached = adminBadgeCacheGet();
  var ts = 0;
  try{ ts = Number(localStorage.getItem('__cls_badge_ts')) || 0; }catch(e){}
  if(!force && cached && ts && (Date.now() - ts) < 7 * 86400000) return;
  try{
    fetch(apiUrl('/badge'), { cache:'force-cache' }).then(function(r){
      if(!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function(blob){
      if(!blob || blob.size < 200) return;
      var fr = new FileReader();
      fr.onload = function(){
        var d = String(fr.result || '');
        if(d.indexOf('data:image/') !== 0) return;
        try{
          localStorage.setItem('__cls_badge_src', d);
          localStorage.setItem('__cls_badge_ts', String(Date.now()));
        }catch(e){}
      };
      fr.readAsDataURL(blob);
    }).catch(function(){});
  }catch(e){}
}

/** v3.6.5：后台的班徽候选（缓存优先，其次本地小图，最后走代理） */
function adminBadgeList(){
  var list = [];
  var cached = adminBadgeCacheGet();
  if(cached) list.push(cached);
  try{ list.push(new URL('./badge.png', location.href).href); }catch(e){}
  try{
    var c = JSON.parse(localStorage.getItem('__cls_badge') || '{}');
    if(c && /^https?:\/\//i.test(String(c.url || ''))) list.push(apiUrl('/badge'));
  }catch(e){}
  return list;
}

function adminBadgeUrl(){
  /* v3.6.4：与前台一致 —— 配了直链就走服务器代理，避免跨域把画布搞脏 */
  try{
    var c = JSON.parse(localStorage.getItem('__cls_badge') || '{}');
    if(c && /^https?:\/\//i.test(String(c.url || ''))) return apiUrl('/badge');
  }catch(e){}
  try{ return new URL('./badge.png', location.href).href; }catch(e){ return './badge.png'; }
}

/** 后台启动时拉一次 site_config，把班徽地址缓存下来（导出时不用等） */
function cacheSiteBadge(){
  try{
    api('/content?keys=site_config').then(function(j){
      var cfg = (j && j.items && j.items.site_config) || {};
      localStorage.setItem('__cls_badge', JSON.stringify({
        url: String(cfg.badgeUrl || ''), ts: Date.now()
      }));
    }).catch(function(){});
  }catch(e){}
}

function startAdminHeartbeat(){
  if(window.__adminHbTimer) return;   /* 防重复启动（PWA 往返 / 重新登录） */
  var beat = function(){
    if(document.hidden) return;
    if(!STATE.token) return;
    try{
      fetch(apiUrl('/auth?action=ping&page=' + encodeURIComponent(adminPageName())), {
        method:'GET', cache:'no-store',
        headers:{ Authorization:'Bearer ' + STATE.token }
      }).catch(function(){});
    }catch(e){}
  };
  beat();
  window.__adminHbTimer = setInterval(beat, 60000);
}

/* ============================================================================
 * ⑳ 主题
 * ========================================================================= */
/* v3.5.14：横屏切换（修正「双重旋转」）
   ------------------------------------------------------------
   站主反馈：「只旋转了我的手机屏幕，页面没有一起旋转，还是只能竖着看」。
   原因是：系统被 fullscreen + orientation.lock 转成横屏后（视口 844×390），
   CSS 又把 body 转了 -90°，等于转回竖屏。

   现在的规则：
     · LAND_ON = 用户要不要横屏（只表示意图）
     · syncLandscapeClass() 看**当前视口**：竖屏（h>w）才加 .force-landscape 旋转兜底；
       一旦系统真的转成横屏（w>h），立刻撤掉 CSS 旋转，页面自然铺满宽屏。
     · 锁方向成功与否都不影响结果，最多差一个「地址栏方向」。 */
var LAND_ON = false;
/* v3.5.30：横屏只认「用户显式点过按钮」。
   ------------------------------------------------------------
   站主原话：
     「如果是从主页面进入的后台页面，默认采用竖屏，不用横过来。每次都横过来，
       但实际上它还是竖屏，因为我你只是改了页面，但是手机没改。」
     「在后台界面退出了一下 PWA 应用（切到后台做别的事），重新回来时要保持原来状态，
       不要一回去又变成竖屏了。」
   于是拆成两层状态：
     · LAND_ON      —— 当前要不要横屏（唯一真源，只由按钮/恢复流程改）
     · cls_admin_land —— 持久化 LAND_ON（'1' / '0'），跨 PWA 前后台切换、跨刷新都记住
   进入后台时不看「上次怎么设的」而看「这次从哪进来的」：
     从主站跳进来（sessionStorage 有 cls_admin_from_home）→ 一律竖屏，并清掉横屏记忆；
     外部直接打开网址 / 独立 PWA 入口 → 沿用上次的横屏选择。
   另外监听 visibilitychange：从后台切回来时重新对齐一次，避免系统把屏幕转回去后
   CSS 还停在横屏状态（站主抱怨的「回来又变回竖屏」就是这种不同步）。 */
var LAND_LS = 'cls_admin_land';
var FROM_HOME_LS = 'cls_admin_from_home';

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
  /* v3.5.40：设备物理横了就不再加 CSS 旋转（iOS PWA 视口可能不更新） */
  var need = LAND_ON && vpPortrait && !devLand;
  var html = document.documentElement;
  if(html.classList.contains('force-landscape') !== need){
    html.classList.toggle('force-landscape', need);
  }
  var btn = document.getElementById('btnRotate');
  if(btn) btn.setAttribute('data-on', LAND_ON ? '1' : '0');
  landscapePin();
}

/* v3.9.6（站主）：横屏时 body 自己滚动，absolute 的顶栏会随内容滚走 ——
   滚到中间就点不到汉堡按钮（打开侧边栏）。滚动时按 scrollTop 补偿把它钉住。 */
function landscapePin(){
  var head = document.querySelector('.head');
  if(!head) return;
  var html = document.documentElement;
  if(!html.classList.contains('force-landscape')){
    if(head.style.top) head.style.top = '';
    return;
  }
  var st = (document.body && document.body.scrollTop) || 0;
  head.style.top = st + 'px';
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

function toggleLandscape(){
  LAND_ON = !LAND_ON;
  saveLandIntent();
  if(LAND_ON){
    lockLandscape();
    /* 先按竖屏兜底转一次；350ms 后系统若已转屏会自动撤掉 CSS 旋转 */
    syncLandscapeClass();
    setTimeout(syncLandscapeClass, 380);
    toast('已切到横屏（若画面还是竖的，把手机横过来即可）', 'ok');
  }else{
    unlockLandscape();
    document.documentElement.classList.remove('force-landscape');
    setTimeout(syncLandscapeClass, 380);
    toast('已切回竖屏', 'ok');
  }
}

/** 记住当前横屏意图（'1' / '0'）。显式点按钮、恢复流程都走这里，保证只有一处写盘。 */
function saveLandIntent(){
  try{ localStorage.setItem(LAND_LS, LAND_ON ? '1' : '0'); }catch(e){}
}

/** v3.5.30：进入后台时决定用竖屏还是横屏。
 *  规则（站主拍板）：
 *    ① 从主站跳进来 → 一律竖屏，并顺手把横屏记忆清成 '0'
 *       （否则下次从外部打开又会横过来，等于没改）
 *    ② 外部直接打开 / 独立 PWA → 沿用上次选择
 *  注意：这里**不主动调用 lockLandscape()**。站主抱怨「页面横了但手机没横」，
 *  根因就是以前进来就抢着锁方向；现在只有点了按钮才尝试锁，
 *  免得一进后台画面就是歪的。 */
function initLandscape(){
  var fromHome = false;
  try{
    fromHome = sessionStorage.getItem(FROM_HOME_LS) === '1';
    if(fromHome) sessionStorage.removeItem(FROM_HOME_LS);
  }catch(e){}
  if(fromHome){
    LAND_ON = false;
    saveLandIntent();
    document.documentElement.classList.remove('force-landscape');
  }else{
    try{ LAND_ON = (localStorage.getItem(LAND_LS) === '1'); }catch(e){ LAND_ON = false; }
  }
  syncLandscapeClass();
  setTimeout(syncLandscapeClass, 400);
}

/** v3.5.30：从后台切回来 / 页面被恢复时重新对齐。
 *  v3.5.40 重写：不再重复请求锁方向（iOS PWA 恢复时视口没更新，锁方向 + fixed 旋转
 *  会把页面顶出屏幕，站主反馈的「卡住」就是这个）。
 *  现在先摘旋转 → 两帧后按真实视口重排 → 再等一拍补一次。 */
function resyncLandscape(){
  try{
    document.documentElement.classList.remove('force-landscape');
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){
        syncLandscapeClass();
        setTimeout(syncLandscapeClass, 260);
      });
    });
  }catch(e){}
}

function applyTheme(t){
  document.documentElement.setAttribute('data-theme', t === 'dark' ? 'dark' : '');
  try{ localStorage.setItem(LS_THEME, t); }catch(e){}
  /* 字色全站共用逻辑（与 index.html 同款）：主题变了背景全变，
     所有 .ink-auto 按新背景重算相反色；启动时 initTheme→applyTheme 也会扫到 */
  try{ clsAutoInk(document.body); }catch(e){}
}
function initTheme(){
  var t = '';
  try{ t = localStorage.getItem(LS_THEME) || ''; }catch(e){}
  if(!t){
    /* 跟随系统 */
    t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : '';
  }
  applyTheme(t);
}

/* ============================================================================
 * ㉑ 启动
 * ========================================================================= */
/* ============================================================================
 * 版本号显示 + 在线心跳（2026-10-07）
 * -------------------------------------------------------------------------- */
/* 版本号显示 + 在线心跳（2026-10-07）
   ⚠️ 2026-10-10：版本号要同时写进**顶栏 #headVer** 和侧边栏 #adminVer。
      手机上侧边栏默认收起，只有顶栏那个看得见 —— 站主靠它判断自己打开的是
      不是缓存的旧页面（此前反复出现「改了却没生效」，其实是手机缓存）。 */
function paintAdminVer(){
  var txt = 'v' + SITE_VERSION + ' · ' + VER_DATE;
  var a = $('adminVer'); if(a) a.textContent = txt;
  var h = $('headVer');  if(h) h.textContent = 'v' + SITE_VERSION;
}
/* 点击回查线上后端构建号：等于最新 commit 前 7 位说明已经是新代码 */
function checkAdminVer(){
  var el = $('adminVer') || $('headVer');
  if(!el) return;
  var txt = 'v' + SITE_VERSION + ' · 回查中…';
  var a = $('adminVer'); if(a) a.textContent = txt;
  var h = $('headVer');  if(h) h.textContent = 'v' + SITE_VERSION + ' ·…';
  var t = new Date();
  var hhmm = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2);
  fetch((API_BASE || '') + '/api/content', { cache:'no-store' })
    .then(function(r){
      var sha = r.headers.get('x-build-sha') || '';
      var full = 'v' + SITE_VERSION + ' · ' + VER_DATE + ' · 线上构建 ' + (sha || '未知') + ' ' + hhmm;
      var a2 = $('adminVer'); if(a2) a2.textContent = full;
      var h2 = $('headVer');  if(h2) h2.textContent = 'v' + SITE_VERSION + ' · ' + (sha || '未知');
    })
    .catch(function(){
      var full = 'v' + SITE_VERSION + ' · ' + VER_DATE + ' · 回查失败';
      var a3 = $('adminVer'); if(a3) a3.textContent = full;
      var h3 = $('headVer');  if(h3) h3.textContent = 'v' + SITE_VERSION + ' · 回查失败';
    });
}
/* 后台也算「在线」：站主自己在后台挂着也要体现在最后上线里 */
function boot(){
  initTheme();
  paintAdminVer();

  /* 顶栏按钮 */
  var rot = $('btnRotate');
  if(rot) rot.onclick = toggleLandscape;
  /* v3.5.14 修：横屏不再「无脑 CSS 旋转」——
     系统（屏幕）真的转成横屏时，页面再转 -90° 就等于又转回竖屏，看着还是竖的。
     现在只记「用户想让后台横屏」的意图，按实时视口决定要不要 CSS 兜底旋转。
     v3.5.30：意图改为「这次从哪进来」决定，见 initLandscape() 注释。 */
  initLandscape();
  window.addEventListener('resize', syncLandscapeClass);
  window.addEventListener('orientationchange', function(){ setTimeout(syncLandscapeClass, 260); });
  /* v3.5.30：PWA 切到后台再回来 —— 系统可能已经悄悄把方向改了，
     这里重新对齐一次 CSS 横屏状态，保证「回来还是你离开时的样子」。 */
  document.addEventListener('visibilitychange', function(){
    if(document.visibilityState === 'visible') setTimeout(resyncLandscape, 120);
  });
  /* 页面从往返缓存（bfcache）恢复时同样对齐 */
  window.addEventListener('pageshow', function(){ setTimeout(resyncLandscape, 120); });
  $('btnTheme').onclick = function(){
    var cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? '' : 'dark');
  };
  $('btnRefresh').onclick = function(){ go(STATE.page); };
  /* 返回主界面（需求 13）。直接跳转，登录态靠 localStorage 里的 token 带过去，
     回到主站仍是登录状态，不用重新登。 */
  $('btnBackHome').onclick = function(){ location.href = 'index.html'; };
  $('btnLogout').onclick = function(){ doLogout(false); };
  $('burger').onclick = function(){
    var s = $('side');
    if(s.classList.contains('open')) closeSide(); else openSide();
  };
  $('scrim').onclick = closeSide;

  /* 登录门 */
  $('gGo').onclick = doLogin;
  $('gP').onkeydown = function(e){ if(e.key === 'Enter') doLogin(); };
  $('gU').onkeydown = function(e){ if(e.key === 'Enter') $('gP').focus(); };

  /* 恢复会话：优先读与主站共用的 cls_auth（2026-10-07 统一登录态）。
     这样在主站登录了 AI 账号，打开后台直接就是 AI 账号，不会再显示旧身份。 */
  var token = '';
  var user = null;
  try{
    var shared = localStorage.getItem(LS_SHARED);
    if(shared){
      var sa = JSON.parse(shared);
      if(sa && sa.token && sa.user){ token = sa.token; user = sa.user; }
    }
  }catch(e){}
  /* 兜底：升级前残留的 cls_admin_*（旧会话） */
  if(!token){
    try{
      token = localStorage.getItem(LS_TOKEN) || '';
      var raw = localStorage.getItem(LS_USER);
      if(raw) user = JSON.parse(raw);
    }catch(e){}
  }

  if(!token || !user || user.role !== 'admin'){
    return;   /* 停在登录门 */
  }

  STATE.token = token;
  STATE.me = user;

  /* 校验 token 是否还有效，并顺手确认 role */
  api('/auth?action=me').then(function(j){
    if(!j.user || j.user.role !== 'admin'){
      doLogout(true);
      gateMsg('这个账号不是管理员，无法进入后台。');
      return;
    }
    STATE.me = j.user;
    setUser(j.user);
    if(j.mustChangePassword){ $('gate').classList.add('hide'); openForceChangePwd(); return; }
    enterApp();
  }).catch(function(){
    doLogout(true);
  });
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', boot);
}else{
  boot();
}
/* v2.5.0 去 emoji：启动后把后台界面里写死的 emoji 一次性换成 SVG 图标。
   ⚠️ 只跑一次、不监听 DOM；option 放不了 SVG，单独去 emoji。 */
setTimeout(function(){
  try{ admIconify(document.body); }catch(e){}
  try{ admStripOptions(document); }catch(e){}
}, 0);

/* ============================================================================
 * ⑫ 面板：抽歌排期（第二十八轮，从主站 index.html 整体搬迁）
 * ----------------------------------------------------------------------------
 * 【为什么搬】
 *   原先这套抽签逻辑住在前端 index.html 里，靠「点歌平台图标连点 5 次 +
 *   答身份验证题（身份证后四位 / 户籍地村名）」隐藏进入。
 *   站主要求：功能挪进后台，前台那套入口整个删掉。
 *
 * 【搬过来时砍掉了什么】
 *   · 身份验证弹窗 —— 后台本身就要密码登录，再答一遍是重复劳动。
 *   · 「点歌平台图标连点 5 次」的入口 —— 后台由侧栏点进来，不需要暗门。
 *   · 平台密钥的两个 xor 密文常量 —— 后台已有一份（VH_DJ_KEY_ENC），复用即可。
 *
 * 【数据存哪：这次改了】
 *   前台版本把排期存在浏览器 localStorage（cls_dj_schedule），
 *   换台电脑 / 清缓存就全没了 —— 而这是个「在教室电脑抽签」的场景。
 *   现在改为存云端（/api/content 的 dj_schedule / dj_excluded 两键），
 *   全班管理员共享同一份，换设备不丢。
 *
 *   ⚠️ localStorage 仍然保留，但只做两件事：
 *      ① 读取失败时的兜底（比如网络断了，至少还能看本机旧数据）
 *      ② 首次进入时的「旧数据一键迁移」来源
 *   写入一律走云端，不再写 localStorage。
 *
 * 【依赖】
 *   · vhFetchSongs() / vhDjKey()  —— 后台「点歌管理」面板已有的拉歌单实现，直接复用，不重复实现
 *   · api()                       —— 统一请求封装（自动带 token、处理 401）
 *   · openModal / confirmBox / toast / svg / esc  —— 后台通用 UI
 * ========================================================================= */

/* 排期与排除清单的云端读写。改自前台 djLoadRounds/djSaveRounds —— 区别只在「存云端」。 */
var DJ_LS_SCHEDULE = 'cls_dj_schedule';   /* 仅作旧数据迁移与本机兜底 */
var DJ_LS_EXCLUDED = 'cls_dj_excluded';
var DJ_LS_EXCLUDED_REQ = 'cls_dj_excluded_req';
var DJ_LS_NOTE = 'cls_dj_copy_note';

var DJ_STATE = {
  songs: [],          /* 平台歌单（拉下来后缓存在这，切视图不重复拉） */
  rounds: [],         /* 排期批次 */
  excluded: { songs: [], reqs: [] },   /* 单曲排除 / 整人排除 */
  view: 'song',       /* 歌单管理视图：song=按歌曲 req=按点歌人 */
  pick: [],           /* 本次抽中的歌（用于「复制公示」校验） */
  loaded: false,      /* 云端数据是否已拉过 */
  dirtyLocal: false,  /* 本机是否有可迁移的旧数据 */
  /* v3.5.6 点歌人加权：考试进步 / 班委身份两个加成，管理员在抽签面板调。
     wmap = { 点歌人姓名: { prog:进步了没, comm:是不是班委 } }，抽签时按需拉一次 */
  weight: { on: false, prog: 2, comm: 1 },
  wmap: null,
  /* v3.5.12 获选原因（站主 2026-10-17 #3）：
     progTopN = 进步加权只覆盖「班内总分排名进步幅度前 N 名」（0 = 不限，所有进步的人都算）
     commNames = 班委名单来源（后台头衔）；reasonShort = 公示里允许的最大字数（默认 5） */
  reason: { progTopN: 0, reasonShort: 5 },
};

/* ---- 兼容读取：云端那份可能被写成数组，也可能写成 {schedule:[...]} ---- */
function djNormRounds(v){
  if(Array.isArray(v)) return v;
  if(v && Array.isArray(v.schedule)) return v.schedule;
  return [];
}
function djNormExcluded(v){
  var o = { songs: [], reqs: [] };
  if(Array.isArray(v)) { o.songs = v; return o; }        /* 极老格式：纯 id 数组 */
  if(v && typeof v === 'object'){
    if(Array.isArray(v.songs)) o.songs = v.songs;
    if(Array.isArray(v.reqs)) o.reqs = v.reqs;
  }
  return o;
}

/* ---- 本机旧数据（只读，供迁移与兜底）---- */
function djLocalRounds(){
  try{ return djNormRounds(JSON.parse(localStorage.getItem(DJ_LS_SCHEDULE) || '[]')); }catch(e){ return []; }
}
function djLocalExcluded(){
  var s = [], r = [];
  try{ s = JSON.parse(localStorage.getItem(DJ_LS_EXCLUDED) || '[]') || []; }catch(e){}
  try{ r = JSON.parse(localStorage.getItem(DJ_LS_EXCLUDED_REQ) || '[]') || []; }catch(e){}
  return { songs: Array.isArray(s) ? s : [], reqs: Array.isArray(r) ? r : [] };
}

/* ---- 从云端拉一次（排期 + 排除清单一起）---- */
function djLoadCloud(){
  return api('/content').then(function(j){
    var it = (j && j.items) || {};
    DJ_STATE.rounds = djNormRounds(it.dj_schedule);
    DJ_STATE.excluded = djNormExcluded(it.dj_excluded);
    /* 云端两个都是空的、而本机有旧数据 → 提示可迁移 */
    var loc = djLocalRounds(), locEx = djLocalExcluded();
    DJ_STATE.dirtyLocal = (!DJ_STATE.rounds.length && !DJ_STATE.excluded.songs.length && !DJ_STATE.excluded.reqs.length)
      && (loc.length > 0 || locEx.songs.length > 0 || locEx.reqs.length > 0);
    DJ_STATE.loaded = true;
    return j;
  });
}
/* ---- 写云端。只传要改的键，后端是「读旧→合并→写回」语义 ---- */
function djSaveSchedule(arr){
  DJ_STATE.rounds = arr || [];
  return api('/content', { method:'PUT', body:{ items:{ dj_schedule: DJ_STATE.rounds } } })
    .then(function(){ toast('排期已保存到云端', 'ok'); })
    .catch(function(e){ toast('保存失败：' + e.message, 'err', 4000); throw e; });
}
function djSaveExcluded(){
  return api('/content', { method:'PUT', body:{ items:{ dj_excluded: DJ_STATE.excluded } } })
    .catch(function(e){ toast('排除清单保存失败：' + e.message, 'err', 4000); throw e; });
}

/* ---- 取排除态（改成读内存，不再读 localStorage）---- */
function djExcludedMap(){
  var m = {};
  (DJ_STATE.excluded.songs || []).forEach(function(id){ m[id] = 1; });
  return m;
}
function djExcludedReqMap(){
  var m = {};
  (DJ_STATE.excluded.reqs || []).forEach(function(n){ m[n] = 1; });
  return m;
}
function djSetExcluded(id, on){
  var arr = (DJ_STATE.excluded.songs || []).filter(function(x){ return String(x) !== String(id); });
  if(on) arr.push(id);
  DJ_STATE.excluded.songs = arr;
  return djSaveExcluded();
}
function djSetExcludedReq(name, on){
  var arr = (DJ_STATE.excluded.reqs || []).filter(function(x){ return String(x) !== String(name); });
  if(on) arr.push(name);
  DJ_STATE.excluded.reqs = arr;
  return djSaveExcluded();
}
function djClearExcluded(){
  confirmBox({
    text: '确定清空全部排除记录？',
    detail: '包含「单曲排除」和「点歌人排除」两类，清空后这些歌会重新参与抽签。',
    danger: true, okText: '清空',
  }).then(function(yes){
    if(!yes) return;
    DJ_STATE.excluded = { songs: [], reqs: [] };
    djSaveExcluded().then(function(){
      toast('已清空排除记录', 'ok');
      paintDjSongs();
    });
  });
}

/* ---- 点歌人姓名兼容（平台可能返回字符串或 {name} 对象）---- */
function djReqName(s){
  var r = (typeof s.requester === 'string') ? s.requester : ((s.requester && s.requester.name) || '');
  return String(r == null ? '' : r).trim();
}

/* ---- 已播放 / 已排期：默认排除，不用手动一首首点 ----
 * 「已排期」= 只要在排期记录里出现过就算，不要求该批次被勾成「已加到平台」。
 * （前台 2026-08-30 修的坑：要求 addedToPlatform 会让「排除已排期」形同虚设） */
function djAutoExclude(){
  var schedIds = {}, playedIds = {};
  (DJ_STATE.rounds || []).forEach(function(r){
    (r.songs || []).forEach(function(s){
      if(s && s.id != null) schedIds[s.id] = 1;
    });
  });
  /* 平台自身也带 played 标记（同学在平台上标记过已播） */
  (DJ_STATE.songs || []).forEach(function(s){ if(s && s.played) playedIds[s.id] = 1; });
  return { schedIds: schedIds, playedIds: playedIds };
}
function djAutoExReason(s, info){
  if(!s) return '';
  if(info.playedIds[s.id]) return '已播放';
  if(info.schedIds[s.id]) return '已排期';
  return '';
}

/* ---- 时间格式化（平台返回 UTC ISO，直接切片会差 8 小时）---- */
function djFmtTime(iso){
  if(!iso) return '';
  var d = new Date(iso);
  if(isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
  function p(n){ return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate())
       + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function djNowLocal(){
  var d = new Date();
  function p(n){ return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate())
       + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* ============================ 面板骨架 ============================ */
function renderDj(){
  $('view').innerHTML =
    '<div class="alert info" style="margin-bottom:16px">'
    +   '本页数据保存在<b>云端</b>（全班管理员共用一份），换电脑 / 清缓存都不会丢。'
    +   '歌单实时来自点歌平台，抽签结果会写进云端排期。'
    + '</div>'
    + '<div id="djMigrate"></div>'
    /* v3.5.27：时长缺口提示（时长为空不能排歌） */
    + '<div id="djDurNotice" style="display:none"></div>'
    + '<section class="panel" style="margin-bottom:16px">'
    +   '<div class="panel-head" style="display:flex;align-items:center;justify-content:space-between;gap:10px">'
    +     '<h3 style="margin:0;font-size:.95rem">🎲 抽签</h3>'
    +     '<div style="display:flex;gap:8px">'
    +       '<button class="btn btn-sm btn-ghost" id="djSongsBtn">' + svg('music',14) + ' 歌单管理</button>'
    +       '<button class="btn btn-sm btn-ghost" id="djHistoryBtn">' + svg('clock',14) + ' 历史记录</button>'
    +     '</div>'
    +   '</div>'
    /* 时间范围 */
    +   '<div class="field" style="margin-top:4px"><label>投稿时间范围</label>'
    +     '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">'
    +       '<input type="datetime-local" id="djFrom" style="flex:1;min-width:150px">'
    +       '<span class="muted">至</span>'
    +       '<input type="datetime-local" id="djTo" style="flex:1;min-width:150px">'
    +     '</div>'
    +   '</div>'
    +   '<div style="display:flex;gap:6px;margin:8px 0 14px;flex-wrap:wrap">'
    +     '<button class="btn btn-sm btn-secondary" data-dj-quick="0">全部</button>'
    +     '<button class="btn btn-sm btn-secondary" data-dj-quick="3">近 3 天</button>'
    +     '<button class="btn btn-sm btn-secondary" data-dj-quick="7">近 7 天</button>'
    +     '<button class="btn btn-sm btn-secondary" data-dj-quick="30">近 30 天</button>'
    +   '</div>'
    +   '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:6px">'
    +     '<div class="field" style="margin:0;width:120px"><label>抽取数量</label>'
    +       '<input type="number" id="djCount" min="1" max="50" placeholder="留空 = 自动" value="5"></div>'
    +     '<div class="field" style="margin:0;width:130px"><label>高赞必选</label>'
    +       '<input type="number" id="djTopN" min="0" max="50" value="0" title="点赞最高的前 N 首必定中选，其余随机"></div>'
    /* v3.5.19：按时长抽取（音乐课常用，比如一节课 40 分钟） */
    +     '<div class="field" style="margin:0;width:150px"><label>总时长上限</label>'
    +       '<input type="number" id="djMaxMin" min="1" max="300" placeholder="留空 = 不限" title="累加歌曲时长，超过就不再抽（缺时长的歌不参与判断）"></div>'
    +   '</div>'
    +   '<p class="hint" id="djCapHint" style="margin:-2px 0 10px">抽取数量 / 总时长上限二选一：填了总时长上限，系统按歌曲时长自动决定数量。</p>'
    /* v3.5.27：时长库状态 —— 让站主一眼看到「哪些歌还没时长」入口 */
    +   '<div id="djDurStat" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;'
    +     'margin:-4px 0 12px;font-size:.8rem;color:var(--fg-3)">'
    +     '<span>🎵 歌曲时长：先查<b>云端时长库</b>，未再查询网易云 / QQ 音乐；均无结果时需手动填写，否则无法排歌</span>'
    +     '<button class="btn btn-sm btn-ghost" id="djDurLibBtn" type="button">时长库 / 补录</button>'
    +   '</div>'
    +   '<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px;font-size:.85rem">'
    +     '<label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" id="djExcludePlayed" checked> 排除已播放</label>'
    +     '<label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" id="djExcludeSched" checked> 排除已排期</label>'
    +     '<label style="display:flex;align-items:center;gap:5px;cursor:pointer" title="同一位同学点的歌，同一次抽签最多上一首"><input type="checkbox" id="djOnePer" checked> 每人限一首</label>'
    +     '<label style="display:flex;align-items:center;gap:5px;cursor:pointer" title="考试进步的同学、班委，歌被随机抽中的概率更高"><input type="checkbox" id="djWeightOn"> 点歌人加权</label>'
    +   '</div>'
    +   '<div id="djWeightBox" style="display:none;margin-bottom:12px;padding:10px 12px;border:1px solid var(--line,#e5dcd2);border-radius:10px">'
    +     '<div style="display:flex;gap:10px;flex-wrap:wrap">'
    +       '<div class="field" style="margin:0;width:150px"><label>考试进步加成</label>'
    +         '<input type="number" id="djWProg" min="0" max="20" step="0.5" value="2" title="最近两场考试班内总分排名靠前＝进步，权重加这么多"></div>'
    +       '<div class="field" style="margin:0;width:150px"><label>班委身份加成</label>'
    +         '<input type="number" id="djWComm" min="0" max="20" step="0.5" value="1" title="有班级职务（班长/委员/课代表等）＝班委，权重加这么多"></div>'
    +       '<div class="field" style="margin:0;width:190px"><label>进步加权范围</label>'
    +         '<input type="number" id="djWProgTop" min="0" max="60" step="1" value="0" title="只给「班内总分排名进步幅度前 N 名」加权。0 = 所有进步的人都算"></div>'
    +     '</div>'
    +     '<p class="muted" style="font-size:.78rem;margin:8px 0 0;line-height:1.6">进步按最近两场有成绩的考试算（总分班内排名靠前，名次变化越大越靠前）；班委按后台头衔任命算。加成只作用于随机抽取，「高赞必选」不受影响。设为 0 即关闭该项。</p>'
    +   '</div>'
    +   '<button class="btn" id="djRunBtn" style="width:100%">🎲 开始抽签</button>'
    +   '<div id="djResult" style="margin-top:12px"></div>'
    + '</section>'
    + '<section class="panel">'
    +   '<div class="panel-head"><h3 style="margin:0;font-size:.95rem">📋 公示</h3></div>'
    /* v3.5.21：公示文案可选显示每首时长和总时长 */
    +   '<div style="display:flex;gap:14px;flex-wrap:wrap;margin:8px 0 6px;font-size:.84rem">'
    +     '<label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" id="djShowDur" checked> 显示每首时长</label>'
    +     '<label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" id="djShowTotal" checked> 显示歌曲总时长</label>'
    +   '</div>'
    +   '<div class="field"><label>公示备注（选填，会加在公示最后）</label>'
    +     '<textarea id="djCopyNote" rows="2" placeholder="选填：例如「本次不随机抽人，是对段考前十的奖励」。抽签规则那行会自动生成，不用填"></textarea>'
    +   '</div>'
    +   '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">'
    +     '<button class="btn btn-green" id="djCopyBtn">' + svg('file',14) + ' 一键复制公示</button>'
    /* v3.5.40（站主 #6）：把公示画成长图，直接发群里 */
    +     '<button class="btn" id="djImgBtn">' + svg('download',14) + ' 导出图片</button>'
    +     '<button class="btn btn-secondary" id="djShareBtn">' + svg('upload',14) + ' 分享图片</button>'
    +     '<button class="btn btn-secondary" id="djExportBtn">' + svg('download',14) + ' 导出数据</button>'
    +     '<button class="btn btn-secondary" id="djImportBtn">' + svg('upload',14) + ' 导入数据</button>'
    +     '<button class="btn btn-ghost" id="djClearBtn" style="color:#b3261e">' + svg('trash',14) + ' 清空排期</button>'
    +     '<input type="file" id="djImportFile" accept=".json,application/json" style="display:none">'
    +   '</div>'
    + '</section>';

  /* 备注：沿用本机存的那份（只是输入框的草稿，不算业务数据，不必上云） */
  var ne = $('djCopyNote');
  if(ne){ try{ ne.value = String(localStorage.getItem(DJ_LS_NOTE) || ''); }catch(e){} }
  ne.oninput = function(){ try{ localStorage.setItem(DJ_LS_NOTE, ne.value); }catch(e){} };

  Array.prototype.forEach.call($('view').querySelectorAll('[data-dj-quick]'), function(b){
    b.onclick = function(){ djQuick(parseInt(b.dataset.djQuick, 10) || 0); };
  });
  $('djSongsBtn').onclick = openDjSongs;
  $('djHistoryBtn').onclick = openDjHistory;
  $('djRunBtn').onclick = djRun;
  /* v3.5.27：时长库入口 —— 先拉一次云端库，再把缺时长的歌列出来 */
  var durLibBtn = $('djDurLibBtn');
  if(durLibBtn) durLibBtn.onclick = function(){ openDurLib(); };
  vhDurNotice();
  $('djCopyBtn').onclick = djCopy;
  /* v3.5.40（站主 #6）：公示长图 —— 与「一键复制公示」同一份数据，样式仿成绩卡 */
  if($('djImgBtn'))   $('djImgBtn').onclick = function(){ djShareImage('download'); };
  if($('djShareBtn')) $('djShareBtn').onclick = function(){ djShareImage('share'); };

  /* v3.5.21：抽取数量与总时长上限二选一。
     填了总时长上限后，抽取数量由系统按歌曲时长自动决定。 */
  var djCapIn = $('djMaxMin'), djCountIn = $('djCount'), djCapHint = $('djCapHint');
  function syncDjCap(){
    if(!djCapIn || !djCountIn) return;
    var cap = Number(djCapIn.value || 0);
    if(cap > 0){
      djCountIn.value = ''; djCountIn.disabled = true; djCountIn.title = '已设总时长上限，数量由系统自动决定';
      if(djCapHint) djCapHint.textContent = '已启用总时长上限：系统会按歌曲时长自动决定抽取数量，「抽取数量」此时无效。';
    }else{
      djCountIn.disabled = false; djCountIn.title = '';
      if(djCapHint) djCapHint.textContent = '抽取数量 / 总时长上限二选一：填了总时长上限，系统按歌曲时长自动决定数量。';
    }
  }
  if(djCapIn){ djCapIn.oninput = syncDjCap; syncDjCap(); }
  $('djExportBtn').onclick = djExportRounds;
  $('djImportBtn').onclick = function(){ $('djImportFile').click(); };
  $('djImportFile').onchange = function(){ djImportRounds(this); };
  $('djClearBtn').onclick = djClear;

  $('djTo').value = djNowLocal();

  /* 点歌人加权：勾选才显示加成输入框 */
  var wOn = $('djWeightOn'), wBox = $('djWeightBox');
  if(wOn && wBox){
    wOn.checked = !!DJ_STATE.weight.on;
    var wp = $('djWProg'), wc = $('djWComm'), wt = $('djWProgTop');
    if(wp) wp.value = String(DJ_STATE.weight.prog);
    if(wc) wc.value = String(DJ_STATE.weight.comm);
    if(wt) wt.value = String(Math.max(0, Number(DJ_STATE.reason.progTopN) || 0));
    wBox.style.display = wOn.checked ? '' : 'none';
    wOn.onchange = function(){
      DJ_STATE.weight.on = !!wOn.checked;
      wBox.style.display = wOn.checked ? '' : 'none';
      if(wOn.checked) djLoadWeightMap().catch(function(){});
    };
    if(wp) wp.oninput = function(){ DJ_STATE.weight.prog = Math.max(0, Number(wp.value) || 0); };
    if(wc) wc.oninput = function(){ DJ_STATE.weight.comm = Math.max(0, Number(wc.value) || 0); };
    if(wt) wt.oninput = function(){ DJ_STATE.reason.progTopN = Math.max(0, Number(wt.value) || 0); };
  }

  /* 拉云端数据；成功后检查要不要提示迁移旧数据 */
  djLoadCloud().then(function(){
    if(DJ_STATE.dirtyLocal) djShowMigrateTip();
  }).catch(function(e){
    /* 云端拉不到 → 用本机旧数据兜底，至少界面不是空的 */
    DJ_STATE.rounds = djLocalRounds();
    DJ_STATE.excluded = djLocalExcluded();
    DJ_STATE.loaded = true;
    var box = $('djMigrate');
    if(box) box.innerHTML = '<div class="alert danger" style="margin-bottom:16px">'
      + '读取云端排期失败（' + esc(e.message) + '），当前显示的是<b>本机旧数据</b>。'
      + '此时做出的修改无法保存，请检查网络后刷新重试。</div>';
  });
}

/* 本机旧数据迁移提示（只在云端为空、本机有数据时出现一次） */
function djShowMigrateTip(){
  var box = $('djMigrate');
  if(!box) return;
  var n = djLocalRounds().length, ex = djLocalExcluded();
  box.innerHTML = '<div class="alert info" style="margin-bottom:16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">'
    + '<span style="flex:1;min-width:200px">检测到本机有旧抽歌数据'
    +   '（排期 <b>' + n + '</b> 批，单曲排除 <b>' + ex.songs.length + '</b> 首，整人排除 <b>' + ex.reqs.length + '</b> 人），'
    +   '云端还是空的。要不要把它上传到云端？</span>'
    + '<button class="btn btn-sm" id="djMigGo">上传到云端</button>'
    + '<button class="btn btn-sm btn-ghost" id="djMigNo">不用了</button></div>';
  $('djMigGo').onclick = function(){
    var rounds = djLocalRounds(), e = djLocalExcluded();
    DJ_STATE.rounds = rounds;
    DJ_STATE.excluded = e;
    api('/content', { method:'PUT', body:{ items:{ dj_schedule: rounds, dj_excluded: e } } })
      .then(function(){
        toast('旧数据已上传到云端', 'ok');
        box.innerHTML = '';
        DJ_STATE.dirtyLocal = false;
      })
      .catch(function(err){ toast('上传失败：' + err.message, 'err', 4000); });
  };
  $('djMigNo').onclick = function(){ box.innerHTML = ''; };
}

/* 快捷时间范围：0=全部，其余=近 N 天 */
function djQuick(days){
  var f = $('djFrom'), t = $('djTo');
  if(days <= 0){ if(f) f.value = ''; if(t) t.value = ''; return; }
  var now = new Date(), from = new Date(now.getTime() - days * 86400000);
  function fmt(d){
    function p(n){ return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate())
         + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  if(f) f.value = fmt(from);
  if(t) t.value = fmt(now);
}

/* ============================ 抽签主流程 ============================
 * 算法与前台完全一致（三个约束按顺序施加）：
 *   ① 同一首歌不重复中选
 *   ② 「每人限一首」时，同一位点歌人只占一个名额
 *   ③ 高赞必选优先，撞上 ② 就顺延给后面的歌
 * 变化只有一处：结果写云端而非 localStorage。
 * ================================================================= */
function djRun(){
  /* v3.5.21：抽取数量 / 总时长上限二选一。填了总时长上限时，
     把数量放宽到足够大，由 take() 里的时长上限来终止。 */
  var capMin = parseInt(($('djMaxMin') || {}).value || '0', 10);
  if(!(capMin >= 0)) capMin = 0;
  var n = capMin > 0 ? 9999 : parseInt(($('djCount') || {}).value || '5', 10);
  if(capMin <= 0 && !(n >= 1)) n = 5;
  var wantN = n;
  var excl = ($('djExcludePlayed') || {}).checked;
  var exclSched = ($('djExcludeSched') || {}).checked;
  var onePerEl = $('djOnePer');
  var onePer = !onePerEl || onePerEl.checked;
  var topN = parseInt(($('djTopN') || {}).value || '0', 10);
  if(!(topN >= 0)) topN = 0;
  var wantTop = topN;

  /* v3.5.6 点歌人加权：读面板配置；开了就先拉加权数据（头衔 + 最近两场成绩）再抽 */
  var wOnEl = $('djWeightOn');
  DJ_STATE.weight.on = !!(wOnEl && wOnEl.checked);
  if(DJ_STATE.weight.on){
    DJ_STATE.weight.prog = Math.max(0, Number(($('djWProg') || {}).value) || 0);
    DJ_STATE.weight.comm = Math.max(0, Number(($('djWComm') || {}).value) || 0);
    DJ_STATE.reason.progTopN = Math.max(0, Number(($('djWProgTop') || {}).value) || 0);
  }

  var box = $('djResult');
  if(box) box.innerHTML = '<div class="loading" style="padding:12px"><div class="spinner"></div>正在拉取歌单并抽签…</div>';

  var f = $('djFrom'), t = $('djTo');
  var tFrom = f && f.value ? new Date(f.value).getTime() : -Infinity;
  var tTo = t && t.value ? new Date(t.value).getTime() : Infinity;

  djFetchSongs()
    .then(function(){ return DJ_STATE.weight.on ? djLoadWeightMap() : null; })
    .then(function(){
    var songs = DJ_STATE.songs;
    var exIds = djExcludedMap(), exReq = djExcludedReqMap();
    var auto = djAutoExclude();
    var pool = songs.filter(function(s){
      if(exIds[s.id]) return false;                  /* 手动排除单曲 */
      var rq = djReqName(s);
      if(rq && exReq[rq]) return false;              /* 手动排除该点歌人的全部歌 */
      if(excl && auto.playedIds[s.id]) return false; /* 排除已播放 */
      if(exclSched && auto.schedIds[s.id]) return false; /* 排除已排期 */
      var ts = new Date(s.createdAt).getTime();
      if(ts < tFrom || ts > tTo) return false;
      return true;
    });
    /* 🔴 v3.5.27（站主）：「时长为空不能随机排歌」。
       先把没时长的歌挑出来单独提示（而不是静默抽出一批时长未知的歌）。 */
    var noDurSongs = pool.filter(function(s){ return !(Number(s.durationSeconds) >= 20); });
    if(noDurSongs.length){
      var map0 = {};
      noDurSongs.forEach(function(s){
        map0[vhDurationKey(String(s.title || ''), String(s.artist || ''))] = { title: s.title || '', artist: s.artist || '' };
      });
      Object.keys(map0).forEach(function(k){ if(!DUR_MISS[k]) DUR_MISS[k] = map0[k]; });
      if(box){
        box.innerHTML = '<div class="alert danger" style="line-height:1.9">'
          + '<b>有 ' + noDurSongs.length + ' 首歌没有时长，按站规不能排歌</b><br>'
          + '<span style="font-size:.82rem">' + noDurSongs.slice(0, 8).map(function(s){ return esc(s.title || '?'); }).join('、')
          + (noDurSongs.length > 8 ? ' 等' : '') + '</span><br>'
          + '<span style="font-size:.82rem;color:#57534e">时长优先从云端库匹配，其次查询网易云 / QQ 音乐；均未命中时需手动填写。</span><br>'
          + '<button class="btn btn-sm" id="djDurFillNow" style="margin-top:8px">立即补录 ' + noDurSongs.length + ' 首的时长</button>'
          + '</div>';
        var b0 = document.getElementById('djDurFillNow');
        if(b0) b0.onclick = function(){ voDurManualDialog(Object.keys(map0)); };
      }
      return;
    }
    if(!pool.length){
      if(box) box.innerHTML = '<div class="alert danger">无可抽取歌曲。请放宽时间范围，或在「歌单管理」解除排除、取消「排除已播放 / 已排期」。</div>';
      return;
    }

    /* 「每人限一首」时的容量上限 = 不同点歌人数 + 无点歌人信息的歌数 */
    var personSet = {}, anonCnt = 0, pk;
    pool.forEach(function(s){ var rq = djReqName(s); if(rq) personSet[rq] = 1; else anonCnt++; });
    var personCnt = 0; for(pk in personSet) personCnt++;
    var cap = onePer ? (personCnt + anonCnt) : pool.length;
    if(n > cap) n = cap;
    if(topN > n) topN = n;

    var usedId = {}, usedReq = {}, picked = [], guarantee = [];
    var usedSec = 0;   /* v3.5.19：已抽中歌曲的总时长（秒） */
    function take(s){
      if(!s || usedId[s.id]) return false;
      var rq = djReqName(s);
      if(onePer && rq && usedReq[rq]) return false;
      var d = Number(s.durationSeconds) || 0;
      /* v3.5.27（站主）：「时长为空不能随机排歌」——
         以前「没时长就不拦」，结果抽出一批时长未知的歌，总时长统计全是错。
         现在没时长的歌直接不进池子（在下面 pool 过滤时已经剔除，这里再兜一次）。 */
      if(!(d >= 20)) return false;
      if(capMin > 0 && usedSec + d > capMin * 60) return false;
      usedSec += d;
      usedId[s.id] = 1; if(rq) usedReq[rq] = 1; picked.push(s);
      return true;
    }
    /* 1) 高赞必选：按点赞降序取；撞上「每人限一首」时自动顺延 */
    var deferred = 0;
    if(topN > 0){
      var sorted = pool.slice().sort(function(a, b){ return (b.voteCount || 0) - (a.voteCount || 0); });
      for(var i = 0; i < sorted.length && guarantee.length < topN; i++){
        if(take(sorted[i])){ guarantee.push(sorted[i]); continue; }
        var rqD = djReqName(sorted[i]);
        if(onePer && rqD && usedReq[rqD]) deferred++;
      }
    }
    /* 2) 其余随机：每中一首，同步剔除同一人的其他歌。
       v3.5.6：开了点歌人加权时按权重抽（进步 / 班委加成），否则等概率 */
    var bag = pool.filter(function(s){
      if(usedId[s.id]) return false;
      var rq = djReqName(s);
      return !(onePer && rq && usedReq[rq]);
    });
    var boosted = 0;
    while(picked.length < n && bag.length){
      var idx = djWeightedIdx(bag);
      var s = bag[idx];
      bag.splice(idx, 1);
      if(!take(s)) continue;
      if(djWeightOf(djReqName(s)) > 1) boosted++;
      if(onePer){
        var rq2 = djReqName(s);
        if(rq2){ for(var j = bag.length - 1; j >= 0; j--){ if(djReqName(bag[j]) === rq2) bag.splice(j, 1); } }
      }
    }

    /* 存成一个批次（含时间 / 备注 / 已排期 / 已播放标记 + 本次参数） */
    var rounds = (DJ_STATE.rounds || []).slice();
    /* 高赞必选集合要在生成 songs 之前先算好 —— djReasonOf 靠它判断「高赞必选」 */
    var gsetForReason = {};
    guarantee.forEach(function(s){ gsetForReason[s.id] = 1; });
    var rec = {
      id: Date.now(),
      at: new Date().toLocaleString('zh-CN', { hour12:false }),
      note: '', addedToPlatform: false, played: false,
      songs: picked.map(function(s){
        /* v3.5.12 #3：每首歌带上「获选原因」——short 用于公示（≤5 字），
           detail 用于后台结果面板与历史记录（写清楚进步了多少名 / 班干身份） */
        var why = djReasonOf(s, gsetForReason);
        return {
          id: s.id, title: s.title, artist: s.artist, votes: s.voteCount || 0,
          requester: djReqName(s),
          duration: Number(s.durationSeconds) || 0,
          reason: why.short, reasonDetail: why.detail,
          /* 高赞必选的额外标记，公示按「获选原因」一列走，不单列 */
          top: !!gsetForReason[s.id],
        };
      }),
    };
    /* 把参数存进批次：公示时用「这一批自己的参数」，
       而不是复制时面板上的当前开关（否则抽完又改了开关，公示的规则就对不上歌单了） */
    /* v3.5.21：公示时是否显示每首时长 / 歌曲总时长（用抽签那一刻的开关，避免复制时改设置导致对不上） */
    var showDurEl = $('djShowDur'), showTotalEl = $('djShowTotal');
    rec.params = {
      top: guarantee.length, picked: picked.length, onePer: onePer,
      exPlayed: !!excl, exSched: !!exclSched, pool: pool.length, persons: personCnt,
      maxMinutes: capMin || null, totalSeconds: usedSec,          /* v3.5.19 时长约束 */
      showDur: !!(showDurEl && showDurEl.checked),
      showTotal: !!(showTotalEl && showTotalEl.checked),
      /* v3.5.6 点歌人加权（null = 本次没开）；v3.5.12 加 progTopN 记录「前 N 名」范围 */
      weight: DJ_STATE.weight.on
        ? { on: true, prog: DJ_STATE.weight.prog, comm: DJ_STATE.weight.comm,
            boosted: boosted, progTopN: Math.max(0, Number(DJ_STATE.reason.progTopN) || 0) }
        : null,
    };
    rounds.push(rec);
    DJ_STATE.pick = picked;

    djSaveSchedule(rounds).then(function(){
      var gset = {};
      guarantee.forEach(function(s){ gset[s.id] = 1; });
      /* v3.5.12 #3：结果面板要把「获选原因」写清楚（这是后台看的内部版） */
      var rows = picked.map(function(s, i){
        var rq = djReqName(s);
        var why = djReasonOf(s, gset);
        return '<div style="margin-top:4px">'
          + (i + 1) + '. <b>' + esc(s.title || '?') + '</b> - ' + esc(s.artist || '未知歌手')
          + (rq ? '（点歌：' + esc(rq) + ' · ' : '（')
          + '点赞 ' + (s.voteCount || 0) + '）'
          + (s.durationSeconds ? ' · 时长 ' + voFmtDur(s.durationSeconds) : '')
          + '<div style="font-size:.78rem;color:#57534e;margin-left:1.2em">'
          +   '获选原因：<b style="color:#0a7d42">' + esc(why.short) + '</b>'
          +   (why.detail ? ' · <span style="color:#af410f">' + esc(why.detail) + '</span>' : '')
          + '</div></div>';
      }).join('');
      var mode = (topN > 0 ? '高赞必选 ' + guarantee.length + ' 首 + ' : '') + '随机'
        + (onePer ? ' · 每人限一首' : ' · 不限制每人首数')
        + (excl ? ' · 排除已播放' : '') + (exclSched ? ' · 排除已排期' : '')
        + (DJ_STATE.weight.on
            ? ' · 点歌人加权（进步 +' + DJ_STATE.weight.prog + '／班委 +' + DJ_STATE.weight.comm
              + (Math.max(0, Number(DJ_STATE.reason.progTopN) || 0) > 0
                  ? '／仅进步前 ' + DJ_STATE.reason.progTopN + ' 名' : '')
              + '，加权中选 ' + boosted + ' 首）'
            : '')
        + ' · 池中 ' + pool.length + ' 首' + (onePer ? ' / ' + personCnt + ' 位同学' : '');
      var shortMsg = '';
      if(picked.length < wantN){
        shortMsg = onePer
          ? '（受「每人限一首」限制：池中 ' + personCnt + ' 位点歌人 + ' + anonCnt + ' 首无点歌人信息，最多只能抽 ' + cap + ' 首）'
          : (capMin > 0
              ? '（已按总时长上限 ' + capMin + ' 分钟凑够 ' + picked.length + ' 首，再抽会超时）'
              : '（池中仅 ' + pool.length + ' 首，已全部抽取）');
      }
      var topMsg = (wantTop > 0 && deferred > 0)
        ? '⚠️ 高赞必选里有 ' + deferred + ' 首因「每人限一首」被顺延（同一位同学已有歌中选，名额让给后面的歌）'
        : '';
      if(box){
        box.innerHTML = '<div class="alert info" style="line-height:1.9">'
          + '<b style="color:#0a7d42">✅ 已抽中 ' + picked.length + ' 首' + shortMsg
          + '，总时长 ' + voFmtDur(usedSec)
          + '，已写入云端排期（累计 ' + djScheduleCount() + ' 首）</b><br>'
          + '<span style="color:#af410f">' + mode + '</span><br>'
          + (topMsg ? '<span style="color:#af410f;font-size:.82rem">' + topMsg + '</span><br>' : '')
          + rows + '</div>';
      }
    }).catch(function(){
      /* djSaveSchedule 内已弹错误提示；此处把结果框标红，避免看着像「抽成功了」 */
      if(box) box.innerHTML = '<div class="alert danger">抽签结果<b>没能保存到云端</b>，请检查网络后重试。'
        + '（本次抽中的歌未计入排期）</div>';
    });
  }).catch(function(err){
    if(box) box.innerHTML = '<div class="alert danger">拉取歌单失败：' + esc(String((err && err.message) || err))
      + '<br>请确认后台「点歌管理」能正常连上平台，再回来重试。</div>';
  });
}

function djScheduleCount(){
  var n = 0;
  (DJ_STATE.rounds || []).forEach(function(r){ n += (r.songs || []).length; });
  return n;
}

/* ============================ 拉歌单（复用点歌管理面板的实现） ============================ */
function djFetchSongs(){
  return vhFetchSongs().then(function(list){
    DJ_STATE.songs = list || [];
    return DJ_STATE.songs;
  });
}

/* v3.5.27：人工补录时长成功后刷新面板。
   已经拉过歌单的，把本地缓存里的秒数补回去；没拉过就等下次自动带上。 */
function djRefreshDur(){
  if(!DJ_STATE.songs || !DJ_STATE.songs.length) return;
  var cache = vhDurationCache();
  DJ_STATE.songs.forEach(function(s){
    if(Number(s.durationSeconds) >= 20) return;
    var sec = cache[vhDurationKey(String(s.title || ''), String(s.artist || ''))];
    if(sec > 0) s.durationSeconds = Number(sec);
  });
  /* 抽屉/列表里显示时长的行要跟着重画 */
  if(typeof window.__djRepaint === 'function') window.__djRepaint();
  vhDurNotice();
}
window.djRefreshDur = djRefreshDur;

/* ============================ 点歌人加权（v3.5.6）============================
 * 站主要求：抽签排期能按「考试进退步 / 班委身份」给点歌人加权 ——
 * 进步的同学、当班委的同学，歌被随机抽中的概率更高。
 * 权重只作用在**随机那一部分**：「高赞必选」是管理员明确点名要的，不掺权重。
 *
 * 数据来源（都是后台已有接口，不新增后端）：
 *   ① 班委身份 → /api/admin?action=titles：profiles[].titles 非空 = 有班级职务
 *      （头衔白名单：班长/副班长/团支书/学习委员/纪律委员/生活委员/体育委员/
 *       文艺委员/电教委/各科课代表）
 *   ② 考试进退步 → /api/scores?action=list 取最近两场有成绩的考试，
 *      分别拉 board，按「总分赋分」口径算班内总分排名；新的比旧的排名靠前 = 进步。
 *      （排名算法与前台成绩分析一致：同分并列 1,2,2,4；赋分科取 assigned）
 *
 * 姓名匹配按点歌人姓名精确比对（去空白）。成绩表姓名与账号名不一致时
 * （姓名对照表那种情况）对不上就不加权，不影响抽签本身。
 * ========================================================================= */
function djTotalOfRow(row, subs, basis){
  var t = 0, any = false;
  for(var i = 0; i < subs.length; i++){
    var v = row.s && row.s[subs[i].key];
    if(!v) continue;
    var val = (basis === 'graded' && subs[i].graded && v.assigned != null) ? v.assigned : v.raw;
    if(val == null) continue;
    t += val; any = true;
  }
  return any ? t : null;
}
/* 同分并列排名（1,2,2,4）——与前台 scRankMap 同一算法 */
function djRankByName(rows, subs, basis){
  var arr = [];
  rows.forEach(function(r){
    var t = djTotalOfRow(r, subs, basis);
    if(t != null) arr.push({ name: String(r.name || '').trim(), v: t });
  });
  arr.sort(function(a, b){ return b.v - a.v; });
  var out = {}, rank = 0, prev = null;
  arr.forEach(function(x, i){
    if(prev === null || x.v !== prev){ rank = i + 1; prev = x.v; }
    if(x.name && out[x.name] == null) out[x.name] = rank;
  });
  return out;
}

/**
 * v3.5.12（#3）把加权映射算出来：{ 姓名: { prog, comm, delta, rankOld, rankNew } }
 *   prog  : 是否「进步」（名次变小）
 *   delta : 进步了多少名（正数=进步，负数=退步，0=持平）
 *   comm  : 是否有班级职务
 *   rankOld / rankNew : 上一场 / 这一场的班内总分排名
 *   progRanked : 该人在「按进步幅度降序」里排第几（1 开始，只在进步的人里排）
 * 有了 delta 才能实现站主要求的「在班级成员学校排名进步最多的前 10 名随机选出」。
 */
function djLoadWeightMap(){
  if(DJ_STATE.wmap) return Promise.resolve(DJ_STATE.wmap);
  var map = {};
  return Promise.all([
    api('/admin?action=titles').catch(function(){ return null; }),
    api('/scores?action=list').catch(function(){ return null; }),
  ]).then(function(res){
    /* ① 班委 */
    var tj = res[0];
    ((tj && tj.profiles) || []).forEach(function(p){
      var nm = String(p.name || '').trim();
      if(!nm) return;
      var comm = !!(p.titles && p.titles.length);
      if(!map[nm]) map[nm] = { prog: false, comm: false, delta: 0, rankOld: null, rankNew: null, progRanked: 0 };
      map[nm].comm = comm;
    });
    /* ② 进退步：最近两场有成绩的考试 */
    var sj = res[1];
    var exams = ((sj && sj.exams) || []).filter(function(e){
      return e && e.id && (e.rowCount == null || e.rowCount > 0);
    });
    /* 后端按时间倒序给的，再排一次兜底（空日期沉底） */
    exams.sort(function(a, b){
      if(a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (b.id || 0) - (a.id || 0);
    });
    var last2 = exams.slice(0, 2);
    if(last2.length === 2){
      return Promise.all(last2.map(function(e){
        return api('/scores?action=board&exam=' + e.id).catch(function(){ return null; });
      })).then(function(bs){
        var older = bs[1], newer = bs[0];   /* last2[0] 最新 */
        if(older && newer && older.rows && newer.rows){
          var rOld = djRankByName(older.rows, older.exam.subjects || [], 'graded');
          var rNew = djRankByName(newer.rows, newer.exam.subjects || [], 'graded');
          var gains = [];
          Object.keys(rNew).forEach(function(nm){
            if(rOld[nm] == null) return;               /* 上一场没这个人，无从谈进退步 */
            var delta = rOld[nm] - rNew[nm];            /* 正数 = 名次前进 */
            if(!map[nm]) map[nm] = { prog: false, comm: false, delta: 0, rankOld: null, rankNew: null, progRanked: 0 };
            map[nm].delta = delta;
            map[nm].rankOld = rOld[nm];
            map[nm].rankNew = rNew[nm];
            map[nm].prog = delta > 0;
            if(delta > 0) gains.push({ name: nm, delta: delta });
          });
          /* 「进步最多的前 N 名」：按进步幅度降序排，同幅度并列同名次 */
          gains.sort(function(a, b){ return b.delta - a.delta; });
          var rk = 0, prevD = null;
          gains.forEach(function(g, i){
            if(prevD === null || g.delta !== prevD){ rk = i + 1; prevD = g.delta; }
            map[g.name].progRanked = rk;
          });
          /* 记下这批进步的名单，公示时要按名次范围写原因 */
          DJ_STATE.gainTop = rk;
          DJ_STATE.gainCount = gains.length;
          DJ_STATE.examOld = older.exam && (older.exam.name || older.exam.title);
          DJ_STATE.examNew = newer.exam && (newer.exam.name || newer.exam.title);
        }
        DJ_STATE.wmap = map;
        return map;
      });
    }
    DJ_STATE.wmap = map;
    return map;
  });
}
/* 某个点歌人的权重倍数（1 = 不加成）
 * v3.5.12：进步加成受「前 N 名」限制（reason.progTopN，0 = 不限） */
function djProgEligible(name){
  var info = DJ_STATE.wmap && DJ_STATE.wmap[name];
  if(!info || !info.prog) return false;
  var topN = Math.max(0, Number(DJ_STATE.reason.progTopN) || 0);
  if(topN > 0 && !(info.progRanked >= 1 && info.progRanked <= topN)) return false;
  return true;
}
function djWeightOf(name){
  var w = DJ_STATE.weight;
  if(!w.on) return 1;
  var info = DJ_STATE.wmap && DJ_STATE.wmap[name];
  if(!info) return 1;
  var mul = 1;
  if(djProgEligible(name) && w.prog > 0) mul += w.prog;
  if(info.comm && w.comm > 0) mul += w.comm;
  return mul;
}

/**
 * v3.5.12（#3）获选原因
 * 「抽歌要备注抽到的歌的原因（班干加权、进步加权，具体进步多少名），
 *   但公示只需要写明 歌曲-歌手-点歌人-点赞量-获选原因（5 字以内概括，
 *   没有就是随机抽取）」
 *
 * 返回 { short, detail }：
 *   short  公示用，≤5 字（可调）。没有加成就是「随机抽取」。
 *   detail 后台内部记录 / 结果面板用，写清楚到底为什么。
 */
function djReasonOf(s, gset){
  var rq = djReqName(s);
  var info = (DJ_STATE.wmap && DJ_STATE.wmap[rq]) || null;
  var isTop = !!(gset && gset[s.id]);

  /* 高赞必选：管理员点名要的，最优先说明 */
  if(isTop){
    return { short: '高赞必选', detail: '点赞 ' + (s.voteCount || 0) + '，进入高赞必选名额' };
  }
  if(!rq) return { short: '随机抽取', detail: '这首没有点歌人信息，纯随机' };

  var parts = [];   /* 内部明细 */
  var shorts = [];  /* 公示短语候选 */

  if(DJ_STATE.weight.on && info){
    if(djProgEligible(rq)){
      var d = Number(info.delta) || 0;
      var rk = info.progRanked;
      var topN = Math.max(0, Number(DJ_STATE.reason.progTopN) || 0);
      var scope = topN > 0
        ? ('班内总分排名进步最多的前 ' + topN + ' 名中')
        : '班内总分排名进步';
      parts.push(scope + '（`' + info.rankOld + '` → `' + info.rankNew + '`，进步 ' + d + ' 名'
        + (rk ? '，进步幅度第 ' + rk + ' 名' : '') + '）');
      shorts.push('进步加权');
    }
    if(info.comm && DJ_STATE.weight.comm > 0){
      parts.push('担任班级职务（班干加权 +' + DJ_STATE.weight.comm + '）');
      shorts.push('班干加权');
    }
  }

  if(!shorts.length){
    return { short: '随机抽取', detail: (rq ? '点歌人 「' + rq + '」 没有满足任何加权条件，等概率随机中选' : '纯随机') };
  }
  /* 公示短语：能合并就合并（「进步加权」4 字 + 「班干加权」4 字超 5 字时取第一项） */
  var maxLen = Math.max(2, Number(DJ_STATE.reason.reasonShort) || 5);
  var short = shorts.join('+');
  if(short.length > maxLen){
    short = shorts.filter(function(x){ return x.length <= maxLen; })[0] || shorts[0].slice(0, maxLen);
  }
  return { short: short, detail: parts.join('；') };
}
/* 加权随机取一个下标：权重 = 1 + 加成；全部为 1 时行为与等概率一致 */
function djWeightedIdx(bag){
  var total = 0, i;
  for(i = 0; i < bag.length; i++) total += djWeightOf(djReqName(bag[i]));
  var r = Math.random() * total;
  for(i = 0; i < bag.length; i++){
    r -= djWeightOf(djReqName(bag[i]));
    if(r <= 0) return i;
  }
  return bag.length - 1;
}

/* ============================ 歌单管理（按歌曲 / 按点歌人） ============================ */
var _djReqGroups = [], _djReqOpen = {};

function openDjSongs(){
  openModal({
    title: '🎼 歌单管理',
    sub: '可以排除「某一首歌」，也可以排除「某一个人点的全部歌」',
    wide: true,
    body: '<p class="muted" style="font-size:.82rem;margin:0 0 10px;line-height:1.7">'
        + '已播放 / 已排期的歌会<b>默认排除</b>（行尾标 🚫），不用手动点。'
        + '想让它们重新参与，到抽签面板取消对应的「排除」开关即可。'
        + '手动排除记录保存在云端。</p>'
        + '<div class="seg" id="djSongsTab" style="margin-bottom:10px">'
        +   '<button data-dj-view="song">🎵 按歌曲</button>'
        +   '<button data-dj-view="req">👤 按点歌人</button>'
        + '</div>'
        + '<div class="search" style="width:100%;margin-bottom:8px">' + svg('search')
        +   '<input id="djSongSearch" placeholder="搜索歌名 / 歌手 / 点歌人" maxlength="40">'
        + '</div>'
        + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">'
        +   '<p id="djSongsStatus" class="muted" style="flex:1;min-width:0;margin:0;font-size:.82rem"></p>'
        +   '<button class="btn btn-sm btn-ghost" id="djSongsClear">清空排除</button>'
        + '</div>'
        + '<div id="djSongsList" style="max-height:52vh;overflow:auto"><div class="loading"><div class="spinner"></div>加载中…</div></div>',
    onMount: function(box){
      box.querySelector('[data-dj-view="song"]').onclick = function(){ djSongsView('song'); };
      box.querySelector('[data-dj-view="req"]').onclick  = function(){ djSongsView('req'); };
      box.querySelector('#djSongSearch').oninput = debounce(function(e){
        DJ_STATE.q = e.target.value.trim();
        paintDjSongs();
      }, 250);
      box.querySelector('#djSongsClear').onclick = djClearExcluded;
    },
  });
  paintDjSongs();
  /* 歌单还没拉过就先拉一次 */
  if(!DJ_STATE.songs.length){
    djFetchSongs().then(function(){ paintDjSongs(); })
      .catch(function(e){
        var l = $('djSongsList');
        if(l) l.innerHTML = '<div class="empty">' + svg('alert', 32) + '<p>拉取歌单失败：' + esc(e.message) + '</p></div>';
      });
  }
  djLoadCloud().then(function(){ paintDjSongs(); }).catch(function(){});
}

function djSongsView(v){
  DJ_STATE.view = (v === 'req') ? 'req' : 'song';
  paintDjSongs();
}
function djSyncSongsTab(){
  var box = $('djSongsTab');
  if(!box) return;
  Array.prototype.forEach.call(box.querySelectorAll('[data-dj-view]'), function(b){
    b.className = (b.dataset.djView === DJ_STATE.view) ? 'on' : '';
  });
}
function djSongsFiltered(arr){
  var kw = String(DJ_STATE.q || '').toLowerCase();
  if(!kw) return arr;
  return arr.filter(function(s){
    return String(s.title || '').toLowerCase().indexOf(kw) >= 0
        || String(s.artist || '').toLowerCase().indexOf(kw) >= 0
        || djReqName(s).toLowerCase().indexOf(kw) >= 0;
  });
}
function paintDjSongs(){
  var list = $('djSongsList'), st = $('djSongsStatus');
  if(!list) return;
  djSyncSongsTab();
  var songs = DJ_STATE.songs || [];
  var ex = djExcludedMap(), exReq = djExcludedReqMap();
  var exCount = 0, k; for(k in ex) exCount++;
  var exReqCount = 0; for(k in exReq) exReqCount++;
  var auto = djAutoExclude(), autoCnt = 0;
  songs.forEach(function(s){ if(djAutoExReason(s, auto)) autoCnt++; });
  if(st) st.textContent = '共 ' + songs.length + ' 首 · 手动排除 ' + exCount + ' 首 / ' + exReqCount
    + ' 人 · 已播放或已排期 ' + autoCnt + ' 首（默认排除）';

  if(!songs.length){ list.innerHTML = '<div class="empty">' + svg('music', 32) + '<p>平台上还没有人点歌</p></div>'; return; }
  var arr = djSongsFiltered(songs);
  if(!arr.length){ list.innerHTML = '<div class="empty"><p>没有匹配的歌曲</p></div>'; return; }

  list.innerHTML = (DJ_STATE.view === 'req')
    ? djRenderReqView(arr, ex, exReq, auto)
    : arr.map(function(s, i){ return djSongRowHtml(s, i + 1, ex, exReq, auto); }).join('');

  /* 事件绑定：用 data-* 属性循环绑，避免内联 onclick 拼字符串的转义风险 */
  Array.prototype.forEach.call(list.querySelectorAll('[data-dj-ex-id]'), function(cb){
    cb.onchange = function(){
      djSetExcluded(cb.dataset.djExId, cb.checked).then(paintDjSongs);
    };
  });
  Array.prototype.forEach.call(list.querySelectorAll('[data-dj-ex-req]'), function(cb){
    cb.onchange = function(){
      djSetExcludedReq(cb.dataset.djExReq, cb.checked).then(paintDjSongs);
    };
  });
  Array.prototype.forEach.call(list.querySelectorAll('[data-dj-req-open]'), function(el){
    el.onclick = function(){
      var n = el.dataset.djReqOpen;
      _djReqOpen[n] = !_djReqOpen[n];
      paintDjSongs();
    };
  });
}

function djSongRowHtml(s, i, ex, exReq, auto){
  var req = djReqName(s);
  var byReq = req && !!exReq[req];
  var autoR = djAutoExReason(s, auto);
  var isEx = !!ex[s.id] || byReq || !!autoR;
  var isAuto = !!autoR;
  return '<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line)">'
    + '<span class="muted" style="min-width:24px;font-size:.8rem">' + i + '</span>'
    + '<span style="flex:1;min-width:0;font-size:.85rem">'
    +   '<b style="' + (isEx ? 'text-decoration:line-through;color:var(--fg-3)' : '') + '">' + esc(s.title || '?') + '</b> '
    +   '<span class="muted">' + esc(s.artist || '未知') + '</span>'
    +   '<br><span class="muted" style="font-size:.76rem">👍 ' + (s.voteCount || 0)
    +     ' · 点歌：' + esc(req || '?') + (s.played ? ' · 已播放' : '')
    +     ' · ' + esc(String(s.createdAt || '').slice(0, 10)) + '</span>'
    + '</span>'
    + (byReq
        ? '<span class="badge badge-gray" title="这位点歌人已被整人排除，请到「按点歌人」里解除">👤 已排除</span>'
        : isAuto
          ? '<span class="badge badge-gray" title="' + autoR + '的歌默认排除，不用手动勾选">🚫 ' + autoR + '</span>'
          : '<label style="display:flex;align-items:center;gap:4px;white-space:nowrap;font-size:.82rem;cursor:pointer">'
            + '<input type="checkbox" data-dj-ex-id="' + attr(String(s.id)) + '"' + (ex[s.id] ? ' checked' : '') + '> 排除</label>')
    + '</div>';
}

function djRenderReqView(arr, ex, exReq, auto){
  var map = {}, order = [];
  arr.forEach(function(s){
    var r = djReqName(s) || '（未填写点歌人）';
    if(!map[r]){ map[r] = []; order.push(r); }
    map[r].push(s);
  });
  order.sort(function(a, b){ return map[b].length - map[a].length; });
  _djReqGroups = order.map(function(r){ return { name: r, songs: map[r] }; });

  return _djReqGroups.map(function(g){
    var anon = (g.name === '（未填写点歌人）');
    var isEx = !anon && !!exReq[g.name];
    var cntEx = 0, cntAuto = 0;
    g.songs.forEach(function(s){ if(ex[s.id]) cntEx++; if(djAutoExReason(s, auto)) cntAuto++; });
    var open = !!_djReqOpen[g.name];
    return '<div style="padding:10px 0;border-bottom:1px solid var(--line)">'
      + '<div style="display:flex;align-items:center;gap:10px">'
      +   '<span style="flex:1;min-width:0;cursor:pointer;font-size:.88rem" data-dj-req-open="' + attr(g.name) + '">'
      +     (open ? '▾ ' : '▸ ') + '<b style="' + (isEx ? 'text-decoration:line-through;color:var(--fg-3)' : '') + '">' + esc(g.name) + '</b>'
      +     '<span class="muted" style="font-size:.76rem"> · ' + g.songs.length + ' 首'
      +       (cntAuto ? ' · 自动排除 ' + cntAuto : '') + (cntEx ? ' · 单曲排除 ' + cntEx : '') + '</span>'
      +   '</span>'
      +   (anon ? ''
              : '<label style="display:flex;align-items:center;gap:4px;white-space:nowrap;font-size:.82rem;cursor:pointer">'
                + '<input type="checkbox" data-dj-ex-req="' + attr(g.name) + '"' + (isEx ? ' checked' : '') + '> 排除此人</label>')
      + '</div>'
      + (open ? '<div style="margin:8px 0 2px 16px;border-left:2px solid var(--line);padding-left:12px">'
              + g.songs.map(function(s, j){ return djSongRowHtml(s, j + 1, ex, exReq, auto); }).join('')
              + '</div>' : '')
      + '</div>';
  }).join('');
}

/* ============================ 历史记录 ============================ */
function openDjHistory(){
  openModal({
    title: '📜 抽歌历史记录',
    sub: '共 ' + (DJ_STATE.rounds || []).length + ' 批，累计 ' + djScheduleCount() + ' 首',
    wide: true,
    body: '<div id="djHistoryList" style="max-height:56vh;overflow:auto"></div>',
  });
  paintDjHistory();
}
function paintDjHistory(){
  var list = $('djHistoryList');
  if(!list) return;
  var rounds = DJ_STATE.rounds || [];
  if(!rounds.length){
    list.innerHTML = '<div class="empty">' + svg('clock', 32) + '<p>还没有排期记录，先去抽一次签</p></div>';
    return;
  }
  list.innerHTML = rounds.slice().reverse().map(function(r){
    var songRows = (r.songs || []).map(function(s, j){
      /* v3.5.12 #3：历史记录也带上获选原因（内部版，写清楚为什么） */
      var why = s.reason || '随机抽取';
      return (j + 1) + '. ' + esc(s.title || '?') + ' - ' + esc(s.artist || '未知')
        + (s.requester ? '（点歌：' + esc(s.requester) + '）' : '') + '（点赞 ' + (s.votes || 0) + '）'
        + (s.duration ? ' <span class="muted">· ' + voFmtDur(s.duration) + '</span>' : '')
        + ' <span style="color:#0a7d42">· ' + esc(why) + '</span>'
        + (s.reasonDetail ? '<div class="muted" style="font-size:.72rem;margin-left:1.1em">' + esc(s.reasonDetail) + '</div>' : '');
    }).join('<br>');
    var totSec = 0;
    (r.songs || []).forEach(function(s){ totSec += Number(s.duration) || 0; });
    return '<div class="panel" style="margin:0 0 12px;padding:12px 14px;font-size:.85rem">'
      + '<div style="font-weight:700;color:#af410f;margin-bottom:8px">📅 ' + esc(r.at || '')
      +   (totSec ? '<span class="muted" style="font-weight:400;font-size:.78rem"> · 总时长 ' + voFmtDur(totSec) + '</span>' : '')
      + '</div>'
      + '<div style="display:flex;gap:8px;margin-bottom:8px">'
      +   '<input data-dj-note="' + attr(String(r.id)) + '" placeholder="备注：本次用于…" value="' + attr(r.note || '') + '" style="flex:1;min-width:0">'
      +   '<button class="btn btn-sm" data-dj-note-save="' + attr(String(r.id)) + '">保存</button>'
      + '</div>'
      + '<div style="display:flex;gap:16px;margin-bottom:8px;flex-wrap:wrap;font-size:.83rem">'
      +   '<label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" data-dj-flag="' + attr(String(r.id)) + '" data-dj-flag-name="addedToPlatform"' + (r.addedToPlatform ? ' checked' : '') + '> 已排期（已加到平台）</label>'
      +   '<label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" data-dj-flag="' + attr(String(r.id)) + '" data-dj-flag-name="played"' + (r.played ? ' checked' : '') + '> 已播放</label>'
      + '</div>'
      + '<div class="muted" style="line-height:1.9">' + (songRows || '（本批没有歌）') + '</div>'
      + '<div style="text-align:right;margin-top:8px">'
      +   '<button class="btn btn-sm btn-ghost" data-dj-del="' + attr(String(r.id)) + '" style="color:#b3261e">' + svg('trash', 13) + ' 删除本批</button>'
      + '</div>'
      + '</div>';
  }).join('');

  var box = list;
  Array.prototype.forEach.call(box.querySelectorAll('[data-dj-note-save]'), function(b){
    b.onclick = function(){ djSetRoundNote(b.dataset.djNoteSave, b); };
  });
  Array.prototype.forEach.call(box.querySelectorAll('[data-dj-flag]'), function(cb){
    cb.onchange = function(){ djToggleRoundFlag(cb.dataset.djFlag, cb.dataset.djFlagName, cb.checked); };
  });
  Array.prototype.forEach.call(box.querySelectorAll('[data-dj-del]'), function(b){
    b.onclick = function(){ djDeleteRound(b.dataset.djDel); };
  });
}
function djSetRoundNote(id, btn){
  var inp = document.querySelector('[data-dj-note="' + id + '"]');
  if(!inp) return;
  var rounds = (DJ_STATE.rounds || []).slice(), hit = null;
  for(var i = 0; i < rounds.length; i++){ if(String(rounds[i].id) === String(id)){ hit = rounds[i]; break; } }
  if(!hit) return;
  hit.note = inp.value.trim();
  djSaveSchedule(rounds).then(function(){
    if(btn){ var old = btn.textContent; btn.textContent = '✅ 已保存'; setTimeout(function(){ btn.textContent = old; }, 1200); }
  });
}
function djToggleRoundFlag(id, flag, val){
  var rounds = (DJ_STATE.rounds || []).slice();
  for(var i = 0; i < rounds.length; i++){
    if(String(rounds[i].id) === String(id)){ rounds[i][flag] = !!val; break; }
  }
  djSaveSchedule(rounds);
}
function djDeleteRound(id){
  confirmBox({ text: '确定删除这批记录吗？', detail: '只是一条排期批次记录，不影响平台上的歌单。', danger: true, okText: '删除' })
    .then(function(yes){
      if(!yes) return;
      var rounds = (DJ_STATE.rounds || []).filter(function(r){ return String(r.id) !== String(id); });
      djSaveSchedule(rounds).then(function(){ paintDjHistory(); });
    });
}

/* ============================ 导出 / 导入 / 清空 ============================ */
function djExportRounds(){
  var json = JSON.stringify(DJ_STATE.rounds || [], null, 1);
  download(new Blob([json], { type: 'application/json' }), 'dj-schedule-' + new Date().toISOString().slice(0, 10) + '.json');
  toast('已导出排期数据', 'ok');
}
function djImportRounds(input){
  var file = input.files && input.files[0];
  if(!file) return;
  var rd = new FileReader();
  rd.onload = function(){
    try{
      var arr = JSON.parse(String(rd.result));
      if(!Array.isArray(arr)) throw new Error('不是数组');
      /* 旧格式兼容：早期导出的是「扁平歌曲数组」，这里包一层成批次 */
      var isFlat = arr.length && arr[0] && (arr[0].title !== undefined) && (arr[0].songs === undefined);
      var add = isFlat
        ? [{ id: Date.now(), at: new Date().toLocaleString('zh-CN', { hour12:false }),
             note: '（从旧格式导入）', addedToPlatform: false, played: false, songs: arr }]
        : arr;
      var merged = (DJ_STATE.rounds || []).concat(add);
      djSaveSchedule(merged).then(function(){
        toast('已导入 ' + add.length + ' 批记录', 'ok');
        if($('djHistoryList')) paintDjHistory();
        if($('djResult')) $('djResult').innerHTML = '';
      });
    }catch(e){
      toast('导入失败：数据格式不正确', 'err', 4000);
    }
    input.value = '';
  };
  rd.readAsText(file);
}
function djClear(){
  confirmBox({
    text: '确定清空全部排期历史吗？',
    detail: '会清空云端的 ' + (DJ_STATE.rounds || []).length + ' 批记录，不可恢复。建议先「导出数据」备份。',
    danger: true, okText: '清空',
  }).then(function(yes){
    if(!yes) return;
    DJ_STATE.pick = [];
    djSaveSchedule([]).then(function(){
      if($('djResult')) $('djResult').innerHTML = '';
      if($('djHistoryList')) paintDjHistory();
    });
  });
}

/* ============================ 公示 ============================ */
/* 「抽签规则」行：自动生成，尽量短。
   数据优先用批次自带的 params（抽签那一刻的开关），老批次没有才按当前面板现算。 */
function djParamsLine(r, pickedLen){
  var p = (r && r.params) || null;
  if(!p){
    p = {
      top: Math.max(0, parseInt(($('djTopN') || {}).value || '0', 10) || 0),
      picked: pickedLen || 0,
      onePer: !$('djOnePer') || $('djOnePer').checked,
      exPlayed: !$('djExcludePlayed') || $('djExcludePlayed').checked,
      exSched: !$('djExcludeSched') || $('djExcludeSched').checked,
      pool: 0, persons: 0,
    };
  }
  var picked = p.picked || pickedLen || 0;
  var top = Math.max(0, p.top || 0); if(top > picked) top = picked;
  var seg = [];
  seg.push(top > 0 ? ('高赞必选 ' + top + ' + 随机 ' + (picked - top)) : ('随机 ' + picked));
  seg.push(p.onePer ? '每人限一首' : '不限每人首数');
  var ex = [];
  if(p.exPlayed) ex.push('已播放');
  if(p.exSched) ex.push('已排期');
  if(ex.length) seg.push('排除' + ex.join('、'));
  /* v3.5.6 点歌人加权（老批次没有这个字段，不显示） */
  if(p.weight && p.weight.on){
    seg.push('点歌人加权（进步 +' + (p.weight.prog || 0) + '／班委 +' + (p.weight.comm || 0) + '）');
  }
  if(p.pool) seg.push('池中 ' + p.pool + ' 首');
  return seg.join(' · ');
}
function djCopy(){
  var rounds = DJ_STATE.rounds || [];
  if(!rounds.length){ toast('还没有排期，请先抽签', 'err'); return; }
  var last = rounds[rounds.length - 1];
  var lines = [];
  lines.push('【25级05班 · 点歌抽签排期公示】');
  lines.push('抽取时间：' + (last.at || ''));
  var rule = djParamsLine(last, (last.songs || []).length);
  if(rule) lines.push('抽签规则：' + rule);
  lines.push('本期中选 ' + (last.songs || []).length + ' 首，累计排期 ' + djScheduleCount() + ' 首：');

  /* v3.5.21：公示可选显示每首时长 / 总时长（用抽签时保存的开关，避免复制前乱改设置） */
  var p = last.params || {};
  var showDur = p.showDur !== false;   /* 老数据默认显示 */
  var showTotal = p.showTotal !== false;
  var totSec = 0;
  (last.songs || []).forEach(function(s){ totSec += Number(s.duration) || 0; });

  /* v3.5.12 #3 公示格式（站主钦定，一个字都不多写）：
     歌曲 - 歌手 - 点歌人 - 点赞量 - 获选原因（≤5 字，没有就「随机抽取」）
     抽签规则那行仍然保留（那是「怎么抽的」），但每首歌这一行不再啰嗦。 */
  (last.songs || []).forEach(function(s, i){
    var why = s.reason || '随机抽取';
    var line = (i + 1) + '. ' + (s.title || '?')
      + ' - ' + (s.artist || '未知')
      + ' - ' + (s.requester || '匿名')
      + ' - 点赞 ' + (s.votes || 0)
      + ' - ' + why;
    if(showDur && s.duration) line += ' - 时长 ' + voFmtDur(s.duration);
    lines.push(line);
  });
  if(showTotal && totSec) lines.push('歌曲总时长：' + voFmtDur(totSec));

  /* 备注统一放最后：批次备注（历史记录里填的）+ 公示备注（默认为空，手填才有） */
  var notes = [];
  if(last.note) notes.push(String(last.note));
  var ne = $('djCopyNote');
  var note = ne ? String(ne.value || '').trim() : '';
  if(note) notes.push(note);
  if(notes.length) lines.push('备注：' + notes.join(' '));

  var text = lines.join('\n');
  var done = function(){ toast('公示文本已复制，可粘贴到班级群', 'ok'); };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done, function(){ djFallbackCopy(text); done(); });
  }else{ djFallbackCopy(text); done(); }
}
/* ============================================================================
 * v3.5.40（站主 #6）：抽歌排期公示 → 长图
 * ----------------------------------------------------------------------------
 * 站主原话：「抽歌排期支持导出图片公示的内容，样式和功能仿照成绩分析的导出图片」
 *
 * 与「一键复制公示」共用同一批数据（最近一次抽签），不另算一遍：
 *   头部 = 标题 / 抽取时间 / 本期首数 / 总时长
 *   分段 = 抽签规则、本期歌单（每首一行，右侧点赞数与时长）、备注
 * 画图交给 share-card.js（前后台共用），这里只负责把数据摆成 rows。
 * ========================================================================= */
/* v3.5.42（站主 #2）：导出前先选「哪一次」——
   站主原话：「抽歌导出的话，我可以选择是导出哪一次数据」。 */
function djPickRound(cb){
  var rounds = (DJ_STATE.rounds || []).slice();
  if(!rounds.length){ cb(null); return; }
  if(rounds.length === 1){ cb(rounds[0]); return; }
  var rev = rounds.slice().reverse();       /* 新的在前 */
  var html = '<div class="muted" style="font-size:.8rem;margin-bottom:10px">'
    + '共 ' + rev.length + ' 次抽签记录，点一条即可导出那一次的公示图片。</div>'
    + '<div style="max-height:50vh;overflow:auto">'
    + rev.slice(0, 60).map(function(r, i){
        var n = (r.songs || []).length;
        var rule = djParamsLine(r, n);
        return '<button class="btn btn-secondary" style="width:100%;text-align:left;margin-bottom:6px;display:block" data-djpick="' + i + '">'
          + '<b>' + esc(r.at || '未知时间') + '</b>'
          + '<span class="muted" style="margin-left:8px">' + n + ' 首</span>'
          + (i === 0 ? ' <span class="badge" style="margin-left:6px">最近一次</span>' : '')
          + (rule ? '<div class="muted" style="font-size:.72rem;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(rule) + '</div>' : '')
          + '</button>';
      }).join('')
    + '</div>';
  openModal({
    title: '导出哪一次排期', sub: '选中的那一次会画成一张长图',
    body: html,
    foot: '<button class="btn btn-secondary" id="djPickCancel">取消</button>',
    onMount: function(box){
      Array.prototype.forEach.call(box.querySelectorAll('[data-djpick]'), function(b){
        b.onclick = function(){
          var r = rev[Number(b.dataset.djpick)];
          closeModal();
          cb(r);
        };
      });
      var c = box.querySelector('#djPickCancel');
      if(c) c.onclick = closeModal;
    },
  });
}

function djShareImage(mode){
  if(typeof ShareCard === 'undefined'){
    toast('图片组件没加载出来，请刷新页面重试', 'err');
    return;
  }
  var rounds = DJ_STATE.rounds || [];
  if(!rounds.length){ toast('还没有排期，请先抽签', 'err'); return; }
  djPickRound(function(picked){
    if(picked) djMakeImage(picked, mode);
  });
}

function djMakeImage(last, mode){
  var p = last.params || {};
  var showDur = p.showDur !== false;
  var showTotal = p.showTotal !== false;

  var songs = last.songs || [];
  var totSec = 0;
  songs.forEach(function(s){ totSec += Number(s.duration) || 0; });

  var badges = ['本期 ' + songs.length + ' 首'];
  if(showTotal && totSec) badges.push('总时长 ' + voFmtDur(totSec));

  var rows = songs.map(function(s, i){
    var left = (i + 1) + '. ' + (s.title || '?') + ' - ' + (s.artist || '未知')
      + ' - ' + (s.requester || '匿名');
    var right = '点赞 ' + (s.votes || 0);
    if(showDur && s.duration) right += ' · ' + voFmtDur(s.duration);
    return { l: left, r: right };
  });

  var sections = [];
  var rule = djParamsLine(last, songs.length);
  if(rule) sections.push({ heading: '抽签规则', lines: [rule] });
  sections.push({ heading: '本期歌单', rows: rows });

  var notes = [];
  if(last.note) notes.push(String(last.note));
  var ne = $('djCopyNote');
  var note = ne ? String(ne.value || '').trim() : '';
  if(note) notes.push(note);
  if(notes.length) sections.push({ heading: '备注', lines: notes });

  var card = {
    title: '点歌抽签排期公示',
    subtitle: '25级05班 · ' + (last.at || ''),
    badges: badges,
    sections: sections,
    footer: '由 25级05班 班级服务站生成 · 累计已排期 ' + djScheduleCount() + ' 首',
    badge: (typeof adminBadgeList === 'function') ? adminBadgeList() : adminBadgeUrl(),
  };
  var fname = '点歌排期-' + String(last.at || '').replace(/[^0-9]/g, '').slice(0, 12) + '.png';

  if(mode === 'share'){
    ShareCard.share(card, fname).then(function(r){
      if(r && r.shared) toast('已唤起系统分享', 'ok');
      else if(r && r.canceled) { /* 用户自己取消，不打扰 */ }
      else toast('这个浏览器不支持直接分享，已保存到下载', 'ok');
    }).catch(function(e){ toast('分享失败：' + (e.message || e), 'err'); });
  } else {
    ShareCard.download(card, fname)
      .then(function(){ toast('图片已生成，请在相册或下载目录查看', 'ok'); })
      .catch(function(e){ toast('生成失败：' + (e.message || e), 'err'); });
  }
}

function djFallbackCopy(text){
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand('copy'); }catch(e){}
  document.body.removeChild(ta);
}

/* ============================================================================
 * ⑬ 面板：版本更新记录（第二十八轮）
 * ----------------------------------------------------------------------------
 * 站主需求：「后台新增一个板块，用于记录每个版本更新、修复的问题，
 *           有点像 GitHub 上的 release。」
 *
 * 【只有后台能看】前台不展示 —— 这是站主明确的要求（CONTENT_MAP 里
 *   release_notes 的值是 null，主站不消费它）。
 *
 * 【为什么要放云端而不是后台本地】
 *   版本记录是「站长资产」：换电脑、重装浏览器都不该丢。
 *   同时它天然就是「这个站怎么长起来的」的历史档案，值得跟内容一起云备份。
 *
 * 【权限】
 *   走 /api/content PUT，后端只放行 admin / AI 助手，天然受保护。
 * ========================================================================= */

var REL_STATE = { list: [], editing: null };

/* 版本条目类型 → 展示标签 / 颜色（badge 样式复用后台已有的 badge-*） */
var REL_TYPES = {
  feature:  { label: '新功能', cls: 'badge-green' },
  fix:      { label: '问题修复', cls: 'badge-blue' },
  improve:  { label: '体验优化', cls: 'badge-gray' },
  security: { label: '安全', cls: 'badge' },
};
function relTypeOf(t){
  return REL_TYPES[t] || { label: t || '其他', cls: 'badge-gray' };
}

/* ============================================================================
 * v3.6.1（站主 #4）：数据管理 —— 备份 / 回档
 * ----------------------------------------------------------------------------
 * 站主原话：「后台新增数据管理，以后每次更新都先自动备份所有数据
 *            （通过检测在部署前先备份后部署）……默认存储最近 14 个版本更新，
 *            方便有问题随时回档」
 *
 * 这个面板只做三件事：看有哪些备份、手动备份一次、从某一份回档。
 * 自动备份发生在「部署前」（见仓库脚本 predeploy.mjs），不依赖这个页面。
 * ========================================================================= */
var BK_STATE = { list: [], count: 0, totalBytes: 0, keep: 14, busy: false };

/* ============================================================================
 * v3.9.3（站主）：班级岛后台
 * ----------------------------------------------------------------------------
 * 站主原话：
 *   「班级岛不要那么多功能了，第二行的课程表改为课表信息显示，类似一个横幅，
 *     我在后台可以编辑横幅内容……比如说星期一写哪个课表，星期二哪个课表，
 *     然后星期六和星期天都默认都是有课的，如果当天没课的话，我会在后台提前修改。」
 *   「寒暑假我就在后台设置开始时间和截止时间，在这时间内不显示课表，显示已放假
 *     多少天、距开学还有多少天。」
 *   「有些考试是不上课的，我就在后台编辑今日事项，比如数学，几点到几点。」
 *
 * 三块：① 周一到周日的默认横幅文案
 *       ② 按具体日期临时改（周五就能把周六周日写掉）
 *       ③ 假期区间（名称 + 起止），期间横幅自动变倒计时
 * ========================================================================= */
var AI = null;
var AI_DRAG = null;

var AI_COMPS = [
  { k: 'time', n: '时间', d: '当前时分，每 30 秒自己走' },
  { k: 'weather', n: '天气', d: '修水县实时温度与天气' },
  { k: 'week', n: '周数', d: '按开学日期算第几周' },
  { k: 'term', n: '学期名称', d: '例如 高二上' }
];

var AI_DAYS = [
  ['mon', '周一'], ['tue', '周二'], ['wed', '周三'], ['thu', '周四'],
  ['fri', '周五'], ['sat', '周六'], ['sun', '周日']
];

function renderIsland(){
  $('view').innerHTML = '<div class="loading"><div class="spinner"></div>加载中…</div>';
  api('/island').then(function(j){
    AI = (j && j.data) || {};
    AI.banner = AI.banner || {};
    AI.days = AI.days || {};
    AI.holidays = AI.holidays || [];
    paintIsland();
  }).catch(function(e){
    $('view').innerHTML = '<div class="alert danger" style="margin:16px">加载失败：' + esc(e.message) + '</div>';
  });
}

function paintIsland(){
  $('view').innerHTML =
    '<div class="toolbar" style="background:var(--panel)">'
    +   '<div style="flex:1;min-width:0">'
    +     '<b style="font-size:.92rem">班级岛</b>'
    +     '<p class="muted" style="margin:4px 0 0;font-size:.8rem">'
    +       '首页公告上面那条。<b>改动实时保存</b>，无需再点击保存；成员刷新后即生效</p>'
    +   '</div>'
    +   '<span class="ai-save-state" id="aiStage">已同步</span>'
    +   '<button class="btn btn-sm btn-secondary" id="aiReload">重新读取</button>'
    + '</div>'

    + '<section class="panel ai-sec">'
    +   '<div class="panel-head"><div><h3>基本</h3></div></div>'
    +   '<div class="panel-body">'
    +     '<label class="ai-check"><input type="checkbox" id="aiOn"' + (AI.on !== false ? ' checked' : '') + '> 在首页显示班级岛</label>'
    +     '<div class="bd-grid2" style="margin-top:10px">'
    +       '<div class="field"><label>学期名称</label>'
    +         '<input class="gate-input" id="aiTerm" maxlength="30" value="' + attr(AI.term || '') + '" placeholder="2026 年秋季 · 高二上"></div>'
    +       '<div class="field"><label>开学那一周的周一（算周数用）</label>'
    +         '<input class="gate-input" id="aiStart" type="date" value="' + attr(AI.startDate || '') + '"></div>'
    +     '</div>'
    +   '</div>'
    + '</section>'

    + '<section class="panel ai-sec">'
    +   '<div class="panel-head"><div><h3>今日事项照片</h3>'
    +     '<p class="sub">同学点首页「今日事项」那一行会弹出这张图，可放大缩小；留空则点击不弹图</p></div></div>'
    +   '<div class="panel-body">'
    +     '<input class="gate-input" id="aiPhoto" maxlength="500" placeholder="粘贴图片直链，或写仓库相对路径 ./photo.jpg">'
    +     '<div class="ai-photo-row">'
    +       '<img id="aiPhotoPrev" alt="预览" style="display:none">'
    +       '<p class="muted" style="font-size:.74rem;margin:8px 0 0">'
    +         '直链（图床 / 云盘外链）最稳；用仓库里的图就写 <b>./文件名.jpg</b>（和 index.html 放同一层）。'
    +         '填好会自动预览，有效才会显示缩略图</p>'
    +     '</div>'
    +   '</div>'
    + '</section>'

    + '<section class="panel ai-sec">'
    +   '<div class="panel-head"><div><h3>显示哪些组件</h3>'
    +     '<p class="sub">拖动卡片排序；✕ 摘掉、下面 ＋ 加回来。横幅固定在第二行</p></div></div>'
    +   '<div class="panel-body">'
    +     '<div id="aiComps"></div>'
    +     '<div id="aiRest" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"></div>'
    +   '</div>'
    + '</section>'

    + '<section class="panel ai-sec">'
    +   '<div class="panel-head"><div><h3>今日事项横幅（按星期）</h3>'
    +     '<p class="sub">每天一句，写法随意：「升 数数语英化 物物体劳 听自语语」。'
    +       '周六周日默认也有课，放掉就清空或留「今天放假」</p></div></div>'
    +   '<div class="panel-body"><div id="aiBanner"></div></div>'
    + '</section>'

    + '<section class="panel ai-sec">'
    +   '<div class="panel-head"><div><h3>按日期临时改（提前改某一天）</h3>'
    +     '<p class="sub">只影响那一天：考试、调课、临时放假都写这里。<b>支持换行</b>，'
    +       '可单独设<b>加粗</b>（让考试更醒目）和是否<b>居中</b>；点已有条目可再次修改</p></div></div>'
    +   '<div class="panel-body">'
    +     '<div id="aiDayList"></div>'
    +     '<div class="ai-dform">'
    +       '<input class="gate-input" type="date" id="adDate">'
    +       '<button class="btn btn-sm btn-secondary" id="adFill" type="button">填入当天课表</button>'
    +       '<label class="ai-check" style="margin:0"><input type="checkbox" id="adOff"> 不上课</label>'
    +       '<label class="ai-check" style="margin:0"><input type="checkbox" id="adBold" checked> 加粗</label>'
    +       '<label class="ai-check" style="margin:0"><input type="checkbox" id="adCenter" checked> 居中</label>'
    +       '<label class="ai-check" style="margin:0;gap:4px">字号'
    +         '<select id="adSize" class="ai-size">'
    +           '<option value="0">默认</option>'
    +           '<option value="14">14</option><option value="16">16</option>'
    +           '<option value="18">18</option><option value="20">20</option>'
    +           '<option value="22">22</option><option value="24">24</option>'
    +           '<option value="26">26</option><option value="28">28</option>'
    +         '</select>px</label>'
    +       '<button class="btn btn-sm" id="adAdd">添加</button>'
    +     '</div>'
    +     '<p class="muted ai-chhint">直接在这块里写，看到的就是首页的样子。'
    +       '选中文字后点 B / S / 字号；再点一次就取消。想在句子里插字，光标点进去直接打。</p>'
    +     '<div class="ai-rt" id="adRich" contenteditable="true" role="textbox" aria-multiline="true"'
    +       ' data-ph="这一天的安排（可多行），如：数学 08:00-09:30"></div>'
    +     '<textarea id="adText" style="display:none" aria-hidden="true" tabindex="-1"></textarea>'
    +     '<div class="ai-charbar">'
    +       '<button type="button" class="ai-fmt ai-fmt-b" data-rt="b" title="加粗选中的字">B</button>'
    +       '<button type="button" class="ai-fmt" data-rt="s" title="给选中的字加横线">S</button>'
    +       '<select id="adChSize" class="ai-size" title="选中的字多大">'
    +         '<option value="0">字号·默认</option>'
    +         '<option value="4">4px</option><option value="6">6px</option>'
    +         '<option value="8">8px</option><option value="10">10px</option>'
    +         '<option value="12">12px</option><option value="14">14px</option>'
    +         '<option value="16">16px</option><option value="18">18px</option>'
    +         '<option value="20">20px</option><option value="22">22px</option>'
    +         '<option value="24">24px</option><option value="26">26px</option>'
    +         '<option value="28">28px</option><option value="32">32px</option>'
    +       '</select>'
    +       '<button type="button" class="ai-fmt" data-rt="h" title="整行加底色">整行强调</button>'
    +       '<button type="button" class="ai-fmt" data-rt="clear" title="去掉选中的格式">清格式</button>'
    +       '<span class="muted ai-chtip" id="adChTip">选中文字后点击左侧按钮</span>'
    +     '</div>'
    +     '<p class="muted" style="font-size:.72rem;margin:8px 0 4px">预览（就是首页看到的效果）：</p>'
    +     '<div class="ai-dprev"><div class="ai-dprev-txt" id="adPrev"></div></div>'
    +   '</div>'
    + '</section>'

    + '<section class="panel ai-sec">'
    +   '<div class="panel-head"><div><h3>假期（寒假 / 暑假 / 小长假）</h3>'
    +     '<p class="sub">这段时间内横幅显示「已放假 N 天 · 距开学还有 M 天」，不再显示课表</p></div></div>'
    +   '<div class="panel-body">'
    +     '<div id="aiHolList"></div>'
    +     '<div class="ai-dform">'
    +       '<input class="gate-input" id="ahLabel" maxlength="16" placeholder="名称，如 寒假">'
    +       '<input class="gate-input" type="date" id="ahFrom">'
    +       '<input class="gate-input" type="date" id="ahTo">'
    +       '<button class="btn btn-sm" id="ahAdd">添加</button>'
    +     '</div>'
    +   '</div>'
    + '</section>';

  $('aiReload').onclick = renderIsland;
  $('adAdd').onclick = aiAddDay;
  $('adFill').onclick = aiFillDay;
  $('ahAdd').onclick = aiAddHoliday;
  if($('adRich')){
    $('adRich').addEventListener('keydown', function(e){
      if((e.ctrlKey || e.metaKey) && e.key === 'Enter'){ e.preventDefault(); aiAddDay(); }
    });
  }
  $('adBold').onchange = aiDayPreview;
  $('adCenter').onchange = aiDayPreview;
  if($('adSize')) $('adSize').onchange = aiDayPreview;
  document.querySelectorAll('[data-rt]').forEach(function(b){
    b.onclick = function(){ aiRtFmt(b.getAttribute('data-rt')); };
  });
  if($('adChSize')){
    $('adChSize').onchange = function(){
      aiRtFmt('size', this.value);
      this.value = '0';
      aiRtTip();
    };
  }
  aiRtInit();

  /* 基本项：改完立刻存 */
  $('aiOn').onchange = aiTouch;
  $('aiTerm').oninput = aiTouch;
  $('aiStart').onchange = aiTouch;

  /* 照片：输入即存 + 实时预览（有效地址才显示缩略图） */
  var ph = $('aiPhoto');
  if(ph){
    ph.value = AI.photo || '';
    ph.oninput = function(){
      AI.photo = String(ph.value || '').trim().slice(0, 500);
      aiPhotoPreview();
      aiTouch();
    };
    aiPhotoPreview();
  }

  paintComps();
  paintBanner();
  paintDayList();
  paintHols();
  aiDayPreview();
}

/* ============================================================================
 * v3.9.7（站主）：实时保存
 * ----------------------------------------------------------------------------
 * 站主原话：「太繁琐了……我要更新内容，先要在下面更新这个表，然后点击添加之后
 *            又在上面点保存，如果忘了一步，我重新看的时候就全部都没了。
 *            那就实时更新，就跟我录那个数据一样，不要再加这么多保存让我搞了」。
 *
 * 做法：任何一处改动（开关 / 学期 / 照片 / 横幅 / 组件 / 日期 / 假期）都调用
 *       aiTouch()，650ms 内没有新动作就自动 POST；顶部只显示状态，不再有保存按钮。
 *       保存失败会变成「保存失败，点此重试」，点击重发。
 * ========================================================================= */
var AI_T = null, AI_BUSY = false, AI_AGAIN = false;
function aiStage(txt, cls){
  var el = $('aiStage');
  if(!el) return;
  el.textContent = txt;
  el.className = 'ai-save-state' + (cls ? ' ' + cls : '');
  el.onclick = (cls === 'err') ? aiFlush : null;
}
function aiTouch(){
  aiStage('保存中…', 'saving');
  clearTimeout(AI_T);
  AI_T = setTimeout(aiFlush, 650);
}
function aiCollect(){
  var on = $('aiOn'), term = $('aiTerm'), st = $('aiStart'), ph = $('aiPhoto');
  AI.on = !!(on && on.checked);
  AI.term = String((term && term.value) || '').trim();
  AI.startDate = String((st && st.value) || '').trim();
  AI.photo = String((ph && ph.value) || '').trim().slice(0, 500);
  Array.prototype.forEach.call(document.querySelectorAll('#aiBanner [data-bk]'), function(el){
    AI.banner[el.getAttribute('data-bk')] = String(el.value || '').trim().slice(0, 60);
  });
  return {
    on: AI.on,
    term: AI.term,
    startDate: AI.startDate,
    components: (AI.components || []).slice(),
    banner: AI.banner,
    days: AI.days,
    holidays: AI.holidays,
    photo: AI.photo,
  };
}
function aiFlush(){
  clearTimeout(AI_T);
  if(AI_BUSY){ AI_AGAIN = true; return; }
  AI_BUSY = true;
  AI_AGAIN = false;
  var data = aiCollect();
  api('/island', { method: 'POST', body: { data: data } }).then(function(j){
    AI_BUSY = false;
    if(j && j.data) AI = j.data;
    var t = new Date();
    aiStage('已自动保存 ' + ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2), 'ok');
    if(AI_AGAIN) aiFlush();
  }).catch(function(e){
    AI_BUSY = false;
    aiStage('保存失败，点此重试', 'err');
    try{ console.warn('[island save]', e && e.message); }catch(err){}
  });
}
/* 离开页面前把没来得及发的改动补发掉（keepalive 保证请求不被中断） */
function aiFlushBeacon(){
  if(!AI_T && !AI_BUSY) return;
  try{
    var body = JSON.stringify({ data: aiCollect() });
    fetch(API_BASE + '/api/island', {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + STATE.token },
      body: body,
    }).catch(function(){});
  }catch(e){}
}
try{ window.addEventListener('pagehide', aiFlushBeacon); }catch(e){}

/* ---------- 组件 ---------- */
function paintComps(){
  var used = (AI.components || []).slice();
  var box = $('aiComps');
  box.innerHTML = used.map(function(k, i){
    var info = null;
    for(var j = 0; j < AI_COMPS.length; j++){ if(AI_COMPS[j].k === k) info = AI_COMPS[j]; }
    return '<div class="ai-comp" draggable="true" data-c="' + k + '" data-i="' + i + '">'
      + '<span class="grip">⋮⋮</span>'
      + '<span class="nm">' + esc((info && info.n) || k) + '</span>'
      + '<span class="muted" style="font-size:.7rem">' + esc((info && info.d) || '') + '</span>'

      + '<button type="button" class="ai-x" data-off="' + k + '" title="摘掉">✕</button>'
      + '</div>';
  }).join('');

  var rest = AI_COMPS.filter(function(x){ return used.indexOf(x.k) < 0; });
  $('aiRest').innerHTML = rest.length
    ? rest.map(function(x){
        return '<button type="button" class="ai-add" data-add="' + x.k + '">＋ ' + esc(x.n) + '</button>';
      }).join('')
    : '<span class="muted" style="font-size:.74rem">四个组件都在用</span>';

  box.onclick = function(e){
    var k = e.target.getAttribute && e.target.getAttribute('data-off');
    if(!k) return;
    AI.components = (AI.components || []).filter(function(x){ return x !== k; });
    paintComps(); aiTouch();
  };
  $('aiRest').onclick = function(e){
    var k = e.target.getAttribute && e.target.getAttribute('data-add');
    if(!k) return;
    AI.components = (AI.components || []).concat([k]);
    paintComps(); aiTouch();
  };

  /* 拖拽排序 */
  Array.prototype.forEach.call(box.querySelectorAll('.ai-comp'), function(el){
    el.addEventListener('dragstart', function(e){
      AI_DRAG = Number(el.getAttribute('data-i'));
      try{ e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'x'); }catch(err){}
    });
    el.addEventListener('dragover', function(e){ e.preventDefault(); el.classList.add('drag-over'); });
    el.addEventListener('dragleave', function(){ el.classList.remove('drag-over'); });
    el.addEventListener('drop', function(e){
      e.preventDefault(); el.classList.remove('drag-over');
      var to = Number(el.getAttribute('data-i'));
      if(AI_DRAG == null || AI_DRAG === to) return;
      var arr = (AI.components || []).slice();
      var moved = arr.splice(AI_DRAG, 1)[0];
      arr.splice(to, 0, moved);
      AI.components = arr;
      AI_DRAG = null;
      paintComps(); aiTouch();
    });
  });
}

/* ---------- 横幅（默认课表：一行就够） ---------- */
function paintBanner(){
  var host = $('aiBanner');
  /* v3.9.6（站主）：星期横幅 = 默认课表，收回单行输入；
     要多行请用「按日期临时改」那一块（考试时段 / 备注）。 */
  host.innerHTML = AI_DAYS.map(function(d){
    return '<div class="ai-brow">'
      + '<span class="d">' + d[1] + '</span>'
      + '<input data-bk="' + d[0] + '" maxlength="60" value="' + attr(AI.banner[d[0]] || '') + '"'
      +   ' placeholder="默认课表，如 升 数数语英化 物物体劳 听自语语">'
      + '</div>';
  }).join('');
  host.oninput = function(e){
    var k = e.target.getAttribute && e.target.getAttribute('data-bk');
    if(!k) return;
    AI.banner[k] = String(e.target.value || '').slice(0, 60);
    aiTouch();
  };
}

/* ---------- 按日期覆盖（可再次编辑 / 复用） ---------- */
var AI_DAY_EDIT = null;   /* 正在编辑的日期；null = 新增 */
function paintDayList(){
  var keys = Object.keys(AI.days || {}).sort();
  var host = $('aiDayList');
  if(!keys.length){
    host.innerHTML = '<p class="muted" style="font-size:.8rem;margin:0 0 8px">尚未单独设置日期。点上面「填入当天课表」可以基于当天默认课表改一两个字。</p>';
    return;
  }
  host.innerHTML = keys.map(function(k){
    var v = AI.days[k] || {};
    var one = aiStrip(v.label || v.text || '').replace(/\n/g, ' / ');
    return '<div class="ai-ovitem ai-ovclick' + (AI_DAY_EDIT === k ? ' on' : '') + '" data-dayedit="' + attr(k) + '">'
      + '<span class="ai-ovtag ' + (v.off ? 'off' : 'plan') + '">' + (v.off ? '不上课' : '改文案') + '</span>'
      + '<b>' + esc(k.slice(5)) + '</b>'
      + (v.bold ? '<span class="ai-ovflag">粗</span>' : '')
      + (v.center === false ? '<span class="ai-ovflag">左</span>' : '')
      + (v.size ? '<span class="ai-ovflag">' + v.size + 'px</span>' : '')
      + '<span class="muted">' + esc(one) + '</span>'
      + '<button type="button" data-daydel="' + attr(k) + '" title="删除">✕</button>'
      + '</div>';
  }).join('');
  host.onclick = function(e){
    var del = e.target.getAttribute && e.target.getAttribute('data-daydel');
    if(del){
      delete AI.days[del];
      if(AI_DAY_EDIT === del) aiCancelDay();
      paintDayList();
      aiTouch();
      return;
    }
    var ed = e.target.closest && e.target.closest('[data-dayedit]');
    if(ed) aiEditDay(ed.getAttribute('data-dayedit'));
  };
}

/* 后台文本框实时套用「加粗 / 居中」，下方再给一份和首页一样的预览 */
function aiInline(sz, fl, txt){
  if(!sz && !fl) return txt;
  var st = '';
  if(sz) st += 'font-size:' + sz + 'px;';
  if(fl.indexOf('b') >= 0) st += 'font-weight:900;';
  if(fl.indexOf('s') >= 0) st += 'text-decoration:line-through;';
  return st ? '<span style="' + st + '">' + txt + '</span>' : txt;
}
function aiPrevFmt(text){
  return String(text == null ? '' : text).split('\n').map(function(line){
    var head = false, t = line;
    if(/^#\s?/.test(t)){ head = true; t = t.replace(/^#\s?/, ''); }
    var h = esc(t);
    h = h.replace(/\{(\d{0,2})([bs]{0,2})([^{}]+)\}/g, function(all, sz, fl, txt){
      if(!sz && !fl) return all;
      return aiInline(sz, fl, txt);
    });
    h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    h = h.replace(/~~([^~]+)~~/g, '<s>$1</s>');
    return head ? '<span class="ln-em">' + h + '</span>' : h;
  }).join('\n');
}
