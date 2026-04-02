@echo off
chcp 65001 > nul

echo ============================================
echo  Naver SA Solution - Setup
echo ============================================
echo.

:: 1. Firewall
echo [1/3] Opening firewall port 3000...
netsh advfirewall firewall delete rule name="Naver SA Solution" >nul 2>&1
netsh advfirewall firewall add rule name="Naver SA Solution" dir=in action=allow protocol=TCP localport=3000
echo.

:: 2. Node.js 서버 자동시작 등록
echo [2/3] Registering server auto-start task...
schtasks /delete /tn "NaverSA-Server" /f >nul 2>&1
schtasks /create /tn "NaverSA-Server" /tr "\"C:\Program Files\nodejs\node.exe\" \"C:\Users\admin\Desktop\naver-sa-solution\src\index.js\"" /sc onstart /ru SYSTEM /rl HIGHEST /f
echo.

:: 3. Cloudflare Tunnel 자동시작 등록
echo [3/3] Registering Cloudflare Tunnel auto-start task...
set CF_EXE=%~dp0cloudflared.exe
set CF_CONFIG=%USERPROFILE%\.cloudflared\config.yml
schtasks /delete /tn "NaverSA-Tunnel" /f >nul 2>&1
schtasks /create /tn "NaverSA-Tunnel" /tr "\"%CF_EXE%\" tunnel --config \"%CF_CONFIG%\" run smart-sa" /sc onstart /ru SYSTEM /rl HIGHEST /f /delay 0000:30
echo.

if %errorlevel%==0 (
    echo ============================================
    echo  Setup Complete!
    echo ============================================
    echo.
    echo  - Firewall: port 3000 open
    echo  - Server auto-start: enabled (runs on boot)
    echo  - Tunnel auto-start: enabled (30s delay after boot)
    echo.
    echo  직원 접속 주소:
    echo     https://newment.co.kr/smart-sa
    echo.
    echo  지금 바로 시작하려면:
    echo    1. start-server.bat  (서버 시작)
    echo    2. 3_start-tunnel.bat (터널 시작)
    echo ============================================
) else (
    echo [FAIL] 관리자 권한으로 실행하세요.
    echo   파일 우클릭 ^> 관리자 권한으로 실행
)

echo.
pause
