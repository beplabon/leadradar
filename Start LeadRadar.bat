@echo off
title LeadRadar - Starting...
color 0B
echo.
echo  ==========================================
echo    LeadRadar - AI Lead Generation Tool
echo  ==========================================
echo.
echo  [*] Starting local server on port 3500...
echo  [*] Browser will open automatically.
echo.
echo  To STOP the server: close this window or press Ctrl+C
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
echo.
echo  Server stopped. Press any key to exit.
pause > nul
