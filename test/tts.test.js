// 声の合成（lib/tts.js）のテスト
//  VOICEVOX / AivisSpeech の代わりに、呼ばれた回数を数える偽物を使う。決まった言葉を覚えて、すぐ返せることを確かめる。
const test = require("node:test");
const assert = require("node:assert/strict");
const { createTts } = require("../lib/tts");

// 偽物のエンジン。audio_query は文と話者を返し、synthesis はそれを「音声」として返す
// AivisSpeech の話者一覧（まお。番号は「話者ごとの番号 × 32 + モデルの中の番号」）
const MAO = { name: "まお", styles: ["ノーマル", "ふつー", "あまあま", "おちつき", "からかい", "せつなめ"].map((name, i) => ({ name, id: 3200 + i })) };
function fakeEngine({ speakers = [MAO] } = {}) {
  const calls = [];
  const bodies = [];   // 合成に送った中身（話者の番号と、速さ・強さ・緩急）
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(u.pathname);
    if (u.pathname === "/version") return new Response('"1.0"');
    if (u.pathname === "/speakers") return Response.json(speakers);
    if (u.pathname === "/audio_query") return Response.json({ text: u.searchParams.get("text"), speaker: u.searchParams.get("speaker") });
    if (u.pathname === "/synthesis") {
      const q = JSON.parse(init.body);
      bodies.push({ speaker: Number(u.searchParams.get("speaker")), speed: q.speedScale, intonation: q.intonationScale, tempo: q.tempoDynamicsScale });
      return new Response(Buffer.from(`${q.text}|${u.searchParams.get("speaker")}|${q.speedScale}`));
    }
    if (u.pathname === "/initialize_speaker") return new Response("");
    return new Response("not found", { status: 404 });
  };
  const synthCount = () => calls.filter((c) => c === "/synthesis").length;
  return { calls, bodies, fetchImpl, synthCount };
}
const silent = { log() {}, warn() {} };
const waitFor = async (cond) => { for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); };

test("合成: 文を音声にする（速さも渡す）", async () => {
  const e = fakeEngine();
  const tts = createTts({ url: "http://engine", name: "AivisSpeech", fetchImpl: e.fetchImpl, log: silent });
  const wav = await tts.synthesize({ text: "こんにちは", speaker: 3, speed: 1.2 });
  assert.equal(wav.toString(), "こんにちは|3|1.2");
});

test("決まった言葉は、準備のときに先に合成して覚え、次からは合成せずに返す", async () => {
  const e = fakeEngine();
  const tts = createTts({ url: "http://engine", name: "AivisSpeech", fetchImpl: e.fetchImpl, log: silent });
  await tts.warmup({ speaker: 3, speed: 1.15, phrases: ["はい、お呼びでしょうか。", "少々お待ちください。"] });
  await waitFor(() => tts.remembered() === 2);
  const before = e.synthCount();
  assert.equal((await tts.synthesize({ text: "少々お待ちください。", speaker: 3, speed: 1.15 })).toString(), "少々お待ちください。|3|1.15");
  assert.equal(e.synthCount(), before, "覚えた言葉なのに合成し直した");
  await tts.synthesize({ text: "少々お待ちください。", speaker: 3, speed: 1.3 });   // 速さが違えば、合成し直す
  await tts.synthesize({ text: "少々お待ちください。", speaker: 8, speed: 1.15 });  // 声が違っても
  assert.equal(e.synthCount(), before + 2);
});

test("ふつうの文は覚えない（毎回違うので）", async () => {
  const e = fakeEngine();
  const tts = createTts({ url: "http://engine", name: "VOICEVOX", fetchImpl: e.fetchImpl, log: silent });
  await tts.synthesize({ text: "今日は晴れです。", speaker: 2 });
  await tts.synthesize({ text: "今日は晴れです。", speaker: 2 });
  assert.equal(e.synthCount(), 2);
  assert.equal(tts.remembered(), 0);
});

test("覚える言葉には上限があり、古いものから忘れる", async () => {
  const e = fakeEngine();
  const tts = createTts({ url: "http://engine", name: "VOICEVOX", fetchImpl: e.fetchImpl, log: silent, maxPhrases: 3 });
  await tts.warmup({ speaker: 2, speed: 1, phrases: ["一", "二", "三"] });
  await waitFor(() => tts.remembered() === 3);
  await tts.warmup({ speaker: 2, speed: 1, phrases: ["四"] });
  await waitFor(() => e.synthCount() >= 5);   // 準備の「はい」+ 一〜四
  assert.equal(tts.remembered(), 3);
  const before = e.synthCount();
  await tts.synthesize({ text: "一", speaker: 2, speed: 1 });   // いちばん古い「一」は忘れた
  await tts.synthesize({ text: "四", speaker: 2, speed: 1 });
  assert.equal(e.synthCount(), before + 1);
});

test("声の気持ち（AivisSpeech）: 気持ちに合うスタイルに切り替え、強さ・緩急・速さも変える", async () => {
  const e = fakeEngine();
  const tts = createTts({ url: "http://engine", name: "AivisSpeech", isAivis: true, fetchImpl: e.fetchImpl, log: silent });
  await tts.synthesize({ text: "えっ、もう終わったんですか？", speaker: 3200, speed: 1.15, mood: "うれしい" });
  await tts.synthesize({ text: "残念でしたね。", speaker: 3200, speed: 1.15, mood: "かなしい" });
  await tts.synthesize({ text: "次は九時です。", speaker: 3200, speed: 1.15, mood: "ふつう" });
  assert.deepEqual(e.bodies, [
    { speaker: 3204, speed: 1.22, intonation: 1.5, tempo: 1.4 },
    { speaker: 3205, speed: 0.98, intonation: 1.5, tempo: 0.8 },
    { speaker: 3200, speed: 1.15, intonation: 1, tempo: undefined },   // 緩急は既定（1）のまま
  ]);
  // 話者の一覧は 1 回だけ取りに行き、覚えておく
  assert.equal(e.calls.filter((c) => c === "/speakers").length, 1);
});

