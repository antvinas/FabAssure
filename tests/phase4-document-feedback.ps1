$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))
& node --test tests/phase4-document-feedback.test.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
