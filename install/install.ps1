$ErrorActionPreference = 'Stop'
$HubNode = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $HubNode -or [int]((& $HubNode.Source --version) -replace '^v(\d+).*$', '$1') -lt 22) {
    throw 'Hub requires Node.js 22 or newer. Download: https://nodejs.org/en/download'
}
$HubDist = $env:HUB_DIST_URL
if (-not $HubDist) { $HubDist = 'https://hub.example.invalid/dist/' }
if ($HubDist -cne 'https://hub.example.invalid/dist/' -and $HubDist -cnotmatch '^http://127\.0\.0\.1:\d+/dist/$') {
    throw 'Invalid Hub distribution URL'
}
# Temporary files here contain executable public release material only.
$HubTemp = Join-Path ([IO.Path]::GetTempPath()) ('hub-install-' + [guid]::NewGuid())
[void][IO.Directory]::CreateDirectory($HubTemp)
try {
    $HubBootstrap = Join-Path $HubTemp 'bootstrap.mjs'
    Invoke-WebRequest -UseBasicParsing -Uri ($HubDist + 'bootstrap.mjs') -OutFile $HubBootstrap -MaximumRedirection 0 -TimeoutSec 15
    & $HubNode.Source $HubBootstrap install zip
    if ($LASTEXITCODE -ne 0) { throw 'Hub installation failed' }
    if ($env:OS -eq 'Windows_NT') {
        $HubBin = Join-Path $env:LOCALAPPDATA 'hub-client\bin'
        if (($env:Path -split ';') -notcontains $HubBin) { $env:Path = $HubBin + ';' + $env:Path }
    }
} finally {
    Remove-Item -LiteralPath $HubTemp -Recurse -Force
}
