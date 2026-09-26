$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))
& node --check assets/ui/app.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node --test tests/phase4-http.test.mjs tests/phase3-runtime.test.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
