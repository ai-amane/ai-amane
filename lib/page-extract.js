// Web ページの本文の取り出し（Firefox のリーダー表示と同じ Readability を使う）
//  細工したページ（入れ子がとても深いなど）では時間がかかることがあるので、lib/web-page.js が別のスレッド（worker）で動かし、
//  時間がかかりすぎたら止める。ここに書いた処理はサーバーの本体では動かさない
const { parentPort, workerData, isMainThread } = require("worker_threads");

const MAX_MARKDOWN = 8000;
const MAX_INPUT = 1_000_000;   // 取り出しに渡す HTML の長さ（スクリプトとスタイルを除いたあと）
const LIMITS = { title: 300, description: 1000, siteName: 100, image: 2000 };

const clip = (s, n) => String(s || "").trim().slice(0, n);
const absUrl = (u, base) => {
  if (!u) return "";   // 空なら（new URL は空をページ自身の URL にしてしまう）
  try { const x = new URL(u, base); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch { return ""; }
};
// 題名だけを取り出す（本文を取り出せなかったときの予備）。細工した HTML でも長さに比例する時間で終わるよう、
// 繰り返しに上限を付け、先頭だけを見る
const titleOf = (html) => clip((String(html).slice(0, 200000).match(/<title\b[^<>]{0,500}>([^<]{0,1000})/i) || [])[1], LIMITS.title);

// スクリプト・スタイルの中身は本文に要らないので、解析の前に除く（大手サイトは数百 KB のスクリプトを埋め込んでいる）
//  正規表現の繰り返しは閉じタグのないページで遅くなるので、indexOf で一度だけ読み進める
//  （次の <script / <style の位置は覚えておき、読み進めた位置より前になったときだけ探し直す。見つからなければ -1 のまま）
function stripHeavy(html) {
  // 長さの変わらない小文字化（toLowerCase は「İ」などで長さが変わり、位置がずれる）
  const lower = html.replace(/[A-Z]+/g, (s) => s.toLowerCase());
  const out = [];
  let pos = 0, s = -2, t = -2;
  for (;;) {
    if (s !== -1 && s < pos) s = lower.indexOf("<script", pos);
    if (t !== -1 && t < pos) t = lower.indexOf("<style", pos);
    const start = s < 0 ? t : t < 0 ? s : Math.min(s, t);
    if (start < 0) break;
    const close = start === s ? "</script" : "</style";
    const end = lower.indexOf(close, start);
    out.push(html.slice(pos, start));
    if (end < 0) { pos = html.length; break; }
    pos = lower.indexOf(">", end) + 1 || html.length;
  }
  out.push(html.slice(pos));
  return out.join("").slice(0, MAX_INPUT);
}

// Readability が取り出した本文（HTML）を、パネルの簡易 Markdown にする
function toMarkdown(root) {
  const blocks = [];
  let size = 0;
  for (const el of root.querySelectorAll("h1, h2, h3, h4, p, li, pre, blockquote")) {
    if (el.parentElement?.closest("li, pre, blockquote")) continue;   // 入れ子は外側でまとめて取る
    const text = el.tagName === "PRE" ? el.textContent.trim() : el.textContent.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const tag = el.tagName.toLowerCase();
    const line = tag === "h1" ? `# ${text}` : tag === "h2" ? `## ${text}` : /h[34]/.test(tag) ? `### ${text}`
      : tag === "li" ? `- ${text}` : tag === "pre" ? "```\n" + text + "\n```" : tag === "blockquote" ? `> ${text}` : text;
    blocks.push(line.slice(0, MAX_MARKDOWN));
    size += line.length;
    if (size > MAX_MARKDOWN) { blocks.push("（長いので、ここまでにしています）"); break; }
  }
  // 箇条書きは続けて、ほかは空行で区切る
  return blocks.reduce((md, b, i) => md + (i === 0 ? "" : b.startsWith("- ") && blocks[i - 1].startsWith("- ") ? "\n" : "\n\n") + b, "");
}

// → { title, description, image, siteName, markdown }
function extractPage(html, url) {
  let parseHTML, Readability;
  try {
    ({ parseHTML } = require("linkedom"));
    ({ Readability } = require("@mozilla/readability"));
  } catch {
    // パッケージが入っていない（npm install 前）ときは、題名だけ
    return { title: titleOf(html), description: "", image: "", siteName: "", markdown: "（本文を取り出すには、npm install でパッケージを入れてください）" };
  }
  const { document } = parseHTML(stripHeavy(String(html)));
  const meta = (sel) => (document.querySelector(sel)?.getAttribute("content") || "").trim();
  const info = {
    title: clip(meta('meta[property="og:title"]') || document.querySelector("title")?.textContent, LIMITS.title),
    description: clip(meta('meta[property="og:description"]') || meta('meta[name="description"]'), LIMITS.description),
    image: clip(absUrl(meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]'), url), LIMITS.image),
    siteName: clip(meta('meta[property="og:site_name"]'), LIMITS.siteName),
  };
  let markdown = "";
  let title = info.title;
  try {
    const article = new Readability(document).parse();   // document を書き換えるので、上の情報を先に取る
    if (article?.content) markdown = toMarkdown(parseHTML(`<!doctype html><html><body>${article.content}</body></html>`).document.body);
    if (!title && article?.title) title = clip(article.title, LIMITS.title);
  } catch { /* 本文を取り出せないページは、題名と説明だけ */ }
  return { ...info, title, markdown };
}

// 別のスレッドとして起動されたとき（lib/web-page.js の extractInWorker）
if (!isMainThread && parentPort && workerData?.task === "extract") {
  parentPort.postMessage(extractPage(workerData.html, workerData.url));
}

module.exports = { extractPage, titleOf };