test("声の気持ち: 選んだ声が一覧になければ、一覧を取り直す（あとから入れたモデル）。ただし取り直しすぎない", async () => {
  const later = { name: "コハク", styles: [{ name: "ノーマル", id: 6400 }, { name: "せつなめ", id: 6402 }] };
  const list = [MAO];
  const e = fakeEngine({ speakers: list });
  const tts = createTts({ url: "http://engine", name: "AivisSpeech", isAivis: true, fetchImpl: e.fetchImpl, log: silent });
  await tts.synthesize({ text: "あ。", speaker: 3200, mood: "かなしい" });
  list.push(later);
  await tts.synthesize({ text: "い。", speaker: 6400, mood: "かなしい" });
  assert.equal(e.bodies.at(-1).speaker, 6402);
  // 取り直しても見つからなかった声は、もう取り直さない（文ごとに一覧を取りに行かない）
  await tts.synthesize({ text: "う。", speaker: 99999, mood: "かなしい" });
  await tts.synthesize({ text: "え。", speaker: 99999, mood: "かなしい" });
  assert.equal(e.calls.filter((c) => c === "/speakers").length, 3);
  assert.equal(e.bodies.at(-1).speaker, 99999);
});

test("声の気持ち: VOICEVOX では使わない（強さの意味が違い、緩急もない）", async () => {
  const e = fakeEngine();
  const tts = createTts({ url: "http://engine", name: "VOICEVOX", isAivis: false, fetchImpl: e.fetchImpl, log: silent });
  await tts.synthesize({ text: "えっ。", speaker: 2, speed: 1.15, mood: "うれしい" });
  assert.deepEqual(e.bodies, [{ speaker: 2, speed: 1.15, intonation: 1, tempo: undefined }]);
  assert.equal(e.calls.includes("/speakers"), false);
});

test("声の気持ち: 覚えた決まった言葉（つなぎの言葉）は、ふつうの気持ちのときにそのまま使う", async () => {
  const e = fakeEngine();
  const tts = createTts({ url: "http://engine", name: "AivisSpeech", isAivis: true, fetchImpl: e.fetchImpl, log: silent });
  await tts.warmup({ speaker: 3200, speed: 1.15, phrases: ["少々お待ちください。"] });
  await waitFor(() => tts.remembered() === 1);
  const before = e.synthCount();
  await tts.synthesize({ text: "少々お待ちください。", speaker: 3200, speed: 1.15, mood: "ふつう" });
  await tts.synthesize({ text: "少々お待ちください。", speaker: 3200, speed: 1.15 });
  assert.equal(e.synthCount(), before);
});

test("声の気持ち: 話者の一覧が取れなくても、選んだ声で話す。ふつうの気持ちでは一覧を取りに行かない", async () => {
  const e = fakeEngine();
  const broken = async (url, init) => (new URL(url).pathname === "/speakers" ? new Response("err", { status: 500 }) : e.fetchImpl(url, init));
  const tts = createTts({ url: "http://engine", name: "AivisSpeech", isAivis: true, fetchImpl: broken, log: silent });
  assert.equal((await tts.synthesize({ text: "やった。", speaker: 3200, speed: 1.15, mood: "うれしい" })).toString(), "やった。|3200|1.22");
  const before = e.calls.length;
  await tts.synthesize({ text: "はい。", speaker: 3200, speed: 1.15, mood: "ふつう" });
  await tts.synthesize({ text: "はい。", speaker: 3200, speed: 1.15, mood: "知らない気持ち" });
  assert.deepEqual(e.calls.slice(before), ["/audio_query", "/synthesis", "/audio_query", "/synthesis"]);
});

test("声の気持ち: 同時に届いた文でも、話者の一覧は 1 回だけ取りに行く。見つからない声を覚えすぎない", async () => {
  const e = fakeEngine();
  const tts = createTts({ url: "http://engine", name: "AivisSpeech", isAivis: true, fetchImpl: e.fetchImpl, log: silent });
  await Promise.all(["一。", "二。", "三。"].map((text) => tts.synthesize({ text, speaker: 3200, mood: "かなしい" })));
  assert.equal(e.calls.filter((c) => c === "/speakers").length, 1);
  // 数字でない声の番号では、一覧を取りに行かない
  await tts.synthesize({ text: "四。", speaker: "abc", mood: "かなしい" }).catch(() => {});
  assert.equal(e.calls.filter((c) => c === "/speakers").length, 1);
  // 見つからない声を次々に送られても、覚えておく数には上限がある（古いものから忘れる）
  for (let i = 0; i < 40; i++) await tts.synthesize({ text: "五。", speaker: 900000 + i, mood: "かなしい" });
  assert.ok(tts.missingCount() <= 20, String(tts.missingCount()));
});

test("つながらないときは、使っているエンジンの名前で知らせる", async () => {
  const tts = createTts({ url: "http://engine", name: "AivisSpeech", fetchImpl: async () => { throw new Error("ECONNREFUSED"); }, log: silent });
  await assert.rejects(tts.synthesize({ text: "a" }), (e) => /AivisSpeech（http:\/\/engine）に接続できません/.test(e.message) && e.status === 502);
  assert.deepEqual(await tts.health(), { ok: false, error: "http://engine に接続できません" });
});
