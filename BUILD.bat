@echo off
cd /d "%~dp0"
if not exist "node_modules\electron" (
  echo [NexRPC] Paketler kuruluyor...
  call npm install
  if errorlevel 1 pause & exit /b 1
)
echo [NexRPC] Windows build aliniyor...
call npm run dist:win
if errorlevel 1 (
  echo Build basarisiz.
  pause
  exit /b 1
)
echo.
echo Build tamamlandi. dist klasorune bak.
pause
