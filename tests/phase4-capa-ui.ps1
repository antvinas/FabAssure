$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))
& node --check assets/ui/app.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node --test tests/phase4-capa-ui.test.mjs
exit $LASTEXITCODE
