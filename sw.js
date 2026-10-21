// Service Worker for 25级05班班级服务站 (static PWA)
// 策略：网络优先（保证内容随 Gitee 实时更新），离线时回退缓存
// v33：新增「自定义设置」——五类排序（首页区块 / 板块 / 板块内卡片 / 小游戏 / 公告分类）、
//      字号六档、四类背景（跟随主题 / 纯色 / 渐变 / 本地图片 + 蒙层）、动效总开关，
//      配置可导出导入跨设备使用。
//      配套 7 项交互：圆形涟漪主题切换 / 长按拖拽排序 / 速度吸附滑块 /
//      文字渐显手风琴 / 3 步进度条 / 开关涟漪 / 标签选中扩散。
//      排序一律存在数据层（不是 DOM），render() 重建后自动重放，站主新增项永不丢失。
//      背景可读性守护：选到深色背景自动配夜间模式（实测最坏情况对比度 2.24:1 → 16.68:1）。
//      （v32 暖阳橙色相成果保留）
// v34：修正 4 条站内公告的时间——原值写成了未来时刻且日期整体错了一天，
//      现按 git 提交时间回填（09-26 15:38 / 16:43 / 17:50，以及本轮 09-27 09:32）。
//      同期修正 internal/notes.md 中 8 条更新记录标题与 10 处站规日期。
//      （v33 自定义设置成果保留）
// v35：板块卡片改为「卡片堆叠」——同一板块下 ≥2 个入口时层叠成一沓只露顶牌，
//      顶部条显示入口数并提供 ↑↓ 上下轮换（点击 / 滚轮 / 手机上下滑动均可触发），
//      另有「展开全部」回到平铺，被压住的卡片在堆叠态不响应指针避免误触。
//      纯 CSS transform 实现，不引入任何第三方库（微信 X5 可用）；
//      可在「自定义设置 → 动效」里关掉，回到传统平铺。仅单个入口的板块不堆叠。
// v35.2：卡片堆叠改为**默认关闭**（试验功能，观感不稳定，站主拍板）。
//      UI 配置版本升至 v2，v1 老配置里带的 stack=1 在升级时一并复位为关；
//      用户主动打开时会弹出橙色提醒「还在测试中，随时可能调整或去掉」。
// v35.1：卡片堆叠调整——所有卡片统一高度（矮卡不再让下层漏内容）、层间距加大更好点击
//         （v35.2 起该功能默认关闭）
// v36：法定节假日改为**自动推算**，不再手填日期表（以前过一年就得手动补，忘了会空掉）。
//      ① 固定公历：元旦 1/1、劳动节 5/1、国庆 10/1
//      ② 农历节日：春节 / 端午 / 中秋 —— 内置 1900–2100 农历数据表精确换算，离线可用
//      ③ 清明：节气，4/4 或 4/5 浮动，用官方日期查表 + 公式兜底
//      滚动生成「今年起未来 5 年」，永远不会因年份增长而空掉。
//      首页按「节日当天一开始就隐藏」过滤；弹窗只列「近 1 个月内过期 + 未来半年内」，
//      过期的置灰显示 0 天，长度恒定不会越积越长。放假天数标「参考」（国务院每年调休会变）。
// v37：新增【账号系统 + 云同步 + 管理员后台】——前端加登录/注册弹窗、个人中心、
//      管理员后台三个界面；后端在 api/ 目录（Vercel Serverless + Neon Postgres）。
//      ① 登录态用 Bearer token（不用 Cookie，避开微信对第三方 Cookie 的限制）
//      ② 云同步只上传个人数据键（白名单），公告资料等站内容不同步
//      ③ 管理员可管用户、改数据、看统计与操作日志
//      ④ 不登录时站点行为完全不变，数据照旧存本机
//      部署说明见 api/README.md；接口不可用时不影响离线使用
// v38：部署平台说明修正 —— 前端域名由「Gitee Pages」更正为「GitHub Pages」
//      （Gitee Pages 已于 2024 年永久下线），站点「仓库」按钮改指 GitHub 仓库；
//      api/README.md 补上「Vercel 不支持导入 Gitee，需用 GitHub 仓库」的说明
//      与推送步骤。功能无变化，仅纠正过时描述。
// v39：管理后台入口增加【服务端身份核实】—— 原先前端只看本地缓存的 role，
//      若缓存过时（管理员被降级）或被人手动改 localStorage 伪造 admin，
//      会出现「能进后台但每个接口都 403」的尴尬。现在点开后台前先问一次
//      /api/auth?action=me，以服务端返回的 role 为准并回写本地缓存。
//      同时修掉一个残留问题：核实失败时清空弹窗内容，不留上次的旧界面。
// v41：重要日期新增【第一次段考】（10月13日—14日），并在「查看全部」里支持
//      二级弹窗展开各科考试范围（文字版）。列表日期对跨天事项改为显示区间。
// v42：新增【国庆假期作业】（10.1–10.7，六科），开屏通知弹窗同步切换为国庆作业。
// v43：开屏弹窗与公告按站主要求精简（弹窗只留「作业已发布」，公告只留一句）。
// v44：① 开屏弹窗图标由中秋遗留的 🌕 改为 🎉；
//      ② 摘掉 Classworks 那条**永久置顶**公告（只取消置顶、保留条目，仍可在「重要更新」
//         分组里翻到——直接删会连历史记录一起丢）；
//      ③ 【站点内容云端化】新增云端内容拉取层：公告 / 作业 / 重要日期 / 站点配置
//         可改为从后端读取，站主在后台改完即时生效，不必再改代码 + 等 Pages 重建。
//         策略是**渐进式**——index.html 里的 SITE_DATA 永久保留作静态兜底，
//         断网 / 后端挂掉 / 未部署后端时，页面与从前完全一致；
//         拉到内容后存 localStorage 缓存，二次进站先用缓存秒开、再后台比对增量。
//      升版本清旧缓存
// v46：国庆英语的听力音频并入「试卷 1 张」同一条（不单独占一行答题项）。
//      v45：国庆英语新增听力音频（与中秋那条格式一致，站内弹窗播放）。
//      升版本清旧缓存
// v47：隐私加固 —— 移除「个人资料查询」里的电话 / 微信 / QQ / 智学网准考证四类字段
//       （此前用 XOR 混淆存放，密钥就在同一份 JS 里，等于明文；公开站点藏不住，故彻底删除）。
//       清理仓库内全部历史备份包（backup/ 与根目录 class-site-backup.zip），改用 git 做版本留档。
//       升版本清旧缓存。
// v53（对应 v2.6.1）：心跳判定的时间窗防抖改为「连续失败计数」——
//       以前任一条请求偶尔失败就会点亮红条（api 失败计入但 api 成功不清零，
//       且复查时刻与心跳间隔几乎重合 → 红条闪一下），现在只有连续 2 次心跳
//       失败才提示，任意一次成功即清零。「重试」按钮改成 60 秒倒计时
//       （正在刷新… 剩余 N 秒 → 连接已恢复）。学习卡片暂时隐藏。
//       升版本清旧缓存。
// v54（对应 v2.6.2）：后台导航把「每日一言」与「学习卡片」合并为一个板块
//       「首页卡片」（内容组 10 项 → 9 项，原来太碎不好找）。面板内分上下两块，
//       各自复用原逻辑与云端键（daily_quote / study_card），互不干扰。
//       纯后台结构调整，同学侧无变化。升版本清旧缓存。
// v55（对应 v2.6.3）：登录验证码由「拖动滑块拼图」改为「输入 4 位数字图形码」。
//       站主反馈滑块在部分老手机屏幕上用不了 —— 根因是原实现走 Pointer Events，
//       老浏览器（iOS Safari < 13 / Android Chrome < 55）根本不支持，事件不触发；
//       且拖动要求手指精准。改成输入式后只看「键盘能不能打字」，
//       配合数字键盘（inputmode=numeric + pattern）输入门槛最低。
//       升版本清旧缓存。
// v56（对应 v2.6.4）：新增【更新检测与一键强制刷新】—— 站主反馈「iOS 端无法正常
//       刷新，线上已经是 2.6.3，我的还是 2.6.2」。根因：**iOS 极少主动去检查 SW 更新**
//       （尤其「添加到主屏」后只在导航时 + 最长 24 小时检查一次），而旧页面即使新 SW
//       已激活也不会自己重新加载，于是永远停在旧版本。配套改动：sw.js 新增 message
//       监听 SKIP_WAITING（页面可主动让新 SW 立刻接管）；前端注册后主动 update()、
//       回到前台再 update()、定时 update()，并对比本文件里的 SITE_VER（见下方常量）
//       判断是否落后；提供「强制刷新」（清空 CacheStorage + 注销 SW + 带时间戳跳转
//       绕开 HTTP 缓存）。升版本清旧缓存。
//       v57（同 v2.6.4 补丁）：① 检查更新原先要下载整个 600KB 首页，弱网下
//       30 秒都下不完、还每次白耗流量 —— 改为读本文件里的 SITE_VER（12KB，
//       快约 40 倍）；② 检查更新加 withTimeout 兜底，不再卡在「正在检查更新…」。
//       v58（对应 v2.6.5）：页脚「页面由 Work Buddy 辅助生成」改为「页面由 AI 辅助生成」。
//       v59（对应 v2.6.6）：① 修 iPad 弹窗不居中（body 的 overflow-x 会让
//       WebKit 把 fixed 定位基准变成 body；弹窗改 flex+margin:auto，长内容不再裁顶；
//       高度上限换 dvh）；② 通用弹窗的按钮支持跳站内页面（cat:N 板块 / fn:函数白名单）。
/* ⚠️ 这个常量必须和 index.html 里的 SITE_VERSION 保持一致。
   前端的「检查更新」就是读这里的值来判断线上有没有新版 ——
   读 12KB 的 sw.js 比读 600KB 的首页快得多、也省流量
   （线上实测：首页在弱网下 30 秒都下不完，而 sw.js 1~5 秒）。
   e2e 测试里有护栏会校验两者相等，改版本号时别漏。 */
