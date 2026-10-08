"""疑問文に「？」を付ける

ReazonSpeech は記号（？ や 。）を出さないので、「明日晴れる」と「明日晴れる？」の区別が文字では消えてしまう。
次のどちらかに当てはまれば、疑問文として「？」を付ける。
  ・文の形: 「〜ですか」「〜かな」「〜っけ」などで終わる。「何・どこ・いつ・誰・どう・なぜ・いくら」などの疑問詞を含む
            （「何回も」「誰か」「どうでもいい」のような疑問でない言い方や、「何をすればいいか分からない」のような文の一部は除く）
  ・声の上がり調子: 話し終わりの声の高さ（基本周波数）が、その手前より上がっている（「明日晴れる？」「それ本当？」）
普通の文に「？」を付けないことを優先する。言いかけ（「明日どこに」）にも付けない（画面が続きを待つため）
"""
import re

import numpy as np

SR = 16000

# ---------- 文の形 ----------
# はっきりした疑問の終わり方だけを見る（ただの「か」「でしょう」は、ひとりごとや推量もあるので、声の上がり調子に任せる）
QUESTION_END = re.compile(r"(ですか|ますか|ませんか|でしょうか|だろうか|かな|かね|かい|かしら|っけ)$")
# 疑問詞で終わる（「それはなんで」「次はどこ」）
QUESTION_WORD_END = re.compile(r"(なんで|どうして|なぜ|何|なに|どこ|いつ|誰|だれ|どう|どれ|どっち|どちら|いくら|いくつ)$")
# 気づき・相づちなど（疑問の形に見えても付けない）
NOT_QUESTION_END = re.compile(r"(そうか|そっか|なるほど.*|まさか)$")
# 言いかけ（続きがある）。疑問詞があっても、続きを待つので付けない
UNFINISHED = re.compile(r"(が|を|に|と|で|て|けど|けれど|から|ので|のに|し|ば|ながら|たり|や|とか)$")
# 「何をすればいいか分からない」のような、文の一部の疑問（間接的な疑問）
INDIRECT = re.compile(r"か(?:知ら|分から|わから|覚え|忘れ|聞|調べ|教え|決め|考え|気にな)")
INTERROGATIVE = re.compile(
    r"何|なに|どこ|どれ|どの|どう|どんな|どっち|どちら|いつ|誰|だれ|なぜ|いくら|いくつ"
    # 「なんで」「なんの」は文の頭でだけ（「そうなんです」「雨なんで」は説明・理由）。「なんて」は「なんて言った」だけ
    r"|(?:^|[はもとて、])(?:なんで(?!す|しょ)|なんの)|なんて(?=言|いう|いっ)")
# 疑問詞を使っているが、疑問でない言い方（先に取り除いてから疑問詞を探す）。
# 「何回も」「何人か」「いつまでも」「誰にも」…（後ろに「ら・な・ね」が続く「何から」「いつかな」は疑問なので除かない）
NOT_INTERROGATIVE = re.compile(
    r"(?:何|なに|なん|どこ|どれ|どちら|どっち|誰|だれ|いつ|いくら|いくつ)[回人日年度個つ百千万]*(?:まで|に|で|と)?(?:も|か)(?![らなね])"
    r"|何とか|なんとか|何より|何だか|なんだか|何しろ|何せ|何気な|何事|何者|何一つ|なぜなら|何故か|いつの間に|いつの日"
    r"|どうでも|どうしようもな|どうにか|どうにも|どうやら|どう考えても|どうも|どうぞ|どうか|どうせ|どうしても")
CLAUSE_BREAK = re.compile(r"けど|けれど|ので|のに")


def looks_like_question(text):
    t = str(text).strip().rstrip("。．.、, ")
    if not t or NOT_QUESTION_END.search(t):
        return False
    if QUESTION_END.search(t) or QUESTION_WORD_END.search(t):
        return True
    if UNFINISHED.search(t) or INDIRECT.search(t):
        return False
    last = CLAUSE_BREAK.split(t)[-1]   # 疑問詞は最後の部分だけで探す（「昨日どこに行ったけど楽しかった」）
    return bool(INTERROGATIVE.search(NOT_INTERROGATIVE.sub("", last)))


# ---------- 声の上がり調子 ----------
# 日本語の質問は「いったん下がって、最後の一音でぐっと上がる」ことが多いので、
# 話し終わり（最後の 30 ms）の高さを、その直前（0.08〜0.3 秒前）の谷と比べる。
# 設定は VOICEVOX の 10 人の声で「？」「。」を読ませた 200 文で調整した（質問の約 60% に付き、普通の文に付けたのは 2%）。
# 普通の文に付けないことを優先している。語尾がかすれる（周期がなくなる）とても低い声では見分けられない
WIN, HOP = 400, 160            # 25 ms の区間を 10 ms ずつずらして、声の高さを求める
F0_MIN, F0_MAX = 70, 600       # 人の声の高さの範囲（Hz。高い声の語尾の上がりも入るように）
YIN_THRESHOLD = 0.3            # YIN の値（小さいほど周期的）がこれ未満なら、声とみなす
RISE_RATIO = 1.15              # 話し終わりが直前の谷のこれ倍以上（約 2.4 半音）なら上がり調子
END_FRAMES = 3                 # 話し終わり 30 ms
PRE_FROM, PRE_TO = 30, 8       # 直前の谷を探す範囲（話し終わりの 0.3 秒前〜0.08 秒前）


