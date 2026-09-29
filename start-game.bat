@echo off
title Little Life
cd /d "D:\proyects\little-life"
echo Starting Little Life...
echo.
echo Starting Ollama...
REM 4 parallel slots (keep in sync with LLM_PARALLEL in .env, default 4): without
REM this Ollama runs one request at a time and dialogue waits behind planning.
REM Flash attention + q8 KV cache halve the cache so 4 slots fit next to a 26B model.
set OLLAMA_NUM_PARALLEL=4
set OLLAMA_FLASH_ATTENTION=1
set OLLAMA_KV_CACHE_TYPE=q8_0
set OLLAMA_MAX_LOADED_MODELS=2
start "" /min "D:\Ollama\ollama.exe" serve
timeout /t 3 /nobreak >nul
start "" cmd /c "timeout /t 5 /nobreak >nul && start http://localhost:5173"
npm run dev
pause
