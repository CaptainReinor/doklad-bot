@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "CONTEXT=telegram-bot-server"
set "COMPOSE=compose.remote.yaml"
set "UP_ARGS=up -d --build --remove-orphans"
if "%~1"=="--no-build" set "UP_ARGS=up -d --no-build --remove-orphans"
call :find_docker || exit /b 1

"%DOCKER%" context inspect %CONTEXT% >nul 2>&1
if errorlevel 1 (
  echo First run setup-server.cmd once.
  pause
  exit /b 1
)

echo Saving the currently running image for automatic rollback...
"%DOCKER%" --context %CONTEXT% image inspect telegram-bot-local:latest >nul 2>&1
if not errorlevel 1 "%DOCKER%" --context %CONTEXT% image tag telegram-bot-local:latest telegram-bot-local:rollback

echo Building and deploying on the VPS...
"%DOCKER%" --context %CONTEXT% compose -p telegram-bot -f "%COMPOSE%" %UP_ARGS%
if errorlevel 1 goto :failed

set "STATUS=starting"
for /L %%I in (1,1,40) do (
  for /F "usebackq delims=" %%S in (`"%DOCKER%" --context %CONTEXT% inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" telegram-bot 2^>nul`) do set "STATUS=%%S"
  if "!STATUS!"=="healthy" goto :success
  if "!STATUS!"=="unhealthy" goto :rollback
  timeout /t 2 /nobreak >nul
)

:rollback
echo New container is not healthy. Showing its logs and restoring the previous image...
"%DOCKER%" --context %CONTEXT% logs --tail 80 telegram-bot
"%DOCKER%" --context %CONTEXT% image inspect telegram-bot-local:rollback >nul 2>&1
if errorlevel 1 goto :failed
"%DOCKER%" --context %CONTEXT% rm -f telegram-bot >nul 2>&1
"%DOCKER%" --context %CONTEXT% image tag telegram-bot-local:rollback telegram-bot-local:latest
"%DOCKER%" --context %CONTEXT% compose -p telegram-bot -f "%COMPOSE%" up -d --no-build
echo Previous version restored.
pause
exit /b 1

:success
echo.
echo Deployment completed. Container status: healthy.
"%DOCKER%" --context %CONTEXT% compose -p telegram-bot -f "%COMPOSE%" ps
pause
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
echo Deployment failed before health verification. The current container state was not removed automatically.
pause
exit /b 1
