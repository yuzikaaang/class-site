// Service Worker —— 班级服务站 PWA
// 策略：导航(html)走「网络优先」，保证内容随网页实时更新；
//       静态资源(js/css/图片)走「stale-while-revalidate」，快且有网即更新；
//       离线时回退到已缓存页面，实现兜底。

const CACHE = 'class-site-v1'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  // 只处理同源请求，跨域（如云开发 SDK）交给浏览器默认行为
  if (url.origin !== self.location.origin) return

  // 导航请求：网络优先，失败回退缓存 / 首页
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {})
          return res
        })
        .catch(() =>
          caches.match(req).then((c) => c || caches.match('/index.html'))
        )
    )
    return
  }

  // 静态资源：stale-while-revalidate
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetched = fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {})
          return res
        })
        .catch(() => cached)
      return cached || fetched
    })
  )
})
