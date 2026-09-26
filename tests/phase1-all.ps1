$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $root
try {
    & node --test 'tests/phase1-sql.test.mjs' 'tests/phase1-bootstrap-open.test.mjs' 'tests/phase1-schema.test.mjs'
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
