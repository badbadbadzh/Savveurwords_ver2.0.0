@echo off
cd /d "%~dp0"
start "" /b "%~dp0runtime\node.exe" "%~dp0auth-service.cjs"
"%~dp0runtime\node.exe" "%~dp0music-service.cjs" --launch
if errorlevel 1 pause
