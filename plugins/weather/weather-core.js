// 天気予報（気象庁の予報のデータ。API キーは要らない）
//  ・場所の名前（市区町村・都道府県・地方）を、気象庁の予報の区域（一次細分区域）に当てる（area.json）
//  ・予報（今日から 7 日分）を取って、頭が話しやすい短い文にする
//  ・区域の一覧は data/plugins/weather.json に覚えておく（30 日ごとに取り直す）。予報は 10 分だけ覚える
//  出典: 気象庁ホームページ（https://www.jma.go.jp/bosai/forecast/）
const TELOPS = require("./telops");

const BASE = "https://www.jma.go.jp/bosai";
const AREA_MAX_AGE = 30 * 24 * 3600 * 1000;   // 区域の一覧を取り直すまで
const FORECAST_TTL = 10 * 60 * 1000;          // 予報を覚えておく長さ（気象庁の発表は 1 日 3 回）
const FETCH_TIMEOUT_MS = 8000;
const AREA_RETRY_MS = 3600 * 1000;            // 区域の一覧を取り直せなかったとき、前のものを使ってから取り直すまで
const AREA_VERSION = 2;                       // 覚えておく区域の一覧の形（変えたら上げる。形の違う古いものは捨てて取り直す）
const TEXT_MAX = 500;                         // 追加機能の結果の上限（lib/plugins.js）。入らない日は丸ごと落とす
const DAYS = 7;
// 予報のファイルが、ほかの区域のファイルに入っているもの（十勝 → 釧路・根室、奄美 → 鹿児島）
const FILE_OF = { "014030": "014100", "460040": "460100" };
// 都道府県（区域の番号の頭 2 桁）。北海道・鹿児島・沖縄は、県庁のある区域の予報を使う
const PREFS = ["北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県",
  "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県",
  "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県",
  "高知県", "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"];
const PREF_OFFICE = { "01": "016000", 46: "460100", 47: "471000" };
// 府県予報区のいちばん初めの区域が、県庁のある区域ではない県（山口県は西部（下関）が初め。山口市は中部）
const PREF_AREA = { 35: "350020" };
const prefCode = (i) => String(i + 1).padStart(2, "0");
const stem = (p) => (p === "北海道" ? p : p.replace(/[都府県]$/, ""));
const WEEK = "日月火水木金土";

// 気象庁の天気の言葉を、読み上げやすくする（「晴時々曇」→「晴れ時々くもり」、全角の空白 → 半角）
//  「午後」の「後」は「のち」にしない（「晴午後は雷雨」→「晴れ午後は雷雨」）
const readable = (s) => String(s || "").replace(/　+/g, " ").replace(/晴(?!れ)/g, "晴れ").replace(/曇り?/g, "くもり").replace(/(?<!午)後/g, "のち").replace(/止む/g, "やむ").trim();
const hira = (s) => String(s).replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
// 地名だけにする（「東京の天気」「渋谷のあたり」「新宿あたりの天気」→「東京」「渋谷」「新宿」）
const TAIL_RE = /の?(天気|予報|週間天気|あたり|辺り|周辺|付近)$/u;
function placeOf(s) {
  let q = String(s || "").replace(/\s+/g, "");
  for (let i = 0; i < 3 && TAIL_RE.test(q); i++) q = q.replace(TAIL_RE, "");
  return q;
}

// 頭に渡る文字から、タグや知らせの印になる記号を除く（覚えたファイルが書き換えられても、指示のふりをさせない）
const safe = (v) => String(v ?? "").replace(/[<>［］[\]{}]/g, "").slice(0, 40);

// area.json などから、場所を当てるのに要るものだけを残す（覚えておく大きさを減らす）
function compactArea(area, forecastArea, weekArea) {
  const pick = (o, f) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, f(v)]));
  return {
    offices: pick(area.offices, (v) => safe(v.name)),
    class10s: pick(area.class10s, (v) => [safe(v.name), v.parent]),
    class15s: pick(area.class15s, (v) => [safe(v.name), v.parent]),
    class20s: pick(area.class20s, (v) => [safe(v.name), v.parent, safe(v.kana)]),
    // 一次細分区域ごとの、気温の観測点（短期予報。予報に入っている最初の地点を使う）・週間予報の区域と観測点
    stations: Object.fromEntries(Object.values(forecastArea || {}).flat().map((e) => [e.class10, [].concat(e.amedas || []).map(String)])),
    week: pick(weekArea, (list) => list.map((e) => [e.srf, e.week, e.amedas])),
  };
}