def f0_track(audio, sr=SR):
    """10 ms ごとの声の高さ（Hz）。声でない区間は 0。
    YIN（de Cheveigné & Kawahara, 2002）で求める。急に高さが変わる語尾でも、1 オクターブ下に取り違えにくい"""
    x_all = np.asarray(audio, np.float64)
    tau_min, tau_max = sr // F0_MAX, sr // F0_MIN
    n = len(x_all)
    if n < WIN + tau_max:
        return np.zeros(0)
    starts = range(0, n - WIN - tau_max + 1, HOP)
    levels = [float(np.sqrt(np.mean(x_all[s:s + WIN] ** 2))) for s in starts]
    # 音量の下限は、その発話の大きさに合わせる（小さい声・遠いマイクでも見分けられるように。ふつうの大きさなら 0.01）
    gate = max(0.002, min(0.01, 0.1 * max(levels, default=0.0)))
    out = []
    for s, level in zip(starts, levels):
        ext = x_all[s:s + WIN + tau_max]
        w = ext[:WIN]
        if level < gate:   # 無音・とても小さい音
            out.append(0.0)
            continue
        # 差分関数 d(τ) = Σ (x[j] - x[j+τ])² を、相関と二乗和の累積から求める
        r = np.correlate(ext, w, "valid")                 # r[τ] = Σ x[j] x[j+τ]
        c = np.concatenate([[0.0], np.cumsum(ext * ext)])
        d = c[WIN] + (c[WIN:WIN + tau_max + 1] - c[:tau_max + 1]) - 2 * r
        # 累積平均で割って正規化（τ=0 付近の小さな値を選ばないように）
        cm = np.cumsum(d[1:])
        cmnd = np.ones(tau_max + 1)
        cmnd[1:] = d[1:] * np.arange(1, tau_max + 1) / np.maximum(cm, 1e-12)
        below = np.nonzero(cmnd[tau_min:] < YIN_THRESHOLD)[0]
        if not len(below):
            out.append(0.0)
            continue
        tau = tau_min + int(below[0])
        while tau + 1 <= tau_max and cmnd[tau + 1] < cmnd[tau]:   # 谷の底まで進む
            tau += 1
        out.append(sr / tau)
    return np.array(out)


def last_part(audio, sr=SR, keep_sec=1.5):
    """話し終わりのあたり（後ろの無音を除いた、最後の keep_sec 秒）。長い発話でも調べる時間が増えないように"""
    a = np.asarray(audio, np.float32)
    if not len(a):
        return a
    loud = np.nonzero(np.abs(a) > max(0.002, 0.01 * float(np.abs(a).max())))[0]
    if len(loud):
        a = a[:int(loud[-1]) + 1]
    return a[-(int(keep_sec * sr) + WIN + sr // F0_MIN):]


def rising_end(audio, sr=SR):
    """話し終わり（最後の声）の高さが、その直前の谷より上がっているか"""
    f0 = f0_track(last_part(audio, sr), sr)
    voiced = np.nonzero(f0 > 0)[0]
    if len(voiced) < 25:   # 声が 0.25 秒もない
        return False
    last = int(voiced[-1])
    end = f0[max(0, last - END_FRAMES + 1):last + 1]
    pre = f0[max(0, last - PRE_FROM):max(0, last - PRE_TO)]
    end, pre = end[end > 0], pre[pre > 0]
    if len(end) < 3 or len(pre) < 5:
        return False
    ratio = float(np.median(end) / np.percentile(pre, 20))
    return RISE_RATIO <= ratio < 1.9   # 2 倍近い変化は、高さの取り違え（1 オクターブずれ）とみなす


# ---------- まとめ ----------
def punctuate(text, audio):
    """疑問文なら「？」を付ける → (文, 理由: "形" | "上がり調子" | None)。すでに記号で終わっていればそのまま"""
    t = str(text or "").strip()
    if not t or t[-1] in "？?！!":
        return text, None
    body = t.rstrip("。．.")
    if looks_like_question(body):
        return body + "？", "形"
    if UNFINISHED.search(body):   # 言いかけは、上がり調子でも付けない（画面が続きを待つ）
        return text, None
    if rising_end(audio):
        return body + "？", "上がり調子"
    return text, None
