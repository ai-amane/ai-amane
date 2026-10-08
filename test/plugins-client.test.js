// 追加機能の画面側（public/plugins.js）の、表示とタグの扱いのテスト
//  ブラウザの部品は使わない関数だけを、vm で読み込んで確かめる
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load() {
  const ctx = vm.createContext({ window: {}, URL });   // URL: ブラウザにある部品（怪しい URL の判定で使う）
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "plugins.js"), "utf8"), ctx);
  return ctx.window.AmanePlugins;
}
const { remainText, splitTag } = load();

test("残り時間: 分:秒（1時間以上は 時:分:秒）。端数は切り上げ、過ぎたら 0:00", () => {
  assert.equal(remainText(185000), "3:05");
  assert.equal(remainText(59001), "1:00");
  assert.equal(remainText(3723000), "1:02:03");
  assert.equal(remainText(-5000), "0:00");
});

test("タグ: do を動作の名前に、ほかの属性を引数に分ける", () => {
  const { name, args } = splitTag({ do: "timer.set", seconds: "180", label: "カップ麺" });
  assert.equal(name, "timer.set");
  assert.deepEqual({ ...args }, { seconds: "180", label: "カップ麺" });
  assert.equal(splitTag({}).name, "");
});

// 確認のボタン（showConfirm）を、偽物の画面と偽物のサーバーで確かめる
function fakeDom() {
  const el = (tag) => ({
    tag, children: [], textContent: "", disabled: false, attrs: {}, className: "", id: "", onclick: null, removed: false,
    append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; },
    setAttribute(k, v) { this.attrs[k] = v; }, remove() { this.removed = true; },
  });
  const box = el("div");
  const find = (node, pred) => (pred(node) ? node : node.children.map((c) => find(c, pred)).find(Boolean));
  return { box, find, document: { getElementById: (id) => (id === "pluginConfirm" ? box : null), createElement: el } };
}
function loadWithDom(dom, fetchImpl) {
  const ctx = vm.createContext({ window: {}, document: dom.document, fetch: fetchImpl, setTimeout, setInterval, clearInterval, clearTimeout, Date, Headers, URL, localStorage: { getItem: () => "dtest1234", setItem() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "plugins.js"), "utf8"), ctx);
  return ctx.window.AmanePlugins;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("確認のボタン: 押したあとに期限が来ても、サーバーの結果（実行した）を伝える", async () => {
  const dom = fakeDom();
  const plugins = loadWithDom(dom, async () => { await sleep(800); return { ok: true, status: 200, json: async () => ({ kind: "command", text: "開けました。" }) }; });
  const results = [];
  plugins.showConfirm({ id: "a".repeat(32), title: "SwitchBot：鍵を開ける", text: "玄関の鍵を開けますか？", label: "鍵を開ける", ttlMs: 2600 }, (r) => results.push(r));
  const card = dom.box.children[0];
  const yes = dom.find(card, (n) => n.className.includes("confirm-yes"));
  assert.equal(yes.textContent, "鍵を開ける");
  assert.equal(dom.find(card, (n) => n.className === "confirm-title").textContent, "SwitchBot：鍵を開ける");
  assert.equal(yes.disabled, true);   // 出てすぐは押せない
  await sleep(1100);
  assert.equal(yes.disabled, false);
  yes.onclick({ stopPropagation() {} });   // 残り 0.5 秒ほどで押す（サーバーの返事は 0.8 秒後）
  await sleep(1200);
  assert.equal(results.length, 1);
  assert.deepEqual([results[0].ok, results[0].text], [true, "開けました。"]);
});

test("確認のボタン: 押さずに期限が来たら、実行していないことを伝える。二度押しはしない", async () => {
  const dom = fakeDom();
  let posts = 0;
  const plugins = loadWithDom(dom, async () => { posts++; return { ok: true, status: 200, json: async () => ({ kind: "cancelled", text: "やめました。" }) }; });
  const results = [];
  plugins.showConfirm({ id: "b".repeat(32), text: "開けますか？", ttlMs: 1300 }, (r) => results.push(r));
  await sleep(600);
  assert.equal(results.length, 1);
  assert.equal(results[0].expired, true);
  const dom2 = fakeDom();
  const plugins2 = loadWithDom(dom2, async () => { posts++; return { ok: true, status: 200, json: async () => ({ kind: "cancelled", text: "やめました。" }) }; });
  plugins2.showConfirm({ id: "c".repeat(32), text: "開けますか？", ttlMs: 60000 }, () => {});   // 「やめる」を押すので、期限の数えは止まる
  const no = dom2.find(dom2.box.children[0], (n) => n.className.includes("confirm-no"));
  no.onclick({ stopPropagation() {} }); no.onclick({ stopPropagation() {} });
  await sleep(50);
  assert.equal(posts, 1);
});

test("残りの秒数: 端数は切り上げ、過ぎたら 0", () => {
  const { secondsLeft } = load();
  assert.equal(secondsLeft(10500, 10000), 1);
  assert.equal(secondsLeft(12000, 10000), 2);
  assert.equal(secondsLeft(9000, 10000), 0);
});

test("声の答え: 「お願い」「はい」は yes、「やめて」「いいえ」は no。ほかの話は答えにしない", () => {
  const { voiceAnswerOf } = load();
  for (const t of ["お願い", "お願いします。", "はい", "はい、お願いします", "実行して", "開けて！", "うん、いいよ", "OK", "じゃあ、お願い"]) assert.equal(voiceAnswerOf(t), "yes", t);
  for (const t of ["やめて", "いいえ", "キャンセル", "やめといて", "だめ"]) assert.equal(voiceAnswerOf(t), "no", t);
  for (const t of ["はいはい、それより天気は？", "お願いがあるんだけど", "開けておいて、窓を", "今日はやめておこうかな", ""]) assert.equal(voiceAnswerOf(t), "", t);
});

test("怪しい URL: 長い文字列が付いている・IP アドレスで指しているものだけを確かめる", () => {
  const { urlRisk } = load();
  for (const ok of ["https://www.youtube.com/watch?v=K4DyBUG242c", "https://www.nhk.or.jp/news/", "https://ja.wikipedia.org/wiki/東京スカイツリー", "map:東京駅", "sample.png"]) assert.equal(urlRisk(ok), "", ok);
  assert.match(urlRisk("http://203.0.113.5/page"), /IP アドレス/);
  assert.match(urlRisk("https://attacker.example/?d=" + "A".repeat(80)), /長い文字列/);
  assert.match(urlRisk("https://attacker.example/" + "x".repeat(10) + "/" + "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlq"), /長い文字列/);
});

test("確認のボタン: 声でも決められる（画面だけの確認も、渡した処理で決める）", async () => {
  const dom = fakeDom();
  const plugins = loadWithDom(dom, async () => { throw new Error("サーバーには送らない"); });
  const results = [];
  const decided = [];
  const handle = plugins.showConfirm({ id: "local1", title: "作業の依頼", text: "頼みますか？", label: "頼む", voice: "any", ttlMs: 60000 }, (r) => results.push(r), { decide: async (ok) => { decided.push(ok); return { ok: true, kind: "command", text: "始めました" }; } });
  assert.equal(plugins.activeConfirm(), handle);
  assert.match(dom.find(dom.box.children[0], (n) => n.className === "confirm-hint").textContent, /声でも決められます/);
  assert.equal(handle.say(true), false);   // 出たばかりの確認には、声の答えを受け付けない（前の確認への答えかもしれない）
  await sleep(1600);
  assert.equal(handle.say(true), true);
  await sleep(20);
  assert.deepEqual(decided, [true]);
  assert.deepEqual([results[0].ok, results[0].by, results[0].text], [true, "voice", "始めました"]);
  assert.equal(plugins.activeConfirm(), null);
  // 新しい確認が出たら、前の確認は期限切れと同じに扱う
  const r2 = [];
  plugins.showConfirm({ id: "local2", text: "1つ目", ttlMs: 60000 }, (r) => r2.push(r), { decide: async () => ({ ok: true }) });
  const last = plugins.showConfirm({ id: "local3", text: "2つ目", voice: "none", ttlMs: 60000 }, () => {}, { decide: async () => ({ ok: true }) });
  assert.equal(r2[0].expired, true);
  assert.match(dom.find(dom.box.children[0], (n) => n.className === "confirm-hint").textContent, /画面のボタンで/);
  last.cancel();   // 期限の数え（setInterval）を止める
});
