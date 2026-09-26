$ErrorActionPreference = 'Stop'
& node --test tests/phase5-incident-lifecycle.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'Phase 5 incident lifecycle focused test failed.' }
