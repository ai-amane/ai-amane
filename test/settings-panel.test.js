// 設定の画面（public/settings-panel.js）のテスト
//  本物の index.html を linkedom で読み込み、分類の切り替え・探す・使えない分類を隠すを確かめる
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { parseHTML } = require("linkedom");

const PUBLIC = path.join(__dirname, "..", "public");
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), "utf8");

// stored: localStorage に入っている値（最後に開いた分類など）
function load(stored = {}) {
  const win = parseHTML(read("index.html"));
  const doc = win.document;
  const dialog = doc.getElementById("settingsDialog");
  // linkedom には dialog の開け閉めがないので、open の属性だけで代わりをする
  Object.defineProperty(dialog, "open", { get() { return this.hasAttribute("open"); } });
  dialog.showModal = function () { this.setAttribute("open", ""); };
  dialog.close = function () { this.removeAttribute("open"); };
  const storage = { ...stored };
  const localStorage = { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); } };
  const ctx = vm.createContext({ window: {}, document: doc, localStorage, MutationObserver: win.MutationObserver, console });
  vm.runInContext(read("settings-panel.js"), ctx);
  const $ = (id) => doc.getElementById(id);
  const tab = (name) => doc.querySelector(`[data-tab="${name}"]`);
  const page = (name) => doc.querySelector(`[data-page="${name}"]`);
  const search = (q) => { $("settingsSearch").value = q; $("settingsSearch").dispatchEvent(new win.Event("input")); };
  const shownPages = () => [...doc.querySelectorAll("[data-page]")]
    .filter((p) => !p.hidden && (dialog.classList.contains("searching") ? !p.classList.contains("no-hit") : p.classList.contains("active")))
    .map((p) => p.dataset.page);
  return { api: ctx.window.AmaneSettings, doc, dialog, storage, $, tab, page, search, shownPages, win };
}

test("「設定」で開き、× で閉じる。開いたときに onOpen が呼ばれる", () => {
  const { api, dialog, $, win } = load();
  let opened = 0;
  api.onOpen(() => opened++);
  assert.equal(api.isOpen(), false);
  $("btnSettings").dispatchEvent(new win.Event("click"));
  assert.equal(dialog.open, true);
  assert.equal(api.isOpen(), true);
  assert.equal(opened, 1);
  $("settingsClose").dispatchEvent(new win.Event("click"));
  assert.equal(dialog.open, false);
});

test("分類: 最初は「声」。選んだ分類だけを出し、次に開いたときのために覚える", () => {
  const { tab, page, storage, shownPages, win } = load();
  assert.deepEqual(shownPages(), ["voice"]);
  assert.equal(tab("voice").getAttribute("aria-selected"), "true");
  tab("talk").dispatchEvent(new win.Event("click"));
  assert.deepEqual(shownPages(), ["talk"]);
  assert.equal(tab("voice").getAttribute("aria-selected"), "false");
  assert.equal(page("voice").classList.contains("active"), false);
  assert.equal(storage["amane.settingsTab"], JSON.stringify("talk"));
});

test("分類: 覚えていた分類で開く。覚えていた値がおかしいときは「声」", () => {
  assert.deepEqual(load({ "amane.settingsTab": JSON.stringify("persona") }).shownPages(), ["persona"]);
  assert.deepEqual(load({ "amane.settingsTab": "{壊れた" }).shownPages(), ["voice"]);
  assert.deepEqual(load({ "amane.settingsTab": JSON.stringify("nothing") }).shownPages(), ["voice"]);
});

const tick = () => new Promise((r) => setTimeout(r, 0));   // MutationObserver の知らせを待つ

test("iPad・スマホの分類は、その設定が使えるとき（lan-panel.js が hidden を外したとき）だけ出す", async () => {
  const { tab, page, storage, win } = load({ "amane.settingsTab": JSON.stringify("lan") });
  assert.equal(tab("lan").hidden, true);
  assert.equal(tab("voice").getAttribute("aria-selected"), "true");   // 使えない分類を覚えていたら、使える分類で開く
  assert.equal(storage["amane.settingsTab"], JSON.stringify("lan"));  // 覚えている分類は消さない
  page("lan").hidden = false;                                         // 読み込みの少しあとに使えるようになる
  await tick();
  assert.equal(tab("lan").hidden, false);
  assert.equal(tab("lan").getAttribute("aria-selected"), "true");     // 閉じている間なら、覚えていた分類に戻る
  tab("voice").dispatchEvent(new win.Event("click"));
  tab("lan").dispatchEvent(new win.Event("click"));
  assert.equal(tab("lan").getAttribute("aria-selected"), "true");
  // 選んでいるときに使えなくなったら、ほかの分類に移る
  page("lan").hidden = true;
  await tick();
  assert.equal(tab("lan").hidden, true);
  assert.equal(tab("voice").getAttribute("aria-selected"), "true");
});

