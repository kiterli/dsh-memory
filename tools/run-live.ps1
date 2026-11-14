# run-live.ps1
# Start @local/dsh-memory inside a REAL DSH web-server context and probe it over HTTP.
#
# We cannot launch the packaged Electron DSH.exe from this shell, but we CAN open the
# plugin the way DSH's webServer does: index.js only needs `ctx.webServer.register`
# (which the bundle wires). This drives apply() with a faithful webServer that listens on
# a real port, then URL-checks the routes. It is the closest live proof without the shell.
$ErrorActionPreference = 'Stop'
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
cd 'C:\Users\13264\Documents\deepseek-harness\default-workspace'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $here 'live-smoke.mjs') @args