// LAN（家の Wi-Fi）の iPad などから HTTPS でつなぐための証明書を作る
//  iPad の Safari は、localhost 以外のアドレスでは HTTPS でないとマイクを使わせてくれない。
//  ・この PC 専用の認証局（CA）を作り、それでサーバー証明書に署名する。iPad には CA の証明書を入れて信頼させる
//  ・CA の秘密鍵は署名したらすぐ捨てる（保存しない）。iPad に信頼させた CA で、ほかのサイトの偽の証明書を作られないように
//  ・iOS の条件に合わせる: 名前は SAN（IP アドレス・ホスト名）、用途に serverAuth、有効期間 825 日以内
//  ・依存パッケージを増やさないよう、証明書（DER）は自前で組み立て、署名は Node の crypto（ECDSA P-256）で行う
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");

const CERT_DAYS = 800;          // iOS はサーバー証明書の有効期間を 825 日以内にするよう求める
const WARN_DAYS = 30;           // 期限がこれより近づいたら知らせる
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- DER（ASN.1）の組み立て ----------
function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const octets = (buf) => tlv(0x04, buf);
const bits = (buf, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), buf]));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, "utf8"));
const explicit = (n, body) => tlv(0xa0 | n, body);
// 0 以上の整数（buf はビッグエンディアン）。余分な先頭の 0 を除き、最上位ビットが立っていれば負の数にならないよう 0 を足す
function uint(buf) {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  const b = buf.subarray(i);
  return tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
}
function oid(dotted) {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const body = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    body.push(...chunk);
  }
  return tlv(0x06, Buffer.from(body));
}
// 2049 年までは UTCTime、2050 年からは GeneralizedTime（RFC 5280）
function time(d) {
  const s = d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";   // YYYYMMDDHHMMSSZ
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(s.slice(2), "ascii")) : tlv(0x18, Buffer.from(s, "ascii"));
}

const OID = {
  commonName: "2.5.4.3",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  subjectAltName: "2.5.29.17",
  subjectKeyId: "2.5.29.14",
  authorityKeyId: "2.5.29.35",
  serverAuth: "1.3.6.1.5.5.7.3.1",
};
const SIG_ALG = seq(oid(OID.ecdsaWithSha256));
const name = (cn) => seq(set(seq(oid(OID.commonName), utf8(cn))));
const extension = (id, value, critical = false) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
const keyId = (spki) => crypto.createHash("sha1").update(spki).digest();

function signCertificate({ issuer, subject, notBefore, notAfter, spki, extensions, signKey }) {
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x40;   // 正の数で、先頭のバイトが 0 にならないように
  const tbs = seq(
    explicit(0, uint(Buffer.from([2]))),   // v3
    uint(serial), SIG_ALG, name(issuer), seq(time(notBefore), time(notAfter)), name(subject), spki,
    explicit(3, seq(...extensions)),
  );
  return seq(tbs, SIG_ALG, bits(crypto.sign("sha256", tbs, { key: signKey, dsaEncoding: "der" })));
}

const pem = (label, der) => `-----BEGIN ${label}-----\n${der.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END ${label}-----\n`;
const isDnsName = (s) => /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(s);
const ecKeyPair = () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });

