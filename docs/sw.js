/* Jayce量化慧采 PWA Service Worker
 * 策略：仅处理同源 GET（静态壳），网络优先、失败回退缓存壳；
 *       跨域请求（腾讯行情等）一律不拦截，交给浏览器原生处理（含 CORS 校验）。
 */
const CACHE = 'quant-app-v41';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './regime_breadth.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 非 GET 或跨域请求：不拦截（跨域由浏览器原生 CORS 处理，避免 SW 把失败回退成 index.html）
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // 静态壳 / 同源代理：网络优先，离线回退缓存
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        if (res.ok) {
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  );
});
