// HTTP の API で使う共通の部品
function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

// JSON の本文（オブジェクトでなければ・読めなければ・大きすぎれば、空のオブジェクト）
//  文字がチャンクの境目で切れても化けないよう、バイトのまま集めてから読む
function readBody(req, limit = 1e6) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0, done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { finish({}); req.destroy(); } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        finish(v && typeof v === "object" && !Array.isArray(v) ? v : {});
      } catch { finish({}); }
    });
    req.on("error", () => finish({}));
    req.on("close", () => finish({}));
  });
}

// 音声などのバイナリの本文
function readRaw(req, limit = 8e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ほかのサイトのページから API を呼ばせない（<img> などからの GET には Origin が付かないので、ブラウザが付ける
// Sec-Fetch-Site で見分ける）。ヘッダーが無いのは、ブラウザ以外（新しく起動したサーバーなど）か古いブラウザ
//  pathname: 解析したパス（絶対形式の要求 GET http://…/api/… でも見分けられるように）
function crossSiteApi(req, pathname = req.url) {
  if (!String(pathname || "").startsWith("/api/")) return false;
  const site = req.headers["sec-fetch-site"];
  return Boolean(site) && site !== "same-origin" && site !== "none";
}

// [method, path, handler] の表から、合うものを呼ぶ（合うものが無ければ false を返す）。method が "*" ならどれでも
function routeTable(table) {
  return async (req, res, url) => {
    const hit = table.find(([method, p]) => (method === "*" || method === req.method) && p === url.pathname);
    if (!hit) return false;
    await hit[2](req, res, url);
    return true;
  };
}

module.exports = { sendJson, readBody, readRaw, crossSiteApi, routeTable };
