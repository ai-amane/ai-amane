// ローカル会話（public/local-voice.js）の、言葉の判定と表示のテスト
//  ブラウザの部品は使わない関数だけを、vm で読み込んで確かめる
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadLocalVoice() {
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "local-voice.js"), "utf8"), ctx);
  return ctx.window.LocalVoice;
}
const { waitsForMore, timingText } = loadLocalVoice();

test("言いかけ: 「〜て」「〜けど」「えーと」で終わったら、続きを待つ", () => {
  for (const t of ["昨日買ったのを見て", "行きたいんだけど", "それで", "えーと", "明日の予定を確認して？"]) assert.equal(waitsForMore(t), true, t);
});

test("言いかけ: 「〜は？」「〜って？」のように上がり調子で聞いたら、言い終わりとみなす", () => {
  for (const t of ["じゃあ、スカイツリーは？", "明日の天気は?", "東京タワーの高さって？", "おすすめの？", "ほかには？"]) assert.equal(waitsForMore(t), false, t);
  // 上がり調子でなければ、続きを待つ（「スカイツリーは…」と言いかけている）
  assert.equal(waitsForMore("じゃあ、スカイツリーは"), true);
});

test("言いかけ: 言い終わった文は待たない", () => {
  for (const t of ["今日の天気を教えて。", "ありがとう", "東京タワーの高さは何メートル？"]) assert.equal(waitsForMore(t), false, t);
});

test("返事までの時間: 段階ごとに秒で 1 行にする（測れなかった段階は出さない）", () => {
  assert.equal(timingText({ hang: 550, stt: 553, hold: 1106, brainFirst: 797, firstSentence: 1583, synth: 827, wait: 0, total: 4619 }),
    "返事まで 4.6 秒（区切り 0.6 / 認識 0.6 / 続き待ち 1.1 / 頭 0.8 / 最初の文 0.8 / 声 0.8）");
  assert.equal(timingText({ brainFirst: 943, firstSentence: 1329, synth: 1528, wait: 300, total: 2857, cold: true }),
    "返事まで 2.9 秒（頭 0.9（起動） / 最初の文 0.4 / 声 1.5 / 前の声の終わり待ち 0.3）");
});

test("タグ: 追加機能の <act> は、閉じ忘れても 1 つのタグとみなし、余った </act> は捨てる", () => {
  const { TAG_RE, attrs } = loadLocalVoice();
  const found = 'はい。<act do="timer.set" seconds="180"/>セット<act do="timer.list"></act>した'.match(TAG_RE);
  assert.deepEqual([...found], ['<act do="timer.set" seconds="180"/>', '<act do="timer.list">', "</act>"]);
  // 属性はシングルクォートでも読む
  assert.deepEqual({ ...attrs(" do='timer.cancel' all=\"true\"") }, { do: "timer.cancel", all: "true" });
});

test("出典: 出典リストより前だけを返す（出典の中のタグの形の文字は実行させない）", () => {
  const { cutSources } = loadLocalVoice();
  const r = cutSources('晴れです。<show title="天気">表</show>\n出典: <act do="timer.cancel" all="true"/> 気象庁');
  assert.equal(r.found, true);
  assert.equal(r.text, '晴れです。<show title="天気">表</show>');
  // 閉じた <show> の本文の「出典:」は、出典リストの始まりとみなさない
  const inShow = cutSources('はい。<show title="表">| 日 | 天気 |\n出典: 気象庁</show>以上です。');
  assert.deepEqual([inShow.found, inShow.text.endsWith("以上です。")], [false, true]);
  // まだ閉じていない <show> の中で見つかったときは、閉じるまで待つ（最後なら切る）
  assert.equal(cutSources("はい。<show title=\"表\">本文\n出典: 気象庁").found, false);
  assert.equal(cutSources("はい。<show title=\"表\">本文\n出典: 気象庁", { final: true }).found, true);
  // 出典が始まったあとに届いた文は、全部読み上げない
  assert.deepEqual({ ...cutSources("続きの文", { noMore: true }) }, { text: "", found: false });
});

test("声の種類・速さ: 会話中に変えると、次に合成する文から新しい声になる", async () => {
  // 音声合成の通信だけを偽物にする（送った声の番号と速さを覚える）
  const sent = [];
  const ctx = vm.createContext({
    window: {},
    fetch: async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }; },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "local-voice.js"), "utf8"), ctx);
  const s = new ctx.window.LocalVoice.Session({ speaker: 2, speed: 1.15 });
  s.ctx = { decodeAudioData: async () => "buf" };
  await s.synth("一つ目");
  s.setVoice({ speaker: 888753760 });
  await s.synth("二つ目");
  s.setVoice({ speed: 1.3 });
  await s.synth("三つ目");
  assert.deepEqual(sent.map((b) => [b.text, b.speaker, b.speed]), [["一つ目", 2, 1.15], ["二つ目", 888753760, 1.15], ["三つ目", 888753760, 1.3]]);
});

