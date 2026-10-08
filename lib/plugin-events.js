// 追加機能（lib/plugins.js）から画面への知らせ（Server-Sent Events。/api/plugins/events）
const CLIENTS_MAX = 20;         // 知らせを受け取る画面の数の上限（超えたら古いものから閉じる）
const CLIENTS_PER_DEVICE = 3;   // 1 つの端末から受け取れる数の上限
const HELD_MS = 10 * 60 * 1000; // 画面が 1 つもつながっていないときの知らせを、つながるまで預かる時間
const WAIT_TARGET_MS = 8000;    // 預かった知らせの届け先の端末がつながるのを、ほかの画面がつながってから待つ時間

// 画面への知らせ（Server-Sent Events）。つながっている画面と、その画面の印（端末）を覚える
//  知らせ（emitTo）は、届け先の端末にだけ送る。届け先がつながっていなければ全部の画面に fallback の印を付けて送る。
//  画面が 1 つもつながっていないとき（起動し直した直後・Wi-Fi のつなぎ直し中など）は預かっておき、つながったら送る
//  （届け先の端末があれば、つながるのを少し待ってから、ほかの画面に回す）
function createEventHub({ pingMs = 20000, max = CLIENTS_MAX, perDevice = CLIENTS_PER_DEVICE, heldMs = HELD_MS, waitTargetMs = WAIT_TARGET_MS } = {}) {
  const clients = new Map();   // res → device（入れた順に並ぶ）
  let held = [];               // 画面が無かったときの知らせ { device, o, at }
  let heldTimer = null;
  const write = (res, o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const drop = (res) => { clients.delete(res); try { res.end(); } catch { /* もう閉じている */ } };
  const targetsOf = (device) => (device ? [...clients].filter(([, d]) => d === device).map(([r]) => r) : []);
  const ping = setInterval(() => { for (const r of clients.keys()) r.write(": ping\n\n"); }, pingMs);
  ping.unref?.();

  // 届け先に送る → 送れたら true。force: 届け先がつながっていなければ、全部の画面に回す
  function deliver(device, o, force) {
    const targets = targetsOf(device);
    if (targets.length) { for (const r of targets) write(r, { ...o, fallback: false }); return true; }
    if (!clients.size || (device && !force)) return false;
    for (const r of clients.keys()) write(r, { ...o, fallback: true });
    return true;
  }
  // 預かっている知らせを送る（古すぎるものは捨てる）。届け先を待っているものは、少しあとでもう一度
  function flushHeld(force = false) {
    const now = Date.now();
    held = held.filter((h) => now - h.at < heldMs && !deliver(h.device, h.o, force || !h.device));
    clearTimeout(heldTimer);
    heldTimer = held.length && clients.size ? setTimeout(() => flushHeld(true), waitTargetMs) : null;
    heldTimer?.unref?.();
  }

  return {
    add(req, res, device, snapshot = []) {
      // 数の上限を超えたら、同じ端末の古いもの → 全体の古いもの の順に閉じる
      const same = targetsOf(device);
      if (device && same.length >= perDevice) drop(same[0]);
      if (clients.size >= max) drop(clients.keys().next().value);
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": ok\n\n");
      clients.set(res, device);
      for (const o of snapshot) write(res, o);
      req.on("close", () => clients.delete(res));
      if (held.length) flushHeld();
    },
    emit(o) { for (const r of clients.keys()) write(r, o); },
    emitTo(device, o) {
      if (deliver(device, o, true)) return;
      held = [...held, { device, o, at: Date.now() }];
    },
    connected(device) { return [...clients.values()].includes(device); },
    close() { clearInterval(ping); clearTimeout(heldTimer); for (const r of [...clients.keys()]) drop(r); },
  };
}

module.exports = { createEventHub };
