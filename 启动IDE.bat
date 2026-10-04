@echo off
title UL Research Tree IDE
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [UL-IDE] Node.js not found. Install it from https://nodejs.org then run again.
  pause
  exit /b 1
)

set PORT=8899
if defined UL_IDE_PORT set PORT=%UL_IDE_PORT%

rem If an IDE instance is already listening, just open it; otherwise start one
rem (the server opens the browser by itself once it is up).
node -e "fetch('http://localhost:%PORT%/api/langs').then(()=>process.exit(0)).catch(()=>process.exit(1))"
if not errorlevel 1 (
  start "" "http://localhost:%PORT%"
) else (
  node server.js
)
