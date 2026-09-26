$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $root
try {
    & node --test 'tests/phase3-local-server.test.mjs'
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
