// server.js から分けた部品のテスト
//  作業の振り分け・報告の取り出し・応答の速さの記録・表示してよいファイルの判定
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { routeByRules, createRouter } = require("../lib/task-router");
const { extractReport } = require("../lib/tasks");
const { cleanTiming } = require("../lib/voice-routes");
const { createDisplayRoutes } = require("../lib/display-routes");
const { childEnv, redactSecrets } = require("../lib/proc");
const { createTaskRunner, buildPrompt } = require("../lib/tasks");
const { crossSiteApi, readBody } = require("../lib/http-util");
const { Readable } = require("node:stream");

test("振り分け: 言葉の規則で light / heavy を決める", async () => {
  assert.equal(routeByRules("このフォルダを一覧して"), "light");
  assert.equal(routeByRules("全体を設計して"), "heavy");
  assert.equal(routeByRules("あ".repeat(81)), "heavy");
  const decide = createRouter({ router: "rules" });
  assert.deepEqual(await decide("メモに追記して"), { level: "light", by: "rules" });
  assert.deepEqual(await createRouter({ router: "hint" })("なにか", "heavy"), { level: "heavy", by: "agent" });
});

test("報告: 【報告】の段落を取り出し、記号を落とす（【表示】の行は含めない）", () => {
  assert.equal(extractReport("作業しました\n【報告】**終わりました**。ファイルを `作りました`。\n【表示】C:\\a.png"), "終わりました。ファイルを 作りました。");
  assert.equal(extractReport(""), "");
});

test("応答の速さの記録: 決まった項目の数値だけを残す", () => {
  assert.deepEqual(cleanTiming({ stt: 412.4, brainFirst: "1800", total: -5, evil: "<script>", hang: Infinity, cold: "yes", from: "wake", chars: 30 }),
    { stt: 412, cold: false, from: "wake", chars: 30 });   // 文字列の "1800" も数値ではないので残さない
  assert.deepEqual(cleanTiming({}), { cold: false, from: "talk", chars: 0 });
  // 測れなかった値（null・空・true/false）は 0 にせず、記録しない
  assert.deepEqual(cleanTiming({ stt: null, hold: "", wait: false, synth: [], total: 0 }), { total: 0, cold: false, from: "talk", chars: 0 });
});

test("子プロセスの環境変数: APIキーなどの秘密は渡さない（CLI のログインに使うものは残す）", () => {
  const e = childEnv({ EXTRA: "1" }, { ELEVENLABS_API_KEY: "x", OTHER_SECRET: "y", GH_TOKEN: "g", PATH: "p" });
  assert.deepEqual(e, { GH_TOKEN: "g", PATH: "p", EXTRA: "1" });
  // パスワード・秘密鍵・接続先の URL（中にパスワードが入る）なども渡さない
  const more = childEnv({}, { STRIPE_SECRET_KEY: "s", AZURE_CLIENT_SECRET: "a", DB_PASSWORD: "d", DATABASE_URL: "u", SLACK_WEBHOOK_URL: "w",
    SSH_PRIVATE_KEY: "k", SMTP_PASS: "p", FTP_PWD: "p", PROXY_AUTH: "a", AZURE_CONNECTION_STRING: "c", REDIS_URL: "r", MONGODB_URI: "m",
    HTTPS_PROXY: "http://proxy:8080", ANTHROPIC_API_KEY: "keep", AWS_SECRET_ACCESS_KEY: "bedrock", GOOGLE_APPLICATION_CREDENTIALS: "vertex.json", USERPROFILE: "C:/Users/x", APPDATA: "x" });
  assert.deepEqual(more, { HTTPS_PROXY: "http://proxy:8080", ANTHROPIC_API_KEY: "keep", AWS_SECRET_ACCESS_KEY: "bedrock", GOOGLE_APPLICATION_CREDENTIALS: "vertex.json", USERPROFILE: "C:/Users/x", APPDATA: "x" });
});