// 場所の名前 → { office, class10, label }（見つからなければ null）
//  「広島県府中市」のように都道府県が付いていたら、まずその中から探す（「大阪狭山市」のように見つからなければ、全部から探す）
function resolvePlace(a, raw) {
  const q = placeOf(raw);
  if (!q) return null;
  const whole = prefIndex(q, true);
  if (whole >= 0) return prefPlace(a, whole);
  const pi = prefIndex(q, false);
  if (pi >= 0) {
    const p = PREFS[pi], rest = q.startsWith(p) ? q.slice(p.length) : q.slice(stem(p).length);
    const hit = findPlace(a, rest, prefCode(pi));
    if (hit) return hit;
  }
  return findPlace(a, q, "");
}
// 都道府県の名前そのもの（whole）か、名前で始まる言葉か → PREFS の番号（なければ -1）
//  「京都市」「福島市」のように、県の名前に「市・区・町・村」が続くものは都道府県とみなさない
function prefIndex(q, whole) {
  return PREFS.findIndex((p) => (whole ? q === p || q === stem(p)
    : q.startsWith(p) || (q.startsWith(stem(p)) && q.length > stem(p).length && !/^[市区町村]/.test(q.slice(stem(p).length)))));
}
function prefPlace(a, i) {
  const office = PREF_OFFICE[prefCode(i)] || `${prefCode(i)}0000`;
  // 県庁のある区域（ふつうは、いちばん初め）
  const fixed = PREF_AREA[prefCode(i)];
  const class10 = fixed && a.class10s[fixed] ? fixed : Object.entries(a.class10s).find(([, v]) => v[1] === office)?.[0];
  return class10 ? { office, class10, label: PREFS[i] } : null;
}
// 探す順: 市区町村の名前そのもの → 地方の名前 → 「市」を足した名前（「横浜」→ 横浜市。青森県の横浜町より先に）
//  → 「区・町・村」を足した名前 → 二次細分区域 → 前方一致 → よみがな
function findPlace(a, q, pref) {
  if (!q) return null;
  const only = (o) => Object.entries(o).filter(([code]) => !pref || code.startsWith(pref));
  const c20 = only(a.class20s), c10 = only(a.class10s), c15 = only(a.class15s);
  const find = (list, f) => list.find(([, v]) => f(v[0], v));
  const h = hira(q);
  const tries = [
    () => ["c20", find(c20, (n) => n === q)],
    () => ["c10", find(c10, (n) => n === q || n === q + "地方")],
    () => ["c20", find(c20, (n) => n === q + "市")],
    () => ["c20", find(c20, (n) => n.startsWith(q + "市"))],   // 横浜市北部・横浜市南部
    ...["区", "町", "村"].map((s) => () => ["c20", find(c20, (n) => n === q + s)]),
    () => ["c15", find(c15, (n) => n === q)],
    () => ["c20", find(c20, (n) => n.startsWith(q))],
    // よみがなも「市」を先に（「よこはま」→ 横浜市。青森県の横浜町より先に）
    () => ["c20", h.length >= 2 && find(c20, (n, v) => v[2] === h || v[2].startsWith(h + "し"))],   // よこはましほくぶ
    () => ["c20", h.length >= 2 && find(c20, (n, v) => v[2].replace(/(し|く|ちょう|まち|むら|そん)$/, "") === h)],
  ];
  for (const t of tries) {
    const [kind, hit] = t();
    if (hit) return placeFrom(a, kind, hit);
  }
  return null;
}
// 市区町村 → 二次細分区域のまとまり（class15）→ 一次細分区域（class10）→ 府県予報区（office）
function placeFrom(a, kind, [code, v]) {
  const class10 = kind === "c10" ? code : kind === "c15" ? v[1] : a.class15s[v[1]]?.[1];
  const office = a.class10s[class10]?.[1];
  return office ? { office, class10, label: `${PREFS[Number(code.slice(0, 2)) - 1] || ""} ${v[0]}`.trim() } : null;
}

