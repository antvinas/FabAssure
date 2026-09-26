$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))
& node --test tests/phase4-capa-service.test.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
