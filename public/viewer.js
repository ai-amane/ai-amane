// AI あまね 資料の表示パネル
//  文章・表（簡易 Markdown）・画像・動画・PDF を、パネルに表示する。
//  パネルは表示するものに合わせて、右・左・中央（大きく）に出す（place）。
//  AI の姿はパネルをよけて動く（setOnFocus で知らせる。中央に大きく出すときは、後ろで小さくなる）
window.AmaneViewer = (() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const ui = { stage: $("stage"), viewer: $("viewer"), title: $("viewerTitle"), body: $("viewerBody"), close: $("viewerClose") };
  const PLACES = ["right", "left", "center"];
  const IMAGE_EXT = /^(png|jpe?g|gif|webp|svg|bmp|avif)$/;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let onFocus = () => {};

  // 簡易 Markdown（見出し・箇条書き・太字・コード・表・リンク）
  function mdToHtml(md) {
    const lines = esc(md).split(/\r?\n/);
    let html = "", inList = null, inCode = false, table = [];
    const inline = (t) => t.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const flushList = () => { if (inList) { html += `</${inList}>`; inList = null; } };
    const flushTable = () => {
      if (!table.length) return;
      const rows = table.filter((r) => !/^\|?\s*:?-+/.test(r));
      html += "<table>" + rows.map((r, i) => "<tr>" + r.replace(/^\||\|$/g, "").split("|").map((c) => `<${i ? "td" : "th"}>${inline(c.trim())}</${i ? "td" : "th"}>`).join("") + "</tr>").join("") + "</table>";
      table = [];
    };
    for (const l of lines) {
      if (/^```/.test(l)) { flushList(); flushTable(); html += inCode ? "</pre>" : "<pre>"; inCode = !inCode; continue; }
      if (inCode) { html += l + "\n"; continue; }
      if (/^\s*\|/.test(l)) { flushList(); table.push(l.trim()); continue; } else flushTable();
      let m;
      if ((m = l.match(/^(#{1,3})\s+(.*)/))) { flushList(); html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; }
      else if ((m = l.match(/^\s*[-*・]\s+(.*)/))) { if (inList !== "ul") { flushList(); html += "<ul>"; inList = "ul"; } html += `<li>${inline(m[1])}</li>`; }
      else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (inList !== "ol") { flushList(); html += "<ol>"; inList = "ol"; } html += `<li>${inline(m[1])}</li>`; }
      else if (!l.trim()) { flushList(); }
      else { flushList(); html += `<p>${inline(l)}</p>`; }
    }
    flushList(); flushTable(); if (inCode) html += "</pre>";
    return html;
  }
  const isUrl = (s) => /^https?:\/\//i.test(s);
  const fileUrl = (src) => "/api/file?path=" + encodeURIComponent(src);
  // ほかのサイトの画像は、ブラウザが直接ではなく、サーバーの中継（家の中の機器には行かない）を通して読む
  const proxied = (url) => "/api/web/image?url=" + encodeURIComponent(url);
  const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ""; } };

  function loadImage(url, timeout = 10000) {
    return new Promise((ok, ng) => {
      const img = new Image();
      const t = setTimeout(() => ng(new Error("画像の読み込みがタイムアウトしました")), timeout);
      img.onload = () => { clearTimeout(t); ok(img); };
      img.onerror = () => { clearTimeout(t); ng(new Error("画像を読み込めません")); };
      img.src = url;
    });
  }

  // 置き場所の指定がないときは、中身で決める（PDF・Web ページ・地図のように大きく見たいものは中央、ほかは右）
  const isYouTube = (src) => /^https?:\/\/([\w-]+\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)\//i.test(src);
  const isWeb = (src, ext) => /^(map|route):/i.test(src) || (isUrl(src) && !IMAGE_EXT.test(ext) && !/^(mp4|webm)$/.test(ext));
  const autoPlace = (src, ext) => (isYouTube(src) ? "right" : ext === "pdf" || isWeb(src, ext) ? "center" : "right");
  const linkHtml = (url, label) => `<p><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label || url)}</a></p>`;
  // 自動再生・全画面を許すのは、YouTube と地図の埋め込み（server.js が作った URL）だけ
  const isTrustedEmbed = (url) => /^https:\/\/(www\.youtube-nocookie\.com\/embed\/|maps\.google\.com\/maps\?)/.test(url);

  async function showImage(body, url, alt) {
    const img = await loadImage(url);
    body.classList.add("media");
    img.alt = alt;
    body.append(img);
  }
  function showVideo(body, url) {
    body.classList.add("media");
    const v = document.createElement("video");
    v.src = url; v.controls = true; v.autoplay = true; v.muted = true;
    body.append(v);
  }
  // sandbox: ほかのサイトのページか（作業フォルダの PDF は、ブラウザの PDF ビューアーが sandbox の中では動かないので付けない）
  //  sandbox などは、読み込みが始まる前（src を入れて画面に加える前）に付ける。後から付けても、最初の読み込みには効かない
  function showFrame(body, url, { sandbox = true } = {}) {
    body.classList.add("frame");
    const f = document.createElement("iframe");
    if (sandbox) {
      f.allow = isTrustedEmbed(url) ? "autoplay; encrypted-media; picture-in-picture; fullscreen" : "";
      // ほかのサイトのページは、この画面とは別のオリジンとして動き、この画面には触れられない
      f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-forms allow-presentation");
      // YouTube は送り元（この画面のオリジン）が分からないと再生できないので、オリジンだけ送る
      f.referrerPolicy = isYouTube(url) ? "strict-origin-when-cross-origin" : "no-referrer";
    }
    f.src = url;
    body.append(f);
  }

  // Web ページ・YouTube・地図・ほかのサイトの画像や動画（server.js が下調べする。家の中の機器には行かない）
  //  埋め込めるもの（YouTube・地図・許可しているページ）はそのまま埋め込み、だめなページは本文を読みやすく整えて出す
  async function showWeb(body, src, title) {
    const r = await fetch("/api/web/inspect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: src }) });
    const info = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(info.error || "HTTP " + r.status);
    // 見出しは、ページが名乗る題名ではなくサイトの名前（ホスト名）にする（ページの題名で、この画面の一部のように見せかけられないように）
    if (!title) ui.title.textContent = isTrustedEmbed(info.embed || "") ? info.title || "" : hostOf(info.url);
    if (info.kind === "image") return showImage(body, proxied(info.url), title);
    // ほかのサイトの動画は、ブラウザに直接読ませない（画面の CSP でも止めている）ので、リンクで出す
    if (info.kind === "video") { body.innerHTML = linkHtml(info.url, "動画を開く（" + hostOf(info.url) + "）"); return; }
    // 埋め込むのは https のページだけ（画面の CSP。家の機器の管理画面の多くは http なので、転送されても読み込まない）。
    // http のページは本文で出す
    if (info.kind === "embed" && /^https:/i.test(info.embed || "")) return showFrame(body, info.embed);
    if (info.kind === "link" || !(info.markdown || info.description)) { body.innerHTML = linkHtml(info.url || src); return; }
    const site = info.siteName ? `${info.siteName}（${hostOf(info.url)}）` : hostOf(info.url);
    body.innerHTML = (info.image ? `<img class="web-hero" src="${esc(proxied(info.image))}" alt="">` : "")
      + `<p class="web-site">${esc(site)}</p>`
      + (info.description ? `<p class="web-desc">${esc(info.description)}</p>` : "")
      + mdToHtml(info.markdown || "")
      + linkHtml(info.url, "元のページを開く");
    // 代表画像が読めなければ、画像だけ消す
    body.querySelector(".web-hero")?.addEventListener("error", (e) => e.target.remove());
  }

  function setPlace(where) {
    for (const p of PLACES) ui.viewer.classList.toggle(`place-${p}`, p === where);
    ui.stage.classList.add("focus");
    ui.stage.dataset.focus = where;
    onFocus(where);
  }

  // title: 見出し  src: 作業フォルダ内のファイル or URL  text: Markdown  place: right | left | center
  async function show({ title = "", src = "", text = "", place = "" } = {}) {
    src = String(src || "").trim(); text = String(text || "");
    const body = ui.body;
    body.className = "viewer-body"; body.innerHTML = "";
    ui.title.textContent = title || (src ? src.split(/[\\/]/).pop() : "");
    const ext = (src.split("?")[0].match(/\.(\w+)$/) || [])[1]?.toLowerCase() || "";
    setPlace(PLACES.includes(place) ? place : autoPlace(src, ext));
    try {
      const external = isUrl(src);
      // 画像は iframe ではなく img で、パネルの幅に収めて表示する
      if (src && IMAGE_EXT.test(ext)) await showImage(body, external ? proxied(src) : fileUrl(src), title);
      else if (src && !external && /^(mp4|webm)$/.test(ext)) showVideo(body, fileUrl(src));
      // 作業フォルダ内の PDF だけ、ブラウザの PDF ビューアーで表示する
      else if (src && !external && ext === "pdf") showFrame(body, fileUrl(src), { sandbox: false });
      // ほかのサイトのもの（ページ・画像・動画）と地図は、サーバーが先に下調べする
      else if (src && (external || /^(map|route):/i.test(src))) await showWeb(body, src, title);
      else if (src) {
        const r = await fetch(fileUrl(src)); const t = await r.text();
        if (!r.ok) throw new Error((() => { try { return JSON.parse(t).error; } catch { return "HTTP " + r.status; } })());
        body.innerHTML = /^(md|markdown|txt)$/.test(ext) || !ext ? mdToHtml(t) : `<pre>${esc(t)}</pre>`;
      } else {
        body.innerHTML = mdToHtml(text);
      }
    } catch (e) {
      body.innerHTML = `<p>表示できませんでした：${esc(e.message)}</p>`;
    }
    body.scrollTop = 0;
    ui.viewer.classList.add("show");
    return "画面に表示しました。";
  }

  function hide() {
    // 音楽・動画は、閉じたらすぐ止める（パネルは消えるまで少しかかるので、埋め込みと動画は先に外す）
    for (const el of ui.body.querySelectorAll("iframe, video")) el.remove();
    ui.viewer.classList.remove("show");
    ui.stage.classList.remove("focus");
    delete ui.stage.dataset.focus;
    onFocus(false);
    return "表示を閉じました。";
  }
  ui.close.onclick = hide;

  return { show, hide, setOnFocus(fn) { onFocus = fn; } };
})();
