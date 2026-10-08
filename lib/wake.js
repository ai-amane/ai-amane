// 呼びかけ（「あまね」など）の判定（server.js の /api/wake）。下の説明の例は、呼びかけの言葉が「ひかり」のとき
// 周りの会話を拾わないよう、次をすべて満たすときだけ呼びかけとみなす
//  ・発話の先頭（「やあ」「ねえ」などの後ろ）にある … 「今日は光が」を除く
//  ・長い単語の一部ではない … 「光る」「光が丘」を除く（辞書で一語になっている単語だけ。辞書が区切る言葉は区別できない）
//  ・直後に助詞・助動詞・「する」が続かない … 「光の速さ」「ひかりって」「ひかりして」を除く
// 読みは単語ごとに直して比べるので、「光」と認識されても「ひかり」に一致する
const path = require("path");

// ---------- 読み仮名（kuromoji があれば） ----------
// 音声認識は「ひかり」を「光」のように漢字で返すことがあるので、読みに直して比較する
let tokenizerPromise = null;
function getTokenizer(log = console) {
  if (tokenizerPromise) return tokenizerPromise;
  tokenizerPromise = new Promise((resolve) => {
    try {
      const kuromoji = require("kuromoji");
      const dicPath = path.join(path.dirname(require.resolve("kuromoji")), "..", "dict");
      kuromoji.builder({ dicPath }).build((err, t) => {
        if (err) { log.warn("[reading] kuromoji の辞書を読めません:", err.message); resolve(null); }
        else { log.log("[reading] kuromoji ready"); resolve(t); }
      });
    } catch { log.warn("[reading] kuromoji 未インストール（漢字の読み判定は無効）"); resolve(null); }
  });
  return tokenizerPromise;
}

const hira2kata = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
const normalizeKana = (s) => hira2kata(String(s).normalize("NFKC").toLowerCase())
  .replace(/ヴィ/g, "ビ").replace(/ヴ/g, "ブ")
  .replace(/[\s、。，．,.!！?？「」『』・ー〜~-]/g, "");
// 長音のゆれを吸収（コウコウ→ココ、センセイ→センセ）
const foldKana = (s) => normalizeKana(s)
  .replace(/([オコソトノホモヨロゴゾドボポョォ])ウ/g, "$1")
  .replace(/([エケセテネヘメレゲゼデベペェ])イ/g, "$1");
// 呼びかけの前に付けてよい言葉（「あの」は「あの光」のように使われるので入れない）
const WAKE_PREFIX = "(?:" + ["やあ", "やぁ", "ねえ", "ねぇ", "おい", "ほら", "はい", "えっと", "えーと", "ちょっと", "もしもし", "ヘイ", "オーケー", "オッケー", "hey", "okay", "ok"].map(foldKana).join("|") + ")*";
const HAS_KANJI = /[一-鿿]/;
const readingOf = (k) => (k.reading && k.reading !== "*" ? k.reading : hira2kata(k.surface_form));

// 読み（長音を吸収したもの）の end 文字目より後ろの表記。一致が漢字の単語の途中で終わるなら null（長い単語の一部）
//  start: 呼びかけの言葉が始まる位置。呼びかけの言葉が、1 つの長い単語の頭の部分なら null（「あまね」と「あまねく」）
function surfaceAfter(toks, end, start = 0) {
  let pos = 0;
  for (let i = 0; i < toks.length; i++) {
    const { s, f } = toks[i];
    if (pos + f.length <= end) { pos += f.length; if (pos === end) return toks.slice(i + 1).map((k) => k.s).join(""); continue; }
    if (HAS_KANJI.test(s) || pos <= start) return null;
    // かなの単語の途中で終わっている（kuromoji が「みおさん」を「み|おさん」と区切るなど）→ その位置で切る
    for (let c = s.length; c > 0; c--) if (foldKana(s.slice(0, c)).length === end - pos) return s.slice(c) + toks.slice(i + 1).map((k) => k.s).join("");
    return null;
  }
  return "";
}

// → { hit, reading, rest? }  rest: 呼びかけに続けて言った用件（なければ空）
async function detectWake(text, words) {
  const t = await getTokenizer();
  // kuromoji が無いときは 1 文字ずつ区切る（漢字の読みと品詞は使えない）
  const toks = (t ? t.tokenize(text).map((k) => ({ s: k.surface_form, r: readingOf(k) })) : [...text].map((c) => ({ s: c, r: c })))
    .map((k) => ({ ...k, f: foldKana(k.r) }));
  const folded = toks.map((k) => k.f).join("");
  const reading = toks.map((k) => k.r).join("");
  const wakes = words.map((w) => foldKana(t && HAS_KANJI.test(w) ? t.tokenize(w).map(readingOf).join("") : w))
    .filter(Boolean).sort((a, b) => b.length - a.length);
  for (const fw of wakes) {
    const m = folded.match(new RegExp("^" + WAKE_PREFIX + fw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    if (!m) continue;
    const rest = surfaceAfter(toks, m[0].length, m[0].length - fw.length);
    if (rest === null) continue;
    const next = t && rest ? t.tokenize(rest).find((k) => k.pos !== "記号") : null;
    if (next && ((next.pos === "助詞" && !/終助詞|間投助詞/.test(next.pos_detail_1)) || next.pos === "助動詞" || (next.pos === "動詞" && next.basic_form === "する"))) continue;
    // 呼びかけに続けて言った用件（「あまねちゃん」の「ちゃん」などは除く）
    const ask = rest.replace(/^[\s、。，．,.!！?？]*(ちゃん|さん|くん|さま|様)?[\s、。，．,.!！?？]*/, "").trim();
    return { hit: true, reading, rest: normalizeKana(ask).length >= 3 ? ask : "" };
  }
  return { hit: false, reading };
}

module.exports = { detectWake, getTokenizer };
