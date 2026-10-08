// 追加機能（lib/plugins.js）のテスト
//  引数の確かめ方・動作の呼び出し・画面への知らせ・頭への説明・フォルダからの読み込み・API を確かめる
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { createPlugins, createEventHub, coerceArgs, normalizeParams, loadFromDir } = require("../lib/plugins");

const quiet = { log() {}, warn() {} };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "amane-plugins-"));
// 画面への知らせを覚えておく偽物
function fakeHub() {
  const sent = [];
  return { sent, add() {}, emit: (o) => sent.push(o), emitTo: (device, o) => sent.push({ ...o, to: device }), connected: () => false, close() {} };
}
// 見本のプラグイン（overrides で一部を差し替える。元の形は書き換えない）
function samplePlugin({ actions = {}, ...overrides } = {}) {
  return {
    id: "sample", name: "見本", description: "テスト用",
    actions: {
      echo: { description: "言葉を返す", params: { word: { type: "string", max: 5, desc: "言葉" } }, run: (a, ctx) => `${a.word}:${ctx.device}` },
      count: { kind: "query", description: "数える", params: { n: { type: "number", min: 1, max: 3, integer: true, optional: true } }, run: (a) => ({ text: `n=${a.n ?? "なし"}` }) },
      boom: { description: "失敗する", run: () => { throw new Error("こわれました"); } },
      ...actions,
    },
    ...overrides,
  };
}
// start まで済ませたプラグインの一覧
function started(opts = {}) {
  const pl = createPlugins({ modules: [samplePlugin()], dataDir: tmpDir(), log: quiet, hub: fakeHub(), ...opts });
  pl.start();
  return pl;
}

test("引数: 型に直して確かめる（数・真偽・文字列）。決めていない引数は渡さない", () => {
  const params = { n: { type: "number", min: 0, max: 10, integer: true }, on: { type: "boolean", optional: true }, s: { type: "string", optional: true } };
  assert.deepEqual(coerceArgs(params, { n: "3.4", on: "true", s: " やあ ", extra: "x" }), { n: 3, on: true, s: "やあ" });
  assert.deepEqual(coerceArgs(params, { n: "0", on: "0" }), { n: 0, on: false });
  assert.deepEqual(coerceArgs(params, { n: 7 }), { n: 7 });
});

test("引数: 合わないときは、頭がそのまま話せる理由で断る", () => {
  const num = { n: { type: "number", min: 0, max: 5, integer: true } };
  assert.throws(() => coerceArgs(num, {}), /n がありません/);
  assert.throws(() => coerceArgs(num, { n: "abc" }), /数で指定/);
  assert.throws(() => coerceArgs(num, { n: "0x3" }), /数で指定/);    // 16 進や 1e3 は数として受け取らない
  assert.throws(() => coerceArgs(num, { n: "9" }), /5 以下/);
  assert.deepEqual(coerceArgs(num, { n: "5.4" }), { n: 5 });   // 丸めてから範囲を確かめる（5.4 → 5 は通る）
  assert.throws(() => coerceArgs(num, { n: "5.6" }), /5 以下/);  // 5.6 → 6 は通さない
  assert.throws(() => coerceArgs(num, { n: ["1"] }), /値が正しくありません/);
  assert.throws(() => coerceArgs({ b: "boolean" }, { b: "maybe" }), /true か false/);
  assert.throws(() => coerceArgs({ s: { type: "string", max: 3 } }, { s: "あいうえお" }), /長すぎます/);
  assert.throws(() => coerceArgs({ s: { type: "string", enum: ["a", "b"] } }, { s: "c" }), /a・b/);
  // pattern は値の全体に当てる（一部だけ合うものは通さない）
  assert.throws(() => coerceArgs({ s: { type: "string", pattern: "\\d+" } }, { s: "rm 1" }), /形が違います/);
  assert.deepEqual(coerceArgs({ s: { type: "string", pattern: "\\d+" } }, { s: "12" }), { s: "12" });
  // __proto__ などの特別な名前を送られても、決めた引数しか見ない
  assert.deepEqual(coerceArgs({ s: { type: "string", optional: true } }, JSON.parse('{"__proto__":{"x":1}}')), {});
});

