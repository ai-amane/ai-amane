// 縦型の収録モード（public/rec-mode.js）の、表示する言葉を作る関数のテスト
//  ブラウザの部品は使わない関数だけを、vm で読み込んで確かめる
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadRec() {
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "rec-mode.js"), "utf8"), ctx);
  return ctx.window.AmaneRec;
}
const { creditFor, hearingText } = loadRec();

test("声のクレジット: スタイル名を外して、エンジンごとの書き方にする", () => {
  assert.equal(creditFor("AivisSpeech", "まお（ノーマル）"), "AivisSpeech: まお");
  assert.equal(creditFor("VOICEVOX", "四国めたん（ノーマル）"), "VOICEVOX:四国めたん");
  assert.equal(creditFor("VOICEVOX", "ずんだもん(あまあま)"), "VOICEVOX:ずんだもん");
  // スタイル名が無い名前はそのまま
  assert.equal(creditFor("AivisSpeech", "コハク"), "AivisSpeech: コハク");
});

test("声のクレジット: 声が分からないときは出さない", () => {
  assert.equal(creditFor("AivisSpeech", ""), "");
  assert.equal(creditFor("AivisSpeech", "（ノーマル）"), "");
  assert.equal(creditFor("", "まお（ノーマル）"), "");
});

test("字幕: 聞き取り中の表示から、話した言葉だけを取り出す", () => {
  assert.equal(hearingText("今日の天気"), "今日の天気");
  assert.equal(hearingText("（続きを待っています）明日の予定を確認して"), "明日の予定を確認して");
});

test("字幕: 聞き取りの途中経過（認識中・聞き流し）は字幕に出さない", () => {
  for (const t of ["", "…", "認識中…（1.2秒）", "聞き取り中…", "（周りの声を聞き流しました）", null, undefined]) assert.equal(hearingText(t), "", String(t));
});
