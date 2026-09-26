$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $root
try {
    & node --test 'tests/phase2-baseline.test.mjs'
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
