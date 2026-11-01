@echo off
rem ---------------------------------------------------------------------------
rem Voxelight Launcher - build entry point that always works.
rem
rem Why this exists: Windows PowerShell refuses to run an unsigned .ps1 when the
rem file carries a Low integrity label (it treats such files as untrusted and
rem demands a signature - no execution policy except Bypass gets around it).
rem This project tree inherited Low integrity labels from a sandboxed run, so
rem `scripts\build.ps1` can fail with "is not digitally signed" in a plain
rem shell. Calling it through this wrapper with -ExecutionPolicy Bypass (process
rem scope only, nothing is changed system-wide) sidesteps that.
rem
rem Usage:  build.cmd                 full build (exe + NSIS installer)
rem         build.cmd -NoBundle       executable only
rem         build.cmd -CloseRunning   stop a running launcher first
rem         build.cmd -Clean          discard dist\ and old bundles first
rem Any argument is passed straight through to build.ps1.
rem ---------------------------------------------------------------------------
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
exit /b %ERRORLEVEL%
