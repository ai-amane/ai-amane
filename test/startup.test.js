// 起動の案内（lib/startup.js）と、声のソフトにつながらないときの案内（lib/companions.js の checkTts）のテスト
const test = require("node:test");
const assert = require("node:assert/strict");
const { startupLines, ttsMissingLines } = require("../lib/startup");
const { createCompanions } = require("../lib/companions");

const base = { port: 3939, workdir: "C:/ai-amane/workspace", light: "claude-sonnet", heavy: "claude-opus", router: "auto" };

test("起動の案内: アドレス・次にやること 3 つ・窓を閉じない注意を出す。README と同じ AI AMANE is running の行も残す", () => {
  const text = startupLines({ ...base, aiName: "あまね" }).join("\n");
  assert.match(text, /AI AMANE is running: http:\/\/localhost:3939/);
  assert.match(text, /1\. ブラウザで http:\/\/localhost:3939 を開く/);
  assert.match(text, /「待受をオン」→ マイクを「許可」/);
  assert.match(text, /3\. 「あまね」と呼ぶ/);
  assert.match(text, /閉じないでください/);
});

test("起動の案内: AI の名前を変えていれば、その名前で呼ぶように出す", () => {
  assert.match(startupLines({ ...base, aiName: "ハル" }).join("\n"), /「ハル」と呼ぶ/);
});

test("起動の案内: ElevenLabs の行は、エージェント ID か鍵があるときだけ出す（古い英語の行は出さない）", () => {
  const plain = startupLines(base).join("\n");
  assert.doesNotMatch(plain, /ElevenLabs|Agent ID|Private agent/);
  assert.match(startupLines({ ...base, agentId: "abc" }).join("\n"), /ElevenLabs: +エージェント ID あり/);
});

test("声のソフトの案内: AivisSpeech と VOICEVOX で入れ先のページを分ける", () => {
  assert.match(ttsMissingLines({ ttsName: "AivisSpeech", isAivis: true }).join("\n"), /AivisSpeech のアプリを開いてください.*aivis-project\.com/);
  assert.match(ttsMissingLines({ ttsName: "VOICEVOX", isAivis: false }).join("\n"), /voicevox\.hiroshiba\.jp/);
});

test("checkTts: つながらなければ案内を出して false、つながれば何も出さず true", async () => {
  const make = (ok) => {
    const lines = [];
    const c = createCompanions({ env: () => "", rootDir: ".", sttUrl: "", ttsUrl: "http://127.0.0.1:10101", ttsName: "AivisSpeech", isAivis: true,
      log: { log: (s) => lines.push(s), warn: (s) => lines.push(s) }, reach: async () => ok });
    return { c, lines };
  };
  const off = make(false);
  assert.equal(await off.c.checkTts(), false);
  assert.match(off.lines.join("\n"), /AivisSpeech）につながりません/);
  const on = make(true);
  assert.equal(await on.c.checkTts(), true);
  assert.equal(on.lines.length, 0);
});
