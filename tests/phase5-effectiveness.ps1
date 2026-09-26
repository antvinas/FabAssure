$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    & node --test tests/phase5-effectiveness.test.mjs
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
