@echo off
title VTN Anti-Browser Antidetect Manager (Chromium 151)
cd /d "%~dp0"
echo ========================================================
echo   VTN Anti-Browser Native Antidetect Manager (Chromium 151)
echo ========================================================
echo Starting VTN Anti-Browser Server and Desktop UI Window...
echo.

node src\main.js --app-window
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] VTN Anti-Browser encountered a fatal error (Exit code: %ERRORLEVEL%).
    echo Please review the error message above before closing this window.
    pause
)
