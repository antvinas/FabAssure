$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
& node --test 'tests/phase4-sql-digest.test.mjs'
exit $LASTEXITCODE
