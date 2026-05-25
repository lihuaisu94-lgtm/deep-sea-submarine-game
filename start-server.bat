@echo off
chcp 65001 >nul
title 深海幽灵 - 公网服务器

echo.
echo   ╔══════════════════════════════════╗
echo   ║       深海幽灵 临时服务器       ║
echo   ╚══════════════════════════════════╝
echo.
echo   [1/2] 启动本地静态服务...
start /b npx serve -l 3000 -s . >nul 2>&1

echo   [2/2] 启动公网隧道...
echo.
echo   等待生成公网 URL...
echo.

npx localtunnel --port 3000

echo.
echo   隧道已关闭，按任意键退出...
pause >nul
