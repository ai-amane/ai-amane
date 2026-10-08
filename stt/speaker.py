"""声紋（話者照合）: 登録した人の声かどうかを調べる

会話中、テレビや家族の声（と、あまね自身の声の回り込み）に返事をしないよう、
登録した声と似ている区間だけを文字にするのに使う。

  ・登録: 何回か話した音声から声の特徴（埋め込み）を求めて平均し、data/voiceprints.json に保存する
  ・照合: 区間ごとに特徴を求め、登録した声とのコサイン類似度がしきい値以上なら、その人の声とみなす
    （試したモデルでは、1 秒以上の声なら同じ人 0.55 以上・別の人 0.31 以下だったので、既定のしきい値は 0.45）
  ・短すぎる区間は特徴がぶれるので、前後を含めて 1 秒にしてから調べる
"""
import json
import os
import re
import time
from threading import Lock

import numpy as np

SR = 16000
MODEL_NAME = "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
MODEL_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/" + MODEL_NAME
MIN_CHECK_SEC = 1.0    # 照合する区間の最低の長さ（短い区間は前後に広げる）
MIN_ENROLL_SEC = 3.0   # 登録に必要な声の合計の長さ
NAME_MAX = 20


def clean_name(name):
    """登録する名前。制御文字を除いて NAME_MAX 文字まで。空ならエラー"""
    n = re.sub(r"[\x00-\x1f\x7f<>]", "", str(name or "")).strip()[:NAME_MAX]
    if not n:
        raise ValueError("名前を入れてください")
    return n


