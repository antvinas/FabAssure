$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))
& node --test tests/phase4-schema.test.mjs tests/phase4-incident-service.test.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
