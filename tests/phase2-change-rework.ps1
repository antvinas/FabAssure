$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $root
try {
    & node --test 'tests/phase2-change-rework.test.mjs'
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
