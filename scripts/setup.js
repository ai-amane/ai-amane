// かんたんセットアップの残りの段（setup-windows.ps1 / setup.command から呼ばれる。node scripts/setup.js で単体でも動く）
//  .env → Node のパッケージ → 音声認識の Python のパッケージ → Claude のログイン → AivisSpeech → 声の確認 → 起動
//  --check: 調べるだけ（何も入れない・書かない・起動しない・鳴らさない）  --no-play: 声を作るが鳴らさない
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const readline = require("readline");
const { spawn, spawnSync } = require("child_process");
const { ttsCandidates } = require("../lib/companions");

const DEFAULT_PORT = 3939;
const AIVIS_URL = "http://127.0.0.1:10101";
const EXIT_START_HERE = 10;   // Mac: この窓でそのまま あまね を起動してほしい（setup.command が start.command に切り替える）
const AIVIS_SITE = "https://aivis-project.com/";
const WAIT_MAX_MS = 20 * 60 * 1000;
const WAIT_STEP_MS = 5000;
const TEST_TEXT = "はじめまして、あまね です。この声が聞こえていれば、準備はできています。";
const PAID_PLANS = /^(pro|max|team|enterprise)/i;

// ---------- 純粋な関数 ----------

// "3 12" や "Python 3.12.4" から { major, minor } を読む。読めなければ null
function parsePythonVersion(out) {
  const m = String(out ?? "").match(/(\d+)[ .](\d+)/);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}
// ok（3.10〜3.12）| too-new（3.13 以上）| too-old | none
function pythonVerdict(v) {
  if (!v || v.major !== 3) return v && v.major > 3 ? "too-new" : v ? "too-old" : "none";
  if (v.minor > 12) return "too-new";
  return v.minor >= 10 ? "ok" : "too-old";
}
// Node の版（v22.1.0）が 18 以上か
function nodeVersionOk(s) {
  const m = String(s ?? "").match(/^v?(\d+)\./);
  return !!m && Number(m[1]) >= 18;
}

// .env.example から新しい .env の中身を作る。USER_NAME と VOICEVOX_AUTOSTART の値だけ変え、他の行は一切変えない
function buildEnv(example, { userName = "", aivis = false } = {}) {
  const name = String(userName).replace(/[\r\n]/g, " ").trim();
  let out = String(example);
  if (name) out = out.replace(/^USER_NAME=[^\r\n]*/m, () => `USER_NAME=${name}`);
  if (aivis) out = out.replace(/^VOICEVOX_AUTOSTART=[^\r\n]*/m, () => "VOICEVOX_AUTOSTART=1");
  return out;
}
// .env の 1 つの値（server.js と同じ読み方: コメント行・空の値は無いものとする）
function readEnvValue(text, key) {
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] !== key) continue;
    const v = m[2].replace(/^["']|["']$/g, "");
    if (v !== "") return v;
  }
  return undefined;
}
function parsePort(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_PORT;
}
// `claude auth status --json` の読み取り（壊れた JSON でも落ちない）
function parseClaudeStatus(text) {
  let j = null;
  try { j = JSON.parse(String(text ?? "").trim()); } catch { /* 読めない */ }
  if (!j || typeof j !== "object") return { loggedIn: false, subscriptionType: null, valid: false };
  const sub = typeof j.subscriptionType === "string" ? j.subscriptionType.trim().toLowerCase() : null;
  return { loggedIn: j.loggedIn === true, subscriptionType: sub || null, valid: true };
}
// 有料プランか。分からない（null）ときは、注意を出さないよう true
function isPaidPlan(sub) { return sub == null || PAID_PLANS.test(sub); }
// /speakers から最初の声の最初のスタイルを選ぶ。無ければ null
function pickVoice(speakers) {
  if (!Array.isArray(speakers)) return null;
  for (const sp of speakers) {
    const st = Array.isArray(sp?.styles) ? sp.styles.find((s) => Number.isSafeInteger(s?.id)) : null;
    if (st) return { id: st.id, name: String(sp.name ?? ""), style: String(st.name ?? "") };
  }
  return null;
}
const isMac = (d) => d.platform === "darwin";
const againName = (d) => (isMac(d) ? "setup.command" : "setup.bat");
// AivisSpeech の run（.app の中）から、アプリ本体の場所を取り出す。.app の中でなければ null
function appBundleOf(exe) {
  const m = String(exe ?? "").match(/^(.*?\.app)(\/|$)/i);
  return m ? m[1] : null;
}
// 引数（--check / --no-play）
function parseArgs(argv) {
  return { check: argv.includes("--check"), noPlay: argv.includes("--no-play") };
}

