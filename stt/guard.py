"""音声認識サーバー（stt_server.py）の入口の確認

ブラウザで開いたほかのサイトから、音声認識サーバー（127.0.0.1）を勝手に使われないようにする。
呼ぶのは server.js だけなので、それ以外の形の要求は断る。
- Host が 127.0.0.1 / localhost（とこのポート）でなければ断る（DNS リバインディング対策）
- Origin が付いていれば断る（ブラウザからの要求には付く。server.js の fetch は付けない）
- POST は Content-Type: audio/wav だけ受け付ける（ほかのサイトのページは、確認（preflight）なしにはこの形で送れない）
- 本文の大きさに上限を付ける
"""

MAX_BODY = 16 * 1024 * 1024
RATE_MIN, RATE_MAX = 8000, 48000


def request_denied(method, host, content_type, length, origin, port):
    """断る理由（日本語）か None"""
    if (host or "").lower() not in (f"127.0.0.1:{port}", f"localhost:{port}"):
        return "Host が許可されていません"
    if origin is not None:
        return "ブラウザからは使えません"
    if method != "POST":
        return None
    if (content_type or "").split(";")[0].strip().lower() != "audio/wav":
        return "Content-Type は audio/wav だけです"
    try:
        n = int(length or 0)
    except ValueError:
        return "Content-Length が正しくありません"
    if n < 0 or n > MAX_BODY:
        return "本文が大きすぎます"
    return None


def check_rate(rate, channels):
    """WAV のサンプリング周波数とチャンネル数を確かめる（変な値で、作り直す配列が大きくなりすぎないように）"""
    if not RATE_MIN <= rate <= RATE_MAX:
        raise ValueError(f"サンプリング周波数は {RATE_MIN}〜{RATE_MAX} Hz にしてください（{rate} Hz）")
    if channels not in (1, 2):
        raise ValueError(f"モノラルかステレオの WAV を送ってください（{channels} チャンネル）")
