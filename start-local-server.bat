@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo  Asset Tracking - Local Server
echo ============================================================
echo.
echo Starting a local server so the app can load properly.
echo Your browser should open automatically in a few seconds.
echo.
echo Leave THIS WINDOW OPEN while you use the app.
echo To stop the server, just close this window (or press Ctrl+C).
echo.

where node >nul 2>nul
if %errorlevel%==0 (
    start "" cmd /c "timeout /t 2 >nul & start http://localhost:5500/dashboard.html"
    npx --yes serve -l 5500 .
    goto :end
)

where python >nul 2>nul
if %errorlevel%==0 (
    start "" cmd /c "timeout /t 2 >nul & start http://localhost:5500/dashboard.html"
    python -m http.server 5500
    goto :end
)

where py >nul 2>nul
if %errorlevel%==0 (
    start "" cmd /c "timeout /t 2 >nul & start http://localhost:5500/dashboard.html"
    py -m http.server 5500
    goto :end
)

echo This computer doesn't seem to have Node.js or Python installed,
echo and one of those is needed to run the local server.
echo.
echo Please install ONE of the following, then double-click this
echo file again:
echo.
echo   Node.js  -  https://nodejs.org
echo   Python   -  https://www.python.org/downloads/
echo     (when installing Python, tick "Add python.exe to PATH")
echo.
pause

:end
