"""
AI あまね ローカル音声認識サーバー（ReazonSpeech / faster-whisper）

  STT_ENGINE=reazonspeech（既定）: 日本語特化の k2 モデルを CPU で。短い発話ほど速い（数百ms）
  STT_ENGINE=whisper            : kotoba-whisper を GPU で。常に約30秒分を処理するので1発話あたり一定時間かかる

ブラウザが区切った発話（16kHz・モノラルの WAV）を受け取り、日本語の文字に起こして返す。
server.js から POST http://127.0.0.1:3941/transcribe で呼ばれる。

  セットアップ（NVIDIA GPU）:
    python -m pip install faster-whisper nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
  起動:
    python stt/stt_server.py      （または start-stt.bat）

  環境変数（任意。.env に書いてもよい）:
    STT_MODEL     既定: kotoba-tech/kotoba-whisper-v2.0-faster（日本語特化）
                  ほか: large-v3-turbo / medium / small など
    STT_DEVICE    auto | cuda | cpu
    STT_COMPUTE   既定: GPU は float16 / int8_float16 / int8 を起動時に測って一番速いもの、CPU は int8
    STT_CHUNK     既定: auto（発話の長さに合わせて処理窓を縮める）。精度が落ちるなら 15
    STT_VAD       既定: 0（ブラウザ側で区切るので不要）。雑音の誤認識が多いなら 1
    STT_BEAM      既定: 1（速さ優先。精度を上げたいなら 5）
"""
import gc
import io
import math
import re
import json
import os
import sys
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


# ---- .env（server.js と共通）を読む。使うのは音声認識の設定（STT_ / HF_）だけ（API キーなどの秘密は読まない） ----
def load_env():
    path = os.path.join(ROOT, ".env")
    if not os.path.exists(path):
        return
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if v and k.startswith(("STT_", "HF_")) and k not in os.environ:
            os.environ[k] = v


load_env()

# .env の「STT_THREADS=」のような空の値は「未設定」として扱う（既定値を使う）
for _k in [k for k, v in os.environ.items() if k.startswith(("STT_", "HF_")) and v.strip() == ""]:
    del os.environ[_k]

# 待ち受けるポート（server.js と同じく .env の STT_URL から決める。既定は 3941）
PORT = urlparse(os.environ.get("STT_URL") or "http://127.0.0.1:3941").port or 3941


# ---- Windows: pip で入れた CUDA ライブラリ（cuBLAS / cuDNN）の DLL を先に読み込んでおく ----
# CTranslate2 は「cublas64_12.dll」などを名前だけで探すので、フルパスで先読みしておけば確実に見つかる。
CUDA_DLL_NOTE = []


def add_cuda_dll_dirs():
    if os.name != "nt":
        return
    import ctypes
    import glob
    import site

    roots = list(site.getsitepackages()) + [site.getusersitepackages()]
    bins = []
    for r in roots:
        bins += glob.glob(os.path.join(r, "nvidia", "*", "bin"))
    for b in bins:
        try:
            os.add_dll_directory(b)
        except Exception:
            pass
        os.environ["PATH"] = b + os.pathsep + os.environ.get("PATH", "")
    # 依存関係の順に先読み（cudart → cublasLt → cublas → cudnn）
    patterns = ["cudart64_*.dll", "cublasLt64_*.dll", "cublas64_*.dll", "cudnn64_*.dll", "cudnn_*64_*.dll"]
    for pat in patterns:
        for b in bins:
            for dll in sorted(glob.glob(os.path.join(b, pat))):
                try:
                    ctypes.WinDLL(dll)
                    CUDA_DLL_NOTE.append(os.path.basename(dll))
                except OSError:
                    pass
    if not bins:
        CUDA_DLL_NOTE.append("(nvidia-cublas-cu12 / nvidia-cudnn-cu12 が見つかりません)")


ENGINE = os.environ.get("STT_ENGINE", "reazonspeech").lower()  # reazonspeech | whisper

import numpy as np  # noqa: E402
from guard import check_rate, request_denied  # noqa: E402
from segments import plan_segments  # noqa: E402
from question import punctuate  # noqa: E402
from speaker import (  # noqa: E402
    MODEL_NAME, Sessions, Voiceprints, fetch_model, kept_regions, load_embedder, loud_region, owner_parts, spans_within, split_windows,
)

