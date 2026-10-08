// 追加機能（lib/plugins.js）の読み込み: plugins/<名前>/plugin.js を読み、形を確かめる
const fs = require("fs");
const path = require("path");
const { normalizeParams } = require("./plugin-args");

const ID_RE = /^[a-z][a-z0-9-]{0,30}$/;          // プラグインの名前（フォルダ名と同じ）
const ACTION_RE = /^[a-z][a-zA-Z0-9_]{0,30}$/;   // 動作の名前
// この本体が持っている仕組み。プラグインは requires に、使う仕組みを書く（無い仕組みを使うプラグインは読み込まない）
const FEATURES = new Set(["confirm", "confirm-voice", "prompt-function", "async-start", "prompt-changed", "enabled", "signal"]);
// 確認を声でも決めてよいか: any（だれの声でも）| owner（呼びかけた人の声だけ。声紋がオンのとき。既定）| none（画面のボタンだけ）
const CONFIRM_VOICES = ["any", "owner", "none"];

// プラグインごとの保存場所（data/plugins/<名前>.json）。書きかけで壊れないよう、別のファイルに書いてから置き換える
function createStore(dataDir, id) {
  const file = path.join(dataDir, `${id}.json`);
  return {
    load(fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } },
    save(value) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file + ".tmp", JSON.stringify(value));
      fs.renameSync(file + ".tmp", file);
    },
  };
}

const isTextOrFn = (v) => v == null || typeof v === "string" || typeof v === "function";

// 動作の形を確かめる → 組み立て直した引数の決まり
function checkAction(name, a) {
  if (!ACTION_RE.test(name)) throw new Error(`動作の名前が正しくありません: ${name}`);
  if (typeof a?.run !== "function") throw new Error(`動作 ${name} に run がありません`);
  if (a.kind && !["command", "query"].includes(a.kind)) throw new Error(`動作 ${name} の kind は command か query です`);
  if (a.description != null && typeof a.description !== "string") throw new Error(`動作 ${name} の description は文字列にしてください`);
  if (a.usage != null && ![].concat(a.usage).every((u) => typeof u === "string")) throw new Error(`動作 ${name} の usage は文字列（か、その配列）にしてください`);
  // confirm は、空の文字列も断る（安全のための確認が、書き間違いで黙って外れないように）
  if (!isTextOrFn(a.confirm) || a.confirm === "") throw new Error(`動作 ${name} の confirm は、空でない文字列か関数にしてください`);
  if (a.confirmLabel != null && (typeof a.confirmLabel !== "string" || !a.confirmLabel.trim() || a.confirmLabel.length > 12)) throw new Error(`動作 ${name} の confirmLabel は 12 文字までの文字列にしてください`);
  if (a.confirmVoice != null && !CONFIRM_VOICES.includes(a.confirmVoice)) throw new Error(`動作 ${name} の confirmVoice は ${CONFIRM_VOICES.join(" / ")} のどれかにしてください`);
  for (const k of ["enabled", "localOnly"]) {
    if (a[k] != null && typeof a[k] !== "boolean" && typeof a[k] !== "function") throw new Error(`動作 ${name} の ${k} は true / false か関数にしてください`);
  }
  return normalizeParams(a.params, `${name}.`);
}

// プラグインの形を確かめる（足りなければ Error）。引数の決まりは、組み立て直したものを返す（元のプラグインは書き換えない）
function checkPlugin(p, folder) {
  if (!p || typeof p !== "object") throw new Error("plugin.js がオブジェクトを返していません");
  if (!ID_RE.test(String(p.id || ""))) throw new Error(`id が正しくありません（英小文字・数字・ハイフン）: ${p.id}`);
  if (folder && p.id !== folder) throw new Error(`id（${p.id}）がフォルダ名（${folder}）と違います`);
  const missing = [].concat(p.requires || []).map(String).filter((f) => !FEATURES.has(f));
  if (missing.length) throw new Error(`この本体では使えません。本体を新しい版にしてください（足りない仕組み: ${missing.join("・")}）`);
  // 頭への説明に入る文（書き間違いで頭が起動できなくならないように）
  for (const k of ["name", "description"]) if (p[k] != null && typeof p[k] !== "string") throw new Error(`${k} は文字列にしてください`);
  if (!isTextOrFn(p.prompt)) throw new Error("prompt は文字列か関数にしてください");
  const specs = {};
  for (const [name, a] of Object.entries(p.actions || {})) specs[name] = checkAction(name, a);
  return { plugin: p, specs };
}

// フォルダからプラグインを読み込む。壊れたプラグインがあっても、ほかのプラグインとサーバーは動かす
function loadFromDir(dir, { off = [], log = console } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); }
  catch { return []; }
  const out = [];
  for (const name of names) {
    if (off.includes(name) || !ID_RE.test(name)) continue;
    const file = path.resolve(dir, name, "plugin.js");   // require は相対パスをモジュール名として探すので、絶対パスにする
    if (!fs.existsSync(file)) continue;
    try { const p = require(file); checkPlugin(p, name); out.push(p); }
    catch (e) { log.warn(`[plugins] ${name} を読み込めません: ${e.message}`); }
  }
  return out;
}

module.exports = { createStore, checkPlugin, loadFromDir, FEATURES };
