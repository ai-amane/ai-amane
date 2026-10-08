// 作業の委任: Codex CLI / Claude Code CLI をバックグラウンドで起動して、結果（音声で読み上げる報告）を返す
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { IS_WIN, q, killTree, killTreeSync, childEnv, redactSecrets, onLines } = require("./proc");

const ENGINE_LABEL = {
  "codex-fast": "Codex（Fast）", codex: "Codex", "claude-opus": "Claude Code（Opus）", "claude-sonnet": "Claude Code（Sonnet）",
};
const engineLabel = (engine) => ENGINE_LABEL[engine] || engine;

// aiName: 名前か、名前を返す関数（画面の「AI の設定」で変えた名前を、作業のたびに読む）
function buildPrompt(task, { aiName, workdir }) {
  const name = typeof aiName === "function" ? aiName() : aiName;
  return [
    `あなたは音声アシスタント「${name}」の作業担当です。ユーザーが音声で依頼した次の作業を実行してください。`,
    `作業フォルダ: ${workdir}`,
    "ルール:",
    "- 依頼は音声認識なので聞き間違いの可能性があります。意図が曖昧なうえに取り返しのつかない操作（削除・上書き・外部への送信・購入など）は実行せず、報告で確認を求めてください。",
    "- 作業が終わったら、最後に必ず「【報告】」で始まる段落を書き、音声で読み上げる結果報告を日本語の話し言葉で2〜3文にまとめてください。記号・URL・コード・箇条書きは含めないでください。",
    "- 作った画像や資料など、ユーザーの画面に表示すると分かりやすいファイルがあれば、最後に「【表示】ファイルの絶対パス」を1行だけ書いてください（画像・PDF・テキスト・Markdown が表示できます）。",
    "",
    "依頼: " + task,
  ].join("\n");
}

function engineCommand(engine, outFile, { env, workdir }) {
  const codexBin = env("CODEX_BIN", "codex");
  const claudeBin = env("CLAUDE_BIN", "claude");
  const codexBase = ["exec", "--json", "--skip-git-repo-check", "-s", env("CODEX_SANDBOX", "workspace-write"), "-C", q(workdir), "-o", q(outFile)];
  const codexModel = env("CODEX_MODEL") ? ["-m", env("CODEX_MODEL")] : [];
  const claudeBase = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", env("CLAUDE_PERMISSION_MODE", "acceptEdits")];
  switch (engine) {
    case "codex-fast": return { bin: codexBin, args: [...codexBase, ...codexModel, "-c", 'service_tier="fast"', "--enable", "fast_mode", "-"] };
    case "codex": return { bin: codexBin, args: [...codexBase, ...codexModel, "-"] };
    case "claude-sonnet": return { bin: claudeBin, args: [...claudeBase, "--model", "sonnet"] };
    case "claude-opus":
    default: return { bin: claudeBin, args: [...claudeBase, "--model", "opus"] };
  }
}