test("ほかのサイトからの API の呼び出し: Sec-Fetch-Site が same-origin / none / なし以外なら断る（画面の表示は除く）", () => {
  const req = (url, site, mode = "cors") => ({ url, headers: site ? { "sec-fetch-site": site, "sec-fetch-mode": mode } : {} });
  assert.equal(crossSiteApi(req("/api/web/image?url=x", "cross-site", "no-cors")), true);
  assert.equal(crossSiteApi(req("/api/file?path=a.png", "same-site", "no-cors")), true);
  assert.equal(crossSiteApi(req("/api/web/image?url=x", "same-origin", "no-cors")), false);
  assert.equal(crossSiteApi(req("/api/config", "none", "navigate")), false);
  assert.equal(crossSiteApi(req("/api/shutdown")), false);   // サーバーどうし（新しく起動したサーバー）はヘッダーなし
  assert.equal(crossSiteApi(req("/index.html", "cross-site", "navigate")), false);   // 画面そのものは API ではない
  // 絶対形式の要求（GET http://localhost:3939/api/...）でも、解析したパスで判定する
  assert.equal(crossSiteApi(req("http://localhost:3939/api/file?path=a", "cross-site", "no-cors"), "/api/file"), true);
});

test("readBody: オブジェクトでない JSON・大きすぎる本文は {}。文字がチャンクの境目で切れても読める", async () => {
  const body = (...chunks) => Object.assign(Readable.from(chunks.map((c) => Buffer.from(c))), { destroy() { this.emit("close"); } });
  assert.deepEqual(await readBody(body("null")), {});
  assert.deepEqual(await readBody(body("[1,2]")), {});
  assert.deepEqual(await readBody(body("x".repeat(50)), 10), {});
  const t = Buffer.from(JSON.stringify({ text: "こんにちは" }));
  assert.deepEqual(await readBody(body(t.subarray(0, 12), t.subarray(12))), { text: "こんにちは" });
});

// ---------- 表示してよいファイル ----------
test("ファイルの表示: 作業フォルダの中だけ。SVG はスクリプトが動かないようにして返す", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amane-show-"));
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, "a.svg"), "<svg/>");
  fs.writeFileSync(path.join(root, "secret.txt"), "secret");
  const route = createDisplayRoutes({ showDirs: [work] });
  const server = http.createServer(async (req, res) => {
    if (!(await route(req, res, new URL(req.url, "http://x")))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/api/file?path=a.svg`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/svg+xml");
    assert.match(ok.headers.get("content-security-policy"), /sandbox/);
    assert.equal(ok.headers.get("cross-origin-resource-policy"), "same-origin");
    for (const p of ["../secret.txt", path.join(root, "secret.txt"), "\\\\server\\share\\x.txt"]) {
      assert.equal((await fetch(`${base}/api/file?path=${encodeURIComponent(p)}`)).status, 403, p);
    }
    assert.equal((await fetch(`${base}/api/file?path=none.txt`)).status, 404);
    // HTML（ゲームなど）は、この画面とは別の隔離された場所で動かす（スクリプトは動くが、この画面・API・外のサイトには触れない）
    fs.writeFileSync(path.join(work, "game.html"), "<!doctype html><script>1</script>");
    const inFrame = { headers: { "Sec-Fetch-Dest": "iframe" } };
    const html = await fetch(`${base}/api/file?path=game.html`, inFrame);
    assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
    const csp = html.headers.get("content-security-policy");
    assert.match(csp, /^sandbox allow-scripts;/);
    assert.doesNotMatch(csp, /allow-same-origin|allow-top-navigation|allow-popups|allow-forms|worker-src/);
    for (const d of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-src 'none'"]) assert.ok(csp.includes(d), d);
    // 枠の中に読み込むとき以外（タブで直接開く・fetch で読む）は渡さない。HEAD（あるかどうかの確認）は中身を送らずに答える
    assert.equal((await fetch(`${base}/api/file?path=game.html`)).status, 403);
    const head = await fetch(`${base}/api/file?path=game.html`, { method: "HEAD" });
    assert.deepEqual([head.status, (await head.arrayBuffer()).byteLength], [200, 0]);
    // 枠の外側（この画面と同じオリジンの、スクリプトのないページ）。中の枠の移動先を、このサーバーの中だけに限る
    const wrap = await fetch(`${base}/api/app-frame?path=${encodeURIComponent('a"><script>x</script>.html')}`);
    const wcsp = wrap.headers.get("content-security-policy");
    for (const d of ["default-src 'none'", "frame-src 'self'", "frame-ancestors 'self'"]) assert.ok(wcsp.includes(d), d);
    assert.doesNotMatch(wcsp, /script-src/);
    const page = await wrap.text();
    assert.match(page, /<iframe sandbox="allow-scripts" [^>]*src="\/api\/file\?path=a%22%3E%3Cscript%3Ex%3C%2Fscript%3E\.html"/);
    assert.doesNotMatch(page, /<script/);
    assert.equal((await fetch(`${base}/api/app-frame?path=a.svg`)).status, 400);
    // Web ページの下調べ: 家の中のアドレスは 403
    const r = await fetch(`${base}/api/web/inspect`, { method: "POST", body: JSON.stringify({ url: "http://192.168.0.1/" }) });
    assert.equal(r.status, 403);
    const img = await fetch(`${base}/api/web/image?url=${encodeURIComponent("http://10.0.0.1/a.png")}`);
    assert.equal(img.status, 403);
  } finally { server.close(); }
});

test("ファイルの表示: HTML を動かすのは作業フォルダの中だけ（SHOW_DIRS で足したフォルダの HTML は、これまでどおり文字で出す）", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amane-show-"));
  const [work, extra] = ["work", "extra"].map((d) => path.join(root, d));
  for (const d of [work, extra]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(extra, "saved.html"), "<script>1</script>");
  const route = createDisplayRoutes({ showDirs: [work, extra] });
  const server = http.createServer(async (req, res) => {
    if (!(await route(req, res, new URL(req.url, "http://x")))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/file?path=${encodeURIComponent(path.join(extra, "saved.html"))}`, { headers: { "Sec-Fetch-Dest": "iframe" } });
    assert.equal(r.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.match(r.headers.get("content-security-policy"), /^sandbox;/);
  } finally { server.close(); }
});

