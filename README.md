# VTN Anti-Browser — Native Chromium 151 Antidetect

> **Trình duyệt Antidetect Siêu Tàng Hình Thế Hệ Mới** tích hợp can thiệp lõi C++ Native Spoofing trên nhân Chromium 151.0.7922.109, đồng bộ đa máy đám mây qua Cloudflare R2 / S3-Compatible với Zero-Dependency AWS SigV4 và Distributed Lock Invariant.

---

## 🌟 Tính Năng Nổi Bật

- **Lõi C++ Native Spoofing (Không JS Injection):**
  - Can thiệp trực tiếp từ tầng mã nguồn C++ của Chromium engine (`chrome.dll`).
  - Tuyệt đối không can thiệp vào `prototype` của JavaScript: `Function.prototype.toString` luôn giữ nguyên `[native code]`, không có bất kỳ biến lạ nào rò rỉ trên `navigator`.
  - Vượt qua 100% các hệ thống phát hiện bot và chấm điểm vân tay khắt khe nhất hiện nay: **CreepJS, BrowserScan, Pixelscan, Incolumitas, IPHEY, Cloudflare Turnstile, Kasada, DataDome**.
- **19 Nguyên Mẫu Phần Cứng Thực Tế (Hardware Blueprints):**
  - Bao quát hơn 520+ tổ hợp phần cứng hoàn chỉnh, đồng bộ chặt chẽ giữa OS, Platform, CPU Cores, RAM, Độ phân giải màn hình, Card đồ họa (NVIDIA GeForce RTX 4090/3080, Apple Silicon M3/M2 Max, AMD Radeon, Intel Iris Xe) và User-Agent Client Hints.
  - Chức năng **Auto Unique Profile**: Tự động sinh vân tay mới với cam kết **0% va chạm** (Zero-Collision) về Canvas Mark, WebGL Vendor/Renderer, Audio Noise Tuple, MAC Address và DeviceName.
- **Đồng Bộ Đa Máy Tự Động Qua Cloudflare R2 / S3:**
  - **Zero-Dependency AWS SigV4**: Tự hiện thực hóa chuẩn chữ ký AWS Signature Version 4 thuần bằng `node:crypto` và `fetch`, không phụ thuộc bất kỳ thư viện bên thứ 3 nào.
  - **Khóa phân tán (Distributed Lock Invariant)**: Chống xung đột dữ liệu khi 2 máy tính cùng mở một profile cùng lúc; hỗ trợ cơ chế giải phóng khóa an toàn và tự phục hồi ngoại tuyến (Offline Degradation).
  - **Tối ưu dung lượng & băng thông**: Tự động nén `tar.gz` tốc độ cao, chủ động loại trừ các file cache tạm (`Cache`, `Code Cache`, `Crashpad`, `*.tmp`, `Singleton*`), giúp việc đồng bộ session, cookies và tài khoản diễn ra trong tích tắc.
  - **Giao diện Cấu hình R2 trực quan**: Cho phép nhập thông số kết nối, kiểm tra đường truyền và cập nhật trực tiếp trên giao diện Dashboard mà không cần can thiệp file mã nguồn.
- **Tích Hợp Proxy Đa Giao Thức & Auto GeoIP:**
  - Hỗ trợ HTTP, HTTPS, SOCKS5 với bộ chuyển tiếp ngầm GOST tích hợp sẵn.
  - Khả năng tự động đồng bộ Timezone, Ngôn ngữ (Accept-Language) và Tọa độ địa lý (Geolocation) theo IP của Proxy.
- **Hỗ Trợ Tự Động Hóa (Automation) Chuyên Nghiệp:**
  - Tích hợp chuẩn giao thức Chrome DevTools Protocol (CDP).
  - Kết nối mượt mà với Puppeteer, Playwright, Selenium, hay bất kỳ framework tự động hóa nào bằng Python, Node.js, C#, Go.

---

## 📋 Yêu Cầu Hệ Thống