// 作業担当の最後の文章から、読み上げる報告（【報告】の段落）を取り出す
function extractReport(text) {
  if (!text) return "";
  const i = text.lastIndexOf("【報告】");
  const s = (i >= 0 ? text.slice(i + 4) : text).split("【表示】")[0];
  return s.replace(/[#*`>|_]/g, "").replace(/\s+/g, " ").trim().slice(0, 400);
}

// 画面と頭に渡す作業の様子。作業担当が書いた文（報告・結果・途中経過・エラー）からは、秘密の値を伏せる（redactSecrets）
const hide = (s) => (s == null ? s : redactSecrets(s));
const publicTask = (t) => ({
  id: t.id, task: t.task, engine: t.engine, engineLabel: engineLabel(t.engine),
  level: t.level, routedBy: t.routedBy, status: t.status, startedAt: t.startedAt, endedAt: t.endedAt,
  progress: t.progress.slice(-3).map(hide), report: hide(t.report), showPath: t.showPath, result: hide(t.result?.slice(0, 4000)), error: hide(t.error), usage: t.usage,
});

// 作業担当の出力（1 行の JSON）を、途中経過と使用量に反映する
function handleCodexLine(t, obj) {
  const item = obj.item || obj.msg || {};
  const type = item.type || item.item_type || obj.type;
  if (type === "command_execution" && item.command) t.progress.push("実行: " + String(item.command).slice(0, 80));
  else if ((type === "file_change" || type === "patch_apply_begin") && item.changes) t.progress.push("ファイル変更");
  else if (type === "agent_message" && item.text) { t.progress.push("メモ: " + item.text.slice(0, 60)); t.lastText = item.text; }
  else if (type === "reasoning" && item.text) t.progress.push("思考中…");
  else if ((obj.type === "error" || obj.type === "turn.failed") && (obj.message || obj.error)) t.progress.push("エラー: " + String(obj.message || obj.error?.message || obj.error).slice(0, 80));
  const usage = obj.usage || obj.info?.total_token_usage;
  if (usage) {
    const prev = t.usage || { input_tokens: 0, output_tokens: 0 };
    t.usage = { input_tokens: prev.input_tokens + (usage.input_tokens || 0), output_tokens: prev.output_tokens + (usage.output_tokens || 0) };
  }
}
function handleClaudeLine(t, obj) {
  if (obj.type === "assistant" && obj.message?.content) {
    for (const c of obj.message.content) {
      if (c.type === "tool_use") t.progress.push("ツール: " + c.name + (c.input?.command ? " " + String(c.input.command).slice(0, 60) : c.input?.file_path ? " " + path.basename(c.input.file_path) : ""));
      else if (c.type === "text" && c.text) { t.progress.push("メモ: " + c.text.slice(0, 60)); t.lastText = c.text; }
    }
  } else if (obj.type === "result") {
    t.finalText = obj.result || t.lastText;
    t.isError = Boolean(obj.is_error);
    t.usage = {
      input_tokens: obj.usage?.input_tokens, output_tokens: obj.usage?.output_tokens,
      cost_usd_equivalent: obj.total_cost_usd, turns: obj.num_turns,
    };
  }
}

// 作業が終わったとき: 結果・報告・表示するファイルを取り出し、状態を決める
function finishTask(t, { code, stderr, timeoutSec }) {
  t.endedAt = Date.now();
  let text = t.finalText || "";
  try { if (fs.existsSync(t.outFile)) { text = fs.readFileSync(t.outFile, "utf8") || text; fs.unlink(t.outFile, () => {}); } } catch { /* 結果のファイルが無い */ }
  text = text || t.lastText || "";
  t.result = text;
  t.report = extractReport(text);
  const mShow = text.match(/【表示】\s*(.+)/);
  if (mShow) t.showPath = mShow[1].trim().replace(/^["'`]|["'`]$/g, "");
  if (t.status === "cancelled") return text;
  if (t.timedOut) { t.status = "error"; t.error = `${timeoutSec}秒でタイムアウトしました`; }
  else if (t.status !== "error" && (code !== 0 || t.isError)) {
    t.status = "error";
    t.error = (t.error || stderr.trim().split(/\r?\n/).slice(-3).join(" ") || `終了コード ${code}`).slice(0, 400);
  } else if (t.status !== "error") t.status = "done";
  return text;
}

function createTaskRunner({ env, workdir, aiName, decideLevel, lightEngine, heavyEngine, maxParallel = 2, timeoutSec = 900, appendLog = () => {}, log = console }) {
  const tasks = new Map();
  let seq = 0;

  async function start({ task, level: hint, engine: engineReq }) {
    const running = [...tasks.values()].filter((t) => t.status === "running").length;
    if (running >= maxParallel) throw new Error(`同時に実行できる作業は${maxParallel}件までです`);

    const id = String(++seq);
    const chosen = engineReq === "codex" ? { engine: "codex-fast", level: "light", routedBy: "指名" }
      : engineReq === "claude" ? { engine: "claude-opus", level: "heavy", routedBy: "指名" }
        : await decideLevel(task, hint).then(({ level, by }) => ({ level, routedBy: by, engine: level === "heavy" ? heavyEngine : lightEngine }));
    const { engine, level, routedBy } = chosen;

    const outFile = path.join(os.tmpdir(), `amane-task-${Date.now()}-${id}.txt`);
    const { bin, args } = engineCommand(engine, outFile, { env, workdir });
    const t = { id, task, level, engine, routedBy, status: "running", startedAt: Date.now(), progress: ["開始"], outFile };
    tasks.set(id, t);

    const child = spawn(bin, args, { cwd: workdir, shell: IS_WIN, windowsHide: true, detached: !IS_WIN, env: childEnv() });
    t.child = child;
    child.stdin.end(buildPrompt(task, { aiName, workdir }));

    let stderr = "";
    onLines(child.stdout, (raw) => {
      const line = raw.trim();
      if (!line) return;
      try {
        const obj = JSON.parse(line);
        engine.startsWith("codex") ? handleCodexLine(t, obj) : handleClaudeLine(t, obj);
      } catch { t.progress.push(line.slice(0, 80)); }
      if (t.progress.length > 50) t.progress = t.progress.slice(-50);
    });
    child.stderr.on("data", (d) => { stderr = (stderr + d.toString("utf8")).slice(-3000); });

    const timer = setTimeout(() => { t.timedOut = true; killTree(child); }, timeoutSec * 1000);
    child.on("error", (e) => {
      t.status = "error";
      t.error = e.code === "ENOENT" ? `${bin} が見つかりません（インストールとPATHを確認してください）` : e.message;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = finishTask(t, { code, stderr, timeoutSec });
      delete t.child;
      appendLog("tasks.jsonl", { ...publicTask(t), result: text.slice(0, 20000) });
      log.log(`[task ${id}] ${t.status} (${engineLabel(engine)}, ${((t.endedAt - t.startedAt) / 1000).toFixed(1)}s)`);
    });

    log.log(`[task ${id}] ${engineLabel(engine)} <- "${task.slice(0, 60)}" (level=${level}, by=${routedBy})`);
    return publicTask(t);
  }

  const list = () => [...tasks.values()].slice(-20).reverse().map(publicTask);
  function cancel(id) {
    const t = tasks.get(id);
    if (!t) return null;
    if (t.status === "running") { t.status = "cancelled"; killTree(t.child); }
    return publicTask(t);
  }
  const killAll = () => { for (const t of tasks.values()) killTreeSync(t.child); };
  // 作業担当が動いているか、終わってから withinMs たっていないか（追加機能の「画面で確認」の動作を止めるのに使う。
  // 作業担当はこの PC のプログラムなので、だまされると、画面のボタンを押したのと同じ要求をサーバーに送れるため）
  const active = (withinMs = 0, now = Date.now()) => [...tasks.values()].some((t) => t.status === "running" || (t.endedAt && now - t.endedAt < withinMs));

  return { start, list, cancel, killAll, active };
}

module.exports = { createTaskRunner, engineLabel, extractReport, buildPrompt };
