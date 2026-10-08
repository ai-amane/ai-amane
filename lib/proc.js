// 子プロセス（作業担当の CLI・常駐の頭・音声認識サーバーなど）を扱うための共通の部品
const { execFile, execFileSync } = require("child_process");

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

// shell:true（Windows）で起動するときの引数のクォート
const q = (s) => (IS_WIN ? `"${s}"` : s);

// Mac / Linux では CLI を detached（自分がリーダーのプロセスグループ）で起動しているので、グループごと止めて孫プロセスを残さない
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
  else try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* もう止まっている */ } }
}
// 終了するとき用（待ってから戻る。process.on("exit") の中では非同期の処理が動かないため）
function killTreeSync(child) {
  if (!child || child.exitCode !== null) return;
  try { IS_WIN ? execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }) : killTree(child); } catch { /* もう止まっている */ }
}

// 子プロセスに渡す環境変数（APIキーなどの秘密は渡さない）
// 作業担当（Codex / Claude Code）や常駐の頭が、Web 検索の結果などに含まれる悪意ある指示（プロンプトインジェクション）に
// だまされても、ElevenLabs の APIキーを読み出せないようにする。
//  キー・秘密・トークン・パスワード・秘密鍵のほか、中にパスワードが入る接続先の URL も渡さない
//  （プロキシの設定（HTTPS_PROXY など）は、CLI がインターネットにつなぐのに要るので渡す）
const SECRET_ENV = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|_PASS|_PWD|_AUTH|CREDENTIALS?|CONNECTION_STRING)$|^(DATABASE_URL|.*_DATABASE_URL|.*_WEBHOOK_URL|.*_DSN|REDIS_URL|MONGO(DB)?_(URI|URL))$|^ELEVENLABS_/i;
// CLI 自身のログインに使うものは残す（Amazon Bedrock・Google Vertex AI 経由で Claude を使う場合の認証も）
const KEEP_ENV = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|GH_TOKEN|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_BEARER_TOKEN_BEDROCK|GOOGLE_APPLICATION_CREDENTIALS)$/i;
function childEnv(extra = {}, base = process.env) {
  const e = Object.fromEntries(Object.entries(base).filter(([k]) => (!SECRET_ENV.test(k) || KEEP_ENV.test(k)) && k !== "ELEVENLABS_API_KEY"));
  return { ...e, ...extra };
}

// 文の中の秘密の値（名前が SECRET_ENV に当たる環境変数の値。8 文字以上）を伏せる
//  作業担当は .env のファイルそのものは読めるので、だまされて報告に書いても、頭や画面には渡さないように
//  （base64 などに変えられると素通りするので、補助の守り）
function redactSecrets(text, base = process.env) {
  const values = Object.entries(base).filter(([k, v]) => SECRET_ENV.test(k) && typeof v === "string" && v.length >= 8)
    .map(([, v]) => v).sort((a, b) => b.length - a.length);
  return values.reduce((s, v) => s.split(v).join("（秘密の値）"), String(text ?? ""));
}

// 行ごとに受け取る（子プロセスの出力は途中で区切られて届くことがあるので、改行までためる）
function onLines(stream, fn) {
  let buf = "";
  stream.on("data", (d) => {
    buf += d.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      fn(line);
    }
  });
}

module.exports = { IS_WIN, IS_MAC, q, killTree, killTreeSync, childEnv, redactSecrets, onLines };
