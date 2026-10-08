"""声の区間を、文字起こしする区間に整える処理（stt/segments.py）のテスト

  python -m unittest discover -s test -p "test_*.py"
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "stt"))
from segments import plan_segments  # noqa: E402

SR = 16000


def s(sec):
    return round(sec * SR)


class PlanSegmentsTest(unittest.TestCase):
    def test_声がなければ空(self):
        self.assertEqual(plan_segments([], s(5)), [])

    def test_離れた区間は別々にして前後に余白を付ける(self):
        spans = [(s(1.0), s(2.0)), (s(3.0), s(3.6))]
        self.assertEqual(plan_segments(spans, s(5)), [(s(0.85), s(2.15)), (s(2.85), s(3.75))])

    def test_余白で重なるほど近い区間はつなげる(self):
        spans = [(s(1.0), s(2.0)), (s(2.2), s(3.0))]  # 間は 0.2 秒
        self.assertEqual(plan_segments(spans, s(5)), [(s(0.85), s(3.15))])

    def test_短い区間も近くの区間とつながるなら捨てない(self):
        # 素早く言った「あまね」（0.25 秒）のすぐ後に用件が続く
        spans = [(s(1.0), s(1.25)), (s(1.5), s(2.5))]
        self.assertEqual(plan_segments(spans, s(5)), [(s(0.85), s(2.65))])

    def test_短すぎる区間は物音として捨てる(self):
        spans = [(s(1.0), s(1.1)), (s(2.0), s(3.0))]
        self.assertEqual(plan_segments(spans, s(5)), [(s(1.85), s(3.15))])

    def test_余白は音声の端を超えない(self):
        spans = [(s(0.05), s(1.0)), (s(4.5), s(4.98))]
        self.assertEqual(plan_segments(spans, s(5)), [(0, s(1.15)), (s(4.35), s(5))])

    def test_多すぎるときは間の短いところからつなげて上限に収める(self):
        # 1 秒ずつの区間。間は 0.5 秒（C と D の間だけ 0.4 秒）
        spans = [(s(0.5), s(1.5)), (s(2.0), s(3.0)), (s(3.5), s(4.5)), (s(4.9), s(5.9)), (s(6.4), s(7.4))]
        self.assertEqual(
            plan_segments(spans, s(8), max_count=3),
            [(s(0.35), s(3.15)), (s(3.35), s(6.05)), (s(6.25), s(7.55))],
        )

    def test_順番がばらばらでも時刻順に返す(self):
        spans = [(s(3.0), s(3.6)), (s(1.0), s(2.0))]
        self.assertEqual(plan_segments(spans, s(5)), [(s(0.85), s(2.15)), (s(2.85), s(3.75))])


if __name__ == "__main__":
    unittest.main()
