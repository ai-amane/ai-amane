// ユーザーが自分のターミナルで動かしている Claude Code（hooks の Stop / Notification）からの知らせを受けて、声で伝える
//  既定ではオフ（.env の CLAUDE_HOOKS=1 でオン）。受け口 POST /api/claude-hook の安全の作り:
//   ・この PC の画面と同じ localhost のサーバーだけ（iPad などの LAN からは受けない）。接続元が 127.0.0.1 / ::1 でなければ断る
//   ・合言葉（トークン）が要る。初回に作って data/claude-hooks-token に保存し、scripts/claude-hook.js が読む
//   ・知らせの種類は done（終わった）と waiting（確認待ち）だけ。読み上げる文はここで決めた文で、外から来た文は使わない
//     （受け取るのはフォルダの名前だけ。長さを区切り、記号を落とす）。頭（Claude）には渡さない
//   ・同じ種類は INTERVAL_MS に 1 回だけ（間引き）
//  読み上げは、追加機能の知らせ（lib/plugin-events.js の say）に乗せる。画面の側で、会話・ほかの知らせの順番に並ぶ
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { sendJson, readBody, routeTable } = require("./http-util");

const HOOK_PATH = "/api/claude-hook";
const TOKEN_HEADER = "x-amane-hook-token";
const INTERVAL_MS = 5000;
const NAME_MAX = 20;
const FALLBACK_NAME = "どこか";
const KINDS = Object.freeze({
  done: (name) => `${name}の Claude Code、終わったよ。`,
  waiting: (name) => `${name}の Claude Code が、確認を待ってるよ。`,
});

// フォルダの名前を、読み上げてよい形にする（文字・数字・空白・- _ だけ残し、長さを区切る）
function cleanName(v) {
  const s = String(v ?? "").normalize("NFKC").replace(/[^\p{L}\p{N} _-]/gu, "").replace(/\s+/g, " ").trim();
  return Array.from(s).slice(0, NAME_MAX).join("").trim() || FALLBACK_NAME;
}
// cwd（Windows の C:\a\b でも Mac の /a/b でも）の最後のフォルダの名前
function folderName(cwd) {
  return String(cwd ?? "").split(/[\\/]/).filter(Boolean).pop() || "";
}
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
const isLoopback = (addr) => LOOPBACK.test(String(addr || ""));
// あまね が自分で起動した作業担当の Claude Code の印（lib/tasks.js が付ける）。作業担当もユーザーの hooks を読むので、
//  これが付いた Claude Code からの知らせは送らない（あまね に頼んだ作業は、あまね が自分で報告するので二重になる）
const TASK_ENV = "AMANE_TASK";
const isAmaneTask = (env = process.env) => env[TASK_ENV] === "1";

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const sameToken = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

// 合言葉を読む。無ければ作って保存する（自分だけが読める権限で）
function loadOrCreateToken(file) {
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  } catch { /* まだ無い */ }
  const t = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, t + "\n", { mode: 0o600 });
  return t;
}

// enabled: オンか  tokenFile: 合言葉の保存先  say(text): 声で伝える  now: 時計（テスト用）
function createClaudeHooks({ enabled = false, tokenFile, say, now = Date.now, intervalMs = INTERVAL_MS, log = console }) {
  const token = enabled ? loadOrCreateToken(tokenFile) : "";
  const lastAt = new Map();   // 種類 → 最後に受け付けた時刻

  const routes = routeTable([
    ["POST", HOOK_PATH, async (req, res) => {
      // 順番に意味がある: 入り口（PC の中か）→ オンか → 合言葉 → 中身 → 間引き
      if (req.amaneFrom !== "local" || !isLoopback(req.socket?.remoteAddress)) return sendJson(res, 403, { error: "この PC の中からだけ使えます" });
      if (!enabled) return sendJson(res, 403, { error: "Claude Code からの知らせは、オフです（.env に CLAUDE_HOOKS=1）" });
      const given = req.headers[TOKEN_HEADER];
      if (typeof given !== "string" || !sameToken(given, token)) return sendJson(res, 401, { error: "合言葉が違います" });
      const body = await readBody(req, 2000);
      const kind = typeof body.kind === "string" && Object.hasOwn(KINDS, body.kind) ? body.kind : "";
      if (!kind) return sendJson(res, 400, { error: "知らせの種類は done か waiting です" });
      const t = now();
      if (lastAt.has(kind) && t - lastAt.get(kind) < intervalMs) return sendJson(res, 429, { error: "続けて来たので、間引きました" });
      lastAt.set(kind, t);
      try { say(KINDS[kind](cleanName(body.name))); } catch (e) { log.warn?.("[claude-hooks] 伝えられませんでした:", e.message); }
      sendJson(res, 200, { ok: true });
    }],
  ]);

  return { routes, enabled, hookPath: HOOK_PATH };
}

// 貼り付ける hooks の設定（~/.claude/settings.json の "hooks" の中身）。パスは / にそろえる（Windows の Git Bash・PowerShell・Mac で通る）
function hooksSnippet(scriptPath) {
  const script = path.resolve(scriptPath).replace(/\\/g, "/");
  const cmd = (kind) => ({ type: "command", command: `node "${script}" ${kind}`, timeout: 10 });
  return {
    hooks: {
      Stop: [{ hooks: [cmd("done")] }],
      Notification: [{ matcher: "permission_prompt|elicitation_dialog", hooks: [cmd("waiting")] }],
    },
  };
}

module.exports = { createClaudeHooks, cleanName, folderName, isLoopback, isAmaneTask, loadOrCreateToken, hooksSnippet, HOOK_PATH, TOKEN_HEADER, TASK_ENV, KINDS, INTERVAL_MS, NAME_MAX };