if ENGINE == "whisper":
    add_cuda_dll_dirs()
    from faster_whisper import WhisperModel  # noqa: E402

MODEL = os.environ.get("STT_MODEL", "kotoba-tech/kotoba-whisper-v2.0-faster")
DEVICE = os.environ.get("STT_DEVICE", "auto")
BEAM = int(os.environ.get("STT_BEAM", "1"))

# Whisper が無音や雑音から作りがちな定番の幻聴
HALLUCINATIONS = (
    "ご視聴ありがとうございました", "ご視聴ありがとうございます", "チャンネル登録", "最後までご視聴",
    "字幕は", "字幕作成", "提供は",
)


def pick_device():
    if DEVICE in ("cuda", "cpu"):
        return DEVICE
    try:
        import ctranslate2
        return "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
    except Exception:
        return "cpu"


CHUNK = os.environ.get("STT_CHUNK", "auto")      # auto | 15 | 30
USE_VAD = os.environ.get("STT_VAD", "0") == "1"  # ブラウザ側で区切っているので既定はオフ


def chunk_for(sec):
    """Whisper は入力を chunk 秒まで無音で埋めてから処理するので、短い発話は窓を縮めると速くなる"""
    if CHUNK != "auto":
        return int(CHUNK)
    return int(min(15, max(5, math.ceil(sec) + 1)))


def run(m, audio, hotwords="", vad=False):
    segments, _ = m.transcribe(
        audio,
        language="ja",
        beam_size=BEAM,
        temperature=0.0,
        chunk_length=chunk_for(len(audio) / 16000),
        condition_on_previous_text=False,
        without_timestamps=True,
        vad_filter=vad,
        vad_parameters={"min_silence_duration_ms": 300} if vad else None,
        no_speech_threshold=0.6,
        hotwords=hotwords or None,
    )
    return [s for s in segments if s.no_speech_prob < 0.7]


def bench(m, sec=2.0, n=3):
    """GPU が本当に動くかの確認を兼ねて、短い発話相当の処理時間を測る"""
    noise = np.random.RandomState(0).randn(int(16000 * sec)).astype(np.float32) * 0.01
    times = []
    for _ in range(n):
        t0 = time.perf_counter()
        run(m, noise)
        times.append((time.perf_counter() - t0) * 1000)
    return min(times[1:] or times)


def load_model():
    dev = pick_device()
    print(f"[stt] loading {MODEL} on {dev} ... 初回はダウンロードに数分かかります", flush=True)
    if dev == "cuda" and os.name == "nt":
        print("[stt] CUDA DLL: " + (", ".join(CUDA_DLL_NOTE) or "なし"), flush=True)
    if dev == "cuda":
        # 精度の型は GPU によって速さが大きく違うので、実際に測って一番速いものを使う
        candidates = [os.environ["STT_COMPUTE"]] if os.environ.get("STT_COMPUTE") else ["float16", "int8_float16", "int8"]
        best = None
        for ct in candidates:
            try:
                m = WhisperModel(MODEL, device="cuda", compute_type=ct)
                ms = bench(m)
                print(f"[stt]   {ct:<13} {ms:6.0f} ms（2秒の発話）", flush=True)
                if best is None or ms < best[1]:
                    if best:
                        del best[0]
                    best = [m, ms, ct]
                else:
                    del m
                gc.collect()
            except Exception as e:
                print(f"[stt]   {ct:<13} 使えません: {str(e)[:120]}", flush=True)
        if best:
            return best[0], "cuda", best[2]
        print("[stt] GPU で動かせませんでした。次のコマンドで CUDA ライブラリを入れると GPU が使えます:", flush=True)
        print('       python -m pip install nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"', flush=True)
        print("[stt] いったん CPU で動かします（遅くなります）。", flush=True)
    ct = os.environ.get("STT_COMPUTE") if dev == "cpu" and os.environ.get("STT_COMPUTE") else "int8"
    m = WhisperModel(MODEL, device="cpu", compute_type=ct)
    print(f"[stt]   cpu {ct} {bench(m, n=2):.0f} ms（2秒の発話）", flush=True)
    return m, "cpu", ct


