# End-to-end test of install/install.ps1 against a local fake release (run on Windows).
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $here '..\..')).Path
$port = 8767
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("mf-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null

function Assert-That($condition, $message) {
    if (-not $condition) { throw "FAIL: $message" }
}

$server = Start-Process node -ArgumentList @((Join-Path $here 'smoke-server.mjs'), $port) -PassThru -WindowStyle Hidden
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
try {
    for ($i = 0; $i -lt 50; $i++) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/release/SHA256SUMS" | Out-Null
            break
        } catch { Start-Sleep -Milliseconds 200 }
    }

    $installDir = Join-Path $tmp 'Media Forge'
    $exe = Join-Path $installDir 'mediaforge.exe'
    $env:MEDIAFORGE_RELEASE_TAG = 'v9.9.9'
    $env:MEDIAFORGE_INSTALL_DIR = $installDir
    $env:MEDIAFORGE_RELEASE_BASE_URL = "http://127.0.0.1:$port/release"
    $installer = Join-Path $root 'install\install.ps1'

    & $installer -SkipTools
    Assert-That (Test-Path $exe) 'the binary was not installed'
    Assert-That ((Get-Content -Raw $exe) -match 'fake mediaforge binary') 'wrong binary content'
    $entries = [Environment]::GetEnvironmentVariable('Path', 'User') -split ';'
    Assert-That ($entries -contains $installDir) 'the user PATH was not updated'

    # A second run replaces the binary and does not add the PATH entry twice.
    & $installer -SkipTools
    $entries = [Environment]::GetEnvironmentVariable('Path', 'User') -split ';'
    Assert-That (@($entries | Where-Object { $_ -eq $installDir }).Count -eq 1) 'the PATH entry was added twice'

    # A download that does not match SHA256SUMS is refused and the installed binary is left alone.
    $before = Get-Content -Raw $exe
    $env:MEDIAFORGE_RELEASE_BASE_URL = "http://127.0.0.1:$port/corrupt"
    $refused = $false
    try { & $installer -SkipTools } catch { $refused = $_.Exception.Message -match 'Checksum mismatch' }
    Assert-That $refused 'a corrupt download was not refused with a checksum message'
    Assert-That ((Get-Content -Raw $exe) -eq $before) 'the installed binary changed'

    # A binary that is in use cannot be replaced; the message says so and the old file stays.
    $env:MEDIAFORGE_RELEASE_BASE_URL = "http://127.0.0.1:$port/release"
    $lock = [IO.File]::Open($exe, 'Open', 'Read', 'None')
    try {
        $message = ''
        try { & $installer -SkipTools } catch { $message = $_.Exception.Message }
        Assert-That ($message -match 'Could not replace') 'no message for a binary in use'
    } finally { $lock.Dispose() }

    Write-Output 'install.ps1 OK'
} finally {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    [Environment]::SetEnvironmentVariable('Path', $userPath, 'User')
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
