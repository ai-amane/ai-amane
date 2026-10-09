// 資料のパネルに出すものの API（作業フォルダのファイル・Web ページの下調べ・画像の中継）
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream");
const { sendJson, readBody, routeTable } = require("./http-util");
const { inspect, mapEmbed, routeEmbed, fetchImage } = require("./web-page");

const FILE_TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm",
};
const isHtml = (p) => /\.html?$/i.test(p);
// 取りに行けなかった理由 → HTTP のステータス
const STATUS_OF = { EBLOCKED: 403, EBUSY: 429, ENOTIMAGE: 415 };
// SVG などに埋め込まれたスクリプトが、この画面の権限で動かないようにする
const SANDBOX_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'";
// 作業フォルダの HTML（作業担当が作ったゲームや動くページ）。スクリプトは動かすが、この画面とは別の隔離された場所（名前のないオリジン）で動き、
//  この画面・Cookie・保存した設定・API・外のサイトには触れない（通信・フォーム・別の窓もできない）。
//  中で使えるのは、ファイルに書かれたスクリプト・スタイルと、data: / blob: の画像・音・フォントだけ（1 つのファイルにまとめて作ってもらう）
const APP_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
  + "img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'";
// HTML を入れる枠の外側（/api/app-frame。この画面と同じオリジンの、スクリプトのないページ）。
//  中の枠が自分で外のサイトへ移動するのを止める（移動先は、この外側のページの frame-src で決まる。画面の CSP は https を許しているため）。
//  このサーバーの中への移動も、API はほかのサイトからの呼び出しとして断り（crossSiteApi）、画面は埋め込ませない（frame-ancestors）
const WRAP_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";
const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// fp が dirs のどれかの中にあるか（Windows はパスの大文字・小文字を区別しない）
const foldCase = (s) => (process.platform === "win32" ? s.toLowerCase() : s);
const insideDirs = (fp, dirs) => dirs.some((d) => foldCase(fp) === foldCase(d) || foldCase(fp).startsWith(foldCase(d) + path.sep));

