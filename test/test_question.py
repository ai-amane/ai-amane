"""疑問文に「？」を付ける処理（stt/question.py）のテスト

  python -m unittest discover -s test -p "test_*.py"

ReazonSpeech は記号を出さないので、文の形と、話し終わりの声の上がり調子で疑問文を見分ける。
声の上がり調子は、高さ（基本周波数）を決めて作った人工の声で確かめる。
"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "stt"))
from question import looks_like_question, punctuate, rising_end  # noqa: E402

SR = 16000


def voice(f0_start, f0_end, sec=1.5, bend_at=0.75, seed=0):
    """高さが f0_start → （bend_at 以降で）f0_end に変わる、倍音を含む声のような音"""
    n = int(sec * SR)
    t = np.arange(n) / SR
    f0 = np.where(t < bend_at * sec, f0_start, f0_start + (f0_end - f0_start) * (t - bend_at * sec) / ((1 - bend_at) * sec))
    phase = 2 * np.pi * np.cumsum(f0) / SR
    x = sum(np.sin(k * phase) / k for k in range(1, 8))
    x += 0.02 * np.random.RandomState(seed).randn(n)
    return (0.3 * x / np.max(np.abs(x))).astype(np.float32)


class LooksLikeQuestionTest(unittest.TestCase):
    def test_疑問の終わり方(self):
        for t in ["それって本当ですか", "明日は晴れますか", "どうしようかな", "あれ何だっけ", "それでいいのかしら", "一緒に行きませんか",
                  "これでいいんだろうか", "ちょっといいかい", "明日は雨でしょうか"]:
            self.assertTrue(looks_like_question(t), t)

    def test_疑問詞を含む(self):
        for t in ["今何時", "明日の天気はどう", "これいくら", "誰が来るの", "なんで怒ってるの", "どこ行く", "どっちがいい", "いつ帰ってくる",
                  "どうして知ってるの", "何食べたい", "何から始める", "なんの話", "なんて言ったの", "それはなんで"]:
            self.assertTrue(looks_like_question(t), t)

    def test_疑問でない言い方(self):
        for t in ["何でもいいよ", "誰かいる気がする", "いつも助かってる", "どこにも行かない", "何もしない", "ありがとう", "そうか", "そっか",
                  "なるほどね", "明日は晴れる", "電気を消して", "何とかなる", "どうも", "どうぞ", ""]:
            self.assertFalse(looks_like_question(t), t)

    def test_よく言う普通の文に_付けない(self):
        # 「なんで」「なんだ」の説明・理由の言い方
        for t in ["そうなんです", "実は明日休みなんです", "好きなんですよ", "そうなんだよね", "大変なんだけど", "雨なんで行かない",
                  "なんて素敵なんだ",
                  # 疑問詞を使った、疑問でない言い方
                  "何回も言った", "何人か来た", "何日もかかった", "何年も前の話", "いつまでも待つ", "どこまでも行ける", "誰にも言わない",
                  "どっちでもいい", "いくらでもある", "いくつか買った", "どうでもいい", "どうしようもない", "どうにかなる", "どうやら雨らしい",
                  "どう考えてもおかしい", "何気なく見た", "何しろ忙しい", "何一つ問題ない", "なぜなら簡単だから", "何故か眠い",
                  "いつの間にか寝てた",
                  # 「か」で終わるが、疑問でない（ひとりごと・言いよどみ）
                  "なんか", "何だか", "なんだか", "何か", "誰か", "ていうか", "というか", "まあいいか", "じゃあ寝るか", "そうなのか",
                  # 推量（質問ではない）
                  "たぶん晴れるでしょう", "明日は雨だろう",
                  # 文の一部に疑問詞がある（間接的な疑問・説明）
                  "昨日どこに行ったか忘れたけど楽しかった", "何をすればいいか分からない", "どこにあるか知らない", "何時に起きるか決めた"]:
            self.assertFalse(looks_like_question(t), t)

    def test_言いかけで終わる文には付けない(self):
        # 続きを待つ（画面側）ので、疑問詞があっても「？」は付けない
        for t in ["明日どこに", "何を", "誰と", "それで何が", "どこで", "何時から", "いつまで待てば"]:
            self.assertFalse(looks_like_question(t), t)


class RisingEndTest(unittest.TestCase):
    def test_語尾で上がる声(self):
        self.assertTrue(rising_end(voice(150, 230)))
        self.assertTrue(rising_end(voice(220, 320, seed=1)))   # 高い声でも
        self.assertTrue(rising_end(voice(95, 135, seed=2)))    # 低い声でも
        self.assertTrue(rising_end(voice(330, 480, seed=3)))   # とても高い声でも（上がった先が 400Hz を超える）

    def test_平らな声_下がる声は上がっていない(self):
        self.assertFalse(rising_end(voice(150, 150)))
        self.assertFalse(rising_end(voice(180, 130)))

    def test_少しだけ上がる声は_上がりとみなさない(self):
        self.assertFalse(rising_end(voice(150, 158)))

    def test_雑音や短すぎる音は_上がりとみなさない(self):
        self.assertFalse(rising_end(0.1 * np.random.RandomState(0).randn(SR).astype(np.float32)))
        self.assertFalse(rising_end(voice(150, 230, sec=0.2)))
        self.assertFalse(rising_end(np.zeros(SR, np.float32)))

    def test_最後の無音は無視して_声の終わりを見る(self):
        audio = np.concatenate([voice(150, 230), np.zeros(int(0.4 * SR), np.float32)])
        self.assertTrue(rising_end(audio))


class PunctuateTest(unittest.TestCase):
    def test_文の形か上がり調子なら_を付ける(self):
        flat = voice(150, 150)
        self.assertEqual(punctuate("明日は晴れますか", flat), ("明日は晴れますか？", "形"))
        self.assertEqual(punctuate("明日晴れる", voice(150, 230)), ("明日晴れる？", "上がり調子"))
        self.assertEqual(punctuate("明日晴れる", flat), ("明日晴れる", None))

    def test_すでに記号があるときは_付け直さない(self):
        self.assertEqual(punctuate("本当？", voice(150, 230)), ("本当？", None))
        self.assertEqual(punctuate("本当に?", voice(150, 230)), ("本当に?", None))
        self.assertEqual(punctuate("よかった！", voice(150, 230)), ("よかった！", None))

    def test_句点で終わる疑問文は_に置き換える(self):
        # Whisper は「。」を付けてくることがある
        self.assertEqual(punctuate("それって本当ですか。", voice(150, 150)), ("それって本当ですか？", "形"))

    def test_空の文はそのまま(self):
        self.assertEqual(punctuate("", voice(150, 230)), ("", None))

    def test_言いかけで終わっていたら_上がり調子でも付けない(self):
        self.assertEqual(punctuate("明日どこに", voice(150, 230)), ("明日どこに", None))
        self.assertEqual(punctuate("雨が降ってきたけど", voice(150, 230)), ("雨が降ってきたけど", None))


class LongUtteranceTest(unittest.TestCase):
    def test_長い発話でも_話し終わりの上がり調子を見つける(self):
        long = np.concatenate([voice(150, 150, sec=8.0), voice(150, 230)])
        self.assertTrue(rising_end(long))
        self.assertFalse(rising_end(np.concatenate([voice(150, 230, sec=8.0), voice(150, 150)])))

    def test_小さい声でも見分ける(self):
        self.assertTrue(rising_end(voice(150, 230) * 0.05))


if __name__ == "__main__":
    unittest.main()
