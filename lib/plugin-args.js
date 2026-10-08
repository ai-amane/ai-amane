// 追加機能（lib/plugins.js）の引数の確かめ方
//  頭が書いたタグの属性（すべて文字列）を、プラグインが決めた型（number / boolean / string）に直して確かめる
const NUMBER_RE = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;  // 数の書き方（0x10 や 1e3 は数として受け取らない）
const TYPES = new Set(["number", "boolean", "string"]);
const STR_MAX = 200;        // 文字列の引数の長さの上限（プラグインが max を決めなければ）

// 引数の決まりを確かめて、使いやすい形にする（プラグインを読み込むときに 1 回。合わなければ Error で、そのプラグインは使わない）
//  params: { 名前: "number" | { type, optional, min, max, integer, pattern, enum, multiline, desc } }
const NORMALIZED = Symbol("normalized");
function normalizeParams(params = {}, where = "") {
  if (params?.[NORMALIZED]) return params;
  const out = Object.defineProperty({}, NORMALIZED, { value: true });
  for (const [name, spec0] of Object.entries(params || {})) {
    const spec = typeof spec0 === "string" ? { type: spec0 } : { ...(spec0 || {}) };
    const at = `${where}${name}`;
    if (!TYPES.has(spec.type)) throw new Error(`${at} の type が正しくありません（number / boolean / string）: ${spec.type}`);
    if (spec.type === "number" && !(Number.isFinite(spec.min) && Number.isFinite(spec.max))) throw new Error(`${at} は min と max を決めてください`);
    if (spec.enum && !Array.isArray(spec.enum)) throw new Error(`${at} の enum は配列にしてください`);
    // pattern は読み込むときに組み立て、必ず値の全体に当てる（「\\d+」が「rm 1」にも当たらないように）
    if (spec.pattern) spec.re = new RegExp(`^(?:${spec.pattern})$`, "u");
    out[name] = spec;
  }
  return out;
}

// 文字列の引数から、改行・制御文字と、頭への知らせの印（［］）・タグの記号（<>）を除く
//  知らせや結果の文に入って頭に戻ったとき、システムからの指示のふりをさせないため（multiline: true なら改行だけ残す）
const cleanText = (s, multiline) => String(s)
  .replace(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, " ")
  .replace(/[［］<>]/g, "");

// タグの属性（すべて文字列）を、プラグインが決めた型に直して確かめる。合わなければ Error（理由は頭がそのまま話せる言葉で）
//  決めていない引数は渡さない
function coerceArgs(params = {}, raw = {}) {
  const specs = normalizeParams(params);   // 読み込むときに組み立て済みなら、そのまま使う
  const out = {};
  for (const [name, spec] of Object.entries(specs)) {
    const v = Object.prototype.hasOwnProperty.call(raw, name) ? raw[name] : undefined;
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
      if (!spec.optional) throw new Error(`${name} がありません`);
      continue;
    }
    if (!["string", "number", "boolean"].includes(typeof v)) throw new Error(`${name} の値が正しくありません`);
    if (spec.type === "number") {
      const s = String(v).trim();
      if (typeof v !== "number" && !NUMBER_RE.test(s)) throw new Error(`${name} は数で指定してください`);
      const n0 = Number(s);
      if (!Number.isFinite(n0)) throw new Error(`${name} は数で指定してください`);
      const n = spec.integer ? Math.round(n0) : n0;   // 丸めてから範囲を確かめる
      if (n < spec.min) throw new Error(`${name} は ${spec.min} 以上にしてください`);
      if (n > spec.max) throw new Error(`${name} は ${spec.max} 以下にしてください`);
      out[name] = n;
    } else if (spec.type === "boolean") {
      const s = String(v).trim().toLowerCase();
      if (!["true", "false", "1", "0"].includes(s)) throw new Error(`${name} は true か false で指定してください`);
      out[name] = s === "true" || s === "1";
    } else {
      const s = cleanText(v, spec.multiline).trim();
      const max = spec.max ?? STR_MAX;
      if (s.length > max) throw new Error(`${name} が長すぎます（${max} 文字まで）`);
      if (spec.enum && !spec.enum.includes(s)) throw new Error(`${name} は ${spec.enum.join("・")} のどれかにしてください`);
      if (spec.re && !spec.re.test(s)) throw new Error(`${name} の形が違います`);
      out[name] = s;
    }
  }
  return out;
}

module.exports = { normalizeParams, coerceArgs, cleanText };
