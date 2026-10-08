// 発話の区切り（public/mic-vad.js）のテスト
//  マイクの代わりに、音量（dB）を決めたフレームを流し込んで、区切り方を確かめる。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadMicVAD() {
  const ctx = vm.createContext({ window: {}, Blob });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "mic-vad.js"), "utf8"), ctx);
  return ctx.window.MicVAD;
}
const { Listener } = loadMicVAD();

const FRAME_SEC = 0.032; // 512 サンプル @16kHz
const frameOf = (db) => new Float32Array(512).fill(10 ** (db / 20));
// sec 秒ぶんのフレームの音量。db は数値か、フレーム番号から音量を返す関数
const span = (sec, db) => Array.from({ length: Math.round(sec / FRAME_SEC) }, (_, i) => (typeof db === "function" ? db(i) : db));
// 再現できる乱数（揺れる雑音用）
function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// WAV（Blob）の中身（16bit PCM）と、その比較（食い違ったときに巨大な差分を作らないよう、一致したかだけを返す）
const pcmOf = async (wav) => new Int16Array((await wav.arrayBuffer()).slice(44));
const sameSamples = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

// 音量の並びを流し込み、話し始めの時刻と、切り出した発話（始まり・終わりの時刻、長さ、声の長さ、WAV）を記録する
function run(levels, opts = {}) {
  const starts = [];
  const utterances = [];
  let i = 0;
  let startAt = null;
  const l = new Listener({
    ...opts,
    onSpeechStart: () => { startAt = i * FRAME_SEC; starts.push(startAt); },
    onUtterance: (wav, sec, voiceSec) => utterances.push({ start: startAt, end: (i + 1) * FRAME_SEC, sec, voiceSec, wav }),
  });
  for (; i < levels.length; i++) l.onFrame(frameOf(levels[i]));
  return { starts, utterances };
}

const STANDBY = { adaptive: true };   // 待受中（騒がしい場所向けの判定）

// ---------- 静かな部屋（会話中・待受中とも同じように区切る） ----------
for (const [mode, opts] of [["会話中", {}], ["待受中", STANDBY]]) {
  test(`${mode}: 静かな部屋で 1 秒話すと、ひとつの発話として切り出す`, () => {
    const { utterances } = run([...span(2, -60), ...span(1, -25), ...span(2, -60)], opts);
    assert.equal(utterances.length, 1);
    assert.ok(utterances[0].sec > 0.9 && utterances[0].sec < 1.8, `長さ ${utterances[0].sec} 秒`);
  });

  test(`${mode}: 静かな部屋で 4 秒話し続けても、途中で切らない`, () => {
    const speech = span(4, (i) => (Math.floor(i / 3) % 2 ? -35 : -25)); // 話し声は音節ごとに大きさが揺れる
    const { utterances } = run([...span(2, -60), ...speech, ...span(2, -60)], opts);
    assert.equal(utterances.length, 1);
    assert.ok(utterances[0].sec > 3.8, `長さ ${utterances[0].sec} 秒`);
  });

  test(`${mode}: 静かな部屋では、離れた所の小さな音（雑音より 11dB 大きい程度）を声と間違えない`, () => {
    const { utterances } = run([...span(5, -58), ...span(1.5, -47), ...span(2, -58)], opts);
    assert.equal(utterances.length, 0, `発話の数 ${utterances.length}`);
  });
}

// ---------- 会話中（既定）。長く話しても、声を雑音と覚えない ----------
test("会話中: 息継ぎの少ない長い話（9 秒）のあと少し弱めに話しても、途中で切らない", () => {
  const rand = mulberry32(4);
  // 単語の切れ目で少し落ち込むだけで、静かになる間がない話し声
  const fluent = span(9, (i) => (i % 6 === 5 ? -36 - rand() * 6 : -22 - rand() * 6));
  const levels = [...span(2, -60), ...fluent, ...span(0.6, -34), ...span(2, (i) => (i % 6 === 5 ? -38 : -24)), ...span(2, -60)];
  const { utterances } = run(levels);
  assert.equal(utterances.length, 1, `発話の数 ${utterances.length}（${utterances.map((u) => u.sec).join(", ")} 秒）`);
  assert.ok(utterances[0].sec > 11, `長さ ${utterances[0].sec} 秒`);
});

