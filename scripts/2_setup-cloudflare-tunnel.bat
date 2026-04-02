@echo off
chcp 65001 > nul
setlocal
set SCRIPT_DIR=%~dp0
set CF_EXE=%SCRIPT_DIR%cloudflared.exe
set CF_CONFIG=%USERPROFILE%\.cloudflared\config.yml

echo [네이버 SA 솔루션] Cloudflare Tunnel 설정
echo ============================================
echo  목표 주소: https://newment.co.kr/smart-sa
echo ============================================
echo.

:: cloudflared.exe 다운로드 여부 확인
if not exist "%CF_EXE%" (
    echo cloudflared.exe 를 다운로드합니다...
    powershell -Command "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '%CF_EXE%'"
    if not exist "%CF_EXE%" (
        echo [FAIL] 다운로드 실패. 인터넷 연결을 확인하세요.
        pause
        exit /b 1
    )
    echo [OK] 다운로드 완료
    echo.
)

:: Cloudflare 로그인
echo [1단계] Cloudflare 계정 로그인
echo 브라우저가 열리면 Cloudflare 계정으로 로그인 후 승인해주세요.
echo (계정 없으면 cloudflare.com 에서 무료 가입)
echo.
"%CF_EXE%" tunnel login
if errorlevel 1 (
    echo [FAIL] 로그인 실패.
    pause
    exit /b 1
)
echo.

:: 터널 생성
echo [2단계] 터널 생성 (이름: smart-sa)
"%CF_EXE%" tunnel create smart-sa
echo.

:: 터널 ID 파싱
echo [3단계] 터널 설정 파일 생성
if not exist "%USERPROFILE%\.cloudflared" mkdir "%USERPROFILE%\.cloudflared"

:: 터널 JSON 파일에서 ID 추출
for /f "delims=" %%f in ('dir /b "%USERPROFILE%\.cloudflared\*.json" 2^>nul') do (
    set CF_JSON=%%~nf
)
if "%CF_JSON%"=="" (
    echo [FAIL] 터널 인증 파일을 찾을 수 없습니다.
    echo %USERPROFILE%\.cloudflared\ 폴더를 확인하세요.
    pause
    exit /b 1
)

echo tunnel: %CF_JSON%> "%CF_CONFIG%"
echo credentials-file: %USERPROFILE%\.cloudflared\%CF_JSON%.json>> "%CF_CONFIG%"
echo.>> "%CF_CONFIG%"
echo ingress:>> "%CF_CONFIG%"
echo   - hostname: newment.co.kr>> "%CF_CONFIG%"
echo     path: /smart-sa>> "%CF_CONFIG%"
echo     service: http://localhost:3000>> "%CF_CONFIG%"
echo   - service: http_status:404>> "%CF_CONFIG%"

echo [OK] 설정 파일 생성: %CF_CONFIG%
echo.

:: DNS 자동 등록
echo [4단계] DNS CNAME 자동 등록 (newment.co.kr)
"%CF_EXE%" tunnel route dns smart-sa newment.co.kr
echo.

echo ============================================
echo  설정 완료!
echo ============================================
echo.
echo  다음 단계:
echo  1. setup-autostart.bat 을 관리자 권한으로 실행
echo     (서버 자동시작 등록)
echo  2. 3_start-tunnel.bat 실행 (터널 시작)
echo.
echo  직원 접속 주소:
echo     https://newment.co.kr/smart-sa
echo.
echo  [주의] newment.co.kr 이 Cloudflare에 등록된
echo  도메인이어야 DNS 자동 등록이 됩니다.
echo ============================================
echo.
pause
