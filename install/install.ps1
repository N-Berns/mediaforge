<#
.SYNOPSIS
Installs MediaForge for the current user (Windows).

.DESCRIPTION
Downloads mediaforge.exe from the GitHub release this script belongs to, checks its SHA-256
against the release's SHA256SUMS, puts it in %LOCALAPPDATA%\MediaForge (adding that folder to your
user PATH) and, unless -SkipTools is given, runs `mediaforge setup --yes` to download yt-dlp and
ffmpeg. No administrator rights are needed and nothing outside your user profile is changed.
It is short; read it first if you like.

.PARAMETER SkipTools
Do not download yt-dlp and ffmpeg now. Run `mediaforge setup` later.

.EXAMPLE
irm https://github.com/N-Berns/mediaforge/releases/latest/download/install.ps1 | iex

.EXAMPLE
& ([scriptblock]::Create((irm https://github.com/N-Berns/mediaforge/releases/latest/download/install.ps1))) -SkipTools
#>
[CmdletBinding()]
param(
    [switch]$SkipTools
)

$ErrorActionPreference = 'Stop'
# The progress bar makes Invoke-WebRequest very slow on Windows PowerShell 5.1.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = 'N-Berns/mediaforge'
# The release workflow replaces the placeholder with the release tag when it publishes this file.
$Tag = if ($env:MEDIAFORGE_RELEASE_TAG) { $env:MEDIAFORGE_RELEASE_TAG } else { '__RELEASE_TAG__' }
if ($Tag -like '__RELEASE*') {
    throw "This copy of install.ps1 is not tied to a release. Download it from https://github.com/$Repo/releases"
}
$BaseUrl = if ($env:MEDIAFORGE_RELEASE_BASE_URL) { $env:MEDIAFORGE_RELEASE_BASE_URL } else { "https://github.com/$Repo/releases/download/$Tag" }
$InstallDir = if ($env:MEDIAFORGE_INSTALL_DIR) { $env:MEDIAFORGE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'MediaForge' }
$Asset = 'mediaforge-win-x64.exe'

# Windows on ARM runs the x64 build under emulation.
$cpu = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
if ($cpu -ne 'X64' -and $cpu -ne 'Arm64') {
    throw "Unsupported CPU: $cpu (supported: x64, and ARM64 through emulation)"
}

$Temp = Join-Path ([IO.Path]::GetTempPath()) ('mediaforge-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Temp | Out-Null
try {
    Write-Host "Downloading $Asset ($Tag)..."
    $sumsFile = Join-Path $Temp 'SHA256SUMS'
    $downloaded = Join-Path $Temp $Asset
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/SHA256SUMS" -OutFile $sumsFile
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$Asset" -OutFile $downloaded

    $expected = $null
    foreach ($line in (Get-Content -LiteralPath $sumsFile)) {
        $parts = $line.Trim() -split '\s+', 2
        if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $Asset) { $expected = $parts[0].ToLowerInvariant() }
    }
    if (-not $expected) { throw "SHA256SUMS has no entry for $Asset." }
    $actual = (Get-FileHash -LiteralPath $downloaded -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        throw "Checksum mismatch for $Asset (expected $expected, got $actual). Nothing was installed."
    }

    # Copy next to the final name and rename, so an interrupted install never leaves a half-written file.
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $staged = Join-Path $InstallDir 'mediaforge.exe.new'
    $target = Join-Path $InstallDir 'mediaforge.exe'
    Copy-Item -LiteralPath $downloaded -Destination $staged -Force
    try {
        Move-Item -LiteralPath $staged -Destination $target -Force
    } catch {
        Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
        throw "Could not replace $target. Close any running MediaForge window and try again. ($($_.Exception.Message))"
    }
    Write-Host "Installed $target"
} finally {
    Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = @()
if ($userPath) { $entries = @($userPath -split ';' | Where-Object { $_ }) }
if ($entries -notcontains $InstallDir) {
    [Environment]::SetEnvironmentVariable('Path', (($entries + $InstallDir) -join ';'), 'User')
    $env:Path = "$env:Path;$InstallDir"
    Write-Host "Added $InstallDir to your user PATH. Open a new terminal to use it everywhere."
}

if (-not $SkipTools) {
    Write-Host 'Setting up yt-dlp and ffmpeg...'
    & (Join-Path $InstallDir 'mediaforge.exe') setup --yes
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Tool setup did not finish. Run 'mediaforge setup' when you are online."
    }
}

Write-Host "MediaForge $Tag is ready. Run: mediaforge"
