@echo off
setlocal
cd /d "%~dp0"
title TideCast
echo.
echo  TideCast for Windows
echo  First run: sets everything up (a few minutes). After that it starts right away.
echo.

rem --- 1. Python 3.11 or 3.12 (the length model's packages need one of them) ---
set "PY="
set "NOMODEL="
py -3.12 --version >nul 2>&1
if not errorlevel 1 set "PY=py -3.12"
if not defined PY (
  py -3.11 --version >nul 2>&1
  if not errorlevel 1 set "PY=py -3.11"
)
if not defined PY (
  echo Python 3.11/3.12 not found. Installing Python 3.12 with winget ^(one time^)...
  winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
  py -3.12 --version >nul 2>&1
  if not errorlevel 1 set "PY=py -3.12"
)
if not defined PY (
  echo.
  echo Could not find or install Python 3.12. The site will start without the length model.
  echo To add it later: install Python 3.12 from https://www.python.org/downloads/ and run this file again.
  set "NOMODEL=1"
)

rem --- 2. A private environment in a short folder (avoids Windows long-path errors) ---
set "VENV=%LOCALAPPDATA%\TideCast\venv"
if not defined NOMODEL if not exist "%VENV%\Scripts\python.exe" (
  echo Creating the Python environment ^(one time^)...
  %PY% -m venv "%VENV%"
)
if not defined NOMODEL if not exist "%VENV%\Scripts\python.exe" (
  echo Could not create the environment. The site will start without the length model.
  set "NOMODEL=1"
)

rem --- 3. The length model's packages (one time) ---
if not defined NOMODEL if not exist "%VENV%\.ready" (
  echo Installing the length model packages ^(one time, a few minutes^)...
  "%VENV%\Scripts\python.exe" -m pip install --upgrade pip
  "%VENV%\Scripts\python.exe" -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
  if not errorlevel 1 "%VENV%\Scripts\python.exe" -m pip install -r Catch\requirements-model.txt
  if not errorlevel 1 echo ok> "%VENV%\.ready"
)
if not defined NOMODEL if not exist "%VENV%\.ready" (
  echo.
  echo The length model could not be installed. The site still works with the knuckle method.
  echo Check your internet connection and run this file again to retry.
)

rem --- 4. Start the site ---
echo.
echo Starting TideCast. Leave this window open; press Ctrl+C to stop.
echo The first time, the length model also downloads its weights (a few GB) in the background.
echo Until it says "Length model: ready" in this window, catches use the knuckle method.
echo.
if defined NOMODEL (
  python FishMigration\server.py
) else (
  "%VENV%\Scripts\python.exe" FishMigration\server.py
)
pause