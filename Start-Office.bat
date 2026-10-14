@echo off
title Lazy dough - Migrate Team
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js not found. Please install it from https://nodejs.org
  pause
  exit /b 1
)

where claude >nul 2>nul
if errorlevel 1 (
  echo [*] Claude Code CLI not found. Installing...
  call npm install -g @anthropic-ai/claude-code
  if errorlevel 1 (
    echo [!] Install failed.
    pause
    exit /b 1
  )
)

rem port 4778 so this office can run side by side with the Lazy dough office (4777)
set OFFICE_PORT=4778
echo [*] Starting Lazy dough - Migrate Team at http://127.0.0.1:%OFFICE_PORT%
echo     Keep this window open. Closing it stops the office.
echo.
rem temporary: fable rate-limited, remove this line to switch back
set OFFICE_MODEL_MAP=fable=opus
call npm run office
echo.
echo [*] Office stopped.
pause
