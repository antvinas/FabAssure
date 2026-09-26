$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
& node --test 'tests/phase4-capa-migration.test.mjs' 'tests/phase4-capa-schema.test.mjs' 'tests/phase1-bootstrap-open.test.mjs' 'tests/phase1-schema.test.mjs' 'tests/phase2-migration.test.mjs' 'tests/phase4-schema.test.mjs'
exit $LASTEXITCODE
