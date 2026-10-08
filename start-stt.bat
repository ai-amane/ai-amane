@echo off
cd /d "%~dp0"
title AMANE speech recognition
where python >nul 2>nul
if errorlevel 1 (
  echo [AMANE] Python was not found. Install Python 3.10-3.12 first.
  pause
  exit /b 1
)
python -c "import sherpa_onnx, huggingface_hub" 2>nul
if errorlevel 1 (
  echo [AMANE] Installing sherpa-onnx - ReazonSpeech...
  python -m pip install sherpa-onnx huggingface_hub numpy
)
findstr /r /c:"^STT_ENGINE=whisper" .env >nul 2>nul
if not errorlevel 1 (
  python -c "import faster_whisper" 2>nul
  if errorlevel 1 python -m pip install faster-whisper
  python -c "import nvidia.cublas, nvidia.cudnn" 2>nul
  if errorlevel 1 python -m pip install nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
)
set HF_HUB_DISABLE_SYMLINKS_WARNING=1
python stt\stt_server.py
pause
