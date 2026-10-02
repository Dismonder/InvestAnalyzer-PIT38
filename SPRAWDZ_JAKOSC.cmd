@echo off
rem Uruchamia komplet bramek jakosci: lint, testy, build, wydajnosc, smoke,
rem kontrole wycofanych integracji i danych osobowych.
cd /d "%~dp0"
call npm run verify
echo.
if errorlevel 1 (echo Bramki jakosci NIE przeszly.) else (echo Wszystkie bramki jakosci przeszly.)
pause
exit /b %errorlevel%