// 予報の JSON → 日ごとの天気 [{ date, weather, pops: [[時, %]] | null, pop, min, max }]
function daysOf(a, place, json) {
  const [short, week] = json;
  const byDate = new Map();
  const day = (date) => byDate.get(date) || byDate.set(date, { date }).get(date);
  const ts = short?.timeSeries || [];
  const area = (series, code) => series?.areas?.find((x) => x.area.code === code);
  // 短期予報: 天気（3 日分）・降水確率（6 時間ごと）・気温（0 時 = 最低、9 時 = 最高）
  const w = area(ts[0], place.class10);
  ts[0]?.timeDefines.forEach((t, i) => { if (w?.weathers?.[i]) day(t.slice(0, 10)).weather = readable(w.weathers[i]); });
  const p = area(ts[1], place.class10);
  ts[1]?.timeDefines.forEach((t, i) => {
    const v = p?.pops?.[i];
    if (v === undefined || v === "") return;
    const d = day(t.slice(0, 10));
    d.pops = [...(d.pops || []), [Number(t.slice(11, 13)), Number(v)]];
  });
  // 気温: その区域の観測点のうち、予報に入っている最初の地点（どれもなければ気温は出さない。ほかの区域の気温を使わない）
  const sts = [].concat(a.stations[place.class10] || []);
  const tp = sts.map((code) => ts[2]?.areas?.find((x) => x.area.code === code)).find(Boolean);
  ts[2]?.timeDefines.forEach((t, i) => {
    const v = tp?.temps?.[i];
    if (v === undefined || v === "") return;
    const d = day(t.slice(0, 10)), hour = Number(t.slice(11, 13));
    if (hour === 0) d.min = Number(v); else d.max = Number(v);
  });
  // 週間予報: 足りないところを埋める（天気のコード・1 日の降水確率・最低と最高）
  //  探す順: その区域の行 → 名前を含む区域（浜通り → 「中通り・浜通り」）→ 県に 1 つだけの区域
  //  見つからなければ週間予報は使わない（福島県の浜通りに、会津の週間予報を使ってしまわないように）
  const wt = week?.timeSeries || [];
  const entries = a.week[place.office] || [];
  const inData = (e) => wt[0]?.areas?.some((x) => x.area.code === e[1]);
  const name = a.class10s[place.class10]?.[0] || "";
  const byName = name && wt[0]?.areas?.find((x) => x.area.name.includes(name) || name.includes(x.area.name));
  const we = entries.filter((e) => e[0] === place.class10).find(inData)
    || (byName && entries.find((e) => e[1] === byName.area.code))
    || (wt[0]?.areas?.length === 1 ? entries.find(inData) : null);
  const wa = we ? area(wt[0], we[1]) : null;
  const wtemp = we ? wt[1]?.areas?.find((x) => x.area.code === we[2]) : null;
  wt[0]?.timeDefines.forEach((t, i) => {
    const d = day(t.slice(0, 10));
    const code = wa?.weatherCodes?.[i];
    if (!d.weather && TELOPS[code]) d.weather = readable(TELOPS[code]);
    if (!d.pops && wa?.pops?.[i]) d.pop = Number(wa.pops[i]);
    const lo = wtemp?.tempsMin?.[i], hi = wtemp?.tempsMax?.[i];
    if (d.min == null && lo) d.min = Number(lo);
    if (d.max == null && hi) d.max = Number(hi);
  });
  return [...byDate.values()].sort((x, y) => x.date.localeCompare(y.date));
}

// 日本の日付（YYYY-MM-DD）
const jstDate = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (date, n) => jstDate(Date.parse(date + "T00:00:00+09:00") + n * 86400000);

