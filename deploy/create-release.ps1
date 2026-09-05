param(
    [Parameter(Mandatory = $true)]
    [string]$ArchivePath
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$projectPrefix = $projectRoot.TrimEnd('\') + '\'
$archiveFullPath = [System.IO.Path]::GetFullPath($ArchivePath)

$files = @(
    Get-ChildItem -LiteralPath $projectRoot -Filter '*.py' -File |
        Where-Object Name -ne 'config.py'
)
$files += Get-Item -LiteralPath (Join-Path $projectRoot 'Dockerfile')
$files += Get-Item -LiteralPath (Join-Path $projectRoot 'requirements.txt')
$files += Get-ChildItem -LiteralPath (Join-Path $projectRoot 'webapp') -File -Recurse
$files += Get-ChildItem -LiteralPath (Join-Path $projectRoot 'deploy') -File -Recurse

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $archiveFullPath) {
    Remove-Item -LiteralPath $archiveFullPath -Force
}

$archive = [System.IO.Compression.ZipFile]::Open(
    $archiveFullPath,
    [System.IO.Compression.ZipArchiveMode]::Create
)
try {
    foreach ($file in $files) {
        $relativePath = $file.FullName.Substring($projectPrefix.Length).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive,
            $file.FullName,
            $relativePath,
            [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
    }
}
finally {
    $archive.Dispose()
}
