// AI あまね ローカル会話（AivisSpeech モード。声は AivisSpeech か VOICEVOX）
//  耳: Web Speech API / 頭: server.js 経由で常駐 Claude Code / 口: VOICEVOX
//  ElevenLabs の Conversation と同じ形（startSession / endSession / getXxxByteFrequencyData /
//  sendUserMessage / getId）にして、app.js から差し替えて使えるようにしている。
window.LocalVoice = (() => {
  "use strict";

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  // <act> は中身を持たないので、閉じ忘れ（<act do="…">）も 1 つのタグとみなし、余った </act> は捨てる
  const TAG_RE = /<task\b[^>]*>[\s\S]*?<\/task>|<show\b[^>]*\/>|<show\b[^>]*>[\s\S]*?<\/show>|<act\b[^>]*>|<\/act\s*>|<status\s*\/?>|<end\s*\/?>|<hide\s*\/?>/g;
  const OPEN_TAG_RE = /<(task|status|end|show|hide|act)\b[\s\S]*$/;   // まだ閉じていない（続きが届いていない）タグ
  const SOURCES_RE = /(^|\n)\s*(Sources?|出典|参考)\s*[:：]/;          // Web 検索の出典リストの始まり
  // 声の気持ちの印（[うれしい] など。頭が気持ちの変わる文の頭に書く。気持ちの名前と声の調子は lib/moods.js と同じ）
  //  全角のかっこ・【】や漢字で書かれても読み取る。気持ちの名前でないかっこ（読み仮名など）は、印とみなさない
  const MOOD_WORDS = {
    ふつう: "ふつう", 普通: "ふつう", うれしい: "うれしい", 嬉しい: "うれしい", からかう: "からかう",
    やさしい: "やさしい", 優しい: "やさしい", おちつく: "おちつく", 落ち着く: "おちつく", かなしい: "かなしい", 悲しい: "かなしい",
  };
  const MOOD_SRC = `[\\[［【](${Object.keys(MOOD_WORDS).join("|")})[\\]］】]`;
  const MOOD_RE = new RegExp(MOOD_SRC);
  const MOOD_ALL = new RegExp(MOOD_SRC, "g");
  const MOOD_CUT = /[[［【][^\]］】]{0,4}$/;     // 返事の最後で切れた印
  const MAX_ACTS = 5;        // 1 つの返事で実行する追加機能のタグの数の上限
  const MAX_AUTO_SENDS = 3;  // ユーザーが話さないまま、結果を自動で頭に送る回数の上限（結果 → タグ → 結果 … のくり返しを止める）
  // 言いかけで終わっているか（「〜て」「〜けど」「えーと」など）→ 続きを少し待つ
  const INCOMPLETE = /(て|で|が|けど|けれど|から|ので|のに|し|と|って|の|に|を|は|も|や|とか|たり|ば|ながら|あと|それで|そして|でも|えーと|えっと|あの|その|ちょっと|なんか|まあ)$/;
  const STOP_WORDS = /^(ストップ|すとっぷ|止まって|とまって|待って|まって|ちょっと待って|もういい|しーっ|静かに)/;
  const FILLER_ONLY = /^(えーと|えっと|えー|あのー?|うーん|うん|まあ|なんか|その)$/;
  // 音声認識サーバーが疑問文の最後に付けた「？」を除く（言いかけ・つなぎ言葉の判定は、言葉そのもので行う）
  const bare = (s) => String(s).replace(/[？?]+$/, "");
  // 「〜は？」「〜って？」のように、上がり調子（？）で終わる短い聞き方は言い終わり（「スカイツリーは…」の言いかけとは区別する）
  const ASKED = /(は|って|の|とか|も)[？?]$/;
  // 言いかけで終わっていて、続きを少し待つか
  const waitsForMore = (s) => INCOMPLETE.test(bare(s)) && !ASKED.test(s);
  const HOLD_MS = 1100;          // 言いかけのときに続きを待つ時間
  // 返事を考えるのに時間がかかるときの、つなぎの言葉（黙ったまま待たせない）
  const FILLERS = {
    wait: ["少々お待ちください。", "ちょっと考えますね。", "えーっと、少々お待ちを。"],
    search: ["調べてみますね。", "少し調べます。"],
    long: ["もう少しお待ちください。", "もうちょっとかかりそうです。"],
  };
  const FILL_WAIT_MS = 3500;     // これだけ待っても話し始めなければ「少々お待ちください」
  const FILL_LONG_MS = 12000;    // さらに長くかかっているときに、もう一度
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const GREETING = "はい、お呼びでしょうか。";
  const VOICEPRINT_MAX_MS = 6000;   // 声紋を使うとき、1 回に聞き取る長さの上限（周りの音で区切りが来なくても待たせない）
  const CONTINUE_MS = 7000;      // 送ってからこの時間内に話し始めたら「続き」とみなす（まだ返事を話し始めていない場合）
  // 文字の2文字組の重なり（自分の声のエコーを聞き取ってしまったかの判定用）
  const bigrams = (s) => { const t = String(s).replace(/[\s、。,.!?！？]/g, ""); const a = []; for (let i = 0; i < t.length - 1; i++) a.push(t.slice(i, i + 2)); return a; };
  const overlap = (text, ref) => { const a = bigrams(text); if (!a.length) return 1; const r = new Set(bigrams(ref)); return a.filter((x) => r.has(x)).length / a.length; };
  const attrs = (s) => { const o = {}; String(s || "").replace(/(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_, k, v1, v2) => { o[k] = v1 ?? v2; }); return o; };
  // 出典リスト（読み上げない部分）の前までを返す。found: 出典が始まった（このあとに届く文も読み上げない）
  //  閉じたタグの中（<show> の本文の「出典:」など）は出典とみなさない。まだ閉じていないタグの中で見つかったら、閉じるまで待つ
  //  出典の中のタグの形の文字（Web ページの題名など）は実行しない（タグは、ここで残った部分からだけ探す）
  function cutSources(buf, { noMore = false, final = false } = {}) {
    if (noMore) return { text: "", found: false };
    const masked = String(buf).replace(TAG_RE, (m) => " ".repeat(m.length));
    let src = masked.search(SOURCES_RE);
    const open = masked.search(OPEN_TAG_RE);
    if (src >= 0 && open >= 0 && src > open && !final) src = -1;
    return src >= 0 ? { text: buf.slice(0, src), found: true } : { text: buf, found: false };
  }
  // 読み上げ用に記号や URL を落とす
  const clean = (s) => s
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*#`>|_~\[\]{}]/g, "")
    .replace(/^\s*[-・●]\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  // 会話ログに出す返事（タグ・声の気持ちの印・出典リストを除く）
  const spokenText = (full) => clean(String(full).replace(TAG_RE, "").replace(MOOD_ALL, "").replace(MOOD_CUT, "").split(/\n\s*(?:Sources?|出典)\s*[:：]/)[0]).trim();

  // 声を gain 倍に大きくして dest へつなぐ（iPad などは、マイクを使っている間スピーカーの音が小さくなるため）。
  // 大きくしても割れないよう、0 dBFS を超えた分だけを押さえるリミッターを通す（1 倍のときは元の音のまま）
  function louder(ctx, gain, dest) {
    const boost = ctx.createGain();
    boost.gain.value = gain;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = 0; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.002; limiter.release.value = 0.15;
    boost.connect(limiter).connect(dest);
    return boost;
  }

  class Session {
    constructor(o) {
      this.o = o;
      this.active = false;
      this.mode = "listening";
      this.queue = [];          // Promise<AudioBuffer|null> の列（先読みしつつ順番に再生）
      this.playing = false;
      this.inflight = null;     // 頭が返答中の発言 { discard, muted, played, noMore }
      this.outbox = [];         // 頭が返答中に来た発言（返答が終わったらまとめて送る）
      this.buf = "";            // 読み上げ待ちのテキスト
      this.full = "";           // ログ用の返答全文
      this.pendingEnd = false;
      this.recogOn = false;
      this.pendingText = "";    // 言いかけで保留中の発言
      this.holdTimer = null;
      this.lastSent = { text: "", at: 0 };
      this.recentSpoken = [];   // 直近に読み上げた文（エコー判定用）
      this.ducked = false;
      this.playGen = 0;         // 割り込まれた回数（合成を待っている間に割り込まれた文を、あとから話さないように）
      this.mood = "ふつう";     // いま話している返事の気持ち（印が来るまで続く。返事ごとに戻す）
    }

    async start() {
      await this.checkEngines();
      await this.openAudio();
      await this.openBrain();
      if (this.whisper) await this.startWhisper(); else this.startBrowserRecognition();
      this.active = true;
      this.o.onConnect?.({ conversationId: null });
      if (this.o.initialText) this.userSaid(this.o.initialText, "", { from: "wake" });
      else this.say(this.o.greeting || GREETING);
    }

    // 声の合成と、聞き取り（ローカル音声認識 / ブラウザ）が使えるか
    async checkEngines() {
      const h = await fetch("/api/tts/health").then((r) => r.json()).catch(() => ({ ok: false, error: "サーバーに接続できません" }));
      if (!h.ok) throw new Error("声の合成（VOICEVOX / AivisSpeech）に接続できません。起動してから、もう一度呼んでください。（" + (h.error || "") + "）");
      this.whisper = this.o.stt === "whisper";
      if (this.whisper) {
        const s = await MicVAD.health();
        if (!s.ok) throw new Error("ローカル音声認識に接続できません（start.bat の黒いウィンドウで [stt] の表示を確認してください）。（" + (s.error || "") + "）");
      } else if (!SR) throw new Error("このブラウザは音声認識に対応していません（Chrome か Edge を使ってください）");
    }

    // マイクと、音を鳴らす準備。マイクを先に使い始めてから、音を鳴らす準備をする（iPad の Safari の自動再生の制限への対策。
    // 呼びかけで会話を始めるときは画面のタップがないため）
    async openAudio() {
      try {
        this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch (e) { throw new Error("マイクを使えません: " + e.message); }
      // 出力（スピーカー）と入力（マイク）のアナライザー
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      // 音を鳴らす許可がまだ無いと resume が終わらないことがあるので、待ちすぎない
      await Promise.race([this.ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
      // 止まったままなら、画面をタップしたときに app.js の unlockAudio が動かす
      if (this.ctx.state !== "running") this.o.onError?.("音を鳴らせません。画面を一度タップしてください。");
      this.outAnalyser = this.ctx.createAnalyser();
      this.outAnalyser.fftSize = 512; this.outAnalyser.smoothingTimeConstant = 0.55;
      this.outAnalyser.connect(this.ctx.destination);
      this.boost = louder(this.ctx, this.o.volume ?? 1, this.outAnalyser);   // 声の大きさ（設定）
      this.outGain = this.ctx.createGain();       // 割り込まれたときに音量を下げるため
      this.outGain.connect(this.boost);
      this.outBins = new Uint8Array(this.outAnalyser.frequencyBinCount);
      this.inAnalyser = this.ctx.createAnalyser();
      this.inAnalyser.fftSize = 512; this.inAnalyser.smoothingTimeConstant = 0.6;
      this.ctx.createMediaStreamSource(this.mic).connect(this.inAnalyser);
      this.inBins = new Uint8Array(this.inAnalyser.frequencyBinCount);
    }

    // 頭（Claude Code）からのストリーム
    async openBrain() {
      this.es = new EventSource("/api/brain/events");
      this.es.onmessage = (e) => { try { this.onBrain(JSON.parse(e.data)); } catch (err) { console.error(err); } };
      await new Promise((res) => { this.es.onopen = res; setTimeout(res, 1500); });
      fetch("/api/brain/warmup", { method: "POST" }).catch(() => {});
    }

    // 会話中の聞き取り（ローカル音声認識）
    // voiceprint: 会話の主（o.session。呼びかけた人）の声だけを聞く。テレビや家族の声、自分の声の回り込みは、
    //  音声認識サーバーが聞き流す（stt/speaker.py）。テレビなどが鳴り続けて話の区切りが来なくても待たされないよう、
    //  VOICEPRINT_MAX_MS ごとに区切って調べる
    async startWhisper() {
      this.session = this.o.ownerOnly ? await this.startOwner(this.o.wakeVoice) : "";
      this.voiceprint = Boolean(this.session);
      this.vad = await new MicVAD.Listener({
        sensitivity: this.o.sensitivity,
        maxMs: this.voiceprint ? VOICEPRINT_MAX_MS : undefined,
        onSpeechStart: () => {
          this.o.onInterim?.("…");
          clearTimeout(this.holdTimer);                   // 言いかけの続きが来た
          // この発話の印。AI が話している間に話し始めた発話（テレビ・自分の声の回り込みかもしれない）からは、主を決めない
          this.utt = { seq: (this.utt?.seq || 0) + 1, open: true, duringSpeech: this.mode === "speaking" };
          // 話している最中なら、まず音量を下げて様子を見る（声紋のときは、話し始めの声が主と分かってから。onEarly）
          if (this.mode === "speaking" && !this.voiceprint) this.duck(true);
        },
        onEarly: (wav) => {
          if (!this.voiceprint || this.mode !== "speaking") return;
          const utt = this.utt;
          MicVAD.session.check(wav, this.session)
            // 返事が遅れて届いたとき、その発話がもう終わっていたら下げない
            .then((r) => { if (r.owner && this.active && this.mode === "speaking" && this.utt === utt && utt?.open) this.duck(true); })
            .catch(() => {});
        },
        onDiscard: () => { if (this.utt) this.utt.open = false; this.o.onInterim?.(""); this.duck(false); this.rearmHold(); },
        onUtterance: (wav, sec, voiceSec, info) => this.onUtterance(wav, sec, info),
      }).start(this.mic);
    }

    // 話し終わった（または上限で区切った）発話を文字にする。info.cut: 上限（VOICEPRINT_MAX_MS）で区切った（話の途中かもしれない）
    async onUtterance(wav, sec, info = {}) {
      const heardAt = performance.now();
      const utt = this.utt;
      if (utt && !info.cut) utt.open = false;
      const wasSpeaking = this.mode === "speaking" || this.ducked;
      this.o.onInterim?.(`認識中…（${sec.toFixed(1)}秒）`);
      try {
        await this.ownerReady;   // 会話の主を覚え終わってから調べる
        const r = await MicVAD.transcribe(wav, this.o.hotwords || "", "talk", {
          speaker: this.voiceprint, session: this.session, adopt: this.voiceprint && !utt?.duringSpeech, cut: Boolean(info.cut),
        });
        this.o.onInterim?.("");
        if (!this.active) return;
        // 主の声がなかった（周りの声だけ）→ 聞き流す
        if (this.voiceprint && !r.text && r.speaker?.length && !r.speaker.some((c) => c.keep)) {
          this.o.onIgnored?.(r.speaker); this.duck(false); return this.rearmHold();
        }
        // 応答の速さの計測（話し終わり → 返事の声が出るまで）。hang: 黙ってから話し終わりと判定するまで（上限で区切ったときは 0）
        const clock = { from: "talk", heardAt, hang: info.cut ? 0 : this.vad.endSilenceMs, stt: performance.now() - heardAt, sttServer: r.ms };
        this.heard(r.text || "", wasSpeaking, { userAtEnd: Boolean(info.cut && r.userAtEnd), clock });
      } catch (e) { this.duck(false); this.rearmHold(); this.o.onError?.("音声認識に失敗: " + e.message); }
    }

    // 会話中の聞き取り（ブラウザの音声認識）
    startBrowserRecognition() {
      this.recog = new SR();
      this.recog.lang = "ja-JP";
      this.recog.continuous = true;
      this.recog.interimResults = true;
      this.recog.onresult = (ev) => {
        if (!this.active || this.mode !== "listening") return;
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          const t = r[0].transcript.trim();
          if (r.isFinal) { if (t) this.userSaid(t); }
          else this.o.onInterim?.(t);
        }
      };
      this.recog.onstart = () => { this.recogOn = true; };
      this.recog.onend = () => {
        this.recogOn = false;
        if (this.active && this.mode === "listening") setTimeout(() => this.listen(), 200);
      };
      this.recog.onerror = (e) => {
        if (e.error === "not-allowed" || e.error === "service-not-allowed") this.o.onError?.("マイクが許可されていません");
      };
    }

    // 会話の主（呼びかけた人）の声を、音声認識サーバーに覚えさせる。wakeVoice: { wav, start, end }（呼びかけの音声と、
    // その中の呼びかけの区間（秒））。無ければ、会話で最初に話した人を主にする。会話の印（session）を返す
    async startOwner(wakeVoice) {
      const session = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      const started = MicVAD.session.start(wakeVoice?.wav || "", session, wakeVoice?.start ?? 0, wakeVoice?.end ?? "")
        .then((r) => this.o.onOwner?.(r))
        .catch((e) => this.o.onError?.("呼びかけた人の声を覚えられません（声紋なしで聞きます）: " + e.message));
      const wait = (ms) => Promise.race([started, new Promise((r) => setTimeout(r, ms))]);
      // 最初の聞き取りは、覚え終わってから（声紋のモデルの準備などで遅れても、5 秒までで先に進む）
      this.ownerReady = wait(5000);
      await wait(1500);   // 会話を始めるのは待ちすぎない（覚えるのはふだん 0.1 秒ほど）
      return session;
    }

    // ---- 聞き取り ----
    listen() {
      if (!this.active || this.mode !== "listening") return;
      if (this.vad) { this.vad.strict = false; return this.vad.resume(); }
      if (this.recogOn) return;
      try { this.recog.start(); } catch {}
    }
    pauseListen() {
      // ローカル音声認識では話している間も聞き続ける（割り込みのため）。自分の声を拾いにくいよう判定を厳しくする
      if (this.vad) { this.vad.strict = this.mode === "speaking"; return; }
      if (this.recogOn) { try { this.recog.abort(); } catch {} }
    }
    setSensitivity(v) { if (this.vad) this.vad.sensitivity = v; }
    setVolume(v) { if (this.boost) this.boost.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }
    // 声の種類・速さ・声に気持ちを込めるか（設定）。会話中に変えても、次に合成する文から変わる（合成し終えた文は前の声のまま）
    setVoice({ speaker, speed, moods } = {}) {
      this.o = { ...this.o, ...(speaker != null && { speaker }), ...(speed != null && { speed }), ...(moods != null && { moods }) };
    }
    setMode(m) {
      if (this.mode === m) { if (m === "listening") this.listen(); return; }
      this.mode = m;
      this.o.onModeChange?.({ mode: m });
      if (m === "listening") this.listen(); else this.pauseListen();
    }
    // clock: 応答の速さの計測（聞き取ったときの時刻など。onUtterance）
    userSaid(text, note = "", clock = { from: "talk" }) {
      if (!this.active) return;
      this.autoSends = 0;
      // 画面が受け取る言葉（確認が出ている間の「お願い」「やめて」など）は、頭に送らない（だまされた頭が代わりに答えられないように）
      if (this.o.onUserText?.(text)) { this.o.onMessage?.({ message: text, role: "user", source: "user" }); return; }
      this.o.onMessage?.({ message: text, role: "user", source: "user" });
      this.lastSent = { text, at: Date.now() };
      this.sendToBrain(note ? `${note}${text}` : text, clock);
    }

    // ---- 聞き取った発言の扱い（言いかけ・続き・割り込み） ----
    // userAtEnd: 登録した声が聞き取りの最後まで続いていた（話の途中で区切られた）→ 続きを待つ
    heard(text, wasSpeaking, { userAtEnd = false, clock } = {}) {
      text = text.trim();
      // 1) AI が話している最中に聞こえた → 割り込みか、自分の声のエコーか
      if (wasSpeaking) {
        const ref = this.recentSpoken.join("");
        if (!text || overlap(text, ref) > 0.6) { this.duck(false); return; } // エコーなので無視
        this.interrupt();
        if (STOP_WORDS.test(text)) { this.o.onMessage?.({ message: text, role: "user", source: "user" }); return this.afterPlay(); }
        return this.userSaid(text, "（あなたの話をさえぎって）", clock);
      }
      if (!text) return this.rearmHold();
      if (FILLER_ONLY.test(bare(text))) return this.rearmHold();   // 「えーと」「うーん」だけなら何もしない
      // 「ストップ」「待って」は、返事の準備中でも止める
      if (STOP_WORDS.test(text)) {
        this.interrupt(); this.pendingText = ""; clearTimeout(this.holdTimer);
        this.o.onMessage?.({ message: text, role: "user", source: "user" });
        return this.afterPlay();
      }
      // 2) 送った直後、まだ返事を話し始める前に話し始めた → 前の発言の続きとして言い直す
      const fl = this.inflight;
      if (fl && !fl.discard && !fl.played && Date.now() - this.lastSent.at < CONTINUE_MS) {
        fl.discard = true;                                   // 考え中の返答は捨てて
        // 頭にも中断を伝える（印を付けて、ほかの画面への返答を止めないように）
        fetch("/api/brain/interrupt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turn: fl.turn }) }).catch(() => {});
        this.buf = ""; this.full = "";
        const merged = this.lastSent.text + text;
        this.o.onMessage?.({ message: "（続き）" + text, role: "user", source: "user" });
        this.lastSent = { text: merged, at: Date.now() };
        return this.sendToBrain(`${merged}\n（※直前の発言は途中で区切れていました。これが言い終わった全文です。直前の発言ではなく、この全文に答えてください）`, clock);
      }
      // 3) 普通の発言。言いかけで終わっていたら続きを少し待つ
      this.pendingText += text;
      this.pendingClock = clock;   // 言いかけを待つ時間も、返事までの時間に含めて測る（最後に聞き取った部分から）
      clearTimeout(this.holdTimer);
      if (waitsForMore(this.pendingText) || userAtEnd) {
        this.o.onInterim?.(`（続きを待っています）${this.pendingText}`);
        // 上限で区切った続きは、次の聞き取りが終わるまで待つ（届けば heard / rearmHold が待ち時間を決め直す）
        this.holdTimer = setTimeout(() => this.flushPending(), userAtEnd ? VOICEPRINT_MAX_MS + 2000 : HOLD_MS);
      } else this.flushPending();
    }
    rearmHold() {
      if (this.pendingText) { clearTimeout(this.holdTimer); this.holdTimer = setTimeout(() => this.flushPending(), HOLD_MS); }
    }
    flushPending() {
      clearTimeout(this.holdTimer);
      const t = this.pendingText; this.pendingText = "";
      const clock = this.pendingClock; this.pendingClock = null;
      this.o.onInterim?.("");
      if (t && !FILLER_ONLY.test(bare(t))) this.userSaid(t, "", clock);   // 「えーと」だけなら送らない
    }
    duck(on) {
      this.ducked = on;
      if (!this.outGain) return;
      const now = this.ctx.currentTime;
      this.outGain.gain.cancelScheduledValues(now);
      this.outGain.gain.setTargetAtTime(on ? 0.25 : 1, now, 0.05);
      clearTimeout(this.duckTimer);
      if (on) this.duckTimer = setTimeout(() => this.duck(false), 4000); // 念のため戻す
    }

    // ---- 頭 ----
    sendUserMessage(text) { this.sendToBrain(text); } // 作業完了の通知など
    // タグの結果を、自動で頭に送る（ユーザーが話すまでに MAX_AUTO_SENDS 回まで。userSaid で数え直す）
    autoSend(text) {
      this.autoSends = (this.autoSends || 0) + 1;
      if (this.autoSends > MAX_AUTO_SENDS) return this.o.onError?.("結果を頭に送る回数が多すぎるので止めました（話しかけると、また送ります）");
      this.sendToBrain(text);
    }
    get busy() { return Boolean(this.inflight) || this.outbox.length > 0; }
    sendToBrain(text, clock = null) {
      if (!this.active) return;
      // 頭が返答中なら、終わるまで待ってからまとめて送る（1発言=1返答を保つ。待たせた発言の速さは測らない）
      if (this.inflight) { this.outbox.push(text); return; }
      this.dispatch(text, clock);
    }
    async dispatch(text, clock = null) {
      // turn: この発言の印。頭の返事は全部の画面（PC と iPad など）に届くので、自分の発言への返事だけを読み上げる
      const turn = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      this.inflight = { turn, discard: false, muted: false, played: false, noMore: false, fills: [], clock: clock && { ...clock, sentAt: performance.now() } };
      this.clearFill();
      this.fillTimers = [setTimeout(() => this.fill("wait"), FILL_WAIT_MS), setTimeout(() => this.fill("long"), FILL_LONG_MS)];
      this.buf = ""; this.full = ""; this.mood = "ふつう";
      if (!this.playing) this.setMode("thinking");
      const now = new Date().toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });
      try {
        const r = await fetch("/api/brain/say", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: `${text}\n（現在: ${now}）`, turn }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "HTTP " + r.status);
      } catch (e) {
        this.inflight = null;
        this.o.onError?.("頭（Claude Code）に送れません: " + e.message);
        this.afterPlay();
      }
    }
    onBrain(ev) {
      if (!this.active) return;
      const turn = this.inflight;
      // ほかの画面の発言への返事は読み上げない（頭が止まった知らせ（exit）だけは全部の画面で受ける）
      if (ev.type !== "exit" && (!turn || ev.turn !== turn.turn)) return;
      if (ev.type === "delta") {
        if (turn?.discard) return;                 // 言い直し・割り込みで不要になった返答は読み上げない
        if (ev.first && turn.clock) turn.clock = { ...turn.clock, firstDeltaAt: performance.now(), brainServer: ev.ms, cold: ev.cold };
        this.buf += ev.text; this.full += ev.text; this.drain(false);
      }
      else if (ev.type === "tool") { this.o.onTool?.(ev.name); if (ev.name === "web_search") this.fill("search"); }
      else if (ev.type === "done") {
        if (turn && !turn.discard) {
          this.drain(true);                          // 最後の文を読み上げに回す
          const msg = spokenText(this.full);
          if (msg) this.o.onMessage?.({ message: msg, role: "agent", source: "ai" });
          if (ev.error && !ev.interrupted) this.o.onError?.("頭の応答でエラー: " + ev.text);
        }
        this.full = ""; this.buf = "";
        this.clearFill();
        this.inflight = null;
        this.o.onCost?.(ev.cost || 0, ev.ms);
        if (this.outbox.length) this.dispatch(this.outbox.splice(0).join("\n"));   // 待っていた発言をまとめて送る
        else if (!this.playing && !this.queue.length) this.afterPlay();
      } else if (ev.type === "exit") {
        this.inflight = null; this.outbox = [];
        this.clearFill();
        this.o.onError?.("頭（Claude Code）が終了しました: " + (ev.message || ""));
        this.afterPlay();
      }
    }
    // 届いたテキストを、タグの処理と文単位の読み上げに振り分ける
    drain(final) {
      // Web 検索の出典リストは読み上げない（出典の中のタグの形の文字も実行しない。cutSources）
      const cut = cutSources(this.buf, { noMore: Boolean(this.inflight?.noMore), final });
      if (cut.found && this.inflight) this.inflight.noMore = true;
      let b = cut.text.replace(TAG_RE, (m) => { this.handleTag(m); return ""; });
      let hold = "";
      const open = b.search(OPEN_TAG_RE);
      if (open >= 0 && !final) { hold = b.slice(open); b = b.slice(0, open); }
      else {
        const lt = b.lastIndexOf("<");
        if (!final && lt >= 0 && b.indexOf(">", lt) < 0 && b.length - lt < 12) { hold = b.slice(lt); b = b.slice(0, lt); }
      }
      const re = /[^。！？!?\n]*[。！？!?\n]+/g;
      let m, last = 0;
      while ((m = re.exec(b))) { this.enqueue(m[0]); last = re.lastIndex; }
      let rest = b.slice(last);
      // 句点が来ないまま長くなったら読点で区切る（短く区切るほど合成が速く、文の間が空きにくい）
      if (!final && rest.length > 22) { const c = rest.lastIndexOf("、"); if (c > 8) { this.enqueue(rest.slice(0, c + 1)); rest = rest.slice(c + 1); } }
      if (final) { this.enqueue(rest + hold.replace(/<[^>]*$/, "")); rest = ""; hold = ""; }
      this.buf = rest + hold;
    }
    handleTag(m) {
      const tools = this.o.clientTools || {};
      const open = (m.match(/^<\w+\b([^>]*?)\/?>/) || [])[1] || "";
      const body = m.replace(/^<\w+\b[^>]*>/, "").replace(/<\/\w+>$/, "");
      const at = attrs(open);
      if (m.startsWith("<show")) {
        // 声の気持ちの印は、資料の本文にも出さない
        return this.o.onShow?.({ title: at.title, src: at.src, place: at.place, text: m.endsWith("/>") ? "" : body.replace(MOOD_ALL, "").trim() });
      }
      if (m.startsWith("<hide")) return this.o.onHide?.();
      // 追加機能（plugins.js）。結果を伝えてほしいとき（確認の動作・失敗）は、返ってきた文を頭に送る
      if (m.startsWith("<act")) {
        const fl = this.inflight;
        if (fl && (fl.acts = (fl.acts || 0) + 1) > MAX_ACTS) return this.o.onError?.(`追加機能のタグが多すぎるので、${MAX_ACTS + 1} 個目からは実行しませんでした`);
        Promise.resolve(this.o.onAct?.(at)).then((r) => { if (r) this.autoSend(r); }).catch(() => {});
        return;
      }
      if (m.startsWith("<task")) {
        Promise.resolve(tools.run_task?.({ task: String(body || "").trim(), level: at.level, engine: at.engine }))
          .then((r) => { if (r && !String(r).startsWith("作業ID")) this.autoSend("［システム］" + r); });
      } else if (m.startsWith("<status")) {
        Promise.resolve(tools.get_task_status?.())
          .then((r) => this.autoSend("［作業状況］" + (r || "情報なし") + "\nこれをユーザーに簡潔に伝えてください。"));
      } else if (m.startsWith("<end")) {
        this.pendingEnd = true;
      }
    }

    // 返事を待たせているとき、つなぎの言葉を話す（その返事でまだ何も話していないときだけ。種類ごとに 1 回）
    fill(kind) {
      const fl = this.inflight;
      if (!this.active || !fl || fl.discard || fl.muted || fl.played || this.playing || this.queue.length || this.ducked) return;
      if (fl.fills.includes(kind) || (kind === "wait" && fl.fills.length)) return;   // 「調べてみますね」のあとに「少々お待ちを」は重ねない
      fl.fills = [...fl.fills, kind];
      if (fl.clock && fl.clock.fillerAt == null) fl.clock = { ...fl.clock, fillerAt: performance.now() - fl.clock.sentAt };
      const t = pick(FILLERS[kind]);
      this.recentSpoken.push(t); if (this.recentSpoken.length > 4) this.recentSpoken.shift();   // 自分の声の回り込みと分かるように
      this.queue.push(Object.assign(this.synth(t), { text: t }));
      this.playNext();
    }
    clearFill() { for (const t of this.fillTimers || []) clearTimeout(t); this.fillTimers = []; }

    // ---- 口（VOICEVOX） ----
    say(text) {
      this.o.onMessage?.({ message: text, role: "agent", source: "ai" });
      this.enqueue(text);
    }
    // 声の気持ちの印で区切り、印のあとの文はその気持ちで話す（返事の最後で切れた印は読まない）
    enqueue(text) {
      String(text).replace(MOOD_CUT, "").split(MOOD_RE).forEach((part, i) => {
        if (i % 2) this.mood = MOOD_WORDS[part]; else this.enqueuePart(part);
      });
    }
    enqueuePart(text) {
      const t = clean(text);
      if (!/[ぁ-んァ-ヶ一-龯a-zA-Z0-9]/.test(t)) return;
      if (this.inflight?.muted) return;
      this.recentSpoken.push(t); if (this.recentSpoken.length > 4) this.recentSpoken.shift();
      const fl = this.inflight;
      // 返事の最初の文は、合成にかかった時間と、話し始めた時刻を測る（probe）
      const probe = fl?.clock && !fl.played ? { ...fl.clock, firstSentenceAt: performance.now(), chars: t.length } : null;
      if (fl) fl.played = true;
      const job = this.synth(t, this.mood);
      // text: 話し始めたときに知らせる文（縦型の収録モードの字幕。onSpeak）
      this.queue.push(Object.assign(probe ? job.then((buf) => { probe.synthDoneAt = performance.now(); return buf; }) : job, { probe, text: t }));
      this.playNext();
    }
    // mood: 文の気持ち（設定の「声に気持ちを込める」がオフなら送らない）
    async synth(text, mood) {
      try {
        const r = await fetch("/api/tts", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, speaker: this.o.speaker ?? 2, speed: this.o.speed ?? 1.15, ...(mood && this.o.moods !== false && { mood }) }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "HTTP " + r.status);
        return await this.ctx.decodeAudioData(await r.arrayBuffer());
      } catch (e) {
        this.o.onError?.("音声合成に失敗: " + e.message);
        return null;
      }
    }
    async playNext() {
      if (this.playing || !this.queue.length || !this.active) return;
      this.playing = true;
      this.setMode("speaking");
      const gen = this.playGen;
      const job = this.queue.shift();
      const buf = await job;
      if (!this.active || gen !== this.playGen) return;   // 待っている間に割り込まれた
      if (!buf) { this.playing = false; return this.afterPlay(); }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.outGain);
      this.current = src;
      src.onended = () => { this.current = null; this.playing = false; this.afterPlay(); };
      src.start();
      if (job.text) this.o.onSpeak?.(job.text);
      if (job.probe) this.reportTiming(job.probe, performance.now());
    }
    // 応答の速さ（話し終わり → 返事の声が出るまで）を、段階ごとに ms で知らせる
    reportTiming(c, playAt) {
      const heard = c.heardAt != null;
      this.o.onTiming?.({
        from: c.from, cold: Boolean(c.cold), chars: c.chars, fillerAt: c.fillerAt,
        hang: c.hang, stt: c.stt, sttServer: c.sttServer,
        hold: heard ? c.sentAt - (c.heardAt + c.stt) : undefined,   // 言いかけの続きを待った時間
        brainFirst: c.firstDeltaAt - c.sentAt, brainServer: c.brainServer,
        firstSentence: c.firstSentenceAt - c.sentAt,
        synth: c.synthDoneAt - c.firstSentenceAt,
        wait: playAt - c.synthDoneAt,                                 // 前の声（つなぎの言葉など）が終わるのを待った時間
        total: playAt - (heard ? c.heardAt - c.hang : c.sentAt),
      });
    }
    afterPlay() {
      if (!this.active) return;
      if (this.queue.length) return this.playNext();
      if (this.busy) return this.setMode("thinking");
      if (this.pendingEnd) return this.endSession();
      this.setMode("listening");
    }
    // 話している途中で止める（もう一度呼びかけたいときなど）
    interrupt() {
      // 話しかけられたら読み上げは止めるが、表示や作業のタグはそのまま実行する
      if (this.inflight) this.inflight.muted = true;
      this.playGen++;
      this.queue = [];
      const cur = this.current; this.current = null;
      if (cur) { cur.onended = null; try { cur.stop(); } catch {} }
      this.playing = false;
      this.duck(false);
    }

    // ---- ElevenLabs 互換の API ----
    getId() { return null; }
    getInputByteFrequencyData() { if (this.inAnalyser) this.inAnalyser.getByteFrequencyData(this.inBins); return this.inBins; }
    getOutputByteFrequencyData() { this.outAnalyser.getByteFrequencyData(this.outBins); return this.outBins; }
    async endSession() {
      if (!this.active) return;
      this.active = false;
      clearTimeout(this.holdTimer); clearTimeout(this.duckTimer); this.clearFill();
      if (this.recog) this.pauseListen();
      this.queue = [];
      try { this.current?.stop(); } catch {}
      try { this.es?.close(); } catch {}
      if (this.session) MicVAD.session.end(this.session).catch(() => {});
      try { await this.vad?.stop(); } catch {}
      try { this.mic?.getTracks().forEach((t) => t.stop()); } catch {}
      try { await this.ctx?.close(); } catch {}
      this.o.onDisconnect?.({ reason: "user" });
    }
  }

  return {
    async startSession(opts) { const s = new Session(opts); await s.start(); return s; },
    // 決まった言葉（あいさつ・つなぎの言葉）。先に合成して覚えておいてもらう（/api/tts/warmup。すぐ話し始められるように）
    phrases: [GREETING, ...Object.values(FILLERS).flat()],
    // 話者一覧と試し読み（設定画面用）
    async speakers() { const r = await fetch("/api/tts/speakers"); if (!r.ok) throw new Error("声の合成に接続できません"); return r.json(); },
    // 試聴（volume: 声の大きさ。会話中と同じ大きさで聞けるように）
    async preview(text, speaker, speed, volume = 1) {
      // 音の準備はボタンを押した直後にする（iPad の Safari は、通信を待ったあとだと音を鳴らさせてくれないことがある）
      const ctx = new AudioContext();
      ctx.resume().catch(() => {});
      try {
        const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, speaker, speed }) });
        if (!r.ok) throw new Error("声の合成に接続できません");
        const src = ctx.createBufferSource();
        src.buffer = await ctx.decodeAudioData(await r.arrayBuffer());
        src.connect(louder(ctx, volume, ctx.destination)); src.start();
        src.onended = () => ctx.close();
      } catch (e) { ctx.close(); throw e; }
    },
    louder, waitsForMore, cutSources, attrs, spokenText, TAG_RE, MOOD_WORDS, Session,   // テスト用
    // 応答の速さ（onTiming）を、会話ログに出す 1 行にする
    timingText(t) {
      const s = (ms) => (Number.isFinite(ms) ? (ms / 1000).toFixed(1) : "-");
      const parts = [
        t.hang != null && `区切り ${s(t.hang)}`, t.stt != null && `認識 ${s(t.stt)}`, t.hold > 50 && `続き待ち ${s(t.hold)}`,
        `頭 ${s(t.brainFirst)}${t.cold ? "（起動）" : ""}`, `最初の文 ${s(t.firstSentence - t.brainFirst)}`, `声 ${s(t.synth)}`,
        t.wait > 50 && `前の声の終わり待ち ${s(t.wait)}`,
      ].filter(Boolean);
      return `返事まで ${s(t.total)} 秒（${parts.join(" / ")}）`;
    },
  };
})();
