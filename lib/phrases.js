// 決まった言葉（呼ばれたときのあいさつ・返事を待たせるときのつなぎの言葉・作業が終わって自分から報告するときの始め）
//  画面の「名前・性格」の話し方に合わせて、頭とは別の Claude Code（既定は haiku）に一度だけ作ってもらい、data/phrases.json に覚えておく
//  ・話し方（名前・呼び方・話し方・キャラクター）を変えたら作り直す。覚えたものがあれば、起動し直しても作り直さない
//  ・作っている間と、作れなかったときは、話し方がくだけた言葉（タメ口）かどうかで選んだ、用意した言葉を使う
//  ・声は画面が先に合成して覚えておく（/api/tts/warmup）ので、作ったあとは待たずに話せる
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { IS_WIN, q, killTree, killTreeSync, childEnv } = require("./proc");
const { sendJson, routeTable } = require("./http-util");

// 場面ごとの数と、頭への説明（どんなときに話す言葉か）
const KINDS = {
  greeting: { n: 1, when: "呼びかけられて、返事をするとき" },
  wait: { n: 3, when: "返事を考えるのに少し時間がかかっているとき（何について考えているかは分からないので、内容には触れない）" },
  search: { n: 3, when: "インターネットで調べものを始めたとき" },
  long: { n: 2, when: "さらに時間がかかっていて、もう少し待ってもらうとき" },
  reportOk: { n: 1, when: "頼まれた作業が終わって、自分から報告を始めるときの最初のひとこと（中身はこのあと話すので、何ができたかには触れない）" },
  reportNg: { n: 1, when: "頼まれた作業がうまくいかず、自分から報告を始めるときの最初のひとこと（中身はこのあと話すので、理由には触れない）" },
};
const POLITE = Object.freeze({
  greeting: ["はい、お呼びでしょうか。"],
  wait: ["少々お待ちください。", "ちょっと考えますね。", "えーっと、少々お待ちを。"],
  search: ["調べてみますね。", "少し調べます。"],
  long: ["もう少しお待ちください。", "もうちょっとかかりそうです。"],
  reportOk: ["お待たせしました。"],
  reportNg: ["すみません、ご報告があります。"],
});
const CASUAL = Object.freeze({
  greeting: ["うん、どうしたの？"],
  wait: ["ちょっと待ってね。", "うーん、ちょっと考えさせて。", "えっとね、ちょっと待って。"],
  search: ["ちょっと調べてみるね。", "調べてみるね。"],
  long: ["もうちょっとかかりそう、ごめんね。", "もう少しだけ待ってね。"],
  reportOk: ["お待たせ！"],
  reportNg: ["ごめん、ちょっと報告があるんだ。"],
});
const CASUAL_RE = /タメ口|ため口|くだけた|友だち|友達|フランク|気さく/;
const PHRASE_MAX = 30;          // 1 つの言葉の長さの上限
const RETRY_MS = 10 * 60 * 1000;   // 作れなかったとき、同じ話し方で作り直すまで
const TIMEOUT_MS = 90 * 1000;

const defaultsFor = (p) => (CASUAL_RE.test(String(p?.style || "")) ? CASUAL : POLITE);
// 話し方の印（これが変わったら作り直す）
const keyOf = (p) => crypto.createHash("sha256")
  .update(JSON.stringify([p?.aiName || "", p?.userName || "", p?.style || "", p?.character || ""])).digest("hex").slice(0, 16);

// 作ってもらった言葉を確かめる（場面ごとに、話し言葉として読める短い文だけ。足りない場面は用意した言葉）
//  かっこは除き、そのほかは使ってよい文字（かな・漢字・句読点）だけの言葉を残す（英字・記号・絵文字・文字化けした言葉は使わない）
const ALLOWED = /^[ぁ-ゖァ-ヺー一-龯々〆、。！？!?…〜・]+$/;
function cleanPhrases(raw, fallback = POLITE) {
  const one = (s) => {
    const t = String(s ?? "").replace(/\s+/g, "").replace(/[()（）「」『』]/g, "");
    if (!t || t.length > PHRASE_MAX || !ALLOWED.test(t) || !/[ぁ-ゖァ-ヺ一-龯]/.test(t)) return "";
    return /[。！？!?]$/.test(t) ? t : t + "。";
  };
  const r = raw && typeof raw === "object" ? raw : {};
  return Object.freeze(Object.fromEntries(Object.entries(KINDS).map(([k, { n }]) => {
    const list = [...new Set([].concat(r[k] ?? []).map(one).filter(Boolean))].slice(0, n + 1);
    return [k, list.length ? list : fallback[k]];
  })));
}

