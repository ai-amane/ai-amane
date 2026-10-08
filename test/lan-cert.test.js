// LAN 用の証明書（lib/lan-cert.js）のテスト
//  iPad の Safari が受け付ける形になっているかを、Node の X509Certificate と実際の TLS 接続で確かめる。
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { createLanCertificate, ensureLanCertificate, certWarnings } = require("../lib/lan-cert");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const made = createLanCertificate({ ips: ["192.168.1.23", "127.0.0.1"], hostnames: ["Desktop-ABC.local"], now: NOW });
const ca = new crypto.X509Certificate(made.caDer);
const leaf = new crypto.X509Certificate(made.certPem);

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "amane-lan-cert-"));

// その CA を信頼して接続し、本文を返す（servername を変えると、証明書の名前の確認だけを変えられる）
function fetchOver(server, { servername } = {}) {
  return new Promise((resolve, reject) => {
    const opts = { host: "127.0.0.1", port: server.address().port, path: "/", ca: made.caPem, ...(servername ? { servername } : {}) };
    https.get(opts, (res) => {
      let s = "";
      res.on("data", (d) => { s += d; });
      res.on("end", () => resolve(s));
    }).on("error", reject);
  });
}
async function withServer(fn) {
  const server = https.createServer({ key: made.keyPem, cert: made.certPem }, (req, res) => res.end("ok"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try { return await fn(server); } finally { server.close(); }
}

test("CA の証明書は CA で、サーバー証明書はその CA が署名している", () => {
  assert.equal(ca.ca, true);
  assert.equal(leaf.ca, false);
  assert.ok(leaf.checkIssued(ca));
  assert.ok(leaf.verify(ca.publicKey));
  assert.ok(ca.verify(ca.publicKey));   // CA は自己署名
});

test("サーバー証明書の名前（SAN）に IP アドレスとホスト名が入っている（ホスト名は小文字にする）", () => {
  assert.equal(leaf.checkIP("192.168.1.23"), "192.168.1.23");
  assert.equal(leaf.checkIP("127.0.0.1"), "127.0.0.1");
  assert.equal(leaf.checkHost("desktop-abc.local"), "desktop-abc.local");
  assert.equal(leaf.checkIP("192.168.1.24"), undefined);
});

test("iOS の条件: 用途に serverAuth があり、有効期間は 825 日以内", () => {
  assert.deepEqual(leaf.keyUsage, ["1.3.6.1.5.5.7.3.1"]);
  const days = (new Date(leaf.validTo) - new Date(leaf.validFrom)) / DAY;
  assert.ok(days <= 825, `有効期間 ${days} 日`);
  assert.ok(new Date(leaf.validFrom) <= NOW && new Date(leaf.validTo) > NOW);
});

test("秘密鍵はサーバー証明書と組になっている", () => {
  assert.ok(leaf.checkPrivateKey(crypto.createPrivateKey(made.keyPem)));
});

test("CA の秘密鍵は返さない（iPad に信頼させた CA で、ほかのサイトの証明書を作れないように）", () => {
  assert.deepEqual(Object.keys(made).sort(), ["caDer", "caPem", "certPem", "keyPem"]);
  // 返す秘密鍵はサーバー証明書のものだけで、CA の公開鍵とは組にならない
  assert.equal(ca.checkPrivateKey(crypto.createPrivateKey(made.keyPem)), false);
});

test("作るたびに別の CA になる", () => {
  const other = createLanCertificate({ ips: ["192.168.1.23"], now: NOW });
  assert.notEqual(new crypto.X509Certificate(other.caDer).fingerprint256, ca.fingerprint256);
});

test("使えない名前は入れず、名前がひとつも無ければエラーにする", () => {
  const c = createLanCertificate({ ips: ["::1", "999.1.1.1", "10.0.0.5"], hostnames: ["bad_name.local", "ok.local"], now: NOW });
  assert.equal(new crypto.X509Certificate(c.certPem).subjectAltName, "DNS:ok.local, IP Address:10.0.0.5");
  assert.throws(() => createLanCertificate({ ips: [], hostnames: ["bad name"], now: NOW }));
});

test("その CA を信頼したクライアントから、TLS で接続できる", async () => {
  assert.equal(await withServer((s) => fetchOver(s)), "ok");
});

test("証明書に無い名前で接続すると、TLS の確認で失敗する", async () => {
  await assert.rejects(withServer((s) => fetchOver(s, { servername: "other.local" })), /altnames|ERR_TLS_CERT_ALTNAME_INVALID/);
});

test("ensureLanCertificate: 初回は作って保存し、2 回目は同じものを読む（CA の秘密鍵は保存しない）", () => {
  const dir = tmpDir();
  try {
    const a = ensureLanCertificate({ dir, ips: ["192.168.1.23"], hostnames: ["pc.local"], now: NOW });
    assert.equal(a.created, true);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["ca.crt", "server.crt", "server.key"]);
    // IP アドレスが変わっても勝手に作り直さない（iPad に入れた証明書が使えなくなるため）
    const b = ensureLanCertificate({ dir, ips: ["192.168.1.99"], hostnames: ["pc.local"], now: NOW });
    assert.equal(b.created, false);
    assert.equal(b.cert, a.cert);
    assert.deepEqual(b.ips, ["192.168.1.23"]);
    assert.deepEqual(b.hostnames, ["pc.local"]);
    assert.match(b.caName, /Local CA/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("ensureLanCertificate: 期限が切れていたら作り直す", () => {
  const dir = tmpDir();
  try {
    const a = ensureLanCertificate({ dir, ips: ["192.168.1.23"], hostnames: [], now: NOW });
    const later = new Date(NOW.getTime() + 900 * DAY);
    const b = ensureLanCertificate({ dir, ips: ["192.168.1.23"], hostnames: [], now: later });
    assert.equal(b.created, true);
    assert.notEqual(b.cert, a.cert);
    assert.ok(b.notAfter > later);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("ensureLanCertificate: 壊れたファイルなら作り直す", () => {
  const dir = tmpDir();
  try {
    ensureLanCertificate({ dir, ips: ["192.168.1.23"], hostnames: [], now: NOW });
    fs.writeFileSync(path.join(dir, "server.crt"), "broken");
    assert.equal(ensureLanCertificate({ dir, ips: ["192.168.1.23"], hostnames: [], now: NOW }).created, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("certWarnings: IP アドレスが変わったとき・期限が近いときに知らせる", () => {
  const info = { ips: ["192.168.1.23"], hostnames: ["pc.local"], notAfter: new Date(NOW.getTime() + 100 * DAY) };
  assert.deepEqual(certWarnings(info, { ip: "192.168.1.23", now: NOW }), []);
  assert.deepEqual(certWarnings(info, { ip: undefined, now: NOW }), []);
  const moved = certWarnings(info, { ip: "192.168.1.50", now: NOW });
  assert.equal(moved.length, 1);
  assert.match(moved[0], /192\.168\.1\.50/);
  assert.match(moved[0], /pc\.local/);   // ホスト名でなら開けることを伝える
  const soon = certWarnings({ ...info, notAfter: new Date(NOW.getTime() + 10 * DAY) }, { ip: "192.168.1.23", now: NOW });
  assert.equal(soon.length, 1);
  assert.match(soon[0], /10 日/);
});

test("CA の名前（CN）は、ホスト名が長くても 64 文字までにする", () => {
  const long = createLanCertificate({ hostnames: ["kabayama-hiroshinomacbook-pro-no-totemo-nagai-namae.local"], now: NOW });
  const cn = new crypto.X509Certificate(long.caDer).subject.replace(/^CN=/, "");
  assert.ok(cn.length <= 64, `${cn.length} 文字: ${cn}`);
  assert.match(cn, /^AI AMANE Local CA \(.*\)$/);
});