// showDirs: 表示してよいフォルダ（先頭が作業フォルダ。相対パスはここから探す）
function createDisplayRoutes({ showDirs, webOptions = {} }) {
  function sendFile(req, res, raw) {
    const notAllowed = () => sendJson(res, 403, { error: "表示できるのは作業フォルダ（と SHOW_DIRS）の中のファイルだけです" });
    const real = showDirs.filter((d) => fs.existsSync(d)).map((d) => fs.realpathSync(d));
    const roots = [...showDirs, ...real];
    const asked = path.resolve(showDirs[0], raw);
    // ファイルに触る前に、許可したフォルダの中かを確かめる（\\サーバー\共有 を開かせて Windows のログイン情報を
    // 送らせる手口や、ほかの場所にファイルがあるかどうかを探られるのを防ぐ）
    if (/^[\\/]{2}/.test(asked) || !insideDirs(asked, roots)) return notAllowed();
    if (!fs.existsSync(asked)) return sendJson(res, 404, { error: "ファイルが見つかりません: " + raw });
    const fp = fs.realpathSync(asked); // ショートカット（シンボリックリンク）で外に出られないよう、実体の場所でも判定する
    if (!insideDirs(fp, real)) return notAllowed();
    if (!fs.statSync(fp).isFile()) return sendJson(res, 404, { error: "ファイルが見つかりません: " + raw });
    const ext = path.extname(fp).toLowerCase();
    // HTML を動かすのは作業フォルダの中のものだけ（SHOW_DIRS で足したフォルダの、保存した Web ページなどは文字で出す）
    const app = isHtml(fp) && fs.existsSync(showDirs[0]) && insideDirs(fp, [fs.realpathSync(showDirs[0])]);
    // 動かす HTML は、パネルの枠に読み込むときだけ渡す（タブで直接開いて、この PC のアドレスで本物らしく見せる偽のページにさせない）
    if (app && req.method !== "HEAD" && req.headers["sec-fetch-dest"] !== "iframe") {
      return sendJson(res, 403, { error: "HTML は、画面のパネルの中でだけ開けます" });
    }
    const headers = {
      "Content-Type": app ? "text/html; charset=utf-8" : FILE_TYPES[ext] || "text/plain; charset=utf-8",
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",   // ほかのサイトのページに読み込ませない
    };
    // PDF はブラウザのビューアーが必要なので sandbox にしない。動かす HTML は隔離した場所でスクリプトを動かす
    res.writeHead(200, ext === ".pdf" ? headers : { ...headers, "Content-Security-Policy": app ? APP_CSP : SANDBOX_CSP });
    if (req.method === "HEAD") return res.end();   // あるかどうかの確認（パネルが先に確かめる）。中身は読まない
    // 読めなかったとき（権限がない・作業が消した直後など）も、サーバーが落ちないように
    return pipeline(fs.createReadStream(fp), res, () => {});
  }

  // HTML を入れる枠の外側（WRAP_CSP）。スクリプトはなく、中の枠（sandbox="allow-scripts"）に /api/file を読み込むだけ
  function sendAppFrame(res, raw) {
    if (!isHtml(raw)) return sendJson(res, 400, { error: "HTML のファイルではありません" });
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": WRAP_CSP, "X-Frame-Options": "SAMEORIGIN", "Referrer-Policy": "no-referrer",
    });
    return res.end('<!doctype html><meta charset="utf-8"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block}</style>'
      + `<iframe sandbox="allow-scripts" allow="" referrerpolicy="no-referrer" src="${escAttr("/api/file?path=" + encodeURIComponent(raw))}"></iframe>`);
  }

  // Web ページ・YouTube・地図をパネルに出すための下調べ（lib/web-page.js。家の中の機器には行かない）
  async function sendInspect(req, res) {
    const raw = String((await readBody(req)).url || "").trim().slice(0, 2000);
    if (/^map:/i.test(raw)) {
      const embed = mapEmbed(raw.slice(4));
      return embed ? sendJson(res, 200, { kind: "embed", url: raw, embed, title: raw.slice(4).trim() }) : sendJson(res, 400, { error: "場所がありません" });
    }
    // 道順（route:出発地|目的地|手段）
    if (/^route:/i.test(raw)) {
      const embed = routeEmbed(raw.slice(6));
      const [from = "", to = ""] = raw.slice(6).split(/[|｜]/).map((s) => s.trim());
      return embed ? sendJson(res, 200, { kind: "embed", url: raw, embed, title: `${from} → ${to}` }) : sendJson(res, 400, { error: "出発地と目的地がありません（route:出発地|目的地）" });
    }
    try { return sendJson(res, 200, await inspect(raw, webOptions)); }
    catch (e) { return sendJson(res, STATUS_OF[e.code] || 502, { error: e.message }); }
  }

  // ほかのサイトの画像の中継（ブラウザが家の中の機器を直接読みに行かないように。SVG は中継しない）
  async function sendImage(res, raw) {
    try {
      const { type, body } = await fetchImage(String(raw).slice(0, 2000), webOptions);
      res.writeHead(200, {
        "Content-Type": type, "Content-Length": body.length, "Cache-Control": "private, max-age=600",
        "X-Content-Type-Options": "nosniff", "Content-Security-Policy": SANDBOX_CSP, "Cross-Origin-Resource-Policy": "same-origin",
      });
      return res.end(body);
    } catch (e) { return sendJson(res, STATUS_OF[e.code] || 502, { error: e.message }); }
  }

  return routeTable([
    ["*", "/api/file", (req, res, url) => sendFile(req, res, url.searchParams.get("path") || "")],
    ["GET", "/api/app-frame", (req, res, url) => sendAppFrame(res, String(url.searchParams.get("path") || "").slice(0, 1000))],
    ["POST", "/api/web/inspect", sendInspect],
    ["GET", "/api/web/image", (req, res, url) => sendImage(res, url.searchParams.get("url") || "")],
  ]);
}

module.exports = { createDisplayRoutes };
