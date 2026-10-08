"""声紋（話者照合）の処理（stt/speaker.py）のテスト

  python -m unittest discover -s test -p "test_*.py"

声の特徴（埋め込み）を求めるモデルの代わりに、音声の中身から決まる特徴を返す関数を使って、
登録・照合・保存の流れを確かめる。
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "stt"))
from speaker import (  # noqa: E402
    Sessions, Voiceprints, clean_name, kept_regions, loud_region, owner_parts, spans_within, split_windows, widen,
)

SR = 16000


def s(sec):
    return round(sec * SR)


# 「声」の代わり: 区間の音の高さ（値）で人が決まる。値 1.0 は A さん、-1.0 は B さん
A, B = 1.0, -1.0


def fake_embed(audio):
    """平均値の符号で A / B を見分ける特徴（長さ 2 の単位ベクトル）"""
    m = float(np.mean(audio))
    v = np.array([max(m, 0.0), max(-m, 0.0)], np.float32) + 1e-6
    return v / np.linalg.norm(v)


def unit2(v):
    return v / np.linalg.norm(v)


def voice(*parts):
    """parts: (秒, 値) の並び。値 0 は無音"""
    return np.concatenate([np.full(s(sec), val, np.float32) for sec, val in parts])


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="amane-voiceprint-")
        self.path = os.path.join(self.dir, "voiceprints.json")
        self.vp = Voiceprints(self.path, embed=fake_embed, threshold=0.45)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)


class CleanNameTest(unittest.TestCase):
    def test_前後の空白と制御文字を除き_20文字まで(self):
        self.assertEqual(clean_name("  わたし\n"), "わたし")
        self.assertEqual(clean_name("あ" * 30), "あ" * 20)

    def test_空ならエラー(self):
        with self.assertRaises(ValueError):
            clean_name("  \t ")


class WidenTest(unittest.TestCase):
    def test_短い区間は前後に広げて最低の長さにする(self):
        self.assertEqual(widen(s(2.0), s(2.4), s(10), min_len=s(1.0)), (s(1.7), s(2.7)))

    def test_広げても音声の端は超えない(self):
        self.assertEqual(widen(s(0.1), s(0.3), s(10), min_len=s(1.0)), (0, s(1.0)))
        self.assertEqual(widen(s(9.8), s(9.9), s(10), min_len=s(1.0)), (s(9.0), s(10)))

    def test_十分長い区間はそのまま(self):
        self.assertEqual(widen(s(1.0), s(3.0), s(10), min_len=s(1.0)), (s(1.0), s(3.0)))

    def test_音声全体が最低の長さより短ければ全体(self):
        self.assertEqual(widen(s(0.1), s(0.2), s(0.5), min_len=s(1.0)), (0, s(0.5)))


class SplitWindowsTest(unittest.TestCase):
    """テレビと人の声は切れ目なく続くことがあるので、声の区間を短い窓に刻んでから照合する"""

    def test_長い区間は_ほぼ同じ長さの窓に刻む(self):
        self.assertEqual(split_windows([(0, s(3.0))], win=s(1.5)), [(0, s(1.5)), (s(1.5), s(3.0))])
        self.assertEqual(split_windows([(0, s(4.5))], win=s(1.5)), [(0, s(1.5)), (s(1.5), s(3.0)), (s(3.0), s(4.5))])

    def test_窓の長さ前後の区間はそのまま(self):
        self.assertEqual(split_windows([(s(1.0), s(3.0)), (s(4.0), s(4.5))], win=s(1.5)), [(s(1.0), s(3.0)), (s(4.0), s(4.5))])

    def test_割り切れない長さは均等に分ける(self):
        got = split_windows([(0, s(4.0))], win=s(1.5))
        self.assertEqual(len(got), 3)
        self.assertEqual(got[0][0], 0)
        self.assertEqual(got[-1][1], s(4.0))
        self.assertTrue(all(a < b for a, b in got))
        self.assertTrue(all(got[i][1] == got[i + 1][0] for i in range(len(got) - 1)))


class OwnerPartsTest(unittest.TestCase):
    """呼びかけは発話の先頭にあるので、主の声は先頭の窓からだけとる（後ろに続くテレビの声を混ぜない）"""

    def test_先頭の窓だけ(self):
        self.assertEqual(owner_parts([(0, s(4.0))]), [(0, s(4.0) // 3)])
        self.assertEqual(owner_parts([(0, s(1.0)), (s(2.0), s(5.0))]), [(0, s(1.0))])

    def test_声がなければ空(self):
        self.assertEqual(owner_parts([]), [])


class WakeRangeTest(unittest.TestCase):
    """呼びかけの範囲（画面が教える start〜end）から、主の声をとる区間を決める。
    声の判定は音声全体で行い（短く切り出すと声を見落とすことがある）、その範囲に切り詰める"""

    def test_声の区間を範囲に切り詰める(self):
        spans = [(s(0.2), s(1.0)), (s(1.5), s(2.5)), (s(3.0), s(4.0))]
        self.assertEqual(spans_within(spans, s(1.8), s(3.2)), [(s(1.8), s(2.5)), (s(3.0), s(3.2))])

    def test_切り詰めて短くなりすぎた区間は捨てる(self):
        self.assertEqual(spans_within([(s(1.0), s(2.0))], s(1.95), s(3.0)), [])

    def test_範囲の中で音の大きいところ(self):
        audio = voice((1.0, 0), (0.6, 0.5), (1.0, 0))
        a, b = loud_region(audio, 0, len(audio))[0]
        self.assertAlmostEqual(a / SR, 1.0, delta=0.03)
        self.assertAlmostEqual(b / SR, 1.6, delta=0.03)

    def test_範囲の外の大きな音は使わない(self):
        audio = voice((1.0, 0.5), (1.0, 0), (0.5, 0.3), (1.0, 0))   # 範囲の外（先頭）にテレビの大きな音
        a, b = loud_region(audio, s(1.5), s(3.5))[0]
        self.assertAlmostEqual(a / SR, 2.0, delta=0.03)
        self.assertAlmostEqual(b / SR, 2.5, delta=0.03)

    def test_無音なら空(self):
        self.assertEqual(loud_region(voice((1.0, 0)), 0, s(1.0)), [])
        self.assertEqual(loud_region(voice((1.0, 0.5)), s(0.5), s(0.5)), [])


class KeptRegionsTest(unittest.TestCase):
    def test_続いている窓はつなげ_離れた窓は分ける(self):
        checks = [
            {"start": 0, "end": 10, "keep": True}, {"start": 10, "end": 20, "keep": True},
            {"start": 20, "end": 30, "keep": False}, {"start": 30, "end": 40, "keep": True},
            {"start": 45, "end": 50, "keep": True},
        ]
        self.assertEqual(kept_regions(checks), [(0, 20), (30, 40), (45, 50)])

    def test_残す窓がなければ空(self):
        self.assertEqual(kept_regions([{"start": 0, "end": 10, "keep": False}]), [])


class EnrollTest(Base):
    def test_登録すると保存され_読み込み直しても残る(self):
        audio = voice((0.5, 0), (3.5, A), (0.5, 0))
        res = self.vp.enroll("わたし", audio, [(s(0.5), s(4.0))])
        self.assertEqual(res["name"], "わたし")
        self.assertAlmostEqual(res["seconds"], 3.5, places=1)
        self.assertEqual(Voiceprints(self.path, embed=fake_embed).names(), ["わたし"])
        with open(self.path, encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(len(saved["わたし"]["embedding"]), 2)

    def test_声が短すぎると登録しない(self):
        with self.assertRaises(ValueError):
            self.vp.enroll("わたし", voice((2.0, A)), [(0, s(2.0))])
        self.assertEqual(self.vp.names(), [])

    def test_同じ名前で登録し直すと置き換える(self):
        self.vp.enroll("わたし", voice((4.0, A)), [(0, s(4.0))])
        self.vp.enroll("わたし", voice((4.0, B)), [(0, s(4.0))])
        self.assertEqual(self.vp.names(), ["わたし"])
        self.assertEqual(self.vp.check(voice((2.0, B)), [(0, s(2.0))])[0]["keep"], True)

    def test_削除できる(self):
        self.vp.enroll("わたし", voice((4.0, A)), [(0, s(4.0))])
        self.assertTrue(self.vp.remove("わたし"))
        self.assertFalse(self.vp.remove("わたし"))
        self.assertEqual(Voiceprints(self.path, embed=fake_embed).names(), [])

    def test_壊れたファイルは登録なしとして扱う(self):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write("{ broken")
        self.assertEqual(Voiceprints(self.path, embed=fake_embed).names(), [])


class CheckTest(Base):
    def setUp(self):
        super().setUp()
        self.vp.enroll("わたし", voice((4.0, A)), [(0, s(4.0))])

    def test_登録した声の区間だけを残す(self):
        # テレビ（B さん）→ わたし → テレビ
        audio = voice((2.0, B), (0.5, 0), (2.0, A), (0.5, 0), (1.5, B))
        parts = [(0, s(2.0)), (s(2.5), s(4.5)), (s(5.0), s(6.5))]
        got = self.vp.check(audio, parts)
        self.assertEqual([g["keep"] for g in got], [False, True, False])
        self.assertEqual(got[1]["name"], "わたし")
        self.assertGreater(got[1]["score"], 0.9)
        self.assertLess(got[0]["score"], 0.45)

    def test_短い区間は前後を含めて調べる(self):
        # 0.4 秒だけの「はい」も、前後の自分の声と合わせて 1 秒にして調べる
        audio = voice((1.0, 0), (0.4, A), (1.0, 0))
        got = self.vp.check(audio, [(s(1.0), s(1.4))])
        self.assertEqual(got[0]["start"], s(1.0))   # 返す区間は元のまま
        self.assertEqual(got[0]["end"], s(1.4))

    def test_登録がなければ全部残す(self):
        empty = Voiceprints(os.path.join(self.dir, "none.json"), embed=fake_embed)
        got = empty.check(voice((2.0, B)), [(0, s(2.0))])
        self.assertEqual([g["keep"] for g in got], [True])
        self.assertIsNone(got[0]["score"])

    def test_複数人を登録したら_どちらの声も残す(self):
        self.vp.enroll("家族", voice((4.0, B)), [(0, s(4.0))])
        audio = voice((2.0, A), (2.0, B))
        got = self.vp.check(audio, [(0, s(2.0)), (s(2.0), s(4.0))])
        self.assertEqual([(g["keep"], g["name"]) for g in got], [(True, "わたし"), (True, "家族")])


class SessionsTest(unittest.TestCase):
    """会話ごとの「主」（呼びかけた人）の声"""

    def setUp(self):
        self.clock = [1000.0]
        self.ss = Sessions(fake_embed, threshold=0.45, ttl=1800, now=lambda: self.clock[0])

    def wake(self, sid="s1", sec=0.6, who=A):
        return self.ss.start(sid, voice((0.2, 0), (sec, who), (0.2, 0)), [(s(0.2), s(0.2 + sec))])

    def test_呼びかけの声を主にして_主の声だけを残す(self):
        self.assertTrue(self.wake()["owner"])
        audio = voice((2.0, B), (2.0, A), (1.5, B))   # テレビ → 主 → 家族
        got = self.ss.check("s1", audio, [(0, s(2.0)), (s(2.0), s(4.0)), (s(4.0), s(5.5))])
        self.assertEqual([g["keep"] for g in got], [False, True, False])

    def test_知らない会話は_None(self):
        self.assertIsNone(self.ss.check("nope", voice((1.0, A)), [(0, s(1.0))]))
        self.assertIsNone(self.ss.score("nope", voice((1.0, A))))

    def test_主の声が少ないうちは基準が甘く_学び足すと本来の基準になる(self):
        self.wake(sec=0.6)
        self.assertAlmostEqual(self.ss.threshold_of("s1"), 0.35)
        self.ss.check("s1", voice((2.0, A)), [(0, s(2.0))])          # 主の声を 2 秒学び足す（合計 2.6 秒）
        self.assertAlmostEqual(self.ss.threshold_of("s1"), 0.40)
        self.ss.check("s1", voice((2.0, A)), [(0, s(2.0))])          # 合計 4.6 秒
        self.assertAlmostEqual(self.ss.threshold_of("s1"), 0.45)

    def test_主と判定しても_はっきりしない声からは学ばない(self):
        # 基準（0.35）は超えるが 0.5 に届かない声（似ているが確かでない）は残すだけで、主の声として学ばない
        half = lambda a: unit2(np.array([0.42, 0.9075], np.float32))  # noqa: E731  主（A）との一致 0.42
        ss = Sessions(lambda a: fake_embed(a) if abs(float(np.mean(a))) != 0.5 else half(a), threshold=0.45, now=lambda: 0)
        ss.start("s1", voice((0.6, A)), [(0, s(0.6))])
        got = ss.check("s1", voice((2.0, 0.5)), [(0, s(2.0))])
        self.assertEqual(got[0]["keep"], True)
        self.assertAlmostEqual(ss.seconds_of("s1"), 0.6)

    def test_短い区間や主でない区間からは学ばない(self):
        self.wake(sec=0.6)
        self.ss.check("s1", voice((0.5, A), (2.0, B)), [(0, s(0.5)), (s(0.5), s(2.5))])
        self.assertAlmostEqual(self.ss.seconds_of("s1"), 0.6)

    def test_呼びかけの声がとれなければ_あまねが黙っている間に話し始めた発話の先頭の声を主にする(self):
        self.assertFalse(self.ss.start("s1", voice((1.0, 0)), [])["owner"])
        # あまねが話している間に聞こえた声（テレビ・あまね自身の声の回り込み）からは主を決めない
        got = self.ss.check("s1", voice((2.0, B)), [(0, s(2.0))], adopt=False)
        self.assertEqual([g["keep"] for g in got], [True])         # 主が決まるまでは全部残す
        # 黙っている間に話し始めた発話の、先頭の窓（1 秒以上）の声を主にし、同じ発話の残りもその人で調べる
        got = self.ss.check("s1", voice((2.0, A), (2.0, B)), [(0, s(2.0)), (s(2.0), s(4.0))], adopt=True)
        self.assertEqual([g["keep"] for g in got], [True, False])
        got = self.ss.check("s1", voice((2.0, B), (2.0, A)), [(0, s(2.0)), (s(2.0), s(4.0))])
        self.assertEqual([g["keep"] for g in got], [False, True])

    def test_先頭の窓が短ければ_まだ主を決めない(self):
        self.ss.start("s1", voice((1.0, 0)), [])
        self.ss.check("s1", voice((0.5, B), (2.0, A)), [(0, s(0.5)), (s(0.5), s(2.5))], adopt=True)
        self.assertEqual(self.ss.score("s1", voice((1.0, B)))["owner"], True)   # 主なし（全員を主とみなす）のまま

    def test_最初に学び足す声に引きずられない(self):
        # 主（A）と 0.7 だけ似ている声 M（テレビと混ざった窓など）を 2 秒学んでも、主は M より A に近いまま
        m_vec = unit2(np.array([0.7, 0.714], np.float32))
        embed = lambda a: m_vec if abs(float(np.mean(a)) - 0.5) < 1e-3 else fake_embed(a)  # noqa: E731
        ss = Sessions(embed, threshold=0.45, now=lambda: 0)
        ss.start("s1", voice((0.6, A)), [(0, s(0.6))])
        ss.check("s1", voice((2.0, 0.5)), [(0, s(2.0))])
        self.assertGreaterEqual(ss.score("s1", voice((1.0, A)))["score"] + 1e-3, ss.score("s1", voice((1.0, 0.5)))["score"])

    def test_声が短すぎて特徴がとれない区間は_使わない(self):
        nan_embed = lambda a: np.full(2, np.nan, np.float32) if len(a) < 1600 else fake_embed(a)  # noqa: E731
        ss = Sessions(nan_embed, threshold=0.45, now=lambda: 0)
        self.assertFalse(ss.start("s1", voice((0.05, A)), [(0, s(0.05))])["owner"])
        ss.start("s2", voice((0.6, A)), [(0, s(0.6))])
        got = ss.check("s2", voice((0.05, A)), [(0, s(0.05))])
        self.assertEqual([g["keep"] for g in got], [False])

    def test_登録した声と似ていない人が呼んだら_登録した声に置き換えない(self):
        got = self.ss.start("s1", voice((0.6, B)), [(0, s(0.6))], prints={"わたし": fake_embed(np.full(10, A, np.float32))})
        self.assertIsNone(got["name"])
        self.assertTrue(self.ss.score("s1", voice((1.0, B)))["owner"])

    def test_登録した声と同じ人が呼んだら_登録した声を主にする(self):
        got = self.ss.start("s1", voice((0.6, A)), [(0, s(0.6))], prints={"わたし": fake_embed(np.full(10, A, np.float32))})
        self.assertEqual(got["name"], "わたし")
        self.assertAlmostEqual(self.ss.threshold_of("s1"), 0.45)    # 登録した声は十分長いので、最初から本来の基準

    def test_話し始めの照合は主かどうかだけを返し_学ばない(self):
        self.wake()
        self.assertTrue(self.ss.score("s1", voice((1.0, A)))["owner"])
        self.assertFalse(self.ss.score("s1", voice((1.0, B)))["owner"])
        self.assertAlmostEqual(self.ss.seconds_of("s1"), 0.6)

    def test_しばらく使われない会話は忘れる_終わった会話も忘れる(self):
        self.wake("s1")
        self.wake("s2")
        self.clock[0] += 1801
        self.wake("s3")                 # 新しい会話を始めるときに、古いものを片付ける
        self.assertIsNone(self.ss.score("s1", voice((1.0, A))))
        self.ss.end("s3")
        self.assertIsNone(self.ss.score("s3", voice((1.0, A))))


if __name__ == "__main__":
    unittest.main()