def widen(start, end, total, min_len):
    """区間 [start, end) が min_len より短ければ、前後に広げて min_len にする（音声の端は超えない）"""
    if end - start >= min_len:
        return start, end
    if total <= min_len:
        return 0, total
    mid = (start + end) // 2
    a = max(0, min(mid - min_len // 2, total - min_len))
    return a, a + min_len


def split_windows(parts, win=round(1.5 * SR)):
    """声の区間を、win 前後の長さの窓に均等に刻む（テレビと人の声は切れ目なく続くことがあり、
    区間のままだと二人の声がひとつにまとまってしまうため）。窓の長さ前後の区間はそのまま"""
    out = []
    for a, b in parts:
        n = max(1, round((b - a) / win))
        out += [(a + (b - a) * i // n, a + (b - a) * (i + 1) // n) for i in range(n)]
    return out


def kept_regions(checks):
    """残す窓のうち、続いているものをつなげた区間 [(開始, 終了), ...]"""
    out = []
    for c in checks:
        if not c["keep"]:
            continue
        if out and out[-1][1] == c["start"]:
            out[-1] = (out[-1][0], c["end"])
        else:
            out.append((c["start"], c["end"]))
    return out


def unit(v):
    v = np.asarray(v, np.float32)
    n = float(np.linalg.norm(v))
    return v / n if n > 0 else v


def fetch_model(models_dir, log=print):
    """モデル（約 28MB）が無ければダウンロードして、その場所を返す"""
    path = os.path.join(models_dir, MODEL_NAME)
    if not os.path.exists(path):
        import shutil
        import urllib.request
        os.makedirs(models_dir, exist_ok=True)
        log("[stt] 声紋のモデル（約28MB）をダウンロードします…")
        # 通信が止まったまま待ち続けないよう、時間を区切る
        with urllib.request.urlopen(MODEL_URL, timeout=30) as r, open(path + ".part", "wb") as f:
            shutil.copyfileobj(r, f)
        os.replace(path + ".part", path)
    return path


def load_embedder(model_path, num_threads=1):
    """sherpa-onnx の話者の特徴を求めるモデル。音声（16kHz・float32）→ 単位ベクトル"""
    import sherpa_onnx
    ex = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=model_path, num_threads=num_threads))
    lock = Lock()  # 1 つのモデルを複数スレッドから同時に使わない

    def embed(audio):
        with lock:
            st = ex.create_stream()
            st.accept_waveform(SR, audio)
            st.input_finished()
            return unit(ex.compute(st))
    return embed


MIN_EMBED_SAMPLES = round(0.1 * SR)   # これより短い音声からは特徴をとらない（モデルが空や NaN を返す）


def valid(f):
    return f is not None and f.size > 0 and bool(np.isfinite(f).all()) and float(np.linalg.norm(f)) > 0


def features(embed, audio, parts):
    """区間ごとの声の特徴（とれなければ None）と、その区間の長さ（サンプル数）。短い区間は前後に広げてから調べる"""
    total = len(audio)
    out = []
    for a, b in parts:
        x, y = widen(a, b, total, round(MIN_CHECK_SEC * SR))
        f = embed(audio[x:y]) if y - x >= MIN_EMBED_SAMPLES else None
        out.append((f if valid(f) else None, b - a))
    return out


def spans_within(spans, a, b, min_len=round(0.1 * SR)):
    """声の区間を [a, b) に切り詰める（短くなりすぎたものは捨てる）。
    声の判定は音声全体で行ってから切り詰める（短く切り出した音声では、前後の文脈がなく声を見落とすことがあるため）"""
    out = []
    for s, e in spans:
        x, y = max(s, a), min(e, b)
        if y - x >= min_len:
            out.append((x, y))
    return out


def loud_region(audio, a, b, frame=320):
    """[a, b) のうち、音の大きいところ [(開始, 終了)]。呼びかけの範囲で声の区間が見つからないときに使う
    （そこで「あまね」と認識できているので、声はあるはず）"""
    seg = np.asarray(audio[a:b], np.float32)
    n = len(seg) // frame
    if n == 0:
        return []
    rms = np.sqrt(np.mean(seg[:n * frame].reshape(n, frame) ** 2, axis=1))
    loud = np.nonzero(rms >= max(0.01, 0.2 * float(rms.max())))[0]
    if not len(loud):
        return []
    return [(a + int(loud[0]) * frame, a + (int(loud[-1]) + 1) * frame)]


def owner_parts(parts):
    """呼びかけの声から主の声をとる区間。呼びかけは発話の先頭にあるので、先頭の窓だけを使う
    （待受の音声は最長 6 秒あり、呼びかけと用件のあとにテレビの声が続いていることがある）"""
    return split_windows(parts)[:1]


class Voiceprints:
    """登録した声（path の JSON）と、照合。embed: 音声 → 声の特徴（単位ベクトル）"""

    def __init__(self, path, embed=None, threshold=0.45):
        self.path = path
        self.embed = embed
        self.threshold = threshold
        self.lock = Lock()
        self.prints = self._load()

    def _load(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
            return {n: unit(v["embedding"]) for n, v in data.items() if isinstance(v, dict) and v.get("embedding")}
        except (OSError, ValueError, TypeError, AttributeError):
            return {}

    def _save(self, meta):
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False)
        os.replace(tmp, self.path)

    def _meta(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def names(self):
        return sorted(self.prints)

    def _features(self, audio, parts):
        return features(self.embed, audio, parts)

    def enroll(self, name, audio, spans):
        """spans: 声の区間（Silero VAD）。区間ごとの特徴を、声の長さで重み付けして平均したものを保存する"""
        name = clean_name(name)
        seconds = sum(b - a for a, b in spans) / SR
        if seconds < MIN_ENROLL_SEC:
            raise ValueError(f"声が短すぎます（{seconds:.1f} 秒）。{MIN_ENROLL_SEC:.0f} 秒以上話してください")
        feats = [(f, n) for f, n in self._features(audio, spans) if f is not None]
        if not feats:
            raise ValueError("声の特徴をとれませんでした。もう一度話してください")
        weights = np.array([w for _, w in feats], np.float32)
        profile = unit(np.average(np.stack([f for f, _ in feats]), axis=0, weights=weights))
        with self.lock:
            meta = self._meta()
            meta[name] = {"embedding": [round(float(x), 6) for x in profile], "seconds": round(seconds, 1), "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S")}
            self._save(meta)
            self.prints = {**self.prints, name: profile}
        return {"name": name, "seconds": round(seconds, 1)}

    def remove(self, name):
        with self.lock:
            if name not in self.prints:
                return False
            meta = self._meta()
            meta.pop(name, None)
            self._save(meta)
            self.prints = {n: v for n, v in self.prints.items() if n != name}
            return True

    def check(self, audio, parts):
        """区間ごとに、登録した声かを調べる → [{start, end, keep, name, score}]
        登録がひとつもなければ、全部残す（score は None）"""
        prints = self.prints
        if not prints:
            return [{"start": a, "end": b, "keep": True, "name": None, "score": None} for a, b in parts]
        out = []
        for (a, b), (f, _) in zip(parts, self._features(audio, parts)):
            if f is None:
                out.append({"start": a, "end": b, "keep": False, "name": None, "score": None})
                continue
            name, score = max(((n, float(v @ f)) for n, v in prints.items()), key=lambda x: x[1])
            out.append({"start": a, "end": b, "keep": score >= self.threshold, "name": name, "score": round(score, 3)})
        return out


# ================= 会話ごとの「主」（呼びかけた人） =================
LEARN_MIN_SEC = 1.0      # これより長い区間だけから、主の声を学び足す（短いと特徴がぶれる）
LEARN_MARGIN = 0.05      # 学び足すのは、基準よりこれだけ余裕を持って主と判定できた区間だけ（他人の声を学ばない）
LEARN_MIN_SCORE = 0.5    # 基準が甘いうちも、これ未満の（確かでない）声からは学ばない
LEARN_CAP_SEC = 30.0     # 学び足すときの、これまでの声の重みの上限（新しい声もきちんと効くように）
ENROLLED_SEC = 10.0      # 登録した声を主にするとき、学んだ声の長さとみなす値


class Sessions:
    """会話ごとの「主」の声。呼びかけた声から始め、会話で聞き取った主の声で学び足す。
    主の声が少ないうちは特徴がぶれるので、判定の基準を甘くし、学ぶにつれて本来の基準（threshold）にする
    （試したモデルでは、0.6 秒の呼びかけからだと同じ人 0.35〜・別の人 〜0.35、数秒学び足すと同じ人 0.57〜・別の人 〜0.24）
    ・学び足すのは、はっきり主と分かり、最初に覚えた声（anchor）とも似ている窓だけ。新しい声の重みは、それまでの声より
      重くしない（テレビと混ざった窓などに、主が引きずられないように）"""

    def __init__(self, embed, threshold=0.45, ttl=1800, now=time.time):
        self.embed = embed
        self.threshold = threshold
        self.ttl = ttl
        self.now = now
        self.lock = Lock()
        self.sessions = {}   # id → {"owner": 単位ベクトル | None, "anchor", "seconds", "name", "used"}

    def _threshold(self, sess):
        sec = sess["seconds"]
        return round(self.threshold - (0.10 if sec < 1.5 else 0.05 if sec < 3.0 else 0.0), 3)

    def threshold_of(self, sid):
        return self._threshold(self.sessions[sid])

    def seconds_of(self, sid):
        return round(self.sessions[sid]["seconds"], 2)

    def start(self, sid, audio, parts, prints=None):
        """呼びかけの声（parts）を主にして会話を始める。prints: 登録した声。はっきり同じ人なら、そちらを主にする"""
        feats = [(f, n) for f, n in (features(self.embed, audio, parts) if parts else []) if f is not None]
        owner, seconds, name = None, 0.0, None
        if feats:
            weights = [n for _, n in feats]
            owner = unit(np.average(np.stack([f for f, _ in feats]), axis=0, weights=weights))
            seconds = sum(weights) / SR
            if prints:
                best, score = max(((n, float(v @ owner)) for n, v in prints.items()), key=lambda x: x[1])
                if score >= self.threshold:
                    owner, seconds, name = prints[best], ENROLLED_SEC, best
        with self.lock:
            limit = self.now() - self.ttl
            kept = {k: v for k, v in self.sessions.items() if v["used"] >= limit}
            self.sessions = {**kept, sid: {"owner": owner, "anchor": owner, "seconds": seconds, "name": name, "used": self.now()}}
        return {"owner": owner is not None, "seconds": round(seconds, 2), "name": name}

    def end(self, sid):
        with self.lock:
            self.sessions = {k: v for k, v in self.sessions.items() if k != sid}

    def _learn(self, sess, f, n):
        """主の声として学び足した新しい状態"""
        old = min(sess["seconds"], LEARN_CAP_SEC)
        new = min(n / SR, old)
        return {**sess, "owner": unit(sess["owner"] * old + f * new), "seconds": sess["seconds"] + n / SR}

    def check(self, sid, audio, parts, adopt=False):
        """区間（窓）ごとに主の声かを調べ、主の声なら学び足す → [{start, end, keep, score}]。知らない会話なら None
        主がまだ決まっていなければ全部残す。adopt（あまねが黙っている間に話し始めた発話）なら、その先頭の窓（1 秒以上）の
        声を主にする（あまねが話している間の、テレビや自分の声の回り込みを主にしないように）"""
        if sid not in self.sessions:
            return None
        feats = features(self.embed, audio, parts)   # 時間がかかるので、ロックの外で
        with self.lock:
            sess = self.sessions.get(sid)
            if sess is None:
                return None
            if sess["owner"] is None and adopt and feats and feats[0][0] is not None and feats[0][1] >= LEARN_MIN_SEC * SR:
                f, n = feats[0]
                sess = {**sess, "owner": f, "anchor": f, "seconds": n / SR}
            out = []
            for (a, b), (f, n) in zip(parts, feats):
                if f is None or sess["owner"] is None:
                    out.append({"start": a, "end": b, "keep": f is not None, "score": None})
                    continue
                thr = self._threshold(sess)
                score = float(sess["owner"] @ f)
                if (score >= max(thr + LEARN_MARGIN, LEARN_MIN_SCORE) and n >= LEARN_MIN_SEC * SR
                        and float(sess["anchor"] @ f) >= thr):
                    sess = self._learn(sess, f, n)
                out.append({"start": a, "end": b, "keep": score >= thr, "score": round(score, 3)})
            self.sessions = {**self.sessions, sid: {**sess, "used": self.now()}}
            return out

    def score(self, sid, audio):
        """話し始めの声が主かどうか（学ばない）。主が決まっていなければ主とみなす。知らない会話なら None"""
        sess = self.sessions.get(sid)
        if sess is None:
            return None
        if sess["owner"] is None:
            return {"owner": True, "score": None}
        (f, _), = features(self.embed, audio, [(0, len(audio))])
        if f is None:
            return {"owner": False, "score": None}
        score = float(sess["owner"] @ f)
        return {"owner": score >= self._threshold(sess), "score": round(score, 3)}
