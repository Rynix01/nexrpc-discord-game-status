@echo off
cd /d "%~dp0"
echo [NexRPC] Paketler kuruluyor...
call npm install
if errorlevel 1 (
  echo.
  echo Kurulum basarisiz. Node.js 20+ kurulu mu kontrol et.
  pause
  exit /b 1
)
echo.
echo Kurulum tamamlandi.
pause
