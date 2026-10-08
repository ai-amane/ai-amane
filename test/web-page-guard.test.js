// Web ページの表示（lib/web-page.js）の安全対策のテスト
//  家の中の機器（IPv6 を含む）・ほかのポート・ログイン情報入りの URL に行かないこと、
//  時間のかかるページ・細工したページでサーバーが止まらないこと、を確かめる。
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { isPublicAddress, addressPolicy, youtubeEmbed, frameAllowed, extractPage, extractInWorker, fetchPage, fetchImage, inspect } = require("../lib/web-page");

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`, server); } finally { server.closeAllConnections?.(); server.close(); }
}
const anyAddress = { addressAllowed: () => true, portAllowed: () => true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- IPv6 ----------
test("isPublicAddress: IPv6 はインターネット用（2000::/3）だけ。中に IPv4 を包むものや特別な範囲は断る", () => {
  for (const ip of ["2400:4050:1:2::1", "2a00:1450:4001::200e", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of ["2001::1", "2002:c0a8:101::1", "::c0a8:101", "100::1", "fec0::1", "3fff::1", "64:ff9b::c0a8:101",
    "64:ff9b:1::1", "4000::1", "2001:db8::1", "2001:10::1", "2001:20::1", "fe80::1%eth0"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

test("addressPolicy: この PC と同じ家のネットワーク（IPv6 は /48、IPv4 は /24）には行かない", () => {
  const allowed = addressPolicy({
    wifi: [
      { address: "2400:4050:abcd:1200:1234:5678:9abc:def0", family: "IPv6", internal: false },
      { address: "fe80::1234%12", family: "IPv6", internal: false },
      { address: "61.12.34.56", family: "IPv4", internal: false },
      { address: "192.168.1.10", family: "IPv4", internal: false },
    ],
    lo: [{ address: "::1", family: "IPv6", internal: true }],
  });
  for (const ip of ["2400:4050:abcd:1200::1", "2400:4050:abcd:ff00::1", "2400:4050:abcd::", "61.12.34.1", "192.168.1.1", "10.0.0.1"]) {
    assert.equal(allowed(ip), false, ip);
  }
  for (const ip of ["2400:4050:abce::1", "2606:4700:4700::1111", "61.12.35.1", "8.8.8.8"]) assert.equal(allowed(ip), true, ip);
});

// ---------- URL の形 ----------
test("fetchPage: 80 / 443 以外のポートと、ログイン情報入りの URL は断る", async () => {
  await withServer((req, res) => res.end("x"), async (base) => {
    await assert.rejects(fetchPage(base + "/", { addressAllowed: () => true }), /ポート/);
  });
  await assert.rejects(fetchPage("http://user:pass@example.com/"), /ログイン情報/);
  await assert.rejects(fetchPage("https://example.com:8443/"), /ポート/);
});

test("fetchPage: 名前を解決したら家の中だった・転送先が家の中、のときも断る", async () => {
  await withServer((req, res) => res.end("x"), async (base) => {
    const port = new URL(base).port;
    await assert.rejects(fetchPage(`http://localhost:${port}/`, { portAllowed: () => true }), /家の中/);
  });
  await withServer((req, res) => {
    res.writeHead(302, { Location: `http://[::1]:${req.socket.localPort}/secret` });
    res.end();
  }, async (base) => {
    await assert.rejects(fetchPage(base + "/", { addressAllowed: (a) => a === "127.0.0.1", portAllowed: () => true }), (e) => e.code === "EBLOCKED");
  });
});

// ---------- 接続を残さない ----------
test("fetchPage: 転送の応答の本文は読まずに接続を切る", async () => {
  let redirectClosed = false;
  await withServer((req, res) => {
    if (req.url === "/ok") return res.end("<p>ok</p>");
    res.writeHead(302, { Location: "/ok" });
    res.write("x".repeat(1000));   // 終わらない本文
    res.on("close", () => { redirectClosed = true; });
  }, async (base) => {
    const r = await fetchPage(base + "/", anyAddress);
    assert.match(r.html, /ok/);
    for (let i = 0; i < 50 && !redirectClosed; i++) await sleep(20);
    assert.equal(redirectClosed, true, "転送の応答の接続が残っている");
  });
});

