$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $root
try {
    & node --test (Join-Path $PSScriptRoot 'phase1-sql.test.mjs')
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