test("秘密の値を伏せる: 名前が秘密の形の環境変数の値（8 文字以上）だけを、文の中から伏せる", () => {
  const env = { SWITCHBOT_TOKEN: "abcd1234efgh5678", SWITCHBOT_SECRET: "s3cr3t-value", SHORT_KEY: "abc", PATH: "C:/Windows/system32" };
  const text = "トークンは abcd1234efgh5678 で、シークレットは s3cr3t-value です。abc と C:/Windows/system32 はそのまま";
  assert.equal(redactSecrets(text, env), "トークンは （秘密の値） で、シークレットは （秘密の値） です。abc と C:/Windows/system32 はそのまま");
  assert.equal(redactSecrets(null, env), "");
});

test("作業担当への指示文: AI の名前は文字列でも、名前を返す関数でもよい（画面で変えた名前を、作業のたびに読む）", () => {
  assert.match(buildPrompt("メモを作って", { aiName: "あまね", workdir: "W" }), /^あなたは音声アシスタント「あまね」の作業担当です。/);
  let name = "ひかり";
  const aiName = () => name;
  assert.match(buildPrompt("メモを作って", { aiName, workdir: "W" }), /「ひかり」の作業担当/);
  name = "みお";
  const p = buildPrompt("メモを作って", { aiName, workdir: "W" });
  assert.match(p, /「みお」の作業担当/);
  assert.match(p, /作業フォルダ: W\n/);
  assert.match(p, /依頼: メモを作って$/);
});

test("作業担当が動いているか: 作業が無ければ false", () => {
  const tasks = createTaskRunner({ env: (k, d = "") => d, workdir: os.tmpdir(), aiName: "あまね", decideLevel: async () => ({ level: "light" }), lightEngine: "codex", heavyEngine: "claude-opus", log: { log() {}, warn() {} } });
  assert.equal(tasks.active(120000), false);
});
