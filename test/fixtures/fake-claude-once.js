// 偽物の Claude Code（1 回だけ答える。lib/phrases.js の runClaude のテスト用）
//  最初の引数で動きを選ぶ: ok（JSON の返事）| fail（終了コード 2）| slow（答えない）| echo（受け取った頼みの文を返す）
const mode = process.argv[2];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  if (mode === "fail") { process.stderr.write("ログインしていません"); process.exit(2); }
  if (mode === "slow") { setTimeout(() => {}, 60000); return; }
  const result = mode === "echo" ? input : '```json\n{"wait":["ちょっと待ってね。"],"search":["調べてみるね！"]}\n```';
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result, args: process.argv.slice(3) }));
});
