@echo off
rem Uruchamia zbudowana wersje przenosna aplikacji.
cd /d "%~dp0"
set "APP=wydania\komputerowa\przenosna\najnowsza\InvestAnalyzer.exe"
if not exist "%APP%" (
  echo Nie znaleziono zbudowanej aplikacji:
  echo   %APP%
  echo.
  echo Uruchom najpierw ZBUDUJ_DESKTOP.cmd
  pause
  exit /b 1
)
start "" "%APP%"
exit /b 0
