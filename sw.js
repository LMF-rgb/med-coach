/*
 * 医考教练 service worker。
 *
 * 🔴 策略是 network-first（先问网络、失败才回退缓存），**不是** cache-first。
 * 这个区别是整套东西的关键：
 *   - cache-first（命中缓存就永不联网）：离线能开，但改了不生效，得手动改版本号才更新
 *   - network-first：有网时拿到的永远是最新版；拉不到（没网/校园网抽风）才回退到缓存
 * 所以「刷新即最新」和「没网也能开」能同时拿到，两者并不冲突。
 *
 * 首次访问必须联网（资源要下载一遍存起来），之后就一直有效。
 *
 * 注意 tesseract 的 15MB 资源是**用到 OCR 时才 fetch**，所以 SW 按需缓存，
 * 不会拖慢首屏。
 */
const CACHE = 'med-coach-v2'

// 新 SW 一装上就接管，不等所有标签页关掉 —— 否则用户要重开两次才看到新版
self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  let url
  try {
    url = new URL(req.url)
  } catch {
    return
  }

  // 🔴 只管同源资源。跨域的必须直接放行 —— 尤其是 AI 的 fetch 请求
  // （api.deepseek.com / 火山视觉），缓存住的话会把模型回复也当成静态资源存下来。
  if (url.origin !== self.location.origin) return

  /*
   * 🔴 导航请求必须绕开 HTTP 缓存。
   *
   * GitHub Pages 给 index.html 发的是 `Cache-Control: max-age=600`，而 JS/CSS 是带
   * hash 的（hash 变了就是新 URL，不受影响）。于是出现一个很难查的现象：
   * SW 是 network-first，`fetch(req)` 也「走了网络」，但浏览器在中途用本地 HTTP 缓存
   * 把它截胡了，拿回 10 分钟前的**旧 index.html** —— 而旧 index.html 指向旧的 JS。
   * 结果就是「推了新版本，用户刷新了却什么都没变」，得等满 10 分钟才好。
   *
   * `cache: 'reload'` 强制跳过 HTTP 缓存去要真的最新（但会把新响应写回缓存，
   * 比 no-store 好）。只对导航请求这么做：带 hash 的静态资源本来就不需要。
   */
  event.respondWith(
    fetch(req, { cache: req.mode === 'navigate' ? 'reload' : 'default' })
      .then((res) => {
        // 只缓存干净的成功响应。opaque（跨域）和 206（Range）都不适合缓存 ——
        // 前者读不到状态码，后者只是片段，存下去会让下次拿到半截文件。
        if (res && res.status === 200 && res.type === 'basic' && !req.headers.has('range')) {
          const clone = res.clone()
          caches.open(CACHE).then((c) => c.put(req, clone))
        }
        return res
      })
      .catch(() =>
        caches.match(req).then((hit) => {
          if (hit) return hit
          // 导航请求（地址栏输入/刷新）离线时回退到 shell；
          // 直接写 caches.match('./index.html') 在 GitHub Pages 子路径下
          // 会因为解析出的绝对路径不同而落空，所以用 URL 拼。
          if (req.mode === 'navigate') {
            return caches.match(new URL('./index.html', self.registration.scope).href)
          }
          return Response.error()
        })
      )
  )
})
