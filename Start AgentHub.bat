@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ===== Node: pakai runtime bawaan (portable) bila ada =====
set "NODEEXE=node"
if exist "%~dp0runtime\node.exe" set "NODEEXE=%~dp0runtime\node.exe"

rem ===== Ambil port & URL dari config =====
set PORT=
set URL=
for /f "tokens=1,2 delims==" %%a in ('"%NODEEXE%" get-info.js') do set %%a=%%b

rem ===== Jalankan server bila belum berjalan =====
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul 2>&1
if %errorlevel%==0 goto open

echo Menjalankan server AgentHub...
start "AgentHub" /min cmd /c """%NODEEXE%" "%~dp0server.js"""
timeout /t 2 /nobreak >nul
for /f "tokens=1,2 delims==" %%a in ('"%NODEEXE%" get-info.js') do set %%a=%%b

:open
echo Membuka jendela AgentHub...
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app=%URL%
) else if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" --app=%URL%
) else (
  start "" %URL%
)
exit /b 0
