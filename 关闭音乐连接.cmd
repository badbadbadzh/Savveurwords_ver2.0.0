@echo off
cd /d "%~dp0"
"%~dp0runtime\node.exe" "%~dp0music-service.cjs" --stop
if errorlevel 1 pause
