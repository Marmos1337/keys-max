@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Установите Node.js 22.16+ или 24 LTS, затем запустите этот файл повторно.
  echo https://nodejs.org/en/download
  pause
  exit /b 1
)
node scripts/setup.mjs
if errorlevel 1 (pause & exit /b 1)
echo Откройте http://localhost:3000 после сообщения о запуске сервера.
node --env-file-if-exists=.env server/index.mjs
pause
