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
// 取りに行けなかった理由 → HTTP のステータス
const STATUS_OF = { EBLOCKED: 403, EBUSY: 429, ENOTIMAGE: 415 };
// SVG などに埋め込まれたスクリプトが、この画面の権限で動かないようにする
const SANDBOX_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'";

// fp が dirs のどれかの中にあるか（Windows はパスの大文字・小文字を区別しない）
const foldCase = (s) => (process.platform === "win32" ? s.toLowerCase() : s);
const insideDirs = (fp, dirs) => dirs.some((d) => foldCase(fp) === foldCase(d) || foldCase(fp).startsWith(foldCase(d) + path.sep));

// showDirs: 表示してよいフォルダ（先頭が作業フォルダ。相対パスはここから探す）
function createDisplayRoutes({ showDirs, webOptions = {} }) {
  function sendFile(res, raw) {
    const notAllowed = () => sendJson(res, 403, { error: "表示できるのは作業フォルダ（と SHOW_DIRS）の中のファイルだけです" });
    const roots = [...showDirs, ...showDirs.filter((d) => fs.existsSync(d)).map((d) => fs.realpathSync(d))];
    const asked = path.resolve(showDirs[0], raw);
    // ファイルに触る前に、許可したフォルダの中かを確かめる（\\サーバー\共有 を開かせて Windows のログイン情報を
    // 送らせる手口や、ほかの場所にファイルがあるかどうかを探られるのを防ぐ）
    if (/^[\\/]{2}/.test(asked) || !insideDirs(asked, roots)) return notAllowed();
    if (!fs.existsSync(asked)) return sendJson(res, 404, { error: "ファイルが見つかりません: " + raw });
    const fp = fs.realpathSync(asked); // ショートカット（シンボリックリンク）で外に出られないよう、実体の場所でも判定する
    if (!insideDirs(fp, roots.slice(showDirs.length))) return notAllowed();
    if (!fs.statSync(fp).isFile()) return sendJson(res, 404, { error: "ファイルが見つかりません: " + raw });
    const ext = path.extname(fp).toLowerCase();
    const headers = {
      "Content-Type": FILE_TYPES[ext] || "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",   // ほかのサイトのページに読み込ませない
    };
    // PDF はブラウザのビューアーが必要なので sandbox にしない
    res.writeHead(200, ext === ".pdf" ? headers : { ...headers, "Content-Security-Policy": SANDBOX_CSP });
    // 読めなかったとき（権限がない・作業が消した直後など）も、サーバーが落ちないように
    return pipeline(fs.createReadStream(fp), res, () => {});
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
    ["*", "/api/file", (req, res, url) => sendFile(res, url.searchParams.get("path") || "")],
    ["POST", "/api/web/inspect", sendInspect],
    ["GET", "/api/web/image", (req, res, url) => sendImage(res, url.searchParams.get("url") || "")],
  ]);
}

module.exports = { createDisplayRoutes };
