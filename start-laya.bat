@echo off
cd /d "%~dp0"
title AMANE Laya router
where python >nul 2>nul
if errorlevel 1 (
  echo [AMANE] Python was not found. Install Python 3.10+ and run: python -m pip install laya
  pause
  exit /b 1
)
python router\laya_bridge.py %*
pause
