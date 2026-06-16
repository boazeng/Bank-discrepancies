@echo off
chcp 65001 > nul
echo ========================================
echo  התקנת Bank Discrepancies
echo ========================================

set "DIR=%~dp0"

:: Check Python
python --version > nul 2>&1
if errorlevel 1 (
    echo שגיאה: Python לא מותקן. הורד מ- https://python.org
    pause & exit /b 1
)

:: Create venv
if not exist "%DIR%.venv\Scripts\python.exe" (
    echo יוצר סביבת Python...
    python -m venv "%DIR%.venv"
    if errorlevel 1 ( echo שגיאה & pause & exit /b 1 )
)

:: Install Python packages
echo מתקין תלויות Python...
"%DIR%.venv\Scripts\pip" install -r "%DIR%requirements.txt" -q
if errorlevel 1 ( echo שגיאה & pause & exit /b 1 )

:: Create .env if missing
if not exist "%DIR%.env" (
    copy "%DIR%.env.example" "%DIR%.env" > nul
    echo.
    echo *** יש למלא פרטי Priority ב-.env ***
    notepad "%DIR%.env"
)

echo.
echo ========================================
echo  התקנה הושלמה! הרץ start.bat להפעלה.
echo ========================================
pause
