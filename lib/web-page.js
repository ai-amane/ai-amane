// Web ページをパネルに出すための下調べ（server.js の /api/web/inspect）と、画像の中継（/api/web/image）
//  ・YouTube（音楽・動画）と地図は、埋め込み用の URL にする（ページは取りに行かない）
//  ・ほかのページは取りに行き、埋め込みを許可しているか（X-Frame-Options / CSP の frame-ancestors）を調べる。
//    許可していないページ（大手サイトの多く）は、題名・説明・代表画像と、読みやすく整えた本文（Readability）を返す
//  ・家の中の機器（ルーターの管理画面など）やこの PC には行かない。接続する瞬間の IP アドレスで確かめ、転送先も毎回確かめる。
//    IPv6 は家ごとにインターネット用のアドレスが配られる（NTT の IPoE など）ので、この PC と同じ範囲（/48）にも行かない
//  ・行けるのは 80 / 443 番のポートだけ。ログイン情報入りの URL は開かない
//  ・本文の取り出しは別のスレッドで行い、時間がかかりすぎたら止める（細工したページでサーバーが止まらないように）
const dns = require("dns");
const http = require("http");
const https = require("https");
const net = require("net");
const os = require("os");
const path = require("path");
const { Worker } = require("worker_threads");
const { extractPage, titleOf } = require("./page-extract");

const TIMEOUT_MS = 8000;          // 何も届かない時間の上限
const TOTAL_TIMEOUT_MS = 15000;   // 転送も含めた全体の時間の上限（少しずつ届くページで待たされ続けないように）
const EXTRACT_MS = 4000;          // 本文の取り出しの時間の上限
const MAX_BYTES = 2_000_000;
const MAX_IMAGE_BYTES = 8_000_000;
const MAX_REDIRECTS = 5;
const MAX_INSPECTS = 2;           // 同時に調べるページの数
const MAX_IMAGES = 4;             // 同時に中継する画像の数
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const YT_PARAMS = "autoplay=1&playsinline=1&enablejsapi=1";
const EXTRACT_WORKER = path.join(__dirname, "page-extract.js");
// SVG は中にスクリプトを書けるので、中継しない
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm"]);

// ---------- 行ってよいアドレス ----------
// インターネットのアドレスだけ。プライベート・この PC・リンクローカル（クラウドの管理用アドレスを含む）・
// CGNAT・マルチキャスト・ドキュメント用などの特別なアドレスは断る。
// IPv6 はインターネット用（2000::/3）だけ。その中でも、IPv4 を包んで運ぶもの（Teredo・6to4）などは断る
const SPECIAL = new net.BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]]) SPECIAL.addSubnet(a, p, "ipv4");
for (const [a, p] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]]) SPECIAL.addSubnet(a, p, "ipv6");
const GLOBAL_V6 = new net.BlockList();
GLOBAL_V6.addSubnet("2000::", 3, "ipv6");

// → { ip, type: "ipv4" | "ipv6" } か null（IPv4 を IPv6 の形で書いたもの（::ffff:a.b.c.d）は IPv4 として扱う）
function parseIp(addr) {
  let ip = String(addr || "").toLowerCase().split("%")[0];   // fe80::1%eth0 のような印は除く
  if (ip.startsWith("::ffff:") && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  if (net.isIPv4(ip)) return { ip, type: "ipv4" };
  if (net.isIPv6(ip)) return { ip, type: "ipv6" };
  return null;
}
function isPublicAddress(addr) {
  const a = parseIp(addr);
  if (!a) return false;
  if (a.type === "ipv6" && !GLOBAL_V6.check(a.ip, "ipv6")) return false;
  return !SPECIAL.check(a.ip, a.type);
}

// この PC のネットワークの範囲（IPv6 は家ごとに配られる /48、IPv4 は /24）には行かない、という判定を作る
function addressPolicy(ifaces = os.networkInterfaces()) {
  const home = new net.BlockList();
  for (const i of Object.values(ifaces).flat()) {
    const a = i && !i.internal ? parseIp(i.address) : null;
    if (a) home.addSubnet(a.ip, a.type === "ipv6" ? 48 : 24, a.type);
  }
  return (addr) => {
    const a = parseIp(addr);
    return Boolean(a) && isPublicAddress(a.ip) && !home.check(a.ip, a.type);
  };
}
const isWebPort = (port) => port === 80 || port === 443;
const blocked = (msg = "家の中の機器や特別なアドレスには接続しません（インターネットのページだけ開けます）") => Object.assign(new Error(msg), { code: "EBLOCKED" });

// ---------- YouTube と地図 ----------
function youtubeEmbed(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  let id = null;
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else if (u.pathname === "/playlist") {
      const list = u.searchParams.get("list");
      return list && /^[\w-]{10,64}$/.test(list) ? `https://www.youtube-nocookie.com/embed/videoseries?list=${list}&${YT_PARAMS}` : null;
    } else id = (u.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/) || [])[1];
  } else return null;
  return id && /^[\w-]{11}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}?${YT_PARAMS}` : null;
}
function mapEmbed(query) {
  const q = String(query || "").trim();
  return q ? `https://maps.google.com/maps?q=${encodeURIComponent(q)}&output=embed` : null;
}
// 道順（「出発地|目的地|手段」）の埋め込み URL。手段は 徒歩・車・電車・自転車（省略・分からないときは車）
const ROUTE_MODES = { 徒歩: "w", 歩き: "w", walk: "w", 車: "", 自動車: "", car: "", 電車: "r", 公共交通機関: "r", train: "r", transit: "r", 自転車: "b", bike: "b" };
function routeEmbed(spec) {
  const [from = "", to = "", mode = ""] = String(spec || "").split(/[|｜]/).map((s) => s.trim());
  if (!from || !to) return null;
  const flag = ROUTE_MODES[mode.toLowerCase()] || "";
  return `https://maps.google.com/maps?saddr=${encodeURIComponent(from)}&daddr=${encodeURIComponent(to)}${flag ? `&dirflg=${flag}` : ""}&output=embed`;
}