// 証明書を作る。ips: IPv4 アドレス、hostnames: ホスト名（例: desktop-abc.local）。使えないものは除く
function createLanCertificate({ ips = [], hostnames = [], now = new Date(), days = CERT_DAYS, label = "AI AMANE" } = {}) {
  const v4 = [...new Set(ips)].filter((ip) => net.isIPv4(ip));
  const dns = [...new Set(hostnames.map((h) => String(h).toLowerCase()))].filter(isDnsName);
  if (!v4.length && !dns.length) throw new Error("証明書に入れる IP アドレスもホスト名もありません");
  const ca = ecKeyPair();
  const server = ecKeyPair();
  const caSpki = ca.publicKey.export({ type: "spki", format: "der" });
  const serverSpki = server.publicKey.export({ type: "spki", format: "der" });
  const notBefore = new Date(now.getTime() - 60 * 60 * 1000);   // PC と iPad の時計のずれを許す
  const notAfter = new Date(now.getTime() + days * DAY_MS);
  // 名前（CN）は 64 文字まで（X.520）。ホスト名が長い Mac などで超えないように切る
  const caName = `${label} Local CA (${now.toISOString().slice(0, 10)} ${dns[0] || v4[0]}`.slice(0, 63) + ")";
  const caDer = signCertificate({
    issuer: caName, subject: caName, notBefore, notAfter, spki: caSpki, signKey: ca.privateKey,
    extensions: [
      extension(OID.basicConstraints, seq(bool(true), uint(Buffer.from([0]))), true),   // CA（その下に CA は作れない）
      extension(OID.keyUsage, bits(Buffer.from([0x06]), 1), true),                      // keyCertSign, cRLSign
      extension(OID.subjectKeyId, octets(keyId(caSpki))),
    ],
  });
  const certDer = signCertificate({
    issuer: caName, subject: label, notBefore, notAfter, spki: serverSpki, signKey: ca.privateKey,
    extensions: [
      extension(OID.basicConstraints, seq(), true),                  // CA ではない
      extension(OID.keyUsage, bits(Buffer.from([0x80]), 7), true),   // digitalSignature
      extension(OID.extKeyUsage, seq(oid(OID.serverAuth))),
      extension(OID.subjectAltName, seq(
        ...dns.map((d) => tlv(0x82, Buffer.from(d, "ascii"))),                   // dNSName
        ...v4.map((ip) => tlv(0x87, Buffer.from(ip.split(".").map(Number)))),    // iPAddress
      )),
      extension(OID.subjectKeyId, octets(keyId(serverSpki))),
      extension(OID.authorityKeyId, seq(tlv(0x80, keyId(caSpki)))),
    ],
  });
  // CA の秘密鍵（ca.privateKey）は返さず、ここで捨てる
  return {
    caDer,
    caPem: pem("CERTIFICATE", caDer),
    certPem: pem("CERTIFICATE", certDer),
    keyPem: server.privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

// 証明書の名前と期限を読む。鍵と組になっていて、CA が署名したものかも確かめる
function describe(caDer, certPem, keyPem) {
  const x509 = new crypto.X509Certificate(certPem);
  const ca = new crypto.X509Certificate(caDer);
  if (!x509.checkPrivateKey(crypto.createPrivateKey(keyPem)) || !x509.verify(ca.publicKey)) throw new Error("証明書と鍵が組になっていません");
  const names = (x509.subjectAltName || "").split(/,\s*/);
  return {
    caDer, cert: certPem, key: keyPem,
    caName: ca.subject.replace(/^CN=/, ""),
    caFingerprint: ca.fingerprint256,   // iPad に入れた証明書と同じものか、見比べるため
    ips: names.filter((n) => n.startsWith("IP Address:")).map((n) => n.slice("IP Address:".length)),
    hostnames: names.filter((n) => n.startsWith("DNS:")).map((n) => n.slice("DNS:".length)),
    notAfter: new Date(x509.validTo),
  };
}

// dir に保存した証明書を使う。無い・壊れている・期限切れのときだけ作り直す
// （IP アドレスが変わっても作り直さない。作り直すと iPad に証明書を入れ直す必要があるため。certWarnings で知らせる）
function ensureLanCertificate({ dir, ips, hostnames, now = new Date() }) {
  const files = { ca: path.join(dir, "ca.crt"), cert: path.join(dir, "server.crt"), key: path.join(dir, "server.key") };
  try {
    const saved = describe(fs.readFileSync(files.ca), fs.readFileSync(files.cert, "utf8"), fs.readFileSync(files.key, "utf8"));
    if (saved.notAfter > now) return { ...saved, created: false };
  } catch { /* 無い・壊れている → 作り直す */ }
  const made = createLanCertificate({ ips, hostnames, now });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(files.ca, made.caDer);
  fs.writeFileSync(files.cert, made.certPem);
  fs.writeFileSync(files.key, made.keyPem, { mode: 0o600 });
  return { ...describe(made.caDer, made.certPem, made.keyPem), created: true };
}

// 証明書について利用者に知らせること（ip: いまこの PC で一番使われていそうな IP アドレス）
function certWarnings(info, { ip, now = new Date() }) {
  const out = [];
  if (ip && !info.ips.includes(ip)) {
    const byName = info.hostnames.length ? `iPad では https://${info.hostnames[0]}:ポート番号 で開くか、` : "";
    out.push(`この PC の IP アドレス（${ip}）が、証明書を作ったとき（${info.ips.join(", ") || "なし"}）から変わっています。`
      + `${byName}data/lan フォルダを削除して起動し直し、iPad に証明書を入れ直してください（ルーターで IP アドレスを固定しておくと、この作業は不要です）。`);
  }
  const left = Math.floor((info.notAfter - now) / DAY_MS);
  if (left < WARN_DAYS) out.push(`証明書の期限まであと ${left} 日です。期限が切れると作り直すので、iPad に証明書を入れ直してください。`);
  return out;
}

module.exports = { createLanCertificate, ensureLanCertificate, certWarnings };