test("fetchPage: 少しずつしか届かないページは、全体の時間で打ち切る", async () => {
  await withServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    const t = setInterval(() => res.write("x"), 30);
    res.on("close", () => clearInterval(t));
  }, async (base) => {
    const t0 = Date.now();
    await assert.rejects(fetchPage(base + "/", { ...anyAddress, timeout: 2000, totalTimeout: 300 }), /時間/);
    assert.ok(Date.now() - t0 < 1500, "全体の時間で打ち切られていない");
  });
});

// ---------- YouTube・埋め込みの可否 ----------
test("youtubeEmbed: http(s) 以外は YouTube とみなさない", () => {
  assert.equal(youtubeEmbed("javascript://www.youtube.com/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(youtubeEmbed("ftp://youtu.be/dQw4w9WgXcQ"), null);
});

test("frameAllowed: CSP が複数（カンマ区切り・配列）のときは、ひとつでも禁止していれば埋め込まない", () => {
  assert.equal(frameAllowed({ "content-security-policy": "default-src 'self', frame-ancestors 'none'" }), false);
  assert.equal(frameAllowed({ "content-security-policy": ["default-src *", "frame-ancestors 'self'"] }), false);
  assert.equal(frameAllowed({ "content-security-policy": "frame-ancestors *, frame-ancestors 'self'" }), false);
  assert.equal(frameAllowed({ "content-security-policy": "frame-ancestors *, default-src 'self'" }), true);
});

// ---------- 本文の取り出し ----------
test("extractPage: 題名・説明などは長すぎれば切る", () => {
  const html = `<html><head><title>${"題".repeat(1000)}</title><meta name="description" content="${"説".repeat(5000)}">`
    + `<meta property="og:site_name" content="${"名".repeat(500)}"></head><body><p>x</p></body></html>`;
  const p = extractPage(html, "https://a.example/");
  assert.ok(p.title.length <= 300, "title " + p.title.length);
  assert.ok(p.description.length <= 1000, "description " + p.description.length);
  assert.ok(p.siteName.length <= 100, "siteName " + p.siteName.length);
});

const ARTICLE = `<!doctype html><html><head><title>ページの題名</title><script>${"var a=1;".repeat(20000)}</script></head>
<body><article><h1>記事</h1><p>${"これは本文の段落です。".repeat(10)}</p><p>${"二つ目の段落です。".repeat(10)}</p></article></body></html>`;

test("extractInWorker: 本文の取り出しは別のスレッドで行い、時間がかかりすぎたら題名だけにする", async () => {
  const ok = await extractInWorker(ARTICLE, "https://a.example/");
  assert.match(ok.markdown, /これは本文の段落です。/);
  assert.doesNotMatch(ok.markdown, /var a=1/);
  const late = await extractInWorker(ARTICLE, "https://a.example/", { timeout: 1 });
  assert.equal(late.title, "ページの題名");
  assert.equal(late.markdown, "");
});

// ---------- 同時に調べる数 ----------
test("inspect: 同時に調べられるのは 2 件まで。それ以上は断り、終わればまた調べられる", async () => {
  await withServer((req, res) => setTimeout(() => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<title>t</title><p>x</p>"); }, 300), async (base) => {
    const a = inspect(base + "/a", anyAddress), b = inspect(base + "/b", anyAddress);
    await assert.rejects(inspect(base + "/c", anyAddress), (e) => e.code === "EBUSY");
    await Promise.all([a, b]);
    assert.equal((await inspect(base + "/d", anyAddress)).kind, "embed");
  });
});

// ---------- 画像 ----------
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
test("inspect: 画像の URL なら image と答える（ブラウザは中継を通して表示する）", async () => {
  await withServer((req, res) => { res.writeHead(200, { "Content-Type": "image/png" }); res.end(PNG); }, async (base) => {
    assert.deepEqual(await inspect(base + "/photo", anyAddress), { kind: "image", url: base + "/photo", title: "127.0.0.1" });
  });
});

test("inspect: 動画（mp4）の URL なら video と答え、本文は読まない", async () => {
  let ended = false;
  await withServer((req, res) => {
    res.writeHead(200, { "Content-Type": "video/mp4" });
    res.write(Buffer.alloc(1000));   // 大きな動画（読み終わらない）
    res.on("close", () => { ended = true; });
  }, async (base) => {
    assert.deepEqual(await inspect(base + "/movie", anyAddress), { kind: "video", url: base + "/movie", title: "127.0.0.1" });
    for (let i = 0; i < 50 && !ended; i++) await sleep(20);
    assert.equal(ended, true, "動画を読み続けている");
  });
});

test("fetchImage: 画像だけを取りに行く（HTML・SVG は断る）", async () => {
  await withServer((req, res) => {
    const type = { "/a.png": "image/png", "/b.svg": "image/svg+xml", "/c": "text/html" }[req.url];
    res.writeHead(200, { "Content-Type": type });
    res.end(req.url === "/a.png" ? PNG : "<svg onload=alert(1)></svg>");
  }, async (base) => {
    const img = await fetchImage(base + "/a.png", anyAddress);
    assert.equal(img.type, "image/png");
    assert.deepEqual(img.body, PNG);
    await assert.rejects(fetchImage(base + "/b.svg", anyAddress), (e) => e.code === "ENOTIMAGE");
    await assert.rejects(fetchImage(base + "/c", anyAddress), (e) => e.code === "ENOTIMAGE");
  });
  await assert.rejects(fetchImage("http://192.168.0.1/a.png"), (e) => e.code === "EBLOCKED");
});

// ---------- 細工したページでサーバーが止まらない（2 回目のレビュー） ----------
test("extractInWorker: 「<title」を繰り返したページでも、サーバー（本体のスレッド）は止まらない", async () => {
  const html = "<title".repeat(333334);   // 約 2MB。「>」がない
  let maxGap = 0, last = performance.now();
  const tick = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 10);
  try { await extractInWorker(html, "https://a.example/"); } finally { clearInterval(tick); }
  assert.ok(maxGap < 300, `本体のスレッドが ${Math.round(maxGap)}ms 止まった`);
});

test("extractInWorker: 小文字にすると長さが変わる文字（İ）があっても、取り出しが終わる", async () => {
  const t0 = Date.now();
  const r = await extractInWorker("\u0130".repeat(100) + "<p>本文</p><script>x</script", "https://a.example/");
  assert.ok(Date.now() - t0 < 2500, "取り出しが時間切れまで終わらなかった");
  assert.equal(typeof r.markdown, "string");
});

test("fetchPage: 転送先（Location）のない転送は、分かりやすいエラーにする", async () => {
  await withServer((req, res) => { res.writeHead(302); res.end(); }, async (base) => {
    await assert.rejects(fetchPage(base + "/", anyAddress), /転送先/);
  });
});

test("fetchPage: 101（プロトコルの切り替え）を返されても、全体の時間内に失敗にして、調べる枠を返す", async () => {
  const net = require("node:net");
  const server = net.createServer((sock) => sock.once("data", () => sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const opts = { ...anyAddress, totalTimeout: 500 };
    const t0 = Date.now();
    await assert.rejects(inspect(base + "/a", opts));
    await assert.rejects(inspect(base + "/b", opts));
    assert.ok(Date.now() - t0 < 3000, "決着までに時間がかかりすぎ");
    await assert.rejects(inspect(base + "/c", opts), (e) => e.code !== "EBUSY");   // 枠は返っている
  } finally { server.close(); }
});

test("extractPage: <script></script> をたくさん並べたページでも、すぐ終わる", () => {
  const t0 = Date.now();
  const p = extractPage("<title>t</title>" + "<script></script>".repeat(40000) + "<p>本文です。</p>", "https://a.example/");
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0}ms かかった`);
  assert.equal(p.title, "t");
});
