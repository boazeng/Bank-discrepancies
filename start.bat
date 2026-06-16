@echo off
chcp 65001 > nul
set "DIR=%~dp0"

if not exist "%DIR%.venv\Scripts\python.exe" (
    echo טרם בוצעה התקנה. הרץ install.bat קודם.
    pause & exit /b 1
)

echo פותח: http://localhost:5000/
start "" "http://localhost:5000/"
"%DIR%.venv\Scripts\python.exe" "%DIR%backend\server.py"
