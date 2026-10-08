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