// ---------- 待受中（adaptive）。鳴り続ける音に慣れて区切る ----------
test("待受中: ドライヤーのような鳴りっぱなしの音が始まっても、発話が終わらないままにならない", () => {
  const { starts, utterances } = run([...span(2, -60), ...span(40, -35)], STANDBY);
  assert.ok(utterances.length >= 1, "鳴り始めの発話が終わっていない");
  assert.ok(utterances[0].sec < 7, `鳴り始めの発話が ${utterances[0].sec} 秒続いた`);
  assert.deepEqual(starts.filter((t) => t > 10), [], "雑音に慣れたあとも、話し始めと判定し続けている");
});

test("待受中: 鳴りっぱなしの音の中で話すと、その声だけを切り出す", () => {
  const voiceAt = 14;
  const { utterances } = run([...span(2, -60), ...span(12, -35), ...span(1, -15), ...span(3, -35)], STANDBY);
  const u = utterances.find((x) => x.start > voiceAt - 0.5);
  assert.ok(u, "声を切り出せていない");
  assert.ok(u.start < voiceAt + 0.3, `話し始めの判定が遅い（${u.start} 秒）`);
  assert.ok(u.end < voiceAt + 1 + 1.2, `話し終わりの判定が遅い（${u.end} 秒）`);
});

test("待受中: 大きさが揺れる雑音の中でも、声を切り出す", () => {
  const rand = mulberry32(1);
  const noise = (sec) => span(sec, () => -39 + rand() * 8);
  const voiceAt = 15;
  const { utterances } = run([...span(2, -60), ...noise(13), ...span(1, -12), ...noise(3)], STANDBY);
  const u = utterances.find((x) => x.start > voiceAt - 0.5);
  assert.ok(u, "声を切り出せていない");
  assert.ok(u.sec < 2.5, `声の発話が ${u.sec} 秒続いた`);
});

test("待受中: ドライヤーのように大きさが揺れない音の中では、雑音より 10dB ほど大きい声でも拾う", () => {
  const voiceAt = 14;
  const voice = span(1.5, (i) => (i % 8 < 6 ? -18 : -27)); // 音節ごとに少し弱まる声
  const { utterances } = run([...span(2, -60), ...span(12, -30), ...voice, ...span(3, -30)], STANDBY);
  const u = utterances.find((x) => x.start > voiceAt - 0.5);
  assert.ok(u, "声を切り出せていない");
  assert.ok(u.end < voiceAt + 1.5 + 1.2, `話し終わりの判定が遅い（${u.end} 秒）`);
});

test("待受中: カタカタという音（0.1 秒ほどの山が続く）を声と間違えない", () => {
  const rand = mulberry32(2);
  const clatter = span(20, (i) => (i % 5 < 3 ? -46 + rand() * 4 : -34 + rand() * 4));
  const { starts } = run([...span(2, -60), ...clatter], STANDBY);
  assert.deepEqual(starts.filter((t) => t > 8), [], "雑音に慣れたあとも、話し始めと判定している");
});

test("待受中: ときどき長めに鳴る雑音（0.2 秒ほどの山）も、声と間違えない", () => {
  const rand = mulberry32(3);
  const bursts = span(20, (i) => (i % 16 < 10 ? -46 + rand() * 2 : -34 + rand() * 2));
  const { starts } = run([...span(2, -60), ...bursts], STANDBY);
  assert.deepEqual(starts.filter((t) => t > 8), [], "雑音に慣れたあとも、話し始めと判定している");
});

