@echo off
echo Starting Lvtian Personal Assistant Server on Windows...
cd /d "%~dp0\.."

echo Compiling TypeScript server...
call npx tsc

node dist/index.js
pause
