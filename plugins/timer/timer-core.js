// タイマー・アラーム・リマインダーの中身（時間の計算と、鳴らす時刻の管理）。plugin.js から使う
//  時計（now）とタイマー（setTimer / clearTimer）を差し替えられるようにして、テストで時間を進められるようにしている
const MAX_TIMERS = 20;
const MAX_SECONDS = 24 * 60 * 60;
const LATE_MS = 10 * 60 * 1000;      // 起動し直したとき、鳴らす時刻をこれ以上過ぎていたら鳴らさずに消す
const CHECK_MS = 60 * 1000;          // 先のタイマーでも、これだけたったら時刻を確かめ直す（PC のスリープからの復帰・時計の補正に追いつく）
const GENERIC_LABEL = /^(タイマー|アラーム|リマインダー)$/;   // 名前として言われても、名前なしと同じに扱う言葉

// 秒数を、読み上げやすい言葉にする（180 → 3分、5400 → 1時間30分）
function durationText(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (!h && !m) return `${r}秒`;
  return `${h ? `${h}時間` : ""}${m ? `${m}分` : ""}${!h && r ? `${r}秒` : ""}`;
}
// 時刻を読み上げやすい言葉にする（7:00 → 7時、15:30 → 15時30分。now と日が違えば「明日の」）
function clockText(ms, now = ms) {
  const d = new Date(ms), today = new Date(now);
  const day = d.toDateString() === today.toDateString() ? "" : "明日の";
  return `${day}${d.getHours()}時${d.getMinutes() ? `${d.getMinutes()}分` : ""}`;
}
// 「7:30」「15:00」を、次にその時刻になる瞬間（今日か明日）にする
function nextClock(at, now) {
  const m = String(at || "").trim().match(/^(\d{1,2})[:：](\d{2})$/);
  if (!m) throw new Error("時刻は 7:30 のように書いてください");
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error("時刻が正しくありません");
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}
// 鳴ったときに話す言葉（名前はタイマーの名前のことも、リマインダーの内容のこともあるので、どちらでも通じる形にする）
function ringText(t) {
  if (t.label) return `お時間です。${t.label}。`;
  return t.kind === "alarm" ? `${clockText(t.endsAt)}になりました。` : `${durationText(t.seconds)}がたちました。`;
}
// 名前（画面の表示・止めるときの照合にも使う。「明日の」は付けない（日付が変わっても表示が古くならないように））
function nameOf(t) { return t.label || (t.kind === "alarm" ? `${clockText(t.endsAt)}のアラーム` : `${durationText(t.seconds)}のタイマー`); }
// 保存してあったタイマーとして正しい形か
const validTimer = (t) => Boolean(t) && typeof t.id === "string" && Number.isFinite(t.endsAt)
  && (t.kind === "alarm" || (t.kind === "timer" && Number.isFinite(t.seconds))) && typeof (t.label ?? "") === "string";