test("探す: すべての分類から当てはまる項目だけを出す（キーワードでも、大文字・小文字を問わず）", () => {
  const { search, shownPages, doc, $ } = load();
  search("マイク");
  assert.deepEqual(shownPages(), ["listen"]);
  const shown = [...doc.querySelectorAll('[data-page="listen"] .setting')].filter((s) => !s.hidden).map((s) => s.id);
  assert.deepEqual(shown, ["micSensRow"]);
  search("名前");   // 呼びかけの言葉はキーワードの「名前」で当たる
  assert.deepEqual(shownPages(), ["talk", "persona"]);
  search("音量");   // 声の大きさのキーワード
  assert.deepEqual(shownPages(), ["voice"]);
  search("ELEVENLABS");
  assert.ok(shownPages().includes("voice"));
  assert.equal($("settingsNoHit").classList.contains("show"), false);
});

test("探す: 見つからないときは知らせる。消したら、選んでいた分類に戻る", () => {
  const { search, shownPages, dialog, doc, $ } = load();
  search("見つからない言葉");
  assert.deepEqual(shownPages(), []);
  assert.equal($("settingsNoHit").classList.contains("show"), true);
  search("");
  assert.equal(dialog.classList.contains("searching"), false);
  assert.equal($("settingsNoHit").classList.contains("show"), false);
  assert.deepEqual(shownPages(), ["voice"]);
  assert.equal(doc.querySelectorAll(".setting[hidden]").length, 0);
});

test("探す: いまの声のエンジンなどで app.js が隠している項目は、当たっても数えない", () => {
  const { search, shownPages, $ } = load();
  $("agentRow").style.display = "none";            // VOICEVOX のときの Agent ID
  $("micSensRow").style.display = "none";          // ブラウザの音声認識のときのマイクの感度
  search("エージェント");
  assert.deepEqual(shownPages(), []);
  search("感度");
  assert.deepEqual(shownPages(), []);
  $("vvRow").style.display = "none";               // ElevenLabs のときの声の種類・速さ（中の項目ごと隠れる）
  search("速度");
  assert.deepEqual(shownPages(), []);
});

test("探す: 分類のボタンを押したら、探す文字を消してその分類を出す", () => {
  const { search, shownPages, tab, $, win } = load();
  search("マイク");
  tab("look").dispatchEvent(new win.Event("click"));
  assert.equal($("settingsSearch").value, "");
  assert.deepEqual(shownPages(), ["look"]);
});

test("index.html: 画面のスクリプトが使う ID が、すべてある", () => {
  const html = read("index.html");
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const f of ["app.js", "settings-panel.js", "persona-panel.js", "lan-panel.js", "ambient.js", "rec-mode.js", "viewer.js", "plugins.js"]) {
    const used = [...read(f).matchAll(/(?:\$|getElementById)\("([A-Za-z][\w-]*)"\)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(used)].filter((id) => !ids.has(id)), [], `${f} が使う ID`);
  }
  // 分類のボタンとページが 1 対 1
  const tabs = [...html.matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]);
  const pages = [...html.matchAll(/data-page="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, pages);
});

test("探す: 閉じたら探す文字を消す（次に開いたときは、選んでいた分類から）", () => {
  const { search, shownPages, dialog, $, win } = load();
  search("マイク");
  dialog.close();
  dialog.dispatchEvent(new win.Event("close"));
  assert.equal($("settingsSearch").value, "");
  assert.deepEqual(shownPages(), ["voice"]);
});

test("開いている間に覚えていた分類が使えるようになっても、見ている分類は変えない", async () => {
  const { tab, page, $, win } = load({ "amane.settingsTab": JSON.stringify("lan") });
  $("btnSettings").dispatchEvent(new win.Event("click"));
  page("lan").hidden = false;
  await tick();
  assert.equal(tab("voice").getAttribute("aria-selected"), "true");
  assert.equal(tab("lan").hidden, false);
});

test("探す: 探している間に使えるようになった分類も、当てはまる項目だけを出す。探したあとに隠れたままにしない", async () => {
  const { search, shownPages, page, doc, win } = load();
  const lanItem = () => doc.querySelector('[data-page="lan"] .setting');
  search("マイク");
  page("lan").hidden = false;
  await tick();
  assert.deepEqual(shownPages(), ["listen"]);
  assert.equal(lanItem().hidden, true);
  page("lan").hidden = true;    // 探している間に使えなくなり（状態が読めなかったときなど）
  await tick();
  search("");                   // 探す文字を消して
  page("lan").hidden = false;   // また使えるようになったとき
  await tick();
  assert.equal(lanItem().hidden, false);
  search("ipad");
  assert.ok(shownPages().includes("lan"));
});

