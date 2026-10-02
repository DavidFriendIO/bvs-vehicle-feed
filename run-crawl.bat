@echo off
rem Full crawl: list, detail (up to 80 vehicle pages), build. Log: logs\crawl-YYYY-MM-DD.log
rem Double-click to run and watch. Task Scheduler passes "auto" so the window closes by itself.
setlocal
cd /d "%~dp0"
set MAX_DETAIL=80

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed or not found. Install the LTS version from https://nodejs.org then try again.
  if /i not "%~1"=="auto" pause
  exit /b 9
)

echo Crawling braintreevansales.co.uk. This takes about 30 minutes on the first run. Do not close this window.
node scripts\crawl.js
set CODE=%ERRORLEVEL%

echo.
if "%CODE%"=="0" (echo DONE: the feed was updated.) else (echo PROBLEM: see the log in the logs folder, or send it to David.)
if /i not "%~1"=="auto" pause
exit /b %CODE%
