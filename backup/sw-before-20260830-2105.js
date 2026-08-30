// Service Worker for 25级05班班级服务站 (static PWA)
// 策略：网络优先（保证内容随 Gitee 实时更新），离线时回退缓存
// v8：API 请求不再进缓存（详见下面 fetch 事件里的说明）；升版本号会清掉 v7 留下的旧缓存
const CACHE = 'class-site-v8'
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
