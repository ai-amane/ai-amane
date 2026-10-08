// iPad など LAN の端末向けの HTTPS サーバー（lib/lan-server.js）のテスト
//  実際に HTTPS で接続して、ペアリングしていない端末が入れないこと、ペアリングの流れを確かめる。
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { startLanServer, isHomeAddress } = require("../lib/lan-server");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const silent = { log() {}, warn() {}, error() {} };

// サーバーを起動し、受け取ったリクエストを記録する handle（server.js の画面と API の代わり）を付ける
async function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "amane-lan-server-"));
  const calls = [];
  const lan = await startLanServer({
    port: 0, host: "127.0.0.1", dataDir, publicDir: PUBLIC_DIR, log: silent,
    addresses: { ips: ["127.0.0.1"], hostnames: [] },
    handle: (req, res, from) => {
      calls.push({ url: req.url, from });
      // 会話の受信（/api/brain/events）のように、ずっと開いたままの応答
      if (req.url === "/api/stream") { res.writeHead(200, { "Content-Type": "text/event-stream" }); return res.write(": ok\n\n"); }
      res.end(`handled:${from}`);
    },
  });
  const caPem = new crypto.X509Certificate(fs.readFileSync(path.join(dataDir, "ca.crt"))).toString();
  const host = `127.0.0.1:${lan.port}`;
  // anyName: 証明書の名前を確かめない（Host を偽ったときに、サーバー側で拒否されるかを見るため）
  function request(pathname, { method = "GET", headers = {}, body, anyName = false } = {}) {
    return new Promise((resolve, reject) => {
      // agent: false … 毎回新しい接続にする（解除すると、サーバーが開いている接続を切るため）
      const tls = { ca: caPem, agent: false, ...(anyName ? { checkServerIdentity: () => undefined } : {}) };
      const req = https.request({ host: "127.0.0.1", port: lan.port, path: pathname, method, ...tls, headers: { Host: host, ...headers } }, (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end(body);
    });
  }
  const post = (pathname, json, headers = {}) => request(pathname, {
    method: "POST", body: JSON.stringify(json), headers: { "Content-Type": "application/json", "X-Amane": "1", ...headers },
  });
  // 番号を出して、その番号でペアリングし、もらった Cookie を返す
  async function pairDevice(label = "iPad") {
    const { code } = lan.issueCode();
    const r = await post("/api/lan/pair", { code, label });
    assert.equal(r.status, 200);
    return r.headers["set-cookie"][0].split(";")[0];
  }
  const close = async () => { await lan.close(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  return { lan, calls, host, caPem, request, post, pairDevice, close };
}

test("ペアリング前: / はペアリングのページに案内し、API は使えない（handle に渡さない）", async () => {
  const s = await setup();
  try {
    const top = await s.request("/");
    assert.equal(top.status, 302);
    assert.equal(top.headers.location, "/pair");
    const api = await s.request("/api/config");
    assert.equal(api.status, 401);
    assert.match(JSON.parse(api.body).error, /つながっていません/);
    assert.equal((await s.request("/app.js")).status, 401);
    assert.deepEqual(s.calls, []);
  } finally { await s.close(); }
});

test("ペアリング前でも、証明書とペアリングのページは見られる", async () => {
  const s = await setup();
  try {
    const ca = await s.request("/amane-ca.crt");
    assert.equal(ca.status, 200);
    assert.equal(ca.headers["content-type"], "application/x-x509-ca-cert");
    assert.equal(new crypto.X509Certificate(ca.body).ca, true);
    const pair = await s.request("/pair");
    assert.equal(pair.status, 200);
    assert.match(pair.headers["content-type"], /text\/html/);
    assert.match(pair.body.toString(), /ペアリング|つなぐ/);
  } finally { await s.close(); }
});

test("番号が違えば 403。合っていれば Cookie をもらえ、その Cookie で画面と API に入れる（from は lan）", async () => {
  const s = await setup();
  try {
    s.lan.issueCode();
    const wrong = await s.post("/api/lan/pair", { code: "000000x" });
    assert.equal(wrong.status, 403);
    const { code } = s.lan.issueCode();
    const ok = await s.post("/api/lan/pair", { code, label: "リビングの iPad" });
    assert.equal(ok.status, 200);
    const cookie = ok.headers["set-cookie"][0];
    // __Host- を付けると、同じ PC の別のポートのサービスと Cookie を共有しない・上書きされない
    assert.match(cookie, /^__Host-amane_lan=[\w-]{40,};/);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(cookie.includes(attr), `Cookie に ${attr} が無い`);
    const r = await s.request("/api/config", { headers: { Cookie: cookie.split(";")[0] } });
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), "handled:lan");
    assert.deepEqual(s.calls, [{ url: "/api/config", from: "lan" }]);
    assert.deepEqual(s.lan.status().devices.map((d) => [d.label, d.ip]), [["リビングの iPad", "127.0.0.1"]]);
  } finally { await s.close(); }
});

test("中身が JSON のオブジェクトでなくても、番号違いとして断る（エラーで落ちない）", async () => {
  const s = await setup();
  try {
    s.lan.issueCode();
    for (const body of ["null", "[]", "123", "not json"]) {
      const r = await s.request("/api/lan/pair", { method: "POST", body, headers: { "Content-Type": "application/json", "X-Amane": "1" } });
      assert.equal(r.status, 403, body);
    }
  } finally { await s.close(); }
});

test("同じ番号は二度使えない", async () => {
  const s = await setup();
  try {
    const { code } = s.lan.issueCode();
    assert.equal((await s.post("/api/lan/pair", { code })).status, 200);
    assert.equal((await s.post("/api/lan/pair", { code })).status, 403);
  } finally { await s.close(); }
});

test("Host が違うと拒否する（DNS リバインディング対策）", async () => {
  const s = await setup();
  try {
    const r = await s.request("/pair", { headers: { Host: `evil.example:${s.lan.port}` }, anyName: true });
    assert.equal(r.status, 403);
    assert.equal((await s.request("/pair", { headers: { Host: "127.0.0.1:1" }, anyName: true })).status, 403);   // ポートが違う
  } finally { await s.close(); }
});

test("ほかのサイトからの POST（Origin が違う・X-Amane が無い）は拒否する", async () => {
  const s = await setup();
  try {
    const cookie = await s.pairDevice();
    const { code } = s.lan.issueCode();
    assert.equal((await s.post("/api/lan/pair", { code }, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await s.post("/api/tasks", { task: "x" }, { Cookie: cookie, Origin: "https://evil.example" })).status, 403);
    assert.equal((await s.post("/api/tasks", { task: "x" }, { Cookie: cookie, Origin: "null" })).status, 403);
    const noHeader = await s.request("/api/tasks", { method: "POST", body: "{}", headers: { Cookie: cookie } });
    assert.equal(noHeader.status, 403);
    // 同じ画面からの POST（Origin が自分）は通る
    assert.equal((await s.post("/api/tasks", { task: "x" }, { Cookie: cookie, Origin: `https://${s.host}` })).status, 200);
    assert.deepEqual(s.calls.map((c) => c.url), ["/api/tasks"]);
  } finally { await s.close(); }
});

test("ペアリングした端末でも、PC の画面専用の操作（終了・ペアリングの管理）はできない", async () => {
  const s = await setup();
  try {
    const cookie = await s.pairDevice();
    for (const p of ["/api/shutdown", "/api/lan/code", "/api/lan/revoke"]) {
      assert.equal((await s.post(p, {}, { Cookie: cookie })).status, 403, p);
    }
    assert.equal((await s.request("/api/lan/status", { headers: { Cookie: cookie } })).status, 403);
    assert.deepEqual(s.calls, []);
  } finally { await s.close(); }
});

test("すべて解除すると、もらった Cookie では入れなくなる", async () => {
  const s = await setup();
  try {
    const cookie = await s.pairDevice();
    assert.equal((await s.request("/api/config", { headers: { Cookie: cookie } })).status, 200);
    s.lan.revokeAll();
    assert.equal((await s.request("/api/config", { headers: { Cookie: cookie } })).status, 401);
    assert.deepEqual(s.lan.status().devices, []);
  } finally { await s.close(); }
});

test("すべて解除すると、開いたままの受信（会話のストリーム）も切る", async () => {
  const s = await setup();
  try {
    const cookie = await s.pairDevice();
    const closed = await new Promise((resolve, reject) => {
      const req = https.get({ host: "127.0.0.1", port: s.lan.port, path: "/api/stream", ca: s.caPem, headers: { Host: s.host, Cookie: cookie } }, (res) => {
        assert.equal(res.statusCode, 200);
        const timer = setTimeout(() => resolve(false), 2000);
        res.on("close", () => { clearTimeout(timer); resolve(true); });
        res.resume();
        s.lan.revokeAll();
      });
      req.on("error", (e) => (e.code === "ECONNRESET" ? resolve(true) : reject(e)));
    });
    assert.equal(closed, true, "解除しても受信が切れていない");
  } finally { await s.close(); }
});

test("status: 開く URL・証明書のフィンガープリント・番号の期限・つないだ端末を返す", async () => {
  const s = await setup();
  try {
    const before = s.lan.status();
    assert.equal(before.enabled, true);
    assert.deepEqual(before.urls, [`https://127.0.0.1:${s.lan.port}`]);
    // iPad で入れた証明書と同じものか、PC の画面で見比べられるように
    const served = new crypto.X509Certificate((await s.request("/amane-ca.crt")).body);
    assert.equal(before.caFingerprint, served.fingerprint256);
    assert.equal(before.pending, null);
    const { expiresAt } = s.lan.issueCode();
    assert.deepEqual(s.lan.status().pending, { expiresAt });
  } finally { await s.close(); }
});

test("isHomeAddress: 家の LAN・この PC のアドレスだけを受け付ける（VPN や公衆のアドレスは断る）", () => {
  for (const ip of ["192.168.0.25", "10.1.2.3", "172.16.0.1", "172.31.255.255", "169.254.1.1", "127.0.0.1", "::ffff:192.168.0.25", "::1", "fe80::1"]) {
    assert.equal(isHomeAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "172.32.0.1", "100.64.0.1", "::ffff:8.8.8.8", "2001:db8::1", "", undefined]) {
    assert.equal(isHomeAddress(ip), false, String(ip));
  }
});

test("IP アドレスがまだ無く、証明書も無いとき（Wi-Fi につながる前）は、証明書を作らずにエラーにする", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "amane-lan-noip-"));
  try {
    await assert.rejects(
      startLanServer({ port: 0, host: "127.0.0.1", dataDir, publicDir: PUBLIC_DIR, log: silent, addresses: { ips: [], hostnames: ["pc.local"] }, handle: () => {} }),
      (e) => e.code === "ENOLANIP",
    );
    assert.deepEqual(fs.readdirSync(dataDir), []);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
