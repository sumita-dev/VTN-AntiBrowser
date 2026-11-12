<#
.SYNOPSIS
    VTN Anti-Browser Zero-Touch Setup Script (Windows PowerShell)
    Tự động cài đặt Git, Node.js >= 22, clone mã nguồn, import 1-Line Sync Key,
    tải lõi Chromium 151 từ R2, đồng bộ toàn bộ Profile và tạo Shortcut Desktop.

.EXAMPLE
    irm https://raw.githubusercontent.com/sumita-dev/VTN-AntiBrowser/main/setup.ps1 | iex
    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/sumita-dev/VTN-AntiBrowser/main/setup.ps1))) -SyncKey "VTN-R2-..."
#>

[CmdletBinding()]
param (
    [string]$SyncKey = "",
    [string]$InstallDir = "$env:USERPROFILE\VTN-AntiBrowser"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-BrandHeader {
    Write-Host "============================================================" -ForegroundColor DarkCyan
    Write-Host "  VTN Anti-Browser — Zero-Touch Auto-Setup (Chromium 151)" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor DarkCyan
    Write-Host ""
}

function Refresh-EnvPath {
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

function Test-CommandExists ($cmd) {
    return (Get-Command $cmd -ErrorAction SilentlyContinue) -ne $null
}

Write-BrandHeader

# 1. Kiểm tra và tự cài đặt Git nếu thiếu
Write-Host "[1/6] Kiểm tra môi trường Git..." -ForegroundColor Cyan
if (-not (Test-CommandExists "git")) {
    Write-Host "  Git chưa được cài đặt. Tiến hành cài đặt qua winget..." -ForegroundColor Yellow
    winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements
    Refresh-EnvPath
    if (-not (Test-CommandExists "git")) {
        throw "Không tìm thấy Git sau khi cài đặt. Vui lòng mở lại PowerShell và chạy lại script."
    }
}
$gitVer = (git --version)
Write-Host "  ✓ $gitVer" -ForegroundColor Green

# 2. Kiểm tra và tự cài đặt Node.js >= 22 nếu thiếu hoặc lỗi thời
Write-Host "[2/6] Kiểm tra môi trường Node.js (Yêu cầu >= v22.0.0)..." -ForegroundColor Cyan
$needNodeInstall = $false
if (Test-CommandExists "node") {
    $nodeVerRaw = (node -v) -replace '^v', ''
    $majorVer = [int]($nodeVerRaw.Split('.')[0])
    if ($majorVer -lt 22) {
        Write-Host "  Node.js hiện tại là v$nodeVerRaw (< v22.0.0). Tiến hành nâng cấp qua winget..." -ForegroundColor Yellow
        $needNodeInstall = $true
    } else {
        Write-Host "  ✓ Node.js v$nodeVerRaw (Tương thích)" -ForegroundColor Green
    }
} else {
    Write-Host "  Node.js chưa được cài đặt." -ForegroundColor Yellow
    $needNodeInstall = $true
}

if ($needNodeInstall) {
    Write-Host "  Đang cài đặt Node.js LTS (>= 22.x) qua winget..." -ForegroundColor Yellow
    winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements
    Refresh-EnvPath
    if (-not (Test-CommandExists "node")) {
        throw "Không tìm thấy Node.js sau khi cài đặt. Vui lòng mở lại PowerShell và chạy lại script."
    }
    $nodeVerRaw = (node -v) -replace '^v', ''
    Write-Host "  ✓ Đã cài đặt thành công Node.js v$nodeVerRaw" -ForegroundColor Green
}

# 3. Clone hoặc Pull mã nguồn mới nhất
Write-Host "[3/6] Thiết lập thư mục mã nguồn tại $InstallDir..." -ForegroundColor Cyan
$RepoUrl = "https://github.com/sumita-dev/VTN-AntiBrowser.git"
if (-not (Test-Path "$InstallDir\.git")) {
    Write-Host "  Đang clone mã nguồn từ $RepoUrl..." -ForegroundColor Cyan
    git clone $RepoUrl "$InstallDir"
} else {
    Write-Host "  Thư mục mã nguồn đã tồn tại. Đang cập nhật mã nguồn mới nhất..." -ForegroundColor Cyan
    git -C "$InstallDir" pull
}
Set-Location "$InstallDir"

# 4. Xử lý Sync Key (Nếu chưa truyền vào, hỏi người dùng)
Write-Host "[4/6] Thiết lập kết nối Cloudflare R2 Sync..." -ForegroundColor Cyan
if ([string]::IsNullOrWhiteSpace($SyncKey)) {
    Write-Host ""
    Write-Host "  ┌────────────────────────────────────────────────────────────┐" -ForegroundColor Yellow
    Write-Host "  │ ⚡ 1-LINE SYNC KEY: Dán mã 'VTN-R2-...' sao chép từ máy cũ  │" -ForegroundColor Yellow
    Write-Host "  │ (Nhấn Enter để bỏ qua nếu bạn muốn cấu hình sau trên UI)   │" -ForegroundColor Yellow
    Write-Host "  └────────────────────────────────────────────────────────────┘" -ForegroundColor Yellow
    $SyncKey = Read-Host "  Dán Sync Key tại đây"
}

if (-not [string]::IsNullOrWhiteSpace($SyncKey)) {
    $SyncKey = $SyncKey.Trim()
    if ($SyncKey.StartsWith("VTN-R2-")) {
        Write-Host "  Đang nạp thông tin kết nối từ Sync Key..." -ForegroundColor Cyan
        node -e "const { CloudSync } = require('./src/core/cloud-sync'); const cs = new CloudSync(); try { cs.importSyncKey(process.argv[1]); console.log('  ✓ Import Sync Key thành công!'); } catch(e) { console.error('  ❌ Lỗi import Sync Key:', e.message); process.exit(1); }" "$SyncKey"

        # Tự động kiểm tra và tải lõi Chromium 151 từ R2
        Write-Host "  Đang kiểm tra gói lõi Chromium 151 trên Cloudflare R2..." -ForegroundColor Cyan
        node -e "const { CloudSync } = require('./src/core/cloud-sync'); const cs = new CloudSync(); (async () => { const st = await cs.hasKernelOnCloud(); if (st && st.exists) { console.log('  ☁️ Tìm thấy gói lõi trên R2 (' + (st.contentLength / (1024*1024)).toFixed(1) + ' MB). Đang tải về và giải nén...'); const dl = await cs.downloadKernel(); console.log('  ✓ Lõi Chromium 151 đã được nạp thành công!'); } else { console.log('  ℹ️ Gói lõi chưa có sẵn trên R2. App sẽ tự mở Dashboard trên trình duyệt mặc định.'); } })().catch(e => console.warn('  ⚠️ Cảnh báo tải lõi:', e.message));"

        # Tự động đồng bộ toàn bộ Profile về máy
        Write-Host "  Đang đồng bộ danh sách Profile từ R2 về máy..." -ForegroundColor Cyan
        node -e "const { CloudSync } = require('./src/core/cloud-sync'); const { ProfileDatabase } = require('./src/core/db'); const path = require('path'); const cs = new CloudSync(); const db = new ProfileDatabase(); const pDir = path.resolve('./data/profiles'); (async () => { const res = await cs.syncAllProfiles(db, pDir); console.log('  ✓ Đồng bộ hoàn tất: ' + res.totalCloudProfiles + ' profiles trên cloud (tải mới ' + res.newSyncedProfiles + ').'); })().catch(e => console.warn('  ⚠️ Cảnh báo đồng bộ profiles:', e.message));"
    } else {
        Write-Host "  ⚠️ Khóa nhập vào không đúng định dạng 'VTN-R2-...'. Bỏ qua import tự động." -ForegroundColor Yellow
    }
} else {
    Write-Host "  ℹ️ Bỏ qua bước Sync Key. Bạn có thể cấu hình bất cứ lúc nào trong Settings trên UI." -ForegroundColor Gray
}

# 5. Tạo Shortcut VTN Anti-Browser trên Desktop
Write-Host "[5/6] Tạo Shortcut 'VTN Anti-Browser' trên Desktop..." -ForegroundColor Cyan
try {
    $WshShell = New-Object -ComObject WScript.Shell
    $DesktopPath = [Environment]::GetFolderPath("Desktop")
    $Shortcut = $WshShell.CreateShortcut("$DesktopPath\VTN Anti-Browser.lnk")
    $Shortcut.TargetPath = "$InstallDir\Start-VTN-Anti-Browser.bat"
    $Shortcut.WorkingDirectory = "$InstallDir"
    $Shortcut.Description = "VTN Anti-Browser Antidetect Manager (Chromium 151)"
    if (Test-Path "$InstallDir\src\ui\favicon.ico") {
        $Shortcut.IconLocation = "$InstallDir\src\ui\favicon.ico"
    }
    $Shortcut.Save()
    Write-Host "  ✓ Đã tạo Shortcut tại: $DesktopPath\VTN Anti-Browser.lnk" -ForegroundColor Green
} catch {
    Write-Host "  ⚠️ Không thể tạo shortcut desktop: $($_.Exception.Message)" -ForegroundColor Yellow
}

# 6. Khởi chạy ứng dụng
Write-Host "[6/6] Khởi chạy VTN Anti-Browser..." -ForegroundColor Green
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  🎉 CÀI ĐẶT HOÀN TẤT — HỆ THỐNG ĐÃ SẴN SÀNG!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""

Start-Process "$InstallDir\Start-VTN-Anti-Browser.bat"
