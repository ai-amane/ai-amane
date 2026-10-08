// 追加機能（プラグイン）の画面側
//  ・頭の返事のタグ（<act do="timer.set" seconds="180"/>。local-voice.js）を、サーバー（/api/plugins/act）に送って実行する
//  ・サーバーからの知らせ（/api/plugins/events）を受け取る: 声で伝えること（say）と、画面に出す状態（status。タイマーの残り時間など）
//  ・この画面（端末）の印を作って覚えておく。知らせは、頼んだ画面に届く（PC と iPad の両方で開いていても、頼んだほうで鳴る）。
//    印は届け先の目印で、認証ではない（同じブラウザのタブどうしは同じ印になる）
window.AmanePlugins = (() => {
  "use strict";
  const KEY = "amane.device";
  const hasDom = typeof document !== "undefined";

  // 残り時間の表示（3:05 / 1:02:03）
  function remainText(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
  }
  // タグの属性から、動作の名前（do）と引数を分ける
  function splitTag(at = {}) {
    const { do: name = "", ...args } = at;
    return { name: String(name), args };
  }

  function deviceId() {
    try {
      let id = localStorage.getItem(KEY);
      if (!/^[\w-]{8,40}$/.test(id || "")) { id = "d" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36); localStorage.setItem(KEY, id); }
      return id;
    } catch { return ""; }
  }

  // 動作を実行する → { ok, kind, text } | { ok: false, error }
  async function act(name, args = {}) {
    try {
      const r = await fetch("/api/plugins/act", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ do: name, args, device: deviceId() }),
      });
      const j = await r.json().catch(() => ({}));
      return r.ok ? { ok: true, kind: j.kind, text: j.text || "", confirm: j.confirm } : { ok: false, error: j.error || "HTTP " + r.status };
    } catch (e) { return { ok: false, error: "サーバーに接続できません: " + e.message }; }
  }

  // ---- 確かめてから実行する動作（confirm）: 画面に確認のボタンを出し、押されたらサーバーに伝える ----
  // 確認の残り秒数（表示用）
  const secondsLeft = (expiresAt, now = Date.now()) => Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const READY_MS = 1000;      // 確認が出てから「実行する」を押せるようになるまで（続けてのタップで、思わず押さないように）
  // 確認が出てから、声の答えを受け付けるまで。前の確認に言った「お願い」が、文字になるまでの間に出た新しい確認に当たらないように
  //  （話し終わりから文字になるまで 0.5〜1 秒ほどかかる）
  const VOICE_READY_MS = 1500;
  const TTL_MAX_MS = 120000;  // 期限の長さの上限（サーバーから変な長さが届いても、確認を出しっぱなしにしない）
  // 確認のボタンで決めたことをサーバーに伝える → { ok, kind, text } | { ok: false, status, error }（status 0: 届いたか分からない）
  async function decide(id, ok) {
    try {
      const r = await fetch("/api/plugins/confirm", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ok, device: deviceId() }),
      });
      const j = await r.json().catch(() => ({}));
      return r.ok ? { ok: true, kind: j.kind, text: j.text || "" } : { ok: false, status: r.status, error: j.error || "HTTP " + r.status };
    } catch (e) { return { ok: false, status: 0, error: "サーバーに接続できません: " + e.message }; }
  }
  // 確認が出ている間の声の答え（「お願い」「はい」→ yes、「やめて」「いいえ」→ no、それ以外 → ""）
  const YES_WORDS = /^(?:(?:はい|うん|ええ)[、,\s]*)?(?:お願い(?:します)?|おねがい(?:します)?|実行(?:して|する|します)?|始めて|はじめて|やって|開けて|いいよ|いいです|オッケー|オーケー|ok|okay|どうぞ|頼む|たのむ|よろしく)$|^(?:はい|うん)$/i;
  const NO_WORDS = /^(?:いいえ|いや|やめて|やめる|やめます|やめといて|キャンセル|中止|だめ|ダメ|いらない|しない|なし)(?:です|にして|して)?$/;
  function voiceAnswerOf(text) {
    const t = String(text || "").normalize("NFKC").trim().replace(/[。．.！!？?\s]+$/u, "").replace(/^(?:じゃあ|では|それじゃ)[、,\s]*/, "");
    return YES_WORDS.test(t) ? "yes" : NO_WORDS.test(t) ? "no" : "";
  }

  // Web ページを開く前に確かめたほうがよい URL か → 理由（確かめなくてよければ空）
  //  だまされた頭が、会話や作業の結果をアドレスに付けて外のサイトに送る手口（長い文字列の付いた URL）と、IP アドレスで直に指すものを確かめる
  function urlRisk(src) {
    let u;
    try { u = new URL(String(src)); } catch { return ""; }
    if (!/^https?:$/.test(u.protocol)) return "";
    if (/^\[.*\]$|^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname)) return "サイトの名前ではなく、番号（IP アドレス）で指定されています";
    const tail = u.search + u.hash;
    const longValue = [...u.searchParams.values()].some((v) => v.length > 64) || /[A-Za-z0-9+/=_-]{48,}/.test(tail + u.pathname);
    if (tail.length > 160 || longValue) return "アドレスに長い文字列が付いています（会話の中身などを送ろうとしているかもしれません）";
    return "";
  }

  let active = null;   // いま画面に出ている確認（声で決めるため）
  // confirm: { id, title, text, label, voice（any | owner | none）, ttlMs（期限までの長さ） }
  // onDone(result): 決めた結果。expired: 期限が切れた（何も実行していない）。by: "button" | "voice"
  // decideImpl(ok): 決めたときの処理（省くとサーバーの確認待ちに伝える。作業の依頼など、画面だけの確認ではここで渡す）
  function showConfirm(confirm, onDone = () => {}, { decide: decideImpl = (ok) => decide(confirm.id, ok) } = {}) {
    const box = hasDom && document.getElementById("pluginConfirm");
    if (!box || !confirm?.id) return onDone({ ok: false, expired: true, error: "確認を画面に出せませんでした" });
    active?.cancel();   // 1 つの画面に出す確認は 1 枚だけ（前の確認は、期限切れと同じに扱う）
    const card = document.createElement("div");
    card.className = "confirm-card";
    card.setAttribute("role", "alertdialog");
    const qid = "confirm-q-" + String(confirm.id).slice(0, 8);
    card.setAttribute("aria-labelledby", qid);
    // 見出し（何を実行するか。本体が決める）と、確認の文（プラグインが決める）を分けて出す
    const head = document.createElement("p"); head.className = "confirm-title"; head.textContent = confirm.title || "";
    const q = document.createElement("p"); q.className = "confirm-q"; q.id = qid; q.textContent = confirm.text;
    const left = document.createElement("p"); left.className = "confirm-left";
    const yes = document.createElement("button"); yes.className = "btn confirm-yes"; yes.textContent = confirm.label || "実行する";
    const no = document.createElement("button"); no.className = "btn confirm-no"; no.textContent = "やめる";
    const row = document.createElement("div"); row.className = "confirm-row"; row.append(no, yes);
    const voice = ["any", "owner", "none"].includes(confirm.voice) ? confirm.voice : "owner";
    const shownAt = Date.now();
    const hint = document.createElement("p"); hint.className = "confirm-hint";
    hint.textContent = voice === "none" ? "画面のボタンで決めてください" : "声でも決められます（「お願い」／「やめて」）";
    card.append(head, q, row, hint, left);
    box.replaceChildren(card);
    // 端末の時計がサーバーとずれていても、期限までの長さで数える（少し早めに閉じる。サーバーの期限を過ぎてから押させない）
    const ttl = Number(confirm.ttlMs);
    const until = Date.now() + Math.max(0, Math.min(Number.isFinite(ttl) ? ttl : 60000, TTL_MAX_MS) - 1000);
    yes.disabled = true;
    setTimeout(() => { if (!sent) yes.disabled = false; }, READY_MS);
    let done = false, sent = false;
    const me = {};
    const finish = (r) => {
      if (done) return;
      done = true; clearInterval(tick); card.remove();
      if (active === me) active = null;
      onDone(r);
    };
    const tick = setInterval(() => {
      const s = secondsLeft(until);
      left.textContent = "あと " + s + " 秒";
      if (!s) finish({ ok: false, expired: true, error: "確認の期限が切れたので、実行しませんでした" });
    }, 250);
    left.textContent = "あと " + secondsLeft(until) + " 秒";
    // 押したら（言ったら）数えるのをやめて、結果を待つ（決めたあとに期限が来ても、実行した結果を伝える）
    async function answer(ok, by) {
      if (done || sent) return;
      sent = true;
      clearInterval(tick);
      yes.disabled = no.disabled = true;
      left.textContent = ok ? "実行しています…" : "やめています…";
      const r = await decideImpl(ok);
      finish({ ...r, by });
    }
    yes.onclick = (e) => { e.stopPropagation(); if (!yes.disabled) answer(true, "button"); };
    no.onclick = (e) => { e.stopPropagation(); answer(false, "button"); };
    Object.assign(me, {
      voice,
      // 声で決める。出てから VOICE_READY_MS たつまでは受け付けない（false を返す。前の確認への答えかもしれないため）
      say(ok) { if (Date.now() - shownAt < VOICE_READY_MS) return false; answer(ok, "voice"); return true; },
      cancel() { finish({ ok: false, expired: true, error: "新しい確認が出たので、前の確認はやめました" }); },
    });
    active = me;
    return me;
  }
  // いま画面に出ている確認（声で決めるため）。無ければ null
  const activeConfirm = () => active;

  // ---- 画面に出す状態（画面の上の中央に、残り時間などを並べる） ----
  const statuses = new Map();   // plugin → { items, offset（サーバーとこの端末の時計のずれ） }
  let tick = null;
  function render() {
    const box = hasDom && document.getElementById("pluginStatus");
    if (!box) return;
    const now = Date.now();
    const chips = [...statuses.values()].flatMap(({ items, offset }) => items.map((it) => ({ ...it, left: it.endsAt ? it.endsAt - (now + offset) : null })));
    box.replaceChildren(...chips.map((c) => {
      const el = document.createElement("span");
      el.className = "plugin-chip";
      const name = document.createElement("span"); name.textContent = c.text;
      el.append(name);
      if (c.left != null) { const t = document.createElement("b"); t.textContent = remainText(c.left); el.append(t); }
      return el;
    }));
    const counting = chips.some((c) => c.left != null && c.left > 0);
    if (counting && !tick) tick = setInterval(render, 500);
    else if (!counting && tick) { clearInterval(tick); tick = null; }
  }

  // onSay(ev): 声で伝える知らせ（ev.text・ev.chime・ev.fallback）。サーバーが届け先の画面にだけ送る
  //  （fallback: 届け先がつながっていなかったので、全部の画面に送られた知らせ）
  function connect({ onSay = () => {} } = {}) {
    const me = deviceId();
    const es = new EventSource("/api/plugins/events?device=" + encodeURIComponent(me));
    es.onmessage = (e) => {
      let ev;
      try { ev = JSON.parse(e.data); } catch { return; }
      if (ev.type === "status") {
        statuses.set(ev.plugin, { items: Array.isArray(ev.items) ? ev.items : [], offset: Number(ev.now) ? ev.now - Date.now() : 0 });
        render();
      } else if (ev.type === "say") onSay(ev);
    };
    return es;
  }

  return { act, decide, showConfirm, activeConfirm, voiceAnswerOf, urlRisk, connect, deviceId, splitTag, remainText, secondsLeft };
})();
