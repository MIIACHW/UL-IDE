@echo off
title UL Tech Tree IDE
cd /d "%~dp0"

rem Port selection lives exclusively in server.js (UL_IDE_PORT env var -> 8899
rem default, auto-increment while busy). This launcher NEVER guesses the port:
rem launch.mjs reuses a healthy instance found via .runtime/instance.json +
rem /api/health, otherwise it starts the server, polls /api/health and opens the
rem REAL url from the health response. To pin a port, run:
rem     set UL_IDE_PORT=9000
rem before starting (or set it permanently in your user environment).

where node >nul 2>nul
if errorlevel 1 (
  echo [UL-IDE] Node.js not found. Install it from https://nodejs.org then run again.
  pause
  exit /b 1
)

node launch.mjs
if errorlevel 1 pause
