// 声の合成（lib/tts.js）のテスト
//  VOICEVOX / AivisSpeech の代わりに、呼ばれた回数を数える偽物を使う。決まった言葉を覚えて、すぐ返せることを確かめる。
const test = require("node:test");
const assert = require("node:assert/strict");
const { createTts } = require("../lib/tts");

// 偽物のエンジン。audio_query は文と話者を返し、synthesis はそれを「音声」として返す
function fakeEngine() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(u.pathname);
    if (u.pathname === "/version") return new Response('"1.0"');
    if (u.pathname === "/audio_query") return Response.json({ text: u.searchParams.get("text"), speaker: u.searchParams.get("speaker") });
    if (u.pathname === "/synthesis") {
      const q = JSON.parse(init.body);
      return new Response(Buffer.from(`${q.text}|${u.searchParams.get("speaker")}|${q.speedScale}`));
    }
    if (u.pathname === "/initialize_speaker") return new Response("");
    return new Response("not found", { status: 404 });
  };
  const synthCount = () => calls.filter((c) => c === "/synthesis").length;
  return { calls, fetchImpl, synthCount };
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

test("つながらないときは、使っているエンジンの名前で知らせる", async () => {
  const tts = createTts({ url: "http://engine", name: "AivisSpeech", fetchImpl: async () => { throw new Error("ECONNREFUSED"); }, log: silent });
  await assert.rejects(tts.synthesize({ text: "a" }), (e) => /AivisSpeech（http:\/\/engine）に接続できません/.test(e.message) && e.status === 502);
  assert.deepEqual(await tts.health(), { ok: false, error: "http://engine に接続できません" });
});
