/* ============================================================
   /api/upload —— 作业附件上传（音频 / 视频 / 图片）
   ------------------------------------------------------------
   背景（2026-10-07 第二十五轮）：
     站主要求「作业的音频和视频不一定要直链，点击上传到服务器也可以」。
     以前课代表只能填一个 URL（还得自己找图床 / 网盘外链），
     绝大多数人根本填不明白，于是附件功能形同虚设。

   【为什么必须有后端】
     Cloudflare Workers 本身**没有持久存储**（实例随时回收，文件放着就没了）。
     要真的「存在服务器上」，必须挂一个对象存储。站主选定 Cloudflare R2：

       wrangler.toml
       -------------------
       [[r2_buckets]]
       binding     = "UPLOADS"       # 代码里通过 env.UPLOADS 访问
       bucket_name = "<你建的桶名>"
       -------------------

   【没绑定时怎么办 —— 本文件的降级策略】
     线上没绑 R2 时，这里**不会假装成功**，而是回 503 + needSetup:true，
     把「去哪里配」写清楚。前端收到后把上传按钮标成「暂不可用」，
     并保留原来的「填直链」输入框 —— 功能降级，但不误导人。
     这条设计是被本项目的旧坑逼出来的：
       「写入成功、线上没反应」的静默失效排查成本极高，宁可明确报错。

   【请求格式：JSON + base64，不用 multipart】
     原因：Workers 入口 worker.mjs 的 adaptRequest 会把请求体
     `await request.text()` 预读成字符串再交给业务层，multipart 的二进制
     部分经这一趟会被破坏（非 UTF-8 字节丢失）。改 JSON + base64 后
     整条链路都是纯文本，稳。

     代价是 base64 会让体积膨胀约 33%，所以：
       · 单文件上限 20MB（base64 后约 27MB，请求体 100MB 限额内绰绰有余）
       · 前端负责压缩图片 / 提示音频体积

   【权限】与 ca-save-subject 完全一致（站主 2026-10-07 拍板）：
     · 管理员：任意科目
     · 课代表：只能给自己那一科传（服务端按 profiles.title 强校验）
     · 其他同学：401/403，看得到附件但传不了
   ============================================================ */

import { cors, handlePreflight, ok, fail, body, requireUserReady, audit } from './_lib/http.js';

/* 允许上传的 MIME 类型白名单。
   ⚠️ 只认前缀，具体编码（如 audio/mpeg、audio/mp4）都由前缀兜住。
   拒绝 application/* 与 text/* 是有意的：只让「能直接播放/看」的媒体进来，
   避免上传变成任意文件中转站（安全边界）。 */
const ALLOW_MIME = ['image/', 'audio/', 'video/'];

/* 单文件体积上限。20MB 是按「一首歌 / 一段听力 / 一张谱子照片」定的：
   · 听力音频一般 1–5MB
   · 手机拍的谱子照片 2–8MB
   · 短视频课件 10–20MB
   真要放更大的视频，走直链更合适（R2 免费额度也经不起一次性灌满）。 */
const MAX_BYTES = 20 * 1024 * 1024;

/* base64 解码后的实际字节数估算：去掉 data URL 前缀后按 3/4 折算 */
function b64Bytes(b64) {
  const s = String(b64 || '');
  const pure = s.includes(',') ? s.slice(s.indexOf(',') + 1) : s;
  const pad = (pure.match(/=+$/) || [''])[0].length;
  return Math.floor((pure.length * 3) / 4) - pad;
}

/* base64 → Uint8Array。
   Workers 里没有 Buffer，atob 是有的（Web 标准）。 */
