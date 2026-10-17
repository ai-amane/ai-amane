// かんたんセットアップ（scripts/setup.js）のテスト
//  外のコマンド・HTTP・ファイルは偽物に差し替える。.env は一時フォルダの中だけで扱う
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const S = require("../scripts/setup");

const tmpDirs = [];
const tmpRoot = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "amane-setup-")); tmpDirs.push(d); return d; };
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const EXAMPLE = "# コメント\r\nUSER_NAME=\r\nPORT=\r\nVOICEVOX_AUTOSTART=0\r\nVOICEVOX_PATH=\r\n";
const LOGGED_IN = '{"loggedIn":true,"subscriptionType":"pro"}';

// 偽の外とのやりとり。呼ばれたものを calls に残す
function fakeDeps(root, over = {}) {
  const calls = [];
  const logs = [];
  const rec = (name, ret) => (...a) => { calls.push([name, ...a]); return typeof ret === "function" ? ret(...a) : ret; };
  const res = (u) => ({
    ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4),
    json: async () => (/speakers/.test(u) ? [{ name: "A", styles: [{ id: 7, name: "ふつう" }] }] : {}),
  });
  const d = {
    root, env: {}, isTTY: false, log: (s = "") => logs.push(String(s)),
    exists: (p) => fs.existsSync(p), readText: (p) => fs.readFileSync(p, "utf8"),
    writeText: rec("writeText", (p, s) => fs.writeFileSync(p, s)),
    writeBin: rec("writeBin", (n) => path.join(root, n)),
    exec: rec("exec", (cmd, args) => ({ status: 0, stdout: args[0] === "auth" ? LOGGED_IN : "3 12" })),
    fetchImpl: rec("fetch", async (u) => res(u)),
    sleep: async () => {}, ask: rec("ask", async (q, def) => def),
    removeFile: rec("removeFile"), killTree: rec("killTree"),
    play: rec("play"), spawnEngine: rec("spawnEngine", 1234), openUrl: rec("openUrl"), startBat: rec("startBat"),
    portInUse: rec("portInUse", async () => false), candidates: () => [],
    ...over,
  };
  return { d, calls, logs };
}
const setupRoot = ({ env = false } = {}) => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, ".env.example"), EXAMPLE);
  if (env) fs.writeFileSync(path.join(root, ".env"), "USER_NAME=既存\nPORT=4000\n");
  for (const m of ["kuromoji", "linkedom", path.join("@mozilla", "readability")]) fs.mkdirSync(path.join(root, "node_modules", m), { recursive: true });
  return root;
};
// 実行のうち、読むだけのもの（Python の版・import の確認・ログインの状態）
const readOnlyExec = (c) => c[0] === "exec" && ((c[1] === "python" && c[2][0] === "-c") || (c[1] === "claude" && c[2].join(" ") === "auth status --json"));

test("Python の版: 読み取りと 3.10〜3.12 の判定", () => {
  assert.deepEqual(S.parsePythonVersion("3 12\n"), { major: 3, minor: 12 });
  assert.deepEqual(S.parsePythonVersion("Python 3.10.4"), { major: 3, minor: 10 });
  assert.equal(S.parsePythonVersion(""), null);
  assert.equal(S.parsePythonVersion("Python was not found; run without arguments"), null);
  assert.equal(S.pythonVerdict({ major: 3, minor: 10 }), "ok");
  assert.equal(S.pythonVerdict({ major: 3, minor: 12 }), "ok");
  assert.equal(S.pythonVerdict({ major: 3, minor: 13 }), "too-new");
  assert.equal(S.pythonVerdict({ major: 3, minor: 9 }), "too-old");
  assert.equal(S.pythonVerdict({ major: 2, minor: 7 }), "too-old");
  assert.equal(S.pythonVerdict(null), "none");
});

test("Node の版は 18 以上", () => {
  assert.equal(S.nodeVersionOk("v22.1.0"), true);
  assert.equal(S.nodeVersionOk("v18.0.0"), true);
  assert.equal(S.nodeVersionOk("v16.20.2"), false);
  assert.equal(S.nodeVersionOk(""), false);
});

test(".env の中身: 呼ばれ方と自動起動だけ変え、他の行は変えない", () => {
  const out = S.buildEnv(EXAMPLE, { userName: "田中さん", aivis: true });
  assert.equal(out, "# コメント\r\nUSER_NAME=田中さん\r\nPORT=\r\nVOICEVOX_AUTOSTART=1\r\nVOICEVOX_PATH=\r\n");
  assert.equal(S.buildEnv(EXAMPLE, { userName: "", aivis: false }), EXAMPLE);
  const bad = "a\r\nPORT=1$&";   // 改行を含む名前でも、行が増えない
  assert.equal(S.buildEnv(EXAMPLE, { userName: bad }), EXAMPLE.replace("USER_NAME=", () => "USER_NAME=a  PORT=1" + "$&"));
  assert.ok(S.buildEnv(EXAMPLE, { userName: "x" }).includes("VOICEVOX_AUTOSTART=0"));
});

