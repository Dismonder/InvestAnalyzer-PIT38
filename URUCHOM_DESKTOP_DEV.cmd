@echo off
rem Uruchamia wersje desktop w trybie deweloperskim (Tauri + silnik ze zrodel).
cd /d "%~dp0"
call npm run desktop:dev
exit /b %errorlevel%
