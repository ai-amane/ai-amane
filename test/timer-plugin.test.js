// タイマー（plugins/timer）のテスト
//  時計とタイマーを偽物にして、時間を進めて鳴るかを確かめる
const test = require("node:test");
const assert = require("node:assert/strict");
const { createTimers, durationText, clockText, nextClock } = require("../plugins/timer/timer-core");
const timerPlugin = require("../plugins/timer/plugin");

// 偽物の時計（advance で時間を進めると、時刻が来たタイマーを呼ぶ）
function fakeClock(start) {
  let t = start;
  let pending = null;
  return {
    now: () => t,
    setTimer: (fn, ms) => { pending = { fn, at: t + ms }; return pending; },
    clearTimer: (h) => { if (pending === h) pending = null; },
    advance(ms) {
      const end = t + ms;
      while (pending && pending.at <= end) { const p = pending; pending = null; t = p.at; p.fn(); }
      t = end;
    },
  };
}
function memoryStore(initial = {}) {
  let v = initial;
  return { load: () => v, save: (x) => { v = JSON.parse(JSON.stringify(x)); }, get: () => v };
}
const at = (h, m) => new Date(2026, 9, 8, h, m, 0, 0).getTime();   // 2026-10-08（PC の時刻）

function setup(start = at(15, 0), store = memoryStore()) {
  const clock = fakeClock(start);
  const rang = [], changes = [];
  const timers = createTimers({ store, notify: (t, text) => rang.push([t.device, text]), onChange: (l) => changes.push(l), ...clock });
  timers.load();
  return { timers, clock, rang, changes, store };
}

test("言葉: 秒数と時刻を、読み上げやすい言葉にする", () => {
  assert.equal(durationText(45), "45秒");
  assert.equal(durationText(180), "3分");
  assert.equal(durationText(90), "1分30秒");
  assert.equal(durationText(5400), "1時間30分");
  assert.equal(durationText(3600), "1時間");
  const now = at(15, 0);
  assert.equal(clockText(at(15, 30), now), "15時30分");
  assert.equal(clockText(at(7, 0) + 24 * 3600 * 1000, now), "明日の7時");
});

test("時刻: 次にその時刻になる瞬間（過ぎていれば明日）", () => {
  const now = at(15, 0);
  assert.equal(nextClock("15:30", now), at(15, 30));
  assert.equal(nextClock("7:00", now), at(7, 0) + 24 * 3600 * 1000);
  assert.equal(nextClock("15:00", now), at(15, 0) + 24 * 3600 * 1000);   // ちょうど今なら明日
  assert.equal(nextClock("15：30", now), at(15, 30));                    // 全角のコロンも
  assert.throws(() => nextClock("25:00", now), /正しくありません/);
  assert.throws(() => nextClock("7時", now), /7:30 のように/);
});

test("タイマー: セットした秒数で、頼んだ画面に鳴らす", () => {
  const { timers, clock, rang } = setup();
  const r = timers.set({ seconds: 180, label: "カップ麺", device: "ipad" });
  assert.equal(r.text, "「カップ麺」のタイマーを、3分後（15時3分）に鳴るようにセットしました。");
  clock.advance(179 * 1000);
  assert.deepEqual(rang, []);
  clock.advance(1000);
  assert.deepEqual(rang, [["ipad", "お時間です。カップ麺。"]]);
  assert.equal(timers.list().length, 0);
});

test("アラームと、名前のないタイマーの言葉", () => {
  const { timers, clock, rang } = setup();
  assert.equal(timers.set({ at: "15:30" }).text, "アラームを、15時30分に鳴るようにセットしました。");
  timers.set({ seconds: 60 });
  clock.advance(60 * 1000);
  clock.advance(29 * 60 * 1000);
  assert.deepEqual(rang.map((x) => x[1]), ["1分がたちました。", "15時30分になりました。"]);
});

test("一覧: 早く鳴る順に、残り時間を言う", () => {
  const { timers, clock } = setup();
  assert.equal(timers.listText(), "セットしているタイマーはありません。");
  timers.set({ seconds: 1800, label: "洗濯物を取り込む" });
  timers.set({ seconds: 180, label: "カップ麺" });
  clock.advance(50 * 1000);
  assert.equal(timers.listText(), "タイマーは2つです。カップ麺は残り2分10秒、洗濯物を取り込むは残り29分10秒。");
});

test("止める: 名前で選ぶ。1つだけなら名前なしで止める。2つ以上で名前がなければ聞き返す", () => {
  const { timers, clock, rang } = setup();
  timers.set({ seconds: 180, label: "カップ麺" });
  timers.set({ seconds: 600, label: "お風呂" });
  assert.throws(() => timers.cancel({}), /2つあります（カップ麺・お風呂）。どれを止めるか/);
  assert.throws(() => timers.cancel({ label: "洗濯" }), /見つかりません/);
  assert.equal(timers.cancel({ label: "カップ麺のタイマー" }).text, "カップ麺を止めました。");
  assert.equal(timers.cancel({}).text, "お風呂を止めました。");
  assert.throws(() => timers.cancel({}), /ありません/);
  timers.set({ seconds: 10 }); timers.set({ seconds: 20 });
  assert.equal(timers.cancel({ all: true }).text, "タイマーを2つ止めました。");
  clock.advance(60 * 1000);
  assert.deepEqual(rang, []);   // 止めたものは鳴らない
});

test("範囲: 秒数も時刻もなければ断る。上限の数を超えたら断る", () => {
  const { timers } = setup();
  assert.throws(() => timers.set({}), /seconds/);
  assert.throws(() => timers.set({ seconds: 0 }), /seconds/);
  for (let i = 0; i < 20; i++) timers.set({ seconds: 100 + i });
  assert.throws(() => timers.set({ seconds: 5 }), /20 個まで/);
});

