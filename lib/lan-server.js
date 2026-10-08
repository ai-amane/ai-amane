// 家の Wi-Fi（LAN）の iPad などから使うための HTTPS サーバー（.env の LAN_ACCESS=1 のときだけ起動）
//  ・この PC の画面（http://localhost:3939）はそのまま。LAN からは https://この PC の IP アドレス:LAN_PORT で開く
//  ・ペアリングしていない端末が使えるのは、証明書のダウンロードとペアリングのページだけ
//  ・Host / Origin / X-Amane の確認は、この PC の画面と同じ（DNS リバインディング・CSRF 対策）
//  ・終了やペアリングの管理など、PC の画面専用の操作は LAN からは受け付けない
//  ・家の LAN（プライベートアドレス）以外からの接続は断る（VPN や公衆 Wi-Fi のアドレスにも待ち受けてしまうため）
const https = require("https");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { ensureLanCertificate, certWarnings } = require("./lan-cert");
const { createPairingCodes, createDeviceStore } = require("./lan-pairing");

// __Host- を付けると、同じ PC の別のポートのサービスと Cookie を共有せず、上書きもされない
const COOKIE = "__Host-amane_lan";
const COOKIE_MAX_AGE_SEC = 400 * 24 * 60 * 60;   // ブラウザが受け付ける上限（400 日）
const BODY_LIMIT = 4096;
// PC の画面からだけ使える操作（サーバーの終了・ペアリングの管理）。server.js でも同じものを使う
const LOCAL_ONLY = /^\/api\/(shutdown$|lan\/)/;
const FAIL_LOG_MS = 10 * 1000;   // ペアリングの失敗をログに書く間隔（何度も試されても黒いウィンドウを埋めない）
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "frame-ancestors 'none'", "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
};

// 家の LAN（プライベートアドレス・リンクローカル）か、この PC 自身のアドレスか
function isHomeAddress(addr) {
  const ip = String(addr || "").replace(/^::ffff:/i, "");
  if (net.isIPv4(ip)) return /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  if (net.isIPv6(ip)) return ip === "::1" || /^(fe[89ab]|f[cd])/i.test(ip);
  return false;
}
// 仮想マシン・WSL・VPN などのネットワーク（iPad からはつながらない）と、Wi-Fi・有線のネットワーク
const VIRTUAL_NIC = /vEthernet|Hyper-V|VirtualBox|VMware|VMnet|vbox|WSL|Docker|^br-|bridge|utun|tailscale|ZeroTier/i;
const REAL_NIC = /Wi-?Fi|WLAN|Wireless|ワイヤレス|イーサネット|Ethernet|^en\d|^eth\d|^wl/i;
// この PC の LAN 側の IPv4 アドレス。iPad から開く URL に使うので、Wi-Fi・有線の 192.168.x.x を先頭に、仮想のものは後ろに
function lanAddresses() {
  const rank = ({ name, address }) => (VIRTUAL_NIC.test(name) ? 4 : 0) + (REAL_NIC.test(name) ? 0 : 2) + (address.startsWith("192.168.") ? 0 : 1);
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) => (list || []).map((a) => ({ ...a, name })))
    .filter((a) => (a.family === "IPv4" || a.family === 4) && !a.internal && isHomeAddress(a.address) && !a.address.startsWith("169.254."))
    .sort((a, b) => rank(a) - rank(b))
    .map((a) => a.address);
}
// この PC のホスト名（iPad からは「ホスト名.local」で見つけられることが多い）
const lanHostnames = () => [`${os.hostname().toLowerCase().replace(/\.local$/, "")}.local`];

function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}
function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(obj));
}
// 日本語（端末の名前）が途中で切れて文字化けしないよう、全部受け取ってから UTF-8 として読む
function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { resolve({}); req.destroy(); } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        const j = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        resolve(j && typeof j === "object" && !Array.isArray(j) ? j : {});
      } catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

