@echo off
chcp 65001 > nul
set "DIR=%~dp0"

echo פותח: http://localhost:5000/
start "" "http://localhost:5000/"

if exist "%DIR%.venv\Scripts\python.exe" (
    "%DIR%.venv\Scripts\python.exe" "%DIR%backend\server.py"
) else (
    python "%DIR%backend\server.py"
)
