/* ============================================================================
 * share-card.js —— 把一段结构化内容画成一张 PNG 长图（v3.5.40）
 * ----------------------------------------------------------------------------
 * 站主需求：
 *   #6「抽歌排期支持导出图片公示的内容，样式和功能仿照成绩分析的导出图片」
 *   #7「作业支持导出图片（包含名称、对应作业、时间范围、作业对应的图片直链等）
 *       也支持分享的功能」
 *
 * 为什么单独一个文件：主站 index.html 和后台 admin.html 都要用。
 * 复制两份代码必然会漂移（历史上「前台能看、后台不能」这类问题反复出现），
 * 所以抽成一个纯 canvas 的小工具，两边都引它。
 *
 * 设计原则（对齐成绩卡的既有做法）：
 *   · 不引第三方库（html2canvas 有 200KB+，还会因为跨域图片把 canvas 污染）
 *   · 尺寸先算后画：算高度与绘制共用同一套步长常量，避免多一片空白 / 少一截内容
 *   · 所有文字按设备像素比放大 2 倍，微信里放大看也不糊
 *   · 深色底不用纯黑，浅色底不用纯白 —— 与站点暖色调一致
 *
 * 用法：
 *   ShareCard.download({
 *     title: '点歌抽签排期公示',
 *     subtitle: '25级05班 · 2026-10-18',
 *     badges: ['本期 8 首', '总时长 32:10'],
 *     sections: [
 *       { heading: '本期歌单', rows: [ { l:'1. 晴天 - 周杰伦', r:'点赞 12' }, ... ] },
 *       { heading: '备注', lines: ['...'] }
 *     ],
 *     footer: '由 25级05班 班级服务站生成',
 *     badge: './favicon.svg'      // 班徽，画在右上角（取不到就不画，不影响导出）
 *   }, '文件名.png');
 * ========================================================================= */