test("claude auth status の読み取り: 壊れていても落ちない", () => {
  assert.deepEqual(S.parseClaudeStatus('{"loggedIn":true,"subscriptionType":"Max","email":"a@b.c"}'), { loggedIn: true, subscriptionType: "max", valid: true });
  assert.equal(S.parseClaudeStatus('{"loggedIn":false}').loggedIn, false);
  for (const bad of ["", "{oops", "null", "[1]", undefined, "not json"]) assert.equal(S.parseClaudeStatus(bad).loggedIn, false);
  assert.equal(S.parseClaudeStatus("{oops").valid, false);
  assert.equal(S.isPaidPlan("pro"), true);
  assert.equal(S.isPaidPlan("team"), true);
  assert.equal(S.isPaidPlan("free"), false);
  assert.equal(S.isPaidPlan(null), true);
});

test("声を選ぶ: 最初の声の最初のスタイル", () => {
  assert.deepEqual(S.pickVoice([{ name: "A", styles: [{ id: 5, name: "ふつう" }, { id: 6, name: "x" }] }, { name: "B", styles: [{ id: 9 }] }]), { id: 5, name: "A", style: "ふつう" });
  assert.deepEqual(S.pickVoice([{ name: "空", styles: [] }, { name: "B", styles: [{ id: 0, name: "n" }] }]), { id: 0, name: "B", style: "n" });
  assert.equal(S.pickVoice([]), null);
  assert.equal(S.pickVoice(null), null);
  assert.equal(S.pickVoice([{ name: "A" }]), null);
});

test("ポートの値の読み取り", () => {
  assert.equal(S.parsePort("4000"), 4000);
  assert.equal(S.parsePort(undefined), 3939);
  assert.equal(S.parsePort("abc"), 3939);
  assert.equal(S.parsePort("70000"), 3939);
  assert.equal(S.readEnvValue("# PORT=1\nPORT=4001\n", "PORT"), "4001");
  assert.equal(S.readEnvValue("PORT=\n", "PORT"), undefined);
  assert.equal(S.readEnvValue('PORT="4002"\r\n', "PORT"), "4002");
});

test(".env がすでにあれば、書き換えない", async () => {
  const root = setupRoot({ env: true });
  const before = fs.readFileSync(path.join(root, ".env"), "utf8");
  const { d, calls, logs } = fakeDeps(root);
  const r = await S.stepEnv(d, { check: false }, true);
  assert.equal(r.created, false);
  assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), before);
  assert.equal(calls.some((c) => c[0] === "writeText"), false);
  assert.ok(logs.some((l) => l.includes("そのまま使います")));
});

test(".env が無ければ作る（端末でなければ呼ばれ方は空のまま）", async () => {
  const root = setupRoot();
  const { d } = fakeDeps(root);
  const r = await S.stepEnv(d, { check: false }, true);
  assert.equal(r.created, true);
  assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), S.buildEnv(EXAMPLE, { aivis: true }));
});

test("--check: 何も入れず、書かず、鳴らさない（AivisSpeech が無い PC）", async () => {
  const root = setupRoot();
  fs.rmSync(path.join(root, "node_modules"), { recursive: true });
  const { d, calls } = fakeDeps(root, {
    exec: (...a) => { calls.push(["exec", ...a]); return { status: 1, stdout: "" }; },
    fetchImpl: async () => { throw new Error("down"); },
  });
  const code = await S.run(["--check"], d);
  assert.equal(code, 1);   // AivisSpeech が無いので、そこで止まる
  assert.deepEqual(calls.filter((c) => !readOnlyExec(c)), []);
  assert.equal(fs.existsSync(path.join(root, ".env")), false);
});

test("--check: すべてそろっていれば、何も実行せず 0 で終わる", async () => {
  const root = setupRoot({ env: true });
  const before = fs.readFileSync(path.join(root, ".env"), "utf8");
  const { d, calls, logs } = fakeDeps(root, { portInUse: async () => true });
  const code = await S.run(["--check"], d);
  assert.equal(code, 0);
  for (const n of ["writeText", "writeBin", "play", "spawnEngine", "openUrl", "startBat"]) assert.equal(calls.some((c) => c[0] === n), false, n);
  assert.deepEqual(calls.filter((c) => c[0] === "exec" && !readOnlyExec(c)), []);
  assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), before);
  assert.ok(logs.some((l) => l.includes("そのまま使います")));
});

