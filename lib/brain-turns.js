// 頭（常駐の Claude Code）に渡す発言の順番待ち
//  PC の画面と iPad など、複数の画面から話しかけられても、返事がどの発言へのものか分かるようにする。
//  ・頭に渡すのは一度にひとつだけ。返答中に届いた発言は、返答が終わってから届いた順に渡す
//  ・返答（delta / done）には返答中の発言の印（turn）を付けて全部の画面に送り、画面は自分の印のものだけを読み上げる
//  ・順番待ちは MAX_WAITING 件まで（大量に送られても、頭を呼び続けないように）
const MAX_WAITING = 5;

// onFail(turn, error): 頭に渡せなかった発言を知らせる（頭を起動できないなど）
function createTurnQueue({ write, onFail = () => {}, maxWaiting = MAX_WAITING }) {
  let current = null;   // 頭が返答中の発言 { text, turn }
  let waiting = [];     // 順番待ちの発言

  // 頭に渡す。渡せなかったら返答中にはせず、知らせてから順番待ちの次を試す
  function start(item) {
    current = item;
    try { write(item.text); } catch (e) {
      current = null;
      onFail(item.turn, e);
      const [head, ...rest] = waiting;
      waiting = rest;
      if (head) start(head);
    }
  }
  return {
    // 受け付けたら true。順番待ちがいっぱいなら false
    say(text, turn = "") {
      const item = { text, turn: String(turn) };
      if (!current) { start(item); return true; }
      if (waiting.length >= maxWaiting) return false;
      waiting = [...waiting, item];
      return true;
    },
    current: () => (current ? current.turn : null),
    busy: () => Boolean(current),
    // 返答が終わった。終わった発言の印を返し、順番待ちの次の発言を頭に渡す
    finish() {
      const done = current;
      current = null;
      const [head, ...rest] = waiting;
      waiting = rest;
      if (head) start(head);
      return done ? done.turn : null;
    },
    // まだ頭に渡していない発言を取り消す（取り消せたら true）
    cancel(turn) {
      if (!waiting.some((w) => w.turn === turn)) return false;
      waiting = waiting.filter((w) => w.turn !== turn);
      return true;
    },
    // 頭が止まった・止めた: 返答中・順番待ちの発言を全部捨てる。捨てた発言の印を返す（画面に知らせるため）
    reset() {
      const dropped = [current, ...waiting].filter(Boolean).map((w) => w.turn);
      current = null;
      waiting = [];
      return dropped;
    },
  };
}

module.exports = { createTurnQueue };
