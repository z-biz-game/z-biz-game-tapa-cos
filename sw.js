'use strict';
// network-first：能联网就取网络并顺手回填缓存；断网时回落到上次成功抓取的资源。
//
// 缓存名带版本号，而且必须本仓专属：组合里每个 -cos 仓都挂在同一个 origin 下
// （z-biz-game.github.io/<repo>/ 是路径不是子域），而 CacheStorage 按 origin 计
// —— 沿用共用的 'z-pwa-v1' 会让一个游戏的 activate 去删另一个游戏的缓存。
//
// 绝不做 cache-first：手工版本号 + cache-first 会把 js/css 永久钉死在旧版，
// 出新 HTML 配旧 JS 的鬼状态比离线打不开更难查。
var CACHE = 'tapa-pwa-v2';
// 外壳单独预取：离线路径下的第一跳是导航请求，只靠"上次顺手回填"不够。
// 名单得盖到整张模块图和游戏真用到的贴图：main.js 是 ESM，断网首开时那 12 个依赖
// 与三张母题 PNG 一次都没被回填过 —— 只列 main.js 的"离线可玩"是句假话。
// index.html 自己指向的东西（注册脚本、manifest、favicon、apple-touch-icon）也一并进来：
// 离线首开时这些是 404 就少一块的地方。只有 og 社交卡不进表 —— 那是爬虫读的绝对 URL，
// 应用自己不取它，65KB 没理由压在 install 上。
var SHELL = [
  './',
  './index.html',
  './css/game.css',
  './js/main.js',
  './js/theme.js',
  './js/store.js',
  './js/audio/synth.js',
  './js/data/library.js',
  './js/engine/count.js',
  './js/engine/generate.js',
  './js/engine/rng.js',
  './js/engine/tapa.js',
  './js/render/assets.js',
  './js/render/board.js',
  './js/render/fx.js',
  './js/ui/game.js',
  './js/sw-register.js',
  './manifest.webmanifest',
  './assets/img/favicon-32.png',
  './assets/img/favicon-16.png',
  './assets/img/apple-touch-icon.png',
  './assets/img/board-grain.png',
  './assets/img/ink-sprite.png',
  './assets/img/pulse-hoop.png',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) { return c.add(new Request(u, { cache: 'reload' })).catch(function () { }); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        // 导航请求断网时回落到外壳。两个候选必须串起来判：`a() || b()` 比的是两个
        // Promise 对象，永远为真，第二个候选于是从来没被看过一眼。
        if (req.mode !== 'navigate') return Response.error();
        return caches.match('./').then(function (shell) {
          return shell || caches.match('./index.html');
        });
      });
    })
  );
});
