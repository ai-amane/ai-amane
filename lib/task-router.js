// 作業の振り分け（light: すぐ終わる作業 / heavy: じっくり考える作業）
//  router: auto | laya | hint | rules
//   laya: 振り分け用の小さなモデル（LAYA_URL）に聞く。auto は Laya が無ければ規則で決める
//   hint: 会話の AI が付けた目安を使う  rules: 言葉の規則で決める
const HEAVY_WORDS = /(設計|リファクタ|全体|大規模|まとめて全部|調査して|比較して|原因を|デバッグ|移行|アーキテクチャ|テストを書|実装して|作り直|レビュー|分析)/;
const LIGHT_WORDS = /(開いて|一覧|リネーム|名前を変え|コピー|移動|探して|検索|確認して|メモ|追記|何時|日付|サイズ|数えて)/;

function routeByRules(text) {
  if (HEAVY_WORDS.test(text)) return "heavy";
  if (LIGHT_WORDS.test(text)) return "light";
  return text.length > 80 ? "heavy" : "light";
}

async function routeByLaya(text, layaUrl) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2000);
  try {
    const r = await fetch(layaUrl + "/route", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }), signal: ctrl.signal,
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json(); // { level, confidence }
  } finally { clearTimeout(t); }
}

// → { level: "light" | "heavy", by: 決めた方法 }
function createRouter({ router = "auto", layaUrl, minConfidence = 0.6, log = console }) {
  return async function decideLevel(text, hint) {
    if (router === "hint" && hint) return { level: hint, by: "agent" };
    if (router === "rules") return { level: routeByRules(text), by: "rules" };
    if (router === "laya" || router === "auto") {
      try {
        const { level, confidence } = await routeByLaya(text, layaUrl);
        if (level === "light" || level === "heavy") {
          // 自信がないときは重い側に倒す
          const final = confidence != null && confidence < minConfidence ? "heavy" : level;
          return { level: final, by: `laya(${level}, ${confidence != null ? Number(confidence).toFixed(2) : "?"})` };
        }
      } catch (e) {
        if (router === "laya") log.warn("[router] Laya unavailable:", e.message);
      }
    }
    if (hint === "light" || hint === "heavy") return { level: hint, by: "agent" };
    return { level: routeByRules(text), by: "rules" };
  };
}

module.exports = { routeByRules, createRouter };
