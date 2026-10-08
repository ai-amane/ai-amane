// LAN の端末のペアリング（lib/lan-pairing.js）のテスト
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPairingCodes, createDeviceStore } = require("../lib/lan-pairing");

const MIN = 60 * 1000;
// 時計を進められるペアリング番号（番号は順に 123456, 654321, … を出す）
function codesAt(start = 1_000_000, opts = {}) {
  const clock = { t: start };
  const seq = [123456, 654321, 42];
  let i = 0;
  const codes = createPairingCodes({ now: () => clock.t, randomInt: () => seq[i++ % seq.length], ...opts });
  return { codes, clock };
}
const tmpDirs = [];
function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amane-lan-pair-"));
  tmpDirs.push(dir);
  return path.join(dir, "devices.json");
}
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

// ---------- ペアリングの番号 ----------
test("番号は 6 桁で、合っていれば一度だけ使える", () => {
  const { codes } = codesAt();
  assert.equal(codes.issue().code, "123456");
  assert.equal(codes.redeem("123456"), true);
  assert.equal(codes.redeem("123456"), false);
  assert.equal(codes.pending(), null);
});

test("6 桁に満たない数は、頭を 0 で埋める", () => {
  const codes = createPairingCodes({ randomInt: () => 42 });
  assert.equal(codes.issue().code, "000042");
});

test("番号を出していないときは、何を入れても通らない", () => {
  const { codes } = codesAt();
  assert.equal(codes.redeem("123456"), false);
  assert.equal(codes.redeem(""), false);
  assert.equal(codes.redeem(undefined), false);
});

test("番号は 5 分で期限が切れる", () => {
  const { codes, clock } = codesAt();
  const { expiresAt } = codes.issue();
  assert.equal(expiresAt, clock.t + 5 * MIN);
  assert.deepEqual(codes.pending(), { expiresAt });
  clock.t += 5 * MIN;
  assert.equal(codes.pending(), null);
  assert.equal(codes.redeem("123456"), false);
});

test("5 回間違えると番号は無効になる（総当たり対策）", () => {
  const { codes } = codesAt();
  codes.issue();
  for (let k = 0; k < 4; k++) assert.equal(codes.redeem("000000"), false);
  assert.notEqual(codes.pending(), null);   // 4 回まではまだ有効
  assert.equal(codes.redeem("000000"), false);
  assert.equal(codes.pending(), null);
  assert.equal(codes.redeem("123456"), false);   // 5 回目のあとは、正しい番号でも通らない
});

test("番号を出し直すと、前の番号は使えず、間違えた回数も数え直す", () => {
  const { codes } = codesAt();
  codes.issue();
  for (let k = 0; k < 4; k++) codes.redeem("000000");
  assert.equal(codes.issue().code, "654321");
  assert.equal(codes.redeem("123456"), false);
  assert.equal(codes.redeem("654321"), true);
});

test("番号の間の空白やハイフンは無視する", () => {
  const { codes } = codesAt();
  codes.issue();
  assert.equal(codes.redeem(" 123-456 "), true);
});

// ---------- つないだ端末 ----------
test("つないだ端末のトークンで確認でき、ファイルにはトークンそのものを保存しない", () => {
  const file = tmpFile();
  const store = createDeviceStore({ file, now: () => 1000 });
  const { token, device } = store.add("リビングの iPad", "192.168.0.25");
  assert.ok(token.length >= 40);
  assert.equal(device.ip, "192.168.0.25");   // どこからつないだかを PC の画面に出す
  assert.deepEqual(store.verify(token), device);
  assert.equal(device.label, "リビングの iPad");
  assert.equal(store.verify(token + "x"), null);
  assert.equal(store.verify(""), null);
  assert.equal(store.verify(undefined), null);
  const saved = fs.readFileSync(file, "utf8");
  assert.ok(!saved.includes(token), "トークンがそのまま保存されている");
});

test("読み込み直しても（再起動しても）つないだ端末を覚えている", () => {
  const file = tmpFile();
  const { token } = createDeviceStore({ file }).add("iPad");
  const again = createDeviceStore({ file });
  assert.equal(again.verify(token)?.label, "iPad");
  assert.equal(again.list().length, 1);
  assert.deepEqual(Object.keys(again.list()[0]).sort(), ["createdAt", "id", "ip", "label"]);   // 一覧にハッシュは出さない
});

test("すべて解除すると、どのトークンも通らない（読み込み直しても）", () => {
  const file = tmpFile();
  const store = createDeviceStore({ file });
  const a = store.add("iPad").token;
  const b = store.add("スマホ").token;
  store.removeAll();
  assert.equal(store.verify(a), null);
  assert.equal(store.verify(b), null);
  assert.equal(createDeviceStore({ file }).verify(a), null);
});

test("壊れたファイルは、つないだ端末なしとして扱う", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{ broken");
  assert.deepEqual(createDeviceStore({ file }).list(), []);
});

test("端末の名前は 40 文字までで、制御文字や < > を除き、空なら代わりの名前にする", () => {
  const store = createDeviceStore({ file: tmpFile() });
  assert.equal(store.add("あ".repeat(50)).device.label.length, 40);
  assert.equal(store.add("<b>iPad</b>\n").device.label, "biPad/b");
  assert.equal(store.add("\u202eevil\u2028\u0085iPad\u200b").device.label, "eviliPad");   // 表示の向きを変える文字なども除く
  assert.equal(store.add("   ").device.label, "名前なしの端末");
  assert.equal(store.add(undefined).device.label, "名前なしの端末");
});
