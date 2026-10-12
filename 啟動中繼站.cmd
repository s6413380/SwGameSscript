@echo off
chcp 65001 >nul
rem Start the local relay from this folder; keep this window open while playing
if not exist "%~dp0monitor-server.ps1" (
  echo 找不到 monitor-server.ps1。
  echo 如果是在壓縮檔裡直接點開的，請先把整個壓縮檔「解壓縮」到一個資料夾，再到資料夾裡雙擊這個檔案。
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0monitor-server.ps1"
pause
