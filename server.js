// AI あまね ローカルサーバー（Node.js 18+ / 任意で kuromoji）
//  - public/ を http://localhost:PORT で配信（iPad などからは LAN_ACCESS=1 で https。lib/lan-server.js）
//  - ElevenLabs: 署名付きURL発行・使用量（クレジット）取得
//  - 声の会話（VOICEVOX / AivisSpeech モード）: 頭（lib/brain.js）・音声認識・声の合成の API（lib/voice-routes.js）
//  - 資料のパネル: 作業フォルダのファイル・Web ページ・画像の中継（lib/display-routes.js）
//  - 作業の委任: Codex CLI / Claude Code CLI をバックグラウンドで起動して結果を返す（lib/tasks.js）
const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { IS_WIN, IS_MAC } = require("./lib/proc");
const { sendJson, readBody, crossSiteApi, routeTable } = require("./lib/http-util");
const { startLanServer, LOCAL_ONLY } = require("./lib/lan-server");
const { createBrain } = require("./lib/brain");
const { createTts } = require("./lib/tts");
const { moodPrompt } = require("./lib/moods");
const { detectWake, getTokenizer } = require("./lib/wake");
const { createRouter } = require("./lib/task-router");
const { createTaskRunner, engineLabel } = require("./lib/tasks");
const { createCompanions } = require("./lib/companions");
const { createVoiceRoutes } = require("./lib/voice-routes");
const { createDisplayRoutes } = require("./lib/display-routes");
const { createPlugins } = require("./lib/plugins");
const { createPersona } = require("./lib/persona");

