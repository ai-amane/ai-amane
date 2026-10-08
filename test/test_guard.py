"""音声認識サーバーの入口の確認（stt/guard.py）のテスト

  python -m unittest discover -s test -p "test_*.py"

ブラウザで開いたほかのサイトから、音声認識サーバー（127.0.0.1）を勝手に使われないことを確かめる。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "stt"))
from guard import MAX_BODY, request_denied, check_rate  # noqa: E402

PORT = 3941


def denied(method="POST", host="127.0.0.1:3941", ctype="audio/wav", length="100", origin=None):
    return request_denied(method, host, ctype, length, origin, PORT)


class RequestDeniedTest(unittest.TestCase):
    def test_server_js_calls_pass(self):
        # server.js（Node の fetch）は Origin を付けず、POST はいつも audio/wav
        self.assertIsNone(denied())
        self.assertIsNone(denied(host="localhost:3941"))
        self.assertIsNone(denied(method="GET", ctype=None, length=None))
        self.assertIsNone(denied(length="0"))

    def test_other_hosts_are_denied(self):
        # DNS リバインディング（ほかのサイトの名前でこのサーバーを指す）
        for host in ("evil.example:3941", "127.0.0.1:80", "", None):
            self.assertIsNotNone(denied(host=host), host)

    def test_browser_requests_are_denied(self):
        # ブラウザからの要求には Origin が付く（ほかのサイトのページからの CSRF）
        self.assertIsNotNone(denied(origin="https://evil.example"))
        self.assertIsNotNone(denied(origin="null"))
        self.assertIsNotNone(denied(method="GET", ctype=None, length=None, origin="http://localhost:3939"))

    def test_post_must_be_wav_and_not_too_large(self):
        self.assertIsNotNone(denied(ctype="text/plain"))
        self.assertIsNotNone(denied(ctype=None))
        self.assertIsNone(denied(ctype="audio/wav; charset=binary"))
        self.assertIsNotNone(denied(length=str(MAX_BODY + 1)))
        self.assertIsNotNone(denied(length="-1"))
        self.assertIsNotNone(denied(length="abc"))


class CheckRateTest(unittest.TestCase):
    def test_rate_and_channels(self):
        check_rate(16000, 1)
        check_rate(48000, 2)
        for sr, ch in ((1, 1), (7999, 1), (96000, 1), (16000, 0), (16000, 3)):
            with self.assertRaises(ValueError):
                check_rate(sr, ch)


if __name__ == "__main__":
    unittest.main()
