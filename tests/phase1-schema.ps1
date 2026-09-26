$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$test = Join-Path $PSScriptRoot 'phase1-schema.test.mjs'
Push-Location $root
try {
    & node --test $test
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
