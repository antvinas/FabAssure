@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "FAB_ROOT=%~dp0"
if not exist "%FAB_ROOT%runtime\node.exe" (
    1>&2 echo FabAssure bundled Node runtime is missing.
    exit /b 2
)
if not exist "%FAB_ROOT%src\server\main.mjs" (
    1>&2 echo FabAssure local server entry is missing.
    exit /b 2
)
cd /d "%FAB_ROOT%"
if errorlevel 1 (
    1>&2 echo FabAssure could not open its portable folder.
    exit /b 2
)
"%FAB_ROOT%runtime\node.exe" "%FAB_ROOT%src\server\main.mjs"
set "FAB_EXIT=%ERRORLEVEL%"
endlocal & exit /b %FAB_EXIT%
