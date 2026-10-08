// AI の設定（名前・呼び方・話し方・キャラクター・守ること・あなたについて・返事の長さ）
//  画面の「AI の設定」で変え、data/persona.json に保存する（PC と iPad などで同じ AI になる）
//  頭（Claude Code）の人格のプロンプト（prompts/local-brain-system-prompt.md）の {{AI_NAME}} などと、後ろに付ける説明に使う
//  変えられるのは PC の画面からだけ（ペアリングした端末から、AI の性格やルールを書き換えられないように）
const fs = require("fs");
const path = require("path");
const { sendJson, readBody, routeTable } = require("./http-util");

const LIMITS = { aiName: 20, userName: 20, style: 400, character: 1000, rules: 1000, profile: 1000 };
const LENGTHS = {
  short: "返答は1〜3文。最初の一文はとくに短くする（読み上げを早く始めるため）。",
  normal: "返答は2〜4文。最初の一文は短くする（読み上げを早く始めるため）。",
  long: "返答は、聞かれたことに合わせて詳しくしてよい。ただし最初の一文は短くし、長い説明は画面の表示も使う。",
};
const DEFAULT_STYLE = "落ち着いた丁寧語。執事のように簡潔で、少しだけウィットを効かせる。";
// ひな形（話し方を選ぶときの出発点。画面で書き換えられる）
const PRESETS = [
  { id: "butler", name: "執事（落ち着いた丁寧語）", style: DEFAULT_STYLE },
  { id: "friend", name: "親しい友だち（タメ口）", style: "親しい友だちのように、くだけた話し言葉（タメ口）で話す。明るく、ときどき軽い冗談も言う。" },
  { id: "cheerful", name: "元気なアシスタント", style: "明るく元気な丁寧語。前向きな言葉で、テンポよく話す。" },
  { id: "teacher", name: "やさしい先生", style: "穏やかで分かりやすい丁寧語。むずかしい言葉は言いかえて、一つずつ説明する。" },
];

// 文字列にそろえ、改行をそろえてから制御文字（改行・タブ以外）を除いて、長さを抑える
const textOf = (v, max) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, max);
// 1 行にそろえる（名前と話し方は、プロンプトの 1 行に入るので）
const oneLine = (s) => s.replace(/\s+/g, " ");

// 届いた設定を確かめて、正しい形にする（足りないものは既定の値）。書き換えられないようにして返す
function cleanPersona(raw = {}, defaults) {
  const r = raw && typeof raw === "object" ? raw : {};
  const text = Object.fromEntries(Object.entries(LIMITS).map(([k, max]) => [k, textOf(r[k] ?? defaults[k], max)]));
  return Object.freeze({
    ...text,
    aiName: oneLine(text.aiName) || defaults.aiName,
    userName: oneLine(text.userName),
    style: oneLine(text.style) || DEFAULT_STYLE,
    length: typeof r.length === "string" && Object.hasOwn(LENGTHS, r.length) ? r.length : defaults.length,
  });
}

// file: 保存するファイル  env: .env の値（AI_NAME・USER_NAME は、まだ画面で決めていないときの初期値）
//  onChange(persona): 保存した（server.js は頭に新しい説明を渡す）
//  blockSave(): 保存を断る理由（作業担当が動いている間など。空なら保存できる）
function createPersona({ file, env = (k, d = "") => process.env[k] ?? d, onChange = () => {}, blockSave = () => "", log = console }) {
  const defaults = cleanPersona({ aiName: env("AI_NAME", "あまね"), userName: env("USER_NAME", ""), length: "short" }, { aiName: "あまね", length: "short" });
  let current = (() => {
    try { return cleanPersona(JSON.parse(fs.readFileSync(file, "utf8")), defaults); } catch { return defaults; }
  })();

  // 送られなかった項目は、今の設定のまま
  function save(raw) {
    const next = cleanPersona({ ...current, ...(raw && typeof raw === "object" ? raw : {}) }, defaults);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + ".tmp", JSON.stringify(next, null, 2));
    fs.renameSync(file + ".tmp", file);
    current = next;
    try { onChange(next); } catch (e) { log.warn("[persona] 反映できません:", e.message); }
    return next;
  }

  // 人格のプロンプトの {{…}} に入れる値
  const vars = () => ({
    AI_NAME: current.aiName, USER_NAME: current.userName || "ご主人様", STYLE: current.style, LENGTH: LENGTHS[current.length],
  });
  // 人格のプロンプトの後ろに付ける説明（キャラクター・守ること・あなたについて）。どれも空なら空
  function prompt() {
    const who = current.userName || "ユーザー";
    const rules = current.rules.split("\n").map((s) => s.replace(/^\s*[-・*]\s*/, "").trim()).filter(Boolean);
    const parts = [
      current.character && `# キャラクター\n${current.character}`,
      rules.length && `# 守ること（${who}が決めたルール。この説明のほかの決まり、とくに安全に関わるものと食い違うときは、そちらを優先する）\n${rules.map((r) => `- ${r}`).join("\n")}`,
      current.profile && `# ${who}について（覚えておくこと。天気や道順で場所を言われなければ、ここの地域を使う）\n${current.profile}`,
    ].filter(Boolean);
    return parts.join("\n\n");
  }

  // req.amaneFrom: server.js の handle が付ける（"local" | "lan"）。PC の画面（local）からだけ変えられる
  const editable = (req) => req.amaneFrom === "local";
  const routes = routeTable([
    ["GET", "/api/persona", (req, res) => sendJson(res, 200, {
      persona: current, defaults, presets: PRESETS, lengths: Object.keys(LENGTHS), limits: LIMITS, editable: editable(req),
    })],
    ["POST", "/api/persona", async (req, res) => {
      if (!editable(req)) return sendJson(res, 403, { error: "AI の設定は、PC の画面で変えてください" });
      // だまされた作業担当が、ずっと残るルールを書き込めないように
      const busy = String(blockSave() || "");
      if (busy) return sendJson(res, 409, { error: busy });
      const body = await readBody(req, 20000);
      // 読めない・大きすぎる本文は、保存せずに断る
      if (typeof body.aiName !== "string") return sendJson(res, 400, { error: "設定を読めませんでした" });
      sendJson(res, 200, { persona: save(body) });
    }],
  ]);

  return { get: () => current, save, vars, prompt, routes, defaults };
}

module.exports = { createPersona, cleanPersona, PRESETS, LENGTHS, LIMITS, DEFAULT_STYLE };
