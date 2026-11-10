@echo off
chcp 65001 >nul
set VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\agenthub-server.vbs
if exist "%VBS%" (del "%VBS%" & echo Autostart dimatikan.) else (echo Autostart tidak ditemukan.)
pause