const SITE_VER = '3.8.9'

const CACHE = 'class-site-v171'
/* 预缓存清单：**只放小文件**。
   ⚠️ 不要把 index.html（600KB）放进来 —— install 会因为它变慢一大截，
   弱网下甚至装不完（真机实测 SW 卡在 installing 25 秒都没装好，
   而 SW 装不上，前端的「检查更新」也就跟着失效）。
   首页交给下面 fetch handler 的「网络优先 + 写缓存」在首次访问时自然缓存，
   断网时照样能用 caches.match('./index.html') 兜底，功能不受影响。
   v80（v2.10.0）：加入两个字体的 latin 子集 woff2（共约 78KB）——
   同源自托管替代 Google Fonts 外链（微信内置浏览器拦截外部字体域），
   预缓存保证首次离线访问英文字形也不掉。 */
const PRECACHE = ['./favicon.svg', './manifest.webmanifest',
  './fonts/inter-latin.woff2', './fonts/jetbrains-mono-latin.woff2',
  /* v3.5.40：作业/排期导出图片用的共享画笔，离线也要能生成 */
  './share-card.js', './badge.png']

self.addEventListener('install', (event) => {
  /* ⚠️ v3.8.2 关键修复：不能用 cache.addAll(PRECACHE)。
     addAll 是「全成功才算数」—— 清单里只要有一个文件 404（本项目就长期
     被 ./badge.png、./share-card.js 拖累，GitHub Pages 新文件同步极慢），
     整个 install 就 reject，Service Worker **永远装不上**。
     表现就是：缓存明明写了策略却从来没用上、断网打不开、每次进站都重新下整页。
     现在逐个 add 并各自 catch：缺哪个就跳过，其余照常缓存。 */
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(
        PRECACHE.map((u) => cache.add(u).catch(() => {
          /* 单个文件取不到不算错（比如临时 404 的图），下个版本再补 */
        }))
      ))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
      .then(() => self.clients.claim())
      /* v2.6.4：接管完成后通知所有开着的页面「我换了」。
         页面按此判断要不要重新加载。iOS 上 controllerchange 偶有不触发，
         多给一条信号源能让「更新后仍显示旧版」少发生。 */
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((cs) => cs.forEach((c) => c.postMessage({ type: 'SW_ACTIVATED', cache: CACHE })))
      .catch(() => {})
  )
})

