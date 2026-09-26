$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
& node --test 'tests/phase4-capa-schema.test.mjs'
exit $LASTEXITCODE
