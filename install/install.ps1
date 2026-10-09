<#
.SYNOPSIS
Installs MediaForge for the current user (Windows).

.DESCRIPTION
Downloads mediaforge.exe from the GitHub release this script belongs to, checks its SHA-256
against the release's SHA256SUMS, puts it in %LOCALAPPDATA%\MediaForge (adding that folder to your
user PATH) and, unless -SkipTools is given, runs `mediaforge setup --yes` to download yt-dlp and
ffmpeg. When it finishes it starts MediaForge, unless -NoLaunch is given or there is no
interactive terminal. No administrator rights are needed and nothing outside your user profile is
changed. It is short; read it first if you like.

.PARAMETER SkipTools
Do not download yt-dlp and ffmpeg now. Run `mediaforge setup` later.

.PARAMETER NoLaunch
Do not start MediaForge when the install finishes.

.EXAMPLE
irm https://github.com/N-Berns/mediaforge/releases/latest/download/install.ps1 | iex

.EXAMPLE
& ([scriptblock]::Create((irm https://github.com/N-Berns/mediaforge/releases/latest/download/install.ps1))) -SkipTools
#>
[CmdletBinding()]
param(
    [switch]$SkipTools,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
# The built-in progress bar makes Invoke-WebRequest very slow on Windows PowerShell 5.1.
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

# --- Look of the output ---------------------------------------------------------------------------
# Colours go through Write-Host, so no escape codes end up in a log. NO_COLOR turns them off. The
# live download bar redraws one line, so it is used only when output goes to a real console.
$UseColor = -not $env:NO_COLOR
$Live = -not [Console]::IsOutputRedirected
$StepCount = if ($SkipTools) { 3 } else { 4 }
$StepNo = 0

function Write-Styled([string]$Text, [string]$Color = '', [switch]$NoNewline) {
    $params = @{ Object = $Text; NoNewline = [bool]$NoNewline }
    if ($UseColor -and $Color) { $params.ForegroundColor = $Color }
    Write-Host @params
}

function Write-Step([string]$Text) {
    $script:StepNo++
    Write-Styled ''
    Write-Styled "[$($script:StepNo)/$StepCount] " 'Cyan' -NoNewline
    Write-Styled $Text 'White'
}

function Write-Ok([string]$Text) {
    Write-Styled '  [ok] ' 'Green' -NoNewline
    Write-Styled $Text
}

function Write-Detail([string]$Text) { Write-Styled "       $Text" 'DarkGray' }

function Format-Size([double]$Bytes) {
    if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ('{0:N0} KB' -f ($Bytes / 1KB)) }
    return ('{0:N0} B' -f $Bytes)
}

# One line, redrawn in place: [######----------]  42%  3.1 MB of 7.4 MB  1.2 MB/s
function Write-Bar([double]$Done, [double]$Total, [double]$BytesPerSec) {
    $width = 30
    $percent = if ($Total -gt 0) { [Math]::Min(100, [int](100 * $Done / $Total)) } else { 0 }
    $filled = [int]($width * $percent / 100)
    Write-Host "`r" -NoNewline
    Write-Styled '       [' 'DarkGray' -NoNewline
    Write-Styled ('#' * $filled) 'Cyan' -NoNewline
    Write-Styled ('-' * ($width - $filled)) 'DarkGray' -NoNewline
    Write-Styled ('] {0,3}%  ' -f $percent) 'White' -NoNewline
    $text = if ($Total -gt 0) { "$(Format-Size $Done) of $(Format-Size $Total)" } else { Format-Size $Done }
    if ($BytesPerSec -gt 0) { $text += "  $(Format-Size $BytesPerSec)/s" }
    Write-Styled ($text + '    ') 'DarkGray' -NoNewline
}

# Downloads a file. With -Bar and a real console it shows progress; otherwise it is a plain download.
function Save-File([string]$Url, [string]$Path, [switch]$Bar) {
    if (-not ($Bar -and $Live)) {
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path
        return
    }
    Add-Type -AssemblyName System.Net.Http
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromMinutes(15)
    try {
        $response = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        $response.EnsureSuccessStatusCode() | Out-Null
        $total = $response.Content.Headers.ContentLength
        if ($null -eq $total) { $total = 0 }
        $in = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $out = [IO.File]::Create($Path)
        try {
            $buffer = New-Object byte[] 81920
            $done = 0
            $clock = [Diagnostics.Stopwatch]::StartNew()
            $lastDraw = -1000
            while (($n = $in.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $out.Write($buffer, 0, $n)
                $done += $n
                if ($clock.ElapsedMilliseconds - $lastDraw -ge 100) {
                    $lastDraw = $clock.ElapsedMilliseconds
                    Write-Bar $done $total ($done / [Math]::Max(0.001, $clock.Elapsed.TotalSeconds))
                }
            }
            Write-Bar $done $(if ($total -gt 0) { $total } else { $done }) 0
            Write-Host ''
        } finally {
            $out.Dispose()
            $in.Dispose()
        }
    } finally {
        $client.Dispose()
    }
}

# 64-bit Windows only. Windows on ARM runs the x64 build under emulation. (Not
# RuntimeInformation.OSArchitecture: in some Windows PowerShell sessions it returns nothing.)
if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'Unsupported system: 32-bit Windows (supported: 64-bit x64, and ARM64 through emulation)'
}

Write-Styled ''
Write-Styled '  MediaForge installer' 'Cyan'
Write-Styled "  Release $Tag  |  Windows x64" 'DarkGray'
Write-Styled '  ----------------------------------------' 'DarkGray'

$Temp = Join-Path ([IO.Path]::GetTempPath()) ('mediaforge-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Temp | Out-Null
try {
    Write-Step "Downloading $Asset"
    $sumsFile = Join-Path $Temp 'SHA256SUMS'
    $downloaded = Join-Path $Temp $Asset
    Save-File "$BaseUrl/SHA256SUMS" $sumsFile
    Save-File "$BaseUrl/$Asset" $downloaded -Bar
    Write-Ok 'Download complete'

    Write-Step 'Verifying checksum'
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
    Write-Ok 'SHA-256 matches the release'
    Write-Detail $actual

    Write-Step 'Installing'
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
    Write-Ok "Installed $target"
} finally {
    Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = @()
if ($userPath) { $entries = @($userPath -split ';' | Where-Object { $_ }) }
if ($entries -notcontains $InstallDir) {
    [Environment]::SetEnvironmentVariable('Path', (($entries + $InstallDir) -join ';'), 'User')
    $env:Path = "$env:Path;$InstallDir"
    Write-Ok "Added $InstallDir to your user PATH"
    Write-Detail 'Open a new terminal to use it everywhere.'
} else {
    Write-Ok 'Already on your user PATH'
}

if (-not $SkipTools) {
    Write-Step 'Setting up yt-dlp and ffmpeg'
    & (Join-Path $InstallDir 'mediaforge.exe') setup --yes
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Tool setup did not finish. Run 'mediaforge setup' when you are online."
    } else {
        Write-Ok 'Tools are ready'
    }
}

$interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected
$ready = "MediaForge $Tag is ready"
$rule = '+' + ('-' * ($ready.Length + 4)) + '+'
Write-Styled ''
Write-Styled "  $rule" 'Green'
Write-Styled '  |  ' 'Green' -NoNewline
Write-Styled $ready 'White' -NoNewline
Write-Styled '  |' 'Green'
Write-Styled "  $rule" 'Green'
if ($NoLaunch -or -not $interactive) {
    Write-Styled '  Run: ' 'DarkGray' -NoNewline
    Write-Styled 'mediaforge' 'Cyan'
} else {
    Write-Styled '  Starting MediaForge...' 'DarkGray'
    & (Join-Path $InstallDir 'mediaforge.exe')
}