test("通常: 足りないパッケージを入れ、声を作り（鳴らさない）、start.bat を開く", async () => {
  const root = setupRoot({ env: true });
  fs.rmSync(path.join(root, "node_modules", "linkedom"), { recursive: true });
  const { d, calls } = fakeDeps(root, {
    exec: (cmd, args) => {
      calls.push(["exec", cmd, args]);
      const noSherpa = args[0] === "-c" && /sherpa/.test(args[1]);
      return { status: noSherpa ? 1 : 0, stdout: args[0] === "auth" ? LOGGED_IN : "3 12" };
    },
  });
  const code = await S.run(["--no-play"], d);
  assert.equal(code, 0);
  assert.ok(calls.some((c) => c[0] === "exec" && c[1] === "npm"));
  assert.ok(calls.some((c) => c[0] === "exec" && c[2].includes("pip")));
  assert.equal(calls.some((c) => c[0] === "play"), false);
  assert.ok(calls.some((c) => c[0] === "writeBin"));
  assert.ok(calls.some((c) => c[0] === "startBat"));
});

// AivisSpeech がまだ動いていない PC を作る（spawnEngine で動き出す）。fail なら、声の合成が失敗する
function engineDeps(root, { fail = false, running = false } = {}) {
  const exe = path.join(root, "run.exe");
  fs.writeFileSync(exe, "");
  let up = running;
  const ok = (u) => ({
    ok: !(fail && /audio_query/.test(u)), status: 500, arrayBuffer: async () => new ArrayBuffer(4),
    json: async () => (/speakers/.test(u) ? [{ name: "A", styles: [{ id: 7, name: "n" }] }] : {}),
  });
  return fakeDeps(root, {
    candidates: () => [exe],
    fetchImpl: async (u) => { if (!up) throw new Error("down"); return ok(u); },
    spawnEngine: (...a) => { up = true; return 4321; },
  });
}
const killed = (calls) => calls.filter((c) => c[0] === "killTree").map((c) => c[1]);

test("起動した AivisSpeech: VOICEVOX_AUTOSTART=1 なら、声の確認のあとに止める", async () => {
  const root = setupRoot();   // .env は無いので、AivisSpeech が見つかった状態で作られ、AUTOSTART=1 になる
  const { d, calls } = engineDeps(root);
  assert.equal(await S.run(["--no-play"], d), 0);
  assert.deepEqual(killed(calls), [4321]);
  assert.ok(calls.some((c) => c[0] === "startBat"));
});

test("起動した AivisSpeech: VOICEVOX_AUTOSTART が 1 でなければ、止めずに知らせる", async () => {
  const root = setupRoot({ env: true });   // もとからある .env（AUTOSTART の指定なし）
  const { d, calls, logs } = engineDeps(root);
  assert.equal(await S.run(["--no-play"], d), 0);
  assert.deepEqual(killed(calls), []);
  assert.ok(logs.some((l) => l.includes("動いたままにしています")));
});

test("起動した AivisSpeech: 声を作れずに失敗で終わるときは止める", async () => {
  const root = setupRoot({ env: true });
  const { d, calls } = engineDeps(root, { fail: true });
  assert.equal(await S.run(["--no-play"], d), 1);
  assert.deepEqual(killed(calls), [4321]);
});

test("もとから動いていた AivisSpeech は、成功でも失敗でも止めない", async () => {
  for (const fail of [false, true]) {
    const root = setupRoot({ env: true });
    const { d, calls } = engineDeps(root, { fail, running: true });
    assert.equal(await S.run(["--no-play"], d), fail ? 1 : 0);
    assert.deepEqual(killed(calls), []);
    assert.equal(calls.some((c) => c[0] === "spawnEngine"), false);
  }
});

test("声の確認: 鳴らしたあとの wav は消す。--no-play では残す", async () => {
  const root = setupRoot({ env: true });
  const a = fakeDeps(root);
  await S.stepVoice(a.d, { check: false, noPlay: false });
  assert.ok(a.calls.some((c) => c[0] === "play"));
  assert.ok(a.calls.some((c) => c[0] === "removeFile"));
  const b = fakeDeps(root);
  await S.stepVoice(b.d, { check: false, noPlay: true });
  assert.equal(b.calls.some((c) => c[0] === "removeFile" || c[0] === "play"), false);
});
