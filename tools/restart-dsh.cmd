@echo off
setlocal
REM Restart DSH so the rewritten dsh-memory plugin is loaded.
REM
REM Why a detached script: it is launched BY the running DSH process, so it must survive
REM that process being killed.
REM
REM Why the old process is killed by PID and never by image name: the new instance has the
REM same image name ("DSH NEXT.exe"), so `taskkill /IM "DSH NEXT.exe"` would kill the brand
REM new instance too and leave the user with no window at all.
REM
REM Usage: restart-dsh.cmd <oldMainProcessId>

set "OLD_PID=%~1"
set "EXE=D:\DSH-Herness\DSH NEXT\DSH NEXT.exe"
set "LOG=%~dp0dsh-restart.log"

echo [%date% %time%] restart requested, old pid=%OLD_PID% > "%LOG%"

if "%OLD_PID%"=="" (
  echo [%date% %time%] ERROR: no pid given, aborting >> "%LOG%"
  goto :eof
)

timeout /t 2 /nobreak >nul

echo [%date% %time%] closing old instance >> "%LOG%"
taskkill /PID %OLD_PID% /T /F >nul 2>&1

timeout /t 3 /nobreak >nul

echo [%date% %time%] launching new instance >> "%LOG%"
start "" "%EXE%"

echo [%date% %time%] done >> "%LOG%"
endlocal
