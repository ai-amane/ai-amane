// Claude Code の hooks（Stop / Notification）から呼ばれる小さなスクリプト。使い方: node claude-hook.js done|waiting
//  hooks の入力（JSON）の cwd からフォルダの名前を取り、この PC の AI あまね に知らせる（lib/claude-hooks.js）。
//  あまね が止まっていても、オフでも、Claude Code の邪魔をしないよう、何も出さず必ず終了コード 0 で終わる
const fs = require("fs");
const http = require("http");
const path = require("path");
const { folderName, HOOK_PATH, TOKEN_HEADER, KINDS } = require("../lib/claude-hooks");

const ROOT = path.join(__dirname, "..");
const TIMEOUT_MS = 3000;

// あまね の画面のポート: AMANE_PORT → .env の PORT → 3939
function portOf(env = process.env, root = ROOT) {
  const fromEnv = Number(env.AMANE_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;
  try {
    const m = fs.readFileSync(path.join(root, ".env"), "utf8").match(/^\s*PORT\s*=\s*["']?(\d+)/m);
    if (m) return Number(m[1]);
  } catch { /* .env が無い */ }
  return 3939;
}

function readStdin(ms = 1000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let s = "";
    const t = setTimeout(() => resolve(s), ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { s += c; });
    process.stdin.on("end", () => { clearTimeout(t); resolve(s); });
    process.stdin.on("error", () => { clearTimeout(t); resolve(s); });
  });
}

function send({ port, token, kind, name }) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ kind, name });
    const req = http.request({
      host: "127.0.0.1", port, path: HOOK_PATH, method: "POST", timeout: TIMEOUT_MS,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), "X-Amane": "1", [TOKEN_HEADER]: token },
    }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(0));
    req.end(payload);
  });
}

async function main(argv = process.argv.slice(2)) {
  const kind = argv[0];
  if (!Object.hasOwn(KINDS, kind)) return;
  let token = "";
  try { token = fs.readFileSync(path.join(ROOT, "data", "claude-hooks-token"), "utf8").trim(); } catch { return; }   // あまね が一度も オンで起動していない
  let cwd = "";
  try { cwd = JSON.parse(await readStdin()).cwd || ""; } catch { /* 入力が読めなくても知らせる */ }
  await send({ port: portOf(), token, kind, name: folderName(cwd || process.cwd()) });
}

if (require.main === module) main().then(() => process.exit(0), () => process.exit(0));
module.exports = { portOf, send, main };
