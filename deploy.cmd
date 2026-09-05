@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "SERVER=root@138.16.179.240"
set "MODE=update"
if "%~1"=="--first" set "MODE=first"
set "ARCHIVE=%TEMP%\telegram-bot-release-%RANDOM%-%RANDOM%.tar.gz"
set "REMOTE_ARCHIVE=/tmp/telegram-bot-release-%RANDOM%-%RANDOM%.tar.gz"

call :find_git || exit /b 1
call :check_tools || exit /b 1

echo Preparing a safe source archive...
"%GIT%" archive --format=tar.gz --output="%ARCHIVE%" HEAD
if errorlevel 1 goto :failed

echo Uploading the update to the VPS...
scp "%ARCHIVE%" %SERVER%:%REMOTE_ARCHIVE%
if errorlevel 1 goto :failed

echo Building and switching the Docker container on the VPS...
ssh %SERVER% "rm -rf /opt/telegram-bot/release-next && mkdir -p /opt/telegram-bot/release-next && tar -xzf %REMOTE_ARCHIVE% -C /opt/telegram-bot/release-next && rm -f %REMOTE_ARCHIVE% && chmod 0755 /opt/telegram-bot/release-next/deploy/remote-deploy.sh && /opt/telegram-bot/release-next/deploy/remote-deploy.sh %MODE%"
if errorlevel 1 goto :failed

del /q "%ARCHIVE%" >nul 2>&1
echo.
echo Deployment completed. The new container is healthy.
pause
exit /b 0

:check_tools
where ssh >nul 2>&1 || goto :missing_tools
where scp >nul 2>&1 || goto :missing_tools
exit /b 0

:missing_tools
echo Windows OpenSSH was not found. Install OpenSSH Client in Windows Optional Features.
pause
exit /b 1

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
del /q "%ARCHIVE%" >nul 2>&1
echo.
echo Deployment failed. Server logs above show the reason; automatic rollback was attempted.
pause
exit /b 1
