$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $root
try {
    & node --test 'tests/phase2-domain-sql.test.mjs' 'tests/phase2-change-acceptance.test.mjs'
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
