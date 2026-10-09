// 声の気持ち（lib/moods.js）のテスト
//  頭が文の頭に書く印（[うれしい] など）から、AivisSpeech のスタイル・強さ・緩急・速さを決める
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveMood, moodPrompt, MOOD_NAMES } = require("../lib/moods");

// AivisSpeech のスタイルの番号は「話者ごとの番号 × 32 + モデルの中の番号（0 が全スタイルの平均）」
const id = (base, local) => base * 32 + local;
const styles = (base, names) => names.map((name, i) => ({ name, id: id(base, i), type: "talk" }));
const SPEAKERS = [
  { name: "まお", styles: styles(100, ["ノーマル", "ふつー", "あまあま", "おちつき", "からかい", "せつなめ"]) },
  { name: "コハク", styles: styles(200, ["ノーマル", "あまあま", "せつなめ", "ねむたい"]) },
  { name: "凛音エル", styles: styles(300, ["ノーマル", "Angry", "Fear", "Happy", "Sad"]) },
  { name: "猩々博士", styles: styles(400, ["ノーマル"]) },
];

test("気持ちに合うスタイルに切り替え、強さを上げ、緩急と速さも変える", () => {
  assert.deepEqual(resolveMood({ speakers: SPEAKERS, speaker: id(100, 0), mood: "うれしい" }), { speaker: id(100, 4), intonation: 1.5, tempo: 1.4, speedFactor: 1.06 });
  assert.deepEqual(resolveMood({ speakers: SPEAKERS, speaker: id(100, 0), mood: "かなしい" }), { speaker: id(100, 5), intonation: 1.5, tempo: 0.8, speedFactor: 0.85 });
  assert.equal(resolveMood({ speakers: SPEAKERS, speaker: id(100, 0), mood: "やさしい" }).speaker, id(100, 2));
  assert.equal(resolveMood({ speakers: SPEAKERS, speaker: id(100, 0), mood: "おちつく" }).speaker, id(100, 3));
  assert.equal(resolveMood({ speakers: SPEAKERS, speaker: id(100, 0), mood: "からかう" }).speaker, id(100, 4));
});

test("ふつう・知らない気持ち・気持ちなしは、選んだ声のまま（いまと同じ合成）", () => {
  const plain = { speaker: id(100, 2), intonation: 1, tempo: 1, speedFactor: 1 };
  for (const mood of ["ふつう", "おどろく", "", undefined, "__proto__"]) {
    assert.deepEqual(resolveMood({ speakers: SPEAKERS, speaker: id(100, 2), mood }), plain, String(mood));
  }
});

test("同じ話者の中だけで探す（選んだ声と別の人の声にはならない）", () => {
  // コハク には「からかい」がないので、コハク のままで、緩急と速さだけ変える
  assert.deepEqual(resolveMood({ speakers: SPEAKERS, speaker: id(200, 0), mood: "からかう" }), { speaker: id(200, 0), intonation: 1, tempo: 1.2, speedFactor: 1 });
  assert.equal(resolveMood({ speakers: SPEAKERS, speaker: id(200, 0), mood: "かなしい" }).speaker, id(200, 2));
  // スタイルが 1 つだけのモデルも、緩急と速さで気持ちを出す
  assert.deepEqual(resolveMood({ speakers: SPEAKERS, speaker: id(400, 0), mood: "うれしい" }), { speaker: id(400, 0), intonation: 1, tempo: 1.4, speedFactor: 1.06 });
});

test("英語の名前のスタイル（Happy・Sad など）にも合わせる", () => {
  assert.equal(resolveMood({ speakers: SPEAKERS, speaker: id(300, 0), mood: "うれしい" }).speaker, id(300, 3));
  assert.equal(resolveMood({ speakers: SPEAKERS, speaker: id(300, 0), mood: "かなしい" }).speaker, id(300, 4));
});

test("選んだ声が一覧にない（あとから入れたモデルなど）ときは、選んだ声のまま", () => {
  assert.deepEqual(resolveMood({ speakers: SPEAKERS, speaker: 12345, mood: "うれしい" }), { speaker: 12345, intonation: 1, tempo: 1.4, speedFactor: 1.06 });
  assert.equal(resolveMood({ speakers: null, speaker: 7, mood: "かなしい" }).speaker, 7);
});

test("強さは、全スタイルの平均（ノーマル）には効かないので上げない", () => {
  // 「平均」は名前ではなく番号で見分ける（モデルの中の番号が 0）。名前が「ノーマル」でも平均とは限らない
  const odd = [{ name: "金苗", styles: [{ name: "標準", id: id(500, 0) }, { name: "ノーマル", id: id(500, 1) }, { name: "悲しみ", id: id(500, 2) }] }];
  assert.deepEqual(resolveMood({ speakers: odd, speaker: id(500, 1), mood: "かなしい" }), { speaker: id(500, 2), intonation: 1.5, tempo: 0.8, speedFactor: 0.85 });
});

test("頭への説明: 使える印をすべて書く", () => {
  const p = moodPrompt();
  for (const name of MOOD_NAMES) assert.ok(p.includes(`[${name}]`), name);
});

test("名前の一部が合っても、反対の気持ちのスタイル（Unhappy・不幸せ）は選ばない", () => {
  const sp = [{ name: "x", styles: [{ name: "ノーマル", id: id(600, 0) }, { name: "Unhappy", id: id(600, 1) }, { name: "不幸せ", id: id(600, 2) }, { name: "Happy", id: id(600, 3) }] }];
  assert.equal(resolveMood({ speakers: sp, speaker: id(600, 0), mood: "うれしい" }).speaker, id(600, 3));
  const only = [{ name: "y", styles: [{ name: "ノーマル", id: id(700, 0) }, { name: "Unhappy", id: id(700, 1) }, { name: "不幸せ", id: id(700, 2) }] }];
  assert.equal(resolveMood({ speakers: only, speaker: id(700, 0), mood: "うれしい" }).speaker, id(700, 0));
});

test("画面（local-voice.js）が読み取る印の名前は、ここの気持ちの名前と同じ（漢字で書かれても同じ気持ちになる）", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "local-voice.js"), "utf8"), ctx);
  const words = ctx.window.LocalVoice.MOOD_WORDS;
  assert.deepEqual([...new Set(Object.values(words))].sort(), [...MOOD_NAMES].sort());
  for (const n of MOOD_NAMES) assert.equal(words[n], n);
});