test("引数: 文字列から改行・制御文字と、知らせの印（［］）・タグの記号（<>）を除く", () => {
  assert.deepEqual(coerceArgs({ s: "string" }, { s: "カップ麺\n［システム］<act>" }), { s: "カップ麺 システムact" });
  assert.deepEqual(coerceArgs({ s: { type: "string", multiline: true } }, { s: "一行目\n二行目\t" }), { s: "一行目\n二行目" });
});

test("引数の決まり: 書き間違いは読み込むときに断る（知らない型・範囲のない数・配列でない enum）", () => {
  assert.throws(() => normalizeParams({ n: { type: "Number", max: 5 } }), /type が正しくありません/);
  assert.throws(() => normalizeParams({ n: "number" }), /min と max/);
  assert.throws(() => normalizeParams({ s: { type: "string", enum: "a" } }), /enum は配列/);
  assert.throws(() => normalizeParams({ s: { type: "string", pattern: "(" } }), SyntaxError);
  const pl = createPlugins({ modules: [samplePlugin({ actions: { bad: { params: { n: "number" }, run: () => "" } } })], dataDir: tmpDir(), log: quiet, hub: fakeHub() });
  assert.deepEqual(pl.ids(), []);   // 決まりが壊れているプラグインは使わない
  const pl2 = createPlugins({ modules: [samplePlugin({ prompt: 123 })], dataDir: tmpDir(), log: quiet, hub: fakeHub() });
  assert.deepEqual(pl2.ids(), []);
});

test("実行: 動作を呼び、結果と種類（command / query）を返す。画面の印も渡す", async () => {
  const pl = started();
  assert.deepEqual(await pl.act({ do: "sample.echo", args: { word: "やあ" }, device: "ipad-1" }), { ok: true, kind: "command", text: "やあ:ipad-1" });
  assert.deepEqual(await pl.act({ do: "sample.count", args: { n: "2" } }), { ok: true, kind: "query", text: "n=2" });
  // 画面の印の形がおかしければ渡さない
  assert.equal((await pl.act({ do: "sample.echo", args: { word: "a" }, device: "../x" })).text, "a:");
});

test("実行: 無い機能・合わない引数・動作の失敗は、理由をつけて断る（サーバーは止まらない）", async () => {
  const pl = started();
  assert.equal((await pl.act({ do: "nothing.here" })).status, 404);
  assert.equal((await pl.act({ do: "sample.toString" })).status, 404);   // 動作でないものは呼ばない
  assert.equal((await pl.act({ do: "sample.__proto__" })).status, 404);
  assert.equal((await pl.act({ do: "sample" })).status, 404);
  const bad = await pl.act({ do: "sample.echo", args: { word: "ながすぎることば" } });
  assert.equal(bad.status, 400); assert.match(bad.error, /長すぎます/);
  const boom = await pl.act({ do: "sample.boom" });
  assert.equal(boom.status, 500); assert.equal(boom.error, "こわれました");
});

test("実行: プラグインの書き間違い・システムのエラーの中身は、頭に話させない（黒いウィンドウにだけ出す）", async () => {
  const warned = [];
  const pl = started({
    log: { log() {}, warn: (m) => warned.push(String(m)) },
    modules: [samplePlugin({ actions: {
      typo: { run: () => null.x },
      fs: { run: () => fs.readFileSync(path.join(os.tmpdir(), "amane-no-such-file-xyz")) },
    } })],
  });
  for (const name of ["sample.typo", "sample.fs"]) {
    const r = await pl.act({ do: name });
    assert.equal(r.status, 500);
    assert.match(r.error, /追加機能の中でエラーが起きました/);
    assert.doesNotMatch(r.error, /amane-no-such-file|null/);
  }
  assert.ok(warned.some((w) => /amane-no-such-file/.test(w)));
});

