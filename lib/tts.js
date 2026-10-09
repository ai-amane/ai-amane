// 声の合成（VOICEVOX / AivisSpeech。どちらも同じ使い方（API））
//  ・決まった言葉（呼ばれたときのあいさつ・待ち時間のつなぎの言葉など）は、準備のときに先に合成して覚えておく。
//    AivisSpeech は GPU でも 1 文に約 0.8 秒かかるので、これらはすぐ話し始められるように
//  ・ふつうの文は毎回違うので覚えない
//  ・声の気持ち（AivisSpeech のとき。lib/moods.js）: 文ごとの気持ちに合わせて、スタイル・強さ・緩急・速さを変える
const { resolveMood, isMood } = require("./moods");

const PHRASE_MAX = 40;
const MISSING_MAX = 20;   // 一覧にない声を覚えておく数

function createTts({ url, name, isAivis = false, fetchImpl = fetch, log = console, maxPhrases = PHRASE_MAX }) {
  const warmed = new Set();     // 準備（モデルの読み込み）が済んだ話者
  let phrases = new Map();      // 覚えた決まった言葉の音声（キー → WAV）
  let speakerList = null;       // /speakers の一覧（声の気持ちで、同じ話者のほかのスタイルを探すため）
  let missing = [];             // 一覧を取り直しても見つからなかった声（文ごとに取り直さないように。新しいものだけ覚える）
  let listing = null;           // 取りに行っている途中の一覧（同時に届いた文で、取りに行くのを 1 回にまとめる）
  let listFailed = false;       // 一覧を取れなかったことを、もう知らせたか

  async function call(pathname, init) {
    let r;
    try { r = await fetchImpl(url + pathname, init); }
    catch { throw Object.assign(new Error(`${name}（${url}）に接続できません。${name} を起動してください`), { status: 502 }); }
    if (!r.ok) throw Object.assign(new Error(`${name} ${pathname} HTTP ${r.status}`), { status: 502 });
    return r;
  }
  // tempo: 緩急（AivisSpeech だけにある。VOICEVOX には送らない）
  const keyOf = ({ text, speaker = 2, speed = 1.15, pitch = 0, intonation = 1, tempo = null }) =>
    JSON.stringify([String(text), Number(speaker), Number(speed), Number(pitch), Number(intonation), tempo == null ? null : Number(tempo)]);

  async function render({ text, speaker = 2, speed = 1.15, pitch = 0, intonation = 1, tempo = null }) {
    const sp = Number(speaker);
    const query = await (await call(`/audio_query?text=${encodeURIComponent(String(text).slice(0, 300))}&speaker=${sp}`, { method: "POST" })).json();
    const body = {
      ...query, speedScale: Number(speed), pitchScale: Number(pitch), intonationScale: Number(intonation), prePhonemeLength: 0.05, postPhonemeLength: 0.08,
      ...(tempo != null && { tempoDynamicsScale: Number(tempo) }),
    };
    const wav = await call(`/synthesis?speaker=${sp}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return Buffer.from(await wav.arrayBuffer());
  }

  // 選んだ声が一覧になければ取り直す（あとから入れたモデル）。取り直してもなければ、その声ではもう取り直さない
  async function listFor(speaker) {
    const has = (list) => list?.some((sp) => sp?.styles?.some((st) => st.id === speaker));
    if (has(speakerList) || missing.includes(speaker)) return speakerList;
    if (!listing) listing = call("/speakers").then((r) => r.json()).finally(() => { listing = null; });
    speakerList = await listing;
    if (!has(speakerList)) missing = [...missing, speaker].slice(-MISSING_MAX);
    return speakerList;
  }
  // mood: 文の気持ち（[うれしい] など。lib/moods.js）。AivisSpeech のときだけ使う
  //  ふつう・知らない気持ちは、気持ちなしと同じ（一覧も取りに行かない）。一覧を取れなくても、選んだ声で緩急と速さだけ変えて話す
  async function withMood(req) {
    const { mood, ...rest } = req;
    if (!isAivis || !isMood(mood) || mood === "ふつう") return rest;
    const speaker = Number(rest.speaker ?? 2);
    if (!Number.isSafeInteger(speaker)) return rest;
    let list = speakerList;
    try { list = await listFor(speaker); listFailed = false; }
    catch (e) { if (!listFailed) log.warn(`[tts] ${name} の話者の一覧を取れないので、声の気持ちはスタイルを変えずに話します: ${e.message}`); listFailed = true; }
    const m = resolveMood({ speakers: list, speaker, mood });
    const speed = Math.min(2, Math.max(0.5, Math.round(Number(rest.speed ?? 1.15) * m.speedFactor * 100) / 100));
    // 緩急 1 は既定のまま（送らない）。ふつうの気持ちの文が、覚えた決まった言葉と同じ合成になるように
    return { ...rest, speaker: m.speaker, speed, intonation: m.intonation, tempo: m.tempo === 1 ? null : m.tempo };
  }

  async function synthesize(req) {
    const r = await withMood(req);
    return phrases.get(keyOf(r)) || render(r);
  }

  // 決まった言葉を順に合成して覚える（裏で動かす。覚えすぎないよう、古いものから忘れる）
  async function remember(list, speaker, speed) {
    for (const text of list) {
      const key = keyOf({ text, speaker, speed });
      if (phrases.has(key)) continue;
      try {
        const wav = await render({ text, speaker, speed });
        const next = new Map([...phrases, [key, wav]]);
        while (next.size > maxPhrases) next.delete(next.keys().next().value);
        phrases = next;
      } catch { return; }   // つながらなくなったら、やめる（次の準備でまた試す）
    }
  }

  // 話者の準備。GPU モードだと話者ごとの最初の合成でモデルの読み込みが走って数秒かかるので、待受を始めたときなどに先に済ませる
  async function warmup({ speaker = 2, speed = 1.15, phrases: list = [] }) {
    const sp = Number(speaker);
    let ms = 0;
    if (!warmed.has(sp)) {
      const t0 = Date.now();
      try { await call(`/initialize_speaker?speaker=${sp}&skip_reinit=true`, { method: "POST" }); } catch { /* ない場合もある */ }
      await render({ text: "はい", speaker: sp, speed });
      warmed.add(sp);
      ms = Date.now() - t0;
      log.log(`[tts] ${name} 話者${sp} の準備完了（${ms}ms）`);
    }
    remember([...new Set(list.map(String).filter(Boolean))].slice(0, 20), sp, speed);
    return { ok: true, ms };
  }

  async function health() {
    try { return { ok: true, version: (await (await call("/version")).text()).replace(/"/g, "") }; }
    catch { return { ok: false, error: `${url} に接続できません` }; }
  }
  async function speakers() {
    const list = await (await call("/speakers")).json();
    speakerList = list; missing = [];
    return list.flatMap((sp) => sp.styles.map((st) => ({ id: st.id, name: `${sp.name}（${st.name}）` })));
  }

  return { synthesize, warmup, health, speakers, remembered: () => phrases.size, missingCount: () => missing.length };
}

module.exports = { createTts };
