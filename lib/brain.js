// ローカル頭脳: Claude Code を常駐させて会話する（VOICEVOX / AivisSpeech モード用）
//  ・返事は Server-Sent Events（/api/brain/events）で全部の画面に送る。どの発言への返事かの印（turn）を付ける
//  ・PC の画面と iPad などから同時に話しかけられても返事が混ざらないよう、頭には一度にひとつずつ渡す（lib/brain-turns.js）
//  ・応答の速さを測れるよう、最初の文字が届くまでの時間（ms）と、起動直後だったか（cold）を最初の delta に付ける
//  ・しばらく使われなければ止める（会話の続きは持ち越さない）。待受中の画面があれば（warm）、止めたらすぐ新しく起動しておく。
//    止まっていると、呼びかけてすぐの返事が数秒遅れるため（起動に 1〜4 秒かかる）
const fs = require("fs");
const { spawn } = require("child_process");
const { createTurnQueue } = require("./brain-turns");
const { IS_WIN, q, killTree, killTreeSync, childEnv, onLines } = require("./proc");

const WARM_WANTED_MS = 10 * 60 * 1000;
const REFRESH_QUIET_MS = 45 * 1000;   // 追加機能の説明の更新で起動し直すのは、最後の発言からこれだけたってから（会話の続きを忘れないように）
const REFRESH_DELAY_MS = 2000;        // 続けて頼まれた更新を、まとめて 1 回にする   // 待受中の画面が warm を呼んでから、これだけの間は頭を起動したままにする

// Claude Code CLI の引数（stream-json で会話し、途中の文字も受け取る。ツールは tools だけ）
function cliArgs({ model, tools, promptFile }) {
  const empty = IS_WIN ? '""' : "";
  return [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--model", model, "--system-prompt-file", q(promptFile),
    "--tools", ...(tools.length ? tools : [empty]), ...(tools.length ? ["--allowedTools", ...tools] : []),
    "--strict-mcp-config", "--no-session-persistence", "--setting-sources", empty,
  ];
}

// 返事を受け取る画面（Server-Sent Events）の一覧と、全部の画面への送信
function createBroadcaster() {
  const clients = new Set();
  // つながったままにするため、ときどき空の知らせを送る
  const ping = setInterval(() => { for (const r of clients) r.write(": ping\n\n"); }, 20000);
  ping.unref?.();
  return {
    emit(o) {
      const s = `data: ${JSON.stringify(o)}\n\n`;
      for (const r of clients) r.write(s);
    },
    add(req, res) {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": ok\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
    },
  };
}

