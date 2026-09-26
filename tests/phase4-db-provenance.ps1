$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))
# Service-emitted proposal, R2 and unknown-start cases run in the linked incident-service packet.
& node --test --test-name-pattern '^(direct SQL LKG observation|an LKG audit without|LKG observation and audit require|reviewed incident state requires|incident creation time|a forged creation|creation audit|a source-consistent direct trace)' tests/phase4-incident-service.test.mjs
exit $LASTEXITCODE
