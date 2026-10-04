$ErrorActionPreference = 'Stop'
$env:PATH = (Join-Path $PSScriptRoot '.runtime\node') + ';' + (Join-Path $PSScriptRoot '.runtime\uv') + ';' + $env:PATH
if (!$env:UV_PYTHON_INSTALL_DIR) { $env:UV_PYTHON_INSTALL_DIR = Join-Path $PSScriptRoot '.runtime\python' }
$Node = (Get-Command node -ErrorAction Stop).Source
& $Node (Join-Path $PSScriptRoot 'run.mjs') --replace @args
exit $LASTEXITCODE