// binArgs: bin の前に付ける引数（テストで偽物の CLI を node で動かすため）
// promptExtra: 人格のプロンプトの後ろに付ける説明を返す関数（追加機能の使い方。lib/plugins.js）
// refreshQuietMs / refreshDelayMs: 説明の更新（refresh）を、最後の発言からどれだけ待ってからにするか・まとめる長さ（テストで短くする）
function createBrain({
  bin = "claude", binArgs = [], model, tools = [], idleMin = 20, thinkingTokens = "0", workdir, promptSrc, promptFile, vars = {},
  promptExtra = () => "", refreshQuietMs = REFRESH_QUIET_MS, refreshDelayMs = REFRESH_DELAY_MS, log = console,
}) {
  const idleMs = Math.max(0.001, Number(idleMin) || 20) * 60 * 1000;   // 0 や数でない値で、起動と停止を繰り返さないように
  const out = createBroadcaster();
  let child = null, idleTimer = null, stderr = "";
  let spawnedAt = 0, quietStart = false;
  let warmWantedAt = 0;   // 待受中の画面が最後に warm を呼んだ時刻
  let turnClock = { at: 0, first: true, cold: false };   // 返答中の発言の時間の計測

  // 人格のプロンプト。{{USER_NAME}} などを AI の設定の値に置き換えたものに、AI の設定と追加機能の説明を付けて使う
  let writtenPrompt = "";   // 今の頭に渡した説明（変わっていなければ起動し直さない）
  function buildPrompt() {
    // vars は関数でもよい（画面の「AI の設定」で変えた名前・話し方を、書くたびに読む。lib/persona.js）
    const values = typeof vars === "function" ? vars() : vars;
    // 一度にまとめて置き換える（入れた値の中の {{…}} は、そのまま残す）
    const src = fs.readFileSync(promptSrc, "utf8").replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.hasOwn(values, k) ? String(values[k] ?? "") : m));
    let extra = "";
    try { extra = String(promptExtra() || "").trim(); }
    catch (e) { log.warn("[brain] 追加機能の使い方を付けられません:", e.message); }   // 追加機能の書き間違いで、頭が起動できなくならないように
    return extra ? `${src.trimEnd()}\n\n${extra}\n` : src;
  }
  function writePrompt() {
    writtenPrompt = buildPrompt();
    fs.writeFileSync(promptFile, writtenPrompt);
  }

  function onEvent(o) {
    if (o.type === "stream_event") {
      const ev = o.event || {};
      const turn = turns.current();
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
        const timing = turnClock.first ? { first: true, ms: Date.now() - turnClock.at, cold: turnClock.cold } : {};
        turnClock = { ...turnClock, first: false };
        out.emit({ type: "delta", text: ev.delta.text, turn, ...timing });
      } else if (ev.type === "content_block_start" && ev.content_block?.type === "server_tool_use") out.emit({ type: "tool", name: ev.content_block.name, turn });
    } else if (o.type === "result") {
      const turn = turns.finish();   // 順番待ちの発言があれば、ここで次を頭に渡す
      out.emit({ type: "done", turn, text: o.result || "", cost: o.total_cost_usd, ms: o.duration_ms, apiMs: o.duration_api_ms, error: o.is_error || false, interrupted: o.subtype === "error_during_execution" });
    } else if (o.type === "system" && o.subtype === "init") {
      if (!quietStart) log.log(`[brain] 準備完了（${Date.now() - spawnedAt}ms）`);
      out.emit({ type: "ready", model: o.model });
    }
  }

  // quiet: 待受中の起動し直し（ログを出さない）
  function start({ quiet = false } = {}) {
    if (child && child.exitCode === null) return child;
    writePrompt();
    stderr = "";
    spawnedAt = Date.now();
    quietStart = quiet;
    const c = spawn(bin, [...binArgs, ...cliArgs({ model, tools, promptFile })], {
      cwd: workdir, shell: IS_WIN, windowsHide: true, detached: !IS_WIN, env: childEnv({ MAX_THINKING_TOKENS: thinkingTokens }),
    });
    child = c;
    // 止めて入れ替えた古いプロセスの出力・終了は扱わない（新しい発言の返事と混ざらないように）
    onLines(c.stdout, (line) => {
      if (child !== c || !line.trim()) return;
      let o;
      try { o = JSON.parse(line); } catch { return; }   // JSON でない行
      onEvent(o);
    });
    c.stderr.on("data", (d) => { stderr = (stderr + d.toString("utf8")).slice(-2000); });
    c.stdin.on("error", (e) => log.warn("[brain] 書き込めません:", e.message));   // 落ちた直後に書いたとき（EPIPE）
    c.on("error", (e) => { if (child === c) out.emit({ type: "exit", message: e.code === "ENOENT" ? "claude が見つかりません" : e.message }); });
    // 頭が自分で終わった（落ちた）とき: 状態はすぐ（exit）片付け、知らせは出力を読み終えてから（close）送る。
    // 止めて入れ替えた古いプロセス（stop()）は扱わない
    let dropped = null;
    c.on("exit", () => { if (child === c) { child = null; dropped = turns.reset(); } });
    c.on("close", (code, signal) => {
      if (!dropped) return;
      if (code || signal) {
        log.warn(`[brain] exited (${code ?? signal}): ${stderr.trim().slice(-300)}`);
        // 「終了」を先に知らせる（画面は「終了」で待たせていた発言を捨てる。「中断」が先だと、待たせていた発言を送り出してしまう）
        out.emit({ type: "exit", code, message: stderr.trim().split(/\r?\n/).slice(-2).join(" ") || `終了コード ${code ?? signal}` });
      }
      interruptAll(dropped);
    });
    if (!quiet) log.log(`[brain] Claude Code (${model}) を起動しました`);
    armIdle();
    return c;
  }

  // 使われない時間が続いたら止める。待受中の画面があれば、新しい頭をすぐ起動しておく
  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const again = Date.now() - warmWantedAt < WARM_WANTED_MS;
      log.log(again ? "[brain] しばらく使われていないので、会話の続きを忘れて起動し直します" : "[brain] しばらく使われていないので停止します");
      stop();
      if (again) try { start({ quiet: true }); } catch (e) { log.warn("[brain] 起動し直せません:", e.message); }
    }, idleMs);
    idleTimer.unref?.();
  }
  // 返答中・順番待ちだった発言の画面に、返事が来ないことを知らせる
  const interruptAll = (dropped) => { for (const turn of dropped) out.emit({ type: "done", turn, text: "", interrupted: true }); };
  function stop() {
    clearTimeout(idleTimer);
    const c = child;
    child = null;
    if (c) killTree(c);
    interruptAll(turns.reset());
  }
  // 人格のプロンプト（追加機能の使い方）が変わった（追加機能が機器の一覧を読み込んだ、など）。
  // 頭が動いていれば、起動し直して新しい説明を渡す（会話の続きは忘れる）。返答中なら、返答が終わってからにする
  //  ・続けて頼まれても、refreshDelayMs 待ってまとめて 1 回にする
  //  ・会話の途中で続きを忘れないよう、最後の発言から refreshQuietMs たつまで待つ。返答中・順番待ちがあるときも待つ
  //  ・説明が変わっていなければ、起動し直さない
  //  soon: 画面の「AI の設定」を保存したとき。会話の切れ目を待たず、返答中でなければすぐ（試してすぐ確かめられるように）
  let refreshTimer = null, lastSayAt = 0, refreshSoon = false;
  function refresh({ soon = false } = {}) {
    clearTimeout(refreshTimer);
    refreshSoon = refreshSoon || soon;
    if (!child || child.exitCode !== null) { refreshSoon = false; return; }   // 次に起動するときに新しい説明を書く
    const quietUntil = refreshSoon ? 0 : lastSayAt + refreshQuietMs - Date.now();
    refreshTimer = setTimeout(refreshNow, Math.max(refreshDelayMs, quietUntil));
    refreshTimer.unref?.();
  }
  function refreshNow() {
    refreshTimer = null;
    if (!child || child.exitCode !== null) { refreshSoon = false; return; }
    if (turns.busy() || (!refreshSoon && Date.now() - lastSayAt < refreshQuietMs)) return refresh();
    refreshSoon = false;
    if (buildPrompt() === writtenPrompt) return;
    const again = Date.now() - warmWantedAt < WARM_WANTED_MS;
    log.log("[brain] 説明（AI の設定・追加機能の使い方）が変わったので、起動し直します");
    stop();
    if (again) try { start({ quiet: true }); } catch (e) { log.warn("[brain] 起動し直せません:", e.message); }
  }
  // 待受中の画面から（ときどき呼ばれる）: 頭を起動しておく
  function warm() {
    warmWantedAt = Date.now();
    start();
  }

  function write(text) {
    const cold = !child || child.exitCode !== null;
    const c = start();
    turnClock = { at: Date.now(), first: true, cold };
    c.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
    armIdle();
  }
  const turns = createTurnQueue({
    write,
    onFail: (turn, e) => {
      log.warn("[brain] 起動できません:", e.message);
      out.emit({ type: "done", turn, text: `頭（Claude Code）を起動できません: ${e.message}`, error: true });
    },
  });

  function say(text, turn) {
    lastSayAt = Date.now();
    if (!turns.say(text, turn)) out.emit({ type: "done", turn, text: "話しかけられた順番待ちがいっぱいです。少し待ってから、もう一度どうぞ", error: true });
  }

  // 返答の途中で止める（Claude Code の stream-json の中断リクエスト）。
  // まだ順番待ちの発言なら取り消すだけにして、ほかの画面への返答は止めない
  function interrupt(turn) {
    if (turn && turns.cancel(turn)) { out.emit({ type: "done", turn, text: "", interrupted: true }); return; }
    if (turn && turns.current() !== turn) return;   // もう返答が終わった発言
    if (child && child.exitCode === null) child.stdin.write(JSON.stringify({ type: "control_request", request_id: "int-" + Date.now(), request: { subtype: "interrupt" } }) + "\n");
  }

  return { model, start, warm, stop, say, interrupt, refresh, addClient: out.add, killSync: () => killTreeSync(child) };
}

module.exports = { createBrain };