// ---------- 埋め込みの可否 ----------
// CSP は複数あれば（カンマ区切り・配列）すべてに従う。ひとつでも frame-ancestors を * 以外に限っていれば埋め込まない
function frameAllowed(headers) {
  const xfo = String(headers["x-frame-options"] || "").toLowerCase();
  if (xfo && !xfo.includes("allowall")) return false;   // DENY / SAMEORIGIN / ALLOW-FROM（ほかのサイト）
  const policies = [].concat(headers["content-security-policy"] || []).join(",").toLowerCase().split(",");
  return policies.every((policy) => {
    const fa = policy.split(";").map((d) => d.trim()).find((d) => /^frame-ancestors(\s|$)/.test(d));
    return !fa || fa.split(/\s+/).slice(1).includes("*");
  });
}

// ---------- 本文の取り出し（別のスレッドで。lib/page-extract.js） ----------
// 時間がかかりすぎたり、メモリを使いすぎたりしたら、スレッドを止めて題名だけにする
//  予備の結果（題名だけ）は、必要になったときだけ作る（取り出せたときは、本体のスレッドで HTML を読み直さない）
function extractInWorker(html, url, { timeout = EXTRACT_MS } = {}) {
  const fallback = () => ({ title: titleOf(html), description: "", image: "", siteName: "", markdown: "" });
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(EXTRACT_WORKER, { workerData: { task: "extract", html, url }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    } catch { return resolve(fallback()); }
    let done = false;
    const finish = (make) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(make());
    };
    const timer = setTimeout(() => finish(fallback), timeout);
    worker.once("message", (info) => finish(() => info));
    worker.once("error", () => finish(fallback));
    worker.once("exit", () => finish(fallback));
  });
}

// ---------- 取りに行く ----------
const mediaType = (headers) => String(headers["content-type"] || "").split(";")[0].trim().toLowerCase();
function decode(buf, contentType) {
  const head = buf.subarray(0, 4096).toString("latin1");
  const label = (String(contentType || "").match(/charset=["']?([\w-]+)/i) || head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1] || "utf-8";
  try { return new TextDecoder(label.toLowerCase()).decode(buf); } catch { return new TextDecoder("utf-8").decode(buf); }
}
const tooSlow = () => new Error("ページの読み込みに時間がかかりすぎました");

// 1 回分の取得。転送（3xx）・失敗（4xx / 5xx）と、本文が要らない応答（wantBody が false）は、本文を読まずに接続を切る
//  全体の締め切り（deadline）で必ず決着させる（接続の状態によっては、切ってもエラーが届かないことがあるため）
function request(url, { addressAllowed, timeout, deadline, maxBytes, accept, wantBody }) {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // IP アドレスを直接書いた URL は名前の解決を通らないので、ここで確かめる
    if (net.isIP(host) && !addressAllowed(host)) return reject(blocked());
    // 名前は、接続する瞬間に解決したアドレスで確かめる（解決し直されて家の中を向く手口を防ぐ）
    const lookup = (hostname, options, cb) => dns.lookup(hostname, options, (err, address, family) => {
      if (err) return cb(err);
      const list = Array.isArray(address) ? address : [{ address, family }];
      if (!list.length || list.some((a) => !addressAllowed(a.address))) return cb(blocked());
      return Array.isArray(address) ? cb(null, address) : cb(null, address, family);
    });
    let timer = null, settled = false;
    const settle = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.get(url, {
      lookup, timeout, agent: false,
      headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "ja,en;q=0.7" },
    }, (res) => {
      res.on("error", (e) => settle(reject, e));
      const head = { status: res.statusCode, headers: res.headers };
      if (res.statusCode >= 300 || !wantBody(res.headers)) {
        res.destroy();
        return settle(resolve, head);
      }
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > maxBytes) req.destroy(new Error("ページが大きすぎます"));
        else chunks.push(c);
      });
      res.on("end", () => settle(resolve, { ...head, body: Buffer.concat(chunks) }));
    });
    timer = setTimeout(() => { req.destroy(); settle(reject, tooSlow()); }, Math.max(0, deadline - Date.now()));
    req.on("timeout", () => req.destroy(tooSlow()));
    req.on("error", (e) => settle(reject, e));
    // 101（WebSocket などへの切り替え）は Web ページではない。ほうっておくと、エラーも終わりも届かない
    req.on("upgrade", (res, socket) => { socket.destroy(); settle(reject, new Error("ページを開けませんでした（HTTP 101）")); });
  });
}

