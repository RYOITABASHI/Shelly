@echo off
REM Maestro E2E Test Runner for Shelly
REM Usage: run-test.bat [test_name]
REM Example: run-test.bat chat
REM         run-test.bat all

setlocal

set MAESTRO_BIN=C:\Users\ryoxr\maestro\maestro\bin\maestro.bat
set TEST_DIR=C:\Users\ryoxr\Shelly\.maestro

if "%1"=="" (
    echo Usage: run-test.bat [test_name]
    echo.
    echo Available tests:
    echo   setup     - Setup wizard test
    echo   chat      - Chat tab test
    echo   terminal  - Terminal tab test
    echo   settings  - Settings tab test
    echo   bridge    - Bridge recovery test
    echo   all       - Run all tests
    exit /b 1
)

if "%1"=="setup" (
    echo Running Setup Wizard test...
    echo WARNING: This will clear app data!
    adb shell pm clear space.manus.shelly.terminal.t20260224103125
    "%MAESTRO_BIN%" test "%TEST_DIR%\01_setup_wizard_ja.yaml"
    exit /b %ERRORLEVEL%
)

if "%1"=="chat" (
    echo Running Chat tab test...
    "%MAESTRO_BIN%" test "%TEST_DIR%\02_chat_tab_ja.yaml"
    exit /b %ERRORLEVEL%
)

if "%1"=="terminal" (
    echo Running Terminal tab test...
    "%MAESTRO_BIN%" test "%TEST_DIR%\03_terminal_tab_ja.yaml"
    exit /b %ERRORLEVEL%
)

if "%1"=="settings" (
    echo Running Settings tab test...
    "%MAESTRO_BIN%" test "%TEST_DIR%\04_settings_tab_ja.yaml"
    exit /b %ERRORLEVEL%
)

if "%1"=="bridge" (
    echo Running Bridge recovery test...
    "%MAESTRO_BIN%" test "%TEST_DIR%\05_bridge_recovery_ja.yaml"
    exit /b %ERRORLEVEL%
)

if "%1"=="all" (
    echo Running all Japanese tests...
    "%MAESTRO_BIN%" test "%TEST_DIR%\02_chat_tab_ja.yaml"
    "%MAESTRO_BIN%" test "%TEST_DIR%\03_terminal_tab_ja.yaml"
    "%MAESTRO_BIN%" test "%TEST_DIR%\04_settings_tab_ja.yaml"
    "%MAESTRO_BIN%" test "%TEST_DIR%\05_bridge_recovery_ja.yaml"
    exit /b %ERRORLEVEL%
)

echo Unknown test: %1
exit /b 1