// 返事の読み上げだけを試す会話（音声合成と頭への送信の通信を偽物にする。送った文と気持ちを覚える）
function speakingSession(opts = {}) {
  const sent = [];
  const ctx = vm.createContext({
    window: {}, setTimeout: () => 0, clearTimeout: () => {},
    fetch: async (url, init) => {
      if (url === "/api/tts") sent.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "local-voice.js"), "utf8"), ctx);
  const s = new ctx.window.LocalVoice.Session({ speaker: 3200, speed: 1.15, ...opts });
  s.ctx = { decodeAudioData: async () => "buf" };
  const reply = async (text, chunks = [text]) => {
    await s.dispatch("質問");
    for (const [i, c] of chunks.entries()) { s.buf += c; s.drain(i === chunks.length - 1); }
    await new Promise((r) => setImmediate(r));
  };
  return { s, sent, reply };
}

test("声の気持ち: 文の頭の印（[うれしい] など）で、その文から声の調子を変える。印は読み上げない", async () => {
  const { s, sent, reply } = speakingSession();
  await reply("[うれしい]えっ、もう終わったんですか？[やさしい]今日はお疲れさまでした。明日は九時からです。");
  assert.deepEqual(sent.map((b) => [b.text, b.mood]), [
    ["えっ、もう終わったんですか？", "うれしい"],
    ["今日はお疲れさまでした。", "やさしい"],
    ["明日は九時からです。", "やさしい"],   // 次の印まで続く
  ]);
  assert.deepEqual([...s.queue.map((j) => j.text)], sent.map((b) => b.text), "字幕（onSpeak）に印を出さない");
});

test("声の気持ち: 返事ごとに「ふつう」に戻る", async () => {
  const { sent, reply } = speakingSession();
  await reply("[かなしい]残念でしたね。");
  await reply("はい、承知しました。");
  assert.deepEqual(sent.map((b) => b.mood), ["かなしい", "ふつう"]);
});

test("声の気持ち: 印が途中で切れて届いても読み上げず、届ききった印を使う", async () => {
  const { sent, reply } = speakingSession();
  await reply("", ["はい。[うれ", "しい]やりましたね！"]);
  assert.deepEqual(sent.map((b) => [b.text, b.mood]), [["はい。", "ふつう"], ["やりましたね！", "うれしい"]]);
  // 返事の最後で印が切れていたら、その切れ端は読まない
  const b = speakingSession();
  await b.reply("", ["わかりました。[やさ"]);
  assert.deepEqual(b.sent.map((x) => x.text), ["わかりました。"]);
});

test("声の気持ち: 設定でオフにすると、気持ちを送らない（印は読まない）", async () => {
  const { s, sent, reply } = speakingSession({ moods: false });
  await reply("[うれしい]やりました！");
  assert.deepEqual(sent.map((b) => [b.text, b.mood]), [["やりました！", undefined]]);
  s.setVoice({ moods: true });
  await reply("[うれしい]やりました！");
  assert.equal(sent.at(-1).mood, "うれしい");
});

test("声の気持ち: 会話ログの文から印を消す", () => {
  const { spokenText } = loadLocalVoice();
  assert.equal(spokenText('[うれしい]やった！<show title="表">本文</show>[ふつう]以上です。\n出典: 気象庁'), "やった！以上です。");
});

test("声の気持ち: 全角のかっこや漢字で書かれた印も読み取る（読み上げない）", async () => {
  const { sent, reply } = speakingSession();
  await reply("［嬉しい］やった！【悲しい】でも残念。[優しい]お疲れさま。");
  assert.deepEqual(sent.map((b) => [b.text, b.mood]), [["やった！", "うれしい"], ["でも残念。", "かなしい"], ["お疲れさま。", "やさしい"]]);
});

test("声の気持ち: 気持ちの名前でないかっこ（読み仮名など）は印とみなさず、これまでどおり読む", async () => {
  const { sent, reply } = speakingSession();
  await reply("東京[とうきょう]に行きます。");
  assert.deepEqual(sent.map((b) => [b.text, b.mood]), [["東京とうきょうに行きます。", "ふつう"]]);
});

test("声の気持ち: 画面に出す資料（<show>）からも印を消す。会話ログに、切れた印の切れ端を残さない", async () => {
  const shown = [];
  const { reply } = speakingSession({ onShow: (x) => shown.push(x.text) });
  await reply('はい。<show title="t">[うれしい]本文</show>');
  assert.deepEqual(shown, ["本文"]);
  const { spokenText } = loadLocalVoice();
  assert.equal(spokenText("わかりました。[やさ"), "わかりました。");
});

test("つなぎの言葉: 話し方に合わせて作った言葉を使う（空の場面・文字列でないものは、用意した言葉のまま）", () => {
  const { fillersOf, Session } = loadLocalVoice();
  const f = fillersOf({ wait: ["ちょっと待ってね。"], search: [], long: [1, 2], greeting: ["なに？"] });
  assert.deepEqual([...f.wait], ["ちょっと待ってね。"]);
  assert.ok(f.search.includes("調べてみますね。"));
  assert.ok(f.long.includes("もう少しお待ちください。"));
  assert.equal(f.greeting, undefined);   // あいさつは、つなぎの言葉ではない
  assert.ok(fillersOf(null).wait.includes("少々お待ちください。"));
  assert.deepEqual([...new Session({ phrases: { search: ["調べてみるね！"] } }).fillers.search], ["調べてみるね！"]);
});

