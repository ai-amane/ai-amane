// 天気予報（plugins/weather）のテスト
//  気象庁のデータは test/fixtures/weather に置いた本物の一部（2026-10-09 17 時発表）。通信は偽物の fetch にする
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createWeather, resolvePlace, compactArea, forecastText, readable, placeOf } = require("../plugins/weather/weather-core");
const weatherPlugin = require("../plugins/weather/plugin");
const { checkPlugin } = require("../lib/plugin-load");

const FIX = path.join(__dirname, "fixtures", "weather");
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
const FILES = {
  "common/const/area.json": "area.json",
  "forecast/const/forecast_area.json": "forecast_area.json",
  "forecast/const/week_area.json": "week_area.json",
  "forecast/data/forecast/130000.json": "forecast-130000.json",
  "forecast/data/forecast/014100.json": "forecast-014100.json",
  "forecast/data/forecast/070000.json": "forecast-070000.json",
  "forecast/data/forecast/350000.json": "forecast-350000.json",
  "forecast/data/forecast/380000.json": "forecast-380000.json",
};
const NOW = Date.parse("2026-10-09T20:00:00+09:00");
const area = compactArea(read("area.json"), read("forecast_area.json"), read("week_area.json"));

// 偽物の fetch（取ったファイルを数える。fail: 通信できないふり）
function fakeFetch({ fail = false } = {}) {
  const calls = [];
  const fn = async (url) => {
    const p = url.replace("https://www.jma.go.jp/bosai/", "");
    calls.push(p);
    if (fail) throw new Error("ネットにつながらない");
    if (!FILES[p]) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => read(FILES[p]) };
  };
  return Object.assign(fn, { calls });
}
function memoryStore(initial = {}) {
  let v = initial;
  return { load: () => v, save: (x) => { v = JSON.parse(JSON.stringify(x)); }, get: () => v };
}
const setup = (o = {}) => {
  const fetch = o.fetch || fakeFetch();
  let now = o.now ?? NOW;
  const store = o.store || memoryStore();
  const w = createWeather({ fetch, store, now: () => now, log: { warn() {} } });
  return { w, fetch, store, advance: (ms) => { now += ms; } };
};

test("言葉: 気象庁の天気の言葉を、読み上げやすくする", () => {
  assert.equal(readable("晴時々曇"), "晴れ時々くもり");
  assert.equal(readable("曇後一時雨"), "くもりのち一時雨");
  assert.equal(readable("晴れ　夜　くもり"), "晴れ 夜 くもり");
  assert.equal(readable("雨時々止む"), "雨時々やむ");
  assert.equal(readable("晴午後は雷雨"), "晴れ午後は雷雨");   // 「午後」は「午のち」にしない
});

test("地名: 「の天気」「あたり」などを除く", () => {
  assert.equal(placeOf("東京の天気"), "東京");
  assert.equal(placeOf("渋谷のあたり"), "渋谷");
  assert.equal(placeOf("新宿あたりの天気"), "新宿");
  assert.equal(placeOf(" 大阪 "), "大阪");
});

test("場所: 市区町村・都道府県・地方の名前を、予報の区域に当てる", () => {
  const at = (q) => { const r = resolvePlace(area, q); return r && [r.office, r.class10, r.label]; };
  assert.deepEqual(at("東京"), ["130000", "130010", "東京都"]);
  assert.deepEqual(at("東京都"), ["130000", "130010", "東京都"]);
  assert.deepEqual(at("世田谷区"), ["130000", "130010", "東京都 世田谷区"]);
  assert.deepEqual(at("渋谷"), ["130000", "130010", "東京都 渋谷区"]);
  assert.deepEqual(at("八丈島"), ["130000", "130030", "東京都 八丈島"]);
  assert.deepEqual(at("北海道"), ["016000", "016010", "北海道"]);
  assert.deepEqual(at("札幌"), ["016000", "016010", "北海道 札幌市"]);
  assert.deepEqual(at("帯広"), ["014030", "014030", "北海道 帯広市"]);
});

