@echo off
if "%~1"=="" (
  echo ReplayCam ZIP file onto this BAT file.
  echo [ReplayCam] Drag and drop the ZIP onto merge_replay.bat.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0merge_replay.ps1" -ZipPath "%~1"
if errorlevel 1 (
  echo Failed. Ensure FFmpeg is installed and on PATH.
)
pause
