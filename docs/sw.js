/**
 * Service Worker - 离线缓存支持 (v4 iOS优化版)
 * 趋势交易助手 PWA
 */

const CACHE_NAME = 'trend-trader-v6';
// 核心资源预缓存（包含ECharts本地文件）
const CORE_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/strategy.js',
  './js/data.js',
  './js/app.js',
  './js/echarts.min.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// CDN白名单（Stale-While-Revalidate策略）
const CDN_HOSTS = ['cdn.jsdelivr.net'];

// 安装 - 逐个缓存，单个失败不影响整体
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        // 使用Promise.allSettled容错：单个资源失败不导致SW安装失败
        return Promise.allSettled(
          CORE_ASSETS.map(url =>
            cache.add(url).catch(err => {
              console.warn('预缓存跳过:', url, err.message);
            })
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

// 激活
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// fetch 事件处理
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // CDN资源（ECharts等）: Stale-While-Revalidate，先缓存后网络更新
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache => {
        return cache.match(event.request).then(cached => {
          const fetchPromise = fetch(event.request, { mode: 'cors' })
            .then(networkResponse => {
              if (networkResponse && networkResponse.status === 200) {
                cache.put(event.request, networkResponse.clone()).catch(() => {});
              }
              return networkResponse;
            })
            .catch(() => cached || new Response('', { status: 503 }));
          return cached || fetchPromise;
        });
      })
    );
    return;
  }

  // 同源API/数据请求（bundle.json、股票数据）: Network-First，失败回缓存
  if (url.origin === location.origin && url.pathname.startsWith('/data/')) {
    event.respondWith(
      fetch(event.request)
        .then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, clone).catch(() => {});
            });
          }
          return networkResponse;
        })
        .catch(() => {
          return caches.match(event.request).then(cached => {
            return cached || new Response('{"error":"offline"}', {
              status: 503,
              headers: { 'Content-Type': 'application/json' }
            });
          });
        })
    );
    return;
  }

  // index.html: Network-First，确保每次打开都是最新版本
  if (url.origin === location.origin && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.endsWith('/index.html'))) {
    event.respondWith(
      fetch(event.request)
        .then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, clone).catch(() => {});
            });
          }
          return networkResponse;
        })
        .catch(() => {
          return caches.match(event.request).then(cached => {
            return cached || new Response('离线模式', { status: 503 });
          });
        })
    );
    return;
  }

  // 其他同源静态资源（JS/CSS/图标等）: Cache-First，后台更新
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(event.request)
        .then(cachedResponse => {
          const fetchPromise = fetch(event.request)
            .then(networkResponse => {
              if (networkResponse && networkResponse.status === 200) {
                const clone = networkResponse.clone();
                caches.open(CACHE_NAME).then(cache => {
                  cache.put(event.request, clone).catch(() => {});
                });
              }
              return networkResponse;
            })
            .catch(() => cachedResponse);
          return cachedResponse || fetchPromise;
        })
    );
    return;
  }

  // 其他跨域请求（腾讯/新浪API）: 直接走网络，不缓存
  event.respondWith(
    fetch(event.request).catch(() => new Response('', { status: 503 }))
  );
});
