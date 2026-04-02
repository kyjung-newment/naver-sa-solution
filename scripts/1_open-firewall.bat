@echo off
chcp 65001 > nul
echo Opening firewall port 3000 for Naver SA Solution...
netsh advfirewall firewall delete rule name="Naver SA Solution" >nul 2>&1
netsh advfirewall firewall add rule name="Naver SA Solution" dir=in action=allow protocol=TCP localport=3000
if %errorlevel%==0 (
    echo [OK] Firewall rule added. LAN access: http://192.168.0.42:3000
) else (
    echo [FAIL] Run this file as Administrator (right-click -> Run as administrator)
)
pause
