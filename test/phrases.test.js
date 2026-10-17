// 決まった言葉（lib/phrases.js）のテスト
//  話し方に合わせて作ってもらう部分（generate）は偽物にする
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createPhrases, cleanPhrases, promptFor, parseJson, runClaude, defaultsFor, keyOf, POLITE, CASUAL } = require("../lib/phrases");

// テストで作った一時フォルダは、最後に消す
const tmpDirs = [];
const tmpFile = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "amane-phrases-")); tmpDirs.push(d); return path.join(d, "phrases.json"); };
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const FRIEND = { aiName: "あまね", userName: "", style: "親しい友だちのように、くだけた話し言葉（タメ口）で話す。", character: "" };
const BUTLER = { aiName: "あまね", userName: "", style: "落ち着いた丁寧語。執事のように簡潔で、少しだけウィットを効かせる。", character: "" };
const MADE = { greeting: ["なに？どうしたの？"], wait: ["ちょっと待ってて！", "うーん、考え中！"], search: ["調べてみるね！"],
  long: ["もうちょっと待ってて！"], reportOk: ["お待たせ！"], reportNg: ["ごめん、報告があるよ。"] };
const settle = () => new Promise((r) => setImmediate(r));

test("用意した言葉: 話し方がタメ口なら、くだけた言葉を使う", () => {
  assert.equal(defaultsFor(FRIEND), CASUAL);
  assert.equal(defaultsFor(BUTLER), POLITE);
  assert.equal(defaultsFor({ style: "フランクに話す" }), CASUAL);
});

test("確かめ方: 声で読める短い話し言葉だけを残し、足りない場面は用意した言葉にする", () => {
  const r = cleanPhrases({
    greeting: "はーい、呼んだ？",                      // 1 つだけでも配列にする
    wait: ["ちょっと待ってね", "<act do=\"x\"/>", "OK、待って！", "待って待って待って待って待って待って待って待って待って待って！"],
    search: [],
    long: "（もう少し）待って。",
  }, CASUAL);
  assert.deepEqual(r.greeting, ["はーい、呼んだ？"]);
  assert.deepEqual(r.wait, ["ちょっと待ってね。"]);     // 句点を足す。タグ・英字・長すぎるものは除く
  assert.deepEqual(r.search, CASUAL.search);
  assert.deepEqual(r.long, ["もう少し待って。"]);       // かっこは除く
  assert.deepEqual(r.reportOk, CASUAL.reportOk);
});

test("頼む文: 話し方とキャラクターを入れ、空の項目は入れない", () => {
  const t = promptFor({ ...FRIEND, character: "物知りで、少しだけお茶目。" });
  assert.match(t, /話し方・性格: 親しい友だちのように/);
  assert.match(t, /キャラクター設定: 物知りで/);
  assert.doesNotMatch(t, /相手の呼び方/);
  assert.match(t, /search: インターネットで調べものを始めたとき（3つ）/);
});

test("JSON の取り出し: ```json で囲まれていても読む", () => {
  assert.deepEqual(parseJson('```json\n{"wait":["待ってね。"]}\n```'), { wait: ["待ってね。"] });
  assert.throws(() => parseJson("できませんでした"), /JSON がありません/);
});

test("作って覚える: 最初は用意した言葉を返し、できたら保存して、起動し直しても作り直さない", async () => {
  const file = tmpFile();
  let calls = 0;
  const generate = async () => { calls++; return JSON.stringify(MADE); };
  const ph = createPhrases({ file, persona: () => FRIEND, generate, log: { warn() {}, log() {} } });
  assert.equal(ph.get(), CASUAL);
  assert.equal(ph.ready(), false);
  ph.get();   // 作っている途中なら、もう 1 回は頼まない
  await settle();
  assert.equal(calls, 1);
  assert.equal(ph.ready(), true);
  assert.deepEqual(ph.get().wait, ["ちょっと待ってて！", "うーん、考え中！"]);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).key, keyOf(FRIEND));
  const again = createPhrases({ file, persona: () => FRIEND, generate, log: { warn() {}, log() {} } });
  assert.deepEqual(again.get().search, ["調べてみるね！"]);
  assert.equal(calls, 1);
});

test("話し方を変えたら作り直す。作れなかったときは用意した言葉のまま、しばらく頼み直さない", async () => {
  let who = FRIEND, now = 0, fail = false, calls = 0;
  const generate = async () => { calls++; if (fail) throw new Error("つながらない"); return JSON.stringify(MADE); };
  const ph = createPhrases({ file: tmpFile(), persona: () => who, generate, now: () => now, log: { warn() {}, log() {} } });
  ph.get(); await settle();
  assert.equal(calls, 1);
  who = BUTLER; fail = true;
  assert.equal(ph.get(), POLITE);
  await settle();
  assert.equal(calls, 2);
  assert.equal(ph.get(), POLITE);       // 作れなかった → 用意した言葉
  await settle();
  assert.equal(calls, 2);               // すぐには頼み直さない
  now += 11 * 60 * 1000; fail = false;
  ph.get(); await settle();
  assert.equal(calls, 3);
  assert.equal(ph.ready(), true);
});

test("作っている間に話し方が変わったら、前の話し方の言葉は使わない", async () => {
  let who = FRIEND, release;
  const generate = () => new Promise((r) => { release = () => r(JSON.stringify(MADE)); });
  const ph = createPhrases({ file: tmpFile(), persona: () => who, generate, log: { warn() {}, log() {} } });
  ph.get();
  who = BUTLER;
  release(); await settle(); await settle();
  assert.equal(ph.ready(), false);
  assert.equal(ph.get(), POLITE);
});

test("確かめ方: 英字・記号・絵文字・文字化けした言葉は使わない", () => {
  const r = cleanPhrases({ wait: ["ＯＫ、待って！", "待ってね😊", "待っ�てね。", "待って＆見て。", "ちょっと待ってね…。"] }, POLITE);
  assert.deepEqual(r.wait, ["ちょっと待ってね…。"]);
});

const FAKE = path.join(__dirname, "fixtures", "fake-claude-once.js");
const run = (mode, o = {}) => runClaude({ bin: process.execPath, binArgs: [FAKE, mode], prompt: "頼みの文", ...o });

test("Claude Code を 1 回動かす: 頼みの文を渡し、返事の文を受け取る（ツール・設定なし）", async () => {
  assert.match(await run("ok"), /"wait":\["ちょっと待ってね。"\]/);
  assert.equal(await run("echo", { prompt: "日本語の頼みの文。".repeat(2000) }), "日本語の頼みの文。".repeat(2000));   // 長い日本語も化けない
});

test("Claude Code を 1 回動かす: 失敗・時間切れは、理由を付けて断る（時間切れなら止める）", async () => {
  await assert.rejects(run("fail"), /終了コード 2: ログインしていません/);
  await assert.rejects(run("slow", { timeoutMs: 1500 }), /時間がかかりすぎました/);
  await assert.rejects(runClaude({ bin: path.join(os.tmpdir(), "no-such-claude-bin"), prompt: "x" }));
});
