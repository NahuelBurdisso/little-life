@echo off
title Little Life
cd /d "D:\proyects\little-life"
echo Starting Little Life...
echo.
echo Starting Ollama...
start "" /min "D:\Ollama\ollama.exe" serve
timeout /t 3 /nobreak >nul
start "" cmd /c "timeout /t 5 /nobreak >nul && start http://localhost:5173"
npm run dev
pause
