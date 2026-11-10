@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODEEXE=node"
if exist "%~dp0runtime\node.exe" set "NODEEXE=%~dp0runtime\node.exe"
set PORT=
for /f "tokens=1,2 delims==" %%a in ('"%NODEEXE%" get-info.js') do set %%a=%%b
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -Unique OwningProcess | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
echo AgentHub dimatikan (port %PORT%).
pause