// ---------- .env ----------
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const v = m[2].replace(/^["']|["']$/g, "");
    if (v === "") continue;   // 空の値は未設定として扱う（子プロセスにも空の値を渡さない）
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
const env = (k, d = "") => (process.env[k] ?? "") !== "" ? process.env[k] : d;

const PORT = Number(env("PORT", 3939));
const AGENT_ID = env("ELEVENLABS_AGENT_ID");
const API_KEY = env("ELEVENLABS_API_KEY");
const PUBLIC_DIR = path.join(__dirname, "public");
const LOG_DIR = path.join(__dirname, "logs");
const WORKDIR = path.resolve(env("TASK_WORKDIR", path.join(__dirname, "workspace")));
const LIGHT_ENGINE = env("LIGHT_ENGINE", "claude-sonnet");   // Codex を入れたら codex-fast にすると速い
const HEAVY_ENGINE = env("HEAVY_ENGINE", "claude-opus");
const ROUTER = env("ROUTER", "auto"); // auto | laya | hint | rules
// 家の Wi-Fi の iPad などから使う（https://この PC の IP アドレス:LAN_PORT。lib/lan-server.js）
const LAN_ACCESS = env("LAN_ACCESS", "0") === "1";
const LAN_PORT = Number(env("LAN_PORT", 3942));
const LAN_DIR = path.join(__dirname, "data", "lan");
// 画面に表示してよいフォルダ（作業フォルダ + .env の SHOW_DIRS をセミコロン区切りで）
const SHOW_DIRS = [WORKDIR, ...env("SHOW_DIRS").split(";").map((d) => d.trim()).filter(Boolean).map((d) => path.resolve(d))];
// 声の合成のエンジン。既定は AivisSpeech（感情豊か。ポート 10101）。VOICEVOX は 50021
const VOICEVOX_URL = env("VOICEVOX_URL", "http://127.0.0.1:10101");
// AivisSpeech（VOICEVOX と同じ使い方の、感情豊かな音声合成。既定のポートは 10101）を使っているか。名前は表示とエラーに使う
const IS_AIVIS = env("TTS_ENGINE", /:10101(\/|$)/.test(VOICEVOX_URL) ? "aivisspeech" : "voicevox").toLowerCase() === "aivisspeech";
const TTS_NAME = IS_AIVIS ? "AivisSpeech" : "VOICEVOX";
const STT_URL = env("STT_URL", "http://127.0.0.1:3941");

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(WORKDIR, { recursive: true });

// ログ（logs/*.jsonl）に 1 行足す。大きくなりすぎたら .1 に移して、新しく始める
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const rotating = new Set();   // 切り替え中のログ（同時に 2 回切り替えて、.1 を上書きしないように）
function appendLog(file, obj) {
  const fp = path.join(LOG_DIR, file);
  const line = JSON.stringify({ at: new Date().toISOString(), ...obj }) + "\n";
  fs.stat(fp, (err, st) => {
    const append = () => fs.appendFile(fp, line, () => {});
    if (err || st.size <= LOG_MAX_BYTES || rotating.has(fp)) return append();
    rotating.add(fp);
    fs.rename(fp, fp + ".1", () => { rotating.delete(fp); append(); });
  });
}
async function elevenlabs(pathname) {
  const r = await fetch("https://api.elevenlabs.io" + pathname, { headers: { "xi-api-key": API_KEY } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body?.detail?.message || JSON.stringify(body?.detail || body) || `HTTP ${r.status}`), { status: r.status });
  return body;
}

// ---------- 部品 ----------
getTokenizer();   // 呼びかけの判定に使う辞書を先に読み込む
const CONFIRM_BLOCK_AFTER_TASK_MS = 2 * 60 * 1000;
// 追加機能（plugins/<名前>/plugin.js）。.env の PLUGINS_OFF（カンマ区切り）で止められる
const plugins = createPlugins({
  dir: path.join(__dirname, "plugins"), dataDir: path.join(__dirname, "data", "plugins"), env, appendLog,
  off: env("PLUGINS_OFF").split(/[,\s]+/).filter(Boolean),
  // 追加機能の使い方が変わった（機器の一覧を読み込んだ、など）→ 頭を起動し直して新しい説明を渡す（会話の切れ目で）
  onPromptChange: () => brain.refresh(),
  // 作業担当（この PC のプログラム）が動いている間と、終わってから少しの間は、画面で確認する動作（鍵を開けるなど）を断る。
  // だまされた作業担当が、画面のボタンを押したのと同じ要求をサーバーに送れるため
  blockConfirm: () => (tasks.active(CONFIRM_BLOCK_AFTER_TASK_MS) ? "作業担当が動いている間（終わってから 2 分まで）は、画面で確認する操作はできません。少し待ってから頼んでください" : ""),
});
// AI の設定（名前・話し方・キャラクター・守ること・あなたについて。画面の「AI の設定」で変える。lib/persona.js）
//  保存したら、返答中でなければすぐ頭を起動し直して反映する
//  作業担当が動いている間（終わってから 2 分まで）は保存を断る（だまされた作業担当が、ずっと残るルールを書き込めないように）
const persona = createPersona({
  file: path.join(__dirname, "data", "persona.json"), env, onChange: () => brain.refresh({ soon: true }),
  blockSave: () => (tasks.active(CONFIRM_BLOCK_AFTER_TASK_MS) ? "作業担当が動いている間（終わってから 2 分まで）は、AI の設定を変えられません。少し待ってから保存してください" : ""),
});
const brain = createBrain({
  bin: env("CLAUDE_BIN", "claude"), model: env("BRAIN_MODEL", "sonnet"),
  tools: env("BRAIN_TOOLS", "WebSearch").split(/[,\s]+/).filter(Boolean),
  idleMin: Math.max(1, Number(env("BRAIN_IDLE_MIN", 20)) || 20), thinkingTokens: env("BRAIN_THINKING_TOKENS", "0"), workdir: WORKDIR,
  promptSrc: path.join(__dirname, "prompts", "local-brain-system-prompt.md"), promptFile: path.join(LOG_DIR, "brain-system-prompt.md"),
  // 声の気持ち（[うれしい] などの印）の説明は、AivisSpeech のときだけ付ける（VOICEVOX では使わない。lib/moods.js）
  vars: () => persona.vars(), promptExtra: () => [IS_AIVIS && moodPrompt(), persona.prompt(), plugins.prompt()].filter(Boolean).join("\n\n"),
});
const tts = createTts({ url: VOICEVOX_URL, name: TTS_NAME, isAivis: IS_AIVIS });
const tasks = createTaskRunner({
  env, workdir: WORKDIR, aiName: () => persona.get().aiName, lightEngine: LIGHT_ENGINE, heavyEngine: HEAVY_ENGINE,
  decideLevel: createRouter({ router: ROUTER, layaUrl: env("LAYA_URL", "http://127.0.0.1:3940"), minConfidence: Number(env("LAYA_MIN_CONFIDENCE", 0.6)) }),
  maxParallel: Number(env("MAX_PARALLEL_TASKS", 2)), timeoutSec: Number(env("TASK_TIMEOUT_SEC", 900)), appendLog,
});
const companions = createCompanions({ env, rootDir: __dirname, sttUrl: STT_URL, ttsUrl: VOICEVOX_URL, ttsName: TTS_NAME, isAivis: IS_AIVIS });
const voiceRoutes = createVoiceRoutes({ brain, tts, sttUrl: STT_URL, detectWake, appendLog });
const displayRoutes = createDisplayRoutes({ showDirs: SHOW_DIRS });

// ---------- 外部の Web ページからの悪用を防ぐ ----------
// ・Host ヘッダーが localhost 以外なら拒否（DNS リバインディング対策）
// ・状態を変える API（POST）は、この画面からの呼び出しにだけ付く X-Amane ヘッダーと、
//   localhost の Origin を必須にする（ほかのサイトを開いているときに勝手に作業を実行されるのを防ぐ）
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));
function guard(req) {
  if (!ALLOWED_HOSTS.has(String(req.headers.host || "").toLowerCase())) return "Host が許可されていません";
  const origin = req.headers.origin;
  if (origin && origin !== "null" && !ALLOWED_ORIGINS.has(origin)) return "Origin が許可されていません";
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (req.headers["x-amane"] !== "1") return "X-Amane ヘッダーがありません";
    if (origin === "null") return "Origin が許可されていません";
  }
  return null;
}

