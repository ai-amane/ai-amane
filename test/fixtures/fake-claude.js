// テスト用の偽物の Claude Code（stream-json で会話する。lib/brain.js のテストで使う）
//  user の発言ごとに、少し待ってから 2 つに分けて返事を返し、最後に result を送る
const readline = require("readline");

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const delta = (text) => out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });

out({ type: "system", subtype: "init", model: "fake-model" });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== "user") return;
  if (msg.message.content === "落ちて") { process.stderr.write("fake crash"); process.exit(3); }   // 頭が落ちたとき
  setTimeout(() => {
    delta("はい、");
    delta(`${msg.message.content}ですね。`);
    out({ type: "result", result: "ok", total_cost_usd: 0, duration_ms: 50, duration_api_ms: 40 });
  }, 50);
});
