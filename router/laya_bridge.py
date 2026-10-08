"""
AI あまね 用 Laya ルーター（任意）

作業依頼の文章を受け取り、light（軽い作業）か heavy（重い作業）かを Laya で判定して返す。
server.js から POST http://127.0.0.1:3940/route {"text": "..."} で呼ばれる。

  セットアップ:  python -m pip install laya
  起動:          python router/laya_bridge.py   （または start-laya.bat）

※ laya 0.3.27 の戻り値の形に合わせている。--debug を付けて起動すると生の戻り値がコンソールに出る。
   初回起動時に Hugging Face からモデル（数百MB）をダウンロードする。GPU が無くても動く（CPU だと少し遅い）。
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 3940
DEBUG = "--debug" in sys.argv

QUESTIONS = {
    "level": {
        "type": "choice",
        "instructions": "音声アシスタントへの作業依頼です。どの程度の重さの作業か判定してください。",
        "criteria": {
            "light": "ファイルの一覧・検索・コピー・リネーム、メモの追記、簡単な確認や1コマンドで済む操作など、数分以内に終わる単純な作業",
            "heavy": "設計、実装、リファクタリング、デバッグ、調査や比較、複数ファイルにまたがる変更など、考える量が多い作業",
        },
    }
}

print("[laya] loading model ...", flush=True)
from laya import Router  # noqa: E402

router = Router()
print(f"[laya] ready on http://127.0.0.1:{PORT}/route", flush=True)


def pick(obj, *names):
    """dict でも属性オブジェクトでも値を取り出す"""
    for n in names:
        if isinstance(obj, dict) and n in obj:
            return obj[n]
        if hasattr(obj, n):
            return getattr(obj, n)
    return None


def decide(text):
    res = router.predict(text, QUESTIONS)
    if DEBUG:
        print("[laya] raw:", repr(res), flush=True)
    # 戻り値: {"answers": {"level": {"choice": "light", "answer_confidence": 0.9, "probabilities": {...}}}, ...}
    ans = pick(pick(res, "answers") or {}, "level") or pick(res, "level") or {}
    label = pick(ans, "choice", "label", "answer")
    conf = pick(ans, "answer_confidence", "confidence")
    if label is None:
        probs = pick(ans, "probabilities", "probs", "distribution")
        if isinstance(probs, dict) and probs:
            label, conf = max(probs.items(), key=lambda kv: kv[1])
    return str(label) if label is not None else None, (float(conf) if conf is not None else None)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/route":
            self.send_error(404)
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            text = json.loads(self.rfile.read(n) or b"{}").get("text", "")
            t0 = time.perf_counter()
            level, conf = decide(text)
            ms = (time.perf_counter() - t0) * 1000
            print(f"[laya] {level} ({conf}) {ms:.0f}ms <- {text[:40]}", flush=True)
            body = json.dumps({"level": level, "confidence": conf, "ms": round(ms)}).encode()
            self.send_response(200)
        except Exception as e:  # noqa: BLE001
            body = json.dumps({"error": str(e)}).encode()
            self.send_response(500)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
