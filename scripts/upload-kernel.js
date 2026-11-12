// noqa: debug-artifact-file
/**
 * VTN Anti-Browser Chromium Kernel Cloud Upload Tool (`scripts/upload-kernel.js`)
 * Compresses local `bin/151-0007/` into a portable tar.gz archive and uploads it
 * directly to Cloudflare R2 at key `system/bin_151-0007.tar.gz`.
 */

const path = require('node:path');
const fs = require('node:fs');
const { CloudSync } = require('../src/core/cloud-sync');

async function main() {
  console.log('============================================================');
  console.log('  VTN Anti-Browser — Chromium 151 Kernel Cloud Uploader');
  console.log('============================================================\n');

  const cloudSync = new CloudSync();
  if (!cloudSync.isEnabled()) {
    console.error('❌ Lỗi: Cloudflare R2 chưa được kích hoạt hoặc chưa cấu hình.');
    console.error('   Vui lòng khởi động app ("npm start") và vào [Settings > Cloudflare R2]');
    console.error('   để nhập thông tin kết nối hoặc dán 1-Line Sync Key trước khi upload kernel.\n');
    process.exit(1);
  }

  const binBaseDir = path.resolve(__dirname, '..', 'bin');
  const chromeExe = path.join(binBaseDir, '151-0007', 'chrome.exe');

  if (!fs.existsSync(chromeExe)) {
    console.error(`❌ Lỗi: Không tìm thấy file thực thi Chromium tại:`);
    console.error(`   ${chromeExe}`);
    console.error('   Vui lòng đảm bảo thư mục "bin/151-0007/" đã có đầy đủ mã máy trước khi đẩy lên cloud.\n');
    process.exit(1);
  }

  console.log(`📦 Thư mục nguồn: ${path.join(binBaseDir, '151-0007')}`);
  console.log(`☁️  Bucket R2:      ${cloudSync.r2Client.bucket}`);
  console.log(`🎯 Key lưu trữ:    system/bin_151-0007.tar.gz`);
  console.log('\n⏳ Đang nén thư mục với tar.exe và đẩy lên Cloudflare R2...');

  const startTime = Date.now();
  try {
    const result = await cloudSync.uploadKernel(binBaseDir);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const mb = (result.size / (1024 * 1024)).toFixed(2);

    console.log('\n✅ [THÀNH CÔNG] Lõi Chromium 151 đã được nén và đẩy lên Cloudflare R2!');
    console.log(`   • Dung lượng gói tin: ${mb} MB`);
    console.log(`   • Thời gian hoàn tất: ${duration}s`);
    console.log(`   • Object Key trên R2: ${result.key}`);
    console.log('\n🎉 Các máy mới chỉ cần chạy "setup.ps1" hoặc nhập Sync Key là có thể tự động tải lõi này về!');
  } catch (err) {
    console.error('\n❌ Upload thất bại:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
