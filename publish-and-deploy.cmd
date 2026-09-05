@echo off
setlocal EnableExtensions
cd /d "%~dp0"

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo Git repository is not configured yet.
  pause
  exit /b 1
)

set /p "MESSAGE=Describe the update for Git: "
if not defined MESSAGE set "MESSAGE=Update bot"

git add -A
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "%MESSAGE%"
  if errorlevel 1 goto :failed
)
git push
if errorlevel 1 goto :failed

call deploy.cmd
exit /b %errorlevel%

:failed
echo Git publication failed; deployment was not started.
pause
exit /b 1