// ---------- 切り方の設定（待受中に使う） ----------
test("preRollMs: 雑音の中で話し始めの判定が遅れても、その前の短い呼びかけを含める", async () => {
  // ドライヤーの中で、短い「あまね」（0.1 秒）→ 0.5 秒の間 → 用件（1.5 秒）
  const wake = span(0.1, -16);
  const ask = span(1.5, (i) => (i % 8 < 6 ? -18 : -27));
  const levels = [...span(2, -60), ...span(12, -30), ...wake, ...span(0.5, -30), ...ask, ...span(3, -30)];
  const { utterances } = run(levels, { ...STANDBY, preRollMs: 1500 });
  const loudest = (pcm) => pcm.reduce((m, v) => Math.max(m, v), 0);
  const last = await pcmOf(utterances[utterances.length - 1].wav);
  assert.ok(loudest(last) > 0.9 * 32767 * 10 ** (-16 / 20), "用件の発話に、その前の呼びかけが含まれていない");
});

test("preRollMs を長くしても、短い物音は発話にしない", () => {
  const { utterances } = run([...span(2, -60), ...span(0.2, -25), ...span(2, -60)], { preRollMs: 1500 });
  assert.equal(utterances.length, 0, `物音を発話にした（${utterances[0]?.sec} 秒）`);
});

test("preRollMs で長めに含めた手前は、声の長さ（3 つ目の引数）に数えない", () => {
  const { utterances } = run([...span(3, -60), ...span(0.5, -25), ...span(2, -60)], { preRollMs: 1500 });
  assert.equal(utterances.length, 1);
  assert.ok(utterances[0].sec > 1.9, `長さ ${utterances[0].sec} 秒`);
  assert.ok(utterances[0].voiceSec < 1.2, `声の長さ ${utterances[0].voiceSec} 秒`);
});

test("maxMs で 1 回の長さの上限を短くできる（待受中に数秒ごとに呼びかけを調べるため）", () => {
  // テレビの話し声のように、区切りが来ない音
  const talk = span(20, (i) => (i % 8 < 6 ? -20 : -45));
  const { utterances } = run([...span(2, -60), ...talk], { maxMs: 6000 });
  assert.ok(utterances.length >= 2, `発話の数 ${utterances.length}`);
  for (const u of utterances) assert.ok(u.sec <= 6.3, `${u.sec} 秒`);
});

// フレームごとに少しずつ違う音量にして、どこを切り出したかを中身で確かめる
const uniqueTalk = (sec) => span(sec, (i) => (i % 8 < 6 ? -20 - (i % 97) * 0.05 : -45));

test("overlapMs: 上限で切るとき、終わりの部分を次の発話の頭に重ねる（切れ目にかかった呼びかけが途切れない）", async () => {
  const { utterances } = run([...span(2, -60), ...uniqueTalk(14)], { maxMs: 6000, overlapMs: 1500 });
  assert.ok(utterances.length >= 2, `発話の数 ${utterances.length}`);
  const [a, b] = [await pcmOf(utterances[0].wav), await pcmOf(utterances[1].wav)];
  const overlap = Math.round(1.5 / FRAME_SEC) * 512;
  assert.ok(sameSamples(b.slice(0, overlap), a.slice(a.length - overlap)), "次の発話の頭が、前の発話の終わりと同じではない");
});

test("overlapMs を指定しなければ重ねない（会話中に同じ言葉を 2 回送らない）", async () => {
  const { utterances } = run([...span(2, -60), ...uniqueTalk(14)], { maxMs: 6000 });
  assert.ok(utterances.length >= 2, `発話の数 ${utterances.length}`);
  const [a, b] = [await pcmOf(utterances[0].wav), await pcmOf(utterances[1].wav)];
  const n = 4 * 512;
  assert.ok(!sameSamples(b.slice(0, n), a.slice(a.length - n)), "重ねていないはずの部分が重なっている");
});

