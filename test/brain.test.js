// 常駐の頭（lib/brain.js）のテスト
//  偽物の Claude Code（test/fixtures/fake-claude.js）を使って、返事に発言の印（turn）と、最初の文字までの時間が付くこと、
//  順番待ちの発言を取り消せること、を確かめる
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createBrain } = require("../lib/brain");

const silent = { log() {}, warn() {} };
function makeBrain(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amane-brain-"));
  const promptSrc = path.join(dir, "src.md");
  fs.writeFileSync(promptSrc, "{{AI_NAME}} です。{{USER_NAME}} と話します。");
  const node = process.platform === "win32" ? `"${process.execPath}"` : process.execPath;
  const fake = path.join(__dirname, "fixtures", "fake-claude.js");
  const brain = createBrain({
    bin: node, binArgs: [process.platform === "win32" ? `"${fake}"` : fake], model: "fake", workdir: dir,
    promptSrc, promptFile: path.join(dir, "prompt.md"), vars: { AI_NAME: "あまね", USER_NAME: "ご主人様" }, log: silent, ...opts,
  });
  // 返事を受け取る画面の代わり
  const events = [];
  const req = new EventEmitter();
  brain.addClient(req, { writeHead() {}, write(s) { const m = s.match(/^data: (.*)\n\n$/); if (m) events.push(JSON.parse(m[1])); } });
  return { brain, events, dir, close: () => { req.emit("close"); brain.stop(); } };
}
const waitFor = async (cond, ms = 15000) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("待ちきれませんでした"); await new Promise((r) => setTimeout(r, 20)); }
};

test("頭: 返事に発言の印が付き、最初の文字には待った時間と起動直後かが付く", async () => {
  const { brain, events, dir, close } = makeBrain();
  try {
    brain.say("天気", "t1");
    await waitFor(() => events.some((e) => e.type === "done"));
    assert.equal(fs.readFileSync(path.join(dir, "prompt.md"), "utf8"), "あまね です。ご主人様 と話します。");
    const deltas = events.filter((e) => e.type === "delta");
    assert.deepEqual(deltas.map((e) => e.turn), ["t1", "t1"]);
    assert.equal(deltas.map((e) => e.text).join(""), "はい、天気ですね。");
    assert.equal(deltas[0].first, true);
    assert.equal(deltas[0].cold, true);
    assert.ok(deltas[0].ms >= 40, "最初の文字までの時間 " + deltas[0].ms);
    assert.equal(deltas[1].first, undefined);
    const done = events.find((e) => e.type === "done");
    assert.equal(done.turn, "t1");
    assert.equal(done.apiMs, 40);

    // 2 回目は起動済み
    brain.say("時間", "t2");
    await waitFor(() => events.filter((e) => e.type === "done").length === 2);
    assert.equal(events.find((e) => e.type === "delta" && e.turn === "t2" && e.first).cold, false);
  } finally { close(); }
});

test("頭: 追加機能の使い方（promptExtra）があれば、人格のプロンプトの後ろに付けて起動する", async () => {
  const { brain, events, dir, close } = makeBrain({ promptExtra: () => "# 追加機能（プラグイン）\n- タイマー" });
  try {
    brain.say("天気", "t1");
    await waitFor(() => events.some((e) => e.type === "done"));
    assert.equal(fs.readFileSync(path.join(dir, "prompt.md"), "utf8"), "あまね です。ご主人様 と話します。\n\n# 追加機能（プラグイン）\n- タイマー\n");
  } finally { close(); }
});

test("頭: 追加機能の使い方が変わったら（refresh）、会話の切れ目で起動し直して新しい説明を渡す。変わっていなければ起動し直さない", async () => {
  let extra = "使い方: 古い";
  const { brain, events, dir, close } = makeBrain({ promptExtra: () => extra, refreshQuietMs: 80, refreshDelayMs: 10 });
  const file = path.join(dir, "prompt.md");
  const promptNow = () => fs.readFileSync(file, "utf8");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    brain.refresh();   // まだ起動していなければ何もしない（次に起動するときに新しい説明を書く）
    brain.warm();      // 待受中の画面がある（起動し直したら、すぐ新しい頭を起動しておく）
    brain.say("天気", "t1");
    await waitFor(() => events.some((e) => e.type === "done" && e.turn === "t1"));
    assert.match(promptNow(), /使い方: 古い/);
    extra = "使い方: 新しい";
    brain.say("時間", "t2");
    brain.refresh();   // 返答中 → 返答が終わり、最後の発言から少したってから起動し直す
    await sleep(30);
    assert.match(promptNow(), /使い方: 古い/);   // まだ起動し直さない（会話の途中）
    await waitFor(() => events.some((e) => e.type === "done" && e.turn === "t2"));
    assert.equal(events.find((e) => e.type === "done" && e.turn === "t2").interrupted, false);   // 返答は止めない
    await waitFor(() => /使い方: 新しい/.test(promptNow()));
    // 説明が変わっていなければ、起動し直さない（説明のファイルを書き直さない）
    const before = fs.statSync(file).mtimeMs;
    brain.refresh(); brain.refresh();
    await sleep(250);
    assert.equal(fs.statSync(file).mtimeMs, before);
    brain.say("もう一度", "t3");
    await waitFor(() => events.some((e) => e.type === "done" && e.turn === "t3"));
  } finally { close(); }
});

