$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))
& node --test tests/phase4-scenario-b.test.mjs
exit $LASTEXITCODE
