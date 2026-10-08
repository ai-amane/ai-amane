// 追加機能の確認待ちの一覧（lib/plugin-confirm.js）のテスト
const test = require("node:test");
const assert = require("node:assert/strict");
const { createConfirms, tagOf } = require("../lib/plugin-confirm");

test("確認待ち: 頼んだ画面からだけ、期限の前に 1 回だけ取り出せる。使ったものは「もう使いました」", () => {
  let t = 1000;
  const c = createConfirms({ ttlMs: 60000, now: () => t });
  const a = c.add({ plugin: "p", action: "open", device: "ipad" }, "p.open");
  assert.deepEqual([a.ok, a.expiresAt, a.ttlMs, a.tag], [true, 61000, 60000, tagOf(a.id)]);
  assert.equal(c.take(a.id, "pc").status, 403);
  assert.equal(c.take(a.id, "").status, 403);
  assert.equal(c.take(a.id, "ipad").entry.action, "open");
  assert.equal(c.take(a.id, "ipad").status, 409);
  const late = c.add({ device: "pc" }, "p.open");
  t += 60000;
  assert.equal(c.take(late.id, "pc").status, 410);
  assert.equal(c.size(), 0);
});

test("確認待ち: 1 つの画面には 1 件まで。全体の上限でも、ほかの画面の確認は消さずに新しいほうを断る", () => {
  const c = createConfirms({ max: 2 });
  const a = c.add({ device: "pc" }, "x");
  assert.equal(c.add({ device: "pc" }, "y").status, 429);   // 同じ画面の 2 件目
  const b = c.add({ device: "ipad" }, "x");
  assert.equal(c.add({ device: "phone" }, "x").status, 429); // 全体の上限
  assert.equal(c.take(a.id, "pc").ok, true);
  assert.equal(c.take(b.id, "ipad").ok, true);
});

test("確認待ち: 「やめる」を押した動作は、その画面ではしばらく出し直せない", () => {
  let t = 0;
  const c = createConfirms({ cooldownMs: 30000, now: () => t });
  const a = c.add({ device: "pc" }, "lock.open");
  c.take(a.id, "pc", { cancelled: true });
  assert.equal(c.add({ device: "pc" }, "lock.open").status, 429);
  assert.equal(c.add({ device: "ipad" }, "lock.open").ok, true);   // ほかの画面は止めない
  assert.equal(c.add({ device: "pc" }, "other").ok, true);         // ほかの動作も止めない
  t += 30000;
  const c2 = createConfirms({ cooldownMs: 30000, now: () => t });
  assert.equal(c2.add({ device: "pc" }, "lock.open").ok, true);
});
