/* ============================================================
   字段校验规则（v3.5.5 · 2026-10-17 第七十九轮后）
   ------------------------------------------------------------
   站主原话：「所有字段支持管理员自定义配置校验规则」——
   文本（最大/最小字符数）、数字（固定位数/数值范围/仅允许数字）、
   时间（选择器录入/可限区间）、下拉单选多选（后台自定义选项）。

   规则存在 profile_field_meta.rules（jsonb），形如：
     { type:'text',   minLen:2, maxLen:3 }
     { type:'number', digits:11 }              // 固定位数（仅数字）
     { type:'number', min:0, max:100 }         // 数值范围（仅数字）
     { type:'time',   min:'2024-01-01', max:'2026-12-31' }          // 默认精确到日
     { type:'time',   precision:'month', min:'2024-01', max:'2026-12' }  // 只要年月
     { type:'time',   precision:'year' }                              // 只要年份
     { type:'select', options:['群众','共青团员'], multi:false }
     {}                                        // 无规则：按短文本放过

   ⚠️ 三条纪律：
     ① 服务端是唯一裁判。前端选择器只是「让正确输入更容易」，
        批量导入 / 直接调 API 都能绕过 UI，必须在服务端复核。
     ② 空值一律放过（'' / null）—— 规则约束「填了的时候」长什么样，
        不强制必填。必填是另一件事，本系统没有必填字段。
     ③ 规则形状永远先过 normalizeRules 再进库 / 再用，防止脏数据
        （如 options 里混进非字符串、digits 是负数）把校验器搞挂。
   ============================================================ */

/** 把任意输入收敛成合法规则对象（脏数据 → 最接近的合法形态）。
 *  ⚠️ 入参可能是三种形态：对象（PG jsonb 驱动直接给对象）、JSON 文本
 *     （SQLite 测试桩 / 个别驱动把 jsonb 当文本返回）、null/垃圾值。
 *     字符串一律先 JSON.parse（最多剥两层，防双重编码），解析失败当无规则。 */
export function normalizeRules(raw) {
  let src = raw;
  for (let i = 0; i < 2 && typeof src === 'string'; i++) {
    try { src = JSON.parse(src); } catch (e) { src = null; break; }
  }
  const r = (src && typeof src === 'object' && !Array.isArray(src)) ? src : {};
  const type = ['text', 'number', 'time', 'select'].includes(r.type) ? r.type : '';
  const out = {};
  if (!type) return out;   /* 无类型 = 无规则 */

  if (type === 'text') {
    const minLen = numOr(r.minLen, 0, 0, 200);
    const maxLen = numOr(r.maxLen, 0, 0, 500);
    if (minLen) out.minLen = minLen;
    if (maxLen) out.maxLen = maxLen;
    out.type = 'text';
    return out;
  }

  if (type === 'number') {
    out.type = 'number';
    const digits = numOr(r.digits, 0, 1, 12);
    if (digits) out.digits = digits;
    /* min/max 与 digits 互斥表达：digits 管长度，min/max 管大小。
       两者都给了也行（先查位数再查范围），但不强制。 */
    if (r.min != null && r.min !== '' && isFinite(Number(r.min))) out.min = Number(r.min);
    if (r.max != null && r.max !== '' && isFinite(Number(r.max))) out.max = Number(r.max);
    if (out.digits == null && out.min == null && out.max == null) out.digits = 0;
    return out;
  }

  if (type === 'time') {
    out.type = 'time';
    /* v3.5.15：精确到「日 / 月 / 年」。站主原话：「入团时间是精确到月份，
       没有具体日期，我表格里写 2024-05 可是就显示无法导入」——
       以前 time 规则死认 YYYY-MM-DD，年月日以外的写法一律判非法。 */
    const precision = ['day', 'month', 'year'].includes(r.precision) ? r.precision : 'day';
    out.precision = precision;
    const min = boundStr(r.min, precision), max = boundStr(r.max, precision);
    if (min) out.min = min;
    if (max) out.max = max;
    return out;
  }

  /* select：选项列表去空白、去重复、保序；最多 50 个 */
  const opts = [];
  const seen = new Set();
  for (const o of (Array.isArray(r.options) ? r.options : [])) {
    const s = String(o == null ? '' : o).trim().slice(0, 40);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    opts.push(s);
    if (opts.length >= 50) break;
  }
  out.type = 'select';
  out.options = opts;
  out.multi = !!r.multi;
  return out;
}

