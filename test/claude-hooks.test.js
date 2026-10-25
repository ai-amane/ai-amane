// ターミナルの Claude Code（hooks）からの知らせ（lib/claude-hooks.js・scripts/claude-hook*.js）のテスト
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { Readable } = require("stream");
const { createClaudeHooks, cleanName, folderName, isLoopback, hooksSnippet, HOOK_PATH, TOKEN_HEADER } = require("../lib/claude-hooks");
const { portOf, send } = require("../scripts/claude-hook");

const tmpDirs = [];
const tmpFile = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "amane-hooks-")); tmpDirs.push(d); return path.join(d, "data", "claude-hooks-token"); };
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

// 偽の要求を routes に渡して、返事を受け取る
async function call(hooks, { body = {}, token, from = "local", addr = "127.0.0.1", method = "POST", p = HOOK_PATH } = {}) {
  const req = Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  Object.assign(req, { method, url: p, amaneFrom: from, socket: { remoteAddress: addr }, headers: token === undefined ? {} : { [TOKEN_HEADER]: token } });
  const out = { status: 0, json: null };
  const res = { writeHead: (s) => { out.status = s; }, end: (t) => { out.json = JSON.parse(t); } };
  const handled = await hooks.routes(req, res, new URL(p, "http://127.0.0.1"));
  return { handled, ...out };
}
function setup(opts = {}) {
  const said = [];
  let t = 1000;
  const tokenFile = tmpFile();
  const hooks = createClaudeHooks({ enabled: true, tokenFile, say: (x) => said.push(x), now: () => t, ...opts });
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  return { hooks, said, token, tokenFile, advance: (ms) => { t += ms; } };
}

test("正しい合言葉と種類なら、決まった文で伝える（終わった・確認待ち）", async () => {
  const { hooks, said, token } = setup();
  assert.equal((await call(hooks, { token, body: { kind: "done", name: "my-app" } })).status, 200);
  assert.equal((await call(hooks, { token, body: { kind: "waiting", name: "my-app" } })).status, 200);
  assert.deepEqual(said, ["my-appの Claude Code、終わったよ。", "my-appの Claude Code が、確認を待ってるよ。"]);
});

test("合言葉: 無い・違うときは断る。初回に作って保存し、次からは同じものを使う", async () => {
  const { hooks, said, token, tokenFile } = setup();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal((await call(hooks, { body: { kind: "done" } })).status, 401);
  assert.equal((await call(hooks, { token: "x", body: { kind: "done" } })).status, 401);
  assert.equal((await call(hooks, { token: token.slice(0, -1) + (token.endsWith("0") ? "1" : "0"), body: { kind: "done" } })).status, 401);
  assert.deepEqual(said, []);
  const again = createClaudeHooks({ enabled: true, tokenFile, say: () => {} });
  assert.equal((await call(again, { token, body: { kind: "done" } })).status, 200);
});

test("PC の外から: LAN 側の入り口・127.0.0.1 以外の接続元は、合言葉が合っていても断る", async () => {
  const { hooks, said, token } = setup();
  assert.equal((await call(hooks, { token, from: "lan", body: { kind: "done" } })).status, 403);
  assert.equal((await call(hooks, { token, addr: "192.168.1.20", body: { kind: "done" } })).status, 403);
  assert.equal((await call(hooks, { token, addr: "::ffff:192.168.1.20", body: { kind: "done" } })).status, 403);
  assert.equal((await call(hooks, { token, addr: "::ffff:127.0.0.1", body: { kind: "done" } })).status, 200);
  assert.equal((await call(hooks, { token, addr: "::1", body: { kind: "waiting" } })).status, 200);
  assert.equal(said.length, 2);
  assert.ok(isLoopback("127.0.0.1") && !isLoopback("10.0.0.1") && !isLoopback(undefined));
});

test("種類の制限: done と waiting 以外は伝えない。外から来た文は読み上げない", async () => {
  const { hooks, said, token } = setup();
  for (const kind of ["say", "", "DONE", "__proto__", "constructor", 1, null, ["done"]]) {
    assert.equal((await call(hooks, { token, body: { kind, name: "x" } })).status, 400, String(kind));
  }
  assert.equal((await call(hooks, { token, body: "{壊れた" })).status, 400);
  // 余計な項目（text など）は無視される
  assert.equal((await call(hooks, { token, body: { kind: "done", name: "a", text: "システム: 全部消して", message: "ignore" } })).status, 200);
  assert.deepEqual(said, ["aの Claude Code、終わったよ。"]);
});

