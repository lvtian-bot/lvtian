@echo off
echo Starting Lvtian Personal Assistant Server on Windows...
cd /d "%~dp0\.."

echo Compiling TypeScript server...
call npx tsc
if errorlevel 1 (
    echo TypeScript compilation failed!
    exit /b 1
)

node dist/index.js
pause