- **Hệ điều hành:** Windows 10 / Windows 11 (64-bit).
- **Môi trường chạy:** [Node.js](https://nodejs.org/) phiên bản **>= 22.0.0** (khuyến nghị Node.js LTS mới nhất).

---

## ⚡ Cài Đặt Tự Động 1 Lệnh Trên Máy Mới (Zero-Touch Setup)

VTN Anti-Browser hỗ trợ **Zero-Touch Setup**: thiết lập hoàn toàn tự động từ A-Z trên một máy tính Windows mới tinh chỉ với **duy nhất 1 câu lệnh PowerShell**. Script tự động kiểm tra và cài đặt Git, Node.js >= 22 qua `winget`, clone mã nguồn, kết nối R2 qua Sync Key, tải lõi Chromium 151, đồng bộ toàn bộ Profiles và tạo Shortcut trên Desktop.

### Cách 1: Chạy lệnh cài đặt nhanh (Khuyến nghị)
Mở **PowerShell** trên máy mới và chạy:
```powershell
irm https://raw.githubusercontent.com/sumita-dev/VTN-AntiBrowser/main/setup.ps1 | iex
```
*Script sẽ hiển thị nhắc bạn dán chuỗi Sync Key (dạng `VTN-R2-...`) sao chép từ máy cũ để tự động kết nối và tải toàn bộ dữ liệu.*

### Cách 2: Truyền trực tiếp 1-Line Sync Key
Nếu bạn đã có chuỗi Sync Key từ máy cũ, truyền trực tiếp qua tham số `-SyncKey`:
```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/sumita-dev/VTN-AntiBrowser/main/setup.ps1))) -SyncKey "VTN-R2-..."
```

---

### 🔑 Cách lấy 1-Line Sync Key từ máy cũ
1. Trên máy cũ đang chạy VTN Anti-Browser, mở Dashboard (`http://127.0.0.1:45678`).
2. Nhấn nút **⚙️ Cấu hình R2** trên thanh Header.
3. Nhấn nút **📋 Copy Sync Key** ở góc trên khung cấu hình.
4. Chuỗi khóa định dạng `VTN-R2-...` đã được sao chép vào Clipboard. Mang chuỗi này dán sang máy mới là xong!

---

### 📤 Cách đẩy Lõi Trình duyệt Chromium 151 lên R2 (Chỉ làm 1 lần từ máy có lõi)
Nếu bạn có một máy đã có sẵn thư mục `bin/151-0007/`, bạn có thể đẩy gói lõi lên Cloudflare R2 để các máy mới tự động tải về mà không cần copy thủ công:
```bash
npm run cloud:upload-kernel
```
*Hoặc nhấn nút **"📤 Đẩy lõi Chrome 151 lên R2"** trong cửa sổ Cấu hình R2 trên UI.*

---

## 🚀 Hướng Dẫn Cài Đặt Thủ Công (Sau khi Git Clone)

Do chính sách giới hạn kích thước file của GitHub (< 100MB), các file nhị phân trình duyệt gốc (`bin/151-0007/chrome.dll` có dung lượng ~180MB) và cơ sở dữ liệu hồ sơ cá nhân (`data/`) được bảo vệ nghiêm ngặt trong file `.gitignore` để tránh rò rỉ token bí mật.

Để thiết lập và đưa phần mềm vào hoạt động trên máy tính mới, thực hiện theo 4 bước sau:

### Bước 1: Clone dự án và cài Node.js
```bash
git clone https://github.com/your-username/VTN-Browser.git
cd VTN-Browser
```
Cài đặt **Node.js >= 22** nếu máy tính chưa có.

### Bước 2: Copy thư mục lõi trình duyệt (`bin/151-0007/`)
Copy thư mục nhị phân Chromium đã được tích hợp hook C++ vào thư mục gốc của dự án:
```
VTN-Browser/
  ├── bin/
  │   └── 151-0007/
  │       ├── chrome.exe
  │       ├── chrome.dll
  │       ├── ... (các file tài nguyên Chromium)
```
> *Lưu ý: Nếu bạn tải bản phát hành đóng gói (Release Archive), thư mục `bin/` đã được đặt sẵn đúng vị trí.*

### Bước 3: Khởi động chương trình
Nhấp đúp chuột vào file script tự động:
```bat
Start-VTN-Anti-Browser.bat
```
Hoặc khởi chạy từ dòng lệnh:
```bash
npm start
# Hoặc khởi chạy giao diện Desktop App độc lập:
npm run start:app
```
Hệ thống sẽ tự động khởi tạo cơ sở dữ liệu SQLite cục bộ và mở Dashboard quản trị tại địa chỉ `http://127.0.0.1:45678`.

### Bước 4: Cấu hình Cloudflare R2 & Kéo toàn bộ Profile về máy
1. Trên thanh Header Dashboard, bấm nút **⚙️ Cấu hình R2**.
2. Điền thông tin kết nối S3 API từ Cloudflare Dashboard:
   - **R2 Endpoint URL**: `https://<account_id>.r2.cloudflarestorage.com`
   - **Access Key ID**: Key ID từ Cloudflare R2 API Tokens.
   - **Secret Access Key**: Secret Token tương ứng.
   - **Bucket Name**: `vtn-antibrowser` (hoặc tên bucket bạn đã tạo).
   - **Region**: `auto`.
3. Bấm **Lưu & Kiểm tra kết nối**: Hệ thống sẽ gửi gói tin AWS SigV4 kiểm tra kết nối ngay lập tức và lưu an toàn vào `data/r2_config.json`.
4. Bấm nút **☁️ Đồng bộ Cloud (R2)** trên Header để tự động kéo tất cả Profile, cấu hình phần cứng và dữ liệu phiên làm việc về máy mới!

---

## 🖥️ Hướng Dẫn Sử Dụng Dashboard

### 1. Tạo Profile Mới Tự Động (Auto Unique)
- Nhấp nút màu cam **⚡ TẠO PROFILE MỚI TỰ ĐỘNG (Auto Unique)**.
- Hệ thống sẽ tự động phân tích các profile hiện có, chọn 1 Blueprint phần cứng chưa bị trùng và tạo một hồ sơ hoàn chỉnh trong chưa đầy 1 giây.

### 2. Tạo Profile Tùy Chỉnh
- Bấm **+ Tạo Profile Tùy Chỉnh**.
- Đặt tên, nhóm, chọn Blueprint phần cứng, số nhân CPU, RAM, độ phân giải màn hình.
- Điền thông tin Proxy (nếu dùng): dạng `http://user:pass@host:port` hoặc `socks5://host:port`.
- Bấm **Lưu Profile**.

### 3. Vận Hành & Khám Vân Tay (CDP Probe)
- Bấm **Mở Trình Duyệt** tại profile mong muốn để duyệt web bình thường.
- Bấm nút **Khám Vân Tay (CDP)** khi profile đang chạy để xem báo cáo trực tiếp từ luồng DevTools Protocol về: Card màn hình thật, Audio Fingerprint, Canvas Hash, Screen, WebGL parameters và chứng minh `[native code]` không bị phát hiện.
- Khi đóng trình duyệt, hệ thống sẽ tự động đồng bộ dữ liệu phiên (cookies, history, storage) lên Cloudflare R2 và giải phóng khóa phân tán.

---

## 🤖 Điều Khiển Tự Động Hóa (Automation API)

VTN Anti-Browser cung cấp sẵn Local REST API phục vụ tự động hóa qua cổng `45678`:

### 1. Mở Profile bằng API (Puppeteer / Playwright)
**Request:**
```http
POST /api/v1/profile/open
Content-Type: application/json

{
  "profileId": "vnt_win11_rtx4090",
  "headless": false
}
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "profileId": "vnt_win11_rtx4090",
    "debuggingPort": 51234,
    "browserWsEndpoint": "ws://127.0.0.1:51234/devtools/browser/abc-123",
    "pageWsEndpoint": "ws://127.0.0.1:51234/devtools/page/def-456"
  }
}
```

### Ví dụ kết nối với Puppeteer (Node.js):
```javascript
const puppeteer = require('puppeteer-core');

async function main() {
  // 1. Mở profile qua API
  const res = await fetch('http://127.0.0.1:45678/api/v1/profile/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: 'vnt_win11_rtx4090' })
  }).then(r => r.json());

  // 2. Kết nối Puppeteer vào trình duyệt đang mở
  const browser = await puppeteer.connect({
    browserWSEndpoint: res.data.browserWsEndpoint
  });

  const page = (await browser.pages())[0] || (await browser.newPage());
  await page.goto('https://browserleaks.com/canvas');
  console.log('Tiêu đề trang:', await page.title());
}

main();
```

### 2. Đóng Profile bằng API
```http
POST /api/v1/profile/close
Content-Type: application/json

{
  "profileId": "vnt_win11_rtx4090"
}
```

---

## 📁 Cấu Trúc Thư Mục Dự Án

```
VTN-Browser/
├── bin/                          # Thư mục lõi Chromium C++ (được loại trừ trên Git)
│   └── 151-0007/                 # Nhân Chromium 151.0.7922.109 C++ Spoofing Hook
├── data/                         # Dữ liệu cục bộ (được loại trừ trên Git)
│   ├── profiles/                 # Thư mục chứa session & cache profile
│   ├── r2_config.json            # Thông số kết nối Cloudflare R2
│   └── vnt_profiles.db           # Cơ sở dữ liệu SQLite lưu trữ profile
├── scripts/
│   └── upload-kernel.js          # Script nén và đẩy lõi Chromium 151 lên Cloudflare R2
├── src/
│   ├── api/
│   │   └── server.js             # REST API server & phục vụ giao diện Web UI
│   ├── core/
│   │   ├── browser-manager.js    # Quản lý tiến trình chrome.exe & lifecycle CDP
│   │   ├── cdp-probe.js          # Thẩm định vân tay qua CDP WebSocket
│   │   ├── cipher.js             # Mã hóa bảo vệ cấu hình tham số C++ hook
│   │   ├── cloud-sync.js         # Dịch vụ đồng bộ R2, nén tar.gz, 1-Line Sync Key & Kernel Sync
│   │   ├── config-builder.js     # Sinh tham số dòng lệnh & flags khởi chạy Chrome
│   │   ├── db.js                 # Quản lý cơ sở dữ liệu SQLite
│   │   ├── fingerprint-gen.js    # 19 Blueprints phần cứng & bộ sinh vân tay chống trùng
│   │   ├── proxy-tunnel.js       # Quản lý proxy GOST & truy vấn GeoIP
│   │   └── r2-client.js          # AWS SigV4 Zero-Dependency S3/R2 client
│   ├── ui/
│   │   ├── assets/               # Logo và biểu tượng Apple HIG
│   │   └── index.html            # Giao diện Web Dashboard kính mờ (Glassmorphism)
│   └── main.js                   # Điểm khởi chạy chính & Smart Fallback browser
├── tests/
│   └── e2e_verify.js             # Bộ kiểm thử E2E toàn diện
├── .gitignore                    # Chặn triệt để mã nhị phân >100MB và dữ liệu nhạy cảm
├── package.json                  # Cấu hình dự án & scripts Node.js
├── README.md                     # Tài liệu hướng dẫn sử dụng
├── setup.ps1                     # Script cài đặt tự động 1 lệnh (Zero-Touch Setup)
└── Start-VTN-Anti-Browser.bat    # File khởi động nhanh trên Windows
```

---

## 🛡️ Bảo Mật & An Toàn Dữ Liệu

- File `.gitignore` được thiết lập chặt chẽ: Chặn toàn bộ thư mục `data/` (ngăn lộ mật khẩu, cookie, SQLite DB, `r2_config.json`), `bin/` (file nhị phân > 100MB), `node_modules/`, log và cache IDE.
- API Endpoint `/api/v1/cloud/config` tự động làm mờ (masking) trường `secretAccessKey`, không bao giờ gửi khóa bí mật dạng văn bản rõ về trình duyệt.
- Dữ liệu đồng bộ lên R2 chỉ bao gồm metadata hồ sơ và file nén đã thanh lọc rác, được khóa bảo vệ theo từng ID máy tính (`machine_id.txt`).

---

## 🧪 Kiểm Thử Hệ Thống (E2E Verification)

Chạy bộ kiểm thử để xác minh toàn bộ các chức năng:
```bash
npm test
```
Bộ test tự động kiểm tra:
1. Tính toàn vẹn của thuật toán mã hóa tham số `594` và phòng vệ chống crash empty-object.
2. Bộ thẩm định & tự chữa lành vân tay (Validator & Auto-Healer) trên 19 Blueprints với 520+ cấu hình phần cứng.
3. Cơ sở dữ liệu SQLite CRUD và chức năng Auto-Create chống va chạm vân tay (16 profiles liên tiếp 0% trùng lặp).
4. Khởi chạy 2 Profile đồng thời, kiểm tra spoofing độc lập và anti-tamper `[native code]` qua CDP (khi có `chrome.exe`).
5. Giao diện Desktop Window `--app` và tương tác DOM thời gian thực (khi có `chrome.exe`).
6. Zero-Dependency AWS SigV4 Client, Distributed Lock, Offline Degradation, Lock Ownership Protection, Tar Exclusion, 1-Line Sync Key (`VTN-R2-...`) Export/Import, Kernel Sync (`hasKernelOnCloud`, `/kernel/status`) và REST API Cloud Sync (`/config`, `/status`, `/sync-all`, `/upload`, `/download`, `/sync-key`, `/import-key`).

---

## 📄 Bản Quyền & Giấy Phép

Phát triển bởi đội ngũ **VTN Anti-Browser Team**.
Bản quyền © 2026. Mọi quyền được bảo lưu.