test("場所: 同じ名前は「市」を先に、県が付いていればその県の中から探す", () => {
  const at = (q) => resolvePlace(area, q)?.label;
  assert.equal(at("横浜"), "神奈川県 横浜市北部");    // 青森県の横浜町より、横浜市（「市」を先に）
  assert.equal(at("横浜町"), "青森県 横浜町");
  assert.equal(at("府中"), "東京都 府中市");          // 広島県の府中町より、東京都の府中市（「市」を先に）
  assert.equal(at("広島県府中市"), "広島県 府中市");
  assert.equal(at("広島府中"), "広島県 府中市");
  assert.equal(at("大阪狭山市"), "大阪府 大阪狭山市");   // 「大阪」で始まるが、大阪府の「狭山市」ではない
  assert.equal(at("大阪"), "大阪府");
  assert.equal(at("大阪市"), "大阪府 大阪市");
  assert.equal(at("よこはま"), "神奈川県 横浜市北部");  // よみがなでも「市」を先に
  assert.equal(at("山口"), "山口県");
  assert.equal(resolvePlace(area, "山口").class10, "350020");   // 山口県は、いちばん初めの区域（西部）ではなく、県庁のある中部
  assert.equal(at("ニューヨーク"), undefined);
  assert.equal(at(""), undefined);
});

test("予報: 今日から 7 日分を、日ごとに 1 行にする（今日は最高気温だけ、6 時間ごとの降水確率）", async () => {
  const { w } = setup();
  const text = await w.forecast("世田谷区");
  const lines = text.split("\n");
  assert.equal(lines[0], "東京都 世田谷区の天気（気象庁 10月9日17時発表）");
  assert.equal(lines[1], "今日 9日(金): 晴れ。降水確率 18-24時0%");
  assert.equal(lines[2], "明日 10日(土): 晴れ。最低16度 最高26度。降水確率 0-6時0% 6-12時0% 12-18時0% 18-24時0%");
  assert.equal(lines[3], "あさって 11日(日): 晴れ。最低16度 最高27度。降水確率10%");
  assert.equal(lines[4], "12日(月): くもり時々晴れ。最低16度 最高25度。降水確率30%");   // 週間予報（天気のコード）から
  assert.equal(lines.length, 8);
  assert.ok(text.length <= 500, "追加機能の結果の上限（500 文字）に収める");
});

test("予報: 島の区域は、その区域の天気と観測点の気温を使う（週間予報は、まとまった区域）", async () => {
  const { w } = setup();
  const lines = (await w.forecast("八丈島")).split("\n");
  assert.equal(lines[2], "明日 10日(土): くもり 時々 晴れ。最低20度 最高25度。降水確率 0-6時10% 6-12時10% 12-18時10% 18-24時20%");
  assert.match(lines[4], /^12日\(月\): くもり時々晴れ。最低21度 最高24度。降水確率30%$/);   // 週間は「伊豆諸島」と八丈島の気温
});

test("予報: 週間予報は自分の区域のものを使い、同じ県の別の地方のものを使わない（いわきに会津の週間予報を使わない）", async () => {
  const { w } = setup();
  const iwaki = (await w.forecast("いわき")).split("\n"), aizu = (await w.forecast("会津若松")).split("\n");
  assert.equal(iwaki[4], "12日(月): くもり時々晴れ。最低15度 最高24度。降水確率30%");   // 週間予報の「中通り・浜通り」と小名浜の気温
  assert.equal(aizu[4], "12日(月): 晴れ時々くもり。最低14度 最高25度。降水確率20%");    // 「会津」と若松の気温
});

test("予報: 気温は、その区域の観測点のうち予報に入っているものを使う（新居浜に松山の気温を使わない）", async () => {
  const { w } = setup();
  assert.match((await w.forecast("新居浜")).split("\n")[2], /最低16度 最高27度/);
  assert.match((await w.forecast("松山")).split("\n")[2], /最低17度 最高28度/);
});

