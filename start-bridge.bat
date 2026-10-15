@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   Gemini Web Bridge 启动中...（排障用）
echo   保持本窗口开着；关掉窗口 = 停止桥接
echo   平时不需要跑这个：生图工具会自动拉起桥接
echo ============================================
python server.py
pause