// ---------- 本物の外とのやりとり（テストでは差し替える） ----------

function realDeps(root) {
  const isTTY = !!process.stdin.isTTY;
  return {
    root, env: process.env, isTTY, platform: process.platform,
    log: (s = "") => console.log(s),
    exists: (p) => fs.existsSync(p),
    readText: (p) => fs.readFileSync(p, "utf8"),
    writeText: (p, s) => fs.writeFileSync(p, s, "utf8"),
    removeFile: (p) => { try { fs.rmSync(p, { force: true }); } catch { /* 消せなくてもよい */ } },
    killTree: (pid) => {
      if (process.platform !== "win32") {   // Mac: プロセスのグループごと。だめなら 1 つだけ
        try { process.kill(-pid); } catch { try { process.kill(pid); } catch { /* もう止まっている */ } }
        return;
      }
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    },
    writeBin: (name, buf) => { const p = path.join(os.tmpdir(), name); fs.writeFileSync(p, buf); return p; },
    // 外のコマンド。inherit なら画面につなぐ。args は固定の文字だけ
    exec: (cmd, args, { inherit = false } = {}) => {
      // npm は .cmd なので cmd 経由。ほかは shell なし（Node 24 の shell:true の警告を避ける）。
      //  npm 版の claude のように .cmd だけのものは、見つからないときに cmd 経由でやり直す
      const win = process.platform === "win32";
      const opt = { encoding: "utf8", stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"], windowsHide: !inherit };
      const viaCmd = () => spawnSync("cmd", ["/d", "/s", "/c", cmd, ...args], opt);
      let r = win && cmd === "npm" ? viaCmd() : spawnSync(cmd, args, opt);
      if (win && r.error && r.error.code === "ENOENT" && cmd !== "npm") r = viaCmd();
      return { status: r.error ? -1 : r.status, stdout: r.stdout || "" };
    },
    fetchImpl: fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ask: (q, def = "") => new Promise((resolve) => {
      if (!isTTY) { resolve(def); return; }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(q, (a) => { rl.close(); resolve(a.trim() || def); });
    }),
    play: (file) => process.platform === "darwin"
      ? spawnSync("afplay", [file], { stdio: "ignore" })
      : spawnSync("powershell", ["-NoProfile", "-Command", `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`], { stdio: "ignore", windowsHide: true }),
    spawnEngine: (exe, args) => {
      const isEngine = /^run(\.exe)?$/i.test(path.basename(exe));
      const child = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: isEngine, detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
      return child.pid;
    },
    openUrl: (u) => {
      const c = process.platform === "darwin" ? spawn("open", [u], { detached: true, stdio: "ignore" }) : spawn("cmd", ["/c", "start", "", u], { detached: true, stdio: "ignore", windowsHide: true });
      c.on("error", () => {});
      c.unref();
    },
    // Mac: アプリとして開く（初めて開くときの確認を、Mac の普通の画面で出すため）
    openApp: (app) => { const c = spawn("open", ["-a", app], { detached: true, stdio: "ignore" }); c.on("error", () => {}); c.unref(); },
    startBat: (dir) => { spawn("cmd", ["/c", "start", "", path.join(dir, "start.bat")], { cwd: dir, detached: true, stdio: "ignore", windowsHide: true }).unref(); },
    portInUse: (port) => new Promise((resolve) => {
      const s = net.connect({ port, host: "127.0.0.1" });
      const done = (v) => { s.destroy(); resolve(v); };
      s.setTimeout(1000, () => done(false));
      s.on("connect", () => done(true));
      s.on("error", () => done(false));
    }),
    candidates: () => ttsCandidates({ isAivis: true }),
  };
}

// ---------- 各段 ----------

async function getJson(d, url) {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 3000);
    try { const r = await d.fetchImpl(url, { signal: ctrl.signal }); return r.ok ? await r.json() : null; } finally { clearTimeout(t); }
  } catch { return null; }
}
const speakersOf = async (d) => { const l = await getJson(d, AIVIS_URL + "/speakers"); return Array.isArray(l) && l.length ? l : null; };
const findEngine = (d) => d.candidates().find((c) => d.exists(c));

