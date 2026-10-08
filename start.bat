@echo off
cd /d "%~dp0"
title AI AMANE
where node >nul 2>nul
if errorlevel 1 (
  echo [AMANE] Node.js was not found. Install the LTS version from https://nodejs.org/ and try again.
  pause
  exit /b 1
)
rem Install Node packages if any of them is missing (packages are added over time)
set NEED_NPM=
if not exist node_modules\kuromoji set NEED_NPM=1
if not exist node_modules\linkedom set NEED_NPM=1
if not exist node_modules\@mozilla\readability set NEED_NPM=1
if defined NEED_NPM (
  echo [AMANE] Installing Node packages...
  call npm install --no-audit --no-fund
)
rem --- local speech recognition (Python) ---
findstr /r /c:"^STT_AUTOSTART=0" .env >nul 2>nul
if errorlevel 1 (
  where python >nul 2>nul
  if errorlevel 1 (
    echo [AMANE] Python was not found. Local speech recognition will be skipped.
  ) else (
    python -c "import sherpa_onnx, huggingface_hub" 2>nul
    if errorlevel 1 (
      echo [AMANE] Installing speech recognition packages...
      python -m pip install sherpa-onnx huggingface_hub numpy
    )
    findstr /r /c:"^STT_ENGINE=whisper" .env >nul 2>nul
    if not errorlevel 1 (
      python -c "import faster_whisper" 2>nul
      if errorlevel 1 python -m pip install faster-whisper
      python -c "import nvidia.cublas, nvidia.cudnn" 2>nul
      if errorlevel 1 python -m pip install nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
    )
  )
)
node server.js
pause
