// 声の会話の API（呼びかけの判定・頭・音声認識・声の合成・応答の速さの記録）
const { sendJson, readBody, readRaw, routeTable } = require("./http-util");

const STT_DOWN = "音声認識サーバーに接続できません（音声認識サーバーが起動中か、start.bat の [stt] の表示を確認してください）";
// 応答の速さの記録（画面が測って送る。logs/timing.jsonl）に残す項目。どれも ms
const TIMING_KEYS = ["hang", "stt", "sttServer", "hold", "brainFirst", "brainServer", "firstSentence", "synth", "wait", "total", "fillerAt"];

// 届いた記録から、決まった項目の数値だけを残す（ログに変なものを書かせない。測れなかった値（null など）は 0 にしない）
function cleanTiming(body) {
  const nums = Object.fromEntries(TIMING_KEYS
    .map((k) => [k, typeof body[k] === "number" ? body[k] : Number.NaN])
    .filter(([, v]) => Number.isFinite(v) && v >= 0 && v < 600000)
    .map(([k, v]) => [k, Math.round(v)]));
  return { ...nums, cold: body.cold === true, from: body.from === "wake" ? "wake" : "talk", chars: Math.min(Math.max(Number(body.chars) || 0, 0), 10000) };
}

function createVoiceRoutes({ brain, tts, sttUrl, detectWake, appendLog }) {
  // 音声認識サーバーへの取り次ぎ（音声は WAV のまま渡す）
  const toStt = (pathOf, method) => async (req, res, url) => {
    try {
      const target = sttUrl + pathOf(url);
      const r = method === "POST" ? await fetch(target, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: await readRaw(req) }) : await fetch(target);
      sendJson(res, r.status, await r.json());
    } catch { sendJson(res, 502, { error: STT_DOWN }); }
  };
  const sameStt = (url) => url.pathname.replace("/api/stt", "") + url.search;
  const ok = (res) => sendJson(res, 200, { ok: true });

  return routeTable([
    ["POST", "/api/wake", async (req, res) => {
      const { text = "", words = [] } = await readBody(req);
      const list = (Array.isArray(words) ? words : []).map(String).filter(Boolean).slice(0, 20);
      sendJson(res, 200, await detectWake(String(text).slice(0, 200), list));
    }],

    // --- 頭（lib/brain.js） ---
    ["*", "/api/brain/events", (req, res) => brain.addClient(req, res)],
    ["POST", "/api/brain/warmup", (req, res) => { brain.warm(); ok(res); }],
    ["POST", "/api/brain/say", async (req, res) => {
      const { text, turn = "" } = await readBody(req);
      if (!text) return sendJson(res, 400, { error: "text が空です" });
      brain.say(String(text), String(turn).slice(0, 64));
      ok(res);
    }],
    ["POST", "/api/brain/interrupt", async (req, res) => {
      const { turn } = await readBody(req);
      brain.interrupt(turn ? String(turn) : "");
      ok(res);
    }],
    ["POST", "/api/brain/reset", (req, res) => { brain.stop(); ok(res); }],

    // --- 音声認識（stt/stt_server.py） ---
    ["*", "/api/stt/health", async (req, res) => {
      try { sendJson(res, 200, await (await fetch(sttUrl + "/health")).json()); }
      catch { sendJson(res, 200, { ok: false, error: `${sttUrl} に接続できません（音声認識サーバーが起動中か、start.bat の [stt] の表示を確認してください）` }); }
    }],
    ["POST", "/api/stt", toStt((url) => "/transcribe" + url.search, "POST")],
    // 声紋の一覧・登録・削除（登録した人の声だけを会話で聞く。stt/speaker.py）
    ["GET", "/api/stt/voiceprints", toStt(sameStt, "GET")],
    ["POST", "/api/stt/enroll", toStt(sameStt, "POST")],
    ["POST", "/api/stt/voiceprints/delete", toStt(sameStt, "POST")],
    // 会話の主（呼びかけた人の声）: 会話の開始・終了と、話し始めの声が主かの照合
    ["POST", "/api/stt/session/start", toStt(sameStt, "POST")],
    ["POST", "/api/stt/session/end", toStt(sameStt, "POST")],
    ["POST", "/api/stt/speaker-check", toStt(sameStt, "POST")],

    // --- 声の合成（VOICEVOX / AivisSpeech。lib/tts.js） ---
    ["*", "/api/tts/health", async (req, res) => sendJson(res, 200, await tts.health())],
    // 話者の準備（モデルの読み込み）と、決まった言葉（あいさつ・つなぎの言葉）の先読み。待受を始めたときや声を選んだときに呼ぶ
    ["POST", "/api/tts/warmup", async (req, res) => {
      const { speaker = 2, speed = 1.15, phrases = [] } = await readBody(req);
      try { sendJson(res, 200, await tts.warmup({ speaker, speed, phrases: Array.isArray(phrases) ? phrases : [] })); }
      catch (e) { sendJson(res, 200, { ok: false, error: e.message }); }
    }],
    ["*", "/api/tts/speakers", async (req, res) => sendJson(res, 200, await tts.speakers())],
    ["POST", "/api/tts", async (req, res) => {
      const { text, speaker = 2, speed = 1.15, pitch = 0, intonation = 1 } = await readBody(req);
      if (!text) return sendJson(res, 400, { error: "text が空です" });
      const buf = await tts.synthesize({ text, speaker, speed, pitch, intonation });
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": buf.length, "Cache-Control": "no-store" });
      res.end(buf);
    }],

    // --- 応答の速さの記録 ---
    ["POST", "/api/timing", async (req, res) => {
      appendLog("timing.jsonl", cleanTiming(await readBody(req, 10000)));
      ok(res);
    }],
  ]);
}

module.exports = { createVoiceRoutes, cleanTiming };
