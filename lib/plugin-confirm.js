// 追加機能（lib/plugins.js）の「画面で確かめてから実行する」動作（confirm）の、確認待ちの一覧
//  ・確認ごとに、どの動作か・引数・頼んだ画面（端末の印）・期限を覚える。画面のボタンが押されたら 1 回だけ使える
//  ・頼んだ画面からしか決められない（ほかの画面から押しても断り、確認は残す）
//  ・頭のタグや ElevenLabs のツールからは決められない（決めるのは /api/plugins/confirm だけで、画面のボタンが呼ぶ）
//  ・1 つの画面の確認待ちは 1 件まで。いっぱいなら新しいほうを断る（ほかの画面の確認は消さない。確認を何枚も出して
//    押し間違いを誘ったり、正しい確認を押し出したりできないように）
//  ・「やめる」を押した動作は、しばらく出し直せない（根負けして押すのを誘えないように）
const crypto = require("crypto");

const CONFIRM_MS = 60 * 1000;     // 確認の期限
const CONFIRM_MAX = 20;           // 全部の画面の確認待ちの数の上限
const PER_DEVICE = 1;             // 1 つの画面の確認待ちの数の上限
const COOLDOWN_MS = 30 * 1000;    // 「やめる」を押した動作を出し直せない時間

// 記録に残す確認の印（id そのものは残さない）
const tagOf = (id) => crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 8);

function createConfirms({ ttlMs = CONFIRM_MS, max = CONFIRM_MAX, perDevice = PER_DEVICE, cooldownMs = COOLDOWN_MS, now = Date.now } = {}) {
  const waiting = new Map();    // id → { plugin, action, args, device, from, question, expiresAt }
  const cooling = new Map();    // 「端末|動作」→ 出し直せるようになる時刻
  const used = new Map();       // 使い終わった id → 覚えておく期限（2 回押されたときに「もう使いました」と返すため）
  const prune = () => {
    const t = now();
    for (const [id, c] of waiting) if (c.expiresAt <= t) waiting.delete(id);
    for (const [k, until] of cooling) if (until <= t) cooling.delete(k);
    for (const [id, until] of used) if (until <= t) used.delete(id);
  };

  // 確認待ちを足す → { ok: true, id, tag, expiresAt } | { ok: false, status, error }
  //  key: 動作の名前（「やめる」のあとの出し直しを止めるのに使う）
  function add(entry, key = "") {
    prune();
    if (cooling.has(`${entry.device}|${key}`)) return { ok: false, status: 429, error: "さきほど「やめる」が押されたので、少し時間をおいてから頼んでください" };
    if ([...waiting.values()].filter((c) => c.device === entry.device).length >= perDevice) {
      return { ok: false, status: 429, error: "画面に確認が出ています。先に画面のボタンで決めてください" };
    }
    if (waiting.size >= max) return { ok: false, status: 429, error: "確認待ちが多すぎます。少し時間をおいてから頼んでください" };
    const id = crypto.randomBytes(16).toString("hex");
    const expiresAt = now() + ttlMs;
    waiting.set(id, { ...entry, key, expiresAt });
    return { ok: true, id, tag: tagOf(id), expiresAt, ttlMs };
  }

  // 画面のボタンで決めた確認を取り出す（1 回だけ）→ { ok: true, entry, tag } | { ok: false, status, error, tag }
  //  cancelled: 「やめる」を押した（同じ動作を、しばらく出し直せないようにする）
  function take(id, device, { cancelled = false } = {}) {
    prune();
    const key = String(id || "");
    const tag = tagOf(key);
    if (used.has(key)) return { ok: false, status: 409, error: "この確認は、もう使いました", tag };
    const c = waiting.get(key);
    if (!c) return { ok: false, status: 410, error: "確認の期限が切れました。もう一度頼んでください", tag };
    if (!device || c.device !== device) return { ok: false, status: 403, error: "確認は、頼んだ画面でしかできません", tag };
    waiting.delete(key);
    used.set(key, now() + ttlMs);
    if (cancelled) cooling.set(`${c.device}|${c.key}`, now() + cooldownMs);
    return { ok: true, entry: c, tag };
  }

  return { add, take, size: () => { prune(); return waiting.size; } };
}

module.exports = { createConfirms, CONFIRM_MS, tagOf };
