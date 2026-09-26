param(
    [Parameter(Mandatory=$true)][string]$NodeArchive,
    [string]$OutputDirectory = ''
)
$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $repoRoot 'dist/FabAssure'
}
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'dist'))
if ($output.StartsWith($repoRoot + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and
    -not $output.StartsWith($distRoot + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'A package inside the project must be placed under dist/.'
}
if (Test-Path -LiteralPath $output) {
    throw "Package output already exists: $output"
}
if ($output.StartsWith($distRoot + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    $ancestor = Split-Path -Parent $output
    while ($ancestor.StartsWith($distRoot + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $ancestor.Equals($distRoot, [StringComparison]::OrdinalIgnoreCase)) {
        if (Test-Path -LiteralPath $ancestor) {
            $attributes = (Get-Item -LiteralPath $ancestor -Force).Attributes
            if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Package output path crosses a junction or symbolic link: $ancestor"
            }
        }
        $ancestor = Split-Path -Parent $ancestor
    }
}

function Get-Sha256([string]$Path) {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        return [System.BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
        $stream.Dispose()
        $algorithm.Dispose()
    }
}

# Pinned to the official Node.js 24.19.0 Windows x64 SHASUMS256.txt release entry.
$expectedArchiveHash = '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73'
$archiveFile = (Resolve-Path -LiteralPath $NodeArchive).Path
$actualArchiveHash = Get-Sha256 $archiveFile
if ($actualArchiveHash -cne $expectedArchiveHash) {
    throw "Node archive SHA256 mismatch: $actualArchiveHash"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($archiveFile)
try {
    $releaseRoot = 'node-v24.19.0-win-x64/'
    $nodeEntry = $archive.GetEntry($releaseRoot + 'node.exe')
    $licenseEntry = $archive.GetEntry($releaseRoot + 'LICENSE')
    if ($null -eq $nodeEntry -or $null -eq $licenseEntry) {
        throw 'Pinned Node archive lacks node.exe or LICENSE.'
    }

    New-Item -ItemType Directory -Path $output -ErrorAction Stop | Out-Null
    $runtimeDir = Join-Path $output 'runtime'
    New-Item -ItemType Directory -Path $runtimeDir -ErrorAction Stop | Out-Null
    foreach ($pair in @(@($nodeEntry, 'node.exe'), @($licenseEntry, 'LICENSE'))) {
        $destination = Join-Path $runtimeDir $pair[1]
        $inputStream = $pair[0].Open()
        $outputStream = [System.IO.File]::Create($destination)
        try {
            $inputStream.CopyTo($outputStream)
        } finally {
            $outputStream.Dispose()
            $inputStream.Dispose()
        }
    }
} finally {
    $archive.Dispose()
}

$nodeFile = Join-Path $runtimeDir 'node.exe'
$version = (& $nodeFile --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $version -cne 'v24.19.0') {
    throw "Extracted Node runtime version mismatch: $version"
}

$files = @(
    'src/server/main.mjs',
    'src/server/http.mjs',
    'src/server/appliance-lock.mjs',
    'src/server/reset.mjs',
    'src/server/offline-verify.mjs',
    'src/data/db.mjs',
    'src/data/seed.mjs',
    'src/data/schema.sql',
    'src/data/schema-v2.sql',
    'src/data/schema-v3.sql',
    'src/data/schema-v4.sql',
    'src/data/schema-v5.sql',
    'src/data/schema-v6.sql',
    'src/data/schema-v7.sql',
    'src/data/schema-v8.sql',
    'src/data/schema-v9.sql',
    'src/domain/audit.mjs',
    'src/domain/capa-service.mjs',
    'src/domain/change-service.mjs',
    'src/domain/change-effectiveness-service.mjs',
    'src/domain/change-effectiveness-source.mjs',
    'src/domain/document-service.mjs',
    'src/domain/effectiveness.mjs',
    'src/domain/equipment-timeline.mjs',
    'src/domain/incident-service.mjs',
    'src/domain/incident-effectiveness-service.mjs',
    'src/domain/quality-metrics.mjs',
    'src/domain/risk.mjs',
    'src/domain/state.mjs',
    'src/domain/trace.mjs',
    'src/domain/trace-source.mjs',
    'assets/ui/index.html',
    'assets/ui/app.js',
    'assets/ui/styles.css',
    'start-fabassure.cmd',
    'reset-demo.cmd',
    'verify-offline.cmd',
    'README_FIRST_KO.md'
)
$manifestFiles = @()
foreach ($relative in $files) {
    $source = Join-Path $repoRoot ($relative -replace '/', '\')
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Required runtime source is missing: $relative"
    }
    $destination = Join-Path $output ($relative -replace '/', '\')
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
    $manifestFiles += [ordered]@{
        path = $relative
        sha256 = Get-Sha256 $destination
    }
}
$manifest = [ordered]@{
    product = 'FabAssure'
    description = 'Synthetic offline demonstration'
    nodeVersion = $version
    nodeArchiveSha256 = $actualArchiveHash
    files = $manifestFiles
}
$json = $manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path $output 'manifest.json'), $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
Write-Output "FabAssure portable package created: $output"