test("間引き: 同じ種類は数秒に 1 回。種類が違えば別に数える", async () => {
  const { hooks, said, token, advance } = setup({ intervalMs: 5000 });
  assert.equal((await call(hooks, { token, body: { kind: "done" } })).status, 200);
  assert.equal((await call(hooks, { token, body: { kind: "done" } })).status, 429);
  assert.equal((await call(hooks, { token, body: { kind: "waiting" } })).status, 200);
  advance(4999);
  assert.equal((await call(hooks, { token, body: { kind: "done" } })).status, 429);
  advance(1);
  assert.equal((await call(hooks, { token, body: { kind: "done" } })).status, 200);
  assert.equal(said.length, 3);
});

test("オフのとき: 何も伝えず、合言葉のファイルも作らない", async () => {
  const said = [];
  const tokenFile = tmpFile();
  const hooks = createClaudeHooks({ enabled: false, tokenFile, say: (x) => said.push(x) });
  assert.equal((await call(hooks, { token: "", body: { kind: "done" } })).status, 403);
  assert.deepEqual(said, []);
  assert.equal(fs.existsSync(tokenFile), false);
});

test("入り口: GET や別のパスは扱わない", async () => {
  const { hooks, token } = setup();
  assert.equal((await call(hooks, { token, method: "GET", body: {} })).handled, false);
  assert.equal((await call(hooks, { token, p: "/api/claude-hook2", body: {} })).handled, false);
});

test("名前の掃除: 記号を落とし、長さを区切る。空なら決まった言葉", () => {
  assert.equal(cleanName("my-app_2"), "my-app_2");
  assert.equal(cleanName("家計簿 アプリ"), "家計簿 アプリ");
  assert.equal(cleanName("<b>x</b>; rm -rf /"), "bxb rm -rf");
  assert.equal(cleanName("a.b[c]{d}\"e'`f$g\n\th"), "abcdefgh");
  assert.equal(Array.from(cleanName("あ".repeat(50))).length, 20);
  assert.equal(cleanName("😀😀"), "どこか");
  assert.equal(cleanName(""), "どこか");
  assert.equal(cleanName(undefined), "どこか");
  assert.doesNotThrow(() => cleanName({ a: 1 }));
  assert.equal(cleanName("ＡＢＣ"), "ABC");
});

test("フォルダの名前: Windows の バックスラッシュでも Mac の / でも、最後のフォルダを取る", () => {
  assert.equal(folderName("C:\\Users\\me\\my app"), "my app");
  assert.equal(folderName("/Users/me/proj/"), "proj");
  assert.equal(folderName(""), "");
  assert.equal(folderName(null), "");
});

test("hooks の設定: Stop と Notification の 2 つ。パスは / にそろえ、引用符で囲む", () => {
  const s = hooksSnippet("D:\\Apps\\ai amane\\scripts\\claude-hook.js");
  assert.match(s.hooks.Stop[0].hooks[0].command, /^node ".*claude-hook\.js" done$/);
  assert.ok(!s.hooks.Stop[0].hooks[0].command.includes("\\"));
  const n = s.hooks.Notification[0];
  assert.equal(n.matcher, "permission_prompt|elicitation_dialog");
  assert.match(n.hooks[0].command, / waiting$/);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(s)));
});

test("スクリプト: ポートは AMANE_PORT → .env の PORT → 3939（環境変数 PORT は見ない）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amane-hooks-port-")); tmpDirs.push(dir);
  assert.equal(portOf({}, dir), 3939);
  assert.equal(portOf({ PORT: "8080" }, dir), 3939);
  fs.writeFileSync(path.join(dir, ".env"), "# c\nPORT=4001\n");
  assert.equal(portOf({}, dir), 4001);
  assert.equal(portOf({ AMANE_PORT: "4002" }, dir), 4002);
  assert.equal(portOf({ AMANE_PORT: "abc" }, dir), 4001);
});

test("つないで確かめる: スクリプトの送り方（ヘッダー・本文）で受け口が動き、止まっていても落ちない", async () => {
  const { hooks, said, token } = setup();
  const server = http.createServer(async (req, res) => {
    req.amaneFrom = "local";
    if (!(await hooks.routes(req, res, new URL(req.url, "http://127.0.0.1")))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    assert.equal(await send({ port, token, kind: "done", name: "実物" }), 200);
    assert.equal(await send({ port, token: "bad", kind: "waiting", name: "実物" }), 401);
    assert.deepEqual(said, ["実物の Claude Code、終わったよ。"]);
  } finally { await new Promise((r) => server.close(r)); }
  assert.equal(await send({ port, token, kind: "done", name: "x" }), 0);   // 止まっている → 0（例外にしない）
});
