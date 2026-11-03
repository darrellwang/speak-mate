@echo off
REM ============================================================
REM SpeakMate backend service restart (MUST run as Administrator)
REM
REM Usage: right-click this file -> "Run as administrator"
REM    or: in an elevated terminal:  scripts\restart-service.cmd
REM
REM NOTE: this file is intentionally ASCII-only with CRLF line endings.
REM       cmd.exe decodes .cmd by OEM code page (936/GBK on zh-CN);
REM       non-ASCII bytes cause mojibake and break line parsing.
REM ============================================================

setlocal enabledelayedexpansion

set "SVC=SpeakMate"
set "LOG=D:\Work\SpeakMate\backend\data\speakmate-service.log"
set "ENVF=D:\Work\SpeakMate\backend\.env"

echo.
echo === [1/5] Checking administrator rights ===
net session >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Not running as administrator.
    echo         Right-click this file -^> "Run as administrator".
    echo.
    pause
    exit /b 1
)
echo [OK] Administrator rights confirmed.

echo.
echo === [2/5] Checking WECHAT_APP_SECRET in .env ===
findstr /B /C:"WECHAT_APP_SECRET=." "%ENVF%" >nul 2>&1
if errorlevel 1 (
    echo [WARN] WECHAT_APP_SECRET is EMPTY.
    echo        Mini Program wx.login will fail with:
    echo        "server not configured for WeChat login".
    echo        Get it at: WeChat MP -^> Development -^> Dev Settings -^> AppSecret -^> Reset
    echo        Then paste it into: %ENVF%
) else (
    echo [OK] WECHAT_APP_SECRET is configured.
)

echo.
echo === [3/5] Stopping service ===
net stop %SVC% >nul 2>&1
timeout /t 3 /nobreak >nul
echo Stopped.

echo.
echo === [4/5] Starting service ===
net start %SVC%
if errorlevel 1 (
    echo [ERROR] Failed to start service. Check log: %LOG%
    pause
    exit /b 1
)
timeout /t 5 /nobreak >nul

echo.
echo === [5/5] Health check ===
set "AT="
for /f "tokens=1,* delims==" %%a in ('findstr /B /C:"ACCESS_TOKEN=" "%ENVF%"') do set "AT=%%b"
if "!AT!"=="" (
    echo [WARN] ACCESS_TOKEN not found in .env, skipping health check.
) else (
    curl -s -H "Authorization: Bearer !AT!" http://localhost:3001/api/health
    echo.
)

echo.
echo === Last 12 log lines ===
powershell -NoProfile -Command "Get-Content '%LOG%' -Tail 12"
echo.
pause
endlocal
