// 呼びかけの言葉を欄に足す関数（public/wake-words.js）のテスト
//  聞こえた文に「、」や空白が入っていても、1 つの言葉として足せることを確かめる
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load() {
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "wake-words.js"), "utf8"), ctx);
  return ctx.window.AmaneWakeWords;
}
const { cleanHeard, addHeard, splitList } = load();

test("「ねえ、あまね」は 1 つの言葉として足される（2 つに割れない）", () => {
  const list = addHeard(["あまね"], "ねえ、あまね");
  assert.deepEqual([...list], ["あまね", "ねえあまね"]);
  assert.equal(splitList(list.join(", ")).length, 2);
});

test("読点・句点・空白・カンマは取り除く", () => {
  assert.equal(cleanHeard("ねえ、あまね。"), "ねえあまね");
  assert.equal(cleanHeard(" Hey， Amane! "), "HeyAmane");
  assert.equal(cleanHeard("、。"), "");
});

test("もう入っている言葉は足さない。空なら何もしない。元の並びは変えない", () => {
  const base = ["あまね"];
  assert.deepEqual([...addHeard(base, "あまね。")], ["あまね"]);
  assert.deepEqual([...addHeard(base, "、")], ["あまね"]);
  addHeard(base, "天音");
  assert.deepEqual(base, ["あまね"]);
});