function b64ToBytes(b64) {
  const s = String(b64 || '');
  const pure = s.includes(',') ? s.slice(s.indexOf(',') + 1) : s;
  const bin = atob(pure);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* 从 MIME 推扩展名。上传进 R2 的对象名带对扩展名很关键：
   浏览器靠 Content-Type 决定「是播放还是下载」，靠扩展名决定用什么打开。 */
function extOf(mime) {
  const m = String(mime || '').toLowerCase();
  const map = {
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'webm',
    'audio/flac': 'flac', 'audio/x-m4a': 'm4a',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'video/x-msvideo': 'avi',
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
  };
  if (map[m]) return map[m];
  const sub = m.split('/')[1] || '';
  return (sub.replace(/[^a-z0-9]/g, '') || 'bin').slice(0, 8);
}

/* 通用文件名清洗：只留 ASCII 字母数字点横线，防止路径穿越与编码问题。
   ⚠️ 必须清 —— R2 的 key 就是「路径」，放任 ../ 会写到别的前缀去。 */
function safeStem(name) {
  const base = String(name || '').replace(/\.[^.]+$/, '');
  const s = base.replace(/[^a-zA-Z0-9_-]/g, '');
  return (s || 'file').slice(0, 40);
}

/* 科目校验：与 api/content.js 的 caSaveSubject 保持同一份名单。
   ⚠️ 两处必须同步改，否则会出现「能存作业但传不了附件」的割裂。 */
const KNOWN_SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理', '其他'];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  cors(req, res);

  const action = String(req.query.action || 'file').toLowerCase();

  try {
    if (req.method === 'GET') {
      /* 查询上传能力：前端据此决定按钮是「可上传」还是「去填直链」。
         不暴露桶名等内部信息，只说能不能用。 */
      if (action === 'status') {
        const env = globalThis.__ENV__ || {};
        const has = !!(env.UPLOADS && typeof env.UPLOADS.put === 'function');
        return ok(res, {
          enabled: has,
          maxBytes: MAX_BYTES,
          maxMB: Math.round(MAX_BYTES / 1024 / 1024),
          allow: ['image', 'audio', 'video'],
          hint: has ? '' : '后端还没绑定存储桶，附件上传暂不可用，请先用「填直链」的方式。',
        });
      }
      /* 取文件：R2 桶如果是私有 bucket，走这里代理转发。
         公有桶（r2.dev）则前端直接用返回的公开 URL，不经过这里。 */
      if (action === 'file') {
        return await serveFile(req, res);
      }
      return fail(res, 404, '未知的 action：' + action);
    }

    if (req.method === 'POST') {
      if (action === 'file') return await uploadFile(req, res);
      return fail(res, 404, '未知的 action：' + action);
    }

    return fail(res, 405, '不支持的方法');
  } catch (e) {
    console.error('[upload]', action, e);
    return fail(res, 500, '服务器内部错误，请稍后重试');
  }
}

/* ---------------- 上传 ---------------- */

async function uploadFile(req, res) {
  const env = globalThis.__ENV__ || {};
  const bucket = env.UPLOADS;

  /* 存储没绑 → 明确说清楚，不假装成功。
     前端收到 needSetup 会把按钮切成「暂不可用」并提示走直链。 */
  if (!bucket || typeof bucket.put !== 'function') {
    return fail(res, 503, '附件上传暂未启用：后端还没有绑定存储桶（R2）。请先联系站主配置，或改用「填直链」的方式。', {
      needSetup: true,
    });
  }

  /* 鉴权：与课代表改作业同一档要求（已登录 + 已改初始密码） */
  const u = await requireUserReady(req, res, 'upload');
  if (!u) return;

  const b = await body(req);

  const subject = String(b.subject || '').trim();
  if (!KNOWN_SUBJECTS.includes(subject)) {
    return fail(res, 400, '不认识的科目：' + (subject || '（空）'));
  }

  const kind = String(b.kind || 'audio').toLowerCase();
  if (!['audio', 'video', 'image'].includes(kind)) {
    return fail(res, 400, '附件类型只支持 audio / video / image');
  }

  const mime = String(b.mime || '').toLowerCase();
  if (!mime) return fail(res, 400, '缺少文件类型（mime）');
  if (!ALLOW_MIME.some((p) => mime.startsWith(p))) {
    return fail(res, 400, '不支持的文件类型：' + mime + '（只允许图片 / 音频 / 视频）');
  }
  /* 兜一道：声明的 kind 必须和 mime 对得上。
     防止把视频标成 audio 绕过去（虽然不影响安全，但会让前端渲染错）。 */
  if (!mime.startsWith(kind + '/')) {
    return fail(res, 400, '文件类型与所选类别不符（' + kind + ' vs ' + mime + '）');
  }

  const data = String(b.data || '');
  if (!data) return fail(res, 400, '缺少文件内容');
  const size = b64Bytes(data);
  if (size <= 0) return fail(res, 400, '文件内容解析不出来（base64 格式不对）');
  if (size > MAX_BYTES) {
    return fail(res, 400, '文件太大（' + (size / 1024 / 1024).toFixed(1) + 'MB，上限 ' + Math.round(MAX_BYTES / 1024 / 1024) + 'MB）');
  }

  /* ---- 权限：管理员任意科目；课代表仅本科目 ---- */
  const isAdmin = u.role === 'admin' || !!u.isAI;
  if (!isAdmin) {
    const titles = String(u.title || '')
      .split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
    if (!titles.includes(subject + '课代表')) {
      return fail(res, 403, '你不是「' + subject + '课代表」，不能给该科目上传附件');
    }
  }

  const bytes = b64ToBytes(data);
  /* 对象名：hw/<科目>/<时间戳>-<随机>-<清洗后的原名>.<ext>
     带科目前缀是为了在 R2 控制台里能按科目看，
     带时间戳 + 随机串是为了避免同名覆盖（两个人传「听力.mp3」不会互相顶掉）。 */
  const stamp = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  const key = 'hw/' + subject + '/' + stamp + '-' + rnd + '-' + safeStem(b.name) + '.' + extOf(mime);

  try {
    await bucket.put(key, bytes, {
      httpMetadata: {
        contentType: mime,
        /* 附件内容不变，可以长缓存；但用 immutable 得配带版本的 URL，
           这里 URL 里已含时间戳随机串，天然不复用，所以可以放心长缓存。 */
        cacheControl: 'public, max-age=31536000, immutable',
      },
    });
  } catch (e) {
    console.error('[upload] R2 put 失败', e);
    return fail(res, 500, '上传失败：写入存储时出错，请稍后重试');
  }

  /* 公开 URL 的两种来源：
     ① 站主配了自定义域 / r2.dev 公开域 → env.UPLOAD_PUBLIC_BASE
     ② 没配 → 回落到本站代理 /api/upload?action=file&key=...
        好处是「不配也能用」，代价是流量走 Worker（有免费额度限制）。 */
  const base = String(env.UPLOAD_PUBLIC_BASE || '').replace(/\/+$/, '');
  const encKey = key.split('/').map(encodeURIComponent).join('/');
  const url = base ? (base + '/' + encKey) : ('/api/upload?action=file&key=' + encodeURIComponent(key));

  await audit(u.id, 'upload-file', 'upload', key,
    (isAdmin ? '管理员' : '课代表') + '上传「' + subject + '」' + kind + '（' + (size / 1024).toFixed(0) + 'KB）');

  return ok(res, {
    url,
    key,
    size,
    mime,
    kind,
    subject,
    proxied: !base,
    message: '上传成功',
  });
}

