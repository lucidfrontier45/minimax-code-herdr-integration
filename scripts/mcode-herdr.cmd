@echo off
REM mcode-herdr.cmd -- Windows shim for mcode-herdr.ps1.
REM Reports this pane's MiniMax Code agent to Herdr before mcode starts.
REM Install both this file and mcode-herdr.ps1 into a directory on PATH.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mcode-herdr.ps1" %*
exit /b %ERRORLEVEL%
