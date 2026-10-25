// 起動したときに黒いウィンドウへ出す案内（次にやること）。はじめての人が、起動のあとに迷わないように
//  「AI AMANE is running」の行は README の説明と同じ形で残す
function startupLines({ port, aiName = "あまね", workdir, light, heavy, router, agentId = "", signedUrl = false }) {
  const url = `http://localhost:${port}`;
  return [
    "",
    `  AI AMANE is running: ${url}`,
    "",
    "  ── 次にやること ──",
    `  1. ブラウザで ${url} を開く（自動で開かないときは、このアドレスをブラウザに入れてください）`,
    "  2. 画面を一度クリック →「待受をオン」→ マイクを「許可」",
    `  3. 「${aiName}」と呼ぶ`,
    "  この黒いウィンドウは閉じないでください（閉じると AI あまね が止まります）",
    "",
    `  作業フォルダ: ${workdir}`,
    `  作業担当:     軽い作業=${light}  重い作業=${heavy}  振り分け=${router}`,
    ...(agentId || signedUrl ? [`  ElevenLabs:   エージェント ID ${agentId ? "あり" : "なし（画面で入れる）"}・署名つきの接続 ${signedUrl ? "オン" : "オフ"}`] : []),
    "",
  ];
}

// 声のソフトにつながらないときの案内（起動して少したってから 1 回だけ出す）
function ttsMissingLines({ ttsName, isAivis }) {
  const site = isAivis ? "https://aivis-project.com/" : "https://voicevox.hiroshiba.jp/";
  return [
    "",
    `  ※ 声のソフト（${ttsName}）につながりません。`,
    `     声を出すには、${ttsName} のアプリを開いてください（入っていなければ ${site} から入れます）。`,
    "     声が出ないだけで、画面の文字の返事や作業はそのまま使えます。",
    "",
  ];
}

module.exports = { startupLines, ttsMissingLines };
