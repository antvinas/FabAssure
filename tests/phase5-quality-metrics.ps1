$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    & node --test tests/phase5-quality-metrics.test.mjs
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
