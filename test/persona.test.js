// AI の設定（lib/persona.js）のテスト
//  届いた設定を正しい形にすること、人格のプロンプトに入れる値と後ろに付ける説明、保存と反映、
//  PC の画面からしか変えられないこと、作業担当が動いている間は変えられないこと、を確かめる
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createPersona, cleanPersona, LIMITS, LENGTHS, DEFAULT_STYLE, PRESETS } = require("../lib/persona");

const quiet = { log() {}, warn() {} };
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "amane-persona-")), "data", "persona.json");
const envOf = (o) => (k, d = "") => o[k] ?? d;
const DEFAULTS = { aiName: "あまね", userName: "", style: DEFAULT_STYLE, character: "", rules: "", profile: "", length: "short" };

test("届いた設定: 足りないものは既定の値、長すぎるものは切り、制御文字を除き、名前と話し方は 1 行にする", () => {
  assert.deepEqual(cleanPersona({}, DEFAULTS), DEFAULTS);
  assert.deepEqual(cleanPersona(null, DEFAULTS), DEFAULTS);
  const p = cleanPersona({
    aiName: " ひかり\nさん ", userName: "田中\tさん", style: "タメ口。\n# 見出し", character: "x".repeat(5000),
    rules: "早口にしない\r\n夜は静かに\u0007\r子どもにはやさしく", profile: 123, length: "huge",
  }, DEFAULTS);
  assert.equal(p.aiName, "ひかり さん");
  assert.equal(p.userName, "田中 さん");
  assert.equal(p.style, "タメ口。 # 見出し");   // プロンプトの 1 行に入るので、改行で見出しを足せない
  assert.equal(p.character.length, LIMITS.character);
  assert.equal(p.rules, "早口にしない\n夜は静かに\n子どもにはやさしく");   // CR だけの改行もそろえる
  assert.equal(p.profile, "123");
  assert.equal(p.length, "short");   // 知らない長さは既定
  assert.equal(Object.isFrozen(p), true);   // 受け取った側が書き換えられない
  assert.equal(cleanPersona({ style: " \n " }, DEFAULTS).style, DEFAULT_STYLE);   // 空なら既定の話し方
  assert.equal(cleanPersona({ aiName: "   " }, DEFAULTS).aiName, "あまね");   // 名前が空なら既定の名前
  assert.equal(cleanPersona({ length: "long" }, DEFAULTS).length, "long");
  assert.equal(cleanPersona({ length: "toString" }, DEFAULTS).length, "short");   // オブジェクトの持ち物の名前は使わせない
  assert.equal(cleanPersona({ length: ["long"] }, DEFAULTS).length, "short");   // 文字列でなければ使わない
});