test("保存: 起動し直しても残る。少し過ぎたものはすぐ鳴らし、大きく過ぎたものは消す", () => {
  const first = setup();
  first.timers.set({ seconds: 600, label: "残る" });
  first.timers.set({ seconds: 60, label: "少し過ぎる" });
  first.timers.set({ seconds: 30, label: "大きく過ぎる" });
  const saved = first.store.get();
  // 15 分止まっていたあとに起動（「大きく過ぎる」は 14.5 分、「少し過ぎる」は 14 分過ぎ → 10 分を超えて消える。
  // 「残る」（15時10分）は 5 分過ぎ → すぐ鳴らす）
  const late = setup(at(15, 15), memoryStore(saved));
  assert.deepEqual(late.timers.list().map((t) => t.label), ["残る"]);
  late.clock.advance(0);
  assert.deepEqual(late.rang.map((x) => x[1]), ["お時間です。残る。"]);
  // 5 分止まっていたあとに起動（「少し過ぎる」は 4 分過ぎ → すぐ鳴らす）
  const soon = setup(at(15, 5), memoryStore(saved));
  soon.clock.advance(0);
  assert.deepEqual(soon.rang.map((x) => x[1]), ["お時間です。少し過ぎる。", "お時間です。大きく過ぎる。"]);
  assert.deepEqual(soon.timers.list().map((t) => t.label), ["残る"]);
});

test("プラグインとして: 画面に残り時間を出し、鳴ったら頼んだ画面に知らせる", async () => {
  const sent = [], statuses = [];
  const ctx = { store: memoryStore(), notify: (o) => sent.push(o), setStatus: (l) => statuses.push(l), device: "" };
  timerPlugin.start(ctx);
  try {
    const r = await timerPlugin.actions.set.run({ seconds: 1, label: "テスト" }, { ...ctx, device: "pc" });
    assert.match(r.text, /「テスト」のタイマー/);
    assert.equal(statuses.at(-1)[0].text, "テスト");
    assert.ok(Number.isFinite(statuses.at(-1)[0].endsAt));
    assert.equal(await timerPlugin.actions.list.run({}), "タイマーは1つです。テストは残り1秒。");
    await new Promise((res) => setTimeout(res, 1200));
    assert.deepEqual(sent, [{ text: "お時間です。テスト。", chime: "alarm", to: "pc" }]);
    assert.deepEqual(statuses.at(-1), []);
  } finally { timerPlugin.stop(); }
});

test("止める: 名前の一部が 2 つ以上に当たるときは聞き返す。「タイマー」だけの名前は名前なしと同じ", () => {
  const { timers } = setup();
  timers.set({ seconds: 180 });               // 3分のタイマー
  timers.set({ seconds: 780 });               // 13分のタイマー
  assert.throws(() => timers.cancel({ label: "3分" }), /^Error: 「3分」に当たるタイマーが2つあります/);
  assert.equal(timers.cancel({ label: "3分のタイマー" }).text, "3分のタイマーを止めました。");   // 名前がそのまま合うもの
  assert.equal(timers.cancel({ label: "タイマー" }).text, "13分のタイマーを止めました。");      // 1 つだけなので、名前なしと同じに止める
  assert.equal(timers.set({ seconds: 60, label: "タイマー" }).timer.label, "");
});

test("鳴らす: 同じ時刻のタイマーは全部鳴らす。1 つの知らせに失敗しても、ほかは鳴らして予約も続ける", () => {
  const clock = fakeClock(at(15, 0));
  const rang = [];
  let first = true;
  const timers = createTimers({
    store: memoryStore(), log: { warn() {} }, ...clock,
    notify: (t) => { if (first) { first = false; throw new Error("画面に送れない"); } rang.push(t.label); },
  });
  timers.load();
  timers.set({ seconds: 60, label: "A" }); timers.set({ seconds: 60, label: "B" }); timers.set({ seconds: 120, label: "C" });
  clock.advance(60 * 1000);
  assert.deepEqual(rang, ["B"]);
  clock.advance(60 * 1000);
  assert.deepEqual(rang, ["B", "C"]);
});

test("長いタイマー: 先のタイマーも、1 分ごとに時刻を確かめ直して、時間どおりに鳴らす", () => {
  const { timers, clock, rang } = setup();
  timers.set({ seconds: 2 * 3600 + 30, label: "長い" });
  clock.advance(2 * 3600 * 1000);
  assert.deepEqual(rang, []);
  clock.advance(30 * 1000);
  assert.deepEqual(rang.map((x) => x[1]), ["お時間です。長い。"]);
});

test("保存: 壊れたタイマー（形が違う・数でない）は読み込まない", () => {
  const t0 = at(15, 0);
  const store = memoryStore({ seq: 3, timers: [
    { id: "t1", kind: "timer", seconds: 60, endsAt: t0 + 60000, label: "正しい" },
    { id: "t2", kind: "timer", endsAt: t0 + 60000 },                   // seconds がない
    { id: "t3", kind: "other", endsAt: t0 + 60000 },
    { kind: "alarm", endsAt: t0 + 60000 },                             // id がない
    { id: "t4", kind: "alarm", endsAt: "あした" },
  ] });
  const { timers } = setup(t0, store);
  assert.deepEqual(timers.list().map((t) => t.label), ["正しい"]);
  assert.equal(timers.set({ seconds: 10 }).timer.id, "t4");   // 番号は続きから
});