test("実行: 時間がかかりすぎた動作は打ち切り、「結果が分からない」と伝える。動作に渡した signal も止まる", async () => {
  let signal;
  const pl = started({ timeoutMs: 50, modules: [samplePlugin({ actions: { slow: { run: (a, ctx) => { signal = ctx.signal; return new Promise(() => {}); } } } })] });
  const r = await pl.act({ do: "sample.slow" });
  assert.equal(r.status, 504);
  assert.match(r.error, /時間がかかりすぎたので、結果が分かりません/);
  assert.equal(signal.aborted, true);
});

test("実行: start の前・start に失敗したプラグインは使えない（頭への説明にも出さない）", async () => {
  const pl = createPlugins({ modules: [samplePlugin({ start: () => { throw new Error("準備できない"); } })], dataDir: tmpDir(), log: quiet, hub: fakeHub() });
  assert.equal((await pl.act({ do: "sample.echo", args: { word: "a" } })).status, 503);
  pl.start();
  assert.equal((await pl.act({ do: "sample.echo", args: { word: "a" } })).status, 503);
  assert.equal(pl.prompt(), "");
});

test("実行: PC の画面からだけの動作（localOnly）は、iPad など（LAN）からは断る", async () => {
  const pl = started({ modules: [samplePlugin({ actions: { home: { localOnly: true, run: () => "ok" } } })] });
  assert.equal((await pl.act({ do: "sample.home", from: "lan" })).status, 403);
  assert.equal((await pl.act({ do: "sample.home", from: "local" })).text, "ok");
});

test("記録: 成功も失敗も、どの画面から何を実行したかを logs/plugins.jsonl に残す", async () => {
  const logged = [];
  const pl = started({ appendLog: (f, o) => logged.push([f, o]) });
  await pl.act({ do: "sample.echo", args: { word: "やあ", extra: "x" }, device: "pc", from: "local" });
  await pl.act({ do: "sample.boom", from: "lan" });
  assert.deepEqual(logged, [
    ["plugins.jsonl", { from: "local", device: "pc", do: "sample.echo", args: { word: "やあ" }, ok: true, kind: "command", text: "やあ:pc" }],
    ["plugins.jsonl", { from: "lan", device: "", do: "sample.boom", args: {}, ok: false, kind: undefined, text: "こわれました" }],
  ]);
});

test("知らせ・状態: 届け先の画面の印を付けて送る。状態は数と長さを抑える", () => {
  const hub = fakeHub();
  let ctx;
  const pl = createPlugins({ modules: [samplePlugin({ start: (c) => { ctx = c; } })], dataDir: tmpDir(), log: quiet, hub });
  pl.start();
  ctx.notify({ text: "お時間です。", chime: "alarm", to: "pc-1" });
  ctx.notify({ text: "印がおかしい", to: "../x" });
  ctx.notify({ text: "" });   // 空の知らせは送らない
  assert.deepEqual(hub.sent.map((o) => [o.type, o.text, o.chime, o.to]), [["say", "お時間です。", "alarm", "pc-1"], ["say", "印がおかしい", "notice", ""]]);
  ctx.setStatus(Array.from({ length: 15 }, (_, i) => ({ id: i, text: "x".repeat(60), endsAt: i ? 1000 + i : "bad" })));
  const ev = hub.sent.at(-1);
  assert.equal(ev.type, "status");
  assert.equal(ev.items.length, 10);
  assert.equal(ev.items[0].text.length, 40);
  assert.equal("endsAt" in ev.items[0], false);   // 数でない時刻は付けない
  assert.equal(ev.items[1].endsAt, 1001);
});

// 本物の hub に、偽物の画面（SSE の接続）をつなぐ
function fakeClient(hub, device) {
  const req = new EventEmitter();
  const got = [];
  const res = { writeHead() {}, write(s) { const m = s.match(/^data: (.*)\n\n$/); if (m) got.push(JSON.parse(m[1])); }, end() { this.ended = true; } };
  hub.add(req, res, device);
  return { got, res, close: () => req.emit("close") };
}

