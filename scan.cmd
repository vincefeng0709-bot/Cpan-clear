@echo off
cd /d "%~dp0"
python storage_audit.py --all
if errorlevel 1 goto failed
start "" "%~dp0reports\latest.html"
exit /b 0
:failed
echo Scan failed. Please check the message above.
pause
exit /b 1