// 頭とは別の Claude Code に頼む文
function promptFor(p) {
  const lines = Object.entries(KINDS).map(([k, { n, when }]) => `- ${k}: ${when}（${n}つ）`);
  return [
    "音声アシスタントが、決まった場面で話す短いせりふを書いてください。",
    `名前: ${p.aiName || "あまね"}`,
    p.userName ? `相手の呼び方: ${p.userName}` : null,
    `話し方・性格: ${p.style || ""}`,
    p.character ? `キャラクター設定: ${p.character}` : null,
    "",
    "場面:",
    ...lines,
    "",
    "決まり:",
    "- 話し方・性格に合わせた話し言葉で、どれも 15 文字くらいまで。同じ場面の言葉は、言い方を少しずつ変える。",
    "- 記号・絵文字・英語・かっこを使わない。最後は「。」か「！」か「？」。",
    "- 返事は JSON だけ（説明を付けない）。形: {\"greeting\":[\"…\"],\"wait\":[\"…\",\"…\",\"…\"],\"search\":[…],\"long\":[…],\"reportOk\":[\"…\"],\"reportNg\":[\"…\"]}",
  ].filter((s) => s !== null).join("\n");
}

// 返事の文から JSON を取り出す（```json で囲まれていても読む）
function parseJson(text) {
  const s = String(text || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("JSON がありません");
  return JSON.parse(s.slice(a, b + 1));
}

// Claude Code を 1 回だけ動かして、返事の文を受け取る（ツールなし・設定や会話を残さない）
// binArgs: bin の前に付ける引数（テストで偽物の CLI を node で動かすため）
function runClaude({ bin = "claude", binArgs = [], model = "haiku", prompt, timeoutMs = TIMEOUT_MS }) {
  const empty = IS_WIN ? '""' : "";
  const args = ["-p", "--model", model, "--output-format", "json", "--tools", empty, "--strict-mcp-config",
    "--no-session-persistence", "--setting-sources", empty, "--system-prompt", q("You write short Japanese voice lines. Reply with JSON only.")];
  return new Promise((resolve, reject) => {
    const c = spawn(bin, [...binArgs, ...args], { cwd: os.tmpdir(), shell: IS_WIN, windowsHide: true, detached: !IS_WIN, env: childEnv() });
    let out = "", err = "";
    // サーバーが止まるときは、作っている途中の Claude Code も止める
    const onExit = () => killTreeSync(c);
    process.once("exit", onExit);
    const timer = setTimeout(() => { killTree(c); reject(new Error("時間がかかりすぎました")); }, timeoutMs);
    const done = () => { clearTimeout(timer); process.off("exit", onExit); };
    // 文字で受け取る（塊ごとに文字にすると、日本語が塊の境目で切れて化ける）
    c.stdout.setEncoding("utf8");
    c.stderr.setEncoding("utf8");
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { err += d; });
    c.stdin.on("error", () => { /* 起動できなかったとき（error・close で知らせる） */ });
    c.on("error", (e) => { done(); reject(e); });
    c.on("close", (code) => {
      done();
      if (code !== 0) return reject(new Error(`終了コード ${code}: ${err.slice(0, 200)}`));
      try { const r = JSON.parse(out); r.is_error ? reject(new Error(String(r.result).slice(0, 200))) : resolve(String(r.result || "")); }
      catch { reject(new Error("返事を読めません")); }
    });
    c.stdin.end(prompt);
  });
}

// file: 覚えておくファイル  persona: 今の AI の設定を返す関数  generate(prompt): 返事の文（テストで差し替える）
//  画面は /api/phrases で受け取る。ready が false（作っている途中）なら、少しあとで取り直して、声を覚え直す
function createPhrases({ file, persona, generate, log = console, now = () => Date.now() }) {
  let saved = (() => { try { const s = JSON.parse(fs.readFileSync(file, "utf8")); return { key: s.key, phrases: cleanPhrases(s.phrases) }; } catch { return null; } })();
  let making = null;            // 作っている途中の話し方の印
  const failed = new Map();     // 話し方の印 → 作れなかった時刻

  async function make(p, key) {
    making = key;
    try {
      const phrases = cleanPhrases(parseJson(await generate(promptFor(p))), defaultsFor(p));
      if (keyOf(persona()) !== key) return;   // 作っている間に話し方が変わった（新しい話し方で、また作る）
      saved = { key, phrases };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + ".tmp", JSON.stringify({ key, at: new Date(now()).toISOString(), phrases }, null, 2));
      fs.renameSync(file + ".tmp", file);
      log.log?.("[phrases] 話し方に合わせた決まった言葉を作りました");
    } catch (e) {
      failed.set(key, now());
      log.warn?.(`[phrases] 決まった言葉を作れないので、用意した言葉を使います: ${e.message}`);
    } finally { if (making === key) making = null; }
  }
  // 今の話し方の言葉。まだ作っていなければ作り始めて、できるまでは用意した言葉を返す
  function get() {
    const p = persona();
    const key = keyOf(p);
    if (saved?.key === key) return saved.phrases;
    const lastFail = failed.get(key);
    if (making !== key && !(lastFail !== undefined && now() - lastFail < RETRY_MS)) make(p, key);
    return defaultsFor(p);
  }

  const ready = () => saved?.key === keyOf(persona());
  const routes = routeTable([
    ["GET", "/api/phrases", (req, res) => { const phrases = get(); sendJson(res, 200, { phrases, ready: ready() }); }],
  ]);
  return { get, ready, routes };
}

module.exports = { createPhrases, cleanPhrases, promptFor, parseJson, runClaude, defaultsFor, keyOf, KINDS, POLITE, CASUAL };
