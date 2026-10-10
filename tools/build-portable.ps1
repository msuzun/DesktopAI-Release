param(
    [string]$TargetDirectory,
    [switch]$VerboseBuild
)
$ErrorActionPreference = 'Stop'
$repositoryPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$targetRoot = [IO.Path]::GetFullPath((Join-Path $repositoryPath 'src-tauri/target'))
if (!$TargetDirectory) {
    $TargetDirectory = Join-Path $targetRoot ('portable-' + [guid]::NewGuid().ToString('N'))
}
$targetPath = [IO.Path]::GetFullPath($TargetDirectory)
if (!$targetPath.StartsWith($targetRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Portable build output must be a new directory under src-tauri/target.'
}
if (Test-Path -LiteralPath $targetPath) {
    throw 'Portable builds require a new target directory for a clean compilation.'
}
# Existing junctions/symlinks must not redirect the clean target outside this tree.
$ancestorPath = Split-Path -Parent $targetPath
while ($ancestorPath) {
    if (Test-Path -LiteralPath $ancestorPath) {
        $ancestor = Get-Item -LiteralPath $ancestorPath -Force
        if (!$ancestor.PSIsContainer -or ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Portable build output requires ordinary directory ancestors, without junctions or symlinks.'
        }
    }
    $nextAncestor = Split-Path -Parent $ancestorPath
    if ($nextAncestor -eq $ancestorPath) { break }
    $ancestorPath = $nextAncestor
}
if ($env:RUSTFLAGS -and !$env:CARGO_ENCODED_RUSTFLAGS) {
    throw 'Use CARGO_ENCODED_RUSTFLAGS for custom flags; this build does not reinterpret shell-quoted RUSTFLAGS.'
}
$previousTarget = $env:CARGO_TARGET_DIR
$previousFlags = $env:CARGO_ENCODED_RUSTFLAGS
$userDirectory = [Environment]::GetFolderPath('UserProfile')
$cargoDirectory = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $userDirectory '.cargo' }
$rustupDirectory = if ($env:RUSTUP_HOME) { $env:RUSTUP_HOME } else { Join-Path $userDirectory '.rustup' }
$flags = @()
if ($previousFlags) { $flags += $previousFlags.Split([char]31) }
# Privacy: remap diagnostic source filenames during compilation. This does not
# alter code, certificate verification, security products, or warning settings.
# Put more specific paths last; rustc uses the last matching mapping.
$mappings = @(
    @($userDirectory, '/user'),
    @($cargoDirectory, '/cargo'),
    @($rustupDirectory, '/rustup'),
    @($repositoryPath, '/source')
)
foreach ($mapping in $mappings) {
    $sourcePath = [IO.Path]::GetFullPath($mapping[0])
    $flags += '--remap-path-prefix=' + $sourcePath + '=' + $mapping[1]
    if ($sourcePath.Contains('\')) {
        $flags += '--remap-path-prefix=' + $sourcePath.Replace('\', '/') + '=' + $mapping[1]
    }
}
Push-Location -LiteralPath $repositoryPath
try {
    $env:CARGO_TARGET_DIR = $targetPath
    $env:CARGO_ENCODED_RUSTFLAGS = $flags -join [char]31
    $arguments = @('run', 'tauri', '--', 'build', '--no-bundle', '--', '--locked')
    if ($VerboseBuild) { $arguments += '--verbose' }
    & npm.cmd @arguments
    $buildExit = $LASTEXITCODE
    if ($buildExit -ne 0) { exit $buildExit }
    $executable = Join-Path $targetPath 'release/ai-desktop-companion.exe'
    Get-FileHash -LiteralPath $executable -Algorithm SHA256
    Write-Output "Portable executable: $executable"
} finally {
    $env:CARGO_TARGET_DIR = $previousTarget
    $env:CARGO_ENCODED_RUSTFLAGS = $previousFlags
    Pop-Location
}
