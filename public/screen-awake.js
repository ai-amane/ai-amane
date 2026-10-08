// 画面を消さない（iPad などを置いたままで待ち受けるため）
//  画面が消えるとマイクも止まるので、待受中・会話中は画面をつけたままにする（Screen Wake Lock に対応しているブラウザだけ）。
//  app.js が、待受中・会話中かに合わせて ScreenAwake.set(on) を呼ぶ。
window.ScreenAwake = (() => {
  "use strict";
  let lock = null, wanted = false, requesting = false;

  async function set(on) {
    wanted = on;
    if (on && !lock && !requesting && navigator.wakeLock && document.visibilityState === "visible") {
      requesting = true;
      try {
        const l = await navigator.wakeLock.request("screen");
        l.addEventListener("release", () => { if (lock === l) lock = null; });
        lock = l;
      } catch (e) { console.warn("wake lock:", e.message); }
      finally { requesting = false; }
    }
    // 取っている間に待受をオフにした場合なども、ここで外す
    if (!wanted && lock) { const l = lock; lock = null; l.release().catch(() => {}); }
  }

  // ほかのアプリやタブから戻ったとき・画面をタップしたときに取り直す（画面が隠れると自動で外れるため）
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") set(wanted); });
  for (const ev of ["touchend", "click"]) document.addEventListener(ev, () => { if (wanted) set(true); }, true);

  return { set };
})();
