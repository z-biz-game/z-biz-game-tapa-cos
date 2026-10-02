'use strict';
// network-first：能联网就取网络并顺手回填缓存；断网时回落到上次成功抓取的资源。
//
// 缓存名带版本号，而且必须本仓专属：组合里每个 -cos 仓都挂在同一个 origin 下
// （z-biz-game.github.io/<repo>/ 是路径不是子域），而 CacheStorage 按 origin 计
// —— 沿用共用的 'z-pwa-v1' 会让一个游戏的 activate 去删另一个游戏的缓存。
//
// 绝不做 cache-first：手工版本号 + cache-first 会把 js/css 永久钉死在旧版，
// 出新 HTML 配旧 JS 的鬼状态比离线打不开更难查。
var CACHE = 'tapa-pwa-v1';
// 外壳单独预取：离线路径下的第一跳是导航请求，只靠"上次顺手回填"不够。
var SHELL = ['./', './index.html', './css/game.css', './js/main.js'];

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
