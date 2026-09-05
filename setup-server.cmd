@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "SERVER=root@138.16.179.240"
set "CONTEXT=telegram-bot-server"
set "KEY=%USERPROFILE%\.ssh\id_ed25519"
call :find_docker || exit /b 1

if not exist "%KEY%" (
  echo Creating an SSH key. Leave the passphrase empty when asked.
  ssh-keygen -t ed25519 -f "%KEY%"
  if errorlevel 1 goto :failed
)

echo.
echo The server password is needed once to install the SSH key.
type "%KEY%.pub" | ssh %SERVER% "umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys"
if errorlevel 1 goto :failed

echo.
echo Installing Docker on the server and preserving the current database...
ssh %SERVER% "sh -s" < deploy\server-bootstrap.sh
if errorlevel 1 goto :failed

"%DOCKER%" context inspect %CONTEXT% >nul 2>&1
if errorlevel 1 (
  "%DOCKER%" context create %CONTEXT% --docker "host=ssh://%SERVER%"
  if errorlevel 1 goto :failed
)

echo.
echo Building the first image while the current bot remains online...
"%DOCKER%" --context %CONTEXT% compose -p telegram-bot -f compose.remote.yaml build
if errorlevel 1 goto :failed

echo Switching from systemd to the prepared Docker container...
ssh %SERVER% "systemctl disable --now telegram-bot.service"
if errorlevel 1 goto :failed
call deploy.cmd --no-build
if errorlevel 1 (
  echo Restoring the previous systemd service...
  ssh %SERVER% "systemctl enable --now telegram-bot.service"
  exit /b 1
)
exit /b 0

:find_docker
set "DOCKER=docker"
where docker >nul 2>&1 && exit /b 0
if exist "%ProgramFiles%\Docker\Docker\resources\bin\docker.exe" (
  set "DOCKER=%ProgramFiles%\Docker\Docker\resources\bin\docker.exe"
  exit /b 0
)
if exist "%LOCALAPPDATA%\Docker\resources\bin\docker.exe" (
  set "DOCKER=%LOCALAPPDATA%\Docker\resources\bin\docker.exe"
  exit /b 0
)
echo Docker CLI was not found. Start Docker Desktop and add its resources\bin folder to PATH.
pause
exit /b 1

:failed
echo.
echo Setup failed. The existing systemd service was only disabled after the database backup.
pause
exit /b 1
