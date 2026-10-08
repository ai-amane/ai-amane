// 声の合成（VOICEVOX / AivisSpeech。どちらも同じ使い方（API））
//  ・決まった言葉（呼ばれたときのあいさつ・待ち時間のつなぎの言葉など）は、準備のときに先に合成して覚えておく。
//    AivisSpeech は GPU でも 1 文に約 0.8 秒かかるので、これらはすぐ話し始められるように
//  ・ふつうの文は毎回違うので覚えない
const PHRASE_MAX = 40;

function createTts({ url, name, fetchImpl = fetch, log = console, maxPhrases = PHRASE_MAX }) {
  const warmed = new Set();     // 準備（モデルの読み込み）が済んだ話者
  let phrases = new Map();      // 覚えた決まった言葉の音声（キー → WAV）

  async function call(pathname, init) {
    let r;
    try { r = await fetchImpl(url + pathname, init); }
    catch { throw Object.assign(new Error(`${name}（${url}）に接続できません。${name} を起動してください`), { status: 502 }); }
    if (!r.ok) throw Object.assign(new Error(`${name} ${pathname} HTTP ${r.status}`), { status: 502 });
    return r;
  }
  const keyOf = ({ text, speaker = 2, speed = 1.15, pitch = 0, intonation = 1 }) =>
    JSON.stringify([String(text), Number(speaker), Number(speed), Number(pitch), Number(intonation)]);

  async function render({ text, speaker = 2, speed = 1.15, pitch = 0, intonation = 1 }) {
    const sp = Number(speaker);
    const query = await (await call(`/audio_query?text=${encodeURIComponent(String(text).slice(0, 300))}&speaker=${sp}`, { method: "POST" })).json();
    const body = { ...query, speedScale: Number(speed), pitchScale: Number(pitch), intonationScale: Number(intonation), prePhonemeLength: 0.05, postPhonemeLength: 0.08 };
    const wav = await call(`/synthesis?speaker=${sp}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return Buffer.from(await wav.arrayBuffer());
  }

  async function synthesize(req) {
    return phrases.get(keyOf(req)) || render(req);
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
    return list.flatMap((sp) => sp.styles.map((st) => ({ id: st.id, name: `${sp.name}（${st.name}）` })));
  }

  return { synthesize, warmup, health, speakers, remembered: () => phrases.size };
}

module.exports = { createTts };