# ================= ReazonSpeech（sherpa-onnx・CPU で高速） =================
# Whisper は発話が短くても常に30秒分の処理をするので、短い呼びかけでも一定時間かかる。
# ReazonSpeech（k2 / Zipformer）は発話の長さに比例して処理が終わるので、短い発話ほど速い。
RZ_REPO = "reazon-research/reazonspeech-k2-v2"
RZ_TAR = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01.tar.bz2"
RZ_FILES = ["encoder-epoch-99-avg-1.int8.onnx", "decoder-epoch-99-avg-1.int8.onnx", "joiner-epoch-99-avg-1.int8.onnx", "tokens.txt"]
RZ_DIR = os.environ.get("STT_REAZON_DIR", os.path.join(ROOT, "models", "reazonspeech-k2-v2"))
FILLERS = {"え", "ん", "あ", "う", "お", "えー", "あー", "ー", "あっ", "えっ", "おっ", "うっ", "んっ", "ああ"}
RZ_LEAD_PAD = np.zeros(8000, np.float32)  # 認識の前に先頭に足す無音（0.5 秒）


def fetch_reazon():
    tmp = os.path.join(RZ_DIR, "_model.tar.bz2")
    if all(os.path.exists(os.path.join(RZ_DIR, f)) for f in RZ_FILES):
        if os.path.exists(tmp):
            os.remove(tmp)  # 展開済みなら一時ファイルは不要
        return RZ_DIR
    os.makedirs(RZ_DIR, exist_ok=True)
    print("[stt] ReazonSpeech のモデル（約160MB）をダウンロードします…", flush=True)
    try:
        from huggingface_hub import hf_hub_download
        for f in RZ_FILES:
            src = hf_hub_download(RZ_REPO, f)
            import shutil
            shutil.copyfile(src, os.path.join(RZ_DIR, f))
        return RZ_DIR
    except Exception as e:
        print(f"[stt] Hugging Face から取得できませんでした（{e}）。GitHub から取得します（約700MB）…", flush=True)
    import tarfile
    import urllib.request
    def progress(n, bs, total):
        if total > 0 and n % 200 == 0:
            print(f"\r[stt]   {min(100, n * bs * 100 // total)}% ({n * bs // 1048576} / {total // 1048576} MB)", end="", flush=True)
    urllib.request.urlretrieve(RZ_TAR, tmp, progress)
    print("", flush=True)
    with tarfile.open(tmp, "r:bz2") as t:
        for mem in t.getmembers():
            name = os.path.basename(mem.name)
            if name in RZ_FILES:
                with t.extractfile(mem) as fsrc, open(os.path.join(RZ_DIR, name), "wb") as fdst:
                    fdst.write(fsrc.read())
    os.remove(tmp)
    return RZ_DIR


def load_reazon():
    import sherpa_onnx
    d = fetch_reazon()
    threads = int(os.environ.get("STT_THREADS", min(8, os.cpu_count() or 4)))
    rec = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=os.path.join(d, RZ_FILES[0]), decoder=os.path.join(d, RZ_FILES[1]), joiner=os.path.join(d, RZ_FILES[2]),
        tokens=os.path.join(d, RZ_FILES[3]), num_threads=threads, sample_rate=16000, feature_dim=80,
        decoding_method="modified_beam_search", max_active_paths=4, hotwords_score=1.5, modeling_unit="cjkchar",
    )
    vocab = set()
    for line in open(os.path.join(d, RZ_FILES[3]), encoding="utf-8"):
        tok = line.rsplit(None, 1)[0] if line.strip() else ""
        if tok:
            vocab.add(tok)
    return rec, vocab, threads


def run_reazon(audio, hotwords=""):
    # 語彙に無い文字（英字など）を含むヒントは使えないので除外する
    # （英数字は単語ごと1トークン扱いになり、辞書に無いのでヒントに使えない）
    hws = [w for w in re.split(r"[、,，/\s]+", hotwords or "")
           if w and not re.search(r"[A-Za-z0-9]", w) and all(c in rz_vocab for c in w)]
    s = rz.create_stream(hotwords="/".join(hws)) if hws else rz.create_stream()
    # 声の直前の無音が短いと、最初の言葉（呼びかけなど）が落ちるので、先頭に無音を足す
    s.accept_waveform(16000, np.concatenate([RZ_LEAD_PAD, audio]))
    rz.decode_stream(s)
    text = s.result.text.strip()
    return "" if text in FILLERS else text


