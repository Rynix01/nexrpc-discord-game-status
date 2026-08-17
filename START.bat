@echo off
cd /d "%~dp0"
if not exist "node_modules\electron" (
  echo [NexRPC] Ilk calistirma: paketler kuruluyor...
  call npm install
  if errorlevel 1 pause & exit /b 1
)
call npm start
