@echo off
rem Crawl via your installed Google Chrome: list, detail (up to 80 vehicle pages), build.
rem   run-crawl.bat          full crawl (Chrome stays out of the way, minimised/off-screen)
rem   run-crawl.bat probe    quick test: opens Chrome visibly, loads the stock list and one vehicle
rem   run-crawl.bat show     full crawl with Chrome visible (use if a "verify you are human" box appears)
rem   run-crawl.bat auto     used by Task Scheduler (no "press any key" at the end)
rem Log: logs\crawl-YYYY-MM-DD.log
setlocal
cd /d "%~dp0"
set MAX_DETAIL=80
set MODE=%~1

where node >nul 2>&1
if errorlevel 1 goto nonode

if exist "node_modules\playwright-core\package.json" goto ready
echo First run: installing the browser-control component. This needs internet and takes about a minute.
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 goto noinstall

:ready
if /i "%MODE%"=="probe" goto probe
if /i "%MODE%"=="show" set SHOW_BROWSER=1

echo Crawling braintreevansales.co.uk in Chrome. This takes about 30 minutes on the first run. Do not close this window.
node scripts\crawl.js
set CODE=%ERRORLEVEL%
echo.
if "%CODE%"=="0" goto done
echo PROBLEM: see the newest file in the logs folder, or send it to David.
goto finish
:done
echo DONE: the feed was updated.
goto finish

:probe
echo Opening Chrome to test the site. A Chrome window will appear. If it shows a "verify you are human" box, tick it.
node scripts\probe.js
set CODE=%ERRORLEVEL%
echo.
if "%CODE%"=="0" goto probeok
echo PROBE FAILED: Chrome could not read the site. Send David the text above.
goto finish
:probeok
echo PROBE OK: Chrome can read the site and the vehicle data was found.
goto finish

:nonode
echo Node.js is not installed or not found. Install the LTS version from https://nodejs.org then try again.
set CODE=9
goto finish

:noinstall
echo Could not install the component. Check the internet connection and try again.
set CODE=8

:finish
if /i not "%MODE%"=="auto" pause
exit /b %CODE%
