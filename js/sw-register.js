'use strict';
// service worker 注册：只在 http/https 下做。
//
// file:// 直接打开（双击 index.html、或把仓库 zip 解开看）时 navigator.serviceWorker
// 要么不存在、要么 register 必抛 SecurityError。那不是玩家的错，不该在控制台上留一条
// 红字，更不该让后面真正该跑的 main.js 因为这条未捕获异常被中断。
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', () => {
    // 相对 sw.js 而不是绝对 /sw.js：Pages 的项目站挂在 /<repo>/ 子路径下。按 baseURI 解析成绝对
    // 地址再交给 register：路径仍跟着页面走，但注册地址与 scope 不再依赖调用方替它猜 base。
    const sw = new URL('sw.js', document.baseURI).href;
    const scope = new URL('./', document.baseURI).href;
    navigator.serviceWorker.register(sw, { scope }).catch(() => {});
  });
}
