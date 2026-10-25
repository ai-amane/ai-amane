// 貼り付ける hooks の設定を表示する（npm run claude-hooks）。~/.claude/settings.json は書き換えない
const path = require("path");
const { hooksSnippet } = require("../lib/claude-hooks");

const snippet = hooksSnippet(path.join(__dirname, "claude-hook.js"));
console.log(`
AI あまね に Claude Code の終わりを声で知らせてもらう設定です。

1. このフォルダの .env に次の行を書いて、AI あまね を起動し直します（初期値はオフです）
     CLAUDE_HOOKS=1
2. 下の設定を、~/.claude/settings.json の "hooks" に貼り付けます
   （Windows は C:\\Users\\あなた\\.claude\\settings.json。すでに "hooks" があるときは、Stop と Notification の中に足します）
3. 外すときは、貼り付けた設定を消し、.env の CLAUDE_HOOKS を 0 にします

${JSON.stringify(snippet, null, 2)}
`);