(function (global) {
  'use strict';

  var STEP = {
    W: 760,            /* CSS 像素宽（实际画布 ×2） */
    PAD: 36,
    SCALE: 2,
    TITLE: 34,         /* 标题字号 */
    SUB: 16,
    BADGE_H: 30,
    BADGE_GAP: 10,
    HEAD: 17,          /* 分段标题 */
    ROW: 30,           /* 每行 */
    LINE: 24,          /* 纯文本行 */
    GAP_SECTION: 26,
    GAP_ROW: 6,
    FOOT: 46,
    BADGE: 66,          /* 班徽边长（右上角） */
    BADGE_GAP: 16,      /* 标题与班徽之间的留白 */
  };

  var COLORS = {
    bg: '#fffdfb',
    card: '#ffffff',
    ink: '#332d29',
    ink2: '#6e635a',
    ink3: '#9a8d82',
    line: '#efe4d9',
    accent: '#c2410c',
    accentSoft: '#fff1e6',
  };

  function font(size, weight) {
    return (weight || 400) + ' ' + size + 'px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif';
  }

  /* 按宽度折行（中文按字切，英文按词切，混合也能处理） */
  function wrap(ctx, text, maxW) {
    var out = [];
    String(text == null ? '' : text).split('\n').forEach(function (para) {
      if (!para) { out.push(''); return; }
      var buf = '';
      for (var i = 0; i < para.length; i++) {
        var ch = para.charAt(i);
        if (ctx.measureText(buf + ch).width > maxW && buf) {
          out.push(buf);
          buf = ch;
        } else {
          buf += ch;
        }
      }
      out.push(buf);
    });
    return out;
  }

  function normalize(opts) {
    var o = opts || {};
    var sections = [];
    (o.sections || []).forEach(function (s) {
      if (!s) return;
      var sec = { heading: s.heading || '', rows: [], lines: [] };
      (s.rows || []).forEach(function (r) {
        if (!r) return;
        if (r.l == null && r.left == null && r.right == null) return;
        sec.rows.push({ l: String(r.l != null ? r.l : (r.left || '')), r: String(r.r != null ? r.r : (r.right || '')) });
      });
      (s.lines || []).forEach(function (t) { if (t != null && String(t) !== '') sec.lines.push(String(t)); });
      if (sec.heading || sec.rows.length || sec.lines.length) sections.push(sec);
    });
    return {
      title: o.title || '分享',
      subtitle: o.subtitle || '',
      badges: (o.badges || []).map(String).filter(Boolean),
      sections: sections,
      footer: o.footer || '',
      width: o.width && o.width > 320 ? o.width : STEP.W,
      __badge: o.__badge || null,
    };
  }

  /* ---- 测量：先用一个离屏 ctx 算折行与高度 ---- */
  function measure(o) {
    var cv = document.createElement('canvas');
    var ctx = cv.getContext('2d');
    var innerW = o.width - STEP.PAD * 2;
    var h = STEP.PAD;

    ctx.font = font(STEP.TITLE, 700);
    var hasBadge = !!o.__badge;
    var titleW = hasBadge ? innerW - STEP.BADGE - STEP.BADGE_GAP : innerW;
    var titleLines = wrap(ctx, o.title, titleW);
    h += titleLines.length * (STEP.TITLE + 8);

    if (o.subtitle) {
      ctx.font = font(STEP.SUB);
      var subLines = wrap(ctx, o.subtitle, innerW);
      h += 6 + subLines.length * (STEP.SUB + 8);
    }

    var badgeH = 0;
    if (o.badges.length) {
      ctx.font = font(13, 600);
      /* 粗略按每个徽章一行排（宽度够就并排） */
      var linesW = 0, rows = 1;
      o.badges.forEach(function (b) {
        var w = ctx.measureText(b).width + 24 + STEP.BADGE_GAP;
        if (linesW + w > innerW) { rows++; linesW = w; } else { linesW += w; }
      });
      badgeH = rows * (STEP.BADGE_H + 8) + 8;
      h += badgeH;
    }

    var parts = [];
    o.sections.forEach(function (s) {
      var block = { heading: s.heading, rows: [], lines: [] };
      var bh = 0;
      if (s.heading) {
        ctx.font = font(STEP.HEAD, 700);
        bh += STEP.HEAD + 12;
      }
      ctx.font = font(14);
      s.rows.forEach(function (r) {
        var leftW = innerW - 150;
        var lh = wrap(ctx, r.l, leftW);
        var rh = r.r ? wrap(ctx, r.r, 140) : [''];
        var lines = Math.max(lh.length, rh.length);
        block.rows.push({ l: lh, r: rh, lines: lines });
        bh += lines * STEP.ROW + STEP.GAP_ROW;
      });
      s.lines.forEach(function (t) {
        ctx.font = font(14);
        var ls = wrap(ctx, t, innerW);
        block.lines.push({ lines: ls });
        bh += ls.length * STEP.LINE;
      });
      bh += STEP.GAP_SECTION;
      h += bh;
      parts.push(block);
    });

    if (o.footer) h += STEP.FOOT;
    h += STEP.PAD;

    return { height: Math.round(h), blocks: parts, titleLines: titleLines };
  }

  /* ---- 班徽（v3.5.42）----
     站主要求：所有导出图片右上角都带班徽。
     图片跨域时 canvas 会被污染（toBlob 直接抛 SecurityError），
     所以统一先试 crossOrigin='anonymous'，失败就当没有徽标 ——
     少一个角标总比整张图导不出来强。 */
  var badgeCache = {};

  /** 取不到真班徽时的兜底：绿色圆角块 + 班级号 */
  function fallbackBadge() {
    try {
      if (badgeCache.__fallback) return badgeCache.__fallback;
      var s = 132;
      var cv = document.createElement('canvas');
      cv.width = cv.height = s;
      var c = cv.getContext('2d');
      var g = c.createLinearGradient(0, 0, s, s);
      g.addColorStop(0, '#16a34a');
      g.addColorStop(1, '#0b6b35');
      c.fillStyle = g;
      c.fillRect(0, 0, s, s);
      c.fillStyle = 'rgba(255,255,255,.18)';
      c.beginPath(); c.arc(s * 0.78, s * 0.24, s * 0.34, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#fff';
      c.font = 'bold 58px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('05', s / 2, s / 2 + 3);
      var r = { ok: true, img: cv, fallback: true };
      badgeCache.__fallback = r;
      return r;
    } catch (e) { return null; }
  }

  /* v3.6.5：支持传数组 —— 按顺序试（先本地 badge.png，失败再走服务器代理）。
     大图（几 MB 的原始班徽）走代理要好几秒，先试本地小图能快很多。 */
  function loadBadge(urlOrList) {
    if (Array.isArray(urlOrList)) {
      var list = urlOrList.filter(Boolean);
      if (!list.length) return Promise.resolve(fallbackBadge());
      var i = 0;
      var tryNext = function () {
        if (i >= list.length) return Promise.resolve(fallbackBadge());
        var u = list[i++];
        return loadBadge(u).then(function (r) {
          if (r && r.img && !r.fallback) return r;
          return tryNext();
        });
      };
      return tryNext();
    }
    var url = urlOrList;
    if (!url) return Promise.resolve(null);
    if (Object.prototype.hasOwnProperty.call(badgeCache, url) && badgeCache[url] && badgeCache[url].img) {
      return Promise.resolve(badgeCache[url]);
    }
    return new Promise(function (resolve) {
      var img = new Image();
      var done = false;
      function fin(v) { if (!done) { done = true; badgeCache[url] = v; resolve(v); } }
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        badgeCache[url] = { ok: true, img: img };
        fin({ ok: true, img: img });
      };
      img.onerror = function () {
        /* 带 crossOrigin 失败时，再试一次不带（同源图片在某些内核上也会被拦） */
        var img2 = new Image();
        img2.onload = function () {
          try {
            /* 画一下空像素检测是否被污染 */
            var t = document.createElement('canvas');
            t.width = t.height = 1;
            t.getContext('2d').drawImage(img2, 0, 0, 1, 1);
            t.getContext('2d').getImageData(0, 0, 1, 1);
            fin({ ok: true, img: img2 });
          } catch (e) { fin(null); }
        };
        img2.onerror = function () { fin(fallbackBadge()); };
        img2.src = url;
      };
      img.src = url;
      /* 兜底：3 秒还没结果就不等了，别让用户以为按钮坏了。
         v3.6.3：图取不到时不再留空 —— 画一个同色系的简化徽标（班级号），
         总比右上角光秃秃强；真图同步上来后会自动换回真图。 */
      setTimeout(function () {
        if (!done) fin(fallbackBadge());
        /* 超时后图片仍可能加载完 —— 更新缓存，下次导出用真图 */
      }, 8000);
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** 画到 canvas 上并返回 canvas */
  function render(opts) {
    var o = normalize(opts);
    var m = measure(o);
    var cv = document.createElement('canvas');
    cv.width = Math.round(o.width * STEP.SCALE);
    cv.height = Math.round(m.height * STEP.SCALE);
    var ctx = cv.getContext('2d');
    ctx.scale(STEP.SCALE, STEP.SCALE);
    ctx.textBaseline = 'top';

    /* 背景 */
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, o.width, m.height);

    var x = STEP.PAD;
    var innerW = o.width - STEP.PAD * 2;
    var y = STEP.PAD;

    /* 标题 */
    /* 班徽：右上角，圆角裁切 */
    if (o.__badge && o.__badge.img) {
      try {
        ctx.save();
        roundRect(ctx, o.width - STEP.PAD - STEP.BADGE, STEP.PAD - 6, STEP.BADGE, STEP.BADGE, 16);
        ctx.clip();
        ctx.drawImage(o.__badge.img, o.width - STEP.PAD - STEP.BADGE, STEP.PAD - 6, STEP.BADGE, STEP.BADGE);
        ctx.restore();
        /* 细边框，浅色徽标也能看出边界 */
        ctx.strokeStyle = 'rgba(0,0,0,.06)';
        ctx.lineWidth = 1;
        roundRect(ctx, o.width - STEP.PAD - STEP.BADGE, STEP.PAD - 6, STEP.BADGE, STEP.BADGE, 16);
        ctx.stroke();
      } catch (e) { /* 画不上就跳过 */ }
    }

    ctx.fillStyle = COLORS.ink;
    ctx.font = font(STEP.TITLE, 700);
    m.titleLines.forEach(function (ln) {
      ctx.fillText(ln, x, y);
      y += STEP.TITLE + 8;
    });

    /* 副标题 */
    if (o.subtitle) {
      ctx.font = font(STEP.SUB);
      ctx.fillStyle = COLORS.ink2;
      wrap(ctx, o.subtitle, innerW).forEach(function (ln) {
        ctx.fillText(ln, x, y);
        y += STEP.SUB + 8;
      });
    }

    /* 徽章（浅橙底胶囊） */
    if (o.badges.length) {
      y += 8;
      var bx = x, by = y;
      ctx.font = font(13, 600);
      o.badges.forEach(function (b) {
        var tw = ctx.measureText(b).width;
        var bw = tw + 24;
        if (bx + bw > x + innerW) { bx = x; by += STEP.BADGE_H + 8; }
        ctx.fillStyle = COLORS.accentSoft;
        roundRect(ctx, bx, by, bw, STEP.BADGE_H, 15);
        ctx.fill();
        ctx.fillStyle = COLORS.accent;
        ctx.fillText(b, bx + 12, by + 8);
        bx += bw + STEP.BADGE_GAP;
      });
      y = by + STEP.BADGE_H + 14;
    }

    /* 分段 */
    m.blocks.forEach(function (b) {
      if (b.heading) {
        ctx.fillStyle = COLORS.accent;
        ctx.font = font(STEP.HEAD, 700);
        ctx.fillText(b.heading, x, y);
        y += STEP.HEAD + 10;
        /* 细分隔线 */
        ctx.strokeStyle = COLORS.line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + innerW, y);
        ctx.stroke();
        y += 10;
      }
      b.rows.forEach(function (r) {
        ctx.font = font(14);
        var maxLines = r.lines;
        for (var i = 0; i < maxLines; i++) {
          ctx.fillStyle = COLORS.ink;
          if (r.l[i]) ctx.fillText(r.l[i], x, y + i * STEP.ROW);
          if (r.r[i]) {
            ctx.fillStyle = COLORS.ink3;
            var rw = ctx.measureText(r.r[i]).width;
            ctx.fillText(r.r[i], x + innerW - rw, y + i * STEP.ROW);
          }
        }
        y += maxLines * STEP.ROW + STEP.GAP_ROW;
        ctx.strokeStyle = 'rgba(239,228,217,.7)';
        ctx.beginPath();
        ctx.moveTo(x, y - 3);
        ctx.lineTo(x + innerW, y - 3);
        ctx.stroke();
      });
      b.lines.forEach(function (ln) {
        ctx.font = font(14);
        ctx.fillStyle = COLORS.ink2;
        ln.lines.forEach(function (t) {
          ctx.fillText(t, x, y);
          y += STEP.LINE;
        });
      });
      y += STEP.GAP_SECTION - 6;
    });

    /* 页脚 */
    if (o.footer) {
      ctx.strokeStyle = COLORS.line;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + innerW, y);
      ctx.stroke();
      y += 14;
      ctx.font = font(12);
      ctx.fillStyle = COLORS.ink3;
      ctx.fillText(o.footer, x, y);
    }

    return cv;
  }

  /** 先把班徽加载好再画。download/share 内部都用这个。 */
  function renderAsync(opts) {
    var o = opts || {};
    return loadBadge(o.badge).then(function (bd) {
      var withBadge = {};
      for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) withBadge[k] = o[k];
      withBadge.__badge = bd;
      return render(withBadge);
    }).catch(function () {
      return render(o);
    });
  }

  function toBlob(cv) {
    return new Promise(function (resolve, reject) {
      try {
        cv.toBlob(function (b) { b ? resolve(b) : reject(new Error('生成图片失败')); }, 'image/png');
      } catch (e) { reject(e); }
    });
  }

  /** 下载（桌面 / 安卓微信里都走这条） */
  function download(opts, filename) {
    return renderAsync(opts).then(function (cv) { return downloadCanvas(cv, opts, filename); });
  }

  function downloadCanvas(cv, opts, filename) {
    var name = filename || ((opts && opts.title ? String(opts.title) : '卡片') + '.png');
    return toBlob(cv).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        try { a.remove(); URL.revokeObjectURL(url); } catch (e) {}
      }, 1500);
      return blob;
    });
  }

  /** 分享：优先系统分享（iOS / 安卓能直接发微信），不支持就退回下载 */
  function share(opts, filename) {
    return renderAsync(opts).then(function (cv) { return shareCanvas(cv, opts, filename); });
  }

  function shareCanvas(cv, opts, filename) {
    var name = filename || ((opts && opts.title ? String(opts.title) : '卡片') + '.png');
    return toBlob(cv).then(function (blob) {
      try {
        var file = new File([blob], name, { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
          return navigator.share({ files: [file], title: (opts && opts.title) || '分享' })
            .then(function () { return { shared: true }; })
            .catch(function (e) {
              /* 用户取消不算失败 */
              if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return { shared: false, canceled: true };
              throw e;
            });
        }
      } catch (e) { /* 老浏览器没有 File 构造器，直接走下载 */ }
      return downloadCanvas(cv, opts, filename).then(function () { return { shared: false, downloaded: true }; });
    });
  }

  global.ShareCard = {
    render: render, renderAsync: renderAsync,
    download: download, share: share, toBlob: toBlob,
    loadBadge: loadBadge,
  };
})(window);
