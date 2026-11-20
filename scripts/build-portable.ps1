param(
    [switch]$SkipKernel,
    [switch]$SkipSign,
    [string]$CertThumbprint = ''
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

if (-not $SkipSign) {
    Write-Host '[2b/5] Signing VTN-AntiBrowser.exe...'
    $SignTool = Get-ChildItem -Path 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $SignTool) {
        $SignToolCmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
        if ($SignToolCmd) { $SignTool = $SignToolCmd.Source }
    }
    if (-not $SignTool -or -not (Test-Path $SignTool)) {
        throw 'signtool.exe not found under Windows Kits 10 bin\*\x64 or PATH. Pass -SkipSign to bypass signing.'
    }

    if ([string]::IsNullOrWhiteSpace($CertThumbprint)) {
        $SigningCert = Get-ChildItem -Path 'Cert:\CurrentUser\My' -CodeSigningCert -ErrorAction SilentlyContinue |
            Where-Object { $_.Subject -eq 'CN=VTN-AntiBrowser' } |
            Sort-Object NotAfter -Descending |
            Select-Object -First 1
        if (-not $SigningCert) {
            throw 'CodeSigning certificate CN=VTN-AntiBrowser not found in Cert:\CurrentUser\My. Pass -CertThumbprint or -SkipSign.'
        }
        $CertThumbprint = $SigningCert.Thumbprint
    }

    & $SignTool sign /fd SHA256 /s My /sha1 $CertThumbprint /tr 'http://timestamp.digicert.com' /td SHA256 $LauncherExe
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Timestamped signing failed (exit code $LASTEXITCODE); retrying without RFC3161 timestamp..."
        & $SignTool sign /fd SHA256 /s My /sha1 $CertThumbprint $LauncherExe
        if ($LASTEXITCODE -ne 0) {
            throw "signtool.exe failed with exit code $LASTEXITCODE"
        }
    }

    $Sig = Get-AuthenticodeSignature -FilePath $LauncherExe
    if (-not $Sig.SignerCertificate) {
        throw "Authenticode signature missing: Status=$($Sig.Status), StatusMessage=$($Sig.StatusMessage)"
    }
    if ($Sig.Status -eq 'Valid') {
        Write-Host ("      Signed successfully: Thumbprint={0}, Status={1}" -f $Sig.SignerCertificate.Thumbprint, $Sig.Status)
    } elseif ($Sig.Status -eq 'UnknownError') {
        Write-Warning ("Signed with self-signed cert (Root not yet trusted locally): Thumbprint={0}, Status={1}, Message={2}" -f $Sig.SignerCertificate.Thumbprint, $Sig.Status, $Sig.StatusMessage)
    } else {
        throw "Authenticode signature verification failed: Status=$($Sig.Status), StatusMessage=$($Sig.StatusMessage)"
    }

    $RepoCer = Join-Path $RepoRoot 'certs\VTN-AntiBrowser.cer'
    if (Test-Path $RepoCer) {
        Copy-Item -Path $RepoCer -Destination (Join-Path $PortableDir 'VTN-AntiBrowser.cer') -Force
    }
} else {
    Write-Host '[2b/5] -SkipSign specified: skipping Authenticode signing.'
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
