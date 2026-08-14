@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [Response Guard] Node.js was not found. Start this script on the computer running SillyTavern.
  pause
  exit /b 1
)

node response-guard-proxy.mjs
if errorlevel 1 pause
