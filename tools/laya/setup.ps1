param(
    [string]$RuntimeDirectory = (Join-Path $PSScriptRoot '../../src-tauri/target/laya-runtime'),
    [string]$ModelDirectory = (Join-Path $PSScriptRoot '../../src-tauri/target/laya-models'),
    [string]$Checkpoints = 'multilingual',
    [string]$PythonVersion = '3.13'
)
$ErrorActionPreference = 'Stop'
# Explicit developer setup only. The application never invokes this script.
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This CPU runtime lock supports Windows only.'
}
if (!(Get-Command uv -ErrorAction SilentlyContinue)) {
    throw 'Install Python 3.13 and uv before running this optional setup.'
}
$runtimePath = [IO.Path]::GetFullPath($RuntimeDirectory)
$modelPath = [IO.Path]::GetFullPath($ModelDirectory)
$pythonPath = Join-Path $runtimePath 'Scripts/python.exe'
$previousCache = $env:UV_CACHE_DIR
try {
    $env:UV_CACHE_DIR = Join-Path $runtimePath '..\laya-package-cache'
    if (!(Test-Path -LiteralPath $pythonPath)) {
        & uv venv --python $PythonVersion --no-python-downloads $runtimePath
        if ($LASTEXITCODE -ne 0) { throw 'Install a supported Python and uv first.' }
    }
    & $pythonPath -c "import sys, sysconfig; sys.exit(0 if sys.implementation.name == 'cpython' and sys.version_info[:2] == (3, 13) and sysconfig.get_platform() == 'win-amd64' and not sysconfig.get_config_var('Py_GIL_DISABLED') else 1)"
    if ($LASTEXITCODE -ne 0) { throw 'The locked runtime requires standard (GIL-enabled) Windows x64 CPython 3.13.' }
    # Windows CPU wheels avoid an unrequested CUDA runtime and GPU contention.
    # Every dependency is pinned below. Do not resolve unpinned packages or run
    # source-distribution build scripts while creating this optional runtime.
    & uv pip install --python $pythonPath --no-deps --only-binary :all: --require-hashes --index-url https://download.pytorch.org/whl/cpu -r (Join-Path $PSScriptRoot 'requirements-torch.lock.txt')
    if ($LASTEXITCODE -ne 0) { throw 'CPU PyTorch installation failed.' }
    & uv pip install --python $pythonPath --no-deps --only-binary :all: --require-hashes --index-url https://pypi.org/simple -r (Join-Path $PSScriptRoot 'requirements-cpu.lock.txt')
    if ($LASTEXITCODE -ne 0) { throw 'LAYA installation failed.' }
    & uv pip check --python $pythonPath
    if ($LASTEXITCODE -ne 0) { throw 'LAYA runtime dependencies are incompatible.' }
    $installedVersions = & uv pip freeze --python $pythonPath
    if ($LASTEXITCODE -ne 0) { throw 'Unable to record installed runtime versions.' }
    $installedVersions | Set-Content -Encoding UTF8 (Join-Path $runtimePath 'installed-versions.txt')
    & $pythonPath (Join-Path $PSScriptRoot 'download_models.py') --destination $modelPath --checkpoints $Checkpoints
    if ($LASTEXITCODE -ne 0) { throw 'Verified model acquisition failed.' }
    Write-Output "Runtime ready: $pythonPath"
    Write-Output "Models: $modelPath"
} finally {
    $env:UV_CACHE_DIR = $previousCache
}