function numOr(v, dflt, lo, hi) {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/** 把常见的手写日期写法收敛成 YYYY-MM-DD / YYYY-MM / YYYY（失败返回 ''）。
    认：2024-05-13 / 2024-5-3 / 2024/5/3 / 2024.5.3 / 2024年5月3日 / 2024-05 / 2024年5月 / 2024
    不认：13/05/2024、五月、2024-13（月份越界）等无法无歧义解析的写法。 */
export function normTimeInput(v) {
  let s = String(v == null ? '' : v).trim();
  if (!s) return '';
  /* Excel 有时把日期读成 Date 序列号（45000 这种）—— 交给上层前先挡掉：
     纯 5 位数字且像序列号的，按 1899-12-30 起算换算。 */
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 20000 && n < 80000) {
      const dt = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
      const y = dt.getUTCFullYear(), mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const d = String(dt.getUTCDate()).padStart(2, '0');
      return y + '-' + mo + '-' + d;
    }
  }
  /* 剥掉时间部分：2024-05-13 00:00:00 / 2024-05-13T00:00:00.000Z
     （Excel 单元格是日期型时，前端 sheet_to_json 会带出这种串） */
  s = s.replace(/[T\s]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i, '');
  s = s.replace(/[年\/\.．]/g, '-').replace(/月/g, '-').replace(/日/g, '')
       .replace(/\s+/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  let m = s.match(/^(\d{4})$/);
  if (m) return m[1];
  m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) {
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return '';
    return m[1] + '-' + String(mo).padStart(2, '0');
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const mo = Number(m[2]), dd = Number(m[3]);
    if (mo < 1 || mo > 12 || dd < 1 || dd > 31) return '';
    return m[1] + '-' + String(mo).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
  }
  return '';
}

/** 按精度截断：日 → YYYY-MM-DD，月 → YYYY-MM，年 → YYYY */
function clipPrecision(s, precision) {
  if (!s) return '';
  if (precision === 'year') return s.slice(0, 4);
  if (precision === 'month') return s.slice(0, 7);
  return s;
}

/** 区间边界值：按精度归一 + 截断；解析不了当没填 */
function boundStr(v, precision) {
  const n = normTimeInput(v);
  return n ? clipPrecision(n, precision) : '';
}

/** 精度对应的示例写法（报错文案用） */
function timeHint(precision) {
  if (precision === 'year') return '四位年份，如 2024';
  if (precision === 'month') return '年月，如 2024-05';
  return '具体日期，如 2024-05-13';
}

/** 真日期校验（只对完整到日的值有意义） */
function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = new Date(s + 'T00:00:00Z');
  return !isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s;
}

/** 规则的一句话人话描述（后台字段列表 / 报错文案用） */
export function describeRules(rules) {
  const r = normalizeRules(rules);
  if (!r.type) return '';
  if (r.type === 'text') {
    if (r.minLen && r.maxLen) return '文本 ' + r.minLen + '–' + r.maxLen + ' 字符';
    if (r.maxLen) return '文本最多 ' + r.maxLen + ' 字符';
    if (r.minLen) return '文本至少 ' + r.minLen + ' 字符';
    return '文本';
  }
  if (r.type === 'number') {
    if (r.digits) return '数字固定 ' + r.digits + ' 位';
    if (r.min != null && r.max != null) return '数字 ' + r.min + '–' + r.max;
    if (r.min != null) return '数字 ≥ ' + r.min;
    if (r.max != null) return '数字 ≤ ' + r.max;
    return '数字';
  }
  if (r.type === 'time') {
    const p = r.precision || 'day';
    const base = p === 'year' ? '年份' : p === 'month' ? '年月' : '日期';
    const fmt = p === 'year' ? 'YYYY' : p === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';
    if (r.min && r.max) return base + ' ' + fmt + '，' + r.min + ' ~ ' + r.max;
    if (r.min) return base + ' ' + fmt + '，不早于 ' + r.min;
    if (r.max) return base + ' ' + fmt + '，不晚于 ' + r.max;
    return base + '（' + fmt + '）';
  }
  if (r.type === 'select') {
    return (r.multi ? '多选' : '单选') + '：' + r.options.join(' / ');
  }
  return '';
}

