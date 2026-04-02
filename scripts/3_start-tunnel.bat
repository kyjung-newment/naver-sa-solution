@echo off
chcp 65001 > nul
set SCRIPT_DIR=%~dp0
set CF_EXE=%SCRIPT_DIR%cloudflared.exe
set CF_CONFIG=%USERPROFILE%\.cloudflared\config.yml

echo [네이버 SA 솔루션] Cloudflare Tunnel 시작
echo  접속 주소: https://newment.co.kr/smart-sa
echo.

if not exist "%CF_EXE%" (
    echo [FAIL] cloudflared.exe 없음.
    echo 먼저 2_setup-cloudflare-tunnel.bat 을 실행하세요.
    pause
    exit /b 1
)

if not exist "%CF_CONFIG%" (
    echo [FAIL] 터널 설정 파일 없음: %CF_CONFIG%
    echo 먼저 2_setup-cloudflare-tunnel.bat 을 실행하세요.
    pause
    exit /b 1
)

echo 이 창을 닫으면 외부 접속이 끊어집니다.
echo.

"%CF_EXE%" tunnel --config "%CF_CONFIG%" run smart-sa
pause
