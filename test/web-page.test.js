// Web ページの表示（lib/web-page.js）のテスト
//  埋め込みの可否・YouTube と地図の埋め込み URL・本文の取り出し・家の中の機器に行かないこと、を確かめる。
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { isPublicAddress, youtubeEmbed, mapEmbed, routeEmbed, frameAllowed, extractPage, fetchPage, inspect } = require("../lib/web-page");

// ---------- 家の中の機器・特別なアドレスには行かない ----------
test("isPublicAddress: インターネットのアドレスだけ通す", () => {
  for (const ip of ["8.8.8.8", "142.250.196.110", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "255.255.255.255", "198.18.0.1", "192.0.2.1", "::1", "fe80::1", "fd00::1", "::ffff:192.168.0.1", "::", ""]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

// ---------- YouTube と地図 ----------
test("youtubeEmbed: いろいろな YouTube の URL を、埋め込み用の URL にする", () => {
  const e = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&playsinline=1&enablejsapi=1";
  assert.equal(youtubeEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), e);
  assert.equal(youtubeEmbed("https://youtu.be/dQw4w9WgXcQ?t=10"), e);
  assert.equal(youtubeEmbed("https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share"), e);
  assert.equal(youtubeEmbed("https://www.youtube.com/shorts/dQw4w9WgXcQ"), e);
  assert.equal(youtubeEmbed("https://music.youtube.com/watch?v=dQw4w9WgXcQ"), e);
  assert.equal(youtubeEmbed("https://www.youtube.com/playlist?list=PL1234567890abcdef"),
    "https://www.youtube-nocookie.com/embed/videoseries?list=PL1234567890abcdef&autoplay=1&playsinline=1&enablejsapi=1");
  assert.equal(youtubeEmbed("https://example.com/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(youtubeEmbed("https://www.youtube.com/watch?v=bad\"id"), null);
});

test("mapEmbed: 場所の名前から、地図の埋め込み URL を作る", () => {
  assert.equal(mapEmbed("東京駅"), "https://maps.google.com/maps?q=%E6%9D%B1%E4%BA%AC%E9%A7%85&output=embed");
  assert.equal(mapEmbed("  "), null);
});

test("routeEmbed: 出発地・目的地・手段から、道順の埋め込み URL を作る", () => {
  const e = (x) => encodeURIComponent(x);
  assert.equal(routeEmbed("東京駅|東京スカイツリー|電車"), `https://maps.google.com/maps?saddr=${e("東京駅")}&daddr=${e("東京スカイツリー")}&dirflg=r&output=embed`);
  assert.equal(routeEmbed(" 東京駅 ｜ 浅草 ｜徒歩"), `https://maps.google.com/maps?saddr=${e("東京駅")}&daddr=${e("浅草")}&dirflg=w&output=embed`);
  // 手段を省いたとき・分からないときは車（dirflg を付けない）
  assert.equal(routeEmbed("東京駅|浅草"), `https://maps.google.com/maps?saddr=${e("東京駅")}&daddr=${e("浅草")}&output=embed`);
  assert.equal(routeEmbed("東京駅|浅草|ロケット"), routeEmbed("東京駅|浅草"));
  // 出発地か目的地がなければ作らない
  for (const bad of ["", "東京駅", "|浅草", "東京駅|"]) assert.equal(routeEmbed(bad), null, bad);
});

// ---------- 埋め込みの可否 ----------
test("frameAllowed: X-Frame-Options や CSP の frame-ancestors で禁止されていなければ埋め込める", () => {
  assert.equal(frameAllowed({}), true);
  assert.equal(frameAllowed({ "x-frame-options": "DENY" }), false);
  assert.equal(frameAllowed({ "x-frame-options": "sameorigin" }), false);
  assert.equal(frameAllowed({ "content-security-policy": "frame-ancestors 'self'" }), false);
  assert.equal(frameAllowed({ "content-security-policy": "default-src 'self'; frame-ancestors https://example.com" }), false);
  assert.equal(frameAllowed({ "content-security-policy": "frame-ancestors *" }), true);
  assert.equal(frameAllowed({ "content-security-policy": "default-src 'self'" }), true);
});

// ---------- 本文の取り出し ----------
const ARTICLE = `<!doctype html><html><head><title>ページの題名</title>
<meta property="og:title" content="記事の題名"><meta property="og:description" content="記事の説明です">
<meta property="og:image" content="/img/top.jpg"><meta property="og:site_name" content="テスト新聞">
<script>alert(1)</script><style>p{color:red}</style></head>
<body><nav>メニュー ホーム ニュース</nav><article><h1>記事の題名</h1>
<p>${"これは本文の最初の段落です。".repeat(8)}</p><h2>小見出し</h2><p>${"二つ目の段落です。".repeat(10)}</p>
<ul><li>項目その一</li><li>項目その二</li></ul></article><footer>著作権表示</footer></body></html>`;

test("extractPage: 題名・説明・画像（絶対 URL）・本文（Markdown）を取り出し、スクリプトやメニューは入れない", () => {
  const p = extractPage(ARTICLE, "https://news.example.com/a/1");
  assert.equal(p.title, "記事の題名");
  assert.equal(p.description, "記事の説明です");
  assert.equal(p.image, "https://news.example.com/img/top.jpg");
  assert.equal(p.siteName, "テスト新聞");
  assert.match(p.markdown, /これは本文の最初の段落です。/);
  assert.match(p.markdown, /## 小見出し/);
  assert.match(p.markdown, /- 項目その一/);
  assert.doesNotMatch(p.markdown, /alert|color:red|メニュー|著作権表示/);
});

test("extractPage: 代表画像がなければ空（ページ自身の URL にしない）", () => {
  assert.equal(extractPage("<html><head><title>t</title></head><body><p>x</p></body></html>", "https://a.example/page").image, "");
});

test("extractPage: 画像の URL が http(s) でなければ使わない", () => {
  const p = extractPage('<html><head><meta property="og:image" content="javascript:alert(1)"></head><body><p>x</p></body></html>', "https://a.example/");
  assert.equal(p.image, "");
});

// ---------- 取りに行く（テスト用のサーバーで。家の中のアドレスを通すのはテストのときだけ） ----------
async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const anyAddress = { addressAllowed: () => true, portAllowed: () => true };   // テストのサーバーは 127.0.0.1 の空いているポートで動くので

test("fetchPage: 家の中のアドレス（この PC も含む）には行かない", async () => {
  await withServer((req, res) => res.end("secret"), async (base) => {
    await assert.rejects(fetchPage(base + "/", { portAllowed: () => true }), /家の中|インターネット/);
  });
  await assert.rejects(fetchPage("file:///etc/passwd"), /http/);
});

test("fetchPage: 転送先もたどり、文字コード（Shift_JIS）を読み分ける", async () => {
  const sjis = Buffer.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]);   // 「こんにちは」
  await withServer((req, res) => {
    if (req.url === "/old") { res.writeHead(302, { Location: "/new" }); return res.end(); }
    res.writeHead(200, { "Content-Type": "text/html; charset=Shift_JIS", "X-Frame-Options": "DENY" });
    res.end(Buffer.concat([Buffer.from("<html><body><p>"), sjis, Buffer.from("</p></body></html>")]));
  }, async (base) => {
    const r = await fetchPage(base + "/old", anyAddress);
    assert.equal(r.url, base + "/new");
    assert.match(r.html, /こんにちは/);
    assert.equal(r.headers["x-frame-options"], "DENY");
  });
});

test("fetchPage: 転送が多すぎる・大きすぎるページは断る", async () => {
  await withServer((req, res) => { res.writeHead(302, { Location: "/loop" }); res.end(); }, async (base) => {
    await assert.rejects(fetchPage(base + "/loop", anyAddress), /転送/);
  });
  await withServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("x".repeat(3_000_000)); }, async (base) => {
    await assert.rejects(fetchPage(base + "/", { ...anyAddress, maxBytes: 1_000_000 }), /大きすぎ/);
  });
});

test("inspect: YouTube は取りに行かずに埋め込む。埋め込めるページは埋め込み、だめなページは本文を返す", async () => {
  assert.deepEqual(await inspect("https://youtu.be/dQw4w9WgXcQ"), {
    kind: "embed", url: "https://youtu.be/dQw4w9WgXcQ",
    embed: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&playsinline=1&enablejsapi=1", title: "YouTube",
  });
  await withServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...(req.url === "/deny" ? { "X-Frame-Options": "DENY" } : {}) });
    res.end(ARTICLE);
  }, async (base) => {
    const ok = await inspect(base + "/ok", anyAddress);
    assert.equal(ok.kind, "embed");
    assert.equal(ok.embed, base + "/ok");
    assert.equal(ok.title, "記事の題名");
    const deny = await inspect(base + "/deny", anyAddress);
    assert.equal(deny.kind, "article");
    assert.match(deny.markdown, /二つ目の段落です。/);
  });
});
