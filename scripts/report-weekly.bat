@echo off
chcp 65001 > nul
set NODE="C:\Program Files\nodejs\node.exe"
set PROJECT=C:\Users\admin\Desktop\naver-sa-solution

cd /d %PROJECT%
%NODE% src/scheduler/run.js weekly
