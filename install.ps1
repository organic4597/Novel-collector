$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Root = $PSScriptRoot
if (!(Test-Path -LiteralPath (Join-Path $Root 'run.mjs'))) { throw '릴리스 소스 ZIP을 먼저 압축 해제하세요.' }
$LocalNode = Join-Path $Root '.runtime\node\node.exe'
$Node = if (Test-Path -LiteralPath $LocalNode) { $LocalNode } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
$Ready = $false
if ($Node) { & $Node -e 'process.exit(Number(process.versions.node.split(".")[0])>=22&&process.arch==="x64"?0:1)'; $Ready = ($LASTEXITCODE -eq 0) }
if (!$Ready) {
    $Arch = 'x64'
    $Runtime = Join-Path $Root '.runtime'
    $Temp = Join-Path $Runtime ('node-install-' + [guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $Temp -Force | Out-Null
    try {
        $Sums = (Invoke-WebRequest -UseBasicParsing 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt').Content
        $Line = ($Sums -split "`n" | Where-Object { $_.Trim() -match " node-v22\.\d+\.\d+-win-$Arch\.zip$" } | Select-Object -First 1).Trim()
        if (!$Line) { throw '공식 Node 패키지를 찾지 못했습니다.' }
        $Parts = $Line -split '\s+'; $File = $Parts[-1]; $Archive = Join-Path $Temp $File
        Invoke-WebRequest -UseBasicParsing ("https://nodejs.org/dist/latest-v22.x/" + $File) -OutFile $Archive
        if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Parts[0]) { throw 'Node 패키지 무결성 오류' }
        Expand-Archive -LiteralPath $Archive -DestinationPath $Temp
        if (Test-Path -LiteralPath (Join-Path $Runtime 'node')) { Move-Item -LiteralPath (Join-Path $Runtime 'node') -Destination (Join-Path $Runtime ('node.old.' + [guid]::NewGuid().ToString())) }
        Move-Item -LiteralPath (Join-Path $Temp ($File.Substring(0, $File.Length - 4))) -Destination (Join-Path $Runtime 'node')
        $Node = $LocalNode
    } finally { Remove-Item -LiteralPath $Temp -Recurse -Force }
}
$env:PATH = (Join-Path $Root '.runtime\node') + ';' + (Join-Path $Root '.runtime\uv') + ';' + $env:PATH
& $Node (Join-Path $Root 'tools\install-runtime.mjs') @args
if ($LASTEXITCODE -ne 0) { throw '설치를 완료하지 못했습니다.' }
