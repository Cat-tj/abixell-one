@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "VARIANT=DEV"
set "DB_CONTAINER=abixell-dev"
set "DB_NAME=abixell_one_dev"
set "WEB_PORT=5183"
set "API_PORT=4010"
set "DB_PORT=5542"
title Abixell One %VARIANT%
cd /d "%~dp0"
if errorlevel 1 goto fail
where node >nul 2>nul
if errorlevel 1 goto fail
where npm >nul 2>nul
if errorlevel 1 goto fail
where docker >nul 2>nul
if errorlevel 1 goto fail
if not exist "apps\api\.env" (
  echo ERROR: Missing variant-specific apps\api\.env. Do not use another variant's settings.
  goto fail
)
if not exist "node_modules\.bin\tsx.cmd" (
  call npm ci --no-audit --no-fund
  if errorlevel 1 goto fail
)
rem Fail closed before Docker or database writes. Validate file AND inherited overrides.
node -e "const fs=require('node:fs'); const dotenv=require('dotenv'); const fail=m=>{console.error('ERROR: '+process.env.VARIANT+' configuration: '+m);process.exit(1)}; const blocked=e=>{for(const k of Object.keys(e)){if(k.toUpperCase()==='DOTENV_KEY'||k.toUpperCase().startsWith('DOTENV_CONFIG_'))fail('Remove dotenv override '+k+' before using this local launcher.')}}; const check=(e,label)=>{if(e.PORT!==process.env.API_PORT)fail(label+' PORT must be '+process.env.API_PORT); let u;try{u=new URL(e.DATABASE_URL)}catch{fail(label+' DATABASE_URL must be a PostgreSQL URL.')} if(!['postgres:','postgresql:'].includes(u.protocol)||!['localhost','127.0.0.1'].includes(u.hostname)||u.port!==process.env.DB_PORT||u.pathname!=='/'+process.env.DB_NAME||u.username!=='abixell'||!u.password||u.hash)fail(label+' DATABASE_URL must target abixell at localhost or 127.0.0.1:'+process.env.DB_PORT+'/'+process.env.DB_NAME+' with a password.'); for(const [k,v] of u.searchParams){if(k!=='schema'||v!=='public'||u.searchParams.getAll(k).length!==1)fail(label+' DATABASE_URL only permits the optional schema=public query.')}}; try{blocked(process.env);const file=dotenv.parse(fs.readFileSync('apps/api/.env'));blocked(file);check(file,'.env');const result=dotenv.config({path:'apps/api/.env'});if(result.error)fail('Cannot load apps/api/.env.');check(process.env,'Effective environment');console.log('Validated '+process.env.VARIANT+': API '+process.env.API_PORT+', PostgreSQL '+process.env.DB_PORT+'/'+process.env.DB_NAME);}catch{fail('Cannot validate apps/api/.env. No database setup was started.')}"
if errorlevel 1 goto fail
if /i "%~1"=="--check-only" exit /b 0
echo Starting %DB_CONTAINER% on PostgreSQL port %DB_PORT%...
call npm run db:up
if errorlevel 1 goto fail
set /a ATTEMPTS=0
:wait_db
docker exec "%DB_CONTAINER%" pg_isready -U abixell -d "%DB_NAME%" >nul 2>nul
if not errorlevel 1 goto db_ready
set /a ATTEMPTS+=1
if %ATTEMPTS% GEQ 30 goto fail
powershell -NoProfile -Command "Start-Sleep -Seconds 2"
goto wait_db
:db_ready
rem DEV database has a legacy migration-order inversion. The launcher always
rem disables order checking so it reaches seed and launches both services.
call npm run migrate -w apps/api -- --check-order false
if errorlevel 1 goto fail
call npm run seed -w apps/api
if errorlevel 1 goto fail
call npm run sync-permissions -w apps/api
if errorlevel 1 goto fail
if /i "%~1"=="--setup-only" exit /b 0
rem Stop any dev service left over from an earlier run before binding the ports.
rem Killing the port holder alone is not enough: tsx watch and Vite respawn
rem their child immediately, so the port comes straight back.
echo Stopping existing dev services...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-dev-services.ps1" -ProjectRoot "%~dp0." -Port "%API_PORT%,%WEB_PORT%"
if errorlevel 1 (
  echo ERROR: could not free ports %API_PORT% and %WEB_PORT%. Close the old API/Web windows and retry.
  goto fail
)
start "Abixell %VARIANT% API" /D "%~dp0" "%ComSpec%" /d /k npm run dev:api
start "Abixell %VARIANT% Web" /D "%~dp0" "%ComSpec%" /d /k npm run dev:web
powershell -NoProfile -Command "Start-Sleep -Seconds 5"
start "" "http://localhost:%WEB_PORT%"
echo Web: http://localhost:%WEB_PORT%  API: http://localhost:%API_PORT%
echo Login: demo-gs / admin@demo.local / admin123!
echo Keep the API and Web windows open. This is a local testing environment.
exit /b 0
:fail
echo ERROR: %VARIANT% startup failed. Check the error above and Docker Desktop.
if /i not "%~1"=="--setup-only" if /i not "%~1"=="--check-only" pause
exit /b 1