test("予報: 結果の上限（500 文字）に入らない日は、行ごと落とす", () => {
  const long = "くもり 所により 昼過ぎ から 夕方 まで 雨 で 雷を伴い 激しく 降る";
  const days = Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-${String(9 + i).padStart(2, "0")}`, weather: long, min: 10, max: 20,
    pops: [[0, 10], [6, 20], [12, 30], [18, 40]] }));
  const text = forecastText({ label: "東京都" }, days, { now: NOW, reportAt: "2026-10-09T05:00:00+09:00" });
  assert.ok(text.length <= 500, String(text.length));
  assert.ok(text.split("\n").every((l) => /(%|発表）)$/.test(l)), "どの行も途中で切れていない");
  assert.ok(text.split("\n").length < 8);
});

test("予報: 十勝は、釧路・根室のファイルから読む", async () => {
  const { w, fetch } = setup();
  const text = await w.forecast("帯広");
  assert.ok(fetch.calls.includes("forecast/data/forecast/014100.json"));
  assert.match(text.split("\n")[2], /^明日 10日\(土\): 晴れ 朝晩 くもり。最低9度 最高24度/);
});

test("覚えておく: 区域の一覧は保存して使い回し、予報は 10 分たったら取り直す", async () => {
  const { w, fetch, store, advance } = setup();
  await w.forecast("東京");
  await w.forecast("渋谷");
  assert.equal(fetch.calls.filter((c) => c.includes("forecast/data")).length, 1);
  assert.equal(fetch.calls.filter((c) => c.includes("const/")).length, 3);
  advance(11 * 60 * 1000);
  await w.forecast("東京");
  assert.equal(fetch.calls.filter((c) => c.includes("forecast/data")).length, 2);
  // 起動し直しても、保存した区域の一覧を使う（取り直さない）
  const again = setup({ store: memoryStore(store.get()) });
  await again.w.forecast("東京");
  assert.equal(again.fetch.calls.filter((c) => c.includes("const/")).length, 0);
  // 形の版が違う（古い形の）保存は使わず、取り直す
  const old = setup({ store: memoryStore({ ...store.get(), v: 1 }) });
  await old.w.forecast("東京");
  assert.equal(old.fetch.calls.filter((c) => c.includes("const/")).length, 3);
});

test("覚えておく: 区域の一覧を取り直せなければ前のものを使い、1 時間たったら取り直す", async () => {
  const first = setup();
  await first.w.forecast("東京");
  const saved = { ...first.store.get(), at: NOW - 31 * 24 * 3600 * 1000 };   // 31 日前に覚えた（古い）
  let fail = true;
  const base = fakeFetch(), calls = [];
  const fetch = async (url) => { calls.push(url); if (fail && url.includes("const/")) throw new Error("つながらない"); return base(url); };
  const later = setup({ fetch, store: memoryStore(saved) });
  await later.w.forecast("東京");                        // 古いものを使って答える
  const n = calls.filter((c) => c.includes("const/")).length;
  await later.w.forecast("東京");
  assert.equal(calls.filter((c) => c.includes("const/")).length, n);   // すぐには取り直さない
  later.advance(61 * 60 * 1000); fail = false;
  await later.w.forecast("東京");
  assert.ok(calls.filter((c) => c.includes("const/")).length > n);
});

test("失敗: 理由を話せる言葉で返す", async () => {
  await assert.rejects(setup({ fetch: fakeFetch({ fail: true }) }).w.forecast("東京"), /気象庁の予報につながりませんでした/);
  await assert.rejects(setup().w.forecast("ニューヨーク"), /「ニューヨーク」の場所が、気象庁の予報の区域に見つかりませんでした/);
  await assert.rejects(setup().w.forecast("  "), /どこの天気か/);
  // 予報のファイルが取れない（このテストのデータに大阪府の予報は入れていない）
  await assert.rejects(setup().w.forecast("堺市"), /気象庁の予報を取れませんでした/);
});

test("プラグイン: 本体の決まりに合う（読み込める形・確認の動作）", () => {
  const { specs } = checkPlugin(weatherPlugin, "weather");
  assert.equal(weatherPlugin.actions.forecast.kind, "query");
  assert.equal(specs.forecast.place.type, "string");
  assert.throws(() => weatherPlugin.actions.forecast.run({ place: "東京" }, {}), /準備ができていません/);
});
