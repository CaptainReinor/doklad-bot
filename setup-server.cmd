@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "SERVER=root@138.16.179.240"
set "KEY=%USERPROFILE%\.ssh\id_ed25519"
call :check_tools || exit /b 1

if not exist "%KEY%" (
  echo Creating an SSH key. Press Enter twice to leave the passphrase empty.
  ssh-keygen -t ed25519 -f "%KEY%"
  if errorlevel 1 goto :failed
)

echo.
echo The VPS password is needed once to install the SSH key.
type "%KEY%.pub" | ssh %SERVER% "umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys"
if errorlevel 1 goto :failed

echo.
echo Installing Docker on the VPS and preserving the current database...
scp deploy\server-bootstrap.sh %SERVER%:/tmp/telegram-bot-server-bootstrap.sh
if errorlevel 1 goto :failed
ssh %SERVER% "sh /tmp/telegram-bot-server-bootstrap.sh; rm -f /tmp/telegram-bot-server-bootstrap.sh"
if errorlevel 1 goto :failed

echo.
echo Sending and starting the first container. Docker Desktop is not required.
call deploy.cmd --first
if errorlevel 1 goto :failed
exit /b 0

:check_tools
where ssh >nul 2>&1 || goto :missing_tools
where scp >nul 2>&1 || goto :missing_tools
exit /b 0

:missing_tools
echo Windows OpenSSH was not found. Install OpenSSH Client in Windows Optional Features.
pause
exit /b 1

:failed
echo.
echo Setup failed. If the new container did not become healthy, the previous service was restored.
pause
exit /b 1
