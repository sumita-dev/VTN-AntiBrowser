param(
    [switch]$SkipKernel
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$DistRoot = Join-Path $RepoRoot 'dist'
$PortableDir = Join-Path $DistRoot 'VTN-AntiBrowser-Portable'
$ZipPath = Join-Path $DistRoot 'VTN-AntiBrowser-Portable.zip'

$CscPath = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$LauncherCs = Join-Path $RepoRoot 'launcher\VTNLauncher.cs'
$IconPath = Join-Path $RepoRoot 'src\ui\favicon.ico'
$LauncherExe = Join-Path $PortableDir 'VTN-AntiBrowser.exe'

Write-Host '[1/5] Preparing output directory...'
if (Test-Path $PortableDir) {
    Remove-Item -Path $PortableDir -Recurse -Force
}
if (Test-Path $ZipPath) {
    Remove-Item -Path $ZipPath -Force
}
New-Item -ItemType Directory -Path $PortableDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $PortableDir 'runtime') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $PortableDir 'bin') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $PortableDir 'data\profiles') -Force | Out-Null

Write-Host '[2/5] Compiling VTN-AntiBrowser.exe...'
if (-not (Test-Path $CscPath)) {
    throw "C# compiler not found at: $CscPath"
}
if (-not (Test-Path $LauncherCs)) {
    throw "Launcher source not found at: $LauncherCs"
}
if (-not (Test-Path $IconPath)) {
    throw "Application icon not found at: $IconPath"
}

& $CscPath `
    /nologo `
    /target:winexe `
    /optimize+ `
    "/win32icon:$IconPath" `
    /r:System.Windows.Forms.dll `
    "/out:$LauncherExe" `
    $LauncherCs

if ($LASTEXITCODE -ne 0) {
    throw "csc.exe failed with exit code $LASTEXITCODE"
}

Write-Host '[3/5] Copying Node.js runtime...'
$NodeCmd = Get-Command node -ErrorAction Stop
$NodeSource = $NodeCmd.Source
if (-not (Test-Path $NodeSource)) {
    throw "node.exe not found at: $NodeSource"
}
$NodeVersionRaw = (& $NodeSource -v).Trim()
if ($NodeVersionRaw -notmatch '^v(\d+)\.') {
    throw "Unable to parse Node.js version: $NodeVersionRaw"
}
$NodeMajor = [int]$Matches[1]
if ($NodeMajor -lt 22) {
    throw "Node.js >= 22 is required, found $NodeVersionRaw at $NodeSource"
}
Write-Host "      Using Node.js $NodeVersionRaw ($NodeSource)"
Copy-Item -Path $NodeSource -Destination (Join-Path $PortableDir 'runtime\node.exe') -Force

Write-Host '[4/5] Copying application files and binaries...'
Copy-Item -Path (Join-Path $RepoRoot 'src') -Destination (Join-Path $PortableDir 'src') -Recurse -Force
Copy-Item -Path (Join-Path $RepoRoot 'automation') -Destination (Join-Path $PortableDir 'automation') -Recurse -Force
Remove-Item -Path (Join-Path $PortableDir 'automation\config\accounts_facebook.json') -Force -ErrorAction SilentlyContinue
Copy-Item -Path (Join-Path $RepoRoot 'package.json') -Destination (Join-Path $PortableDir 'package.json') -Force
Copy-Item -Path (Join-Path $RepoRoot 'README.md') -Destination (Join-Path $PortableDir 'README.md') -Force

$ToolExe = Join-Path $RepoRoot 'bin\Tool.exe'
if (Test-Path $ToolExe) {
    Copy-Item -Path $ToolExe -Destination (Join-Path $PortableDir 'bin\Tool.exe') -Force
}

if (-not $SkipKernel) {
    $KernelDir = Join-Path $RepoRoot 'bin\151-0007'
    if (Test-Path $KernelDir) {
        Write-Host '      Including Chromium kernel (bin\151-0007)...'
        Copy-Item -Path $KernelDir -Destination (Join-Path $PortableDir 'bin\151-0007') -Recurse -Force
    } else {
        Write-Host '      Warning: bin\151-0007 not found, skipping kernel.'
    }
} else {
    Write-Host '      -SkipKernel specified: skipping bin\151-0007.'
}

Write-Host '[5/5] Creating portable zip archive...'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $PortableDir,
    $ZipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
)

$ExeInfo = Get-Item $LauncherExe
$ZipInfo = Get-Item $ZipPath
Write-Host ("Build complete:`n  EXE: {0} ({1:N0} bytes)`n  ZIP: {2} ({3:N2} MB)" -f $ExeInfo.FullName, $ExeInfo.Length, $ZipInfo.FullName, ($ZipInfo.Length / 1MB))
