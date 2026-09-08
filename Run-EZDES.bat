@echo off
set "EZDES_PORT=8777"
set "EZDES_OPEN_BROWSER=1"
where py >nul 2>nul
if not errorlevel 1 (
  py -3 "%~dp0ezdes_server.py"
  goto :eof
)
where python >nul 2>nul
if not errorlevel 1 (
  python "%~dp0ezdes_server.py"
  goto :eof
)
echo Python 3 is required to run EZDES locally.
echo Install Python 3, then run this file again.
pause