let lan = null;   // LAN_ACCESS=1 のときの iPad など向けサーバー（startLan）
let lanError = "";

// ---------- そのほかの API（サーバーの管理・LAN・設定・ElevenLabs・作業） ----------
const otherRoutes = routeTable([
  // 新しく起動したサーバーが古いサーバーを止めるために使う
  ["POST", "/api/shutdown", (req, res) => {
    sendJson(res, 200, { ok: true });
    console.log("\n  新しいサーバーが起動したので、このサーバーは終了します。");
    setTimeout(() => { cleanupAll(); process.exit(0); }, 100);
  }],

  // --- iPad などからの接続（LAN） ---
  // configured: .env で有効にしているか（起動中・起動に失敗したときも、画面に様子を出すため）
  ["*", "/api/lan/status", (req, res) => sendJson(res, 200, lan ? lan.status() : { enabled: false, configured: LAN_ACCESS, error: lanError })],
  ["POST", "/api/lan/code", (req, res) => {
    if (!lan) return sendJson(res, 400, { error: LAN_ACCESS ? `iPad などからの接続は、まだ使えません（${lanError || "準備中です"}）` : "iPad などからの接続は無効です（.env に LAN_ACCESS=1 を書いて起動し直してください）" });
    sendJson(res, 200, lan.issueCode());
  }],
  ["POST", "/api/lan/revoke", (req, res) => {
    if (lan) { lan.revokeAll(); console.log("[lan] つないでいた端末をすべて解除しました"); }
    sendJson(res, 200, { ok: true });
  }],

  ["*", "/api/config", (req, res) => sendJson(res, 200, {
    aiName: persona.get().aiName, agentId: AGENT_ID, signedUrlAvailable: Boolean(API_KEY), usageAvailable: Boolean(API_KEY),
    voicevoxUrl: VOICEVOX_URL, ttsName: TTS_NAME, brainModel: brain.model,
    workdir: WORKDIR, lightEngine: engineLabel(LIGHT_ENGINE), heavyEngine: engineLabel(HEAVY_ENGINE), router: ROUTER,
  })],

  // --- ElevenLabs ---
  ["*", "/api/signed-url", async (req, res, url) => {
    const agentId = url.searchParams.get("agentId") || AGENT_ID;
    if (!API_KEY) return sendJson(res, 400, { error: "ELEVENLABS_API_KEY が .env に設定されていません" });
    if (!agentId) return sendJson(res, 400, { error: "Agent ID がありません" });
    const body = await elevenlabs(`/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`);
    sendJson(res, 200, { signedUrl: body.signed_url });
  }],
  ["*", "/api/usage/subscription", async (req, res) => {
    if (!API_KEY) return sendJson(res, 400, { error: "APIキー未設定" });
    const s = await elevenlabs("/v1/user/subscription");
    sendJson(res, 200, { tier: s.tier, used: s.character_count, limit: s.character_limit, resetAt: s.next_character_count_reset_unix });
  }],

  // --- 作業（lib/tasks.js） ---
  ["POST", "/api/tasks", async (req, res) => {
    const body = await readBody(req);
    const task = String(body.task || "").trim();
    if (!task) return sendJson(res, 400, { error: "task が空です" });
    sendJson(res, 200, await tasks.start({ task, level: body.level, engine: body.engine }));
  }],
  ["GET", "/api/tasks", (req, res) => sendJson(res, 200, tasks.list())],
]);