// 頭に渡す文（頭は、聞かれた日のことだけを話す。プラグインの結果は 500 文字まで）
function forecastText(place, days, { now = Date.now(), reportAt = "" } = {}) {
  const today = jstDate(now);
  const names = { [today]: "今日", [addDays(today, 1)]: "明日", [addDays(today, 2)]: "あさって" };
  const all = days.filter((d) => d.date >= today && d.weather).slice(0, DAYS).map((d) => {
    const [y, m, dd] = d.date.split("-").map(Number);
    const wd = WEEK[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
    const temp = d.date === today ? (d.max != null ? `最高${d.max}度` : "") : [d.min != null && `最低${d.min}度`, d.max != null && `最高${d.max}度`].filter(Boolean).join(" ");
    const pop = d.pops ? `降水確率 ${d.pops.map(([h, v]) => `${h}-${h + 6}時${v}%`).join(" ")}` : d.pop != null ? `降水確率${d.pop}%` : "";
    return `${names[d.date] ? names[d.date] + " " : ""}${dd}日(${wd}): ${[d.weather, temp, pop].filter(Boolean).join("。")}`;
  });
  if (!all.length) throw new Error("気象庁の予報に、この場所の天気が見つかりませんでした");
  const at = reportAt ? `気象庁 ${Number(reportAt.slice(5, 7))}月${Number(reportAt.slice(8, 10))}日${Number(reportAt.slice(11, 13))}時発表` : "気象庁";
  // 結果の上限に入る日までにする（本体が文字の途中で切ると「最高2」のように数字の途中で終わるため、行ごと落とす）
  let text = `${place.label}の天気（${at}）`;
  for (const line of all) { if (text.length + 1 + line.length > TEXT_MAX) break; text += "\n" + line; }
  return text;
}

// fetch: 差し替えられるように（テスト）  store: 区域の一覧を覚えておく場所  now: 今の時刻
function createWeather({ fetch: get = globalThis.fetch, store, now = () => Date.now(), log = console } = {}) {
  let area = null;
  const cache = new Map();   // office → { at, json }

  // deadline: 本体が打ち切る時刻（ctx.deadline）。区域の一覧と予報を続けて取っても、その前に終える
  async function json(path, signal, deadline) {
    const ac = new AbortController();
    const stop = () => ac.abort();
    const left = deadline ? Math.min(FETCH_TIMEOUT_MS, deadline - now() - 500) : FETCH_TIMEOUT_MS;
    if (signal?.aborted || left <= 0) throw new Error("時間切れ");
    const timer = setTimeout(stop, left);
    signal?.addEventListener?.("abort", stop, { once: true });
    try {
      const r = await get(`${BASE}/${path}`, { signal: ac.signal, headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(timer); signal?.removeEventListener?.("abort", stop); }
  }
  // 区域の一覧（覚えたものが古ければ取り直す。取れなければ古いものを使う）
  //  覚えたものは形の版（v）を確かめる（形の違う古いものは使わない）
  async function areas(signal, deadline) {
    if (area && now() - area.at < AREA_MAX_AGE) return area.data;
    const loaded = store?.load({}) || {};
    const saved = loaded.v === AREA_VERSION && loaded.area ? loaded : {};
    if (saved.area && now() - saved.at < AREA_MAX_AGE) { area = { at: saved.at, data: saved.area }; return area.data; }
    try {
      const [a, fa, wa] = await Promise.all(["common/const/area.json", "forecast/const/forecast_area.json", "forecast/const/week_area.json"].map((p) => json(p, signal, deadline)));
      area = { at: now(), data: compactArea(a, fa, wa) };
      store?.save({ v: AREA_VERSION, at: area.at, area: area.data });
      return area.data;
    } catch (e) {
      // 前に覚えたものを使い、1 時間たったら取り直す
      if (saved.area) { log.warn?.(`[weather] 区域の一覧を取り直せないので、前に覚えたものを使います: ${e.message}`); area = { at: now() - AREA_MAX_AGE + AREA_RETRY_MS, data: saved.area }; return area.data; }
      throw new Error("気象庁の予報につながりませんでした（インターネットにつながっているか確かめてください）");
    }
  }
  async function forecast(placeName, { signal, deadline } = {}) {
    if (!placeOf(placeName)) throw new Error("どこの天気かが分かりません。場所を聞いてください");
    const a = await areas(signal, deadline);
    const place = resolvePlace(a, placeName);
    if (!place) throw new Error(`「${placeOf(placeName)}」の場所が、気象庁の予報の区域に見つかりませんでした（日本の市区町村か都道府県の名前で聞いてください）`);
    const file = FILE_OF[place.office] || place.office;
    let c = cache.get(file);
    if (!c || now() - c.at > FORECAST_TTL) {
      try { c = { at: now(), json: await json(`forecast/data/forecast/${file}.json`, signal, deadline) }; cache.set(file, c); }
      catch { throw new Error("気象庁の予報を取れませんでした（少しあとで、もう一度聞いてください）"); }
    }
    return forecastText(place, daysOf(a, place, c.json), { now: now(), reportAt: c.json?.[0]?.reportDatetime || "" });
  }
  return { forecast, areas };
}

module.exports = { createWeather, resolvePlace, compactArea, daysOf, forecastText, readable, placeOf };
