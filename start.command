#!/bin/bash
# AI あまね 起動用（Mac）。Finder でダブルクリックするか、ターミナルで ./start.command
cd "$(dirname "$0")" || exit 1
printf '\033]0;AI AMANE\007'

if ! command -v node >/dev/null 2>&1; then
  echo "[AMANE] Node.js was not found. Install the LTS version from https://nodejs.org/ and try again."
  read -r -p "Press Enter to close..."
  exit 1
fi
# 足したパッケージも入るよう、ひとつでも無ければ npm install する
if [ ! -d node_modules/kuromoji ] || [ ! -d node_modules/linkedom ] || [ ! -d node_modules/@mozilla/readability ]; then
  echo "[AMANE] Installing Node packages..."
  npm install --no-audit --no-fund
fi

# --- local speech recognition (Python) ---
# Mac 標準の python3 にはパッケージを入れられないことがあるので、このフォルダの .venv に入れて使う。
# .env に PYTHON_BIN を書いた場合は、そちらをそのまま使う。
if ! grep -qE '^STT_AUTOSTART=0' .env 2>/dev/null && ! grep -qE '^PYTHON_BIN=[^[:space:]]' .env 2>/dev/null; then
  PY=""
  for p in python3.12 python3.11 python3.10 python3; do
    if command -v "$p" >/dev/null 2>&1; then PY="$p"; break; fi
  done
  if [ -z "$PY" ]; then
    echo "[AMANE] Python was not found. Local speech recognition will be skipped."
  else
    if [ ! -x .venv/bin/python ]; then
      echo "[AMANE] Creating Python environment (.venv) with $($PY --version 2>&1)..."
      "$PY" -m venv .venv
    fi
    if ! .venv/bin/python -c "import sherpa_onnx, huggingface_hub" 2>/dev/null; then
      echo "[AMANE] Installing speech recognition packages..."
      .venv/bin/python -m pip install sherpa-onnx huggingface_hub numpy
    fi
    # Mac では GPU を使えないので Whisper は CPU で動く（遅い）。既定の reazonspeech がおすすめ
    if grep -qE '^STT_ENGINE=whisper' .env 2>/dev/null && ! .venv/bin/python -c "import faster_whisper" 2>/dev/null; then
      .venv/bin/python -m pip install faster-whisper
    fi
    export PYTHON_BIN="$PWD/.venv/bin/python"
  fi
fi

exec node server.js