test("頭: 人格の値（vars）が関数なら起動のたびに読み、refresh({ soon }) は最後の発言の直後でも待たずに起動し直す", async () => {
  let name = "あまね";
  const { brain, events, dir, close } = makeBrain({ vars: () => ({ AI_NAME: name, USER_NAME: "田中さん" }), refreshQuietMs: 60000, refreshDelayMs: 10 });
  const promptNow = () => fs.readFileSync(path.join(dir, "prompt.md"), "utf8");
  try {
    brain.warm();   // 待受中の画面がある（起動し直したら、すぐ新しい頭を起動しておく）
    brain.say("天気", "t1");
    await waitFor(() => events.some((e) => e.type === "done" && e.turn === "t1"));
    assert.equal(promptNow(), "あまね です。田中さん と話します。");
    name = "ひかり{{USER_NAME}}";
    brain.refresh({ soon: true });   // 画面で設定を保存した（話し終えてすぐでも、1 分待たない）
    await waitFor(() => /ひかり/.test(promptNow()), 3000);
    assert.equal(promptNow(), "ひかり{{USER_NAME}} です。田中さん と話します。");   // 入れた値の中の {{…}} は置き換えない
    // 返答中に保存したときは、返答が終わってから起動し直す（返答は止めない）
    brain.say("時間", "t2");
    name = "みお";
    brain.refresh({ soon: true });
    await new Promise((r) => setTimeout(r, 30));
    assert.match(promptNow(), /^ひかり/);
    await waitFor(() => events.some((e) => e.type === "done" && e.turn === "t2"));
    assert.equal(events.find((e) => e.type === "done" && e.turn === "t2").interrupted, false);
    await waitFor(() => /^みお/.test(promptNow()), 5000);
    brain.say("もう一度", "t3");
    await waitFor(() => events.some((e) => e.type === "done" && e.turn === "t3"));
  } finally { close(); }
});

test("頭: 返答中に届いた発言は順番待ちになり、まだなら取り消せる", async () => {
  const { brain, events, close } = makeBrain();
  try {
    brain.say("一つ目", "a");
    brain.say("二つ目", "b");
    brain.say("三つ目", "c");
    brain.interrupt("b");   // 順番待ちの b を取り消す
    await waitFor(() => events.filter((e) => e.type === "done").length === 3);
    const dones = events.filter((e) => e.type === "done");
    assert.deepEqual(dones.map((e) => [e.turn, Boolean(e.interrupted)]), [["b", true], ["a", false], ["c", false]]);
    assert.equal(events.some((e) => e.type === "delta" && e.turn === "b"), false);
  } finally { close(); }
});

test("頭: 使われない時間が続いたら止める。待受中の画面が warm を呼んでいれば、すぐ新しく起動しておく", async () => {
  // 待受中（warm）: 止めたあと起動し直す → 準備完了（ready）が 2 回以上届く
  const a = makeBrain({ idleMin: 0.005 });   // 0.3 秒
  try {
    a.brain.warm();
    await waitFor(() => a.events.filter((e) => e.type === "ready").length >= 2, 10000);
  } finally { a.close(); }
  // 待受中でない: 止めたまま（ready は 1 回だけ）
  const b = makeBrain({ idleMin: 0.005 });
  try {
    b.brain.start();
    await waitFor(() => b.events.some((e) => e.type === "ready"));
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(b.events.filter((e) => e.type === "ready").length, 1);
  } finally { b.close(); }
});

test("頭: 待受中に起動し直しても、「頭が終了しました」は知らせない", async () => {
  const a = makeBrain({ idleMin: 0.005 });
  try {
    a.brain.warm();
    await waitFor(() => a.events.filter((e) => e.type === "ready").length >= 3, 10000);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(a.events.some((e) => e.type === "exit"), false, JSON.stringify(a.events.map((e) => e.type)));
  } finally { a.close(); }
});

test("頭: 起動に失敗したら、その発言に失敗を返し、次の発言は通る", async () => {
  const b = makeBrain();
  const src = path.join(b.dir, "src.md");
  const saved = fs.readFileSync(src, "utf8");
  fs.unlinkSync(src);   // 人格のプロンプトが読めない
  try {
    b.brain.say("一つ目", "t1");
    const failed = b.events.find((e) => e.type === "done" && e.turn === "t1");
    assert.ok(failed && failed.error, "失敗が知らされていない");
    fs.writeFileSync(src, saved);
    b.brain.say("二つ目", "t2");
    await waitFor(() => b.events.some((e) => e.type === "done" && e.turn === "t2" && !e.error));
  } finally { b.close(); }
});

test("頭: 止めたときは、返答中・順番待ちの発言に「中断」を知らせる。順番待ちがあふれたら断る", async () => {
  const c = makeBrain();
  try {
    for (let i = 0; i < 7; i++) c.brain.say("発言" + i, "t" + i);
    const full = c.events.find((e) => e.type === "done" && e.turn === "t6");
    assert.ok(full && full.error, "あふれた発言が断られていない");
    c.brain.stop();
    const stopped = c.events.filter((e) => e.type === "done" && e.interrupted).map((e) => e.turn);
    assert.deepEqual(stopped, ["t0", "t1", "t2", "t3", "t4", "t5"]);
  } finally { c.close(); }
});

test("頭: 落ちたときは「終了」を先に、返答中・順番待ちの発言に「中断」をあとで知らせ、次の発言は新しい頭で答える", async () => {
  const d = makeBrain();
  try {
    d.brain.say("落ちて", "x");
    d.brain.say("待ち", "y");
    await waitFor(() => d.events.filter((e) => e.type === "done" && e.interrupted).length === 2);
    const order = d.events.filter((e) => e.type === "exit" || (e.type === "done" && e.interrupted)).map((e) => e.type === "exit" ? "exit" : e.turn);
    assert.deepEqual(order, ["exit", "x", "y"]);
    d.brain.say("次", "z");
    await waitFor(() => d.events.some((e) => e.type === "done" && e.turn === "z" && !e.interrupted));
  } finally { d.close(); }
});
