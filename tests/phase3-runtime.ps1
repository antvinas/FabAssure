$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    & node --check assets/ui/app.js
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node --test tests/phase3-runtime.test.mjs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}