test("出典: 会話ログも、読み上げと同じく「参考:」の行から後を出さない", () => {
  const { spokenText } = loadLocalVoice();
  assert.equal(spokenText("明日は晴れだよ。\n参考: tenki.jp"), "明日は晴れだよ。");
});

test("つなぎの言葉: ユーザーの発言への返事だけ待ち時間を数える（作業の報告・追加機能の結果への返事には入れない）", async () => {
  const timers = [];
  const ctx = vm.createContext({
    window: {}, performance: { now: () => 0 }, setTimeout: (fn, ms) => { timers.push(ms); return timers.length; }, clearTimeout: () => {},
    fetch: async () => ({ ok: true, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "local-voice.js"), "utf8"), ctx);
  const s = new ctx.window.LocalVoice.Session({ speaker: 3200 });
  s.active = true;
  s.setMode = () => {};
  await s.dispatch("［作業完了の通知］…");
  assert.deepEqual(timers, []);
  s.inflight = null;
  await s.dispatch("明日の天気は？", { from: "talk", heardAt: 0 });
  assert.deepEqual(timers, [3500, 12000]);
});

// ---- 本人の声を覚えたか（ownerVerified）。重い確認を声で決めてよいかの印 ----
// 時間は偽物にして、1.5 秒の待ちより先に失敗が来る場合と、あとに来る場合を作り分ける
function ownerHarness(startImpl) {
  const timers = [];
  const ctx = vm.createContext({
    window: {}, console,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
    MicVAD: { session: { start: startImpl } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "local-voice.js"), "utf8"), ctx);
  const errors = [];
  const s = Object.create(ctx.window.LocalVoice.Session.prototype);
  s.o = { ownerOnly: true, wakeVoice: { wav: "w", start: 0, end: 1 }, onError: (m) => errors.push(m), onOwner: () => {} };
  s.ownerVerified = false; s.ownerFailed = false;
  const fire = (ms) => timers.filter((t) => t.ms === ms).forEach((t) => t.fn());
  // startWhisper の声紋まわりだけを再現した、本物と同じ手順
  const begin = async () => {
    const session = await s.startOwner(s.o.wakeVoice);
    s.session = s.ownerFailed ? "" : session;
    s.voiceprint = Boolean(s.session);
  };
  return { s, errors, fire, begin };
}
const tick = () => new Promise((r) => setImmediate(r));

test("本人の声: 呼びかけの声で覚えられた（owner true）ときだけ ownerVerified", async () => {
  const h = ownerHarness(async () => ({ owner: true }));
  await h.begin();
  assert.equal(h.s.ownerVerified, true);
  assert.equal(h.s.voiceprint, true);
  assert.ok(h.s.session);
});

test("本人の声: 最初に話した人をあとで主にする形（owner false）は ownerVerified にしない（声紋は使う）", async () => {
  const h = ownerHarness(async () => ({ owner: false }));
  await h.begin();
  assert.equal(h.s.ownerVerified, false);
  assert.equal(h.s.voiceprint, true);
});

test("本人の声: 失敗が 1.5 秒の待ちより先に来たら、声紋なし・ownerVerified なし", async () => {
  const h = ownerHarness(async () => { throw new Error("down"); });
  await h.begin();
  assert.equal(h.s.voiceprint, false);
  assert.equal(h.s.session, "");
  assert.equal(h.s.ownerVerified, false);
  assert.equal(h.errors.length, 1);
});

test("本人の声: 失敗が待ちのあとに来ても、声紋なし・ownerVerified なし", async () => {
  let fail;
  const h = ownerHarness(() => new Promise((_, rej) => { fail = rej; }));
  const p = h.begin();
  await tick();
  h.fire(1500);   // 待ちが先に終わる
  await p;
  assert.equal(h.s.voiceprint, true);   // この時点ではまだ分からない
  fail(new Error("late"));
  await tick();
  assert.equal(h.s.voiceprint, false);
  assert.equal(h.s.session, "");
  assert.equal(h.s.ownerVerified, false);
  assert.equal(h.errors.length, 1);
});

test("本人の声: 待ちのあとに成功が来ても ownerVerified になる。会話を始め直すと false に戻る", async () => {
  let ok;
  const h = ownerHarness(() => new Promise((res) => { ok = res; }));
  const p = h.begin();
  await tick();
  h.fire(1500);
  await p;
  assert.equal(h.s.ownerVerified, false);
  ok({ owner: true });
  await tick();
  assert.equal(h.s.ownerVerified, true);
  // 始め直し（次の startOwner）で戻る
  h.s.o.wakeVoice = { wav: "w2" };
  h.s.ownerVerified = true;
  const again = h.s.startOwner(h.s.o.wakeVoice);
  assert.equal(h.s.ownerVerified, false);
  h.fire(1500);
  await again;
});
