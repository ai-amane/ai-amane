// 声の会話の API（lib/voice-routes.js）のテスト
//  頭・声の合成・音声認識サーバーは偽物に差し替えて、API の振り分けと受け渡しを確かめる
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createVoiceRoutes } = require("../lib/voice-routes");

// 偽物の音声認識サーバー（受け取った要求を覚えて返す）
async function fakeStt() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, type: req.headers["content-type"], bytes: Buffer.concat(chunks).length });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(req.url === "/health" ? { ok: true } : { text: "こんにちは", ms: 5 }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

async function setup(sttUrl) {
  const calls = [];
  const brain = {
    addClient: (req, res) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(": ok\n\n"); },
    warm: () => calls.push(["warm"]), stop: () => calls.push(["stop"]),
    say: (text, turn) => calls.push(["say", text, turn]), interrupt: (turn) => calls.push(["interrupt", turn]),
  };
  const tts = {
    health: async () => ({ ok: true, version: "1" }), speakers: async () => [{ id: 1, name: "声" }],
    warmup: async (o) => ({ ok: true, got: o }), synthesize: async ({ text }) => Buffer.from("WAV:" + text),
  };
  const logged = [];
  const route = createVoiceRoutes({ brain, tts, sttUrl, detectWake: async (text, words) => ({ hit: text.startsWith(words[0]) }), appendLog: (f, o) => logged.push([f, o]) });
  const server = http.createServer(async (req, res) => {
    if (!(await route(req, res, new URL(req.url, "http://x")))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, type = "application/json") => fetch(base + p, { method: "POST", headers: { "Content-Type": type }, body: typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  return { base, post, calls, logged, close: () => server.close() };
}

test("頭の API: 発言・中断・やり直し・準備を頭に渡す（空の発言は 400）", async () => {
  const s = await setup("http://127.0.0.1:1");
  try {
    assert.equal((await s.post("/api/brain/say", { text: "" })).status, 400);
    assert.equal((await s.post("/api/brain/say", { text: "天気は", turn: "t1" })).status, 200);
    await s.post("/api/brain/interrupt", { turn: "t1" });
    await s.post("/api/brain/interrupt", {});
    await s.post("/api/brain/warmup", {});
    await s.post("/api/brain/reset", {});
    assert.deepEqual(s.calls, [["say", "天気は", "t1"], ["interrupt", "t1"], ["interrupt", ""], ["warm"], ["stop"]]);
    assert.equal((await fetch(s.base + "/api/brain/events")).headers.get("content-type"), "text/event-stream");
    // 合わないメソッドは扱わない（画面の配信に回る）
    assert.equal((await fetch(s.base + "/api/brain/say")).status, 404);
  } finally { s.close(); }
});

test("呼びかけの判定と、声の合成の API", async () => {
  const s = await setup("http://127.0.0.1:1");
  try {
    assert.deepEqual(await (await s.post("/api/wake", { text: "あまね、天気", words: ["あまね", 1] })).json(), { hit: true });
    assert.deepEqual(await (await fetch(s.base + "/api/tts/health")).json(), { ok: true, version: "1" });
    assert.deepEqual(await (await fetch(s.base + "/api/tts/speakers")).json(), [{ id: 1, name: "声" }]);
    const w = await (await s.post("/api/tts/warmup", { speaker: 3, phrases: "文字列" })).json();
    assert.deepEqual(w.got, { speaker: 3, speed: 1.15, phrases: [] });   // phrases が配列でなければ使わない
    assert.equal((await s.post("/api/tts", { text: "" })).status, 400);
    const r = await s.post("/api/tts", { text: "はい" });
    assert.equal(r.headers.get("content-type"), "audio/wav");
    assert.equal(Buffer.from(await r.arrayBuffer()).toString(), "WAV:はい");
  } finally { s.close(); }
});

test("音声認識の API: WAV のまま音声認識サーバーに取り次ぐ。つながらなければ 502", async () => {
  const stt = await fakeStt();
  const s = await setup(stt.url);
  try {
    assert.deepEqual(await (await fetch(s.base + "/api/stt/health")).json(), { ok: true });
    const r = await s.post("/api/stt?mode=talk", Buffer.alloc(100), "audio/wav");
    assert.deepEqual(await r.json(), { text: "こんにちは", ms: 5 });
    await fetch(s.base + "/api/stt/voiceprints");
    await s.post("/api/stt/session/end?session=abc", "", "audio/wav");
    assert.deepEqual(stt.seen.map((x) => [x.method, x.url, x.type, x.bytes]), [
      ["GET", "/health", undefined, 0],
      ["POST", "/transcribe?mode=talk", "audio/wav", 100],
      ["GET", "/voiceprints", undefined, 0],
      ["POST", "/session/end?session=abc", "audio/wav", 0],
    ]);
  } finally { s.close(); stt.close(); }
  const down = await setup("http://127.0.0.1:1");
  try {
    assert.equal((await down.post("/api/stt", Buffer.alloc(10), "audio/wav")).status, 502);
    assert.equal((await (await fetch(down.base + "/api/stt/health")).json()).ok, false);
  } finally { down.close(); }
});

test("返事までの時間の記録: 数値だけを logs/timing.jsonl に書く", async () => {
  const s = await setup("http://127.0.0.1:1");
  try {
    await s.post("/api/timing", { total: 3400.4, evil: "<x>", from: "talk" });
    assert.deepEqual(s.logged, [["timing.jsonl", { total: 3400, cold: false, from: "talk", chars: 0 }]]);
  } finally { s.close(); }
});
