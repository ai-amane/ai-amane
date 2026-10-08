// 頭（常駐の Claude Code）に渡す発言の順番待ち（lib/brain-turns.js）のテスト
//  PC の画面と iPad の両方から話しかけたときに、返事がどの発言へのものかが混ざらないことを確かめる。
const test = require("node:test");
const assert = require("node:assert/strict");
const { createTurnQueue } = require("../lib/brain-turns");

function setup() {
  const written = [];
  const turns = createTurnQueue({ write: (text) => written.push(text) });
  return { turns, written };
}

test("返答中でなければ、すぐ頭に渡す", () => {
  const { turns, written } = setup();
  assert.equal(turns.current(), null);
  turns.say("こんにちは", "pc-1");
  assert.deepEqual(written, ["こんにちは"]);
  assert.equal(turns.current(), "pc-1");
  assert.equal(turns.busy(), true);
});

test("返答中に届いた発言は、返答が終わってから順に渡す（返事の持ち主が入れ替わらない）", () => {
  const { turns, written } = setup();
  turns.say("PC から", "pc-1");
  turns.say("iPad から", "ipad-1");
  turns.say("PC からもう一度", "pc-2");
  assert.deepEqual(written, ["PC から"]);
  assert.equal(turns.finish(), "pc-1");
  assert.deepEqual(written, ["PC から", "iPad から"]);
  assert.equal(turns.current(), "ipad-1");
  assert.equal(turns.finish(), "ipad-1");
  assert.equal(turns.finish(), "pc-2");
  assert.equal(turns.current(), null);
  assert.equal(turns.busy(), false);
  assert.equal(turns.finish(), null);   // 返答中の発言がないのに終わりが来ても壊れない
});

test("順番待ちの発言は取り消せる（ほかの画面の返答は止めない）", () => {
  const { turns, written } = setup();
  turns.say("PC から", "pc-1");
  turns.say("iPad から", "ipad-1");
  assert.equal(turns.cancel("ipad-1"), true);
  assert.equal(turns.cancel("ipad-1"), false);
  assert.equal(turns.cancel("pc-1"), false);     // 返答中の発言は取り消しではなく、中断で止める
  assert.equal(turns.finish(), "pc-1");
  assert.deepEqual(written, ["PC から"]);
  assert.equal(turns.busy(), false);
});

test("頭が止まったら、返答中・順番待ちの発言を全部捨てる", () => {
  const { turns, written } = setup();
  turns.say("a", "1");
  turns.say("b", "2");
  turns.reset();
  assert.equal(turns.current(), null);
  turns.say("c", "3");
  assert.deepEqual(written, ["a", "c"]);
  assert.equal(turns.finish(), "3");
  assert.equal(turns.busy(), false);
});

test("印のない発言（古い画面から）も、空の印として扱う", () => {
  const { turns } = setup();
  turns.say("a");
  assert.equal(turns.current(), "");
  assert.equal(turns.finish(), "");
});

test("頭に渡すのに失敗したら、その発言は返答中にせず知らせる（次の発言が止まらない）", () => {
  let fail = true;
  const written = [], failed = [];
  const turns = createTurnQueue({ write: (text) => { if (fail) throw new Error("起動できません"); written.push(text); }, onFail: (turn, e) => failed.push([turn, e.message]) });
  turns.say("一つ目", "a");
  assert.deepEqual(failed, [["a", "起動できません"]]);
  assert.equal(turns.current(), null);
  fail = false;
  turns.say("二つ目", "b");
  assert.deepEqual(written, ["二つ目"]);
  assert.equal(turns.current(), "b");
});

test("順番待ちは 5 件まで。それ以上は断る（false）", () => {
  const { turns } = setup();
  assert.equal(turns.say("返答中", "0"), true);
  for (let i = 1; i <= 5; i++) assert.equal(turns.say("待ち" + i, String(i)), true);
  assert.equal(turns.say("あふれ", "6"), false);
});

test("reset: 返答中・順番待ちだった発言の印を返す（画面に知らせるため）", () => {
  const { turns } = setup();
  turns.say("a", "a"); turns.say("b", "b"); turns.say("c", "c");
  assert.deepEqual(turns.reset(), ["a", "b", "c"]);
  assert.equal(turns.current(), null);
  assert.deepEqual(turns.reset(), []);
});
