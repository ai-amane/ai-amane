"""声の区間（Silero VAD の結果）を、文字起こしする区間に整える

騒がしくて長いかたまりで届いた発話を、声の切れ目で区切り直すのに使う（待受中の呼びかけ探し）。
"""


def plan_segments(spans, total, sr=16000, pad=0.15, min_len=0.3, max_count=8):
    """spans: 声の区間 [(開始, 終了), ...]（サンプル数）。total: 音声の長さ（サンプル数）

    ・言葉の頭や終わりが切れないよう、前後に pad 秒の余白を付ける。余白で重なるほど近い区間はつなげる
    ・つなげたあとで、声の合計が min_len 秒に満たない区間は、物音として捨てる
      （先に捨てると、素早く言った短い呼びかけが、すぐ後に続く用件から外れて消える）
    ・max_count 個を超えるときは、間の短いところからつなげる（文字起こしの回数を抑えるため）
    """
    p = round(pad * sr)
    merged = []  # (開始, 終了, 声の合計)
    for s, e in sorted(spans):
        a, b = max(0, s - p), min(total, e + p)
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b), merged[-1][2] + e - s)
        else:
            merged.append((a, b, e - s))
    kept = [m for m in merged if m[2] >= round(min_len * sr)]
    while len(kept) > max_count:
        i = min(range(len(kept) - 1), key=lambda k: kept[k + 1][0] - kept[k][1])
        kept = kept[:i] + [(kept[i][0], kept[i + 1][1], kept[i][2] + kept[i + 1][2])] + kept[i + 2:]
    return [(a, b) for a, b, _ in kept]
