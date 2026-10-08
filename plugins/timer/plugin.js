// タイマー・アラーム・リマインダー（同梱のプラグイン。書き方の見本も兼ねる。docs/plugins.md）
//  「3分たったら教えて」「7時に起こして」「30分後に洗濯物って言って」
//  鳴ったら、頼んだ画面（PC か iPad など）で音を鳴らして、声で知らせる。残り時間は画面の上の中央に出す
//  セットしたタイマーは data/plugins/timer.json に保存するので、サーバーを起動し直しても残る
const { createTimers, nameOf } = require("./timer-core");

let timers = null;
// 準備ができる前（start の前・start に失敗したあと）に呼ばれたときは、理由を話せる言葉で断る
const ready = () => { if (!timers) throw new Error("タイマーの準備ができていません"); return timers; };

module.exports = {
  id: "timer",
  name: "タイマー",
  description: "タイマー・アラーム（時刻）・リマインダー",
  prompt: `「3分たったら教えて」「7時に起こして」「30分後に洗濯物を取り込むって言って」のように頼まれたら使う。
- 時間は秒に直す（3分 → 180、1時間半 → 5400）。時刻は24時間制で書く（午後3時 → 15:00）。
- label には何のタイマーかを短く書く（言われなければ省く）。リマインダーは知らせる内容を label に書く（例: 洗濯物を取り込む）。
- 「あと何分？」と聞かれたら timer.list を使う。`,
  actions: {
    set: {
      description: "タイマー（seconds 秒後）かアラーム（at の時刻）をセットする。どちらか一方を書く",
      usage: ['<act do="timer.set" seconds="180" label="カップ麺"/>', '<act do="timer.set" at="7:00" label="起床"/>'],
      params: {
        seconds: { type: "number", optional: true, min: 1, max: 86400, integer: true, desc: "秒数" },
        at: { type: "string", optional: true, max: 5, pattern: "\\d{1,2}[:：]\\d{2}", desc: "時刻 7:30" },
        label: { type: "string", optional: true, max: 30, desc: "名前" },
      },
      run: (args, ctx) => ready().set({ ...args, device: ctx.device }),
    },
    list: {
      kind: "query",
      description: "セットしているタイマーと残り時間",
      run: () => ready().listText(),
    },
    cancel: {
      description: "タイマーを止める（label で選ぶ。全部止めるときだけ all=\"true\"）",
      usage: ['<act do="timer.cancel" label="カップ麺"/>', '<act do="timer.cancel" all="true"/>'],
      params: {
        label: { type: "string", optional: true, max: 30, desc: "名前" },
        all: { type: "boolean", optional: true, desc: "true" },
      },
      run: (args) => ready().cancel(args),
    },
  },
  start(ctx) {
    timers?.stop();   // 2 回呼ばれても、前の予約を残さない
    timers = createTimers({
      store: ctx.store,
      log: { warn: ctx.warn },
      notify: (t, text) => ctx.notify({ text, chime: "alarm", to: t.device }),
      onChange: (list) => ctx.setStatus(list.map((t) => ({ id: t.id, text: nameOf(t), endsAt: t.endsAt }))),
    });
    timers.load();
  },
  stop() { timers?.stop(); timers = null; },
};
