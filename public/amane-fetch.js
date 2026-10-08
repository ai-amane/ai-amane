// この画面からサーバーの API を呼ぶときに、目印のヘッダー（X-Amane）を付ける。
// サーバーはこのヘッダーが無い POST を拒否するので、ほかの Web サイトから勝手に作業を実行されることがない。
(() => {
  "use strict";
  const orig = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const sameOrigin = url.startsWith("/") || url.startsWith(location.origin);
    if (sameOrigin) {
      const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      headers.set("X-Amane", "1");
      init = { ...init, headers };
    }
    return orig(input, init);
  };
})();
