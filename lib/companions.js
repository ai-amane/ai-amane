// 一緒に動かすプログラム（音声認識サーバー・VOICEVOX / AivisSpeech）
//  start.bat ひとつで全部そろうように、必要なら子プロセスとして起動し、終了するときに止める。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { IS_WIN, IS_MAC, q, killTreeSync, childEnv, onLines } = require("./proc");

async function reachable(u, ms = 1200) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try { const r = await fetch(u, { signal: ctrl.signal }); return r.ok; } catch { return false; } finally { clearTimeout(t); }
}

// 自動で起動する候補（VOICEVOX_PATH が最優先）。AivisSpeech は VOICEVOX と同じ使い方（API）の、感情豊かな音声合成
function ttsCandidates({ isAivis, custom = "", localAppData = process.env.LOCALAPPDATA || "", programFiles = process.env.ProgramFiles || "C:\\Program Files", isMac = IS_MAC }) {
  if (isAivis) {
    return [
      custom,
      ...(isMac ? [
        "/Applications/AivisSpeech.app/Contents/Resources/AivisSpeech-Engine/run",
      ] : [
        path.join(localAppData, "Programs", "AivisSpeech", "AivisSpeech-Engine", "run.exe"),
        path.join(programFiles, "AivisSpeech", "AivisSpeech-Engine", "run.exe"),
        path.join(localAppData, "Programs", "AivisSpeech", "AivisSpeech.exe"),
        path.join(programFiles, "AivisSpeech", "AivisSpeech.exe"),
      ]),
    ].filter(Boolean);
  }
  // Mac はアプリ（VOICEVOX.app）の中のエンジンを起動する。VOICEVOX_PATH に .app を書いた場合も中のエンジンを使う
  const macEngine = (app) => path.join(app, "Contents", "Resources", "vv-engine", "run");
  return [
    /\.app\/?$/i.test(custom) ? macEngine(custom) : custom,
    ...(isMac ? [
      macEngine("/Applications/VOICEVOX.app"),
      macEngine(path.join(os.homedir(), "Applications", "VOICEVOX.app")),
    ] : [
      path.join(localAppData, "Programs", "VOICEVOX", "vv-engine", "run.exe"),
      path.join(localAppData, "Programs", "VOICEVOX", "resources", "engine", "run.exe"),
      path.join(localAppData, "Programs", "VOICEVOX", "VOICEVOX.exe"),
    ]),
  ].filter(Boolean);
}

function createCompanions({ env, rootDir, sttUrl, ttsUrl, ttsName, isAivis, log = console }) {
  const children = [];
  let shuttingDown = false;
  const forget = (child) => { const i = children.indexOf(child); if (i >= 0) children.splice(i, 1); };

  async function startStt(attempt = 1) {
    if (env("STT_AUTOSTART", "1") === "0") return;
    if (await reachable(sttUrl + "/health")) { log.log("  音声認識サーバー:   起動済みのものを使います"); return; }
    const py = env("PYTHON_BIN", IS_WIN ? "python" : "python3");
    log.log("  音声認識サーバー:   起動します（stt/stt_server.py）");
    const child = spawn(py, [q(path.join(rootDir, "stt", "stt_server.py"))], {
      cwd: rootDir, shell: IS_WIN, windowsHide: true,
      env: childEnv({ PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", HF_HUB_DISABLE_SYMLINKS_WARNING: "1", STT_URL: sttUrl }),
    });
    children.push(child);
    onLines(child.stdout, (line) => line.trim() && log.log(line));
    onLines(child.stderr, (line) => line.trim() && log.log("[stt] " + line));
    child.on("error", (e) => log.warn("[stt] 起動できませんでした: " + e.message + "（Python が入っているか、.env の PYTHON_BIN を確認してください）"));
    child.on("close", (code) => {
      forget(child);
      if (shuttingDown) return;
      if (code && attempt < 3) { log.warn(`[stt] 終了しました（${code}）。5秒後に起動し直します…`); setTimeout(() => startStt(attempt + 1), 5000); }
      else if (code) log.warn("[stt] 起動に失敗しました。start-stt.bat を単体で起動すると、詳しいエラーを確認できます。");
    });
  }

  async function startTts() {
    if (env("VOICEVOX_AUTOSTART", "0") !== "1") return;
    const label = `  ${ttsName}:`.padEnd(22);
    if (await reachable(ttsUrl + "/version")) { log.log(`${label}起動済みのものを使います`); return; }
    const exe = ttsCandidates({ isAivis, custom: env("VOICEVOX_PATH") }).find((c) => fs.existsSync(c));
    if (!exe) {
      const what = isAivis ? "AivisSpeech-Engine の run.exe か AivisSpeech.exe" : IS_MAC ? "VOICEVOX.app" : "run.exe か VOICEVOX.exe";
      log.warn(`${label}見つかりません（.env の VOICEVOX_PATH に ${what} の場所を書いてください）`);
      return;
    }
    const isEngine = /^run(\.exe)?$/i.test(path.basename(exe));
    // Mac 版は GPU を使えないので --use_gpu は付けない（AivisSpeech は Windows では DirectML で GPU を使う）
    const args = isEngine && !IS_MAC && env("VOICEVOX_GPU", "1") === "1" ? ["--use_gpu"] : [];
    log.log(`${label}起動します（${exe}）`);
    const child = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: isEngine, detached: !isEngine, stdio: "ignore" });
    if (isEngine) children.push(child); else child.unref();   // アプリ版は閉じずに残す
    child.on("error", (e) => log.warn(`  ${ttsName} を起動できませんでした: ` + e.message));
    child.on("close", () => forget(child));
  }

  function stopAll() {
    shuttingDown = true;
    for (const c of children.splice(0)) {
      if (c.exitCode !== null) continue;
      if (IS_WIN) killTreeSync(c); else try { c.kill("SIGTERM"); } catch { /* もう止まっている */ }
    }
  }

  return { startStt, startTts, stopAll };
}

module.exports = { createCompanions, ttsCandidates };