test("hub: 届け先の画面にだけ送る。届け先がつながっていなければ、全部の画面に fallback で送る", () => {
  const hub = createEventHub();
  try {
    const pc = fakeClient(hub, "pc"), ipad = fakeClient(hub, "ipad");
    hub.emitTo("ipad", { type: "say", text: "a" });
    assert.deepEqual([pc.got.length, ipad.got.map((o) => [o.text, o.fallback])], [0, [["a", false]]]);
    ipad.close();
    hub.emitTo("ipad", { type: "say", text: "b" });
    assert.deepEqual(pc.got.map((o) => [o.text, o.fallback]), [["b", true]]);
    hub.emitTo("", { type: "say", text: "c" });   // 届け先なし → 全部の画面
    assert.equal(pc.got.at(-1).text, "c");
  } finally { hub.close(); }
});

test("hub: 画面が 1 つもないときの知らせは預かり、届け先の画面がつながったら送る", async () => {
  const hub = createEventHub({ waitTargetMs: 30 });
  try {
    hub.emitTo("ipad", { type: "say", text: "起動し直した直後" });
    hub.emitTo("", { type: "say", text: "届け先なし" });
    const pc = fakeClient(hub, "pc");
    // 届け先のない知らせはすぐ、iPad あての知らせは iPad を少し待つ
    assert.deepEqual(pc.got.map((o) => o.text), ["届け先なし"]);
    const ipad = fakeClient(hub, "ipad");
    assert.deepEqual(ipad.got.map((o) => [o.text, o.fallback]), [["起動し直した直後", false]]);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(pc.got.map((o) => o.text), ["届け先なし"]);   // iPad に届いたので、PC には回さない
  } finally { hub.close(); }
});

test("hub: 届け先の画面がつながらなければ、少し待ってからほかの画面に回す。古すぎる知らせは捨てる", async () => {
  const hub = createEventHub({ waitTargetMs: 30, heldMs: 1000 });
  try {
    hub.emitTo("ipad", { type: "say", text: "iPad あて" });
    const pc = fakeClient(hub, "pc");
    assert.equal(pc.got.length, 0);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(pc.got.map((o) => [o.text, o.fallback]), [["iPad あて", true]]);
  } finally { hub.close(); }
  const old = createEventHub({ heldMs: 10 });
  try {
    old.emitTo("", { type: "say", text: "古い" });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fakeClient(old, "pc").got.length, 0);
  } finally { old.close(); }
});

test("hub: 1 つの端末からの接続と、全体の接続の数を抑える（古いものから閉じる）", () => {
  const hub = createEventHub({ max: 3, perDevice: 2 });
  try {
    const a1 = fakeClient(hub, "a"), a2 = fakeClient(hub, "a"), a3 = fakeClient(hub, "a");
    assert.equal(a1.res.ended, true);
    assert.equal(a2.res.ended, undefined);
    fakeClient(hub, "b"); fakeClient(hub, "c");
    assert.equal(a2.res.ended, true);   // 全体の上限で、いちばん古いものを閉じる
    assert.equal(a3.res.ended, undefined);
  } finally { hub.close(); }
});

test("保存: プラグインごとのファイルに保存し、読み戻せる", () => {
  const dataDir = tmpDir();
  let ctx;
  createPlugins({ modules: [samplePlugin({ start: (c) => { ctx = c; } })], dataDir, log: quiet, hub: fakeHub() }).start();
  assert.deepEqual(ctx.store.load({ none: true }), { none: true });
  ctx.store.save({ a: 1 });
  assert.deepEqual(ctx.store.load(null), { a: 1 });
  assert.ok(fs.existsSync(path.join(dataDir, "sample.json")));
});