// パスに番号などが入る API
async function sendConversationUsage(res, id) {
  if (!API_KEY) return sendJson(res, 400, { error: "APIキー未設定" });
  const c = await elevenlabs(`/v1/convai/conversations/${id}`);
  const out = {
    status: c.status, durationSec: c.metadata?.call_duration_secs, credits: c.metadata?.cost,
    costFiat: c.metadata?.cost_fiat, llmCharge: c.metadata?.charging?.llm_charge, callCharge: c.metadata?.charging?.call_charge,
  };
  if (c.status === "done") appendLog("usage.jsonl", { conversationId: id, ...out });
  return sendJson(res, 200, out);
}
async function patternRoutes(req, res, p) {
  const mConv = p.match(/^\/api\/usage\/conversation\/([\w-]+)$/);
  if (mConv) { await sendConversationUsage(res, mConv[1]); return true; }
  const mCancel = p.match(/^\/api\/tasks\/(\d+)\/cancel$/);
  if (mCancel && req.method === "POST") {
    const t = tasks.cancel(mCancel[1]);
    if (t) sendJson(res, 200, t); else sendJson(res, 404, { error: "not found" });
    return true;
  }
  return false;
}

// ---------- 画面と API ----------
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
};
// 画面の CSP: ほかのサイトに埋め込ませない。資料のパネルに埋め込めるのは https のページだけ（転送された先も含めてブラウザが確かめる。
// 家の機器の管理画面の多くは http）。画像・動画はこのサーバーのものだけ（ほかのサイトの画像は /api/web/image で中継する）
const PAGE_CSP = "frame-ancestors 'none'; frame-src 'self' https:; img-src 'self' data: blob:; media-src 'self' blob: data:";
function sendStatic(res, p) {
  let fp;
  try { fp = decodeURIComponent(p); } catch { res.writeHead(400); return res.end(); }
  if (fp === "/") fp = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, fp));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": PAGE_CSP, "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    });
    res.end(data);
  });
}

