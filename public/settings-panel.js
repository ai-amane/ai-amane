// 設定の画面（index.html の #settingsDialog）。開く・閉じる・分類（声・聞き取り・会話など）の切り替え・探す
//  それぞれの設定の中身は app.js・persona-panel.js・lan-panel.js が受け持つ。ここは見せ方だけ
//  分類の中で、いまの声のエンジンなどでは使わない項目は、app.js が style.display で隠す（探すときも出さない）
window.AmaneSettings = (() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const ui = {
    open: $("btnSettings"), dialog: $("settingsDialog"), close: $("settingsClose"),
    search: $("settingsSearch"), noHit: $("settingsNoHit"),
  };
  if (!ui.dialog) return { onOpen() {}, isOpen: () => false };
  const tabs = [...ui.dialog.querySelectorAll("[data-tab]")];
  const pages = [...ui.dialog.querySelectorAll("[data-page]")];
  const pageOf = (name) => pages.find((p) => p.dataset.page === name);
  const KEY = "amane.settingsTab";   // 最後に選んだ分類（この画面ごとに覚える）
  const openHandlers = [];
  let currentName = null;            // いま選んでいる分類
  let openedByPointer = false;

  const remembered = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
  const remember = (name) => { try { localStorage.setItem(KEY, JSON.stringify(name)); } catch {} };
  // 使えない分類（iPad・スマホの設定がオフのときなど）は、ページに hidden が付く。その分類のボタンも隠す
  const usable = (tab) => !pageOf(tab.dataset.tab)?.hidden;
  const usableName = (name) => tabs.some((t) => t.dataset.tab === name && usable(t));
  const isOpen = () => ui.dialog.hasAttribute("open");

  // 読み上げソフト向けに、分類のボタンとページを結びつける
  for (const t of tabs) {
    const page = pageOf(t.dataset.tab);
    t.id = "sdTab-" + t.dataset.tab;
    if (!page) continue;
    if (!page.id) page.id = "sdPage-" + t.dataset.tab;
    t.setAttribute("aria-controls", page.id);
    page.setAttribute("aria-labelledby", t.id);
  }

  function render() {
    const searching = ui.dialog.classList.contains("searching");
    for (const t of tabs) {
      const on = t.dataset.tab === currentName;
      t.setAttribute("aria-selected", String(on && !searching));   // 探しているときは、全部の分類から出す
      t.tabIndex = on ? 0 : -1;
      t.toggleAttribute("autofocus", on);   // 開いたときは選んでいる分類にフォーカス（探す欄だと、iPad などで文字のキーボードが出る）
      pageOf(t.dataset.tab)?.classList.toggle("active", on);
    }
  }
  // name の分類を選ぶ。使えなければ、使える最初の分類（覚えている分類は変えない。使えるようになったら戻れるように）
  function select(name) {
    const tab = tabs.find((t) => t.dataset.tab === name && usable(t)) || tabs.find(usable);
    if (!tab) return;
    currentName = tab.dataset.tab;
    render();
  }
  // 人が選んだとき（押す・矢印キー）: 探す文字を消して、その分類を出し、覚える
  function choose(name) {
    if (ui.search.value) { ui.search.value = ""; filter(); }
    select(name);
    remember(currentName);
  }

  function syncTabs() {
    for (const t of tabs) t.hidden = !usable(t);
    const want = remembered();
    // 閉じている間に、覚えていた分類が使えるようになったら（iPad・スマホの準備ができたときなど）、そちらに戻す
    if (!isOpen() && want !== currentName && usableName(want)) select(want);
    else if (!usableName(currentName)) select(want);
  }

  // 探す: 文字が入っていれば、すべての分類から当てはまる項目だけを出す（ページの見出しは残す）
  //  ひらがな・カタカナ、全角・半角、大文字・小文字の違いは問わない
  const fold = (s) => String(s).normalize("NFKC").toLowerCase().replace(/\s+/g, "")
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  // app.js が隠している項目（いまの声のエンジンでは使わないもの）か
  const shownByApp = (el, page) => {
    for (let n = el; n && n !== page; n = n.parentElement) if (n.style.display === "none") return false;
    return true;
  };
  function filter() {
    const q = fold(ui.search.value);
    ui.dialog.classList.toggle("searching", !!q);
    let hits = 0;
    // 使えないページの項目も付け直す（あとで使えるようになったとき、前に探した結果で隠れたままにしない）
    for (const page of pages) {
      let pageHits = 0;
      // 分類の名前や読み（「声」「こえ」など）で探したら、その分類の項目を全部出す
      const pageWords = fold((page.querySelector("h3")?.textContent || "") + " " + (page.dataset.keywords || ""));
      for (const item of page.querySelectorAll(".setting")) {
        const match = !q || pageWords.includes(q) || fold(item.textContent + " " + (item.dataset.keywords || "")).includes(q);
        item.hidden = !match;
        if (match && shownByApp(item, page)) pageHits++;
      }
      page.classList.toggle("no-hit", !!q && !pageHits);
      if (!page.hidden) hits += pageHits;
    }
    ui.noHit.classList.toggle("show", !!q && !hits);
    render();
  }

  // <dialog> がない古いブラウザ（iPadOS 15.3 まで）でも、開け閉めはできるようにする
  function open() {
    if (isOpen()) return;
    syncTabs();
    const want = remembered();
    if (want !== currentName && usableName(want)) select(want);
    if (typeof ui.dialog.showModal === "function") ui.dialog.showModal();
    else {
      ui.dialog.classList.add("no-modal");
      ui.dialog.setAttribute("open", "");
      tabs.find((t) => t.dataset.tab === currentName)?.focus();
    }
    for (const fn of openHandlers) { try { fn(); } catch (e) { console.error(e); } }
  }
  function close() {
    if (typeof ui.dialog.close === "function") return ui.dialog.close();
    ui.dialog.removeAttribute("open");
    onClosed();
  }
  function onClosed() {
    // 閉じたら探す文字を消す（次に開いたときは、選んでいた分類から）
    if (ui.search.value) { ui.search.value = ""; filter(); }
    // マウスやタップで開いたときは、「設定」のボタンにフォーカスを残さない（残すと、次の Space で会話でなく設定が開く）
    if (openedByPointer && document.activeElement === ui.open) ui.open.blur();
  }

  ui.open?.addEventListener("click", (e) => { openedByPointer = e.detail > 0; open(); });
  ui.close?.addEventListener("click", close);
  ui.dialog.addEventListener("close", onClosed);
  // 外側（暗くなったところ）を押したら閉じる。中で押して外で離したとき（文字を選んでいたときなど）は閉じない
  let downOnBackdrop = false;
  ui.dialog.addEventListener("pointerdown", (e) => { downOnBackdrop = e.target === ui.dialog; });
  ui.dialog.addEventListener("click", (e) => { if (e.target === ui.dialog && downOnBackdrop) close(); });
  for (const t of tabs) t.addEventListener("click", () => choose(t.dataset.tab));
  // 分類のボタンは、矢印キーでも選べる（上下・左右どちらでも）
  ui.dialog.querySelector('[role="tablist"]')?.addEventListener("keydown", (e) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const list = tabs.filter(usable);
    const next = list[(list.findIndex((t) => t.dataset.tab === currentName) + step + list.length) % list.length];
    if (next) { choose(next.dataset.tab); next.focus(); }
  });
  ui.search.addEventListener("input", filter);
  // 探しているときの Esc は、まず探す文字を消す（もう一度 Esc で閉じる）。変換中の Esc は、変換の取り消しに使う
  ui.search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.isComposing && ui.search.value) { e.preventDefault(); ui.search.value = ""; filter(); }
  });
  // 分類が使えるようになった・使えなくなった（lan-panel.js が hidden を付け外しする）
  for (const page of pages) {
    new MutationObserver(() => { syncTabs(); filter(); }).observe(page, { attributes: true, attributeFilter: ["hidden"] });
  }
  syncTabs();

  // onOpen(fn): 設定を開いたとき（LAN の状態や声の一覧を取り直すのに使う）
  return { onOpen: (fn) => openHandlers.push(fn), isOpen };
})();