test("頭への説明: 共通の決まりと、プラグインごとの使い方を出す（プラグインが無ければ空）", () => {
  const p = started({ modules: [samplePlugin({ prompt: "見本の説明" })] }).prompt();
  assert.match(p, /# 追加機能（プラグイン）/);
  assert.match(p, /ユーザーが声で頼んだときだけ書く/);
  assert.match(p, /## 見本（sample）\n見本の説明/);
  assert.match(p, /<act do="sample\.echo" word="言葉"\/>: 言葉を返す/);
  assert.match(p, /<act do="sample\.count" n="…"\/>: 数える（確認）/);
  assert.equal(started({ modules: [] }).prompt(), "");
});

test("頭への説明: 書き方の例（usage）があれば、引数を全部並べた形の代わりに出す", () => {
  const echo = { description: "言葉を返す", params: { word: { type: "string", max: 5, desc: "言葉" } }, usage: ['<act do="sample.echo" word="やあ"/>', '<act do="sample.echo" word="おはよう"/>'], run: () => "" };
  const p = started({ modules: [samplePlugin({ actions: { echo } })] }).prompt();
  assert.match(p, /- <act do="sample\.echo" word="やあ"\/> \/ <act do="sample\.echo" word="おはよう"\/>: 言葉を返す/);
  assert.doesNotMatch(p, /word="言葉"/);
});

test("止める設定（PLUGINS_OFF）にあるプラグインは使わない（大文字・小文字は区別しない）", async () => {
  const pl = started({ off: ["Sample"] });
  assert.deepEqual(pl.ids(), []);
  assert.equal((await pl.act({ do: "sample.echo", args: { word: "a" } })).status, 404);
});

test("読み込み: フォルダの plugin.js を読む。壊れたもの・名前が合わないものは飛ばして、ほかは使う", () => {
  const dir = tmpDir();
  const put = (name, src) => { fs.mkdirSync(path.join(dir, name)); fs.writeFileSync(path.join(dir, name, "plugin.js"), src); };
  put("good", 'module.exports = { id: "good", actions: { hi: { run: () => "hi" } } };');
  put("broken", "module.exports = {{;");
  put("mismatch", 'module.exports = { id: "other", actions: {} };');
  put("norun", 'module.exports = { id: "norun", actions: { x: {} } };');
  put("badtype", 'module.exports = { id: "badtype", actions: { x: { params: { n: { type: "integer" } }, run: () => "" } } };');
  put("Bad_Name", 'module.exports = { id: "Bad_Name" };');
  fs.mkdirSync(path.join(dir, "empty"));
  const warned = [];
  const list = loadFromDir(dir, { log: { warn: (m) => warned.push(m) } });
  assert.deepEqual(list.map((p) => p.id), ["good"]);
  assert.equal(warned.length, 4);   // broken・mismatch・norun・badtype（名前の形が違うフォルダと、plugin.js の無いフォルダは黙って飛ばす）
  assert.deepEqual(loadFromDir(path.join(dir, "nothing")), []);
  // 相対パスで渡しても読める
  const rel = path.relative(process.cwd(), dir);
  assert.deepEqual(loadFromDir(rel, { log: quiet }).map((p) => p.id), ["good"]);
});

test("API: 一覧・実行（PC か LAN かを見る）・知らせ（つないだ時点の状態も送る）", async () => {
  let ctx;
  const pl = createPlugins({ modules: [samplePlugin({ start: (c) => { ctx = c; }, actions: { home: { localOnly: true, run: () => "ok" } } })], dataDir: tmpDir(), log: quiet });
  pl.start();
  ctx.setStatus([{ id: "a", text: "残り", endsAt: 5 }]);
  const server = http.createServer(async (req, res) => {
    req.amaneFrom = req.headers["x-from"] || "local";   // server.js の handle の代わり
    if (!(await pl.routes(req, res, new URL(req.url, "http://x")))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await (await fetch(base + "/api/plugins")).json();
    assert.equal(list[0].id, "sample");
    assert.deepEqual(list[0].actions.map((a) => a.kind), ["command", "query", "command", "command"]);
    const post = (body, from = "local") => fetch(base + "/api/plugins/act", { method: "POST", headers: { "Content-Type": "application/json", "X-From": from }, body: JSON.stringify(body) });
    const ok = await post({ do: "sample.echo", args: { word: "やあ" }, device: "pc" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).text, "やあ:pc");
    const ng = await post({ do: "sample.echo", args: {} });
    assert.equal(ng.status, 400);
    assert.match((await ng.json()).error, /word がありません/);
    assert.equal((await post({ do: "sample.home" }, "lan")).status, 403);
    // 知らせ: つないだ時点の状態がまず届く
    const ac = new AbortController();
    const r = await fetch(base + "/api/plugins/events?device=pc", { signal: ac.signal });
    const reader = r.body.getReader();
    let text = "";
    while (!text.includes('"type":"status"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    assert.match(text, /"items":\[\{"id":"a","text":"残り","endsAt":5\}\]/);
    ac.abort();
  } finally { pl.stop(); server.close(); }
});

// ---------- 確かめてから実行する動作（confirm）・使える動作（enabled）・本体の仕組み（requires）など ----------
function confirmPlugin(extra = {}) {
  const ran = [];
  const plugin = samplePlugin({
    actions: {
      open: { description: "開ける", params: { door: { type: "string", max: 10, optional: true } }, confirm: (a) => `${a.door || "玄関"}を開けますか？`, run: (a, ctx) => { ran.push([a.door, ctx.device, ctx.confirmed]); return "開けました。"; } },
      fixed: { confirm: "本当に？", run: () => "した" },
      refuse: { confirm: () => { throw new Error("今は使えません（安全のため）"); }, run: () => "x" },
      lanless: { confirm: "PC だけ？", localOnly: true, run: () => "した" },
    },
    ...extra,
  });
  return { plugin, ran };
}

test("確認: confirm の動作はすぐには実行せず、確認の文と id を返す。頼んだ画面がボタンで決めたときだけ 1 回実行する", async () => {
  const { plugin, ran } = confirmPlugin();
  const pl = started({ modules: [plugin] });
  const r = await pl.act({ do: "sample.open", args: { door: "勝手口" }, device: "ipad" });
  assert.equal(r.kind, "confirm");
  assert.equal(r.confirm.text, "勝手口を開けますか？");
  assert.match(r.confirm.id, /^[0-9a-f]{32}$/);
  assert.deepEqual(ran, []);
  // ほかの画面からは決められない（確認は残る）
  assert.equal((await pl.decide({ id: r.confirm.id, ok: true, device: "pc" })).status, 403);
  const done = await pl.decide({ id: r.confirm.id, ok: true, device: "ipad" });
  assert.deepEqual([done.ok, done.text], [true, "開けました。"]);
  assert.deepEqual(ran, [["勝手口", "ipad", true]]);
  // 1 回だけ（2 回目は「もう使いました」）
  assert.equal((await pl.decide({ id: r.confirm.id, ok: true, device: "ipad" })).status, 409);
  // 見出しと実行のボタンの文字は本体が決める
  assert.deepEqual([r.confirm.title, r.confirm.label], ["見本：開ける", "実行する"]);
});

test("確認: やめるを押したら実行しない。文の確認・期限切れ・画面の印がないとき", async () => {
  const { plugin, ran } = confirmPlugin();
  const pl = started({ modules: [plugin] });
  const r = await pl.act({ do: "sample.fixed", device: "pc" });
  assert.equal(r.confirm.text, "本当に？");
  assert.deepEqual(await pl.decide({ id: r.confirm.id, ok: false, device: "pc" }), { ok: true, kind: "cancelled", text: "やめました。" });
  assert.equal((await pl.decide({ id: "0".repeat(32), ok: true, device: "pc" })).status, 410);
  // 画面の印がない頼み方（画面のボタンを出せない）は断る
  assert.equal((await pl.act({ do: "sample.open" })).status, 400);
  assert.deepEqual(ran, []);
});

test("確認: confirm が理由を投げたら、確認を出さずにその理由で断る。PC だけの動作は LAN から決められない", async () => {
  const { plugin } = confirmPlugin();
  const pl = started({ modules: [plugin] });
  const r = await pl.act({ do: "sample.refuse", device: "pc" });
  assert.deepEqual([r.status, r.error], [400, "今は使えません（安全のため）"]);
  assert.equal((await pl.act({ do: "sample.lanless", device: "ipad", from: "lan" })).status, 403);
  const ok = await pl.act({ do: "sample.lanless", device: "pc", from: "local" });
  assert.equal((await pl.decide({ id: ok.confirm.id, ok: true, device: "pc", from: "lan" })).status, 403);
});

test("確認: 頭への説明に「画面で確認」と出し、決めた結果も記録に残す", async () => {
  const logged = [];
  const { plugin } = confirmPlugin();
  const pl = started({ modules: [plugin], appendLog: (f, o) => logged.push(o) });
  assert.match(pl.prompt(), /<act do="sample\.fixed"\/>: （画面で確認）/);
  assert.match(pl.prompt(), /「画面で確認」と書いた動作は/);
  const r = await pl.act({ do: "sample.fixed", device: "pc" });
  await pl.decide({ id: r.confirm.id, ok: true, device: "pc" });
  assert.deepEqual(logged.map((o) => [o.do, o.kind, o.confirmed]), [["sample.fixed", "confirm", undefined], ["sample.fixed", "command", true]]);
});

test("使える動作（enabled）: false の動作は断り、頭への説明と一覧にも出さない", async () => {
  let on = false;
  const pl = started({ modules: [samplePlugin({ actions: { secret: { enabled: () => on, description: "隠す", run: () => "ok" }, broken: { enabled: () => { throw new Error("x"); }, run: () => "ok" } } })] });
  assert.equal((await pl.act({ do: "sample.secret" })).status, 403);
  assert.doesNotMatch(pl.prompt(), /sample\.secret|sample\.broken/);
  assert.equal(pl.list()[0].actions.some((a) => a.name === "secret"), false);
  on = true;
  assert.equal((await pl.act({ do: "sample.secret" })).text, "ok");
  assert.match(pl.prompt(), /sample\.secret/);
});

test("本体の仕組み（requires）: この本体に無い仕組みを使うプラグインは読み込まない", () => {
  const warned = [];
  const ok = createPlugins({ modules: [samplePlugin({ requires: ["confirm", "prompt-function", "async-start", "prompt-changed", "enabled", "signal"] })], dataDir: tmpDir(), log: quiet, hub: fakeHub() });
  assert.deepEqual(ok.ids(), ["sample"]);
  const ng = createPlugins({ modules: [samplePlugin({ requires: ["confirm", "teleport"] })], dataDir: tmpDir(), log: { log() {}, warn: (m) => warned.push(m) }, hub: fakeHub() });
  assert.deepEqual(ng.ids(), []);
  assert.match(warned[0], /足りない仕組み: teleport/);
});

test("使い方（prompt）は関数でもよい。失敗しても、ほかの説明は出す", () => {
  let devices = "まだありません";
  const pl = started({ modules: [samplePlugin({ prompt: () => `使える機器: ${devices}` }), samplePlugin({ id: "other", name: "ほか", prompt: () => { throw new Error("x"); } })] });
  assert.match(pl.prompt(), /使える機器: まだありません/);
  devices = "リビングの電気";
  assert.match(pl.prompt(), /使える機器: リビングの電気/);
  assert.match(pl.prompt(), /## ほか（other）\n- /);
});

test("start が Promise を返すプラグイン: 終わるまで「準備中」で断り、失敗・時間切れなら使わない。使い方が変わったら知らせる", async () => {
  let finish;
  const changed = [];
  const slow = samplePlugin({ start: (ctx) => new Promise((r) => { finish = () => { ctx.promptChanged(); r(); }; }) });
  const bad = samplePlugin({ id: "bad", start: async () => { throw new Error("つながらない"); } });
  const never = samplePlugin({ id: "never", start: () => new Promise(() => {}) });
  const pl = createPlugins({ modules: [slow, bad, never], dataDir: tmpDir(), log: quiet, hub: fakeHub(), startTimeoutMs: 50, onPromptChange: (id) => changed.push(id) });
  const started_ = pl.start();
  assert.equal((await pl.act({ do: "sample.echo", args: { word: "a" } })).status, 503);
  finish();
  await started_;
  assert.equal((await pl.act({ do: "sample.echo", args: { word: "a" } })).text, "a:");
  assert.equal((await pl.act({ do: "bad.echo", args: { word: "a" } })).status, 503);
  assert.equal((await pl.act({ do: "never.echo", args: { word: "a" } })).status, 503);
  assert.deepEqual(changed, ["sample"]);
});

test("確認: 作業担当が動いている間（blockConfirm）は、頼むのも押すのも断る", async () => {
  let busy = "";
  const { plugin, ran } = confirmPlugin();
  const pl = started({ modules: [plugin], blockConfirm: () => busy });
  const r = await pl.act({ do: "sample.fixed", device: "pc" });
  busy = "作業担当が動いています";
  assert.deepEqual([(await pl.act({ do: "sample.open", device: "pc" })).status], [423]);
  const d = await pl.decide({ id: r.confirm.id, ok: true, device: "pc" });
  assert.deepEqual([d.status, d.error], [423, "作業担当が動いています"]);
  assert.deepEqual(ran, []);
  // 確認のない動作は止めない
  assert.equal((await pl.act({ do: "sample.echo", args: { word: "a" } })).ok, true);
});

test("確認: 「やめる」のあとは同じ動作をしばらく出し直せない。PC だけかどうかは関数でも決められる", async () => {
  let lanOk = false;
  const pl = started({ modules: [samplePlugin({ actions: { door: { confirm: "開けますか？", confirmLabel: "開ける", localOnly: () => !lanOk, run: () => "開けました。" } } })] });
  const r = await pl.act({ do: "sample.door", device: "pc" });
  assert.equal(r.confirm.label, "開ける");
  await pl.decide({ id: r.confirm.id, ok: false, device: "pc" });
  assert.equal((await pl.act({ do: "sample.door", device: "pc" })).status, 429);
  assert.equal((await pl.act({ do: "sample.door", device: "ipad", from: "lan" })).status, 403);
  lanOk = true;
  assert.equal((await pl.act({ do: "sample.door", device: "ipad", from: "lan" })).kind, "confirm");
});

test("確認: 空の確認の文は読み込みで断る（確認が黙って外れないように）。確認の文の書き間違いは記録し、500 で断る", async () => {
  const ng = createPlugins({ modules: [samplePlugin({ actions: { x: { confirm: "", run: () => "ran" } } })], dataDir: tmpDir(), log: quiet, hub: fakeHub() });
  assert.deepEqual(ng.ids(), []);
  const warned = [];
  const pl = started({ log: { log() {}, warn: (m) => warned.push(String(m)) }, modules: [samplePlugin({ actions: { typo: { confirm: () => null.x, run: () => "ran" } } })] });
  const r = await pl.act({ do: "sample.typo", device: "pc" });
  assert.deepEqual([r.status, r.error], [500, "追加機能の中でエラーが起きました（詳しくは黒いウィンドウを見てください）"]);
  assert.ok(warned.some((w) => /確認の文を作れません/.test(w)));
});

test("時間切れ: プラグインが自分で付けた timeout の Error は、その理由のまま伝える（本体の時間切れとは分ける）", async () => {
  const pl = started({ modules: [samplePlugin({ actions: { own: { run: () => { throw Object.assign(new Error("命令が届いたかは分かりません"), { timeout: true }); } } } })] });
  const r = await pl.act({ do: "sample.own" });
  assert.deepEqual([r.status, r.error], [500, "命令が届いたかは分かりません"]);
});

test("start が Promise のプラグイン: 準備の途中の知らせはまとめ、終わったときに 1 回、そのプラグインを含む説明で知らせる", async () => {
  let finish;
  const seen = [];
  let pl;
  const slow = samplePlugin({ start: (ctx) => new Promise((r) => { ctx.promptChanged(); finish = () => { ctx.promptChanged(); r(); }; }) });
  pl = createPlugins({ modules: [slow], dataDir: tmpDir(), log: quiet, hub: fakeHub(), onPromptChange: (id) => seen.push([id, /## 見本（sample）/.test(pl.prompt())]) });
  const done = pl.start();
  finish();
  await done;
  assert.deepEqual(seen, [["sample", true]]);
});

test("使い方: 長すぎるものは切り、タグの形の文字が入っていたら知らせる", () => {
  const warned = [];
  const pl = started({ log: { log() {}, warn: (m) => warned.push(String(m)) }, modules: [samplePlugin({ prompt: () => "<act do=\"x.y\"/>" + "あ".repeat(5000) })] });
  const p = pl.prompt();
  assert.ok(p.length < 6000);
  assert.ok(warned.some((w) => /タグの形の文字/.test(w)));
});
