// 天気予報（同梱のプラグイン。気象庁の予報のデータを使う。API キーは要らない）
//  「明日の天気は？」「週末、大阪は雨降る？」「傘いる？」
//  Web 検索より確かで速い（検索では予報のページが見つからないことや、関係のない指示が混ざることがある）
//  区域の一覧は data/plugins/weather.json に覚えておく。出典: 気象庁ホームページ
const { createWeather } = require("./weather-core");

let weather = null;
const ready = () => { if (!weather) throw new Error("天気予報の準備ができていません"); return weather; };

module.exports = {
  id: "weather",
  name: "天気予報",
  description: "気象庁の天気予報（日本国内。今日から 7 日分）",
  prompt: `天気・気温・雨・傘が要るか・週間天気を聞かれたら、Web 検索ではなく weather.forecast を使う（気象庁の予報）。
- place には市区町村か都道府県の名前を書く（例: 東京、世田谷区、大阪市、札幌）。同じ名前の市があるときは県も書く（例: 広島県府中市）。
- 場所を言われなければ、「あなたについて」の地域を使う。それも分からなければ、どこの天気か聞く。
- 結果には今日から 7 日分が入っている。聞かれた日のことだけを、短く話す（全部は読まない）。降水確率は「午後から雨が降りそう」のように言い換える。
- 日本の外の天気は、Web 検索で調べる。`,
  actions: {
    forecast: {
      kind: "query",
      description: "その場所の天気予報（天気・最低と最高の気温・降水確率）",
      usage: ['<act do="weather.forecast" place="東京"/>'],
      params: { place: { type: "string", max: 30, desc: "地名" } },
      run: (args, ctx) => ready().forecast(args.place, { signal: ctx.signal, deadline: ctx.deadline }),
    },
  },
  start(ctx) {
    weather = createWeather({ store: ctx.store, log: { warn: ctx.warn } });
  },
  stop() { weather = null; },
};
