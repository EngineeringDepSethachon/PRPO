@echo off
REM ===========================================================
REM  Reset password of a PRPO user on PRODUCTION D1 (prpo-db)
REM  Usage : double-click  -> resets user "admin"
REM          reset-admin-password.bat <username>  -> resets that user
REM  Needs : Node 22+, wrangler logged in (npx wrangler whoami)
REM  Writes only a PBKDF2 hash. Sets mustChangePassword=1 and
REM  invalidates old tokens. The temporary .sql is deleted after use.
REM ===========================================================
setlocal
cd /d "%~dp0"

set "TARGET_USER=%~1"
if "%TARGET_USER%"=="" set "TARGET_USER=admin"
set "SQLFILE=%USERPROFILE%\prpo-backups\set-pw-%TARGET_USER%.sql"

if not exist "%USERPROFILE%\prpo-backups" mkdir "%USERPROFILE%\prpo-backups"

echo.
echo === PRPO reset password : user "%TARGET_USER%" (production prpo-db) ===
echo Type the new temporary password twice (characters are hidden).
echo Rules: 6-256 chars, not 123456 / password123 / admin123, no leading/trailing spaces.
echo.

node scripts\set-user-password.js --username %TARGET_USER% --out "%SQLFILE%" --force
if errorlevel 1 (
  echo.
  echo [FAILED] could not create the SQL file. Nothing was changed.
  goto :end
)

echo.
echo Applying to remote D1 prpo-db ...
call npx wrangler d1 execute prpo-db --remote --yes --file="%SQLFILE%"
set "RC=%errorlevel%"

if exist "%SQLFILE%" del /f /q "%SQLFILE%"

echo.
if "%RC%"=="0" (
  echo [OK] password of "%TARGET_USER%" was reset.
  echo      Log in at https://prpo-pdqc.pages.dev with the temporary password.
  echo      The system will force a new password on first login.
) else (
  echo [FAILED] wrangler returned %RC%. Check that you are logged in: npx wrangler whoami
)

:end
echo.
pause
endlocal