// store: { load, save }  notify(timer, text): 鳴らす  onChange(list): 一覧が変わった（画面の表示）
function createTimers({ store, notify, onChange = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = console }) {
  let timers = [];
  let seq = 0;
  let handle = null;

  const save = () => { try { store.save({ timers, seq }); } catch { /* 保存できなくても、動いている間は鳴らす */ } };
  const changed = () => { save(); onChange(timers.slice()); schedule(); };

  function schedule() {
    if (handle) clearTimer(handle);
    handle = null;
    if (!timers.length) return;
    const next = Math.min(...timers.map((t) => t.endsAt));
    handle = setTimer(fire, Math.max(0, Math.min(next - now(), CHECK_MS)));
    handle?.unref?.();
  }
  function fire() {
    handle = null;
    const t0 = now();
    const due = timers.filter((t) => t.endsAt <= t0);
    if (!due.length) return schedule();
    timers = timers.filter((t) => t.endsAt > t0);
    try {
      for (const t of due) {
        try { notify(t, ringText(t)); } catch (e) { log.warn("[timer] 知らせられません:", e.message); }   // 1 つの失敗で、ほかを鳴らし損ねない
      }
    } finally { changed(); }
  }

  // 起動したとき: 前に保存したタイマーを読み込む（大きく過ぎたもの・壊れたものは消す。少し過ぎたものはすぐ鳴らす）
  function load() {
    const saved = store.load({}) || {};
    const t0 = now();
    timers = (Array.isArray(saved.timers) ? saved.timers : []).filter((t) => validTimer(t) && t.endsAt > t0 - LATE_MS).slice(0, MAX_TIMERS);
    seq = Number(saved.seq) || 0;
    changed();
  }

  // seconds: 何秒後か  at: 時刻（"7:30"）  label: 何のタイマーか  device: 知らせる画面
  function set({ seconds, at, label = "", device = "" }) {
    if (timers.length >= MAX_TIMERS) throw new Error(`タイマーは ${MAX_TIMERS} 個までです`);
    const t0 = now();
    let t;
    if (at) t = { kind: "alarm", endsAt: nextClock(at, t0) };
    else if (Number.isFinite(seconds) && seconds >= 1 && seconds <= MAX_SECONDS) t = { kind: "timer", seconds: Math.round(seconds), endsAt: t0 + Math.round(seconds) * 1000 };
    else throw new Error("何秒後か（seconds）か、時刻（at）を指定してください");
    const name = String(label).trim();
    const timer = { ...t, id: `t${++seq}`, label: GENERIC_LABEL.test(name) ? "" : name, device, createdAt: t0 };
    timers = [...timers, timer];
    changed();
    const when = timer.kind === "alarm" ? `${clockText(timer.endsAt, t0)}に` : `${durationText(timer.seconds)}後（${clockText(timer.endsAt, t0)}）に`;
    return { timer, text: `${timer.label ? `「${timer.label}」の` : ""}${timer.kind === "alarm" ? "アラーム" : "タイマー"}を、${when}鳴るようにセットしました。` };
  }

  function listText() {
    if (!timers.length) return "セットしているタイマーはありません。";
    const t0 = now();
    const items = timers.slice().sort((a, b) => a.endsAt - b.endsAt)
      .map((t) => `${nameOf(t)}は${t.kind === "alarm" ? `${clockText(t.endsAt, t0)}に鳴ります` : `残り${durationText((t.endsAt - t0) / 1000)}`}`);
    return `タイマーは${timers.length}つです。${items.join("、")}。`;
  }

  // label: 名前で選ぶ（まず名前がそのまま合うもの。無ければ名前の一部が合うものが 1 つだけのとき）
  // all: 全部。どちらも無ければ、1 つだけのときにそれを止める。迷うときは、どれを止めるか聞き返す Error
  function cancel({ label: label0 = "", all = false } = {}) {
    if (!timers.length) throw new Error("セットしているタイマーはありません");
    const label = GENERIC_LABEL.test(String(label0).trim()) ? "" : String(label0).trim();
    const names = () => timers.map(nameOf).join("・");
    let hit;
    if (all) hit = timers;
    else if (label) {
      const exact = timers.filter((t) => nameOf(t) === label || t.label === label);
      const part = timers.filter((t) => nameOf(t).includes(label) || (t.label && label.includes(t.label)));
      hit = exact.length ? exact : part;
      if (!hit.length) throw new Error(`「${label}」のタイマーは見つかりません（あるのは ${names()}）`);
      if (!exact.length && part.length > 1) throw new Error(`「${label}」に当たるタイマーが${part.length}つあります（${part.map(nameOf).join("・")}）。どれを止めるか聞いてください`);
    } else if (timers.length === 1) hit = timers;
    else throw new Error(`タイマーが${timers.length}つあります（${names()}）。どれを止めるか聞いてください`);
    const ids = new Set(hit.map((t) => t.id));
    timers = timers.filter((t) => !ids.has(t.id));
    changed();
    return { text: hit.length === 1 ? `${nameOf(hit[0])}を止めました。` : `タイマーを${hit.length}つ止めました。` };
  }

  function stop() { if (handle) clearTimer(handle); handle = null; }

  return { load, set, cancel, listText, nameOf, stop, list: () => timers.slice() };
}

module.exports = { createTimers, durationText, clockText, nextClock, ringText, nameOf, MAX_TIMERS };