test("探す: ひらがな・カタカナ、全角・半角の違いは問わない", () => {
  const { search, shownPages } = load();
  search("まいく");
  assert.deepEqual(shownPages(), ["listen"]);
  search("ＥＬＥＶＥＮＬＡＢＳ");
  assert.ok(shownPages().includes("voice"));
});

test("探す: 分類の名前や読みで探したら、その分類の項目を全部出す", () => {
  const { search, shownPages, doc } = load();
  const visibleIn = (name) => [...doc.querySelectorAll(`[data-page="${name}"] .setting`)].filter((s) => !s.hidden).length;
  const all = (name) => doc.querySelectorAll(`[data-page="${name}"] .setting`).length;
  search("さぎょう");
  assert.deepEqual(shownPages(), ["tasks"]);
  assert.equal(visibleIn("tasks"), all("tasks"));
  search("こえ");                // 「声」の分類（「聞こえた」が入っている呼びかけの言葉も当たる）
  assert.deepEqual(shownPages(), ["voice", "talk"]);
  assert.equal(visibleIn("voice"), all("voice"));
  search("見た目");
  assert.deepEqual(shownPages(), ["look"]);
});

test("探す: 探している間は、どの分類も選んでいない扱いにする（全部の分類から出しているので）", () => {
  const { search, tab } = load();
  search("マイク");
  assert.equal(tab("voice").getAttribute("aria-selected"), "false");
  search("");
  assert.equal(tab("voice").getAttribute("aria-selected"), "true");
});

test("矢印キーで分類を選べる（探している文字は消す）。使えない分類は飛ばす", () => {
  const { doc, tab, search, shownPages, storage, $, win } = load({ "amane.settingsTab": JSON.stringify("look") });
  const press = (key) => doc.querySelector('[role="tablist"]').dispatchEvent(Object.assign(new win.Event("keydown"), { key }));
  press("ArrowDown");            // 見た目の次の iPad・スマホは使えないので、最初の「声」に戻る
  assert.deepEqual(shownPages(), ["voice"]);
  press("ArrowUp");
  assert.deepEqual(shownPages(), ["look"]);
  search("マイク");
  press("ArrowLeft");
  assert.equal($("settingsSearch").value, "");
  assert.deepEqual(shownPages(), ["tasks"]);
  assert.equal(storage["amane.settingsTab"], JSON.stringify("tasks"));
  assert.equal(tab("tasks").hasAttribute("autofocus"), true);   // 次に開いたときは、この分類にフォーカス
});

test("Esc: 探す文字があれば、まず文字を消す（閉じない）。変換中の Esc は使わない", () => {
  const { search, dialog, $, win } = load();
  $("btnSettings").dispatchEvent(new win.Event("click"));
  const esc = (extra = {}) => {
    const e = Object.assign(new win.Event("keydown", { cancelable: true }), { key: "Escape", ...extra });
    $("settingsSearch").dispatchEvent(e);
    return e;
  };
  search("マイク");
  esc({ isComposing: true });
  assert.equal($("settingsSearch").value, "マイク");
  const e = esc();
  assert.equal($("settingsSearch").value, "");
  assert.equal(e.defaultPrevented, true);   // ブラウザが dialog を閉じないように
  assert.equal(dialog.open, true);
  assert.equal(esc().defaultPrevented, false);   // 文字がなければ、ブラウザに任せて閉じる
});

test("外側（暗いところ）を押したら閉じる。中で押して外で離したときは閉じない", () => {
  const { dialog, $, win } = load();
  $("btnSettings").dispatchEvent(new win.Event("click"));
  $("settingsSearch").dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
  dialog.dispatchEvent(new win.Event("click"));
  assert.equal(dialog.open, true);
  dialog.dispatchEvent(new win.Event("pointerdown"));
  dialog.dispatchEvent(new win.Event("click"));
  assert.equal(dialog.open, false);
});

test("読み上げソフト向けに、分類のボタンとページを結びつける", () => {
  const { tab, page } = load();
  assert.equal(tab("voice").getAttribute("aria-controls"), page("voice").id);
  assert.equal(page("voice").getAttribute("aria-labelledby"), tab("voice").id);
  assert.equal(page("lan").id, "lanRow");   // lan-panel.js が使う ID はそのまま
});