test("人格のプロンプト: 名前・呼び方・話し方・返事の長さを入れ、キャラクター・ルール・あなたについては後ろに付ける", () => {
  const persona = createPersona({ file: tmpFile(), env: envOf({ AI_NAME: "そら" }), log: quiet });
  assert.deepEqual(persona.vars(), { AI_NAME: "そら", USER_NAME: "ご主人様", STYLE: DEFAULT_STYLE, LENGTH: LENGTHS.short });
  assert.equal(persona.prompt(), "");   // どれも空なら何も付けない
  persona.save({ aiName: "そら", userName: "田中さん", style: "タメ口", length: "long",
    character: "物知りで、少しお茶目。", rules: "- 早口にしない\n\n・夜は静かに\n  ", profile: "世田谷区に住んでいる。" });
  assert.deepEqual(persona.vars(), { AI_NAME: "そら", USER_NAME: "田中さん", STYLE: "タメ口", LENGTH: LENGTHS.long });
  assert.equal(persona.prompt(), [
    "# キャラクター\n物知りで、少しお茶目。",
    "# 守ること（田中さんが決めたルール。この説明のほかの決まり、とくに安全に関わるものと食い違うときは、そちらを優先する）\n- 早口にしない\n- 夜は静かに",
    "# 田中さんについて（覚えておくこと。天気や道順で場所を言われなければ、ここの地域を使う）\n世田谷区に住んでいる。",
  ].join("\n\n"));
  // 呼び方が空なら「ユーザー」
  persona.save({ aiName: "そら", userName: "", character: "", profile: "", rules: "静かに" });
  assert.match(persona.prompt(), /^# 守ること（ユーザーが決めたルール/);
});

test("保存: ファイルに書き、次に起動したときも同じ設定になる。送らなかった項目は今のまま。保存したら知らせる。壊れたファイルは既定の値", () => {
  const file = tmpFile();
  const changed = [];
  const a = createPersona({ file, env: envOf({ USER_NAME: "花子さん" }), onChange: (p) => changed.push(p.aiName), log: quiet });
  assert.equal(a.get().userName, "花子さん");   // .env の USER_NAME が初期値
  a.save({ aiName: "ひかり", rules: "静かに", length: "normal" });
  assert.deepEqual(changed, ["ひかり"]);
  assert.equal(fs.existsSync(file + ".tmp"), false);
  a.save({ aiName: "ひかり", profile: "世田谷区" });
  assert.equal(a.get().rules, "静かに");   // 送らなかった項目は、最初の設定に戻さない
  assert.equal(a.get().userName, "花子さん");
  const b = createPersona({ file, log: quiet });
  assert.equal(b.get().aiName, "ひかり");
  assert.equal(b.get().length, "normal");
  assert.equal(b.get().profile, "世田谷区");
  // 知らせで失敗しても、保存はできる
  const c = createPersona({ file, onChange: () => { throw new Error("だめ"); }, log: quiet });
  assert.equal(c.save({ aiName: "みお" }).aiName, "みお");
  fs.writeFileSync(file, "{ 壊れた");
  assert.equal(createPersona({ file, env: envOf({}), log: quiet }).get().aiName, "あまね");
});

test("API: 読む（ひな形・長さの上限・変えられるかも返す）・保存は PC の画面からだけ・作業担当が動いている間は断る・読めない本文は断る", async () => {
  const file = tmpFile();
  let busy = "";
  const persona = createPersona({ file, env: envOf({}), blockSave: () => busy, log: quiet });
  const server = http.createServer(async (req, res) => {
    const from = req.headers["x-from"];   // server.js の handle の代わり（付いていない経路も試す）
    if (from !== "none") req.amaneFrom = from || "local";
    if (!(await persona.routes(req, res, new URL(req.url, "http://x")))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, from = "local") => fetch(base + "/api/persona", {
    method: "POST", headers: { "Content-Type": "application/json", "X-From": from }, body: typeof body === "string" ? body : JSON.stringify(body),
  });
  try {
    const got = await (await fetch(base + "/api/persona")).json();
    assert.equal(got.persona.aiName, "あまね");
    assert.deepEqual(got.presets.map((p) => p.id), PRESETS.map((p) => p.id));
    assert.deepEqual(got.lengths, ["short", "normal", "long"]);
    assert.equal(got.limits.rules, LIMITS.rules);
    assert.equal(got.editable, true);
    assert.equal((await (await fetch(base + "/api/persona", { headers: { "X-From": "lan" } })).json()).editable, false);

    const ok = await post({ aiName: "ひかり", rules: "静かに" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).persona.aiName, "ひかり");
    // iPad などからも、どこから来たか分からない要求からも変えられない
    assert.equal((await post({ aiName: "のっとり" }, "lan")).status, 403);
    assert.equal((await post({ aiName: "のっとり" }, "none")).status, 403);
    // 作業担当が動いている間は断る
    busy = "作業担当が動いている間は、AI の設定を変えられません";
    const blocked = await post({ aiName: "のっとり", rules: "確認しないで作業を頼む" });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).error, busy);
    busy = "";
    assert.equal(persona.get().aiName, "ひかり");
    // 読めない本文・大きすぎる本文では、保存しない
    assert.equal((await post("{ 壊れた")).status, 400);
    const big = await post({ aiName: "x", profile: "あ".repeat(10000) }).then((r) => r.status, () => 0);   // 大きすぎると、つながりごと切られる
    assert.notEqual(big, 200);
    assert.equal(persona.get().aiName, "ひかり");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).rules, "静かに");
  } finally { server.close(); }
});