// handle(req, res, "lan"): ペアリング済みの端末からのリクエストを渡す先（server.js の画面と API）
// addresses: 証明書に入れる名前（省略時はこの PC の IP アドレスとホスト名。テスト用）
async function startLanServer({ port, dataDir, publicDir, handle, host = "0.0.0.0", addresses = null, log = console }) {
  const current = addresses || { ips: lanAddresses(), hostnames: lanHostnames() };
  // Wi-Fi につながる前（PC の起動直後など）に証明書を作ると、IP アドレスの入らない証明書になってしまうので作らない
  if (!current.ips.length && !fs.existsSync(path.join(dataDir, "server.crt"))) {
    throw Object.assign(new Error("この PC の LAN の IP アドレスが見つかりません（Wi-Fi などにつながるのを待っています）"), { code: "ENOLANIP" });
  }
  const cert = ensureLanCertificate({ dir: dataDir, ...current });
  const warnings = certWarnings(cert, { ip: current.ips[0] });
  const devices = createDeviceStore({ file: path.join(dataDir, "devices.json") });
  const pairing = createPairingCodes();
  const pairPage = path.join(publicDir, "pair.html");
  let allowedHosts = new Set();
  let failLoggedAt = 0, failsUnlogged = 0;

  function logFailure(from) {
    failsUnlogged++;
    if (Date.now() - failLoggedAt < FAIL_LOG_MS) return;
    const more = failsUnlogged > 1 ? `。直前の ${FAIL_LOG_MS / 1000} 秒間にほか ${failsUnlogged - 1} 回` : "";
    log.warn(`[lan] ペアリングの番号が違うか、期限が切れています（${from}${more}）`);
    failLoggedAt = Date.now();
    failsUnlogged = 0;
  }

  async function pair(req, res) {
    const body = await readJson(req);
    const from = String(req.socket.remoteAddress || "").replace(/^::ffff:/i, "");
    if (!pairing.redeem(body.code)) {
      logFailure(from);
      return sendJson(res, 403, { error: "番号が違うか、期限が切れています。PC の画面で番号を表示し直してください。" });
    }
    const { token, device } = devices.add(body.label, from);
    log.log(`[lan] 端末をつなぎました: ${device.label}（${from}）`);
    return sendJson(res, 200, { ok: true }, {
      "Set-Cookie": `${COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE_SEC}; HttpOnly; Secure; SameSite=Strict`,
    });
  }

  async function route(req, res) {
    if (!isHomeAddress(req.socket.remoteAddress)) return sendJson(res, 403, { error: "家の LAN の外からは使えません" });
    const hostHeader = String(req.headers.host || "").toLowerCase();
    if (!allowedHosts.has(hostHeader)) return sendJson(res, 403, { error: "Host が許可されていません" });
    const origin = req.headers.origin;
    if (origin && origin !== `https://${hostHeader}`) return sendJson(res, 403, { error: "Origin が許可されていません" });
    const isRead = req.method === "GET" || req.method === "HEAD";
    if (!isRead && req.headers["x-amane"] !== "1") return sendJson(res, 403, { error: "X-Amane ヘッダーがありません" });
    const p = new URL(req.url, `https://${hostHeader}`).pathname;

    // ペアリング前でも使えるもの
    if (p === "/amane-ca.crt" && isRead) {
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/x-x509-ca-cert", "Content-Length": cert.caDer.length });
      return res.end(req.method === "HEAD" ? undefined : cert.caDer);
    }
    if (p === "/pair" && isRead) {
      const html = await fs.promises.readFile(pairPage);
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" });
      return res.end(req.method === "HEAD" ? undefined : html);
    }
    if (p === "/api/lan/pair" && req.method === "POST") return pair(req, res);

    // ここから先はペアリングした端末だけ
    if (!devices.verify(cookieOf(req, COOKIE))) {
      if (isRead && (p === "/" || p === "/index.html")) {
        res.writeHead(302, { Location: "/pair", "Cache-Control": "no-store" });
        return res.end();
      }
      return sendJson(res, 401, { error: "この端末はまだつながっていません（/pair を開いてペアリングしてください）" });
    }
    if (LOCAL_ONLY.test(p)) return sendJson(res, 403, { error: "この操作は PC の画面からだけできます" });
    return handle(req, res, "lan");
  }

  const server = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    route(req, res).catch((e) => {
      log.error("[lan]", e.message);
      if (!res.headersSent) sendJson(res, 400, { error: "リクエストを処理できませんでした" });
      else res.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  server.on("error", (e) => log.error("[lan]", e.message));

  const boundPort = server.address().port;
  // 443 番のときは、ブラウザが Host にポート番号を付けない
  allowedHosts = new Set([...cert.ips, ...cert.hostnames].flatMap((n) => (boundPort === 443 ? [n, `${n}:443`] : [`${n}:${boundPort}`])));
  const urls = [...cert.ips, ...cert.hostnames].map((n) => `https://${n}:${boundPort}`);
  if (cert.created) log.log(`[lan] 証明書を作りました（${cert.caName}）。iPad などには、ペアリングのページから証明書を入れてください。`);

  return {
    port: boundPort,
    urls,
    status: () => ({
      enabled: true, urls, caName: cert.caName, caFingerprint: cert.caFingerprint, notAfter: cert.notAfter,
      warnings, devices: devices.list(), pending: pairing.pending(),
    }),
    issueCode: () => ({ ...pairing.issue(), urls }),
    // 解除したら、開いたままの接続（会話の受信など）も切る（LAN の端末からの接続だけ。PC の画面は別のサーバー）
    revokeAll: () => { devices.removeAll(); server.closeAllConnections?.(); },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

module.exports = { startLanServer, isHomeAddress, LOCAL_ONLY };