test("overlapMs: 上限で切った直後に音が止んだら、重ねた部分だけを送り直さない", () => {
  // 話し始めから 6 秒（上限）を少し過ぎたところで黙る
  const { utterances } = run([...span(2, -60), ...uniqueTalk(5.9), ...span(2, -60)], { maxMs: 6000, overlapMs: 1500 });
  assert.equal(utterances.length, 1, `発話の数 ${utterances.length}（${utterances.map((u) => u.sec).join(", ")} 秒）`);
});

test("overlapMs が maxMs より長くても、細切れの発話を送り続けない", () => {
  const { utterances } = run([...span(2, -60), ...uniqueTalk(14)], { maxMs: 2000, overlapMs: 5000 });
  assert.ok(utterances.length < 20, `発話の数 ${utterances.length}`);
});

// ---------- 話し始めの照合（onEarly。会話の主の声か、話し始めのうちに調べる） ----------
function runEarly(levels, opts = {}) {
  const early = [];
  let i = 0;
  const l = new Listener({ ...opts, onEarly: (wav) => early.push({ at: (i + 1) * FRAME_SEC, wav }) });
  for (; i < levels.length; i++) l.onFrame(frameOf(levels[i]));
  return early;
}

test("onEarly: 話し始めて earlyMs ほど声が続いたら、そこまでの音声を 1 回だけ渡す", async () => {
  const early = runEarly([...span(2, -60), ...span(3, -25), ...span(2, -60)], { earlyMs: 1000 });
  assert.equal(early.length, 1);
  assert.ok(early[0].at > 2.9 && early[0].at < 3.5, `渡した時刻 ${early[0].at} 秒`);
  const sec = (await pcmOf(early[0].wav)).length / 16000;
  assert.ok(sec > 0.9 && sec < 1.6, `渡した長さ ${sec} 秒`);
});

test("onEarly: earlyMs より短い声では渡さない", () => {
  assert.equal(runEarly([...span(2, -60), ...span(0.6, -25), ...span(2, -60)], { earlyMs: 1000 }).length, 0);
});

test("onEarly: 発話ごとに 1 回ずつ渡す", () => {
  const early = runEarly([...span(2, -60), ...span(2, -25), ...span(2, -60), ...span(2, -25), ...span(2, -60)], { earlyMs: 1000 });
  assert.equal(early.length, 2);
});

// ---------- 上限で区切ったとき（会話中・声紋）。区切ったことを伝え、続きも聞き落とさない ----------
test("maxMs で区切った発話には cut: true を、話し終わって区切った発話には付けずに渡す", () => {
  const infos = [];
  const l = new Listener({ maxMs: 6000, onUtterance: (wav, sec, voiceSec, info = {}) => infos.push(Boolean(info.cut)) });
  for (const db of [...span(2, -60), ...span(9, -25), ...span(2, -60)]) l.onFrame(frameOf(db));
  assert.deepEqual(infos, [true, false]);
});

test("重ねずに区切ったあとも、話し続けている声は次の発話として聞き続ける（AI が話している間の厳しい判定でも落とさない）", () => {
  const secs = [];
  const l = new Listener({ maxMs: 6000, onUtterance: (wav, sec) => secs.push(sec) });
  const feed = (levels) => { for (const db of levels) l.onFrame(frameOf(db)); };
  feed(span(2, -60));
  feed(span(0.5, -40));   // 話し始め（雑音 -60 dB より 20 dB 大きい）
  l.strict = true;        // AI が話し始めた（話し始めの判定が 8 dB 厳しくなる。-40 dB では話し始めと判定されない）
  feed(span(9.5, -40));
  feed(span(2, -60));
  assert.equal(secs.length, 2, `発話の数 ${secs.length}（${secs.join(", ")} 秒）`);
  assert.ok(secs[1] > 3.5, `区切ったあとの続き ${secs[1]} 秒`);
});