// from: "local"（この PC の画面）| "lan"（ペアリングした iPad など。lib/lan-server.js が確認済み）
async function handle(req, res, from) {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host}`); } catch { res.writeHead(400); return res.end(); }
  const p = url.pathname;
  try {
    // サーバーの終了と、iPad などのペアリングの管理は、この PC の画面からだけ
    if (from !== "local" && LOCAL_ONLY.test(p)) return sendJson(res, 403, { error: "この操作は PC の画面からだけできます" });
    if (crossSiteApi(req, p)) return sendJson(res, 403, { error: "ほかのサイトからは使えません" });
    req.amaneFrom = from;   // 追加機能の「PC の画面からだけ」の動作の判定に使う（lib/plugins.js）
    for (const route of [otherRoutes, voiceRoutes, displayRoutes, plugins.routes, persona.routes]) if (await route(req, res, url)) return;
    if (await patternRoutes(req, res, p)) return;
  } catch (e) {
    console.error(`[api] ${p} failed:`, e.message);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message });
    else res.end();
    return;
  }
  sendStatic(res, p);
}

const server = http.createServer((req, res) => {
  const denied = guard(req);
  if (denied) { res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Forbidden: " + denied); }
  handle(req, res, "local");
});

// iPad など向けの HTTPS サーバーを起動する（失敗しても、この PC の画面はそのまま使える）
// Wi-Fi などにつながる前（PC の起動直後など）なら、つながるまで LAN_RETRY_MS ごとに試す
const LAN_RETRY_MS = 30 * 1000;
async function startLan() {
  try {
    lan = await startLanServer({ port: LAN_PORT, dataDir: LAN_DIR, publicDir: PUBLIC_DIR, handle });
    lanError = "";
    console.log(`  iPad などから:      ${lan.urls[0]}（つなぎ方: 画面の「設定」→「iPad・スマホ」）`);
    for (const w of lan.status().warnings) console.warn("  [lan] " + w);
  } catch (e) {
    const why = e.code === "EADDRINUSE" ? `ポート ${LAN_PORT} を別のプログラムが使っています。.env の LAN_PORT を変えてください` : e.message;
    if (why !== lanError) console.warn(`  iPad などから:      起動できませんでした（${why}）`);
    lanError = why;
    if (e.code === "ENOLANIP") setTimeout(startLan, LAN_RETRY_MS);
  }
}

// この PC の画面は localhost のみで待ち受け（外部からはアクセス不可）。iPad などからは startLan の HTTPS サーバーを使う
// すでに起動中なら古いほうを止めて入れ替わる（コード更新後の再起動を楽にするため）
let listenRetries = 0;
server.on("error", async (e) => {
  if (e.code !== "EADDRINUSE" || listenRetries >= 5) {
    console.error(e.code === "EADDRINUSE"
      ? `\n  ポート ${PORT} を別のプログラムが使っています。前に開いた AI あまね のウィンドウを閉じるか、.env の PORT を変えてください。\n`
      : e);
    process.exit(1);
  }
  listenRetries++;
  if (listenRetries === 1) {
    console.log(`  ポート ${PORT} で前の AI あまね が動いているので、止めて入れ替わります…`);
    try { await fetch(`http://127.0.0.1:${PORT}/api/shutdown`, { method: "POST", headers: { "X-Amane": "1" } }); } catch { /* もう止まっている */ }
  }
  setTimeout(() => server.listen(PORT, "127.0.0.1"), 800);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("");
  console.log(`  AI AMANE is running: http://localhost:${PORT}`);
  console.log(`  Agent ID (.env):    ${AGENT_ID || "(not set - enter it in the UI)"}`);
  console.log(`  Private agent mode: ${API_KEY ? "ON (signed URL)" : "OFF (public agent)"}`);
  console.log(`  Task workdir:       ${WORKDIR}`);
  console.log(`  Engines:            light=${LIGHT_ENGINE}  heavy=${HEAVY_ENGINE}  router=${ROUTER}`);
  console.log("  Close this window to stop.");
  console.log("");
  plugins.start();
  // 前のサーバーと入れ替わった直後は、前の音声認識サーバー・LAN のポートが空くのを少し待つ
  setTimeout(() => { companions.startStt(); companions.startTts(); if (LAN_ACCESS) startLan(); }, listenRetries ? 2500 : 0);
  if (env("OPEN_BROWSER", "1") !== "0") {
    if (IS_WIN) exec(`start "" http://localhost:${PORT}`);
    // Mac は動作確認している Chrome で開く。無ければ既定のブラウザ
    else if (IS_MAC) exec(`open -a "Google Chrome" http://localhost:${PORT}`, (e) => e && exec(`open http://localhost:${PORT}`));
  }
});

let cleaned = false;
function cleanupAll() {
  if (cleaned) return;   // Ctrl+C のあとの exit でもう一度呼ばれる
  cleaned = true;
  tasks.killAll();
  brain.killSync();
  companions.stopAll();
  plugins.stop();
}
process.on("exit", cleanupAll);
// ウィンドウを閉じた（SIGHUP）・Ctrl+C（SIGINT）でも、一緒に起動したプログラムを止める
for (const sig of ["SIGINT", "SIGHUP", "SIGTERM", "SIGBREAK"]) process.on(sig, () => { cleanupAll(); process.exit(0); });
