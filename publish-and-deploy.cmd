@echo off
setlocal EnableExtensions
cd /d "%~dp0"

call :find_git || exit /b 1

"%GIT%" rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo Git repository is not configured yet.
  pause
  exit /b 1
)

set /p "MESSAGE=Describe the update for Git: "
if not defined MESSAGE set "MESSAGE=Update bot"

"%GIT%" add -A
"%GIT%" diff --cached --quiet
if errorlevel 1 (
  "%GIT%" commit -m "%MESSAGE%"
  if errorlevel 1 goto :failed
)
"%GIT%" push
if errorlevel 1 goto :failed

call deploy.cmd
exit /b %errorlevel%

:find_git
set "GIT=git"
where git >nul 2>&1 && exit /b 0
if exist "%ProgramFiles%\Git\cmd\git.exe" (
  set "GIT=%ProgramFiles%\Git\cmd\git.exe"
  exit /b 0
)
for /D %%D in ("%LOCALAPPDATA%\GitHubDesktop\app-*") do (
  if exist "%%~fD\resources\app\git\cmd\git.exe" (
    set "GIT=%%~fD\resources\app\git\cmd\git.exe"
    exit /b 0
  )
)
echo Git was not found. Install Git for Windows or GitHub Desktop once.
pause
exit /b 1

:failed
echo Git publication failed; deployment was not started.
pause
exit /b 1