// (a) .env。すでにあれば絶対に書き換えない
async function stepEnv(d, o, aivisFound) {
  const envPath = path.join(d.root, ".env");
  if (d.exists(envPath)) { d.log(".env: あるので、そのまま使います"); return { created: false }; }
  if (o.check) { d.log(".env: 作る予定です（.env.example をコピーして、呼ばれ方を聞きます）"); return { created: false }; }
  const examplePath = path.join(d.root, ".env.example");
  if (!d.exists(examplePath)) { d.log("[失敗] .env.example が見つかりません。README の 3-7 を見て、手で .env を作ってください。"); return { created: false, failed: true }; }
  const userName = await d.ask("AI からの呼ばれ方を入力してください（例: 田中さん。空のままでも大丈夫です）: ", "");
  d.writeText(envPath, buildEnv(d.readText(examplePath), { userName, aivis: aivisFound }));
  d.log(".env: 作りました");
  return { created: true, userName };
}

// (b) Node のパッケージ（start.bat と同じ判定）
function stepNpm(d, o) {
  const need = ["kuromoji", "linkedom", path.join("@mozilla", "readability")].some((m) => !d.exists(path.join(d.root, "node_modules", m)));
  if (!need) { d.log("Node のパッケージ: すでに入っています"); return true; }
  if (o.check) { d.log("Node のパッケージ: 入れる予定です（npm install）"); return true; }
  d.log("Node のパッケージを入れます…（数分かかることがあります）");
  const r = d.exec("npm", ["install", "--no-audit", "--no-fund"], { inherit: true });
  if (r.status !== 0) { d.log("[失敗] npm install が終わりませんでした。ネットワークを確かめて、もう一度 " + againName(d) + " を押してください。"); return false; }
  d.log("Node のパッケージ: 入れました");
  return true;
}

// (c) Mac: このフォルダの .venv に入れる（start.command と同じ。.env に PYTHON_BIN があれば飛ばす）
function stepPipMac(d, o) {
  const envPath = path.join(d.root, ".env");
  // 確認だけのときは .env を読まない
  if (!o.check && d.exists(envPath) && readEnvValue(d.readText(envPath), "PYTHON_BIN")) {
    d.log("音声認識のパッケージ: .env の PYTHON_BIN を使うので、飛ばします");
    return true;
  }
  const py = ["python3.12", "python3.11", "python3.10"].find((p) => d.exec(p, ["--version"]).status === 0);
  if (!py) { d.log("音声認識のパッケージ: Python 3.10〜3.12 が見つからないので、飛ばします"); return true; }
  const venvDir = path.join(d.root, ".venv");
  const venvPy = path.join(venvDir, "bin", "python");
  if (!d.exists(venvPy)) {
    if (o.check) { d.log(`音声認識のパッケージ: .venv を作って入れる予定です（${py}）`); return true; }
    d.log(`Python の環境（.venv）を作ります（${py}）…`);
    if (d.exec(py, ["-m", "venv", venvDir], { inherit: true }).status !== 0) { d.log("[失敗] .venv を作れませんでした。README の 3-3 を見て Python を確かめてください。"); return false; }
  }
  if (d.exec(venvPy, ["-c", "import sherpa_onnx, huggingface_hub"]).status === 0) { d.log("音声認識のパッケージ: すでに入っています"); return true; }
  if (o.check) { d.log("音声認識のパッケージ: 入れる予定です（pip install）"); return true; }
  d.log("音声認識のパッケージを入れます…（数分かかることがあります）");
  if (d.exec(venvPy, ["-m", "pip", "install", "sherpa-onnx", "huggingface_hub", "numpy"], { inherit: true }).status !== 0) {
    d.log("[失敗] pip install が終わりませんでした。ネットワークを確かめて、もう一度 setup.command を押してください。");
    return false;
  }
  d.log("音声認識のパッケージ: 入れました");
  return true;
}

