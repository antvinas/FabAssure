$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
& node --test (Join-Path $repo 'tests/phase1-bootstrap-open.test.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
