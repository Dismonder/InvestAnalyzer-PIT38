@echo off
rem Buduje aplikacje desktop wraz z sidecarem Pythona i pakuje wersje przenosna.
rem Wynik: wydania\komputerowa\przenosna\najnowsza\InvestAnalyzer.exe
cd /d "%~dp0"
call npm run desktop:portable
if errorlevel 1 (
  echo.
  echo Build nie powiodl sie. Sprawdz komunikaty powyzej.
  pause
  exit /b 1
)
echo.
echo Gotowe. Paczka przenosna: wydania\komputerowa\przenosna\najnowsza
pause
exit /b 0