// (c) 音声認識の Python のパッケージ（start.bat と同じ）
function stepPip(d, o) {
  if (isMac(d)) return stepPipMac(d, o);
  const py = parsePythonVersion(d.exec("python", ["-c", "import sys;print(sys.version_info[0],sys.version_info[1])"]).stdout);
  if (pythonVerdict(py) === "none") { d.log("音声認識のパッケージ: Python が見つからないので、飛ばします"); return true; }
  if (d.exec("python", ["-c", "import sherpa_onnx, huggingface_hub"]).status === 0) { d.log("音声認識のパッケージ: すでに入っています"); return true; }
  if (o.check) { d.log("音声認識のパッケージ: 入れる予定です（pip install）"); return true; }
  d.log("音声認識のパッケージを入れます…（数分かかることがあります）");
  const r = d.exec("python", ["-m", "pip", "install", "sherpa-onnx", "huggingface_hub", "numpy"], { inherit: true });
  if (r.status !== 0) { d.log("[失敗] pip install が終わりませんでした。README の 3-3 を見て Python を確かめてください。"); return false; }
  d.log("音声認識のパッケージ: 入れました");
  return true;
}

// (d) Claude のログイン
function claudeStatus(d) { return parseClaudeStatus(d.exec("claude", ["auth", "status", "--json"]).stdout); }
function warnPlan(d, st) {
  if (!isPaidPlan(st.subscriptionType)) d.log("[注意] Claude の有料プラン（Pro 以上）が必要です。無料のままだと、会話が動きません。");
}
function stepClaude(d, o) {
  let st = claudeStatus(d);
  if (st.loggedIn) { d.log("Claude のログイン: すでにログインしています"); warnPlan(d, st); return true; }
  if (o.check) { d.log("Claude のログイン: ログインする予定です（claude auth login）"); return true; }
  d.log("ブラウザが開くので、Claude のアカウントでログインしてください。");
  d.exec("claude", ["auth", "login"], { inherit: true });
  st = claudeStatus(d);
  if (!st.loggedIn) { d.log("[失敗] ログインを確かめられませんでした。README の 3-4 の手順 3 を見て、claude でログインしてください。"); return false; }
  d.log("Claude のログイン: ログインできました");
  warnPlan(d, st);
  return true;
}

// (e) AivisSpeech。{ found, pid } を返す（pid はこの実行で起動したものだけ）
async function stepAivis(d, o) {
  const alive = async () => (await getJson(d, AIVIS_URL + "/version")) != null;
  let running = await alive();
  let exe = findEngine(d);
  if (!running && !exe) {
    if (o.check) { d.log("AivisSpeech: 入れる予定です（公式のページを開いて案内します）"); return { found: false }; }
    d.log("AivisSpeech が見つかりません。公式のページを開きます。");
    d.openUrl(AIVIS_SITE);
    await d.ask(isMac(d) ? "AivisSpeech の Mac 版を入れて（ダウンロードしたものをアプリケーションに入れて）、一度 AivisSpeech を開いてから Enter を押してください: " : "AivisSpeech の Windows 版を入れて、終わったら Enter を押してください: ", "");
    running = await alive();
    exe = findEngine(d);
    if (!running && !exe) { d.log("[失敗] AivisSpeech が見つかりません。README の 3-5 を見て入れてから、もう一度 " + againName(d) + " を押してください。"); return { found: false }; }
  }
  if (running) { d.log("AivisSpeech: 起動済みのものを使います"); return { found: true }; }
  if (o.check) { d.log(`AivisSpeech: あります（${exe}）。実行するときに起動します`); return { found: true }; }
  const isEngine = /^run(\.exe)?$/i.test(path.basename(exe));
  d.log("AivisSpeech を起動します…");
  // Mac: アプリとして開く。pid は持たない（アプリの窓が見えるので、あとで止めない）
  const app = isMac(d) ? appBundleOf(exe) : null;
  let pid;
  if (app) d.openApp(app);
  else pid = d.spawnEngine(exe, isEngine && !isMac(d) ? ["--use_gpu"] : []);
  d.log("初回は声のモデルなど（約 900MB）をダウンロードするので、数分〜十数分かかります。");
  let waited = 0;
  while (waited < WAIT_MAX_MS) {
    if (await speakersOf(d)) { d.log("AivisSpeech: 準備ができました"); return { found: true, pid }; }
    await d.sleep(WAIT_STEP_MS);
    waited += WAIT_STEP_MS;
    if (waited % 30000 === 0) d.log(`待っています…（${Math.round(waited / 60000 * 10) / 10} 分）`);
  }
  d.log("[失敗] 20 分待っても AivisSpeech の準備ができませんでした。AivisSpeech の画面を開いて、ダウンロードが終わっているか確かめてください。");
  return { found: true, pid, timedOut: true };
}

