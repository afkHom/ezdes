@echo off
rem Folder holding the production workbooks. Leave empty to only use "Choose a workbook".
set "EZDES_DATA_DIR="
set "EZDES_PORT=8777"

where py >nul 2>nul && (py -3 "%~dp0server.py" & goto :eof)
where python >nul 2>nul && (python "%~dp0server.py" & goto :eof)

echo Python 3 is required to run the EZDES server.
echo You can also open web\index.html directly to use it without the shared-folder button.
pause
