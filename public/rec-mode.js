// 縦型の収録モード: ショート動画（縦 9:16）を撮るための表示
//  ・画面の中央に 9:16 の枠を出し、AI の姿・資料のパネル・字幕（話しかけた言葉と、いま話している返事の文）をその中に収める
//  ・字幕と資料は、SNS のボタンや説明文に隠れない場所（上の 1 割・下の 2 割・右の 1 割強を避ける。style.css）に置く
//  ・声のクレジット（例: AivisSpeech: まお）を枠の中に小さく出す（動画で公開するときに表記を求める声があるため）
//  ・「縦型で収録」ボタン・R キー・URL の ?rec=1 で入る。画面をタップすると「収録を終える」ボタンが少しの間だけ出る
//  ・この画面（端末）ごとに覚えておく。万一戻れなくなったら ?rec=0 を付けて開く
window.AmaneRec = (() => {
  "use strict";
  const KEY = "amane.rec";
  const REVEAL_MS = 4000;
  const CLEAR_MS = 5000;   // 会話が終わってから字幕を消すまで
  const hasDom = typeof document !== "undefined";
  const $ = (id) => (hasDom ? document.getElementById(id) : null);
  const ui = {
    enter: $("btnRec"), exit: $("btnRecExit"), credit: $("recCredit"), captions: $("recCaptions"),
    user: $("recUser"), aiLine: $("recAiLine"), aiName: $("recAiName"), ai: $("recAiText"),
  };
  let revealTimer = null, clearTimer = null;

  // 声のクレジット。話者の名前「まお（ノーマル）」からスタイル名を外して、エンジンの書き方に合わせる
  //  VOICEVOX は「VOICEVOX:四国めたん」、AivisSpeech は「AivisSpeech: まお」（モデルの作者の指定）
  function creditFor(engine, speakerName) {
    const name = String(speakerName || "").replace(/[（(][^（）()]*[）)]\s*$/, "").trim();
    if (!name || !engine) return "";
    return /^voicevox$/i.test(engine) ? `VOICEVOX:${name}` : `${engine}: ${name}`;
  }
  // 聞き取り中の表示（local-voice.js の onInterim）から、字幕に出す言葉だけを取り出す（「認識中…（1.2秒）」などは出さない）
  function hearingText(text) {
    const t = String(text || "").trim();
    if (!t || /^(…|認識中|聞き取り中…|（周りの声)/.test(t)) return "";
    return t.replace(/^（続きを待っています）/, "");
  }

  const isOn = () => hasDom && document.body.classList.contains("rec");
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
    if (on && document.body.classList.contains("ambient")) window.AmaneAmbient?.set(false);   // 表示だけモードとは同時に使わない
    document.body.classList.toggle("rec", on);
    remember(on);
    fullscreen(on);
    if (on) reveal(); else document.body.classList.remove("rec-reveal");
  }

  // 画面をタップしたら、終えるボタンを少しの間だけ出す（全画面が外れていたら戻す）
  function reveal() {
    if (!isOn()) return;
    fullscreen(true);
    document.body.classList.add("rec-reveal");
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => document.body.classList.remove("rec-reveal"), REVEAL_MS);
  }

  // 字幕の行を書き換える。空の行は隠す（話しかけた言葉だけ・返事だけのときもある）
  function setLine(el, text) {
    if (!el) return;
    el.textContent = text;
    ui.user?.classList.toggle("off", !ui.user.textContent);
    ui.aiLine?.classList.toggle("off", !ui.ai?.textContent);
  }
  const setAi = (text) => setLine(ui.ai, text);

  // 話しかけた言葉（言い終わり）。「（続き）〜」は前の言葉につなげる。新しい発言になったら、前の返事は消す
  function said(text) {
    clearTimeout(clearTimer);
    const t = String(text || "").trim();
    if (t.startsWith("（続き）")) return setLine(ui.user, (ui.user?.textContent || "") + t.slice(4));
    setAi("");
    setLine(ui.user, t);
  }
  // 聞き取り中（途中の言葉）。字幕に出せる言葉があるときだけ書き換える
  function hearing(text) {
    const t = hearingText(text);
    if (t) { clearTimeout(clearTimer); setLine(ui.user, t); }
  }
  // いま話している返事の文
  function speaking(text) {
    clearTimeout(clearTimer);
    setAi(String(text || "").trim());
  }
  // 会話が終わったら、少し待って字幕を消す
  function clear() {
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => { setLine(ui.user, ""); setAi(""); }, CLEAR_MS);
  }
  function setCredit(text) { if (ui.credit) ui.credit.textContent = text || ""; }
  function setName(name) { if (ui.aiName) ui.aiName.textContent = name || ""; }

  if (hasDom) {
    if (ui.enter) ui.enter.onclick = (e) => { e.stopPropagation(); set(true); };
    if (ui.exit) ui.exit.onclick = (e) => { e.stopPropagation(); set(false); };
    for (const ev of ["click", "pointerup"]) document.addEventListener(ev, (e) => { if (e.target !== ui.exit) reveal(); });
    window.addEventListener("keydown", (e) => {
      const t = e.target;
      if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.isComposing) return;   // Ctrl+R（再読み込み）などでは切り替えない
      if (e.code === "KeyR") set(!isOn());
    });
    try {
      const q = new URLSearchParams(location.search).get("rec");
      if (q === "0" || q === "1") remember(q === "1");
      if (localStorage.getItem(KEY) === "1") document.body.classList.add("rec");
    } catch {}
    setAi("");
  }

  return { set, isOn, said, hearing, speaking, clear, setCredit, setName, creditFor, hearingText };
})();
