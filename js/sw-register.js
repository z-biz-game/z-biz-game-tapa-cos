'use strict';
// 注册本身要静默失败：file:// 下、旧 Safari、无痕窗口都拿不到 serviceWorker，
// 那不是玩家的错，不该在控制台抛红。
//
// sw.js 与 scope 都按 document.baseURI 解析，而不是拿 'sw.js' 让浏览器按当前 URL
// 字符串猜：Pages 上少一个尾斜杠时相对路径会一路找到 domain root 的 sw.js，那是别的
// 游戏的 worker —— 注册成功比失败更难查。
if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
  window.addEventListener('load', function () {
    var swUrl = new URL('sw.js', document.baseURI).href;
    var scope = new URL('./', document.baseURI).href;
    navigator.serviceWorker.register(swUrl, { scope: scope }).catch(function () {});
  });
}