// 転送をたどって取りに行く → { url, headers, body? }
//  opts.addressAllowed / portAllowed: 行ってよいアドレス・ポートか（既定はインターネットの 80 / 443 だけ。テストでだけ変える）
async function fetchUrl(raw, {
  addressAllowed = addressPolicy(), portAllowed = isWebPort, timeout = TIMEOUT_MS, totalTimeout = TOTAL_TIMEOUT_MS,
  maxBytes = MAX_BYTES, maxRedirects = MAX_REDIRECTS, accept = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", wantBody = () => true,
} = {}) {
  const deadline = Date.now() + totalTimeout;
  let next = String(raw);
  for (let hop = 0; ; hop++) {
    let url;
    try { url = new URL(next); } catch { throw new Error("URL の形が正しくありません"); }
    if (!/^https?:$/.test(url.protocol)) throw new Error("http / https のページだけ開けます");
    if (url.username || url.password) throw blocked("ログイン情報の入った URL は開けません");
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (!portAllowed(port)) throw blocked(`ポート ${port} のページは開けません（80 / 443 番だけ開けます）`);
    const res = await request(url, { addressAllowed, timeout, deadline, maxBytes, accept, wantBody });
    if (res.status >= 300 && res.status < 400) {
      if (!res.headers.location) throw new Error(`ページを開けませんでした（HTTP ${res.status}・転送先が書かれていません）`);
      if (hop >= maxRedirects) throw new Error("転送が多すぎます");
      next = new URL(res.headers.location, url).href;
      continue;
    }
    if (res.status >= 400) throw new Error(`ページを開けませんでした（HTTP ${res.status}）`);
    return { url: url.href, headers: res.headers, body: res.body };
  }
}

async function fetchPage(raw, opts = {}) {
  const page = await fetchUrl(raw, opts);
  return { url: page.url, headers: page.headers, html: decode(page.body || Buffer.alloc(0), page.headers["content-type"]) };
}

// ---------- 同時に扱う数 ----------
function limiter(max, message) {
  let active = 0;
  return async (fn) => {
    if (active >= max) throw Object.assign(new Error(message), { code: "EBUSY" });
    active++;
    try { return await fn(); } finally { active--; }
  };
}
const pageSlots = limiter(MAX_INSPECTS, "ほかのページを調べている途中です。少し待ってから、もう一度どうぞ");
const imageSlots = limiter(MAX_IMAGES, "ほかの画像を読み込んでいる途中です");

// パネルにどう出すか → { kind: "embed" | "article" | "image" | "video" | "link", url, embed?, title, description?, image?, siteName?, markdown? }
//  embed: 埋め込める（YouTube・地図・許可しているページ）。ページのときは、埋め込めなかったとき用に本文も返す
//  image: 画像（ブラウザは /api/web/image の中継を通して表示する）  video: 動画（mp4 / webm）
async function inspect(raw, opts = {}) {
  const yt = youtubeEmbed(raw);
  if (yt) return { kind: "embed", url: new URL(raw).href, embed: yt, title: "YouTube" };
  return pageSlots(async () => {
    const page = await fetchUrl(raw, { ...opts, wantBody: (h) => /html/.test(mediaType(h)) });
    const type = mediaType(page.headers);
    if (IMAGE_TYPES.has(type)) return { kind: "image", url: page.url, title: new URL(page.url).hostname };
    if (VIDEO_TYPES.has(type)) return { kind: "video", url: page.url, title: new URL(page.url).hostname };
    if (!/html/.test(type)) return { kind: "link", url: page.url, title: page.url };
    const info = await extractInWorker(decode(page.body || Buffer.alloc(0), page.headers["content-type"]), page.url, { timeout: opts.extractTimeout });
    const embed = frameAllowed(page.headers) ? page.url : null;
    return { kind: embed ? "embed" : "article", url: page.url, ...(embed ? { embed } : {}), ...info };
  });
}

// 画像だけを取りに行く（代表画像や、AI が表示する画像の URL を、ブラウザが直接ではなくこのサーバーを通して読むため）
//  → { type, body }。画像でなければ ENOTIMAGE
async function fetchImage(raw, opts = {}) {
  return imageSlots(async () => {
    const img = await fetchUrl(raw, {
      maxBytes: MAX_IMAGE_BYTES, accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9", ...opts,
      wantBody: (h) => IMAGE_TYPES.has(mediaType(h)),
    });
    const type = mediaType(img.headers);
    if (!IMAGE_TYPES.has(type) || !img.body) throw Object.assign(new Error("画像ではありません"), { code: "ENOTIMAGE" });
    return { type, body: img.body };
  });
}

module.exports = { isPublicAddress, addressPolicy, youtubeEmbed, mapEmbed, routeEmbed, frameAllowed, extractPage, extractInWorker, fetchPage, fetchImage, inspect };