/* v2.6.4：页面可主动要求新 SW **立刻接管**（点「立即更新 / 强制刷新」时用）。
   install 里本来就有 skipWaiting()，但「已在等待中的旧 SW」需要这条消息推一把。 */
self.addEventListener('message', (event) => {
  const d = event.data
  if (d && d.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  /* 点歌平台开放 API：完全绕过 SW，不进缓存（2026-08-30）
   * 原因：CORS 白名单加好后 API 请求会成功，若照旧缓存，用户离线时 SW 会用**缓存的旧歌单**兜底，
   * 前端拿到数据就以为抽签成功——实际抽的是过期歌单，且不会触发「连不上点歌平台」的降级提示。
   * 跨域**静态资源**（图床上的班徽与各卡片图标）不在此列，仍照常缓存，保证离线可用。 */
  try {
    const u = new URL(request.url)
    if (u.origin !== self.location.origin &&
        (u.hostname.indexOf('dpdns.org') >= 0 || u.pathname.indexOf('/api/') === 0)) return
    /* v2.6.4：版本探测（?_=）与强制刷新（?_r=）的请求**不进缓存**。
       这两种 URL 每次都带一个新时间戳，缓存只会越堆越多（线上每 5 分钟查一次，
       一天就能塞进几百份 index.html 副本）；而且它们本来就是「我就要最新的」语义，
       缓存毫无意义。直接放行走网络。 */
    if (u.searchParams.has('_') || u.searchParams.has('_r')) return
  } catch (e) { /* URL 解析失败就按原逻辑走 */ }

  /* 导航请求（打开页面）：v3.8.0 起改成「最多等 900ms 的网络优先」
   * ------------------------------------------------------------
   * 站主原话：「从后台到前台的时候，一直在这个页面，但它还是要重新加载一次，
   *            而且暂时没有用到缓存」
   *
   * 根因：原来是纯网络优先 —— 每次进站都要把整页 HTML 重新下一遍（现在 400KB+），
   *       网慢的时候就是白等好几秒，缓存明明有却完全用不上。
   *
   * 现在：
   *   · 有缓存 → 网络 900ms 内回来就用最新（保持「打开就是新版」），
   *     回不来就先把缓存那页给浏览器，网络结果在后台落盘，下次即最新。
   *   · 没缓存 → 老实等网络。
   * 版本更新仍由 swRegister 的「检查更新」负责，不会因为这条策略卡住不升。
   */
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      let cache = null
      let cached = null
      try {
        cache = await caches.open(CACHE)
        cached = (await cache.match(request)) || (await cache.match('./index.html'))
      } catch (e) { cached = null }

      const netP = fetch(request)
        .then((res) => {
          if (res && res.ok && cache) cache.put(request, res.clone()).catch(() => {})
          return res
        })
        .catch(() => null)

      if (!cached) {
        const r = await netP
        return r || Response.error()
      }
      /* 有缓存：最多等 900ms 拿最新，超时先给缓存（页面秒开） */
      const winner = await Promise.race([
        netP,
        new Promise((resolve) => setTimeout(() => resolve(null), 900)),
      ])
      return winner || cached
    })())
    return
  }

  // 静态资源：网络优先 + 缓存兜底
  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(request, copy))
        return res
      })
      .catch(() => caches.match(request))
  )
})
