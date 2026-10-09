// AI あまね フロントエンド
//  耳: Web Speech API（Chrome / Edge）で呼びかけを待ち受け
//  雑談: ElevenLabs Conversational AI（@elevenlabs/client）
//  作業: ElevenLabs の client tool「run_task」→ server.js → Codex / Claude Code CLI
(() => {
  "use strict";

  // 「天音」は辞書の読みが「テンオン」なので、漢字でも並べておく（判定は読み仮名で比べる。server.js の /api/wake）
  const DEFAULT_WAKE = ["あまね", "天音"];
  const END_PHRASES = /(会話を?終了|会話終わり|おしまい|おやすみ|もういいよ|ありがとう.{0,6}(終わり|おわり|以上))/;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const ui = {
    canvas: $("orb"), status: $("status"), heard: $("heard"), log: $("log"), sys: $("sysMsg"),
    hudClock: $("hudClock"), hudMode: $("hudMode"), hudTimer: $("hudTimer"),
    btnStandby: $("btnStandby"), btnTalk: $("btnTalk"), btnEnd: $("btnEnd"),
    tasks: $("tasks"), engineInfo: $("engineInfo"),
    btnUsage: $("btnUsage"), usageBar: $("usageBar"), usageText: $("usageText"), usageLast: $("usageLast"),
    agentId: $("agentId"), btnSaveAgent: $("btnSaveAgent"), agentRow: $("agentRow"),
    wakeWords: $("wakeWords"), btnSaveWake: $("btnSaveWake"), btnAddHeard: $("btnAddHeard"),
    sttEngine: $("sttEngine"), sttHints: $("sttHints"), btnSaveHints: $("btnSaveHints"), micSens: $("micSens"), micSensVal: $("micSensVal"),
    micSensRow: $("micSensRow"), ownerOnlyRow: $("ownerOnlyRow"), showTimingRow: $("showTimingRow"),
    visual: $("visual"), panelScale: $("panelScale"), panelScaleVal: $("panelScaleVal"),
    voiceEngine: $("voiceEngine"), vvRow: $("vvRow"), vvSpeaker: $("vvSpeaker"), vvSpeed: $("vvSpeed"), vvSpeedVal: $("vvSpeedVal"), btnVvTest: $("btnVvTest"),
    vvVolume: $("vvVolume"), vvVolumeVal: $("vvVolumeVal"), vvMood: $("vvMood"), vvMoodRow: $("vvMoodRow"),
    idleEnd: $("idleEnd"), idleSec: $("idleSec"), autoReport: $("autoReport"), autoStandby: $("autoStandby"), note: $("settingsNote"),
    ownerOnly: $("ownerOnly"), showTiming: $("showTiming"), taskConfirm: $("taskConfirm"),
  };

  const store = {
    get(k, d) { try { const v = localStorage.getItem("amane." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("amane." + k, JSON.stringify(v)); } catch {} },
  };

  // ---------- 見た目（粒子の群れ / 流体オーブ） ----------
  const Orb = store.get("visual", "swarm") === "orb" ? window.AmaneOrb : window.AmaneSwarm;

  let AI_NAME = "あまね";   // .env の AI_NAME（/api/config）で上書き

  // ---------- state ----------
  let serverCfg = { agentId: "", signedUrlAvailable: false, usageAvailable: false };
  let standbyOn = false;
  let conversation = null;
  let conversationId = null;
  let connecting = false;
  let recog = null, recogRunning = false, recogStopWaiters = [];
  let lastHeard = "";
  let mode = "listening";
  let pendingEnd = false;
  let idleTimer = null;
  let callStartedAt = 0;
  let localCost = 0, localTurns = 0;
  let orbOk = false;
  let micStream = null, micCtx = null, micAnalyser = null, micBins = null;
  const taskState = new Map();      // id -> status（変化の検出用）
  const REPORT_GREETINGS = ["お待たせしました。", "すみません、ご報告があります。"];   // 作業が終わって自分から報告するときの始め（成功・失敗）
  const myTasks = new Set();        // この画面で頼んだ作業の id（完了の報告は、頼んだ画面だけでする）
  const reportQueue = [];           // 会話で伝える作業完了の通知

  // ---------- helpers ----------
  const HAS_KANJI = /[\u4e00-\u9fff]/;
  const wakeList = () => (ui.wakeWords.value || "").split(/[,、，]/).map((w) => w.trim()).filter(Boolean);
  // 呼びかけの判定（server.js の /api/wake。発話の先頭の呼びかけだけを拾い、漢字は読み仮名に直して比べる）
  // → { hit, reading, rest（呼びかけに続けて言った用件） }。ブラウザの音声認識は途中結果ごとに呼ぶのでキャッシュする
  const wakeCache = new Map();
  function checkWake(text) {
    const key = wakeList().join(",") + "\n" + text;
    if (wakeCache.has(key)) return wakeCache.get(key);
    const pr = fetch("/api/wake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, words: wakeList() }) })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    wakeCache.set(key, pr);
    if (wakeCache.size > 300) wakeCache.delete(wakeCache.keys().next().value);
    return pr;
  }
  // voice: 呼びかけの音声 { wav, start, end }（会話の主として声を覚えるため。ローカル音声認識のとき）
  function triggerWake(heard, w, voice = null) {
    if (!standbyOn || conversation || connecting) return;
    if (isLocal()) warmBrain();   // 呼びかけに続けて用件を言われたとき、すぐ答えられるように
    addLog("sys", `呼びかけを検知：${heard || lastHeard}${HAS_KANJI.test(heard) ? `（${w.reading}）` : ""}`);
    sys("呼びかけを聞き取りました。接続します。");
    startConversation(w.rest, voice);
  }
  const fmtSec = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const MODE_LABEL = { idle: "IDLE", standby: "STANDBY", connecting: "LINKING", listening: "LISTENING", speaking: "SPEAKING", thinking: "THINKING" };
  function setState(state, label) {
    if (orbOk) Orb.setState(state);
    ui.hudMode.textContent = MODE_LABEL[state] || state.toUpperCase();
    if (label) ui.status.textContent = label;
  }
  function sys(msg) { ui.sys.textContent = msg; }
  function note(msg) { ui.note.textContent = msg; }

  // 応答の速さ（話し終わり → 返事の声が出るまで）。logs/timing.jsonl に残し、設定でオンなら会話ログにも出す
  function reportTiming(t) {
    fetch("/api/timing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(t) }).catch(() => {});
    if (ui.showTiming.checked) addLog("sys", LocalVoice.timingText(t));
  }
  function addLog(who, text) {
    if (who === "sys") window.AmaneAmbient?.notify(text);   // 表示だけモードでは、エラーを画面の下に短く出す
    // 縦型の収録モードの字幕（VOICEVOX / AivisSpeech モードの返事は、話している文ごとに onSpeak で出す）
    if (who === "user") AmaneRec.said(text);
    else if (who === "ai" && !isLocal()) AmaneRec.speaking(text);
    const div = document.createElement("div");
    div.className = "msg " + (who === "ai" ? "ai" : who === "sys" ? "sysmsg" : "user");
    const w = document.createElement("span");
    w.className = "who"; w.textContent = who === "ai" ? AI_NAME : who === "sys" ? "システム" : "あなた";
    const t = document.createElement("span"); t.textContent = text;
    div.append(w, t);
    ui.log.prepend(div);          // 最新を一番上に
    ui.log.scrollTop = 0;
  }

  function refreshButtons() {
    const inConv = Boolean(conversation) || connecting;
    ui.btnStandby.textContent = standbyOn ? "待受をオフ" : "待受をオン";
    ui.btnStandby.classList.toggle("on", standbyOn);
    ui.btnTalk.disabled = inConv;
    ui.btnEnd.disabled = !inConv;
    ScreenAwake.set(standbyOn || inConv);   // 待受中・会話中は画面を消さない（screen-awake.js）
    if (!inConv) setState(standbyOn ? "standby" : "idle", standbyOn ? "呼びかけを待っています" : "待受はオフです");
  }

  function chime(freqs = [880, 1320]) {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const now = ac.currentTime;
      freqs.forEach((f, i) => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.frequency.value = f; o.type = "sine";
        g.gain.setValueAtTime(0, now + i * 0.09);
        g.gain.linearRampToValueAtTime(0.12, now + i * 0.09 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.09 + 0.25);
        o.connect(g).connect(ac.destination); o.start(now + i * 0.09); o.stop(now + i * 0.09 + 0.3);
      });
      setTimeout(() => ac.close(), 800);
    } catch {}
  }

  // ---------- 待受中のマイク波形（オーブ用） ----------
  async function startMicAnalyser() {
    if (micStream) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      micCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = micCtx.createMediaStreamSource(micStream);
      micAnalyser = micCtx.createAnalyser();
      micAnalyser.fftSize = 512; micAnalyser.smoothingTimeConstant = 0.6;
      src.connect(micAnalyser);
      micBins = new Uint8Array(micAnalyser.frequencyBinCount);
    } catch (e) { console.warn("mic analyser:", e); stopMicAnalyser(); }
  }
  function stopMicAnalyser() {
    try { micStream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { micCtx?.close(); } catch {}
    micStream = micCtx = micAnalyser = micBins = null;
  }

  // 毎フレーム、オーブに音のデータを渡す
  function audioLoop() {
    let bins = null;
    if (conversation) {
      try {
        bins = mode === "speaking" ? conversation.getOutputByteFrequencyData() : conversation.getInputByteFrequencyData();
      } catch {}
    } else if (vad && standbyOn) {
      bins = vad.getByteFrequencyData();
    } else if (micAnalyser && standbyOn) {
      micAnalyser.getByteFrequencyData(micBins);
      bins = micBins;
    }
    if (orbOk) Orb.setBins(bins);
    if (conversation && callStartedAt) ui.hudTimer.textContent = fmtSec((Date.now() - callStartedAt) / 1000);
    requestAnimationFrame(audioLoop);
  }
  setInterval(() => { ui.hudClock.textContent = new Date().toLocaleTimeString("ja-JP", { hour12: false }); }, 1000);

  // ---------- 耳: 呼びかけ待ち受け ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function initRecognition() {
    if (!SR) {
      if (!useWhisper()) { sys("このブラウザは音声認識に対応していません。Google Chrome か Microsoft Edge で開くか、ローカル Whisper を使ってください。"); ui.btnStandby.disabled = true; }
      return;
    }
    recog = new SR();
    recog.lang = "ja-JP";
    recog.continuous = true;
    recog.interimResults = true;
    recog.maxAlternatives = 3;

    recog.onstart = () => { recogRunning = true; };
    recog.onresult = (ev) => {
      if (!standbyOn || conversation || connecting) return;
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const text = res[0].transcript.trim();
        if (text) {
          lastHeard = text;
          ui.heard.innerHTML = "";
          ui.heard.append("聞こえた言葉：");
          const b = document.createElement("b"); b.textContent = text; ui.heard.append(b);
          ui.btnAddHeard.disabled = false;
        }
        // 候補ごとに判定（漢字混じりなら読みも表示。例: 「やあ天音」→ ヤアテンオン）
        for (let a = 0; a < res.length; a++) {
          const alt = res[a].transcript.trim();
          if (!alt) continue;
          checkWake(alt).then((w) => {
            if (!w) return;
            if (HAS_KANJI.test(alt) && alt === lastHeard && ui.heard.lastChild) ui.heard.lastChild.textContent = `${alt}（${w.reading}）`;
            if (w.hit) triggerWake(alt, w);
          });
        }
      }
    };
    recog.onerror = (ev) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        standbyOn = false; stopMicAnalyser(); refreshButtons();
        sys("マイクが許可されていません。ブラウザのアドレスバー左のアイコンと、Windowsの設定（プライバシー > マイク）の両方で許可してください。");
      } else if (ev.error === "network") {
        sys("音声認識サービスに接続できません（ネットワークを確認してください）。再試行します…");
      } else if (ev.error === "audio-capture") {
        sys("マイクが見つかりません。マイクの接続を確認してください。");
      }
    };
    recog.onend = () => {
      recogRunning = false;
      recogStopWaiters.splice(0).forEach((r) => r());
      if (standbyOn && !conversation && !connecting) setTimeout(startRecognition, 300);
    };
  }

  // ---------- 耳（ローカル Whisper 版） ----------
  const useWhisper = () => ui.sttEngine.value === "whisper";
  const sttHotwords = () => [...wakeList(), ...(ui.sttHints.value || "").split(/[,、，]/)].map((w) => w.trim()).filter(Boolean).join("、");
  const micSens = () => Number(ui.micSens.value) || 1;
  const STANDBY_MAX_MS = 6000;   // 待受中の 1 回の長さの上限（騒がしくて区切りが来なくても、数秒ごとに呼びかけを調べる）
  const STANDBY_OVERLAP_MS = 1500;   // 上限で切るとき、切れ目にかかった呼びかけが途切れないよう次の頭に重ねる長さ
  const STANDBY_PRE_ROLL_MS = 1500;  // 話し始めの手前を含める長さ（雑音の中で判定が遅れても、短い呼びかけを落とさない）
  const SPLIT_MIN_SEC = 1.5;     // 声がこれより長い発話で呼びかけが見つからなければ、声の切れ目で区切り直して探す
  const SPLIT_JOIN_GAP = 0.4;    // 区切り直したとき、間がこれ以下（秒）で続く区切りだけを、呼びかけに続く用件としてつなげる
  // 騒がしいと、テレビの声などと一緒に長いかたまりで届き、途中の呼びかけは「話し始め」ではないので見つからない。
  // 声の切れ目で区切り直し、区切りごとに、そこを話し始めとみなして呼びかけを探す
  async function findWakeInParts(wav) {
    const r = await MicVAD.transcribe(wav, sttHotwords(), "wake", { split: true });
    const segs = r.segments || [];
    if (segs.length < 2) return null;   // 区切れなければ、元の判定と同じ
    for (let k = 0; k < segs.length; k++) {
      if (!segs[k].text) continue;
      // 用件としてつなげるのは、間を空けずに続く区切りだけ（離れた後ろのテレビの声などを用件にしない）
      let text = segs[k].text, j = k + 1;
      for (; j < segs.length && segs[j].start - segs[j - 1].end <= SPLIT_JOIN_GAP; j++) text += segs[j].text;
      const w = await checkWake(text);
      if (w?.hit) return { text, w, start: segs[k].start, end: segs[j - 1].end };   // start〜end: 呼びかけと用件の区間（秒）
    }
    return null;
  }
  let vad = null, vadStarting = false;
  let standbyGen = 0;      // 待受を止めるたびに増やす（止める前に届いた発話の結果で、呼びかけ扱いにしない）
  let splitting = false;   // 区切り直しは同時に 1 つまで（テレビがつきっぱなしでも、文字起こしの依頼を溜めない）
  async function startWhisperStandby() {
    if (vad || vadStarting) return;
    vadStarting = true;
    try {
      const h = await MicVAD.health();
      if (!h.ok) throw new Error(h.error || "音声認識サーバーに接続できません");
      if (!standbyOn || conversation || connecting) return;
      const gen = standbyGen;
      const live = () => gen === standbyGen;
      // Whisper は短い区切りでも一定時間かかるので、区切り直しは ReazonSpeech のときだけ
      const canSplit = h.engine !== "whisper";
      vad = await new MicVAD.Listener({
        sensitivity: micSens(),
        adaptive: true,
        maxMs: STANDBY_MAX_MS,
        overlapMs: STANDBY_OVERLAP_MS,
        preRollMs: STANDBY_PRE_ROLL_MS,
        onSpeechStart: () => { ui.heard.textContent = "聞き取り中…"; },
        onDiscard: () => { ui.heard.innerHTML = "&nbsp;"; },
        onUtterance: async (wav, sec, voiceSec = sec) => {
          ui.heard.textContent = `認識中…（${sec.toFixed(1)}秒）`;
          try {
            const r = await MicVAD.transcribe(wav, sttHotwords(), "wake");
            if (!live()) return;
            if (!r.text) { ui.heard.innerHTML = "&nbsp;"; return; }
            lastHeard = r.text;
            ui.heard.innerHTML = ""; ui.heard.append("聞こえた言葉：");
            const b = document.createElement("b"); b.textContent = r.text; ui.heard.append(b);
            ui.heard.append(`（${r.ms}ms）`);
            ui.btnAddHeard.disabled = false;
            const w = await checkWake(r.text);
            if (!live()) return;
            if (w?.hit) return triggerWake(r.text, w, { wav });
            if (!canSplit || splitting || voiceSec < SPLIT_MIN_SEC) return;
            splitting = true;
            try {
              const found = await findWakeInParts(wav);
              if (found && live()) triggerWake(found.text, found.w, { wav, start: found.start, end: found.end });
            } finally { splitting = false; }
          } catch (e) { ui.heard.textContent = "認識エラー：" + e.message; }
        },
      }).start();
      if (vad.ctx.state !== "running") { sys("マイクの音を処理できません。画面を一度タップしてください。"); return; }
      sys(`待受中です（ローカル音声認識：${h.model} / ${h.device === "cuda" ? "GPU" : "CPU"}）。「${wakeList()[0] || AI_NAME}」と呼びかけてください。`);
    } catch (e) {
      standbyOn = false; refreshButtons();
      sys("ローカル音声認識を使えません：" + e.message);
      addLog("sys", "ローカル音声認識を使えません：" + e.message + "。start.bat の黒いウィンドウに [stt] のエラーが出ていないか確認するか、設定で「ブラウザの音声認識」に切り替えてください。");
    } finally { vadStarting = false; }
  }
  async function stopWhisperStandby() {
    standbyGen++;
    const v = vad; vad = null;
    if (v) await v.stop();
  }

  function startRecognition() {
    if (!standbyOn || conversation || connecting) return;
    if (useWhisper()) return startWhisperStandby();
    if (!recog || recogRunning) return;
    try { recog.start(); } catch {}
    startMicAnalyser();
  }
  function stopRecognition() {
    stopMicAnalyser();
    stopWhisperStandby();
    if (!recog || !recogRunning) return Promise.resolve();
    return new Promise((resolve) => {
      recogStopWaiters.push(resolve);
      try { recog.abort(); } catch { resolve(); }
      setTimeout(resolve, 1000);
    });
  }

  // ---------- 資料の表示パネル（viewer.js。右・左・中央に出し分ける） ----------
  // 怪しい URL（長い文字列が付いている・IP アドレスで指している）の Web ページは、開く前に画面で確かめる
  //  （だまされた頭が、会話の中身などをアドレスに付けて外のサイトに送らないように）
  const showContent = (p = {}) => {
    const risk = AmanePlugins.urlRisk(p.src);
    if (!risk) return AmaneViewer.show(p);
    let host = "";
    try { host = new URL(p.src).hostname; } catch { /* urlRisk が読めた URL なので来ない */ }
    askLocal({ title: "Web ページを開く", text: `${host} を開きますか？ ${risk}。`, label: "開く" }, async (ok) => {
      if (!ok) return { ok: true, kind: "cancelled", text: "ページは開きませんでした。" };
      await AmaneViewer.show(p);
      return { ok: true, kind: "command", text: "ページを開きました。" };
    }, "Web ページを開くこと");
    return "開く前に、画面で確かめてもらっています。";
  };
  const hideContent = () => AmaneViewer.hide();
  AmaneViewer.setOnFocus((where) => Orb.setFocus?.(where));   // AI の姿をパネルからよける
  // 開発者ツールのコンソールから試せるように（例: amane.show({ src: "sample.png", place: "left" })）
  window.amane = { show: showContent, hide: hideContent };

  // ---------- 作業（client tools） ----------
  const clientTools = {
    // 画面に資料・画像を表示する（src: 作業フォルダ内のパス or URL / text: Markdown）
    show_content: (p = {}) => showContent(p),
    hide_content: () => hideContent(),
    // ElevenLabs 側に同名の Client tool を登録してください（README 参照）
    // 設定の「作業を頼む前に確認する」なら、画面に確認を出し、「お願い」かボタンで決めてから始める
    run_task: async (params = {}) => {
      const task = String(params.task || params.request || "").trim();
      if (!task) return "作業内容が空でした。何をするか聞き返してください。";
      const req = { task, level: params.level, engine: params.engine };
      if (!needTaskConfirm(req.level)) return (await startTask(req)).text;
      askLocal({ title: "作業の依頼", text: `作業担当に、次の作業を頼みますか？「${task.slice(0, 120)}」`, label: "頼む" }, async (ok) => {
        if (!ok) return { ok: true, kind: "cancelled", text: "作業は頼みませんでした。" };
        const r = await startTask(req);
        return r.ok ? { ok: true, kind: "command", text: r.text } : { ok: false, status: 500, error: r.text };
      }, "作業の依頼");
      if (isLocal()) { conversation?.say?.("よろしければ「お願い」と言うか、画面のボタンを押してください。"); return ""; }
      return "画面に確認を出しました。ユーザーが「お願い」と言うか、画面のボタンを押したら始めます（まだ始めていません）。";
    },
    get_task_status: async () => {
      const list = await (await fetch("/api/tasks")).json();
      if (!list.length) return "実行した作業はありません。";
      return list.slice(0, 5).map((t) =>
        `作業ID${t.id}（${t.engineLabel}）「${t.task}」: ${({ running: "実行中", done: "完了", error: "失敗", cancelled: "中止" })[t.status]}` +
        (t.status === "running" ? `、経過${Math.round((Date.now() - t.startedAt) / 1000)}秒、直近の動き: ${t.progress.at(-1) || "なし"}` : t.report ? `、結果: ${t.report}` : t.error ? `、理由: ${t.error}` : "")
      ).join("\n");
    },
    get_current_datetime: () => new Date().toLocaleString("ja-JP", { dateStyle: "full", timeStyle: "short" }),
    // 追加機能（ElevenLabs 側に同名の Client tool を登録。引数は action（例: timer.set）と args（JSON の文字列）。docs/plugins.md）
    plugin_action: async (params = {}) => {
      let args = params.args ?? {};
      if (typeof args === "string") { try { args = JSON.parse(args || "{}"); } catch { return "args は JSON の形で書いてください。"; } }
      const name = String(params.action || "");
      const r = await AmanePlugins.act(name, args && typeof args === "object" ? args : {});
      if (r.ok && r.kind === "confirm") { askConfirm(name, r.confirm); return "画面に確認のボタンを出しました。ユーザーが画面のボタンで決めるまで、実行されません。"; }
      return r.ok ? r.text || "実行しました。" : "失敗しました: " + r.error;
    },
  };

  // 作業を始める → { ok, text }（text は頭に伝える文）
  async function startTask({ task, level, engine }) {
    try {
      const r = await fetch("/api/tasks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, level, engine }),
      });
      const j = await r.json();
      if (!r.ok) return { ok: false, text: "作業を開始できませんでした: " + (j.error || r.status) };
      taskState.set(j.id, "running");
      myTasks.add(j.id);
      addLog("sys", `#${j.id} ${j.engineLabel} が作業開始：${task}`);
      pollTasks();
      return { ok: true, text: `作業ID${j.id}として受け付け、${j.engineLabel}が取りかかりました。完了したら通知が来るので、それまでは他の話をして構いません。` };
    } catch (e) {
      return { ok: false, text: "作業サーバーに接続できませんでした: " + e.message };
    }
  }
  // 作業を頼む前に確認するか（設定: all すべて | heavy 時間のかかる作業だけ | none しない）
  //  頭がだまされると重い作業を light と書くこともあるので、既定は all
  const needTaskConfirm = (level) => ui.taskConfirm.value === "all" || (ui.taskConfirm.value === "heavy" && level !== "light");

  // ---------- 画面だけで決める確認（作業の依頼・怪しいページを開く）と、声での答え ----------
  // run(ok): 決めたときの処理 → { ok, kind, text } | { ok: false, error }。決めた結果は、会話中なら頭に伝える
  let localSeq = 0;
  function askLocal({ title, text, label, voice = "any" }, run, name) {
    const id = `local${++localSeq}${Date.now().toString(36)}`;
    addLog("sys", `確認待ち：${text}（画面のボタンか、声で「お願い」／「やめて」）`);
    AmanePlugins.showConfirm({ id, title, text, label, voice, ttlMs: 60000 }, (d) => {
      addLog("sys", `${name}：${d.ok ? d.text : d.error}`);
      if (!conversation) return;
      reportQueue.push(d.ok && d.kind === "cancelled" ? `［システム］ユーザーが「やめる」と決めたので、${name}はしませんでした。`
        : d.ok ? `［システム］${d.text}` : `［システム］${name}: ${d.error}`);
      flushReports();
    }, { decide: run });
  }
  // 確認が出ている間の声の答え（画面が直接受け取り、頭には送らない）→ 受け取ったら true
  //  voice: owner の確認（鍵を開けるなど）は、「呼びかけた人の声だけを聞く」がオンのとき（声紋で本人と分かるとき）だけ声で決められる
  function voiceAnswer(text) {
    const c = AmanePlugins.activeConfirm();
    const a = c ? AmanePlugins.voiceAnswerOf(text) : "";
    if (!a) return false;
    // 設定ではなく、いまの会話で声紋が本当に効いているか（会話の途中で設定をオンにしても、その会話には効かない）
    const owner = isLocal() && conversation?.voiceprint === true;
    if (c.voice === "none" || (c.voice === "owner" && !owner)) {
      addLog("sys", c.voice === "owner" ? "この確認は、声紋（呼びかけた人の声だけを聞く）がオンのときだけ声で決められます。画面のボタンで決めてください" : "この確認は、画面のボタンで決めてください");
      return true;
    }
    if (!c.say(a === "yes")) { addLog("sys", "確認が出たばかりなので、声の答えは受け付けませんでした。もう一度言ってください"); return true; }
    return true;
  }

  // ---------- 追加機能（plugins.js。タイマーなど） ----------
  // 頭のタグ（<act do="…"/>）を実行する。頭に伝えてほしいこと（確認の結果・失敗の理由）があれば、その文を返す
  async function runAct(at = {}) {
    const { name, args } = AmanePlugins.splitTag(at);
    const r = await AmanePlugins.act(name, args);
    if (!r.ok) {
      addLog("sys", `追加機能（${name}）に失敗：${r.error}`);
      return `［追加機能の結果］${name} は失敗しました。理由: ${r.error}。ユーザーに短く伝えて、どうするか聞いてください。`;
    }
    if (r.kind === "confirm") { askConfirm(name, r.confirm); return ""; }
    if (r.text) addLog("sys", `${name}：${r.text}`);
    return r.kind === "query" ? `［追加機能の結果］${r.text}\nこれをユーザーに簡潔に伝えてください。` : "";
  }
  // 確かめてから実行する動作: 画面に確認のボタンを出す。決めた結果は、会話中なら頭に伝えてもらう
  function askConfirm(name, confirm) {
    addLog("sys", `確認待ち：${confirm?.text || name}（画面のボタンで決めてください）`);
    AmanePlugins.showConfirm(confirm, (d) => {
      addLog("sys", `${name}：${d.ok ? d.text : d.error}`);
      if (conversation) { reportQueue.push(confirmReport(name, d)); flushReports(); }
    });
  }
  // 確認のボタンで決めた結果を、頭に伝える文にする（実行しなかった・失敗した・実行されたか分からない、を分ける）
  function confirmReport(name, d) {
    if (d.ok && d.kind === "cancelled") return `［追加機能の結果］ユーザーが画面で「やめる」を押したので、${name} は実行しませんでした。`;
    if (d.ok) return `［追加機能の結果］${d.text}\nこれをユーザーに簡潔に伝えてください。`;
    if (d.expired) return `［追加機能の結果］${d.error}（${name}）。`;
    // 時間切れ（504）・通信の失敗（0）は、実行されたかどうか分からない
    if (d.status === 504 || d.status === 0) return `［追加機能の結果］${name} は、実行されたか分かりません。理由: ${d.error}。状態を確かめるよう、ユーザーに伝えてください。`;
    return `［追加機能の結果］${name} は失敗しました。理由: ${d.error}。ユーザーに短く伝えて、どうするか聞いてください。`;
  }
  // 追加機能からの知らせ（タイマーが鳴った、など）。音を鳴らして、声で伝える（会話中なら、頭に伝えてもらう）
  //  自分から話しかけるのは、待受がオンのときだけ（待受をオフにしたら、知らせでマイクを開かない）。
  //  届け先の画面がつながっていなくて全部の画面に届いた知らせ（fallback）は、この PC の画面だけが話す（ほかは音だけ）
  const IS_PC = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const NOTICE_IDLE_SEC = 30;   // 知らせで始めた会話は、無言がこれだけ続いたら終える（設定の「無言で終了」がオフでも）
  let noticeStarting = false;   // 知らせの言葉で会話を始める準備中（音が鳴り終わるのを待っている）
  function alarm() { for (let i = 0; i < 3; i++) setTimeout(() => chime([988, 1319, 1568]), i * 800); }
  function onPluginSay(ev) {
    if (ev.chime === "alarm") alarm(); else chime([660, 990]);
    addLog("sys", `お知らせ：${ev.text}`);
    // 会話中・会話を始める準備中なら、頭に伝えてもらう（続けて届いた知らせも落とさない）
    const queue = () => { reportQueue.push(`［お知らせ］${ev.text}`); flushReports(); };
    if (conversation || connecting || noticeStarting) return queue();
    if (!isLocal() || !standbyOn || (ev.fallback && !IS_PC)) return;
    // 呼ばれたときの「はい、お呼びでしょうか」の代わりに、知らせの言葉で話し始める（音が鳴り終わってから）
    noticeStarting = true;
    setTimeout(() => {
      noticeStarting = false;
      if (conversation || connecting) queue();
      else startConversation("", null, { greeting: ev.text, idleSec: NOTICE_IDLE_SEC });
    }, ev.chime === "alarm" ? 2400 : 600);
  }

  function renderTasks(list) {
    if (!list.length) { ui.tasks.innerHTML = '<p class="empty">まだ作業はありません</p>'; return; }
    ui.tasks.innerHTML = list.map((t) => {
      const sec = Math.round(((t.endedAt || Date.now()) - t.startedAt) / 1000);
      const st = { running: "実行中", done: "完了", error: "失敗", cancelled: "中止" }[t.status];
      const usage = t.usage
        ? (t.usage.cost_usd_equivalent != null ? `API換算 $${Number(t.usage.cost_usd_equivalent).toFixed(3)}` : "") +
          (t.usage.output_tokens ? ` 出力${t.usage.output_tokens}tok` : "")
        : "";
      return `<div class="task ${t.status}">
        <div class="head"><span class="badge ${t.level}">${esc(t.engineLabel)}</span>
          ${t.status === "running" ? `<button class="cancel" data-id="${t.id}">中止</button>` : ""}</div>
        <div class="title">#${t.id} ${esc(t.task)}</div>
        <div class="meta"><span>${st} · ${sec}秒 · 振分:${esc(t.routedBy)}</span><span>${esc(usage)}</span></div>
        ${t.status === "running" ? `<div class="prog">${esc(t.progress.at(-1) || "")}</div>` : ""}
        ${t.report ? `<div class="report">${esc(t.report)}</div>` : t.error ? `<div class="report">${esc(t.error)}</div>` : ""}
      </div>`;
    }).join("");
  }
  ui.tasks.addEventListener("click", async (e) => {
    const id = e.target?.dataset?.id;
    if (id) { await fetch(`/api/tasks/${id}/cancel`, { method: "POST" }); pollTasks(); }
  });

  let pollTimer = null;
  async function pollTasks() {
    clearTimeout(pollTimer);
    let list = [];
    try { list = await (await fetch("/api/tasks")).json(); } catch { pollTimer = setTimeout(pollTasks, 3000); return; }
    renderTasks(list);
    let anyRunning = false;
    for (const t of list) {
      const prev = taskState.get(t.id);
      if (t.status === "running") anyRunning = true;
      if (prev === "running" && t.status !== "running") onTaskFinished(t);
      taskState.set(t.id, t.status);
    }
    if (orbOk) Orb.setWorking(anyRunning);
    pollTimer = setTimeout(pollTasks, anyRunning ? 1200 : 4000);
  }

  function onTaskFinished(t) {
    // 表示と報告は、その作業を頼んだ画面だけでする（PC と iPad の両方で開いていても、二重に話さないように）
    const mine = myTasks.has(t.id);
    if (mine && t.showPath && t.status === "done") showContent({ title: t.task, src: t.showPath });
    const ok = t.status === "done";
    chime(ok ? [660, 990, 1320] : [440, 330]);
    addLog("sys", `#${t.id} ${ok ? "完了" : t.status === "cancelled" ? "中止" : "失敗"}：${t.report || t.error || ""}`);
    if (t.status === "cancelled" || !mine) return;
    reportQueue.push(
      ok
        ? `［作業完了の通知］作業ID${t.id}「${t.task}」が完了しました（担当: ${t.engineLabel}）。結果: ${t.report || "報告文なし"}。この結果をユーザーに簡潔に伝えてください。`
        : `［作業失敗の通知］作業ID${t.id}「${t.task}」は失敗しました（担当: ${t.engineLabel}）。理由: ${t.error || t.report || "不明"}。ユーザーに伝え、どうするか聞いてください。`
    );
    if (conversation) flushReports();
    // 自分から報告を始めるときは、呼ばれたときの「はい、お呼びでしょうか」ではなく、状況に合ったあいさつにする
    else if (ui.autoReport.checked) { sys("作業が終わったので報告します。"); startConversation("", null, { greeting: REPORT_GREETINGS[ok ? 0 : 1] }); }
  }
  function flushReports() {
    if (!conversation || connecting || mode === "speaking" || !reportQueue.length) return;
    const msg = reportQueue.splice(0).join("\n");
    try { conversation.sendUserMessage(msg); } catch (e) { console.error(e); }
  }
  setInterval(flushReports, 1000);

  // ---------- 頭+口: ElevenLabs ----------
  async function getSessionConfig() {
    const agentId = (ui.agentId.value || "").trim() || serverCfg.agentId;
    if (!agentId) throw new Error(`Agent ID が未設定です。右の「設定」の「声」で入力して保存してください（${ttsName()} モードなら不要です）。`);
    if (serverCfg.signedUrlAvailable) {
      const r = await fetch("/api/signed-url?agentId=" + encodeURIComponent(agentId));
      const j = await r.json();
      if (!r.ok) throw new Error("署名付きURLの取得に失敗: " + (j.error || r.status));
      return { signedUrl: j.signedUrl, connectionType: "websocket" };
    }
    return { agentId };
  }

  // idleOverrideSec: この会話だけの、無言で終える秒数（知らせで始めた会話。設定の「無言で終了」がオフでも効く）
  let idleOverrideSec = 0;
  function resetIdleTimer() {
    clearTimeout(idleTimer);
    const base = ui.idleEnd.checked ? Math.max(10, Number(ui.idleSec.value) || 60) : Infinity;
    const sec = Math.min(base, idleOverrideSec || Infinity);
    if (!conversation || sec === Infinity) return;
    idleTimer = setTimeout(() => {
      if (conversation && mode === "listening" && !reportQueue.length) {
        sys(`${sec}秒間会話がなかったので終了しました。`);
        endConversation();
      } else resetIdleTimer();
    }, sec * 1000);
  }

  const isLocal = () => ui.voiceEngine.value === "voicevox";

  // initialText: 呼びかけに続けて言った用件（「やあ天音、明日の予定は？」の「明日の予定は？」）。最初の質問として渡す
  // greeting: 最初のあいさつ（省略時は「はい、お呼びでしょうか。」）
  // idleSec: この会話だけ、無言がこの秒数続いたら終える（知らせで始めた会話）
  async function startConversation(initialText = "", wakeVoice = null, { greeting, idleSec = 0 } = {}) {
    if (conversation || connecting) return;
    connecting = true; pendingEnd = false;
    idleOverrideSec = idleSec;
    refreshButtons();
    setState("connecting", "接続しています");
    await stopRecognition();
    chime();

    try {
      if (navigator.userActivation && !navigator.userActivation.hasBeenActive) {
        sys("※ 音声を再生するには、画面を一度クリックしておく必要があります。");
      }
      const local = isLocal();
      const cfg = local
        ? { speaker: Number(ui.vvSpeaker.value || 2), speed: Number(ui.vvSpeed.value || 1.15), volume: vvVolume(), moods: ui.vvMood.checked, initialText,
            stt: useWhisper() ? "whisper" : "browser", hotwords: sttHotwords(), sensitivity: micSens(),
            onInterim: (t) => { ui.heard.textContent = t ? "聞き取り中：" + t : "\u00a0"; AmaneRec.hearing(t); },
            onSpeak: (t) => AmaneRec.speaking(t),
            onShow: (c) => showContent(c),
            onHide: () => hideContent(),
            onAct: (at) => runAct(at),
            onUserText: (t) => voiceAnswer(t),   // 確認が出ている間の「お願い」「やめて」は、画面が受け取る
            onTool: (name) => setState("thinking", name === "web_search" ? "調べています" : "考えています"),
            // 呼びかけた人（会話の主）の声だけを聞く（テレビや家族の声は聞き流す。stt/speaker.py）
            ownerOnly: ui.ownerOnly.checked, wakeVoice, greeting,
            onOwner: (r) => sys(r.owner ? "呼びかけた人の声を覚えました。この会話では、その人の声だけを聞きます。" : "最初に話した人の声を覚えて、その人の声だけを聞きます。"),
            onIgnored: () => { ui.heard.textContent = "（周りの声を聞き流しました）"; },
            onTiming: (t) => reportTiming(t),
            onCost: (usd) => { localCost += usd || 0; localTurns++; ui.usageLast.textContent = `ローカル会話: ${localTurns}往復 · Claude API換算 $${localCost.toFixed(3)}（サブスク内・参考値）`; } }
        : await getSessionConfig();
      const provider = local ? LocalVoice : ElevenLabsClient.Conversation;
      conversation = await provider.startSession({
        ...cfg,
        clientTools,
        onConnect: () => { mode = "listening"; callStartedAt = Date.now(); setState("listening", "聞いています"); resetIdleTimer(); },
        onDisconnect: (details) => {
          console.log("[amane] disconnect:", details);
          if (details && details.reason === "error") addLog("sys", "切断（エラー）：" + (details.message || JSON.stringify(details.context || {})).slice(0, 200));
          const id = conversationId;
          conversation = null; conversationId = null; connecting = false; callStartedAt = 0; idleOverrideSec = 0;
          clearTimeout(idleTimer);
          AmaneRec.clear();
          refreshButtons();
          if (standbyOn) { sys("会話を終了しました。呼びかけを待っています。"); startRecognition(); }
          else sys("会話を終了しました。");
          if (id) fetchConversationUsage(id);
        },
        onError: (message, ctx) => { console.error(message, ctx); sys("エラー: " + message); addLog("sys", "エラー：" + message); },
        onStatusChange: ({ status }) => console.log("[amane] status:", status),
        onMessage: (m) => {
          if (!m.message || /^［(作業|お知らせ|追加機能の結果)/.test(m.message)) return; // 自分で送った通知は表示しない
          const who = (m.role === "agent" || m.source === "ai") ? "ai" : "user";
          addLog(who, m.message);
          // ElevenLabs モードでは、頭にも届くが、確認の答えは画面が受け取る（VOICEVOX モードは onUserText で先に受け取る）
          if (who === "user" && !isLocal()) voiceAnswer(m.message);
          if (who === "user" && END_PHRASES.test(m.message)) pendingEnd = true;
          resetIdleTimer();
        },
        onModeChange: ({ mode: md }) => {
          mode = md;
          if (md === "speaking") setState("speaking", "話しています");
          else if (md === "thinking") setState("thinking", "考えています");
          else {
            setState("listening", "聞いています");
            if (pendingEnd) setTimeout(endConversation, 400);
            else flushReports();
          }
          resetIdleTimer();
        },
      });
      try { conversationId = conversation.getId(); } catch {}
      connecting = false;
      refreshButtons();
    } catch (e) {
      console.error(e);
      conversation = null; connecting = false;
      sys(String(e.message || e));
      addLog("sys", "接続に失敗：" + String(e.message || e));
      refreshButtons();
      if (standbyOn) setTimeout(startRecognition, 1500);
    }
  }

  async function endConversation() {
    pendingEnd = false;
    clearTimeout(idleTimer);
    const c = conversation;
    if (c) { try { await c.endSession(); } catch {} }
  }

  // ---------- 使用量 ----------
  async function refreshSubscription() {
    if (isLocal()) { ui.usageText.textContent = `${ttsName()} モード：ElevenLabs のクレジットは消費しません`; return; }
    if (!serverCfg.usageAvailable) { ui.usageText.textContent = "APIキーを .env に設定すると表示されます"; return; }
    try {
      const r = await fetch("/api/usage/subscription");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      const pct = j.limit ? Math.min(100, (j.used / j.limit) * 100) : 0;
      ui.usageBar.style.width = pct.toFixed(1) + "%";
      const reset = j.resetAt ? new Date(j.resetAt * 1000).toLocaleDateString("ja-JP") : "-";
      ui.usageText.textContent = `今期 ${Number(j.used).toLocaleString()} / ${Number(j.limit).toLocaleString()} クレジット（${pct.toFixed(1)}%）· ${j.tier} · リセット ${reset}`;
    } catch (e) {
      ui.usageText.textContent = "取得できません: " + e.message + "（APIキーに User の読み取り権限が必要な場合があります）";
    }
  }
  async function fetchConversationUsage(id, tries = 0) {
    try {
      const r = await fetch("/api/usage/conversation/" + id);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      if ((j.status !== "done" || j.credits == null) && tries < 8) { setTimeout(() => fetchConversationUsage(id, tries + 1), 4000); return; }
      ui.usageLast.textContent = `直近の会話: ${j.durationSec ?? "?"}秒 · ${j.credits ?? "?"} クレジット` + (j.costFiat != null ? `（$${Number(j.costFiat).toFixed(3)}）` : "");
      refreshSubscription();
    } catch (e) {
      if (tries < 3) setTimeout(() => fetchConversationUsage(id, tries + 1), 4000);
      else ui.usageLast.textContent = "直近の会話の使用量を取得できませんでした: " + e.message;
    }
  }
  ui.btnUsage.onclick = refreshSubscription;
  // 設定を開いたとき、声の一覧を読めていなければ取り直す（VOICEVOX を後から起動したとき）
  AmaneSettings.onOpen(() => { if (isLocal() && !speakersLoaded) loadSpeakers(); });

  // ---------- 設定 ----------
  function loadSettings() {
    ui.agentId.value = store.get("agentId", "") || serverCfg.agentId || "";
    ui.wakeWords.value = store.get("wakeWords", DEFAULT_WAKE).join(", ");
    ui.idleEnd.checked = store.get("idleEnd", true);
    ui.idleSec.value = store.get("idleSec", 60);
    ui.autoReport.checked = store.get("autoReport", true);
    ui.autoStandby.checked = store.get("autoStandby", false);
    ui.ownerOnly.checked = store.get("ownerOnly", false);
    ui.showTiming.checked = store.get("showTiming", false);
    ui.taskConfirm.value = store.get("taskConfirm", "all");
    ui.voiceEngine.value = store.get("voiceEngine", "voicevox");
    ui.visual.value = store.get("visual", "swarm");
    ui.panelScale.value = store.get("panelScale", 1);
    applyPanelScale();
    ui.vvSpeed.value = store.get("vvSpeed", 1.15);
    ui.vvVolume.value = store.get("vvVolume", IS_IOS ? 2 : 1);
    ui.sttEngine.value = store.get("sttEngine", "whisper");
    ui.sttHints.value = store.get("sttHints", "Codex, Claude, Opus, VOICEVOX");
    ui.micSens.value = store.get("micSens", 1);
    ui.vvSpeedVal.textContent = Number(ui.vvSpeed.value).toFixed(2);
    ui.vvVolumeVal.textContent = vvVolume().toFixed(2);
    ui.micSensVal.textContent = micSens().toFixed(1);
    applySttUI();
    document.getElementById("vvSpeakerLabel").textContent = `${ttsName()} の声`;
    ui.voiceEngine.querySelector('option[value="voicevox"]').textContent = `${ttsName()}（無料・頭は Claude Code）`;
    ui.vvMood.checked = store.get("vvMood", true);
    ui.vvMoodRow.style.display = ttsName() === "AivisSpeech" ? "" : "none";   // 声の気持ちは AivisSpeech だけ（lib/moods.js）
    applyEngineUI();
    if (store.get("agentId", "")) note("保存済みのAgent IDを読み込みました。");
    else if (serverCfg.agentId) note(".env のAgent IDを使用しています。");
    else note("ElevenLabsで作ったエージェントのAgent IDを入力してください。");
    if (serverCfg.signedUrlAvailable) note(ui.note.textContent + "（APIキー接続：有効）");
    if (serverCfg.lightEngine) ui.engineInfo.textContent = `軽:${serverCfg.lightEngine} / 重:${serverCfg.heavyEngine}`;
  }

  ui.btnSaveAgent.onclick = () => { store.set("agentId", ui.agentId.value.trim()); note("Agent IDを保存しました。"); };
  ui.btnSaveWake.onclick = () => { store.set("wakeWords", wakeList()); note("呼びかけの言葉を保存しました。"); };
  ui.btnAddHeard.onclick = () => {
    if (!lastHeard) return;
    const list = wakeList();
    if (!list.includes(lastHeard)) list.push(lastHeard);
    ui.wakeWords.value = list.join(", ");
    store.set("wakeWords", list);
    note(`「${lastHeard}」を呼びかけの言葉に追加しました。`);
  };
  ui.idleEnd.onchange = () => store.set("idleEnd", ui.idleEnd.checked);
  ui.idleSec.onchange = () => store.set("idleSec", Number(ui.idleSec.value) || 60);
  ui.autoReport.onchange = () => store.set("autoReport", ui.autoReport.checked);
  ui.autoStandby.onchange = () => store.set("autoStandby", ui.autoStandby.checked);
  ui.ownerOnly.onchange = () => store.set("ownerOnly", ui.ownerOnly.checked);
  ui.showTiming.onchange = () => store.set("showTiming", ui.showTiming.checked);
  ui.taskConfirm.onchange = () => store.set("taskConfirm", ui.taskConfirm.value);

  // ---------- 声のエンジン（ElevenLabs / VOICEVOX） ----------
  let speakersLoaded = false;
  const ttsName = () => serverCfg.ttsName || "VOICEVOX";   // 声の合成（VOICEVOX か、同じ使い方の AivisSpeech）
  async function loadSpeakers() {
    try {
      const list = await LocalVoice.speakers();
      const saved = String(store.get("vvSpeaker", 2));
      ui.vvSpeaker.innerHTML = list.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
      ui.vvSpeaker.value = list.some((s) => String(s.id) === saved) ? saved : String(list[0]?.id ?? 2);
      speakersLoaded = true;
      updateCredit();
      warmupVoice();
      note(`${ttsName()} に接続しました（${list.length}種類の声）。`);
    } catch (e) {
      ui.vvSpeaker.innerHTML = `<option value="2">（${ttsName()} 未接続）</option>`;
      note(`${ttsName()} に接続できません。${ttsName()} を起動してから、設定を開き直してください。`);
    }
  }
  // 縦型の収録モードに出す声のクレジット（例: AivisSpeech: まお）。ElevenLabs の声には出さない
  function updateCredit() {
    const name = ui.vvSpeaker.selectedOptions[0]?.textContent || "";
    AmaneRec.setCredit(isLocal() && speakersLoaded ? AmaneRec.creditFor(ttsName(), name) : "");
  }
  function applyEngineUI() {
    updateCredit();
    const local = isLocal();
    // 設定の中は、いまの声のエンジンで使う項目だけを出す（settings-panel.js が探すときも、隠した項目は出さない）
    ui.vvRow.style.display = ui.showTimingRow.style.display = local ? "" : "none";
    ui.agentRow.style.display = local ? "none" : "";
    if (local && !speakersLoaded) loadSpeakers();
    ui.usageText.textContent = local ? `${ttsName()} モード：ElevenLabs のクレジットは消費しません` : ui.usageText.textContent;
    if (!local) refreshSubscription();
  }
  // マイクの感度・呼びかけた人の声だけを聞くは、ローカル音声認識のときだけ使う
  function applySttUI() { ui.micSensRow.style.display = ui.ownerOnlyRow.style.display = useWhisper() ? "" : "none"; }
  ui.sttEngine.onchange = async () => {
    store.set("sttEngine", ui.sttEngine.value);
    applySttUI();
    if (standbyOn) { await stopRecognition(); startRecognition(); }
    if (useWhisper()) { const h = await MicVAD.health(); note(h.ok ? `ローカル音声認識に接続しました（${h.model} / ${h.device}）` : h.error); }
  };
  ui.btnSaveHints.onclick = () => { store.set("sttHints", ui.sttHints.value); note("認識ヒントを保存しました。"); };
  ui.micSens.oninput = () => {
    const v = micSens();
    ui.micSensVal.textContent = v.toFixed(1); store.set("micSens", v);
    if (vad) vad.sensitivity = v;              // 待受中・会話中もその場で反映
    conversation?.setSensitivity?.(v);
  };
  ui.visual.onchange = () => { store.set("visual", ui.visual.value); location.reload(); };
  // 資料のパネルの文字の大きさ（この画面ごとに覚える。表示中のパネルにもその場で効く）
  function applyPanelScale() {
    const v = Number(ui.panelScale.value) || 1;
    ui.panelScaleVal.textContent = v.toFixed(1);
    document.documentElement.style.setProperty("--panel-scale", String(v));
  }
  ui.panelScale.oninput = () => { applyPanelScale(); store.set("panelScale", Number(ui.panelScale.value) || 1); };
  ui.voiceEngine.onchange = () => { store.set("voiceEngine", ui.voiceEngine.value); applyEngineUI(); };
  // VOICEVOX（特に GPU モード）は最初の合成が遅いので、先に準備させておく
  function warmupVoice() {
    if (!isLocal()) return;
    // 声の準備と、決まった言葉（あいさつ・つなぎの言葉・報告の始め）の先読み
    const phrases = [...LocalVoice.phrases, ...REPORT_GREETINGS];
    fetch("/api/tts/warmup", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speaker: Number(ui.vvSpeaker.value || 2), speed: Number(ui.vvSpeed.value || 1.15), phrases }) }).catch(() => {});
    warmBrain();
  }
  // 頭（Claude Code）を先に起動しておく。止まっていると、呼びかけてすぐの返事が数秒遅れる。
  // サーバーは使われない時間が続くと頭を止めるので、待受中はときどき知らせて、起動したままにしてもらう
  function warmBrain() { fetch("/api/brain/warmup", { method: "POST" }).catch(() => {}); }
  setInterval(() => { if (standbyOn && isLocal() && !conversation) warmBrain(); }, 5 * 60 * 1000);
  // 声の種類・速さは、会話中に変えても次の文から変わる（会話を終えて呼び直さなくてよい）
  ui.vvSpeaker.onchange = () => { store.set("vvSpeaker", Number(ui.vvSpeaker.value)); conversation?.setVoice?.({ speaker: Number(ui.vvSpeaker.value) }); updateCredit(); warmupVoice(); };
  ui.vvSpeed.onchange = () => warmupVoice();   // 速さが変わったら、決まった言葉を合成し直して覚える
  ui.vvMood.onchange = () => { store.set("vvMood", ui.vvMood.checked); conversation?.setVoice?.({ moods: ui.vvMood.checked }); };
  ui.vvSpeed.oninput = () => { ui.vvSpeedVal.textContent = Number(ui.vvSpeed.value).toFixed(2); store.set("vvSpeed", Number(ui.vvSpeed.value)); conversation?.setVoice?.({ speed: Number(ui.vvSpeed.value) }); };
  // 声の大きさ（iPad などは、マイクを使っている間スピーカーの音が小さくなるので、最初から大きめにする）
  const IS_IOS = /iPad|iPhone/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  function vvVolume() { return Number(ui.vvVolume.value) || 1; }
  ui.vvVolume.oninput = () => { ui.vvVolumeVal.textContent = vvVolume().toFixed(2); store.set("vvVolume", vvVolume()); conversation?.setVolume?.(vvVolume()); };
  ui.btnVvTest.onclick = async () => {
    try { await LocalVoice.preview("はい、お呼びでしょうか。本日もよろしくお願いいたします。", Number(ui.vvSpeaker.value), Number(ui.vvSpeed.value), vvVolume()); }
    catch (e) { note(e.message); }
  };

  // ---------- ボタン ----------
  ui.btnStandby.onclick = () => {
    standbyOn = !standbyOn;
    refreshButtons();
    if (standbyOn) { sys(`待受中です。「${wakeList()[0] || AI_NAME}」と呼びかけてください。`); startRecognition(); warmupVoice(); }
    else { stopRecognition(); ui.heard.innerHTML = "&nbsp;"; sys("待受をオフにしました。"); }
  };
  ui.btnTalk.onclick = () => startConversation();
  ui.btnEnd.onclick = () => endConversation();
  window.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || e.isComposing) return;
    if (AmaneSettings.isOpen()) return;   // 設定を開いているときの Space・Esc は、設定の画面で使う
    // ボタン（確認のボタンなど）にフォーカスがあるときの Space は、そのボタンを押すのに使う
    if (e.code === "Space" && e.target.tagName !== "BUTTON") { e.preventDefault(); conversation ? endConversation() : startConversation(); }
    if (e.code === "Escape") endConversation();
  });
  // 画面をタップ（クリック）したら、止まっている音の処理を全部動かす。iPad の Safari は、タップしないと音の処理を
  // 始めさせてくれないことがある（タップと数えるのは touchend / click。pointerdown はタッチでは数えない）
  function unlockAudio() {
    for (const c of [micCtx, vad?.ctx, conversation?.ctx, conversation?.vad?.ctx]) {
      if (c && c.state !== "running" && c.state !== "closed") c.resume().catch(() => {});
    }
  }
  for (const ev of ["touchend", "click"]) document.addEventListener(ev, unlockAudio, true);

  // ---------- 起動 ----------
  (async () => {
    try { Orb.init(ui.canvas); orbOk = true; } catch (e) { console.error(e); sys("WebGL を初期化できませんでした: " + e.message); }
    try { serverCfg = await (await fetch("/api/config")).json(); } catch {}
    if (serverCfg.aiName) AI_NAME = serverCfg.aiName;
    AmaneRec.setName(AI_NAME);
    // AI の設定（名前・性格・ルール）。保存したら、会話ログや字幕の名前も変える
    AmanePersona.init((p) => { AI_NAME = p.aiName || AI_NAME; AmaneRec.setName(AI_NAME); });
    loadSettings();
    sys(`「待受をオン」を押して、「${wakeList()[0] || AI_NAME}」と呼びかけてください。`);
    initRecognition();
    refreshButtons();
    audioLoop();
    pollTasks();
    AmanePlugins.connect({ onSay: onPluginSay });
    refreshSubscription();
    if (ui.autoStandby.checked && (recog || useWhisper())) {
      standbyOn = true; refreshButtons(); startRecognition(); warmupVoice();
      sys("待受中です。音声を再生するため、最初に画面を一度クリックしてください。");
    }
  })();
})();
