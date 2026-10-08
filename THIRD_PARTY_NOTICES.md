# サードパーティのライセンス表記

AI あまね 本体のコードは [MIT ライセンス](LICENSE) です。
このリポジトリには、次の第三者のコードが含まれています。また、実行時に次のソフトウェア・モデル・サービスを利用します。

## このリポジトリに含まれるもの

### @elevenlabs/client 1.26.0（`public/vendor/elevenlabs-client.js`）

- ライセンス: MIT（全文は `public/vendor/elevenlabs-client.LICENSE`）
- 配布元: https://www.npmjs.com/package/@elevenlabs/client

### webgl-noise（`public/swarm.js` と `public/orb.js` の 3D シンプレックスノイズ関数）

- ライセンス: MIT
- Copyright (C) 2011 Ashima Arts / Stefan Gustavson
- 配布元: https://github.com/ashima/webgl-noise

```
Copyright (C) 2011 by Ashima Arts (Simplex noise)
Copyright (C) 2011-2016 by Stefan Gustavson (Classic noise and others)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## 実行時にインストール・ダウンロードされるもの（リポジトリには含まれません）

| 名前 | 用途 | ライセンス |
|---|---|---|
| [kuromoji.js](https://github.com/takuyaa/kuromoji.js) | 呼びかけの言葉の読み仮名変換（`npm install`） | Apache-2.0。辞書は mecab-ipadic（NAIST の著作権表示と免責事項を同梱） |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | ローカル音声認識の実行 | Apache-2.0 |
| [ReazonSpeech k2 v2](https://huggingface.co/reazon-research/reazonspeech-k2-v2) | 日本語音声認識モデル（初回に自動ダウンロード） | Apache-2.0 |
| [Silero VAD](https://github.com/snakers4/silero-vad) | 声かどうかの判定モデル（初回に自動ダウンロード） | MIT |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | Whisper での音声認識（任意） | MIT |
| [kotoba-whisper v2.0](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-faster) | Whisper の日本語モデル（任意） | モデルカードのライセンスに従う |
| [Laya](https://github.com/NandhaKishorM/laya) | 作業の軽重判定（任意） | Apache-2.0 |

## 利用規約に従って使う外部サービス・ソフトウェア

これらは本リポジトリには含まれず、利用者自身がそれぞれの規約に同意して使います。

- **VOICEVOX**: 音声ライブラリ（キャラクター）ごとに利用規約があります。合成した音声を公開する場合は「VOICEVOX:四国めたん」のようなクレジット表記が必要です。https://voicevox.hiroshiba.jp/term/
- **ElevenLabs**: 無料プランは商用利用できません。https://elevenlabs.io/terms-of-use
- **Claude Code（Anthropic）/ Codex（OpenAI）**: 各サービスの利用規約・利用上限に従ってください。
- **ブラウザの音声認識（Web Speech API）**: 「ブラウザの音声認識」を選んだ場合、音声は Google（Chrome）または Microsoft（Edge）のサーバーに送られます。
