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
//      升版本清旧缓存
const CACHE = 'class-site-v41'
const PRECACHE = ['./', './index.html', './favicon.svg', './manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
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
  } catch (e) { /* URL 解析失败就按原逻辑走 */ }

  // 导航请求：网络优先，失败回退缓存首页
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(request, copy))
          return res
        })
        .catch(() => caches.match('./index.html'))
    )
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
