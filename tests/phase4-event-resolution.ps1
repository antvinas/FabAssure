$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
& node --test 'tests/phase4-event-resolution.test.mjs'
exit $LASTEXITCODE
