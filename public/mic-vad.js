// AI あまね 発話の区切り（VAD）とローカル Whisper への送信
//  マイク音声を 16kHz で取り込み、声の大きさ（周囲の雑音レベルに自動で合わせる）で
//  「話し始め」「話し終わり」を判定して、1発話ぶんの WAV を Whisper サーバーに送る。
window.MicVAD = (() => {
  "use strict";

  const WORKLET = `
    class Tap extends AudioWorkletProcessor {
      constructor() { super(); this.buf = new Float32Array(512); this.n = 0; }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch) for (let i = 0; i < ch.length; i++) {
          this.buf[this.n++] = ch[i];
          if (this.n === 512) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
        }
        return true;
      }
    }
    registerProcessor("amane-tap", Tap);`;

  const FRAME_MS = 32;              // 512 サンプル @16kHz
  const PRE_ROLL = 10;              // 話し始めの手前 約0.3秒も含める
  const START_FRAMES = 5;           // 約0.16秒続いたら話し始め（クリック音などの一瞬の音は無視）
  const MIN_SPEECH_FRAMES = 12;     // 0.4秒未満は捨てる（咳・物音）
  const MAX_MS = 15000;             // 1 回の発話の長さの上限（opts.maxMs で変えられる）
  const END_SILENCE_MS = 550;       // これだけ黙ったら話し終わり（opts.endSilenceMs で変えられる）
  const START_MARGIN = 16;          // 話し始めと判定する、雑音との差（dB）
  const KEEP_MARGIN = 8;            // 話し続けていると判定する、雑音との差（dB）
  // 騒がしい場所向けの判定（opts.adaptive。待受中に使う）
  const NOISE_FRAMES = Math.round(5000 / FRAME_MS);   // 雑音の大きさと揺れは直近 5 秒の音量から求める
  const RELAX_MIN = 8;              // 揺れない雑音の中で、話し始めの判定を緩めるときの最小の差（dB）
  const RELAX_ABOVE = -45;          // 雑音がこれより大きい（dBFS）ときだけ緩める（静かな部屋では緩めない）
  const RELAX_AFTER = Math.round(2000 / FRAME_MS);    // 話していない間の音量がこれだけ溜まってから緩める

  const sortedOf = (list) => [...list].sort((a, b) => a - b);
  const at = (sorted, p) => sorted[Math.floor((sorted.length - 1) * p)];   // 小さいほうから p（0〜1）の位置の値
  const pushRecent = (list, v) => { list.push(v); if (list.length > NOISE_FRAMES) list.shift(); };

  function encodeWav(frames) {
    const len = frames.reduce((a, f) => a + f.length, 0);
    const buf = new ArrayBuffer(44 + len * 2);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + len * 2, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, "data"); v.setUint32(40, len * 2, true);
    let o = 44;
    for (const f of frames) for (let i = 0; i < f.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, f[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  class Listener {
    // opts: { onSpeechStart, onUtterance(wavBlob, sec, voiceSec), endSilenceMs, maxMs, overlapMs, preRollMs, adaptive, sensitivity,
    //         onEarly(wavBlob), earlyMs }
    //  onEarly: 話し始めて earlyMs（既定 1 秒）ほど声が続いたら、そこまでの音声を発話ごとに 1 回渡す
    //           （会話の主の声かを、話し終わる前に調べるため。local-voice.js）
    //  以下は待受中用（会話中は使わない）
    //  adaptive: 騒がしい場所向けの判定。話している間も雑音の大きさを学習し（ドライヤーなどが鳴り始めても区切れる）、
    //            大きさが揺れない雑音の中では話し始めの判定を緩める。長く話し続けると声を雑音と覚えることがあるので、会話中は使わない
    //  overlapMs: maxMs で切るとき、終わりのこの長さを次の発話の頭に重ねる（切れ目にかかった呼びかけを途切れさせない）
    //  preRollMs: 話し始めの手前をこの長さまで含める（雑音の中で判定が遅れても、短い呼びかけを落とさない）
    //  voiceSec: 発話の長さから、長めに含めた手前と重ねた部分を除いたもの
    constructor(opts = {}) {
      this.o = opts;
      this.sensitivity = opts.sensitivity ?? 1;   // 大きいほど小さな声も拾う（下げると周りの声を拾いにくい）
      this.adaptive = Boolean(opts.adaptive);
      this.maxFrames = Math.round((opts.maxMs ?? MAX_MS) / FRAME_MS);
      this.earlyFrames = Math.round((opts.earlyMs ?? 1000) / FRAME_MS);
      this.earlyDone = false; this.voiced = 0;
      this.overlapFrames = Math.min(Math.round((opts.overlapMs ?? 0) / FRAME_MS), Math.floor(this.maxFrames / 2));
      this.preFrames = Math.max(PRE_ROLL, Math.round((opts.preRollMs ?? 0) / FRAME_MS));
      this.extraPre = 0;            // 今の発話の頭の、声の長さに数えないフレーム数（長めに含めた手前・重ねた部分）
      this.endSilenceMs = opts.endSilenceMs ?? END_SILENCE_MS;
      this.paused = false;
      this.speaking = false;
      this.pre = [];
      this.frames = [];
      this.silent = 0;
      this.loud = 0;
      this.noise = -60;             // 周囲の雑音レベル（dBFS）
      this.spread = START_MARGIN;   // 雑音の揺れ（dB。adaptive のとき）
      this.recent = [];             // 直近の音量（dBFS）。雑音の大きさを求める（adaptive のとき）
      this.calm = [];               // 話していない間の直近の音量（dBFS）。雑音の揺れを求める（adaptive のとき）
      this.level = -100;
    }
    async start(stream) {
      this.stream = stream || await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      this.ownStream = !stream;
      this.ctx = new AudioContext({ sampleRate: 16000 });
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, "amane-tap");
      this.node.port.onmessage = (e) => this.onFrame(e.data);
      src.connect(this.node);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512; this.analyser.smoothingTimeConstant = 0.6;
      src.connect(this.analyser);
      this.bins = new Uint8Array(this.analyser.frequencyBinCount);
      // ブラウザが許可するまで resume が終わらないことがある（iPad の Safari など）ので、待ちすぎない
      await Promise.race([this.ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
      return this;
    }
    onFrame(f) {
      let sum = 0;
      for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
      const db = 10 * Math.log10(sum / f.length + 1e-10);
      this.level = db;
      if (this.paused) { this.reset(); return; }

      const sens = this.sensitivity;
      // strict（AI が話している間）は、自分の声の回り込みを拾わないよう判定を厳しくする
      const startTh = Math.max(this.noise + this.startMargin() / sens, -50) + (this.strict ? 8 : 0);
      const keepTh = Math.max(this.noise + KEEP_MARGIN / sens, -58);
      const endFrames = Math.round(this.endSilenceMs / FRAME_MS);
      // AI の声が出ている間は、雑音の大きさを学習しない
      if (!this.strict) this.learnNoise(db);

      if (!this.speaking) {
        this.pre.push(f); if (this.pre.length > this.preFrames) this.pre.shift();
        this.loud = db > startTh ? this.loud + 1 : 0;
        if (this.loud >= START_FRAMES) {
          this.speaking = true; this.silent = 0; this.voiced = START_FRAMES;
          this.extraPre = Math.max(0, this.pre.length - PRE_ROLL);
          this.frames = this.pre.slice(); this.pre = [];
          this.o.onSpeechStart?.();
        }
      } else {
        this.frames.push(f);
        this.silent = db > keepTh ? 0 : this.silent + 1;
        // 声の鳴っている長さ（話し終わりを待つ間の無音は数えない）が earlyMs ほどになったら、話し始めの音声を渡す
        if (this.silent === 0) this.voiced++;
        if (this.o.onEarly && !this.earlyDone && this.voiced >= this.earlyFrames) {
          this.earlyDone = true;
          this.o.onEarly(encodeWav(this.frames.slice(this.extraPre)));
        }
        if (this.silent >= endFrames) this.finish();
        else if (this.frames.length >= this.maxFrames) this.cut();
      }
    }
    learnNoise(db) {
      if (!this.adaptive) {
        // 話していない間だけ学習する（話している間も学習すると、長く話し続けたときに声を雑音と覚えてしまう）
        if (!this.speaking) this.noise = db < this.noise ? this.noise * 0.9 + db * 0.1 : this.noise * 0.995 + db * 0.005;
        return;
      }
      // 雑音の大きさ: 直近 5 秒の音量の小さいほう。話している間も学習するので、ドライヤーなどが鳴り始めても
      // 「話し続けている」と判定されたままにならず、数秒で慣れて区切りが来る
      pushRecent(this.recent, db);
      this.noise = at(sortedOf(this.recent), 0.1);
      // 雑音の揺れ: 話していない間の音量の幅（話し声を含めると、話した直後に判定が厳しくなるので除く）
      if (!this.speaking) {
        pushRecent(this.calm, db);
        const calm = sortedOf(this.calm);
        this.spread = at(calm, 0.9) - at(calm, 0.1);
      }
    }
    // 話し始めと判定する、雑音との差（dB）
    startMargin() {
      // ドライヤーのように大きさがほとんど揺れない大きな音の中では、声との差が小さくても見分けられるので緩める。
      // 静かな部屋・揺れる雑音・AI の声が出ている間・学習が足りないうちは緩めない
      // （話し続けている判定は緩めない。揺れる雑音で区切りが来なくなるため）
      if (!this.adaptive || this.strict || this.noise < RELAX_ABOVE || this.calm.length < RELAX_AFTER) return START_MARGIN;
      return Math.min(START_MARGIN, RELAX_MIN + this.spread);
    }
    // 長すぎるので切る。overlapMs を指定したときは、切れ目にかかった言葉（呼びかけなど）が途切れないよう、
    // 終わりの部分を次の発話の頭に重ねてそのまま続ける（会話中は同じ言葉を 2 回送らないよう重ねない）
    // 重ねないときも、話し続けている声はそのまま次の発話として聞き続ける（もう一度「話し始め」と判定されるのを
    // 待つと、AI が話している間の厳しい判定などで、続きの言葉を落とすため）
    cut() {
      const overlap = this.overlapFrames ? this.frames.slice(-this.overlapFrames) : [];
      this.finish({ cut: true });
      // 重ねた部分は送信済みなので、声の長さに数えない（切った直後に黙ったら、重ねた部分だけを送り直さない）
      this.speaking = true; this.frames = overlap; this.extraPre = overlap.length;
    }
    // info.cut: maxMs の上限で区切った（話の途中かもしれない）。onUtterance の 4 つ目の引数で渡す
    finish(info = {}) {
      this.earlyDone = false; this.voiced = 0;
      const frames = this.frames;
      const tail = this.silent;
      const extra = this.extraPre;   // 長めに含めた手前・重ねた部分は、物音かどうかの判定（声の長さ）に数えない
      this.speaking = false; this.frames = []; this.silent = 0; this.loud = 0; this.extraPre = 0;
      if (frames.length - tail - extra < MIN_SPEECH_FRAMES) { this.o.onDiscard?.(); return; }
      // 末尾の無音は 0.2 秒ほど残して切る
      const keep = frames.slice(0, frames.length - Math.max(0, tail - 6));
      const sec = (n) => (n * FRAME_MS) / 1000;
      this.o.onUtterance?.(encodeWav(keep), sec(keep.length), sec(Math.max(0, keep.length - extra)), { cut: Boolean(info.cut) });
    }
    reset() { this.speaking = false; this.frames = []; this.pre = []; this.silent = 0; this.loud = 0; this.extraPre = 0; this.earlyDone = false; }
    pause() { this.paused = true; this.reset(); }
    resume() { this.paused = false; }
    getByteFrequencyData() { if (this.analyser) this.analyser.getByteFrequencyData(this.bins); return this.bins; }
    async stop() {
      try { this.node?.disconnect(); } catch {}
      if (this.ownStream) try { this.stream?.getTracks().forEach((t) => t.stop()); } catch {}
      try { await this.ctx?.close(); } catch {}
    }
  }

  // Whisper に送って文字にする（server.js 経由）
  // split: 声の切れ目で区切り直して、区切りごとにも文字にする（結果の segments）
  // speaker: 会話の主（session）・登録した人の声の区間だけを文字にする（結果の speaker・userAtEnd。stt/speaker.py）
  // adopt: 会話の主がまだ決まっていなければ、この発話の先頭の声を主にしてよい（AI が黙っている間に話し始めた発話）
  // cut: 上限で区切った（話の途中）。疑問文の「？」を付けない
  async function transcribe(blob, hotwords = "", mode = "talk", { split = false, speaker = false, session = "", adopt = false, cut = false } = {}) {
    const q = `mode=${mode}&hotwords=${encodeURIComponent(hotwords)}${split ? "&split=1" : ""}${speaker ? "&speaker=1" : ""}`
      + (session ? `&session=${encodeURIComponent(session)}` : "") + (adopt ? "&adopt=1" : "") + (cut ? "&cut=1" : "");
    const r = await fetch(`/api/stt?${q}`, { method: "POST", body: blob, headers: { "Content-Type": "audio/wav" } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
    return j; // { text, ms, duration }
  }
  // 声紋の会話（session）: 始める（呼びかけの声 start〜end 秒を主として覚える）・話し始めの声が主かを調べる・終える
  async function sttPost(path, body) {
    const r = await fetch(path, { method: "POST", body, headers: { "Content-Type": "audio/wav" } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
    return j;
  }
  const sid = (session) => `session=${encodeURIComponent(session)}`;
  const session = {
    start: (blob, id, start = 0, end = "") => sttPost(`/api/stt/session/start?${sid(id)}&start=${start}${end !== "" ? `&end=${end}` : ""}`, blob),
    check: (blob, id) => sttPost(`/api/stt/speaker-check?${sid(id)}`, blob),   // → { owner, score }
    end: (id) => sttPost(`/api/stt/session/end?${sid(id)}`, ""),
  };
  async function health() {
    try { return await (await fetch("/api/stt/health")).json(); } catch { return { ok: false, error: "サーバーに接続できません" }; }
  }

  return { Listener, transcribe, health, session };
})();