// (f) 声の確認（lib/tts.js と同じ audio_query → synthesis）
async function stepVoice(d, o) {
  if (o.check) { d.log("声の確認: 実行するときに、声を合成して鳴らします"); return true; }
  const voice = pickVoice(await speakersOf(d));
  if (!voice) { d.log("[失敗] AivisSpeech の声が見つかりません。AivisSpeech を起動して、声が入っているか確かめてください。"); return false; }
  let wav;
  try {
    const q = await d.fetchImpl(`${AIVIS_URL}/audio_query?text=${encodeURIComponent(TEST_TEXT)}&speaker=${voice.id}`, { method: "POST" });
    if (!q.ok) throw new Error(`audio_query HTTP ${q.status}`);
    const query = await q.json();
    const body = { ...query, speedScale: 1.15, prePhonemeLength: 0.05, postPhonemeLength: 0.08 };
    const s = await d.fetchImpl(`${AIVIS_URL}/synthesis?speaker=${voice.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!s.ok) throw new Error(`synthesis HTTP ${s.status}`);
    wav = Buffer.from(await s.arrayBuffer());
  } catch (e) { d.log(`[失敗] 声を作れませんでした: ${e.message}`); return false; }
  const file = d.writeBin(`amane-setup-voice-${process.pid}.wav`, wav);
  if (o.noPlay) { d.log(`声の確認: 声を作りました（${file}）。--no-play なので鳴らしません`); return true; }
  d.log(`声を出します（${voice.name} / ${voice.style}）…`);
  d.play(file);
  d.removeFile(file);   // 鳴らしたあとは消す
  const a = (await d.ask("声は聞こえましたか？ [Y/n] ", "y")).toLowerCase();
  if (a.startsWith("n")) {
    d.log("声が聞こえないときは、次を確かめてください。");
    d.log("  ・スピーカーやイヤホンがつながっていて、PC の音量が小さすぎない・ミュートでない");
    d.log("  ・画面右下の音量アイコンで、出力先が使いたいスピーカーになっている");
    d.log("  ・直ったら、" + againName(d) + " をもう一度押してください");
    return false;
  }
  return true;
}

// (g) 起動。Mac で、この窓から起動してほしいときは true を返す
async function stepLaunch(d, o) {
  let port = parsePort(d.env.PORT);
  const envPath = path.join(d.root, ".env");
  // 確認だけのときは .env を読まない（環境変数の PORT か既定を見る）
  if (!o.check && d.exists(envPath)) port = parsePort(readEnvValue(d.readText(envPath), "PORT"));
  const url = `http://localhost:${port}`;
  const busy = await d.portInUse(port);
  if (busy) {
    if (o.check) { d.log(`起動: あまね はもう起動しています（ポート ${port}）`); return false; }
    d.log("あまね はもう起動しています。ブラウザで開きます。");
    d.openUrl(url);
  } else if (o.check) {
    d.log(`起動: 起動する予定です（${isMac(d) ? "start.command" : "start.bat"}。ポート ${port}）`);
    return false;
  } else {
    if (isMac(d)) d.log("このまま あまね を起動します…");
    else { d.log("あまね を起動します（新しい黒い窓が開きます）…"); d.startBat(d.root); }
  }
  d.log("");
  d.log("次の手順で話しかけてみてください。");
  d.log("  1. 画面（ブラウザ）のどこかを一度クリックする");
  d.log("  2. 「待受をオン」を押す");
  d.log("  3. マイクの使用を聞かれたら「許可」を押す");
  d.log("  4. マイクに向かって「あまね」と呼びかける");
  d.log("初回は音声認識のモデル（約 200MB）をダウンロードするので、数分かかります。");
  d.log(isMac(d) ? "この窓は閉じないでください（閉じると あまね が止まります）。" : "黒い窓は閉じないでください（閉じると あまね が止まります）。");
  return isMac(d) && !busy;
}

// この実行で起動した AivisSpeech の pid（もとから動いていたものは入れない）を、ctx.pid に控える
async function runSteps(o, d, ctx) {
  // .env を作るときに AivisSpeech の有無が要るので、先に調べる
  const exeFound = !!findEngine(d);
  const envRes = await stepEnv(d, o, exeFound || (!o.check && (await getJson(d, AIVIS_URL + "/version")) != null));
  if (envRes.failed) return 1;
  if (!stepNpm(d, o)) return 1;
  if (!stepPip(d, o)) return 1;
  if (!stepClaude(d, o)) return 1;
  const aivis = await stepAivis(d, o);
  ctx.pid = aivis.pid ?? null;
  // この実行で作った .env に、あとから入れた AivisSpeech の自動起動を足す（もとからあった .env は触らない）
  if (envRes.created && !exeFound && aivis.found) {
    const p = path.join(d.root, ".env");
    d.writeText(p, buildEnv(d.readText(p), { userName: "", aivis: true }));
  }
  if (!aivis.found || aivis.timedOut) return 1;
  if (!(await stepVoice(d, o))) return 1;
  // 声の確認が終わったら、起動した AivisSpeech の扱いを決める
  if (ctx.pid != null) {
    const envPath = path.join(d.root, ".env");
    const auto = d.exists(envPath) && readEnvValue(d.readText(envPath), "VOICEVOX_AUTOSTART") === "1";
    if (auto) { d.killTree(ctx.pid); ctx.pid = null; }   // start.bat が自分の子として起動し直し、終了時に止める
    else d.log("AivisSpeech は動いたままにしています。あまね を使う間は止めないでください。");
  }
  const startHere = await stepLaunch(d, o);
  d.log("");
  d.log(o.check ? "調べ終わりました。" : "セットアップは終わりました。");
  return startHere ? EXIT_START_HERE : 0;
}

async function run(argv, d) {
  const o = parseArgs(argv);
  if (o.check) d.log("（--check: 調べるだけです。何も入れず、書かず、起動せず、鳴らしません）");
  const ctx = { pid: null };
  let code = 1;
  try { code = await runSteps(o, d, ctx); }
  finally {
    // 失敗で終わるときは、この実行で起動したものを止める
    if (code !== 0 && code !== EXIT_START_HERE && ctx.pid != null) d.killTree(ctx.pid);
  }
  return code;
}

if (require.main === module) {
  run(process.argv.slice(2), realDeps(path.resolve(__dirname, ".."))).then((code) => { process.exitCode = code; }, (e) => {
    console.error("[失敗] 想定外のエラーです: " + e.message);
    process.exitCode = 1;
  });
}

module.exports = {
  parsePythonVersion, pythonVerdict, nodeVersionOk, buildEnv, readEnvValue, parsePort,
  parseClaudeStatus, isPaidPlan, pickVoice, parseArgs, appBundleOf, EXIT_START_HERE, run, stepEnv, stepNpm, stepPip, stepClaude, stepAivis, stepVoice, stepLaunch,
};
