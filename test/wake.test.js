// 呼びかけの判定（lib/wake.js）のテスト
//  漢字で認識されても読みで一致すること、周りの会話（助詞が続く・長い単語の一部・文の途中）は拾わないこと、を確かめる
const test = require("node:test");
const assert = require("node:assert/strict");
const { detectWake } = require("../lib/wake");

const pick = (r) => ({ hit: r.hit, rest: r.rest });

// 既定の呼びかけの言葉（public/app.js の DEFAULT_WAKE）
const AMANE = ["あまね", "天音"];

test("呼びかけ（あまね）: ひらがなでも漢字（天音）でも反応し、続けて言った用件を返す", async () => {
  assert.deepEqual(pick(await detectWake("あまね", AMANE)), { hit: true, rest: "" });
  assert.deepEqual(pick(await detectWake("あまね、今日の天気は？", AMANE)), { hit: true, rest: "今日の天気は？" });
  assert.deepEqual(pick(await detectWake("天音、電気消して", AMANE)), { hit: true, rest: "電気消して" });
  assert.deepEqual(pick(await detectWake("ねえ、あまね", AMANE)), { hit: true, rest: "" });
  assert.deepEqual(pick(await detectWake("あまねちゃん、おはよう", AMANE)), { hit: true, rest: "おはよう" });
  assert.deepEqual(pick(await detectWake("あまねさん、おはよう", AMANE)), { hit: true, rest: "おはよう" });
});

test("呼びかけ（あまね）: 長い単語の頭（あまねく）や、助詞が続くとき、文の途中では反応しない", async () => {
  for (const text of ["あまねく広める", "ねえあまねく知られている", "あまねって何？", "天音の意味は", "今日はあまねがいる"]) {
    assert.equal((await detectWake(text, AMANE)).hit, false, text);
  }
});

// 読みと辞書の区切り方を試しやすい、ありふれた名前でも確かめる（呼びかけの言葉は利用者が変えられる）
const HIKARI = ["ひかり"];

test("呼びかけ: 漢字で認識されても（光）、読みで一致する。長音のゆれ（高校 → ここ）も吸収する", async () => {
  assert.deepEqual(pick(await detectWake("光", HIKARI)), { hit: true, rest: "" });
  assert.deepEqual(pick(await detectWake("ねえひかり、今日の天気を教えて", HIKARI)), { hit: true, rest: "今日の天気を教えて" });
  assert.deepEqual(pick(await detectWake("光、電気つけて", HIKARI)), { hit: true, rest: "電気つけて" });
  assert.equal((await detectWake("高校", ["ここ"])).hit, true);   // コウコウ → ココ
});

test("呼びかけ: 周りの会話は拾わない（助詞・「する」が続く・長い単語の一部・文の途中）", async () => {
  for (const text of ["光の速さ", "ひかりって何", "ひかりして", "光る", "光が丘に行く", "今日は光が強い"]) {
    assert.equal((await detectWake(text, HIKARI)).hit, false, text);
  }
});

test("呼びかけ: 辞書が言葉の途中で区切っても（み|おさん）、呼びかけとみなす", async () => {
  assert.deepEqual(pick(await detectWake("みおさん、おはよう", ["みお"])), { hit: true, rest: "おはよう" });
});