# ================= 声かどうかの判定（Silero VAD） =================
# マウスのクリック音や物音を「あっ」「こんにちは」と誤認識しないよう、
# 人の声が一定時間含まれているかを先に調べ、含まれていなければ文字起こししない。
VAD_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"
VAD_PATH = os.path.join(ROOT, "models", "silero_vad.onnx")
MIN_SPEECH = float(os.environ.get("STT_MIN_SPEECH", "0.3"))  # 秒
GATE = os.environ.get("STT_GATE", "1") == "1"
vad_cfg = None


def load_vad():
    global vad_cfg
    try:
        import sherpa_onnx
        if not os.path.exists(VAD_PATH):
            import urllib.request
            os.makedirs(os.path.dirname(VAD_PATH), exist_ok=True)
            print("[stt] 声の判定モデル（Silero VAD）をダウンロードします…", flush=True)
            urllib.request.urlretrieve(VAD_URL, VAD_PATH)
        c = sherpa_onnx.VadModelConfig()
        c.silero_vad.model = VAD_PATH
        c.silero_vad.threshold = float(os.environ.get("STT_VAD_THRESHOLD", "0.5"))
        c.silero_vad.min_silence_duration = 0.2
        c.silero_vad.min_speech_duration = 0.15
        c.silero_vad.window_size = 512
        c.sample_rate = 16000
        c.num_threads = 1
        vad_cfg = c
        print(f"[stt] 声の判定: Silero VAD（声が{MIN_SPEECH}秒未満なら無視）", flush=True)
    except Exception as e:
        print(f"[stt] Silero VAD を使えません（{e}）。声の判定なしで動きます。", flush=True)


def speech_spans(audio):
    """声の区間 [(開始, 終了), ...]（サンプル数）"""
    import sherpa_onnx
    v = sherpa_onnx.VoiceActivityDetector(vad_cfg, buffer_size_in_seconds=60)
    for i in range(0, len(audio) - 511, 512):
        v.accept_waveform(audio[i:i + 512])
    v.flush()
    spans = []
    while not v.empty():
        spans.append((v.front.start, v.front.start + len(v.front.samples)))
        v.pop()
    return spans


# ================= 声紋（登録した人・呼びかけた人の声だけを文字にする。stt/speaker.py） =================
# ・会話ごとの「主」: 呼びかけた人の声を覚え、その会話では主の声だけを文字にする（sessions）
# ・登録した声: 画面から登録した人の声（voiceprints）。呼んだのが登録した人なら、その声を主にする
# モデル（約 28MB）は、最初に使うとき（声を登録済みなら起動したとき）に読み込む
SPEAKER_THRESHOLD = float(os.environ.get("STT_SPEAKER_THRESHOLD", "0.45"))
voiceprints = Voiceprints(os.path.join(ROOT, "data", "voiceprints.json"), threshold=SPEAKER_THRESHOLD)
sessions = Sessions(None, threshold=SPEAKER_THRESHOLD)
embed_lock = Lock()
EMBED_RETRY_SEC = 60
embed_failed_at = 0.0   # 読み込みに失敗した時刻（しばらくは試し直さず、声紋なしで聞き取る）


def ensure_embedder():
    """声紋のモデルを読み込む。使えなければ RuntimeError（呼び出し側は声紋なしで続ける）"""
    global embed_failed_at
    with embed_lock:
        if voiceprints.embed is not None:
            return
        if time.time() - embed_failed_at < EMBED_RETRY_SEC:
            raise RuntimeError("声紋のモデルを読み込めませんでした（しばらくしてから試し直します）")
        try:
            path = fetch_model(os.path.join(ROOT, "models"), log=lambda m: print(m, flush=True))
            voiceprints.embed = sessions.embed = load_embedder(path)
        except Exception as e:  # noqa: BLE001
            embed_failed_at = time.time()
            print(f"[stt] 声紋のモデルを読み込めません（{e}）。声紋なしで聞き取ります。", flush=True)
            raise RuntimeError(f"声紋のモデルを読み込めません（{e}）") from e
        print(f"[stt] 声紋: 読み込みました（しきい値 {SPEAKER_THRESHOLD}・登録 {', '.join(voiceprints.names()) or 'なし'}）", flush=True)


def speech_parts(audio, spans):
    """照合・文字起こしする声の区間。声の判定が使えないときは全体"""
    return plan_segments(spans, len(audio), min_len=0.2) if spans is not None else [(0, len(audio))]


# ================= 起動 =================
if ENGINE == "whisper":
    model, device, compute = load_model()
    MODEL_LABEL = MODEL
