@echo off
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
python app.py
if errorlevel 1 pause
