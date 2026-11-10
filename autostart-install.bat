@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODEEXE=node"
if exist "%~dp0runtime\node.exe" set "NODEEXE=%~dp0runtime\node.exe"
"%NODEEXE%" install-autostart.js
echo Selesai. Server AgentHub akan berjalan otomatis saat PC dinyalakan.
pause