else:
    print("[stt] loading ReazonSpeech k2 v2（sherpa-onnx / CPU）", flush=True)
    rz, rz_vocab, rz_threads = load_reazon()
    device, compute, MODEL_LABEL = "cpu", f"int8 x{rz_threads}threads", "reazonspeech-k2-v2"
    for sec in (1.5, 4.0):
        noise = np.random.RandomState(0).randn(int(16000 * sec)).astype(np.float32) * 0.01
        run_reazon(noise)
        t0 = time.perf_counter(); run_reazon(noise)
        print(f"[stt]   {sec}秒の発話 → {(time.perf_counter() - t0) * 1000:.0f} ms", flush=True)
if GATE:
    load_vad()
# 声紋のモデルがダウンロード済み（または声を登録済み）なら、最初の会話を待たせないよう先に読み込んでおく
if voiceprints.names() or os.path.exists(os.path.join(ROOT, "models", MODEL_NAME)):
    import threading

    def preload():
        try:
            ensure_embedder()
        except RuntimeError:
            pass   # 読み込めなければ、声紋なしで聞き取る（理由は ensure_embedder が表示済み）
    threading.Thread(target=preload, daemon=True).start()
lock = Lock()  # 1 つのモデルを複数スレッドから同時に使わない


def wav_to_float32(data: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(data), "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError("16bit PCM の WAV を送ってください")
        sr = w.getframerate()
        ch = w.getnchannels()
        check_rate(sr, ch)
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        pcm = pcm.reshape(-1, ch).mean(axis=1)
    if sr != 16000:  # 念のため簡易リサンプル
        n = int(len(pcm) * 16000 / sr)
        pcm = np.interp(np.linspace(0, len(pcm) - 1, n), np.arange(len(pcm)), pcm).astype(np.float32)
    return pcm


def recognize(audio, hotwords=""):
    with lock:
        if ENGINE == "whisper":
            text = "".join(s.text for s in run(model, audio, hotwords, vad=USE_VAD))
        else:
            text = run_reazon(audio, hotwords)
    text = text.replace("\ufffd", "").strip()
    return "" if any(h in text for h in HALLUCINATIONS) and len(text) < 20 else text


def speaker_checks(audio, spans, session, adopt=False):
    """声を短い窓に刻んで、窓ごとに残すか（会話の主・登録した声か）を調べる。
    調べようがない（会話が無い・声紋のモデルを使えない）ときは None（声紋なしで、全部を文字にする）"""
    parts = split_windows(speech_parts(audio, spans))
    try:
        if session:
            ensure_embedder()
            checks = sessions.check(session, audio, parts, adopt=adopt)
            if checks is not None:
                return checks
        if voiceprints.names():
            ensure_embedder()
            return voiceprints.check(audio, parts)
    except RuntimeError:
        pass   # 声紋のモデルを使えない（ensure_embedder が表示済み）
    return None


def transcribe(audio: np.ndarray, hotwords: str = "", split: bool = False, speaker: bool = False, session: str = "", adopt: bool = False,
               mode: str = "", cut: bool = False):
    """split: \u58f0\u306e\u5207\u308c\u76ee\u3067\u533a\u5207\u308a\u76f4\u3057\u3066\u3001\u533a\u5207\u308a\u3054\u3068\u306b\u6587\u5b57\u306b\u3059\u308b\uff08segments\uff09\u3002
    \u9a12\u304c\u3057\u304f\u3066\u9577\u3044\u304b\u305f\u307e\u308a\u3067\u5c4a\u3044\u305f\u767a\u8a71\u304b\u3089\u3001\u9014\u4e2d\u306e\u547c\u3073\u304b\u3051\u3092\u63a2\u3059\u306e\u306b\u4f7f\u3046"""
    t0 = time.perf_counter()
    sec = len(audio) / 16000
    spans = speech_spans(audio) if vad_cfg is not None else None
    if spans is not None:
        sp = sum(e - s for s, e in spans) / 16000
        if sp < MIN_SPEECH:
            return {"text": "", "ms": round((time.perf_counter() - t0) * 1000), "duration": round(sec, 2), "speech": round(sp, 2), "skipped": True}
    res = {"duration": round(sec, 2), "chunk": chunk_for(sec) if ENGINE == "whisper" else None}
    last = audio   # 疑問文の上がり調子を調べる声（話し終わりの部分）
    checks = speaker_checks(audio, spans, session, adopt) if speaker else None
    if checks is not None:
        # 会話の主（登録した声）の区間だけをつなげて文字にする（テレビや家族の声、あまねの声の回り込みは聞き流す）
        kept = kept_regions(checks)
        res["speaker"] = [{**c, "start": round(c["start"] / 16000, 2), "end": round(c["end"] / 16000, 2)} for c in checks]
        gap = np.zeros(3200, np.float32)  # 区間のあいだに 0.2 秒の無音をはさむ
        res["text"] = recognize(np.concatenate([x for a, b in kept for x in (audio[a:b], gap)]), hotwords) if kept else ""
        # 主の声が最後まで続いている → 画面は、6 秒の上限で区切ったときだけ、話の途中とみなして続きを待つ
        res["userAtEnd"] = bool(kept) and kept[-1][1] >= len(audio) - 5600
        if kept:
            last = audio[kept[-1][0]:kept[-1][1]]   # 主の最後の区間
    elif split:
        # Whisper は短い区切りでも一定時間かかるので区切り直さない（ブラウザ側も ReazonSpeech のときだけ頼む）
        # 素早く言った短い呼びかけも残すよう、区切りの声の長さは 0.2 秒あればよい
        parts = plan_segments(spans or [], len(audio), min_len=0.2) if ENGINE != "whisper" else []
        res["segments"] = [{"text": recognize(audio[s:e], hotwords), "start": round(s / 16000, 2), "end": round(e / 16000, 2)} for s, e in parts]
        res["text"] = " ".join(x["text"] for x in res["segments"] if x["text"])
    else:
        res["text"] = recognize(audio, hotwords)
    # 会話中の発言が疑問文なら「？」を付ける（ReazonSpeech は記号を出さないので。stt/question.py）。
    # 上限で区切った発言（話の途中）には付けない。うまく調べられなくても、文字はそのまま返す
    if mode == "talk" and not cut and res.get("text"):
        try:
            res["text"], res["question"] = punctuate(res["text"], last)
        except Exception as e:  # noqa: BLE001
            print(f"[stt] 疑問文の判定に失敗しました（{e}）", file=sys.stderr, flush=True)
    res["ms"] = round((time.perf_counter() - t0) * 1000)
    return res


print(f"[stt] ready on http://127.0.0.1:{PORT}  engine={ENGINE} model={MODEL_LABEL} device={device} compute={compute}", flush=True)


class Handler(BaseHTTPRequestHandler):
    # ほかのサイトのページから使われないよう、server.js からの形の要求だけを受け付ける（stt/guard.py）
    def _denied(self):
        h = self.headers
        why = request_denied(self.command, h.get("Host"), h.get("Content-Type"), h.get("Content-Length"), h.get("Origin"), PORT)
        if why:
            self._json(403, {"error": why})
        return bool(why)

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self._denied():
            return
        path = urlparse(self.path).path
        if path == "/health":
            return self._json(200, {"ok": True, "engine": ENGINE, "model": MODEL_LABEL, "device": device, "compute": compute})
        if path == "/voiceprints":
            return self._json(200, {"names": voiceprints.names(), "threshold": voiceprints.threshold})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self._denied():
            return
        u = urlparse(self.path)
        q = parse_qs(u.query)
        arg = lambda k: q.get(k, [""])[0]  # noqa: E731
        try:
            if u.path == "/voiceprints/delete":
                return self._json(200, {"ok": voiceprints.remove(arg("name"))})
            if u.path == "/session/end":
                sessions.end(arg("session"))
                return self._json(200, {"ok": True})
            if u.path not in ("/transcribe", "/enroll", "/session/start", "/speaker-check"):
                return self._json(404, {"error": "not found"})
            n = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(n)
            # 会話の開始は、呼びかけの音声が無くてもよい（最初に話した人を主にする）
            audio = wav_to_float32(body) if body or u.path != "/session/start" else np.zeros(0, np.float32)
            if u.path == "/enroll":
                return self.enroll(arg("name"), audio)
            if u.path == "/session/start":
                return self.start_session(arg("session"), audio, arg("start"), arg("end"))
            if u.path == "/speaker-check":
                # 主かどうか分からない（会話が無い・モデルを使えない）ときは、主とみなす（今までどおり音量を下げる）
                try:
                    ensure_embedder()
                    return self._json(200, sessions.score(arg("session"), audio) or {"owner": True, "score": None})
                except RuntimeError:
                    return self._json(200, {"owner": True, "score": None})
            res = transcribe(audio, hotwords=arg("hotwords"), split=arg("split") == "1", speaker=arg("speaker") == "1",
                             session=arg("session"), adopt=arg("adopt") == "1", mode=arg("mode"), cut=arg("cut") == "1")
            if res.get("skipped"):
                print(f"[stt] {res['duration']}s -> 声ではないので無視（声 {res['speech']}s）", flush=True)
            elif "speaker" in res:
                marks = " | ".join(f"{'－' if c['score'] is None else format(c['score'], '.2f')}{'✓' if c['keep'] else '✗'}" for c in res["speaker"])
                none = "（文字なし）" if any(c["keep"] for c in res["speaker"]) else "（主の声なし・聞き流しました）"
                print(f"[stt] {res['duration']}s -> {res['ms']}ms : 声紋 {marks} : {res['text'] or none}", flush=True)
            elif "segments" in res:
                print(f"[stt] {res['duration']}s -> {res['ms']}ms : 区切り直し " + " | ".join(x["text"] for x in res["segments"]), flush=True)
            else:
                why = f"（「？」は{res['question']}から）" if res.get("question") else ""
                print(f"[stt] {res['duration']}s -> {res['ms']}ms : {res['text']}{why}", flush=True)
            self._json(200, res)
        except Exception as e:  # noqa: BLE001
            print("[stt] error:", e, file=sys.stderr, flush=True)
            self._json(500, {"error": str(e)})

    def start_session(self, sid, audio, start, end):
        """会話を始める。呼びかけの声（start〜end 秒。省略時は全体）の先頭の窓を、その会話の主として覚える"""
        if not sid or len(sid) > 64:
            return self._json(400, {"error": "session が正しくありません"})
        try:
            a = round(float(start or 0) * 16000)
            b = round(float(end) * 16000) if end else len(audio)
        except (ValueError, OverflowError):
            return self._json(400, {"error": "start / end が正しくありません"})
        try:
            ensure_embedder()
        except RuntimeError as e:
            return self._json(503, {"error": str(e)})
        a = max(0, min(a, len(audio)))
        b = max(a, min(b, len(audio)))
        # 声の判定は音声全体で行い（短く切り出すと、前後の文脈がなく声を見落とすことがある）、呼びかけの範囲に切り詰める。
        # それでも見つからなければ、範囲の中の音の大きいところを使う（そこで「あまね」と認識できているので、声はあるはず）
        inside = spans_within(speech_spans(audio), a, b) if vad_cfg is not None and len(audio) else []
        parts = plan_segments(inside, len(audio), pad=0.05, min_len=0.15)
        how = "声"
        if not parts:
            parts, how = loud_region(audio, a, b), "音の大きいところ"
        res = sessions.start(sid, audio, owner_parts(parts), prints=voiceprints.prints)
        if res["name"]:
            who = f"登録した「{res['name']}」"
        elif res["owner"]:
            who = f"呼びかけた{how} {res['seconds']}秒"
        else:
            who = (f"まだ分からない（呼びかけの声が見つかりませんでした。音声 {len(audio) / 16000:.1f}秒・呼びかけ {a / 16000:.2f}〜{b / 16000:.2f}秒）"
                   "。最初に話した人を主にします")
        print(f"[stt] 声紋: 会話の主 = {who}", flush=True)
        return self._json(200, res)

    def enroll(self, name, audio):
        """声を登録する（画面で読み上げてもらった数回分の音声をつなげたもの）"""
        try:
            ensure_embedder()
            spans = speech_spans(audio) if vad_cfg is not None else [(0, len(audio))]
            res = voiceprints.enroll(name, audio, spans)
        except (ValueError, RuntimeError) as e:
            return self._json(400, {"error": str(e)})
        # 登録した声そのものとの似ている度合い（区間ごとのいちばん低い値。同じ人なら高いはずで、低ければ雑音が多い）
        checks = voiceprints.check(audio, speech_parts(audio, spans if vad_cfg is not None else None))
        res["selfScore"] = min((c["score"] for c in checks if c["name"] == res["name"]), default=None)
        print(f"[stt] 声紋: 「{res['name']}」を登録しました（声 {res['seconds']}秒・自分との一致 {res['selfScore']}）", flush=True)
        return self._json(200, {"ok": True, **res})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