/* ---------------- 读文件（未配公开域时的代理通道） ----------------
   只读，不需要登录：作业附件本来就是给全班看的，
   而 <audio src> / <img src> 这类标签**带不上 Authorization 头**，
   要求登录就会导致「上传成功但播放不了」。 */
async function serveFile(req, res) {
  const env = globalThis.__ENV__ || {};
  const bucket = env.UPLOADS;
  if (!bucket || typeof bucket.get !== 'function') {
    return fail(res, 503, '附件服务未启用', { needSetup: true });
  }

  const key = String(req.query.key || '');
  /* 只允许读 hw/ 前缀：防止有人拿这个接口去读桶里别的东西 */
  if (!key || !key.startsWith('hw/') || key.includes('..')) {
    return fail(res, 400, '非法的文件标识');
  }

  const obj = await bucket.get(key);
  if (!obj) return fail(res, 404, '文件不存在或已删除');

  const headers = {};
  const meta = (obj.httpMetadata || {});
  if (meta.contentType) headers['Content-Type'] = meta.contentType;
  if (meta.cacheControl) headers['Cache-Control'] = meta.cacheControl;
  /* 音频/视频要支持拖动进度条 → 必须让浏览器知道能随机读，
     并接受 Range 请求。这里声明 accept-ranges，Content-Length 由 R2 给。 */
  headers['Accept-Ranges'] = 'bytes';
  if (obj.size !== undefined && obj.size !== null) headers['Content-Length'] = String(obj.size);
  /* 不让浏览器猜类型（猜错会把 mp3 当文本） */
  headers['X-Content-Type-Options'] = 'nosniff';

  /* ⚠️ 这里不走 json() 包装：要回二进制流。
     worker.mjs 的响应收集器会把 body 字符串化，所以走 res.end() 传字符串是错的
     —— 二进制会被破坏。改用 env 上挂的原生 Response 直出（见 _lib 约定）。

     具体做法：把 Response 对象挂在 req 上，由 worker.mjs 识别后直接返回。
     这是本项目唯一需要「绕过统一响应包装」的地方。 */
  req.__rawResponse = new Response(obj.body, { status: 200, headers });
  res.statusCode = 200;
  res.setHeader('X-Raw-Response', '1');
  res.end();
  return null;
}