/**
 * 按规则把值规整成「入库形态」（目前只有时间精度用到）。
 * 例：规则 precision='month'，填 2024/5/13 → 存 2024-05；2024年5月 → 2024-05。
 * 解析不了 / 非时间规则 → 原样返回（校验器会另行报错）。
 */
export function coerceValueByRules(rules, value) {
  const r = normalizeRules(rules);
  if (r.type !== 'time' || value == null) return value;
  const s = String(value).trim();
  if (!s) return value;
  const n = normTimeInput(s);
  return n ? clipPrecision(n, r.precision || 'day') : value;
}

/**
 * 按规则校验一个值。
 * @returns {{ok:true} | {ok:false, error:string}}
 */
export function validateByRules(rules, value, label) {
  const r = normalizeRules(rules);
  const name = label || '该字段';
  /* 空值放过（纪律②） */
  if (value == null) return { ok: true };
  const v = String(value).trim();
  if (!v) return { ok: true };

  if (r.type === 'text') {
    const n = [...v].length;   /* 按字符数（中文一字算一），不按字节 */
    if (r.minLen && n < r.minLen) {
      return { ok: false, error: name + '至少 ' + r.minLen + ' 个字符（当前 ' + n + ' 个）' };
    }
    if (r.maxLen && n > r.maxLen) {
      return { ok: false, error: name + '最多 ' + r.maxLen + ' 个字符（当前 ' + n + ' 个）' };
    }
    return { ok: true };
  }

  if (r.type === 'number') {
    if (!/^\d+$/.test(v)) {
      return { ok: false, error: name + '只能填数字' };
    }
    if (r.digits && v.length !== r.digits) {
      return { ok: false, error: name + '必须是 ' + r.digits + ' 位数字（当前 ' + v.length + ' 位）' };
    }
    const n = Number(v);
    if (r.min != null && n < r.min) return { ok: false, error: name + '不能小于 ' + r.min };
    if (r.max != null && n > r.max) return { ok: false, error: name + '不能大于 ' + r.max };
    return { ok: true };
  }

  if (r.type === 'time') {
    /* v3.5.15：按后台配的精度校验 —— 精确到月时「2024-05」就是合法值。
       同时容忍常见手写：2024/5、2024年5月、2024.5，以及 Excel 的日期序列号。 */
    const p = r.precision || 'day';
    const norm = normTimeInput(v);
    if (!norm) {
      return { ok: false, error: name + '日期写法看不懂（应为' + timeHint(p) + '），你填的是「' + v + '」' };
    }
    if (p === 'day' && norm.length < 10) {
      return { ok: false, error: name + '要精确到日（' + timeHint(p) + '），你填的是「' + v + '」' };
    }
    if (p === 'month' && norm.length < 7) {
      return { ok: false, error: name + '要精确到月（' + timeHint(p) + '），你填的是「' + v + '」' };
    }
    if (norm.length === 10 && !isRealDate(norm)) {
      return { ok: false, error: name + '不是有效的日期：' + norm };
    }
    const cv = clipPrecision(norm, p);
    if (r.min && cv < r.min) return { ok: false, error: name + '不能早于 ' + r.min + '（你填的是 ' + cv + '）' };
    if (r.max && cv > r.max) return { ok: false, error: name + '不能晚于 ' + r.max + '（你填的是 ' + cv + '）' };
    return { ok: true };
  }

  if (r.type === 'select') {
    if (!r.options.length) return { ok: true };   /* 没配选项 = 不约束 */
    if (r.multi) {
      const parts = v.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      const bad = parts.filter((p) => !r.options.includes(p));
      if (bad.length) {
        return { ok: false, error: name + '含没有的选项：' + bad.join('、') + '（可选：' + r.options.join('、') + '）' };
      }
      return { ok: true };
    }
    if (!r.options.includes(v)) {
      return { ok: false, error: name + '只能是：' + r.options.join('、') };
    }
    return { ok: true };
  }

  return { ok: true };
}
