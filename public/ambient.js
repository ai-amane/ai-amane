// 表示だけモード: 会話ログ・状態の文字・ボタンを隠して、AI の姿（粒子の群れ / 流体オーブ）だけを画面いっぱいに出す
//  ・「表示だけにする」ボタンで入る。画面をタップ（クリック）すると「表示を戻す」ボタンが少しの間だけ出る。H キーでも切り替え
//  ・入るときはブラウザの全画面表示にもする（iPad の Safari のアドレスバーなども隠れる）
//  ・この画面（端末）ごとに覚えておく。困ったとき（エラー）は、画面の下に短く知らせる
window.AmaneAmbient = (() => {
  "use strict";
  const KEY = "amane.ambient";
  const REVEAL_MS = 4000;
  const TOAST_MS = 8000;
  const ERROR_WORDS = /エラー|失敗|使えません|できません|接続できません|見つかりません/;
  const $ = (id) => document.getElementById(id);
  const ui = { enter: $("btnAmbient"), exit: $("btnAmbientExit"), toast: $("toast") };
  let revealTimer = null, toastTimer = null;

  const isOn = () => document.body.classList.contains("ambient");
  const remember = (on) => { try { localStorage.setItem(KEY, on ? "1" : "0"); } catch {} };

  function fullscreen(on) {
    const d = document, el = d.documentElement;
    const active = d.fullscreenElement || d.webkitFullscreenElement;
    try {
      if (on && !active) (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
      else if (!on && active) (d.exitFullscreen || d.webkitExitFullscreen)?.call(d)?.catch?.(() => {});
    } catch {}
  }

  function set(on) {
    if (on && window.AmaneRec?.isOn()) window.AmaneRec.set(false);   // 縦型の収録モード（rec-mode.js）とは同時に使わない
    document.body.classList.toggle("ambient", on);
    document.body.classList.remove("reveal");
    if (!on) ui.toast?.classList.remove("show");
    remember(on);
    fullscreen(on);
  }

  // 表示だけモードで画面をタップしたら、戻るボタンを少しの間だけ出す（全画面が外れていたら戻す）
  function reveal() {
    if (!isOn()) return;
    fullscreen(true);
    document.body.classList.add("reveal");
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => document.body.classList.remove("reveal"), REVEAL_MS);
  }

  // 表示だけモードのときだけ、エラーを画面の下に短く出す（ログが見えないので）
  function notify(text) {
    // 作業の報告（「#3 完了：…」）は、中に「できません」などがあってもエラーではない
    if (!isOn() || !ERROR_WORDS.test(text) || /^#\d+/.test(text) || !ui.toast) return;
    ui.toast.textContent = text;
    ui.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove("show"), TOAST_MS);
  }

  if (ui.enter) ui.enter.onclick = (e) => { e.stopPropagation(); set(true); };
  if (ui.exit) ui.exit.onclick = (e) => { e.stopPropagation(); set(false); };
  // iPad の Safari は、ボタンなどでない場所のタップで click を出さないことがあるので、指を離したときにも出す
  for (const ev of ["click", "pointerup"]) document.addEventListener(ev, (e) => { if (e.target !== ui.exit) reveal(); });
  window.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.isComposing) return;   // Ctrl+H（履歴）・長押しなどでは切り替えない
    if (e.code === "KeyH") set(!isOn());
  });
  // 万一戻れなくなったときは、URL に ?ambient=0 を付けて開けば解除できる
  try {
    if (new URLSearchParams(location.search).get("ambient") === "0") remember(false);
    if (localStorage.getItem(KEY) === "1") document.body.classList.add("ambient");
  } catch {}

  return { set, notify };
})();
